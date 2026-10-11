import assert from 'assert'
import {
  canonicalizePropertyFollowupAssignmentForSave,
  isActivePropertyFollowupSource,
  parsePropertyFollowupTaskId,
  propertyFollowupTaskId,
  resolvePropertyFollowupAssignment,
} from '../../src/lib/propertyFollowupPolicy'

function main() {
  for (const status of ['pending_review', 'review_pending', 'awaiting_review']) {
    assert.equal(isActivePropertyFollowupSource({ sourceType: 'property_maintenance', status }), false)
    assert.equal(isActivePropertyFollowupSource({ sourceType: 'property_deep_cleaning', status }), false)
    assert.equal(isActivePropertyFollowupSource({ sourceType: 'property_deep_cleaning', status: 'pending', reviewStatus: status }), false)
  }
  for (const status of ['closed', 'cancelled', 'canceled', 'completed', 'done', 'ready']) {
    assert.equal(isActivePropertyFollowupSource({ sourceType: 'property_maintenance', status }), false)
    assert.equal(isActivePropertyFollowupSource({ sourceType: 'property_deep_cleaning', status }), false)
  }
  assert.equal(isActivePropertyFollowupSource({ sourceType: 'property_maintenance', status: 'pending' }), true)
  assert.equal(isActivePropertyFollowupSource({ sourceType: 'property_deep_cleaning', status: 'assigned' }), true)
  assert.equal(isActivePropertyFollowupSource({ sourceType: 'property_daily_necessities', status: 'need_replace' }), true)
  assert.equal(isActivePropertyFollowupSource({ sourceType: 'property_daily_necessities', status: 'replaced' }), false)
  assert.equal(isActivePropertyFollowupSource({
    sourceType: 'property_daily_necessities',
    status: 'need_replace',
    deletedAt: '2026-10-11T00:00:00Z',
  }), false)
  assert.equal(isActivePropertyFollowupSource({
    sourceType: 'property_deep_cleaning',
    status: 'pending',
    deletedAt: '2026-10-11T00:00:00Z',
  }), false)

  const taskId = propertyFollowupTaskId('property_maintenance', 'maintenance-1')
  assert.equal(taskId, 'property_maintenance:maintenance-1')
  assert.deepEqual(parsePropertyFollowupTaskId(taskId), {
    sourceType: 'property_maintenance',
    sourceId: 'maintenance-1',
  })
  assert.equal(parsePropertyFollowupTaskId('manual_work_task:1'), null)

  assert.deepEqual(resolvePropertyFollowupAssignment({
    sourceType: 'property_deep_cleaning',
    sourceStatus: 'pending',
    workAssigneeId: 'cleaner-from-saved-work-task',
    workProjectionExists: true,
  }), {
    assigneeId: 'cleaner-from-saved-work-task',
    status: 'assigned',
  }, 'deep-cleaning assignment saved to work_tasks survives the next GET projection')
  assert.deepEqual(resolvePropertyFollowupAssignment({
    sourceType: 'property_deep_cleaning',
    sourceAssigneeId: 'cleaner-from-source',
    sourceStatus: 'assigned',
    workAssigneeId: 'stale-work-cleaner',
    workProjectionExists: true,
  }), {
    assigneeId: 'stale-work-cleaner',
    status: 'assigned',
  }, 'deep-cleaning Web projection is authoritative after materialization')
  assert.deepEqual(resolvePropertyFollowupAssignment({
    sourceType: 'property_deep_cleaning',
    sourceAssigneeId: 'cleaner-from-source',
    sourceStatus: 'assigned',
    workAssigneeId: null,
    workProjectionExists: true,
  }), {
    assigneeId: null,
    status: 'todo',
  }, 'deep-cleaning explicit Web unassign survives refresh despite a stale source assignee')
  assert.deepEqual(resolvePropertyFollowupAssignment({
    sourceType: 'property_deep_cleaning',
    sourceAssigneeId: 'cleaner-from-source',
    sourceStatus: 'assigned',
    workProjectionExists: false,
  }), {
    assigneeId: 'cleaner-from-source',
    status: 'assigned',
  }, 'deep-cleaning source assignment seeds the candidate before materialization')
  assert.deepEqual(resolvePropertyFollowupAssignment({
    sourceType: 'property_maintenance',
    sourceStatus: 'pending',
    workAssigneeId: 'stale-work-cleaner',
  }), {
    assigneeId: null,
    status: 'todo',
  }, 'maintenance remains source-owned and ignores a stale work projection')

  assert.deepEqual(canonicalizePropertyFollowupAssignmentForSave({
    task_id: 'property_maintenance:maintenance-1',
    title: '客户端展示标题',
    summary: '客户端展示摘要',
    urgency: 'urgent',
    assignee_id: 'worker-2',
  }, {
    source_type: 'property_maintenance',
    title: '服务端维修标题',
    summary: '服务端维修摘要',
    urgency: 'medium',
  }), {
    task_id: 'property_maintenance:maintenance-1',
    title: '服务端维修标题',
    summary: '服务端维修摘要',
    urgency: 'medium',
    assignee_id: 'worker-2',
  }, 'maintenance diff uses canonical server text while preserving the requested assignee')
}

main()
console.log('property follow-up policy tests passed')
