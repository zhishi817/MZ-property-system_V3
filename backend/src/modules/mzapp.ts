import { Router } from 'express'
import { z } from 'zod'
import { hasPg, pgPool, pgRunInTransaction } from '../dbAdapter'
import multer from 'multer'
import path from 'path'
import { hasR2, r2Upload } from '../r2'
import crypto from 'crypto'
import sharp from 'sharp'
import fs from 'fs'
import { listPermissionCodesForUser, userHasAnyPerm } from '../auth'
import { buildCleaningTaskVisibilityHints, buildWorkTaskVisibilityHints, emitWorkTaskEvent } from '../services/workTaskEvents'
import { emitNotificationEvent } from '../services/notificationEvents'
import {
  canEditGuestLuggageForRoles,
  planGuestLuggageMutation,
  resolveGuestLuggageRecipientIds,
} from '../services/guestLuggage'
import { deferredProjectionDate, effectiveInspectionMode, isInspectionFinishedStatus, mergeInspectionPlan, mobileInspectionProjectionDate } from '../lib/cleaningInspection'
import { deepCleaningSourceSummary, maintenanceSourceSummary } from '../lib/autoExpenseSourceSummary'
import { resolvePropertyPublicGuideLinks } from './property_guide_link_sync'

export const router = Router()

const REQUIRED_COMPLETION_PHOTO_AREAS = ['toilet', 'living', 'sofa', 'bedroom', 'kitchen'] as const

const upload = hasR2 ? multer({ storage: multer.memoryStorage() }) : multer({ dest: path.join(process.cwd(), 'uploads') })
const PHOTO_ID_WATERMARK_TEXT = '仅用于MZ Property（ABN：42 657 925 365）记录,不做任何其他用途。\nFor the records of MZ Property (ABN: 42 657 925 365) only, not for other purpose.'

function dayOnly(v: any): string | null {
  const s = String(v ?? '').slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null
}

function normStatus(v: any): string {
  const s = String(v ?? '').trim().toLowerCase()
  if (s === 'done' || s === 'completed') return 'done'
  if (s === 'cancelled' || s === 'canceled') return 'cancelled'
  if (s === 'in_progress') return 'in_progress'
  if (s === 'assigned') return 'assigned'
  return 'todo'
}

function normUrgency(v: any): string {
  const s = String(v ?? '').trim().toLowerCase()
  if (s === 'low' || s === 'medium' || s === 'high' || s === 'urgent') return s
  return 'medium'
}

function normalizeWorkTaskPhotoUrls(input: any) {
  const values = Array.isArray(input) ? input : []
  return Array.from(new Set(values.map((item) => String(item || '').trim()).filter(Boolean)))
}

function workTaskCompletedTitle(title: any) {
  const base = String(title || '').trim()
  return base ? `任务已完成：${base}` : '任务已完成'
}

function workTaskCompletedBody(title: any) {
  const base = String(title || '').trim()
  return base ? `${base} 已标记完成` : '任务已标记完成'
}

function isWorkTaskDoneStatus(status: any) {
  const value = String(status || '').trim().toLowerCase()
  return value === 'done' || value === 'completed' || value === 'ready'
}

function workTaskSortNumber(raw: any) {
  if (raw == null) return null
  const n = Number(raw)
  return Number.isFinite(n) ? Math.trunc(n) : null
}

function randomBase62(len = 4) {
  const chars = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
  let out = ''
  for (let i = 0; i < len; i++) {
    out += chars[crypto.randomInt(0, chars.length)]
  }
  return out
}

function makeWorkNo(prefix: string, occurredAt?: string) {
  const day = String(occurredAt || '').slice(0, 10)
  const ymd = /^\d{4}-\d{2}-\d{2}$/.test(day)
    ? day.replace(/-/g, '')
    : (() => {
        const d = new Date()
        const pad2 = (n: number) => String(n).padStart(2, '0')
        return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`
      })()
  return `${String(prefix || 'R').trim()}-${ymd}-${randomBase62(4)}`
}

function roleNamesOf(user: any) {
  const arr = Array.isArray(user?.roles) ? (user.roles as any[]) : []
  const ids = arr.map((x) => String(x || '').trim()).filter(Boolean)
  const primary = String(user?.role || '').trim()
  if (primary) ids.unshift(primary)
  return Array.from(new Set(ids))
}

function hasRole(user: any, roleName: string) {
  const rn = String(roleName || '').trim()
  if (!rn) return false
  return roleNamesOf(user).includes(rn)
}

function canViewAll(user: any) {
  return hasRole(user, 'admin') || hasRole(user, 'offline_manager') || hasRole(user, 'customer_service')
}

const PROPERTY_FOLLOWUP_SOURCE_TYPES = ['property_maintenance', 'property_deep_cleaning', 'property_daily_necessities'] as const

async function canViewAllWorkTasks(user: any) {
  return canViewAll(user) || await userHasAnyPerm(user, ['cleaning_app.calendar.view.all'])
}

function normalizeStoredPhotoUrls(raw: any, fallback?: any) {
  if (Array.isArray(raw)) return Array.from(new Set(raw.map((item) => String(item || '').trim()).filter(Boolean)))
  const text = String(raw || '').trim()
  if (text) {
    try {
      const parsed = JSON.parse(text)
      if (Array.isArray(parsed)) return Array.from(new Set(parsed.map((item) => String(item || '').trim()).filter(Boolean)))
    } catch {}
    if (/^https?:\/\//i.test(text)) return [text]
  }
  const fallbackText = String(fallback || '').trim()
  return fallbackText ? [fallbackText] : []
}

type MzappExpenseScope = 'company' | 'property'

const MZAPP_PROPERTY_REGION_ORDER = ['Melbourne', 'Southbank', 'South Melbourne', 'West Melbourne', 'St Kilda', 'Docklands']
const COMPANY_EXPENSE_CATEGORIES = [
  { value: 'office', label: '办公' },
  { value: 'bedding_fee', label: '床品费' },
  { value: 'office_rent', label: '办公室租金' },
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
const PROPERTY_EXPENSE_CATEGORIES = [
  { value: 'electricity', label: '电费' },
  { value: 'water', label: '水费' },
  { value: 'gas_hot_water', label: '煤气/热水费' },
  { value: 'internet', label: '网费' },
  { value: 'consumables', label: '消耗品费' },
  { value: 'carpark', label: '车位费' },
  { value: 'owners_corp', label: '物业费' },
  { value: 'council_rate', label: '市政费' },
  { value: 'parking_fee', label: '停车费' },
  { value: 'other', label: '其他' },
]

const mzappExpenseCreateSchema = z.object({
  scope: z.enum(['company', 'property']),
  property_id: z.string().optional(),
  occurred_at: z.string(),
  amount: z.coerce.number().positive(),
  category: z.string().min(1),
  category_detail: z.string().optional(),
  expense_name: z.string().optional(),
  note: z.string().optional(),
  receipt_urls: z.array(z.string().min(1)).max(5).optional(),
})

const mzappExpenseUpdateSchema = mzappExpenseCreateSchema.partial().extend({
  scope: z.enum(['company', 'property']),
})

const mzappExpenseOcrSchema = z.object({
  scope: z.enum(['company', 'property']),
  receipt_url: z.string().min(1),
})

const mzappExpenseReceiptItemSchema = z.object({
  id: z.string().optional(),
  scope: z.enum(['company', 'property']),
  property_id: z.string().optional(),
  expense_name: z.string().min(1),
  amount: z.coerce.number().positive(),
  category: z.string().min(1),
  category_detail: z.string().optional(),
  note: z.string().optional(),
})

const mzappExpenseReceiptCreateSchema = z.object({
  receipt_total_amount: z.coerce.number().positive(),
  receipt_date: z.string(),
  note: z.string().optional(),
  receipt_urls: z.array(z.string().min(1)).min(1).max(5),
  items: z.array(mzappExpenseReceiptItemSchema).min(1).max(50),
})

const mzappExpenseReceiptUpdateSchema = mzappExpenseReceiptCreateSchema

function mzappExpensePermission(scope: MzappExpenseScope, action: 'submit' | 'view.self' | 'edit.self' | 'delete.self') {
  return `cleaning_app.expense.${scope}.${action}`
}

function cmpPropertyCode(a?: string, b?: string) {
  const A = String(a || '').trim().toUpperCase()
  const B = String(b || '').trim().toUpperCase()
  if (!A && !B) return 0
  if (!A) return 1
  if (!B) return -1
  const isDigitA = /\d/.test(A[0] || '')
  const isDigitB = /\d/.test(B[0] || '')
  if (isDigitA !== isDigitB) return isDigitA ? -1 : 1
  const tok = (s: string) => s.match(/\d+|[A-Z]+|[^A-Z0-9]+/g) || []
  const ta = tok(A)
  const tb = tok(B)
  const n = Math.min(ta.length, tb.length)
  for (let i = 0; i < n; i++) {
    const xa = ta[i]
    const xb = tb[i]
    const da = /^\d+$/.test(xa)
    const db = /^\d+$/.test(xb)
    if (da && db) {
      const va = Number(xa)
      const vb = Number(xb)
      if (va !== vb) return va - vb
    } else {
      const c = xa.localeCompare(xb)
      if (c !== 0) return c
    }
  }
  if (ta.length !== tb.length) return ta.length - tb.length
  return A.localeCompare(B)
}

function propertyRegionRank(region0?: string | null) {
  const region = String(region0 || '').trim()
  const idx = MZAPP_PROPERTY_REGION_ORDER.indexOf(region)
  return idx >= 0 ? idx : MZAPP_PROPERTY_REGION_ORDER.length + 1
}

function sortActivePropertiesByRegionThenCode<T extends { code?: string; region?: string | null; archived?: boolean | null }>(rows: T[]) {
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => row?.archived !== true)
    .slice()
    .sort((a, b) => {
      const ra = propertyRegionRank(a?.region)
      const rb = propertyRegionRank(b?.region)
      if (ra !== rb) return ra - rb
      return cmpPropertyCode(a?.code, b?.code)
    })
}

function normalizeExpenseReceiptUrls(input: any) {
  return Array.from(new Set((Array.isArray(input) ? input : []).map((item) => String(item || '').trim()).filter(Boolean))).slice(0, 5)
}

async function ensureMzappExpenseSchema() {
  if (!hasPg || !pgPool) return
  if ((ensureMzappExpenseSchema as any)._promise) return await (ensureMzappExpenseSchema as any)._promise
  ;(ensureMzappExpenseSchema as any)._promise = (async () => {
  await pgPool.query(`CREATE TABLE IF NOT EXISTS company_expenses (
    id text PRIMARY KEY,
    occurred_at date NOT NULL,
    amount numeric NOT NULL,
    currency text NOT NULL DEFAULT 'AUD',
    category text,
    category_detail text,
    expense_name text,
    note text,
    invoice_url text,
    created_at timestamptz DEFAULT now(),
    created_by text,
    deleted_at timestamptz,
    deleted_by text,
    delete_source text,
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
  await pgPool.query(`CREATE TABLE IF NOT EXISTS property_expenses (
    id text PRIMARY KEY,
    property_id text,
    occurred_at date NOT NULL,
    amount numeric NOT NULL,
    currency text NOT NULL DEFAULT 'AUD',
    category text,
    category_detail text,
    expense_name text,
    note text,
    invoice_url text,
    created_at timestamptz DEFAULT now(),
    created_by text,
    deleted_at timestamptz,
    deleted_by text,
    delete_source text,
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
  await pgPool.query('ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS category_detail text;')
  await pgPool.query('ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS expense_name text;')
  await pgPool.query('ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS invoice_url text;')
  await pgPool.query('ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS created_by text;')
  await pgPool.query('ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS deleted_at timestamptz;')
  await pgPool.query('ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS deleted_by text;')
  await pgPool.query('ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS delete_source text;')
  await pgPool.query('ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS generated_from text;')
  await pgPool.query('ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS receipt_id text;')
  await pgPool.query('ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS receipt_item_id text;')
  await pgPool.query('ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS category_detail text;')
  await pgPool.query('ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS expense_name text;')
  await pgPool.query('ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS invoice_url text;')
  await pgPool.query('ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS created_by text;')
  await pgPool.query('ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS deleted_at timestamptz;')
  await pgPool.query('ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS deleted_by text;')
  await pgPool.query('ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS delete_source text;')
  await pgPool.query('ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS generated_from text;')
  await pgPool.query('ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS receipt_id text;')
  await pgPool.query('ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS receipt_item_id text;')
  })().catch((e: any) => {
    ;(ensureMzappExpenseSchema as any)._promise = null
    throw e
  })
  return await (ensureMzappExpenseSchema as any)._promise
}

async function ensureMzappExpenseInvoicesTable() {
  if (!hasPg || !pgPool) return
  if ((ensureMzappExpenseInvoicesTable as any)._promise) return await (ensureMzappExpenseInvoicesTable as any)._promise
  ;(ensureMzappExpenseInvoicesTable as any)._promise = (async () => {
  await pgPool.query(`CREATE TABLE IF NOT EXISTS expense_invoices (
    id text PRIMARY KEY,
    expense_id text REFERENCES property_expenses(id) ON DELETE CASCADE,
    company_expense_id text REFERENCES company_expenses(id) ON DELETE CASCADE,
    url text NOT NULL,
    file_name text,
    mime_type text,
    file_size integer,
    created_at timestamptz DEFAULT now(),
    created_by text
  );`)
  await pgPool.query('ALTER TABLE expense_invoices ADD COLUMN IF NOT EXISTS company_expense_id text;')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_expense_invoices_expense ON expense_invoices(expense_id);')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_expense_invoices_company_expense ON expense_invoices(company_expense_id);')
  })().catch((e: any) => {
    ;(ensureMzappExpenseInvoicesTable as any)._promise = null
    throw e
  })
  return await (ensureMzappExpenseInvoicesTable as any)._promise
}

async function listExpenseReceipts(scope: MzappExpenseScope, expenseId: string, db: any = pgPool) {
  if (!hasPg || !db) return []
  await ensureMzappExpenseInvoicesTable()
  const col = scope === 'property' ? 'expense_id' : 'company_expense_id'
  const r = await db.query(
    `SELECT id, expense_id, company_expense_id, url, file_name, mime_type, file_size, created_at, created_by
       FROM expense_invoices
      WHERE ${col} = $1
      ORDER BY created_at ASC NULLS LAST, id ASC`,
    [expenseId],
  )
  return r?.rows || []
}

async function syncExpenseReceipts(scope: MzappExpenseScope, expenseId: string, receiptUrls: string[], user: any, db: any = pgPool) {
  if (!hasPg || !db) return
  await ensureMzappExpenseInvoicesTable()
  const col = scope === 'property' ? 'expense_id' : 'company_expense_id'
  const table = scope === 'property' ? 'property_expenses' : 'company_expenses'
  const normalized = normalizeExpenseReceiptUrls(receiptUrls)
  const currentRows = await listExpenseReceipts(scope, expenseId, db)
  const currentByUrl = new Map<string, any>()
  for (const row of currentRows) currentByUrl.set(String(row?.url || '').trim(), row)
  for (const row of currentRows) {
    const url = String(row?.url || '').trim()
    if (url && !normalized.includes(url)) await db.query('DELETE FROM expense_invoices WHERE id = $1', [String(row.id)])
  }
  for (const url of normalized) {
    if (!currentByUrl.has(url)) {
      await db.query(
        `INSERT INTO expense_invoices (id, ${col}, url, created_by)
         VALUES ($1, $2, $3, $4)`,
        [crypto.randomUUID(), expenseId, url, String(user?.sub || user?.username || 'mzapp')],
      )
    }
  }
  await db.query(
    `UPDATE ${table}
        SET invoice_url = $2
      WHERE id = $1`,
    [expenseId, normalized[0] || null],
  )
}

async function ensureMzappExpenseReceiptSchema() {
  if (!hasPg || !pgPool) return
  if ((ensureMzappExpenseReceiptSchema as any)._promise) return await (ensureMzappExpenseReceiptSchema as any)._promise
  ;(ensureMzappExpenseReceiptSchema as any)._promise = (async () => {
  await ensureMzappExpenseSchema()
  await ensureMzappExpenseInvoicesTable()
  await pgPool.query(`CREATE TABLE IF NOT EXISTS expense_receipts (
    id text PRIMARY KEY,
    receipt_date date NOT NULL,
    receipt_total_amount numeric NOT NULL,
    currency text NOT NULL DEFAULT 'AUD',
    note text,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now(),
    created_by text,
    generated_from text,
    deleted_at timestamptz,
    deleted_by text,
    delete_source text
  );`)
  await pgPool.query(`CREATE TABLE IF NOT EXISTS expense_receipt_images (
    id text PRIMARY KEY,
    receipt_id text NOT NULL REFERENCES expense_receipts(id) ON DELETE CASCADE,
    url text NOT NULL,
    sort_index integer NOT NULL DEFAULT 0,
    created_at timestamptz DEFAULT now(),
    created_by text
  );`)
  await pgPool.query(`CREATE TABLE IF NOT EXISTS expense_receipt_items (
    id text PRIMARY KEY,
    receipt_id text NOT NULL REFERENCES expense_receipts(id) ON DELETE CASCADE,
    line_no integer NOT NULL,
    scope text NOT NULL,
    property_id text,
    expense_name text NOT NULL,
    amount numeric NOT NULL,
    category text NOT NULL,
    category_detail text,
    note text,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
  );`)
  await pgPool.query('ALTER TABLE expense_receipts ADD COLUMN IF NOT EXISTS receipt_date date;')
  await pgPool.query('ALTER TABLE expense_receipts ADD COLUMN IF NOT EXISTS receipt_total_amount numeric;')
  await pgPool.query("ALTER TABLE expense_receipts ALTER COLUMN currency SET DEFAULT 'AUD';")
  await pgPool.query('ALTER TABLE expense_receipts ADD COLUMN IF NOT EXISTS note text;')
  await pgPool.query('ALTER TABLE expense_receipts ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();')
  await pgPool.query('ALTER TABLE expense_receipts ADD COLUMN IF NOT EXISTS created_by text;')
  await pgPool.query('ALTER TABLE expense_receipts ADD COLUMN IF NOT EXISTS generated_from text;')
  await pgPool.query('ALTER TABLE expense_receipts ADD COLUMN IF NOT EXISTS deleted_at timestamptz;')
  await pgPool.query('ALTER TABLE expense_receipts ADD COLUMN IF NOT EXISTS deleted_by text;')
  await pgPool.query('ALTER TABLE expense_receipts ADD COLUMN IF NOT EXISTS delete_source text;')
  await pgPool.query('ALTER TABLE expense_receipt_images ADD COLUMN IF NOT EXISTS sort_index integer NOT NULL DEFAULT 0;')
  await pgPool.query('ALTER TABLE expense_receipt_images ADD COLUMN IF NOT EXISTS created_by text;')
  await pgPool.query('ALTER TABLE expense_receipt_items ADD COLUMN IF NOT EXISTS line_no integer NOT NULL DEFAULT 1;')
  await pgPool.query('ALTER TABLE expense_receipt_items ADD COLUMN IF NOT EXISTS scope text;')
  await pgPool.query('ALTER TABLE expense_receipt_items ADD COLUMN IF NOT EXISTS property_id text;')
  await pgPool.query('ALTER TABLE expense_receipt_items ADD COLUMN IF NOT EXISTS expense_name text;')
  await pgPool.query('ALTER TABLE expense_receipt_items ADD COLUMN IF NOT EXISTS amount numeric;')
  await pgPool.query('ALTER TABLE expense_receipt_items ADD COLUMN IF NOT EXISTS category text;')
  await pgPool.query('ALTER TABLE expense_receipt_items ADD COLUMN IF NOT EXISTS category_detail text;')
  await pgPool.query('ALTER TABLE expense_receipt_items ADD COLUMN IF NOT EXISTS note text;')
  await pgPool.query('ALTER TABLE expense_receipt_items ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_expense_receipt_images_receipt ON expense_receipt_images(receipt_id, sort_index, created_at);')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_expense_receipt_items_receipt ON expense_receipt_items(receipt_id, line_no, created_at);')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_company_expenses_receipt ON company_expenses(receipt_id, receipt_item_id);')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_property_expenses_receipt ON property_expenses(receipt_id, receipt_item_id);')
  })().catch((e: any) => {
    ;(ensureMzappExpenseReceiptSchema as any)._promise = null
    throw e
  })
  return await (ensureMzappExpenseReceiptSchema as any)._promise
}

async function listActivePropertiesForMzapp() {
  if (!hasPg || !pgPool) return []
  const r = await pgPool.query('SELECT id, code, address, region, archived FROM properties')
  return sortActivePropertiesByRegionThenCode((r?.rows || []).map((row: any) => ({
    id: String(row?.id || ''),
    code: String(row?.code || ''),
    address: String(row?.address || ''),
    region: row?.region == null ? null : String(row.region || ''),
    archived: row?.archived === true,
  })))
}

async function mzappPropertyExists(propertyId: string) {
  const id = String(propertyId || '').trim()
  if (!id || !hasPg || !pgPool) return false
  const r = await pgPool.query(
    `SELECT 1
       FROM properties
      WHERE id = $1
        AND COALESCE(archived, false) = false
      LIMIT 1`,
    [id],
  )
  return !!r.rowCount
}

async function mzappUserHasScopePerm(user: any, scope: MzappExpenseScope, action: 'submit' | 'view.self' | 'edit.self' | 'delete.self') {
  return await userHasAnyPerm(user, [mzappExpensePermission(scope, action)])
}

async function listMzappScopesForUser(user: any) {
  const scopes: MzappExpenseScope[] = []
  if (await userHasAnyPerm(user, [
    mzappExpensePermission('company', 'submit'),
    mzappExpensePermission('company', 'view.self'),
    mzappExpensePermission('company', 'edit.self'),
    mzappExpensePermission('company', 'delete.self'),
  ])) scopes.push('company')
  if (await userHasAnyPerm(user, [
    mzappExpensePermission('property', 'submit'),
    mzappExpensePermission('property', 'view.self'),
    mzappExpensePermission('property', 'edit.self'),
    mzappExpensePermission('property', 'delete.self'),
  ])) scopes.push('property')
  return scopes
}

function mzappActorId(user: any) {
  return String(user?.sub || user?.username || 'mzapp')
}

function roundMoney(value: any) {
  return Number(Number(value || 0).toFixed(2))
}

function moneyToCents(value: any) {
  return Math.round(Number(value || 0) * 100)
}

function expenseCategoriesForScope(scope: MzappExpenseScope) {
  return scope === 'company' ? COMPANY_EXPENSE_CATEGORIES : PROPERTY_EXPENSE_CATEGORIES
}

function normalizeReceiptItems(input: any) {
  const items = Array.isArray(input) ? input : []
  return items.map((item, index) => ({
    id: String(item?.id || '').trim() || undefined,
    line_no: index + 1,
    scope: String(item?.scope || '').trim() === 'property' ? 'property' : 'company',
    property_id: String(item?.property_id || '').trim() || undefined,
    expense_name: String(item?.expense_name || '').trim(),
    amount: roundMoney(item?.amount || 0),
    category: String(item?.category || '').trim(),
    category_detail: String(item?.category_detail || '').trim() || undefined,
    note: String(item?.note || '').trim() || undefined,
  }))
}

async function assertValidReceiptPayload(user: any, payload: any, action: 'submit' | 'edit.self') {
  const receiptDate = dayOnly(payload?.receipt_date)
  if (!receiptDate) throw new Error('invalid receipt_date')
  const receiptUrls = normalizeExpenseReceiptUrls(payload?.receipt_urls)
  if (!receiptUrls.length) throw new Error('missing receipt_urls')
  const items = normalizeReceiptItems(payload?.items)
  if (!items.length) throw new Error('missing items')
  const receiptTotalAmount = roundMoney(payload?.receipt_total_amount || 0)
  if (!(receiptTotalAmount > 0)) throw new Error('invalid receipt_total_amount')
  const totalCents = items.reduce((sum, item) => sum + moneyToCents(item.amount), 0)
  if (moneyToCents(receiptTotalAmount) !== totalCents) throw new Error('items_total_mismatch')
  const scopes = Array.from(new Set(items.map((item) => item.scope as MzappExpenseScope)))
  for (const scope of scopes) {
    if (!(await mzappUserHasScopePerm(user, scope, action))) throw new Error('forbidden')
  }
  for (const item of items) {
    if (!item.expense_name) throw new Error('missing expense_name')
    if (!(item.amount > 0)) throw new Error('invalid item amount')
    if (item.scope === 'property') {
      if (!item.property_id) throw new Error('missing property_id')
      if (!(await mzappPropertyExists(item.property_id))) throw new Error('invalid property_id')
    } else if (item.property_id) {
      throw new Error('property_id_not_allowed')
    }
    const allowedCategories = new Set(expenseCategoriesForScope(item.scope as MzappExpenseScope).map((entry) => entry.value))
    if (!allowedCategories.has(item.category)) throw new Error('invalid category')
    if (item.category === 'other' && !String(item.category_detail || '').trim()) throw new Error('missing category_detail')
  }
  return {
    receipt_total_amount: receiptTotalAmount,
    receipt_date: receiptDate,
    note: String(payload?.note || '').trim() || null,
    receipt_urls: receiptUrls,
    items,
  }
}

function buildReceiptScopeSummary(items: Array<{ scope?: string | null }>) {
  const scopes = Array.from(new Set((Array.isArray(items) ? items : []).map((item) => String(item?.scope || '').trim()).filter(Boolean)))
  if (!scopes.length) return '未分配'
  if (scopes.length > 1) return '混合支出'
  return scopes[0] === 'property' ? '房源支出' : '公司支出'
}

async function listReceiptImages(receiptId: string, db: any = pgPool) {
  if (!hasPg || !db) return []
  const r = await db.query(
    `SELECT id, receipt_id, url, sort_index, created_at, created_by
       FROM expense_receipt_images
      WHERE receipt_id = $1
      ORDER BY sort_index ASC, created_at ASC NULLS LAST, id ASC`,
    [receiptId],
  )
  return r?.rows || []
}

async function listReceiptItems(receiptId: string, db: any = pgPool) {
  if (!hasPg || !db) return []
  const r = await db.query(
    `SELECT i.id, i.receipt_id, i.line_no, i.scope, i.property_id, i.expense_name, i.amount, i.category, i.category_detail, i.note, i.created_at, i.updated_at,
            p.code AS property_code, p.address AS property_address, p.region AS property_region
       FROM expense_receipt_items i
       LEFT JOIN properties p ON p.id = i.property_id
      WHERE i.receipt_id = $1
      ORDER BY i.line_no ASC, i.created_at ASC NULLS LAST, i.id ASC`,
    [receiptId],
  )
  return r?.rows || []
}

async function listActiveGeneratedExpensesByReceipt(receiptId: string, db: any = pgPool) {
  if (!hasPg || !db) return { company: [], property: [] }
  const [company, property] = await Promise.all([
    db.query(
      `SELECT id, receipt_id, receipt_item_id, deleted_at
         FROM company_expenses
        WHERE receipt_id = $1`,
      [receiptId],
    ),
    db.query(
      `SELECT id, receipt_id, receipt_item_id, property_id, deleted_at
         FROM property_expenses
        WHERE receipt_id = $1`,
      [receiptId],
    ),
  ])
  return {
    company: company?.rows || [],
    property: property?.rows || [],
  }
}

async function buildReceiptDetail(receiptId: string, db: any = pgPool, opts?: { includeDeleted?: boolean }) {
  if (!hasPg || !db) return null
  const receiptR = await db.query(
    `SELECT *
       FROM expense_receipts
      WHERE id = $1
        ${opts?.includeDeleted ? '' : 'AND deleted_at IS NULL'}
      LIMIT 1`,
    [receiptId],
  )
  const receipt = receiptR?.rows?.[0]
  if (!receipt) return null
  const [images, items, generated] = await Promise.all([
    listReceiptImages(receiptId, db),
    listReceiptItems(receiptId, db),
    listActiveGeneratedExpensesByReceipt(receiptId, db),
  ])
  const byItem = new Map<string, { company_expense_id?: string; property_expense_id?: string }>()
  for (const row of generated.company || []) {
    if (row?.deleted_at) continue
    byItem.set(String(row.receipt_item_id || ''), { ...(byItem.get(String(row.receipt_item_id || '')) || {}), company_expense_id: String(row.id || '') })
  }
  for (const row of generated.property || []) {
    if (row?.deleted_at) continue
    byItem.set(String(row.receipt_item_id || ''), { ...(byItem.get(String(row.receipt_item_id || '')) || {}), property_expense_id: String(row.id || '') })
  }
  const normalizedItems = (items || []).map((item: any) => ({
    ...item,
    amount: roundMoney(item?.amount || 0),
    ...byItem.get(String(item?.id || '')),
  }))
  return {
    ...receipt,
    receipt_total_amount: roundMoney(receipt?.receipt_total_amount || 0),
    first_image_url: String(images?.[0]?.url || '').trim() || null,
    item_count: normalizedItems.length,
    scope_summary: buildReceiptScopeSummary(normalizedItems),
    images,
    items: normalizedItems,
  }
}

async function backfillLegacyMzappExpensesToReceiptsForUser(user: any, db: any = pgPool) {
  if (!hasPg || !db) return
  const actor = mzappActorId(user)
  await ensureMzappExpenseReceiptSchema()
  const companyRows = await db.query(
    `SELECT id, occurred_at, amount, category, category_detail, expense_name, note, invoice_url, created_by, generated_from, deleted_at, created_at
       FROM company_expenses
      WHERE created_by = $1
        AND COALESCE(generated_from, '') = 'mzapp'
        AND receipt_id IS NULL
        AND deleted_at IS NULL`,
    [actor],
  )
  const propertyRows = await db.query(
    `SELECT id, property_id, occurred_at, amount, category, category_detail, expense_name, note, invoice_url, created_by, generated_from, deleted_at, created_at
       FROM property_expenses
      WHERE created_by = $1
        AND COALESCE(generated_from, '') = 'mzapp'
        AND receipt_id IS NULL
        AND deleted_at IS NULL`,
    [actor],
  )
  const legacyRows = [
    ...(companyRows?.rows || []).map((row: any) => ({ ...row, scope: 'company' as const })),
    ...(propertyRows?.rows || []).map((row: any) => ({ ...row, scope: 'property' as const })),
  ]
  for (const row of legacyRows) {
    const existingReceiptId = String(row?.receipt_id || '').trim()
    if (existingReceiptId) continue
    const receiptId = crypto.randomUUID()
    const receiptItemId = crypto.randomUUID()
    const occurredAt = dayOnly(row?.occurred_at) || String(row?.occurred_at || '').slice(0, 10) || new Date().toISOString().slice(0, 10)
    const note = String(row?.note || '').trim() || null
    const receiptUrl = String(row?.invoice_url || '').trim()
    const receiptUrls = receiptUrl ? [receiptUrl] : await listExpenseReceipts(row.scope, String(row.id || ''), db).then((items) => items.map((item: any) => String(item?.url || '').trim()).filter(Boolean))
    await db.query(
      `INSERT INTO expense_receipts (id, receipt_date, receipt_total_amount, currency, note, created_by, generated_from, created_at, updated_at)
       VALUES ($1, $2, $3, 'AUD', $4, $5, 'mzapp', COALESCE($6::timestamptz, now()), now())`,
      [receiptId, occurredAt, roundMoney(row?.amount || 0), note, actor, row?.created_at || null],
    )
    await replaceReceiptImages(db, receiptId, receiptUrls, user)
    await db.query(
      `INSERT INTO expense_receipt_items (id, receipt_id, line_no, scope, property_id, expense_name, amount, category, category_detail, note, created_at, updated_at)
       VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9, COALESCE($10::timestamptz, now()), now())`,
      [
        receiptItemId,
        receiptId,
        row.scope,
        row.scope === 'property' ? String(row?.property_id || '').trim() || null : null,
        String(row?.expense_name || '').trim() || String(row?.category_detail || row?.category || '').trim() || '未命名支出',
        roundMoney(row?.amount || 0),
        String(row?.category || '').trim() || 'other',
        String(row?.category_detail || '').trim() || null,
        note,
        row?.created_at || null,
      ],
    )
    if (row.scope === 'company') {
      await db.query(
        `UPDATE company_expenses
            SET receipt_id = $2,
                receipt_item_id = $3,
                invoice_url = $4
          WHERE id = $1`,
        [String(row.id || ''), receiptId, receiptItemId, receiptUrls[0] || null],
      )
    } else {
      await db.query(
        `UPDATE property_expenses
            SET receipt_id = $2,
                receipt_item_id = $3,
                invoice_url = $4
          WHERE id = $1`,
        [String(row.id || ''), receiptId, receiptItemId, receiptUrls[0] || null],
      )
    }
  }
}

async function replaceReceiptImages(db: any, receiptId: string, urls: string[], user: any) {
  await db.query('DELETE FROM expense_receipt_images WHERE receipt_id = $1', [receiptId])
  for (let index = 0; index < urls.length; index++) {
    await db.query(
      `INSERT INTO expense_receipt_images (id, receipt_id, url, sort_index, created_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [crypto.randomUUID(), receiptId, urls[index], index, mzappActorId(user)],
    )
  }
}

async function upsertReceiptItemRow(db: any, receiptId: string, item: any) {
  const itemId = String(item?.id || '').trim() || crypto.randomUUID()
  const existing = await db.query('SELECT id FROM expense_receipt_items WHERE id = $1 AND receipt_id = $2 LIMIT 1', [itemId, receiptId])
  if (existing?.rowCount) {
    await db.query(
      `UPDATE expense_receipt_items
          SET line_no = $3,
              scope = $4,
              property_id = $5,
              expense_name = $6,
              amount = $7,
              category = $8,
              category_detail = $9,
              note = $10,
              updated_at = now()
        WHERE id = $1
          AND receipt_id = $2`,
      [itemId, receiptId, item.line_no, item.scope, item.property_id || null, item.expense_name, item.amount, item.category, item.category_detail || null, item.note || null],
    )
  } else {
    await db.query(
      `INSERT INTO expense_receipt_items (id, receipt_id, line_no, scope, property_id, expense_name, amount, category, category_detail, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [itemId, receiptId, item.line_no, item.scope, item.property_id || null, item.expense_name, item.amount, item.category, item.category_detail || null, item.note || null],
    )
  }
  return itemId
}

async function softDeleteGeneratedExpensesByReceiptItem(db: any, receiptItemId: string, user: any) {
  const actor = mzappActorId(user)
  const now = new Date().toISOString()
  await db.query(
    `UPDATE company_expenses
        SET deleted_at = COALESCE(deleted_at, $2),
            deleted_by = COALESCE(deleted_by, $3),
            delete_source = COALESCE(delete_source, 'mzapp')
      WHERE receipt_item_id = $1
        AND deleted_at IS NULL`,
    [receiptItemId, now, actor],
  )
  await db.query(
    `UPDATE property_expenses
        SET deleted_at = COALESCE(deleted_at, $2),
            deleted_by = COALESCE(deleted_by, $3),
            delete_source = COALESCE(delete_source, 'mzapp')
      WHERE receipt_item_id = $1
        AND deleted_at IS NULL`,
    [receiptItemId, now, actor],
  )
}

async function upsertGeneratedExpenseFromReceiptItem(
  db: any,
  receipt: { id: string; receipt_date: string; note?: string | null },
  item: any,
  receiptUrls: string[],
  user: any,
) {
  const actor = mzappActorId(user)
  const occurredAt = dayOnly(receipt.receipt_date) || new Date().toISOString().slice(0, 10)
  const monthKey = occurredAt.slice(0, 7)
  if (item.scope === 'company') {
    await db.query(
      `UPDATE property_expenses
          SET deleted_at = COALESCE(deleted_at, now()),
              deleted_by = COALESCE(deleted_by, $2),
              delete_source = COALESCE(delete_source, 'mzapp')
        WHERE receipt_item_id = $1
          AND deleted_at IS NULL`,
      [item.id, actor],
    )
    const existing = await db.query(
      `SELECT id
         FROM company_expenses
        WHERE receipt_item_id = $1
          AND deleted_at IS NULL
        ORDER BY created_at DESC NULLS LAST
        LIMIT 1`,
      [item.id],
    )
    const expenseId = String(existing?.rows?.[0]?.id || '').trim() || crypto.randomUUID()
    const values = [
      expenseId,
      occurredAt,
      monthKey,
      item.amount,
      item.category,
      item.category === 'other' ? item.category_detail || null : item.category_detail || null,
      item.expense_name,
      item.note || null,
      receiptUrls[0] || null,
      actor,
      receipt.id,
      item.id,
    ]
    if (existing?.rowCount) {
      await db.query(
        `UPDATE company_expenses
            SET occurred_at = $2,
                due_date = $2,
                paid_date = $2,
                month_key = $3,
                amount = $4,
                currency = 'AUD',
                category = $5,
                category_detail = $6,
                expense_name = $7,
                note = $8,
                invoice_url = $9,
                created_by = COALESCE(created_by, $10),
                generated_from = 'mzapp',
                receipt_id = $11,
                receipt_item_id = $12,
                deleted_at = NULL,
                deleted_by = NULL,
                delete_source = NULL
          WHERE id = $1`,
        values,
      )
    } else {
      await db.query(
        `INSERT INTO company_expenses (id, occurred_at, due_date, paid_date, month_key, amount, currency, category, category_detail, expense_name, note, invoice_url, created_by, generated_from, receipt_id, receipt_item_id)
         VALUES ($1, $2, $2, $2, $3, $4, 'AUD', $5, $6, $7, $8, $9, $10, 'mzapp', $11, $12)`,
        values,
      )
    }
    await syncExpenseReceipts('company', expenseId, receiptUrls, user, db)
    return { scope: 'company' as const, expenseId }
  }
  await db.query(
    `UPDATE company_expenses
        SET deleted_at = COALESCE(deleted_at, now()),
            deleted_by = COALESCE(deleted_by, $2),
            delete_source = COALESCE(delete_source, 'mzapp')
      WHERE receipt_item_id = $1
        AND deleted_at IS NULL`,
    [item.id, actor],
  )
  const existing = await db.query(
    `SELECT id
       FROM property_expenses
      WHERE receipt_item_id = $1
        AND deleted_at IS NULL
      ORDER BY created_at DESC NULLS LAST
      LIMIT 1`,
    [item.id],
  )
  const expenseId = String(existing?.rows?.[0]?.id || '').trim() || crypto.randomUUID()
  const values = [
    expenseId,
    String(item.property_id || '').trim(),
    occurredAt,
    monthKey,
    item.amount,
    item.category,
    item.category === 'other' ? item.category_detail || null : item.category_detail || null,
    item.expense_name,
    item.note || null,
    receiptUrls[0] || null,
    actor,
    receipt.id,
    item.id,
  ]
  if (existing?.rowCount) {
    await db.query(
      `UPDATE property_expenses
          SET property_id = $2,
              occurred_at = $3,
              due_date = $3,
              paid_date = $3,
              month_key = $4,
              amount = $5,
              currency = 'AUD',
              category = $6,
              category_detail = $7,
              expense_name = $8,
              note = $9,
              invoice_url = $10,
              created_by = COALESCE(created_by, $11),
              generated_from = 'mzapp',
              receipt_id = $12,
              receipt_item_id = $13,
              deleted_at = NULL,
              deleted_by = NULL,
              delete_source = NULL
        WHERE id = $1`,
      values,
    )
  } else {
    await db.query(
      `INSERT INTO property_expenses (id, property_id, occurred_at, due_date, paid_date, month_key, amount, currency, category, category_detail, expense_name, note, invoice_url, created_by, generated_from, receipt_id, receipt_item_id)
       VALUES ($1, $2, $3, $3, $3, $4, $5, 'AUD', $6, $7, $8, $9, $10, $11, 'mzapp', $12, $13)`,
      values,
    )
  }
  await syncExpenseReceipts('property', expenseId, receiptUrls, user, db)
  return { scope: 'property' as const, expenseId }
}

async function mzappUploadExpenseReceipt(file: Express.Multer.File) {
  const ext = path.extname(String(file?.originalname || '')) || '.jpg'
  if (hasR2 && (file as any)?.buffer) {
    const key = `mzapp/expenses/${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`
    const buffer = Buffer.isBuffer((file as any).buffer) ? (file as any).buffer : Buffer.from((file as any).buffer || '')
    const mime = String(file?.mimetype || 'application/octet-stream')
    const uploaded = await r2Upload(key, mime, buffer)
    return uploaded
  }
  const filePath = String((file as any)?.path || '').trim()
  if (filePath) return `/uploads/${path.basename(filePath)}`
  throw new Error('upload_failed')
}

async function resolveReceiptImageInput(receiptUrl: string) {
  const raw = String(receiptUrl || '').trim()
  if (!raw) return null
  if (/^https?:\/\//i.test(raw) || /^data:/i.test(raw)) return raw
  const normalized = raw.startsWith('/') ? raw : `/${raw}`
  if (/^\/uploads\//i.test(normalized)) {
    const rel = normalized.replace(/^\/+/, '')
    const full = path.join(process.cwd(), rel)
    const buf = await fs.promises.readFile(full)
    const ext = path.extname(full).toLowerCase()
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg'
    return `data:${mime};base64,${buf.toString('base64')}`
  }
  return raw
}

function tryParseJsonObject(raw: string) {
  const text = String(raw || '').trim()
  if (!text) return null
  try { return JSON.parse(text) } catch {}
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return null
  try { return JSON.parse(match[0]) } catch {}
  return null
}

async function ocrExpenseReceipt(receiptUrl: string) {
  const apiKey = String(process.env.OPENAI_API_KEY || '').trim()
  const model = String(process.env.MZAPP_EXPENSE_OCR_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini').trim()
  const baseUrl = String(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').trim().replace(/\/+$/g, '')
  if (!apiKey) return { available: false, reason: 'ocr_not_configured', suggestion: {} }
  try {
    const imageInput = await resolveReceiptImageInput(receiptUrl)
    if (!imageInput) return { available: false, reason: 'receipt_not_accessible', suggestion: {} }
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: 'You extract receipt data. Return JSON only with keys expense_name, amount, occurred_at. expense_name should be a short item or merchant description in Chinese when obvious, otherwise original text. amount should be a number without currency symbol. occurred_at must be YYYY-MM-DD when confident, otherwise null.',
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Read this receipt image and extract the best guess for expense_name, amount, and occurred_at. If unsure, use null.' },
              { type: 'image_url', image_url: { url: imageInput } },
            ],
          },
        ],
      }),
    })
    if (!resp.ok) return { available: false, reason: 'ocr_provider_error', suggestion: {} }
    const data: any = await resp.json().catch(() => null)
    const raw = String(data?.choices?.[0]?.message?.content || '').trim()
    const parsed = tryParseJsonObject(raw) || {}
    const amount = Number(parsed?.amount)
    const occurredAt = dayOnly(parsed?.occurred_at)
    const suggestion = {
      expense_name: String(parsed?.expense_name || '').trim() || undefined,
      amount: Number.isFinite(amount) && amount > 0 ? Number(amount.toFixed(2)) : undefined,
      occurred_at: occurredAt || undefined,
    }
    const hasSuggestion = !!(suggestion.expense_name || suggestion.amount != null || suggestion.occurred_at)
    return { available: true, reason: hasSuggestion ? undefined : 'no_fields_extracted', suggestion }
  } catch {
    return { available: false, reason: 'ocr_provider_error', suggestion: {} }
  }
}

function isCleanerRole(user: any) {
  return hasRole(user, 'cleaner')
}

function isInspectorRole(user: any) {
  return hasRole(user, 'cleaning_inspector')
}

function isCleanerInspectorRole(user: any) {
  return hasRole(user, 'cleaner_inspector')
}

async function refreshAutoExpenseSourceSummary(refType: 'maintenance' | 'deep_cleaning', row: any) {
  if (!hasPg || !pgPool) return
  const refId = String(row?.id || '').trim()
  if (!refId) return
  const sourceSummary = refType === 'maintenance' ? maintenanceSourceSummary(row) : deepCleaningSourceSummary(row)
  try {
    await pgPool.query(
      `UPDATE property_expenses
          SET source_summary = $3
        WHERE ref_type = $1
          AND ref_id = $2
          AND is_auto = true
          AND COALESCE(manual_override, false) = false`,
      [refType, refId, sourceSummary || null],
    )
  } catch {}
  try {
    await pgPool.query(
      `UPDATE company_expenses
          SET source_summary = $3
        WHERE ref_type = $1
          AND ref_id = $2
          AND is_auto = true
          AND COALESCE(manual_override, false) = false`,
      [refType, refId, sourceSummary || null],
    )
  } catch {}
}

async function listKeysHungNotificationUserIds(actorId?: string) {
  if (!hasPg || !pgPool) return []
  const { listManagerUserIds, excludeUserIds } = require('./notifications')
  const managerUsers = await listManagerUserIds({ roles: ['admin', 'offline_manager', 'customer_service'] })
  return excludeUserIds(managerUsers, actorId)
}

async function listConsumablesManagerNotificationUserIds(actorId?: string) {
  if (!hasPg || !pgPool) return []
  const { listManagerUserIds, excludeUserIds } = require('./notifications')
  const managerUsers = await listManagerUserIds({ roles: ['admin', 'offline_manager'] })
  return excludeUserIds(managerUsers, actorId)
}

async function listInspectionPhotoUrls(taskId: string) {
  if (!hasPg || !pgPool) return []
  try {
    const r = await pgPool.query(
      `SELECT url
       FROM cleaning_task_media
       WHERE task_id = $1
         AND type LIKE 'inspection_%'
         AND COALESCE(url, '') <> ''
       ORDER BY captured_at ASC NULLS LAST, created_at ASC NULLS LAST, id ASC`,
      [String(taskId || '').trim()],
    )
    return Array.from(new Set((r?.rows || []).map((row: any) => String(row?.url || '').trim()).filter(Boolean)))
  } catch {
    return []
  }
}

async function resolveCleaningTaskPropertyCode(taskId: string) {
  if (!hasPg || !pgPool) return ''
  try {
    const r = await pgPool.query(
      `SELECT COALESCE(p_id.code::text, p_code.code::text, t.property_id::text) AS property_code
       FROM cleaning_tasks t
       LEFT JOIN properties p_id ON p_id.id::text = t.property_id::text
       LEFT JOIN properties p_code ON upper(p_code.code) = upper(t.property_id::text)
       WHERE t.id::text = $1::text
       LIMIT 1`,
      [String(taskId || '').trim()],
    )
    return String(r?.rows?.[0]?.property_code || '').trim()
  } catch {
    return ''
  }
}

function mapCleaningTaskStatus(v: any): string {
  const s = String(v ?? '').trim().toLowerCase()
  if (!s) return 'todo'
  if (s === 'cancelled' || s === 'canceled') return 'cancelled'
  if (s === 'keys_hung') return 'keys_hung'
  if (s === 'done' || s === 'completed' || s === 'cleaned' || s === 'restocked' || s === 'inspected' || s === 'ready') return 'done'
  if (s === 'in_progress' || s === 'cleaning') return 'in_progress'
  if (s === 'assigned' || s === 'scheduled') return 'assigned'
  return 'todo'
}

function summaryFromCleaningTimes(checkoutTime: any, checkinTime: any) {
  const out: string[] = []
  const co = String(checkoutTime || '').trim()
  const ci = String(checkinTime || '').trim()
  if (co) out.push(`${co}退房`)
  if (ci) out.push(`${ci}入住`)
  return out.join(' ')
}

function cleaningType(taskType: any): 'checkout' | 'checkin' | 'stayover' | 'other' {
  const s = String(taskType || '').trim().toLowerCase()
  if (s === 'checkout_clean') return 'checkout'
  if (s === 'checkin_clean') return 'checkin'
  if (s === 'stayover_clean') return 'stayover'
  return 'other'
}

function parseYmd(s0: any) {
  const s = String(s0 || '').trim().slice(0, 10)
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null
  return { y, m: mo, d }
}

function daysBetweenYmd(a0: any, b0: any) {
  const a = parseYmd(a0)
  const b = parseYmd(b0)
  if (!a || !b) return null
  const ta = Date.UTC(a.y, a.m - 1, a.d, 12, 0, 0)
  const tb = Date.UTC(b.y, b.m - 1, b.d, 12, 0, 0)
  return Math.round((tb - ta) / 86400000)
}

function clampInt(n0: any, min: number, max: number) {
  const n = Number(n0)
  if (!Number.isFinite(n)) return null
  const v = Math.max(min, Math.min(max, Math.trunc(n)))
  return v
}

function computeStayedRemaining(params: { checkin: any; checkout: any; taskDate: any; nightsTotal: any }) {
  const total0 = params.nightsTotal == null ? daysBetweenYmd(params.checkin, params.checkout) : Number(params.nightsTotal)
  if (!Number.isFinite(total0 as any)) return { stayed: null as number | null, remaining: null as number | null }
  const total = Math.max(0, Math.trunc(total0 as any))
  const stayed0 = daysBetweenYmd(params.checkin, params.taskDate)
  const stayed = stayed0 == null ? null : clampInt(stayed0, 0, total)
  const remaining = stayed == null ? null : Math.max(0, total - stayed)
  return { stayed, remaining }
}

function firstNonEmpty(...vals: any[]) {
  for (const v of vals) {
    const s = String(v ?? '').trim()
    if (s) return s
  }
  return null
}

function normalizeTimeOrDefault(v: any, fallback: string) {
  const s = String(v ?? '').trim()
  return s || fallback
}

async function ensureWorkTasksTable() {
  if (!hasPg || !pgPool) return
  await pgPool.query(`CREATE TABLE IF NOT EXISTS work_tasks (
    id text PRIMARY KEY,
    task_kind text NOT NULL,
    source_type text NOT NULL,
    source_id text NOT NULL,
    property_id text,
    title text NOT NULL DEFAULT '',
    summary text,
    scheduled_date date,
    start_time text,
    end_time text,
    assignee_id text,
    status text NOT NULL DEFAULT 'todo',
    urgency text NOT NULL DEFAULT 'medium',
    sort_index integer,
    completion_photo_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
    completion_note text,
    completion_reason text,
    created_by text,
    updated_by text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );`)
  await pgPool.query(`ALTER TABLE IF EXISTS work_tasks ADD COLUMN IF NOT EXISTS sort_index integer;`)
  await pgPool.query(`ALTER TABLE IF EXISTS work_tasks ADD COLUMN IF NOT EXISTS completion_photo_urls jsonb NOT NULL DEFAULT '[]'::jsonb;`)
  await pgPool.query(`ALTER TABLE IF EXISTS work_tasks ADD COLUMN IF NOT EXISTS completion_note text;`)
  await pgPool.query(`ALTER TABLE IF EXISTS work_tasks ADD COLUMN IF NOT EXISTS completion_reason text;`)
  await pgPool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_work_tasks_source ON work_tasks(source_type, source_id);`)
  await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_work_tasks_day_assignee ON work_tasks(scheduled_date, assignee_id, status);`)
  await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_work_tasks_kind_day ON work_tasks(task_kind, scheduled_date);`)
  await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_work_tasks_day ON work_tasks(scheduled_date);`)
}

async function ensureMzappAlertsTable() {
  if (!hasPg || !pgPool) return
  await pgPool.query(`CREATE TABLE IF NOT EXISTS mzapp_alerts (
    id text PRIMARY KEY,
    kind text NOT NULL,
    target_user_id text NOT NULL,
    level text NOT NULL,
    date date,
    position integer,
    payload jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    read_at timestamptz
  );`)
  await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_mzapp_alerts_target_unread ON mzapp_alerts(target_user_id, read_at, created_at);`)
  await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_mzapp_alerts_kind ON mzapp_alerts(kind);`)
  await pgPool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_mzapp_alerts_dedupe ON mzapp_alerts(kind, target_user_id, date, position, level);`)
}

async function ensureGuestLuggageTables() {
  if (!hasPg || !pgPool) return
  await pgPool.query(`CREATE TABLE IF NOT EXISTS guest_luggage_notices (
    id text PRIMARY KEY,
    property_id text NOT NULL,
    task_date date NOT NULL,
    note text,
    photo_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
    version integer NOT NULL DEFAULT 1,
    created_by text,
    updated_by text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(property_id, task_date)
  );`)
  await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_guest_luggage_notices_task ON guest_luggage_notices(task_date, property_id);`)
  await pgPool.query(`CREATE TABLE IF NOT EXISTS guest_luggage_acknowledgements (
    notice_id text NOT NULL REFERENCES guest_luggage_notices(id) ON DELETE CASCADE,
    user_id text NOT NULL,
    notice_version integer NOT NULL,
    acknowledged_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(notice_id, user_id)
  );`)
  await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_guest_luggage_ack_user ON guest_luggage_acknowledgements(user_id, acknowledged_at DESC);`)
}

