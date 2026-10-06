import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { getMelbourneDate, getSettlementWeekStart } from '../../src/lib/personnelSettlement'
import {
  assertPersonnelSettlementTransition,
  buildPersonnelSettlementSubmissionSnapshot,
  calculatePersonnelSettlementDisputeResolution,
  comparePersonnelSettlementFinanceReview,
  getPersonnelSettlementReturnDeliveryRetry,
  getPersonnelSettlementAvailableActions,
  personnelSettlementSubmissionStatus,
  validatePersonnelSettlementPayment,
} from '../../src/lib/personnelSettlementWorkflow'
import {
  normalizePersonnelPaymentMethod,
  personnelPaymentMethodRequiresBankDetails,
} from '../../src/lib/personnelSettlementPayment'
import {
  buildPersonnelClaimOptions,
  calculatePersonnelClaimEstimate,
  personnelClaimOptionAllowsClaim,
  personnelClaimRequiresEvidence,
  validatePersonnelClaimInput,
  validatePersonnelClaimReviewInput,
} from '../../src/lib/personnelWorkloadClaims'
import {
  claimReviewEstimateQuerySchema,
  myClaimEstimateQuerySchema,
  myClaimOptionsQuerySchema,
  myClaimListQuerySchema,
  myWeeklySubmissionBodySchema,
  myWeeklySubmissionQuerySchema,
  myWeeklyListQuerySchema,
} from '../../src/modules/personnel_settlements'

const backendRoot = path.resolve(__dirname, '../..')
const workflow = fs.readFileSync(path.join(backendRoot, 'src/lib/personnelSettlementWorkflow.ts'), 'utf8')
const claims = fs.readFileSync(path.join(backendRoot, 'src/lib/personnelWorkloadClaims.ts'), 'utf8')
const preview = fs.readFileSync(path.join(backendRoot, 'src/lib/personnelSettlementPreview.ts'), 'utf8')
const router = fs.readFileSync(path.join(backendRoot, 'src/modules/personnel_settlements.ts'), 'utf8')
const crudRouter = fs.readFileSync(path.join(backendRoot, 'src/modules/crud.ts'), 'utf8')
const weeklyPanel = fs.readFileSync(path.resolve(backendRoot, '../frontend/src/app/finance/settlements/WeeklySettlementsPanel.tsx'), 'utf8')
const claimsPanel = fs.readFileSync(path.resolve(backendRoot, '../frontend/src/app/finance/settlements/WorkloadClaimsPanel.tsx'), 'utf8')
const page = fs.readFileSync(path.resolve(backendRoot, '../frontend/src/app/finance/settlements/page.tsx'), 'utf8')

assert.strictEqual(getSettlementWeekStart('2026-09-06'), '2026-08-31')
assert.strictEqual(getSettlementWeekStart('2026-09-07'), '2026-09-07')
assert.throws(() => getSettlementWeekStart('2026-02-30'), /invalid_service_date/)
assert.strictEqual(getMelbourneDate(new Date('2026-09-10T14:30:00Z')), '2026-09-11')

