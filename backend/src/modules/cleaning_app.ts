import { Router } from 'express'
import { z } from 'zod'
import { requirePerm, requireAnyPerm } from '../auth'
import { hasPg, pgUpdate, pgInsert } from '../dbAdapter'
import multer from 'multer'
import path from 'path'
import { hasR2, r2Upload } from '../r2'
import { broadcastCleaningEvent } from './events'
import { roleHasPermission } from '../store'
import sharp from 'sharp'
import fs from 'fs'
import { emitNotificationEvent } from '../services/notificationEvents'
import { buildCleaningTaskVisibilityHints, emitWorkTaskEvent } from '../services/workTaskEvents'
import { effectiveInspectionMode } from '../lib/cleaningInspection'
import { resolvePropertyPublicGuideLinks } from './property_guide_link_sync'

export const router = Router()

const REQUIRED_COMPLETION_PHOTO_AREAS = ['toilet', 'living', 'sofa', 'bedroom', 'kitchen'] as const
const upload = hasR2 ? multer({ storage: multer.memoryStorage() }) : multer({ dest: path.join(process.cwd(), 'uploads') })

function parseYmd(value: string): { y: number; m: number; d: number } | null {
  const s = String(value || '').trim()
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  if (!y || mo < 1 || mo > 12 || d < 1 || d > 31) return null
  return { y, m: mo, d }
}

function utcDay(ts: { y: number; m: number; d: number }) {
  return Date.UTC(ts.y, ts.m - 1, ts.d)
}

async function hasPerm(roleName: string, code: string): Promise<boolean> {
  if (!roleName) return false
  if (roleName === 'admin') return true
  try {
    const { hasPg: hasPg0, pgPool } = require('../dbAdapter')
    if (hasPg0 && pgPool) {
      let roleId: string | undefined
      try {
        const r0 = await pgPool.query('SELECT id FROM roles WHERE name=$1 LIMIT 1', [roleName])
        if (r0 && r0.rows && r0.rows[0] && r0.rows[0].id) roleId = String(r0.rows[0].id)
      } catch {}
      const roleIds = Array.from(new Set([roleId, roleName, roleName.startsWith('role.') ? roleName.replace(/^role\./, '') : `role.${roleName}`].filter(Boolean)))
      const r = await pgPool.query(
        'SELECT 1 FROM role_permissions WHERE role_id = ANY($1::text[]) AND permission_code = $2 LIMIT 1',
        [roleIds, code],
      )
      return !!r?.rowCount
    }
  } catch {}
  return roleHasPermission(roleName, code)
}

async function notifyRecipientsForTask(taskId: string, actorId: string) {
  const { listCleaningTaskUserIds, listManagerUserIds, excludeUserIds } = require('./notifications')
  const taskUsers = excludeUserIds(await listCleaningTaskUserIds(taskId), actorId)
  const managerUsers = await listManagerUserIds()
  return Array.from(new Set([...taskUsers, ...managerUsers]))
}

async function listKeysHungNotificationUserIds(actorId?: string) {
  const { listManagerUserIds, excludeUserIds } = require('./notifications')
  const managerUsers = await listManagerUserIds({ roles: ['admin', 'offline_manager', 'customer_service'] })
  return excludeUserIds(managerUsers, actorId)
}

async function listConsumablesRestockNotificationUserIds(taskId: string, actorId?: string) {
  const { listInspectionTaskUserIds, listManagerUserIds, excludeUserIds } = require('./notifications')
  const inspectionUsers = await listInspectionTaskUserIds(taskId)
  const managerUsers = await listManagerUserIds({ roles: ['admin', 'offline_manager'] })
  return excludeUserIds(Array.from(new Set([...inspectionUsers, ...managerUsers])), actorId)
}

async function listInspectionPhotoUrls(taskId: string) {
  if (!hasPg) return []
  try {
    const { pgPool } = require('../dbAdapter')
    if (!pgPool) return []
    const r = await pgPool.query(
      `SELECT url
       FROM cleaning_task_media
       WHERE task_id = $1
         AND type LIKE 'inspection_%'
         AND COALESCE(url, '') <> ''
       ORDER BY captured_at ASC NULLS LAST, created_at ASC NULLS LAST, id ASC`,
      [String(taskId || '').trim()],
    )
    return Array.from(new Set((r?.rows || []).map((row: any) => String(row?.url || '').trim()).filter(Boolean)))
  } catch {
    return []
  }
}

function normalizeStoredPhotoUrls(raw: any, fallback?: any) {
  if (Array.isArray(raw)) return Array.from(new Set(raw.map((item) => String(item || '').trim()).filter(Boolean)))
  const text = String(raw || '').trim()
  if (text) {
    try {
      const parsed = JSON.parse(text)
      if (Array.isArray(parsed)) return Array.from(new Set(parsed.map((item) => String(item || '').trim()).filter(Boolean)))
    } catch {}
    if (/^https?:\/\//i.test(text)) return [text]
  }
  const fallbackText = String(fallback || '').trim()
  return fallbackText ? [fallbackText] : []
}

async function listDayEndManagerUserIds() {
  const { listManagerUserIds } = require('./notifications')
  return await listManagerUserIds()
}

async function resolveUserDisplayName(userId: string) {
  const uid = String(userId || '').trim()
  if (!uid || !hasPg) return uid
  try {
    const { pgPool } = require('../dbAdapter')
    if (!pgPool) return uid
    const r = await pgPool.query(
      `SELECT COALESCE(NULLIF(TRIM(username), ''), NULLIF(TRIM(legal_name), ''), NULLIF(TRIM(email), ''), id::text) AS name
       FROM users
       WHERE id::text = $1::text
       LIMIT 1`,
      [uid],
    )
    return String(r?.rows?.[0]?.name || uid).trim() || uid
  } catch {
    return uid
  }
}

async function ensureWarehouseKeyTables() {
  if (!hasPg) return
  const { pgPool } = require('../dbAdapter')
  if (!pgPool) return
  await pgPool.query(`CREATE TABLE IF NOT EXISTS warehouse_keys (
    key_code text PRIMARY KEY,
    label text NOT NULL,
    status text NOT NULL DEFAULT 'available',
    holder_user_id text,
    holder_name_snapshot text,
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by text
  );`)
  await pgPool.query(`CREATE TABLE IF NOT EXISTS warehouse_key_events (
    id text PRIMARY KEY,
    key_code text NOT NULL,
    action text NOT NULL,
    actor_user_id text NOT NULL,
    actor_name_snapshot text,
    from_user_id text,
    from_name_snapshot text,
    to_user_id text,
    to_name_snapshot text,
    note text,
    task_date date,
    created_at timestamptz NOT NULL DEFAULT now()
  );`)
  await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_warehouse_key_events_key_created ON warehouse_key_events(key_code, created_at DESC);`)
  await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_warehouse_key_events_task_date ON warehouse_key_events(task_date);`)
  await pgPool.query(
    `INSERT INTO warehouse_keys (key_code, label, status)
     VALUES ('msq', 'MSQ 仓库钥匙', 'available')
     ON CONFLICT (key_code) DO NOTHING`,
  )
}

let warehouseKeyTablesInitPromise: Promise<void> | null = null

function ensureWarehouseKeyTablesOnce() {
  if (!warehouseKeyTablesInitPromise) {
    warehouseKeyTablesInitPromise = ensureWarehouseKeyTables().catch((e) => {
      warehouseKeyTablesInitPromise = null
      throw e
    })
  }
  return warehouseKeyTablesInitPromise
}

void ensureWarehouseKeyTablesOnce().catch((e) => {
  console.warn('[warehouse-key] table initialization failed:', e?.message || e)
})

function normalizeWarehouseKeyCode(raw: any) {
  const value = String(raw || '').trim().toLowerCase()
  return value || 'msq'
}

function todayYmd() {
  return new Date().toISOString().slice(0, 10)
}

function toIsoStringOrNull(value: any) {
  if (!value) return null
  if (value instanceof Date) return value.toISOString()
  const d = new Date(value)
  if (!Number.isNaN(d.getTime())) return d.toISOString()
  return String(value)
}

async function listSouthbankWarehouseKeyUsers(taskDate: string) {
  if (!hasPg) return { userIds: [] as string[], candidates: [] as Array<{ id: string; name: string; role: string }> }
  const { pgPool } = require('../dbAdapter')
  if (!pgPool) return { userIds: [], candidates: [] }
  const date = String(taskDate || '').slice(0, 10) || todayYmd()
  const r = await pgPool.query(
    `WITH southbank_tasks AS (
       SELECT
         t.*,
         COALESCE(t.task_date, t.date)::date AS task_day,
         lower(COALESCE(t.task_type, '')) AS task_type_l,
         lower(COALESCE(t.status, '')) AS status_l,
         CASE
           WHEN lower(COALESCE(t.inspection_mode, '')) IN ('pending_decision', 'same_day', 'self_complete', 'deferred')
             THEN lower(COALESCE(t.inspection_mode, ''))
           WHEN lower(COALESCE(t.task_type, '')) = 'stayover_clean'
             THEN 'self_complete'
           WHEN lower(COALESCE(t.task_type, '')) = 'checkin_clean'
             THEN 'same_day'
           WHEN lower(COALESCE(t.task_type, '')) = 'checkout_clean'
             THEN CASE
               WHEN NULLIF(t.inspector_id::text, '') IS NOT NULL THEN 'same_day'
               WHEN lower(COALESCE(t.status, '')) IN ('cleaned', 'restock_pending', 'restocked', 'inspected', 'done', 'completed', 'ready', 'keys_hung') THEN 'self_complete'
               ELSE 'pending_decision'
             END
           WHEN NULLIF(t.inspector_id::text, '') IS NOT NULL
             THEN 'same_day'
           ELSE 'pending_decision'
         END AS effective_inspection_mode
       FROM cleaning_tasks t
       LEFT JOIN properties p_id ON p_id.id::text = t.property_id::text
       LEFT JOIN properties p_code ON upper(p_code.code) = upper(t.property_id::text)
       WHERE COALESCE(t.task_date, t.date)::date = $1::date
         AND lower(COALESCE(t.status, '')) NOT IN ('cancelled', 'canceled')
         AND lower(COALESCE(p_id.region, p_code.region, '')) LIKE '%southbank%'
     )
     SELECT DISTINCT
        u.id::text AS id,
        COALESCE(NULLIF(TRIM(u.username), ''), NULLIF(TRIM(u.legal_name), ''), NULLIF(TRIM(u.email), ''), u.id::text) AS name,
        COALESCE(NULLIF(TRIM(u.role), ''), '') AS role
     FROM southbank_tasks t
     JOIN LATERAL (
       VALUES
         (NULLIF(COALESCE(NULLIF(t.cleaner_id::text, ''), NULLIF(t.assignee_id::text, '')), '')),
         (CASE
           WHEN NULLIF(t.inspector_id::text, '') IS NOT NULL
             AND (
               t.effective_inspection_mode = 'same_day'
               OR (
                 t.effective_inspection_mode = 'deferred'
                 AND t.inspection_due_date IS NOT NULL
                 AND t.inspection_due_date::date = t.task_day
               )
             )
           THEN NULLIF(t.inspector_id::text, '')
           ELSE NULL
         END)
     ) AS candidate(user_id) ON candidate.user_id IS NOT NULL
     JOIN users u ON u.id::text = candidate.user_id
     ORDER BY name ASC`,
    [date],
  )
  const candidates = (r?.rows || []).map((row: any) => ({
    id: String(row.id || '').trim(),
    name: String(row.name || '').trim(),
    role: String(row.role || '').trim(),
  })).filter((row: any) => !!row.id)
  return {
    userIds: Array.from(new Set(candidates.map((row: any) => row.id))),
    candidates,
  }
}

async function listWarehouseKeyNotificationUserIds(params: { taskDate: string; actorId: string; extraUserIds?: string[] }) {
  const { listUserIdsByRoles } = require('./notifications')
  const related = await listSouthbankWarehouseKeyUsers(params.taskDate)
  const managerIds = await listUserIdsByRoles(['admin', 'offline_manager'])
  const actorId = String(params.actorId || '').trim()
  const ids = [
    ...related.userIds,
    ...managerIds,
    ...((params.extraUserIds || []).map((x) => String(x || '').trim()).filter(Boolean)),
  ]
  return Array.from(new Set(ids.filter(Boolean))).filter((id) => id !== actorId)
}

function warehouseKeyActionText(action: string) {
  if (action === 'borrow') return '借走了'
  if (action === 'return') return '归还了'
  if (action === 'handover') return '转交了'
  return '更新了'
}

const warehouseKeyEventSchema = z.object({
  key_code: z.string().trim().max(40).optional(),
  action: z.enum(['borrow', 'return', 'handover']),
  to_user_id: z.string().trim().max(80).optional(),
  note: z.string().trim().max(500).optional(),
  task_date: z.string().trim().min(10).max(32).optional(),
}).strict()

