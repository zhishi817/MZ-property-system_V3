type TaskCenterDisplayTask = {
  task_source?: string | null
  task_kind?: string | null
  title?: string | null
  detail?: string | null
  assignee_id?: string | null
  cleaner_id?: string | null
  inspector_id?: string | null
  deferred_checkin_conflict?: boolean
  deferred_inspection_view?: boolean
  inspection_mode?: string | null
  inspection_due_date?: string | null
  conflict_checkin_task_date?: string | null
  conflict_checkin_time?: string | null
  checkout_task_date?: string | null
  checkout_task_dates?: string[]
}

type TaskCenterNightsDisplayTask = TaskCenterDisplayTask & {
  task_ids?: string[]
  nights?: number | null
  turnover_display?: {
    stayed_nights?: number | null
    remaining_nights?: number | null
  } | null
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

export function deferredInspectionConflictPresentation(task: TaskCenterDisplayTask) {
  if (task.deferred_checkin_conflict !== true) return null
  const checkinDate = String(task.conflict_checkin_task_date || '').trim() || '-'
  const checkinTime = String(task.conflict_checkin_time || '').trim()
  return {
    key: 'deferred-checkin-conflict',
    label: '入住冲突',
    tone: 'danger' as const,
    detail: `原定检查 ${String(task.inspection_due_date || '').trim() || '-'}；入住 ${checkinDate}${checkinTime ? ` ${checkinTime}` : ''}`,
  }
}

function positiveNights(value: number | null | undefined) {
  const nights = Number(value)
  if (!Number.isFinite(nights) || nights <= 0) return null
  return Math.trunc(nights)
}

function showsCheckin(task: TaskCenterNightsDisplayTask) {
  const kind = lower(task.task_kind)
  if (kind === 'turnover' || kind === 'checkin_clean') return true
  if (kind === 'checkout_clean' || kind === 'stayover_clean') return false
  const text = `${String(task.title || '')} ${String(task.detail || '')}`
  if ((task.task_ids || []).length > 1) return true
  return text.includes('入住')
}

export function cleaningNightsDisplayLabels(task: TaskCenterNightsDisplayTask) {
  if (lower(task.task_source) !== 'cleaning' || task.deferred_inspection_view || !showsCheckin(task)) return []
  const kind = lower(task.task_kind)
  const display = task.turnover_display
  const remainingNights = positiveNights(display?.remaining_nights ?? task.nights)
  if (kind !== 'turnover') return remainingNights == null ? [] : [`住${remainingNights}晚`]

  const labels: string[] = []
  const stayedNights = positiveNights(display?.stayed_nights)
  if (stayedNights != null) labels.push(`已住 ${stayedNights}晚`)
  if (remainingNights != null) labels.push(`待住 ${remainingNights}晚`)
  return labels
}

export function taskCenterInspectionAssignmentPatch(params: {
  isPureCheckin: boolean
  inspectorId: string | null | undefined
}): {
  assignee_id?: string | null
  cleaner_id?: string | null
  inspector_id: string | null
  inspection_mode: 'same_day' | 'pending_decision'
} {
  const inspectorId = String(params.inspectorId || '').trim() || null
  const inspectionMode = inspectorId ? 'same_day' as const : 'pending_decision' as const
  if (params.isPureCheckin) {
    return {
      assignee_id: inspectorId,
      cleaner_id: null,
      inspector_id: null,
      inspection_mode: inspectionMode,
    }
  }
  return {
    inspector_id: inspectorId,
    inspection_mode: inspectionMode,
  }
}

export function hasTaskCenterRequiredExecutor(task: TaskCenterDisplayTask) {
  if (lower(task.task_source) !== 'cleaning') return Boolean(String(task.assignee_id || '').trim())
  if (lower(task.task_kind) === 'checkin_clean') {
    return Boolean(String(task.assignee_id || task.inspector_id || task.cleaner_id || '').trim())
  }
  return Boolean(String(task.cleaner_id || task.assignee_id || '').trim())
}

export function maintenanceDetailContentText(value: unknown) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed === 'string') return parsed.trim()
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const key of ['content', 'description', 'detail', 'message', 'note']) {
        const candidate = (parsed as Record<string, unknown>)[key]
        if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
      }
    }
  } catch {
    // Historical maintenance details are often plain text; preserve them unchanged.
  }
  return raw
}

export function resolveTaskCenterColumns(containerWidth: number) {
  const width = Number(containerWidth)
  if (!Number.isFinite(width) || width <= 0) return TASK_CENTER_MAX_COLUMNS
  if (width < TASK_CENTER_SINGLE_COLUMN_WIDTH) return 1
  const columns = Math.floor((width + TASK_CENTER_GRID_GAP) / TASK_CENTER_MIN_CARD_WIDTH)
  return Math.max(1, Math.min(TASK_CENTER_MAX_COLUMNS, columns))
}
