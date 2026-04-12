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

export const router = Router()
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

async function listDayEndManagerUserIds() {
  const { listManagerUserIds } = require('./notifications')
  return await listManagerUserIds({ roles: ['admin', 'offline_manager'] })
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
          t.status,
          t.assignee_id,
          t.cleaner_id,
          t.inspector_id,
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
      return res.json(
        rows.map((row) => {
          const taskId = String(row.task_id || '')
          const taskDate = String(row.task_date || '').slice(0, 10)
          const oldCode = row.old_code === null || row.old_code === undefined ? null : String(row.old_code)
          const newCode = row.new_code === null || row.new_code === undefined ? null : String(row.new_code)
          const keyboxCode = row.property_keybox_code === null || row.property_keybox_code === undefined ? null : String(row.property_keybox_code)
          const accessCode = (newCode && newCode.trim()) ? newCode : (oldCode && oldCode.trim()) ? oldCode : (keyboxCode && keyboxCode.trim()) ? keyboxCode : null
          const propertyId = row.property_id === null || row.property_id === undefined ? null : String(row.property_id)
          const accessGuideLink =
            row.property_access_guide_link === null || row.property_access_guide_link === undefined ? null : String(row.property_access_guide_link)
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
            status: row.status === null || row.status === undefined ? '' : String(row.status),
            assignee_id: row.assignee_id === null || row.assignee_id === undefined ? null : String(row.assignee_id),
            cleaner_id: row.cleaner_id === null || row.cleaner_id === undefined ? null : String(row.cleaner_id),
            inspector_id: row.inspector_id === null || row.inspector_id === undefined ? null : String(row.inspector_id),
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
      const now = new Date().toISOString()
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
              entity: 'cleaning_task',
              entityId: String(id),
              propertyId,
              updatedAt: new Date().toISOString(),
              title: '房源问题反馈',
              body: `收到新的问题反馈：${String(issue.title || '').trim() || '问题'}`.slice(0, 240),
              data: { entity: 'cleaning_task', entityId: String(id), action: 'open_task', kind: 'issue_reported', task_id: id, issue_id: issue.id },
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
  items: z.array(
    z.object({
      item_id: z.string().min(1),
      status: z.enum(['ok', 'low']),
      qty: z.number().int().min(1).optional(),
      note: z.string().optional(),
      photo_url: z.string().optional(),
    }),
  ),
})
router.get('/tasks/:id/consumables', requirePerm('cleaning_app.tasks.finish'), async (req, res) => {
  const { id } = req.params
  try {
    if (!hasPg) return res.json({ items: [] })
    const { pgPool } = require('../dbAdapter')
    if (!pgPool) return res.json({ items: [] })
    const rows = await pgPool.query(
      `SELECT id, item_id, qty, need_restock, note, status, photo_url, item_label, created_at
       FROM cleaning_consumable_usages
       WHERE task_id = $1
       ORDER BY created_at ASC, id ASC`,
      [String(id)],
    )
    return res.json({
      items: (rows.rows || []).map((x: any) => ({
        id: String(x.id || ''),
        item_id: String(x.item_id || ''),
        qty: Number(x.qty || 0) || 0,
        need_restock: !!x.need_restock,
        note: x.note == null ? null : String(x.note),
        status: String(x.status || ''),
        photo_url: x.photo_url == null ? null : String(x.photo_url),
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
        if (row.status === 'low' && requiresPhoto && !String(row.photo_url || '').trim()) {
          return res.status(400).json({ message: '不足项必须拍照', item_id: row.item_id })
        }
        if (row.status === 'low' && (!row.qty || row.qty < 1)) {
          return res.status(400).json({ message: '不足项必须填写数量', item_id: row.item_id })
        }
      }

      await pgPool.query(`DELETE FROM cleaning_consumable_usages WHERE task_id=$1`, [String(id)])

      for (const it of parsed.data.items) {
        const meta: any = byId.get(String(it.item_id)) || null
        const row = {
          id: require('uuid').v4(),
          task_id: id,
          item_id: String(it.item_id),
          qty: it.status === 'low' ? Number(it.qty || 1) : 1,
          need_restock: it.status === 'low',
          note: it.note || null,
          status: it.status,
          photo_url: it.photo_url || null,
          item_label: meta ? String(meta.label || '') : null,
        }
        await pgInsert('cleaning_consumable_usages', row as any)
      }
      const needsRestock = parsed.data.items.some((i) => i.status === 'low')
      const now = new Date().toISOString()
      const taskStatus = String(task.status || '').trim().toLowerCase()
      const isFinishedTask = ['cleaned', 'restock_pending', 'restocked', 'to_inspect', 'to_hang_keys', 'keys_hung', 'done', 'completed', 'ready'].includes(taskStatus)
      const patch: any = {}
      if (!isFinishedTask) patch.status = needsRestock ? 'restock_pending' : 'cleaned'
      if (!task.finished_at) patch.finished_at = now
      const up = Object.keys(patch).length ? await pgUpdate('cleaning_tasks', id, patch) : task
      await emitWorkTaskEvent({
        taskId: `cleaning_task:${String(id)}`,
        sourceType: 'cleaning_tasks',
        sourceRefIds: [String(id)],
        eventType: needsRestock ? 'TASK_UPDATED' : 'TASK_COMPLETED',
        changeScope: Object.keys(patch).length ? 'list' : 'detail',
        changedFields: Array.from(new Set([...Object.keys(patch), 'restock_items'])),
        patch: { ...patch, restock_items_updated: true },
        causedByUserId: String(user?.sub || '').trim() || null,
        visibilityHints: buildCleaningTaskVisibilityHints(up || task),
      })
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
        if (propertyId) {
          await emitNotificationEvent(
            {
              type: hadExisting ? 'CLEANING_TASK_UPDATED' : 'CLEANING_COMPLETED',
              entity: 'cleaning_task',
              entityId: String(id),
              propertyId,
              updatedAt: String(now),
              title: propertyCode ? `${hadExisting ? '补品已更新' : '清洁完成'}：${propertyCode}` : (hadExisting ? '补品已更新' : '清洁完成'),
              body: hadExisting ? '清洁补品记录已修改，请检查更新' : (needsRestock ? '清洁已完成，待补货' : '清洁已完成，待检查'),
              data: { entity: 'cleaning_task', entityId: String(id), action: 'open_task', kind: hadExisting ? 'consumables_updated' : 'consumables_submitted', task_id: id, restock_pending: needsRestock, property_code: propertyCode },
              actorUserId: String(user?.sub || ''),
            },
            { operationId },
          )
        }
      } catch {}
      return res.json(up || patch)
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
        if (propertyId) {
          await emitNotificationEvent(
            {
              type: 'INSPECTION_COMPLETED',
              entity: 'cleaning_task',
              entityId: String(id),
              propertyId,
              updatedAt: now,
              title: '检查已完成',
              body: '检查员已提交挂钥匙视频并标记完成',
              data: { entity: 'cleaning_task', entityId: String(id), action: 'open_task', kind: 'inspection_complete', task_id: id },
              actorUserId: String(user?.sub || ''),
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
      submitted_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, date)
    );`)
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
      const batchId = uuid.v4()
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
              title: '检查照片已提交',
              body: '检查员已上传检查照片',
              data: { entity: 'cleaning_task', entityId: String(id), action: 'open_task', kind: 'inspection_photos_saved', task_id: id, batch_id: batchId },
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

const completionPhotosSchema = z
  .object({
    items: z.array(
      z.object({
        area: z.enum(['toilet', 'living', 'sofa', 'bedroom', 'kitchen', 'shower_drain']),
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
    const limits: Record<string, number> = { toilet: 9, living: 3, sofa: 2, bedroom: 8, kitchen: 2, shower_drain: 1 }
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
        if (propertyId) {
          await emitNotificationEvent(
            {
              type: 'CLEANING_TASK_UPDATED',
              entity: 'cleaning_task',
              entityId: String(id),
              propertyId,
              updatedAt: now,
              title: '挂钥匙视频已上传',
              body: '清洁员已上传挂钥匙视频',
              data: { entity: 'cleaning_task', entityId: String(id), action: 'open_task', kind: 'lockbox_video_uploaded', task_id: id },
              actorUserId: String(user?.sub || ''),
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
        `SELECT id::text AS id, COALESCE(status,'') AS status, finished_at, lockbox_video_uploaded_at
         FROM cleaning_tasks
         WHERE id::text=$1
         LIMIT 1`,
        [String(id)],
      )
      const task = rTask?.rows?.[0] || null
      if (!task) return res.status(404).json({ message: 'task not found' })
      const st0 = String(task.status || '').trim().toLowerCase()
      if (st0 === 'cancelled' || st0 === 'canceled') return res.status(400).json({ message: 'task is cancelled' })

      const rLock = await pgPool.query(
        `SELECT 1 FROM cleaning_task_media WHERE task_id=$1 AND type='lockbox_video' LIMIT 1`,
        [String(id)],
      )
      const hasLock = !!rLock?.rowCount || !!task.lockbox_video_uploaded_at
      if (!hasLock) return res.status(400).json({ message: '缺少挂钥匙视频' })

      const rComp = await pgPool.query(
        `SELECT type FROM cleaning_task_media WHERE task_id=$1 AND type LIKE 'completion_%'`,
        [String(id)],
      )
      const requiredAreas = ['toilet', 'living', 'sofa', 'bedroom', 'kitchen', 'shower_drain']
      const got = new Set<string>()
      for (const row of rComp?.rows || []) {
        const type = String(row.type || '')
        const a = type.startsWith('completion_') ? type.slice('completion_'.length) : type
        if (a) got.add(a)
      }
      const missingAreas = requiredAreas.filter((a) => !got.has(a))
      if (missingAreas.length) return res.status(400).json({ message: '房间完成照片未齐', missing_areas: missingAreas })

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
      const needsRestock = !!rNeed?.rowCount

      const now = new Date().toISOString()
      const patch: any = {}
      if (st0 !== 'restocked' && st0 !== 'ready') patch.status = needsRestock ? 'restock_pending' : 'cleaned'
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
                title: '任务已完成',
                body: '清洁员已标记任务完成',
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
      const items = (r?.rows || []).map((x: any) => {
        const type = String(x.type || '')
        const itemId = type.includes(':') ? type.split(':').slice(1).join(':') : type
        let meta: any = null
        try {
          const raw = String(x.note || '').trim()
          meta = raw && (raw.startsWith('{') || raw.startsWith('[')) ? JSON.parse(raw) : null
        } catch {}
        return {
          item_id: itemId,
          proof_url: (() => {
            const u = String(x.url || '').trim()
            return u && /^https?:\/\//i.test(u) ? u : null
          })(),
          status: meta?.status == null ? null : String(meta.status || ''),
          qty: meta?.qty == null ? null : Number(meta.qty),
          note: meta?.note == null ? null : String(meta.note || ''),
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
        const url = String(it.proof_url || '').trim()
        await pgPool.query(
          `INSERT INTO cleaning_task_media (id, task_id, type, url, note, captured_at)
           VALUES ($1,$2,$3,$4,$5,now())`,
          [uuid.v4(), id, `restock_proof:${it.item_id}`, url || 'no_photo', JSON.stringify(meta)],
        )
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
    key_photos: z.array(z.object({ url: z.string().trim().min(1).max(800), captured_at: z.string().trim().max(64).optional() })).max(30).default([]),
    dirty_linen_photos: z.array(z.object({ url: z.string().trim().min(1).max(800), captured_at: z.string().trim().max(64).optional() })).max(30).default([]),
    return_wash_photos: z.array(z.object({ url: z.string().trim().min(1).max(800), captured_at: z.string().trim().max(64).optional() })).max(30).default([]),
    consumable_photos: z.array(z.object({ url: z.string().trim().min(1).max(800), captured_at: z.string().trim().max(64).optional() })).max(30).default([]),
    reject_items: z.array(z.object({
      linen_type: z.string().trim().min(1).max(80),
      quantity: z.coerce.number().int().min(1).max(999),
      used_room: z.string().trim().min(1).max(80),
      photos: z.array(z.object({ url: z.string().trim().min(1).max(800), captured_at: z.string().trim().max(64).optional() })).min(1).max(10),
    })).max(30).default([]),
    no_dirty_linen: z.boolean().optional(),
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
    if (!hasPg) return res.json({ key_photos: [], dirty_linen_photos: [], return_wash_photos: [], consumable_photos: [], reject_items: [], no_dirty_linen: false, submitted_at: null, updated_at: null })
    const { pgPool } = require('../dbAdapter')
    if (!pgPool) return res.json({ key_photos: [], dirty_linen_photos: [], return_wash_photos: [], consumable_photos: [], reject_items: [], no_dirty_linen: false, submitted_at: null, updated_at: null })
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
           AND kind IN ('backup_key_return', 'dirty_linen_return', 'return_wash_linen', 'remaining_consumables')
         ORDER BY created_at ASC`,
        [userId, date ? date : null],
      ),
      pgPool.query(
        `SELECT no_dirty_linen, submitted_at, updated_at
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
    return res.json({
      key_photos,
      dirty_linen_photos: return_wash_photos,
      return_wash_photos,
      consumable_photos,
      reject_items,
      no_dirty_linen: !!statusRow?.no_dirty_linen,
      submitted_at: statusRow?.submitted_at ? String(statusRow.submitted_at) : null,
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
    const keyPhotos = Array.isArray(parsed.data.key_photos) ? parsed.data.key_photos : []
    const returnWashPhotos = Array.isArray(parsed.data.return_wash_photos) && parsed.data.return_wash_photos.length
      ? parsed.data.return_wash_photos
      : (Array.isArray(parsed.data.dirty_linen_photos) ? parsed.data.dirty_linen_photos : [])
    const consumablePhotos = Array.isArray(parsed.data.consumable_photos) ? parsed.data.consumable_photos : []
    const rejectItems = Array.isArray(parsed.data.reject_items) ? parsed.data.reject_items : []
    const noDirtyLinen = !!parsed.data.no_dirty_linen
    const inspectorOnlyDayEnd = isInspectorOnlyDayEndUser(user)
    if (inspectorOnlyDayEnd) {
      if (!consumablePhotos.length) return res.status(400).json({ message: '请上传剩余消耗品照片' })
    } else {
      if (!keyPhotos.length) return res.status(400).json({ message: '请先上传备用钥匙照片' })
      if (!returnWashPhotos.length && !noDirtyLinen) return res.status(400).json({ message: '请上传退洗床品照片' })
    }

    const client = await pgPool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `DELETE FROM cleaning_day_end_media
         WHERE user_id = $1::text
           AND date = $2::date
           AND kind IN ('backup_key_return', 'dirty_linen_return', 'return_wash_linen', 'remaining_consumables')`,
        [userId, date],
      )
      await client.query(
        `DELETE FROM cleaning_day_end_reject_items
         WHERE user_id = $1::text
           AND date = $2::date`,
        [userId, date],
      )
      for (const it of keyPhotos) {
        const cap = String(it.captured_at || '').trim()
        const capturedAt = cap ? new Date(cap) : null
        await client.query(
          `INSERT INTO cleaning_day_end_media (id, user_id, date, kind, url, captured_at)
           VALUES ($1,$2,$3,'backup_key_return',$4,$5)`,
          [uuid.v4(), userId, date, String(it.url), capturedAt ? capturedAt.toISOString() : null],
        )
      }
      for (const it of returnWashPhotos) {
        const cap = String(it.captured_at || '').trim()
        const capturedAt = cap ? new Date(cap) : null
        await client.query(
          `INSERT INTO cleaning_day_end_media (id, user_id, date, kind, url, captured_at)
           VALUES ($1,$2,$3,'return_wash_linen',$4,$5)`,
          [uuid.v4(), userId, date, String(it.url), capturedAt ? capturedAt.toISOString() : null],
        )
      }
      for (const it of consumablePhotos) {
        const cap = String(it.captured_at || '').trim()
        const capturedAt = cap ? new Date(cap) : null
        await client.query(
          `INSERT INTO cleaning_day_end_media (id, user_id, date, kind, url, captured_at)
           VALUES ($1,$2,$3,'remaining_consumables',$4,$5)`,
          [uuid.v4(), userId, date, String(it.url), capturedAt ? capturedAt.toISOString() : null],
        )
      }
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
      await client.query(
        `INSERT INTO cleaning_day_end_handover (user_id, date, no_dirty_linen, submitted_at, updated_at)
         VALUES ($1,$2,$3,now(),now())
         ON CONFLICT (user_id, date)
         DO UPDATE SET no_dirty_linen = EXCLUDED.no_dirty_linen, submitted_at = now(), updated_at = now()`,
        [userId, date, noDirtyLinen],
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
    } catch {}
    try {
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
          body: `${actorName} 已提交 ${date} 的日终交接，可进入查看内容。`,
          recipientUserIds: managerIds,
          priority: 'medium',
          data: {
            kind: 'day_end_handover_submitted',
            action: 'open_day_end_handover',
            date,
            target_user_id: actorId,
            target_user_name: actorName,
            handover_status: 'submitted',
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
