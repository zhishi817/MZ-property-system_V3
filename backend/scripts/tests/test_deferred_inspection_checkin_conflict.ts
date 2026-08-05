import assert from 'assert'
import {
  deferredInspectionCheckinConflictEventId,
  findDeferredInspectionCheckinReplacements,
  findDeferredInspectionCheckinConflicts,
  isDeferredInspectionCheckinConflictRelevantChange,
} from '../../src/services/deferredInspectionCheckinConflict'
import { getAppNotificationPolicyCatalogMeta } from '../../src/services/appNotificationPolicies'

function run() {
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
