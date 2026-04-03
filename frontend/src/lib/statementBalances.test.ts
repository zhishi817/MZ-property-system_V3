import { describe, expect, it } from 'vitest'
import { computeMonthlyStatementBalance, computeMonthlyStatementBalanceDebug } from './statementBalances'

describe('computeMonthlyStatementBalance', () => {
  it('offsets furniture outstanding across months and carries forward negative net', () => {
    const pid = 'p1'
    const orders: any[] = [
      { id: 'o-jan', property_id: pid, checkin: '2026-01-01T12:00:00', checkout: '2026-02-01T11:59:59', price: 3000, cleaning_fee: 0 },
      { id: 'o-feb', property_id: pid, checkin: '2026-02-01T12:00:00', checkout: '2026-03-01T11:59:59', price: 2000, cleaning_fee: 0 },
      { id: 'o-mar', property_id: pid, checkin: '2026-03-01T12:00:00', checkout: '2026-04-01T11:59:59', price: 4000, cleaning_fee: 0 },
      { id: 'o-may', property_id: pid, checkin: '2026-05-01T12:00:00', checkout: '2026-06-01T11:59:59', price: 300, cleaning_fee: 0 },
    ]
    const txs: any[] = [
      { id: 'fx-jan-charge', kind: 'expense', amount: 10000, currency: 'AUD', property_id: pid, occurred_at: '2026-01-05', category: 'furniture_recoverable', note: 'furniture recoverable' },
      { id: 'fx-feb-paid', kind: 'income', amount: 5000, currency: 'AUD', property_id: pid, occurred_at: '2026-02-10', category: 'furniture_owner_payment', note: 'owner paid furniture' },
      { id: 'fx-apr-exp', kind: 'expense', amount: 500, currency: 'AUD', property_id: pid, occurred_at: '2026-04-15', category: 'other', note: 'operating loss' },
    ]

    const jan = computeMonthlyStatementBalance({ month: '2026-01', propertyId: pid, orders, txs, managementFeeRate: 0 })
    expect(jan.operating_net_income).toBe(3000)
    expect(jan.furniture_charge).toBe(10000)
    expect(jan.furniture_owner_paid).toBe(0)
    expect(jan.furniture_offset_from_rent).toBe(3000)
    expect(jan.furniture_closing_outstanding).toBe(7000)
    expect(jan.payable_to_owner).toBe(0)
    expect(jan.closing_carry_net).toBe(0)

    const feb = computeMonthlyStatementBalance({ month: '2026-02', propertyId: pid, orders, txs, managementFeeRate: 0 })
    expect(feb.operating_net_income).toBe(2000)
    expect(feb.furniture_opening_outstanding).toBe(7000)
    expect(feb.furniture_owner_paid).toBe(5000)
    expect(feb.furniture_offset_from_rent).toBe(2000)
    expect(feb.furniture_closing_outstanding).toBe(0)
    expect(feb.payable_to_owner).toBe(0)

    const mar = computeMonthlyStatementBalance({ month: '2026-03', propertyId: pid, orders, txs, managementFeeRate: 0 })
    expect(mar.operating_net_income).toBe(4000)
    expect(mar.furniture_opening_outstanding).toBe(0)
    expect(mar.payable_to_owner).toBe(4000)

    const apr = computeMonthlyStatementBalance({ month: '2026-04', propertyId: pid, orders, txs, managementFeeRate: 0 })
    expect(apr.operating_net_income).toBe(-500)
    expect(apr.opening_carry_net).toBe(0)
    expect(apr.closing_carry_net).toBe(-500)
    expect(apr.payable_to_owner).toBe(0)

    const may = computeMonthlyStatementBalance({ month: '2026-05', propertyId: pid, orders, txs, managementFeeRate: 0 })
    expect(may.operating_net_income).toBe(300)
    expect(may.opening_carry_net).toBe(-500)
    expect(may.closing_carry_net).toBe(-200)
    expect(may.payable_to_owner).toBe(0)
  })

  it('returns month-by-month diagnostics that match the final monthly result', () => {
    const pid = 'p1'
    const orders: any[] = [
      { id: 'o-jan', property_id: pid, checkin: '2026-01-01T12:00:00', checkout: '2026-02-01T11:59:59', price: 3000, cleaning_fee: 0 },
      { id: 'o-feb', property_id: pid, checkin: '2026-02-01T12:00:00', checkout: '2026-03-01T11:59:59', price: 2000, cleaning_fee: 0 },
      { id: 'o-mar', property_id: pid, checkin: '2026-03-01T12:00:00', checkout: '2026-04-01T11:59:59', price: 4000, cleaning_fee: 0 },
      { id: 'o-may', property_id: pid, checkin: '2026-05-01T12:00:00', checkout: '2026-06-01T11:59:59', price: 300, cleaning_fee: 0 },
    ]
    const txs: any[] = [
      { id: 'fx-jan-charge', kind: 'expense', amount: 10000, currency: 'AUD', property_id: pid, occurred_at: '2026-01-05', category: 'furniture_recoverable', note: 'furniture recoverable' },
      { id: 'fx-feb-paid', kind: 'income', amount: 5000, currency: 'AUD', property_id: pid, occurred_at: '2026-02-10', category: 'furniture_owner_payment', note: 'owner paid furniture' },
      { id: 'fx-apr-exp', kind: 'expense', amount: 500, currency: 'AUD', property_id: pid, occurred_at: '2026-04-15', category: 'other', note: 'operating loss' },
    ]

    const base = computeMonthlyStatementBalance({ month: '2026-05', propertyId: pid, orders, txs, managementFeeRate: 0 })
    const debug = computeMonthlyStatementBalanceDebug({ month: '2026-05', propertyId: pid, orders, txs, managementFeeRate: 0 })

    expect(debug.result).toEqual(base)
    expect(debug.target.month).toBe('2026-05')
    expect(debug.target.opening_carry_net).toBe(-500)
    expect(debug.target.closing_carry_net).toBe(-200)
    expect(debug.target.carry_source_kind).toBe('prior_operating_loss')
    expect(debug.summary.hasCarry).toBe(true)
    expect(debug.summary.carrySourceKind).toBe('prior_operating_loss')
    expect(debug.months.map(x => x.month)).toEqual(['2026-01', '2026-02', '2026-03', '2026-04', '2026-05'])
    const apr = debug.months.find(x => x.month === '2026-04')
    expect(apr?.negative_carry_trigger?.id).toBe('fx-apr-exp')
    expect(apr?.contributing_expense_tx_ids).toContain('fx-apr-exp')
  })

  it('distinguishes furniture offset from carry-over when carry stays at zero', () => {
    const pid = 'p2'
    const orders: any[] = [
      { id: 'o-jan', property_id: pid, checkin: '2026-01-01T12:00:00', checkout: '2026-02-01T11:59:59', price: 1200, cleaning_fee: 0 },
    ]
    const txs: any[] = [
      { id: 'fx-jan-charge', kind: 'expense', amount: 800, currency: 'AUD', property_id: pid, occurred_at: '2026-01-05', category: 'furniture_recoverable', note: 'furniture recoverable' },
    ]

    const jan = computeMonthlyStatementBalanceDebug({ month: '2026-01', propertyId: pid, orders, txs, managementFeeRate: 0 })

    expect(jan.result.opening_carry_net).toBe(0)
    expect(jan.result.closing_carry_net).toBe(0)
    expect(jan.result.furniture_offset_from_rent).toBe(800)
    expect(jan.result.payable_before_furniture).toBe(1200)
    expect(jan.result.payable_to_owner).toBe(400)
    expect(jan.summary.hasCarry).toBe(false)
    expect(jan.summary.hasFurniture).toBe(true)
    expect(jan.summary.carrySourceKind).toBe('none')
  })

  it('ignores carry-over before the configured carry start month', () => {
    const pid = 'p3'
    const orders: any[] = [
      { id: 'o-jan', property_id: pid, checkin: '2026-01-01T12:00:00', checkout: '2026-02-01T11:59:59', price: 3000, cleaning_fee: 0 },
      { id: 'o-mar', property_id: pid, checkin: '2026-03-01T12:00:00', checkout: '2026-04-01T11:59:59', price: 2000, cleaning_fee: 0 },
    ]
    const txs: any[] = [
      { id: 'hist-dec-exp', kind: 'expense', amount: 800, currency: 'AUD', property_id: pid, occurred_at: '2025-12-28', category: 'other', note: 'legacy expense' },
    ]

    const mar = computeMonthlyStatementBalanceDebug({
      month: '2026-03',
      propertyId: pid,
      orders,
      txs,
      managementFeeRate: 0,
      carryStartMonth: '2026-01',
    })

    expect(mar.result.opening_carry_net).toBe(0)
    expect(mar.result.closing_carry_net).toBe(0)
    expect(mar.summary.hasCarry).toBe(false)
    expect(mar.months.some(x => x.month === '2025-12')).toBe(false)
  })
})
