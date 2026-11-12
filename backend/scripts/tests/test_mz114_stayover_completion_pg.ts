import assert from 'node:assert/strict'
import express from 'express'
import net from 'node:net'
import path from 'node:path'
import { realpathSync } from 'node:fs'

const connectionString = String(process.env.MZ114_SQL_INTEGRATION_DATABASE_URL || '').trim()
if (!connectionString) throw new Error('MZ114_SQL_INTEGRATION_DATABASE_URL_required')
if (process.env.MZ114_SQL_INTEGRATION_WRITE !== '1') throw new Error('MZ114_SQL_INTEGRATION_WRITE=1_required')
if (process.env.MZ114_SQL_INTEGRATION_CONFIRM_EPHEMERAL !== '1') {
  throw new Error('MZ114_SQL_INTEGRATION_CONFIRM_EPHEMERAL=1_required')
}
const expectedDataDirectoryRaw = String(process.env.MZ114_SQL_INTEGRATION_EXPECT_DATA_DIRECTORY || '').trim()
if (!expectedDataDirectoryRaw) throw new Error('MZ114_SQL_INTEGRATION_EXPECT_DATA_DIRECTORY_required')
const expectedDataDirectory = path.resolve(expectedDataDirectoryRaw)
const actualExpectedDirectory = realpathSync(expectedDataDirectory)
assert.ok(actualExpectedDirectory.startsWith(realpathSync('/tmp') + path.sep), 'real data directory must stay under the temporary directory')
if (!expectedDataDirectory.startsWith('/tmp/')) {
  throw new Error('MZ114_SQL_INTEGRATION_EXPECT_DATA_DIRECTORY_must_be_under_tmp')
}

function assertEphemeralLoopbackUrl(raw: string) {
  const url = new URL(raw)
  if (!['postgres:', 'postgresql:'].includes(url.protocol.toLowerCase())) {
    throw new Error('MZ114_SQL_INTEGRATION_DATABASE_URL_must_use_postgresql')
  }
  if ([...url.searchParams].length) {
    throw new Error('MZ114_SQL_INTEGRATION_DATABASE_URL_must_not_include_query_parameters')
  }
  const host = url.hostname.toLowerCase()
  if (!['127.0.0.1', '::1', '[::1]'].includes(host)) {
    throw new Error('MZ114_SQL_INTEGRATION_DATABASE_URL_must_use_numeric_loopback')
  }
  const port = Number(url.port || 5432)
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 5432) {
    throw new Error('MZ114_SQL_INTEGRATION_DATABASE_URL_must_use_random_nondefault_port')
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''))
  if (!/^mz114_[a-z0-9_]+$/i.test(database)) {
    throw new Error('MZ114_SQL_INTEGRATION_DATABASE_URL_must_name_mz114_ephemeral_database')
  }
  const sanitizedUrl = new URL(url.toString())
  sanitizedUrl.search = ''
  return { url: sanitizedUrl, database, port }
}

const target = assertEphemeralLoopbackUrl(connectionString)
// Even a direct invocation cannot connect to another service. Only this verified
// PostgreSQL port and the ephemeral HTTP listener created below are permitted.
const allowedPorts = new Set<number>([target.port])
const originalConnect = net.Socket.prototype.connect
net.Socket.prototype.connect = function (...args: any[]) {
  let options = (net as any)._normalizeArgs(args)[0]
  while (Array.isArray(options)) options = options[0]
  if (options.path || !['127.0.0.1', '::1'].includes(String(options.host || options.hostname || '')) || !allowedPorts.has(Number(options.port))) {
    throw new Error('MZ114 test prohibits external networks and unrelated local services')
  }
  return originalConnect.apply(this, args as any)
} as typeof originalConnect
const schema = `mz114_${process.pid}_${Date.now().toString(36)}`
const applicationName = `mz114_sql_${process.pid}_${Date.now().toString(36)}`
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
      code text, address text, type text
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
      checkin_time text, finished_at timestamptz, lockbox_video_uploaded_at timestamptz, updated_at timestamptz
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
      IF NEW.source_id IN ('rollback-task', 'rollback-complete') THEN
        RAISE EXCEPTION 'synthetic_audit_insert_failure';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER fail_selected_audit
      BEFORE INSERT ON ${q(schema)}.work_task_action_audits
      FOR EACH ROW EXECUTE FUNCTION ${q(schema)}.fail_selected_audit();

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
  assert.equal(row.database, target.database, 'server-reported database must match the dedicated MZ114 database')
  assert.ok(['127.0.0.1', '::1'].includes(serverAddress(row.address)), 'server-reported address must be numeric loopback')
  assert.equal(Number(row.port), target.port, 'server-reported port must match the random nondefault port')
  assert.equal(path.resolve(String(row.data_directory || '')), expectedDataDirectory, 'server data_directory must match the approved /tmp cluster')
}

