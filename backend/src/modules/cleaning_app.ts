import { Router } from 'express'
import { z } from 'zod'
import { listPermissionCodesForUser, requirePerm, requireAnyPerm } from '../auth'
import { hasPg, pgRunInTransaction, pgUpdate, pgInsert } from '../dbAdapter'
import multer from 'multer'
import path from 'path'
import { hasR2, r2GetObjectByKey, r2KeyFromUrl, r2Upload } from '../r2'
import { broadcastCleaningEvent } from './events'
import { roleHasPermission } from '../store'
import sharp from 'sharp'
import fs from 'fs'
import { emitNotificationEvent } from '../services/notificationEvents'
import { buildCleaningTaskVisibilityHints, emitWorkTaskEvent } from '../services/workTaskEvents'
import { effectiveInspectionMode, isInspectionFinishedStatus } from '../lib/cleaningInspection'
import { CLEANING_IMAGE_FORMAT_ERROR, encodeCleaningImageToJpeg, isImageUploadCandidate, normalizeCleaningImageUpload } from '../lib/cleaningMediaImage'
import { isCleaningMediaKey } from '../lib/cleaningMediaReference'
import { currentOfflineTaskPhotoKeyFromReference, currentMzappTaskPhotoKeyFromReference, isLegacyMzappTaskPhotoPublicUrl, offlineTaskPhotoReferenceVariants, normalizeMzappTaskPhotoKey } from '../lib/mzappTaskPhotoReference'
import {
  buildIdempotencyPayloadHash,
  assertIdempotentStepReceiptsReady,
  IDEMPOTENCY_SUBMIT_ID_MAX_LENGTH,
  loadIdempotentStepReceipt,
  saveIdempotentStepReceipt,
} from '../lib/idempotentStepReceipts'
import {
  actorAndPerformerFromRequest,
  applyCleaningTaskActionTransition,
  buildKeyPhotoUploadEventPatch,
  buildKeyPhotoUploadTaskPatch,
  ensureWorkTaskActionAuditsTable,
  recordWorkTaskActionAudit,
} from '../lib/workTaskActionAudit'
import type { WorkTaskActionId } from '../lib/workTaskActions'
import { resolvePropertyPublicGuideLinks } from './property_guide_link_sync'
import { canViewMzappGuestLuggageNoticeMedia, canViewMzappOfflineWorkTaskMedia, canViewMzappPropertyFeedback, canViewMzappRecordedCleaningMedia } from './mzapp'

export const router = Router()

const REQUIRED_COMPLETION_PHOTO_AREAS = ['toilet', 'living', 'sofa', 'bedroom', 'kitchen', 'shower_drain', 'remote_tv', 'vacuum_used'] as const
const upload = hasR2 ? multer({ storage: multer.memoryStorage() }) : multer({ dest: path.join(process.cwd(), 'uploads') })

function stableUploadKeySegment(value: any, fallback: string) {
  const normalized = String(value || '').trim().replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128)
  return normalized || fallback
}

function cleaningUploadRequestId(req: any) {
  const incoming = String(req?.get?.('X-Cleaning-Upload-Request-Id') || req?.headers?.['x-cleaning-upload-request-id'] || '').trim()
  const normalized = incoming.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 128)
  return normalized || `srv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

let cleaningConsumablesSchemaReady = false
let cleaningConsumablesSchemaPromise: Promise<void> | null = null

async function ensureCleaningConsumablesSchema() {
  if (!hasPg) return
  const { pgPool } = require('../dbAdapter')
  if (!pgPool || cleaningConsumablesSchemaReady) return
  if (cleaningConsumablesSchemaPromise) return cleaningConsumablesSchemaPromise
  cleaningConsumablesSchemaPromise = (async () => {
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
    await assertIdempotentStepReceiptsReady(pgPool)
    await ensureWorkTaskActionAuditsTable(pgPool)
    cleaningConsumablesSchemaReady = true
  })()
    .catch((error) => {
      cleaningConsumablesSchemaPromise = null
      throw error
    })
    .finally(() => {
      if (cleaningConsumablesSchemaReady) cleaningConsumablesSchemaPromise = null
    })
  return cleaningConsumablesSchemaPromise
}

export async function warmupCleaningAppModule() {
  await ensureCleaningConsumablesSchema()
}

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

async function resolveCleaningTaskPropertyCode(taskId: string) {
  if (!hasPg) return ''
  try {
    const { pgPool } = require('../dbAdapter')
    if (!pgPool) return ''
    const r = await pgPool.query(
      `SELECT COALESCE(p_id.code::text, p_code.code::text, t.property_id::text) AS property_code
       FROM cleaning_tasks t
       LEFT JOIN properties p_id ON p_id.id::text = t.property_id::text
       LEFT JOIN properties p_code ON upper(p_code.code) = upper(t.property_id::text)
       WHERE t.id::text = $1::text
       LIMIT 1`,
      [String(taskId || '').trim()],
    )
    return String(r?.rows?.[0]?.property_code || '').trim()
  } catch {
    return ''
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
    if (/^https?:\/\//i.test(text) || isCleaningMediaKey(text)) return [text]
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
           WHEN lower(COALESCE(t.inspection_mode, '')) IN ('pending_decision', 'same_day', 'deferred', 'self_complete', 'checked_done')
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

async function listWarehouseKeyRelatedUserIds(params: { taskDate: string; actorId: string }) {
  const related = await listSouthbankWarehouseKeyUsers(params.taskDate)
  const actorId = String(params.actorId || '').trim()
  return Array.from(new Set(related.userIds.filter(Boolean))).filter((id) => id !== actorId)
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
      const relatedUserIds = await listWarehouseKeyRelatedUserIds({ taskDate, actorId })
      const actionText = warehouseKeyActionText(action)
      const body = action === 'handover'
        ? `${actorName} 已将 MSQ 仓库钥匙转交给 ${toName || '同事'}。`
        : `${actorName} ${actionText} MSQ 仓库钥匙。`
      await emitNotificationEvent({
        type: 'WAREHOUSE_KEY_UPDATED',
        policyKey: 'warehouse_key_updated',
        entity: 'warehouse_key',
        entityId: keyCode,
        eventId: `warehouse_key:${keyCode}:${String(eventRow?.id || Date.now())}`,
        updatedAt: eventRow?.created_at ? String(eventRow.created_at) : new Date().toISOString(),
        title: 'MSQ 仓库钥匙更新',
        body,
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
          warehouse_related_user_ids: relatedUserIds,
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
const actionAuditBodySchema = {
  performed_by_user_id: z.string().trim().min(1).max(120).optional(),
  performed_by_name: z.string().trim().min(1).max(160).optional(),
}
const WORK_TASK_PARTICIPANT_ACTION_IDS = new Set<WorkTaskActionId | '*'>([
  '*',
  'upload_key_photo',
  'fill_supplies',
  'submit_inspection',
  'upload_access_video',
  'complete_cleaning',
  'report_issue',
  'mark_guest_checkout',
])

function normalizeParticipantActionIds(value: any) {
  const raw = Array.isArray(value)
    ? value
    : (typeof value === 'string' && value.trim().startsWith('['))
      ? (() => {
          try { return JSON.parse(value) } catch { return [] }
        })()
      : []
  return Array.from(new Set((Array.isArray(raw) ? raw : []).map((item) => String(item || '').trim()).filter(Boolean)))
    .filter((item) => WORK_TASK_PARTICIPANT_ACTION_IDS.has(item as any))
}

async function ensureWorkTaskParticipantsTable() {
  if (!hasPg) return
  const { pgPool } = require('../dbAdapter')
  if (!pgPool) return
  await pgPool.query(`CREATE TABLE IF NOT EXISTS work_task_participants (
    id text PRIMARY KEY,
    source_type text NOT NULL,
    source_id text NOT NULL,
    user_id text NOT NULL,
    participant_role text NOT NULL DEFAULT 'collaborator',
    action_ids jsonb NOT NULL DEFAULT '["*"]'::jsonb,
    source_relation text NOT NULL DEFAULT 'manual',
    created_by text,
    updated_by text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );`)
  await pgPool.query(`ALTER TABLE IF EXISTS work_task_participants ADD COLUMN IF NOT EXISTS participant_role text NOT NULL DEFAULT 'collaborator';`)
  await pgPool.query(`ALTER TABLE IF EXISTS work_task_participants ADD COLUMN IF NOT EXISTS action_ids jsonb NOT NULL DEFAULT '["*"]'::jsonb;`)
  await pgPool.query(`ALTER TABLE IF EXISTS work_task_participants ADD COLUMN IF NOT EXISTS source_relation text NOT NULL DEFAULT 'manual';`)
  await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_work_task_participants_source ON work_task_participants(source_type, source_id);`)
  await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_work_task_participants_user ON work_task_participants(user_id);`)
  await pgPool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_work_task_participants_manual ON work_task_participants(source_type, source_id, user_id, source_relation);`)
}

function canBasePerformWorkTaskAction(actionId: WorkTaskActionId, permissions: string[]) {
  const set = new Set((permissions || []).map((item) => String(item || '').trim()).filter(Boolean))
  const canStart = set.has('cleaning_app.tasks.start')
  const canFinish = set.has('cleaning_app.tasks.finish')
  const canInspect = set.has('cleaning_app.inspect.finish') || canFinish
  const canMedia = set.has('cleaning_app.media.upload') || canStart || canFinish || canInspect
  if (actionId === 'upload_access_video') return canFinish && canMedia
  if (actionId === 'submit_inspection') return canInspect && canMedia
  if (actionId === 'upload_key_photo') return canStart && canMedia
  if (actionId === 'fill_supplies' || actionId === 'complete_cleaning') return canFinish
  if (actionId === 'report_issue') return set.has('cleaning_app.issues.report')
  if (actionId === 'mark_guest_checkout') return true
  return false
}

function legacyCleaningTaskActionAllowed(row: any, userId: string, actionId: WorkTaskActionId) {
  const uid = String(userId || '').trim()
  if (!uid) return false
  const cleanerId = String(row?.cleaner_id || row?.assignee_id || '').trim()
  const inspectorId = String(row?.inspector_id || row?.assignee_id || '').trim()
  const assigneeId = String(row?.assignee_id || '').trim()
  const inspectionMode = effectiveInspectionMode(row)
  const isCleaningParticipant = cleanerId === uid || assigneeId === uid
  const isInspectionParticipant = inspectorId === uid || assigneeId === uid
  if (actionId === 'upload_key_photo') return isCleaningParticipant
  if (actionId === 'fill_supplies' || actionId === 'complete_cleaning') return isCleaningParticipant
  if (actionId === 'submit_inspection') return isInspectionParticipant
  if (actionId === 'upload_access_video') return isInspectionParticipant || (inspectionMode === 'self_complete' && isCleaningParticipant)
  if (actionId === 'report_issue') return isCleaningParticipant || isInspectionParticipant
  return false
}

async function canPerformCleaningTaskAction(user: any, taskId: string, actionIds: WorkTaskActionId[]) {
  if (!hasPg) return true
  const { pgPool } = require('../dbAdapter')
  if (!pgPool) return false
  const userId = String(user?.sub || '').trim()
  const id = String(taskId || '').trim()
  if (!userId || !id || !actionIds.length) return false
  const permissions = await listPermissionCodesForUser(user)
  const allowedBaseActions = actionIds.filter((actionId) => canBasePerformWorkTaskAction(actionId, permissions))
  if (!allowedBaseActions.length) return false
  const taskRes = await pgPool.query(
    `SELECT id::text AS id,
            status,
            cleaner_id::text AS cleaner_id,
            inspector_id::text AS inspector_id,
            assignee_id::text AS assignee_id,
            task_type,
            inspection_mode,
            inspection_scope,
            inspection_due_date::text AS inspection_due_date
       FROM cleaning_tasks
      WHERE id::text = $1::text
      LIMIT 1`,
    [id],
  )
  const row = taskRes?.rows?.[0] || null
  if (!row) return false
  if (allowedBaseActions.some((actionId) => legacyCleaningTaskActionAllowed(row, userId, actionId))) return true
  await ensureWorkTaskParticipantsTable()
  const grants = await pgPool.query(
    `SELECT action_ids
       FROM work_task_participants
      WHERE source_type = 'cleaning_tasks'
        AND source_id = $1
        AND user_id = $2
        AND source_relation = 'manual'`,
    [id, userId],
  )
  return (grants?.rows || []).some((grant: any) => {
    const ids = normalizeParticipantActionIds(grant?.action_ids)
    return allowedBaseActions.some((actionId) => ids.includes('*') || ids.includes(actionId))
  })
}

