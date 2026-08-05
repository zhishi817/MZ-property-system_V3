const EXCLUDED_TASK_EXECUTOR_ROLE_NAMES = new Set([
  'customer_service',
  'finance',
  'finance_staff',
  'finance_manager',
])

function normalizedRoleName(value: unknown) {
  return String(value || '').trim().toLowerCase()
}

export function isTaskExecutorEligibleRoleNames(roleNames: unknown[]) {
  const normalized = Array.from(new Set((roleNames || []).map(normalizedRoleName).filter(Boolean)))
  return normalized.length > 0 && !normalized.some((role) => EXCLUDED_TASK_EXECUTOR_ROLE_NAMES.has(role) || role.startsWith('finance_'))
}

export function assignedTaskExecutorIds(params: { cleaningAssignments?: Array<Record<string, unknown>>; workAssignments?: Array<Record<string, unknown>> }) {
  const ids = [
    ...(params.cleaningAssignments || []).filter((item) => String(item.assignee_assignment_action || '').trim() === 'assign').map((item) => String(item.assignee_id || '').trim()),
    ...(params.cleaningAssignments || []).filter((item) => String(item.cleaner_assignment_action || '').trim() === 'assign').map((item) => String(item.cleaner_id || '').trim()),
    ...(params.cleaningAssignments || []).filter((item) => String(item.inspector_assignment_action || '').trim() === 'assign').map((item) => String(item.inspector_id || '').trim()),
    ...(params.workAssignments || []).filter((item) => String(item.assignee_assignment_action || '').trim() === 'assign').map((item) => String(item.assignee_id || '').trim()),
  ].filter(Boolean)
  return Array.from(new Set(ids))
}
