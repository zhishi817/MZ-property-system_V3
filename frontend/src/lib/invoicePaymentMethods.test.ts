import { describe, expect, it } from 'vitest'
import { invoicePaymentMethodOptions } from './invoicePaymentMethods'

describe('invoicePaymentMethodOptions', () => {
  it('provides the payment methods used by invoice editing and quick payment', () => {
    expect(invoicePaymentMethodOptions.map((option) => option.value)).toEqual([
      'bank_transfer',
      'bpay',
      'payid',
      'cash',
      'rent_deduction',
      'other',
    ])
  })
})
