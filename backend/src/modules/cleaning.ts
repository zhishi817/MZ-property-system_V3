import { Router } from 'express'
import { z } from 'zod'
import { requireAnyPerm, requirePerm } from '../auth'
import { addAudit, db } from '../store'
import { hasPg, pgPool } from '../dbAdapter'
import { backfillCleaningTasks, syncOrderToCleaningTasks } from '../services/cleaningSync'
import { v4 as uuid } from 'uuid'

export const router = Router()

const DEFAULT_SUMMARY_CHECKOUT_TIME = '10am'
const DEFAULT_SUMMARY_CHECKIN_TIME = '3pm'

function auDayStr(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d)
  const get = (t: string) => parts.find((p) => p.type === t)?.value || ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

function dayOnly(s?: any): string | null {
  const v = String(s || '').slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null
}

async function ensureOfflineTasksTable() {
  if (!hasPg || !pgPool) return
  const r = await pgPool.query(`SELECT to_regclass('public.cleaning_offline_tasks') AS t`)
  const t = r?.rows?.[0]?.t
  if (!t) {
    const err: any = new Error('cleaning_offline_tasks_missing')
    err.code = 'CLEANING_SCHEMA_MISSING'
    throw err
  }
}

async function ensureWorkTasksTable() {
  if (!hasPg || !pgPool) return
  await pgPool.query(`CREATE TABLE IF NOT EXISTS work_tasks (
    id text PRIMARY KEY,
    task_kind text NOT NULL,
    source_type text NOT NULL,
    source_id text NOT NULL,
    property_id text,
    title text NOT NULL DEFAULT '',
    summary text,
    scheduled_date date,
    start_time text,
    end_time text,
    assignee_id text,
    status text NOT NULL DEFAULT 'todo',
    urgency text NOT NULL DEFAULT 'medium',
    created_by text,
    updated_by text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );`)
  try { await pgPool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_work_tasks_source ON work_tasks(source_type, source_id);`) } catch {}
  try { await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_work_tasks_day_assignee ON work_tasks(scheduled_date, assignee_id, status);`) } catch {}
}

async function upsertWorkTaskFromOfflineTask(row: any) {
  if (!hasPg || !pgPool) return
  const id = String(row?.id || '').trim()
  if (!id) return
  await ensureWorkTasksTable()
  const workId = `cleaning_offline_tasks:${id}`
  const scheduled = row?.date ? String(row.date).slice(0, 10) : null
  const assignee = String(row?.assignee_id || '').trim() || null
  const status = String(row?.status || '').trim() === 'done' ? 'done' : 'todo'
  const urgency = String(row?.urgency || '').trim() || 'medium'
  await pgPool.query(
    `INSERT INTO work_tasks(id, task_kind, source_type, source_id, property_id, title, summary, scheduled_date, assignee_id, status, urgency, created_at, updated_at)
     VALUES($1,'offline','cleaning_offline_tasks',$2,$3,$4,$5,$6::date,$7,$8,$9,COALESCE($10::timestamptz, now()), now())
     ON CONFLICT (source_type, source_id) DO UPDATE SET
       property_id=EXCLUDED.property_id,
       title=EXCLUDED.title,
       summary=EXCLUDED.summary,
       scheduled_date=EXCLUDED.scheduled_date,
       assignee_id=EXCLUDED.assignee_id,
       status=EXCLUDED.status,
       urgency=EXCLUDED.urgency,
       updated_at=now()`,
    [workId, id, row?.property_id || null, String(row?.title || ''), String(row?.content || '') || null, scheduled, assignee, status, urgency, row?.created_at || null]
  )
}

router.get('/staff', requireAnyPerm(['cleaning.view', 'cleaning.schedule.manage', 'cleaning.task.assign']), async (req, res) => {
  const kind = String((req.query as any)?.kind || '').trim().toLowerCase()
  const rolesForKind = (k: string): string[] => {
    if (k === 'cleaner') return ['cleaner', 'cleaner_inspector']
    if (k === 'inspector') return ['cleaning_inspector', 'cleaner_inspector']
    return ['cleaner', 'cleaning_inspector', 'cleaner_inspector']
  }
  const roles = rolesForKind(kind)
  try {
    if (hasPg && pgPool) {
      const r = await pgPool.query(
        `SELECT
           id,
           username,
           email,
           role,
           (color_hex::text) AS color_hex
         FROM users
         WHERE role = ANY($1::text[])
         ORDER BY COALESCE(username, email) ASC, id ASC`,
        [roles]
      )
      const out: any[] = []
      for (const u of (r?.rows || []) as any[]) {
        const role = String(u.role || '')
        const name = String(u.username || u.email || u.id || '').trim() || String(u.id)
        const base = { id: String(u.id), name, capacity_per_day: 0, is_active: true, color_hex: String(u.color_hex || '#3B82F6') }
        if (role === 'cleaner' && kind !== 'inspector') out.push({ ...base, kind: 'cleaner' })
        else if (role === 'cleaning_inspector' && kind !== 'cleaner') out.push({ ...base, kind: 'inspector' })
        else if (role === 'cleaner_inspector') {
          if (kind === 'cleaner') out.push({ ...base, kind: 'cleaner' })
          else if (kind === 'inspector') out.push({ ...base, kind: 'inspector' })
          else out.push({ ...base, kind: 'cleaner' }, { ...base, kind: 'inspector' })
        }
      }
      return res.json(out)
    }
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'staff_failed' })
  }
  const users = (db.users || []).filter((u: any) => roles.includes(String(u.role || '')))
  const out: any[] = []
  for (const u of users) {
    const role = String(u.role || '')
    const name = String(u.username || u.email || u.id || '').trim() || String(u.id)
    const base = { id: String(u.id), name, capacity_per_day: 0, is_active: true, color_hex: String((u as any).color_hex || '#3B82F6') }
    if (role === 'cleaner' && kind !== 'inspector') out.push({ ...base, kind: 'cleaner' })
    else if (role === 'cleaning_inspector' && kind !== 'cleaner') out.push({ ...base, kind: 'inspector' })
    else if (role === 'cleaner_inspector') {
      if (kind === 'cleaner') out.push({ ...base, kind: 'cleaner' })
      else if (kind === 'inspector') out.push({ ...base, kind: 'inspector' })
      else out.push({ ...base, kind: 'cleaner' }, { ...base, kind: 'inspector' })
    }
  }
  return res.json(out)
})

const offlineTaskSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  task_type: z.enum(['property', 'company', 'other']),
  title: z.string().min(1),
  content: z.string().optional(),
  kind: z.string().min(1),
  status: z.enum(['todo', 'done']),
  urgency: z.enum(['low', 'medium', 'high', 'urgent']),
  property_id: z.string().nullable().optional(),
  assignee_id: z.string().nullable().optional(),
}).strict()

