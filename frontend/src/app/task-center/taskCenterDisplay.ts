type TaskCenterDisplayTask = {
  task_source?: string | null
  task_kind?: string | null
  title?: string | null
  detail?: string | null
  deferred_inspection_view?: boolean
  inspection_mode?: string | null
  checkout_task_date?: string | null
  checkout_task_dates?: string[]
}

export const TASK_CENTER_MAX_COLUMNS = 4
const TASK_CENTER_MIN_CARD_WIDTH = 320
const TASK_CENTER_SINGLE_COLUMN_WIDTH = 620
const TASK_CENTER_GRID_GAP = 8

function lower(value: string | null | undefined) {
  return String(value || '').trim().toLowerCase()
}

function uniqueText(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.map((value) => String(value || '').trim()).filter(Boolean)))
}

function formatCheckoutDate(raw: string) {
  const text = String(raw || '').trim()
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return text
  return `${Number(match[2])}月${Number(match[3])}日`
}

export function isDeferredInspectionDisplayTask(task: TaskCenterDisplayTask) {
  if (lower(task.task_source) !== 'cleaning') return false
  return task.deferred_inspection_view === true || lower(task.inspection_mode) === 'deferred'
}

export function deferredInspectionCheckoutText(task: TaskCenterDisplayTask) {
  if (!isDeferredInspectionDisplayTask(task)) return ''
  const dates = uniqueText([
    ...(Array.isArray(task.checkout_task_dates) ? task.checkout_task_dates : []),
    task.checkout_task_date,
  ])
  if (!dates.length) return ''
  return `${dates.map(formatCheckoutDate).join('、')}退房`
}

export function cleaningTaskFlowLabelText(task: TaskCenterDisplayTask) {
  if (isDeferredInspectionDisplayTask(task)) {
    const checkoutText = deferredInspectionCheckoutText(task)
    return checkoutText ? `延期检查，${checkoutText}` : '延期检查'
  }
  const kind = lower(task.task_kind)
  if (kind === 'turnover') return '退房入住'
  if (kind === 'checkout_clean') return '退房'
  if (kind === 'checkin_clean') return '入住'
  if (kind === 'stayover_clean') return '入住中清洁'
  return String(task.detail || task.title || '任务安排').trim()
}

export function resolveTaskCenterColumns(containerWidth: number) {
  const width = Number(containerWidth)
  if (!Number.isFinite(width) || width <= 0) return TASK_CENTER_MAX_COLUMNS
  if (width < TASK_CENTER_SINGLE_COLUMN_WIDTH) return 1
  const columns = Math.floor((width + TASK_CENTER_GRID_GAP) / TASK_CENTER_MIN_CARD_WIDTH)
  return Math.max(1, Math.min(TASK_CENTER_MAX_COLUMNS, columns))
}
