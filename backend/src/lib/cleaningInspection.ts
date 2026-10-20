export type InspectionMode = 'pending_decision' | 'same_day' | 'deferred' | 'self_complete' | 'checked_done'
export type InspectionScope = 'inspect_and_hang' | 'password_only'
export type TaskExecutionSemantics =
  | 'cleaning_execution'
  | 'checkin_inspection'
  | 'inspection_execution'
  | 'key_or_password_action'
  | 'mixed_cleaning_inspection'
  | 'work_task'
export type CleaningTaskExecutionSemantics = Exclude<TaskExecutionSemantics, 'work_task'>

const VALID_INSPECTION_MODES = new Set<InspectionMode>(['pending_decision', 'same_day', 'deferred', 'self_complete', 'checked_done'])
export const TERMINAL_DEFERRED_INSPECTION_STATUSES = [
  'inspected',
  'done',
  'completed',
  'ready',
  'keys_hung',
  'cancelled',
  'canceled',
] as const
const TERMINAL_DEFERRED_INSPECTION_STATUS_SET = new Set<string>(TERMINAL_DEFERRED_INSPECTION_STATUSES)
const LOCKBOX_VIDEO_CURRENT_STATE_STATUSES = new Set<string>([
  'keys_hung',
  'done',
  'completed',
  'ready',
])
const KEY_HANDOVER_PENDING_REQUIREMENTS = new Set<string>([
  'cleaning_consumables',
  'cleaning_property_photo',
  'inspection_photos',
])
const KEY_PHOTO_CURRENT_PROGRESS_STATUSES = new Set<string>(['in_progress', 'cleaning'])
const VALID_TASK_EXECUTION_SEMANTICS = new Set<TaskExecutionSemantics>([
  'cleaning_execution',
  'checkin_inspection',
  'inspection_execution',
  'key_or_password_action',
  'mixed_cleaning_inspection',
  'work_task',
])

function inspectionDayOnly(value: any): string | null {
  const day = String(value || '').slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null
}

export function resolveBoardInspectionDueDate(params: {
  inspectionMode: InspectionMode
  requestedDueDate?: any
  previousDueDate?: any
  previousInspectionMode?: any
  modeChangeAction?: 'set' | null
}): string | null {
  if (params.previousInspectionMode === 'deferred' && params.inspectionMode !== 'deferred' && params.modeChangeAction !== 'set') {
    throw new Error('inspection_mode_change_confirmation_required')
  }
  if (params.inspectionMode !== 'deferred') return null
  const due = inspectionDayOnly(params.requestedDueDate) || inspectionDayOnly(params.previousDueDate)
  if (!due) throw new Error('inspection_due_date_required')
  return due
}

export function normalizeTaskExecutionSemantics(value: any): TaskExecutionSemantics | null {
  const raw = String(value || '').trim().toLowerCase()
  if (!raw) return null
  if (raw === 'key_handover_execution') return 'key_or_password_action'
  return VALID_TASK_EXECUTION_SEMANTICS.has(raw as TaskExecutionSemantics) ? (raw as TaskExecutionSemantics) : null
}

export function isKeyOrPasswordActionSemantics(value: any): boolean {
  return normalizeTaskExecutionSemantics(value) === 'key_or_password_action'
}

export function normalizeInspectionScope(value: any): InspectionScope {
  const raw = String(value || '').trim().toLowerCase()
  return raw === 'password_only' ? 'password_only' : 'inspect_and_hang'
}

export type CleaningKeyHandoverProjection = {
  state: 'completed'
  source_task_id: string
  completed_at: string | null
  workflow_finalization_pending: boolean
  missing_requirements: string[]
}

/**
 * Project the key-handover fact independently from the shared cleaning
 * workflow state.  A checkout inspection can have a valid access video while
 * the task remains `in_progress` because cleaner-owned evidence is still
 * missing.  The narrow pending branch requires the exact task's latest
 * upload audit; a retained URL by itself must never restore a reopened task.
 */