const hourlyClaim = validatePersonnelClaimInput({
  service_date: '2026-09-09',
  claim_type: 'warehouse_hour',
  started_at: '2026-09-09T00:00:00Z',
  ended_at: '2026-09-09T01:30:00Z',
  note: 'Warehouse shift',
}, new Date('2026-09-10T00:00:00Z'))
assert.strictEqual(hourlyClaim.duration_minutes, 90)
assert.throws(() => validatePersonnelClaimInput({
  service_date: '2026-09-09',
  claim_type: 'overtime_hour',
  note: 'Overtime',
}), /claim_duration_required/)
assert.throws(() => validatePersonnelClaimInput({
  service_date: '2026-09-09',
  claim_type: 'subsidy_amount',
  note: 'Travel',
}), /claim_amount_or_quantity_required/)
assert.throws(() => validatePersonnelClaimInput({
  service_date: '2026-09-12',
  claim_type: 'custom_amount',
  requested_amount_cents: 1000,
  note: 'Future',
}, new Date('2026-09-10T00:00:00Z')), /claim_service_date_in_future/)
assert.throws(() => validatePersonnelClaimReviewInput({ action: 'return' }), /claim_review_note_required/)
assert.throws(() => validatePersonnelClaimInput({
  service_date: '2026-09-09',
  claim_type: 'new_property_task',
  started_at: '2026-09-09T00:00:00Z',
  ended_at: '2026-09-09T02:00:00Z',
  note: 'New property setup',
}, new Date('2026-09-10T00:00:00Z')), /claim_property_required/)
assert.throws(() => validatePersonnelClaimInput({
  service_date: '2026-09-09',
  claim_type: 'new_property_task',
  property_id: 'FG1003',
  note: 'New property setup',
}, new Date('2026-09-10T00:00:00Z')), /claim_duration_required/)
const newPropertyClaim = validatePersonnelClaimInput({
  service_date: '2026-09-09',
  claim_type: 'new_property_task',
  property_id: 'FG1003',
  started_at: '2026-09-09T00:00:00Z',
  ended_at: '2026-09-09T02:30:00Z',
  note: 'New property setup',
}, new Date('2026-09-10T00:00:00Z'))
assert.strictEqual(newPropertyClaim.duration_minutes, 150)
assert.strictEqual(newPropertyClaim.requested_quantity, null)

const configuredClaimOptions = buildPersonnelClaimOptions([
  { component_type: 'cleaning_task' },
  { component_type: 'trial_hour' },
  { component_type: 'external_hour' },
  { component_type: 'external_day' },
  { component_type: 'new_property_task' },
  { component_type: 'subsidy_amount' },
])
assert.deepStrictEqual(configuredClaimOptions.map((option) => option.business_type), [
  'warehouse', 'overtime', 'subsidy', 'new_property', 'external',
])
assert.deepStrictEqual(configuredClaimOptions.find((option) => option.business_type === 'external'), {
  business_type: 'external', claim_type: 'external_hour', label: '编外合作',
  calculation_label: '系统按小时计算', input_mode: 'time_range', evidence_required: true,
  property_required: false, rule_configured: true,
})
assert.strictEqual(configuredClaimOptions.find((option) => option.business_type === 'new_property')?.rule_configured, true)
assert.deepStrictEqual(configuredClaimOptions.find((option) => option.business_type === 'new_property'), {
  business_type: 'new_property', claim_type: 'new_property_task', label: '上新房',
  calculation_label: '系统按小时计算', input_mode: 'time_range', evidence_required: false,
  property_required: true, rule_configured: true,
})
assert.strictEqual(configuredClaimOptions.find((option) => option.business_type === 'warehouse')?.rule_configured, false)
assert.strictEqual(configuredClaimOptions.some((option) => option.claim_type.startsWith('trial_')), false)
assert.strictEqual(personnelClaimRequiresEvidence('new_property_task'), false)
assert.strictEqual(personnelClaimRequiresEvidence('subsidy_amount'), true)
const selfServiceOptions = buildPersonnelClaimOptions([])
assert.strictEqual(selfServiceOptions.length, 5)
assert.strictEqual(selfServiceOptions.find((option) => option.claim_type === 'subsidy_amount')?.rule_configured, true)
assert.strictEqual(selfServiceOptions.some((option) => option.claim_type === 'custom_amount'), false)
assert.strictEqual(selfServiceOptions.find((option) => option.claim_type === 'warehouse_hour')?.rule_configured, false)
assert.strictEqual(personnelClaimOptionAllowsClaim(selfServiceOptions, 'new_property_task'), true)
assert.strictEqual(personnelClaimOptionAllowsClaim(selfServiceOptions, 'subsidy_amount'), true)
assert.strictEqual(personnelClaimOptionAllowsClaim(selfServiceOptions, 'custom_amount'), false)
assert.strictEqual(personnelClaimOptionAllowsClaim(selfServiceOptions, 'trial_task'), false)

