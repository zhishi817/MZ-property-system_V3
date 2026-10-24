import { hasPg, pgPool } from '../dbAdapter'
import { isTerminalDeferredInspectionStatus } from '../lib/cleaningInspection'
import { buildCleaningTaskVisibilityHints, buildMz031CleaningArrangementRevision, emitWorkTaskEvent } from './workTaskEvents'
import { emitNotificationEvent } from './notificationEvents'

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
  linked_checkout_task_id?: string | null
  order_id?: string | null
  order_status?: string | null
  order_checkin?: string | null
  order_checkout?: string | null
  checkin_time?: string | null
  inspection_completed_at?: string | null
  inspector_id?: string | null
  assignee_id?: string | null
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

export type DeferredInspectionCheckinArrangement = {
  deferred_task_id: string
  checkin_task_id: string
  checkin_task_ids: string[]
  property_id: string
  original_checkout_date: string
  effective_inspection_date: string
  planned_inspector_id: string | null
  checkin_inspector_id: string | null
  checkin_assignee_id: string | null
  conflict_reasons: string[]
  display_merge_eligible: boolean
  display_merge_reasons: string[]
}

export type DeferredInspectionActionLike = {
  id?: unknown
  source_id?: unknown
  enabled?: boolean
  disabled_reason?: unknown
  [key: string]: unknown
}

