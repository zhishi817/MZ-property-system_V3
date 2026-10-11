import assert from 'assert'
import { buildWebTaskCapabilityPayload } from '../../src/lib/webTaskCapabilities'

function actionById(payload: ReturnType<typeof buildWebTaskCapabilityPayload>, id: string) {
  return payload.management_actions.find((action) => action.id === id)
}

function badgeIds(payload: ReturnType<typeof buildWebTaskCapabilityPayload>) {
  return payload.display_state.badges.map((badge) => badge.id)
}

async function main() {
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

  const checkedOutAssigned = buildWebTaskCapabilityPayload({
    task_source: 'cleaning',
    task_kind: 'turnover',
    status: 'assigned',
    checked_out_at: '2026-10-07T01:02:03.000Z',
  }, managerContext)
  assert.equal(checkedOutAssigned.display_state.status_key, 'assigned', 'checked-out display must not invent a persisted task status')
  assert.equal(checkedOutAssigned.display_state.status_label, '已退房')
  assert.equal(checkedOutAssigned.display_state.status_tone, 'info')

  const checkedOutInProgress = buildWebTaskCapabilityPayload({
    task_source: 'cleaning',
    task_kind: 'turnover',
    status: 'in_progress',
    checked_out_at: '2026-10-07T01:02:03.000Z',
  }, managerContext)
  assert.equal(checkedOutInProgress.display_state.status_label, '进行中', 'workflow progress must stay higher priority than checkout display')

  const assignedWithoutCheckout = buildWebTaskCapabilityPayload({
    task_source: 'cleaning',
    task_kind: 'turnover',
    status: 'assigned',
    checked_out_at: null,
  }, managerContext)
  assert.equal(assignedWithoutCheckout.display_state.status_label, '已分配')

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
  assert.equal(checkedDoneViewOnly.display_state.task_semantics.is_task_ended, true)
  assert.equal(checkedDoneViewOnly.execution_semantics, 'mixed_cleaning_inspection')
  assert.ok(badgeIds(checkedDoneViewOnly).includes('checked_done'))
  assert.ok(badgeIds(checkedDoneViewOnly).includes('task_ended'))
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
  assert.equal(selfCompleteLocked.display_state.task_semantics.is_task_ended, false)
  assert.ok(badgeIds(selfCompleteLocked).includes('self_complete'))
  assert.equal(badgeIds(selfCompleteLocked).includes('task_ended'), false)
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

  process.env.DATABASE_URL = ''
  const [{ buildTaskCenterDay }, { db }] = await Promise.all([
    import('../../src/modules/task_center'),
    import('../../src/store'),
  ])
  const memoryDb = db as any
  const original = {
    cleaningTasks: memoryDb.cleaningTasks,
    properties: memoryDb.properties,
    orders: memoryDb.orders,
    workTasks: memoryDb.workTasks,
    cleaningOfflineTasks: memoryDb.cleaningOfflineTasks,
  }
  try {
    memoryDb.cleaningTasks = [
      {
        id: 'checked-out-checkout',
        property_id: 'checked-out-property',
        task_type: 'checkout_clean',
        task_date: '2026-10-07',
        status: 'assigned',
        checked_out_at: '2026-10-07T01:02:03.000Z',
      },
      {
        id: 'checked-out-checkin',
        property_id: 'checked-out-property',
        task_type: 'checkin_clean',
        task_date: '2026-10-07',
        status: 'assigned',
      },
      {
        id: 'checked-out-progress',
        property_id: 'checked-out-progress-property',
        task_type: 'checkout_clean',
        task_date: '2026-10-07',
        status: 'in_progress',
        checked_out_at: '2026-10-07T01:02:03.000Z',
      },
    ]
    memoryDb.properties = [
      { id: 'checked-out-property', code: 'MZ015', region: 'TEST' },
      { id: 'checked-out-progress-property', code: 'MZ015-PROGRESS', region: 'TEST' },
    ]
    memoryDb.orders = []
    memoryDb.workTasks = []
    memoryDb.cleaningOfflineTasks = []
    const day = await buildTaskCenterDay('2026-10-07', false, true, false, true)
    const boardTasks = day.rows.flatMap((row: any) => row.subrows.flatMap((subrow: any) => subrow.tasks))
    const checkedOutTurnover = boardTasks.find((task: any) => task.property_id === 'checked-out-property')
    assert.ok(checkedOutTurnover, 'task-center should keep the checked-out turnover card')
    assert.equal(checkedOutTurnover.checked_out_at, '2026-10-07T01:02:03.000Z')
    assert.equal(checkedOutTurnover.status, 'assigned', 'task-center must preserve the canonical workflow status')
    assert.equal(checkedOutTurnover.display_state?.status_key, 'assigned')
    assert.equal(checkedOutTurnover.display_state?.status_label, '已退房')
    const inProgress = boardTasks.find((task: any) => task.property_id === 'checked-out-progress-property')
    assert.equal(inProgress?.display_state?.status_label, '进行中')
  } finally {
    Object.assign(memoryDb, original)
  }

  process.stdout.write('test_web_task_capabilities: ok\n')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
