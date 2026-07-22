import { v4 as uuidv4 } from 'uuid'
import { db, type FinanceTransaction, type Landlord, type Order, type Property } from '../store'
import { hasPg, pgPool } from '../dbAdapter'
import {
  ensureManagementFeeRulesTable,
  listManagementFeeRulesByLandlordIds,
  resolveManagementFeeRateForMonthFromRules,
  type LandlordManagementFeeRule,
} from './managementFeeRules'
import { computeMonthSegmentsForOrders, sumSegmentsVisibleNetIncome } from './orderMonthSegments'

export const SUPPORTED_ANNUAL_REPORT_FISCAL_YEARS = [2026] as const
export const ANNUAL_REPORT_CURRENCY = 'AUD'
export const ANNUAL_REPORT_ROUTE = '/finance/performance/annual'

export const ANNUAL_REPORT_LINE_KEYS = [
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
] as const

export const ANNUAL_REPORT_EXPENSE_LINE_KEYS = [
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
] as const

export type AnnualReportLineKey = (typeof ANNUAL_REPORT_LINE_KEYS)[number]
export type AnnualReportExpenseLineKey = (typeof ANNUAL_REPORT_EXPENSE_LINE_KEYS)[number]
export type AnnualReportMonthSource = 'manual' | 'system'
export type AnnualReportMonthStatus = 'complete' | 'missing_manual' | 'missing_system_data' | 'warning'
export type AnnualReportStatus = 'complete' | 'draft_incomplete'

export type AnnualReportWarning = {
  code: string
  message: string
  month_key?: string
}

export type AnnualReportLines = Record<AnnualReportLineKey, number | null>

export type AnnualReportMonth = {
  month_key: string
  source: AnnualReportMonthSource
  status: AnnualReportMonthStatus
  is_complete: boolean
  currency: string
  income: number | null
  expense: number | null
  net_income: number | null
  lines: AnnualReportLines
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

export type AnnualReportManualMonthRow = {
  id: string
  property_id: string
  month_key: string
  fiscal_year: number
  currency: string
  rent_income: number | null
  other_income: number | null
  management_fee: number | null
  consumables: number | null
  electricity: number | null
  gas: number | null
  water: number | null
  internet: number | null
  carpark: number | null
  council: number | null
  bodycorp: number | null
  other_expense: number | null
  note: string | null
  is_complete: boolean
  created_at?: string | null
  updated_at?: string | null
  created_by?: string | null
  updated_by?: string | null
}

type OwnerSummary = NonNullable<AnnualPropertyReport['owner_current']>

type NormalizedSystemMonth = {
  rent_income: number
  other_income: number
  expense_lines: Partial<Record<AnnualReportExpenseLineKey, number>>
  has_activity: boolean
}

type BuildAnnualPropertyReportInput = {
  fiscal_year: number
  property: Pick<Property, 'id' | 'code' | 'address'> & { landlord_id?: string | null }
  ownerCurrent: OwnerSummary | null
  ownerSnapshot: AnnualPropertyReport['report_owner_snapshot']
  manualRows: AnnualReportManualMonthRow[]
  systemMonths: Record<string, NormalizedSystemMonth | undefined>
  managementFeeRules: LandlordManagementFeeRule[]
}

let ensureAnnualManualMonthsPromise: Promise<void> | null = null

export function isSupportedAnnualReportFiscalYear(value: any): value is number {
  const fy = Number(value)
  return SUPPORTED_ANNUAL_REPORT_FISCAL_YEARS.includes(fy as (typeof SUPPORTED_ANNUAL_REPORT_FISCAL_YEARS)[number])
}

export function listAnnualReportMonthKeys(fiscalYear: number) {
  if (!isSupportedAnnualReportFiscalYear(fiscalYear)) return []
  const startYear = fiscalYear - 1
  const out: string[] = []
  for (let month = 7; month <= 12; month += 1) out.push(`${String(startYear).padStart(4, '0')}-${String(month).padStart(2, '0')}`)
  for (let month = 1; month <= 6; month += 1) out.push(`${String(fiscalYear).padStart(4, '0')}-${String(month).padStart(2, '0')}`)
  return out
}

export function getAnnualReportPeriodBounds(fiscalYear: number) {
  if (!isSupportedAnnualReportFiscalYear(fiscalYear)) return null
  return {
    period_start: `${fiscalYear - 1}-07-01`,
    period_end: `${fiscalYear}-06-30`,
  }
}

export function getAnnualReportManualMonthKeys(fiscalYear: number) {
  if (fiscalYear !== 2026) return []
  return listAnnualReportMonthKeys(fiscalYear).filter((monthKey) => monthKey <= '2026-01')
}

export function isAnnualReportManualMonth(fiscalYear: number, monthKey: string) {
  return getAnnualReportManualMonthKeys(fiscalYear).includes(String(monthKey || '').trim())
}

export function getAnnualReportFiscalYearForMonth(monthKey: string) {
  const month = String(monthKey || '').trim()
  if (!/^\d{4}-\d{2}$/.test(month)) return null
  const year = Number(month.slice(0, 4))
  const monthNo = Number(month.slice(5, 7))
  if (!year || monthNo < 1 || monthNo > 12) return null
  return monthNo >= 7 ? year + 1 : year
}

export async function ensureAnnualReportManualMonthsTable() {
  if (!hasPg || !pgPool) return
  if (ensureAnnualManualMonthsPromise) return ensureAnnualManualMonthsPromise
  ensureAnnualManualMonthsPromise = (async () => {
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS property_annual_report_manual_months (
        id text PRIMARY KEY,
        property_id text NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
        month_key text NOT NULL,
        fiscal_year integer NOT NULL,
        currency text NOT NULL DEFAULT 'AUD',
        rent_income numeric,
        other_income numeric,
        management_fee numeric,
        consumables numeric,
        electricity numeric,
        gas numeric,
        water numeric,
        internet numeric,
        carpark numeric,
        council numeric,
        bodycorp numeric,
        other_expense numeric,
        note text,
        is_complete boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        created_by text,
        updated_by text
      );
    `)
    await pgPool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_property_annual_report_manual_months_property_month
      ON property_annual_report_manual_months(property_id, month_key);
    `)
    await pgPool.query(`
      CREATE INDEX IF NOT EXISTS idx_property_annual_report_manual_months_fy
      ON property_annual_report_manual_months(fiscal_year, property_id, month_key);
    `)
  })().catch((error) => {
    ensureAnnualManualMonthsPromise = null
    throw error
  })
  return ensureAnnualManualMonthsPromise
}

