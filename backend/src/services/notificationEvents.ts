import { v4 as uuid } from 'uuid'
import { hasPg, pgPool } from '../dbAdapter'
import { listInspectionTaskUserIds, listCleaningTaskUserIds, listUserIdsByRoles, listWorkTaskUserIds } from '../modules/notifications'
import {
  getNotificationRule,
  isManagedNotificationEventType,
  NotificationAudienceType,
  NotificationManagedEventType,
  NotificationRuleConfigState,
  resolveManagerUsersAudience,
} from './notificationRules'

export type NotificationPriority = 'high' | 'medium' | 'low'

export type NotificationEventType =
  | 'ORDER_UPDATED'
  | 'CLEANING_TASK_UPDATED'
  | 'CLEANING_COMPLETED'
  | 'INSPECTION_COMPLETED'
  | 'KEY_PHOTO_UPLOADED'
  | 'ISSUE_REPORTED'
  | 'WORK_TASK_COMPLETED'
  | 'DAY_END_HANDOVER_REMINDER'
  | 'DAY_END_HANDOVER_MANAGER_REMINDER'
  | 'KEY_UPLOAD_REMINDER'
  | 'KEY_UPLOAD_SLA_REMINDER'
  | 'KEY_UPLOAD_SLA_ESCALATION'
  | 'WORK_TASK_UPDATED'

export type EmitNotificationEventParams = {
  type: NotificationEventType
  entity: 'order' | 'cleaning_task' | 'work_task'
  entityId: string
  eventId?: string | null
  propertyId?: string | null
  updatedAt?: string | null
  changes?: string[] | null
  title?: string | null
  body?: string | null
  data?: any
  priority?: NotificationPriority
  actorUserId?: string | null
  excludeActor?: boolean
  recipientUserIds?: string[] | null
}

export type EmitNotificationEventOptions = {
  operationId?: string | null
  pgClient?: any
}

let ensured = false
let ensuring: Promise<void> | null = null

