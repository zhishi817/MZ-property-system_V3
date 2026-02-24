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

  const orders = [
    { id: o1, property_id: 'P_TEST_A', checkin: '2026-02-10', checkout: '2026-02-12', status: 'confirmed', confirmation_code: `TEST_SYNC_${o1.slice(0, 8)}` },
    { id: o2, property_id: 'P_TEST_B', checkin: '2026-02-11', checkout: '2026-02-13', status: 'confirmed', confirmation_code: `TEST_SYNC_${o2.slice(0, 8)}` },
    { id: o3, property_id: 'P_TEST_C', checkin: '2026-02-12', checkout: '2026-02-14', status: 'confirmed', confirmation_code: `TEST_SYNC_${o3.slice(0, 8)}` },
  ]

  if (pgPool) {
    await ensureCleaningSchemaV2()
    await pgPool.query('DELETE FROM cleaning_sync_logs WHERE order_id = ANY($1)', [[o1, o2, o3]])
    await pgPool.query('DELETE FROM cleaning_tasks WHERE order_id = ANY($1)', [[o1, o2, o3]])
    await pgPool.query('DELETE FROM orders WHERE id = ANY($1)', [[o1, o2, o3]])
    for (const o of orders) {
      await pgPool.query(
        `INSERT INTO orders(id, property_id, checkin, checkout, status, confirmation_code)
         VALUES($1,$2,$3::date,$4::date,$5,$6)`,
        [o.id, o.property_id, o.checkin, o.checkout, o.status, o.confirmation_code]
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
  const t1di = await fetchTaskByType(o1, 'checkin_clean')
  assert.ok(t1di)
  assert.equal(String(t1di.status), 'cancelled')

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
    await pgPool.query('DELETE FROM cleaning_sync_logs WHERE order_id = ANY($1)', [[o1, o2]])
    await pgPool.query('DELETE FROM cleaning_tasks WHERE order_id = ANY($1)', [[o1, o2]])
    await pgPool.query('DELETE FROM orders WHERE id = ANY($1)', [[o1, o2]])
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