function round2(value: any) {
  const amount = Number(value ?? 0)
  if (!Number.isFinite(amount)) return 0
  return Math.round((amount + Number.EPSILON) * 100) / 100
}

function normalizeNullableAmount(value: any): number | null {
  if (value === null || value === undefined || value === '') return null
  const amount = Number(value)
  return Number.isFinite(amount) ? round2(amount) : null
}

function emptyAnnualReportLines(): AnnualReportLines {
  return {
    rent_income: null,
    other_income: null,
    management_fee: null,
    consumables: null,
    electricity: null,
    gas: null,
    water: null,
    internet: null,
    carpark: null,
    council: null,
    bodycorp: null,
    other_expense: null,
  }
}

function numericAnnualReportLines(): Record<AnnualReportLineKey, number> {
  return {
    rent_income: 0,
    other_income: 0,
    management_fee: 0,
    consumables: 0,
    electricity: 0,
    gas: 0,
    water: 0,
    internet: 0,
    carpark: 0,
    council: 0,
    bodycorp: 0,
    other_expense: 0,
  }
}

function normalizeExpenseCategory(raw?: string, detail?: string): AnnualReportExpenseLineKey {
  const value = `${String(raw || '').trim().toLowerCase()} ${String(detail || '').trim().toLowerCase()}`.trim()
  if (value.includes('management') || value.includes('管理费')) return 'management_fee'
  if (value.includes('consumable') || value.includes('消耗')) return 'consumables'
  if (value.includes('electric') || value.includes('电')) return 'electricity'
  if (value.includes('gas') || value.includes('热水') || value.includes('煤气')) return 'gas'
  if ((value.includes('water') || value.includes('水')) && !value.includes('热')) return 'water'
  if (value.includes('internet') || value.includes('nbn') || value.includes('网')) return 'internet'
  if (value.includes('carpark') || value.includes('parking_fee') || value.includes('车位')) return 'carpark'
  if (value.includes('council') || value.includes('市政')) return 'council'
  if (
    value.includes('body_corp') ||
    value.includes('bodycorp') ||
    value.includes('owners_corp') ||
    value.includes('ownerscorp') ||
    value.includes('property_fee') ||
    value.includes('物业')
  ) return 'bodycorp'
  return 'other_expense'
}

function isVoidedLike(row: any) {
  const status = String(row?.status || '').trim().toLowerCase()
  return status === 'void' || status === 'voided'
}

