import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { inspectionAssignmentConflictPayload } from '../../src/lib/inspectionAssignmentConflict'
import { buildPersonnelSettlementPreview } from '../../src/lib/personnelSettlementPreview'
import { buildMz031CleaningArrangementRevision } from '../../src/services/workTaskEvents'
import {
  buildPersonnelSettlementSubmissionSnapshot,
  hydrateStoredPersonnelSettlementLineForSubmission,
} from '../../src/lib/personnelSettlementWorkflow'

const backendRoot = path.resolve(__dirname, '../..')
const migration = fs.readFileSync(
  path.join(backendRoot, 'scripts/migrations/20261013_inspection_assignment_conflict_guard.sql'),
  'utf8',
)
const taskCenter = fs.readFileSync(path.join(backendRoot, 'src/modules/task_center.ts'), 'utf8')

assert.match(migration, /^BEGIN;/)
assert.match(migration, /CREATE CONSTRAINT TRIGGER trg_effective_inspection_assignment_conflict/)
assert.match(migration, /DEFERRABLE INITIALLY DEFERRED/)
assert.match(migration, /pg_advisory_xact_lock/)
assert.match(migration, /inspection_assignment_property_date_conflict/)
assert.match(migration, /IS DISTINCT FROM requested_inspector/)
assert.match(migration, /work_task_events latest/)
assert.match(migration, /management_reopened/)
assert.match(migration, /current_setting\('mz\.inspection_management_closed_task_ids', true\)/)
assert.match(migration, /current_setting\('mz\.inspection_management_reopened_task_ids', true\)/)
assert.match(migration, /NULLIF\(TRIM\(t\.inspector_id::text\), ''\) IS NOT NULL/)
assert.doesNotMatch(migration, /COALESCE\([^\n]*inspector_id[^\n]*assignee_id/)
assert.doesNotMatch(migration, /COALESCE\([^\n]*assignee_id[^\n]*inspector_id/)
assert.match(migration, /first_effective_inspection_assignment_conflict/)
assert.match(migration, /existing_inspection_assignment_property_date_conflict/)
assert.match(migration, /CREATE CONSTRAINT TRIGGER trg_order_reactivation_inspection_conflict/)
assert.match(migration, /CREATE OR REPLACE FUNCTION enforce_inspection_management_event_conflict\(\)/)
assert.match(migration, /CREATE CONSTRAINT TRIGGER trg_inspection_management_event_conflict/)
assert.match(migration, /AFTER INSERT OR UPDATE OR DELETE\s+ON work_task_events/)
assert.match(migration, /enforce_inspection_management_event_conflict[\s\S]*management_reopened[\s\S]*pg_advisory_xact_lock[\s\S]*first_effective_inspection_assignment_conflict/)
assert.match(migration, /unnest\(ARRAY\[old_task_id, new_task_id\]\)[\s\S]*ORDER BY candidate\.task_id/)
assert.match(migration, /IF FOUND AND latest_is_closed THEN CONTINUE; END IF;/)
assert.doesNotMatch(migration, /IF NOT FOUND OR latest_is_closed THEN CONTINUE/)
assert.match(migration, /LOCK TABLE cleaning_tasks, orders, work_task_events IN SHARE ROW EXCLUSIVE MODE/)
assert.ok(
  migration.indexOf('LOCK TABLE cleaning_tasks, orders, work_task_events IN SHARE ROW EXCLUSIVE MODE')
    < migration.indexOf('existing_inspection_assignment_property_date_conflict'),
  'migration must block task, order, and management-event writers before the existing-conflict preflight',
)
assert.match(migration, /COMMIT;\s*$/)
assert.match(taskCenter, /set_config\('mz\.inspection_management_closed_task_ids', \$2, true\)/)
assert.match(taskCenter, /set_config\('mz\.inspection_management_reopened_task_ids', \$3, true\)/)
assert.deepStrictEqual(buildMz031CleaningArrangementRevision(
  { task_date: '2026-10-05', property_id: 'property-old', inspector_id: 'flora', inspection_mode: 'same_day' },
  { task_date: '2026-10-05', property_id: 'property-new', inspector_id: 'flora', inspection_mode: 'same_day' },
)?.reasons, ['property_changed'])

assert.deepStrictEqual(inspectionAssignmentConflictPayload({
  constraint: 'inspection_assignment_property_date_conflict',
  detail: 'property_id=property-1 service_date=2026-10-05 existing_inspector_id=flora requested_inspector_id=other',
}), {
  message: '同一房源同一检查日期只能有一位有效检查人员：property-1 · 2026-10-05',
  code: 'inspection_assignment_property_date_conflict',
  property_id: 'property-1',
  service_date: '2026-10-05',
  existing_inspector_id: 'flora',
  requested_inspector_id: 'other',
})

const profile = (userId: string, gst: 'registered' | 'not_registered' | 'unconfirmed' = 'not_registered') => ({
  id: `profile-${userId}`, user_id: userId, user_name: userId, effective_from: '2026-01-01', effective_to: null,
  person_type: 'inspector', supplier_legal_name: userId, supplier_business_name: null, abn: null,
  gst_status: gst, payment_method: 'bank_transfer', invoice_document_type: 'invoice', currency: 'AUD',
})
const rule = (userId: string) => ({
  rule_id: `rule-${userId}`, user_id: userId, rule_name: 'Inspection day', effective_from: '2026-01-01', effective_to: null,
  price_basis: 'inclusive_gst', currency: 'AUD', item_id: `item-${userId}`, component_type: 'inspection_day',
  property_id: null, task_type: null, conditions: null, priority: 0, rate_cents: '15000',
})
const assignment = (patch: Record<string, unknown> = {}) => ({
  task_id: 'inspection-1', inspection_key: 'inspection:inspection-1', user_id: 'flora', user_name: 'Flora',
  service_date: '2026-10-05', scheduled_service_date: '2026-10-05', property_id: 'property-1', property_label: '831606',
  property_type: '一房一卫', task_type: 'checkout_clean', inspection_due_date: null, inspection_mode: 'same_day',
  assignment_source: 'current', inspection_scope_state: 'billable', inspection_scope_issue: null,
  property_snapshot_missing: false, is_payable: true, submission_count: 0, latest_audit_id: null,
  latest_performed_at: null, latest_metadata: null,
  ...patch,
})

async function previewOf(input: {
  assignments: any[]
  profiles?: any[]
  rules?: any[]
  audits?: any[]
  carryAdjustments?: any[]
  weekStart?: string
  userIds?: string[]
}) {
  const executor = {
    async query(sql: string) {
      if (sql.includes('FROM personnel_settlement_profiles')) return { rows: input.profiles ?? [profile('flora')] }
      if (sql.includes('FROM personnel_fee_rules')) return { rows: input.rules ?? [rule('flora')] }
      if (sql.includes('WITH current_inspection_assignments AS')) {
        assert.match(sql, /FROM effective_inspection_assignments requested/)
        assert.match(sql, /requested\.property_id = effective\.property_id/)
        assert.doesNotMatch(sql, /arrangement_revision,before,task_type/)
        assert.match(sql, /t\.inspector_id::text AS user_id/)
        assert.doesNotMatch(sql, /arrangement_revision,before,assignee_id/)
        assert.doesNotMatch(sql, /COALESCE\([^\n]*inspector_id[^\n]*assignee_id/)
        assert.match(sql, /arrangement_revision,before,property_id/)
        assert.match(sql, /FROM cleaning_sync_logs log/)
        assert.match(sql, /property_snapshot_missing/)
        assert.match(sql, /inspection_scope_state/)
        assert.match(sql, /IN \('checkout_clean', 'checkout_cleaning', 'checkin_clean'\)/)
        assert.match(sql, /inspection_scope_invalid_for_task/)
        assert.doesNotMatch(sql, /inspection_scope_missing_for_checkin/)
        assert.doesNotMatch(sql, /created_at\s*[<>]=?\s*['\"]2026-09-02/)
        return { rows: input.assignments }
      }
      if (sql.includes('FROM personnel_settlement_carry_adjustments')) return { rows: input.carryAdjustments ?? [] }
      if (sql.includes('FROM work_task_action_audits a') && sql.includes('JOIN cleaning_tasks t')) return { rows: input.audits ?? [] }
      if (sql.includes('FROM personnel_workload_claims')) return { rows: [] }
      if (sql.includes('WITH payment_candidates AS')) return { rows: [] }
      if (sql.includes('FROM cleaning_tasks t')) return { rows: [] }
      throw new Error(`unexpected query: ${sql.slice(0, 80)}`)
    },
  }
  return buildPersonnelSettlementPreview({
    week_start: input.weekStart || '2026-10-05',
    ...(input.userIds ? { user_ids: input.userIds } : {}),
  }, executor)
}

async function main() {
  const weakNetwork = await previewOf({
    assignments: [
      assignment(),
      assignment({ task_id: 'inspection-2', inspection_key: 'inspection:inspection-2', property_id: 'property-2', property_label: 'FO1602' }),
    ],
  })
  const flora = weakNetwork.people.find((person) => person.user_id === 'flora')!
  const day = flora.lines.find((line) => line.component_type === 'inspection_day')!
  assert.strictEqual(day.total_cents, 15000, 'one valid room is enough for the configured daily rate')
  assert.strictEqual(day.work_items.length, 2, 'rooms are display detail, not a pay threshold')
  assert.ok(day.work_items.every((item) => item.audit_id == null && item.status === 'payable'))
  assert.strictEqual(flora.warnings.length, 0, 'missing uploads do not block effective assignments')
  const submission = buildPersonnelSettlementSubmissionSnapshot({ weekStart: '2026-10-05', weekEnd: '2026-10-11', person: flora })
  assert.strictEqual(submission.lines[0].calculation_snapshot.executed_task_count, 2)
  assert.deepStrictEqual(submission.lines[0].calculation_snapshot.work_items.map((item: any) => item.property_label), ['831606', 'FO1602'])
  const financeReviewSnapshot = buildPersonnelSettlementSubmissionSnapshot({
    weekStart: '2026-10-05',
    weekEnd: '2026-10-11',
    person: {
      ...flora,
      lines: submission.lines.map(hydrateStoredPersonnelSettlementLineForSubmission),
    },
  })
  assert.strictEqual(
    financeReviewSnapshot.confirmation_token,
    submission.confirmation_token,
    'an unchanged stored inspection-day snapshot must not look edited during finance review',
  )

  const expected = await previewOf({ assignments: [assignment({ is_payable: false })] })
  assert.strictEqual(expected.people[0].lines.length, 0)
  assert.strictEqual(expected.people[0].work_checklist[0].status, 'expected')

  const idempotent = await previewOf({ assignments: [assignment(), assignment()] })
  assert.strictEqual(idempotent.people[0].lines.length, 1)
  assert.strictEqual(idempotent.people[0].lines[0].work_items.length, 1)

  const sameInspectorSameRoom = await previewOf({ assignments: [
    assignment(),
    assignment({ task_id: 'inspection-2', inspection_key: 'inspection:inspection-2' }),
  ] })
  assert.strictEqual(sameInspectorSameRoom.people[0].lines[0].work_items.length, 2)
  assert.match(sameInspectorSameRoom.people[0].lines[0].description, /1 property\(ies\) · 2 task\(s\)/)

  const pairedExecutorOnlyCheckin = await previewOf({
    assignments: [
      assignment({ user_id: 'mia', user_name: 'Mia' }),
      assignment({
        task_id: 'checkin-1',
        inspection_key: 'inspection:checkin-1',
        task_type: 'checkin_clean',
        user_id: null,
        user_name: null,
        inspection_scope_state: 'billable',
      }),
    ],
    profiles: [profile('mia'), profile('elise')],
    rules: [rule('mia'), rule('elise')],
  })
  assert.strictEqual(pairedExecutorOnlyCheckin.people.find((person) => person.user_id === 'mia')?.lines.length, 1)
  assert.strictEqual(pairedExecutorOnlyCheckin.people.find((person) => person.user_id === 'mia')?.lines[0].work_items.length, 1)
  assert.strictEqual(pairedExecutorOnlyCheckin.people.find((person) => person.user_id === 'elise')?.lines.length, 0)
  assert.strictEqual(pairedExecutorOnlyCheckin.manual_review.warnings.length, 0)

  const pairedSameInspector = await previewOf({
    assignments: [
      assignment({ user_id: 'mia', user_name: 'Mia' }),
      assignment({
        task_id: 'checkin-same-inspector',
        inspection_key: 'inspection:checkin-same-inspector',
        task_type: 'checkin_clean',
        user_id: 'mia',
        user_name: 'Mia',
        inspection_scope_state: 'legacy_default',
      }),
    ],
    profiles: [profile('mia')],
    rules: [rule('mia')],
  })
  assert.deepStrictEqual(
    pairedSameInspector.people.find((person) => person.user_id === 'mia')?.lines[0].work_items.map((item) => item.task_id),
    ['inspection-1'],
    'a same-inspector companion check-in must not inflate the room task count',
  )

  const pairedDifferentInspectors = await previewOf({
    assignments: [
      assignment({ user_id: 'mia', user_name: 'Mia' }),
      assignment({
        task_id: 'checkin-different-inspector',
        inspection_key: 'inspection:checkin-different-inspector',
        task_type: 'checkin_clean',
        user_id: 'elise',
        user_name: 'Elise',
        inspection_scope_state: 'legacy_default',
      }),
    ],
    profiles: [profile('mia'), profile('elise')],
    rules: [rule('mia'), rule('elise')],
  })
  assert.strictEqual(pairedDifferentInspectors.people.flatMap((person) => person.lines).length, 0)
  assert.strictEqual(
    pairedDifferentInspectors.manual_review.warnings.filter(
      (warning) => warning.reason === 'inspection_assignment_conflict_for_property_date',
    ).length,
    2,
    'a different check-in inspector must remain a visible conflict',
  )

  const deferredDifferentServiceDate = await previewOf({
    assignments: [
      assignment({ user_id: 'mia', user_name: 'Mia' }),
      assignment({
        task_id: 'checkin-deferred-next-day',
        inspection_key: 'inspection:checkin-deferred-next-day',
        task_type: 'checkin_clean',
        user_id: 'mia',
        user_name: 'Mia',
        service_date: '2026-10-06',
        inspection_mode: 'deferred',
        inspection_due_date: '2026-10-06',
        inspection_scope_state: 'legacy_default',
      }),
    ],
    profiles: [profile('mia')],
    rules: [rule('mia')],
  })
  assert.deepStrictEqual(
    deferredDifferentServiceDate.people.find((person) => person.user_id === 'mia')?.lines.map((line) => ({
      date: line.service_date,
      tasks: line.work_items.map((item) => item.task_id),
    })),
    [
      { date: '2026-10-05', tasks: ['inspection-1'] },
      { date: '2026-10-06', tasks: ['checkin-deferred-next-day'] },
    ],
    'different effective service dates must never be paired or suppressed',
  )

  const explicitInspectorInvalidScope = await previewOf({
    assignments: [assignment({
      task_id: 'invalid-scope',
      inspection_key: 'inspection:invalid-scope',
      inspection_scope_state: 'requires_review',
      inspection_scope_issue: 'inspection_scope_invalid_for_task',
    })],
  })
  assert.strictEqual(explicitInspectorInvalidScope.people[0].lines.length, 0)
  assert.strictEqual(explicitInspectorInvalidScope.people[0].work_checklist[0].included_in_amount, false)
  assert.strictEqual(explicitInspectorInvalidScope.people[0].warnings[0].reason, 'inspection_scope_invalid_for_task')

  const historicalDefault = await previewOf({
    assignments: [assignment({ inspection_scope_state: 'legacy_default' })],
  })
  assert.strictEqual(historicalDefault.people[0].lines.length, 1, 'a classified NULL legacy default remains billable')

  const unassignedStandalone = await previewOf({
    assignments: [assignment({ user_id: null, user_name: null })],
  })
  assert.strictEqual(unassignedStandalone.people.flatMap((person) => person.lines).length, 0)
  assert.strictEqual(unassignedStandalone.source_summary.unassigned_inspection_assignments, 1)
  assert.deepStrictEqual(unassignedStandalone.manual_review.warnings.map((warning) => ({
    user_id: warning.user_id,
    reason: warning.reason,
    included: warning.work_items?.[0]?.included_in_amount,
  })), [{ user_id: '', reason: 'inspection_inspector_missing', included: false }])

  const conflict = await previewOf({
    assignments: [
      assignment(),
      assignment({ task_id: 'inspection-2', inspection_key: 'inspection:inspection-2', user_id: 'other', user_name: 'Other' }),
    ],
    profiles: [profile('flora'), profile('other')],
    rules: [rule('flora'), rule('other')],
    userIds: ['flora'],
  })
  assert.strictEqual(conflict.people.flatMap((person) => person.lines).length, 0)
  assert.strictEqual(conflict.manual_review.warnings.length, 1)
  assert.ok(conflict.manual_review.warnings.every((warning) => (
    warning.reason === 'inspection_assignment_conflict_for_property_date'
    && warning.property_label === '831606'
    && warning.service_date === '2026-10-05'
  )))

  const staleOldUpload = await previewOf({
    assignments: [assignment({ user_id: 'other', user_name: 'Other' })],
    profiles: [profile('flora'), profile('other')],
    rules: [rule('flora'), rule('other')],
    audits: [{
      audit_id: 'late-offline-upload', task_id: 'inspection-1', user_id: 'flora', performed_by_name: 'Flora',
      action: 'submit_inspection', performed_at: '2026-10-07T01:00:00Z', service_date: '2026-10-05',
      status_after: 'inspected', property_id: 'property-1', property_label: '831606', property_type: '一房一卫',
      task_type: 'checkout_clean', task_status: 'inspected', metadata: { inspection_submission_complete: true },
    }],
  })
  assert.strictEqual(staleOldUpload.people.find((person) => person.user_id === 'flora')?.lines.length || 0, 0)
  assert.strictEqual(staleOldUpload.people.find((person) => person.user_id === 'other')?.lines.length, 1)

  const movedOldWeek = await previewOf({ assignments: [] })
  const movedNewWeek = await previewOf({
    weekStart: '2026-10-12',
    assignments: [assignment({ service_date: '2026-10-12', scheduled_service_date: '2026-10-12' })],
  })
  assert.strictEqual(movedOldWeek.people.flatMap((person) => person.lines).length, 0)
  assert.strictEqual(movedNewWeek.people.flatMap((person) => person.lines).length, 1)

  const unverifiableHistoricalProperty = await previewOf({
    assignments: [assignment({
      property_id: null,
      property_label: null,
      assignment_source: 'preserved_auto_change',
      property_snapshot_missing: true,
    })],
  })
  assert.strictEqual(unverifiableHistoricalProperty.people[0].lines.length, 0)
  assert.strictEqual(unverifiableHistoricalProperty.people[0].warnings[0].reason, 'historical_property_snapshot_missing')

  const missingCurrentProperty = await previewOf({
    assignments: [assignment({ property_id: null, property_label: null, property_snapshot_missing: true })],
  })
  assert.strictEqual(missingCurrentProperty.people[0].lines.length, 0)
  assert.strictEqual(missingCurrentProperty.people[0].warnings[0].reason, 'inspection_property_missing')

  const missingRate = await previewOf({ assignments: [assignment()], rules: [] })
  assert.deepStrictEqual(missingRate.people[0].warnings[0] && {
    reason: missingRate.people[0].warnings[0].reason,
    service_date: missingRate.people[0].warnings[0].service_date,
    property_label: missingRate.people[0].warnings[0].property_label,
    task_id: missingRate.people[0].warnings[0].task_id,
  }, { reason: 'missing_effective_rule', service_date: '2026-10-05', property_label: '831606', task_id: 'inspection-1' })

  const unconfirmedGst = await previewOf({ assignments: [assignment()], profiles: [profile('flora', 'unconfirmed')] })
  assert.strictEqual(unconfirmedGst.people[0].warnings[0].reason, 'gst_status_unconfirmed')

  const carryBase = {
    id: 'carry-1', source_settlement_id: 'paid-week', source_adjustment_id: 'adjustment-1', user_id: 'flora',
    source_week_start: '2026-10-05', source_week_end: '2026-10-11',
    target_week_start: '2026-10-12', target_week_end: '2026-10-18',
    recorded_subtotal_difference_cents: 2000, recorded_gst_difference_cents: 200,
    recorded_total_difference_cents: 2200,
    previously_applied_subtotal_cents: 0, previously_applied_gst_cents: 0,
    previously_applied_total_cents: 0,
    applied_subtotal_cents: 2000, applied_gst_cents: 200, applied_total_cents: 2200,
    reason: '付款后修正', applied_by: 'finance-1', applied_at: '2026-10-13T00:00:00.000Z',
  }
  const supplement = await previewOf({
    weekStart: '2026-10-12',
    assignments: [assignment({ service_date: '2026-10-12', scheduled_service_date: '2026-10-12' })],
    profiles: [profile('flora', 'registered')],
    carryAdjustments: [carryBase],
  })
  const supplementLine = supplement.people[0].lines.find((line) => line.component_type === 'post_payment_adjustment')!
  assert.strictEqual(supplementLine.subtotal_cents, 2000)
  assert.strictEqual(supplementLine.gst_cents, 200)
  assert.strictEqual(supplementLine.total_cents, 2200)
  assert.strictEqual(supplementLine.carry_adjustment?.source_settlement_id, 'paid-week')
  assert.strictEqual(supplement.people[0].totals.total_cents, 17200)
  const supplementSubmission = buildPersonnelSettlementSubmissionSnapshot({
    weekStart: '2026-10-12',
    weekEnd: '2026-10-18',
    person: supplement.people[0],
  })
  const supplementSubmissionLine = supplementSubmission.lines.find(
    (line) => line.component_type === 'post_payment_adjustment',
  )!
  assert.deepStrictEqual(supplementSubmissionLine.calculation_snapshot?.carry_adjustment && {
    source_settlement_id: supplementSubmissionLine.calculation_snapshot.carry_adjustment.source_settlement_id,
    source_week_start: supplementSubmissionLine.calculation_snapshot.carry_adjustment.source_week_start,
    source_week_end: supplementSubmissionLine.calculation_snapshot.carry_adjustment.source_week_end,
  }, {
    source_settlement_id: 'paid-week',
    source_week_start: '2026-10-05',
    source_week_end: '2026-10-11',
  })
  const frozenCarrySubmission = buildPersonnelSettlementSubmissionSnapshot({
    weekStart: '2026-10-12',
    weekEnd: '2026-10-18',
    person: {
      ...supplement.people[0],
      lines: [hydrateStoredPersonnelSettlementLineForSubmission({
        ...supplementLine,
        carry_adjustment: undefined,
        calculation_snapshot: supplementSubmissionLine.calculation_snapshot,
      })],
    },
  })
  assert.strictEqual(
    frozenCarrySubmission.lines[0].calculation_snapshot?.carry_adjustment?.source_week_start,
    '2026-10-05',
  )

  const nonRegisteredCarry = await previewOf({
    weekStart: '2026-10-12',
    assignments: [assignment({ service_date: '2026-10-12', scheduled_service_date: '2026-10-12' })],
    profiles: [profile('flora', 'not_registered')],
    carryAdjustments: [carryBase],
  })
  assert.strictEqual(
    nonRegisteredCarry.people[0].lines.some((line) => line.component_type === 'post_payment_adjustment'),
    false,
  )
  assert.strictEqual(
    nonRegisteredCarry.people[0].warnings.find((warning) => warning.source_id === 'carry-1')?.reason,
    'post_payment_adjustment_tax_treatment_requires_decision',
  )

  const offset = await previewOf({
    weekStart: '2026-10-12',
    assignments: [assignment({ service_date: '2026-10-12', scheduled_service_date: '2026-10-12' })],
    profiles: [profile('flora', 'registered')],
    carryAdjustments: [{
      ...carryBase,
      recorded_subtotal_difference_cents: -4545, recorded_gst_difference_cents: -455,
      recorded_total_difference_cents: -5000,
      applied_subtotal_cents: -4545, applied_gst_cents: -455, applied_total_cents: -5000,
    }],
  })
  assert.strictEqual(offset.people[0].totals.total_cents, 10000)
  assert.strictEqual(offset.people[0].totals.gst_cents, 909)
  assert.strictEqual(offset.people[0].warnings.length, 0)

  const taxStatusReclassification = await previewOf({
    weekStart: '2026-10-12',
    assignments: [assignment({ service_date: '2026-10-12', scheduled_service_date: '2026-10-12' })],
    profiles: [profile('flora', 'registered')],
    carryAdjustments: [{
      ...carryBase,
      recorded_subtotal_difference_cents: 1000, recorded_gst_difference_cents: -1000,
      recorded_total_difference_cents: 0,
      applied_subtotal_cents: 1000, applied_gst_cents: -1000, applied_total_cents: 0,
    }],
  })
  const reclassificationLine = taxStatusReclassification.people[0].lines.find(
    (line) => line.component_type === 'post_payment_adjustment',
  )!
  assert.deepStrictEqual({
    subtotal_cents: reclassificationLine.subtotal_cents,
    gst_cents: reclassificationLine.gst_cents,
    total_cents: reclassificationLine.total_cents,
  }, { subtotal_cents: 1000, gst_cents: -1000, total_cents: 0 })
  assert.strictEqual(taxStatusReclassification.people[0].totals.total_cents, 15000)
  assert.strictEqual(taxStatusReclassification.people[0].warnings.length, 0)

  const excessiveOffset = await previewOf({
    weekStart: '2026-10-12',
    assignments: [assignment({ service_date: '2026-10-12', scheduled_service_date: '2026-10-12' })],
    profiles: [profile('flora', 'registered')],
    carryAdjustments: [{
      ...carryBase,
      recorded_subtotal_difference_cents: -18182, recorded_gst_difference_cents: -1818,
      recorded_total_difference_cents: -20000,
      applied_subtotal_cents: -18182, applied_gst_cents: -1818, applied_total_cents: -20000,
    }],
  })
  assert.strictEqual(excessiveOffset.people[0].warnings[0].reason, 'post_payment_adjustment_exceeds_target_total')

  console.log('personnel settlement MZ-034 contract tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
