import assert from 'node:assert/strict'
import express from 'express'
import path from 'node:path'

const connectionString = String(process.env.MZ073_SQL_INTEGRATION_DATABASE_URL || '').trim()
if (!connectionString) throw new Error('MZ073_SQL_INTEGRATION_DATABASE_URL_required')
if (process.env.MZ073_SQL_INTEGRATION_WRITE !== '1') throw new Error('MZ073_SQL_INTEGRATION_WRITE=1_required')
if (process.env.MZ073_SQL_INTEGRATION_CONFIRM_EPHEMERAL !== '1') {
  throw new Error('MZ073_SQL_INTEGRATION_CONFIRM_EPHEMERAL=1_required')
}
const expectedDataDirectoryRaw = String(process.env.MZ073_SQL_INTEGRATION_EXPECT_DATA_DIRECTORY || '').trim()
if (!expectedDataDirectoryRaw) throw new Error('MZ073_SQL_INTEGRATION_EXPECT_DATA_DIRECTORY_required')
const expectedDataDirectory = path.resolve(expectedDataDirectoryRaw)
if (!expectedDataDirectory.startsWith('/tmp/')) {
  throw new Error('MZ073_SQL_INTEGRATION_EXPECT_DATA_DIRECTORY_must_be_under_tmp')
}

function assertEphemeralLoopbackUrl(raw: string) {
  const url = new URL(raw)
  if (!['postgres:', 'postgresql:'].includes(url.protocol.toLowerCase())) {
    throw new Error('MZ073_SQL_INTEGRATION_DATABASE_URL_must_use_postgresql')
  }
  if ([...url.searchParams].length) {
    throw new Error('MZ073_SQL_INTEGRATION_DATABASE_URL_must_not_include_query_parameters')
  }
  const host = url.hostname.toLowerCase()
  if (!['127.0.0.1', '::1', '[::1]'].includes(host)) {
    throw new Error('MZ073_SQL_INTEGRATION_DATABASE_URL_must_use_numeric_loopback')
  }
  const port = Number(url.port || 5432)
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 5432) {
    throw new Error('MZ073_SQL_INTEGRATION_DATABASE_URL_must_use_random_nondefault_port')
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''))
  if (!/^mz073_[a-z0-9_]+$/i.test(database)) {
    throw new Error('MZ073_SQL_INTEGRATION_DATABASE_URL_must_name_mz073_ephemeral_database')
  }
  const sanitizedUrl = new URL(url.toString())
  sanitizedUrl.search = ''
  return { url: sanitizedUrl, database, port }
}

