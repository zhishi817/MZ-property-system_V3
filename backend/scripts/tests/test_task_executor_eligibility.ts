import assert from 'assert'
import { assignedTaskExecutorIds, isTaskExecutorEligibleRoleNames } from '../../src/services/taskExecutorEligibility'

assert.equal(isTaskExecutorEligibleRoleNames(['admin']), true)
assert.equal(isTaskExecutorEligibleRoleNames(['offline_manager']), true)
assert.equal(isTaskExecutorEligibleRoleNames(['maintenance_staff']), true)
assert.equal(isTaskExecutorEligibleRoleNames(['inventory_manager']), true)
assert.equal(isTaskExecutorEligibleRoleNames(['cleaner_inspector']), true)
assert.equal(isTaskExecutorEligibleRoleNames(['customer_service']), false)
assert.equal(isTaskExecutorEligibleRoleNames(['finance_staff']), false)
assert.equal(isTaskExecutorEligibleRoleNames(['admin', 'finance_staff']), false)
assert.equal(isTaskExecutorEligibleRoleNames([]), false)
assert.deepEqual(assignedTaskExecutorIds({
  cleaningAssignments: [{ cleaner_assignment_action: 'assign', cleaner_id: 'cleaner' }, { inspector_assignment_action: 'assign', inspector_id: 'inspector' }],
  workAssignments: [{ assignee_assignment_action: 'assign', assignee_id: 'executor' }],
}), ['cleaner', 'inspector', 'executor'])
process.stdout.write('test_task_executor_eligibility: ok\\n')
