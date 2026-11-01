import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { Pool, type PoolClient } from 'pg'
import { updatePasswordOnlyTaskSortOrder } from '../../src/services/passwordOnlyTaskReorder'

const connectionString = String(process.env.MZ093_TEST_DATABASE_URL || '').trim()
const expectedDataDirectory = String(process.env.MZ093_TEST_DATA_DIR || '').trim()
const schema = `mz093_reorder_${process.pid}_${Date.now()}`
const quoteIdentifier = (value: string) => `"${value.replace(/"/g, '""')}"`
const qualified = (table: string) => `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`

function assertSafeEphemeralTarget() {
  if (String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production') {
    throw new Error('MZ093_TEST_refuses_NODE_ENV_production')
  }
  if (!connectionString) throw new Error('MZ093_TEST_DATABASE_URL_required')
  if (process.env.MZ093_TEST_DATABASE_WRITE !== 'yes') throw new Error('MZ093_TEST_DATABASE_WRITE=yes_required')
  if (process.env.MZ093_TEST_CONFIRM_EPHEMERAL !== 'yes') throw new Error('MZ093_TEST_CONFIRM_EPHEMERAL=yes_required')
  if (!expectedDataDirectory) throw new Error('MZ093_TEST_DATA_DIR_required')

  const url = new URL(connectionString)
  if (!['postgres:', 'postgresql:'].includes(url.protocol.toLowerCase())) throw new Error('MZ093_TEST_DATABASE_URL_invalid')
  if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname.toLowerCase())) throw new Error('MZ093_TEST_requires_loopback_host')
  if (!url.port || url.port === '5432') throw new Error('MZ093_TEST_requires_explicit_nondefault_port')
  const username = decodeURIComponent(url.username)
  if (!/^mz093_runner(?:_[a-z0-9_]+)?$/i.test(username)) {
    throw new Error('MZ093_TEST_requires_dedicated_database_user')
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''))
  if (!/^mz093_test_[a-z0-9_]+$/i.test(database)) throw new Error('MZ093_TEST_requires_dedicated_database_name')

  const resolvedDataDirectory = fs.realpathSync(expectedDataDirectory)
  const temporaryRoot = fs.realpathSync('/tmp')
  if (!resolvedDataDirectory.startsWith(`${temporaryRoot}${path.sep}`)) {
    throw new Error('MZ093_TEST_DATA_DIR_must_be_under_tmp')
  }
  return { database, port: Number(url.port), resolvedDataDirectory, username }
}

async function begin(client: PoolClient) {
  await client.query('BEGIN')
  await client.query(`SET LOCAL search_path TO ${quoteIdentifier(schema)}, pg_catalog`)
  await client.query("SET LOCAL lock_timeout='5s'")
  await client.query("SET LOCAL statement_timeout='15s'")
}

async function rollbackAndRelease(client: PoolClient) {
  try {
    await client.query('ROLLBACK')
  } catch (error) {
    client.release(error instanceof Error ? error : new Error(String(error)))
    throw error
  }
  client.release()
}

async function insertCleaningTask(pool: Pool, values: {
  id: string
  assigneeId?: string
  date?: string
  status?: string
  executionState?: string
  taskType?: string
  scope?: string
  sortIndex?: number
}) {
  await pool.query(
    `INSERT INTO ${qualified('cleaning_tasks')}(
       id, task_date, date, status, execution_state, task_type, type,
       inspection_scope, assignee_id, sort_index_inspector
     ) VALUES ($1,$2::date,$2::date,$3,$4,$5,$5,$6,$7,$8)`,
    [
      values.id,
      values.date || '2026-11-01',
      values.status || 'assigned',
      values.executionState || 'active',
      values.taskType || 'checkin_clean',
      values.scope || 'password_only',
      values.assigneeId || 'executor-1',
      values.sortIndex ?? 40,
    ],
  )
}

async function assertSortIndexes(pool: Pool, expected: Record<string, number>) {
  const ids = Object.keys(expected).sort()
  const result = await pool.query(
    `SELECT id, sort_index_inspector FROM ${qualified('cleaning_tasks')} WHERE id = ANY($1::text[]) ORDER BY id`,
    [ids],
  )
  assert.deepEqual(
    result.rows.map((row) => [String(row.id), Number(row.sort_index_inspector)]),
    ids.map((id) => [id, expected[id]]),
  )
}

