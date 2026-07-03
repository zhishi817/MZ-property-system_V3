import { Router } from 'express'
import { requireAnyPerm, requirePerm, userHasAnyPerm } from '../auth'
import { addAudit } from '../store'
import { hasPg, pgPool, pgRunInTransaction } from '../dbAdapter'
import { z } from 'zod'

export const router = Router()

function currentMonthKeyAU(): string {
  const parts = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit' }).formatToParts(new Date())
  let y = '', m = ''
  for (const p of parts) { if ((p as any).type === 'year') y = (p as any).value; if ((p as any).type === 'month') m = (p as any).value }
  return `${y}-${m}`
}

function currentDateISOAU(): string {
  const parts = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())
  let y = '', m = '', d = ''
  for (const p of parts) {
    if ((p as any).type === 'year') y = (p as any).value
    if ((p as any).type === 'month') m = (p as any).value
    if ((p as any).type === 'day') d = (p as any).value
  }
  return `${y}-${m}-${d}`
}

function addDaysISO(dateISO: string, days: number): string | null {
  const iso = toISODate(dateISO)
  if (!iso) return null
  const dt = new Date(`${iso}T00:00:00Z`)
  if (Number.isNaN(dt.getTime())) return null
  dt.setUTCDate(dt.getUTCDate() + Number(days || 0))
  return dt.toISOString().slice(0, 10)
}

function computeDueISO(monthKey: string, dueDay: number): string {
  const [ys, ms] = String(monthKey).split('-')
  const y = Number(ys)
  const m = Number(ms)
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const d = Math.min(Number(dueDay || 1), lastDay)
  return `${String(y)}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`
}

function toISODate(v: any): string | null {
  if (!v) return null
  if (v instanceof Date && !isNaN(v.getTime())) return v.toISOString().slice(0, 10)
  const s = String(v)
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
  const d = new Date(s)
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10)
  return null
}

function monthKeyToIndex(monthKey: string): number {
  const [ys, ms] = String(monthKey).split('-')
  const y = Number(ys)
  const m = Number(ms)
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return NaN
  return y * 12 + (m - 1)
}

function indexToMonthKey(idx: number): string {
  const y = Math.floor(idx / 12)
  const m = (idx % 12) + 1
  return `${String(y)}-${String(m).padStart(2, '0')}`
}

function prevMonthKey(monthKey: string): string | null {
  const idx = monthKeyToIndex(monthKey)
  if (!Number.isFinite(idx)) return null
  if (idx <= 0) return null
  return indexToMonthKey(idx - 1)
}

function monthKeysBetween(start: string, end: string): string[] {
  const a = monthKeyToIndex(start)
  const b = monthKeyToIndex(end)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return []
  if (a > b) return []
  const out: string[] = []
  for (let i = a; i <= b; i++) out.push(indexToMonthKey(i))
  return out
}

export function isDueMonthKey(start: string, monthKey: string, freqMonths: number): boolean {
  const freq = Math.max(1, Math.min(24, Number(freqMonths || 1)))
  const s = monthKeyToIndex(start)
  const m = monthKeyToIndex(monthKey)
  if (!Number.isFinite(s) || !Number.isFinite(m)) return false
  if (m < s) return false
  return ((m - s) % freq) === 0
}

function dueMonthKeysBetween(start: string, end: string, freqMonths: number): string[] {
  const freq = Math.max(1, Math.min(24, Number(freqMonths || 1)))
  const a = monthKeyToIndex(start)
  const b = monthKeyToIndex(end)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return []
  if (a > b) return []
  const out: string[] = []
  for (let i = a; i <= b; i += freq) out.push(indexToMonthKey(i))
  return out
}

const RECURRING_SNAPSHOT_CONFLICT_WHERE = `fixed_expense_id IS NOT NULL AND fixed_expense_id <> '' AND month_key IS NOT NULL AND month_key <> ''`
const TEMPLATE_KIND_FIXED_EXPENSE = 'fixed_expense'
const TEMPLATE_KIND_PROPERTY_PAYABLE = 'property_payable'
const PROPERTY_PAYABLE_MENU_PERM = 'menu.finance.property_payables.visible'
export const PROPERTY_PAYABLE_FIXED_DUE_DAY_OF_MONTH = 30
export const PROPERTY_PAYABLE_PAYMENT_GRACE_DAYS = 5
const PROPERTY_PAYABLE_ALLOWED_FREQUENCY_MONTHS = [1, 2, 3, 6, 12] as const

export function normalizePropertyPayableFrequencyMonths(value: any): number {
  const n = Number(value || 1)
  if (!Number.isFinite(n)) return 1
  const whole = Math.trunc(n)
  return (PROPERTY_PAYABLE_ALLOWED_FREQUENCY_MONTHS as readonly number[]).includes(whole) ? whole : 1
}

type RecurringSnapshotPayload = {
  fixedExpenseId: string
  monthKey: string
  occurredAt: string
  amount: number
  category?: string | null
  categoryDetail?: string | null
  dueDate: string
  paidDate?: string | null
  status: 'paid' | 'unpaid'
  propertyId?: string | null
}

type PropertyPayableSnapshotRow = {
  id: string
  fixed_expense_id: string
  month_key: string
  property_id?: string | null
  amount?: number
  due_date?: string | null
  bill_expected_date?: string | null
  bill_received_date?: string | null
  bill_period_start?: string | null
  bill_period_end?: string | null
  paid_date?: string | null
  status?: string | null
  note?: string | null
  amount_confirmed?: boolean | null
  amount_confirmed_by?: string | null
  amount_confirmed_at?: string | null
  paid_by?: string | null
  paid_confirmed_at?: string | null
}

