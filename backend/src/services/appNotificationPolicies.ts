import { v4 as uuid } from 'uuid'
import { hasPg, pgPool, pgRunInTransaction } from '../dbAdapter'
import { listUserIdsByRoles } from '../modules/notifications'

export const APP_NOTIFICATION_POLICY_KEYS = [
  'guest_checked_out',
  'guest_checked_out_cancelled',
  'task_requirements_changed',
  'task_deleted',
  'key_photo_uploaded',
  'key_photo_deleted',
  'issue_reported',
  'consumables_submitted',
  'consumables_need_restock',
  'restock_done',
  'completion_photos_saved',
  'keys_hung',
  'restock_proof_saved',
  'task_ready',
  'guest_luggage_updated',
  'warehouse_key_updated',
  'work_task_updated',
  'work_task_completed',
  'day_end_handover_reminder',
  'day_end_handover_manager_reminder',
  'key_upload_reminder',
  'key_upload_sla_reminder',
  'key_upload_sla_escalation',
] as const

export type AppNotificationPolicyKey = (typeof APP_NOTIFICATION_POLICY_KEYS)[number]

export const APP_NOTIFICATION_GROUP_KEYS = [
  'admin_users',
  'offline_manager_users',
  'customer_service_users',
  'ops_manager_users',
  'task_cleaner',
  'task_inspector',
  'task_assignee',
  'cleaning_task_participants',
  'inspection_task_participants',
  'work_task_assignee',
  'warehouse_related_users',
] as const

export type AppNotificationGroupKey = (typeof APP_NOTIFICATION_GROUP_KEYS)[number]

export const APP_NOTIFICATION_TEMPLATE_KEYS = [
  'participants_only',
  'participants_plus_ops_manager',
  'participants_plus_ops_manager_and_customer_service',
  'inspection_plus_ops_manager',
  'worktask_assignee_plus_ops_manager',
  'ops_manager_only',
  'explicit_only',
] as const

export type AppNotificationTemplateKey = (typeof APP_NOTIFICATION_TEMPLATE_KEYS)[number]

export const APP_NOTIFICATION_GROUP_ROLE_KEYS: Partial<Record<AppNotificationGroupKey, string[]>> = {
  admin_users: ['admin'],
  offline_manager_users: ['offline_manager'],
  customer_service_users: ['customer_service'],
  ops_manager_users: ['admin', 'offline_manager'],
}

type ParticipantGroupKey = 'cleaning_task_participants' | 'work_task_assignee' | 'warehouse_related_users'

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

export type AppNotificationPolicyCatalogMeta = {
  policy_key: AppNotificationPolicyKey
  label: string
  description: string
  source_event_types: string[]
  default_template_key: AppNotificationTemplateKey
  allowed_group_keys: AppNotificationGroupKey[]
  supports_extra_users: boolean
  default_enabled: boolean
}

type AppNotificationPolicyCatalogEntry = AppNotificationPolicyCatalogMeta & {
  participant_group_key: ParticipantGroupKey
}

export type AppNotificationPolicyRecord = {
  policy_key: AppNotificationPolicyKey
  enabled: boolean
  template_key: AppNotificationTemplateKey
  extra_group_keys: AppNotificationGroupKey[]
  extra_user_ids: string[]
  note: string | null
  version: number
  updated_at: string | null
  updated_by: string | null
  updated_by_name?: string | null
  catalog_meta: AppNotificationPolicyCatalogMeta
}

type StoredAppPolicyRow = {
  policy_key: AppNotificationPolicyKey
  enabled: boolean
  template_key: AppNotificationTemplateKey
  extra_group_keys: AppNotificationGroupKey[]
  extra_user_ids: string[]
  note: string | null
  version: number
  updated_at: string | null
  updated_by: string | null
}

type AppNotificationResolutionParams = {
  entity: string
  entityId: string
  data?: any
}

const ALL_APP_ALLOWED_GROUP_KEYS = APP_NOTIFICATION_GROUP_KEYS.slice() as AppNotificationGroupKey[]

