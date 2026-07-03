import { isKeyOrPasswordActionSemantics } from './cleaningInspection'

export type WorkTaskActionId =
  | 'upload_key_photo'
  | 'fill_supplies'
  | 'submit_inspection'
  | 'upload_access_video'
  | 'complete_cleaning'
  | 'report_issue'
  | 'mark_guest_checkout'

export type WorkTaskActionTarget =
  | 'TaskDetail'
  | 'SuppliesForm'
  | 'InspectionPanel'
  | 'InspectionComplete'
  | 'CleaningSelfComplete'
  | 'FeedbackForm'

export type WorkTaskActionIntent = 'cleaning' | 'inspection' | 'site_action' | 'issue' | 'manager'

export type WebTaskManagementActionId =
  | 'edit_task'
  | 'assign_cleaner'
  | 'assign_inspector'
  | 'assign_executor'
  | 'set_inspection_mode'
  | 'set_inspection_scope'
  | 'set_keys_hung'
  | 'set_task_completed'
  | 'update_status'
  | 'save_participants'
  | 'cancel_task'
  | 'add_checkout'
  | 'add_checkin'

export type WebTaskManagementAction = {
  id: WebTaskManagementActionId
  label: string
  placement: 'card' | 'drawer' | 'bulk' | 'more'
  enabled: boolean
  disabled_reason?: string
  intent: 'assignment' | 'inspection' | 'status' | 'schedule' | 'participants'
}

export type WebTaskEditableField = {
  enabled: boolean
  disabled_reason?: string
}

export type WebTaskManagementContext = {
  canManageSchedule: boolean
}

export type WebTaskManagementInput = {
  source: 'cleaning' | 'work' | 'offline' | 'unknown'
  requiresCleaner: boolean
  isPasswordOnly: boolean
  canConfigureInspection: boolean
  pureCheckin: boolean
  deferredInspection: boolean
  inspectionMode: string
  autoSyncLocked: boolean
}

export type WorkTaskParticipant = {
  user_id: string
  participant_role?: 'assignee' | 'cleaner' | 'inspector' | 'collaborator' | string | null
  action_ids?: string[] | null
  source_relation?: 'legacy' | 'manual' | string | null
  source_type?: string | null
  source_id?: string | null
}

export type WorkTaskAvailableAction = {
  id: WorkTaskActionId
  label: string
  placement: 'primary' | 'more'
  enabled: boolean
  disabled_reason?: string
  target?: WorkTaskActionTarget
  intent: WorkTaskActionIntent
  source_type?: string | null
  source_id?: string | null
}

export type WorkTaskActionContext = {
  userId: string
  roleNames: string[]
  permissions: string[]
  canViewAll: boolean
}

export type WorkTaskCapabilities = {
  is_manager: boolean
  is_task_participant: boolean
  can_view_all: boolean
  participant_actions: string[]
  participant_sources: string[]
  base_permissions: {
    start: boolean
    finish: boolean
    inspect: boolean
    media_upload: boolean
    issue_report: boolean
  }
  task_state: {
    source_type: string
    task_kind: string
    status: string
    execution_role: string | null
    inspection_mode: string | null
    inspection_scope: string | null
  }
}

function cleanText(value: any) {
  return String(value ?? '').trim()
}

function lower(value: any) {
  return cleanText(value).toLowerCase()
}

function uniqueTexts(values: any[]) {
  return Array.from(new Set(values.map(cleanText).filter(Boolean)))
}

function normalizeActionIds(value: any): string[] {
  const raw = Array.isArray(value)
    ? value
    : (typeof value === 'string' && value.trim().startsWith('['))
      ? (() => {
          try { return JSON.parse(value) } catch { return [] }
        })()
      : []
  return Array.from(new Set((Array.isArray(raw) ? raw : []).map((item) => lower(item)).filter(Boolean)))
}

function isDoneStatus(value: any) {
  const status = lower(value)
  return ['done', 'completed', 'ready', 'cancelled', 'canceled', 'cleaned', 'restock_pending', 'restocked', 'to_inspect', 'to_hang_keys', 'keys_hung', 'inspected'].includes(status)
}

function isCleaningWorkSubmitted(value: any) {
  const status = lower(value)
  return ['cleaned', 'restock_pending', 'restocked', 'to_inspect', 'to_hang_keys', 'keys_hung', 'done', 'completed', 'ready'].includes(status)
}

function isStayoverTaskType(value: any) {
  return lower(value) === 'stayover_clean'
}