function canEditGuestLuggage(user: any) {
  return canEditGuestLuggageForRoles(roleNamesOf(user))
}

function melbourneToday() {
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Melbourne',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${value.year}-${value.month}-${value.day}`
}

async function resolveGuestLuggageTaskScope(taskIds0: string[], client: any = pgPool) {
  const taskIds = Array.from(new Set((taskIds0 || []).map((x) => String(x || '').trim()).filter(Boolean)))
  if (!taskIds.length || !client) throw new Error('missing task ids')
  const result = await client.query(
    `SELECT t.id::text AS id,
            COALESCE(p_id.id::text, p_code.id::text, t.property_id::text) AS property_id,
            COALESCE(p_id.code::text, p_code.code::text, t.property_id::text) AS property_code,
            COALESCE(t.task_date, t.date)::text AS task_date,
            t.assignee_id::text AS assignee_id,
            t.cleaner_id::text AS cleaner_id,
            t.inspector_id::text AS inspector_id,
            lower(COALESCE(t.task_type, '')) AS task_type
     FROM cleaning_tasks t
     LEFT JOIN properties p_id ON p_id.id::text = t.property_id::text
     LEFT JOIN properties p_code ON upper(p_code.code) = upper(t.property_id::text)
     WHERE t.id::text = ANY($1::text[])
       AND COALESCE(t.status, '') <> 'cancelled'`,
    [taskIds],
  )
  const rows = result?.rows || []
  if (rows.length !== taskIds.length) throw new Error('invalid task ids')
  const propertyIds = Array.from(new Set<string>(rows.map((row: any) => String(row.property_id || '').trim()).filter(Boolean)))
  const taskDates = Array.from(new Set<string>(rows.map((row: any) => String(row.task_date || '').slice(0, 10)).filter(Boolean)))
  if (propertyIds.length !== 1 || taskDates.length !== 1) throw new Error('tasks must belong to the same property and date')
  return {
    taskIds,
    rows,
    propertyId: propertyIds[0],
    propertyCode: String(rows[0]?.property_code || '').trim(),
    taskDate: taskDates[0],
  }
}

async function loadGuestLuggageNotice(noticeId: string, viewerUserId: string, client: any = pgPool) {
  if (!client) return null
  const noticeResult = await client.query(
    `SELECT id, property_id::text AS property_id, task_date::text AS task_date, note, photo_urls, version,
            created_by, updated_by, created_at::text AS created_at, updated_at::text AS updated_at
     FROM guest_luggage_notices
     WHERE id = $1
     LIMIT 1`,
    [noticeId],
  )
  const row = noticeResult?.rows?.[0] || null
  if (!row) return null
  const version = Number(row.version || 1)
  const assignments = await client.query(
    `WITH assigned AS (
       SELECT 'cleaner'::text AS role_kind,
              COALESCE(t.cleaner_id::text, t.assignee_id::text) AS user_id
       FROM cleaning_tasks t
       LEFT JOIN properties p_id ON p_id.id::text = t.property_id::text
       LEFT JOIN properties p_code ON upper(p_code.code) = upper(t.property_id::text)
       WHERE COALESCE(p_id.id::text, p_code.id::text, t.property_id::text) = $1
         AND COALESCE(t.task_date, t.date)::date = $2::date
         AND COALESCE(t.status, '') <> 'cancelled'
       UNION ALL
       SELECT 'inspector'::text AS role_kind, t.inspector_id::text AS user_id
       FROM cleaning_tasks t
       LEFT JOIN properties p_id ON p_id.id::text = t.property_id::text
       LEFT JOIN properties p_code ON upper(p_code.code) = upper(t.property_id::text)
       WHERE COALESCE(p_id.id::text, p_code.id::text, t.property_id::text) = $1
         AND COALESCE(t.task_date, t.date)::date = $2::date
         AND COALESCE(t.status, '') <> 'cancelled'
     )
     SELECT DISTINCT a.role_kind, a.user_id,
            COALESCE(NULLIF(TRIM(u.username), ''), NULLIF(TRIM(u.legal_name), ''), NULLIF(TRIM(u.email), ''), a.user_id) AS user_name,
            ack.acknowledged_at::text AS acknowledged_at
     FROM assigned a
     LEFT JOIN users u ON u.id::text = a.user_id
     LEFT JOIN guest_luggage_acknowledgements ack
       ON ack.notice_id = $3
      AND ack.user_id = a.user_id
      AND ack.notice_version = $4
     WHERE COALESCE(a.user_id, '') <> ''
     ORDER BY a.role_kind, user_name`,
    [String(row.property_id || ''), String(row.task_date || '').slice(0, 10), noticeId, version],
  )
  const cleaners: any[] = []
  const inspectors: any[] = []
  for (const item of assignments?.rows || []) {
    const mapped = {
      user_id: String(item.user_id || ''),
      user_name: String(item.user_name || item.user_id || ''),
      acknowledged: !!item.acknowledged_at,
      acknowledged_at: item.acknowledged_at ? String(item.acknowledged_at) : null,
    }
    if (String(item.role_kind || '') === 'inspector') inspectors.push(mapped)
    else cleaners.push(mapped)
  }
  const currentUserAcknowledged = [...cleaners, ...inspectors].some(
    (item) => item.user_id === viewerUserId && item.acknowledged,
  )
  return {
    id: String(row.id || ''),
    property_id: String(row.property_id || ''),
    task_date: String(row.task_date || '').slice(0, 10),
    note: row.note == null ? null : String(row.note || ''),
    photo_urls: normalizeStoredPhotoUrls(row.photo_urls),
    version,
    created_by: row.created_by == null ? null : String(row.created_by || ''),
    updated_by: row.updated_by == null ? null : String(row.updated_by || ''),
    created_at: row.created_at ? String(row.created_at) : null,
    updated_at: row.updated_at ? String(row.updated_at) : null,
    current_user_acknowledged: currentUserAcknowledged,
    acknowledgements: { cleaners, inspectors },
  }
}

async function listGuestLuggageRecipients(propertyId: string, taskDate: string) {
  if (!pgPool) return []
  const taskUsers = await pgPool.query(
    `SELECT t.cleaner_id::text AS cleaner_id, t.inspector_id::text AS inspector_id, t.assignee_id::text AS assignee_id
     FROM cleaning_tasks t
     LEFT JOIN properties p_id ON p_id.id::text = t.property_id::text
     LEFT JOIN properties p_code ON upper(p_code.code) = upper(t.property_id::text)
     WHERE COALESCE(p_id.id::text, p_code.id::text, t.property_id::text) = $1
       AND COALESCE(t.task_date, t.date)::date = $2::date
       AND COALESCE(t.status, '') <> 'cancelled'`,
    [propertyId, taskDate],
  )
  const { listUserIdsByRoles } = require('./notifications')
  return resolveGuestLuggageRecipientIds(taskUsers?.rows || [], await listUserIdsByRoles(['admin', 'offline_manager']))
}

async function emitGuestLuggageTaskEvents(params: {
  taskRows: any[]
  taskIds: string[]
  patch?: any
  actorUserId: string
}) {
  for (const row of params.taskRows || []) {
    await emitWorkTaskEvent({
      taskId: `cleaning_task:${String(row.id || '')}`,
      sourceType: 'cleaning_tasks',
      sourceRefIds: params.taskIds,
      eventType: 'TASK_DETAIL_ASSET_CHANGED',
      changeScope: 'detail',
      changedFields: ['guest_luggage'],
      patch: params.patch === undefined ? null : { guest_luggage: params.patch },
      causedByUserId: params.actorUserId || null,
      visibilityHints: buildCleaningTaskVisibilityHints(row),
    })
  }
}

router.get('/alerts', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  const uid = String(user.sub || '').trim()
  if (!uid) return res.status(401).json({ message: 'unauthorized' })
  try {
    if (!hasPg || !pgPool) return res.json([])
    await ensureMzappAlertsTable()
    const unread = String((req.query as any)?.unread || '0').trim() === '1'
    const kind = String((req.query as any)?.kind || '').trim()
    const limit0 = Number((req.query as any)?.limit || 50)
    const limit = Number.isFinite(limit0) ? Math.max(1, Math.min(200, limit0)) : 50
    const where: string[] = ['target_user_id=$1']
    const vals: any[] = [uid]
    if (unread) where.push('read_at IS NULL')
    if (kind) {
      vals.push(kind)
      where.push(`kind=$${vals.length}`)
    }
    vals.push(limit)
    const sql = `SELECT id, kind, level, date::text AS date, position, payload, created_at::text AS created_at, read_at::text AS read_at
                 FROM mzapp_alerts
                 WHERE ${where.join(' AND ')}
                 ORDER BY created_at DESC
                 LIMIT $${vals.length}`
    const r = await pgPool.query(sql, vals)
    return res.json(r?.rows || [])
  } catch (e: any) {
    return res.status(500).json({ message: String(e?.message || 'alerts_failed') })
  }
})

router.post('/alerts/:id/read', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  const uid = String(user.sub || '').trim()
  if (!uid) return res.status(401).json({ message: 'unauthorized' })
  const id = String(req.params.id || '').trim()
  if (!id) return res.status(400).json({ message: 'missing id' })
  try {
    if (!hasPg || !pgPool) return res.json({ ok: true })
    await ensureMzappAlertsTable()
    await pgPool.query('UPDATE mzapp_alerts SET read_at=now() WHERE id=$1 AND target_user_id=$2', [id, uid])
    return res.json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: String(e?.message || 'alerts_read_failed') })
  }
})

let mediaEnsured = false
let mediaEnsuring: Promise<void> | null = null

async function ensureCleaningTaskMediaTable() {
  if (!hasPg || !pgPool) return
  if (mediaEnsured) return
  if (mediaEnsuring) return mediaEnsuring
  mediaEnsuring = (async () => {
    await pgPool.query(`CREATE TABLE IF NOT EXISTS cleaning_task_media (
        id text PRIMARY KEY,
        task_id text REFERENCES cleaning_tasks(id) ON DELETE CASCADE,
        type text,
        url text NOT NULL,
        note text,
        captured_at timestamptz,
        lat numeric,
        lng numeric,
        uploader_id text,
        size integer,
        mime text,
        created_at timestamptz DEFAULT now()
      );`)
    await pgPool.query(`ALTER TABLE cleaning_task_media ADD COLUMN IF NOT EXISTS note text;`)
    await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_cleaning_task_media_task ON cleaning_task_media(task_id);`)
    await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_cleaning_task_media_type ON cleaning_task_media(type);`)
    await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_cleaning_task_media_task_type ON cleaning_task_media(task_id, type);`)
    mediaEnsured = true
  })()
    .catch((e) => {
      mediaEnsured = false
      mediaEnsuring = null
      throw e
    })
    .finally(() => {
      mediaEnsuring = null
    })
  return mediaEnsuring
}

export async function warmupMzappModule() {
  if (!(hasPg && pgPool)) return
  await ensureCleaningTaskMediaTable()
  try {
    await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_cleaning_task_media_task_type_captured_created ON cleaning_task_media(task_id, type, captured_at DESC, created_at DESC)`)
  } catch {}
}

let checkoutEnsured = false
let checkoutEnsuring: Promise<void> | null = null

async function ensureCleaningCheckoutColumns() {
  if (!hasPg || !pgPool) return
  if (checkoutEnsured) return
  if (checkoutEnsuring) return checkoutEnsuring
  checkoutEnsuring = (async () => {
    await pgPool.query(`ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS checked_out_at timestamptz;`)
    await pgPool.query(`ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS checkout_marked_by text;`)
    checkoutEnsured = true
  })()
    .catch((e) => {
      checkoutEnsured = false
      checkoutEnsuring = null
      throw e
    })
    .finally(() => {
      checkoutEnsuring = null
    })
  return checkoutEnsuring
}

let cleaningCustomerEnsured = false
let cleaningCustomerEnsuring: Promise<void> | null = null

async function ensureCleaningCustomerColumns() {
  if (!hasPg || !pgPool) return
  if (cleaningCustomerEnsured) return
  if (cleaningCustomerEnsuring) return cleaningCustomerEnsuring
  cleaningCustomerEnsuring = (async () => {
    await pgPool.query(`ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS guest_special_request text;`)
    await pgPool.query(`ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS keys_required integer NOT NULL DEFAULT 1;`)
    await pgPool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS keys_required integer NOT NULL DEFAULT 1;`)
    cleaningCustomerEnsured = true
  })()
    .catch((e) => {
      cleaningCustomerEnsured = false
      cleaningCustomerEnsuring = null
      throw e
    })
    .finally(() => {
      cleaningCustomerEnsuring = null
    })
  return cleaningCustomerEnsuring
}

let cleaningInspectionEnsured = false
let cleaningInspectionEnsuring: Promise<void> | null = null

async function ensureCleaningInspectionColumns() {
  if (!hasPg || !pgPool) return
  if (cleaningInspectionEnsured) return
  if (cleaningInspectionEnsuring) return cleaningInspectionEnsuring
  cleaningInspectionEnsuring = (async () => {
    await pgPool.query(`ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS inspection_mode text;`)
    await pgPool.query(`ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS inspection_due_date date;`)
    cleaningInspectionEnsured = true
  })()
    .catch((e) => {
      cleaningInspectionEnsured = false
      cleaningInspectionEnsuring = null
      throw e
    })
    .finally(() => {
      cleaningInspectionEnsuring = null
    })
  return cleaningInspectionEnsuring
}

let checklistEnsured = false
let checklistEnsuring: Promise<void> | null = null

async function ensureCleaningChecklistTables() {
  if (!hasPg || !pgPool) return
  if (checklistEnsured) return
  if (checklistEnsuring) return checklistEnsuring
  checklistEnsuring = (async () => {
    await pgPool.query(`CREATE TABLE IF NOT EXISTS cleaning_checklist_items (
        id text PRIMARY KEY,
        label text NOT NULL,
        kind text NOT NULL DEFAULT 'consumable',
        required boolean NOT NULL DEFAULT true,
        requires_photo_when_low boolean NOT NULL DEFAULT true,
        active boolean NOT NULL DEFAULT true,
        sort_order integer,
        created_by text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );`)
    await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_cleaning_checklist_active_sort ON cleaning_checklist_items (active, sort_order, created_at);`)
    await pgPool.query(`ALTER TABLE cleaning_consumable_usages ADD COLUMN IF NOT EXISTS status text;`)
    await pgPool.query(`ALTER TABLE cleaning_consumable_usages ADD COLUMN IF NOT EXISTS photo_url text;`)
    await pgPool.query(`ALTER TABLE cleaning_consumable_usages ADD COLUMN IF NOT EXISTS photo_urls text;`)
    await pgPool.query(`ALTER TABLE cleaning_consumable_usages ADD COLUMN IF NOT EXISTS item_label text;`)
    await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_cleaning_consumables_status ON cleaning_consumable_usages (status);`)
    await pgPool.query(
        `INSERT INTO cleaning_checklist_items (id, label, kind, required, requires_photo_when_low, active, sort_order)
         VALUES
          ('toilet_paper','卷纸','consumable',true,true,true,10),
          ('facial_tissue','抽纸','consumable',true,true,true,20),
          ('shampoo','洗发水','consumable',true,true,true,30),
          ('conditioner','护发素','consumable',true,true,true,40),
          ('body_wash','沐浴露','consumable',true,true,true,50),
          ('hand_soap','洗手液','consumable',true,true,true,60),
          ('dish_sponge','洗碗海绵','consumable',true,true,true,70),
          ('dish_soap','洗碗皂','consumable',true,true,true,80),
          ('tea_bags','茶包','consumable',true,true,true,90),
          ('coffee','咖啡','consumable',true,true,true,100),
          ('sugar_sticks','条装糖','consumable',true,true,true,110),
          ('bin_bags_large','大垃圾袋（有大垃圾桶才需要）','consumable',true,true,true,120),
          ('bin_bags_small','小垃圾袋','consumable',true,true,true,130),
          ('dish_detergent','洗洁精','consumable',true,true,true,140),
          ('laundry_powder','洗衣粉','consumable',true,true,true,150),
          ('cooking_oil','食用油','consumable',true,true,true,160),
          ('salt_sugar','盐糖','consumable',true,true,true,170),
          ('pepper','花椒（替换旧的花椒瓶带走）','consumable',true,true,true,180),
          ('toilet_cleaner','洁厕灵','consumable',true,true,true,190),
          ('bleach','漂白水（房间里用空的瓶子不要扔掉）','consumable',true,true,true,200),
          ('spare_pillowcase','备用枕套','consumable',true,true,true,210),
          ('other','其他','consumable',false,true,true,900)
         ON CONFLICT (id) DO NOTHING`,
    )
    checklistEnsured = true
  })()
    .catch((e) => {
      checklistEnsured = false
      checklistEnsuring = null
      throw e
    })
    .finally(() => {
      checklistEnsuring = null
    })
  return checklistEnsuring
}

let cleaningSortEnsured = false
let cleaningSortEnsuring: Promise<void> | null = null

async function ensureCleaningTaskSortColumns() {
  if (!hasPg || !pgPool) return
  if (cleaningSortEnsured) return
  if (cleaningSortEnsuring) return cleaningSortEnsuring
  cleaningSortEnsuring = (async () => {
    const r = await pgPool.query(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'cleaning_tasks'
         AND column_name = ANY($1::text[])`,
      [['sort_index_cleaner', 'sort_index_inspector']],
    )
    const have = new Set((r?.rows || []).map((x: any) => String(x.column_name || '')))
    if (!have.has('sort_index_cleaner')) {
      await pgPool.query(`ALTER TABLE IF EXISTS cleaning_tasks ADD COLUMN IF NOT EXISTS sort_index_cleaner integer;`)
    }
    if (!have.has('sort_index_inspector')) {
      await pgPool.query(`ALTER TABLE IF EXISTS cleaning_tasks ADD COLUMN IF NOT EXISTS sort_index_inspector integer;`)
    }
    cleaningSortEnsured = true
  })()
    .catch((e) => {
      cleaningSortEnsured = false
      cleaningSortEnsuring = null
      throw e
    })
    .finally(() => {
      cleaningSortEnsuring = null
    })
  return cleaningSortEnsuring
}

router.post('/cleaning-tasks/reorder', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  const userId = String(user.sub || '')
  const kind = String(req.body?.kind || '').trim().toLowerCase()
  const date = dayOnly(req.body?.date)
  const groups = Array.isArray(req.body?.groups) ? req.body.groups : null
  if (!date) return res.status(400).json({ message: 'invalid date' })
  if (kind !== 'cleaner' && kind !== 'inspector') return res.status(400).json({ message: 'invalid kind' })
  if (!groups || !groups.length) return res.status(400).json({ message: 'groups required' })

  if (kind === 'cleaner') {
    if (!(isCleanerRole(user) || isCleanerInspectorRole(user))) return res.status(403).json({ message: 'forbidden' })
  } else {
    if (!(isInspectorRole(user) || isCleanerInspectorRole(user))) return res.status(403).json({ message: 'forbidden' })
  }

  try {
    if (!hasPg || !pgPool) return res.json({ ok: false })
    await ensureCleaningTaskSortColumns()

    let idx = 1
    const entryById = new Map<string, number>()
    for (const g of groups as any[]) {
      if (!Array.isArray(g)) continue
      const ids = Array.from(new Set(g.map((x: any) => String(x || '').trim()).filter(Boolean)))
      if (!ids.length) continue
      for (const id of ids) entryById.set(id, idx)
      idx++
    }
    const entries = Array.from(entryById.entries()).map(([id, sort_index]) => ({ id, sort_index }))
    if (!entries.length) return res.status(400).json({ message: 'groups required' })
    const data = JSON.stringify(entries)
    const sql = kind === 'cleaner'
      ? `
        UPDATE cleaning_tasks AS t
        SET sort_index_cleaner = v.sort_index, updated_at = now()
        FROM jsonb_to_recordset($1::jsonb) AS v(id text, sort_index integer)
        WHERE t.id::text = v.id
          AND COALESCE(t.task_date, t.date)::date = $2::date
          AND COALESCE(t.cleaner_id::text, t.assignee_id::text) = $3::text
      `
      : `
        UPDATE cleaning_tasks AS t
        SET sort_index_inspector = v.sort_index, updated_at = now()
        FROM jsonb_to_recordset($1::jsonb) AS v(id text, sort_index integer)
        WHERE t.id::text = v.id
          AND COALESCE(t.task_date, t.date)::date = $2::date
          AND t.inspector_id::text = $3::text
      `
    const r = await pgPool.query(sql, [data, date, userId])
    const updated = r?.rowCount || 0
    return res.json({ ok: true, updated })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'reorder_failed' })
  }
})

router.post('/cleaning-tasks/:id/lockbox-video', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  const userId = String(user.sub || '')
  const id = String(req.params.id || '').trim()
  const mediaUrl = String(req.body?.media_url || '').trim()
  if (!id) return res.status(400).json({ message: 'missing id' })
  if (!mediaUrl) return res.status(400).json({ message: 'missing media_url' })
  if (!(isInspectorRole(user) || isCleanerInspectorRole(user) || canViewAll(user))) return res.status(403).json({ message: 'forbidden' })
  if (!hasPg || !pgPool) return res.status(500).json({ message: 'pg not available' })
  try {
    await ensureCleaningTaskMediaTable()
    const r0 = await pgPool.query('SELECT id, inspector_id, property_id::text AS property_id FROM cleaning_tasks WHERE id=$1 LIMIT 1', [id])
    const row = r0?.rows?.[0] || null
    if (!row) return res.status(404).json({ message: 'not found' })
    const inspectorId = row.inspector_id ? String(row.inspector_id) : ''
    const propertyId = row.property_id ? String(row.property_id) : ''
    if (!canViewAll(user) && inspectorId !== userId) return res.status(403).json({ message: 'forbidden' })

    const restockCheck = await pgPool.query(
      `SELECT 1
       FROM cleaning_task_media
       WHERE task_id=$1
         AND (type LIKE 'restock_proof:%' OR type='inspection_consumables_confirmed')
       LIMIT 1`,
      [id],
    )
    if (!restockCheck?.rows?.length) {
      return res.status(400).json({ message: '请先确认消耗品是否充足，或完成消耗品补充提交' })
    }

    const uuid = require('uuid')
    const mediaId = uuid.v4()
    await pgPool.query(
      `INSERT INTO cleaning_task_media (id, task_id, type, url, captured_at, uploader_id)
       VALUES ($1,$2,'lockbox_video',$3,now(),$4)`,
      [mediaId, id, mediaUrl, userId],
    )
    await pgPool.query(
      `UPDATE cleaning_tasks
       SET status = 'inspected', lockbox_video_uploaded_at = now(), updated_at = now()
       WHERE id = $1`,
      [id],
    )
    try {
      const { broadcastCleaningEvent } = require('./events')
      broadcastCleaningEvent({ event: 'lockbox_video_uploaded', task_id: id })
    } catch {}
    try {
      const { emitNotificationEvent } = require('../services/notificationEvents')
      const operationId = require('uuid').v4()
      const photoUrls = await listInspectionPhotoUrls(String(id))
      const propertyCode = await resolveCleaningTaskPropertyCode(String(id))
      const recipients = await listKeysHungNotificationUserIds(userId)
      if (propertyId && recipients.length) {
        await emitNotificationEvent(
          {
            type: 'WORK_TASK_UPDATED',
            entity: 'cleaning_task',
            entityId: String(id),
            eventId: `keys_hung:${String(id)}`,
            propertyId,
            updatedAt: new Date().toISOString(),
            title: propertyCode ? `${propertyCode} · 房间已挂钥匙` : '房间已挂钥匙',
            body: '检查员已上传挂钥匙视频，房间钥匙已挂好',
            data: {
              entity: 'cleaning_task',
              entityId: String(id),
              action: 'open_task',
              kind: 'keys_hung',
              task_id: id,
              property_code: propertyCode || undefined,
              media_id: mediaId,
              photo_url: photoUrls[0] || null,
              photo_urls: photoUrls,
            },
            actorUserId: userId,
            recipientUserIds: recipients,
          },
          { operationId },
        )
      }
    } catch {}
    return res.status(201).json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'lockbox_video_failed' })
  }
})