export const APP_NOTIFICATION_GROUP_OPTIONS: AppNotificationGroupOption[] = [
  { key: 'admin_users', label: 'Admin', description: '系统管理员' },
  { key: 'offline_manager_users', label: '线下经理', description: '线下运营经理' },
  { key: 'customer_service_users', label: '客服', description: '客服角色，始终单独配置' },
  { key: 'ops_manager_users', label: '运营经理组（admin + 线下经理）', description: '固定等于 admin + 线下经理，不包含客服' },
  { key: 'task_cleaner', label: '当前清洁员', description: '当前清洁任务 cleaner / assignee' },
  { key: 'task_inspector', label: '当前检查员', description: '当前清洁任务 inspector' },
  { key: 'task_assignee', label: '当前任务执行人', description: '当前清洁任务 assignee' },
  { key: 'cleaning_task_participants', label: '当前任务参与人', description: '当前清洁任务 cleaner / inspector / assignee' },
  { key: 'inspection_task_participants', label: '当前检查参与人', description: '当前清洁任务 inspector / assignee' },
  { key: 'work_task_assignee', label: '当前线下任务执行人', description: '当前 work task 的 assignee' },
  { key: 'warehouse_related_users', label: '仓库相关人', description: '从事件 payload 显式提供的仓库相关用户' },
]

export const APP_NOTIFICATION_TEMPLATE_OPTIONS: AppNotificationTemplateOption[] = [
  { key: 'participants_only', label: '仅当前参与人', description: '只通知当前业务参与人', summary_label: '当前任务参与人' },
  { key: 'participants_plus_ops_manager', label: '参与人 + 运营经理组', description: '当前业务参与人 + 运营经理组', summary_label: '当前任务参与人 + 运营经理组' },
  {
    key: 'participants_plus_ops_manager_and_customer_service',
    label: '参与人 + 运营经理组 + 客服',
    description: '当前业务参与人 + 运营经理组 + 客服',
    summary_label: '当前任务参与人 + 运营经理组 + 客服',
  },
  {
    key: 'inspection_plus_ops_manager',
    label: '检查参与人 + 运营经理组',
    description: '当前检查参与人 + 运营经理组',
    summary_label: '当前检查参与人 + 运营经理组',
  },
  {
    key: 'worktask_assignee_plus_ops_manager',
    label: '线下任务执行人 + 运营经理组',
    description: '当前线下任务执行人 + 运营经理组',
    summary_label: '当前线下任务执行人 + 运营经理组',
  },
  { key: 'ops_manager_only', label: '仅运营经理组', description: '只通知运营经理组', summary_label: '运营经理组' },
  { key: 'explicit_only', label: '仅显式追加', description: '不带默认组，只通知附加接收组和指定个人', summary_label: '仅显式追加' },
]

