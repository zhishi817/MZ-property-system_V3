import { buildWebTaskManagementPayload, type WebTaskEditableField, type WebTaskManagementAction } from './workTaskActions'

export type { WebTaskEditableField, WebTaskManagementAction, WebTaskManagementActionId } from './workTaskActions'

export type WebTaskDisplayBadge = {
  id: string
  label: string
  tone: 'normal' | 'special' | 'pending' | 'danger' | 'success' | 'info' | 'neutral'
}

export type WebTaskDisplayState = {
  status_key: string
  status_label: string
  status_tone: WebTaskDisplayBadge['tone']
  task_semantics: {
    source: 'cleaning' | 'work' | 'offline' | 'unknown'
    is_cleaning_task: boolean
    is_work_task: boolean
    is_offline_task: boolean
    is_pure_checkin: boolean
    is_cleaning_execution: boolean
    is_key_handover: boolean
    is_password_only: boolean
    requires_cleaner: boolean
    can_configure_inspection: boolean
    is_deferred_inspection: boolean
    is_keys_hung: boolean
    is_self_complete: boolean
    is_checked_done: boolean
    is_task_ended: boolean
    inspection_mode: string | null
    inspection_mode_label: string | null
    inspection_scope: string | null
    inspection_scope_label: string | null
  }
  badges: WebTaskDisplayBadge[]
}

export type WebTaskExecutionSemantics =
  | 'cleaning_execution'
  | 'checkin_inspection'
  | 'inspection_execution'
  | 'key_or_password_action'
  | 'mixed_cleaning_inspection'
  | 'work_task'

export type WebTaskDisplayScope = {
  key: WebTaskExecutionSemantics
  label: string
  tone: WebTaskDisplayBadge['tone']
}

export type WebTaskParticipantSummary = {
  primary_role: 'cleaner' | 'inspector' | 'executor' | 'assignee' | 'none'
  primary_user_id: string | null
  cleaner_id: string | null
  inspector_id: string | null
  executor_id: string | null
  show_cleaner: boolean
  show_inspector: boolean
  show_executor: boolean
}

export type WebTaskCapabilityPayload = {
  display_state: WebTaskDisplayState
  execution_semantics: WebTaskExecutionSemantics
  display_scope: WebTaskDisplayScope
  participant_summary: WebTaskParticipantSummary
  editable_fields: Record<string, WebTaskEditableField>
  management_actions: WebTaskManagementAction[]
}

export type WebTaskCapabilityContext = {
  canManageSchedule: boolean
}

function cleanText(value: unknown) {
  return String(value ?? '').trim()
}

function lower(value: unknown) {
  return cleanText(value).toLowerCase()
}

function normalizeStatus(status: unknown) {
  return lower(status) || 'pending'
}

function normalizeInspectionScope(scope: unknown) {
  return lower(scope) === 'password_only' ? 'password_only' : 'inspect_and_hang'
}

function normalizeInspectionMode(mode: unknown) {
  const value = lower(mode)
  if (value === 'same_day' || value === 'deferred' || value === 'self_complete' || value === 'checked_done') return value
  return 'pending_decision'
}

function statusMeta(status: unknown): Pick<WebTaskDisplayState, 'status_key' | 'status_label' | 'status_tone'> {
  const value = normalizeStatus(status)
  if (value === 'to_inspect') return { status_key: value, status_label: '待检查', status_tone: 'pending' }
  if (value === 'to_hang_keys') return { status_key: value, status_label: '待挂钥匙', status_tone: 'pending' }
  if (value === 'to_complete') return { status_key: value, status_label: '待完成', status_tone: 'pending' }
  if (value === 'pending' || value === 'todo' || value === 'unassigned') return { status_key: value, status_label: '待处理', status_tone: 'pending' }
  if (value === 'assigned') return { status_key: value, status_label: '已分配', status_tone: 'normal' }
  if (value === 'in_progress') return { status_key: value, status_label: '进行中', status_tone: 'normal' }
  if (value === 'keys_hung') return { status_key: value, status_label: '已挂钥匙', status_tone: 'success' }
  if (value === 'ready') return { status_key: value, status_label: '已就绪', status_tone: 'success' }
  if (value === 'cleaned') return { status_key: value, status_label: '已清洁', status_tone: 'success' }
  if (value === 'restock_pending') return { status_key: value, status_label: '待补品', status_tone: 'pending' }
  if (value === 'restocked') return { status_key: value, status_label: '已补品', status_tone: 'success' }
  if (value === 'inspected') return { status_key: value, status_label: '已检查', status_tone: 'success' }
  if (value === 'completed' || value === 'done') return { status_key: value, status_label: '已完成', status_tone: 'success' }
  if (value === 'cancelled' || value === 'canceled') return { status_key: value, status_label: '已取消', status_tone: 'neutral' }
  return { status_key: value, status_label: value || '-', status_tone: 'neutral' }
}