function isFurnitureOwnerPaymentLike(tx: Pick<FinanceTransaction, 'kind' | 'category' | 'category_detail' | 'note'>) {
  if (tx.kind !== 'income') return false
  const value = `${String(tx.category || '').trim().toLowerCase()} ${String(tx.category_detail || '').trim().toLowerCase()} ${String(tx.note || '').trim().toLowerCase()}`.trim()
  if (value.includes('furniture_owner_payment') || value.includes('owner_payment_furniture') || value.includes('furniture_payment_owner')) return true
  const hasFurniture = value.includes('furniture') || value.includes('家具')
  const hasOwner = value.includes('owner') || value.includes('landlord') || value.includes('房东')
  const hasPaid = value.includes('paid') || value.includes('payment') || value.includes('转') || value.includes('已付') || value.includes('付款')
  return hasFurniture && hasOwner && hasPaid
}

function shouldIncludeOtherIncome(tx: Pick<FinanceTransaction, 'kind' | 'category' | 'category_detail' | 'note'>) {
  if (tx.kind !== 'income') return false
  const category = String(tx.category || '').trim().toLowerCase()
  if (category === 'late_checkout' || category === 'cancel_fee') return false
  if (isFurnitureOwnerPaymentLike(tx)) return false
  return true
}

function monthKeyFromDateLike(row: any) {
  const fromMonthKey = String(row?.month_key || '').trim()
  if (/^\d{4}-\d{2}$/.test(fromMonthKey)) return fromMonthKey
  const raw = String(row?.paid_date || row?.occurred_at || row?.due_date || row?.created_at || '').trim()
  const match = raw.match(/^(\d{4})-(\d{2})-\d{2}/)
  if (!match) return ''
  return `${match[1]}-${match[2]}`
}

function allLineValuesPresent(lines: AnnualReportLines) {
  return ANNUAL_REPORT_LINE_KEYS.every((key) => typeof lines[key] === 'number')
}

function buildMonthFinancials(lines: AnnualReportLines) {
  if (!allLineValuesPresent(lines)) return { income: null, expense: null, net_income: null }
  const income = round2(Number(lines.rent_income || 0) + Number(lines.other_income || 0))
  const expense = round2(
    ANNUAL_REPORT_EXPENSE_LINE_KEYS.reduce((sum, key) => sum + Number(lines[key] || 0), 0)
  )
  const net_income = round2(income - expense)
  return { income, expense, net_income }
}

function normalizeManualRow(row: any): AnnualReportManualMonthRow {
  return {
    id: String(row?.id || ''),
    property_id: String(row?.property_id || ''),
    month_key: String(row?.month_key || ''),
    fiscal_year: Number(row?.fiscal_year || 0),
    currency: String(row?.currency || ANNUAL_REPORT_CURRENCY),
    rent_income: normalizeNullableAmount(row?.rent_income),
    other_income: normalizeNullableAmount(row?.other_income),
    management_fee: normalizeNullableAmount(row?.management_fee),
    consumables: normalizeNullableAmount(row?.consumables),
    electricity: normalizeNullableAmount(row?.electricity),
    gas: normalizeNullableAmount(row?.gas),
    water: normalizeNullableAmount(row?.water),
    internet: normalizeNullableAmount(row?.internet),
    carpark: normalizeNullableAmount(row?.carpark),
    council: normalizeNullableAmount(row?.council),
    bodycorp: normalizeNullableAmount(row?.bodycorp),
    other_expense: normalizeNullableAmount(row?.other_expense),
    note: row?.note == null ? null : String(row.note),
    is_complete: row?.is_complete !== false,
    created_at: row?.created_at == null ? null : String(row.created_at),
    updated_at: row?.updated_at == null ? null : String(row.updated_at),
    created_by: row?.created_by == null ? null : String(row.created_by),
    updated_by: row?.updated_by == null ? null : String(row.updated_by),
  }
}

function manualRowToLines(row: AnnualReportManualMonthRow): AnnualReportLines {
  return {
    rent_income: row.rent_income,
    other_income: row.other_income,
    management_fee: row.management_fee,
    consumables: row.consumables,
    electricity: row.electricity,
    gas: row.gas,
    water: row.water,
    internet: row.internet,
    carpark: row.carpark,
    council: row.council,
    bodycorp: row.bodycorp,
    other_expense: row.other_expense,
  }
}

