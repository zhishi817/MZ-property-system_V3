import assert from 'assert'
import fs from 'fs'
import path from 'path'
import {
  deferredInspectionCheckinConflictEventId,
  findDeferredInspectionCheckinReplacements,
  findDeferredInspectionCheckinConflicts,
  isDeferredInspectionCheckinConflictRelevantChange,
} from '../../src/services/deferredInspectionCheckinConflict'
import { getAppNotificationPolicyCatalogMeta } from '../../src/services/appNotificationPolicies'
import { buildMz031CleaningArrangementRevision } from '../../src/services/workTaskEvents'

function run() {
  const source = fs.readFileSync(path.resolve(__dirname, '../../src/services/deferredInspectionCheckinConflict.ts'), 'utf8')
  const inspectionAuditQuery = source.slice(source.indexOf('SELECT MIN(a.performed_at)'), source.indexOf('AS inspection_completed_at'))
  assert.doesNotMatch(inspectionAuditQuery, /item_count/)
  assert.match(inspectionAuditQuery, /<> 'mzapp\.cleaning_tasks\.restock_proof'/)
  assert.match(inspectionAuditQuery, /cleaning_app\.tasks\.inspection_photos/)
  assert.match(inspectionAuditQuery, /mzapp\.cleaning_tasks\.inspection_photos/)
  assert.strictEqual(buildMz031CleaningArrangementRevision(
    { task_date: '2026-08-01', cleaner_id: 'cleaner-1', status: 'assigned' },
    { task_date: '2026-08-01', cleaner_id: 'cleaner-1', status: 'completed' },
  ), null, 'management close is not an arrangement revision')
  assert.deepStrictEqual(buildMz031CleaningArrangementRevision(
    { task_date: '2026-08-01', cleaner_id: 'cleaner-1', status: 'assigned' },
    { task_date: '2026-08-03', cleaner_id: 'cleaner-2', status: 'assigned' },
  )?.reasons, ['scheduled_service_date_changed', 'assignment_changed'])
  assert.deepStrictEqual(buildMz031CleaningArrangementRevision(
    { task_date: '2026-08-01', cleaner_id: 'cleaner-1', inspection_mode: 'deferred', inspection_due_date: '2026-08-02' },
    { task_date: '2026-08-01', cleaner_id: 'cleaner-1', inspection_mode: 'deferred', inspection_due_date: '2026-08-04' },
  )?.reasons, ['inspection_plan_changed'])
  assert.deepStrictEqual(buildMz031CleaningArrangementRevision(
    { task_date: '2026-08-01', inspector_id: 'inspector-1', inspection_mode: 'deferred', inspection_due_date: '2026-08-02' },
    { task_date: '2026-08-01', inspector_id: 'inspector-1', inspection_mode: 'checked_done', inspection_due_date: null },
    ['deferred_replaced_by_completed_checkin'],
  )?.reasons, ['inspection_plan_changed', 'deferred_replaced_by_completed_checkin'])
  assert.match(source, /buildMz031CleaningArrangementRevision\(params\.before, params\.after, \[explicitReason\]\)/)
  assert.match(source, /payload: arrangementRevision \? \{ arrangement_revision: arrangementRevision \} : undefined/)
  const conflicts = findDeferredInspectionCheckinConflicts([
    {
      id: 'deferred-a',
      property_id: 'property-a',
      task_type: 'checkout_clean',
      task_date: '2026-08-03',
      inspection_mode: 'deferred',
      inspection_due_date: '2026-08-05',
      status: 'assigned',
      execution_state: 'active',
    },
    {
      id: 'checkin-a',
      property_id: 'property-a',
      task_type: 'checkin_clean',
      task_date: '2026-08-04',
      inspection_scope: 'inspect_and_hang',
      checkin_time: '15:00',
      status: 'assigned',
      execution_state: 'active',
    },
    {
      id: 'checkin-same-day',
      property_id: 'property-a',
      task_type: 'checkin_clean',
      task_date: '2026-08-05',
      inspection_scope: 'inspect_and_hang',
      inspection_completed_at: '2026-08-01T05:00:00.000Z',
      status: 'pending',
      execution_state: 'active',
    },
    {
      id: 'checkin-later',
      property_id: 'property-a',
      task_type: 'checkin_clean',
      task_date: '2026-08-06',
      inspection_scope: 'inspect_and_hang',
      status: 'pending',
      execution_state: 'active',
    },
    {
      id: 'checkin-other-property',
      property_id: 'property-b',
      task_type: 'checkin_clean',
      task_date: '2026-08-04',
      inspection_scope: 'inspect_and_hang',
      status: 'pending',
      execution_state: 'active',
    },
  ])

  assert.deepStrictEqual(conflicts.map((conflict) => conflict.checkin_task_id), ['checkin-a', 'checkin-same-day'])
  assert.strictEqual(conflicts[0].checkin_time, '15:00')
  assert.ok(deferredInspectionCheckinConflictEventId(conflicts[0]).includes('deferred-a:checkin-a:2026-08-05:2026-08-04:15:00'))

  const replacements = findDeferredInspectionCheckinReplacements([
    {
      id: 'deferred-replace',
      property_id: 'property-a',
      task_type: 'checkout_clean',
      task_date: '2026-08-01',
      inspection_mode: 'deferred',
      inspection_due_date: '2026-08-02',
      status: 'pending',
      execution_state: 'active',
    },
    {
      id: 'checkin-same-day-replace',
      property_id: 'property-a',
      task_type: 'checkin_clean',
      task_date: '2026-08-01',
      inspection_scope: 'inspect_and_hang',
      inspection_completed_at: '2026-08-01T05:00:00.000Z',
      status: 'pending',
      execution_state: 'active',
    },
    {
      id: 'checkin-before-checkout',
      property_id: 'property-a',
      task_type: 'checkin_clean',
      task_date: '2026-07-31',
      inspection_scope: 'inspect_and_hang',
      status: 'pending',
      execution_state: 'active',
    },
  ])
  assert.deepStrictEqual(replacements.map((replacement) => ({
    deferred: replacement.deferred_task_id,
    checkin: replacement.checkin_task_id,
    deferredDate: replacement.deferred_task_date,
    dueDate: replacement.inspection_due_date,
  })), [{
    deferred: 'deferred-replace',
    checkin: 'checkin-same-day-replace',
    deferredDate: '2026-08-01',
    dueDate: '2026-08-02',
  }])

  const notYetInspected = findDeferredInspectionCheckinReplacements([
    {
      id: 'deferred-awaiting-checkin-inspection',
      property_id: 'property-a',
      task_type: 'checkout_clean',
      task_date: '2026-08-01',
      inspection_mode: 'deferred',
      inspection_due_date: '2026-08-02',
      status: 'pending',
    },
    {
      id: 'checkin-created-only',
      property_id: 'property-a',
      task_type: 'checkin_clean',
      task_date: '2026-08-02',
      inspection_scope: 'inspect_and_hang',
      status: 'assigned',
    },
  ])
  assert.deepStrictEqual(notYetInspected, [], 'a check-in assignment is not proof that inspection work finished')

  const passwordOnlyReplacements = findDeferredInspectionCheckinReplacements([
    {
      id: 'deferred-password-only',
      property_id: 'property-a',
      task_type: 'checkout_clean',
      task_date: '2026-08-01',
      inspection_mode: 'deferred',
      inspection_due_date: '2026-08-02',
      status: 'pending',
    },
    {
      id: 'password-only-checkin',
      property_id: 'property-a',
      task_type: 'checkin_clean',
      task_date: '2026-08-02',
      inspection_scope: 'password_only',
      status: 'pending',
    },
  ])
  assert.deepStrictEqual(passwordOnlyReplacements, [])

  const resolvedConflict = findDeferredInspectionCheckinConflicts([
    {
      id: 'deferred-done',
      property_id: 'property-a',
      task_date: '2026-08-03',
      inspection_mode: 'deferred',
      inspection_due_date: '2026-08-05',
      status: 'completed',
    },
    {
      id: 'checkin-active',
      property_id: 'property-a',
      task_type: 'checkin_clean',
      task_date: '2026-08-04',
      status: 'pending',
    },
  ])
  assert.deepStrictEqual(resolvedConflict, [])

  assert.strictEqual(isDeferredInspectionCheckinConflictRelevantChange(['inspector_id']), false)
  assert.strictEqual(isDeferredInspectionCheckinConflictRelevantChange(['inspection_due_date']), true)
  assert.strictEqual(isDeferredInspectionCheckinConflictRelevantChange(['inspection_scope']), true)
  assert.strictEqual(isDeferredInspectionCheckinConflictRelevantChange(['task_date']), true)

  const policy = getAppNotificationPolicyCatalogMeta('deferred_inspection_checkin_conflict')
  assert.strictEqual(policy.default_template_key, 'ops_manager_only')
  assert.deepStrictEqual(policy.source_event_types, ['CLEANING_TASK_UPDATED'])

  console.log('ok')
}

run()