export async function ensureNotificationStorage() {
  if (!hasPg || !pgPool) return
  if (ensured) return
  if (ensuring) return ensuring
  ensuring = (async () => {
    await pgPool.query(
      `CREATE TABLE IF NOT EXISTS user_notifications (
        id text PRIMARY KEY,
        user_id text NOT NULL,
        event_id text NOT NULL,
        type text NOT NULL,
        entity text NOT NULL,
        entity_id text NOT NULL,
        changes text[],
        title text NOT NULL,
        body text NOT NULL,
        data jsonb,
        priority text NOT NULL,
        read_at timestamptz,
        created_at timestamptz DEFAULT now(),
        updated_at timestamptz DEFAULT now(),
        UNIQUE(user_id, event_id)
      );`,
    )
    await pgPool.query(`CREATE INDEX IF NOT EXISTS user_notifications_user_created_idx ON user_notifications (user_id, created_at DESC);`)
    await pgPool.query(`CREATE INDEX IF NOT EXISTS user_notifications_user_read_idx ON user_notifications (user_id, read_at);`)
    await pgPool.query(`CREATE INDEX IF NOT EXISTS user_notifications_event_id_idx ON user_notifications (event_id);`)

    await pgPool.query(
      `CREATE TABLE IF NOT EXISTS event_queue (
        id text PRIMARY KEY,
        user_notification_id text NOT NULL,
        user_id text NOT NULL,
        event_id text NOT NULL,
        status text NOT NULL,
        attempts int NOT NULL DEFAULT 0,
        run_after timestamptz NOT NULL DEFAULT now(),
        last_error text,
        created_at timestamptz DEFAULT now(),
        UNIQUE(user_id, event_id)
      );`,
    )
    await pgPool.query(`CREATE INDEX IF NOT EXISTS event_queue_status_run_after_idx ON event_queue (status, run_after);`)
    await pgPool.query(`CREATE INDEX IF NOT EXISTS event_queue_user_status_idx ON event_queue (user_id, status);`)

    await pgPool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS property_scope text[];`)
    await pgPool.query(`CREATE INDEX IF NOT EXISTS users_property_scope_gin_idx ON users USING GIN (property_scope);`)

    ensured = true
  })()
    .catch(() => {})
    .finally(() => {
      ensuring = null
    })
  return ensuring
}

function uniqText(items: any[]) {
  return Array.from(new Set((items || []).map((x) => String(x || '').trim()).filter(Boolean)))
}

function changeLabel(k: string) {
  const key = String(k || '').trim().toLowerCase()
  if (key === 'time') return '时间'
  if (key === 'note') return '备注'
  if (key === 'password') return '密码'
  if (key === 'keys') return '钥匙'
  if (key === 'status') return '状态'
  return key
}

function buildDefaultTitleBody(params: EmitNotificationEventParams) {
  const type = params.type
  const changes = uniqText(params.changes || []).map(changeLabel)
  const suffix = changes.length ? `（${changes.join(' + ')}）` : ''

  if (type === 'ORDER_UPDATED') return { title: `订单信息已更新${suffix}`, body: changes.length ? `已更新：${changes.join(' + ')}` : '订单信息已更新' }
  if (type === 'CLEANING_TASK_UPDATED') return { title: `清洁任务已更新${suffix}`, body: changes.length ? `已更新：${changes.join(' + ')}` : '清洁任务已更新' }
  if (type === 'CLEANING_COMPLETED') return { title: '房源已完成清洁', body: '清洁已完成' }
  if (type === 'INSPECTION_COMPLETED') return { title: '房源已完成检查', body: '检查已完成' }
  if (type === 'KEY_PHOTO_UPLOADED') return { title: '钥匙照片已上传', body: '钥匙照片已上传' }
  if (type === 'ISSUE_REPORTED') return { title: '房源问题反馈', body: '收到新的问题反馈' }
  if (type === 'WORK_TASK_COMPLETED') return { title: '任务已完成', body: '任务已标记完成' }
  if (type === 'DAY_END_HANDOVER_REMINDER') return { title: '提醒：提交日终交接', body: '请完成并提交日终交接任务' }
  if (type === 'DAY_END_HANDOVER_MANAGER_REMINDER') return { title: '提醒：有人未提交日终交接', body: '有人仍未提交日终交接，请及时跟进。' }
  if (type === 'KEY_UPLOAD_REMINDER') return { title: '提醒：上传钥匙照片', body: '请检查并上传钥匙照片' }
  if (type === 'KEY_UPLOAD_SLA_REMINDER') return { title: '上传钥匙提醒', body: '请尽快上传钥匙照片' }
  if (type === 'KEY_UPLOAD_SLA_ESCALATION') return { title: '上传钥匙超时提醒', body: '清洁员未按时上传钥匙照片' }
  if (type === 'WORK_TASK_UPDATED') return { title: '任务有更新', body: '任务已更新' }
  return { title: '通知', body: '有新的更新' }
}

async function listCleaningTaskUserIdsByOrderId(orderId: string, client: any) {
  const oid = String(orderId || '').trim()
  if (!oid) return []
  const r = await client.query(
    `SELECT cleaner_id::text AS cleaner_id, inspector_id::text AS inspector_id, assignee_id::text AS assignee_id
     FROM cleaning_tasks
     WHERE order_id::text = $1::text
       AND COALESCE(status,'') <> 'cancelled'`,
    [oid],
  )
  const out: string[] = []
  for (const row of r?.rows || []) {
    for (const v of [row.cleaner_id, row.inspector_id, row.assignee_id]) {
      const s = String(v || '').trim()
      if (s) out.push(s)
    }
  }
  return Array.from(new Set(out))
}

async function filterUserIdsByPropertyScope(userIds: string[], propertyId: string, client: any) {
  const ids = uniqText(userIds)
  const pid = String(propertyId || '').trim()
  if (!ids.length) return []
  if (!pid) return ids
  const r = await client.query(
    `SELECT id::text AS id
     FROM users
     WHERE id = ANY($1::text[])
       AND (property_scope IS NULL OR property_scope @> ARRAY[$2]::text[])`,
    [ids, pid],
  )
  return Array.from(new Set((r?.rows || []).map((x: any) => String(x.id || '').trim()).filter(Boolean)))
}

async function resolveRecipients(params: EmitNotificationEventParams, client: any) {
  return []
}

function shouldExcludeActor(params: EmitNotificationEventParams) {
  if (params.excludeActor === false) return false
  return true
}

function resolvePriority(params: EmitNotificationEventParams): NotificationPriority {
  const p = String(params.priority || '').trim()
  if (p === 'high' || p === 'medium' || p === 'low') return p
  if (params.type === 'CLEANING_TASK_UPDATED') {
    const changes = uniqText(params.changes || []).map((x) => x.toLowerCase())
    if (changes.includes('password')) return 'high'
    return 'medium'
  }
  if (params.type === 'ORDER_UPDATED') return 'medium'
  if (params.type === 'CLEANING_COMPLETED') return 'high'
  if (params.type === 'INSPECTION_COMPLETED') return 'high'
  if (params.type === 'KEY_PHOTO_UPLOADED') return 'high'
  if (params.type === 'ISSUE_REPORTED') return 'high'
  if (params.type === 'WORK_TASK_COMPLETED') return 'high'
  if (params.type === 'DAY_END_HANDOVER_REMINDER') return 'high'
  if (params.type === 'DAY_END_HANDOVER_MANAGER_REMINDER') return 'high'
  if (params.type === 'KEY_UPLOAD_REMINDER') return 'high'
  if (params.type === 'KEY_UPLOAD_SLA_REMINDER') return 'high'
  if (params.type === 'KEY_UPLOAD_SLA_ESCALATION') return 'high'
  return 'low'
}

function normalizeEventTimestamp(raw: any) {
  const s = String(raw || '').trim()
  if (!s) return null
  const d = new Date(s)
  if (!Number.isFinite(d.getTime())) return null
  return d.toISOString()
}

function logNoRecipients(params: EmitNotificationEventParams, eventId: string, hasExplicitRecipients: boolean, propertyId: string) {
  try {
    console.error(
      `[notifications][no_recipients] type=${String(params.type || '')} entity=${String(params.entity || '')} entity_id=${String(params.entityId || '')} event_id=${eventId} actor_user_id=${String(params.actorUserId || '')} has_explicit_recipients=${hasExplicitRecipients ? 'true' : 'false'} property_id=${propertyId || ''}`,
    )
  } catch {}
}

function logResolution(params: EmitNotificationEventParams, payload: {
  eventId: string
  configState: NotificationRuleConfigState
  ruleVersion: number
  selectedRoles: string[]
  selectedAudiences: string[]
  selectedUsersCount: number
  resolvedCountBeforeScope: number
  resolvedCountAfterScope: number
  resolvedCountAfterActor: number
  finalCount: number
  audienceCounts: Record<string, number>
}) {
  try {
    console.log(
      `[notifications][resolve] type=${String(params.type || '')} event_id=${payload.eventId} entity=${String(params.entity || '')} entity_id=${String(params.entityId || '')} rule_version=${payload.ruleVersion} config_state=${payload.configState} actor_user_id=${String(params.actorUserId || '')} has_explicit_recipients=${Array.isArray(params.recipientUserIds) && params.recipientUserIds.length ? 'true' : 'false'} selected_roles=${payload.selectedRoles.join(',')} selected_audiences=${payload.selectedAudiences.join(',')} selected_users_count=${payload.selectedUsersCount} audience_counts=${JSON.stringify(payload.audienceCounts)} resolved_count_before_scope=${payload.resolvedCountBeforeScope} resolved_count_after_scope=${payload.resolvedCountAfterScope} resolved_count_after_actor=${payload.resolvedCountAfterActor} final_count=${payload.finalCount}`,
    )
  } catch {}
}

function logDisabledRule(params: EmitNotificationEventParams, eventId: string, ruleVersion: number) {
  try {
    console.log(
      `[notifications][disabled] type=${String(params.type || '')} event_id=${eventId} entity=${String(params.entity || '')} entity_id=${String(params.entityId || '')} rule_version=${ruleVersion} config_state=disabled`,
    )
  } catch {}
}

async function resolveAudienceRecipients(audience: NotificationAudienceType, params: EmitNotificationEventParams, client: any) {
  const entityId = String(params.entityId || '').trim()
  if (!entityId) return []
  if (audience === 'order_related_users') return await listCleaningTaskUserIdsByOrderId(entityId, client)
  if (audience === 'cleaning_task_users') return await listCleaningTaskUserIds(entityId)
  if (audience === 'inspection_task_users') return await listInspectionTaskUserIds(entityId)
  if (audience === 'work_task_users') return await listWorkTaskUserIds(entityId)
  if (audience === 'manager_users') return await resolveManagerUsersAudience()
  return []
}

export async function emitNotificationEvent(params: EmitNotificationEventParams, opts?: EmitNotificationEventOptions) {
  // Business code must enter notifications here so inbox persistence and queued push delivery stay in sync.
  if (!hasPg || !pgPool) return { ok: true, sent: 0 }
  await ensureNotificationStorage()

  const client = opts?.pgClient || pgPool
  const type = params.type
  const entity = String(params.entity || '').trim()
  const entityId = String(params.entityId || '').trim()
  if (!entity || !entityId) return { ok: false, sent: 0 }

  const updatedAt = normalizeEventTimestamp(params.updatedAt) || new Date().toISOString()
  const explicitEventId = String(params.eventId || '').trim()
  const eventId = explicitEventId || `${type}_${entity}_${entityId}_${updatedAt}`
  let configState: NotificationRuleConfigState = 'configured'
  let ruleVersion = 0
  let selectedRoles: string[] = []
  let selectedAudiences: string[] = []
  let selectedUsers: string[] = []
  const audienceCounts: Record<string, number> = {}
  const resolved: string[] = []
  if (isManagedNotificationEventType(type)) {
    const rule = await getNotificationRule(type as NotificationManagedEventType)
    configState = rule.config_state
    ruleVersion = Number(rule.version || 0)
    if (configState === 'disabled') {
      logDisabledRule(params, eventId, ruleVersion)
      return { ok: true, sent: 0, skipped: 'RULE_DISABLED', event_id: eventId, rule_version: ruleVersion, config_state: configState }
    }
    const selectors = configState === 'no_config' ? rule.default_template.selectors : rule.selectors
    selectedRoles = selectors.filter((x) => x.recipient_type === 'role').map((x) => x.recipient_value)
    selectedAudiences = selectors.filter((x) => x.recipient_type === 'audience').map((x) => x.recipient_value)
    selectedUsers = selectors.filter((x) => x.recipient_type === 'user').map((x) => x.recipient_value)
    for (const audience of selectedAudiences) {
      const ids = await resolveAudienceRecipients(audience as NotificationAudienceType, params, client)
      audienceCounts[audience] = ids.length
      resolved.push(...ids)
    }
    if (selectedRoles.length) {
      const roleIds = await listUserIdsByRoles(selectedRoles)
      resolved.push(...roleIds)
    }
    resolved.push(...selectedUsers)
  }
  const propertyId = String(params.propertyId || '').trim()
  const hasExplicitRecipients = Array.isArray(params.recipientUserIds) && params.recipientUserIds.length > 0
  if (hasExplicitRecipients) resolved.push(...params.recipientUserIds!.map((x) => String(x || '').trim()).filter(Boolean))
  const mergedResolved = Array.from(new Set(resolved.filter(Boolean)))
  const filtered = propertyId ? await filterUserIdsByPropertyScope(mergedResolved, propertyId, client) : mergedResolved
  const actor = String(params.actorUserId || '').trim()
  const excludeActor = shouldExcludeActor(params)
  const to = excludeActor && actor ? filtered.filter((x) => x !== actor) : filtered
  logResolution(params, {
    eventId,
    configState,
    ruleVersion,
    selectedRoles,
    selectedAudiences,
    selectedUsersCount: selectedUsers.length,
    resolvedCountBeforeScope: mergedResolved.length,
    resolvedCountAfterScope: filtered.length,
    resolvedCountAfterActor: to.length,
    finalCount: to.length,
    audienceCounts,
  })
  if (!to.length) {
    logNoRecipients(params, eventId, hasExplicitRecipients, propertyId)
    return { ok: false, sent: 0, error_code: 'NO_RECIPIENTS', event_id: eventId, rule_version: ruleVersion, config_state: configState }
  }
  const priority = resolvePriority(params)

  const { title: autoTitle, body: autoBody } = buildDefaultTitleBody(params)
  const title = String(params.title || '').trim() || autoTitle
  const body = String(params.body || '').trim() || autoBody
  const changes = uniqText(params.changes || [])

  const baseData = params.data || {}
  const data = {
    ...(typeof baseData === 'object' && baseData ? baseData : {}),
    event_id: eventId,
    entity,
    entityId,
  }

  let inserted = 0
  for (const userId of to) {
    const nid = uuid()
    const r = await client.query(
      `INSERT INTO user_notifications (
        id, user_id, event_id, type, entity, entity_id, changes, title, body, data, priority, created_at, updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::timestamptz,now()
      )
      ON CONFLICT (user_id, event_id)
      DO UPDATE SET
        changes = CASE
          WHEN user_notifications.changes IS NULL AND EXCLUDED.changes IS NULL THEN NULL
          WHEN user_notifications.changes IS NULL THEN EXCLUDED.changes
          WHEN EXCLUDED.changes IS NULL THEN user_notifications.changes
          ELSE (SELECT ARRAY(SELECT DISTINCT x FROM unnest(user_notifications.changes || EXCLUDED.changes) AS x))
        END,
        title = EXCLUDED.title,
        body = EXCLUDED.body,
        data = EXCLUDED.data,
        priority = EXCLUDED.priority,
        updated_at = now()
      RETURNING id`,
      [nid, userId, eventId, type, entity, entityId, changes.length ? changes : null, title, body, data, priority, updatedAt],
    )
    const userNotificationId = String(r?.rows?.[0]?.id || '').trim() || nid

    await client.query(
      `INSERT INTO event_queue (id, user_notification_id, user_id, event_id, status, attempts, run_after, created_at)
       VALUES ($1,$2,$3,$4,'pending',0,now(),now())
       ON CONFLICT (user_id, event_id) DO NOTHING`,
      [uuid(), userNotificationId, userId, eventId],
    )
    inserted++
  }

  return { ok: true, sent: inserted, event_id: eventId, rule_version: ruleVersion, config_state: configState }
}