const APP_NOTIFICATION_POLICY_CATALOG: Record<AppNotificationPolicyKey, AppNotificationPolicyCatalogEntry> = {
  guest_checked_out: {
    policy_key: 'guest_checked_out',
    label: '客人已退房',
    description: '退房任务完成后的 App 通知',
    source_event_types: ['CLEANING_TASK_UPDATED'],
    default_template_key: 'participants_plus_ops_manager_and_customer_service',
    allowed_group_keys: ALL_APP_ALLOWED_GROUP_KEYS,
    supports_extra_users: true,
    default_enabled: true,
    participant_group_key: 'cleaning_task_participants',
  },
  guest_checked_out_cancelled: {
    policy_key: 'guest_checked_out_cancelled',
    label: '退房标记已取消',
    description: '取消客人已退房后的 App 通知',
    source_event_types: ['CLEANING_TASK_UPDATED'],
    default_template_key: 'participants_plus_ops_manager_and_customer_service',
    allowed_group_keys: ALL_APP_ALLOWED_GROUP_KEYS,
    supports_extra_users: true,
    default_enabled: true,
    participant_group_key: 'cleaning_task_participants',
  },
  task_requirements_changed: {
    policy_key: 'task_requirements_changed',
    label: '任务要求变更',
    description: '退房时间、密码、客需、钥匙套数等任务要求变更',
    source_event_types: ['CLEANING_TASK_UPDATED'],
    default_template_key: 'participants_plus_ops_manager_and_customer_service',
    allowed_group_keys: ALL_APP_ALLOWED_GROUP_KEYS,
    supports_extra_users: true,
    default_enabled: true,
    participant_group_key: 'cleaning_task_participants',
  },
  task_deleted: {
    policy_key: 'task_deleted',
    label: '任务已删除',
    description: '退房、入住或入住中清洁任务被删除后的 App 通知',
    source_event_types: ['CLEANING_TASK_UPDATED'],
    default_template_key: 'participants_plus_ops_manager',
    allowed_group_keys: ALL_APP_ALLOWED_GROUP_KEYS,
    supports_extra_users: true,
    default_enabled: true,
    participant_group_key: 'cleaning_task_participants',
  },
  key_photo_uploaded: {
    policy_key: 'key_photo_uploaded',
    label: '钥匙照片已上传',
    description: '清洁员上传钥匙照片后的 App 通知',
    source_event_types: ['KEY_PHOTO_UPLOADED'],
    default_template_key: 'participants_plus_ops_manager',
    allowed_group_keys: ALL_APP_ALLOWED_GROUP_KEYS,
    supports_extra_users: true,
    default_enabled: true,
    participant_group_key: 'cleaning_task_participants',
  },
  key_photo_deleted: {
    policy_key: 'key_photo_deleted',
    label: '钥匙照片已删除',
    description: '钥匙照片被删除后的 App 通知',
    source_event_types: ['CLEANING_TASK_UPDATED'],
    default_template_key: 'participants_plus_ops_manager',
    allowed_group_keys: ALL_APP_ALLOWED_GROUP_KEYS,
    supports_extra_users: true,
    default_enabled: true,
    participant_group_key: 'cleaning_task_participants',
  },
  issue_reported: {
    policy_key: 'issue_reported',
    label: '问题上报',
    description: '任务或房源问题反馈',
    source_event_types: ['ISSUE_REPORTED'],
    default_template_key: 'participants_plus_ops_manager_and_customer_service',
    allowed_group_keys: ALL_APP_ALLOWED_GROUP_KEYS,
    supports_extra_users: true,
    default_enabled: true,
    participant_group_key: 'cleaning_task_participants',
  },
  consumables_submitted: {
    policy_key: 'consumables_submitted',
    label: '消耗品提交',
    description: '清洁员提交消耗品检查结果',
    source_event_types: ['CLEANING_TASK_UPDATED', 'CLEANING_COMPLETED'],
    default_template_key: 'participants_plus_ops_manager',
    allowed_group_keys: ALL_APP_ALLOWED_GROUP_KEYS,
    supports_extra_users: true,
    default_enabled: true,
    participant_group_key: 'cleaning_task_participants',
  },
  consumables_need_restock: {
    policy_key: 'consumables_need_restock',
    label: '消耗品待补货',
    description: '消耗品不足，需要检查或补货',
    source_event_types: ['WORK_TASK_UPDATED'],
    default_template_key: 'inspection_plus_ops_manager',
    allowed_group_keys: ALL_APP_ALLOWED_GROUP_KEYS,
    supports_extra_users: true,
    default_enabled: true,
    participant_group_key: 'cleaning_task_participants',
  },
  restock_done: {
    policy_key: 'restock_done',
    label: '补货完成',
    description: '补货任务已完成',
    source_event_types: ['WORK_TASK_UPDATED'],
    default_template_key: 'participants_plus_ops_manager',
    allowed_group_keys: ALL_APP_ALLOWED_GROUP_KEYS,
    supports_extra_users: true,
    default_enabled: true,
    participant_group_key: 'cleaning_task_participants',
  },
  completion_photos_saved: {
    policy_key: 'completion_photos_saved',
    label: '完成照片已提交',
    description: '清洁员提交完成照片',
    source_event_types: ['CLEANING_TASK_UPDATED'],
    default_template_key: 'participants_plus_ops_manager',
    allowed_group_keys: ALL_APP_ALLOWED_GROUP_KEYS,
    supports_extra_users: true,
    default_enabled: true,
    participant_group_key: 'cleaning_task_participants',
  },
  keys_hung: {
    policy_key: 'keys_hung',
    label: '已挂钥匙',
    description: '挂钥匙视频已上传',
    source_event_types: ['WORK_TASK_UPDATED'],
    default_template_key: 'participants_plus_ops_manager',
    allowed_group_keys: ALL_APP_ALLOWED_GROUP_KEYS,
    supports_extra_users: true,
    default_enabled: true,
    participant_group_key: 'cleaning_task_participants',
  },
  restock_proof_saved: {
    policy_key: 'restock_proof_saved',
    label: '补货凭证已提交',
    description: '检查员提交补货凭证或确认',
    source_event_types: ['CLEANING_TASK_UPDATED'],
    default_template_key: 'participants_plus_ops_manager',
    allowed_group_keys: ALL_APP_ALLOWED_GROUP_KEYS,
    supports_extra_users: true,
    default_enabled: true,
    participant_group_key: 'cleaning_task_participants',
  },
  task_ready: {
    policy_key: 'task_ready',
    label: '房源已可入住',
    description: '任务已进入可入住状态',
    source_event_types: ['CLEANING_TASK_UPDATED'],
    default_template_key: 'participants_plus_ops_manager',
    allowed_group_keys: ALL_APP_ALLOWED_GROUP_KEYS,
    supports_extra_users: true,
    default_enabled: true,
    participant_group_key: 'cleaning_task_participants',
  },
  guest_luggage_updated: {
    policy_key: 'guest_luggage_updated',
    label: '当天任务临时通知',
    description: '当天任务的行李 / 临时通知更新',
    source_event_types: ['GUEST_LUGGAGE_UPDATED'],
    default_template_key: 'participants_plus_ops_manager_and_customer_service',
    allowed_group_keys: ALL_APP_ALLOWED_GROUP_KEYS,
    supports_extra_users: true,
    default_enabled: true,
    participant_group_key: 'cleaning_task_participants',
  },
  warehouse_key_updated: {
    policy_key: 'warehouse_key_updated',
    label: '仓库钥匙更新',
    description: '仓库钥匙交接或状态更新',
    source_event_types: ['WAREHOUSE_KEY_UPDATED'],
    default_template_key: 'participants_plus_ops_manager',
    allowed_group_keys: ALL_APP_ALLOWED_GROUP_KEYS,
    supports_extra_users: true,
    default_enabled: true,
    participant_group_key: 'warehouse_related_users',
  },
  work_task_updated: {
    policy_key: 'work_task_updated',
    label: '线下任务更新',
    description: 'work task 指派或详情更新',
    source_event_types: ['WORK_TASK_UPDATED'],
    default_template_key: 'worktask_assignee_plus_ops_manager',
    allowed_group_keys: ALL_APP_ALLOWED_GROUP_KEYS,
    supports_extra_users: true,
    default_enabled: true,
    participant_group_key: 'work_task_assignee',
  },
  work_task_completed: {
    policy_key: 'work_task_completed',
    label: '线下任务完成',
    description: 'work task 被标记完成',
    source_event_types: ['WORK_TASK_COMPLETED'],
    default_template_key: 'worktask_assignee_plus_ops_manager',
    allowed_group_keys: ALL_APP_ALLOWED_GROUP_KEYS,
    supports_extra_users: true,
    default_enabled: true,
    participant_group_key: 'work_task_assignee',
  },
  day_end_handover_reminder: {
    policy_key: 'day_end_handover_reminder',
    label: '日终交接提醒',
    description: '提醒相关人员提交日终交接',
    source_event_types: ['DAY_END_HANDOVER_REMINDER'],
    default_template_key: 'explicit_only',
    allowed_group_keys: ALL_APP_ALLOWED_GROUP_KEYS,
    supports_extra_users: true,
    default_enabled: true,
    participant_group_key: 'work_task_assignee',
  },
  day_end_handover_manager_reminder: {
    policy_key: 'day_end_handover_manager_reminder',
    label: '日终交接经理提醒',
    description: '有人未提交日终交接时提醒运营经理组',
    source_event_types: ['DAY_END_HANDOVER_MANAGER_REMINDER'],
    default_template_key: 'ops_manager_only',
    allowed_group_keys: ALL_APP_ALLOWED_GROUP_KEYS,
    supports_extra_users: true,
    default_enabled: true,
    participant_group_key: 'work_task_assignee',
  },
  key_upload_reminder: {
    policy_key: 'key_upload_reminder',
    label: '钥匙照片提醒',
    description: '提醒上传或检查钥匙照片',
    source_event_types: ['KEY_UPLOAD_REMINDER'],
    default_template_key: 'explicit_only',
    allowed_group_keys: ALL_APP_ALLOWED_GROUP_KEYS,
    supports_extra_users: true,
    default_enabled: true,
    participant_group_key: 'cleaning_task_participants',
  },
  key_upload_sla_reminder: {
    policy_key: 'key_upload_sla_reminder',
    label: '钥匙照片 SLA 提醒',
    description: 'SLA 时限提醒执行人上传钥匙照片',
    source_event_types: ['KEY_UPLOAD_SLA_REMINDER'],
    default_template_key: 'explicit_only',
    allowed_group_keys: ALL_APP_ALLOWED_GROUP_KEYS,
    supports_extra_users: true,
    default_enabled: true,
    participant_group_key: 'cleaning_task_participants',
  },
  key_upload_sla_escalation: {
    policy_key: 'key_upload_sla_escalation',
    label: '钥匙照片 SLA 升级',
    description: 'SLA 超时后升级提醒运营经理组',
    source_event_types: ['KEY_UPLOAD_SLA_ESCALATION'],
    default_template_key: 'ops_manager_only',
    allowed_group_keys: ALL_APP_ALLOWED_GROUP_KEYS,
    supports_extra_users: true,
    default_enabled: true,
    participant_group_key: 'cleaning_task_participants',
  },
}

