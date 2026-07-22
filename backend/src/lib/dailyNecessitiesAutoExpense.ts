import { v4 as uuidv4 } from 'uuid'
import { dailyNecessitiesSourceSummary } from './autoExpenseSourceSummary'

export type DailyNecessityAutoExpenseDecision = {
  refType: 'daily_necessities'
  refId: string
  propertyId: string
  status: string
  payMethod: string
  occurredAt: string | null
  amount: number
  category: 'consumables'
  categoryDetail: string
  generatedFrom: string
  sourceTitle: string
  sourceSummary: string
}

function round2(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

function toNum(v: any): number {
  if (v === null || v === undefined || v === '') return 0
  const n0 = Number(v)
  if (Number.isFinite(n0)) return n0
  const s = String(v || '').replace(/[^0-9.\-]/g, '')
  const n1 = Number(s)
  return Number.isFinite(n1) ? n1 : 0
}

function toISODateOnly(v: any): string | null {
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

function monthKeyFromDateOnly(d: string | null): string | null {
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return null
  return `${d.slice(0, 4)}-${d.slice(5, 7)}`
}

export function normalizeDailyNecessityStatus(v: any): string {
  const s = String(v || '').trim()
  const low = s.toLowerCase()
  if (!low) return ''
  if (low === 'replaced' || low === 'completed' || s.includes('已更换') || s.includes('已完成') || s === '完成') return 'completed'
  if (low === 'need_replace' || s.includes('待更换')) return 'pending'
  if (low === 'no_action' || s.includes('无需')) return 'void'
  if (low === 'canceled' || low === 'cancelled' || s.includes('取消')) return 'void'
  return low
}

export function normalizeDailyNecessityPayMethod(v: any): string {
  const s = String(v || '').trim()
  const low = s.toLowerCase()
  if (!low) return ''
  if (low === 'landlord_pay' || s.includes('房东')) return 'landlord_pay'
  if (low === 'company_pay' || s.includes('公司')) return 'company_pay'
  if (low === 'rent_deduction' || s.includes('租金')) return 'rent_deduction'
  if (low === 'tenant_pay' || s.includes('房客')) return 'tenant_pay'
  if (low === 'other_pay' || s.includes('其他')) return 'other_pay'
  return low
}

export function computeDailyNecessityAmount(row: any): number {
  const quantity = Math.max(0, Math.trunc(toNum(row?.quantity || 0)))
  const unitPrice = toNum(row?.unit_price ?? row?.daily_unit_price ?? row?.price_unit_price)
  if (!(quantity > 0) || !(unitPrice > 0)) return 0
  return round2(quantity * unitPrice)
}

export function buildDailyNecessityAutoExpenseDecision(row: any): DailyNecessityAutoExpenseDecision {
  const refId = String(row?.id || '').trim()
  const itemName = String(row?.item_name || '').trim()
  const sourceTitle = itemName ? `日用品更换 ${itemName}` : '日用品更换'
  return {
    refType: 'daily_necessities',
    refId,
    propertyId: String(row?.property_id || '').trim(),
    status: normalizeDailyNecessityStatus(row?.status),
    payMethod: normalizeDailyNecessityPayMethod(row?.pay_method),
    occurredAt: toISODateOnly(row?.replacement_at) || toISODateOnly(row?.submitted_at) || toISODateOnly(row?.occurred_at) || toISODateOnly(row?.created_at),
    amount: computeDailyNecessityAmount(row),
    category: 'consumables',
    categoryDetail: '日用品更换',
    generatedFrom: refId,
    sourceTitle,
    sourceSummary: dailyNecessitiesSourceSummary(row),
  }
}

export async function enrichDailyNecessityPriceWithClient(client: any, row: any): Promise<any> {
  if (!client || row?.unit_price !== undefined || row?.daily_unit_price !== undefined || row?.price_unit_price !== undefined) return row
  const itemId = String(row?.item_id || '').trim()
  const itemName = String(row?.item_name || '').trim()
  if (!itemId && !itemName) return row
  try {
    const values: any[] = []
    const clauses: string[] = []
    if (itemId) {
      values.push(itemId)
      clauses.push(`id = $${values.length}`)
    }
    if (itemName) {
      values.push(itemName)
      clauses.push(`lower(item_name) = lower($${values.length})`)
    }
    const rs = await client.query(
      `SELECT unit_price
         FROM daily_items_price_list
        WHERE ${clauses.join(' OR ')}
        ORDER BY CASE WHEN id = $1 THEN 0 ELSE 1 END,
                 is_active DESC NULLS LAST,
                 updated_at DESC NULLS LAST
        LIMIT 1`,
      values,
    )
    const price = rs?.rows?.[0]?.unit_price
    return { ...row, unit_price: price == null ? 0 : Number(price || 0) }
  } catch {
    return { ...row, unit_price: 0 }
  }
}

async function ensureAutoExpenseSchema(client: any) {
  await client.query(`CREATE TABLE IF NOT EXISTS company_expenses (
    id text PRIMARY KEY,
    occurred_at date NOT NULL,
    amount numeric NOT NULL,
    currency text NOT NULL DEFAULT 'AUD',
    category text,
    category_detail text,
    note text,
    created_at timestamptz DEFAULT now(),
    month_key text,
    due_date date,
    status text,
    generated_from text,
    ref_type text,
    ref_id text,
    is_auto boolean DEFAULT false,
    manual_override boolean DEFAULT false,
    source_title text,
    source_summary text
  );`)
  await client.query(`CREATE TABLE IF NOT EXISTS property_expenses (
    id text PRIMARY KEY,
    property_id text,
    occurred_at date NOT NULL,
    amount numeric NOT NULL,
    currency text NOT NULL DEFAULT 'AUD',
    category text,
    category_detail text,
    note text,
    created_at timestamptz DEFAULT now(),
    month_key text,
    due_date date,
    status text,
    pay_method text,
    generated_from text,
    ref_type text,
    ref_id text,
    is_auto boolean DEFAULT false,
    manual_override boolean DEFAULT false,
    source_title text,
    source_summary text
  );`)
  const cols = [
    'ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS category_detail text',
    'ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS note text',
    'ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS month_key text',
    'ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS due_date date',
    'ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS status text',
    'ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS pay_method text',
    'ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS generated_from text',
    'ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS ref_type text',
    'ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS ref_id text',
    'ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS is_auto boolean DEFAULT false',
    'ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS manual_override boolean DEFAULT false',
    'ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS source_title text',
    'ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS source_summary text',
    'ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS category_detail text',
    'ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS note text',
    'ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS month_key text',
    'ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS due_date date',
    'ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS status text',
    'ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS generated_from text',
    'ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS ref_type text',
    'ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS ref_id text',
    'ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS is_auto boolean DEFAULT false',
    'ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS manual_override boolean DEFAULT false',
    'ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS source_title text',
    'ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS source_summary text',
  ]
  for (const sql of cols) await client.query(sql)
  await client.query("CREATE UNIQUE INDEX IF NOT EXISTS uniq_property_expenses_ref ON property_expenses(ref_type, ref_id) WHERE ref_type IS NOT NULL AND ref_id IS NOT NULL;")
  await client.query("CREATE UNIQUE INDEX IF NOT EXISTS uniq_company_expenses_ref ON company_expenses(ref_type, ref_id) WHERE ref_type IS NOT NULL AND ref_id IS NOT NULL;")
}

async function hasManualOverrideForRef(client: any, refType: string, refId: string): Promise<boolean> {
  const r = await client.query(
    `SELECT (
       EXISTS (SELECT 1 FROM property_expenses WHERE ref_type=$1 AND ref_id=$2 AND manual_override=true)
       OR EXISTS (SELECT 1 FROM company_expenses WHERE ref_type=$1 AND ref_id=$2 AND manual_override=true)
     ) AS ok`,
    [refType, refId],
  )
  return !!(r?.rows?.[0]?.ok)
}

async function voidAutoExpensesByRef(client: any, refType: string, refId: string) {
  await client.query(
    `UPDATE property_expenses
        SET status='void'
      WHERE ref_type=$1 AND ref_id=$2 AND is_auto=true AND coalesce(manual_override,false)=false`,
    [refType, refId],
  )
  await client.query(
    `UPDATE company_expenses
        SET status='void'
      WHERE ref_type=$1 AND ref_id=$2 AND is_auto=true AND coalesce(manual_override,false)=false`,
    [refType, refId],
  )
}

async function upsertAutoPropertyExpense(client: any, decision: DailyNecessityAutoExpenseDecision) {
  const mk = monthKeyFromDateOnly(decision.occurredAt)
  await client.query(
    `INSERT INTO property_expenses (id, property_id, occurred_at, amount, currency, category, category_detail, note, pay_method, generated_from, ref_type, ref_id, month_key, due_date, is_auto, source_title, source_summary)
     VALUES ($1,$2,$3,$4,'AUD',$5,$6,$7,'landlord_pay',$8,$9,$10,$11,$3,true,$12,$13)
     ON CONFLICT (ref_type, ref_id) WHERE ref_type IS NOT NULL AND ref_id IS NOT NULL DO UPDATE
     SET property_id=EXCLUDED.property_id, occurred_at=EXCLUDED.occurred_at, amount=EXCLUDED.amount, currency=EXCLUDED.currency, category=EXCLUDED.category,
         category_detail=EXCLUDED.category_detail, note=EXCLUDED.note, pay_method=EXCLUDED.pay_method, generated_from=EXCLUDED.generated_from,
         month_key=EXCLUDED.month_key, due_date=EXCLUDED.due_date, is_auto=EXCLUDED.is_auto, status=NULL,
         source_title=EXCLUDED.source_title, source_summary=EXCLUDED.source_summary`,
    [uuidv4(), decision.propertyId, decision.occurredAt, decision.amount, decision.category, decision.categoryDetail, `AUTO ${decision.refType} ${decision.refId}`, decision.generatedFrom, decision.refType, decision.refId, mk, decision.sourceTitle || null, decision.sourceSummary || null],
  )
}

async function upsertAutoCompanyExpense(client: any, decision: DailyNecessityAutoExpenseDecision) {
  const mk = monthKeyFromDateOnly(decision.occurredAt)
  await client.query(
    `INSERT INTO company_expenses (id, occurred_at, amount, currency, category, category_detail, note, generated_from, ref_type, ref_id, month_key, due_date, is_auto, source_title, source_summary)
     VALUES ($1,$2,$3,'AUD',$4,$5,$6,$7,$8,$9,$10,$2,true,$11,$12)
     ON CONFLICT (ref_type, ref_id) WHERE ref_type IS NOT NULL AND ref_id IS NOT NULL DO UPDATE
     SET occurred_at=EXCLUDED.occurred_at, amount=EXCLUDED.amount, currency=EXCLUDED.currency, category=EXCLUDED.category, category_detail=EXCLUDED.category_detail,
         note=EXCLUDED.note, generated_from=EXCLUDED.generated_from, month_key=EXCLUDED.month_key, due_date=EXCLUDED.due_date, is_auto=EXCLUDED.is_auto,
         status=NULL, source_title=EXCLUDED.source_title, source_summary=EXCLUDED.source_summary`,
    [uuidv4(), decision.occurredAt, decision.amount, decision.category, decision.categoryDetail, `AUTO ${decision.refType} ${decision.refId}`, decision.generatedFrom, decision.refType, decision.refId, mk, decision.sourceTitle || null, decision.sourceSummary || null],
  )
}

export async function syncDailyNecessityAutoExpenseWithClient(client: any, row: any) {
  await ensureAutoExpenseSchema(client)
  const priced = await enrichDailyNecessityPriceWithClient(client, row)
  const decision = buildDailyNecessityAutoExpenseDecision(priced)
  if (!decision.refId) return { ok: true, skipped: true, error: 'missing_ref_id' }
  if (await hasManualOverrideForRef(client, decision.refType, decision.refId)) {
    return { ok: true, skipped: true, error: 'manual_override' }
  }
  if (decision.status !== 'completed' || !(decision.amount > 0) || !decision.occurredAt) {
    await voidAutoExpensesByRef(client, decision.refType, decision.refId)
    return { ok: true, skipped: false, error: decision.amount > 0 ? '' : 'missing_price' }
  }
  if (decision.payMethod === 'landlord_pay') {
    if (!decision.propertyId) {
      await voidAutoExpensesByRef(client, decision.refType, decision.refId)
      return { ok: true, skipped: true, error: 'missing_property_id' }
    }
    await client.query(
      `UPDATE company_expenses
          SET status='void'
        WHERE ref_type=$1 AND ref_id=$2 AND is_auto=true AND coalesce(manual_override,false)=false`,
      [decision.refType, decision.refId],
    )
    await upsertAutoPropertyExpense(client, decision)
    return { ok: true, skipped: false, error: '' }
  }
  if (decision.payMethod === 'company_pay') {
    await client.query(
      `UPDATE property_expenses
          SET status='void'
        WHERE ref_type=$1 AND ref_id=$2 AND is_auto=true AND coalesce(manual_override,false)=false`,
      [decision.refType, decision.refId],
    )
    await upsertAutoCompanyExpense(client, decision)
    return { ok: true, skipped: false, error: '' }
  }
  await voidAutoExpensesByRef(client, decision.refType, decision.refId)
  return { ok: true, skipped: false, error: '' }
}