router.get('/warehouse-key/status', requireAnyPerm(['cleaning_app.tasks.finish', 'cleaning_app.inspect.finish', 'cleaning_app.calendar.view.all']), async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  try {
    if (!hasPg) return res.json({ key: { key_code: 'msq', label: 'MSQ 仓库钥匙', status: 'available', holder_user_id: null, holder_name: null, holder_phone_au: null, updated_at: null }, events: [], candidates: [] })
    const { pgPool } = require('../dbAdapter')
    if (!pgPool) return res.status(500).json({ message: 'pg not available' })
    await ensureWarehouseKeyTablesOnce()
    const keyCode = normalizeWarehouseKeyCode((req.query as any)?.key || (req.query as any)?.key_code)
    const taskDate = String((req.query as any)?.date || '').slice(0, 10) || todayYmd()
    const [keyRes, eventRes, related] = await Promise.all([
      pgPool.query(
        `SELECT k.key_code, k.label, k.status, k.holder_user_id, k.holder_name_snapshot, u.phone_au AS holder_phone_au, k.updated_at, k.updated_by
         FROM warehouse_keys k
         LEFT JOIN users u ON u.id::text = k.holder_user_id::text
         WHERE k.key_code = $1
         LIMIT 1`,
        [keyCode],
      ),
      pgPool.query(
        `SELECT id, key_code, action, actor_user_id, actor_name_snapshot, from_user_id, from_name_snapshot,
                to_user_id, to_name_snapshot, note, task_date::text AS task_date, created_at
         FROM warehouse_key_events
         WHERE key_code = $1
         ORDER BY created_at DESC
         LIMIT 20`,
        [keyCode],
      ),
      listSouthbankWarehouseKeyUsers(taskDate),
    ])
    const keyRow = keyRes?.rows?.[0] || { key_code: keyCode, label: 'MSQ 仓库钥匙', status: 'available' }
    return res.json({
      key: {
        key_code: String(keyRow.key_code || keyCode),
        label: String(keyRow.label || 'MSQ 仓库钥匙'),
        status: String(keyRow.status || 'available'),
        holder_user_id: keyRow.holder_user_id == null ? null : String(keyRow.holder_user_id || ''),
        holder_name: keyRow.holder_name_snapshot == null ? null : String(keyRow.holder_name_snapshot || ''),
        holder_phone_au: keyRow.holder_phone_au == null ? null : String(keyRow.holder_phone_au || '').trim() || null,
        updated_at: toIsoStringOrNull(keyRow.updated_at),
        updated_by: keyRow.updated_by == null ? null : String(keyRow.updated_by || ''),
      },
      events: (eventRes?.rows || []).map((row: any) => ({
        id: String(row.id || ''),
        key_code: String(row.key_code || keyCode),
        action: String(row.action || ''),
        actor_user_id: String(row.actor_user_id || ''),
        actor_name: String(row.actor_name_snapshot || ''),
        from_user_id: row.from_user_id == null ? null : String(row.from_user_id || ''),
        from_name: row.from_name_snapshot == null ? null : String(row.from_name_snapshot || ''),
        to_user_id: row.to_user_id == null ? null : String(row.to_user_id || ''),
        to_name: row.to_name_snapshot == null ? null : String(row.to_name_snapshot || ''),
        note: row.note == null ? null : String(row.note || ''),
        task_date: row.task_date ? String(row.task_date).slice(0, 10) : null,
        created_at: toIsoStringOrNull(row.created_at),
      })),
      candidates: related.candidates,
    })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'error' })
  }
})

