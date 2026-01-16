require('dotenv').config({ path: require('path').resolve(process.cwd(), '.env.local') })
const { Pool } = require('pg')
const fs = require('fs')
const path = require('path')
async function main() {
  const conn = process.env.DATABASE_URL || ''
  if (!conn) { console.error('no pg'); process.exit(1) }
  const pgPool = new Pool({ connectionString: conn, ssl: { rejectUnauthorized: false } })
  const sql = fs.readFileSync(path.join(process.cwd(), 'scripts/migrations/20260114_cleaning_app.sql'), 'utf8')
  const stmts = sql.split(/;\s*\n/).map(s => s.trim()).filter(s => s)
  const client = await pgPool.connect()
  try {
    await client.query('BEGIN')
    for (const s of stmts) { await client.query(s) }
    await client.query('COMMIT')
    console.log('ok')
  } catch (e) {
    try { await client.query('ROLLBACK') } catch {}
    console.error(e)
    process.exit(1)
  } finally {
    client.release()
  }
}
main()
