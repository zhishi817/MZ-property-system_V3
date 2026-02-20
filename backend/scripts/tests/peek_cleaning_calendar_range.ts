import dotenv from 'dotenv'
import path from 'path'
dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), override: true })
dotenv.config()

import { pgPool } from '../../src/dbAdapter'
import { ensureCleaningSchemaV2 } from '../../src/services/cleaningSync'

async function main() {
  if (!pgPool) throw new Error('pg=false')
  await ensureCleaningSchemaV2()
  const from = '2026-02-01'
  const to = '2026-02-28'

  const r = await pgPool.query(
    `SELECT
       t.id,
       t.order_id,
       t.property_id,
       (p.code::text) AS property_code,
       (p.region::text) AS property_region,
       t.task_type,
       COALESCE(t.task_date, t.date)::text AS task_date,
       t.status,
       t.assignee_id,
       t.scheduled_at,
       t.source,
       t.auto_sync_enabled,
       t.old_code,
       t.new_code,
       (o.confirmation_code::text) AS order_code,
       (o.nights) AS nights
     FROM cleaning_tasks t
     LEFT JOIN orders o ON (o.id::text) = (t.order_id::text)
     LEFT JOIN properties p ON (p.id::text) = (t.property_id::text)
     WHERE (COALESCE(task_date, date)::date) >= ($1::date) AND (COALESCE(task_date, date)::date) <= ($2::date)
     ORDER BY COALESCE(task_date, date) ASC, property_id NULLS LAST, id
     LIMIT 5`,
    [from, to]
  )

  const mapped = (r.rows || []).map((row: any) => ({
    source: 'cleaning_tasks',
    entity_id: String(row.id),
    order_id: row.order_id ? String(row.order_id) : null,
    order_code: row.order_code ? String(row.order_code) : null,
    property_id: row.property_id ? String(row.property_id) : null,
    property_code: row.property_code ? String(row.property_code) : null,
    property_region: row.property_region ? String(row.property_region) : null,
    task_type: row.task_type ? String(row.task_type) : null,
    task_date: String(row.task_date || '').slice(0, 10),
    nights: row.nights != null ? Number(row.nights) : null,
    summary_checkout_time: '11:30',
    summary_checkin_time: '3pm',
  }))

  process.stdout.write(JSON.stringify({ from, to, sample: mapped }, null, 2) + '\n')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

