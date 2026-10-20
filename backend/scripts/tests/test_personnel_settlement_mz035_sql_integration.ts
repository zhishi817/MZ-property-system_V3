import assert from 'assert'
import { Pool, PoolClient } from 'pg'
import { buildPersonnelSettlementPreview } from '../../src/lib/personnelSettlementPreview'

const connectionString = String(process.env.MZ035_SQL_INTEGRATION_DATABASE_URL || '').trim()
if (!connectionString) throw new Error('MZ035_SQL_INTEGRATION_DATABASE_URL_required')
if (process.env.MZ035_SQL_INTEGRATION_WRITE !== '1') throw new Error('MZ035_SQL_INTEGRATION_WRITE=1_required')
if (process.env.MZ035_SQL_INTEGRATION_CONFIRM_EPHEMERAL !== '1') {
  throw new Error('MZ035_SQL_INTEGRATION_CONFIRM_EPHEMERAL=1_required')
}

const schema = `mz035_${process.pid}_${Date.now()}`
const q = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`

const profile = (userId: string) => ({
  id: `profile-${userId}`,
  user_id: userId,
  user_name: userId,
  effective_from: '2026-01-01',
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
  effective_from: '2026-01-01',
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

async function insertTask(client: PoolClient, input: {
  id: string
  propertyId: string
  taskType: 'checkout_clean' | 'checkin_clean'
  serviceDate: string
  scope: string | null
  inspectorId?: string | null
  createdAt?: string
  status?: string
  executionState?: string
  inspectionMode?: 'same_day' | 'deferred'
  inspectionDueDate?: string | null
}) {
  await client.query(
    `INSERT INTO cleaning_tasks (
       id, order_id, property_id, task_type, type, task_date, date,
       inspection_due_date, inspection_mode, inspection_scope, execution_state, status,
       inspector_id, assignee_id, cleaner_id, created_at
     ) VALUES ($1,'order-active',$2,$3,$3,$4::date,$4::date,$5::date,$6,$7,$8,$9,$10,'executor','executor',$11::timestamptz)`,
    [
      input.id,
      input.propertyId,
      input.taskType,
      input.serviceDate,
      input.inspectionDueDate ?? null,
      input.inspectionMode ?? 'same_day',
      input.scope,
      input.executionState ?? 'active',
      input.status ?? 'to_inspect',
      Object.prototype.hasOwnProperty.call(input, 'inspectorId') ? input.inspectorId : 'flora',
      input.createdAt ?? '2026-10-01T00:00:00Z',
    ],
  )
}

function revision(input: {
  beforeDate: string
  afterDate: string
  propertyId: string
  beforeScope: string | null
  afterScope: string | null
  inspectorId?: string | null
  beforeInspectorId?: string | null
  afterInspectorId?: string | null
}) {
  return {
    arrangement_revision: {
      version: 'mz031-v1',
      reasons: ['scheduled_service_date_changed'],
      before: {
        scheduled_service_date: input.beforeDate,
        inspection_due_date: null,
        inspection_mode: 'same_day',
        inspection_scope: input.beforeScope,
        property_id: input.propertyId,
        inspector_id: input.beforeInspectorId ?? input.inspectorId ?? 'flora',
      },
      after: {
        scheduled_service_date: input.afterDate,
        inspection_due_date: null,
        inspection_mode: 'same_day',
        inspection_scope: input.afterScope,
        property_id: input.propertyId,
        inspector_id: input.afterInspectorId ?? input.inspectorId ?? 'flora',
      },
    },
  }
}

async function main() {
  const pool = new Pool({
    connectionString,
    max: 1,
    application_name: 'mz035-isolated-sql-integration',
  })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`CREATE SCHEMA ${q(schema)}`)
    await client.query(`SET LOCAL search_path TO ${q(schema)}, pg_catalog`)
    await client.query(`
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
        inspection_replaced_by_checkin_task_id text,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE work_task_events (
        id text PRIMARY KEY,
        task_id text NOT NULL,
        payload jsonb NOT NULL,
        sequence_no bigint NOT NULL,
        occurred_at timestamptz NOT NULL,
        caused_by_user_id text
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
        performed_at timestamptz,
        metadata jsonb
      );
    `)
    await client.query(`INSERT INTO orders(id,status) VALUES ('order-active','confirmed')`)
    await client.query(`INSERT INTO users(id,display_name) VALUES ('flora','Flora'),('elise','Elise')`)

    const propertyIds = [
      'valid-checkout', 'valid-checkin', 'execution-mixed', 'execution-only',
      'legacy-null', 'missing-new', 'missing-inspector', 'invalid-current', 'paired',
      'invalid-checkout-password', 'cancelled', 'manager-override',
      'preserved-legacy', 'preserved-legacy-checkin', 'preserved-invalid',
    ]
    for (const propertyId of propertyIds) {
      await client.query(
        `INSERT INTO properties(id,code,type) VALUES ($1,$2,'一房一卫')`,
        [propertyId, propertyId.toUpperCase()],
      )
    }

    await insertTask(client, {
      id: 'valid-checkout', propertyId: 'valid-checkout', taskType: 'checkout_clean',
      serviceDate: '2026-10-05', scope: null,
    })
    await insertTask(client, {
      id: 'valid-checkin', propertyId: 'valid-checkin', taskType: 'checkin_clean',
      serviceDate: '2026-10-05', scope: 'inspect_and_hang',
    })
    await insertTask(client, {
      id: 'execution-mixed', propertyId: 'execution-mixed', taskType: 'checkin_clean',
      serviceDate: '2026-10-05', scope: 'password_only',
    })
    await insertTask(client, {
      id: 'execution-only', propertyId: 'execution-only', taskType: 'checkin_clean',
      serviceDate: '2026-10-06', scope: 'password_only',
    })
    await insertTask(client, {
      id: 'legacy-null', propertyId: 'legacy-null', taskType: 'checkin_clean',
      serviceDate: '2026-10-05', scope: null, createdAt: '2026-09-01T23:59:59Z',
    })
    await insertTask(client, {
      id: 'missing-new', propertyId: 'missing-new', taskType: 'checkin_clean',
      serviceDate: '2026-10-05', scope: null,
    })
    await insertTask(client, {
      id: 'missing-inspector', propertyId: 'missing-inspector', taskType: 'checkin_clean',
      serviceDate: '2026-10-05', scope: null, inspectorId: null,
    })
    await insertTask(client, {
      id: 'invalid-current', propertyId: 'invalid-current', taskType: 'checkout_clean',
      serviceDate: '2026-10-05', scope: 'unexpected_scope',
    })
    await insertTask(client, {
      id: 'invalid-checkout-password', propertyId: 'invalid-checkout-password', taskType: 'checkout_clean',
      serviceDate: '2026-10-05', scope: 'password_only',
    })
    await insertTask(client, {
      id: 'paired-checkout', propertyId: 'paired', taskType: 'checkout_clean',
      serviceDate: '2026-10-05', scope: null,
    })
    await insertTask(client, {
      id: 'paired-checkin-missing', propertyId: 'paired', taskType: 'checkin_clean',
      serviceDate: '2026-10-05', scope: null, inspectorId: null,
    })
    await insertTask(client, {
      id: 'status-transition', propertyId: 'cancelled', taskType: 'checkout_clean',
      serviceDate: '2026-10-05', scope: 'inspect_and_hang', status: 'cancelled', executionState: 'cancelled',
    })
    await insertTask(client, {
      id: 'manager-override', propertyId: 'manager-override', taskType: 'checkin_clean',
      serviceDate: '2026-10-05', scope: null, inspectorId: 'elise',
    })

    await insertTask(client, {
      id: 'preserved-legacy', propertyId: 'preserved-legacy', taskType: 'checkout_clean',
      serviceDate: '2026-10-12', scope: 'inspect_and_hang', createdAt: '2026-09-01T23:59:59Z',
    })
    await insertTask(client, {
      id: 'preserved-legacy-checkin', propertyId: 'preserved-legacy-checkin', taskType: 'checkin_clean',
      serviceDate: '2026-10-12', scope: 'inspect_and_hang',
    })
    await insertTask(client, {
      id: 'preserved-invalid', propertyId: 'preserved-invalid', taskType: 'checkin_clean',
      serviceDate: '2026-10-12', scope: 'inspect_and_hang',
    })
    await client.query(
      `INSERT INTO work_task_events(id,task_id,payload,sequence_no,occurred_at,caused_by_user_id)
       VALUES
       ($1,$2,$3::jsonb,1,'2026-10-06T01:00:00Z',NULL),
       ($4,$5,$6::jsonb,1,'2026-10-06T01:00:00Z',NULL),
       ($7,$8,$9::jsonb,1,'2026-10-06T01:00:00Z',NULL)`,
      [
        'preserved-legacy-event',
        'cleaning_task:preserved-legacy',
        JSON.stringify(revision({
          beforeDate: '2026-10-05', afterDate: '2026-10-12', propertyId: 'preserved-legacy',
          beforeScope: null, afterScope: 'inspect_and_hang',
        })),
        'preserved-invalid-event',
        'cleaning_task:preserved-invalid',
        JSON.stringify(revision({
          beforeDate: '2026-10-05', afterDate: '2026-10-12', propertyId: 'preserved-invalid',
          beforeScope: 'unexpected_scope', afterScope: 'inspect_and_hang',
        })),
        'preserved-legacy-checkin-event',
        'cleaning_task:preserved-legacy-checkin',
        JSON.stringify(revision({
          beforeDate: '2026-10-05', afterDate: '2026-10-12', propertyId: 'preserved-legacy-checkin',
          beforeScope: null, afterScope: 'inspect_and_hang',
        })),
      ],
    )
    await client.query(
      `INSERT INTO work_task_events(id,task_id,payload,sequence_no,occurred_at,caused_by_user_id)
       VALUES
       ($1,$2,$3::jsonb,1,'2026-10-06T01:00:00Z',NULL),
       ($4,$5,$6::jsonb,2,'2026-10-07T01:00:00Z','manager')`,
      [
        'manager-override-auto-event',
        'cleaning_task:manager-override',
        JSON.stringify(revision({
          beforeDate: '2026-10-05', afterDate: '2026-10-12', propertyId: 'manager-override',
          beforeScope: null, afterScope: null, beforeInspectorId: 'flora', afterInspectorId: 'flora',
        })),
        'manager-override-manager-event',
        'cleaning_task:manager-override',
        JSON.stringify(revision({
          beforeDate: '2026-10-12', afterDate: '2026-10-05', propertyId: 'manager-override',
          beforeScope: null, afterScope: null, beforeInspectorId: 'flora', afterInspectorId: 'elise',
        })),
      ],
    )

    const executor = {
      async query(sql: string, params?: any[]) {
        if (sql.includes('FROM personnel_settlement_profiles')) return { rows: [profile('flora'), profile('elise')] }
        if (sql.includes('FROM personnel_fee_rules')) return { rows: [rule('flora'), rule('elise')] }
        if (sql.includes('WITH current_inspection_assignments AS')) return client.query(sql, params)
        if (sql.includes('FROM personnel_settlement_carry_adjustments')) return { rows: [] }
        if (sql.includes('FROM personnel_workload_claims')) return { rows: [] }
        if (sql.includes('WITH payment_candidates AS')) return { rows: [] }
        if (sql.includes('FROM work_task_action_audits a')) return { rows: [] }
        if (sql.includes('FROM cleaning_tasks t')) return { rows: [] }
        throw new Error(`unexpected query: ${sql.slice(0, 120)}`)
      },
    }

    const first = await buildPersonnelSettlementPreview({ week_start: '2026-10-05' }, executor)
    const flora = first.people.find((person) => person.user_id === 'flora')
    assert.deepStrictEqual(
      flora?.lines.map((line) => ({ date: line.service_date, total: line.total_cents })),
      [{ date: '2026-10-05', total: 15000 }],
      'execution-only work must not create a second inspection day',
    )
    const paidTaskIds = flora?.lines.flatMap((line) => line.work_items.map((item) => item.task_id)).sort()
    assert.deepStrictEqual(paidTaskIds, [
      'legacy-null',
      'missing-new',
      'paired-checkout',
      'preserved-legacy',
      'preserved-legacy-checkin',
      'valid-checkin',
      'valid-checkout',
    ])
    const legalNullWithoutUpload = flora?.lines
      .flatMap((line) => line.work_items)
      .find((item) => item.task_id === 'legacy-null')
    assert.ok(
      legalNullWithoutUpload?.included_in_amount && legalNullWithoutUpload.audit_id == null,
      'NULL scope with an explicit inspector remains payable without upload/audit evidence',
    )
    assert.deepStrictEqual(
      first.people.find((person) => person.user_id === 'elise')?.lines
        .flatMap((line) => line.work_items.map((item) => item.task_id)),
      ['manager-override'],
      'a later manager reassignment must override an earlier automatic preserved assignment',
    )
    assert.ok(
      !paidTaskIds?.includes('manager-override'),
      'the superseded automatic Flora ownership must not survive the manager override',
    )
    assert.ok(!flora?.work_checklist.some((item) => (
      item.task_id === 'execution-mixed' || item.task_id === 'execution-only'
    )), 'password-only tasks must create no inspection checklist or work item')
    assert.deepStrictEqual(
      first.manual_review.warnings.map((warning) => ({
        task: String(warning.task_id || ''),
        reason: warning.reason,
      })).sort((a, b) => (a.task < b.task ? -1 : a.task > b.task ? 1 : 0)),
      [
        { task: 'invalid-checkout-password', reason: 'inspection_scope_invalid_for_task' },
        { task: 'invalid-current', reason: 'inspection_scope_invalid_for_task' },
        { task: 'missing-inspector', reason: 'inspection_inspector_missing' },
        { task: 'preserved-invalid', reason: 'inspection_scope_invalid_for_task' },
      ],
      'unknown scopes and genuinely missing inspectors remain visible without blocking legal NULL defaults',
    )

    await client.query(
      `UPDATE cleaning_tasks SET status='to_inspect', execution_state='active' WHERE id='status-transition'`,
    )
    const reactivated = await buildPersonnelSettlementPreview({ week_start: '2026-10-05' }, executor)
    assert.ok(
      reactivated.people.find((person) => person.user_id === 'flora')?.lines
        .flatMap((line) => line.work_items)
        .some((item) => item.task_id === 'status-transition'),
      'reactivating a valid inspection restores it without creating an extra day rate',
    )

    const pairingPropertyIds = ['paired-same', 'paired-unassigned-explicit', 'paired-conflict', 'paired-deferred']
    for (const propertyId of pairingPropertyIds) {
      await client.query(
        `INSERT INTO properties(id,code,type) VALUES ($1,$2,'一房一卫')`,
        [propertyId, propertyId.toUpperCase()],
      )
    }
    await insertTask(client, {
      id: 'paired-same-checkout', propertyId: 'paired-same', taskType: 'checkout_clean',
      serviceDate: '2026-10-05', scope: null, inspectorId: 'flora',
    })
    await insertTask(client, {
      id: 'paired-same-checkin', propertyId: 'paired-same', taskType: 'checkin_clean',
      serviceDate: '2026-10-05', scope: 'inspect_and_hang', inspectorId: 'flora',
    })
    await insertTask(client, {
      id: 'paired-unassigned-explicit-checkout', propertyId: 'paired-unassigned-explicit', taskType: 'checkout_clean',
      serviceDate: '2026-10-05', scope: null, inspectorId: 'flora',
    })
    await insertTask(client, {
      id: 'paired-unassigned-explicit-checkin', propertyId: 'paired-unassigned-explicit', taskType: 'checkin_clean',
      serviceDate: '2026-10-05', scope: 'inspect_and_hang', inspectorId: null,
    })
    await insertTask(client, {
      id: 'paired-conflict-checkout', propertyId: 'paired-conflict', taskType: 'checkout_clean',
      serviceDate: '2026-10-05', scope: null, inspectorId: 'flora',
    })
    await insertTask(client, {
      id: 'paired-conflict-checkin', propertyId: 'paired-conflict', taskType: 'checkin_clean',
      serviceDate: '2026-10-05', scope: 'inspect_and_hang', inspectorId: 'elise',
    })
    await insertTask(client, {
      id: 'paired-deferred-checkout', propertyId: 'paired-deferred', taskType: 'checkout_clean',
      serviceDate: '2026-10-05', scope: null, inspectorId: 'flora',
    })
    await insertTask(client, {
      id: 'paired-deferred-checkin', propertyId: 'paired-deferred', taskType: 'checkin_clean',
      serviceDate: '2026-10-05', scope: 'inspect_and_hang', inspectorId: 'flora',
      inspectionMode: 'deferred', inspectionDueDate: '2026-10-06',
    })

    const pairing = await buildPersonnelSettlementPreview({ week_start: '2026-10-05' }, executor)
    const pairingWorkItems = pairing.people.flatMap((person) => person.lines.flatMap((line) => (
      line.work_items.map((item) => ({ task_id: item.task_id, date: line.service_date }))
    )))
    assert.ok(pairingWorkItems.some((item) => item.task_id === 'paired-same-checkout'))
    assert.ok(
      !pairingWorkItems.some((item) => item.task_id === 'paired-same-checkin'),
      'same-inspector companion check-in must be suppressed by actual business SQL output',
    )
    assert.ok(pairingWorkItems.some((item) => item.task_id === 'paired-unassigned-explicit-checkout'))
    assert.ok(
      !pairingWorkItems.some((item) => item.task_id === 'paired-unassigned-explicit-checkin')
        && !pairing.manual_review.warnings.some((warning) => (
          warning.task_id === 'paired-unassigned-explicit-checkin'
        )),
      'an explicitly billable but unassigned companion check-in is suppressed without inferring assignee ownership',
    )
    assert.deepStrictEqual(
      pairing.manual_review.warnings
        .filter((warning) => warning.reason === 'inspection_assignment_conflict_for_property_date')
        .map((warning) => String(warning.task_id || ''))
        .filter((taskId) => taskId.startsWith('paired-conflict-'))
        .sort(),
      ['paired-conflict-checkin', 'paired-conflict-checkout'],
      'different explicit inspectors must remain a two-sided conflict',
    )
    assert.ok(
      !pairingWorkItems.some((item) => item.task_id.startsWith('paired-conflict-')),
      'conflicting assignments must not enter an amount',
    )
    assert.deepStrictEqual(
      pairingWorkItems
        .filter((item) => item.task_id.startsWith('paired-deferred-'))
        .sort((a, b) => a.date.localeCompare(b.date)),
      [
        { task_id: 'paired-deferred-checkout', date: '2026-10-05' },
        { task_id: 'paired-deferred-checkin', date: '2026-10-06' },
      ],
      'different effective service dates must stay as separate paid inspection days',
    )

    await client.query('ROLLBACK')
    console.log('personnel settlement MZ-035 isolated SQL integration tests passed')
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
