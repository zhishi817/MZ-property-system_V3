import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { Client } from 'pg'
import { buildCanonicalIdempotencyPayloadHash } from '../../src/lib/idempotentStepReceipts'

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

async function waitForBlockedQuery(client: Client, queryPattern: string) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const result = await client.query(
      `SELECT 1
       FROM pg_stat_activity
       WHERE datname = current_database()
         AND pid <> pg_backend_pid()
         AND wait_event_type = 'Lock'
         AND query LIKE $1
       LIMIT 1`,
      [queryPattern],
    )
    if ((result?.rows || []).length) return
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`blocked query not observed: ${queryPattern}`)
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
    CREATE TABLE app_submit_receipts (
      id text PRIMARY KEY,
      scope_type text NOT NULL,
      scope_id text NOT NULL,
      submit_id text NOT NULL,
      step_key text NOT NULL,
      payload_hash text NOT NULL,
      response_json jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(scope_type, scope_id, submit_id, step_key)
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
    INSERT INTO properties(id, code) VALUES
      ('known-property', 'KNOWN-PROPERTY'),
      ('checkout-only-property', 'CHECKOUT-ONLY-PROPERTY');
    INSERT INTO orders(id, property_id, status, checkin, checkout, keys_required) VALUES
      ('order-checkout', 'known-property', 'confirmed', '2026-11-01', '2026-11-13', 1),
      ('order-checkin', 'known-property', 'confirmed', '2026-11-13', '2026-11-15', 1),
      ('checkout-only-order', 'checkout-only-property', 'confirmed', '2026-11-20', '2026-11-22', 1);
    INSERT INTO cleaning_tasks(
      id, property_id, task_date, date, task_type, type, status, execution_state, source,
      linked_checkout_task_id, assignee_id, cleaner_id, inspector_id, inspection_scope,
      checkout_time, checkin_time, guest_special_request, keys_required
    ) VALUES
      ('checkout-missing-property', 'missing-property', '2026-11-06', '2026-11-06', 'checkout_clean', 'checkout_clean', 'assigned', 'active', 'manual', NULL, 'staff-a', 'staff-a', 'staff-a', 'inspect_and_hang', '10am', NULL, 'checkout before', 1),
      ('checkin-missing-property', 'missing-property', '2026-11-06', '2026-11-06', 'checkin_clean', 'checkin_clean', 'assigned', 'active', 'manual', 'checkout-missing-property', 'staff-a', NULL, 'staff-a', 'inspect_and_hang', NULL, '3pm', 'checkin before', 1),
      ('independent-checkin', 'known-property', '2026-11-08', '2026-11-08', 'checkin_clean', 'checkin_clean', 'assigned', 'active', 'manual', NULL, 'staff-a', NULL, 'staff-a', 'password_only', NULL, '3pm', 'independent before', 1),
      ('inactive-checkin', 'known-property', '2026-11-10', '2026-11-10', 'checkin_clean', 'checkin_clean', 'cancelled', 'cancelled', 'manual', NULL, 'staff-a', NULL, 'staff-a', 'password_only', NULL, '3pm', 'inactive before', 1),
      ('terminal-ready', 'known-property', '2026-11-10', '2026-11-10', 'checkin_clean', 'checkin_clean', 'ready', 'active', 'manual', NULL, 'staff-a', NULL, 'staff-a', 'password_only', NULL, '3pm', 'ready before', 1),
      ('terminal-completed', 'known-property', '2026-11-10', '2026-11-10', 'checkin_clean', 'checkin_clean', 'completed', 'active', 'manual', NULL, 'staff-a', NULL, 'staff-a', 'password_only', NULL, '3pm', 'completed before', 1),
      ('terminal-done', 'known-property', '2026-11-10', '2026-11-10', 'checkin_clean', 'checkin_clean', 'done', 'active', 'manual', NULL, 'staff-a', NULL, 'staff-a', 'password_only', NULL, '3pm', 'done before', 1),
      ('stayover-task', 'known-property', '2026-11-09', '2026-11-09', 'stayover_clean', 'stayover_clean', 'assigned', 'active', 'manual', NULL, 'staff-a', 'staff-a', 'staff-a', NULL, NULL, '1pm', 'stayover before', 1),
      ('checkout-only-task', 'checkout-only-property', '2026-11-22', '2026-11-22', 'checkout_clean', 'checkout_clean', 'assigned', 'active', 'order', NULL, 'staff-a', 'staff-a', 'staff-a', 'inspect_and_hang', '10am', NULL, 'checkout-only before', 1),
      ('order-checkout-task', 'known-property', '2026-11-13', '2026-11-13', 'checkout_clean', 'checkout_clean', 'assigned', 'active', 'order', NULL, 'staff-a', 'staff-a', 'staff-a', 'inspect_and_hang', '10am', NULL, 'order checkout before', 1),
      ('order-checkin-task', 'known-property', '2026-11-13', '2026-11-13', 'checkin_clean', 'checkin_clean', 'assigned', 'active', 'order', NULL, 'staff-a', NULL, 'staff-a', 'inspect_and_hang', NULL, '3pm', 'order checkin before', 1);
    UPDATE cleaning_tasks SET order_id='order-checkout' WHERE id='order-checkout-task';
    UPDATE cleaning_tasks SET order_id='order-checkin' WHERE id='order-checkin-task';
    UPDATE cleaning_tasks SET order_id='checkout-only-order' WHERE id='checkout-only-task';
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
    const deferredService = require('../../src/services/deferredInspectionCheckinConflict') as typeof import('../../src/services/deferredInspectionCheckinConflict')
    const originalDeferredReconcile = deferredService.reconcileDeferredInspectionCheckinReplacement
    let failDeferredForTaskId = ''
    ;(deferredService as any).reconcileDeferredInspectionCheckinReplacement = async (params: any) => {
      if (failDeferredForTaskId && (params?.taskIds || []).map(String).includes(failDeferredForTaskId)) {
        throw new Error('synthetic_deferred_reconcile_failure')
      }
      return originalDeferredReconcile(params)
    }
    const { warmupR5TaskRuntimeSchema } = require('../../src/lib/r5RequestSchema') as typeof import('../../src/lib/r5RequestSchema')
    const { warmupPasswordAuthoritySchema } = require('../../src/lib/passwordAuthoritySchema') as typeof import('../../src/lib/passwordAuthoritySchema')
    const { pgPool } = require('../../src/dbAdapter') as typeof import('../../src/dbAdapter')
    const { router, assertPgExplicitTurnoverLinkTopology } = require('../../src/modules/cleaning') as typeof import('../../src/modules/cleaning')
    const { router: mzappRouter } = require('../../src/modules/mzapp') as typeof import('../../src/modules/mzapp')
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
      const role = String(req.headers['x-mz109-test-auth'] || '').trim()
      if (role) req.user = { sub: `mz109-test-${role}`, role, roles: [role] }
      next()
    })
    app.use('/cleaning', router)
    app.use('/mzapp', mzappRouter)
    server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
    })
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const baseUrl = `http://127.0.0.1:${address.port}`
    const patchTask = async (id: string, body: Record<string, any>, role: string | false = 'admin') => {
      const response = await fetch(`${baseUrl}/cleaning/tasks/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...(role ? { 'x-mz109-test-auth': role } : {}) },
        body: JSON.stringify(body),
      })
      const text = await response.text()
      return { status: response.status, body: text ? JSON.parse(text) : null }
    }
    const atomicPatch = async (body: Record<string, any>, role: string | false = 'admin') => {
      const response = await fetch(`${baseUrl}/cleaning/tasks/atomic-patch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(role ? { 'x-mz109-test-auth': role } : {}) },
        body: JSON.stringify(body),
      })
      const text = await response.text()
      return { status: response.status, body: text ? JSON.parse(text) : null }
    }
    const managerFields = async (body: Record<string, any>, role: string | false = 'admin') => {
      const response = await fetch(`${baseUrl}/mzapp/cleaning-tasks/manager-fields`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...(role ? { 'x-mz109-test-auth': role } : {}) },
        body: JSON.stringify(body),
      })
      const text = await response.text()
      return { status: response.status, body: text ? JSON.parse(text) : null }
    }

    const unauthenticated = await patchTask(checkinCurrent.id, { guest_special_request: 'unauthorized write' }, false)
    assert.equal(unauthenticated.status, 401, 'the real route permission middleware must remain active')
    const unauthenticatedAtomic = await atomicPatch({
      operation_id: 'synthetic-unauthorized-operation',
      items: [{ id: 'independent-checkin', patch: { guest_special_request: 'unauthorized atomic write' } }],
    }, false)
    assert.equal(unauthenticatedAtomic.status, 401, 'the atomic route permission middleware must remain active')
    const unauthenticatedManager = await managerFields({
      operation_id: 'synthetic-mobile-unauthorized',
      task_ids: ['independent-checkin'],
      guest_special_request: 'unauthorized manager write',
    }, false)
    assert.equal(unauthenticatedManager.status, 401, 'manager-fields permission middleware must remain active')
    for (const role of ['admin', 'customer_service', 'offline_manager', 'cleaner']) {
      const existingRoute = await patchTask('missing-role-probe', { guest_special_request: 'authorization probe' }, role)
      const allowed = await atomicPatch({
        operation_id: `synthetic-atomic-role-${role}`,
        items: [{ id: 'missing-role-probe', patch: { guest_special_request: 'authorization probe' } }],
      }, role)
      assert.equal(allowed.status, existingRoute.status, `${role} atomic permission must match the existing single-task PATCH`)
    }

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

    const atomicPayload = {
      operation_id: 'synthetic-atomic-save-1',
      items: [
        {
          id: 'order-checkout-task',
          patch: {
            task_date: '2026-11-13', status: 'assigned', cleaner_id: 'staff-b', inspector_id: 'staff-b',
            checkout_time: '11:30am', guest_special_request: 'atomic checkout request', old_code: 'SYNTH-ATOMIC-OLD',
            password_verification: { fields: ['old_code'], request_id: 'synthetic-atomic-save-1', client: 'web' },
          },
        },
        {
          id: 'order-checkin-task',
          patch: {
            task_date: '2026-11-13', status: 'assigned', assignee_id: 'staff-a', inspector_id: 'staff-a',
            checkin_time: '4:30pm', nights_override: 2, guest_special_request: 'atomic checkin request', new_code: 'SYNTH-ATOMIC-NEW',
            password_verification: { fields: ['new_code'], request_id: 'synthetic-atomic-save-1', client: 'web' },
          },
        },
      ],
      order_key_updates: [
        { order_id: 'order-checkout', keys_required: 1 },
        { order_id: 'order-checkin', keys_required: 2 },
      ],
    }
    const atomicSaved = await atomicPatch(atomicPayload)
    assert.equal(atomicSaved.status, 200, JSON.stringify(atomicSaved.body))
    assert.equal(atomicSaved.body.replayed, false)
    assert.deepEqual(atomicSaved.body.updated_task_ids, ['order-checkin-task', 'order-checkout-task'])
    const atomicReadBack = await admin.query(
      `SELECT t.id, t.assignee_id, t.cleaner_id, t.inspector_id, t.checkout_time, t.checkin_time,
              t.guest_special_request, t.keys_required, t.nights_override, t.old_code, t.new_code,
              t.old_code_authority_status, t.new_code_authority_status, o.keys_required AS order_keys_required
         FROM cleaning_tasks t
         LEFT JOIN orders o ON o.id=t.order_id
        WHERE t.id = ANY($1::text[])
        ORDER BY t.id`,
      [['order-checkout-task', 'order-checkin-task']],
    )
    assert.deepEqual(atomicReadBack.rows, [
      {
        id: 'order-checkin-task', assignee_id: 'staff-a', cleaner_id: null, inspector_id: 'staff-a',
        checkout_time: null, checkin_time: '4:30pm', guest_special_request: 'atomic checkin request',
        keys_required: 2, nights_override: 2, old_code: null, new_code: 'SYNTH-ATOMIC-NEW',
        old_code_authority_status: null, new_code_authority_status: 'manual_confirmed', order_keys_required: 2,
      },
      {
        id: 'order-checkout-task', assignee_id: 'staff-b', cleaner_id: 'staff-b', inspector_id: 'staff-b',
        checkout_time: '11:30am', checkin_time: null, guest_special_request: 'atomic checkout request',
        keys_required: 1, nights_override: null, old_code: 'SYNTH-ATOMIC-OLD', new_code: null,
        old_code_authority_status: 'manual_confirmed', new_code_authority_status: null, order_keys_required: 1,
      },
    ], 'task-specific fields and order key counts must not leak across the combined card')

    const atomicCounts = async () => ({
      submitReceipts: Number((await admin.query("SELECT COUNT(*)::int AS count FROM app_submit_receipts WHERE scope_type='cleaning_tasks_atomic_patch'")).rows[0].count),
      passwordReceipts: Number((await admin.query("SELECT COUNT(*)::int AS count FROM cleaning_password_authority_receipts WHERE request_id='synthetic-atomic-save-1'")).rows[0].count),
      events: Number((await admin.query("SELECT COUNT(*)::int AS count FROM work_task_events WHERE source_ref_ids && ARRAY['order-checkout-task','order-checkin-task']::text[]")).rows[0].count),
    })
    const countsAfterAtomicSave = await atomicCounts()
    assert.deepEqual(
      countsAfterAtomicSave,
      { submitReceipts: 1, passwordReceipts: 2, events: 5 },
      'the first save must persist both task edits, authority transitions and the changed order-key projection exactly once',
    )
    const storedAtomicReceipt = (await admin.query(
      `SELECT scope_type, scope_id, submit_id, step_key, payload_hash, response_json
         FROM app_submit_receipts
        WHERE scope_type='cleaning_tasks_atomic_patch' AND submit_id=$1`,
      [atomicPayload.operation_id],
    )).rows[0]
    const normalizedAtomicPayload = {
      items: [...atomicPayload.items].sort((a, b) => a.id.localeCompare(b.id)),
      order_key_updates: [...atomicPayload.order_key_updates].sort((a, b) => a.order_id.localeCompare(b.order_id)),
    }
    assert.ok(!JSON.stringify(storedAtomicReceipt).includes('SYNTH-ATOMIC-OLD'))
    assert.ok(!JSON.stringify(storedAtomicReceipt).includes('SYNTH-ATOMIC-NEW'))
    assert.notEqual(
      storedAtomicReceipt.payload_hash,
      buildCanonicalIdempotencyPayloadHash(normalizedAtomicPayload),
      'credential-bearing operation receipts must use a server-keyed fingerprint, not an enumerable plain digest',
    )
    const atomicReplay = await atomicPatch(atomicPayload)
    assert.equal(atomicReplay.status, 200, JSON.stringify(atomicReplay.body))
    assert.equal(atomicReplay.body.replayed, true)
    assert.deepEqual(await atomicCounts(), countsAfterAtomicSave, 'lost-response replay must not add receipts or work-task events')
    const atomicCanonicalReplay = await atomicPatch({
      operation_id: atomicPayload.operation_id,
      items: [...atomicPayload.items].reverse().map((item) => ({
        patch: Object.fromEntries(Object.entries(item.patch).reverse().map(([key, value]) => [
          key,
          key === 'password_verification'
            ? Object.fromEntries(Object.entries(value as Record<string, any>).reverse())
            : value,
        ])),
        id: item.id,
      })),
      order_key_updates: [...atomicPayload.order_key_updates].reverse(),
    })
    assert.equal(atomicCanonicalReplay.status, 200, JSON.stringify(atomicCanonicalReplay.body))
    assert.equal(atomicCanonicalReplay.body.replayed, true)
    assert.deepEqual(await atomicCounts(), countsAfterAtomicSave, 'recursive key and array reordering must preserve replay identity')

    const atomicReplayConflict = await atomicPatch({
      ...atomicPayload,
      items: atomicPayload.items.map((item) => item.id === 'order-checkout-task'
        ? { ...item, patch: { ...item.patch, guest_special_request: 'same operation changed payload' } }
        : item),
    })
    assert.equal(atomicReplayConflict.status, 409)
    assert.equal(atomicReplayConflict.body.message, 'idempotency_conflict')
    assert.deepEqual(await atomicCounts(), countsAfterAtomicSave)

    const intentionalEdit = await atomicPatch({
      operation_id: 'synthetic-atomic-save-2',
      items: [{
        id: 'order-checkout-task',
        patch: { guest_special_request: 'intentional later edit', checkout_time: '11:45am' },
      }],
      order_key_updates: [],
    })
    assert.equal(intentionalEdit.status, 200, JSON.stringify(intentionalEdit.body))
    assert.equal(intentionalEdit.body.replayed, false)
    const intentionalReadBack = await admin.query('SELECT guest_special_request, checkout_time FROM cleaning_tasks WHERE id=$1', ['order-checkout-task'])
    assert.deepEqual(intentionalReadBack.rows[0], { guest_special_request: 'intentional later edit', checkout_time: '11:45am' })

    const concurrentEventCountBefore = Number((await admin.query(
      "SELECT COUNT(*)::int AS count FROM work_task_events WHERE source_ref_ids && ARRAY['stayover-task']::text[]",
    )).rows[0].count)
    const concurrentPayload = {
      operation_id: 'synthetic-atomic-concurrent-1',
      items: [{ id: 'stayover-task', patch: { guest_special_request: 'concurrent identical edit' } }],
      order_key_updates: [],
    }
    const concurrentResults = await Promise.all([atomicPatch(concurrentPayload), atomicPatch(concurrentPayload)])
    assert.deepEqual(concurrentResults.map((result) => result.status), [200, 200])
    assert.deepEqual(concurrentResults.map((result) => result.body.replayed).sort(), [false, true])
    assert.equal(
      Number((await admin.query("SELECT COUNT(*)::int AS count FROM app_submit_receipts WHERE submit_id='synthetic-atomic-concurrent-1'")).rows[0].count),
      1,
    )
    assert.equal(Number((await admin.query(
      "SELECT COUNT(*)::int AS count FROM work_task_events WHERE source_ref_ids && ARRAY['stayover-task']::text[]",
    )).rows[0].count), concurrentEventCountBefore + 1)

    const faultBefore = await admin.query(
      `SELECT id, task_date::text, guest_special_request FROM cleaning_tasks
        WHERE id = ANY($1::text[]) ORDER BY id`,
      [[checkoutCurrent.id, checkinCurrent.id]],
    )
    const faultBeforeReceipts = Number((await admin.query('SELECT COUNT(*)::int AS count FROM cleaning_password_authority_receipts')).rows[0].count)
    const faultBeforeEvents = Number((await admin.query('SELECT COUNT(*)::int AS count FROM work_task_events')).rows[0].count)
    const faultBeforeSubmitReceipts = Number((await admin.query('SELECT COUNT(*)::int AS count FROM app_submit_receipts')).rows[0].count)
    const atomicFault = await atomicPatch({
      operation_id: 'synthetic-atomic-fault-1',
      items: [
        { id: checkoutCurrent.id, patch: { guest_special_request: 'must roll back first item', checkout_time: '12pm' } },
        { id: checkinCurrent.id, patch: { task_date: '2026-11-07', guest_special_request: 'must reject second item' } },
      ],
      order_key_updates: [],
    })
    assert.equal(atomicFault.status, 409, JSON.stringify(atomicFault.body))
    assert.equal(atomicFault.body.code, 'turnover_link_topology_conflict')
    const faultAfter = await admin.query(
      `SELECT id, task_date::text, guest_special_request FROM cleaning_tasks
        WHERE id = ANY($1::text[]) ORDER BY id`,
      [[checkoutCurrent.id, checkinCurrent.id]],
    )
    assert.deepEqual(faultAfter.rows, faultBefore.rows, 'one task conflict must roll back the complete combined-card save')
    assert.equal(Number((await admin.query('SELECT COUNT(*)::int AS count FROM cleaning_password_authority_receipts')).rows[0].count), faultBeforeReceipts)
    assert.equal(Number((await admin.query('SELECT COUNT(*)::int AS count FROM work_task_events')).rows[0].count), faultBeforeEvents)
    assert.equal(Number((await admin.query('SELECT COUNT(*)::int AS count FROM app_submit_receipts')).rows[0].count), faultBeforeSubmitReceipts)

    const deferredFaultBefore = await admin.query(
      'SELECT checkin_time, guest_special_request FROM cleaning_tasks WHERE id=$1',
      ['independent-checkin'],
    )
    const deferredFaultEventsBefore = Number((await admin.query('SELECT COUNT(*)::int AS count FROM work_task_events')).rows[0].count)
    failDeferredForTaskId = 'independent-checkin'
    const deferredFault = await atomicPatch({
      operation_id: 'synthetic-atomic-deferred-fault-1',
      items: [{ id: 'independent-checkin', patch: { checkin_time: '6pm', guest_special_request: 'must roll back reconcile fault' } }],
      order_key_updates: [],
    })
    failDeferredForTaskId = ''
    assert.equal(deferredFault.status, 500, JSON.stringify(deferredFault.body))
    assert.equal(deferredFault.body.message, 'synthetic_deferred_reconcile_failure')
    assert.deepEqual(
      (await admin.query('SELECT checkin_time, guest_special_request FROM cleaning_tasks WHERE id=$1', ['independent-checkin'])).rows,
      deferredFaultBefore.rows,
      'deferred reconciliation failure must roll back the direct edit',
    )
    assert.equal(Number((await admin.query('SELECT COUNT(*)::int AS count FROM work_task_events')).rows[0].count), deferredFaultEventsBefore)
    assert.equal(
      Number((await admin.query("SELECT COUNT(*)::int AS count FROM app_submit_receipts WHERE submit_id='synthetic-atomic-deferred-fault-1'")).rows[0].count),
      0,
    )

    const inactiveBefore = await admin.query('SELECT guest_special_request FROM cleaning_tasks WHERE id=$1', ['inactive-checkin'])
    const inactiveRejected = await atomicPatch({
      operation_id: 'synthetic-atomic-inactive-1',
      items: [{ id: 'inactive-checkin', patch: { guest_special_request: 'must not update inactive task' } }],
      order_key_updates: [],
    })
    assert.equal(inactiveRejected.status, 409, JSON.stringify(inactiveRejected.body))
    assert.equal(inactiveRejected.body.message, 'atomic_patch_task_inactive')
    assert.deepEqual(
      (await admin.query('SELECT guest_special_request FROM cleaning_tasks WHERE id=$1', ['inactive-checkin'])).rows,
      inactiveBefore.rows,
    )
    assert.equal(
      Number((await admin.query("SELECT COUNT(*)::int AS count FROM app_submit_receipts WHERE submit_id='synthetic-atomic-inactive-1'")).rows[0].count),
      0,
    )

    for (const status of ['ready', 'completed', 'done']) {
      const taskId = `terminal-${status}`
      const before = await admin.query('SELECT guest_special_request FROM cleaning_tasks WHERE id=$1', [taskId])
      const eventsBefore = Number((await admin.query('SELECT COUNT(*)::int AS count FROM work_task_events WHERE source_ref_ids && ARRAY[$1]::text[]', [taskId])).rows[0].count)
      const atomicOperationId = `synthetic-atomic-terminal-${status}`
      const atomicTerminal = await atomicPatch({
        operation_id: atomicOperationId,
        items: [{ id: taskId, patch: { guest_special_request: `must not update ${status}` } }],
        order_key_updates: [],
      })
      assert.equal(atomicTerminal.status, 409, JSON.stringify(atomicTerminal.body))
      assert.equal(atomicTerminal.body.message, 'atomic_patch_task_inactive')
      assert.deepEqual((await admin.query('SELECT guest_special_request FROM cleaning_tasks WHERE id=$1', [taskId])).rows, before.rows)
      assert.equal(Number((await admin.query('SELECT COUNT(*)::int AS count FROM app_submit_receipts WHERE submit_id=$1', [atomicOperationId])).rows[0].count), 0)
      assert.equal(Number((await admin.query('SELECT COUNT(*)::int AS count FROM work_task_events WHERE source_ref_ids && ARRAY[$1]::text[]', [taskId])).rows[0].count), eventsBefore)

      const managerOperationId = `synthetic-manager-terminal-${status}`
      const managerTerminal = await managerFields({
        operation_id: managerOperationId,
        task_ids: [taskId],
        items: [{ id: taskId, guest_special_request: `manager must not update ${status}` }],
      })
      assert.equal(managerTerminal.status, 409, JSON.stringify(managerTerminal.body))
      assert.equal(managerTerminal.body.message, 'manager_fields_task_inactive')
      assert.deepEqual((await admin.query('SELECT guest_special_request FROM cleaning_tasks WHERE id=$1', [taskId])).rows, before.rows)
      assert.equal(Number((await admin.query('SELECT COUNT(*)::int AS count FROM app_submit_receipts WHERE submit_id=$1', [managerOperationId])).rows[0].count), 0)
      assert.equal(Number((await admin.query('SELECT COUNT(*)::int AS count FROM work_task_events WHERE source_ref_ids && ARRAY[$1]::text[]', [taskId])).rows[0].count), eventsBefore)
    }

    const unrelatedOrderBefore = await admin.query('SELECT keys_required FROM orders WHERE id=$1', ['order-checkout'])
    const unrelatedOrderRejected = await atomicPatch({
      operation_id: 'synthetic-atomic-unrelated-order-1',
      items: [{ id: 'independent-checkin', patch: { guest_special_request: 'must roll back unrelated order target' } }],
      order_key_updates: [{ order_id: 'order-checkout', keys_required: 2 }],
    })
    assert.equal(unrelatedOrderRejected.status, 400, JSON.stringify(unrelatedOrderRejected.body))
    assert.equal(unrelatedOrderRejected.body.message, 'order_key_target_not_in_items')
    assert.deepEqual((await admin.query('SELECT keys_required FROM orders WHERE id=$1', ['order-checkout'])).rows, unrelatedOrderBefore.rows)

    const mobilePayload = {
      operation_id: 'synthetic-mobile-save-1',
      task_ids: ['independent-checkin'],
      password_task_ids: ['independent-checkin'],
      items: [{ id: 'independent-checkin', checkin_time: '4:15pm', guest_special_request: 'synthetic mobile request' }],
      new_code: 'SYNTH-MOBILE-NEW',
      password_verification: {
        fields: ['new_code'],
        request_id: 'synthetic-mobile-save-1',
        client: 'mobile',
      },
    }
    const mobileSaved = await managerFields(mobilePayload)
    assert.equal(mobileSaved.status, 201, JSON.stringify(mobileSaved.body))
    assert.equal(mobileSaved.body.operation_id, mobilePayload.operation_id)
    assert.equal(mobileSaved.body.manager_fields_receipt_version, 1)
    assert.equal(mobileSaved.body.projection_refresh_required, true, 'check-in time can change role-scoped guest-ready actions')
    assert.deepEqual(mobileSaved.body.authoritative_updates.map((update: any) => ({
      task_id: update.task_id,
      task_type: update.task_type,
      checkin_time: update.checkin_time,
      new_code: update.new_code,
      new_code_authority_status: update.new_code_authority_status,
      guest_special_request: update.guest_special_request,
      has_sequence: Number(update.sequence_no || 0) > 0,
    })), [{
      task_id: 'independent-checkin',
      task_type: 'checkin_clean',
      checkin_time: '4:15pm',
      new_code: 'SYNTH-MOBILE-NEW',
      new_code_authority_status: 'manual_confirmed',
      guest_special_request: 'synthetic mobile request',
      has_sequence: true,
    }], 'the save response must carry only the committed affected task state')
    const mobileReadBack = await admin.query(
      'SELECT checkin_time, new_code, new_code_authority_status, guest_special_request FROM cleaning_tasks WHERE id=$1',
      ['independent-checkin'],
    )
    assert.deepEqual(mobileReadBack.rows[0], {
      checkin_time: '4:15pm',
      new_code: 'SYNTH-MOBILE-NEW',
      new_code_authority_status: 'manual_confirmed',
      guest_special_request: 'synthetic mobile request',
    })
    const mobileCounts = async () => ({
      submitReceipts: Number((await admin.query("SELECT COUNT(*)::int AS count FROM app_submit_receipts WHERE scope_type='cleaning_task_manager_fields'")).rows[0].count),
      passwordReceipts: Number((await admin.query("SELECT COUNT(*)::int AS count FROM cleaning_password_authority_receipts WHERE request_id LIKE 'synthetic-mobile-save-%'")).rows[0].count),
      events: Number((await admin.query("SELECT COUNT(*)::int AS count FROM work_task_events WHERE source_ref_ids && ARRAY['independent-checkin']::text[]")).rows[0].count),
    })
    const mobileCountsAfterSave = await mobileCounts()
    assert.equal(mobileCountsAfterSave.submitReceipts, 1)
    assert.equal(mobileCountsAfterSave.passwordReceipts, 1)
    assert.equal(mobileCountsAfterSave.events, 3, 'the HTTP success must not precede its durable task event evidence')
    const storedMobileReceiptRow = (await admin.query(
      `SELECT scope_type, scope_id, submit_id, step_key, payload_hash, response_json
         FROM app_submit_receipts
        WHERE scope_type='cleaning_task_manager_fields' AND submit_id=$1`,
      [mobilePayload.operation_id],
    )).rows[0]
    const storedMobileReceipt = storedMobileReceiptRow?.response_json
    assert.deepEqual(storedMobileReceipt.authoritative_updates, [], 'idempotency storage must not persist credential values')
    assert.deepEqual(storedMobileReceipt.authoritative_task_ids, ['independent-checkin'])
    assert.ok(!JSON.stringify(storedMobileReceiptRow).includes('SYNTH-MOBILE-NEW'), 'the complete receipt row must not contain the password value')
    const normalizedMobilePayload = {
      ...mobilePayload,
      task_ids: [...new Set(mobilePayload.task_ids)].sort(),
      items: [...mobilePayload.items].sort((a, b) => a.id.localeCompare(b.id)),
      password_task_ids: [...new Set(mobilePayload.password_task_ids)].sort(),
      password_verification: {
        ...mobilePayload.password_verification,
        fields: [...new Set(mobilePayload.password_verification.fields)].sort(),
      },
    }
    assert.notEqual(
      storedMobileReceiptRow.payload_hash,
      buildCanonicalIdempotencyPayloadHash(normalizedMobilePayload),
      'manager receipt payload_hash must not be an offline-enumerable plain digest of low-entropy credentials',
    )

    const mobileReplay = await managerFields(mobilePayload)
    assert.equal(mobileReplay.status, 201, JSON.stringify(mobileReplay.body))
    assert.equal(mobileReplay.body.replayed, true)
    assert.equal(mobileReplay.body.authoritative_updates[0]?.new_code, 'SYNTH-MOBILE-NEW', 'a response-loss replay must rehydrate current authoritative state')
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.deepEqual(await mobileCounts(), mobileCountsAfterSave, 'a lost-response Mobile retry must not duplicate receipts or task events')

    const mobileConflict = await managerFields({
      ...mobilePayload,
      items: [{ ...mobilePayload.items[0], guest_special_request: 'same operation changed payload' }],
    })
    assert.equal(mobileConflict.status, 409, JSON.stringify(mobileConflict.body))
    assert.equal(mobileConflict.body.message, 'idempotency_conflict')
    assert.deepEqual(await mobileCounts(), mobileCountsAfterSave)

    const mobileLaterEdit = await managerFields({
      ...mobilePayload,
      operation_id: 'synthetic-mobile-save-2',
      items: [{ ...mobilePayload.items[0], guest_special_request: 'intentional later mobile edit' }],
      password_verification: {
        ...mobilePayload.password_verification,
        request_id: 'synthetic-mobile-save-2',
      },
    })
    assert.equal(mobileLaterEdit.status, 201, JSON.stringify(mobileLaterEdit.body))
    assert.equal(
      (await admin.query('SELECT guest_special_request FROM cleaning_tasks WHERE id=$1', ['independent-checkin'])).rows[0].guest_special_request,
      'intentional later mobile edit',
    )
    const mobileCountsAfterLaterEdit = await mobileCounts()
    assert.equal(mobileCountsAfterLaterEdit.submitReceipts, mobileCountsAfterSave.submitReceipts + 1)
    assert.equal(mobileCountsAfterLaterEdit.passwordReceipts, mobileCountsAfterSave.passwordReceipts + 1)
    const mobileReplayAfterLaterEdit = await managerFields(mobilePayload)
    assert.equal(mobileReplayAfterLaterEdit.status, 201, JSON.stringify(mobileReplayAfterLaterEdit.body))
    assert.equal(mobileReplayAfterLaterEdit.body.replayed, true)
    assert.equal(
      mobileReplayAfterLaterEdit.body.authoritative_updates[0]?.guest_special_request,
      'intentional later mobile edit',
      'an old operation replay must return current authoritative state after a newer save',
    )
    assert.equal(
      Number(mobileReplayAfterLaterEdit.body.authoritative_updates[0]?.sequence_no),
      Number(mobileLaterEdit.body.authoritative_updates[0]?.sequence_no),
      'rehydrated current state must carry the current durable event sequence rather than the old operation sequence',
    )
    assert.equal(mobileReplayAfterLaterEdit.body.authoritative_task_ids, undefined, 'internal idempotency metadata must not leak on replay')
    assert.equal(mobileReplayAfterLaterEdit.body.authoritative_event_receipts, undefined, 'internal event metadata must not leak on replay')
    assert.deepEqual(await mobileCounts(), mobileCountsAfterLaterEdit, 'rehydrating an old operation must not create new receipts or events')
    await admin.query("UPDATE cleaning_tasks SET status='ready', execution_state='active' WHERE id='independent-checkin'")
    const terminalMobileReplay = await managerFields(mobilePayload)
    assert.equal(terminalMobileReplay.status, 201, JSON.stringify(terminalMobileReplay.body))
    assert.equal(terminalMobileReplay.body.replayed, true)
    assert.deepEqual(terminalMobileReplay.body.authoritative_updates, [])
    assert.equal(terminalMobileReplay.body.projection_refresh_required, true)
    assert.equal(JSON.stringify(terminalMobileReplay.body).includes('SYNTH-MOBILE-NEW'), false, 'terminal replay must not return a raw password')
    assert.equal(terminalMobileReplay.body.authoritative_task_ids, undefined)
    assert.equal(terminalMobileReplay.body.authoritative_event_receipts, undefined)
    assert.deepEqual(await mobileCounts(), mobileCountsAfterLaterEdit, 'terminal replay must remain read-only and event-free')
    await admin.query("UPDATE cleaning_tasks SET status='assigned', execution_state='active' WHERE id='independent-checkin'")

    const mobileCombinedPayload = {
      operation_id: 'synthetic-mobile-combined-1',
      task_ids: ['order-checkout-task', 'order-checkin-task'],
      items: [
        { id: 'order-checkin-task', checkin_time: '5:10pm', guest_special_request: 'shared mobile combined request' },
        { id: 'order-checkout-task', checkout_time: '12:10pm', guest_special_request: 'shared mobile combined request' },
      ],
    }
    const combinedEventsBefore = Number((await admin.query(
      "SELECT COUNT(*)::int AS count FROM work_task_events WHERE source_ref_ids && ARRAY['order-checkout-task','order-checkin-task']::text[]",
    )).rows[0].count)
    const mobileCombinedSaved = await managerFields(mobileCombinedPayload)
    assert.equal(mobileCombinedSaved.status, 201, JSON.stringify(mobileCombinedSaved.body))
    assert.equal(mobileCombinedSaved.body.manager_fields_receipt_version, 1)
    assert.equal(mobileCombinedSaved.body.projection_refresh_required, true)
    assert.deepEqual(
      mobileCombinedSaved.body.authoritative_updates.map((update: any) => update.task_id).sort(),
      ['order-checkin-task', 'order-checkout-task'],
      'a combined save receipt must include both exact source tasks and no whole-range projection',
    )
    assert.deepEqual((await admin.query(
      `SELECT id, checkout_time, checkin_time, guest_special_request
       FROM cleaning_tasks
       WHERE id = ANY($1::text[])
       ORDER BY id`,
      [['order-checkout-task', 'order-checkin-task']],
    )).rows, [
      { id: 'order-checkin-task', checkout_time: null, checkin_time: '5:10pm', guest_special_request: 'shared mobile combined request' },
      { id: 'order-checkout-task', checkout_time: '12:10pm', checkin_time: null, guest_special_request: 'shared mobile combined request' },
    ], 'Mobile manager-fields items must preserve task-specific times')
    const combinedEventsAfter = Number((await admin.query(
      "SELECT COUNT(*)::int AS count FROM work_task_events WHERE source_ref_ids && ARRAY['order-checkout-task','order-checkin-task']::text[]",
    )).rows[0].count)
    assert.equal(combinedEventsAfter, combinedEventsBefore + 2, 'both durable task events must exist before HTTP success')
    const mobileCombinedReplay = await managerFields(mobileCombinedPayload)
    assert.equal(mobileCombinedReplay.status, 201, JSON.stringify(mobileCombinedReplay.body))
    assert.equal(mobileCombinedReplay.body.replayed, true)
    assert.equal(Number((await admin.query(
      "SELECT COUNT(*)::int AS count FROM work_task_events WHERE source_ref_ids && ARRAY['order-checkout-task','order-checkin-task']::text[]",
    )).rows[0].count), combinedEventsAfter)

    const checkoutOnlyKeysPayload = {
      operation_id: 'synthetic-mobile-checkout-only-keys-1',
      task_ids: ['checkout-only-task'],
      items: [{ id: 'checkout-only-task', checkout_time: '12:10pm' }],
      keys_required: 2,
    }
    const checkoutOnlyEventsBefore = Number((await admin.query(
      "SELECT COUNT(*)::int AS count FROM work_task_events WHERE source_ref_ids && ARRAY['checkout-only-task']::text[]",
    )).rows[0].count)
    const checkoutOnlyKeysSaved = await managerFields(checkoutOnlyKeysPayload)
    assert.equal(checkoutOnlyKeysSaved.status, 201, JSON.stringify(checkoutOnlyKeysSaved.body))
    assert.deepEqual((await admin.query(
      'SELECT checkout_time, keys_required FROM cleaning_tasks WHERE id=$1',
      ['checkout-only-task'],
    )).rows[0], { checkout_time: '12:10pm', keys_required: 2 })
    assert.equal(
      Number((await admin.query("SELECT keys_required FROM orders WHERE id='checkout-only-order'")).rows[0].keys_required),
      2,
      'a checkout-only card without any future check-in must persist keys to its selected order',
    )
    const checkoutOnlyEventsAfter = Number((await admin.query(
      "SELECT COUNT(*)::int AS count FROM work_task_events WHERE source_ref_ids && ARRAY['checkout-only-task']::text[]",
    )).rows[0].count)
    assert.ok(checkoutOnlyEventsAfter > checkoutOnlyEventsBefore, 'checkout-only keys must have durable event evidence before success')
    const checkoutOnlyKeysReplay = await managerFields(checkoutOnlyKeysPayload)
    assert.equal(checkoutOnlyKeysReplay.status, 201, JSON.stringify(checkoutOnlyKeysReplay.body))
    assert.equal(checkoutOnlyKeysReplay.body.replayed, true)
    assert.equal(Number((await admin.query(
      "SELECT COUNT(*)::int AS count FROM work_task_events WHERE source_ref_ids && ARRAY['checkout-only-task']::text[]",
    )).rows[0].count), checkoutOnlyEventsAfter, 'checkout-only retry must not duplicate durable events')

    const wrongTimeTargetBefore = await admin.query(
      'SELECT id, checkout_time, checkin_time FROM cleaning_tasks WHERE id = ANY($1::text[]) ORDER BY id',
      [['order-checkout-task', 'order-checkin-task']],
    )
    const wrongTimeTarget = await managerFields({
      operation_id: 'synthetic-mobile-wrong-time-target-1',
      task_ids: ['order-checkout-task', 'order-checkin-task'],
      items: [{ id: 'order-checkin-task', checkout_time: 'must-not-save' }],
    })
    assert.equal(wrongTimeTarget.status, 400, JSON.stringify(wrongTimeTarget.body))
    assert.equal(wrongTimeTarget.body.message, 'checkout_time_target_not_checkout')
    assert.deepEqual((await admin.query(
      'SELECT id, checkout_time, checkin_time FROM cleaning_tasks WHERE id = ANY($1::text[]) ORDER BY id',
      [['order-checkout-task', 'order-checkin-task']],
    )).rows, wrongTimeTargetBefore.rows)
    assert.equal(
      Number((await admin.query("SELECT COUNT(*)::int AS count FROM app_submit_receipts WHERE submit_id='synthetic-mobile-wrong-time-target-1'")).rows[0].count),
      0,
    )

    const atomicManualKeysBefore = await admin.query('SELECT order_id, keys_required, guest_special_request FROM cleaning_tasks WHERE id=$1', ['stayover-task'])
    await locker.query('BEGIN')
    await locker.query("UPDATE cleaning_tasks SET order_id='order-checkin' WHERE id='stayover-task'")
    const atomicManualKeysRacePromise = atomicPatch({
      operation_id: 'synthetic-atomic-manual-keys-race-1',
      items: [{ id: 'stayover-task', patch: { keys_required: 2, guest_special_request: 'must roll back key target race' } }],
      order_key_updates: [],
    })
    await waitForBlockedQuery(admin, '%SELECT * FROM cleaning_tasks%FOR UPDATE%')
    await locker.query('COMMIT')
    const atomicManualKeysRace = await atomicManualKeysRacePromise
    assert.equal(atomicManualKeysRace.status, 400, JSON.stringify(atomicManualKeysRace.body))
    assert.match(String(atomicManualKeysRace.body.message || ''), /关联订单/)
    assert.deepEqual(
      (await admin.query('SELECT keys_required, guest_special_request FROM cleaning_tasks WHERE id=$1', ['stayover-task'])).rows,
      atomicManualKeysBefore.rows.map((row: any) => ({ keys_required: row.keys_required, guest_special_request: row.guest_special_request })),
      'a manual-key save must revalidate order binding after the task lock and roll back all fields',
    )
    assert.equal(Number((await admin.query("SELECT COUNT(*)::int AS count FROM app_submit_receipts WHERE submit_id='synthetic-atomic-manual-keys-race-1'")).rows[0].count), 0)
    await admin.query("UPDATE cleaning_tasks SET order_id=NULL WHERE id='stayover-task'")

    await admin.query("UPDATE orders SET keys_required=1 WHERE id='order-checkin'")
    await admin.query("UPDATE cleaning_tasks SET keys_required=1 WHERE order_id='order-checkin'")
    await locker.query('BEGIN')
    await locker.query("UPDATE cleaning_tasks SET order_id='order-checkin' WHERE id='independent-checkin'")
    const managerKeysRacePromise = managerFields({
      operation_id: 'synthetic-manager-keys-race-1',
      task_ids: ['independent-checkin'],
      keys_required: 2,
    })
    await waitForBlockedQuery(admin, '%SELECT id::text AS id, order_id::text AS order_id, status%FOR UPDATE%')
    await locker.query('COMMIT')
    const managerKeysRace = await managerKeysRacePromise
    assert.equal(managerKeysRace.status, 201, JSON.stringify(managerKeysRace.body))
    assert.equal((await admin.query("SELECT keys_required FROM orders WHERE id='order-checkin'")).rows[0].keys_required, 2)
    assert.equal((await admin.query("SELECT keys_required FROM cleaning_tasks WHERE id='independent-checkin'")).rows[0].keys_required, 2)
    assert.equal(Number((await admin.query("SELECT COUNT(*)::int AS count FROM app_submit_receipts WHERE submit_id='synthetic-manager-keys-race-1'")).rows[0].count), 1)
    await admin.query("UPDATE cleaning_tasks SET keys_required=1 WHERE id='independent-checkin'")
    const managerOrderBackedKeysReceipt = await managerFields({
      operation_id: 'synthetic-manager-order-backed-keys-receipt-1',
      task_ids: ['independent-checkin'],
      items: [{ id: 'independent-checkin', guest_special_request: 'order-backed key receipt check' }],
    })
    assert.equal(managerOrderBackedKeysReceipt.status, 201, JSON.stringify(managerOrderBackedKeysReceipt.body))
    assert.equal(
      Number(managerOrderBackedKeysReceipt.body.authoritative_updates[0]?.keys_required),
      2,
      'the authoritative receipt must use the linked order key count rather than a stale task fallback',
    )
    assert.equal(
      Number((await admin.query("SELECT keys_required FROM cleaning_tasks WHERE id='independent-checkin'")).rows[0].keys_required),
      1,
      'the synthetic fixture must retain a divergent task fallback so the order-backed assertion is meaningful',
    )
    const managerNoopEventsBefore = Number((await admin.query('SELECT COUNT(*)::int AS count FROM work_task_events')).rows[0].count)
    const managerNoopKeys = await managerFields({
      operation_id: 'synthetic-manager-keys-noop-1',
      task_ids: ['independent-checkin'],
      keys_required: 2,
    })
    assert.equal(managerNoopKeys.status, 201, JSON.stringify(managerNoopKeys.body))
    assert.equal(Number((await admin.query('SELECT COUNT(*)::int AS count FROM work_task_events')).rows[0].count), managerNoopEventsBefore)
    assert.equal(Number((await admin.query("SELECT COUNT(*)::int AS count FROM app_submit_receipts WHERE submit_id='synthetic-manager-keys-noop-1'")).rows[0].count), 1)
    await admin.query("UPDATE cleaning_tasks SET order_id=NULL WHERE id='independent-checkin'")

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
      eventPayloads.some((payload: string) => (
        payload.includes('SYNTH-MZ109-NEW')
        || payload.includes('SYNTH-MZ109-OLD')
        || payload.includes('SYNTH-MOBILE-NEW')
      )),
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