router.get('/offline-tasks', requireAnyPerm(['cleaning.view', 'cleaning.schedule.manage', 'cleaning.task.assign']), async (req, res) => {
  const dateParsed = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().safeParse((req.query as any)?.date)
  const date = dateParsed.success ? dateParsed.data : undefined
  const includeOverdue = String((req.query as any)?.include_overdue || '').trim() === '1'
  try {
    if (hasPg && pgPool) {
      await ensureOfflineTasksTable()
      if (!date) {
        const r = await pgPool.query('SELECT * FROM cleaning_offline_tasks ORDER BY date DESC, updated_at DESC, id DESC')
        return res.json(r?.rows || [])
      }
      if (includeOverdue) {
        const r = await pgPool.query(
          `SELECT * FROM cleaning_offline_tasks
           WHERE ((date::date) = ($1::date))
              OR ((date::date) < ($1::date) AND status <> 'done')
           ORDER BY date ASC, urgency DESC, updated_at DESC, id DESC`,
          [date]
        )
        return res.json(r?.rows || [])
      }
      const r = await pgPool.query(
        `SELECT * FROM cleaning_offline_tasks
         WHERE (date::date) = ($1::date)
         ORDER BY urgency DESC, updated_at DESC, id DESC`,
        [date]
      )
      return res.json(r?.rows || [])
    }
    const rows = ((db as any).cleaningOfflineTasks || []) as any[]
    const filtered = date
      ? rows.filter((t: any) => {
          const d = String(t.date || '').slice(0, 10)
          if (d === date) return true
          if (!includeOverdue) return false
          return d < date && String(t.status || '') !== 'done'
        })
      : rows
    filtered.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || String(b.id || '').localeCompare(String(a.id || '')))
    return res.json(filtered)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'offline_tasks_failed' })
  }
})

