import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import express from 'express'
import jwt from 'jsonwebtoken'
import { Client } from 'pg'

const connectionString = String(process.env.MZ010_TEST_DATABASE_URL || '').trim()
const schema = `mz010_http_${process.pid}_${Date.now()}`
const quoteIdentifier = (value: string) => `"${value.replace(/"/g, '""')}"`

function assertSafeLocalTarget(target = connectionString) {
  if (String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production') {
    throw new Error('MZ010 HTTP test refuses NODE_ENV=production')
  }
  if (!target) throw new Error('MZ010_TEST_DATABASE_URL is required')
  const url = new URL(target)
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('MZ010 HTTP test requires PostgreSQL')
  if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname.toLowerCase())) {
    throw new Error('MZ010 HTTP test accepts localhost only')
  }
  for (const key of url.searchParams.keys()) {
    if (key.toLowerCase() !== 'sslmode') {
      throw new Error(`MZ010 HTTP test rejects connection query parameter: ${key}`)
    }
  }
  const sslModes = url.searchParams.getAll('sslmode')
  if (sslModes.length > 1 || (sslModes[0] && sslModes[0].toLowerCase() !== 'disable')) {
    throw new Error('MZ010 HTTP test accepts only sslmode=disable')
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''))
  if (!/^mz010_test_[a-z0-9_]+$/i.test(database)) {
    throw new Error('MZ010 HTTP test database name must start with mz010_test_')
  }
  if (process.env.MZ010_TEST_DATABASE_WRITE !== 'yes') {
    throw new Error('MZ010_TEST_DATABASE_WRITE=yes is required')
  }
}

function melbourneBusinessDate() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Melbourne',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value || ''
  return `${value('year')}-${value('month')}-${value('day')}`
}

