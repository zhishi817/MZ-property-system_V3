export type InspectionMode = 'pending_decision' | 'same_day' | 'deferred' | 'self_complete' | 'checked_done'
export type InspectionScope = 'inspect_and_hang' | 'password_only'

const VALID_INSPECTION_MODES = new Set<InspectionMode>(['pending_decision', 'same_day', 'deferred', 'self_complete', 'checked_done'])

export function normalizeInspectionScope(value: any): InspectionScope {
  const raw = String(value || '').trim().toLowerCase()
  return raw === 'password_only' ? 'password_only' : 'inspect_and_hang'
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
}): 'cleaning_execution' | 'checkin_inspection' | 'inspection_execution' | 'key_handover_execution' | 'mixed_cleaning_inspection' {
  if (params?.hasKeyHandoverExecution) return 'key_handover_execution'
  if (params?.hasCleaningExecution && params?.hasInspectionExecution) return 'mixed_cleaning_inspection'
  const role = String(params?.roleKind || '').trim().toLowerCase()
  if (role === 'executor' || role === 'execution') return 'key_handover_execution'
  if (role === 'cleaner' || role === 'cleaning') return 'cleaning_execution'
  if (isCheckinKeyHandoverTask({ task_type: params?.taskType, inspection_scope: params?.inspectionScope })) return 'key_handover_execution'
  if (cleaningInspectionTaskKind(params?.taskType) === 'checkin') return 'checkin_inspection'
  return 'inspection_execution'
}

export function isInspectionFinishedStatus(status: any): boolean {
  const raw = String(status || '').trim().toLowerCase()
  return raw === 'inspected' || raw === 'done' || raw === 'completed' || raw === 'ready' || raw === 'keys_hung'
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
    inspection_due_date?: any
  }>,
): {
  cleanerId: string | null
  assigneeId: string | null
  inspectorId: string | null
  status: string
  inspectionMode: InspectionMode
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

  return {
    cleanerId,
    assigneeId: assignee.matches ? (assignee.value || cleanerId) : cleanerId,
    inspectorId: inspector.matches ? inspector.value : null,
    status: mergedTaskStatus(list.map((row) => row?.status)),
    inspectionMode: inspectionPlan.inspectionMode,
    inspectionDueDate: inspectionPlan.inspectionDueDate,
  }
}