export function projectCleaningKeyHandover(input: {
  taskId?: any
  status?: any
  executionState?: any
  lockboxVideoUrl?: any
  latestUploadAudit?: {
    performed_as_action?: any
    performed_at?: any
    status_before?: any
    status_after?: any
    metadata?: any
  } | null
  invalidatedAfterUpload?: boolean
}): CleaningKeyHandoverProjection | null {
  const taskId = String(input.taskId || '').trim()
  const status = String(input.status || '').trim().toLowerCase()
  const executionState = String(input.executionState || '').trim().toLowerCase()
  const lockboxVideoUrl = String(input.lockboxVideoUrl || '').trim()
  if (!taskId || !lockboxVideoUrl) return null
  if (executionState === 'cancelled' || executionState === 'canceled' || executionState === 'superseded') return null
  if (status === 'cancelled' || status === 'canceled') return null

  const audit = input.latestUploadAudit || null
  const auditAction = String(audit?.performed_as_action || '').trim().toLowerCase()
  const auditMetadata = audit?.metadata && typeof audit.metadata === 'object' ? audit.metadata : {}
  const finalizationPending = auditMetadata.finalization_pending === true
  const missingRequirements: string[] = Array.from(new Set<string>(
    (Array.isArray(auditMetadata.missing_requirements) ? auditMetadata.missing_requirements : [])
      .map((value: any) => String(value || '').trim().toLowerCase())
      .filter((value: string) => KEY_HANDOVER_PENDING_REQUIREMENTS.has(value)),
  ))

  // Once the task has been reset or reopened after this upload, the retained
  // media is historical evidence.  It must not become current again merely
  // because a later workflow run reaches another terminal state.
  if (input.invalidatedAfterUpload === true) return null

  if (LOCKBOX_VIDEO_CURRENT_STATE_STATUSES.has(status)) {
    return {
      state: 'completed',
      source_task_id: taskId,
      completed_at: String(audit?.performed_at || '').trim() || null,
      workflow_finalization_pending: finalizationPending && missingRequirements.length > 0,
      missing_requirements: finalizationPending ? missingRequirements : [],
    }
  }

  if (
    status !== 'in_progress'
    || auditAction !== 'upload_access_video'
    || !finalizationPending
    || missingRequirements.length === 0
  ) return null

  const statusBefore = String(audit?.status_before || '').trim().toLowerCase()
  const statusAfter = String(audit?.status_after || '').trim().toLowerCase()
  if (statusBefore !== status || statusAfter !== status) return null

  return {
    state: 'completed',
    source_task_id: taskId,
    completed_at: String(audit?.performed_at || '').trim() || null,
    workflow_finalization_pending: true,
    missing_requirements: missingRequirements,
  }
}

/**
 * A two-source key-handover fact may only be shared by the canonical booking
 * boundary for one turnover: one checkout task tied to the outgoing order's
 * checkout date and one check-in task tied to the incoming order's check-in
 * date.  Room/date/assignee grouping alone is deliberately insufficient.
 */
export function canonicalKeyHandoverSourceIds(tasks: any[]): string[] {
  const rows = (Array.isArray(tasks) ? tasks : []).filter(Boolean)
  if (rows.length === 1) {
    const sourceId = String(rows[0]?.__raw_id || rows[0]?.source_id || rows[0]?.id || '').trim()
    return sourceId ? [sourceId] : []
  }
  if (rows.length !== 2 || rows.some((row) => String(row?.__work_record_state || '').trim())) return []

  const checkout = rows.find((row) => cleaningInspectionTaskKind(row?.task_type ?? row?.type) === 'checkout')
  const checkin = rows.find((row) => cleaningInspectionTaskKind(row?.task_type ?? row?.type) === 'checkin')
  if (!checkout || !checkin) return []

  const checkoutId = String(checkout?.__raw_id || checkout?.source_id || checkout?.id || '').trim()
  const checkinId = String(checkin?.__raw_id || checkin?.source_id || checkin?.id || '').trim()
  const checkoutOrderId = String(checkout?.order_id || '').trim()
  const checkinOrderId = String(checkin?.order_id || '').trim()
  const checkoutPropertyId = String(checkout?.property_id || checkout?.__prop_id || '').trim()
  const checkinPropertyId = String(checkin?.property_id || checkin?.__prop_id || '').trim()
  const checkoutTaskDate = inspectionDayOnly(checkout?.task_date ?? checkout?.date ?? checkout?.__date)
  const checkinTaskDate = inspectionDayOnly(checkin?.task_date ?? checkin?.date ?? checkin?.__date)
  const outgoingCheckoutDate = inspectionDayOnly(checkout?.order_checkout)
  const incomingCheckinDate = inspectionDayOnly(checkin?.order_checkin)

  if (!checkoutId || !checkinId || checkoutId === checkinId) return []
  if (!checkoutOrderId || !checkinOrderId || checkoutOrderId === checkinOrderId) return []
  if (!checkoutPropertyId || checkoutPropertyId !== checkinPropertyId) return []
  if (!checkoutTaskDate || checkoutTaskDate !== checkinTaskDate) return []
  if (outgoingCheckoutDate !== checkoutTaskDate || incomingCheckinDate !== checkinTaskDate) return []
  return [checkoutId, checkinId]
}

