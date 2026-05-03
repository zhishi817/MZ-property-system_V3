import path from 'path'
import dotenv from 'dotenv'
import { v4 as uuidv4 } from 'uuid'
import { deepCleaningSourceSummary, maintenanceSourceSummary } from '../src/lib/autoExpenseSourceSummary'

dotenv.config({ path: path.join(process.cwd(), '.env.local'), override: true })
dotenv.config({ path: path.join(process.cwd(), '..', '.env.local'), override: true })
dotenv.config()

const { pgPool, pgRunInTransaction } = require('../src/dbAdapter') as typeof import('../src/dbAdapter')

function toDateOnly(v: any): string | null {
  if (!v) return null
  if (typeof v === 'string') {
    const s = v.trim()
    if (!s) return null
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
    const d0 = new Date(s)
    if (!Number.isNaN(d0.getTime())) return d0.toISOString().slice(0, 10)
    return null
  }
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10)
  try {
    const d = new Date(v)
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10)
  } catch {}
  return null
}

function toNum(v: any): number {
  if (v === null || v === undefined || v === '') return 0
  const n0 = Number(v)
  if (Number.isFinite(n0)) return n0
  const s = String(v || '').replace(/[^0-9.\-]/g, '')
  const n1 = Number(s)
  return Number.isFinite(n1) ? n1 : 0
}

function normStatus(v: any): string {
  const s = String(v || '').trim()
  const low = s.toLowerCase()
  if (!low) return ''
  if (low === 'completed' || s.includes('已完成') || s === '完成') return 'completed'
  if (low === 'canceled' || s.includes('取消')) return 'canceled'
  return low
}

