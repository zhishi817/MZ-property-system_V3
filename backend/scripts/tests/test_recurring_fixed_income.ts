import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import {
  buildRecurringIncomeReferenceId,
  buildRecurringIncomeTransactionPayload,
  isRecurringIncomeTemplate,
} from '../../src/modules/recurring'

function main() {
  assert.equal(isRecurringIncomeTemplate({}), false)
  assert.equal(isRecurringIncomeTemplate({ cashflow_type: 'expense' }), false)
  assert.equal(isRecurringIncomeTemplate({ cashflow_type: 'income' }), true)
  assert.equal(buildRecurringIncomeReferenceId('income-1', '2026-09'), 'income-1:2026-09')

  const payload = buildRecurringIncomeTransactionPayload({
    id: 'tx-1',
    payment: {
      id: 'income-1',
      cashflow_type: 'income',
      property_id: 'property-1',
      amount: 850,
      vendor: '仓库租赁',
      category_detail: '仓库租赁收入',
    },
    monthKey: '2026-09',
    occurredAt: '2026-09-15',
    status: 'unreceived',
  })
  assert.deepEqual(payload, {
    id: 'tx-1',
    kind: 'income',
    amount: 850,
    currency: 'AUD',
    ref_type: 'recurring_income',
    ref_id: 'income-1:2026-09',
    occurred_at: '2026-09-15',
    note: 'Recurring income',
    category: 'other',
    category_detail: '仓库租赁收入',
    property_id: 'property-1',
    recurring_payment_id: 'income-1',
    month_key: '2026-09',
    due_date: '2026-09-15',
    received_at: null,
    status: 'unreceived',
  })

  const backendRoot = path.resolve(__dirname, '../..')
  const recurringSource = fs.readFileSync(path.join(backendRoot, 'src/modules/recurring.ts'), 'utf8')
  const annualReportSource = fs.readFileSync(path.join(backendRoot, 'src/lib/annualPropertyReport.ts'), 'utf8')
  const migrationSource = fs.readFileSync(path.join(backendRoot, 'scripts/migrations/20260922_recurring_fixed_income.sql'), 'utf8')
  const monthlyStatementSource = fs.readFileSync(path.resolve(backendRoot, '../frontend/src/components/MonthlyStatement.tsx'), 'utf8')

  assert.match(recurringSource, /cashflow_type:[\s\S]*?expense[\s\S]*?income/)
  assert.match(recurringSource, /INSERT INTO finance_transactions[\s\S]*?ON CONFLICT \(recurring_payment_id, month_key\)/)
  assert.match(recurringSource, /'finance_transactions' AS expense_resource/)
  assert.match(recurringSource, /mark_received/)
  assert.match(recurringSource, /unmark_received/)
  const historyLimitGuard = recurringSource.indexOf('if (recurringIncomeDueMonths.length > 240)')
  const recurringTemplateUpdate = recurringSource.indexOf('const sql = `UPDATE recurring_payments SET')
  assert.ok(historyLimitGuard >= 0 && recurringTemplateUpdate >= 0 && historyLimitGuard < recurringTemplateUpdate, 'income history limit must be rejected before the recurring template UPDATE can persist')
  assert.doesNotMatch(recurringSource, /ALTER TABLE recurring_payments ADD COLUMN IF NOT EXISTS cashflow_type/, 'request-time recurring initialization must not own fixed-income schema changes')
  assert.match(annualReportSource, /FROM finance_transactions[\s\S]*?WHERE kind = 'income'/)
  assert.match(annualReportSource, /other_income = round2\(systemMonth\.other_income \+ Number\(row\.amount \|\| 0\)\)/)
  assert.match(monthlyStatementSource, /otherIncomeTx = txs\.filter[\s\S]*?t\.kind !== 'income'/)
  assert.match(monthlyStatementSource, /v === 'other'[\s\S]*?tx\.category_detail/)
  assert.match(migrationSource, /ADD COLUMN IF NOT EXISTS cashflow_type/)
  assert.match(migrationSource, /uniq_finance_transactions_recurring_income_month/)
  assert.match(migrationSource, /INSERT INTO schema_migrations/)
}

main()