router.post('/warehouse-key/events', requireAnyPerm(['cleaning_app.tasks.finish', 'cleaning_app.inspect.finish']), async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  const parsed = warehouseKeyEventSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (!hasPg) return res.status(201).json({ ok: true })
    const { pgPool } = require('../dbAdapter')
    if (!pgPool) return res.status(500).json({ message: 'pg not available' })
    await ensureWarehouseKeyTablesOnce()
    const uuid = require('uuid')
    const keyCode = normalizeWarehouseKeyCode(parsed.data.key_code)
    const action = parsed.data.action
    const actorId = String(user.sub || '').trim()
    if (!actorId) return res.status(401).json({ message: 'unauthorized' })
    const actorName = await resolveUserDisplayName(actorId)
    const toUserId = String(parsed.data.to_user_id || '').trim()
    if (action === 'handover' && !toUserId) return res.status(400).json({ message: '请选择要转交的同事' })
    if (action === 'handover' && toUserId === actorId) return res.status(400).json({ message: '不能转交给自己' })
    const toName = toUserId ? await resolveUserDisplayName(toUserId) : ''
    const taskDate = String(parsed.data.task_date || '').slice(0, 10) || todayYmd()
    const note = String(parsed.data.note || '').trim()
    const client = await pgPool.connect()
    let eventRow: any = null
    let updatedKey: any = null
    let fromUserId = ''
    let fromName = ''
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO warehouse_keys (key_code, label, status)
         VALUES ($1, 'MSQ 仓库钥匙', 'available')
         ON CONFLICT (key_code) DO NOTHING`,
        [keyCode],
      )
      const cur = await client.query(
        `SELECT key_code, label, status, holder_user_id, holder_name_snapshot
         FROM warehouse_keys
         WHERE key_code = $1
         FOR UPDATE`,
        [keyCode],
      )
      const current = cur?.rows?.[0] || {}
      fromUserId = String(current.holder_user_id || '').trim()
      fromName = String(current.holder_name_snapshot || '').trim()
      let nextStatus = 'available'
      let nextHolderUserId: string | null = null
      let nextHolderName: string | null = null
      if (action === 'borrow') {
        nextStatus = 'borrowed'
        nextHolderUserId = actorId
        nextHolderName = actorName
      } else if (action === 'handover') {
        nextStatus = 'borrowed'
        nextHolderUserId = toUserId
        nextHolderName = toName
      }
      const up = await client.query(
        `UPDATE warehouse_keys
            SET status = $2,
                holder_user_id = $3,
                holder_name_snapshot = $4,
                updated_at = now(),
                updated_by = $5
          WHERE key_code = $1
          RETURNING key_code, label, status, holder_user_id, holder_name_snapshot, updated_at, updated_by`,
        [keyCode, nextStatus, nextHolderUserId, nextHolderName, actorId],
      )
      updatedKey = up?.rows?.[0] || null
      const ev = await client.query(
        `INSERT INTO warehouse_key_events (
           id, key_code, action, actor_user_id, actor_name_snapshot, from_user_id, from_name_snapshot,
           to_user_id, to_name_snapshot, note, task_date, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::date,now())
         RETURNING id, key_code, action, actor_user_id, actor_name_snapshot, from_user_id, from_name_snapshot,
                   to_user_id, to_name_snapshot, note, task_date::text AS task_date, created_at`,
        [uuid.v4(), keyCode, action, actorId, actorName, fromUserId || null, fromName || null, toUserId || null, toName || null, note || null, taskDate],
      )
      eventRow = ev?.rows?.[0] || null
      await client.query('COMMIT')
    } catch (e) {
      try { await client.query('ROLLBACK') } catch {}
      throw e
    } finally {
      client.release()
    }

    try {
      const recipients = await listWarehouseKeyNotificationUserIds({ taskDate, actorId, extraUserIds: [toUserId] })
      const actionText = warehouseKeyActionText(action)
      const body = action === 'handover'
        ? `${actorName} 已将 MSQ 仓库钥匙转交给 ${toName || '同事'}。`
        : `${actorName} ${actionText} MSQ 仓库钥匙。`
      await emitNotificationEvent({
        type: 'WAREHOUSE_KEY_UPDATED',
        entity: 'warehouse_key',
        entityId: keyCode,
        eventId: `warehouse_key:${keyCode}:${String(eventRow?.id || Date.now())}`,
        updatedAt: eventRow?.created_at ? String(eventRow.created_at) : new Date().toISOString(),
        title: 'MSQ 仓库钥匙更新',
        body,
        recipientUserIds: recipients,
        actorUserId: actorId,
        priority: 'high',
        data: {
          kind: 'warehouse_key_updated',
          key_code: keyCode,
          key_label: 'MSQ 仓库钥匙',
          action,
          task_date: taskDate,
          actor_user_id: actorId,
          actor_name: actorName,
          from_user_id: fromUserId || null,
          from_name: fromName || null,
          to_user_id: toUserId || null,
          to_name: toName || null,
          note: note || null,
        },
      })
    } catch {}

    return res.status(201).json({
      ok: true,
      key: updatedKey ? {
        key_code: String(updatedKey.key_code || keyCode),
        label: String(updatedKey.label || 'MSQ 仓库钥匙'),
        status: String(updatedKey.status || 'available'),
        holder_user_id: updatedKey.holder_user_id == null ? null : String(updatedKey.holder_user_id || ''),
        holder_name: updatedKey.holder_name_snapshot == null ? null : String(updatedKey.holder_name_snapshot || ''),
        updated_at: updatedKey.updated_at ? String(updatedKey.updated_at) : null,
        updated_by: updatedKey.updated_by == null ? null : String(updatedKey.updated_by || ''),
      } : null,
      event: eventRow,
    })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'error' })
  }
})

// List tasks for app (self or all)
router.get('/tasks', requireAnyPerm(['cleaning_app.calendar.view.all','cleaning_app.tasks.view.self']), async (req, res) => {
  const { assignee_id, date_from, date_to, status } = req.query as { assignee_id?: string; date_from?: string; date_to?: string; status?: string }
  try {
    const user = (req as any).user
    if (!user) return res.status(401).json({ message: 'unauthorized' })
    const roleName = String(user.role || '')
    const canViewAll = await hasPerm(roleName, 'cleaning_app.calendar.view.all')

    const dfRaw = String(date_from || '').trim()
    const dtRaw = String(date_to || '').trim()
    const df = parseYmd(dfRaw)
    const dt = parseYmd(dtRaw)
    if (!df || !dt) return res.status(400).json({ message: 'invalid date_from/date_to' })
    const spanDays = Math.floor((utcDay(dt) - utcDay(df)) / 86400000)
    if (spanDays < 0) return res.status(400).json({ message: 'date_to must be >= date_from' })
    if (spanDays > 31) return res.status(400).json({ message: 'date range too large' })

    if (hasPg) {
      const { pgPool } = require('../dbAdapter')
      if (!pgPool) return res.json([])

      const assignee = canViewAll ? (assignee_id ? String(assignee_id) : null) : String(user.sub || '')
      const status0 = status ? String(status) : null

      const q = `
        SELECT
          t.id as task_id,
          COALESCE(t.task_date, t.date) as task_date,
          t.task_type,
          t.status,
          t.assignee_id,
          t.cleaner_id,
          t.inspector_id,
          t.inspection_mode,
          t.inspection_due_date::text AS inspection_due_date,
          COALESCE(cu.username, cu.email, cu.id::text) AS cleaner_name,
          COALESCE(iu.username, iu.email, iu.id::text) AS inspector_name,
          t.checkout_time as checkout_time,
          t.checkin_time as checkin_time,
          t.old_code,
          t.new_code,
          COALESCE(p_id.id, p_code.id) as property_id,
          COALESCE(p_id.code, p_code.code) as property_code,
          COALESCE(p_id.address, p_code.address) as property_address,
          COALESCE(p_id.type, p_code.type) as property_unit_type,
          COALESCE(p_id.region, p_code.region) as property_region,
          COALESCE(p_id.keybox_code, p_code.keybox_code) as property_keybox_code,
          COALESCE(p_id.access_guide_link, p_code.access_guide_link) as property_access_guide_link
        FROM cleaning_tasks t
        LEFT JOIN properties p_id ON (p_id.id::text) = (t.property_id::text)
        LEFT JOIN properties p_code ON upper(p_code.code) = upper(t.property_id::text)
        LEFT JOIN users cu ON (cu.id::text) = (COALESCE(t.cleaner_id, t.assignee_id)::text)
        LEFT JOIN users iu ON (iu.id::text) = (t.inspector_id::text)
        WHERE COALESCE(t.task_date, t.date) BETWEEN $1::date AND $2::date
          AND ($3::text IS NULL OR t.assignee_id = $3::text)
          AND ($4::text IS NULL OR t.status = $4::text)
        ORDER BY COALESCE(t.task_date, t.date) ASC, COALESCE(p_id.code, p_code.code) ASC NULLS LAST, t.created_at ASC
      `
      const r = await pgPool.query(q, [dfRaw, dtRaw, assignee, status0])
      const rows = (r?.rows || []) as any[]
      const guideLinks = await resolvePropertyPublicGuideLinks(
        rows.map((row) => ({
          propertyId: String(row.property_id || '').trim(),
          fallbackLink: row.property_access_guide_link,
        })),
      )
      return res.json(
        rows.map((row) => {
          const taskId = String(row.task_id || '')
          const taskDate = String(row.task_date || '').slice(0, 10)
          const oldCode = row.old_code === null || row.old_code === undefined ? null : String(row.old_code)
          const newCode = row.new_code === null || row.new_code === undefined ? null : String(row.new_code)
          const keyboxCode = row.property_keybox_code === null || row.property_keybox_code === undefined ? null : String(row.property_keybox_code)
          const accessCode = (newCode && newCode.trim()) ? newCode : (oldCode && oldCode.trim()) ? oldCode : (keyboxCode && keyboxCode.trim()) ? keyboxCode : null
          const propertyId = row.property_id === null || row.property_id === undefined ? null : String(row.property_id)
          const accessGuideLink = propertyId ? guideLinks.get(propertyId) || null : null
          const region = row.property_region === null || row.property_region === undefined ? null : String(row.property_region)
          const property = propertyId
            ? {
                id: propertyId,
                code: row.property_code === null || row.property_code === undefined ? '' : String(row.property_code),
                address: row.property_address === null || row.property_address === undefined ? '' : String(row.property_address),
                unit_type: row.property_unit_type === null || row.property_unit_type === undefined ? '' : String(row.property_unit_type),
                region,
                access_guide_link: accessGuideLink,
              }
            : null
          return {
            id: taskId,
            task_id: taskId,
            date: taskDate,
            task_date: taskDate,
            task_type: row.task_type === null || row.task_type === undefined ? null : String(row.task_type),
            status: row.status === null || row.status === undefined ? '' : String(row.status),
            assignee_id: row.assignee_id === null || row.assignee_id === undefined ? null : String(row.assignee_id),
            cleaner_id: row.cleaner_id === null || row.cleaner_id === undefined ? null : String(row.cleaner_id),
            inspector_id: row.inspector_id === null || row.inspector_id === undefined ? null : String(row.inspector_id),
            inspection_mode: row.inspection_mode === null || row.inspection_mode === undefined ? null : String(row.inspection_mode),
            inspection_due_date: row.inspection_due_date === null || row.inspection_due_date === undefined ? null : String(row.inspection_due_date).slice(0, 10),
            cleaner_name: row.cleaner_name === null || row.cleaner_name === undefined ? null : String(row.cleaner_name),
            inspector_name: row.inspector_name === null || row.inspector_name === undefined ? null : String(row.inspector_name),
            checkout_time: row.checkout_time === null || row.checkout_time === undefined ? null : String(row.checkout_time),
            checkin_time: row.checkin_time === null || row.checkin_time === undefined ? null : String(row.checkin_time),
            old_code: oldCode,
            new_code: newCode,
            access_code: accessCode,
            property,
          }
        }),
      )
    }
    return res.json([])
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'error' })
  }
})

// Start cleaning: upload key photo (url provided) + geo + timestamps
const startSchema = z.object({ media_url: z.string().min(1), captured_at: z.string().optional(), lat: z.number().optional(), lng: z.number().optional() })
router.post('/tasks/:id/start', requirePerm('cleaning_app.tasks.start'), async (req, res) => {
  const user = (req as any).user
  const { id } = req.params
  const parsed = startSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (hasPg) {
      const { pgPool } = require('../dbAdapter')
      if (!pgPool) return res.status(500).json({ message: 'pg not available' })
      const now = new Date().toISOString()
      const beforeRes = await pgPool.query(
        `SELECT t.*,
                (
                  SELECT m.url
                  FROM cleaning_task_media m
                  WHERE m.task_id::text = t.id::text
                    AND m.type = 'key_photo'
                  ORDER BY m.created_at DESC NULLS LAST, m.captured_at DESC NULLS LAST, m.id DESC
                  LIMIT 1
                ) AS current_key_photo_url
         FROM cleaning_tasks t
         WHERE t.id::text = $1::text
         LIMIT 1`,
        [String(id)],
      )
      const before = beforeRes?.rows?.[0] || null
      if (!before) return res.status(404).json({ message: 'task not found' })
      const alreadyHasKeyPhoto = !!String(before.current_key_photo_url || '').trim() || !!before.key_photo_uploaded_at
      if (alreadyHasKeyPhoto) {
        const patchExisting: any = {}
        if (String(before.status || '').trim().toLowerCase() !== 'in_progress') patchExisting.status = 'in_progress'
        if (!before.started_at) patchExisting.started_at = now
        if (!before.key_photo_uploaded_at) patchExisting.key_photo_uploaded_at = now
        if (parsed.data.lat !== undefined) patchExisting.geo_lat = parsed.data.lat
        if (parsed.data.lng !== undefined) patchExisting.geo_lng = parsed.data.lng
        const upExisting = Object.keys(patchExisting).length ? await pgUpdate('cleaning_tasks', id, patchExisting) : before
        if (Object.keys(patchExisting).length) {
          await emitWorkTaskEvent({
            taskId: `cleaning_task:${String(id)}`,
            sourceType: 'cleaning_tasks',
            sourceRefIds: [String(id)],
            eventType: 'TASK_UPDATED',
            changeScope: 'list',
            changedFields: Object.keys(patchExisting),
            patch: patchExisting,
            causedByUserId: String(user?.sub || '').trim() || null,
            visibilityHints: buildCleaningTaskVisibilityHints(upExisting || patchExisting),
          })
          try { broadcastCleaningEvent({ event: 'started', task_id: id }) } catch {}
        }
        return res.json(upExisting || before)
      }
      const patch: any = { status: 'in_progress', started_at: now, key_photo_uploaded_at: now }
      if (parsed.data.lat !== undefined) patch.geo_lat = parsed.data.lat
      if (parsed.data.lng !== undefined) patch.geo_lng = parsed.data.lng
      const up = await pgUpdate('cleaning_tasks', id, patch)
      const media = {
        id: require('uuid').v4(),
        task_id: id,
        type: 'key_photo',
        url: parsed.data.media_url,
        captured_at: parsed.data.captured_at || now,
        lat: parsed.data.lat,
        lng: parsed.data.lng,
      }
      try { await pgInsert('cleaning_task_media', media as any) } catch {}
      await emitWorkTaskEvent({
        taskId: `cleaning_task:${String(id)}`,
        sourceType: 'cleaning_tasks',
        sourceRefIds: [String(id)],
        eventType: 'TASK_UPDATED',
        changeScope: 'list',
        changedFields: ['status', 'started_at', 'key_photo_uploaded_at'],
        patch: {
          status: patch.status,
          started_at: patch.started_at,
          key_photo_uploaded_at: patch.key_photo_uploaded_at,
        },
        causedByUserId: String(user?.sub || '').trim() || null,
        visibilityHints: buildCleaningTaskVisibilityHints(up || patch),
      })
      try { broadcastCleaningEvent({ event: 'started', task_id: id }) } catch {}
      try {
        const operationId = require('uuid').v4()
        const propertyId = String((up as any)?.property_id || '').trim()
        if (propertyId) {
          let propertyCode = ''
          try {
            const { pgPool } = require('../dbAdapter')
            if (pgPool) {
              const r0 = await pgPool.query(
                `SELECT COALESCE(p_id.code, p_code.code, '') AS property_code
                 FROM cleaning_tasks t
                 LEFT JOIN properties p_id ON (p_id.id::text) = (t.property_id::text)
                 LEFT JOIN properties p_code ON upper(p_code.code) = upper(t.property_id::text)
                 WHERE t.id::text = $1::text
                 LIMIT 1`,
                [String(id)],
              )
              propertyCode = String(r0?.rows?.[0]?.property_code || '').trim()
            }
          } catch {}
          const title = propertyCode ? `钥匙已上传：${propertyCode}` : '钥匙已上传'
          const body = [propertyCode ? `房源：${propertyCode}` : '', '清洁员已上传钥匙照片', parsed.data.media_url ? `照片：${parsed.data.media_url}` : '']
            .filter(Boolean)
            .join('\n')
          await emitNotificationEvent(
            {
              type: 'KEY_PHOTO_UPLOADED',
              entity: 'cleaning_task',
              entityId: String(id),
              propertyId,
              updatedAt: now,
              title,
              body,
              data: { entity: 'cleaning_task', entityId: String(id), action: 'open_notice', kind: 'key_photo_uploaded', task_id: id, property_code: propertyCode || undefined, photo_url: parsed.data.media_url || undefined },
              actorUserId: String(user?.sub || ''),
            },
            { operationId },
          )
        }
      } catch {}
      return res.json(up || patch)
    }
    return res.json({ id, status: 'in_progress' })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'error' })
  }
})

async function handleDeleteKeyPhoto(req: any, res: any) {
  const user = (req as any).user
  const { id } = req.params
  try {
    if (!hasPg) return res.json({ ok: true })
    const { pgPool } = require('../dbAdapter')
    if (!pgPool) return res.json({ ok: true })
    const userId = String(user?.sub || '').trim()
    if (!userId) return res.status(401).json({ message: 'unauthorized' })

    const r = await pgPool.query(
      `SELECT COALESCE(cleaner_id, assignee_id)::text AS cleaner_id
          , property_id::text AS property_id
       FROM cleaning_tasks
       WHERE id::text = $1::text`,
      [String(id || '').trim()],
    )
    const cleanerId = String(r?.rows?.[0]?.cleaner_id || '').trim()
    const propertyId = String(r?.rows?.[0]?.property_id || '').trim()
    if (!cleanerId || cleanerId !== userId) return res.status(403).json({ message: 'forbidden' })

    await pgPool.query(`DELETE FROM cleaning_task_media WHERE task_id::text = $1::text AND type = 'key_photo'`, [String(id || '').trim()])
    await pgPool.query(`UPDATE cleaning_tasks SET key_photo_uploaded_at = NULL WHERE id::text = $1::text`, [String(id || '').trim()])
    await emitWorkTaskEvent({
      taskId: `cleaning_task:${String(id)}`,
      sourceType: 'cleaning_tasks',
      sourceRefIds: [String(id)],
      eventType: 'TASK_DETAIL_ASSET_CHANGED',
      changeScope: 'detail',
      changedFields: ['key_photo_uploaded_at', 'key_photo_url'],
      patch: { key_photo_uploaded_at: null, key_photo_url: null },
      causedByUserId: userId,
      visibilityHints: buildCleaningTaskVisibilityHints({ cleaner_id: cleanerId, property_id: propertyId }),
    })

    try { broadcastCleaningEvent({ event: 'key_photo_deleted', task_id: id }) } catch {}
    try {
      const now = new Date().toISOString()
      const operationId = require('uuid').v4()
      if (propertyId) {
        await emitNotificationEvent(
          {
            type: 'CLEANING_TASK_UPDATED',
            entity: 'cleaning_task',
            entityId: String(id),
            propertyId,
            updatedAt: now,
            changes: ['keys'],
            title: '钥匙照片已删除',
            body: '清洁员删除了已上传的钥匙照片',
            data: { entity: 'cleaning_task', entityId: String(id), action: 'open_task', kind: 'key_photo_deleted', task_id: id },
            actorUserId: userId,
          },
          { operationId },
        )
      }
    } catch {}
    return res.json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'error' })
  }
}

router.delete('/tasks/:id/key-photo', requirePerm('cleaning_app.tasks.start'), handleDeleteKeyPhoto)
router.post('/tasks/:id/key-photo/delete', requirePerm('cleaning_app.tasks.start'), handleDeleteKeyPhoto)

// Report issue
const issueSchema = z.object({ title: z.string().min(1), detail: z.string().optional(), severity: z.string().optional(), media_url: z.string().optional() })
router.post('/tasks/:id/issues', requirePerm('cleaning_app.issues.report'), async (req, res) => {
  const user = (req as any).user
  const { id } = req.params
  const parsed = issueSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (hasPg) {
      const issue = { id: require('uuid').v4(), task_id: id, title: parsed.data.title, detail: parsed.data.detail || null, severity: parsed.data.severity || null }
      await pgInsert('cleaning_issues', issue as any)
      if (parsed.data.media_url) {
        const media = { id: require('uuid').v4(), task_id: id, type: 'issue_photo', url: parsed.data.media_url, captured_at: new Date().toISOString() }
        try { await pgInsert('cleaning_task_media', media as any) } catch {}
      }
      await emitWorkTaskEvent({
        taskId: `cleaning_task:${String(id)}`,
        sourceType: 'cleaning_tasks',
        sourceRefIds: [String(id)],
        eventType: 'TASK_DETAIL_ASSET_CHANGED',
        changeScope: 'detail',
        changedFields: ['issues'],
        patch: { issue_reported: true },
        causedByUserId: String(user?.sub || '').trim() || null,
        visibilityHints: buildCleaningTaskVisibilityHints({ id }),
      })
      try { broadcastCleaningEvent({ event: 'issue', task_id: id }) } catch {}
      try {
        const operationId = require('uuid').v4()
        let propertyId = ''
        let managerRecipients: string[] = []
        try {
          const { pgPool } = require('../dbAdapter')
          if (pgPool) {
            const r = await pgPool.query(`SELECT property_id::text AS property_id FROM cleaning_tasks WHERE id::text=$1::text LIMIT 1`, [String(id)])
            propertyId = String(r?.rows?.[0]?.property_id || '').trim()
          }
        } catch {}
        try {
          const { listManagerUserIds } = require('./notifications')
          managerRecipients = Array.from(new Set(await listManagerUserIds({ roles: ['admin', 'offline_manager', 'customer_service'] })))
        } catch {}
        if (propertyId || managerRecipients.length) {
          await emitNotificationEvent(
            {
              type: 'ISSUE_REPORTED',
              entity: 'cleaning_task',
              entityId: String(id),
              propertyId,
              updatedAt: new Date().toISOString(),
              title: '房源问题反馈',
              body: `收到新的问题反馈：${String(issue.title || '').trim() || '问题'}`.slice(0, 240),
              data: {
                entity: 'cleaning_task',
                entityId: String(id),
                action: 'open_task',
                kind: 'issue_reported',
                task_id: id,
                issue_id: issue.id,
                issue_title: String(issue.title || '').trim() || undefined,
                issue_detail: issue.detail || undefined,
                severity: issue.severity || undefined,
                photo_url: parsed.data.media_url || undefined,
              },
              actorUserId: String(user?.sub || ''),
              recipientUserIds: managerRecipients,
            },
            { operationId },
          )
        }
      } catch {}
      return res.status(201).json(issue)
    }
    return res.status(201).json({ id: 'local', task_id: id })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'error' })
  }
})

// Submit consumables checklist (cannot skip; low requires photo)
const consumableSchema = z.object({
  living_room_photo_url: z.string().min(1),
  items: z.array(
    z.object({
      item_id: z.string().min(1),
      status: z.enum(['ok', 'low']),
      qty: z.number().int().min(1).optional(),
      note: z.string().optional(),
      photo_url: z.string().optional(),
      photo_urls: z.array(z.string().trim().min(1).max(800)).max(12).optional(),
    }),
  ),
})
router.get('/tasks/:id/consumables', requirePerm('cleaning_app.tasks.finish'), async (req, res) => {
  const { id } = req.params
  try {
    if (!hasPg) return res.json({ items: [] })
    const { pgPool } = require('../dbAdapter')
    if (!pgPool) return res.json({ items: [] })
    try {
      await pgPool.query(`ALTER TABLE cleaning_consumable_usages ADD COLUMN IF NOT EXISTS photo_urls text;`)
    } catch {}
    const rows = await pgPool.query(
      `SELECT id, item_id, qty, need_restock, note, status, photo_url, photo_urls, item_label, created_at
       FROM cleaning_consumable_usages
       WHERE task_id = $1
       ORDER BY created_at ASC, id ASC`,
      [String(id)],
    )
    const livingPhotoRow = await pgPool.query(
      `SELECT url
       FROM cleaning_task_media
       WHERE task_id::text = $1::text
         AND type = 'consumable_living_room_photo'
       ORDER BY captured_at DESC NULLS LAST, created_at DESC
       LIMIT 1`,
      [String(id)],
    )
    return res.json({
      living_room_photo_url: String(livingPhotoRow?.rows?.[0]?.url || '').trim() || null,
      items: (rows.rows || []).map((x: any) => ({
        id: String(x.id || ''),
        item_id: String(x.item_id || ''),
        qty: Number(x.qty || 0) || 0,
        need_restock: !!x.need_restock,
        note: x.note == null ? null : String(x.note),
        status: String(x.status || ''),
        photo_url: x.photo_url == null ? null : String(x.photo_url),
        photo_urls: normalizeStoredPhotoUrls(x.photo_urls, x.photo_url),
        item_label: x.item_label == null ? null : String(x.item_label),
        created_at: x.created_at == null ? null : String(x.created_at),
      })),
    })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'error' })
  }
})

router.post('/tasks/:id/consumables', requirePerm('cleaning_app.tasks.finish'), async (req, res) => {
  const user = (req as any).user
  const { id } = req.params
  const parsed = consumableSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (hasPg) {
      const { pgPool } = require('../dbAdapter')
      if (pgPool) {
        try {
          await pgPool.query(`CREATE TABLE IF NOT EXISTS cleaning_checklist_items (
            id text PRIMARY KEY,
            label text NOT NULL,
            kind text NOT NULL DEFAULT 'consumable',
            required boolean NOT NULL DEFAULT true,
            requires_photo_when_low boolean NOT NULL DEFAULT true,
            active boolean NOT NULL DEFAULT true,
            sort_order integer,
            created_by text,
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now()
          );`)
          await pgPool.query(`ALTER TABLE cleaning_consumable_usages ADD COLUMN IF NOT EXISTS status text;`)
          await pgPool.query(`ALTER TABLE cleaning_consumable_usages ADD COLUMN IF NOT EXISTS photo_url text;`)
          await pgPool.query(`ALTER TABLE cleaning_consumable_usages ADD COLUMN IF NOT EXISTS photo_urls text;`)
          await pgPool.query(`ALTER TABLE cleaning_consumable_usages ADD COLUMN IF NOT EXISTS item_label text;`)
        } catch {}
      }

      const activeItems = pgPool
        ? (
            await pgPool.query(
              `SELECT id, label, required, requires_photo_when_low
               FROM cleaning_checklist_items
               WHERE active = true
               ORDER BY sort_order ASC NULLS LAST, created_at ASC`,
            )
          )?.rows || []
        : []
      const byId = new Map(activeItems.map((x: any) => [String(x.id), x]))
      const submittedIds = new Set(parsed.data.items.map((x) => String(x.item_id)))
      const missing = activeItems.map((x: any) => String(x.id)).filter((x: string) => !submittedIds.has(x))
      if (missing.length) return res.status(400).json({ message: '缺少必填项', missing })

      const taskRow = await pgPool.query(`SELECT id, status, property_id::text AS property_id, finished_at FROM cleaning_tasks WHERE id=$1 LIMIT 1`, [String(id)])
      const task = taskRow?.rows?.[0]
      if (!task) return res.status(404).json({ message: 'task not found' })
      const existingRows = await pgPool.query(`SELECT id FROM cleaning_consumable_usages WHERE task_id=$1 LIMIT 1`, [String(id)])
      const hadExisting = !!existingRows?.rowCount

      for (const row of parsed.data.items) {
        const meta: any = byId.get(String(row.item_id)) || null
        const requiresPhoto = meta ? !!meta.requires_photo_when_low : true
        const photoUrls = normalizeStoredPhotoUrls(row.photo_urls, row.photo_url)
        if (row.status === 'low' && requiresPhoto && !photoUrls.length) {
          return res.status(400).json({ message: '不足项必须拍照', item_id: row.item_id })
        }
        if (row.status === 'low' && (!row.qty || row.qty < 1)) {
          return res.status(400).json({ message: '不足项必须填写数量', item_id: row.item_id })
        }
      }

      const livingRoomPhotoUrl = String(parsed.data.living_room_photo_url || '').trim()
      if (!livingRoomPhotoUrl) return res.status(400).json({ message: '请上传客厅照片' })

      await pgPool.query(`DELETE FROM cleaning_consumable_usages WHERE task_id=$1`, [String(id)])
      await pgPool.query(`DELETE FROM cleaning_task_media WHERE task_id::text=$1::text AND type='consumable_living_room_photo'`, [String(id)])

      for (const it of parsed.data.items) {
        const meta: any = byId.get(String(it.item_id)) || null
        const photoUrls = normalizeStoredPhotoUrls(it.photo_urls, it.photo_url)
        const row = {
          id: require('uuid').v4(),
          task_id: id,
          item_id: String(it.item_id),
          qty: it.status === 'low' ? Number(it.qty || 1) : 1,
          need_restock: it.status === 'low',
          note: it.note || null,
          status: it.status,
          photo_url: photoUrls[0] || null,
          photo_urls: photoUrls.length ? JSON.stringify(photoUrls) : null,
          item_label: meta ? String(meta.label || '') : null,
        }
        await pgInsert('cleaning_consumable_usages', row as any)
      }
      const restockItemsPayload = parsed.data.items
        .filter((it) => String(it.status || '').trim().toLowerCase() === 'low')
        .map((it) => {
          const meta: any = byId.get(String(it.item_id)) || null
          const qty0 = Number(it.qty || 1)
          const qty = Number.isFinite(qty0) && qty0 > 0 ? qty0 : 1
          return {
            item_id: String(it.item_id || '').trim(),
            label: meta ? String(meta.label || it.item_id || '').trim() : String(it.item_id || '').trim(),
            qty,
            status: 'low',
            photo_url: normalizeStoredPhotoUrls(it.photo_urls, it.photo_url)[0] || null,
            photo_urls: normalizeStoredPhotoUrls(it.photo_urls, it.photo_url),
            note: it.note == null ? null : String(it.note || '').trim(),
          }
        })
      await pgInsert('cleaning_task_media', {
        id: require('uuid').v4(),
        task_id: String(id),
        type: 'consumable_living_room_photo',
        url: livingRoomPhotoUrl,
        captured_at: new Date().toISOString(),
      } as any)
      const needsRestock = parsed.data.items.some((i) => i.status === 'low')
      const now = new Date().toISOString()
      const taskStatus = String(task.status || '').trim().toLowerCase()
      const isFinishedTask = ['cleaned', 'restock_pending', 'restocked', 'to_inspect', 'to_hang_keys', 'keys_hung', 'done', 'completed', 'ready'].includes(taskStatus)
      const patch: any = {}
      if (!isFinishedTask) patch.status = needsRestock ? 'restock_pending' : 'cleaned'
      if (!task.finished_at) patch.finished_at = now
      const up = Object.keys(patch).length ? await pgUpdate('cleaning_tasks', id, patch) : task
      const responsePayload = up || patch
      res.json(responsePayload)
      void (async () => {
        try {
          await emitWorkTaskEvent({
            taskId: `cleaning_task:${String(id)}`,
            sourceType: 'cleaning_tasks',
            sourceRefIds: [String(id)],
            eventType: needsRestock ? 'TASK_UPDATED' : 'TASK_COMPLETED',
            changeScope: Object.keys(patch).length ? 'list' : 'detail',
            changedFields: Array.from(new Set([...Object.keys(patch), 'restock_items'])),
            patch: { ...patch, restock_items: restockItemsPayload },
            causedByUserId: String(user?.sub || '').trim() || null,
            visibilityHints: buildCleaningTaskVisibilityHints(up || task),
          })
        } catch (eventError: any) {
          try { console.error(`[cleaning-app] consumables work_task_event_failed task_id=${String(id)} message=${String(eventError?.message || eventError)}`) } catch {}
        }
        try { broadcastCleaningEvent({ event: 'consumables_submitted', task_id: id, restock_pending: needsRestock }) } catch {}
        try {
          const operationId = require('uuid').v4()
          let propertyCode = ''
          try {
            const { pgPool } = require('../dbAdapter')
            if (pgPool) {
              const r = await pgPool.query(
                `SELECT COALESCE(p_id.code, p_code.code, t.property_id::text) AS property_code
                 FROM cleaning_tasks t
                 LEFT JOIN properties p_id ON (p_id.id::text) = (t.property_id::text)
                 LEFT JOIN properties p_code ON upper(p_code.code) = upper(t.property_id::text)
                 WHERE t.id=$1 LIMIT 1`,
                [id],
              )
              propertyCode = String(r?.rows?.[0]?.property_code || '').trim()
            }
          } catch {}
          const propertyId = String((up as any)?.property_id || task.property_id || '').trim()
          const restockLabels = restockItemsPayload.map((it) => (it.qty != null ? `${it.label} x${it.qty}` : it.label)).filter(Boolean)
          const restockSummary = restockLabels.length ? `待补货：${restockLabels.join('、')}` : ''
          const actorId = String(user?.sub || '')
          const restockRecipients = needsRestock ? await listConsumablesRestockNotificationUserIds(String(id), actorId) : []
          if (propertyId && (!needsRestock || restockRecipients.length)) {
            await emitNotificationEvent(
              {
                type: needsRestock ? 'WORK_TASK_UPDATED' : (hadExisting ? 'CLEANING_TASK_UPDATED' : 'CLEANING_COMPLETED'),
                entity: 'cleaning_task',
                entityId: String(id),
                propertyId,
                updatedAt: String(now),
                title: needsRestock
                  ? (propertyCode ? `消耗品需要补充：${propertyCode}` : '消耗品需要补充')
                  : (propertyCode ? `${hadExisting ? '补品已更新' : '清洁完成'}：${propertyCode}` : (hadExisting ? '补品已更新' : '清洁完成')),
                body: needsRestock ? restockSummary || '清洁已完成，待补货' : (hadExisting ? '清洁补品记录已修改，请检查更新' : '清洁已完成，待检查'),
                data: {
                  entity: 'cleaning_task',
                  entityId: String(id),
                  action: 'open_task',
                  kind: hadExisting ? 'consumables_updated' : 'consumables_submitted',
                  task_id: id,
                  restock_pending: needsRestock,
                  property_code: propertyCode,
                  restock_items: restockItemsPayload,
                },
                actorUserId: actorId,
                recipientUserIds: needsRestock ? restockRecipients : undefined,
              },
              { operationId },
            )
          }
        } catch (notificationError: any) {
          try { console.error(`[cleaning-app] consumables notification_failed task_id=${String(id)} message=${String(notificationError?.message || notificationError)}`) } catch {}
        }
      })()
      return
    }
    return res.json({ id, status: 'cleaned' })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'error' })
  }
})

// Restock done
router.patch('/tasks/:id/restock', requireAnyPerm(['cleaning_app.restock.manage', 'cleaning_app.tasks.finish']), async (req, res) => {
  const user = (req as any).user
  const { id } = req.params
  try {
    if (hasPg) {
      const up = await pgUpdate('cleaning_tasks', id, { status: 'restocked' } as any)
      await emitWorkTaskEvent({
        taskId: `cleaning_task:${String(id)}`,
        sourceType: 'cleaning_tasks',
        sourceRefIds: [String(id)],
        eventType: 'TASK_UPDATED',
        changeScope: 'list',
        changedFields: ['status'],
        patch: { status: 'restocked' },
        causedByUserId: String(user?.sub || '').trim() || null,
        visibilityHints: buildCleaningTaskVisibilityHints(up),
      })
      try { broadcastCleaningEvent({ event: 'restock_done', task_id: id }) } catch {}
      try {
        const operationId = require('uuid').v4()
        const now = new Date().toISOString()
        const propertyId = String((up as any)?.property_id || '').trim()
        if (propertyId) {
          await emitNotificationEvent(
            {
              type: 'CLEANING_TASK_UPDATED',
              entity: 'cleaning_task',
              entityId: String(id),
              propertyId,
              updatedAt: now,
              changes: ['status'],
              title: '任务有更新',
              body: '补货已完成，待检查',
              data: { entity: 'cleaning_task', entityId: String(id), action: 'open_task', kind: 'restock_done', task_id: id },
              actorUserId: String(user?.sub || ''),
            },
            { operationId },
          )
        }
      } catch {}
      return res.json(up || { id, status: 'restocked' })
    }
    return res.json({ id, status: 'restocked' })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'error' })
  }
})

// Inspection complete with lockbox video
const inspectSchema = z.object({ media_url: z.string().min(1), captured_at: z.string().optional(), lat: z.number().optional(), lng: z.number().optional() })
router.post('/tasks/:id/inspection-complete', requirePerm('cleaning_app.inspect.finish'), async (req, res) => {
  const user = (req as any).user
  const { id } = req.params
  const parsed = inspectSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (hasPg) {
      const now = new Date().toISOString()
      const patch: any = { status: 'inspected', lockbox_video_uploaded_at: now }
      const up = await pgUpdate('cleaning_tasks', id, patch)
      const media = { id: require('uuid').v4(), task_id: id, type: 'lockbox_video', url: parsed.data.media_url, captured_at: parsed.data.captured_at || now, lat: parsed.data.lat, lng: parsed.data.lng }
      try { await pgInsert('cleaning_task_media', media as any) } catch {}
      await emitWorkTaskEvent({
        taskId: `cleaning_task:${String(id)}`,
        sourceType: 'cleaning_tasks',
        sourceRefIds: [String(id)],
        eventType: 'TASK_COMPLETED',
        changeScope: 'list',
        changedFields: ['status', 'lockbox_video_uploaded_at', 'lockbox_video_url'],
        patch: { status: patch.status, lockbox_video_uploaded_at: patch.lockbox_video_uploaded_at },
        causedByUserId: String(user?.sub || '').trim() || null,
        visibilityHints: buildCleaningTaskVisibilityHints(up || patch),
      })
      try { broadcastCleaningEvent({ event: 'inspected', task_id: id }) } catch {}
      try {
        const operationId = require('uuid').v4()
        const propertyId = String((up as any)?.property_id || '').trim()
        const photoUrls = await listInspectionPhotoUrls(String(id))
        const recipients = await listKeysHungNotificationUserIds(String(user?.sub || ''))
        if (propertyId && recipients.length) {
          await emitNotificationEvent(
            {
              type: 'WORK_TASK_UPDATED',
              entity: 'cleaning_task',
              entityId: String(id),
              eventId: `keys_hung:${String(id)}`,
              propertyId,
              updatedAt: now,
              title: '房间已挂钥匙',
              body: '检查员已上传挂钥匙视频，房间钥匙已挂好',
              data: {
                entity: 'cleaning_task',
                entityId: String(id),
                action: 'open_task',
                kind: 'keys_hung',
                task_id: id,
                photo_url: photoUrls[0] || null,
                photo_urls: photoUrls,
              },
              actorUserId: String(user?.sub || ''),
              recipientUserIds: recipients,
            },
            { operationId },
          )
        }
      } catch {}
      return res.json(up || patch)
    }
    return res.json({ id, status: 'inspected' })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'error' })
  }
})

async function ensureCleaningTaskMediaNote() {
  try {
    if (!hasPg) return
    const { pgPool } = require('../dbAdapter')
    if (!pgPool) return
    await pgPool.query(`ALTER TABLE cleaning_task_media ADD COLUMN IF NOT EXISTS note text;`)
    await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_cleaning_task_media_task_type ON cleaning_task_media(task_id, type);`)
  } catch {}
}

