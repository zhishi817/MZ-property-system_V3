import dotenv from 'dotenv'
import path from 'path'
dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), override: true })
dotenv.config()
import { pgPool } from '../src/dbAdapter'

async function run() {
  if (!pgPool) { console.error('pg unavailable'); process.exit(1) }
  const account = process.env.AIRBNB_IMAP_USER || ''
  const r = await pgPool.query(`SELECT run_id::text AS run_id, uid FROM email_sync_items WHERE account=$1 AND status='scanned' ORDER BY created_at DESC LIMIT 1`, [account])
  const row = r.rows[0]
  if (!row) { console.log('no scanned rows'); await pgPool.end(); return }
  const conf = 'TESTCONF'
  const listing = 'Test Listing'
  const upd = await pgPool.query('UPDATE email_sync_items SET status=$4, confirmation_code=$5, listing_name=$6 WHERE account=$1 AND run_id::text=$2 AND uid=$3', [account, row.run_id, row.uid, 'parsed', conf, listing])
  console.log(JSON.stringify({ tried: { account, run_id: row.run_id, uid: row.uid }, rowCount: upd.rowCount }))
  await pgPool.end()
}

run().catch(async (e) => { console.error(e?.message || e); try { await pgPool?.end?.() } catch {}; process.exit(1) })