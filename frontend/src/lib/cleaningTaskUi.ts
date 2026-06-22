import dayjs from 'dayjs'

export type TaskSemanticTone = 'normal' | 'special' | 'pending' | 'danger' | 'success' | 'info' | 'neutral'

export function formatTaskTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = dayjs(String(iso))
  if (!d.isValid()) return ''
  return d.format('HH:mm')
}

export function isTaskLocked(autoSyncEnabled: boolean | null | undefined): boolean {
  return autoSyncEnabled === false
}

export type TaskInspectionMode = 'pending_decision' | 'same_day' | 'self_complete' | 'deferred'
export type TaskInspectionScope = 'inspect_and_hang' | 'password_only'

function lower(value: string | null | undefined) {
  return String(value || '').trim().toLowerCase()
}

export function normalizeInspectionScope(value: string | null | undefined): TaskInspectionScope {
  return lower(value) === 'password_only' ? 'password_only' : 'inspect_and_hang'
}

export function inspectionScopeLabel(scope: string | null | undefined): string {
  return normalizeInspectionScope(scope) === 'password_only' ? '仅改密码' : '检查后挂钥匙'
}

export function normalizeKeysHungInspectionMode(params: {
  inspectionMode: TaskInspectionMode | null | undefined
  status: string | null | undefined
  isCheckinOnly: boolean
}): TaskInspectionMode {
  const mode = params.inspectionMode || 'pending_decision'
  const status = lower(params.status)
  if (params.isCheckinOnly && status === 'keys_hung' && mode === 'self_complete') return 'same_day'
  return mode
}

export function isTaskCompletionToggleStatus(status: string | null | undefined): boolean {
  const value = lower(status)
  return value === 'ready' || value === 'done' || value === 'completed'
}

export function isCompletedTaskStatus(status: string | null | undefined): boolean {
  return isTaskCompletionToggleStatus(status)
}

export function isResolvedTaskStatus(status: string | null | undefined): boolean {
  const value = lower(status)
  return value === 'keys_hung' || isCompletedTaskStatus(value)
}

export function resolveTaskDetailCompletionStatus(params: {
  isCheckinOnly: boolean
  keysHung: boolean
  taskCompleted: boolean
}): 'keys_hung' | 'completed' | null {
  if (params.isCheckinOnly && params.keysHung) return 'keys_hung'
  if (params.taskCompleted) return 'completed'
  return null
}

export function taskStatusMeta(status: string | null | undefined): { label: string; tone: TaskSemanticTone } {
  const value = lower(status)
  if (value === 'to_inspect') return { label: '待检查', tone: 'pending' }
  if (value === 'to_hang_keys') return { label: '待挂钥匙', tone: 'pending' }
  if (value === 'to_complete') return { label: '待完成', tone: 'pending' }
  if (value === 'pending' || value === 'todo' || value === 'unassigned') return { label: '待处理', tone: 'pending' }
  if (value === 'assigned') return { label: '已分配', tone: 'normal' }
  if (value === 'in_progress') return { label: '进行中', tone: 'normal' }
  if (value === 'keys_hung') return { label: '已挂钥匙', tone: 'success' }
  if (value === 'ready') return { label: '已就绪', tone: 'success' }
  if (value === 'completed' || value === 'done') return { label: '已完成', tone: 'success' }
  if (value === 'cancelled') return { label: '已取消', tone: 'neutral' }
  return { label: value || '-', tone: 'neutral' }
}

export function taskInspectionModeMeta(mode: string | null | undefined): { label: string; tone: TaskSemanticTone } {
  const value = lower(mode)
  if (value === 'same_day') return { label: '同日检查', tone: 'normal' }
  if (value === 'self_complete') return { label: '已检查', tone: 'special' }
  if (value === 'deferred') return { label: '延后检查', tone: 'pending' }
  return { label: '待确认检查安排', tone: 'pending' }
}

export function taskInspectionScopeMeta(scope: string | null | undefined): { label: string; tone: TaskSemanticTone } {
  const normalized = normalizeInspectionScope(scope)
  return normalized === 'password_only'
    ? { label: '仅改密码', tone: 'pending' }
    : { label: '检查后挂钥匙', tone: 'success' }
}

export function taskTimingTone(label: string | null | undefined): TaskSemanticTone {
  const value = String(label || '').trim()
  if (value === '晚退房') return 'danger'
  if (value === '早退房') return 'success'
  if (value === '早入住' || value === '晚入住' || value === '入住') return 'info'
  return 'normal'
}

export function propertyFollowupKindMeta(kind: string | null | undefined): { label: string; tone: TaskSemanticTone } {
  const value = lower(kind)
  if (value === 'maintenance') return { label: '维修', tone: 'special' }
  if (value === 'deep_cleaning') return { label: '深度清洁', tone: 'special' }
  if (value === 'daily_necessities') return { label: '日用品更换', tone: 'special' }
  return { label: '房源待办', tone: 'special' }
}
