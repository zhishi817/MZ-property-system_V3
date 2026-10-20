import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  DAILY_TASK_MANAGER_ROLES,
  dailyTaskExecutionVisibility,
  dailyTaskWorkRecordProjection,
  evidenceBackedWorkRecordState,
  isDailyTaskManagerRoleNames,
  isOrdinaryOfflineDailyTask,
  mergeRoleRecordEvidenceWithCancellation,
  projectDailyTaskListItems,
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

assert.equal(
  evidenceBackedWorkRecordState({ currentAssigneeId: 'staff-b', evidenceActorUserId: 'staff-a' }),
  'reassigned',
  'A evidence must remain reassigned after B becomes the current assignee, even when the task later completes',
)
assert.equal(
  evidenceBackedWorkRecordState({ currentAssigneeId: 'staff-b', evidenceActorUserId: 'staff-b' }),
  'completed',
  'the current assignee owns their own completion record',
)
assert.equal(
  evidenceBackedWorkRecordState({ cancelled: true, currentAssigneeId: 'staff-b', evidenceActorUserId: 'staff-a' }),
  'cancelled',
  'cancellation remains the canonical record state regardless of earlier reassignment',
)
assert.deepEqual(
  mergeRoleRecordEvidenceWithCancellation({
    roleEvidence: [{ performedAt: '2026-10-19T02:00:00.000Z', actorUserId: 'staff-a' }],
    cancelled: true,
    cancelledAt: '2026-10-19T03:00:00.000Z',
    currentAssigneeId: 'staff-b',
  }),
  [
    { performedAt: '2026-10-19T02:00:00.000Z', actorUserId: 'staff-a' },
    { performedAt: '2026-10-19T03:00:00.000Z', actorUserId: 'staff-b' },
  ],
  'A execution evidence and B cancellation receipt must both survive an A-to-B reassignment followed by cancellation',
)
assert.deepEqual(
  mergeRoleRecordEvidenceWithCancellation({
    roleEvidence: [{ performedAt: '2026-10-19T03:00:00.000Z', actorUserId: 'staff-b' }],
    cancelled: true,
    cancelledAt: '2026-10-19T03:00:00.000Z',
    currentAssigneeId: 'staff-b',
  }),
  [{ performedAt: '2026-10-19T03:00:00.000Z', actorUserId: 'staff-b' }],
  'identical actor/timestamp evidence must not double count a cancellation record',
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

assert.deepEqual(
  dailyTaskWorkRecordProjection({
    id: 'legacy-done-without-timestamp',
    source_type: 'cleaning_offline_tasks',
    task_kind: 'offline',
    status: 'done',
    scheduled_date: '2026-10-19',
    assignee_id: 'staff-3',
  }),
  {
    work_record_visible: false,
    work_record_state: 'completed',
    work_record_date: null,
    original_scheduled_date: '2026-10-19',
    work_record_read_only: true,
    counts_as_active_task: false,
  },
  'a legacy done row without a trustworthy completion timestamp must never re-enter the active queue or counts',
)

const workRecordCases = [
  {
    id: 'mq801-pending-review',
    source_type: 'property_maintenance',
    status: 'pending_review',
    source_workflow_status: 'pending_review',
    scheduled_date: '2026-10-19',
    original_scheduled_date: '2026-10-19',
    work_record_date: '2026-10-19',
    completed_at: '2026-10-19T09:53:54.000Z',
    assignee_id: 'flora',
  },
  {
    id: 'cross-day-completed',
    source_type: 'cleaning_offline_tasks',
    status: 'done',
    scheduled_date: '2026-10-19',
    original_scheduled_date: '2026-10-19',
    work_record_date: '2026-10-20',
    completed_at: '2026-10-20T01:10:00.000Z',
    assignee_id: 'staff-3',
  },
  {
    id: 'cleaning-cross-day-completed',
    source_type: 'cleaning_tasks',
    task_kind: 'cleaning',
    task_type: 'checkout_clean',
    status: 'cleaned',
    work_record_state: 'completed',
    scheduled_date: '2026-10-19',
    original_scheduled_date: '2026-10-19',
    work_record_date: '2026-10-20',
    completed_at: '2026-10-20T02:15:00.000Z',
    assignee_id: 'cleaner-1',
  },
  {
    id: 'cancelled-record',
    source_type: 'cleaning_offline_tasks',
    status: 'cancelled',
    scheduled_date: '2026-10-19',
    original_scheduled_date: '2026-10-19',
    work_record_date: '2026-10-19',
    assignee_id: 'staff-3',
  },
  {
    id: 'rescheduled-record',
    source_type: 'cleaning_offline_tasks',
    status: 'rescheduled',
    work_record_state: 'rescheduled',
    scheduled_date: '2026-10-19',
    original_scheduled_date: '2026-10-19',
    work_record_date: '2026-10-19',
    assignee_id: 'staff-3',
  },
  {
    id: 'reassigned-with-evidence',
    source_type: 'property_maintenance',
    status: 'assigned',
    work_record_state: 'reassigned',
    scheduled_date: '2026-10-22',
    original_scheduled_date: '2026-10-19',
    work_record_date: '2026-10-19',
    assignee_id: 'staff-b',
  },
]
const projectedRecords = projectDailyTaskListItems(workRecordCases)
assert.deepEqual(
  projectedRecords.map((task) => ({
    id: task.id,
    state: task.work_record_state,
    date: task.work_record_date,
    original: task.original_scheduled_date,
    readOnly: task.work_record_read_only,
    executionVisible: task.execution_list_visible,
    countsAsActive: task.counts_as_active_task,
  })),
  [
    { id: 'mq801-pending-review', state: 'pending_review', date: '2026-10-19', original: '2026-10-19', readOnly: true, executionVisible: false, countsAsActive: false },
    { id: 'cross-day-completed', state: 'completed', date: '2026-10-20', original: '2026-10-19', readOnly: true, executionVisible: false, countsAsActive: false },
    { id: 'cleaning-cross-day-completed', state: 'completed', date: '2026-10-20', original: '2026-10-19', readOnly: true, executionVisible: false, countsAsActive: false },
    { id: 'cancelled-record', state: 'cancelled', date: '2026-10-19', original: '2026-10-19', readOnly: true, executionVisible: false, countsAsActive: false },
    { id: 'rescheduled-record', state: 'rescheduled', date: '2026-10-19', original: '2026-10-19', readOnly: true, executionVisible: false, countsAsActive: false },
    { id: 'reassigned-with-evidence', state: 'reassigned', date: '2026-10-19', original: '2026-10-19', readOnly: true, executionVisible: false, countsAsActive: false },
  ],
  'completion, cancellation, reschedule and evidence-backed reassignment remain immutable records without re-entering execution counts',
)

const backendRoot = path.resolve(__dirname, '../..')
const mzapp = fs.readFileSync(path.join(backendRoot, 'src/modules/mzapp.ts'), 'utf8')
const maintenance = fs.readFileSync(path.join(backendRoot, 'src/modules/maintenance.ts'), 'utf8')
const cleaningApp = fs.readFileSync(path.join(backendRoot, 'src/modules/cleaning_app.ts'), 'utf8')
const workTasks = fs.readFileSync(path.join(backendRoot, 'src/modules/work_tasks.ts'), 'utf8')
const directCreateStart = workTasks.indexOf("router.post('/',")
const directCreateEnd = workTasks.indexOf("router.patch('/:id'", directCreateStart)
const directCreateRoute = workTasks.slice(directCreateStart, directCreateEnd)
const sourceUpsertStart = workTasks.indexOf("router.post('/upsert-from-source'")
const sourceUpsertRoute = workTasks.slice(sourceUpsertStart)
const taskCenter = fs.readFileSync(path.join(backendRoot, 'src/modules/task_center.ts'), 'utf8')
const taskCenterPage = fs.readFileSync(path.join(backendRoot, '../frontend/src/app/task-center/page.tsx'), 'utf8')
const maintenanceRecordsPage = fs.readFileSync(path.join(backendRoot, '../frontend/src/app/maintenance/records/page.tsx'), 'utf8')
const deepCleaningRecordsPage = fs.readFileSync(path.join(backendRoot, '../frontend/src/app/deep-cleaning/records/page.tsx'), 'utf8')
const genericManagerHistoryStart = mzapp.lastIndexOf('if (managerCanSeeAllTaskPool) {', mzapp.indexOf("markWorkTasksStep('work_pool')"))
const genericManagerHistoryEnd = mzapp.indexOf("markWorkTasksStep('work_pool')", genericManagerHistoryStart)
const genericManagerHistory = mzapp.slice(genericManagerHistoryStart, genericManagerHistoryEnd)
const markRouteStart = mzapp.indexOf("router.post('/work-tasks/:id/mark'")
const markRouteEnd = mzapp.indexOf('const workTaskCompletionPhotoAppendSchema', markRouteStart)
const markRoute = mzapp.slice(markRouteStart, markRouteEnd)
const reorderStart = mzapp.indexOf("router.post('/work-tasks/reorder'")
const reorderEnd = mzapp.indexOf("router.post('/work-tasks/mixed-reorder'", reorderStart)
const reorderRoute = mzapp.slice(reorderStart, reorderEnd)
const mixedReorderStart = mzapp.indexOf("router.post('/work-tasks/mixed-reorder'")
const mixedReorderEnd = mzapp.indexOf('const workTaskPhotosSchema', mixedReorderStart)
const mixedReorder = mzapp.slice(mixedReorderStart, mixedReorderEnd)
const photosStart = mzapp.indexOf("router.patch('/work-tasks/:id/photos'")
const photosEnd = mzapp.indexOf("router.post('/work-tasks/:id/", photosStart)
const photosRoute = mzapp.slice(photosStart, photosEnd > photosStart ? photosEnd : undefined)
const mineAccessStart = mzapp.indexOf('if (!allowAll) {', mzapp.indexOf('const managerCanSeeAllTaskPool'))
const mineAccessEnd = mzapp.indexOf('const sql =', mineAccessStart)
const mineAccess = mzapp.slice(mineAccessStart, mineAccessEnd)
const priorExecutionEnd = mzapp.indexOf(') prior_execution_event ON TRUE')
const priorExecutionStart = mzapp.lastIndexOf('LEFT JOIN LATERAL (', priorExecutionEnd)
const priorExecution = mzapp.slice(priorExecutionStart, priorExecutionEnd)

assert.match(mzapp, /projectDailyTaskListItems\(out,/, 'mobile API must apply the shared server execution-plus-record projection before action payloads')
assert.match(mzapp, /work_record_transition:[\s\S]*?state: 'rescheduled'/, 'a defer must append an immutable original-day record transition')
assert.match(mzapp, /eventType: 'TASK_UPDATED',[\s\S]*?changeScope: 'membership',[\s\S]*?work_record_transition:/, 'a defer must force a canonical refetch so the active destination and original-day placeholder arrive together')
assert.match(mzapp, /status: 'rescheduled',[\s\S]*?photo_urls: \[\],[\s\S]*?completion_photo_urls: normalizeWorkTaskPhotoUrls\(x\.transition_photo_urls\)/, 'an original-day reschedule record must not inherit mutable photos from the destination task')
assert.match(markRoute, /lower\(COALESCE\(status, ''\)\) NOT IN \('done', 'completed', 'ready', 'cancelled', 'canceled', 'closed'\)/, 'mark and defer writes must reject every terminal record state at SQL time')
assert.match(markRoute, /changeScope: 'list',[\s\S]*?completion_reason: reason,[\s\S]*?\}, client\)/, 'a no-date unfinished update must publish its cross-device cache event in the same transaction')
assert.match(mzapp, /prior_execution_event\.performed_at IS NOT NULL[\s\S]*?THEN 'reassigned'/, 'a former assignee record must require persisted execution evidence')
assert.doesNotMatch(mzapp, /emo\.completed_at/, 'external maintenance records must use the deployed submitted timestamp column')
assert.doesNotMatch(mzapp, /emo\.review_status/, 'external maintenance records must not query a review_status column absent from the deployed schema')
assert.match(mzapp, /maintenance_record_event\.event_type IN \('executor_completed', 'manager_completed', 'submitted'\)[\s\S]*?THEN base\.assignee_id/, 'completion records belong to the assigned executor rather than the reviewer')
assert.match(mzapp, /source_record_reason == null[\s\S]*?x\.completion_reason/, 'a maintenance cancellation must retain its authoritative source reason')
assert.match(mzapp, /emitWorkTaskEvent\(\{[\s\S]*?eventType: 'TASK_COMPLETED'[\s\S]*?\}, client\)[\s\S]*?COMMIT/, 'generic completion and its authoritative work-record event must commit atomically')
assert.match(mzapp, /cleaner_record\.performed_at AS cleaner_record_at[\s\S]*?inspector_record\.performed_at AS inspector_record_at[\s\S]*?cancelled_record\.occurred_at AS cancelled_record_at/, 'cleaning history must use persisted cleaner, inspector and cancellation evidence')
assert.match(mzapp, /__work_record_state: recordState[\s\S]*?__original_scheduled_date: taskDate/, 'cleaning history must project an actual-day record without moving its original planned date')
assert.match(mzapp, /isWorkRecordGroup[\s\S]*?work_record_date: workRecordDate \|\| date[\s\S]*?original_scheduled_date: originalScheduledDate/, 'cleaning completion records must expose explicit record and original dates')
assert.match(mzapp, /historical_candidate_ids AS MATERIALIZED[\s\S]*?performed_as_action IN \('complete_cleaning', 'submit_inspection'\)[\s\S]*?media\.type = 'lockbox_video'/, 'terminal cleaning rows must remain queryable when immutable execution evidence exists')
assert.match(mzapp, /const recordKey = recordState \? `record:\$\{recordState\}:\$\{recordActorId \|\| 'unassigned'\}` : 'active'/, 'manager aggregation must not merge active cleaning cards with historical records')
assert.match(mzapp, /w\.is_work_record AND COALESCE\([\s\S]*?w\.work_record_date[\s\S]*?NOT w\.is_work_record AND w\.scheduled_date/, 'completed cross-day rows must be selected only by their record date')
assert.match(mzapp, /isReassignedRecord \? \[\] : normalizeWorkTaskPhotoUrls\(x\.photo_urls\)/, 'a former executor record must not inherit the current assignee photo set')
assert.match(mzapp, /completion_note: isReassignedRecord[\s\S]*?\? null[\s\S]*?completion_reason: isReassignedRecord[\s\S]*?任务已改派；此条仅保留原执行人的实际工作记录/, 'a former executor record must not inherit the current assignee note or current-state reason')
assert.match(mzapp, /if \(managerCanSeeAllTaskPool\) \{[\s\S]*?WITH execution_evidence AS[\s\S]*?work_record_state: 'reassigned'/, 'manager roles must receive evidence-backed prior-executor records without replacing the current assignee card')
assert.match(genericManagerHistory, /maintenance_action'[\s\S]*?IN \('executor_complete', 'submit'\)/, 'manager-completed maintenance must not misattribute the manager as the actual repairer')
assert.doesNotMatch(genericManagerHistory, /maintenance_action'[\s\S]*?IN \([^)]*manager_complete/, 'manager-complete attribution must come from the authoritative assignee, not the event actor')
assert.doesNotMatch(genericManagerHistory, /maintenance_action' IS NULL/, 'an unclassified generic event must never make its audit actor a former executor')
assert.match(genericManagerHistory, /execution_evidence,is_execution}' = 'true'[\s\S]*?execution_evidence,actor_user_id}' = event\.caused_by_user_id::text/, 'generic history must require explicit, actor-matched execution evidence')
assert.match(markRoute, /kind: assignee === userId \? 'executor_completion' : 'manager_completion'[\s\S]*?is_execution: assignee === userId/, 'mobile completion must distinguish the assigned executor from a manager marking done')
assert.equal((markRoute.match(/\(\$\d+::boolean OR COALESCE\(assignee_id::text, ''\) = \$\d+::text\)/g) || []).length, 3, 'complete and both defer writes must re-check the current assignee at write time')
assert.match(markRoute, /latestRow && isWorkTaskDoneStatus\(latestRow\.status\)[\s\S]*?latestRow\.assignee_id[\s\S]*?return res\.status\(403\)/, 'a concurrent completion response must not disclose the new assignee record to a stale caller')
assert.match(workTasks, /kind: completedChanged \? 'manager_completion'[\s\S]*?is_execution: false/, 'web management completion must not be classified as executor evidence')
assert.match(mzapp, /kind: 'manager_feedback_completion'[\s\S]*?is_execution: false/, 'deep-cleaning manager completion must not create a false reassigned actor record')
assert.doesNotMatch(mineAccess, /history_event\.event_type NOT IN/, 'editing or reviewing a task must not grant a manager a personal work record')
assert.doesNotMatch(mineAccess, /w\.work_record_actor_user_id =/, 'an audit actor field alone must not grant personal work-record visibility')
assert.match(mineAccess, /execution_evidence,is_execution}' = 'true'[\s\S]*?execution_evidence,actor_user_id}' = history_event\.caused_by_user_id::text/, 'mine access must require explicit actor-matched execution evidence')
assert.doesNotMatch(mineAccess, /history_maintenance\.event_type IN \([^)]*manager_completed/, 'manager-completed maintenance must not broaden the manager mine view')
assert.match(priorExecution, /execution_evidence,is_execution}' = 'true'[\s\S]*?execution_evidence,actor_user_id}' = event\.caused_by_user_id::text/, 'mine reassignment projection must require explicit actor-matched execution evidence')
assert.match(priorExecution, /audit\.performed_as_action IN \('fill_supplies', 'complete_cleaning', 'submit_inspection', 'upload_access_video'\)/, 'mine reassignment projection must ignore non-execution audits')
assert.match(mzapp, /work_record_event\.event_type = 'TASK_COMPLETED'[\s\S]*?execution_evidence,is_execution}' = 'false'[\s\S]*?THEN base\.assignee_id/, 'manager-triggered canonical completion belongs to the authoritative assignee while its audit actor stays in the event')
assert.match(mzapp, /DISTINCT ON \(task_id, role_kind, actor_user_id\)[\s\S]*?managerRecordEvidenceByTaskId/, 'cleaning history must retain one durable record per task, role and actual actor')
assert.match(mzapp, /hideUnattributedHistoricalMedia = isWorkRecordGroup && workRecordState === 'reassigned'/, 'every reassigned cleaning record must hide mutable current-task media, including self views')
assert.match(mixedReorder, /client\.query\('BEGIN'\)[\s\S]*?client\.query\('COMMIT'\)[\s\S]*?client\.release\(\)/, 'mixed reorder must use one checked-out database connection for the full transaction')
assert.match(mixedReorder, /NOT IN \('cleaned', 'restock_pending', 'restocked', 'done', 'completed'/, 'cleaner work-record states must be immutable through direct reorder APIs')
assert.match(reorderRoute, /COALESCE\(w\.assignee_id::text, ''\) = \$3::text/, 'ordinary reorder must re-check the current assignee at write time')
assert.match(mixedReorder, /COALESCE\(w\.assignee_id::text, ''\) = \$3::text/, 'mixed work-task reorder must re-check the current assignee at write time')
assert.match(photosRoute, /COALESCE\(assignee_id::text, ''\) = \$4::text/, 'photo updates must re-check the current assignee at write time')
assert.match(mzapp, /media_access_work_task_id: String\(x\.id\)/, 'a synthetic historical card must retain the canonical task id for guarded media reads')
assert.match(mzapp, /work_record_media_attributed: isReassignedRecord/, 'actor-bound generic history media must carry explicit provenance for Mobile redaction')
assert.match(mzapp, /if \(isWorkRecord\) \{[\s\S]*?payload\.available_actions = \[\]/, 'read-only records must not advertise executable server actions')
assert.match(mzapp, /const responseTask = isWorkRecord[\s\S]*?old_code: null[\s\S]*?new_code: null[\s\S]*?access_guide_link: null[\s\S]*?wifi_password: null/, 'work records must not extend access to current property credentials')
assert.match(mzapp, /const sanitizedTurnoverDisplay = isWorkRecord[\s\S]*?old_code: null[\s\S]*?new_code: null[\s\S]*?guest_request_summary: null[\s\S]*?guest_special_request/, 'work records must redact nested turnover credentials, guest requests and their conflicts')
assert.match(mzapp, /const responseTask = isWorkRecord[\s\S]*?guest_special_request: null[\s\S]*?order_note: null[\s\S]*?turnover_display: sanitizedTurnoverDisplay/, 'work records must not retain live guest details in top-level or nested projections')
assert.match(mzapp, /const taskWithParticipants = isProjectedWorkRecord[\s\S]*?taskWithGuestState[\s\S]*?attachWorkTaskParticipants/, 'work records must not inherit live participant grants or guest-ready state')
assert.match(maintenance, /row\?\.cancelled_at/, 'a cancellation response must timestamp its read-only work record')
assert.match(maintenance, /recordState === 'cancelled'[\s\S]*?completion_reason/, 'a cancellation response must retain its reason')
assert.match(maintenance, /await emitWorkTaskEvent\(\{[\s\S]*?maintenance_action: action[\s\S]*?\}, client\)[\s\S]*?await client\.query\('COMMIT'\)/, 'maintenance transitions and cross-device list invalidation must commit atomically')
assert.match(maintenance, /changedFields: \[[\s\S]*?'work_record_visible'[\s\S]*?'work_record_date'[\s\S]*?'counts_as_active_task'[\s\S]*?patch: \{[\s\S]*?work_record_visible: workRecordVisible/, 'maintenance completion events must patch the record projection immediately instead of briefly removing the task')
assert.match(cleaningApp, /FROM work_task_events event[\s\S]*?completion_photo_urls[\s\S]*?photo_urls/, 'historical media authorization must inspect immutable task-event photo references')
assert.match(cleaningApp, /work_record_actor_user_ids/, 'historical media authorization must preserve the actor scope from immutable evidence')
assert.match(cleaningApp, /router\.post\('\/tasks\/:id\/completion-photos'[\s\S]*?assertCleaningTaskRoleRecordMutable\([\s\S]*?actionId: 'complete_cleaning'[\s\S]*?DELETE FROM cleaning_task_media/, 'completion-photo replacement must reject submitted cleaner records before deleting immutable evidence')
assert.match(workTasks, /await client\.query\('BEGIN'\)[\s\S]*?INSERT INTO work_tasks[\s\S]*?await emitWorkTaskEvent\(\{[\s\S]*?TASK_CREATED[\s\S]*?await client\.query\('COMMIT'\)/, 'direct Web task creation and its event must commit atomically')
assert.match(directCreateRoute, /requestedStatus === 'done' \|\| requestedStatus === 'cancelled'[\s\S]*?terminal_status_not_allowed_on_create/, 'direct creation must start active and use a dedicated transition for terminal records')
assert.doesNotMatch(directCreateRoute, /eventType: 'TASK_COMPLETED'/, 'direct creation must not invent executor completion evidence')
assert.match(workTasks, /lower\(COALESCE\(status, ''\)\) NOT IN \('done', 'completed', 'cancelled', 'canceled', 'closed'\)[\s\S]*?work_record_read_only/, 'direct Web task mutation must reject terminal work records, including races')
assert.match(workTasks, /cancellation_reason_required[\s\S]*?eventType: completedChanged \? 'TASK_COMPLETED' : cancelledChanged \? 'TASK_REMOVED'/, 'direct Web cancellation must retain a reason and publish a record-forming membership event')
assert.match(workTasks, /const upsertFromSourceSchema = z\.object[\s\S]*?\.partial\(\)\.strict\(\)/, 'source upsert must reject arbitrary database column patches')
assert.match(workTasks, /ON CONFLICT \(source_type, source_id\) DO UPDATE SET[\s\S]*?WHERE lower\(COALESCE\(work_tasks\.status, ''\)\) NOT IN/, 'source upsert must never reopen a terminal record through a conflict update')
assert.match(sourceUpsertRoute, /terminal_status_requires_transition[\s\S]*?client\.query\('BEGIN'\)[\s\S]*?FOR UPDATE[\s\S]*?work_record_read_only[\s\S]*?emitWorkTaskEvent\([\s\S]*?client\.query\('COMMIT'\)/, 'source upsert must reject terminal transitions and publish active mutations atomically')
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
