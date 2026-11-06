import { expect, test, vi } from 'vitest'
import { buildTurnoverAtomicEditItems, exactCleaningCardEditSourceIds, normalizeAtomicOrderKeyUpdates, resolveTurnoverEditOperation, turnoverEditPersistedSignature, validateTurnoverEditMutationIsolation, validateTurnoverEditPlan } from './cleaningTurnoverEditPlan'

test('keeps the clicked card exact when another same-property/day task exists', () => {
  const clickedPair = ['checkout-linked', 'checkin-linked']
  const unrelatedSameScope = ['checkin-independent']
  expect(exactCleaningCardEditSourceIds(clickedPair)).toEqual(clickedPair)
  expect(exactCleaningCardEditSourceIds(unrelatedSameScope)).toEqual(unrelatedSameScope)
})

test('rejects cross-day add/link plans before any mutation', () => {
  expect(validateTurnoverEditPlan({
    pendingAddCheckin: true,
    checkoutDate: '2026-11-04',
    checkinDate: '2026-11-05',
    initialCheckoutDate: '2026-11-04',
    initialCheckinDate: '2026-11-05',
  })?.code).toBe('cross_day_relation')
})

test('requires an existing task date change to be saved before creating its counterpart', () => {
  expect(validateTurnoverEditPlan({
    pendingAddCheckout: true,
    checkoutDate: '2026-11-04',
    checkinDate: '2026-11-04',
    initialCheckoutDate: '2026-11-04',
    initialCheckinDate: '2026-11-03',
  })?.code).toBe('existing_date_unsaved')
})

test('same-day unchanged topology is safe to submit', () => {
  expect(validateTurnoverEditPlan({
    pendingAddCheckout: true,
    checkoutDate: '2026-11-04',
    checkinDate: '2026-11-04',
    initialCheckoutDate: '2026-11-04',
    initialCheckinDate: '2026-11-04',
  })).toBeNull()
})

test('persisted signature detects other unsaved edits before a standalone link action closes the drawer', () => {
  const base = {
    checkoutDate: '2026-11-04',
    checkinDate: '2026-11-04',
    status: 'assigned',
    cleanerId: 'cleaner-1',
    inspectorId: 'inspector-1',
    inspectionScope: 'inspect_and_hang',
    keysRequiredCheckin: 1,
    keysRequiredCheckout: 1,
    guestSpecialRequest: '',
    nightsOverride: null,
    checkoutPassword: '',
    checkinPassword: '',
    checkoutTime: '10am',
    checkinTime: '3pm',
  }
  expect(turnoverEditPersistedSignature({ ...base, guestSpecialRequest: 'late arrival' }))
    .not.toBe(turnoverEditPersistedSignature(base))
})

test('adding checkout permits only new-checkout fields and blocks existing checkin mutations', () => {
  const initial = turnoverEditPersistedSignature({
    checkoutDate: '2026-11-04', checkinDate: '2026-11-04', status: 'assigned', cleanerId: 'cleaner-1', inspectorId: null,
    inspectionScope: 'inspect_and_hang', keysRequiredCheckin: 1, keysRequiredCheckout: 1, guestSpecialRequest: '', nightsOverride: 2,
    checkoutPassword: '', checkinPassword: '2222', checkoutTime: '10am', checkinTime: '3pm',
  })
  expect(validateTurnoverEditMutationIsolation({
    pendingAddCheckout: true,
    initialSignature: initial,
    currentSignature: turnoverEditPersistedSignature({
      checkoutDate: '2026-11-04', checkinDate: '2026-11-04', status: 'assigned', cleanerId: 'cleaner-1', inspectorId: null,
      inspectionScope: 'inspect_and_hang', keysRequiredCheckin: 1, keysRequiredCheckout: 2, guestSpecialRequest: '', nightsOverride: 2,
      checkoutPassword: '1111', checkinPassword: '2222', checkoutTime: '11am', checkinTime: '3pm',
    }),
  })).toBeNull()
  expect(validateTurnoverEditMutationIsolation({
    pendingAddCheckout: true,
    initialSignature: initial,
    currentSignature: turnoverEditPersistedSignature({
      checkoutDate: '2026-11-04', checkinDate: '2026-11-04', status: 'assigned', cleanerId: 'cleaner-1', newCheckoutCleanerId: 'checkout-cleaner', inspectorId: null,
      inspectionScope: 'inspect_and_hang', keysRequiredCheckin: 1, keysRequiredCheckout: 1, guestSpecialRequest: '', nightsOverride: 2,
      checkoutPassword: '', checkinPassword: '2222', checkoutTime: '10am', checkinTime: '3pm',
    }),
  })).toBeNull()
  expect(validateTurnoverEditMutationIsolation({
    pendingAddCheckout: true,
    initialSignature: initial,
    currentSignature: initial.replace('"status":"assigned"', '"status":"completed"'),
  })?.code).toBe('existing_date_unsaved')
})

