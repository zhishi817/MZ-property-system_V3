import assert from 'assert'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { v4 as uuid } from 'uuid'
import { pgPool } from '../../src/dbAdapter'
import { ensureCleaningSchemaV2, syncCheckinOldCodeFromPreviousStay, syncCheckoutOldCodeFromCheckinNewCode, syncOrderToCleaningTasks, backfillCleaningTasks } from '../../src/services/cleaningSync'
import { cleaningSyncJobScope, enqueueCleaningSyncJobTx } from '../../src/services/cleaningSyncJobs'
import { __test_dispatchCleaningSyncJob, __test_syncOrderOptionsForJob, __test_syncScopeForJob } from '../../src/services/cleaningSyncJobsWorker'
import { db } from '../../src/store'
import { buildCleaningTurnoverDisplay, mergeCleaningTurnoverDisplays } from '../../src/lib/cleaningTurnoverDisplay'

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
  const o1 = uuid()
  const o2 = uuid()
  const o3 = uuid()
  const o4 = uuid()
  const o5 = uuid()
  const o6 = uuid()
  const o7 = uuid()
  const o8 = uuid()
  const manualCheckin = uuid()
  const manualCheckout = uuid()
  const manualExtraCheckin = uuid()
  const manualCheckoutInProgress = uuid()
  const manualCheckinZeroNights = uuid()

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
  ]

  if (pgPool) {
    await ensureCleaningSchemaV2()
    await pgPool.query('DELETE FROM cleaning_sync_logs WHERE order_id = ANY($1)', [[o1, o2, o3, o4, o5, o6, o7, o8]])
    await pgPool.query('DELETE FROM cleaning_tasks WHERE order_id = ANY($1) OR id = ANY($2)', [[o1, o2, o3, o4, o5, o6, o7, o8], [manualCheckin, manualCheckout, manualExtraCheckin, manualCheckoutInProgress, manualCheckinZeroNights]])
    await pgPool.query('DELETE FROM orders WHERE id = ANY($1)', [[o1, o2, o3, o4, o5, o6, o7, o8]])
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
    await pgPool.query(`UPDATE cleaning_tasks SET new_code='2468' WHERE order_id=$1 AND lower(COALESCE(task_type, type, ''))='checkin_clean'`, [o6])
    await pgPool.query(`UPDATE cleaning_tasks SET old_code='1357' WHERE order_id=$1 AND lower(COALESCE(task_type, type, ''))='checkout_clean'`, [o6])
  } else {
    const previousCheckin = await fetchTaskByType(o6, 'checkin_clean')
    const previousCheckout = await fetchTaskByType(o6, 'checkout_clean')
    if (previousCheckin) previousCheckin.new_code = '2468'
    if (previousCheckout) previousCheckout.old_code = '1357'
  }
  await syncOrderToCleaningTasks(o7)
  const incomingCheckin = await fetchTaskByType(o7, 'checkin_clean')
  assert.ok(incomingCheckin, 'should create the incoming checkin task')
  assert.equal(String(incomingCheckin.old_code), '1357', 'a checkin-only day should use the nearest previous checkout old_code')

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
    await pgPool.query(`UPDATE cleaning_tasks SET new_code='2468' WHERE order_id=$1 AND lower(COALESCE(task_type, type, ''))='checkin_clean'`, [o6])
    await pgPool.query(`UPDATE cleaning_tasks SET old_code=NULL, auto_sync_enabled=true WHERE order_id=$1 AND lower(COALESCE(task_type, type, ''))='checkin_clean'`, [o7])
  } else {
    const previousCheckin = await fetchTaskByType(o6, 'checkin_clean')
    const previousCheckout = await fetchTaskByType(o6, 'checkout_clean')
    const targetCheckin = await fetchTaskByType(o7, 'checkin_clean')
    if (previousCheckin) previousCheckin.new_code = '2468'
    if (previousCheckout) previousCheckout.old_code = null
    if (targetCheckin) { targetCheckin.old_code = null; targetCheckin.auto_sync_enabled = true }
  }
  await syncCheckinOldCodeFromPreviousStay({ orderId: o7 })
  const fallbackIncomingCheckin = await fetchTaskByType(o7, 'checkin_clean')
  assert.equal(String(fallbackIncomingCheckin.old_code), '2468', 'a missing historical checkout old_code should fall back to the prior stay checkin new_code')

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
  assert.equal(lockedWithoutSource.action, 'no_change', 'a manually locked checkin old_code must remain unchanged when no historical source exists')
  const lockedWithoutSourceCheckin = await fetchTaskByType(o7, 'checkin_clean')
  assert.equal(String(lockedWithoutSourceCheckin?.old_code), 'manual-old-code')

  if (pgPool) {
    await pgPool.query(`UPDATE cleaning_tasks SET old_code='manual-old-code', auto_sync_enabled=false WHERE order_id=$1 AND lower(COALESCE(task_type, type, ''))='checkin_clean'`, [o7])
    await pgPool.query(`UPDATE cleaning_tasks SET old_code='9753' WHERE order_id=$1 AND lower(COALESCE(task_type, type, ''))='checkout_clean'`, [o6])
  } else {
    const previousCheckout = await fetchTaskByType(o6, 'checkout_clean')
    const targetCheckin = await fetchTaskByType(o7, 'checkin_clean')
    if (previousCheckout) previousCheckout.old_code = '9753'
    if (targetCheckin) { targetCheckin.old_code = 'manual-old-code'; targetCheckin.auto_sync_enabled = false }
  }
  const lockedCheckinPassword = await syncCheckinOldCodeFromPreviousStay({ orderId: o7 })
  assert.equal(lockedCheckinPassword.action, 'skipped_locked', 'a manually locked checkin old_code must not be overwritten')
  const lockedIncomingCheckin = await fetchTaskByType(o7, 'checkin_clean')
  assert.equal(String(lockedIncomingCheckin.old_code), 'manual-old-code')

  const pureCheckinDisplay = buildCleaningTurnoverDisplay({
    propertyId: 'P_TEST_PASSWORD_CHAIN',
    taskDate: '2026-02-05',
    checkinTask: { id: 'pure-checkin', order_id: 'incoming', task_type: 'checkin_clean', task_date: '2026-02-05', old_code: '1357', new_code: '2468' },
  })
  assert.equal(pureCheckinDisplay.old_code, '1357', 'the canonical display must retain old_code for a pure checkin card')
  const mergedPureCheckinDisplay = mergeCleaningTurnoverDisplays([pureCheckinDisplay])
  assert.equal(mergedPureCheckinDisplay?.old_code, '1357', 'the merged display must retain old_code for a pure checkin card')

  if (pgPool) {
    await pgPool.query(`UPDATE cleaning_tasks SET new_code='9753' WHERE order_id=$1 AND task_type='checkin_clean'`, [o1])
    await pgPool.query(`UPDATE cleaning_tasks SET old_code=NULL WHERE order_id=$1 AND task_type='checkout_clean'`, [o1])
  } else {
    const checkinTask = (db.cleaningTasks as any[]).find((x: any) => String(x.order_id) === o1 && String(x.task_type) === 'checkin_clean')
    const checkoutTask = (db.cleaningTasks as any[]).find((x: any) => String(x.order_id) === o1 && String(x.task_type) === 'checkout_clean')
    if (checkinTask) checkinTask.new_code = '9753'
    if (checkoutTask) checkoutTask.old_code = null
  }
  await syncOrderToCleaningTasks(o1)
  const t1Password = await fetchTask(o1)
  assert.equal(String(t1Password.old_code), '9753', 'checkout old_code should follow checkin new_code for existing orders')

  if (pgPool) {
    await pgPool.query(`UPDATE cleaning_tasks SET task_type=NULL WHERE order_id=$1`, [o1])
    await pgPool.query(`UPDATE cleaning_tasks SET new_code='8642' WHERE order_id=$1 AND type='checkin_clean'`, [o1])
    await pgPool.query(`UPDATE cleaning_tasks SET old_code=NULL WHERE order_id=$1 AND type='checkout_clean'`, [o1])
  } else {
    const checkinTask = (db.cleaningTasks as any[]).find((x: any) => String(x.order_id) === o1 && String(x.type) === 'checkin_clean')
    const checkoutTask = (db.cleaningTasks as any[]).find((x: any) => String(x.order_id) === o1 && String(x.type) === 'checkout_clean')
    if (checkinTask) {
      checkinTask.task_type = null
      checkinTask.new_code = '8642'
    }
    if (checkoutTask) {
      checkoutTask.task_type = null
      checkoutTask.old_code = null
    }
  }
  await syncCheckoutOldCodeFromCheckinNewCode({ orderId: o1 })
  const legacyTaskTypePassword = await fetchTask(o1)
  assert.equal(String(legacyTaskTypePassword.old_code), '8642', 'legacy type-only tasks should still sync checkin new_code to checkout old_code')

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
      `INSERT INTO cleaning_tasks(id, order_id, property_id, task_type, task_date, type, date, status, source, execution_state, manual_task_purpose, auto_sync_enabled, checkin_time, checkout_time, new_code, old_code, guest_special_request, keys_required, nights_override)
       VALUES
         ($1, NULL, 'P_TEST_D', 'checkin_clean', '2026-02-18'::date, 'checkin_clean', '2026-02-18'::date, 'pending', 'manual', 'active', 'temporary_order_placeholder', true, '2pm', NULL, 'manual-new-code', NULL, 'first cleaning inspection', 2, 5),
         ($2, NULL, 'P_TEST_D', 'checkout_clean', '2026-02-21'::date, 'checkout_clean', '2026-02-21'::date, 'pending', 'manual', 'active', 'temporary_order_placeholder', true, NULL, '11am', NULL, 'manual-old-code', NULL, 2, 5),
         ($3, NULL, 'P_TEST_D', 'checkin_clean', '2026-02-18'::date, 'checkin_clean', '2026-02-18'::date, 'pending', 'manual', 'active', 'manual_extra', true, NULL, NULL, NULL, NULL, NULL, 1, NULL),
         ($4, NULL, 'P_TEST_D', 'checkout_clean', '2026-02-21'::date, 'checkout_clean', '2026-02-21'::date, 'in_progress', 'manual', 'active', 'temporary_order_placeholder', true, NULL, NULL, NULL, NULL, NULL, 1, NULL)`,
      [manualCheckin, manualCheckout, manualExtraCheckin, manualCheckoutInProgress],
    )
  } else {
    ;(db.cleaningTasks as any[]).push(
      { id: manualCheckin, order_id: null, property_id: 'P_TEST_D', task_type: 'checkin_clean', task_date: '2026-02-18', type: 'checkin_clean', date: '2026-02-18', status: 'pending', source: 'manual', execution_state: 'active', manual_task_purpose: 'temporary_order_placeholder', auto_sync_enabled: true, checkin_time: '2pm', new_code: 'manual-new-code', guest_special_request: 'first cleaning inspection', keys_required: 2, nights_override: 5 },
      { id: manualCheckout, order_id: null, property_id: 'P_TEST_D', task_type: 'checkout_clean', task_date: '2026-02-21', type: 'checkout_clean', date: '2026-02-21', status: 'pending', source: 'manual', execution_state: 'active', manual_task_purpose: 'temporary_order_placeholder', auto_sync_enabled: true, checkout_time: '11am', old_code: 'manual-old-code', keys_required: 2, nights_override: 5 },
      { id: manualExtraCheckin, order_id: null, property_id: 'P_TEST_D', task_type: 'checkin_clean', task_date: '2026-02-18', type: 'checkin_clean', date: '2026-02-18', status: 'pending', source: 'manual', execution_state: 'active', manual_task_purpose: 'manual_extra', auto_sync_enabled: true },
      { id: manualCheckoutInProgress, order_id: null, property_id: 'P_TEST_D', task_type: 'checkout_clean', task_date: '2026-02-21', type: 'checkout_clean', date: '2026-02-21', status: 'in_progress', source: 'manual', execution_state: 'active', manual_task_purpose: 'temporary_order_placeholder', auto_sync_enabled: true },
    )
  }
  await syncOrderToCleaningTasks(o4)
  const o4Checkin = await fetchTaskByType(o4, 'checkin_clean')
  const o4Checkout = await fetchTaskByType(o4, 'checkout_clean')
  assert.ok(o4Checkin, 'should create canonical checkin task before superseding placeholder')
  assert.ok(o4Checkout, 'should create canonical checkout task before superseding placeholder')
  assert.equal(String(o4Checkin.checkin_time), '2pm', 'canonical checkin should inherit manual placeholder checkin_time over default')
  assert.equal(String(o4Checkin.guest_special_request), 'first cleaning inspection', 'canonical checkin should inherit manual placeholder guest request')
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
  assert.equal(String(eligibleManual.execution_state), 'superseded', 'temporary manual checkin placeholder should be superseded')
  assert.equal(String(eligibleManual.status), 'pending', 'superseded placeholder should keep original status instead of cancelled')
  assert.equal(String(eligibleManual.superseded_by), String(o4Checkin.id))
  assert.ok(supersedeConflicts(eligibleManual).some((item: any) => item.field === 'checkin_time' && item.resolution === 'copied_manual'))
	  assert.ok(supersedeConflicts(eligibleManual).some((item: any) => item.field === 'guest_special_request' && item.resolution === 'copied_manual'))
	  assert.ok(supersedeConflicts(eligibleManual).some((item: any) => item.field === 'new_code' && item.resolution === 'manual_requires_review'))
	  assert.ok(supersedeConflicts(eligibleManual).some((item: any) => item.field === 'keys_required' && item.resolution === 'manual_requires_review'))
	  assert.ok(supersedeConflicts(eligibleManual).some((item: any) => item.field === 'nights_override' && item.resolution === 'manual_requires_review' && Number(item.canonical_value) === 3 && Number(item.manual_value) === 5))
	  assert.equal(String(eligibleManualCheckout.execution_state), 'superseded', 'temporary manual checkout placeholder should be superseded')
  assert.equal(String(eligibleManualCheckout.superseded_by), String(o4Checkout.id))
  assert.ok(supersedeConflicts(eligibleManualCheckout).some((item: any) => item.field === 'checkout_time' && item.resolution === 'copied_manual'))
  assert.ok(supersedeConflicts(eligibleManualCheckout).some((item: any) => item.field === 'old_code' && item.resolution === 'manual_requires_review'))
	  assert.equal(String(extraManual.execution_state), 'active', 'explicit extra manual checkin task must not be superseded')
	  assert.equal(String(extraManual.status), 'pending')
	  assert.equal(String(protectedManual.execution_state), 'active', 'in-progress manual checkout task must not be superseded')
	  assert.equal(String(protectedManual.status), 'in_progress')

	  if (pgPool) {
	    await pgPool.query(
	      `INSERT INTO cleaning_tasks(id, order_id, property_id, task_type, task_date, type, date, status, source, execution_state, manual_task_purpose, auto_sync_enabled, checkin_time, nights_override)
	       VALUES($1, NULL, 'P_TEST_E', 'checkin_clean', '2026-02-24'::date, 'checkin_clean', '2026-02-24'::date, 'pending', 'manual', 'active', 'temporary_order_placeholder', true, '2pm', 0)`,
	      [manualCheckinZeroNights],
	    )
	  } else {
	    ;(db.cleaningTasks as any[]).push({ id: manualCheckinZeroNights, order_id: null, property_id: 'P_TEST_E', task_type: 'checkin_clean', task_date: '2026-02-24', type: 'checkin_clean', date: '2026-02-24', status: 'pending', source: 'manual', execution_state: 'active', manual_task_purpose: 'temporary_order_placeholder', auto_sync_enabled: true, checkin_time: '2pm', nights_override: 0 })
	  }
	  await syncOrderToCleaningTasks(o5)
	  const o5Checkin = await fetchTaskByType(o5, 'checkin_clean')
	  assert.ok(o5Checkin)
	  assert.equal(String(o5Checkin.checkin_time), '2pm', 'canonical checkin should inherit non-default manual placeholder time')
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
    await pgPool.query('DELETE FROM cleaning_sync_logs WHERE order_id = ANY($1)', [[o1, o2, o4, o5, o6, o7]])
    await pgPool.query('DELETE FROM cleaning_tasks WHERE order_id = ANY($1) OR id = ANY($2)', [[o1, o2, o4, o5, o6, o7], [manualCheckin, manualCheckout, manualExtraCheckin, manualCheckoutInProgress, manualCheckinZeroNights]])
    await pgPool.query('DELETE FROM orders WHERE id = ANY($1)', [[o1, o2, o4, o5, o6, o7]])
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
