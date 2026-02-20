import dotenv from 'dotenv'
import path from 'path'
dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), override: true })
dotenv.config()

import { pgPool } from '../../src/dbAdapter'

async function main() {
  if (!pgPool) throw new Error('pg=false')
  const r1 = await pgPool.query("select count(*)::int as c from orders where (property_id::text) like '%true' or (property_id::text) like '%false'")
  const r2 = await pgPool.query("select property_id::text as property_id, count(*)::int as c from orders where (property_id::text) like '%true' or (property_id::text) like '%false' group by property_id::text order by c desc limit 20")
  const r3 = await pgPool.query("select count(*)::int as c from properties where (id::text) like '%true' or (id::text) like '%false'")
  const badId = r2.rows?.[0]?.property_id ? String(r2.rows[0].property_id) : null
  let badProp: any = null
  let badOrder: any = null
  if (badId) {
    const p = await pgPool.query('select * from properties where id::text=$1 limit 1', [badId])
    badProp = p.rows?.[0] || null
    const o = await pgPool.query('select id::text as id, property_id::text as property_id, confirmation_code, checkin::text as checkin, checkout::text as checkout, status from orders where property_id::text=$1 limit 5', [badId])
    badOrder = o.rows || []
  }
  console.log(JSON.stringify({ ordersPropSuffixBool: r1.rows?.[0]?.c ?? null, ordersPropSuffixTop: r2.rows || [], propertiesIdSuffixBool: r3.rows?.[0]?.c ?? null, badPropId: badId, badProp, badOrders: badOrder }, null, 2))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