function normPayMethod(v: any): string {
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

function monthKeyOf(dateOnly: string | null) {
  if (!dateOnly || !/^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) return null
  return `${dateOnly.slice(0, 4)}-${dateOnly.slice(5, 7)}`
}

function calcMaintenanceTotal(row: any): number {
  const explicitTotal = toNum(row?.total_amount)
  if (Number.isFinite(explicitTotal) && explicitTotal > 0) return Math.round((explicitTotal + Number.EPSILON) * 100) / 100
  const base = toNum(row?.maintenance_amount)
  const hasParts = row?.has_parts === true
  const hasGst = row?.has_gst === true
  const includesGst = row?.maintenance_amount_includes_gst === true
  let subtotal = Number.isFinite(base) ? base : 0
  if (!hasParts) {
    if (hasGst && !includesGst) subtotal += subtotal * 0.1
    return Math.round((subtotal + Number.EPSILON) * 100) / 100
  }
  const includesParts = row?.maintenance_amount_includes_parts === true
  if (!includesParts) subtotal += toNum(row?.parts_amount)
  if (hasGst && !includesGst) subtotal += subtotal * 0.1
  return Math.round((subtotal + Number.EPSILON) * 100) / 100
}

function calcDeepCleaningTotal(row: any): number {
  const raw = row?.total_cost !== undefined && row?.total_cost !== null ? row.total_cost : null
  if (raw !== null) return toNum(raw)
  const labor = toNum(row?.labor_cost)
  let items: any[] = []
  let consumables: any = row?.consumables
  if (typeof consumables === 'string') {
    try { consumables = JSON.parse(consumables) } catch { consumables = [] }
  }
  if (Array.isArray(consumables)) items = consumables
  const sum = items.reduce((acc, item) => acc + toNum(item?.cost), 0)
  return Math.round(((labor + sum) + Number.EPSILON) * 100) / 100
}

async function ensureAutoExpenseSchema(client: any) {
  const must = async (sql: string) => { try { await client.query(sql) } catch {} }
  await must('ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS manual_override boolean DEFAULT false;')
  await must('ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS source_title text;')
  await must('ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS source_summary text;')
  await must('ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS is_auto boolean DEFAULT false;')
  await must('ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS manual_override boolean DEFAULT false;')
  await must('ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS source_title text;')
  await must('ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS source_summary text;')
  await must('ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS is_auto boolean DEFAULT false;')
}

async function hasManualOverrideForRef(executor: any, refType: string, refId: string): Promise<boolean> {
  const r = await executor.query(
    `SELECT (
       EXISTS (SELECT 1 FROM property_expenses WHERE ref_type=$1 AND ref_id=$2 AND manual_override=true)
       OR EXISTS (SELECT 1 FROM company_expenses WHERE ref_type=$1 AND ref_id=$2 AND manual_override=true)
     ) AS ok`,
    [refType, refId],
  )
  return !!(r?.rows?.[0]?.ok)
}

async function upsertPropertyExpenseByRef(client: any, input: {
  propertyId: string
  occurredAt: string
  amount: number
  categoryDetail: string
  generatedFrom: string
  refType: string
  refId: string
  sourceTitle?: string | null
  sourceSummary?: string | null
}) {
  const mk = monthKeyOf(input.occurredAt)
  await client.query(
    `INSERT INTO property_expenses (id, property_id, occurred_at, amount, currency, category, category_detail, note, pay_method, generated_from, ref_type, ref_id, month_key, due_date, is_auto, source_title, source_summary)
     VALUES ($12,$1,$2,$3,'AUD','other',$4,$5,'landlord_pay',$6,$7,$8,$9,$2,true,$10,$11)
     ON CONFLICT (ref_type, ref_id) WHERE ref_type IS NOT NULL AND ref_id IS NOT NULL DO UPDATE
     SET property_id=EXCLUDED.property_id, occurred_at=EXCLUDED.occurred_at, amount=EXCLUDED.amount, currency=EXCLUDED.currency, category=EXCLUDED.category,
         category_detail=EXCLUDED.category_detail, note=EXCLUDED.note, pay_method=EXCLUDED.pay_method, generated_from=EXCLUDED.generated_from,
         month_key=EXCLUDED.month_key, due_date=EXCLUDED.due_date, is_auto=EXCLUDED.is_auto, source_title=EXCLUDED.source_title, source_summary=EXCLUDED.source_summary`,
    [input.propertyId, input.occurredAt, input.amount, input.categoryDetail, `AUTO ${input.refType} ${input.refId}`, input.generatedFrom, input.refType, input.refId, mk, input.sourceTitle || null, input.sourceSummary || null, uuidv4()],
  )
}

async function upsertCompanyExpenseByRef(client: any, input: {
  occurredAt: string
  amount: number
  categoryDetail: string
  generatedFrom: string
  refType: string
  refId: string
  sourceTitle?: string | null
  sourceSummary?: string | null
}) {
  const mk = monthKeyOf(input.occurredAt)
  await client.query(
    `INSERT INTO company_expenses (id, occurred_at, amount, currency, category, category_detail, note, generated_from, ref_type, ref_id, month_key, due_date, is_auto, source_title, source_summary)
     VALUES ($11,$1,$2,'AUD','other',$3,$4,$5,$6,$7,$8,$1,true,$9,$10)
     ON CONFLICT (ref_type, ref_id) WHERE ref_type IS NOT NULL AND ref_id IS NOT NULL DO UPDATE
     SET occurred_at=EXCLUDED.occurred_at, amount=EXCLUDED.amount, currency=EXCLUDED.currency, category=EXCLUDED.category, category_detail=EXCLUDED.category_detail,
         note=EXCLUDED.note, generated_from=EXCLUDED.generated_from, month_key=EXCLUDED.month_key, due_date=EXCLUDED.due_date, is_auto=EXCLUDED.is_auto,
         source_title=EXCLUDED.source_title, source_summary=EXCLUDED.source_summary`,
    [input.occurredAt, input.amount, input.categoryDetail, `AUTO ${input.refType} ${input.refId}`, input.generatedFrom, input.refType, input.refId, mk, input.sourceTitle || null, input.sourceSummary || null, uuidv4()],
  )
}

async function collectSourceItems(executor: any, input: {
  from: string
  to: string
  limit: number
  type: 'maintenance' | 'deep_cleaning' | 'all'
  propertyId?: string
}) {
  const propertyId = String(input.propertyId || '').trim()
  const items: Array<{ kind: 'maintenance' | 'deep_cleaning'; row: any }> = []
  if (input.type === 'all' || input.type === 'maintenance') {
    const mt = await executor.query(
      `SELECT id, property_id, status, pay_method, work_no, maintenance_amount, has_parts, parts_amount, maintenance_amount_includes_parts, has_gst, maintenance_amount_includes_gst, total_amount, completed_at, occurred_at, created_at, details, repair_notes, invoice_description_en
         FROM property_maintenance
        WHERE coalesce(completed_at::date, occurred_at) BETWEEN $1::date AND $2::date
          AND ($4::text IS NULL OR $4::text = '' OR property_id = $4::text)
        ORDER BY coalesce(completed_at::date, occurred_at) ASC
        LIMIT $3`,
      [input.from, input.to, input.limit, propertyId],
    )
    for (const row of mt.rows || []) items.push({ kind: 'maintenance', row })
  }
  if (input.type === 'all' || input.type === 'deep_cleaning') {
    const dc = await executor.query(
      `SELECT id, property_id, status, pay_method, work_no, total_cost, labor_cost, consumables, completed_at, occurred_at, created_at, project_desc, details, notes, invoice_description_en
         FROM property_deep_cleaning
        WHERE coalesce(completed_at::date, occurred_at, created_at::date) BETWEEN $1::date AND $2::date
          AND ($4::text IS NULL OR $4::text = '' OR property_id = $4::text)
        ORDER BY coalesce(completed_at::date, occurred_at, created_at::date) ASC
        LIMIT $3`,
      [input.from, input.to, input.limit, propertyId],
    )
    for (const row of dc.rows || []) items.push({ kind: 'deep_cleaning', row })
  }
  return items
}

type BackfillStats = {
  dry_run: boolean
  range: { from: string; to: string }
  type: string
  property_id: string | null
  limit: number
  scanned: number
  upserted_property?: number
  upserted_company?: number
  voided?: number
  cleaned_opposite?: number
  skipped_manual_override: number
  would_property?: number
  would_company?: number
  would_void?: number
  would_cleaned_opposite?: number
}

async function main() {
  if (!pgPool) throw new Error('DATABASE_URL not set')

  const from = String(process.env.AUTO_EXPENSES_FROM || process.env.DRYRUN_FROM || '2000-01-01').slice(0, 10)
  const to = String(process.env.AUTO_EXPENSES_TO || process.env.DRYRUN_TO || '2100-01-01').slice(0, 10)
  const limit = Math.max(1, Math.min(20000, Number(process.env.AUTO_EXPENSES_LIMIT || process.env.DRYRUN_LIMIT || 5000)))
  const typeRaw = String(process.env.AUTO_EXPENSES_TYPE || 'all').trim()
  const type = (typeRaw === 'maintenance' || typeRaw === 'deep_cleaning') ? typeRaw : 'all'
  const propertyId = String(process.env.AUTO_EXPENSES_PROPERTY_ID || '').trim() || null
  const dryRunRaw = String(process.env.AUTO_EXPENSES_DRY_RUN || '1').trim().toLowerCase()
  const dryRun = !(dryRunRaw === '0' || dryRunRaw === 'false' || dryRunRaw === 'no')

  const items = await collectSourceItems(pgPool, { from, to, limit, type, propertyId: propertyId || undefined })
  const scanned = items.length

  if (dryRun) {
    const out: BackfillStats = {
      dry_run: true,
      range: { from, to },
      type,
      property_id: propertyId,
      limit,
      scanned,
      would_property: 0,
      would_company: 0,
      would_void: 0,
      would_cleaned_opposite: 0,
      skipped_manual_override: 0,
    }
    for (const it of items) {
      const refType = it.kind
      const row = it.row || {}
      const refId = String(row?.id || '')
      if (!refId) continue
      if (await hasManualOverrideForRef(pgPool, refType, refId)) {
        out.skipped_manual_override++
        continue
      }
      const status = normStatus(row?.status)
      const payMethod = normPayMethod(row?.pay_method)
      const occurredAt = toDateOnly(row?.completed_at) || toDateOnly(row?.occurred_at)
      const amount = it.kind === 'maintenance' ? calcMaintenanceTotal(row) : calcDeepCleaningTotal(row)
      if (status !== 'completed' || !(amount > 0) || !occurredAt) {
        out.would_void!++
        continue
      }
      if (payMethod === 'landlord_pay') {
        out.would_property!++
        out.would_cleaned_opposite!++
        continue
      }
      if (payMethod === 'company_pay') {
        out.would_company!++
        out.would_cleaned_opposite!++
        continue
      }
      out.would_void!++
    }
    console.log(JSON.stringify(out, null, 2))
    return
  }

  const out = await pgRunInTransaction<BackfillStats>(async (client) => {
    await ensureAutoExpenseSchema(client)
    const stats: BackfillStats = {
      dry_run: false,
      range: { from, to },
      type,
      property_id: propertyId,
      limit,
      scanned,
      upserted_property: 0,
      upserted_company: 0,
      voided: 0,
      cleaned_opposite: 0,
      skipped_manual_override: 0,
    }

    for (const it of items) {
      const refType = it.kind
      const row = it.row || {}
      const refId = String(row?.id || '')
      if (!refId) continue
      if (await hasManualOverrideForRef(client, refType, refId)) {
        stats.skipped_manual_override++
        continue
      }

      const status = normStatus(row?.status)
      const payMethod = normPayMethod(row?.pay_method)
      const occurredAt = toDateOnly(row?.completed_at) || toDateOnly(row?.occurred_at)
      const amount = it.kind === 'maintenance' ? calcMaintenanceTotal(row) : calcDeepCleaningTotal(row)
      const sourceTitle = it.kind === 'deep_cleaning'
        ? (String(row?.work_no || refId).trim() ? `深度清洁 ${String(row?.work_no || refId).trim()}` : '深度清洁')
        : '维修'
      const sourceSummary = it.kind === 'maintenance' ? maintenanceSourceSummary(row) : deepCleaningSourceSummary(row)
      const categoryDetail = it.kind === 'maintenance' ? '维修' : '深度清洁'
      const propertyIdValue = String(row?.property_id || '').trim()

      const voidBoth = async () => {
        const v1 = await client.query(
          `UPDATE property_expenses
              SET status='void'
            WHERE ref_type=$1 AND ref_id=$2 AND is_auto=true AND (manual_override IS NULL OR manual_override=false)`,
          [refType, refId],
        )
        const v2 = await client.query(
          `UPDATE company_expenses
              SET status='void'
            WHERE ref_type=$1 AND ref_id=$2 AND is_auto=true AND (manual_override IS NULL OR manual_override=false)`,
          [refType, refId],
        )
        stats.voided! += Number(v1.rowCount || 0) + Number(v2.rowCount || 0)
      }

      if (status !== 'completed' || !(amount > 0) || !occurredAt) {
        await voidBoth()
        continue
      }

      if (payMethod === 'landlord_pay') {
        if (!propertyIdValue) {
          await voidBoth()
          continue
        }
        const cleaned = await client.query(
          `UPDATE company_expenses
              SET status='void'
            WHERE ref_type=$1 AND ref_id=$2 AND is_auto=true AND (manual_override IS NULL OR manual_override=false)`,
          [refType, refId],
        )
        stats.cleaned_opposite! += Number(cleaned.rowCount || 0)
        await upsertPropertyExpenseByRef(client, {
          propertyId: propertyIdValue,
          occurredAt,
          amount,
          categoryDetail,
          generatedFrom: refId,
          refType,
          refId,
          sourceTitle,
          sourceSummary,
        })
        stats.upserted_property!++
        continue
      }

      if (payMethod === 'company_pay') {
        const cleaned = await client.query(
          `UPDATE property_expenses
              SET status='void'
            WHERE ref_type=$1 AND ref_id=$2 AND is_auto=true AND (manual_override IS NULL OR manual_override=false)`,
          [refType, refId],
        )
        stats.cleaned_opposite! += Number(cleaned.rowCount || 0)
        await upsertCompanyExpenseByRef(client, {
          occurredAt,
          amount,
          categoryDetail,
          generatedFrom: refId,
          refType,
          refId,
          sourceTitle,
          sourceSummary,
        })
        stats.upserted_company!++
        continue
      }

      await voidBoth()
    }

    return stats
  })

  console.log(JSON.stringify(out, null, 2))
}

main().then(() => {
  if (pgPool) return pgPool.end()
  return undefined
}).catch(async (e: any) => {
  console.error(JSON.stringify({ ok: false, error: String(e?.message || e || '') }, null, 2))
  try { if (pgPool) await pgPool.end() } catch {}
  process.exitCode = 1
})
