import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Client, Pool } from 'pg'

const connectionString = String(process.env.R5_2A_TEST_DATABASE_URL || '').trim()

function assertSafeNonProductionTarget() {
  if (!connectionString) throw new Error('R5_2A_TEST_DATABASE_URL is required')
  const url = new URL(connectionString)
  const database = url.pathname.replace(/^\//, '')
  if (!/(test|staging|dev|local)/i.test(database)) {
    throw new Error('R5_2A_TEST_DATABASE_URL database name must identify a non-production target')
  }
  if (process.env.R5_2A_TEST_DATABASE_WRITE !== 'yes') {
    throw new Error('set R5_2A_TEST_DATABASE_WRITE=yes only after confirming the target is non-production')
  }
}

async function main() {
  assertSafeNonProductionTarget()
  process.env.DATABASE_URL = connectionString

  const check = new Client({ connectionString, ssl: { rejectUnauthorized: false } })
  await check.connect()
  const marker = await check.query(
    "SELECT 1 FROM schema_migrations WHERE version='20260902_r5_2a_core_task_schema' LIMIT 1",
  )
  assert.equal(marker.rowCount, 1, 'apply the controlled R5-2A migration to this non-production database before this test')

  const { warmupR5TaskRuntimeSchema } = await import('../../src/lib/r5RequestSchema')
  const { emitWorkTaskEvent } = await import('../../src/services/workTaskEvents')
  await warmupR5TaskRuntimeSchema()

  const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false }, max: 10 })
  const taskId = `r5-2a-concurrency:${randomUUID()}`
  const observedSql: string[] = []
  try {
    const emitted = await Promise.all(Array.from({ length: 10 }, async () => {
      const client = await pool.connect()
      try {
        return await emitWorkTaskEvent({
          taskId,
          sourceType: 'r5_2a_test',
          sourceRefIds: [taskId],
          eventType: 'TASK_UPDATED',
          changeScope: 'detail',
          changedFields: ['test'],
          payload: { test: true },
        }, {
          query: async (sql: string, params?: any[]) => {
            observedSql.push(sql)
            return client.query(sql, params)
          },
        })
      } finally {
        client.release()
      }
    }))

    assert.equal(emitted.length, 10)
    assert.ok(emitted.every(Boolean), 'each concurrent event write must return an event')
    assert.doesNotMatch(observedSql.join('\n'), /\b(CREATE|ALTER|DROP)\b/i, 'event writes must not issue runtime DDL')

    const rows = await check.query(
      'SELECT task_version, sequence_no FROM work_task_events WHERE task_id=$1 ORDER BY task_version ASC',
      [taskId],
    )
    assert.equal(rows.rowCount, 10, 'all concurrent event writes must persist')
    assert.deepEqual(rows.rows.map((row) => Number(row.task_version)), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    assert.equal(new Set(rows.rows.map((row) => String(row.sequence_no))).size, 10, 'sequence_no must remain unique')
  } finally {
    await check.query('DELETE FROM work_task_events WHERE task_id=$1', [taskId])
    await check.query('DELETE FROM work_task_event_versions WHERE task_id=$1', [taskId])
    await pool.end()
    await check.end()
  }

  console.log('r5-2a work-task event concurrency integration: PASS')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