assert.deepStrictEqual(calculatePersonnelClaimEstimate({
  serviceDate: '2026-09-09',
  claimType: 'subsidy_amount',
  requestedAmountCents: 1368,
  rule: {
    ruleId: null, ruleName: null, effectiveFrom: '2026-09-01',
    priceBasis: 'inclusive_gst', unitRateCents: null, gstStatus: 'registered',
  },
}), {
  available: true,
  reason: null,
  rule_id: null,
  rule_name: null,
  effective_from: '2026-09-01',
  price_basis: 'inclusive_gst',
  unit_rate_cents: 1368,
  gst_status: 'registered',
  quantity_numerator: 1,
  quantity_denominator: 1,
  subtotal_cents: 1244,
  gst_cents: 124,
  total_cents: 1368,
})
assert.deepStrictEqual(calculatePersonnelClaimEstimate({
  serviceDate: '2026-09-09',
  claimType: 'custom_amount',
  requestedAmountCents: 1368,
  rule: {
    ruleId: null, ruleName: null, effectiveFrom: '2026-09-01',
    priceBasis: 'inclusive_gst', unitRateCents: null, gstStatus: 'not_registered',
  },
}), {
  available: true,
  reason: null,
  rule_id: null,
  rule_name: null,
  effective_from: '2026-09-01',
  price_basis: 'inclusive_gst',
  unit_rate_cents: 1368,
  gst_status: 'not_registered',
  quantity_numerator: 1,
  quantity_denominator: 1,
  subtotal_cents: 1368,
  gst_cents: 0,
  total_cents: 1368,
})
const estimatePersonnelClaimSource = claims.slice(claims.indexOf('export async function estimatePersonnelClaim('))
assert.ok(
  estimatePersonnelClaimSource.indexOf('if (DIRECT_AMOUNT_TYPES.has(claimType))')
    < estimatePersonnelClaimSource.indexOf('WITH selected_rule AS'),
  'direct amount estimates must use the effective profile before any fee-rule lookup',
)

assert.deepStrictEqual(calculatePersonnelClaimEstimate({
  serviceDate: '2026-09-09',
  claimType: 'new_property_task',
  durationMinutes: 150,
  rule: {
    ruleId: 'new-property-rule', ruleName: 'New property setup', effectiveFrom: '2026-09-01',
    priceBasis: 'inclusive_gst', unitRateCents: 20000, gstStatus: 'registered',
  },
}), {
  available: true,
  reason: null,
  rule_id: 'new-property-rule',
  rule_name: 'New property setup',
  effective_from: '2026-09-01',
  price_basis: 'inclusive_gst',
  unit_rate_cents: 20000,
  gst_status: 'registered',
  quantity_numerator: 150,
  quantity_denominator: 60,
  subtotal_cents: 45455,
  gst_cents: 4545,
  total_cents: 50000,
})

assert.deepStrictEqual(calculatePersonnelClaimEstimate({
  serviceDate: '2026-09-04',
  claimType: 'warehouse_hour',
  durationMinutes: 70,
  rule: {
    ruleId: 'rule-1',
    ruleName: 'Cleaner rule',
    effectiveFrom: '2026-09-01',
    priceBasis: 'inclusive_gst',
    unitRateCents: 3500,
    gstStatus: 'registered',
  },
}), {
  available: true,
  reason: null,
  rule_id: 'rule-1',
  rule_name: 'Cleaner rule',
  effective_from: '2026-09-01',
  price_basis: 'inclusive_gst',
  unit_rate_cents: 3500,
  gst_status: 'registered',
  quantity_numerator: 70,
  quantity_denominator: 60,
  subtotal_cents: 3712,
  gst_cents: 371,
  total_cents: 4083,
})

assert.deepStrictEqual(calculatePersonnelClaimEstimate({
  serviceDate: '2026-09-14',
  claimType: 'warehouse_hour',
  durationMinutes: 50,
  rule: {
    ruleId: 'rule-1',
    ruleName: 'Cleaner rule',
    effectiveFrom: '2026-09-14',
    priceBasis: 'inclusive_gst',
    unitRateCents: 3500,
    gstStatus: 'registered',
  },
}), {
  available: true,
  reason: null,
  rule_id: 'rule-1',
  rule_name: 'Cleaner rule',
  effective_from: '2026-09-14',
  price_basis: 'inclusive_gst',
  unit_rate_cents: 3500,
  gst_status: 'registered',
  quantity_numerator: 50,
  quantity_denominator: 60,
  subtotal_cents: 2652,
  gst_cents: 265,
  total_cents: 2917,
})