const inspectionPhotosSchema = z
  .object({
    items: z.array(
      z.object({
        area: z.enum(['toilet', 'living', 'sofa', 'bedroom', 'kitchen', 'shower_drain', 'unclean']),
        url: z.string().trim().min(1).max(800),
        note: z.string().trim().max(800).optional().nullable(),
        captured_at: z.string().trim().max(64).optional(),
      }),
    ),
  })
  .strict()

router.get('/cleaning-tasks/:id/inspection-photos', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  const userId = String(user.sub || '')
  const id = String(req.params.id || '').trim()
  if (!id) return res.status(400).json({ message: 'missing id' })
  if (!(isInspectorRole(user) || isCleanerInspectorRole(user) || canViewAll(user))) return res.status(403).json({ message: 'forbidden' })
  if (!hasPg || !pgPool) return res.status(500).json({ message: 'pg not available' })
  try {
    await ensureCleaningChecklistTables()
    await ensureCleaningTaskMediaTable()
    const r0 = await pgPool.query('SELECT id, inspector_id, cleaner_id, assignee_id FROM cleaning_tasks WHERE id=$1 LIMIT 1', [id])
    const row = r0?.rows?.[0] || null
    if (!row) return res.status(404).json({ message: 'not found' })
    const inspectorId = row.inspector_id ? String(row.inspector_id) : ''
    const cleanerId = row.cleaner_id ? String(row.cleaner_id) : ''
    const assigneeId = row.assignee_id ? String(row.assignee_id) : ''
    if (!canViewAll(user) && inspectorId !== userId && cleanerId !== userId && assigneeId !== userId) return res.status(403).json({ message: 'forbidden' })

    const r = await pgPool.query(
      `SELECT type, url, note, captured_at, created_at
       FROM cleaning_task_media
       WHERE task_id=$1 AND type LIKE 'inspection_%'
       ORDER BY created_at ASC`,
      [id],
    )
    const items = (r?.rows || []).map((x: any) => {
      const type = String(x.type || '')
      const area = type.startsWith('inspection_') ? type.slice('inspection_'.length) : type
      return {
        area,
        url: String(x.url || ''),
        note: x.note == null ? null : String(x.note || ''),
        captured_at: x.captured_at ? String(x.captured_at) : null,
        created_at: x.created_at ? String(x.created_at) : null,
      }
    })
    return res.json({ items })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'inspection_photos_failed' })
  }
})

router.get('/cleaning-tasks/:id/consumables', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  const userId = String(user.sub || '')
  const id = String(req.params.id || '').trim()
  if (!id) return res.status(400).json({ message: 'missing id' })
  if (!hasPg || !pgPool) return res.status(500).json({ message: 'pg not available' })
  try {
    await ensureCleaningChecklistTables()
    await ensureCleaningTaskMediaTable()
    const r0 = await pgPool.query('SELECT id, inspector_id, cleaner_id, assignee_id FROM cleaning_tasks WHERE id=$1 LIMIT 1', [id])
    const row = r0?.rows?.[0] || null
    if (!row) return res.status(404).json({ message: 'not found' })
    const inspectorId = row.inspector_id ? String(row.inspector_id) : ''
    const cleanerId = row.cleaner_id ? String(row.cleaner_id) : ''
    const assigneeId = row.assignee_id ? String(row.assignee_id) : ''
    if (!canViewAll(user) && inspectorId !== userId && cleanerId !== userId && assigneeId !== userId) return res.status(403).json({ message: 'forbidden' })

    const rows = await pgPool.query(
      `SELECT id, item_id, qty, need_restock, note, status, photo_url, photo_urls, item_label, created_at
       FROM cleaning_consumable_usages
       WHERE task_id = $1
       ORDER BY created_at ASC, id ASC`,
      [String(id)],
    )
    const livingPhotoRow = await pgPool.query(
      `SELECT url
       FROM cleaning_task_media
       WHERE task_id::text = $1::text
         AND type = 'consumable_living_room_photo'
       ORDER BY captured_at DESC NULLS LAST, created_at DESC
       LIMIT 1`,
      [String(id)],
    )
    return res.json({
      living_room_photo_url: String(livingPhotoRow?.rows?.[0]?.url || '').trim() || null,
      items: (rows.rows || []).map((x: any) => ({
        id: String(x.id || ''),
        item_id: String(x.item_id || ''),
        qty: Number(x.qty || 0) || 0,
        need_restock: !!x.need_restock,
        note: x.note == null ? null : String(x.note),
        status: String(x.status || ''),
        photo_url: x.photo_url == null ? null : String(x.photo_url),
        photo_urls: normalizeStoredPhotoUrls(x.photo_urls, x.photo_url),
        item_label: x.item_label == null ? null : String(x.item_label),
        created_at: x.created_at == null ? null : String(x.created_at),
      })),
    })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'consumables_failed' })
  }
})

router.post('/cleaning-tasks/:id/inspection-photos', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  const userId = String(user.sub || '')
  const id = String(req.params.id || '').trim()
  if (!id) return res.status(400).json({ message: 'missing id' })
  if (!(isInspectorRole(user) || isCleanerInspectorRole(user) || canViewAll(user))) return res.status(403).json({ message: 'forbidden' })
  const parsed = inspectionPhotosSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  if (!hasPg || !pgPool) return res.status(500).json({ message: 'pg not available' })
  try {
    await ensureCleaningTaskMediaTable()
    const r0 = await pgPool.query('SELECT id, inspector_id, cleaner_id, assignee_id FROM cleaning_tasks WHERE id=$1 LIMIT 1', [id])
    const row = r0?.rows?.[0] || null
    if (!row) return res.status(404).json({ message: 'not found' })
    const inspectorId = row.inspector_id ? String(row.inspector_id) : ''
    const cleanerId = row.cleaner_id ? String(row.cleaner_id) : ''
    const assigneeId = row.assignee_id ? String(row.assignee_id) : ''
    if (!canViewAll(user) && inspectorId !== userId && cleanerId !== userId && assigneeId !== userId) return res.status(403).json({ message: 'forbidden' })

    const limits: Record<string, number> = { toilet: 9, living: 3, sofa: 2, bedroom: 8, kitchen: 2, shower_drain: 1, unclean: 12 }
    const byArea = new Map<string, number>()
    for (const it of parsed.data.items) {
      const a = String(it.area)
      byArea.set(a, (byArea.get(a) || 0) + 1)
      const lim = limits[a] ?? 1
      if ((byArea.get(a) || 0) > lim) return res.status(400).json({ message: '超出数量限制', area: a, limit: lim })
    }

    await pgPool.query(`DELETE FROM cleaning_task_media WHERE task_id=$1 AND type LIKE 'inspection_%'`, [id])
    const uuid = require('uuid')
    for (const it of parsed.data.items) {
      const type = `inspection_${it.area}`
      const cap = String(it.captured_at || '').trim()
      const capturedAt = cap ? new Date(cap) : new Date()
      await pgPool.query(
        `INSERT INTO cleaning_task_media (id, task_id, type, url, note, captured_at, uploader_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [uuid.v4(), id, type, String(it.url), it.note == null ? null : String(it.note || ''), capturedAt.toISOString(), userId],
      )
    }
    try {
      const { broadcastCleaningEvent } = require('./events')
      broadcastCleaningEvent({ event: 'inspection_photos_saved', task_id: id })
    } catch {}
    return res.status(201).json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'inspection_photos_failed' })
  }
})

router.get('/cleaning-tasks/:id/completion-photos', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  const userId = String(user.sub || '')
  const id = String(req.params.id || '').trim()
  if (!id) return res.status(400).json({ message: 'missing id' })
  if (!hasPg || !pgPool) return res.status(500).json({ message: 'pg not available' })
  try {
    await ensureCleaningTaskMediaTable()
    const r0 = await pgPool.query('SELECT id, inspector_id, cleaner_id, assignee_id FROM cleaning_tasks WHERE id=$1 LIMIT 1', [id])
    const row = r0?.rows?.[0] || null
    if (!row) return res.status(404).json({ message: 'not found' })
    const inspectorId = row.inspector_id ? String(row.inspector_id) : ''
    const cleanerId = row.cleaner_id ? String(row.cleaner_id) : ''
    const assigneeId = row.assignee_id ? String(row.assignee_id) : ''
    if (!canViewAll(user) && inspectorId !== userId && cleanerId !== userId && assigneeId !== userId) return res.status(403).json({ message: 'forbidden' })

    const r = await pgPool.query(
      `SELECT type, url, note, captured_at, created_at
       FROM cleaning_task_media
       WHERE task_id=$1 AND type LIKE 'completion_%'
       ORDER BY created_at ASC`,
      [id],
    )
    const items = (r?.rows || []).map((x: any) => {
      const type = String(x.type || '')
      const area = type.startsWith('completion_') ? type.slice('completion_'.length) : type
      return {
        area,
        url: String(x.url || ''),
        note: x.note == null ? null : String(x.note || ''),
        captured_at: x.captured_at ? String(x.captured_at) : null,
        created_at: x.created_at ? String(x.created_at) : null,
      }
    })
    return res.json({ items })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'completion_photos_failed' })
  }
})

const restockProofSchema = z
  .object({
    items: z.array(
      z.object({
        item_id: z.string().trim().min(1).max(80),
        status: z.enum(['restocked', 'unavailable']),
        qty: z.number().int().min(1).optional().nullable(),
        note: z.string().trim().max(800).optional().nullable(),
        proof_url: z.string().trim().min(1).max(800).optional().nullable(),
        proof_urls: z.array(z.string().trim().min(1).max(800)).max(12).optional(),
      }),
    ),
    confirmed_sufficient: z.boolean().optional(),
  })
  .strict()

router.get('/cleaning-tasks/:id/restock-proof', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  const userId = String(user.sub || '')
  const id = String(req.params.id || '').trim()
  if (!id) return res.status(400).json({ message: 'missing id' })
  if (!(isInspectorRole(user) || isCleanerInspectorRole(user) || canViewAll(user))) return res.status(403).json({ message: 'forbidden' })
  if (!hasPg || !pgPool) return res.status(500).json({ message: 'pg not available' })
  try {
    await ensureCleaningTaskMediaTable()
    const r0 = await pgPool.query('SELECT id, inspector_id, cleaner_id, assignee_id FROM cleaning_tasks WHERE id=$1 LIMIT 1', [id])
    const row = r0?.rows?.[0] || null
    if (!row) return res.status(404).json({ message: 'not found' })
    const inspectorId = row.inspector_id ? String(row.inspector_id) : ''
    const cleanerId = row.cleaner_id ? String(row.cleaner_id) : ''
    const assigneeId = row.assignee_id ? String(row.assignee_id) : ''
    if (!canViewAll(user) && inspectorId !== userId && cleanerId !== userId && assigneeId !== userId) return res.status(403).json({ message: 'forbidden' })

    const r = await pgPool.query(
      `SELECT type, url, note, created_at
       FROM cleaning_task_media
       WHERE task_id=$1 AND (type LIKE 'restock_proof:%' OR type='inspection_consumables_confirmed')
       ORDER BY created_at ASC`,
      [id],
    )
    const rows = r?.rows || []
    const confirmRow = rows.find((x: any) => String(x.type || '').trim() === 'inspection_consumables_confirmed') || null
    const grouped = new Map<string, any>()
    for (const x of rows.filter((row: any) => String(row.type || '').trim().startsWith('restock_proof:'))) {
      const type = String(x.type || '')
      const itemId = type.includes(':') ? type.split(':').slice(1).join(':') : type
      let meta: any = null
      try {
        const raw = String(x.note || '').trim()
        meta = raw && (raw.startsWith('{') || raw.startsWith('[')) ? JSON.parse(raw) : null
      } catch {}
      const proofUrl = (() => {
        const u = String(x.url || '').trim()
        return u && /^https?:\/\//i.test(u) ? u : null
      })()
      const prev = grouped.get(itemId) || {
        item_id: itemId,
        proof_url: null,
        proof_urls: [] as string[],
        status: String(meta?.status || ''),
        qty: meta?.qty == null ? null : Number(meta.qty),
        note: meta?.note == null ? null : String(meta.note || ''),
        created_at: x.created_at ? String(x.created_at) : null,
      }
      if (proofUrl && !prev.proof_urls.includes(proofUrl)) prev.proof_urls.push(proofUrl)
      prev.proof_url = prev.proof_urls[0] || null
      grouped.set(itemId, prev)
    }
    const items = Array.from(grouped.values())
    return res.json({
      items,
      confirmed_sufficient: !!confirmRow,
      confirmed_at: confirmRow?.created_at ? String(confirmRow.created_at) : null,
    })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'restock_proof_failed' })
  }
})

router.post('/cleaning-tasks/:id/restock-proof', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  const userId = String(user.sub || '')
  const id = String(req.params.id || '').trim()
  if (!id) return res.status(400).json({ message: 'missing id' })
  if (!(isInspectorRole(user) || isCleanerInspectorRole(user) || canViewAll(user))) return res.status(403).json({ message: 'forbidden' })
  const parsed = restockProofSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  if (!hasPg || !pgPool) return res.status(500).json({ message: 'pg not available' })
  try {
    await ensureCleaningTaskMediaTable()
    const r0 = await pgPool.query('SELECT id, inspector_id, cleaner_id, assignee_id FROM cleaning_tasks WHERE id=$1 LIMIT 1', [id])
    const row = r0?.rows?.[0] || null
    if (!row) return res.status(404).json({ message: 'not found' })
    const inspectorId = row.inspector_id ? String(row.inspector_id) : ''
    const cleanerId = row.cleaner_id ? String(row.cleaner_id) : ''
    const assigneeId = row.assignee_id ? String(row.assignee_id) : ''
    if (!canViewAll(user) && inspectorId !== userId && cleanerId !== userId && assigneeId !== userId) return res.status(403).json({ message: 'forbidden' })

    const uniq = new Set<string>()
    for (const it of parsed.data.items) {
      const k = String(it.item_id || '').trim()
      if (!k) continue
      if (uniq.has(k)) return res.status(400).json({ message: '重复 item_id', item_id: k })
      uniq.add(k)
    }

    const confirmedSufficient = !!parsed.data.confirmed_sufficient
    const restockActionKind = parsed.data.items.length ? 'restock_proof_saved' : 'restock_sufficient_confirmed'
    const restockActionTitle = parsed.data.items.length ? '补货凭证已提交' : '消耗品已确认充足'
    const restockActionBody = parsed.data.items.length ? '检查员已提交补货凭证' : '检查员已确认现场消耗品充足'
    if (!parsed.data.items.length && !confirmedSufficient) {
      return res.status(400).json({ message: '请确认消耗品是否充足，或提交补充记录' })
    }

    await pgPool.query(`DELETE FROM cleaning_task_media WHERE task_id=$1 AND (type LIKE 'restock_proof:%' OR type='inspection_consumables_confirmed')`, [id])
    const uuid = require('uuid')
    const batchId = uuid.v4()
    for (const it of parsed.data.items) {
      const meta = { status: it.status, qty: it.qty == null ? null : Number(it.qty), note: it.note == null ? null : String(it.note || '') }
      const proofUrls = normalizeStoredPhotoUrls(it.proof_urls, it.proof_url)
      const urlsToPersist = it.status === 'unavailable' ? ['no_photo'] : (proofUrls.length ? proofUrls : ['no_photo'])
      for (const url of urlsToPersist) {
        await pgPool.query(
          `INSERT INTO cleaning_task_media (id, task_id, type, url, note, captured_at, uploader_id)
           VALUES ($1,$2,$3,$4,$5,now(),$6)`,
          [uuid.v4(), id, `restock_proof:${it.item_id}`, url, JSON.stringify(meta), userId],
        )
      }
    }
    if (confirmedSufficient) {
      await pgPool.query(
        `INSERT INTO cleaning_task_media (id, task_id, type, url, note, captured_at, uploader_id)
         VALUES ($1,$2,'inspection_consumables_confirmed',$3,$4,now(),$5)`,
        [uuid.v4(), id, 'confirmed', JSON.stringify({ confirmed_sufficient: true }), userId],
      )
    }
    try {
      const { broadcastCleaningEvent } = require('./events')
      broadcastCleaningEvent({ event: restockActionKind, task_id: id })
    } catch {}
    try {
      const { emitNotificationEvent } = require('../services/notificationEvents')
      const operationId = require('uuid').v4()
      const to = await listConsumablesManagerNotificationUserIds(userId)
      let propertyId = ''
      try {
        const r2 = await pgPool.query(`SELECT property_id::text AS property_id FROM cleaning_tasks WHERE id::text=$1::text LIMIT 1`, [String(id)])
        propertyId = String(r2?.rows?.[0]?.property_id || '').trim()
      } catch {}
      if (propertyId && to.length) {
        await emitNotificationEvent(
          {
            type: 'WORK_TASK_UPDATED',
            entity: 'cleaning_task',
            entityId: String(id),
            propertyId,
            updatedAt: new Date().toISOString(),
            title: restockActionTitle,
            body: restockActionBody,
            data: { entity: 'cleaning_task', entityId: String(id), action: 'open_task', kind: restockActionKind, task_id: id, batch_id: batchId },
            actorUserId: userId,
            recipientUserIds: to,
          },
          { operationId },
        )
      }
    } catch {}
    return res.status(201).json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'restock_proof_failed' })
  }
})

async function emitGuestCheckoutRealtimeEvents(params: {
  taskIds: string[]
  checkedOutAt: string | null
  propertyCode: string
  keysRequired?: number | null
  eventId: string
  cancelled?: boolean
  causedByUserId?: string | null
}) {
  if (!hasPg || !pgPool) return
  const taskIds = Array.from(new Set((params.taskIds || []).map((id) => String(id || '').trim()).filter(Boolean)))
  if (!taskIds.length) return
  const result = await pgPool.query(
    `SELECT id::text AS id, assignee_id, cleaner_id, inspector_id
     FROM cleaning_tasks
     WHERE id::text = ANY($1::text[])`,
    [taskIds],
  )
  for (const row of result?.rows || []) {
    const id = String(row?.id || '').trim()
    if (!id) continue
    await emitWorkTaskEvent({
      taskId: `cleaning_task:${id}`,
      sourceType: 'cleaning_tasks',
      sourceRefIds: [id],
      eventType: 'TASK_UPDATED',
      changeScope: 'list',
      changedFields: ['checked_out_at'],
      patch: { checked_out_at: params.cancelled ? null : params.checkedOutAt },
      causedByUserId: params.causedByUserId || null,
      visibilityHints: buildCleaningTaskVisibilityHints(row),
    })
  }
}

router.post('/cleaning-tasks/:id/guest-checked-out', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  const userId = String(user.sub || '')
  if (!(hasRole(user, 'customer_service') || hasRole(user, 'admin') || hasRole(user, 'offline_manager'))) return res.status(403).json({ message: 'forbidden' })
  const id = String(req.params.id || '').trim()
  if (!id) return res.status(400).json({ message: 'missing id' })
  if (!hasPg || !pgPool) return res.status(500).json({ message: 'pg not available' })
  try {
    await ensureCleaningCheckoutColumns()
    try {
      await pgPool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS keys_required integer NOT NULL DEFAULT 1;`)
    } catch {}
    const action = String(req.body?.action || 'set').trim().toLowerCase()
    const r0 = await pgPool.query('SELECT id, checked_out_at FROM cleaning_tasks WHERE id=$1 LIMIT 1', [id])
    const row = r0?.rows?.[0] || null
    if (!row) return res.status(404).json({ message: 'not found' })
    const prevCheckedOutAt = row.checked_out_at ? String(row.checked_out_at) : null
    if (action === 'unset' || action === 'clear' || action === 'cancel') {
      await pgPool.query(
        `UPDATE cleaning_tasks
         SET checked_out_at = NULL,
             checkout_marked_by = NULL,
             updated_at = now()
         WHERE id = $1`,
        [id],
      )
      try {
        const { broadcastCleaningEvent } = require('./events')
        broadcastCleaningEvent({ event: 'guest_checked_out_cancelled', task_id: id })
      } catch {}
      try {
        const { listCleaningTaskUserIds, listManagerUserIds } = require('./notifications')
        let propertyCode = ''
        let propertyId = ''
        try {
          const r = await pgPool.query(
            `SELECT t.property_id::text AS property_id,
                    COALESCE(p_id.code, p_code.code, t.property_id::text) AS property_code
             FROM cleaning_tasks t
             LEFT JOIN properties p_id ON (p_id.id::text) = (t.property_id::text)
             LEFT JOIN properties p_code ON upper(p_code.code) = upper(t.property_id::text)
             WHERE t.id=$1 LIMIT 1`,
            [id],
          )
          propertyId = String(r?.rows?.[0]?.property_id || '').trim()
          propertyCode = String(r?.rows?.[0]?.property_code || '').trim()
        } catch {}
        const to = Array.from(new Set([...(await listCleaningTaskUserIds(id)), ...(await listManagerUserIds())]))
        const eventId = `guest_checked_out_cancelled:${propertyCode || id}:${prevCheckedOutAt || ''}`
        await emitGuestCheckoutRealtimeEvents({
          taskIds: [id],
          checkedOutAt: prevCheckedOutAt,
          propertyCode,
          eventId,
          cancelled: true,
          causedByUserId: userId,
        })
        if (propertyId && to.length) {
          const { emitNotificationEvent } = require('../services/notificationEvents')
          await emitNotificationEvent({
            type: 'CLEANING_TASK_UPDATED',
            entity: 'cleaning_task',
            entityId: String(id),
            propertyId,
            eventId,
            updatedAt: new Date().toISOString(),
            changes: ['status'],
            title: propertyCode ? `待退房：${propertyCode}` : '待退房',
            body: '房源还未退房，待退房',
            data: { entity: 'cleaning_task', entityId: String(id), action: 'open_task', kind: 'guest_checked_out_cancelled', task_id: id, property_code: propertyCode, checked_out_at: prevCheckedOutAt, event_id: eventId },
            actorUserId: userId,
            recipientUserIds: to,
          })
        }
      } catch {}
      return res.status(201).json({ ok: true })
    }
    await pgPool.query(
      `UPDATE cleaning_tasks
       SET checked_out_at = COALESCE(checked_out_at, now()),
           checkout_marked_by = COALESCE(checkout_marked_by, $2),
           updated_at = now()
       WHERE id = $1`,
      [id, userId],
    )
    try {
      const { broadcastCleaningEvent } = require('./events')
      broadcastCleaningEvent({ event: 'guest_checked_out', task_id: id })
    } catch {}
    try {
      const { listCleaningTaskUserIds, listManagerUserIds } = require('./notifications')
      let checkedOutAt: string | null = null
      let propertyCode = ''
      let propertyId = ''
      let keysRequired: number | null = null
      try {
        const r = await pgPool.query(
          `SELECT t.checked_out_at, t.property_id::text AS property_id, COALESCE(o.keys_required, 1) AS keys_required, COALESCE(p_id.code, p_code.code, t.property_id::text) AS property_code
           FROM cleaning_tasks t
           LEFT JOIN orders o ON (o.id::text) = (t.order_id::text)
           LEFT JOIN properties p_id ON (p_id.id::text) = (t.property_id::text)
           LEFT JOIN properties p_code ON upper(p_code.code) = upper(t.property_id::text)
           WHERE t.id=$1 LIMIT 1`,
          [id],
        )
        checkedOutAt = r?.rows?.[0]?.checked_out_at ? String(r.rows[0].checked_out_at) : null
        propertyId = String(r?.rows?.[0]?.property_id || '').trim()
        propertyCode = String(r?.rows?.[0]?.property_code || '').trim()
        keysRequired = r?.rows?.[0]?.keys_required == null ? null : Number(r.rows[0].keys_required)
      } catch {}
      const to = Array.from(new Set([...(await listCleaningTaskUserIds(id)), ...(await listManagerUserIds())]))
      const eventId = `guest_checked_out:${propertyCode || id}:${checkedOutAt || ''}`
      const body = keysRequired && keysRequired >= 2 ? `已退房（${keysRequired}把钥匙）` : '已退房'
      await emitGuestCheckoutRealtimeEvents({
        taskIds: [id],
        checkedOutAt,
        propertyCode,
        keysRequired,
        eventId,
        causedByUserId: userId,
      })
      if (propertyId && to.length) {
        const { emitNotificationEvent } = require('../services/notificationEvents')
        await emitNotificationEvent({
          type: 'CLEANING_TASK_UPDATED',
          entity: 'cleaning_task',
          entityId: String(id),
          propertyId,
          eventId,
          updatedAt: checkedOutAt || new Date().toISOString(),
          changes: ['status', 'keys'],
          title: propertyCode ? `已退房：${propertyCode}` : '已退房',
          body,
          data: { entity: 'cleaning_task', entityId: String(id), action: 'open_task', kind: 'guest_checked_out', task_id: id, property_code: propertyCode, checked_out_at: checkedOutAt, keys_required: keysRequired, event_id: eventId },
          actorUserId: userId,
          recipientUserIds: to,
        })
      }
    } catch {}
    return res.status(201).json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'guest_checked_out_failed' })
  }
})

const guestCheckedOutBulkSchema = z
  .object({
    task_ids: z.array(z.string().trim().min(1)).min(1).max(20),
    action: z.enum(['set', 'unset']).optional(),
  })
  .strict()

router.post('/cleaning-tasks/guest-checked-out', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  const userId = String(user.sub || '')
  if (!(hasRole(user, 'customer_service') || hasRole(user, 'admin') || hasRole(user, 'offline_manager'))) return res.status(403).json({ message: 'forbidden' })
  const parsed = guestCheckedOutBulkSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  if (!hasPg || !pgPool) return res.status(500).json({ message: 'pg not available' })
  const ids = Array.from(new Set(parsed.data.task_ids.map((x) => String(x || '').trim()).filter(Boolean)))
  if (!ids.length) return res.status(400).json({ message: 'missing task_ids' })
  try {
    await ensureCleaningCheckoutColumns()
    try {
      await pgPool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS keys_required integer NOT NULL DEFAULT 1;`)
    } catch {}
    const action = String(parsed.data.action || 'set').trim().toLowerCase()
    let ids2 = ids
    try {
      const rTypes = await pgPool.query(
        `SELECT id::text AS id, order_id::text AS order_id, task_type::text AS task_type
         FROM cleaning_tasks
         WHERE id::text = ANY($1::text[])`,
        [ids],
      )
      const checkoutIds = (rTypes?.rows || [])
        .filter((x: any) => String(x?.task_type || '').trim().toLowerCase() === 'checkout_clean')
        .map((x: any) => String(x?.id || '').trim())
        .filter(Boolean)
      if (checkoutIds.length) ids2 = Array.from(new Set(checkoutIds))
    } catch {}
    if (action === 'unset' || action === 'clear' || action === 'cancel') {
      let prevCheckedOutAt: string | null = null
      try {
        const rPrev = await pgPool.query(`SELECT checked_out_at FROM cleaning_tasks WHERE id=$1 LIMIT 1`, [ids2[0]])
        prevCheckedOutAt = rPrev?.rows?.[0]?.checked_out_at ? String(rPrev.rows[0].checked_out_at) : null
      } catch {}
      await pgPool.query(
        `UPDATE cleaning_tasks
         SET checked_out_at = NULL,
             checkout_marked_by = NULL,
             updated_at = now()
         WHERE id::text = ANY($1::text[])`,
        [ids2],
      )
      try {
        const { broadcastCleaningEvent } = require('./events')
        for (const id of ids2) broadcastCleaningEvent({ event: 'guest_checked_out_cancelled', task_id: id })
      } catch {}
      let propertyCode = ''
      let propertyId = ''
      try {
        const r = await pgPool.query(
          `SELECT t.property_id::text AS property_id,
                  COALESCE(p_id.code, p_code.code, t.property_id::text) AS property_code
           FROM cleaning_tasks t
           LEFT JOIN properties p_id ON (p_id.id::text) = (t.property_id::text)
           LEFT JOIN properties p_code ON upper(p_code.code) = upper(t.property_id::text)
           WHERE t.id=$1 LIMIT 1`,
          [ids2[0]],
        )
        propertyId = String(r?.rows?.[0]?.property_id || '').trim()
        propertyCode = String(r?.rows?.[0]?.property_code || '').trim()
      } catch {}
      try {
        const { listCleaningTaskUserIdsBulk, listManagerUserIds } = require('./notifications')
        const to = Array.from(new Set([...(await listCleaningTaskUserIdsBulk(ids2)), ...(await listManagerUserIds())]))
        const eventId = `guest_checked_out_cancelled:${propertyCode || ids2[0]}:${prevCheckedOutAt || ''}`
        await emitGuestCheckoutRealtimeEvents({
          taskIds: ids2,
          checkedOutAt: prevCheckedOutAt,
          propertyCode,
          eventId,
          cancelled: true,
          causedByUserId: userId,
        })
        if (propertyId && to.length) {
          const { emitNotificationEvent } = require('../services/notificationEvents')
          await emitNotificationEvent({
            type: 'CLEANING_TASK_UPDATED',
            entity: 'cleaning_task',
            entityId: String(ids2[0]),
            propertyId,
            eventId,
            updatedAt: new Date().toISOString(),
            changes: ['status'],
            title: propertyCode ? `待退房：${propertyCode}` : '待退房',
            body: '房源还未退房，待退房',
            data: { entity: 'cleaning_task', entityId: String(ids2[0]), action: 'open_task', kind: 'guest_checked_out_cancelled', task_ids: ids2, property_code: propertyCode, checked_out_at: prevCheckedOutAt, event_id: eventId },
            actorUserId: userId,
            recipientUserIds: to,
          })
        }
      } catch {}
      return res.status(201).json({ ok: true })
    }

    await pgPool.query(
      `UPDATE cleaning_tasks
       SET checked_out_at = COALESCE(checked_out_at, now()),
           checkout_marked_by = COALESCE(checkout_marked_by, $2),
           updated_at = now()
       WHERE id::text = ANY($1::text[])`,
      [ids2, userId],
    )
    try {
      const { broadcastCleaningEvent } = require('./events')
      for (const id of ids2) broadcastCleaningEvent({ event: 'guest_checked_out', task_id: id })
    } catch {}

    let checkedOutAt: string | null = null
    let propertyCode = ''
    let keysRequired: number | null = null
    try {
      const r = await pgPool.query(
        `SELECT t.checked_out_at, COALESCE(o.keys_required, 1) AS keys_required, COALESCE(p_id.code, p_code.code, t.property_id::text) AS property_code
         FROM cleaning_tasks t
         LEFT JOIN orders o ON (o.id::text) = (t.order_id::text)
         LEFT JOIN properties p_id ON (p_id.id::text) = (t.property_id::text)
         LEFT JOIN properties p_code ON upper(p_code.code) = upper(t.property_id::text)
         WHERE t.id=$1 LIMIT 1`,
        [ids2[0]],
      )
      checkedOutAt = r?.rows?.[0]?.checked_out_at ? String(r.rows[0].checked_out_at) : null
      propertyCode = String(r?.rows?.[0]?.property_code || '').trim()
      keysRequired = r?.rows?.[0]?.keys_required == null ? null : Number(r.rows[0].keys_required)
    } catch {}
    const eventId = `guest_checked_out:${propertyCode || ids2[0]}:${checkedOutAt || ''}`
    await emitGuestCheckoutRealtimeEvents({
      taskIds: ids2,
      checkedOutAt,
      propertyCode,
      keysRequired,
      eventId,
      causedByUserId: userId,
    })
    try {
      const { listCleaningTaskUserIdsBulk, listManagerUserIds } = require('./notifications')
      const to = Array.from(new Set([...(await listCleaningTaskUserIdsBulk(ids2)), ...(await listManagerUserIds())]))
      const body = keysRequired && keysRequired >= 2 ? `已退房（${keysRequired}把钥匙）` : '已退房'
      if (propertyCode && to.length) {
        const r0 = await pgPool.query(
          `SELECT property_id::text AS property_id
           FROM cleaning_tasks
           WHERE id::text = $1::text
           LIMIT 1`,
          [ids2[0]],
        )
        const propertyId = String(r0?.rows?.[0]?.property_id || '').trim()
        if (propertyId) {
          const { emitNotificationEvent } = require('../services/notificationEvents')
          await emitNotificationEvent({
            type: 'CLEANING_TASK_UPDATED',
            entity: 'cleaning_task',
            entityId: String(ids2[0]),
            propertyId,
            eventId,
            updatedAt: checkedOutAt || new Date().toISOString(),
            changes: ['status', 'keys'],
            title: propertyCode ? `已退房：${propertyCode}` : '已退房',
            body,
            data: { entity: 'cleaning_task', entityId: String(ids2[0]), action: 'open_task', kind: 'guest_checked_out', task_ids: ids2, property_code: propertyCode, checked_out_at: checkedOutAt, keys_required: keysRequired, event_id: eventId },
            actorUserId: userId,
            recipientUserIds: to,
          })
        }
      }
    } catch {}
    return res.status(201).json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'guest_checked_out_bulk_failed' })
  }
})

const orderCheckedOutSchema = z
  .object({
    order_id: z.string().trim().min(1),
    action: z.enum(['set', 'unset']).optional(),
  })
  .strict()

router.post('/cleaning-tasks/order-checked-out', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  const userId = String(user.sub || '')
  if (!(hasRole(user, 'customer_service') || hasRole(user, 'admin') || hasRole(user, 'offline_manager'))) return res.status(403).json({ message: 'forbidden' })
  const parsed = orderCheckedOutSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  if (!hasPg || !pgPool) return res.status(500).json({ message: 'pg not available' })
  const orderId = String(parsed.data.order_id || '').trim()
  if (!orderId) return res.status(400).json({ message: 'missing order_id' })
  try {
    await ensureCleaningCheckoutColumns()
    try {
      await pgPool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS keys_required integer NOT NULL DEFAULT 1;`)
    } catch {}

    const action = String(parsed.data.action || 'set').trim().toLowerCase()
    const rTasks = await pgPool.query(
      `SELECT id::text AS id
       FROM cleaning_tasks
       WHERE order_id::text = $1::text
         AND lower(COALESCE(task_type,'')) = 'checkout_clean'
         AND COALESCE(status,'') <> 'cancelled'
       ORDER BY COALESCE(task_date, date) DESC, id DESC`,
      [orderId],
    )
    const taskIds = Array.from(new Set((rTasks?.rows || []).map((x: any) => String(x.id || '').trim()).filter(Boolean)))
    if (!taskIds.length) return res.status(404).json({ message: 'checkout task not found' })

    if (action === 'unset' || action === 'clear' || action === 'cancel') {
      let prevCheckedOutAt: string | null = null
      try {
        const rPrev = await pgPool.query(`SELECT checked_out_at FROM cleaning_tasks WHERE id=$1 LIMIT 1`, [taskIds[0]])
        prevCheckedOutAt = rPrev?.rows?.[0]?.checked_out_at ? String(rPrev.rows[0].checked_out_at) : null
      } catch {}
      await pgPool.query(
        `UPDATE cleaning_tasks
         SET checked_out_at = NULL,
             checkout_marked_by = NULL,
             updated_at = now()
         WHERE id::text = ANY($1::text[])`,
        [taskIds],
      )
      try {
        const { broadcastCleaningEvent } = require('./events')
        for (const id of taskIds) broadcastCleaningEvent({ event: 'guest_checked_out_cancelled', task_id: id })
      } catch {}
      let propertyCode = ''
      let propertyId = ''
      try {
        const r = await pgPool.query(
          `SELECT t.property_id::text AS property_id,
                  COALESCE(p_id.code, p_code.code, t.property_id::text) AS property_code
           FROM cleaning_tasks t
           LEFT JOIN properties p_id ON (p_id.id::text) = (t.property_id::text)
           LEFT JOIN properties p_code ON upper(p_code.code) = upper(t.property_id::text)
           WHERE t.id=$1 LIMIT 1`,
          [taskIds[0]],
        )
        propertyId = String(r?.rows?.[0]?.property_id || '').trim()
        propertyCode = String(r?.rows?.[0]?.property_code || '').trim()
      } catch {}
      try {
        const { listCleaningTaskUserIdsBulk, listManagerUserIds } = require('./notifications')
        const to = Array.from(new Set([...(await listCleaningTaskUserIdsBulk(taskIds)), ...(await listManagerUserIds())]))
        const eventId = `guest_checked_out_cancelled:${propertyCode || taskIds[0]}:${prevCheckedOutAt || ''}`
        await emitGuestCheckoutRealtimeEvents({
          taskIds,
          checkedOutAt: prevCheckedOutAt,
          propertyCode,
          eventId,
          cancelled: true,
          causedByUserId: userId,
        })
        if (propertyId && to.length) {
          const { emitNotificationEvent } = require('../services/notificationEvents')
          await emitNotificationEvent({
            type: 'CLEANING_TASK_UPDATED',
            entity: 'cleaning_task',
            entityId: String(taskIds[0]),
            propertyId,
            eventId,
            updatedAt: new Date().toISOString(),
            changes: ['status'],
            title: propertyCode ? `待退房：${propertyCode}` : '待退房',
            body: '房源还未退房，待退房',
            data: { entity: 'cleaning_task', entityId: String(taskIds[0]), action: 'open_task', kind: 'guest_checked_out_cancelled', task_ids: taskIds, property_code: propertyCode, checked_out_at: prevCheckedOutAt, event_id: eventId },
            actorUserId: userId,
            recipientUserIds: to,
          })
        }
      } catch {}
      return res.status(201).json({ ok: true })
    }

    await pgPool.query(
      `UPDATE cleaning_tasks
       SET checked_out_at = COALESCE(checked_out_at, now()),
           checkout_marked_by = COALESCE(checkout_marked_by, $2),
           updated_at = now()
       WHERE id::text = ANY($1::text[])`,
      [taskIds, userId],
    )
    try {
      const { broadcastCleaningEvent } = require('./events')
      for (const id of taskIds) broadcastCleaningEvent({ event: 'guest_checked_out', task_id: id })
    } catch {}

    let checkedOutAt: string | null = null
    let propertyCode = ''
    let propertyId = ''
    let keysRequired: number | null = null
    try {
      const r = await pgPool.query(
        `SELECT t.checked_out_at,
                COALESCE(o.keys_required, 1) AS keys_required,
                t.property_id::text AS property_id,
                COALESCE(p_id.code, p_code.code, t.property_id::text) AS property_code
         FROM cleaning_tasks t
         LEFT JOIN orders o ON (o.id::text) = (t.order_id::text)
         LEFT JOIN properties p_id ON (p_id.id::text) = (t.property_id::text)
         LEFT JOIN properties p_code ON upper(p_code.code) = upper(t.property_id::text)
         WHERE t.id=$1 LIMIT 1`,
        [taskIds[0]],
      )
      checkedOutAt = r?.rows?.[0]?.checked_out_at ? String(r.rows[0].checked_out_at) : null
      propertyId = String(r?.rows?.[0]?.property_id || '').trim()
      propertyCode = String(r?.rows?.[0]?.property_code || '').trim()
      keysRequired = r?.rows?.[0]?.keys_required == null ? null : Number(r.rows[0].keys_required)
    } catch {}
    const eventId = `guest_checked_out:${propertyCode || taskIds[0]}:${checkedOutAt || ''}`
    await emitGuestCheckoutRealtimeEvents({
      taskIds,
      checkedOutAt,
      propertyCode,
      keysRequired,
      eventId,
      causedByUserId: userId,
    })
    try {
      const { listCleaningTaskUserIdsBulk, listManagerUserIds } = require('./notifications')
      const { emitNotificationEvent } = require('../services/notificationEvents')
      const operationId = require('uuid').v4()
      const to = Array.from(new Set([...(await listCleaningTaskUserIdsBulk(taskIds)), ...(await listManagerUserIds())]))
      const body = keysRequired && keysRequired >= 2 ? `已退房（${keysRequired}把钥匙）` : '已退房'
      if (propertyId && to.length) {
        await emitNotificationEvent(
          {
            type: 'CLEANING_TASK_UPDATED',
            entity: 'cleaning_task',
            entityId: String(taskIds[0]),
            propertyId,
            eventId,
            updatedAt: checkedOutAt || new Date().toISOString(),
            changes: ['status', 'keys'],
            title: propertyCode ? `已退房：${propertyCode}` : '已退房',
            body,
            data: { entity: 'cleaning_task', entityId: String(taskIds[0]), action: 'open_task', kind: 'guest_checked_out', task_ids: taskIds, property_code: propertyCode, checked_out_at: checkedOutAt, keys_required: keysRequired, event_id: eventId },
            actorUserId: userId,
            recipientUserIds: to,
          },
          { operationId },
        )
      }
    } catch {}
    return res.status(201).json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'order_checked_out_failed' })
  }
})

