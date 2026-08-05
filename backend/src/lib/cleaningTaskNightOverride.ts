export type CleaningTaskNightOverrideGuardInput = {
  order_id?: unknown
  task_type?: unknown
  type?: unknown
  source?: unknown
  auto_sync_enabled?: unknown
}

export function shouldIgnoreNightsOverrideForAutoCheckinTask(task: CleaningTaskNightOverrideGuardInput): boolean {
  const taskType = String(task?.task_type ?? task?.type ?? '').trim().toLowerCase()
  const source = String(task?.source ?? '').trim().toLowerCase()
  return !!String(task?.order_id ?? '').trim()
    && taskType === 'checkin_clean'
    && source === 'auto'
    && task?.auto_sync_enabled !== false
}
