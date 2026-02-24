import dotenv from 'dotenv'
import path from 'path'
dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), override: true })
dotenv.config()
import { pgPool } from '../src/dbAdapter'
import { ymdInTz, inferYearByDelta } from '../src/modules/jobs'
import { syncOrderToCleaningTasks } from '../src/services/cleaningSync'

function recompute(base: Date, origDay: string | null): string | null {
  if (!origDay) return null
  const o = new Date(origDay)
  if (isNaN(o.getTime())) return null
  const b = ymdInTz(base, 'Australia/Melbourne')
  const month = o.getMonth() + 1
  const day = o.getDate()
  const year = inferYearByDelta(b.year, b.month, month)
  return `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`
}

async function run() {
  if (!pgPool) { console.error('DATABASE_URL not set'); process.exit(1) }
  const rs = await pgPool.query(`
    SELECT id, confirmation_code, email_header_at, checkin, checkout
    FROM orders
    WHERE source IN ('airbnb_email','airbnb_email_import_v1')
      AND email_header_at IS NOT NULL
      AND EXTRACT(YEAR FROM email_header_at) = 2026
      AND (EXTRACT(YEAR FROM checkin) = 2027 OR EXTRACT(YEAR FROM checkout) = 2027)
  `)
  const rows = rs.rows || []
  let updated = 0
  for (const r of rows) {
    try {
      const base = new Date(r.email_header_at)
      const ciNew = recompute(base, r.checkin ? String(r.checkin).slice(0,10) : null)
      const coNew = recompute(base, r.checkout ? String(r.checkout).slice(0,10) : null)
      await pgPool.query('UPDATE orders SET checkin = COALESCE($2::date, checkin), checkout = COALESCE($3::date, checkout) WHERE id=$1', [r.id, ciNew, coNew])
      try { await syncOrderToCleaningTasks(String(r.id)) } catch {}
      updated++
    } catch (e) {
      console.error('fix_failed', r.id, e)
    }
  }
  console.log(JSON.stringify({ updated, scanned: rows.length }))
  await pgPool.end()
}

run().catch(async (e)=>{ console.error(e); if (pgPool) await pgPool.end(); process.exit(1) })