const target = assertEphemeralLoopbackUrl(connectionString)
const schema = `mz073_${process.pid}_${Date.now().toString(36)}`
const applicationName = `mz073_sql_${process.pid}_${Date.now().toString(36)}`
const q = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`
const serverAddress = (value: any) => String(value || '').split('/')[0]

const pgModule = require('pg')
const NativePool = pgModule.Pool
const adminPool = new NativePool({
  connectionString: target.url.toString(),
  ssl: false,
  max: 4,
  connectionTimeoutMillis: 5000,
  statement_timeout: 10000,
  application_name: `${applicationName}_control`,
})

function assertPoolConfigIsLocal(config: any) {
  const raw = String(config?.connectionString || '')
  const controlledUrl = new URL(raw)
  assert.deepEqual(
    Array.from(controlledUrl.searchParams.keys()).sort(),
    ['application_name', 'options'],
    'application pool URL may contain only harness-owned query parameters',
  )
  assert.equal(controlledUrl.searchParams.get('application_name'), applicationName)
  assert.equal(controlledUrl.searchParams.get('options'), `-c search_path=${schema}`)
  controlledUrl.search = ''
  const parsed = assertEphemeralLoopbackUrl(controlledUrl.toString())
  assert.equal(parsed.database, target.database)
  assert.equal(parsed.port, target.port)
}

class LocalOnlyPool extends NativePool {
  constructor(config: any) {
    assertPoolConfigIsLocal(config)
    super({ ...config, ssl: false })
  }
}

type JsonResult = { status: number; body: any }

let appPool: any = null
let server: any = null
let sideEffects = { broadcasts: 0, notifications: 0 }
let serverIdentityApproved = false
let schemaCreated = false

function scopedConnectionString() {
  const url = new URL(target.url.toString())
  url.searchParams.set('application_name', applicationName)
  url.searchParams.set('options', `-c search_path=${schema}`)
  return url.toString()
}

async function createSyntheticSchema() {
  await adminPool.query(`CREATE SCHEMA ${q(schema)}`)
  schemaCreated = true
  await adminPool.query(`
    CREATE TABLE ${q(schema)}.schema_migrations (
      version text PRIMARY KEY
    );
    INSERT INTO ${q(schema)}.schema_migrations(version) VALUES
      ('20260902_r5_1_request_schema'),
      ('20260902_r5_2a_core_task_schema');

    CREATE TABLE ${q(schema)}.properties (
      id text PRIMARY KEY,
      code text
    );
    CREATE TABLE ${q(schema)}.orders (
      id text PRIMARY KEY,
      status text,
      checkin date,
      checkout date
    );
    CREATE TABLE ${q(schema)}.users (
      id text PRIMARY KEY,
      display_name text,
      username text,
      legal_name text,
      email text
    );
    CREATE TABLE ${q(schema)}.cleaning_tasks (
      id text PRIMARY KEY,
      order_id text,
      property_id text,
      task_type text,
      type text,
      task_date date,
      date date,
      status text,
      execution_state text,
      cleaner_id text,
      inspector_id text,
      assignee_id text,
      inspection_mode text,
      inspection_scope text,
      inspection_due_date date,
      inspection_replaced_by_checkin_task_id text,
      linked_checkout_task_id text,
      checkin_time text
    );
    CREATE TABLE ${q(schema)}.work_task_participants (
      source_type text NOT NULL,
      source_id text NOT NULL,
      user_id text NOT NULL,
      source_relation text NOT NULL,
      action_ids jsonb NOT NULL DEFAULT '[]'::jsonb
    );
    CREATE TABLE ${q(schema)}.cleaning_task_media (
      id text PRIMARY KEY,
      task_id text NOT NULL,
      type text NOT NULL,
      url text NOT NULL,
      note text,
      captured_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      uploader_id text
    );
    CREATE TABLE ${q(schema)}.work_task_action_audits (
      id text PRIMARY KEY,
      source_type text NOT NULL,
      source_id text NOT NULL,
      performed_by_user_id text,
      performed_by_name text,
      performed_as_action text NOT NULL,
      performed_at timestamptz NOT NULL,
      actor_user_id text,
      status_before text,
      status_after text,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE TABLE ${q(schema)}.app_submit_receipts (
      id text PRIMARY KEY,
      scope_type text NOT NULL,
      scope_id text NOT NULL,
      submit_id text NOT NULL,
      step_key text NOT NULL,
      payload_hash text NOT NULL,
      response_json jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (scope_type, scope_id, submit_id, step_key)
    );
    CREATE TABLE ${q(schema)}.mutation_probe (
      id bigserial PRIMARY KEY,
      table_name text NOT NULL,
      operation text NOT NULL,
      recorded_at timestamptz NOT NULL DEFAULT now()
    );

    INSERT INTO ${q(schema)}.properties(id, code) VALUES ('property-1', 'PROPERTY1');
    INSERT INTO ${q(schema)}.users(id, display_name, username, email)
      VALUES ('inspector-1', 'Synthetic Inspector', 'synthetic-inspector', 'synthetic@example.invalid');

    CREATE FUNCTION ${q(schema)}.record_mutation_probe() RETURNS trigger AS $$
    BEGIN
      INSERT INTO ${q(schema)}.mutation_probe(table_name, operation) VALUES (TG_TABLE_NAME, TG_OP);
      RETURN NULL;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER media_mutation_probe
      AFTER INSERT OR DELETE ON ${q(schema)}.cleaning_task_media
      FOR EACH STATEMENT EXECUTE FUNCTION ${q(schema)}.record_mutation_probe();
    CREATE TRIGGER audit_mutation_probe
      AFTER INSERT ON ${q(schema)}.work_task_action_audits
      FOR EACH STATEMENT EXECUTE FUNCTION ${q(schema)}.record_mutation_probe();
    CREATE TRIGGER receipt_mutation_probe
      AFTER INSERT OR UPDATE ON ${q(schema)}.app_submit_receipts
      FOR EACH STATEMENT EXECUTE FUNCTION ${q(schema)}.record_mutation_probe();

    CREATE FUNCTION ${q(schema)}.fail_selected_audit() RETURNS trigger AS $$
    BEGIN
      IF NEW.source_id = 'rollback-task' THEN
        RAISE EXCEPTION 'synthetic_audit_insert_failure';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER fail_selected_audit
      BEFORE INSERT ON ${q(schema)}.work_task_action_audits
      FOR EACH ROW EXECUTE FUNCTION ${q(schema)}.fail_selected_audit();

    CREATE FUNCTION ${q(schema)}.delay_concurrent_media() RETURNS trigger AS $$
    BEGIN
      IF NEW.task_id = 'concurrent-task' THEN
        PERFORM pg_sleep(4);
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER delay_concurrent_media
      BEFORE INSERT ON ${q(schema)}.cleaning_task_media
      FOR EACH ROW EXECUTE FUNCTION ${q(schema)}.delay_concurrent_media();
  `)
}

async function assertServerIdentityBeforeDdl() {
  const result = await adminPool.query(
    `SELECT current_database() AS database,
            inet_server_addr()::text AS address,
            inet_server_port()::int AS port,
            current_setting('data_directory') AS data_directory`,
  )
  const row = result.rows[0] || {}
  assert.equal(row.database, target.database, 'server-reported database must match the dedicated MZ073 database')
  assert.ok(['127.0.0.1', '::1'].includes(serverAddress(row.address)), 'server-reported address must be numeric loopback')
  assert.equal(Number(row.port), target.port, 'server-reported port must match the random nondefault port')
  assert.equal(path.resolve(String(row.data_directory || '')), expectedDataDirectory, 'server data_directory must match the approved /tmp cluster')
}

async function resetFixture(taskId: string, status = 'to_inspect') {
  await appPool.query(`
    TRUNCATE cleaning_task_media, work_task_action_audits, app_submit_receipts,
             work_task_participants, cleaning_tasks, mutation_probe RESTART IDENTITY
  `)
  await appPool.query(
    `INSERT INTO cleaning_tasks (
       id, property_id, task_type, type, task_date, date, status, execution_state,
       cleaner_id, inspector_id, assignee_id, inspection_mode, inspection_scope
     ) VALUES ($1,'property-1','checkout_clean','checkout_clean','2026-11-01','2026-11-01',$2,'active',NULL,'inspector-1','inspector-1','same_day','inspect_and_hang')`,
    [taskId, status],
  )
}

async function clearProbe() {
  await appPool.query('TRUNCATE mutation_probe RESTART IDENTITY')
}

async function probeSequenceState() {
  const result = await appPool.query('SELECT last_value::bigint AS last_value, is_called FROM mutation_probe_id_seq')
  return {
    lastValue: Number(result.rows[0]?.last_value || 0),
    isCalled: !!result.rows[0]?.is_called,
  }
}

async function count(table: string, where = '', params: any[] = []) {
  assert.match(table, /^(cleaning_task_media|work_task_action_audits|app_submit_receipts|mutation_probe)$/)
  const result = await appPool.query(`SELECT COUNT(*)::int AS count FROM ${table} ${where}`, params)
  return Number(result.rows[0]?.count || 0)
}

async function mediaRows(taskId: string) {
  const result = await appPool.query(
    `SELECT type, url, note, uploader_id FROM cleaning_task_media WHERE task_id=$1 ORDER BY type, url`,
    [taskId],
  )
  return result.rows
}

async function submitRestock(baseUrl: string, taskId: string, submitId: string, item = false): Promise<JsonResult> {
  const response = await fetch(`${baseUrl}/mzapp/cleaning-tasks/${taskId}/restock-proof`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      items: item
        ? [{ item_id: 'toilet_paper', status: 'restocked', qty: 1, proof_url: 'cleaning/test/restock.jpg' }]
        : [],
      confirmed_sufficient: !item,
      submit_id: submitId,
      step_key: 'inspection_restock_proof',
    }),
  })
  return { status: response.status, body: await response.json() }
}

async function waitForRealLockWait(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await adminPool.query(
      `SELECT COUNT(*)::int AS sessions,
              COUNT(*) FILTER (WHERE wait_event_type='Lock')::int AS lock_waiters
         FROM pg_stat_activity
        WHERE datname=$1 AND application_name=$2`,
      [target.database, applicationName],
    )
    const sessions = Number(result.rows[0]?.sessions || 0)
    const lockWaiters = Number(result.rows[0]?.lock_waiters || 0)
    if (sessions >= 2 && lockWaiters >= 1) return { sessions, lockWaiters }
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  throw new Error('did not observe two PostgreSQL connections with a real row-lock waiter')
}

async function startRouteServer() {
  const r5 = require('../../src/lib/r5RequestSchema')
  await r5.warmupR5RequestSchema()
  await r5.warmupR5TaskRuntimeSchema()

  const notificationEvents = require('../../src/services/notificationEvents')
  notificationEvents.emitNotificationEvent = async () => { sideEffects.notifications += 1 }
  const cleaningEvents = require('../../src/modules/events')
  cleaningEvents.broadcastCleaningEvent = () => { sideEffects.broadcasts += 1 }

  const { router } = require('../../src/modules/mzapp')
  const app = express()
  app.use(express.json())
  app.use((req: any, _res, next) => {
    req.user = { sub: 'inspector-1', role: 'cleaning_inspector', roles: ['cleaning_inspector'] }
    next()
  })
  app.use('/mzapp', router)
  server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return `http://127.0.0.1:${address.port}`
}

