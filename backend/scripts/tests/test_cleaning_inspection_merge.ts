import assert from 'node:assert/strict'
import { mergeInspectionPlan } from '../../src/lib/cleaningInspection'

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

testTurnoverCheckoutAssignmentWinsOverPendingFallback()
testTurnoverPendingCheckoutDoesNotGetPromotedByCheckinDefault()
testDeferredCheckoutKeepsDeferredDate()
testStayoverRemainsSelfComplete()

console.log('test_cleaning_inspection_merge: ok')