function normalizeInspectionMode(task: any) {
  const explicit = lower(task?.inspection_mode)
  if (['pending_decision', 'same_day', 'deferred', 'self_complete', 'checked_done'].includes(explicit)) return explicit
  if (isStayoverTaskType(task?.task_type)) return 'self_complete'
  if (lower(task?.task_type) === 'checkin_clean') return 'same_day'
  if (cleanText(task?.inspector_id)) return 'same_day'
  return 'pending_decision'
}

function isSelfCompleteMode(task: any) {
  return isStayoverTaskType(task?.task_type) || normalizeInspectionMode(task) === 'self_complete'
}

function isPasswordOnlyInspectionTask(task: any) {
  const sourceType = cleanText(task?.source_type)
  const taskKind = lower(task?.task_kind)
  const taskType = lower(task?.task_type)
  const executionRole = lower(task?.execution_role)
  if (sourceType !== 'cleaning_tasks') return false
  if (executionRole === 'execution' || isKeyOrPasswordActionSemantics(task?.execution_semantics) || taskKind === 'execution') return true
  return taskKind === 'inspection' && taskType === 'checkin_clean' && lower(task?.inspection_scope) === 'password_only'
}

function hasPermission(permissionSet: Set<string>, code: string) {
  return permissionSet.has(code)
}

function disabledReason(params: {
  hasPermission: boolean
  isParticipant: boolean
  completed?: boolean
  blocked?: boolean
  alreadyDone?: boolean
}) {
  if (!params.hasPermission) return 'missing_base_permission'
  if (!params.isParticipant) return 'not_participant'
  if (params.completed) return 'task_completed'
  if (params.blocked) return 'pending_inspection_decision'
  if (params.alreadyDone) return 'already_recorded'
  return undefined
}

function actionEnabled(reason: string | undefined) {
  return !reason
}

function webManagementAction(
  id: WebTaskManagementActionId,
  label: string,
  placement: WebTaskManagementAction['placement'],
  intent: WebTaskManagementAction['intent'],
  enabled: boolean,
  disabledReason?: string,
): WebTaskManagementAction {
  return {
    id,
    label,
    placement,
    intent,
    enabled,
    ...(enabled || !disabledReason ? {} : { disabled_reason: disabledReason }),
  }
}

function webManagementGate(enabled: boolean, context: WebTaskManagementContext, disabledReason?: string) {
  if (!context.canManageSchedule) return { enabled: false, reason: 'missing_management_permission' }
  if (!enabled) return { enabled: false, reason: disabledReason || 'not_applicable' }
  return { enabled: true, reason: undefined }
}