assert.deepStrictEqual(myClaimListQuerySchema.parse({ _: '1789107631516' }), { _: '1789107631516' })
assert.deepStrictEqual(myWeeklyListQuerySchema.parse({ _: ['1789107631516'] }), { _: ['1789107631516'] })
assert.deepStrictEqual(myWeeklySubmissionQuerySchema.parse({
  week_start: '2026-09-07',
  _: '1789107631516',
}), {
  week_start: '2026-09-07',
  _: '1789107631516',
})
const weeklyConfirmationToken = 'a'.repeat(64)
assert.deepStrictEqual(myWeeklySubmissionBodySchema.parse({
  week_start: '2026-09-07',
  confirmation_token: weeklyConfirmationToken,
}), {
  week_start: '2026-09-07',
  confirmation_token: weeklyConfirmationToken,
})
assert.deepStrictEqual(myClaimOptionsQuerySchema.parse({ service_date: '2026-09-09', _: '1789107631516' }), {
  service_date: '2026-09-09', _: '1789107631516',
})
assert.deepStrictEqual(myClaimEstimateQuerySchema.parse({
  service_date: '2026-09-09',
  claim_type: 'warehouse_hour',
  duration_minutes: '70',
}), {
  service_date: '2026-09-09',
  claim_type: 'warehouse_hour',
  duration_minutes: 70,
})
assert.deepStrictEqual(claimReviewEstimateQuerySchema.parse({
  duration_minutes: '50',
}), { duration_minutes: 50 })
assert.strictEqual(myClaimListQuerySchema.safeParse({ unexpected: 'value' }).success, false)
assert.strictEqual(myWeeklyListQuerySchema.safeParse({ search: 'not-allowed-for-self' }).success, false)
assert.strictEqual(myWeeklySubmissionQuerySchema.safeParse({
  week_start: '2026-09-07',
  search: 'not-allowed-for-self',
}).success, false)
assert.strictEqual(myWeeklySubmissionBodySchema.safeParse({
  week_start: '2026-09-07',
  confirmation_token: weeklyConfirmationToken,
  _: '1789107631516',
}).success, false)
assert.strictEqual(myWeeklySubmissionBodySchema.safeParse({ week_start: '2026-09-07' }).success, false)

