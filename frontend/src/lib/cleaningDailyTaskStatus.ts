import { type TaskSemanticTone, taskStatusMeta } from './cleaningTaskUi'

export type CleaningDailyDisplayState = {
  status_key?: string | null
  status_label?: string | null
  status_tone?: TaskSemanticTone | null
  badges?: CleaningDailyDisplayBadge[] | null
}

export type CleaningDailyDisplayBadge = {
  id?: string | null
  label?: string | null
  tone?: TaskSemanticTone | null
}

export type CleaningDailyStatusItem = {
  status?: string | null
  display_state?: CleaningDailyDisplayState | null
}

export type CleaningDailyCapabilityGate = {
  enabled?: boolean | null
  disabled_reason?: string | null
}

const DAILY_STATUS_RANK: Record<string, number> = {
  cancelled: 0,
  canceled: 0,
  pending: 10,
  todo: 10,
  unassigned: 10,
  assigned: 20,
  in_progress: 30,
  cleaning: 30,
  to_complete: 40,
  to_inspect: 50,
  restock_pending: 55,
  to_hang_keys: 60,
  ready: 70,
  cleaned: 70,
  restocked: 70,
  inspected: 70,
  completed: 70,
  done: 70,
  keys_hung: 80,
}

function cleanStatus(value: unknown) {
  return String(value || '').trim().toLowerCase()
}

function statusKeyOf(item: CleaningDailyStatusItem) {
  return cleanStatus(item.display_state?.status_key) || cleanStatus(item.status) || 'pending'
}

function rankOf(status: string) {
  return DAILY_STATUS_RANK[status] ?? 15
}

export function dailyTaskStatusMeta(
  status: string | null | undefined,
  displayState?: CleaningDailyDisplayState | null,
): { label: string; tone: TaskSemanticTone } {
  const key = cleanStatus(displayState?.status_key) || cleanStatus(status)
  if (key === 'pending' || key === 'todo' || key === 'unassigned') return { label: '未分配', tone: 'pending' }
  if (key === 'cleaning') return { label: '进行中', tone: 'normal' }
  if (key === 'cleaned') return { label: '已清洁', tone: 'success' }
  if (key === 'restock_pending') return { label: '待补品', tone: 'pending' }
  if (key === 'restocked') return { label: '已补品', tone: 'success' }
  if (key === 'inspected') return { label: '已检查', tone: 'success' }

  const label = String(displayState?.status_label || '').trim()
  const tone = displayState?.status_tone || null
  if (label && tone) return { label, tone }
  return taskStatusMeta(key || status)
}

export function mergedDailyTaskStatus(items: CleaningDailyStatusItem[]): string {
  const keys = items.map(statusKeyOf).filter(Boolean)
  if (!keys.length) return 'pending'
  if (keys.every((key) => key === 'cancelled' || key === 'canceled')) return keys[0]
  return keys
    .filter((key) => key !== 'cancelled' && key !== 'canceled')
    .sort((a, b) => rankOf(b) - rankOf(a))[0] || 'pending'
}

export function mergedDailyDisplayStatus(items: CleaningDailyStatusItem[]): {
  status_key: string
  status_label: string
  status_tone: TaskSemanticTone
} {
  const status = mergedDailyTaskStatus(items)
  const source = items.find((item) => statusKeyOf(item) === status)
  const meta = dailyTaskStatusMeta(status, source?.display_state)
  return {
    status_key: status,
    status_label: meta.label,
    status_tone: meta.tone,
  }
}

function isPureCheckinBadge(id: string, label: string) {
  return id === 'pure_checkin_inspection' || label === '纯入住检查' || label === '入住现场执行'
}

function normalizeTaskExecutionSemantics(value: string | null | undefined) {
  const raw = String(value || '').trim()
  return raw === 'key_handover_execution' ? 'key_or_password_action' : raw
}

export function mergedDailyDisplayBadges(
  items: CleaningDailyStatusItem[],
  semantics: string | null | undefined,
): Array<{ id: string; label: string; tone: TaskSemanticTone }> {
  const normalizedSemantics = normalizeTaskExecutionSemantics(semantics)
  const allowPureCheckinBadge = normalizedSemantics === 'checkin_inspection' || normalizedSemantics === 'key_or_password_action'
  const badgeMap = new Map<string, { id: string; label: string; tone: TaskSemanticTone }>()

  for (const item of items) {
    const badges = Array.isArray(item.display_state?.badges) ? item.display_state.badges : []
    for (const badge of badges) {
      const id = String(badge?.id || '').trim()
      const label = String(badge?.label || '').trim()
      if (!label) continue
      if (!allowPureCheckinBadge && isPureCheckinBadge(id, label)) continue
      const key = id || label
      if (!badgeMap.has(key)) {
        badgeMap.set(key, { id: key, label, tone: badge?.tone || 'normal' })
      }
    }
  }

  return Array.from(badgeMap.values())
}

export function visibleDailyDisplayBadges<T extends { label?: string | null }>(
  badges: T[],
  hiddenLabels: Array<string | null | undefined>,
): T[] {
  const hidden = new Set(hiddenLabels.map((label) => String(label || '').trim()).filter(Boolean))
  return badges.filter((badge) => {
    const label = String(badge?.label || '').trim()
    return label && !hidden.has(label)
  })
}

function timeMinutes(raw: string | null | undefined): number | null {
  const value = String(raw || '').trim().toLowerCase()
  if (!value) return null
  const match = value.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/)
  if (!match) return null
  let hour = Number(match[1] || 0)
  const minute = Number(match[2] || 0)
  const meridiem = String(match[3] || '').trim()
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null
  if (meridiem === 'am') {
    if (hour === 12) hour = 0
  } else if (meridiem === 'pm') {
    if (hour < 12) hour += 12
  }
  return hour * 60 + minute
}

export function checkoutTimingLabel(raw: string | null | undefined): '早退房' | '晚退房' | null {
  const minutes = timeMinutes(raw)
  if (minutes == null || minutes === 10 * 60) return null
  return minutes < 10 * 60 ? '早退房' : '晚退房'
}

export function checkinTimingLabel(raw: string | null | undefined): '早入住' | '晚入住' | null {
  const minutes = timeMinutes(raw)
  if (minutes == null || minutes === 15 * 60) return null
  return minutes < 15 * 60 ? '早入住' : '晚入住'
}

export function mergeDailyCapabilityGate(gates: Array<CleaningDailyCapabilityGate | null | undefined>): {
  enabled: boolean
  disabled_reason?: string
} {
  const present = gates.filter(Boolean) as CleaningDailyCapabilityGate[]
  if (!present.length) return { enabled: true }

  const applicable = present.filter((gate) => gate.enabled !== false || String(gate.disabled_reason || '').trim() !== 'not_applicable')
  if (!applicable.length) return { enabled: false, disabled_reason: 'not_applicable' }

  const blocked = applicable.find((gate) => gate.enabled === false)
  if (blocked) return { enabled: false, disabled_reason: String(blocked.disabled_reason || '').trim() || 'not_applicable' }

  return { enabled: true }
}
