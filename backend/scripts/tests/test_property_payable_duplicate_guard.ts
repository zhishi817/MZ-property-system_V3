import assert from 'assert'
import {
  buildPropertyPayableDuplicateKey,
  propertyPayableTemplatesConflict,
  shouldDeletePropertyPayableSnapshotOnTemplateDelete,
} from '../../src/modules/recurring'

const baseTemplate = {
  id: 'tpl-old',
  template_kind: 'property_payable',
  scope: 'property',
  status: 'active',
  property_id: 'property-bo614',
  vendor: 'Occom',
  category: 'internet',
  category_detail: null,
  amount: 89.8,
  due_day_of_month: 28,
  payment_type: 'bpay',
  bill_account_no: null,
  pay_account_name: null,
  pay_bsb: null,
  pay_account_number: null,
  pay_ref: null,
  bpay_code: null,
  pay_mobile_number: null,
}

assert.ok(buildPropertyPayableDuplicateKey(baseTemplate), 'active property payable should have a duplicate key')

assert.equal(
  propertyPayableTemplatesConflict(baseTemplate, {
    ...baseTemplate,
    id: 'tpl-new',
    vendor: ' OCCOM ',
    amount: 120,
    due_day_of_month: 30,
    start_month_key: '2026-07',
  }),
  true,
  'same property/category/vendor/payment identity should conflict even when casing, amount, or due day differs',
)

assert.equal(
  propertyPayableTemplatesConflict(baseTemplate, {
    ...baseTemplate,
    id: 'tpl-water',
    category: 'water',
  }),
  false,
  'different payable category should not conflict',
)

assert.equal(
  propertyPayableTemplatesConflict(baseTemplate, {
    ...baseTemplate,
    id: 'tpl-paused',
    status: 'paused',
  }),
  false,
  'paused templates should not block a new active payable template',
)

assert.equal(
  shouldDeletePropertyPayableSnapshotOnTemplateDelete({
    id: 'snap-unpaid-old-month',
    month_key: '2026-06',
    status: 'unpaid',
    generated_from: 'recurring_payments',
  }),
  true,
  'unpaid snapshots should be cleared when their payable template is deleted, regardless of month',
)

assert.equal(
  shouldDeletePropertyPayableSnapshotOnTemplateDelete({
    id: 'snap-pending-old-month',
    month_key: '2026-06',
    status: 'pending',
    generated_from: 'recurring_payments',
  }),
  true,
  'pending snapshots should be cleared when their payable template is deleted',
)

assert.equal(
  shouldDeletePropertyPayableSnapshotOnTemplateDelete({
    id: 'snap-paid',
    month_key: '2026-06',
    status: 'paid',
    generated_from: 'recurring_payments',
  }),
  false,
  'paid snapshots should remain as historical records',
)

assert.equal(
  shouldDeletePropertyPayableSnapshotOnTemplateDelete({
    id: 'manual-expense',
    month_key: '2026-06',
    status: 'unpaid',
    generated_from: null,
    note: 'manual',
  }),
  false,
  'manual expenses should not be deleted by payable template deletion',
)

console.log('test_property_payable_duplicate_guard: ok')
