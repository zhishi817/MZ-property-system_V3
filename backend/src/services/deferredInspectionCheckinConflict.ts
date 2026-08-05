import { hasPg, pgPool } from '../dbAdapter'
import { buildCleaningTaskVisibilityHints, emitWorkTaskEvent } from './workTaskEvents'
import { emitNotificationEvent } from './notificationEvents'

const TERMINAL_DEFERRED_INSPECTION_STATUSES = new Set([
  'inspected',
  'done',
  'completed',
  'ready',
  'keys_hung',
  'cancelled',
  'canceled',
])

export type DeferredInspectionCheckinConflictInput = {
  id?: string | null
  property_id?: string | null
  task_type?: string | null
  type?: string | null
  task_date?: string | null
  date?: string | null
  status?: string | null
  execution_state?: string | null
  inspection_mode?: string | null
  inspection_scope?: string | null
  inspection_due_date?: string | null
  inspection_replaced_by_checkin_task_id?: string | null
  inspection_replaced_original_due_date?: string | null
  order_id?: string | null
  order_status?: string | null
  checkin_time?: string | null
}

export type DeferredInspectionCheckinConflict = {
  deferred_task_id: string
  checkin_task_id: string
  property_id: string
  inspection_due_date: string
  checkin_task_date: string
  checkin_time: string | null
}

export type DeferredInspectionCheckinReplacement = DeferredInspectionCheckinConflict & {
  deferred_task_date: string
}

export type DeferredInspectionCheckinReplacementResult = {
  ok: true
  auto_completed: number
  restored: number
  relinked: number
  changed_task_ids: string[]
}

function text(value: any) {
  return String(value || '').trim()
}

function lower(value: any) {
  return text(value).toLowerCase()
}

function dayOnly(value: any): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(text(value))
  return match ? match[1] : null
}

function taskType(task: DeferredInspectionCheckinConflictInput) {
  return lower(task.task_type || task.type)
}

function taskDay(task: DeferredInspectionCheckinConflictInput) {
  return dayOnly(task.task_date || task.date)
}

function activeExecutionState(value: any) {
  const state = lower(value)
  return !state || state === 'active'
}

function hasActiveOrder(task: DeferredInspectionCheckinConflictInput) {
  if (!text(task.order_id)) return true
  const status = lower(task.order_status)
  return !!status && status !== 'invalid' && !status.includes('cancel')
}

function isOpenDeferredInspection(task: DeferredInspectionCheckinConflictInput) {
  const dueDate = dayOnly(task.inspection_due_date)
  return (
    lower(task.inspection_mode) === 'deferred'
    && !!dueDate
    && activeExecutionState(task.execution_state)
    && !TERMINAL_DEFERRED_INSPECTION_STATUSES.has(lower(task.status))
  )
}

function isActiveCheckin(task: DeferredInspectionCheckinConflictInput) {
  const status = lower(task.status)
  return (
    taskType(task) === 'checkin_clean'
    && !!taskDay(task)
    && activeExecutionState(task.execution_state)
    && status !== 'cancelled'
    && status !== 'canceled'
    && hasActiveOrder(task)
  )
}

function isInspectionBearingCheckin(task: DeferredInspectionCheckinConflictInput) {
  return isActiveCheckin(task) && lower(task.inspection_scope) !== 'password_only'
}

function isWithinDeferredReplacementWindow(
  deferred: DeferredInspectionCheckinConflictInput,
  checkin: DeferredInspectionCheckinConflictInput,
) {
  const deferredDay = taskDay(deferred)
  const dueDay = dayOnly(deferred.inspection_due_date)
  const checkinDay = taskDay(checkin)
  return !!deferredDay && !!dueDay && !!checkinDay && deferredDay <= checkinDay && checkinDay <= dueDay
}

function compareCheckins(left: DeferredInspectionCheckinConflictInput, right: DeferredInspectionCheckinConflictInput) {
  const leftDay = taskDay(left) || ''
  const rightDay = taskDay(right) || ''
  if (leftDay !== rightDay) return leftDay.localeCompare(rightDay)
  const timeOrder = text(left.checkin_time).localeCompare(text(right.checkin_time))
  if (timeOrder) return timeOrder
  return text(left.id).localeCompare(text(right.id))
}

