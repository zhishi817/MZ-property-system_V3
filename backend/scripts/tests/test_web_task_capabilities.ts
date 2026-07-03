import assert from 'assert'
import { buildWebTaskCapabilityPayload } from '../../src/lib/webTaskCapabilities'

function actionById(payload: ReturnType<typeof buildWebTaskCapabilityPayload>, id: string) {
  return payload.management_actions.find((action) => action.id === id)
}

function badgeIds(payload: ReturnType<typeof buildWebTaskCapabilityPayload>) {
  return payload.display_state.badges.map((badge) => badge.id)
}

function main() {
  const managerContext = { canManageSchedule: true }
  const viewOnlyContext = { canManageSchedule: false }

  const passwordOnly = buildWebTaskCapabilityPayload({
    source: 'cleaning_tasks',
    task_type: 'checkin_clean',
    status: 'assigned',
    inspection_scope: 'password_only',
    inspection_mode: 'same_day',
    assignee_id: 'staff-1',
  }, managerContext)
  assert.equal(passwordOnly.display_state.task_semantics.is_pure_checkin, true)
  assert.equal(passwordOnly.display_state.task_semantics.is_key_handover, true)
  assert.equal(passwordOnly.display_state.task_semantics.inspection_scope_label, '仅改密码')
  assert.equal(passwordOnly.execution_semantics, 'key_or_password_action')
  assert.equal(passwordOnly.display_scope.label, '仅改密码/挂钥匙')
  assert.equal(passwordOnly.participant_summary.show_executor, true)
  assert.equal(passwordOnly.participant_summary.primary_user_id, 'staff-1')
  assert.equal(passwordOnly.editable_fields.assignee_id.enabled, true)
  assert.equal(passwordOnly.editable_fields.inspector_id.enabled, false)
  assert.deepEqual(badgeIds(passwordOnly).slice(0, 2), ['pure_checkin_inspection', 'password_only_site_action'])
  assert.equal(actionById(passwordOnly, 'assign_executor')?.enabled, true)
  assert.equal(actionById(passwordOnly, 'assign_inspector')?.enabled, false)

  const checkinSiteExecution = buildWebTaskCapabilityPayload({
    source: 'cleaning_tasks',
    task_type: 'checkin_clean',
    status: 'assigned',
    inspection_scope: 'inspect_and_hang',
    inspection_mode: 'same_day',
    assignee_id: 'staff-2',
  }, managerContext)
  assert.equal(checkinSiteExecution.execution_semantics, 'checkin_inspection')
  assert.equal(checkinSiteExecution.display_scope.label, '入住现场执行')
  assert.equal(checkinSiteExecution.participant_summary.primary_role, 'executor')
  assert.equal(checkinSiteExecution.participant_summary.primary_user_id, 'staff-2')
  assert.equal(checkinSiteExecution.participant_summary.show_executor, true)
  assert.equal(checkinSiteExecution.participant_summary.show_inspector, false)
  assert.equal(checkinSiteExecution.editable_fields.assignee_id.enabled, true)
  assert.equal(checkinSiteExecution.editable_fields.inspector_id.enabled, false)
  assert.equal(actionById(checkinSiteExecution, 'assign_executor')?.enabled, true)
  assert.equal(actionById(checkinSiteExecution, 'assign_inspector')?.enabled, false)

  const keysHung = buildWebTaskCapabilityPayload({
    task_source: 'cleaning',
    task_kind: 'checkin_clean',
    status: 'keys_hung',
    inspection_scope: 'password_only',
  }, managerContext)
  assert.equal(keysHung.display_state.status_label, '已挂钥匙')
  assert.equal(keysHung.display_state.task_semantics.is_keys_hung, true)
  assert.equal(keysHung.display_state.task_semantics.is_task_ended, true)
  assert.ok(badgeIds(keysHung).includes('keys_hung'))
  assert.ok(badgeIds(keysHung).includes('task_ended'))

  const checkedDoneViewOnly = buildWebTaskCapabilityPayload({
    task_source: 'cleaning',
    task_kind: 'turnover',
    status: 'assigned',
    inspection_mode: 'checked_done',
  }, viewOnlyContext)
  assert.equal(checkedDoneViewOnly.display_state.task_semantics.is_checked_done, true)
  assert.equal(checkedDoneViewOnly.execution_semantics, 'mixed_cleaning_inspection')
  assert.ok(badgeIds(checkedDoneViewOnly).includes('checked_done'))
  assert.equal(actionById(checkedDoneViewOnly, 'edit_task')?.enabled, false)
  assert.equal(actionById(checkedDoneViewOnly, 'edit_task')?.disabled_reason, 'missing_management_permission')
  assert.equal(checkedDoneViewOnly.editable_fields.status.enabled, false)
  assert.equal(checkedDoneViewOnly.editable_fields.status.disabled_reason, 'missing_management_permission')

  const selfCompleteLocked = buildWebTaskCapabilityPayload({
    task_source: 'cleaning',
    task_kind: 'checkout_clean',
    status: 'assigned',
    inspection_mode: 'self_complete',
    auto_sync_enabled: false,
  }, managerContext)
  assert.equal(selfCompleteLocked.display_state.task_semantics.is_self_complete, true)
  assert.ok(badgeIds(selfCompleteLocked).includes('self_complete'))
  assert.equal(actionById(selfCompleteLocked, 'update_status')?.enabled, false)
  assert.equal(actionById(selfCompleteLocked, 'update_status')?.disabled_reason, 'auto_sync_locked')
  assert.equal(selfCompleteLocked.editable_fields.cleaner_id.disabled_reason, 'auto_sync_locked')

  const offline = buildWebTaskCapabilityPayload({
    source: 'offline_tasks',
    status: 'done',
    assignee_id: 'staff-3',
  }, managerContext)
  assert.equal(offline.display_state.task_semantics.is_offline_task, true)
  assert.equal(offline.display_state.status_label, '已完成')
  assert.equal(offline.execution_semantics, 'work_task')
  assert.equal(offline.display_scope.label, '线下任务')
  assert.equal(offline.participant_summary.primary_role, 'assignee')
  assert.equal(offline.participant_summary.primary_user_id, 'staff-3')
  assert.equal(actionById(offline, 'assign_executor')?.enabled, true)
  assert.equal(actionById(offline, 'save_participants')?.enabled, false)
  assert.equal(actionById(offline, 'save_participants')?.disabled_reason, 'not_applicable')

  process.stdout.write('test_web_task_capabilities: ok\n')
}

main()
