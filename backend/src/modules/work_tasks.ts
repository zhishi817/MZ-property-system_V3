import { Router } from 'express'
import { z } from 'zod'
import { requireAnyPerm, requirePerm } from '../auth'
import { hasPg, pgPool } from '../dbAdapter'
import { v4 as uuid } from 'uuid'
import { emitNotificationEvent } from '../services/notificationEvents'
import { buildWorkTaskVisibilityHints, emitWorkTaskEvent } from '../services/workTaskEvents'

export const router = Router()

function enqueueNotification(task: () => Promise<any>) {
  setImmediate(() => {
    task().catch((e: any) => {
      try { console.error(`[work-tasks][notification_async_failed] message=${String(e?.message || '')}`) } catch {}
    })
  })
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
  await pgPool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_work_tasks_source ON work_tasks(source_type, source_id);`)
  await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_work_tasks_day_assignee ON work_tasks(scheduled_date, assignee_id, status);`)
  await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_work_tasks_kind_day ON work_tasks(task_kind, scheduled_date);`)
  await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_work_tasks_day ON work_tasks(scheduled_date);`)
}

function normId(v: any): string | null {
  const s = String(v ?? '').trim()
  return s ? s : null
}

function normStatus(v: any): string {
  const s = String(v ?? '').trim().toLowerCase()
  if (s === 'done' || s === 'completed') return 'done'
  if (s === 'cancelled' || s === 'canceled') return 'cancelled'
  if (s === 'in_progress') return 'in_progress'
  if (s === 'assigned') return 'assigned'
  return 'todo'
}

function normUrgency(v: any): string {
  const s = String(v ?? '').trim().toLowerCase()
  if (s === 'low' || s === 'medium' || s === 'high' || s === 'urgent') return s
  return 'medium'
}

function dayOnly(v: any): string | null {
  const s = String(v ?? '').slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null
}

function taskCompletedTitle(title: any) {
  const base = String(title || '').trim()
  return base ? `任务已完成：${base}` : '任务已完成'
}

function taskCompletedBody(title: any) {
  const base = String(title || '').trim()
  return base ? `${base} 已标记完成` : '任务已标记完成'
}

const createSchema = z.object({
  task_kind: z.string().min(1),
  property_id: z.string().nullable().optional(),
  title: z.string().min(1),
  summary: z.string().nullable().optional(),
  scheduled_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  start_time: z.string().nullable().optional(),
  end_time: z.string().nullable().optional(),
  assignee_id: z.string().nullable().optional(),
  status: z.string().optional(),
  urgency: z.string().optional(),
  source_type: z.string().nullable().optional(),
  source_id: z.string().nullable().optional(),
}).strict()

const patchSchema = createSchema.partial().strict()

async function upsertWorkTaskFromSource(sourceType: string, sourceId: string, patch: any) {
  if (!hasPg || !pgPool) return
  await ensureWorkTasksTable()
  const st = String(sourceType || '').trim()
  const sid = String(sourceId || '').trim()
  if (!st || !sid) return
  const id = `${st}:${sid}`
  const keys = Object.keys(patch || {}).filter((k) => patch[k] !== undefined)
  const cols = ['id', 'source_type', 'source_id', ...keys]
  const vals = [id, st, sid, ...keys.map((k) => patch[k])]
  const ph = cols.map((_, i) => `$${i + 1}`).join(', ')
  const upd = keys.length
    ? keys.map((k, i) => `"${k}" = EXCLUDED."${k}"`).join(', ')
    : ''
  const sql = `
    INSERT INTO work_tasks(${cols.map((c) => `"${c}"`).join(', ')})
    VALUES(${ph})
    ON CONFLICT (source_type, source_id) DO UPDATE SET ${upd || 'updated_at = now()'}
    RETURNING id
  `
  await pgPool.query(sql, vals)
}