function uniqText(items: any[]) {
  return Array.from(new Set((items || []).map((item) => String(item || '').trim()).filter(Boolean)))
}

function uniqGroupKeys(items: any[]) {
  return uniqText(items).filter((item): item is AppNotificationGroupKey => isAppNotificationGroupKey(item))
}

export function isAppNotificationPolicyKey(raw: string): raw is AppNotificationPolicyKey {
  return (APP_NOTIFICATION_POLICY_KEYS as readonly string[]).includes(String(raw || '').trim())
}

export function isAppNotificationGroupKey(raw: string): raw is AppNotificationGroupKey {
  return (APP_NOTIFICATION_GROUP_KEYS as readonly string[]).includes(String(raw || '').trim())
}

export function isAppNotificationTemplateKey(raw: string): raw is AppNotificationTemplateKey {
  return (APP_NOTIFICATION_TEMPLATE_KEYS as readonly string[]).includes(String(raw || '').trim())
}

export function getAppNotificationPolicyCatalogMeta(policyKey: AppNotificationPolicyKey): AppNotificationPolicyCatalogMeta {
  const entry = APP_NOTIFICATION_POLICY_CATALOG[policyKey]
  return {
    policy_key: entry.policy_key,
    label: entry.label,
    description: entry.description,
    source_event_types: entry.source_event_types.slice(),
    default_template_key: entry.default_template_key,
    allowed_group_keys: entry.allowed_group_keys.slice(),
    supports_extra_users: entry.supports_extra_users,
    default_enabled: entry.default_enabled,
  }
}

