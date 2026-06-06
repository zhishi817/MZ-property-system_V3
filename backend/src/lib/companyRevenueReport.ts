import { computeMonthSegmentsForOrders } from './orderMonthSegments'

export type CompanyRevenueProperty = {
  id: string
  code?: string | null
  address?: string | null
  landlord_id?: string | null
}

export type CompanyRevenueManagementFeeRule = {
  effective_from_month: string
  management_fee_rate: number
}

export type CompanyRevenueRow = {
  id: string
  record_id?: string | null
  kind: 'income' | 'expense'
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

export type CompanyRevenueCategorySummary = {
  category: string
  label: string
  total: number
  percentage: number
  count: number
}

export type CompanyRevenueWarning = {
  code: 'management_fee_rule_missing'
  message: string
  property_id?: string
  property_code?: string
}

export type CompanyRevenueReport = {
  month: string
  summary: {
    total_income: number
    total_expense: number
    net_revenue: number
    net_margin: number
  }
  income_categories: CompanyRevenueCategorySummary[]
  expense_categories: CompanyRevenueCategorySummary[]
  income_rows: CompanyRevenueRow[]
  expense_rows: CompanyRevenueRow[]
  warnings: CompanyRevenueWarning[]
}

type ReportInput = {
  month: string
  orders: any[]
  properties: CompanyRevenueProperty[]
  managementFeeRulesByLandlord: Record<string, CompanyRevenueManagementFeeRule[]>
  companyIncomes: any[]
  companyExpenses: any[]
  includeDeleted: boolean
}

export const COMPANY_INCOME_CATEGORY_LABELS: Record<string, string> = {
  mgmt_fee: '管理费',
  cleaning_fee: '清洁费',
  cancel_fee: '订单取消费',
  late_checkout: '晚退房费',
  other: '其他收入',
}

export const COMPANY_EXPENSE_CATEGORY_LABELS: Record<string, string> = {
  office: '办公',
  bedding_fee: '床品费',
  office_rent: '办公室租金',
  company_warehouse_rent: '公司仓库租金',
  car_loan: '车贷',
  electricity: '电费',
  internet: '网费',
  water: '水费',
  fuel: '油费',
  parking_fee: '车位费',
  maintenance_materials: '维修材料费',
  tax: '税费',
  service: '服务采购',
  other: '其他',
}

const INCOME_CATEGORY_ORDER = ['mgmt_fee', 'cleaning_fee', 'cancel_fee', 'late_checkout', 'other']

function round2(value: any): number {
  const n = Number(value || 0)
  if (!Number.isFinite(n)) return 0
  return Math.round((n + Number.EPSILON) * 100) / 100
}

function dateOnly(value: any): string {
  const raw = String(value || '').trim()
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})/)
  return match ? match[1] : ''
}

function monthBounds(month: string) {
  const match = String(month || '').match(/^(\d{4})-(\d{2})$/)
  if (!match) throw new Error('invalid month')
  const y = Number(match[1])
  const m = Number(match[2])
  if (!y || m < 1 || m > 12) throw new Error('invalid month')
  const next = new Date(Date.UTC(y, m, 1))
  const end = new Date(Date.UTC(y, m, 0))
  return {
    start: `${match[1]}-${match[2]}-01`,
    nextStart: next.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  }
}

function inMonth(value: any, start: string, nextStart: string): boolean {
  const day = dateOnly(value)
  return !!day && day >= start && day < nextStart
}

function normalizedIncomeCategory(value: any): string {
  const category = String(value || '').trim().toLowerCase()
  return COMPANY_INCOME_CATEGORY_LABELS[category] ? category : 'other'
}

function normalizedExpenseCategory(value: any): string {
  const category = String(value || '').trim().toLowerCase()
  return COMPANY_EXPENSE_CATEGORY_LABELS[category] ? category : 'other'
}

function activeOrder(order: any): boolean {
  const status = String(order?.status || '').trim().toLowerCase()
  return !status.includes('cancel') || !!order?.count_in_income
}

