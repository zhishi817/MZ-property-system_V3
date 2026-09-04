import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  availableMaintenanceActions,
  MAINTENANCE_WORKFLOW_MANAGE_PERMISSION,
  maintenanceWorkTaskStatus,
  normalizeMaintenanceWorkflowStatus,
  validateMaintenanceWorkflowAction,
} from '../../src/lib/maintenanceWorkflow'

assert.equal(normalizeMaintenanceWorkflowStatus('pending'), 'pending_assignment')
assert.equal(normalizeMaintenanceWorkflowStatus('completed'), 'pending_review')
assert.equal(normalizeMaintenanceWorkflowStatus('completed', 'approved'), 'closed')
assert.equal(normalizeMaintenanceWorkflowStatus('cancelled'), 'cancelled')
assert.equal(maintenanceWorkTaskStatus('pending_assignment'), 'todo')
assert.equal(maintenanceWorkTaskStatus('closed'), 'done')

assert.deepEqual(
  availableMaintenanceActions({ status: 'pending_assignment', isManager: false, isAssignedExecutor: false }),
  [],
)
assert.deepEqual(
  availableMaintenanceActions({ status: 'assigned', isManager: false, isAssignedExecutor: true }),
  ['executor_complete', 'executor_unfinished'],
)
assert.deepEqual(
  availableMaintenanceActions({ status: 'pending_review', isManager: true, isAssignedExecutor: false }),
  ['review'],
)
assert.deepEqual(
  availableMaintenanceActions({ status: 'pending_assignment', isManager: true, isAssignedExecutor: false }),
  ['assign', 'cancel', 'manager_start', 'manager_complete'],
)
assert.deepEqual(
  availableMaintenanceActions({ status: 'closed', isManager: true, isAssignedExecutor: false }),
  ['correct_completion', 'reopen'],
)

assert.deepEqual(
  validateMaintenanceWorkflowAction({ action: 'submit', status: 'in_progress', isManager: false, isAssignedExecutor: true, completionPhotoCount: 0 }),
  { ok: false, code: 'maintenance_completion_photo_required' },
)
assert.deepEqual(
  validateMaintenanceWorkflowAction({ action: 'submit', status: 'in_progress', isManager: false, isAssignedExecutor: true, completionPhotoCount: 1 }),
  { ok: true },
)
assert.deepEqual(
  validateMaintenanceWorkflowAction({ action: 'executor_complete', status: 'pending_assignment', isManager: false, isAssignedExecutor: false, completionPhotoCount: 1 }),
  { ok: false, code: 'maintenance_assignee_required' },
)
assert.deepEqual(
  validateMaintenanceWorkflowAction({ action: 'executor_complete', status: 'assigned', isManager: false, isAssignedExecutor: true, completionPhotoCount: 0 }),
  { ok: false, code: 'maintenance_completion_photo_required' },
)
assert.deepEqual(
  validateMaintenanceWorkflowAction({ action: 'executor_unfinished', status: 'in_progress', isManager: false, isAssignedExecutor: true }),
  { ok: false, code: 'maintenance_unfinished_reason_required' },
)
assert.deepEqual(
  validateMaintenanceWorkflowAction({ action: 'executor_unfinished', status: 'in_progress', isManager: false, isAssignedExecutor: true, reason: '配件缺失' }),
  { ok: true },
)
assert.deepEqual(
  validateMaintenanceWorkflowAction({ action: 'review_rejected', status: 'pending_review', isManager: true, isAssignedExecutor: false }),
  { ok: false, code: 'maintenance_review_reason_required' },
)
assert.deepEqual(
  validateMaintenanceWorkflowAction({ action: 'review_approved', status: 'pending_review', isManager: true, isAssignedExecutor: false, completionPhotoCount: 0 }),
  { ok: false, code: 'maintenance_completion_photo_required' },
)
assert.deepEqual(
  validateMaintenanceWorkflowAction({ action: 'review_approved', status: 'pending_review', isManager: true, isAssignedExecutor: false, completionPhotoCount: 1 }),
  { ok: true },
)
assert.deepEqual(
  validateMaintenanceWorkflowAction({ action: 'cancel', status: 'assigned', isManager: true, isAssignedExecutor: false, reason: 'client cancelled' }),
  { ok: true },
)
assert.deepEqual(
  validateMaintenanceWorkflowAction({ action: 'reopen', status: 'closed', isManager: false, isAssignedExecutor: true }),
  { ok: false, code: 'maintenance_manager_required' },
)
assert.deepEqual(
  validateMaintenanceWorkflowAction({ action: 'manager_complete', status: 'in_progress', isManager: true, isAssignedExecutor: false, completionPhotoCount: 0 }),
  { ok: false, code: 'maintenance_completion_photo_required' },
)
assert.deepEqual(
  validateMaintenanceWorkflowAction({ action: 'manager_complete', status: 'in_progress', isManager: true, isAssignedExecutor: false, completionPhotoCount: 1 }),
  { ok: true },
)
assert.deepEqual(
  validateMaintenanceWorkflowAction({ action: 'correct_completion', status: 'closed', isManager: true, isAssignedExecutor: false }),
  { ok: false, code: 'maintenance_completion_correction_reason_required' },
)
assert.deepEqual(
  validateMaintenanceWorkflowAction({ action: 'correct_completion', status: 'in_progress', isManager: true, isAssignedExecutor: false, reason: '完成日期录错' }),
  { ok: false, code: 'maintenance_transition_invalid' },
)
assert.deepEqual(
  validateMaintenanceWorkflowAction({ action: 'correct_completion', status: 'closed', isManager: false, isAssignedExecutor: true, reason: '完成日期录错' }),
  { ok: false, code: 'maintenance_manager_required' },
)
assert.deepEqual(
  validateMaintenanceWorkflowAction({ action: 'correct_completion', status: 'closed', isManager: true, isAssignedExecutor: false, reason: '完成日期录错' }),
  { ok: true },
)

