import { describe, expect, it } from 'vitest'
import {
  buildCompanyRevenueCsv,
  filterCompanyRevenueRows,
  sumEffectiveCompanyRevenueRows,
  type CompanyRevenueRow,
} from './companyRevenue'

const rows: CompanyRevenueRow[] = [
  {
    id: 'income:1',
    kind: 'income',
    occurred_at: '2026-06-08',
    amount: 120,
    currency: 'AUD',
    category: 'late_checkout',
    category_label: '晚退房费',
    property_code: 'SH1901',
    source_type: 'manual_income',
    source_label: '手工记录',
    description: '延迟两小时',
    note: '客人已确认',
    editable: true,
    is_effective: true,
  },
  {
    id: 'income:2',
    kind: 'income',
    occurred_at: '2026-06-19',
    amount: 80,
    currency: 'AUD',
    category: 'other',
    category_label: '其他收入',
    source_type: 'manual_income',
    source_label: '手工记录',
    description: '补偿款',
    note: '含逗号,与引号"内容"',
    editable: true,
    is_effective: false,
  },
]

describe('company revenue filters and export', () => {
  it('filters by category, keyword and inclusive date range', () => {
    expect(filterCompanyRevenueRows(rows, {
      categories: ['late_checkout'],
      query: 'sh1901',
      dateFrom: '2026-06-08',
      dateTo: '2026-06-08',
    })).toEqual([rows[0]])

    expect(filterCompanyRevenueRows(rows, {
      categories: [],
      query: '补偿款',
      dateFrom: '2026-06-01',
      dateTo: '2026-06-30',
    })).toEqual([rows[1]])
  })

  it('sums only effective rows', () => {
    expect(sumEffectiveCompanyRevenueRows(rows)).toBe(120)
  })

  it('exports every supplied row with a UTF-8 BOM and escaped cells', () => {
    const csv = buildCompanyRevenueCsv('income', rows)
    expect(csv.startsWith('\uFEFF')).toBe(true)
    expect(csv).toContain('"日期","类别","房号","来源/说明","金额(AUD)","备注","是否有效"')
    expect(csv).toContain('"晚退房费"')
    expect(csv).toContain('"其他收入"')
    expect(csv).toContain('"含逗号,与引号""内容"""')
    expect(csv.split('\r\n')).toHaveLength(3)
  })
})