const orderKeysRequiredSchema = z
  .object({
    order_id: z.string().trim().min(1),
    keys_required: z
      .preprocess((v) => {
        if (v == null) return v
        if (typeof v === 'number') return v
        const n = Number(v)
        return Number.isFinite(n) ? n : v
      }, z.number().int().min(1).max(2)),
  })
  .strict()

router.post('/cleaning-tasks/order-keys-required', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  if (!(hasRole(user, 'customer_service') || hasRole(user, 'admin') || hasRole(user, 'offline_manager'))) return res.status(403).json({ message: 'forbidden' })
  const parsed = orderKeysRequiredSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  if (!hasPg || !pgPool) return res.status(500).json({ message: 'pg not available' })
  const orderId = String(parsed.data.order_id || '').trim()
  const nextK = Math.max(1, Math.min(2, Math.trunc(Number(parsed.data.keys_required))))
  try {
    await ensureCleaningCustomerColumns()
    try {
      await pgPool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS keys_required integer NOT NULL DEFAULT 1;`)
    } catch {}

    const r0 = await pgPool.query(`SELECT keys_required FROM orders WHERE id::text = $1::text LIMIT 1`, [orderId])
    const prevK0 = r0?.rows?.[0]?.keys_required == null ? 1 : Number(r0.rows[0].keys_required)
    const prevK = Number.isFinite(prevK0) ? Math.max(1, Math.min(2, Math.trunc(prevK0))) : 1
    if (prevK === nextK) return res.json({ ok: true, skipped: 'no_change' })

    await pgPool.query(`UPDATE orders SET keys_required = $1 WHERE id::text = $2::text`, [nextK, orderId])
    const rTasks = await pgPool.query(
      `UPDATE cleaning_tasks
       SET keys_required = $1, updated_at = now()
       WHERE order_id::text = $2::text
         AND lower(COALESCE(task_type,'')) IN ('checkin_clean','checkout_clean')
         AND COALESCE(status,'') <> 'cancelled'
       RETURNING id::text AS id`,
      [nextK, orderId],
    )
    const touched = Array.from(new Set((rTasks?.rows || []).map((x: any) => String(x.id || '').trim()).filter(Boolean)))
    let allTaskIds: string[] = touched
    try {
      const rAll = await pgPool.query(
        `SELECT id::text AS id
         FROM cleaning_tasks
         WHERE order_id::text = $1::text
           AND lower(COALESCE(task_type,'')) IN ('checkin_clean','checkout_clean')
           AND COALESCE(status,'') <> 'cancelled'`,
        [orderId],
      )
      allTaskIds = Array.from(new Set((rAll?.rows || []).map((x: any) => String(x.id || '').trim()).filter(Boolean)))
    } catch {}

    try {
      const { broadcastCleaningEvent } = require('./events')
      for (const id of allTaskIds) broadcastCleaningEvent({ event: 'cleaning_task_manager_fields_updated', task_id: String(id) })
    } catch {}
    if (allTaskIds.length) {
      try {
        const vis = await pgPool.query(
          `SELECT id::text AS id, assignee_id, cleaner_id, inspector_id, lower(COALESCE(task_type, '')) AS task_type
           FROM cleaning_tasks
           WHERE id::text = ANY($1::text[])`,
          [allTaskIds],
        )
        const byId = new Map<string, any>((vis?.rows || []).map((row: any) => [String(row.id || ''), row]))
        for (const id of allTaskIds) {
          const row = byId.get(String(id)) || { id }
          const taskType = String(row?.task_type || '').trim()
          const isCheckoutTask = taskType === 'checkout_clean'
          const isCheckinTask = taskType === 'checkin_clean'
          await emitWorkTaskEvent({
            taskId: `cleaning_task:${String(id)}`,
            sourceType: 'cleaning_tasks',
            sourceRefIds: [String(id)],
            eventType: 'TASK_UPDATED',
            changeScope: 'list',
            changedFields: [
              'keys_required',
              ...(isCheckoutTask ? ['keys_required_checkout'] : []),
              ...(isCheckinTask ? ['keys_required_checkin'] : []),
              'key_tags',
            ],
            patch: {
              keys_required: nextK,
              ...(isCheckoutTask ? { keys_required_checkout: nextK } : {}),
              ...(isCheckinTask ? { keys_required_checkin: nextK } : {}),
              key_tags: {
                checkout_sets: isCheckoutTask ? nextK : 0,
                checkin_sets: isCheckinTask ? nextK : 0,
                show_checkout: isCheckoutTask && nextK >= 2,
                show_checkin: isCheckinTask && nextK >= 2,
              },
            },
            causedByUserId: String(user?.sub || '').trim() || null,
            visibilityHints: buildCleaningTaskVisibilityHints(row),
          })
        }
      } catch {}
    }

    return res.status(201).json({ ok: true, updated: touched.length })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'order_keys_required_failed' })
  }
})

const managerFieldsSchema = z
  .object({
    task_ids: z.array(z.string().trim().min(1)).min(1).max(50),
    checkout_time: z.string().trim().max(32).optional().nullable(),
    checkin_time: z.string().trim().max(32).optional().nullable(),
    old_code: z.string().trim().max(64).optional().nullable(),
    new_code: z.string().trim().max(64).optional().nullable(),
    guest_special_request: z.string().trim().max(1500).optional().nullable(),
    keys_required: z
      .preprocess((v) => {
        if (v == null) return v
        if (typeof v === 'number') return v
        const n = Number(v)
        return Number.isFinite(n) ? n : v
      }, z.number().int().min(1).max(2))
      .optional()
      .nullable(),
  })
  .strict()

async function handleManagerFields(req: any, res: any) {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  if (!(hasRole(user, 'customer_service') || hasRole(user, 'admin') || hasRole(user, 'offline_manager'))) return res.status(403).json({ message: 'forbidden' })
  const parsed = managerFieldsSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  if (!hasPg || !pgPool) return res.status(500).json({ message: 'pg not available' })
  const pool = pgPool
  try {
    await ensureCleaningCustomerColumns()
    const repId = String(parsed.data.task_ids[0] || '').trim()
    let propertyCode = ''
    let propertyId = ''
    let prevRow: any = null
    try {
      const r = await pool.query(
        `SELECT t.order_id::text AS order_id, t.property_id::text AS property_id, t.checkout_time, t.checkin_time, t.old_code, t.new_code, t.guest_special_request,
                CASE
                  WHEN t.order_id IS NULL THEN COALESCE(t.keys_required, 1)
                  ELSE COALESCE(o.keys_required, t.keys_required, 1)
                END AS keys_required,
                COALESCE(p_id.code, p_code.code, t.property_id::text) AS property_code
         FROM cleaning_tasks t
         LEFT JOIN orders o ON o.id::text = t.order_id::text
         LEFT JOIN properties p_id ON (p_id.id::text) = (t.property_id::text)
         LEFT JOIN properties p_code ON upper(p_code.code) = upper(t.property_id::text)
         WHERE t.id=$1 LIMIT 1`,
        [repId],
      )
      prevRow = r?.rows?.[0] || null
      propertyId = String(prevRow?.property_id || '').trim()
      propertyCode = String(prevRow?.property_code || '').trim()
    } catch {}
    const fields: string[] = []
    const vals: any[] = []
    const push = (sql: string, v: any) => {
      vals.push(v)
      fields.push(`${sql} = $${vals.length}`)
    }
    const norm = (v: any) => String(v ?? '').replace(/\s+/g, ' ').trim()
    const eqNorm = (a: any, b: any) => norm(a) === norm(b)
    let nextKeysRequired: number | null = null
    let prevKeysRequiredMin: number | null = null
    let prevKeysRequiredMax: number | null = null
    let keysOrderIds: string[] = []
    let keysNullIds: string[] = []
    if (parsed.data.checkout_time !== undefined && !eqNorm(parsed.data.checkout_time, prevRow?.checkout_time)) push('checkout_time', parsed.data.checkout_time)
    if (parsed.data.checkin_time !== undefined && !eqNorm(parsed.data.checkin_time, prevRow?.checkin_time)) push('checkin_time', parsed.data.checkin_time)
    if (parsed.data.old_code !== undefined && !eqNorm(parsed.data.old_code, prevRow?.old_code)) push('old_code', parsed.data.old_code)
    if (parsed.data.new_code !== undefined && !eqNorm(parsed.data.new_code, prevRow?.new_code)) push('new_code', parsed.data.new_code)
    if (parsed.data.guest_special_request !== undefined && !eqNorm(parsed.data.guest_special_request, prevRow?.guest_special_request)) push('guest_special_request', parsed.data.guest_special_request)
    if (parsed.data.keys_required !== undefined) {
      const nextK = parsed.data.keys_required == null ? 1 : Number(parsed.data.keys_required)
      if (Number.isFinite(nextK)) {
        const nextK2 = Math.max(1, Math.min(2, Math.trunc(nextK)))
        try {
          const ids0 = Array.from(new Set(parsed.data.task_ids.map((x) => String(x || '').trim()).filter(Boolean)))
          const rrIds = await pool.query(
            `SELECT t.id::text AS id, t.order_id::text AS order_id, t.task_type::text AS task_type,
                    COALESCE(p_id.id::text, p_code.id::text, t.property_id::text) AS property_id,
                    COALESCE(t.task_date, t.date)::text AS task_date
             FROM cleaning_tasks t
             LEFT JOIN properties p_id ON p_id.id::text = t.property_id::text
             LEFT JOIN properties p_code ON upper(p_code.code) = upper(t.property_id::text)
             WHERE t.id::text = ANY($1::text[])`,
            [ids0],
          )
          const pickedRows = (() => {
            const rows = (rrIds?.rows || []) as any[]
            const checkins = rows.filter((x: any) => String(x?.task_type || '').trim().toLowerCase() === 'checkin_clean')
            if (checkins.length) return checkins
            return []
          })()
          let incomingRows = pickedRows
          if (!incomingRows.length) {
            const rows = (rrIds?.rows || []) as any[]
            const propertyIds = Array.from(new Set(rows.map((x: any) => String(x?.property_id || '').trim()).filter(Boolean)))
            const taskDates = rows.map((x: any) => String(x?.task_date || '').slice(0, 10)).filter(Boolean).sort()
            const propertyId0 = propertyIds.length === 1 ? propertyIds[0] : ''
            const taskDate0 = taskDates[0] || ''
            if (propertyId0 && taskDate0) {
              const nextCheckins = await pool.query(
                `WITH candidates AS (
                   SELECT t.id::text AS id, t.order_id::text AS order_id,
                          COALESCE(t.task_date, t.date)::date AS task_date
                   FROM cleaning_tasks t
                   LEFT JOIN properties p_id ON p_id.id::text = t.property_id::text
                   LEFT JOIN properties p_code ON upper(p_code.code) = upper(t.property_id::text)
                   LEFT JOIN orders o ON o.id::text = t.order_id::text
                   WHERE COALESCE(p_id.id::text, p_code.id::text, t.property_id::text) = $1
                     AND COALESCE(t.task_date, t.date)::date >= $2::date
                     AND lower(COALESCE(t.task_type, '')) = 'checkin_clean'
                     AND COALESCE(t.status, '') <> 'cancelled'
                     AND (
                       t.order_id IS NULL
                       OR (
                         o.id IS NOT NULL
                         AND lower(COALESCE(o.status, '')) <> 'invalid'
                         AND lower(COALESCE(o.status, '')) NOT LIKE '%cancel%'
                       )
                     )
                 )
                 SELECT id, order_id, task_date::text AS task_date
                 FROM candidates
                 WHERE task_date = (SELECT MIN(task_date) FROM candidates)`,
                [propertyId0, taskDate0],
              )
              incomingRows = nextCheckins?.rows || []
            }
          }
          keysOrderIds = Array.from(new Set(incomingRows.map((x: any) => String(x.order_id || '').trim()).filter(Boolean)))
          keysNullIds = Array.from(new Set(incomingRows.filter((x: any) => !String(x.order_id || '').trim()).map((x: any) => String(x.id || '').trim()).filter(Boolean)))
          if (!keysOrderIds.length && !keysNullIds.length) {
            prevKeysRequiredMin = 1
            prevKeysRequiredMax = 1
          } else {
            const rrk = await pool.query(
              `WITH target_orders AS (SELECT unnest($1::text[]) AS order_id),
                    i AS (SELECT unnest($2::text[]) AS id)
               SELECT
                 MIN(CASE WHEN t.order_id IS NULL THEN COALESCE(t.keys_required, 1) ELSE COALESCE(o.keys_required, t.keys_required, 1) END) AS min_k,
                 MAX(CASE WHEN t.order_id IS NULL THEN COALESCE(t.keys_required, 1) ELSE COALESCE(o.keys_required, t.keys_required, 1) END) AS max_k,
                 SUM(CASE WHEN (CASE WHEN t.order_id IS NULL THEN COALESCE(t.keys_required, 1) ELSE COALESCE(o.keys_required, t.keys_required, 1) END) <> $3 THEN 1 ELSE 0 END) AS diff_count
               FROM cleaning_tasks t
               LEFT JOIN orders o ON o.id::text = t.order_id::text
               WHERE (t.order_id::text IN (SELECT order_id FROM target_orders))
                  OR (t.order_id IS NULL AND t.id::text IN (SELECT id FROM i))`,
              [keysOrderIds, keysNullIds, nextK2],
            )
            const minK = rrk?.rows?.[0]?.min_k == null ? 1 : Number(rrk.rows[0].min_k)
            const maxK = rrk?.rows?.[0]?.max_k == null ? 1 : Number(rrk.rows[0].max_k)
            const diffCount = rrk?.rows?.[0]?.diff_count == null ? 0 : Number(rrk.rows[0].diff_count)
            prevKeysRequiredMin = Number.isFinite(minK) ? Math.max(1, Math.min(2, Math.trunc(minK))) : 1
            prevKeysRequiredMax = Number.isFinite(maxK) ? Math.max(1, Math.min(2, Math.trunc(maxK))) : 1
            if (Number.isFinite(diffCount) && diffCount > 0) nextKeysRequired = nextK2
          }
        } catch {
          const fallback = prevRow?.keys_required == null ? 1 : Number(prevRow.keys_required)
          const k0 = Number.isFinite(fallback) ? Math.max(1, Math.min(2, Math.trunc(fallback))) : 1
          prevKeysRequiredMin = k0
          prevKeysRequiredMax = k0
        }
      }
    }
    if (!fields.length && nextKeysRequired == null) return res.json({ ok: true, skipped: 'no_change' })

    if (fields.length) {
      vals.push(parsed.data.task_ids)
      const sql = `UPDATE cleaning_tasks SET ${fields.join(', ')}, updated_at = now() WHERE id::text = ANY($${vals.length}::text[])`
      await pool.query(sql, vals)
    }

    const affectedTaskIds = new Set(parsed.data.task_ids.map((x) => String(x || '').trim()).filter(Boolean))
    if (nextKeysRequired != null) {
      try {
        const doUpdateOrder = async () => {
          if (!keysOrderIds.length) return
          await pool.query(
            `UPDATE orders
             SET keys_required = $1
             WHERE id::text = ANY($2::text[])
               AND COALESCE(keys_required, 1) <> $1`,
            [nextKeysRequired, keysOrderIds],
          )
          await pool.query(
            `UPDATE cleaning_tasks
             SET keys_required = $1, updated_at = now()
             WHERE order_id::text = ANY($2::text[])
               AND COALESCE(status,'') <> 'cancelled'
               AND COALESCE(keys_required, 1) <> $1`,
            [nextKeysRequired, keysOrderIds],
          )
          const rIds = await pool.query(
            `SELECT id::text AS id
             FROM cleaning_tasks
             WHERE order_id::text = ANY($1::text[])`,
            [keysOrderIds],
          )
          for (const x of rIds?.rows || []) {
            const id2 = String(x?.id || '').trim()
            if (id2) affectedTaskIds.add(id2)
          }
        }
        const doUpdateNull = async () => {
          if (!keysNullIds.length) return
          await pool.query(
            `UPDATE cleaning_tasks
             SET keys_required = $1, updated_at = now()
             WHERE order_id IS NULL
               AND id::text = ANY($2::text[])
               AND COALESCE(status,'') <> 'cancelled'
               AND COALESCE(keys_required, 1) <> $1`,
            [nextKeysRequired, keysNullIds],
          )
          for (const id2 of keysNullIds) affectedTaskIds.add(String(id2))
        }
        await doUpdateOrder()
        await doUpdateNull()
      } catch {}
    }

    setImmediate(() => {
      ;(async () => {
        try {
          const { broadcastCleaningEvent } = require('./events')
          for (const id of Array.from(affectedTaskIds)) broadcastCleaningEvent({ event: 'cleaning_task_manager_fields_updated', task_id: String(id) })
        } catch {}
        if (affectedTaskIds.size) {
          try {
            const affectedIds = Array.from(affectedTaskIds)
            const vis = await pool.query(
              `SELECT id::text AS id, assignee_id, cleaner_id, inspector_id, lower(COALESCE(task_type, '')) AS task_type,
                      property_id::text AS property_id,
                      COALESCE(task_date, date)::text AS task_date,
                      COALESCE(keys_required, 1) AS keys_required
               FROM cleaning_tasks
               WHERE id::text = ANY($1::text[])`,
              [affectedIds],
            )
            const byId = new Map<string, any>((vis?.rows || []).map((row: any) => [String(row.id || ''), row]))
            const keyTagsByGroup = new Map<string, { checkout_sets: number; checkin_sets: number }>()
            for (const row of vis?.rows || []) {
              const groupKey = `${String(row?.property_id || '').trim()}|${String(row?.task_date || '').slice(0, 10)}`
              const prev = keyTagsByGroup.get(groupKey) || { checkout_sets: 0, checkin_sets: 0 }
              const k0 = Number(row?.keys_required == null ? 1 : row.keys_required)
              const k = Number.isFinite(k0) ? Math.max(1, Math.min(2, Math.trunc(k0))) : 1
              const taskType = String(row?.task_type || '').trim()
              if (taskType === 'checkout_clean') prev.checkout_sets = Math.max(prev.checkout_sets, k)
              if (taskType === 'checkin_clean') prev.checkin_sets = Math.max(prev.checkin_sets, k)
              keyTagsByGroup.set(groupKey, prev)
            }
            const scope = parsed.data.checkout_time !== undefined
              || parsed.data.checkin_time !== undefined
              || parsed.data.keys_required !== undefined
              ? 'list'
              : 'detail'
            for (const id of affectedIds) {
              const row = byId.get(String(id)) || { id }
              const taskType = String(row?.task_type || '').trim()
              const isCheckoutTask = taskType === 'checkout_clean'
              const isCheckinTask = taskType === 'checkin_clean'
              const groupKey = `${String(row?.property_id || '').trim()}|${String(row?.task_date || '').slice(0, 10)}`
              const groupKeys = keyTagsByGroup.get(groupKey) || { checkout_sets: 0, checkin_sets: 0 }
              const checkoutSets = groupKeys.checkout_sets >= 2 ? groupKeys.checkout_sets : (isCheckoutTask && nextKeysRequired != null ? nextKeysRequired : 0)
              const checkinSets = groupKeys.checkin_sets >= 2 ? groupKeys.checkin_sets : (isCheckinTask && nextKeysRequired != null ? nextKeysRequired : 0)
              const mergedKeysRequired = Math.max(1, checkoutSets || 0, checkinSets || 0, nextKeysRequired || 0)
              const changedFieldsForTask = [
                ...(parsed.data.checkout_time !== undefined ? ['checkout_time', 'start_time', 'summary'] : []),
                ...(parsed.data.checkin_time !== undefined ? ['checkin_time', 'end_time', 'summary'] : []),
                ...(parsed.data.old_code !== undefined ? ['old_code'] : []),
                ...(parsed.data.new_code !== undefined ? ['new_code'] : []),
                ...(parsed.data.guest_special_request !== undefined ? ['guest_special_request'] : []),
                ...(parsed.data.keys_required !== undefined ? ['keys_required'] : []),
                ...(parsed.data.keys_required !== undefined ? ['keys_required_checkout'] : []),
                ...(parsed.data.keys_required !== undefined ? ['keys_required_checkin'] : []),
                ...(parsed.data.keys_required !== undefined ? ['key_tags'] : []),
              ]
              await emitWorkTaskEvent({
                taskId: `cleaning_task:${String(id)}`,
                sourceType: 'cleaning_tasks',
                sourceRefIds: [String(id)],
                eventType: 'TASK_UPDATED',
                changeScope: scope,
                changedFields: changedFieldsForTask,
                patch: {
                  ...(parsed.data.checkout_time !== undefined ? { checkout_time: parsed.data.checkout_time ?? null } : {}),
                  ...(parsed.data.checkout_time !== undefined ? { start_time: parsed.data.checkout_time ?? null } : {}),
                  ...(parsed.data.checkin_time !== undefined ? { checkin_time: parsed.data.checkin_time ?? null } : {}),
                  ...(parsed.data.checkin_time !== undefined ? { end_time: parsed.data.checkin_time ?? null } : {}),
                  ...(parsed.data.checkout_time !== undefined || parsed.data.checkin_time !== undefined
                    ? {
                        summary: summaryFromCleaningTimes(
                          parsed.data.checkout_time !== undefined ? parsed.data.checkout_time : prevRow?.checkout_time,
                          parsed.data.checkin_time !== undefined ? parsed.data.checkin_time : prevRow?.checkin_time,
                        ),
                      }
                    : {}),
                  ...(parsed.data.old_code !== undefined ? { old_code: parsed.data.old_code ?? null } : {}),
                  ...(parsed.data.new_code !== undefined ? { new_code: parsed.data.new_code ?? null } : {}),
                  ...(parsed.data.guest_special_request !== undefined ? { guest_special_request: parsed.data.guest_special_request ?? null } : {}),
                  ...(parsed.data.keys_required !== undefined && nextKeysRequired != null ? { keys_required: mergedKeysRequired } : {}),
                  ...(parsed.data.keys_required !== undefined && nextKeysRequired != null ? { keys_required_checkout: checkoutSets || null } : {}),
                  ...(parsed.data.keys_required !== undefined && nextKeysRequired != null ? { keys_required_checkin: checkinSets || null } : {}),
                  ...(parsed.data.keys_required !== undefined && nextKeysRequired != null
                    ? {
                        key_tags: {
                          checkout_sets: checkoutSets || null,
                          checkin_sets: checkinSets || null,
                          show_checkout: checkoutSets >= 2,
                          show_checkin: checkinSets >= 2,
                        },
                      }
                    : {}),
                },
                causedByUserId: String(user?.sub || '').trim() || null,
                visibilityHints: buildCleaningTaskVisibilityHints(row),
              })
            }
          } catch {}
        }
        try {
          const { listCleaningTaskUserIdsBulk, listManagerUserIds } = require('./notifications')
          const fmt = (label: string, next: any, prev: any) => `${label}：${norm(next) || '-'}（原：${norm(prev) || '-'}）`
          const lines: string[] = []
          if (parsed.data.checkout_time !== undefined && !eqNorm(parsed.data.checkout_time, prevRow?.checkout_time)) lines.push(fmt('退房时间', parsed.data.checkout_time, prevRow?.checkout_time))
          if (parsed.data.checkin_time !== undefined && !eqNorm(parsed.data.checkin_time, prevRow?.checkin_time)) lines.push(fmt('入住时间', parsed.data.checkin_time, prevRow?.checkin_time))
          if (parsed.data.old_code !== undefined && !eqNorm(parsed.data.old_code, prevRow?.old_code)) lines.push(fmt('旧密码', parsed.data.old_code, prevRow?.old_code))
          if (parsed.data.new_code !== undefined && !eqNorm(parsed.data.new_code, prevRow?.new_code)) lines.push(fmt('新密码', parsed.data.new_code, prevRow?.new_code))
          if (parsed.data.guest_special_request !== undefined && !eqNorm(parsed.data.guest_special_request, prevRow?.guest_special_request)) lines.push(fmt('客人需求', parsed.data.guest_special_request, prevRow?.guest_special_request))
          if (parsed.data.keys_required !== undefined) {
            const nextK = parsed.data.keys_required == null ? 1 : Number(parsed.data.keys_required)
            if (Number.isFinite(nextK) && nextKeysRequired != null) {
              const prevLabel =
                prevKeysRequiredMin != null && prevKeysRequiredMax != null && prevKeysRequiredMin !== prevKeysRequiredMax
                  ? `${prevKeysRequiredMin}/${prevKeysRequiredMax}`
                  : (prevKeysRequiredMax != null ? String(prevKeysRequiredMax) : (prevRow?.keys_required == null ? '1' : String(prevRow.keys_required)))
              lines.push(fmt('需挂钥匙套数', nextKeysRequired, prevLabel))
            }
          }
          if (!lines.length) return
          const hashText = (s: string) => {
            let h = 0
            for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
            return String(h)
          }
          let afterRow: any = null
          try {
            const rAfter = await pool.query(
              `SELECT t.property_id::text AS property_id, t.checkout_time, t.checkin_time, t.old_code, t.new_code, t.guest_special_request,
                      CASE
                        WHEN t.order_id IS NULL THEN COALESCE(t.keys_required, 1)
                        ELSE COALESCE(o.keys_required, t.keys_required, 1)
                      END AS keys_required,
                      COALESCE(p_id.code, p_code.code, t.property_id::text) AS property_code
               FROM cleaning_tasks t
               LEFT JOIN orders o ON o.id::text = t.order_id::text
               LEFT JOIN properties p_id ON (p_id.id::text) = (t.property_id::text)
               LEFT JOIN properties p_code ON upper(p_code.code) = upper(t.property_id::text)
               WHERE t.id=$1 LIMIT 1`,
              [repId],
            )
            afterRow = rAfter?.rows?.[0] || null
            if (!propertyId) propertyId = String(afterRow?.property_id || '').trim()
            if (!propertyCode) propertyCode = String(afterRow?.property_code || '').trim()
          } catch {}
          const keyObj = {
            checkout_time: afterRow?.checkout_time == null ? null : String(afterRow.checkout_time),
            checkin_time: afterRow?.checkin_time == null ? null : String(afterRow.checkin_time),
            old_code: afterRow?.old_code == null ? null : String(afterRow.old_code),
            new_code: afterRow?.new_code == null ? null : String(afterRow.new_code),
            guest_special_request: afterRow?.guest_special_request == null ? null : String(afterRow.guest_special_request),
            keys_required: nextKeysRequired != null ? nextKeysRequired : (afterRow?.keys_required == null ? 1 : Number(afterRow.keys_required)),
          }
          const fieldsKey = hashText(JSON.stringify(keyObj))
          const to = Array.from(new Set([...(await listCleaningTaskUserIdsBulk(Array.from(affectedTaskIds))), ...(await listManagerUserIds())]))
          const changes: string[] = []
          if (parsed.data.checkout_time !== undefined && !eqNorm(parsed.data.checkout_time, prevRow?.checkout_time)) changes.push('time')
          if (parsed.data.checkin_time !== undefined && !eqNorm(parsed.data.checkin_time, prevRow?.checkin_time)) changes.push('time')
          if (parsed.data.old_code !== undefined && !eqNorm(parsed.data.old_code, prevRow?.old_code)) changes.push('password')
          if (parsed.data.new_code !== undefined && !eqNorm(parsed.data.new_code, prevRow?.new_code)) changes.push('password')
          if (parsed.data.guest_special_request !== undefined && !eqNorm(parsed.data.guest_special_request, prevRow?.guest_special_request)) changes.push('note')
          if (parsed.data.keys_required !== undefined && nextKeysRequired != null) changes.push('keys')
          const title = propertyCode ? `任务信息更新：${propertyCode}` : '任务信息更新'
          const body = lines.join('\n')
          const eventId = `manager_fields:${propertyCode || repId}:${fieldsKey}`
          const dedupeKey = nextKeysRequired != null
            ? `manager_fields:${propertyCode || repId}:keys_required:${nextKeysRequired}`
            : eventId
          const data = {
            entity: 'cleaning_task',
            entityId: String(repId),
            action: 'open_task',
            kind: 'cleaning_task_manager_fields_updated',
            task_ids: Array.from(affectedTaskIds),
            property_code: propertyCode,
            fields_key: fieldsKey,
            event_id: eventId,
            keys_required: nextKeysRequired,
            dedupe_key: dedupeKey,
          }
          if (propertyId && to.length) {
            const { emitNotificationEvent } = require('../services/notificationEvents')
            await emitNotificationEvent({
              type: 'CLEANING_TASK_UPDATED',
              entity: 'cleaning_task',
              entityId: String(repId),
              propertyId,
              eventId,
              updatedAt: new Date().toISOString(),
              changes,
              title,
              body,
              data,
              actorUserId: String(user?.sub || ''),
              recipientUserIds: to,
            })
          }
        } catch {}
      })().catch(() => {})
    })
    return res.status(201).json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'manager_fields_failed' })
  }
}

router.patch('/cleaning-tasks/manager-fields', handleManagerFields)
router.post('/cleaning-tasks/manager-fields', handleManagerFields)

const guestLuggageUpsertSchema = z
  .object({
    task_ids: z.array(z.string().trim().min(1)).min(1).max(50),
    note: z.string().trim().max(1500).optional().nullable(),
    photo_urls: z.array(z.string().trim().min(1).max(1200)).max(3).default([]),
  })
  .strict()

router.post('/cleaning-tasks/guest-luggage', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  if (!canEditGuestLuggage(user)) return res.status(403).json({ message: 'forbidden' })
  const parsed = guestLuggageUpsertSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  if (!hasPg || !pgPool) return res.status(500).json({ message: 'pg not available' })
  const actorUserId = String(user.sub || '').trim()
  try {
    await ensureGuestLuggageTables()
    const scope = await resolveGuestLuggageTaskScope(parsed.data.task_ids)
    if (scope.taskDate !== melbourneToday()) return res.status(400).json({ message: '只能编辑当天任务的临时通知' })
    const nextNote = String(parsed.data.note || '').trim() || null
    const nextPhotos = Array.from(new Set(parsed.data.photo_urls.map((url) => String(url || '').trim()).filter(Boolean)))
    if (!nextNote && !nextPhotos.length) return res.status(400).json({ message: '请填写临时通知内容或上传照片' })
    if (nextPhotos.length > 3) return res.status(400).json({ message: '临时通知照片最多 3 张' })

    const result = await pgRunInTransaction(async (client: any) => {
      const existingResult = await client.query(
        `SELECT id, note, photo_urls, version
         FROM guest_luggage_notices
         WHERE property_id = $1 AND task_date = $2::date
         FOR UPDATE`,
        [scope.propertyId, scope.taskDate],
      )
      const existing = existingResult?.rows?.[0] || null
      const mutation = planGuestLuggageMutation(
        existing,
        { note: nextNote, photoUrls: nextPhotos },
        normalizeStoredPhotoUrls,
      )
      if (!mutation.changed) {
        return {
          changed: false,
          notice: await loadGuestLuggageNotice(String(existing.id || ''), actorUserId, client),
        }
      }
      const id = existing ? String(existing.id || '') : require('uuid').v4()
      const version = mutation.version
      if (existing) {
        await client.query(
          `UPDATE guest_luggage_notices
           SET note = $1, photo_urls = $2::jsonb, version = $3, updated_by = $4, updated_at = now()
           WHERE id = $5`,
          [nextNote, JSON.stringify(nextPhotos), version, actorUserId || null, id],
        )
        if (mutation.resetAcknowledgements) {
          await client.query(`DELETE FROM guest_luggage_acknowledgements WHERE notice_id = $1`, [id])
        }
      } else {
        await client.query(
          `INSERT INTO guest_luggage_notices
             (id, property_id, task_date, note, photo_urls, version, created_by, updated_by)
           VALUES ($1, $2, $3::date, $4, $5::jsonb, 1, $6, $6)`,
          [id, scope.propertyId, scope.taskDate, nextNote, JSON.stringify(nextPhotos), actorUserId || null],
        )
      }
      return {
        changed: true,
        notice: await loadGuestLuggageNotice(id, actorUserId, client),
      }
    })
    const notice = result?.notice || null
    if (!notice) return res.status(500).json({ message: 'guest luggage save failed' })
    if (result?.changed) {
      try {
        await emitGuestLuggageTaskEvents({
          taskRows: scope.rows,
          taskIds: scope.taskIds,
          patch: notice,
          actorUserId,
        })
      } catch {}
      try {
        const recipients = await listGuestLuggageRecipients(scope.propertyId, scope.taskDate)
        await emitNotificationEvent({
          type: 'GUEST_LUGGAGE_UPDATED',
          entity: 'cleaning_task',
          entityId: scope.taskIds[0],
          eventId: `guest_luggage:${notice.id}:v${notice.version}`,
          updatedAt: notice.updated_at || new Date().toISOString(),
          changes: ['guest_luggage'],
          priority: 'high',
          title: `当天任务临时通知${scope.propertyCode ? `：${scope.propertyCode}` : ''}`,
          body: [
            notice.note || '请查看说明或照片，并按通知内容处理。',
            notice.photo_urls.length ? `照片：${notice.photo_urls.length} 张` : '',
          ].filter(Boolean).join('\n'),
          data: {
            entity: 'cleaning_task',
            entityId: scope.taskIds[0],
            action: 'open_task',
            kind: 'guest_luggage_updated',
            task_ids: scope.taskIds,
            property_code: scope.propertyCode || undefined,
            guest_luggage_id: notice.id,
            guest_luggage_version: notice.version,
            photo_url: notice.photo_urls[0] || null,
            photo_urls: notice.photo_urls,
          },
          actorUserId,
          recipientUserIds: recipients,
        })
      } catch {}
    }
    return res.status(result?.changed ? 201 : 200).json({ ok: true, changed: !!result?.changed, guest_luggage: notice })
  } catch (e: any) {
    const message = String(e?.message || 'guest_luggage_save_failed')
    if (message === 'invalid task ids' || message === 'tasks must belong to the same property and date' || message === 'missing task ids') {
      return res.status(400).json({ message })
    }
    return res.status(500).json({ message })
  }
})

router.delete('/cleaning-tasks/guest-luggage/:id', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  if (!canEditGuestLuggage(user)) return res.status(403).json({ message: 'forbidden' })
  if (!hasPg || !pgPool) return res.status(500).json({ message: 'pg not available' })
  const noticeId = String(req.params.id || '').trim()
  const actorUserId = String(user.sub || '').trim()
  if (!noticeId) return res.status(400).json({ message: 'missing id' })
  try {
    await ensureGuestLuggageTables()
    const found = await pgPool.query(
      `SELECT id, property_id::text AS property_id, task_date::text AS task_date, version
       FROM guest_luggage_notices WHERE id = $1 LIMIT 1`,
      [noticeId],
    )
    const notice = found?.rows?.[0] || null
    if (!notice) return res.status(404).json({ message: 'guest luggage notice not found' })
    const taskResult = await pgPool.query(
      `SELECT t.id::text AS id, t.assignee_id::text AS assignee_id, t.cleaner_id::text AS cleaner_id,
              t.inspector_id::text AS inspector_id, lower(COALESCE(t.task_type, '')) AS task_type,
              COALESCE(p_id.code::text, p_code.code::text, t.property_id::text) AS property_code
       FROM cleaning_tasks t
       LEFT JOIN properties p_id ON p_id.id::text = t.property_id::text
       LEFT JOIN properties p_code ON upper(p_code.code) = upper(t.property_id::text)
       WHERE COALESCE(p_id.id::text, p_code.id::text, t.property_id::text) = $1
         AND COALESCE(t.task_date, t.date)::date = $2::date
         AND COALESCE(t.status, '') <> 'cancelled'`,
      [String(notice.property_id || ''), String(notice.task_date || '').slice(0, 10)],
    )
    const taskRows = taskResult?.rows || []
    const taskIds = taskRows.map((row: any) => String(row.id || '')).filter(Boolean)
    const propertyCode = String(taskRows?.[0]?.property_code || '').trim()
    const recipients = await listGuestLuggageRecipients(String(notice.property_id || ''), String(notice.task_date || '').slice(0, 10))
    await pgPool.query(`DELETE FROM guest_luggage_notices WHERE id = $1`, [noticeId])
    try {
      await emitGuestLuggageTaskEvents({ taskRows, taskIds, patch: null, actorUserId })
    } catch {}
    if (taskIds.length) {
      try {
        await emitNotificationEvent({
          type: 'GUEST_LUGGAGE_UPDATED',
          entity: 'cleaning_task',
          entityId: taskIds[0],
          eventId: `guest_luggage:${noticeId}:deleted:v${Number(notice.version || 1)}`,
          changes: ['guest_luggage'],
          priority: 'high',
          title: `当天任务临时通知已移除${propertyCode ? `：${propertyCode}` : ''}`,
          body: '当天任务中的临时通知已移除。',
          data: {
            entity: 'cleaning_task',
            entityId: taskIds[0],
            action: 'open_task',
            kind: 'guest_luggage_deleted',
            task_ids: taskIds,
            property_code: propertyCode || undefined,
            guest_luggage_id: noticeId,
          },
          actorUserId,
          recipientUserIds: recipients,
        })
      } catch {}
    }
    return res.json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: String(e?.message || 'guest_luggage_delete_failed') })
  }
})

router.post('/cleaning-tasks/guest-luggage/:id/ack', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  if (!hasPg || !pgPool) return res.status(500).json({ message: 'pg not available' })
  const noticeId = String(req.params.id || '').trim()
  const userId = String(user.sub || '').trim()
  if (!noticeId || !userId) return res.status(400).json({ message: 'missing id' })
  try {
    await ensureGuestLuggageTables()
    const noticeResult = await pgPool.query(
      `SELECT id, property_id::text AS property_id, task_date::text AS task_date, version
       FROM guest_luggage_notices WHERE id = $1 LIMIT 1`,
      [noticeId],
    )
    const noticeRow = noticeResult?.rows?.[0] || null
    if (!noticeRow) return res.status(404).json({ message: 'guest luggage notice not found' })
    const assigned = await pgPool.query(
      `SELECT t.id::text AS id, t.assignee_id::text AS assignee_id, t.cleaner_id::text AS cleaner_id,
              t.inspector_id::text AS inspector_id, lower(COALESCE(t.task_type, '')) AS task_type
       FROM cleaning_tasks t
       LEFT JOIN properties p_id ON p_id.id::text = t.property_id::text
       LEFT JOIN properties p_code ON upper(p_code.code) = upper(t.property_id::text)
       WHERE COALESCE(p_id.id::text, p_code.id::text, t.property_id::text) = $1
         AND COALESCE(t.task_date, t.date)::date = $2::date
         AND COALESCE(t.status, '') <> 'cancelled'
         AND ($3 = COALESCE(t.cleaner_id::text, t.assignee_id::text) OR $3 = t.inspector_id::text)`,
      [String(noticeRow.property_id || ''), String(noticeRow.task_date || '').slice(0, 10), userId],
    )
    if (!assigned?.rowCount) return res.status(403).json({ message: 'forbidden' })
    await pgPool.query(
      `INSERT INTO guest_luggage_acknowledgements (notice_id, user_id, notice_version, acknowledged_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (notice_id, user_id)
       DO UPDATE SET notice_version = EXCLUDED.notice_version, acknowledged_at = now()`,
      [noticeId, userId, Number(noticeRow.version || 1)],
    )
    const guestLuggage = await loadGuestLuggageNotice(noticeId, userId)
    const allTasks = await pgPool.query(
      `SELECT t.id::text AS id, t.assignee_id::text AS assignee_id, t.cleaner_id::text AS cleaner_id,
              t.inspector_id::text AS inspector_id, lower(COALESCE(t.task_type, '')) AS task_type
       FROM cleaning_tasks t
       LEFT JOIN properties p_id ON p_id.id::text = t.property_id::text
       LEFT JOIN properties p_code ON upper(p_code.code) = upper(t.property_id::text)
       WHERE COALESCE(p_id.id::text, p_code.id::text, t.property_id::text) = $1
         AND COALESCE(t.task_date, t.date)::date = $2::date
         AND COALESCE(t.status, '') <> 'cancelled'`,
      [String(noticeRow.property_id || ''), String(noticeRow.task_date || '').slice(0, 10)],
    )
    const taskRows = allTasks?.rows || []
    try {
      await emitGuestLuggageTaskEvents({
        taskRows,
        taskIds: taskRows.map((row: any) => String(row.id || '')).filter(Boolean),
        actorUserId: userId,
      })
    } catch {}
    return res.json({ ok: true, guest_luggage: guestLuggage })
  } catch (e: any) {
    return res.status(500).json({ message: String(e?.message || 'guest_luggage_ack_failed') })
  }
})

router.get('/checklist-items', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  try {
    if (!hasPg || !pgPool) return res.json([])
    await ensureCleaningChecklistTables()
    const r = await pgPool.query(
      `SELECT id, label, kind, required, requires_photo_when_low, active, sort_order
       FROM cleaning_checklist_items
       WHERE active = true
       ORDER BY sort_order ASC NULLS LAST, created_at ASC`,
    )
    return res.json((r?.rows || []).map((x: any) => ({
      id: String(x.id),
      label: String(x.label || ''),
      kind: String(x.kind || 'consumable'),
      required: !!x.required,
      requires_photo_when_low: !!x.requires_photo_when_low,
    })))
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'checklist_failed' })
  }
})

router.post('/checklist-items', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  const role = String(user.role || '')
  if (role !== 'admin') return res.status(403).json({ message: 'forbidden' })
  const id = String(req.body?.id || '').trim()
  const label = String(req.body?.label || '').trim()
  const kind = String(req.body?.kind || 'consumable').trim()
  const required = req.body?.required === undefined ? true : !!req.body.required
  const requiresPhoto = req.body?.requires_photo_when_low === undefined ? true : !!req.body.requires_photo_when_low
  const sortOrder = req.body?.sort_order === undefined || req.body?.sort_order === null ? null : Number(req.body.sort_order)
  if (!id || !/^[a-z0-9_]{2,64}$/i.test(id)) return res.status(400).json({ message: 'invalid id' })
  if (!label) return res.status(400).json({ message: 'missing label' })
  if (!hasPg || !pgPool) return res.status(500).json({ message: 'pg not available' })
  try {
    await ensureCleaningChecklistTables()
    await pgPool.query(
      `INSERT INTO cleaning_checklist_items (id, label, kind, required, requires_photo_when_low, active, sort_order, created_by)
       VALUES ($1,$2,$3,$4,$5,true,$6,$7)
       ON CONFLICT (id) DO UPDATE SET label=EXCLUDED.label, kind=EXCLUDED.kind, required=EXCLUDED.required, requires_photo_when_low=EXCLUDED.requires_photo_when_low, sort_order=EXCLUDED.sort_order, active=true, updated_at=now()`,
      [id, label, kind, required, requiresPhoto, Number.isFinite(sortOrder as any) ? sortOrder : null, String(user.sub || '')],
    )
    return res.status(201).json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'checklist_upsert_failed' })
  }
})

router.patch('/checklist-items/:id', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  const role = String(user.role || '')
  if (role !== 'admin') return res.status(403).json({ message: 'forbidden' })
  const id = String(req.params.id || '').trim()
  if (!id) return res.status(400).json({ message: 'missing id' })
  if (!hasPg || !pgPool) return res.status(500).json({ message: 'pg not available' })
  try {
    await ensureCleaningChecklistTables()
    const fields: string[] = []
    const vals: any[] = []
    const setField = (k: string, v: any) => {
      vals.push(v)
      fields.push(`${k} = $${vals.length}`)
    }
    if (req.body?.label !== undefined) setField('label', String(req.body.label || '').trim())
    if (req.body?.kind !== undefined) setField('kind', String(req.body.kind || 'consumable').trim())
    if (req.body?.required !== undefined) setField('required', !!req.body.required)
    if (req.body?.requires_photo_when_low !== undefined) setField('requires_photo_when_low', !!req.body.requires_photo_when_low)
    if (req.body?.active !== undefined) setField('active', !!req.body.active)
    if (req.body?.sort_order !== undefined) setField('sort_order', req.body.sort_order === null ? null : Number(req.body.sort_order))
    if (!fields.length) return res.json({ ok: true })
    fields.push(`updated_at = now()`)
    vals.push(id)
    const sql = `UPDATE cleaning_checklist_items SET ${fields.join(', ')} WHERE id = $${vals.length}`
    await pgPool.query(sql, vals)
    return res.json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'checklist_patch_failed' })
  }
})

router.get('/expenses/bootstrap', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  try {
    const permissions = await listPermissionCodesForUser(user)
    const scopes = await listMzappScopesForUser(user)
    if (!scopes.length) return res.status(403).json({ message: 'forbidden' })
    const properties = scopes.includes('property') ? await listActivePropertiesForMzapp() : []
    return res.json({
      permissions,
      scopes,
      categories: {
        company: COMPANY_EXPENSE_CATEGORIES,
        property: PROPERTY_EXPENSE_CATEGORIES,
      },
      properties,
    })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'bootstrap_failed' })
  }
})

router.post('/expenses/receipts/upload', upload.single('file'), async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  if (!req.file) return res.status(400).json({ message: 'missing file' })
  try {
    const allowed = await userHasAnyPerm(user, [
      mzappExpensePermission('company', 'submit'),
      mzappExpensePermission('company', 'edit.self'),
      mzappExpensePermission('property', 'submit'),
      mzappExpensePermission('property', 'edit.self'),
    ])
    if (!allowed) return res.status(403).json({ message: 'forbidden' })
    const url = await mzappUploadExpenseReceipt(req.file as Express.Multer.File)
    return res.status(201).json({ url })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'upload_failed' })
  }
})

router.post('/expenses/ocr', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  const parsed = mzappExpenseOcrSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json({ message: 'invalid payload' })
  try {
    const allowed = await userHasAnyPerm(user, [
      mzappExpensePermission(parsed.data.scope, 'submit'),
      mzappExpensePermission(parsed.data.scope, 'edit.self'),
    ])
    if (!allowed) return res.status(403).json({ message: 'forbidden' })
    const result = await ocrExpenseReceipt(parsed.data.receipt_url)
    return res.json(result)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'ocr_failed' })
  }
})

router.post('/expenses', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  const parsed = mzappExpenseCreateSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json({ message: 'invalid payload' })
  const body = parsed.data
  const scope = body.scope as MzappExpenseScope
  try {
    if (!(await mzappUserHasScopePerm(user, scope, 'submit'))) return res.status(403).json({ message: 'forbidden' })
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'pg not available' })
    await ensureMzappExpenseSchema()
    await ensureMzappExpenseInvoicesTable()
    const occurredAt = dayOnly(body.occurred_at)
    if (!occurredAt) return res.status(400).json({ message: 'invalid occurred_at' })
    const receiptUrls = normalizeExpenseReceiptUrls(body.receipt_urls)
    if (scope === 'company' && body.property_id) return res.status(400).json({ message: 'property_id_not_allowed' })
    if (scope === 'property' && !String(body.property_id || '').trim()) return res.status(400).json({ message: 'missing property_id' })
    if (scope === 'property' && !(await mzappPropertyExists(String(body.property_id || '').trim()))) return res.status(400).json({ message: 'invalid property_id' })
    const allowedCategories = new Set((scope === 'company' ? COMPANY_EXPENSE_CATEGORIES : PROPERTY_EXPENSE_CATEGORIES).map((item) => item.value))
    if (!allowedCategories.has(String(body.category || '').trim())) return res.status(400).json({ message: 'invalid category' })
    if (String(body.category || '').trim() === 'other' && !String(body.category_detail || '').trim()) return res.status(400).json({ message: 'missing category_detail' })
    const id = crypto.randomUUID()
    const monthKey = occurredAt.slice(0, 7)
    const table = scope === 'property' ? 'property_expenses' : 'company_expenses'
    const payload: any = {
      id,
      occurred_at: occurredAt,
      due_date: occurredAt,
      paid_date: occurredAt,
      month_key: monthKey,
      amount: Number(Number(body.amount || 0).toFixed(2)),
      currency: 'AUD',
      category: String(body.category || '').trim(),
      category_detail: String(body.category || '').trim() === 'other' ? String(body.category_detail || '').trim() : (String(body.category_detail || '').trim() || null),
      expense_name: String(body.expense_name || '').trim() || null,
      note: String(body.note || '').trim() || null,
      invoice_url: receiptUrls[0] || null,
      created_by: String(user.sub || user.username || 'mzapp'),
      generated_from: 'mzapp',
      deleted_at: null,
      deleted_by: null,
      delete_source: null,
    }
    if (scope === 'property') payload.property_id = String(body.property_id || '').trim()
    const keys = Object.keys(payload)
    const vals = keys.map((key) => payload[key])
    const sql = `INSERT INTO ${table} (${keys.map((key) => `"${key}"`).join(', ')}) VALUES (${vals.map((_, idx) => `$${idx + 1}`).join(', ')}) RETURNING *`
    const inserted = await pgPool.query(sql, vals)
    await syncExpenseReceipts(scope, id, receiptUrls, user)
    const row = inserted?.rows?.[0] || { ...payload }
    try { const { addAudit } = require('../store'); addAudit(table, id, 'create', null, row, String(user.sub || user.username || 'mzapp')) } catch {}
    return res.status(201).json({ ...row, scope, receipts: await listExpenseReceipts(scope, id) })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'create_failed' })
  }
})

router.get('/expenses/mine', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  try {
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'pg not available' })
    await ensureMzappExpenseSchema()
    const scopeRaw = String((req.query as any)?.scope || '').trim()
    const allowedScopes = await listMzappScopesForUser(user)
    const scopes = (scopeRaw === 'company' || scopeRaw === 'property') ? [scopeRaw as MzappExpenseScope].filter((item) => allowedScopes.includes(item)) : allowedScopes
    if (!scopes.length) return res.status(403).json({ message: 'forbidden' })
    const limit = Math.max(1, Math.min(100, Number((req.query as any)?.limit || 50) || 50))
    const offset = Math.max(0, Number((req.query as any)?.offset || 0) || 0)
    const out: any[] = []
    for (const scope of scopes) {
      if (!(await mzappUserHasScopePerm(user, scope, 'view.self'))) continue
      const table = scope === 'property' ? 'property_expenses' : 'company_expenses'
      const cols = scope === 'property'
        ? `e.id, e.property_id, p.code AS property_code, p.address AS property_address, p.region AS property_region, e.occurred_at, e.amount, e.currency, e.category, e.category_detail, e.expense_name, e.note, e.invoice_url, e.created_at, e.created_by`
        : `e.id, null::text AS property_id, null::text AS property_code, null::text AS property_address, null::text AS property_region, e.occurred_at, e.amount, e.currency, e.category, e.category_detail, e.expense_name, e.note, e.invoice_url, e.created_at, e.created_by`
      const join = scope === 'property' ? ' LEFT JOIN properties p ON p.id = e.property_id' : ''
      const r = await pgPool.query(
        `SELECT ${cols}
           FROM ${table} e${join}
          WHERE e.created_by = $1
            AND COALESCE(e.generated_from, '') = 'mzapp'
            AND e.deleted_at IS NULL
          ORDER BY e.created_at DESC NULLS LAST, e.occurred_at DESC NULLS LAST, e.id DESC`,
        [String(user.sub || user.username || '')],
      )
      out.push(...(r?.rows || []).map((row: any) => ({ ...row, scope })))
    }
    out.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')) || String(b.occurred_at || '').localeCompare(String(a.occurred_at || '')))
    return res.json({ items: out.slice(offset, offset + limit), total: out.length })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'list_failed' })
  }
})

router.get('/expenses/mine/:scope/:id', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  const scope = String(req.params.scope || '').trim() === 'company' ? 'company' : String(req.params.scope || '').trim() === 'property' ? 'property' : ''
  const id = String(req.params.id || '').trim()
  if (!scope || !id) return res.status(400).json({ message: 'invalid scope or id' })
  try {
    if (!(await mzappUserHasScopePerm(user, scope as MzappExpenseScope, 'view.self'))) return res.status(403).json({ message: 'forbidden' })
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'pg not available' })
    await ensureMzappExpenseSchema()
    const table = scope === 'property' ? 'property_expenses' : 'company_expenses'
    const join = scope === 'property' ? ' LEFT JOIN properties p ON p.id = e.property_id' : ''
    const cols = scope === 'property'
      ? `e.*, p.code AS property_code, p.address AS property_address, p.region AS property_region`
      : 'e.*'
    const r = await pgPool.query(
      `SELECT ${cols}
         FROM ${table} e${join}
        WHERE e.id = $1
          AND e.created_by = $2
          AND COALESCE(e.generated_from, '') = 'mzapp'
          AND e.deleted_at IS NULL
        LIMIT 1`,
      [id, String(user.sub || user.username || '')],
    )
    const row = r?.rows?.[0]
    if (!row) return res.status(404).json({ message: 'not_found' })
    return res.json({ ...row, scope, receipts: await listExpenseReceipts(scope as MzappExpenseScope, id) })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'detail_failed' })
  }
})

router.patch('/expenses/mine/:scope/:id', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  const scope = String(req.params.scope || '').trim() === 'company' ? 'company' : String(req.params.scope || '').trim() === 'property' ? 'property' : ''
  const id = String(req.params.id || '').trim()
  if (!scope || !id) return res.status(400).json({ message: 'invalid scope or id' })
  const parsed = mzappExpenseUpdateSchema.safeParse({ ...(req.body || {}), scope })
  if (!parsed.success) return res.status(400).json({ message: 'invalid payload' })
  try {
    if (!(await mzappUserHasScopePerm(user, scope as MzappExpenseScope, 'edit.self'))) return res.status(403).json({ message: 'forbidden' })
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'pg not available' })
    await ensureMzappExpenseSchema()
    const table = scope === 'property' ? 'property_expenses' : 'company_expenses'
    const beforeR = await pgPool.query(
      `SELECT * FROM ${table}
        WHERE id = $1
          AND created_by = $2
          AND COALESCE(generated_from, '') = 'mzapp'
          AND deleted_at IS NULL
        LIMIT 1`,
      [id, String(user.sub || user.username || '')],
    )
    const before = beforeR?.rows?.[0]
    if (!before) return res.status(404).json({ message: 'not_found' })
    const body = parsed.data
    const patch: Record<string, any> = {}
    if (body.occurred_at !== undefined) {
      const occurredAt = dayOnly(body.occurred_at)
      if (!occurredAt) return res.status(400).json({ message: 'invalid occurred_at' })
      patch.occurred_at = occurredAt
      patch.due_date = occurredAt
      patch.paid_date = occurredAt
      patch.month_key = occurredAt.slice(0, 7)
    }
    if (body.amount !== undefined) patch.amount = Number(Number(body.amount || 0).toFixed(2))
    if (body.category !== undefined) patch.category = String(body.category || '').trim()
    const category = String((patch.category ?? before.category ?? '') || '').trim()
    if (category) {
      const allowedCategories = new Set(((scope === 'company' ? COMPANY_EXPENSE_CATEGORIES : PROPERTY_EXPENSE_CATEGORIES)).map((item) => item.value))
      if (!allowedCategories.has(category)) return res.status(400).json({ message: 'invalid category' })
      if (category === 'other') {
        const detail = body.category_detail !== undefined ? String(body.category_detail || '').trim() : String(before.category_detail || '').trim()
        if (!detail) return res.status(400).json({ message: 'missing category_detail' })
        patch.category_detail = detail
      } else if (body.category_detail !== undefined) {
        patch.category_detail = String(body.category_detail || '').trim() || null
      }
    }
    if (scope === 'property' && body.property_id !== undefined) {
      if (!String(body.property_id || '').trim()) return res.status(400).json({ message: 'missing property_id' })
      if (!(await mzappPropertyExists(String(body.property_id || '').trim()))) return res.status(400).json({ message: 'invalid property_id' })
      patch.property_id = String(body.property_id || '').trim()
    }
    if (scope === 'company' && body.property_id !== undefined && String(body.property_id || '').trim()) return res.status(400).json({ message: 'property_id_not_allowed' })
    if (body.expense_name !== undefined) patch.expense_name = String(body.expense_name || '').trim() || null
    if (body.note !== undefined) patch.note = String(body.note || '').trim() || null
    const receiptUrls = body.receipt_urls !== undefined ? normalizeExpenseReceiptUrls(body.receipt_urls) : await listExpenseReceipts(scope as MzappExpenseScope, id).then((rows) => rows.map((row: any) => String(row?.url || '').trim()).filter(Boolean))
    patch.invoice_url = receiptUrls[0] || null
    const keys = Object.keys(patch)
    if (!keys.length && body.receipt_urls === undefined) return res.json({ ...before, scope, receipts: await listExpenseReceipts(scope as MzappExpenseScope, id) })
    const values = keys.map((key) => patch[key])
    if (keys.length) {
      await pgPool.query(
        `UPDATE ${table}
            SET ${keys.map((key, idx) => `"${key}" = $${idx + 1}`).join(', ')}
          WHERE id = $${keys.length + 1}`,
        [...values, id],
      )
    }
    await syncExpenseReceipts(scope as MzappExpenseScope, id, receiptUrls, user)
    const afterR = await pgPool.query(`SELECT * FROM ${table} WHERE id = $1 LIMIT 1`, [id])
    const after = afterR?.rows?.[0] || { ...before, ...patch }
    try { const { addAudit } = require('../store'); addAudit(table, id, 'update', before, after, String(user.sub || user.username || 'mzapp')) } catch {}
    return res.json({ ...after, scope, receipts: await listExpenseReceipts(scope as MzappExpenseScope, id) })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'update_failed' })
  }
})

router.delete('/expenses/mine/:scope/:id', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  const scope = String(req.params.scope || '').trim() === 'company' ? 'company' : String(req.params.scope || '').trim() === 'property' ? 'property' : ''
  const id = String(req.params.id || '').trim()
  if (!scope || !id) return res.status(400).json({ message: 'invalid scope or id' })
  try {
    if (!(await mzappUserHasScopePerm(user, scope as MzappExpenseScope, 'delete.self'))) return res.status(403).json({ message: 'forbidden' })
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'pg not available' })
    await ensureMzappExpenseSchema()
    const table = scope === 'property' ? 'property_expenses' : 'company_expenses'
    const beforeR = await pgPool.query(
      `SELECT * FROM ${table}
        WHERE id = $1
          AND created_by = $2
          AND COALESCE(generated_from, '') = 'mzapp'
          AND deleted_at IS NULL
        LIMIT 1`,
      [id, String(user.sub || user.username || '')],
    )
    const before = beforeR?.rows?.[0]
    if (!before) return res.status(404).json({ message: 'not_found' })
    const now = new Date().toISOString()
    await pgPool.query(
      `UPDATE ${table}
          SET deleted_at = $2,
              deleted_by = $3,
              delete_source = 'mzapp'
        WHERE id = $1`,
      [id, now, String(user.sub || user.username || 'mzapp')],
    )
    const after = { ...before, deleted_at: now, deleted_by: String(user.sub || user.username || 'mzapp'), delete_source: 'mzapp' }
    try { const { addAudit } = require('../store'); addAudit(table, id, 'delete', before, after, String(user.sub || user.username || 'mzapp')) } catch {}
    return res.json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'delete_failed' })
  }
})

router.get('/expense-receipts/bootstrap', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  try {
    const permissions = await listPermissionCodesForUser(user)
    const scopes = await listMzappScopesForUser(user)
    if (!scopes.length) return res.status(403).json({ message: 'forbidden' })
    const properties = scopes.includes('property') ? await listActivePropertiesForMzapp() : []
    return res.json({
      permissions,
      scopes,
      categories: {
        company: COMPANY_EXPENSE_CATEGORIES,
        property: PROPERTY_EXPENSE_CATEGORIES,
      },
      properties,
    })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'bootstrap_failed' })
  }
})

router.post('/expense-receipts/images/upload', upload.single('file'), async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  if (!req.file) return res.status(400).json({ message: 'missing file' })
  try {
    const allowed = await userHasAnyPerm(user, [
      mzappExpensePermission('company', 'submit'),
      mzappExpensePermission('company', 'edit.self'),
      mzappExpensePermission('property', 'submit'),
      mzappExpensePermission('property', 'edit.self'),
    ])
    if (!allowed) return res.status(403).json({ message: 'forbidden' })
    const url = await mzappUploadExpenseReceipt(req.file as Express.Multer.File)
    return res.status(201).json({ url })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'upload_failed' })
  }
})

router.post('/expense-receipts', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  const parsed = mzappExpenseReceiptCreateSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json({ message: 'invalid payload' })
  if (!hasPg || !pgPool) return res.status(500).json({ message: 'pg not available' })
  try {
    await ensureMzappExpenseReceiptSchema()
    const normalized = await assertValidReceiptPayload(user, parsed.data, 'submit')
    const client = await pgPool.connect()
    try {
      await client.query('BEGIN')
      const receiptId = crypto.randomUUID()
      await client.query(
        `INSERT INTO expense_receipts (id, receipt_date, receipt_total_amount, currency, note, created_by, generated_from)
         VALUES ($1, $2, $3, 'AUD', $4, $5, 'mzapp')`,
        [receiptId, normalized.receipt_date, normalized.receipt_total_amount, normalized.note, mzappActorId(user)],
      )
      await replaceReceiptImages(client, receiptId, normalized.receipt_urls, user)
      for (const item of normalized.items) {
        const itemId = await upsertReceiptItemRow(client, receiptId, item)
        await upsertGeneratedExpenseFromReceiptItem(client, { id: receiptId, receipt_date: normalized.receipt_date, note: normalized.note }, { ...item, id: itemId }, normalized.receipt_urls, user)
      }
      await client.query('COMMIT')
      const detail = await buildReceiptDetail(receiptId, pgPool)
      try { const { addAudit } = require('../store'); addAudit('expense_receipts', receiptId, 'create', null, detail, mzappActorId(user)) } catch {}
      return res.status(201).json(detail)
    } catch (e) {
      try { await client.query('ROLLBACK') } catch {}
      throw e
    } finally {
      client.release()
    }
  } catch (e: any) {
    const msg = String(e?.message || 'create_failed')
    if (['invalid receipt_date','missing receipt_urls','missing items','invalid receipt_total_amount','items_total_mismatch','missing expense_name','invalid item amount','missing property_id','invalid property_id','property_id_not_allowed','invalid category','missing category_detail','forbidden'].includes(msg)) {
      return res.status(msg === 'forbidden' ? 403 : 400).json({ message: msg })
    }
    return res.status(500).json({ message: msg || 'create_failed' })
  }
})

router.get('/expense-receipts/mine', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  if (!hasPg || !pgPool) return res.status(500).json({ message: 'pg not available' })
  try {
    await ensureMzappExpenseReceiptSchema()
    await backfillLegacyMzappExpensesToReceiptsForUser(user, pgPool)
    const canViewCompany = await mzappUserHasScopePerm(user, 'company', 'view.self')
    const canViewProperty = await mzappUserHasScopePerm(user, 'property', 'view.self')
    if (!canViewCompany && !canViewProperty) return res.status(403).json({ message: 'forbidden' })
    const limit = Math.max(1, Math.min(100, Number((req.query as any)?.limit || 50) || 50))
    const offset = Math.max(0, Number((req.query as any)?.offset || 0) || 0)
    const rows = await pgPool.query(
      `WITH item_summary AS (
         SELECT receipt_id,
                count(*)::int AS item_count,
                bool_or(scope = 'company') AS has_company,
                bool_or(scope = 'property') AS has_property,
                CASE
                  WHEN bool_or(scope = 'company') AND bool_or(scope = 'property') THEN '混合支出'
                  WHEN bool_or(scope = 'property') THEN '房源支出'
                  WHEN bool_or(scope = 'company') THEN '公司支出'
                  ELSE '未分配'
                END AS scope_summary
           FROM expense_receipt_items
          GROUP BY receipt_id
       ),
       first_image AS (
         SELECT DISTINCT ON (receipt_id) receipt_id, url AS first_image_url
           FROM expense_receipt_images
          ORDER BY receipt_id, sort_index ASC, created_at ASC NULLS LAST, id ASC
       )
       SELECT r.*,
              COALESCE(s.item_count, 0) AS item_count,
              COALESCE(s.scope_summary, '未分配') AS scope_summary,
              f.first_image_url
         FROM expense_receipts
         r
         LEFT JOIN item_summary s ON s.receipt_id = r.id
         LEFT JOIN first_image f ON f.receipt_id = r.id
        WHERE r.created_by = $1
          AND COALESCE(r.generated_from, '') = 'mzapp'
          AND r.deleted_at IS NULL
          AND ($2::boolean OR COALESCE(s.has_company, false) = false)
          AND ($3::boolean OR COALESCE(s.has_property, false) = false)
        ORDER BY r.created_at DESC NULLS LAST, r.id DESC`,
      [mzappActorId(user), canViewCompany, canViewProperty],
    )
    const items = (rows?.rows || []).map((row: any) => ({
      ...row,
      receipt_total_amount: roundMoney(row?.receipt_total_amount || 0),
      item_count: Number(row?.item_count || 0),
      scope_summary: String(row?.scope_summary || '未分配'),
      first_image_url: String(row?.first_image_url || '').trim() || null,
    }))
    return res.json({ items: items.slice(offset, offset + limit), total: items.length })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'list_failed' })
  }
})

router.get('/expense-receipts/mine/:id', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  const id = String(req.params.id || '').trim()
  if (!id) return res.status(400).json({ message: 'invalid id' })
  if (!hasPg || !pgPool) return res.status(500).json({ message: 'pg not available' })
  try {
    await ensureMzappExpenseReceiptSchema()
    await backfillLegacyMzappExpensesToReceiptsForUser(user, pgPool)
    const detail = await buildReceiptDetail(id, pgPool)
    if (!detail) return res.status(404).json({ message: 'not_found' })
    if (String(detail.created_by || '') !== mzappActorId(user) || String(detail.generated_from || '') !== 'mzapp') return res.status(404).json({ message: 'not_found' })
    const scopes = Array.from(new Set((detail.items || []).map((item: any) => String(item?.scope || '').trim()).filter(Boolean))) as MzappExpenseScope[]
    for (const scope of scopes) {
      if (!(await mzappUserHasScopePerm(user, scope, 'view.self'))) return res.status(403).json({ message: 'forbidden' })
    }
    return res.json(detail)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'detail_failed' })
  }
})

router.patch('/expense-receipts/mine/:id', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  const id = String(req.params.id || '').trim()
  if (!id) return res.status(400).json({ message: 'invalid id' })
  const parsed = mzappExpenseReceiptUpdateSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json({ message: 'invalid payload' })
  if (!hasPg || !pgPool) return res.status(500).json({ message: 'pg not available' })
  try {
    await ensureMzappExpenseReceiptSchema()
    const before = await buildReceiptDetail(id, pgPool)
    if (!before || String(before.created_by || '') !== mzappActorId(user) || String(before.generated_from || '') !== 'mzapp') return res.status(404).json({ message: 'not_found' })
    const beforeScopes = Array.from(new Set((before.items || []).map((item: any) => String(item?.scope || '').trim()).filter(Boolean))) as MzappExpenseScope[]
    for (const scope of beforeScopes) {
      if (!(await mzappUserHasScopePerm(user, scope, 'edit.self'))) return res.status(403).json({ message: 'forbidden' })
    }
    const normalized = await assertValidReceiptPayload(user, parsed.data, 'edit.self')
    const client = await pgPool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `UPDATE expense_receipts
            SET receipt_date = $2,
                receipt_total_amount = $3,
                note = $4,
                updated_at = now()
          WHERE id = $1`,
        [id, normalized.receipt_date, normalized.receipt_total_amount, normalized.note],
      )
      await replaceReceiptImages(client, id, normalized.receipt_urls, user)
      const existingIds = new Set((before.items || []).map((item: any) => String(item?.id || '').trim()).filter(Boolean))
      const keptIds = new Set<string>()
      for (const item of normalized.items) {
        const itemId = await upsertReceiptItemRow(client, id, item)
        keptIds.add(itemId)
        await upsertGeneratedExpenseFromReceiptItem(client, { id, receipt_date: normalized.receipt_date, note: normalized.note }, { ...item, id: itemId }, normalized.receipt_urls, user)
      }
      for (const existingId0 of existingIds) {
        const existingId = String(existingId0 || '').trim()
        if (!existingId) continue
        if (keptIds.has(existingId)) continue
        await softDeleteGeneratedExpensesByReceiptItem(client, existingId, user)
        await client.query('DELETE FROM expense_receipt_items WHERE id = $1 AND receipt_id = $2', [existingId, id])
      }
      await client.query('COMMIT')
      const after = await buildReceiptDetail(id, pgPool)
      try { const { addAudit } = require('../store'); addAudit('expense_receipts', id, 'update', before, after, mzappActorId(user)) } catch {}
      return res.json(after)
    } catch (e) {
      try { await client.query('ROLLBACK') } catch {}
      throw e
    } finally {
      client.release()
    }
  } catch (e: any) {
    const msg = String(e?.message || 'update_failed')
    if (['invalid receipt_date','missing receipt_urls','missing items','invalid receipt_total_amount','items_total_mismatch','missing expense_name','invalid item amount','missing property_id','invalid property_id','property_id_not_allowed','invalid category','missing category_detail','forbidden'].includes(msg)) {
      return res.status(msg === 'forbidden' ? 403 : 400).json({ message: msg })
    }
    return res.status(500).json({ message: msg || 'update_failed' })
  }
})

router.delete('/expense-receipts/mine/:id', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  const id = String(req.params.id || '').trim()
  if (!id) return res.status(400).json({ message: 'invalid id' })
  if (!hasPg || !pgPool) return res.status(500).json({ message: 'pg not available' })
  try {
    await ensureMzappExpenseReceiptSchema()
    const before = await buildReceiptDetail(id, pgPool)
    if (!before || String(before.created_by || '') !== mzappActorId(user) || String(before.generated_from || '') !== 'mzapp') return res.status(404).json({ message: 'not_found' })
    const scopes = Array.from(new Set((before.items || []).map((item: any) => String(item?.scope || '').trim()).filter(Boolean))) as MzappExpenseScope[]
    for (const scope of scopes) {
      if (!(await mzappUserHasScopePerm(user, scope, 'delete.self'))) return res.status(403).json({ message: 'forbidden' })
    }
    const client = await pgPool.connect()
    try {
      await client.query('BEGIN')
      const now = new Date().toISOString()
      const actor = mzappActorId(user)
      await client.query(
        `UPDATE expense_receipts
            SET deleted_at = $2,
                deleted_by = $3,
                delete_source = 'mzapp',
                updated_at = now()
          WHERE id = $1`,
        [id, now, actor],
      )
      await client.query(
        `UPDATE company_expenses
            SET deleted_at = COALESCE(deleted_at, $2),
                deleted_by = COALESCE(deleted_by, $3),
                delete_source = COALESCE(delete_source, 'mzapp')
          WHERE receipt_id = $1
            AND deleted_at IS NULL`,
        [id, now, actor],
      )
      await client.query(
        `UPDATE property_expenses
            SET deleted_at = COALESCE(deleted_at, $2),
                deleted_by = COALESCE(deleted_by, $3),
                delete_source = COALESCE(delete_source, 'mzapp')
          WHERE receipt_id = $1
            AND deleted_at IS NULL`,
        [id, now, actor],
      )
      await client.query('COMMIT')
      const after = await buildReceiptDetail(id, pgPool, { includeDeleted: true })
      try { const { addAudit } = require('../store'); addAudit('expense_receipts', id, 'delete', before, after, actor) } catch {}
      return res.json({ ok: true })
    } catch (e) {
      try { await client.query('ROLLBACK') } catch {}
      throw e
    } finally {
      client.release()
    }
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'delete_failed' })
  }
})

router.get('/expense-receipts/admin/:id', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  const id = String(req.params.id || '').trim()
  if (!id) return res.status(400).json({ message: 'invalid id' })
  if (!hasPg || !pgPool) return res.status(500).json({ message: 'pg not available' })
  try {
    const allowed = hasRole(user, 'admin') || hasRole(user, 'finance_staff') || hasRole(user, 'customer_service') || await userHasAnyPerm(user, ['finance.tx.write', 'company_expenses.view', 'property_expenses.view'])
    if (!allowed) return res.status(403).json({ message: 'forbidden' })
    await ensureMzappExpenseReceiptSchema()
    const includeDeleted = String((req.query as any)?.include_deleted || '').trim() === '1'
    const detail = await buildReceiptDetail(id, pgPool, { includeDeleted })
    if (!detail) return res.status(404).json({ message: 'not_found' })
    return res.json(detail)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'detail_failed' })
  }
})

router.post('/upload', upload.single('file'), async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  if (!req.file) return res.status(400).json({ message: 'missing file' })
  try {
    const body: any = (req as any).body || {}
    const watermarkMode = String(body.watermark_mode || '').trim().toLowerCase()
    const watermarkRequested = watermarkMode === 'photo_id_full'
    const isImage = String(req.file.mimetype || '').startsWith('image/')
    const esc = (s: string) =>
      String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
    const applyPhotoIdWatermark = async (input: Buffer) => {
      if (!watermarkRequested || !isImage) return input
      const image = sharp(input)
      const meta = await image.metadata()
      const width = Math.max(1, Number(meta.width || 0))
      const height = Math.max(1, Number(meta.height || 0))
      if (!width || !height) return input
      const fontSize = Math.max(18, Math.round(Math.min(width, height) * 0.042))
      const blockWidth = Math.max(320, Math.round(width * 0.68))
      const lineHeight = Math.round(fontSize * 1.35)
      const watermarkLines = PHOTO_ID_WATERMARK_TEXT.split('\n').map((line) => esc(line))
      const textY = fontSize + 8
      const svg = `
        <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
          <g transform="translate(${Math.round(width * 0.16)}, ${Math.round(height * 0.18)}) rotate(-24 ${Math.round(width * 0.34)} ${Math.round(height * 0.28)})">
            ${Array.from({ length: 5 }).map((_, row) => {
              const y = row * Math.max(lineHeight * 3, Math.round(height * 0.18))
              return Array.from({ length: 3 }).map((__, col) => {
                const x = col * Math.max(blockWidth + 56, Math.round(width * 0.34))
                return `
                  <g transform="translate(${x}, ${y})" opacity="0.18">
                    <rect x="-18" y="-${fontSize}" width="${blockWidth}" height="${lineHeight * watermarkLines.length + fontSize}" rx="18" fill="rgba(255,255,255,0.08)" />
                    ${watermarkLines
                      .map((line, idx) => `<text x="0" y="${textY + idx * lineHeight}" font-family="Arial, Helvetica, sans-serif" font-size="${fontSize}" font-weight="700" fill="rgba(220,38,38,0.82)">${line}</text>`)
                      .join('')}
                  </g>
                `
              }).join('')
            }).join('')}
          </g>
        </svg>
      `
      return await image
        .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
        .jpeg({ quality: 90 })
        .toBuffer()
    }

    if (hasR2 && (req.file as any).buffer) {
      let buffer: Buffer = (req.file as any).buffer
      buffer = await applyPhotoIdWatermark(buffer)
      const ext = watermarkRequested && isImage ? '.jpg' : (path.extname(req.file.originalname) || '')
      const key = `mzapp/${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`
      const mime = watermarkRequested && isImage ? 'image/jpeg' : (req.file.mimetype || 'application/octet-stream')
      const url = await r2Upload(key, mime, buffer)
      return res.status(201).json({ url })
    }
    const filePath = (req.file as any).path ? String((req.file as any).path) : ''
    if (filePath && watermarkRequested && isImage) {
      const buf = await fs.promises.readFile(filePath)
      const out = await applyPhotoIdWatermark(buf)
      const nextPath = `${filePath}.jpg`
      await fs.promises.writeFile(nextPath, out)
      try { await fs.promises.unlink(filePath) } catch {}
      const url = `/uploads/${path.basename(nextPath)}`
      return res.status(201).json({ url })
    }
    const url = `/uploads/${req.file.filename}`
    return res.status(201).json({ url })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'upload_failed' })
  }
})

async function completePropertyFollowupSource(client: any, row: any, completedAt: string) {
  const sourceType = String(row?.source_type || '').trim()
  const sourceId = String(row?.source_id || '').trim()
  if (!sourceId) return
  if (sourceType === 'property_maintenance') {
    await client.query(
      `UPDATE property_maintenance
          SET status = 'completed', completed_at = $2::timestamptz, updated_at = now()
        WHERE id::text = $1`,
      [sourceId, completedAt],
    )
    return
  }
  if (sourceType === 'property_deep_cleaning') {
    await client.query(
      `UPDATE property_deep_cleaning
          SET status = 'completed', completed_at = $2::timestamptz, updated_at = now()
        WHERE id::text = $1`,
      [sourceId, completedAt],
    )
    return
  }
  if (sourceType === 'property_daily_necessities') {
    await client.query(
      `UPDATE property_daily_necessities
          SET status = 'replaced'
        WHERE id::text = $1`,
      [sourceId],
    )
    return
  }
}

router.post('/work-tasks/:id/mark', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  const userId = String(user.sub || '')
  const id = String(req.params.id || '').trim()
  const action = String(req.body?.action || '').trim().toLowerCase()
  const photoUrl = String(req.body?.photo_url || '').trim() || null
  const photoUrls = normalizeWorkTaskPhotoUrls(req.body?.photo_urls)
  const note = String(req.body?.note || '').trim() || null
  const reason = String(req.body?.reason || '').trim() || null
  const deferTo = dayOnly(req.body?.defer_to)
  if (!id) return res.status(400).json({ message: 'missing id' })
  if (action !== 'done' && action !== 'defer') return res.status(400).json({ message: 'invalid action' })
  if (!hasPg || !pgPool) return res.status(500).json({ message: 'pg not available' })

  try {
    await ensureWorkTasksTable()
    const r0 = await pgPool.query('SELECT * FROM work_tasks WHERE id=$1 LIMIT 1', [id])
    const row = r0?.rows?.[0] || null
    if (!row) return res.status(404).json({ message: 'not found' })
    const assignee = row.assignee_id == null ? '' : String(row.assignee_id)
    if (!canViewAll(user) && assignee !== userId) return res.status(403).json({ message: 'forbidden' })
    const completionPhotoUrls = normalizeWorkTaskPhotoUrls(photoUrls.length ? photoUrls : (photoUrl ? [photoUrl] : []))

    if (action === 'done') {
      if (isWorkTaskDoneStatus(row.status)) {
        return res.json({
          ok: true,
          already_done: true,
          completion_photo_urls: normalizeWorkTaskPhotoUrls(row.completion_photo_urls),
          completion_note: row.completion_note == null ? null : String(row.completion_note || ''),
          completion_reason: null,
        })
      }
      const completedAt = new Date().toISOString()
      const client = await pgPool.connect()
      let alreadyDone = false
      try {
        await client.query('BEGIN')
        const updateResult = await client.query(
          `UPDATE work_tasks
           SET status=$1,
               completion_photo_urls=$2::jsonb,
               completion_note=$3,
               completion_reason=NULL,
               updated_at=now()
           WHERE id=$4
             AND lower(COALESCE(status, '')) NOT IN ('done', 'completed', 'ready')
           RETURNING id`,
          ['done', JSON.stringify(completionPhotoUrls), note, id],
        )
        alreadyDone = Number(updateResult?.rowCount || 0) === 0
        await completePropertyFollowupSource(client, row, completedAt)
        await client.query('COMMIT')
      } catch (error) {
        try { await client.query('ROLLBACK') } catch {}
        throw error
      } finally {
        client.release()
      }
      if (alreadyDone) {
        return res.json({
          ok: true,
          already_done: true,
          completion_photo_urls: normalizeWorkTaskPhotoUrls(row.completion_photo_urls),
          completion_note: row.completion_note == null ? null : String(row.completion_note || ''),
          completion_reason: null,
        })
      }
      try {
        await emitWorkTaskEvent({
          taskId: `work_task:${id}`,
          sourceType: 'work_tasks',
          sourceRefIds: [id],
          eventType: 'TASK_COMPLETED',
          changeScope: 'list',
          changedFields: ['status', 'completion_photo_urls', 'completion_note'],
          patch: {
            status: 'done',
            completion_photo_urls: completionPhotoUrls,
            completion_note: note,
            completion_reason: null,
          },
          occurredAt: completedAt,
          causedByUserId: userId,
          visibilityHints: buildWorkTaskVisibilityHints(row),
        })
      } catch {}
      try {
        await emitNotificationEvent(
          {
            type: 'WORK_TASK_COMPLETED',
            entity: 'work_task',
            entityId: id,
            propertyId: row.property_id ? String(row.property_id) : undefined,
            updatedAt: completedAt,
            title: workTaskCompletedTitle(row.title),
            body: workTaskCompletedBody(row.title),
            data: {
              entity: 'work_task',
              entityId: id,
              action: 'open_work_task',
              kind: 'work_task_completed',
              task_id: id,
              photo_url: completionPhotoUrls[0] || null,
              photo_urls: completionPhotoUrls,
              note,
            },
            actorUserId: userId,
          },
          { operationId: require('uuid').v4() },
        )
      } catch {}
      return res.json({ ok: true, completion_photo_urls: completionPhotoUrls, completion_note: note, completion_reason: null })
    }
    if (!reason) return res.status(400).json({ message: 'missing reason' })
    if (deferTo) {
      await pgPool.query(
        `UPDATE work_tasks
         SET status=$1,
             scheduled_date=$2::date,
             completion_photo_urls=$3::jsonb,
             completion_note=$4,
             completion_reason=$5,
             updated_at=now()
         WHERE id=$6`,
        ['todo', deferTo, JSON.stringify(completionPhotoUrls), note, reason, id],
      )
      return res.json({ ok: true, completion_photo_urls: completionPhotoUrls, completion_note: note, completion_reason: reason })
    }
    await pgPool.query(
      `UPDATE work_tasks
       SET status=$1,
           completion_photo_urls=$2::jsonb,
           completion_note=$3,
           completion_reason=$4,
           updated_at=now()
       WHERE id=$5`,
      ['todo', JSON.stringify(completionPhotoUrls), note, reason, id],
    )
    return res.json({ ok: true, completion_photo_urls: completionPhotoUrls, completion_note: note, completion_reason: reason })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'mark_failed' })
  }
})

const workTaskReorderSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  task_ids: z.array(z.string().min(1)).min(1),
}).strict()

router.post('/work-tasks/reorder', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  const userId = String(user.sub || '').trim()
  if (!userId && !canViewAll(user)) return res.status(401).json({ message: 'unauthorized' })
  const parsed = workTaskReorderSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  if (!hasPg || !pgPool) return res.status(500).json({ message: 'pg not available' })

  const date = parsed.data.date
  const taskIds = Array.from(new Set(parsed.data.task_ids.map((item) => String(item || '').trim()).filter(Boolean)))
  if (!taskIds.length) return res.status(400).json({ message: 'missing task_ids' })

  try {
    await ensureWorkTasksTable()
    const r0 = await pgPool.query(
      `SELECT id, assignee_id, scheduled_date, source_type
       FROM work_tasks
       WHERE id = ANY($1::text[])`,
      [taskIds],
    )
    const rows = Array.isArray(r0?.rows) ? r0.rows : []
    if (rows.length !== taskIds.length) return res.status(404).json({ message: 'task not found' })
    if (rows.some((row: any) => String(row.source_type || '').trim() === 'cleaning_tasks')) {
      return res.status(400).json({ message: 'cleaning tasks use dedicated reorder api' })
    }
    if (rows.some((row: any) => String(row.scheduled_date || '').slice(0, 10) !== date)) {
      return res.status(400).json({ message: 'task date mismatch' })
    }

    const assignees = Array.from(new Set(rows.map((row: any) => String(row.assignee_id || '').trim())))
    if (!canViewAll(user)) {
      if (rows.some((row: any) => String(row.assignee_id || '').trim() !== userId)) {
        return res.status(403).json({ message: 'forbidden' })
      }
    } else {
      const nonEmptyAssignees = assignees.filter(Boolean)
      if (nonEmptyAssignees.length > 1) return res.status(400).json({ message: 'only one assignee can be reordered at a time' })
    }

    const scopeAssignee = canViewAll(user) ? (assignees.find(Boolean) || '') : userId
    await pgPool.query('BEGIN')
    try {
      if (scopeAssignee) {
        await pgPool.query(
          `UPDATE work_tasks
           SET sort_index = NULL, updated_at = now()
           WHERE scheduled_date = $1::date
             AND source_type <> 'cleaning_tasks'
             AND COALESCE(assignee_id, '') = $2`,
          [date, scopeAssignee],
        )
      } else {
        await pgPool.query(
          `UPDATE work_tasks
           SET sort_index = NULL, updated_at = now()
           WHERE scheduled_date = $1::date
             AND source_type <> 'cleaning_tasks'
             AND COALESCE(assignee_id, '') = ''`,
          [date],
        )
      }
      const entries = JSON.stringify(taskIds.map((id, index) => ({ id, sort_index: index + 1 })))
      await pgPool.query(
        `UPDATE work_tasks AS w
         SET sort_index = v.sort_index, updated_at = now()
         FROM jsonb_to_recordset($1::jsonb) AS v(id text, sort_index integer)
         WHERE w.id::text = v.id`,
        [entries],
      )
      await pgPool.query('COMMIT')
    } catch (e) {
      await pgPool.query('ROLLBACK')
      throw e
    }
    return res.json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'work_task_reorder_failed' })
  }
})

router.get('/work-tasks', async (req, res) => {
  const dateFrom = dayOnly((req.query as any)?.date_from)
  const dateTo = dayOnly((req.query as any)?.date_to)
  if (!dateFrom || !dateTo) return res.status(400).json({ message: 'invalid date range' })
  const view = String((req.query as any)?.view || 'mine').trim().toLowerCase() === 'all' ? 'all' : 'mine'

  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  const userId = String(user.sub || '')

  const allowAll = view === 'all' && await canViewAllWorkTasks(user)

  try {
    if (!hasPg || !pgPool) return res.json([])
    await ensureWorkTasksTable()
    await ensureCleaningTaskSortColumns()
    await ensureCleaningTaskMediaTable()
    await ensureCleaningCheckoutColumns()
    await ensureCleaningCustomerColumns()
    await ensureCleaningInspectionColumns()
    try {
      await pgPool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS keys_required integer NOT NULL DEFAULT 1;`)
    } catch {}

    const out: any[] = []

    {
      const where: string[] = []
      const vals: any[] = [dateFrom, dateTo]
      where.push(`w.scheduled_date BETWEEN $1::date AND $2::date`)
      where.push(`NULLIF(COALESCE(w.assignee_id::text, ''), '') IS NOT NULL`)
      if (!allowAll) {
        vals.push(userId)
        where.push(`w.assignee_id = $${vals.length}`)
      }
      const sql = `
        SELECT
          w.*,
          p.code AS property_code,
          p.address AS property_address,
          p.type AS property_unit_type,
          p.region AS property_region,
          p.access_guide_link AS property_access_guide_link,
          p.wifi_ssid AS property_wifi_ssid,
          p.wifi_password AS property_wifi_password,
          p.router_location AS property_router_location,
          COALESCE(NULLIF(TRIM(au.display_name), ''), NULLIF(TRIM(au.username), ''), NULLIF(TRIM(au.email), ''), w.assignee_id::text) AS assignee_name
        FROM work_tasks w
        LEFT JOIN properties p ON p.id = w.property_id
        LEFT JOIN users au ON (au.id::text) = (w.assignee_id::text)
        WHERE ${where.join(' AND ')}
        ORDER BY
          w.scheduled_date ASC,
          COALESCE(w.sort_index, 2147483647) ASC,
          w.urgency DESC,
          w.updated_at DESC,
          w.id DESC`
      const r = await pgPool.query(sql, vals)
      const rows = r?.rows || []
      const guideLinks = await resolvePropertyPublicGuideLinks(
        rows.map((row: any) => ({
          propertyId: String(row.property_id || '').trim(),
          fallbackLink: row.property_access_guide_link,
        })),
      )
      for (const x of rows) {
        const completionPhotoUrls = normalizeWorkTaskPhotoUrls(x.completion_photo_urls)
        out.push({
          id: String(x.id),
          task_kind: String(x.task_kind || ''),
          source_type: String(x.source_type || ''),
          source_id: String(x.source_id || ''),
          property_id: x.property_id ? String(x.property_id) : null,
          title: String(x.title || ''),
          summary: x.summary !== undefined && x.summary !== null ? String(x.summary || '') : null,
          scheduled_date: x.scheduled_date ? String(x.scheduled_date).slice(0, 10) : null,
          start_time: x.start_time !== undefined && x.start_time !== null ? String(x.start_time || '') : null,
          end_time: x.end_time !== undefined && x.end_time !== null ? String(x.end_time || '') : null,
          assignee_id: x.assignee_id ? String(x.assignee_id) : null,
          assignee_name: x.assignee_name ? String(x.assignee_name) : null,
          cleaner_name: x.assignee_name ? String(x.assignee_name) : null,
          status: normStatus(x.status),
          urgency: normUrgency(x.urgency),
          sort_index: workTaskSortNumber(x.sort_index),
          completion_photo_urls: completionPhotoUrls,
          completion_note: x.completion_note == null ? null : String(x.completion_note || ''),
          completion_reason: x.completion_reason == null ? null : String(x.completion_reason || ''),
          property: x.property_id
            ? {
                id: String(x.property_id),
                code: x.property_code ? String(x.property_code) : '',
                address: x.property_address ? String(x.property_address) : '',
                unit_type: x.property_unit_type ? String(x.property_unit_type) : '',
                region: x.property_region ? String(x.property_region) : null,
                access_guide_link: guideLinks.get(String(x.property_id || '').trim()) || null,
                wifi_ssid: x.property_wifi_ssid ? String(x.property_wifi_ssid) : null,
                wifi_password: x.property_wifi_password ? String(x.property_wifi_password) : null,
                router_location: x.property_router_location ? String(x.property_router_location) : null,
              }
            : null,
        })
      }
    }

    {
      const isCleanerView = isCleanerRole(user) || isCleanerInspectorRole(user)
      const isInspectorView = isInspectorRole(user) || isCleanerInspectorRole(user)
      const wantCleaner = allowAll || isCleanerView
      const wantInspector = allowAll || isInspectorView

      if (wantCleaner || wantInspector) {
        const sql = `
          WITH latest_media_raw AS (
            SELECT DISTINCT ON (m.task_id::text, m.type)
              m.task_id::text AS task_id,
              m.type,
              m.url
            FROM cleaning_task_media m
            WHERE m.type IN ('key_photo', 'lockbox_video', 'consumable_living_room_photo')
            ORDER BY m.task_id::text, m.type, m.captured_at DESC NULLS LAST, m.created_at DESC
          ),
          latest_media AS (
            SELECT
              task_id,
              MAX(url) FILTER (WHERE type = 'key_photo') AS key_photo_url,
              MAX(url) FILTER (WHERE type = 'lockbox_video') AS lockbox_video_url,
              MAX(url) FILTER (WHERE type = 'consumable_living_room_photo') AS living_room_photo_url
            FROM latest_media_raw
            GROUP BY task_id
          )
          SELECT
            t.id,
            t.order_id,
            COALESCE(o.keys_required, 1) AS order_keys_required,
            t.nights_override,
            COALESCE(p_id.id::text, p_code.id::text, t.property_id::text) AS property_id,
            COALESCE(p_id.code::text, p_code.code::text) AS property_code,
            COALESCE(p_id.region::text, p_code.region::text) AS property_region,
            COALESCE(p_id.address::text, p_code.address::text) AS property_address,
            COALESCE(p_id.type::text, p_code.type::text) AS property_unit_type,
            COALESCE(p_id.access_guide_link::text, p_code.access_guide_link::text) AS property_access_guide_link,
            COALESCE(p_id.wifi_ssid::text, p_code.wifi_ssid::text) AS property_wifi_ssid,
            COALESCE(p_id.wifi_password::text, p_code.wifi_password::text) AS property_wifi_password,
            COALESCE(p_id.router_location::text, p_code.router_location::text) AS property_router_location,
            t.task_type,
            COALESCE(t.task_date, t.date)::text AS task_date,
            t.status,
            t.assignee_id,
            t.cleaner_id,
            t.inspector_id,
            t.inspection_mode,
            t.inspection_due_date::text AS inspection_due_date,
            COALESCE(cu.username, cu.email, cu.id::text) AS cleaner_name,
            COALESCE(iu.username, iu.email, iu.id::text) AS inspector_name,
            t.checkout_time,
            t.checkin_time,
            t.old_code,
            t.new_code,
            t.guest_special_request,
            t.note,
            CASE
              WHEN t.order_id IS NULL THEN COALESCE(t.keys_required, 1)
              ELSE COALESCE(o.keys_required, 1)
            END AS keys_required,
            t.checked_out_at,
            o.checkin::text AS order_checkin,
            o.checkout::text AS order_checkout,
            COALESCE(t.nights_override, o.nights, (o.checkout - o.checkin)) AS order_nights,
            lm.key_photo_url,
            lm.lockbox_video_url,
            lm.living_room_photo_url,
            t.sort_index_cleaner,
            t.sort_index_inspector,
            t.updated_at
          FROM cleaning_tasks t
          LEFT JOIN orders o ON (o.id::text) = (t.order_id::text)
          LEFT JOIN properties p_id ON (p_id.id::text) = (t.property_id::text)
          LEFT JOIN properties p_code ON upper(p_code.code) = upper(t.property_id::text)
          LEFT JOIN users cu ON (cu.id::text) = (COALESCE(t.cleaner_id, t.assignee_id)::text)
          LEFT JOIN users iu ON (iu.id::text) = (t.inspector_id::text)
          LEFT JOIN latest_media lm ON lm.task_id = t.id::text
          WHERE (
              ((COALESCE(t.task_date, t.date)::date) >= ($1::date) AND (COALESCE(t.task_date, t.date)::date) <= ($2::date))
              OR (t.inspection_due_date IS NOT NULL AND (t.inspection_due_date::date) <= ($2::date))
            )
            AND COALESCE(t.status,'') <> 'cancelled'
            AND (t.order_id IS NULL OR o.id IS NOT NULL)
            AND (
              t.order_id IS NULL
              OR (
                COALESCE(o.status, '') <> ''
                AND lower(COALESCE(o.status, '')) <> 'invalid'
                AND lower(COALESCE(o.status, '')) NOT LIKE '%cancel%'
              )
            )
          ORDER BY COALESCE(t.task_date, t.date) ASC, COALESCE(p_id.code, p_code.code) NULLS LAST, t.id`
        const r = await pgPool.query(sql, [dateFrom, dateTo])
        const cleaningRows = r?.rows || []
        const cleaningGuideLinks = await resolvePropertyPublicGuideLinks(
          cleaningRows.map((row: any) => ({
            propertyId: String(row.property_id || '').trim(),
            fallbackLink: row.property_access_guide_link,
          })),
        )
        const taskIds = Array.from(new Set(cleaningRows.map((x: any) => String(x.id || '')).filter(Boolean)))
        const guestLuggageByTaskKey = new Map<string, any>()
        const guestLuggagePropertyIds = Array.from(
          new Set(cleaningRows.map((x: any) => String(x.property_id || '').trim()).filter(Boolean)),
        )
        if (guestLuggagePropertyIds.length) {
          await ensureGuestLuggageTables()
          const luggageRows = await pgPool.query(
            `SELECT id, property_id::text AS property_id, task_date::text AS task_date
             FROM guest_luggage_notices
             WHERE property_id::text = ANY($1::text[])
               AND task_date::date BETWEEN $2::date AND $3::date`,
            [guestLuggagePropertyIds, dateFrom, dateTo],
          )
          const luggageDetails = await Promise.all(
            (luggageRows?.rows || []).map((row: any) => loadGuestLuggageNotice(String(row.id || ''), userId)),
          )
          for (const detail of luggageDetails) {
            if (!detail) continue
            guestLuggageByTaskKey.set(`${detail.property_id}|${detail.task_date}`, detail)
          }
        }
        const restockByTaskId = new Map<string, any[]>()
        if (taskIds.length) {
          const rr = await pgPool.query(
            `SELECT task_id::text AS task_id, item_id::text AS item_id, COALESCE(item_label,'') AS item_label, qty, note, photo_url, COALESCE(status,'') AS status
             FROM cleaning_consumable_usages
             WHERE task_id::text = ANY($1::text[])
               AND (COALESCE(status,'') = 'low' OR need_restock = true)
             ORDER BY created_at ASC`,
            [taskIds],
          )
          for (const x of rr?.rows || []) {
            const k = String(x.task_id || '')
            const arr = restockByTaskId.get(k) || []
            arr.push({
              item_id: String(x.item_id || ''),
              label: String(x.item_label || x.item_id || ''),
              qty: x.qty == null ? null : Number(x.qty),
              note: x.note == null ? null : String(x.note || ''),
              photo_url: x.photo_url == null ? null : String(x.photo_url || ''),
              status: String(x.status || ''),
            })
            restockByTaskId.set(k, arr)
          }
        }
        const completionAreasByTaskId = new Map<string, Set<string>>()
        if (taskIds.length) {
          const cr = await pgPool.query(
            `SELECT task_id::text AS task_id, type
             FROM cleaning_task_media
             WHERE task_id::text = ANY($1::text[])
               AND type LIKE 'completion_%'`,
            [taskIds],
          )
          for (const x of cr?.rows || []) {
            const tid = String(x.task_id || '').trim()
            if (!tid) continue
            const type = String(x.type || '')
            const area = type.startsWith('completion_') ? type.slice('completion_'.length) : type
            if (!area) continue
            const set = completionAreasByTaskId.get(tid) || new Set<string>()
            set.add(area)
            completionAreasByTaskId.set(tid, set)
          }
        }
        const cleanerGroups = new Map<string, any[]>()
        const inspectorGroups = new Map<string, any[]>()
        for (const row of cleaningRows) {
          const taskDate = String(row.task_date || row.date || '').slice(0, 10)
          const propId = row.property_id ? String(row.property_id) : null
          const prop = propId
            ? {
                id: propId,
                code: row.property_code ? String(row.property_code) : '',
                address: row.property_address ? String(row.property_address) : '',
                unit_type: row.property_unit_type ? String(row.property_unit_type) : '',
                region: row.property_region ? String(row.property_region) : null,
                access_guide_link: cleaningGuideLinks.get(String(propId || '').trim()) || null,
                wifi_ssid: row.property_wifi_ssid ? String(row.property_wifi_ssid) : null,
                wifi_password: row.property_wifi_password ? String(row.property_wifi_password) : null,
                router_location: row.property_router_location ? String(row.property_router_location) : null,
              }
            : null

          const raw_status = String(row.status ?? '').trim().toLowerCase()
          const status = mapCleaningTaskStatus(raw_status)
          const inspectionMode = effectiveInspectionMode(row)
          const inspectionDueDate = dayOnly(row.inspection_due_date)
          const deferredDate = deferredProjectionDate({
            inspectionMode,
            inspectionDueDate,
            dateFrom,
            dateTo,
            status: raw_status,
          })

          const effectiveCleanerId = row.cleaner_id ? String(row.cleaner_id) : (row.assignee_id ? String(row.assignee_id) : null)
          const inspectorId = row.inspector_id ? String(row.inspector_id) : null
          const orderId = row.order_id ? String(row.order_id) : null
          const orderKeysRequired = row.order_keys_required == null ? null : Number(row.order_keys_required)

          const base = {
            __raw_id: String(row.id),
            __date: taskDate,
            __prop_id: propId,
            __assignee_cleaner: effectiveCleanerId,
            __assignee_inspector: inspectorId,
            __inspection_mode: inspectionMode,
            __inspection_due_date: inspectionDueDate,
            __deferred_projection_date: deferredDate,
            order_id: orderId,
            order_keys_required: orderKeysRequired,
            raw_status,
            task_type: String(row.task_type || ''),
            checkout_time: row.checkout_time,
            checkin_time: row.checkin_time,
            old_code: row.old_code,
            new_code: row.new_code,
            guest_special_request: row.guest_special_request,
            note: row.note == null ? null : String(row.note || '').trim() || null,
            keys_required: row.keys_required == null ? 1 : Number(row.keys_required),
            keys_required_checkout: cleaningType(row.task_type) === 'checkout' ? clampInt(row.keys_required == null ? 1 : Number(row.keys_required), 1, 2) : null,
            keys_required_checkin: cleaningType(row.task_type) === 'checkin' ? clampInt(row.keys_required == null ? 1 : Number(row.keys_required), 1, 2) : null,
            checked_out_at: row.checked_out_at,
            key_photo_url: row.key_photo_url,
            lockbox_video_url: row.lockbox_video_url,
            living_room_photo_url: row.living_room_photo_url,
            restock_items: restockByTaskId.get(String(row.id)) || [],
            completion_areas: Array.from(completionAreasByTaskId.get(String(row.id)) || []),
            nights_override: row.nights_override == null ? null : Number(row.nights_override),
            order_checkin: row.order_checkin,
            order_checkout: row.order_checkout,
            order_nights: row.order_nights == null ? null : Number(row.order_nights),
            cleaner_name: row.cleaner_name,
            inspector_name: row.inspector_name,
            sort_index_cleaner: row.sort_index_cleaner,
            sort_index_inspector: row.sort_index_inspector,
            guest_luggage: guestLuggageByTaskKey.get(`${String(propId || '')}|${taskDate}`) || null,
            status,
            property: prop,
          }

          if (wantCleaner && effectiveCleanerId && taskDate >= dateFrom && taskDate <= dateTo && (allowAll || effectiveCleanerId === userId)) {
            const k = `${taskDate}|${propId || ''}|${effectiveCleanerId || 'unassigned'}`
            const arr = cleanerGroups.get(k) || []
            arr.push(base)
            cleanerGroups.set(k, arr)
          }

          const inspectorDisplayDate = mobileInspectionProjectionDate({
            inspectionMode,
            inspectionDueDate,
            taskDate,
            dateFrom,
            dateTo,
            status: raw_status,
          })
          if (wantInspector && inspectorId && inspectorDisplayDate && cleaningType(row.task_type) !== 'stayover' && (allowAll || inspectorId === userId)) {
            const k = `${inspectorDisplayDate}|${propId || ''}|${inspectorId}`
            const arr = inspectorGroups.get(k) || []
            arr.push({ ...base, __date: inspectorDisplayDate, __is_deferred_projection: inspectionMode === 'deferred' })
            inspectorGroups.set(k, arr)
          }
        }

        const buildMerged = (roleKind: 'cleaner' | 'inspector', rows: any[], assigneeId: string) => {
          const date = String(rows?.[0]?.__date || '')
          const propId = rows?.[0]?.__prop_id ? String(rows[0].__prop_id) : null
          const prop = rows?.[0]?.property || null

          const checkouts = rows.filter((x) => cleaningType(x.task_type) === 'checkout')
          const checkins = rows.filter((x) => cleaningType(x.task_type) === 'checkin')
          const stayovers = rows.filter((x) => cleaningType(x.task_type) === 'stayover')

          const pickPrimary = () => {
            if (checkouts.length && checkins.length) return { kind: 'turnover', a: checkouts[0], b: checkins[0], ids: [checkouts[0].__raw_id, checkins[0].__raw_id] }
            if (checkouts.length) return { kind: 'checkout', a: checkouts[0], b: null, ids: [checkouts[0].__raw_id] }
            if (checkins.length) return { kind: 'checkin', a: checkins[0], b: null, ids: [checkins[0].__raw_id] }
            if (stayovers.length) return { kind: 'stayover', a: stayovers[0], b: null, ids: [stayovers[0].__raw_id] }
            return { kind: 'other', a: rows[0], b: null, ids: [rows[0].__raw_id] }
          }

          const p = pickPrimary()
          const checkoutTime = p.kind === 'turnover' || p.kind === 'checkout' ? normalizeTimeOrDefault(p.a.checkout_time, '10am') : ''
          const checkinTime = p.kind === 'turnover' || p.kind === 'checkin' ? normalizeTimeOrDefault((p.kind === 'turnover' ? p.b?.checkin_time : p.a.checkin_time), '3pm') : ''
          const summary =
            p.kind === 'turnover'
              ? `${checkoutTime}退房 ${checkinTime}入住`
              : p.kind === 'checkout'
                ? `${checkoutTime}退房`
                : p.kind === 'checkin'
                  ? `${checkinTime}入住`
                  : p.kind === 'stayover'
                    ? '清洁'
                    : (summaryFromCleaningTimes(p.a.checkout_time, p.a.checkin_time) || null)

          const oldCode = firstNonEmpty(p.a.old_code, p.b?.old_code, ...rows.map((x) => x.old_code))
          const newCode = firstNonEmpty(p.a.new_code, p.b?.new_code, ...rows.map((x) => x.new_code))
          const guestSpecialRequest = firstNonEmpty(p.a.guest_special_request, p.b?.guest_special_request, ...rows.map((x) => x.guest_special_request))
          const taskNote = firstNonEmpty(p.a.note, p.b?.note, ...rows.map((x) => x.note))
          const checkedOutAt = firstNonEmpty(p.a.checked_out_at, p.b?.checked_out_at, ...rows.map((x) => x.checked_out_at))
          const keyPhotoUrl = firstNonEmpty(p.a.key_photo_url, p.b?.key_photo_url, ...rows.map((x) => x.key_photo_url))
          const lockboxVideoUrl = firstNonEmpty(p.a.lockbox_video_url, p.b?.lockbox_video_url, ...rows.map((x) => x.lockbox_video_url))
          const keysRequired = Math.max(...rows.map((x) => (x.keys_required == null ? 1 : Number(x.keys_required))).filter((x) => Number.isFinite(x) && x > 0), 1)
          const cleanerName = firstNonEmpty(p.a.cleaner_name, p.b?.cleaner_name, ...rows.map((x) => x.cleaner_name))
          const inspectorName = p.kind === 'stayover' ? null : firstNonEmpty(p.a.inspector_name, p.b?.inspector_name, ...rows.map((x) => x.inspector_name))
          const inspectorAssigned = p.kind === 'stayover' ? null : firstNonEmpty(p.a.__assignee_inspector, p.b?.__assignee_inspector, ...rows.map((x) => x.__assignee_inspector))
          const inspectionPlan = mergeInspectionPlan(
            rows.map((x) => ({
              task_type: x.task_type,
              inspection_mode: x.__inspection_mode,
              inspection_due_date: x.__inspection_due_date,
              inspector_id: x.__assignee_inspector,
              status: x.raw_status,
            })),
          )
          const inspectionMode = inspectionPlan.inspectionMode
          const inspectionDueDate = inspectionPlan.inspectionDueDate
          const requireSelfComplete = roleKind === 'cleaner' && inspectionMode === 'self_complete'
          const requireLockboxBeforeDone = requireSelfComplete && p.kind !== 'stayover'
          const completionAreas = new Set<string>()
          for (const sId of p.ids) {
            const arr = rows.filter((x) => String(x.__raw_id) === String(sId)).flatMap((x) => (Array.isArray(x.completion_areas) ? x.completion_areas : []))
            for (const a of arr) {
              const k = String(a || '').trim()
              if (k) completionAreas.add(k)
            }
          }
          const completionPhotosOk = REQUIRED_COMPLETION_PHOTO_AREAS.every((a) => completionAreas.has(a))
          const restockItems: any[] = []
          const seen = new Set<string>()
          for (const sId of p.ids) {
            const arr = rows.filter((x) => String(x.__raw_id) === String(sId)).flatMap((x) => (Array.isArray(x.restock_items) ? x.restock_items : []))
            for (const it of arr) {
              const iid = String(it?.item_id || it?.label || '').trim()
              if (!iid) continue
              if (seen.has(iid)) continue
              seen.add(iid)
              restockItems.push(it)
            }
          }
          const raw = String(p.a.raw_status ?? '').trim().toLowerCase()
          const isDoneLike = raw === 'cleaned' || raw === 'restock_pending' || raw === 'restocked' || raw === 'ready' || raw === 'inspected'
          const nightsFor = (x: any) => {
            const n0 =
              x?.nights_override != null
                ? Number(x.nights_override)
                : x?.order_nights != null
                  ? Number(x.order_nights)
                  : null
            if (Number.isFinite(n0 as any)) return Math.max(0, Math.trunc(n0 as any))
            const d0 = daysBetweenYmd(x?.order_checkin, x?.order_checkout)
            return d0 == null ? null : Math.max(0, Math.trunc(d0))
          }
          const stayedAndRemaining = (() => {
            if (p.kind === 'turnover') return { stayed: nightsFor(p.a), remaining: nightsFor(p.b) }
            if (p.kind === 'checkout') return { stayed: nightsFor(p.a), remaining: 0 }
            if (p.kind === 'checkin') return { stayed: 0, remaining: nightsFor(p.a) }
            if (p.kind === 'stayover') {
              const total = nightsFor(p.a)
              const r0 = computeStayedRemaining({ checkin: p.a.order_checkin, checkout: p.a.order_checkout, taskDate: date, nightsTotal: total })
              return { stayed: r0.stayed, remaining: r0.remaining }
            }
            return { stayed: null as number | null, remaining: null as number | null }
          })()
          const statusOut =
            roleKind === 'inspector'
              ? (
                  raw === 'keys_hung'
                    ? 'keys_hung'
                    : lockboxVideoUrl
                    ? 'keys_hung'
                    : isInspectionFinishedStatus(raw)
                      ? 'done'
                      : (raw === 'cleaned' || raw === 'restock_pending' || raw === 'restocked')
                          ? 'to_inspect'
                          : (raw === 'in_progress' || keyPhotoUrl)
                            ? 'in_progress'
                            : (String(inspectorAssigned || '').trim() ? 'assigned' : 'todo')
                )
              : (
                  raw === 'keys_hung'
                    ? 'keys_hung'
                    : requireLockboxBeforeDone && isDoneLike && !lockboxVideoUrl
                    ? 'to_hang_keys'
                    : requireSelfComplete && isDoneLike && !completionPhotosOk
                      ? 'to_complete'
                      : (!String(assigneeId || '').trim() && !isDoneLike && raw !== 'in_progress' && !keyPhotoUrl)
                        ? 'todo'
                        : (raw === 'cleaned' || raw === 'restock_pending' ? 'done' : p.a.status)
                )
          const sortIndex =
            roleKind === 'cleaner'
              ? Math.min(...rows.map((x) => (x.sort_index_cleaner == null ? Number.POSITIVE_INFINITY : Number(x.sort_index_cleaner))).filter((x) => Number.isFinite(x)))
              : Math.min(...rows.map((x) => (x.sort_index_inspector == null ? Number.POSITIVE_INFINITY : Number(x.sort_index_inspector))).filter((x) => Number.isFinite(x)))
          const sort_index = Number.isFinite(sortIndex) && sortIndex !== Number.POSITIVE_INFINITY ? sortIndex : null
          const cleanerSortIndex = Math.min(...rows.map((x) => (x.sort_index_cleaner == null ? Number.POSITIVE_INFINITY : Number(x.sort_index_cleaner))).filter((x) => Number.isFinite(x)))
          const inspectorSortIndex = Math.min(...rows.map((x) => (x.sort_index_inspector == null ? Number.POSITIVE_INFINITY : Number(x.sort_index_inspector))).filter((x) => Number.isFinite(x)))
          const sort_index_cleaner = Number.isFinite(cleanerSortIndex) && cleanerSortIndex !== Number.POSITIVE_INFINITY ? cleanerSortIndex : null
          const sort_index_inspector = Number.isFinite(inspectorSortIndex) && inspectorSortIndex !== Number.POSITIVE_INFINITY ? inspectorSortIndex : null

          const assigneeKey = String(assigneeId || '').trim() || 'unassigned'
          const outId = p.kind === 'turnover' ? `cleaning_tasks_${roleKind}_turnover:${date}:${propId || 'unknown'}:${assigneeKey}` : `cleaning_tasks_${roleKind}:${p.ids.join(',')}`
          const primarySourceId = String(p.a.__raw_id)
          const nextCheckinsForCheckout = p.kind === 'checkout'
            ? (() => {
                const candidates = cleaningRows
                  .filter((x: any) => String(x?.property_id || '') === String(propId || ''))
                  .filter((x: any) => cleaningType(x?.task_type) === 'checkin')
                  .filter((x: any) => String(x?.task_date || x?.date || '').slice(0, 10) >= date)
                  .sort((a: any, b: any) => String(a?.task_date || a?.date || '').localeCompare(String(b?.task_date || b?.date || '')))
                const nextDate = String(candidates[0]?.task_date || candidates[0]?.date || '').slice(0, 10)
                return nextDate ? candidates.filter((x: any) => String(x?.task_date || x?.date || '').slice(0, 10) === nextDate) : []
              })()
            : []
          const checkoutKeys =
            p.kind === 'turnover' || p.kind === 'checkout'
              ? (p.a?.keys_required == null ? 1 : Number(p.a.keys_required))
              : null
          const checkinKeys =
            p.kind === 'turnover'
              ? (p.b?.keys_required == null ? 1 : Number(p.b.keys_required))
              : p.kind === 'checkin'
                ? (p.a?.keys_required == null ? 1 : Number(p.a.keys_required))
                : p.kind === 'checkout' && nextCheckinsForCheckout.length
                  ? Math.max(...nextCheckinsForCheckout.map((x: any) => (x?.keys_required == null ? 1 : Number(x.keys_required))))
                  : null
          const checkoutOrderId =
            (p.kind === 'turnover' || p.kind === 'checkout') && p.a?.order_id ? String(p.a.order_id) : null
          const checkinOrderId =
            p.kind === 'turnover'
              ? (p.b?.order_id ? String(p.b.order_id) : null)
              : (p.kind === 'checkin' && p.a?.order_id ? String(p.a.order_id) : null)
                || (p.kind === 'checkout' && nextCheckinsForCheckout[0]?.order_id ? String(nextCheckinsForCheckout[0].order_id) : null)
          const singleOrderId = p.kind === 'turnover' ? null : (p.a?.order_id ? String(p.a.order_id) : null)
          const checkoutKeysOut = checkoutKeys != null && Number.isFinite(checkoutKeys) ? Math.max(1, Math.min(2, Math.trunc(checkoutKeys))) : null
          const checkinKeysOut = checkinKeys != null && Number.isFinite(checkinKeys) ? Math.max(1, Math.min(2, Math.trunc(checkinKeys))) : null

          return {
            id: outId,
            task_kind: roleKind === 'cleaner' ? 'cleaning' : 'inspection',
            source_type: 'cleaning_tasks',
            source_id: primarySourceId,
            source_ids: p.ids,
            order_id: singleOrderId,
            order_id_checkout: checkoutOrderId,
            order_id_checkin: checkinOrderId,
            property_id: propId,
            title: prop?.code || (propId ? String(propId) : primarySourceId),
            summary: summary || null,
            scheduled_date: date,
            start_time: checkoutTime || null,
            end_time: checkinTime || null,
            task_type: p.kind === 'turnover' ? 'turnover' : String(p.a.task_type || ''),
            assignee_id: String(assigneeId || '').trim() || null,
            inspector_id: inspectorAssigned ? String(inspectorAssigned) : null,
            status: statusOut,
            urgency: 'medium',
            sort_index,
            sort_index_cleaner,
            sort_index_inspector,
            old_code: oldCode,
            new_code: newCode,
            guest_special_request: guestSpecialRequest,
            guest_luggage: p.a.guest_luggage || null,
            note: taskNote,
            inspection_mode: inspectionMode,
            inspection_due_date: inspectionDueDate,
            keys_required: keysRequired,
            keys_required_checkout: checkoutKeysOut,
            keys_required_checkin: checkinKeysOut,
            key_tags: {
              checkout_sets: checkoutKeysOut,
              checkin_sets: checkinKeysOut,
              show_checkout: (checkoutKeysOut ?? 0) >= 2,
              show_checkin: (checkinKeysOut ?? 0) >= 2,
            },
            checked_out_at: checkedOutAt,
            key_photo_url: keyPhotoUrl,
            lockbox_video_url: lockboxVideoUrl,
            restock_items: restockItems,
            completion_photos_ok: completionPhotosOk,
            stayed_nights: stayedAndRemaining.stayed,
            remaining_nights: stayedAndRemaining.remaining,
            cleaner_name: cleanerName,
            inspector_name: inspectorName,
            property: prop,
          }
        }

        for (const [k, rows] of cleanerGroups) {
          const parts = k.split('|')
          const assigneeId = parts[2] === 'unassigned' ? '' : (parts[2] || '')
          out.push(buildMerged('cleaner', rows, assigneeId))
        }

        for (const [k, rows] of inspectorGroups) {
          const parts = k.split('|')
          const assigneeId = parts[2] || ''
          if (!assigneeId) continue
          out.push(buildMerged('inspector', rows, assigneeId))
        }
      }
    }

    if (allowAll && (hasRole(user, 'customer_service') || hasRole(user, 'admin') || hasRole(user, 'offline_manager'))) {
      const merged: any[] = []
      const byKey = new Map<string, any[]>()
      for (const it of out) {
        const isCleaning = String(it?.source_type || '') === 'cleaning_tasks'
        const d = String(it?.scheduled_date || '').slice(0, 10)
        const code = String(it?.property?.code || '').trim()
        const pid = it?.property_id ? String(it.property_id) : ''
        const propKey = code || pid || String(it?.title || '').trim()
        if (!isCleaning || !d || !propKey) {
          merged.push(it)
          continue
        }
        const k = `${d}|${propKey}`
        const arr = byKey.get(k) || []
        arr.push(it)
        byKey.set(k, arr)
      }

      const rankStatus = (s0: any) => {
        const s = String(s0 || '').trim().toLowerCase()
        if (!s) return 50
        if (s === 'in_progress') return 10
        if (s === 'to_hang_keys') return 12
        if (s === 'to_complete') return 13
        if (s === 'to_inspect') return 15
        if (s === 'to_clean') return 20
        if (s === 'checked_out') return 25
        if (s === 'keys_hung') return 80
        if (s === 'done') return 90
        return 60
      }

      for (const [k, arr0] of byKey) {
        const arr = (arr0 || []).filter(Boolean)
        if (!arr.length) continue
        const preferred = arr.find((x) => String(x?.task_kind || '') === 'inspection') || arr[0]
        const [d, propKey] = k.split('|')
        const srcIds = Array.from(new Set(arr.flatMap((x) => (Array.isArray(x?.source_ids) ? x.source_ids : []))))
        const cleaningTaskIds = Array.from(
          new Set(arr.filter((x) => String(x?.task_kind || '') === 'cleaning').flatMap((x) => (Array.isArray(x?.source_ids) ? x.source_ids : []))),
        )
        const inspectionTaskIds = Array.from(
          new Set(arr.filter((x) => String(x?.task_kind || '') === 'inspection').flatMap((x) => (Array.isArray(x?.source_ids) ? x.source_ids : []))),
        )
        const cleaningStatus = (arr.find((x) => String(x?.task_kind || '') === 'cleaning') || null)?.status || null
        const inspectionStatus = (arr.find((x) => String(x?.task_kind || '') === 'inspection') || null)?.status || null
        const startTime = firstNonEmpty(...arr.map((x) => x.start_time))
        const endTime = firstNonEmpty(...arr.map((x) => x.end_time))
        const keyPhotoUrl = firstNonEmpty(...arr.map((x) => x.key_photo_url))
        const lockboxVideoUrl = firstNonEmpty(...arr.map((x) => x.lockbox_video_url))
        const keysRequired = Math.max(...arr.map((x) => (x?.keys_required == null ? 1 : Number(x.keys_required))).filter((x) => Number.isFinite(x) && x > 0), 1)
        const checkoutKeys = Math.max(
          ...arr.map((x) => (x?.keys_required_checkout == null ? 0 : Number(x.keys_required_checkout))).filter((x) => Number.isFinite(x) && x > 0),
          0,
        )
        const checkinKeys = Math.max(
          ...arr.map((x) => (x?.keys_required_checkin == null ? 0 : Number(x.keys_required_checkin))).filter((x) => Number.isFinite(x) && x > 0),
          0,
        )
        const orderIdCheckin = firstNonEmpty(
          ...arr.map((x) => x.order_id_checkin),
          ...arr.map((x) => (String(x?.task_type || '').trim().toLowerCase() === 'checkin_clean' ? x.order_id : null)),
        )
        const orderIdCheckout = firstNonEmpty(
          ...arr.map((x) => x.order_id_checkout),
          ...arr.map((x) => (String(x?.task_type || '').trim().toLowerCase() === 'checkout_clean' ? x.order_id : null)),
        )
        const checkoutKeysOut = checkoutKeys ? clampInt(checkoutKeys, 1, 2) : null
        const checkinKeysOut = checkinKeys ? clampInt(checkinKeys, 1, 2) : null
        const checkedOutAtMerged = firstNonEmpty(...arr.map((x) => x.checked_out_at))
        const cleanerName = firstNonEmpty(...arr.map((x) => x.cleaner_name))
        const inspectorName = firstNonEmpty(...arr.map((x) => x.inspector_name))
        const cleanerAssigneeId = firstNonEmpty(
          ...arr
            .filter((x) => String(x?.task_kind || '') === 'cleaning')
            .map((x) => x.assignee_id),
          ...arr
            .filter((x) => String(x?.task_kind || '') === 'cleaning')
            .map((x) => x.__assignee_cleaner),
        )
        const inspectorAssigneeId = firstNonEmpty(
          ...arr
            .filter((x) => String(x?.task_kind || '') === 'inspection')
            .map((x) => x.inspector_id || x.assignee_id),
          ...arr
            .filter((x) => String(x?.task_kind || '') === 'inspection')
            .map((x) => x.__assignee_inspector),
        )
        const inspectionPlan = mergeInspectionPlan(
          arr.map((x) => ({
            task_type: x.task_type,
            inspection_mode: x.inspection_mode,
            inspection_due_date: x.inspection_due_date,
            inspector_id: x.inspector_id,
            status: x.status,
          })),
        )
        const inspectionMode = inspectionPlan.inspectionMode
        const inspectionDueDate = inspectionPlan.inspectionDueDate
        const restockItems: any[] = []
        const seenRestock = new Set<string>()
        for (const it of arr.flatMap((x) => (Array.isArray(x?.restock_items) ? x.restock_items : []))) {
          const iid = String(it?.item_id || it?.label || '').trim()
          if (!iid) continue
          if (seenRestock.has(iid)) continue
          seenRestock.add(iid)
          restockItems.push(it)
        }
        const statusOut =
          cleaningStatus && rankStatus(cleaningStatus) < 80
            ? cleaningStatus
            : inspectionStatus
              ? inspectionStatus
              : arr
                  .map((x) => x.status)
                  .sort((a: any, b: any) => rankStatus(a) - rankStatus(b))[0]

        merged.push({
          ...preferred,
          id: `cleaning_tasks_merged:${d}:${propKey}`,
          start_time: startTime || null,
          end_time: endTime || null,
          task_kind: arr.some((x) => String(x?.task_kind || '') === 'inspection') ? 'inspection' : 'cleaning',
          source_ids: srcIds.length ? srcIds : (Array.isArray(preferred?.source_ids) ? preferred.source_ids : undefined),
          cleaning_task_ids: cleaningTaskIds,
          inspection_task_ids: inspectionTaskIds,
          cleaning_status: cleaningStatus,
          inspection_status: inspectionStatus,
          assignee_id: cleanerAssigneeId || inspectorAssigneeId || null,
          cleaner_id: cleanerAssigneeId || null,
          inspector_id: inspectorAssigneeId || null,
          status: statusOut,
          key_photo_url: keyPhotoUrl,
          lockbox_video_url: lockboxVideoUrl,
          order_id: null,
          order_id_checkin: orderIdCheckin || null,
          order_id_checkout: orderIdCheckout || null,
          inspection_mode: inspectionMode,
          inspection_due_date: inspectionDueDate,
          keys_required: keysRequired,
          keys_required_checkout: checkoutKeysOut,
          keys_required_checkin: checkinKeysOut,
          key_tags: {
            checkout_sets: checkoutKeysOut,
            checkin_sets: checkinKeysOut,
            show_checkout: (checkoutKeysOut ?? 0) >= 2,
            show_checkin: (checkinKeysOut ?? 0) >= 2,
          },
          cleaner_name: cleanerName,
          inspector_name: inspectorName,
          restock_items: restockItems,
        })
      }

      out.length = 0
      out.push(...merged)
    }

    const hasMobileAssignee = (task: any) => {
      const source = String(task?.source_type || '').trim()
      if (source !== 'cleaning_tasks') return !!String(task?.assignee_id || '').trim()
      const kind = String(task?.task_kind || '').trim().toLowerCase()
      if (kind === 'inspection') return !!String(task?.inspector_id || task?.assignee_id || '').trim()
      if (kind === 'cleaning') return !!String(task?.cleaner_id || task?.assignee_id || '').trim()
      return !!String(task?.cleaner_id || task?.inspector_id || task?.assignee_id || '').trim()
    }
    const assignedOut = out.filter(hasMobileAssignee)

    assignedOut.sort((a, b) => {
      const ad = String(a.scheduled_date || '')
      const bd = String(b.scheduled_date || '')
      const d = ad.localeCompare(bd)
      if (d) return d
      const ai = a.sort_index == null ? Number.POSITIVE_INFINITY : Number(a.sort_index)
      const bi = b.sort_index == null ? Number.POSITIVE_INFINITY : Number(b.sort_index)
      const o = ai - bi
      if (o) return o
      const aIsCleaning = String(a.source_type || '') === 'cleaning_tasks'
      const bIsCleaning = String(b.source_type || '') === 'cleaning_tasks'
      if (aIsCleaning && bIsCleaning && allowAll) {
        const aa = String(a.assignee_id || '')
        const ba = String(b.assignee_id || '')
        const u0 = aa.localeCompare(ba)
        if (u0) return u0
      }
      if (!(aIsCleaning && bIsCleaning)) {
        const ur = urgencyRank(String(b.urgency || '')) - urgencyRank(String(a.urgency || ''))
        if (ur) return ur
      }
      return String(a.title || '').localeCompare(String(b.title || ''))
    })

    return res.json(assignedOut)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'mzapp_work_tasks_failed' })
  }
})