export function buildAnnualPropertyReport(input: BuildAnnualPropertyReportInput): AnnualPropertyReport {
  const months = listAnnualReportMonthKeys(input.fiscal_year)
  const manualRowsByMonth = new Map(input.manualRows.map((row) => [row.month_key, row]))
  const reportMonths: AnnualReportMonth[] = []
  const reportWarnings: AnnualReportWarning[] = []
  const totals = numericAnnualReportLines()
  let totalIncome = 0
  let totalExpense = 0
  let totalNetIncome = 0
  let completeMonthCount = 0
  let missingMonthCount = 0

  for (const monthKey of months) {
    const isManualMonth = isAnnualReportManualMonth(input.fiscal_year, monthKey)
    if (isManualMonth) {
      const row = manualRowsByMonth.get(monthKey)
      if (!row) {
        reportMonths.push({
          month_key: monthKey,
          source: 'manual',
          status: 'missing_manual',
          is_complete: false,
          currency: ANNUAL_REPORT_CURRENCY,
          income: null,
          expense: null,
          net_income: null,
          lines: emptyAnnualReportLines(),
          note: null,
          warnings: [{ code: 'missing_manual', message: '手工月份尚未录入', month_key: monthKey }],
          editable: true,
          has_saved_manual_record: false,
        })
        reportWarnings.push({ code: 'missing_manual', message: `${monthKey} 缺少手工月汇总`, month_key: monthKey })
        missingMonthCount += 1
        continue
      }
      const lines = manualRowToLines(row)
      const monthWarnings: AnnualReportWarning[] = []
      const hasAllValues = allLineValuesPresent(lines)
      const isComplete = row.is_complete && hasAllValues
      if (!row.is_complete) monthWarnings.push({ code: 'manual_marked_incomplete', message: '手工月份被标记为未完成', month_key: monthKey })
      if (!hasAllValues) monthWarnings.push({ code: 'manual_values_missing', message: '手工月份存在未填写字段', month_key: monthKey })
      const financials = buildMonthFinancials(lines)
      const status: AnnualReportMonthStatus = isComplete ? 'complete' : 'warning'
      if (!isComplete) {
        reportWarnings.push(...monthWarnings)
        missingMonthCount += 1
      } else {
        completeMonthCount += 1
      }
      reportMonths.push({
        month_key: monthKey,
        source: 'manual',
        status,
        is_complete: isComplete,
        currency: row.currency || ANNUAL_REPORT_CURRENCY,
        income: financials.income,
        expense: financials.expense,
        net_income: financials.net_income,
        lines,
        note: row.note || null,
        warnings: monthWarnings,
        editable: true,
        has_saved_manual_record: true,
      })
      for (const key of ANNUAL_REPORT_LINE_KEYS) totals[key] += Number(lines[key] || 0)
      totalIncome += Number(financials.income || 0)
      totalExpense += Number(financials.expense || 0)
      totalNetIncome += Number(financials.net_income || 0)
      continue
    }

    const system = input.systemMonths[monthKey]
    if (!system || !system.has_activity) {
      reportMonths.push({
        month_key: monthKey,
        source: 'system',
        status: 'missing_system_data',
        is_complete: false,
        currency: ANNUAL_REPORT_CURRENCY,
        income: null,
        expense: null,
        net_income: null,
        lines: emptyAnnualReportLines(),
        note: null,
        warnings: [{ code: 'missing_system_data', message: '系统月份暂无可信营收数据', month_key: monthKey }],
        editable: false,
        has_saved_manual_record: false,
      })
      reportWarnings.push({ code: 'missing_system_data', message: `${monthKey} 缺少系统营收数据`, month_key: monthKey })
      missingMonthCount += 1
      continue
    }

    const lines = emptyAnnualReportLines()
    lines.rent_income = round2(system.rent_income)
    lines.other_income = round2(system.other_income)
    for (const key of ANNUAL_REPORT_EXPENSE_LINE_KEYS) lines[key] = round2(system.expense_lines[key] || 0)

    const monthWarnings: AnnualReportWarning[] = []
    const mgmtRecorded = Number(lines.management_fee || 0) > 0
    if (!mgmtRecorded && Number(lines.rent_income || 0) > 0) {
      const resolved = resolveManagementFeeRateForMonthFromRules(input.managementFeeRules, monthKey)
      if (resolved.rule) {
        lines.management_fee = round2(Number(lines.rent_income || 0) * Number(resolved.rate || 0))
      } else {
        lines.management_fee = null
        monthWarnings.push({
          code: 'management_fee_rule_missing',
          message: `管理费缺少 ${monthKey} 的历史规则，未使用当前费率兜底`,
          month_key: monthKey,
        })
      }
    }

    const financials = buildMonthFinancials(lines)
    const isComplete = monthWarnings.length === 0 && financials.income !== null && financials.expense !== null && financials.net_income !== null
    if (isComplete) completeMonthCount += 1
    else missingMonthCount += 1
    reportWarnings.push(...monthWarnings)
    reportMonths.push({
      month_key: monthKey,
      source: 'system',
      status: isComplete ? 'complete' : 'warning',
      is_complete: isComplete,
      currency: ANNUAL_REPORT_CURRENCY,
      income: financials.income,
      expense: financials.expense,
      net_income: financials.net_income,
      lines,
      note: null,
      warnings: monthWarnings,
      editable: false,
      has_saved_manual_record: false,
    })
    for (const key of ANNUAL_REPORT_LINE_KEYS) totals[key] += Number(lines[key] || 0)
    totalIncome += Number(financials.income || 0)
    totalExpense += Number(financials.expense || 0)
    totalNetIncome += Number(financials.net_income || 0)
  }

  if (!input.ownerCurrent) {
    reportWarnings.push({ code: 'owner_missing', message: '当前房源没有关联房东信息' })
  }

  const period = getAnnualReportPeriodBounds(input.fiscal_year)
  if (!period) throw new Error('unsupported fiscal year')
  return {
    fiscal_year: input.fiscal_year,
    period_start: period.period_start,
    period_end: period.period_end,
    property: {
      id: String(input.property.id || ''),
      code: input.property.code ? String(input.property.code) : null,
      address: input.property.address ? String(input.property.address) : null,
      landlord_id: input.property.landlord_id ? String(input.property.landlord_id) : null,
    },
    owner_current: input.ownerCurrent,
    report_owner_snapshot: input.ownerSnapshot,
    report_status: missingMonthCount > 0 || reportWarnings.length > 0 ? 'draft_incomplete' : 'complete',
    warnings: reportWarnings,
    months: reportMonths,
    totals: {
      currency: ANNUAL_REPORT_CURRENCY,
      income: round2(totalIncome),
      expense: round2(totalExpense),
      net_income: round2(totalNetIncome),
      lines: Object.fromEntries(
        ANNUAL_REPORT_LINE_KEYS.map((key) => [key, round2(totals[key])])
      ) as Record<AnnualReportLineKey, number>,
      complete_month_count: completeMonthCount,
      missing_month_count: missingMonthCount,
    },
  }
}

