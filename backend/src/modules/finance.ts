import { Router } from 'express'
import { db, FinanceTransaction, Payout, CompanyPayout, PropertyRevenueStatus, addAudit } from '../store'
import { hasPg, pgSelect, pgInsert, pgUpdate, pgDelete, pgRunInTransaction } from '../dbAdapter'
import multer from 'multer'
import path from 'path'
import { hasR2, r2Upload } from '../r2'
import fs from 'fs'
import { z } from 'zod'
import { buildExpenseFingerprint, hasFingerprint, setFingerprint, addDedupLog } from '../fingerprint'
import { requirePerm, requireAnyPerm } from '../auth'
import { PDFDocument } from 'pdf-lib'
import { pgInsertOnConflictDoNothing, pgPool } from '../dbAdapter'
import { getChromiumBrowser, resetChromiumBrowser } from '../lib/playwright'
import { pdfTaskLimiter } from '../lib/pdfTaskLimiter'
import { renderMonthlyStatementPdfHtml } from '../lib/monthlyStatementPdfTemplate'
import { waitForImages } from '../lib/waitForImages'
import { resizeUploadImage } from '../lib/uploadImageResize'
import { normalizePhotoUrlForPdf } from '../lib/normalizePhotoUrlForPdf'
import { v4 as uuidv4 } from 'uuid'
import { ensurePdfJobsSchema } from '../services/pdfJobsSchema'
import { r2GetObjectByKey } from '../r2'
import { computeMonthSegmentsForOrders, sumSegmentsVisibleNetIncome } from '../lib/orderMonthSegments'
import { countPhotoUrls, loadMonthlyStatementPhotoRows, recordHasPhotoUrls } from '../lib/monthlyStatementPhotoRecords'
import { ensureManagementFeeRulesTable, resolveManagementFeeRateForMonth } from '../lib/managementFeeRules'
import { generateStatementPhotoPackPdf, type StatementPhotoPackSection } from '../lib/monthlyStatementPhotoPack'

export const router = Router()
const upload = hasR2 ? multer({ storage: multer.memoryStorage() }) : multer({ dest: path.join(process.cwd(), 'uploads') })
const memUpload = multer({ storage: multer.memoryStorage() })
const mergeMaxMb = Math.max(5, Math.min(200, Number(process.env.MERGE_PDF_MAX_MB || 50)))
const mergeUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: mergeMaxMb * 1024 * 1024 } })

function toReportCat(raw?: string, detail?: string): string {
  const v = String(raw||'').toLowerCase()
  const d = String(detail||'').toLowerCase()
  const s = v + ' ' + d
  if (['carpark'].includes(v) || s.includes('车位')) return 'parking_fee'
  if (['owners_corp','ownerscorp','body_corp','bodycorp'].includes(v) || s.includes('物业')) return 'body_corp'
  if (['internet','nbn'].includes(v) || s.includes('internet') || s.includes('nbn') || s.includes('网')) return 'internet'
  if (['electricity'].includes(v) || s.includes('electric') || s.includes('电')) return 'electricity'
  if (['water'].includes(v) || ((s.includes('water') || s.includes('水')) && !s.includes('热'))) return 'water'
  if (['gas','gas_hot_water','hot_water'].includes(v) || s.includes('gas') || s.includes('热水') || s.includes('煤气')) return 'gas'
  if (['consumables'].includes(v) || s.includes('consumable') || s.includes('消耗')) return 'consumables'
  if (['council_rate','council'].includes(v) || s.includes('council') || s.includes('市政')) return 'council'
  if (s.includes('management_fee') || s.includes('管理费')) return 'management_fee'
  return 'other'
}

function pdfLimiter(req: any, res: any, next: any) {
  pdfTaskLimiter.acquire().then((release) => {
    let done = false
    const once = () => {
      if (done) return
      done = true
      try { release() } catch {}
    }
    res.on('finish', once)
    res.on('close', once)
    try { res.on('error', once) } catch {}
    next()
  }).catch(() => {
    return res.status(429).json({ message: 'PDF任务繁忙，请稍后重试' })
  })
}

function isPlaywrightClosedError(e: any) {
  const msg = String(e?.message || '')
  return /(Target page, context or browser has been closed|browser has been closed|browser disconnected|Target closed)/i.test(msg)
}

function kickPdfJobsSoon(reason: string) {
  setTimeout(() => {
    ;(async () => {
      try {
        const { processPdfJobsOnce } = require('../services/pdfJobsWorker')
        const limit = Math.min(2, Math.max(1, Number(process.env.PDF_JOBS_KICK_LIMIT || 1)))
        const r = await processPdfJobsOnce({ limit })
        try {
          console.log(`[pdf-jobs][kick] reason=${reason} processed=${r?.processed || 0} ok=${r?.ok || 0} failed=${r?.failed || 0} reclaimed=${r?.reclaimed || 0}`)
        } catch {}
      } catch (e: any) {
        try { console.log(`[pdf-jobs][kick] reason=${reason} failed message=${String(e?.message || '')}`) } catch {}
      }
    })()
  }, 0)
}

function monthRangeISO(monthKey: string): { start: string; end: string } | null {
  const m = String(monthKey || '').trim()
  const mm = m.match(/^(\d{4})-(\d{2})$/)
  if (!mm) return null
  const y = Number(mm[1])
  const mo = Number(mm[2])
  if (!Number.isFinite(y) || !Number.isFinite(mo) || mo < 1 || mo > 12) return null
  const start = new Date(Date.UTC(y, mo - 1, 1))
  const end = new Date(Date.UTC(y, mo, 1))
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) }
}

router.get('/', async (req, res) => {
  try {
    if (hasPg) {
      const q: any = req.query || {}
      const from = autoToISODateOnly(q.from)
      const to = autoToISODateOnly(q.to)
      const pid = String(q.property_id || '').trim()
      let rows: any[] = []
      if (pgPool && (from || to || pid)) {
        const vals: any[] = []
        const where: string[] = []
        if (pid) {
          vals.push(pid)
          where.push(`property_id = $${vals.length}`)
        }
        if (from && to) {
          vals.push(from, to)
          where.push(`(
            (occurred_at IS NOT NULL AND substring(occurred_at::text,1,10) >= $${vals.length - 1} AND substring(occurred_at::text,1,10) <= $${vals.length})
            OR
            (occurred_at IS NULL AND substring(coalesce(created_at::text,''),1,10) >= $${vals.length - 1} AND substring(coalesce(created_at::text,''),1,10) <= $${vals.length})
          )`)
        } else if (from) {
          vals.push(from)
          where.push(`(
            (occurred_at IS NOT NULL AND substring(occurred_at::text,1,10) >= $${vals.length})
            OR
            (occurred_at IS NULL AND substring(coalesce(created_at::text,''),1,10) >= $${vals.length})
          )`)
        } else if (to) {
          vals.push(to)
          where.push(`(
            (occurred_at IS NOT NULL AND substring(occurred_at::text,1,10) <= $${vals.length})
            OR
            (occurred_at IS NULL AND substring(coalesce(created_at::text,''),1,10) <= $${vals.length})
          )`)
        }
        const sql = `SELECT * FROM finance_transactions${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`
        const raw = await pgPool.query(sql, vals)
        rows = Array.isArray(raw?.rows) ? raw.rows : []
      } else {
        const raw = await pgSelect('finance_transactions')
        rows = Array.isArray(raw) ? raw : []
      }
      return res.json(rows)
    }
    const q: any = req.query || {}
    const from = autoToISODateOnly(q.from)
    const to = autoToISODateOnly(q.to)
    const pid = String(q.property_id || '').trim()
    return res.json((db.financeTransactions || []).filter((r: any) => {
      if (pid && String(r?.property_id || '') !== pid) return false
      const d = autoToISODateOnly(r?.occurred_at || r?.created_at)
      if (from && (!d || d < from)) return false
      if (to && (!d || d > to)) return false
      return true
    }))
  } catch {
    const q: any = req.query || {}
    const from = autoToISODateOnly(q.from)
    const to = autoToISODateOnly(q.to)
    const pid = String(q.property_id || '').trim()
    return res.json((db.financeTransactions || []).filter((r: any) => {
      if (pid && String(r?.property_id || '') !== pid) return false
      const d = autoToISODateOnly(r?.occurred_at || r?.created_at)
      if (from && (!d || d < from)) return false
      if (to && (!d || d > to)) return false
      return true
    }))
  }
})

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
  if (!d) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null
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
  const base = autoToNum(row?.maintenance_amount)
  const baseN = Number.isFinite(base) ? base : 0
  const hasParts = row?.has_parts === true
  const hasGst = row?.has_gst === true
  const includesGst = row?.maintenance_amount_includes_gst === true
  let subtotal = baseN
  if (!hasParts) {
    if (hasGst && !includesGst) subtotal = subtotal + subtotal * 0.1
    return Math.round((subtotal + Number.EPSILON) * 100) / 100
  }
  const includesParts = row?.maintenance_amount_includes_parts === true
  if (includesParts) {
    if (hasGst && !includesGst) subtotal = subtotal + subtotal * 0.1
    return Math.round((subtotal + Number.EPSILON) * 100) / 100
  }
  const parts = autoToNum(row?.parts_amount)
  const partsN = Number.isFinite(parts) ? parts : 0
  subtotal = subtotal + partsN
  if (hasGst && !includesGst) subtotal = subtotal + subtotal * 0.1
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
  const sum = arr.reduce((s, x) => {
    const n = autoToNum((x as any)?.cost)
    return s + (Number.isFinite(n) ? n : 0)
  }, 0)
  const total = labor + sum
  return Math.round((total + Number.EPSILON) * 100) / 100
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

function autoParseMaybeJson(v: any): any {
  if (typeof v !== 'string') return v
  const s = v.trim()
  if (!s) return ''
  const head = s[0]
  if (head !== '{' && head !== '[') return s
  try { return JSON.parse(s) } catch { return s }
}

function autoPickSummaryFromDetails(detailsRaw: any): string {
  const v = autoParseMaybeJson(detailsRaw)
  if (!v) return ''
  if (Array.isArray(v)) {
    for (const it of v) {
      const c = autoToSummaryText((it as any)?.content)
      if (c) return c
      const i = autoToSummaryText((it as any)?.item)
      if (i) return i
      const s = autoToSummaryText(it)
      if (s) return s
    }
    return ''
  }
  if (typeof v === 'object') {
    const c = autoToSummaryText((v as any)?.content)
    if (c) return c
    const i = autoToSummaryText((v as any)?.item)
    if (i) return i
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
  try {
    const r = await executor.query(
      `SELECT (
         EXISTS (SELECT 1 FROM property_expenses WHERE ref_type=$1 AND ref_id=$2 AND manual_override=true)
         OR
         EXISTS (SELECT 1 FROM company_expenses WHERE ref_type=$1 AND ref_id=$2 AND manual_override=true)
       ) AS ok`,
      [refType, refId]
    )
    return !!(r?.rows?.[0]?.ok)
  } catch {
    return false
  }
}

async function ensureAutoExpenseSchema(client: any) {
  let sp = 0
  const safeQuery = async (sql: string) => {
    const name = `s${sp++}`
    await client.query(`SAVEPOINT ${name}`)
    try {
      await client.query(sql)
      await client.query(`RELEASE SAVEPOINT ${name}`)
      return { ok: true as const, error: '' }
    } catch (e: any) {
      try { await client.query(`ROLLBACK TO SAVEPOINT ${name}`) } catch {}
      try { await client.query(`RELEASE SAVEPOINT ${name}`) } catch {}
      return { ok: false as const, error: String(e?.message || e || '') }
    }
  }
  const must = async (sql: string) => {
    const r = await safeQuery(sql)
    if (!r.ok) throw new Error(r.error || 'schema ensure failed')
  }
  await must(`CREATE TABLE IF NOT EXISTS company_expenses (
    id text PRIMARY KEY,
    occurred_at date NOT NULL,
    amount numeric NOT NULL,
    currency text NOT NULL DEFAULT 'AUD',
    category text,
    category_detail text,
    note text,
    invoice_url text,
    created_at timestamptz DEFAULT now(),
    created_by text,
    fixed_expense_id text,
    month_key text,
    due_date date,
    paid_date date,
    status text,
    generated_from text,
    ref_type text,
    ref_id text,
    is_auto boolean DEFAULT false,
    manual_override boolean DEFAULT false,
    source_title text,
    source_summary text
  );`)
  await must(`CREATE TABLE IF NOT EXISTS property_expenses (
    id text PRIMARY KEY,
    property_id text,
    occurred_at date NOT NULL,
    amount numeric NOT NULL,
    currency text NOT NULL DEFAULT 'AUD',
    category text,
    category_detail text,
    note text,
    invoice_url text,
    created_at timestamptz DEFAULT now(),
    created_by text,
    fixed_expense_id text,
    month_key text,
    due_date date,
    paid_date date,
    status text,
    pay_method text,
    pay_other_note text,
    generated_from text,
    ref_type text,
    ref_id text,
    is_auto boolean DEFAULT false,
    manual_override boolean DEFAULT false,
    source_title text,
    source_summary text
  );`)
  await must('ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS category_detail text;')
  await must('ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS note text;')
  await must('ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS month_key text;')
  await must('ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS due_date date;')
  await must('ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS pay_method text;')
  await must('ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS pay_other_note text;')
  await must('ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS generated_from text;')
  await must('ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS ref_type text;')
  await must('ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS ref_id text;')
  await must('ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS is_auto boolean DEFAULT false;')
  await must('ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS manual_override boolean DEFAULT false;')
  await must('ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS source_title text;')
  await must('ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS source_summary text;')
  await safeQuery("CREATE UNIQUE INDEX IF NOT EXISTS uniq_property_expenses_ref ON property_expenses(ref_type, ref_id) WHERE ref_type IS NOT NULL AND ref_id IS NOT NULL;")
  await must('ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS category_detail text;')
  await must('ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS note text;')
  await must('ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS month_key text;')
  await must('ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS due_date date;')
  await must('ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS generated_from text;')
  await must('ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS ref_type text;')
  await must('ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS ref_id text;')
  await must('ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS is_auto boolean DEFAULT false;')
  await must('ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS manual_override boolean DEFAULT false;')
  await must('ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS source_title text;')
  await must('ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS source_summary text;')
  await safeQuery("CREATE UNIQUE INDEX IF NOT EXISTS uniq_company_expenses_ref ON company_expenses(ref_type, ref_id) WHERE ref_type IS NOT NULL AND ref_id IS NOT NULL;")
}

async function autoUpsertPropertyExpenseByRef(client: any, input: { propertyId: string, occurredAt: string, amount: number, categoryDetail: string, generatedFrom: string, refType: string, refId: string, sourceTitle?: string, sourceSummary?: string }) {
  const { v4: uuid } = require('uuid')
  const mk = autoMonthKey(input.occurredAt)
  try {
    await client.query(
      `INSERT INTO property_expenses (id, property_id, occurred_at, amount, currency, category, category_detail, note, pay_method, generated_from, ref_type, ref_id, month_key, due_date, is_auto, source_title, source_summary)
       VALUES ($1,$2,$3,$4,'AUD','other',$5,$6,'landlord_pay',$7,$8,$9,$10,$3,true,$11,$12)
       ON CONFLICT (ref_type, ref_id) WHERE ref_type IS NOT NULL AND ref_id IS NOT NULL DO UPDATE
       SET property_id=EXCLUDED.property_id, occurred_at=EXCLUDED.occurred_at, amount=EXCLUDED.amount, currency=EXCLUDED.currency, category=EXCLUDED.category, category_detail=EXCLUDED.category_detail,
           note=EXCLUDED.note, pay_method=EXCLUDED.pay_method, generated_from=EXCLUDED.generated_from, month_key=EXCLUDED.month_key, due_date=EXCLUDED.due_date, is_auto=EXCLUDED.is_auto,
           source_title=EXCLUDED.source_title, source_summary=EXCLUDED.source_summary`,
      [uuid(), input.propertyId, input.occurredAt, input.amount, input.categoryDetail, `AUTO ${input.refType} ${input.refId}`, input.generatedFrom, input.refType, input.refId, mk, input.sourceTitle || null, input.sourceSummary || null]
    )
  } catch (e: any) {
    const msg = String(e?.message || '')
    if (/no\s+unique\s+constraint\s+matching\s+ON\s+CONFLICT/i.test(msg) || /there\s+is\s+no\s+unique\s+or\s+exclusion\s+constraint/i.test(msg)) {
      const existing = await client.query('SELECT id FROM property_expenses WHERE ref_type=$1 AND ref_id=$2 LIMIT 1', [input.refType, input.refId])
      const existingId = String(existing?.rows?.[0]?.id || '')
      if (existingId) {
        await client.query(
          `UPDATE property_expenses
           SET property_id=$1, occurred_at=$2, amount=$3, currency='AUD', category='other', category_detail=$4, note=$5,
               pay_method='landlord_pay', generated_from=$6, month_key=$7, due_date=$2, is_auto=true, source_title=$9, source_summary=$10
           WHERE id=$8`,
          [input.propertyId, input.occurredAt, input.amount, input.categoryDetail, `AUTO ${input.refType} ${input.refId}`, input.generatedFrom, mk, existingId, input.sourceTitle || null, input.sourceSummary || null]
        )
        return
      }
      await client.query(
        `INSERT INTO property_expenses (id, property_id, occurred_at, amount, currency, category, category_detail, note, pay_method, generated_from, ref_type, ref_id, month_key, due_date, is_auto, source_title, source_summary)
         VALUES ($1,$2,$3,$4,'AUD','other',$5,$6,'landlord_pay',$7,$8,$9,$10,$3,true,$11,$12)`,
        [uuid(), input.propertyId, input.occurredAt, input.amount, input.categoryDetail, `AUTO ${input.refType} ${input.refId}`, input.generatedFrom, input.refType, input.refId, mk, input.sourceTitle || null, input.sourceSummary || null]
      )
      return
    }
    throw e
  }
}

async function autoUpsertCompanyExpenseByRef(client: any, input: { occurredAt: string, amount: number, categoryDetail: string, generatedFrom: string, refType: string, refId: string, sourceTitle?: string, sourceSummary?: string }) {
  const { v4: uuid } = require('uuid')
  const mk = autoMonthKey(input.occurredAt)
  try {
    await client.query(
      `INSERT INTO company_expenses (id, occurred_at, amount, currency, category, category_detail, note, generated_from, ref_type, ref_id, month_key, due_date, is_auto, source_title, source_summary)
       VALUES ($1,$2,$3,'AUD','other',$4,$5,$6,$7,$8,$9,$2,true,$10,$11)
       ON CONFLICT (ref_type, ref_id) WHERE ref_type IS NOT NULL AND ref_id IS NOT NULL DO UPDATE
       SET occurred_at=EXCLUDED.occurred_at, amount=EXCLUDED.amount, currency=EXCLUDED.currency, category=EXCLUDED.category, category_detail=EXCLUDED.category_detail,
           note=EXCLUDED.note, generated_from=EXCLUDED.generated_from, month_key=EXCLUDED.month_key, due_date=EXCLUDED.due_date, is_auto=EXCLUDED.is_auto,
           source_title=EXCLUDED.source_title, source_summary=EXCLUDED.source_summary`,
      [uuid(), input.occurredAt, input.amount, input.categoryDetail, `AUTO ${input.refType} ${input.refId}`, input.generatedFrom, input.refType, input.refId, mk, input.sourceTitle || null, input.sourceSummary || null]
    )
  } catch (e: any) {
    const msg = String(e?.message || '')
    if (/no\s+unique\s+constraint\s+matching\s+ON\s+CONFLICT/i.test(msg) || /there\s+is\s+no\s+unique\s+or\s+exclusion\s+constraint/i.test(msg)) {
      const existing = await client.query('SELECT id FROM company_expenses WHERE ref_type=$1 AND ref_id=$2 LIMIT 1', [input.refType, input.refId])
      const existingId = String(existing?.rows?.[0]?.id || '')
      if (existingId) {
        await client.query(
          `UPDATE company_expenses
           SET occurred_at=$1, amount=$2, currency='AUD', category='other', category_detail=$3, note=$4, generated_from=$5, month_key=$6, due_date=$1, is_auto=true, source_title=$8, source_summary=$9
           WHERE id=$7`,
          [input.occurredAt, input.amount, input.categoryDetail, `AUTO ${input.refType} ${input.refId}`, input.generatedFrom, mk, existingId, input.sourceTitle || null, input.sourceSummary || null]
        )
        return
      }
      await client.query(
        `INSERT INTO company_expenses (id, occurred_at, amount, currency, category, category_detail, note, generated_from, ref_type, ref_id, month_key, due_date, is_auto, source_title, source_summary)
         VALUES ($1,$2,$3,'AUD','other',$4,$5,$6,$7,$8,$9,$2,true,$10,$11)`,
        [uuid(), input.occurredAt, input.amount, input.categoryDetail, `AUTO ${input.refType} ${input.refId}`, input.generatedFrom, input.refType, input.refId, mk, input.sourceTitle || null, input.sourceSummary || null]
      )
      return
    }
    throw e
  }
}

const autoExpensesBackfillSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  dry_run: z.boolean().optional().default(true),
  limit: z.coerce.number().optional().default(5000),
  type: z.enum(['maintenance','deep_cleaning','all']).optional().default('all'),
  property_id: z.string().optional(),
})

const autoExpensesInspectSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.coerce.number().optional().default(500),
  type: z.enum(['maintenance','deep_cleaning','all']).optional().default('all'),
  property_id: z.string().optional(),
})

async function collectAutoExpenseSourceItems(executor: any, input: { from: string, to: string, limit: number, type: string, propertyIdFilter?: string }) {
  const items: any[] = []
  const propertyIdFilter = String(input.propertyIdFilter || '').trim()
  if (input.type === 'all' || input.type === 'maintenance') {
    const mt = await executor.query(
      `SELECT id, property_id, status, pay_method, work_no, maintenance_amount, has_parts, parts_amount, maintenance_amount_includes_parts, completed_at, occurred_at, created_at, details, repair_notes, category
         FROM property_maintenance
        WHERE coalesce(completed_at::date, occurred_at, created_at::date) BETWEEN $1::date AND $2::date
          AND ($4::text IS NULL OR $4::text = '' OR property_id = $4::text)
        ORDER BY coalesce(completed_at::date, occurred_at, created_at::date) ASC
        LIMIT $3`,
      [input.from, input.to, input.limit, propertyIdFilter]
    )
    for (const r of (mt.rows || [])) items.push({ kind: 'maintenance', row: r })
  }
  if (input.type === 'all' || input.type === 'deep_cleaning') {
    const dc = await executor.query(
      `SELECT id, property_id, status, pay_method, work_no, total_cost, labor_cost, consumables, completed_at, occurred_at, created_at, project_desc, details, notes
         FROM property_deep_cleaning
        WHERE coalesce(completed_at::date, occurred_at, created_at::date) BETWEEN $1::date AND $2::date
          AND ($4::text IS NULL OR $4::text = '' OR property_id = $4::text)
        ORDER BY coalesce(completed_at::date, occurred_at, created_at::date) ASC
        LIMIT $3`,
      [input.from, input.to, input.limit, propertyIdFilter]
    )
    for (const r of (dc.rows || [])) items.push({ kind: 'deep_cleaning', row: r })
  }
  return items
}

router.post('/auto-expenses/backfill', requireAnyPerm(['finance.tx.write','property_expenses.write','company_expenses.write']), async (req, res) => {
  if (!hasPg || !pgPool) return res.status(400).json({ message: 'pg required' })
  const parsed = autoExpensesBackfillSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const from = parsed.data.from ? String(parsed.data.from).slice(0, 10) : '2000-01-01'
  const to = parsed.data.to ? String(parsed.data.to).slice(0, 10) : '2100-01-01'
  const dryRun = !!parsed.data.dry_run
  const limit = Math.max(1, Math.min(20000, Number(parsed.data.limit || 5000)))
  const type = String(parsed.data.type || 'all')
  const propertyIdFilter = parsed.data.property_id ? String(parsed.data.property_id || '').trim() : ''
  try {
    const items = await collectAutoExpenseSourceItems(pgPool, { from, to, limit, type, propertyIdFilter })
    const scanned = items.length

    if (dryRun) {
      let would_property = 0, would_company = 0, would_void = 0, skipped_manual_override = 0, would_cleaned_opposite = 0
      for (const it of items) {
        const refType = it.kind === 'maintenance' ? 'maintenance' : 'deep_cleaning'
        const r = it.row || {}
        const refId = String(r?.id || '')
        if (!refId) continue
        if (await autoHasManualOverrideForRef(pgPool, refType, refId)) { skipped_manual_override++; continue }
        const st = autoNormStatus(r?.status)
        const pm = autoNormPayMethod(r?.pay_method)
        const occurredAt = autoToISODateOnly(r?.completed_at) || autoToISODateOnly(r?.occurred_at) || autoToISODateOnly(r?.created_at)
        const amount = it.kind === 'maintenance'
          ? autoCalcMaintenanceTotal(r)
          : (() => {
              const raw = r?.total_cost !== undefined && r?.total_cost !== null ? r.total_cost : autoComputeDeepCleaningTotalCost(r?.labor_cost, r?.consumables)
              return autoToNum(raw)
            })()
        if (st !== 'completed' || !(amount > 0) || !occurredAt) { would_void++; continue }
        if (pm === 'landlord_pay') { would_property++; would_cleaned_opposite++; continue }
        if (pm === 'company_pay') { would_company++; would_cleaned_opposite++; continue }
        would_void++
      }
      return res.json({ dry_run: true, range: { from, to }, scanned, would_property, would_company, would_void, would_cleaned_opposite, skipped_manual_override })
    }

    const result = await pgRunInTransaction(async (client) => {
      await ensureAutoExpenseSchema(client)
      let upserted_property = 0, upserted_company = 0, voided = 0, cleaned_opposite = 0, skipped_manual_override = 0

      for (const it of items) {
        const refType = it.kind === 'maintenance' ? 'maintenance' : 'deep_cleaning'
        const r = it.row || {}
        const refId = String(r?.id || '')
        if (!refId) continue
        if (await autoHasManualOverrideForRef(client, refType, refId)) { skipped_manual_override++; continue }

        const st = autoNormStatus(r?.status)
        const pm = autoNormPayMethod(r?.pay_method)
        const occurredAt = autoToISODateOnly(r?.completed_at) || autoToISODateOnly(r?.occurred_at) || autoToISODateOnly(r?.created_at)
        const amount = it.kind === 'maintenance'
          ? autoCalcMaintenanceTotal(r)
          : (() => {
              const raw = r?.total_cost !== undefined && r?.total_cost !== null ? r.total_cost : autoComputeDeepCleaningTotalCost(r?.labor_cost, r?.consumables)
              return autoToNum(raw)
            })()
        const propertyId = String(r?.property_id || '')
        const categoryDetail = it.kind === 'maintenance' ? '维修' : '深度清洁'
        const generatedFrom = refId
        const sourceTitle = (() => {
          if (it.kind !== 'deep_cleaning') return categoryDetail
          const workNo = String(r?.work_no || refId)
          return workNo ? `深度清洁 ${workNo}` : categoryDetail
        })()
        const sourceSummary = it.kind === 'maintenance' ? autoMaintenanceIssueSummary(r) : autoDeepCleaningProjectSummary(r)

        const voidBothAuto = async () => {
          const v1 = await client.query(
            `UPDATE property_expenses SET status='void'
             WHERE ref_type=$1 AND ref_id=$2 AND is_auto=true AND (manual_override IS NULL OR manual_override=false)`,
            [refType, refId]
          )
          const v2 = await client.query(
            `UPDATE company_expenses SET status='void'
             WHERE ref_type=$1 AND ref_id=$2 AND is_auto=true AND (manual_override IS NULL OR manual_override=false)`,
            [refType, refId]
          )
          voided += Number(v1.rowCount || 0) + Number(v2.rowCount || 0)
        }

        if (st !== 'completed' || !(amount > 0) || !occurredAt) {
          await voidBothAuto()
          continue
        }

        if (pm === 'landlord_pay') {
          if (!propertyId) { await voidBothAuto(); continue }
          const v2 = await client.query(
            `UPDATE company_expenses SET status='void'
             WHERE ref_type=$1 AND ref_id=$2 AND is_auto=true AND (manual_override IS NULL OR manual_override=false)`,
            [refType, refId]
          )
          cleaned_opposite += Number(v2.rowCount || 0)
          await autoUpsertPropertyExpenseByRef(client, { propertyId, occurredAt, amount, categoryDetail, generatedFrom, refType, refId, sourceTitle, sourceSummary })
          upserted_property++
          continue
        }

        if (pm === 'company_pay') {
          const v1 = await client.query(
            `UPDATE property_expenses SET status='void'
             WHERE ref_type=$1 AND ref_id=$2 AND is_auto=true AND (manual_override IS NULL OR manual_override=false)`,
            [refType, refId]
          )
          cleaned_opposite += Number(v1.rowCount || 0)
          await autoUpsertCompanyExpenseByRef(client, { occurredAt, amount, categoryDetail, generatedFrom, refType, refId, sourceTitle, sourceSummary })
          upserted_company++
          continue
        }

        await voidBothAuto()
      }

      return { scanned, upserted_property, upserted_company, voided, cleaned_opposite, skipped_manual_override }
    })
    return res.json({ dry_run: false, range: { from, to }, ...(result as any) })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'backfill_failed' })
  }
})

router.post('/auto-expenses/inspect', requireAnyPerm(['finance.tx.write','property_expenses.write','company_expenses.write']), async (req, res) => {
  if (!hasPg || !pgPool) return res.status(400).json({ message: 'pg required' })
  const parsed = autoExpensesInspectSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const from = parsed.data.from ? String(parsed.data.from).slice(0, 10) : '2000-01-01'
  const to = parsed.data.to ? String(parsed.data.to).slice(0, 10) : '2100-01-01'
  const limit = Math.max(1, Math.min(5000, Number(parsed.data.limit || 500)))
  const type = String(parsed.data.type || 'all')
  const propertyIdFilter = parsed.data.property_id ? String(parsed.data.property_id || '').trim() : ''
  try {
    const items = await collectAutoExpenseSourceItems(pgPool, { from, to, limit, type, propertyIdFilter })
    const issues: any[] = []
    const stats = {
      scanned: items.length,
      missing_expected: 0,
      amount_mismatch: 0,
      wrong_side_active: 0,
      stale_active: 0,
      source_deleted_active: 0,
      skipped_manual_override: 0,
    }
    for (const it of items) {
      const refType = it.kind === 'maintenance' ? 'maintenance' : 'deep_cleaning'
      const r = it.row || {}
      const refId = String(r?.id || '')
      if (!refId) continue
      const status = autoNormStatus(r?.status)
      const payMethod = autoNormPayMethod(r?.pay_method)
      const occurredAt = autoToISODateOnly(r?.completed_at) || autoToISODateOnly(r?.occurred_at) || autoToISODateOnly(r?.created_at)
      const amount = it.kind === 'maintenance'
        ? autoCalcMaintenanceTotal(r)
        : (() => {
            const raw = r?.total_cost !== undefined && r?.total_cost !== null ? r.total_cost : autoComputeDeepCleaningTotalCost(r?.labor_cost, r?.consumables)
            return autoToNum(raw)
          })()
      const expectedSide = (status === 'completed' && amount > 0 && occurredAt)
        ? (payMethod === 'landlord_pay' ? 'property' : (payMethod === 'company_pay' ? 'company' : 'void'))
        : 'void'
      const manualOverride = await autoHasManualOverrideForRef(pgPool, refType, refId)
      if (manualOverride) {
        stats.skipped_manual_override++
        continue
      }
      const propRows = await pgPool.query(
        `SELECT id, amount, status, is_auto FROM property_expenses WHERE ref_type=$1 AND ref_id=$2 ORDER BY created_at DESC NULLS LAST, occurred_at DESC NULLS LAST`,
        [refType, refId]
      )
      const compRows = await pgPool.query(
        `SELECT id, amount, status, is_auto FROM company_expenses WHERE ref_type=$1 AND ref_id=$2 ORDER BY created_at DESC NULLS LAST, occurred_at DESC NULLS LAST`,
        [refType, refId]
      )
      const activeProp = (propRows.rows || []).filter((x: any) => String(x?.status || '') !== 'void' && x?.is_auto === true)
      const activeComp = (compRows.rows || []).filter((x: any) => String(x?.status || '') !== 'void' && x?.is_auto === true)
      if (expectedSide === 'property') {
        if (!activeProp.length) {
          stats.missing_expected++
          issues.push({ kind: it.kind, ref_type: refType, ref_id: refId, issue: 'missing_expected_property_expense' })
        } else if (Math.abs(Number(activeProp[0]?.amount || 0) - Number(amount || 0)) > 0.005) {
          stats.amount_mismatch++
          issues.push({ kind: it.kind, ref_type: refType, ref_id: refId, issue: 'property_amount_mismatch', expected_amount: amount, actual_amount: Number(activeProp[0]?.amount || 0) })
        }
        if (activeComp.length) {
          stats.wrong_side_active++
          issues.push({ kind: it.kind, ref_type: refType, ref_id: refId, issue: 'company_expense_should_be_void', active_company_expense_ids: activeComp.map((x: any) => x.id) })
        }
      } else if (expectedSide === 'company') {
        if (!activeComp.length) {
          stats.missing_expected++
          issues.push({ kind: it.kind, ref_type: refType, ref_id: refId, issue: 'missing_expected_company_expense' })
        } else if (Math.abs(Number(activeComp[0]?.amount || 0) - Number(amount || 0)) > 0.005) {
          stats.amount_mismatch++
          issues.push({ kind: it.kind, ref_type: refType, ref_id: refId, issue: 'company_amount_mismatch', expected_amount: amount, actual_amount: Number(activeComp[0]?.amount || 0) })
        }
        if (activeProp.length) {
          stats.wrong_side_active++
          issues.push({ kind: it.kind, ref_type: refType, ref_id: refId, issue: 'property_expense_should_be_void', active_property_expense_ids: activeProp.map((x: any) => x.id) })
        }
      } else if (activeProp.length || activeComp.length) {
        stats.stale_active++
        issues.push({ kind: it.kind, ref_type: refType, ref_id: refId, issue: 'auto_expense_should_be_void', active_property_expense_ids: activeProp.map((x: any) => x.id), active_company_expense_ids: activeComp.map((x: any) => x.id) })
      }
    }

    const orphans = await pgPool.query(
      `
      SELECT 'property' AS side, id, ref_type, ref_id
        FROM property_expenses
       WHERE is_auto=true
         AND ref_type IN ('maintenance','deep_cleaning')
         AND coalesce(status,'') <> 'void'
         AND (
           (ref_type='maintenance' AND NOT EXISTS (SELECT 1 FROM property_maintenance m WHERE m.id = property_expenses.ref_id))
           OR
           (ref_type='deep_cleaning' AND NOT EXISTS (SELECT 1 FROM property_deep_cleaning d WHERE d.id = property_expenses.ref_id))
         )
      UNION ALL
      SELECT 'company' AS side, id, ref_type, ref_id
        FROM company_expenses
       WHERE is_auto=true
         AND ref_type IN ('maintenance','deep_cleaning')
         AND coalesce(status,'') <> 'void'
         AND (
           (ref_type='maintenance' AND NOT EXISTS (SELECT 1 FROM property_maintenance m WHERE m.id = company_expenses.ref_id))
           OR
           (ref_type='deep_cleaning' AND NOT EXISTS (SELECT 1 FROM property_deep_cleaning d WHERE d.id = company_expenses.ref_id))
         )
      LIMIT $1
      `,
      [limit]
    )
    const orphanRows = orphans.rows || []
    stats.source_deleted_active = orphanRows.length
    for (const row of orphanRows) issues.push({ issue: 'source_deleted_but_auto_expense_active', ...row })

    return res.json({ range: { from, to }, stats, issues })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'inspect_failed' })
  }
})