function compareDeferredForReplacement(left: DeferredInspectionCheckinConflictInput, right: DeferredInspectionCheckinConflictInput) {
  const leftDay = taskDay(left) || ''
  const rightDay = taskDay(right) || ''
  if (leftDay !== rightDay) return rightDay.localeCompare(leftDay)
  const leftDue = dayOnly(left.inspection_due_date) || ''
  const rightDue = dayOnly(right.inspection_due_date) || ''
  if (leftDue !== rightDue) return leftDue.localeCompare(rightDue)
  return text(left.id).localeCompare(text(right.id))
}

/**
 * Returns one deterministic replacement per incoming inspection-bearing check-in.
 * A check-in may only replace the most recent matching deferred inspection, so
 * duplicate historical rows are not silently completed together.
 */
export function findDeferredInspectionCheckinReplacements(rows: DeferredInspectionCheckinConflictInput[]): DeferredInspectionCheckinReplacement[] {
  const deferredTasks = (rows || []).filter(isOpenDeferredInspection)
  const checkins = (rows || []).filter(isInspectionBearingCheckin).sort(compareCheckins)
  const claimedDeferredTaskIds = new Set<string>()
  const replacements: DeferredInspectionCheckinReplacement[] = []

  for (const checkin of checkins) {
    const checkinTaskId = text(checkin.id)
    const propertyId = text(checkin.property_id)
    const checkinTaskDate = taskDay(checkin)
    if (!checkinTaskId || !propertyId || !checkinTaskDate) continue

    const deferred = deferredTasks
      .filter((candidate) => {
        const candidateId = text(candidate.id)
        return !!candidateId
          && !claimedDeferredTaskIds.has(candidateId)
          && text(candidate.property_id) === propertyId
          && isWithinDeferredReplacementWindow(candidate, checkin)
      })
      .sort(compareDeferredForReplacement)[0]
    if (!deferred) continue

    const deferredTaskId = text(deferred.id)
    const inspectionDueDate = dayOnly(deferred.inspection_due_date)
    const deferredTaskDate = taskDay(deferred)
    if (!deferredTaskId || !inspectionDueDate || !deferredTaskDate) continue
    claimedDeferredTaskIds.add(deferredTaskId)
    replacements.push({
      deferred_task_id: deferredTaskId,
      checkin_task_id: checkinTaskId,
      property_id: propertyId,
      inspection_due_date: inspectionDueDate,
      deferred_task_date: deferredTaskDate,
      checkin_task_date: checkinTaskDate,
      checkin_time: text(checkin.checkin_time) || null,
    })
  }

  return replacements
}

/**
 * Finds remaining occupancy risks without changing either task. Same-day check-ins
 * are included; a check-in before the underlying checkout day is not a conflict.
 */
export function findDeferredInspectionCheckinConflicts(rows: DeferredInspectionCheckinConflictInput[]): DeferredInspectionCheckinConflict[] {
  const deferredTasks = (rows || []).filter(isOpenDeferredInspection)
  const checkins = (rows || []).filter(isActiveCheckin)
  const conflicts: DeferredInspectionCheckinConflict[] = []

  for (const deferred of deferredTasks) {
    const deferredTaskId = text(deferred.id)
    const propertyId = text(deferred.property_id)
    const inspectionDueDate = dayOnly(deferred.inspection_due_date)
    if (!deferredTaskId || !propertyId || !inspectionDueDate) continue

    const matchingCheckins = checkins
      .filter((checkin) => {
        const checkinTaskId = text(checkin.id)
        return !!checkinTaskId
          && checkinTaskId !== deferredTaskId
          && text(checkin.property_id) === propertyId
          && isWithinDeferredReplacementWindow(deferred, checkin)
      })
      .sort(compareCheckins)

    for (const checkin of matchingCheckins) {
      conflicts.push({
        deferred_task_id: deferredTaskId,
        checkin_task_id: text(checkin.id),
        property_id: propertyId,
        inspection_due_date: inspectionDueDate,
        checkin_task_date: taskDay(checkin) || '',
        checkin_time: text(checkin.checkin_time) || null,
      })
    }
  }

  return conflicts
}

