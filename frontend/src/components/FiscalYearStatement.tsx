"use client"
import { forwardRef } from 'react'
import {
  annualReportHasIssues,
  formatAnnualReportMoney,
  formatAnnualReportMonthStatus,
  formatAnnualReportWarningMessage,
  getAnnualReportLineLabel,
  getVisibleAnnualReportExpenseLineKeys,
  type AnnualReportLanguage,
  type AnnualPropertyReport,
  type AnnualReportLineKey,
} from '../lib/annualReport'

const DISPLAY_ROWS: AnnualReportLineKey[] = [
  'rent_income',
  'other_income',
  'management_fee',
  'consumables',
  'electricity',
  'gas',
  'water',
  'internet',
  'carpark',
  'council',
  'bodycorp',
  'other_expense',
]

function monthLabel(monthKey: string) {
  const [, month] = String(monthKey || '').split('-')
  return (
    {
      '07': 'Jul',
      '08': 'Aug',
      '09': 'Sep',
      '10': 'Oct',
      '11': 'Nov',
      '12': 'Dec',
      '01': 'Jan',
      '02': 'Feb',
      '03': 'Mar',
      '04': 'Apr',
      '05': 'May',
      '06': 'Jun',
    }[month || ''] || monthKey
  )
}

function formatAustralianDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''))
  return match ? `${match[3]}/${match[2]}/${match[1]}` : value
}

