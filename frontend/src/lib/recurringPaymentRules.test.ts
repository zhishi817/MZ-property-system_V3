import { describe, expect, it } from 'vitest'
import { isAutoPaidInRent, isConsumablesRecurring, isRentDeduction } from './recurringPaymentRules'

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
})

