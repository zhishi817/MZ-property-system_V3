export type InspectionMode = 'pending_decision' | 'same_day' | 'self_complete' | 'deferred'

const VALID_INSPECTION_MODES = new Set<InspectionMode>(['pending_decision', 'same_day', 'self_complete', 'deferred'])

export function normalizeInspectionMode(value: any): InspectionMode | null {
  const raw = String(value || '').trim().toLowerCase()
  if (!raw) return null
  return VALID_INSPECTION_MODES.has(raw as InspectionMode) ? (raw as InspectionMode) : null
}

export function cleaningInspectionTaskKind(taskType: any): 'checkout' | 'checkin' | 'stayover' | 'other' {
  const raw = String(taskType || '').trim().toLowerCase()
  if (raw === 'checkout_clean') return 'checkout'
  if (raw === 'checkin_clean') return 'checkin'
  if (raw === 'stayover_clean') return 'stayover'
  return 'other'
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
  status?: any
  inspector_id?: any
}): InspectionMode {
  const explicit = normalizeInspectionMode(task?.inspection_mode)
  if (explicit) return explicit
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
  if (due < from && isInspectionFinishedStatus(params.status)) return null
  return due < from ? from : due
}

