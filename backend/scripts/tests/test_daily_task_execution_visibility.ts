import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  DAILY_TASK_MANAGER_ROLES,
  dailyTaskExecutionVisibility,
  isDailyTaskManagerRoleNames,
  projectVisibleDailyTasks,
} from '../../src/lib/dailyTaskExecutionVisibility'

const scheduled = '2026-10-09'
const cases = [
  { id: 'maintenance-assigned', source_type: 'property_maintenance', status: 'assigned', source_workflow_status: 'assigned', scheduled_date: scheduled, assignee_id: 'staff-1' },
  { id: 'maintenance-progress', source_type: 'property_maintenance', status: 'in_progress', source_workflow_status: 'in_progress', scheduled_date: scheduled, assignee_id: 'staff-1' },
  { id: 'maintenance-review', source_type: 'property_maintenance', status: 'pending_review', source_workflow_status: 'pending_review', scheduled_date: scheduled, assignee_id: 'staff-1' },
  { id: 'maintenance-review-pending-alias', source_type: 'property_maintenance', status: 'review_pending', scheduled_date: scheduled, assignee_id: 'staff-1' },
  { id: 'maintenance-closed-mapped-done', source_type: 'property_maintenance', status: 'done', source_workflow_status: 'closed', scheduled_date: scheduled, assignee_id: 'staff-1' },
  { id: 'external-maintenance-assigned', source_type: 'external_maintenance_orders', status: 'assigned', scheduled_date: scheduled, assignee_id: 'staff-1' },
  { id: 'external-maintenance-closed-mapped-done', source_type: 'external_maintenance_orders', status: 'done', scheduled_date: scheduled, assignee_id: 'staff-1' },
  { id: 'deep-cleaning-review', source_type: 'property_deep_cleaning', status: 'pending_review', scheduled_date: scheduled, assignee_id: 'staff-2' },
  { id: 'deep-cleaning-awaiting-review-alias', source_type: 'property_deep_cleaning', status: 'awaiting_review', scheduled_date: scheduled, assignee_id: 'staff-2' },
  { id: 'deep-cleaning-completed-review-alias', source_type: 'property_deep_cleaning', status: 'done', scheduled_date: scheduled, assignee_id: 'staff-2' },
  { id: 'daily-necessities-unassigned', source_type: 'property_daily_necessities', status: 'todo', scheduled_date: scheduled, assignee_id: null },
  { id: 'daily-necessities-done', source_type: 'property_daily_necessities', status: 'done', scheduled_date: scheduled, assignee_id: 'staff-2' },
  { id: 'offline-done', source_type: 'cleaning_offline_tasks', task_kind: 'offline', status: 'done', scheduled_date: scheduled, assignee_id: 'staff-3' },
  { id: 'offline-ready', source_type: 'cleaning_offline_tasks', task_kind: 'offline', status: 'ready', scheduled_date: scheduled, assignee_id: 'staff-3' },
  { id: 'offline-assigned', source_type: 'cleaning_offline_tasks', task_kind: 'offline', status: 'assigned', scheduled_date: scheduled, assignee_id: 'staff-3' },
  { id: 'offline-progress', source_type: 'cleaning_offline_tasks', task_kind: 'offline', status: 'in_progress', scheduled_date: scheduled, assignee_id: 'staff-3' },
  { id: 'offline-cancelled', source_type: 'cleaning_offline_tasks', task_kind: 'offline', status: 'cancelled', scheduled_date: scheduled, assignee_id: 'staff-3' },
  { id: 'offline-canceled-alias', source_type: 'cleaning_offline_tasks', task_kind: 'offline', status: 'canceled', scheduled_date: scheduled, assignee_id: 'staff-3' },
  { id: 'offline-unscheduled', source_type: 'cleaning_offline_tasks', task_kind: 'offline', status: 'assigned', scheduled_date: null, task_date: scheduled, date: scheduled, assignee_id: 'staff-3' },
  { id: 'turnover-unassigned-ready', source_type: 'cleaning_tasks', task_type: 'turnover', task_kind: 'cleaning', status: 'ready', scheduled_date: scheduled, assignee_id: null },
  { id: 'checkin-unassigned', source_type: 'cleaning_tasks', task_type: 'checkin', task_kind: 'cleaning', status: 'assigned', scheduled_date: scheduled, assignee_id: null },
  { id: 'checkout-unassigned', source_type: 'cleaning_tasks', task_type: 'checkout', task_kind: 'cleaning', status: 'assigned', scheduled_date: scheduled, assignee_id: null },
  { id: 'stayover-unassigned', source_type: 'cleaning_tasks', task_type: 'stayover_clean', task_kind: 'cleaning', status: 'assigned', scheduled_date: scheduled, assignee_id: null },
]

