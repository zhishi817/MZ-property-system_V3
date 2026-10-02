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
