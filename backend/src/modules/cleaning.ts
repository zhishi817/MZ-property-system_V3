import { Router } from 'express'
import { z } from 'zod'
import { requireAnyPerm, requirePerm } from '../auth'
import { db } from '../store'
import { hasPg, pgPool } from '../dbAdapter'
import { backfillCleaningTasks, ensureCleaningSchemaV2, syncOrderToCleaningTasks } from '../services/cleaningSync'
import { v4 as uuid } from 'uuid'

export const router = Router()

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
  await pgPool.query(`CREATE TABLE IF NOT EXISTS cleaning_offline_tasks (
    id text PRIMARY KEY,
    date date NOT NULL,
    task_type text NOT NULL DEFAULT 'other',
    title text NOT NULL,
    content text NOT NULL DEFAULT '',
    kind text NOT NULL,
    status text NOT NULL,
    urgency text NOT NULL,
    property_id text,
    assignee_id text,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
  );`)
  await pgPool.query(`ALTER TABLE cleaning_offline_tasks ADD COLUMN IF NOT EXISTS task_type text NOT NULL DEFAULT 'other';`)
  await pgPool.query(`ALTER TABLE cleaning_offline_tasks ADD COLUMN IF NOT EXISTS content text NOT NULL DEFAULT '';`)
  await pgPool.query(`ALTER TABLE cleaning_offline_tasks ADD COLUMN IF NOT EXISTS assignee_id text;`)
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_cleaning_offline_tasks_date ON cleaning_offline_tasks(date);')
}

router.get('/staff', requireAnyPerm(['cleaning.view', 'cleaning.schedule.manage', 'cleaning.task.assign']), (_req, res) => {
  res.json(db.cleaners)
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
      return res.status(201).json(r?.rows?.[0] || row)
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
      await ensureCleaningSchemaV2()
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

const patchTaskSchema = z.object({
  property_id: z.string().nullable().optional(),
  task_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  status: z.enum(['pending', 'assigned', 'in_progress', 'completed', 'cancelled']).optional(),
  assignee_id: z.union([z.string().min(1), z.null()]).optional(),
  scheduled_at: z.union([z.string().min(1), z.null()]).optional(),
  note: z.union([z.string(), z.null()]).optional(),
}).strict()

router.patch('/tasks/:id', requirePerm('cleaning.task.assign'), async (req, res) => {
  const { id } = req.params
  const parsed = patchTaskSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (hasPg && pgPool) {
      await ensureCleaningSchemaV2()
      const r0 = await pgPool.query('SELECT * FROM cleaning_tasks WHERE id = $1 LIMIT 1', [String(id)])
      const before = r0?.rows?.[0] || null
      if (!before) return res.status(404).json({ message: 'task not found' })

      const keyChanged =
        (parsed.data.task_date != null && String(parsed.data.task_date) !== String(before.task_date || before.date || '')) ||
        (parsed.data.assignee_id !== undefined && String(parsed.data.assignee_id ?? '') !== String(before.assignee_id ?? '')) ||
        (parsed.data.scheduled_at !== undefined && String(parsed.data.scheduled_at ?? '') !== String(before.scheduled_at ?? ''))

      const patch: any = { ...parsed.data }
      if (patch.task_date != null) patch.date = patch.task_date
      if (keyChanged) patch.auto_sync_enabled = false
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
    if (parsed.data.assignee_id !== undefined) task.assignee_id = parsed.data.assignee_id
    if (parsed.data.scheduled_at !== undefined) task.scheduled_at = parsed.data.scheduled_at
    if (parsed.data.note !== undefined) task.note = parsed.data.note
    const keyChanged =
      (parsed.data.task_date != null && String(parsed.data.task_date) !== String(before.task_date || before.date || '')) ||
      (parsed.data.assignee_id !== undefined && String(parsed.data.assignee_id ?? '') !== String(before.assignee_id ?? '')) ||
      (parsed.data.scheduled_at !== undefined && String(parsed.data.scheduled_at ?? '') !== String(before.scheduled_at ?? ''))
    if (keyChanged) task.auto_sync_enabled = false
    return res.json(task)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'update_failed' })
  }
})

