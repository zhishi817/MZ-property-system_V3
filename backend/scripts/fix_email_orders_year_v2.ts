import dotenv from 'dotenv'
import path from 'path'
dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), override: true })
dotenv.config()
import { pgPool } from '../src/dbAdapter'
import { ymdInTz, inferYearByDelta } from '../src/modules/jobs'

function recomputeDate(baseDate: Date, orig: Date): Date {
  const base = ymdInTz(baseDate, 'Australia/Melbourne')
  const o = { year: orig.getFullYear(), month: orig.getMonth() + 1, day: orig.getDate() }
  const y = inferYearByDelta(base.year, base.month, o.month)
  return new Date(`${String(y).padStart(4,'0')}-${String(o.month).padStart(2,'0')}-${String(o.day).padStart(2,'0')}T00:00:00Z`)
}

async function ensureLogTable() {
  const sql = `
    CREATE TABLE IF NOT EXISTS order_fix_logs (
      id text PRIMARY KEY,
      order_id text NOT NULL,
      before_checkin date,
      before_checkout date,
      after_checkin date,
      after_checkout date,
      rule_version text NOT NULL,
      fixed_at timestamptz DEFAULT now(),
      created_at timestamptz DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_order_fix ON order_fix_logs(order_id, rule_version, after_checkin, after_checkout);
  `
  await pgPool!.query(sql)
}

async function run() {
  if (!pgPool) {
    console.error('DATABASE_URL not set')
    process.exit(1)
  }
  await ensureLogTable()
  const ruleVersion = 'email_year_rule_v2'

  const rs = await pgPool.query(`
    SELECT id, source, email_header_at, year_inferred, raw_checkin_text, raw_checkout_text, checkin, checkout
    FROM orders
    WHERE source = 'email'
      AND (year_inferred = true OR (
        (raw_checkin_text IS NOT NULL AND raw_checkin_text !~ '(19|20)\\d{2}') OR
        (raw_checkout_text IS NOT NULL AND raw_checkout_text !~ '(19|20)\\d{2}')
      ))
      AND email_header_at IS NOT NULL
  `)
  const rows = rs.rows || []
  let updated = 0
  for (const r of rows) {
    try {
      const baseDate = new Date(r.email_header_at)
      const ci = r.checkin ? new Date(r.checkin) : null
      const co = r.checkout ? new Date(r.checkout) : null
      const nci = ci ? recomputeDate(baseDate, ci) : null
      const nco = co ? recomputeDate(baseDate, co) : null
      const ciChanged = ci && nci && nci.toISOString().slice(0,10) !== ci.toISOString().slice(0,10)
      const coChanged = co && nco && nco.toISOString().slice(0,10) !== co.toISOString().slice(0,10)
      if (ciChanged || coChanged) {
        await pgPool.query('BEGIN')
        const afterCheckin = nci ? nci.toISOString().slice(0,10) : null
        const afterCheckout = nco ? nco.toISOString().slice(0,10) : null
        await pgPool.query(
          'UPDATE orders SET checkin = COALESCE($2, checkin), checkout = COALESCE($3, checkout) WHERE id = $1',
          [r.id, afterCheckin, afterCheckout]
        )
        await pgPool.query(
          'INSERT INTO order_fix_logs(id, order_id, before_checkin, before_checkout, after_checkin, after_checkout, rule_version) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING',
          [require('uuid').v4(), r.id, ci ? ci.toISOString().slice(0,10) : null, co ? co.toISOString().slice(0,10) : null, afterCheckin, afterCheckout, ruleVersion]
        )
        await pgPool.query('COMMIT')
        updated++
      }
    } catch (e) {
      try { await pgPool.query('ROLLBACK') } catch {}
      console.error('fix_failed', r.id, e)
    }
  }
  console.log(JSON.stringify({ updated, scanned: rows.length, rule_version: ruleVersion }))
  await pgPool.end()
}

run().catch(async (e) => {
  console.error(e)
  if (pgPool) await pgPool.end()
  process.exit(1)
})