async function ensureCleaningDayEndMediaTable() {
  try {
    if (!hasPg) return
    const { pgPool } = require('../dbAdapter')
    if (!pgPool) return
    await pgPool.query(`CREATE TABLE IF NOT EXISTS cleaning_day_end_media (
      id text PRIMARY KEY,
      user_id text NOT NULL,
      date date NOT NULL,
      kind text NOT NULL DEFAULT 'backup_key_return',
      url text NOT NULL,
      captured_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );`)
    await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_cleaning_day_end_media_user_date ON cleaning_day_end_media(user_id, date);`)
    await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_cleaning_day_end_media_date ON cleaning_day_end_media(date);`)
  } catch {}
}

async function ensureCleaningDayEndHandoverTable() {
  try {
    if (!hasPg) return
    const { pgPool } = require('../dbAdapter')
    if (!pgPool) return
    await ensureCleaningDayEndMediaTable()
    await pgPool.query(`CREATE TABLE IF NOT EXISTS cleaning_day_end_handover (
      user_id text NOT NULL,
      date date NOT NULL,
      no_dirty_linen boolean NOT NULL DEFAULT false,
      no_warehouse_key boolean NOT NULL DEFAULT false,
      submitted_at timestamptz NOT NULL DEFAULT now(),
      key_submitted_at timestamptz,
      dirty_linen_submitted_at timestamptz,
      warehouse_key_submitted_at timestamptz,
      consumable_submitted_at timestamptz,
      reject_submitted_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, date)
    );`)
    await pgPool.query(`ALTER TABLE cleaning_day_end_handover ADD COLUMN IF NOT EXISTS no_warehouse_key boolean NOT NULL DEFAULT false;`)
    await pgPool.query(`ALTER TABLE cleaning_day_end_handover ADD COLUMN IF NOT EXISTS key_submitted_at timestamptz;`)
    await pgPool.query(`ALTER TABLE cleaning_day_end_handover ADD COLUMN IF NOT EXISTS dirty_linen_submitted_at timestamptz;`)
    await pgPool.query(`ALTER TABLE cleaning_day_end_handover ADD COLUMN IF NOT EXISTS warehouse_key_submitted_at timestamptz;`)
    await pgPool.query(`ALTER TABLE cleaning_day_end_handover ADD COLUMN IF NOT EXISTS consumable_submitted_at timestamptz;`)
    await pgPool.query(`ALTER TABLE cleaning_day_end_handover ADD COLUMN IF NOT EXISTS reject_submitted_at timestamptz;`)
    await pgPool.query(`ALTER TABLE cleaning_day_end_handover ALTER COLUMN submitted_at DROP DEFAULT;`)
    await pgPool.query(`ALTER TABLE cleaning_day_end_handover ALTER COLUMN submitted_at DROP NOT NULL;`)
    await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_cleaning_day_end_handover_date ON cleaning_day_end_handover(date);`)
    await pgPool.query(`CREATE TABLE IF NOT EXISTS cleaning_day_end_reject_items (
      id text PRIMARY KEY,
      user_id text NOT NULL,
      date date NOT NULL,
      linen_type text NOT NULL,
      quantity integer NOT NULL DEFAULT 1,
      used_room text NOT NULL,
      photos_json jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );`)
    await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_cleaning_day_end_reject_items_user_date ON cleaning_day_end_reject_items(user_id, date);`)
  } catch {}
}

