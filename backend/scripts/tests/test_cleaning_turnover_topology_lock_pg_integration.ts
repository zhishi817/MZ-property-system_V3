import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { Client } from 'pg'

const connectionString = String(process.env.MZ109_TEST_DATABASE_URL || '').trim()
const expectedDataDirectory = String(process.env.MZ109_TEST_DATA_DIR || '').trim()

function checkedTarget() {
  if (!connectionString) throw new Error('MZ109_TEST_DATABASE_URL_required')
  if (process.env.MZ109_TEST_DATABASE_WRITE !== 'yes') throw new Error('MZ109_TEST_DATABASE_WRITE=yes_required')
  if (process.env.MZ109_TEST_CONFIRM_EPHEMERAL !== 'yes') throw new Error('MZ109_TEST_CONFIRM_EPHEMERAL=yes_required')
  const url = new URL(connectionString)
  if (!['postgres:', 'postgresql:'].includes(url.protocol.toLowerCase())) throw new Error('MZ109_TEST_DATABASE_URL_invalid')
  if (url.search) throw new Error('MZ109_TEST_DATABASE_URL_must_not_include_query_parameters')
  if (url.hostname !== '127.0.0.1') throw new Error('MZ109_TEST_DATABASE_URL_must_use_numeric_loopback')
  const port = Number(url.port || 5432)
  if (!Number.isInteger(port) || port <= 0 || port === 5432) throw new Error('MZ109_TEST_DATABASE_URL_must_use_random_nondefault_port')
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''))
  if (!/^mz109_test_[a-z0-9_]+$/i.test(database)) throw new Error('MZ109_TEST_DATABASE_URL_must_name_mz109_test_database')
  if (!/^\/tmp\/mz109-pg\.[A-Za-z0-9_-]+\/data$/.test(expectedDataDirectory)) throw new Error('MZ109_TEST_DATA_DIR_invalid')
  return { database, dataDirectory: expectedDataDirectory }
}

function topologyQueriesFromProductionSource() {
  const source = fs.readFileSync(path.resolve(__dirname, '../../src/modules/cleaning.ts'), 'utf8')
  const start = source.indexOf('async function assertPgExplicitTurnoverLinkTopology')
  const end = source.indexOf('function sendTurnoverInspectionScopeConflict', start)
  assert.ok(start >= 0 && end > start, 'explicit topology guard must exist')
  const guard = source.slice(start, end)
  const queries = Array.from(
    guard.matchAll(/`(SELECT task\.\*[\s\S]*?FOR UPDATE OF task)`/g),
    (match) => match[1],
  )
  assert.equal(queries.length, 2, 'test must execute both production topology-lock SQL branches')
  return { checkinQuery: queries[0], checkoutQuery: queries[1] }
}

async function expectLegacyOuterJoinLockFailure(client: Client, sql: string, parameter: string) {
  await client.query('BEGIN')
  try {
    await assert.rejects(
      client.query(sql.replace('FOR UPDATE OF task', 'FOR UPDATE'), [parameter]),
      (error: any) => error?.code === '0A000' && /nullable side of an outer join/i.test(String(error?.message || '')),
      'the pre-fix SQL must reproduce PostgreSQL nullable outer-join row-lock failure',
    )
  } finally {
    await client.query('ROLLBACK')
  }
}

async function expectTaskRowLock(
  locker: Client,
  contender: Client,
  acquireLock: () => Promise<void>,
  lockedTaskId: string,
) {
  await locker.query('BEGIN')
  await acquireLock()
  await contender.query('BEGIN')
  await contender.query("SET LOCAL statement_timeout = '250ms'")
  try {
    await assert.rejects(
      contender.query('UPDATE cleaning_tasks SET guest_special_request=$1 WHERE id=$2', ['must wait', lockedTaskId]),
      (error: any) => error?.code === '57014',
      'the selected cleaning task row must remain locked for the transaction',
    )
  } finally {
    await contender.query('ROLLBACK')
    await locker.query('COMMIT')
  }
  await contender.query('BEGIN')
  await contender.query('UPDATE cleaning_tasks SET guest_special_request=$1 WHERE id=$2', ['lock released', lockedTaskId])
  await contender.query('COMMIT')
}