export function mergeCleaningKeyHandoverProjections(
  tasks: any[],
  canonicalSourceIds: string[],
): CleaningKeyHandoverProjection | null {
  const allowedSourceIds = new Set(
    (Array.isArray(canonicalSourceIds) ? canonicalSourceIds : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean),
  )
  if (!allowedSourceIds.size || allowedSourceIds.size > 2) return null
  const facts = (Array.isArray(tasks) ? tasks : [])
    .map((task) => task?.key_handover)
    .filter((fact): fact is CleaningKeyHandoverProjection => (
      fact?.state === 'completed'
      && allowedSourceIds.has(String(fact?.source_task_id || '').trim())
    ))
  if (!facts.length) return null
  const latest = facts.slice().sort((a, b) => String(b.completed_at || '').localeCompare(String(a.completed_at || '')))[0]
  const missingRequirements = Array.from(new Set(
    facts.flatMap((fact) => Array.isArray(fact.missing_requirements) ? fact.missing_requirements.map(String) : []),
  ))
  return {
    ...latest,
    workflow_finalization_pending: facts.some((fact) => fact.workflow_finalization_pending === true),
    missing_requirements: missingRequirements,
  }
}

export function hasCheckoutCheckinTurnover(rows: Array<{ task_type?: any; type?: any }>): boolean {
  const kinds = new Set((Array.isArray(rows) ? rows : []).map((row) => (
    cleaningInspectionTaskKind(row?.task_type ?? row?.type)
  )))
  return kinds.has('checkout') && kinds.has('checkin')
}

export function normalizeTurnoverInspectionScope(params: {
  inspectionScope?: any
  hasCheckoutCheckinTurnover?: boolean
}): InspectionScope {
  return params?.hasCheckoutCheckinTurnover
    ? 'inspect_and_hang'
    : normalizeInspectionScope(params?.inspectionScope)
}

export function normalizeInspectionMode(value: any): InspectionMode | null {
  const raw = String(value || '').trim().toLowerCase()
  if (!raw) return null
  return VALID_INSPECTION_MODES.has(raw as InspectionMode) ? (raw as InspectionMode) : null
}

export function isInspectionModeAllowedForTask(params: {
  taskType?: any
  inspectionScope?: any
  inspectionMode?: any
}): boolean {
  const mode = normalizeInspectionMode(params?.inspectionMode)
  if (!mode) return false
  if (cleaningInspectionTaskKind(params?.taskType) !== 'checkin') return true
  if (normalizeInspectionScope(params?.inspectionScope) !== 'password_only') return true
  return mode !== 'self_complete' && mode !== 'checked_done'
}

export function sanitizeInspectionModeForTask(params: {
  taskType?: any
  inspectionScope?: any
  inspectionMode?: InspectionMode | null | undefined
}): InspectionMode {
  const mode = params?.inspectionMode || 'pending_decision'
  if (!isInspectionModeAllowedForTask({
    taskType: params?.taskType,
    inspectionScope: params?.inspectionScope,
    inspectionMode: mode,
  })) {
    return 'same_day'
  }
  return mode
}

export function cleaningInspectionTaskKind(taskType: any): 'checkout' | 'checkin' | 'stayover' | 'other' {
  const raw = String(taskType || '').trim().toLowerCase()
  if (raw === 'checkout_clean') return 'checkout'
  if (raw === 'checkin_clean') return 'checkin'
  if (raw === 'stayover_clean') return 'stayover'
  return 'other'
}

export function isCheckinKeyHandoverTask(task: { task_type?: any; inspection_scope?: any }): boolean {
  return cleaningInspectionTaskKind(task?.task_type) === 'checkin' && normalizeInspectionScope(task?.inspection_scope) === 'password_only'
}

export function isCleaningExecutionTask(task: { task_type?: any; inspection_scope?: any }): boolean {
  return cleaningInspectionTaskKind(task?.task_type) !== 'checkin'
}

