import dayjs from 'dayjs'

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

export function normalizeKeysHungInspectionMode(params: {
  inspectionMode: TaskInspectionMode | null | undefined
  status: string | null | undefined
  isCheckinOnly: boolean
}): TaskInspectionMode {
  const mode = params.inspectionMode || 'pending_decision'
  const status = String(params.status || '').trim().toLowerCase()
  if (params.isCheckinOnly && status === 'keys_hung' && mode === 'self_complete') return 'same_day'
  return mode
}

export function isTaskCompletionToggleStatus(status: string | null | undefined): boolean {
  const value = String(status || '').trim().toLowerCase()
  return value === 'ready' || value === 'done' || value === 'completed'
}

export function isCompletedTaskStatus(status: string | null | undefined): boolean {
  return isTaskCompletionToggleStatus(status)
}

export function isResolvedTaskStatus(status: string | null | undefined): boolean {
  const value = String(status || '').trim().toLowerCase()
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