const dailyNecessitiesStatusSchema = z.enum(['need_replace', 'replaced', 'no_action'])

router.get('/daily-necessities-options', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  try {
    if (!hasPg || !pgPool) return res.json([])
    const keyword = String((req.query as any)?.keyword || '').trim()
    const limitRaw = Number((req.query as any)?.limit)
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(120, Math.trunc(limitRaw))) : 80
    const values: any[] = []
    const where: string[] = [`COALESCE(is_active, true) = true`]
    if (keyword) {
      values.push(`%${keyword.toLowerCase()}%`)
      where.push(`(
        LOWER(COALESCE(item_name, '')) LIKE $${values.length}
        OR LOWER(COALESCE(sku, '')) LIKE $${values.length}
        OR LOWER(COALESCE(category, '')) LIKE $${values.length}
      )`)
    }
    const rows = await pgPool.query(
      `SELECT id, category, item_name, sku, unit, default_quantity
         FROM daily_items_price_list
        WHERE ${where.join(' AND ')}
        ORDER BY COALESCE(category, ''), item_name ASC
        LIMIT ${limit}`,
      values,
    )
    return res.json(
      (rows.rows || []).map((row: any) => ({
        id: String(row.id || ''),
        category: row.category ? String(row.category) : null,
        item_name: String(row.item_name || ''),
        sku: row.sku ? String(row.sku) : null,
        unit: row.unit ? String(row.unit) : null,
        default_quantity: row.default_quantity == null ? null : Number(row.default_quantity),
      })),
    )
  } catch (e: any) {
    const msg = String(e?.message || '')
    if (/relation\s+"?daily_items_price_list"?\s+does\s+not\s+exist/i.test(msg)) return res.json([])
    return res.status(500).json({ message: msg || 'daily_necessities_options_failed' })
  }
})