function inspectionModeLabel(mode: string) {
  if (mode === 'same_day') return '同日检查'
  if (mode === 'deferred') return '延期检查'
  if (mode === 'self_complete') return '自完成'
  if (mode === 'checked_done') return '已检查'
  return '待确认检查安排'
}

function inspectionScopeLabel(scope: string) {
  return scope === 'password_only' ? '仅改密码' : '检查后挂钥匙'
}

function taskTypeOf(task: Record<string, any>) {
  return lower(task.task_kind || task.task_type || task.label)
}

function sourceOf(task: Record<string, any>): WebTaskDisplayState['task_semantics']['source'] {
  const source = lower(task.task_source || task.source)
  if (source === 'cleaning' || source === 'cleaning_tasks') return 'cleaning'
  if (source === 'work' || source === 'work_tasks') return 'work'
  if (source === 'offline' || source === 'offline_tasks' || source === 'cleaning_offline_tasks') return 'offline'
  return 'unknown'
}

function isPureCheckinTask(task: Record<string, any>) {
  const type = taskTypeOf(task)
  const label = cleanText(task.label || task.title || task.detail)
  if (type === 'checkin_clean') return true
  return label.includes('入住') && !label.includes('退房') && !label.includes('入住中清洁')
}

function isStayoverTask(task: Record<string, any>) {
  const type = taskTypeOf(task)
  const label = cleanText(task.label || task.title || task.detail)
  return type === 'stayover_clean' || label.includes('入住中清洁') || label.toLowerCase().includes('stayover')
}

function isCompletedStatus(status: string) {
  return [
    'ready',
    'done',
    'completed',
    'cleaned',
    'restock_pending',
    'restocked',
    'keys_hung',
    'inspected',
    'cancelled',
    'canceled',
  ].includes(status)
}

function executionSemantics(params: {
  source: WebTaskDisplayState['task_semantics']['source']
  pureCheckin: boolean
  isPasswordOnly: boolean
  deferredInspection: boolean
  isCleaningExecution: boolean
  canConfigureInspection: boolean
}): WebTaskExecutionSemantics {
  if (params.source === 'work' || params.source === 'offline') return 'work_task'
  if (params.isPasswordOnly) return 'key_or_password_action'
  if (params.deferredInspection) return 'inspection_execution'
  if (params.pureCheckin) return 'checkin_inspection'
  if (params.isCleaningExecution && params.canConfigureInspection) return 'mixed_cleaning_inspection'
  return 'cleaning_execution'
}

function displayScopeFor(semantics: WebTaskExecutionSemantics): WebTaskDisplayScope {
  if (semantics === 'key_or_password_action') return { key: semantics, label: '仅改密码/挂钥匙', tone: 'special' }
  if (semantics === 'checkin_inspection') return { key: semantics, label: '入住现场执行', tone: 'info' }
  if (semantics === 'inspection_execution') return { key: semantics, label: '检查执行', tone: 'info' }
  if (semantics === 'mixed_cleaning_inspection') return { key: semantics, label: '清洁 + 检查', tone: 'normal' }
  if (semantics === 'work_task') return { key: semantics, label: '线下任务', tone: 'special' }
  return { key: semantics, label: '清洁执行', tone: 'normal' }
}

