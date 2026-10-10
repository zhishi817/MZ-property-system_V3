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

  const offlineBase = {
    id: 'offline-1',
    source_type: 'manual_work_task',
    source_id: 'offline-1',
    task_kind: 'offline',
    scheduled_date: '2026-10-04',
    assignee_id: 'worker-1',
  }
  assert.deepEqual(countDailyTaskGroups([
    { ...turnoverBase, id: 'cleaner-card', task_kind: 'cleaning', status: 'ready' },
    { ...turnoverBase, id: 'inspection-card', task_kind: 'inspection', status: 'assigned' },
    { ...offlineBase, status: 'done' },
    { ...offlineBase, id: 'offline-review', source_id: 'offline-review', status: 'pending_review' },
    { ...offlineBase, id: 'offline-unassigned', source_id: 'offline-unassigned', assignee_id: null, status: 'assigned' },
  ]), { turnover: 1, offline: 1 })
}

main()
console.log('daily task execution stats tests passed')