export function computeMonthDayISO(monthKey: string, dayOfMonth: any, monthOffset = 0): string | null {
  const baseIdx = monthKeyToIndex(monthKey)
  if (!Number.isFinite(baseIdx)) return null
  const targetMonthKey = indexToMonthKey(baseIdx + Number(monthOffset || 0))
  const [ys, ms] = targetMonthKey.split('-')
  const y = Number(ys)
  const m = Number(ms)
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return null
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const requested = Math.max(1, Math.floor(Number(dayOfMonth || 1)))
  const d = Math.min(requested, lastDay)
  return `${String(y)}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

export function computePropertyPayableTemplateDates(payment: any, monthKey: string) {
  const expectedRaw = payment?.bill_expected_day_of_month
  return {
    due_date: computeDueISO(monthKey, PROPERTY_PAYABLE_FIXED_DUE_DAY_OF_MONTH),
    bill_expected_date: expectedRaw == null || expectedRaw === '' ? null : computeMonthDayISO(monthKey, expectedRaw, 0),
    bill_period_start: null,
    bill_period_end: null,
  }
}

function normalizePropertyPayableTemplatePayload(payload: Record<string, any>, fallback?: Record<string, any> | null) {
  if (String(payload?.template_kind || '') !== TEMPLATE_KIND_PROPERTY_PAYABLE) return payload
  payload.scope = 'property'
  payload.due_day_of_month = PROPERTY_PAYABLE_FIXED_DUE_DAY_OF_MONTH
  const frequencySource = Object.prototype.hasOwnProperty.call(payload, 'frequency_months')
    ? payload.frequency_months
    : fallback?.frequency_months
  payload.frequency_months = normalizePropertyPayableFrequencyMonths(frequencySource)
  payload.bill_period_start_day_of_month = null
  payload.bill_period_start_month_offset = 0
  payload.bill_period_end_day_of_month = null
  payload.bill_period_end_month_offset = 0
  return payload
}

function buildRecurringSnapshotPayload(input: RecurringSnapshotPayload) {
  const { v4: uuid } = require('uuid')
  return {
    id: uuid(),
    occurred_at: input.occurredAt,
    amount: input.amount,
    currency: 'AUD',
    category: input.category || 'other',
    category_detail: input.categoryDetail || null,
    note: 'Fixed payment snapshot',
    generated_from: 'recurring_payments',
    fixed_expense_id: input.fixedExpenseId,
    month_key: input.monthKey,
    due_date: input.dueDate,
    paid_date: input.paidDate || null,
    status: input.status,
    property_id: input.propertyId || null,
  }
}

function isPropertyPayableTemplate(row: any): boolean {
  return String((row as any)?.template_kind || TEMPLATE_KIND_FIXED_EXPENSE) === TEMPLATE_KIND_PROPERTY_PAYABLE
}

async function canAccessPropertyPayables(req: any): Promise<boolean> {
  return userHasAnyPerm(req?.user || {}, [PROPERTY_PAYABLE_MENU_PERM])
}

function normalizeBool(v: any): boolean {
  return v === true || v === 'true' || v === 1 || v === '1'
}

function recurringActorId(req: any): string | null {
  const raw = String(req?.user?.sub || req?.user?.username || '').trim()
  return raw || null
}

function recurringActorLabel(req: any): string | null {
  const raw = String(req?.user?.username || req?.user?.sub || '').trim()
  return raw || null
}

async function upsertRecurringSnapshotTx(client: any, table: 'property_expenses' | 'company_expenses', payload0: RecurringSnapshotPayload) {
  const scope = table === 'property_expenses' ? 'property' : 'company'
  const payload = buildRecurringSnapshotPayload(payload0)
  const cols = ['id', 'occurred_at', 'amount', 'currency', 'category', 'category_detail', 'note', 'generated_from', 'fixed_expense_id', 'month_key', 'due_date', 'paid_date', 'status']
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(',')
  const extraCols = scope === 'property' ? ', property_id' : ''
  const extraPlaceholder = scope === 'property' ? `,$${cols.length + 1}` : ''
  const values = cols.map((k) => (payload as any)[k]).concat(scope === 'property' ? [payload.property_id] : [])
  const propertyUpdate = scope === 'property' ? `, property_id = COALESCE(EXCLUDED.property_id, ${table}.property_id)` : ''
  const sql = `INSERT INTO ${table} (${cols.join(',')}${extraCols})
    VALUES (${placeholders}${extraPlaceholder})
    ON CONFLICT (fixed_expense_id, month_key) WHERE ${RECURRING_SNAPSHOT_CONFLICT_WHERE}
    DO UPDATE SET
      occurred_at = EXCLUDED.occurred_at,
      amount = EXCLUDED.amount,
      currency = EXCLUDED.currency,
      category = EXCLUDED.category,
      category_detail = EXCLUDED.category_detail,
      note = EXCLUDED.note,
      generated_from = EXCLUDED.generated_from,
      due_date = EXCLUDED.due_date,
      status = CASE
        WHEN ${table}.status = 'paid' AND EXCLUDED.status <> 'paid' THEN ${table}.status
        ELSE EXCLUDED.status
      END,
      paid_date = CASE
        WHEN ${table}.paid_date IS NOT NULL AND EXCLUDED.paid_date IS NULL THEN ${table}.paid_date
        ELSE COALESCE(EXCLUDED.paid_date, ${table}.paid_date)
      END
      ${propertyUpdate}
    RETURNING *, (xmax = 0) AS inserted`
  const res = await client.query(sql, values)
  return res.rows?.[0] || null
}

async function getPropertyPayableSnapshotTx(client: any, fixedExpenseId: string, monthKey: string): Promise<PropertyPayableSnapshotRow | null> {
  const res = await client.query(
    `SELECT *
       FROM property_expenses
      WHERE fixed_expense_id = $1
        AND month_key = $2
      LIMIT 1`,
    [fixedExpenseId, monthKey]
  )
  return (res.rows?.[0] as PropertyPayableSnapshotRow) || null
}

async function ensurePropertyPayableSnapshotTx(client: any, payment: any, monthKey: string, actorId?: string | null) {
  const templateDates = computePropertyPayableTemplateDates(payment, monthKey)
  const dueISO = templateDates.due_date
  const payload = {
    id: require('uuid').v4(),
    property_id: String(payment?.property_id || '').trim() || null,
    occurred_at: dueISO,
    amount: round2(Number(payment?.amount || 0)),
    currency: 'AUD',
    category: String(payment?.category || 'other') || 'other',
    category_detail: payment?.category_detail || null,
    note: null,
    created_by: actorId || String(payment?.created_by || '').trim() || 'property_payable_snapshot',
    generated_from: 'recurring_payments',
    fixed_expense_id: String(payment?.id || '').trim(),
    month_key: monthKey,
    due_date: dueISO,
    bill_expected_date: templateDates.bill_expected_date,
    bill_received_date: null,
    bill_period_start: templateDates.bill_period_start,
    bill_period_end: templateDates.bill_period_end,
    paid_date: null,
    status: 'pending',
    amount_confirmed: false,
    amount_confirmed_by: null,
    amount_confirmed_at: null,
    paid_by: null,
    paid_confirmed_at: null,
  }
  const cols = Object.keys(payload)
  const sql = `INSERT INTO property_expenses (${cols.join(',')})
    VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})
    ON CONFLICT (fixed_expense_id, month_key) WHERE ${RECURRING_SNAPSHOT_CONFLICT_WHERE}
    DO UPDATE SET
      property_id = COALESCE(property_expenses.property_id, EXCLUDED.property_id),
      currency = COALESCE(property_expenses.currency, EXCLUDED.currency),
      category = COALESCE(property_expenses.category, EXCLUDED.category),
      category_detail = COALESCE(property_expenses.category_detail, EXCLUDED.category_detail),
      generated_from = COALESCE(property_expenses.generated_from, EXCLUDED.generated_from),
      created_by = COALESCE(property_expenses.created_by, EXCLUDED.created_by),
      due_date = COALESCE(property_expenses.due_date, EXCLUDED.due_date),
      bill_expected_date = COALESCE(property_expenses.bill_expected_date, EXCLUDED.bill_expected_date),
      bill_period_start = COALESCE(property_expenses.bill_period_start, EXCLUDED.bill_period_start),
      bill_period_end = COALESCE(property_expenses.bill_period_end, EXCLUDED.bill_period_end),
      status = COALESCE(property_expenses.status, EXCLUDED.status)
    RETURNING *, (xmax = 0) AS inserted`
  const res = await client.query(sql, cols.map((k) => (payload as any)[k]))
  return (res.rows?.[0] as any) || null
}

async function confirmPropertyPayableSnapshotTx(
  client: any,
  payment: any,
  monthKey: string,
  input: { amount: number; dueDate?: string | null; billReceivedDate?: string | null; billPeriodStart?: string | null; billPeriodEnd?: string | null; note?: string | null; actorId?: string | null }
) {
  const actor = String(input.actorId || '').trim() || null
  const base = await ensurePropertyPayableSnapshotTx(client, payment, monthKey, actor)
  if (!base?.id) throw new Error('snapshot_confirm_failed')
  const before = await getPropertyPayableSnapshotTx(client, String(payment.id), monthKey)
  const nextDue = computeDueISO(monthKey, PROPERTY_PAYABLE_FIXED_DUE_DAY_OF_MONTH)
  const nextBillReceived = input.billReceivedDate === undefined ? (before?.bill_received_date || null) : toISODate(input.billReceivedDate)
  const nextBillPeriodStart = null
  const nextBillPeriodEnd = null
  const nextNote = input.note == null ? (before?.note || null) : String(input.note || '').trim() || null
  const nextAmount = round2(Number(input.amount || 0))
  const upd = await client.query(
    `UPDATE property_expenses
        SET amount = $1,
            due_date = $2,
            note = $3,
            bill_received_date = $4,
            bill_period_start = $5,
            bill_period_end = $6,
            status = CASE WHEN status = 'paid' THEN status ELSE 'unpaid' END,
            amount_confirmed = true,
            amount_confirmed_by = $7,
            amount_confirmed_at = now()
      WHERE id = $8
      RETURNING *`,
    [nextAmount, nextDue, nextNote, nextBillReceived, nextBillPeriodStart, nextBillPeriodEnd, actor, String(base.id)]
  )
  return { before, after: (upd.rows?.[0] as PropertyPayableSnapshotRow) || null }
}

let schemaEnsured: Promise<void> | null = null
async function ensureSchemasOnce() {
  if (!hasPg || !pgPool) return
  if (schemaEnsured) return schemaEnsured
  schemaEnsured = (async () => {
    await pgPool.query('ALTER TABLE recurring_payments ADD COLUMN IF NOT EXISTS start_month_key text;')
    try { await pgPool.query('ALTER TABLE recurring_payments ADD COLUMN IF NOT EXISTS report_category text;') } catch {}
    try { await pgPool.query('ALTER TABLE recurring_payments ADD COLUMN IF NOT EXISTS frequency_months integer DEFAULT 1;') } catch {}
    try { await pgPool.query(`ALTER TABLE recurring_payments ADD COLUMN IF NOT EXISTS amount_mode text DEFAULT 'fixed';`) } catch {}
    try { await pgPool.query(`ALTER TABLE recurring_payments ADD COLUMN IF NOT EXISTS income_base text DEFAULT 'total_income';`) } catch {}
    try { await pgPool.query('ALTER TABLE recurring_payments ADD COLUMN IF NOT EXISTS rate_percent numeric;') } catch {}
    try { await pgPool.query('ALTER TABLE recurring_payments ADD COLUMN IF NOT EXISTS property_ids text[];') } catch {}
    try { await pgPool.query(`ALTER TABLE recurring_payments ADD COLUMN IF NOT EXISTS template_kind text DEFAULT '${TEMPLATE_KIND_FIXED_EXPENSE}';`) } catch {}
    try { await pgPool.query('ALTER TABLE recurring_payments ADD COLUMN IF NOT EXISTS bill_account_no text;') } catch {}
    try { await pgPool.query('ALTER TABLE recurring_payments ADD COLUMN IF NOT EXISTS note text;') } catch {}
    try { await pgPool.query('ALTER TABLE recurring_payments ADD COLUMN IF NOT EXISTS created_by text;') } catch {}
    try { await pgPool.query('ALTER TABLE recurring_payments ADD COLUMN IF NOT EXISTS updated_by text;') } catch {}
    try { await pgPool.query('ALTER TABLE recurring_payments ADD COLUMN IF NOT EXISTS bill_expected_day_of_month integer;') } catch {}
    try { await pgPool.query('ALTER TABLE recurring_payments ADD COLUMN IF NOT EXISTS bill_period_start_day_of_month integer;') } catch {}
    try { await pgPool.query('ALTER TABLE recurring_payments ADD COLUMN IF NOT EXISTS bill_period_start_month_offset integer DEFAULT 0;') } catch {}
    try { await pgPool.query('ALTER TABLE recurring_payments ADD COLUMN IF NOT EXISTS bill_period_end_day_of_month integer;') } catch {}
    try { await pgPool.query('ALTER TABLE recurring_payments ADD COLUMN IF NOT EXISTS bill_period_end_month_offset integer DEFAULT 0;') } catch {}

    try { await pgPool.query('ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS fixed_expense_id text;') } catch {}
    try { await pgPool.query('ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS month_key text;') } catch {}
    try { await pgPool.query('ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS due_date date;') } catch {}
    try { await pgPool.query('ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS paid_date date;') } catch {}
    try { await pgPool.query('ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS status text;') } catch {}
    try { await pgPool.query('ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS generated_from text;') } catch {}
    try { await pgPool.query('ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS created_by text;') } catch {}
    try { await pgPool.query('ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS deleted_at timestamptz;') } catch {}

    try { await pgPool.query('ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS fixed_expense_id text;') } catch {}
    try { await pgPool.query('ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS month_key text;') } catch {}
    try { await pgPool.query('ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS due_date date;') } catch {}
    try { await pgPool.query('ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS paid_date date;') } catch {}
    try { await pgPool.query('ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS status text;') } catch {}
    try { await pgPool.query('ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS generated_from text;') } catch {}
    try { await pgPool.query('ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS created_by text;') } catch {}
    try { await pgPool.query('ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS paid_by text;') } catch {}
    try { await pgPool.query('ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS paid_confirmed_at timestamptz;') } catch {}
    try { await pgPool.query('ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS amount_confirmed boolean DEFAULT false;') } catch {}
    try { await pgPool.query('ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS amount_confirmed_by text;') } catch {}
    try { await pgPool.query('ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS amount_confirmed_at timestamptz;') } catch {}
    try { await pgPool.query('ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS bill_expected_date date;') } catch {}
    try { await pgPool.query('ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS bill_received_date date;') } catch {}
    try { await pgPool.query('ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS bill_period_start date;') } catch {}
    try { await pgPool.query('ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS bill_period_end date;') } catch {}
    try { await pgPool.query('ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS deleted_at timestamptz;') } catch {}
    try { await pgPool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_property_expenses_fixed_expense_month_key ON property_expenses(fixed_expense_id, month_key) WHERE ${RECURRING_SNAPSHOT_CONFLICT_WHERE};`) } catch {}
    try { await pgPool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_company_expenses_fixed_month ON company_expenses(fixed_expense_id, month_key) WHERE ${RECURRING_SNAPSHOT_CONFLICT_WHERE};`) } catch {}
    try { await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_property_expenses_month_fixed_lookup ON property_expenses(month_key, fixed_expense_id) WHERE ${RECURRING_SNAPSHOT_CONFLICT_WHERE};`) } catch {}
    try { await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_company_expenses_month_fixed_lookup ON company_expenses(month_key, fixed_expense_id) WHERE ${RECURRING_SNAPSHOT_CONFLICT_WHERE};`) } catch {}
  })().catch((e) => {
    schemaEnsured = null
    throw e
  })
  return schemaEnsured
}

function msEnv(name: string, defMs: number): number {
  const raw = Number(process.env[name] || defMs)
  if (!Number.isFinite(raw)) return defMs
  return Math.max(0, Math.floor(raw))
}

async function applyTxTimeouts(client: any) {
  const lockTimeoutMs = msEnv('RECURRING_TX_LOCK_TIMEOUT_MS', 1500)
  const statementTimeoutMs = msEnv('RECURRING_TX_STATEMENT_TIMEOUT_MS', 20000)
  const idleTimeoutMs = msEnv('RECURRING_TX_IDLE_TIMEOUT_MS', 30000)
  if (lockTimeoutMs) await client.query(`SET LOCAL lock_timeout = ${lockTimeoutMs}`)
  if (statementTimeoutMs) await client.query(`SET LOCAL statement_timeout = ${statementTimeoutMs}`)
  if (idleTimeoutMs) await client.query(`SET LOCAL idle_in_transaction_session_timeout = ${idleTimeoutMs}`)
}

const paymentTypeEnum = z.enum(['bank_account', 'bpay', 'payid', 'rent_deduction', 'cash'])
const monthKeySchema = z.string().regex(/^\d{4}-\d{2}$/, 'invalid month_key')
const amountModeEnum = z.enum(['fixed', 'percent_of_property_total_income'])
const incomeBaseEnum = z.enum(['total_income'])
const createPaymentSchema = z.object({
  id: z.string().min(8),
  scope: z.enum(['company', 'property']).optional().default('company'),
  property_id: z.string().optional(),
  property_ids: z.array(z.string()).optional(),
  vendor: z.string().optional(),
  category: z.string().optional(),
  category_detail: z.string().optional(),
  amount: z.coerce.number().optional(),
  due_day_of_month: z.coerce.number().optional(),
  bill_expected_day_of_month: z.coerce.number().optional(),
  bill_period_start_day_of_month: z.coerce.number().optional(),
  bill_period_start_month_offset: z.coerce.number().optional(),
  bill_period_end_day_of_month: z.coerce.number().optional(),
  bill_period_end_month_offset: z.coerce.number().optional(),
  frequency_months: z.coerce.number().optional(),
  remind_days_before: z.coerce.number().optional(),
  status: z.string().optional(),
  payment_type: paymentTypeEnum.optional(),
  pay_account_name: z.string().optional(),
  pay_bsb: z.string().optional(),
  pay_account_number: z.string().optional(),
  pay_ref: z.string().optional(),
  bpay_code: z.string().optional(),
  pay_mobile_number: z.string().optional(),
  report_category: z.string().optional(),
  template_kind: z.enum([TEMPLATE_KIND_FIXED_EXPENSE, TEMPLATE_KIND_PROPERTY_PAYABLE]).optional().default(TEMPLATE_KIND_FIXED_EXPENSE),
  bill_account_no: z.string().optional(),
  note: z.string().optional(),
  start_month_key: monthKeySchema,
  amount_mode: amountModeEnum.optional(),
  rate_percent: z.coerce.number().optional(),
  income_base: incomeBaseEnum.optional(),
  initial_mark: z.enum(['paid', 'unpaid']).optional().default('unpaid'),
})
const resumeSchema = z.object({ month_key: monthKeySchema.optional() })
const markPaidSchema = z.object({ month_key: monthKeySchema, paid_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'invalid paid_date') })
const unmarkPaidSchema = z.object({ month_key: monthKeySchema })
const confirmAmountSchema = z.object({
  month_key: monthKeySchema,
  amount: z.coerce.number().min(0),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'invalid due_date').optional(),
  bill_received_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'invalid bill_received_date').nullable().optional(),
  bill_period_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'invalid bill_period_start').nullable().optional(),
  bill_period_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'invalid bill_period_end').nullable().optional(),
  note: z.string().optional(),
})

function round2(n: number): number {
  return Number(Number(n || 0).toFixed(2))
}

function parseDateOnlyUTC(v: any): Date | null {
  const s = toISODate(v)
  if (!s) return null
  const d = new Date(`${s}T00:00:00.000Z`)
  return isNaN(d.getTime()) ? null : d
}

function addMonthsUTC(d: Date, months: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1))
}

function monthStartUTC(monthKey: string): Date | null {
  const [ys, ms] = String(monthKey).split('-')
  const y = Number(ys)
  const m = Number(ms)
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return null
  return new Date(Date.UTC(y, m - 1, 1))
}

function dayDiffUTC(a: Date, b: Date): number {
  const ms = b.getTime() - a.getTime()
  return ms > 0 ? Math.floor(ms / (24 * 3600 * 1000)) : 0
}

function isCanceledStatus(raw: any): boolean {
  return String(raw || '').toLowerCase().includes('cancel')
}

function isReferralLocked(paymentMonthKey: string): boolean {
  const mk = String(paymentMonthKey || '').trim()
  if (!/^\d{4}-\d{2}$/.test(mk)) return false
  const lockISO = `${mk}-05`
  return currentDateISOAU() >= lockISO
}

async function computePropertyTotalIncomeForMonthTx(client: any, propertyId: string, monthKey: string, cache?: Record<string, number>): Promise<number> {
  const pid = String(propertyId || '').trim()
  const mk = String(monthKey || '').trim()
  if (!pid || !mk) return 0
  const cacheKey = `${pid}__${mk}`
  if (cache && Object.prototype.hasOwnProperty.call(cache, cacheKey)) return Number(cache[cacheKey] || 0)
  const ms = monthStartUTC(mk)
  if (!ms) return 0
  const meNext = addMonthsUTC(ms, 1)
  const startISO = ms.toISOString().slice(0, 10)
  const endExclusiveISO = meNext.toISOString().slice(0, 10)

  let rentIncome = 0
  try {
    const ordersRes = await client.query(
      `SELECT id, checkin, checkout, price, cleaning_fee, status, count_in_income
       FROM orders
       WHERE property_id = $1
         AND checkin < to_date($3,'YYYY-MM-DD')
         AND checkout > to_date($2,'YYYY-MM-DD')`,
      [pid, startISO, endExclusiveISO]
    )
    const orders: any[] = ordersRes?.rows || []
    const ids = orders.map(o => String(o.id)).filter(Boolean)
    const deductionTotals: Record<string, number> = {}
    if (ids.length) {
      try {
        const rs = await client.query(
          `SELECT order_id, COALESCE(SUM(amount),0) AS total
           FROM order_internal_deductions
           WHERE is_active=true AND order_id = ANY($1)
           GROUP BY order_id`,
          [ids]
        )
        ;(rs?.rows || []).forEach((r: any) => { deductionTotals[String(r.order_id)] = round2(Number(r.total || 0)) })
      } catch {}
    }
    for (const o of orders) {
      const ci = parseDateOnlyUTC(o.checkin)
      const co = parseDateOnlyUTC(o.checkout)
      if (!ci || !co) continue
      const totalNights = Math.max(0, dayDiffUTC(ci, co))
      if (totalNights <= 0) continue
      const a = ci > ms ? ci : ms
      const b = co < meNext ? co : meNext
      const nightsMonth = Math.max(0, dayDiffUTC(a, b))
      if (nightsMonth <= 0) continue
      const totalPrice = Number(o.price || 0)
      const totalCleaning = Number(o.cleaning_fee || 0)
      const netTotal = round2(totalPrice - totalCleaning)
      const dailyNet = totalNights ? (netTotal / totalNights) : 0
      const netMonth = round2(dailyNet * nightsMonth)
      const lastNight = new Date(co.getTime() - 24 * 3600 * 1000)
      const isDeductionMonth = totalNights > 0 && (lastNight.getUTCFullYear() === ms.getUTCFullYear()) && (lastNight.getUTCMonth() === ms.getUTCMonth())
      const deductionMonth = isDeductionMonth ? Number(deductionTotals[String(o.id)] || 0) : 0
      const include = (!isCanceledStatus(o.status)) || !!o.count_in_income
      const visibleNetMonth = include ? round2(netMonth - deductionMonth) : 0
      rentIncome += visibleNetMonth
    }
  } catch {}

  let otherIncome = 0
  try {
    const txRes = await client.query(
      `SELECT amount, category, ref_type, ref_id, occurred_at
       FROM finance_transactions
       WHERE kind='income'
         AND property_id = $1
         AND (occurred_at)::date >= to_date($2,'YYYY-MM-DD')
         AND (occurred_at)::date < to_date($3,'YYYY-MM-DD')`,
      [pid, startISO, endExclusiveISO]
    )
    const txs: any[] = txRes?.rows || []
    const cancelFeeOrderIds = Array.from(new Set(txs.filter(t => String(t.category || '').toLowerCase() === 'cancel_fee' && String(t.ref_type || '') === 'order' && String(t.ref_id || '')).map(t => String(t.ref_id))))
    const orderById: Record<string, any> = {}
    if (cancelFeeOrderIds.length) {
      try {
        const ordRes = await client.query(`SELECT id, status, count_in_income FROM orders WHERE id = ANY($1)`, [cancelFeeOrderIds])
        ;(ordRes?.rows || []).forEach((r: any) => { orderById[String(r.id)] = r })
      } catch {}
    }
    for (const t of txs) {
      const cat = String(t.category || '').toLowerCase()
      if (cat === 'furniture_owner_payment') continue
      if (cat === 'late_checkout') continue
      if (cat === 'cancel_fee') {
        const oid = (String(t.ref_type || '') === 'order') ? String(t.ref_id || '') : ''
        if (!oid) continue
        const ord = orderById[oid]
        const canceled = isCanceledStatus(ord?.status)
        const countInIncome = !!ord?.count_in_income
        if (!(canceled && countInIncome)) continue
      }
      otherIncome += Number(t.amount || 0)
    }
  } catch {}

  const total = round2(rentIncome + otherIncome)
  if (cache) cache[cacheKey] = total
  return total
}

async function computePropertyRentIncomeForMonthTx(client: any, propertyId: string, monthKey: string, cache?: Record<string, number>): Promise<number> {
  const pid = String(propertyId || '').trim()
  const mk = String(monthKey || '').trim()
  if (!pid || !mk) return 0
  const cacheKey = `rent__${pid}__${mk}`
  if (cache && Object.prototype.hasOwnProperty.call(cache, cacheKey)) return Number(cache[cacheKey] || 0)
  const ms = monthStartUTC(mk)
  if (!ms) return 0
  const meNext = addMonthsUTC(ms, 1)
  const startISO = ms.toISOString().slice(0, 10)
  const endExclusiveISO = meNext.toISOString().slice(0, 10)

  let rentIncome = 0
  try {
    const ordersRes = await client.query(
      `SELECT id, checkin, checkout, price, cleaning_fee, status, count_in_income
       FROM orders
       WHERE property_id = $1
         AND checkin < to_date($3,'YYYY-MM-DD')
         AND checkout > to_date($2,'YYYY-MM-DD')`,
      [pid, startISO, endExclusiveISO]
    )
    const orders: any[] = ordersRes?.rows || []
    const ids = orders.map(o => String(o.id)).filter(Boolean)
    const deductionTotals: Record<string, number> = {}
    if (ids.length) {
      try {
        const rs = await client.query(
          `SELECT order_id, COALESCE(SUM(amount),0) AS total
           FROM order_internal_deductions
           WHERE is_active=true AND order_id = ANY($1)
           GROUP BY order_id`,
          [ids]
        )
        ;(rs?.rows || []).forEach((r: any) => { deductionTotals[String(r.order_id)] = round2(Number(r.total || 0)) })
      } catch {}
    }
    for (const o of orders) {
      const ci = parseDateOnlyUTC(o.checkin)
      const co = parseDateOnlyUTC(o.checkout)
      if (!ci || !co) continue
      const totalNights = Math.max(0, dayDiffUTC(ci, co))
      if (totalNights <= 0) continue
      const a = ci > ms ? ci : ms
      const b = co < meNext ? co : meNext
      const nightsMonth = Math.max(0, dayDiffUTC(a, b))
      if (nightsMonth <= 0) continue
      const totalPrice = Number(o.price || 0)
      const totalCleaning = Number(o.cleaning_fee || 0)
      const netTotal = round2(totalPrice - totalCleaning)
      const dailyNet = totalNights ? (netTotal / totalNights) : 0
      const netMonth = round2(dailyNet * nightsMonth)
      const lastNight = new Date(co.getTime() - 24 * 3600 * 1000)
      const isDeductionMonth = totalNights > 0 && (lastNight.getUTCFullYear() === ms.getUTCFullYear()) && (lastNight.getUTCMonth() === ms.getUTCMonth())
      const deductionMonth = isDeductionMonth ? Number(deductionTotals[String(o.id)] || 0) : 0
      const include = (!isCanceledStatus(o.status)) || !!o.count_in_income
      const visibleNetMonth = include ? round2(netMonth - deductionMonth) : 0
      rentIncome += visibleNetMonth
    }
  } catch {}

  const total = round2(rentIncome)
  if (cache) cache[cacheKey] = total
  return total
}

function normalizePropertyIds(v: any): string[] {
  if (!v) return []
  if (Array.isArray(v)) return Array.from(new Set(v.map(x => String(x || '').trim()).filter(Boolean)))
  if (typeof v === 'string') {
    const s = v.trim()
    if (!s) return []
    try {
      const j = JSON.parse(s)
      if (Array.isArray(j)) return Array.from(new Set(j.map(x => String(x || '').trim()).filter(Boolean)))
    } catch {}
    return [s]
  }
  return []
}

async function computeSnapshotAmountTx(client: any, paymentRow: any, paymentMonthKey: string, incomeCache?: Record<string, number>): Promise<number> {
  const mode = String((paymentRow as any).amount_mode || 'fixed')
  if (mode !== 'percent_of_property_total_income') return round2(Number(paymentRow.amount || 0))
  const pids = (() => {
    const ids = normalizePropertyIds((paymentRow as any).property_ids)
    const pid = String((paymentRow as any).property_id || '').trim()
    if (!ids.length && pid) return [pid]
    return ids
  })()
  if (!pids.length) return 0
  const rate = Number((paymentRow as any).rate_percent || 0)
  if (!Number.isFinite(rate) || rate < 0) return 0
  const baseMonth = prevMonthKey(paymentMonthKey)
  if (!baseMonth) return 0
  let base = 0
  for (const pid of pids) {
    base += await computePropertyRentIncomeForMonthTx(client, pid, baseMonth, incomeCache)
  }
  return round2(Math.max(0, base) * rate / 100)
}

type PropertyPayableWorkbenchResult = {
  rows: any[]
  summary: {
    unpaid_amount: number
    bill_not_received_count: number
    awaiting_confirmation_count: number
    overdue_count: number
    paid_amount: number
  }
  month_key: string
}

function pushMonthKeysFromRaw(out: string[], raw: any) {
  if (Array.isArray(raw)) {
    raw.forEach((item) => pushMonthKeysFromRaw(out, item))
    return
  }
  const s = String(raw || '').trim()
  if (!s) return
  s.split(',').map((item) => item.trim()).filter(Boolean).forEach((item) => out.push(item))
}

function parsePropertyPayableWorkbenchMonths(query: any) {
  const requested: string[] = []
  pushMonthKeysFromRaw(requested, query?.month_keys)
  const fallbackMonthKey = String(query?.month_key || currentMonthKeyAU()).trim()
  const monthKeys = Array.from(new Set((requested.length ? requested : [fallbackMonthKey]).map((item) => item.trim()).filter(Boolean)))
  const result = {
    monthKeys,
    primaryMonthKey: fallbackMonthKey,
    isBatch: requested.length > 0,
    error: '',
  }
  if (!monthKeys.length || monthKeys.some((mk) => !/^\d{4}-\d{2}$/.test(mk))) {
    result.error = 'invalid month key'
    return result
  }
  if (monthKeys.length > 6) {
    result.error = 'too many month keys'
    return result
  }
  if (!/^\d{4}-\d{2}$/.test(result.primaryMonthKey) || !monthKeys.includes(result.primaryMonthKey)) {
    result.primaryMonthKey = monthKeys[0]
  }
  return result
}

function buildPropertyPayableWorkbenchMonth(
  templates: any[],
  snapByTemplate: Map<string, any>,
  monthKey: string,
  today: string,
  dueSoonCutoff: string,
): PropertyPayableWorkbenchResult {
  const rows = templates
    .map((tpl) => {
      const startMonth = String(tpl?.start_month_key || '').trim()
      const freq = normalizePropertyPayableFrequencyMonths(tpl?.frequency_months)
      const isDue = !!startMonth && isDueMonthKey(startMonth, monthKey, freq)
      const snapshot = snapByTemplate.get(String(tpl.id)) || null
      if (!isDue && !snapshot) return null
      const templateDates = computePropertyPayableTemplateDates(tpl, monthKey)
      const dueDate = String(templateDates.due_date || snapshot?.due_date || '').slice(0, 10)
      const billExpectedDate = String(snapshot?.bill_expected_date || templateDates.bill_expected_date || '').slice(0, 10) || null
      const billReceivedDate = snapshot?.bill_received_date ? String(snapshot.bill_received_date).slice(0, 10) : null
      const billPeriodStart = null
      const billPeriodEnd = null
      const paid = String(snapshot?.status || '') === 'paid'
      const amountConfirmed = normalizeBool(snapshot?.amount_confirmed)
      const billNotReceived = !paid && !amountConfirmed && !billReceivedDate
      const overdueAfterDate = billExpectedDate ? addDaysISO(billExpectedDate, PROPERTY_PAYABLE_PAYMENT_GRACE_DAYS) : null
      const paymentOverdue = !paid && !!overdueAfterDate && overdueAfterDate < today
      const billOverdue = billNotReceived && !paymentOverdue && !!billExpectedDate && billExpectedDate < today
      const paymentDueSoon = !paid && amountConfirmed && !paymentOverdue && !!dueDate && dueDate <= dueSoonCutoff
      let workflowStatus = 'pending'
      let sortBucket = 5
      if (paid) { workflowStatus = 'paid'; sortBucket = 6 }
      else if (paymentOverdue) { workflowStatus = 'payment_overdue'; sortBucket = 0 }
      else if (billOverdue) { workflowStatus = 'bill_not_received'; sortBucket = 1 }
      else if (paymentDueSoon) { workflowStatus = 'payment_due_soon'; sortBucket = 2 }
      else if (!amountConfirmed && billNotReceived) { workflowStatus = 'awaiting_bill'; sortBucket = 3 }
      else if (!amountConfirmed) { workflowStatus = 'awaiting_confirmation'; sortBucket = 4 }
      else { workflowStatus = 'awaiting_payment'; sortBucket = 5 }
      return {
        template_id: String(tpl.id),
        snapshot_id: snapshot?.id ? String(snapshot.id) : null,
        property_id: String(tpl.property_id || '').trim() || null,
        property_code: tpl.property_code || null,
        property_address: tpl.property_address || null,
        vendor: tpl.vendor || '',
        category: tpl.category || 'other',
        category_detail: tpl.category_detail || null,
        start_month_key: startMonth || null,
        due_day_of_month: PROPERTY_PAYABLE_FIXED_DUE_DAY_OF_MONTH,
        bill_expected_day_of_month: tpl.bill_expected_day_of_month == null ? null : Number(tpl.bill_expected_day_of_month || 0),
        bill_period_start_day_of_month: null,
        bill_period_start_month_offset: 0,
        bill_period_end_day_of_month: null,
        bill_period_end_month_offset: 0,
        frequency_months: freq,
        report_category: tpl.report_category || null,
        template_note: tpl.note || null,
        bill_account_no: tpl.bill_account_no || null,
        template_status: tpl.status || 'active',
        payment_type: tpl.payment_type || null,
        pay_account_name: tpl.pay_account_name || null,
        pay_bsb: tpl.pay_bsb || null,
        pay_account_number: tpl.pay_account_number || null,
        pay_ref: tpl.pay_ref || null,
        bpay_code: tpl.bpay_code || null,
        pay_mobile_number: tpl.pay_mobile_number || null,
        amount: Number(snapshot?.amount ?? tpl.amount ?? 0),
        due_date: dueDate || null,
        bill_expected_date: billExpectedDate,
        bill_received_date: billReceivedDate,
        bill_period_start: billPeriodStart,
        bill_period_end: billPeriodEnd,
        paid_date: snapshot?.paid_date ? String(snapshot.paid_date).slice(0, 10) : null,
        status: paid ? 'paid' : (snapshot?.status || 'pending'),
        workflow_status: workflowStatus,
        bill_status: paid || amountConfirmed ? 'handled' : (billReceivedDate ? 'received' : (billOverdue ? 'not_received_overdue' : 'awaiting_bill')),
        payment_status: paid ? 'paid' : (amountConfirmed ? (paymentOverdue ? 'overdue' : (paymentDueSoon ? 'due_soon' : 'awaiting_payment')) : 'not_ready'),
        note: snapshot?.note || null,
        amount_confirmed: amountConfirmed,
        amount_confirmed_by: snapshot?.amount_confirmed_by || null,
        amount_confirmed_at: snapshot?.amount_confirmed_at || null,
        paid_by: snapshot?.paid_by || null,
        paid_confirmed_at: snapshot?.paid_confirmed_at || null,
        remind_days_before: Number(tpl.remind_days_before || 3),
        is_bill_overdue: billOverdue,
        is_payment_overdue: paymentOverdue,
        is_overdue: paymentOverdue,
        is_due_soon: paymentDueSoon,
        sort_bucket: sortBucket,
      }
    })
    .filter(Boolean)
    .sort((a: any, b: any) => {
      if (a.sort_bucket !== b.sort_bucket) return a.sort_bucket - b.sort_bucket
      const ad = String(a.due_date || '9999-12-31')
      const bd = String(b.due_date || '9999-12-31')
      if (ad !== bd) return ad.localeCompare(bd)
      const ap = String(a.property_code || a.property_address || '')
      const bp = String(b.property_code || b.property_address || '')
      if (ap !== bp) return ap.localeCompare(bp)
      return String(a.vendor || '').localeCompare(String(b.vendor || ''))
    }) as any[]
  const summary = {
    unpaid_amount: round2(rows.filter((r: any) => r.status !== 'paid').reduce((sum: number, r: any) => sum + Number(r.amount || 0), 0)),
    bill_not_received_count: rows.filter((r: any) => r.workflow_status === 'bill_not_received').length,
    awaiting_confirmation_count: rows.filter((r: any) => r.status !== 'paid' && !r.amount_confirmed).length,
    overdue_count: rows.filter((r: any) => r.is_overdue).length,
    paid_amount: round2(rows.filter((r: any) => r.status === 'paid').reduce((sum: number, r: any) => sum + Number(r.amount || 0), 0)),
  }
  return { rows, summary, month_key: monthKey }
}

router.get('/property-payables/workbench', requirePerm(PROPERTY_PAYABLE_MENU_PERM), requireAnyPerm(['recurring_payments.view', 'finance.tx.write']), async (req, res) => {
  if (!hasPg) return res.status(500).json({ message: 'pg not available' })
  const parsedMonths = parsePropertyPayableWorkbenchMonths((req as any).query || {})
  if (parsedMonths.error) return res.status(400).json({ message: parsedMonths.error })
  try {
    const tplRes = await pgPool!.query(
      `SELECT rp.*,
              p.code AS property_code,
              p.address AS property_address
         FROM recurring_payments rp
         LEFT JOIN properties p ON p.id = rp.property_id
        WHERE COALESCE(rp.template_kind, $1) = $2
          AND COALESCE(rp.scope, 'property') = 'property'
        ORDER BY COALESCE(rp.status, 'active') ASC, COALESCE(rp.vendor, '') ASC, COALESCE(p.code, '') ASC`,
      [TEMPLATE_KIND_FIXED_EXPENSE, TEMPLATE_KIND_PROPERTY_PAYABLE]
    )
    const expRes = await pgPool!.query(
      `SELECT id,
              fixed_expense_id,
              month_key,
              amount,
              due_date,
              bill_expected_date,
              bill_received_date,
              bill_period_start,
              bill_period_end,
              paid_date,
              status,
              note,
              amount_confirmed,
              amount_confirmed_by,
              amount_confirmed_at,
              paid_by,
              paid_confirmed_at
         FROM property_expenses
        WHERE month_key = ANY($1::text[])
          AND fixed_expense_id IS NOT NULL
          AND fixed_expense_id <> ''`,
      [parsedMonths.monthKeys]
    )
    const templates: any[] = Array.isArray(tplRes.rows) ? tplRes.rows : []
    const snapshotsByMonth = new Map<string, Map<string, any>>()
    for (const row of Array.isArray(expRes.rows) ? expRes.rows : []) {
      const mk = String((row as any)?.month_key || '').trim()
      const key = String((row as any)?.fixed_expense_id || '').trim()
      if (!mk || !key) continue
      const monthMap = snapshotsByMonth.get(mk) || new Map<string, any>()
      monthMap.set(key, row)
      snapshotsByMonth.set(mk, monthMap)
    }
    const today = currentDateISOAU()
    const dueSoonCutoff = addDaysISO(today, 3) || today
    const months: Record<string, PropertyPayableWorkbenchResult> = {}
    for (const monthKey of parsedMonths.monthKeys) {
      months[monthKey] = buildPropertyPayableWorkbenchMonth(templates, snapshotsByMonth.get(monthKey) || new Map<string, any>(), monthKey, today, dueSoonCutoff)
    }
    const primary = months[parsedMonths.primaryMonthKey] || months[parsedMonths.monthKeys[0]]
    const result = parsedMonths.isBatch ? { ...primary, months, month_keys: parsedMonths.monthKeys } : primary
    return res.json(result)
  } catch (e: any) {
    const msg = String(e?.message || 'property payable workbench failed')
    if (/timeout exceeded when trying to connect/i.test(msg)) return res.status(503).json({ message: msg })
    if (/lock timeout/i.test(msg)) return res.status(503).json({ message: msg })
    return res.status(500).json({ message: msg })
  }
})

router.get('/property-payables/vendors', requirePerm(PROPERTY_PAYABLE_MENU_PERM), requireAnyPerm(['recurring_payments.view', 'finance.tx.write', 'property.write', 'properties.write']), async (_req, res) => {
  if (!hasPg) return res.status(500).json({ message: 'pg not available' })
  try {
    await ensureSchemasOnce()
    const result = await pgPool!.query(
      `SELECT TRIM(vendor) AS vendor, COUNT(*)::int AS usage_count
         FROM recurring_payments
        WHERE COALESCE(template_kind, $1) = $2
          AND COALESCE(scope, 'property') = 'property'
          AND COALESCE(TRIM(vendor), '') <> ''
        GROUP BY TRIM(vendor)
        ORDER BY COUNT(*) DESC, TRIM(vendor) ASC`,
      [TEMPLATE_KIND_FIXED_EXPENSE, TEMPLATE_KIND_PROPERTY_PAYABLE]
    )
    return res.json(
      (Array.isArray(result.rows) ? result.rows : []).map((row: any) => ({
        value: String(row?.vendor || ''),
        label: String(row?.vendor || ''),
        usage_count: Number(row?.usage_count || 0),
      }))
    )
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed to load vendors' })
  }
})

router.get('/payments/month-snapshots', requireAnyPerm(['recurring_payments.view', 'finance.tx.write']), async (req, res) => {
  if (!hasPg) return res.status(500).json({ message: 'pg not available' })
  const monthKey = String((req.query as any)?.month_key || currentMonthKeyAU()).trim()
  if (!/^\d{4}-\d{2}$/.test(monthKey)) return res.status(400).json({ message: 'invalid month_key' })
  try {
    await ensureSchemasOnce()
    const [propertyRows, companyRows] = await Promise.all([
      pgPool!.query(
        `SELECT id,
                fixed_expense_id,
                month_key,
                due_date,
                paid_date,
                status,
                property_id,
                category,
                amount,
                'property_expenses' AS expense_resource
           FROM property_expenses
          WHERE month_key = $1
            AND fixed_expense_id IS NOT NULL
            AND fixed_expense_id <> ''
            AND deleted_at IS NULL
          ORDER BY due_date ASC NULLS LAST, paid_date DESC NULLS LAST`,
        [monthKey]
      ),
      pgPool!.query(
        `SELECT id,
                fixed_expense_id,
                month_key,
                due_date,
                paid_date,
                status,
                NULL::text AS property_id,
                category,
                amount,
                'company_expenses' AS expense_resource
           FROM company_expenses
          WHERE month_key = $1
            AND fixed_expense_id IS NOT NULL
            AND fixed_expense_id <> ''
            AND deleted_at IS NULL
          ORDER BY due_date ASC NULLS LAST, paid_date DESC NULLS LAST`,
        [monthKey]
      ),
    ])
    return res.json([...(propertyRows.rows || []), ...(companyRows.rows || [])])
  } catch (e: any) {
    const msg = String(e?.message || 'failed to load recurring snapshots')
    if (/timeout exceeded when trying to connect/i.test(msg)) return res.status(503).json({ message: msg })
    if (/lock timeout/i.test(msg)) return res.status(503).json({ message: msg })
    return res.status(500).json({ message: msg })
  }
})

router.post('/payments', requireAnyPerm(['recurring_payments.write', 'finance.tx.write']), async (req, res) => {
  if (!hasPg) return res.status(500).json({ message: 'pg not available' })
  const parsed = createPaymentSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const actorId = recurringActorId(req)

  const currentMonth = currentMonthKeyAU()
  const startMonth = parsed.data.start_month_key
  const startIdx = monthKeyToIndex(startMonth)
  const curIdx = monthKeyToIndex(currentMonth)
  if (!Number.isFinite(startIdx) || !Number.isFinite(curIdx)) return res.status(400).json({ message: 'invalid month key' })
  const pastEndIdx = curIdx - 1

  const { initial_mark, ...payment } = parsed.data
  ;(payment as any).template_kind = String((payment as any).template_kind || TEMPLATE_KIND_FIXED_EXPENSE)
  ;(payment as any).created_by = actorId
  ;(payment as any).updated_by = actorId
  normalizePropertyPayableTemplatePayload(payment as any)
  if (String((payment as any).template_kind || '') === TEMPLATE_KIND_PROPERTY_PAYABLE && !(await canAccessPropertyPayables(req))) {
    return res.status(403).json({ message: 'forbidden' })
  }
  const freq = Number(payment.frequency_months || 1)
  const dueDay = Number(payment.due_day_of_month || 1)
  const mode = String((payment as any).amount_mode || 'fixed')
  const rate = Number((payment as any).rate_percent || 0)
  if (payment.payment_type !== 'rent_deduction' && (!Number.isFinite(dueDay) || dueDay < 1 || dueDay > 31)) {
    return res.status(400).json({ message: 'due_day_of_month required' })
  }
  if (!Number.isFinite(freq) || freq < 1 || freq > 24) return res.status(400).json({ message: 'frequency_months invalid' })
  if (payment.scope === 'property' && !payment.property_id) return res.status(400).json({ message: 'property_id required' })
  if (String((payment as any).template_kind || '') === TEMPLATE_KIND_PROPERTY_PAYABLE) {
    ;(payment as any).scope = 'property'
    if (!String(payment.property_id || '').trim()) return res.status(400).json({ message: 'property_id required' })
    if (!Number.isFinite(Number((payment as any).bill_expected_day_of_month)) || Number((payment as any).bill_expected_day_of_month) < 1 || Number((payment as any).bill_expected_day_of_month) > 31) {
      return res.status(400).json({ message: 'bill_expected_day_of_month required' })
    }
  }
  if (mode === 'percent_of_property_total_income') {
    if (payment.scope === 'property') return res.status(400).json({ message: 'referral fee must be company scoped' })
    const pids = normalizePropertyIds((payment as any).property_ids)
    const single = String(payment.property_id || '').trim()
    if (!pids.length && !single) return res.status(400).json({ message: 'property_ids required for referral fee' })
    if ((payment as any).rate_percent == null) return res.status(400).json({ message: 'rate_percent required' })
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) return res.status(400).json({ message: 'rate_percent invalid' })
    ;(payment as any).property_ids = pids.length ? pids : (single ? [single] : [])
    ;(payment as any).property_id = ((payment as any).property_ids.length === 1) ? String((payment as any).property_ids[0] || '').trim() : null
  }
  const pastEndMonthKey = startIdx <= pastEndIdx ? indexToMonthKey(pastEndIdx) : ''
  const pastDueMonths = pastEndMonthKey ? dueMonthKeysBetween(startMonth, pastEndMonthKey, freq) : []
  if (pastDueMonths.length > 240) return res.status(400).json({ message: '起始月份过早，历史月份过多（最多 240 个月）' })

  try {
    const result = await pgRunInTransaction(async (client) => {
      await applyTxTimeouts(client)
      await ensureSchemasOnce()
      await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [202603, String(payment.id)])

      const keys = Object.keys(payment)
      const cols = keys.map((k) => `"${k}"`).join(', ')
      const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ')
      const values = keys.map((k) => (payment as any)[k])
      const ins = await client.query(`INSERT INTO recurring_payments (${cols}) VALUES (${placeholders}) RETURNING *`, values)
      const created = ins.rows?.[0] || payment

      const scope = String(payment.scope || 'company')
      const table = scope === 'property' ? 'property_expenses' : 'company_expenses'
      const existingRes = await client.query(
        `SELECT id, month_key, status, due_date, paid_date FROM ${table} WHERE fixed_expense_id = $1 AND month_key >= $2 AND month_key <= $3`,
        [payment.id, startMonth, currentMonth]
      )
      const byMonth: Record<string, any> = {}
      for (const r of Array.isArray(existingRes.rows) ? existingRes.rows : []) {
        const mk = String((r as any).month_key || '')
        if (mk) byMonth[mk] = r
      }

      let inserted = 0
      let updated = 0
      const incomeCache: Record<string, number> = {}

      for (const mk of pastDueMonths) {
        const dueISO = payment.payment_type === 'rent_deduction' ? `${mk}-01` : computeDueISO(mk, dueDay)
        const row = byMonth[mk]
        if (!row) {
          const rowUp = isPropertyPayableTemplate(payment)
            ? await ensurePropertyPayableSnapshotTx(client, payment, mk, actorId)
            : await upsertRecurringSnapshotTx(client, table as any, {
                fixedExpenseId: payment.id,
                monthKey: mk,
                occurredAt: dueISO,
                amount: await computeSnapshotAmountTx(client, payment, mk, incomeCache),
                category: payment.category || 'other',
                categoryDetail: payment.category_detail || null,
                dueDate: dueISO,
                paidDate: dueISO,
                status: 'paid',
                propertyId: scope === 'property' ? (payment.property_id || null) : null,
              })
          if (rowUp?.inserted) inserted++
        } else if (!isPropertyPayableTemplate(payment) && String((row as any).status || '') !== 'paid') {
          const nextPaid = toISODate((row as any).paid_date) || toISODate((row as any).due_date) || dueISO
          const nextDue = toISODate((row as any).due_date) || dueISO
          await client.query(`UPDATE ${table} SET status='paid', paid_date=$1, due_date=$2 WHERE id=$3`, [nextPaid, nextDue, String((row as any).id)])
          updated++
        }
      }

      if (startIdx <= curIdx && isDueMonthKey(startMonth, currentMonth, freq)) {
        const mk = currentMonth
        const dueISO = payment.payment_type === 'rent_deduction' ? `${mk}-01` : computeDueISO(mk, dueDay)
        const row = byMonth[mk]
        const wantPaid = !isPropertyPayableTemplate(payment) && initial_mark === 'paid'
        if (!row) {
          const rowUp = isPropertyPayableTemplate(payment)
            ? await ensurePropertyPayableSnapshotTx(client, payment, mk, actorId)
            : await upsertRecurringSnapshotTx(client, table as any, {
                fixedExpenseId: payment.id,
                monthKey: mk,
                occurredAt: dueISO,
                amount: await computeSnapshotAmountTx(client, payment, mk, incomeCache),
                category: payment.category || 'other',
                categoryDetail: payment.category_detail || null,
                dueDate: dueISO,
                paidDate: wantPaid ? dueISO : null,
                status: wantPaid ? 'paid' : 'unpaid',
                propertyId: scope === 'property' ? (payment.property_id || null) : null,
              })
          if (rowUp?.inserted) inserted++
          if (wantPaid && isPropertyPayableTemplate(payment) && rowUp?.id) {
            await client.query(
              `UPDATE property_expenses
                  SET status = 'paid',
                      paid_date = $1,
                      paid_by = $2,
                      paid_confirmed_at = now()
                WHERE id = $3`,
              [dueISO, actorId, String(rowUp.id)]
            )
          }
        }
      }

      addAudit('RecurringPayment', String(payment.id), 'create', null, created, (req as any).user?.sub)
      return { created, inserted, updated, currentMonth }
    })
    return res.status(201).json({ ok: true, ...result })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'create failed' })
  }
})

router.post('/payments/:id/pause', requireAnyPerm(['recurring_payments.write', 'finance.tx.write']), async (req, res) => {
  if (!hasPg) return res.status(500).json({ message: 'pg not available' })
  const { id } = req.params
  const currentMonthKey = currentMonthKeyAU()
  const curIdx = monthKeyToIndex(currentMonthKey)
  const nextMonthKey = Number.isFinite(curIdx) ? indexToMonthKey(curIdx + 1) : ''
  const currentMonthStart = `${currentMonthKey}-01`
  const nextMonthStart = nextMonthKey ? `${nextMonthKey}-01` : ''
  try {
    const result = await pgRunInTransaction(async (client) => {
      await applyTxTimeouts(client)
      await ensureSchemasOnce()
      await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [202603, String(id)])
      const beforeRes = await client.query('SELECT * FROM recurring_payments WHERE id = $1', [id])
      const before = beforeRes.rows?.[0] || null
      if (!before) return { notFound: true }
      if (isPropertyPayableTemplate(before) && !(await canAccessPropertyPayables(req))) return { forbidden: true }
      const afterRes = await client.query(`UPDATE recurring_payments SET status='paused', updated_at = now() WHERE id = $1 RETURNING *`, [id])
      const after = afterRes.rows?.[0] || null
      const guard = `(generated_from = 'recurring_payments' OR (coalesce(generated_from,'') = '' AND coalesce(note,'') ILIKE 'Fixed payment%'))`
      const d1 = await client.query(
        `DELETE FROM company_expenses
         WHERE fixed_expense_id = $1
           AND ${guard}
           AND (
             (
               coalesce(month_key,'') <> ''
               AND (
                 month_key > $2
                 OR (month_key = $2 AND coalesce(status,'unpaid') <> 'paid')
               )
             )
             OR (
               (coalesce(month_key,'') = '')
               AND $4 <> ''
               AND (
                 (COALESCE(paid_date, due_date, occurred_at::date) >= to_date($4,'YYYY-MM-DD'))
                 OR (
                   COALESCE(paid_date, due_date, occurred_at::date) >= to_date($3,'YYYY-MM-DD')
                   AND COALESCE(paid_date, due_date, occurred_at::date) < to_date($4,'YYYY-MM-DD')
                   AND coalesce(status,'unpaid') <> 'paid'
                 )
               )
             )
           )
         RETURNING id`,
        [id, currentMonthKey, currentMonthStart, nextMonthStart]
      )
      const d2 = await client.query(
        `DELETE FROM property_expenses
         WHERE fixed_expense_id = $1
           AND ${guard}
           AND (
             (
               coalesce(month_key,'') <> ''
               AND (
                 month_key > $2
                 OR (month_key = $2 AND coalesce(status,'unpaid') <> 'paid')
               )
             )
             OR (
               (coalesce(month_key,'') = '')
               AND $4 <> ''
               AND (
                 (COALESCE(paid_date, due_date, occurred_at::date) >= to_date($4,'YYYY-MM-DD'))
                 OR (
                   COALESCE(paid_date, due_date, occurred_at::date) >= to_date($3,'YYYY-MM-DD')
                   AND COALESCE(paid_date, due_date, occurred_at::date) < to_date($4,'YYYY-MM-DD')
                   AND coalesce(status,'unpaid') <> 'paid'
                 )
               )
             )
           )
         RETURNING id`,
        [id, currentMonthKey, currentMonthStart, nextMonthStart]
      )
      return { before, after, cleared_company_expenses: Number(d1.rowCount || 0), cleared_property_expenses: Number(d2.rowCount || 0), from_month_key: currentMonthKey }
    })
    if ((result as any)?.notFound) return res.status(404).json({ message: 'not found' })
    if ((result as any)?.forbidden) return res.status(403).json({ message: 'forbidden' })
    addAudit('RecurringPayment', String(id), 'pause', (result as any).before, (result as any).after, (req as any).user?.sub)
    return res.json({ ok: true, paused: true, cleared_company_expenses: (result as any).cleared_company_expenses || 0, cleared_property_expenses: (result as any).cleared_property_expenses || 0, from_month_key: (result as any).from_month_key || null })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'pause failed' })
  }
})

router.post('/payments/:id/resume', requireAnyPerm(['recurring_payments.write', 'finance.tx.write']), async (req, res) => {
  if (!hasPg) return res.status(500).json({ message: 'pg not available' })
  const { id } = req.params
  const parsed = resumeSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const monthKey = String(parsed.data.month_key || currentMonthKeyAU())
  const currentMonthKey = currentMonthKeyAU()
  const monthIdx = monthKeyToIndex(monthKey)
  const curIdx = monthKeyToIndex(currentMonthKey)
  if (!Number.isFinite(monthIdx) || !Number.isFinite(curIdx)) return res.status(400).json({ message: 'invalid month key' })
  try {
    const result = await pgRunInTransaction(async (client) => {
      await applyTxTimeouts(client)
      await ensureSchemasOnce()
      await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [202603, String(id)])
      const beforeRes = await client.query('SELECT * FROM recurring_payments WHERE id = $1', [id])
      const before = beforeRes.rows?.[0] || null
      if (!before) return { notFound: true }
      if (isPropertyPayableTemplate(before) && !(await canAccessPropertyPayables(req))) return { forbidden: true }
      const afterRes = await client.query(`UPDATE recurring_payments SET status='active', updated_at = now() WHERE id = $1 RETURNING *`, [id])
      const after = afterRes.rows?.[0] || before

      const scope = String(after.scope || before.scope || 'company')
      const table = scope === 'property' ? 'property_expenses' : 'company_expenses'
      const dueDay = Number(after.due_day_of_month || 1)
      const startMonth = String((after as any).start_month_key || (before as any).start_month_key || '')
      const freq = isPropertyPayableTemplate(after)
        ? normalizePropertyPayableFrequencyMonths((after as any).frequency_months || (before as any).frequency_months)
        : Number((after as any).frequency_months || (before as any).frequency_months || 1)
      const isDue = startMonth ? isDueMonthKey(startMonth, monthKey, freq) : true
      if (!isDue) return { before, after, month_key: monthKey, ensured: false }
      if (isPropertyPayableTemplate(after)) {
        await ensurePropertyPayableSnapshotTx(client, after, monthKey, recurringActorId(req))
      } else {
        const dueISO = after.payment_type === 'rent_deduction' ? `${monthKey}-01` : computeDueISO(monthKey, dueDay)
        const shouldPaid = after.payment_type === 'rent_deduction' || monthIdx < curIdx
        const amount = await computeSnapshotAmountTx(client, after, monthKey)
        await upsertRecurringSnapshotTx(client, table as any, {
          fixedExpenseId: id,
          monthKey,
          occurredAt: dueISO,
          amount,
          category: after.category || 'other',
          categoryDetail: after.category_detail || null,
          dueDate: dueISO,
          paidDate: shouldPaid ? dueISO : null,
          status: shouldPaid ? 'paid' : 'unpaid',
          propertyId: scope === 'property' ? (after.property_id || before.property_id || null) : null,
        })
      }
      return { before, after, month_key: monthKey, ensured: true }
    })
    if ((result as any)?.notFound) return res.status(404).json({ message: 'not found' })
    if ((result as any)?.forbidden) return res.status(403).json({ message: 'forbidden' })
    addAudit('RecurringPayment', String(id), 'resume', (result as any).before, (result as any).after, (req as any).user?.sub)
    return res.json({ ok: true, resumed: true, month_key: (result as any).month_key || monthKey, ensured: (result as any).ensured !== false })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'resume failed' })
  }
})

router.delete('/payments/:id', requireAnyPerm(['recurring_payments.write', 'finance.tx.write']), async (req, res) => {
  if (!hasPg) return res.status(500).json({ message: 'pg not available' })
  const { id } = req.params
  const currentMonthKey = currentMonthKeyAU()
  try {
    const result = await pgRunInTransaction(async (client) => {
      await applyTxTimeouts(client)
      await ensureSchemasOnce()
      await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [202603, String(id)])
      const beforeRes = await client.query('SELECT * FROM recurring_payments WHERE id = $1', [id])
      const before = beforeRes.rows?.[0] || null
      if (!before) return { notFound: true }
      if (!isPropertyPayableTemplate(before)) return { invalid: 'only_property_payable_template_can_delete' }
      if (!(await canAccessPropertyPayables(req))) return { forbidden: true }

      const guard = `(generated_from = 'recurring_payments' OR (coalesce(generated_from,'') = '' AND coalesce(note,'') ILIKE 'Fixed payment%'))`
      const deletedSnapshots = await client.query(
        `DELETE FROM property_expenses
         WHERE fixed_expense_id = $1
           AND ${guard}
           AND coalesce(month_key,'') <> ''
           AND (
             month_key > $2
             OR (month_key = $2 AND coalesce(status,'unpaid') <> 'paid')
           )
         RETURNING id`,
        [id, currentMonthKey]
      )
      const deletedTemplate = await client.query(`DELETE FROM recurring_payments WHERE id = $1 RETURNING *`, [id])
      return { before, deleted: deletedTemplate.rows?.[0] || before, cleared_property_expenses: Number(deletedSnapshots.rowCount || 0), from_month_key: currentMonthKey }
    })
    if ((result as any)?.notFound) return res.status(404).json({ message: 'not found' })
    if ((result as any)?.forbidden) return res.status(403).json({ message: 'forbidden' })
    if ((result as any)?.invalid) return res.status(400).json({ message: String((result as any).invalid) })
    addAudit('RecurringPayment', String(id), 'delete', (result as any).before, null, (req as any).user?.sub)
    return res.json({ ok: true, deleted: true, cleared_property_expenses: (result as any).cleared_property_expenses || 0, from_month_key: (result as any).from_month_key || null })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'delete failed' })
  }
})

router.post('/payments/:id/ensure-snapshot', requireAnyPerm(['recurring_payments.write', 'finance.tx.write']), async (req, res) => {
  if (!hasPg) return res.status(500).json({ message: 'pg not available' })
  const { id } = req.params
  const parsed = resumeSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const monthKey = String(parsed.data.month_key || currentMonthKeyAU())
  const currentMonthKey = currentMonthKeyAU()
  const monthIdx = monthKeyToIndex(monthKey)
  const curIdx = monthKeyToIndex(currentMonthKey)
  if (!Number.isFinite(monthIdx) || !Number.isFinite(curIdx)) return res.status(400).json({ message: 'invalid month key' })
  try {
    const result = await pgRunInTransaction(async (client) => {
      await applyTxTimeouts(client)
      await ensureSchemasOnce()
      await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [202603, String(id)])
      const beforeRes = await client.query('SELECT * FROM recurring_payments WHERE id = $1', [id])
      const payment = beforeRes.rows?.[0] || null
      if (!payment) return { notFound: true }
      if (isPropertyPayableTemplate(payment) && !(await canAccessPropertyPayables(req))) return { forbidden: true }
      const scope = String(payment.scope || 'company')
      const table = scope === 'property' ? 'property_expenses' : 'company_expenses'
      const dueDay = Number(payment.due_day_of_month || 1)
      const startMonth = String((payment as any).start_month_key || '')
      const freq = isPropertyPayableTemplate(payment)
        ? normalizePropertyPayableFrequencyMonths((payment as any).frequency_months)
        : Number((payment as any).frequency_months || 1)
      const isDue = startMonth ? isDueMonthKey(startMonth, monthKey, freq) : true
      if (!isDue) return { ensured: false, month_key: monthKey }
      if (isPropertyPayableTemplate(payment)) {
        const rowUp = await ensurePropertyPayableSnapshotTx(client, payment, monthKey, recurringActorId(req))
        return { ensured: !!rowUp?.id, inserted: rowUp?.inserted ? 1 : 0, updated: rowUp?.inserted ? 0 : 1, month_key: monthKey }
      }
      const dueISO = payment.payment_type === 'rent_deduction' ? `${monthKey}-01` : computeDueISO(monthKey, dueDay)
      const shouldPaid = payment.payment_type === 'rent_deduction' || monthIdx < curIdx
      const rowUp = await upsertRecurringSnapshotTx(client, table as any, {
        fixedExpenseId: id,
        monthKey,
        occurredAt: dueISO,
        amount: await computeSnapshotAmountTx(client, payment, monthKey),
        category: payment.category || 'other',
        categoryDetail: payment.category_detail || null,
        dueDate: dueISO,
        paidDate: shouldPaid ? dueISO : null,
        status: shouldPaid ? 'paid' : 'unpaid',
        propertyId: scope === 'property' ? (payment.property_id || null) : null,
      })
      if (!rowUp) return { ensured: false, inserted: 0, updated: 0, month_key: monthKey }
      const status = String(rowUp?.status || 'unpaid')
      if (status === 'paid') return { ensured: true, inserted: 0, updated: 0, month_key: monthKey }
      if (String((payment as any).amount_mode || '') === 'percent_of_property_total_income' && isReferralLocked(monthKey)) {
        return { ensured: true, inserted: 0, updated: 0, month_key: monthKey, locked: true }
      }
      const wantAmount = await computeSnapshotAmountTx(client, payment, monthKey)
      const updates: string[] = []
      const vals: any[] = []
      updates.push(`amount = $${vals.length + 1}`); vals.push(wantAmount)
      updates.push(`due_date = $${vals.length + 1}`); vals.push(dueISO)
      if (shouldPaid) {
        updates.push(`status = 'paid'`)
        updates.push(`paid_date = COALESCE(paid_date, $${vals.length + 1})`); vals.push(dueISO)
      }
      const sql = `UPDATE ${table} SET ${updates.join(', ')} WHERE id = $${vals.length + 1}`
      vals.push(String(rowUp.id))
      await client.query(sql, vals)
      return { ensured: true, inserted: rowUp?.inserted ? 1 : 0, updated: rowUp?.inserted ? 0 : 1, month_key: monthKey }
    })
    if ((result as any)?.notFound) return res.status(404).json({ message: 'not found' })
    if ((result as any)?.forbidden) return res.status(403).json({ message: 'forbidden' })
    return res.json({ ok: true, ...result })
  } catch (e: any) {
    const msg = String(e?.message || 'ensure failed')
    if (/timeout exceeded when trying to connect/i.test(msg)) return res.status(503).json({ message: msg })
    if (/lock timeout/i.test(msg)) return res.status(503).json({ message: msg })
    return res.status(500).json({ message: msg })
  }
})

async function handleConfirmPropertyPayableBill(req: any, res: any) {
  if (!hasPg) return res.status(500).json({ message: 'pg not available' })
  const { id } = req.params
  const parsed = confirmAmountSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const actorId = recurringActorId(req)
  const monthKey = String(parsed.data.month_key)
  try {
    const result = await pgRunInTransaction(async (client) => {
      await applyTxTimeouts(client)
      await ensureSchemasOnce()
      await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [202604, `${id}:${monthKey}:confirm`])
      const payRes = await client.query('SELECT * FROM recurring_payments WHERE id = $1', [id])
      const payment = payRes.rows?.[0] || null
      if (!payment) return { notFound: true }
      if (!isPropertyPayableTemplate(payment)) return { invalid: 'only_property_payable_supported' }
      if (!(await canAccessPropertyPayables(req))) return { forbidden: true }
      const changed = await confirmPropertyPayableSnapshotTx(client, payment, monthKey, {
        amount: Number(parsed.data.amount || 0),
        dueDate: parsed.data.due_date || null,
        billReceivedDate: parsed.data.bill_received_date,
        billPeriodStart: parsed.data.bill_period_start,
        billPeriodEnd: parsed.data.bill_period_end,
        note: parsed.data.note,
        actorId,
      })
      if (!changed.after?.id) return { failed: true }
      addAudit('property_expenses', String(changed.after.id), 'confirm_bill', changed.before, changed.after, actorId || undefined)
      return { ok: true, snapshot_id: String(changed.after.id), month_key: monthKey, row: changed.after }
    })
    if ((result as any)?.notFound) return res.status(404).json({ message: 'not found' })
    if ((result as any)?.forbidden) return res.status(403).json({ message: 'forbidden' })
    if ((result as any)?.invalid) return res.status(400).json({ message: (result as any).invalid })
    if ((result as any)?.failed) return res.status(500).json({ message: 'confirm amount failed' })
    return res.json(result)
  } catch (e: any) {
    return res.status(500).json({ message: String(e?.message || 'confirm bill failed') })
  }
}

router.post('/payments/:id/confirm-bill', requireAnyPerm(['recurring_payments.write', 'finance.tx.write']), handleConfirmPropertyPayableBill)
router.post('/payments/:id/confirm-amount', requireAnyPerm(['recurring_payments.write', 'finance.tx.write']), handleConfirmPropertyPayableBill)

router.post('/payments/:id/mark-paid', requireAnyPerm(['recurring_payments.write', 'finance.tx.write']), async (req, res) => {
  if (!hasPg) return res.status(500).json({ message: 'pg not available' })
  const { id } = req.params
  const parsed = markPaidSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const monthKey = String(parsed.data.month_key)
  const paidDate = toISODate(parsed.data.paid_date)
  if (!paidDate) return res.status(400).json({ message: 'invalid paid_date' })
  const actorId = recurringActorId(req)
  try {
    const result = await pgRunInTransaction(async (client) => {
      await applyTxTimeouts(client)
      await ensureSchemasOnce()
      await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [202604, `${id}:${monthKey}`])
      const payRes = await client.query('SELECT * FROM recurring_payments WHERE id = $1', [id])
      const payment = payRes.rows?.[0] || null
      if (!payment) return { notFound: true }
      if (isPropertyPayableTemplate(payment)) {
        if (!(await canAccessPropertyPayables(req))) return { forbidden: true }
        const ensured = await ensurePropertyPayableSnapshotTx(client, payment, monthKey, actorId)
        const expenseId = String(ensured?.id || '').trim()
        if (!expenseId) return { failed: true }
        const before = await getPropertyPayableSnapshotTx(client, String(payment.id), monthKey)
        if (!normalizeBool(before?.amount_confirmed)) return { confirmationRequired: true }
        const upd = await client.query(
          `UPDATE property_expenses
              SET status = 'paid',
                  paid_date = $1,
                  paid_by = $2,
                  paid_confirmed_at = now()
            WHERE id = $3
            RETURNING *`,
          [paidDate, actorId, expenseId]
        )
        const after = upd.rows?.[0] || null
        addAudit('property_expenses', expenseId, 'mark_paid', before, after, actorId || undefined)
        return { ok: true, expense_id: expenseId, month_key: monthKey, row: after }
      }
      const scope = String(payment.scope || 'company')
      const table = scope === 'property' ? 'property_expenses' : 'company_expenses'
      const dueDay = Number(payment.due_day_of_month || 1)
      const dueISO = payment.payment_type === 'rent_deduction' ? `${monthKey}-01` : computeDueISO(monthKey, dueDay)
      const rowUp = await upsertRecurringSnapshotTx(client, table as any, {
        fixedExpenseId: id,
        monthKey,
        occurredAt: dueISO,
        amount: await computeSnapshotAmountTx(client, payment, monthKey),
        category: payment.category || 'other',
        categoryDetail: payment.category_detail || null,
        dueDate: dueISO,
        paidDate: null,
        status: 'unpaid',
        propertyId: scope === 'property' ? (payment.property_id || null) : null,
      })
      let expenseId = rowUp?.id ? String(rowUp.id) : ''
      if (!expenseId) return { failed: true }
      const expenseUpd = await client.query(`UPDATE ${table} SET status = 'paid', paid_date = $1 WHERE id = $2 RETURNING *`, [paidDate, expenseId])
      const rawFreq = Number(payment.frequency_months || 1)
      const freq = Number.isFinite(rawFreq) ? Math.max(1, Math.min(24, rawFreq)) : 1
      const nextMonthKey = indexToMonthKey(monthKeyToIndex(monthKey) + freq)
      const nextDueISO = payment.payment_type === 'rent_deduction' ? `${nextMonthKey}-01` : computeDueISO(nextMonthKey, dueDay)
      const templateUpd = await client.query(
        `UPDATE recurring_payments
            SET last_paid_date = $1,
                next_due_date = $2,
                status = 'active',
                updated_at = now()
          WHERE id = $3
          RETURNING *`,
        [paidDate, nextDueISO, id]
      )
      return {
        ok: true,
        expense_id: expenseId,
        month_key: monthKey,
        row: expenseUpd.rows?.[0] || null,
        template: templateUpd.rows?.[0] || null,
      }
    })
    if ((result as any)?.notFound) return res.status(404).json({ message: 'not found' })
    if ((result as any)?.forbidden) return res.status(403).json({ message: 'forbidden' })
    if ((result as any)?.confirmationRequired) return res.status(409).json({ message: '请先确认本月账单金额' })
    if ((result as any)?.failed) return res.status(500).json({ message: 'mark paid failed' })
    return res.json(result)
  } catch (e: any) {
    const msg = String(e?.message || 'mark paid failed')
    if (/duplicate key value violates unique constraint/i.test(msg)) return res.status(409).json({ message: msg })
    if (/timeout exceeded when trying to connect/i.test(msg)) return res.status(503).json({ message: msg })
    if (/lock timeout/i.test(msg)) return res.status(503).json({ message: msg })
    return res.status(500).json({ message: msg })
  }
})

router.post('/payments/:id/unmark-paid', requireAnyPerm(['recurring_payments.write', 'finance.tx.write']), async (req, res) => {
  if (!hasPg) return res.status(500).json({ message: 'pg not available' })
  const { id } = req.params
  const parsed = unmarkPaidSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const monthKey = String(parsed.data.month_key)
  const actorId = recurringActorId(req)
  try {
    const result = await pgRunInTransaction(async (client) => {
      await applyTxTimeouts(client)
      await ensureSchemasOnce()
      await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [202604, `${id}:${monthKey}`])
      const payRes = await client.query('SELECT * FROM recurring_payments WHERE id = $1', [id])
      const payment = payRes.rows?.[0] || null
      if (!payment) return { notFound: true }
      if (isPropertyPayableTemplate(payment)) {
        if (!(await canAccessPropertyPayables(req))) return { forbidden: true }
        const ensured = await ensurePropertyPayableSnapshotTx(client, payment, monthKey, actorId)
        const expenseId = String(ensured?.id || '').trim()
        if (!expenseId) return { failed: true }
        const before = await getPropertyPayableSnapshotTx(client, String(payment.id), monthKey)
        const upd = await client.query(
          `UPDATE property_expenses
              SET status = 'unpaid',
                  paid_date = NULL,
                  paid_by = NULL,
                  paid_confirmed_at = NULL
            WHERE id = $1
            RETURNING *`,
          [expenseId]
        )
        const after = upd.rows?.[0] || null
        addAudit('property_expenses', expenseId, 'unmark_paid', before, after, actorId || undefined)
        return { ok: true, expense_id: expenseId, month_key: monthKey, row: after }
      }
      const scope = String(payment.scope || 'company')
      const table = scope === 'property' ? 'property_expenses' : 'company_expenses'
      const dueDay = Number(payment.due_day_of_month || 1)
      const dueISO = payment.payment_type === 'rent_deduction' ? `${monthKey}-01` : computeDueISO(monthKey, dueDay)
      const rowUp = await upsertRecurringSnapshotTx(client, table as any, {
        fixedExpenseId: id,
        monthKey,
        occurredAt: dueISO,
        amount: await computeSnapshotAmountTx(client, payment, monthKey),
        category: payment.category || 'other',
        categoryDetail: payment.category_detail || null,
        dueDate: dueISO,
        paidDate: null,
        status: 'unpaid',
        propertyId: scope === 'property' ? (payment.property_id || null) : null,
      })
      let expenseId = rowUp?.id ? String(rowUp.id) : ''
      if (!expenseId) return { failed: true }
      await client.query(`UPDATE ${table} SET status = 'unpaid', paid_date = NULL WHERE id = $1`, [expenseId])
      return { ok: true, expense_id: expenseId, month_key: monthKey }
    })
    if ((result as any)?.notFound) return res.status(404).json({ message: 'not found' })
    if ((result as any)?.forbidden) return res.status(403).json({ message: 'forbidden' })
    if ((result as any)?.failed) return res.status(500).json({ message: 'unmark paid failed' })
    return res.json(result)
  } catch (e: any) {
    const msg = String(e?.message || 'unmark paid failed')
    if (/duplicate key value violates unique constraint/i.test(msg)) return res.status(409).json({ message: msg })
    if (/timeout exceeded when trying to connect/i.test(msg)) return res.status(503).json({ message: msg })
    if (/lock timeout/i.test(msg)) return res.status(503).json({ message: msg })
    return res.status(500).json({ message: msg })
  }
})

router.patch('/payments/:id', requireAnyPerm(['recurring_payments.write','finance.tx.write']), async (req, res) => {
  if (!hasPg) return res.status(500).json({ message: 'pg not available' })
  const { id } = req.params
  const body = req.body || {}
  const allowed = ['amount','vendor','category','category_detail','due_day_of_month','bill_expected_day_of_month','bill_period_start_day_of_month','bill_period_start_month_offset','bill_period_end_day_of_month','bill_period_end_month_offset','frequency_months','status','pay_account_name','pay_bsb','pay_account_number','pay_ref','payment_type','bpay_code','pay_mobile_number','report_category','start_month_key','amount_mode','rate_percent','income_base','property_id','property_ids','template_kind','bill_account_no','note']
  const payload: Record<string, any> = {}
  allowed.forEach(k => { if (body[k] != null) payload[k] = body[k] })
  payload.updated_by = recurringActorId(req)
  const currentMonth = currentMonthKeyAU()
  try {
    const result = await pgRunInTransaction(async (client) => {
      await applyTxTimeouts(client)
      await ensureSchemasOnce()
      await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [202603, String(id)])
      const beforeRes = await client.query('SELECT * FROM recurring_payments WHERE id = $1', [id])
      const before = (beforeRes.rows?.[0]) || null
      if (!before) return { notFound: true }
      const nextMode = String((Object.prototype.hasOwnProperty.call(payload, 'amount_mode') ? payload.amount_mode : (before as any).amount_mode) || 'fixed')
      const nextTemplateKind = String((Object.prototype.hasOwnProperty.call(payload, 'template_kind') ? payload.template_kind : (before as any).template_kind) || TEMPLATE_KIND_FIXED_EXPENSE)
      if ((isPropertyPayableTemplate(before) || nextTemplateKind === TEMPLATE_KIND_PROPERTY_PAYABLE) && !(await canAccessPropertyPayables(req))) return { forbidden: true }
      const nextPids = (() => {
        if (Object.prototype.hasOwnProperty.call(payload, 'property_ids')) {
          const ids = normalizePropertyIds(payload.property_ids)
          if (ids.length) return ids
        }
        const ids = normalizePropertyIds((before as any).property_ids)
        if (ids.length) return ids
        const single = String((Object.prototype.hasOwnProperty.call(payload, 'property_id') ? payload.property_id : (before as any).property_id) || '').trim()
        return single ? [single] : []
      })()
      const nextRateRaw = (Object.prototype.hasOwnProperty.call(payload, 'rate_percent') ? payload.rate_percent : (before as any).rate_percent)
      const nextRate = Number(nextRateRaw)
      if (nextTemplateKind === TEMPLATE_KIND_PROPERTY_PAYABLE) {
        payload.scope = 'property'
        payload.template_kind = TEMPLATE_KIND_PROPERTY_PAYABLE
        normalizePropertyPayableTemplatePayload(payload, before)
        const nextPropertyId = String((Object.prototype.hasOwnProperty.call(payload, 'property_id') ? payload.property_id : (before as any).property_id) || '').trim()
        if (!nextPropertyId) return { invalid: 'property_id required' }
        const nextExpectedDay = Number(Object.prototype.hasOwnProperty.call(payload, 'bill_expected_day_of_month') ? payload.bill_expected_day_of_month : (before as any).bill_expected_day_of_month)
        if (!Number.isFinite(nextExpectedDay) || nextExpectedDay < 1 || nextExpectedDay > 31) return { invalid: 'bill_expected_day_of_month required' }
      }
      if (nextMode === 'percent_of_property_total_income') {
        if (String((before as any).scope || 'company') === 'property') return { invalid: 'referral fee must be company scoped' }
        if (!nextPids.length) return { invalid: 'property_ids required for referral fee' }
        if (nextRateRaw == null) return { invalid: 'rate_percent required' }
        if (!Number.isFinite(nextRate) || nextRate < 0 || nextRate > 100) return { invalid: 'rate_percent invalid' }
        payload.property_ids = nextPids
        payload.property_id = nextPids.length === 1 ? nextPids[0] : null
      }
      const keys = Object.keys(payload)
      const sets = keys.map((k, i) => `${k} = $${i + 1}`)
      const values = keys.map(k => payload[k])
      const sql = `UPDATE recurring_payments SET ${sets.length ? sets.join(', ') + ', ' : ''}updated_at = now() WHERE id = $${keys.length + 1} RETURNING *`
      const updRes = await client.query(sql, [...values, id])
      const updated = (updRes.rows?.[0]) || before
      const propertyPayable = isPropertyPayableTemplate(updated)
      const scope = String(updated.scope || before.scope || 'company')
      const table = scope === 'property' ? 'property_expenses' : 'company_expenses'
      const currentIdxForSync = monthKeyToIndex(currentMonth)
      const nextMonthForSync = Number.isFinite(currentIdxForSync) ? indexToMonthKey(currentIdxForSync + 1) : currentMonth
      const syncFromMonth = propertyPayable ? nextMonthForSync : currentMonth
      const listRes = await client.query(`SELECT id, month_key FROM ${table} WHERE fixed_expense_id = $1 AND month_key >= $2 AND status = 'unpaid'`, [id, syncFromMonth])
      const rows: Array<{ id: string; month_key: string }> = Array.isArray(listRes.rows) ? listRes.rows.map((r: any) => ({ id: String(r.id), month_key: String(r.month_key || '') })) : []
      const amountChanged = Object.prototype.hasOwnProperty.call(payload, 'amount')
      const modeChanged = Object.prototype.hasOwnProperty.call(payload, 'amount_mode') || Object.prototype.hasOwnProperty.call(payload, 'rate_percent') || Object.prototype.hasOwnProperty.call(payload, 'income_base') || Object.prototype.hasOwnProperty.call(payload, 'property_id') || Object.prototype.hasOwnProperty.call(payload, 'property_ids')
      const dueChanged = Object.prototype.hasOwnProperty.call(payload, 'due_day_of_month')
      const billExpectedChanged = propertyPayable && Object.prototype.hasOwnProperty.call(payload, 'bill_expected_day_of_month')
      const newAmount = Number(payload.amount || 0)
      const newDueDay = Number(payload.due_day_of_month || updated.due_day_of_month || before.due_day_of_month || 1)
      let cnt = 0
      const incomeCache: Record<string, number> = {}
      for (const r of rows) {
        const sets2: string[] = []
        const vals2: any[] = []
        const pushSet = (column: string, value: any) => {
          vals2.push(value)
          sets2.push(`${column} = $${vals2.length}`)
        }
        if ((amountChanged && !modeChanged) && String((updated as any).amount_mode || '') !== 'percent_of_property_total_income') {
          pushSet('amount', newAmount)
        } else if ((amountChanged || modeChanged)) {
          const amt = await computeSnapshotAmountTx(client, updated, r.month_key, incomeCache)
          pushSet('amount', amt)
        }
        if (dueChanged) {
          const dueISO = computeDueISO(r.month_key, newDueDay)
          pushSet('due_date', dueISO)
        }
        if (billExpectedChanged) {
          const expectedISO = computeMonthDayISO(r.month_key, payload.bill_expected_day_of_month, 0)
          pushSet('bill_expected_date', expectedISO)
        }
        if (!sets2.length) continue
        const sql2 = `UPDATE ${table} SET ${sets2.join(', ')} WHERE id = $${vals2.length + 1}`
        await client.query(sql2, [...vals2, r.id])
        cnt++
      }

      let autoMarked = 0
      const startMonthForRule = String((Object.prototype.hasOwnProperty.call(payload, 'start_month_key') ? payload.start_month_key : (updated as any).start_month_key) || (before as any).start_month_key || '')
      const rawFreqForRule = (Object.prototype.hasOwnProperty.call(payload, 'frequency_months') ? payload.frequency_months : (updated as any).frequency_months) || (before as any).frequency_months || 1
      const freqForRule = propertyPayable ? normalizePropertyPayableFrequencyMonths(rawFreqForRule) : Number(rawFreqForRule)

      if (!propertyPayable && Object.prototype.hasOwnProperty.call(payload, 'start_month_key')) {
        const startMonth = String(payload.start_month_key || '')
        const startIdx = monthKeyToIndex(startMonth)
        const curIdx = monthKeyToIndex(currentMonth)
        if (Number.isFinite(startIdx) && Number.isFinite(curIdx)) {
          const pastEndIdx = curIdx - 1
          const pastEndMonthKey = startIdx <= pastEndIdx ? indexToMonthKey(pastEndIdx) : ''
          const pastMonths = pastEndMonthKey ? dueMonthKeysBetween(startMonth, pastEndMonthKey, freqForRule) : []
          if (pastMonths.length <= 240) {
            const dueDay = Number(updated.due_day_of_month || 1)
            const existingRes = await client.query(
              `SELECT id, month_key, status, due_date, paid_date FROM ${table} WHERE fixed_expense_id = $1 AND month_key >= $2 AND month_key <= $3`,
              [id, startMonth, currentMonth]
            )
            const byMonth: Record<string, any> = {}
            for (const r of Array.isArray(existingRes.rows) ? existingRes.rows : []) {
              const mk = String((r as any).month_key || '')
              if (mk) byMonth[mk] = r
            }
            for (const mk of pastMonths) {
              const row = byMonth[mk]
              const dueISO = updated.payment_type === 'rent_deduction' ? `${mk}-01` : computeDueISO(mk, dueDay)
              if (!row) {
                const amount = await computeSnapshotAmountTx(client, updated, mk, incomeCache)
                const rowUp = await upsertRecurringSnapshotTx(client, table as any, {
                  fixedExpenseId: id,
                  monthKey: mk,
                  occurredAt: dueISO,
                  amount,
                  category: updated.category || 'other',
                  categoryDetail: (updated as any).category_detail || null,
                  dueDate: dueISO,
                  paidDate: dueISO,
                  status: 'paid',
                  propertyId: scope === 'property' ? (updated.property_id || before.property_id || null) : null,
                })
                if (rowUp) autoMarked++
                continue
              }
              if (String((row as any).status || '') === 'paid') continue
              const nextPaid = toISODate((row as any).paid_date) || toISODate((row as any).due_date) || dueISO
              const nextDue = toISODate((row as any).due_date) || dueISO
              await client.query(`UPDATE ${table} SET status='paid', paid_date=$1, due_date=$2 WHERE id=$3`, [nextPaid, nextDue, String((row as any).id)])
              autoMarked++
            }

            if (startIdx <= curIdx && isDueMonthKey(startMonth, currentMonth, freqForRule) && !byMonth[currentMonth]) {
              const mk = currentMonth
              const dueISO = updated.payment_type === 'rent_deduction' ? `${mk}-01` : computeDueISO(mk, dueDay)
              const amount = await computeSnapshotAmountTx(client, updated, mk, incomeCache)
              await upsertRecurringSnapshotTx(client, table as any, {
                fixedExpenseId: id,
                monthKey: mk,
                occurredAt: dueISO,
                amount,
                category: updated.category || 'other',
                categoryDetail: (updated as any).category_detail || null,
                dueDate: dueISO,
                paidDate: null,
                status: 'unpaid',
                propertyId: scope === 'property' ? (updated.property_id || before.property_id || null) : null,
              })
            }
          }
        }
      }

      if (Object.prototype.hasOwnProperty.call(payload, 'start_month_key') || Object.prototype.hasOwnProperty.call(payload, 'frequency_months')) {
        if (startMonthForRule) {
          const existingUnpaid = await client.query(`SELECT id, month_key FROM ${table} WHERE fixed_expense_id = $1 AND month_key >= $2 AND status = 'unpaid'`, [id, syncFromMonth])
          const rows2: Array<{ id: string; month_key: string }> = Array.isArray(existingUnpaid.rows) ? existingUnpaid.rows.map((r: any) => ({ id: String(r.id), month_key: String(r.month_key || '') })) : []
          for (const r of rows2) {
            if (!isDueMonthKey(startMonthForRule, r.month_key, freqForRule)) {
              await client.query(`DELETE FROM ${table} WHERE id = $1`, [r.id])
            }
          }
        }
      }

      addAudit('RecurringPayment', String(id), 'update-and-sync', before, updated, (req as any).user?.sub)
      return { updated, rowCount: cnt, autoMarked }
    })
    if ((result as any)?.notFound) return res.status(404).json({ message: 'not found' })
    if ((result as any)?.forbidden) return res.status(403).json({ message: 'forbidden' })
    if ((result as any)?.invalid) return res.status(400).json({ message: String((result as any).invalid) })
    const { updated, rowCount, autoMarked } = result as any
    return res.json({ ok: true, updated, syncedCount: rowCount, autoMarked: Number(autoMarked || 0), currentMonth })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'update failed' })
  }
})

export default router