async function runAssertions(baseUrl: string) {
  for (const terminalStatus of ['cancelled', 'ready', 'completed', 'done']) {
    const taskId = `terminal-${terminalStatus}`
    await resetFixture(taskId, terminalStatus)
    await appPool.query(
      `INSERT INTO cleaning_task_media(id,task_id,type,url,uploader_id)
       VALUES ('existing',$1,'restock_proof:soap','cleaning/test/existing.jpg','inspector-1')`,
      [taskId],
    )
    await clearProbe()
    const before = await mediaRows(taskId)
    const result = await submitRestock(baseUrl, taskId, `terminal-submit-${terminalStatus}`, true)
    assert.equal(result.status, 409)
    assert.equal(result.body.message, 'work_record_read_only')
    assert.deepEqual(await mediaRows(taskId), before)
    assert.equal(await count('work_task_action_audits'), 0)
    assert.equal(await count('app_submit_receipts'), 0)
    assert.equal(await count('mutation_probe'), 0, `${terminalStatus} must execute zero mutation statements`)
  }

  await resetFixture('rollback-task')
  await appPool.query(
    `INSERT INTO cleaning_task_media(id,task_id,type,url,uploader_id) VALUES
       ('old-restock','rollback-task','restock_proof:soap','cleaning/test/old.jpg','inspector-1'),
       ('inspection-photo','rollback-task','inspection_photo:toilet','cleaning/test/inspection.jpg','inspector-1')`,
  )
  const rollbackBefore = await mediaRows('rollback-task')
  await clearProbe()
  sideEffects = { broadcasts: 0, notifications: 0 }
  const rollback = await submitRestock(baseUrl, 'rollback-task', 'rollback-submit', true)
  assert.equal(rollback.status, 500)
  assert.equal(rollback.body.message, 'synthetic_audit_insert_failure')
  assert.deepEqual(await mediaRows('rollback-task'), rollbackBefore, 'PostgreSQL must roll back prior DELETE/INSERT statements')
  assert.equal(await count('work_task_action_audits'), 0)
  assert.equal(await count('app_submit_receipts'), 0)
  assert.equal(await count('mutation_probe'), 0, 'probe rows must roll back with the failed transaction')
  const rollbackProbeSequence = await probeSequenceState()
  assert.equal(rollbackProbeSequence.isCalled, true, 'nontransactional probe sequence must prove mutation statements ran before rollback')
  assert.ok(rollbackProbeSequence.lastValue >= 2, 'DELETE and media INSERT statement probes must both advance the sequence before rollback')
  assert.deepEqual(sideEffects, { broadcasts: 0, notifications: 0 })

  await resetFixture('replay-task')
  await appPool.query(
    `INSERT INTO cleaning_task_media(id,task_id,type,url,uploader_id)
     VALUES ('inspection-photo','replay-task','inspection_photo:toilet','cleaning/test/inspection.jpg','inspector-1')`,
  )
  sideEffects = { broadcasts: 0, notifications: 0 }
  const first = await submitRestock(baseUrl, 'replay-task', 'stable-replay-submit')
  assert.equal(first.status, 201)
  const replayState = {
    media: await mediaRows('replay-task'),
    audits: await count('work_task_action_audits'),
    receipts: await count('app_submit_receipts'),
    effects: { ...sideEffects },
  }
  assert.equal(replayState.media.filter((row: any) => row.type === 'inspection_consumables_confirmed').length, 1)
  assert.equal(replayState.media.filter((row: any) => row.type === 'inspection_photo:toilet').length, 1)
  assert.equal(replayState.audits, 1)
  assert.equal(replayState.receipts, 1)
  await clearProbe()
  const replay = await submitRestock(baseUrl, 'replay-task', 'stable-replay-submit')
  assert.equal(replay.status, 200)
  assert.deepEqual(replay.body, first.body)
  assert.deepEqual(await mediaRows('replay-task'), replayState.media)
  assert.equal(await count('work_task_action_audits'), replayState.audits)
  assert.equal(await count('app_submit_receipts'), replayState.receipts)
  assert.deepEqual(sideEffects, replayState.effects)
  assert.equal(await count('mutation_probe'), 0, 'receipt replay must execute zero mutation statements')

  await resetFixture('concurrent-task')
  await appPool.query(
    `INSERT INTO cleaning_task_media(id,task_id,type,url,uploader_id)
     VALUES ('lockbox-video','concurrent-task','lockbox_video','cleaning/test/lockbox.mp4','inspector-1')`,
  )
  await clearProbe()
  sideEffects = { broadcasts: 0, notifications: 0 }
  const requestOne = submitRestock(baseUrl, 'concurrent-task', 'concurrent-submit')
  await new Promise((resolve) => setTimeout(resolve, 80))
  const requestTwo = submitRestock(baseUrl, 'concurrent-task', 'concurrent-submit')
  const observedLock = await waitForRealLockWait()
  assert.ok(observedLock.sessions >= 2)
  assert.ok(observedLock.lockWaiters >= 1)
  const concurrent = await Promise.all([requestOne, requestTwo])
  assert.deepEqual(concurrent.map((result) => result.status).sort(), [200, 201])
  assert.deepEqual(concurrent[0].body, concurrent[1].body)
  const concurrentMedia = await mediaRows('concurrent-task')
  assert.equal(concurrentMedia.filter((row: any) => row.type === 'inspection_consumables_confirmed').length, 1)
  assert.equal(concurrentMedia.filter((row: any) => row.type === 'lockbox_video').length, 1)
  assert.equal(await count('work_task_action_audits'), 1)
  assert.equal(await count('app_submit_receipts'), 1)
  assert.deepEqual(sideEffects, { broadcasts: 1, notifications: 1 })
}