export function cleaningTaskExecutionSemantics(params: {
  roleKind?: any
  taskType?: any
  inspectionScope?: any
  hasCleaningExecution?: boolean
  hasInspectionExecution?: boolean
  hasKeyHandoverExecution?: boolean
}): CleaningTaskExecutionSemantics {
  if (params?.hasKeyHandoverExecution) return 'key_or_password_action'
  if (params?.hasCleaningExecution && params?.hasInspectionExecution) return 'mixed_cleaning_inspection'
  const role = String(params?.roleKind || '').trim().toLowerCase()
  if (role === 'executor' || role === 'execution') return 'key_or_password_action'
  if (role === 'cleaner' || role === 'cleaning') return 'cleaning_execution'
  if (isCheckinKeyHandoverTask({ task_type: params?.taskType, inspection_scope: params?.inspectionScope })) return 'key_or_password_action'
  if (cleaningInspectionTaskKind(params?.taskType) === 'checkin') return 'checkin_inspection'
  return 'inspection_execution'
}

export function isInspectionFinishedStatus(status: any): boolean {
  const raw = String(status || '').trim().toLowerCase()
  return raw === 'inspected' || raw === 'done' || raw === 'completed' || raw === 'ready' || raw === 'keys_hung'
}

export function isTerminalDeferredInspectionStatus(status: any): boolean {
  return TERMINAL_DEFERRED_INSPECTION_STATUS_SET.has(String(status || '').trim().toLowerCase())
}

/**
 * A lockbox video is retained as evidence when a task is reopened. It may only
 * confirm a current keys-hung state when the task lifecycle is still at or
 * beyond that step; the media alone must not advance an assigned task.
 */
export function lockboxVideoConfirmsCurrentTaskState(params: {
  status?: any
  lockboxVideoUrl?: any
}): boolean {
  if (!String(params?.lockboxVideoUrl || '').trim()) return false
  return LOCKBOX_VIDEO_CURRENT_STATE_STATUSES.has(String(params?.status || '').trim().toLowerCase())
}

export function keyPhotoConfirmsCurrentTaskProgress(params: {
  status?: any
  keyPhotoUrl?: any
}): boolean {
  if (!String(params?.keyPhotoUrl || '').trim()) return false
  return KEY_PHOTO_CURRENT_PROGRESS_STATUSES.has(String(params?.status || '').trim().toLowerCase())
}

/**
 * An overdue deferred inspection without a stored checkout/check-in
 * arrangement is an independent source of work. Keep it out of ordinary
 * date/property turnover de-duplication so its assignee, state, and evidence
 * cannot leak into a later booking.
 */
export function unlinkedDeferredInspectionMergeKey(params: {
  sourceId?: any
  inspectionMode?: any
  hasExplicitInspectionRelation?: boolean
}): string | null {
  if (normalizeInspectionMode(params?.inspectionMode) !== 'deferred') return null
  if (params?.hasExplicitInspectionRelation === true) return null
  const sourceId = String(params?.sourceId || '').trim()
  return sourceId ? `deferred:${sourceId}` : null
}

export function withInspectionMergeIsolation(baseKey: string, isolationKey?: any): string {
  const isolated = String(isolationKey || '').trim()
  return isolated ? `${baseKey}|${isolated}` : baseKey
}

export function openDeferredInspectionStatusSql(alias: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw new Error('invalid_sql_alias')
  const terminalStatuses = TERMINAL_DEFERRED_INSPECTION_STATUSES.map((status) => `'${status}'`).join(', ')
  return `lower(COALESCE(${alias}.status, '')) NOT IN (${terminalStatuses})`
}

export function projectInspectorTaskStatus(status: any, inspectionScope: any): string {
  const raw = String(status || '').trim().toLowerCase()
  if (raw !== 'inspected') return raw
  return normalizeInspectionScope(inspectionScope) === 'password_only' ? 'done' : 'to_hang_keys'
}

export function isCleaningDoneLikeStatus(status: any): boolean {
  const raw = String(status || '').trim().toLowerCase()
  return (
    raw === 'cleaned' ||
    raw === 'restock_pending' ||
    raw === 'restocked' ||
    raw === 'inspected' ||
    raw === 'done' ||
    raw === 'completed' ||
    raw === 'ready' ||
    raw === 'keys_hung'
  )
}

export function defaultInspectionModeForTaskType(taskType: any): InspectionMode {
  const kind = cleaningInspectionTaskKind(taskType)
  if (kind === 'stayover') return 'self_complete'
  if (kind === 'checkin') return 'same_day'
  return 'pending_decision'
}