const expectedVisible = [
  'maintenance-assigned',
  'maintenance-progress',
  'external-maintenance-assigned',
  'daily-necessities-done',
  'offline-done',
  'offline-ready',
  'offline-assigned',
  'offline-progress',
  'turnover-unassigned-ready',
  'checkin-unassigned',
  'checkout-unassigned',
]
for (const role of DAILY_TASK_MANAGER_ROLES) {
  assert.equal(isDailyTaskManagerRoleNames([role]), true, `${role} must use the authorized all-task projection`)
  assert.deepEqual(
    projectVisibleDailyTasks(cases).map((task) => task.id),
    expectedVisible,
    `${role} must receive the same daily execution semantics`,
  )
}
assert.equal(isDailyTaskManagerRoleNames(['cleaner']), false)
assert.equal(isDailyTaskManagerRoleNames(['ADMIN']), false, 'role matching must preserve the existing exact-name authorization boundary')
const caseById = (id: string) => {
  const task = cases.find((item) => item.id === id)
  assert.ok(task, `missing fixture ${id}`)
  return task
}
assert.deepEqual(dailyTaskExecutionVisibility(caseById('maintenance-review')), { visible: false, reason: 'review_only' })
assert.deepEqual(dailyTaskExecutionVisibility(caseById('maintenance-closed-mapped-done')), { visible: false, reason: 'terminal' })
assert.deepEqual(dailyTaskExecutionVisibility(caseById('external-maintenance-closed-mapped-done')), { visible: false, reason: 'review_only' })
assert.deepEqual(dailyTaskExecutionVisibility(caseById('deep-cleaning-completed-review-alias')), { visible: false, reason: 'review_only' })
assert.deepEqual(dailyTaskExecutionVisibility(caseById('daily-necessities-unassigned')), { visible: false, reason: 'unassigned' })
assert.deepEqual(dailyTaskExecutionVisibility(caseById('offline-unscheduled')), { visible: false, reason: 'unscheduled' })

const backendRoot = path.resolve(__dirname, '../..')
const mzapp = fs.readFileSync(path.join(backendRoot, 'src/modules/mzapp.ts'), 'utf8')
const taskCenter = fs.readFileSync(path.join(backendRoot, 'src/modules/task_center.ts'), 'utf8')
const taskCenterPage = fs.readFileSync(path.join(backendRoot, '../frontend/src/app/task-center/page.tsx'), 'utf8')
const maintenanceRecordsPage = fs.readFileSync(path.join(backendRoot, '../frontend/src/app/maintenance/records/page.tsx'), 'utf8')
const deepCleaningRecordsPage = fs.readFileSync(path.join(backendRoot, '../frontend/src/app/deep-cleaning/records/page.tsx'), 'utf8')

assert.match(mzapp, /projectVisibleDailyTasks\(out\)/, 'mobile API must apply the shared server projection before action payloads')
assert.match(mzapp, /source_workflow_status: maintenanceSourceWorkflowStatus/, 'maintenance source workflow must survive the closed-to-done work-task mapping')
assert.match(taskCenter, /projectVisibleDailyTasks\(dedupeBoardTasks/, 'web work-task loader must apply the same shared projection')
assert.match(taskCenter, /pm\.status AS maintenance_source_status/, 'web projection must read authoritative maintenance workflow status')
assert.match(taskCenter, /scheduled_date: row\.scheduled_date \? String\(row\.scheduled_date\)\.slice\(0, 10\) : null/, 'web projection must preserve an explicit unscheduled value instead of fabricating execution eligibility from task_date')
assert.match(taskCenter, /pending_review','review_pending','awaiting_review'.*'closed'/s, 'property follow-up sync must remove review and closed projections without deleting source records')
assert.match(
  taskCenter,
  /w\.source_type = 'property_daily_necessities'[\s\S]*?lower\(COALESCE\(w\.status, ''\)\) IN \('done', 'completed'\)[\s\S]*?w\.scheduled_date IS NOT NULL/,
  'daily-necessities sync must preserve an existing scheduled completion while still excluding replaced sources from active upserts',
)
assert.match(taskCenterPage, /visibleTaskCenterPropertyFollowups/, 'web UI must fail closed instead of rendering property follow-ups directly')
assert.match(maintenanceRecordsPage, /maintenance/i, 'maintenance review/history entry must remain available')
assert.match(deepCleaningRecordsPage, /deep|深清/i, 'deep-cleaning review/history entry must remain available')

process.stdout.write('test_daily_task_execution_visibility: ok\n')
