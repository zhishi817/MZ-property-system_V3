import { pgRunInTransaction } from '../dbAdapter'
import { v4 as uuidv4 } from 'uuid'
import { deepCleaningSourceSummary, maintenanceSourceSummary } from './autoExpenseSourceSummary'
import { buildDailyNecessityAutoExpenseDecision } from './dailyNecessitiesAutoExpense'

function autoToISODateOnly(v: any): string | null {
  if (!v) return null
  if (typeof v === 'string') {
    const s = v.trim()
    if (!s) return null
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
    const d0 = new Date(s)
    if (!isNaN(d0.getTime())) return d0.toISOString().slice(0, 10)
    return null
  }
  if (v instanceof Date && !isNaN(v.getTime())) return v.toISOString().slice(0, 10)
  try {
    const d = new Date(v)
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10)
  } catch {}
  return null
}

function autoMonthKey(d: string | null): string | null {
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return null
  return `${d.slice(0, 4)}-${d.slice(5, 7)}`
}

function autoToNum(v: any): number {
  if (v === null || v === undefined || v === '') return 0
  const n0 = Number(v)
  if (Number.isFinite(n0)) return n0
  const s = String(v || '').replace(/[^0-9.\-]/g, '')
  const n1 = Number(s)
  return Number.isFinite(n1) ? n1 : 0
}

function autoNormPayMethod(v: any): string {
  const s = String(v || '').trim()
  const low = s.toLowerCase()
  if (!low) return ''
  if (low === 'rent_deduction' || s.includes('租金')) return 'rent_deduction'
  if (low === 'landlord_pay' || s.includes('房东')) return 'landlord_pay'
  if (low === 'company_pay' || s.includes('公司')) return 'company_pay'
  if (low === 'tenant_pay' || s.includes('房客')) return 'tenant_pay'
  if (low === 'other_pay' || s.includes('其他')) return 'other_pay'
  return low
}

function autoNormStatus(v: any): string {
  const s = String(v || '').trim()
  const low = s.toLowerCase()
  if (!low) return ''
  if (low === 'completed' || s.includes('已完成') || s === '完成') return 'completed'
  if (low === 'canceled' || s.includes('取消')) return 'canceled'
  return low
}

function autoCalcMaintenanceTotal(row: any): number {
  const explicitTotal = autoToNum(row?.total_amount)
  if (Number.isFinite(explicitTotal) && explicitTotal > 0) return Math.round((explicitTotal + Number.EPSILON) * 100) / 100
  const base = autoToNum(row?.maintenance_amount)
  const hasParts = row?.has_parts === true
  const hasGst = row?.has_gst === true
  const includesGst = row?.maintenance_amount_includes_gst === true
  let subtotal = Number.isFinite(base) ? base : 0
  if (!hasParts) {
    if (hasGst && !includesGst) subtotal += subtotal * 0.1
    return Math.round((subtotal + Number.EPSILON) * 100) / 100
  }
  const includesParts = row?.maintenance_amount_includes_parts === true
  if (!includesParts) subtotal += autoToNum(row?.parts_amount)
  if (hasGst && !includesGst) subtotal += subtotal * 0.1
  return Math.round((subtotal + Number.EPSILON) * 100) / 100
}

function autoComputeDeepCleaningTotalCost(laborCostRaw: any, consumablesRaw: any) {
  const labor = autoToNum(laborCostRaw)
  let arr: any[] = []
  let raw: any = consumablesRaw
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw) } catch { raw = [] }
  }
  if (Array.isArray(raw)) arr = raw
  const sum = arr.reduce((s, x) => s + autoToNum((x as any)?.cost), 0)
  return Math.round(((labor + sum) + Number.EPSILON) * 100) / 100
}

async function autoHasManualOverrideForRef(executor: any, refType: string, refId: string): Promise<boolean> {
  const r = await executor.query(
    `SELECT (
       EXISTS (SELECT 1 FROM property_expenses WHERE ref_type=$1 AND ref_id=$2 AND manual_override=true)
       OR EXISTS (SELECT 1 FROM company_expenses WHERE ref_type=$1 AND ref_id=$2 AND manual_override=true)
     ) AS ok`,
    [refType, refId]
  )
  return !!(r?.rows?.[0]?.ok)
}

