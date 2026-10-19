import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { Pool, PoolClient } from 'pg'
import { buildPersonnelSettlementPreview } from '../../src/lib/personnelSettlementPreview'

const connectionString = String(process.env.MZ034_SQL_INTEGRATION_DATABASE_URL || '').trim()
if (!connectionString) throw new Error('MZ034_SQL_INTEGRATION_DATABASE_URL_required')
if (process.env.MZ034_SQL_INTEGRATION_WRITE !== '1') throw new Error('MZ034_SQL_INTEGRATION_WRITE=1_required')
if (process.env.MZ034_SQL_INTEGRATION_CONFIRM_EPHEMERAL !== '1') {
  throw new Error('MZ034_SQL_INTEGRATION_CONFIRM_EPHEMERAL=1_required')
}

const backendRoot = path.resolve(__dirname, '../..')
const migrationPath = path.join(
  backendRoot,
  'scripts/migrations/20261013_inspection_assignment_conflict_guard.sql',
)
const schema = `mz034_${process.pid}_${Date.now()}`
const q = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`

const task = (input: {
  id: string
  propertyId: string
  taskType: 'checkout_clean' | 'checkin_clean'
  serviceDate: string
  inspectorId?: string | null
  assigneeId?: string | null
  cleanerId?: string | null
  orderId?: string | null
}) => [
  input.id,
  input.orderId ?? 'order-active',
  input.propertyId,
  input.taskType,
  input.serviceDate,
  input.inspectorId ?? null,
  input.assigneeId ?? null,
  input.cleanerId ?? null,
]

async function insertTask(client: PoolClient, input: Parameters<typeof task>[0]) {
  await client.query(
    `INSERT INTO cleaning_tasks (
       id, order_id, property_id, task_type, type, task_date, date,
       inspection_mode, inspection_scope, execution_state, status,
       inspector_id, assignee_id, cleaner_id
     ) VALUES ($1,$2,$3,$4,$4,$5::date,$5::date,'same_day','inspect_and_hang','active','to_inspect',$6,$7,$8)`,
    task(input),
  )
}

function revision(input: {
  beforeDate: string
  afterDate: string
  propertyId: string
  beforeInspector?: string | null
  afterInspector?: string | null
  beforeAssignee?: string | null
  afterAssignee?: string | null
  reasons: string[]
}) {
  return {
    arrangement_revision: {
      version: 'mz031-v1',
      reasons: input.reasons,
      before: {
        scheduled_service_date: input.beforeDate,
        inspection_due_date: null,
        inspection_mode: 'same_day',
        inspection_scope: 'inspect_and_hang',
        property_id: input.propertyId,
        inspector_id: input.beforeInspector ?? null,
        assignee_id: input.beforeAssignee ?? null,
        cleaner_id: input.beforeAssignee ?? null,
      },
      after: {
        scheduled_service_date: input.afterDate,
        inspection_due_date: null,
        inspection_mode: 'same_day',
        inspection_scope: 'inspect_and_hang',
        property_id: input.propertyId,
        inspector_id: input.afterInspector ?? null,
        assignee_id: input.afterAssignee ?? null,
        cleaner_id: input.afterAssignee ?? null,
      },
    },
  }
}

async function expectConflict(client: PoolClient, name: string, action: () => Promise<void>) {
  await client.query(`SAVEPOINT ${q(name)}`)
  try {
    await action()
    assert.fail(`${name}: expected inspection assignment conflict`)
  } catch (error: any) {
    assert.strictEqual(error?.code, '23514', `${name}: expected SQLSTATE 23514`)
    assert.strictEqual(
      error?.constraint,
      'inspection_assignment_property_date_conflict',
      `${name}: expected canonical constraint`,
    )
  } finally {
    await client.query(`ROLLBACK TO SAVEPOINT ${q(name)}`)
    await client.query(`RELEASE SAVEPOINT ${q(name)}`)
  }
}

const profile = (userId: string) => ({
  id: `profile-${userId}`,
  user_id: userId,
  user_name: userId,
  effective_from: '2000-01-01',
  effective_to: null,
  person_type: 'inspector',
  supplier_legal_name: userId,
  supplier_business_name: null,
  abn: null,
  gst_status: 'not_registered',
  payment_method: 'bank_transfer',
  invoice_document_type: 'invoice',
  currency: 'AUD',
})

const rule = (userId: string) => ({
  rule_id: `rule-${userId}`,
  user_id: userId,
  rule_name: 'Inspection day',
  effective_from: '2000-01-01',
  effective_to: null,
  price_basis: 'inclusive_gst',
  currency: 'AUD',
  item_id: `item-${userId}`,
  component_type: 'inspection_day',
  property_id: null,
  task_type: null,
  conditions: null,
  priority: 0,
  rate_cents: '15000',
})

async function main() {
  const pool = new Pool({
    connectionString,
    max: 1,
    application_name: 'mz034-isolated-sql-integration',
  })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`CREATE SCHEMA ${q(schema)}`)
    await client.query(`SET LOCAL search_path TO ${q(schema)}, pg_catalog`)
    await client.query(`
      CREATE TABLE schema_migrations (version text PRIMARY KEY);
      CREATE TABLE orders (id text PRIMARY KEY, status text);
      CREATE TABLE cleaning_tasks (
        id text PRIMARY KEY,
        order_id text,
        property_id text,
        task_type text,
        type text,
        task_date date,
        date date,
        inspection_due_date date,
        inspection_mode text,
        inspection_scope text,
        execution_state text,
        status text,
        inspector_id text,
        assignee_id text,
        cleaner_id text,
        inspection_replaced_by_checkin_task_id text
      );
      CREATE TABLE work_task_events (
        id text PRIMARY KEY,
        task_id text NOT NULL,
        payload jsonb NOT NULL,
        sequence_no bigint NOT NULL,
        occurred_at timestamptz NOT NULL,
        caused_by_user_id text,
        source_type text,
        source_ref_ids text[]
      );
      CREATE TABLE cleaning_sync_logs (
        task_id text,
        action text,
        created_at timestamptz,
        before jsonb,
        after jsonb
      );
      CREATE TABLE users (
        id text PRIMARY KEY,
        display_name text,
        username text,
        legal_name text
      );
      CREATE TABLE properties (
        id text PRIMARY KEY,
        code text,
        address text,
        type text
      );
      CREATE TABLE work_task_action_audits (
        id text PRIMARY KEY,
        source_id text,
        source_type text,
        performed_as_action text,
        performed_by_user_id text,
        performed_by_name text,
        performed_at timestamptz,
        status_after text,
        metadata jsonb
      );
    `)
    await client.query(
      `INSERT INTO schema_migrations(version) VALUES ('20260902_r5_2a_core_task_schema')`,
    )
    await client.query(`INSERT INTO orders(id,status) VALUES ('order-active','confirmed'), ('order-invalid','invalid')`)
    await client.query(`
      INSERT INTO users(id,display_name) VALUES ('mia','Mia'), ('elise','Elise'), ('sunjialin','Sunjialin');
      INSERT INTO properties(id,code,type) VALUES
        ('property-pair','PAIR','一房一卫'),
        ('property-standalone','STANDALONE','一房一卫'),
        ('property-cross-day','CROSS-DAY','一房一卫'),
        ('property-executor-only','EXECUTOR-ONLY','一房一卫'),
        ('property-dual','DUAL','一房一卫');
    `)

    // Production-shaped identity fixture: check-in executor only, checkout Mia.
    await insertTask(client, {
      id: 'pair-checkout', propertyId: 'property-pair', taskType: 'checkout_clean',
      serviceDate: '2010-01-05', inspectorId: 'mia', assigneeId: 'elise', cleanerId: 'elise',
    })
    await insertTask(client, {
      id: 'pair-checkin', propertyId: 'property-pair', taskType: 'checkin_clean',
      serviceDate: '2010-01-05', inspectorId: null, assigneeId: 'elise', cleanerId: 'elise',
    })

    let migration = fs.readFileSync(migrationPath, 'utf8')
      .replace(/^BEGIN;\s*/u, '')
      .replace(/COMMIT;\s*$/u, '')
      .replace("to_regclass('public.schema_migrations')", `to_regclass('${schema}.schema_migrations')`)
    await client.query(migration)
    const preflight = await client.query(`SELECT * FROM first_effective_inspection_assignment_conflict()`)
    assert.deepStrictEqual(preflight.rows, [], 'executor-only check-in must not fail migration preflight')

    await client.query('SET CONSTRAINTS ALL IMMEDIATE')
    await client.query(`UPDATE cleaning_tasks SET assignee_id='sunjialin', cleaner_id='sunjialin' WHERE id='pair-checkin'`)
    assert.deepStrictEqual(
      (await client.query(`SELECT inspector_id,assignee_id FROM cleaning_tasks WHERE id='pair-checkin'`)).rows,
      [{ inspector_id: null, assignee_id: 'sunjialin' }],
      'executor reassignment must not become inspection reassignment',
    )

    await expectConflict(client, 'explicit_dual_inspector', async () => {
      await insertTask(client, {
        id: 'dual-mia', propertyId: 'property-dual', taskType: 'checkout_clean',
        serviceDate: '2010-01-05', inspectorId: 'mia', assigneeId: 'elise',
      })
      await insertTask(client, {
        id: 'dual-elise', propertyId: 'property-dual', taskType: 'checkin_clean',
        serviceDate: '2010-01-05', inspectorId: 'elise', assigneeId: 'sunjialin',
      })
    })

    await expectConflict(client, 'order_reactivation', async () => {
      await insertTask(client, {
        id: 'reactivated-elise', propertyId: 'property-pair', taskType: 'checkin_clean',
        serviceDate: '2010-01-05', inspectorId: 'elise', assigneeId: 'elise', orderId: 'order-invalid',
      })
      await client.query(`UPDATE orders SET status='confirmed' WHERE id='order-invalid'`)
    })

    await client.query('SET CONSTRAINTS ALL DEFERRED')
    await insertTask(client, {
      id: 'managed-elise', propertyId: 'property-pair', taskType: 'checkin_clean',
      serviceDate: '2010-01-05', inspectorId: 'elise', assigneeId: 'elise',
    })
    await client.query(
      `INSERT INTO work_task_events(id,task_id,payload,sequence_no,occurred_at,caused_by_user_id)
       VALUES ($1,$2,$3::jsonb,1,'2010-01-05T01:00:00Z','manager')`,
      ['managed-close', 'cleaning_task:managed-elise', JSON.stringify(revision({
        beforeDate: '2010-01-05', afterDate: '2010-01-05', propertyId: 'property-pair',
        beforeInspector: 'elise', afterInspector: 'elise', reasons: ['management_closed'],
      }))],
    )
    await client.query('SET CONSTRAINTS ALL IMMEDIATE')
    assert.deepStrictEqual(
      (await client.query(`SELECT * FROM first_effective_inspection_assignment_conflict()`)).rows,
      [],
      'latest management close must remove the row from effective ownership',
    )
    await expectConflict(client, 'management_reopen', async () => {
      await client.query(
        `INSERT INTO work_task_events(id,task_id,payload,sequence_no,occurred_at,caused_by_user_id)
         VALUES ($1,$2,$3::jsonb,2,'2010-01-05T02:00:00Z','manager')`,
        ['managed-reopen', 'cleaning_task:managed-elise', JSON.stringify(revision({
          beforeDate: '2010-01-05', afterDate: '2010-01-05', propertyId: 'property-pair',
          beforeInspector: 'elise', afterInspector: 'elise', reasons: ['management_reopened'],
        }))],
      )
    })
    await client.query(`DELETE FROM cleaning_tasks WHERE id='managed-elise'`)
    await client.query(`DELETE FROM work_task_events WHERE id='managed-close'`)

    await insertTask(client, {
      id: 'standalone-unassigned', propertyId: 'property-standalone', taskType: 'checkin_clean',
      serviceDate: '2010-01-05', inspectorId: null, assigneeId: 'elise', cleanerId: 'elise',
    })
    await insertTask(client, {
      id: 'cross-day-mia', propertyId: 'property-cross-day', taskType: 'checkout_clean',
      serviceDate: '2010-01-12', inspectorId: 'mia', assigneeId: 'sunjialin', cleanerId: 'sunjialin',
    })
    await client.query(
      `INSERT INTO work_task_events(id,task_id,payload,sequence_no,occurred_at,caused_by_user_id)
       VALUES ($1,$2,$3::jsonb,1,'2010-01-06T01:00:00Z',NULL)`,
      ['cross-day-event', 'cleaning_task:cross-day-mia', JSON.stringify(revision({
        beforeDate: '2010-01-05', afterDate: '2010-01-12', propertyId: 'property-cross-day',
        beforeInspector: 'mia', afterInspector: 'mia', beforeAssignee: 'elise', afterAssignee: 'sunjialin',
        reasons: ['scheduled_service_date_changed', 'assignee_changed'],
      }))],
    )
    await insertTask(client, {
      id: 'executor-only', propertyId: 'property-executor-only', taskType: 'checkin_clean',
      serviceDate: '2010-01-05', inspectorId: null, assigneeId: 'sunjialin', cleanerId: 'sunjialin',
    })
    await client.query(
      `INSERT INTO work_task_events(id,task_id,payload,sequence_no,occurred_at,caused_by_user_id)
       VALUES ($1,$2,$3::jsonb,1,'2010-01-06T01:00:00Z',NULL)`,
      ['executor-only-event', 'cleaning_task:executor-only', JSON.stringify(revision({
        beforeDate: '2010-01-05', afterDate: '2010-01-05', propertyId: 'property-executor-only',
        beforeInspector: null, afterInspector: null, beforeAssignee: 'elise', afterAssignee: 'sunjialin',
        reasons: ['assignee_changed'],
      }))],
    )

    const executor = {
      async query(sql: string, params?: any[]) {
        if (sql.includes('FROM personnel_settlement_profiles')) {
          return { rows: ['mia', 'elise', 'sunjialin'].map(profile) }
        }
        if (sql.includes('FROM personnel_fee_rules')) {
          return { rows: ['mia', 'elise', 'sunjialin'].map(rule) }
        }
        if (sql.includes('WITH current_inspection_assignments AS')) return client.query(sql, params)
        if (sql.includes('FROM personnel_settlement_carry_adjustments')) return { rows: [] }
        if (sql.includes('FROM personnel_workload_claims')) return { rows: [] }
        if (sql.includes('WITH payment_candidates AS')) return { rows: [] }
        if (sql.includes('FROM work_task_action_audits a')) return { rows: [] }
        if (sql.includes('FROM cleaning_tasks t')) return { rows: [] }
        throw new Error(`unexpected query: ${sql.slice(0, 120)}`)
      },
    }
    const preview = await buildPersonnelSettlementPreview({ week_start: '2010-01-04' }, executor)
    const mia = preview.people.find((person) => person.user_id === 'mia')
    assert.strictEqual(mia?.lines.length, 1, 'Mia receives exactly one inspection-day line')
    assert.deepStrictEqual(
      mia?.lines[0].work_items.map((item) => item.task_id).sort(),
      ['cross-day-mia', 'pair-checkout'],
      'paired executor-only check-in is ignored and cross-day history remains with explicit Mia',
    )
    assert.strictEqual(preview.people.find((person) => person.user_id === 'elise')?.lines.length, 0)
    assert.strictEqual(preview.people.find((person) => person.user_id === 'sunjialin')?.lines.length, 0)
    assert.deepStrictEqual(
      preview.manual_review.warnings
        .filter((warning) => warning.reason === 'inspection_inspector_missing')
        .map((warning) => warning.task_id)
        .sort(),
      ['executor-only', 'standalone-unassigned'],
      'standalone no-inspector tasks remain explicit pending items and never pay their executors',
    )

    await client.query('ROLLBACK')
    console.log('personnel settlement MZ-034 isolated SQL integration tests passed')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
