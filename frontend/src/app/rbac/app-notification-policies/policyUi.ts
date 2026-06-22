export type AppNotificationGroupKey =
  | 'admin_users'
  | 'offline_manager_users'
  | 'customer_service_users'
  | 'ops_manager_users'
  | 'task_cleaner'
  | 'task_inspector'
  | 'task_assignee'
  | 'cleaning_task_participants'
  | 'inspection_task_participants'
  | 'work_task_assignee'
  | 'warehouse_related_users'

export type AppNotificationTemplateKey =
  | 'participants_only'
  | 'participants_plus_ops_manager'
  | 'participants_plus_ops_manager_and_customer_service'
  | 'inspection_plus_ops_manager'
  | 'worktask_assignee_plus_ops_manager'
  | 'ops_manager_only'
  | 'explicit_only'

export type AppNotificationPolicy = {
  policy_key: string
  enabled: boolean
  template_key: AppNotificationTemplateKey
  extra_group_keys: AppNotificationGroupKey[]
  extra_user_ids: string[]
  note: string | null
  version: number
  updated_at: string | null
  updated_by: string | null
  updated_by_name?: string | null
  catalog_meta: {
    policy_key: string
    label: string
    description: string
    source_event_types: string[]
    default_template_key: AppNotificationTemplateKey
    allowed_group_keys: AppNotificationGroupKey[]
    supports_extra_users: boolean
    default_enabled: boolean
  }
}

export type AppNotificationGroupOption = {
  key: AppNotificationGroupKey
  label: string
  description: string
}

export type AppNotificationTemplateOption = {
  key: AppNotificationTemplateKey
  label: string
  description: string
  summary_label: string
}

export type AppNotificationUser = {
  id: string
  username: string
  role: string
  roles?: string[]
}

export type AppNotificationPolicyForm = {
  enabled: boolean
  template_key: AppNotificationTemplateKey
  extra_group_keys: AppNotificationGroupKey[]
  extra_user_ids: string[]
  note: string
}

type ParticipantGroupKey = 'cleaning_task_participants' | 'work_task_assignee'
type ParticipantLabelKey = ParticipantGroupKey | 'warehouse_related_users'

const PARTICIPANT_GROUP_BY_POLICY: Record<string, ParticipantLabelKey> = {
  work_task_updated: 'work_task_assignee',
  work_task_completed: 'work_task_assignee',
  warehouse_key_updated: 'warehouse_related_users',
}

const PARTICIPANT_LABEL_BY_GROUP: Record<ParticipantLabelKey, string> = {
  cleaning_task_participants: '当前任务参与人',
  work_task_assignee: '当前线下任务执行人',
  warehouse_related_users: '相关任务参与人',
}

function uniqText(items: string[]) {
  return Array.from(new Set((items || []).map((item) => String(item || '').trim()).filter(Boolean)))
}

export function buildPolicyForm(policy: AppNotificationPolicy): AppNotificationPolicyForm {
  return {
    enabled: policy.enabled !== false,
    template_key: policy.template_key,
    extra_group_keys: uniqText(policy.extra_group_keys) as AppNotificationGroupKey[],
    extra_user_ids: uniqText(policy.extra_user_ids),
    note: String(policy.note || ''),
  }
}

export function isPolicyDirty(policy: AppNotificationPolicy, form: AppNotificationPolicyForm) {
  const base = buildPolicyForm(policy)
  return (
    base.enabled !== form.enabled ||
    base.template_key !== form.template_key ||
    JSON.stringify(uniqText(base.extra_group_keys)) !== JSON.stringify(uniqText(form.extra_group_keys)) ||
    JSON.stringify(uniqText(base.extra_user_ids)) !== JSON.stringify(uniqText(form.extra_user_ids)) ||
    String(base.note || '').trim() !== String(form.note || '').trim()
  )
}

export function policyStateMeta(policy: AppNotificationPolicy) {
  if (policy.enabled === false) return { color: 'red', text: '已禁用', desc: '当前业务事件不会发 App 通知' }
  if (Number(policy.version || 0) > 0) return { color: 'green', text: '已配置', desc: '当前使用自定义 App 通知策略' }
  return { color: 'gold', text: '默认模板', desc: '当前使用系统默认模板' }
}

export function formatPolicyUpdatedAt(raw: string | null) {
  if (!raw) return '-'
  const d = new Date(raw)
  if (!Number.isFinite(d.getTime())) return raw
  return d.toLocaleString()
}

export function expandTemplateGroupKeys(policyKey: string, templateKey: AppNotificationTemplateKey) {
  const participantGroup = PARTICIPANT_GROUP_BY_POLICY[policyKey] || 'cleaning_task_participants'
  if (templateKey === 'participants_only') return [participantGroup]
  if (templateKey === 'participants_plus_ops_manager') return [participantGroup, 'ops_manager_users']
  if (templateKey === 'participants_plus_ops_manager_and_customer_service') return [participantGroup, 'ops_manager_users', 'customer_service_users']
  if (templateKey === 'inspection_plus_ops_manager') return ['inspection_task_participants', 'ops_manager_users']
  if (templateKey === 'worktask_assignee_plus_ops_manager') return ['work_task_assignee', 'ops_manager_users']
  if (templateKey === 'ops_manager_only') return ['ops_manager_users']
  return []
}

export function buildPolicySummary(args: {
  policyKey: string
  templateKey: AppNotificationTemplateKey
  extraGroupKeys: AppNotificationGroupKey[]
  extraUserIds: string[]
  groups: AppNotificationGroupOption[]
  templates: AppNotificationTemplateOption[]
  users: AppNotificationUser[]
}) {
  const template = args.templates.find((item) => item.key === args.templateKey) || null
  const groupLabelByKey = new Map(args.groups.map((item) => [item.key, item.label]))
  const userLabelById = new Map(args.users.map((item) => [item.id, item.username]))
  const participantGroup = PARTICIPANT_GROUP_BY_POLICY[args.policyKey] || 'cleaning_task_participants'
  const participantLabel = PARTICIPANT_LABEL_BY_GROUP[participantGroup] || '当前任务参与人'
  const pieces: string[] = []
  if (args.templateKey === 'participants_only') pieces.push(participantLabel)
  else if (args.templateKey === 'participants_plus_ops_manager') pieces.push(`${participantLabel} + 运营经理组`)
  else if (args.templateKey === 'participants_plus_ops_manager_and_customer_service') pieces.push(`${participantLabel} + 运营经理组 + 客服`)
  else if (args.templateKey === 'inspection_plus_ops_manager') pieces.push('当前检查参与人 + 运营经理组')
  else if (args.templateKey === 'worktask_assignee_plus_ops_manager') pieces.push('当前线下任务执行人 + 运营经理组')
  else if (args.templateKey === 'ops_manager_only') pieces.push('运营经理组')
  else if (template?.summary_label) pieces.push(template.summary_label)
  for (const groupKey of uniqText(args.extraGroupKeys).filter((key) => !expandTemplateGroupKeys(args.policyKey, args.templateKey).includes(key as any))) {
    const label = groupLabelByKey.get(groupKey as AppNotificationGroupKey)
    if (label) pieces.push(label)
  }
  for (const userId of uniqText(args.extraUserIds)) {
    const label = userLabelById.get(userId)
    if (label) pieces.push(label)
  }
  if (!pieces.length) return '当前无接收人'
  if (args.templateKey === 'explicit_only' && pieces.length === 1 && pieces[0] === '仅显式追加') return '仅显式追加（当前无接收人）'
  return pieces.join(' + ')
}