function toOwnerSummary(landlord: any): OwnerSummary | null {
  if (!landlord) return null
  const emails = Array.isArray(landlord?.emails)
    ? landlord.emails.map((value: any) => String(value || '').trim()).filter(Boolean)
    : []
  const primaryEmail = emails[0] || String(landlord?.email || '').trim() || null
  return {
    id: landlord?.id ? String(landlord.id) : null,
    name: landlord?.name ? String(landlord.name) : null,
    company_name: landlord?.company_name ? String(landlord.company_name) : null,
    email: primaryEmail,
    emails,
    phone: landlord?.phone ? String(landlord.phone) : null,
  }
}

export function findLandlordByPropertyId(landlords: any[], propertyId: string) {
  const pid = String(propertyId || '').trim()
  if (!pid || !Array.isArray(landlords)) return null
  return landlords.find((landlord: any) => (
    Array.isArray(landlord?.property_ids)
      && landlord.property_ids.some((linkedPropertyId: any) => String(linkedPropertyId || '').trim() === pid)
  )) || null
}

async function loadPropertyAndOwner(propertyId: string) {
  const pid = String(propertyId || '').trim()
  if (!pid) return { property: null as any, landlord: null as any }
  if (hasPg && pgPool) {
    const propertyRs = await pgPool.query('SELECT id, code, address, landlord_id FROM properties WHERE id = $1 LIMIT 1', [pid])
    const property = propertyRs.rows?.[0] || null
    const landlordId = String(property?.landlord_id || '').trim()
    let landlord = landlordId
      ? ((await pgPool.query('SELECT * FROM landlords WHERE id = $1 LIMIT 1', [landlordId])).rows?.[0] || null)
      : null
    if (!landlord) {
      const reverseRs = await pgPool.query(
        `SELECT *
           FROM landlords
          WHERE $1 = ANY(COALESCE(property_ids, ARRAY[]::text[]))
          LIMIT 1`,
        [pid]
      )
      landlord = reverseRs.rows?.[0] || null
    }
    return { property, landlord }
  }
  const property = (db.properties || []).find((row) => String((row as any)?.id || '') === pid) || null
  const landlordId = String((property as any)?.landlord_id || '').trim()
  const landlord = (landlordId ? (db.landlords || []).find((row) => String((row as any)?.id || '') === landlordId) || null : null)
    || findLandlordByPropertyId(db.landlords || [], pid)
  return { property, landlord }
}

