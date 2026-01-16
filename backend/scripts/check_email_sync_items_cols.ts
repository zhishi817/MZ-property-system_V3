import dotenv from 'dotenv'
import path from 'path'
dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), override: true })
dotenv.config()
import { pgPool } from '../src/dbAdapter'

async function run() {
  if (!pgPool) { console.error('pg not available'); process.exit(1) }
  const rs = await pgPool.query("select column_name from information_schema.columns where table_schema='public' and table_name='email_sync_items' order by column_name")
  const cols = rs.rows.map((r:any)=> String(r.column_name))
  console.log(JSON.stringify({ table: 'email_sync_items', columns: cols }))
  await pgPool.end()
}

run().catch(async (e) => { console.error(e?.message || e); try { await pgPool?.end?.() } catch {}; process.exit(1) })