export default forwardRef<HTMLDivElement, {
  report: AnnualPropertyReport
  showChinese?: boolean
}>(function FiscalYearStatement({ report, showChinese = true }, ref) {
  const language: AnnualReportLanguage = showChinese ? 'bilingual' : 'en'
  const isDraft = annualReportHasIssues(report)
  const owner = report.report_owner_snapshot || report.owner_current
  const ownerName = owner?.name || owner?.company_name || '-'
  const propertyCode = report.property.code || '-'
  const propertyAddress = report.property.address || '-'
  const visibleExpenseRows = getVisibleAnnualReportExpenseLineKeys(report)

  return (
    <div ref={ref as any} data-fy-statement-root="1" style={{ padding: 16, fontFamily: 'StatementFont, serif' }}>
      <style>{`
        @font-face {
          font-family: 'StatementFont';
          src: local('Times New Roman'), local('Times');
          font-weight: 400;
          unicode-range: U+0000-00FF, U+0100-024F, U+1E00-1EFF;
        }
        @font-face {
          font-family: 'StatementFont';
          src: local('PingFang SC'), local('PingFangSC-Regular'), local('Noto Sans CJK SC'), local('Noto Sans SC'), local('Microsoft YaHei');
          font-weight: 400;
          unicode-range: U+3000-303F, U+3400-4DBF, U+4E00-9FFF, U+F900-FAFF, U+FF00-FFEF;
        }
        @font-face {
          font-family: 'StatementFont';
          src: local('Times New Roman Bold'), local('TimesNewRomanPS-BoldMT'), local('Times Bold');
          font-weight: 700;
          unicode-range: U+0000-00FF, U+0100-024F, U+1E00-1EFF;
        }
        @font-face {
          font-family: 'StatementFont';
          src: local('PingFang SC Semibold'), local('PingFangSC-Semibold'), local('PingFang SC Medium'), local('PingFangSC-Medium'), local('Noto Sans CJK SC'), local('Noto Sans SC'), local('Microsoft YaHei');
          font-weight: 700;
          unicode-range: U+3000-303F, U+3400-4DBF, U+4E00-9FFF, U+F900-FAFF, U+FF00-FFEF;
        }
        [data-fy-statement-root="1"] table { width: 100%; border-collapse: collapse; }
        [data-fy-statement-root="1"] table tr > * { border-bottom: 1px solid #ddd; vertical-align: top; }
        [data-fy-statement-root="1"].__pdf_capture_root__,
        .__pdf_capture_root__ [data-fy-statement-root="1"] {
          min-height: 188.7mm;
          box-sizing: border-box;
          display: flex !important;
          flex-direction: column !important;
        }
        [data-fy-statement-root="1"].__pdf_capture_root__ [data-fy-report-footer="1"],
        .__pdf_capture_root__ [data-fy-statement-root="1"] [data-fy-report-footer="1"] {
          margin-top: auto !important;
          padding-top: 24px;
        }
        @media print {
          @page { size: A4 landscape; margin: 12mm; }
          html, body { margin: 0; padding: 0; font-family: StatementFont, serif; -webkit-font-smoothing: antialiased; text-rendering: geometricPrecision; }
        }
      `}</style>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr 1fr', alignItems: 'center', columnGap: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <img src="/mz-logo.png" alt="Company Logo" style={{ height: 70 }} />
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: showChinese ? 26 : 28, fontWeight: 700, letterSpacing: showChinese ? 0 : 1, whiteSpace: 'nowrap' }}>
            {showChinese ? 'ANNUAL PROPERTY REPORT 房源年度报告' : 'ANNUAL PROPERTY REPORT'}
          </div>
          <div style={{ fontSize: 14, marginTop: 6 }}>
            {showChinese
              ? `FY${report.fiscal_year} 财年：${report.period_start} 至 ${report.period_end}`
              : `FY${report.fiscal_year}: ${formatAustralianDate(report.period_start)} to ${formatAustralianDate(report.period_end)}`}
          </div>
          {isDraft ? (
            <div style={{ marginTop: 8, display: 'inline-block', padding: '4px 10px', background: '#fff1f0', color: '#cf1322', border: '1px solid #ffa39e', borderRadius: 999 }}>
              Draft / Incomplete
            </div>
          ) : null}
        </div>
        <div />
      </div>

      <div style={{ marginTop: 12, marginBottom: 18, display: 'flex', justifyContent: 'flex-end' }}>
        <div style={{ width: '34%' }}>
          <div style={{ background: '#e6ecf6', padding: '6px 8px', fontWeight: 700, textAlign: 'right', border: '1px solid #dfe6f1' }}>
            {showChinese ? 'Customer Details 客户信息' : 'Customer Details'}
          </div>
          <div style={{ border: '1px solid #dfe6f1', borderTop: 0, padding: 8, textAlign: 'right' }}>
            <div style={{ fontSize: 12 }}>{ownerName}</div>
            <div style={{ fontSize: 12 }}>{propertyCode}</div>
            <div style={{ fontSize: 12, marginTop: 2 }}>{propertyAddress}</div>
          </div>
        </div>
      </div>

      {report.warnings.length ? (
        <div style={{ marginTop: 12, marginBottom: 12, padding: 10, border: '1px solid #ffd591', background: '#fff7e6', color: '#8c5a00' }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>{showChinese ? 'Warnings 警告' : 'Warnings'}</div>
          {report.warnings.map((warning, index) => (
            <div key={`${warning.code}-${warning.month_key || ''}-${index}`}>- {formatAnnualReportWarningMessage(warning, language)}</div>
          ))}
        </div>
      ) : null}

      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 12, fontSize: 12 }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left', padding: 6 }}></th>
            {report.months.map((month) => (
              <th key={month.month_key} style={{ padding: 6, background: '#e6ecf6' }}>
                <div>{monthLabel(month.month_key)}</div>
                {month.status !== 'complete' ? (
                  <div style={{ fontSize: 10, color: '#cf1322', marginTop: 4 }}>{formatAnnualReportMonthStatus(month.status, language)}</div>
                ) : null}
              </th>
            ))}
            <th style={{ padding: 6, background: '#e6ecf6' }}>{showChinese ? 'Year Total 全年合计' : 'Year Total'}</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style={{ padding: 6, fontWeight: 700 }}>{showChinese ? 'Income 收入' : 'Income'}</td>
            <td colSpan={13}></td>
          </tr>
          {DISPLAY_ROWS.slice(0, 2).map((rowKey) => (
            <tr key={rowKey}>
              <td style={{ padding: 6 }}>{getAnnualReportLineLabel(rowKey, language)}</td>
              {report.months.map((month) => (
                <td key={`${month.month_key}-${rowKey}`} style={{ padding: 6, textAlign: 'right' }}>
                  {formatAnnualReportMoney(month.lines[rowKey])}
                </td>
              ))}
              <td style={{ padding: 6, textAlign: 'right' }}>{formatAnnualReportMoney(report.totals.lines[rowKey])}</td>
            </tr>
          ))}

          {visibleExpenseRows.length ? (
            <>
              <tr>
                <td style={{ padding: 6, fontWeight: 700 }}>{showChinese ? 'Expenses 支出' : 'Expenses'}</td>
                <td colSpan={13}></td>
              </tr>
              {visibleExpenseRows.map((rowKey) => (
                <tr key={rowKey}>
                  <td style={{ padding: 6 }}>{getAnnualReportLineLabel(rowKey, language)}</td>
                  {report.months.map((month) => (
                    <td key={`${month.month_key}-${rowKey}`} style={{ padding: 6, textAlign: 'right' }}>
                      {formatAnnualReportMoney(month.lines[rowKey])}
                    </td>
                  ))}
                  <td style={{ padding: 6, textAlign: 'right' }}>{formatAnnualReportMoney(report.totals.lines[rowKey])}</td>
                </tr>
              ))}
            </>
          ) : null}

          <tr>
            <td style={{ padding: 6, fontWeight: 700 }}>{showChinese ? 'Net Income 净收入' : 'Net Income'}</td>
            {report.months.map((month) => (
              <td key={`${month.month_key}-net`} style={{ padding: 6, textAlign: 'right', fontWeight: 700 }}>
                {formatAnnualReportMoney(month.net_income)}
              </td>
            ))}
            <td style={{ padding: 6, textAlign: 'right', fontWeight: 700 }}>{formatAnnualReportMoney(report.totals.net_income)}</td>
          </tr>
        </tbody>
      </table>

      <div data-fy-report-footer="1" style={{ textAlign: 'center', marginTop: 18, fontSize: 12 }}>
        <div style={{ fontWeight: 700 }}>MZ Property Pty Ltd</div>
        <div>ABN: 42 657 925 365</div>
        <div>Address: G3/87 Gladstone St, South Melbourne, VIC3205</div>
        <div>Email: info@mzproperty.com.au</div>
      </div>
    </div>
  )
})
