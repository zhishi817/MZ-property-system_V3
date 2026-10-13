import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  DAILY_TASK_MANAGER_ROLES,
  dailyTaskExecutionVisibility,
  isDailyTaskManagerRoleNames,
  isOrdinaryOfflineDailyTask,
  projectTaskCenterManageableWorkTasks,
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
  { id: 'external-maintenance-unassigned', source_type: 'external_maintenance_orders', task_kind: 'maintenance', status: 'todo', scheduled_date: scheduled, assignee_id: null },
  { id: 'external-maintenance-unassigned-mislabeled', source_type: 'external_maintenance_orders', task_kind: 'offline', status: 'todo', scheduled_date: scheduled, assignee_id: null },
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
  { id: 'offline-unassigned', source_type: 'work_tasks', task_kind: 'offline', status: 'todo', scheduled_date: scheduled, assignee_id: null },
  { id: 'offline-unassigned-source', source_type: 'cleaning_offline_tasks', task_kind: 'offline', task_type: 'company', status: 'todo', scheduled_date: scheduled, assignee_id: null },
  { id: 'offline-cancelled', source_type: 'cleaning_offline_tasks', task_kind: 'offline', status: 'cancelled', scheduled_date: scheduled, assignee_id: 'staff-3' },
  { id: 'offline-canceled-alias', source_type: 'cleaning_offline_tasks', task_kind: 'offline', status: 'canceled', scheduled_date: scheduled, assignee_id: 'staff-3' },
  { id: 'offline-unscheduled', source_type: 'cleaning_offline_tasks', task_kind: 'offline', status: 'assigned', scheduled_date: null, task_date: scheduled, date: scheduled, assignee_id: 'staff-3' },
  { id: 'turnover-unassigned-ready', source_type: 'cleaning_tasks', task_type: 'turnover', task_kind: 'cleaning', status: 'ready', scheduled_date: scheduled, assignee_id: null },
  { id: 'checkin-unassigned', source_type: 'cleaning_tasks', task_type: 'checkin', task_kind: 'cleaning', status: 'assigned', scheduled_date: scheduled, assignee_id: null },
  { id: 'checkout-unassigned', source_type: 'cleaning_tasks', task_type: 'checkout', task_kind: 'cleaning', status: 'assigned', scheduled_date: scheduled, assignee_id: null },
  { id: 'stayover-unassigned', source_type: 'cleaning_tasks', task_type: 'stayover_clean', task_kind: 'cleaning', status: 'assigned', scheduled_date: scheduled, assignee_id: null },
]

const expectedPartnerVisible = [
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
    projectVisibleDailyTasks(cases, { includeManagerUnassignedOffline: true }).map((task) => task.id),
    [
      ...expectedPartnerVisible.slice(0, 8),
      'offline-unassigned',
      'offline-unassigned-source',
      ...expectedPartnerVisible.slice(8),
    ],
    `${role} must receive the same daily execution semantics`,
  )
}
assert.deepEqual(
  projectVisibleDailyTasks(cases).map((task) => task.id),
  expectedPartnerVisible,
  'partner projection includes assigned-to-self candidates only and excludes unassigned tasks',
)
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
assert.deepEqual(dailyTaskExecutionVisibility(caseById('offline-unassigned')), { visible: false, reason: 'unassigned' })
assert.equal(isOrdinaryOfflineDailyTask(caseById('offline-unassigned-source')), true)
assert.deepEqual(
  dailyTaskExecutionVisibility(caseById('offline-unassigned-source'), { includeManagerUnassignedOffline: true }),
  { visible: true, reason: 'visible' },
)
assert.deepEqual(
  projectVisibleDailyTasks(cases, { includeManagerUnassignedOffline: true })
    .filter((task) => task.id.startsWith('offline-unassigned'))
    .map((task) => task.id),
  ['offline-unassigned', 'offline-unassigned-source'],
  'manager all view includes ordinary unassigned offline tasks from both canonical source projections',
)
assert.deepEqual(
  projectVisibleDailyTasks(cases)
    .filter((task) => task.id.startsWith('offline-unassigned'))
    .map((task) => task.id),
  [],
  'partner/self projection continues to exclude every unassigned offline task',
)
assert.equal(
  dailyTaskExecutionVisibility(caseById('daily-necessities-unassigned'), { includeManagerUnassignedOffline: true }).visible,
  false,
  'property follow-up categories remain assignment-first even for managers',
)
assert.equal(
  dailyTaskExecutionVisibility(caseById('external-maintenance-unassigned'), { includeManagerUnassignedOffline: true }).visible,
  false,
  'external maintenance remains assignment-first because its business task kind is maintenance, not ordinary offline',
)
assert.equal(
  dailyTaskExecutionVisibility(caseById('external-maintenance-unassigned-mislabeled'), { includeManagerUnassignedOffline: true }).visible,
  false,
  'external maintenance source remains assignment-first even if a stale projection mislabels the task kind',
)
const dateStatusMatrix = ['2026-10-08', '2026-10-09', '2026-10-10'].flatMap((date) => ([
  { id: `${date}:unassigned`, source_type: 'cleaning_offline_tasks', task_kind: 'offline', status: 'todo', scheduled_date: date, assignee_id: null },
  { id: `${date}:assigned`, source_type: 'cleaning_offline_tasks', task_kind: 'offline', status: 'assigned', scheduled_date: date, assignee_id: 'staff-1' },
  { id: `${date}:in-progress`, source_type: 'cleaning_offline_tasks', task_kind: 'offline', status: 'in_progress', scheduled_date: date, assignee_id: 'staff-1' },
  { id: `${date}:done`, source_type: 'cleaning_offline_tasks', task_kind: 'offline', status: 'done', scheduled_date: date, assignee_id: 'staff-1' },
]))
assert.equal(
  projectVisibleDailyTasks(dateStatusMatrix, { includeManagerUnassignedOffline: true }).length,
  12,
  'past, current and future dates retain unassigned, assigned, incomplete and completed ordinary offline tasks',
)
assert.deepEqual(
  projectTaskCenterManageableWorkTasks(cases).filter((task) => task.id === 'offline-unassigned').map((task) => ({
    id: task.id,
    execution_list_visible: task.execution_list_visible,
  })),
  [{ id: 'offline-unassigned', execution_list_visible: false }],
  'Web assignment surface includes unassigned native offline tasks without changing Mobile execution visibility',
)