const backendRoot = path.resolve(__dirname, '../..')
const read = (relativePath: string) => fs.readFileSync(path.join(backendRoot, relativePath), 'utf8')
const maintenanceRouter = read('src/modules/maintenance.ts')
const mzapp = read('src/modules/mzapp.ts')
const crud = read('src/modules/crud.ts')
const cleaningApp = read('src/modules/cleaning_app.ts')
const workTasks = read('src/modules/work_tasks.ts')
const publicRouter = read('src/modules/public.ts')
const workflowStore = read('src/lib/maintenanceWorkflowStore.ts')
const taskCenter = read('src/modules/task_center.ts')
const cleaning = read('src/modules/cleaning.ts')
const taskCenterPage = fs.readFileSync(path.resolve(backendRoot, '../frontend/src/app/task-center/page.tsx'), 'utf8')
const maintenanceRecordsPage = fs.readFileSync(path.resolve(backendRoot, '../frontend/src/app/maintenance/records/page.tsx'), 'utf8')
const store = read('src/store.ts')
const permissionsCatalog = read('src/permissionsCatalog.ts')

assert.equal(MAINTENANCE_WORKFLOW_MANAGE_PERMISSION, 'property_maintenance.workflow.manage')
assert.match(store, /'property_maintenance\.workflow\.manage'/)
const offlineManagerGrant = store.match(/grant\(offlineMgrId, \[([\s\S]*?)\]\)/)?.[1] || ''
assert.doesNotMatch(offlineManagerGrant, /property_maintenance\.workflow\.manage/)
assert.match(permissionsCatalog, /'property_maintenance\.workflow\.manage'/)
assert.match(maintenanceRouter, /userHasAnyPerm\(user, \[MAINTENANCE_WORKFLOW_MANAGE_PERMISSION\]\)/)
assert.doesNotMatch(maintenanceRouter, /offline_manager/)
assert.match(mzapp, /canManageMaintenanceWorkflow = await userHasAnyPerm\(user, \[MAINTENANCE_WORKFLOW_MANAGE_PERMISSION\]\)/)
assert.match(mzapp, /can_manage_workflow: canManageWorkflow/)
assert.match(maintenanceRecordsPage, /hasPerm\('property_maintenance\.workflow\.manage'\)/)
assert.match(maintenanceRecordsPage, /manager_complete/)
assert.match(maintenanceRecordsPage, /recordActualRepairerWithCompletion/)
assert.match(maintenanceRecordsPage, /pendingReviewActualRepairerRequired/)
assert.match(maintenanceRecordsPage, /实际维修人员/)
assert.match(maintenanceRecordsPage, /const reviewCompletedAt = v\.completed_at \? dayjs\(v\.completed_at\)\.format\('YYYY-MM-DD'\) : undefined/)
assert.match(maintenanceRecordsPage, /completedAt: reviewCompletedAt/)
assert.match(maintenanceRouter, /let completedByAssigneeId: string \| null = null/)
assert.match(maintenanceRouter, /action === 'manager_complete'[\s\S]*requestedAssigneeId[\s\S]*actual_repairer_id/)
assert.match(maintenanceRouter, /const actualRepairerId = requestedAssigneeId \|\| String\(row\.assignee_id \|\| ''\)\.trim\(\)/)
assert.match(maintenanceRouter, /maintenance_actual_repairer_required/)
assert.match(maintenanceRouter, /assignee_id: completedByAssigneeId/)
assert.match(maintenanceRouter, /action === 'review_approved'[\s\S]*requestedAssigneeId[\s\S]*actual_repairer_id[\s\S]*maintenance_actual_repairer_required/, 'review approval must not close an unassigned maintenance record')
assert.match(maintenanceRouter, /action === 'review_approved'[\s\S]*assignee_id: completedByAssigneeId/, 'review approval must persist the actual repairer before closing')
assert.match(maintenanceRouter, /action === 'review_approved'[\s\S]*completedAtFromWorkflowBody\(body\.completed_at\)[\s\S]*completed_at: completedAt/, 'review approval must atomically persist its validated accounting completion date before auto-expense sync')
assert.match(maintenanceRouter, /action === 'correct_completion'[\s\S]*completedAtFromWorkflowBody\(body\.completed_at\)/, 'closed completion correction must validate a supplied accounting date through the workflow route')
assert.match(maintenanceRouter, /action === 'correct_completion'[\s\S]*completion_photo_urls: JSON\.stringify\(nextCompletionPhotoUrls\)/, 'closed completion correction must update authoritative completion photos through the workflow route')
assert.match(maintenanceRouter, /action === 'correct_completion'[\s\S]*if \(nextCompletionPhotoUrls\.length < 1\)[\s\S]*maintenance_completion_photo_required/, 'a closed completion correction must preserve at least one completion photo even when only the date changes')
assert.match(maintenanceRouter, /action === 'correct_completion'[\s\S]*maintenance_auto_expense_manual_override/, 'a manual auto-expense override must reject a completion-date correction before commit')
assert.match(maintenanceRouter, /action === 'correct_completion'[\s\S]*eventType = 'completion_corrected'/, 'closed completion correction must emit an audited workflow event')
assert.match(maintenanceRouter, /action === 'review_rejected'[\s\S]*nextStatus = 'pending_assignment'[\s\S]*assignee_id: null[\s\S]*assigned_at: null[\s\S]*assigned_by: null[\s\S]*started_at: null/, 'review rejection must return the source record to unassigned pending work')
assert.match(maintenanceRouter, /action === 'review_rejected'[\s\S]*domain === 'internal' \? \{ eta: null, completed_at: null \} : \{ scheduled_date: null \}/, 'review rejection must clear the prior assignment schedule and stale internal completion date')
assert.match(maintenanceRouter, /action === 'review_rejected'[\s\S]*previous_assignee_id:[\s\S]*previous_scheduled_date:[\s\S]*previous_completed_at:[\s\S]*previous_completion_photo_count:/, 'review rejection must retain cleared assignment context in the workflow audit event')
assert.match(maintenanceRecordsPage, /pending_review:\s*\[[\s\S]*value: 'pending_assignment', label: '退回维修（待分派）'/, 'the web review action must visibly target pending assignment')
assert.match(maintenanceRecordsPage, /targetWorkflowStatus === 'pending_assignment' && currentWorkflowStatus === 'pending_review'[\s\S]*decision: 'rejected'/, 'the web return action must reject without assigning another repairer')
assert.match(maintenanceRecordsPage, /currentWorkflowStatus === 'pending_review'[\s\S]*requestedWorkflowStatus !== 'pending_assignment'[\s\S]*shouldAutoApproveInternalMaintenanceSettlement/, 'an existing payment method must not make a repairer mandatory when returning to pending assignment')

assert.match(maintenanceRouter, /SELECT \* FROM \$\{workflowTable\(domain\)\} WHERE id=\$1 FOR UPDATE/)
assert.match(maintenanceRouter, /record_patch/)
assert.match(maintenanceRouter, /operation_id/)
assert.match(maintenanceRouter, /if \(has\('photo_urls'\)\) patch\.photo_urls = nonEmptyStrings\(value\.photo_urls\)/)
assert.match(maintenanceRouter, /const cast = field === 'completion_photo_urls'[\s\S]*\? '::jsonb'[\s\S]*field === 'photo_urls'[\s\S]*\? '::text\[\]'/)
assert.match(maintenanceRecordsPage, /if \(prePhotos\.length\) payload\.photo_urls = prePhotos/)
assert.match(maintenanceRecordsPage, /correctInternalMaintenanceCompletion\(/, 'the web drawer must use the dedicated closed-completion correction route')
assert.match(maintenanceRecordsPage, /管理员直接修正已关闭维修完成信息/, 'the web drawer must automatically retain an audit reason for direct manager completion edits')
assert.match(maintenanceRecordsPage, /可直接更新实际完成日期、维修人员、完工说明或照片/, 'the web drawer must let managers directly edit closed completion fields without an extra correction mode')
assert.doesNotMatch(maintenanceRecordsPage, /completion_correction/, 'the web drawer must not require a separate correction-mode checkbox')
assert.match(maintenanceRecordsPage, /已关闭维修必须至少保留一张维修后照片/, 'the web drawer must prevent clearing every required completion photo')
assert.match(maintenanceRouter, /saveIdempotentStepReceipt\(client, receiptScope/)
assert.match(maintenanceRouter, /assertMaintenanceWorkflowSchemaReady\(pgPool\)/)
assert.match(workflowStore, /maintenance_workflow_events/)
assert.match(workflowStore, /maintenanceTaskSummaryFromDetails/)
assert.match(maintenanceRouter, /completion_photo_urls/)
assert.match(maintenanceRouter, /executor_complete/)
assert.match(maintenanceRouter, /executor_unfinished/)
assert.match(maintenanceRouter, /action === 'executor_unfinished'[\s\S]*completionPhotoUrls\.length \? \{ completion_photo_urls: JSON\.stringify\(completionPhotoUrls\) \} : \{\}/)
assert.match(maintenanceRouter, /String\(row\.assignee_id \|\| ''\)\.trim\(\) === userId\(user\)/)
assert.match(maintenanceRouter, /reconcileLegacyInternalMaintenanceAssignee/)
assert.match(maintenanceRouter, /String\(projection\?\.assignee_id \|\| ''\)\.trim\(\) !== actorId/)
assert.match(maintenanceRouter, /eventType: 'assignment_reconciled'/)
assert.doesNotMatch(maintenanceRouter, /maintenance_staff/)
assert.match(maintenanceRouter, /external_maintenance_orders/)
assert.match(mzapp, /\['property_maintenance', 'external_maintenance_orders'\]\.includes\(String\(row\.source_type/)
assert.match(mzapp, /maintenanceWorkflowForWorkTask/)
assert.match(mzapp, /String\(task\?\.assignee_id \|\| ''\)\.trim\(\) === actorId/)
assert.match(mzapp, /if \(s === 'pending_review'\) return 'pending_review'/)
assert.match(mzapp, /return status === 'todo' && String\(assigneeId \?\? ''\)\.trim\(\) \? 'assigned' : status/)
assert.match(mzapp, /pm\.status AS maintenance_source_status/)
assert.match(mzapp, /maintenanceWorkTaskStatus\(normalizeMaintenanceWorkflowStatus\(maintenanceSourceStatus, maintenanceSourceReviewStatus\)\)/)
assert.match(mzapp, /status: maintenanceProjectionStatus \?\? effectiveWorkTaskStatus\(x\.status, x\.assignee_id\)/)
assert.doesNotMatch(mzapp, /MAINTENANCE_WORK_TASK_SOURCE_TYPES/)
assert.match(crud, /maintenance_feedback_creation_required/)
assert.match(crud, /maintenance_cancel_required/)
const propertyMaintenancePatchGuard = crud.slice(
  crud.indexOf("router.patch('/:resource/:id'"),
  crud.indexOf("if (resource === 'property_maintenance' || resource === 'property_deep_cleaning')"),
)
assert.match(propertyMaintenancePatchGuard, /'completed_at'/, 'ordinary maintenance PATCH must treat accounting completion date as a workflow-only field')
assert.match(propertyMaintenancePatchGuard, /maintenance_workflow_action_required/, 'ordinary maintenance PATCH must reject workflow-only fields before expense synchronization')
assert.match(maintenanceRouter, /action === 'manager_complete'[\s\S]*completed_at: completedAt/, 'only manager completion writes the supplied accounting completion date')
assert.match(crud, /pending_assignment: \['pending_assignment', 'pending'\]/)
assert.match(crud, /in_progress: \['in_progress', 'repairing', 'started'\]/)
assert.match(crud, /pending_review: \['pending_review', 'review_pending', 'awaiting_review', 'completed', 'done', 'ready'\]/)
assert.match(crud, /cancelled: \['cancelled', 'canceled'\]/)
assert.match(crud, /"status" = ANY\(\$\$\{values\.length\}::text\[\]\)/)
assert.match(workTasks, /maintenance_workflow_action_required/)
assert.match(mzapp, /resolveInternalMaintenanceFeedbackOrigin/)
assert.match(mzapp, /maintenance_feedback_source_task_required/)
assert.match(mzapp, /maintenance_feedback_source_task_forbidden/)
assert.match(mzapp, /feedbackSource: 'manager_feedback'/)
assert.match(mzapp, /feedbackSource: isInspectorFeedback \? 'inspection_feedback' : 'cleaning_feedback'/)
assert.match(mzapp, /createInternalMaintenanceFromFeedback/)
assert.match(mzapp, /'pending_assignment'/)
assert.match(mzapp, /feedback_source, source_task_id, category_detail/)
assert.match(mzapp, /maintenance_runtime_schema_not_ready/)
assert.match(mzapp, /upsertMaintenanceWorkTask\(client, 'internal', row\)/)
assert.match(mzapp, /insertMaintenanceWorkflowEvent\(client, \{[\s\S]*domain: 'internal'/)
assert.match(mzapp, /pg_advisory_xact_lock\(hashtext\(\$1\)\)/)
assert.match(mzapp, /maintenance-feedback:\$\{String\(parsed\.data\.property_id\)\}:\$\{fingerprint\}/)
assert.match(mzapp, /createInternalMaintenanceFromFeedback\(\{[\s\S]*\}, client\)/)
assert.match(mzapp, /void notifyPropertyFeedbackCreated\(/)
assert.match(mzapp, /warmupMzappModule\(\)[\s\S]*ensurePropertyMaintenanceColumns\(\)[\s\S]*ensureNotificationStorage\(\)/)
assert.match(mzapp, /workflow_status/)
assert.match(mzapp, /maintenance_before_photo_urls/)
assert.match(mzapp, /maintenanceTaskSummaryFromDetails\(x\.summary\)/)
assert.match(mzapp, /eventType: 'feedback_completed'/)
assert.match(mzapp, /toStatus: 'pending_review'/)
assert.match(mzapp, /completion_photo_urls =/)
assert.match(mzapp, /function feedbackPhotoFallbacks[\s\S]*fallback\?\.completion_photo_urls/, 'historical feedback responses must expose saved executor completion photos')
assert.match(mzapp, /function feedbackAfterPhotos[\s\S]*row\.completion_photo_urls/, 'moving a maintenance feedback record must preserve saved executor completion photos')
assert.match(mzapp, /kind === 'maintenance' && normalizeMaintenanceWorkflowStatus\(row\.status, row\.review_status\) === 'cancelled'[\s\S]*maintenance_cancel_required/, 'cancelled maintenance must be rejected by the server even for managers')
assert.match(mzapp, /resolveInternalMaintenanceFeedbackOrigin\(user, String\(row\.property_id \|\| ''\)\.trim\(\), row\.source_task_id\)/)
assert.match(mzapp, /'pending_review','review_pending','awaiting_review','completed','done','ready'/)
assert.match(mzapp, /existingOpenMaintenanceProject/)
assert.match(mzapp, /candidate\.status !== 'completed'/)
assert.match(mzapp, /async function loadPropertyFeedbackRow\(kind: FeedbackKind, id: string, client: any = pgPool, lockForUpdate = false\)/, 'project mutations must read through their transaction client')
assert.match(mzapp, /const lockClause = lockForUpdate \? ' FOR UPDATE' : ''/, 'project mutations must be able to lock the feedback row')
assert.match(mzapp, /router\.post\('\/property-feedbacks\/:kind\/:id\/projects'[\s\S]*pgRunInTransaction\(async \(client\)[\s\S]*loadPropertyFeedbackRow\(kind, id, client, true\)/, 'project creation must serialize against the feedback row')
assert.match(mzapp, /router\.post\('\/property-feedbacks\/:kind\/:id\/projects\/:projectId\/complete'[\s\S]*pgRunInTransaction\(async \(client\)[\s\S]*loadPropertyFeedbackRow\(kind, id, client, true\)/, 'project completion must serialize against the feedback row')
assert.match(crud, /assignee_name: assigneeName/)
assert.match(workflowStore, /MAINTENANCE_WORK_TASK_SOURCE_TYPES/)
assert.match(workflowStore, /ON CONFLICT \(source_type, source_id\)/)
assert.match(workflowStore, /EXCLUDED\.status, ''\)\)='todo' AND EXCLUDED\.assignee_id IS NULL THEN NULL[\s\S]*COALESCE\(EXCLUDED\.scheduled_date, work_tasks\.scheduled_date\)/, 'an unassigned pending projection must not retain the previous assignment schedule')
assert.match(workflowStore, /completion_photo_urls=EXCLUDED\.completion_photo_urls/)
assert.match(workflowStore, /completion_note=EXCLUDED\.completion_note/)
assert.match(workflowStore, /completion_reason=EXCLUDED\.completion_reason/)
assert.match(workflowStore, /work_tasks\.status, ''\)\)='pending_review'[\s\S]*EXCLUDED\.status, ''\)\)='assigned'/)
assert.match(maintenanceRouter, /action === 'executor_unfinished'[\s\S]*completion_reason: reason/, 'unfinished executor actions must project their reason')
assert.match(taskCenter, /NULLIF\(BTRIM\(m\.assignee_id::text\), ''\) AS source_assignee_id/)
assert.match(taskCenter, /m\.review_status::text, ''\)\) IN \('approved', 'closed'\) THEN 'done'/)
assert.match(taskCenter, /'pending_review', 'review_pending', 'awaiting_review', 'completed', 'done', 'ready'\) THEN 'pending_review'/)
assert.match(taskCenter, /WHEN p\.source_type = 'property_maintenance' THEN p\.source_task_status/)
assert.match(taskCenter, /WHEN work_tasks\.source_type = 'property_maintenance' THEN EXCLUDED\.status/)
assert.match(taskCenter, /maintenanceWorkAssignments/)
assert.match(taskCenter, /maintenanceAssignedUserIds/)
assert.match(taskCenter, /UPDATE property_maintenance[\s\S]*assignee_id=\$2/)
assert.match(taskCenter, /upsertMaintenanceWorkTask\(client, 'internal', updated\)/)
assert.match(taskCenter, /maintenance_unassign_not_supported/)
assert.match(cleaning, /maintenanceExecutorScope = staffScope === 'maintenance_executor'/)
assert.match(cleaning, /if \(maintenanceExecutorScope\) \{[\s\S]*out\.push\(\{ \.\.\.base, kind: 'executor' \}\)/)
assert.match(taskCenterPage, /\/cleaning\/staff\?scope=maintenance_executor/)
assert.match(taskCenterPage, /task\.source_type === 'property_maintenance' \? maintenanceStaffOptions : allStaffOptions/)
assert.match(publicRouter, /maintenance_feedback_workflow_required/)
assert.match(publicRouter, /maintenance_mzstay_workflow_required/)
assert.match(cleaningApp, /JOIN properties p ON p\.id::text = m\.property_id::text/)
assert.match(cleaningApp, /m\.deleted_at IS NULL/)
assert.match(cleaningApp, /canViewMzappPropertyFeedback\(user, feedbackMediaRow, userId\)/)

console.log('maintenance workflow actions: PASS')