async function propagateToSource(sourceType: string, sourceId: string, patch: any) {
  if (!hasPg || !pgPool) return
  const st = String(sourceType || '').trim()
  const sid = String(sourceId || '').trim()
  if (!st || !sid) return
  const assigneeId = patch.assignee_id === undefined ? undefined : (normId(patch.assignee_id) || null)
  const scheduledDate = patch.scheduled_date === undefined ? undefined : (dayOnly(patch.scheduled_date) || null)
  const status = patch.status === undefined ? undefined : normStatus(patch.status)
  if (st === 'property_maintenance') {
    const set: string[] = []
    const vals: any[] = []
    if (assigneeId !== undefined) { vals.push(assigneeId); set.push(`assignee_id = $${vals.length}`) }
    if (scheduledDate !== undefined) { vals.push(scheduledDate); set.push(`eta = $${vals.length}::date`) }
    if (status !== undefined) {
      const mapped = status === 'done' ? 'completed' : (status === 'cancelled' ? 'cancelled' : null)
      if (mapped) { vals.push(mapped); set.push(`status = $${vals.length}`) }
      if (status === 'done') set.push(`completed_at = now()`)
    }
    if (!set.length) return
    vals.push(sid)
    await pgPool.query(`UPDATE property_maintenance SET ${set.join(', ')}, updated_at=now() WHERE id=$${vals.length}`, vals)
    return
  }
  if (st === 'property_deep_cleaning') {
    const set: string[] = []
    const vals: any[] = []
    if (assigneeId !== undefined) { vals.push(assigneeId); set.push(`assignee_id = $${vals.length}`) }
    if (scheduledDate !== undefined) { vals.push(scheduledDate); set.push(`eta = $${vals.length}::date`) }
    if (status !== undefined) {
      const mapped = status === 'done' ? 'completed' : (status === 'cancelled' ? 'cancelled' : null)
      if (mapped) { vals.push(mapped); set.push(`status = $${vals.length}`) }
      if (status === 'done') set.push(`completed_at = now()`)
    }
    if (!set.length) return
    vals.push(sid)
    await pgPool.query(`UPDATE property_deep_cleaning SET ${set.join(', ')}, updated_at=now() WHERE id=$${vals.length}`, vals)
    return
  }
  if (st === 'cleaning_offline_tasks') {
    const set: string[] = []
    const vals: any[] = []
    if (assigneeId !== undefined) { vals.push(assigneeId); set.push(`assignee_id = $${vals.length}`) }
    if (scheduledDate !== undefined) { vals.push(scheduledDate); set.push(`date = $${vals.length}::date`) }
    if (status !== undefined) {
      const mapped = status === 'done' ? 'done' : 'todo'
      vals.push(mapped); set.push(`status = $${vals.length}`)
    }
    if (!set.length) return
    vals.push(sid)
    await pgPool.query(`UPDATE cleaning_offline_tasks SET ${set.join(', ')}, updated_at=now() WHERE id=$${vals.length}`, vals)
    return
  }
}

