import assert from 'assert'
import {
  computeMonthDayISO,
  computeOptionalMonthDayISO,
  computePropertyPayableTemplateDates,
  isDueMonthKey,
  normalizePropertyPayableFrequencyMonths,
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