export type DeferredInspectionConflictSourceLike = {
  deferred_task_id?: unknown
  checkin_task_id?: unknown
  checkin_task_ids?: unknown
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

/**
 * Applies arrangement conflicts before collapsing same-id actions from merged
 * task cards.  An independent action (notably password_only key work) always
 * wins over an action blocked by a deferred/check-in inspection conflict,
 * regardless of child order.
 */
export function mergeDeferredInspectionAwareActions<T extends DeferredInspectionActionLike>(
  actionGroups: T[][],
  blockedSourceIds: Iterable<string> = [],
): T[] {
  const blockedSources = new Set(Array.from(blockedSourceIds, (value) => text(value)).filter(Boolean))
  const actionsById = new Map<string, { action: T; blocked: boolean }>()

  for (const actions of actionGroups || []) {
    for (const rawAction of actions || []) {
      const key = text(rawAction?.id)
      if (!key) continue
      const sourceId = text(rawAction?.source_id)
      const blocked = (
        (key === 'submit_inspection' || key === 'upload_access_video')
        && blockedSources.has(sourceId)
      )
      const action = blocked
        ? { ...rawAction, enabled: false, disabled_reason: 'inspection_arrangement_conflict' } as T
        : rawAction
      const existing = actionsById.get(key)
      if (!existing) {
        actionsById.set(key, { action, blocked })
        continue
      }

      const actionEnabled = action.enabled !== false
      const existingEnabled = existing.action.enabled !== false
      const existingSourceId = text(existing.action.source_id)
      if (
        (existing.blocked && !blocked)
        || (existing.blocked === blocked && !existingEnabled && actionEnabled)
        || (
          existing.blocked === blocked
          && actionEnabled
          && sourceId
          && sourceId !== existingSourceId
        )
      ) {
        actionsById.set(key, { action, blocked })
      }
    }
  }

  return Array.from(actionsById.values(), ({ action }) => action)
}

export function deferredInspectionConflictSourceIds(
  conflicts: Array<DeferredInspectionConflictSourceLike | null | undefined>,
): string[] {
  const sourceIds = new Set<string>()
  for (const conflict of conflicts || []) {
    if (!conflict) continue
    for (const value of [
      conflict.deferred_task_id,
      conflict.checkin_task_id,
      ...(Array.isArray(conflict.checkin_task_ids) ? conflict.checkin_task_ids : []),
    ]) {
      const sourceId = text(value)
      if (sourceId) sourceIds.add(sourceId)
    }
  }
  return Array.from(sourceIds)
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
    && !isTerminalDeferredInspectionStatus(task.status)
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

function isCompletedInspectionBearingCheckin(task: DeferredInspectionCheckinConflictInput) {
  return isInspectionBearingCheckin(task) && !!text(task.inspection_completed_at)
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

function hasReliableDisplayRelation(
  deferred: DeferredInspectionCheckinConflictInput,
  checkin: DeferredInspectionCheckinConflictInput,
) {
  const deferredTaskId = text(deferred.id)
  const checkinTaskId = text(checkin.id)
  if (!deferredTaskId || !checkinTaskId) return false
  if (text(checkin.linked_checkout_task_id) === deferredTaskId) return true
  if (text(deferred.inspection_replaced_by_checkin_task_id) === checkinTaskId) return true

  const deferredOrderId = text(deferred.order_id)
  const checkinOrderId = text(checkin.order_id)
  const deferredCheckout = dayOnly(deferred.order_checkout)
  const checkinOrderCheckin = dayOnly(checkin.order_checkin)
  return !!(
    deferredOrderId
    && checkinOrderId
    && deferredOrderId !== checkinOrderId
    && deferredCheckout
    && checkinOrderCheckin
    && deferredCheckout === taskDay(deferred)
    && checkinOrderCheckin === taskDay(checkin)
  )
}

/**
 * Builds the effective same-property/date inspection arrangement used by the
 * App.  Display merging never infers a reassignment: the incoming check-in's
 * own assignment (including a real unassigned state) remains authoritative.
 * Submission conflicts remain stricter and continue to compare both plans.
 * Password-only work is intentionally not an inspection arrangement.
 */
export function buildDeferredInspectionCheckinArrangements(
  rows: DeferredInspectionCheckinConflictInput[],
): DeferredInspectionCheckinArrangement[] {
  const deferredTasks = (rows || []).filter((task) => (
    isOpenDeferredInspection(task)
    && ['checkout_clean', 'checkout_cleaning'].includes(taskType(task))
  ))
  const checkins = (rows || []).filter(isInspectionBearingCheckin)
  const arrangements: DeferredInspectionCheckinArrangement[] = []

  for (const deferred of deferredTasks) {
    const deferredTaskId = text(deferred.id)
    const propertyId = text(deferred.property_id)
    const originalCheckoutDate = taskDay(deferred)
    const plannedDueDate = dayOnly(deferred.inspection_due_date)
    if (!deferredTaskId || !propertyId || !originalCheckoutDate || !plannedDueDate) continue

    const matchingCheckins = checkins
      .filter((candidate) => text(candidate.property_id) === propertyId && isWithinDeferredReplacementWindow(deferred, candidate))
      .sort(compareCheckins)
    const reliableSameDayCheckins = matchingCheckins.filter((candidate) => (
      taskDay(candidate) === plannedDueDate
      && hasReliableDisplayRelation(deferred, candidate)
    ))
    const checkin = reliableSameDayCheckins.length === 1
      ? reliableSameDayCheckins[0]
      : matchingCheckins[0]
    const checkinTaskId = text(checkin?.id)
    const effectiveInspectionDate = taskDay(checkin || {})
    if (!checkin || !checkinTaskId || !effectiveInspectionDate) continue

    const plannedInspectorId = text(deferred.inspector_id) || null
    const checkinInspectorId = text(checkin.inspector_id) || null
    const checkinAssigneeId = text(checkin.assignee_id) || null
    const conflictReasons: string[] = []
    if (matchingCheckins.length > 1) conflictReasons.push('multiple_checkin_inspection_tasks')
    if (!plannedInspectorId) conflictReasons.push('deferred_inspector_missing')
    if (!checkinInspectorId && !checkinAssigneeId) conflictReasons.push('checkin_executor_missing')
    if (plannedInspectorId && checkinInspectorId && checkinInspectorId !== plannedInspectorId) {
      conflictReasons.push('checkin_inspector_mismatch')
    }
    if (plannedInspectorId && checkinAssigneeId && checkinAssigneeId !== plannedInspectorId) {
      conflictReasons.push('checkin_executor_mismatch')
    }
    if (checkinInspectorId && checkinAssigneeId && checkinInspectorId !== checkinAssigneeId) {
      conflictReasons.push('checkin_participant_mismatch')
    }
    if (
      plannedInspectorId
      && ![checkinInspectorId, checkinAssigneeId].filter(Boolean).includes(plannedInspectorId)
      && !conflictReasons.includes('checkin_executor_missing')
    ) {
      conflictReasons.push('planned_inspector_not_checkin_participant')
    }
    const displayMergeReasons: string[] = []
    if (effectiveInspectionDate !== plannedDueDate) displayMergeReasons.push('checkin_not_on_deferred_inspection_date')
    if (!hasReliableDisplayRelation(deferred, checkin)) displayMergeReasons.push('reliable_turnover_relation_missing')
    if (reliableSameDayCheckins.length > 1) displayMergeReasons.push('multiple_reliable_checkin_inspection_tasks')

    arrangements.push({
      deferred_task_id: deferredTaskId,
      checkin_task_id: checkinTaskId,
      checkin_task_ids: matchingCheckins.map((candidate) => text(candidate.id)).filter(Boolean),
      property_id: propertyId,
      original_checkout_date: originalCheckoutDate,
      effective_inspection_date: effectiveInspectionDate,
      planned_inspector_id: plannedInspectorId,
      checkin_inspector_id: checkinInspectorId,
      checkin_assignee_id: checkinAssigneeId,
      conflict_reasons: Array.from(new Set(conflictReasons)),
      display_merge_eligible: displayMergeReasons.length === 0,
      display_merge_reasons: Array.from(new Set(displayMergeReasons)),
    })
  }

  const arrangementCountByCheckin = new Map<string, number>()
  for (const arrangement of arrangements) {
    arrangementCountByCheckin.set(
      arrangement.checkin_task_id,
      (arrangementCountByCheckin.get(arrangement.checkin_task_id) || 0) + 1,
    )
  }
  for (const arrangement of arrangements) {
    if ((arrangementCountByCheckin.get(arrangement.checkin_task_id) || 0) > 1) {
      arrangement.conflict_reasons = Array.from(new Set([
        ...arrangement.conflict_reasons,
        'multiple_deferred_inspection_tasks',
      ]))
      arrangement.display_merge_eligible = false
      arrangement.display_merge_reasons = Array.from(new Set([
        ...arrangement.display_merge_reasons,
        'multiple_deferred_inspection_tasks',
      ]))
    }
  }

  return arrangements
}

export function indexDeferredInspectionCheckinArrangements(
  arrangements: DeferredInspectionCheckinArrangement[],
) {
  const byTaskId = new Map<string, DeferredInspectionCheckinArrangement[]>()
  for (const arrangement of arrangements || []) {
    const taskIds = Array.from(new Set([
      arrangement.deferred_task_id,
      arrangement.checkin_task_id,
      ...(arrangement.checkin_task_ids || []),
    ].map(text).filter(Boolean)))
    for (const taskId of taskIds) {
      const existing = byTaskId.get(taskId) || []
      existing.push(arrangement)
      byTaskId.set(taskId, existing)
    }
  }
  return byTaskId
}

export function deferredInspectionCheckinSubmissionGuard(
  rows: DeferredInspectionCheckinConflictInput[],
  taskId: string,
) {
  const arrangements = buildDeferredInspectionCheckinArrangements(rows)
  const relevantArrangements = indexDeferredInspectionCheckinArrangements(arrangements).get(text(taskId)) || []
  const conflicts = relevantArrangements.filter((arrangement) => arrangement.conflict_reasons.length > 0)
  const redirectedArrangement = relevantArrangements.find((arrangement) => (
    arrangement.deferred_task_id === text(taskId)
    && arrangement.conflict_reasons.length === 0
  )) || null
  return {
    blocked: conflicts.length > 0 || !!redirectedArrangement,
    reason: conflicts.length > 0
      ? 'inspection_arrangement_conflict'
      : (redirectedArrangement ? 'inspection_action_moved_to_checkin_task' : null),
    canonical_action_task_id: redirectedArrangement?.checkin_task_id || null,
    conflicts,
  }
}

export function findDeferredInspectionCheckinReplacements(rows: DeferredInspectionCheckinConflictInput[]): DeferredInspectionCheckinReplacement[] {
  const rowsById = new Map((rows || []).map((row) => [text(row.id), row]))
  return buildDeferredInspectionCheckinArrangements(rows || [])
    .filter((arrangement) => arrangement.conflict_reasons.length === 0)
    .flatMap((arrangement) => {
      const deferred = rowsById.get(arrangement.deferred_task_id)
      const checkin = rowsById.get(arrangement.checkin_task_id)
      const inspectionDueDate = dayOnly(deferred?.inspection_due_date)
      if (!deferred || !checkin || !inspectionDueDate || !isCompletedInspectionBearingCheckin(checkin)) return []
      return [{
        deferred_task_id: arrangement.deferred_task_id,
        checkin_task_id: arrangement.checkin_task_id,
        property_id: arrangement.property_id,
        inspection_due_date: inspectionDueDate,
        deferred_task_date: arrangement.original_checkout_date,
        checkin_task_date: arrangement.effective_inspection_date,
        checkin_time: text(checkin.checkin_time) || null,
      }]
    })
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
    'inspector_id',
    'assignee_id',
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

export function findStoredDeferredInspectionCheckinReplacement(
  rows: DeferredInspectionCheckinConflictInput[],
  deferredTaskId: string,
): DeferredInspectionCheckinReplacement | null {
  const normalizedDeferredTaskId = text(deferredTaskId)
  const deferred = (rows || []).find((row) => text(row.id) === normalizedDeferredTaskId)
  const originalDueDate = dayOnly(deferred?.inspection_replaced_original_due_date)
  if (!deferred || !originalDueDate || !isAutomaticallyReplacedDeferredInspection(deferred)) return null
  const virtualRows = (rows || []).map((row) => (
    text(row.id) === normalizedDeferredTaskId
      ? {
          ...row,
          inspection_mode: 'deferred',
          inspection_due_date: originalDueDate,
          inspection_replaced_by_checkin_task_id: null,
          inspection_replaced_original_due_date: null,
        }
      : row
  ))
  return findDeferredInspectionCheckinReplacements(virtualRows)
    .find((replacement) => replacement.deferred_task_id === normalizedDeferredTaskId) || null
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
       t.checkin_time,
       t.inspector_id::text AS inspector_id,
       t.assignee_id::text AS assignee_id,
       (
         SELECT MIN(a.performed_at)::text
           FROM work_task_action_audits a
          WHERE a.source_type='cleaning_tasks'
            AND a.source_id::text=t.id::text
            AND a.performed_as_action='submit_inspection'
            AND COALESCE(a.metadata->>'route', '') <> 'mzapp.cleaning_tasks.restock_proof'
            AND (
              COALESCE(a.metadata->>'inspection_submission_complete','false')='true'
              OR COALESCE(a.metadata->>'guest_arrival_skip','false')='true'
              OR (
                COALESCE(a.metadata->>'route', '') IN (
                  'cleaning_app.tasks.inspection_photos',
                  'mzapp.cleaning_tasks.inspection_photos'
                )
                AND lower(COALESCE(a.status_after,'')) IN ('inspected','to_hang_keys','keys_hung','ready','completed','done')
              )
            )
       ) AS inspection_completed_at
     FROM cleaning_tasks t
     LEFT JOIN properties p_id ON p_id.id::text = t.property_id::text
     LEFT JOIN properties p_code ON upper(p_code.code) = upper(t.property_id::text)
     LEFT JOIN orders o ON o.id::text = t.order_id::text
     WHERE ${scopes.join(' OR ')}`,
    values,
  )
  return result?.rows || []
}

/**
 * Transactional fail-closed guard for every inspection/action write route.
 * Related property tasks are locked in a stable order before the target row is
 * mutated, so direct or older clients cannot bypass a visible assignment
 * conflict and concurrent submissions observe one authoritative arrangement.
 */
export async function loadDeferredInspectionCheckinSubmissionGuard(params: {
  taskId: string
  client: any
}) {
  const taskId = text(params.taskId)
  if (!taskId) return {
    blocked: false,
    reason: null,
    canonical_action_task_id: null,
    conflicts: [] as DeferredInspectionCheckinArrangement[],
  }
  const targetResult = await params.client.query(
    `SELECT
       t.id::text AS id,
       COALESCE(p_id.id::text, p_code.id::text, t.property_id::text) AS property_id,
       COALESCE(t.task_type, t.type, '') AS task_type,
       COALESCE(t.task_date, t.date)::text AS task_date,
       t.inspection_mode,
       t.inspection_scope,
       t.inspection_due_date::text AS inspection_due_date,
       t.status,
       t.execution_state
     FROM cleaning_tasks t
     LEFT JOIN properties p_id ON p_id.id::text = t.property_id::text
     LEFT JOIN properties p_code ON upper(p_code.code) = upper(t.property_id::text)
     WHERE t.id::text = $1::text
     LIMIT 1`,
    [taskId],
  )
  const target = targetResult?.rows?.[0] || null
  if (!target) return {
    blocked: false,
    reason: null,
    canonical_action_task_id: null,
    conflicts: [] as DeferredInspectionCheckinArrangement[],
  }
  const targetType = taskType(target)
  const targetTaskDate = taskDay(target)
  const targetDueDate = dayOnly(target.inspection_due_date)
  let windowStart = targetType === 'checkin_clean'
    ? targetTaskDate
    : (isOpenDeferredInspection(target) ? targetTaskDate : null)
  let windowEnd = targetType === 'checkin_clean'
    ? targetTaskDate
    : (isOpenDeferredInspection(target) ? targetDueDate : null)
  if (
    !windowStart
    || !windowEnd
    || !text(target.property_id)
    || (targetType === 'checkin_clean' && lower(target.inspection_scope) === 'password_only')
  ) {
    return {
      blocked: false,
      reason: null,
      canonical_action_task_id: null,
      conflicts: [] as DeferredInspectionCheckinArrangement[],
    }
  }

  if (targetType === 'checkin_clean') {
    const overlappingWindowResult = await params.client.query(
      `SELECT
         MIN(COALESCE(deferred.task_date, deferred.date))::text AS window_start,
         MAX(deferred.inspection_due_date)::text AS window_end
       FROM cleaning_tasks deferred
       LEFT JOIN properties property_by_id ON property_by_id.id::text = deferred.property_id::text
       LEFT JOIN properties property_by_code ON upper(property_by_code.code) = upper(deferred.property_id::text)
       LEFT JOIN orders deferred_order ON deferred_order.id::text = deferred.order_id::text
       WHERE COALESCE(property_by_id.id::text, property_by_code.id::text, deferred.property_id::text) = $1::text
         AND lower(COALESCE(deferred.task_type, deferred.type, '')) IN ('checkout_clean', 'checkout_cleaning')
         AND lower(COALESCE(deferred.inspection_mode, '')) = 'deferred'
         AND deferred.inspection_due_date IS NOT NULL
         AND COALESCE(deferred.task_date, deferred.date)::date <= $2::date
         AND deferred.inspection_due_date::date >= $2::date
         AND COALESCE(deferred.execution_state, CASE WHEN lower(COALESCE(deferred.status, '')) IN ('cancelled', 'canceled') THEN 'cancelled' ELSE 'active' END) = 'active'
         AND lower(COALESCE(deferred.status, '')) NOT IN ('inspected', 'done', 'completed', 'ready', 'keys_hung', 'cancelled', 'canceled')
         AND (
           deferred.order_id IS NULL
           OR (
             deferred_order.id IS NOT NULL
             AND COALESCE(deferred_order.status, '') <> ''
             AND lower(COALESCE(deferred_order.status, '')) <> 'invalid'
             AND lower(COALESCE(deferred_order.status, '')) NOT LIKE '%cancel%'
           )
         )`,
      [text(target.property_id), targetTaskDate],
    )
    windowStart = dayOnly(overlappingWindowResult?.rows?.[0]?.window_start)
    windowEnd = dayOnly(overlappingWindowResult?.rows?.[0]?.window_end)
    if (!windowStart || !windowEnd) {
      return {
        blocked: false,
        reason: null,
        canonical_action_task_id: null,
        conflicts: [] as DeferredInspectionCheckinArrangement[],
      }
    }
  }

  const rowsResult = await params.client.query(
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
       t.order_id::text AS order_id,
       o.status::text AS order_status,
       t.checkin_time,
       t.inspector_id::text AS inspector_id,
       t.assignee_id::text AS assignee_id
     FROM cleaning_tasks t
     LEFT JOIN properties p_id ON p_id.id::text = t.property_id::text
     LEFT JOIN properties p_code ON upper(p_code.code) = upper(t.property_id::text)
     LEFT JOIN orders o ON o.id::text = t.order_id::text
     WHERE COALESCE(p_id.id::text, p_code.id::text, t.property_id::text) = $1::text
       AND (
         (
           lower(COALESCE(t.inspection_mode, '')) = 'deferred'
           AND COALESCE(t.task_date, t.date)::date <= $3::date
           AND t.inspection_due_date::date >= $2::date
         )
         OR (
           lower(COALESCE(t.task_type, t.type, '')) = 'checkin_clean'
           AND COALESCE(t.task_date, t.date)::date BETWEEN $2::date AND $3::date
         )
       )
     ORDER BY t.id::text
     FOR UPDATE OF t`,
    [text(target.property_id), windowStart, windowEnd],
  )
  const rows = rowsResult?.rows || []
  return deferredInspectionCheckinSubmissionGuard(rows, taskId)
}

type DeferredInspectionSubmissionAuthorizationResult =
  | { kind: 'missing' }
  | { kind: 'forbidden' }
  | { kind: 'inspection_arrangement_conflict'; guard: ReturnType<typeof deferredInspectionCheckinSubmissionGuard> }
  | { kind: 'authorized'; task: any }

/**
 * Authorizes a write against the target task before conflict details can be
 * returned. The target is checked once before the wider conflict lookup and
 * again from its locked row afterwards, so a role alone never substitutes for
 * current task-level access and an assignment change cannot disclose metadata.
 */
export async function authorizeDeferredInspectionCheckinSubmission(params: {
  taskId: string
  client: any
  canSubmit: (task: any, client: any) => Promise<boolean>
}): Promise<DeferredInspectionSubmissionAuthorizationResult> {
  const taskId = text(params.taskId)
  const loadTarget = async (lock: boolean) => {
    const result = await params.client.query(
      `SELECT id::text AS id,
              status,
              cleaner_id::text AS cleaner_id,
              inspector_id::text AS inspector_id,
              assignee_id::text AS assignee_id,
              task_type,
              inspection_mode,
              inspection_scope,
              inspection_due_date::text AS inspection_due_date,
              property_id::text AS property_id
         FROM cleaning_tasks
        WHERE id::text = $1::text
        ${lock ? 'FOR UPDATE' : 'LIMIT 1'}`,
      [taskId],
    )
    return result?.rows?.[0] || null
  }

  const preflightTask = await loadTarget(false)
  if (!preflightTask) return { kind: 'missing' }
  if (!await params.canSubmit(preflightTask, params.client)) return { kind: 'forbidden' }

  const guard = await loadDeferredInspectionCheckinSubmissionGuard({ taskId, client: params.client })
  const lockedTask = await loadTarget(true)
  if (!lockedTask) return { kind: 'missing' }
  if (!await params.canSubmit(lockedTask, params.client)) return { kind: 'forbidden' }
  if (guard.blocked) return { kind: 'inspection_arrangement_conflict', guard }
  return { kind: 'authorized', task: lockedTask }
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
  const explicitReason = params.action === 'auto_completed'
    ? 'deferred_replaced_by_completed_checkin'
    : params.action === 'restored'
    ? 'deferred_replacement_restored'
    : 'deferred_replacement_relinked'
  const arrangementRevision = buildMz031CleaningArrangementRevision(params.before, params.after, [explicitReason])
  await emitWorkTaskEvent({
    taskId: `cleaning_task:${String(params.after.id)}`,
    sourceType: 'cleaning_tasks',
    sourceRefIds: [String(params.after.id), ...(params.checkinTaskId ? [params.checkinTaskId] : [])],
    eventType: 'TASK_UPDATED',
    changeScope: 'membership',
    changedFields,
    patch: {
      inspection_mode: params.after.inspection_mode,
      inspection_due_date: params.after.inspection_due_date,
      inspection_replaced_by_checkin_task_id: params.after.inspection_replaced_by_checkin_task_id,
      inspection_replaced_original_due_date: params.after.inspection_replaced_original_due_date,
      inspection_replacement_action: params.action,
    },
    payload: arrangementRevision ? { arrangement_revision: arrangementRevision } : undefined,
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
 * Completes a deferred inspection only after a same-property check-in has an
 * audited inspection submission inside the replacement window. Merely creating,
 * assigning or starting a check-in task never closes the deferred inspection.
 * It also restores the original deferred inspection if that replacing execution
 * later becomes invalid.
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
      const replacement = findStoredDeferredInspectionCheckinReplacement(rows, deferredTaskId)
      const nextCheckinTaskId = replacement?.checkin_task_id || null
      if (nextCheckinTaskId === sourceCheckinTaskId) continue

      const action = nextCheckinTaskId ? 'relinked' as const : 'restored' as const
      const after = await updateAutomaticallyReplacedDeferredInspection({
        action,
        deferredTaskId,
        previousCheckinTaskId: sourceCheckinTaskId,
        nextCheckinTaskId,
        originalDueDate,
        actorUserId: params.actorUserId,
        client,
      })
      if (!after) continue
      await emitReplacementWorkTaskEvent({
        action,
        before: deferred,
        after,
        checkinTaskId: nextCheckinTaskId,
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
