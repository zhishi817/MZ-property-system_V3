import assert from 'assert'
import { v4 as uuid } from 'uuid'
import { pgPool } from '../../src/dbAdapter'
import { ensureCleaningSchemaV2, syncOrderToCleaningTasks, backfillCleaningTasks } from '../../src/services/cleaningSync'
import { db } from '../../src/store'

async function fetchTask(orderId: string) {
  if (pgPool) {
    const r = await pgPool.query(
      `SELECT * FROM cleaning_tasks WHERE order_id=$1 AND task_type='checkout_clean' LIMIT 1`,
      [orderId]
    )
    return r?.rows?.[0] || null
  }
  return (db.cleaningTasks as any[]).find((t: any) => String(t.order_id) === String(orderId) && String(t.task_type) === 'checkout_clean') || null
}

async function fetchTaskByType(orderId: string, taskType: string) {
  if (pgPool) {
    const r = await pgPool.query(
      `SELECT * FROM cleaning_tasks WHERE order_id=$1 AND task_type=$2 LIMIT 1`,
      [orderId, taskType]
    )
    return r?.rows?.[0] || null
  }
  return (db.cleaningTasks as any[]).find((t: any) => String(t.order_id) === String(orderId) && String(t.task_type) === String(taskType)) || null
}

async function main() {
  const o1 = uuid()
  const o2 = uuid()
  const o3 = uuid()
  const o4 = uuid()
  const o5 = uuid()
  const manualCheckin = uuid()
  const manualCheckout = uuid()
  const manualExtraCheckin = uuid()
  const manualCheckoutInProgress = uuid()
  const manualCheckinZeroNights = uuid()

  const orders = [
    { id: o1, property_id: 'P_TEST_A', checkin: '2026-02-10', checkout: '2026-02-12', nights: 2, status: 'confirmed', confirmation_code: `TEST_SYNC_${o1.slice(0, 8)}` },
    { id: o2, property_id: 'P_TEST_B', checkin: '2026-02-11', checkout: '2026-02-13', nights: 2, status: 'confirmed', confirmation_code: `TEST_SYNC_${o2.slice(0, 8)}` },
    { id: o3, property_id: 'P_TEST_C', checkin: '2026-02-12', checkout: '2026-02-14', nights: 2, status: 'confirmed', confirmation_code: `TEST_SYNC_${o3.slice(0, 8)}` },
    { id: o4, property_id: 'P_TEST_D', checkin: '2026-02-18', checkout: '2026-02-21', nights: 3, status: 'confirmed', confirmation_code: `TEST_SYNC_${o4.slice(0, 8)}` },
    { id: o5, property_id: 'P_TEST_E', checkin: '2026-02-24', checkout: '2026-02-28', nights: 4, status: 'confirmed', confirmation_code: `TEST_SYNC_${o5.slice(0, 8)}` },
  ]

  if (pgPool) {
    await ensureCleaningSchemaV2()
    await pgPool.query('DELETE FROM cleaning_sync_logs WHERE order_id = ANY($1)', [[o1, o2, o3, o4, o5]])
    await pgPool.query('DELETE FROM cleaning_tasks WHERE order_id = ANY($1) OR id = ANY($2)', [[o1, o2, o3, o4, o5], [manualCheckin, manualCheckout, manualExtraCheckin, manualCheckoutInProgress, manualCheckinZeroNights]])
    await pgPool.query('DELETE FROM orders WHERE id = ANY($1)', [[o1, o2, o3, o4, o5]])
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
	    await pgPool.query('DELETE FROM cleaning_sync_logs WHERE order_id = ANY($1)', [[o1, o2, o4, o5]])
	    await pgPool.query('DELETE FROM cleaning_tasks WHERE order_id = ANY($1) OR id = ANY($2)', [[o1, o2, o4, o5], [manualCheckin, manualCheckout, manualExtraCheckin, manualCheckoutInProgress, manualCheckinZeroNights]])
	    await pgPool.query('DELETE FROM orders WHERE id = ANY($1)', [[o1, o2, o4, o5]])
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