async function autoUpsertPropertyExpenseByRef(client: any, input: { propertyId: string, occurredAt: string, amount: number, categoryDetail: string, generatedFrom: string, refType: string, refId: string, sourceTitle?: string, sourceSummary?: string, category?: string }) {
  const mk = autoMonthKey(input.occurredAt)
  const category = input.category || 'other'
  await client.query(
    `INSERT INTO property_expenses (id, property_id, occurred_at, amount, currency, category, category_detail, note, pay_method, generated_from, ref_type, ref_id, month_key, due_date, is_auto, source_title, source_summary)
     VALUES ($13,$1,$2,$3,'AUD',$4,$5,$6,'landlord_pay',$7,$8,$9,$10,$2,true,$11,$12)
     ON CONFLICT (ref_type, ref_id) WHERE ref_type IS NOT NULL AND ref_id IS NOT NULL DO UPDATE
     SET property_id=EXCLUDED.property_id, occurred_at=EXCLUDED.occurred_at, amount=EXCLUDED.amount, currency=EXCLUDED.currency, category=EXCLUDED.category,
         category_detail=EXCLUDED.category_detail, note=EXCLUDED.note, pay_method=EXCLUDED.pay_method, generated_from=EXCLUDED.generated_from,
         month_key=EXCLUDED.month_key, due_date=EXCLUDED.due_date, is_auto=EXCLUDED.is_auto, status=NULL, source_title=EXCLUDED.source_title, source_summary=EXCLUDED.source_summary`,
    [input.propertyId, input.occurredAt, input.amount, category, input.categoryDetail, `AUTO ${input.refType} ${input.refId}`, input.generatedFrom, input.refType, input.refId, mk, input.sourceTitle || null, input.sourceSummary || null, uuidv4()]
  )
}

async function autoUpsertCompanyExpenseByRef(client: any, input: { occurredAt: string, amount: number, categoryDetail: string, generatedFrom: string, refType: string, refId: string, sourceTitle?: string, sourceSummary?: string, category?: string }) {
  const mk = autoMonthKey(input.occurredAt)
  const category = input.category || 'other'
  await client.query(
    `INSERT INTO company_expenses (id, occurred_at, amount, currency, category, category_detail, note, generated_from, ref_type, ref_id, month_key, due_date, is_auto, source_title, source_summary)
     VALUES ($12,$1,$2,'AUD',$3,$4,$5,$6,$7,$8,$9,$1,true,$10,$11)
     ON CONFLICT (ref_type, ref_id) WHERE ref_type IS NOT NULL AND ref_id IS NOT NULL DO UPDATE
     SET occurred_at=EXCLUDED.occurred_at, amount=EXCLUDED.amount, currency=EXCLUDED.currency, category=EXCLUDED.category, category_detail=EXCLUDED.category_detail,
         note=EXCLUDED.note, generated_from=EXCLUDED.generated_from, month_key=EXCLUDED.month_key, due_date=EXCLUDED.due_date, is_auto=EXCLUDED.is_auto,
         status=NULL, source_title=EXCLUDED.source_title, source_summary=EXCLUDED.source_summary`,
    [input.occurredAt, input.amount, category, input.categoryDetail, `AUTO ${input.refType} ${input.refId}`, input.generatedFrom, input.refType, input.refId, mk, input.sourceTitle || null, input.sourceSummary || null, uuidv4()]
  )
}

