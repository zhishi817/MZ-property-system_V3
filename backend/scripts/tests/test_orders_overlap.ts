import { __test } from '../../src/modules/orders'

function assert(cond: any, msg: string) {
  if (!cond) throw new Error(msg)
}

const { rangesOverlap, isInactiveOrderStatus, dayOnly } = __test

assert(dayOnly('2026-03-25') === '2026-03-25', 'dayOnly should keep YYYY-MM-DD')
assert(dayOnly('2026-03-25T12:00:00') === '2026-03-25', 'dayOnly should slice ISO')

assert(rangesOverlap('2026-03-25', '2026-03-26', '2026-03-24', '2026-03-25') === false, 'touching ranges should not overlap')
assert(rangesOverlap('2026-03-25', '2026-03-26', '2026-03-26', '2026-03-27') === false, 'touching ranges should not overlap 2')
assert(rangesOverlap('2026-03-25', '2026-03-26', '2026-03-25', '2026-03-26') === true, 'same ranges should overlap')
assert(rangesOverlap('2026-03-25T12:00:00', '2026-03-26T11:59:59', '2026-03-24T12:00:00', '2026-03-25T11:59:59') === false, 'iso touching should not overlap')

assert(isInactiveOrderStatus('cancelled') === true, 'cancelled should be inactive')
assert(isInactiveOrderStatus('canceled') === true, 'canceled should be inactive')
assert(isInactiveOrderStatus('confirmed') === false, 'confirmed should be active')

console.log('ok')