export function buildWebTaskManagementPayload(input: WebTaskManagementInput, context: WebTaskManagementContext): {
  management_actions: WebTaskManagementAction[]
  editable_fields: Record<string, WebTaskEditableField>
} {
  const disabledByLock = input.autoSyncLocked ? 'auto_sync_locked' : undefined
  const make = (params: {
    id: WebTaskManagementActionId
    label: string
    placement: WebTaskManagementAction['placement']
    intent: WebTaskManagementAction['intent']
    applicable?: boolean
    disabledReason?: string
  }) => {
    const gate = webManagementGate(params.applicable !== false && !input.autoSyncLocked, context, params.disabledReason || disabledByLock)
    return webManagementAction(params.id, params.label, params.placement, params.intent, gate.enabled, gate.reason)
  }

  const managementActions: WebTaskManagementAction[] = [
      make({ id: 'edit_task', label: '编辑任务', placement: 'card', intent: 'schedule' }),
      make({ id: 'update_status', label: '更新状态', placement: 'drawer', intent: 'status' }),
      make({ id: 'cancel_task', label: '取消任务', placement: 'more', intent: 'status' }),
  ]

  if (input.source === 'cleaning') {
    managementActions.push(
      make({ id: 'assign_cleaner', label: '分配清洁人员', placement: 'drawer', intent: 'assignment', applicable: input.requiresCleaner }),
      make({ id: 'assign_inspector', label: '分配检查人员', placement: 'drawer', intent: 'assignment', applicable: !input.isPasswordOnly && !input.pureCheckin }),
      make({ id: 'assign_executor', label: '分配执行人', placement: 'drawer', intent: 'assignment', applicable: input.isPasswordOnly || input.pureCheckin }),
      make({ id: 'set_inspection_mode', label: '设置检查安排', placement: 'drawer', intent: 'inspection', applicable: input.canConfigureInspection }),
      make({ id: 'set_inspection_scope', label: '设置检查执行方式', placement: 'drawer', intent: 'inspection', applicable: input.pureCheckin }),
      make({ id: 'set_keys_hung', label: '标记已挂钥匙', placement: 'drawer', intent: 'status', applicable: input.pureCheckin }),
      make({ id: 'set_task_completed', label: '标记任务已结束', placement: 'drawer', intent: 'status', applicable: input.deferredInspection || input.inspectionMode === 'deferred' }),
      make({ id: 'save_participants', label: '保存协作者授权', placement: 'drawer', intent: 'participants' }),
      make({ id: 'add_checkout', label: '新增退房任务', placement: 'drawer', intent: 'schedule' }),
      make({ id: 'add_checkin', label: '新增入住任务', placement: 'drawer', intent: 'schedule' }),
    )
  } else if (input.source === 'work' || input.source === 'offline') {
    managementActions.push(
      make({ id: 'assign_executor', label: '分配执行人', placement: 'drawer', intent: 'assignment' }),
      make({ id: 'save_participants', label: '保存协作者授权', placement: 'drawer', intent: 'participants', applicable: input.source === 'work' }),
    )
  }

  const actionById = (id: WebTaskManagementActionId) => managementActions.find((item) => item.id === id)
  const fieldFromAction = (id: WebTaskManagementActionId): WebTaskEditableField => {
    const item = actionById(id)
    if (!item) return { enabled: false, disabled_reason: 'not_applicable' }
    return item.enabled ? { enabled: true } : { enabled: false, disabled_reason: item.disabled_reason || 'not_applicable' }
  }

  return {
    management_actions: managementActions,
    editable_fields: {
      task_date: fieldFromAction('edit_task'),
      details: fieldFromAction('edit_task'),
      status: fieldFromAction('update_status'),
      cleaner_id: fieldFromAction('assign_cleaner'),
      inspector_id: fieldFromAction('assign_inspector'),
      assignee_id: fieldFromAction('assign_executor'),
      inspection_scope: fieldFromAction('set_inspection_scope'),
      inspection_mode: fieldFromAction('set_inspection_mode'),
      keys_hung: fieldFromAction('set_keys_hung'),
      task_completed: fieldFromAction('set_task_completed'),
      delete: fieldFromAction('cancel_task'),
      add_checkout: fieldFromAction('add_checkout'),
      add_checkin: fieldFromAction('add_checkin'),
    },
  }
}

function legacyParticipantActions(task: any, role: 'assignee' | 'cleaner' | 'inspector') {
  const sourceType = cleanText(task?.source_type)
  if (sourceType !== 'cleaning_tasks') return ['*']
  const taskKind = lower(task?.task_kind)
  const executionRole = lower(task?.execution_role)
  const isExecution = taskKind === 'execution' || executionRole === 'execution' || isKeyOrPasswordActionSemantics(task?.execution_semantics)
  if (role === 'cleaner') return ['upload_key_photo', 'fill_supplies', 'complete_cleaning', 'report_issue']
  if (role === 'inspector') return ['submit_inspection', 'upload_access_video', 'report_issue']
  if (isExecution || isPasswordOnlyInspectionTask(task)) return ['upload_access_video', 'report_issue']
  if (taskKind === 'inspection') return ['submit_inspection', 'upload_access_video', 'report_issue']
  return ['upload_key_photo', 'fill_supplies', 'complete_cleaning', 'report_issue']
}

function normalizeTaskParticipants(task: any): WorkTaskParticipant[] {
  const explicit = Array.isArray(task?.participants) ? task.participants : []
  const rows: WorkTaskParticipant[] = explicit
    .map((item: any) => ({
      user_id: cleanText(item?.user_id),
      participant_role: lower(item?.participant_role) || null,
      source_relation: lower(item?.source_relation) || null,
      source_type: cleanText(item?.source_type) || cleanText(task?.source_type) || null,
      source_id: cleanText(item?.source_id) || cleanText(task?.source_id) || null,
      action_ids: normalizeActionIds(item?.action_ids),
    }))
    .filter((item: WorkTaskParticipant) => !!item.user_id)
  if (rows.length) return rows

  const addLegacy = (userId: any, role: 'assignee' | 'cleaner' | 'inspector') => {
    const id = cleanText(userId)
    if (!id) return
    rows.push({
      user_id: id,
      participant_role: role,
      source_relation: 'legacy',
      source_type: cleanText(task?.source_type) || null,
      source_id: cleanText(task?.source_id) || null,
      action_ids: legacyParticipantActions(task, role),
    })
  }
  addLegacy(task?.assignee_id, 'assignee')
  addLegacy(task?.cleaner_id, 'cleaner')
  addLegacy(task?.inspector_id, 'inspector')
  return rows
}

