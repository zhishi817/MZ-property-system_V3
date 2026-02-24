import dotenv from 'dotenv'
import path from 'path'
dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), override: true })
dotenv.config()

import { pgPool } from '../../src/dbAdapter'

async function main() {
  if (!pgPool) throw new Error('pg=false')
  const r = await pgPool.query(
    `select id::text as id,
            confirmation_code,
            checkin::text as checkin,
            checkout::text as checkout,
            nights,
            property_id::text as property_id,
            status
     from orders
     where checkin is not null
     order by checkin desc
     limit 10`
  )
  const p = await pgPool.query(`select id::text as id, code, region, building_name from properties where code='SH1910' limit 1`)
  process.stdout.write(JSON.stringify({ orders: r.rows || [], property: p.rows?.[0] || null }, null, 2) + '\n')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