test('adding checkin permits only new-checkin fields and blocks existing checkout mutations', () => {
  const initial = turnoverEditPersistedSignature({
    checkoutDate: '2026-11-04', checkinDate: '2026-11-04', status: 'assigned', cleanerId: 'cleaner-1', inspectorId: 'inspector-1',
    inspectionScope: 'inspect_and_hang', keysRequiredCheckin: 1, keysRequiredCheckout: 1, guestSpecialRequest: '', nightsOverride: null,
    checkoutPassword: '1111', checkinPassword: '', checkoutTime: '10am', checkinTime: '3pm',
  })
  expect(validateTurnoverEditMutationIsolation({
    pendingAddCheckin: true,
    initialSignature: initial,
    currentSignature: turnoverEditPersistedSignature({
      checkoutDate: '2026-11-04', checkinDate: '2026-11-04', status: 'assigned', cleanerId: 'cleaner-1', inspectorId: 'inspector-1',
      inspectionScope: 'inspect_and_hang', keysRequiredCheckin: 2, keysRequiredCheckout: 1, guestSpecialRequest: '', nightsOverride: 3,
      checkoutPassword: '1111', checkinPassword: '3333', checkoutTime: '10am', checkinTime: '4pm',
    }),
  })).toBeNull()
  expect(validateTurnoverEditMutationIsolation({
    pendingAddCheckin: true,
    initialSignature: initial,
    currentSignature: initial.replace('"checkoutTime":"10am"', '"checkoutTime":"11am"'),
  })?.code).toBe('existing_date_unsaved')
})

test('atomic edit operation id is opaque, stable for a lost response and rotates for a later edit', () => {
  const firstSignature = '{"checkoutPassword":"SYNTH-LOW-ENTROPY-A","guest":"first"}'
  const first = resolveTurnoverEditOperation({
    previous: null,
    persistedSignature: firstSignature,
    createOperationId: () => 'opaque-random-operation-1',
  })
  expect(first.operationId).toBe('opaque-random-operation-1')
  expect(first.operationId).not.toContain('SYNTH-LOW-ENTROPY-A')

  const retryFactory = vi.fn(() => 'must-not-be-used')
  expect(resolveTurnoverEditOperation({
    previous: first,
    persistedSignature: firstSignature,
    createOperationId: retryFactory,
  })).toEqual(first)
  expect(retryFactory).not.toHaveBeenCalled()

  const later = resolveTurnoverEditOperation({
    previous: first,
    persistedSignature: '{"checkoutPassword":"SYNTH-LOW-ENTROPY-B","guest":"second"}',
    createOperationId: () => 'opaque-random-operation-2',
  })
  expect(later.operationId).toBe('opaque-random-operation-2')
  expect(later.operationId).not.toContain('SYNTH-LOW-ENTROPY-B')
  expect(later.operationId).not.toBe(first.operationId)
})

test('atomic edit operation id is never derived from a low-entropy password snapshot', () => {
  const operationFor = (persistedSignature: string) => resolveTurnoverEditOperation({
    previous: null,
    persistedSignature,
    createOperationId: () => 'same-test-randomness',
  }).operationId
  expect(operationFor('{"checkoutPassword":"SYNTH-LOW-ENTROPY-A"}')).toBe('same-test-randomness')
  expect(operationFor('{"checkoutPassword":"SYNTH-LOW-ENTROPY-B"}')).toBe('same-test-randomness')
})

test('atomic items preserve task-specific password, time and key payloads', () => {
  const items = buildTurnoverAtomicEditItems({
    ids: ['checkin-1', 'checkout-1'],
    checkoutIds: ['checkout-1'],
    checkinIds: ['checkin-1'],
    basePatch: { guest_special_request: 'shared request', status: 'assigned' },
    checkoutPatch: {
      checkout_time: '11am',
      old_code: 'SYNTH-OLD',
      password_verification: { fields: ['old_code'], request_id: 'operation-1', client: 'web' },
    },
    checkinPatch: {
      task_date: '2026-11-06',
      checkin_time: '4pm',
      new_code: 'SYNTH-NEW',
      nights_override: 3,
      password_verification: { fields: ['new_code'], request_id: 'operation-1', client: 'web' },
    },
    manualKeysByTaskId: { 'checkout-1': 1, 'checkin-1': 2 },
  })
  expect(items).toEqual([
    {
      id: 'checkin-1',
      patch: {
        guest_special_request: 'shared request', status: 'assigned', task_date: '2026-11-06', checkin_time: '4pm',
        new_code: 'SYNTH-NEW', nights_override: 3,
        password_verification: { fields: ['new_code'], request_id: 'operation-1', client: 'web' }, keys_required: 2,
      },
    },
    {
      id: 'checkout-1',
      patch: {
        guest_special_request: 'shared request', status: 'assigned', checkout_time: '11am', old_code: 'SYNTH-OLD',
        password_verification: { fields: ['old_code'], request_id: 'operation-1', client: 'web' }, keys_required: 1,
      },
    },
  ])
  expect(items[0].patch).not.toHaveProperty('old_code')
  expect(items[0].patch).not.toHaveProperty('checkout_time')
  expect(items[1].patch).not.toHaveProperty('new_code')
  expect(items[1].patch).not.toHaveProperty('checkin_time')
})

test('order key updates reject conflicting values without merging task payloads', () => {
  expect(normalizeAtomicOrderKeyUpdates([
    { order_id: 'checkout-order', keys_required: 1 },
    { order_id: 'checkin-order', keys_required: 2 },
  ])).toEqual([
    { order_id: 'checkin-order', keys_required: 2 },
    { order_id: 'checkout-order', keys_required: 1 },
  ])
  expect(() => normalizeAtomicOrderKeyUpdates([
    { order_id: 'same-order', keys_required: 1 },
    { order_id: 'same-order', keys_required: 2 },
  ])).toThrow('同一订单不能在一次保存中设置不同的钥匙套数')
})