function canViewDayEndForAllUsers(user: any) {
  const role = String(user?.role || '').trim()
  const roles = Array.isArray(user?.roles) ? user.roles.map((x: any) => String(x || '').trim()) : []
  const all = new Set([role, ...roles].filter(Boolean))
  return all.has('admin') || all.has('offline_manager') || all.has('customer_service') || all.has('inventory_manager')
}

function roleNamesOfUser(user: any) {
  const role = String(user?.role || '').trim()
  const roles = Array.isArray(user?.roles) ? user.roles.map((x: any) => String(x || '').trim()) : []
  return Array.from(new Set([role, ...roles].filter(Boolean)))
}

function isInspectorOnlyDayEndUser(user: any) {
  const roleNames = roleNamesOfUser(user)
  return roleNames.includes('cleaning_inspector') && !roleNames.includes('cleaner') && !roleNames.includes('cleaner_inspector')
}

const inspectionPhotosSchema = z
  .object({
    items: z.array(
      z.object({
        area: z.enum(['toilet', 'living', 'sofa', 'bedroom', 'kitchen', 'shower_drain', 'unclean']),
        url: z.string().trim().min(1),
        note: z.string().trim().max(800).optional().nullable(),
        captured_at: z.string().trim().max(64).optional(),
      }),
    ),
  })
  .strict()

router.get('/tasks/:id/inspection-photos', requirePerm('cleaning_app.inspect.finish'), async (req, res) => {
  const { id } = req.params
  try {
    if (hasPg) {
      await ensureCleaningTaskMediaNote()
      const { pgPool } = require('../dbAdapter')
      if (!pgPool) return res.status(500).json({ message: 'pg not available' })
      const r = await pgPool.query(
        `SELECT type, url, note, captured_at, created_at
         FROM cleaning_task_media
         WHERE task_id=$1 AND type LIKE 'inspection_%'
         ORDER BY created_at ASC`,
        [id],
      )
      const items = (r?.rows || []).map((x: any) => {
        const type = String(x.type || '')
        const area = type.startsWith('inspection_') ? type.slice('inspection_'.length) : type
        return {
          area,
          url: String(x.url || ''),
          note: x.note == null ? null : String(x.note || ''),
          captured_at: x.captured_at ? String(x.captured_at) : null,
          created_at: x.created_at ? String(x.created_at) : null,
        }
      })
      return res.json({ items })
    }
    return res.json({ items: [] })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'error' })
  }
})

router.post('/tasks/:id/inspection-photos', requirePerm('cleaning_app.inspect.finish'), async (req, res) => {
  const user = (req as any).user
  const { id } = req.params
  const parsed = inspectionPhotosSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    const limits: Record<string, number> = { toilet: 9, living: 3, sofa: 2, bedroom: 8, kitchen: 2, shower_drain: 1, unclean: 12 }
    const byArea = new Map<string, number>()
    for (const it of parsed.data.items) {
      const a = String(it.area)
      byArea.set(a, (byArea.get(a) || 0) + 1)
      const lim = limits[a] ?? 1
      if ((byArea.get(a) || 0) > lim) return res.status(400).json({ message: '超出数量限制', area: a, limit: lim })
    }
    if (hasPg) {
      await ensureCleaningTaskMediaNote()
      const { pgPool } = require('../dbAdapter')
      if (!pgPool) return res.status(500).json({ message: 'pg not available' })
      const uuid = require('uuid')
      await pgPool.query(`DELETE FROM cleaning_task_media WHERE task_id=$1 AND type LIKE 'inspection_%'`, [id])
      for (const it of parsed.data.items) {
        const type = `inspection_${it.area}`
        const cap = String(it.captured_at || '').trim()
        const capturedAt = cap ? new Date(cap) : new Date()
        await pgPool.query(
          `INSERT INTO cleaning_task_media (id, task_id, type, url, note, captured_at)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [uuid.v4(), id, type, String(it.url), it.note == null ? null : String(it.note || ''), capturedAt.toISOString()],
        )
      }
      try { broadcastCleaningEvent({ event: 'inspection_photos_saved', task_id: id }) } catch {}
      return res.status(201).json({ ok: true })
    }
    return res.status(201).json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'error' })
  }
})

const completionPhotosSchema = z
  .object({
    items: z.array(
      z.object({
        area: z.enum(['toilet', 'living', 'sofa', 'bedroom', 'kitchen', 'vacuum_used', 'shower_drain']),
        url: z.string().trim().min(1),
        note: z.string().trim().max(800).optional().nullable(),
        captured_at: z.string().trim().max(64).optional(),
      }),
    ),
  })
  .strict()

router.get('/tasks/:id/completion-photos', requirePerm('cleaning_app.tasks.finish'), async (req, res) => {
  const { id } = req.params
  try {
    if (hasPg) {
      await ensureCleaningTaskMediaNote()
      const { pgPool } = require('../dbAdapter')
      if (!pgPool) return res.status(500).json({ message: 'pg not available' })
      const r = await pgPool.query(
        `SELECT type, url, note, captured_at, created_at
         FROM cleaning_task_media
         WHERE task_id=$1 AND type LIKE 'completion_%'
         ORDER BY created_at ASC`,
        [id],
      )
      const items = (r?.rows || []).map((x: any) => {
        const type = String(x.type || '')
        const area = type.startsWith('completion_') ? type.slice('completion_'.length) : type
        return {
          area,
          url: String(x.url || ''),
          note: x.note == null ? null : String(x.note || ''),
          captured_at: x.captured_at ? String(x.captured_at) : null,
          created_at: x.created_at ? String(x.created_at) : null,
        }
      })
      return res.json({ items })
    }
    return res.json({ items: [] })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'error' })
  }
})

router.post('/tasks/:id/completion-photos', requirePerm('cleaning_app.tasks.finish'), async (req, res) => {
  const user = (req as any).user
  const { id } = req.params
  const parsed = completionPhotosSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    const limits: Record<string, number> = { toilet: 9, living: 3, sofa: 2, bedroom: 8, kitchen: 2, vacuum_used: 1, shower_drain: 1 }
    const byArea = new Map<string, number>()
    for (const it of parsed.data.items) {
      const a = String(it.area)
      byArea.set(a, (byArea.get(a) || 0) + 1)
      const lim = limits[a] ?? 1
      if ((byArea.get(a) || 0) > lim) return res.status(400).json({ message: '超出数量限制', area: a, limit: lim })
    }
    if (hasPg) {
      await ensureCleaningTaskMediaNote()
      const { pgPool } = require('../dbAdapter')
      if (!pgPool) return res.status(500).json({ message: 'pg not available' })
      const uuid = require('uuid')
      const batchId = uuid.v4()
      await pgPool.query(`DELETE FROM cleaning_task_media WHERE task_id=$1 AND type LIKE 'completion_%'`, [id])
      for (const it of parsed.data.items) {
        const type = `completion_${it.area}`
        const cap = String(it.captured_at || '').trim()
        const capturedAt = cap ? new Date(cap) : new Date()
        await pgPool.query(
          `INSERT INTO cleaning_task_media (id, task_id, type, url, note, captured_at)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [uuid.v4(), id, type, String(it.url), it.note == null ? null : String(it.note || ''), capturedAt.toISOString()],
        )
      }
      try { broadcastCleaningEvent({ event: 'completion_photos_saved', task_id: id }) } catch {}
      try {
        const operationId = require('uuid').v4()
        let propertyId = ''
        try {
          const r2 = await pgPool.query(`SELECT property_id::text AS property_id FROM cleaning_tasks WHERE id::text=$1::text LIMIT 1`, [String(id)])
          propertyId = String(r2?.rows?.[0]?.property_id || '').trim()
        } catch {}
        if (propertyId) {
          await emitNotificationEvent(
            {
              type: 'CLEANING_TASK_UPDATED',
              entity: 'cleaning_task',
              entityId: String(id),
              propertyId,
              updatedAt: new Date().toISOString(),
              title: '房间完成照片已提交',
              body: '清洁员已上传房间完成照片',
              data: { entity: 'cleaning_task', entityId: String(id), action: 'open_task', kind: 'completion_photos_saved', task_id: id, batch_id: batchId },
              actorUserId: String(user?.sub || ''),
            },
            { operationId },
          )
        }
      } catch {}
      return res.status(201).json({ ok: true })
    }
    return res.status(201).json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'error' })
  }
})

