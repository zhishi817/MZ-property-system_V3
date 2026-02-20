import dotenv from 'dotenv'
import path from 'path'
dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), override: true })
dotenv.config()

import { pgPool } from '../../src/dbAdapter'
import { ensureCleaningSchemaV2 } from '../../src/services/cleaningSync'

async function main() {
  if (!pgPool) throw new Error('pg=false')
  await ensureCleaningSchemaV2()

  const propertyId = '0402e912-9a40-4e01-a16c-17b3d0663013'
  const from = '2026-02-01'
  const to = '2026-02-28'

  const r = await pgPool.query(
    `
    SELECT
      COALESCE(t.task_date, t.date)::date AS d,
      t.task_type,
      COUNT(*)::int AS n,
      array_agg(t.order_id::text ORDER BY t.order_id::text) AS order_ids,
      array_agg(COALESCE(o.status,'') ORDER BY o.status) AS order_statuses
    FROM cleaning_tasks t
    LEFT JOIN orders o ON (o.id::text)=(t.order_id::text)
    WHERE (t.property_id::text)=$1
      AND (COALESCE(t.task_date,t.date)::date) >= ($2::date)
      AND (COALESCE(t.task_date,t.date)::date) <= ($3::date)
      AND COALESCE(t.status,'') <> 'cancelled'
      AND (t.order_id IS NULL OR o.id IS NOT NULL)
      AND (
        t.order_id IS NULL
        OR (
          COALESCE(o.status, '') <> ''
          AND lower(COALESCE(o.status, '')) <> 'invalid'
          AND lower(COALESCE(o.status, '')) NOT LIKE '%cancel%'
        )
      )
    GROUP BY COALESCE(t.task_date, t.date)::date, t.task_type
    HAVING COUNT(*) > 1
    ORDER BY d ASC, t.task_type ASC
    `,
    [propertyId, from, to]
  )
  process.stdout.write(JSON.stringify({ dup_groups: r.rows || [] }, null, 2) + '\n')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