async function assertGuardedWriteBoundaries(pool: Pool) {
  const cases = [
    { id: 'wrong-owner', assigneeId: 'executor-2' },
    { id: 'wrong-date', date: '2026-11-02' },
    { id: 'wrong-type', taskType: 'checkout_clean' },
    { id: 'wrong-scope', scope: 'inspect_and_hang' },
    { id: 'terminal', status: 'completed' },
    { id: 'superseded', executionState: 'superseded' },
  ]
  for (const fixture of cases) await insertCleaningTask(pool, { ...fixture, sortIndex: 40 })

  for (const fixture of cases) {
    const client = await pool.connect()
    try {
      await begin(client)
      await assert.rejects(
        updatePasswordOnlyTaskSortOrder({
          client,
          entries: [{ id: fixture.id, sort_index: 1 }],
          date: '2026-11-01',
          userId: 'executor-1',
        }),
        (error: any) => error?.statusCode === 403 && error?.message === 'forbidden',
        `${fixture.id} must fail closed at the guarded UPDATE`,
      )
    } finally {
      await rollbackAndRelease(client)
    }
  }
  await assertSortIndexes(pool, Object.fromEntries(cases.map((fixture) => [fixture.id, 40])))
}

async function assertWholeBatchRollback(pool: Pool) {
  await insertCleaningTask(pool, { id: 'batch-owned', sortIndex: 41 })
  await insertCleaningTask(pool, { id: 'batch-other', assigneeId: 'executor-2', sortIndex: 42 })
  await pool.query(`INSERT INTO ${qualified('work_tasks')}(id, sort_index) VALUES ('batch-work', 9)`)

  const client = await pool.connect()
  try {
    await begin(client)
    await client.query("UPDATE work_tasks SET sort_index=1, updated_at=now() WHERE id='batch-work'")
    await assert.rejects(
      updatePasswordOnlyTaskSortOrder({
        client,
        entries: [
          { id: 'batch-owned', sort_index: 2 },
          { id: 'batch-other', sort_index: 3 },
        ],
        date: '2026-11-01',
        userId: 'executor-1',
      }),
      (error: any) => error?.statusCode === 403,
      'one unauthorized source must reject the mixed batch after the SQL updates only the owned source',
    )
  } finally {
    await rollbackAndRelease(client)
  }

  await assertSortIndexes(pool, { 'batch-other': 42, 'batch-owned': 41 })
  const work = await pool.query(`SELECT sort_index FROM ${qualified('work_tasks')} WHERE id='batch-work'`)
  assert.equal(Number(work.rows[0]?.sort_index), 9, 'a prior work-task update must roll back with the rejected executor item')
}

async function assertAssertionFailureStillRollsBack(pool: Pool) {
  await insertCleaningTask(pool, { id: 'harness-assertion-failure', sortIndex: 44 })

  const exerciseFailurePath = async () => {
    const client = await pool.connect()
    try {
      await begin(client)
      await client.query(
        `UPDATE ${qualified('cleaning_tasks')} SET sort_index_inspector=99 WHERE id='harness-assertion-failure'`,
      )
      await assert.rejects(Promise.resolve(), 'deliberate assertion failure must still reach transaction cleanup')
    } finally {
      await rollbackAndRelease(client)
    }
  }

  await assert.rejects(
    exerciseFailurePath(),
    (error: any) => error?.name === 'AssertionError',
    'the deliberate assertion failure must propagate after rollback',
  )
  await assertSortIndexes(pool, { 'harness-assertion-failure': 44 })
}