async function loadManualRows(propertyId: string, fiscalYear: number) {
  if (hasPg && pgPool) {
    try {
      const rows = await pgPool.query(
        `SELECT *
           FROM property_annual_report_manual_months
          WHERE property_id = $1
            AND fiscal_year = $2
          ORDER BY month_key ASC`,
        [propertyId, fiscalYear]
      )
      return (rows.rows || []).map(normalizeManualRow)
    } catch (error: any) {
      // The annual-report migration is applied separately; a GET must remain read-only
      // and should treat an unapplied manual-months table as no saved manual rows.
      if (String(error?.code || '') === '42P01') return [] as AnnualReportManualMonthRow[]
      throw error
    }
  }
  return [] as AnnualReportManualMonthRow[]
}

async function loadSystemMonths(propertyId: string, fiscalYear: number) {
  const monthKeys = listAnnualReportMonthKeys(fiscalYear)
  const out: Record<string, NormalizedSystemMonth> = {}
  for (const monthKey of monthKeys) {
    out[monthKey] = { rent_income: 0, other_income: 0, expense_lines: {}, has_activity: false }
  }

  const monthSet = new Set(monthKeys)
  if (hasPg && pgPool) {
    const period = getAnnualReportPeriodBounds(fiscalYear)
    if (!period) return out
    const nextStart = `${fiscalYear}-07-01`
    const ordersRs = await pgPool.query(
      `SELECT id, property_id, stay_type, checkin, checkout, price, cleaning_fee, nights, net_income, status, count_in_income
         FROM orders
        WHERE property_id = $1
          AND checkin < $3::date
          AND checkout > $2::date`,
      [propertyId, period.period_start, nextStart]
    )
    const orders = ordersRs.rows || []
    const orderIds = orders.map((row: any) => String(row?.id || '')).filter(Boolean)
    const deductionByOrderId = new Map<string, number>()
    if (orderIds.length) {
      const deductionsRs = await pgPool.query(
        `SELECT order_id, COALESCE(SUM(amount), 0) AS total
           FROM order_internal_deductions
          WHERE is_active = true
            AND order_id = ANY($1::text[])
          GROUP BY order_id`,
        [orderIds]
      ).catch(() => ({ rows: [] as any[] }))
      for (const row of (deductionsRs.rows || [])) {
        deductionByOrderId.set(String(row.order_id), Number(row.total || 0))
      }
    }
    const enrichedOrders = orders.map((row: any) => ({
      ...row,
      internal_deduction_total: round2(deductionByOrderId.get(String(row.id)) || 0),
    }))
    for (const monthKey of monthKeys.filter((key) => !isAnnualReportManualMonth(fiscalYear, key))) {
      const segments = computeMonthSegmentsForOrders(enrichedOrders as any[], monthKey)
      const rentIncome = round2(sumSegmentsVisibleNetIncome(segments))
      if (!out[monthKey]) out[monthKey] = { rent_income: 0, other_income: 0, expense_lines: {}, has_activity: false }
      out[monthKey].rent_income = rentIncome
      out[monthKey].has_activity = out[monthKey].has_activity || segments.length > 0
    }

    const incomeRs = await pgPool.query(
      `SELECT *
         FROM finance_transactions
        WHERE kind = 'income'
          AND property_id = $1
          AND occurred_at::date >= $2::date
          AND occurred_at::date <= $3::date`,
      [propertyId, period.period_start, period.period_end]
    ).catch(() => ({ rows: [] as any[] }))
    for (const row of (incomeRs.rows || [])) {
      const monthKey = monthKeyFromDateLike(row)
      if (!monthSet.has(monthKey) || isAnnualReportManualMonth(fiscalYear, monthKey)) continue
      if (!shouldIncludeOtherIncome(row as FinanceTransaction)) continue
      out[monthKey].other_income = round2(out[monthKey].other_income + Number(row.amount || 0))
      out[monthKey].has_activity = true
    }

    const recurringRs = await pgPool.query(
      `SELECT id, report_category
         FROM recurring_payments`
    ).catch(() => ({ rows: [] as any[] }))
    const recurringCategoryById = new Map<string, string>()
    for (const row of (recurringRs.rows || [])) recurringCategoryById.set(String(row.id || ''), String(row.report_category || ''))

    const expenseRs = await pgPool.query(
      `SELECT *
         FROM property_expenses
        WHERE property_id = $1
          AND (
            (month_key IS NOT NULL AND month_key >= $2 AND month_key <= $3)
            OR (
              month_key IS NULL
              AND COALESCE(paid_date, occurred_at)::date >= $4::date
              AND COALESCE(paid_date, occurred_at)::date <= $5::date
            )
          )`,
      [propertyId, `${fiscalYear - 1}-07`, `${fiscalYear}-06`, period.period_start, period.period_end]
    ).catch(() => ({ rows: [] as any[] }))
    for (const row of (expenseRs.rows || [])) {
      if (row?.deleted_at || isVoidedLike(row)) continue
      const monthKey = monthKeyFromDateLike(row)
      if (!monthSet.has(monthKey) || isAnnualReportManualMonth(fiscalYear, monthKey)) continue
      const fixedExpenseId = String(row?.fixed_expense_id || '').trim()
      const recurringCategory = fixedExpenseId ? recurringCategoryById.get(fixedExpenseId) : ''
      const category = normalizeExpenseCategory(recurringCategory || row?.category, row?.category_detail)
      const amount = round2(row?.amount || 0)
      out[monthKey].expense_lines[category] = round2(Number(out[monthKey].expense_lines[category] || 0) + amount)
      out[monthKey].has_activity = true
    }
    return out
  }

  const orders = (db.orders || []).filter((row) => String((row as any)?.property_id || '') === propertyId)
  for (const monthKey of monthKeys.filter((key) => !isAnnualReportManualMonth(fiscalYear, key))) {
    const segments = computeMonthSegmentsForOrders(orders as any[], monthKey)
    out[monthKey].rent_income = round2(sumSegmentsVisibleNetIncome(segments))
    out[monthKey].has_activity = segments.length > 0
  }
  const incomeRows = (db.financeTransactions || []).filter((row) => row.kind === 'income' && String(row.property_id || '') === propertyId)
  for (const row of incomeRows) {
    const monthKey = monthKeyFromDateLike(row)
    if (!monthSet.has(monthKey) || isAnnualReportManualMonth(fiscalYear, monthKey)) continue
    if (!shouldIncludeOtherIncome(row)) continue
    out[monthKey].other_income = round2(out[monthKey].other_income + Number(row.amount || 0))
    out[monthKey].has_activity = true
  }
  return out
}