export function listAppNotificationPolicyCatalog() {
  return APP_NOTIFICATION_POLICY_KEYS.map((policyKey) => getAppNotificationPolicyCatalogMeta(policyKey))
}

export function getAppNotificationTemplateOption(templateKey: AppNotificationTemplateKey) {
  return APP_NOTIFICATION_TEMPLATE_OPTIONS.find((item) => item.key === templateKey) || null
}

export function resolveAppPolicyTemplateGroupKeys(policyKey: AppNotificationPolicyKey, templateKey: AppNotificationTemplateKey): AppNotificationGroupKey[] {
  const participantGroupKey = APP_NOTIFICATION_POLICY_CATALOG[policyKey].participant_group_key
  if (templateKey === 'participants_only') return [participantGroupKey]
  if (templateKey === 'participants_plus_ops_manager') return [participantGroupKey, 'ops_manager_users']
  if (templateKey === 'participants_plus_ops_manager_and_customer_service') return [participantGroupKey, 'ops_manager_users', 'customer_service_users']
  if (templateKey === 'inspection_plus_ops_manager') return ['inspection_task_participants', 'ops_manager_users']
  if (templateKey === 'worktask_assignee_plus_ops_manager') return ['work_task_assignee', 'ops_manager_users']
  if (templateKey === 'ops_manager_only') return ['ops_manager_users']
  return []
}