async function main() {
  assertSafeLocalTarget()
  for (const key of ['host', 'hostaddr', 'service', 'port', 'user', 'password', 'options', 'database', 'dbname']) {
    assert.throws(
      () => assertSafeLocalTarget(`postgresql://127.0.0.1/mz010_test_guard?${key}=shared.invalid`),
      /rejects connection query parameter/,
      `${key} must not be able to redirect or redefine the guarded local target`,
    )
  }
  const baseUrl = new URL(connectionString)
  const admin = new Client({ connectionString, ssl: false })
  let server: ReturnType<express.Express['listen']> | null = null
  let runtimePool: any = null
  await admin.connect()
  try {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`)
    await admin.query(`SET search_path TO ${quoteIdentifier(schema)}, pg_catalog`)
    await admin.query(`
      CREATE TABLE schema_migrations(version text PRIMARY KEY);
      CREATE TABLE roles(id text PRIMARY KEY, name text NOT NULL UNIQUE);
      CREATE TABLE role_permissions(role_id text NOT NULL, permission_code text NOT NULL);
      CREATE TABLE users(
        id text PRIMARY KEY,
        role text NOT NULL,
        display_name text,
        username text,
        email text
      );
      CREATE TABLE user_roles(user_id text NOT NULL, role_name text NOT NULL);
      CREATE TABLE cleaning_tasks(
        id text PRIMARY KEY,
        order_id text,
        task_type text,
        type text,
        task_date date,
        date date,
        checkin_time text,
        status text,
        execution_state text,
        property_id text,
        assignee_id text,
        cleaner_id text,
        inspector_id text,
        updated_at timestamptz NOT NULL DEFAULT now(),
        guest_ready_checkin_requirement_version bigint NOT NULL DEFAULT 0
      );
      CREATE TABLE cleaning_task_media(
        id text PRIMARY KEY,
        task_id text NOT NULL,
        type text NOT NULL,
        url text,
        captured_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        uploader_id text
      );
      CREATE TABLE work_task_action_audits(
        id text PRIMARY KEY,
        source_type text NOT NULL,
        source_id text NOT NULL,
        performed_by_user_id text,
        performed_as_action text NOT NULL,
        performed_at timestamptz NOT NULL,
        actor_user_id text,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE work_task_events(
        id text PRIMARY KEY,
        task_id text NOT NULL,
        sequence_no bigint NOT NULL UNIQUE,
        occurred_at timestamptz NOT NULL,
        caused_by_user_id text,
        payload jsonb NOT NULL DEFAULT '{}'::jsonb
      );
    `)

    const migrationPath = path.resolve(__dirname, '../migrations/20261101_manual_task_guest_ready_notification.sql')
    const migration = fs.readFileSync(migrationPath, 'utf8')
      .replaceAll('public.schema_migrations', `${schema}.schema_migrations`)
      .replaceAll('public.cleaning_tasks', `${schema}.cleaning_tasks`)
    await admin.query(migration)

    const taskId = `manual-http-${randomUUID()}`
    const businessDate = melbourneBusinessDate()
    await admin.query(
      `INSERT INTO roles(id, name) VALUES ('role-cs', 'customer_service'), ('role-cleaner', 'cleaner');
       INSERT INTO role_permissions(role_id, permission_code)
       VALUES ('role-cs', 'order.guest_ready_notification.manage');
       INSERT INTO users(id, role, display_name, username)
       VALUES
         ('cs-http', 'customer_service', 'Synthetic Support', 'synthetic-support'),
         ('cleaner-http', 'cleaner', 'Synthetic Cleaner', 'synthetic-cleaner'),
         ('executor-http', 'cleaner', 'Synthetic Executor', 'synthetic-executor');
       INSERT INTO user_roles(user_id, role_name)
       VALUES ('cs-http', 'customer_service'), ('cleaner-http', 'cleaner'), ('executor-http', 'cleaner')`,
    )
    await admin.query(
      `INSERT INTO cleaning_tasks(
         id, task_type, task_date, status, execution_state, property_id, assignee_id,
         guest_ready_checkin_requirement_version
       ) VALUES ($1, 'checkin_clean', $2::date, 'keys_hung', 'active', 'property-http', 'executor-http', 0)`,
      [taskId, businessDate],
    )
    await admin.query(
      `INSERT INTO cleaning_task_media(id, task_id, type, url, captured_at, uploader_id)
       VALUES ($1, $2, 'lockbox_video', 'synthetic://local-http-lockbox', now(), 'executor-http')`,
      [randomUUID(), taskId],
    )
    await admin.query(
      `INSERT INTO work_task_action_audits(
         id, source_type, source_id, performed_by_user_id, performed_as_action, performed_at, actor_user_id, metadata
       ) VALUES ($1, 'cleaning_tasks', $2, 'executor-http', 'upload_access_video', now(), 'executor-http', $3::jsonb)`,
      [randomUUID(), taskId, JSON.stringify({
        guest_ready_requirement_version: 0,
        task_snapshot: { scheduled_service_date: businessDate },
        property_snapshot: { property_id: 'property-http' },
      })],
    )

    baseUrl.searchParams.set('options', `-c search_path=${schema},pg_catalog`)
    process.env.DATABASE_URL = baseUrl.toString()
    process.env.DATABASE_DIRECT_URL = ''
    process.env.JWT_SECRET = 'mz010-local-http-test-secret'
    process.env.NOTIFICATION_WORKER_ENABLED = 'false'
    process.env.NOTIFICATION_WORKER_RUN_ON_START = 'false'
    process.env.PDF_JOBS_MODE = 'disabled'
    process.env.PERSONNEL_SETTLEMENT_WEEKLY_ENABLED = 'false'

    const [{ auth, clearPermissionCacheForRoles, invalidateUserAuthState }, { pgPool }, { router }] = await Promise.all([
      import('../../src/auth'),
      import('../../src/dbAdapter'),
      import('../../src/modules/mzapp'),
    ])
    runtimePool = pgPool
    assert.ok(runtimePool, 'the local HTTP test must initialize the PostgreSQL pool')

    const app = express()
    app.use(express.json())
    app.use(auth)
    app.use('/mzapp', router)
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>((resolve, reject) => {
      server?.once('listening', resolve)
      server?.once('error', reject)
    })
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const endpoint = `http://127.0.0.1:${address.port}/mzapp/guest-ready-task-notifications`
    const token = (sub: string, role: string) => jwt.sign(
      { sub, role, roles: [role], username: sub },
      process.env.JWT_SECRET as string,
      { expiresIn: '5m' },
    )
    const post = async (bearer: string | null, body: unknown) => {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        },
        body: JSON.stringify(body),
      })
      return { status: response.status, body: await response.json() as any }
    }

    const request = { task_id: taskId, action: 'mark', operation_id: 'http-mark-0001', expected_version: 0 }
    assert.equal((await post(null, request)).status, 401, 'anonymous HTTP requests stay unauthorized')
    assert.equal(
      (await post(token('cleaner-http', 'cleaner'), request)).status,
      403,
      'a current non-customer-service identity cannot use the mutation route',
    )

    const marked = await post(token('cs-http', 'customer_service'), request)
    assert.equal(marked.status, 200)
    assert.equal(marked.body.changed, true)
    assert.equal(marked.body.idempotent_replay, false)
    assert.equal(marked.body.guest_ready_notification?.status, 'notified')
    assert.equal(marked.body.guest_ready_notification?.version, 1)

    const replay = await post(token('cs-http', 'customer_service'), request)
    assert.equal(replay.status, 200)
    assert.equal(replay.body.idempotent_replay, true)
    assert.equal(replay.body.guest_ready_notification?.version, 1)

    const stale = await post(token('cs-http', 'customer_service'), {
      task_id: taskId,
      action: 'revoke',
      operation_id: 'http-revoke-stale',
      expected_version: 0,
    })
    assert.equal(stale.status, 409, 'a stale expected version must fail closed')

    const revoked = await post(token('cs-http', 'customer_service'), {
      task_id: taskId,
      action: 'revoke',
      operation_id: 'http-revoke-0001',
      expected_version: 1,
    })
    assert.equal(revoked.status, 200)
    assert.equal(revoked.body.changed, true)
    assert.equal(revoked.body.guest_ready_notification?.status, 'not_notified')
    assert.equal(revoked.body.guest_ready_notification?.version, 2)

    const audit = await admin.query(
      `SELECT action, changed, metadata, resulting_version
         FROM cleaning_task_guest_ready_notification_events
        WHERE task_id_snapshot=$1
        ORDER BY occurred_at, action`,
      [taskId],
    )
    assert.equal(audit.rowCount, 2, 'idempotent replay and stale requests cannot append duplicate audit rows')
    assert.deepEqual(new Set(audit.rows.map((row) => row.action)), new Set(['mark', 'revoke']))
    for (const row of audit.rows) {
      assert.equal(row.changed, true)
      assert.equal(row.metadata?.source, 'mzapp_manual_checkin_task')
      assert.equal(row.metadata?.no_message_sent, true, 'the route records a marker and never claims a sent message')
    }

    await admin.query(`UPDATE cleaning_tasks SET order_id='synthetic-order' WHERE id=$1`, [taskId])
    const linked = await post(token('cs-http', 'customer_service'), {
      task_id: taskId,
      action: 'mark',
      operation_id: 'http-linked-0001',
      expected_version: 2,
    })
    assert.equal(linked.status, 409)
    assert.equal(linked.body.code, 'GUEST_READY_TASK_LINKED_TO_ORDER')

    await admin.query(`UPDATE users SET role='cleaner' WHERE id='cs-http'`)
    await admin.query(`UPDATE user_roles SET role_name='cleaner' WHERE user_id='cs-http'`)
    invalidateUserAuthState('cs-http')
    clearPermissionCacheForRoles(['customer_service'])
    assert.equal(
      (await post(token('cs-http', 'customer_service'), request)).status,
      403,
      'a current persisted role revocation immediately closes the route despite the stale JWT role claim',
    )

    console.log('guest-ready task notification authenticated HTTP/SQL integration: PASS')
  } finally {
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()))
    if (runtimePool) await runtimePool.end().catch(() => undefined)
    try { await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`) } catch {}
    await admin.end().catch(() => undefined)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
