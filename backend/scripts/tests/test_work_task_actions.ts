import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { cleaningTaskExecutionSemantics, isSameInspectionRecordEvidence, normalizeTaskExecutionSemantics, projectInspectorTaskStatus, shouldKeepCheckoutInspectionActiveForKeyHandover } from '../../src/lib/cleaningInspection'
import { buildWebTaskManagementPayload, buildWorkTaskActionPayload } from '../../src/lib/workTaskActions'
import { buildKeyPhotoUploadEventPatch, buildKeyPhotoUploadTaskPatch, isCleaningAccessVideoWorkRecordStatus, keyPhotoUploadStatus, resolveCleaningTaskActionStatus } from '../../src/lib/workTaskActionAudit'

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
  const mzappSource = fs.readFileSync(path.resolve(__dirname, '../../src/modules/mzapp.ts'), 'utf8')
  const cleaningAppSourceForRecordGuards = fs.readFileSync(path.resolve(__dirname, '../../src/modules/cleaning_app.ts'), 'utf8')
  for (const [label, source, routeStart, routeEnd] of [
    ['MZapp', mzappSource, "router.post('/cleaning-tasks/:id/lockbox-video'", 'async function handleDeleteMzappLockboxVideo'],
    ['cleaning app', cleaningAppSourceForRecordGuards, "router.post('/tasks/:id/lockbox-video'", 'async function handleDeleteLockboxVideo'],
  ] as const) {
    const start = source.indexOf(routeStart)
    const end = source.indexOf(routeEnd, start)
    const route = source.slice(start, end)
    assert(start >= 0 && end > start, `${label} lockbox route must remain discoverable`)
    assert(route.indexOf('assertCleaningTaskRoleRecordMutable({') >= 0, `${label} lockbox route must reject immutable role records`)
    assert(
      route.indexOf('assertCleaningTaskRoleRecordMutable({') < route.indexOf("DELETE FROM cleaning_task_media"),
      `${label} lockbox route must reject immutable role records before replacing media`,
    )
  }
  const keyDeleteStart = cleaningAppSourceForRecordGuards.indexOf('async function handleDeleteKeyPhoto')
  const keyDeleteEnd = cleaningAppSourceForRecordGuards.indexOf("router.delete('/tasks/:id/key-photo'", keyDeleteStart)
  const keyDeleteRoute = cleaningAppSourceForRecordGuards.slice(keyDeleteStart, keyDeleteEnd)
  assert(keyDeleteStart >= 0 && keyDeleteEnd > keyDeleteStart, 'key-photo delete route must remain discoverable')
  assert(
    keyDeleteRoute.indexOf('assertCleaningTaskRoleRecordMutable({') < keyDeleteRoute.indexOf("DELETE FROM cleaning_task_media"),
    'key-photo deletion must reject immutable work records before deleting evidence',
  )
  const submissionProjectionStart = mzappSource.indexOf('const cleaningSubmissionReadyByTaskId')
  const submissionProjectionEnd = mzappSource.indexOf('const manualParticipantsByCleaningRef', submissionProjectionStart)
  const submissionProjection = mzappSource.slice(submissionProjectionStart, submissionProjectionEnd)
  assert(submissionProjection.includes("WHEN lower(COALESCE(t.task_type, t.type, '')) = 'checkin_clean' THEN true"), 'pure checkin task payload must mark the cleaning prerequisite as satisfied')
  const bulkGuestCheckoutStart = mzappSource.indexOf("router.post('/cleaning-tasks/guest-checked-out'")
  const bulkCheckoutTypeQueryStart = mzappSource.indexOf('const rTypes = await pgPool.query(', bulkGuestCheckoutStart)
  const bulkCheckoutTypeQueryEnd = mzappSource.indexOf('ids2 = await expandGuestCheckoutTaskIds(ids2)', bulkCheckoutTypeQueryStart)
  const bulkCheckoutTypeQuery = mzappSource.slice(bulkCheckoutTypeQueryStart, bulkCheckoutTypeQueryEnd)
  assert.match(bulkCheckoutTypeQuery, /COALESCE\(NULLIF\(task_type, ''\), NULLIF\(type, ''\)\)::text AS task_type/, 'bulk guest checkout must support legacy type values')
  assert.match(bulkCheckoutTypeQuery, /checkoutIds\.length !== ids\.length/, 'mixed checkin and checkout IDs must be rejected')
  assert.doesNotMatch(bulkCheckoutTypeQuery, /catch\s*\{\}/, 'a bulk checkout type lookup failure must propagate to the fail-closed route error response')

  assert.equal(normalizeTaskExecutionSemantics('key_handover_execution'), 'key_or_password_action')
  assert.equal(cleaningTaskExecutionSemantics({ roleKind: 'execution', taskType: 'checkin_clean', inspectionScope: 'password_only' }), 'key_or_password_action')
  assert.equal(projectInspectorTaskStatus('inspected', 'inspect_and_hang'), 'to_hang_keys')
  assert.equal(projectInspectorTaskStatus('inspected', 'password_only'), 'done')

  const checkoutOnlyPendingHandover = {
    taskType: 'checkout_clean',
    status: 'inspected',
    inspectionScope: null,
    executionState: 'active',
    sourceKeyHandoverCompleted: false,
    currentInspectorId: 'inspector-a',
    inspectionRecordActorUserId: 'inspector-a',
    inspectionRecordAt: '2026-10-26T03:01:17.000Z',
    inspectionRecordDate: '2026-10-26',
    displayDate: '2026-10-26',
    hasRelatedInspectionArrangement: false,
  }
  assert.equal(shouldKeepCheckoutInspectionActiveForKeyHandover(checkoutOnlyPendingHandover), true)
  assert.equal(shouldKeepCheckoutInspectionActiveForKeyHandover({ ...checkoutOnlyPendingHandover, status: 'to_hang_keys' }), true)
  assert.equal(shouldKeepCheckoutInspectionActiveForKeyHandover({ ...checkoutOnlyPendingHandover, inspectionScope: 'password_only' }), false)
  assert.equal(shouldKeepCheckoutInspectionActiveForKeyHandover({ ...checkoutOnlyPendingHandover, sourceKeyHandoverCompleted: true }), false)
  assert.equal(shouldKeepCheckoutInspectionActiveForKeyHandover({ ...checkoutOnlyPendingHandover, currentInspectorId: null }), false)
  assert.equal(shouldKeepCheckoutInspectionActiveForKeyHandover({ ...checkoutOnlyPendingHandover, inspectionRecordActorUserId: 'inspector-b' }), false)
  assert.equal(shouldKeepCheckoutInspectionActiveForKeyHandover({ ...checkoutOnlyPendingHandover, inspectionRecordDate: '2026-10-27' }), false)
  assert.equal(shouldKeepCheckoutInspectionActiveForKeyHandover({ ...checkoutOnlyPendingHandover, executionState: 'cancelled' }), false)
  assert.equal(shouldKeepCheckoutInspectionActiveForKeyHandover({ ...checkoutOnlyPendingHandover, hasRelatedInspectionArrangement: true }), false)
  assert.equal(shouldKeepCheckoutInspectionActiveForKeyHandover({ ...checkoutOnlyPendingHandover, taskType: 'checkin_clean' }), false)

  const embeddedInspectionEvidence = {
    performedAt: '2026-10-26T03:01:17.000Z',
    recordDate: '2026-10-26',
    actorUserId: 'inspector-a',
  }
  assert.equal(isSameInspectionRecordEvidence(embeddedInspectionEvidence, embeddedInspectionEvidence), true)
  assert.equal(isSameInspectionRecordEvidence({ ...embeddedInspectionEvidence, performedAt: '2026-10-26T14:01:17+11:00' }, embeddedInspectionEvidence), true)
  assert.equal(isSameInspectionRecordEvidence({ ...embeddedInspectionEvidence, actorUserId: 'inspector-b' }, embeddedInspectionEvidence), false)
  assert.equal(isSameInspectionRecordEvidence({ ...embeddedInspectionEvidence, recordDate: '2026-10-25' }, embeddedInspectionEvidence), false)
  assert.equal(isSameInspectionRecordEvidence({ ...embeddedInspectionEvidence, performedAt: '2026-10-26T03:00:00.000Z' }, embeddedInspectionEvidence), false)

  assert.match(mzappSource, /const inspectorTerminal = isInspectionFinishedStatus\(raw_status\)[\s\S]*?&& !checkoutInspectionAwaitingKeyHandover/, 'exact checkout inspection handover must remain active after photo submission')
  assert.match(mzappSource, /inspectorRoleRecordEvidence\.filter\(\(evidence\) => !isSameInspectionRecordEvidence/, 'only the exact embedded inspection record may be suppressed from standalone history')
  assert.match(mzappSource, /__embedded_inspection_record_at: effectiveInspectorRecordAt/, 'the active checkout card must retain the exact inspection phase timestamp')

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
  assert.equal(actionById(managerPayload, 'upload_key_photo'), undefined)
  assert.equal(actionById(managerPayload, 'fill_supplies'), undefined)
  assert.equal(actionById(managerPayload, 'mark_guest_checkout')?.enabled, true)
  assert.equal(actionById(managerPayload, 'report_issue')?.label, '问题反馈')
  assert.deepEqual(managerPayload.available_actions.map((action) => action.id), ['mark_guest_checkout', 'report_issue'])

  const customerServicePayload = buildWorkTaskActionPayload(cleaningTask, {
    userId: 'cs-1',
    roleNames: ['customer_service'],
    permissions: ['cleaning_app.issues.report'],
    canViewAll: true,
  })
  assert.equal(customerServicePayload.capabilities.is_manager, true)
  assert.equal(actionById(customerServicePayload, 'mark_guest_checkout')?.enabled, true)
  assert.equal(actionById(customerServicePayload, 'report_issue')?.enabled, true)
  assert.deepEqual(customerServicePayload.available_actions.map((action) => action.id), ['mark_guest_checkout', 'report_issue'])
  assert.equal(actionById(customerServicePayload, 'mark_guest_checkout')?.label, '标记已退房')
  assert.equal(actionById(customerServicePayload, 'report_issue')?.label, '问题反馈')
  assert.equal(actionById(customerServicePayload, 'report_issue')?.placement, 'primary')

  const customerServiceInspectionPayload = buildWorkTaskActionPayload({
    ...cleaningTask,
    id: 'w-cs-inspection',
    task_kind: 'inspection',
    task_type: 'checkin_clean',
    inspection_scope: 'password_only',
  }, {
    userId: 'cs-1',
    roleNames: ['customer_service'],
    permissions: ['cleaning_app.issues.report'],
    canViewAll: true,
  })
  assert.deepEqual(customerServiceInspectionPayload.available_actions.map((action) => action.id), ['report_issue'])
  assert.equal(actionById(customerServiceInspectionPayload, 'mark_guest_checkout'), undefined)
  assert.equal(actionById(customerServiceInspectionPayload, 'submit_inspection'), undefined)
  assert.equal(actionById(customerServiceInspectionPayload, 'upload_access_video'), undefined)

  const managerCheckinPayload = buildWorkTaskActionPayload({
    ...cleaningTask,
    id: 'w-manager-checkin',
    task_kind: 'inspection',
    task_type: 'checkin_clean',
    inspection_scope: 'inspect_and_hang',
    order_id: 'order-checkin-1',
    start_time: '3pm',
  }, {
    userId: 'admin-1',
    roleNames: ['admin'],
    permissions: allExecPerms,
    canViewAll: true,
  })
  assert.equal(actionById(managerCheckinPayload, 'mark_guest_checkout'), undefined, 'an order-linked checkin task must never expose a guest checkout action')

  const offlineManagerPayload = buildWorkTaskActionPayload(cleaningTask, {
    userId: 'offline-manager-1',
    roleNames: ['offline_manager'],
    permissions: ['cleaning_app.tasks.finish', 'cleaning_app.media.upload', 'cleaning_app.issues.report'],
    canViewAll: true,
  })
  assert.equal(offlineManagerPayload.capabilities.is_manager, true)
  assert.equal(actionById(offlineManagerPayload, 'mark_guest_checkout')?.enabled, true)
  assert.equal(actionById(offlineManagerPayload, 'fill_supplies'), undefined)
  assert.deepEqual(offlineManagerPayload.available_actions.map((action) => action.id), ['mark_guest_checkout', 'report_issue'])

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
  assert.equal(actionById(inspectionPayload, 'submit_inspection'), undefined)
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
  assert.equal(actionById(adminInspectionParticipantPayload, 'upload_access_video'), undefined)

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
  assert.equal(actionById(adminInspectionViewerPayload, 'submit_inspection'), undefined)
  assert.equal(actionById(adminInspectionViewerPayload, 'mark_guest_checkout')?.enabled, true)
  assert.equal(actionById(adminInspectionViewerPayload, 'report_issue')?.label, '问题反馈')

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

  const completedGenericWorkTaskPayload = buildWorkTaskActionPayload({
    id: 'w-completed-offline-task',
    source_type: 'cleaning_offline_tasks',
    source_id: 'offline-source-1',
    task_kind: 'offline',
    status: 'done',
    assignee_id: 'cleaner-1',
  }, {
    userId: 'cleaner-1',
    roleNames: ['cleaner'],
    permissions: [],
    canViewAll: false,
  })
  assert.equal(actionById(completedGenericWorkTaskPayload, 'append_completion_photo')?.enabled, true)
  assert.equal(actionById(completedGenericWorkTaskPayload, 'append_completion_photo')?.target, 'TaskDetail')
  assert.equal(actionById(completedGenericWorkTaskPayload, 'append_completion_photo')?.intent, 'completion')

  const completedGenericWorkTaskViewerPayload = buildWorkTaskActionPayload({
    id: 'w-completed-offline-viewer',
    source_type: 'cleaning_offline_tasks',
    source_id: 'offline-source-2',
    task_kind: 'offline',
    status: 'done',
    assignee_id: 'cleaner-1',
  }, {
    userId: 'cleaner-2',
    roleNames: ['cleaner'],
    permissions: [],
    canViewAll: false,
  })
  assert.equal(actionById(completedGenericWorkTaskViewerPayload, 'append_completion_photo')?.enabled, false)
  assert.equal(actionById(completedGenericWorkTaskViewerPayload, 'append_completion_photo')?.disabled_reason, 'not_participant')

  const completedMaintenancePayload = buildWorkTaskActionPayload({
    id: 'w-completed-maintenance',
    source_type: 'property_maintenance',
    source_id: 'maintenance-source-1',
    task_kind: 'maintenance',
    status: 'done',
    assignee_id: 'cleaner-1',
  }, {
    userId: 'cleaner-1',
    roleNames: ['cleaner'],
    permissions: [],
    canViewAll: false,
  })
  assert.equal(actionById(completedMaintenancePayload, 'append_completion_photo'), undefined)
  const completedUnmappedPayload = buildWorkTaskActionPayload({
    id: 'w-completed-unmapped',
    source_type: 'property_daily_necessities',
    source_id: 'daily-source-1',
    task_kind: 'daily_necessities',
    status: 'done',
    assignee_id: 'cleaner-1',
  }, {
    userId: 'cleaner-1',
    roleNames: ['cleaner'],
    permissions: [],
    canViewAll: false,
  })
  assert.equal(actionById(completedUnmappedPayload, 'append_completion_photo'), undefined, 'unmapped task media sources must not expose an offline completion-photo action')
  assert(mzappSource.includes("router.post('/work-tasks/:id/completion-photos'"), 'completed task photo append route must exist')
  assert(mzappSource.includes("code: 'task_not_completed'"), 'completed task photo append route must reject non-terminal tasks')
  assert(mzappSource.includes("code: 'maintenance_workflow_action_required'"), 'maintenance must keep its dedicated completion workflow')
  assert(mzappSource.includes("code: 'completion_photo_action_not_supported'"), 'unmapped task sources must not write an offline completion-photo association')
  const appendRouteSource = mzappSource.slice(
    mzappSource.indexOf("router.post('/work-tasks/:id/completion-photos'"),
    mzappSource.indexOf('const workTaskReorderSchema'),
  )
  assert(appendRouteSource.includes("code: 'work_record_read_only'"), 'completed work records must reject post-completion media mutation')
  assert(!appendRouteSource.includes('UPDATE work_tasks'), 'completed work-record media must remain immutable')

  const selfCompleteRecoveryPayload = buildWorkTaskActionPayload({
    ...cleaningTask,
    id: 'w-self-complete-keys-hung',
    inspection_mode: 'self_complete',
    status: 'keys_hung',
    completion_photos_ok: false,
  }, {
    userId: 'cleaner-1',
    roleNames: ['cleaner'],
    permissions: allExecPerms,
    canViewAll: false,
  })
  assert.equal(actionById(selfCompleteRecoveryPayload, 'complete_cleaning')?.enabled, true)
  assert.equal(actionById(selfCompleteRecoveryPayload, 'complete_cleaning')?.label, '继续自完成')
  assert.equal(actionById(selfCompleteRecoveryPayload, 'complete_cleaning')?.read_only, undefined)

  const selfCompleteReadOnlyPayload = buildWorkTaskActionPayload({
    ...cleaningTask,
    id: 'w-self-complete-cleaned',
    inspection_mode: 'self_complete',
    status: 'cleaned',
    completion_photos_ok: true,
    source_key_handover_completed: true,
  }, {
    userId: 'cleaner-1',
    roleNames: ['cleaner'],
    permissions: allExecPerms,
    canViewAll: false,
  })
  assert.equal(actionById(selfCompleteReadOnlyPayload, 'complete_cleaning')?.enabled, false)
  assert.equal(actionById(selfCompleteReadOnlyPayload, 'complete_cleaning')?.disabled_reason, 'task_completed')
  assert.equal(actionById(selfCompleteReadOnlyPayload, 'complete_cleaning')?.label, '查看完成照片')
  assert.equal(actionById(selfCompleteReadOnlyPayload, 'complete_cleaning')?.read_only, true)
  assert.equal(actionById(selfCompleteReadOnlyPayload, 'upload_access_video')?.enabled, false)

  const selfCompleteAwaitingHandoverPayload = buildWorkTaskActionPayload({
    ...cleaningTask,
    id: 'w-self-complete-awaiting-handover',
    inspection_mode: 'self_complete',
    status: 'cleaned',
    cleaning_submission_ready: true,
    completion_photos_ok: true,
    consumables_recorded: true,
    source_key_handover_completed: false,
  }, {
    userId: 'cleaner-1',
    roleNames: ['cleaner'],
    permissions: allExecPerms,
    canViewAll: false,
  })
  assert.equal(actionById(selfCompleteAwaitingHandoverPayload, 'upload_access_video')?.enabled, true)
  assert.equal(actionById(selfCompleteAwaitingHandoverPayload, 'upload_access_video')?.label, '挂钥匙并完成')
  assert.equal(actionById(selfCompleteAwaitingHandoverPayload, 'complete_cleaning')?.enabled, false)
  assert.equal(actionById(selfCompleteAwaitingHandoverPayload, 'complete_cleaning')?.label, '查看完成照片')
  assert.equal(actionById(selfCompleteAwaitingHandoverPayload, 'complete_cleaning')?.read_only, true)
  assert.equal(actionById(selfCompleteAwaitingHandoverPayload, 'fill_supplies')?.read_only, true)
  assert.equal(actionById(selfCompleteAwaitingHandoverPayload, 'fill_supplies')?.disabled_reason, 'task_completed')
  assert.equal(actionById(selfCompleteAwaitingHandoverPayload, 'report_issue')?.enabled, true)

  const selfCompleteExceptionReadOnlyPayload = buildWorkTaskActionPayload({
    ...cleaningTask,
    id: 'w-self-complete-photo-exception',
    inspection_mode: 'self_complete',
    status: 'cleaned',
    completion_photos_ok: false,
    source_key_handover_completed: true,
    completion_photo_exception: {
      items: [{ area: 'living', reason: 'network_pending', media_id: 'media-living', captured_at: '2026-08-01T01:00:00.000Z' }],
    },
  }, {
    userId: 'cleaner-1',
    roleNames: ['cleaner'],
    permissions: allExecPerms,
    canViewAll: false,
  })
  assert.equal(actionById(selfCompleteExceptionReadOnlyPayload, 'complete_cleaning')?.label, '查看完成照片')
  assert.equal(actionById(selfCompleteExceptionReadOnlyPayload, 'complete_cleaning')?.read_only, true)
  assert(mzappSource.includes('completion_photo_exception'), 'work-task projection must expose a validated self-complete photo exception')
  assert(mzappSource.includes("isSelfCompleteFinalized\n                    ? 'done'"), 'finalized self-complete must take precedence over lockbox-only projection')
  assert.match(mzappSource, /selfCompleteAwaitingOwnKeyHandover[\s\S]*?const cleanerTerminal[\s\S]*?!selfCompleteAwaitingOwnKeyHandover/, 'self-complete cleaner card must stay active before exact-source key handover')
  assert.match(mzappSource, /const recordEvidence = selfCompleteAwaitingOwnKeyHandover \? \[\]/, 'premature supplies evidence must not create a duplicate history card before key handover')
  assert.match(mzappSource, /has_current_manual_key_handover/, 'exact-source manual key handover must be projected independently of the current viewer')
  assert.match(mzappSource, /current_manual_key_handover_at[\s\S]*?manualConfirmedAt: row\.current_manual_key_handover_at \|\| null/, 'manager-confirmed handover timestamp must remain visible as a task fact without exposing the actor')
  assert.match(mzappSource, /const sourceKeyHandoverCompleted = row\.has_current_lockbox_video === true[\s\S]*?row\.has_current_manual_key_handover === true/, 'exact-source handover completion must not depend on uploader or event actor visibility')
  assert.match(mzappSource, /const sourceKeyHandoverCompleted = p\.a\?\.__source_key_handover_completed === true/, 'self-complete finalization must use the exact primary source task handover fact')
  assert.match(mzappSource, /__source_key_handover: sourceKeyHandover/, 'base projection must retain the exact-source handover independently of canonical fallback')
  assert.match(mzappSource, /__source_lockbox_video_url: row\.lockbox_video_url \|\| null/, 'base projection must retain the exact-source video independently of same-day fallback')
  assert.match(mzappSource, /requireSelfComplete \? \(p\.a\?\.__source_key_handover \|\| null\) : keyHandover/, 'self-complete handover must use the exact-source projection')
  assert.match(mzappSource, /requireSelfComplete \? \(p\.a\?\.__source_lockbox_video_url \|\| null\) : lockboxVideoUrl/, 'self-complete video playback must never fall back to a related turnover source')
  const cleaningAppSource = fs.readFileSync(path.resolve(__dirname, '../../src/modules/cleaning_app.ts'), 'utf8')
  assert(cleaningAppSource.includes('normalizedSelfCompletePhotoException(parsed.data.completion_photo_exception, missingAreas)'), 'self-complete route must validate exception evidence against every missing photo area')

  const deletedKeyAfterCleaningPayload = buildWorkTaskActionPayload({
    ...cleaningTask,
    id: 'w-deleted-key-after-cleaning',
    status: 'done',
    cleaning_submission_ready: false,
    key_photo_url: null,
  }, {
    userId: 'cleaner-1',
    roleNames: ['cleaner'],
    permissions: allExecPerms,
    canViewAll: false,
  })
  assert.equal(actionById(deletedKeyAfterCleaningPayload, 'upload_key_photo')?.enabled, true)
  assert.equal(actionById(deletedKeyAfterCleaningPayload, 'upload_key_photo')?.disabled_reason, undefined)

  const toInspectPayload = buildWorkTaskActionPayload({
    id: 'w-to-inspect',
    source_type: 'cleaning_tasks',
    source_id: 'cleaning-task-to-inspect',
    task_kind: 'inspection',
    task_type: 'checkout_clean',
    status: 'to_inspect',
    inspector_id: 'inspector-to-inspect',
  }, {
    userId: 'inspector-to-inspect',
    roleNames: ['cleaning_inspector'],
    permissions: allExecPerms,
    canViewAll: false,
  })
  assert.equal(actionById(toInspectPayload, 'submit_inspection')?.enabled, true)
  assert.equal(actionById(toInspectPayload, 'submit_inspection')?.disabled_reason, undefined)
  assert.equal(actionById(toInspectPayload, 'upload_access_video')?.enabled, true)
  assert.equal(actionById(toInspectPayload, 'upload_access_video')?.disabled_reason, undefined)

  const inspectionBeforeCleaningPayload = buildWorkTaskActionPayload({
    id: 'w-inspection-before-cleaning',
    source_type: 'cleaning_tasks',
    task_kind: 'inspection',
    task_type: 'checkout_clean',
    status: 'to_inspect',
    inspector_id: 'inspector-to-inspect',
    cleaning_submission_ready: false,
  }, {
    userId: 'inspector-to-inspect',
    roleNames: ['cleaning_inspector'],
    permissions: allExecPerms,
    canViewAll: false,
  })
  assert.equal(actionById(inspectionBeforeCleaningPayload, 'submit_inspection')?.enabled, true)
  assert.equal(actionById(inspectionBeforeCleaningPayload, 'submit_inspection')?.disabled_reason, undefined)
  assert.equal(actionById(inspectionBeforeCleaningPayload, 'upload_access_video')?.enabled, true)
  assert.equal(actionById(inspectionBeforeCleaningPayload, 'upload_access_video')?.disabled_reason, undefined)

  const checkinInspectionWithoutCleaningPayload = buildWorkTaskActionPayload({
    ...inspectionBeforeCleaningPayload.capabilities.task_state,
    id: 'w-checkin-without-cleaning',
    source_type: 'cleaning_tasks',
    task_kind: 'inspection',
    task_type: 'checkin_clean',
    inspection_scope: 'inspect_and_hang',
    status: 'to_inspect',
    inspector_id: 'inspector-to-inspect',
    cleaning_submission_ready: false,
  }, {
    userId: 'inspector-to-inspect',
    roleNames: ['cleaning_inspector'],
    permissions: allExecPerms,
    canViewAll: false,
  })
  assert.equal(actionById(checkinInspectionWithoutCleaningPayload, 'submit_inspection')?.enabled, true)
  assert.equal(actionById(checkinInspectionWithoutCleaningPayload, 'submit_inspection')?.disabled_reason, undefined)
  assert.equal(actionById(checkinInspectionWithoutCleaningPayload, 'submit_inspection')?.label, '入住检查')
  assert.equal(actionById(checkinInspectionWithoutCleaningPayload, 'upload_access_video')?.enabled, true)
  assert.equal(actionById(checkinInspectionWithoutCleaningPayload, 'upload_access_video')?.disabled_reason, undefined)
  assert.equal(actionById(checkinInspectionWithoutCleaningPayload, 'upload_access_video')?.label, '挂钥匙并完成')

  const checkinReadyForKeysPayload = buildWorkTaskActionPayload({
    ...checkinInspectionWithoutCleaningPayload.capabilities.task_state,
    id: 'w-checkin-ready-for-keys',
    source_type: 'cleaning_tasks',
    task_kind: 'inspection',
    task_type: 'checkin_clean',
    inspection_scope: 'inspect_and_hang',
    status: 'to_hang_keys',
    inspector_id: 'inspector-to-inspect',
    cleaning_submission_ready: false,
  }, {
    userId: 'inspector-to-inspect',
    roleNames: ['cleaning_inspector'],
    permissions: allExecPerms,
    canViewAll: false,
  })
  assert.equal(actionById(checkinReadyForKeysPayload, 'upload_access_video')?.enabled, true)
  assert.equal(actionById(checkinReadyForKeysPayload, 'upload_access_video')?.disabled_reason, undefined)
  assert.equal(actionById(checkinReadyForKeysPayload, 'upload_access_video')?.label, '挂钥匙并完成')
  assert.equal(actionById(checkinReadyForKeysPayload, 'submit_inspection')?.enabled, false)
  assert.equal(actionById(checkinReadyForKeysPayload, 'submit_inspection')?.disabled_reason, 'task_completed')
  assert.equal(actionById(checkinReadyForKeysPayload, 'submit_inspection')?.read_only, true)

  const checkoutOnlyReadyForKeysPayload = buildWorkTaskActionPayload({
    id: 'w-checkout-only-ready-for-keys',
    source_type: 'cleaning_tasks',
    source_id: 'checkout-only-source',
    source_ids: ['checkout-only-source'],
    task_kind: 'inspection',
    task_type: 'checkout_clean',
    inspection_scope: null,
    status: 'to_hang_keys',
    inspector_id: 'inspector-to-inspect',
  }, {
    userId: 'inspector-to-inspect',
    roleNames: ['cleaning_inspector'],
    permissions: allExecPerms,
    canViewAll: false,
  })
  assert.equal(actionById(checkoutOnlyReadyForKeysPayload, 'submit_inspection')?.enabled, false)
  assert.equal(actionById(checkoutOnlyReadyForKeysPayload, 'submit_inspection')?.read_only, true)
  assert.equal(actionById(checkoutOnlyReadyForKeysPayload, 'submit_inspection')?.source_id, 'checkout-only-source')
  assert.equal(actionById(checkoutOnlyReadyForKeysPayload, 'upload_access_video')?.enabled, true)
  assert.equal(actionById(checkoutOnlyReadyForKeysPayload, 'upload_access_video')?.source_id, 'checkout-only-source')

  const pendingHandoverTurnoverPayload = buildWorkTaskActionPayload({
    id: 'w-pending-handover-turnover',
    source_type: 'cleaning_tasks',
    source_id: 'checkout-source',
    source_ids: ['checkout-source', 'checkin-source'],
    task_kind: 'inspection',
    task_type: 'turnover',
    inspection_scope: 'inspect_and_hang',
    status: 'to_hang_keys',
    inspector_id: 'inspector-to-inspect',
    participants: [{
      user_id: 'inspector-to-inspect',
      relation: 'assigned',
      role: 'inspector',
      action_ids: ['submit_inspection', 'upload_access_video'],
    }],
  }, {
    userId: 'inspector-to-inspect',
    roleNames: ['cleaning_inspector'],
    permissions: allExecPerms,
    canViewAll: false,
  })
  assert.equal(actionById(pendingHandoverTurnoverPayload, 'submit_inspection')?.enabled, false)
  assert.equal(actionById(pendingHandoverTurnoverPayload, 'submit_inspection')?.read_only, true)
  assert.equal(actionById(pendingHandoverTurnoverPayload, 'submit_inspection')?.source_id, 'checkout-source')
  assert.equal(actionById(pendingHandoverTurnoverPayload, 'upload_access_video')?.enabled, true)
  assert.equal(actionById(pendingHandoverTurnoverPayload, 'upload_access_video')?.source_id, 'checkout-source')

  assert.equal(
    actionById(pendingHandoverTurnoverPayload, 'upload_access_video')?.source_id,
    'checkout-source',
    'the original checkout source must continue to own the handover video and action audit',
  )

  const cleanerRecoveryPayload = buildWorkTaskActionPayload({
    ...cleaningTask,
    id: 'w-cleaner-recovery-after-early-inspection',
    status: 'inspected',
    cleaning_submission_ready: false,
  }, {
    userId: 'cleaner-1',
    roleNames: ['cleaner'],
    permissions: allExecPerms,
    canViewAll: false,
  })
  assert.equal(actionById(cleanerRecoveryPayload, 'fill_supplies')?.enabled, true)

  const cleanerRecoveryAfterLockboxPayload = buildWorkTaskActionPayload({
    ...cleaningTask,
    id: 'w-cleaner-recovery-after-early-lockbox',
    status: 'keys_hung',
    cleaning_submission_ready: false,
  }, {
    userId: 'cleaner-1',
    roleNames: ['cleaner'],
    permissions: allExecPerms,
    canViewAll: false,
  })
  assert.equal(actionById(cleanerRecoveryAfterLockboxPayload, 'fill_supplies')?.enabled, true)
  assert.equal(actionById(cleanerRecoveryAfterLockboxPayload, 'fill_supplies')?.disabled_reason, undefined)
  assert(mzappSource.includes("roleKind === 'cleaner' && !cleaningSubmissionReady"), 'cleaner projection must ignore inspection completion while cleaning is unsubmitted')
  assert(mzappSource.includes('cleaning_submission_ready: cleaningSubmissionReady'), 'role-specific task projection must expose cleaning submission authority')

  const inspectedPayload = buildWorkTaskActionPayload({
    id: 'w-inspected-waiting-video',
    source_type: 'cleaning_tasks',
    task_kind: 'inspection',
    task_type: 'checkout_clean',
    inspection_scope: 'inspect_and_hang',
    status: 'inspected',
    inspector_id: 'inspector-inspected',
  }, {
    userId: 'inspector-inspected',
    roleNames: ['cleaning_inspector'],
    permissions: allExecPerms,
    canViewAll: false,
  })
  assert.equal(actionById(inspectedPayload, 'upload_access_video')?.enabled, true)
  assert.equal(actionById(inspectedPayload, 'upload_access_video')?.disabled_reason, undefined)

  const completedInspectionPayload = buildWorkTaskActionPayload({
    id: 'w-inspection-completed',
    source_type: 'cleaning_tasks',
    task_kind: 'inspection',
    task_type: 'checkout_clean',
    inspection_scope: 'inspect_and_hang',
    status: 'keys_hung',
    inspector_id: 'inspector-completed',
  }, {
    userId: 'inspector-completed',
    roleNames: ['cleaning_inspector'],
    permissions: allExecPerms,
    canViewAll: false,
  })
  assert.equal(actionById(completedInspectionPayload, 'submit_inspection')?.enabled, false)
  assert.equal(actionById(completedInspectionPayload, 'submit_inspection')?.disabled_reason, 'task_completed')
  assert.equal(actionById(completedInspectionPayload, 'submit_inspection')?.read_only, true)
  assert.equal(actionById(completedInspectionPayload, 'upload_access_video')?.disabled_reason, 'task_completed')

  const passwordOnlyCompletedPayload = buildWorkTaskActionPayload({
    id: 'w-password-only-completed',
    source_type: 'cleaning_tasks',
    task_kind: 'inspection',
    task_type: 'checkin_clean',
    inspection_scope: 'password_only',
    status: 'inspected',
    inspector_id: 'inspector-password',
  }, {
    userId: 'inspector-password',
    roleNames: ['cleaning_inspector'],
    permissions: allExecPerms,
    canViewAll: false,
  })
  assert.equal(actionById(passwordOnlyCompletedPayload, 'upload_access_video')?.enabled, false)
  assert.equal(actionById(passwordOnlyCompletedPayload, 'upload_access_video')?.disabled_reason, 'task_completed')

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
  assert.equal(resolveCleaningTaskActionStatus({ actionId: 'upload_key_photo', statusBefore: 'restock_pending' }), 'restock_pending')
  assert.equal(keyPhotoUploadStatus('in_progress', 'in_progress', 'restock_pending'), 'restock_pending')
  assert.equal(keyPhotoUploadStatus('in_progress', 'in_progress', ''), 'in_progress')
  assert.equal(resolveCleaningTaskActionStatus({ actionId: 'fill_supplies', statusBefore: 'in_progress', needsRestock: false }), 'cleaned')
  assert.equal(resolveCleaningTaskActionStatus({ actionId: 'fill_supplies', statusBefore: 'in_progress', needsRestock: true }), 'restock_pending')
  assert.equal(resolveCleaningTaskActionStatus({ actionId: 'complete_cleaning', statusBefore: 'in_progress', isStayover: true }), 'cleaned')
  assert.equal(resolveCleaningTaskActionStatus({ actionId: 'upload_access_video', statusBefore: 'assigned' }), 'keys_hung')
  assert.equal(resolveCleaningTaskActionStatus({ actionId: 'upload_access_video', statusBefore: 'assigned', isPasswordOnly: true }), 'inspected')
  assert.equal(resolveCleaningTaskActionStatus({ actionId: 'submit_inspection', statusBefore: 'to_inspect' }), 'inspected')
  assert.equal(resolveCleaningTaskActionStatus({ actionId: 'submit_inspection', statusBefore: 'to_inspect', isCheckinInspectAndHang: true }), 'to_hang_keys')
  assert.equal(resolveCleaningTaskActionStatus({ actionId: 'submit_inspection', statusBefore: 'to_inspect', inspectionPhotosSaved: false }), 'to_inspect')
  assert.equal(isCleaningAccessVideoWorkRecordStatus('keys_hung'), true)
  assert.equal(isCleaningAccessVideoWorkRecordStatus('completed'), true)
  assert.equal(isCleaningAccessVideoWorkRecordStatus('inspected'), false, 'inspected checkout tasks may still need the first lockbox upload')

  assert.deepEqual(buildKeyPhotoUploadTaskPatch({
    statusBefore: 'done',
    statusAfter: 'done',
    startedAt: '2026-07-26T00:00:00.000Z',
    keyPhotoUploadedAt: null,
    now: '2026-07-27T00:00:00.000Z',
  }), {
    key_photo_uploaded_at: '2026-07-27T00:00:00.000Z',
  })
  assert.deepEqual(buildKeyPhotoUploadTaskPatch({
    statusBefore: 'assigned',
    statusAfter: 'in_progress',
    startedAt: null,
    keyPhotoUploadedAt: null,
    now: '2026-07-27T00:00:00.000Z',
  }), {
    status: 'in_progress',
    started_at: '2026-07-27T00:00:00.000Z',
    key_photo_uploaded_at: '2026-07-27T00:00:00.000Z',
  })
  assert.deepEqual(buildKeyPhotoUploadTaskPatch({
    statusBefore: 'restock_pending',
    statusAfter: 'in_progress',
    startedAt: '2026-07-27T00:00:00.000Z',
    keyPhotoUploadedAt: '2026-07-27T00:00:00.000Z',
    now: '2026-07-27T01:00:00.000Z',
  }), {})
  assert.deepEqual(buildKeyPhotoUploadTaskPatch({
    statusBefore: 'in_progress',
    statusAfter: 'restock_pending',
    startedAt: '2026-07-27T00:00:00.000Z',
    keyPhotoUploadedAt: '2026-07-27T00:00:00.000Z',
    now: '2026-07-27T01:00:00.000Z',
  }), {
    status: 'restock_pending',
  })
  assert.deepEqual(buildKeyPhotoUploadEventPatch({
    statusBefore: 'done',
    statusAfter: 'done',
    keyPhotoUrl: 'cleaning/task-1/key.jpg',
  }), {
    key_photo_url: 'cleaning/task-1/key.jpg',
  })
  assert.deepEqual(buildKeyPhotoUploadEventPatch({
    statusBefore: 'assigned',
    statusAfter: 'in_progress',
    keyPhotoUrl: 'cleaning/task-1/key.jpg',
  }), {
    status: 'in_progress',
    key_photo_url: 'cleaning/task-1/key.jpg',
  })
  assert.deepEqual(buildKeyPhotoUploadEventPatch({
    statusBefore: 'restock_pending',
    statusAfter: 'in_progress',
    keyPhotoUrl: 'cleaning/task-1/key-reuploaded.jpg',
  }), {
    key_photo_url: 'cleaning/task-1/key-reuploaded.jpg',
  })

  process.stdout.write('test_work_task_actions: ok\n')
}

main()
