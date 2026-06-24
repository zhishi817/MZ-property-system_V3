import assert from 'assert'
import {
  buildAnnualPropertyReport,
  listAnnualReportMonthKeys,
  type AnnualReportManualMonthRow,
} from '../../src/lib/annualPropertyReport'

function buildReport(input: {
  manualRows?: AnnualReportManualMonthRow[]
  systemMonths?: Record<string, any>
  rules?: Array<{ effective_from_month: string; management_fee_rate: number }>
} = {}) {
  return buildAnnualPropertyReport({
    fiscal_year: 2026,
    property: { id: 'p1', code: 'SH1901', address: '123 Test St', landlord_id: 'l1' },
    ownerCurrent: { id: 'l1', name: 'Owner', company_name: null, email: 'owner@example.com', emails: ['owner@example.com'], phone: null },
    ownerSnapshot: { id: 'l1', name: 'Owner', company_name: null, email: 'owner@example.com', emails: ['owner@example.com'], phone: null, snapshot_mode: 'current_owner_at_generation' },
    manualRows: input.manualRows || [],
    systemMonths: input.systemMonths || {},
    managementFeeRules: (input.rules || []).map((rule, index) => ({
      id: `r${index + 1}`,
      landlord_id: 'l1',
      effective_from_month: rule.effective_from_month,
      management_fee_rate: rule.management_fee_rate,
      note: null,
    })),
  })
}

function completeManualMonth(monthKey: string, overrides: Partial<AnnualReportManualMonthRow> = {}): AnnualReportManualMonthRow {
  return {
    id: `m-${monthKey}`,
    property_id: 'p1',
    month_key: monthKey,
    fiscal_year: 2026,
    currency: 'AUD',
    rent_income: 1000,
    other_income: 0,
    management_fee: 180,
    consumables: 10,
    electricity: 20,
    gas: 30,
    water: 40,
    internet: 50,
    carpark: 60,
    council: 70,
    bodycorp: 80,
    other_expense: 90,
    note: null,
    is_complete: true,
    ...overrides,
  }
}

function main() {
  {
    assert.deepEqual(listAnnualReportMonthKeys(2026), [
      '2025-07',
      '2025-08',
      '2025-09',
      '2025-10',
      '2025-11',
      '2025-12',
      '2026-01',
      '2026-02',
      '2026-03',
      '2026-04',
      '2026-05',
      '2026-06',
    ])
  }

  {
    const report = buildReport({
      manualRows: [completeManualMonth('2025-07', { rent_income: 888 })],
      systemMonths: {
        '2025-07': { rent_income: 999, other_income: 50, expense_lines: { electricity: 20 }, has_activity: true },
      },
    })
    const month = report.months.find((row) => row.month_key === '2025-07')!
    assert.equal(month.source, 'manual')
    assert.equal(month.lines.rent_income, 888)
    assert.equal(month.status, 'complete')
  }

  {
    const report = buildReport()
    const month = report.months.find((row) => row.month_key === '2025-07')!
    assert.equal(month.source, 'manual')
    assert.equal(month.status, 'missing_manual')
    assert.equal(month.net_income, null)
  }

  {
    const report = buildReport({
      systemMonths: {
        '2026-02': { rent_income: 0, other_income: 0, expense_lines: {}, has_activity: false },
      },
    })
    const month = report.months.find((row) => row.month_key === '2026-02')!
    assert.equal(month.status, 'missing_system_data')
    assert.equal(month.income, null)
  }

  {
    const report = buildReport({
      systemMonths: {
        '2026-02': { rent_income: 1000, other_income: 0, expense_lines: { electricity: 20 }, has_activity: true },
      },
      rules: [],
    })
    const month = report.months.find((row) => row.month_key === '2026-02')!
    assert.equal(month.status, 'warning')
    assert.equal(month.lines.management_fee, null)
    assert.ok(month.warnings.some((warning) => warning.code === 'management_fee_rule_missing'))
  }

  {
    const report = buildReport({
      systemMonths: {
        '2026-02': { rent_income: 1000, other_income: 50, expense_lines: { electricity: 20 }, has_activity: true },
        '2026-03': { rent_income: 1000, other_income: 0, expense_lines: { electricity: 20 }, has_activity: true },
      },
      rules: [
        { effective_from_month: '2025-07', management_fee_rate: 0.18 },
        { effective_from_month: '2026-03', management_fee_rate: 0.2 },
      ],
    })
    const feb = report.months.find((row) => row.month_key === '2026-02')!
    const mar = report.months.find((row) => row.month_key === '2026-03')!
    assert.equal(feb.lines.management_fee, 180)
    assert.equal(mar.lines.management_fee, 200)
    assert.equal(feb.status, 'complete')
    assert.equal(mar.status, 'complete')
  }
}

main()
