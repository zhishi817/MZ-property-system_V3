import assert from 'node:assert/strict'
import { isTaskCenterPendingInspection } from '../../src/modules/task_center'

const baseTask = {
  task_source: 'cleaning' as const,
  task_kind: 'checkin_clean',
  task_ids: ['checkin-1'],
  title: 'Melbourne WSP5605B',
  status: 'assigned',
  temporarily_skipped: false,
  deferred_inspection_view: false,
  inspection_mode: 'same_day' as const,
  inspection_scope: 'inspect_and_hang' as const,
  assignee_id: 'mia',
  cleaner_id: null,
  inspector_id: null,
}

assert.equal(isTaskCenterPendingInspection(baseTask), false, 'a pure check-in executor assignment satisfies the inspection gate')
assert.equal(isTaskCenterPendingInspection({ ...baseTask, assignee_id: null }), true, 'an unassigned pure check-in remains pending')
assert.equal(isTaskCenterPendingInspection({
  ...baseTask,
  task_kind: 'checkout_clean',
  task_ids: ['checkout-1'],
  assignee_id: 'mia',
  inspector_id: null,
}), true, 'a normal cleaning task still requires inspector_id')
assert.equal(isTaskCenterPendingInspection({
  ...baseTask,
  task_kind: 'checkout_clean',
  task_ids: ['checkout-1'],
  assignee_id: null,
  inspector_id: 'oscar',
}), false, 'a normal cleaning task with an inspector is ready')
assert.equal(isTaskCenterPendingInspection({ ...baseTask, inspection_mode: 'pending_decision' }), true, 'pending decision remains pending regardless of an old executor assignment')

console.log('task center inspection readiness tests passed')