const feedbackCreateSchema = z
  .object({
    kind: z.enum(['maintenance', 'deep_cleaning', 'daily_necessities']),
    property_id: z.string().min(1),
    source_task_id: z.string().optional(),

    area: z.string().optional(),
    areas: z.array(z.string().min(1)).optional(),
    category: z.string().optional(),
    detail: z.string().optional(),
    invoice_description_en: z.string().optional(),
    media_urls: z.array(z.string().min(1)).optional(),

    items: z
      .array(
        z.object({
          area: z.string().min(1),
          category: z.string().min(1),
          detail: z.string().min(1),
          media_urls: z.array(z.string().min(1)).optional(),
        }),
      )
      .optional(),

    status: dailyNecessitiesStatusSchema.optional(),
    item_name: z.string().optional(),
    quantity: z
      .preprocess((v) => {
        if (v == null) return v
        if (typeof v === 'number') return v
        const n = Number(v)
        return Number.isFinite(n) ? n : v
      }, z.number().int())
      .optional(),
    note: z.string().optional(),
  })
  .strict()

const feedbackProjectCreateSchema = z
  .object({
    name: z.string().min(1),
    area: z.string().optional(),
    category: z.string().optional(),
    detail: z.string().optional(),
    note: z.string().optional(),
  })
  .strict()