const lockboxVideoSchema = z.object({ media_url: z.string().min(1), captured_at: z.string().optional(), lat: z.number().optional(), lng: z.number().optional() })
router.post('/tasks/:id/lockbox-video', requirePerm('cleaning_app.tasks.finish'), async (req, res) => {
  const user = (req as any).user
  const { id } = req.params
  const parsed = lockboxVideoSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (hasPg) {
      await ensureCleaningTaskMediaNote()
      const { pgPool } = require('../dbAdapter')
      if (!pgPool) return res.status(500).json({ message: 'pg not available' })
      const uuid = require('uuid')
      const now = new Date().toISOString()
      await pgPool.query(`DELETE FROM cleaning_task_media WHERE task_id=$1 AND type='lockbox_video'`, [id])
      await pgPool.query(
        `INSERT INTO cleaning_task_media (id, task_id, type, url, captured_at, lat, lng)
         VALUES ($1,$2,'lockbox_video',$3,$4,$5,$6)`,
        [uuid.v4(), id, String(parsed.data.media_url), String(parsed.data.captured_at || now), parsed.data.lat ?? null, parsed.data.lng ?? null],
      )
      const up = await pgUpdate('cleaning_tasks', id, { lockbox_video_uploaded_at: now } as any)
      try { broadcastCleaningEvent({ event: 'lockbox_video_uploaded', task_id: id }) } catch {}
      try {
        const operationId = require('uuid').v4()
        const propertyId = String((up as any)?.property_id || '').trim()
        const recipients = await listKeysHungNotificationUserIds(String(user?.sub || ''))
        if (propertyId && recipients.length) {
          await emitNotificationEvent(
            {
              type: 'WORK_TASK_UPDATED',
              entity: 'cleaning_task',
              entityId: String(id),
              propertyId,
              updatedAt: now,
              title: '房间已挂钥匙',
              body: '挂钥匙视频已上传，房间钥匙已挂好',
              data: { entity: 'cleaning_task', entityId: String(id), action: 'open_task', kind: 'keys_hung', task_id: id },
              actorUserId: String(user?.sub || ''),
              recipientUserIds: recipients,
            },
            { operationId },
          )
        }
      } catch {}
      return res.status(201).json(up || { id, lockbox_video_uploaded_at: now })
    }
    return res.status(201).json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'error' })
  }
})

router.post('/tasks/:id/self-complete', requirePerm('cleaning_app.tasks.finish'), async (req, res) => {
  const user = (req as any).user
  const { id } = req.params
  try {
    if (hasPg) {
      await ensureCleaningTaskMediaNote()
      const { pgPool } = require('../dbAdapter')
      if (!pgPool) return res.status(500).json({ message: 'pg not available' })

      const rTask = await pgPool.query(
        `SELECT id::text AS id, COALESCE(status,'') AS status, finished_at, lockbox_video_uploaded_at, LOWER(COALESCE(task_type, '')) AS task_type,
                inspection_mode, inspection_due_date::text AS inspection_due_date, inspector_id
         FROM cleaning_tasks
         WHERE id::text=$1
         LIMIT 1`,
        [String(id)],
      )
      const task = rTask?.rows?.[0] || null
      if (!task) return res.status(404).json({ message: 'task not found' })
      const st0 = String(task.status || '').trim().toLowerCase()
      const taskType = String(task.task_type || '').trim().toLowerCase()
      const isStayoverTask = taskType === 'stayover_clean'
      const inspectionMode = effectiveInspectionMode(task)
      if (st0 === 'cancelled' || st0 === 'canceled') return res.status(400).json({ message: 'task is cancelled' })
      if (!isStayoverTask && inspectionMode !== 'self_complete') {
        return res.status(400).json({ message: '待经理确认检查安排，当前任务不能直接自完成' })
      }

      if (!isStayoverTask) {
        const rLock = await pgPool.query(
          `SELECT 1 FROM cleaning_task_media WHERE task_id=$1 AND type='lockbox_video' LIMIT 1`,
          [String(id)],
        )
        const hasLock = !!rLock?.rowCount || !!task.lockbox_video_uploaded_at
        if (!hasLock) return res.status(400).json({ message: '缺少挂钥匙视频' })
      }

      const rComp = await pgPool.query(
        `SELECT type FROM cleaning_task_media WHERE task_id=$1 AND type LIKE 'completion_%'`,
        [String(id)],
      )
      const got = new Set<string>()
      for (const row of rComp?.rows || []) {
        const type = String(row.type || '')
        const a = type.startsWith('completion_') ? type.slice('completion_'.length) : type
        if (a) got.add(a)
      }
      const missingAreas = REQUIRED_COMPLETION_PHOTO_AREAS.filter((a) => !got.has(a))
      if (missingAreas.length) return res.status(400).json({ message: '房间完成照片未齐', missing_areas: missingAreas })

      let needsRestock = false
      if (!isStayoverTask) {
        const rConsum = await pgPool.query(`SELECT 1 FROM cleaning_consumable_usages WHERE task_id=$1 LIMIT 1`, [String(id)])
        const hasConsum = !!rConsum?.rowCount
        if (!hasConsum) return res.status(400).json({ message: '请先完成消耗品补充' })

        const rNeed = await pgPool.query(
          `SELECT 1
           FROM cleaning_consumable_usages
           WHERE task_id=$1 AND (need_restock = true OR COALESCE(status,'') = 'low')
           LIMIT 1`,
          [String(id)],
        )
        needsRestock = !!rNeed?.rowCount
      }

      const now = new Date().toISOString()
      const patch: any = {}
      if (st0 !== 'restocked' && st0 !== 'ready') patch.status = isStayoverTask ? 'cleaned' : (needsRestock ? 'restock_pending' : 'cleaned')
      if (!task.finished_at) patch.finished_at = now
      if (Object.keys(patch).length) {
        const up = await pgUpdate('cleaning_tasks', id, patch)
        try {
          const { recordCleaningTaskStandardLinenUsage } = require('./inventory')
          await recordCleaningTaskStandardLinenUsage({
            cleaningTaskId: String(id),
            actorId: String(user?.sub || '').trim() || null,
          })
        } catch {}
        try { broadcastCleaningEvent({ event: 'self_completed', task_id: id }) } catch {}
        try {
          const operationId = require('uuid').v4()
          const propertyId = String((up as any)?.property_id || '').trim()
          if (propertyId) {
            await emitNotificationEvent(
              {
                type: 'CLEANING_COMPLETED',
                entity: 'cleaning_task',
                entityId: String(id),
                propertyId,
                updatedAt: now,
                title: isStayoverTask ? '入住中清洁已完成' : '任务已完成',
                body: isStayoverTask ? '清洁员已完成入住中清洁' : '清洁员已标记任务完成',
                data: { entity: 'cleaning_task', entityId: String(id), action: 'open_task', kind: 'self_completed', task_id: id },
                actorUserId: String(user?.sub || ''),
              },
              { operationId },
            )
          }
        } catch {}
        return res.json(up || { id, ...patch })
      }
      try {
        const { recordCleaningTaskStandardLinenUsage } = require('./inventory')
        await recordCleaningTaskStandardLinenUsage({
          cleaningTaskId: String(id),
          actorId: String(user?.sub || '').trim() || null,
        })
      } catch {}
      return res.json({ ok: true, id: String(id) })
    }
    return res.json({ ok: true, id: String(id) })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'error' })
  }
})

const restockProofSchema = z
  .object({
    items: z.array(
      z.object({
        item_id: z.string().trim().min(1).max(80),
        status: z.enum(['restocked', 'unavailable']),
        qty: z.number().int().min(1).optional().nullable(),
        note: z.string().trim().max(800).optional().nullable(),
        proof_url: z.string().trim().min(1).optional().nullable(),
        proof_urls: z.array(z.string().trim().min(1).max(800)).max(12).optional(),
      }),
    ),
  })
  .strict()

router.get('/tasks/:id/restock-proof', requireAnyPerm(['cleaning_app.inspect.finish', 'cleaning_app.tasks.finish']), async (req, res) => {
  const { id } = req.params
  try {
    if (hasPg) {
      await ensureCleaningTaskMediaNote()
      const { pgPool } = require('../dbAdapter')
      if (!pgPool) return res.status(500).json({ message: 'pg not available' })
      const r = await pgPool.query(
        `SELECT type, url, note, created_at
         FROM cleaning_task_media
         WHERE task_id=$1 AND type LIKE 'restock_proof:%'
         ORDER BY created_at ASC`,
        [id],
      )
      const grouped = new Map<string, any>()
      for (const x of r?.rows || []) {
        const type = String(x.type || '')
        const itemId = type.includes(':') ? type.split(':').slice(1).join(':') : type
        let meta: any = null
        try {
          const raw = String(x.note || '').trim()
          meta = raw && (raw.startsWith('{') || raw.startsWith('[')) ? JSON.parse(raw) : null
        } catch {}
        const proofUrl = (() => {
          const u = String(x.url || '').trim()
          return u && /^https?:\/\//i.test(u) ? u : null
        })()
        const prev = grouped.get(itemId) || {
          item_id: itemId,
          proof_url: null,
          proof_urls: [] as string[],
          status: meta?.status == null ? null : String(meta.status || ''),
          qty: meta?.qty == null ? null : Number(meta.qty),
          note: meta?.note == null ? null : String(meta.note || ''),
          created_at: x.created_at ? String(x.created_at) : null,
        }
        if (proofUrl && !prev.proof_urls.includes(proofUrl)) prev.proof_urls.push(proofUrl)
        prev.proof_url = prev.proof_urls[0] || null
        grouped.set(itemId, prev)
      }
      const items = Array.from(grouped.values())
      return res.json({ items })
    }
    return res.json({ items: [] })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'error' })
  }
})

router.post('/tasks/:id/restock-proof', requireAnyPerm(['cleaning_app.inspect.finish', 'cleaning_app.tasks.finish']), async (req, res) => {
  const user = (req as any).user
  const { id } = req.params
  const parsed = restockProofSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    const uniq = new Set<string>()
    for (const it of parsed.data.items) {
      const k = String(it.item_id || '').trim()
      if (uniq.has(k)) return res.status(400).json({ message: '重复 item_id', item_id: k })
      uniq.add(k)
    }
    if (hasPg) {
      await ensureCleaningTaskMediaNote()
      const { pgPool } = require('../dbAdapter')
      if (!pgPool) return res.status(500).json({ message: 'pg not available' })
      const uuid = require('uuid')
      const batchId = uuid.v4()
      await pgPool.query(`DELETE FROM cleaning_task_media WHERE task_id=$1 AND type LIKE 'restock_proof:%'`, [id])
      for (const it of parsed.data.items) {
        const meta = { status: it.status, qty: it.qty == null ? null : Number(it.qty), note: it.note == null ? null : String(it.note || '') }
        const proofUrls = normalizeStoredPhotoUrls(it.proof_urls, it.proof_url)
        const urlsToPersist = it.status === 'unavailable' ? ['no_photo'] : (proofUrls.length ? proofUrls : ['no_photo'])
        for (const url of urlsToPersist) {
          await pgPool.query(
            `INSERT INTO cleaning_task_media (id, task_id, type, url, note, captured_at)
             VALUES ($1,$2,$3,$4,$5,now())`,
            [uuid.v4(), id, `restock_proof:${it.item_id}`, url, JSON.stringify(meta)],
          )
        }
      }
      try { broadcastCleaningEvent({ event: 'restock_proof_saved', task_id: id }) } catch {}
      try {
        const operationId = require('uuid').v4()
        let propertyId = ''
        try {
          const r2 = await pgPool.query(`SELECT property_id::text AS property_id FROM cleaning_tasks WHERE id::text=$1::text LIMIT 1`, [String(id)])
          propertyId = String(r2?.rows?.[0]?.property_id || '').trim()
        } catch {}
        if (propertyId) {
          await emitNotificationEvent(
            {
              type: 'CLEANING_TASK_UPDATED',
              entity: 'cleaning_task',
              entityId: String(id),
              propertyId,
              updatedAt: new Date().toISOString(),
              title: '补货凭证已提交',
              body: '检查员已提交补货凭证',
              data: { entity: 'cleaning_task', entityId: String(id), action: 'open_task', kind: 'restock_proof_saved', task_id: id, batch_id: batchId },
              actorUserId: String(user?.sub || ''),
            },
            { operationId },
          )
        }
      } catch {}
      return res.status(201).json({ ok: true })
    }
    return res.status(201).json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'error' })
  }
})

// Set ready
router.patch('/tasks/:id/ready', requirePerm('cleaning_app.ready.set'), async (req, res) => {
  const user = (req as any).user
  const { id } = req.params
  try {
    if (hasPg) {
      const up = await pgUpdate('cleaning_tasks', id, { status: 'ready' } as any)
      try { broadcastCleaningEvent({ event: 'ready', task_id: id }) } catch {}
      try {
        const operationId = require('uuid').v4()
        const now = new Date().toISOString()
        const propertyId = String((up as any)?.property_id || '').trim()
        if (propertyId) {
          await emitNotificationEvent(
            {
              type: 'CLEANING_TASK_UPDATED',
              entity: 'cleaning_task',
              entityId: String(id),
              propertyId,
              updatedAt: now,
              changes: ['status'],
              title: '可入住',
              body: '房源已标记为可入住',
              data: { entity: 'cleaning_task', entityId: String(id), action: 'open_task', kind: 'ready', task_id: id },
              actorUserId: String(user?.sub || ''),
            },
            { operationId },
          )
        }
      } catch {}
      return res.json(up || { id, status: 'ready' })
    }
    return res.json({ id, status: 'ready' })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'error' })
  }
})

