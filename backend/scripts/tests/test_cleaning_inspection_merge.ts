import assert from 'node:assert/strict'
import {
  deferredProjectionDate,
  isInspectionModeAllowedForTask,
  mergeInspectionPlan,
  mergeTurnoverTaskPlan,
  mobileInspectionProjectionDate,
  sanitizeInspectionModeForTask,
} from '../../src/lib/cleaningInspection'

function testTurnoverCheckoutAssignmentWinsOverPendingFallback() {
  const out = mergeInspectionPlan([
    {
      task_type: 'checkout_clean',
      inspection_mode: 'same_day',
      inspector_id: 'justin',
      status: 'assigned',
    },
    {
      task_type: 'checkin_clean',
      inspection_mode: 'same_day',
      inspector_id: null,
      status: 'assigned',
    },
  ])
  assert.equal(out.inspectionMode, 'same_day')
  assert.equal(out.inspectionDueDate, null)
}

function testTurnoverPendingCheckoutDoesNotGetPromotedByCheckinDefault() {
  const out = mergeInspectionPlan([
    {
      task_type: 'checkout_clean',
      inspection_mode: 'pending_decision',
      inspector_id: null,
      status: 'assigned',
    },
    {
      task_type: 'checkin_clean',
      inspection_mode: 'same_day',
      inspector_id: null,
      status: 'assigned',
    },
  ])
  assert.equal(out.inspectionMode, 'pending_decision')
  assert.equal(out.inspectionDueDate, null)
}

function testDeferredCheckoutKeepsDeferredDate() {
  const out = mergeInspectionPlan([
    {
      task_type: 'checkout_clean',
      inspection_mode: 'deferred',
      inspection_due_date: '2026-05-05',
      inspector_id: 'justin',
      status: 'assigned',
    },
    {
      task_type: 'checkin_clean',
      inspection_mode: 'same_day',
      inspector_id: null,
      status: 'assigned',
    },
  ])
  assert.equal(out.inspectionMode, 'deferred')
  assert.equal(out.inspectionDueDate, '2026-05-05')
}

function testStayoverRemainsSelfComplete() {
  const out = mergeInspectionPlan([
    {
      task_type: 'stayover_clean',
      inspection_mode: 'self_complete',
      inspector_id: null,
      status: 'assigned',
    },
  ])
  assert.equal(out.inspectionMode, 'self_complete')
  assert.equal(out.inspectionDueDate, null)
}

function testCheckedDoneBeatsSelfCompleteWhenMerged() {
  const out = mergeInspectionPlan([
    {
      task_type: 'checkout_clean',
      inspection_mode: 'self_complete',
      inspector_id: null,
      status: 'assigned',
    },
    {
      task_type: 'checkout_clean',
      inspection_mode: 'checked_done',
      inspector_id: null,
      status: 'assigned',
    },
  ])
  assert.equal(out.inspectionMode, 'checked_done')
  assert.equal(out.inspectionDueDate, null)
}

function testTemporaryCheckinDoesNotUnassignScheduledCheckout() {
  const out = mergeTurnoverTaskPlan([
    {
      task_type: 'checkout_clean',
      cleaner_id: 'cleaner-1',
      assignee_id: 'cleaner-1',
      inspector_id: null,
      inspection_mode: 'pending_decision',
      status: 'assigned',
    },
    {
      task_type: 'checkin_clean',
      cleaner_id: null,
      assignee_id: null,
      inspector_id: null,
      inspection_mode: 'same_day',
      status: 'pending',
    },
  ])
  assert.equal(out.cleanerId, 'cleaner-1')
  assert.equal(out.assigneeId, 'cleaner-1')
  assert.equal(out.status, 'assigned')
  assert.equal(out.inspectionMode, 'pending_decision')
  assert.equal(out.inspectorId, null)
}

