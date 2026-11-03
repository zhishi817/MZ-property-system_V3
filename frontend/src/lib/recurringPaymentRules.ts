import { isDueForMonth } from './recurringStartMonth'

export type RecurringLike = {
  cashflow_type?: string
  category?: string
  report_category?: string
  payment_type?: string
}

export function isRecurringIncome(r: RecurringLike): boolean {
  return String(r?.cashflow_type || 'expense') === 'income'
}

export type RecurringSnapshotState = {
  amount_mode?: string
  has_snapshot?: boolean
  snapshot_status?: string
}

export type RecurringSnapshotTemplate = RecurringLike & {
  status?: string
  amount_mode?: string
  start_month_key?: string
  frequency_months?: number
}

export type RecurringSnapshotRow = {
  status?: string
}

export function isConsumablesRecurring(r: RecurringLike): boolean {
  return String(r?.category || '') === '消耗品费' || String(r?.report_category || '') === 'consumables'
}

export function isRentDeduction(r: RecurringLike): boolean {
  return String(r?.payment_type || '') === 'rent_deduction'
}

export function isAutoPaidInRent(r: RecurringLike): boolean {
  return isConsumablesRecurring(r) && isRentDeduction(r)
}

export function shouldEnsureRecurringSnapshot(state: RecurringSnapshotState): boolean {
  if (!state.has_snapshot) return true
  return String(state.amount_mode || 'fixed') === 'percent_of_property_total_income'
    && String(state.snapshot_status || '').toLowerCase() !== 'paid'
}

export function shouldEnsureRecurringTemplateSnapshot(
  template: RecurringSnapshotTemplate,
  monthKey: string,
  snapshot?: RecurringSnapshotRow,
): boolean {
  if (String(template?.status || '') === 'paused') return false
  if (!isDueForMonth(template?.start_month_key, monthKey, template?.frequency_months)) return false
  return shouldEnsureRecurringSnapshot({
    amount_mode: template?.amount_mode,
    has_snapshot: !!snapshot,
    snapshot_status: snapshot?.status,
  })
}