const dayEndBackupKeysListSchema = z.object({ date: z.string().trim().min(10).max(32).optional(), user_id: z.string().trim().max(80).optional() })

const dayEndHandoverListSchema = z.object({ date: z.string().trim().min(10).max(32).optional(), user_id: z.string().trim().max(80).optional() })

router.get('/linen-types', requireAnyPerm(['cleaning_app.tasks.finish', 'cleaning_app.inspect.finish', 'cleaning_app.calendar.view.all']), async (_req, res) => {
  try {
    if (!hasPg) return res.json([])
    const { pgPool } = require('../dbAdapter')
    if (!pgPool) return res.json([])
    await pgPool.query(
      `INSERT INTO inventory_linen_types (code, name, in_set, set_divisor, sort_order, active)
       VALUES
         ('bedsheet','床单',true,1,10,true),
         ('duvet_cover','被套',true,1,20,true),
         ('pillowcase','枕套',true,2,30,true),
         ('hand_towel','手巾',true,1,35,true),
         ('bath_mat','地巾',true,1,36,true),
         ('tea_towel','茶巾',true,1,37,true),
         ('bath_towel','浴巾',true,1,40,true)
       ON CONFLICT (code) DO NOTHING`,
    )
    const rows = await pgPool.query(
      `SELECT code, name, sort_order
       FROM inventory_linen_types
       WHERE active = true
         AND COALESCE(NULLIF(TRIM(name), ''), code, '') <> ''
       ORDER BY COALESCE(sort_order, 9999) ASC, code ASC`,
    )
    const seen = new Set<string>()
    const out = []
    for (const row of rows.rows || []) {
      const name = String(row.name || '').trim()
      if (!name || seen.has(name)) continue
      seen.add(name)
      out.push({
        code: String(row.code || ''),
        name,
        sort_order: Number(row.sort_order || 0) || 0,
      })
    }
    return res.json(out)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'error' })
  }
})

router.get('/property-codes', requireAnyPerm(['cleaning_app.tasks.finish', 'cleaning_app.inspect.finish', 'cleaning_app.calendar.view.all']), async (req, res) => {
  try {
    if (!hasPg) return res.json([])
    const { pgPool } = require('../dbAdapter')
    if (!pgPool) return res.json([])
    const q = String((req.query as any)?.q || '').trim()
    const values: any[] = []
    let where = `WHERE COALESCE(code, '') <> ''`
    if (q) {
      values.push(`%${q}%`)
      where += ` AND code ILIKE $${values.length}`
    }
    values.push(q ? 100 : 5000)
    const rows = await pgPool.query(
      `SELECT id::text AS id, code
       FROM properties
       ${where}
       ORDER BY code ASC
       LIMIT $${values.length}`,
      values,
    )
    return res.json((rows.rows || []).map((x: any) => ({
      id: String(x.id || ''),
      code: String(x.code || ''),
    })))
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'error' })
  }
})

const dayEndHandoverPostSchema = z
  .object({
    date: z.string().trim().min(10).max(32),
    section: z.enum(['all', 'key', 'dirty_linen', 'return_wash', 'warehouse_key', 'consumable', 'reject']).optional(),
    key_photos: z.array(z.object({ url: z.string().trim().min(1).max(800), captured_at: z.string().trim().max(64).optional() })).max(30).default([]),
    dirty_linen_photos: z.array(z.object({ url: z.string().trim().min(1).max(800), captured_at: z.string().trim().max(64).optional() })).max(30).default([]),
    return_wash_photos: z.array(z.object({ url: z.string().trim().min(1).max(800), captured_at: z.string().trim().max(64).optional() })).max(30).default([]),
    warehouse_key_photos: z.array(z.object({ url: z.string().trim().min(1).max(800), captured_at: z.string().trim().max(64).optional() })).max(30).default([]),
    consumable_photos: z.array(z.object({ url: z.string().trim().min(1).max(800), captured_at: z.string().trim().max(64).optional() })).max(30).default([]),
    reject_items: z.array(z.object({
      linen_type: z.string().trim().min(1).max(80),
      quantity: z.coerce.number().int().min(1).max(999),
      used_room: z.string().trim().min(1).max(80),
      photos: z.array(z.object({ url: z.string().trim().min(1).max(800), captured_at: z.string().trim().max(64).optional() })).min(1).max(10),
    })).max(30).default([]),
    no_dirty_linen: z.boolean().optional(),
    no_warehouse_key: z.boolean().optional(),
  })
  .strict()

router.get('/day-end/backup-keys', requireAnyPerm(['cleaning_app.tasks.finish', 'cleaning_app.inspect.finish', 'cleaning_app.calendar.view.all']), async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  const parsed = dayEndBackupKeysListSchema.safeParse(req.query || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (!hasPg) return res.json({ items: [] })
    const { pgPool } = require('../dbAdapter')
    if (!pgPool) return res.json({ items: [] })
    await ensureCleaningDayEndMediaTable()
    const date = String(parsed.data.date || '').slice(0, 10)
    const canAll = canViewDayEndForAllUsers(user)
    const userId = canAll && parsed.data.user_id ? String(parsed.data.user_id) : String(user.sub || '')
    if (!userId) return res.status(401).json({ message: 'unauthorized' })
    const r = await pgPool.query(
      `SELECT id, url, captured_at, created_at
       FROM cleaning_day_end_media
       WHERE user_id = $1::text
         AND ($2::date IS NULL OR date = $2::date)
         AND kind = 'backup_key_return'
       ORDER BY created_at ASC`,
      [userId, date ? date : null],
    )
    const items = (r?.rows || []).map((x: any) => ({
      id: String(x.id || ''),
      url: String(x.url || ''),
      captured_at: x.captured_at ? String(x.captured_at) : null,
      created_at: x.created_at ? String(x.created_at) : null,
    }))
    return res.json({ items })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'error' })
  }
})

router.get('/day-end/handover', requireAnyPerm(['cleaning_app.tasks.finish', 'cleaning_app.inspect.finish', 'cleaning_app.calendar.view.all']), async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  const parsed = dayEndHandoverListSchema.safeParse(req.query || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (!hasPg) return res.json({ key_photos: [], dirty_linen_photos: [], return_wash_photos: [], warehouse_key_photos: [], consumable_photos: [], reject_items: [], no_dirty_linen: false, no_warehouse_key: false, submitted_at: null, updated_at: null })
    const { pgPool } = require('../dbAdapter')
    if (!pgPool) return res.json({ key_photos: [], dirty_linen_photos: [], return_wash_photos: [], warehouse_key_photos: [], consumable_photos: [], reject_items: [], no_dirty_linen: false, no_warehouse_key: false, submitted_at: null, updated_at: null })
    await ensureCleaningDayEndHandoverTable()
    const date = String(parsed.data.date || '').slice(0, 10)
    const canAll = canViewDayEndForAllUsers(user)
    const userId = canAll && parsed.data.user_id ? String(parsed.data.user_id) : String(user.sub || '')
    if (!userId) return res.status(401).json({ message: 'unauthorized' })
    const [mediaRes, statusRes, rejectRes] = await Promise.all([
      pgPool.query(
        `SELECT id, kind, url, captured_at, created_at
         FROM cleaning_day_end_media
         WHERE user_id = $1::text
           AND ($2::date IS NULL OR date = $2::date)
           AND kind IN ('backup_key_return', 'dirty_linen_return', 'return_wash_linen', 'warehouse_key_return', 'remaining_consumables')
         ORDER BY created_at ASC`,
        [userId, date ? date : null],
      ),
      pgPool.query(
        `SELECT no_dirty_linen, no_warehouse_key, submitted_at, updated_at,
                key_submitted_at, dirty_linen_submitted_at, warehouse_key_submitted_at, consumable_submitted_at, reject_submitted_at
         FROM cleaning_day_end_handover
         WHERE user_id = $1::text
           AND ($2::date IS NULL OR date = $2::date)
         ORDER BY date DESC
        LIMIT 1`,
        [userId, date ? date : null],
      ),
      pgPool.query(
        `SELECT id, linen_type, quantity, used_room, photos_json, created_at, updated_at
         FROM cleaning_day_end_reject_items
         WHERE user_id = $1::text
           AND ($2::date IS NULL OR date = $2::date)
         ORDER BY created_at ASC`,
        [userId, date ? date : null],
      ),
    ])
    const rows = mediaRes?.rows || []
    const key_photos = rows
      .filter((x: any) => String(x.kind || '') === 'backup_key_return')
      .map((x: any) => ({
        id: String(x.id || ''),
        url: String(x.url || ''),
        captured_at: x.captured_at ? String(x.captured_at) : null,
        created_at: x.created_at ? String(x.created_at) : null,
      }))
    const return_wash_photos = rows
      .filter((x: any) => {
        const kind = String(x.kind || '')
        return kind === 'dirty_linen_return' || kind === 'return_wash_linen'
      })
      .map((x: any) => ({
        id: String(x.id || ''),
        url: String(x.url || ''),
        captured_at: x.captured_at ? String(x.captured_at) : null,
        created_at: x.created_at ? String(x.created_at) : null,
      }))
    const consumable_photos = rows
      .filter((x: any) => String(x.kind || '') === 'remaining_consumables')
      .map((x: any) => ({
        id: String(x.id || ''),
        url: String(x.url || ''),
        captured_at: x.captured_at ? String(x.captured_at) : null,
        created_at: x.created_at ? String(x.created_at) : null,
      }))
    const warehouse_key_photos = rows
      .filter((x: any) => String(x.kind || '') === 'warehouse_key_return')
      .map((x: any) => ({
        id: String(x.id || ''),
        url: String(x.url || ''),
        captured_at: x.captured_at ? String(x.captured_at) : null,
        created_at: x.created_at ? String(x.created_at) : null,
      }))
    const reject_items = (rejectRes?.rows || []).map((x: any) => ({
      id: String(x.id || ''),
      linen_type: String(x.linen_type || ''),
      quantity: Number(x.quantity || 0) || 0,
      used_room: String(x.used_room || ''),
      photos: Array.isArray(x.photos_json) ? x.photos_json.map((p: any, idx: number) => ({
        id: `${String(x.id || 'reject')}_${idx}`,
        url: String(p?.url || ''),
        captured_at: p?.captured_at ? String(p.captured_at) : null,
      })).filter((p: any) => !!p.url) : [],
      created_at: x.created_at ? String(x.created_at) : null,
      updated_at: x.updated_at ? String(x.updated_at) : null,
    }))
    const statusRow = statusRes?.rows?.[0] || null
    const rawSubmittedAt = statusRow?.submitted_at ? String(statusRow.submitted_at) : null
    const sectionSubmittedTimes = [
      statusRow?.key_submitted_at,
      statusRow?.dirty_linen_submitted_at,
      statusRow?.warehouse_key_submitted_at,
      statusRow?.consumable_submitted_at,
      statusRow?.reject_submitted_at,
    ]
      .map((value: any) => (value ? String(value) : ''))
      .filter(Boolean)
    const submittedAtTime = rawSubmittedAt ? new Date(rawSubmittedAt).getTime() : NaN
    const isFinalSubmitted = Number.isFinite(submittedAtTime) && sectionSubmittedTimes.length === 5 && sectionSubmittedTimes.every((value: string) => new Date(value).getTime() === submittedAtTime)
    return res.json({
      key_photos,
      dirty_linen_photos: return_wash_photos,
      return_wash_photos,
      warehouse_key_photos,
      consumable_photos,
      reject_items,
      no_dirty_linen: !!statusRow?.no_dirty_linen,
      no_warehouse_key: !!statusRow?.no_warehouse_key,
      submitted_at: isFinalSubmitted ? rawSubmittedAt : null,
      key_submitted_at: statusRow?.key_submitted_at ? String(statusRow.key_submitted_at) : null,
      dirty_linen_submitted_at: statusRow?.dirty_linen_submitted_at ? String(statusRow.dirty_linen_submitted_at) : null,
      warehouse_key_submitted_at: statusRow?.warehouse_key_submitted_at ? String(statusRow.warehouse_key_submitted_at) : null,
      consumable_submitted_at: statusRow?.consumable_submitted_at ? String(statusRow.consumable_submitted_at) : null,
      reject_submitted_at: statusRow?.reject_submitted_at ? String(statusRow.reject_submitted_at) : null,
      updated_at: statusRow?.updated_at ? String(statusRow.updated_at) : null,
    })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'error' })
  }
})

const dayEndBackupKeysPostSchema = z
  .object({
    date: z.string().trim().min(10).max(32),
    items: z.array(z.object({ url: z.string().trim().min(1).max(800), captured_at: z.string().trim().max(64).optional() })).min(1).max(30),
  })
  .strict()

router.post('/day-end/backup-keys', requireAnyPerm(['cleaning_app.tasks.finish', 'cleaning_app.inspect.finish']), async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  const parsed = dayEndBackupKeysPostSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (!hasPg) return res.status(201).json({ ok: true })
    const { pgPool } = require('../dbAdapter')
    if (!pgPool) return res.status(500).json({ message: 'pg not available' })
    await ensureCleaningDayEndMediaTable()
    const uuid = require('uuid')
    const userId = String(user.sub || '').trim()
    const date = String(parsed.data.date || '').slice(0, 10)
    for (const it of parsed.data.items) {
      const cap = String(it.captured_at || '').trim()
      const capturedAt = cap ? new Date(cap) : null
      await pgPool.query(
        `INSERT INTO cleaning_day_end_media (id, user_id, date, kind, url, captured_at)
         VALUES ($1,$2,$3,'backup_key_return',$4,$5)`,
        [uuid.v4(), userId, date, String(it.url), capturedAt ? capturedAt.toISOString() : null],
      )
    }
    return res.status(201).json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'error' })
  }
})