export async function loadAnnualPropertyReport(propertyId: string, fiscalYear: number): Promise<AnnualPropertyReport> {
  if (!isSupportedAnnualReportFiscalYear(fiscalYear)) throw new Error('unsupported fiscal year')
  const { property, landlord } = await loadPropertyAndOwner(propertyId)
  if (!property) throw new Error('property_not_found')
  const ownerCurrent = toOwnerSummary(landlord)
  const ownerSnapshot = ownerCurrent ? { ...ownerCurrent, snapshot_mode: 'current_owner_at_generation' as const } : null
  const managementFeeRules = landlord?.id && hasPg && pgPool
    ? ((await listManagementFeeRulesByLandlordIds([String(landlord.id)]))[String(landlord.id)] || [])
    : []
  const [manualRows, systemMonths] = await Promise.all([
    loadManualRows(String(property.id), fiscalYear),
    loadSystemMonths(String(property.id), fiscalYear),
  ])
  return buildAnnualPropertyReport({
    fiscal_year: fiscalYear,
    property: {
      id: String(property.id || ''),
      code: property.code || null,
      address: property.address || null,
      landlord_id: property.landlord_id || null,
    },
    ownerCurrent,
    ownerSnapshot,
    manualRows,
    systemMonths,
    managementFeeRules,
  })
}

export async function listAnnualReportManualRows(propertyId: string, fiscalYear: number) {
  if (!isSupportedAnnualReportFiscalYear(fiscalYear)) throw new Error('unsupported fiscal year')
  return loadManualRows(propertyId, fiscalYear)
}