const startSchema = z.object({ media_url: z.string().min(1), captured_at: z.string().optional(), lat: z.number().optional(), lng: z.number().optional(), ...actionAuditBodySchema })
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
      if (!await canPerformCleaningTaskAction(user, String(id), ['upload_key_photo'])) return res.status(403).json({ message: 'forbidden' })
      const actionActor = actorAndPerformerFromRequest(user, parsed.data)
      const alreadyHasKeyPhoto = !!String(before.current_key_photo_url || '').trim() || !!before.key_photo_uploaded_at
      if (alreadyHasKeyPhoto) {
        const actionResult = await applyCleaningTaskActionTransition({
          taskId: String(id),
          actionId: 'upload_key_photo',
          actorUserId: actionActor.actorUserId,
          performedByUserId: actionActor.performedByUserId,
          performedByName: actionActor.performedByName,
          metadata: { route: 'cleaning_app.tasks.start', already_recorded: true },
        }, pgPool)
        // Re-upload replaces only the key media row.  The previous branch
        // returned early without saving the new key, while the task event
        // could still advertise it to mobile clients.  Keep all other
        // cleaning/consumable media untouched.
        await pgRunInTransaction(async (client) => {
          await client.query(`DELETE FROM cleaning_task_media WHERE task_id::text = $1::text AND type = 'key_photo'`, [String(id)])
          await client.query(
            `INSERT INTO cleaning_task_media (id, task_id, type, url, captured_at, lat, lng)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [require('uuid').v4(), id, 'key_photo', parsed.data.media_url, parsed.data.captured_at || now, parsed.data.lat ?? null, parsed.data.lng ?? null],
          )
        })
        const patchExisting = buildKeyPhotoUploadTaskPatch({
          statusBefore: before.status,
          statusAfter: actionResult?.status_after,
          startedAt: before.started_at,
          keyPhotoUploadedAt: before.key_photo_uploaded_at,
          now,
          lat: parsed.data.lat,
          lng: parsed.data.lng,
        })
        const upExisting = Object.keys(patchExisting).length ? await pgUpdate('cleaning_tasks', id, patchExisting) : before
        const eventPatch = buildKeyPhotoUploadEventPatch({
          statusBefore: before.status,
          statusAfter: actionResult?.status_after,
          keyPhotoUrl: parsed.data.media_url,
        })
        if (Object.keys(eventPatch).length) {
          await emitWorkTaskEvent({
            taskId: `cleaning_task:${String(id)}`,
            sourceType: 'cleaning_tasks',
            sourceRefIds: [String(id)],
            eventType: 'TASK_UPDATED',
            changeScope: 'list',
            changedFields: Object.keys(eventPatch),
            patch: eventPatch,
            causedByUserId: String(user?.sub || '').trim() || null,
            visibilityHints: buildCleaningTaskVisibilityHints(upExisting || patchExisting),
          })
          try { broadcastCleaningEvent({ event: 'started', task_id: id }) } catch {}
        }
        return res.json(upExisting || before)
      }
      const actionResult = await applyCleaningTaskActionTransition({
        taskId: String(id),
        actionId: 'upload_key_photo',
        actorUserId: actionActor.actorUserId,
        performedByUserId: actionActor.performedByUserId,
        performedByName: actionActor.performedByName,
        metadata: { route: 'cleaning_app.tasks.start' },
      }, pgPool)
      const patch = buildKeyPhotoUploadTaskPatch({
        statusBefore: before.status,
        statusAfter: actionResult?.status_after,
        startedAt: before.started_at,
        keyPhotoUploadedAt: before.key_photo_uploaded_at,
        now,
        lat: parsed.data.lat,
        lng: parsed.data.lng,
      })
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
      const eventPatch = buildKeyPhotoUploadEventPatch({
        statusBefore: before.status,
        statusAfter: actionResult?.status_after,
        keyPhotoUrl: parsed.data.media_url,
      })
      await emitWorkTaskEvent({
        taskId: `cleaning_task:${String(id)}`,
        sourceType: 'cleaning_tasks',
        sourceRefIds: [String(id)],
        eventType: 'TASK_UPDATED',
        changeScope: 'list',
        changedFields: Object.keys(eventPatch),
        patch: eventPatch,
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
              policyKey: 'key_photo_uploaded',
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
    if (!await canPerformCleaningTaskAction(user, String(id), ['upload_key_photo'])) return res.status(403).json({ message: 'forbidden' })

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
            policyKey: 'key_photo_deleted',
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
        try {
          const { pgPool } = require('../dbAdapter')
          if (pgPool) {
            const r = await pgPool.query(`SELECT property_id::text AS property_id FROM cleaning_tasks WHERE id::text=$1::text LIMIT 1`, [String(id)])
            propertyId = String(r?.rows?.[0]?.property_id || '').trim()
          }
        } catch {}
        if (propertyId) {
          await emitNotificationEvent(
            {
              type: 'ISSUE_REPORTED',
              policyKey: 'issue_reported',
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
  living_room_photo_url: z.string().trim().min(1).optional(),
  living_room_photo_urls: z.array(z.string().trim().min(1).max(800)).max(12).optional(),
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
  submit_id: z.string().trim().min(1).max(IDEMPOTENCY_SUBMIT_ID_MAX_LENGTH).optional(),
  ...actionAuditBodySchema,
})
router.get('/tasks/:id/consumables', requirePerm('cleaning_app.tasks.finish'), async (req, res) => {
  const { id } = req.params
  try {
    if (!hasPg) return res.json({ items: [] })
    const { pgPool } = require('../dbAdapter')
    if (!pgPool) return res.json({ items: [] })
    const rows = await pgPool.query(
      `SELECT id, item_id, qty, need_restock, note, status, photo_url, photo_urls, item_label, created_at
       FROM cleaning_consumable_usages
       WHERE task_id = $1
       ORDER BY created_at ASC, id ASC`,
      [String(id)],
    )
    const livingPhotoRows = await pgPool.query(
      `SELECT url
       FROM cleaning_task_media
       WHERE task_id::text = $1::text
         AND type = 'consumable_living_room_photo'
       ORDER BY captured_at ASC NULLS LAST, created_at ASC, id ASC`,
      [String(id)],
    )
    const livingRoomPhotoUrls = Array.from(new Set((livingPhotoRows?.rows || [])
      .map((row: any) => String(row?.url || '').trim())
      .filter(Boolean)))
    return res.json({
      living_room_photo_urls: livingRoomPhotoUrls,
      living_room_photo_url: livingRoomPhotoUrls[0] || null,
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
      if (!taskRow?.rows?.[0]) return res.status(404).json({ message: 'task not found' })
      if (!await canPerformCleaningTaskAction(user, String(id), ['fill_supplies'])) return res.status(403).json({ message: 'forbidden' })
      const submitId = String(parsed.data.submit_id || '').trim()
      const stepKey = 'consumables_submit'
      const payloadHash = buildIdempotencyPayloadHash(parsed.data)

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

      const transactionResult = await pgRunInTransaction(async (client) => {
        const lockedTaskRow = await client.query(
          `SELECT id, status, property_id::text AS property_id, finished_at
             FROM cleaning_tasks
            WHERE id=$1
            FOR UPDATE`,
          [String(id)],
        )
        const task = lockedTaskRow?.rows?.[0]
        if (!task) return { kind: 'missing' as const }

        if (submitId) {
          const receipt = await loadIdempotentStepReceipt(client, {
            scopeType: 'cleaning_task_consumables',
            scopeId: String(id),
            submitId,
            stepKey,
          })
          if (receipt) {
            if (String(receipt.payload_hash || '') !== payloadHash) {
              return { kind: 'conflict' as const }
            }
            return { kind: 'replay' as const, responsePayload: receipt.response_json || { ok: true } }
          }
        }

        const existingRows = await client.query(`SELECT id FROM cleaning_consumable_usages WHERE task_id=$1 LIMIT 1`, [String(id)])
        const hadExisting = !!existingRows?.rowCount
        const livingRoomPhotoUrls = normalizeStoredPhotoUrls(parsed.data.living_room_photo_urls, parsed.data.living_room_photo_url)

        await client.query(`DELETE FROM cleaning_consumable_usages WHERE task_id=$1`, [String(id)])
        await client.query(`DELETE FROM cleaning_task_media WHERE task_id::text=$1::text AND type='consumable_living_room_photo'`, [String(id)])

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
          await pgInsert('cleaning_consumable_usages', row as any, client)
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
        for (const livingRoomPhotoUrl of livingRoomPhotoUrls) {
          await pgInsert('cleaning_task_media', {
            id: require('uuid').v4(),
            task_id: String(id),
            type: 'consumable_living_room_photo',
            url: livingRoomPhotoUrl,
            captured_at: new Date().toISOString(),
          } as any, client)
        }
        const needsRestock = parsed.data.items.some((i) => i.status === 'low')
        const now = new Date().toISOString()
        const actionActor = actorAndPerformerFromRequest(user, parsed.data)
        const actionResult = await applyCleaningTaskActionTransition({
          taskId: String(id),
          actionId: 'fill_supplies',
          actorUserId: actionActor.actorUserId,
          performedByUserId: actionActor.performedByUserId,
          performedByName: actionActor.performedByName,
          needsRestock,
          metadata: {
            route: 'cleaning_app.tasks.consumables',
            item_count: parsed.data.items.length,
            needs_restock: needsRestock,
          },
        }, client)
        const taskStatus = String(task.status || '').trim().toLowerCase()
        const isFinishedTask = ['cleaned', 'restock_pending', 'restocked', 'to_inspect', 'to_hang_keys', 'keys_hung', 'done', 'completed', 'ready'].includes(taskStatus)
        const patch: any = {}
        if (!isFinishedTask && !String(actionResult?.status_after || '').trim()) patch.status = needsRestock ? 'restock_pending' : 'cleaned'
        if (!task.finished_at) patch.finished_at = now
        const up = await pgUpdate('cleaning_tasks', id, patch, client)
        const responsePayload = { ...(up || patch), action_result: actionResult }
        if (submitId) {
          await saveIdempotentStepReceipt(client, {
            scopeType: 'cleaning_task_consumables',
            scopeId: String(id),
            submitId,
            stepKey,
          }, payloadHash, responsePayload)
        }
        return {
          kind: 'committed' as const,
          responsePayload,
          needsRestock,
          restockItemsPayload,
          patch,
          up,
          task,
          hadExisting,
          now,
        }
      })
      if (!transactionResult || transactionResult.kind === 'missing') return res.status(404).json({ message: 'task not found' })
      if (transactionResult.kind === 'conflict') {
        return res.status(409).json({ message: 'idempotency_conflict', submit_id: submitId, step_key: stepKey })
      }
      if (transactionResult.kind === 'replay') return res.status(200).json(transactionResult.responsePayload)
      const { responsePayload, needsRestock, restockItemsPayload, patch, up, task, hadExisting, now } = transactionResult
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
          if (propertyId) {
            await emitNotificationEvent(
              {
                type: needsRestock ? 'WORK_TASK_UPDATED' : (hadExisting ? 'CLEANING_TASK_UPDATED' : 'CLEANING_COMPLETED'),
                policyKey: needsRestock ? 'consumables_need_restock' : 'consumables_submitted',
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
              policyKey: 'restock_done',
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
      if (!await canPerformCleaningTaskAction(user, String(id), ['upload_access_video'])) return res.status(403).json({ message: 'forbidden' })
      const now = new Date().toISOString()
      const media = { id: require('uuid').v4(), task_id: id, type: 'lockbox_video', url: parsed.data.media_url, captured_at: parsed.data.captured_at || now, lat: parsed.data.lat, lng: parsed.data.lng }
      await pgInsert('cleaning_task_media', media as any)
      const actionActor = actorAndPerformerFromRequest(user, parsed.data)
      const actionResult = await applyCleaningTaskActionTransition({
        taskId: String(id),
        actionId: 'upload_access_video',
        actorUserId: actionActor.actorUserId,
        performedByUserId: actionActor.performedByUserId,
        performedByName: actionActor.performedByName,
        metadata: { route: 'cleaning_app.tasks.inspection_complete' },
      }, require('../dbAdapter').pgPool)
      const up = await pgUpdate('cleaning_tasks', id, { lockbox_video_uploaded_at: now } as any)
      await emitWorkTaskEvent({
        taskId: `cleaning_task:${String(id)}`,
        sourceType: 'cleaning_tasks',
        sourceRefIds: [String(id)],
        eventType: 'TASK_UPDATED',
        changeScope: 'list',
        changedFields: ['status', 'lockbox_video_uploaded_at', 'lockbox_video_url'],
        patch: { status: actionResult?.status_after || (up as any)?.status || null, lockbox_video_uploaded_at: now },
        causedByUserId: String(user?.sub || '').trim() || null,
        visibilityHints: buildCleaningTaskVisibilityHints(up || { id, status: actionResult?.status_after || null, lockbox_video_uploaded_at: now }),
      })
      try { broadcastCleaningEvent({ event: 'lockbox_video_uploaded', task_id: id }) } catch {}
      try {
        const operationId = require('uuid').v4()
        const propertyId = String((up as any)?.property_id || '').trim()
        const photoUrls = await listInspectionPhotoUrls(String(id))
        const propertyCode = await resolveCleaningTaskPropertyCode(String(id))
        if (propertyId) {
          await emitNotificationEvent(
            {
              type: 'WORK_TASK_UPDATED',
              policyKey: 'keys_hung',
              entity: 'cleaning_task',
              entityId: String(id),
              eventId: `keys_hung:${String(id)}`,
              propertyId,
              updatedAt: now,
              title: propertyCode ? `${propertyCode} · 房间已挂钥匙` : '房间已挂钥匙',
              body: '检查员已上传挂钥匙视频，房间钥匙已挂好',
              data: {
                entity: 'cleaning_task',
                entityId: String(id),
                action: 'open_task',
                kind: 'keys_hung',
                task_id: id,
                property_code: propertyCode || undefined,
                photo_url: photoUrls[0] || null,
                photo_urls: photoUrls,
              },
              actorUserId: String(user?.sub || ''),
            },
            { operationId },
          )
        }
      } catch {}
      return res.json({ ...(up || { id, lockbox_video_uploaded_at: now }), action_result: actionResult })
    }
    return res.json({ id, status: 'keys_hung', finalization_pending: true, missing_requirements: ['inspection_photos'] })
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
        area: z.enum(['toilet', 'living', 'sofa', 'bedroom', 'kitchen', 'bathroom', 'balcony', 'shower_drain', 'unclean']),
        url: z.string().trim().min(1),
        note: z.string().trim().max(800).optional().nullable(),
        captured_at: z.string().trim().max(64).optional(),
      }),
    ),
    guest_arrival_confirmed: z.boolean().optional(),
    submit_id: z.string().trim().min(1).max(IDEMPOTENCY_SUBMIT_ID_MAX_LENGTH).optional(),
    step_key: z.string().trim().min(1).max(120).optional(),
    ...actionAuditBodySchema,
  })
  .strict()

const inspectionIssuePhotosSchema = z
  .object({
    items: z.array(
      z.object({
        url: z.string().trim().min(1),
        note: z.string().trim().max(800).optional().nullable(),
        captured_at: z.string().trim().max(64).optional(),
      }),
    ).min(1).max(12),
    submit_id: z.string().trim().min(1).max(IDEMPOTENCY_SUBMIT_ID_MAX_LENGTH),
    step_key: z.string().trim().min(1).max(120),
  })
  .strict()

router.get('/tasks/:id/inspection-photos', requireAnyPerm(['cleaning_app.inspect.finish', 'cleaning_app.tasks.finish']), async (req, res) => {
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

router.post('/tasks/:id/inspection-photos', requireAnyPerm(['cleaning_app.inspect.finish', 'cleaning_app.tasks.finish']), async (req, res) => {
  const user = (req as any).user
  const { id } = req.params
  const parsed = inspectionPhotosSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const guestArrivalConfirmed = parsed.data.guest_arrival_confirmed === true
  if (!parsed.data.items.length && !guestArrivalConfirmed) return res.status(400).json({ message: 'inspection_photos_required' })
  try {
    const submitId = String(parsed.data.submit_id || '').trim()
    const stepKey = String(parsed.data.step_key || '').trim()
    const payloadHash = buildIdempotencyPayloadHash(parsed.data)
    const limits: Record<string, number> = { toilet: 9, living: 3, sofa: 2, bedroom: 8, kitchen: 2, bathroom: 3, balcony: 3, shower_drain: 1, unclean: 12 }
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
      if (!await canPerformCleaningTaskAction(user, String(id), ['submit_inspection'])) return res.status(403).json({ message: 'forbidden' })
      if (submitId && stepKey) await assertIdempotentStepReceiptsReady(pgPool)
      const transactionResult = await pgRunInTransaction(async (client) => {
        const lockedTask = await client.query(
          `SELECT id::text AS id
             FROM cleaning_tasks
            WHERE id::text = $1::text
            FOR UPDATE`,
          [String(id)],
        )
        if (!lockedTask?.rows?.[0]) return { kind: 'missing' as const }

        if (submitId && stepKey) {
          const receipt = await loadIdempotentStepReceipt(client, {
            scopeType: 'cleaning_task_inspection_photos',
            scopeId: String(id),
            submitId,
            stepKey,
          })
          if (receipt) {
            if (String(receipt.payload_hash || '') !== payloadHash) {
              return { kind: 'conflict' as const }
            }
            return { kind: 'replay' as const, responseBody: receipt.response_json || { ok: true } }
          }
        }

        const uuid = require('uuid')
        if (parsed.data.items.length) {
          await client.query(`DELETE FROM cleaning_task_media WHERE task_id=$1 AND type LIKE 'inspection_%'`, [id])
          for (const it of parsed.data.items) {
            const type = `inspection_${it.area}`
            const cap = String(it.captured_at || '').trim()
            const capturedAt = cap ? new Date(cap) : new Date()
            await client.query(
              `INSERT INTO cleaning_task_media (id, task_id, type, url, note, captured_at)
               VALUES ($1,$2,$3,$4,$5,$6)`,
              [uuid.v4(), id, type, String(it.url), it.note == null ? null : String(it.note || ''), capturedAt.toISOString()],
            )
          }
        }
        const actionActor = actorAndPerformerFromRequest(user, parsed.data)
        const actionResult = await applyCleaningTaskActionTransition({
          taskId: String(id),
          actionId: 'submit_inspection',
          actorUserId: actionActor.actorUserId,
          performedByUserId: actionActor.performedByUserId,
          performedByName: actionActor.performedByName,
          metadata: {
            route: 'cleaning_app.tasks.inspection_photos',
            item_count: parsed.data.items.length,
            ...(guestArrivalConfirmed ? { guest_arrival_skip: true } : {}),
          },
        }, client)
        const responseBody = { ok: true, action_result: actionResult }
        if (submitId && stepKey) {
          await saveIdempotentStepReceipt(client, {
            scopeType: 'cleaning_task_inspection_photos',
            scopeId: String(id),
            submitId,
            stepKey,
          }, payloadHash, responseBody)
        }
        return { kind: 'committed' as const, responseBody }
      })
      if (!transactionResult || transactionResult.kind === 'missing') return res.status(404).json({ message: 'task not found' })
      if (transactionResult.kind === 'conflict') {
        return res.status(409).json({ message: 'idempotency_conflict', submit_id: submitId, step_key: stepKey })
      }
      if (transactionResult.kind === 'replay') return res.status(200).json(transactionResult.responseBody)
      try { broadcastCleaningEvent({ event: 'inspection_photos_saved', task_id: id }) } catch {}
      return res.status(201).json(transactionResult.responseBody)
    }
    return res.status(201).json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'error' })
  }
})

// After the formal inspection is saved, inspectors can still append cleaning
// issue evidence from their album. This route never replaces the submitted
// inspection batch and deliberately does not advance the task state again.
router.post('/tasks/:id/inspection-issue-photos', requireAnyPerm(['cleaning_app.inspect.finish', 'cleaning_app.issues.report']), async (req, res) => {
  const user = (req as any).user
  const { id } = req.params
  const parsed = inspectionIssuePhotosSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (!hasPg) return res.status(201).json({ ok: true })
    await ensureCleaningTaskMediaNote()
    const { pgPool } = require('../dbAdapter')
    if (!pgPool) return res.status(500).json({ message: 'pg not available' })
    if (!await canPerformCleaningTaskAction(user, String(id), ['submit_inspection', 'report_issue'])) return res.status(403).json({ message: 'forbidden' })
    await assertIdempotentStepReceiptsReady(pgPool)

    const submitId = String(parsed.data.submit_id || '').trim()
    const stepKey = String(parsed.data.step_key || '').trim()
    const payloadHash = buildIdempotencyPayloadHash(parsed.data)
    const transactionResult = await pgRunInTransaction(async (client) => {
      const lockedTask = await client.query(
        `SELECT id::text AS id, COALESCE(status, '') AS status
           FROM cleaning_tasks
          WHERE id::text = $1::text
          FOR UPDATE`,
        [String(id)],
      )
      const taskRow = lockedTask?.rows?.[0] || null
      if (!taskRow) return { kind: 'missing' as const }
      if (!isInspectionFinishedStatus(String(taskRow.status || ''))) return { kind: 'inspection_not_submitted' as const }

      const receipt = await loadIdempotentStepReceipt(client, {
        scopeType: 'cleaning_task_inspection_issue_photos',
        scopeId: String(id),
        submitId,
        stepKey,
      })
      if (receipt) {
        if (String(receipt.payload_hash || '') !== payloadHash) return { kind: 'conflict' as const }
        return { kind: 'replay' as const, responseBody: receipt.response_json || { ok: true } }
      }

      const existing = await client.query(
        `SELECT count(*)::int AS count
           FROM cleaning_task_media
          WHERE task_id::text = $1::text
            AND type = 'inspection_unclean'`,
        [String(id)],
      )
      const existingCount = Number(existing?.rows?.[0]?.count || 0)
      if (existingCount + parsed.data.items.length > 12) return { kind: 'limit' as const, limit: 12 - existingCount }

      const uuid = require('uuid')
      for (const item of parsed.data.items) {
        const capturedAt = String(item.captured_at || '').trim() ? new Date(String(item.captured_at)).toISOString() : new Date().toISOString()
        await client.query(
          `INSERT INTO cleaning_task_media (id, task_id, type, url, note, captured_at)
           VALUES ($1,$2,'inspection_unclean',$3,$4,$5)`,
          [uuid.v4(), String(id), String(item.url), item.note == null ? null : String(item.note || ''), capturedAt],
        )
      }
      const responseBody = { ok: true, appended: parsed.data.items.length }
      await saveIdempotentStepReceipt(client, {
        scopeType: 'cleaning_task_inspection_issue_photos',
        scopeId: String(id),
        submitId,
        stepKey,
      }, payloadHash, responseBody)
      return { kind: 'committed' as const, responseBody }
    })
    if (!transactionResult || transactionResult.kind === 'missing') return res.status(404).json({ message: 'task not found' })
    if (transactionResult.kind === 'inspection_not_submitted') return res.status(409).json({ message: 'inspection_not_submitted' })
    if (transactionResult.kind === 'limit') return res.status(400).json({ message: '超出数量限制', area: 'unclean', limit: Math.max(0, transactionResult.limit) })
    if (transactionResult.kind === 'conflict') return res.status(409).json({ message: 'idempotency_conflict', submit_id: submitId, step_key: stepKey })
    if (transactionResult.kind === 'replay') return res.status(200).json(transactionResult.responseBody)
    try { broadcastCleaningEvent({ event: 'inspection_issue_photos_saved', task_id: id }) } catch {}
    return res.status(201).json(transactionResult.responseBody)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'inspection_issue_photos_failed' })
  }
})

const completionPhotosSchema = z
  .object({
    items: z.array(
      z.object({
        area: z.enum(['toilet', 'living', 'sofa', 'bedroom', 'kitchen', 'vacuum_used', 'shower_drain', 'remote_tv', 'remote_ac', 'remote_controls']),
        url: z.string().trim().min(1),
        note: z.string().trim().max(800).optional().nullable(),
        captured_at: z.string().trim().max(64).optional(),
      }),
    ),
    submit_id: z.string().trim().min(1).max(IDEMPOTENCY_SUBMIT_ID_MAX_LENGTH).optional(),
    step_key: z.string().trim().min(1).max(120).optional(),
    ...actionAuditBodySchema,
  })
  .strict()

const selfCompletePhotoExceptionItemSchema = z
  .object({
    area: z.enum(REQUIRED_COMPLETION_PHOTO_AREAS),
    reason: z.enum(['network_pending', 'local_file_missing', 'business_save_pending']),
    media_id: z.string().trim().min(1).max(160),
    captured_at: z.string().trim().min(1).max(64),
  })
  .strict()

const selfCompleteSchema = z
  .object({
    completion_photo_exception: z
      .object({
        items: z.array(selfCompletePhotoExceptionItemSchema).min(1).max(REQUIRED_COMPLETION_PHOTO_AREAS.length),
      })
      .strict()
      .optional(),
    ...actionAuditBodySchema,
  })
  .strict()

function normalizedSelfCompletePhotoException(raw: any, missingAreas: readonly string[]) {
  const items = Array.isArray(raw?.items) ? raw.items : []
  const byArea = new Map<string, { area: string; reason: string; media_id: string; captured_at: string }>()
  for (const item of items) {
    const area = String(item?.area || '').trim()
    if (!missingAreas.includes(area) || byArea.has(area)) continue
    const reason = String(item?.reason || '').trim()
    const mediaId = String(item?.media_id || '').trim()
    const capturedAt = String(item?.captured_at || '').trim()
    if (!['network_pending', 'local_file_missing', 'business_save_pending'].includes(reason) || !mediaId || !capturedAt) continue
    byArea.set(area, { area, reason, media_id: mediaId, captured_at: capturedAt })
  }
  if (!missingAreas.length || missingAreas.some((area) => !byArea.has(area))) return null
  return { items: missingAreas.map((area) => byArea.get(area)!) }
}

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
    const submitId = String(parsed.data.submit_id || '').trim()
    const stepKey = String(parsed.data.step_key || '').trim()
    const payloadHash = buildIdempotencyPayloadHash(parsed.data)
    const limits: Record<string, number> = { toilet: 9, living: 3, sofa: 2, bedroom: 8, kitchen: 2, vacuum_used: 1, shower_drain: 1, remote_tv: 1, remote_ac: 1, remote_controls: 3 }
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
      if (!await canPerformCleaningTaskAction(user, String(id), ['upload_access_video', 'complete_cleaning'])) return res.status(403).json({ message: 'forbidden' })
      if (submitId && stepKey) await assertIdempotentStepReceiptsReady(pgPool)
      const uuid = require('uuid')
      const batchId = uuid.v4()
      const transactionResult = await pgRunInTransaction(async (client) => {
        const lockedTask = await client.query(
          `SELECT id::text AS id, COALESCE(status, '') AS status
             FROM cleaning_tasks
            WHERE id::text=$1::text
            FOR UPDATE`,
          [String(id)],
        )
        const task = lockedTask?.rows?.[0]
        if (!task) return { kind: 'missing' as const }
        const statusBefore = String(task.status || '').trim()

        if (submitId && stepKey) {
          const receipt = await loadIdempotentStepReceipt(client, {
            scopeType: 'cleaning_task_completion_photos',
            scopeId: String(id),
            submitId,
            stepKey,
          })
          if (receipt) {
            if (String(receipt.payload_hash || '') !== payloadHash) return { kind: 'conflict' as const }
            return { kind: 'replay' as const, responseBody: receipt.response_json || { ok: true } }
          }
        }

        await client.query(`DELETE FROM cleaning_task_media WHERE task_id=$1 AND type LIKE 'completion_%'`, [id])
        for (const it of parsed.data.items) {
          const type = `completion_${it.area}`
          const cap = String(it.captured_at || '').trim()
          const capturedAt = cap ? new Date(cap) : new Date()
          await client.query(
            `INSERT INTO cleaning_task_media (id, task_id, type, url, note, captured_at)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [uuid.v4(), id, type, String(it.url), it.note == null ? null : String(it.note || ''), capturedAt.toISOString()],
          )
        }
        const actionActor = actorAndPerformerFromRequest(user, parsed.data)
        const actionAudit = await recordWorkTaskActionAudit({
          sourceType: 'cleaning_tasks',
          sourceId: String(id),
          performedAsAction: 'complete_cleaning',
          actorUserId: actionActor.actorUserId,
          performedByUserId: actionActor.performedByUserId,
          performedByName: actionActor.performedByName,
          statusBefore,
          statusAfter: statusBefore,
          metadata: {
            route: 'cleaning_app.tasks.completion_photos',
            step: 'completion_photos_saved',
            item_count: parsed.data.items.length,
          },
        }, client)
        const responseBody = { ok: true, action_result: { status_before: statusBefore || null, status_after: statusBefore || null, audit: actionAudit } }
        if (submitId && stepKey) {
          await saveIdempotentStepReceipt(client, {
            scopeType: 'cleaning_task_completion_photos',
            scopeId: String(id),
            submitId,
            stepKey,
          }, payloadHash, responseBody)
        }
        return { kind: 'committed' as const, responseBody }
      })
      if (!transactionResult || transactionResult.kind === 'missing') return res.status(404).json({ message: 'task not found' })
      if (transactionResult.kind === 'conflict') return res.status(409).json({ message: 'idempotency_conflict', submit_id: submitId, step_key: stepKey })
      if (transactionResult.kind === 'replay') return res.status(200).json(transactionResult.responseBody)
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
              policyKey: 'completion_photos_saved',
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
      return res.status(201).json(transactionResult.responseBody)
    }
    return res.status(201).json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'error' })
  }
})