async function createFixtureSchema(client: Client, schema: string) {
  await client.query(`CREATE SCHEMA ${schema}`)
  await client.query(`SET search_path TO ${schema}`)
  await client.query(`
    CREATE TABLE schema_migrations(version text PRIMARY KEY);
    INSERT INTO schema_migrations(version) VALUES
      ('20260902_r5_2a_core_task_schema'),
      ('20261101_mz091_password_authority');
    CREATE TABLE properties (id text PRIMARY KEY, code text NOT NULL UNIQUE, region text);
    CREATE TABLE orders (
      id text PRIMARY KEY, property_id text, status text, checkin date, checkout date,
      keys_required integer NOT NULL DEFAULT 1
    );
    CREATE TABLE users (
      id text PRIMARY KEY, username text, email text, role text, property_scope text[]
    );
    CREATE TABLE cleaning_tasks (
      id text PRIMARY KEY,
      property_id text,
      task_date date,
      date date,
      task_type text,
      type text,
      status text,
      execution_state text,
      source text,
      order_id text,
      linked_checkout_task_id text,
      assignee_id text,
      cleaner_id text,
      inspector_id text,
      inspection_mode text,
      inspection_scope text,
      inspection_due_date date,
      inspection_replaced_by_checkin_task_id text,
      inspection_replaced_original_due_date date,
      checkout_time text,
      checkin_time text,
      guest_special_request text,
      note text,
      keys_required integer NOT NULL DEFAULT 1,
      nights_override integer,
      scheduled_at timestamptz,
      auto_sync_enabled boolean NOT NULL DEFAULT true,
      old_code text,
      new_code text,
      old_code_authority_status text,
      new_code_authority_status text,
      old_code_source_task_id text,
      old_code_source_order_id text,
      old_code_source_field text,
      old_code_authority_updated_at timestamptz,
      new_code_authority_updated_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE cleaning_password_authority_receipts (
      request_id text NOT NULL,
      task_id text NOT NULL,
      field text NOT NULL CHECK (field IN ('old_code', 'new_code')),
      actor_user_id text,
      actor_role text,
      client text NOT NULL CHECK (client IN ('web', 'mobile', 'api')),
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (request_id, task_id, field)
    );
    CREATE SEQUENCE work_task_events_sequence_no_seq AS bigint;
    CREATE TABLE work_task_event_versions (
      task_id text PRIMARY KEY, last_version bigint NOT NULL DEFAULT 0,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE work_task_events (
      id text PRIMARY KEY,
      event_id text NOT NULL UNIQUE,
      sequence_no bigint NOT NULL UNIQUE,
      task_id text NOT NULL,
      task_version bigint NOT NULL,
      source_type text NOT NULL,
      source_ref_ids text[] NOT NULL DEFAULT '{}',
      event_type text NOT NULL,
      change_scope text NOT NULL,
      changed_fields text[] NOT NULL DEFAULT '{}',
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      occurred_at timestamptz NOT NULL,
      caused_by_user_id text,
      visibility_hints jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE work_task_action_audits (
      id text PRIMARY KEY,
      source_type text NOT NULL,
      source_id text NOT NULL,
      performed_by_user_id text,
      performed_by_name text,
      performed_as_action text NOT NULL,
      performed_at timestamptz NOT NULL DEFAULT now(),
      actor_user_id text,
      status_before text,
      status_after text,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `)
  await client.query(`
    INSERT INTO users(id, username, email, role) VALUES
      ('staff-a', 'Synthetic Staff A', 'staff-a@example.invalid', 'cleaner_inspector'),
      ('staff-b', 'Synthetic Staff B', 'staff-b@example.invalid', 'cleaner_inspector');
    INSERT INTO properties(id, code) VALUES('known-property', 'KNOWN-PROPERTY');
    INSERT INTO cleaning_tasks(
      id, property_id, task_date, date, task_type, type, status, execution_state, source,
      linked_checkout_task_id, assignee_id, cleaner_id, inspector_id, inspection_scope,
      checkout_time, checkin_time, guest_special_request, keys_required
    ) VALUES
      ('checkout-missing-property', 'missing-property', '2026-11-06', '2026-11-06', 'checkout_clean', 'checkout_clean', 'assigned', 'active', 'manual', NULL, 'staff-a', 'staff-a', 'staff-a', 'inspect_and_hang', '10am', NULL, 'checkout before', 1),
      ('checkin-missing-property', 'missing-property', '2026-11-06', '2026-11-06', 'checkin_clean', 'checkin_clean', 'assigned', 'active', 'manual', 'checkout-missing-property', 'staff-a', NULL, 'staff-a', 'inspect_and_hang', NULL, '3pm', 'checkin before', 1),
      ('independent-checkin', 'known-property', '2026-11-08', '2026-11-08', 'checkin_clean', 'checkin_clean', 'assigned', 'active', 'manual', NULL, 'staff-a', NULL, 'staff-a', 'password_only', NULL, '3pm', 'independent before', 1),
      ('stayover-task', 'known-property', '2026-11-09', '2026-11-09', 'stayover_clean', 'stayover_clean', 'assigned', 'active', 'manual', NULL, 'staff-a', 'staff-a', 'staff-a', NULL, NULL, '1pm', 'stayover before', 1);
  `)
}

