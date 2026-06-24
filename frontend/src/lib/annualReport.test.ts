import { describe, expect, it } from 'vitest'
import {
  ANNUAL_REPORT_ROUTE,
  annualReportHasIssues,
  canDownloadAnnualReport,
  formatAnnualReportMonthStatus,
  formatAnnualReportWarningMessage,
  formatAnnualReportFilename,
  getVisibleAnnualReportExpenseLineKeys,
  getAnnualReportMissingMonths,
  getAnnualReportLineLabel,
  isAnnualReportManualMonth,
  listAnnualReportMonthKeys,
  type AnnualPropertyReport,
} from './annualReport'

const report: AnnualPropertyReport = {
  fiscal_year: 2026,
  period_start: '2025-07-01',
  period_end: '2026-06-30',
  property: { id: 'p1', code: 'SH1901', address: '123 Test St', landlord_id: 'l1' },
  owner_current: { id: 'l1', name: 'Owner', company_name: null, email: 'owner@example.com', emails: ['owner@example.com'], phone: null },
  report_owner_snapshot: { id: 'l1', name: 'Owner', company_name: null, email: 'owner@example.com', emails: ['owner@example.com'], phone: null, snapshot_mode: 'current_owner_at_generation' },
  report_status: 'draft_incomplete',
  warnings: [{ code: 'missing_system_data', message: '2026-03 缺少系统营收数据', month_key: '2026-03' }],
  months: [
    {
      month_key: '2025-07',
      source: 'manual',
      status: 'complete',
      is_complete: true,
      currency: 'AUD',
      income: 100,
      expense: 40,
      net_income: 60,
      lines: { rent_income: 100, other_income: 0, management_fee: 10, consumables: 0, electricity: 10, gas: 0, water: 10, internet: 0, carpark: 0, council: 0, bodycorp: 0, other_expense: 10 },
      note: null,
      warnings: [],
      editable: true,
      has_saved_manual_record: true,
    },
    {
      month_key: '2026-03',
      source: 'system',
      status: 'missing_system_data',
      is_complete: false,
      currency: 'AUD',
      income: null,
      expense: null,
      net_income: null,
      lines: { rent_income: null, other_income: null, management_fee: null, consumables: null, electricity: null, gas: null, water: null, internet: null, carpark: null, council: null, bodycorp: null, other_expense: null },
      note: null,
      warnings: [{ code: 'missing_system_data', message: '系统月份暂无可信营收数据', month_key: '2026-03' }],
      editable: false,
      has_saved_manual_record: false,
    },
  ],
  totals: {
    currency: 'AUD',
    income: 100,
    expense: 40,
    net_income: 60,
    lines: { rent_income: 100, other_income: 0, management_fee: 10, consumables: 0, electricity: 10, gas: 0, water: 10, internet: 0, carpark: 0, council: 0, bodycorp: 0, other_expense: 10 },
    complete_month_count: 1,
    missing_month_count: 1,
  },
}

describe('annualReport helpers', () => {
  it('lists FY2026 months exactly in July-to-June order', () => {
    expect(listAnnualReportMonthKeys(2026)).toEqual([
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
  })

  it('formats annual report filenames with FY and property code', () => {
    expect(formatAnnualReportFilename({ fiscalYear: 2026, propertyCode: 'SH1901' })).toBe('MZ_Annual_Report_SH1901_FY2026.pdf')
  })

  it('disables download without a selected property or report', () => {
    expect(canDownloadAnnualReport(null, 'p1')).toBe(false)
    expect(canDownloadAnnualReport(report, '')).toBe(false)
    expect(canDownloadAnnualReport(report, 'p1')).toBe(true)
  })

  it('surfaces missing months and draft status', () => {
    expect(annualReportHasIssues(report)).toBe(true)
    expect(getAnnualReportMissingMonths(report)).toEqual(['2026-03'])
  })

  it('keeps system months read-only while manual months stay editable', () => {
    expect(isAnnualReportManualMonth(report.months[0])).toBe(true)
    expect(isAnnualReportManualMonth(report.months[1])).toBe(false)
  })

  it('hides zero-only expense lines only when the full year is confirmed zero', () => {
    const completeReport: AnnualPropertyReport = {
      ...report,
      report_status: 'complete',
      warnings: [],
      months: [
        {
          ...report.months[0],
          month_key: '2025-07',
          is_complete: true,
          status: 'complete',
          lines: {
            ...report.months[0].lines,
            management_fee: 10,
            consumables: 0,
            electricity: 0,
            gas: 0,
            water: 0,
            internet: 0,
            carpark: 0,
            council: 0,
            bodycorp: 0,
            other_expense: 0,
          },
        },
        {
          ...report.months[0],
          month_key: '2025-08',
          is_complete: true,
          status: 'complete',
          lines: {
            ...report.months[0].lines,
            management_fee: 20,
            consumables: 0,
            electricity: 0,
            gas: 0,
            water: 0,
            internet: 0,
            carpark: 0,
            council: 0,
            bodycorp: 0,
            other_expense: 0,
          },
        },
      ],
      totals: {
        ...report.totals,
        lines: {
          ...report.totals.lines,
          management_fee: 30,
          consumables: 0,
          electricity: 0,
          gas: 0,
          water: 0,
          internet: 0,
          carpark: 0,
          council: 0,
          bodycorp: 0,
          other_expense: 0,
        },
      },
    }

    expect(getVisibleAnnualReportExpenseLineKeys(completeReport)).toEqual(['management_fee'])
    expect(getVisibleAnnualReportExpenseLineKeys(report)).toContain('consumables')
  })

  it('formats english-only line labels, warning text, and status labels', () => {
    expect(getAnnualReportLineLabel('management_fee', 'en')).toBe('Agency Fees')
    expect(formatAnnualReportMonthStatus('missing_manual', 'en')).toBe('Missing Manual')
    expect(formatAnnualReportWarningMessage({ code: 'missing_manual', month_key: '2025-07', message: 'ignored' }, 'en')).toBe('2025-07 Missing manual month summary')
  })

  it('keeps the legacy route redirected to the new annual report page', () => {
    expect(ANNUAL_REPORT_ROUTE).toBe('/finance/performance/annual')
  })
})
