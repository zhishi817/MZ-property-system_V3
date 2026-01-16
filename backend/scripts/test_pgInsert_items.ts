import dotenv from 'dotenv'
import path from 'path'
dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), override: true })
dotenv.config()
import { pgPool, pgInsert, pgDelete } from '../src/dbAdapter'
import { v4 as uuid } from 'uuid'

async function run() {
  if (!pgPool) { console.error('pg unavailable'); process.exit(1) }
  const rid = uuid()
  const payload = { run_id: rid, account: process.env.AIRBNB_IMAP_USER || '', uid: 99999999, status: 'scanned', message_id: 'test', mailbox: 'INBOX', subject: 'test', sender: 'airbnb', header_date: new Date() }
  const row = await pgInsert('email_sync_items', payload)
  console.log(JSON.stringify({ inserted: row }))
  if (row?.id) { await pgDelete('email_sync_items', String(row.id)) }
  await pgPool.end()
}

run().catch(async (e) => { console.error(e?.message || e); try { await pgPool?.end?.() } catch {}; process.exit(1) })