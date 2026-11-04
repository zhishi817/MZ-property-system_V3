import { expect, test } from 'vitest'
import { turnoverEditPersistedSignature, validateTurnoverEditMutationIsolation, validateTurnoverEditPlan } from './cleaningTurnoverEditPlan'

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