function participantSummaryForUser(participants: WorkTaskParticipant[], userId: string) {
  const actions = new Set<string>()
  const sources = new Set<string>()
  let hasAll = false
  for (const item of participants) {
    if (!userId || cleanText(item.user_id) !== userId) continue
    const relation = lower(item.source_relation) || 'manual'
    const role = lower(item.participant_role) || 'collaborator'
    sources.add(`${relation}:${role}`)
    const ids = normalizeActionIds(item.action_ids)
    if (!ids.length || ids.includes('*')) {
      hasAll = true
      actions.add('*')
      continue
    }
    for (const id of ids) actions.add(id)
  }
  const can = (actionId: WorkTaskActionId) => hasAll || actions.has(actionId)
  return {
    hasAny: hasAll || actions.size > 0,
    actions: Array.from(actions).sort(),
    sources: Array.from(sources).sort(),
    can,
  }
}

export function buildWorkTaskActionPayload(task: any, context: WorkTaskActionContext): {
  capabilities: WorkTaskCapabilities
  available_actions: WorkTaskAvailableAction[]
} {
  const permissions = new Set((context.permissions || []).map(cleanText).filter(Boolean))
  const roleNames = new Set((context.roleNames || []).map(cleanText).filter(Boolean))
  const userId = cleanText(context.userId)
  const sourceType = cleanText(task?.source_type)
  const taskKind = lower(task?.task_kind)
  const status = lower(task?.status)
  const isManager = roleNames.has('admin') || roleNames.has('offline_manager') || roleNames.has('customer_service')
  const isCleaningSource = sourceType === 'cleaning_tasks'
  const isCleaningTask = isCleaningSource && taskKind === 'cleaning'
  const isInspectionTask = isCleaningSource && taskKind === 'inspection'
  const isExecutionTask = isCleaningSource && (taskKind === 'execution' || lower(task?.execution_role) === 'execution' || isKeyOrPasswordActionSemantics(task?.execution_semantics))
  const isStayoverTask = isCleaningTask && isStayoverTaskType(task?.task_type)
  const isCheckoutTask = lower(task?.task_type) === 'checkout_clean' || !!cleanText(task?.start_time)
  const inspectionMode = normalizeInspectionMode(task)
  const isPasswordOnly = isPasswordOnlyInspectionTask(task)
  const isCheckinInspection = isInspectionTask && lower(task?.task_type) === 'checkin_clean'
  const isPendingInspectionDecision = isCleaningTask && !isStayoverTask && inspectionMode === 'pending_decision'
  const isSelfCompleteEligible = isCleaningTask && isSelfCompleteMode(task) && (isCheckoutTask || isStayoverTask)
  const isDirectCompleteEligible = isCleaningTask && (isSelfCompleteEligible || isStayoverTask)
  const isCleaningSubmitted = isCleaningTask && isCleaningWorkSubmitted(status)
  const isCompleted = isDoneStatus(status)
  const participants = normalizeTaskParticipants(task)
  const participantSummary = participantSummaryForUser(participants, userId)
  const isParticipant = participantSummary.hasAny

  const canStart = hasPermission(permissions, 'cleaning_app.tasks.start')
  const canFinish = hasPermission(permissions, 'cleaning_app.tasks.finish')
  const canInspect = hasPermission(permissions, 'cleaning_app.inspect.finish') || canFinish
  const canMediaUpload = hasPermission(permissions, 'cleaning_app.media.upload') || canStart || canFinish || canInspect
  const canReportIssue = hasPermission(permissions, 'cleaning_app.issues.report')

  const actions: WorkTaskAvailableAction[] = []
  const addAction = (action: WorkTaskAvailableAction) => {
    actions.push({
      ...action,
      source_type: action.source_type ?? (sourceType || null),
      source_id: action.source_id ?? (cleanText(task?.source_id) || null),
    })
  }

  if (isCleaningTask) {
    const keyReason = disabledReason({
      hasPermission: canStart && canMediaUpload,
      isParticipant: participantSummary.can('upload_key_photo'),
      completed: isCleaningSubmitted,
      alreadyDone: !!cleanText(task?.key_photo_url),
    })
    addAction({
      id: 'upload_key_photo',
      label: keyReason === 'already_recorded' ? '钥匙已记录' : '上传钥匙',
      placement: keyReason === 'not_participant' ? 'more' : 'primary',
      enabled: actionEnabled(keyReason),
      ...(keyReason ? { disabled_reason: keyReason } : {}),
      target: 'TaskDetail',
      intent: 'cleaning',
    })

    const completionReason = disabledReason({
      hasPermission: canFinish,
      isParticipant: participantSummary.can(isDirectCompleteEligible ? 'complete_cleaning' : 'fill_supplies'),
      completed: isCompleted,
      blocked: isPendingInspectionDecision,
    })
    addAction({
      id: isDirectCompleteEligible ? 'complete_cleaning' : 'fill_supplies',
      label: isPendingInspectionDecision
        ? '待确认检查安排'
        : isCleaningSubmitted
          ? (isDirectCompleteEligible ? '完成记录' : '补品记录')
          : (isStayoverTask ? '标记已完成' : (isSelfCompleteEligible ? '补充与完成' : '补品填报')),
      placement: completionReason === 'not_participant' ? 'more' : 'primary',
      enabled: actionEnabled(completionReason),
      ...(completionReason ? { disabled_reason: completionReason } : {}),
      target: isDirectCompleteEligible ? 'CleaningSelfComplete' : 'SuppliesForm',
      intent: 'cleaning',
    })
  }

  if (isInspectionTask) {
    const inspectionReason = disabledReason({
      hasPermission: canInspect && canMediaUpload,
      isParticipant: participantSummary.can('submit_inspection'),
      completed: isCompleted,
    })
    const siteReason = disabledReason({
      hasPermission: canFinish && canMediaUpload,
      isParticipant: participantSummary.can('upload_access_video'),
      completed: isCompleted,
    })
    addAction({
      id: 'submit_inspection',
      label: isPasswordOnly ? '查看说明' : (isCheckinInspection ? '入住检查' : '检查与补充'),
      placement: inspectionReason === 'not_participant' ? 'more' : 'primary',
      enabled: actionEnabled(inspectionReason),
      ...(inspectionReason ? { disabled_reason: inspectionReason } : {}),
      target: 'InspectionPanel',
      intent: 'inspection',
    })
    addAction({
      id: 'upload_access_video',
      label: isPasswordOnly ? '改密码并完成' : (isCheckinInspection ? '挂钥匙并完成' : '标记已完成'),
      placement: siteReason === 'not_participant' ? 'more' : 'primary',
      enabled: actionEnabled(siteReason),
      ...(siteReason ? { disabled_reason: siteReason } : {}),
      target: 'InspectionComplete',
      intent: isPasswordOnly || isCheckinInspection ? 'site_action' : 'inspection',
    })
  }

  if (isExecutionTask) {
    const siteReason = disabledReason({
      hasPermission: canFinish && canMediaUpload,
      isParticipant: participantSummary.can('upload_access_video'),
      completed: isCompleted,
    })
    addAction({
      id: 'upload_access_video',
      label: '上传视频并完成',
      placement: siteReason === 'not_participant' ? 'more' : 'primary',
      enabled: actionEnabled(siteReason),
      ...(siteReason ? { disabled_reason: siteReason } : {}),
      target: 'InspectionComplete',
      intent: 'site_action',
    })
  }

  if (isCleaningSource) {
    const issueAllowed = canReportIssue && (participantSummary.can('report_issue') || context.canViewAll)
    addAction({
      id: 'report_issue',
      label: '房源问题反馈',
      placement: 'more',
      enabled: issueAllowed,
      ...(!issueAllowed ? { disabled_reason: canReportIssue ? 'not_participant' : 'missing_base_permission' } : {}),
      target: 'FeedbackForm',
      intent: 'issue',
    })
  }

  if (isCleaningSource && isManager && (isCheckoutTask || !!cleanText(task?.order_id_checkout) || !!cleanText(task?.order_id))) {
    const checkedOut = !!cleanText(task?.checked_out_at)
    addAction({
      id: 'mark_guest_checkout',
      label: checkedOut ? '取消已退房' : '标记已退房',
      placement: 'primary',
      enabled: true,
      target: 'TaskDetail',
      intent: 'manager',
    })
  }

  return {
    capabilities: {
      is_manager: isManager,
      is_task_participant: isParticipant,
      can_view_all: !!context.canViewAll,
      participant_actions: participantSummary.actions,
      participant_sources: participantSummary.sources,
      base_permissions: {
        start: canStart,
        finish: canFinish,
        inspect: canInspect,
        media_upload: canMediaUpload,
        issue_report: canReportIssue,
      },
      task_state: {
        source_type: sourceType,
        task_kind: taskKind,
        status,
        execution_role: task?.execution_role == null ? null : cleanText(task.execution_role),
        inspection_mode: inspectionMode || null,
        inspection_scope: task?.inspection_scope == null ? null : cleanText(task.inspection_scope),
      },
    },
    available_actions: actions,
  }
}
