import assert from 'assert'
import { propertyPayableTemplateHasBusinessChanges } from '../../src/modules/properties'

const base = {
  id: 'tpl-1',
  property_id: 'property-1',
  scope: 'property',
  template_kind: 'property_payable',
  vendor: 'o',
  category: 'internet',
  category_detail: null,
  amount: '89.80',
  due_day_of_month: 30,
  bill_expected_day_of_month: 5,
  frequency_months: 1,
  remind_days_before: 3,
  payment_type: 'bpay',
  pay_account_name: null,
  pay_bsb: null,
  pay_account_number: null,
  pay_ref: '80033865',
  bpay_code: '285056',
  pay_mobile_number: null,
  report_category: null,
  start_month_key: '2026-06',
  bill_account_no: null,
  note: null,
  updated_by: 'old-user',
  updated_at: '2026-06-29T00:29:53.156Z',
}

assert.equal(
  propertyPayableTemplateHasBusinessChanges(base, {
    ...base,
    amount: 89.8,
    updated_by: 'jt-user',
    updated_at: new Date(),
  }),
  false,
  'audit-only metadata changes should not count as payable template business changes',
)

assert.equal(
  propertyPayableTemplateHasBusinessChanges(base, {
    ...base,
    amount: 92.35,
    updated_by: 'jt-user',
    updated_at: new Date(),
  }),
  true,
  'amount changes should count as payable template business changes',
)

assert.equal(
  propertyPayableTemplateHasBusinessChanges(base, {
    ...base,
    bill_expected_day_of_month: 6,
  }),
  true,
  'expected bill received day changes should count as payable template business changes',
)

console.log('test_property_payable_template_sync: ok')
