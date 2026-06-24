export const ANNUAL_REPORT_ROUTE = '/finance/performance/annual'
export const SUPPORTED_ANNUAL_REPORT_FISCAL_YEARS = [2026] as const
export const ANNUAL_REPORT_LANGUAGE_OPTIONS = ['en', 'bilingual'] as const
export const ANNUAL_REPORT_LINE_LABELS_EN = {
  rent_income: 'Rent Income',
  other_income: 'Other Income',
  management_fee: 'Agency Fees',
  consumables: 'Consumables Cost',
  electricity: 'Electricity',
  gas: 'Gas and Hot Water',
  water: 'Water',
  internet: 'Internet',
  carpark: 'Carpark Rent',
  council: 'Council Rate',
  bodycorp: 'Body Corporation',
  other_expense: 'Other Expenses',
} as const

export const ANNUAL_REPORT_LINE_LABELS = {
  rent_income: 'Rent Income 租金收入',
  other_income: 'Other Income 其他收入',
  management_fee: 'Agency Fees 管理费',
  consumables: 'Consumables Cost 耗材费用',
  electricity: 'Electricity 电费',
  gas: 'Gas and Hot Water 燃气/热水',
  water: 'Water 水费',
  internet: 'Internet 网络费',
  carpark: 'Carpark Rent 车位租金',
  council: 'Council Rate 市政费',
  bodycorp: 'Body Corporation 物业费',
  other_expense: 'Other Expenses 其他支出',
} as const

export type AnnualReportLineKey = keyof typeof ANNUAL_REPORT_LINE_LABELS
export type AnnualReportLanguage = (typeof ANNUAL_REPORT_LANGUAGE_OPTIONS)[number]
export type AnnualReportMonthSource = 'manual' | 'system'
export type AnnualReportMonthStatus = 'complete' | 'missing_manual' | 'missing_system_data' | 'warning'
export type AnnualReportStatus = 'complete' | 'draft_incomplete'

export type AnnualReportWarning = {
  code: string
  message: string
  month_key?: string
}

export type AnnualReportMonth = {
  month_key: string
  source: AnnualReportMonthSource
  status: AnnualReportMonthStatus
  is_complete: boolean
  currency: string
  income: number | null
  expense: number | null
  net_income: number | null
  lines: Record<AnnualReportLineKey, number | null>
  note: string | null
  warnings: AnnualReportWarning[]
  editable: boolean
  has_saved_manual_record: boolean
}

export type AnnualPropertyReport = {
  fiscal_year: number
  period_start: string
  period_end: string
  property: {
    id: string
    code: string | null
    address: string | null
    landlord_id: string | null
  }
  owner_current: {
    id: string | null
    name: string | null
    company_name: string | null
    email: string | null
    emails: string[]
    phone: string | null
  } | null
  report_owner_snapshot: {
    id: string | null
    name: string | null
    company_name: string | null
    email: string | null
    emails: string[]
    phone: string | null
    snapshot_mode: 'current_owner_at_generation'
  } | null
  report_status: AnnualReportStatus
  warnings: AnnualReportWarning[]
  months: AnnualReportMonth[]
  totals: {
    currency: string
    income: number
    expense: number
    net_income: number
    lines: Record<AnnualReportLineKey, number>
    complete_month_count: number
    missing_month_count: number
  }
}

export function listAnnualReportMonthKeys(fiscalYear: number) {
  if (!SUPPORTED_ANNUAL_REPORT_FISCAL_YEARS.includes(fiscalYear as (typeof SUPPORTED_ANNUAL_REPORT_FISCAL_YEARS)[number])) return []
  return [
    `${fiscalYear - 1}-07`,
    `${fiscalYear - 1}-08`,
    `${fiscalYear - 1}-09`,
    `${fiscalYear - 1}-10`,
    `${fiscalYear - 1}-11`,
    `${fiscalYear - 1}-12`,
    `${fiscalYear}-01`,
    `${fiscalYear}-02`,
    `${fiscalYear}-03`,
    `${fiscalYear}-04`,
    `${fiscalYear}-05`,
    `${fiscalYear}-06`,
  ]
}

export function isAnnualReportManualMonth(month: Pick<AnnualReportMonth, 'source' | 'editable'> | null | undefined) {
  return !!month && month.source === 'manual' && month.editable
}