export function deferredInspectionCheckinConflictEventId(conflict: DeferredInspectionCheckinConflict) {
  return [
    'DEFERRED_INSPECTION_CHECKIN_CONFLICT',
    conflict.deferred_task_id,
    conflict.checkin_task_id,
    conflict.inspection_due_date,
    conflict.checkin_task_date,
    conflict.checkin_time || '-',
  ].join(':')
}

export function isDeferredInspectionCheckinConflictRelevantChange(fields: string[]) {
  const relevant = new Set([
    'property_id',
    'task_type',
    'type',
    'task_date',
    'date',
    'status',
    'execution_state',
    'inspection_mode',
    'inspection_scope',
    'inspection_due_date',
    'checkin_time',
    'order_id',
  ])
  return (fields || []).some((field) => relevant.has(text(field)))
}

function replacementSourceTaskId(task: DeferredInspectionCheckinConflictInput) {
  return text(task.inspection_replaced_by_checkin_task_id)
}

function isAutomaticallyReplacedDeferredInspection(task: DeferredInspectionCheckinConflictInput) {
  return lower(task.inspection_mode) === 'checked_done'
    && !!replacementSourceTaskId(task)
    && !!dayOnly(task.inspection_replaced_original_due_date)
}

function replacementWindowForStoredTask(deferred: DeferredInspectionCheckinConflictInput, checkin: DeferredInspectionCheckinConflictInput) {
  if (!isInspectionBearingCheckin(checkin)) return false
  if (text(deferred.property_id) !== text(checkin.property_id)) return false
  if (!dayOnly(deferred.inspection_replaced_original_due_date)) return false
  return isWithinDeferredReplacementWindow({
    ...deferred,
    inspection_due_date: deferred.inspection_replaced_original_due_date,
  }, checkin)
}

function replacementCandidatesForStoredTask(rows: DeferredInspectionCheckinConflictInput[], deferred: DeferredInspectionCheckinConflictInput) {
  return rows
    .filter((candidate) => replacementWindowForStoredTask(deferred, candidate))
    .sort(compareCheckins)
}

