import { v4 as uuid } from 'uuid'
import { hasPg, pgPool, pgRunInTransaction } from '../dbAdapter'

export const ALL_NOTIFICATION_EVENT_TYPES = [
  'ORDER_UPDATED',
  'CLEANING_TASK_UPDATED',
  'CLEANING_COMPLETED',
  'INSPECTION_COMPLETED',
  'KEY_PHOTO_UPLOADED',
  'ISSUE_REPORTED',
  'WORK_TASK_UPDATED',
  'WORK_TASK_COMPLETED',
  'DAY_END_HANDOVER_REMINDER',
  'DAY_END_HANDOVER_MANAGER_REMINDER',
  'KEY_UPLOAD_REMINDER',
  'KEY_UPLOAD_SLA_REMINDER',
  'KEY_UPLOAD_SLA_ESCALATION',
] as const

export type NotificationManagedEventType = (typeof ALL_NOTIFICATION_EVENT_TYPES)[number]
export type NotificationAudienceType = 'order_related_users' | 'cleaning_task_users' | 'inspection_task_users' | 'work_task_users' | 'manager_users'
export type NotificationRuleRecipientType = 'role' | 'audience' | 'user'
export type NotificationRuleConfigState = 'no_config' | 'configured' | 'empty_config' | 'disabled'

export type NotificationRuleSelector = {
  recipient_type: NotificationRuleRecipientType
  recipient_value: string
}

export type NotificationRuleTemplate = {
  enabled: boolean
  note?: string | null
  selectors: NotificationRuleSelector[]
}

export const NOTIFICATION_AUDIENCE_OPTIONS: Array<{ value: NotificationAudienceType; label: string; description: string }> = [
  { value: 'order_related_users', label: '订单关联人', description: '关联 cleaning task 的 cleaner / inspector / assignee' },
  { value: 'cleaning_task_users', label: '清洁任务参与人', description: '当前 cleaning task 的 cleaner / inspector / assignee' },
  { value: 'inspection_task_users', label: '检查任务参与人', description: '当前 inspection task 的 inspector / assignee' },
  { value: 'work_task_users', label: '任务执行人', description: '当前 work task 的 assignee' },
  { value: 'manager_users', label: '默认经理组', description: 'admin + offline_manager + customer_service' },
]

export const DEFAULT_NOTIFICATION_RULE_TEMPLATES: Record<NotificationManagedEventType, NotificationRuleTemplate> = {
  ORDER_UPDATED: {
    enabled: true,
    note: '默认通知订单关联清洁任务参与人和经理组',
    selectors: [
      { recipient_type: 'audience', recipient_value: 'order_related_users' },
      { recipient_type: 'audience', recipient_value: 'manager_users' },
    ],
  },
  CLEANING_TASK_UPDATED: {
    enabled: true,
    note: '默认通知清洁任务参与人和经理组',
    selectors: [
      { recipient_type: 'audience', recipient_value: 'cleaning_task_users' },
      { recipient_type: 'audience', recipient_value: 'manager_users' },
    ],
  },
  CLEANING_COMPLETED: {
    enabled: true,
    note: '默认通知清洁任务参与人和经理组',
    selectors: [
      { recipient_type: 'audience', recipient_value: 'cleaning_task_users' },
      { recipient_type: 'audience', recipient_value: 'manager_users' },
    ],
  },
  INSPECTION_COMPLETED: {
    enabled: true,
    note: '默认通知检查任务参与人和经理组',
    selectors: [
      { recipient_type: 'audience', recipient_value: 'inspection_task_users' },
      { recipient_type: 'audience', recipient_value: 'manager_users' },
    ],
  },
  KEY_PHOTO_UPLOADED: {
    enabled: true,
    note: '默认通知清洁任务参与人和经理组',
    selectors: [
      { recipient_type: 'audience', recipient_value: 'cleaning_task_users' },
      { recipient_type: 'audience', recipient_value: 'manager_users' },
    ],
  },
  ISSUE_REPORTED: {
    enabled: true,
    note: '默认通知经理组',
    selectors: [{ recipient_type: 'audience', recipient_value: 'manager_users' }],
  },
  WORK_TASK_UPDATED: { enabled: true, note: '默认无固定收件人，需显式追加', selectors: [] },
  WORK_TASK_COMPLETED: {
    enabled: true,
    note: '默认通知任务执行人和经理组',
    selectors: [
      { recipient_type: 'audience', recipient_value: 'work_task_users' },
      { recipient_type: 'audience', recipient_value: 'manager_users' },
    ],
  },
  DAY_END_HANDOVER_REMINDER: { enabled: true, note: '默认无固定收件人，依赖调用方追加', selectors: [] },
  DAY_END_HANDOVER_MANAGER_REMINDER: {
    enabled: true,
    note: '默认通知经理组',
    selectors: [{ recipient_type: 'audience', recipient_value: 'manager_users' }],
  },
  KEY_UPLOAD_REMINDER: { enabled: true, note: '默认无固定收件人，依赖调用方追加', selectors: [] },
  KEY_UPLOAD_SLA_REMINDER: { enabled: true, note: '默认无固定收件人，依赖调用方追加', selectors: [] },
  KEY_UPLOAD_SLA_ESCALATION: {
    enabled: true,
    note: '默认通知经理组',
    selectors: [{ recipient_type: 'audience', recipient_value: 'manager_users' }],
  },
}