const submissionSnapshot = buildPersonnelSettlementSubmissionSnapshot({
  weekStart: '2026-09-07',
  weekEnd: '2026-09-13',
  person: {
    totals: { subtotal_cents: 3182, gst_cents: 318, total_cents: 3500 },
    lines: [{
      component_type: 'subsidy_amount', service_date: '2026-09-10',
      source_type: 'workload_claim', source_id: 'claim-1', description: '雨补',
      quantity_numerator: 1, quantity_denominator: 1, unit_rate_cents: 3500,
      subtotal_cents: 3182, gst_cents: 318, total_cents: 3500,
      price_basis: 'inclusive_gst',
    }],
    warnings: [],
  },
})
assert.strictEqual(submissionSnapshot.confirmation_token.length, 64)
assert.deepStrictEqual(submissionSnapshot.lines, [{
  id: 'workload_claim:claim-1:subsidy_amount', component_type: 'subsidy_amount',
  service_date: '2026-09-10', source_type: 'workload_claim', source_id: 'claim-1',
  description: '雨补', quantity_numerator: 1, quantity_denominator: 1,
  unit_rate_cents: 3500, subtotal_cents: 3182, gst_cents: 318, total_cents: 3500,
  price_basis: 'inclusive_gst', evidence_count: 0,
}])
assert.notStrictEqual(buildPersonnelSettlementSubmissionSnapshot({
  weekStart: '2026-09-07',
  weekEnd: '2026-09-13',
  person: {
    totals: { subtotal_cents: 3182, gst_cents: 318, total_cents: 3501 },
    lines: submissionSnapshot.lines,
    warnings: [],
  },
}).confirmation_token, submissionSnapshot.confirmation_token)
assert.deepStrictEqual(comparePersonnelSettlementFinanceReview({
  unresolvedClaimCount: 0,
  partnerSnapshot: submissionSnapshot,
  reviewedSnapshot: submissionSnapshot,
}), {
  unresolved_claim_count: 0,
  changed: false,
  can_pay_without_reconfirmation: true,
  partner_line_count: 1,
  reviewed_line_count: 1,
  partner_subtotal_cents: 3182,
  partner_gst_cents: 318,
  partner_total_cents: 3500,
  reviewed_subtotal_cents: 3182,
  reviewed_gst_cents: 318,
  reviewed_total_cents: 3500,
  difference_cents: 0,
  blocking_issues: [],
})
const reducedReviewSnapshot = buildPersonnelSettlementSubmissionSnapshot({
  weekStart: '2026-09-07',
  weekEnd: '2026-09-13',
  person: { totals: { subtotal_cents: 0, gst_cents: 0, total_cents: 0 }, lines: [], warnings: [] },
})
assert.deepStrictEqual(comparePersonnelSettlementFinanceReview({
  unresolvedClaimCount: 0,
  partnerSnapshot: submissionSnapshot,
  reviewedSnapshot: reducedReviewSnapshot,
}), {
  unresolved_claim_count: 0,
  changed: true,
  can_pay_without_reconfirmation: false,
  partner_line_count: 1,
  reviewed_line_count: 0,
  partner_subtotal_cents: 3182,
  partner_gst_cents: 318,
  partner_total_cents: 3500,
  reviewed_subtotal_cents: 0,
  reviewed_gst_cents: 0,
  reviewed_total_cents: 0,
  difference_cents: -3500,
  blocking_issues: [],
})
assert.strictEqual(myClaimOptionsQuerySchema.safeParse({ service_date: '2026-09-09', search: 'not-allowed' }).success, false)
assert.strictEqual(claimReviewEstimateQuerySchema.safeParse({ user_id: 'another-person' }).success, false)

