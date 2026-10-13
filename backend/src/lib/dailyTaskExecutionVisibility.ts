export const DAILY_TASK_MANAGER_ROLES = ['admin', 'offline_manager', 'customer_service'] as const

export type DailyTaskExecutionCandidate = {
  source_type?: unknown
  task_kind?: unknown
  task_type?: unknown
  status?: unknown
  source_workflow_status?: unknown
  maintenance_workflow?: { status?: unknown } | null
  scheduled_date?: unknown
  task_date?: unknown
  date?: unknown
  assignee_id?: unknown
  cleaner_id?: unknown
  inspector_id?: unknown
}

export type DailyTaskExecutionVisibility = {
  visible: boolean
  reason: 'visible' | 'review_only' | 'terminal' | 'unscheduled' | 'unassigned'
}

export type DailyTaskExecutionVisibilityOptions = {
  includeManagerUnassignedOffline?: boolean
}

const REVIEW_ONLY_STATUSES = new Set(['pending_review', 'review_pending', 'awaiting_review'])
const TERMINAL_STATUSES = new Set(['cancelled', 'canceled', 'closed'])
const ASSIGNMENT_FIRST_SOURCES = new Set([
  'property_maintenance',
  'external_maintenance_orders',
  'property_deep_cleaning',
  'property_daily_necessities',
])
const REVIEW_COMPLETION_ALIAS_SOURCES = new Set([
  'property_maintenance',
  'external_maintenance_orders',
  'property_deep_cleaning',
])
const MAINTENANCE_REVIEW_ALIASES = new Set(['done', 'completed', 'ready'])
const TURNOVER_TYPES = new Set(['turnover', 'checkout', 'checkin', 'checkout_clean', 'checkin_clean'])

function normalized(value: unknown) {
  return String(value ?? '').trim().toLowerCase()
}

function hasValue(value: unknown) {
  return Boolean(String(value ?? '').trim())
}

function scheduledDate(task: DailyTaskExecutionCandidate) {
  const value = Object.prototype.hasOwnProperty.call(task, 'scheduled_date')
    ? task.scheduled_date
    : (task.task_date || task.date)
  return normalized(value).slice(0, 10)
}

function sourceWorkflowStatus(task: DailyTaskExecutionCandidate) {
  return normalized(task.source_workflow_status || task.maintenance_workflow?.status || task.status)
}

export function isDailyTaskManagerRoleNames(roleNames: unknown) {
  const names = Array.isArray(roleNames)
    ? roleNames.map((value) => String(value ?? '').trim())
    : [String(roleNames ?? '').trim()]
  return names.some((name) => DAILY_TASK_MANAGER_ROLES.includes(name as typeof DAILY_TASK_MANAGER_ROLES[number]))
}

export function isTurnoverDailyExecutionTask(task: DailyTaskExecutionCandidate) {
  if (normalized(task.source_type) !== 'cleaning_tasks') return false
  return TURNOVER_TYPES.has(normalized(task.task_type)) || TURNOVER_TYPES.has(normalized(task.task_kind))
}

export function hasDailyTaskExecutor(task: DailyTaskExecutionCandidate) {
  const source = normalized(task.source_type)
  const kind = normalized(task.task_kind)
  if (source !== 'cleaning_tasks') return hasValue(task.assignee_id)
  if (kind === 'inspection') return hasValue(task.inspector_id) || hasValue(task.assignee_id)
  if (kind === 'cleaning') return hasValue(task.cleaner_id) || hasValue(task.assignee_id)
  return hasValue(task.assignee_id) || hasValue(task.cleaner_id) || hasValue(task.inspector_id)
}

export function isOrdinaryOfflineDailyTask(task: DailyTaskExecutionCandidate) {
  return normalized(task.task_kind) === 'offline'
    && !ASSIGNMENT_FIRST_SOURCES.has(normalized(task.source_type))
}

export function dailyTaskExecutionVisibility(
  task: DailyTaskExecutionCandidate,
  options: DailyTaskExecutionVisibilityOptions = {},
): DailyTaskExecutionVisibility {
  const source = normalized(task.source_type)
  const workflowStatus = sourceWorkflowStatus(task)

  if (REVIEW_ONLY_STATUSES.has(workflowStatus)) return { visible: false, reason: 'review_only' }
  if (TERMINAL_STATUSES.has(workflowStatus)) return { visible: false, reason: 'terminal' }
  if (REVIEW_COMPLETION_ALIAS_SOURCES.has(source) && MAINTENANCE_REVIEW_ALIASES.has(workflowStatus)) {
    return { visible: false, reason: 'review_only' }
  }
  if (ASSIGNMENT_FIRST_SOURCES.has(source) && workflowStatus === 'pending_assignment') {
    return { visible: false, reason: 'unassigned' }
  }
  if (!scheduledDate(task)) return { visible: false, reason: 'unscheduled' }
  if (!isTurnoverDailyExecutionTask(task) && !hasDailyTaskExecutor(task)) {
    if (options.includeManagerUnassignedOffline === true && isOrdinaryOfflineDailyTask(task)) {
      return { visible: true, reason: 'visible' }
    }
    return { visible: false, reason: 'unassigned' }
  }
  return { visible: true, reason: 'visible' }
}

export function projectDailyTaskExecution<T extends DailyTaskExecutionCandidate>(task: T): T & { execution_list_visible: boolean } {
  return {
    ...task,
    execution_list_visible: dailyTaskExecutionVisibility(task).visible,
  }
}

/**
 * The Web task center is also an assignment surface. A scheduled, active
 * offline task must remain visible there before an executor is assigned, while
 * the Mobile execution list continues to hide it until assignment.
 */
export function isTaskCenterManagementOnlyOfflineTask(task: DailyTaskExecutionCandidate) {
  return isOrdinaryOfflineDailyTask(task)
    && dailyTaskExecutionVisibility(task).reason === 'unassigned'
}

export function projectTaskCenterManageableWorkTasks<T extends DailyTaskExecutionCandidate>(tasks: T[]) {
  return tasks
    .map(projectDailyTaskExecution)
    .filter((task) => task.execution_list_visible || isTaskCenterManagementOnlyOfflineTask(task))
}

export function projectVisibleDailyTasks<T extends DailyTaskExecutionCandidate>(
  tasks: T[],
  options: DailyTaskExecutionVisibilityOptions = {},
) {
  return tasks
    .map((task) => ({
      ...task,
      execution_list_visible: dailyTaskExecutionVisibility(task, options).visible,
    }))
    .filter((task) => task.execution_list_visible)
}
