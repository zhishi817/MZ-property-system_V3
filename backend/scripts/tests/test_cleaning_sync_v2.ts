import assert from 'assert'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { v4 as uuid } from 'uuid'
import { pgPool } from '../../src/dbAdapter'
import { __test_hasManualTaskExecutionRecords, claimTaskPasswordAuthorityFields, confirmTaskPasswordAuthority, ensureCleaningSchemaV2, guestReadyCheckinIdentityChangedFields, reconcilePasswordAuthorityAfterTaskTopologyChange, syncCheckinOldCodeFromPreviousStay, syncCheckoutOldCodeFromCheckinNewCode, syncNextCheckinOldCodeFromSourceOrder, syncOrderToCleaningTasks, backfillCleaningTasks } from '../../src/services/cleaningSync'
import { cleaningSyncJobScope, enqueueCleaningSyncJobTx } from '../../src/services/cleaningSyncJobs'
import { __test_dispatchCleaningSyncJob, __test_syncOrderOptionsForJob, __test_syncScopeForJob } from '../../src/services/cleaningSyncJobsWorker'
import { db } from '../../src/store'
import { buildCleaningTurnoverDisplay, mergeCleaningTurnoverDisplays } from '../../src/lib/cleaningTurnoverDisplay'
import { redactPasswordAuditValues } from '../../src/lib/passwordAudit'
import { warmupPasswordAuthoritySchema } from '../../src/lib/passwordAuthoritySchema'
import { warmupR5TaskRuntimeSchema } from '../../src/lib/r5RequestSchema'

async function fetchTask(orderId: string) {
  return fetchTaskByType(orderId, 'checkout_clean')
}

async function fetchTaskByType(orderId: string, taskType: string) {
  if (pgPool) {
    const r = await pgPool.query(
      `SELECT *
       FROM cleaning_tasks
       WHERE order_id=$1
         AND lower(COALESCE(task_type, type, ''))=lower($2)
       LIMIT 1`,
      [orderId, taskType]
    )
    return r?.rows?.[0] || null
  }
  return (
    (db.cleaningTasks as any[]).find(
      (t: any) => String(t.order_id) === String(orderId) && String((t.task_type ?? t.type) || '').toLowerCase() === String(taskType).toLowerCase(),
    ) || null
  )
}

async function assertScopedQueueIdentity() {
  const rows: Array<{ id: string; order_id: string; action: string; payload_snapshot: any; fingerprint: string; status: string }> = []
  const orderStatuses = new Map<string, string>()
  let crossScopeSideEffects = 0
  const client = {
    async query(sql: string, params: any[] = []) {
      if (sql.includes("SELECT lower(coalesce(status, '')) AS s FROM orders")) {
        return { rows: [{ s: orderStatuses.get(String(params[0])) || 'confirmed' }] }
      }
      if (sql.includes('SELECT id, status') && sql.includes('FROM cleaning_sync_jobs')) {
        const [orderId, action, scope] = params
        return {
          rows: rows
            .filter((row) => row.order_id === orderId && row.action === action && row.status === 'pending' && cleaningSyncJobScope(row.payload_snapshot) === scope)
            .slice(0, 1),
        }
      }
      if (sql.includes('UPDATE cleaning_sync_jobs') && sql.includes('SET fingerprint=$2')) {
        const [id, fingerprint, payloadSnapshot] = params
        const row = rows.find((item) => item.id === id)
        assert.ok(row, 'same-scope update must target the existing queue row')
        row.fingerprint = fingerprint
        row.payload_snapshot = payloadSnapshot
        return { rowCount: 1, rows: [] }
      }
      if (
        (sql.includes("UPDATE cleaning_sync_jobs") && (sql.includes("SET status='skipped'") || sql.includes("SET status='done'"))) ||
        sql.includes('UPDATE cleaning_tasks')
      ) {
        crossScopeSideEffects += 1
        return { rowCount: 0, rows: [] }
      }
      if (sql.includes('INSERT INTO cleaning_sync_jobs')) {
        const [id, orderId, action, fingerprint, payloadSnapshot] = params
        rows.push({ id, order_id: orderId, action, fingerprint, payload_snapshot: payloadSnapshot, status: 'pending' })
        return { rowCount: 1, rows: [] }
      }
      throw new Error(`unexpected_queue_sql:${sql.replace(/\s+/g, ' ').trim().slice(0, 100)}`)
    },
  }

  process.env.CLEANING_SYNC_JOBS_EVENT_ENABLED = 'false'
  const fullThenScoped = 'queue-full-then-scoped'
  const fullFirst = await enqueueCleaningSyncJobTx(client, { order_id: fullThenScoped, action: 'updated', payload_snapshot: { id: fullThenScoped, revision: 'full-1' } })
  const scopedSecond = await enqueueCleaningSyncJobTx(client, { order_id: fullThenScoped, action: 'updated', payload_snapshot: { id: fullThenScoped, revision: 'scoped-1', sync_scope: 'checkin_only' } })
  assert.equal(fullFirst.merged, false)
  assert.equal(scopedSecond.merged, false, 'a checkin-only job must not merge into a pending normal job')
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map((row) => cleaningSyncJobScope(row.payload_snapshot)).sort(), ['checkin_only', 'full'])
  assert.equal(rows.find((row) => cleaningSyncJobScope(row.payload_snapshot) === 'full')?.payload_snapshot.revision, 'full-1')

  const scopedThenFull = 'queue-scoped-then-full'
  const scopedFirst = await enqueueCleaningSyncJobTx(client, { order_id: scopedThenFull, action: 'updated', payload_snapshot: { id: scopedThenFull, revision: 'scoped-1', sync_scope: 'checkin_only' } })
  const fullSecond = await enqueueCleaningSyncJobTx(client, { order_id: scopedThenFull, action: 'updated', payload_snapshot: { id: scopedThenFull, revision: 'full-1' } })
  assert.equal(scopedFirst.merged, false)
  assert.equal(fullSecond.merged, false, 'a normal job must not merge into a pending checkin-only job')
  assert.equal(rows.filter((row) => row.order_id === scopedThenFull).length, 2)
  assert.deepEqual(rows.filter((row) => row.order_id === scopedThenFull).map((row) => cleaningSyncJobScope(row.payload_snapshot)).sort(), ['checkin_only', 'full'])

  const fullMerge = await enqueueCleaningSyncJobTx(client, { order_id: fullThenScoped, action: 'updated', payload_snapshot: { id: fullThenScoped, revision: 'full-2' } })
  assert.equal(fullMerge.merged, true, 'same-scope normal jobs should remain idempotently coalesced')
  assert.equal(rows.length, 4)
  assert.equal(rows.find((row) => row.order_id === fullThenScoped && cleaningSyncJobScope(row.payload_snapshot) === 'full')?.payload_snapshot.revision, 'full-2')
  assert.equal(rows.find((row) => row.order_id === fullThenScoped && cleaningSyncJobScope(row.payload_snapshot) === 'checkin_only')?.payload_snapshot.revision, 'scoped-1')

  const scopedCancelled = 'queue-scoped-cancelled'
  await enqueueCleaningSyncJobTx(client, { order_id: scopedCancelled, action: 'updated', payload_snapshot: { id: scopedCancelled, revision: 'full-1' } })
  orderStatuses.set(scopedCancelled, 'cancelled')
  const cancelledScopedResult = await enqueueCleaningSyncJobTx(client, { order_id: scopedCancelled, action: 'updated', payload_snapshot: { id: scopedCancelled, revision: 'scoped-1', sync_scope: 'checkin_only' } })
  assert.deepEqual(cancelledScopedResult, { id: '', merged: false }, 'a scoped update for a cancelled order must be a no-op')
  assert.equal(rows.filter((row) => row.order_id === scopedCancelled && cleaningSyncJobScope(row.payload_snapshot) === 'full' && row.status === 'pending').length, 1, 'a scoped cancellation no-op must preserve the normal pending job')
  assert.equal(crossScopeSideEffects, 0, 'a scoped cancellation no-op must not skip normal jobs or cancel tasks')

  const scopedDeleted = 'queue-scoped-deleted'
  await enqueueCleaningSyncJobTx(client, { order_id: scopedDeleted, action: 'updated', payload_snapshot: { id: scopedDeleted, revision: 'full-1' } })
  const deletedScopedResult = await enqueueCleaningSyncJobTx(client, { order_id: scopedDeleted, action: 'deleted', payload_snapshot: { id: scopedDeleted, revision: 'scoped-delete', sync_scope: 'checkin_only' } })
  assert.equal(deletedScopedResult.merged, false)
  assert.equal(rows.filter((row) => row.order_id === scopedDeleted && cleaningSyncJobScope(row.payload_snapshot) === 'full' && row.status === 'pending').length, 1, 'a scoped delete must not supersede the normal pending job')
  assert.equal(rows.filter((row) => row.order_id === scopedDeleted && cleaningSyncJobScope(row.payload_snapshot) === 'checkin_only' && row.action === 'deleted' && row.status === 'pending').length, 1, 'the scoped delete remains isolated for the worker no-op path')
  assert.equal(crossScopeSideEffects, 0, 'a scoped delete must not change normal queue state or task projections')

  const migration = readFileSync(resolve(__dirname, '../migrations/20260820_cleaning_sync_job_scope_identity.sql'), 'utf8')
  assert.match(migration, /DROP INDEX IF EXISTS uniq_cleaning_sync_jobs_order_action_active/i)
  assert.match(migration, /payload_snapshot->>'sync_scope'/)
  for (const file of ['../schema.sql', '../schema_neon.sql', '../init_db.ts']) {
    const source = readFileSync(resolve(__dirname, file), 'utf8')
    assert.match(source, /payload_snapshot->>'sync_scope'/, `${file} must initialize the scope-aware active-job identity`)
  }
}

