import { pgRunInTransaction } from '../dbAdapter'
import { v4 as uuidv4 } from 'uuid'

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

function autoToSummaryText(v: any, maxLen = 260): string {
  try {
    if (v === null || v === undefined) return ''
    const s = typeof v === 'string' ? v.trim() : JSON.stringify(v)
    return String(s || '').trim().slice(0, maxLen)
  } catch {
    return String(v || '').trim().slice(0, maxLen)
  }
}

function autoPickSummaryFromDetails(raw: any): string {
  if (!raw) return ''
  let v: any = raw
  if (typeof v === 'string') {
    const s = v.trim()
    if (!s) return ''
    try { v = JSON.parse(s) } catch { return autoToSummaryText(s) }
  }
  if (Array.isArray(v)) {
    for (const item of v) {
      const txt = autoToSummaryText((item as any)?.content || (item as any)?.title || (item as any)?.item || (item as any)?.desc)
      if (txt) return txt
    }
  }
  if (typeof v === 'object') {
    return autoToSummaryText((v as any)?.content || (v as any)?.title || (v as any)?.item || (v as any)?.desc)
  }
  return autoToSummaryText(v)
}

function autoMaintenanceIssueSummary(row: any): string {
  const a = autoPickSummaryFromDetails(row?.details)
  if (a) return a
  const b = autoToSummaryText(row?.repair_notes)
  if (b) return b
  return autoToSummaryText(row?.category)
}

function autoDeepCleaningProjectSummary(row: any): string {
  const a = autoToSummaryText(row?.project_desc)
  if (a) return a
  const b = autoPickSummaryFromDetails(row?.details)
  if (b) return b
  return autoToSummaryText(row?.notes)
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

async function autoUpsertPropertyExpenseByRef(client: any, input: { propertyId: string, occurredAt: string, amount: number, categoryDetail: string, generatedFrom: string, refType: string, refId: string, sourceTitle?: string, sourceSummary?: string }) {
  const mk = autoMonthKey(input.occurredAt)
  await client.query(
    `INSERT INTO property_expenses (id, property_id, occurred_at, amount, currency, category, category_detail, note, pay_method, generated_from, ref_type, ref_id, month_key, due_date, is_auto, source_title, source_summary)
     VALUES ($12,$1,$2,$3,'AUD','other',$4,$5,'landlord_pay',$6,$7,$8,$9,$2,true,$10,$11)
     ON CONFLICT (ref_type, ref_id) WHERE ref_type IS NOT NULL AND ref_id IS NOT NULL DO UPDATE
     SET property_id=EXCLUDED.property_id, occurred_at=EXCLUDED.occurred_at, amount=EXCLUDED.amount, currency=EXCLUDED.currency, category=EXCLUDED.category,
         category_detail=EXCLUDED.category_detail, note=EXCLUDED.note, pay_method=EXCLUDED.pay_method, generated_from=EXCLUDED.generated_from,
         month_key=EXCLUDED.month_key, due_date=EXCLUDED.due_date, is_auto=EXCLUDED.is_auto, source_title=EXCLUDED.source_title, source_summary=EXCLUDED.source_summary`,
    [input.propertyId, input.occurredAt, input.amount, input.categoryDetail, `AUTO ${input.refType} ${input.refId}`, input.generatedFrom, input.refType, input.refId, mk, input.sourceTitle || null, input.sourceSummary || null, uuidv4()]
  )
}

async function autoUpsertCompanyExpenseByRef(client: any, input: { occurredAt: string, amount: number, categoryDetail: string, generatedFrom: string, refType: string, refId: string, sourceTitle?: string, sourceSummary?: string }) {
  const mk = autoMonthKey(input.occurredAt)
  await client.query(
    `INSERT INTO company_expenses (id, occurred_at, amount, currency, category, category_detail, note, generated_from, ref_type, ref_id, month_key, due_date, is_auto, source_title, source_summary)
     VALUES ($11,$1,$2,'AUD','other',$3,$4,$5,$6,$7,$8,$1,true,$9,$10)
     ON CONFLICT (ref_type, ref_id) WHERE ref_type IS NOT NULL AND ref_id IS NOT NULL DO UPDATE
     SET occurred_at=EXCLUDED.occurred_at, amount=EXCLUDED.amount, currency=EXCLUDED.currency, category=EXCLUDED.category, category_detail=EXCLUDED.category_detail,
         note=EXCLUDED.note, generated_from=EXCLUDED.generated_from, month_key=EXCLUDED.month_key, due_date=EXCLUDED.due_date, is_auto=EXCLUDED.is_auto,
         source_title=EXCLUDED.source_title, source_summary=EXCLUDED.source_summary`,
    [input.occurredAt, input.amount, input.categoryDetail, `AUTO ${input.refType} ${input.refId}`, input.generatedFrom, input.refType, input.refId, mk, input.sourceTitle || null, input.sourceSummary || null, uuidv4()]
  )
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
      `SELECT id, property_id, status, pay_method, maintenance_amount, has_parts, parts_amount, maintenance_amount_includes_parts, has_gst, maintenance_amount_includes_gst, total_amount, completed_at, occurred_at, created_at, details, repair_notes, category
       FROM property_maintenance
       WHERE property_id=$1
         AND coalesce(completed_at::date, occurred_at, created_at::date) >= $2::date
         AND coalesce(completed_at::date, occurred_at, created_at::date) < $3::date`,
      [propertyId, start, next]
    )
    const deepRs = await client.query(
      `SELECT id, property_id, status, pay_method, total_cost, labor_cost, consumables, completed_at, occurred_at, created_at, project_desc, details, notes, work_no
       FROM property_deep_cleaning
       WHERE property_id=$1
         AND coalesce(completed_at::date, occurred_at, created_at::date) >= $2::date
         AND coalesce(completed_at::date, occurred_at, created_at::date) < $3::date`,
      [propertyId, start, next]
    )
    const items = [
      ...(maintenanceRs.rows || []).map((row: any) => ({ kind: 'maintenance' as const, row })),
      ...(deepRs.rows || []).map((row: any) => ({ kind: 'deep_cleaning' as const, row })),
    ]
    let scanned = 0
    let upsertedProperty = 0
    let upsertedCompany = 0
    let voided = 0
    let skippedManualOverride = 0
    for (const it of items) {
      scanned++
      const refType = it.kind
      const row = it.row || {}
      const refId = String(row?.id || '')
      if (!refId) continue
      if (await autoHasManualOverrideForRef(client, refType, refId)) {
        skippedManualOverride++
        continue
      }
      const status = autoNormStatus(row?.status)
      const payMethod = autoNormPayMethod(row?.pay_method)
      const occurredAt = autoToISODateOnly(row?.completed_at) || autoToISODateOnly(row?.occurred_at) || autoToISODateOnly(row?.created_at)
      const amount = it.kind === 'maintenance'
        ? autoCalcMaintenanceTotal(row)
        : autoToNum(row?.total_cost ?? autoComputeDeepCleaningTotalCost(row?.labor_cost, row?.consumables))
      const categoryDetail = it.kind === 'maintenance' ? '维修' : '深度清洁'
      const sourceTitle = it.kind === 'deep_cleaning' ? (String(row?.work_no || refId).trim() ? `深度清洁 ${String(row?.work_no || refId).trim()}` : categoryDetail) : categoryDetail
      const sourceSummary = it.kind === 'maintenance' ? autoMaintenanceIssueSummary(row) : autoDeepCleaningProjectSummary(row)
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
          categoryDetail,
          generatedFrom: refId,
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
          categoryDetail,
          generatedFrom: refId,
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