async function loadReconciliationRows(params: {
  taskIds: string[]
  checkinOrderId: string
  client: any
}) {
  const triggerScopes: string[] = []
  const triggerValues: any[] = []
  if (params.taskIds.length) {
    triggerValues.push(params.taskIds)
    triggerScopes.push(`t.id::text = ANY($${triggerValues.length}::text[])`)
  }
  if (params.checkinOrderId) {
    triggerValues.push(params.checkinOrderId)
    triggerScopes.push(`t.order_id::text = $${triggerValues.length}::text`)
  }
  if (!triggerScopes.length) return [] as DeferredInspectionCheckinConflictInput[]

  const triggerResult = await params.client.query(
    `SELECT
       t.id::text AS id,
       t.property_id::text AS property_id,
       COALESCE(p_id.id::text, p_code.id::text, t.property_id::text) AS canonical_property_id
     FROM cleaning_tasks t
     LEFT JOIN properties p_id ON p_id.id::text = t.property_id::text
     LEFT JOIN properties p_code ON upper(p_code.code) = upper(t.property_id::text)
     WHERE (${triggerScopes.join(' OR ')})`,
    triggerValues,
  )
  const triggerIds = Array.from(new Set((triggerResult?.rows || []).map((row: any) => text(row.id)).filter(Boolean)))
  const propertyIds = Array.from(new Set((triggerResult?.rows || []).map((row: any) => text(row.canonical_property_id)).filter(Boolean)))

  const replacementResult = triggerIds.length
    ? await params.client.query(
      `SELECT
         t.id::text AS id,
         COALESCE(p_id.id::text, p_code.id::text, t.property_id::text) AS canonical_property_id
       FROM cleaning_tasks t
       LEFT JOIN properties p_id ON p_id.id::text = t.property_id::text
       LEFT JOIN properties p_code ON upper(p_code.code) = upper(t.property_id::text)
       WHERE t.inspection_replaced_by_checkin_task_id::text = ANY($1::text[])`,
      [triggerIds],
    )
    : { rows: [] }
  const restoredTaskIds = Array.from(new Set((replacementResult?.rows || []).map((row: any) => text(row.id)).filter(Boolean)))
  for (const row of replacementResult?.rows || []) {
    const propertyId = text(row.canonical_property_id)
    if (propertyId && !propertyIds.includes(propertyId)) propertyIds.push(propertyId)
  }
  if (!propertyIds.length && !restoredTaskIds.length) return [] as DeferredInspectionCheckinConflictInput[]

  const scopes: string[] = []
  const values: any[] = []
  if (propertyIds.length) {
    values.push(propertyIds)
    const index = values.length
    scopes.push(`COALESCE(p_id.id::text, p_code.id::text, t.property_id::text) = ANY($${index}::text[])`)
  }
  if (restoredTaskIds.length) {
    values.push(restoredTaskIds)
    scopes.push(`t.id::text = ANY($${values.length}::text[])`)
  }
  const result = await params.client.query(
    `SELECT
       t.id::text AS id,
       COALESCE(p_id.id::text, p_code.id::text, t.property_id::text) AS property_id,
       COALESCE(t.task_type, t.type, '') AS task_type,
       t.type,
       COALESCE(t.task_date, t.date)::text AS task_date,
       t.status,
       t.execution_state,
       t.inspection_mode,
       t.inspection_scope,
       t.inspection_due_date::text AS inspection_due_date,
       t.inspection_replaced_by_checkin_task_id::text AS inspection_replaced_by_checkin_task_id,
       t.inspection_replaced_original_due_date::text AS inspection_replaced_original_due_date,
       t.order_id::text AS order_id,
       o.status::text AS order_status,
       t.checkin_time
     FROM cleaning_tasks t
     LEFT JOIN properties p_id ON p_id.id::text = t.property_id::text
     LEFT JOIN properties p_code ON upper(p_code.code) = upper(t.property_id::text)
     LEFT JOIN orders o ON o.id::text = t.order_id::text
     WHERE ${scopes.join(' OR ')}`,
    values,
  )
  return result?.rows || []
}

async function emitReplacementWorkTaskEvent(params: {
  action: 'auto_completed' | 'restored' | 'relinked'
  before: any
  after: any
  checkinTaskId: string | null
  actorUserId?: string | null
  client: any
}) {
  const changedFields = [
    'inspection_mode',
    'inspection_due_date',
    'inspection_replaced_by_checkin_task_id',
    'inspection_replaced_original_due_date',
  ]
  await emitWorkTaskEvent({
    taskId: `cleaning_task:${String(params.after.id)}`,
    sourceType: 'cleaning_tasks',
    sourceRefIds: [String(params.after.id), ...(params.checkinTaskId ? [params.checkinTaskId] : [])],
    eventType: 'TASK_UPDATED',
    changeScope: 'list',
    changedFields,
    patch: {
      inspection_mode: params.after.inspection_mode,
      inspection_due_date: params.after.inspection_due_date,
      inspection_replaced_by_checkin_task_id: params.after.inspection_replaced_by_checkin_task_id,
      inspection_replaced_original_due_date: params.after.inspection_replaced_original_due_date,
      inspection_replacement_action: params.action,
    },
    causedByUserId: params.actorUserId || null,
    visibilityHints: buildCleaningTaskVisibilityHints(params.after),
  }, params.client)
}