async function main() {
  const expected = checkedTarget()
  const { checkinQuery, checkoutQuery } = topologyQueriesFromProductionSource()
  const admin = new Client({ connectionString })
  const locker = new Client({ connectionString })
  const contender = new Client({ connectionString })
  const schema = `mz109_${process.pid}_${Date.now()}`
  let server: any = null
  let routePool: any = null
  let pgModule: any = null
  let nativePool: any = null
  let adminConnected = false
  let lockerConnected = false
  let contenderConnected = false
  try {
    await admin.connect()
    adminConnected = true
    await locker.connect()
    lockerConnected = true
    await contender.connect()
    contenderConnected = true
    const identity = await admin.query(`
      SELECT current_database() AS database,
             host(inet_server_addr()) AS address,
             inet_server_port() AS port,
             current_setting('data_directory') AS data_directory,
             (inet_server_addr() <<= inet '127.0.0.0/8' OR inet_server_addr() = inet '::1') AS loopback
    `)
    assert.equal(identity.rows[0]?.database, expected.database)
    assert.equal(identity.rows[0]?.loopback, true, `server must be loopback, received ${String(identity.rows[0]?.address || '')}`)
    assert.notEqual(Number(identity.rows[0]?.port), 5432, 'default PostgreSQL port is forbidden')
    assert.equal(identity.rows[0]?.data_directory, expected.dataDirectory)

    await createFixtureSchema(admin, schema)
    await admin.query(`ALTER DATABASE ${expected.database} SET search_path TO ${schema}`)
    for (const client of [locker, contender]) await client.query(`SET search_path TO ${schema}`)
    const checkoutCurrent = {
      id: 'checkout-missing-property', property_id: 'missing-property', task_date: '2026-11-06', date: '2026-11-06',
      task_type: 'checkout_clean', type: 'checkout_clean', status: 'assigned', execution_state: 'active',
    }
    const checkinCurrent = {
      id: 'checkin-missing-property', property_id: 'missing-property', task_date: '2026-11-06', date: '2026-11-06',
      task_type: 'checkin_clean', type: 'checkin_clean', status: 'assigned', execution_state: 'active',
      linked_checkout_task_id: 'checkout-missing-property',
    }

    await expectLegacyOuterJoinLockFailure(admin, checkinQuery, checkoutCurrent.id)
    await expectLegacyOuterJoinLockFailure(admin, checkoutQuery, checkoutCurrent.id)

    const routeUrl = new URL(connectionString)
    routeUrl.searchParams.set('options', `-c search_path=${schema},pg_catalog`)
    process.env.DATABASE_URL = routeUrl.toString()
    process.env.DATABASE_DIRECT_URL = routeUrl.toString()
    process.env.NODE_ENV = 'test'
    process.env.PG_POOL_MAX = '8'
    pgModule = require('pg')
    nativePool = pgModule.Pool
    class Mz109LocalOnlyPool extends nativePool {
      constructor(config: any) {
        const configuredUrl = new URL(String(config?.connectionString || ''))
        assert.equal(configuredUrl.hostname, '127.0.0.1')
        assert.equal(Number(configuredUrl.port), Number(new URL(connectionString).port))
        assert.equal(decodeURIComponent(configuredUrl.pathname.replace(/^\//, '')), expected.database)
        assert.deepEqual(Array.from(configuredUrl.searchParams.keys()), ['options'])
        assert.equal(configuredUrl.searchParams.get('options'), `-c search_path=${schema},pg_catalog`)
        super({ ...config, ssl: false })
      }
    }
    pgModule.Pool = Mz109LocalOnlyPool
    const notifications = require('../../src/services/notificationEvents') as typeof import('../../src/services/notificationEvents')
    ;(notifications as any).emitNotificationEvent = async () => null
    const { warmupR5TaskRuntimeSchema } = require('../../src/lib/r5RequestSchema') as typeof import('../../src/lib/r5RequestSchema')
    const { warmupPasswordAuthoritySchema } = require('../../src/lib/passwordAuthoritySchema') as typeof import('../../src/lib/passwordAuthoritySchema')
    const { pgPool } = require('../../src/dbAdapter') as typeof import('../../src/dbAdapter')
    const { router, assertPgExplicitTurnoverLinkTopology } = require('../../src/modules/cleaning') as typeof import('../../src/modules/cleaning')
    assert.ok(pgPool, 'production route must use the isolated PostgreSQL pool')
    routePool = pgPool
    const routeIdentity = await pgPool.query(
      `SELECT current_database() AS database, current_schema() AS schema,
              current_setting('search_path') AS search_path,
              to_regclass('schema_migrations')::text AS migrations_table`,
    )
    assert.equal(routeIdentity.rows[0]?.database, expected.database)
    assert.equal(routeIdentity.rows[0]?.schema, schema, JSON.stringify(routeIdentity.rows[0]))
    assert.equal(routeIdentity.rows[0]?.migrations_table, 'schema_migrations', JSON.stringify(routeIdentity.rows[0]))
    await warmupR5TaskRuntimeSchema()
    await warmupPasswordAuthoritySchema()

    await admin.query('BEGIN')
    await assertPgExplicitTurnoverLinkTopology(admin, checkinCurrent.id, checkinCurrent, { task_date: '2026-11-06', status: 'assigned' })
    await admin.query('COMMIT')
    await admin.query('BEGIN')
    await assertPgExplicitTurnoverLinkTopology(admin, checkoutCurrent.id, checkoutCurrent, { task_date: '2026-11-06', status: 'assigned' })
    await admin.query('COMMIT')
    await expectTaskRowLock(
      locker, contender,
      () => assertPgExplicitTurnoverLinkTopology(locker, checkinCurrent.id, checkinCurrent, { task_date: '2026-11-06' }),
      checkoutCurrent.id,
    )
    await expectTaskRowLock(
      locker, contender,
      () => assertPgExplicitTurnoverLinkTopology(locker, checkoutCurrent.id, checkoutCurrent, { task_date: '2026-11-06' }),
      checkinCurrent.id,
    )

    const express = require('express') as typeof import('express')
    const app = express()
    app.use(express.json())
    app.use((req: any, _res: any, next: any) => {
      if (req.headers['x-mz109-test-auth'] === 'admin') req.user = { sub: 'mz109-test-admin', role: 'admin', roles: ['admin'] }
      next()
    })
    app.use('/cleaning', router)
    server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
    })
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const baseUrl = `http://127.0.0.1:${address.port}`
    const patchTask = async (id: string, body: Record<string, any>, authenticated = true) => {
      const response = await fetch(`${baseUrl}/cleaning/tasks/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...(authenticated ? { 'x-mz109-test-auth': 'admin' } : {}) },
        body: JSON.stringify(body),
      })
      const text = await response.text()
      return { status: response.status, body: text ? JSON.parse(text) : null }
    }

    const unauthenticated = await patchTask(checkinCurrent.id, { guest_special_request: 'unauthorized write' }, false)
    assert.equal(unauthenticated.status, 401, 'the real route permission middleware must remain active')

    const checkinSaved = await patchTask(checkinCurrent.id, {
      task_date: '2026-11-06', status: 'assigned', assignee_id: 'staff-a', inspector_id: 'staff-a',
      inspection_scope: 'inspect_and_hang', keys_required: 2, checkin_time: '3pm',
      guest_special_request: 'HTTP PG linked check-in guest request', new_code: 'SYNTH-MZ109-NEW',
      password_verification: { fields: ['new_code'], request_id: 'mz109-http-checkin-password', client: 'web' },
    })
    assert.equal(checkinSaved.status, 200, JSON.stringify(checkinSaved.body))
    assert.equal(checkinSaved.body.guest_special_request, 'HTTP PG linked check-in guest request')
    assert.equal(checkinSaved.body.new_code, 'SYNTH-MZ109-NEW')
    assert.equal(checkinSaved.body.new_code_authority_status, 'manual_confirmed')
    assert.equal(checkinSaved.body.linked_checkout_task_id, checkoutCurrent.id)

    const checkoutSaved = await patchTask(checkoutCurrent.id, {
      task_date: '2026-11-06', status: 'assigned', cleaner_id: 'staff-a', inspector_id: 'staff-a',
      inspection_scope: 'inspect_and_hang', keys_required: 2, checkout_time: '11am',
      guest_special_request: 'HTTP PG linked checkout guest request', old_code: 'SYNTH-MZ109-OLD',
      password_verification: { fields: ['old_code'], request_id: 'mz109-http-checkout-password', client: 'web' },
    })
    assert.equal(checkoutSaved.status, 200, JSON.stringify(checkoutSaved.body))
    assert.equal(checkoutSaved.body.checkout_time, '11am')
    assert.equal(checkoutSaved.body.guest_special_request, 'HTTP PG linked checkout guest request')
    assert.equal(checkoutSaved.body.old_code, 'SYNTH-MZ109-OLD')
    assert.equal(checkoutSaved.body.old_code_authority_status, 'manual_confirmed')

    const independentSaved = await patchTask('independent-checkin', {
      task_date: '2026-11-08', status: 'assigned', assignee_id: 'staff-a', inspector_id: 'staff-a',
      inspection_scope: 'password_only', checkin_time: '3pm',
      guest_special_request: 'HTTP PG independent check-in request',
    })
    assert.equal(independentSaved.status, 200, JSON.stringify(independentSaved.body))
    assert.equal(independentSaved.body.guest_special_request, 'HTTP PG independent check-in request')
    assert.equal(independentSaved.body.linked_checkout_task_id, null)

    const stayoverSaved = await patchTask('stayover-task', {
      task_date: '2026-11-09', status: 'assigned', cleaner_id: 'staff-a', inspector_id: 'staff-a',
      checkin_time: '1pm', guest_special_request: 'HTTP PG stayover request',
    })
    assert.equal(stayoverSaved.status, 200, JSON.stringify(stayoverSaved.body))
    assert.equal(stayoverSaved.body.guest_special_request, 'HTTP PG stayover request')

    const beforeStayoverReject = await admin.query('SELECT guest_special_request, new_code FROM cleaning_tasks WHERE id=$1', ['stayover-task'])
    const stayoverPasswordRejected = await patchTask('stayover-task', {
      guest_special_request: 'must roll back with invalid password field', new_code: 'SYNTH-MZ109-STAYOVER-INVALID',
    })
    assert.equal(stayoverPasswordRejected.status, 400)
    assert.equal(stayoverPasswordRejected.body.message, 'password_field_not_applicable')
    const afterStayoverReject = await admin.query('SELECT guest_special_request, new_code FROM cleaning_tasks WHERE id=$1', ['stayover-task'])
    assert.deepEqual(afterStayoverReject.rows, beforeStayoverReject.rows, 'invalid mixed-field PATCH must not partially persist')

    const beforeConflict = await admin.query(
      'SELECT task_date::text, guest_special_request, keys_required FROM cleaning_tasks WHERE id=$1',
      [checkinCurrent.id],
    )
    const beforeConflictReceipts = await admin.query('SELECT COUNT(*)::int AS count FROM cleaning_password_authority_receipts')
    const beforeConflictEvents = await admin.query('SELECT COUNT(*)::int AS count FROM work_task_events')
    const linkedConflict = await patchTask(checkinCurrent.id, {
      task_date: '2026-11-07', status: 'assigned', keys_required: 1,
      guest_special_request: 'must roll back with topology conflict', new_code: 'SYNTH-MZ109-CONFLICT',
      password_verification: { fields: ['new_code'], request_id: 'mz109-http-conflict-password', client: 'web' },
    })
    assert.equal(linkedConflict.status, 409)
    assert.equal(linkedConflict.body.code, 'turnover_link_topology_conflict')
    const afterConflict = await admin.query(
      'SELECT task_date::text, guest_special_request, keys_required FROM cleaning_tasks WHERE id=$1',
      [checkinCurrent.id],
    )
    assert.deepEqual(afterConflict.rows, beforeConflict.rows, 'topology rejection must roll back every requested field')
    assert.equal((await admin.query('SELECT COUNT(*)::int AS count FROM cleaning_password_authority_receipts')).rows[0].count, beforeConflictReceipts.rows[0].count)
    assert.equal((await admin.query('SELECT COUNT(*)::int AS count FROM work_task_events')).rows[0].count, beforeConflictEvents.rows[0].count)

    const readBack = await admin.query(`
      SELECT id, task_date::text, status, assignee_id, cleaner_id, inspector_id,
             checkout_time, checkin_time, guest_special_request, keys_required,
             old_code, new_code, old_code_authority_status, new_code_authority_status,
             linked_checkout_task_id
        FROM cleaning_tasks ORDER BY id
    `)
    const byId = new Map(readBack.rows.map((row: any) => [row.id, row]))
    assert.deepEqual(
      {
        task_date: byId.get(checkinCurrent.id)?.task_date,
        status: byId.get(checkinCurrent.id)?.status,
        assignee_id: byId.get(checkinCurrent.id)?.assignee_id,
        inspector_id: byId.get(checkinCurrent.id)?.inspector_id,
        checkin_time: byId.get(checkinCurrent.id)?.checkin_time,
        guest_special_request: byId.get(checkinCurrent.id)?.guest_special_request,
        keys_required: byId.get(checkinCurrent.id)?.keys_required,
        new_code: byId.get(checkinCurrent.id)?.new_code,
        linked_checkout_task_id: byId.get(checkinCurrent.id)?.linked_checkout_task_id,
      },
      {
        task_date: '2026-11-06', status: 'assigned', assignee_id: 'staff-a', inspector_id: 'staff-a',
        checkin_time: '3pm', guest_special_request: 'HTTP PG linked check-in guest request', keys_required: 2,
        new_code: 'SYNTH-MZ109-NEW', linked_checkout_task_id: checkoutCurrent.id,
      },
    )
    assert.equal(byId.get(checkoutCurrent.id)?.guest_special_request, 'HTTP PG linked checkout guest request')
    assert.equal(byId.get(checkoutCurrent.id)?.keys_required, 2)
    assert.equal(byId.get(checkoutCurrent.id)?.checkout_time, '11am')
    assert.equal(byId.get(checkoutCurrent.id)?.old_code, 'SYNTH-MZ109-OLD')
    const eventPayloads = (await admin.query('SELECT payload::text AS payload FROM work_task_events')).rows.map((row: any) => String(row.payload))
    assert.equal(
      eventPayloads.some((payload: string) => payload.includes('SYNTH-MZ109-NEW') || payload.includes('SYNTH-MZ109-OLD')),
      false,
      'credential values must remain redacted from event payloads',
    )
  } finally {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
    if (routePool) await routePool.end().catch(() => null)
    if (pgModule && nativePool) pgModule.Pool = nativePool
    await Promise.allSettled([
      ...(lockerConnected ? [locker.end()] : []),
      ...(contenderConnected ? [contender.end()] : []),
    ])
    try {
      if (adminConnected) {
        await admin.query(`ALTER DATABASE ${expected.database} RESET search_path`)
        await admin.query('RESET search_path')
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
      }
    } finally {
      if (adminConnected) await admin.end().catch(() => null)
    }
  }
  process.stdout.write('test_cleaning_turnover_topology_lock_pg_integration: ok\n')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