const backendRoot = path.resolve(__dirname, '../..')
const mzapp = fs.readFileSync(path.join(backendRoot, 'src/modules/mzapp.ts'), 'utf8')
const taskCenter = fs.readFileSync(path.join(backendRoot, 'src/modules/task_center.ts'), 'utf8')
const taskCenterPage = fs.readFileSync(path.join(backendRoot, '../frontend/src/app/task-center/page.tsx'), 'utf8')
const maintenanceRecordsPage = fs.readFileSync(path.join(backendRoot, '../frontend/src/app/maintenance/records/page.tsx'), 'utf8')
const deepCleaningRecordsPage = fs.readFileSync(path.join(backendRoot, '../frontend/src/app/deep-cleaning/records/page.tsx'), 'utf8')

assert.match(mzapp, /projectVisibleDailyTasks\(out,/, 'mobile API must apply the shared server projection before action payloads')
assert.match(mzapp, /const allowAll = view === 'all' && canViewAll\(user\)/, 'only the three business manager roles may request the all-task execution projection')
assert.match(mzapp, /includeManagerUnassignedOffline: managerCanSeeAllTaskPool/, 'manager list and count projections must share the ordinary unassigned offline policy')
assert.match(mzapp, /source_workflow_status: maintenanceSourceWorkflowStatus/, 'maintenance source workflow must survive the closed-to-done work-task mapping')
assert.match(taskCenter, /projectTaskCenterManageableWorkTasks\(dedupeBoardTasks/, 'Web work-task loader must preserve assignment candidates while reusing shared execution semantics')
assert.match(taskCenter, /FROM property_maintenance m[\s\S]*?m\.status::text/, 'web management projection must read authoritative maintenance workflow status')
assert.match(taskCenter, /scheduled_date: row\.scheduled_date \? String\(row\.scheduled_date\)\.slice\(0, 10\) : null/, 'web projection must preserve an explicit unscheduled value instead of fabricating execution eligibility from task_date')
assert.match(taskCenter, /pending_review','review_pending','awaiting_review','completed','done','ready','canceled','cancelled','closed'/, 'property follow-up projection must hide review, completed and terminal sources without deleting source records')
assert.match(taskCenter, /AND m\.deleted_at IS NULL/, 'soft-deleted maintenance sources must not re-enter the Web projection')
assert.match(taskCenter, /AND d\.deleted_at IS NULL/, 'soft-deleted deep-cleaning sources must not re-enter the Web projection')
assert.match(taskCenter, /a\.source_type = 'property_deep_cleaning'[\s\S]*?w\.id IS NOT NULL[\s\S]*?NULLIF\(BTRIM\(w\.assignee_id::text\), ''\) IS NOT NULL THEN w\.scheduled_date/, 'an unassigned deep-cleaning projection cannot lend its stale work date to a new checkout day')
assert.doesNotMatch(taskCenter, /syncPropertyFollowupWorkTasks/, 'GET must not synchronize property follow-ups into work_tasks')
assert.match(taskCenterPage, /dayData\?\.property_followups \|\| \[\]/, 'Web management must render server-authorized candidates without reusing Mobile execution-list visibility')
assert.match(maintenanceRecordsPage, /maintenance/i, 'maintenance review/history entry must remain available')
assert.match(deepCleaningRecordsPage, /deep|深清/i, 'deep-cleaning review/history entry must remain available')

process.stdout.write('test_daily_task_execution_visibility: ok\n')