export function effectiveInspectionMode(task: {
  task_type?: any
  inspection_mode?: any
  inspection_scope?: any
  status?: any
  cleaner_id?: any
  inspector_id?: any
}): InspectionMode {
  const explicit = normalizeInspectionMode(task?.inspection_mode)
  if (explicit) {
    return sanitizeInspectionModeForTask({
      taskType: task?.task_type,
      inspectionScope: task?.inspection_scope,
      inspectionMode: explicit,
    })
  }
  const kind = cleaningInspectionTaskKind(task?.task_type)
  if (kind === 'stayover') return 'self_complete'
  if (kind === 'checkin') return 'same_day'
  if (kind === 'checkout') {
    if (String(task?.inspector_id || '').trim()) return 'same_day'
    if (isCleaningDoneLikeStatus(task?.status)) return 'self_complete'
    return 'pending_decision'
  }
  if (String(task?.inspector_id || '').trim()) return 'same_day'
  return 'pending_decision'
}

/**
 * Legacy participant fallback for the submit_inspection business action.
 * Manual work-task grants are evaluated separately by the route.
 */
export function isCleaningTaskInspectionSubmitParticipant(task: {
  task_type?: any
  type?: any
  inspection_mode?: any
  inspection_scope?: any
  status?: any
  inspector_id?: any
  assignee_id?: any
}, userId: any): boolean {
  const uid = String(userId || '').trim()
  if (!uid) return false
  const mode = effectiveInspectionMode(task)
  const scope = normalizeInspectionScope(task?.inspection_scope)
  const kind = cleaningInspectionTaskKind(task?.task_type ?? task?.type)
  if (scope === 'password_only') return false
  if (mode !== 'same_day' && mode !== 'deferred') return false
  const inspectorId = String(task?.inspector_id || '').trim()
  const assigneeId = String(task?.assignee_id || '').trim()
  if (kind === 'checkin') return inspectorId === uid || assigneeId === uid
  if (kind === 'checkout') return inspectorId ? inspectorId === uid : assigneeId === uid
  return !!inspectorId && inspectorId === uid
}