router.post('/tasks/:id/restore-auto-sync', requirePerm('cleaning.schedule.manage'), async (req, res) => {
  const { id } = req.params
  try {
    if (hasPg && pgPool) {
      await ensureCleaningSchemaV2()
      const r0 = await pgPool.query('SELECT * FROM cleaning_tasks WHERE id = $1 LIMIT 1', [String(id)])
      const task = r0?.rows?.[0] || null
      if (!task) return res.status(404).json({ message: 'task not found' })
      const r1 = await pgPool.query('UPDATE cleaning_tasks SET auto_sync_enabled=true, updated_at=now() WHERE id=$1 RETURNING *', [String(id)])
      const updated = r1?.rows?.[0] || task
      const orderId = updated?.order_id ? String(updated.order_id) : ''
      if (orderId) {
        try { await syncOrderToCleaningTasks(orderId) } catch {}
      }
      return res.json({ ok: true, task: updated })
    }
    const task = (db.cleaningTasks as any[]).find((t: any) => String(t.id) === String(id))
    if (!task) return res.status(404).json({ message: 'task not found' })
    task.auto_sync_enabled = true
    const orderId = task.order_id ? String(task.order_id) : ''
    if (orderId) { try { await syncOrderToCleaningTasks(orderId) } catch {} }
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
    await ensureCleaningSchemaV2()
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
      await ensureCleaningSchemaV2()
      const r = await pgPool.query(
        `SELECT
           t.id,
           t.order_id,
           t.property_id,
           (p.code::text) AS property_code,
           (p.region::text) AS property_region,
           t.task_type,
           COALESCE(t.task_date, t.date)::text AS task_date,
           t.status,
           t.assignee_id,
           t.scheduled_at,
           t.source,
           t.auto_sync_enabled,
           t.old_code,
           t.new_code,
           (o.confirmation_code::text) AS order_code,
           (o.nights) AS nights
         FROM cleaning_tasks t
         LEFT JOIN orders o ON (o.id::text) = (t.order_id::text)
         LEFT JOIN properties p ON (p.id::text) = (t.property_id::text)
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
         ORDER BY COALESCE(task_date, date) ASC, property_id NULLS LAST, id`,
        [from, to]
      )
      for (const row of (r?.rows || [])) {
        const d = String(row.task_date || '').slice(0, 10)
        const rawType = row.task_type ? String(row.task_type) : 'cleaning_task'
        const label =
          rawType === 'checkout_clean' ? '退房' :
          rawType === 'checkin_clean' ? '入住' :
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
          scheduled_at: row.scheduled_at ? String(row.scheduled_at) : null,
          auto_sync_enabled: row.auto_sync_enabled !== false,
          old_code: row.old_code != null ? String(row.old_code || '') : null,
          new_code: row.new_code != null ? String(row.new_code || '') : null,
          nights: row.nights != null ? Number(row.nights) : null,
          summary_checkout_time: '11:30',
          summary_checkin_time: '3pm',
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
        scheduled_at: t.scheduled_at ? String(t.scheduled_at) : null,
        auto_sync_enabled: t.auto_sync_enabled !== false,
        old_code: t.old_code != null ? String(t.old_code || '') : null,
        new_code: t.new_code != null ? String(t.new_code || '') : null,
        nights: order?.nights != null ? Number(order.nights) : null,
        summary_checkout_time: '11:30',
        summary_checkin_time: '3pm',
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
    await ensureCleaningSchemaV2()
    const beforeTasks = await pgPool.query('SELECT * FROM cleaning_tasks WHERE (order_id::text)=$1 ORDER BY task_type, id', [orderId])
    const beforeCount = Number(beforeTasks?.rows?.length || 0)
    let syncResult: any = null
    try {
      syncResult = await syncOrderToCleaningTasks(orderId)
    } catch (e: any) {
      syncResult = { error: String(e?.message || 'sync_failed') }
    }
    const afterTasks = await pgPool.query('SELECT * FROM cleaning_tasks WHERE (order_id::text)=$1 ORDER BY task_type, id', [orderId])
    const afterCount = Number(afterTasks?.rows?.length || 0)
    const orderRow = await pgPool.query('SELECT * FROM orders WHERE (id::text)=$1 LIMIT 1', [orderId])
    return res.json({
      ok: true,
      order_id: orderId,
      before_count: beforeCount,
      after_count: afterCount,
      sync: syncResult,
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
    await ensureCleaningSchemaV2()
    const sql = `SELECT MIN(COALESCE(task_date, date))::text AS min, MAX(COALESCE(task_date, date))::text AS max FROM cleaning_tasks WHERE (COALESCE(task_date, date)::date) >= ($1::date)`
    const r = await pgPool.query(sql, [from])
    const min = r?.rows?.[0]?.min ? String(r.rows[0].min).slice(0, 10) : null
    const max = r?.rows?.[0]?.max ? String(r.rows[0].max).slice(0, 10) : null
    return res.json({ ok: true, min, max, from })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'minmax_failed' })
  }
})