async function updateAutomaticallyReplacedDeferredInspection(params: {
  action: 'auto_completed' | 'restored' | 'relinked'
  deferredTaskId: string
  previousCheckinTaskId?: string | null
  nextCheckinTaskId?: string | null
  originalDueDate: string
  actorUserId?: string | null
  client: any
}) {
  let result: any
  if (params.action === 'auto_completed') {
    result = await params.client.query(
      `UPDATE cleaning_tasks
       SET inspection_mode='checked_done',
           inspection_due_date=NULL,
           inspection_replaced_by_checkin_task_id=$2,
           inspection_replaced_original_due_date=$3::date,
           updated_at=now()
       WHERE id::text=$1::text
         AND lower(COALESCE(inspection_mode, ''))='deferred'
         AND inspection_due_date=$3::date
       RETURNING *`,
      [params.deferredTaskId, params.nextCheckinTaskId, params.originalDueDate],
    )
  } else if (params.action === 'relinked') {
    result = await params.client.query(
      `UPDATE cleaning_tasks
       SET inspection_replaced_by_checkin_task_id=$3,
           updated_at=now()
       WHERE id::text=$1::text
         AND lower(COALESCE(inspection_mode, ''))='checked_done'
         AND inspection_replaced_by_checkin_task_id::text=$2::text
         AND inspection_replaced_original_due_date=$4::date
       RETURNING *`,
      [params.deferredTaskId, params.previousCheckinTaskId, params.nextCheckinTaskId, params.originalDueDate],
    )
  } else {
    result = await params.client.query(
      `UPDATE cleaning_tasks
       SET inspection_mode='deferred',
           inspection_due_date=$3::date,
           inspection_replaced_by_checkin_task_id=NULL,
           inspection_replaced_original_due_date=NULL,
           updated_at=now()
       WHERE id::text=$1::text
         AND lower(COALESCE(inspection_mode, ''))='checked_done'
         AND inspection_replaced_by_checkin_task_id::text=$2::text
         AND inspection_replaced_original_due_date=$3::date
       RETURNING *`,
      [params.deferredTaskId, params.previousCheckinTaskId, params.originalDueDate],
    )
  }
  return result?.rows?.[0] || null
}

/**
 * Completes a deferred inspection only when a same-property check-in inspection
 * falls from the checkout day through the deferred due day. It also restores the
 * original deferred inspection if that replacing check-in later becomes invalid.
 */
export async function reconcileDeferredInspectionCheckinReplacement(params: {
  taskIds?: string[]
  checkinOrderId?: string | null
  actorUserId?: string | null
  pgClient?: any
}): Promise<DeferredInspectionCheckinReplacementResult> {
  if (!hasPg || !pgPool) return { ok: true, auto_completed: 0, restored: 0, relinked: 0, changed_task_ids: [] }
  const taskIds = Array.from(new Set((params.taskIds || []).map(text).filter(Boolean)))
  const checkinOrderId = text(params.checkinOrderId)
  if (!taskIds.length && !checkinOrderId) return { ok: true, auto_completed: 0, restored: 0, relinked: 0, changed_task_ids: [] }

  const ownClient = !params.pgClient ? await pgPool.connect() : null
  const client = params.pgClient || ownClient
  const result: DeferredInspectionCheckinReplacementResult = { ok: true, auto_completed: 0, restored: 0, relinked: 0, changed_task_ids: [] }
  try {
    if (ownClient) await client.query('BEGIN')
    const rows = await loadReconciliationRows({ taskIds, checkinOrderId, client })
    const rowsById = new Map((rows || []).map((row: any) => [text(row.id), row]))

    for (const replacement of findDeferredInspectionCheckinReplacements(rows)) {
      const before = rowsById.get(replacement.deferred_task_id)
      if (!before) continue
      const after = await updateAutomaticallyReplacedDeferredInspection({
        action: 'auto_completed',
        deferredTaskId: replacement.deferred_task_id,
        nextCheckinTaskId: replacement.checkin_task_id,
        originalDueDate: replacement.inspection_due_date,
        actorUserId: params.actorUserId,
        client,
      })
      if (!after) continue
      await emitReplacementWorkTaskEvent({
        action: 'auto_completed',
        before,
        after,
        checkinTaskId: replacement.checkin_task_id,
        actorUserId: params.actorUserId,
        client,
      })
      result.auto_completed += 1
      result.changed_task_ids.push(String(after.id))
    }

    for (const deferred of rows.filter(isAutomaticallyReplacedDeferredInspection)) {
      const deferredTaskId = text(deferred.id)
      const originalDueDate = dayOnly(deferred.inspection_replaced_original_due_date)
      const sourceCheckinTaskId = replacementSourceTaskId(deferred)
      if (!deferredTaskId || !originalDueDate || !sourceCheckinTaskId) continue
      const sourceCheckin = rowsById.get(sourceCheckinTaskId)
      if (sourceCheckin && replacementWindowForStoredTask(deferred, sourceCheckin)) continue

      const alternative = replacementCandidatesForStoredTask(rows, deferred)
        .find((candidate) => text(candidate.id) !== sourceCheckinTaskId)
      const action = alternative ? 'relinked' as const : 'restored' as const
      const after = await updateAutomaticallyReplacedDeferredInspection({
        action,
        deferredTaskId,
        previousCheckinTaskId: sourceCheckinTaskId,
        nextCheckinTaskId: alternative ? text(alternative.id) : null,
        originalDueDate,
        actorUserId: params.actorUserId,
        client,
      })
      if (!after) continue
      await emitReplacementWorkTaskEvent({
        action,
        before: deferred,
        after,
        checkinTaskId: alternative ? text(alternative.id) : null,
        actorUserId: params.actorUserId,
        client,
      })
      if (action === 'relinked') result.relinked += 1
      else result.restored += 1
      result.changed_task_ids.push(String(after.id))
    }

    if (ownClient) await client.query('COMMIT')
    result.changed_task_ids = Array.from(new Set(result.changed_task_ids))
    return result
  } catch (error) {
    if (ownClient) {
      try { await client.query('ROLLBACK') } catch {}
    }
    throw error
  } finally {
    if (ownClient) ownClient.release()
  }
}