export function resolveAppPolicyKeyFromKind(kindRaw: string, extras?: { level?: string | null }) {
  const kind = String(kindRaw || '').trim().toLowerCase()
  if (!kind) return null
  if (kind === 'guest_checked_out') return 'guest_checked_out'
  if (kind === 'guest_checked_out_cancelled') return 'guest_checked_out_cancelled'
  if (kind === 'cleaning_task_manager_fields_updated') return 'task_requirements_changed'
  if (kind === 'key_photo_uploaded') return 'key_photo_uploaded'
  if (kind === 'key_photo_deleted') return 'key_photo_deleted'
  if (kind === 'issue_reported') return 'issue_reported'
  if (kind === 'consumables_submitted' || kind === 'consumables_updated') return 'consumables_submitted'
  if (kind === 'consumables_need_restock') return 'consumables_need_restock'
  if (kind === 'restock_done') return 'restock_done'
  if (kind === 'completion_photos_saved') return 'completion_photos_saved'
  if (kind === 'keys_hung') return 'keys_hung'
  if (kind === 'restock_proof_saved' || kind === 'restock_sufficient_confirmed') return 'restock_proof_saved'
  if (kind === 'ready' || kind === 'task_ready') return 'task_ready'
  if (kind === 'guest_luggage_updated' || kind === 'guest_luggage_deleted') return 'guest_luggage_updated'
  if (kind === 'warehouse_key_updated') return 'warehouse_key_updated'
  if (kind === 'work_task_updated') return 'work_task_updated'
  if (kind === 'work_task_completed') return 'work_task_completed'
  if (kind === 'day_end_handover_reminder') return 'day_end_handover_reminder'
  if (kind === 'day_end_handover_manager_reminder') return 'day_end_handover_manager_reminder'
  if (kind === 'key_upload_reminder') return 'key_upload_reminder'
  if (kind === 'key_upload_sla') {
    const level = String(extras?.level || '').trim().toLowerCase()
    return level === 'escalation' ? 'key_upload_sla_escalation' : 'key_upload_sla_reminder'
  }
  return null
}

async function ensureAppNotificationPolicyTable() {
  if (!hasPg || !pgPool) return
  await pgPool.query(
    `CREATE TABLE IF NOT EXISTS app_notification_policies (
      policy_key text PRIMARY KEY,
      enabled boolean NOT NULL DEFAULT true,
      template_key text NOT NULL,
      extra_group_keys text[] NOT NULL DEFAULT ARRAY[]::text[],
      extra_user_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
      note text,
      version integer NOT NULL DEFAULT 1,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text
    );`,
  )
}

async function getUpdatedByName(userId: string | null) {
  const uid = String(userId || '').trim()
  if (!uid || !hasPg || !pgPool) return null
  try {
    const r = await pgPool.query(
      `SELECT COALESCE(NULLIF(TRIM(username), ''), NULLIF(TRIM(legal_name), ''), NULLIF(TRIM(email), ''), id::text) AS name
       FROM users
       WHERE id::text = $1
       LIMIT 1`,
      [uid],
    )
    return String(r?.rows?.[0]?.name || '').trim() || null
  } catch {
    return null
  }
}

function buildDefaultPolicyRow(policyKey: AppNotificationPolicyKey): StoredAppPolicyRow {
  const meta = APP_NOTIFICATION_POLICY_CATALOG[policyKey]
  return {
    policy_key: policyKey,
    enabled: meta.default_enabled !== false,
    template_key: meta.default_template_key,
    extra_group_keys: [],
    extra_user_ids: [],
    note: null,
    version: 0,
    updated_at: null,
    updated_by: null,
  }
}

async function getStoredAppNotificationPolicy(policyKey: AppNotificationPolicyKey): Promise<StoredAppPolicyRow | null> {
  if (!hasPg || !pgPool) return null
  await ensureAppNotificationPolicyTable()
  const r = await pgPool.query(
    `SELECT policy_key, enabled, template_key, extra_group_keys, extra_user_ids, note, version, updated_at, updated_by
     FROM app_notification_policies
     WHERE policy_key = $1
     LIMIT 1`,
    [policyKey],
  )
  const row = r?.rows?.[0] || null
  if (!row) return null
  const templateKey = String(row.template_key || '').trim()
  return {
    policy_key: policyKey,
    enabled: row.enabled !== false,
    template_key: isAppNotificationTemplateKey(templateKey) ? templateKey : APP_NOTIFICATION_POLICY_CATALOG[policyKey].default_template_key,
    extra_group_keys: uniqGroupKeys(row.extra_group_keys || []),
    extra_user_ids: uniqText(row.extra_user_ids || []),
    note: row.note == null ? null : String(row.note || ''),
    version: Number(row.version || 1),
    updated_at: row.updated_at ? String(row.updated_at) : null,
    updated_by: row.updated_by == null ? null : String(row.updated_by || ''),
  }
}