const txSchema = z.object({ kind: z.enum(['income','expense']), amount: z.coerce.number().min(0), currency: z.string(), ref_type: z.string().optional(), ref_id: z.string().optional(), occurred_at: z.string().optional(), note: z.string().optional(), category: z.string().optional(), property_id: z.string().optional(), invoice_url: z.string().optional(), category_detail: z.string().optional() })
router.post('/', requirePerm('finance.tx.write'), async (req, res) => {
  const parsed = txSchema.safeParse(req.body)
  if (!parsed.success) {
    const msg = parsed.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; ')
    return res.status(400).json({ message: msg || 'invalid payload' })
  }
  const { v4: uuid } = require('uuid')
  const tx: FinanceTransaction = { id: uuid(), occurred_at: parsed.data.occurred_at || new Date().toISOString(), ...parsed.data }
  db.financeTransactions.push(tx)
  addAudit('FinanceTransaction', tx.id, 'create', null, tx)
  if (hasPg) {
    try {
      const result = await pgRunInTransaction(async (client) => {
        function normalizeStatus(raw: any): string { return String(raw || '').trim().toLowerCase() }
        function isCanceledStatus(raw: any): boolean {
          const s = normalizeStatus(raw)
          return s === 'canceled' || s === 'cancelled'
        }
        try {
          await client.query('ALTER TABLE company_incomes ADD COLUMN IF NOT EXISTS property_id text REFERENCES properties(id) ON DELETE SET NULL;')
          await client.query('ALTER TABLE company_incomes ADD COLUMN IF NOT EXISTS ref_type text;')
          await client.query('ALTER TABLE company_incomes ADD COLUMN IF NOT EXISTS ref_id text;')
          await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_company_incomes_ref ON company_incomes(category, ref_type, ref_id);`)
        } catch {}

        const cat0 = String((tx as any).category || '').toLowerCase()
        if (String(tx.kind) === 'income' && cat0 === 'cancel_fee' && String((tx as any).ref_type || '') === 'order' && String((tx as any).ref_id || '')) {
          const dup = await pgSelect('finance_transactions', '*', { ref_type: 'order', ref_id: String((tx as any).ref_id), category: 'cancel_fee' }, client)
          if (Array.isArray(dup) && dup[0]) {
            return { txRow: dup[0], duplicated: true }
          }
        }

        const txRow = await pgInsert('finance_transactions', tx as any, client)
        try {
          const cat = String((tx as any).category || '').toLowerCase()
          const isIncome = String(tx.kind) === 'income'
          if (isIncome && (cat === 'cancel_fee' || cat === 'late_checkout' || cat === 'other' || cat === 'cleaning_fee' || cat === 'mgmt_fee')) {
            const occurred = String(tx.occurred_at || '').slice(0, 10) || new Date().toISOString().slice(0,10)
            const rec: any = {
              id: uuid(),
              occurred_at: occurred,
              amount: Number(tx.amount || 0),
              currency: String(tx.currency || 'AUD'),
              category: cat || 'other',
              note: String(tx.note || ''),
              property_id: (tx as any).property_id || null,
              ref_type: (tx as any).ref_type || null,
              ref_id: (tx as any).ref_id || null,
            }

            if (cat === 'cancel_fee' && String((tx as any).ref_type || '') === 'order' && String((tx as any).ref_id || '')) {
              const oid = String((tx as any).ref_id)
              const ordRows = await pgSelect('orders', 'id,status,count_in_income', { id: oid }, client)
              const ord = Array.isArray(ordRows) ? ordRows[0] : null
              const canceled = isCanceledStatus(ord?.status)
              const countInIncome = !!(ord as any)?.count_in_income
              if (canceled && countInIncome) {
                return { txRow: txRow || tx, duplicated: false, skippedCompanyIncome: true }
              }
            }

            if (rec.ref_type && rec.ref_id) {
              const ins = await pgInsertOnConflictDoNothing('company_incomes', rec, ['category', 'ref_type', 'ref_id'], client)
              if (ins) addAudit('CompanyIncome', String((ins as any).id || rec.id), 'create', null, ins as any)
            } else {
              const dup2 = await pgSelect('company_incomes', '*', { occurred_at: rec.occurred_at, category: rec.category, amount: rec.amount, note: rec.note, property_id: rec.property_id }, client)
              if (!(Array.isArray(dup2) && dup2[0])) {
                const ins = await pgInsert('company_incomes', rec as any, client)
                if (ins) addAudit('CompanyIncome', String((ins as any).id || rec.id), 'create', null, ins as any)
              }
            }
          }
        } catch {}
        return { txRow: txRow || tx, duplicated: false }
      })
      const row = (result as any)?.txRow
      const status = (result as any)?.duplicated ? 200 : 201
      return res.status(status).json(row || tx)
    } catch (e: any) {
      return res.status(500).json({ message: e?.message || 'pg insert failed' })
    }
  }
  return res.status(201).json(tx)
})

// Backfill company_incomes from finance_transactions for a given month
router.post('/company-incomes/backfill', requireAnyPerm(['finance.tx.write','company_incomes.write']), async (req, res) => {
  try {
    if (!hasPg) return res.status(400).json({ message: 'pg required' })
    const month = String(((req.body || {}).month) || ((req.query || {}).month) || '')
    const dryRun = String(((req.body || {}).dry_run) ?? ((req.query || {}) as any).dry_run ?? '').toLowerCase() === 'true' || String(((req.body || {}).dry_run) ?? ((req.query || {}) as any).dry_run ?? '') === '1'
    if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ message: 'invalid month format' })
    const lockKey = 91000000 + Number(month.replace('-', ''))
    const lock = await pgPool!.query('SELECT pg_try_advisory_lock($1) AS ok', [lockKey])
    const ok = !!(lock?.rows?.[0]?.ok)
    if (!ok) return res.status(409).json({ message: 'backfill already running', reason: 'locked', month })
    try {
      const y = Number(month.slice(0,4)), m = Number(month.slice(5,7))
      const start = new Date(Date.UTC(y, m - 1, 1)).toISOString().slice(0,10)
      const endExclusive = new Date(Date.UTC(y, m, 1)).toISOString().slice(0,10)
      function normalizeStatus(raw: any): string { return String(raw || '').trim().toLowerCase() }
      function isCanceledStatus(raw: any): boolean {
        const s = normalizeStatus(raw)
        return s === 'canceled' || s === 'cancelled'
      }

      const result = await pgRunInTransaction(async (client) => {
        try {
          await client.query('ALTER TABLE company_incomes ADD COLUMN IF NOT EXISTS property_id text REFERENCES properties(id) ON DELETE SET NULL;')
          await client.query('ALTER TABLE company_incomes ADD COLUMN IF NOT EXISTS ref_type text;')
          await client.query('ALTER TABLE company_incomes ADD COLUMN IF NOT EXISTS ref_id text;')
          await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_company_incomes_ref ON company_incomes(category, ref_type, ref_id);`)
        } catch {}

        const rs = await client.query(
          `SELECT
             t.id AS tx_id,
             (t.occurred_at)::date AS occurred_at,
             t.amount,
             t.currency,
             t.note,
             t.property_id,
             t.ref_id AS order_id,
             o.status AS order_status,
             o.count_in_income AS order_count_in_income
           FROM finance_transactions t
           LEFT JOIN orders o ON o.id = t.ref_id
           WHERE t.kind='income'
             AND t.category='cancel_fee'
             AND t.ref_type='order'
             AND t.ref_id IS NOT NULL
             AND (t.occurred_at)::date >= to_date($1,'YYYY-MM-DD')
             AND (t.occurred_at)::date < to_date($2,'YYYY-MM-DD')`,
          [start, endExclusive]
        )
        const rows: any[] = rs.rows || []
        let scanned = rows.length
        let updated_ref = 0
        let inserted = 0
        let deleted = 0
        let deleted_tx = 0
        let ambiguous = 0
        let skipped_missing_order = 0

        const sample_ambiguous: any[] = []
        const sample_missing_order: any[] = []

        for (const t of rows) {
          const orderId = String(t.order_id || '')
          if (!orderId) continue
          const occ = String(t.occurred_at || '').slice(0,10)
          const amt = Number(t.amount || 0)
          const propId = String(t.property_id || '') || null
          const statusKnown = !!t.order_status
          const canceled = isCanceledStatus(t.order_status)
          const countInIncome = !!t.order_count_in_income

          if (!t.order_status) {
            skipped_missing_order++
            if (sample_missing_order.length < 10) sample_missing_order.push({ order_id: orderId, tx_id: String(t.tx_id || ''), occurred_at: occ, amount: amt })
          }

          const existingByRef = await pgSelect('company_incomes', 'id', { category: 'cancel_fee', ref_type: 'order', ref_id: orderId }, client)
          const hasByRef = Array.isArray(existingByRef) && existingByRef[0]
          if (!hasByRef) {
            const cand = await client.query(
              `SELECT id FROM company_incomes
               WHERE category='cancel_fee'
                 AND (ref_type IS NULL OR ref_type = '')
                 AND (ref_id IS NULL OR ref_id = '')
                 AND occurred_at = to_date($1,'YYYY-MM-DD')
                 AND amount = $2
                 AND (property_id IS NOT DISTINCT FROM $3)`,
              [occ, amt, propId]
            )
            const ids: string[] = (cand.rows || []).map((r: any) => String(r.id))
            if (ids.length === 1) {
              if (!dryRun) {
                await client.query(`UPDATE company_incomes SET ref_type='order', ref_id=$1 WHERE id=$2`, [orderId, ids[0]])
              }
              updated_ref++
            } else if (ids.length > 1) {
              ambiguous++
              if (sample_ambiguous.length < 10) sample_ambiguous.push({ order_id: orderId, occurred_at: occ, amount: amt, candidate_ids: ids })
            }
          }

          if (statusKnown && !canceled) {
            if (!dryRun) {
              const del = await client.query(`DELETE FROM company_incomes WHERE category='cancel_fee' AND ref_type='order' AND ref_id=$1 RETURNING id`, [orderId])
              deleted += Number(del.rowCount || 0)
              const delTx = await client.query(`DELETE FROM finance_transactions WHERE id=$1 RETURNING id`, [String(t.tx_id || '')])
              deleted_tx += Number(delTx.rowCount || 0)
            } else {
              deleted += hasByRef ? 1 : 0
              deleted_tx += 1
            }
            continue
          }

          if (!statusKnown) continue
          const shouldCompany = canceled && !countInIncome
          if (!shouldCompany) {
            if (!dryRun) {
              const del = await client.query(`DELETE FROM company_incomes WHERE category='cancel_fee' AND ref_type='order' AND ref_id=$1 RETURNING id`, [orderId])
              deleted += Number(del.rowCount || 0)
            } else {
              deleted += hasByRef ? 1 : 0
            }
            continue
          }

          const rec: any = {
            id: require('uuid').v4(),
            occurred_at: occ,
            amount: amt,
            currency: String(t.currency || 'AUD'),
            category: 'cancel_fee',
            note: String(t.note || ''),
            property_id: propId,
            ref_type: 'order',
            ref_id: orderId,
          }
          if (!dryRun) {
            const ins = await pgInsertOnConflictDoNothing('company_incomes', rec, ['category', 'ref_type', 'ref_id'], client)
            if (ins) {
              inserted++
              try { addAudit('CompanyIncome', String((ins as any).id || rec.id), 'create', null, ins as any) } catch {}
            }
          } else {
            if (!hasByRef) inserted++
          }
        }

        return {
          month,
          dry_run: dryRun,
          scanned,
          updated_ref,
          inserted,
          deleted,
          deleted_tx,
          ambiguous,
          skipped_missing_order,
          sample_ambiguous,
          sample_missing_order,
        }
      })

      return res.status(201).json(result)
    } finally {
      try { await pgPool!.query('SELECT pg_advisory_unlock($1)', [lockKey]) } catch {}
    }
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'backfill_failed' })
  }
})

router.post('/invoices', requireAnyPerm(['finance.tx.write','property_expenses.write','company_expenses.write']), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'missing file' })
  try {
    if (hasR2 && req.file && (req.file as any).buffer) {
      const img = await resizeUploadImage({ buffer: (req.file as any).buffer, contentType: req.file.mimetype, originalName: req.file.originalname })
      const ext = img.ext || path.extname(req.file.originalname) || ''
      const key = `invoices/${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`
      const url = await r2Upload(key, img.contentType || req.file.mimetype || 'application/octet-stream', img.buffer)
      return res.status(201).json({ url })
    }
    const url = `/uploads/${req.file.filename}`
    return res.status(201).json({ url })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'upload failed' })
  }
})

// Expense-specific invoice resource
router.get('/expense-invoices/:expenseId', requireAnyPerm(['property_expenses.view','finance.tx.write','property_expenses.write']), async (req, res) => {
  const { expenseId } = req.params
  try {
    if (hasPg) {
      try {
        const rows = await pgSelect('expense_invoices', '*', { expense_id: expenseId })
        return res.json(Array.isArray(rows) ? rows : [])
      } catch (e: any) {
        const msg = String(e?.message || '')
        const { pgPool } = require('../dbAdapter')
        if (pgPool && /relation\s+"?expense_invoices"?\s+does\s+not\s+exist/i.test(msg)) {
          await pgPool.query(`CREATE TABLE IF NOT EXISTS expense_invoices (
            id text PRIMARY KEY,
            expense_id text REFERENCES property_expenses(id) ON DELETE CASCADE,
            url text NOT NULL,
            file_name text,
            mime_type text,
            file_size integer,
            created_at timestamptz DEFAULT now(),
            created_by text
          );`)
          await pgPool.query('CREATE INDEX IF NOT EXISTS idx_expense_invoices_expense ON expense_invoices(expense_id);')
          const rows2 = await pgSelect('expense_invoices', '*', { expense_id: expenseId })
          return res.json(Array.isArray(rows2) ? rows2 : [])
        }
        throw e
      }
    }
    const rows = db.expenseInvoices.filter((x: any) => String(x.expense_id) === String(expenseId))
    return res.json(rows)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'list failed' })
  }
})

