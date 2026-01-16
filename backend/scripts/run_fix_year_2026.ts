import dotenv from 'dotenv'
import path from 'path'
import fs from 'fs'
dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), override: true })
dotenv.config()
import { pgPool } from '../src/dbAdapter'

async function run() {
  if (!pgPool) {
    console.error('DATABASE_URL not set')
    process.exit(1)
  }
  const sqlPath = path.resolve(__dirname, 'fix_airbnb_email_year_2026.sql')
  const sql = fs.readFileSync(sqlPath, 'utf8')
  await pgPool.query(sql)
  console.log('fix_year_2026_completed')
  await pgPool.end()
}

run().catch(async (e) => {
  console.error(e)
  if (pgPool) await pgPool.end()
  process.exit(1)
})