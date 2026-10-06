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
  metadata: { step: 'completion_photos_saved' },
}).reason, 'completion_photo_only')
assert.strictEqual(classifyWorkloadAudit({
  ...baseAudit,
  action: 'submit_inspection',
  status_after: 'inspected',
  metadata: { route: 'mzapp.cleaning_tasks.restock_proof' },
}).reason, 'restock_proof_only')

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
  { ...baseAudit, audit_id: 'audit-i1', task_id: 'inspection-1', user_id: 'inspector-1', performed_by_name: 'Inspector One', action: 'submit_inspection', status_after: 'inspected', property_id: 'property-2' },
  { ...baseAudit, audit_id: 'audit-i2', task_id: 'inspection-2', user_id: 'inspector-1', performed_by_name: 'Inspector One', action: 'submit_inspection', status_after: 'inspected', property_id: 'property-3' },
  { ...baseAudit, audit_id: 'audit-restock', task_id: 'restock-1', user_id: 'inspector-1', performed_by_name: 'Inspector One', action: 'submit_inspection', status_after: 'inspected', metadata: { route: 'mzapp.cleaning_tasks.restock_proof' } },
  { ...baseAudit, audit_id: 'audit-conflict-inspector', task_id: 'inspection-conflict', user_id: 'inspector-1', performed_by_name: 'Inspector One', action: 'submit_inspection', status_after: 'inspected' },
  { ...baseAudit, audit_id: 'audit-conflict-cleaner', task_id: 'inspection-conflict', user_id: 'cleaner-1', performed_by_name: 'Cleaner One', action: 'submit_inspection', status_after: 'inspected' },
]
const cleaningAssignments = [
  { task_id: 'task-assigned', user_id: 'cleaner-1', user_name: 'Cleaner One', service_date: '2026-09-08', task_status: 'assigned', property_id: 'property-1', property_label: 'P-1', property_type: '一房一卫', task_type: 'checkout_clean' },
  { task_id: 'task-assigned', user_id: 'cleaner-1', user_name: 'Cleaner One', service_date: '2026-09-08', task_status: 'assigned', property_id: 'property-1', property_label: 'P-1', property_type: '一房一卫', task_type: 'checkout_clean' },
  { task_id: 'task-checkin-pair', user_id: 'cleaner-1', user_name: 'Cleaner One', service_date: '2026-09-08', task_status: 'assigned', property_id: 'property-1', property_label: 'P-1', property_type: '一房一卫', task_type: 'checkin_clean' },
  { task_id: 'task-stayover', user_id: 'cleaner-1', user_name: 'Cleaner One', service_date: '2026-09-08', task_status: 'assigned', property_id: 'property-1', property_label: 'P-1', property_type: '一房一卫', task_type: 'stayover_clean' },
  { task_id: 'task-cancelled', user_id: 'cleaner-1', user_name: 'Cleaner One', service_date: '2026-09-09', task_status: 'cancelled', property_id: 'property-1', property_label: 'P-1', property_type: '一房一卫', task_type: 'checkout_clean' },
  { task_id: 'task-canceled', user_id: 'cleaner-1', user_name: 'Cleaner One', service_date: '2026-09-09', task_status: 'canceled', property_id: 'property-1', property_label: 'P-1', property_type: '一房一卫', task_type: 'checkout_clean' },
  { task_id: 'task-unknown-type', user_id: 'cleaner-1', user_name: 'Cleaner One', service_date: '2026-09-10', task_status: 'pending', property_id: 'property-unknown', property_label: 'P-X', property_type: null, task_type: 'checkout_clean' },
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
  assert.strictEqual(preview.source_summary.audited_candidates, 5)
  assert.strictEqual(preview.source_summary.eligible_deduplicated_candidates, 2)
  assert.strictEqual(preview.source_summary.excluded_auxiliary_candidates, 1)
  assert.strictEqual(preview.source_summary.conflicting_tasks_requiring_manual_review, 1)
  assert.strictEqual(preview.source_summary.cleaning_assignment_candidates, 6)
  assert.strictEqual(preview.source_summary.non_cancelled_cleaning_assignments, 2)
  assert.strictEqual(preview.source_summary.excluded_cancelled_cleaning_assignments, 2)
  assert.strictEqual(preview.source_summary.excluded_non_checkout_cleaning_assignments, 2)
  assert.strictEqual(preview.source_summary.approved_claims, 4)
  assert.strictEqual(preview.source_summary.submitted_claims, 0)
  assert.strictEqual(preview.source_summary.legacy_tasks_requiring_manual_review, 0)

  const cleaner = preview.people.find((person) => person.user_id === 'cleaner-1')
  const inspector = preview.people.find((person) => person.user_id === 'inspector-1')
  const warehouse = preview.people.find((person) => person.user_id === 'warehouse-1')
  const subsidyOnly = preview.people.find((person) => person.user_id === 'subsidy-only')
  assert.ok(cleaner)
  assert.ok(inspector)
  assert.ok(warehouse)
  assert.ok(subsidyOnly)
  assert.strictEqual(cleaner?.lines.filter((line) => line.component_type === 'cleaning_task').length, 1)
  assert.strictEqual(cleaner?.lines.find((line) => line.component_type === 'cleaning_task')?.source_type, 'cleaning_task_assignment')
  assert.strictEqual(cleaner?.lines.find((line) => line.component_type === 'cleaning_task')?.source_audit_id, null)
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
  assert.deepStrictEqual(inspector?.totals, { subtotal_cents: 25_000, gst_cents: 0, total_cents: 25_000 })
  assert.deepStrictEqual(warehouse?.totals, { subtotal_cents: 9_500, gst_cents: 0, total_cents: 9_500 })
  assert.deepStrictEqual(subsidyOnly?.totals, { subtotal_cents: 1_244, gst_cents: 124, total_cents: 1_368 })
  assert.strictEqual(subsidyOnly?.lines[0]?.rule_id, null)
  assert.strictEqual(subsidyOnly?.lines[0]?.rule_item_id, null)
  assert.ok(!subsidyOnly?.warnings.some((warning) => warning.reason === 'missing_effective_rule'))
  assert.deepStrictEqual(preview.totals, { subtotal_cents: 54_108, gst_cents: 1_960, total_cents: 56_068 })
  assert.strictEqual(preview.manual_review.legacy_tasks_without_performer_audit.length, 0)
  assert.ok(preview.manual_review.warnings.some((warning) => warning.reason === 'multiple_performers_for_task'))
  assert.ok(preview.manual_review.warnings.some((warning) => warning.reason === 'missing_or_unsupported_property_type'))
  assert.ok(preview.excluded_candidates.every((candidate) => !('metadata' in candidate)))

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

  console.log('personnel settlement phase 1 contract tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