export function annualReportHasIssues(report: AnnualPropertyReport | null | undefined) {
  if (!report) return false
  return report.report_status !== 'complete' || report.warnings.length > 0 || report.months.some((month) => !month.is_complete)
}

export function getAnnualReportMissingMonths(report: AnnualPropertyReport | null | undefined) {
  if (!report) return []
  return report.months.filter((month) => !month.is_complete).map((month) => month.month_key)
}

export function canDownloadAnnualReport(report: AnnualPropertyReport | null | undefined, propertyId: string | null | undefined) {
  return !!report && !!String(propertyId || '').trim()
}

export function formatAnnualReportFilename(input: { fiscalYear: number; propertyCode?: string | null; propertyAddress?: string | null }) {
  const rawLabel = String(input.propertyCode || input.propertyAddress || 'Property').trim() || 'Property'
  const safe = rawLabel.replace(/[^\w.-]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '') || 'Property'
  return `MZ_Annual_Report_${safe}_FY${input.fiscalYear}.pdf`
}

export function formatAnnualReportMoney(value: number | null | undefined) {
  if (value == null) return '--'
  return `$${Number(value || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function getAnnualReportLineLabel(lineKey: AnnualReportLineKey, language: AnnualReportLanguage) {
  return language === 'en' ? ANNUAL_REPORT_LINE_LABELS_EN[lineKey] : ANNUAL_REPORT_LINE_LABELS[lineKey]
}

const ANNUAL_REPORT_EXPENSE_LINE_KEYS: AnnualReportLineKey[] = [
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

export function getVisibleAnnualReportExpenseLineKeys(report: AnnualPropertyReport | null | undefined) {
  if (!report) return []
  return ANNUAL_REPORT_EXPENSE_LINE_KEYS.filter((lineKey) =>
    report.months.some((month) => {
      const value = month.lines[lineKey]
      if (value == null) return true
      return Number(value || 0) !== 0
    }) || Number(report.totals.lines[lineKey] || 0) !== 0,
  )
}

export function formatAnnualReportMonthStatus(status: AnnualReportMonthStatus, language: AnnualReportLanguage) {
  const labels = {
    complete: { en: 'Complete', bilingual: 'Complete 完整' },
    missing_manual: { en: 'Missing Manual', bilingual: 'Missing Manual 缺少手工月' },
    missing_system_data: { en: 'Missing System Data', bilingual: 'Missing System Data 缺少系统数据' },
    warning: { en: 'Warning', bilingual: 'Warning 警告' },
  } as const
  return labels[status][language]
}

export function formatAnnualReportWarningMessage(warning: AnnualReportWarning, language: AnnualReportLanguage) {
  const monthPrefix = warning.month_key ? `${warning.month_key} ` : ''
  const labels: Record<string, { en: string; bilingual: string }> = {
    missing_manual: {
      en: `${monthPrefix}Missing manual month summary`,
      bilingual: `${monthPrefix}Missing manual month summary 缺少手工月汇总`,
    },
    manual_marked_incomplete: {
      en: `${monthPrefix}Manual month marked incomplete`,
      bilingual: `${monthPrefix}Manual month marked incomplete 手工月份被标记为未完成`,
    },
    manual_values_missing: {
      en: `${monthPrefix}Manual month has missing fields`,
      bilingual: `${monthPrefix}Manual month has missing fields 手工月份存在未填写字段`,
    },
    missing_system_data: {
      en: `${monthPrefix}Missing reliable system revenue data`,
      bilingual: `${monthPrefix}Missing reliable system revenue data 缺少可信系统营收数据`,
    },
    management_fee_rule_missing: {
      en: `${monthPrefix}Missing historical management fee rule; current rate was not used as fallback`,
      bilingual: `${monthPrefix}Missing historical management fee rule; current rate was not used as fallback 管理费缺少历史规则，未使用当前费率兜底`,
    },
    owner_missing: {
      en: 'Current property has no linked owner information',
      bilingual: 'Current property has no linked owner information 当前房源没有关联房东信息',
    },
  }
  const matched = labels[warning.code]
  if (matched) return matched[language]
  return language === 'en' ? warning.message : warning.message
}
