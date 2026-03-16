import { Router } from 'express'
import { requireAnyPerm } from '../auth'
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

function isDueMonthKey(start: string, monthKey: string, freqMonths: number): boolean {
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

    try { await pgPool.query('ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS fixed_expense_id text;') } catch {}
    try { await pgPool.query('ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS month_key text;') } catch {}
    try { await pgPool.query('ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS due_date date;') } catch {}
    try { await pgPool.query('ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS paid_date date;') } catch {}
    try { await pgPool.query('ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS status text;') } catch {}
    try { await pgPool.query('ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS generated_from text;') } catch {}

    try { await pgPool.query('ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS fixed_expense_id text;') } catch {}
    try { await pgPool.query('ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS month_key text;') } catch {}
    try { await pgPool.query('ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS due_date date;') } catch {}
    try { await pgPool.query('ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS paid_date date;') } catch {}
    try { await pgPool.query('ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS status text;') } catch {}
    try { await pgPool.query('ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS generated_from text;') } catch {}
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
  vendor: z.string().optional(),
  category: z.string().optional(),
  category_detail: z.string().optional(),
  amount: z.coerce.number().optional(),
  due_day_of_month: z.coerce.number().optional(),
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
  start_month_key: monthKeySchema,
  amount_mode: amountModeEnum.optional(),
  rate_percent: z.coerce.number().optional(),
  income_base: incomeBaseEnum.optional(),
  initial_mark: z.enum(['paid', 'unpaid']).optional().default('unpaid'),
})
const resumeSchema = z.object({ month_key: monthKeySchema.optional() })

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
  if (cache && Object.prototype.hasOwnProperty.call(cache, mk)) return Number(cache[mk] || 0)
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
  if (cache) cache[mk] = total
  return total
}

async function computeSnapshotAmountTx(client: any, paymentRow: any, paymentMonthKey: string, incomeCache?: Record<string, number>): Promise<number> {
  const mode = String((paymentRow as any).amount_mode || 'fixed')
  if (mode !== 'percent_of_property_total_income') return round2(Number(paymentRow.amount || 0))
  const pid = String(paymentRow.property_id || '').trim()
  if (!pid) return 0
  const rate = Number((paymentRow as any).rate_percent || 0)
  if (!Number.isFinite(rate) || rate < 0) return 0
  const baseMonth = prevMonthKey(paymentMonthKey)
  if (!baseMonth) return 0
  const base = await computePropertyTotalIncomeForMonthTx(client, pid, baseMonth, incomeCache)
  return round2(Math.max(0, base) * rate / 100)
}

