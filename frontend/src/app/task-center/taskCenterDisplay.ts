type TaskCenterDisplayTask = {
  task_source?: string | null
  task_kind?: string | null
  title?: string | null
  detail?: string | null
  deferred_inspection_view?: boolean
  inspection_mode?: string | null
}

function lower(value: string | null | undefined) {
  return String(value || '').trim().toLowerCase()
}

export function isDeferredInspectionDisplayTask(task: TaskCenterDisplayTask) {
  if (lower(task.task_source) !== 'cleaning') return false
  return task.deferred_inspection_view === true || lower(task.inspection_mode) === 'deferred'
}

export function cleaningTaskFlowLabelText(task: TaskCenterDisplayTask) {
  if (isDeferredInspectionDisplayTask(task)) return '延期检查'
  const kind = lower(task.task_kind)
  if (kind === 'turnover') return '退房入住'
  if (kind === 'checkout_clean') return '退房'
  if (kind === 'checkin_clean') return '入住'
  if (kind === 'stayover_clean') return '入住中清洁'
  return String(task.detail || task.title || '任务安排').trim()
}
