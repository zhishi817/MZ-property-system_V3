import assert from 'assert'
import { buildCompanyRevenueReport } from '../../src/lib/companyRevenueReport'

const properties = [
  { id: 'p1', code: 'SH1901', landlord_id: 'l1' },
  { id: 'p2', code: 'SH1902', landlord_id: 'l2' },
]

const rules = {
  l1: [
    { effective_from_month: '2026-01', management_fee_rate: 0.1 },
    { effective_from_month: '2026-06', management_fee_rate: 0.12 },
  ],
}

function report(overrides: Partial<Parameters<typeof buildCompanyRevenueReport>[0]> = {}) {
  return buildCompanyRevenueReport({
    month: '2026-06',
    orders: [],
    properties,
    managementFeeRulesByLandlord: rules,
    companyIncomes: [],
    companyExpenses: [],
    includeDeleted: false,
    ...overrides,
  })
}

function categoryTotal(result: ReturnType<typeof report>, kind: 'income' | 'expense', category: string) {
  const rows = kind === 'income' ? result.income_categories : result.expense_categories
  return rows.find((row) => row.category === category)?.total || 0
}

function main() {
  {
    const result = report({
      orders: [{
        id: 'cross-month',
        property_id: 'p1',
        checkin: '2026-05-30',
        checkout: '2026-06-03',
        net_income: 400,
        cleaning_fee: 80,
        internal_deduction_total: 40,
        status: 'confirmed',
        count_in_income: true,
      }],
    })
    assert.equal(categoryTotal(result, 'income', 'mgmt_fee'), 21.6)
    assert.equal(categoryTotal(result, 'income', 'cleaning_fee'), 80)
    assert.equal(result.summary.total_income, 101.6)
  }

  {
    const result = report({
      orders: [
        {
          id: 'cancelled',
          property_id: 'p1',
          checkin: '2026-06-04',
          checkout: '2026-06-06',
          net_income: 200,
          cleaning_fee: 50,
          status: 'cancelled',
          count_in_income: false,
        },
        {
          id: 'forced',
          property_id: 'p1',
          checkin: '2026-06-07',
          checkout: '2026-06-09',
          net_income: 200,
          cleaning_fee: 50,
          status: 'cancelled',
          count_in_income: true,
        },
      ],
    })
    assert.equal(categoryTotal(result, 'income', 'mgmt_fee'), 24)
    assert.equal(categoryTotal(result, 'income', 'cleaning_fee'), 50)
  }

  {
    const result = report({
      orders: [
        {
          id: 'override',
          property_id: 'p1',
          checkin: '2026-06-10',
          checkout: '2026-06-12',
          net_income: 300,
          cleaning_fee: 70,
          status: 'confirmed',
        },
        {
          id: 'missing-rule',
          property_id: 'p2',
          checkin: '2026-06-11',
          checkout: '2026-06-13',
          net_income: 500,
          cleaning_fee: 60,
          status: 'confirmed',
        },
      ],
      companyIncomes: [
        {
          id: 'manual-mgmt',
          occurred_at: '2026-06-12',
          amount: 45,
          category: 'mgmt_fee',
          property_id: 'p1',
          ref_type: 'order',
          ref_id: 'override',
        },
        {
          id: 'manual-cleaning',
          occurred_at: '2026-06-12',
          amount: 75,
          category: 'cleaning_fee',
          property_id: 'p1',
          ref_type: 'order',
          ref_id: 'override',
        },
        {
          id: 'adjustment',
          occurred_at: '2026-06-15',
          amount: 10,
          category: 'mgmt_fee',
          note: '月末调整',
        },
      ],
    })
    assert.equal(categoryTotal(result, 'income', 'mgmt_fee'), 55)
    assert.equal(categoryTotal(result, 'income', 'cleaning_fee'), 135)
    assert.equal(result.income_rows.filter((row) => row.ref_id === 'override' && row.category === 'mgmt_fee').length, 1)
    assert.equal(result.warnings.length, 1)
    assert.equal(result.warnings[0].property_code, 'SH1902')
  }

  {
    const expenses = [
      {
        id: 'fixed',
        fixed_expense_id: 'fixed-1',
        month_key: '2026-06',
        occurred_at: '2026-05-01',
        amount: 100,
        category: 'office_rent',
      },
      {
        id: 'manual-month-key',
        month_key: '2026-06',
        occurred_at: '2026-05-22',
        paid_date: '2026-05-23',
        amount: 40,
        category: 'office',
      },
      {
        id: 'deleted',
        occurred_at: '2026-06-12',
        amount: 30,
        category: 'office',
        deleted_at: '2026-06-13T01:00:00Z',
      },
      {
        id: 'void',
        occurred_at: '2026-06-14',
        amount: 20,
        category: 'other',
        status: 'void',
      },
      {
        id: 'active',
        occurred_at: '2026-06-20',
        amount: 60,
        category: 'service',
      },
    ]
    const hidden = report({ companyExpenses: expenses })
    assert.equal(hidden.expense_rows.length, 2)
    assert.equal(hidden.summary.total_expense, 160)
    const visible = report({ companyExpenses: expenses, includeDeleted: true })
    assert.equal(visible.expense_rows.length, 4)
    assert.equal(visible.summary.total_expense, 160)
    assert.equal(visible.expense_rows.filter((row) => !row.is_effective).length, 2)
  }

  {
    const result = report({
      companyIncomes: [{
        id: 'income',
        occurred_at: '2026-06-01',
        amount: 250,
        category: 'other',
      }],
      companyExpenses: [{
        id: 'expense',
        occurred_at: '2026-06-02',
        amount: 80,
        category: 'service',
      }],
    })
    assert.equal(result.income_categories.reduce((sum, row) => sum + row.total, 0), result.summary.total_income)
    assert.equal(result.expense_categories.reduce((sum, row) => sum + row.total, 0), result.summary.total_expense)
    assert.equal(result.summary.net_revenue, result.summary.total_income - result.summary.total_expense)
  }

  console.log('OK test_company_revenue_report')
}

main()
