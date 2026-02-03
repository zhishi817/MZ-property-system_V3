import { Router } from 'express'
import { requireAnyPerm } from '../auth'
import { addAudit } from '../store'
import { hasPg, pgRunInTransaction } from '../dbAdapter'
import { z } from 'zod'

export const router = Router()

function currentMonthKeyAU(): string {
  const parts = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit' }).formatToParts(new Date())
  let y = '', m = ''
  for (const p of parts) { if ((p as any).type === 'year') y = (p as any).value; if ((p as any).type === 'month') m = (p as any).value }
  return `${y}-${m}`
}

function computeDueISO(monthKey: string, dueDay: number): string {
  const [ys, ms] = String(monthKey).split('-')
  const y = Number(ys)
  const m = Number(ms)
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const d = Math.min(Number(dueDay || 1), lastDay)
  return `${String(y)}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`
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

function monthKeysBetween(start: string, end: string): string[] {
  const a = monthKeyToIndex(start)
  const b = monthKeyToIndex(end)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return []
  if (a > b) return []
  const out: string[] = []
  for (let i = a; i <= b; i++) out.push(indexToMonthKey(i))
  return out
}

async function ensureRecurringPaymentsSchema(client: any) {
  await client.query('ALTER TABLE recurring_payments ADD COLUMN IF NOT EXISTS start_month_key text;')
  try { await client.query('ALTER TABLE recurring_payments ADD COLUMN IF NOT EXISTS report_category text;') } catch {}
}

async function ensureExpensesSchema(client: any) {
  try { await client.query('ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS fixed_expense_id text;') } catch {}
  try { await client.query('ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS month_key text;') } catch {}
  try { await client.query('ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS due_date date;') } catch {}
  try { await client.query('ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS paid_date date;') } catch {}
  try { await client.query('ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS status text;') } catch {}
  try { await client.query('ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS generated_from text;') } catch {}

  try { await client.query('ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS fixed_expense_id text;') } catch {}
  try { await client.query('ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS month_key text;') } catch {}
  try { await client.query('ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS due_date date;') } catch {}
  try { await client.query('ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS paid_date date;') } catch {}
  try { await client.query('ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS status text;') } catch {}
  try { await client.query('ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS generated_from text;') } catch {}
}

const paymentTypeEnum = z.enum(['bank_account', 'bpay', 'payid', 'rent_deduction', 'cash'])
const monthKeySchema = z.string().regex(/^\d{4}-\d{2}$/, 'invalid month_key')
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
  initial_mark: z.enum(['paid', 'unpaid']).optional().default('unpaid'),
})

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
  const pastMonths = startIdx <= pastEndIdx ? monthKeysBetween(startMonth, indexToMonthKey(pastEndIdx)) : []
  if (pastMonths.length > 240) return res.status(400).json({ message: '起始月份过早，历史月份过多（最多 240 个月）' })

  const { initial_mark, ...payment } = parsed.data
  const freq = Number(payment.frequency_months || 1)
  const dueDay = Number(payment.due_day_of_month || 1)
  if (payment.payment_type !== 'rent_deduction' && (!Number.isFinite(dueDay) || dueDay < 1 || dueDay > 31)) {
    return res.status(400).json({ message: 'due_day_of_month required' })
  }
  if (!Number.isFinite(freq) || freq < 1 || freq > 24) return res.status(400).json({ message: 'frequency_months invalid' })
  if (payment.scope === 'property' && !payment.property_id) return res.status(400).json({ message: 'property_id required' })

  try {
    const result = await pgRunInTransaction(async (client) => {
      await ensureRecurringPaymentsSchema(client)
      await ensureExpensesSchema(client)

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

      for (const mk of pastMonths) {
        const dueISO = payment.payment_type === 'rent_deduction' ? `${mk}-01` : computeDueISO(mk, dueDay)
        const row = byMonth[mk]
        if (!row) {
          const id = uuid()
          const payload: any = {
            id,
            occurred_at: dueISO,
            amount: Number(payment.amount || 0),
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
          await client.query(
            `INSERT INTO ${table} (id, occurred_at, amount, currency, category, category_detail, note, generated_from, fixed_expense_id, month_key, due_date, paid_date, status${scope === 'property' ? ', property_id' : ''})
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13${scope === 'property' ? ',$14' : ''})`,
            scope === 'property'
              ? [payload.id, payload.occurred_at, payload.amount, payload.currency, payload.category, payload.category_detail, payload.note, payload.generated_from, payload.fixed_expense_id, payload.month_key, payload.due_date, payload.paid_date, payload.status, payload.property_id]
              : [payload.id, payload.occurred_at, payload.amount, payload.currency, payload.category, payload.category_detail, payload.note, payload.generated_from, payload.fixed_expense_id, payload.month_key, payload.due_date, payload.paid_date, payload.status]
          )
          inserted++
        } else if (String((row as any).status || '') !== 'paid') {
          const nextPaid = (row as any).paid_date ? String((row as any).paid_date).slice(0, 10) : ((row as any).due_date ? String((row as any).due_date).slice(0, 10) : dueISO)
          const nextDue = (row as any).due_date ? String((row as any).due_date).slice(0, 10) : dueISO
          await client.query(`UPDATE ${table} SET status='paid', paid_date=$1, due_date=$2 WHERE id=$3`, [nextPaid, nextDue, String((row as any).id)])
          updated++
        }
      }

      if (startIdx <= curIdx) {
        const mk = currentMonth
        const dueISO = payment.payment_type === 'rent_deduction' ? `${mk}-01` : computeDueISO(mk, dueDay)
        const row = byMonth[mk]
        const wantPaid = initial_mark === 'paid'
        if (!row) {
          const id = uuid()
          const payload: any = {
            id,
            occurred_at: dueISO,
            amount: Number(payment.amount || 0),
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
          await client.query(
            `INSERT INTO ${table} (id, occurred_at, amount, currency, category, category_detail, note, generated_from, fixed_expense_id, month_key, due_date, paid_date, status${scope === 'property' ? ', property_id' : ''})
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13${scope === 'property' ? ',$14' : ''})`,
            scope === 'property'
              ? [payload.id, payload.occurred_at, payload.amount, payload.currency, payload.category, payload.category_detail, payload.note, payload.generated_from, payload.fixed_expense_id, payload.month_key, payload.due_date, payload.paid_date, payload.status, payload.property_id]
              : [payload.id, payload.occurred_at, payload.amount, payload.currency, payload.category, payload.category_detail, payload.note, payload.generated_from, payload.fixed_expense_id, payload.month_key, payload.due_date, payload.paid_date, payload.status]
          )
          inserted++
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

router.patch('/payments/:id', requireAnyPerm(['recurring_payments.write','finance.tx.write']), async (req, res) => {
  if (!hasPg) return res.status(500).json({ message: 'pg not available' })
  const { id } = req.params
  const body = req.body || {}
  const allowed = ['amount','vendor','category','category_detail','due_day_of_month','frequency_months','status','pay_account_name','pay_bsb','pay_account_number','pay_ref','payment_type','bpay_code','pay_mobile_number','report_category','start_month_key']
  const payload: Record<string, any> = {}
  allowed.forEach(k => { if (body[k] != null) payload[k] = body[k] })
  const currentMonth = currentMonthKeyAU()
  try {
    const result = await pgRunInTransaction(async (client) => {
      await ensureRecurringPaymentsSchema(client)
      await ensureExpensesSchema(client)
      const beforeRes = await client.query('SELECT * FROM recurring_payments WHERE id = $1', [id])
      const before = (beforeRes.rows?.[0]) || null
      if (!before) return { notFound: true }
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
      const dueChanged = Object.prototype.hasOwnProperty.call(payload, 'due_day_of_month')
      const newAmount = Number(payload.amount || 0)
      const newDueDay = Number(payload.due_day_of_month || updated.due_day_of_month || before.due_day_of_month || 1)
      let cnt = 0
      for (const r of rows) {
        const sets2: string[] = []
        const vals2: any[] = []
        if (amountChanged) { sets2.push('amount = $1'); vals2.push(newAmount) }
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
      if (Object.prototype.hasOwnProperty.call(payload, 'start_month_key')) {
        const startMonth = String(payload.start_month_key || '')
        const startIdx = monthKeyToIndex(startMonth)
        const curIdx = monthKeyToIndex(currentMonth)
        if (Number.isFinite(startIdx) && Number.isFinite(curIdx)) {
          const pastEndIdx = curIdx - 1
          const pastMonths = startIdx <= pastEndIdx ? monthKeysBetween(startMonth, indexToMonthKey(pastEndIdx)) : []
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
              if (!row) continue
              if (String((row as any).status || '') === 'paid') continue
              const dueISO = updated.payment_type === 'rent_deduction' ? `${mk}-01` : computeDueISO(mk, dueDay)
              const nextPaid = (row as any).paid_date ? String((row as any).paid_date).slice(0, 10) : ((row as any).due_date ? String((row as any).due_date).slice(0, 10) : dueISO)
              const nextDue = (row as any).due_date ? String((row as any).due_date).slice(0, 10) : dueISO
              await client.query(`UPDATE ${table} SET status='paid', paid_date=$1, due_date=$2 WHERE id=$3`, [nextPaid, nextDue, String((row as any).id)])
              autoMarked++
            }
          }
        }
      }

      addAudit('RecurringPayment', String(id), 'update-and-sync', before, updated, (req as any).user?.sub)
      return { updated, rowCount: cnt, autoMarked }
    })
    if ((result as any)?.notFound) return res.status(404).json({ message: 'not found' })
    const { updated, rowCount, autoMarked } = result as any
    return res.json({ ok: true, updated, syncedCount: rowCount, autoMarked: Number(autoMarked || 0), currentMonth })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'update failed' })
  }
})

export default router
