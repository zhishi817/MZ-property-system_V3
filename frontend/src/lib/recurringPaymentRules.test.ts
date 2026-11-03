import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { buildStatementTxs } from './statementTx'
import {
  isAutoPaidInRent,
  isConsumablesRecurring,
  isRecurringIncome,
  isRentDeduction,
  shouldEnsureRecurringSnapshot,
  shouldEnsureRecurringTemplateSnapshot,
} from './recurringPaymentRules'

describe('recurringPaymentRules', () => {
  it('defaults legacy rows to expense and detects fixed income rows', () => {
    expect(isRecurringIncome({})).toBe(false)
    expect(isRecurringIncome({ cashflow_type: 'expense' })).toBe(false)
    expect(isRecurringIncome({ cashflow_type: 'income' })).toBe(true)
  })

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

  it('selects missing fixed expenses without regressing recurring income or referral refreshes', () => {
    const monthKey = '2026-11'
    const fixedConsumables = {
      status: 'active',
      cashflow_type: 'expense',
      amount_mode: 'fixed',
      amount: 60,
      report_category: 'consumables',
      payment_type: 'rent_deduction',
      start_month_key: '2026-01',
      frequency_months: 1,
    }
    const fixedIncome = {
      status: 'active',
      cashflow_type: 'income',
      amount_mode: 'fixed',
      amount: 850,
      start_month_key: '2026-01',
      frequency_months: 1,
    }
    const referral = {
      status: 'active',
      cashflow_type: 'expense',
      amount_mode: 'percent_of_property_total_income',
      start_month_key: '2026-01',
      frequency_months: 1,
    }

    expect(shouldEnsureRecurringTemplateSnapshot(fixedConsumables, monthKey)).toBe(true)
    expect(shouldEnsureRecurringTemplateSnapshot({ ...fixedConsumables, amount: 0 }, monthKey)).toBe(true)
    expect(shouldEnsureRecurringTemplateSnapshot(fixedIncome, monthKey)).toBe(true)
    expect(shouldEnsureRecurringTemplateSnapshot(referral, monthKey, { status: 'unpaid' })).toBe(true)
    expect(shouldEnsureRecurringTemplateSnapshot(referral, monthKey, { status: 'paid' })).toBe(false)
  })

  it('preserves activation, frequency, history and idempotency boundaries', () => {
    const base = {
      status: 'active',
      amount_mode: 'fixed',
      start_month_key: '2026-10',
      frequency_months: 2,
    }

    expect(shouldEnsureRecurringTemplateSnapshot(base, '2026-10')).toBe(true)
    expect(shouldEnsureRecurringTemplateSnapshot(base, '2026-11')).toBe(false)
    expect(shouldEnsureRecurringTemplateSnapshot(base, '2026-12')).toBe(true)
    expect(shouldEnsureRecurringTemplateSnapshot({ ...base, status: 'paused' }, '2026-12')).toBe(false)
    expect(shouldEnsureRecurringTemplateSnapshot(base, '2026-09')).toBe(false)
    expect(shouldEnsureRecurringTemplateSnapshot(base, '2026-12', { status: 'paid' })).toBe(false)
    expect(shouldEnsureRecurringTemplateSnapshot(base, '2026-12', { status: 'unpaid' })).toBe(false)
  })

  it('maps an ensured consumables snapshot into the property revenue consumables total', () => {
    const template = {
      id: 'consumables-template-1',
      property_id: 'property-1',
      report_category: 'consumables',
      vendor: 'Consumable fee',
    }
    const snapshot = {
      id: 'expense-1',
      property_id: 'property-1',
      fixed_expense_id: template.id,
      month_key: '2026-11',
      generated_from: 'recurring_payments',
      occurred_at: '2026-11-01',
      due_date: '2026-11-01',
      status: 'paid',
      amount: 60,
      currency: 'AUD',
      category: 'consumables',
    }
    const result = buildStatementTxs([], [snapshot], {
      properties: [{ id: 'property-1', code: 'TEST101' }],
      recurring_payments: [template],
      excludeOrphanFixedSnapshots: true,
    })
    const consumablesTotal = result.txs
      .filter((tx) => tx.property_id === 'property-1' && tx.report_category === 'consumables')
      .reduce((sum, tx) => sum + tx.amount, 0)

    expect(result.orphanCount).toBe(0)
    expect(consumablesTotal).toBe(60)
  })

  it('keeps the fixed-income page integration on the shared snapshot decision', () => {
    const page = fs.readFileSync(path.join(process.cwd(), 'src/app/finance/recurring/page.tsx'), 'utf8')
    expect(page).toContain("shouldEnsureRecurringTemplateSnapshot(t, monthKey, expByFixed[String(t.id)])")
    expect(page).not.toContain("return (isRecurringIncome(t) || mode === 'percent_of_property_total_income') && !hasRow")
  })
})