function deriveAutoExpenseFields(kind: 'maintenance' | 'deep_cleaning' | 'daily_necessities', row: any) {
  if (kind === 'daily_necessities') {
    const decision = buildDailyNecessityAutoExpenseDecision(row)
    return {
      refType: decision.refType,
      refId: decision.refId,
      status: decision.status,
      payMethod: decision.payMethod,
      occurredAt: decision.occurredAt,
      amount: decision.amount,
      category: decision.category,
      categoryDetail: decision.categoryDetail,
      generatedFrom: decision.generatedFrom,
      sourceTitle: decision.sourceTitle,
      sourceSummary: decision.sourceSummary,
    }
  }
  const refId = String(row?.id || '')
  const categoryDetail = kind === 'maintenance' ? '维修' : '深度清洁'
  const amount = kind === 'maintenance'
    ? autoCalcMaintenanceTotal(row)
    : autoToNum(row?.total_cost ?? autoComputeDeepCleaningTotalCost(row?.labor_cost, row?.consumables))
  const sourceTitle = kind === 'deep_cleaning' ? (String(row?.work_no || refId).trim() ? `深度清洁 ${String(row?.work_no || refId).trim()}` : categoryDetail) : categoryDetail
  return {
    refType: kind,
    refId,
    status: autoNormStatus(row?.status),
    payMethod: autoNormPayMethod(row?.pay_method),
    occurredAt: autoToISODateOnly(row?.completed_at) || autoToISODateOnly(row?.occurred_at),
    amount,
    category: 'other',
    categoryDetail,
    generatedFrom: refId,
    sourceTitle,
    sourceSummary: kind === 'maintenance' ? maintenanceSourceSummary(row) : deepCleaningSourceSummary(row),
  }
}