function propertyLabel(property: CompanyRevenueProperty | undefined, fallback?: any): string {
  return String(property?.code || property?.address || fallback || '').trim()
}

function resolveManagementFeeRule(
  rules: CompanyRevenueManagementFeeRule[] | undefined,
  month: string,
): CompanyRevenueManagementFeeRule | null {
  return (Array.isArray(rules) ? rules : [])
    .filter((rule) => /^\d{4}-\d{2}$/.test(String(rule?.effective_from_month || '')))
    .slice()
    .sort((a, b) => String(b.effective_from_month).localeCompare(String(a.effective_from_month)))
    .find((rule) => String(rule.effective_from_month) <= month) || null
}

function manualIncomeRow(row: any, property?: CompanyRevenueProperty, sourceType = 'manual_income'): CompanyRevenueRow {
  const category = normalizedIncomeCategory(row?.category)
  return {
    id: `income:${String(row?.id || '')}`,
    record_id: String(row?.id || '') || null,
    kind: 'income',
    occurred_at: dateOnly(row?.occurred_at),
    amount: round2(row?.amount),
    currency: String(row?.currency || 'AUD'),
    category,
    category_label: COMPANY_INCOME_CATEGORY_LABELS[category],
    property_id: String(row?.property_id || '') || null,
    property_code: propertyLabel(property, row?.property_code) || null,
    source_type: sourceType,
    source_label: sourceType === 'manual_override' ? '手工覆盖' : '手工记录',
    description: String(row?.note || '') || COMPANY_INCOME_CATEGORY_LABELS[category],
    note: String(row?.note || '') || null,
    editable: true,
    is_effective: true,
    ref_type: String(row?.ref_type || '') || null,
    ref_id: String(row?.ref_id || '') || null,
  }
}

function buildCategorySummary(
  rows: CompanyRevenueRow[],
  labels: Record<string, string>,
  preferredOrder?: string[],
): CompanyRevenueCategorySummary[] {
  const totals = new Map<string, { total: number; count: number }>()
  for (const row of rows) {
    if (!row.is_effective) continue
    const current = totals.get(row.category) || { total: 0, count: 0 }
    current.total = round2(current.total + row.amount)
    current.count += 1
    totals.set(row.category, current)
  }
  const total = round2(Array.from(totals.values()).reduce((sum, item) => sum + item.total, 0))
  const keys = preferredOrder
    ? Array.from(new Set([...preferredOrder, ...Array.from(totals.keys())]))
    : Array.from(totals.keys()).sort((a, b) => Number(totals.get(b)?.total || 0) - Number(totals.get(a)?.total || 0))
  return keys
    .map((category) => {
      const item = totals.get(category) || { total: 0, count: 0 }
      return {
        category,
        label: labels[category] || labels.other || '其他',
        total: round2(item.total),
        percentage: total > 0 ? round2((item.total / total) * 100) : 0,
        count: item.count,
      }
    })
    .filter((row) => preferredOrder?.includes(row.category) || row.total !== 0 || row.count > 0)
}