async function main() {
  let auditEvidenceQuerySeen = false
  assert.equal(await __test_hasManualTaskExecutionRecords(
    { id: 'manual-with-audit-only' },
    {
      async query(sql: string) {
        if (sql.includes('FROM work_task_action_audits')) {
          auditEvidenceQuerySeen = true
          return { rows: [{ present: 1 }] }
        }
        return { rows: [] }
      },
    },
  ), true, 'an immutable action audit alone must block automatic manual-task takeover')
  assert.equal(auditEvidenceQuerySeen, true, 'the takeover guard must inspect immutable action audits')

  assert.deepEqual(
    guestReadyCheckinIdentityChangedFields(
      { task_type: 'checkin_clean', checkin_time: '2pm', task_date: '2026-10-11', property_id: 'P1', status: 'pending', execution_state: 'active' },
      { task_type: 'checkin_clean', checkin_time: '3pm', task_date: '2026-10-12', property_id: 'P2', status: 'cancelled', execution_state: 'cancelled' },
    ),
    ['checkin_time', 'status', 'execution_state', 'task_date', 'property_id'],
    'sync must identify every changed check-in field that invalidates the guest-ready generation',
  )
  assert.deepEqual(
    guestReadyCheckinIdentityChangedFields(
      { task_type: 'checkout_clean', task_date: '2026-10-11' },
      { task_type: 'checkout_clean', task_date: '2026-10-12' },
    ),
    [],
    'checkout-only sync changes are unrelated to guest-ready authority',
  )

  const o1 = uuid()
  const o2 = uuid()
  const o3 = uuid()
  const o4 = uuid()
  const o5 = uuid()
  const o6 = uuid()
  const o7 = uuid()
  const o8 = uuid()
  const o9 = uuid()
  const o10 = uuid()
  const o11 = uuid()
  const o12 = uuid()
  const o13 = uuid()
  const o14 = uuid()
  const o15 = uuid()
  const o16 = uuid()
  const o17 = uuid()
  const o18 = uuid()
  const o19 = uuid()
  const o20 = uuid()
  const o21 = uuid()
  const o22 = uuid()
  const o23 = uuid()
  const o24 = uuid()
  const turnoverScopeJobId = uuid()
  const manualCheckin = uuid()
  const manualCheckout = uuid()
  const manualExtraCheckin = uuid()
  const manualCheckoutInProgress = uuid()
  const manualCheckinZeroNights = uuid()
  const manualLinkedCheckout = uuid()
  const manualAmbiguousA = uuid()
  const manualAmbiguousB = uuid()
  const manualExecuted = uuid()
  const manualIdentityConflict = uuid()
  const manualCompetingOrder = uuid()
  const manualStaleOfficial = uuid()
  const manualRelinkCheckoutFirst = uuid()
  const manualRelinkCheckinFirst = uuid()
  const manualRelinkCheckoutSecond = uuid()
  const manualRelinkCheckinSecond = uuid()
  const manualAmbiguousRelinkCheckout = uuid()
  const manualAmbiguousRelinkCheckinA = uuid()
  const manualAmbiguousRelinkCheckinB = uuid()

  await assertScopedQueueIdentity()

  assert.equal(__test_syncScopeForJob({ payload_snapshot: { sync_scope: 'checkin_only' } }), 'checkin_only', 'worker must forward the explicit checkin-only queue scope')
  assert.equal(__test_syncScopeForJob({ payload_snapshot: { sync_scope: 'unknown' } }), 'full', 'unknown queue scope must retain the existing full-sync default')
  assert.deepEqual(
    __test_syncOrderOptionsForJob({ action: 'deleted', payload_snapshot: { sync_scope: 'checkin_only' } }),
    { scope: 'checkin_only', deleted: true },
    'a scoped delete job must remain a no-op delete path instead of creating a checkin task',
  )
  const deletedScopedWorkerCalls: Array<{ orderId: string; opts: any }> = []
  await __test_dispatchCleaningSyncJob(
    { id: 'scoped-delete-job', order_id: 'scoped-delete-order', action: 'deleted', payload_snapshot: { sync_scope: 'checkin_only' } },
    { test_client: true },
    async (orderId, opts) => { deletedScopedWorkerCalls.push({ orderId, opts }) },
  )
  assert.deepEqual(
    deletedScopedWorkerCalls,
    [{ orderId: 'scoped-delete-order', opts: { deleted: true, client: { test_client: true }, jobId: 'scoped-delete-job', scope: 'checkin_only' } }],
    'worker delete dispatch must retain deleted=true so the scoped service path is a no-op',
  )

  const orders = [
    { id: o1, property_id: 'P_TEST_A', checkin: '2026-02-10', checkout: '2026-02-12', nights: 2, status: 'confirmed', confirmation_code: `TEST_SYNC_${o1.slice(0, 8)}` },
    { id: o2, property_id: 'P_TEST_B', checkin: '2026-02-11', checkout: '2026-02-13', nights: 2, status: 'confirmed', confirmation_code: `TEST_SYNC_${o2.slice(0, 8)}` },
    { id: o3, property_id: 'P_TEST_C', checkin: '2026-02-12', checkout: '2026-02-14', nights: 2, status: 'confirmed', confirmation_code: `TEST_SYNC_${o3.slice(0, 8)}` },
    { id: o4, property_id: 'P_TEST_D', checkin: '2026-02-18', checkout: '2026-02-21', nights: 3, status: 'confirmed', confirmation_code: `TEST_SYNC_${o4.slice(0, 8)}` },
    { id: o5, property_id: 'P_TEST_E', checkin: '2026-02-24', checkout: '2026-02-28', nights: 4, status: 'confirmed', confirmation_code: `TEST_SYNC_${o5.slice(0, 8)}` },
    { id: o6, property_id: 'P_TEST_PASSWORD_CHAIN', checkin: '2026-02-01', checkout: '2026-02-03', nights: 2, status: 'confirmed', confirmation_code: `TEST_SYNC_${o6.slice(0, 8)}` },
    { id: o7, property_id: 'P_TEST_PASSWORD_CHAIN', checkin: '2026-02-05', checkout: '2026-02-08', nights: 3, status: 'confirmed', confirmation_code: `TEST_SYNC_${o7.slice(0, 8)}` },
    { id: o8, property_id: 'P_TEST_CHECKIN_SCOPE', checkin: null, checkout: '2026-02-26', nights: 1, status: 'confirmed', confirmation_code: `TEST_SYNC_${o8.slice(0, 8)}` },
    { id: o9, property_id: 'P_TEST_TURNOVER_SCOPE', checkin: '2026-03-01', checkout: '2026-03-03', nights: 2, status: 'confirmed', confirmation_code: `TEST_SYNC_${o9.slice(0, 8)}` },
    { id: o10, property_id: 'P_TEST_TURNOVER_SCOPE', checkin: '2026-03-05', checkout: '2026-03-07', nights: 2, status: 'confirmed', confirmation_code: `TEST_SYNC_${o10.slice(0, 8)}` },
    { id: o11, property_id: 'P_TEST_AMBIG', checkin: '2026-03-10', checkout: '2026-03-12', nights: 2, status: 'confirmed', confirmation_code: `TEST_SYNC_${o11.slice(0, 8)}` },
    { id: o12, property_id: 'P_TEST_EXECUTED', checkin: '2026-03-13', checkout: '2026-03-15', nights: 2, status: 'confirmed', confirmation_code: `TEST_SYNC_${o12.slice(0, 8)}` },
    { id: o13, property_id: 'P_TEST_IDENTITY_CONFLICT', checkin: '2026-03-16', checkout: '2026-03-18', nights: 2, status: 'confirmed', confirmation_code: `TEST_SYNC_${o13.slice(0, 8)}` },
    { id: o14, property_id: 'P_TEST_COMPETING_ORDERS', checkin: '2026-03-20', checkout: '2026-03-22', nights: 2, status: 'confirmed', confirmation_code: `TEST_SYNC_${o14.slice(0, 8)}` },
    { id: o15, property_id: 'P_TEST_COMPETING_ORDERS', checkin: '2026-03-20', checkout: '2026-03-23', nights: 3, status: 'confirmed', confirmation_code: `TEST_SYNC_${o15.slice(0, 8)}` },
    { id: o16, property_id: 'P_TEST_STALE_OFFICIAL', checkin: '2026-03-22', checkout: '2026-03-24', nights: 2, status: 'confirmed', confirmation_code: `TEST_SYNC_${o16.slice(0, 8)}` },
    { id: o17, property_id: 'P_TEST_RELINK_CHECKOUT_FIRST', checkin: '2026-03-24', checkout: '2026-03-26', nights: 2, status: 'confirmed', confirmation_code: `TEST_SYNC_${o17.slice(0, 8)}` },
    { id: o18, property_id: 'P_TEST_RELINK_CHECKOUT_FIRST', checkin: '2026-03-26', checkout: '2026-03-29', nights: 3, status: 'confirmed', confirmation_code: `TEST_SYNC_${o18.slice(0, 8)}` },
    { id: o19, property_id: 'P_TEST_RELINK_CHECKIN_FIRST', checkin: '2026-04-06', checkout: '2026-04-09', nights: 3, status: 'confirmed', confirmation_code: `TEST_SYNC_${o19.slice(0, 8)}` },
    { id: o20, property_id: 'P_TEST_RELINK_CHECKIN_FIRST', checkin: '2026-04-03', checkout: '2026-04-06', nights: 3, status: 'confirmed', confirmation_code: `TEST_SYNC_${o20.slice(0, 8)}` },
    { id: o21, property_id: 'P_TEST_RELINK_AMBIGUOUS', checkin: '2026-04-11', checkout: '2026-04-12', nights: 1, status: 'confirmed', confirmation_code: `TEST_SYNC_${o21.slice(0, 8)}` },
    { id: o22, property_id: 'P_TEST_PASSWORD_CREATION', checkin: '2026-04-20', checkout: '2026-04-23', nights: 3, status: 'confirmed', confirmation_code: `TEST_SYNC_${o22.slice(0, 8)}` },
    { id: o23, property_id: 'P_TEST_PASSWORD_CREATION', checkin: '2026-04-25', checkout: '2026-04-28', nights: 3, status: 'confirmed', confirmation_code: `TEST_SYNC_${o23.slice(0, 8)}` },
    { id: o24, property_id: 'P_TEST_PASSWORD_CREATION', checkin: '2026-05-01', checkout: '2026-05-04', nights: 3, status: 'confirmed', confirmation_code: `TEST_SYNC_${o24.slice(0, 8)}` },
  ]

  const orderIds = orders.map((order) => order.id)

  if (pgPool) {
    await ensureCleaningSchemaV2()
    await warmupPasswordAuthoritySchema()
    await warmupR5TaskRuntimeSchema()
    await pgPool.query('DELETE FROM cleaning_sync_logs WHERE order_id = ANY($1)', [orderIds])
    await pgPool.query('DELETE FROM cleaning_tasks WHERE order_id = ANY($1) OR id = ANY($2)', [orderIds, [manualCheckin, manualCheckout, manualExtraCheckin, manualCheckoutInProgress, manualCheckinZeroNights, manualLinkedCheckout, manualAmbiguousA, manualAmbiguousB, manualExecuted, manualIdentityConflict, manualCompetingOrder, manualStaleOfficial, manualRelinkCheckoutFirst, manualRelinkCheckinFirst, manualRelinkCheckoutSecond, manualRelinkCheckinSecond, manualAmbiguousRelinkCheckout, manualAmbiguousRelinkCheckinA, manualAmbiguousRelinkCheckinB]])
    await pgPool.query('DELETE FROM orders WHERE id = ANY($1)', [orderIds])
    for (const o of orders) {
      await pgPool.query(
        `INSERT INTO orders(id, property_id, checkin, checkout, nights, status, confirmation_code)
         VALUES($1,$2,$3::date,$4::date,$5,$6,$7)`,
        [o.id, o.property_id, o.checkin, o.checkout, o.nights, o.status, o.confirmation_code]
      )
    }
  } else {
    ;(db.orders as any[]) = []
    ;(db.cleaningTasks as any[]) = []
    for (const o of orders) {
      ;(db.orders as any[]).push({ ...o })
    }
  }

  await syncOrderToCleaningTasks(o1)
  const t1 = await fetchTask(o1)
  assert.ok(t1, 'should create task for confirmed order')
  assert.equal(String(t1.task_date).slice(0, 10), '2026-02-12')
  const t1i = await fetchTaskByType(o1, 'checkin_clean')
  assert.ok(t1i, 'should create checkin task for confirmed order')
  assert.equal(String(t1i.task_date).slice(0, 10), '2026-02-10')
  assert.equal(t1i.old_code == null ? null : String(t1i.old_code), null, 'a checkin without a prior password source should remain blank')

  await syncOrderToCleaningTasks(o9)
  await syncOrderToCleaningTasks(o10)
  if (pgPool) {
    await pgPool.query(
      `UPDATE cleaning_tasks
       SET inspection_scope='password_only', inspection_mode='deferred', inspection_due_date='2026-03-06'::date,
           status='assigned', assignee_id='TURNOVER-CLEANER', cleaner_id='TURNOVER-CLEANER', inspector_id='TURNOVER-INSPECTOR'
       WHERE order_id=$1 AND lower(COALESCE(task_type, type, ''))='checkin_clean'`,
      [o10],
    )
    await pgPool.query(`UPDATE orders SET checkin='2026-03-03'::date WHERE id=$1`, [o10])
  } else {
    const incomingCheckin = await fetchTaskByType(o10, 'checkin_clean')
    if (incomingCheckin) Object.assign(incomingCheckin, {
      inspection_scope: 'password_only',
      inspection_mode: 'deferred',
      inspection_due_date: '2026-03-06',
      status: 'assigned',
      assignee_id: 'TURNOVER-CLEANER',
      cleaner_id: 'TURNOVER-CLEANER',
      inspector_id: 'TURNOVER-INSPECTOR',
    })
    const incomingOrder = (db.orders as any[]).find((item: any) => String(item.id) === o10)
    if (incomingOrder) incomingOrder.checkin = '2026-03-03'
  }
  assert.equal(String((await fetchTaskByType(o10, 'checkin_clean'))?.inspection_scope), 'password_only', 'a pure checkin may keep password-only scope')
  await syncOrderToCleaningTasks(o10, { jobId: turnoverScopeJobId })
  const normalizedTurnoverCheckin = await fetchTaskByType(o10, 'checkin_clean')
  assert.equal(String(normalizedTurnoverCheckin?.inspection_scope), 'inspect_and_hang', 'moving a checkin onto an active checkout must normalize the turnover scope')
  assert.equal(String(normalizedTurnoverCheckin?.task_date).slice(0, 10), '2026-03-03', 'date sync must still move the checkin onto the turnover date')
  assert.equal(String(normalizedTurnoverCheckin?.inspection_mode), 'deferred', 'scope normalization must not change the inspection mode')
  assert.equal(String(normalizedTurnoverCheckin?.inspection_due_date).slice(0, 10), '2026-03-06', 'scope normalization must not change the inspection due date')
  assert.equal(String(normalizedTurnoverCheckin?.status), 'assigned', 'scope normalization must not change status')
  assert.equal(String(normalizedTurnoverCheckin?.cleaner_id), 'TURNOVER-CLEANER', 'scope normalization must not change cleaner assignment')
  assert.equal(String(normalizedTurnoverCheckin?.inspector_id), 'TURNOVER-INSPECTOR', 'scope normalization must not change inspector assignment')
  assert.equal(String((await fetchTaskByType(o9, 'checkout_clean'))?.inspection_scope), 'inspect_and_hang', 'turnover normalization must update the paired checkout too')
  if (pgPool) {
    const auditActions = (await pgPool.query(
      `SELECT action
       FROM cleaning_sync_logs
       WHERE job_id=$1 AND task_id=$2
       ORDER BY created_at, action`,
      [turnoverScopeJobId, String(normalizedTurnoverCheckin?.id || '')],
    )).rows.map((row: any) => String(row.action))
    assert.ok(auditActions.includes('updated'), 'date sync must keep its ordinary task update audit')
    assert.ok(auditActions.includes('scope_normalized'), 'scope normalization must have a distinct non-colliding audit record')
  }

  await syncOrderToCleaningTasks(o8)
  const o8CheckoutBeforeRepair = await fetchTask(o8)
  assert.ok(o8CheckoutBeforeRepair, 'a legacy incomplete order can have only a checkout task')
  assert.equal(await fetchTaskByType(o8, 'checkin_clean'), null, 'a missing checkin date must not create a checkin task')
  const o8MissingDateRepair = await syncOrderToCleaningTasks(o8, { scope: 'checkin_only' })
  assert.equal(o8MissingDateRepair.action, 'no_change', 'checkin-only repair must not cancel or create work without a checkin date')
  if (pgPool) {
    await pgPool.query(`UPDATE cleaning_tasks SET assignee_id='CHECKOUT_ASSIGNEE', status='assigned' WHERE id=$1`, [String(o8CheckoutBeforeRepair.id)])
    await pgPool.query(`UPDATE orders SET checkin=$2::date, checkout=$3::date, nights=3 WHERE id=$1`, [o8, '2026-02-25', '2026-02-28'])
  } else {
    const checkout = await fetchTask(o8)
    if (checkout) { checkout.assignee_id = 'CHECKOUT_ASSIGNEE'; checkout.status = 'assigned' }
    const order = (db.orders as any[]).find((x: any) => String(x.id) === o8)
    if (order) { order.checkin = '2026-02-25'; order.checkout = '2026-02-28'; order.nights = 3 }
  }
  const o8CheckinRepair = await syncOrderToCleaningTasks(o8, { scope: 'checkin_only' })
  assert.equal(o8CheckinRepair.action, 'created', 'checkin-only repair should create the missing checkin task')
  const o8Checkin = await fetchTaskByType(o8, 'checkin_clean')
  const o8CheckoutAfterRepair = await fetchTask(o8)
  assert.ok(o8Checkin)
  assert.equal(String(o8Checkin.task_date).slice(0, 10), '2026-02-25')
  assert.equal(String(o8CheckoutAfterRepair?.task_date).slice(0, 10), '2026-02-26', 'checkin-only repair must not move the existing checkout task')
  assert.equal(String(o8CheckoutAfterRepair?.status), 'assigned', 'checkin-only repair must not overwrite the existing checkout task')
  if (pgPool) {
    await pgPool.query(`UPDATE cleaning_tasks SET old_code='MANUAL_OLD_CODE', scheduled_at=now(), status='pending', locked=false, auto_sync_enabled=true WHERE id=$1`, [String(o8Checkin.id)])
    await pgPool.query(`UPDATE orders SET checkin=$2::date WHERE id=$1`, [o8, '2026-02-24'])
  } else {
    const checkin = await fetchTaskByType(o8, 'checkin_clean')
    if (checkin) { checkin.old_code = 'MANUAL_OLD_CODE'; checkin.scheduled_at = '2026-02-25T09:00:00.000Z'; checkin.status = 'pending'; checkin.locked = false; checkin.auto_sync_enabled = true }
    const order = (db.orders as any[]).find((x: any) => String(x.id) === o8)
    if (order) order.checkin = '2026-02-24'
  }
  const o8ManualExistingSkip = await syncOrderToCleaningTasks(o8, { scope: 'checkin_only' })
  assert.equal(o8ManualExistingSkip.action, 'skipped_protected', 'a pending, unassigned manually edited checkin task must not be overwritten')
  const o8ManualExisting = await fetchTaskByType(o8, 'checkin_clean')
  assert.equal(String(o8ManualExisting?.task_date).slice(0, 10), '2026-02-25')
  assert.equal(String(o8ManualExisting?.old_code), 'MANUAL_OLD_CODE')
  assert.ok(o8ManualExisting?.scheduled_at, 'a manually scheduled checkin task must remain scheduled')

  const o8CheckinRepeat = await syncOrderToCleaningTasks(o8, { scope: 'checkin_only' })
  assert.equal(o8CheckinRepeat.action, 'skipped_protected', 'repeating a scoped repair must preserve an existing checkin task')

  if (pgPool) {
    await pgPool.query(`UPDATE cleaning_tasks SET assignee_id='CHECKIN_ASSIGNEE', status='assigned' WHERE id=$1`, [String(o8Checkin.id)])
    await pgPool.query(`UPDATE orders SET checkin=$2::date WHERE id=$1`, [o8, '2026-02-24'])
  } else {
    const checkin = await fetchTaskByType(o8, 'checkin_clean')
    if (checkin) { checkin.assignee_id = 'CHECKIN_ASSIGNEE'; checkin.status = 'assigned' }
    const order = (db.orders as any[]).find((x: any) => String(x.id) === o8)
    if (order) order.checkin = '2026-02-24'
  }
  const o8AssignedSkip = await syncOrderToCleaningTasks(o8, { scope: 'checkin_only' })
  assert.equal(o8AssignedSkip.action, 'skipped_protected', 'assigned checkin task must be protected from a scoped repair')
  assert.equal(String((await fetchTaskByType(o8, 'checkin_clean'))?.task_date).slice(0, 10), '2026-02-25')

  if (pgPool) {
    await pgPool.query(`UPDATE cleaning_tasks SET assignee_id=NULL, status='pending', locked=true WHERE id=$1`, [String(o8Checkin.id)])
    await pgPool.query(`UPDATE orders SET checkin=$2::date WHERE id=$1`, [o8, '2026-02-23'])
  } else {
    const checkin = await fetchTaskByType(o8, 'checkin_clean')
    if (checkin) { checkin.assignee_id = null; checkin.status = 'pending'; checkin.locked = true }
    const order = (db.orders as any[]).find((x: any) => String(x.id) === o8)
    if (order) order.checkin = '2026-02-23'
  }
  const o8LockedSkip = await syncOrderToCleaningTasks(o8, { scope: 'checkin_only' })
  assert.equal(o8LockedSkip.action, 'skipped_protected', 'locked checkin task must be protected from a scoped repair')
  assert.equal(String((await fetchTaskByType(o8, 'checkin_clean'))?.task_date).slice(0, 10), '2026-02-25')

  if (pgPool) {
    await pgPool.query(`UPDATE cleaning_tasks SET locked=false, auto_sync_enabled=false WHERE id=$1`, [String(o8Checkin.id)])
    await pgPool.query(`UPDATE orders SET checkin=$2::date WHERE id=$1`, [o8, '2026-02-22'])
  } else {
    const checkin = await fetchTaskByType(o8, 'checkin_clean')
    if (checkin) { checkin.locked = false; checkin.auto_sync_enabled = false }
    const order = (db.orders as any[]).find((x: any) => String(x.id) === o8)
    if (order) order.checkin = '2026-02-22'
  }
  const o8AutoSyncSkip = await syncOrderToCleaningTasks(o8, { scope: 'checkin_only' })
  assert.equal(o8AutoSyncSkip.action, 'skipped_protected', 'auto-sync-disabled checkin task must be protected from a scoped repair')
  assert.equal(String((await fetchTaskByType(o8, 'checkin_clean'))?.task_date).slice(0, 10), '2026-02-25')

  if (pgPool) {
    await pgPool.query(`UPDATE cleaning_tasks SET auto_sync_enabled=true, status='completed', finished_at=now() WHERE id=$1`, [String(o8Checkin.id)])
    await pgPool.query(`UPDATE orders SET checkin=$2::date WHERE id=$1`, [o8, '2026-02-21'])
  } else {
    const checkin = await fetchTaskByType(o8, 'checkin_clean')
    if (checkin) { checkin.auto_sync_enabled = true; checkin.status = 'completed'; checkin.finished_at = new Date().toISOString() }
    const order = (db.orders as any[]).find((x: any) => String(x.id) === o8)
    if (order) order.checkin = '2026-02-21'
  }
  const o8CompletedSkip = await syncOrderToCleaningTasks(o8, { scope: 'checkin_only' })
  assert.equal(o8CompletedSkip.action, 'skipped_protected', 'completed checkin task must be protected from a scoped repair')
  assert.equal(String((await fetchTaskByType(o8, 'checkin_clean'))?.task_date).slice(0, 10), '2026-02-25')

  await syncOrderToCleaningTasks(o6)
  if (pgPool) {
    await pgPool.query(`UPDATE cleaning_tasks SET new_code='2468', new_code_authority_status='manual_confirmed' WHERE order_id=$1 AND lower(COALESCE(task_type, type, ''))='checkin_clean'`, [o6])
    await pgPool.query(`UPDATE cleaning_tasks SET old_code='1357', old_code_authority_status='manual_confirmed' WHERE order_id=$1 AND lower(COALESCE(task_type, type, ''))='checkout_clean'`, [o6])
  } else {
    const previousCheckin = await fetchTaskByType(o6, 'checkin_clean')
    const previousCheckout = await fetchTaskByType(o6, 'checkout_clean')
    if (previousCheckin) { previousCheckin.new_code = '2468'; previousCheckin.new_code_authority_status = 'manual_confirmed' }
    if (previousCheckout) { previousCheckout.old_code = '1357'; previousCheckout.old_code_authority_status = 'manual_confirmed' }
  }
  await syncOrderToCleaningTasks(o7)
  const incomingCheckin = await fetchTaskByType(o7, 'checkin_clean')
  assert.ok(incomingCheckin, 'should create the incoming checkin task')
  assert.equal(incomingCheckin.old_code == null ? null : String(incomingCheckin.old_code), null, 'an arrival task must not inherit a previous checkout old_code')

  if (pgPool) {
    await pgPool.query(`UPDATE cleaning_tasks SET old_code=NULL WHERE order_id=$1 AND lower(COALESCE(task_type, type, ''))='checkout_clean'`, [o6])
    await pgPool.query(`UPDATE cleaning_tasks SET new_code=NULL WHERE order_id=$1 AND lower(COALESCE(task_type, type, ''))='checkin_clean'`, [o6])
  } else {
    const previousCheckin = await fetchTaskByType(o6, 'checkin_clean')
    const previousCheckout = await fetchTaskByType(o6, 'checkout_clean')
    if (previousCheckin) previousCheckin.new_code = null
    if (previousCheckout) previousCheckout.old_code = null
  }
  await syncCheckinOldCodeFromPreviousStay({ orderId: o7 })
  const clearedIncomingCheckin = await fetchTaskByType(o7, 'checkin_clean')
  assert.equal(clearedIncomingCheckin?.old_code == null ? null : String(clearedIncomingCheckin.old_code), null, 'an invalidated prior source should clear a previously auto-filled checkin old_code')

  if (pgPool) {
    await pgPool.query(`UPDATE cleaning_tasks SET new_code='2468', new_code_authority_status='manual_confirmed' WHERE order_id=$1 AND lower(COALESCE(task_type, type, ''))='checkin_clean'`, [o6])
    await pgPool.query(`UPDATE cleaning_tasks SET old_code=NULL, auto_sync_enabled=true WHERE order_id=$1 AND lower(COALESCE(task_type, type, ''))='checkin_clean'`, [o7])
  } else {
    const previousCheckin = await fetchTaskByType(o6, 'checkin_clean')
    const previousCheckout = await fetchTaskByType(o6, 'checkout_clean')
    const targetCheckin = await fetchTaskByType(o7, 'checkin_clean')
    if (previousCheckin) { previousCheckin.new_code = '2468'; previousCheckin.new_code_authority_status = 'manual_confirmed' }
    if (previousCheckout) previousCheckout.old_code = null
    if (targetCheckin) { targetCheckin.old_code = null; targetCheckin.auto_sync_enabled = true }
  }
  await syncCheckinOldCodeFromPreviousStay({ orderId: o7 })
  const fallbackIncomingCheckin = await fetchTaskByType(o7, 'checkin_clean')
  assert.equal(fallbackIncomingCheckin.old_code == null ? null : String(fallbackIncomingCheckin.old_code), null, 'an arrival task must not fall back to any earlier stay password')

  if (pgPool) {
    await pgPool.query(`UPDATE cleaning_tasks SET new_code=NULL WHERE order_id=$1 AND lower(COALESCE(task_type, type, ''))='checkin_clean'`, [o6])
  } else {
    const previousCheckin = await fetchTaskByType(o6, 'checkin_clean')
    if (previousCheckin) previousCheckin.new_code = null
  }
  await syncCheckinOldCodeFromPreviousStay({ orderId: o7 })
  const clearedFallbackIncomingCheckin = await fetchTaskByType(o7, 'checkin_clean')
  assert.equal(clearedFallbackIncomingCheckin?.old_code == null ? null : String(clearedFallbackIncomingCheckin.old_code), null, 'an invalidated fallback checkin new_code should clear a previously auto-filled old_code')

  if (pgPool) {
    await pgPool.query(`UPDATE cleaning_tasks SET old_code='manual-old-code', auto_sync_enabled=false WHERE order_id=$1 AND lower(COALESCE(task_type, type, ''))='checkin_clean'`, [o7])
  } else {
    const targetCheckin = await fetchTaskByType(o7, 'checkin_clean')
    if (targetCheckin) { targetCheckin.old_code = 'manual-old-code'; targetCheckin.auto_sync_enabled = false }
  }
  const lockedWithoutSource = await syncCheckinOldCodeFromPreviousStay({ orderId: o7 })
  assert.equal(lockedWithoutSource.action, 'updated', 'auto_sync_enabled=false alone must not preserve an unaudited password')
  const lockedWithoutSourceCheckin = await fetchTaskByType(o7, 'checkin_clean')
  assert.equal(lockedWithoutSourceCheckin?.old_code == null ? null : String(lockedWithoutSourceCheckin.old_code), null)

  if (pgPool) {
    await pgPool.query(`UPDATE cleaning_tasks SET old_code='manual-old-code', old_code_authority_status='manual_confirmed', old_code_source_field='manual', auto_sync_enabled=false WHERE order_id=$1 AND lower(COALESCE(task_type, type, ''))='checkin_clean'`, [o7])
    await pgPool.query(`UPDATE cleaning_tasks SET old_code='9753', old_code_authority_status='manual_confirmed' WHERE order_id=$1 AND lower(COALESCE(task_type, type, ''))='checkout_clean'`, [o6])
  } else {
    const previousCheckout = await fetchTaskByType(o6, 'checkout_clean')
    const targetCheckin = await fetchTaskByType(o7, 'checkin_clean')
    if (previousCheckout) { previousCheckout.old_code = '9753'; previousCheckout.old_code_authority_status = 'manual_confirmed' }
    if (targetCheckin) { targetCheckin.old_code = 'manual-old-code'; targetCheckin.old_code_authority_status = 'manual_confirmed'; targetCheckin.old_code_source_field = 'manual'; targetCheckin.auto_sync_enabled = false }
  }
  const lockedCheckinPassword = await syncCheckinOldCodeFromPreviousStay({ orderId: o7 })
  assert.equal(lockedCheckinPassword.action, 'skipped_locked', 'a legacy manually confirmed checkin old_code is retained in storage but is no longer a display/write field')
  const lockedIncomingCheckin = await fetchTaskByType(o7, 'checkin_clean')
  assert.equal(String(lockedIncomingCheckin.old_code), 'manual-old-code')

  const pureCheckinDisplay = buildCleaningTurnoverDisplay({
    propertyId: 'P_TEST_PASSWORD_CHAIN',
    taskDate: '2026-02-05',
    checkinTask: { id: 'pure-checkin', order_id: 'incoming', task_type: 'checkin_clean', task_date: '2026-02-05', old_code: '1357', old_code_authority_status: 'manual_confirmed', old_code_source_field: 'manual', new_code: '2468' },
  })
  assert.equal(pureCheckinDisplay.old_code, null, 'a pure checkin card must never project old_code, including legacy manual metadata')
  const mergedPureCheckinDisplay = mergeCleaningTurnoverDisplays([pureCheckinDisplay])
  assert.equal(mergedPureCheckinDisplay?.old_code, null, 'a merged pure checkin display must not restore a hidden old_code')

  if (pgPool) {
    await pgPool.query(`UPDATE cleaning_tasks SET new_code='9753', new_code_authority_status='manual_confirmed' WHERE order_id=$1 AND task_type='checkin_clean'`, [o1])
    await pgPool.query(`UPDATE cleaning_tasks SET old_code=NULL WHERE order_id=$1 AND task_type='checkout_clean'`, [o1])
  } else {
    const checkinTask = (db.cleaningTasks as any[]).find((x: any) => String(x.order_id) === o1 && String(x.task_type) === 'checkin_clean')
    const checkoutTask = (db.cleaningTasks as any[]).find((x: any) => String(x.order_id) === o1 && String(x.task_type) === 'checkout_clean')
    if (checkinTask) { checkinTask.new_code = '9753'; checkinTask.new_code_authority_status = 'manual_confirmed' }
    if (checkoutTask) checkoutTask.old_code = null
  }
  await syncOrderToCleaningTasks(o1)
  const sameOrderPasswordResult = await syncCheckoutOldCodeFromCheckinNewCode({ orderId: o1 })
  const t1Password = await fetchTask(o1)
  assert.equal(String(t1Password.old_code), '9753', `checkout old_code should follow checkin new_code for existing orders (reason=${String(sameOrderPasswordResult.reason || '')})`)

  if (pgPool) {
    await pgPool.query(`UPDATE cleaning_tasks SET new_code=NULL WHERE order_id=$1 AND task_type='checkin_clean'`, [o1])
  } else {
    const checkinTask = (db.cleaningTasks as any[]).find((x: any) => String(x.order_id) === o1 && String(x.task_type) === 'checkin_clean')
    if (checkinTask) checkinTask.new_code = null
  }
  const clearedSourceResult = await syncCheckoutOldCodeFromCheckinNewCode({ orderId: o1 })
  const clearedSourceCheckout = await fetchTask(o1)
  assert.equal(clearedSourceResult.reason, 'source_missing')
  assert.equal(clearedSourceCheckout.old_code, null, 'clearing the same-order checkin new_code must clear the automatic checkout old_code')
  assert.equal(String(clearedSourceCheckout.old_code_source_order_id), o1, 'a cleared source retains exact same-order provenance for review')

  if (pgPool) {
    await pgPool.query(`UPDATE cleaning_tasks SET task_type=NULL WHERE order_id=$1`, [o1])
    await pgPool.query(`UPDATE cleaning_tasks SET new_code='8642', new_code_authority_status='manual_confirmed' WHERE order_id=$1 AND type='checkin_clean'`, [o1])
    await pgPool.query(`UPDATE cleaning_tasks SET old_code=NULL WHERE order_id=$1 AND type='checkout_clean'`, [o1])
  } else {
    const checkinTask = (db.cleaningTasks as any[]).find((x: any) => String(x.order_id) === o1 && String(x.type) === 'checkin_clean')
    const checkoutTask = (db.cleaningTasks as any[]).find((x: any) => String(x.order_id) === o1 && String(x.type) === 'checkout_clean')
    if (checkinTask) {
      checkinTask.task_type = null
      checkinTask.new_code = '8642'
      checkinTask.new_code_authority_status = 'manual_confirmed'
    }
    if (checkoutTask) {
      checkoutTask.task_type = null
      checkoutTask.old_code = null
    }
  }
  await syncCheckoutOldCodeFromCheckinNewCode({ orderId: o1 })
  const legacyTaskTypePassword = await fetchTask(o1)
  assert.equal(String(legacyTaskTypePassword.old_code), '8642', 'legacy type-only tasks should still sync checkin new_code to checkout old_code')

  await syncOrderToCleaningTasks(o22, { scope: 'checkin_only' })
  assert.equal(await fetchTaskByType(o22, 'checkout_clean'), null, 'saving a checkin must not pre-create a checkout task')
  if (pgPool) {
    await pgPool.query(`UPDATE cleaning_tasks SET new_code='CREATION_A', new_code_authority_status='manual_confirmed' WHERE order_id=$1 AND lower(COALESCE(task_type, type, ''))='checkin_clean'`, [o22])
  } else {
    const checkin = await fetchTaskByType(o22, 'checkin_clean')
    if (checkin) { checkin.new_code = 'CREATION_A'; checkin.new_code_authority_status = 'manual_confirmed' }
  }
  assert.equal((await syncCheckoutOldCodeFromCheckinNewCode({ orderId: o22 })).reason, 'target_missing_or_terminal')
  await syncOrderToCleaningTasks(o22)
  assert.equal(String((await fetchTaskByType(o22, 'checkout_clean'))?.old_code), 'CREATION_A', 'a later-created checkout must initialize from the latest same-order checkin new_code')

  if (pgPool) {
    await pgPool.query(
      `INSERT INTO cleaning_tasks(id, order_id, property_id, task_type, type, task_date, date, status, source, execution_state, auto_sync_enabled)
       VALUES($1,$2,'P_TEST_PASSWORD_CREATION','checkout_clean','checkout_clean','2026-04-28'::date,'2026-04-28'::date,'pending','auto','active',true)`,
      [uuid(), o23],
    )
  } else {
    ;(db.cleaningTasks as any[]).push({ id: uuid(), order_id: o23, property_id: 'P_TEST_PASSWORD_CREATION', task_type: 'checkout_clean', type: 'checkout_clean', task_date: '2026-04-28', date: '2026-04-28', status: 'pending', source: 'auto', execution_state: 'active', auto_sync_enabled: true })
  }
  await syncOrderToCleaningTasks(o23, { scope: 'checkin_only' })
  if (pgPool) {
    await pgPool.query(`UPDATE cleaning_tasks SET new_code='CREATION_B', new_code_authority_status='manual_confirmed' WHERE order_id=$1 AND lower(COALESCE(task_type, type, ''))='checkin_clean'`, [o23])
  } else {
    const checkin = await fetchTaskByType(o23, 'checkin_clean')
    if (checkin) { checkin.new_code = 'CREATION_B'; checkin.new_code_authority_status = 'manual_confirmed' }
  }
  await syncCheckoutOldCodeFromCheckinNewCode({ orderId: o23 })
  assert.equal(String((await fetchTaskByType(o23, 'checkout_clean'))?.old_code), 'CREATION_B', 'an existing checkout must receive a later-created same-order checkin password')

  await syncOrderToCleaningTasks(o24, { scope: 'checkin_only' })
  if (pgPool) {
    await pgPool.query(`UPDATE cleaning_tasks SET new_code='CREATION_C', new_code_authority_status='manual_confirmed' WHERE order_id=$1 AND lower(COALESCE(task_type, type, ''))='checkin_clean'`, [o24])
  } else {
    const checkin = await fetchTaskByType(o24, 'checkin_clean')
    if (checkin) { checkin.new_code = 'CREATION_C'; checkin.new_code_authority_status = 'manual_confirmed' }
  }
  await Promise.all([
    syncOrderToCleaningTasks(o24),
    syncCheckoutOldCodeFromCheckinNewCode({ orderId: o24 }),
  ])
  assert.equal(String((await fetchTaskByType(o24, 'checkout_clean'))?.old_code), 'CREATION_C', 'concurrent checkout generation and password sync must converge on the same-order source')

  if (pgPool) await pgPool.query('UPDATE orders SET checkout=$2::date WHERE id=$1', [o1, '2026-02-15'])
  else {
    const o = (db.orders as any[]).find((x: any) => String(x.id) === o1)
    if (o) o.checkout = '2026-02-15'
  }
  await syncOrderToCleaningTasks(o1)
  const t1b = await fetchTask(o1)
  assert.ok(t1b, 'task should still exist')
  assert.equal(String(t1b.task_date).slice(0, 10), '2026-02-15')

  if (pgPool) {
    await pgPool.query(`UPDATE cleaning_tasks SET assignee_id='S1', scheduled_at=now(), status='assigned' WHERE order_id=$1 AND task_type='checkout_clean'`, [o1])
    await pgPool.query('UPDATE orders SET property_id=$2 WHERE id=$1', [o1, 'P_TEST_A2'])
  } else {
    const t = (db.cleaningTasks as any[]).find((x: any) => String(x.order_id) === o1 && String(x.task_type) === 'checkout_clean')
    if (t) { t.assignee_id = 'S1'; t.scheduled_at = new Date().toISOString(); t.status = 'assigned' }
    const o = (db.orders as any[]).find((x: any) => String(x.id) === o1)
    if (o) o.property_id = 'P_TEST_A2'
  }
  await syncOrderToCleaningTasks(o1)
  const t1c = await fetchTask(o1)
  assert.equal(String(t1c.property_id), 'P_TEST_A2')
  assert.equal(t1c.assignee_id, null, 'property change should clear assignee_id')

  if (pgPool) await pgPool.query(`UPDATE orders SET status='cancelled' WHERE id=$1`, [o1])
  else {
    const o = (db.orders as any[]).find((x: any) => String(x.id) === o1)
    if (o) o.status = 'cancelled'
  }
  await syncOrderToCleaningTasks(o1)
  const t1d = await fetchTask(o1)
  assert.equal(String(t1d.status), 'cancelled')
  assert.equal(String(t1d.execution_state), 'cancelled')
  const t1di = await fetchTaskByType(o1, 'checkin_clean')
  assert.ok(t1di)
  assert.equal(String(t1di.status), 'cancelled')
  assert.equal(String(t1di.execution_state), 'cancelled')

  if (pgPool) await pgPool.query(`UPDATE orders SET status='confirmed', checkout=$2::date WHERE id=$1`, [o2, '2026-02-20'])
  else {
    const o = (db.orders as any[]).find((x: any) => String(x.id) === o2)
    if (o) { o.status = 'confirmed'; o.checkout = '2026-02-20' }
  }
  await syncOrderToCleaningTasks(o2)
  const t2 = await fetchTask(o2)
  assert.ok(t2)
  if (pgPool) {
    await pgPool.query(`UPDATE cleaning_tasks SET auto_sync_enabled=false WHERE id=$1`, [String(t2.id)])
    await pgPool.query(`UPDATE orders SET checkout=$2::date WHERE id=$1`, [o2, '2026-02-22'])
  } else {
    const t = (db.cleaningTasks as any[]).find((x: any) => String(x.id) === String(t2.id))
    if (t) t.auto_sync_enabled = false
    const o = (db.orders as any[]).find((x: any) => String(x.id) === o2)
    if (o) o.checkout = '2026-02-22'
  }
  await syncOrderToCleaningTasks(o2)
  const t2b = await fetchTask(o2)
  assert.equal(String(t2b.task_date).slice(0, 10), '2026-02-20', 'locked task should not be overwritten')

  if (pgPool) {
    await pgPool.query(
      `INSERT INTO cleaning_tasks(id, order_id, property_id, task_type, task_date, type, date, status, source, execution_state, manual_task_purpose, auto_sync_enabled, checkin_time, checkout_time, new_code, old_code, guest_special_request, keys_required, nights_override, assignee_id, cleaner_id, inspector_id, linked_checkout_task_id, inspection_scope)
       VALUES
         ($1, NULL, 'P_TEST_D', 'checkin_clean', '2026-02-18'::date, 'checkin_clean', '2026-02-18'::date, 'pending', 'manual', 'active', NULL, true, '2pm', NULL, 'manual-new-code', NULL, 'first cleaning inspection', 2, 5, 'ASSIGNEE-1', 'CLEANER-1', 'INSPECTOR-1', $5, 'inspect_and_hang'),
         ($2, NULL, 'P_TEST_D', 'checkout_clean', '2026-02-21'::date, 'checkout_clean', '2026-02-21'::date, 'pending', 'manual', 'active', 'temporary_order_placeholder', true, NULL, '11am', NULL, 'manual-old-code', NULL, 2, 5, NULL, NULL, NULL, NULL, NULL),
         ($3, NULL, 'P_TEST_D', 'checkin_clean', '2026-02-18'::date, 'checkin_clean', '2026-02-18'::date, 'pending', 'manual', 'active', 'manual_extra', true, NULL, NULL, NULL, NULL, NULL, 1, NULL, NULL, NULL, NULL, NULL, NULL),
         ($4, NULL, 'P_TEST_D', 'checkout_clean', '2026-02-21'::date, 'checkout_clean', '2026-02-21'::date, 'in_progress', 'manual', 'active', 'temporary_order_placeholder', true, NULL, NULL, NULL, NULL, NULL, 1, NULL, NULL, NULL, NULL, NULL, NULL),
         ($5, NULL, 'P_TEST_D', 'checkout_clean', '2026-02-18'::date, 'checkout_clean', '2026-02-18'::date, 'assigned', 'manual', 'active', 'manual_extra', true, NULL, '10am', NULL, NULL, NULL, 1, NULL, NULL, NULL, NULL, NULL, NULL)`,
      [manualCheckin, manualCheckout, manualExtraCheckin, manualCheckoutInProgress, manualLinkedCheckout],
    )
  } else {
    ;(db.cleaningTasks as any[]).push(
      { id: manualCheckin, order_id: null, property_id: 'P_TEST_D', task_type: 'checkin_clean', task_date: '2026-02-18', type: 'checkin_clean', date: '2026-02-18', status: 'pending', source: 'manual', execution_state: 'active', manual_task_purpose: null, auto_sync_enabled: true, checkin_time: '2pm', new_code: 'manual-new-code', guest_special_request: 'first cleaning inspection', keys_required: 2, nights_override: 5, assignee_id: 'ASSIGNEE-1', cleaner_id: 'CLEANER-1', inspector_id: 'INSPECTOR-1', linked_checkout_task_id: manualLinkedCheckout, inspection_scope: 'inspect_and_hang' },
      { id: manualCheckout, order_id: null, property_id: 'P_TEST_D', task_type: 'checkout_clean', task_date: '2026-02-21', type: 'checkout_clean', date: '2026-02-21', status: 'pending', source: 'manual', execution_state: 'active', manual_task_purpose: 'temporary_order_placeholder', auto_sync_enabled: true, checkout_time: '11am', old_code: 'manual-old-code', keys_required: 2, nights_override: 5 },
      { id: manualExtraCheckin, order_id: null, property_id: 'P_TEST_D', task_type: 'checkin_clean', task_date: '2026-02-18', type: 'checkin_clean', date: '2026-02-18', status: 'pending', source: 'manual', execution_state: 'active', manual_task_purpose: 'manual_extra', auto_sync_enabled: true },
      { id: manualCheckoutInProgress, order_id: null, property_id: 'P_TEST_D', task_type: 'checkout_clean', task_date: '2026-02-21', type: 'checkout_clean', date: '2026-02-21', status: 'in_progress', source: 'manual', execution_state: 'active', manual_task_purpose: 'temporary_order_placeholder', auto_sync_enabled: true },
      { id: manualLinkedCheckout, order_id: null, property_id: 'P_TEST_D', task_type: 'checkout_clean', task_date: '2026-02-18', type: 'checkout_clean', date: '2026-02-18', status: 'assigned', source: 'manual', manual_task_purpose: 'manual_extra', execution_state: 'active' },
    )
  }
  await syncOrderToCleaningTasks(o4)
  const o4Checkin = await fetchTaskByType(o4, 'checkin_clean')
  const o4Checkout = await fetchTaskByType(o4, 'checkout_clean')
  assert.ok(o4Checkin, 'should create canonical checkin task before superseding placeholder')
  assert.ok(o4Checkout, 'should create canonical checkout task before superseding placeholder')
  assert.equal(String(o4Checkin.checkin_time), '2pm', 'canonical checkin should inherit manual placeholder checkin_time over default')
  assert.equal(String(o4Checkin.guest_special_request), 'first cleaning inspection', 'canonical checkin should inherit manual placeholder guest request')
  assert.equal(String(o4Checkin.assignee_id), 'ASSIGNEE-1')
  assert.equal(String(o4Checkin.cleaner_id), 'CLEANER-1')
  assert.equal(String(o4Checkin.inspector_id), 'INSPECTOR-1')
  assert.equal(String(o4Checkin.linked_checkout_task_id), manualLinkedCheckout)
  assert.equal(String(o4Checkin.inspection_scope), 'inspect_and_hang', 'automatic order takeover must preserve the explicit manual execution mode')
  assert.equal(o4Checkin.new_code == null ? null : String(o4Checkin.new_code), null, 'manual new_code should not be copied onto canonical checkin')
  assert.equal(Number(o4Checkin.keys_required), 1, 'manual keys_required should not override order-backed canonical checkin')
  assert.equal(String(o4Checkout.checkout_time), '11am', 'canonical checkout should inherit manual placeholder checkout_time over default')
  assert.equal(o4Checkout.old_code == null ? null : String(o4Checkout.old_code), null, 'manual old_code should not be copied onto canonical checkout')
  let eligibleManual: any
  let eligibleManualCheckout: any
  let extraManual: any
  let protectedManual: any
  if (pgPool) {
    const r = await pgPool.query('SELECT * FROM cleaning_tasks WHERE id = ANY($1) ORDER BY id', [[manualCheckin, manualCheckout, manualExtraCheckin, manualCheckoutInProgress]])
    eligibleManual = (r?.rows || []).find((row: any) => String(row.id) === manualCheckin)
    eligibleManualCheckout = (r?.rows || []).find((row: any) => String(row.id) === manualCheckout)
    extraManual = (r?.rows || []).find((row: any) => String(row.id) === manualExtraCheckin)
    protectedManual = (r?.rows || []).find((row: any) => String(row.id) === manualCheckoutInProgress)
  } else {
    eligibleManual = (db.cleaningTasks as any[]).find((row: any) => String(row.id) === manualCheckin)
    eligibleManualCheckout = (db.cleaningTasks as any[]).find((row: any) => String(row.id) === manualCheckout)
    extraManual = (db.cleaningTasks as any[]).find((row: any) => String(row.id) === manualExtraCheckin)
    protectedManual = (db.cleaningTasks as any[]).find((row: any) => String(row.id) === manualCheckoutInProgress)
  }
  const supersedeConflicts = (row: any) => {
    const raw = row?.supersede_conflicts
    if (Array.isArray(raw)) return raw
    if (typeof raw === 'string') return raw ? JSON.parse(raw) : []
    return []
  }
  assert.equal(String(eligibleManual.execution_state), 'superseded', 'an unexecuted manual checkin created by the current entry must be replaced by its unique canonical order task')
  assert.equal(String(eligibleManual.status), 'pending', 'superseded placeholder should keep original status instead of cancelled')
  assert.equal(String(eligibleManual.superseded_by), String(o4Checkin.id))
  assert.ok(supersedeConflicts(eligibleManual).some((item: any) => item.field === 'checkin_time' && item.resolution === 'copied_manual'))
	  assert.ok(supersedeConflicts(eligibleManual).some((item: any) => item.field === 'inspection_scope' && item.resolution === 'copied_manual'))
	  assert.ok(supersedeConflicts(eligibleManual).some((item: any) => item.field === 'guest_special_request' && item.resolution === 'copied_manual'))
	  assert.ok(supersedeConflicts(eligibleManual).some((item: any) => item.field === 'new_code' && item.resolution === 'manual_requires_review'))
	  assert.ok(supersedeConflicts(eligibleManual).some((item: any) => item.field === 'keys_required' && item.resolution === 'manual_requires_review'))
	  assert.ok(supersedeConflicts(eligibleManual).some((item: any) => item.field === 'nights_override' && item.resolution === 'manual_requires_review' && Number(item.canonical_value) === 3 && Number(item.manual_value) === 5))
	  assert.equal(String(eligibleManualCheckout.execution_state), 'superseded', 'temporary manual checkout placeholder should be superseded')
  assert.equal(String(eligibleManualCheckout.superseded_by), String(o4Checkout.id))
  assert.ok(supersedeConflicts(eligibleManualCheckout).some((item: any) => item.field === 'checkout_time' && item.resolution === 'copied_manual'))
  assert.ok(supersedeConflicts(eligibleManualCheckout).some((item: any) => item.field === 'old_code' && item.resolution === 'manual_requires_review'))
  const passwordConflictAudit = JSON.stringify([
    ...supersedeConflicts(eligibleManual).filter((item: any) => item.field === 'new_code'),
    ...supersedeConflicts(eligibleManualCheckout).filter((item: any) => item.field === 'old_code'),
  ])
  assert.ok(!passwordConflictAudit.includes('manual-new-code') && !passwordConflictAudit.includes('manual-old-code'), 'supersede decisions must never persist password values under generic value keys')
  assert.ok(passwordConflictAudit.includes('manual_value_present'), 'supersede decisions may retain only password presence metadata')
	  assert.equal(String(extraManual.execution_state), 'active', 'explicit extra manual checkin task must not be superseded')
	  assert.equal(String(extraManual.status), 'pending')
	  assert.equal(String(protectedManual.execution_state), 'active', 'in-progress manual checkout task must not be superseded')
	  assert.equal(String(protectedManual.status), 'in_progress')

	  if (pgPool) {
	    await pgPool.query(
	      `INSERT INTO cleaning_tasks(id, order_id, property_id, task_type, task_date, type, date, status, source, execution_state, manual_task_purpose, auto_sync_enabled, checkin_time, nights_override, inspection_scope)
	       VALUES($1, NULL, 'P_TEST_E', 'checkin_clean', '2026-02-24'::date, 'checkin_clean', '2026-02-24'::date, 'pending', 'manual', 'active', 'temporary_order_placeholder', true, '2pm', 0, 'password_only')`,
	      [manualCheckinZeroNights],
	    )
	  } else {
	    ;(db.cleaningTasks as any[]).push({ id: manualCheckinZeroNights, order_id: null, property_id: 'P_TEST_E', task_type: 'checkin_clean', task_date: '2026-02-24', type: 'checkin_clean', date: '2026-02-24', status: 'pending', source: 'manual', execution_state: 'active', manual_task_purpose: 'temporary_order_placeholder', auto_sync_enabled: true, checkin_time: '2pm', nights_override: 0, inspection_scope: 'password_only' })
	  }
	  await syncOrderToCleaningTasks(o5)
	  const o5Checkin = await fetchTaskByType(o5, 'checkin_clean')
	  assert.ok(o5Checkin)
	  assert.equal(String(o5Checkin.checkin_time), '2pm', 'canonical checkin should inherit non-default manual placeholder time')
	  assert.equal(String(o5Checkin.inspection_scope), 'password_only', 'an independent manual check-in keeps password-only after automatic order takeover')
	  assert.equal(o5Checkin.nights_override == null ? null : Number(o5Checkin.nights_override), null, 'manual zero-night placeholder should not override order nights')
	  let zeroNightManual: any
	  if (pgPool) {
	    const r = await pgPool.query('SELECT * FROM cleaning_tasks WHERE id = $1', [manualCheckinZeroNights])
	    zeroNightManual = r?.rows?.[0]
	  } else {
	    zeroNightManual = (db.cleaningTasks as any[]).find((row: any) => String(row.id) === manualCheckinZeroNights)
	  }
	  assert.equal(String(zeroNightManual.execution_state), 'superseded', 'zero-night placeholder should still be superseded')
	  assert.ok(supersedeConflicts(zeroNightManual).some((item: any) => item.field === 'nights_override' && item.resolution === 'ignored_placeholder' && Number(item.canonical_value) === 4 && Number(item.manual_value) === 0))
	  assert.equal(supersedeConflicts(zeroNightManual).some((item: any) => item.field === 'nights_override' && item.resolution === 'manual_requires_review'), false, 'zero-night placeholder should not create a manual review conflict')

  if (pgPool) {
    await pgPool.query(
      `INSERT INTO cleaning_tasks(id, order_id, property_id, task_type, task_date, type, date, status, source, execution_state, manual_task_purpose, auto_sync_enabled, checkin_time, started_at, assignee_id)
       VALUES
         ($1, NULL, 'P_TEST_AMBIG', 'checkin_clean', '2026-03-10'::date, 'checkin_clean', '2026-03-10'::date, 'pending', 'manual', 'active', NULL, true, '2pm', NULL, NULL),
         ($2, NULL, 'P_TEST_AMBIG', 'checkin_clean', '2026-03-10'::date, 'checkin_clean', '2026-03-10'::date, 'pending', 'manual', 'active', NULL, true, '4pm', NULL, NULL),
         ($3, NULL, 'P_TEST_EXECUTED', 'checkin_clean', '2026-03-13'::date, 'checkin_clean', '2026-03-13'::date, 'pending', 'manual', 'active', NULL, true, '1pm', now(), NULL)`,
      [manualAmbiguousA, manualAmbiguousB, manualExecuted],
    )
  } else {
    ;(db.cleaningTasks as any[]).push(
      { id: manualAmbiguousA, order_id: null, property_id: 'P_TEST_AMBIG', task_type: 'checkin_clean', task_date: '2026-03-10', type: 'checkin_clean', date: '2026-03-10', status: 'pending', source: 'manual', execution_state: 'active', manual_task_purpose: null, auto_sync_enabled: true, checkin_time: '2pm' },
      { id: manualAmbiguousB, order_id: null, property_id: 'P_TEST_AMBIG', task_type: 'checkin_clean', task_date: '2026-03-10', type: 'checkin_clean', date: '2026-03-10', status: 'pending', source: 'manual', execution_state: 'active', manual_task_purpose: null, auto_sync_enabled: true, checkin_time: '4pm' },
      { id: manualExecuted, order_id: null, property_id: 'P_TEST_EXECUTED', task_type: 'checkin_clean', task_date: '2026-03-13', type: 'checkin_clean', date: '2026-03-13', status: 'pending', source: 'manual', execution_state: 'active', manual_task_purpose: null, auto_sync_enabled: true, checkin_time: '1pm', started_at: '2026-03-13T01:00:00.000Z' },
    )
  }
  await syncOrderToCleaningTasks(o11)
  await syncOrderToCleaningTasks(o12)
  await syncOrderToCleaningTasks(o13)
  const o13OfficialCheckin = await fetchTaskByType(o13, 'checkin_clean')
  if (pgPool) {
    await pgPool.query('UPDATE cleaning_tasks SET assignee_id=$2 WHERE id=$1', [o13OfficialCheckin.id, 'ORDER-ASSIGNEE'])
    await pgPool.query(
      `INSERT INTO cleaning_tasks(id, order_id, property_id, task_type, task_date, type, date, status, source, execution_state, manual_task_purpose, auto_sync_enabled, checkin_time, assignee_id)
       VALUES($1, NULL, 'P_TEST_IDENTITY_CONFLICT', 'checkin_clean', '2026-03-16'::date, 'checkin_clean', '2026-03-16'::date, 'pending', 'manual', 'active', NULL, true, '3pm', 'MANUAL-ASSIGNEE')`,
      [manualIdentityConflict],
    )
  } else {
    o13OfficialCheckin.assignee_id = 'ORDER-ASSIGNEE'
    ;(db.cleaningTasks as any[]).push({ id: manualIdentityConflict, order_id: null, property_id: 'P_TEST_IDENTITY_CONFLICT', task_type: 'checkin_clean', task_date: '2026-03-16', type: 'checkin_clean', date: '2026-03-16', status: 'pending', source: 'manual', execution_state: 'active', manual_task_purpose: null, auto_sync_enabled: true, checkin_time: '3pm', assignee_id: 'MANUAL-ASSIGNEE' })
  }
  await syncOrderToCleaningTasks(o13)
  const ambiguousRows = pgPool
    ? (await pgPool.query('SELECT * FROM cleaning_tasks WHERE id=ANY($1)', [[manualAmbiguousA, manualAmbiguousB]])).rows
    : (db.cleaningTasks as any[]).filter((row) => [manualAmbiguousA, manualAmbiguousB].includes(String(row.id)))
  assert.equal(ambiguousRows.every((row: any) => String(row.execution_state) === 'active'), true, 'multiple manual candidates must fail closed without silent takeover')
  const executedRow = pgPool
    ? (await pgPool.query('SELECT * FROM cleaning_tasks WHERE id=$1', [manualExecuted])).rows?.[0]
    : (db.cleaningTasks as any[]).find((row) => String(row.id) === manualExecuted)
  assert.equal(String(executedRow.execution_state), 'active', 'manual task with execution evidence must never be silently superseded')
  const identityConflictRow = pgPool
    ? (await pgPool.query('SELECT * FROM cleaning_tasks WHERE id=$1', [manualIdentityConflict])).rows?.[0]
    : (db.cleaningTasks as any[]).find((row) => String(row.id) === manualIdentityConflict)
  assert.equal(String(identityConflictRow.execution_state), 'active', 'conflicting assignment must remain visible for manager review instead of being silently superseded')

  if (pgPool) {
    await pgPool.query(
      `INSERT INTO cleaning_tasks(id, order_id, property_id, task_type, task_date, type, date, status, source, execution_state, manual_task_purpose, auto_sync_enabled, checkin_time)
       VALUES($1, NULL, 'P_TEST_COMPETING_ORDERS', 'checkin_clean', '2026-03-20'::date, 'checkin_clean', '2026-03-20'::date, 'pending', 'manual', 'active', NULL, true, '1pm')`,
      [manualCompetingOrder],
    )
  } else {
    ;(db.cleaningTasks as any[]).push({
      id: manualCompetingOrder,
      order_id: null,
      property_id: 'P_TEST_COMPETING_ORDERS',
      task_type: 'checkin_clean',
      task_date: '2026-03-20',
      type: 'checkin_clean',
      date: '2026-03-20',
      status: 'pending',
      source: 'manual',
      execution_state: 'active',
      manual_task_purpose: null,
      auto_sync_enabled: true,
      checkin_time: '1pm',
    })
  }
  await syncOrderToCleaningTasks(o14)
  const competingOrderManual = pgPool
    ? (await pgPool.query('SELECT * FROM cleaning_tasks WHERE id=$1', [manualCompetingOrder])).rows?.[0]
    : (db.cleaningTasks as any[]).find((row) => String(row.id) === manualCompetingOrder)
  assert.equal(String(competingOrderManual.execution_state), 'active', 'two active orders on the same boundary must not let the first sync claim the manual task')

  await syncOrderToCleaningTasks(o16)
  const staleOfficial = await fetchTaskByType(o16, 'checkin_clean')
  assert.ok(staleOfficial)
  if (pgPool) {
    await pgPool.query('UPDATE cleaning_tasks SET auto_sync_enabled=false WHERE id=$1', [String(staleOfficial.id)])
    await pgPool.query('UPDATE orders SET checkin=$2::date WHERE id=$1', [o16, '2026-03-23'])
    await pgPool.query(
      `INSERT INTO cleaning_tasks(id, order_id, property_id, task_type, task_date, type, date, status, source, execution_state, manual_task_purpose, auto_sync_enabled, checkin_time)
       VALUES($1, NULL, 'P_TEST_STALE_OFFICIAL', 'checkin_clean', '2026-03-23'::date, 'checkin_clean', '2026-03-23'::date, 'pending', 'manual', 'active', NULL, true, '4pm')`,
      [manualStaleOfficial],
    )
  } else {
    staleOfficial.auto_sync_enabled = false
    const staleOrder = (db.orders as any[]).find((row: any) => String(row.id) === o16)
    if (staleOrder) staleOrder.checkin = '2026-03-23'
    ;(db.cleaningTasks as any[]).push({
      id: manualStaleOfficial,
      order_id: null,
      property_id: 'P_TEST_STALE_OFFICIAL',
      task_type: 'checkin_clean',
      task_date: '2026-03-23',
      type: 'checkin_clean',
      date: '2026-03-23',
      status: 'pending',
      source: 'manual',
      execution_state: 'active',
      manual_task_purpose: null,
      auto_sync_enabled: true,
      checkin_time: '4pm',
    })
  }
  await syncOrderToCleaningTasks(o16)
  const staleOfficialManual = pgPool
    ? (await pgPool.query('SELECT * FROM cleaning_tasks WHERE id=$1', [manualStaleOfficial])).rows?.[0]
    : (db.cleaningTasks as any[]).find((row) => String(row.id) === manualStaleOfficial)
  assert.equal(String(staleOfficialManual.execution_state), 'active', 'an official task retained on an old date must not claim a manual task from the order new date')

  if (pgPool) {
    await pgPool.query(
      `INSERT INTO cleaning_tasks(id, order_id, property_id, task_type, task_date, type, date, status, source, execution_state, manual_task_purpose, auto_sync_enabled, linked_checkout_task_id)
       VALUES
         ($1, NULL, 'P_TEST_RELINK_CHECKOUT_FIRST', 'checkout_clean', '2026-03-26'::date, 'checkout_clean', '2026-03-26'::date, 'pending', 'manual', 'active', 'temporary_order_placeholder', true, NULL),
         ($2, NULL, 'P_TEST_RELINK_CHECKOUT_FIRST', 'checkin_clean', '2026-03-26'::date, 'checkin_clean', '2026-03-26'::date, 'pending', 'manual', 'active', 'temporary_order_placeholder', true, $1),
         ($3, NULL, 'P_TEST_RELINK_CHECKIN_FIRST', 'checkout_clean', '2026-04-06'::date, 'checkout_clean', '2026-04-06'::date, 'pending', 'manual', 'active', 'temporary_order_placeholder', true, NULL),
         ($4, NULL, 'P_TEST_RELINK_CHECKIN_FIRST', 'checkin_clean', '2026-04-06'::date, 'checkin_clean', '2026-04-06'::date, 'pending', 'manual', 'active', 'temporary_order_placeholder', true, $3),
         ($5, NULL, 'P_TEST_RELINK_AMBIGUOUS', 'checkout_clean', '2026-04-12'::date, 'checkout_clean', '2026-04-12'::date, 'pending', 'manual', 'active', 'temporary_order_placeholder', true, NULL),
         ($6, NULL, 'P_TEST_RELINK_AMBIGUOUS', 'checkin_clean', '2026-04-12'::date, 'checkin_clean', '2026-04-12'::date, 'pending', 'manual', 'active', 'manual_extra', true, $5),
         ($7, NULL, 'P_TEST_RELINK_AMBIGUOUS', 'checkin_clean', '2026-04-12'::date, 'checkin_clean', '2026-04-12'::date, 'pending', 'manual', 'active', 'manual_extra', true, $5)`,
      [manualRelinkCheckoutFirst, manualRelinkCheckinFirst, manualRelinkCheckoutSecond, manualRelinkCheckinSecond, manualAmbiguousRelinkCheckout, manualAmbiguousRelinkCheckinA, manualAmbiguousRelinkCheckinB],
    )
  } else {
    ;(db.cleaningTasks as any[]).push(
      { id: manualRelinkCheckoutFirst, order_id: null, property_id: 'P_TEST_RELINK_CHECKOUT_FIRST', task_type: 'checkout_clean', task_date: '2026-03-26', type: 'checkout_clean', date: '2026-03-26', status: 'pending', source: 'manual', execution_state: 'active', manual_task_purpose: 'temporary_order_placeholder', auto_sync_enabled: true },
      { id: manualRelinkCheckinFirst, order_id: null, property_id: 'P_TEST_RELINK_CHECKOUT_FIRST', task_type: 'checkin_clean', task_date: '2026-03-26', type: 'checkin_clean', date: '2026-03-26', status: 'pending', source: 'manual', execution_state: 'active', manual_task_purpose: 'temporary_order_placeholder', auto_sync_enabled: true, linked_checkout_task_id: manualRelinkCheckoutFirst },
      { id: manualRelinkCheckoutSecond, order_id: null, property_id: 'P_TEST_RELINK_CHECKIN_FIRST', task_type: 'checkout_clean', task_date: '2026-04-06', type: 'checkout_clean', date: '2026-04-06', status: 'pending', source: 'manual', execution_state: 'active', manual_task_purpose: 'temporary_order_placeholder', auto_sync_enabled: true },
      { id: manualRelinkCheckinSecond, order_id: null, property_id: 'P_TEST_RELINK_CHECKIN_FIRST', task_type: 'checkin_clean', task_date: '2026-04-06', type: 'checkin_clean', date: '2026-04-06', status: 'pending', source: 'manual', execution_state: 'active', manual_task_purpose: 'temporary_order_placeholder', auto_sync_enabled: true, linked_checkout_task_id: manualRelinkCheckoutSecond },
      { id: manualAmbiguousRelinkCheckout, order_id: null, property_id: 'P_TEST_RELINK_AMBIGUOUS', task_type: 'checkout_clean', task_date: '2026-04-12', type: 'checkout_clean', date: '2026-04-12', status: 'pending', source: 'manual', execution_state: 'active', manual_task_purpose: 'temporary_order_placeholder', auto_sync_enabled: true },
      { id: manualAmbiguousRelinkCheckinA, order_id: null, property_id: 'P_TEST_RELINK_AMBIGUOUS', task_type: 'checkin_clean', task_date: '2026-04-12', type: 'checkin_clean', date: '2026-04-12', status: 'pending', source: 'manual', execution_state: 'active', manual_task_purpose: 'manual_extra', auto_sync_enabled: true, linked_checkout_task_id: manualAmbiguousRelinkCheckout },
      { id: manualAmbiguousRelinkCheckinB, order_id: null, property_id: 'P_TEST_RELINK_AMBIGUOUS', task_type: 'checkin_clean', task_date: '2026-04-12', type: 'checkin_clean', date: '2026-04-12', status: 'pending', source: 'manual', execution_state: 'active', manual_task_purpose: 'manual_extra', auto_sync_enabled: true, linked_checkout_task_id: manualAmbiguousRelinkCheckout },
    )
  }

  await syncOrderToCleaningTasks(o17)
  const checkoutFirstOfficialCheckout = await fetchTaskByType(o17, 'checkout_clean')
  assert.ok(checkoutFirstOfficialCheckout)
  let checkoutFirstManualCheckin = pgPool
    ? (await pgPool.query('SELECT * FROM cleaning_tasks WHERE id=$1', [manualRelinkCheckinFirst])).rows?.[0]
    : (db.cleaningTasks as any[]).find((row) => String(row.id) === manualRelinkCheckinFirst)
  assert.equal(String(checkoutFirstManualCheckin.linked_checkout_task_id), String(checkoutFirstOfficialCheckout.id), 'checkout-first sync must atomically relink the active manual checkin before superseding its checkout')
  await syncOrderToCleaningTasks(o18)
  const checkoutFirstOfficialCheckin = await fetchTaskByType(o18, 'checkin_clean')
  assert.equal(String(checkoutFirstOfficialCheckin?.linked_checkout_task_id), String(checkoutFirstOfficialCheckout.id), 'later incoming order takeover must preserve the already-relinked turnover relation')
  checkoutFirstManualCheckin = pgPool
    ? (await pgPool.query('SELECT * FROM cleaning_tasks WHERE id=$1', [manualRelinkCheckinFirst])).rows?.[0]
    : (db.cleaningTasks as any[]).find((row) => String(row.id) === manualRelinkCheckinFirst)
  assert.equal(String(checkoutFirstManualCheckin.execution_state), 'superseded')

  await syncOrderToCleaningTasks(o19)
  const checkinFirstOfficialCheckin = await fetchTaskByType(o19, 'checkin_clean')
  assert.equal(String(checkinFirstOfficialCheckin?.linked_checkout_task_id), manualRelinkCheckoutSecond, 'incoming-order-first sync must preserve the explicit manual checkout relation until its official replacement exists')
  await syncOrderToCleaningTasks(o20)
  const checkinFirstOfficialCheckout = await fetchTaskByType(o20, 'checkout_clean')
  const checkinFirstOfficialCheckinAfterRelink = await fetchTaskByType(o19, 'checkin_clean')
  assert.equal(String(checkinFirstOfficialCheckinAfterRelink?.linked_checkout_task_id), String(checkinFirstOfficialCheckout?.id), 'later outgoing order takeover must relink the already-official incoming checkin to the official checkout')

  await syncOrderToCleaningTasks(o21)
  const ambiguousRelinkManualCheckout = pgPool
    ? (await pgPool.query('SELECT * FROM cleaning_tasks WHERE id=$1', [manualAmbiguousRelinkCheckout])).rows?.[0]
    : (db.cleaningTasks as any[]).find((row) => String(row.id) === manualAmbiguousRelinkCheckout)
  assert.equal(String(ambiguousRelinkManualCheckout.execution_state), 'active', 'multiple active reverse links must fail closed without superseding the manual checkout')

  if (!pgPool) {
    const addOrder = (id: string, status = 'confirmed', guestPhone?: string, propertyId = 'P_MZ091') => (db.orders as any[]).push({ id, status, property_id: propertyId, guest_phone: guestPhone || null })
    const addTask = (row: any) => (db.cleaningTasks as any[]).push({
      id: row.id,
      order_id: row.order_id,
      property_id: row.property_id || 'P_MZ091',
      task_type: row.task_type,
      type: row.task_type,
      task_date: row.task_date,
      date: row.task_date,
      status: row.status || 'pending',
      execution_state: 'active',
      auto_sync_enabled: row.auto_sync_enabled !== false,
      ...row,
    })

    addOrder('mz091-old')
    addOrder('mz091-nearest-missing')
    addOrder('mz091-target')
    addTask({ id: 'mz091-old-out', order_id: 'mz091-old', task_type: 'checkout_clean', task_date: '2026-10-20', old_code: '1111' })
    addTask({ id: 'mz091-old-in', order_id: 'mz091-old', task_type: 'checkin_clean', task_date: '2026-10-10', new_code: '1111' })
    addTask({ id: 'mz091-nearest-out', order_id: 'mz091-nearest-missing', task_type: 'checkout_clean', task_date: '2026-10-30', old_code: null })
    addTask({ id: 'mz091-nearest-in', order_id: 'mz091-nearest-missing', task_type: 'checkin_clean', task_date: '2026-10-25', new_code: null })
    addTask({ id: 'mz091-target-in', order_id: 'mz091-target', task_type: 'checkin_clean', task_date: '2026-11-01', old_code: 'stale-value', old_code_authority_status: 'auto_derived' })
    const missingBoundaryResult = await syncCheckinOldCodeFromPreviousStay({ orderId: 'mz091-target' })
    const missingBoundaryTarget = await fetchTaskByType('mz091-target', 'checkin_clean')
    assert.equal(missingBoundaryResult.reason, 'checkin_old_code_not_applicable', 'arrival tasks must not participate in the automatic old-password chain')
    assert.equal(missingBoundaryTarget.old_code, null, 'an arrival task must not fall back across any historical boundary')
    assert.equal(missingBoundaryTarget.old_code_authority_status, 'needs_review')
    assert.equal(missingBoundaryTarget.old_code_source_order_id, null)

    addOrder('mz091-source')
    addOrder('mz091-next')
    addTask({ id: 'mz091-source-in', order_id: 'mz091-source', task_type: 'checkin_clean', task_date: '2026-11-02', new_code: '2222', new_code_authority_status: 'manual_confirmed' })
    addTask({ id: 'mz091-source-out', order_id: 'mz091-source', task_type: 'checkout_clean', task_date: '2026-11-05', old_code: null })
    addTask({ id: 'mz091-next-in', order_id: 'mz091-next', task_type: 'checkin_clean', task_date: '2026-11-06', old_code: null })
    const sourceCheckoutSync = await syncCheckoutOldCodeFromCheckinNewCode({ orderId: 'mz091-source' })
    const nextResult = await syncNextCheckinOldCodeFromSourceOrder({ sourceOrderId: 'mz091-source' })
    const sourceCheckout = await fetchTaskByType('mz091-source', 'checkout_clean')
    const nextCheckin = await fetchTaskByType('mz091-next', 'checkin_clean')
    assert.equal(String(sourceCheckout.old_code), '2222', `same-order checkout must receive the confirmed source checkin password (reason=${String(sourceCheckoutSync.reason || '')})`)
    assert.equal(nextCheckin.old_code, null, 'a later arrival must never inherit this order password')
    assert.equal(nextResult.action, 'no_change')
    assert.equal(nextCheckin.old_code_source_order_id, undefined)

    nextCheckin.old_code = 'manual-correction'
    nextCheckin.old_code_authority_status = 'manual_confirmed'
    nextCheckin.auto_sync_enabled = true
    const sourceCheckin = await fetchTaskByType('mz091-source', 'checkin_clean')
    sourceCheckin.new_code = '3333'
    await syncCheckoutOldCodeFromCheckinNewCode({ orderId: 'mz091-source' })
    const preservedResult = await syncNextCheckinOldCodeFromSourceOrder({ sourceOrderId: 'mz091-source' })
    assert.equal(preservedResult.action, 'no_change', 'manual confirmation remains local and is not treated as a propagation target')
    assert.equal(nextCheckin.old_code, 'manual-correction', 'the MV1608-style explicit correction must not be overwritten')

    nextCheckin.old_code = '3333'
    nextCheckin.old_code_authority_status = 'source_linked'
    nextCheckin.old_code_source_order_id = 'mz091-source'
    nextCheckin.old_code_source_task_id = 'mz091-source-out'
    nextCheckin.old_code_source_field = 'old_code'

    addOrder('mz091-amb-a')
    addOrder('mz091-amb-b')
    addTask({ id: 'mz091-amb-a-in', order_id: 'mz091-amb-a', task_type: 'checkin_clean', task_date: '2026-11-06', old_code: null })
    addTask({ id: 'mz091-amb-b-in', order_id: 'mz091-amb-b', task_type: 'checkin_clean', task_date: '2026-11-06', old_code: null })
    const ambiguousNext = await syncNextCheckinOldCodeFromSourceOrder({ sourceOrderId: 'mz091-source' })
    assert.equal(ambiguousNext.reason, 'cross_order_password_chain_removed', 'cross-order arrival propagation is disabled regardless of candidate count')
    assert.equal(nextCheckin.old_code, null, 'a previously linked target must be cleared when a new nearest-day ambiguity appears')
    assert.equal(nextCheckin.old_code_authority_status, 'needs_review', 'a stale linked target must stop claiming linked authority')
    assert.equal(nextCheckin.old_code_source_task_id, null, 'invalidating a stale dependency must clear the prior source task pointer')
    assert.equal(nextCheckin.old_code_source_order_id, null, 'invalidating a stale dependency must clear the prior source order pointer')
    assert.equal(nextCheckin.old_code_source_field, null, 'invalidating a stale dependency must clear the prior source field pointer')

    addOrder('mz091-cancel-source', 'confirmed', undefined, 'P_MZ091_CANCEL')
    addOrder('mz091-cancel-next', 'confirmed', undefined, 'P_MZ091_CANCEL')
    addTask({ id: 'mz091-cancel-source-in', order_id: 'mz091-cancel-source', property_id: 'P_MZ091_CANCEL', task_type: 'checkin_clean', task_date: '2026-11-07', new_code: '5555', new_code_authority_status: 'manual_confirmed' })
    addTask({ id: 'mz091-cancel-source-out', order_id: 'mz091-cancel-source', property_id: 'P_MZ091_CANCEL', task_type: 'checkout_clean', task_date: '2026-11-08', old_code: null })
    addTask({ id: 'mz091-cancel-next-in', order_id: 'mz091-cancel-next', property_id: 'P_MZ091_CANCEL', task_type: 'checkin_clean', task_date: '2026-11-09', old_code: null })
    await syncCheckoutOldCodeFromCheckinNewCode({ orderId: 'mz091-cancel-source' })
    await syncNextCheckinOldCodeFromSourceOrder({ sourceOrderId: 'mz091-cancel-source' })
    const cancelledSource = await fetchTaskByType('mz091-cancel-source', 'checkin_clean')
    const cancelledSourceBefore = { ...cancelledSource }
    cancelledSource.status = 'cancelled'
    cancelledSource.execution_state = 'cancelled'
    await reconcilePasswordAuthorityAfterTaskTopologyChange({ before: cancelledSourceBefore, after: cancelledSource })
    const invalidatedCheckout = await fetchTaskByType('mz091-cancel-source', 'checkout_clean')
    assert.equal(invalidatedCheckout.old_code, null, 'cancelling a source checkin must clear its same-order checkout dependency')
    assert.equal(invalidatedCheckout.old_code_source_task_id, null)
    await syncCheckoutOldCodeFromCheckinNewCode({ orderId: 'mz091-cancel-source' })
    assert.equal((await fetchTaskByType('mz091-cancel-source', 'checkout_clean')).old_code, null, 'rerunning same-order sync must not resurrect a cancelled checkin password')
    await syncNextCheckinOldCodeFromSourceOrder({ sourceOrderId: 'mz091-cancel-source' })
    const cancelledCheckout = await fetchTaskByType('mz091-cancel-source', 'checkout_clean')
    const cancelledNext = await fetchTaskByType('mz091-cancel-next', 'checkin_clean')
    assert.equal(cancelledCheckout.old_code, null)
    assert.equal(cancelledCheckout.old_code_source_task_id, null)
    assert.equal(cancelledNext.old_code, null, 'cancelling a source checkin must clear the next-arrival dependency')
    assert.notEqual(cancelledNext.old_code_authority_status, 'source_linked', 'the next arrival must never claim linked authority from another order')

    addOrder('mz091-topology-source', 'confirmed', undefined, 'P_MZ091_TOPOLOGY')
    addOrder('mz091-topology-a', 'confirmed', undefined, 'P_MZ091_TOPOLOGY')
    addOrder('mz091-topology-b', 'confirmed', undefined, 'P_MZ091_TOPOLOGY')
    addTask({ id: 'mz091-topology-source-out', order_id: 'mz091-topology-source', property_id: 'P_MZ091_TOPOLOGY', task_type: 'checkout_clean', task_date: '2026-12-01', old_code: '6161', old_code_authority_status: 'manual_confirmed' })
    addTask({ id: 'mz091-topology-a-in', order_id: 'mz091-topology-a', property_id: 'P_MZ091_TOPOLOGY', task_type: 'checkin_clean', task_date: '2026-12-02', old_code: null })
    addTask({ id: 'mz091-topology-b-in', order_id: 'mz091-topology-b', property_id: 'P_MZ091_TOPOLOGY', task_type: 'checkin_clean', task_date: '2026-12-03', old_code: null })
    await syncNextCheckinOldCodeFromSourceOrder({ sourceOrderId: 'mz091-topology-source' })
    const topologyB = await fetchTaskByType('mz091-topology-b', 'checkin_clean')
    const topologyBBefore = { ...topologyB }
    topologyB.task_date = '2026-12-02'
    topologyB.date = '2026-12-02'
    await reconcilePasswordAuthorityAfterTaskTopologyChange({ before: topologyBBefore, after: topologyB })
    assert.notEqual((await fetchTaskByType('mz091-topology-a', 'checkin_clean')).old_code_authority_status, 'source_linked', 'arrival topology must not create cross-order password authority')
    assert.notEqual((await fetchTaskByType('mz091-topology-b', 'checkin_clean')).old_code_authority_status, 'source_linked', 'the moved arrival must not claim cross-order authority')

    addOrder('mz091-move-source', 'confirmed', undefined, 'P_MZ091_MOVE')
    addOrder('mz091-move-first', 'confirmed', undefined, 'P_MZ091_MOVE')
    addOrder('mz091-move-next', 'confirmed', undefined, 'P_MZ091_MOVE')
    addTask({ id: 'mz091-move-source-out', order_id: 'mz091-move-source', property_id: 'P_MZ091_MOVE', task_type: 'checkout_clean', task_date: '2026-12-10', old_code: '7171', old_code_authority_status: 'manual_confirmed' })
    addTask({ id: 'mz091-move-first-in', order_id: 'mz091-move-first', property_id: 'P_MZ091_MOVE', task_type: 'checkin_clean', task_date: '2026-12-11', old_code: null })
    addTask({ id: 'mz091-move-next-in', order_id: 'mz091-move-next', property_id: 'P_MZ091_MOVE', task_type: 'checkin_clean', task_date: '2026-12-12', old_code: null })
    await syncNextCheckinOldCodeFromSourceOrder({ sourceOrderId: 'mz091-move-source' })
    const moveFirst = await fetchTaskByType('mz091-move-first', 'checkin_clean')
    const moveFirstBefore = { ...moveFirst }
    moveFirst.task_date = '2026-12-13'
    moveFirst.date = '2026-12-13'
    await reconcilePasswordAuthorityAfterTaskTopologyChange({ before: moveFirstBefore, after: moveFirst })
    assert.equal((await fetchTaskByType('mz091-move-next', 'checkin_clean')).old_code, null, 'moving a task must never relink a password into a different order')
    assert.notEqual((await fetchTaskByType('mz091-move-first', 'checkin_clean')).old_code_authority_status, 'source_linked', 'the moved former target must lose the stale source link')

    addOrder('mz091-cross-property-source', 'confirmed', undefined, 'P_MZ091_CROSS_A')
    addOrder('mz091-cross-property-target', 'confirmed', undefined, 'P_MZ091_CROSS_B')
    addTask({ id: 'mz091-cross-property-source-in', order_id: 'mz091-cross-property-source', property_id: 'P_MZ091_CROSS_A', task_type: 'checkin_clean', task_date: '2026-12-20', new_code: '8181', new_code_authority_status: 'manual_confirmed' })
    addTask({ id: 'mz091-cross-property-source-out', order_id: 'mz091-cross-property-source', property_id: 'P_MZ091_CROSS_A', task_type: 'checkout_clean', task_date: '2026-12-21', old_code: null })
    addTask({ id: 'mz091-cross-property-target-in', order_id: 'mz091-cross-property-target', property_id: 'P_MZ091_CROSS_B', task_type: 'checkin_clean', task_date: '2026-12-22', old_code: null })
    await syncCheckoutOldCodeFromCheckinNewCode({ orderId: 'mz091-cross-property-source' })
    const crossPropertyCheckout = await fetchTaskByType('mz091-cross-property-source', 'checkout_clean')
    const crossPropertyCheckoutBefore = { ...crossPropertyCheckout }
    crossPropertyCheckout.property_id = 'P_MZ091_CROSS_B'
    await reconcilePasswordAuthorityAfterTaskTopologyChange({ before: crossPropertyCheckoutBefore, after: crossPropertyCheckout })
    assert.equal(crossPropertyCheckout.old_code, null, 'moving only the checkout across properties must clear its old same-order credential')
    assert.equal(crossPropertyCheckout.old_code_authority_status, 'needs_review')
    assert.notEqual((await fetchTaskByType('mz091-cross-property-target', 'checkin_clean')).old_code, '8181', 'an A-property password must never propagate to a B-property arrival')

    addOrder('mz091-cross-manual-source', 'confirmed', undefined, 'P_MZ091_MANUAL_A')
    addOrder('mz091-cross-manual-target', 'confirmed', undefined, 'P_MZ091_MANUAL_B')
    addTask({ id: 'mz091-cross-manual-source-in', order_id: 'mz091-cross-manual-source', property_id: 'P_MZ091_MANUAL_A', task_type: 'checkin_clean', task_date: '2026-12-23', new_code: '8282', new_code_authority_status: 'manual_confirmed' })
    addTask({ id: 'mz091-cross-manual-source-out', order_id: 'mz091-cross-manual-source', property_id: 'P_MZ091_MANUAL_B', task_type: 'checkout_clean', task_date: '2026-12-24', old_code: 'manual-cross-secret', old_code_authority_status: 'manual_confirmed' })
    addTask({ id: 'mz091-cross-manual-target-in', order_id: 'mz091-cross-manual-target', property_id: 'P_MZ091_MANUAL_B', task_type: 'checkin_clean', task_date: '2026-12-25', old_code: null })
    assert.equal((await syncCheckoutOldCodeFromCheckinNewCode({ orderId: 'mz091-cross-manual-source' })).reason, 'property_mismatch_preserved')
    await syncNextCheckinOldCodeFromSourceOrder({ sourceOrderId: 'mz091-cross-manual-source' })
    assert.equal((await fetchTaskByType('mz091-cross-manual-source', 'checkout_clean')).old_code, 'manual-cross-secret', 'manual cross-property values stay preserved for review')
    assert.equal((await fetchTaskByType('mz091-cross-manual-target', 'checkin_clean')).old_code, null, 'preserved manual cross-property values must never propagate')

    addOrder('mz091-cross-locked-source', 'confirmed', undefined, 'P_MZ091_LOCKED_A')
    addOrder('mz091-cross-locked-target', 'confirmed', undefined, 'P_MZ091_LOCKED_B')
    addTask({ id: 'mz091-cross-locked-source-in', order_id: 'mz091-cross-locked-source', property_id: 'P_MZ091_LOCKED_A', task_type: 'checkin_clean', task_date: '2026-12-26', new_code: '8383', new_code_authority_status: 'manual_confirmed' })
    addTask({ id: 'mz091-cross-locked-source-out', order_id: 'mz091-cross-locked-source', property_id: 'P_MZ091_LOCKED_B', task_type: 'checkout_clean', task_date: '2026-12-27', old_code: 'locked-cross-secret', old_code_authority_status: 'source_linked', auto_sync_enabled: false })
    addTask({ id: 'mz091-cross-locked-target-in', order_id: 'mz091-cross-locked-target', property_id: 'P_MZ091_LOCKED_B', task_type: 'checkin_clean', task_date: '2026-12-28', old_code: null })
    assert.equal((await syncCheckoutOldCodeFromCheckinNewCode({ orderId: 'mz091-cross-locked-source' })).reason, 'property_mismatch')
    await syncNextCheckinOldCodeFromSourceOrder({ sourceOrderId: 'mz091-cross-locked-source' })
    assert.equal((await fetchTaskByType('mz091-cross-locked-source', 'checkout_clean')).old_code, null, 'auto_sync_enabled=false without manual authority must not preserve a mismatched password')
    assert.equal((await fetchTaskByType('mz091-cross-locked-target', 'checkin_clean')).old_code, null, 'locked cross-property values must never propagate')

    addOrder('mz091-stale-order-source', 'confirmed', undefined, 'P_MZ091_STALE_B')
    addTask({ id: 'mz091-stale-order-source-in', order_id: 'mz091-stale-order-source', property_id: 'P_MZ091_STALE_A', task_type: 'checkin_clean', task_date: '2027-01-01', new_code: '8484', new_code_authority_status: 'manual_confirmed' })
    addTask({ id: 'mz091-stale-order-source-out', order_id: 'mz091-stale-order-source', property_id: 'P_MZ091_STALE_A', task_type: 'checkout_clean', task_date: '2027-01-02', old_code: '8484', old_code_authority_status: 'source_linked', old_code_source_task_id: 'mz091-stale-order-source-in', old_code_source_order_id: 'mz091-stale-order-source' })
    await syncCheckoutOldCodeFromCheckinNewCode({ orderId: 'mz091-stale-order-source' })
    assert.equal((await fetchTaskByType('mz091-stale-order-source', 'checkout_clean')).old_code, null, 'tasks left on A after their order moved to B must not retain automatic same-order credentials')
    await assert.rejects(
      claimTaskPasswordAuthorityFields({ taskId: 'mz091-stale-order-source-in', fields: ['new_code'], audit: { requestId: 'stale-order-claim', client: 'web' } }),
      /password_authority_order_property_mismatch/,
    )
    addOrder('mz091-inactive-order-claim', 'cancelled', undefined, 'P_MZ091_INACTIVE')
    addTask({ id: 'mz091-inactive-order-claim-in', order_id: 'mz091-inactive-order-claim', property_id: 'P_MZ091_INACTIVE', task_type: 'checkin_clean', task_date: '2027-01-02', new_code: '8686', new_code_authority_status: 'needs_review' })
    await assert.rejects(
      claimTaskPasswordAuthorityFields({ taskId: 'mz091-inactive-order-claim-in', fields: ['new_code'], audit: { requestId: 'inactive-order-claim', client: 'web' } }),
      /password_authority_order_property_mismatch/,
    )

    addOrder('mz091-stale-target-source', 'confirmed', undefined, 'P_MZ091_TARGET_A')
    addOrder('mz091-stale-target', 'confirmed', undefined, 'P_MZ091_TARGET_B')
    addTask({ id: 'mz091-stale-target-source-out', order_id: 'mz091-stale-target-source', property_id: 'P_MZ091_TARGET_A', task_type: 'checkout_clean', task_date: '2027-01-03', old_code: '8585', old_code_authority_status: 'manual_confirmed' })
    addTask({ id: 'mz091-stale-target-in', order_id: 'mz091-stale-target', property_id: 'P_MZ091_TARGET_A', task_type: 'checkin_clean', task_date: '2027-01-04', old_code: '8585', old_code_authority_status: 'source_linked', old_code_source_task_id: 'mz091-stale-target-source-out', old_code_source_order_id: 'mz091-stale-target-source' })
    await syncCheckinOldCodeFromPreviousStay({ orderId: 'mz091-stale-target' })
    const staleTarget = await fetchTaskByType('mz091-stale-target', 'checkin_clean')
    assert.equal(staleTarget.old_code, null, 'a target task left on A after its order moved to B must fail closed')
    assert.equal(staleTarget.old_code_authority_status, 'needs_review')

    addTask({ id: 'mz091-manual', order_id: null, task_type: 'checkout_clean', task_date: '2026-11-07', old_code: 'same-value', old_code_authority_status: 'needs_review' })
    const confirmedOnce = await confirmTaskPasswordAuthority({ taskId: 'mz091-manual', fields: ['old_code'], audit: { requestId: 'req-1', actorRole: 'customer_service', client: 'web' } })
    const confirmedAt = confirmedOnce.task.old_code_authority_updated_at
    const confirmedTwice = await confirmTaskPasswordAuthority({ taskId: 'mz091-manual', fields: ['old_code'], audit: { requestId: 'req-1', actorRole: 'customer_service', client: 'web' } })
    assert.equal(confirmedOnce.task.old_code_authority_status, 'manual_confirmed', 'same-value verification must create explicit authority')
    assert.equal(confirmedTwice.task.old_code_authority_status, 'manual_confirmed', 'same-value verification must be idempotent')
    assert.deepEqual(confirmedTwice.updatedFields, [], 'a replayed request receipt must not perform a second write or event')
    assert.equal(confirmedTwice.task.old_code_authority_updated_at, confirmedAt, 'a replay must preserve the first confirmation timestamp')
    assert.equal(confirmedTwice.task.old_code_source_field, 'manual')

    addTask({ id: 'mz091-manual-concurrent', order_id: null, task_type: 'checkout_clean', task_date: '2026-11-08', old_code: 'concurrent-value', old_code_authority_status: 'needs_review' })
    const concurrentConfirmations = await Promise.all([
      confirmTaskPasswordAuthority({ taskId: 'mz091-manual-concurrent', fields: ['old_code'], audit: { requestId: 'req-concurrent', actorRole: 'customer_service', client: 'web' } }),
      confirmTaskPasswordAuthority({ taskId: 'mz091-manual-concurrent', fields: ['old_code'], audit: { requestId: 'req-concurrent', actorRole: 'customer_service', client: 'web' } }),
    ])
    assert.equal(concurrentConfirmations.reduce((sum, result) => sum + result.updatedFields.length, 0), 1, 'concurrent duplicate clicks must claim exactly one receipt')

    addOrder('mz091-legacy-equal', 'confirmed', '0400007890')
    addTask({ id: 'mz091-legacy-equal-in', order_id: 'mz091-legacy-equal', task_type: 'checkin_clean', task_date: '2026-11-09', new_code: '7890', new_code_authority_status: 'manual_confirmed' })
    addTask({ id: 'mz091-legacy-equal-out', order_id: 'mz091-legacy-equal', task_type: 'checkout_clean', task_date: '2026-11-10', old_code: '7890', old_code_authority_status: null })
    await syncCheckoutOldCodeFromCheckinNewCode({ orderId: 'mz091-legacy-equal' })
    const legacyEqual = await fetchTaskByType('mz091-legacy-equal', 'checkout_clean')
    assert.equal(legacyEqual.old_code, '7890', 'the same-order checkin source must initialize checkout old_code even when the text is unchanged')
    assert.equal(legacyEqual.old_code_authority_status, 'source_linked', 'value equality must still repair exact same-order source provenance')

    addOrder('mz091-legacy-filled-source', 'confirmed', undefined, 'P_MZ091_LEGACY_FILLED')
    addTask({ id: 'mz091-legacy-filled-source-in', order_id: 'mz091-legacy-filled-source', property_id: 'P_MZ091_LEGACY_FILLED', task_type: 'checkin_clean', task_date: '2026-11-10', old_code: 'legacy-unrelated-old', old_code_authority_status: 'needs_review', new_code: 'filled-current-new', new_code_authority_status: null })
    addTask({ id: 'mz091-legacy-filled-source-out', order_id: 'mz091-legacy-filled-source', property_id: 'P_MZ091_LEGACY_FILLED', task_type: 'checkout_clean', task_date: '2026-11-11', old_code: 'stale-target', old_code_authority_status: null })
    const legacyFilledResult = await syncCheckoutOldCodeFromCheckinNewCode({ orderId: 'mz091-legacy-filled-source' })
    const legacyFilledTarget = await fetchTaskByType('mz091-legacy-filled-source', 'checkout_clean')
    assert.equal(legacyFilledResult.reason, 'source_linked', 'a filled same-order checkin new_code must propagate without requiring a second confirmation step')
    assert.equal(legacyFilledTarget.old_code, 'filled-current-new', 'checkin old_code authority is unrelated to propagation of its populated new_code')
    assert.equal(legacyFilledTarget.old_code_authority_status, 'source_linked')
    assert.equal(legacyFilledTarget.old_code_source_task_id, 'mz091-legacy-filled-source-in')
    assert.equal(legacyFilledTarget.old_code_source_order_id, 'mz091-legacy-filled-source')

    addOrder('mz091-terminal-source', 'confirmed', undefined, 'P_MZ091_TERMINAL')
    addOrder('mz091-terminal-ready', 'confirmed', undefined, 'P_MZ091_TERMINAL')
    addOrder('mz091-terminal-active', 'confirmed', undefined, 'P_MZ091_TERMINAL')
    addTask({ id: 'mz091-terminal-source-in', order_id: 'mz091-terminal-source', property_id: 'P_MZ091_TERMINAL', task_type: 'checkin_clean', task_date: '2026-11-12', new_code: '4444', new_code_authority_status: 'manual_confirmed' })
    addTask({ id: 'mz091-terminal-source-out', order_id: 'mz091-terminal-source', property_id: 'P_MZ091_TERMINAL', task_type: 'checkout_clean', task_date: '2026-11-13', old_code: null })
    addTask({ id: 'mz091-terminal-ready-in', order_id: 'mz091-terminal-ready', property_id: 'P_MZ091_TERMINAL', task_type: 'checkin_clean', task_date: '2026-11-14', status: 'ready', old_code: 'terminal-value', old_code_authority_status: 'source_linked', old_code_source_order_id: 'mz091-terminal-source' })
    addTask({ id: 'mz091-terminal-active-in', order_id: 'mz091-terminal-active', property_id: 'P_MZ091_TERMINAL', task_type: 'checkin_clean', task_date: '2026-11-15', old_code: null })
    await syncCheckoutOldCodeFromCheckinNewCode({ orderId: 'mz091-terminal-source' })
    const terminalNext = await syncNextCheckinOldCodeFromSourceOrder({ sourceOrderId: 'mz091-terminal-source' })
    assert.equal(terminalNext.targetTaskId, undefined, 'no later arrival is selected for password mutation')
    assert.equal((await fetchTaskByType('mz091-terminal-ready', 'checkin_clean')).old_code, 'terminal-value', 'terminal password values must remain immutable')
    assert.equal((await fetchTaskByType('mz091-terminal-active', 'checkin_clean')).old_code, null, 'a later active checkin must not receive another order password')

    addOrder('mz091-terminal-worker', 'confirmed', '0400009090', 'P_MZ091_WORKER')
    const terminalWorkerOrder = (db.orders as any[]).find((order: any) => String(order.id) === 'mz091-terminal-worker')
    terminalWorkerOrder.checkin = '2026-12-20'
    terminalWorkerOrder.checkout = '2026-12-21'
    addTask({ id: 'mz091-terminal-worker-in', order_id: 'mz091-terminal-worker', property_id: 'P_MZ091_WORKER', task_type: 'checkin_clean', task_date: '2026-12-20', status: 'completed', new_code: 'worker-in-secret', new_code_authority_status: 'auto_derived', new_code_authority_updated_at: '2026-11-01T00:00:00.000Z' })
    addTask({ id: 'mz091-terminal-worker-out', order_id: 'mz091-terminal-worker', property_id: 'P_MZ091_WORKER', task_type: 'checkout_clean', task_date: '2026-12-21', status: 'ready', old_code: 'worker-out-secret', old_code_authority_status: 'auto_derived', old_code_authority_updated_at: '2026-11-01T00:00:00.000Z' })
    await syncOrderToCleaningTasks('mz091-terminal-worker')
    const terminalWorkerIn = await fetchTaskByType('mz091-terminal-worker', 'checkin_clean')
    const terminalWorkerOut = await fetchTaskByType('mz091-terminal-worker', 'checkout_clean')
    assert.equal(terminalWorkerIn.new_code, 'worker-in-secret', 'worker phone drift must not overwrite completed task passwords')
    assert.equal(terminalWorkerOut.old_code, 'worker-out-secret', 'worker phone drift must not overwrite ready task passwords')
    const terminalAuthorityTimestamp = terminalWorkerOut.old_code_authority_updated_at
    await assert.rejects(
      confirmTaskPasswordAuthority({ taskId: 'mz091-terminal-worker-out', fields: ['old_code'], audit: { requestId: 'terminal-confirm', actorRole: 'customer_service', client: 'web' } }),
      /password_authority_task_terminal/,
    )
    assert.equal(terminalWorkerOut.old_code_authority_updated_at, terminalAuthorityTimestamp, 'terminal confirmation rejection must not update authority timestamps')
  }

  const redacted = redactPasswordAuditValues({
    old_code: 'secret-old',
    nested: { newCode: 'secret-new', guest_phone: 'secret-phone' },
    decision: { field: 'old_code', canonical_value: 'secret-canonical', manual_value: 'secret-manual' },
    supersede_conflicts: JSON.stringify([{ field: 'new_code', canonical_value: 'secret-json-canonical', manual_value: 'secret-json-manual' }]),
    result: 'updated',
  })
  const redactedText = JSON.stringify(redacted.value)
  for (const secret of ['secret-old', 'secret-new', 'secret-phone', 'secret-canonical', 'secret-manual', 'secret-json-canonical', 'secret-json-manual']) {
    assert.ok(!redactedText.includes(secret), `audit payloads must not contain ${secret}`)
  }
  assert.equal(redacted.value.old_code_present, true)
  const migrationSql = readFileSync(resolve(__dirname, '../migrations/20261101_mz091_password_authority.sql'), 'utf8')
  for (const required of ['old_code_authority_status', 'new_code_authority_status', 'old_code_source_order_id', 'manual_confirmed', 'needs_review']) {
    assert.ok(migrationSql.includes(required), `MZ-091 migration must include ${required}`)
  }

  if (pgPool) await pgPool.query('DELETE FROM orders WHERE id=$1', [o3])
  else {
    ;(db.orders as any[]) = (db.orders as any[]).filter((x: any) => String(x.id) !== o3)
  }
  await syncOrderToCleaningTasks(o3, { deleted: true })
  const t3 = await fetchTask(o3)
  assert.equal(t3, null, 'deleted order without existing task should not create')

  await backfillCleaningTasks({ dateFrom: '2026-02-01', dateTo: '2026-03-01', concurrency: 2 })
  await backfillCleaningTasks({ dateFrom: '2026-02-01', dateTo: '2026-03-01', concurrency: 2 })
  if (pgPool) {
    const countTasks = await pgPool.query(`SELECT COUNT(*)::int AS c FROM cleaning_tasks WHERE order_id = ANY($1)`, [[o1, o2]])
    assert.equal(Number(countTasks?.rows?.[0]?.c || 0), 4, 'backfill twice should not duplicate tasks')
    await pgPool.query('DELETE FROM cleaning_sync_logs WHERE order_id = ANY($1)', [[o1, o2, o4, o5, o6, o7, o9, o10, o11, o12, o13, o14, o15, o16, o17, o18, o19, o20, o21]])
    await pgPool.query('DELETE FROM cleaning_tasks WHERE order_id = ANY($1) OR id = ANY($2)', [[o1, o2, o4, o5, o6, o7, o9, o10, o11, o12, o13, o14, o15, o16, o17, o18, o19, o20, o21], [manualCheckin, manualCheckout, manualExtraCheckin, manualCheckoutInProgress, manualCheckinZeroNights, manualLinkedCheckout, manualAmbiguousA, manualAmbiguousB, manualExecuted, manualIdentityConflict, manualCompetingOrder, manualStaleOfficial, manualRelinkCheckoutFirst, manualRelinkCheckinFirst, manualRelinkCheckoutSecond, manualRelinkCheckinSecond, manualAmbiguousRelinkCheckout, manualAmbiguousRelinkCheckinA, manualAmbiguousRelinkCheckinB]])
    await pgPool.query('DELETE FROM orders WHERE id = ANY($1)', [[o1, o2, o4, o5, o6, o7, o9, o10, o11, o12, o13, o14, o15, o16, o17, o18, o19, o20, o21]])
  } else {
    const tasks = (db.cleaningTasks as any[]).filter((t: any) => [o1, o2].includes(String(t.order_id)))
    assert.equal(tasks.length, 4, 'backfill twice should not duplicate tasks')
  }
  process.stdout.write('ok\n')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