router.post('/expense-invoices/:expenseId/upload', requireAnyPerm(['property_expenses.write','finance.tx.write']), memUpload.single('file'), async (req, res) => {
  const { expenseId } = req.params
  if (!req.file) return res.status(400).json({ message: 'missing file' })
  try {
    const user = (req as any).user || {}
    const { v4: uuid } = require('uuid')
    const img = (req.file as any).buffer
      ? await resizeUploadImage({ buffer: (req.file as any).buffer, contentType: req.file.mimetype, originalName: req.file.originalname })
      : { buffer: (req.file as any).buffer, contentType: req.file.mimetype, ext: path.extname(req.file.originalname) || '' }
    const ext = img.ext || path.extname(req.file.originalname) || ''
    let url = ''
    if (hasR2 && (req.file as any).buffer) {
      const key = `expenses/${expenseId}/${uuid()}${ext}`
      url = await r2Upload(key, img.contentType || req.file.mimetype || 'application/octet-stream', img.buffer)
    } else {
      const dir = path.join(process.cwd(), 'uploads', 'expenses', expenseId)
      await fs.promises.mkdir(dir, { recursive: true })
      const name = `${uuid()}${ext}`
      const full = path.join(dir, name)
      await fs.promises.writeFile(full, img.buffer)
      url = `/uploads/expenses/${expenseId}/${name}`
    }
    if (hasPg) {
      try {
        const row = await pgInsert('expense_invoices', {
          id: uuid(),
          expense_id: expenseId,
          url,
          file_name: req.file.originalname,
          mime_type: req.file.mimetype,
          file_size: req.file.size,
          created_by: user?.sub || user?.username || null
        } as any)
        return res.status(201).json(row || { url })
      } catch (e: any) {
        const msg = String(e?.message || '')
        const { pgPool } = require('../dbAdapter')
        if (pgPool && /relation\s+"?expense_invoices"?\s+does\s+not\s+exist/i.test(msg)) {
          await pgPool.query(`CREATE TABLE IF NOT EXISTS expense_invoices (
            id text PRIMARY KEY,
            expense_id text REFERENCES property_expenses(id) ON DELETE CASCADE,
            url text NOT NULL,
            file_name text,
            mime_type text,
            file_size integer,
            created_at timestamptz DEFAULT now(),
            created_by text
          );`)
          await pgPool.query('CREATE INDEX IF NOT EXISTS idx_expense_invoices_expense ON expense_invoices(expense_id);')
          const row2 = await pgInsert('expense_invoices', {
            id: uuid(), expense_id: expenseId, url,
            file_name: req.file.originalname, mime_type: req.file.mimetype,
            file_size: req.file.size, created_by: user?.sub || user?.username || null
          } as any)
          return res.status(201).json(row2 || { url })
        }
        throw e
      }
    }
    const id = uuid()
    db.expenseInvoices.push({ id, expense_id: expenseId, url, file_name: req.file.originalname, mime_type: req.file.mimetype, file_size: req.file.size, created_at: new Date().toISOString(), created_by: user?.sub || user?.username || undefined } as any)
    return res.status(201).json({ id, url })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'upload failed' })
  }
})

router.delete('/expense-invoices/:id', requireAnyPerm(['property_expenses.write','finance.tx.write']), async (req, res) => {
  const { id } = req.params
  try {
    if (hasPg) {
      try { await pgDelete('expense_invoices', id); return res.json({ ok: true }) } catch (e: any) {
        const msg = String(e?.message || '')
        const { pgPool } = require('../dbAdapter')
        if (pgPool && /relation\s+"?expense_invoices"?\s+does\s+not\s+exist/i.test(msg)) {
          await pgPool.query(`CREATE TABLE IF NOT EXISTS expense_invoices (
            id text PRIMARY KEY,
            expense_id text REFERENCES property_expenses(id) ON DELETE CASCADE,
            url text NOT NULL,
            file_name text,
            mime_type text,
            file_size integer,
            created_at timestamptz DEFAULT now(),
            created_by text
          );`)
          await pgPool.query('CREATE INDEX IF NOT EXISTS idx_expense_invoices_expense ON expense_invoices(expense_id);')
          await pgDelete('expense_invoices', id)
          return res.json({ ok: true })
        }
        throw e
      }
    }
    const idx = db.expenseInvoices.findIndex((x: any) => x.id === id)
    if (idx !== -1) db.expenseInvoices.splice(idx, 1)
    return res.json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'delete failed' })
  }
})

// Query invoices by property and occurred_at range via expense join
router.get('/expense-invoices/search', requireAnyPerm(['property_expenses.view','finance.tx.write','property_expenses.write']), async (req, res) => {
  const { property_id, from, to } = (req.query || {}) as any
  if (!property_id || !from || !to) return res.status(400).json({ message: 'missing property_id/from/to' })
  try {
    if (hasPg) {
      const { pgPool } = require('../dbAdapter')
      if (pgPool) {
        const sql = `SELECT i.* FROM expense_invoices i JOIN property_expenses e ON i.expense_id = e.id WHERE e.property_id = $1 AND e.occurred_at >= $2 AND e.occurred_at <= $3 ORDER BY i.created_at ASC`
        const r = await pgPool.query(sql, [property_id, from, to])
        return res.json(r.rows || [])
      }
    }
    const rows = db.expenseInvoices.filter((ii: any) => {
      const exp = (db as any).property_expenses?.find?.((e: any) => String(e.id) === String(ii.expense_id))
      if (!exp) return false
      const pidOk = String(exp.property_id || '') === String(property_id)
      const dt = exp.occurred_at ? new Date(exp.occurred_at) : null
      const fromD = new Date(String(from))
      const toD = new Date(String(to))
      const inRange = dt ? (dt >= fromD && dt <= toD) : false
      return pidOk && inRange
    })
    return res.json(rows)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'search failed' })
  }
})

router.get('/monthly-statement-photo-stats', requireAnyPerm(['finance.payout', 'finance.tx.write', 'property_expenses.view']), async (req, res) => {
  try {
    const pid = String((req.query as any)?.pid || (req.query as any)?.property_id || '').trim()
    const monthKey = String((req.query as any)?.month || '').trim()
    if (!pid) return res.status(400).json({ message: 'missing pid' })
    const range = monthRangeISO(monthKey)
    if (!range) return res.status(400).json({ message: 'invalid month' })
    const threshold = Math.max(1, Number(process.env.STATEMENT_PHOTO_SPLIT_THRESHOLD || 40))
    const hardThreshold = Math.max(threshold, Number(process.env.STATEMENT_PHOTO_SPLIT_HARD_THRESHOLD || 80))

    let propertyCodeRaw = ''
    if (hasPg && pgPool) {
      try {
        const r = await pgPool.query('SELECT code FROM properties WHERE id=$1 LIMIT 1', [pid])
        propertyCodeRaw = String(r.rows?.[0]?.code || '').trim()
      } catch {}
    } else {
      propertyCodeRaw = String((db as any).properties?.find?.((p: any) => String(p.id) === pid)?.code || '').trim()
    }
    const propertyCode = (() => {
      if (!propertyCodeRaw) return ''
      const s = propertyCodeRaw.split('(')[0].trim()
      const t = s.split(/\s+/)[0].trim()
      return t || s || propertyCodeRaw
    })()

    const maint = await loadMonthlyStatementPhotoRows({
      table: 'property_maintenance',
      pid,
      monthKey,
      range,
      propertyCode,
      propertyCodeRaw,
    })
    const deep = await loadMonthlyStatementPhotoRows({
      table: 'property_deep_cleaning',
      pid,
      monthKey,
      range,
      propertyCode,
      propertyCodeRaw,
    })

    const maintenancePhotoCount = maint.reduce((n, r) => {
      if (!recordHasPhotoUrls(r)) return n
      return n + countPhotoUrls((r as any)?.photo_urls) + countPhotoUrls((r as any)?.repair_photo_urls)
    }, 0)
    const deepCleaningPhotoCount = deep.reduce((n, r) => {
      if (!recordHasPhotoUrls(r)) return n
      return n + countPhotoUrls((r as any)?.photo_urls) + countPhotoUrls((r as any)?.repair_photo_urls)
    }, 0)
    const totalPhotoCount = maintenancePhotoCount + deepCleaningPhotoCount

    return res.json({
      maintenancePhotoCount,
      deepCleaningPhotoCount,
      totalPhotoCount,
      shouldSplit: totalPhotoCount >= threshold,
      hardSplit: totalPhotoCount >= hardThreshold,
      threshold,
      hardThreshold,
    })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'stats failed' })
  }
})

router.post('/statement-photo-pack', requireAnyPerm(['finance.payout', 'finance.tx.write', 'property_expenses.view']), async (req, res) => {
  try {
    const { month, property_id, sections, showChinese, quality_mode, forceNew } = req.body || {}
    const monthKey = String(month || '').trim()
    const pid = String(property_id || '').trim()
    const sec = (() => {
      const raw = String(sections || 'all').trim().toLowerCase()
      if (raw === 'maintenance' || raw === 'deep_cleaning') return raw as StatementPhotoPackSection
      return 'all' as StatementPhotoPackSection
    })()
    if (!/^\d{4}-\d{2}$/.test(monthKey)) return res.status(400).json({ message: 'invalid month' })
    if (!pid) return res.status(400).json({ message: 'missing property_id' })
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    if (!hasR2) return res.status(500).json({ message: 'R2 not configured' })
    await ensurePdfJobsSchema()
    const wantNew = forceNew === true || forceNew === 1 || forceNew === '1'
    const qualityMode = (() => {
      const raw = String(quality_mode || '').trim().toLowerCase()
      if (raw === 'thumbnail') return 'thumbnail'
      return 'compressed'
    })()
    if (!wantNew) {
      try {
        const r0 = await pgPool.query(
          `SELECT id, status, created_at
           FROM pdf_jobs
           WHERE kind='statement_photo_pack'
             AND status IN ('queued', 'running')
             AND (status <> 'running' OR lease_expires_at IS NULL OR lease_expires_at > now())
             AND COALESCE(params->>'month', params->>'month_key') = $1
             AND COALESCE(params->>'property_id', params->>'pid') = $2
             AND COALESCE(params->>'sections', 'all') = $3
             AND COALESCE(params->>'showChinese', 'true') = $4
           ORDER BY created_at DESC
           LIMIT 1`,
          [monthKey, pid, sec, (!(showChinese === false || showChinese === '0')).toString()]
        )
        const existing = r0.rows?.[0] || null
        if (existing?.id) {
          if (String(existing.status || '') === 'queued') kickPdfJobsSoon('reuse_existing_statement_photo_pack')
          return res.json({ job_id: String(existing.id), status: String(existing.status || 'running'), reused: true })
        }
      } catch {}
    }
    const id = uuidv4()
    const params = {
      month: monthKey,
      property_id: pid,
      sections: sec,
      showChinese: !(showChinese === false || showChinese === '0'),
      quality_mode: qualityMode,
    }
    await pgPool.query(
      `INSERT INTO pdf_jobs(id, kind, status, progress, stage, detail, params, result_files, attempts, max_attempts, next_retry_at, created_at, updated_at)
       VALUES($1,'statement_photo_pack','queued',0,'queued',NULL,$2::jsonb,'[]'::jsonb,0,3,now(),now(),now())`,
      [id, JSON.stringify(params)]
    )
    kickPdfJobsSoon('create_statement_photo_pack')
    return res.json({ job_id: id, status: 'queued', reused: false })
  } catch (e: any) {
    const code = String(e?.code || '')
    if (code === 'PDF_JOBS_SCHEMA_MISSING') return res.status(500).json({ message: 'pdf_jobs table missing (apply migration)' })
    return res.status(500).json({ message: e?.message || 'create photo pack job failed' })
  }
})

router.get('/statement-photo-pack/:id', requireAnyPerm(['finance.payout', 'finance.tx.write', 'property_expenses.view']), async (req, res) => {
  try {
    const id = String(req.params?.id || '').trim()
    if (!id) return res.status(400).json({ message: 'missing id' })
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    await ensurePdfJobsSchema()
    const r = await pgPool.query(`SELECT * FROM pdf_jobs WHERE id=$1 AND kind='statement_photo_pack' LIMIT 1`, [id])
    const row = r.rows?.[0] || null
    if (!row) return res.status(404).json({ message: 'not_found' })
    const createdMs = row.created_at ? new Date(row.created_at).getTime() : NaN
    const updatedMs = row.updated_at ? new Date(row.updated_at).getTime() : NaN
    const ageSec = Number.isFinite(createdMs) ? Math.max(0, Math.round((Date.now() - createdMs) / 1000)) : null
    const idleSec = Number.isFinite(updatedMs) ? Math.max(0, Math.round((Date.now() - updatedMs) / 1000)) : null
    return res.json({
      id: row.id,
      kind: row.kind,
      status: row.status,
      progress: Number(row.progress || 0),
      stage: row.stage || '',
      detail: row.detail || '',
      attempts: Number(row.attempts || 0),
      created_at: row.created_at,
      updated_at: row.updated_at,
      age_seconds: ageSec,
      idle_seconds: idleSec,
      next_retry_at: row.next_retry_at || null,
      locked_by: row.locked_by || null,
      lease_expires_at: row.lease_expires_at || null,
      params: row.params || null,
      result_files: row.result_files || [],
      last_error_code: row.last_error_code || null,
      last_error_message: row.last_error_message || null,
    })
  } catch (e: any) {
    const code = String(e?.code || '')
    if (code === 'PDF_JOBS_SCHEMA_MISSING') return res.status(500).json({ message: 'pdf_jobs table missing (apply migration)' })
    return res.status(500).json({ message: e?.message || 'get photo pack job failed' })
  }
})

router.get('/statement-photo-pack/:id/download', requireAnyPerm(['finance.payout', 'finance.tx.write', 'property_expenses.view']), async (req, res) => {
  try {
    const id = String(req.params?.id || '').trim()
    if (!id) return res.status(400).json({ message: 'missing id' })
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    if (!hasR2) return res.status(500).json({ message: 'R2 not configured' })
    await ensurePdfJobsSchema()
    const r = await pgPool.query(`SELECT id, status, stage, result_files FROM pdf_jobs WHERE id=$1 AND kind='statement_photo_pack' LIMIT 1`, [id])
    const row = r.rows?.[0] || null
    if (!row) return res.status(404).json({ message: 'not_found' })
    const st = String(row?.status || '')
    const stage = String(row?.stage || '')
    if (st !== 'success' || stage !== 'done') {
      return res.status(409).json({ message: 'job_not_done', status: st || null, stage: stage || null })
    }
    const files = Array.isArray(row?.result_files) ? row.result_files : []
    const target = files.find((x: any) => String(x?.kind || '') === 'statement_photo_pack_pdf') || files[0]
    const key = String(target?.path || '').trim()
    if (!key) return res.status(404).json({ message: 'file_not_found' })
    const obj = await r2GetObjectByKey(key)
    if (!obj || !obj.body?.length) return res.status(404).json({ message: 'file_not_found' })
    const filename = String(target?.name || `${String(row.id)}.pdf`).replace(/[^a-zA-Z0-9._-]/g, '_')
    res.setHeader('Content-Type', obj.contentType || 'application/octet-stream')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.setHeader('Cache-Control', 'private, max-age=0, no-cache')
    return res.status(200).send(obj.body)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'download failed' })
  }
})