const feedbackProjectPatchSchema = z
  .object({
    name: z.string().min(1).optional(),
    area: z.string().optional(),
    category: z.string().optional(),
    detail: z.string().optional(),
    note: z.string().optional(),
  })
  .strict()

const feedbackPatchSchema = z
  .object({
    area: z.string().optional(),
    areas: z.array(z.string().min(1)).optional(),
    category: z.string().optional(),
    detail: z.string().optional(),
    invoice_description_en: z.string().optional(),
    status: dailyNecessitiesStatusSchema.optional(),
    item_name: z.string().min(1).optional(),
    quantity: z
      .preprocess((v) => {
        if (v == null) return v
        if (typeof v === 'number') return v
        const n = Number(v)
        return Number.isFinite(n) ? n : v
      }, z.number().int().min(1))
      .optional(),
    note: z.string().optional(),
    media_urls: z.array(z.string().min(1)).optional(),
    repair_photo_urls: z.array(z.string().min(1)).optional(),
  })
  .strict()

const feedbackProjectCompleteSchema = z
  .object({
    note: z.string().optional(),
    detail: z.string().optional(),
    source_task_id: z.string().optional(),
    started_at: z.string().optional(),
    ended_at: z.string().optional(),
    before_photos: z.array(z.string().min(1)).optional(),
    after_photos: z.array(z.string().min(1)).optional(),
  })
  .strict()

type PropertyFeedbackNotificationKind = 'maintenance' | 'deep_cleaning' | 'daily_necessities'

function propertyFeedbackKindLabel(kind: PropertyFeedbackNotificationKind) {
  if (kind === 'deep_cleaning') return '深度清洁'
  if (kind === 'daily_necessities') return '日用品'
  return '维修'
}

async function notifyPropertyFeedbackCreated(params: {
  id: string
  kind: PropertyFeedbackNotificationKind
  propertyId: string
  sourceTaskId?: string | null
  summary?: string | null
  actorUserId?: string | null
}) {
  const id = String(params.id || '').trim()
  if (!id) return
  const sourceTaskId = String(params.sourceTaskId || '').trim()
  const label = propertyFeedbackKindLabel(params.kind)
  const summary = String(params.summary || '').trim()
  try {
    await emitNotificationEvent({
      type: 'ISSUE_REPORTED',
      entity: 'property_feedback',
      entityId: id,
      eventId: `ISSUE_REPORTED_property_feedback_${id}_created`,
      propertyId: params.propertyId,
      title: `房源问题反馈：${label}`,
      body: summary ? `收到新的${label}反馈：${summary}`.slice(0, 240) : `收到新的${label}反馈`,
      data: {
        entity: 'property_feedback',
        entityId: id,
        action: sourceTaskId ? 'open_task' : 'open_notice',
        kind: 'issue_reported',
        feedback_id: id,
        feedback_kind: params.kind,
        task_id: sourceTaskId || undefined,
        issue_title: label,
        issue_detail: summary || undefined,
      },
      actorUserId: String(params.actorUserId || '').trim() || null,
      excludeActor: false,
    })
  } catch (error: any) {
    console.error(`[mzapp] property_feedback_notification_failed feedback_id=${id} message=${String(error?.message || error || '')}`)
  }
}

function mapWorkStatus(raw: any): 'open' | 'in_progress' | 'resolved' | 'cancelled' {
  const s = String(raw ?? '').trim().toLowerCase()
  if (s === 'in_progress') return 'in_progress'
  if (s === 'completed' || s === 'done' || s === 'ready') return 'resolved'
  if (s === 'canceled' || s === 'cancelled') return 'cancelled'
  return 'open'
}

function feedbackStatusWhereSql(alias: string, want: string[]) {
  const wants = new Set((want || []).map((s) => String(s || '').trim()).filter(Boolean))
  if (!wants.size) wants.add('open')
  const clauses: string[] = []
  if (wants.has('open')) clauses.push(`(${alias}.status IS NULL OR lower(${alias}.status) NOT IN ('in_progress','completed','done','ready','canceled','cancelled'))`)
  if (wants.has('in_progress')) clauses.push(`lower(COALESCE(${alias}.status, '')) = 'in_progress'`)
  if (wants.has('resolved')) clauses.push(`lower(COALESCE(${alias}.status, '')) IN ('completed','done','ready')`)
  if (wants.has('cancelled')) clauses.push(`lower(COALESCE(${alias}.status, '')) IN ('canceled','cancelled')`)
  return clauses.length ? `(${clauses.join(' OR ')})` : 'true'
}

const colTypeCache = new Map<string, 'jsonb' | 'text[]' | 'unknown'>()

async function getColumnType(table: string, column: string): Promise<'jsonb' | 'text[]' | 'unknown'> {
  if (!pgPool) return 'unknown'
  const key = `${table}.${column}`
  const cached = colTypeCache.get(key)
  if (cached) return cached
  try {
    const r = await pgPool.query(
      `SELECT data_type, udt_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = $1
          AND column_name = $2
        LIMIT 1`,
      [table, column],
    )
    const row = r.rows?.[0]
    const dataType = String(row?.data_type || '').trim().toLowerCase()
    const udt = String(row?.udt_name || '').trim().toLowerCase()
    const t: 'jsonb' | 'text[]' | 'unknown' =
      dataType === 'jsonb' || udt === 'jsonb' ? 'jsonb' : udt === '_text' ? 'text[]' : 'unknown'
    colTypeCache.set(key, t)
    return t
  } catch {
    colTypeCache.set(key, 'unknown')
    return 'unknown'
  }
}

function sha256Hex(input: string) {
  return crypto.createHash('sha256').update(input).digest('hex')
}

function normalizeForFingerprint(input: any) {
  const s0 = String(input ?? '').trim()
  if (!s0) return ''
  const s1 = s0.replace(/\s+/g, ' ')
  const s2 = s1.replace(/[，。！？、,.!?;:()（）【】\[\]{}'"“”‘’\-_/\\]+/g, ' ')
  return s2.replace(/\s+/g, ' ').trim().toLowerCase()
}

function makeFeedbackFingerprint(args: {
  kind: 'maintenance' | 'deep_cleaning'
  property_id: string
  area?: string
  category_detail?: string
  areas?: string[]
  detail?: string
}) {
  const pid = String(args.property_id || '').trim()
  const kind = args.kind
  const detail = normalizeForFingerprint(args.detail).slice(0, 160)
  if (kind === 'maintenance') {
    const area = String(args.area || '').trim()
    const cat = String(args.category_detail || '').trim()
    return sha256Hex([pid, kind, area, cat, detail].join('|'))
  }
  const areas = (args.areas || []).map((s) => String(s || '').trim()).filter(Boolean).sort()
  return sha256Hex([pid, kind, areas.join(','), detail].join('|'))
}

let propertyMaintenanceColumnsEnsured = false
let propertyMaintenanceColumnsEnsuring: Promise<void> | null = null
let propertyDeepCleaningColumnsEnsured = false
let propertyDeepCleaningColumnsEnsuring: Promise<void> | null = null
let propertyDailyNecessitiesColumnsEnsured = false
let propertyDailyNecessitiesColumnsEnsuring: Promise<void> | null = null

async function ensurePropertyMaintenanceColumns() {
  if (!pgPool) return
  if (propertyMaintenanceColumnsEnsured) return
  if (propertyMaintenanceColumnsEnsuring) return propertyMaintenanceColumnsEnsuring
  propertyMaintenanceColumnsEnsuring = (async () => {
    await pgPool.query(`CREATE TABLE IF NOT EXISTS property_maintenance (
        id text PRIMARY KEY,
        property_id text,
        occurred_at date,
        worker_name text,
        details text,
        created_by text,
        created_at timestamptz DEFAULT now()
      );`)
    await pgPool.query('ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS property_code text;')
    await pgPool.query('ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS status text;')
    await pgPool.query('ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS submitted_at timestamptz;')
    await pgPool.query('ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS submitter_name text;')
    await pgPool.query('ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS category_detail text;')
    await pgPool.query('ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS photo_urls jsonb;')
    await pgPool.query('ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS repair_photo_urls jsonb;')
    await pgPool.query('ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS repair_notes text;')
    await pgPool.query('ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS area text;')
    await pgPool.query('ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS work_no text;')
    await pgPool.query('ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS completed_at timestamptz;')
    await pgPool.query('ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS updated_at timestamptz;')
    await pgPool.query('ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS review_status text;')
    await pgPool.query('ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS reviewed_by text;')
    await pgPool.query('ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;')
    await pgPool.query('ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS review_notes text;')
    await pgPool.query('ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS project_items jsonb;')
    await pgPool.query('ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS invoice_description_en text;')
    await pgPool.query('ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS dedup_fingerprint text;')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_property_maintenance_dedup ON property_maintenance(property_id, dedup_fingerprint, submitted_at);')
    propertyMaintenanceColumnsEnsured = true
  })().catch((e) => {
    propertyMaintenanceColumnsEnsured = false
    propertyMaintenanceColumnsEnsuring = null
    throw e
  }).finally(() => {
    propertyMaintenanceColumnsEnsuring = null
  })
  return propertyMaintenanceColumnsEnsuring
}

async function ensurePropertyDeepCleaningColumns() {
  if (!pgPool) return
  if (propertyDeepCleaningColumnsEnsured) return
  if (propertyDeepCleaningColumnsEnsuring) return propertyDeepCleaningColumnsEnsuring
  propertyDeepCleaningColumnsEnsuring = (async () => {
    await pgPool.query(`CREATE TABLE IF NOT EXISTS property_deep_cleaning (
        id text PRIMARY KEY,
        property_id text,
        occurred_at date,
        details text,
        notes text,
        created_by text,
        created_at timestamptz DEFAULT now()
      );`)
    await pgPool.query('ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS property_code text;')
    await pgPool.query('ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS status text;')
    await pgPool.query('ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS submitted_at timestamptz;')
    await pgPool.query('ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS submitter_name text;')
    await pgPool.query('ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS project_desc text;')
    await pgPool.query('ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS started_at timestamptz;')
    await pgPool.query('ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS ended_at timestamptz;')
    await pgPool.query('ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS duration_minutes integer;')
    await pgPool.query('ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS photo_urls jsonb;')
    await pgPool.query('ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS repair_photo_urls jsonb;')
    await pgPool.query('ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS repair_notes text;')
    await pgPool.query('ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS attachment_urls jsonb;')
    await pgPool.query('ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS work_no text;')
    await pgPool.query('ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS completed_at timestamptz;')
    await pgPool.query('ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS updated_at timestamptz;')
    await pgPool.query('ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS review_status text;')
    await pgPool.query('ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS reviewed_by text;')
    await pgPool.query('ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;')
    await pgPool.query('ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS review_notes text;')
    await pgPool.query('ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS project_items jsonb;')
    await pgPool.query('ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS invoice_description_en text;')
    await pgPool.query('ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS dedup_fingerprint text;')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_property_deep_cleaning_dedup ON property_deep_cleaning(property_id, dedup_fingerprint, submitted_at);')
    propertyDeepCleaningColumnsEnsured = true
  })().catch((e) => {
    propertyDeepCleaningColumnsEnsured = false
    propertyDeepCleaningColumnsEnsuring = null
    throw e
  }).finally(() => {
    propertyDeepCleaningColumnsEnsuring = null
  })
  return propertyDeepCleaningColumnsEnsuring
}

type FeedbackKind = 'maintenance' | 'deep_cleaning'

type PropertyFeedbackProjectItem = {
  id: string
  name: string
  area?: string | null
  category?: string | null
  detail?: string | null
  note?: string | null
  started_at?: string | null
  ended_at?: string | null
  duration_minutes?: number | null
  before_photos: string[]
  after_photos: string[]
  status: 'open' | 'completed'
  completed_by?: string | null
  completed_at?: string | null
}

function normalizeUrlArray(raw: any): string[] {
  if (!raw) return []
  const input = typeof raw === 'string' ? (() => {
    const s = String(raw || '').trim()
    if (!s) return []
    if (s.startsWith('[') || s.startsWith('{')) {
      try { return JSON.parse(s) } catch { return [s] }
    }
    return [s]
  })() : raw
  if (!Array.isArray(input)) return []
  return input.map((x) => String(x || '').trim()).filter(Boolean)
}

function safeJsonParse(raw: any) {
  if (raw == null) return null
  if (typeof raw === 'object') return raw
  const s = String(raw || '').trim()
  if (!s) return null
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

function toIsoOrNull(raw: any) {
  const s = String(raw || '').trim()
  if (!s) return null
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

function feedbackPhotoFallbacks(kind: FeedbackKind, fallback?: any) {
  const fallbackBefore = normalizeUrlArray(
    fallback?.photo_urls || fallback?.attachment_urls || (kind === 'deep_cleaning' ? fallback?.attachment_urls : null),
  )
  const fallbackAfter = kind === 'deep_cleaning'
    ? normalizeUrlArray(fallback?.repair_photo_urls)
    : normalizeUrlArray(fallback?.repair_photo_urls || fallback?.attachment_urls)
  return { fallbackBefore, fallbackAfter }
}

function summarizeProjectItems(kind: FeedbackKind, itemsRaw: any, fallback?: any) {
  const items = (Array.isArray(itemsRaw) ? itemsRaw : safeJsonParse(itemsRaw) || [])
    .map((it: any) => {
      const startedAt = toIsoOrNull(it?.started_at)
      const endedAt = toIsoOrNull(it?.ended_at)
      const duration0 = Number(it?.duration_minutes)
      const duration = Number.isFinite(duration0) && duration0 >= 0 ? Math.trunc(duration0) : null
      return {
        id: String(it?.id || '').trim() || require('uuid').v4(),
        name: String(it?.name || '').trim(),
        area: String(it?.area || '').trim() || null,
        category: String(it?.category || '').trim() || null,
        detail: String(it?.detail || '').trim() || null,
        note: String(it?.note || '').trim() || null,
        started_at: startedAt,
        ended_at: endedAt,
        duration_minutes: duration,
        before_photos: normalizeUrlArray(it?.before_photos),
        after_photos: normalizeUrlArray(it?.after_photos),
        status: String(it?.status || '').trim().toLowerCase() === 'completed' ? 'completed' : 'open',
        completed_by: String(it?.completed_by || '').trim() || null,
        completed_at: toIsoOrNull(it?.completed_at),
      } as PropertyFeedbackProjectItem
    })
    .filter((it: PropertyFeedbackProjectItem) => it.name || it.detail || it.note || it.before_photos.length || it.after_photos.length)

  if (!items.length && fallback) {
    const { fallbackBefore, fallbackAfter } = feedbackPhotoFallbacks(kind, fallback)
    const fallbackStatus = mapWorkStatus(fallback?.status) === 'resolved' ? 'completed' : 'open'
    const fallbackProject = {
      id: String(fallback?.id || '').trim() ? `legacy-${String(fallback.id).trim()}` : require('uuid').v4(),
      name:
        kind === 'deep_cleaning'
          ? String(fallback?.project_desc || '').trim() || '深度清洁'
          : String(fallback?.area || fallback?.category || '').trim() || '维修项目',
      area: kind === 'maintenance' ? String(fallback?.area || fallback?.category || '').trim() || null : null,
      category: null,
      detail: String(fallback?.details || fallback?.notes || fallback?.detail || fallback?.remark || '').trim() || null,
      note: String(fallback?.repair_notes || '').trim() || null,
      started_at: kind === 'deep_cleaning' ? toIsoOrNull(fallback?.started_at) : null,
      ended_at: kind === 'deep_cleaning' ? toIsoOrNull(fallback?.ended_at) : null,
      duration_minutes: kind === 'deep_cleaning' && Number.isFinite(Number(fallback?.duration_minutes)) ? Math.trunc(Number(fallback?.duration_minutes)) : null,
      before_photos: fallbackBefore,
      after_photos: fallbackAfter,
      status: fallbackStatus,
      completed_by: null,
      completed_at: toIsoOrNull(fallback?.completed_at),
    } as PropertyFeedbackProjectItem
    items.push(fallbackProject)
  }

  const names = items.map((it: PropertyFeedbackProjectItem) => it.name).filter(Boolean)
  const started = items.map((it: PropertyFeedbackProjectItem) => it.started_at).filter(Boolean).sort()[0] || null
  const ended = items.map((it: PropertyFeedbackProjectItem) => it.ended_at).filter(Boolean).sort().slice(-1)[0] || null
  const duration = items.reduce((sum: number, it: PropertyFeedbackProjectItem) => sum + (Number(it.duration_minutes) || 0), 0)
  const { fallbackBefore, fallbackAfter } = feedbackPhotoFallbacks(kind, fallback)
  const beforePhotos = Array.from(new Set([
    ...items.flatMap((it: PropertyFeedbackProjectItem) => it.before_photos),
    ...fallbackBefore,
  ]))
  const afterPhotos = Array.from(new Set([
    ...items.flatMap((it: PropertyFeedbackProjectItem) => it.after_photos),
    ...fallbackAfter,
  ]))
  const allCompleted = items.length > 0 && items.every((it: PropertyFeedbackProjectItem) => it.status === 'completed')
  const anyCompleted = items.some((it: PropertyFeedbackProjectItem) => it.status === 'completed')
  return {
    items,
    project_desc: names.join('；') || null,
    started_at: started,
    ended_at: ended,
    duration_minutes: duration > 0 ? duration : null,
    photo_urls: beforePhotos,
    repair_photo_urls: afterPhotos,
    status: allCompleted ? 'completed' : anyCompleted ? 'in_progress' : 'pending',
    completed_at: allCompleted ? (items.map((it: PropertyFeedbackProjectItem) => it.completed_at).filter(Boolean).sort().slice(-1)[0] || new Date().toISOString()) : null,
  }
}

async function syncFeedbackWorkTask(kind: FeedbackKind, id: string, status: string) {
  if (!pgPool) return
  const sourceType = kind === 'maintenance' ? 'property_maintenance' : 'property_deep_cleaning'
  const workStatus = mapWorkStatus(status)
  if (workStatus === 'resolved' || workStatus === 'cancelled') {
    await pgPool.query(`DELETE FROM work_tasks WHERE source_type = $1 AND source_id = $2`, [sourceType, id])
    return
  }
  await pgPool.query(`UPDATE work_tasks SET status = $1, updated_at = now() WHERE source_type = $2 AND source_id = $3`, [workStatus === 'in_progress' ? 'in_progress' : 'todo', sourceType, id])
}

async function ensurePropertyDailyNecessitiesColumns() {
  if (!pgPool) return
  if (propertyDailyNecessitiesColumnsEnsured) return
  if (propertyDailyNecessitiesColumnsEnsuring) return propertyDailyNecessitiesColumnsEnsuring
  propertyDailyNecessitiesColumnsEnsuring = (async () => {
    await pgPool.query(`CREATE TABLE IF NOT EXISTS property_daily_necessities (
        id text PRIMARY KEY,
        property_id text,
        created_by text,
        created_at timestamptz DEFAULT now()
      );`)
    await pgPool.query('ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS property_code text;')
    await pgPool.query('ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS status text;')
    await pgPool.query('ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS item_name text;')
    await pgPool.query('ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS quantity integer;')
    await pgPool.query('ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS note text;')
    await pgPool.query('ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS photo_urls jsonb;')
    await pgPool.query('ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS source_task_id text;')
    await pgPool.query('ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS submitted_at timestamptz;')
    await pgPool.query('ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS submitter_name text;')
    await pgPool.query('ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS invoice_description_en text;')
    await pgPool.query('ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS dedup_fingerprint text;')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_property_daily_necessities_prop ON property_daily_necessities(property_id);')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_property_daily_necessities_status ON property_daily_necessities(status);')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_property_daily_necessities_created_at ON property_daily_necessities(created_at);')
    propertyDailyNecessitiesColumnsEnsured = true
  })().catch((e) => {
    propertyDailyNecessitiesColumnsEnsured = false
    propertyDailyNecessitiesColumnsEnsuring = null
    throw e
  }).finally(() => {
    propertyDailyNecessitiesColumnsEnsuring = null
  })
  return propertyDailyNecessitiesColumnsEnsuring
}

router.get('/property-feedbacks', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  const propertyId = String((req.query as any)?.property_id || '').trim()
  const propertyCode = String((req.query as any)?.property_code || '').trim()
  if (!propertyId && !propertyCode) return res.status(400).json({ message: 'missing property_id' })

  const statusRaw = String((req.query as any)?.status || 'open,in_progress').trim()
  const want = statusRaw
    .split(',')
    .map((s) => String(s || '').trim())
    .filter(Boolean)

  const dailyStatusSet = new Set(['need_replace', 'replaced', 'no_action'])
  const dailyWanted = want.filter((s) => dailyStatusSet.has(String(s || '').trim()))
  const dailyFilter = dailyWanted.length ? dailyWanted : ['need_replace']

  const limit0 = Number((req.query as any)?.limit || 20)
  const limit = Number.isFinite(limit0) ? Math.max(1, Math.min(50, limit0)) : 20

  try {
    if (!hasPg || !pgPool) return res.json([])
    const pool = pgPool
    const unresolvedMaintSql = feedbackStatusWhereSql('m', want)
    const unresolvedDeepSql = feedbackStatusWhereSql('d', want)
    const settle = async (label: string, loader: () => Promise<any[]>) => {
      try {
        return { items: await loader(), error: null as string | null }
      } catch (e: any) {
        return { items: [] as any[], error: `${label}:${String(e?.message || e)}`.slice(0, 220) }
      }
    }
    const [maintenanceResult, deepResult, dailyResult] = await Promise.all([
      settle('maintenance', async () => {
        try {
          await ensurePropertyMaintenanceColumns()
        } catch {}
        const r = await pool.query(
          `SELECT m.id, m.property_id, COALESCE(m.property_code, p.code) AS property_code,
                  m.area, m.category_detail, m.details, m.photo_urls, m.repair_photo_urls,
                  m.repair_notes, m.invoice_description_en, m.submitter_name, m.submitted_at, m.created_at, m.status, m.completed_at,
                  m.review_status, m.project_items
             FROM property_maintenance m
             LEFT JOIN properties p ON p.id = m.property_id
            WHERE (
                ($1::text IS NOT NULL AND m.property_id = $1)
                OR (
                  $2::text IS NOT NULL
                  AND (
                    COALESCE(m.property_code, p.code) = $2
                    OR m.property_id = $2
                    OR m.property_id IN (SELECT id FROM properties WHERE code = $2 LIMIT 5)
                  )
                )
              )
              AND (${unresolvedMaintSql})
            ORDER BY COALESCE(m.submitted_at, m.created_at) DESC
            LIMIT $3`,
          [propertyId || null, propertyCode || null, limit],
        )
        return (r?.rows || []).map((row: any) => {
          const summary = summarizeProjectItems('maintenance', row.project_items, row)
          return {
            id: String(row.id),
            property_id: row.property_id ? String(row.property_id) : propertyId || null,
            kind: 'maintenance',
            area: row.area || null,
            category: null,
            detail: String(row.details || ''),
            invoice_description_en: row.invoice_description_en ? String(row.invoice_description_en) : null,
            media_urls: summary.photo_urls,
            repair_photo_urls: summary.repair_photo_urls,
            repair_notes: row.repair_notes ? String(row.repair_notes) : null,
            created_by_name: row.submitter_name || null,
            created_at: row.submitted_at || row.created_at || null,
            status: mapWorkStatus(row.status),
            review_status: row.review_status ? String(row.review_status) : null,
            completed_at: row.completed_at || summary.completed_at || null,
            project_items: summary.items,
          }
        })
      }),
      settle('deep_cleaning', async () => {
        try {
          await ensurePropertyDeepCleaningColumns()
        } catch {}
        const r = await pool.query(
          `SELECT d.id, d.property_id, COALESCE(d.property_code, p.code) AS property_code,
                  d.project_desc, d.details, d.notes, d.photo_urls, d.attachment_urls, d.repair_photo_urls,
                  d.repair_notes, d.invoice_description_en, d.submitter_name, d.submitted_at, d.created_at, d.status, d.completed_at,
                  d.review_status, d.project_items
             FROM property_deep_cleaning d
             LEFT JOIN properties p ON p.id = d.property_id
            WHERE (
                ($1::text IS NOT NULL AND d.property_id = $1)
                OR (
                  $2::text IS NOT NULL
                  AND (
                    COALESCE(d.property_code, p.code) = $2
                    OR d.property_id = $2
                    OR d.property_id IN (SELECT id FROM properties WHERE code = $2 LIMIT 5)
                  )
                )
              )
              AND (${unresolvedDeepSql})
            ORDER BY COALESCE(d.submitted_at, d.created_at) DESC
            LIMIT $3`,
          [propertyId || null, propertyCode || null, limit],
        )
        return (r?.rows || []).map((row: any) => {
          const summary = summarizeProjectItems('deep_cleaning', row.project_items, row)
          return {
            id: String(row.id),
            property_id: row.property_id ? String(row.property_id) : propertyId || null,
            kind: 'deep_cleaning',
            areas: String(row.project_desc || '')
              .split('、')
              .map((s) => String(s || '').trim())
              .filter(Boolean),
            detail: String(row.details || row.notes || ''),
            invoice_description_en: row.invoice_description_en ? String(row.invoice_description_en) : null,
            media_urls: summary.photo_urls,
            repair_photo_urls: summary.repair_photo_urls,
            repair_notes: row.repair_notes ? String(row.repair_notes) : null,
            created_by_name: row.submitter_name || null,
            created_at: row.submitted_at || row.created_at || null,
            status: mapWorkStatus(row.status),
            review_status: row.review_status ? String(row.review_status) : null,
            completed_at: row.completed_at || summary.completed_at || null,
            project_items: summary.items,
          }
        })
      }),
      settle('daily_necessities', async () => {
        try {
          await ensurePropertyDailyNecessitiesColumns()
        } catch {}
        const params: any[] = [propertyId || null, propertyCode || null, dailyFilter, limit]
        const r = await pool.query(
          `SELECT n.id, n.property_id, COALESCE(n.property_code, p.code) AS property_code,
                  n.status, n.item_name, n.quantity, n.note, n.invoice_description_en, n.photo_urls, n.submitter_name,
                  n.submitted_at, n.created_at
             FROM property_daily_necessities n
             LEFT JOIN properties p ON p.id = n.property_id
            WHERE (
                ($1::text IS NOT NULL AND n.property_id = $1)
                OR (
                  $2::text IS NOT NULL
                  AND (
                    COALESCE(n.property_code, p.code) = $2
                    OR n.property_id = $2
                    OR n.property_id IN (SELECT id FROM properties WHERE code = $2 LIMIT 5)
                  )
                )
              )
              AND COALESCE(n.status, '') = ANY($3::text[])
            ORDER BY COALESCE(n.submitted_at, n.created_at) DESC
            LIMIT $4`,
          params,
        )
        return (r?.rows || []).map((row: any) => ({
          id: String(row.id),
          property_id: row.property_id ? String(row.property_id) : propertyId || null,
          kind: 'daily_necessities',
          status: String(row.status || '').trim(),
          item_name: row.item_name ? String(row.item_name) : null,
          quantity: row.quantity == null ? null : Number(row.quantity),
          note: row.note ? String(row.note) : null,
          detail: String(row.note || ''),
          invoice_description_en: row.invoice_description_en ? String(row.invoice_description_en) : null,
          media_urls: Array.isArray(row.photo_urls) ? row.photo_urls : row.photo_urls ? row.photo_urls : [],
          created_by_name: row.submitter_name || null,
          created_at: row.submitted_at || row.created_at || null,
        }))
      }),
    ])
    const out = [
      ...maintenanceResult.items,
      ...deepResult.items,
      ...dailyResult.items,
    ]
    const errors = [
      maintenanceResult.error,
      deepResult.error,
      dailyResult.error,
    ].filter(Boolean) as string[]
    out.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
    if (!out.length && errors.length) return res.status(500).json({ message: 'property_feedbacks_failed', errors })
    return res.json(out.slice(0, limit))
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'property_feedbacks_failed' })
  }
})