export function buildWebTaskCapabilityPayload(task: Record<string, any>, context: WebTaskCapabilityContext): WebTaskCapabilityPayload {
  const source = sourceOf(task)
  const status = normalizeStatus(task.status)
  const meta = statusMeta(status)
  const taskType = taskTypeOf(task)
  const inspectionMode = normalizeInspectionMode(task.inspection_mode)
  const inspectionScope = normalizeInspectionScope(task.inspection_scope)
  const pureCheckin = source === 'cleaning' && isPureCheckinTask(task)
  const stayover = source === 'cleaning' && isStayoverTask(task)
  const isPasswordOnly = pureCheckin && inspectionScope === 'password_only'
  const deferredInspection = task.deferred_inspection_view === true || taskType === 'deferred_inspection'
  const isKeysHung = status === 'keys_hung'
  const isSelfComplete = inspectionMode === 'self_complete'
  const isCheckedDone = inspectionMode === 'checked_done' || status === 'inspected'
  const taskEnded = isCompletedStatus(status) || isKeysHung || isSelfComplete || isCheckedDone
  const isCleaningExecution = source === 'cleaning' && !pureCheckin
  const requiresCleaner = source === 'cleaning' && isCleaningExecution && !stayover ? true : source === 'cleaning' && stayover
  const canConfigureInspection = source === 'cleaning' && (task.can_configure_inspection === true || taskType === 'checkout_clean' || taskType === 'checkin_clean' || taskType === 'turnover')
  const autoSyncLocked = task.auto_sync_enabled === false
  const semantics = executionSemantics({
    source,
    pureCheckin,
    isPasswordOnly,
    deferredInspection,
    isCleaningExecution,
    canConfigureInspection,
  })

  const badges: WebTaskDisplayBadge[] = []
  if (pureCheckin) badges.push({ id: 'pure_checkin_inspection', label: '入住现场执行', tone: 'info' })
  if (isPasswordOnly) badges.push({ id: 'password_only_site_action', label: '仅改密码/挂钥匙', tone: 'special' })
  if (isKeysHung) badges.push({ id: 'keys_hung', label: '已挂钥匙', tone: 'success' })
  if (isSelfComplete) badges.push({ id: 'self_complete', label: '自完成', tone: 'special' })
  if (isCheckedDone) badges.push({ id: 'checked_done', label: '已检查', tone: 'success' })
  if (taskEnded) badges.push({ id: 'task_ended', label: '任务已结束', tone: 'success' })

  const managementPayload = buildWebTaskManagementPayload({
    source,
    requiresCleaner,
    isPasswordOnly,
    canConfigureInspection,
    pureCheckin,
    deferredInspection,
    inspectionMode,
    autoSyncLocked,
  }, context)
  const cleanerId = cleanText(task.cleaner_id || (pureCheckin ? null : task.assignee_id)) || null
  const inspectorId = cleanText(task.inspector_id) || null
  const executorId = cleanText(pureCheckin ? (task.assignee_id || task.inspector_id || task.cleaner_id) : task.assignee_id) || null
  const participantSummary: WebTaskParticipantSummary = {
    primary_role: semantics === 'key_or_password_action' || semantics === 'checkin_inspection'
      ? 'executor'
      : semantics === 'inspection_execution'
      ? 'inspector'
      : semantics === 'work_task'
      ? 'assignee'
      : 'cleaner',
    primary_user_id: semantics === 'key_or_password_action' || semantics === 'checkin_inspection'
      ? executorId
      : semantics === 'inspection_execution'
      ? inspectorId
      : semantics === 'work_task'
      ? executorId
      : cleanerId,
    cleaner_id: cleanerId,
    inspector_id: inspectorId,
    executor_id: executorId,
    show_cleaner: source === 'cleaning' && semantics !== 'key_or_password_action' && semantics !== 'checkin_inspection' && semantics !== 'inspection_execution',
    show_inspector: source === 'cleaning' && semantics !== 'key_or_password_action' && semantics !== 'checkin_inspection',
    show_executor: semantics === 'key_or_password_action' || semantics === 'checkin_inspection' || semantics === 'work_task',
  }

  return {
    display_state: {
      ...meta,
      task_semantics: {
        source,
        is_cleaning_task: source === 'cleaning',
        is_work_task: source === 'work',
        is_offline_task: source === 'offline',
        is_pure_checkin: pureCheckin,
        is_cleaning_execution: isCleaningExecution,
        is_key_handover: isPasswordOnly,
        is_password_only: isPasswordOnly,
        requires_cleaner: requiresCleaner,
        can_configure_inspection: canConfigureInspection,
        is_deferred_inspection: deferredInspection,
        is_keys_hung: isKeysHung,
        is_self_complete: isSelfComplete,
        is_checked_done: isCheckedDone,
        is_task_ended: taskEnded,
        inspection_mode: source === 'cleaning' ? inspectionMode : null,
        inspection_mode_label: source === 'cleaning' ? inspectionModeLabel(inspectionMode) : null,
        inspection_scope: source === 'cleaning' ? inspectionScope : null,
        inspection_scope_label: source === 'cleaning' ? inspectionScopeLabel(inspectionScope) : null,
      },
      badges,
    },
    execution_semantics: semantics,
    display_scope: displayScopeFor(semantics),
    participant_summary: participantSummary,
    editable_fields: managementPayload.editable_fields,
    management_actions: managementPayload.management_actions,
  }
}
