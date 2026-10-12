import assert from 'assert'
import fs from 'fs'
import path from 'path'
import {
  CLEANING_PROPERTY_TYPES,
  aggregateSettlementAmounts,
  buildSettlementPeriod,
  calculateSettlementLine,
  chooseRuleItem,
  classifyWorkloadAudit,
  decimalQuantityToRatio,
  type SettlementRuleItem,
  type WorkloadAuditCandidate,
} from '../../src/lib/personnelSettlement'
import { buildPersonnelSettlementPreview } from '../../src/lib/personnelSettlementPreview'
import { isCleaningTaskInspectionSubmitParticipant } from '../../src/lib/cleaningInspection'
import {
  isValidAustralianAbn,
  getPersonnelSettlementProfile,
  listPersonnelSettlementProfiles,
  planPersonnelCurrentProfileEdit,
  validatePersonnelProfilePatch,
} from '../../src/lib/personnelSettlementProfiles'
import {
  normalizePersonnelPaymentMethod,
  personnelPaymentMethodRequiresBankDetails,
} from '../../src/lib/personnelSettlementPayment'

const backendRoot = path.resolve(__dirname, '../..')
const migration = fs.readFileSync(
  path.join(backendRoot, 'scripts/migrations/20260910_personnel_settlement_phase1.sql'),
  'utf8',
)
const paymentMethodMigration = fs.readFileSync(
  path.join(backendRoot, 'scripts/migrations/20260930_personnel_settlement_payment_method.sql'),
  'utf8',
)
const readiness = fs.readFileSync(path.join(backendRoot, 'src/lib/personnelSettlementSchema.ts'), 'utf8')
const profilesSource = fs.readFileSync(path.join(backendRoot, 'src/lib/personnelSettlementProfiles.ts'), 'utf8')
const router = fs.readFileSync(path.join(backendRoot, 'src/modules/personnel_settlements.ts'), 'utf8')
const indexSource = fs.readFileSync(path.join(backendRoot, 'src/index.ts'), 'utf8')