router.post('/property-feedbacks', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  const parsed = feedbackCreateSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'pg not available' })
    const now = new Date()
    const createdAt = now.toISOString()
    const occurredAt = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const submitterName = String(user.username || user.sub || '').trim() || 'unknown'
    const createdBy = String(user.sub || '').trim() || submitterName
    const id = require('uuid').v4()
    const duplicateWindowHours = 24

    if (parsed.data.kind === 'maintenance') {
      try {
        await ensurePropertyMaintenanceColumns()
      } catch {}
      const photoType = await getColumnType('property_maintenance', 'photo_urls')
      const invoiceDescriptionEn = String((parsed.data as any).invoice_description_en || '').trim()
      const photoExpr = photoType === 'jsonb' ? '$10::jsonb' : photoType === 'text[]' ? '$10::text[]' : '$10'

      const items = Array.isArray((parsed.data as any).items) && (parsed.data as any).items.length ? ((parsed.data as any).items as any[]) : null
      const prepared = (items || []).map((x) => ({
        area: String(x?.area || '').trim(),
        category: String(x?.category || '').trim(),
        detail: String(x?.detail || '').trim(),
        media_urls: Array.isArray(x?.media_urls) ? (x.media_urls as any[]) : [],
      }))

      if (items) {
        for (const it of prepared) {
          if (!it.area) return res.status(400).json({ message: 'missing area' })
          if (!it.detail) return res.status(400).json({ message: 'missing detail' })
        }
        for (const it of prepared) {
          const fingerprint = makeFeedbackFingerprint({
            kind: 'maintenance',
            property_id: parsed.data.property_id,
            area: it.area,
            category_detail: it.category,
            detail: it.detail,
          })
          const dup = await pgPool.query(
            `SELECT id
               FROM property_maintenance
              WHERE property_id = $1
                AND dedup_fingerprint = $2
                AND (status IS NULL OR lower(status) NOT IN ('completed','done','ready','canceled','cancelled'))
                AND COALESCE(submitted_at, created_at) >= now() - ($3::int * interval '1 hour')
              ORDER BY COALESCE(submitted_at, created_at) DESC
              LIMIT 1`,
            [parsed.data.property_id, fingerprint, duplicateWindowHours],
          )
          if (dup.rowCount) return res.status(409).json({ message: 'duplicate', existing_id: String(dup.rows[0].id) })
        }

        const createdIds: string[] = []
        const createdFeedbacks: Array<{ id: string; summary: string }> = []
        for (const it of prepared) {
          const rowId = require('uuid').v4()
          const workNo = makeWorkNo('R', occurredAt)
          const fingerprint = makeFeedbackFingerprint({
            kind: 'maintenance',
            property_id: parsed.data.property_id,
            area: it.area,
            category_detail: it.category,
            detail: it.detail,
          })
          const photoValue = photoType === 'jsonb' ? JSON.stringify(it.media_urls || []) : (it.media_urls || [])
          await pgPool.query(
            `INSERT INTO property_maintenance(
              id, property_id, occurred_at, details, created_by, created_at,
              status, submitted_at, submitter_name, photo_urls, work_no, area, invoice_description_en, dedup_fingerprint
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,${photoExpr},$11,$12,$13,$14)
            RETURNING id`,
            [
              rowId,
              parsed.data.property_id,
              occurredAt,
              it.detail,
              createdBy,
              createdAt,
              'pending',
              createdAt,
              submitterName,
              photoValue,
              workNo,
              it.area,
              invoiceDescriptionEn || null,
              fingerprint,
            ],
          )
          createdIds.push(rowId)
          createdFeedbacks.push({ id: rowId, summary: it.detail })
        }
        for (const feedback of createdFeedbacks) {
          await notifyPropertyFeedbackCreated({
            id: feedback.id,
            kind: 'maintenance',
            propertyId: parsed.data.property_id,
            sourceTaskId: parsed.data.source_task_id,
            summary: feedback.summary,
            actorUserId: createdBy,
          })
        }
        return res.status(201).json({ ok: true, ids: createdIds })
      }

      const area = String(parsed.data.area || '').trim()
      const detail = String((parsed.data as any).detail || '').trim()
      const singleInvoiceDescriptionEn = String((parsed.data as any).invoice_description_en || '').trim()
      if (!area) return res.status(400).json({ message: 'missing area' })
      if (!detail) return res.status(400).json({ message: 'missing detail' })
      const mediaUrls = (parsed.data as any).media_urls || []
      const photoValue = photoType === 'jsonb' ? JSON.stringify(mediaUrls) : mediaUrls
      const workNo = makeWorkNo('R', occurredAt)
      const fingerprint = makeFeedbackFingerprint({
        kind: 'maintenance',
        property_id: parsed.data.property_id,
        area,
        category_detail: '',
        detail,
      })
      const dup = await pgPool.query(
        `SELECT id
           FROM property_maintenance
          WHERE property_id = $1
            AND dedup_fingerprint = $2
            AND (status IS NULL OR lower(status) NOT IN ('completed','done','ready','canceled','cancelled'))
            AND COALESCE(submitted_at, created_at) >= now() - ($3::int * interval '1 hour')
          ORDER BY COALESCE(submitted_at, created_at) DESC
          LIMIT 1`,
        [parsed.data.property_id, fingerprint, duplicateWindowHours],
      )
      if (dup.rowCount) return res.status(409).json({ message: 'duplicate', existing_id: String(dup.rows[0].id) })
      await pgPool.query(
        `INSERT INTO property_maintenance(
          id, property_id, occurred_at, details, created_by, created_at,
          status, submitted_at, submitter_name, photo_urls, work_no, area, invoice_description_en, dedup_fingerprint
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,${photoExpr},$11,$12,$13,$14)
        RETURNING id`,
        [
          id,
          parsed.data.property_id,
          occurredAt,
          detail,
          createdBy,
          createdAt,
          'pending',
          createdAt,
          submitterName,
          photoValue,
          workNo,
          area,
          singleInvoiceDescriptionEn || null,
          fingerprint,
        ],
      )
      await notifyPropertyFeedbackCreated({
        id,
        kind: 'maintenance',
        propertyId: parsed.data.property_id,
        sourceTaskId: parsed.data.source_task_id,
        summary: detail,
        actorUserId: createdBy,
      })
      return res.status(201).json({ ok: true, id })
    }

    if (parsed.data.kind === 'daily_necessities') {
      try {
        await ensurePropertyDailyNecessitiesColumns()
      } catch {}
      const status = String((parsed.data as any).status || '').trim()
      const itemName = String((parsed.data as any).item_name || '').trim()
      const quantity0 = (parsed.data as any).quantity
      const quantity = quantity0 == null ? NaN : Number(quantity0)
      const note = String((parsed.data as any).note || '').trim()
      const invoiceDescriptionEn = String((parsed.data as any).invoice_description_en || '').trim()
      const mediaUrls = Array.isArray((parsed.data as any).media_urls) ? (parsed.data as any).media_urls : []
      if (!dailyNecessitiesStatusSchema.safeParse(status).success) return res.status(400).json({ message: 'invalid status' })
      if (!itemName) return res.status(400).json({ message: 'missing item_name' })
      if (!Number.isFinite(quantity) || quantity < 1) return res.status(400).json({ message: 'invalid quantity' })
      if (!note && !mediaUrls.length) return res.status(400).json({ message: 'missing note' })

      const fingerprint = sha256Hex([parsed.data.property_id, status, normalizeForFingerprint(itemName), String(quantity), normalizeForFingerprint(note)].join('|'))
      const dup = await pgPool.query(
        `SELECT id
           FROM property_daily_necessities
          WHERE property_id = $1
            AND dedup_fingerprint = $2
            AND COALESCE(submitted_at, created_at) >= now() - ($3::int * interval '1 hour')
          ORDER BY COALESCE(submitted_at, created_at) DESC
          LIMIT 1`,
        [parsed.data.property_id, fingerprint, duplicateWindowHours],
      )
      if (dup.rowCount) return res.status(409).json({ message: 'duplicate', existing_id: String(dup.rows[0].id) })

      await pgPool.query(
        `INSERT INTO property_daily_necessities(
          id, property_id, status, item_name, quantity, note, photo_urls,
          source_task_id, created_by, created_at, submitted_at, submitter_name, invoice_description_en, dedup_fingerprint
        ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14)
        RETURNING id`,
        [
          id,
          parsed.data.property_id,
          status,
          itemName,
          Math.trunc(quantity),
          note || null,
          JSON.stringify(mediaUrls),
          (parsed.data as any).source_task_id || null,
          createdBy,
          createdAt,
          createdAt,
          submitterName,
          invoiceDescriptionEn || null,
          fingerprint,
        ],
      )
      await notifyPropertyFeedbackCreated({
        id,
        kind: 'daily_necessities',
        propertyId: parsed.data.property_id,
        sourceTaskId: parsed.data.source_task_id,
        summary: note || `${itemName} × ${Math.trunc(quantity)}`,
        actorUserId: createdBy,
      })
      return res.status(201).json({ ok: true, id })
    }

    const areas = parsed.data.areas || []
    if (!areas.length) return res.status(400).json({ message: 'missing areas' })
    const mediaUrls = parsed.data.media_urls || []
    if (!mediaUrls.length) return res.status(400).json({ message: 'missing photos' })
    const detail = String((parsed.data as any).detail || '').trim()
    const invoiceDescriptionEn = String((parsed.data as any).invoice_description_en || '').trim()
    if (!detail) return res.status(400).json({ message: 'missing detail' })
    const projectDesc = areas.join('、')
    const deepPhotoType = await getColumnType('property_deep_cleaning', 'photo_urls')
    const deepAttachType = await getColumnType('property_deep_cleaning', 'attachment_urls')
    const photoExpr = deepPhotoType === 'jsonb' ? '$12::jsonb' : deepPhotoType === 'text[]' ? '$12::text[]' : '$12'
    const attachExpr = deepAttachType === 'jsonb' ? '$13::jsonb' : deepAttachType === 'text[]' ? '$13::text[]' : '$13'
    const photoValue = deepPhotoType === 'jsonb' ? JSON.stringify(mediaUrls) : mediaUrls
    const attachValue = deepAttachType === 'jsonb' ? JSON.stringify(mediaUrls) : mediaUrls
    const workNo = makeWorkNo('DC', occurredAt)
    await pgPool.query('ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS dedup_fingerprint text;')
    const fingerprint = makeFeedbackFingerprint({
      kind: 'deep_cleaning',
      property_id: parsed.data.property_id,
      areas,
      detail,
    })
    const dup = await pgPool.query(
      `SELECT id
         FROM property_deep_cleaning
        WHERE property_id = $1
          AND dedup_fingerprint = $2
          AND (status IS NULL OR lower(status) NOT IN ('completed','done','ready','canceled','cancelled'))
          AND COALESCE(submitted_at, created_at) >= now() - ($3::int * interval '1 hour')
        ORDER BY COALESCE(submitted_at, created_at) DESC
        LIMIT 1`,
      [parsed.data.property_id, fingerprint, duplicateWindowHours],
    )
    if (dup.rowCount) return res.status(409).json({ message: 'duplicate', existing_id: String(dup.rows[0].id) })
    await pgPool.query(
      `INSERT INTO property_deep_cleaning(
        id, property_id, occurred_at, project_desc, details, created_by, created_at,
        status, submitted_at, submitter_name, work_no, photo_urls, attachment_urls, review_status, invoice_description_en, dedup_fingerprint
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,${photoExpr},${attachExpr},$14,$15,$16)
      RETURNING id`,
      [
        id,
        parsed.data.property_id,
        occurredAt,
        projectDesc,
        detail,
        createdBy,
        createdAt,
        'pending',
        createdAt,
        submitterName,
        workNo,
        photoValue,
        attachValue,
        'pending',
        invoiceDescriptionEn || null,
        fingerprint,
      ],
    )
    try {
      await pgPool.query(
        `UPDATE property_deep_cleaning
            SET work_no = COALESCE(NULLIF(work_no, ''), $2)
          WHERE id = $1`,
        [id, workNo],
      )
    } catch {}
    await notifyPropertyFeedbackCreated({
      id,
      kind: 'deep_cleaning',
      propertyId: parsed.data.property_id,
      sourceTaskId: parsed.data.source_task_id,
      summary: detail,
      actorUserId: createdBy,
    })
    return res.status(201).json({ ok: true, id })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'property_feedbacks_create_failed' })
  }
})

async function loadPropertyFeedbackRow(kind: FeedbackKind, id: string) {
  if (!pgPool) return null
  if (kind === 'maintenance') {
    await ensurePropertyMaintenanceColumns()
    const r = await pgPool.query(
      `SELECT *, 'property_maintenance'::text AS feedback_source_table FROM property_maintenance WHERE id = $1 LIMIT 1`,
      [id],
    )
    return r.rows?.[0] || null
  }
  await ensurePropertyDeepCleaningColumns()
  const r = await pgPool.query(`SELECT * FROM property_deep_cleaning WHERE id = $1 LIMIT 1`, [id])
  return r.rows?.[0] || null
}

router.patch('/property-feedbacks/:kind/:id', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  if (!hasPg || !pgPool) return res.status(500).json({ message: 'pg not available' })
  const kind = String(req.params.kind || '').trim()
  const id = String(req.params.id || '').trim()
  if (kind !== 'maintenance' && kind !== 'deep_cleaning' && kind !== 'daily_necessities') return res.status(400).json({ message: 'invalid kind' })
  const parsed = feedbackPatchSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (kind === 'maintenance') {
      await ensurePropertyMaintenanceColumns()
      const row = await loadPropertyFeedbackRow('maintenance', id)
      if (!row) return res.status(404).json({ message: 'not found' })
      const nextArea = parsed.data.area !== undefined ? String(parsed.data.area || '').trim() : String(row.area || '').trim()
      const nextDetail = parsed.data.detail !== undefined ? String(parsed.data.detail || '').trim() : String(row.details || '').trim()
      const nextNote = parsed.data.note !== undefined ? String(parsed.data.note || '').trim() : String(row.repair_notes || '').trim()
      const nextInvoiceDescriptionEn = parsed.data.invoice_description_en !== undefined ? String(parsed.data.invoice_description_en || '').trim() : String(row.invoice_description_en || '').trim()
      const nextMedia = parsed.data.media_urls !== undefined ? normalizeUrlArray(parsed.data.media_urls) : normalizeUrlArray(row.photo_urls)
      const nextRepairMedia = parsed.data.repair_photo_urls !== undefined ? normalizeUrlArray(parsed.data.repair_photo_urls) : normalizeUrlArray(row.repair_photo_urls)
      const currentResolved = mapWorkStatus(row.status) === 'resolved'
      const markCompleted = currentResolved || nextRepairMedia.length > 0
      const nextStatus = markCompleted ? 'completed' : String(row.status || '').trim() || 'pending'
      const nextReviewStatus = markCompleted ? 'pending' : (row.review_status ? String(row.review_status) : null)
      const nextCompletedAt = markCompleted ? (row.completed_at || new Date().toISOString()) : null
      if (!nextArea || !nextDetail) return res.status(400).json({ message: 'missing maintenance fields' })
      const beforeType = await getColumnType('property_maintenance', 'photo_urls')
      const afterType = await getColumnType('property_maintenance', 'repair_photo_urls')
      const beforeExpr = beforeType === 'text[]' ? '$4::text[]' : '$4::jsonb'
      const afterExpr = afterType === 'text[]' ? '$6::text[]' : '$6::jsonb'
      await pgPool.query(
        `UPDATE property_maintenance
            SET area = $2,
                details = $3,
                photo_urls = ${beforeExpr},
                repair_notes = $5,
                repair_photo_urls = ${afterExpr},
                invoice_description_en = $7,
                status = $8,
                review_status = $9,
                completed_at = $10,
                updated_at = now()
          WHERE id = $1`,
        [
          id,
          nextArea,
          nextDetail,
          beforeType === 'text[]' ? nextMedia : JSON.stringify(nextMedia),
          nextNote || null,
          afterType === 'text[]' ? nextRepairMedia : JSON.stringify(nextRepairMedia),
          nextInvoiceDescriptionEn || null,
          nextStatus,
          nextReviewStatus,
          nextCompletedAt,
        ],
      )
      await refreshAutoExpenseSourceSummary('maintenance', {
        id,
        details: nextDetail,
        repair_notes: nextNote || null,
        invoice_description_en: nextInvoiceDescriptionEn || null,
      })
      return res.json({
        ok: true,
        row: {
          id,
          property_id: row.property_id ? String(row.property_id) : null,
          kind: 'maintenance',
          area: nextArea,
          category: null,
          detail: nextDetail,
          invoice_description_en: nextInvoiceDescriptionEn || null,
          note: nextNote || null,
          repair_notes: nextNote || null,
          media_urls: nextMedia,
          repair_photo_urls: nextRepairMedia,
          created_by_name: row.submitter_name ? String(row.submitter_name) : null,
          created_at: row.submitted_at || row.created_at || null,
          status: mapWorkStatus(nextStatus),
          review_status: nextReviewStatus,
          completed_at: nextCompletedAt,
        },
      })
    }
    if (kind === 'deep_cleaning') {
      await ensurePropertyDeepCleaningColumns()
      const existing = await pgPool.query(`SELECT * FROM property_deep_cleaning WHERE id = $1 LIMIT 1`, [id])
      if (!existing.rowCount) return res.status(404).json({ message: 'not found' })
      const row = existing.rows[0]
      const nextAreas = parsed.data.areas !== undefined ? parsed.data.areas.map((x) => String(x || '').trim()).filter(Boolean) : String(row.project_desc || '').split('、').map((x: string) => String(x || '').trim()).filter(Boolean)
      const nextDetail = parsed.data.detail !== undefined ? String(parsed.data.detail || '').trim() : String(row.details || row.notes || '').trim()
      const nextNote = parsed.data.note !== undefined ? String(parsed.data.note || '').trim() : String(row.repair_notes || '').trim()
      const nextInvoiceDescriptionEn = parsed.data.invoice_description_en !== undefined ? String(parsed.data.invoice_description_en || '').trim() : String(row.invoice_description_en || '').trim()
      const nextMedia = parsed.data.media_urls !== undefined ? normalizeUrlArray(parsed.data.media_urls) : normalizeUrlArray(row.photo_urls)
      const nextRepairMedia = parsed.data.repair_photo_urls !== undefined ? normalizeUrlArray(parsed.data.repair_photo_urls) : normalizeUrlArray(row.repair_photo_urls)
      const currentResolved = mapWorkStatus(row.status) === 'resolved'
      const markCompleted = currentResolved || nextRepairMedia.length > 0
      const nextStatus = markCompleted ? 'completed' : String(row.status || '').trim() || 'pending'
      const nextReviewStatus = markCompleted ? 'pending' : (row.review_status ? String(row.review_status) : null)
      const nextCompletedAt = markCompleted ? (row.completed_at || new Date().toISOString()) : null
      if (!nextAreas.length || !nextDetail) return res.status(400).json({ message: 'missing deep cleaning fields' })
      const beforeType = await getColumnType('property_deep_cleaning', 'photo_urls')
      const attachmentType = await getColumnType('property_deep_cleaning', 'attachment_urls')
      const afterType = await getColumnType('property_deep_cleaning', 'repair_photo_urls')
      const beforeExpr = beforeType === 'text[]' ? '$4::text[]' : '$4::jsonb'
      const attachmentExpr = attachmentType === 'text[]' ? '$5::text[]' : '$5::jsonb'
      const afterExpr = afterType === 'text[]' ? '$7::text[]' : '$7::jsonb'
      await pgPool.query(
        `UPDATE property_deep_cleaning
            SET project_desc = $2,
                details = $3,
                notes = $3,
                photo_urls = ${beforeExpr},
                attachment_urls = ${attachmentExpr},
                repair_notes = $6,
                repair_photo_urls = ${afterExpr},
                invoice_description_en = $8,
                status = $9,
                review_status = $10,
                completed_at = $11,
                updated_at = now()
          WHERE id = $1`,
        [
          id,
          nextAreas.join('、'),
          nextDetail,
          beforeType === 'text[]' ? nextMedia : JSON.stringify(nextMedia),
          attachmentType === 'text[]' ? nextMedia : JSON.stringify(nextMedia),
          nextNote || null,
          afterType === 'text[]' ? nextRepairMedia : JSON.stringify(nextRepairMedia),
          nextInvoiceDescriptionEn || null,
          nextStatus,
          nextReviewStatus,
          nextCompletedAt,
        ],
      )
      await refreshAutoExpenseSourceSummary('deep_cleaning', {
        id,
        project_desc: nextAreas.join('、'),
        details: nextDetail,
        notes: nextDetail,
        repair_notes: nextNote || null,
        invoice_description_en: nextInvoiceDescriptionEn || null,
      })
      return res.json({
        ok: true,
        row: {
          id,
          property_id: row.property_id ? String(row.property_id) : null,
          kind: 'deep_cleaning',
          areas: nextAreas,
          detail: nextDetail,
          invoice_description_en: nextInvoiceDescriptionEn || null,
          note: nextNote || null,
          repair_notes: nextNote || null,
          media_urls: nextMedia,
          repair_photo_urls: nextRepairMedia,
          created_by_name: row.submitter_name ? String(row.submitter_name) : null,
          created_at: row.submitted_at || row.created_at || null,
          status: mapWorkStatus(nextStatus),
          review_status: nextReviewStatus,
          completed_at: nextCompletedAt,
        },
      })
    }
    await ensurePropertyDailyNecessitiesColumns()
    const existing = await pgPool.query(`SELECT * FROM property_daily_necessities WHERE id = $1 LIMIT 1`, [id])
    if (!existing.rowCount) return res.status(404).json({ message: 'not found' })
    const row = existing.rows[0]
    const nextStatus = parsed.data.status !== undefined ? String(parsed.data.status || '').trim() : String(row.status || '').trim()
    const nextItemName = parsed.data.item_name !== undefined ? String(parsed.data.item_name || '').trim() : String(row.item_name || '').trim()
    const nextQuantity = parsed.data.quantity !== undefined ? Math.trunc(Number(parsed.data.quantity)) : Math.trunc(Number(row.quantity || 0))
    const nextNote = parsed.data.note !== undefined ? String(parsed.data.note || '').trim() : String(row.note || '').trim()
    const nextInvoiceDescriptionEn = parsed.data.invoice_description_en !== undefined ? String(parsed.data.invoice_description_en || '').trim() : String(row.invoice_description_en || '').trim()
    const nextMedia = parsed.data.media_urls !== undefined ? normalizeUrlArray(parsed.data.media_urls) : normalizeUrlArray(row.photo_urls)
    if (!dailyNecessitiesStatusSchema.safeParse(nextStatus).success) return res.status(400).json({ message: 'invalid status' })
    if (!nextItemName) return res.status(400).json({ message: 'missing item_name' })
    if (!Number.isFinite(nextQuantity) || nextQuantity < 1) return res.status(400).json({ message: 'invalid quantity' })
    if (!nextNote && !nextMedia.length) return res.status(400).json({ message: 'missing note' })
    const photoType = await getColumnType('property_daily_necessities', 'photo_urls')
    const photoExpr = photoType === 'text[]' ? '$6::text[]' : '$6::jsonb'
    await pgPool.query(
      `UPDATE property_daily_necessities
          SET status = $2,
              item_name = $3,
              quantity = $4,
              note = $5,
              photo_urls = ${photoExpr},
              invoice_description_en = $7
        WHERE id = $1`,
      [id, nextStatus, nextItemName, nextQuantity, nextNote || null, photoType === 'text[]' ? nextMedia : JSON.stringify(nextMedia), nextInvoiceDescriptionEn || null],
    )
    return res.json({
      ok: true,
      row: {
        id,
        property_id: row.property_id ? String(row.property_id) : null,
        kind: 'daily_necessities',
        item_name: nextItemName,
        quantity: nextQuantity,
        note: nextNote || null,
        detail: nextNote || '',
        invoice_description_en: nextInvoiceDescriptionEn || null,
        media_urls: nextMedia,
        created_by_name: row.submitter_name ? String(row.submitter_name) : null,
        created_at: row.submitted_at || row.created_at || null,
        status: nextStatus,
      },
    })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'property_feedback_patch_failed' })
  }
})

function projectStatusFromItems(items: PropertyFeedbackProjectItem[]) {
  if (!items.length) return 'pending'
  if (items.every((it) => it.status === 'completed')) return 'completed'
  if (items.some((it) => it.status === 'completed')) return 'in_progress'
  return 'pending'
}

async function persistFeedbackProjects(kind: FeedbackKind, row: any, items: PropertyFeedbackProjectItem[]) {
  if (!pgPool) throw new Error('pg not available')
  const summary = summarizeProjectItems(kind, items)
  const status = projectStatusFromItems(summary.items)
  const sourceTable = kind === 'maintenance' ? 'property_maintenance' : 'property_deep_cleaning'
  const reviewStatus = status === 'completed' ? 'pending' : (row?.review_status ? String(row.review_status) : 'pending')
  const projectJson = JSON.stringify(summary.items)
  const beforeJson = JSON.stringify(summary.photo_urls)
  const afterJson = JSON.stringify(summary.repair_photo_urls)
  if (kind === 'maintenance') {
    const beforeType = await getColumnType(sourceTable, 'photo_urls')
    const afterType = await getColumnType(sourceTable, 'repair_photo_urls')
    const beforeExpr = beforeType === 'text[]' ? '$5::text[]' : '$5::jsonb'
    const afterExpr = afterType === 'text[]' ? '$6::text[]' : '$6::jsonb'
    await pgPool.query(
      `UPDATE property_maintenance
          SET project_items = $2::jsonb,
              details = COALESCE(NULLIF($3, ''), details),
              notes = COALESCE(NULLIF($4, ''), notes),
              photo_urls = ${beforeExpr},
              repair_photo_urls = ${afterExpr},
              repair_notes = $7,
              status = $8,
              completed_at = $9::timestamptz,
              review_status = $10,
              updated_at = now()
        WHERE id = $1`,
      [
        row.id,
        projectJson,
        summary.project_desc || '',
        summary.project_desc || '',
        beforeType === 'text[]' ? summary.photo_urls : beforeJson,
        afterType === 'text[]' ? summary.repair_photo_urls : afterJson,
        String(row?.repair_notes || '').trim() || null,
        status,
        summary.completed_at,
        reviewStatus,
      ],
    )
  } else {
    const beforeType = await getColumnType(sourceTable, 'photo_urls')
    const afterType = await getColumnType(sourceTable, 'repair_photo_urls')
    const beforeExpr = beforeType === 'text[]' ? '$7::text[]' : '$7::jsonb'
    const afterExpr = afterType === 'text[]' ? '$8::text[]' : '$8::jsonb'
    await pgPool.query(
      `UPDATE property_deep_cleaning
          SET project_items = $2::jsonb,
              project_desc = COALESCE(NULLIF($3, ''), project_desc),
              started_at = $4::timestamptz,
              ended_at = $5::timestamptz,
              duration_minutes = $6,
              photo_urls = ${beforeExpr},
              repair_photo_urls = ${afterExpr},
              repair_notes = $9,
              status = $10,
              completed_at = $11::timestamptz,
              review_status = $12,
              updated_at = now()
        WHERE id = $1`,
      [
        row.id,
        projectJson,
        summary.project_desc || '',
        summary.started_at,
        summary.ended_at,
        summary.duration_minutes,
        beforeType === 'text[]' ? summary.photo_urls : beforeJson,
        afterType === 'text[]' ? summary.repair_photo_urls : afterJson,
        String(row?.repair_notes || '').trim() || null,
        status,
        summary.completed_at,
        reviewStatus,
      ],
    )
  }
  await syncFeedbackWorkTask(kind, String(row.id), status)
  return loadPropertyFeedbackRow(kind, String(row.id))
}

router.post('/property-feedbacks/:kind/:id/projects', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  const kind = String(req.params.kind || '').trim() as FeedbackKind
  const id = String(req.params.id || '').trim()
  if (kind !== 'maintenance' && kind !== 'deep_cleaning') return res.status(400).json({ message: 'invalid kind' })
  const parsed = feedbackProjectCreateSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    const row = await loadPropertyFeedbackRow(kind, id)
    if (!row) return res.status(404).json({ message: 'not found' })
    const current = summarizeProjectItems(kind, row.project_items, row).items
    const item: PropertyFeedbackProjectItem = {
      id: require('uuid').v4(),
      name: String(parsed.data.name || '').trim(),
      area: String(parsed.data.area || '').trim() || null,
      category: kind === 'maintenance' ? String(parsed.data.category || '').trim() || null : null,
      detail: kind === 'maintenance' ? String(parsed.data.detail || '').trim() || null : null,
      note: kind === 'deep_cleaning' ? String(parsed.data.note || '').trim() || null : String(parsed.data.note || '').trim() || null,
      started_at: null,
      ended_at: null,
      duration_minutes: null,
      before_photos: [],
      after_photos: [],
      status: 'open',
      completed_by: null,
      completed_at: null,
    }
    const updated = await persistFeedbackProjects(kind, row, [...current, item])
    return res.status(201).json({ ok: true, item, row: updated })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'property_feedback_project_create_failed' })
  }
})

router.patch('/property-feedbacks/:kind/:id/projects/:projectId', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  const kind = String(req.params.kind || '').trim() as FeedbackKind
  const id = String(req.params.id || '').trim()
  const projectId = String(req.params.projectId || '').trim()
  if (kind !== 'maintenance' && kind !== 'deep_cleaning') return res.status(400).json({ message: 'invalid kind' })
  const parsed = feedbackProjectPatchSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    const row = await loadPropertyFeedbackRow(kind, id)
    if (!row) return res.status(404).json({ message: 'not found' })
    const current = summarizeProjectItems(kind, row.project_items, row).items
    const found = current.find((it: PropertyFeedbackProjectItem) => it.id === projectId)
    if (!found) return res.status(404).json({ message: 'project_not_found' })
    Object.assign(found, {
      name: parsed.data.name !== undefined ? String(parsed.data.name || '').trim() : found.name,
      area: parsed.data.area !== undefined ? String(parsed.data.area || '').trim() || null : found.area,
      category: kind === 'maintenance' && parsed.data.category !== undefined ? String(parsed.data.category || '').trim() || null : found.category,
      detail: parsed.data.detail !== undefined ? String(parsed.data.detail || '').trim() || null : found.detail,
      note: parsed.data.note !== undefined ? String(parsed.data.note || '').trim() || null : found.note,
    })
    const updated = await persistFeedbackProjects(kind, row, current)
    return res.json({ ok: true, item: found, row: updated })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'property_feedback_project_patch_failed' })
  }
})

router.post('/property-feedbacks/:kind/:id/projects/:projectId/complete', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  const kind = String(req.params.kind || '').trim() as FeedbackKind
  const id = String(req.params.id || '').trim()
  const projectId = String(req.params.projectId || '').trim()
  if (kind !== 'maintenance' && kind !== 'deep_cleaning') return res.status(400).json({ message: 'invalid kind' })
  const parsed = feedbackProjectCompleteSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    const row = await loadPropertyFeedbackRow(kind, id)
    if (!row) return res.status(404).json({ message: 'not found' })
    const current = summarizeProjectItems(kind, row.project_items, row).items
    const found = current.find((it: PropertyFeedbackProjectItem) => it.id === projectId)
    if (!found) return res.status(404).json({ message: 'project_not_found' })
    const afterPhotos = normalizeUrlArray(parsed.data.after_photos)
    const beforePhotos = normalizeUrlArray(parsed.data.before_photos)
    const note = String(parsed.data.note || '').trim()
    if (!afterPhotos.length) return res.status(400).json({ message: 'missing after_photos' })
    if (kind === 'deep_cleaning') {
      const startedAt = toIsoOrNull(parsed.data.started_at)
      const endedAt = toIsoOrNull(parsed.data.ended_at)
      if (!startedAt || !endedAt) return res.status(400).json({ message: 'missing started_or_ended_at' })
      if (endedAt < startedAt) return res.status(400).json({ message: 'ended_before_started' })
      if (!beforePhotos.length) return res.status(400).json({ message: 'missing before_photos' })
      found.started_at = startedAt
      found.ended_at = endedAt
      found.duration_minutes = Math.max(0, Math.trunc((new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 60000))
      found.before_photos = beforePhotos
      found.note = note || found.note
    } else if (beforePhotos.length) {
      found.before_photos = beforePhotos
    } else if (!found.before_photos.length) {
      found.before_photos = normalizeUrlArray(row.photo_urls)
    }
    if (parsed.data.detail !== undefined) found.detail = String(parsed.data.detail || '').trim() || found.detail
    found.after_photos = afterPhotos
    found.status = 'completed'
    found.completed_by = String(user.username || user.sub || '').trim() || 'unknown'
    found.completed_at = new Date().toISOString()
    if (note) found.note = note
    row.repair_notes = note || row.repair_notes || found.note || null
    const updated = await persistFeedbackProjects(kind, row, current)
    return res.json({ ok: true, item: found, row: updated })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'property_feedback_project_complete_failed' })
  }
})

function urgencyRank(u: string) {
  const s = String(u || '').trim().toLowerCase()
  if (s === 'urgent') return 3
  if (s === 'high') return 2
  if (s === 'medium') return 1
  return 0
}