function toAppNotificationPolicyRecord(row: StoredAppPolicyRow, updatedByName: string | null): AppNotificationPolicyRecord {
  return {
    policy_key: row.policy_key,
    enabled: row.enabled !== false,
    template_key: row.template_key,
    extra_group_keys: row.extra_group_keys.slice(),
    extra_user_ids: row.extra_user_ids.slice(),
    note: row.note ?? null,
    version: row.version,
    updated_at: row.updated_at,
    updated_by: row.updated_by,
    updated_by_name: updatedByName,
    catalog_meta: getAppNotificationPolicyCatalogMeta(row.policy_key),
  }
}

export async function getAppNotificationPolicy(policyKey: AppNotificationPolicyKey) {
  const row = (await getStoredAppNotificationPolicy(policyKey)) || buildDefaultPolicyRow(policyKey)
  return toAppNotificationPolicyRecord(row, await getUpdatedByName(row.updated_by))
}

export async function listAppNotificationPolicies() {
  const out: AppNotificationPolicyRecord[] = []
  for (const policyKey of APP_NOTIFICATION_POLICY_KEYS) out.push(await getAppNotificationPolicy(policyKey))
  return out
}

export async function saveAppNotificationPolicy(
  policyKey: AppNotificationPolicyKey,
  payload: {
    enabled: boolean
    template_key: AppNotificationTemplateKey
    extra_group_keys?: AppNotificationGroupKey[] | null
    extra_user_ids?: string[] | null
    note?: string | null
  },
  updatedBy: string | null,
) {
  if (!hasPg || !pgPool) throw new Error('database not available')
  await ensureAppNotificationPolicyTable()
  const meta = APP_NOTIFICATION_POLICY_CATALOG[policyKey]
  const templateKey = payload.template_key
  if (!isAppNotificationTemplateKey(templateKey)) throw new Error('invalid_template_key')
  const extraGroupKeys = uniqGroupKeys(payload.extra_group_keys || []).filter((item) => meta.allowed_group_keys.includes(item))
  const extraUserIds = uniqText(payload.extra_user_ids || [])
  const note = payload.note == null ? null : String(payload.note || '').trim() || null
  const actor = String(updatedBy || '').trim() || null
  await pgRunInTransaction(async (client) => {
    const current = await client.query(`SELECT version FROM app_notification_policies WHERE policy_key = $1 LIMIT 1`, [policyKey])
    const nextVersion = Number(current?.rows?.[0]?.version || 0) + 1
    await client.query(
      `INSERT INTO app_notification_policies
         (policy_key, enabled, template_key, extra_group_keys, extra_user_ids, note, version, updated_at, updated_by)
       VALUES
         ($1,$2,$3,$4::text[],$5::text[],$6,$7,now(),$8)
       ON CONFLICT (policy_key) DO UPDATE SET
         enabled = EXCLUDED.enabled,
         template_key = EXCLUDED.template_key,
         extra_group_keys = EXCLUDED.extra_group_keys,
         extra_user_ids = EXCLUDED.extra_user_ids,
         note = EXCLUDED.note,
         version = app_notification_policies.version + 1,
         updated_at = now(),
         updated_by = EXCLUDED.updated_by`,
      [policyKey, payload.enabled !== false, templateKey, extraGroupKeys, extraUserIds, note, nextVersion, actor],
    )
  })
  return await getAppNotificationPolicy(policyKey)
}

export async function resetAppNotificationPolicy(policyKey: AppNotificationPolicyKey, updatedBy: string | null) {
  const meta = APP_NOTIFICATION_POLICY_CATALOG[policyKey]
  return await saveAppNotificationPolicy(
    policyKey,
    {
      enabled: meta.default_enabled !== false,
      template_key: meta.default_template_key,
      extra_group_keys: [],
      extra_user_ids: [],
      note: null,
    },
    updatedBy,
  )
}

function resolveCleaningTaskIds(params: AppNotificationResolutionParams): string[] {
  const data = params.data && typeof params.data === 'object' ? params.data : {}
  const ids = [
    ...(Array.isArray(data.task_ids) ? data.task_ids : []),
    data.task_id,
    params.entity === 'cleaning_task' ? params.entityId : null,
  ]
  return uniqText(ids)
}

function resolveWorkTaskIds(params: AppNotificationResolutionParams): string[] {
  const data = params.data && typeof params.data === 'object' ? params.data : {}
  const ids = [data.work_task_id, data.task_id, params.entity === 'work_task' ? params.entityId : null]
  return uniqText(ids)
}