export function deferredProjectionDate(params: {
  inspectionMode: InspectionMode
  inspectionDueDate?: any
  dateFrom: string
  dateTo: string
  status?: any
}): string | null {
  if (params.inspectionMode !== 'deferred') return null
  const due = String(params.inspectionDueDate || '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) return null
  const from = String(params.dateFrom || '').slice(0, 10)
  const to = String(params.dateTo || '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return null
  if (due > to) return null
  if (due < from && (isInspectionFinishedStatus(params.status) || ['cancelled', 'canceled'].includes(String(params.status || '').trim().toLowerCase()))) {
    return null
  }
  return due < from ? from : due
}

export function mobileInspectionProjectionDate(params: {
  inspectionMode: InspectionMode
  inspectionDueDate?: any
  taskDate?: any
  dateFrom: string
  dateTo: string
  status?: any
}): string | null {
  if (params.inspectionMode === 'deferred') {
    return deferredProjectionDate(params)
  }

  const taskDate = String(params.taskDate || '').slice(0, 10)
  const from = String(params.dateFrom || '').slice(0, 10)
  const to = String(params.dateTo || '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(taskDate)) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return null
  if (taskDate < from || taskDate > to) return null
  if (params.inspectionMode === 'same_day') return taskDate

  const status = String(params.status || '').trim().toLowerCase()
  if (params.inspectionMode === 'self_complete' && status === 'keys_hung') return taskDate
  return null
}

export function mergeInspectionPlan(
  rows: Array<{
    task_type?: any
    inspection_mode?: any
    inspection_due_date?: any
    inspector_id?: any
    status?: any
  }>,
): { inspectionMode: InspectionMode; inspectionDueDate: string | null } {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : []
  if (!list.length) return { inspectionMode: 'pending_decision', inspectionDueDate: null }

  const kindOf = (row: any) => cleaningInspectionTaskKind(row?.task_type)
  const checkoutRows = list.filter((row) => kindOf(row) === 'checkout')
  const actionableRows = checkoutRows.length
    ? checkoutRows
    : list.filter((row) => kindOf(row) !== 'stayover')
  const relevantRows = actionableRows.length ? actionableRows : list

  const dueDateFor = (row: any) => {
    const s = String(row?.inspection_due_date || '').slice(0, 10)
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null
  }

  for (const row of relevantRows) {
    if (effectiveInspectionMode(row) === 'deferred') {
      return {
        inspectionMode: 'deferred',
        inspectionDueDate: dueDateFor(row),
      }
    }
  }

  if (relevantRows.some((row) => effectiveInspectionMode(row) === 'same_day')) {
    return { inspectionMode: 'same_day', inspectionDueDate: null }
  }

  if (relevantRows.some((row) => effectiveInspectionMode(row) === 'pending_decision')) {
    return { inspectionMode: 'pending_decision', inspectionDueDate: null }
  }

  if (relevantRows.some((row) => effectiveInspectionMode(row) === 'checked_done')) {
    return { inspectionMode: 'checked_done', inspectionDueDate: null }
  }

  if (relevantRows.every((row) => effectiveInspectionMode(row) === 'self_complete')) {
    return { inspectionMode: 'self_complete', inspectionDueDate: null }
  }

  return { inspectionMode: 'pending_decision', inspectionDueDate: null }
}

function mergedTaskStatus(statuses: any[]): string {
  const values = statuses.map((status) => String(status || '').trim().toLowerCase() || 'pending')
  if (values.length && values.every((status) => status === 'cancelled' || status === 'canceled')) return 'cancelled'
  const rank = (status: string) => {
    if (status === 'keys_hung') return 90
    if (status === 'done' || status === 'completed' || status === 'ready') return 80
    if (status === 'inspected') return 75
    if (status === 'cleaned' || status === 'restock_pending' || status === 'restocked' || status === 'to_inspect' || status === 'to_hang_keys') return 70
    if (status === 'in_progress') return 50
    if (status === 'assigned' || status === 'scheduled') return 40
    if (status === 'pending' || status === 'todo' || status === 'unassigned') return 10
    return 0
  }
  let best = ''
  let bestRank = -1
  for (const status of values) {
    const nextRank = rank(status)
    if (nextRank > bestRank) {
      best = status
      bestRank = nextRank
    }
  }
  if (best) return best
  return 'pending'
}

function matchingId(rows: any[], pick: (row: any) => any): { matches: boolean; value: string | null } {
  if (!rows.length) return { matches: true, value: null }
  const values = rows.map((row) => String(pick(row) || '').trim())
  return {
    matches: values.every((value) => value === values[0]),
    value: values[0] || null,
  }
}

export function mergeTurnoverTaskPlan(
  rows: Array<{
    task_type?: any
    cleaner_id?: any
    assignee_id?: any
    inspector_id?: any
    status?: any
    inspection_mode?: any
    inspection_scope?: any
    inspection_due_date?: any
  }>,
): {
  cleanerId: string | null
  assigneeId: string | null
  inspectorId: string | null
  status: string
  inspectionMode: InspectionMode
  inspectionScope: InspectionScope
  inspectionDueDate: string | null
} {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : []
  const checkoutRows = list.filter((row) => cleaningInspectionTaskKind(row?.task_type) === 'checkout')
  const primaryRows = checkoutRows.length ? checkoutRows : list
  const cleaner = matchingId(primaryRows, (row) => row?.cleaner_id || row?.assignee_id)
  const assignee = matchingId(primaryRows, (row) => row?.assignee_id)
  const inspectionRows = checkoutRows.length
    ? checkoutRows
    : list.filter((row) => cleaningInspectionTaskKind(row?.task_type) !== 'stayover')
  const inspector = matchingId(inspectionRows.length ? inspectionRows : list, (row) => row?.inspector_id)
  const inspectionPlan = mergeInspectionPlan(list)
  const cleanerId = cleaner.matches ? cleaner.value : null
  const hasTurnover = hasCheckoutCheckinTurnover(list)

  return {
    cleanerId,
    assigneeId: assignee.matches ? (assignee.value || cleanerId) : cleanerId,
    inspectorId: inspector.matches ? inspector.value : null,
    status: mergedTaskStatus(list.map((row) => row?.status)),
    inspectionMode: inspectionPlan.inspectionMode,
    inspectionScope: normalizeTurnoverInspectionScope({
      inspectionScope: list.find((row) => cleaningInspectionTaskKind(row?.task_type) === 'checkin')?.inspection_scope,
      hasCheckoutCheckinTurnover: hasTurnover,
    }),
    inspectionDueDate: inspectionPlan.inspectionDueDate,
  }
}
