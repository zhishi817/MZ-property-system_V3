const { Pool } = require('pg')
require('dotenv').config({ path: require('path').resolve(process.cwd(), 'backend/.env.local'), override: true })
require('dotenv').config()

async function main() {
  const url = process.env.DATABASE_URL
  if (!url) { console.error('DATABASE_URL not set'); process.exit(1) }
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } })
  try {
    const r = await pool.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name='property_maintenance' ORDER BY ordinal_position")
    console.log(r.rows)
  } catch (e) {
    console.error('Query failed:', e.message)
  } finally {
    await pool.end()
  }
}

main()