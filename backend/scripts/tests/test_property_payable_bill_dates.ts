import assert from 'assert'
import {
  computeMonthDayISO,
  computeOptionalMonthDayISO,
  computePropertyPayableTemplateDates,
  isPropertyPayableReceiptPaymentOverdue,
  isDueMonthKey,
  normalizePropertyPayableFrequencyMonths,
  resolvePropertyPayableCalendarSchedule,
} from '../../src/modules/recurring'

assert.equal(computeMonthDayISO('2026-02', 31, 0), '2026-02-28', 'non-leap February should fall back to last day')
assert.equal(computeMonthDayISO('2028-02', 31, 0), '2028-02-29', 'leap February should fall back to leap day')
assert.equal(computeMonthDayISO('2026-03', 31, -1), '2026-02-28', 'offset month should apply before month-end fallback')
assert.equal(computeOptionalMonthDayISO('2026-02', null, 0), null, 'blank optional day should stay blank')
assert.equal(computeOptionalMonthDayISO('2026-02', '', 0), null, 'empty optional day should stay blank')
assert.equal(computeOptionalMonthDayISO('2026-02', 31, 0), '2026-02-28', 'optional day should still use month-end fallback')

const dates = computePropertyPayableTemplateDates({
  due_day_of_month: 5,
  bill_expected_day_of_month: 30,
  bill_period_start_day_of_month: 31,
  bill_period_start_month_offset: -1,
  bill_period_end_day_of_month: 31,
  bill_period_end_month_offset: 0,
}, '2026-02')

assert.deepEqual(dates, {
  due_date: '2026-02-28',
  bill_expected_date: '2026-02-28',
  bill_period_start: null,
  bill_period_end: null,
})

assert.deepEqual(computePropertyPayableTemplateDates({
  bill_expected_day_of_month: null,
}, '2026-02'), {
  due_date: '2026-02-28',
  bill_expected_date: null,
  bill_period_start: null,
  bill_period_end: null,
})

assert.equal(
  computePropertyPayableTemplateDates({ due_day_of_month: 30 }, '2026-10').due_date,
  '2026-10-31',
  'property payable settlement should use the billing month actual final day, not the stored legacy 30th'
)

assert.deepEqual(
  resolvePropertyPayableCalendarSchedule({ bill_received_date: '2026-09-08', bill_expected_date: '2026-09-06' }),
  { calendar_date: '2026-09-08', calendar_stage: 'bill_received' },
  'actual receipt date must take priority in the calendar'
)
assert.deepEqual(
  resolvePropertyPayableCalendarSchedule({ bill_expected_date: '2026-09-06' }),
  { calendar_date: '2026-09-06', calendar_stage: 'bill_expected' },
  'expected receipt date should schedule unreceived bills'
)
assert.deepEqual(
  resolvePropertyPayableCalendarSchedule({}),
  { calendar_date: null, calendar_stage: 'unscheduled' },
  'a bill without an actual or expected receipt date must not be fabricated onto month end'
)
assert.deepEqual(
  resolvePropertyPayableCalendarSchedule({ status: 'paid', bill_received_date: '2026-09-08' }),
  { calendar_date: null, calendar_stage: 'unscheduled' },
  'paid bills belong to the paid view rather than the pending calendar'
)
assert.equal(
  isPropertyPayableReceiptPaymentOverdue({ bill_expected_date: '2026-09-01' }, '2026-09-02'),
  true,
  'an unpaid bill is overdue as soon as its expected receipt date has passed'
)
assert.equal(
  isPropertyPayableReceiptPaymentOverdue({ bill_expected_date: '2026-09-01', bill_received_date: '2026-09-03' }, '2026-09-02'),
  false,
  'a later actual receipt date takes precedence over an earlier estimate when determining overdue status'
)
assert.equal(
  isPropertyPayableReceiptPaymentOverdue({ bill_received_date: '2026-09-01' }, '2026-09-02'),
  true,
  'an unpaid bill is overdue after its actual receipt date has passed'
)
assert.equal(
  isPropertyPayableReceiptPaymentOverdue({ status: 'paid', bill_received_date: '2026-09-01' }, '2026-09-02'),
  false,
  'paid bills cannot be overdue'
)

assert.equal(normalizePropertyPayableFrequencyMonths(1), 1, 'monthly frequency should be kept')
assert.equal(normalizePropertyPayableFrequencyMonths(2), 2, 'two-month frequency should be kept')
assert.equal(normalizePropertyPayableFrequencyMonths(3), 3, 'three-month frequency should be kept')
assert.equal(normalizePropertyPayableFrequencyMonths(6), 6, 'six-month frequency should be kept')
assert.equal(normalizePropertyPayableFrequencyMonths(12), 12, 'annual frequency should be kept')
assert.equal(normalizePropertyPayableFrequencyMonths(4), 1, 'unsupported property payable frequency should fall back to monthly')

assert.equal(isDueMonthKey('2026-06', '2026-06', 2), true, 'start month should be due for two-monthly bills')
assert.equal(isDueMonthKey('2026-06', '2026-07', 2), false, 'off-cycle month should not be due for two-monthly bills')
assert.equal(isDueMonthKey('2026-06', '2026-08', 2), true, 'second month after start should be due for two-monthly bills')
assert.equal(isDueMonthKey('2026-07', '2027-07', 12), true, 'annual bill should recur in the same anchor month next year')
assert.equal(isDueMonthKey('2026-07', '2026-08', 12), false, 'annual bill should not appear in non-anchor months')

console.log('test_property_payable_bill_dates: ok')
