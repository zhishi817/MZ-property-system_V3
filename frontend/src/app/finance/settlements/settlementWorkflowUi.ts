import dayjs, { type Dayjs } from 'dayjs'
import timezone from 'dayjs/plugin/timezone'
import utc from 'dayjs/plugin/utc'

dayjs.extend(utc)
dayjs.extend(timezone)

const SETTLEMENT_TIME_ZONE = 'Australia/Melbourne'

export type SettlementStatus =
  | 'draft'
  | 'awaiting_confirmation'
  | 'confirmed'
  | 'disputed'
  | 'finance_approved'
  | 'paid'
  | 'void'

export type SettlementAction =
  | 'resolve_dispute'
  | 'return_for_confirmation'
  | 'approve'
  | 'adjust'
  | 'reopen'
  | 'confirm_paid'
  | 'void'

export type ClaimStatus = 'draft' | 'submitted' | 'approved' | 'returned' | 'rejected'
export type ClaimReviewInputMode = 'time_range' | 'quantity' | 'day' | 'amount'

export const SETTLEMENT_STATUS_META: Record<SettlementStatus, { label: string; color: string }> = {
  draft: { label: '历史草稿', color: 'default' },
  awaiting_confirmation: { label: '待合作方再次确认', color: 'warning' },
  confirmed: { label: '待财务核对', color: 'processing' },
  disputed: { label: '待重新核对', color: 'error' },
  finance_approved: { label: '财务已核对／待付款', color: 'purple' },
  paid: { label: '已付款', color: 'green' },
  void: { label: '已作废', color: 'default' },
}

export const CLAIM_STATUS_META: Record<ClaimStatus, { label: string; color: string }> = {
  draft: { label: '草稿', color: 'default' },
  submitted: { label: '待公司核对', color: 'processing' },
  approved: { label: '已确认计入', color: 'success' },
  returned: { label: '需要补充资料', color: 'warning' },
  rejected: { label: '本次不纳入结算', color: 'error' },
}

export const CLAIM_TYPE_LABELS: Record<string, string> = {
  warehouse_hour: '仓管工时',
  trial_task: '试工任务',
  trial_day: '试工天数',
  trial_hour: '试工工时',
  external_task: '编外任务',
  external_day: '编外天数',
  external_hour: '编外工时',
  subsidy_amount: '补贴',
  overtime_hour: '加班',
  new_property_task: '上新房',
  custom_amount: '其他金额',
}

export const COMPONENT_TYPE_LABELS: Record<string, string> = {
  cleaning_task: '清洁任务',
  inspection_day: '检查天数',
  weekly_fixed: '每周固定',
  ...CLAIM_TYPE_LABELS,
}

const CLAIM_REVIEW_MODE_BY_TYPE: Record<string, ClaimReviewInputMode> = {
  warehouse_hour: 'time_range',
  trial_hour: 'time_range',
  external_hour: 'time_range',
  overtime_hour: 'time_range',
  new_property_task: 'time_range',
  trial_day: 'day',
  external_day: 'day',
  subsidy_amount: 'amount',
  custom_amount: 'amount',
}

export function getClaimReviewInputMode(claimType: string): ClaimReviewInputMode {
  return CLAIM_REVIEW_MODE_BY_TYPE[claimType] || 'quantity'
}

const MANAGEMENT_ACTION_STATUSES: Record<SettlementAction, SettlementStatus[]> = {
  resolve_dispute: ['disputed'],
  return_for_confirmation: ['draft', 'confirmed'],
  approve: ['confirmed'],
  adjust: ['draft'],
  reopen: ['awaiting_confirmation', 'confirmed'],
  confirm_paid: ['finance_approved'],
  void: ['draft', 'awaiting_confirmation', 'confirmed', 'disputed', 'finance_approved'],
}

export function canUseSettlementAction(
  status: SettlementStatus,
  action: SettlementAction,
  permissions: { canManage: boolean; canPayout: boolean; canBank: boolean },
) {
  if (action === 'resolve_dispute') {
    return status === 'disputed' && (permissions.canManage || permissions.canPayout)
  }
  if (action === 'return_for_confirmation') {
    return ['draft', 'confirmed'].includes(status) && (permissions.canManage || permissions.canPayout)
  }
  if (action === 'approve') {
    return status === 'confirmed' && permissions.canPayout
  }
  const permission = action === 'confirm_paid'
    ? permissions.canPayout && permissions.canBank
    : action === 'void'
      ? permissions.canPayout
    : permissions.canManage
  return permission && MANAGEMENT_ACTION_STATUSES[action].includes(status)
}

export function settlementHasPartnerSubmission(ruleSnapshot: unknown) {
  if (!ruleSnapshot || typeof ruleSnapshot !== 'object' || Array.isArray(ruleSnapshot)) return false
  const submission = (ruleSnapshot as { partner_submission?: unknown }).partner_submission
  return Boolean(
    submission
    && typeof submission === 'object'
    && !Array.isArray(submission)
    && Object.keys(submission).length > 0,
  )
}

export function formatMoney(cents: number | null | undefined) {
  const value = Number(cents || 0) / 100
  return new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(value)
}

export function formatPersonnelDuration(minutes: number | null | undefined) {
  const roundedMinutes = Math.round(Number(minutes))
  if (!Number.isFinite(roundedMinutes) || roundedMinutes <= 0) return '-'
  const hours = Math.floor(roundedMinutes / 60)
  const remainingMinutes = roundedMinutes % 60
  if (hours > 0 && remainingMinutes > 0) return `${hours} 小时 ${remainingMinutes} 分钟`
  if (hours > 0) return `${hours} 小时`
  return `${remainingMinutes} 分钟`
}

export function mondayForDate(value: Dayjs) {
  const day = value.day()
  return value.subtract(day === 0 ? 6 : day - 1, 'day').startOf('day')
}

export function previousCompletedWeekStart(now: Dayjs = dayjs()) {
  return mondayForDate(now).subtract(7, 'day')
}

export function formatSettlementWeekRange(value: Dayjs) {
  const start = mondayForDate(value)
  return `${start.format('YYYY-MM-DD')} 至 ${start.add(6, 'day').format('YYYY-MM-DD')}`
}

export function formatDateTime(value: string | null | undefined) {
  if (!value) return '-'
  const parsed = dayjs(value)
  return parsed.isValid() ? parsed.format('YYYY-MM-DD HH:mm') : value
}

export function formatDateOnly(value: string | null | undefined) {
  if (!value) return '-'
  const parsed = dayjs(value)
  return parsed.isValid() ? parsed.format('DD/MM/YYYY') : value
}

export function formatClaimTimeRange(startedAt: string | null | undefined, endedAt: string | null | undefined) {
  if (!startedAt || !endedAt) return '-'
  const start = dayjs(startedAt).tz(SETTLEMENT_TIME_ZONE)
  const end = dayjs(endedAt).tz(SETTLEMENT_TIME_ZONE)
  if (!start.isValid() || !end.isValid()) return '-'
  return `${start.format('HH:mm')}–${end.format('HH:mm')}`
}