export function buildCompanyRevenueReport(input: ReportInput): CompanyRevenueReport {
  const { start, nextStart, end } = monthBounds(input.month)
  const properties = new Map((input.properties || []).map((property) => [String(property.id), property]))
  const manualRows = (input.companyIncomes || []).filter((row) => inMonth(row?.occurred_at, start, nextStart))
  const overrideByKey = new Map<string, any>()
  for (const row of manualRows) {
    const category = normalizedIncomeCategory(row?.category)
    const refType = String(row?.ref_type || '').trim()
    const refId = String(row?.ref_id || '').trim()
    if ((category === 'mgmt_fee' || category === 'cleaning_fee') && refType === 'order' && refId) {
      overrideByKey.set(`${category}:${refId}`, row)
    }
  }

  const consumedManualIds = new Set<string>()
  const warnings: CompanyRevenueWarning[] = []
  const warnedProperties = new Set<string>()
  const incomeRows: CompanyRevenueRow[] = []
  const segments = computeMonthSegmentsForOrders(input.orders || [], input.month)

  for (const segment of segments) {
    const orderId = String(segment?.id || '')
    const propertyId = String(segment?.property_id || '')
    const property = properties.get(propertyId)
    const landlordId = String(property?.landlord_id || '')
    const rule = resolveManagementFeeRule(input.managementFeeRulesByLandlord[landlordId], input.month)
    if (!rule) {
      if (!warnedProperties.has(propertyId || orderId)) {
        warnedProperties.add(propertyId || orderId)
        const label = propertyLabel(property, propertyId) || '未知房源'
        warnings.push({
          code: 'management_fee_rule_missing',
          message: `${label} 缺少 ${input.month} 可用的管理费率规则，管理费未计入`,
          property_id: propertyId || undefined,
          property_code: label || undefined,
        })
      }
      continue
    }

    const override = overrideByKey.get(`mgmt_fee:${orderId}`)
    if (override) {
      consumedManualIds.add(String(override.id || ''))
      const row = manualIncomeRow(override, property, 'manual_override')
      row.source_label = `订单 ${String(segment?.confirmation_code || orderId)}`
      row.description = String(override?.note || '') || `${input.month} 管理费手工覆盖`
      row.calculation = '手工覆盖订单派生管理费'
      if (row.amount !== 0) incomeRows.push(row)
      continue
    }

    const visibleRent = Math.max(0, round2(segment?.visible_net_income ?? segment?.net_income))
    const amount = round2(visibleRent * Number(rule.management_fee_rate || 0))
    if (amount === 0) continue
    const segmentCheckout = dateOnly(segment?.checkout)
    incomeRows.push({
      id: `derived:mgmt_fee:${orderId}:${input.month}`,
      kind: 'income',
      occurred_at: segmentCheckout && segmentCheckout < nextStart ? segmentCheckout : end,
      amount,
      currency: String(segment?.currency || 'AUD'),
      category: 'mgmt_fee',
      category_label: COMPANY_INCOME_CATEGORY_LABELS.mgmt_fee,
      property_id: propertyId || null,
      property_code: propertyLabel(property, propertyId) || null,
      source_type: 'derived_management_fee',
      source_label: `订单 ${String(segment?.confirmation_code || orderId)}`,
      description: `${input.month} 管理费`,
      note: null,
      editable: false,
      is_effective: true,
      ref_type: 'order',
      ref_id: orderId || null,
      calculation: `$${visibleRent.toFixed(2)} × ${(Number(rule.management_fee_rate || 0) * 100).toFixed(2)}%`,
    })
  }

  for (const order of input.orders || []) {
    if (!activeOrder(order) || !inMonth(order?.checkout, start, nextStart)) continue
    const amount = round2(order?.cleaning_fee)
    const orderId = String(order?.id || '')
    const propertyId = String(order?.property_id || '')
    const property = properties.get(propertyId)
    const override = overrideByKey.get(`cleaning_fee:${orderId}`)
    if (override) {
      consumedManualIds.add(String(override.id || ''))
      const row = manualIncomeRow(override, property, 'manual_override')
      row.source_label = `订单 ${String(order?.confirmation_code || orderId)}`
      row.description = String(override?.note || '') || '清洁费手工覆盖'
      row.calculation = '手工覆盖订单派生清洁费'
      if (row.amount !== 0) incomeRows.push(row)
      continue
    }
    if (amount === 0) continue
    incomeRows.push({
      id: `derived:cleaning_fee:${orderId}:${input.month}`,
      kind: 'income',
      occurred_at: dateOnly(order?.checkout),
      amount,
      currency: String(order?.currency || 'AUD'),
      category: 'cleaning_fee',
      category_label: COMPANY_INCOME_CATEGORY_LABELS.cleaning_fee,
      property_id: propertyId || null,
      property_code: propertyLabel(property, propertyId) || null,
      source_type: 'derived_cleaning_fee',
      source_label: `订单 ${String(order?.confirmation_code || orderId)}`,
      description: '退房清洁服务',
      note: null,
      editable: false,
      is_effective: true,
      ref_type: 'order',
      ref_id: orderId || null,
      calculation: '按实际退房月份归属',
    })
  }

  for (const row of manualRows) {
    if (consumedManualIds.has(String(row?.id || ''))) continue
    const property = properties.get(String(row?.property_id || ''))
    incomeRows.push(manualIncomeRow(row, property))
  }

  const expenseRows: CompanyRevenueRow[] = []
  for (const row of input.companyExpenses || []) {
    const isFixedExpense = !!String(row?.fixed_expense_id || '').trim()
    const hasMonthKey = /^\d{4}-\d{2}$/.test(String(row?.month_key || ''))
    const belongsToMonth = isFixedExpense && hasMonthKey
      ? String(row.month_key) === input.month
      : inMonth(row?.paid_date || row?.occurred_at, start, nextStart)
    if (!belongsToMonth) continue
    const deleted = !!row?.deleted_at
    const voided = String(row?.status || '').trim().toLowerCase() === 'void'
    const effective = !deleted && !voided
    if (!effective && !input.includeDeleted) continue
    const category = normalizedExpenseCategory(row?.category)
    const property = properties.get(String(row?.property_id || ''))
    const baseLabel = COMPANY_EXPENSE_CATEGORY_LABELS[category]
    const detail = category === 'other' ? String(row?.category_detail || '').trim() : ''
    expenseRows.push({
      id: `expense:${String(row?.id || '')}`,
      record_id: String(row?.id || '') || null,
      kind: 'expense',
      occurred_at: dateOnly(row?.paid_date || row?.occurred_at || row?.due_date) || start,
      amount: round2(row?.amount),
      currency: String(row?.currency || 'AUD'),
      category,
      category_label: detail ? `${baseLabel} · ${detail}` : baseLabel,
      property_id: String(row?.property_id || '') || null,
      property_code: propertyLabel(property, row?.property_code) || null,
      source_type: String(row?.is_auto ? 'auto_expense' : 'company_expense'),
      source_label: String(row?.source_title || row?.generated_from || (row?.is_auto ? '自动支出' : '公司支出')),
      description: String(row?.source_summary || row?.expense_name || row?.category_detail || '') || null,
      note: String(row?.note || '') || null,
      editable: effective,
      is_effective: effective,
      ref_type: String(row?.ref_type || '') || null,
      ref_id: String(row?.ref_id || '') || null,
      expense_name: String(row?.expense_name || '') || null,
      category_detail: String(row?.category_detail || '') || null,
      invoice_url: String(row?.invoice_url || '') || null,
      receipt_id: String(row?.receipt_id || '') || null,
      receipt_item_id: String(row?.receipt_item_id || '') || null,
      deleted_at: row?.deleted_at || null,
      deleted_by: String(row?.deleted_by || '') || null,
      delete_source: String(row?.delete_source || '') || null,
      status: String(row?.status || '') || null,
    })
  }

  incomeRows.sort((a, b) => b.occurred_at.localeCompare(a.occurred_at) || b.amount - a.amount)
  expenseRows.sort((a, b) => b.occurred_at.localeCompare(a.occurred_at) || b.amount - a.amount)
  const incomeCategories = buildCategorySummary(incomeRows, COMPANY_INCOME_CATEGORY_LABELS, INCOME_CATEGORY_ORDER)
  const expenseCategories = buildCategorySummary(expenseRows, COMPANY_EXPENSE_CATEGORY_LABELS)
  const totalIncome = round2(incomeRows.filter((row) => row.is_effective).reduce((sum, row) => sum + row.amount, 0))
  const totalExpense = round2(expenseRows.filter((row) => row.is_effective).reduce((sum, row) => sum + row.amount, 0))
  const netRevenue = round2(totalIncome - totalExpense)

  return {
    month: input.month,
    summary: {
      total_income: totalIncome,
      total_expense: totalExpense,
      net_revenue: netRevenue,
      net_margin: totalIncome > 0 ? round2((netRevenue / totalIncome) * 100) : 0,
    },
    income_categories: incomeCategories,
    expense_categories: expenseCategories,
    income_rows: incomeRows,
    expense_rows: expenseRows,
    warnings,
  }
}
