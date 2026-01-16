import dotenv from 'dotenv'
import path from 'path'
dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), override: true })
dotenv.config()
import { pgPool } from '../src/dbAdapter'

async function run() {
  if (!pgPool) { console.error('pg unavailable'); process.exit(1) }
  const account = process.env.AIRBNB_IMAP_USER || ''
  const items = await pgPool.query(`SELECT run_id::text AS run_id, COUNT(*) FILTER (WHERE status='scanned') AS scanned, COUNT(*) FILTER (WHERE status='parsed') AS parsed, COUNT(*) FILTER (WHERE status='inserted') AS inserted, COUNT(*) FILTER (WHERE status='skipped') AS skipped, COUNT(*) FILTER (WHERE status='not_matched') AS not_matched, MAX(created_at) AS last_item_at FROM email_sync_items WHERE account=$1 AND created_at > now() - interval '1 day' GROUP BY run_id ORDER BY last_item_at DESC`, [account])
  let runs
  try {
    runs = await pgPool.query(`SELECT run_id, account, status, started_at FROM email_sync_runs WHERE account=$1 ORDER BY started_at DESC LIMIT 5`, [account])
  } catch {
    runs = await pgPool.query(`SELECT account, status, started_at FROM email_sync_runs WHERE account=$1 ORDER BY started_at DESC LIMIT 5`, [account])
  }
  console.log(JSON.stringify({ items: items.rows, runs: runs.rows }, null, 2))
  await pgPool.end()
}

run().catch(async (e) => { console.error(e?.message || e); try { await pgPool?.end?.() } catch {}; process.exit(1) })