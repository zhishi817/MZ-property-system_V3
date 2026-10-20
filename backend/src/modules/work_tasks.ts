import { Router } from 'express'
import { z } from 'zod'
import { requireAnyPerm, requirePerm } from '../auth'
import { hasPg, pgPool } from '../dbAdapter'
import { v4 as uuid } from 'uuid'
import { emitNotificationEvent } from '../services/notificationEvents'
import { buildWorkTaskVisibilityHints, emitWorkTaskEvent } from '../services/workTaskEvents'
import { assertR5TaskRuntimeSchemaReady, requireR5TaskRuntimeSchema } from '../lib/r5RequestSchema'

export const router = Router()

function enqueueNotification(task: () => Promise<any>) {
  setImmediate(() => {
    task().catch((e: any) => {
      try { console.error(`[work-tasks][notification_async_failed] message=${String(e?.message || '')}`) } catch {}
    })
  })
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

function autoStatusForWorkAssignee(assigneeId: any): string {
  return String(assigneeId ?? '').trim() ? 'assigned' : 'todo'
}

function dayOnly(v: any): string | null {
  const s = String(v ?? '').slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null
}

function melbourneDateOnly(value: any): string | null {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return null
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Melbourne',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  const result = `${byType.year}-${byType.month}-${byType.day}`
  return /^\d{4}-\d{2}-\d{2}$/.test(result) ? result : null
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

const patchSchema = createSchema.partial().extend({
  completion_reason: z.string().trim().min(1).max(2000).nullable().optional(),
}).strict()

const upsertFromSourceSchema = z.object({
  source_type: z.string().trim().min(1).max(160),
  source_id: z.string().trim().min(1).max(160),
  patch: createSchema.omit({ source_type: true, source_id: true }).partial().strict()
    .refine((value) => Object.keys(value).length > 0, { message: 'empty patch' }),
}).strict()

async function upsertWorkTaskFromSource(
  sourceType: string,
  sourceId: string,
  patch: any,
  executor: { query: (sql: string, params?: any[]) => Promise<any> } | null = pgPool,
) {
  if (!hasPg || !executor) return null
  assertR5TaskRuntimeSchemaReady()
  const st = String(sourceType || '').trim()
  const sid = String(sourceId || '').trim()
  if (!st || !sid) return
  const id = `${st}:${sid}`
  const keys = Object.keys(patch || {}).filter((k) => patch[k] !== undefined)
  const cols = ['id', 'source_type', 'source_id', ...keys]
  const vals = [id, st, sid, ...keys.map((k) => patch[k])]
  const ph = cols.map((_, i) => `$${i + 1}`).join(', ')
  const upd = keys.length
    ? [...keys.map((k) => `"${k}" = EXCLUDED."${k}"`), 'updated_at = now()'].join(', ')
    : ''
  const sql = `
    INSERT INTO work_tasks(${cols.map((c) => `"${c}"`).join(', ')})
    VALUES(${ph})
    ON CONFLICT (source_type, source_id) DO UPDATE SET ${upd || 'updated_at = now()'}
      WHERE lower(COALESCE(work_tasks.status, '')) NOT IN ('done', 'completed', 'ready', 'cancelled', 'canceled', 'closed')
    RETURNING *
  `
  const result = await executor.query(sql, vals)
  return result?.rows?.[0] || null
}

async function propagateToSource(
  sourceType: string,
  sourceId: string,
  patch: any,
  executor: { query: (sql: string, params?: any[]) => Promise<any> } | null = pgPool,
) {
  if (!hasPg || !executor) return
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
    await executor.query(`UPDATE property_maintenance SET ${set.join(', ')}, updated_at=now() WHERE id=$${vals.length}`, vals)
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
    await executor.query(`UPDATE property_deep_cleaning SET ${set.join(', ')}, updated_at=now() WHERE id=$${vals.length}`, vals)
    return
  }
  if (st === 'cleaning_offline_tasks') {
    const set: string[] = []
    const vals: any[] = []
    if (scheduledDate !== undefined) { vals.push(scheduledDate); set.push(`date = $${vals.length}::date`) }
    if (!set.length) return
    vals.push(sid)
    await executor.query(`UPDATE cleaning_offline_tasks SET ${set.join(', ')}, updated_at=now() WHERE id=$${vals.length}`, vals)
    return
  }
}

router.get('/day', requireAnyPerm(['cleaning.view', 'cleaning.schedule.manage', 'cleaning.task.assign']), requireR5TaskRuntimeSchema, async (req, res) => {
  const date = dayOnly((req.query as any)?.date)
  if (!date) return res.status(400).json({ message: 'invalid date' })
  const includeOverdue = String((req.query as any)?.include_overdue || '').trim() === '1'
  const includeUnscheduled = String((req.query as any)?.include_unscheduled || '').trim() !== '0'
  const includeFuture = String((req.query as any)?.include_future || '').trim() !== '0'
  try {
    if (!hasPg || !pgPool) return res.json({ date, pool: [], groups: {}, tasks: [] })
    const doneSet = ['done', 'completed', 'cancelled', 'canceled']
    const where: string[] = []
    const vals: any[] = [date, doneSet]
    where.push(`scheduled_date = $1::date`)
    if (includeOverdue) where.push(`(scheduled_date IS NOT NULL AND scheduled_date < $1::date)`)
    if (includeUnscheduled) where.push(`(scheduled_date IS NULL)`)
    if (includeFuture) where.push(`(scheduled_date IS NOT NULL AND scheduled_date > $1::date)`)
    const sql = `SELECT * FROM work_tasks WHERE status <> ALL($2::text[]) AND (${where.join(' OR ')}) ORDER BY COALESCE(scheduled_date, $1::date) ASC, CASE WHEN lower(COALESCE(task_kind, '')) = 'offline' THEN NULL ELSE urgency END DESC NULLS LAST, updated_at DESC, id DESC`
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
      urgency: String(x.task_kind || '').toLowerCase() === 'offline' ? null : normUrgency(x.urgency),
      photo_urls: Array.isArray(x.photo_urls) ? x.photo_urls : [],
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

router.post('/', requirePerm('cleaning.schedule.manage'), requireR5TaskRuntimeSchema, async (req, res) => {
  const parsed = createSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    const user = (req as any).user || {}
    const payload = parsed.data
    const taskKind = String(payload.task_kind || '').trim()
    const sourceType = String(payload.source_type || '').trim() || 'work_tasks'
    if (['property_maintenance', 'external_maintenance_orders'].includes(sourceType)) {
      return res.status(409).json({ code: 'maintenance_workflow_action_required' })
    }
    const rawSourceId = String(payload.source_id || '').trim()
    const sourceId = rawSourceId || uuid()
    const id = `${sourceType}:${sourceId}`
    const now = new Date().toISOString()
    const assigneeId = payload.assignee_id === undefined ? null : (normId(payload.assignee_id) || null)
    const requestedStatus = payload.status === undefined ? undefined : normStatus(payload.status)
    if (requestedStatus === 'done' || requestedStatus === 'cancelled') {
      return res.status(400).json({ code: 'terminal_status_not_allowed_on_create', message: 'terminal_status_not_allowed_on_create' })
    }
    const status = requestedStatus === undefined || requestedStatus === 'todo' || requestedStatus === 'assigned'
      ? autoStatusForWorkAssignee(assigneeId)
      : requestedStatus
    const urgency = normUrgency(payload.urgency)
    const scheduledDate = payload.scheduled_date === undefined ? null : (payload.scheduled_date ? dayOnly(payload.scheduled_date) : null)
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
    const client = await pgPool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO work_tasks(
          id, task_kind, source_type, source_id, property_id, title, summary,
          scheduled_date, start_time, end_time, assignee_id, status, urgency,
          created_by, updated_by, created_at, updated_at
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8::date,$9,$10,$11,$12,$13,$14,$15,$16,$17::timestamptz,$18::timestamptz)`,
        [
          row.id, row.task_kind, row.source_type, row.source_id, row.property_id, row.title, row.summary,
          row.scheduled_date, row.start_time, row.end_time, row.assignee_id, row.status, row.urgency,
          row.created_by, row.updated_by, row.created_at, row.updated_at,
        ],
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
      }, client)
      await client.query('COMMIT')
    } catch (error) {
      try { await client.query('ROLLBACK') } catch {}
      throw error
    } finally {
      client.release()
    }
    return res.status(201).json(row)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'create_failed' })
  }
})

router.patch('/:id', requirePerm('cleaning.schedule.manage'), requireR5TaskRuntimeSchema, async (req, res) => {
  const id = String((req.params as any)?.id || '').trim()
  if (!id) return res.status(400).json({ message: 'missing id' })
  const parsed = patchSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    const user = (req as any).user || {}
    const patch = parsed.data as any
    if (patch.status !== undefined && normStatus(patch.status) === 'cancelled' && !String(patch.completion_reason || '').trim()) {
      return res.status(400).json({ code: 'cancellation_reason_required', message: 'cancellation_reason_required' })
    }
    const r0 = await pgPool.query('SELECT * FROM work_tasks WHERE id=$1 LIMIT 1', [id])
    const cur = r0?.rows?.[0] || null
    if (!cur) return res.status(404).json({ message: 'task not found' })
    if (['property_maintenance', 'external_maintenance_orders'].includes(String(cur.source_type || '').trim())) {
      return res.status(409).json({ code: 'maintenance_workflow_action_required' })
    }
    if (['done', 'cancelled'].includes(normStatus(cur.status))) {
      return res.status(409).json({ code: 'work_record_read_only', message: 'work_record_read_only' })
    }
    if (patch.assignee_id !== undefined) {
      const beforeStatus = normStatus(cur.status)
      const incomingStatus = patch.status === undefined ? undefined : normStatus(patch.status)
      const statusAutoEligible = beforeStatus === 'todo' || beforeStatus === 'assigned'
      const incomingStatusEligible = incomingStatus === undefined || incomingStatus === 'todo' || incomingStatus === 'assigned'
      if (statusAutoEligible && incomingStatusEligible) {
        patch.status = autoStatusForWorkAssignee(normId(patch.assignee_id) || null)
      }
    }
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
    if (patch.completion_reason !== undefined) add('completion_reason', patch.completion_reason ? String(patch.completion_reason).trim() : null)
    add('updated_by', String(user.username || user.sub || ''))
    set.push(`updated_at = now()`)
    vals.push(id)
    const sql = `UPDATE work_tasks
      SET ${set.join(', ')}
      WHERE id=$${vals.length}
        AND lower(COALESCE(status, '')) NOT IN ('done', 'completed', 'cancelled', 'canceled', 'closed')
      RETURNING *`
    const client = await pgPool.connect()
    let row: any = cur
    let changedFields: string[] = []
    let assigneeChanged = false
    let completedChanged = false
    let cancelledChanged = false
    let recordAt: string | null = null
    let workRecordDate: string | null = null
    try {
      await client.query('BEGIN')
      const r1 = await client.query(sql, vals)
      row = r1?.rows?.[0] || null
      if (!row) {
        await client.query('ROLLBACK')
        return res.status(409).json({ code: 'work_record_read_only', message: 'work_record_read_only' })
      }
      changedFields = Object.keys(patch || {}).filter((key) => patch[key] !== undefined)
      assigneeChanged = patch.assignee_id !== undefined && String(cur.assignee_id || '') !== String(row.assignee_id || '')
      completedChanged = normStatus(cur.status) !== 'done' && normStatus(row.status) === 'done'
      cancelledChanged = normStatus(cur.status) !== 'cancelled' && normStatus(row.status) === 'cancelled'
      recordAt = completedChanged || cancelledChanged ? String(row.updated_at || new Date().toISOString()) : null
      workRecordDate = recordAt ? melbourneDateOnly(recordAt) : null
      await propagateToSource(sourceType, sourceId, patch, client)
      const visibilityHints = buildWorkTaskVisibilityHints(row)
      visibilityHints.user_ids = Array.from(new Set([
        ...(Array.isArray(visibilityHints.user_ids) ? visibilityHints.user_ids : []),
        String(cur.assignee_id || '').trim(),
        String(row.assignee_id || '').trim(),
      ].filter(Boolean)))
      const workRecordPatch = completedChanged || cancelledChanged
        ? {
            completed_at: recordAt,
            ...(completedChanged
              ? { completed_by_user_id: String(user.sub || user.username || '').trim() || null }
              : {}),
            work_record_visible: true,
            work_record_state: completedChanged ? 'completed' : 'cancelled',
            work_record_date: workRecordDate,
            original_scheduled_date: row.scheduled_date ? String(row.scheduled_date).slice(0, 10) : null,
            work_record_read_only: true,
            counts_as_active_task: false,
            completion_reason: cancelledChanged ? String(row.completion_reason || '').trim() || null : null,
          }
        : {}
      const eventChangedFields = Array.from(new Set([
        ...changedFields,
        ...Object.keys(workRecordPatch),
      ]))
      await emitWorkTaskEvent({
        taskId: `work_task:${row.id}`,
        sourceType: 'work_tasks',
        sourceRefIds: [String(row.id)],
        eventType: completedChanged ? 'TASK_COMPLETED' : cancelledChanged ? 'TASK_REMOVED' : assigneeChanged ? 'TASK_ASSIGNMENT_CHANGED' : 'TASK_UPDATED',
        changeScope: assigneeChanged || cancelledChanged ? 'membership' : 'list',
        changedFields: eventChangedFields,
        patch: {
          ...Object.fromEntries(changedFields.map((field) => [field, (row as any)[field]])),
          ...workRecordPatch,
        },
        payload: {
          execution_evidence: {
            kind: completedChanged ? 'manager_completion' : cancelledChanged ? 'manager_cancellation' : 'manager_task_update',
            is_execution: false,
            actor_user_id: String(user.sub || user.username || '').trim() || null,
          },
        },
        occurredAt: recordAt || undefined,
        causedByUserId: String(user.sub || user.username || '').trim() || null,
        visibilityHints,
      }, client)
      await client.query('COMMIT')
    } catch (error) {
      try { await client.query('ROLLBACK') } catch {}
      throw error
    } finally {
      client.release()
    }
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
              policyKey: 'work_task_updated',
              entity: 'work_task',
              entityId: String(row.id),
              propertyId,
              updatedAt: String(row.updated_at || '').trim() || new Date().toISOString(),
              title: '任务安排已更新',
              body: [
                `任务：${String(row.title || '线下任务')}`,
                row.summary ? `内容：${String(row.summary || '')}` : '',
                row.scheduled_date ? `日期：${String(row.scheduled_date).slice(0, 10)}` : '',
              ].filter(Boolean).join('\n'),
              data: {
                entity: 'work_task',
                entityId: String(row.id),
                action: 'open_work_task',
                kind: 'work_task_updated',
                task_id: String(row.id),
                task_title: String(row.title || ''),
                task_summary: row.summary == null ? null : String(row.summary || ''),
                task_date: row.scheduled_date ? String(row.scheduled_date).slice(0, 10) : null,
                assignee_id: row.assignee_id || null,
                status: row.status,
                urgency: row.urgency,
              },
              actorUserId: actorId,
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
              policyKey: 'work_task_completed',
              entity: 'work_task',
              entityId: String(row.id),
              propertyId: propertyId || undefined,
              updatedAt: String(row.updated_at || '').trim() || new Date().toISOString(),
              title: taskCompletedTitle(row.title),
              body: taskCompletedBody(row.title),
              data: {
                entity: 'work_task',
                entityId: String(row.id),
                action: 'open_work_task',
                kind: 'work_task_completed',
                task_id: String(row.id),
                task_title: String(row.title || ''),
                task_summary: row.summary == null ? null : String(row.summary || ''),
                task_date: row.scheduled_date ? String(row.scheduled_date).slice(0, 10) : null,
                assignee_id: row.assignee_id || null,
                status: row.status,
                urgency: row.urgency,
              },
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
      urgency: String(row.task_kind || '').toLowerCase() === 'offline' ? null : normUrgency(row.urgency),
      ...(completedChanged || cancelledChanged
        ? {
            completed_at: recordAt,
            ...(completedChanged
              ? { completed_by_user_id: String(user.sub || user.username || '').trim() || null }
              : {}),
            work_record_visible: true,
            work_record_state: completedChanged ? 'completed' : 'cancelled',
            work_record_date: workRecordDate,
            original_scheduled_date: row.scheduled_date ? String(row.scheduled_date).slice(0, 10) : null,
            work_record_read_only: true,
            counts_as_active_task: false,
            completion_reason: cancelledChanged ? String(row.completion_reason || '').trim() || null : null,
          }
        : {}),
    })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'update_failed' })
  }
})

router.post('/upsert-from-source', requirePerm('cleaning.schedule.manage'), requireR5TaskRuntimeSchema, async (req, res) => {
  const parsed = upsertFromSourceSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const sourceType = parsed.data.source_type
  const sourceId = parsed.data.source_id
  const rawPatch = parsed.data.patch as any
  const patch: Record<string, any> = {}
  if (rawPatch.task_kind !== undefined) patch.task_kind = String(rawPatch.task_kind || '').trim()
  if (rawPatch.property_id !== undefined) patch.property_id = rawPatch.property_id ?? null
  if (rawPatch.title !== undefined) patch.title = String(rawPatch.title || '').trim()
  if (rawPatch.summary !== undefined) patch.summary = rawPatch.summary ?? null
  if (rawPatch.scheduled_date !== undefined) patch.scheduled_date = rawPatch.scheduled_date ? dayOnly(rawPatch.scheduled_date) : null
  if (rawPatch.start_time !== undefined) patch.start_time = rawPatch.start_time ?? null
  if (rawPatch.end_time !== undefined) patch.end_time = rawPatch.end_time ?? null
  if (rawPatch.assignee_id !== undefined) patch.assignee_id = normId(rawPatch.assignee_id) || null
  if (rawPatch.status !== undefined) patch.status = normStatus(rawPatch.status)
  if (rawPatch.urgency !== undefined) patch.urgency = normUrgency(rawPatch.urgency)
  if (patch.status === 'done' || patch.status === 'cancelled') {
    return res.status(400).json({ code: 'terminal_status_requires_transition', message: 'terminal_status_requires_transition' })
  }
  try {
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    if (['property_maintenance', 'external_maintenance_orders'].includes(sourceType)) {
      return res.status(409).json({ code: 'maintenance_workflow_action_required' })
    }
    const user = (req as any).user || {}
    const client = await pgPool.connect()
    try {
      await client.query('BEGIN')
      const currentResult = await client.query(
        `SELECT * FROM work_tasks WHERE source_type=$1 AND source_id=$2 LIMIT 1 FOR UPDATE`,
        [sourceType, sourceId],
      )
      const current = currentResult?.rows?.[0] || null
      if (current && ['done', 'cancelled'].includes(normStatus(current.status))) {
        await client.query('ROLLBACK')
        return res.status(409).json({ code: 'work_record_read_only', message: 'work_record_read_only' })
      }
      const row = await upsertWorkTaskFromSource(sourceType, sourceId, patch, client)
      if (!row) {
        await client.query('ROLLBACK')
        return res.status(409).json({ code: 'work_record_read_only', message: 'work_record_read_only' })
      }
      const changedFields = Object.keys(patch)
      const assignmentChanged = current && changedFields.includes('assignee_id')
        && normId(current.assignee_id) !== normId(row.assignee_id)
      const visibilityHints = buildWorkTaskVisibilityHints(row)
      visibilityHints.user_ids = Array.from(new Set([
        ...(Array.isArray(visibilityHints.user_ids) ? visibilityHints.user_ids : []),
        String(current?.assignee_id || '').trim(),
        String(row.assignee_id || '').trim(),
      ].filter(Boolean)))
      await emitWorkTaskEvent({
        taskId: `work_task:${row.id}`,
        sourceType: 'work_tasks',
        sourceRefIds: [String(row.id), sourceId],
        eventType: current ? (assignmentChanged ? 'TASK_ASSIGNMENT_CHANGED' : 'TASK_UPDATED') : 'TASK_CREATED',
        changeScope: !current || assignmentChanged || changedFields.includes('scheduled_date') ? 'membership' : 'list',
        changedFields,
        patch,
        causedByUserId: String(user.sub || user.username || '').trim() || null,
        visibilityHints,
      }, client)
      await client.query('COMMIT')
      return res.json({ ok: true, task_id: String(row.id) })
    } catch (error) {
      try { await client.query('ROLLBACK') } catch {}
      throw error
    } finally {
      client.release()
    }
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'upsert_failed' })
  }
})
