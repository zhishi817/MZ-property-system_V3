import assert from 'assert'
import { dailyTaskExecutionVisibility } from '../../src/lib/dailyTaskExecutionVisibility'
import { countDailyTaskGroups, projectDailyTaskStats } from '../../src/lib/dailyTaskExecutionStats'

function main() {
  const turnoverBase = {
    source_type: 'cleaning_tasks',
    task_type: 'turnover',
    scheduled_date: '2026-10-04',
    property_id: 'property-1',
  }
  assert.deepEqual(projectDailyTaskStats({ ...turnoverBase, id: 'cleaner-card', status: 'ready' }), {
    daily_stats_group: 'turnover',
    daily_stats_key: 'turnover:2026-10-04:property-1',
  })
  assert.equal(dailyTaskExecutionVisibility({ ...turnoverBase, status: 'assigned', assignee_id: null }).visible, true)
  assert.deepEqual(projectDailyTaskStats({ ...turnoverBase, status: 'cancelled' }), {
    daily_stats_group: null,
    daily_stats_key: null,
  })

  const maintenanceBase = {
    id: 'work-1',
    source_type: 'property_maintenance',
    source_id: 'maintenance-1',
    task_kind: 'maintenance',
    scheduled_date: '2026-10-04',
    assignee_id: 'worker-1',
  }
  assert.equal(dailyTaskExecutionVisibility({ ...maintenanceBase, status: 'assigned' }).visible, true)
  assert.equal(dailyTaskExecutionVisibility({ ...maintenanceBase, status: 'done' }).visible, false)
  assert.equal(dailyTaskExecutionVisibility({ ...maintenanceBase, source_workflow_status: 'closed', status: 'done' }).visible, false)
  assert.deepEqual(projectDailyTaskStats({ ...maintenanceBase, status: 'done' }), {
    daily_stats_group: null,
    daily_stats_key: null,
  }, 'MZ-021 maintenance completion aliases stay review-only and out of stats')
  assert.deepEqual(projectDailyTaskStats({ ...maintenanceBase, status: 'assigned' }), {
    daily_stats_group: null,
    daily_stats_key: null,
  }, 'property follow-up management candidates are not counted as offline execution tasks')

  const offlineBase = {
    id: 'offline-1',
    source_type: 'manual_work_task',
    source_id: 'offline-1',
    task_kind: 'offline',
    scheduled_date: '2026-10-04',
    assignee_id: 'worker-1',
  }
  assert.deepEqual(projectDailyTaskStats({
    ...offlineBase,
    id: 'offline-unassigned',
    source_id: 'offline-unassigned',
    assignee_id: null,
    status: 'todo',
  }), {
    daily_stats_group: null,
    daily_stats_key: null,
  }, 'Mobile execution statistics continue to hide an unassigned offline task')
  assert.deepEqual(projectDailyTaskStats({
    ...offlineBase,
    id: 'offline-unassigned',
    source_id: 'offline-unassigned',
    assignee_id: null,
    status: 'todo',
  }, { includeTaskCenterManagementOnlyOffline: true }), {
    daily_stats_group: 'offline',
    daily_stats_key: 'offline:2026-10-04:manual_work_task:offline-unassigned',
  }, 'Web assignment statistics include a scheduled active offline task before assignment')
  const deferredInspections = Array.from({ length: 6 }, (_, index) => ({
    id: `inspection-${index + 1}`,
    source_id: `inspection-${index + 1}`,
    source_type: 'cleaning_tasks',
    task_kind: 'deferred_inspection',
    scheduled_date: '2026-10-04',
    property_id: `inspection-property-${index + 1}`,
    inspector_id: 'inspector-1',
    status: 'assigned',
  }))
  assert.deepEqual(countDailyTaskGroups([
    { ...turnoverBase, id: 'cleaner-card', task_kind: 'cleaning', status: 'ready' },
    { ...turnoverBase, id: 'inspection-card', task_kind: 'inspection', status: 'assigned' },
    ...deferredInspections,
    { ...offlineBase, status: 'done' },
    {
      id: 'stayover-1',
      source_type: 'cleaning_tasks',
      source_id: 'stayover-1',
      task_kind: 'stayover_clean',
      scheduled_date: '2026-10-04',
      assignee_id: 'worker-1',
      status: 'assigned',
    },
    { ...offlineBase, id: 'offline-review', source_id: 'offline-review', status: 'pending_review' },
    { ...offlineBase, id: 'offline-unassigned', source_id: 'offline-unassigned', assignee_id: null, status: 'assigned' },
  ]), { turnover: 1, inspection: 6, offline: 2 })
}

main()
console.log('daily task execution stats tests passed')
