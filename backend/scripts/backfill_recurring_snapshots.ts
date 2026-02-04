import dotenv from 'dotenv'
import path from 'path'
dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), override: true })
dotenv.config()

import { pgPool } from '../src/dbAdapter'

function monthKeyAU(d: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit' }).formatToParts(d)
  let y = '', m = ''
  for (const p of parts) {
    if ((p as any).type === 'year') y = (p as any).value
    if ((p as any).type === 'month') m = (p as any).value
  }
  return `${y}-${m}`
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

function computeDueISO(monthKey: string, dueDay: number): string {
  const [ys, ms] = String(monthKey).split('-')
  const y = Number(ys)
  const m = Number(ms)
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const d = Math.min(Number(dueDay || 1), lastDay)
  return `${String(y)}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

async function run() {
  if (!pgPool) {
    console.error('DATABASE_URL not set')
    process.exit(1)
  }

  const fixedExpenseId = String(process.argv[2] || '').trim()
  if (!fixedExpenseId) {
    console.error('Usage: ts-node-dev --transpile-only scripts/backfill_recurring_snapshots.ts <fixedExpenseId>')
    process.exit(1)
  }

  const tplRes = await pgPool.query('SELECT * FROM recurring_payments WHERE id = $1', [fixedExpenseId])
  const tpl = tplRes.rows?.[0]
  if (!tpl) {
    console.error(`recurring_payments not found: ${fixedExpenseId}`)
    process.exit(1)
  }

  const scope = String(tpl.scope || 'company')
  const table = scope === 'property' ? 'property_expenses' : 'company_expenses'
  const startMonthKey = String(tpl.start_month_key || '')
  const dueDay = Number(tpl.due_day_of_month || 1)
  const currentMonthKey = monthKeyAU()

  if (!/^\d{4}-\d{2}$/.test(startMonthKey)) {
    console.error(`invalid start_month_key: ${startMonthKey}`)
    process.exit(1)
  }

  const startIdx = monthKeyToIndex(startMonthKey)
  const curIdx = monthKeyToIndex(currentMonthKey)
  if (!Number.isFinite(startIdx) || !Number.isFinite(curIdx)) {
    console.error('invalid month key')
    process.exit(1)
  }
  if (curIdx - startIdx > 240) {
    console.error(`too many months to backfill: ${curIdx - startIdx + 1}`)
    process.exit(1)
  }

  const listRes = await pgPool.query(
    `SELECT id, month_key, fixed_expense_id FROM ${table} WHERE month_key >= $1 AND month_key <= $2 AND fixed_expense_id = $3`,
    [startMonthKey, currentMonthKey, fixedExpenseId]
  )
  const existing = new Set<string>((listRes.rows || []).map((r: any) => String(r.month_key || '')).filter(Boolean))

  const allMonths = monthKeysBetween(startMonthKey, currentMonthKey)
  const { v4: uuid } = require('uuid')
  let inserted = 0

  for (const mk of allMonths) {
    if (existing.has(mk)) continue
    const dueISO = String(tpl.payment_type) === 'rent_deduction' ? `${mk}-01` : computeDueISO(mk, dueDay)
    const isPast = mk < currentMonthKey
    const payload: any = {
      id: uuid(),
      occurred_at: dueISO,
      amount: Number(tpl.amount || 0),
      currency: 'AUD',
      category: tpl.category || 'other',
      category_detail: tpl.category_detail || null,
      note: 'Fixed payment snapshot',
      generated_from: 'recurring_payments',
      fixed_expense_id: fixedExpenseId,
      month_key: mk,
      due_date: dueISO,
      paid_date: isPast ? dueISO : null,
      status: isPast ? 'paid' : 'unpaid',
    }
    if (scope === 'property') payload.property_id = tpl.property_id || null

    const cols = ['id','occurred_at','amount','currency','category','category_detail','note','generated_from','fixed_expense_id','month_key','due_date','paid_date','status']
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(',')
    const extraCols = scope === 'property' ? ', property_id' : ''
    const extraPlaceholder = scope === 'property' ? `,$${cols.length + 1}` : ''
    const values = cols.map((k) => (payload as any)[k]).concat(scope === 'property' ? [payload.property_id] : [])

    await pgPool.query(
      `INSERT INTO ${table} (${cols.join(',')}${extraCols}) VALUES (${placeholders}${extraPlaceholder}) ON CONFLICT DO NOTHING`,
      values
    )
    inserted++
  }

  console.log(JSON.stringify({ ok: true, fixedExpenseId, scope, table, startMonthKey, currentMonthKey, inserted }, null, 2))
  await pgPool.end()
}

run().catch(async (e) => {
  console.error(e)
  if (pgPool) await pgPool.end()
  process.exit(1)
})