router.post('/merge-monthly-pack', requireAnyPerm(['finance.payout', 'finance.tx.write', 'property_expenses.view', 'invoice.view']), async (req, res) => {
  try {
    const { month, property_id, showChinese, excludeOrphanFixedSnapshots, carryStartMonth, exportQuality, mergeInvoices, forceNew } = req.body || {}
    const monthKey = String(month || '').trim()
    const pid = String(property_id || '').trim()
    if (!/^\d{4}-\d{2}$/.test(monthKey)) return res.status(400).json({ message: 'invalid month' })
    if (!pid) return res.status(400).json({ message: 'missing property_id' })
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    if (!String(process.env.FRONTEND_BASE_URL || '').trim()) return res.status(500).json({ message: 'missing FRONTEND_BASE_URL' })
    if (!hasR2) return res.status(500).json({ message: 'R2 not configured' })
    await ensurePdfJobsSchema()
    const wantNew = forceNew === true || forceNew === 1 || forceNew === '1'
    if (!wantNew) {
      try {
        const r0 = await pgPool.query(
          `SELECT id, status, stage, progress, attempts, locked_by, lease_expires_at, created_at
           FROM pdf_jobs
           WHERE kind='merge_monthly_pack'
             AND status IN ('queued', 'running')
             AND (status <> 'running' OR lease_expires_at IS NULL OR lease_expires_at > now())
             AND COALESCE(params->>'month', params->>'month_key') = $1
             AND COALESCE(params->>'property_id', params->>'pid') = $2
           ORDER BY created_at DESC
           LIMIT 1`,
          [monthKey, pid]
        )
        const existing = r0.rows?.[0] || null
        if (existing?.id) {
          if (String(existing.status || '') === 'queued') kickPdfJobsSoon('reuse_existing_merge_monthly_pack')
          return res.json({ job_id: String(existing.id), status: String(existing.status || 'running'), reused: true })
        }
      } catch {}
    }
    const id = uuidv4()
    const params = {
      month: monthKey,
      property_id: pid,
      showChinese: !(showChinese === false || showChinese === '0'),
      excludeOrphanFixedSnapshots:
        excludeOrphanFixedSnapshots === false || excludeOrphanFixedSnapshots === 0 || excludeOrphanFixedSnapshots === '0'
          ? false
          : true,
      carryStartMonth: /^\d{4}-\d{2}$/.test(String(carryStartMonth || '').trim()) ? String(carryStartMonth).trim() : '2026-01',
      exportQuality: String(exportQuality || '').trim() || null,
      mergeInvoices: mergeInvoices === false ? false : true,
    }
    await pgPool.query(
      `INSERT INTO pdf_jobs(id, kind, status, progress, stage, detail, params, result_files, attempts, max_attempts, next_retry_at, created_at, updated_at)
       VALUES($1,'merge_monthly_pack','queued',0,'queued',NULL,$2::jsonb,'[]'::jsonb,0,3,now(),now(),now())`,
      [id, JSON.stringify(params)]
    )
    kickPdfJobsSoon('create_merge_monthly_pack')
    return res.json({ job_id: id, status: 'queued', reused: false })
  } catch (e: any) {
    const code = String(e?.code || '')
    if (code === 'PDF_JOBS_SCHEMA_MISSING') return res.status(500).json({ message: 'pdf_jobs table missing (apply migration)' })
    return res.status(500).json({ message: e?.message || 'create job failed' })
  }
})

router.get('/merge-monthly-pack/:id/download', requireAnyPerm(['finance.payout', 'finance.tx.write', 'property_expenses.view', 'invoice.view']), async (req, res) => {
  try {
    const id = String(req.params?.id || '').trim()
    const kind = String((req.query as any)?.kind || '').trim()
    if (!id) return res.status(400).json({ message: 'missing id' })
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    if (!hasR2) return res.status(500).json({ message: 'R2 not configured' })
    await ensurePdfJobsSchema()
    const r = await pgPool.query('SELECT id, status, stage, result_files FROM pdf_jobs WHERE id=$1 LIMIT 1', [id])
    const row = r.rows?.[0] || null
    if (!row) return res.status(404).json({ message: 'not_found' })
    const st = String(row?.status || '')
    const stage = String(row?.stage || '')
    if (st !== 'success' || stage !== 'done') {
      return res.status(409).json({ message: 'job_not_done', status: st || null, stage: stage || null })
    }
    const files = Array.isArray(row?.result_files) ? row.result_files : []
    const pick = (k: string) => files.find((x: any) => String(x?.kind || '') === k)
    const merged = pick('statement_merged_invoices')
    const base = pick('statement_base')
    const want = kind ? pick(kind) : (merged || base)
    const key = String(want?.path || '').trim()
    if (!key) return res.status(404).json({ message: 'file_not_found' })
    const obj = await r2GetObjectByKey(key)
    if (!obj || !obj.body?.length) return res.status(404).json({ message: 'file_not_found' })
    const filename = String(want?.name || `${String(row.id)}.pdf`).replace(/[^a-zA-Z0-9._-]/g, '_')
    res.setHeader('Content-Type', obj.contentType || 'application/octet-stream')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.setHeader('Cache-Control', 'private, max-age=0, no-cache')
    return res.status(200).send(obj.body)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'download failed' })
  }
})

router.get('/merge-monthly-pack/:id', requireAnyPerm(['finance.payout', 'finance.tx.write', 'property_expenses.view', 'invoice.view']), async (req, res) => {
  try {
    const id = String(req.params?.id || '').trim()
    if (!id) return res.status(400).json({ message: 'missing id' })
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    await ensurePdfJobsSchema()
    const loadRow = async () => {
      const r = await pgPool!.query('SELECT * FROM pdf_jobs WHERE id=$1 LIMIT 1', [id])
      return r.rows?.[0] || null
    }
    let row = await loadRow()
    if (!row) return res.status(404).json({ message: 'not_found' })
    const createdMs = row.created_at ? new Date(row.created_at).getTime() : NaN
    const updatedMs = row.updated_at ? new Date(row.updated_at).getTime() : NaN
    const ageSec = Number.isFinite(createdMs) ? Math.max(0, Math.round((Date.now() - createdMs) / 1000)) : null
    const idleSec = Number.isFinite(updatedMs) ? Math.max(0, Math.round((Date.now() - updatedMs) / 1000)) : null
    return res.json({
      id: row.id,
      kind: row.kind,
      status: row.status,
      progress: Number(row.progress || 0),
      stage: row.stage || '',
      detail: row.detail || '',
      attempts: Number(row.attempts || 0),
      created_at: row.created_at,
      updated_at: row.updated_at,
      age_seconds: ageSec,
      idle_seconds: idleSec,
      next_retry_at: row.next_retry_at || null,
      locked_by: row.locked_by || null,
      lease_expires_at: row.lease_expires_at || null,
      kick: null,
      params: row.params || null,
      result_files: row.result_files || [],
      last_error_code: row.last_error_code || null,
      last_error_message: row.last_error_message || null,
    })
  } catch (e: any) {
    const code = String(e?.code || '')
    if (code === 'PDF_JOBS_SCHEMA_MISSING') return res.status(500).json({ message: 'pdf_jobs table missing (apply migration)' })
    return res.status(500).json({ message: e?.message || 'get job failed' })
  }
})

// Merge monthly statement PDF with multiple invoice PDFs and return a single PDF
router.post(
  '/merge-pdf',
  requireAnyPerm(['finance.payout', 'finance.tx.write', 'property_expenses.view', 'invoice.view']),
  pdfLimiter,
  mergeUpload.single('statement'),
  async (req: any, res: any) => {
  try {
    const { statement_pdf_base64, statement_pdf_url, invoice_urls } = req.body || {}
    const statementFile = (req as any).file as any
    if (!statementFile?.buffer && !statement_pdf_base64 && !statement_pdf_url) return res.status(400).json({ message: 'missing statement pdf' })
    let urls: string[] = []
    if (Array.isArray(invoice_urls)) {
      urls = invoice_urls.filter((u: any) => typeof u === 'string')
    } else if (typeof invoice_urls === 'string') {
      try {
        const parsed = JSON.parse(invoice_urls)
        if (Array.isArray(parsed)) urls = parsed.filter((u: any) => typeof u === 'string')
        else if (typeof parsed === 'string') urls = [parsed]
      } catch {
        urls = invoice_urls.split(',').map(s => s.trim()).filter(Boolean)
      }
    }
    const allowedHosts = (() => {
      const hosts = new Set<string>()
      const addHost = (h: string) => { if (h) hosts.add(h.toLowerCase()) }
      try {
        const apiBase = String(process.env.API_BASE || '')
        if (apiBase) addHost(new URL(apiBase).host)
      } catch {}
      try {
        const r2Base = String(process.env.R2_PUBLIC_BASE_URL || process.env.R2_PUBLIC_BASE || '')
        if (r2Base) addHost(new URL(r2Base).host)
      } catch {}
      const reqHost = String(req.headers.host || '')
      if (reqHost) addHost(reqHost)
      return hosts
    })()
    function normalizeFetchUrl(input: string): string {
      const raw = String(input || '').trim()
      if (!raw) throw new Error('invalid url')
      if (raw.startsWith('/')) {
        const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http')
        const host = String(req.headers.host || '')
        if (!host) throw new Error('invalid host')
        return `${proto}://${host}${raw}`
      }
      return raw
    }
    function assertAllowed(urlStr: string) {
      const u = new URL(urlStr)
      const proto = u.protocol.toLowerCase()
      if (proto !== 'http:' && proto !== 'https:') throw new Error('invalid protocol')
      const host = u.host.toLowerCase()
      if (!allowedHosts.has(host)) throw new Error('disallowed host')
    }
    async function fetchBytes(u: string): Promise<Uint8Array> {
      const url = normalizeFetchUrl(u)
      assertAllowed(url)
      const timeoutMs = Math.max(1000, Math.min(120000, Number(process.env.MERGE_FETCH_TIMEOUT_MS || 20000)))
      const ac = new AbortController()
      const t = setTimeout(() => { try { ac.abort() } catch {} }, timeoutMs)
      let r: any
      try {
        r = await fetch(url, { signal: ac.signal } as any)
      } finally {
        clearTimeout(t)
      }
      if (!r.ok) throw new Error(`fetch failed: ${r.status}`)
      const ab = await r.arrayBuffer()
      return new Uint8Array(ab)
    }
    let merged = await PDFDocument.create()
    // append statement
    if (statementFile?.buffer && Buffer.isBuffer(statementFile.buffer)) {
      let src: any
      try {
        src = await PDFDocument.load(new Uint8Array(statementFile.buffer))
      } catch (e: any) {
        return res.status(400).json({ message: `invalid statement pdf: ${String(e?.message || 'load failed')}` })
      }
      const copied = await merged.copyPages(src, src.getPageIndices())
      copied.forEach(p => merged.addPage(p))
    } else if (statement_pdf_base64 && typeof statement_pdf_base64 === 'string') {
      const b64 = statement_pdf_base64.replace(/^data:application\/pdf;base64,/, '')
      const bytes = Uint8Array.from(Buffer.from(b64, 'base64'))
      let src: any
      try {
        src = await PDFDocument.load(bytes)
      } catch (e: any) {
        return res.status(400).json({ message: `invalid statement pdf: ${String(e?.message || 'load failed')}` })
      }
      const copied = await merged.copyPages(src, src.getPageIndices())
      copied.forEach(p => merged.addPage(p))
    } else if (statement_pdf_url && typeof statement_pdf_url === 'string') {
      const bytes = await fetchBytes(statement_pdf_url)
      let src: any
      try {
        src = await PDFDocument.load(bytes)
      } catch (e: any) {
        return res.status(400).json({ message: `invalid statement pdf: ${String(e?.message || 'load failed')}` })
      }
      const copied = await merged.copyPages(src, src.getPageIndices())
      copied.forEach(p => merged.addPage(p))
    }
    for (const u of urls) {
      try {
        if (/\.pdf($|\?)/i.test(u || '')) {
          const bytes = await fetchBytes(u)
          const src = await PDFDocument.load(bytes)
          const copied = await merged.copyPages(src, src.getPageIndices())
          copied.forEach(p => merged.addPage(p))
        } else if (/\.(png|jpg|jpeg)($|\?)/i.test(u || '')) {
          const bytes = await fetchBytes(u)
          const img = /\.png($|\?)/i.test(u || '') ? await merged.embedPng(bytes) : await merged.embedJpg(bytes)
          const page = merged.addPage([595, 842])
          const maxW = 595 - 60
          const maxH = 842 - 60
          const scale = Math.min(maxW / img.width, maxH / img.height)
          const w = img.width * scale
          const h = img.height * scale
          const x = (595 - w) / 2
          const y = (842 - h) / 2
          page.drawImage(img, { x, y, width: w, height: h })
        }
      } catch {}
    }
    const out = await merged.save({ useObjectStreams: false })
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', 'attachment; filename="statement-merged.pdf"')
    return res.status(200).send(Buffer.from(out))
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'merge failed' })
  }
  },
  (err: any, _req: any, res: any, _next: any) => {
    const code = String(err?.code || '')
    if (code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ message: `报表PDF过大（最大 ${mergeMaxMb}MB）` })
    }
    if (code) return res.status(400).json({ message: err?.message || `upload failed (${code})` })
    return res.status(500).json({ message: err?.message || 'merge failed' })
  }
)