export async function emitDeferredInspectionCheckinConflictAlerts(params: {
  taskIds?: string[]
  checkinOrderId?: string | null
  actorUserId?: string | null
  pgClient?: any
}) {
  if (!hasPg || !pgPool) return { ok: true, conflicts: 0, sent: 0 }
  const client = params.pgClient || pgPool
  const taskIds = Array.from(new Set((params.taskIds || []).map(text).filter(Boolean)))
  const checkinOrderId = text(params.checkinOrderId)
  if (!taskIds.length && !checkinOrderId) return { ok: true, conflicts: 0, sent: 0 }

  const scopeClauses: string[] = []
  const values: any[] = []
  if (taskIds.length) {
    values.push(taskIds)
    const index = values.length
    scopeClauses.push(`deferred.id::text = ANY($${index}::text[]) OR checkin.id::text = ANY($${index}::text[])`)
  }
  if (checkinOrderId) {
    values.push(checkinOrderId)
    scopeClauses.push(`checkin.order_id::text = $${values.length}::text`)
  }

  const result = await client.query(
    `SELECT
       deferred.id::text AS deferred_task_id,
       checkin.id::text AS checkin_task_id,
       COALESCE(deferred_property_by_id.id::text, deferred_property_by_code.id::text, deferred.property_id::text) AS property_id,
       COALESCE(deferred_property_by_id.code::text, deferred_property_by_code.code::text, deferred.property_id::text) AS property_code,
       deferred.inspection_due_date::text AS inspection_due_date,
       COALESCE(checkin.task_date, checkin.date)::text AS checkin_task_date,
       NULLIF(TRIM(checkin.checkin_time), '') AS checkin_time,
       GREATEST(COALESCE(deferred.updated_at, now()), COALESCE(checkin.updated_at, now()))::text AS updated_at
     FROM cleaning_tasks deferred
     JOIN cleaning_tasks checkin
       ON checkin.id::text <> deferred.id::text
      AND lower(COALESCE(checkin.task_type, checkin.type, '')) = 'checkin_clean'
      AND COALESCE(checkin.task_date, checkin.date)::date >= COALESCE(deferred.task_date, deferred.date)::date
      AND COALESCE(checkin.task_date, checkin.date)::date <= deferred.inspection_due_date::date
      AND COALESCE(checkin.execution_state, CASE WHEN lower(COALESCE(checkin.status, '')) IN ('cancelled', 'canceled') THEN 'cancelled' ELSE 'active' END) = 'active'
      AND lower(COALESCE(checkin.status, '')) NOT IN ('cancelled', 'canceled')
     LEFT JOIN properties deferred_property_by_id ON deferred_property_by_id.id::text = deferred.property_id::text
     LEFT JOIN properties deferred_property_by_code ON upper(deferred_property_by_code.code) = upper(deferred.property_id::text)
     LEFT JOIN properties checkin_property_by_id ON checkin_property_by_id.id::text = checkin.property_id::text
     LEFT JOIN properties checkin_property_by_code ON upper(checkin_property_by_code.code) = upper(checkin.property_id::text)
     LEFT JOIN orders checkin_order ON checkin_order.id::text = checkin.order_id::text
     WHERE lower(COALESCE(deferred.inspection_mode, '')) = 'deferred'
       AND deferred.inspection_due_date IS NOT NULL
       AND COALESCE(deferred.execution_state, CASE WHEN lower(COALESCE(deferred.status, '')) IN ('cancelled', 'canceled') THEN 'cancelled' ELSE 'active' END) = 'active'
       AND lower(COALESCE(deferred.status, '')) NOT IN ('inspected', 'done', 'completed', 'ready', 'keys_hung', 'cancelled', 'canceled')
       AND COALESCE(deferred_property_by_id.id::text, deferred_property_by_code.id::text, deferred.property_id::text)
           = COALESCE(checkin_property_by_id.id::text, checkin_property_by_code.id::text, checkin.property_id::text)
       AND (checkin.order_id IS NULL OR (
         checkin_order.id IS NOT NULL
         AND COALESCE(checkin_order.status, '') <> ''
         AND lower(COALESCE(checkin_order.status, '')) <> 'invalid'
         AND lower(COALESCE(checkin_order.status, '')) NOT LIKE '%cancel%'
       ))
       AND (${scopeClauses.join(' OR ')})
     ORDER BY deferred.inspection_due_date ASC, COALESCE(checkin.task_date, checkin.date) ASC, checkin.id`,
    values,
  )

  let sent = 0
  for (const row of result?.rows || []) {
    const conflict: DeferredInspectionCheckinConflict = {
      deferred_task_id: text(row.deferred_task_id),
      checkin_task_id: text(row.checkin_task_id),
      property_id: text(row.property_id),
      inspection_due_date: dayOnly(row.inspection_due_date) || '',
      checkin_task_date: dayOnly(row.checkin_task_date) || '',
      checkin_time: text(row.checkin_time) || null,
    }
    if (!conflict.deferred_task_id || !conflict.checkin_task_id || !conflict.property_id || !conflict.inspection_due_date || !conflict.checkin_task_date) continue
    const propertyCode = text(row.property_code) || '房源'
    const notificationResult = await emitNotificationEvent(
      {
        type: 'CLEANING_TASK_UPDATED',
        policyKey: 'deferred_inspection_checkin_conflict',
        entity: 'cleaning_task',
        entityId: conflict.deferred_task_id,
        eventId: deferredInspectionCheckinConflictEventId(conflict),
        propertyId: conflict.property_id,
        updatedAt: text(row.updated_at) || new Date().toISOString(),
        changes: ['inspection', 'checkin_conflict'],
        title: `【入住冲突】${propertyCode} 延期检查需处理`,
        body: [
          `延期检查日期：${conflict.inspection_due_date}`,
          `入住日期：${conflict.checkin_task_date}${conflict.checkin_time ? ` ${conflict.checkin_time}` : ''}`,
          '延期检查尚未完成，请重新安排或确认已处理。',
        ].join('\n'),
        data: {
          entity: 'cleaning_task',
          entityId: conflict.deferred_task_id,
          action: 'open_notice',
          kind: 'deferred_inspection_checkin_conflict',
          task_id: conflict.deferred_task_id,
          task_ids: [conflict.deferred_task_id, conflict.checkin_task_id],
          deferred_task_id: conflict.deferred_task_id,
          checkin_task_id: conflict.checkin_task_id,
          inspection_due_date: conflict.inspection_due_date,
          checkin_task_date: conflict.checkin_task_date,
          checkin_time: conflict.checkin_time,
          property_code: propertyCode,
        },
        priority: 'high',
        actorUserId: params.actorUserId || null,
        excludeActor: false,
      },
      { pgClient: client },
    )
    sent += Number(notificationResult?.sent || 0)
  }
  return { ok: true, conflicts: Number(result?.rows?.length || 0), sent }
}