assert.deepStrictEqual(getPersonnelSettlementAvailableActions('draft'), ['issue_confirmation', 'return_for_confirmation', 'adjust', 'void'])
assert.deepStrictEqual(getPersonnelSettlementAvailableActions('awaiting_confirmation'), ['confirm', 'dispute', 'reopen', 'void'])
assert.deepStrictEqual(getPersonnelSettlementAvailableActions('confirmed'), ['return_for_confirmation', 'approve', 'reopen', 'void'])
assert.deepStrictEqual(getPersonnelSettlementAvailableActions('disputed'), ['resolve_dispute', 'void'])
assert.deepStrictEqual(getPersonnelSettlementAvailableActions('finance_approved'), ['confirm_paid', 'void'])
assert.deepStrictEqual(getPersonnelSettlementAvailableActions('paid'), [])
assert.strictEqual(personnelSettlementSubmissionStatus(null), 'not_submitted')
assert.strictEqual(personnelSettlementSubmissionStatus('void'), 'not_submitted')
assert.strictEqual(personnelSettlementSubmissionStatus('confirmed'), 'confirmed')
assert.throws(() => personnelSettlementSubmissionStatus('unknown'), /invalid_settlement_status/)
assert.doesNotThrow(() => assertPersonnelSettlementTransition('approve', 'confirmed'))
assert.throws(() => assertPersonnelSettlementTransition('confirm_paid', 'confirmed'), /settlement_transition_invalid/)
assert.doesNotThrow(() => assertPersonnelSettlementTransition('return_for_confirmation', 'confirmed'))
assert.doesNotThrow(() => assertPersonnelSettlementTransition('return_for_confirmation', 'draft'))
assert.deepStrictEqual(getPersonnelSettlementReturnDeliveryRetry({
  status: 'awaiting_confirmation',
  user_id: 'cleaner-1',
  week_start: '2026-09-07',
  week_end: '2026-09-13',
  rule_snapshot: {
    finance_return: { returned_at: '2026-09-15T01:00:00.000Z' },
    confirmation_request: { revision: '2026-09-15T01:00:00.000Z', round: 'finance_return' },
  },
}), {
  userId: 'cleaner-1',
  weekStart: '2026-09-07',
  weekEnd: '2026-09-13',
  confirmationRevision: '2026-09-15T01:00:00.000Z',
})
assert.strictEqual(getPersonnelSettlementReturnDeliveryRetry({
  status: 'awaiting_confirmation',
  rule_snapshot: { confirmation_request: { revision: '2026-09-15T01:00:00.000Z', round: 'initial' } },
}), null)
assert.doesNotThrow(() => assertPersonnelSettlementTransition('confirm_paid', 'finance_approved'))
assert.throws(() => assertPersonnelSettlementTransition('confirm_paid', 'draft'), /settlement_transition_invalid/)
assert.throws(() => assertPersonnelSettlementTransition('reopen', 'disputed'), /settlement_transition_invalid/)
assert.deepStrictEqual(calculatePersonnelSettlementDisputeResolution({
  decision: 'keep_amount', baseSubtotalCents: 10000, baseGstCents: 1000, currentTotalCents: 11500,
}), { adjustment_cents: 500, subtotal_cents: 10500, gst_cents: 1000, total_cents: 11500 })
assert.deepStrictEqual(calculatePersonnelSettlementDisputeResolution({
  decision: 'edit_amount', baseSubtotalCents: 10000, baseGstCents: 1000, currentTotalCents: 11000, finalTotalCents: 12500,
}), { adjustment_cents: 1500, subtotal_cents: 11500, gst_cents: 1000, total_cents: 12500 })
assert.throws(() => calculatePersonnelSettlementDisputeResolution({
  decision: 'edit_amount', baseSubtotalCents: 10000, baseGstCents: 1000, currentTotalCents: 11000, finalTotalCents: 500,
}), /settlement_adjustment_exceeds_total/)

assert.deepStrictEqual(validatePersonnelSettlementPayment({
  payment_date: '2026-09-10',
}, new Date('2026-09-10T12:00:00Z')), {
  payment_date: '2026-09-10',
})
assert.throws(() => validatePersonnelSettlementPayment({
  payment_date: '2026-02-30',
}), /invalid_payment_date/)
assert.strictEqual(normalizePersonnelPaymentMethod(null), 'bank_transfer')
assert.strictEqual(personnelPaymentMethodRequiresBankDetails('cash'), false)