const lockboxVideoSchema = z.object({ media_url: z.string().min(1), captured_at: z.string().optional(), lat: z.number().optional(), lng: z.number().optional(), ...actionAuditBodySchema })
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
      if (!await canPerformCleaningTaskAction(user, String(id), ['upload_access_video'])) return res.status(403).json({ message: 'forbidden' })
      const taskResult = await pgPool.query(
        `SELECT id::text AS id, task_type, inspection_mode
           FROM cleaning_tasks
          WHERE id::text = $1::text
          LIMIT 1`,
        [String(id)],
      )
      const taskRow = taskResult?.rows?.[0] || null
      if (!taskRow) return res.status(404).json({ message: 'task not found' })
      const selfCompleteLockbox = effectiveInspectionMode(taskRow) === 'self_complete'
      const uuid = require('uuid')
      const now = new Date().toISOString()
      const actionActor = actorAndPerformerFromRequest(user, parsed.data)
      const transactionResult = await pgRunInTransaction(async (client) => {
        await client.query(`DELETE FROM cleaning_task_media WHERE task_id=$1 AND type='lockbox_video'`, [id])
        await client.query(
          `INSERT INTO cleaning_task_media (id, task_id, type, url, captured_at, lat, lng)
           VALUES ($1,$2,'lockbox_video',$3,$4,$5,$6)`,
          [uuid.v4(), id, String(parsed.data.media_url), String(parsed.data.captured_at || now), parsed.data.lat ?? null, parsed.data.lng ?? null],
        )
        const actionResult = await applyCleaningTaskActionTransition({
          taskId: String(id),
          actionId: 'upload_access_video',
          actorUserId: actionActor.actorUserId,
          performedByUserId: actionActor.performedByUserId,
          performedByName: actionActor.performedByName,
          metadata: { route: 'cleaning_app.tasks.lockbox_video', self_complete_lockbox: selfCompleteLockbox },
        }, client)
        const upResult = await client.query(
          `UPDATE cleaning_tasks
             SET lockbox_video_uploaded_at = $2::timestamptz, updated_at = now()
           WHERE id::text = $1::text
           RETURNING *`,
          [String(id), now],
        )
        return { actionResult, up: upResult?.rows?.[0] || null }
      })
      const actionResult = transactionResult?.actionResult || null
      const up = transactionResult?.up || null
      await emitWorkTaskEvent({
        taskId: `cleaning_task:${String(id)}`,
        sourceType: 'cleaning_tasks',
        sourceRefIds: [String(id)],
        eventType: actionResult?.finalization_pending ? 'TASK_UPDATED' : 'TASK_COMPLETED',
        changeScope: 'list',
        changedFields: ['status', 'lockbox_video_uploaded_at', 'lockbox_video_url'],
        patch: {
          status: actionResult?.status_after || (up as any)?.status || null,
          lockbox_video_uploaded_at: now,
        },
        causedByUserId: String(user?.sub || '').trim() || null,
        visibilityHints: buildCleaningTaskVisibilityHints(up || { id, lockbox_video_uploaded_at: now }),
      })
      try { broadcastCleaningEvent({ event: 'lockbox_video_uploaded', task_id: id }) } catch {}
      try {
        const operationId = require('uuid').v4()
        const propertyId = String((up as any)?.property_id || '').trim()
        const propertyCode = await resolveCleaningTaskPropertyCode(String(id))
        if (propertyId) {
          await emitNotificationEvent(
            {
              type: 'WORK_TASK_UPDATED',
              policyKey: 'keys_hung',
              entity: 'cleaning_task',
              entityId: String(id),
              propertyId,
              updatedAt: now,
              title: propertyCode ? `${propertyCode} · 房间已挂钥匙` : '房间已挂钥匙',
              body: '挂钥匙视频已上传，房间钥匙已挂好',
              data: { entity: 'cleaning_task', entityId: String(id), action: 'open_task', kind: 'keys_hung', task_id: id, property_code: propertyCode || undefined },
              actorUserId: String(user?.sub || ''),
            },
            { operationId },
          )
        }
      } catch {}
      return res.status(201).json({ ...(up || { id, lockbox_video_uploaded_at: now }), action_result: actionResult })
    }
    return res.status(201).json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'error' })
  }
})