router.get('/day', requireAnyPerm(['cleaning.view', 'cleaning.schedule.manage', 'cleaning.task.assign']), async (req, res) => {
  const date = dayOnly((req.query as any)?.date)
  if (!date) return res.status(400).json({ message: 'invalid date' })
  const includeOverdue = String((req.query as any)?.include_overdue || '').trim() === '1'
  const includeUnscheduled = String((req.query as any)?.include_unscheduled || '').trim() !== '0'
  const includeFuture = String((req.query as any)?.include_future || '').trim() !== '0'
  try {
    if (!hasPg || !pgPool) return res.json({ date, pool: [], groups: {}, tasks: [] })
    await ensureWorkTasksTable()
    const doneSet = ['done', 'completed', 'cancelled', 'canceled']
    const where: string[] = []
    const vals: any[] = [date, doneSet]
    where.push(`scheduled_date = $1::date`)
    if (includeOverdue) where.push(`(scheduled_date IS NOT NULL AND scheduled_date < $1::date)`)
    if (includeUnscheduled) where.push(`(scheduled_date IS NULL)`)
    if (includeFuture) where.push(`(scheduled_date IS NOT NULL AND scheduled_date > $1::date)`)
    const sql = `SELECT * FROM work_tasks WHERE status <> ALL($2::text[]) AND (${where.join(' OR ')}) ORDER BY COALESCE(scheduled_date, $1::date) ASC, urgency DESC, updated_at DESC, id DESC`
    const r = await pgPool.query(sql, vals)
    const tasks = (r?.rows || []).map((x: any) => ({
      ...x,
      id: String(x.id),
      task_kind: String(x.task_kind || ''),
      source_type: String(x.source_type || ''),
      source_id: String(x.source_id || ''),
      property_id: x.property_id ? String(x.property_id) : null,
      title: String(x.title || ''),
      summary: x.summary !== undefined && x.summary !== null ? String(x.summary || '') : null,
      scheduled_date: x.scheduled_date ? String(x.scheduled_date).slice(0, 10) : null,
      start_time: x.start_time !== undefined && x.start_time !== null ? String(x.start_time || '') : null,
      end_time: x.end_time !== undefined && x.end_time !== null ? String(x.end_time || '') : null,
      assignee_id: x.assignee_id ? String(x.assignee_id) : null,
      status: normStatus(x.status),
      urgency: normUrgency(x.urgency),
    }))
    const pool: any[] = []
    const groups: Record<string, any[]> = {}
    for (const t of tasks) {
      const aid = normId(t.assignee_id)
      if (!aid || t.scheduled_date !== date) pool.push(t)
      else {
        groups[aid] = groups[aid] || []
        groups[aid].push(t)
      }
    }
    return res.json({ date, pool, groups, tasks })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'work_tasks_day_failed' })
  }
})

router.post('/', requirePerm('cleaning.schedule.manage'), async (req, res) => {
  const parsed = createSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    await ensureWorkTasksTable()
    const user = (req as any).user || {}
    const payload = parsed.data
    const taskKind = String(payload.task_kind || '').trim()
    const sourceType = String(payload.source_type || '').trim() || 'work_tasks'
    const rawSourceId = String(payload.source_id || '').trim()
    const sourceId = rawSourceId || uuid()
    const id = `${sourceType}:${sourceId}`
    const now = new Date().toISOString()
    const status = normStatus(payload.status)
    const urgency = normUrgency(payload.urgency)
    const scheduledDate = payload.scheduled_date === undefined ? null : (payload.scheduled_date ? dayOnly(payload.scheduled_date) : null)
    const assigneeId = payload.assignee_id === undefined ? null : (normId(payload.assignee_id) || null)
    const row = {
      id,
      task_kind: taskKind,
      source_type: sourceType,
      source_id: sourceId,
      property_id: payload.property_id ?? null,
      title: String(payload.title || '').trim(),
      summary: payload.summary !== undefined ? (payload.summary ?? null) : null,
      scheduled_date: scheduledDate,
      start_time: payload.start_time ?? null,
      end_time: payload.end_time ?? null,
      assignee_id: assigneeId,
      status,
      urgency,
      created_by: String(user.username || user.sub || ''),
      updated_by: String(user.username || user.sub || ''),
      created_at: now,
      updated_at: now,
    }
    await pgPool.query(
      `INSERT INTO work_tasks(
        id, task_kind, source_type, source_id, property_id, title, summary,
        scheduled_date, start_time, end_time, assignee_id, status, urgency,
        created_by, updated_by, created_at, updated_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8::date,$9,$10,$11,$12,$13,$14,$15,$16,$17::timestamptz,$18::timestamptz)`,
      [
        row.id, row.task_kind, row.source_type, row.source_id, row.property_id, row.title, row.summary,
        row.scheduled_date, row.start_time, row.end_time, row.assignee_id, row.status, row.urgency,
        row.created_by, row.updated_by, row.created_at, row.updated_at,
      ]
    )
    await emitWorkTaskEvent({
      taskId: `work_task:${row.id}`,
      sourceType: 'work_tasks',
      sourceRefIds: [row.id],
      eventType: 'TASK_CREATED',
      changeScope: 'list',
      changedFields: ['task_kind', 'property_id', 'title', 'summary', 'scheduled_date', 'start_time', 'end_time', 'assignee_id', 'status', 'urgency'],
      patch: row,
      causedByUserId: String(user.sub || user.username || '').trim() || null,
      visibilityHints: buildWorkTaskVisibilityHints(row),
    })
    if (normStatus(row.status) === 'done') {
      await emitWorkTaskEvent({
        taskId: `work_task:${row.id}`,
        sourceType: 'work_tasks',
        sourceRefIds: [row.id],
        eventType: 'TASK_COMPLETED',
        changeScope: 'list',
        changedFields: ['status'],
        patch: { status: 'done' },
        causedByUserId: String(user.sub || user.username || '').trim() || null,
        visibilityHints: buildWorkTaskVisibilityHints(row),
      })
      enqueueNotification(() =>
        emitNotificationEvent(
          {
            type: 'WORK_TASK_COMPLETED',
            entity: 'work_task',
            entityId: String(row.id),
            propertyId: row.property_id ? String(row.property_id) : undefined,
            updatedAt: String(row.updated_at || '').trim() || now,
            title: taskCompletedTitle(row.title),
            body: taskCompletedBody(row.title),
            data: { entity: 'work_task', entityId: String(row.id), action: 'open_work_task', kind: 'work_task_completed', task_id: String(row.id) },
            actorUserId: String(user.sub || '').trim() || null,
          },
          { operationId: uuid() },
        ),
      )
    }
    return res.status(201).json(row)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'create_failed' })
  }
})