router.post('/day-end/handover', requireAnyPerm(['cleaning_app.tasks.finish', 'cleaning_app.inspect.finish']), async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  const parsed = dayEndHandoverPostSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (!hasPg) return res.status(201).json({ ok: true })
    const { pgPool } = require('../dbAdapter')
    if (!pgPool) return res.status(500).json({ message: 'pg not available' })
    await ensureCleaningDayEndHandoverTable()
    const uuid = require('uuid')
    const userId = String(user.sub || '').trim()
    const date = String(parsed.data.date || '').slice(0, 10)
    const section = String(parsed.data.section || 'all').trim() as 'all' | 'key' | 'dirty_linen' | 'return_wash' | 'warehouse_key' | 'consumable' | 'reject'
    const isAllSection = section === 'all'
    const isFinalSubmit = isAllSection
    const writesKey = isAllSection || section === 'key'
    const writesReturnWash = isAllSection || section === 'dirty_linen' || section === 'return_wash'
    const writesWarehouseKey = isAllSection || section === 'warehouse_key'
    const writesConsumable = isAllSection || section === 'consumable'
    const writesReject = isAllSection || section === 'reject'
    const keyPhotos = Array.isArray(parsed.data.key_photos) ? parsed.data.key_photos : []
    const returnWashPhotos = Array.isArray(parsed.data.return_wash_photos) && parsed.data.return_wash_photos.length
      ? parsed.data.return_wash_photos
      : (Array.isArray(parsed.data.dirty_linen_photos) ? parsed.data.dirty_linen_photos : [])
    const warehouseKeyPhotos = Array.isArray(parsed.data.warehouse_key_photos) ? parsed.data.warehouse_key_photos : []
    const consumablePhotos = Array.isArray(parsed.data.consumable_photos) ? parsed.data.consumable_photos : []
    const rejectItems = Array.isArray(parsed.data.reject_items) ? parsed.data.reject_items : []
    const noDirtyLinen = !!parsed.data.no_dirty_linen
    const noWarehouseKey = !!parsed.data.no_warehouse_key
    const inspectorOnlyDayEnd = isInspectorOnlyDayEndUser(user)
    if (inspectorOnlyDayEnd) {
      if ((isAllSection || writesConsumable) && !consumablePhotos.length) return res.status(400).json({ message: '请上传剩余消耗品照片' })
    } else {
      if (writesKey && !keyPhotos.length) return res.status(400).json({ message: '请先上传备用钥匙照片' })
      if (writesReturnWash && !returnWashPhotos.length && !noDirtyLinen) return res.status(400).json({ message: '请上传脏床品照片' })
      if (section === 'warehouse_key' && !warehouseKeyPhotos.length && !noWarehouseKey) return res.status(400).json({ message: '请上传仓库钥匙照片，或选择今天未使用仓库钥匙' })
    }

    const client = await pgPool.connect()
    try {
      await client.query('BEGIN')
      const insertMediaItems = async (kind: string, items: any[]) => {
        for (const it of items) {
          const cap = String(it.captured_at || '').trim()
          const capturedAt = cap ? new Date(cap) : null
          await client.query(
            `INSERT INTO cleaning_day_end_media (id, user_id, date, kind, url, captured_at)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [uuid.v4(), userId, date, kind, String(it.url), capturedAt ? capturedAt.toISOString() : null],
          )
        }
      }

      if (writesKey) {
        await client.query(`DELETE FROM cleaning_day_end_media WHERE user_id = $1::text AND date = $2::date AND kind = 'backup_key_return'`, [userId, date])
        await insertMediaItems('backup_key_return', keyPhotos)
      }
      if (writesReturnWash) {
        await client.query(`DELETE FROM cleaning_day_end_media WHERE user_id = $1::text AND date = $2::date AND kind IN ('dirty_linen_return', 'return_wash_linen')`, [userId, date])
        await insertMediaItems('return_wash_linen', returnWashPhotos)
      }
      if (writesWarehouseKey) {
        await client.query(`DELETE FROM cleaning_day_end_media WHERE user_id = $1::text AND date = $2::date AND kind = 'warehouse_key_return'`, [userId, date])
        await insertMediaItems('warehouse_key_return', warehouseKeyPhotos)
      }
      if (writesConsumable) {
        await client.query(`DELETE FROM cleaning_day_end_media WHERE user_id = $1::text AND date = $2::date AND kind = 'remaining_consumables'`, [userId, date])
        await insertMediaItems('remaining_consumables', consumablePhotos)
      }
      if (writesReject) {
        await client.query(
          `DELETE FROM cleaning_day_end_reject_items
           WHERE user_id = $1::text
             AND date = $2::date`,
          [userId, date],
        )
        for (const it of rejectItems) {
          const photos = (Array.isArray(it.photos) ? it.photos : []).map((p: any) => ({
            url: String(p?.url || ''),
            captured_at: String(p?.captured_at || '').trim() || null,
          })).filter((p: any) => !!p.url)
          await client.query(
            `INSERT INTO cleaning_day_end_reject_items (id, user_id, date, linen_type, quantity, used_room, photos_json, created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,now(),now())`,
            [uuid.v4(), userId, date, String(it.linen_type || ''), Number(it.quantity || 0) || 1, String(it.used_room || ''), JSON.stringify(photos)],
          )
        }
      }
      await client.query(
        `INSERT INTO cleaning_day_end_handover (user_id, date, no_dirty_linen, no_warehouse_key, submitted_at, updated_at)
         VALUES ($1,$2,$3,$4,${isFinalSubmit ? 'now()' : 'NULL'},now())
         ON CONFLICT (user_id, date)
         DO UPDATE SET submitted_at = ${isFinalSubmit ? 'now()' : 'NULL'}, updated_at = now()`,
        [userId, date, noDirtyLinen, noWarehouseKey],
      )
      const statusSets: string[] = [isFinalSubmit ? 'submitted_at = now()' : 'submitted_at = NULL', 'updated_at = now()']
      const statusParams: any[] = [userId, date]
      if (writesKey) statusSets.push('key_submitted_at = now()')
      if (writesReturnWash) {
        statusParams.push(noDirtyLinen)
        statusSets.push(`no_dirty_linen = $${statusParams.length}`)
        statusSets.push('dirty_linen_submitted_at = now()')
      }
      if (writesWarehouseKey) {
        statusParams.push(noWarehouseKey)
        statusSets.push(`no_warehouse_key = $${statusParams.length}`)
        statusSets.push('warehouse_key_submitted_at = now()')
      }
      if (writesConsumable) statusSets.push('consumable_submitted_at = now()')
      if (writesReject) statusSets.push('reject_submitted_at = now()')
      await client.query(
        `UPDATE cleaning_day_end_handover
            SET ${statusSets.join(', ')}
          WHERE user_id = $1::text
            AND date = $2::date`,
        statusParams,
      )
      await client.query('COMMIT')
    } catch (e) {
      try { await client.query('ROLLBACK') } catch {}
      throw e
    } finally {
      client.release()
    }
    try {
      const { syncDayEndRejectLinenUsage } = require('./inventory')
      if (isFinalSubmit && writesReject) {
        await syncDayEndRejectLinenUsage({
          userId,
          date,
          actorId: String(user.sub || '').trim() || null,
          rejectItems: rejectItems.map((item: any) => ({
            linen_type: String(item?.linen_type || '').trim(),
            quantity: Number(item?.quantity || 0) || 0,
            used_room: String(item?.used_room || '').trim(),
          })),
        })
      }
    } catch {}
    try {
      if (!isFinalSubmit) return res.status(201).json({ ok: true })
      const managerIds = await listDayEndManagerUserIds()
      if (managerIds.length) {
        const actorId = String(user.sub || '').trim()
        const actorName = await resolveUserDisplayName(actorId)
        await emitNotificationEvent({
          type: 'WORK_TASK_UPDATED',
          entity: 'work_task',
          entityId: `day_end_handover_submitted:${date}:${actorId}`,
          updatedAt: new Date().toISOString(),
          title: '日终交接已提交',
          body: `${actorName} 已更新 ${date} 的日终交接，可进入查看内容。`,
          recipientUserIds: managerIds,
          priority: 'medium',
          data: {
            kind: 'day_end_handover_submitted',
            action: 'open_day_end_handover',
            date,
            target_user_id: actorId,
            target_user_name: actorName,
            handover_status: 'submitted',
            section,
            event_id: `day_end_handover_submitted:${date}:${actorId}`,
          },
        })
      }
    } catch {}
    return res.status(201).json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'error' })
  }
})

export default router
router.post(
  '/upload',
  requireAnyPerm(['cleaning_app.media.upload', 'cleaning_app.tasks.finish', 'cleaning_app.inspect.finish', 'cleaning_app.issues.report']),
  upload.single('file'),
  async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'missing file' })
  try {
    const user = (req as any).user || {}
    const body: any = (req as any).body || {}
    const isImage = String(req.file.mimetype || '').startsWith('image/')
    const wantWatermark = String(body.watermark || '').trim() === '1' || String(body.purpose || '').trim() === 'key_photo'
    const watermarkText = String(body.watermark_text || '').trim()
    const propertyCode = String(body.property_code || '').trim()
    const capturedAt = String(body.captured_at || '').trim()
    const submitter = String(user.username || user.sub || '').trim()
    const fmt = (iso: string) => {
      const d = new Date(String(iso || ''))
      if (Number.isNaN(d.getTime())) return ''
      const pad2 = (n: number) => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
    }
    const fallbackLines =
      wantWatermark && isImage
        ? [
            `${propertyCode || '未知房号'}${submitter ? `  ${submitter}` : ''}`.trim(),
            fmt(capturedAt) || fmt(new Date().toISOString()),
          ].filter(Boolean)
        : []

    const lines0 = (watermarkText ? watermarkText.split(/\r?\n/) : fallbackLines).map((x) => String(x || '').trim()).filter(Boolean)
    const lines = lines0.length > 2 ? lines0.slice(0, 2) : lines0

    if (hasR2 && (req.file as any).buffer) {
      let buf: Buffer = (req.file as any).buffer
      if (isImage && wantWatermark && lines.length) {
        try {
          const img = sharp(buf)
          const meta = await img.metadata()
          const w = Math.max(1, Number(meta.width || 0))
          const h = Math.max(1, Number(meta.height || 0))
          if (w && h) {
            const esc = (s: string) =>
              String(s || '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;')
            const fontSize = Math.max(18, Math.round(Math.min(w, h) * 0.032))
            const pad = Math.round(fontSize * 0.65)
            const lineH = Math.round(fontSize * 1.25)
            const xRight = w - pad
            const strokeW = Math.max(2, Math.round(fontSize * 0.12))
            const yBottom = h - pad - strokeW
            const svg = `
              <svg width="${w}" height="${h}">
                <g font-family="Arial, Helvetica, sans-serif" font-size="${fontSize}" text-anchor="end">
                  ${lines
                    .map((t, idx) => {
                      const y = yBottom - (lines.length - 1 - idx) * lineH
                      return `<text x="${xRight}" y="${y}" fill="#ffffff" stroke="rgba(0,0,0,0.65)" stroke-width="${strokeW}" paint-order="stroke">${esc(t)}</text>`
                    })
                    .join('')}
                </g>
              </svg>
            `
            buf = await img
              .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
              .jpeg({ quality: 88 })
              .toBuffer()
          }
        } catch {}
      }
      const ext = (isImage && wantWatermark && lines.length) ? '.jpg' : (path.extname(req.file.originalname) || '')
      const key = `cleaning/${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`
      const mime = (isImage && wantWatermark && lines.length) ? 'image/jpeg' : (req.file.mimetype || 'application/octet-stream')
      const url = await r2Upload(key, mime, buf)
      return res.status(201).json({ url })
    }
    const filePath = (req.file as any).path ? String((req.file as any).path) : ''
    if (filePath && isImage && wantWatermark && lines.length) {
      try {
        const buf = await fs.promises.readFile(filePath)
        const img = sharp(buf)
        const meta = await img.metadata()
        const w = Math.max(1, Number(meta.width || 0))
        const h = Math.max(1, Number(meta.height || 0))
        if (w && h) {
          const esc = (s: string) =>
            String(s || '')
              .replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;')
              .replace(/'/g, '&#39;')
          const fontSize = Math.max(18, Math.round(Math.min(w, h) * 0.032))
          const pad = Math.round(fontSize * 0.65)
          const lineH = Math.round(fontSize * 1.25)
          const xRight = w - pad
          const strokeW = Math.max(2, Math.round(fontSize * 0.12))
          const yBottom = h - pad - strokeW
          const svg = `
            <svg width="${w}" height="${h}">
              <g font-family="Arial, Helvetica, sans-serif" font-size="${fontSize}" text-anchor="end">
                ${lines
                  .map((t, idx) => {
                    const y = yBottom - (lines.length - 1 - idx) * lineH
                    return `<text x="${xRight}" y="${y}" fill="#ffffff" stroke="rgba(0,0,0,0.65)" stroke-width="${strokeW}" paint-order="stroke">${esc(t)}</text>`
                  })
                  .join('')}
              </g>
            </svg>
          `
          const out = await img.composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).jpeg({ quality: 88 }).toBuffer()
          await fs.promises.writeFile(filePath, out)
        }
      } catch {}
    }
    const url = `/uploads/${req.file.filename}`
    return res.status(201).json({ url })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'upload_failed' })
  }
})