async function resetFixture(taskId: string, status = 'assigned', taskType = 'stayover_clean') {
  await appPool.query(`
    TRUNCATE cleaning_task_media, work_task_action_audits, app_submit_receipts,
             work_task_participants, cleaning_tasks, mutation_probe RESTART IDENTITY
  `)
  await appPool.query(
    `INSERT INTO cleaning_tasks (
       id, property_id, task_type, type, task_date, date, status, execution_state,
       cleaner_id, inspector_id, assignee_id, inspection_mode, inspection_scope
     ) VALUES ($1,'property-1',$3,$3,'2026-11-01','2026-11-01',$2,'active','inspector-1',NULL,'inspector-1','self_complete','inspect_and_hang')`,
    [taskId, status, taskType],
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

const areas = ['toilet', 'living', 'sofa', 'bedroom', 'kitchen', 'remote_tv', 'vacuum_used']
function photos(drains = 2) {
  return [...areas, ...Array.from({ length: drains }, () => 'shower_drain')]
    .map((area, i) => ({ area, url: `cleaning/synthetic/${area}-${i}.jpg` }))
}
async function request(base: string, task: string, route: string, body: any, user = 'inspector-1'): Promise<JsonResult> {
  const response = await fetch(`${base}/cleaning-app/tasks/${task}/${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-test-user': user }, body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}
async function save(base: string, task: string, items: any[], receipt = 'save-1', user = 'inspector-1') {
  return request(base, task, 'completion-photos', { items, submit_id: receipt, step_key: 'completion_photos' }, user)
}
async function snapshot() {
  const result: any = {}
  for (const table of ['cleaning_tasks', 'cleaning_task_media', 'work_task_action_audits', 'app_submit_receipts']) {
    result[table] = (await appPool.query(`SELECT * FROM ${table} ORDER BY id`)).rows
  }
  return result
}
function expectStatus(result: JsonResult, status: number) {
  assert.equal(result.status, status, JSON.stringify(result.body))
}

async function startRouteServer() {
  const r5 = require('../../src/lib/r5RequestSchema')
  await r5.warmupR5RequestSchema()
  await r5.warmupR5TaskRuntimeSchema()

  const notificationEvents = require('../../src/services/notificationEvents')
  notificationEvents.emitNotificationEvent = async () => { sideEffects.notifications += 1 }
  const cleaningEvents = require('../../src/modules/events')
  cleaningEvents.broadcastCleaningEvent = () => { sideEffects.broadcasts += 1 }

  const auth = require('../../src/auth')
  auth.requirePerm = () => (_req: any, _res: any, next: any) => next()
  auth.listPermissionCodesForUser = async () => ['cleaning_app.tasks.finish']
  const events = require('../../src/services/workTaskEvents')
  events.emitWorkTaskEvent = async () => {}
  const inventoryPath = require.resolve('../../src/modules/inventory')
  require.cache[inventoryPath] = { id: inventoryPath, filename: inventoryPath, loaded: true,
    exports: { recordCleaningTaskStandardLinenUsage: async () => {} } } as any
  const { router } = require('../../src/modules/cleaning_app')
  const app = express()
  app.use(express.json())
  app.use((req: any, _res, next) => {
    req.user = { sub: String(req.headers['x-test-user'] || 'inspector-1'), role: 'cleaner', roles: ['cleaner'] }
    next()
  })
  app.use('/cleaning-app', router)
  server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  allowedPorts.add(address.port)
  return `http://127.0.0.1:${address.port}`
}

async function runAssertions(base: string) {
  assert.throws(() => net.connect({ host: 'example.invalid', port: 443 }), /prohibits external/ )
  assert.throws(() => net.connect({ host: '127.0.0.1', port: 5432 }), /unrelated local/ )
  await resetFixture('save-complete')
  const first = await save(base, 'save-complete', photos(2))
  expectStatus(first, 201)
  assert.equal(first.body.action_result.audit.performed_as_action, 'record_completion_photos')
  assert.equal((await appPool.query('SELECT status FROM cleaning_tasks')).rows[0].status, 'assigned')
  const replayBefore = await snapshot()
  const replay = await save(base, 'save-complete', photos(2))
  expectStatus(replay, 200)
  assert.deepEqual(replay.body, first.body)
  assert.deepEqual(await snapshot(), replayBefore, 'exact receipt replay must not mutate rows')
  expectStatus(await save(base, 'save-complete', photos(3)), 409)
  assert.deepEqual(await snapshot(), replayBefore, 'changed receipt payload must not mutate rows')
  expectStatus(await save(base, 'save-complete', photos(3), 'save-2'), 201)
  assert.equal(await count('cleaning_task_media', "WHERE type='completion_shower_drain'"), 3)
  const completed = await request(base, 'save-complete', 'self-complete', {})
  expectStatus(completed, 200)
  assert.equal(completed.body.status, 'cleaned')
  assert.ok(completed.body.finished_at)
  assert.equal(await count('work_task_action_audits', "WHERE performed_as_action='complete_cleaning'"), 1)
  const doneBefore = await snapshot()
  expectStatus(await save(base, 'save-complete', photos(3), 'save-2'), 200)
  assert.deepEqual(await snapshot(), doneBefore, 'committed photo receipt replay after formal completion remains a read-only replay')
  for (const items of [photos(2), []]) {
    expectStatus(await save(base, 'save-complete', items, 'after-complete'), 409)
    assert.deepEqual(await snapshot(), doneBefore, 'true completion prevents replacement/removal')
  }
  expectStatus(await request(base, 'save-complete', 'self-complete', {}), 409)
  assert.deepEqual(await snapshot(), doneBefore)

  await resetFixture('many-drains')
  expectStatus(await save(base, 'many-drains', photos(25)), 201)
  assert.equal(await count('cleaning_task_media', "WHERE type='completion_shower_drain'"), 25)

  for (const legacyStatus of ['assigned', 'in_progress']) {
    await resetFixture('legacy', legacyStatus)
    await appPool.query(`INSERT INTO work_task_action_audits
      (id,source_type,source_id,performed_as_action,performed_by_user_id,actor_user_id,performed_at,status_before,status_after,metadata)
      VALUES ('legacy','cleaning_tasks','legacy','complete_cleaning','inspector-1','inspector-1',now(),$1,$1,
      '{"route":"cleaning_app.tasks.completion_photos","step":"completion_photos_saved"}')`, [legacyStatus])
    expectStatus(await save(base, 'legacy', photos(2)), 201)
    expectStatus(await request(base, 'legacy', 'self-complete', {}), 200)
    assert.equal(await count('work_task_action_audits', "WHERE performed_as_action='complete_cleaning'"), 2)
  }

  await resetFixture('unauthorized')
  const forbiddenBefore = await snapshot()
  expectStatus(await save(base, 'unauthorized', photos(2), 'unauthorized', 'other-cleaner'), 403)
  expectStatus(await request(base, 'unauthorized', 'self-complete', {}, 'other-cleaner'), 403)
  assert.deepEqual(await snapshot(), forbiddenBefore)

  await resetFixture('missing-drain')
  expectStatus(await save(base, 'missing-drain', photos(0)), 201)
  const missingBefore = await snapshot()
  const missing = await request(base, 'missing-drain', 'self-complete', {})
  expectStatus(missing, 400)
  assert.deepEqual(missing.body.missing_areas, ['shower_drain'])
  assert.deepEqual(await snapshot(), missingBefore)

  await resetFixture('checkout', 'assigned', 'checkout_clean')
  const checkoutBefore = await snapshot()
  expectStatus(await save(base, 'checkout', photos(2)), 400)
  assert.deepEqual(await snapshot(), checkoutBefore)
  expectStatus(await save(base, 'checkout', photos(1)), 201)
  for (const [area, limit] of Object.entries({ toilet: 9, living: 3, sofa: 2, bedroom: 8, kitchen: 2, vacuum_used: 1, remote_tv: 1, remote_ac: 1, remote_controls: 3 })) {
    await resetFixture(`limit-${area}`)
    const before = await snapshot()
    const result = await save(base, `limit-${area}`, Array.from({ length: limit + 1 }, (_, i) => ({ area, url: `cleaning/synthetic/${i}.jpg` })))
    expectStatus(result, 400)
    assert.equal(result.body.area, area)
    assert.equal(result.body.limit, limit)
    assert.deepEqual(await snapshot(), before)
  }

  await resetFixture('rollback-task')
  await appPool.query(`INSERT INTO cleaning_task_media(id,task_id,type,url,uploader_id)
    VALUES ('old','rollback-task','completion_shower_drain','cleaning/synthetic/old.jpg','inspector-1')`)
  const rollbackBefore = await snapshot()
  await clearProbe()
  sideEffects = { broadcasts: 0, notifications: 0 }
  const rollback = await save(base, 'rollback-task', photos(3))
  expectStatus(rollback, 500)
  assert.equal(rollback.body.message, 'synthetic_audit_insert_failure')
  assert.deepEqual(await snapshot(), rollbackBefore, 'real PostgreSQL transaction must roll back replacement and audit failure')
  assert.equal(await count('mutation_probe'), 0)
  const probe = await probeSequenceState()
  assert.equal(probe.isCalled, true)
  assert.ok(probe.lastValue >= 2, 'probe sequence proves mutations executed before rollback')
  assert.deepEqual(sideEffects, { broadcasts: 0, notifications: 0 })
  await resetFixture('rollback-complete')
  for (const [i, item] of photos(2).entries()) {
    await appPool.query(`INSERT INTO cleaning_task_media(id,task_id,type,url,uploader_id)
      VALUES ($1,'rollback-complete',$2,$3,'inspector-1')`, [String(i), `completion_${item.area}`, item.url])
  }
  const completionRollbackBefore = await snapshot()
  const completionRollback = await request(base, 'rollback-complete', 'self-complete', {})
  expectStatus(completionRollback, 500)
  assert.equal(completionRollback.body.message, 'synthetic_audit_insert_failure')
  assert.deepEqual(await snapshot(), completionRollbackBefore, 'formal completion failure rolls back status/finished_at and audit')

  for (const status of ['cleaned', 'restock_pending', 'restocked', 'keys_hung', 'inspected', 'ready', 'completed', 'done', 'cancelled', 'canceled']) {
    await resetFixture(`terminal-${status}`, status)
    const before = await snapshot()
    expectStatus(await save(base, `terminal-${status}`, photos(2)), 409)
    assert.deepEqual(await snapshot(), before, 'terminal status remains immutable even without an audit')
  }
  for (const metadata of [{ route: 'cleaning_app.tasks.self_complete' },
    { route: 'cleaning_app.tasks.completion_photos', step: 'not_completion_photos_saved' },
    { route: 'cleaning_app.tasks.completion_photos' },
    { step: 'completion_photos_saved' }, {}]) {
    await resetFixture('real-audit')
    await appPool.query(`INSERT INTO work_task_action_audits
      (id,source_type,source_id,performed_as_action,actor_user_id,performed_at,status_before,status_after,metadata)
      VALUES ('real','cleaning_tasks','real-audit','complete_cleaning','inspector-1',now(),'assigned','assigned',$1)`, [metadata])
    const before = await snapshot()
    expectStatus(await save(base, 'real-audit', photos(2)), 409)
    assert.deepEqual(await snapshot(), before, 'only exact legacy photo-only audit is excluded')
  }


  await resetFixture('transition-audit')
  await appPool.query(`INSERT INTO work_task_action_audits
    (id,source_type,source_id,performed_as_action,actor_user_id,performed_at,status_before,status_after,metadata)
    VALUES ('transition','cleaning_tasks','transition-audit','complete_cleaning','inspector-1',now(),'assigned','cleaned',
    '{"route":"cleaning_app.tasks.completion_photos","step":"completion_photos_saved"}')`)
  const transitionBefore = await snapshot()
  expectStatus(await save(base, 'transition-audit', photos(2)), 409)
  assert.deepEqual(await snapshot(), transitionBefore, 'matching legacy metadata must not hide a real status transition')

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
  net.Socket.prototype.connect = originalConnect
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
    console.log('MZ114 stayover completion actual-route PostgreSQL integration tests passed')
  } catch (error) {
    executionError = error
  }
  const cleanupErrors = await cleanupResources()
  if (executionError && cleanupErrors.length) {
    throw new AggregateError([executionError, ...cleanupErrors], 'MZ114 PostgreSQL test and cleanup both failed')
  }
  if (executionError) throw executionError
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'MZ114 PostgreSQL cleanup failed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
