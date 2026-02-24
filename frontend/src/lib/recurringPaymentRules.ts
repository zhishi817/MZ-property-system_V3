export type RecurringLike = {
  category?: string
  report_category?: string
  payment_type?: string
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

