export type CompanyRevenueKind = 'income' | 'expense'

export type CompanyRevenueCategorySummary = {
  category: string
  label: string
  total: number
  percentage: number
  count: number
}

export type CompanyRevenueRow = {
  id: string
  record_id?: string | null
  kind: CompanyRevenueKind
  occurred_at: string
  amount: number
  currency: string
  category: string
  category_label: string
  property_id?: string | null
  property_code?: string | null
  source_type: string
  source_label: string
  description?: string | null
  note?: string | null
  editable: boolean
  is_effective: boolean
  ref_type?: string | null
  ref_id?: string | null
  expense_name?: string | null
  category_detail?: string | null
  invoice_url?: string | null
  receipt_id?: string | null
  receipt_item_id?: string | null
  deleted_at?: string | null
  deleted_by?: string | null
  delete_source?: string | null
  status?: string | null
  calculation?: string | null
}

export type CompanyRevenueReport = {
  month: string
  capabilities: {
    can_view_income: boolean
    can_view_expense: boolean
    can_include_deleted: boolean
  }
  summary: {
    total_income: number | null
    total_expense: number | null
    net_revenue: number | null
    net_margin: number | null
  }
  income_categories: CompanyRevenueCategorySummary[]
  expense_categories: CompanyRevenueCategorySummary[]
  income_rows: CompanyRevenueRow[]
  expense_rows: CompanyRevenueRow[]
  warnings: Array<{
    code: string
    message: string
    property_id?: string
    property_code?: string
  }>
}

export const COMPANY_INCOME_CATEGORY_OPTIONS = [
  { value: 'mgmt_fee', label: '管理费' },
  { value: 'cleaning_fee', label: '清洁费' },
  { value: 'cancel_fee', label: '订单取消费' },
  { value: 'late_checkout', label: '晚退房费' },
  { value: 'other', label: '其他收入' },
]

export const COMPANY_EXPENSE_CATEGORY_OPTIONS = [
  { value: 'office', label: '办公' },
  { value: 'bedding_fee', label: '床品费' },
  { value: 'office_rent', label: '办公室租金' },
  { value: 'company_warehouse_rent', label: '公司仓库租金' },
  { value: 'car_loan', label: '车贷' },
  { value: 'electricity', label: '电费' },
  { value: 'internet', label: '网费' },
  { value: 'water', label: '水费' },
  { value: 'fuel', label: '油费' },
  { value: 'parking_fee', label: '车位费' },
  { value: 'maintenance_materials', label: '维修材料费' },
  { value: 'tax', label: '税费' },
  { value: 'service', label: '服务采购' },
  { value: 'other', label: '其他' },
]

export type CompanyRevenueFilters = {
  categories: string[]
  query: string
  dateFrom?: string
  dateTo?: string
}

export function filterCompanyRevenueRows(
  rows: CompanyRevenueRow[],
  filters: CompanyRevenueFilters,
): CompanyRevenueRow[] {
  const categorySet = new Set((filters.categories || []).map((value) => String(value)))
  const query = String(filters.query || '').trim().toLowerCase()
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    if (categorySet.size && !categorySet.has(String(row.category || ''))) return false
    const date = String(row.occurred_at || '').slice(0, 10)
    if (filters.dateFrom && date < filters.dateFrom) return false
    if (filters.dateTo && date > filters.dateTo) return false
    if (!query) return true
    const haystack = [
      row.category_label,
      row.property_code,
      row.source_label,
      row.description,
      row.expense_name,
      row.note,
      row.ref_id,
    ].map((value) => String(value || '').toLowerCase()).join(' ')
    return haystack.includes(query)
  })
}

function csvCell(value: any): string {
  const text = String(value ?? '')
  return `"${text.replace(/"/g, '""')}"`
}

export function buildCompanyRevenueCsv(kind: CompanyRevenueKind, rows: CompanyRevenueRow[]): string {
  const header = kind === 'income'
    ? ['日期', '类别', '房号', '来源/说明', '金额(AUD)', '备注', '是否有效']
    : ['日期', '类别', '支出名称', '来源/说明', '金额(AUD)', '备注', '状态', '是否有效']
  const body = (Array.isArray(rows) ? rows : []).map((row) => {
    if (kind === 'income') {
      return [
        row.occurred_at,
        row.category_label,
        row.property_code || '',
        row.description || row.source_label || '',
        Number(row.amount || 0).toFixed(2),
        row.note || '',
        row.is_effective ? '有效' : '无效',
      ]
    }
    return [
      row.occurred_at,
      row.category_label,
      row.expense_name || '',
      row.description || row.source_label || '',
      Number(row.amount || 0).toFixed(2),
      row.note || '',
      row.deleted_at ? '已删除' : (String(row.status || '').toLowerCase() === 'void' ? '已作废' : '有效'),
      row.is_effective ? '有效' : '无效',
    ]
  })
  return `\uFEFF${[header, ...body].map((line) => line.map(csvCell).join(',')).join('\r\n')}`
}

export function sumEffectiveCompanyRevenueRows(rows: CompanyRevenueRow[]): number {
  return Math.round((rows || []).filter((row) => row.is_effective).reduce((sum, row) => sum + Number(row.amount || 0), 0) * 100) / 100
}