router.post('/offline-tasks', requirePerm('cleaning.schedule.manage'), async (req, res) => {
  const parsed = offlineTaskSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const payload = parsed.data
  try {
    const row = {
      id: uuid(),
      date: payload.date,
      task_type: payload.task_type,
      title: payload.title,
      content: payload.content || '',
      kind: payload.kind,
      status: payload.status,
      urgency: payload.urgency,
      property_id: payload.property_id ?? null,
      assignee_id: payload.assignee_id ?? null,
    }
    if (hasPg && pgPool) {
      await ensureOfflineTasksTable()
      const r = await pgPool.query(
        `INSERT INTO cleaning_offline_tasks(
          id, date, task_type, title, content, kind, status, urgency, property_id, assignee_id
        ) VALUES($1,$2::date,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [row.id, row.date, row.task_type, row.title, row.content, row.kind, row.status, row.urgency, row.property_id, row.assignee_id]
      )
      const out = r?.rows?.[0] || row
      try { await upsertWorkTaskFromOfflineTask(out) } catch {}
      return res.status(201).json(out)
    }
    ;(db as any).cleaningOfflineTasks = (db as any).cleaningOfflineTasks || []
    ;(db as any).cleaningOfflineTasks.unshift(row)
    return res.status(201).json(row)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'create_failed' })
  }
})

router.patch('/offline-tasks/:id', requirePerm('cleaning.schedule.manage'), async (req, res) => {
  const { id } = req.params
  const parsed = offlineTaskSchema.partial().safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const patch = parsed.data
  try {
    if (hasPg && pgPool) {
      await ensureOfflineTasksTable()
      const keys = Object.keys(patch || {}).filter((k) => (patch as any)[k] !== undefined)
      if (!keys.length) {
        const r0 = await pgPool.query('SELECT * FROM cleaning_offline_tasks WHERE id=$1 LIMIT 1', [String(id)])
        const row0 = r0?.rows?.[0] || null
        if (!row0) return res.status(404).json({ message: 'task not found' })
        return res.json(row0)
      }
      const set = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ')
      const values = keys.map((k) => ((patch as any)[k] === undefined ? null : (patch as any)[k]))
      const sql = `UPDATE cleaning_offline_tasks SET ${set}, updated_at=now() WHERE id=$${keys.length + 1} RETURNING *`
      const r1 = await pgPool.query(sql, [...values, String(id)])
      const row = r1?.rows?.[0] || null
      if (!row) return res.status(404).json({ message: 'task not found' })
      try { await upsertWorkTaskFromOfflineTask(row) } catch {}
      return res.json(row)
    }
    const rows = ((db as any).cleaningOfflineTasks || []) as any[]
    const t = rows.find((x: any) => String(x.id) === String(id))
    if (!t) return res.status(404).json({ message: 'task not found' })
    Object.assign(t, patch)
    return res.json(t)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'update_failed' })
  }
})

router.delete('/offline-tasks/:id', requirePerm('cleaning.schedule.manage'), async (req, res) => {
  const { id } = req.params
  try {
    if (hasPg && pgPool) {
      await ensureOfflineTasksTable()
      await pgPool.query('DELETE FROM cleaning_offline_tasks WHERE id=$1', [String(id)])
      return res.json({ ok: true })
    }
    const rows = ((db as any).cleaningOfflineTasks || []) as any[]
    ;(db as any).cleaningOfflineTasks = rows.filter((x: any) => String(x.id) !== String(id))
    return res.json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'delete_failed' })
  }
})

router.get('/tasks', requireAnyPerm(['cleaning.view', 'cleaning.schedule.manage', 'cleaning.task.assign']), async (req, res) => {
  const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
  const parsed = dateSchema.safeParse((req.query as any)?.date)
  const date = parsed.success ? parsed.data : undefined
  try {
    if (hasPg && pgPool) {
      if (date) {
        const r = await pgPool.query(
          'SELECT * FROM cleaning_tasks WHERE (COALESCE(task_date, date)::date) = ($1::date) ORDER BY property_id NULLS LAST, id',
          [date]
        )
        return res.json(r?.rows || [])
      }
      const r = await pgPool.query('SELECT * FROM cleaning_tasks ORDER BY COALESCE(task_date, date) NULLS LAST, property_id NULLS LAST, id')
      return res.json(r?.rows || [])
    }
    const rows = (db.cleaningTasks as any[]).slice()
    if (!date) return res.json(rows)
    return res.json(rows.filter((t: any) => String(t.task_date || t.date || '').slice(0, 10) === date))
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'query_failed' })
  }
})

router.get('/history', requireAnyPerm(['cleaning.view', 'cleaning.schedule.manage', 'cleaning.task.assign']), async (req, res) => {
  const propertyId = String((req.query as any)?.property_id || '').trim()
  if (!propertyId) return res.status(400).json({ message: 'property_id_required' })
  const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
  const parsedFrom = dateSchema.optional().safeParse((req.query as any)?.from)
  const parsedTo = dateSchema.optional().safeParse((req.query as any)?.to)
  const fromRaw = parsedFrom.success ? parsedFrom.data : undefined
  const toRaw = parsedTo.success ? parsedTo.data : undefined
  const limitRaw = Number((req.query as any)?.limit || 200)
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, Math.floor(limitRaw)), 1000) : 200
  const today = new Date()
  const defaultTo = today.toISOString().slice(0, 10)
  const defaultFrom = new Date(today.getTime() - 180 * 24 * 3600 * 1000).toISOString().slice(0, 10)
  const from = fromRaw || defaultFrom
  const to = toRaw || defaultTo
  try {
    if (hasPg && pgPool) {
      const sql = `
        SELECT
          t.*,
          p.code AS property_code,
          p.region AS property_region
        FROM cleaning_tasks t
        LEFT JOIN properties p ON p.id = t.property_id
        WHERE t.property_id = $1
          AND (COALESCE(t.task_date, t.date)::date) >= ($2::date)
          AND (COALESCE(t.task_date, t.date)::date) <= ($3::date)
        ORDER BY (COALESCE(t.task_date, t.date)::date) DESC, t.id DESC
        LIMIT $4
      `
      const r = await pgPool.query(sql, [propertyId, from, to, limit])
      return res.json(r?.rows || [])
    }
    const rows = (db.cleaningTasks as any[]).slice().filter((t: any) => String(t.property_id || '') === propertyId)
    const filtered = rows.filter((t: any) => {
      const d = String(t.task_date || t.date || '').slice(0, 10)
      return d && d >= from && d <= to
    })
    filtered.sort((a: any, b: any) => String(b.task_date || b.date || '').localeCompare(String(a.task_date || a.date || '')) || String(b.id || '').localeCompare(String(a.id || '')))
    const props = ((db as any).properties || []) as any[]
    const p = props.find((x: any) => String(x.id) === propertyId) || null
    const out = filtered.slice(0, limit).map((t: any) => ({ ...t, property_code: p?.code || t?.property_code || null, property_region: p?.region || t?.property_region || null }))
    return res.json(out)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'history_failed' })
  }
})

const patchTaskSchema = z.object({
  property_id: z.string().nullable().optional(),
  task_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  status: z.enum(['pending', 'assigned', 'in_progress', 'completed', 'cancelled']).optional(),
  assignee_id: z.union([z.string().min(1), z.null()]).optional(),
  cleaner_id: z.union([z.string().min(1), z.null()]).optional(),
  inspector_id: z.union([z.string().min(1), z.null()]).optional(),
  nights_override: z.union([z.number().int().nonnegative(), z.null()]).optional(),
  old_code: z.union([z.string(), z.null()]).optional(),
  new_code: z.union([z.string(), z.null()]).optional(),
  checkout_time: z.union([z.string(), z.null()]).optional(),
  checkin_time: z.union([z.string(), z.null()]).optional(),
  scheduled_at: z.union([z.string().min(1), z.null()]).optional(),
  note: z.union([z.string(), z.null()]).optional(),
}).strict()

async function isValidStaffId(id: any, kind: 'cleaner' | 'inspector'): Promise<boolean> {
  if (!id) return true
  const sid = String(id)
  const allowed =
    kind === 'cleaner'
      ? ['cleaner', 'cleaner_inspector']
      : ['cleaning_inspector', 'cleaner_inspector']

  if (hasPg && pgPool) {
    try {
      const r = await pgPool.query('SELECT role FROM users WHERE id=$1 LIMIT 1', [sid])
      const role = String(r?.rows?.[0]?.role || '')
      return allowed.includes(role)
    } catch {
      return false
    }
  }

  const u = (db.users || []).find((x: any) => String(x.id) === sid)
  if (u) return allowed.includes(String((u as any).role || ''))

  const all = (db.cleaners || []).map((x: any) => ({ ...x, kind: x?.kind || 'cleaner', is_active: x?.is_active !== false }))
  const found = all.find((x: any) => String(x.id) === sid && x.is_active !== false && x.kind === kind)
  return !!found
}

router.patch('/tasks/:id', requirePerm('cleaning.task.assign'), async (req, res) => {
  const { id } = req.params
  const parsed = patchTaskSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  if (!(await isValidStaffId((parsed.data as any).cleaner_id ?? null, 'cleaner'))) return res.status(400).json({ message: '无效的清洁人员' })
  if (!(await isValidStaffId((parsed.data as any).inspector_id ?? null, 'inspector'))) return res.status(400).json({ message: '无效的检查人员' })
  try {
    if (hasPg && pgPool) {
      const r0 = await pgPool.query('SELECT * FROM cleaning_tasks WHERE id = $1 LIMIT 1', [String(id)])
      const before = r0?.rows?.[0] || null
      if (!before) return res.status(404).json({ message: 'task not found' })

      const patch: any = { ...parsed.data }
      if (patch.cleaner_id !== undefined && patch.assignee_id === undefined) patch.assignee_id = patch.cleaner_id
      if (patch.assignee_id !== undefined && patch.cleaner_id === undefined) patch.cleaner_id = patch.assignee_id
      if (patch.task_date != null) patch.date = patch.task_date
      {
        const beforeStatus = String(before.status || 'pending')
        const statusAutoEligible = beforeStatus === 'pending' || beforeStatus === 'assigned'
        const incomingStatus = (parsed.data as any).status
        const incomingStatusEligible =
          incomingStatus === undefined || String(incomingStatus) === 'pending' || String(incomingStatus) === 'assigned'
        const touchingAssignees =
          (parsed.data as any).cleaner_id !== undefined || (parsed.data as any).inspector_id !== undefined || parsed.data.assignee_id !== undefined
        if (touchingAssignees && statusAutoEligible && incomingStatusEligible) {
          const nextCleanerId = patch.cleaner_id !== undefined ? (patch.cleaner_id ?? null) : (before.cleaner_id ?? before.assignee_id ?? null)
          const nextInspectorId = (parsed.data as any).inspector_id !== undefined ? ((parsed.data as any).inspector_id ?? null) : (before.inspector_id ?? null)
          patch.status = nextCleanerId && nextInspectorId ? 'assigned' : 'pending'
        }
      }
      patch.updated_at = new Date().toISOString()

      const keys = Object.keys(patch).filter((k) => patch[k] !== undefined)
      const set = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ')
      const values = keys.map((k) => (patch[k] === undefined ? null : patch[k]))
      const sql = `UPDATE cleaning_tasks SET ${set} WHERE id = $${keys.length + 1} RETURNING *`
      const r1 = await pgPool.query(sql, [...values, String(id)])
      return res.json(r1?.rows?.[0] || before)
    }

    const task = (db.cleaningTasks as any[]).find((t: any) => String(t.id) === String(id))
    if (!task) return res.status(404).json({ message: 'task not found' })
    const before = { ...task }
    if (parsed.data.property_id !== undefined) task.property_id = parsed.data.property_id
    if (parsed.data.task_date !== undefined) { task.task_date = parsed.data.task_date; task.date = parsed.data.task_date }
    if (parsed.data.status !== undefined) task.status = parsed.data.status
    if ((parsed.data as any).cleaner_id !== undefined) task.cleaner_id = (parsed.data as any).cleaner_id
    if ((parsed.data as any).inspector_id !== undefined) task.inspector_id = (parsed.data as any).inspector_id
    if ((parsed.data as any).nights_override !== undefined) task.nights_override = (parsed.data as any).nights_override
    if ((parsed.data as any).old_code !== undefined) task.old_code = (parsed.data as any).old_code
    if ((parsed.data as any).new_code !== undefined) task.new_code = (parsed.data as any).new_code
    if ((parsed.data as any).checkout_time !== undefined) task.checkout_time = (parsed.data as any).checkout_time
    if ((parsed.data as any).checkin_time !== undefined) task.checkin_time = (parsed.data as any).checkin_time
    if (parsed.data.assignee_id !== undefined) task.assignee_id = parsed.data.assignee_id
    if ((parsed.data as any).cleaner_id !== undefined && parsed.data.assignee_id === undefined) task.assignee_id = (parsed.data as any).cleaner_id
    if (parsed.data.assignee_id !== undefined && (parsed.data as any).cleaner_id === undefined) task.cleaner_id = parsed.data.assignee_id
    if (parsed.data.scheduled_at !== undefined) task.scheduled_at = parsed.data.scheduled_at
    if (parsed.data.note !== undefined) task.note = parsed.data.note
    {
      const beforeStatus = String((before as any).status || 'pending')
      const statusAutoEligible = beforeStatus === 'pending' || beforeStatus === 'assigned'
      const incomingStatus = (parsed.data as any).status
      const incomingStatusEligible =
        incomingStatus === undefined || String(incomingStatus) === 'pending' || String(incomingStatus) === 'assigned'
      const touchingAssignees =
        (parsed.data as any).cleaner_id !== undefined || (parsed.data as any).inspector_id !== undefined || parsed.data.assignee_id !== undefined
      if (touchingAssignees && statusAutoEligible && incomingStatusEligible) {
        const cleaner = String(task.cleaner_id || task.assignee_id || '').trim()
        const inspector = String(task.inspector_id || '').trim()
        task.status = cleaner && inspector ? 'assigned' : 'pending'
      }
    }
    return res.json(task)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'update_failed' })
  }
})

const createTaskSchema = z.object({
  task_type: z.enum(['checkout_clean', 'checkin_clean', 'stayover_clean']).optional(),
  create_mode: z.enum(['checkout', 'checkin', 'turnover', 'stayover']).optional(),
  task_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  property_id: z.string().min(1),
  status: z.enum(['pending', 'assigned', 'in_progress', 'completed', 'cancelled']).optional(),
  cleaner_id: z.union([z.string().min(1), z.null()]).optional(),
  inspector_id: z.union([z.string().min(1), z.null()]).optional(),
  scheduled_at: z.union([z.string().min(1), z.null()]).optional(),
  old_code: z.union([z.string(), z.null()]).optional(),
  new_code: z.union([z.string(), z.null()]).optional(),
  checkout_time: z.union([z.string(), z.null()]).optional(),
  checkin_time: z.union([z.string(), z.null()]).optional(),
  nights_override: z.union([z.number().int().nonnegative(), z.null()]).optional(),
  note: z.union([z.string(), z.null()]).optional(),
}).strict()

router.post('/tasks', requirePerm('cleaning.task.assign'), async (req, res) => {
  const parsed = createTaskSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  if (!(await isValidStaffId((parsed.data as any).cleaner_id ?? null, 'cleaner'))) return res.status(400).json({ message: '无效的清洁人员' })
  if (!(await isValidStaffId((parsed.data as any).inspector_id ?? null, 'inspector'))) return res.status(400).json({ message: '无效的检查人员' })
  try {
    const mode = (parsed.data as any).create_mode
    const taskType = parsed.data.task_type
    if (!mode && !taskType) return res.status(400).json({ message: 'missing task_type' })
    const types =
      mode === 'turnover' ? ['checkout_clean', 'checkin_clean'] :
      mode === 'checkout' ? ['checkout_clean'] :
      mode === 'checkin' ? ['checkin_clean'] :
      mode === 'stayover' ? ['stayover_clean'] :
      [String(taskType)]

    const createdRows: any[] = []
    const rawPropertyId = String(parsed.data.property_id || '').trim()
    let normalizedPropertyId = rawPropertyId
    if (hasPg && pgPool) {
      try {
        const r = await pgPool.query('SELECT id::text AS id FROM properties WHERE id::text=$1 OR upper(code)=upper($1) LIMIT 1', [rawPropertyId])
        const row = r?.rows?.[0]
        const id = row?.id ? String(row.id) : ''
        if (!id) return res.status(400).json({ message: '无效的房源' })
        normalizedPropertyId = id
      } catch {}
    } else {
      const anyDb: any = db as any
      const props: any[] = Array.isArray(anyDb?.properties) ? anyDb.properties : []
      const found = props.find((p) => String(p?.id || '') === rawPropertyId || String(p?.code || '').toLowerCase() === rawPropertyId.toLowerCase())
      const id = found?.id ? String(found.id) : ''
      if (!id) return res.status(400).json({ message: '无效的房源' })
      normalizedPropertyId = id
    }
    const base: any = {
      order_id: null,
      property_id: normalizedPropertyId,
      task_date: parsed.data.task_date,
      date: parsed.data.task_date,
      status: parsed.data.status || ((parsed.data.cleaner_id ?? null) && ((parsed.data as any).inspector_id ?? null) ? 'assigned' : 'pending'),
      assignee_id: (parsed.data.cleaner_id ?? null),
      cleaner_id: (parsed.data.cleaner_id ?? null),
      inspector_id: (parsed.data.inspector_id ?? null),
      scheduled_at: parsed.data.scheduled_at ?? null,
      old_code: parsed.data.old_code ?? null,
      new_code: parsed.data.new_code ?? null,
      checkout_time: parsed.data.checkout_time ?? null,
      checkin_time: parsed.data.checkin_time ?? null,
      nights_override: (parsed.data as any).nights_override ?? null,
      note: (parsed.data as any).note ?? null,
      auto_sync_enabled: true,
      source: 'manual',
    }
    if (hasPg && pgPool) {
      const client = await pgPool.connect()
      try {
        await client.query('BEGIN')
        for (const tt of types) {
          const row: any = { id: uuid(), ...base, task_type: tt, type: tt }
          const keys = Object.keys(row).filter((k) => row[k] !== undefined)
          const cols = keys.map((k) => `"${k}"`).join(', ')
          const args = keys.map((_, i) => `$${i + 1}`).join(', ')
          const values = keys.map((k) => row[k])
          const sql = `INSERT INTO cleaning_tasks(${cols}) VALUES(${args}) RETURNING *`
          const r = await client.query(sql, values)
          createdRows.push(r?.rows?.[0] || row)
        }
        await client.query('COMMIT')
      } catch (e) {
        try { await client.query('ROLLBACK') } catch {}
        throw e
      } finally {
        client.release()
      }
      if (createdRows.length === 1) return res.json(createdRows[0])
      return res.json({ ok: true, created: createdRows.length })
    }
    for (const tt of types) {
      const row: any = { id: uuid(), ...base, task_type: tt, type: tt }
      ;(db.cleaningTasks as any[]).push(row)
      createdRows.push(row)
    }
    if (createdRows.length === 1) return res.json(createdRows[0])
    return res.json({ ok: true, created: createdRows.length })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'create_failed' })
  }
})

router.delete('/tasks/:id', requirePerm('cleaning.task.assign'), async (req, res) => {
  const { id } = req.params
  const actor = (req as any).user
  const actorId = actor?.sub ? String(actor.sub) : undefined
  try {
    if (hasPg && pgPool) {
      const r0 = await pgPool.query('SELECT * FROM cleaning_tasks WHERE id=$1 LIMIT 1', [String(id)])
      const before = r0?.rows?.[0] || null
      if (!before) return res.status(404).json({ message: 'task not found' })
      const r1 = await pgPool.query(`UPDATE cleaning_tasks SET status='cancelled', auto_sync_enabled=false, updated_at=now() WHERE id=$1 RETURNING *`, [String(id)])
      const after = r1?.rows?.[0] || null
      addAudit('cleaning_task', String(id), 'delete', before, after, actorId, { ip: String(req.ip || ''), user_agent: String(req.headers['user-agent'] || '') })
      return res.json({ ok: true })
    }
    const task = (db.cleaningTasks as any[]).find((t: any) => String(t.id) === String(id))
    if (!task) return res.status(404).json({ message: 'task not found' })
    const before = { ...task }
    task.status = 'cancelled'
    task.auto_sync_enabled = false
    addAudit('cleaning_task', String(id), 'delete', before, { ...task }, actorId, { ip: String(req.ip || ''), user_agent: String(req.headers['user-agent'] || '') })
    return res.json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'delete_failed' })
  }
})

const bulkDeleteSchema = z.object({ ids: z.array(z.string().min(1)).min(1) }).strict()
router.post('/tasks/bulk-delete', requirePerm('cleaning.task.assign'), async (req, res) => {
  const parsed = bulkDeleteSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const actor = (req as any).user
  const actorId = actor?.sub ? String(actor.sub) : undefined
  const ids = Array.from(new Set(parsed.data.ids.map((x) => String(x).trim()).filter(Boolean)))
  try {
    if (hasPg && pgPool) {
      const client = await pgPool.connect()
      try {
        await client.query('BEGIN')
        for (const id of ids) {
          const r0 = await client.query('SELECT * FROM cleaning_tasks WHERE id=$1 LIMIT 1', [id])
          const before = r0?.rows?.[0] || null
          if (!before) continue
          const r1 = await client.query(`UPDATE cleaning_tasks SET status='cancelled', auto_sync_enabled=false, updated_at=now() WHERE id=$1 RETURNING *`, [id])
          const after = r1?.rows?.[0] || null
          addAudit('cleaning_task', String(id), 'delete', before, after, actorId, { ip: String(req.ip || ''), user_agent: String(req.headers['user-agent'] || '') })
        }
        await client.query('COMMIT')
      } catch (e) {
        try { await client.query('ROLLBACK') } catch {}
        throw e
      } finally {
        client.release()
      }
      return res.json({ ok: true, deleted: ids.length })
    }
    let cnt = 0
    for (const id of ids) {
      const task = (db.cleaningTasks as any[]).find((t: any) => String(t.id) === String(id))
      if (!task) continue
      const before = { ...task }
      task.status = 'cancelled'
      task.auto_sync_enabled = false
      addAudit('cleaning_task', String(id), 'delete', before, { ...task }, actorId, { ip: String(req.ip || ''), user_agent: String(req.headers['user-agent'] || '') })
      cnt++
    }
    return res.json({ ok: true, deleted: cnt })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'bulk_delete_failed' })
  }
})

const bulkPatchSchema = z.object({ ids: z.array(z.string().min(1)).min(1), patch: patchTaskSchema }).strict()
router.post('/tasks/bulk-patch', requirePerm('cleaning.task.assign'), async (req, res) => {
  const parsed = bulkPatchSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  if (!(await isValidStaffId((parsed.data.patch as any).cleaner_id ?? null, 'cleaner'))) return res.status(400).json({ message: '无效的清洁人员' })
  if (!(await isValidStaffId((parsed.data.patch as any).inspector_id ?? null, 'inspector'))) return res.status(400).json({ message: '无效的检查人员' })
  const ids = Array.from(new Set(parsed.data.ids.map((x) => String(x).trim()).filter(Boolean)))
  const basePatch: any = { ...parsed.data.patch }
  if (basePatch.cleaner_id !== undefined && basePatch.assignee_id === undefined) basePatch.assignee_id = basePatch.cleaner_id
  if (basePatch.assignee_id !== undefined && basePatch.cleaner_id === undefined) basePatch.cleaner_id = basePatch.assignee_id
  try {
    const updated: any[] = []
    for (const id of ids) {
      const r = await (async () => {
        if (hasPg && pgPool) {
          const r0 = await pgPool.query('SELECT * FROM cleaning_tasks WHERE id=$1 LIMIT 1', [id])
          const before = r0?.rows?.[0] || null
          if (!before) return null
          const patch: any = { ...basePatch }
          if (patch.task_date != null) patch.date = patch.task_date
          {
            const beforeStatus = String(before.status || 'pending')
            const statusAutoEligible = beforeStatus === 'pending' || beforeStatus === 'assigned'
            const incomingStatus = (basePatch as any).status
            const incomingStatusEligible =
              incomingStatus === undefined || String(incomingStatus) === 'pending' || String(incomingStatus) === 'assigned'
            const touchingAssignees = (basePatch as any).cleaner_id !== undefined || (basePatch as any).inspector_id !== undefined || (basePatch as any).assignee_id !== undefined
            if (touchingAssignees && statusAutoEligible && incomingStatusEligible) {
              const nextCleanerId = patch.cleaner_id !== undefined ? (patch.cleaner_id ?? null) : (before.cleaner_id ?? before.assignee_id ?? null)
              const nextInspectorId = patch.inspector_id !== undefined ? (patch.inspector_id ?? null) : (before.inspector_id ?? null)
              patch.status = nextCleanerId && nextInspectorId ? 'assigned' : 'pending'
            }
          }
          patch.updated_at = new Date().toISOString()
          const keys = Object.keys(patch).filter((k) => patch[k] !== undefined)
          if (!keys.length) return before
          const set = keys.map((k, i) => `"${k}"=$${i + 1}`).join(', ')
          const values = keys.map((k) => (patch[k] === undefined ? null : patch[k]))
          const sql = `UPDATE cleaning_tasks SET ${set} WHERE id=$${keys.length + 1} RETURNING *`
          const r1 = await pgPool.query(sql, [...values, id])
          return r1?.rows?.[0] || before
        }
        const task = (db.cleaningTasks as any[]).find((t: any) => String(t.id) === String(id))
        if (!task) return null
        if (basePatch.property_id !== undefined) task.property_id = basePatch.property_id
        if (basePatch.task_date !== undefined) { task.task_date = basePatch.task_date; task.date = basePatch.task_date }
        if (basePatch.status !== undefined) task.status = basePatch.status
        if (basePatch.cleaner_id !== undefined) task.cleaner_id = basePatch.cleaner_id
        if (basePatch.inspector_id !== undefined) task.inspector_id = basePatch.inspector_id
        if (basePatch.assignee_id !== undefined) task.assignee_id = basePatch.assignee_id
        if (basePatch.scheduled_at !== undefined) task.scheduled_at = basePatch.scheduled_at
        if (basePatch.note !== undefined) task.note = basePatch.note
        {
          const beforeStatus = String((task as any).status || 'pending')
          const statusAutoEligible = beforeStatus === 'pending' || beforeStatus === 'assigned'
          const incomingStatus = (basePatch as any).status
          const incomingStatusEligible =
            incomingStatus === undefined || String(incomingStatus) === 'pending' || String(incomingStatus) === 'assigned'
          const touchingAssignees = (basePatch as any).cleaner_id !== undefined || (basePatch as any).inspector_id !== undefined || (basePatch as any).assignee_id !== undefined
          if (touchingAssignees && statusAutoEligible && incomingStatusEligible) {
            const cleaner = String(task.cleaner_id || task.assignee_id || '').trim()
            const inspector = String(task.inspector_id || '').trim()
            ;(task as any).status = cleaner && inspector ? 'assigned' : 'pending'
          }
        }
        return task
      })()
      if (r) updated.push(r)
    }
    return res.json({ ok: true, updated: updated.length })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'bulk_patch_failed' })
  }
})

const bulkIdsSchema = z.object({ ids: z.array(z.string().min(1)).min(1) }).strict()

router.post('/tasks/bulk-lock-auto-sync', requirePerm('cleaning.schedule.manage'), async (req, res) => {
  const parsed = bulkIdsSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const ids = Array.from(new Set(parsed.data.ids.map((x) => String(x).trim()).filter(Boolean)))
  if (!ids.length) return res.status(400).json({ message: 'ids required' })
  try {
    if (hasPg && pgPool) {
      const r = await pgPool.query(
        'UPDATE cleaning_tasks SET auto_sync_enabled=false, updated_at=now() WHERE id = ANY($1::text[]) RETURNING id',
        [ids]
      )
      return res.json({ ok: true, updated: r?.rowCount || 0 })
    }
    let cnt = 0
    for (const id of ids) {
      const task = (db.cleaningTasks as any[]).find((t: any) => String(t.id) === String(id))
      if (!task) continue
      task.auto_sync_enabled = false
      cnt++
    }
    return res.json({ ok: true, updated: cnt })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'bulk_lock_failed' })
  }
})

router.post('/tasks/bulk-restore-auto-sync', requirePerm('cleaning.schedule.manage'), async (req, res) => {
  const parsed = bulkIdsSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const ids = Array.from(new Set(parsed.data.ids.map((x) => String(x).trim()).filter(Boolean)))
  if (!ids.length) return res.status(400).json({ message: 'ids required' })
  try {
    if (hasPg && pgPool) {
      const r = await pgPool.query(
        'UPDATE cleaning_tasks SET auto_sync_enabled=true, updated_at=now() WHERE id = ANY($1::text[]) RETURNING id, order_id',
        [ids]
      )
      const orderIds = Array.from(new Set((r?.rows || []).map((x: any) => String(x?.order_id || '')).filter(Boolean)))
      if (orderIds.length) {
        try {
          const { pgRunInTransaction } = require('../dbAdapter')
          const { enqueueCleaningSyncJobTx } = require('../services/cleaningSyncJobs')
          const idsForJob = orderIds.slice()
          setTimeout(() => {
            ;(async () => {
              await pgRunInTransaction(async (client: any) => {
                for (const orderId of idsForJob) {
                  try {
                    await enqueueCleaningSyncJobTx(client, { order_id: orderId, action: 'updated', payload_snapshot: { id: orderId } })
                  } catch {}
                }
              })
            })().catch(() => {})
          }, 0)
        } catch {}
      }
      return res.json({ ok: true, updated: r?.rowCount || 0 })
    }
    let cnt = 0
    for (const id of ids) {
      const task = (db.cleaningTasks as any[]).find((t: any) => String(t.id) === String(id))
      if (!task) continue
      task.auto_sync_enabled = true
      cnt++
    }
    return res.json({ ok: true, updated: cnt })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'bulk_restore_failed' })
  }
})

router.post('/tasks/:id/restore-auto-sync', requirePerm('cleaning.schedule.manage'), async (req, res) => {
  const { id } = req.params
  try {
    if (hasPg && pgPool) {
      const r0 = await pgPool.query('SELECT * FROM cleaning_tasks WHERE id = $1 LIMIT 1', [String(id)])
      const task = r0?.rows?.[0] || null
      if (!task) return res.status(404).json({ message: 'task not found' })
      const r1 = await pgPool.query('UPDATE cleaning_tasks SET auto_sync_enabled=true, updated_at=now() WHERE id=$1 RETURNING *', [String(id)])
      const updated = r1?.rows?.[0] || task
      const orderId = updated?.order_id ? String(updated.order_id) : ''
      if (orderId) {
        try {
          const { pgRunInTransaction } = require('../dbAdapter')
          const { enqueueCleaningSyncJobTx } = require('../services/cleaningSyncJobs')
          await pgRunInTransaction(async (client: any) => {
            await enqueueCleaningSyncJobTx(client, { order_id: orderId, action: 'updated', payload_snapshot: { id: orderId } })
          })
        } catch {}
      }
      return res.json({ ok: true, task: updated })
    }
    const task = (db.cleaningTasks as any[]).find((t: any) => String(t.id) === String(id))
    if (!task) return res.status(404).json({ message: 'task not found' })
    task.auto_sync_enabled = true
    return res.json({ ok: true, task })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'restore_failed' })
  }
})

router.get('/sync-logs', requireAnyPerm(['cleaning.schedule.manage', 'cleaning.task.assign']), async (req, res) => {
  const orderId = String((req.query as any)?.order_id || '').trim() || null
  const limitRaw = Number((req.query as any)?.limit || 100)
  const limit = Math.max(1, Math.min(500, Number.isFinite(limitRaw) ? Math.trunc(limitRaw) : 100))
  try {
    if (!hasPg || !pgPool) return res.json([])
    if (orderId) {
      const r = await pgPool.query('SELECT * FROM cleaning_sync_logs WHERE (order_id::text)=$1 ORDER BY created_at DESC LIMIT $2', [orderId, limit])
      return res.json(r?.rows || [])
    }
    const r = await pgPool.query('SELECT * FROM cleaning_sync_logs ORDER BY created_at DESC LIMIT $1', [limit])
    return res.json(r?.rows || [])
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'logs_failed' })
  }
})

const rangeSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
})

router.get('/calendar-range', requireAnyPerm(['cleaning.view', 'cleaning.schedule.manage', 'cleaning.task.assign']), async (req, res) => {
  const parsed = rangeSchema.safeParse(req.query || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const from = parsed.data.from
  const to = parsed.data.to
  try {
    const items: any[] = []
    if (hasPg && pgPool) {
      const r = await pgPool.query(
        `SELECT
           t.id,
           t.order_id,
           COALESCE(p_id.id::text, p_code.id::text, t.property_id::text) AS property_id,
           COALESCE(p_id.code::text, p_code.code::text) AS property_code,
           COALESCE(p_id.region::text, p_code.region::text) AS property_region,
           t.task_type,
           COALESCE(t.task_date, t.date)::text AS task_date,
           t.status,
           t.assignee_id,
           t.cleaner_id,
           t.inspector_id,
           t.scheduled_at,
           t.checkout_time,
           t.checkin_time,
           t.nights_override,
           t.source,
           t.auto_sync_enabled,
           t.old_code,
           t.new_code,
           (o.confirmation_code::text) AS order_code,
           COALESCE(t.nights_override, o.nights) AS nights
         FROM cleaning_tasks t
         LEFT JOIN orders o ON (o.id::text) = (t.order_id::text)
         LEFT JOIN properties p_id ON (p_id.id::text) = (t.property_id::text)
         LEFT JOIN properties p_code ON upper(p_code.code) = upper(t.property_id::text)
         WHERE (COALESCE(task_date, date)::date) >= ($1::date) AND (COALESCE(task_date, date)::date) <= ($2::date)
           AND COALESCE(t.status,'') <> 'cancelled'
           AND (t.order_id IS NULL OR o.id IS NOT NULL)
           AND (
             t.order_id IS NULL
             OR (
               COALESCE(o.status, '') <> ''
               AND lower(COALESCE(o.status, '')) <> 'invalid'
               AND lower(COALESCE(o.status, '')) NOT LIKE '%cancel%'
             )
           )
         ORDER BY COALESCE(task_date, date) ASC, COALESCE(p_id.code, p_code.code) NULLS LAST, id`,
        [from, to]
      )
      for (const row of (r?.rows || [])) {
        const d = String(row.task_date || '').slice(0, 10)
        const rawType = row.task_type ? String(row.task_type) : 'cleaning_task'
        const label =
          rawType === 'checkout_clean' ? '退房' :
          rawType === 'checkin_clean' ? '入住' :
          rawType === 'stayover_clean' ? '入住中清洁' :
          rawType
        items.push({
          source: 'cleaning_tasks',
          entity_id: String(row.id),
          order_id: row.order_id ? String(row.order_id) : null,
          order_code: row.order_code ? String(row.order_code) : null,
          property_id: row.property_id ? String(row.property_id) : null,
          property_code: row.property_code ? String(row.property_code) : null,
          property_region: row.property_region ? String(row.property_region) : null,
          task_type: row.task_type ? String(row.task_type) : null,
          label,
          task_date: d,
          status: String(row.status || 'pending'),
          assignee_id: row.assignee_id ? String(row.assignee_id) : null,
          cleaner_id: row.cleaner_id ? String(row.cleaner_id) : (row.assignee_id ? String(row.assignee_id) : null),
          inspector_id: row.inspector_id ? String(row.inspector_id) : null,
          scheduled_at: row.scheduled_at ? String(row.scheduled_at) : null,
          auto_sync_enabled: row.auto_sync_enabled !== false,
          old_code: row.old_code != null ? String(row.old_code || '') : null,
          new_code: row.new_code != null ? String(row.new_code || '') : null,
          nights: row.nights != null ? Number(row.nights) : null,
          summary_checkout_time: String(row.checkout_time || '').trim() || DEFAULT_SUMMARY_CHECKOUT_TIME,
          summary_checkin_time: String(row.checkin_time || '').trim() || DEFAULT_SUMMARY_CHECKIN_TIME,
        })
      }
      await ensureOfflineTasksTable()
      const r2 = await pgPool.query(
        `SELECT id, date::text AS date, title, status, urgency, property_id, assignee_id
         FROM cleaning_offline_tasks
         WHERE (date::date) >= ($1::date) AND (date::date) <= ($2::date)
         ORDER BY date ASC, property_id NULLS LAST, id`,
        [from, to]
      )
      for (const row of (r2?.rows || [])) {
        items.push({
          source: 'offline_tasks',
          entity_id: String(row.id),
          order_id: null,
          order_code: null,
          property_id: row.property_id ? String(row.property_id) : null,
          property_code: null,
          property_region: null,
          task_type: null,
          label: String(row.title || 'offline_task'),
          task_date: String(row.date || '').slice(0, 10),
          status: String(row.status || 'pending'),
          assignee_id: row.assignee_id ? String(row.assignee_id) : null,
          scheduled_at: null,
          old_code: null,
          new_code: null,
          nights: null,
          summary_checkout_time: null,
          summary_checkin_time: null,
        })
      }
      return res.json(items)
    }

    const tasks = (db.cleaningTasks as any[]).filter((t: any) => {
      const d = String(t.task_date || t.date || '').slice(0, 10)
      return d >= from && d <= to
    })
    for (const t of tasks) {
      if (String(t.status || '') === 'cancelled') continue
      const d = String(t.task_date || t.date || '').slice(0, 10)
      const rawType = String(t.task_type || t.type || 'checkout_clean')
      const label =
        rawType === 'checkout_clean' ? '退房' :
        rawType === 'checkin_clean' ? '入住' :
        rawType === 'stayover_clean' ? '入住中清洁' :
        rawType
      const order = (db.orders as any[]).find((o: any) => String(o.id) === String(t.order_id)) || null
      const prop = (db.properties as any[]).find((p: any) => String(p.id) === String(t.property_id)) || null
      if (t.order_id && !order) continue
      const statusLower = String(order?.status || '').trim().toLowerCase()
      if (t.order_id && (!statusLower || statusLower === 'invalid' || statusLower.includes('cancel'))) continue
      items.push({
        source: 'cleaning_tasks',
        entity_id: String(t.id),
        order_id: t.order_id ? String(t.order_id) : null,
        order_code: order?.confirmation_code ? String(order.confirmation_code) : null,
        property_id: t.property_id ? String(t.property_id) : null,
        property_code: prop?.code ? String(prop.code) : null,
        property_region: prop?.region ? String(prop.region) : null,
        task_type: rawType || null,
        label,
        task_date: d,
        status: String(t.status || 'pending'),
        assignee_id: t.assignee_id ? String(t.assignee_id) : null,
        cleaner_id: t.cleaner_id ? String(t.cleaner_id) : (t.assignee_id ? String(t.assignee_id) : null),
        inspector_id: t.inspector_id ? String(t.inspector_id) : null,
        scheduled_at: t.scheduled_at ? String(t.scheduled_at) : null,
        auto_sync_enabled: t.auto_sync_enabled !== false,
        old_code: t.old_code != null ? String(t.old_code || '') : null,
        new_code: t.new_code != null ? String(t.new_code || '') : null,
        nights: t.nights_override != null ? Number(t.nights_override) : (order?.nights != null ? Number(order.nights) : null),
        summary_checkout_time: String(t.checkout_time || '').trim() || DEFAULT_SUMMARY_CHECKOUT_TIME,
        summary_checkin_time: String(t.checkin_time || '').trim() || DEFAULT_SUMMARY_CHECKIN_TIME,
      })
    }
    const offline = (db as any).cleaningOfflineTasks || []
    for (const t of offline) {
      const d = String(t.date || '').slice(0, 10)
      if (d < from || d > to) continue
      items.push({
        source: 'offline_tasks',
        entity_id: String(t.id),
        order_id: null,
        order_code: null,
        property_id: t.property_id ? String(t.property_id) : null,
        property_code: null,
        property_region: null,
        task_type: null,
        label: String(t.title || 'offline_task'),
        task_date: d,
        status: String(t.status || 'pending'),
        assignee_id: t.assignee_id ? String(t.assignee_id) : null,
        scheduled_at: null,
        old_code: null,
        new_code: null,
        nights: null,
        summary_checkout_time: null,
        summary_checkin_time: null,
      })
    }
    items.sort((a, b) => String(a.task_date).localeCompare(String(b.task_date)) || String(a.property_id || '').localeCompare(String(b.property_id || '')))
    return res.json(items)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'calendar_failed' })
  }
})

router.post('/backfill', requirePerm('cleaning.schedule.manage'), async (req, res) => {
  const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
  const fromParsed = dateSchema.safeParse((req.query as any)?.date_from)
  const toParsed = dateSchema.safeParse((req.query as any)?.date_to)
  const today = auDayStr(new Date())
  const from = (fromParsed.success ? fromParsed.data : undefined) || dayOnly(new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString()) || today
  const to = (toParsed.success ? toParsed.data : undefined) || dayOnly(new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString()) || today
  try {
    const r = await backfillCleaningTasks({ dateFrom: from, dateTo: to })
    return res.json({ ok: true, from, to, ...r })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'backfill_failed' })
  }
})

router.get('/debug/state', requirePerm('cleaning.schedule.manage'), async (_req, res) => {
  try {
    if (!hasPg || !pgPool) {
      return res.json({
        pg: false,
        memory: { orders: (db.orders || []).length, cleaningTasks: (db.cleaningTasks || []).length, cleaners: (db.cleaners || []).length },
      })
    }
    const rDb = await pgPool.query('SELECT current_database() AS db, current_schema() AS schema')
    const rPath = await pgPool.query('SHOW search_path')
    const rTables = await pgPool.query(`SELECT table_schema FROM information_schema.tables WHERE table_name='cleaning_tasks' ORDER BY table_schema`)
    const rCountOrders = await pgPool.query('SELECT COUNT(*)::int AS c FROM orders')
    const rCountTasks = await pgPool.query('SELECT COUNT(*)::int AS c FROM cleaning_tasks')
    const rCountLogs = await pgPool.query('SELECT COUNT(*)::int AS c FROM cleaning_sync_logs')
    const rMinMax = await pgPool.query(`SELECT MIN(COALESCE(task_date, date))::text AS min, MAX(COALESCE(task_date, date))::text AS max FROM cleaning_tasks`)
    return res.json({
      pg: true,
      db: rDb?.rows?.[0] || null,
      search_path: String(rPath?.rows?.[0]?.search_path || ''),
      cleaning_tasks_schemas: (rTables?.rows || []).map((x: any) => x.table_schema),
      counts: {
        orders: rCountOrders?.rows?.[0]?.c ?? null,
        cleaning_tasks: rCountTasks?.rows?.[0]?.c ?? null,
        cleaning_sync_logs: rCountLogs?.rows?.[0]?.c ?? null,
      },
      minmax: { min: rMinMax?.rows?.[0]?.min || null, max: rMinMax?.rows?.[0]?.max || null },
    })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'debug_failed' })
  }
})

router.get('/debug/order-sample', requirePerm('cleaning.schedule.manage'), async (req, res) => {
  const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
  const fromParsed = dateSchema.safeParse((req.query as any)?.from)
  const toParsed = dateSchema.safeParse((req.query as any)?.to)
  const from = fromParsed.success ? fromParsed.data : undefined
  const to = toParsed.success ? toParsed.data : undefined
  const limitRaw = Number((req.query as any)?.limit || 5)
  const limit = Math.max(1, Math.min(20, Number.isFinite(limitRaw) ? Math.trunc(limitRaw) : 5))
  try {
    if (!hasPg || !pgPool) return res.json({ pg: false })
    const dayExprCheckout = `CASE WHEN substring(o.checkout::text,1,10) ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN substring(o.checkout::text,1,10)::date END`
    const dayExprCheckin = `CASE WHEN substring(o.checkin::text,1,10) ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN substring(o.checkin::text,1,10)::date END`
    const whereRange =
      from && to
        ? `(
            ((${dayExprCheckout}) IS NOT NULL AND (${dayExprCheckout}) >= ($1::date) AND (${dayExprCheckout}) <= ($2::date))
            OR
            ((${dayExprCheckin}) IS NOT NULL AND (${dayExprCheckin}) >= ($1::date) AND (${dayExprCheckin}) <= ($2::date))
          )`
        : `(${dayExprCheckout}) IS NOT NULL OR (${dayExprCheckin}) IS NOT NULL`
    const params = from && to ? [from, to, limit] : [limit]
    const sql = `
      SELECT
        (o.id::text) AS id,
        (o.property_id::text) AS property_id,
        COALESCE(o.status,'') AS status,
        o.checkin::text AS checkin_text,
        o.checkout::text AS checkout_text,
        o.nights AS nights,
        (${dayExprCheckin})::text AS checkin_day,
        (${dayExprCheckout})::text AS checkout_day
      FROM orders o
      WHERE ${whereRange}
      ORDER BY COALESCE((${dayExprCheckout}), (${dayExprCheckin})) ASC, o.id
      LIMIT $${from && to ? 3 : 1}
    `
    const r = await pgPool.query(sql, params)
    const rows = r?.rows || []
    const full: any[] = []
    for (const rr of rows) {
      const r2 = await pgPool.query('SELECT * FROM orders WHERE (id::text)=$1 LIMIT 1', [String(rr.id)])
      const o = r2?.rows?.[0] || null
      const checkin = o?.checkin
      const checkout = o?.checkout
      full.push({
        summary: rr,
        runtime: o
          ? {
              checkin_type: Object.prototype.toString.call(checkin),
              checkout_type: Object.prototype.toString.call(checkout),
              checkin_str: String(checkin),
              checkout_str: String(checkout),
            }
          : null,
      })
    }
    return res.json({ ok: true, from: from || null, to: to || null, limit, rows: full })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'order_sample_failed' })
  }
})

router.post('/debug/sync-one', requirePerm('cleaning.schedule.manage'), async (req, res) => {
  const schema = z.object({ order_id: z.string().min(1) }).strict()
  const parsed = schema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const orderId = String(parsed.data.order_id)
  try {
    if (!hasPg || !pgPool) return res.status(400).json({ message: 'pg=false' })
    const beforeTasks = await pgPool.query('SELECT * FROM cleaning_tasks WHERE (order_id::text)=$1 ORDER BY task_type, id', [orderId])
    const beforeCount = Number(beforeTasks?.rows?.length || 0)
    let job: any = null
    try {
      const { pgRunInTransaction } = require('../dbAdapter')
      const { enqueueCleaningSyncJobTx } = require('../services/cleaningSyncJobs')
      await pgRunInTransaction(async (client: any) => {
        job = await enqueueCleaningSyncJobTx(client, { order_id: orderId, action: 'updated', payload_snapshot: { id: orderId } })
      })
    } catch (e: any) {
      job = { error: String(e?.message || 'enqueue_failed') }
    }
    const afterTasks = await pgPool.query('SELECT * FROM cleaning_tasks WHERE (order_id::text)=$1 ORDER BY task_type, id', [orderId])
    const afterCount = Number(afterTasks?.rows?.length || 0)
    const orderRow = await pgPool.query('SELECT * FROM orders WHERE (id::text)=$1 LIMIT 1', [orderId])
    return res.json({
      ok: true,
      order_id: orderId,
      before_count: beforeCount,
      after_count: afterCount,
      job,
      order: orderRow?.rows?.[0] || null,
      tasks: afterTasks?.rows || [],
    })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'sync_one_failed' })
  }
})

router.get('/tasks/minmax', requireAnyPerm(['cleaning.view', 'cleaning.schedule.manage', 'cleaning.task.assign']), async (req, res) => {
  const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
  const parsed = dateSchema.safeParse((req.query as any)?.from)
  const from = parsed.success ? (parsed.data || auDayStr(new Date())) : auDayStr(new Date())
  try {
    if (!hasPg || !pgPool) return res.json({ ok: true, min: null, max: null, from })
    const sql = `SELECT MIN(COALESCE(task_date, date))::text AS min, MAX(COALESCE(task_date, date))::text AS max FROM cleaning_tasks WHERE (COALESCE(task_date, date)::date) >= ($1::date)`
    const r = await pgPool.query(sql, [from])
    const min = r?.rows?.[0]?.min ? String(r.rows[0].min).slice(0, 10) : null
    const max = r?.rows?.[0]?.max ? String(r.rows[0].max).slice(0, 10) : null
    return res.json({ ok: true, min, max, from })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'minmax_failed' })
  }
})