router.post('/monthly-statement-pdf', requireAnyPerm(['finance.payout', 'finance.tx.write', 'property_expenses.view']), pdfLimiter, async (req: any, res: any) => {
  try {
    const { month, property_id, showChinese, includePhotosMode, includePhotos, sections, photo_w, photo_q, excludeOrphanFixedSnapshots, carryStartMonth } = req.body || {}
    const monthKey = String(month || '').trim()
    const pid = String(property_id || '').trim()
    if (!/^\d{4}-\d{2}$/.test(monthKey)) return res.status(400).json({ message: 'invalid month' })
    if (!pid) return res.status(400).json({ message: 'missing property_id' })
    const front = String(process.env.FRONTEND_BASE_URL || req.headers.origin || '').trim()
    if (!front) return res.status(500).json({ message: 'missing FRONTEND_BASE_URL' })
    const token = (() => {
      const h = String(req.headers.authorization || '')
      const m = h.match(/^Bearer\s+(.+)$/i)
      if (m) return m[1].trim()
      const c = String(req.headers.cookie || '')
      const cm = c.match(/(?:^|;\s*)auth=([^;]+)/)
      return cm ? decodeURIComponent(cm[1]) : ''
    })()
    if (!token) return res.status(401).json({ message: 'missing token' })
    const photos = (() => {
      if (includePhotos === 0 || includePhotos === '0' || includePhotos === false) return 'off'
      const v = String(includePhotosMode || 'full')
      if (v === 'thumbnail' || v === 'compressed' || v === 'off') return v
      return 'full'
    })()
    const sec = (() => {
      if (Array.isArray(sections)) return sections.map((x: any) => String(x || '').trim()).filter(Boolean).join(',')
      if (typeof sections === 'string') return sections.split(',').map(s => s.trim()).filter(Boolean).join(',')
      return 'all'
    })()
    const compress = (() => {
      const w0 = Number(photo_w || 0)
      const q0 = Number(photo_q || 0)
      const w = Math.max(600, Math.min(2400, Number.isFinite(w0) && w0 > 0 ? w0 : 0))
      const q = Math.max(40, Math.min(85, Number.isFinite(q0) && q0 > 0 ? q0 : 0))
      return { w: w || undefined, q: q || undefined }
    })()
    const excludeOrphans = (() => {
      if (excludeOrphanFixedSnapshots === true || excludeOrphanFixedSnapshots === 1 || excludeOrphanFixedSnapshots === '1') return true
      if (excludeOrphanFixedSnapshots === false || excludeOrphanFixedSnapshots === 0 || excludeOrphanFixedSnapshots === '0') return false
      return true
    })()
    const url = (() => {
      const u = new URL('/public/monthly-statement-print', front)
      u.searchParams.set('pid', pid)
      u.searchParams.set('month', monthKey)
      u.searchParams.set('pdf', '1')
      u.searchParams.set('showChinese', String(showChinese === false || showChinese === '0' ? '0' : '1'))
      u.searchParams.set('photos', photos)
      u.searchParams.set('sections', sec || 'all')
      u.searchParams.set('exclude_orphan_fixed', excludeOrphans ? '1' : '0')
      u.searchParams.set('carry_start_month', /^\d{4}-\d{2}$/.test(String(carryStartMonth || '').trim()) ? String(carryStartMonth).trim() : '2026-01')
      if (photos === 'compressed') {
        if (compress.w) u.searchParams.set('photo_w', String(compress.w))
        if (compress.q) u.searchParams.set('photo_q', String(compress.q))
      }
      return u.toString()
    })()
    let browser = await getChromiumBrowser()
    let context: any = null
    try { context = await browser.newContext() } catch (e: any) {
      if (!isPlaywrightClosedError(e)) throw e
      await resetChromiumBrowser()
      browser = await getChromiumBrowser()
      context = await browser.newContext()
    }
    try {
      const apiBaseForAssets = String(
        process.env.NEXT_PUBLIC_API_BASE_URL ||
        process.env.NEXT_PUBLIC_API_BASE_DEV ||
        process.env.NEXT_PUBLIC_API_BASE ||
        ''
      ).trim()
      const cookieBase = (baseUrl: string) => {
        const isHttps = /^https:\/\//i.test(baseUrl)
        return {
          name: 'auth',
          value: token,
          url: baseUrl,
          sameSite: isHttps ? 'None' : 'Lax',
          secure: isHttps,
        }
      }
      const cookieTargets = Array.from(new Set([front, apiBaseForAssets].map(s => String(s || '').trim()).filter(Boolean)))
      if (cookieTargets.length) {
        await context.addCookies(cookieTargets.map(cookieBase) as any)
      }
      const page = await context.newPage()
      const pushCap = (arr: string[], s: string, cap = 30) => {
        const v = String(s || '').slice(0, 500)
        if (!v) return
        arr.push(v)
        if (arr.length > cap) arr.splice(0, arr.length - cap)
      }
      const consoleNotes: string[] = []
      const pageErrors: string[] = []
      const requestFails: string[] = []
      try {
        page.on('console', (msg: any) => {
          const t = String(msg?.type?.() || '')
          if (t === 'error' || t === 'warning') pushCap(consoleNotes, `${t}: ${String(msg?.text?.() || '')}`)
        })
        page.on('pageerror', (err: any) => pushCap(pageErrors, String(err?.message || err || 'pageerror')))
        page.on('requestfailed', (req: any) => {
          const u = String(req?.url?.() || '')
          const ft = String(req?.failure?.()?.errorText || '')
          pushCap(requestFails, ft ? `${u} (${ft})` : u)
        })
      } catch {}
      const navTimeoutMs = Math.max(5000, Math.min(120000, Number(process.env.PDF_NAV_TIMEOUT_MS || 45000)))
      const waitTimeoutMs = Math.max(5000, Math.min(120000, Number(process.env.PDF_WAIT_TIMEOUT_MS || 45000)))
      page.setDefaultTimeout(waitTimeoutMs)
      page.setDefaultNavigationTimeout(navTimeoutMs)
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: navTimeoutMs })
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {})
      await page.evaluate(() => (document as any).fonts?.ready).catch(() => {})
      await page.waitForSelector('[data-monthly-statement-root="1"]', { timeout: waitTimeoutMs })
      const readRootAttrs = async () => {
        const curUrl = String(page.url?.() || '')
        const title = await page.title().catch(() => '')
        const hasRoot = await page.$('[data-monthly-statement-root="1"]').then((h: any) => !!h).catch(() => false)
        const attrs = await page.evaluate(() => {
          const el = document.querySelector('[data-monthly-statement-root="1"]') as any
          if (!el) return null
          return {
            ready: String(el.getAttribute('data-monthly-statement-ready') || ''),
            deepLoaded: String(el.getAttribute('data-deep-clean-loaded') || ''),
            deepCount: String(el.getAttribute('data-deep-clean-count') || ''),
            maintLoaded: String(el.getAttribute('data-maint-loaded') || ''),
            maintCount: String(el.getAttribute('data-maint-count') || ''),
            balanceShow: String(el.getAttribute('data-balance-show') || ''),
            openingCarry: String(el.getAttribute('data-balance-opening-carry') || ''),
            closingCarry: String(el.getAttribute('data-balance-closing-carry') || ''),
            payable: String(el.getAttribute('data-balance-payable') || ''),
            carrySource: String(el.getAttribute('data-balance-carry-source') || ''),
          }
        }).catch(() => null)
        return { curUrl, title, hasRoot, attrs }
      }
      try {
        const u0 = String(page.url?.() || '')
        if (u0.includes('/login')) throw new Error('print page redirected to /login')
        await page.waitForFunction(() => {
          const el = document.querySelector('[data-monthly-statement-root="1"]') as any
          if (!el) return false
          const ready = String(el.getAttribute('data-monthly-statement-ready') || '') === '1'
          return ready
        }, { timeout: waitTimeoutMs } as any)
      } catch (e: any) {
        const d = await readRootAttrs().catch(() => ({ curUrl: '', title: '', hasRoot: false, attrs: null as any }))
        try {
          const msg = String(e?.message || e || 'timeout')
          console.error(
            `[monthly-statement-pdf][ready-timeout] month=${monthKey} pid=${pid} url=${d.curUrl} title=${d.title} hasRoot=${d.hasRoot} attrs=${d.attrs ? JSON.stringify(d.attrs) : ''} ${msg}` +
              `${consoleNotes.length ? ` console=${consoleNotes.slice(-5).join(' | ')}` : ''}` +
              `${pageErrors.length ? ` pageErrors=${pageErrors.slice(-3).join(' | ')}` : ''}` +
              `${requestFails.length ? ` requestFails=${requestFails.slice(-3).join(' | ')}` : ''}`
          )
        } catch {}
        if (!d.hasRoot) throw new Error('monthly statement print page not ready (root missing)')
        if (String(d.curUrl || '').includes('/login')) throw new Error('monthly statement print page redirected to /login (auth failed)')
      }
      const imgStats = await waitForImages(page, { timeoutMs: 20000, scroll: true, maxFailedUrls: 8 }).catch(() => ({ total: 0, notLoaded: 0, failedUrls: [] as string[] }))
      try {
        if (Number(imgStats?.notLoaded || 0) > 0) {
          const sample = (imgStats as any)?.failedUrls?.length ? ` sample=${(imgStats as any).failedUrls.join(' | ')}` : ''
          console.error(`[monthly-statement-pdf][img-timeout] month=${monthKey} pid=${pid} total=${imgStats.total} notLoaded=${imgStats.notLoaded}${sample}`)
        }
      } catch {}
      await page.waitForTimeout(200)
      await page.emulateMedia({ media: 'print' } as any)
      const pdf = await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true })
      res.setHeader('Content-Type', 'application/pdf')
      res.setHeader('Content-Disposition', `attachment; filename="monthly-statement-${monthKey}.pdf"`)
      return res.status(200).send(Buffer.from(pdf))
    } finally {
      try { await context.close() } catch {}
    }
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'pdf failed' })
  }
})

router.post('/monthly-statement-photos-pdf', requireAnyPerm(['finance.payout', 'finance.tx.write', 'property_expenses.view']), pdfLimiter, async (req: any, res: any) => {
  try {
    const { month, property_id, showChinese, includePhotosMode, includePhotos, sections, photo_w, photo_q } = req.body || {}
    const monthKey = String(month || '').trim()
    const pid = String(property_id || '').trim()
    const reqId = (() => {
      const h =
        String(req.headers['x-request-id'] || req.headers['x-amzn-trace-id'] || req.headers['cf-ray'] || '')
          .split(',')[0]
          .trim()
      return h || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
    })()
    if (!/^\d{4}-\d{2}$/.test(monthKey)) return res.status(400).json({ message: 'invalid month' })
    if (!pid) return res.status(400).json({ message: 'missing property_id' })
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    const apiBase = (() => {
      const host = String((req.headers['x-forwarded-host'] as any) || req.headers.host || '').split(',')[0].trim()
      const proto = String((req.headers['x-forwarded-proto'] as any) || req.protocol || 'https').split(',')[0].trim()
      return host ? `${proto}://${host}` : ''
    })()
    const photosMode = (() => {
      if (includePhotos === 0 || includePhotos === '0' || includePhotos === false) return 'off'
      const v = String(includePhotosMode || 'full').trim().toLowerCase()
      if (v === 'thumbnail' || v === 'compressed') return v as 'thumbnail' | 'compressed'
      return 'full'
    })()
    const sec = (() => {
      const raw = Array.isArray(sections) ? sections.join(',') : String(sections || 'all')
      if (/deep[_-]?clean/i.test(raw) && !/maintenance/i.test(raw)) return 'deep_cleaning'
      if (/maintenance/i.test(raw) && !/deep[_-]?clean/i.test(raw)) return 'maintenance'
      return 'all'
    })() as StatementPhotoPackSection
    const compress = (() => {
      const w0 = Number(photo_w || 0)
      const q0 = Number(photo_q || 0)
      const w = Math.max(600, Math.min(2400, Number.isFinite(w0) && w0 > 0 ? w0 : 1400))
      const q = Math.max(40, Math.min(85, Number.isFinite(q0) && q0 > 0 ? q0 : 72))
      return { w, q }
    })()
    const totalTimeoutMs = Math.max(15000, Math.min(120000, Number(process.env.MONTHLY_STATEMENT_SYNC_TIMEOUT_MS || 60000)))
    const built = await Promise.race([
      generateStatementPhotoPackPdf({
        month: monthKey,
        propertyId: pid,
        sections: sec,
        showChinese: !(showChinese === false || showChinese === '0'),
        apiBase,
        photosMode,
        compress,
        syncGuard: true,
      }),
      new Promise((_, reject) => {
        setTimeout(() => {
          const err: any = new Error('pdf_generation_timeout')
          err.code = 'PDF_GENERATION_TIMEOUT'
          reject(err)
        }, totalTimeoutMs)
      }),
    ]) as Awaited<ReturnType<typeof generateStatementPhotoPackPdf>>
    try {
      console.log(`[monthly-statement-photos-pdf][pdf] reqId=${reqId} month=${monthKey} pid=${pid} sections=${sec} mode=${built.effectivePhotosMode} rawUrls=${built.rawUrls} cleanedUrls=${built.cleanedUrls} imageCount=${built.imageCount} notLoaded=${built.notLoaded} bytes=${built.pdf.length}`)
    } catch {}
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="${built.filename.replace(/"/g, '_')}"`)
    res.setHeader('X-MSP-ReqId', reqId)
    res.setHeader('X-MSP-RawUrls', String(built.rawUrls))
    res.setHeader('X-MSP-UrlCleaned', String(built.cleanedUrls))
    res.setHeader('X-MSP-ImageCount', String(built.imageCount))
    res.setHeader('X-MSP-PhotosMode-Effective', String(built.effectivePhotosMode))
    res.setHeader('X-MSP-ImgNotLoaded', String(built.notLoaded))
    res.setHeader('X-MSP-PdfBytes', String(built.pdf.length))
    return res.status(200).send(built.pdf)
  } catch (e: any) {
    const code = String(e?.code || '')
    if (code === 'NO_PHOTOS_TO_RENDER') return res.status(422).json({ message: 'no photos to render for requested sections' })
    if (code === 'MEMORY_GUARD_BLOCKED') {
      return res.status(409).json({
        message: '照片较多，当前版本已改为后台生成，请稍后使用照片分卷下载',
        error_code: 'too_many_photos_for_sync_export',
        rawUrls: Number(e?.rawUrls || 0),
        syncMaxPhotos: Number(e?.syncMaxPhotos || 0),
      })
    }
    if (code === 'PDF_GENERATION_TIMEOUT') return res.status(504).json({ message: 'pdf_generation_timeout' })
    if (code === 'PDF_IMAGE_FETCH_TIMEOUT') return res.status(504).json({ message: 'pdf_image_fetch_timeout' })
    return res.status(500).json({ message: e?.message || 'pdf failed' })
  }
})

router.post('/send-monthly', requirePerm('finance.payout'), (req, res) => {
  const { landlord_id, month } = req.body || {}
  if (!landlord_id || !month) return res.status(400).json({ message: 'missing landlord_id or month' })
  res.json({ ok: true })
})

router.post('/send-annual', requirePerm('finance.payout'), (req, res) => {
  const { landlord_id, year } = req.body || {}
  if (!landlord_id || !year) return res.status(400).json({ message: 'missing landlord_id or year' })
  res.json({ ok: true })
})

const revenueStatusGetMonthRe = /^\d{4}-\d{2}$/
router.get('/property-revenue-status', async (req, res) => {
  try {
    const from = String((req.query as any)?.from || '')
    const to = String((req.query as any)?.to || '')
    const property_id = String((req.query as any)?.property_id || '')
    const hasRange = !!(from && to)
    if (hasRange && (!revenueStatusGetMonthRe.test(from) || !revenueStatusGetMonthRe.test(to))) {
      return res.status(400).json({ message: 'invalid month range' })
    }
    if (hasPg) {
      const wh: string[] = []
      const vals: any[] = []
      if (hasRange) {
        wh.push(`month_key >= $${vals.length + 1} AND month_key <= $${vals.length + 2}`)
        vals.push(from, to)
      }
      if (property_id) {
        wh.push(`property_id = $${vals.length + 1}`)
        vals.push(property_id)
      }
      const where = wh.length ? `WHERE ${wh.join(' AND ')}` : ''
      const sql = `SELECT * FROM property_revenue_statuses ${where} ORDER BY month_key ASC`
      const rs = await pgPool!.query(sql, vals)
      return res.json(rs.rows || [])
    }
    const list = db.propertyRevenueStatuses || []
    const filtered = list.filter((r) => {
      if (property_id && String(r.property_id) !== property_id) return false
      if (hasRange && (String(r.month_key) < from || String(r.month_key) > to)) return false
      return true
    })
    filtered.sort((a, b) => String(a.month_key).localeCompare(String(b.month_key)))
    return res.json(filtered)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'get status failed' })
  }
})

const revenueStatusPatchSchema = z.object({
  property_id: z.string().min(1),
  month_key: z.string().regex(revenueStatusGetMonthRe),
  scheduled_email_set: z.boolean().optional(),
  transferred: z.boolean().optional(),
})
router.patch('/property-revenue-status', requirePerm('finance.payout'), async (req, res) => {
  const parsed = revenueStatusPatchSchema.safeParse(req.body || {})
  if (!parsed.success) {
    const msg = parsed.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; ')
    return res.status(400).json({ message: msg || 'invalid payload' })
  }
  const actor = String((req as any)?.user?.sub || '')
  try {
    const nowIso = new Date().toISOString()
    const { property_id, month_key, scheduled_email_set, transferred } = parsed.data
    if (hasPg) {
      const exists = await pgSelect('property_revenue_statuses', '*', { property_id, month_key })
      const before = Array.isArray(exists) ? exists[0] : null
      if (before?.id) {
        const updated: any = {
          scheduled_email_set: scheduled_email_set ?? before.scheduled_email_set ?? false,
          transferred: transferred ?? before.transferred ?? false,
          updated_at: nowIso,
          updated_by: actor || null,
        }
        const row = await pgUpdate('property_revenue_statuses', String(before.id), updated)
        try { addAudit('PropertyRevenueStatus', String(before.id), 'update', before, row || { ...before, ...updated }, actor || undefined) } catch {}
        return res.json(row || { ...before, ...updated })
      }
      const id = require('uuid').v4()
      const created: PropertyRevenueStatus = {
        id,
        property_id,
        month_key,
        scheduled_email_set: scheduled_email_set ?? false,
        transferred: transferred ?? false,
        updated_at: nowIso,
        updated_by: actor || undefined,
      }
      const row = await pgInsert('property_revenue_statuses', created as any)
      try { addAudit('PropertyRevenueStatus', id, 'create', null, row || created, actor || undefined) } catch {}
      return res.status(201).json(row || created)
    }
    const list = db.propertyRevenueStatuses || (db.propertyRevenueStatuses = [])
    const idx = list.findIndex(r => String(r.property_id) === property_id && String(r.month_key) === month_key)
    if (idx >= 0) {
      const before = list[idx]
      const after: PropertyRevenueStatus = {
        ...before,
        scheduled_email_set: scheduled_email_set ?? before.scheduled_email_set ?? false,
        transferred: transferred ?? before.transferred ?? false,
        updated_at: nowIso,
        updated_by: actor || undefined,
      }
      list[idx] = after
      try { addAudit('PropertyRevenueStatus', String(after.id), 'update', before, after, actor || undefined) } catch {}
      return res.json(after)
    }
    const id = require('uuid').v4()
    const created: PropertyRevenueStatus = {
      id,
      property_id,
      month_key,
      scheduled_email_set: scheduled_email_set ?? false,
      transferred: transferred ?? false,
      updated_at: nowIso,
      updated_by: actor || undefined,
    }
    list.push(created)
    try { addAudit('PropertyRevenueStatus', id, 'create', null, created, actor || undefined) } catch {}
    return res.status(201).json(created)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'update status failed' })
  }
})

