import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  availableMaintenanceActions,
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

assert.match(maintenanceRouter, /SELECT \* FROM \$\{workflowTable\(domain\)\} WHERE id=\$1 FOR UPDATE/)
assert.match(maintenanceRouter, /record_patch/)
assert.match(maintenanceRouter, /operation_id/)
assert.match(maintenanceRouter, /saveIdempotentStepReceipt\(client, receiptScope/)
assert.match(maintenanceRouter, /ensureMaintenanceWorkTasksTable\(pgPool\)/)
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
assert.doesNotMatch(mzapp, /MAINTENANCE_WORK_TASK_SOURCE_TYPES/)
assert.match(crud, /maintenance_feedback_creation_required/)
assert.match(crud, /maintenance_cancel_required/)
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
assert.match(mzapp, /ensureMaintenanceWorkflowFoundation\(pool\)/)
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
assert.match(workflowStore, /scheduled_date=COALESCE\(EXCLUDED\.scheduled_date, work_tasks\.scheduled_date\)/)
assert.match(workflowStore, /completion_photo_urls=EXCLUDED\.completion_photo_urls/)
assert.match(workflowStore, /completion_note=EXCLUDED\.completion_note/)
assert.match(workflowStore, /completion_reason=EXCLUDED\.completion_reason/)
assert.match(maintenanceRouter, /action === 'executor_unfinished'[\s\S]*completion_reason: reason/, 'unfinished executor actions must project their reason')
assert.match(taskCenter, /NULLIF\(BTRIM\(m\.assignee_id::text\), ''\) AS source_assignee_id/)
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
