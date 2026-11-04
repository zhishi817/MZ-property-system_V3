import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { Pool, PoolClient } from 'pg'

const connectionString = String(process.env.MZ065_SQL_INTEGRATION_DATABASE_URL || '').trim()
if (!connectionString) throw new Error('MZ065_SQL_INTEGRATION_DATABASE_URL_required')
if (process.env.MZ065_SQL_INTEGRATION_WRITE !== '1') {
  throw new Error('MZ065_SQL_INTEGRATION_WRITE=1_required')
}
if (process.env.MZ065_SQL_INTEGRATION_CONFIRM_EPHEMERAL !== '1') {
  throw new Error('MZ065_SQL_INTEGRATION_CONFIRM_EPHEMERAL=1_required')
}
if (process.env.CI !== 'true') throw new Error('MZ065_SQL_INTEGRATION_requires_CI=true')

const target = new URL(connectionString)
if (!['postgres:', 'postgresql:'].includes(target.protocol.toLowerCase())) {
  throw new Error('MZ065_SQL_INTEGRATION_DATABASE_URL_must_use_postgresql')
}
if (target.hostname !== '127.0.0.1') {
  throw new Error('MZ065_SQL_INTEGRATION_DATABASE_URL_must_use_numeric_loopback')
}
if ((target.port || '5432') !== '5432') {
  throw new Error('MZ065_SQL_INTEGRATION_DATABASE_URL_must_use_ci_service_port')
}
if (decodeURIComponent(target.pathname.replace(/^\//, '')) !== 'mz065_ci') {
  throw new Error('MZ065_SQL_INTEGRATION_DATABASE_URL_must_name_mz065_ci_database')
}
if (decodeURIComponent(target.username) !== 'mz065_ci') {
  throw new Error('MZ065_SQL_INTEGRATION_DATABASE_URL_must_use_mz065_ci_role')
}
if (target.search || target.hash) {
  throw new Error('MZ065_SQL_INTEGRATION_DATABASE_URL_must_not_include_query_or_fragment')
}

const backendRoot = path.resolve(__dirname, '../..')
const oldMigration = fs.readFileSync(
  path.join(backendRoot, 'scripts/migrations/20261021_mz065_manual_checkin_turnover_link.sql'),
  'utf8',
)
const newMigration = fs.readFileSync(
  path.join(backendRoot, 'scripts/migrations/20261104_mz065_manual_create_receipts.sql'),
  'utf8',
)
const failingMigration = newMigration.replace(/\nCOMMIT;\s*$/, '\nSELECT 1 / 0;\nCOMMIT;')
assert.notEqual(failingMigration, newMigration, 'rollback probe must inject a failure before COMMIT')

const pool = new Pool({ connectionString, max: 8 })

async function assertEphemeralIdentity(client: PoolClient) {
  const result = await client.query(
    `SELECT current_database() AS database,
            current_user AS role,
            inet_server_port()::int AS port,
            current_setting('server_version_num')::int AS server_version_num`,
  )
  const row = result.rows[0] || {}
  assert.equal(row.database, 'mz065_ci', 'server-reported database must be the dedicated MZ065 CI database')
  assert.equal(row.role, 'mz065_ci', 'server-reported role must be the dedicated MZ065 CI role')
  assert.equal(Number(row.port), 5432, 'server-reported port must match the CI service')
  assert.ok(Number(row.server_version_num) >= 160000, 'MZ065 integration requires PostgreSQL 16+')
}

async function createBaseline(client: PoolClient) {
  await client.query(`
    DROP TABLE IF EXISTS manual_cleaning_task_create_receipts;
    DROP TABLE IF EXISTS orders;
    DROP TABLE IF EXISTS cleaning_tasks;
    DROP TABLE IF EXISTS properties;
    DROP TABLE IF EXISTS schema_migrations;
    DROP FUNCTION IF EXISTS mz065_lock_order_turnover_boundaries();

    CREATE TABLE schema_migrations(version text PRIMARY KEY);
    CREATE TABLE properties(
      id uuid PRIMARY KEY,
      code text NOT NULL UNIQUE
    );
    CREATE TABLE cleaning_tasks(
      id text PRIMARY KEY,
      execution_state text NOT NULL DEFAULT 'active',
      status text NOT NULL DEFAULT 'pending'
    );
    CREATE TABLE orders(
      id text PRIMARY KEY,
      property_id text NOT NULL,
      checkin date,
      checkout date
    );
    INSERT INTO properties(id, code)
    VALUES ('11111111-1111-4111-8111-111111111111', 'FO1602');
  `)
  await client.query(oldMigration)
}

async function assertFailedMigrationRolledBack(client: PoolClient) {
  await assert.rejects(
    client.query(failingMigration),
    (error: any) => error?.code === '22012',
    'injected pre-COMMIT failure must surface SQLSTATE 22012',
  )
  await client.query('ROLLBACK')

  const result = await client.query(`
    SELECT
      to_regclass('public.manual_cleaning_task_create_receipts') IS NULL AS table_absent,
      NOT EXISTS (
        SELECT 1 FROM schema_migrations
        WHERE version='20261104_mz065_manual_create_receipts'
      ) AS marker_absent,
      position(
        'canonical_property_key' in pg_get_functiondef('mz065_lock_order_turnover_boundaries()'::regprocedure)
      ) = 0 AS old_function_restored,
      EXISTS (
        SELECT 1
        FROM pg_trigger t
        JOIN pg_class c ON c.oid=t.tgrelid
        WHERE c.relname='orders'
          AND t.tgname='trg_mz065_lock_order_turnover_boundaries'
          AND NOT t.tgisinternal
      ) AS old_trigger_restored
  `)
  assert.deepEqual(result.rows[0], {
    table_absent: true,
    marker_absent: true,
    old_function_restored: true,
    old_trigger_restored: true,
  })
}

async function assertMigrationInstalled(client: PoolClient) {
  const result = await client.query(`
    WITH constraints AS (
      SELECT
        bool_or(contype='p') AS has_pk,
        bool_or(
          contype='c'
          AND pg_get_constraintdef(oid) ILIKE '%status%pending%completed%'
        ) AS has_status_check
      FROM pg_constraint
      WHERE conrelid='public.manual_cleaning_task_create_receipts'::regclass
    )
    SELECT
      (SELECT count(*) FROM schema_migrations
       WHERE version='20261104_mz065_manual_create_receipts')::int AS marker_count,
      (SELECT count(*) FROM information_schema.columns
       WHERE table_schema='public'
         AND table_name='manual_cleaning_task_create_receipts')::int AS column_count,
      (SELECT has_pk FROM constraints) AS has_pk,
      (SELECT has_status_check FROM constraints) AS has_status_check,
      position(
        'canonical_property_key' in pg_get_functiondef('mz065_lock_order_turnover_boundaries()'::regprocedure)
      ) > 0 AS canonical_function,
      position(
        'LEFT JOIN properties p_id' in pg_get_functiondef('mz065_lock_order_turnover_boundaries()'::regprocedure)
      ) > 0 AS uuid_lookup,
      position(
        'LEFT JOIN properties p_code' in pg_get_functiondef('mz065_lock_order_turnover_boundaries()'::regprocedure)
      ) > 0 AS code_lookup,
      EXISTS (
        SELECT 1
        FROM pg_trigger t
        JOIN pg_class c ON c.oid=t.tgrelid
        WHERE c.relname='orders'
          AND t.tgname='trg_mz065_lock_order_turnover_boundaries'
          AND t.tgenabled='O'
          AND NOT t.tgisinternal
      ) AS trigger_enabled
  `)
  assert.deepEqual(result.rows[0], {
    marker_count: 1,
    column_count: 8,
    has_pk: true,
    has_status_check: true,
    canonical_function: true,
    uuid_lookup: true,
    code_lookup: true,
    trigger_enabled: true,
  })
}

async function assertDuplicateRequestSemantics(client: PoolClient) {
  await client.query('BEGIN')
  try {
    const first = await client.query(`
      INSERT INTO manual_cleaning_task_create_receipts(
        actor_user_id, request_id, request_hash, task_ids, task_types, status
      ) VALUES (
        'actor-duplicate', 'request-duplicate', 'hash-original',
        ARRAY['task-1']::text[], ARRAY['checkin']::text[], 'completed'
      )
      RETURNING request_hash
    `)
    assert.equal(first.rowCount, 1)

    const duplicate = await client.query(`
      INSERT INTO manual_cleaning_task_create_receipts(
        actor_user_id, request_id, request_hash, task_ids, task_types, status
      ) VALUES (
        'actor-duplicate', 'request-duplicate', 'hash-conflicting',
        ARRAY['task-2']::text[], ARRAY['checkout']::text[], 'completed'
      )
      ON CONFLICT (actor_user_id, request_id) DO NOTHING
      RETURNING request_hash
    `)
    assert.equal(duplicate.rowCount, 0, 'duplicate actor/request pair must not create a second receipt')

    const stored = await client.query(`
      SELECT request_hash, task_ids, task_types
      FROM manual_cleaning_task_create_receipts
      WHERE actor_user_id='actor-duplicate' AND request_id='request-duplicate'
    `)
    assert.deepEqual(stored.rows[0], {
      request_hash: 'hash-original',
      task_ids: ['task-1'],
      task_types: ['checkin'],
    })
  } finally {
    await client.query('ROLLBACK')
  }
}

async function assertReceiptTransactionRollback(client: PoolClient) {
  await client.query('BEGIN')
  try {
    await client.query(`
      INSERT INTO manual_cleaning_task_create_receipts(
        actor_user_id, request_id, request_hash, task_ids, task_types, status
      ) VALUES (
        'actor-rollback', 'request-before-error', 'hash-before-error',
        ARRAY['task-before-error']::text[], ARRAY['checkin']::text[], 'pending'
      )
    `)
    await assert.rejects(
      client.query(`
        INSERT INTO manual_cleaning_task_create_receipts(
          actor_user_id, request_id, request_hash, task_ids, task_types, status
        ) VALUES (
          'actor-rollback', 'request-invalid', 'hash-invalid',
          ARRAY['task-invalid']::text[], ARRAY['checkout']::text[], 'invalid-status'
        )
      `),
      (error: any) => error?.code === '23514',
      'invalid status must abort the transaction through the CHECK constraint',
    )
  } finally {
    await client.query('ROLLBACK')
  }

  const result = await client.query(`
    SELECT count(*)::int AS count
    FROM manual_cleaning_task_create_receipts
    WHERE actor_user_id='actor-rollback'
  `)
  assert.equal(result.rows[0]?.count, 0, 'an error after the first insert must roll back the full receipt transaction')
}

async function assertConcurrentReceiptDedup(clientA: PoolClient, clientB: PoolClient) {
  await clientA.query('BEGIN')
  await clientB.query('BEGIN')
  try {
    await clientA.query(`
      INSERT INTO manual_cleaning_task_create_receipts(
        actor_user_id, request_id, request_hash, task_ids, task_types, status
      ) VALUES (
        'actor-race', 'request-race', 'hash-winner',
        ARRAY['task-race']::text[], ARRAY['checkin']::text[], 'completed'
      )
    `)
    await clientB.query("SET LOCAL lock_timeout='1200ms'")
    const startedAt = Date.now()
    await assert.rejects(
      clientB.query(`
        INSERT INTO manual_cleaning_task_create_receipts(
          actor_user_id, request_id, request_hash, task_ids, task_types, status
        ) VALUES (
          'actor-race', 'request-race', 'hash-loser',
          ARRAY['task-race-2']::text[], ARRAY['checkout']::text[], 'completed'
        )
        ON CONFLICT (actor_user_id, request_id) DO NOTHING
      `),
      (error: any) => error?.code === '55P03',
      'a concurrent duplicate must wait on the uncommitted primary-key owner',
    )
    assert.ok(Date.now() - startedAt >= 900, 'concurrent duplicate must encounter a real lock wait')
    await clientB.query('ROLLBACK')
    await clientA.query('COMMIT')

    const stored = await pool.query(`
      SELECT request_hash, task_ids
      FROM manual_cleaning_task_create_receipts
      WHERE actor_user_id='actor-race' AND request_id='request-race'
    `)
    assert.deepEqual(stored.rows, [{ request_hash: 'hash-winner', task_ids: ['task-race'] }])
  } catch (error) {
    await Promise.allSettled([clientA.query('ROLLBACK'), clientB.query('ROLLBACK')])
    throw error
  } finally {
    await pool.query(`
      DELETE FROM manual_cleaning_task_create_receipts
      WHERE actor_user_id='actor-race' AND request_id='request-race'
    `)
  }
}

async function assertCanonicalTriggerLock(clientA: PoolClient, clientB: PoolClient) {
  const pids = await Promise.all([
    clientA.query('SELECT pg_backend_pid()::int AS pid'),
    clientB.query('SELECT pg_backend_pid()::int AS pid'),
  ])
  assert.notEqual(pids[0].rows[0]?.pid, pids[1].rows[0]?.pid, 'lock test must use independent sessions')

  await clientA.query('BEGIN')
  try {
    await clientA.query(`
      INSERT INTO orders(id, property_id, checkin, checkout)
      VALUES ('order-lock-owner', 'FO1602', DATE '2099-01-10', DATE '2099-01-11')
    `)

    await clientB.query('BEGIN')
    try {
      await clientB.query("SET LOCAL lock_timeout='1200ms'")
      const startedAt = Date.now()
      await assert.rejects(
        clientB.query(`
          INSERT INTO orders(id, property_id, checkin, checkout)
          VALUES (
            'order-lock-contender',
            '11111111-1111-4111-8111-111111111111',
            DATE '2099-01-11', DATE '2099-01-12'
          )
        `),
        (error: any) => error?.code === '55P03',
        'property code and UUID for the same turnover boundary must contend on one advisory lock',
      )
      assert.ok(Date.now() - startedAt >= 900, 'canonical boundary conflict must encounter a real lock wait')
    } finally {
      await clientB.query('ROLLBACK')
    }

    await clientB.query('BEGIN')
    try {
      await clientB.query("SET LOCAL lock_timeout='1200ms'")
      const nonOverlapping = await clientB.query(`
        INSERT INTO orders(id, property_id, checkin, checkout)
        VALUES (
          'order-non-overlap',
          '11111111-1111-4111-8111-111111111111',
          DATE '2099-01-12', DATE '2099-01-13'
        )
        RETURNING id
      `)
      assert.equal(nonOverlapping.rowCount, 1, 'different boundaries must remain independently writable')
    } finally {
      await clientB.query('ROLLBACK')
    }
  } finally {
    await clientA.query('ROLLBACK')
  }

  const cleanup = await pool.query(`
    SELECT count(*)::int AS count
    FROM orders
    WHERE id IN ('order-lock-owner', 'order-lock-contender', 'order-non-overlap')
  `)
  assert.equal(cleanup.rows[0]?.count, 0, 'all synthetic trigger probes must roll back')
}

async function main() {
  const admin = await pool.connect()
  const concurrentA = await pool.connect()
  const concurrentB = await pool.connect()
  try {
    await assertEphemeralIdentity(admin)
    await createBaseline(admin)
    await assertFailedMigrationRolledBack(admin)

    await admin.query(newMigration)
    await assertMigrationInstalled(admin)
    await admin.query(newMigration)
    await assertMigrationInstalled(admin)

    await assertDuplicateRequestSemantics(admin)
    await assertReceiptTransactionRollback(admin)
    await assertConcurrentReceiptDedup(concurrentA, concurrentB)
    await assertCanonicalTriggerLock(concurrentA, concurrentB)

    console.log('MZ065 manual create receipt PostgreSQL integration tests passed')
  } finally {
    admin.release()
    concurrentA.release()
    concurrentB.release()
    await pool.end()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