export async function reconcileMonthlyAutoExpenses(input: { monthKey: string; propertyId: string }) {
  const monthKey = String(input.monthKey || '').trim()
  const propertyId = String(input.propertyId || '').trim()
  if (!/^\d{4}-\d{2}$/.test(monthKey)) throw new Error('invalid month')
  if (!propertyId) throw new Error('missing property_id')
  const start = `${monthKey}-01`
  const next = (() => {
    const y = Number(monthKey.slice(0, 4))
    const m = Number(monthKey.slice(5, 7))
    const d = new Date(Date.UTC(y, m, 1))
    return d.toISOString().slice(0, 10)
  })()
  return await pgRunInTransaction(async (client) => {
    const maintenanceRs = await client.query(
      `SELECT id, property_id, status, pay_method, maintenance_amount, has_parts, parts_amount, maintenance_amount_includes_parts, has_gst, maintenance_amount_includes_gst, total_amount, completed_at, occurred_at, created_at, details, repair_notes, invoice_description_en
       FROM property_maintenance
       WHERE property_id=$1
         AND coalesce(completed_at::date, occurred_at) >= $2::date
         AND coalesce(completed_at::date, occurred_at) < $3::date`,
      [propertyId, start, next]
    )
    const deepRs = await client.query(
      `SELECT id, property_id, status, pay_method, total_cost, labor_cost, consumables, completed_at, occurred_at, created_at, project_desc, details, notes, work_no, invoice_description_en
       FROM property_deep_cleaning
       WHERE property_id=$1
         AND coalesce(completed_at::date, occurred_at, created_at::date) >= $2::date
         AND coalesce(completed_at::date, occurred_at, created_at::date) < $3::date`,
      [propertyId, start, next]
    )
    const dailyTableState = await client.query(
      `SELECT to_regclass('public.property_daily_necessities') IS NOT NULL AS has_daily,
              to_regclass('public.daily_items_price_list') IS NOT NULL AS has_daily_prices`,
    )
    const hasDaily = !!dailyTableState?.rows?.[0]?.has_daily
    const hasDailyPrices = !!dailyTableState?.rows?.[0]?.has_daily_prices
    const dailyRs = hasDaily
      ? await client.query(
          hasDailyPrices
            ? `SELECT n.id, n.property_id, n.status, n.pay_method, n.item_id, n.item_name, n.quantity, n.note,
                      n.invoice_description_en, n.replacement_at, n.submitted_at, n.created_at,
                      COALESCE(p_id.unit_price, p_name.unit_price, 0) AS unit_price
                 FROM property_daily_necessities n
                 LEFT JOIN daily_items_price_list p_id ON p_id.id = n.item_id
                 LEFT JOIN LATERAL (
                   SELECT unit_price
                     FROM daily_items_price_list p
                    WHERE lower(p.item_name) = lower(n.item_name)
                    ORDER BY is_active DESC NULLS LAST, updated_at DESC NULLS LAST
                    LIMIT 1
                 ) p_name ON true
                WHERE n.property_id=$1
                  AND coalesce(n.replacement_at::date, n.submitted_at::date, n.created_at::date) >= $2::date
                  AND coalesce(n.replacement_at::date, n.submitted_at::date, n.created_at::date) < $3::date`
            : `SELECT n.id, n.property_id, n.status, n.pay_method, n.item_id, n.item_name, n.quantity, n.note,
                      n.invoice_description_en, n.replacement_at, n.submitted_at, n.created_at,
                      0 AS unit_price
                 FROM property_daily_necessities n
                WHERE n.property_id=$1
                  AND coalesce(n.replacement_at::date, n.submitted_at::date, n.created_at::date) >= $2::date
                  AND coalesce(n.replacement_at::date, n.submitted_at::date, n.created_at::date) < $3::date`,
          [propertyId, start, next],
        )
      : { rows: [] }
    const items = [
      ...(maintenanceRs.rows || []).map((row: any) => ({ kind: 'maintenance' as const, row })),
      ...(deepRs.rows || []).map((row: any) => ({ kind: 'deep_cleaning' as const, row })),
      ...(dailyRs.rows || []).map((row: any) => ({ kind: 'daily_necessities' as const, row })),
    ]
    let scanned = 0
    let upsertedProperty = 0
    let upsertedCompany = 0
    let voided = 0
    let skippedManualOverride = 0
    for (const it of items) {
      scanned++
      const row = it.row || {}
      const fields = deriveAutoExpenseFields(it.kind, row)
      const refType = fields.refType
      const refId = fields.refId
      if (!refId) continue
      if (await autoHasManualOverrideForRef(client, refType, refId)) {
        skippedManualOverride++
        continue
      }
      const status = fields.status
      const payMethod = fields.payMethod
      const occurredAt = fields.occurredAt
      const amount = fields.amount
      const category = fields.category
      const categoryDetail = fields.categoryDetail
      const generatedFrom = fields.generatedFrom
      const sourceTitle = fields.sourceTitle
      const sourceSummary = fields.sourceSummary
      const voidBoth = async () => {
        const v1 = await client.query(`UPDATE property_expenses SET status='void' WHERE ref_type=$1 AND ref_id=$2 AND is_auto=true AND coalesce(manual_override,false)=false`, [refType, refId])
        const v2 = await client.query(`UPDATE company_expenses SET status='void' WHERE ref_type=$1 AND ref_id=$2 AND is_auto=true AND coalesce(manual_override,false)=false`, [refType, refId])
        voided += Number(v1.rowCount || 0) + Number(v2.rowCount || 0)
      }
      if (status !== 'completed' || !(amount > 0) || !occurredAt) {
        await voidBoth()
        continue
      }
      if (payMethod === 'landlord_pay') {
        await client.query(`UPDATE company_expenses SET status='void' WHERE ref_type=$1 AND ref_id=$2 AND is_auto=true AND coalesce(manual_override,false)=false`, [refType, refId])
        await autoUpsertPropertyExpenseByRef(client, {
          propertyId,
          occurredAt,
          amount,
          category,
          categoryDetail,
          generatedFrom,
          refType,
          refId,
          sourceTitle,
          sourceSummary,
        })
        upsertedProperty++
        continue
      }
      if (payMethod === 'company_pay') {
        await client.query(`UPDATE property_expenses SET status='void' WHERE ref_type=$1 AND ref_id=$2 AND is_auto=true AND coalesce(manual_override,false)=false`, [refType, refId])
        await autoUpsertCompanyExpenseByRef(client, {
          occurredAt,
          amount,
          category,
          categoryDetail,
          generatedFrom,
          refType,
          refId,
          sourceTitle,
          sourceSummary,
        })
        upsertedCompany++
        continue
      }
      await voidBoth()
    }
    return { scanned, upsertedProperty, upsertedCompany, voided, skippedManualOverride }
  })
}