function testTemporaryCheckinDoesNotClearCheckoutInspector() {
  const out = mergeTurnoverTaskPlan([
    {
      task_type: 'checkout_clean',
      cleaner_id: 'cleaner-1',
      assignee_id: 'cleaner-1',
      inspector_id: 'inspector-1',
      inspection_mode: 'same_day',
      status: 'assigned',
    },
    {
      task_type: 'checkin_clean',
      cleaner_id: null,
      assignee_id: null,
      inspector_id: null,
      inspection_mode: 'same_day',
      status: 'pending',
    },
  ])
  assert.equal(out.inspectorId, 'inspector-1')
  assert.equal(out.inspectionMode, 'same_day')
}

function testTurnoverKeepsKeysHungFromAnyUnderlyingTask() {
  const out = mergeTurnoverTaskPlan([
    {
      task_type: 'checkout_clean',
      cleaner_id: 'cleaner-1',
      assignee_id: 'cleaner-1',
      inspector_id: 'inspector-1',
      inspection_mode: 'same_day',
      status: 'assigned',
    },
    {
      task_type: 'checkin_clean',
      cleaner_id: null,
      assignee_id: null,
      inspector_id: 'inspector-1',
      inspection_mode: 'same_day',
      status: 'keys_hung',
    },
  ])
  assert.equal(out.status, 'keys_hung')
  assert.equal(out.cleanerId, 'cleaner-1')
  assert.equal(out.inspectorId, 'inspector-1')
}

function testCompletedDeferredInspectionStillProjectsToDueDate() {
  const out = deferredProjectionDate({
    inspectionMode: 'deferred',
    inspectionDueDate: '2026-06-21',
    dateFrom: '2026-06-21',
    dateTo: '2026-06-21',
    status: 'completed',
  })
  assert.equal(out, '2026-06-21')
}

function testKeysHungSelfCompleteProjectsToOriginalTaskDate() {
  const out = mobileInspectionProjectionDate({
    inspectionMode: 'self_complete',
    taskDate: '2026-06-22',
    dateFrom: '2026-06-22',
    dateTo: '2026-06-22',
    status: 'keys_hung',
  })
  assert.equal(out, '2026-06-22')
}

function testOrdinarySelfCompleteDoesNotCreateInspectorTask() {
  const out = mobileInspectionProjectionDate({
    inspectionMode: 'self_complete',
    taskDate: '2026-06-22',
    dateFrom: '2026-06-22',
    dateTo: '2026-06-22',
    status: 'completed',
  })
  assert.equal(out, null)
}

function testPasswordOnlyCannotUseSelfCompleteOrCheckedDone() {
  assert.equal(isInspectionModeAllowedForTask({
    taskType: 'checkin_clean',
    inspectionScope: 'password_only',
    inspectionMode: 'self_complete',
  }), false)
  assert.equal(isInspectionModeAllowedForTask({
    taskType: 'checkin_clean',
    inspectionScope: 'password_only',
    inspectionMode: 'checked_done',
  }), false)
  assert.equal(sanitizeInspectionModeForTask({
    taskType: 'checkin_clean',
    inspectionScope: 'password_only',
    inspectionMode: 'checked_done',
  }), 'same_day')
}

testTurnoverCheckoutAssignmentWinsOverPendingFallback()
testTurnoverPendingCheckoutDoesNotGetPromotedByCheckinDefault()
testDeferredCheckoutKeepsDeferredDate()
testStayoverRemainsSelfComplete()
testCheckedDoneBeatsSelfCompleteWhenMerged()
testTemporaryCheckinDoesNotUnassignScheduledCheckout()
testTemporaryCheckinDoesNotClearCheckoutInspector()
testTurnoverKeepsKeysHungFromAnyUnderlyingTask()
testCompletedDeferredInspectionStillProjectsToDueDate()
testKeysHungSelfCompleteProjectsToOriginalTaskDate()
testOrdinarySelfCompleteDoesNotCreateInspectorTask()
testPasswordOnlyCannotUseSelfCompleteOrCheckedDone()

console.log('test_cleaning_inspection_merge: ok')
