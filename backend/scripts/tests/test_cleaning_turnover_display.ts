import assert from 'assert'
import { buildCleaningTurnoverDisplay, mergeCleaningTurnoverDisplays, parseCleaningDisplayTimeMinutes } from '../../src/lib/cleaningTurnoverDisplay'

assert.equal(parseCleaningDisplayTimeMinutes('10am'), 600)
assert.equal(parseCleaningDisplayTimeMinutes('3pm'), 900)
assert.equal(parseCleaningDisplayTimeMinutes('14:30'), 870)

const checkoutTask = {
  id: 'checkout-active',
  task_type: 'checkout_clean',
  order_id: 'checkout-order',
  property_id: 'P1',
  task_date: '2026-06-29',
  checkout_time: '12pm',
  old_code: '1111',
  order_note: 'late checkout bags',
  order_keys_required: 2,
  order_checkin: '2026-06-25',
  order_checkout: '2026-06-29',
  order_nights: 4,
}

const checkinTask = {
  id: 'checkin-active',
  task_type: 'checkin_clean',
  order_id: 'checkin-order',
  property_id: 'P1',
  task_date: '2026-06-29',
  checkin_time: '2pm',
  new_code: '2222',
  order_note: 'early arrival',
  order_keys_required: 1,
  order_checkin: '2026-06-29',
  order_checkout: '2026-07-02',
  order_nights: 3,
}

const supersededManual = {
  id: 'manual-superseded',
  task_type: 'checkin_clean',
  property_id: 'P1',
  task_date: '2026-06-29',
  checkin_time: '5pm',
  new_code: '3333',
  guest_special_request: 'manual request',
  keys_required: 2,
  nights_override: 2,
}

const display = buildCleaningTurnoverDisplay({
  propertyId: 'P1',
  taskDate: '2026-06-29',
  checkoutTask,
  checkinTask,
  activeRows: [checkoutTask, checkinTask],
  supersededRows: [supersededManual],
})

assert.equal(display.checkout_order_id, 'checkout-order')
assert.equal(display.checkin_order_id, 'checkin-order')
assert.equal(display.checkout_time, '12pm')
assert.equal(display.checkin_time, '2pm')
assert.equal(display.is_late_checkout, true)
assert.equal(display.is_early_checkin, true)
assert.equal(display.is_late_checkin, false)
assert.equal(display.guest_request_checkout, 'late checkout bags')
assert.equal(display.guest_request_checkin, 'early arrival')
assert.equal(display.old_code, '1111')
assert.equal(display.new_code, '2222')
assert.equal(display.keys_required_checkout, 2)
assert.equal(display.keys_required_checkin, 1)
assert.equal(display.stayed_nights, 4)
assert.equal(display.remaining_nights, 3)
assert.deepEqual(display.active_source_ids, ['checkout-active', 'checkin-active'])
assert.deepEqual(display.superseded_source_ids, ['manual-superseded'])
assert.deepEqual(display.all_related_source_ids, ['checkout-active', 'checkin-active', 'manual-superseded'])
assert.ok(display.conflicts.some((item) => item.field === 'checkin_time' && item.manual_value === '5pm' && item.canonical_value === '2pm'))
assert.ok(display.conflicts.some((item) => item.field === 'keys_required' && item.manual_value === 2 && item.canonical_value === 1))
assert.ok(display.conflicts.some((item) => item.field === 'nights' && item.manual_value === 2 && item.canonical_value === 3))

const displayWithZeroNightPlaceholder = buildCleaningTurnoverDisplay({
  propertyId: 'P1',
  taskDate: '2026-06-29',
  checkinTask,
  activeRows: [checkinTask],
  supersededRows: [{
    id: 'manual-zero-night-placeholder',
    task_type: 'checkin_clean',
    property_id: 'P1',
    task_date: '2026-06-29',
    checkin_time: '2pm',
    nights_override: 0,
  }],
})
assert.equal(displayWithZeroNightPlaceholder.conflicts.some((item) => item.field === 'nights'), false)

const displayWithPlaceholderOrderNote = buildCleaningTurnoverDisplay({
  propertyId: 'P1',
  taskDate: '2026-08-03',
  checkinTask: {
    id: 'checkin-placeholder-note',
    task_type: 'checkin_clean',
    order_id: 'checkin-order-placeholder-note',
    property_id: 'P1',
    task_date: '2026-08-03',
    order_note: ' NULL ',
    guest_special_request: 'first cleaning inspection',
  },
  activeRows: [
    {
      id: 'checkin-placeholder-note',
      task_type: 'checkin_clean',
      order_id: 'checkin-order-placeholder-note',
      property_id: 'P1',
      task_date: '2026-08-03',
      order_note: 'undefined',
      guest_special_request: 'first cleaning inspection',
    },
  ],
})

assert.equal(displayWithPlaceholderOrderNote.guest_request_checkin, 'first cleaning inspection')
assert.equal(displayWithPlaceholderOrderNote.guest_request_summary, 'first cleaning inspection')

const merged = mergeCleaningTurnoverDisplays([
  buildCleaningTurnoverDisplay({ propertyId: 'P1', taskDate: '2026-06-29', checkoutTask, activeRows: [checkoutTask] }),
  buildCleaningTurnoverDisplay({ propertyId: 'P1', taskDate: '2026-06-29', checkinTask, activeRows: [checkinTask], supersededRows: [supersededManual] }),
])

assert.ok(merged)
assert.equal(merged?.checkout_order_id, 'checkout-order')
assert.equal(merged?.checkin_order_id, 'checkin-order')
assert.equal(merged?.checkout_time, '12pm')
assert.equal(merged?.checkin_time, '2pm')
assert.deepEqual(merged?.active_source_ids, ['checkout-active', 'checkin-active'])
assert.deepEqual(merged?.superseded_source_ids, ['manual-superseded'])

const taskCenterMergedDisplay = buildCleaningTurnoverDisplay({
  propertyId: 'P2',
  taskDate: '2026-07-05',
  checkoutTask: {
    taskId: 'task-center-checkout',
    taskType: 'checkout_clean',
    orderId: 'checkout-order-2',
    summary_checkout_time: '11:30am',
  },
  checkinTask: {
    taskId: 'task-center-checkin',
    taskType: 'checkin_clean',
    orderId: 'checkin-order-2',
    summary_checkin_time: '5pm',
    nights: 3,
  },
  activeRows: [
    {
      taskId: 'task-center-checkin',
      taskType: 'checkin_clean',
      orderId: 'checkin-order-2',
      summary_checkin_time: '5pm',
      nights: 3,
    },
    {
      taskId: 'task-center-checkout',
      taskType: 'checkout_clean',
      orderId: 'checkout-order-2',
      summary_checkout_time: '11:30am',
    },
  ],
})

assert.equal(taskCenterMergedDisplay.checkout_time, '11:30am')
assert.equal(taskCenterMergedDisplay.checkin_time, '5pm')
assert.equal(taskCenterMergedDisplay.is_late_checkout, true)
assert.equal(taskCenterMergedDisplay.is_early_checkin, false)
assert.equal(taskCenterMergedDisplay.is_late_checkin, true)
assert.equal(taskCenterMergedDisplay.remaining_nights, 3)

process.stdout.write('test_cleaning_turnover_display: ok\n')
