import assert from 'assert'
import { computeMonthDayISO, computePropertyPayableTemplateDates } from '../../src/modules/recurring'

assert.equal(computeMonthDayISO('2026-02', 31, 0), '2026-02-28', 'non-leap February should fall back to last day')
assert.equal(computeMonthDayISO('2028-02', 31, 0), '2028-02-29', 'leap February should fall back to leap day')
assert.equal(computeMonthDayISO('2026-03', 31, -1), '2026-02-28', 'offset month should apply before month-end fallback')

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

console.log('test_property_payable_bill_dates: ok')