async function listCleaningTaskColumns(taskIds: string[], columns: Array<'cleaner_id' | 'inspector_id' | 'assignee_id'>, client: any): Promise<string[]> {
  const ids = uniqText(taskIds)
  if (!ids.length || !columns.length) return []
  const sqlColumns = columns.map((column) => `${column}::text AS ${column}`).join(', ')
  const r = await client.query(
    `SELECT ${sqlColumns}
     FROM cleaning_tasks
     WHERE id::text = ANY($1::text[])`,
    [ids],
  )
  const out: string[] = []
  for (const row of r?.rows || []) {
    for (const column of columns) {
      const value = String(row?.[column] || '').trim()
      if (value) out.push(value)
    }
  }
  return Array.from(new Set(out))
}

async function listWorkTaskAssigneeIds(taskIds: string[], client: any): Promise<string[]> {
  const ids = uniqText(taskIds)
  if (!ids.length) return []
  const r = await client.query(
    `SELECT assignee_id::text AS assignee_id
     FROM work_tasks
     WHERE id::text = ANY($1::text[])`,
    [ids],
  )
  return Array.from(new Set((r?.rows || []).map((row: any) => String(row.assignee_id || '').trim()).filter(Boolean)))
}

async function resolveWarehouseRelatedUsers(data: any): Promise<string[]> {
  return uniqText([
    ...(Array.isArray(data?.warehouse_related_user_ids) ? data.warehouse_related_user_ids : []),
    ...(Array.isArray(data?.related_user_ids) ? data.related_user_ids : []),
  ])
}

async function resolveAppNotificationGroupRecipients(groupKey: AppNotificationGroupKey, params: AppNotificationResolutionParams, client: any): Promise<string[]> {
  if (groupKey === 'admin_users') return await listUserIdsByRoles(['admin'])
  if (groupKey === 'offline_manager_users') return await listUserIdsByRoles(['offline_manager'])
  if (groupKey === 'customer_service_users') return await listUserIdsByRoles(['customer_service'])
  if (groupKey === 'ops_manager_users') return await listUserIdsByRoles(['admin', 'offline_manager'])
  if (groupKey === 'task_cleaner') return await listCleaningTaskColumns(resolveCleaningTaskIds(params), ['cleaner_id', 'assignee_id'], client)
  if (groupKey === 'task_inspector') return await listCleaningTaskColumns(resolveCleaningTaskIds(params), ['inspector_id'], client)
  if (groupKey === 'task_assignee') return await listCleaningTaskColumns(resolveCleaningTaskIds(params), ['assignee_id'], client)
  if (groupKey === 'cleaning_task_participants') return await listCleaningTaskColumns(resolveCleaningTaskIds(params), ['cleaner_id', 'inspector_id', 'assignee_id'], client)
  if (groupKey === 'inspection_task_participants') return await listCleaningTaskColumns(resolveCleaningTaskIds(params), ['inspector_id', 'assignee_id'], client)
  if (groupKey === 'work_task_assignee') return await listWorkTaskAssigneeIds(resolveWorkTaskIds(params), client)
  if (groupKey === 'warehouse_related_users') return await resolveWarehouseRelatedUsers(params.data || {})
  return []
}

export async function resolveAppNotificationPolicyRecipients(
  policyKey: AppNotificationPolicyKey,
  params: AppNotificationResolutionParams,
  client: any,
) {
  const policy = await getAppNotificationPolicy(policyKey)
  const templateGroupKeys = resolveAppPolicyTemplateGroupKeys(policyKey, policy.template_key)
  const selectedGroupKeys = Array.from(
    new Set<AppNotificationGroupKey>([
      ...templateGroupKeys,
      ...(policy.extra_group_keys as AppNotificationGroupKey[]),
    ]),
  )
  const audienceCounts: Record<string, number> = {}
  const recipients: string[] = []
  for (const groupKey of selectedGroupKeys) {
    const ids = await resolveAppNotificationGroupRecipients(groupKey, params, client)
    audienceCounts[groupKey] = ids.length
    recipients.push(...ids)
  }
  recipients.push(...policy.extra_user_ids)
  return {
    policy,
    template_group_keys: templateGroupKeys,
    selected_group_keys: selectedGroupKeys,
    audience_counts: audienceCounts,
    recipients: Array.from(new Set(recipients.filter(Boolean))),
  }
}
