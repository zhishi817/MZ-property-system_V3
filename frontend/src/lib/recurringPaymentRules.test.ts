import { describe, expect, it } from 'vitest'
import { isAutoPaidInRent, isConsumablesRecurring, isRentDeduction, shouldEnsureRecurringSnapshot } from './recurringPaymentRules'

describe('recurringPaymentRules', () => {
  it('detects consumables by category or report_category', () => {
    expect(isConsumablesRecurring({ category: '消耗品费' })).toBe(true)
    expect(isConsumablesRecurring({ report_category: 'consumables' })).toBe(true)
    expect(isConsumablesRecurring({ category: '其他' })).toBe(false)
  })

  it('detects rent deduction', () => {
    expect(isRentDeduction({ payment_type: 'rent_deduction' })).toBe(true)
    expect(isRentDeduction({ payment_type: 'bank_account' })).toBe(false)
  })

  it('treats consumables rent_deduction as auto-paid', () => {
    expect(isAutoPaidInRent({ category: '消耗品费', payment_type: 'rent_deduction' })).toBe(true)
    expect(isAutoPaidInRent({ report_category: 'consumables', payment_type: 'rent_deduction' })).toBe(true)
    expect(isAutoPaidInRent({ category: '消耗品费', payment_type: 'bank_account' })).toBe(false)
  })

  it('creates missing snapshots for every due template and only refreshes unpaid percentage templates', () => {
    const zeroAmountFixedTemplate = { amount: 0, amount_mode: 'fixed', has_snapshot: false }
    expect(shouldEnsureRecurringSnapshot(zeroAmountFixedTemplate)).toBe(true)
    expect(shouldEnsureRecurringSnapshot({ amount_mode: 'fixed', has_snapshot: true, snapshot_status: 'paid' })).toBe(false)
    expect(shouldEnsureRecurringSnapshot({ amount_mode: 'fixed', has_snapshot: true, snapshot_status: 'unpaid' })).toBe(false)
    expect(shouldEnsureRecurringSnapshot({ amount_mode: 'percent_of_property_total_income', has_snapshot: false })).toBe(true)
    expect(shouldEnsureRecurringSnapshot({ amount_mode: 'percent_of_property_total_income', has_snapshot: true, snapshot_status: 'unpaid' })).toBe(true)
    expect(shouldEnsureRecurringSnapshot({ amount_mode: 'percent_of_property_total_income', has_snapshot: true, snapshot_status: 'paid' })).toBe(false)
  })
})