router.post('/payments', requireAnyPerm(['recurring_payments.write', 'finance.tx.write']), async (req, res) => {
  if (!hasPg) return res.status(500).json({ message: 'pg not available' })
  const parsed = createPaymentSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())

  const currentMonth = currentMonthKeyAU()
  const startMonth = parsed.data.start_month_key
  const startIdx = monthKeyToIndex(startMonth)
  const curIdx = monthKeyToIndex(currentMonth)
  if (!Number.isFinite(startIdx) || !Number.isFinite(curIdx)) return res.status(400).json({ message: 'invalid month key' })
  const pastEndIdx = curIdx - 1

  const { initial_mark, ...payment } = parsed.data
  const freq = Number(payment.frequency_months || 1)
  const dueDay = Number(payment.due_day_of_month || 1)
  const mode = String((payment as any).amount_mode || 'fixed')
  const rate = Number((payment as any).rate_percent || 0)
  if (payment.payment_type !== 'rent_deduction' && (!Number.isFinite(dueDay) || dueDay < 1 || dueDay > 31)) {
    return res.status(400).json({ message: 'due_day_of_month required' })
  }
  if (!Number.isFinite(freq) || freq < 1 || freq > 24) return res.status(400).json({ message: 'frequency_months invalid' })
  if (payment.scope === 'property' && !payment.property_id) return res.status(400).json({ message: 'property_id required' })
  if (mode === 'percent_of_property_total_income') {
    if (!payment.property_id) return res.status(400).json({ message: 'property_id required for referral fee' })
    if ((payment as any).rate_percent == null) return res.status(400).json({ message: 'rate_percent required' })
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) return res.status(400).json({ message: 'rate_percent invalid' })
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
      const { v4: uuid } = require('uuid')
      const incomeCache: Record<string, number> = {}

      for (const mk of pastDueMonths) {
        const dueISO = payment.payment_type === 'rent_deduction' ? `${mk}-01` : computeDueISO(mk, dueDay)
        const row = byMonth[mk]
        if (!row) {
          const id = uuid()
          const amount = await computeSnapshotAmountTx(client, payment, mk, incomeCache)
          const payload: any = {
            id,
            occurred_at: dueISO,
            amount,
            currency: 'AUD',
            category: payment.category || 'other',
            category_detail: payment.category_detail || null,
            note: 'Fixed payment snapshot',
            generated_from: 'recurring_payments',
            fixed_expense_id: payment.id,
            month_key: mk,
            due_date: dueISO,
            paid_date: dueISO,
            status: 'paid',
          }
          if (scope === 'property') payload.property_id = payment.property_id || null
          const ins2 = await client.query(
            `INSERT INTO ${table} (id, occurred_at, amount, currency, category, category_detail, note, generated_from, fixed_expense_id, month_key, due_date, paid_date, status${scope === 'property' ? ', property_id' : ''})
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13${scope === 'property' ? ',$14' : ''})
             ON CONFLICT DO NOTHING`,
            scope === 'property'
              ? [payload.id, payload.occurred_at, payload.amount, payload.currency, payload.category, payload.category_detail, payload.note, payload.generated_from, payload.fixed_expense_id, payload.month_key, payload.due_date, payload.paid_date, payload.status, payload.property_id]
              : [payload.id, payload.occurred_at, payload.amount, payload.currency, payload.category, payload.category_detail, payload.note, payload.generated_from, payload.fixed_expense_id, payload.month_key, payload.due_date, payload.paid_date, payload.status]
          )
          if (Number(ins2?.rowCount || 0) > 0) inserted++
        } else if (String((row as any).status || '') !== 'paid') {
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
        const wantPaid = initial_mark === 'paid'
        if (!row) {
          const id = uuid()
          const amount = await computeSnapshotAmountTx(client, payment, mk, incomeCache)
          const payload: any = {
            id,
            occurred_at: dueISO,
            amount,
            currency: 'AUD',
            category: payment.category || 'other',
            category_detail: payment.category_detail || null,
            note: 'Fixed payment snapshot',
            generated_from: 'recurring_payments',
            fixed_expense_id: payment.id,
            month_key: mk,
            due_date: dueISO,
            paid_date: wantPaid ? dueISO : null,
            status: wantPaid ? 'paid' : 'unpaid',
          }
          if (scope === 'property') payload.property_id = payment.property_id || null
          const ins3 = await client.query(
            `INSERT INTO ${table} (id, occurred_at, amount, currency, category, category_detail, note, generated_from, fixed_expense_id, month_key, due_date, paid_date, status${scope === 'property' ? ', property_id' : ''})
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13${scope === 'property' ? ',$14' : ''})
             ON CONFLICT DO NOTHING`,
            scope === 'property'
              ? [payload.id, payload.occurred_at, payload.amount, payload.currency, payload.category, payload.category_detail, payload.note, payload.generated_from, payload.fixed_expense_id, payload.month_key, payload.due_date, payload.paid_date, payload.status, payload.property_id]
              : [payload.id, payload.occurred_at, payload.amount, payload.currency, payload.category, payload.category_detail, payload.note, payload.generated_from, payload.fixed_expense_id, payload.month_key, payload.due_date, payload.paid_date, payload.status]
          )
          if (Number(ins3?.rowCount || 0) > 0) inserted++
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
      const afterRes = await client.query(`UPDATE recurring_payments SET status='active', updated_at = now() WHERE id = $1 RETURNING *`, [id])
      const after = afterRes.rows?.[0] || before

      const scope = String(after.scope || before.scope || 'company')
      const table = scope === 'property' ? 'property_expenses' : 'company_expenses'
      const dueDay = Number(after.due_day_of_month || 1)
      const startMonth = String((after as any).start_month_key || (before as any).start_month_key || '')
      const freq = Number((after as any).frequency_months || (before as any).frequency_months || 1)
      const isDue = startMonth ? isDueMonthKey(startMonth, monthKey, freq) : true
      if (!isDue) return { before, after, month_key: monthKey, ensured: false }
      const dueISO = after.payment_type === 'rent_deduction' ? `${monthKey}-01` : computeDueISO(monthKey, dueDay)
      const shouldPaid = after.payment_type === 'rent_deduction' || monthIdx < curIdx
      const existing = await client.query(`SELECT id FROM ${table} WHERE fixed_expense_id = $1 AND month_key = $2 LIMIT 1`, [id, monthKey])
      if (!existing.rowCount) {
        const { v4: uuid } = require('uuid')
        const amount = await computeSnapshotAmountTx(client, after, monthKey)
        const payload: any = {
          id: uuid(),
          occurred_at: dueISO,
          amount,
          currency: 'AUD',
          category: after.category || 'other',
          category_detail: after.category_detail || null,
          note: 'Fixed payment snapshot',
          generated_from: 'recurring_payments',
          fixed_expense_id: id,
          month_key: monthKey,
          due_date: dueISO,
          paid_date: shouldPaid ? dueISO : null,
          status: shouldPaid ? 'paid' : 'unpaid',
        }
        if (scope === 'property') payload.property_id = after.property_id || before.property_id || null
        await client.query(
          `INSERT INTO ${table} (id, occurred_at, amount, currency, category, category_detail, note, generated_from, fixed_expense_id, month_key, due_date, paid_date, status${scope === 'property' ? ', property_id' : ''})
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13${scope === 'property' ? ',$14' : ''})
           ON CONFLICT DO NOTHING`,
          scope === 'property'
            ? [payload.id, payload.occurred_at, payload.amount, payload.currency, payload.category, payload.category_detail, payload.note, payload.generated_from, payload.fixed_expense_id, payload.month_key, payload.due_date, payload.paid_date, payload.status, payload.property_id]
            : [payload.id, payload.occurred_at, payload.amount, payload.currency, payload.category, payload.category_detail, payload.note, payload.generated_from, payload.fixed_expense_id, payload.month_key, payload.due_date, payload.paid_date, payload.status]
        )
      }
      return { before, after, month_key: monthKey, ensured: true }
    })
    if ((result as any)?.notFound) return res.status(404).json({ message: 'not found' })
    addAudit('RecurringPayment', String(id), 'resume', (result as any).before, (result as any).after, (req as any).user?.sub)
    return res.json({ ok: true, resumed: true, month_key: (result as any).month_key || monthKey, ensured: (result as any).ensured !== false })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'resume failed' })
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
      const scope = String(payment.scope || 'company')
      const table = scope === 'property' ? 'property_expenses' : 'company_expenses'
      const dueDay = Number(payment.due_day_of_month || 1)
      const startMonth = String((payment as any).start_month_key || '')
      const freq = Number((payment as any).frequency_months || 1)
      const isDue = startMonth ? isDueMonthKey(startMonth, monthKey, freq) : true
      if (!isDue) return { ensured: false, month_key: monthKey }
      const dueISO = payment.payment_type === 'rent_deduction' ? `${monthKey}-01` : computeDueISO(monthKey, dueDay)
      const shouldPaid = payment.payment_type === 'rent_deduction' || monthIdx < curIdx
      const existing = await client.query(`SELECT id, status FROM ${table} WHERE fixed_expense_id = $1 AND month_key = $2 LIMIT 1`, [id, monthKey])
      if (!existing.rowCount) {
        const wantAmount = await computeSnapshotAmountTx(client, payment, monthKey)
        const { v4: uuid } = require('uuid')
        const payload: any = {
          id: uuid(),
          occurred_at: dueISO,
          amount: wantAmount,
          currency: 'AUD',
          category: payment.category || 'other',
          category_detail: payment.category_detail || null,
          note: 'Fixed payment snapshot',
          generated_from: 'recurring_payments',
          fixed_expense_id: id,
          month_key: monthKey,
          due_date: dueISO,
          paid_date: shouldPaid ? dueISO : null,
          status: shouldPaid ? 'paid' : 'unpaid',
        }
        if (scope === 'property') payload.property_id = payment.property_id || null
        const ins = await client.query(
          `INSERT INTO ${table} (id, occurred_at, amount, currency, category, category_detail, note, generated_from, fixed_expense_id, month_key, due_date, paid_date, status${scope === 'property' ? ', property_id' : ''})
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13${scope === 'property' ? ',$14' : ''})
           ON CONFLICT DO NOTHING`,
          scope === 'property'
            ? [payload.id, payload.occurred_at, payload.amount, payload.currency, payload.category, payload.category_detail, payload.note, payload.generated_from, payload.fixed_expense_id, payload.month_key, payload.due_date, payload.paid_date, payload.status, payload.property_id]
            : [payload.id, payload.occurred_at, payload.amount, payload.currency, payload.category, payload.category_detail, payload.note, payload.generated_from, payload.fixed_expense_id, payload.month_key, payload.due_date, payload.paid_date, payload.status]
        )
        return { ensured: Number(ins?.rowCount || 0) > 0, inserted: Number(ins?.rowCount || 0), updated: 0, month_key: monthKey }
      }
      const row = existing.rows?.[0]
      const status = String(row?.status || 'unpaid')
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
      vals.push(String(row.id))
      await client.query(sql, vals)
      return { ensured: true, inserted: 0, updated: 1, month_key: monthKey }
    })
    if ((result as any)?.notFound) return res.status(404).json({ message: 'not found' })
    return res.json({ ok: true, ...result })
  } catch (e: any) {
    const msg = String(e?.message || 'ensure failed')
    if (/timeout exceeded when trying to connect/i.test(msg)) return res.status(503).json({ message: msg })
    if (/lock timeout/i.test(msg)) return res.status(503).json({ message: msg })
    return res.status(500).json({ message: msg })
  }
})