assert.match(router, /router\.post\('\/my-claims\/:claimId\/submit'/)
assert.match(router, /router\.get\('\/my-claim-options'/)
assert.match(router, /router\.get\('\/my-claim-estimate'/)
assert.match(router, /router\.get\('\/claims\/:claimId\/estimate', requirePerm\('personnel_settlements\.profiles\.view'\)/)
assert.match(router, /router\.post\('\/my-settlements\/:settlementId\/claims\/:claimId\/submit-for-reconciliation'/)
assert.match(router, /'\/claims\/:claimId\/review',[\s\S]*requireAnyPerm\(\['personnel_settlements\.rules\.manage', 'finance\.payout'\]\)/)
assert.match(router, /router\.post\('\/weekly\/generate', requirePerm\('personnel_settlements\.rules\.manage'\)/)
assert.match(router, /'\/weekly\/:settlementId\/confirm-paid',[\s\S]*requirePerm\('finance\.payout'\),[\s\S]*requirePerm\('personnel_settlements\.bank\.manage'\)/)
assert.match(router, /payment_reference: z\.string\(\)\.trim\(\)\.max\(120\)\.optional\(\)\.nullable\(\)/)
assert.match(router, /router\.post\('\/weekly\/:settlementId\/approve', requirePerm\('finance\.payout'\)/)
assert.match(router, /approvePersonnelSettlementFinanceReview/)
assert.doesNotMatch(router, /settlement_approval_step_removed/)
assert.match(router, /'\/weekly\/:settlementId\/resolve-dispute',[\s\S]*requireAnyPerm\(\['personnel_settlements\.rules\.manage', 'finance\.payout'\]\)/)
assert.match(router, /'\/weekly\/:settlementId\/claims\/:claimId\/review',[\s\S]*requireAnyPerm\(\['personnel_settlements\.rules\.manage', 'finance\.payout'\]\)/)
assert.match(workflow, /pg_advisory_xact_lock/)
assert.match(workflow, /FOR UPDATE/)
assert.match(workflow, /ON CONFLICT \(ref_type, ref_id\)/)
assert.match(workflow, /'cleaning_expense','personnel_settlement'/)
assert.match(workflow, /SET status='finance_approved', finance_reviewed_by=/)
assert.match(workflow, /SET status='paid', finance_reviewed_by=/)
assert.match(workflow, /finance_reviewed_by=COALESCE\(finance_reviewed_by,\$1\)/)
assert.match(workflow, /company_expenses\.manual_override/)
assert.match(workflow, /frozenBankComplete \? existingPaymentDestination : bankResult\.rows/)
assert.match(workflow, /personnelPaymentMethodRequiresBankDetails\(paymentMethod\)/)
assert.match(workflow, /payment_method: paymentMethod/)
assert.match(workflow, /company_expense_paid_lock/)
const confirmPaidFlow = workflow.slice(workflow.indexOf('export async function confirmPersonnelSettlementPaid'))
assert.doesNotMatch(confirmPaidFlow, /input\.payment_reference|payment_reference=\$/)
assert.match(crudRouter, /resource === 'company_expenses'[\s\S]*ref_type \|\| ''\) === 'personnel_weekly_settlement'[\s\S]*auto_generated_expense_readonly/)
assert.match(claims, /personnelClaimRequiresEvidence\(current\.claim_type\)[\s\S]*claim_evidence_required/)
assert.match(claims, /manual_amount_not_allowed_for_claim_type/)
assert.match(claims, /reviewPersonnelClaimInTransaction[\s\S]*estimatePersonnelClaimForReview[\s\S]*calculation_preview/)
assert.match(claims, /reviewPersonnelClaimInTransaction[\s\S]*assertNoApprovedPersonnelClaimDuplicate\(current, client\)/)
assert.match(router, /duplicate_approved_claim/)
assert.match(claims, /createPersonnelClaim[\s\S]*assertPersonnelSelfServiceClaimAllowed/)
assert.match(claims, /updatePersonnelClaim[\s\S]*assertPersonnelSelfServiceClaimAllowed/)
assert.match(claims, /submitPersonnelClaimInTransaction[\s\S]*assertPersonnelSelfServiceClaimAllowed/)
const assignmentQuery = preview.slice(preview.indexOf('SELECT t.id::text AS task_id'), preview.indexOf('const profiles ='))
assert.match(assignmentQuery, /t\.cleaner_id::text = ANY\(\$3::text\[\]\)/)
assert.match(assignmentQuery, /NULLIF\(TRIM\(t\.cleaner_id::text\), ''\) IS NOT NULL/)
assert.doesNotMatch(assignmentQuery, /complete_cleaning|fill_supplies/)
assert.match(preview, /status = ANY\(\$4::text\[\]\)/)
assert.match(workflow, /include_submitted_claims: true/)
assert.match(workflow, /settlement_finance_review_changed/)
assert.match(workflow, /settlement_finance_review_unchanged/)
assert.match(workflow, /hasFinanceReturnedZeroSettlement/)
assert.match(workflow, /settlement_partner_submission_required/)
assert.match(workflow, /resubmittingVoidedSettlement \? 'partner_resubmit_after_void'/)
assert.match(workflow, /company_expense_id=NULL, paid_by=NULL, paid_at=NULL/)
const inspectionQuery = preview.slice(preview.indexOf('SELECT a.id AS audit_id'), preview.indexOf('FROM personnel_workload_claims'))
assert.match(inspectionQuery, /a\.performed_by_user_id = ANY\(\$3::text\[\]\)/)
assert.match(inspectionQuery, /\[\.\.\.params, \['submit_inspection'\]\]/)
assert.doesNotMatch(claims.slice(claims.indexOf('const CLAIM_SELECT'), claims.indexOf('export async function listPersonnelClaims')), /storage_key/)
const relatedClaimsQuery = claims.slice(claims.indexOf('export async function listPersonnelClaimsWithEvidence'), claims.indexOf('export async function getPersonnelClaim'))
assert.match(relatedClaimsQuery, /media_id, mime_type, byte_size, original_file_name/)
assert.doesNotMatch(relatedClaimsQuery, /storage_key/)
assert.match(workflow, /related_claims: relatedClaims\.map/)
const reviewHelperStart = claims.indexOf('export async function reviewPersonnelClaimInTransaction')
const reviewLockStart = claims.indexOf('const locked = await client.query', reviewHelperStart)
const reviewEvidenceStart = claims.indexOf('const evidence = await client.query', reviewLockStart)
assert.match(claims.slice(reviewLockStart, reviewEvidenceStart), /'disputed'/)
assert.match(workflow, /reviewPersonnelClaimInTransaction/)
assert.match(workflow, /submitPersonnelClaimInTransaction/)
const reconciliationFlow = workflow.slice(
  workflow.indexOf('export async function submitPersonnelSettlementClaimForReconciliation'),
  workflow.indexOf('export async function reviewPersonnelSettlementDisputeClaim'),
)
assert.match(reconciliationFlow, /pgRunInTransaction/)
assert.match(reconciliationFlow, /submitPersonnelClaimInTransaction/)
assert.match(reconciliationFlow, /status='disputed'/)
assert.match(reconciliationFlow, /settlement_claim_period_mismatch/)
assert.match(workflow, /include_approved_claim/)
assert.match(workflow, /settlement_claim_calculation_failed/)
const auditSummary = workflow.slice(workflow.indexOf('function settlementAuditSummary'), workflow.indexOf('async function insertAudit'))
assert.doesNotMatch(auditSummary, /payment_destination_snapshot/)
assert.match(page, /label: '周结算'/)
assert.match(page, /label: '工作量反馈'/)
assert.match(weeklyPanel, /确认已付款/)
assert.match(weeklyPanel, /财务核定结果与合作方确认完全一致/)
assert.match(weeklyPanel, /重算并退回确认/)
assert.doesNotMatch(weeklyPanel, /\{ key: 'reopen'/)
assert.match(weeklyPanel, /本次付款金额/)
assert.match(weeklyPanel, /请先完成\$\{PERSONNEL_PAYMENT_METHOD_LABELS\[paymentMethod\]\}/)
assert.match(weeklyPanel, /结算账面金额仍以 AUD 记录/)
assert.doesNotMatch(weeklyPanel, /银行转账编号|转账编号|payment_reference/)
assert.doesNotMatch(weeklyPanel, /付款金额（AUD）/)
assert.match(weeklyPanel, /确认并重新发起/)
assert.match(weeklyPanel, /本周补充内容/)
assert.match(weeklyPanel, /确认并自动计入/)
assert.match(weeklyPanel, /计入当前金额/)
assert.match(weeklyPanel, /反馈已确认并自动计入/)
assert.match(weeklyPanel, /证明照片/)
assert.match(weeklyPanel, /loadPersonnelClaimEvidenceObjectUrl/)
assert.match(claimsPanel, /证明照片仅通过登录鉴权接口显示/)
assert.match(claimsPanel, /系统自动计算/)
assert.match(claimsPanel, /确认计入金额/)
assert.match(claimsPanel, /确认并计入/)
assert.match(claimsPanel, /已有内容完全相同的反馈确认计入/)
assert.match(weeklyPanel, /已有内容完全相同的反馈确认计入/)
assert.doesNotMatch(claimsPanel, /直接确认金额（AUD，可选）/)
assert.ok(claimsPanel.includes("if (mode === 'time_range') return `${rate}/小时 × ${values.approved_duration_minutes || 0}分钟 ÷ 60`"))
assert.doesNotMatch(claimsPanel, /new_property_task'\) return `\$\{rate\}\/次/)

console.log('personnel settlement phase3 contract tests passed')