router.patch('/:id', requirePerm('cleaning.schedule.manage'), async (req, res) => {
  const id = String((req.params as any)?.id || '').trim()
  if (!id) return res.status(400).json({ message: 'missing id' })
  const parsed = patchSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    await ensureWorkTasksTable()
    const user = (req as any).user || {}
    const patch = parsed.data as any
    const r0 = await pgPool.query('SELECT * FROM work_tasks WHERE id=$1 LIMIT 1', [id])
    const cur = r0?.rows?.[0] || null
    if (!cur) return res.status(404).json({ message: 'task not found' })
    const sourceType = String(cur.source_type || '')
    const sourceId = String(cur.source_id || '')
    const set: string[] = []
    const vals: any[] = []
    const add = (k: string, v: any) => { vals.push(v); set.push(`"${k}" = $${vals.length}`) }
    if (patch.task_kind !== undefined) add('task_kind', String(patch.task_kind || '').trim())
    if (patch.property_id !== undefined) add('property_id', patch.property_id ?? null)
    if (patch.title !== undefined) add('title', String(patch.title || '').trim())
    if (patch.summary !== undefined) add('summary', patch.summary ?? null)
    if (patch.scheduled_date !== undefined) add('scheduled_date', patch.scheduled_date ? dayOnly(patch.scheduled_date) : null)
    if (patch.start_time !== undefined) add('start_time', patch.start_time ?? null)
    if (patch.end_time !== undefined) add('end_time', patch.end_time ?? null)
    if (patch.assignee_id !== undefined) add('assignee_id', normId(patch.assignee_id) || null)
    if (patch.status !== undefined) add('status', normStatus(patch.status))
    if (patch.urgency !== undefined) add('urgency', normUrgency(patch.urgency))
    add('updated_by', String(user.username || user.sub || ''))
    set.push(`updated_at = now()`)
    vals.push(id)
    const sql = `UPDATE work_tasks SET ${set.join(', ')} WHERE id=$${vals.length} RETURNING *`
    const r1 = await pgPool.query(sql, vals)
    const row = r1?.rows?.[0] || cur
    const changedFields = Object.keys(patch || {}).filter((key) => patch[key] !== undefined)
    const assigneeChanged = patch.assignee_id !== undefined && String(cur.assignee_id || '') !== String(row.assignee_id || '')
    const completedChanged = normStatus(cur.status) !== 'done' && normStatus(row.status) === 'done'
    await propagateToSource(sourceType, sourceId, patch)
    await emitWorkTaskEvent({
      taskId: `work_task:${row.id}`,
      sourceType: 'work_tasks',
      sourceRefIds: [String(row.id)],
      eventType: completedChanged ? 'TASK_COMPLETED' : assigneeChanged ? 'TASK_ASSIGNMENT_CHANGED' : 'TASK_UPDATED',
      changeScope: assigneeChanged ? 'membership' : 'list',
      changedFields,
      patch: Object.fromEntries(changedFields.map((field) => [field, (row as any)[field]])),
      causedByUserId: String(user.sub || user.username || '').trim() || null,
      visibilityHints: buildWorkTaskVisibilityHints(row),
    })
    try {
      const operationId = uuid()
      const assigneeId = String(row.assignee_id || '').trim()
      const actorId = String(user.sub || '').trim()
      const to = assigneeId && assigneeId !== actorId ? [assigneeId] : []
      const propertyId = row.property_id ? String(row.property_id) : ''
      if (to.length && propertyId) {
        enqueueNotification(() =>
          emitNotificationEvent(
            {
              type: 'WORK_TASK_UPDATED',
              entity: 'work_task',
              entityId: String(row.id),
              propertyId,
              updatedAt: String(row.updated_at || '').trim() || new Date().toISOString(),
              title: '任务有更新',
              body: `${String(row.title || '任务')} 已更新`,
              data: { entity: 'work_task', entityId: String(row.id), action: 'open_work_task', kind: 'work_task_updated', task_id: String(row.id) },
              actorUserId: actorId,
              recipientUserIds: to,
            },
            { operationId },
          ),
        )
      }
    } catch {}
    try {
      const actorId = String(user.sub || '').trim()
      const propertyId = row.property_id ? String(row.property_id) : ''
      if (completedChanged) {
        enqueueNotification(() =>
          emitNotificationEvent(
            {
              type: 'WORK_TASK_COMPLETED',
              entity: 'work_task',
              entityId: String(row.id),
              propertyId: propertyId || undefined,
              updatedAt: String(row.updated_at || '').trim() || new Date().toISOString(),
              title: taskCompletedTitle(row.title),
              body: taskCompletedBody(row.title),
              data: { entity: 'work_task', entityId: String(row.id), action: 'open_work_task', kind: 'work_task_completed', task_id: String(row.id) },
              actorUserId: actorId || null,
            },
            { operationId: uuid() },
          ),
        )
      }
    } catch {}
    return res.json({
      ...row,
      id: String(row.id),
      task_kind: String(row.task_kind || ''),
      source_type: String(row.source_type || ''),
      source_id: String(row.source_id || ''),
      property_id: row.property_id ? String(row.property_id) : null,
      title: String(row.title || ''),
      summary: row.summary !== undefined && row.summary !== null ? String(row.summary || '') : null,
      scheduled_date: row.scheduled_date ? String(row.scheduled_date).slice(0, 10) : null,
      start_time: row.start_time !== undefined && row.start_time !== null ? String(row.start_time || '') : null,
      end_time: row.end_time !== undefined && row.end_time !== null ? String(row.end_time || '') : null,
      assignee_id: row.assignee_id ? String(row.assignee_id) : null,
      status: normStatus(row.status),
      urgency: normUrgency(row.urgency),
    })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'update_failed' })
  }
})

router.post('/upsert-from-source', requirePerm('cleaning.schedule.manage'), async (req, res) => {
  const body = req.body || {}
  const sourceType = String(body.source_type || '').trim()
  const sourceId = String(body.source_id || '').trim()
  const patch = body.patch || {}
  try {
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    await upsertWorkTaskFromSource(sourceType, sourceId, patch)
    return res.json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'upsert_failed' })
  }
})