router.patch('/payments/:id', requireAnyPerm(['recurring_payments.write','finance.tx.write']), async (req, res) => {
  if (!hasPg) return res.status(500).json({ message: 'pg not available' })
  const { id } = req.params
  const body = req.body || {}
  const allowed = ['amount','vendor','category','category_detail','due_day_of_month','frequency_months','status','pay_account_name','pay_bsb','pay_account_number','pay_ref','payment_type','bpay_code','pay_mobile_number','report_category','start_month_key','amount_mode','rate_percent','income_base','property_id']
  const payload: Record<string, any> = {}
  allowed.forEach(k => { if (body[k] != null) payload[k] = body[k] })
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
      const nextPid = String((Object.prototype.hasOwnProperty.call(payload, 'property_id') ? payload.property_id : (before as any).property_id) || '').trim()
      const nextRateRaw = (Object.prototype.hasOwnProperty.call(payload, 'rate_percent') ? payload.rate_percent : (before as any).rate_percent)
      const nextRate = Number(nextRateRaw)
      if (nextMode === 'percent_of_property_total_income') {
        if (!nextPid) return { invalid: 'property_id required for referral fee' }
        if (nextRateRaw == null) return { invalid: 'rate_percent required' }
        if (!Number.isFinite(nextRate) || nextRate < 0 || nextRate > 100) return { invalid: 'rate_percent invalid' }
      }
      const keys = Object.keys(payload)
      const sets = keys.map((k, i) => `${k} = $${i + 1}`)
      const values = keys.map(k => payload[k])
      const sql = `UPDATE recurring_payments SET ${sets.length ? sets.join(', ') + ', ' : ''}updated_at = now() WHERE id = $${keys.length + 1} RETURNING *`
      const updRes = await client.query(sql, [...values, id])
      const updated = (updRes.rows?.[0]) || before
      const scope = String(updated.scope || before.scope || 'company')
      const table = scope === 'property' ? 'property_expenses' : 'company_expenses'
      const listRes = await client.query(`SELECT id, month_key FROM ${table} WHERE fixed_expense_id = $1 AND month_key >= $2 AND status = 'unpaid'`, [id, currentMonth])
      const rows: Array<{ id: string; month_key: string }> = Array.isArray(listRes.rows) ? listRes.rows.map((r: any) => ({ id: String(r.id), month_key: String(r.month_key || '') })) : []
      const amountChanged = Object.prototype.hasOwnProperty.call(payload, 'amount')
      const modeChanged = Object.prototype.hasOwnProperty.call(payload, 'amount_mode') || Object.prototype.hasOwnProperty.call(payload, 'rate_percent') || Object.prototype.hasOwnProperty.call(payload, 'income_base') || Object.prototype.hasOwnProperty.call(payload, 'property_id')
      const dueChanged = Object.prototype.hasOwnProperty.call(payload, 'due_day_of_month')
      const newAmount = Number(payload.amount || 0)
      const newDueDay = Number(payload.due_day_of_month || updated.due_day_of_month || before.due_day_of_month || 1)
      let cnt = 0
      const incomeCache: Record<string, number> = {}
      for (const r of rows) {
        const sets2: string[] = []
        const vals2: any[] = []
        const locked = String((updated as any).amount_mode || '') === 'percent_of_property_total_income' && isReferralLocked(r.month_key)
        if ((amountChanged && !modeChanged) && String((updated as any).amount_mode || '') !== 'percent_of_property_total_income') {
          sets2.push('amount = $1'); vals2.push(newAmount)
        } else if ((amountChanged || modeChanged) && !locked) {
          const amt = await computeSnapshotAmountTx(client, updated, r.month_key, incomeCache)
          sets2.push('amount = $1'); vals2.push(amt)
        }
        if (dueChanged) {
          const dueISO = computeDueISO(r.month_key, newDueDay)
          if (sets2.length) { sets2.push('due_date = $2'); vals2.push(dueISO) } else { sets2.push('due_date = $1'); vals2.push(dueISO) }
        }
        if (!sets2.length) continue
        const sql2 = `UPDATE ${table} SET ${sets2.join(', ')} WHERE id = $${vals2.length + 1}`
        await client.query(sql2, [...vals2, r.id])
        cnt++
      }

      let autoMarked = 0
      const startMonthForRule = String((Object.prototype.hasOwnProperty.call(payload, 'start_month_key') ? payload.start_month_key : (updated as any).start_month_key) || (before as any).start_month_key || '')
      const freqForRule = Number((Object.prototype.hasOwnProperty.call(payload, 'frequency_months') ? payload.frequency_months : (updated as any).frequency_months) || (before as any).frequency_months || 1)

      if (Object.prototype.hasOwnProperty.call(payload, 'start_month_key')) {
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
            const { v4: uuid } = require('uuid')
            for (const mk of pastMonths) {
              const row = byMonth[mk]
              const dueISO = updated.payment_type === 'rent_deduction' ? `${mk}-01` : computeDueISO(mk, dueDay)
              if (!row) {
                const amount = await computeSnapshotAmountTx(client, updated, mk, incomeCache)
                const payload2: any = {
                  id: uuid(),
                  occurred_at: dueISO,
                  amount,
                  currency: 'AUD',
                  category: updated.category || 'other',
                  category_detail: (updated as any).category_detail || null,
                  note: 'Fixed payment snapshot',
                  generated_from: 'recurring_payments',
                  fixed_expense_id: id,
                  month_key: mk,
                  due_date: dueISO,
                  paid_date: dueISO,
                  status: 'paid',
                }
                if (scope === 'property') payload2.property_id = updated.property_id || before.property_id || null
                const cols = ['id','occurred_at','amount','currency','category','category_detail','note','generated_from','fixed_expense_id','month_key','due_date','paid_date','status']
                const placeholders = cols.map((_, i) => `$${i + 1}`).join(',')
                const extraCols = scope === 'property' ? ', property_id' : ''
                const extraPlaceholder = scope === 'property' ? `,$${cols.length + 1}` : ''
                const values = cols.map((k) => (payload2 as any)[k]).concat(scope === 'property' ? [payload2.property_id] : [])
                const ins4 = await client.query(
                  `INSERT INTO ${table} (${cols.join(',')}${extraCols}) VALUES (${placeholders}${extraPlaceholder}) ON CONFLICT DO NOTHING`,
                  values
                )
                if (Number(ins4?.rowCount || 0) > 0) autoMarked++
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
              const payload3: any = {
                id: uuid(),
                occurred_at: dueISO,
                amount,
                currency: 'AUD',
                category: updated.category || 'other',
                category_detail: (updated as any).category_detail || null,
                note: 'Fixed payment snapshot',
                generated_from: 'recurring_payments',
                fixed_expense_id: id,
                month_key: mk,
                due_date: dueISO,
                paid_date: null,
                status: 'unpaid',
              }
              if (scope === 'property') payload3.property_id = updated.property_id || before.property_id || null
              const cols = ['id','occurred_at','amount','currency','category','category_detail','note','generated_from','fixed_expense_id','month_key','due_date','paid_date','status']
              const placeholders = cols.map((_, i) => `$${i + 1}`).join(',')
              const extraCols = scope === 'property' ? ', property_id' : ''
              const extraPlaceholder = scope === 'property' ? `,$${cols.length + 1}` : ''
              const values = cols.map((k) => (payload3 as any)[k]).concat(scope === 'property' ? [payload3.property_id] : [])
              const ins5 = await client.query(
                `INSERT INTO ${table} (${cols.join(',')}${extraCols}) VALUES (${placeholders}${extraPlaceholder}) ON CONFLICT DO NOTHING`,
                values
              )
              void ins5
            }
          }
        }
      }

      if (Object.prototype.hasOwnProperty.call(payload, 'start_month_key') || Object.prototype.hasOwnProperty.call(payload, 'frequency_months')) {
        if (startMonthForRule) {
          const existingUnpaid = await client.query(`SELECT id, month_key FROM ${table} WHERE fixed_expense_id = $1 AND month_key >= $2 AND status = 'unpaid'`, [id, currentMonth])
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
    if ((result as any)?.invalid) return res.status(400).json({ message: String((result as any).invalid) })
    const { updated, rowCount, autoMarked } = result as any
    return res.json({ ok: true, updated, syncedCount: rowCount, autoMarked: Number(autoMarked || 0), currentMonth })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'update failed' })
  }
})

export default router
