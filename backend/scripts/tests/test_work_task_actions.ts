import assert from 'assert'
import { cleaningTaskExecutionSemantics, normalizeTaskExecutionSemantics } from '../../src/lib/cleaningInspection'
import { buildWebTaskManagementPayload, buildWorkTaskActionPayload } from '../../src/lib/workTaskActions'
import { resolveCleaningTaskActionStatus } from '../../src/lib/workTaskActionAudit'

const allExecPerms = [
  'cleaning_app.tasks.start',
  'cleaning_app.tasks.finish',
  'cleaning_app.inspect.finish',
  'cleaning_app.media.upload',
  'cleaning_app.issues.report',
]

function actionById(payload: ReturnType<typeof buildWorkTaskActionPayload>, id: string) {
  return payload.available_actions.find((action) => action.id === id)
}

function webActionById(payload: ReturnType<typeof buildWebTaskManagementPayload>, id: string) {
  return payload.management_actions.find((action) => action.id === id)
}

function main() {
  assert.equal(normalizeTaskExecutionSemantics('key_handover_execution'), 'key_or_password_action')
  assert.equal(cleaningTaskExecutionSemantics({ roleKind: 'execution', taskType: 'checkin_clean', inspectionScope: 'password_only' }), 'key_or_password_action')

  const passwordOnlyWebActions = buildWebTaskManagementPayload({
    source: 'cleaning',
    requiresCleaner: false,
    isPasswordOnly: true,
    canConfigureInspection: true,
    pureCheckin: true,
    deferredInspection: false,
    inspectionMode: 'same_day',
    autoSyncLocked: false,
  }, { canManageSchedule: true })
  assert.equal(webActionById(passwordOnlyWebActions, 'assign_executor')?.enabled, true)
  assert.equal(webActionById(passwordOnlyWebActions, 'assign_inspector')?.enabled, false)
  assert.equal(passwordOnlyWebActions.editable_fields.assignee_id.enabled, true)
  assert.equal(passwordOnlyWebActions.editable_fields.inspector_id.disabled_reason, 'not_applicable')

  const lockedWebActions = buildWebTaskManagementPayload({
    source: 'cleaning',
    requiresCleaner: true,
    isPasswordOnly: false,
    canConfigureInspection: true,
    pureCheckin: false,
    deferredInspection: false,
    inspectionMode: 'pending_decision',
    autoSyncLocked: true,
  }, { canManageSchedule: true })
  assert.equal(webActionById(lockedWebActions, 'update_status')?.enabled, false)
  assert.equal(lockedWebActions.editable_fields.cleaner_id.disabled_reason, 'auto_sync_locked')

  const cleaningTask = {
    id: 'w-cleaning',
    source_type: 'cleaning_tasks',
    task_kind: 'cleaning',
    task_type: 'checkout_clean',
    status: 'assigned',
    assignee_id: 'cleaner-1',
    cleaner_id: 'cleaner-1',
    inspector_id: 'inspector-1',
    start_time: '10am',
  }

  const cleanerPayload = buildWorkTaskActionPayload(cleaningTask, {
    userId: 'cleaner-1',
    roleNames: ['cleaner'],
    permissions: allExecPerms,
    canViewAll: false,
  })
  assert.equal(actionById(cleanerPayload, 'upload_key_photo')?.enabled, true)
  assert.equal(actionById(cleanerPayload, 'fill_supplies')?.enabled, true)
  assert.equal(actionById(cleanerPayload, 'report_issue')?.enabled, true)

  const managerPayload = buildWorkTaskActionPayload(cleaningTask, {
    userId: 'admin-1',
    roleNames: ['admin'],
    permissions: allExecPerms,
    canViewAll: true,
  })
  assert.equal(managerPayload.capabilities.is_manager, true)
  assert.equal(managerPayload.capabilities.is_task_participant, false)
  assert.equal(actionById(managerPayload, 'upload_key_photo')?.enabled, false)
  assert.equal(actionById(managerPayload, 'upload_key_photo')?.disabled_reason, 'not_participant')
  assert.equal(actionById(managerPayload, 'mark_guest_checkout')?.enabled, true)

  const customerServicePayload = buildWorkTaskActionPayload(cleaningTask, {
    userId: 'cs-1',
    roleNames: ['customer_service'],
    permissions: ['cleaning_app.issues.report'],
    canViewAll: true,
  })
  assert.equal(customerServicePayload.capabilities.is_manager, true)
  assert.equal(actionById(customerServicePayload, 'mark_guest_checkout')?.enabled, true)
  assert.equal(actionById(customerServicePayload, 'report_issue')?.enabled, true)
  assert.equal(actionById(customerServicePayload, 'fill_supplies')?.disabled_reason, 'missing_base_permission')

  const offlineManagerPayload = buildWorkTaskActionPayload(cleaningTask, {
    userId: 'offline-manager-1',
    roleNames: ['offline_manager'],
    permissions: ['cleaning_app.tasks.finish', 'cleaning_app.media.upload', 'cleaning_app.issues.report'],
    canViewAll: true,
  })
  assert.equal(offlineManagerPayload.capabilities.is_manager, true)
  assert.equal(actionById(offlineManagerPayload, 'mark_guest_checkout')?.enabled, true)
  assert.equal(actionById(offlineManagerPayload, 'fill_supplies')?.disabled_reason, 'not_participant')

  const inspectionPayload = buildWorkTaskActionPayload({
    id: 'w-inspection',
    source_type: 'cleaning_tasks',
    task_kind: 'inspection',
    task_type: 'checkin_clean',
    inspection_scope: 'password_only',
    inspection_mode: 'same_day',
    status: 'assigned',
    assignee_id: 'inspector-1',
    inspector_id: 'inspector-1',
    end_time: '3pm',
  }, {
    userId: 'inspector-1',
    roleNames: ['cleaning_inspector'],
    permissions: ['cleaning_app.tasks.finish', 'cleaning_app.media.upload', 'cleaning_app.issues.report'],
    canViewAll: false,
  })
  assert.equal(actionById(inspectionPayload, 'submit_inspection')?.enabled, true)
  assert.equal(actionById(inspectionPayload, 'submit_inspection')?.label, '查看说明')
  assert.equal(actionById(inspectionPayload, 'upload_access_video')?.intent, 'site_action')
  assert.equal(actionById(inspectionPayload, 'upload_access_video')?.target, 'InspectionComplete')

  const checkinSiteExecutionPayload = buildWorkTaskActionPayload({
    id: 'w-checkin-site-execution',
    source_type: 'cleaning_tasks',
    source_id: 'cleaning-task-checkin-site',
    task_kind: 'inspection',
    task_type: 'checkin_clean',
    inspection_scope: 'inspect_and_hang',
    inspection_mode: 'same_day',
    status: 'assigned',
    assignee_id: 'cleaner-site-1',
    inspector_id: null,
  }, {
    userId: 'cleaner-site-1',
    roleNames: ['cleaner'],
    permissions: allExecPerms,
    canViewAll: false,
  })
  assert.equal(actionById(checkinSiteExecutionPayload, 'submit_inspection')?.enabled, true)
  assert.equal(actionById(checkinSiteExecutionPayload, 'submit_inspection')?.label, '入住检查')
  assert.equal(actionById(checkinSiteExecutionPayload, 'submit_inspection')?.source_id, 'cleaning-task-checkin-site')
  assert.equal(actionById(checkinSiteExecutionPayload, 'upload_access_video')?.enabled, true)
  assert.equal(actionById(checkinSiteExecutionPayload, 'upload_access_video')?.label, '挂钥匙并完成')
  assert.equal(actionById(checkinSiteExecutionPayload, 'upload_access_video')?.intent, 'site_action')
  assert.equal(actionById(checkinSiteExecutionPayload, 'upload_access_video')?.source_id, 'cleaning-task-checkin-site')

  const cleanerSiteActionPayload = buildWorkTaskActionPayload({
    id: 'w-site-action',
    source_type: 'cleaning_tasks',
    source_id: 'cleaning-task-2',
    task_kind: 'execution',
    task_type: 'checkin_clean',
    inspection_scope: 'password_only',
    status: 'assigned',
    assignee_id: 'inspector-2',
    participants: [
      {
        user_id: 'cleaner-2',
        participant_role: 'collaborator',
        action_ids: ['upload_access_video'],
        source_relation: 'manual',
      },
    ],
  }, {
    userId: 'cleaner-2',
    roleNames: ['cleaner'],
    permissions: allExecPerms,
    canViewAll: false,
  })
  assert.equal(cleanerSiteActionPayload.capabilities.is_task_participant, true)
  assert.deepEqual(cleanerSiteActionPayload.capabilities.participant_actions, ['upload_access_video'])
  assert.equal(actionById(cleanerSiteActionPayload, 'upload_access_video')?.enabled, true)
  assert.equal(actionById(cleanerSiteActionPayload, 'upload_access_video')?.intent, 'site_action')
  assert.equal(actionById(cleanerSiteActionPayload, 'upload_access_video')?.source_id, 'cleaning-task-2')

  const adminInspectionParticipantPayload = buildWorkTaskActionPayload({
    id: 'w-admin-inspection',
    source_type: 'cleaning_tasks',
    source_id: 'cleaning-task-3',
    task_kind: 'inspection',
    task_type: 'checkout_clean',
    status: 'assigned',
    inspector_id: 'inspector-3',
    participants: [
      {
        user_id: 'admin-2',
        participant_role: 'collaborator',
        action_ids: ['submit_inspection'],
        source_relation: 'manual',
      },
    ],
  }, {
    userId: 'admin-2',
    roleNames: ['admin'],
    permissions: allExecPerms,
    canViewAll: true,
  })
  assert.equal(adminInspectionParticipantPayload.capabilities.is_manager, true)
  assert.equal(actionById(adminInspectionParticipantPayload, 'submit_inspection')?.enabled, true)
  assert.equal(actionById(adminInspectionParticipantPayload, 'upload_access_video')?.disabled_reason, 'not_participant')

  const adminInspectionViewerPayload = buildWorkTaskActionPayload({
    id: 'w-admin-view-only-inspection',
    source_type: 'cleaning_tasks',
    source_id: 'cleaning-task-4',
    task_kind: 'inspection',
    task_type: 'checkout_clean',
    status: 'assigned',
    inspector_id: 'inspector-4',
  }, {
    userId: 'admin-3',
    roleNames: ['admin'],
    permissions: allExecPerms,
    canViewAll: true,
  })
  assert.equal(adminInspectionViewerPayload.capabilities.is_manager, true)
  assert.equal(adminInspectionViewerPayload.capabilities.is_task_participant, false)
  assert.equal(actionById(adminInspectionViewerPayload, 'submit_inspection')?.enabled, false)
  assert.equal(actionById(adminInspectionViewerPayload, 'submit_inspection')?.disabled_reason, 'not_participant')

  const nonParticipantInspectionPayload = buildWorkTaskActionPayload({
    id: 'w-non-participant',
    source_type: 'cleaning_tasks',
    task_kind: 'inspection',
    task_type: 'checkout_clean',
    status: 'assigned',
    inspector_id: 'inspector-4',
    participants: [
      {
        user_id: 'inspector-4',
        participant_role: 'inspector',
        action_ids: ['submit_inspection', 'upload_access_video'],
        source_relation: 'legacy',
      },
    ],
  }, {
    userId: 'inspector-5',
    roleNames: ['cleaning_inspector'],
    permissions: allExecPerms,
    canViewAll: false,
  })
  assert.equal(actionById(nonParticipantInspectionPayload, 'submit_inspection')?.enabled, false)
  assert.equal(actionById(nonParticipantInspectionPayload, 'submit_inspection')?.disabled_reason, 'not_participant')

  const completedPayload = buildWorkTaskActionPayload({
    ...cleaningTask,
    status: 'done',
    key_photo_url: 'https://example.test/key.jpg',
  }, {
    userId: 'cleaner-1',
    roleNames: ['cleaner'],
    permissions: allExecPerms,
    canViewAll: false,
  })
  assert.equal(actionById(completedPayload, 'upload_key_photo')?.enabled, false)
  assert.equal(actionById(completedPayload, 'upload_key_photo')?.disabled_reason, 'task_completed')

  const keysHungPayload = buildWorkTaskActionPayload({
    id: 'w-keys-hung',
    source_type: 'cleaning_tasks',
    task_kind: 'execution',
    task_type: 'checkin_clean',
    inspection_scope: 'password_only',
    status: 'keys_hung',
    participants: [
      {
        user_id: 'cleaner-2',
        participant_role: 'collaborator',
        action_ids: ['upload_access_video'],
        source_relation: 'manual',
      },
    ],
  }, {
    userId: 'cleaner-2',
    roleNames: ['cleaner'],
    permissions: allExecPerms,
    canViewAll: false,
  })
  assert.equal(actionById(keysHungPayload, 'upload_access_video')?.enabled, false)
  assert.equal(actionById(keysHungPayload, 'upload_access_video')?.disabled_reason, 'task_completed')

  assert.equal(resolveCleaningTaskActionStatus({ actionId: 'upload_key_photo', statusBefore: 'assigned' }), 'in_progress')
  assert.equal(resolveCleaningTaskActionStatus({ actionId: 'fill_supplies', statusBefore: 'in_progress', needsRestock: false }), 'cleaned')
  assert.equal(resolveCleaningTaskActionStatus({ actionId: 'fill_supplies', statusBefore: 'in_progress', needsRestock: true }), 'restock_pending')
  assert.equal(resolveCleaningTaskActionStatus({ actionId: 'complete_cleaning', statusBefore: 'in_progress', isStayover: true }), 'cleaned')
  assert.equal(resolveCleaningTaskActionStatus({ actionId: 'upload_access_video', statusBefore: 'assigned' }), 'keys_hung')
  assert.equal(resolveCleaningTaskActionStatus({ actionId: 'submit_inspection', statusBefore: 'to_inspect' }), 'inspected')

  process.stdout.write('test_work_task_actions: ok\n')
}

main()