async function handleDeleteLockboxVideo(req: any, res: any) {
  const user = (req as any).user
  const { id } = req.params
  const taskId = String(id || '').trim()
  if (!taskId) return res.status(400).json({ message: 'missing id' })
  try {
    if (!hasPg) return res.json({ ok: true })
    await ensureCleaningTaskMediaNote()
    const { pgPool } = require('../dbAdapter')
    if (!pgPool) return res.status(500).json({ message: 'pg not available' })
    const userId = String(user?.sub || '').trim()
    if (!userId) return res.status(401).json({ message: 'unauthorized' })

    const r = await pgPool.query(
      `SELECT id::text AS id,
              status,
              COALESCE(cleaner_id, assignee_id)::text AS cleaner_id,
              inspector_id::text AS inspector_id,
              assignee_id::text AS assignee_id,
              property_id::text AS property_id
       FROM cleaning_tasks
       WHERE id::text = $1::text
       LIMIT 1`,
      [taskId],
    )
    const row = r?.rows?.[0] || null
    if (!row) return res.status(404).json({ message: 'not found' })

    const roleName = String(user?.role || user?.roles?.[0] || '').trim()
    const canViewAll = await hasPerm(roleName, 'cleaning_app.calendar.view.all')
    const allowedUserIds = [row.cleaner_id, row.inspector_id, row.assignee_id].map((v) => String(v || '').trim()).filter(Boolean)
    if (!canViewAll && !allowedUserIds.includes(userId)) return res.status(403).json({ message: 'forbidden' })

    const needsRestockResult = await pgPool.query(
      `SELECT 1
       FROM cleaning_consumable_usages
       WHERE task_id::text = $1::text
         AND (need_restock = true OR COALESCE(status, '') = 'low')
       LIMIT 1`,
      [taskId],
    )
    const nextStatus = isInspectionFinishedStatus(row.status)
      ? (needsRestockResult?.rowCount ? 'restock_pending' : 'cleaned')
      : (String(row.status || '').trim() || null)

    await pgPool.query(`DELETE FROM cleaning_task_media WHERE task_id::text = $1::text AND type = 'lockbox_video'`, [taskId])
    const up = await pgPool.query(
      `UPDATE cleaning_tasks
       SET status = COALESCE($2::text, status),
           lockbox_video_uploaded_at = NULL,
           updated_at = now()
       WHERE id::text = $1::text
       RETURNING id::text AS id, status, cleaner_id, inspector_id, assignee_id, property_id`,
      [taskId, nextStatus],
    )
    const updated = up?.rows?.[0] || { ...row, status: nextStatus }
    const patch: any = { lockbox_video_uploaded_at: null, lockbox_video_url: null }
    if (nextStatus) patch.status = nextStatus
    await emitWorkTaskEvent({
      taskId: `cleaning_task:${taskId}`,
      sourceType: 'cleaning_tasks',
      sourceRefIds: [taskId],
      eventType: 'TASK_UPDATED',
      changeScope: 'list',
      changedFields: Object.keys(patch),
      patch,
      causedByUserId: userId,
      visibilityHints: buildCleaningTaskVisibilityHints(updated),
    })

    try { broadcastCleaningEvent({ event: 'lockbox_video_deleted', task_id: taskId }) } catch {}
    return res.json({ ok: true, status: nextStatus, lockbox_video_uploaded_at: null, lockbox_video_url: null })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'error' })
  }
}

