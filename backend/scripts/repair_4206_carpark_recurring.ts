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

  const propertyCode = 'MSQ4206E'
  const category = '车位租金'
  const reportCategory = 'parking_fee'

  const propRes = await pgPool.query(`SELECT id, code FROM properties WHERE code = $1 LIMIT 1`, [propertyCode])
  const prop = propRes.rows?.[0]
  if (!prop?.id) {
    console.error(`property not found: ${propertyCode}`)
    process.exit(1)
  }
  const propertyId = String(prop.id)

  const fixedIdsRes = await pgPool.query(
    `SELECT fixed_expense_id, COUNT(*)::int AS cnt
     FROM property_expenses
     WHERE property_id = $1 AND category = $2 AND fixed_expense_id IS NOT NULL
     GROUP BY fixed_expense_id
     ORDER BY cnt DESC`,
    [propertyId, category]
  )
  const fixedId = String(fixedIdsRes.rows?.[0]?.fixed_expense_id || '')
  const fixedCount = Number(fixedIdsRes.rows?.[0]?.cnt || 0)
  if (!fixedId) {
    console.error(`no fixed_expense_id snapshots found for ${propertyCode} ${category}`)
    process.exit(1)
  }

  const monthRangeRes = await pgPool.query(
    `SELECT MIN(month_key) AS min_mk, MAX(month_key) AS max_mk
     FROM property_expenses
     WHERE fixed_expense_id = $1`,
    [fixedId]
  )
  const minMk = String(monthRangeRes.rows?.[0]?.min_mk || '')
  const maxMk = String(monthRangeRes.rows?.[0]?.max_mk || '')

  const latestRes = await pgPool.query(
    `SELECT amount, due_date
     FROM property_expenses
     WHERE fixed_expense_id = $1
     ORDER BY month_key DESC NULLS LAST, due_date DESC NULLS LAST, occurred_at DESC NULLS LAST
     LIMIT 1`,
    [fixedId]
  )
  const latest = latestRes.rows?.[0] || {}
  const amount = Number(latest.amount || 0)
  const dueDate = latest.due_date ? String(latest.due_date).slice(0, 10) : ''
  const dueDay = dueDate && /^\d{4}-\d{2}-\d{2}$/.test(dueDate) ? Number(dueDate.slice(8, 10)) : 7

  const currentMk = monthKeyAU()
  const startMk = minMk && /^\d{4}-\d{2}$/.test(minMk) ? minMk : currentMk
  const pastEndIdx = monthKeyToIndex(currentMk) - 1
  const pastMonths = monthKeyToIndex(startMk) <= pastEndIdx ? monthKeysBetween(startMk, indexToMonthKey(pastEndIdx)) : []
  if (pastMonths.length > 240) {
    console.error(`too many past months to backfill (${pastMonths.length}), start_month_key=${startMk}`)
    process.exit(1)
  }

  const tplRes = await pgPool.query(`SELECT id FROM recurring_payments WHERE id = $1 LIMIT 1`, [fixedId])
  const tplExists = !!tplRes.rows?.[0]?.id

  if (!tplExists) {
    await pgPool.query(
      `INSERT INTO recurring_payments
        (id, scope, property_id, vendor, category, amount, due_day_of_month, frequency_months, remind_days_before, status, payment_type, report_category, start_month_key)
       VALUES
        ($1,'property',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [fixedId, propertyId, 'Carpark rent', category, amount, dueDay, 1, 3, 'active', 'bank_account', reportCategory, startMk]
    )
  }

  const byMonthRes = await pgPool.query(
    `SELECT id, month_key FROM property_expenses WHERE fixed_expense_id = $1 AND month_key >= $2 AND month_key <= $3`,
    [fixedId, startMk, currentMk]
  )
  const hasMonth = new Set<string>((byMonthRes.rows || []).map((r: any) => String(r.month_key || '')).filter(Boolean))

  const { v4: uuid } = require('uuid')
  let inserted = 0

  for (const mk of pastMonths) {
    if (hasMonth.has(mk)) continue
    const dueISO = computeDueISO(mk, dueDay)
    await pgPool.query(
      `INSERT INTO property_expenses
        (id, occurred_at, amount, currency, category, note, generated_from, fixed_expense_id, month_key, due_date, paid_date, status, property_id)
       VALUES
        ($1,$2,$3,'AUD',$4,'Fixed payment snapshot','recurring_payments',$5,$6,$7,$8,'paid',$9)`,
      [uuid(), dueISO, amount, category, fixedId, mk, dueISO, dueISO, propertyId]
    )
    inserted++
  }

  if (!hasMonth.has(currentMk)) {
    const dueISO = computeDueISO(currentMk, dueDay)
    await pgPool.query(
      `INSERT INTO property_expenses
        (id, occurred_at, amount, currency, category, note, generated_from, fixed_expense_id, month_key, due_date, paid_date, status, property_id)
       VALUES
        ($1,$2,$3,'AUD',$4,'Fixed payment snapshot','recurring_payments',$5,$6,$7,$8,'unpaid',$9)`,
      [uuid(), dueISO, amount, category, fixedId, currentMk, dueISO, null, propertyId]
    )
    inserted++
  }

  console.log(JSON.stringify({
    ok: true,
    propertyCode,
    propertyId,
    category,
    fixedExpenseId: fixedId,
    fixedSnapshotsFound: fixedCount,
    monthKeyMin: minMk,
    monthKeyMax: maxMk,
    templateCreated: !tplExists,
    inserted
  }, null, 2))

  await pgPool.end()
}

run().catch(async (e) => {
  console.error(e)
  if (pgPool) await pgPool.end()
  process.exit(1)
})