assert.match(migration, /^BEGIN;/)
assert.match(migration, /CREATE TABLE IF NOT EXISTS personnel_settlement_profiles/)
assert.match(migration, /CREATE TABLE IF NOT EXISTS personnel_settlement_profile_audits/)
assert.match(migration, /CREATE TABLE IF NOT EXISTS personnel_fee_rules/)
assert.match(migration, /CREATE TABLE IF NOT EXISTS personnel_fee_rule_items/)
assert.match(migration, /CREATE TABLE IF NOT EXISTS personnel_settlement_batches/)
assert.match(migration, /CREATE TABLE IF NOT EXISTS personnel_weekly_settlements/)
assert.match(migration, /CREATE TABLE IF NOT EXISTS personnel_settlement_lines/)
assert.match(migration, /CREATE TABLE IF NOT EXISTS personnel_workload_claims/)
assert.match(migration, /CREATE TABLE IF NOT EXISTS personnel_workload_claim_evidence/)
assert.match(migration, /media_id text NOT NULL/)
assert.match(migration, /storage_key text NOT NULL/)
assert.match(migration, /gst_status IN \('unconfirmed', 'registered', 'not_registered'\)/)
assert.match(migration, /payment_destination_snapshot jsonb/)
assert.doesNotMatch(migration, /rcti_agreement/i)
assert.doesNotMatch(migration, /\burl\s+text/i)
assert.ok(
  migration.indexOf("INSERT INTO schema_migrations (version)\nVALUES ('20260910_personnel_settlement_phase1')")
    > migration.indexOf('CREATE TABLE IF NOT EXISTS personnel_workload_claim_evidence'),
  'migration marker must be written after all owned DDL',
)
assert.match(migration, /COMMIT;\s*$/)
assert.match(paymentMethodMigration, /^BEGIN;/)
assert.match(paymentMethodMigration, /ADD COLUMN IF NOT EXISTS payment_method text NOT NULL DEFAULT 'bank_transfer'/)
assert.match(paymentMethodMigration, /payment_method IN \('bank_transfer', 'cash', 'foreign_currency', 'other'\)/)
assert.ok(
  paymentMethodMigration.indexOf("VALUES ('20260930_personnel_settlement_payment_method')")
    > paymentMethodMigration.indexOf('ADD CONSTRAINT personnel_settlement_profiles_payment_method_check'),
  'payment-method marker must be written after its owned DDL',
)
assert.match(paymentMethodMigration, /COMMIT;\s*$/)
assert.match(readiness, /20260930_personnel_settlement_payment_method/)
assert.match(readiness, /SELECT 1 FROM schema_migrations WHERE version=\$1 LIMIT 1/)
assert.doesNotMatch(readiness, /CREATE TABLE|ALTER TABLE|CREATE INDEX/i)
assert.match(router, /router\.get\(\s*'\/preview'/)
assert.match(router, /router\.get\('\/my-profile'/)
assert.match(router, /router\.patch\('\/my-profile'/)
assert.match(router, /router\.get\('\/profiles'/)
assert.match(router, /router\.patch\('\/profiles\/:userId'/)
const selfFieldsSource = router.slice(
  router.indexOf('const selfProfilePatchFields'),
  router.indexOf('const profilePatchFields'),
)
assert.doesNotMatch(selfFieldsSource, /settlement_enabled|person_type/)
assert.match(indexSource, /app\.use\('\/finance\/settlements', personnelSettlementsRouter\)/)
assert.doesNotMatch(profilesSource, /settlement_enabled && !merged\.abn/)
assert.match(profilesSource, /merged\.gst_status === 'registered' && !merged\.abn/)
assert.ok(
  indexSource.indexOf("app.use('/finance/settlements', personnelSettlementsRouter)")
    < indexSource.indexOf("app.use('/finance', financeRouter)"),
  'dedicated settlement router must be mounted before the general finance router',
)

assert.deepStrictEqual(buildSettlementPeriod('2026-09-07'), {
  week_start: '2026-09-07',
  week_end: '2026-09-13',
  timezone: 'Australia/Melbourne',
})
assert.throws(() => buildSettlementPeriod('2026-09-08'), /week_start_must_be_monday/)
assert.throws(() => buildSettlementPeriod('2026-02-30'), /week_start_must_be_monday/)
assert.strictEqual(isValidAustralianAbn('53 004 085 616'), true)
assert.strictEqual(isValidAustralianAbn('53 004 085 617'), true)
assert.strictEqual(isValidAustralianAbn('1234'), false)
assert.strictEqual(normalizePersonnelPaymentMethod(undefined), 'bank_transfer')
assert.strictEqual(normalizePersonnelPaymentMethod('cash'), 'cash')
assert.strictEqual(personnelPaymentMethodRequiresBankDetails('bank_transfer'), true)
assert.strictEqual(personnelPaymentMethodRequiresBankDetails('foreign_currency'), false)
assert.strictEqual(isCleaningTaskInspectionSubmitParticipant({
  task_type: 'checkout_clean', inspection_mode: 'same_day', inspection_scope: 'inspect_and_hang',
  cleaner_id: 'cleaner-1', assignee_id: 'cleaner-1', inspector_id: 'inspector-1',
}, 'cleaner-1'), false)
assert.strictEqual(isCleaningTaskInspectionSubmitParticipant({
  task_type: 'checkout_clean', inspection_mode: 'deferred', inspection_scope: 'inspect_and_hang',
  assignee_id: 'cleaner-1', inspector_id: 'inspector-1',
}, 'inspector-1'), true)
assert.strictEqual(isCleaningTaskInspectionSubmitParticipant({
  task_type: 'checkout_clean', inspection_mode: 'same_day', inspection_scope: 'inspect_and_hang',
  assignee_id: 'legacy-inspector', inspector_id: null,
}, 'legacy-inspector'), true)
assert.strictEqual(isCleaningTaskInspectionSubmitParticipant({
  task_type: 'checkin_clean', inspection_mode: 'same_day', inspection_scope: 'inspect_and_hang',
  assignee_id: 'site-executor', inspector_id: 'inspector-1',
}, 'site-executor'), true)
assert.strictEqual(isCleaningTaskInspectionSubmitParticipant({
  task_type: 'checkin_clean', inspection_mode: 'same_day', inspection_scope: 'password_only',
  assignee_id: 'site-executor', inspector_id: 'inspector-1',
}, 'site-executor'), false)
for (const inspectionMode of ['self_complete', 'pending_decision', 'checked_done']) {
  assert.strictEqual(isCleaningTaskInspectionSubmitParticipant({
    task_type: 'checkout_clean', inspection_mode: inspectionMode, inspection_scope: 'inspect_and_hang',
    cleaner_id: 'cleaner-1', assignee_id: 'cleaner-1', inspector_id: null,
  }, 'cleaner-1'), false)
}
assert.strictEqual(validatePersonnelProfilePatch({
  effectiveDate: '2026-09-10',
  source: 'mobile_self',
  patch: { personal_abn: '53 004 085 617' },
}).personal_abn, '53004085617')
assert.throws(() => validatePersonnelProfilePatch({
  effectiveDate: '2026-09-10',
  source: 'web_admin',
  patch: { gst_status: 'registered' },
}), /change_reason_required/)
assert.throws(() => validatePersonnelProfilePatch({
  effectiveDate: '2026-09-10',
  source: 'mobile_self',
  patch: { bank_bsb: '12345' },
}), /invalid_bsb/)
assert.throws(() => validatePersonnelProfilePatch({
  effectiveDate: '2999-01-01',
  source: 'mobile_self',
  patch: {},
}), /effective_date_in_future/)

assert.deepStrictEqual(planPersonnelCurrentProfileEdit({
  profiles: [
    { id: 'profile-sep-1', effective_from: '2026-09-01', effective_to: '2026-09-29' },
    { id: 'profile-sep-30', effective_from: '2026-09-30', effective_to: null },
  ],
  currentEffectiveDate: '2026-09-30',
  requestedEffectiveDate: '2026-09-01',
  today: '2026-10-02',
}), {
  sourceProfileId: 'profile-sep-30',
  targetProfileId: 'profile-sep-1',
  absorbedProfileIds: ['profile-sep-30'],
  previousProfileId: null,
  targetEffectiveFrom: '2026-09-01',
  targetEffectiveTo: null,
})
assert.deepStrictEqual(planPersonnelCurrentProfileEdit({
  profiles: [
    { id: 'profile-aug', effective_from: '2026-08-01', effective_to: '2026-09-29' },
    { id: 'profile-sep-30', effective_from: '2026-09-30', effective_to: null },
  ],
  currentEffectiveDate: '2026-09-30',
  requestedEffectiveDate: '2026-09-01',
  today: '2026-10-02',
}), {
  sourceProfileId: 'profile-sep-30',
  targetProfileId: 'profile-sep-30',
  absorbedProfileIds: [],
  previousProfileId: 'profile-aug',
  targetEffectiveFrom: '2026-09-01',
  targetEffectiveTo: null,
})
assert.throws(() => planPersonnelCurrentProfileEdit({
  profiles: [
    { id: 'profile-sep-1', effective_from: '2026-09-01', effective_to: '2026-09-29' },
    { id: 'profile-sep-30', effective_from: '2026-09-30', effective_to: null },
  ],
  currentEffectiveDate: '2026-09-01',
  requestedEffectiveDate: '2026-09-01',
  today: '2026-10-02',
}), /profile_version_stale/)
assert.throws(() => planPersonnelCurrentProfileEdit({
  profiles: [
    { id: 'profile-sep-30', effective_from: '2026-09-30', effective_to: null },
  ],
  currentEffectiveDate: '2026-09-30',
  requestedEffectiveDate: '2026-10-01',
  today: '2026-10-02',
}), /profile_effective_date_forward_move_not_allowed/)
assert.match(profilesSource, /if \(currentEditPlan \|\| !next\)/)
assert.match(profilesSource, /SET profile_id=\$1/)
assert.match(profilesSource, /DELETE FROM personnel_settlement_profiles/)
assert.match(router, /current_effective_date: z\.string\(\)\.trim\(\)\.regex\(DATE_ONLY\)\.optional\(\)/)

assert.deepStrictEqual(calculateSettlementLine({
  quantity_numerator: 1,
  quantity_denominator: 1,
  unit_rate_cents: 10_000,
  price_basis: 'exclusive_gst',
  gst_registered: true,
}), { subtotal_cents: 10_000, gst_cents: 1_000, total_cents: 11_000 })
assert.deepStrictEqual(calculateSettlementLine({
  quantity_numerator: 1,
  quantity_denominator: 1,
  unit_rate_cents: 11_000,
  price_basis: 'inclusive_gst',
  gst_registered: true,
}), { subtotal_cents: 10_000, gst_cents: 1_000, total_cents: 11_000 })
assert.deepStrictEqual(calculateSettlementLine({
  quantity_numerator: 90,
  quantity_denominator: 60,
  unit_rate_cents: 3_000,
  price_basis: 'inclusive_gst',
  gst_registered: false,
}), { subtotal_cents: 4_500, gst_cents: 0, total_cents: 4_500 })
assert.deepStrictEqual(aggregateSettlementAmounts([
  { subtotal_cents: 100, gst_cents: 10, total_cents: 110 },
  { subtotal_cents: 200, gst_cents: 0, total_cents: 200 },
]), { subtotal_cents: 300, gst_cents: 10, total_cents: 310 })
assert.deepStrictEqual(decimalQuantityToRatio('1.250'), { numerator: 1250, denominator: 1000 })
assert.strictEqual(decimalQuantityToRatio('1.2345'), null)

const baseAudit: WorkloadAuditCandidate = {
  audit_id: 'audit-1',
  task_id: 'task-1',
  user_id: 'cleaner-1',
  performed_by_name: 'Cleaner One',
  action: 'complete_cleaning',
  performed_at: '2026-09-08T01:00:00Z',
  service_date: '2026-09-08',
  property_id: 'property-1',
  property_label: 'P-1',
  property_type: '一房一卫',
  task_type: 'checkout_cleaning',
  task_status: 'cleaned',
  status_after: 'cleaned',
  metadata: {},
}
assert.deepStrictEqual(classifyWorkloadAudit(baseAudit), {
  eligibility: 'eligible',
  component_type: 'cleaning_task',
  reason: 'audited_cleaning_completion',
})
assert.strictEqual(classifyWorkloadAudit({
  ...baseAudit,
  task_status: 'cancelled',
  metadata: { step: 'completion_photos_saved' },
}).reason, 'completion_photo_only')
assert.strictEqual(classifyWorkloadAudit({
  ...baseAudit,
  action: 'submit_inspection',
  task_status: 'cancelled',
  status_after: 'inspected',
  metadata: { route: 'mzapp.cleaning_tasks.restock_proof' },
}).reason, 'restock_proof_only')
assert.strictEqual(classifyWorkloadAudit({
  ...baseAudit,
  action: 'submit_inspection',
  status_after: 'assigned',
  metadata: { item_count: 2 },
}).reason, 'inspection_action_without_submission_status')
assert.deepStrictEqual(classifyWorkloadAudit({
  ...baseAudit,
  task_status: 'cancelled',
  status_after: 'cleaned',
  metadata: {},
}), {
  eligibility: 'manual_review',
  component_type: null,
  reason: 'legacy_execution_task_later_cancelled',
})
assert.deepStrictEqual(classifyWorkloadAudit({
  ...baseAudit,
  task_status: 'cleaned',
  status_after: 'cleaned',
  metadata: { execution_record_version: 'mz031-v1', status_before_snapshot: 'cancelled' },
}), {
  eligibility: 'manual_review',
  component_type: null,
  reason: 'execution_recorded_after_task_cancelled',
})
assert.strictEqual(classifyWorkloadAudit({
  ...baseAudit,
  task_status: 'cancelled',
  status_after: 'cleaned',
  metadata: { execution_record_version: 'mz031-v1', status_before_snapshot: 'assigned' },
}).eligibility, 'eligible')

const items: SettlementRuleItem[] = [
  { id: 'type', rule_id: 'rule', component_type: 'cleaning_task', conditions: { property_type: '一房一卫' }, priority: 0, rate_cents: 8_000 },
  { id: 'property', rule_id: 'rule', component_type: 'cleaning_task', property_id: 'property-1', conditions: { property_type: '一房一卫' }, priority: 0, rate_cents: 10_000 },
]
assert.strictEqual(chooseRuleItem(items, 'cleaning_task', 'property-1', 'checkout_cleaning', '一房一卫').item?.id, 'property')
assert.strictEqual(chooseRuleItem(items, 'cleaning_task', 'property-1', 'checkout_cleaning', '两房一卫').item, null)
assert.strictEqual(chooseRuleItem([
  ...items,
  { ...items[1], id: 'property-duplicate' },
], 'cleaning_task', 'property-1', 'checkout_cleaning', '一房一卫').ambiguous, true)
assert.strictEqual(chooseRuleItem([
  { id: 'legacy-flat', rule_id: 'rule', component_type: 'cleaning_task', priority: 0, rate_cents: 3_500 },
], 'cleaning_task', 'property-1', 'checkout_cleaning', '一房一卫').item, null)
const roomTypeItems: SettlementRuleItem[] = CLEANING_PROPERTY_TYPES.map((propertyType, index) => ({
  id: `room-type-${index}`,
  rule_id: 'room-type-rule',
  component_type: 'cleaning_task',
  conditions: { property_type: propertyType },
  priority: CLEANING_PROPERTY_TYPES.length - index,
  rate_cents: 7_000 + index * 1_000,
}))
for (const [index, propertyType] of CLEANING_PROPERTY_TYPES.entries()) {
  assert.strictEqual(
    chooseRuleItem(roomTypeItems, 'cleaning_task', 'property-1', 'checkout_cleaning', propertyType).item?.rate_cents,
    7_000 + index * 1_000,
  )
}

const profiles = [
  {
    id: 'profile-cleaner', user_id: 'cleaner-1', user_name: 'Cleaner One', effective_from: '2026-01-01', effective_to: null,
    person_type: 'cleaner', supplier_legal_name: 'Cleaner One', supplier_business_name: null, abn: '10000000001',
    gst_status: 'registered', invoice_document_type: 'supplier_invoice', currency: 'AUD',
  },
  {
    id: 'profile-inspector', user_id: 'inspector-1', user_name: 'Inspector One', effective_from: '2026-01-01', effective_to: null,
    person_type: 'inspector', supplier_legal_name: 'Inspector One', supplier_business_name: null, abn: '10000000002',
    gst_status: 'not_registered', invoice_document_type: 'supplier_invoice', currency: 'AUD',
  },
  {
    id: 'profile-warehouse', user_id: 'warehouse-1', user_name: 'Warehouse One', effective_from: '2026-01-01', effective_to: null,
    person_type: 'warehouse', supplier_legal_name: 'Warehouse One', supplier_business_name: null, abn: '10000000003',
    gst_status: 'not_registered', invoice_document_type: 'supplier_invoice', currency: 'AUD',
  },
  {
    id: 'profile-subsidy-only', user_id: 'subsidy-only', user_name: 'Subsidy Only', effective_from: '2026-01-01', effective_to: null,
    person_type: 'cleaner', supplier_legal_name: 'Subsidy Only', supplier_business_name: null, abn: '10000000004',
    gst_status: 'registered', invoice_document_type: 'supplier_invoice', currency: 'AUD',
  },
]
const ruleRows = [
  { rule_id: 'rule-cleaner', user_id: 'cleaner-1', rule_name: 'Cleaner fee', effective_from: '2026-01-01', effective_to: null, price_basis: 'exclusive_gst', currency: 'AUD', item_id: 'cleaner-default', component_type: 'cleaning_task', property_id: null, task_type: null, conditions: { property_type: '一房一卫' }, priority: 0, rate_cents: '8000' },
  { rule_id: 'rule-cleaner', user_id: 'cleaner-1', rule_name: 'Cleaner fee', effective_from: '2026-01-01', effective_to: null, price_basis: 'exclusive_gst', currency: 'AUD', item_id: 'cleaner-property', component_type: 'cleaning_task', property_id: 'property-1', task_type: null, conditions: { property_type: '一房一卫' }, priority: 0, rate_cents: '10000' },
  { rule_id: 'rule-cleaner', user_id: 'cleaner-1', rule_name: 'Cleaner fee', effective_from: '2026-01-01', effective_to: null, price_basis: 'exclusive_gst', currency: 'AUD', item_id: 'new-property-hour', component_type: 'new_property_task', property_id: null, task_type: null, priority: 0, rate_cents: '3500' },
  { rule_id: 'rule-inspector', user_id: 'inspector-1', rule_name: 'Inspector day', effective_from: '2026-01-01', effective_to: null, price_basis: 'inclusive_gst', currency: 'AUD', item_id: 'inspector-day', component_type: 'inspection_day', property_id: null, task_type: null, priority: 0, rate_cents: '25000' },
  { rule_id: 'rule-warehouse', user_id: 'warehouse-1', rule_name: 'Warehouse time', effective_from: '2026-01-01', effective_to: null, price_basis: 'inclusive_gst', currency: 'AUD', item_id: 'warehouse-hour', component_type: 'warehouse_hour', property_id: null, task_type: null, priority: 0, rate_cents: '3000' },
  { rule_id: 'rule-warehouse', user_id: 'warehouse-1', rule_name: 'Warehouse time', effective_from: '2026-01-01', effective_to: null, price_basis: 'inclusive_gst', currency: 'AUD', item_id: 'warehouse-weekly', component_type: 'weekly_fixed', property_id: null, task_type: null, priority: 0, rate_cents: '5000' },
]
const previewAudits = [
  {
    ...baseAudit,
    audit_id: 'audit-clean',
    task_id: 'task-assigned',
    metadata: {
      execution_record_version: 'mz031-v1',
      execution_key: 'cleaning_task:task-assigned',
      actual_service_date: '2026-09-08',
      task_snapshot: { scheduled_service_date: '2026-09-08' },
      evidence_snapshot: [{ media_id: 'clean-photo-1', type: 'completion_photo' }],
      evidence_count: 1,
    },
  },
  {
    ...baseAudit,
    audit_id: 'audit-clean-duplicate',
    task_id: 'task-assigned',
    performed_at: '2026-09-09T01:00:00Z',
    service_date: '2026-09-09',
    metadata: {
      execution_record_version: 'mz031-v1',
      execution_key: 'cleaning:task-assigned',
      actual_service_date: '2026-09-09',
      task_snapshot: { scheduled_service_date: '2026-09-08' },
    },
  },
  {
    ...baseAudit,
    audit_id: 'audit-i1',
    task_id: 'inspection-1',
    user_id: 'inspector-1',
    performed_by_name: 'Inspector One',
    action: 'submit_inspection',
    performed_at: '2026-09-10T01:00:00Z',
    service_date: '2026-09-10',
    status_after: 'inspected',
    property_id: 'property-2',
    property_label: 'P-2',
    metadata: {
      execution_record_version: 'mz031-v1',
      execution_key: 'inspection:inspection-1',
      actual_service_date: '2026-09-10',
      inspection_submission_complete: true,
      task_snapshot: { scheduled_service_date: '2026-09-08', inspection_due_date: '2026-09-10' },
      evidence_snapshot: [{ media_id: 'inspection-photo-1', type: 'inspection_bedroom' }],
      evidence_count: 1,
    },
  },
  {
    ...baseAudit,
    audit_id: 'audit-i2',
    task_id: 'inspection-2',
    user_id: 'inspector-1',
    performed_by_name: 'Inspector One',
    action: 'submit_inspection',
    performed_at: '2026-09-10T02:00:00Z',
    service_date: '2026-09-10',
    status_after: 'inspected',
    property_id: 'property-3',
    property_label: 'P-3',
    metadata: {
      execution_record_version: 'mz031-v1',
      execution_key: 'inspection:inspection-2',
      actual_service_date: '2026-09-10',
      inspection_submission_complete: true,
      task_snapshot: { scheduled_service_date: '2026-09-08', inspection_due_date: '2026-09-10' },
    },
  },
  { ...baseAudit, audit_id: 'audit-restock', task_id: 'restock-1', user_id: 'inspector-1', performed_by_name: 'Inspector One', action: 'submit_inspection', status_after: 'inspected', metadata: { route: 'mzapp.cleaning_tasks.restock_proof' } },
  { ...baseAudit, audit_id: 'audit-conflict-inspector', task_id: 'inspection-conflict', user_id: 'inspector-1', performed_by_name: 'Inspector One', action: 'submit_inspection', status_after: 'inspected' },
  { ...baseAudit, audit_id: 'audit-conflict-cleaner', task_id: 'inspection-conflict', user_id: 'cleaner-1', performed_by_name: 'Cleaner One', action: 'submit_inspection', status_after: 'inspected' },
  { ...baseAudit, audit_id: 'audit-legacy-cancelled', task_id: 'task-cancelled', task_status: 'cancelled', status_after: 'cleaned', metadata: {} },
]
const cleaningAssignments = [
  { task_id: 'task-assigned', user_id: 'cleaner-1', user_name: 'Cleaner One', service_date: '2026-09-08', current_service_date: '2026-09-08', arrangement_reason: 'management_closed_without_execution', task_status: 'completed', property_id: 'property-1', property_label: 'P-1', property_type: '一房一卫', task_type: 'checkout_clean' },
  { task_id: 'task-assigned', user_id: 'cleaner-1', user_name: 'Cleaner One', service_date: '2026-09-08', task_status: 'assigned', property_id: 'property-1', property_label: 'P-1', property_type: '一房一卫', task_type: 'checkout_clean' },
  { task_id: 'task-checkin-pair', user_id: 'cleaner-1', user_name: 'Cleaner One', service_date: '2026-09-08', task_status: 'assigned', property_id: 'property-1', property_label: 'P-1', property_type: '一房一卫', task_type: 'checkin_clean' },
  { task_id: 'task-stayover', user_id: 'cleaner-1', user_name: 'Cleaner One', service_date: '2026-09-08', task_status: 'assigned', property_id: 'property-1', property_label: 'P-1', property_type: '一房一卫', task_type: 'stayover_clean' },
  { task_id: 'task-cancelled', user_id: 'cleaner-1', user_name: 'Cleaner One', service_date: '2026-09-09', task_status: 'cancelled', property_id: 'property-1', property_label: 'P-1', property_type: '一房一卫', task_type: 'checkout_clean' },
  { task_id: 'task-canceled', user_id: 'cleaner-1', user_name: 'Cleaner One', service_date: '2026-09-09', task_status: 'canceled', property_id: 'property-1', property_label: 'P-1', property_type: '一房一卫', task_type: 'checkout_clean' },
  { task_id: 'task-unknown-type', user_id: 'cleaner-1', user_name: 'Cleaner One', service_date: '2026-09-10', task_status: 'pending', property_id: 'property-unknown', property_label: 'P-X', property_type: null, task_type: 'checkout_clean' },
  { task_id: 'task-legacy-complete', user_id: 'cleaner-1', user_name: 'Cleaner One', service_date: '2026-09-11', task_status: 'done', property_id: 'property-legacy', property_label: 'P-LEGACY', property_type: '一房一卫', task_type: 'checkout_clean' },
  { task_id: 'task-rescheduled', user_id: 'cleaner-1', user_name: 'Cleaner One', service_date: '2026-09-12', current_service_date: '2026-09-15', arrangement_reason: 'rescheduled_after_plan', task_status: 'assigned', property_id: 'property-rescheduled', property_label: 'P-MOVED', property_type: '一房一卫', task_type: 'checkout_clean' },
  { task_id: 'task-management-closed', component_type: 'cleaning_task', user_id: 'cleaner-1', user_name: 'Cleaner One', service_date: '2026-09-13', current_service_date: '2026-09-13', arrangement_reason: 'management_closed_without_execution', task_status: 'completed', property_id: 'property-closed', property_label: 'P-CLOSED', property_type: '一房一卫', task_type: 'checkout_clean' },
  { task_id: 'inspection-1', component_type: 'inspection_day', user_id: 'inspector-1', user_name: 'Inspector One', service_date: '2026-09-10', current_service_date: '2026-09-15', arrangement_reason: 'rescheduled_after_plan', task_status: 'assigned', property_id: 'property-2', property_label: 'P-2', property_type: '一房一卫', task_type: 'checkout_clean', inspection_mode: 'same_day' },
  { task_id: 'inspection-planned', component_type: 'inspection_day', user_id: 'inspector-1', user_name: 'Inspector One', service_date: '2026-09-11', current_service_date: '2026-09-11', task_status: 'assigned', property_id: 'property-4', property_label: 'P-4', property_type: '一房一卫', task_type: 'checkout_clean', inspection_mode: 'same_day' },
  { task_id: 'inspection-rescheduled', component_type: 'inspection_day', user_id: 'inspector-1', user_name: 'Inspector One', service_date: '2026-09-11', current_service_date: '2026-09-15', arrangement_reason: 'rescheduled_after_plan', task_status: 'assigned', property_id: 'property-5', property_label: 'P-5', property_type: '一房一卫', task_type: 'checkout_clean', inspection_mode: 'deferred', inspection_due_date: '2026-09-11' },
  { task_id: 'inspection-reassigned', component_type: 'inspection_day', user_id: 'inspector-1', user_name: 'Inspector One', service_date: '2026-09-12', current_service_date: '2026-09-12', arrangement_reason: 'reassigned_after_plan', task_status: 'assigned', property_id: 'property-6', property_label: 'P-6', property_type: '一房一卫', task_type: 'checkout_clean', inspection_mode: 'same_day' },
  { task_id: 'inspection-cancelled', component_type: 'inspection_day', user_id: 'inspector-1', user_name: 'Inspector One', service_date: '2026-09-12', current_service_date: '2026-09-12', arrangement_reason: 'rescheduled_after_plan', task_status: 'cancelled', property_id: 'property-7', property_label: 'P-7', property_type: '一房一卫', task_type: 'checkout_clean', inspection_mode: 'same_day' },
  { task_id: 'task-management-closed', component_type: 'inspection_day', user_id: 'inspector-1', user_name: 'Inspector One', service_date: '2026-09-13', current_service_date: '2026-09-13', arrangement_reason: 'management_closed_without_execution', task_status: 'completed', property_id: 'property-closed', property_label: 'P-CLOSED', property_type: '一房一卫', task_type: 'checkout_clean', inspection_mode: 'deferred', inspection_due_date: '2026-09-13' },
]
const claims = [
  { id: 'claim-warehouse', status: 'approved', submitter_user_id: 'warehouse-1', service_date: '2026-09-09', claim_type: 'warehouse_hour', property_id: null, cleaning_task_id: null, duration_minutes: 90, approved_duration_minutes: null, requested_quantity: null, approved_quantity: null, requested_amount_cents: null, approved_amount_cents: null, note: 'Warehouse shift' },
  { id: 'claim-subsidy', status: 'approved', submitter_user_id: 'cleaner-1', service_date: '2026-09-09', claim_type: 'subsidy_amount', property_id: null, cleaning_task_id: null, duration_minutes: null, approved_duration_minutes: null, requested_quantity: null, approved_quantity: null, requested_amount_cents: '1500', approved_amount_cents: '1500', note: 'Travel subsidy' },
  { id: 'claim-new-property', status: 'approved', submitter_user_id: 'cleaner-1', service_date: '2026-09-10', claim_type: 'new_property_task', property_id: 'property-1', cleaning_task_id: null, duration_minutes: 120, approved_duration_minutes: null, requested_quantity: null, approved_quantity: null, requested_amount_cents: null, approved_amount_cents: null, note: 'New property setup' },
  { id: 'claim-direct-without-rule', status: 'approved', submitter_user_id: 'subsidy-only', service_date: '2026-09-11', claim_type: 'subsidy_amount', property_id: null, cleaning_task_id: null, duration_minutes: null, approved_duration_minutes: null, requested_quantity: null, approved_quantity: null, requested_amount_cents: '1368', approved_amount_cents: '1368', note: 'Approved reimbursement' },
]
const submittedSubsidyClaim = {
  id: 'claim-submitted-subsidy', status: 'submitted', submitter_user_id: 'cleaner-1',
  service_date: '2026-09-11', claim_type: 'subsidy_amount', property_id: null, cleaning_task_id: null,
  duration_minutes: null, approved_duration_minutes: null, requested_quantity: null, approved_quantity: null,
  requested_amount_cents: '1368', approved_amount_cents: null, note: 'Parking reimbursement',
}

const fakeExecutor = {
  async query(sql: string, params?: any[]) {
    if (sql.includes('FROM personnel_settlement_profiles')) return { rows: profiles }
    if (sql.includes('FROM personnel_fee_rules')) return { rows: ruleRows }
    if (sql.includes('FROM work_task_action_audits a') && sql.includes('JOIN cleaning_tasks t')) return { rows: previewAudits }
    if (sql.includes('FROM personnel_workload_claims')) {
      return { rows: Array.isArray(params?.[3]) && params[3].includes('submitted') ? [...claims, submittedSubsidyClaim] : claims }
    }
    if (sql.includes('FROM cleaning_tasks t')) return { rows: cleaningAssignments }
    throw new Error(`unexpected query: ${sql.slice(0, 80)}`)
  },
}

async function main() {
  const profileRow = {
    user_id: 'cleaner-1', username: 'cleaner', display_name: 'Cleaner One', role: 'cleaner',
    legal_name: 'Cleaner One', personal_abn: '53004085616', photo_id_url: 'private-key',
    payment_method: 'cash', bank_account_name: 'Cleaner One', bank_bsb: '123456', bank_account_number: '12345678',
    settlement_enabled: true, person_type: 'cleaner', supplier_legal_name: 'Cleaner One',
    supplier_business_name: null, abn: '53004085616', gst_status: 'registered',
    gst_effective_from: '2026-09-01', effective_from: '2026-09-01', effective_to: null,
    updated_at: '2026-09-10T00:00:00Z', fee_rule_name: null,
  }
  const profileExecutor = { async query() { return { rows: [profileRow] } } }
  const list = await listPersonnelSettlementProfiles({ includeBankDetails: false }, profileExecutor)
  assert.strictEqual(list[0].payment_method, 'cash')
  assert.strictEqual(list[0].bank_account_number, null)
  assert.strictEqual(list[0].bank_account_masked, '•••• 5678')
  const detail = await getPersonnelSettlementProfile({ userId: 'cleaner-1', includeBankDetails: true }, profileExecutor)
  assert.strictEqual(detail?.bank_account_number, '12345678')

  const preview = await buildPersonnelSettlementPreview({ week_start: '2026-09-07' }, fakeExecutor)
  assert.strictEqual(preview.mode, 'read_only_preview')
  assert.strictEqual(preview.source_summary.audited_candidates, 8)
  assert.strictEqual(preview.source_summary.eligible_deduplicated_candidates, 3)
  assert.strictEqual(preview.source_summary.excluded_auxiliary_candidates, 2)
  assert.strictEqual(preview.source_summary.conflicting_tasks_requiring_manual_review, 1)
  assert.strictEqual(preview.source_summary.cleaning_assignment_candidates, 15)
  assert.strictEqual(preview.source_summary.non_cancelled_cleaning_assignments, 5)
  assert.strictEqual(preview.source_summary.excluded_cancelled_cleaning_assignments, 2)
  assert.strictEqual(preview.source_summary.excluded_non_checkout_cleaning_assignments, 2)
  assert.strictEqual(preview.source_summary.approved_claims, 4)
  assert.strictEqual(preview.source_summary.submitted_claims, 0)
  assert.strictEqual(preview.source_summary.planned_work_items, 14)
  assert.strictEqual(preview.source_summary.incomplete_or_rescheduled_work_items, 7)
  assert.strictEqual(preview.source_summary.legacy_tasks_requiring_manual_review, 1)
  assert.strictEqual(preview.source_summary.executed_cleaning_tasks, 1)
  assert.strictEqual(preview.source_summary.executed_inspection_tasks, 2)

  const cleaner = preview.people.find((person) => person.user_id === 'cleaner-1')
  const inspector = preview.people.find((person) => person.user_id === 'inspector-1')
  const warehouse = preview.people.find((person) => person.user_id === 'warehouse-1')
  const subsidyOnly = preview.people.find((person) => person.user_id === 'subsidy-only')
  assert.ok(cleaner)
  assert.ok(inspector)
  assert.ok(warehouse)
  assert.ok(subsidyOnly)
  assert.strictEqual(cleaner?.lines.filter((line) => line.component_type === 'cleaning_task').length, 1)
  assert.strictEqual(cleaner?.lines.find((line) => line.component_type === 'cleaning_task')?.source_type, 'work_task_action_audit')
  assert.strictEqual(cleaner?.lines.find((line) => line.component_type === 'cleaning_task')?.source_audit_id, 'audit-clean')
  assert.strictEqual(cleaner?.work_checklist.find((item) => item.task_id === 'task-assigned')?.status_reason, 'completed_with_execution_audit')
  assert.deepStrictEqual(
    cleaner?.lines.find((line) => line.component_type === 'cleaning_task')?.work_items.map((item) => ({
      execution_key: item.execution_key,
      service_date: item.service_date,
      scheduled_service_date: item.scheduled_service_date,
      evidence_count: item.evidence_count,
    })),
    [{ execution_key: 'cleaning:task-assigned', service_date: '2026-09-08', scheduled_service_date: '2026-09-08', evidence_count: 1 }],
  )
  assert.deepStrictEqual(
    cleaner?.work_checklist.map((item) => ({
      task_id: item.task_id,
      status: item.status,
      included_in_amount: item.included_in_amount,
      reason: item.status_reason,
    })),
    [
      { task_id: 'task-assigned', status: 'completed', included_in_amount: true, reason: 'completed_with_execution_audit' },
      { task_id: 'task-cancelled', status: 'legacy_completed_unverified', included_in_amount: false, reason: 'legacy_execution_task_later_cancelled' },
      { task_id: 'task-canceled', status: 'cancelled', included_in_amount: false, reason: 'task_cancelled_without_payment' },
      { task_id: 'task-unknown-type', status: 'incomplete', included_in_amount: false, reason: 'task_not_completed:pending' },
      { task_id: 'task-legacy-complete', status: 'legacy_completed_unverified', included_in_amount: false, reason: 'legacy_completed_status_without_execution_audit' },
      { task_id: 'task-rescheduled', status: 'rescheduled', included_in_amount: false, reason: 'rescheduled_after_plan' },
      { task_id: 'task-management-closed', status: 'management_closed', included_in_amount: false, reason: 'management_closed_without_execution' },
    ],
  )
  assert.strictEqual(cleaner?.work_checklist.find((item) => item.task_id === 'task-rescheduled')?.current_scheduled_service_date, '2026-09-15')
  assert.ok(cleaner?.lines.every((line) => line.source_id !== 'task-cancelled' && line.source_id !== 'task-canceled'))
  assert.ok(cleaner?.lines.every((line) => line.source_id !== 'task-checkin-pair' && line.source_id !== 'task-stayover'))
  const newPropertyLine = cleaner?.lines.find((line) => line.component_type === 'new_property_task')
  assert.deepStrictEqual(
    newPropertyLine && {
      quantity_numerator: newPropertyLine.quantity_numerator,
      quantity_denominator: newPropertyLine.quantity_denominator,
      subtotal_cents: newPropertyLine.subtotal_cents,
      gst_cents: newPropertyLine.gst_cents,
      total_cents: newPropertyLine.total_cents,
    },
    { quantity_numerator: 120, quantity_denominator: 60, subtotal_cents: 7_000, gst_cents: 700, total_cents: 7_700 },
  )
  assert.deepStrictEqual(cleaner?.totals, { subtotal_cents: 18_364, gst_cents: 1_836, total_cents: 20_200 })
  assert.strictEqual(inspector?.lines.length, 1, 'multiple inspections on one Melbourne day pay one day rate')
  assert.strictEqual(inspector?.lines[0]?.service_date, '2026-09-10', 'inspection pay day follows actual submission day')
  assert.strictEqual(inspector?.work_checklist.find((item) => item.task_id === 'inspection-1')?.status_reason, 'completed_with_execution_audit')
  assert.strictEqual(inspector?.work_checklist.find((item) => item.task_id === 'inspection-1')?.current_scheduled_service_date, '2026-09-15')
  assert.deepStrictEqual(inspector?.lines[0]?.work_items.map((item) => item.property_label), ['P-2', 'P-3'])
  assert.deepStrictEqual(inspector?.lines[0]?.work_items.map((item) => item.scheduled_service_date), ['2026-09-08', '2026-09-08'])
  assert.deepStrictEqual(
    inspector?.work_checklist.map((item) => ({
      task_id: item.task_id,
      status: item.status,
      included_in_amount: item.included_in_amount,
      reason: item.status_reason,
    })),
    [
      { task_id: 'inspection-1', status: 'completed', included_in_amount: true, reason: 'completed_with_execution_audit' },
      { task_id: 'inspection-2', status: 'completed', included_in_amount: true, reason: 'completed_with_execution_audit' },
      { task_id: 'inspection-planned', status: 'incomplete', included_in_amount: false, reason: 'task_not_completed:assigned' },
      { task_id: 'inspection-rescheduled', status: 'rescheduled', included_in_amount: false, reason: 'rescheduled_after_plan' },
      { task_id: 'inspection-reassigned', status: 'rescheduled', included_in_amount: false, reason: 'reassigned_after_plan' },
      { task_id: 'inspection-cancelled', status: 'cancelled', included_in_amount: false, reason: 'task_cancelled_after:rescheduled_after_plan' },
      { task_id: 'task-management-closed', status: 'management_closed', included_in_amount: false, reason: 'management_closed_without_execution' },
    ],
  )
  assert.deepStrictEqual(inspector?.totals, { subtotal_cents: 25_000, gst_cents: 0, total_cents: 25_000 })
  assert.deepStrictEqual(warehouse?.totals, { subtotal_cents: 9_500, gst_cents: 0, total_cents: 9_500 })
  assert.deepStrictEqual(subsidyOnly?.totals, { subtotal_cents: 1_244, gst_cents: 124, total_cents: 1_368 })
  assert.strictEqual(subsidyOnly?.lines[0]?.rule_id, null)
  assert.strictEqual(subsidyOnly?.lines[0]?.rule_item_id, null)
  assert.ok(!subsidyOnly?.warnings.some((warning) => warning.reason === 'missing_effective_rule'))
  assert.deepStrictEqual(preview.totals, { subtotal_cents: 54_108, gst_cents: 1_960, total_cents: 56_068 })
  assert.strictEqual(preview.manual_review.legacy_tasks_without_performer_audit.length, 1)
  assert.ok(!preview.manual_review.warnings.some((warning) => warning.source_id === 'task-management-closed'))
  assert.deepStrictEqual(preview.manual_review.legacy_tasks_without_performer_audit[0], {
    task_id: 'task-legacy-complete',
    component_type: 'cleaning_task',
    user_id: 'cleaner-1',
    user_name: 'Cleaner One',
    service_date: '2026-09-11',
    property_id: 'property-legacy',
    property_label: 'P-LEGACY',
    task_status: 'done',
    reason: 'legacy_completed_status_without_execution_audit',
  })
  assert.ok(preview.manual_review.warnings.some((warning) => warning.reason === 'multiple_performers_for_task'))
  assert.ok(!preview.manual_review.warnings.some((warning) => warning.source_id === 'task-unknown-type'))
  assert.ok(preview.excluded_candidates.every((candidate) => !('metadata' in candidate)))
  assert.ok(preview.excluded_candidates.some((candidate) => (
    candidate.audit_id === 'audit-clean-duplicate' && candidate.reason === 'duplicate_execution_already_counted'
  )))

  const submissionPreview = await buildPersonnelSettlementPreview({
    week_start: '2026-09-07',
    user_ids: ['cleaner-1'],
    include_submitted_claims: true,
  }, fakeExecutor)
  assert.strictEqual(submissionPreview.source_summary.submitted_claims, 1)
  const submittedLine = submissionPreview.people.find((person) => person.user_id === 'cleaner-1')?.lines
    .find((line) => line.source_id === submittedSubsidyClaim.id)
  assert.deepStrictEqual(
    submittedLine && {
      subtotal_cents: submittedLine.subtotal_cents,
      gst_cents: submittedLine.gst_cents,
      total_cents: submittedLine.total_cents,
    },
    { subtotal_cents: 1_244, gst_cents: 124, total_cents: 1_368 },
  )

  const allClaimTypes = [
    { id: 'claim-warehouse-all', status: 'submitted', submitter_user_id: 'all-types-1', service_date: '2026-09-28', claim_type: 'warehouse_hour', property_id: null, cleaning_task_id: null, duration_minutes: 60, approved_duration_minutes: null, requested_quantity: null, approved_quantity: null, requested_amount_cents: null, approved_amount_cents: null, note: 'Warehouse' },
    { id: 'claim-overtime-all', status: 'submitted', submitter_user_id: 'all-types-1', service_date: '2026-09-28', claim_type: 'overtime_hour', property_id: null, cleaning_task_id: null, duration_minutes: 120, approved_duration_minutes: null, requested_quantity: null, approved_quantity: null, requested_amount_cents: null, approved_amount_cents: null, note: 'Overtime' },
    { id: 'claim-subsidy-all', status: 'submitted', submitter_user_id: 'all-types-1', service_date: '2026-10-03', claim_type: 'subsidy_amount', property_id: null, cleaning_task_id: null, duration_minutes: null, approved_duration_minutes: null, requested_quantity: null, approved_quantity: null, requested_amount_cents: '1500', approved_amount_cents: null, note: 'Subsidy' },
    { id: 'claim-new-property-all', status: 'submitted', submitter_user_id: 'all-types-1', service_date: '2026-10-03', claim_type: 'new_property_task', property_id: 'FG1003', cleaning_task_id: null, duration_minutes: 60, approved_duration_minutes: null, requested_quantity: null, approved_quantity: null, requested_amount_cents: null, approved_amount_cents: null, note: 'New property' },
    { id: 'claim-external-all', status: 'submitted', submitter_user_id: 'all-types-1', service_date: '2026-10-03', claim_type: 'external_task', property_id: null, cleaning_task_id: null, duration_minutes: null, approved_duration_minutes: null, requested_quantity: '2', approved_quantity: null, requested_amount_cents: null, approved_amount_cents: null, note: 'External work' },
  ]
  const allTypesProfile = [{
    id: 'profile-all-types', user_id: 'all-types-1', user_name: 'All Types', effective_from: '2026-01-01', effective_to: null,
    person_type: 'cleaner', supplier_legal_name: 'All Types', supplier_business_name: null, abn: null,
    gst_status: 'not_registered', invoice_document_type: 'supplier_invoice', currency: 'AUD',
  }]
  const allTypesRules = [
    ['warehouse-hour', 'warehouse_hour', '3000'],
    ['overtime-hour', 'overtime_hour', '4000'],
    ['new-property', 'new_property_task', '5000'],
    ['external-task', 'external_task', '2500'],
  ].map(([itemId, componentType, rateCents]) => ({
    rule_id: 'rule-all-types', user_id: 'all-types-1', rule_name: 'All types', effective_from: '2026-01-01', effective_to: null,
    price_basis: 'inclusive_gst', currency: 'AUD', item_id: itemId, component_type: componentType,
    property_id: null, task_type: null, priority: 0, rate_cents: rateCents,
  }))
  const allTypesExecutor = {
    async query(sql: string) {
      if (sql.includes('FROM personnel_settlement_profiles')) return { rows: allTypesProfile }
      if (sql.includes('FROM personnel_fee_rules')) return { rows: allTypesRules }
      if (sql.includes('FROM work_task_action_audits a')) return { rows: [] }
      if (sql.includes('FROM personnel_workload_claims')) return { rows: allClaimTypes }
      if (sql.includes('FROM cleaning_tasks t')) return { rows: [] }
      throw new Error(`unexpected all-types query: ${sql.slice(0, 80)}`)
    },
  }
  const allTypesPreview = await buildPersonnelSettlementPreview({
    week_start: '2026-09-28', user_ids: ['all-types-1'], include_submitted_claims: true,
  }, allTypesExecutor)
  const allTypesPerson = allTypesPreview.people.find((person) => person.user_id === 'all-types-1')
  assert.ok(allTypesPerson)
  assert.deepStrictEqual(
    new Set(allTypesPerson?.lines.map((line) => line.component_type)),
    new Set(['warehouse_hour', 'overtime_hour', 'subsidy_amount', 'new_property_task', 'external_task']),
  )
  assert.deepStrictEqual(allTypesPerson?.totals, { subtotal_cents: 22_500, gst_cents: 0, total_cents: 22_500 })
  assert.ok(allTypesPerson?.lines.some((line) => line.source_id === 'claim-overtime-all' && line.service_date === '2026-09-28'))
  assert.ok(allTypesPerson?.lines.some((line) => line.source_id === 'claim-subsidy-all' && line.service_date === '2026-10-03'))

  const missingRateExecutor = {
    async query(sql: string) {
      if (sql.includes('FROM personnel_settlement_profiles')) return { rows: allTypesProfile }
      if (sql.includes('FROM personnel_fee_rules')) return { rows: allTypesRules.filter((row) => row.component_type !== 'overtime_hour') }
      if (sql.includes('FROM work_task_action_audits a')) return { rows: [] }
      if (sql.includes('FROM personnel_workload_claims')) return { rows: [allClaimTypes[1]] }
      if (sql.includes('FROM cleaning_tasks t')) return { rows: [] }
      throw new Error(`unexpected missing-rate query: ${sql.slice(0, 80)}`)
    },
  }
  const missingRatePreview = await buildPersonnelSettlementPreview({
    week_start: '2026-09-28', user_ids: ['all-types-1'], include_submitted_claims: true,
  }, missingRateExecutor)
  assert.deepStrictEqual(missingRatePreview.people[0]?.warnings, [{
    source_type: 'workload_claim', source_id: 'claim-overtime-all', reason: 'missing_rule_item',
    service_date: '2026-09-28', component_type: 'overtime_hour', description: 'Overtime',
  }])

  const unconfirmedGstExecutor = {
    async query(sql: string) {
      if (sql.includes('FROM personnel_settlement_profiles')) return { rows: [{ ...allTypesProfile[0], gst_status: 'unconfirmed' }] }
      if (sql.includes('FROM personnel_fee_rules')) return { rows: allTypesRules }
      if (sql.includes('FROM work_task_action_audits a')) return { rows: [] }
      if (sql.includes('FROM personnel_workload_claims')) return { rows: [allClaimTypes[2]] }
      if (sql.includes('FROM cleaning_tasks t')) return { rows: [] }
      throw new Error(`unexpected unconfirmed-gst query: ${sql.slice(0, 80)}`)
    },
  }
  const unconfirmedGstPreview = await buildPersonnelSettlementPreview({
    week_start: '2026-09-28', user_ids: ['all-types-1'], include_submitted_claims: true,
  }, unconfirmedGstExecutor)
  assert.strictEqual(unconfirmedGstPreview.people[0]?.warnings[0]?.reason, 'gst_status_unconfirmed')
  assert.strictEqual(unconfirmedGstPreview.people[0]?.warnings[0]?.service_date, '2026-10-03')

  const missingProfileExecutor = {
    async query(sql: string) {
      if (sql.includes('FROM personnel_settlement_profiles')) return { rows: [] }
      if (sql.includes('FROM personnel_fee_rules')) return { rows: allTypesRules }
      if (sql.includes('FROM work_task_action_audits a')) return { rows: [] }
      if (sql.includes('FROM personnel_workload_claims')) return { rows: [allClaimTypes[1]] }
      if (sql.includes('FROM cleaning_tasks t')) return { rows: [] }
      throw new Error(`unexpected missing-profile query: ${sql.slice(0, 80)}`)
    },
  }
  const missingProfilePreview = await buildPersonnelSettlementPreview({
    week_start: '2026-09-28', user_ids: ['all-types-1'], include_submitted_claims: true,
  }, missingProfileExecutor)
  assert.strictEqual(missingProfilePreview.people[0]?.warnings[0]?.reason, 'missing_effective_profile')
  assert.strictEqual(missingProfilePreview.people[0]?.warnings[0]?.component_type, 'overtime_hour')

  const privacyExecutor = {
    async query(sql: string) {
      if (sql.includes('FROM personnel_settlement_profiles')) return { rows: [{ ...profiles[0], id: 'profile-old', user_id: 'cleaner-old', user_name: 'Cleaner Old' }] }
      if (sql.includes('FROM personnel_fee_rules')) return { rows: [] }
      if (sql.includes('FROM work_task_action_audits a') && sql.includes('JOIN cleaning_tasks t')) {
        assert.match(
          sql,
          /COALESCE\(t\.cleaner_id::text, t\.assignee_id::text\) = ANY\(\$3::text\[\]\)/,
          'assignee-only historical checkout tasks must stay in scope so another performer audit is detected',
        )
        return { rows: [previewAudits[0]] }
      }
      if (sql.includes('FROM personnel_workload_claims')) return { rows: [] }
      if (sql.includes('FROM cleaning_tasks t')) return { rows: [{
        task_id: 'task-assigned', component_type: 'cleaning_task', user_id: 'cleaner-old', user_name: 'Cleaner Old',
        service_date: '2026-09-08', current_service_date: '2026-09-08', arrangement_reason: null,
        task_status: 'cleaned', property_id: 'property-1', property_label: 'P-1', property_type: '一房一卫', task_type: 'checkout_clean',
      }] }
      throw new Error(`unexpected privacy query: ${sql.slice(0, 80)}`)
    },
  }
  const privacyPreview = await buildPersonnelSettlementPreview({ week_start: '2026-09-07', user_ids: ['cleaner-old'] }, privacyExecutor)
  const oldPerformerItem = privacyPreview.people.find((person) => person.user_id === 'cleaner-old')?.work_checklist[0]
  assert.deepStrictEqual(oldPerformerItem && {
    status: oldPerformerItem.status,
    reason: oldPerformerItem.status_reason,
    included_in_amount: oldPerformerItem.included_in_amount,
    audit_id: oldPerformerItem.audit_id,
    performed_by_user_id: oldPerformerItem.performed_by_user_id,
    performed_by_name: oldPerformerItem.performed_by_name,
    evidence_count: oldPerformerItem.evidence_count,
  }, {
    status: 'rescheduled',
    reason: 'executed_by_different_performer',
    included_in_amount: false,
    audit_id: null,
    performed_by_user_id: null,
    performed_by_name: null,
    evidence_count: 0,
  })

  console.log('personnel settlement phase 1 contract tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
