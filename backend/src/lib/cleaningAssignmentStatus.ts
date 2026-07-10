import { normalizeInspectionScope } from './cleaningInspection'

function clean(value: any) {
  return String(value ?? '').trim()
}

export function assignedStatusFromAssignees(cleanerId: any, inspectorId: any): 'assigned' | 'pending' {
  return clean(cleanerId) || clean(inspectorId) ? 'assigned' : 'pending'
}

export function isAutoAssignableCleaningStatus(status: any) {
  const value = clean(status || 'pending').toLowerCase()
  return value === 'pending' || value === 'assigned' || value === 'todo' || value === 'unassigned'
}

export function isCheckinSiteExecutionTask(task: { task_type?: any; type?: any; inspection_scope?: any }) {
  const type = clean(task?.task_type || task?.type).toLowerCase()
  return type === 'checkin_clean' && ['inspect_and_hang', 'password_only'].includes(normalizeInspectionScope(task?.inspection_scope))
}

export function autoCleaningAssignmentStatus(params: {
  task_type?: any
  type?: any
  inspection_scope?: any
  assignee_id?: any
  cleaner_id?: any
  inspector_id?: any
}): 'assigned' | 'pending' {
  if (isCheckinSiteExecutionTask(params)) {
    return assignedStatusFromAssignees(params.assignee_id, params.inspector_id)
  }
  return clean(params.cleaner_id) || clean(params.assignee_id) || clean(params.inspector_id) ? 'assigned' : 'pending'
}
