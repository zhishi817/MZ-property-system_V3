import assert from 'assert'
import { buildCleaningTurnoverDisplay, cleaningTaskNewCodeForDisplay, cleaningTaskOldCodeForDisplay, mergeCleaningTurnoverDisplays, parseCleaningDisplayTimeMinutes } from '../../src/lib/cleaningTurnoverDisplay'

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
  old_code_authority_status: 'source_linked',
  old_code_source_task_id: 'source-checkin',
  old_code_source_order_id: 'checkout-order',
  old_code_source_field: 'new_code',
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
assert.equal(display.old_code_task_id, 'checkout-active')
assert.equal(display.new_code_task_id, 'checkin-active')
assert.equal(display.new_code_authority_status, 'needs_review')
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
assert.equal(merged?.old_code_source_task_id, 'source-checkin')
assert.equal(merged?.old_code_source_order_id, 'checkout-order')
assert.equal(merged?.old_code_source_field, 'new_code')
assert.equal(merged?.new_code_task_id, 'checkin-active')
assert.equal(merged?.new_code_authority_status, 'needs_review')
assert.deepEqual(merged?.active_source_ids, ['checkout-active', 'checkin-active'])
assert.deepEqual(merged?.superseded_source_ids, ['manual-superseded'])

const blankPasswordTargets = buildCleaningTurnoverDisplay({
  checkoutTask: {
    id: 'checkout-blank-password',
    task_type: 'checkout_clean',
    order_id: 'blank-order',
    old_code: null,
    old_code_authority_status: 'needs_review',
  },
  checkinTask: {
    id: 'checkin-blank-password',
    task_type: 'checkin_clean',
    order_id: 'blank-order',
    new_code: null,
    new_code_authority_status: 'needs_review',
  },
  activeRows: [{
    id: 'checkout-blank-password',
    task_type: 'checkout_clean',
    order_id: 'blank-order',
  }],
})
assert.equal(blankPasswordTargets.old_code, null)
assert.equal(blankPasswordTargets.new_code, null)
assert.equal(blankPasswordTargets.old_code_task_id, 'checkout-blank-password', 'an empty old value must not erase its checkout write target')
assert.equal(blankPasswordTargets.new_code_task_id, 'checkin-blank-password', 'an empty new value must not erase its check-in write target')
assert.deepEqual(blankPasswordTargets.active_source_ids, ['checkout-blank-password'], 'write targets must not widen the active execution source set')

const mergedBlankPasswordTargets = mergeCleaningTurnoverDisplays([
  buildCleaningTurnoverDisplay({
    checkoutTask: { id: 'checkout-blank-password', task_type: 'checkout_clean', order_id: 'blank-order' },
    activeRows: [{ id: 'checkout-blank-password', task_type: 'checkout_clean', order_id: 'blank-order' }],
  }),
  buildCleaningTurnoverDisplay({
    checkinTask: { id: 'checkin-blank-password', task_type: 'checkin_clean', order_id: 'blank-order' },
    activeRows: [],
  }),
])
assert.equal(mergedBlankPasswordTargets?.old_code_task_id, 'checkout-blank-password')
assert.equal(mergedBlankPasswordTargets?.new_code_task_id, 'checkin-blank-password')
assert.deepEqual(mergedBlankPasswordTargets?.active_source_ids, ['checkout-blank-password'])

const ambiguousPasswordTargets = mergeCleaningTurnoverDisplays([
  buildCleaningTurnoverDisplay({ checkinTask: { id: 'checkin-candidate-a', task_type: 'checkin_clean', order_id: 'order-a' } }),
  buildCleaningTurnoverDisplay({ checkinTask: { id: 'checkin-candidate-b', task_type: 'checkin_clean', order_id: 'order-b' } }),
])
assert.equal(ambiguousPasswordTargets?.new_code_task_id, null, 'multiple distinct check-in targets must fail closed')

const staleFallbackHidden = buildCleaningTurnoverDisplay({
  checkoutTask: {
    id: 'checkout-stale',
    task_type: 'checkout_clean',
    order_id: 'checkout-stale-order',
    old_code: 'historical-value',
    old_code_authority_status: 'needs_review',
  },
  checkinTask: {
    id: 'next-checkin-stale',
    task_type: 'checkin_clean',
    order_id: 'next-order',
    old_code: 'older-history',
    old_code_authority_status: 'source_linked',
    old_code_source_task_id: 'older-source',
    old_code_source_order_id: 'older-order',
    old_code_source_field: 'new_code',
  },
})
assert.equal(staleFallbackHidden.old_code, null, 'a merged card must not fall back from an untrusted checkout value to the next check-in history')

const mismatchedSourceOrderHidden = buildCleaningTurnoverDisplay({
  checkoutTask: {
    ...checkoutTask,
    old_code_source_order_id: 'different-order',
  },
})
assert.equal(mismatchedSourceOrderHidden.old_code, null, 'source-linked metadata from a different order must never authorize display')

const localManualCorrection = buildCleaningTurnoverDisplay({
  checkoutTask: {
    ...checkoutTask,
    old_code: 'current-task-correction',
    old_code_authority_status: 'manual_confirmed',
    old_code_source_field: 'manual',
  },
  checkinTask,
})
assert.equal(localManualCorrection.old_code, 'current-task-correction', 'an explicit current-task correction remains visible on the merged card')
assert.equal(localManualCorrection.old_code_task_id, 'checkout-active')

const checkinOldCodeHidden = buildCleaningTurnoverDisplay({
  checkinTask: {
    ...checkinTask,
    old_code: 'not-a-checkout-password',
    old_code_authority_status: 'manual_confirmed',
    old_code_source_field: 'manual',
  },
})
assert.equal(checkinOldCodeHidden.old_code, null, 'an arrival task old_code is not a checkout password source even when legacy metadata marked it manual')
assert.equal(cleaningTaskOldCodeForDisplay({
  ...checkinTask,
  old_code: 'not-a-checkout-password',
  old_code_authority_status: 'manual_confirmed',
  old_code_source_field: 'manual',
}), null, 'single-task APIs must also hide an arrival task old_code')
assert.equal(cleaningTaskNewCodeForDisplay({
  ...checkoutTask,
  new_code: 'not-a-checkin-password',
  new_code_authority_status: 'manual_confirmed',
}), null, 'single-task APIs must hide a legacy checkout new_code')
assert.equal(cleaningTaskNewCodeForDisplay(checkinTask), '2222', 'a check-in task keeps its own new_code visible')
assert.equal(cleaningTaskNewCodeForDisplay({ type: 'checkin_clean', new_code: 'legacy-checkin-new' }), 'legacy-checkin-new', 'legacy type-only check-ins remain valid new-code sources')
assert.equal(cleaningTaskOldCodeForDisplay({
  type: 'checkout_clean',
  order_id: 'legacy-checkout-order',
  old_code: 'legacy-checkout-old',
  old_code_authority_status: 'source_linked',
  old_code_source_task_id: 'legacy-checkin-source',
  old_code_source_order_id: 'legacy-checkout-order',
  old_code_source_field: 'new_code',
}), 'legacy-checkout-old', 'legacy type-only checkouts retain a source-linked old code')

const legacyValueHidden = buildCleaningTurnoverDisplay({
  checkoutTask: { id: 'legacy-checkout', task_type: 'checkout_clean', order_id: 'legacy-order', old_code: 'legacy-value' },
})
assert.equal(legacyValueHidden.old_code, null, 'a legacy value without authority must not be displayed')

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
