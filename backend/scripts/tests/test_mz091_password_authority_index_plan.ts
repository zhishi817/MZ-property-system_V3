import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { Client } from 'pg'

const connectionString = String(process.env.MZ091_INDEX_TEST_DATABASE_URL || '').trim()
const expectedDataDirectory = String(process.env.MZ091_INDEX_TEST_DATA_DIR || '').trim()
const schema = `mz091_index_${process.pid}_${Date.now()}`
const quoteIdentifier = (value: string) => `"${value.replace(/"/g, '""')}"`

function assertSafeEphemeralTarget() {
  if (String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production') {
    throw new Error('MZ091 index test refuses NODE_ENV=production')
  }
  if (!connectionString) throw new Error('MZ091_INDEX_TEST_DATABASE_URL_required')
  if (process.env.MZ091_INDEX_TEST_DATABASE_WRITE !== 'yes') throw new Error('MZ091_INDEX_TEST_DATABASE_WRITE=yes_required')
  if (process.env.MZ091_INDEX_TEST_CONFIRM_EPHEMERAL !== 'yes') throw new Error('MZ091_INDEX_TEST_CONFIRM_EPHEMERAL=yes_required')
  if (!expectedDataDirectory) throw new Error('MZ091_INDEX_TEST_DATA_DIR_required')

  const url = new URL(connectionString)
  if (!['postgres:', 'postgresql:'].includes(url.protocol.toLowerCase())) throw new Error('MZ091_INDEX_TEST_DATABASE_URL_invalid')
  if (!['127.0.0.1', '::1'].includes(url.hostname.toLowerCase())) throw new Error('MZ091_INDEX_TEST_requires_numeric_loopback')
  if (!url.port || url.port === '5432') throw new Error('MZ091_INDEX_TEST_requires_nondefault_port')
  if ([...url.searchParams].length) throw new Error('MZ091_INDEX_TEST_rejects_query_parameters')
  if (!/^mz091_index_runner(?:_[a-z0-9_]+)?$/i.test(decodeURIComponent(url.username))) {
    throw new Error('MZ091_INDEX_TEST_requires_dedicated_user')
  }
  if (!/^mz091_index_test_[a-z0-9_]+$/i.test(decodeURIComponent(url.pathname.replace(/^\//, '')))) {
    throw new Error('MZ091_INDEX_TEST_requires_dedicated_database')
  }
  const resolvedDataDirectory = fs.realpathSync(expectedDataDirectory)
  const temporaryRoot = fs.realpathSync('/tmp')
  if (!resolvedDataDirectory.startsWith(`${temporaryRoot}${path.sep}`)) {
    throw new Error('MZ091_INDEX_TEST_DATA_DIR_must_be_under_tmp')
  }
}

function planNodes(value: any): any[] {
  if (!value || typeof value !== 'object') return []
  const nodes = [value]
  for (const child of Array.isArray(value.Plans) ? value.Plans : []) nodes.push(...planNodes(child))
  return nodes
}

async function explain(client: Client, column: 'old_code_source_order_id' | 'old_code_source_task_id', value: string) {
  const extra = column === 'old_code_source_order_id'
    ? "AND lower(COALESCE(task_type, type, '')) = 'checkin_clean' AND COALESCE(order_id::text, '') <> $1::text"
    : 'AND id::text <> $1::text'
  const result = await client.query(
    `EXPLAIN (FORMAT JSON, COSTS OFF)
     SELECT *
     FROM cleaning_tasks
     WHERE ${column}::text = $1::text
       ${extra}
       AND COALESCE(execution_state, 'active') = 'active'
       AND lower(COALESCE(status, '')) NOT IN ('completed', 'done', 'ready', 'closed')
     ORDER BY id
     FOR UPDATE`,
    [value],
  )
  return result.rows[0]['QUERY PLAN'][0].Plan
}

async function main() {
  assertSafeEphemeralTarget()
  const client = new Client({ connectionString, ssl: false })
  await client.connect()
  try {
    const identity = await client.query(
      `SELECT inet_server_addr()::text AS address,
              inet_server_port() AS port,
              current_database() AS database,
              current_user AS username`,
    )
    const serverAddress = String(identity.rows[0]?.address || '').split('/')[0]
    assert.ok(['127.0.0.1', '::1'].includes(serverAddress))
    assert.notEqual(Number(identity.rows[0]?.port || 5432), 5432)
    assert.match(String(identity.rows[0]?.database || ''), /^mz091_index_test_/)
    assert.match(String(identity.rows[0]?.username || ''), /^mz091_index_runner/)

    await client.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`)
    await client.query(`SET search_path TO ${quoteIdentifier(schema)}, pg_catalog`)
    await client.query(`
      CREATE TABLE schema_migrations(version text PRIMARY KEY);
      INSERT INTO schema_migrations(version) VALUES ('20261101_mz091_password_authority');
      CREATE TABLE cleaning_tasks(
        id text PRIMARY KEY,
        order_id text,
        task_type text,
        type text,
        execution_state text,
        status text,
        old_code_source_order_id text,
        old_code_source_task_id text
      );
      INSERT INTO cleaning_tasks
      SELECT
        'task-' || value,
        'order-' || value,
        'checkin_clean',
        'checkin_clean',
        'active',
        'assigned',
        CASE WHEN value % 5000 = 0 THEN 'source-order' ELSE NULL END,
        CASE WHEN value % 7000 = 0 THEN 'source-task' ELSE NULL END
      FROM generate_series(1, 100000) AS value;
      ANALYZE cleaning_tasks;
    `)

    const beforeOrder = planNodes(await explain(client, 'old_code_source_order_id', 'source-order'))
    const beforeTask = planNodes(await explain(client, 'old_code_source_task_id', 'source-task'))
    assert.ok(beforeOrder.some((node) => node['Node Type'] === 'Seq Scan' && node['Relation Name'] === 'cleaning_tasks'))
    assert.ok(beforeTask.some((node) => node['Node Type'] === 'Seq Scan' && node['Relation Name'] === 'cleaning_tasks'))

    const migrationPath = path.resolve(__dirname, '../migrations/20261101_mz091_password_authority_source_indexes.sql')
    const migration = fs.readFileSync(migrationPath, 'utf8')
    await client.query(migration)
    await client.query(migration)
    await client.query('ANALYZE cleaning_tasks')

    const afterOrder = planNodes(await explain(client, 'old_code_source_order_id', 'source-order'))
    const afterTask = planNodes(await explain(client, 'old_code_source_task_id', 'source-task'))
    assert.ok(afterOrder.some((node) => node['Index Name'] === 'cleaning_tasks_old_code_source_order_idx'))
    assert.ok(afterTask.some((node) => node['Index Name'] === 'cleaning_tasks_old_code_source_task_idx'))
    assert.ok(!afterOrder.some((node) => node['Node Type'] === 'Seq Scan' && node['Relation Name'] === 'cleaning_tasks'))
    assert.ok(!afterTask.some((node) => node['Node Type'] === 'Seq Scan' && node['Relation Name'] === 'cleaning_tasks'))

    const indexes = await client.query(
      `SELECT indexname, indexdef
       FROM pg_indexes
       WHERE schemaname = $1
         AND indexname = ANY($2::text[])
       ORDER BY indexname`,
      [schema, ['cleaning_tasks_old_code_source_order_idx', 'cleaning_tasks_old_code_source_task_idx']],
    )
    assert.equal(indexes.rowCount, 2)
    for (const row of indexes.rows) assert.match(String(row.indexdef || ''), /WHERE .* IS NOT NULL/i)
    const marker = await client.query(
      `SELECT count(*)::int AS count
       FROM schema_migrations
       WHERE version = '20261101_mz091_password_authority_source_indexes'`,
    )
    assert.equal(marker.rows[0]?.count, 1)
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`).catch(() => null)
    await client.end()
  }
  console.log('MZ-091 password authority source index plan: PASS')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
