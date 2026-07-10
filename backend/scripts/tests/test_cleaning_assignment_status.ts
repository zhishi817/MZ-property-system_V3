import assert from 'assert'
import {
  assignedStatusFromAssignees,
  autoCleaningAssignmentStatus,
  isAutoAssignableCleaningStatus,
  isCheckinSiteExecutionTask,
} from '../../src/lib/cleaningAssignmentStatus'

function testGenericCleaningStatus() {
  assert.equal(autoCleaningAssignmentStatus({ task_type: 'checkout_clean', cleaner_id: 'cleaner-1' }), 'assigned')
  assert.equal(autoCleaningAssignmentStatus({ task_type: 'checkout_clean', assignee_id: 'cleaner-1' }), 'assigned')
  assert.equal(autoCleaningAssignmentStatus({ task_type: 'checkout_clean', inspector_id: 'inspector-1' }), 'assigned')
  assert.equal(autoCleaningAssignmentStatus({ task_type: 'checkout_clean' }), 'pending')
}

function testCheckinSiteExecutionStatus() {
  assert.equal(isCheckinSiteExecutionTask({ task_type: 'checkin_clean', inspection_scope: 'password_only' }), true)
  assert.equal(isCheckinSiteExecutionTask({ task_type: 'checkin_clean', inspection_scope: 'inspect_and_hang' }), true)
  assert.equal(isCheckinSiteExecutionTask({ task_type: 'checkout_clean', inspection_scope: 'password_only' }), false)
  assert.equal(autoCleaningAssignmentStatus({ task_type: 'checkin_clean', inspection_scope: 'password_only', assignee_id: 'executor-1' }), 'assigned')
  assert.equal(autoCleaningAssignmentStatus({ task_type: 'checkin_clean', inspection_scope: 'password_only', inspector_id: 'executor-1' }), 'assigned')
  assert.equal(autoCleaningAssignmentStatus({ task_type: 'checkin_clean', inspection_scope: 'password_only', cleaner_id: 'legacy-cleaner' }), 'pending')
}

function testAutoAssignableStatusBoundary() {
  for (const status of ['pending', 'assigned', 'todo', 'unassigned', '', null, undefined]) {
    assert.equal(isAutoAssignableCleaningStatus(status), true)
  }
  for (const status of ['in_progress', 'cleaned', 'restock_pending', 'restocked', 'inspected', 'keys_hung', 'ready', 'completed', 'done', 'cancelled', 'canceled']) {
    assert.equal(isAutoAssignableCleaningStatus(status), false)
  }
}

function testLegacyAssignedStatusHelper() {
  assert.equal(assignedStatusFromAssignees('user-1', null), 'assigned')
  assert.equal(assignedStatusFromAssignees(null, 'user-2'), 'assigned')
  assert.equal(assignedStatusFromAssignees(null, null), 'pending')
}

function main() {
  testGenericCleaningStatus()
  testCheckinSiteExecutionStatus()
  testAutoAssignableStatusBoundary()
  testLegacyAssignedStatusHelper()
  process.stdout.write('ok\n')
}

main()