router.delete('/tasks/:id/lockbox-video', requirePerm('cleaning_app.tasks.finish'), handleDeleteLockboxVideo)
router.post('/tasks/:id/lockbox-video/delete', requirePerm('cleaning_app.tasks.finish'), handleDeleteLockboxVideo)

router.post('/tasks/:id/self-complete', requirePerm('cleaning_app.tasks.finish'), async (req, res) => {
  const user = (req as any).user
  const { id } = req.params
  const parsed = selfCompleteSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
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
      if (!await canPerformCleaningTaskAction(user, String(id), ['complete_cleaning'])) return res.status(403).json({ message: 'forbidden' })
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
      const missingAreas = REQUIRED_COMPLETION_PHOTO_AREAS.filter((a) => !got.has(a) && !(a === 'remote_tv' && (got.has('remote_controls') || got.has('remote_ac'))))
      const completionPhotoException = normalizedSelfCompletePhotoException(parsed.data.completion_photo_exception, missingAreas)
      if (missingAreas.length && !completionPhotoException) {
        return res.status(400).json({ message: '房间完成照片未齐', missing_areas: missingAreas })
      }

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

      const actionActor = actorAndPerformerFromRequest(user, parsed.data)
      const actionResult = await applyCleaningTaskActionTransition({
        taskId: String(id),
        actionId: 'complete_cleaning',
        actorUserId: actionActor.actorUserId,
        performedByUserId: actionActor.performedByUserId,
        performedByName: actionActor.performedByName,
        needsRestock,
        isStayover: isStayoverTask,
        metadata: {
          route: 'cleaning_app.tasks.self_complete',
          needs_restock: needsRestock,
          is_stayover: isStayoverTask,
          ...(completionPhotoException ? { completion_photo_exception: completionPhotoException } : {}),
        },
      }, pgPool)
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
                policyKey: 'cleaning_completed',
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
        return res.json({ ...(up || { id, ...patch }), action_result: actionResult, ...(completionPhotoException ? { completion_photo_exception: completionPhotoException } : {}) })
      }
      try {
        const { recordCleaningTaskStandardLinenUsage } = require('./inventory')
        await recordCleaningTaskStandardLinenUsage({
          cleaningTaskId: String(id),
          actorId: String(user?.sub || '').trim() || null,
        })
      } catch {}
      return res.json({ ok: true, id: String(id), action_result: actionResult, ...(completionPhotoException ? { completion_photo_exception: completionPhotoException } : {}) })
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
          return u && (/^https?:\/\//i.test(u) || isCleaningMediaKey(u)) ? u : null
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
              policyKey: 'restock_proof_saved',
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
              policyKey: 'task_ready',
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
    let where = `WHERE COALESCE(code, '') <> '' AND COALESCE(archived, false) = false`
    if (q) {
      values.push(`%${q}%`)
      where += ` AND code ILIKE $${values.length}`
    }
    values.push(q ? 100 : 5000)
    const rows = await pgPool.query(
      `SELECT id::text AS id, code, region
       FROM properties
       ${where}
       ORDER BY
         CASE COALESCE(region, '')
           WHEN 'Melbourne' THEN 0
           WHEN 'Southbank' THEN 1
           WHEN 'South Melbourne' THEN 2
           WHEN 'West Melbourne' THEN 3
           WHEN 'St Kilda' THEN 4
           WHEN 'Docklands' THEN 5
           WHEN '' THEN 99
           WHEN '其他' THEN 99
           WHEN '未分区' THEN 99
           ELSE 50
         END ASC,
         COALESCE(region, '') ASC,
         code ASC
       LIMIT $${values.length}`,
      values,
    )
    return res.json((rows.rows || []).map((x: any) => ({
      id: String(x.id || ''),
      code: String(x.code || ''),
      region: x.region ? String(x.region) : null,
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
        const notificationResult = await emitNotificationEvent({
          type: 'DAY_END_HANDOVER_MANAGER_REMINDER',
          policyKey: 'day_end_handover_manager_reminder',
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
        if (!notificationResult?.ok || !notificationResult?.sent) {
          console.error(`[notifications][emit_incomplete] source=day_end_handover_submitted date=${date} actor_user_id=${actorId} sent=${Number(notificationResult?.sent || 0)} error_code=${String(notificationResult?.error_code || '')}`)
        }
      }
    } catch (error: any) {
      console.error(`[notifications][emit_failed] source=day_end_handover_submitted date=${date} error=${String(error?.message || 'unknown')}`)
    }
    return res.status(201).json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'error' })
  }
})

export function selectUniqueRecordedCleaningMediaRow(rows: any[]) {
  const matchedRows = Array.isArray(rows) ? rows : []
  const matchedTaskIds = new Set(matchedRows.map((row: any) => String(row?.id || '').trim()).filter(Boolean))
  const matchedMediaTypes = new Set(matchedRows.map((row: any) => String(row?.type || '').trim()).filter(Boolean))
  return matchedTaskIds.size === 1 && matchedMediaTypes.size === 1 ? matchedRows[0] || null : null
}

export function selectUniqueRecordedDayEndMediaRow(rows: any[]) {
  const matchedRows = Array.isArray(rows) ? rows : []
  const matchedUserIds = new Set(matchedRows.map((row: any) => String(row?.user_id || '').trim()).filter(Boolean))
  const matchedKinds = new Set(matchedRows.map((row: any) => String(row?.kind || '').trim()).filter(Boolean))
  return matchedUserIds.size === 1 && matchedKinds.size === 1 ? matchedRows[0] || null : null
}

export function selectExclusiveRecordedCleaningMedia(taskRows: any[], dayEndRows: any[]) {
  const matchedTaskRows = Array.isArray(taskRows) ? taskRows : []
  const matchedDayEndRows = Array.isArray(dayEndRows) ? dayEndRows : []
  const taskRow = selectUniqueRecordedCleaningMediaRow(matchedTaskRows)
  const dayEndRow = selectUniqueRecordedDayEndMediaRow(matchedDayEndRows)
  if ((matchedTaskRows.length && !taskRow) || (matchedDayEndRows.length && !dayEndRow) || (!!taskRow && !!dayEndRow)) return null
  if (taskRow) return { source: 'task' as const, row: taskRow }
  if (dayEndRow) return { source: 'day_end' as const, row: dayEndRow }
  return null
}

export function isExclusiveDayEndHandoverMedia(
  dayEndRows: any[],
  taskRows: any[],
  guestLuggageRows: any[],
  feedbackRows: any[],
  requestedUserId: string,
  requestedDate: string,
) {
  const matchedDayEndRows = Array.isArray(dayEndRows) ? dayEndRows : []
  const recordedMedia = selectExclusiveRecordedCleaningMedia(taskRows, matchedDayEndRows)
  const selectedDayEndRow = recordedMedia?.source === 'day_end' ? recordedMedia.row : null
  return matchedDayEndRows.length === 1
    && !!selectedDayEndRow
    && String(selectedDayEndRow.user_id || '').trim() === requestedUserId
    && String(selectedDayEndRow.date || '').trim() === requestedDate
    && !(Array.isArray(guestLuggageRows) && guestLuggageRows.length)
    && !(Array.isArray(feedbackRows) && feedbackRows.length)
}

export function canViewRecordedDayEndMedia(user: any, mediaRow: any, userId: string) {
  const roles = new Set(roleNamesOfUser(user))
  return roles.has('admin') || roles.has('offline_manager') || roles.has('customer_service') || roles.has('inventory_manager')
    || (Boolean(userId) && String(mediaRow?.user_id || '').trim() === userId)
}

export default router

export function feedbackMediaUrlArray(raw: any): string[] {
  if (Array.isArray(raw)) return raw.map((value) => String(value || '').trim()).filter(Boolean)
  const text = String(raw || '').trim()
  if (!text) return []
  try {
    const parsed = JSON.parse(text)
    return Array.isArray(parsed) ? parsed.map((value) => String(value || '').trim()).filter(Boolean) : []
  } catch {
    return [text]
  }
}

export function feedbackMediaRowReferencesKey(row: any, key: string): boolean {
  const projectItems = (() => {
    const raw = row?.project_items
    if (Array.isArray(raw)) return raw
    try { return JSON.parse(String(raw || '')) } catch { return [] }
  })()
  const references = [
    ...feedbackMediaUrlArray(row?.photo_urls),
    ...feedbackMediaUrlArray(row?.before_photo_urls),
    ...feedbackMediaUrlArray(row?.after_photo_urls),
    ...feedbackMediaUrlArray(row?.repair_photo_urls),
    ...feedbackMediaUrlArray(row?.completion_photo_urls),
    ...feedbackMediaUrlArray(row?.attachment_urls),
    ...(Array.isArray(projectItems) ? projectItems.flatMap((item: any) => [
      ...feedbackMediaUrlArray(item?.before_photos),
      ...feedbackMediaUrlArray(item?.after_photos),
    ]) : []),
  ]
  return references.some((reference) => {
    const normalized = String(reference || '').trim()
    return normalized === key || r2KeyFromUrl(normalized) === key
  })
}

function isPropertyFeedbackMediaKey(value: string): boolean {
  const key = String(value || '').trim().replace(/^\/+/, '')
  if (key.startsWith('cleaning/')) return isCleaningMediaKey(key)
  if (!key.startsWith('mzapp/') && !key.startsWith('maintenance/') && !key.startsWith('deep-cleaning/') && !key.startsWith('deep-cleaning-upload/') && !key.startsWith('inventory/')) return false
  return !key.includes('..') && !key.includes('\\') && !/[?#]/.test(key)
}

export function guestLuggageMediaRowReferencesKey(row: any, key: string): boolean {
  return normalizeStoredPhotoUrls(row?.photo_urls).some((reference) => {
    const normalized = String(reference || '').trim()
    return normalized === key || r2KeyFromUrl(normalized) === key
  })
}

export function selectUniqueGuestLuggageMediaRow(rows: any[], guestLuggageId: unknown) {
  const expectedId = String(guestLuggageId || '').trim()
  if (!expectedId || !Array.isArray(rows) || rows.length !== 1) return null
  const row = rows[0]
  return String(row?.id || '').trim() === expectedId ? row : null
}

async function findGuestLuggageMediaRows(pool: any, key: string, sourceUrl: string) {
  const references = Array.from(new Set([key, sourceUrl].map((value) => String(value || '').trim()).filter(Boolean)))
  if (!references.length) return []
  const result = await pool.query(
    `SELECT id, property_id::text AS property_id, task_date::text AS task_date, photo_urls
       FROM guest_luggage_notices
      WHERE photo_urls ?| $1::text[]
      LIMIT 2`,
    [references],
  )
  return (result?.rows || []).filter((row: any) => guestLuggageMediaRowReferencesKey(row, key))
}

function canViewExternalMaintenanceCompletionMedia(user: any, row: any, userId: string): boolean {
  const roles = Array.from(new Set([
    String(user?.role || '').trim(),
    ...(Array.isArray(user?.roles) ? user.roles.map((role: any) => String(role || '').trim()) : []),
  ].filter(Boolean)))
  if (roles.some((role) => ['admin', 'offline_manager', 'customer_service'].includes(role))) return true
  return roles.includes('maintenance_staff')
    && !!userId
    && String(row?.assignee_id || '').trim() === userId
}

async function findPropertyFeedbackMediaRows(pool: any, key: string) {
  const result = await pool.query(
    `SELECT 'property_maintenance'::text AS feedback_source_type,
            m.id::text AS feedback_source_id,
            m.property_id,
            to_jsonb(m.photo_urls) AS photo_urls,
            to_jsonb(NULL::text) AS before_photo_urls,
            to_jsonb(NULL::text) AS after_photo_urls,
            to_jsonb(m.repair_photo_urls) AS repair_photo_urls,
            to_jsonb(m.completion_photo_urls) AS completion_photo_urls,
            to_jsonb(NULL::text) AS attachment_urls,
            to_jsonb(m.project_items) AS project_items,
            NULL::text AS assignee_id
       FROM property_maintenance m
       JOIN properties p ON p.id::text = m.property_id::text
      WHERE m.deleted_at IS NULL
        AND (
          COALESCE(m.photo_urls::text, '') LIKE $1
          OR COALESCE(m.repair_photo_urls::text, '') LIKE $1
          OR COALESCE(m.completion_photo_urls::text, '') LIKE $1
          OR COALESCE(m.project_items::text, '') LIKE $1
        )
     UNION ALL
     SELECT 'property_deep_cleaning'::text AS feedback_source_type,
            d.id::text AS feedback_source_id,
            d.property_id,
            to_jsonb(d.photo_urls) AS photo_urls,
            to_jsonb(NULL::text) AS before_photo_urls,
            to_jsonb(NULL::text) AS after_photo_urls,
            to_jsonb(d.repair_photo_urls) AS repair_photo_urls,
            to_jsonb(NULL::text) AS completion_photo_urls,
            to_jsonb(d.attachment_urls) AS attachment_urls,
            to_jsonb(d.project_items) AS project_items,
            NULL::text AS assignee_id
       FROM property_deep_cleaning d
       JOIN properties p ON p.id::text = d.property_id::text
      WHERE d.deleted_at IS NULL
        AND (
          COALESCE(d.photo_urls::text, '') LIKE $1
          OR COALESCE(d.repair_photo_urls::text, '') LIKE $1
          OR COALESCE(d.attachment_urls::text, '') LIKE $1
          OR COALESCE(d.project_items::text, '') LIKE $1
        )
     UNION ALL
     SELECT 'property_daily_necessities'::text AS feedback_source_type,
            n.id::text AS feedback_source_id,
            n.property_id,
            to_jsonb(n.photo_urls) AS photo_urls,
            to_jsonb(n.before_photo_urls) AS before_photo_urls,
            to_jsonb(n.after_photo_urls) AS after_photo_urls,
            to_jsonb(NULL::text) AS repair_photo_urls,
            to_jsonb(NULL::text) AS completion_photo_urls,
            to_jsonb(NULL::text) AS attachment_urls,
            to_jsonb(NULL::text) AS project_items,
            NULL::text AS assignee_id
       FROM property_daily_necessities n
      JOIN properties p ON p.id::text = n.property_id::text
      WHERE n.deleted_at IS NULL
        AND (
          COALESCE(n.photo_urls::text, '') LIKE $1
          OR COALESCE(n.before_photo_urls::text, '') LIKE $1
          OR COALESCE(n.after_photo_urls::text, '') LIKE $1
        )
     UNION ALL
     SELECT 'external_maintenance_orders'::text AS feedback_source_type,
            e.id::text AS feedback_source_id,
            NULL::text AS property_id,
            to_jsonb(NULL::text) AS photo_urls,
            to_jsonb(NULL::text) AS before_photo_urls,
            to_jsonb(NULL::text) AS after_photo_urls,
            to_jsonb(NULL::text) AS repair_photo_urls,
            to_jsonb(e.completion_photo_urls) AS completion_photo_urls,
            to_jsonb(NULL::text) AS attachment_urls,
            to_jsonb(NULL::text) AS project_items,
            w.assignee_id::text AS assignee_id
       FROM external_maintenance_orders e
       JOIN work_tasks w
         ON w.source_type = 'external_maintenance_orders'
        AND w.source_id::text = e.id::text
      WHERE COALESCE(e.completion_photo_urls::text, '') LIKE $1`,
    [`%${key}%`],
  )
  return (result?.rows || []).filter((row: any) => feedbackMediaRowReferencesKey(row, key))
}

function safeDayEndMediaUserId(value: unknown) {
  const id = String(value || '').trim()
  return /^[A-Za-z0-9:_-]{1,180}$/.test(id) ? id : ''
}

function safeDayEndMediaDate(value: unknown) {
  const date = String(value || '').trim()
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : ''
}

function dayEndMediaRowReferencesKey(row: any, key: string) {
  const reference = String(row?.url || '').trim()
  return reference === key || r2KeyFromUrl(reference) === key
}

function dayEndRejectMediaRowReferencesKey(row: any, key: string) {
  const raw = row?.photos_json
  const photos = Array.isArray(raw)
    ? raw
    : (() => {
        try { return JSON.parse(String(raw || '[]')) } catch { return [] }
      })()
  return (Array.isArray(photos) ? photos : []).some((photo: any) => {
    const reference = String(photo?.url || '').trim()
    return reference === key || r2KeyFromUrl(reference) === key
  })
}

async function findDayEndHandoverMediaRows(pool: any, userId: string, date: string, key: string) {
  const pattern = `%${key}%`
  const [mediaResult, rejectResult] = await Promise.all([
    pool.query(
      `SELECT 'day_end_media'::text AS source_type, user_id, date::text AS date, url, NULL::jsonb AS photos_json
         FROM cleaning_day_end_media
        WHERE user_id = $1::text
          AND date = $2::date
          AND COALESCE(url, '') LIKE $3`,
      [userId, date, pattern],
    ),
    pool.query(
      `SELECT 'day_end_reject'::text AS source_type, user_id, date::text AS date, NULL::text AS url, photos_json
         FROM cleaning_day_end_reject_items
        WHERE user_id = $1::text
          AND date = $2::date
          AND COALESCE(photos_json::text, '') LIKE $3`,
      [userId, date, pattern],
    ),
  ])
  return [
    ...(mediaResult?.rows || []).filter((row: any) => dayEndMediaRowReferencesKey(row, key)),
    ...(rejectResult?.rows || []).filter((row: any) => dayEndRejectMediaRowReferencesKey(row, key)),
  ]
}

function canViewDayEndHandoverMedia(user: any, row: any, userId: string) {
  return String(row?.user_id || '').trim() === userId || canViewDayEndForAllUsers(user)
}

const OFFLINE_TASK_MEDIA_MAX_BYTES = 15 * 1024 * 1024

function safeOfflineWorkTaskId(value: unknown) {
  const id = String(value || '').trim()
  return /^[A-Za-z0-9:_-]{1,180}$/.test(id) ? id : ''
}

function inspectMzappR2Url(value: unknown) {
  const raw = String(value || '').trim()
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (!url.hostname.toLowerCase().endsWith('.r2.dev') || !url.pathname.startsWith('/mzapp/')) return null
    const authority = /^https:\/\/([^/?#]*)/i.exec(raw)?.[1] || ''
    const hasUnsafeVariant = Boolean(url.protocol !== 'https:' || url.search || url.hash || url.username || url.password || url.port || authority.includes('@') || /:\d+$/.test(authority))
    return { hasUnsafeVariant }
  } catch {
    return null
  }
}

function offlineTaskMediaError(code: string, message: string) {
  const error: any = new Error(message)
  error.code = code
  return error
}

async function findOfflineWorkTaskPhotoRows(pool: any, references: string[]) {
  const keys = Array.from(new Set(references
    .map((reference) => normalizeMzappTaskPhotoKey(reference))
    .filter((key): key is string => Boolean(key))))
  const result = await pool.query(
    `SELECT w.id,
            w.assignee_id,
            w.photo_urls,
            w.completion_photo_urls
       FROM work_tasks w
      WHERE w.source_type = 'cleaning_offline_tasks'
        AND EXISTS (
          SELECT 1
            FROM jsonb_array_elements_text(
              COALESCE(w.photo_urls, '[]'::jsonb) || COALESCE(w.completion_photo_urls, '[]'::jsonb)
            ) AS stored(value)
           WHERE stored.value = ANY($1::text[])
              OR (
                CASE
                  WHEN stored.value ~* '^r2://[a-z0-9][a-z0-9._-]{0,119}/mzapp/[^?#]+$'
                    THEN regexp_replace(stored.value, '^r2://[^/]+/', '')
                  WHEN stored.value ~* '^https://[^/?#@:]+\\.r2\\.dev/mzapp/[^?#]+$'
                    THEN regexp_replace(stored.value, '^https://[^/]+/', '')
                  ELSE ''
                END
              ) = ANY($2::text[])
        )
      LIMIT 2`,
    [references, keys],
  )
  return result?.rows || []
}

async function loadLegacyOfflineTaskPhoto(reference: string) {
  if (!isLegacyMzappTaskPhotoPublicUrl(reference)) throw offlineTaskMediaError('OFFLINE_MEDIA_INVALID_REFERENCE', 'invalid_media_reference')
  let response: Response
  try {
    response = await fetch(reference, {
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    throw offlineTaskMediaError('OFFLINE_MEDIA_LEGACY_UNAVAILABLE', 'legacy_media_unavailable')
  }
  if (response.status === 404) return null
  if (!response.ok) throw offlineTaskMediaError('OFFLINE_MEDIA_LEGACY_UNAVAILABLE', 'legacy_media_unavailable')
  const declaredLength = Number(response.headers.get('content-length') || 0)
  if (Number.isFinite(declaredLength) && declaredLength > OFFLINE_TASK_MEDIA_MAX_BYTES) {
    throw offlineTaskMediaError('OFFLINE_MEDIA_TOO_LARGE', 'legacy_media_too_large')
  }
  const body = Buffer.from(await response.arrayBuffer())
  if (!body.length) return null
  if (body.length > OFFLINE_TASK_MEDIA_MAX_BYTES) throw offlineTaskMediaError('OFFLINE_MEDIA_TOO_LARGE', 'legacy_media_too_large')
  return {
    body,
    contentType: String(response.headers.get('content-type') || 'application/octet-stream'),
    etag: undefined as string | undefined,
  }
}

router.get(
  '/media/image',
  async (req, res) => {
    try {
      const requestedKey = String((req.query as any)?.key || '').trim()
      const sourceUrl = String((req.query as any)?.url || '').trim()
      const requestedWorkTaskIdRaw = String((req.query as any)?.work_task_id || '').trim()
      const requestedWorkTaskId = safeOfflineWorkTaskId(requestedWorkTaskIdRaw)
      const workTaskId = requestedWorkTaskId
      const guestLuggageId = String((req.query as any)?.guest_luggage_id || '').trim()
      const sourceTaskId = String((req.query as any)?.source_task_id || '').trim()
      const requestedDayEndUserIdRaw = String((req.query as any)?.day_end_user_id || '').trim()
      const requestedDayEndDateRaw = String((req.query as any)?.day_end_date || '').trim()
      const requestedDayEndUserId = safeDayEndMediaUserId(requestedDayEndUserIdRaw)
      const requestedDayEndDate = safeDayEndMediaDate(requestedDayEndDateRaw)
      const hasDayEndContext = Boolean(requestedDayEndUserIdRaw || requestedDayEndDateRaw)
      const variant = String((req.query as any)?.variant || 'original').trim().toLowerCase()
      if (!requestedKey && !sourceUrl) return res.status(400).json({ message: 'missing_key' })
      if (!['original', 'thumbnail', 'preview'].includes(variant)) return res.status(400).json({ message: 'invalid_variant' })
      const requestedKeyCurrentKey = currentMzappTaskPhotoKeyFromReference(requestedKey)
      const sourceUrlCurrentKey = currentMzappTaskPhotoKeyFromReference(sourceUrl)
      const requestedKeyHasQueryOrFragment = /^https?:\/\//i.test(requestedKey) && /[?#]/.test(requestedKey)
      const sourceUrlHasQueryOrFragment = /^https?:\/\//i.test(sourceUrl) && /[?#]/.test(sourceUrl)
      const requestedKeyMzappR2Url = inspectMzappR2Url(requestedKey)
      const sourceUrlMzappR2Url = inspectMzappR2Url(sourceUrl)
      const offlineReferences = Array.from(new Set([
        ...offlineTaskPhotoReferenceVariants(requestedKey),
        ...offlineTaskPhotoReferenceVariants(sourceUrl),
      ]))
      // Resolve every current/legacy mzapp reference against offline tasks before
      // considering the generic feedback-media branch. Otherwise a caller could
      // add an unrelated source_task_id (or an incorrect work_task_id) and bypass
      // the exact offline association and authorization gate below.
      const isOfflineTaskPhotoCandidate = offlineReferences.length > 0
      if ((requestedKeyCurrentKey && requestedKeyHasQueryOrFragment) || (sourceUrlCurrentKey && sourceUrlHasQueryOrFragment) || requestedKeyMzappR2Url?.hasUnsafeVariant || sourceUrlMzappR2Url?.hasUnsafeVariant) {
        return res.status(403).json({ code: 'forbidden_media', message: 'forbidden_media' })
      }
      if (isOfflineTaskPhotoCandidate && requestedWorkTaskIdRaw && !requestedWorkTaskId) {
        return res.status(403).json({ code: 'forbidden_media', message: 'forbidden_media' })
      }
      if (isOfflineTaskPhotoCandidate) {
        if (!hasPg) return res.status(403).json({ code: 'forbidden_media', message: 'forbidden_media' })
        const { pgPool } = require('../dbAdapter')
        if (!pgPool) return res.status(403).json({ code: 'forbidden_media', message: 'forbidden_media' })
        const offlineRows = await findOfflineWorkTaskPhotoRows(pgPool, offlineReferences)
        const offlineRow = offlineRows.length === 1 ? offlineRows[0] : null
        if (offlineRows.length && (!offlineRow || (requestedWorkTaskId && String(offlineRow.id || '').trim() !== requestedWorkTaskId))) {
          return res.status(403).json({ code: 'forbidden_media', message: 'forbidden_media' })
        }
        if (offlineRow) {
          const user = (req as any).user || {}
          const userId = String(user.sub || '').trim()
          if (!await canViewMzappOfflineWorkTaskMedia(user, offlineRow, userId)) {
            return res.status(403).json({ code: 'forbidden_media', message: 'forbidden_media' })
          }
          const offlineStoredReferences = new Set([
            ...normalizeStoredPhotoUrls(offlineRow.photo_urls),
            ...normalizeStoredPhotoUrls(offlineRow.completion_photo_urls),
          ])
          const offlineStoredReference = offlineReferences.find((reference) => offlineStoredReferences.has(reference))
          if (!offlineStoredReference) {
            return res.status(403).json({ code: 'forbidden_media', message: 'forbidden_media' })
          }
          const offlineObjectKey = currentOfflineTaskPhotoKeyFromReference(offlineStoredReference) || normalizeMzappTaskPhotoKey(offlineStoredReference)
          const object = offlineObjectKey
            ? hasR2
              ? await r2GetObjectByKey(offlineObjectKey)
              : undefined
            : await loadLegacyOfflineTaskPhoto(offlineStoredReference)
          if (offlineObjectKey && !hasR2) {
            return res.status(503).json({ code: 'media_storage_unavailable', message: 'media_storage_unavailable' })
          }
          if (!object || !object.body?.length) return res.status(404).json({ code: 'media_not_found', message: 'not_found' })
          const maxEdge = variant === 'thumbnail' ? 480 : 1600
          const quality = variant === 'thumbnail' ? 68 : 82
          const responseBody = await encodeCleaningImageToJpeg(object.body, variant === 'original' ? undefined : { maxEdge, quality })
          res.setHeader('Content-Type', 'image/jpeg')
          res.setHeader('Cache-Control', 'private, max-age=86400')
          if (object.etag) {
            const baseEtag = String(object.etag).replace(/^W\//, '').replace(/^"|"$/g, '')
            res.setHeader('ETag', `W/"${baseEtag}-${variant}-jpeg"`)
          }
          return res.status(200).send(responseBody)
        }
        // A zero-row result is not an offline record and may instead be a
        // separately recorded property-feedback reference. That generic source
        // remains protected by its own exact-record selector below.
      }
      if (hasDayEndContext) {
        if (!requestedDayEndUserId || !requestedDayEndDate || sourceTaskId || requestedWorkTaskIdRaw || guestLuggageId) {
          return res.status(403).json({ code: 'forbidden_media', message: 'forbidden_media' })
        }
        const dayEndKey = String(requestedKey || r2KeyFromUrl(sourceUrl) || '').trim()
        if (!isCleaningMediaKey(dayEndKey)) {
          return res.status(403).json({ code: 'forbidden_media', message: 'forbidden_media' })
        }
        if (!hasPg) return res.status(403).json({ code: 'forbidden_media', message: 'forbidden_media' })
        const { pgPool } = require('../dbAdapter')
        if (!pgPool) return res.status(403).json({ code: 'forbidden_media', message: 'forbidden_media' })
        const dayEndRows = await findDayEndHandoverMediaRows(pgPool, requestedDayEndUserId, requestedDayEndDate, dayEndKey)
        const dayEndRow = dayEndRows.length === 1 ? dayEndRows[0] : null
        const dayEndKeyPattern = `%${dayEndKey}%`
        const [
          taskMediaResult,
          consumableMediaResult,
          allDayEndMediaResult,
          allDayEndRejectResult,
          guestLuggageResult,
          feedbackMediaRows,
        ] = await Promise.all([
          pgPool.query(
            `SELECT ctm.type,
                    ctm.url,
                    ct.id,
                    ct.cleaner_id,
                    ct.inspector_id,
                    ct.assignee_id
               FROM cleaning_task_media ctm
               JOIN cleaning_tasks ct ON ct.id::text = ctm.task_id::text
              WHERE COALESCE(ctm.url, '') LIKE $1`,
            [dayEndKeyPattern],
          ),
          pgPool.query(
            `SELECT ct.id,
                    ct.cleaner_id,
                    ct.inspector_id,
                    ct.assignee_id,
                    u.photo_url,
                    u.photo_urls
               FROM cleaning_consumable_usages u
               JOIN cleaning_tasks ct ON ct.id::text = u.task_id::text
              WHERE COALESCE(u.photo_url, '') LIKE $1
                 OR COALESCE(u.photo_urls::text, '') LIKE $1`,
            [dayEndKeyPattern],
          ),
          pgPool.query(
            `SELECT user_id,
                    date::text AS date,
                    kind,
                    url
               FROM cleaning_day_end_media
              WHERE COALESCE(url, '') LIKE $1`,
            [dayEndKeyPattern],
          ),
          pgPool.query(
            `SELECT user_id,
                    date::text AS date,
                    photos_json
               FROM cleaning_day_end_reject_items
              WHERE COALESCE(photos_json::text, '') LIKE $1`,
            [dayEndKeyPattern],
          ),
          pgPool.query(
            `SELECT id,
                    photo_urls
               FROM guest_luggage_notices
              WHERE COALESCE(photo_urls::text, '') LIKE $1`,
            [dayEndKeyPattern],
          ),
          findPropertyFeedbackMediaRows(pgPool, dayEndKey),
        ])
        const matchingTaskMediaRows = [
          ...(taskMediaResult?.rows || []),
          ...(consumableMediaResult?.rows || []).flatMap((row: any) => normalizeStoredPhotoUrls(row.photo_urls, row.photo_url)
            .map((url) => ({
              id: row.id,
              cleaner_id: row.cleaner_id,
              inspector_id: row.inspector_id,
              assignee_id: row.assignee_id,
              type: 'consumable_item_photo',
              url,
            }))),
        ].filter((row: any) => (r2KeyFromUrl(String(row?.url || '').trim()) || String(row?.url || '').trim()) === dayEndKey)
        const matchingAllDayEndRows = [
          ...(allDayEndMediaResult?.rows || []).filter((row: any) => dayEndMediaRowReferencesKey(row, dayEndKey)),
          ...(allDayEndRejectResult?.rows || []).flatMap((row: any) => {
            const raw = row?.photos_json
            const photos = Array.isArray(raw)
              ? raw
              : (() => {
                  try { return JSON.parse(String(raw || '[]')) } catch { return [] }
                })()
            return (Array.isArray(photos) ? photos : [])
              .map((photo: any) => String(photo?.url || '').trim())
              .filter((url) => (r2KeyFromUrl(url) || url) === dayEndKey)
              .map((url) => ({ ...row, kind: 'day_end_reject', url }))
          }),
        ]
        const matchingGuestLuggageRows = (guestLuggageResult?.rows || []).filter((row: any) => (
          normalizeStoredPhotoUrls(row.photo_urls).some((url) => (r2KeyFromUrl(url) || url) === dayEndKey)
        ))
        const user = (req as any).user || {}
        const userId = String(user.sub || '').trim()
        if (!dayEndRow
          || !isExclusiveDayEndHandoverMedia(
            matchingAllDayEndRows,
            matchingTaskMediaRows,
            matchingGuestLuggageRows,
            feedbackMediaRows,
            requestedDayEndUserId,
            requestedDayEndDate,
          )
          || !canViewDayEndHandoverMedia(user, dayEndRow, userId)) {
          return res.status(403).json({ code: 'forbidden_media', message: 'forbidden_media' })
        }
        if (!hasR2) return res.status(503).json({ code: 'media_storage_unavailable', message: 'media_storage_unavailable' })
        const object = await r2GetObjectByKey(dayEndKey)
        if (!object || !object.body?.length) return res.status(404).json({ code: 'media_not_found', message: 'not_found' })
        const maxEdge = variant === 'thumbnail' ? 480 : 1600
        const quality = variant === 'thumbnail' ? 68 : 82
        const responseBody = await encodeCleaningImageToJpeg(object.body, variant === 'original' ? undefined : { maxEdge, quality })
        res.setHeader('Content-Type', 'image/jpeg')
        res.setHeader('Cache-Control', 'private, max-age=86400')
        if (object.etag) {
          const baseEtag = String(object.etag).replace(/^W\//, '').replace(/^"|"$/g, '')
          res.setHeader('ETag', `W/"${baseEtag}-${variant}-jpeg"`)
        }
        return res.status(200).send(responseBody)
      }
      if (!hasR2) return res.status(404).json({ message: 'r2_not_configured' })
      const key = String(requestedKey || r2KeyFromUrl(sourceUrl) || '').trim()
      if (!isPropertyFeedbackMediaKey(key)) {
        return res.status(403).json({ message: 'forbidden_key' })
      }
      if (!hasPg) return res.status(403).json({ message: 'forbidden_media' })
      const { pgPool } = require('../dbAdapter')
      if (!pgPool) return res.status(403).json({ message: 'forbidden_media' })
      const mediaReferences = Array.from(new Set([key, sourceUrl].map((value) => String(value || '').trim()).filter(Boolean)))
      const mediaRows = isCleaningMediaKey(key)
        ? await pgPool.query(
          `SELECT ctm.type,
                  ctm.url,
                  ct.id,
                  ct.cleaner_id,
                  ct.inspector_id,
                  ct.assignee_id
            FROM cleaning_task_media ctm
             JOIN cleaning_tasks ct ON ct.id::text = ctm.task_id::text
            WHERE ctm.url = ANY($1::text[])`,
          [mediaReferences],
        )
        : { rows: [] }
      const usageRows = isCleaningMediaKey(key)
        ? await pgPool.query(
          `SELECT ct.id,
                  ct.cleaner_id,
                  ct.inspector_id,
                  ct.assignee_id,
                  u.photo_url,
                  u.photo_urls
             FROM cleaning_consumable_usages u
             JOIN cleaning_tasks ct ON ct.id::text = u.task_id::text
            WHERE COALESCE(u.photo_url, '') = ANY($1::text[])
               OR EXISTS (
                 SELECT 1
                   FROM unnest($1::text[]) AS reference(value)
                  WHERE position(reference.value IN COALESCE(u.photo_urls::text, '')) > 0
               )`,
          [mediaReferences],
        )
        : { rows: [] }
      const hasGuestLuggageContext = Boolean(guestLuggageId)
      const guestLuggageRows = hasGuestLuggageContext
        ? { rows: await findGuestLuggageMediaRows(pgPool, key, sourceUrl) }
        : isCleaningMediaKey(key)
          ? await pgPool.query(
          `SELECT id, property_id::text AS property_id, task_date::text AS task_date, photo_urls
             FROM guest_luggage_notices
            WHERE COALESCE(photo_urls::text, '') LIKE $1
            LIMIT 2`,
          [`%${key}%`],
          )
          : { rows: [] }
      const dayEndRows = isCleaningMediaKey(key)
        ? await pgPool.query(
          `SELECT user_id, kind, url
             FROM cleaning_day_end_media
            WHERE url = ANY($1::text[])`,
          [mediaReferences],
        )
        : { rows: [] }
      const user = (req as any).user || {}
      const userId = String(user.sub || '').trim()
      const usageMediaRows = (usageRows?.rows || []).flatMap((row: any) => normalizeStoredPhotoUrls(row.photo_urls, row.photo_url)
        .map((url) => ({
          id: row.id,
          cleaner_id: row.cleaner_id,
          inspector_id: row.inspector_id,
          assignee_id: row.assignee_id,
          type: 'consumable_item_photo',
          url,
        })))
      const matchingGuestLuggageRows = (guestLuggageRows?.rows || []).filter((row: any) => (
        normalizeStoredPhotoUrls(row.photo_urls).some((url) => (r2KeyFromUrl(url) || url) === key)
      ))
      const guestLuggageMediaRow = selectUniqueGuestLuggageMediaRow(matchingGuestLuggageRows, guestLuggageId)
      const matchingMediaRows = [...(mediaRows?.rows || []), ...usageMediaRows].filter((row: any) => {
        const storedKey = r2KeyFromUrl(String(row?.url || '').trim()) || String(row?.url || '').trim()
        return storedKey === key
      })
      const matchingDayEndRows = (dayEndRows?.rows || []).filter((row: any) => {
        const storedKey = r2KeyFromUrl(String(row?.url || '').trim()) || String(row?.url || '').trim()
        return storedKey === key
      })
      const hasTaskOrDayEndMedia = matchingMediaRows.length > 0 || matchingDayEndRows.length > 0
      const taskOrDayEndMedia = selectExclusiveRecordedCleaningMedia(matchingMediaRows, matchingDayEndRows)
      const recordedMedia = hasTaskOrDayEndMedia && matchingGuestLuggageRows.length === 0
        ? taskOrDayEndMedia
        : null
      // A temporary-notice association must never hide another private-media source.
      // It needs a feedback/external-maintenance lookup for collision detection.  Without
      // a notice, retain the established fail-closed task/day-end boundary: even an
      // ambiguous task/day-end association must not fall through to feedback access.
      const feedbackMediaRows = !!guestLuggageMediaRow || (!hasTaskOrDayEndMedia && !hasGuestLuggageContext)
        ? await findPropertyFeedbackMediaRows(pgPool, key)
        : []
      const hasGuestLuggageSourceConflict = matchingGuestLuggageRows.length > 0
        && (hasTaskOrDayEndMedia || feedbackMediaRows.length > 0)
      const feedbackMediaRow = feedbackMediaRows.length === 1 ? feedbackMediaRows[0] : null
      const maintenanceWorkTaskResult = feedbackMediaRow?.feedback_source_type === 'property_maintenance' && workTaskId
        ? await pgPool.query(
          `SELECT id::text AS id, assignee_id::text AS assignee_id
             FROM work_tasks
            WHERE id::text = $1
              AND source_type = 'property_maintenance'
              AND source_id::text = $2
              AND property_id::text = $3
            LIMIT 1`,
          [workTaskId, String(feedbackMediaRow.feedback_source_id || '').trim(), String(feedbackMediaRow.property_id || '').trim()],
        )
        : null
      const maintenanceWorkTask = maintenanceWorkTaskResult?.rows?.[0] || null
      const canViewMaintenanceWorkTask = !!maintenanceWorkTask && (
        roleNamesOfUser(user).some((role) => ['admin', 'offline_manager', 'customer_service'].includes(role))
        || String(maintenanceWorkTask.assignee_id || '').trim() === userId
      )
      const canView = hasGuestLuggageContext
        ? !hasGuestLuggageSourceConflict
          && !!guestLuggageMediaRow
          && await canViewMzappGuestLuggageNoticeMedia(user, guestLuggageMediaRow, userId)
        : hasGuestLuggageSourceConflict
          ? false
          : recordedMedia?.source === 'task'
          ? await canViewMzappRecordedCleaningMedia(user, recordedMedia.row, userId, recordedMedia.row.type)
          : recordedMedia?.source === 'day_end'
            ? canViewRecordedDayEndMedia(user, recordedMedia.row, userId)
            : guestLuggageMediaRow
              ? await canViewMzappGuestLuggageNoticeMedia(user, guestLuggageMediaRow, userId)
              : feedbackMediaRow
                ? String(feedbackMediaRow.feedback_source_type || '') === 'external_maintenance_orders'
                  ? canViewExternalMaintenanceCompletionMedia(user, feedbackMediaRow, userId)
                  : canViewMaintenanceWorkTask || await canViewMzappPropertyFeedback(user, feedbackMediaRow, userId)
                : false
      if (!canView) {
        return res.status(403).json({ message: 'forbidden_media' })
      }
      const object = await r2GetObjectByKey(key)
      if (!object || !object.body?.length) return res.status(404).json({ message: 'not_found' })
      let responseBody = object.body
      let responseContentType = object.contentType || 'application/octet-stream'
      if (variant !== 'original') {
        const maxEdge = variant === 'thumbnail' ? 480 : 1600
        const quality = variant === 'thumbnail' ? 68 : 82
        responseBody = await encodeCleaningImageToJpeg(object.body, { maxEdge, quality })
        responseContentType = 'image/jpeg'
      } else {
        responseBody = await encodeCleaningImageToJpeg(object.body)
        responseContentType = 'image/jpeg'
      }
      res.setHeader('Content-Type', responseContentType)
      res.setHeader('Cache-Control', 'private, max-age=86400')
      if (object.etag) {
        const baseEtag = String(object.etag).replace(/^W\//, '').replace(/^"|"$/g, '')
        const jpegSuffix = responseContentType === 'image/jpeg' ? '-jpeg' : ''
        res.setHeader('ETag', variant === 'original' ? (jpegSuffix ? `W/"${baseEtag}${jpegSuffix}"` : object.etag) : `W/"${baseEtag}-${variant}${jpegSuffix}"`)
      }
      return res.status(200).send(responseBody)
    } catch (e: any) {
      if (e?.code === CLEANING_IMAGE_FORMAT_ERROR) return res.status(415).json({ code: CLEANING_IMAGE_FORMAT_ERROR, message: 'image_format_unsupported' })
      return res.status(500).json({ message: e?.message || 'media_read_failed' })
    }
  },
)

router.post(
  '/upload',
  requireAnyPerm(['cleaning_app.media.upload', 'cleaning_app.tasks.finish', 'cleaning_app.inspect.finish', 'cleaning_app.issues.report']),
  upload.single('file'),
  async (req, res) => {
  const uploadRequestId = cleaningUploadRequestId(req)
  if (!req.file) {
    console.error(`[cleaning-upload] event=rejected request_id=${uploadRequestId} stage=validate error_code=MISSING_FILE`)
    return res.status(400).json({ code: 'MISSING_FILE', message: 'missing file', upload_request_id: uploadRequestId })
  }
  let uploadStage = 'validate'
  let taskId = ''
  let mediaId = ''
  let purpose = ''
  try {
    const user = (req as any).user || {}
    const body: any = (req as any).body || {}
    taskId = String(body.task_id || '').trim()
    mediaId = String(body.media_id || '').trim()
    purpose = String(body.purpose || '').trim()
    const fileBytes = Math.max(0, Number((req.file as any)?.size || (req.file as any)?.buffer?.length || 0))
    const isImage = isImageUploadCandidate(req.file.mimetype, req.file.originalname)
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

    console.log(
      `[cleaning-upload] event=received request_id=${uploadRequestId} task_id=${stableUploadKeySegment(taskId, 'unscoped')} media_id=${stableUploadKeySegment(mediaId, 'unscoped')} purpose=${stableUploadKeySegment(purpose, 'unspecified')} size_bytes=${fileBytes} mime=${stableUploadKeySegment(req.file.mimetype, 'unknown')} r2=${hasR2 ? 1 : 0}`,
    )

    if (hasR2 && (req.file as any).buffer) {
      uploadStage = 'normalize_image'
      const normalized = await normalizeCleaningImageUpload({
        buffer: (req.file as any).buffer,
        contentType: req.file.mimetype,
        originalName: req.file.originalname,
      })
      let buf: Buffer = normalized.buffer
      if (normalized.isImage && wantWatermark && lines.length) {
        uploadStage = 'watermark_image'
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
      const ext = normalized.normalized ? '.jpg' : ((isImage && wantWatermark && lines.length) ? '.jpg' : (path.extname(req.file.originalname) || ''))
      const key = mediaId
        ? `cleaning/media/${stableUploadKeySegment(taskId, 'unscoped')}/${stableUploadKeySegment(mediaId, 'media')}`
        : `cleaning/${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`
      const mime = normalized.normalized || (isImage && wantWatermark && lines.length) ? 'image/jpeg' : (req.file.mimetype || 'application/octet-stream')
      uploadStage = 'upload_r2'
      const url = await r2Upload(key, mime, buf)
      console.log(`[cleaning-upload] event=stored request_id=${uploadRequestId} task_id=${stableUploadKeySegment(taskId, 'unscoped')} media_id=${stableUploadKeySegment(mediaId, 'unscoped')} stage=upload_r2`)
      return res.status(201).json({ key, url, upload_request_id: uploadRequestId })
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
    console.log(`[cleaning-upload] event=stored request_id=${uploadRequestId} task_id=${stableUploadKeySegment(taskId, 'unscoped')} media_id=${stableUploadKeySegment(mediaId, 'unscoped')} stage=local_upload`)
    return res.status(201).json({ url, upload_request_id: uploadRequestId })
  } catch (e: any) {
    const errorCode = e?.code === CLEANING_IMAGE_FORMAT_ERROR ? CLEANING_IMAGE_FORMAT_ERROR : 'CLEANING_MEDIA_UPLOAD_FAILED'
    console.error(
      `[cleaning-upload] event=failed request_id=${uploadRequestId} task_id=${stableUploadKeySegment(taskId, 'unscoped')} media_id=${stableUploadKeySegment(mediaId, 'unscoped')} purpose=${stableUploadKeySegment(purpose, 'unspecified')} stage=${uploadStage} error_code=${errorCode}`,
    )
    if (e?.code === CLEANING_IMAGE_FORMAT_ERROR) return res.status(415).json({ code: CLEANING_IMAGE_FORMAT_ERROR, message: 'image_format_unsupported', upload_request_id: uploadRequestId })
    return res.status(500).json({ code: errorCode, message: 'media_upload_failed', upload_request_id: uploadRequestId })
  }
})
