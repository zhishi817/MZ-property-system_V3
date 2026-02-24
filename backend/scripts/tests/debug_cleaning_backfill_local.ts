import dotenv from 'dotenv'
import path from 'path'
import assert from 'assert'
dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), override: true })
dotenv.config()
import { pgPool } from '../../src/dbAdapter'
import { ensureCleaningSchemaV2, syncOrderToCleaningTasks, backfillCleaningTasks } from '../../src/services/cleaningSync'

async function main() {
  assert.ok(pgPool, 'pg is required')
  await ensureCleaningSchemaV2()

  const from = '2026-01-14'
  const to = '2026-02-28'

  const pick = await pgPool.query(
    `
      SELECT id::text AS id, property_id::text AS property_id, status, checkin::text AS checkin, checkout::text AS checkout, nights
      FROM orders
      WHERE (checkin::date) >= ($1::date) AND (checkin::date) <= ($2::date)
        AND COALESCE(status,'') <> ''
      ORDER BY checkin ASC
      LIMIT 1
    `,
    [from, to]
  )
  const order = pick?.rows?.[0]
  assert.ok(order?.id, 'no order found in range')

  const before = await pgPool.query('SELECT COUNT(*)::int AS c FROM cleaning_tasks')
  process.stdout.write(`orders.sample.id=${order.id}\n`)
  process.stdout.write(`orders.sample.status=${String(order.status || '')}\n`)
  process.stdout.write(`orders.sample.checkin=${String(order.checkin || '')} checkout=${String(order.checkout || '')} nights=${String(order.nights ?? '')}\n`)
  process.stdout.write(`cleaning_tasks.before=${before?.rows?.[0]?.c ?? 0}\n`)

  const r1 = await syncOrderToCleaningTasks(String(order.id))
  process.stdout.write(`sync.result=${JSON.stringify(r1)}\n`)

  const tasks = await pgPool.query('SELECT id, order_id, task_type, task_date::text AS task_date, status FROM cleaning_tasks WHERE order_id::text=$1 ORDER BY task_type', [String(order.id)])
  process.stdout.write(`cleaning_tasks.for_order=${tasks?.rows?.length || 0}\n`)
  process.stdout.write(`${JSON.stringify(tasks?.rows || [], null, 2)}\n`)

  const r2 = await backfillCleaningTasks({ dateFrom: from, dateTo: to, concurrency: 2 })
  process.stdout.write(`backfill.result=${JSON.stringify(r2)}\n`)

  const after = await pgPool.query('SELECT COUNT(*)::int AS c FROM cleaning_tasks')
  process.stdout.write(`cleaning_tasks.after=${after?.rows?.[0]?.c ?? 0}\n`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
