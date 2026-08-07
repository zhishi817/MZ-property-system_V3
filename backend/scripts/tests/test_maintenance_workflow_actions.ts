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
  validateMaintenanceWorkflowAction({ action: 'executor_complete', status: 'assigned', isManager: false, isAssignedExecutor: true, completionPhotoCount: 1 }),
  { ok: true },
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

assert.match(maintenanceRouter, /SELECT \* FROM \$\{workflowTable\(domain\)\} WHERE id=\$1 FOR UPDATE/)
assert.match(maintenanceRouter, /record_patch/)
assert.match(maintenanceRouter, /operation_id/)
assert.match(maintenanceRouter, /saveIdempotentStepReceipt\(client, receiptScope/)
assert.match(maintenanceRouter, /upsertMaintenanceWorkTask\(client, domain, updated\)/)
assert.match(workflowStore, /maintenance_workflow_events/)
assert.match(workflowStore, /maintenanceTaskSummaryFromDetails/)
assert.match(maintenanceRouter, /completion_photo_urls/)
assert.match(maintenanceRouter, /executor_complete/)
assert.match(maintenanceRouter, /executor_unfinished/)
assert.match(maintenanceRouter, /external_maintenance_orders/)
assert.match(mzapp, /\['property_maintenance', 'external_maintenance_orders'\]\.includes\(String\(row\.source_type/)
// Maintenance actions are intentionally projected by the dedicated maintenance
// endpoint.  The work-task endpoint rejects its generic "mark" action for
// maintenance sources, so it must not depend on the retired work-task helper.
assert.match(maintenanceRouter, /function workflowResponse\(domain: MaintenanceDomain, row: any, user: any\)/)
assert.match(maintenanceRouter, /available_actions: availableMaintenanceActions/)
assert.match(crud, /maintenance_feedback_creation_required/)
assert.match(crud, /maintenance_cancel_required/)
assert.match(workTasks, /maintenance_workflow_action_required/)
assert.match(mzapp, /resolveInternalMaintenanceFeedbackOrigin/)
assert.match(mzapp, /maintenance_feedback_source_task_required/)
assert.match(mzapp, /maintenance_feedback_source_task_forbidden/)
assert.match(mzapp, /feedbackSource: 'manager_feedback'/)
assert.match(mzapp, /feedbackSource: isInspectorFeedback \? 'inspection_feedback' : 'cleaning_feedback'/)
assert.match(mzapp, /createInternalMaintenanceFromFeedback/)
assert.match(mzapp, /'pending_assignment'/)
assert.match(mzapp, /feedback_source, source_task_id, category_detail/)
assert.match(mzapp, /assertMaintenanceWorkflowSchemaReady\(pgPool\)/)
assert.match(mzapp, /upsertMaintenanceWorkTask\(client, 'internal', row\)/)
assert.match(mzapp, /insertMaintenanceWorkflowEvent\(client, \{[\s\S]*domain: 'internal'/)
assert.match(mzapp, /workflow_status/)
assert.match(mzapp, /maintenance_before_photo_urls/)
assert.match(mzapp, /maintenanceTaskSummaryFromDetails\(x\.summary\)/)
assert.match(mzapp, /eventType: 'feedback_completed'/)
assert.match(mzapp, /toStatus: 'pending_review'/)
assert.match(mzapp, /completion_photo_urls =/)
assert.match(mzapp, /resolveInternalMaintenanceFeedbackOrigin\(user, String\(row\.property_id \|\| ''\)\.trim\(\), row\.source_task_id\)/)
assert.match(mzapp, /'pending_review','review_pending','awaiting_review','completed','done','ready'/)
assert.match(mzapp, /existingOpenMaintenanceProject/)
assert.match(mzapp, /candidate\.status !== 'completed'/)
assert.match(crud, /assignee_name: assigneeName/)
assert.match(workflowStore, /MAINTENANCE_WORK_TASK_SOURCE_TYPES/)
assert.match(workflowStore, /ON CONFLICT \(source_type, source_id\)/)
assert.match(publicRouter, /maintenance_feedback_workflow_required/)
assert.match(publicRouter, /maintenance_mzstay_workflow_required/)
assert.match(cleaningApp, /JOIN properties p ON p\.id::text = m\.property_id::text/)
assert.match(cleaningApp, /m\.deleted_at IS NULL/)
assert.match(cleaningApp, /canViewMzappPropertyFeedback\(user, feedbackMediaRow, userId\)/)

console.log('maintenance workflow actions: PASS')