export type NotificationRuleRecord = {
  event_type: NotificationManagedEventType
  enabled: boolean
  version: number
  updated_at: string | null
  updated_by: string | null
  updated_by_name: string | null
  note: string | null
  selectors: NotificationRuleSelector[]
  config_state: NotificationRuleConfigState
  default_template: NotificationRuleTemplate
}

type StoredRuleRow = {
  event_type: NotificationManagedEventType
  enabled: boolean
  version: number
  updated_at: string | null
  updated_by: string | null
  note: string | null
}

function uniqSelectors(selectors: NotificationRuleSelector[]) {
  const seen = new Set<string>()
  const out: NotificationRuleSelector[] = []
  for (const item of selectors || []) {
    const recipient_type = String(item?.recipient_type || '').trim() as NotificationRuleRecipientType
    const recipient_value = String(item?.recipient_value || '').trim()
    if (!recipient_value || !['role', 'audience', 'user'].includes(recipient_type)) continue
    const key = `${recipient_type}:${recipient_value}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ recipient_type, recipient_value })
  }
  return out
}

export function isManagedNotificationEventType(raw: string): raw is NotificationManagedEventType {
  return (ALL_NOTIFICATION_EVENT_TYPES as readonly string[]).includes(String(raw || '').trim())
}

export async function ensureNotificationRuleTables() {
  if (!hasPg || !pgPool) return
  await pgPool.query(
    `CREATE TABLE IF NOT EXISTS notification_event_rules (
      event_type text PRIMARY KEY,
      enabled boolean NOT NULL DEFAULT true,
      version integer NOT NULL DEFAULT 1,
      note text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text
    );`,
  )
  await pgPool.query(
    `CREATE TABLE IF NOT EXISTS notification_event_rule_selectors (
      id text PRIMARY KEY,
      event_type text NOT NULL,
      recipient_type text NOT NULL,
      recipient_value text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );`,
  )
  await pgPool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_notification_rule_selector ON notification_event_rule_selectors(event_type, recipient_type, recipient_value);`)
  await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_notification_rule_selectors_event_type ON notification_event_rule_selectors(event_type);`)
}

async function getUpdatedByName(userId: string | null) {
  const uid = String(userId || '').trim()
  if (!uid || !hasPg || !pgPool) return null
  try {
    const r = await pgPool.query(
      `SELECT COALESCE(NULLIF(TRIM(username), ''), NULLIF(TRIM(legal_name), ''), NULLIF(TRIM(email), ''), id::text) AS name
       FROM users WHERE id::text = $1 LIMIT 1`,
      [uid],
    )
    return String(r?.rows?.[0]?.name || '').trim() || null
  } catch {
    return null
  }
}

async function getStoredRule(eventType: NotificationManagedEventType): Promise<{ row: StoredRuleRow | null; selectors: NotificationRuleSelector[] }> {
  if (!hasPg || !pgPool) return { row: null, selectors: [] }
  await ensureNotificationRuleTables()
  const ruleRes = await pgPool.query(`SELECT event_type, enabled, version, note, updated_at, updated_by FROM notification_event_rules WHERE event_type = $1 LIMIT 1`, [eventType])
  const row0 = ruleRes?.rows?.[0] || null
  if (!row0) return { row: null, selectors: [] }
  const selectorsRes = await pgPool.query(
    `SELECT recipient_type, recipient_value
     FROM notification_event_rule_selectors
     WHERE event_type = $1
     ORDER BY recipient_type ASC, recipient_value ASC`,
    [eventType],
  )
  return {
    row: {
      event_type: eventType,
      enabled: row0.enabled !== false,
      version: Number(row0.version || 1),
      note: row0.note == null ? null : String(row0.note || ''),
      updated_at: row0.updated_at ? String(row0.updated_at) : null,
      updated_by: row0.updated_by == null ? null : String(row0.updated_by || ''),
    },
    selectors: uniqSelectors((selectorsRes?.rows || []).map((row: any) => ({
      recipient_type: row.recipient_type,
      recipient_value: row.recipient_value,
    }))),
  }
}

function computeConfigState(row: StoredRuleRow | null, selectors: NotificationRuleSelector[]): NotificationRuleConfigState {
  if (!row) return 'no_config'
  if (row.enabled === false) return 'disabled'
  if (!selectors.length) return 'empty_config'
  return 'configured'
}

export async function getNotificationRule(eventType: NotificationManagedEventType): Promise<NotificationRuleRecord> {
  const { row, selectors } = await getStoredRule(eventType)
  const config_state = computeConfigState(row, selectors)
  const updated_by = row?.updated_by || null
  return {
    event_type: eventType,
    enabled: row ? row.enabled !== false : DEFAULT_NOTIFICATION_RULE_TEMPLATES[eventType].enabled,
    version: row ? Number(row.version || 1) : 0,
    updated_at: row?.updated_at || null,
    updated_by,
    updated_by_name: await getUpdatedByName(updated_by),
    note: row?.note ?? DEFAULT_NOTIFICATION_RULE_TEMPLATES[eventType].note ?? null,
    selectors,
    config_state,
    default_template: DEFAULT_NOTIFICATION_RULE_TEMPLATES[eventType],
  }
}

export async function listNotificationRules() {
  const out: NotificationRuleRecord[] = []
  for (const eventType of ALL_NOTIFICATION_EVENT_TYPES) out.push(await getNotificationRule(eventType))
  return out
}

export async function saveNotificationRule(
  eventType: NotificationManagedEventType,
  payload: { enabled: boolean; note?: string | null; selectors?: NotificationRuleSelector[] | null },
  updatedBy: string | null,
) {
  if (!hasPg || !pgPool) throw new Error('database not available')
  await ensureNotificationRuleTables()
  const selectors = uniqSelectors(payload.selectors || [])
  const actor = String(updatedBy || '').trim() || null
  await pgRunInTransaction(async (client) => {
    const current = await client.query(`SELECT version FROM notification_event_rules WHERE event_type = $1 LIMIT 1`, [eventType])
    const nextVersion = Number(current?.rows?.[0]?.version || 0) + 1
    await client.query(
      `INSERT INTO notification_event_rules (event_type, enabled, version, note, updated_at, updated_by)
       VALUES ($1,$2,$3,$4,now(),$5)
       ON CONFLICT (event_type) DO UPDATE SET
         enabled = EXCLUDED.enabled,
         version = notification_event_rules.version + 1,
         note = EXCLUDED.note,
         updated_at = now(),
         updated_by = EXCLUDED.updated_by`,
      [eventType, payload.enabled !== false, nextVersion, payload.note == null ? null : String(payload.note || ''), actor],
    )
    await client.query(`DELETE FROM notification_event_rule_selectors WHERE event_type = $1`, [eventType])
    for (const item of selectors) {
      await client.query(
        `INSERT INTO notification_event_rule_selectors (id, event_type, recipient_type, recipient_value)
         VALUES ($1,$2,$3,$4)`,
        [uuid(), eventType, item.recipient_type, item.recipient_value],
      )
    }
  })
  return await getNotificationRule(eventType)
}

export async function resetNotificationRule(eventType: NotificationManagedEventType, updatedBy: string | null) {
  const tpl = DEFAULT_NOTIFICATION_RULE_TEMPLATES[eventType]
  return await saveNotificationRule(
    eventType,
    {
      enabled: tpl.enabled !== false,
      note: tpl.note || null,
      selectors: tpl.selectors,
    },
    updatedBy,
  )
}

export async function resolveManagerUsersAudience() {
  if (!hasPg || !pgPool) return []
  const roles = ['admin', 'offline_manager', 'customer_service']
  const r = await pgPool.query(
    `SELECT DISTINCT u.id::text AS id
     FROM users u
     LEFT JOIN user_roles ur ON ur.user_id = u.id::text
     WHERE u.role = ANY($1::text[]) OR ur.role_name = ANY($1::text[])`,
    [roles],
  )
  return Array.from(new Set((r?.rows || []).map((x: any) => String(x.id || '').trim()).filter(Boolean)))
}
