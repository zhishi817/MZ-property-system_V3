import assert from 'assert'
import {
  activeCleaningTaskWhereSql,
  isCancelledCleaningTaskStatus,
  isInactiveCleaningOrderStatus,
  validCleaningTaskOrderWhereSql,
} from '../../src/services/cleaningSync'

function testCancelledTaskStatus() {
  assert.equal(isCancelledCleaningTaskStatus('cancelled'), true)
  assert.equal(isCancelledCleaningTaskStatus('canceled'), true)
  assert.equal(isCancelledCleaningTaskStatus('CANCELLED'), true)
  assert.equal(isCancelledCleaningTaskStatus('assigned'), false)
  assert.equal(isCancelledCleaningTaskStatus(''), false)
}

function testInactiveOrderStatus() {
  assert.equal(isInactiveCleaningOrderStatus('invalid'), true)
  assert.equal(isInactiveCleaningOrderStatus('cancelled'), true)
  assert.equal(isInactiveCleaningOrderStatus('Airbnb Cancelled'), true)
  assert.equal(isInactiveCleaningOrderStatus(''), true)
  assert.equal(isInactiveCleaningOrderStatus('confirmed'), false)
}

function testSqlHelpers() {
  const activeSql = activeCleaningTaskWhereSql('t')
  assert.ok(activeSql.includes('COALESCE(t.execution_state'))
  assert.ok(activeSql.includes("lower(COALESCE(t.status, '')) NOT IN ('cancelled','canceled')"))

  const orderSql = validCleaningTaskOrderWhereSql('t', 'o')
  assert.ok(orderSql.includes('t.order_id IS NULL'))
  assert.ok(orderSql.includes('o.id IS NOT NULL'))
  assert.ok(orderSql.includes("lower(COALESCE(o.status, '')) <> 'invalid'"))
  assert.ok(orderSql.includes("lower(COALESCE(o.status, '')) NOT LIKE '%cancel%'"))
}

function main() {
  testCancelledTaskStatus()
  testInactiveOrderStatus()
  testSqlHelpers()
  process.stdout.write('ok\n')
}

main()
