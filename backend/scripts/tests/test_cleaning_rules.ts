import assert from 'assert'
import { computeCleaningTaskFields } from '../../src/services/cleaningRules'

function testBasic() {
  const order: any = {
    id: 'o1',
    property_id: 'p1',
    checkin: '2026-02-17T12:00:00Z',
    checkout: '2026-02-20T11:00:00Z',
    status: 'confirmed',
    cleaning_fee: 120,
    guest_name: 'Alice',
    confirmation_code: 'ABC123',
  }
  const property: any = { id: 'p1', code: 'MSQ402', capacity: 2, type: 'apartment' }
  const a = computeCleaningTaskFields(order, property, 'checkout_cleaning', '2026-02-17')
  assert.equal(a.date, '2026-02-20')
  assert.equal(a.rooms, 2)
  assert.ok(['medium','high','urgent'].includes(a.priority))
  assert.ok(a.content.includes('property:MSQ402'))
  assert.ok(a.content.includes('type:checkout_cleaning'))
}

function testDeepRaisesPriority() {
  const order: any = {
    id: 'o2',
    property_id: 'p2',
    checkin: '2026-02-17',
    checkout: '2026-02-18',
    status: 'confirmed',
    cleaning_fee: 250,
  }
  const property: any = { id: 'p2', code: 'ZZZ1', capacity: 1, type: 'apartment' }
  const s = computeCleaningTaskFields(order, property, 'checkout_cleaning', '2026-02-17')
  assert.equal(s.service_type, 'deep')
  assert.equal(s.priority, 'urgent')
}

function testCheckinTaskDate() {
  const order: any = {
    id: 'o3',
    property_id: 'p3',
    checkin: '2026-02-19T12:00:00Z',
    checkout: '2026-02-20T11:00:00Z',
    status: 'confirmed',
    cleaning_fee: 0,
  }
  const property: any = { id: 'p3', code: 'X1', capacity: 5, type: 'apartment' }
  const s = computeCleaningTaskFields(order, property, 'checkin_cleaning', '2026-02-17')
  assert.equal(s.date, '2026-02-19')
  assert.ok(['high','urgent'].includes(s.priority))
}

function testNightsMismatchCheckoutCorrected() {
  const order: any = {
    id: 'o4',
    property_id: 'p4',
    checkin: '2026-02-01',
    checkout: '2026-02-05',
    nights: 9,
    status: 'confirmed',
    cleaning_fee: 0,
  }
  const property: any = { id: 'p4', code: '3803102', capacity: 2, type: 'apartment' }
  const s = computeCleaningTaskFields(order, property, 'checkout_cleaning', '2026-02-01')
  assert.equal(s.date, '2026-02-10')
}

function testNightsInferCheckoutIfMissing() {
  const order: any = {
    id: 'o5',
    property_id: 'p5',
    checkin: '2026-02-01',
    checkout: null,
    nights: 9,
    status: 'confirmed',
    cleaning_fee: 0,
  }
  const property: any = { id: 'p5', code: '3803102', capacity: 2, type: 'apartment' }
  const s = computeCleaningTaskFields(order, property, 'checkout_cleaning', '2026-02-01')
  assert.equal(s.date, '2026-02-10')
}

function testCheckoutBeforeCheckinCorrected() {
  const order: any = {
    id: 'o6',
    property_id: 'p6',
    checkin: '2026-02-10',
    checkout: '2026-02-05',
    nights: 9,
    status: 'confirmed',
    cleaning_fee: 0,
  }
  const property: any = { id: 'p6', code: 'X', capacity: 1, type: 'apartment' }
  const s = computeCleaningTaskFields(order, property, 'checkout_cleaning', '2026-02-01')
  assert.equal(s.date, '2026-02-19')
}

function main() {
  testBasic()
  testDeepRaisesPriority()
  testCheckinTaskDate()
  testNightsMismatchCheckoutCorrected()
  testNightsInferCheckoutIfMissing()
  testCheckoutBeforeCheckinCorrected()
  process.stdout.write('ok\n')
}

main()