export async function upsertAnnualReportManualMonth(input: {
  property_id: string
  month_key: string
  fiscal_year: number
  currency?: string
  note?: string | null
  is_complete: boolean
  created_by?: string | null
  updated_by?: string | null
  lines: AnnualReportLines
}) {
  const propertyId = String(input.property_id || '').trim()
  const monthKey = String(input.month_key || '').trim()
  const fiscalYear = Number(input.fiscal_year || 0)
  if (!propertyId) throw new Error('property_id_required')
  if (!isSupportedAnnualReportFiscalYear(fiscalYear)) throw new Error('unsupported fiscal year')
  if (!isAnnualReportManualMonth(fiscalYear, monthKey)) throw new Error('manual_month_required')
  if (getAnnualReportFiscalYearForMonth(monthKey) !== fiscalYear) throw new Error('month_fiscal_year_mismatch')
  await ensureManagementFeeRulesTable()
  if (hasPg && pgPool) {
    await ensureAnnualReportManualMonthsTable()
    const now = new Date().toISOString()
    const payload = {
      property_id: propertyId,
      month_key: monthKey,
      fiscal_year: fiscalYear,
      currency: input.currency || ANNUAL_REPORT_CURRENCY,
      rent_income: normalizeNullableAmount(input.lines.rent_income),
      other_income: normalizeNullableAmount(input.lines.other_income),
      management_fee: normalizeNullableAmount(input.lines.management_fee),
      consumables: normalizeNullableAmount(input.lines.consumables),
      electricity: normalizeNullableAmount(input.lines.electricity),
      gas: normalizeNullableAmount(input.lines.gas),
      water: normalizeNullableAmount(input.lines.water),
      internet: normalizeNullableAmount(input.lines.internet),
      carpark: normalizeNullableAmount(input.lines.carpark),
      council: normalizeNullableAmount(input.lines.council),
      bodycorp: normalizeNullableAmount(input.lines.bodycorp),
      other_expense: normalizeNullableAmount(input.lines.other_expense),
      note: input.note == null ? null : String(input.note),
      is_complete: input.is_complete,
      updated_at: now,
      updated_by: input.updated_by || null,
    }
    const existing = await pgPool.query(
      `SELECT id, created_at, created_by
         FROM property_annual_report_manual_months
        WHERE property_id = $1
          AND month_key = $2
        LIMIT 1`,
      [propertyId, monthKey]
    )
    if (existing.rows?.[0]?.id) {
      const updated = await pgPool.query(
        `UPDATE property_annual_report_manual_months
            SET currency = $3,
                rent_income = $4,
                other_income = $5,
                management_fee = $6,
                consumables = $7,
                electricity = $8,
                gas = $9,
                water = $10,
                internet = $11,
                carpark = $12,
                council = $13,
                bodycorp = $14,
                other_expense = $15,
                note = $16,
                is_complete = $17,
                updated_at = $18,
                updated_by = $19
          WHERE property_id = $1
            AND month_key = $2
        RETURNING *`,
        [
          propertyId,
          monthKey,
          payload.currency,
          payload.rent_income,
          payload.other_income,
          payload.management_fee,
          payload.consumables,
          payload.electricity,
          payload.gas,
          payload.water,
          payload.internet,
          payload.carpark,
          payload.council,
          payload.bodycorp,
          payload.other_expense,
          payload.note,
          payload.is_complete,
          payload.updated_at,
          payload.updated_by,
        ]
      )
      return normalizeManualRow(updated.rows[0])
    }
    const inserted = await pgPool.query(
      `INSERT INTO property_annual_report_manual_months (
          id, property_id, month_key, fiscal_year, currency,
          rent_income, other_income, management_fee, consumables, electricity,
          gas, water, internet, carpark, council, bodycorp, other_expense,
          note, is_complete, created_at, updated_at, created_by, updated_by
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15, $16, $17,
          $18, $19, $20, $21, $22, $23
        )
        RETURNING *`,
      [
        uuidv4(),
        propertyId,
        monthKey,
        fiscalYear,
        payload.currency,
        payload.rent_income,
        payload.other_income,
        payload.management_fee,
        payload.consumables,
        payload.electricity,
        payload.gas,
        payload.water,
        payload.internet,
        payload.carpark,
        payload.council,
        payload.bodycorp,
        payload.other_expense,
        payload.note,
        payload.is_complete,
        now,
        now,
        input.created_by || input.updated_by || null,
        payload.updated_by,
      ]
    )
    return normalizeManualRow(inserted.rows[0])
  }
  throw new Error('pg_required')
}

export async function deleteAnnualReportManualMonth(propertyId: string, monthKey: string, fiscalYear?: number) {
  const fy = fiscalYear ?? getAnnualReportFiscalYearForMonth(monthKey)
  if (!fy || !isSupportedAnnualReportFiscalYear(fy)) throw new Error('unsupported fiscal year')
  if (!isAnnualReportManualMonth(fy, monthKey)) throw new Error('manual_month_required')
  if (hasPg && pgPool) {
    await ensureAnnualReportManualMonthsTable()
    await pgPool.query(
      `DELETE FROM property_annual_report_manual_months
        WHERE property_id = $1
          AND month_key = $2`,
      [propertyId, monthKey]
    )
    return { ok: true }
  }
  return { ok: true }
}
