import { v4 as uuid } from 'uuid'
import { hasPg, pgPool } from '../dbAdapter'
import { listManagerUserIds, listCleaningTaskUserIds } from '../modules/notifications'

export type NotificationPriority = 'high' | 'medium' | 'low'

export type NotificationEventType =
  | 'ORDER_UPDATED'
  | 'CLEANING_TASK_UPDATED'
  | 'CLEANING_COMPLETED'
  | 'INSPECTION_COMPLETED'
  | 'KEY_PHOTO_UPLOADED'
  | 'ISSUE_REPORTED'
  | 'WORK_TASK_UPDATED'

export type EmitNotificationEventParams = {
  type: NotificationEventType
  entity: 'order' | 'cleaning_task' | 'work_task'
  entityId: string
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
  if (Array.isArray(params.recipientUserIds) && params.recipientUserIds.length) {
    return Array.from(new Set(params.recipientUserIds.map((x) => String(x || '').trim()).filter(Boolean)))
  }
  const type = params.type
  const entityId = String(params.entityId || '').trim()
  if (!entityId) return []

  if (type === 'ORDER_UPDATED') {
    const rel = await listCleaningTaskUserIdsByOrderId(entityId, client)
    const mgr = await listManagerUserIds()
    return Array.from(new Set([...rel, ...mgr]))
  }

  if (type === 'CLEANING_TASK_UPDATED') {
    const rel = await listCleaningTaskUserIds(entityId)
    const mgr = await listManagerUserIds()
    return Array.from(new Set([...rel, ...mgr]))
  }

  if (type === 'CLEANING_COMPLETED') {
    const rel = await listCleaningTaskUserIds(entityId)
    const mgr = await listManagerUserIds()
    return Array.from(new Set([...rel, ...mgr]))
  }

  if (type === 'INSPECTION_COMPLETED') {
    const mgr = await listManagerUserIds()
    return mgr
  }

  if (type === 'KEY_PHOTO_UPLOADED') {
    const rel = await listCleaningTaskUserIds(entityId)
    const mgr = await listManagerUserIds()
    return Array.from(new Set([...rel, ...mgr]))
  }

  if (type === 'ISSUE_REPORTED') {
    const mgr = await listManagerUserIds()
    return mgr
  }

  if (type === 'WORK_TASK_UPDATED') {
    return []
  }

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
  return 'low'
}

export async function emitNotificationEvent(params: EmitNotificationEventParams, opts?: EmitNotificationEventOptions) {
  if (!hasPg || !pgPool) return { ok: true, sent: 0 }
  await ensureNotificationStorage()

  const client = opts?.pgClient || pgPool
  const type = params.type
  const entity = String(params.entity || '').trim()
  const entityId = String(params.entityId || '').trim()
  if (!entity || !entityId) return { ok: false, sent: 0 }

  const updatedAt = String(params.updatedAt || '').trim() || String(opts?.operationId || '').trim() || new Date().toISOString()
  const eventId = `${type}_${entity}_${entityId}_${updatedAt}`

  const resolved = await resolveRecipients(params, client)
  const propertyId = String(params.propertyId || '').trim()
  const filtered = propertyId ? await filterUserIdsByPropertyScope(resolved, propertyId, client) : resolved
  const actor = String(params.actorUserId || '').trim()
  const excludeActor = shouldExcludeActor(params)
  const to = excludeActor && actor ? filtered.filter((x) => x !== actor) : filtered
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
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now(),now()
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
      [nid, userId, eventId, type, entity, entityId, changes.length ? changes : null, title, body, data, priority],
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

  return { ok: true, sent: inserted, event_id: eventId }
}