// Property revenue aggregated by fixed expenses report_category and order income
router.get('/property-revenue', async (req, res) => {
  try {
    const { property_id, property_code, month } = (req.query || {}) as any
    if (!month || (!(property_id) && !(property_code))) return res.status(400).json({ message: 'missing month or property' })
    const excludeOrphanFixedSnapshots = String(((req.query as any)?.exclude_orphan_fixed_snapshots ?? '')).toLowerCase() === 'true' || String(((req.query as any)?.exclude_orphan_fixed_snapshots ?? '')) === '1'
    const ym = String(month)
    const y = Number(ym.slice(0,4))
    const m = Number(ym.slice(5,7))
    if (!y || !m) return res.status(400).json({ message: 'invalid month format' })
    const start = new Date(Date.UTC(y, m - 1, 1))
    const end = new Date(Date.UTC(y, m, 0))
    let pid = String(property_id || '')
    let pcode = String(property_code || '')
    let label = ''
    if (hasPg) {
      try {
        const { pgPool } = require('../dbAdapter')
        if (pgPool) {
          if (!pid && pcode) {
            const qr = await pgPool.query('SELECT id,code,address FROM properties WHERE lower(code) = lower($1) LIMIT 1', [pcode])
            if (qr.rows && qr.rows[0]) pid = qr.rows[0].id, label = qr.rows[0].code || qr.rows[0].address || ''
          } else if (pid) {
            const qr = await pgPool.query('SELECT id,code,address FROM properties WHERE id = $1 LIMIT 1', [pid])
            if (qr.rows && qr.rows[0]) label = qr.rows[0].code || qr.rows[0].address || ''
          }
        }
      } catch {}
    }
    const cols = { parking_fee: 0, electricity: 0, water: 0, gas: 0, internet: 0, consumables: 0, body_corp: 0, council: 0, other: 0, management_fee: 0 }
    let rentIncome = 0
    let warnings: string[] = []
    const orphanFixedSnapshots: Array<{ expense_id: string; fixed_expense_id: string; month_key?: string; amount: number; category?: string }> = []
    let orphanFixedSnapshotsTotal = 0
    try {
      if (hasPg) {
        const orders = await pgSelect('orders', '*', { property_id: pid })
        const ords: any[] = Array.isArray(orders) ? orders : []
        function toDate(s: any): Date | null { try { return s ? new Date(String(s)) : null } catch { return null } }
        function overlapNights(ci?: any, co?: any): number {
          const a = toDate(ci)
          const b = toDate(co)
          if (!a || !b) return 0
          const A = a > start ? a : start
          const B = b < end ? b : end
          const ms = B.getTime() - A.getTime()
          return ms > 0 ? Math.floor(ms / (24 * 3600 * 1000)) : 0
        }
        for (const o of ords) {
          const ov = overlapNights(o.checkin, o.checkout)
          const nights = Number(o.nights || 0) || 0
          const visNet = Number((o as any).visible_net_income ?? o.net_income ?? 0)
          const status = String((o as any).status || '').toLowerCase()
          const isCanceled = status.includes('cancel')
          const include = (!isCanceled) || !!(o as any).count_in_income
          if (include && ov > 0 && nights > 0) rentIncome += (visNet * ov) / nights
        }
        let peRows: any[] = []
        try {
          const { pgPool } = require('../dbAdapter')
          if (pgPool) {
            const sql = `SELECT * FROM property_expenses
              WHERE (property_id = $1 OR lower(property_id) = lower($2))
                AND (
                  month_key = $3 OR
                  date_trunc('month', COALESCE(paid_date, occurred_at)::date) = date_trunc('month', to_date($3,'YYYY-MM'))
                )`
            const rs = await pgPool.query(sql, [pid || null, pcode || null, ym])
            peRows = rs.rows || []
          }
        } catch {}
        const rp = await pgSelect('recurring_payments', '*')
        const rpRows: any[] = Array.isArray(rp) ? rp : []
        const map: Record<string, string> = Object.fromEntries(rpRows.map(r => [String(r.id), String((r as any).report_category || 'other')]))
        function toReportCat(raw?: string, detail?: string): string {
          const v = String(raw||'').toLowerCase()
          const d = String(detail||'').toLowerCase()
          const s = v + ' ' + d
          // explicit category values
          if (['carpark'].includes(v)) return 'parking_fee'
          if (['owners_corp','ownerscorp','body_corp','bodycorp'].includes(v)) return 'body_corp'
          if (['internet','nbn'].includes(v)) return 'internet'
          if (['electricity'].includes(v)) return 'electricity'
          if (['water'].includes(v)) return 'water'
          if (['gas','gas_hot_water','hot_water'].includes(v)) return 'gas'
          if (['consumables'].includes(v)) return 'consumables'
          if (['council_rate','council'].includes(v)) return 'council'
          // heuristics & Chinese labels
          if (s.includes('车位')) return 'parking_fee'
          if (s.includes('物业')) return 'body_corp'
          if (s.includes('internet') || s.includes('nbn') || s.includes('网')) return 'internet'
          if (s.includes('electric') || s.includes('电')) return 'electricity'
          if ((s.includes('water') || s.includes('水')) && !s.includes('热')) return 'water'
          if (s.includes('gas') || s.includes('热水') || s.includes('煤气')) return 'gas'
          if (s.includes('consumable') || s.includes('消耗')) return 'consumables'
          if (s.includes('council') || s.includes('市政')) return 'council'
          if (s.includes('管理费') || s.includes('management')) return 'management_fee'
          return 'other'
        }
        for (const e of peRows) {
          const fid = String((e as any).fixed_expense_id || '')
          const amt = Number((e as any).amount || 0)
          if (fid && !map[fid]) {
            const genFrom = String((e as any).generated_from || '')
            const note = String((e as any).note || '')
            const isSnapshot = genFrom === 'recurring_payments' || /^fixed payment/i.test(note)
            if (isSnapshot) {
              orphanFixedSnapshotsTotal += amt
              if (orphanFixedSnapshots.length < 20) {
                orphanFixedSnapshots.push({
                  expense_id: String((e as any).id || ''),
                  fixed_expense_id: fid,
                  month_key: String((e as any).month_key || '') || undefined,
                  amount: amt,
                  category: String((e as any).category || '') || undefined,
                })
              }
              if (excludeOrphanFixedSnapshots) continue
            }
          }
          const cat = fid ? (map[fid] || 'other') : toReportCat(String((e as any).category || ''), String((e as any).category_detail || ''))
          if (cat in cols) (cols as any)[cat] += amt
          else cols.other += amt
        }
        const missingMonthKey = peRows.filter((e: any) => !e.month_key).length
        if (missingMonthKey > 0) warnings.push(`expenses_without_month_key=${missingMonthKey}`)
        if (orphanFixedSnapshots.length > 0) warnings.push(`orphan_fixed_expense_snapshots=${orphanFixedSnapshots.length}`)
        // Auto compute management fee only when the month has no recorded management_fee expense.
        try {
          if (!Number(cols.management_fee || 0)) {
            await ensureManagementFeeRulesTable()
            const props = await pgSelect('properties', 'id,landlord_id', { id: pid })
            const prop = Array.isArray(props) ? props[0] : null
            const resolved = prop?.landlord_id ? await resolveManagementFeeRateForMonth(String(prop.landlord_id), ym) : { rate: null as number | null }
            const rate = Number(resolved?.rate || 0)
            if (rate && rentIncome) {
              const fee = Number(((rentIncome * rate)).toFixed(2))
              cols.management_fee += fee
            }
          }
        } catch {}
      }
    } catch {}
    const totalExpense = Object.entries(cols).reduce((s, [k, v]) => s + (k === 'management_fee' ? Number(v || 0) : Number(v || 0)), 0)
    const payload: any = {
      property_code: label || pcode || pid,
      month: ym,
      parking_fee: -Number(cols.parking_fee || 0),
      electricity: -Number(cols.electricity || 0),
      water: -Number(cols.water || 0),
      gas: -Number(cols.gas || 0),
      internet: -Number(cols.internet || 0),
      consumables: -Number(cols.consumables || 0),
      body_corp: -Number(cols.body_corp || 0),
      council: -Number(cols.council || 0),
      other: -Number(cols.other || 0),
      management_fee: -Number(cols.management_fee || 0),
      total_expense: -Number(totalExpense || 0),
      net_income: Number(rentIncome || 0) - Number(totalExpense || 0)
    }
    if (orphanFixedSnapshots.length) {
      payload.orphan_fixed_expense_snapshots_total = -Number(orphanFixedSnapshotsTotal || 0)
      payload.orphan_fixed_expense_snapshots_sample = orphanFixedSnapshots
      payload.exclude_orphan_fixed_snapshots = excludeOrphanFixedSnapshots
    }
    if (warnings.length) payload.warnings = warnings
    return res.json(payload)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'property-revenue failed' })
  }
})