async function cleanupResources() {
  const errors: any[] = []
  if (server) {
    try { await new Promise<void>((resolve, reject) => server.close((error: any) => error ? reject(error) : resolve())) } catch (error) { errors.push(error) }
  }
  if (appPool) {
    try { await appPool.end() } catch (error) { errors.push(error) }
  }
  try { pgModule.Pool = NativePool } catch (error) { errors.push(error) }
  if (serverIdentityApproved && schemaCreated) {
    try { await adminPool.query(`DROP SCHEMA ${q(schema)} CASCADE`) } catch (error) { errors.push(error) }
  }
  try { await adminPool.end() } catch (error) { errors.push(error) }
  return errors
}

async function main() {
  let executionError: any = null
  try {
    await assertServerIdentityBeforeDdl()
    serverIdentityApproved = true
    await createSyntheticSchema()
    process.env.DATABASE_URL = scopedConnectionString()
    process.env.PG_POOL_MAX = '4'
    process.env.PG_CONN_TIMEOUT_MS = '5000'
    process.env.PG_STATEMENT_TIMEOUT_MS = '10000'
    process.env.MZ_DEV_PREVIEW_DISABLE_RUNTIME_DDL = '1'
    pgModule.Pool = LocalOnlyPool

    const dbAdapter = require('../../src/dbAdapter')
    appPool = dbAdapter.pgPool
    assert.ok(dbAdapter.hasPg && appPool, 'real pg Pool must be active')
    const identity = await appPool.query('SELECT current_database() AS database, inet_server_addr()::text AS address, inet_server_port()::int AS port')
    assert.equal(identity.rows[0]?.database, target.database)
    assert.ok(['127.0.0.1', '::1'].includes(serverAddress(identity.rows[0]?.address)))
    assert.equal(Number(identity.rows[0]?.port), target.port)

    const baseUrl = await startRouteServer()
    await runAssertions(baseUrl)
    console.log('MZapp restock-proof PostgreSQL integration tests passed')
  } catch (error) {
    executionError = error
  }
  const cleanupErrors = await cleanupResources()
  if (executionError && cleanupErrors.length) {
    throw new AggregateError([executionError, ...cleanupErrors], 'MZ073 PostgreSQL test and cleanup both failed')
  }
  if (executionError) throw executionError
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'MZ073 PostgreSQL cleanup failed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