async function assertConcurrentReassignmentFailsClosed(pool: Pool) {
  await insertCleaningTask(pool, { id: 'assignment-race', sortIndex: 43 })
  const reassigner = await pool.connect()
  const reorderer = await pool.connect()
  try {
    await begin(reassigner)
    await reassigner.query("UPDATE cleaning_tasks SET assignee_id='executor-2' WHERE id='assignment-race'")

    await begin(reorderer)
    const state = { value: 'pending' }
    const reorderOutcomePromise = updatePasswordOnlyTaskSortOrder({
      client: reorderer,
      entries: [{ id: 'assignment-race', sort_index: 1 }],
      date: '2026-11-01',
      userId: 'executor-1',
    }).then(
      () => {
        state.value = 'resolved'
        return { ok: true as const }
      },
      (error) => {
        state.value = 'rejected'
        return { ok: false as const, error }
      },
    )

    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(state.value, 'pending', 'the reorder UPDATE must wait for the concurrent assignee row lock')
    await reassigner.query('COMMIT')
    const reorderOutcome = await reorderOutcomePromise
    assert.equal(reorderOutcome.ok, false, 'the stale reorder must reject after reassignment commits')
    assert.ok(
      !reorderOutcome.ok
        && reorderOutcome.error?.statusCode === 403
        && reorderOutcome.error?.message === 'forbidden',
      'PostgreSQL must recheck assignee ownership after the concurrent reassignment commits',
    )
  } finally {
    const cleanupResults = await Promise.allSettled([
      rollbackAndRelease(reassigner),
      rollbackAndRelease(reorderer),
    ])
    for (const result of cleanupResults) {
      if (result.status === 'rejected') throw result.reason
    }
  }

  const row = await pool.query(
    `SELECT assignee_id, sort_index_inspector FROM ${qualified('cleaning_tasks')} WHERE id='assignment-race'`,
  )
  assert.equal(String(row.rows[0]?.assignee_id), 'executor-2')
  assert.equal(Number(row.rows[0]?.sort_index_inspector), 43, 'stale executor ordering must not survive the reassignment race')
}

async function main() {
  const safeTarget = assertSafeEphemeralTarget()
  const pool = new Pool({
    connectionString,
    max: 6,
    application_name: 'mz093-password-only-reorder-ephemeral-pg',
  })
  let schemaCreated = false
  let primaryError: unknown
  try {
    // Identity is proven with SELECT-only statements before this test executes DDL.
    const identity = await pool.query(`
      SELECT current_database() AS database,
             current_user AS username,
             host(inet_server_addr()) AS server_address,
             inet_server_port() AS server_port,
             current_setting('data_directory') AS data_directory,
             current_setting('server_version_num') AS server_version_num,
             current_setting('listen_addresses') AS listen_addresses
    `)
    const actual = identity.rows[0] || {}
    assert.equal(String(actual.database), safeTarget.database)
    assert.equal(String(actual.username), safeTarget.username)
    assert.ok(['127.0.0.1', '::1'].includes(String(actual.server_address)), 'server must listen on loopback only')
    assert.equal(Number(actual.server_port), safeTarget.port)
    assert.equal(fs.realpathSync(String(actual.data_directory)), safeTarget.resolvedDataDirectory)
    assert.ok(Number(actual.server_version_num) >= 160000 && Number(actual.server_version_num) < 170000, 'PostgreSQL 16 is required')
    const listenAddresses = String(actual.listen_addresses).split(',').map((value) => value.trim().toLowerCase())
    assert.ok(
      listenAddresses.length > 0 && listenAddresses.every((value) => ['127.0.0.1', 'localhost', '::1'].includes(value)),
      'PostgreSQL must be configured to listen on loopback addresses only',
    )

    await pool.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`)
    schemaCreated = true
    await pool.query(`
      CREATE TABLE ${qualified('cleaning_tasks')} (
        id text PRIMARY KEY,
        task_date date,
        date date,
        status text,
        execution_state text,
        task_type text,
        type text,
        inspection_scope text,
        assignee_id text,
        sort_index_inspector integer,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE ${qualified('work_tasks')} (
        id text PRIMARY KEY,
        sort_index integer,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `)

    await assertGuardedWriteBoundaries(pool)
    await assertWholeBatchRollback(pool)
    await assertAssertionFailureStillRollsBack(pool)
    await assertConcurrentReassignmentFailsClosed(pool)
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    const cleanupErrors: unknown[] = []
    if (schemaCreated) {
      await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`).catch((error) => cleanupErrors.push(error))
    }
    await pool.end().catch((error) => cleanupErrors.push(error))
    if (cleanupErrors.length > 0) {
      if (primaryError) {
        console.error('MZ-093 PostgreSQL cleanup also failed:', cleanupErrors)
      } else {
        throw cleanupErrors[0]
      }
    }
  }
  console.log('MZ-093 password-only reorder PostgreSQL integration: PASS')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