function parseMonthKeyOrNull(monthKey: any): { monthKey: string; start: string; nextStart: string } | null {
  const ym = String(monthKey || '').trim()
  if (!/^\d{4}-\d{2}$/.test(ym)) return null
  const y = Number(ym.slice(0, 4))
  const m = Number(ym.slice(5, 7))
  if (!y || !m) return null
  const start = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-01`
  const next = new Date(Date.UTC(y, m, 1))
  const ny = next.getUTCFullYear()
  const nm = next.getUTCMonth() + 1
  const nextStart = `${String(ny).padStart(4, '0')}-${String(nm).padStart(2, '0')}-01`
  return { monthKey: ym, start, nextStart }
}

router.get('/rent-segments', requireAnyPerm(['finance.payout', 'finance.tx.write', 'property_expenses.view']), async (req, res) => {
  try {
    const m = parseMonthKeyOrNull((req.query as any)?.month)
    const property_id = String(((req.query as any)?.property_id) || '').trim()
    if (!m) return res.status(400).json({ message: 'invalid month' })
    if (!property_id) return res.status(400).json({ message: 'missing property_id' })
    if (!hasPg || !pgPool) return res.status(400).json({ message: 'pg required' })
    const ordersRs = await pgPool.query(
      'SELECT * FROM orders WHERE property_id = $1 AND checkin < $3::date AND checkout > $2::date',
      [property_id, m.start, m.nextStart]
    )
    const orders: any[] = ordersRs.rows || []
    const ids = orders.map((o) => String(o.id || '')).filter(Boolean)
    const totals: Record<string, number> = {}
    if (ids.length) {
      try {
        const dRs = await pgPool.query(
          'SELECT order_id, COALESCE(SUM(amount),0) AS total FROM order_internal_deductions WHERE is_active=true AND order_id = ANY($1) GROUP BY order_id',
          [ids]
        )
        const arr = (dRs?.rows || []) as any[]
        arr.forEach((r) => { totals[String(r.order_id)] = Number(r.total || 0) })
      } catch {}
    }
    const enriched = orders.map((o) => ({ ...o, internal_deduction_total: Number((totals[String(o.id)] || 0).toFixed(2)) }))
    const segments = computeMonthSegmentsForOrders(enriched, m.monthKey)
    const rent_income = sumSegmentsVisibleNetIncome(segments)
    return res.json({ month: m.monthKey, property_id, segments, rent_income })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'rent-segments failed' })
  }
})

router.get('/rent-income-by-property', requireAnyPerm(['finance.payout', 'finance.tx.write', 'property_expenses.view']), async (req, res) => {
  try {
    const m = parseMonthKeyOrNull((req.query as any)?.month)
    if (!m) return res.status(400).json({ message: 'invalid month' })
    if (!hasPg || !pgPool) return res.status(400).json({ message: 'pg required' })
    const ordersRs = await pgPool.query(
      'SELECT * FROM orders WHERE property_id IS NOT NULL AND checkin < $2::date AND checkout > $1::date',
      [m.start, m.nextStart]
    )
    const orders: any[] = ordersRs.rows || []
    const ids = orders.map((o) => String(o.id || '')).filter(Boolean)
    const totals: Record<string, number> = {}
    if (ids.length) {
      try {
        const dRs = await pgPool.query(
          'SELECT order_id, COALESCE(SUM(amount),0) AS total FROM order_internal_deductions WHERE is_active=true AND order_id = ANY($1) GROUP BY order_id',
          [ids]
        )
        const arr = (dRs?.rows || []) as any[]
        arr.forEach((r) => { totals[String(r.order_id)] = Number(r.total || 0) })
      } catch {}
    }
    const enriched = orders.map((o) => ({ ...o, internal_deduction_total: Number((totals[String(o.id)] || 0).toFixed(2)) }))
    const segments = computeMonthSegmentsForOrders(enriched, m.monthKey)
    const byProp: Record<string, any[]> = {}
    for (const s of segments) {
      const pid = String((s as any).property_id || '').trim()
      if (!pid) continue
      if (!byProp[pid]) byProp[pid] = []
      byProp[pid].push(s)
    }
    const rows = Object.entries(byProp).map(([property_id, segs]) => ({
      property_id,
      rent_income: sumSegmentsVisibleNetIncome(segs),
    }))
    return res.json({ month: m.monthKey, rows })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'rent-income-by-property failed' })
  }
})

// Auto-calc management fee for a property and month, persist into property_expenses and finance_transactions
router.post('/management-fee/calc', requireAnyPerm(['property_expenses.write','finance.tx.write']), async (req, res) => {
  try {
    const { property_id, property_code, month } = (req.body || {}) as any
    if (!month || (!(property_id) && !(property_code))) return res.status(400).json({ message: 'missing month or property' })
    if (!hasPg) return res.status(400).json({ message: 'pg required' })
    const ym = String(month)
    const y = Number(ym.slice(0,4)), m = Number(ym.slice(5,7))
    if (!y || !m) return res.status(400).json({ message: 'invalid month format' })
    const start = new Date(Date.UTC(y, m - 1, 1))
    const end = new Date(Date.UTC(y, m, 0))
    let pid = String(property_id || '')
    let pcode = String(property_code || '')
    const { pgPool } = require('../dbAdapter')
    // resolve property id by code
    if (!pid && pcode) {
      const qr = await pgPool!.query('SELECT id, landlord_id FROM properties WHERE lower(code)=lower($1) LIMIT 1', [pcode])
      pid = qr.rows?.[0]?.id || ''
    }
    if (!pid) return res.status(404).json({ message: 'property_not_found' })
    // compute rent income for target month
    const orders = await pgSelect('orders', '*', { property_id: pid })
    const ords: any[] = Array.isArray(orders) ? orders : []
    function toDate(s: any): Date | null { try { return s ? new Date(String(s)) : null } catch { return null } }
    function overlapNights(ci?: any, co?: any): number {
      const a = toDate(ci), b = toDate(co)
      if (!a || !b) return 0
      const A = a > start ? a : start
      const B = b < end ? b : end
      const ms = B.getTime() - A.getTime()
      return ms > 0 ? Math.floor(ms / (24 * 3600 * 1000)) : 0
    }
    let rentIncome = 0
    for (const o of ords) {
      const ov = overlapNights(o.checkin, o.checkout)
      const nights = Number(o.nights || 0) || 0
      const visNet = Number((o as any).visible_net_income ?? o.net_income ?? 0)
      const status = String((o as any).status || '').toLowerCase()
      const isCanceled = status.includes('cancel')
      const include = (!isCanceled) || !!(o as any).count_in_income
      if (include && ov > 0 && nights > 0) rentIncome += (visNet * ov) / nights
    }
    // read landlord rate
    const propRows = await pgSelect('properties', 'id,landlord_id,code', { id: pid })
    const prop = Array.isArray(propRows) ? propRows[0] : null
    const lid = prop?.landlord_id
    if (!lid) return res.status(400).json({ message: 'landlord_not_linked' })
    await ensureManagementFeeRulesTable()
    const resolved = await resolveManagementFeeRateForMonth(String(lid), ym)
    const rate = Number((resolved as any)?.rate || 0)
    if (!(resolved as any)?.rule) return res.status(400).json({ message: 'management_fee_rule_missing' })
    if (!rate) return res.status(400).json({ message: 'management_fee_rate_missing' })
    if (!rentIncome) return res.status(400).json({ message: 'rent_income_zero' })
    const fee = Number(((rentIncome * rate)).toFixed(2))
    // upsert property_expenses
    const { v4: uuid } = require('uuid')
    const occurred = new Date(Date.UTC(y, m - 1, 1)).toISOString().slice(0,10)
    const existing = await pgSelect('property_expenses', '*', { property_id: pid, month_key: ym, category: 'management_fee' })
    let expRow: any
    if (Array.isArray(existing) && existing[0]) {
      const id = existing[0].id
      expRow = await pgUpdate('property_expenses', id, { amount: fee, occurred_at: occurred, note: `auto management fee ${ym}` } as any)
    } else {
      expRow = await pgInsert('property_expenses', { id: uuid(), property_id: pid, amount: fee, category: 'management_fee', occurred_at: occurred, month_key: ym, note: `auto management fee ${ym}` } as any)
    }
    // write finance transaction for integration
    const tx: FinanceTransaction = { id: uuid(), kind: 'expense', amount: fee, currency: 'AUD', occurred_at: new Date().toISOString(), ref_type: 'property_expense', ref_id: expRow?.id || (existing?.[0]?.id || null), property_id: pid, category: 'management_fee', note: `management fee ${prop?.code || pid} ${ym}` }
    await pgInsert('finance_transactions', tx as any)
    addAudit('FinanceTransaction', tx.id, 'create', null, tx)
    // return with double-check snapshot
    const recorded = await pgSelect('property_expenses', '*', { property_id: pid, month_key: ym, category: 'management_fee' })
    const diff = Math.abs(Number((recorded?.[0]?.amount || 0)) - fee)
    return res.status(201).json({ property_id: pid, month: ym, rent_income: Number(rentIncome.toFixed(2)), rate, fee, recorded_fee: Number((recorded?.[0]?.amount || 0)), diff })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'calc_failed' })
  }
})

router.get('/management-fee/history', requireAnyPerm(['property_expenses.view','finance.tx.write']), async (req, res) => {
  try {
    if (!hasPg) return res.status(400).json({ message: 'pg required' })
    const { property_id, month_from, month_to } = (req.query || {}) as any
    const conds: any[] = []
    const where: string[] = ["category = 'management_fee'"]
    if (property_id) { where.push('property_id = $1'); conds.push(property_id) }
    if (month_from && month_to) { where.push('month_key BETWEEN $2 AND $3'); conds.push(month_from, month_to) }
    const { pgPool } = require('../dbAdapter')
    const rs = await pgPool!.query(`SELECT * FROM property_expenses WHERE ${where.join(' AND ')} ORDER BY month_key DESC`, conds)
    return res.json(rs.rows || [])
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'history_failed' })
  }
})

// Validation endpoint: compare raw expenses aggregation for a property and month
router.get('/property-revenue/validate', async (req, res) => {
  try {
    const { property_id, property_code, month } = (req.query || {}) as any
    if (!month || (!(property_id) && !(property_code))) return res.status(400).json({ message: 'missing month or property' })
    const ym = String(month)
    let pid = String(property_id || '')
    let pcode = String(property_code || '')
    if (hasPg) {
      try {
        const { pgPool } = require('../dbAdapter')
        if (pgPool) {
          if (!pid && pcode) {
            const qr = await pgPool.query('SELECT id,code FROM properties WHERE lower(code) = lower($1) LIMIT 1', [pcode])
            if (qr.rows && qr.rows[0]) pid = qr.rows[0].id
          }
        }
      } catch {}
    }
    const totals: Record<string, number> = { parking_fee: 0, electricity: 0, water: 0, gas: 0, internet: 0, consumables: 0, body_corp: 0, council: 0, other: 0 }
    if (hasPg) {
      try {
        const { pgPool } = require('../dbAdapter')
        if (pgPool) {
          const sql = `SELECT * FROM property_expenses
            WHERE (property_id = $1 OR lower(property_id) = lower($2))
              AND (
                month_key = $3 OR
                date_trunc('month', COALESCE(paid_date, occurred_at)::date) = date_trunc('month', to_date($3,'YYYY-MM'))
              )`
          const rs = await pgPool.query(sql, [pid || null, pcode || null, ym])
          const rows = rs.rows || []
          for (const e of rows) {
            const fid = String((e as any).fixed_expense_id || '')
            const amt = Number((e as any).amount || 0)
            let cat = 'other'
            if (fid) {
              try {
                const rp = await pgSelect('recurring_payments', '*', { id: fid })
                const r = Array.isArray(rp) ? rp[0] : null
                cat = String((r as any)?.report_category || 'other')
              } catch {}
            } else {
              cat = toReportCat(String((e as any).category || ''), String((e as any).category_detail || ''))
            }
            if (totals[cat] === undefined) totals[cat] = 0
            totals[cat] += amt
          }
        }
      } catch (e: any) {
        return res.status(500).json({ message: e?.message || 'validate failed' })
      }
    }
    return res.json({ property_id: pid, property_code: pcode, month: ym, totals })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'validate failed' })
  }
})

router.get('/payouts', async (_req, res) => {
  try {
    
    if (hasPg) {
      const raw = await pgSelect('payouts')
      const rows: any[] = Array.isArray(raw) ? raw : []
      return res.json(rows)
    }
    return res.json(db.payouts)
  } catch {
    return res.json(db.payouts)
  }
})

// Company payouts
router.get('/company-payouts', async (_req, res) => {
  try {
    if (hasPg) {
      const raw = await pgSelect('company_payouts')
      const rows: any[] = Array.isArray(raw) ? raw : []
      return res.json(rows)
    }
    return res.json(db.companyPayouts)
  } catch {
    return res.json(db.companyPayouts)
  }
})

const companyPayoutSchema = z.object({ period_from: z.string(), period_to: z.string(), amount: z.number().min(0), invoice_no: z.string().optional(), note: z.string().optional() })
router.post('/company-payouts', requirePerm('finance.payout'), async (req, res) => {
  const parsed = companyPayoutSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const { v4: uuid } = require('uuid')
  const p: CompanyPayout = { id: uuid(), status: 'pending', ...parsed.data }
  db.companyPayouts.push(p)
  addAudit('CompanyPayout', p.id, 'create', null, p)
  const tx: FinanceTransaction = { id: uuid(), kind: 'expense', amount: p.amount, currency: 'AUD', occurred_at: new Date().toISOString(), ref_type: 'company_payout', ref_id: p.id, note: p.note || 'company payout', invoice_url: undefined }
  db.financeTransactions.push(tx)
  addAudit('FinanceTransaction', tx.id, 'create', null, tx)
  if (hasPg) {
    try {
      await pgInsert('company_payouts', p as any)
      await pgInsert('finance_transactions', tx as any)
      return res.status(201).json(p)
    } catch (e: any) { return res.status(500).json({ message: e?.message || 'pg insert failed' }) }
  }
  return res.status(201).json(p)
})

router.patch('/company-payouts/:id', requirePerm('finance.payout'), async (req, res) => {
  const { id } = req.params
  const idx = db.companyPayouts.findIndex(x => x.id === id)
  const prev = idx !== -1 ? db.companyPayouts[idx] : undefined
  if (!prev && !hasPg) return res.status(404).json({ message: 'not found' })
  const body = req.body as Partial<CompanyPayout>
  const updated: CompanyPayout = { ...(prev || ({} as any)), ...body, id }
  if (idx !== -1) db.companyPayouts[idx] = updated
  addAudit('CompanyPayout', id, 'update', prev, updated)
  // sync linked transaction amount/note if provided
  const linkedIdx = db.financeTransactions.findIndex(t => t.ref_type === 'company_payout' && t.ref_id === id)
  if (linkedIdx !== -1) {
    if (body.amount != null) db.financeTransactions[linkedIdx].amount = Number(body.amount)
    if (body.note != null) db.financeTransactions[linkedIdx].note = body.note
  }
  if (hasPg) {
    try { const row = await pgUpdate('company_payouts', id, updated as any); return res.json(row || updated) } catch {
      try { const row2 = await pgInsert('company_payouts', updated as any); return res.json(row2 || updated) } catch {}
    }
  }
  return res.json(updated)
})

router.delete('/company-payouts/:id', requirePerm('finance.payout'), async (req, res) => {
  const { id } = req.params
  const idx = db.companyPayouts.findIndex(x => x.id === id)
  if (idx !== -1) db.companyPayouts.splice(idx, 1)
  db.financeTransactions = db.financeTransactions.filter(t => !(t.ref_type === 'company_payout' && t.ref_id === id))
  if (hasPg) {
    try {
      await pgDelete('company_payouts', id)
      const linked = await pgSelect('finance_transactions', '*', { ref_type: 'company_payout', ref_id: id })
      for (const r of (linked || []) as any[]) { if (r?.id) await pgDelete('finance_transactions', r.id) }
      return res.json({ ok: true })
    } catch {}
  }
  return res.json({ ok: true })
})

const payoutSchema = z.object({ landlord_id: z.string(), period_from: z.string(), period_to: z.string(), amount: z.number().min(0), invoice_no: z.string().optional() })
router.post('/payouts', requirePerm('finance.payout'), async (req, res) => {
  const parsed = payoutSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const { v4: uuid } = require('uuid')
  const p: Payout = { id: uuid(), status: 'pending', ...parsed.data }
  db.payouts.push(p)
  addAudit('Payout', p.id, 'create', null, p)
  const tx: FinanceTransaction = { id: uuid(), kind: 'expense', amount: p.amount, currency: 'AUD', occurred_at: new Date().toISOString(), ref_type: 'payout', ref_id: p.id, note: `landlord payout ${p.landlord_id}` }
  db.financeTransactions.push(tx)
  addAudit('FinanceTransaction', tx.id, 'create', null, tx)
  // Supabase branch removed
  if (hasPg) {
    try {
      await pgInsert('payouts', p as any)
      await pgInsert('finance_transactions', tx as any)
      return res.status(201).json(p)
    } catch (e: any) { return res.status(500).json({ message: e?.message || 'pg insert failed' }) }
  }
  return res.status(201).json(p)
})

router.patch('/payouts/:id', requirePerm('finance.payout'), async (req, res) => {
  const p = db.payouts.find(x => x.id === req.params.id)
  if (!p) return res.status(404).json({ message: 'not found' })
  const before = { ...p }
  Object.assign(p, req.body as Partial<Payout>)
  addAudit('Payout', p.id, 'update', before, p)
  if (hasPg) {
    try { const row = await pgUpdate('payouts', p.id, p as any); return res.json(row || p) } catch {}
  }
  return res.json(p)
})

router.get('/payouts/:id', async (req, res) => {
  const { id } = req.params
  try {
    if (hasPg) {
      const rows = await pgSelect('payouts', '*', { id })
      if (rows && rows[0]) return res.json(rows[0])
    }
  } catch {}
  const local = db.payouts.find(x => x.id === id)
  if (!local) return res.status(404).json({ message: 'not found' })
  return res.json(local)
})

router.delete('/payouts/:id', requirePerm('finance.payout'), async (req, res) => {
  const { id } = req.params
  const idx = db.payouts.findIndex(x => x.id === id)
  if (idx !== -1) db.payouts.splice(idx, 1)
  db.financeTransactions = db.financeTransactions.filter(t => !(t.ref_type === 'payout' && t.ref_id === id))
  if (hasPg) {
    try {
      await pgDelete('payouts', id)
      const linked = await pgSelect('finance_transactions', '*', { ref_type: 'payout', ref_id: id })
      for (const r of (linked || []) as any[]) { if (r?.id) await pgDelete('finance_transactions', r.id) }
      return res.json({ ok: true })
    } catch {}
  }
  return res.json({ ok: true })
})

router.patch('/:id', requirePerm('finance.tx.write'), async (req, res) => {
  const { id } = req.params
  const parsed = txSchema.partial().safeParse(req.body)
  if (!parsed.success) {
    const msg = parsed.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; ')
    return res.status(400).json({ message: msg || 'invalid payload' })
  }
  const idx = db.financeTransactions.findIndex(x => x.id === id)
  const prev = idx !== -1 ? db.financeTransactions[idx] : undefined
  const updated: FinanceTransaction = { ...(prev || ({} as any)), ...(parsed.data as any), id }
  if (idx !== -1) db.financeTransactions[idx] = updated
  else db.financeTransactions.push(updated)
  if (hasPg) {
    try { const row = await pgUpdate('finance_transactions', id, updated as any); return res.json(row || updated) } catch {
      try { await pgInsert('finance_transactions', updated as any); return res.json(updated) } catch {}
    }
  }
  return res.json(updated)
})

router.delete('/:id', requirePerm('finance.tx.write'), async (req, res) => {
  const { id } = req.params
  const idx = db.financeTransactions.findIndex(x => x.id === id)
  if (idx !== -1) db.financeTransactions.splice(idx, 1)
  if (hasPg) {
    try { await pgDelete('finance_transactions', id); return res.json({ ok: true }) } catch {}
  }
  return res.json({ ok: true })
})
// Deduplicate property_expenses by (property_id, month_key, category, amount)
router.post('/dedup-property-expenses', requireAnyPerm(['property_expenses.write','finance.tx.write']), async (_req, res) => {
  try {
    if (!hasPg) return res.status(400).json({ message: 'pg required' })
    const { pgPool } = require('../dbAdapter')
    if (!pgPool) return res.status(500).json({ message: 'pg pool unavailable' })
    const dupSql = `
      SELECT property_id, month_key, category, amount, array_agg(id ORDER BY coalesce(updated_at, created_at, now()) DESC) AS ids
      FROM property_expenses
      WHERE month_key IS NOT NULL
      GROUP BY property_id, month_key, category, amount
      HAVING COUNT(*) > 1
    `
    const qr = await pgPool.query(dupSql)
    const groups = qr.rows || []
    let merged = 0, removed = 0, marked = 0
    for (const g of groups) {
      const ids: string[] = g.ids || []
      if (!ids.length) continue
      const keep = ids[0]
      const drop = ids.slice(1)
      if (drop.length) {
        await pgPool.query('DELETE FROM property_expenses WHERE id = ANY($1::text[])', [drop])
        removed += drop.length
      }
      merged++
    }
    return res.json({ merged_groups: merged, removed_records: removed, marked_conflicts: marked })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'dedup failed' })
  }
})

router.post('/expenses/validate-duplicate', requireAnyPerm(['property_expenses.write','finance.tx.write']), async (req, res) => {
  try {
    const body = req.body || {}
    const mode = String(body.mode || 'exact') === 'fuzzy' ? 'fuzzy' : 'exact'
    const fp = buildExpenseFingerprint(body, mode as any)
    const started = Date.now()
    const result: any = { verification_id: fp, is_duplicate: false, reasons: [], similar: [] }
    if (await hasFingerprint(fp)) { result.is_duplicate = true; result.reasons.push('fingerprint_recent'); }
    if (hasPg) {
      const occ = String(body.paid_date || body.occurred_at || '')
      const whereExact = { property_id: body.property_id, month_key: (occ ? occ.slice(0,7) : body.month_key), category: body.category, amount: Number(body.amount||0) }
      const ex = await pgSelect('property_expenses', '*', whereExact)
      if (Array.isArray(ex) && ex[0]) { result.is_duplicate = true; result.reasons.push('unique_match'); result.similar.push(ex[0]) }
      try {
        const { pgPool } = require('../dbAdapter')
        const sql = `SELECT * FROM property_expenses WHERE property_id=$1 AND category=$2 AND abs(amount - $3) <= 1 AND occurred_at BETWEEN (to_date($4,'YYYY-MM-DD') - interval '1 day') AND (to_date($4,'YYYY-MM-DD') + interval '1 day') LIMIT 10`
        const rs = await pgPool!.query(sql, [body.property_id, body.category, Number(body.amount||0), occ.slice(0,10)])
        if (rs.rowCount) { result.is_duplicate = true; result.reasons.push('fuzzy_window'); result.similar.push(...rs.rows) }
      } catch {}
    }
    await addDedupLog({ resource: 'property_expenses', fingerprint: fp, mode: mode as any, result: result.is_duplicate ? 'hit' : 'miss', operator_id: (req as any).user?.sub || null, reasons: result.reasons, latency_ms: Date.now() - started })
    return res.json(result)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'validate_failed' })
  }
})

router.post('/expenses/scan-duplicates', requireAnyPerm(['property_expenses.write','finance.tx.write']), async (_req, res) => {
  try {
    if (!hasPg) return res.status(400).json({ message: 'pg required' })
    const { pgPool } = require('../dbAdapter')
    const sql = `SELECT property_id, month_key, category, amount, COUNT(*) AS cnt FROM property_expenses WHERE month_key IS NOT NULL GROUP BY property_id, month_key, category, amount HAVING COUNT(*) > 1 ORDER BY cnt DESC LIMIT 100`
    const rs = await pgPool!.query(sql)
    const groups = rs.rows || []
    return res.json({ groups })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'scan_failed' })
  }
})

router.get('/duplicates/metrics', requireAnyPerm(['property_expenses.view','finance.tx.write']), async (_req, res) => {
  try {
    if (!hasPg) return res.json({ duplicate_rate_24h: 0, hits_24h: 0, validations_24h: 0 })
    const { pgPool } = require('../dbAdapter')
    const rs = await pgPool!.query(`SELECT count(*) FILTER (WHERE result='hit') AS hits, count(*) AS total FROM expense_dedup_logs WHERE created_at > now() - interval '24 hours'`)
    const hits = Number(rs.rows?.[0]?.hits || 0)
    const total = Number(rs.rows?.[0]?.total || 0)
    const rate = total ? Number(((hits / total) * 100).toFixed(2)) : 0
    return res.json({ duplicate_rate_24h: rate, hits_24h: hits, validations_24h: total })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'metrics_failed' })
  }
})
