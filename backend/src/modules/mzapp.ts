import { Router } from 'express'
import { z } from 'zod'
import { hasPg, pgPool } from '../dbAdapter'
import multer from 'multer'
import path from 'path'
import { hasR2, r2Upload } from '../r2'
import crypto from 'crypto'

export const router = Router()

const upload = hasR2 ? multer({ storage: multer.memoryStorage() }) : multer({ dest: path.join(process.cwd(), 'uploads') })

function dayOnly(v: any): string | null {
  const s = String(v ?? '').slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null
}

function normStatus(v: any): string {
  const s = String(v ?? '').trim().toLowerCase()
  if (s === 'done' || s === 'completed') return 'done'
  if (s === 'cancelled' || s === 'canceled') return 'cancelled'
  if (s === 'in_progress') return 'in_progress'
  if (s === 'assigned') return 'assigned'
  return 'todo'
}

function normUrgency(v: any): string {
  const s = String(v ?? '').trim().toLowerCase()
  if (s === 'low' || s === 'medium' || s === 'high' || s === 'urgent') return s
  return 'medium'
}

function randomBase62(len = 4) {
  const chars = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
  let out = ''
  for (let i = 0; i < len; i++) {
    out += chars[crypto.randomInt(0, chars.length)]
  }
  return out
}

function makeWorkNo(prefix: string, occurredAt?: string) {
  const day = String(occurredAt || '').slice(0, 10)
  const ymd = /^\d{4}-\d{2}-\d{2}$/.test(day)
    ? day.replace(/-/g, '')
    : (() => {
        const d = new Date()
        const pad2 = (n: number) => String(n).padStart(2, '0')
        return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`
      })()
  return `${String(prefix || 'R').trim()}-${ymd}-${randomBase62(4)}`
}

function roleNamesOf(user: any) {
  const arr = Array.isArray(user?.roles) ? (user.roles as any[]) : []
  const ids = arr.map((x) => String(x || '').trim()).filter(Boolean)
  const primary = String(user?.role || '').trim()
  if (primary) ids.unshift(primary)
  return Array.from(new Set(ids))
}

function hasRole(user: any, roleName: string) {
  const rn = String(roleName || '').trim()
  if (!rn) return false
  return roleNamesOf(user).includes(rn)
}

function canViewAll(user: any) {
  return hasRole(user, 'admin') || hasRole(user, 'offline_manager') || hasRole(user, 'customer_service')
}

function isCleanerRole(user: any) {
  return hasRole(user, 'cleaner')
}

function isInspectorRole(user: any) {
  return hasRole(user, 'cleaning_inspector')
}

function isCleanerInspectorRole(user: any) {
  return hasRole(user, 'cleaner_inspector')
}

function mapCleaningTaskStatus(v: any): string {
  const s = String(v ?? '').trim().toLowerCase()
  if (!s) return 'todo'
  if (s === 'cancelled' || s === 'canceled') return 'cancelled'
  if (s === 'done' || s === 'completed' || s === 'cleaned' || s === 'restocked' || s === 'inspected' || s === 'ready') return 'done'
  if (s === 'in_progress' || s === 'cleaning') return 'in_progress'
  if (s === 'assigned' || s === 'scheduled') return 'assigned'
  return 'todo'
}

function summaryFromCleaningTimes(checkoutTime: any, checkinTime: any) {
  const out: string[] = []
  const co = String(checkoutTime || '').trim()
  const ci = String(checkinTime || '').trim()
  if (co) out.push(`${co}退房`)
  if (ci) out.push(`${ci}入住`)
  return out.join(' ')
}

function cleaningType(taskType: any): 'checkout' | 'checkin' | 'stayover' | 'other' {
  const s = String(taskType || '').trim().toLowerCase()
  if (s === 'checkout_clean') return 'checkout'
  if (s === 'checkin_clean') return 'checkin'
  if (s === 'stayover_clean') return 'stayover'
  return 'other'
}

function parseYmd(s0: any) {
  const s = String(s0 || '').trim().slice(0, 10)
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null
  return { y, m: mo, d }
}

function daysBetweenYmd(a0: any, b0: any) {
  const a = parseYmd(a0)
  const b = parseYmd(b0)
  if (!a || !b) return null
  const ta = Date.UTC(a.y, a.m - 1, a.d, 12, 0, 0)
  const tb = Date.UTC(b.y, b.m - 1, b.d, 12, 0, 0)
  return Math.round((tb - ta) / 86400000)
}

function clampInt(n0: any, min: number, max: number) {
  const n = Number(n0)
  if (!Number.isFinite(n)) return null
  const v = Math.max(min, Math.min(max, Math.trunc(n)))
  return v
}

function computeStayedRemaining(params: { checkin: any; checkout: any; taskDate: any; nightsTotal: any }) {
  const total0 = params.nightsTotal == null ? daysBetweenYmd(params.checkin, params.checkout) : Number(params.nightsTotal)
  if (!Number.isFinite(total0 as any)) return { stayed: null as number | null, remaining: null as number | null }
  const total = Math.max(0, Math.trunc(total0 as any))
  const stayed0 = daysBetweenYmd(params.checkin, params.taskDate)
  const stayed = stayed0 == null ? null : clampInt(stayed0, 0, total)
  const remaining = stayed == null ? null : Math.max(0, total - stayed)
  return { stayed, remaining }
}

function firstNonEmpty(...vals: any[]) {
  for (const v of vals) {
    const s = String(v ?? '').trim()
    if (s) return s
  }
  return null
}

function normalizeTimeOrDefault(v: any, fallback: string) {
  const s = String(v ?? '').trim()
  return s || fallback
}

async function ensureWorkTasksTable() {
  if (!hasPg || !pgPool) return
  await pgPool.query(`CREATE TABLE IF NOT EXISTS work_tasks (
    id text PRIMARY KEY,
    task_kind text NOT NULL,
    source_type text NOT NULL,
    source_id text NOT NULL,
    property_id text,
    title text NOT NULL DEFAULT '',
    summary text,
    scheduled_date date,
    start_time text,
    end_time text,
    assignee_id text,
    status text NOT NULL DEFAULT 'todo',
    urgency text NOT NULL DEFAULT 'medium',
    created_by text,
    updated_by text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );`)
  await pgPool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_work_tasks_source ON work_tasks(source_type, source_id);`)
  await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_work_tasks_day_assignee ON work_tasks(scheduled_date, assignee_id, status);`)
  await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_work_tasks_kind_day ON work_tasks(task_kind, scheduled_date);`)
  await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_work_tasks_day ON work_tasks(scheduled_date);`)
}

async function ensureMzappAlertsTable() {
  if (!hasPg || !pgPool) return
  await pgPool.query(`CREATE TABLE IF NOT EXISTS mzapp_alerts (
    id text PRIMARY KEY,
    kind text NOT NULL,
    target_user_id text NOT NULL,
    level text NOT NULL,
    date date,
    position integer,
    payload jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    read_at timestamptz
  );`)
  await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_mzapp_alerts_target_unread ON mzapp_alerts(target_user_id, read_at, created_at);`)
  await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_mzapp_alerts_kind ON mzapp_alerts(kind);`)
  await pgPool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_mzapp_alerts_dedupe ON mzapp_alerts(kind, target_user_id, date, position, level);`)
}

router.get('/alerts', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  const uid = String(user.sub || '').trim()
  if (!uid) return res.status(401).json({ message: 'unauthorized' })
  try {
    if (!hasPg || !pgPool) return res.json([])
    await ensureMzappAlertsTable()
    const unread = String((req.query as any)?.unread || '0').trim() === '1'
    const kind = String((req.query as any)?.kind || '').trim()
    const limit0 = Number((req.query as any)?.limit || 50)
    const limit = Number.isFinite(limit0) ? Math.max(1, Math.min(200, limit0)) : 50
    const where: string[] = ['target_user_id=$1']
    const vals: any[] = [uid]
    if (unread) where.push('read_at IS NULL')
    if (kind) {
      vals.push(kind)
      where.push(`kind=$${vals.length}`)
    }
    vals.push(limit)
    const sql = `SELECT id, kind, level, date::text AS date, position, payload, created_at::text AS created_at, read_at::text AS read_at
                 FROM mzapp_alerts
                 WHERE ${where.join(' AND ')}
                 ORDER BY created_at DESC
                 LIMIT $${vals.length}`
    const r = await pgPool.query(sql, vals)
    return res.json(r?.rows || [])
  } catch (e: any) {
    return res.status(500).json({ message: String(e?.message || 'alerts_failed') })
  }
})

router.post('/alerts/:id/read', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  const uid = String(user.sub || '').trim()
  if (!uid) return res.status(401).json({ message: 'unauthorized' })
  const id = String(req.params.id || '').trim()
  if (!id) return res.status(400).json({ message: 'missing id' })
  try {
    if (!hasPg || !pgPool) return res.json({ ok: true })
    await ensureMzappAlertsTable()
    await pgPool.query('UPDATE mzapp_alerts SET read_at=now() WHERE id=$1 AND target_user_id=$2', [id, uid])
    return res.json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: String(e?.message || 'alerts_read_failed') })
  }
})

let mediaEnsured = false
let mediaEnsuring: Promise<void> | null = null

async function ensureCleaningTaskMediaTable() {
  if (!hasPg || !pgPool) return
  if (mediaEnsured) return
  if (mediaEnsuring) return mediaEnsuring
  mediaEnsuring = (async () => {
    try {
      await pgPool.query(`CREATE TABLE IF NOT EXISTS cleaning_task_media (
        id text PRIMARY KEY,
        task_id text REFERENCES cleaning_tasks(id) ON DELETE CASCADE,
        type text,
        url text NOT NULL,
        note text,
        captured_at timestamptz,
        lat numeric,
        lng numeric,
        uploader_id text,
        size integer,
        mime text,
        created_at timestamptz DEFAULT now()
      );`)
      await pgPool.query(`ALTER TABLE cleaning_task_media ADD COLUMN IF NOT EXISTS note text;`)
      await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_cleaning_task_media_task ON cleaning_task_media(task_id);`)
      await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_cleaning_task_media_type ON cleaning_task_media(type);`)
      await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_cleaning_task_media_task_type ON cleaning_task_media(task_id, type);`)
    } finally {
      mediaEnsured = true
    }
  })()
    .catch(() => {})
    .finally(() => {
      mediaEnsuring = null
    })
  return mediaEnsuring
}

let checkoutEnsured = false
let checkoutEnsuring: Promise<void> | null = null

async function ensureCleaningCheckoutColumns() {
  if (!hasPg || !pgPool) return
  if (checkoutEnsured) return
  if (checkoutEnsuring) return checkoutEnsuring
  checkoutEnsuring = (async () => {
    try {
      await pgPool.query(`ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS checked_out_at timestamptz;`)
      await pgPool.query(`ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS checkout_marked_by text;`)
    } finally {
      checkoutEnsured = true
    }
  })()
    .catch(() => {})
    .finally(() => {
      checkoutEnsuring = null
    })
  return checkoutEnsuring
}

let cleaningCustomerEnsured = false
let cleaningCustomerEnsuring: Promise<void> | null = null

async function ensureCleaningCustomerColumns() {
  if (!hasPg || !pgPool) return
  if (cleaningCustomerEnsured) return
  if (cleaningCustomerEnsuring) return cleaningCustomerEnsuring
  cleaningCustomerEnsuring = (async () => {
    try {
      await pgPool.query(`ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS guest_special_request text;`)
      await pgPool.query(`ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS keys_required integer NOT NULL DEFAULT 1;`)
    } finally {
      cleaningCustomerEnsured = true
    }
  })()
    .catch(() => {})
    .finally(() => {
      cleaningCustomerEnsuring = null
    })
  return cleaningCustomerEnsuring
}

let checklistEnsured = false
let checklistEnsuring: Promise<void> | null = null

async function ensureCleaningChecklistTables() {
  if (!hasPg || !pgPool) return
  if (checklistEnsured) return
  if (checklistEnsuring) return checklistEnsuring
  checklistEnsuring = (async () => {
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
      await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_cleaning_checklist_active_sort ON cleaning_checklist_items (active, sort_order, created_at);`)
      await pgPool.query(`ALTER TABLE cleaning_consumable_usages ADD COLUMN IF NOT EXISTS status text;`)
      await pgPool.query(`ALTER TABLE cleaning_consumable_usages ADD COLUMN IF NOT EXISTS photo_url text;`)
      await pgPool.query(`ALTER TABLE cleaning_consumable_usages ADD COLUMN IF NOT EXISTS item_label text;`)
      await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_cleaning_consumables_status ON cleaning_consumable_usages (status);`)
      await pgPool.query(
        `INSERT INTO cleaning_checklist_items (id, label, kind, required, requires_photo_when_low, active, sort_order)
         VALUES
          ('toilet_paper','卷纸','consumable',true,true,true,10),
          ('facial_tissue','抽纸','consumable',true,true,true,20),
          ('shampoo','洗发水','consumable',true,true,true,30),
          ('conditioner','护发素','consumable',true,true,true,40),
          ('body_wash','沐浴露','consumable',true,true,true,50),
          ('hand_soap','洗手液','consumable',true,true,true,60),
          ('dish_sponge','洗碗海绵','consumable',true,true,true,70),
          ('dish_soap','洗碗皂','consumable',true,true,true,80),
          ('tea_bags','茶包','consumable',true,true,true,90),
          ('coffee','咖啡','consumable',true,true,true,100),
          ('sugar_sticks','条装糖','consumable',true,true,true,110),
          ('bin_bags_large','大垃圾袋（有大垃圾桶才需要）','consumable',true,true,true,120),
          ('bin_bags_small','小垃圾袋','consumable',true,true,true,130),
          ('dish_detergent','洗洁精','consumable',true,true,true,140),
          ('laundry_powder','洗衣粉','consumable',true,true,true,150),
          ('cooking_oil','食用油','consumable',true,true,true,160),
          ('salt_sugar','盐糖','consumable',true,true,true,170),
          ('pepper','花椒（替换旧的花椒瓶带走）','consumable',true,true,true,180),
          ('toilet_cleaner','洁厕灵','consumable',true,true,true,190),
          ('bleach','漂白水（房间里用空的瓶子不要扔掉）','consumable',true,true,true,200),
          ('spare_pillowcase','备用枕套','consumable',true,true,true,210),
          ('other','其他','consumable',false,true,true,900)
         ON CONFLICT (id) DO NOTHING`,
      )
    } finally {
      checklistEnsured = true
    }
  })()
    .catch(() => {})
    .finally(() => {
      checklistEnsuring = null
    })
  return checklistEnsuring
}

let cleaningSortEnsured = false
let cleaningSortEnsuring: Promise<void> | null = null

async function ensureCleaningTaskSortColumns() {
  if (!hasPg || !pgPool) return
  if (cleaningSortEnsured) return
  if (cleaningSortEnsuring) return cleaningSortEnsuring
  cleaningSortEnsuring = (async () => {
    try {
      const r = await pgPool.query(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'cleaning_tasks'
           AND column_name = ANY($1::text[])`,
        [['sort_index_cleaner', 'sort_index_inspector']],
      )
      const have = new Set((r?.rows || []).map((x: any) => String(x.column_name || '')))
      if (!have.has('sort_index_cleaner')) {
        await pgPool.query(`ALTER TABLE IF EXISTS cleaning_tasks ADD COLUMN IF NOT EXISTS sort_index_cleaner integer;`)
      }
      if (!have.has('sort_index_inspector')) {
        await pgPool.query(`ALTER TABLE IF EXISTS cleaning_tasks ADD COLUMN IF NOT EXISTS sort_index_inspector integer;`)
      }
    } finally {
      cleaningSortEnsured = true
    }
  })()
    .catch(() => {})
    .finally(() => {
      cleaningSortEnsuring = null
    })
  return cleaningSortEnsuring
}

router.post('/cleaning-tasks/reorder', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  const userId = String(user.sub || '')
  const kind = String(req.body?.kind || '').trim().toLowerCase()
  const date = dayOnly(req.body?.date)
  const groups = Array.isArray(req.body?.groups) ? req.body.groups : null
  if (!date) return res.status(400).json({ message: 'invalid date' })
  if (kind !== 'cleaner' && kind !== 'inspector') return res.status(400).json({ message: 'invalid kind' })
  if (!groups || !groups.length) return res.status(400).json({ message: 'groups required' })

  if (kind === 'cleaner') {
    if (!(isCleanerRole(user) || isCleanerInspectorRole(user))) return res.status(403).json({ message: 'forbidden' })
  } else {
    if (!(isInspectorRole(user) || isCleanerInspectorRole(user))) return res.status(403).json({ message: 'forbidden' })
  }

  try {
    if (!hasPg || !pgPool) return res.json({ ok: false })
    await ensureCleaningTaskSortColumns()

    let idx = 1
    let updated = 0
    for (const g of groups as any[]) {
      if (!Array.isArray(g)) continue
      const ids = Array.from(new Set(g.map((x: any) => String(x || '').trim()).filter(Boolean)))
      if (!ids.length) continue
      if (kind === 'cleaner') {
        const sql = `
          UPDATE cleaning_tasks
          SET sort_index_cleaner = $1, updated_at = now()
          WHERE id = ANY($2::text[])
            AND COALESCE(task_date, date)::date = $3::date
            AND COALESCE(cleaner_id::text, assignee_id::text) = $4::text
        `
        const r = await pgPool.query(sql, [idx, ids, date, userId])
        updated += r?.rowCount || 0
      } else {
        const sql = `
          UPDATE cleaning_tasks
          SET sort_index_inspector = $1, updated_at = now()
          WHERE id = ANY($2::text[])
            AND COALESCE(task_date, date)::date = $3::date
            AND inspector_id::text = $4::text
        `
        const r = await pgPool.query(sql, [idx, ids, date, userId])
        updated += r?.rowCount || 0
      }
      idx++
    }
    return res.json({ ok: true, updated })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'reorder_failed' })
  }
})

router.post('/cleaning-tasks/:id/lockbox-video', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  const userId = String(user.sub || '')
  const id = String(req.params.id || '').trim()
  const mediaUrl = String(req.body?.media_url || '').trim()
  if (!id) return res.status(400).json({ message: 'missing id' })
  if (!mediaUrl) return res.status(400).json({ message: 'missing media_url' })
  if (!(isInspectorRole(user) || isCleanerInspectorRole(user) || canViewAll(user))) return res.status(403).json({ message: 'forbidden' })
  if (!hasPg || !pgPool) return res.status(500).json({ message: 'pg not available' })
  try {
    await ensureCleaningTaskMediaTable()
    const r0 = await pgPool.query('SELECT id, inspector_id, property_id::text AS property_id FROM cleaning_tasks WHERE id=$1 LIMIT 1', [id])
    const row = r0?.rows?.[0] || null
    if (!row) return res.status(404).json({ message: 'not found' })
    const inspectorId = row.inspector_id ? String(row.inspector_id) : ''
    const propertyId = row.property_id ? String(row.property_id) : ''
    if (!canViewAll(user) && inspectorId !== userId) return res.status(403).json({ message: 'forbidden' })

    const uuid = require('uuid')
    const mediaId = uuid.v4()
    await pgPool.query(
      `INSERT INTO cleaning_task_media (id, task_id, type, url, captured_at, uploader_id)
       VALUES ($1,$2,'lockbox_video',$3,now(),$4)`,
      [mediaId, id, mediaUrl, userId],
    )
    await pgPool.query(
      `UPDATE cleaning_tasks
       SET status = 'inspected', lockbox_video_uploaded_at = now(), updated_at = now()
       WHERE id = $1`,
      [id],
    )
    try {
      const { broadcastCleaningEvent } = require('./events')
      broadcastCleaningEvent({ event: 'lockbox_video_uploaded', task_id: id })
    } catch {}
    try {
      const { listCleaningTaskUserIds, listManagerUserIds, excludeUserIds } = require('./notifications')
      const { emitNotificationEvent } = require('../services/notificationEvents')
      const operationId = require('uuid').v4()
      const taskUsers = excludeUserIds(await listCleaningTaskUserIds(id), userId)
      const managerUsers = await listManagerUserIds()
      const to = Array.from(new Set([...taskUsers, ...managerUsers]))
      if (propertyId && to.length) {
        await emitNotificationEvent(
          {
            type: 'INSPECTION_COMPLETED',
            entity: 'cleaning_task',
            entityId: String(id),
            propertyId,
            updatedAt: new Date().toISOString(),
            title: '挂钥匙视频已上传',
            body: '检查员已上传挂钥匙视频',
            data: { entity: 'cleaning_task', entityId: String(id), action: 'open_task', kind: 'lockbox_video_uploaded', task_id: id, media_id: mediaId },
            actorUserId: userId,
            recipientUserIds: to,
          },
          { operationId },
        )
      }
    } catch {}
    return res.status(201).json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'lockbox_video_failed' })
  }
})

const inspectionPhotosSchema = z
  .object({
    items: z.array(
      z.object({
        area: z.enum(['toilet', 'living', 'sofa', 'bedroom', 'kitchen', 'unclean']),
        url: z.string().trim().min(1).max(800),
        note: z.string().trim().max(800).optional().nullable(),
        captured_at: z.string().trim().max(64).optional(),
      }),
    ),
  })
  .strict()

router.get('/cleaning-tasks/:id/inspection-photos', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  const userId = String(user.sub || '')
  const id = String(req.params.id || '').trim()
  if (!id) return res.status(400).json({ message: 'missing id' })
  if (!(isInspectorRole(user) || isCleanerInspectorRole(user) || canViewAll(user))) return res.status(403).json({ message: 'forbidden' })
  if (!hasPg || !pgPool) return res.status(500).json({ message: 'pg not available' })
  try {
    await ensureCleaningTaskMediaTable()
    const r0 = await pgPool.query('SELECT id, inspector_id, cleaner_id, assignee_id FROM cleaning_tasks WHERE id=$1 LIMIT 1', [id])
    const row = r0?.rows?.[0] || null
    if (!row) return res.status(404).json({ message: 'not found' })
    const inspectorId = row.inspector_id ? String(row.inspector_id) : ''
    const cleanerId = row.cleaner_id ? String(row.cleaner_id) : ''
    const assigneeId = row.assignee_id ? String(row.assignee_id) : ''
    if (!canViewAll(user) && inspectorId !== userId && cleanerId !== userId && assigneeId !== userId) return res.status(403).json({ message: 'forbidden' })

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
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'inspection_photos_failed' })
  }
})

router.post('/cleaning-tasks/:id/inspection-photos', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  const userId = String(user.sub || '')
  const id = String(req.params.id || '').trim()
  if (!id) return res.status(400).json({ message: 'missing id' })
  if (!(isInspectorRole(user) || isCleanerInspectorRole(user) || canViewAll(user))) return res.status(403).json({ message: 'forbidden' })
  const parsed = inspectionPhotosSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  if (!hasPg || !pgPool) return res.status(500).json({ message: 'pg not available' })
  try {
    await ensureCleaningTaskMediaTable()
    const r0 = await pgPool.query('SELECT id, inspector_id, cleaner_id, assignee_id FROM cleaning_tasks WHERE id=$1 LIMIT 1', [id])
    const row = r0?.rows?.[0] || null
    if (!row) return res.status(404).json({ message: 'not found' })
    const inspectorId = row.inspector_id ? String(row.inspector_id) : ''
    const cleanerId = row.cleaner_id ? String(row.cleaner_id) : ''
    const assigneeId = row.assignee_id ? String(row.assignee_id) : ''
    if (!canViewAll(user) && inspectorId !== userId && cleanerId !== userId && assigneeId !== userId) return res.status(403).json({ message: 'forbidden' })

    const limits: Record<string, number> = { toilet: 9, living: 3, sofa: 2, bedroom: 8, kitchen: 2, unclean: 12 }
    const byArea = new Map<string, number>()
    for (const it of parsed.data.items) {
      const a = String(it.area)
      byArea.set(a, (byArea.get(a) || 0) + 1)
      const lim = limits[a] ?? 1
      if ((byArea.get(a) || 0) > lim) return res.status(400).json({ message: '超出数量限制', area: a, limit: lim })
    }

    await pgPool.query(`DELETE FROM cleaning_task_media WHERE task_id=$1 AND type LIKE 'inspection_%'`, [id])
    const uuid = require('uuid')
    const batchId = uuid.v4()
    for (const it of parsed.data.items) {
      const type = `inspection_${it.area}`
      const cap = String(it.captured_at || '').trim()
      const capturedAt = cap ? new Date(cap) : new Date()
      await pgPool.query(
        `INSERT INTO cleaning_task_media (id, task_id, type, url, note, captured_at, uploader_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [uuid.v4(), id, type, String(it.url), it.note == null ? null : String(it.note || ''), capturedAt.toISOString(), userId],
      )
    }
    try {
      const { broadcastCleaningEvent } = require('./events')
      broadcastCleaningEvent({ event: 'inspection_photos_saved', task_id: id })
    } catch {}
    try {
      const { listCleaningTaskUserIds, listManagerUserIds, excludeUserIds } = require('./notifications')
      const { emitNotificationEvent } = require('../services/notificationEvents')
      const operationId = require('uuid').v4()
      const taskUsers = excludeUserIds(await listCleaningTaskUserIds(id), userId)
      const managerUsers = await listManagerUserIds()
      const to = Array.from(new Set([...taskUsers, ...managerUsers]))
      let propertyId = ''
      try {
        const r2 = await pgPool.query(`SELECT property_id::text AS property_id FROM cleaning_tasks WHERE id::text=$1::text LIMIT 1`, [String(id)])
        propertyId = String(r2?.rows?.[0]?.property_id || '').trim()
      } catch {}
      if (propertyId && to.length) {
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
            actorUserId: userId,
            recipientUserIds: to,
          },
          { operationId },
        )
      }
    } catch {}
    return res.status(201).json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'inspection_photos_failed' })
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
        proof_url: z.string().trim().min(1).max(800).optional().nullable(),
      }),
    ),
  })
  .strict()

router.get('/cleaning-tasks/:id/restock-proof', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  const userId = String(user.sub || '')
  const id = String(req.params.id || '').trim()
  if (!id) return res.status(400).json({ message: 'missing id' })
  if (!(isInspectorRole(user) || isCleanerInspectorRole(user) || canViewAll(user))) return res.status(403).json({ message: 'forbidden' })
  if (!hasPg || !pgPool) return res.status(500).json({ message: 'pg not available' })
  try {
    await ensureCleaningTaskMediaTable()
    const r0 = await pgPool.query('SELECT id, inspector_id, cleaner_id, assignee_id FROM cleaning_tasks WHERE id=$1 LIMIT 1', [id])
    const row = r0?.rows?.[0] || null
    if (!row) return res.status(404).json({ message: 'not found' })
    const inspectorId = row.inspector_id ? String(row.inspector_id) : ''
    const cleanerId = row.cleaner_id ? String(row.cleaner_id) : ''
    const assigneeId = row.assignee_id ? String(row.assignee_id) : ''
    if (!canViewAll(user) && inspectorId !== userId && cleanerId !== userId && assigneeId !== userId) return res.status(403).json({ message: 'forbidden' })

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
        status: String(meta?.status || ''),
        qty: meta?.qty == null ? null : Number(meta.qty),
        note: meta?.note == null ? null : String(meta.note || ''),
        created_at: x.created_at ? String(x.created_at) : null,
      }
    })
    return res.json({ items })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'restock_proof_failed' })
  }
})

router.post('/cleaning-tasks/:id/restock-proof', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  const userId = String(user.sub || '')
  const id = String(req.params.id || '').trim()
  if (!id) return res.status(400).json({ message: 'missing id' })
  if (!(isInspectorRole(user) || isCleanerInspectorRole(user) || canViewAll(user))) return res.status(403).json({ message: 'forbidden' })
  const parsed = restockProofSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  if (!hasPg || !pgPool) return res.status(500).json({ message: 'pg not available' })
  try {
    await ensureCleaningTaskMediaTable()
    const r0 = await pgPool.query('SELECT id, inspector_id, cleaner_id, assignee_id FROM cleaning_tasks WHERE id=$1 LIMIT 1', [id])
    const row = r0?.rows?.[0] || null
    if (!row) return res.status(404).json({ message: 'not found' })
    const inspectorId = row.inspector_id ? String(row.inspector_id) : ''
    const cleanerId = row.cleaner_id ? String(row.cleaner_id) : ''
    const assigneeId = row.assignee_id ? String(row.assignee_id) : ''
    if (!canViewAll(user) && inspectorId !== userId && cleanerId !== userId && assigneeId !== userId) return res.status(403).json({ message: 'forbidden' })

    const uniq = new Set<string>()
    for (const it of parsed.data.items) {
      const k = String(it.item_id || '').trim()
      if (!k) continue
      if (uniq.has(k)) return res.status(400).json({ message: '重复 item_id', item_id: k })
      uniq.add(k)
    }

    await pgPool.query(`DELETE FROM cleaning_task_media WHERE task_id=$1 AND type LIKE 'restock_proof:%'`, [id])
    const uuid = require('uuid')
    const batchId = uuid.v4()
    for (const it of parsed.data.items) {
      const meta = { status: it.status, qty: it.qty == null ? null : Number(it.qty), note: it.note == null ? null : String(it.note || '') }
      const url = String(it.proof_url || '').trim()
      await pgPool.query(
        `INSERT INTO cleaning_task_media (id, task_id, type, url, note, captured_at, uploader_id)
         VALUES ($1,$2,$3,$4,$5,now(),$6)`,
        [uuid.v4(), id, `restock_proof:${it.item_id}`, url || 'no_photo', JSON.stringify(meta), userId],
      )
    }
    try {
      const { broadcastCleaningEvent } = require('./events')
      broadcastCleaningEvent({ event: 'restock_proof_saved', task_id: id })
    } catch {}
    try {
      const { listCleaningTaskUserIds, listManagerUserIds, excludeUserIds } = require('./notifications')
      const { emitNotificationEvent } = require('../services/notificationEvents')
      const operationId = require('uuid').v4()
      const taskUsers = excludeUserIds(await listCleaningTaskUserIds(id), userId)
      const managerUsers = await listManagerUserIds()
      const to = Array.from(new Set([...taskUsers, ...managerUsers]))
      let propertyId = ''
      try {
        const r2 = await pgPool.query(`SELECT property_id::text AS property_id FROM cleaning_tasks WHERE id::text=$1::text LIMIT 1`, [String(id)])
        propertyId = String(r2?.rows?.[0]?.property_id || '').trim()
      } catch {}
      if (propertyId && to.length) {
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
            actorUserId: userId,
            recipientUserIds: to,
          },
          { operationId },
        )
      }
    } catch {}
    return res.status(201).json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'restock_proof_failed' })
  }
})

router.post('/cleaning-tasks/:id/guest-checked-out', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  const userId = String(user.sub || '')
  if (!(hasRole(user, 'customer_service') || hasRole(user, 'admin') || hasRole(user, 'offline_manager'))) return res.status(403).json({ message: 'forbidden' })
  const id = String(req.params.id || '').trim()
  if (!id) return res.status(400).json({ message: 'missing id' })
  if (!hasPg || !pgPool) return res.status(500).json({ message: 'pg not available' })
  try {
    await ensureCleaningCheckoutColumns()
    try {
      await pgPool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS keys_required integer NOT NULL DEFAULT 1;`)
    } catch {}
    const action = String(req.body?.action || 'set').trim().toLowerCase()
    const r0 = await pgPool.query('SELECT id, checked_out_at FROM cleaning_tasks WHERE id=$1 LIMIT 1', [id])
    const row = r0?.rows?.[0] || null
    if (!row) return res.status(404).json({ message: 'not found' })
    const prevCheckedOutAt = row.checked_out_at ? String(row.checked_out_at) : null
    if (action === 'unset' || action === 'clear' || action === 'cancel') {
      await pgPool.query(
        `UPDATE cleaning_tasks
         SET checked_out_at = NULL,
             checkout_marked_by = NULL,
             updated_at = now()
         WHERE id = $1`,
        [id],
      )
      try {
        const { broadcastCleaningEvent } = require('./events')
        broadcastCleaningEvent({ event: 'guest_checked_out_cancelled', task_id: id })
      } catch {}
      try {
        const { notifyExpoUsers, listCleaningTaskUserIds, listManagerUserIds } = require('./notifications')
        let propertyCode = ''
        try {
          const r = await pgPool.query(
            `SELECT COALESCE(p_id.code, p_code.code, t.property_id::text) AS property_code
             FROM cleaning_tasks t
             LEFT JOIN properties p_id ON (p_id.id::text) = (t.property_id::text)
             LEFT JOIN properties p_code ON upper(p_code.code) = upper(t.property_id::text)
             WHERE t.id=$1 LIMIT 1`,
            [id],
          )
          propertyCode = String(r?.rows?.[0]?.property_code || '').trim()
        } catch {}
        const to = Array.from(new Set([...(await listCleaningTaskUserIds(id)), ...(await listManagerUserIds())]))
        await notifyExpoUsers({
          user_ids: to,
          title: propertyCode ? `取消已退房：${propertyCode}` : '取消已退房',
          body: '已取消退房',
          data: { kind: 'guest_checked_out_cancelled', task_id: id, property_code: propertyCode, checked_out_at: prevCheckedOutAt, event_id: `guest_checked_out_cancelled:${propertyCode || id}:${prevCheckedOutAt || ''}` },
        })
      } catch {}
      return res.status(201).json({ ok: true })
    }
    await pgPool.query(
      `UPDATE cleaning_tasks
       SET checked_out_at = COALESCE(checked_out_at, now()),
           checkout_marked_by = COALESCE(checkout_marked_by, $2),
           updated_at = now()
       WHERE id = $1`,
      [id, userId],
    )
    try {
      const { broadcastCleaningEvent } = require('./events')
      broadcastCleaningEvent({ event: 'guest_checked_out', task_id: id })
    } catch {}
    try {
      const { notifyExpoUsers, listCleaningTaskUserIds, listManagerUserIds } = require('./notifications')
      let checkedOutAt: string | null = null
      let propertyCode = ''
      let keysRequired: number | null = null
      try {
        const r = await pgPool.query(
          `SELECT t.checked_out_at, COALESCE(o.keys_required, 1) AS keys_required, COALESCE(p_id.code, p_code.code, t.property_id::text) AS property_code
           FROM cleaning_tasks t
           LEFT JOIN orders o ON (o.id::text) = (t.order_id::text)
           LEFT JOIN properties p_id ON (p_id.id::text) = (t.property_id::text)
           LEFT JOIN properties p_code ON upper(p_code.code) = upper(t.property_id::text)
           WHERE t.id=$1 LIMIT 1`,
          [id],
        )
        checkedOutAt = r?.rows?.[0]?.checked_out_at ? String(r.rows[0].checked_out_at) : null
        propertyCode = String(r?.rows?.[0]?.property_code || '').trim()
        keysRequired = r?.rows?.[0]?.keys_required == null ? null : Number(r.rows[0].keys_required)
      } catch {}
      const to = Array.from(new Set([...(await listCleaningTaskUserIds(id)), ...(await listManagerUserIds())]))
      const body = keysRequired && keysRequired >= 2 ? `已退房（${keysRequired}把钥匙）` : '已退房'
      await notifyExpoUsers({
        user_ids: to,
        title: propertyCode ? `已退房：${propertyCode}` : '已退房',
        body,
        data: { kind: 'guest_checked_out', task_id: id, property_code: propertyCode, checked_out_at: checkedOutAt, keys_required: keysRequired, event_id: `guest_checked_out:${propertyCode || id}:${checkedOutAt || ''}` },
      })
    } catch {}
    return res.status(201).json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'guest_checked_out_failed' })
  }
})

const guestCheckedOutBulkSchema = z
  .object({
    task_ids: z.array(z.string().trim().min(1)).min(1).max(20),
    action: z.enum(['set', 'unset']).optional(),
  })
  .strict()

router.post('/cleaning-tasks/guest-checked-out', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  const userId = String(user.sub || '')
  if (!(hasRole(user, 'customer_service') || hasRole(user, 'admin') || hasRole(user, 'offline_manager'))) return res.status(403).json({ message: 'forbidden' })
  const parsed = guestCheckedOutBulkSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  if (!hasPg || !pgPool) return res.status(500).json({ message: 'pg not available' })
  const ids = Array.from(new Set(parsed.data.task_ids.map((x) => String(x || '').trim()).filter(Boolean)))
  if (!ids.length) return res.status(400).json({ message: 'missing task_ids' })
  try {
    await ensureCleaningCheckoutColumns()
    try {
      await pgPool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS keys_required integer NOT NULL DEFAULT 1;`)
    } catch {}
    const action = String(parsed.data.action || 'set').trim().toLowerCase()
    let ids2 = ids
    try {
      const rTypes = await pgPool.query(
        `SELECT id::text AS id, order_id::text AS order_id, task_type::text AS task_type
         FROM cleaning_tasks
         WHERE id::text = ANY($1::text[])`,
        [ids],
      )
      const checkoutIds = (rTypes?.rows || [])
        .filter((x: any) => String(x?.task_type || '').trim().toLowerCase() === 'checkout_clean')
        .map((x: any) => String(x?.id || '').trim())
        .filter(Boolean)
      if (checkoutIds.length) ids2 = Array.from(new Set(checkoutIds))
    } catch {}
    if (action === 'unset' || action === 'clear' || action === 'cancel') {
      let prevCheckedOutAt: string | null = null
      try {
        const rPrev = await pgPool.query(`SELECT checked_out_at FROM cleaning_tasks WHERE id=$1 LIMIT 1`, [ids2[0]])
        prevCheckedOutAt = rPrev?.rows?.[0]?.checked_out_at ? String(rPrev.rows[0].checked_out_at) : null
      } catch {}
      await pgPool.query(
        `UPDATE cleaning_tasks
         SET checked_out_at = NULL,
             checkout_marked_by = NULL,
             updated_at = now()
         WHERE id::text = ANY($1::text[])`,
        [ids2],
      )
      try {
        const { broadcastCleaningEvent } = require('./events')
        for (const id of ids2) broadcastCleaningEvent({ event: 'guest_checked_out_cancelled', task_id: id })
      } catch {}
      let propertyCode = ''
      try {
        const r = await pgPool.query(
          `SELECT COALESCE(p_id.code, p_code.code, t.property_id::text) AS property_code
           FROM cleaning_tasks t
           LEFT JOIN properties p_id ON (p_id.id::text) = (t.property_id::text)
           LEFT JOIN properties p_code ON upper(p_code.code) = upper(t.property_id::text)
           WHERE t.id=$1 LIMIT 1`,
          [ids2[0]],
        )
        propertyCode = String(r?.rows?.[0]?.property_code || '').trim()
      } catch {}
      try {
        const { notifyExpoUsers, listCleaningTaskUserIdsBulk, listManagerUserIds } = require('./notifications')
        const to = Array.from(new Set([...(await listCleaningTaskUserIdsBulk(ids2)), ...(await listManagerUserIds())]))
        await notifyExpoUsers({
          user_ids: to,
          title: propertyCode ? `取消已退房：${propertyCode}` : '取消已退房',
          body: '已取消退房',
          data: { kind: 'guest_checked_out_cancelled', task_ids: ids2, property_code: propertyCode, checked_out_at: prevCheckedOutAt, event_id: `guest_checked_out_cancelled:${propertyCode || ids2[0]}:${prevCheckedOutAt || ''}` },
        })
      } catch {}
      return res.status(201).json({ ok: true })
    }

    await pgPool.query(
      `UPDATE cleaning_tasks
       SET checked_out_at = COALESCE(checked_out_at, now()),
           checkout_marked_by = COALESCE(checkout_marked_by, $2),
           updated_at = now()
       WHERE id::text = ANY($1::text[])`,
      [ids2, userId],
    )
    try {
      const { broadcastCleaningEvent } = require('./events')
      for (const id of ids2) broadcastCleaningEvent({ event: 'guest_checked_out', task_id: id })
    } catch {}

    let checkedOutAt: string | null = null
    let propertyCode = ''
    let keysRequired: number | null = null
    try {
      const r = await pgPool.query(
        `SELECT t.checked_out_at, COALESCE(o.keys_required, 1) AS keys_required, COALESCE(p_id.code, p_code.code, t.property_id::text) AS property_code
         FROM cleaning_tasks t
         LEFT JOIN orders o ON (o.id::text) = (t.order_id::text)
         LEFT JOIN properties p_id ON (p_id.id::text) = (t.property_id::text)
         LEFT JOIN properties p_code ON upper(p_code.code) = upper(t.property_id::text)
         WHERE t.id=$1 LIMIT 1`,
        [ids2[0]],
      )
      checkedOutAt = r?.rows?.[0]?.checked_out_at ? String(r.rows[0].checked_out_at) : null
      propertyCode = String(r?.rows?.[0]?.property_code || '').trim()
      keysRequired = r?.rows?.[0]?.keys_required == null ? null : Number(r.rows[0].keys_required)
    } catch {}
    const eventId = `guest_checked_out:${propertyCode || ids2[0]}:${checkedOutAt || ''}`
    try {
      const { notifyExpoUsers, listCleaningTaskUserIdsBulk, listManagerUserIds } = require('./notifications')
      const to = Array.from(new Set([...(await listCleaningTaskUserIdsBulk(ids2)), ...(await listManagerUserIds())]))
      const body = keysRequired && keysRequired >= 2 ? `已退房（${keysRequired}把钥匙）` : '已退房'
      await notifyExpoUsers({
        user_ids: to,
        title: propertyCode ? `已退房：${propertyCode}` : '已退房',
        body,
        data: { kind: 'guest_checked_out', task_ids: ids2, property_code: propertyCode, checked_out_at: checkedOutAt, keys_required: keysRequired, event_id: eventId },
      })
    } catch {}
    return res.status(201).json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'guest_checked_out_bulk_failed' })
  }
})

const orderCheckedOutSchema = z
  .object({
    order_id: z.string().trim().min(1),
    action: z.enum(['set', 'unset']).optional(),
  })
  .strict()

router.post('/cleaning-tasks/order-checked-out', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  const userId = String(user.sub || '')
  if (!(hasRole(user, 'customer_service') || hasRole(user, 'admin') || hasRole(user, 'offline_manager'))) return res.status(403).json({ message: 'forbidden' })
  const parsed = orderCheckedOutSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  if (!hasPg || !pgPool) return res.status(500).json({ message: 'pg not available' })
  const orderId = String(parsed.data.order_id || '').trim()
  if (!orderId) return res.status(400).json({ message: 'missing order_id' })
  try {
    await ensureCleaningCheckoutColumns()
    try {
      await pgPool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS keys_required integer NOT NULL DEFAULT 1;`)
    } catch {}

    const action = String(parsed.data.action || 'set').trim().toLowerCase()
    const rTasks = await pgPool.query(
      `SELECT id::text AS id
       FROM cleaning_tasks
       WHERE order_id::text = $1::text
         AND lower(COALESCE(task_type,'')) = 'checkout_clean'
         AND COALESCE(status,'') <> 'cancelled'
       ORDER BY COALESCE(task_date, date) DESC, id DESC`,
      [orderId],
    )
    const taskIds = Array.from(new Set((rTasks?.rows || []).map((x: any) => String(x.id || '').trim()).filter(Boolean)))
    if (!taskIds.length) return res.status(404).json({ message: 'checkout task not found' })

    if (action === 'unset' || action === 'clear' || action === 'cancel') {
      let prevCheckedOutAt: string | null = null
      try {
        const rPrev = await pgPool.query(`SELECT checked_out_at FROM cleaning_tasks WHERE id=$1 LIMIT 1`, [taskIds[0]])
        prevCheckedOutAt = rPrev?.rows?.[0]?.checked_out_at ? String(rPrev.rows[0].checked_out_at) : null
      } catch {}
      await pgPool.query(
        `UPDATE cleaning_tasks
         SET checked_out_at = NULL,
             checkout_marked_by = NULL,
             updated_at = now()
         WHERE id::text = ANY($1::text[])`,
        [taskIds],
      )
      try {
        const { broadcastCleaningEvent } = require('./events')
        for (const id of taskIds) broadcastCleaningEvent({ event: 'guest_checked_out_cancelled', task_id: id })
      } catch {}
      let propertyCode = ''
      try {
        const r = await pgPool.query(
          `SELECT COALESCE(p_id.code, p_code.code, t.property_id::text) AS property_code
           FROM cleaning_tasks t
           LEFT JOIN properties p_id ON (p_id.id::text) = (t.property_id::text)
           LEFT JOIN properties p_code ON upper(p_code.code) = upper(t.property_id::text)
           WHERE t.id=$1 LIMIT 1`,
          [taskIds[0]],
        )
        propertyCode = String(r?.rows?.[0]?.property_code || '').trim()
      } catch {}
      try {
        const { notifyExpoUsers, listCleaningTaskUserIdsBulk, listManagerUserIds } = require('./notifications')
        const to = Array.from(new Set([...(await listCleaningTaskUserIdsBulk(taskIds)), ...(await listManagerUserIds())]))
        await notifyExpoUsers({
          user_ids: to,
          title: propertyCode ? `取消已退房：${propertyCode}` : '取消已退房',
          body: '已取消退房',
          data: { kind: 'guest_checked_out_cancelled', task_ids: taskIds, property_code: propertyCode, checked_out_at: prevCheckedOutAt, event_id: `guest_checked_out_cancelled:${propertyCode || taskIds[0]}:${prevCheckedOutAt || ''}` },
        })
      } catch {}
      return res.status(201).json({ ok: true })
    }

    await pgPool.query(
      `UPDATE cleaning_tasks
       SET checked_out_at = COALESCE(checked_out_at, now()),
           checkout_marked_by = COALESCE(checkout_marked_by, $2),
           updated_at = now()
       WHERE id::text = ANY($1::text[])`,
      [taskIds, userId],
    )
    try {
      const { broadcastCleaningEvent } = require('./events')
      for (const id of taskIds) broadcastCleaningEvent({ event: 'guest_checked_out', task_id: id })
    } catch {}

    let checkedOutAt: string | null = null
    let propertyCode = ''
    let propertyId = ''
    let keysRequired: number | null = null
    try {
      const r = await pgPool.query(
        `SELECT t.checked_out_at,
                COALESCE(o.keys_required, 1) AS keys_required,
                t.property_id::text AS property_id,
                COALESCE(p_id.code, p_code.code, t.property_id::text) AS property_code
         FROM cleaning_tasks t
         LEFT JOIN orders o ON (o.id::text) = (t.order_id::text)
         LEFT JOIN properties p_id ON (p_id.id::text) = (t.property_id::text)
         LEFT JOIN properties p_code ON upper(p_code.code) = upper(t.property_id::text)
         WHERE t.id=$1 LIMIT 1`,
        [taskIds[0]],
      )
      checkedOutAt = r?.rows?.[0]?.checked_out_at ? String(r.rows[0].checked_out_at) : null
      propertyId = String(r?.rows?.[0]?.property_id || '').trim()
      propertyCode = String(r?.rows?.[0]?.property_code || '').trim()
      keysRequired = r?.rows?.[0]?.keys_required == null ? null : Number(r.rows[0].keys_required)
    } catch {}
    const eventId = `guest_checked_out:${propertyCode || taskIds[0]}:${checkedOutAt || ''}`
    try {
      const { listCleaningTaskUserIdsBulk, listManagerUserIds } = require('./notifications')
      const { emitNotificationEvent } = require('../services/notificationEvents')
      const operationId = require('uuid').v4()
      const to = Array.from(new Set([...(await listCleaningTaskUserIdsBulk(taskIds)), ...(await listManagerUserIds())]))
      const body = keysRequired && keysRequired >= 2 ? `已退房（${keysRequired}把钥匙）` : '已退房'
      if (propertyId && to.length) {
        await emitNotificationEvent(
          {
            type: 'CLEANING_TASK_UPDATED',
            entity: 'cleaning_task',
            entityId: String(taskIds[0]),
            propertyId,
            updatedAt: checkedOutAt || new Date().toISOString(),
            changes: ['status', 'keys'],
            title: propertyCode ? `已退房：${propertyCode}` : '已退房',
            body,
            data: { entity: 'cleaning_task', entityId: String(taskIds[0]), action: 'open_task', kind: 'guest_checked_out', task_ids: taskIds, property_code: propertyCode, checked_out_at: checkedOutAt, keys_required: keysRequired, event_id: eventId },
            actorUserId: userId,
            recipientUserIds: to,
          },
          { operationId },
        )
      }
    } catch {}
    return res.status(201).json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'order_checked_out_failed' })
  }
})

const orderKeysRequiredSchema = z
  .object({
    order_id: z.string().trim().min(1),
    keys_required: z
      .preprocess((v) => {
        if (v == null) return v
        if (typeof v === 'number') return v
        const n = Number(v)
        return Number.isFinite(n) ? n : v
      }, z.number().int().min(1).max(2)),
  })
  .strict()

router.post('/cleaning-tasks/order-keys-required', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  if (!(hasRole(user, 'customer_service') || hasRole(user, 'admin') || hasRole(user, 'offline_manager'))) return res.status(403).json({ message: 'forbidden' })
  const parsed = orderKeysRequiredSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  if (!hasPg || !pgPool) return res.status(500).json({ message: 'pg not available' })
  const orderId = String(parsed.data.order_id || '').trim()
  const nextK = Math.max(1, Math.min(2, Math.trunc(Number(parsed.data.keys_required))))
  try {
    await ensureCleaningCustomerColumns()
    try {
      await pgPool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS keys_required integer NOT NULL DEFAULT 1;`)
    } catch {}

    const r0 = await pgPool.query(`SELECT keys_required FROM orders WHERE id::text = $1::text LIMIT 1`, [orderId])
    const prevK0 = r0?.rows?.[0]?.keys_required == null ? 1 : Number(r0.rows[0].keys_required)
    const prevK = Number.isFinite(prevK0) ? Math.max(1, Math.min(2, Math.trunc(prevK0))) : 1
    if (prevK === nextK) return res.json({ ok: true, skipped: 'no_change' })

    await pgPool.query(`UPDATE orders SET keys_required = $1 WHERE id::text = $2::text`, [nextK, orderId])
    const rTasks = await pgPool.query(
      `UPDATE cleaning_tasks
       SET keys_required = $1, updated_at = now()
       WHERE order_id::text = $2::text
         AND lower(COALESCE(task_type,'')) IN ('checkin_clean','checkout_clean')
         AND COALESCE(status,'') <> 'cancelled'
       RETURNING id::text AS id`,
      [nextK, orderId],
    )
    const touched = Array.from(new Set((rTasks?.rows || []).map((x: any) => String(x.id || '').trim()).filter(Boolean)))
    let allTaskIds: string[] = touched
    try {
      const rAll = await pgPool.query(
        `SELECT id::text AS id
         FROM cleaning_tasks
         WHERE order_id::text = $1::text
           AND lower(COALESCE(task_type,'')) IN ('checkin_clean','checkout_clean')
           AND COALESCE(status,'') <> 'cancelled'`,
        [orderId],
      )
      allTaskIds = Array.from(new Set((rAll?.rows || []).map((x: any) => String(x.id || '').trim()).filter(Boolean)))
    } catch {}

    try {
      const { broadcastCleaningEvent } = require('./events')
      for (const id of allTaskIds) broadcastCleaningEvent({ event: 'cleaning_task_manager_fields_updated', task_id: String(id) })
    } catch {}

    try {
      let propertyCode = ''
      let propertyId = ''
      try {
        const r = await pgPool.query(
          `SELECT t.property_id::text AS property_id,
                  COALESCE(p_id.code, p_code.code, t.property_id::text) AS property_code
           FROM cleaning_tasks t
           LEFT JOIN properties p_id ON (p_id.id::text) = (t.property_id::text)
           LEFT JOIN properties p_code ON upper(p_code.code) = upper(t.property_id::text)
           WHERE t.order_id::text = $1::text
           ORDER BY COALESCE(t.task_date, t.date) DESC, t.id DESC
           LIMIT 1`,
          [orderId],
        )
        propertyId = String(r?.rows?.[0]?.property_id || '').trim()
        propertyCode = String(r?.rows?.[0]?.property_code || '').trim()
      } catch {}
      const { emitNotificationEvent } = require('../services/notificationEvents')
      const operationId = require('uuid').v4()
      const body = `需挂钥匙套数：${nextK}（原：${prevK}）`
      if (propertyId) {
        await emitNotificationEvent(
          {
            type: 'ORDER_UPDATED',
            entity: 'order',
            entityId: String(orderId),
            propertyId,
            updatedAt: new Date().toISOString(),
            changes: ['keys'],
            title: propertyCode ? `任务信息更新：${propertyCode}` : '任务信息更新',
            body,
            data: { entity: 'order', entityId: String(orderId), action: 'open_order', kind: 'cleaning_task_manager_fields_updated', task_ids: allTaskIds, property_code: propertyCode },
            actorUserId: String(user?.sub || ''),
          },
          { operationId },
        )
      }
    } catch {}

    return res.status(201).json({ ok: true, updated: touched.length })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'order_keys_required_failed' })
  }
})

const managerFieldsSchema = z
  .object({
    task_ids: z.array(z.string().trim().min(1)).min(1).max(50),
    checkout_time: z.string().trim().max(32).optional().nullable(),
    checkin_time: z.string().trim().max(32).optional().nullable(),
    old_code: z.string().trim().max(64).optional().nullable(),
    new_code: z.string().trim().max(64).optional().nullable(),
    guest_special_request: z.string().trim().max(1500).optional().nullable(),
    keys_required: z
      .preprocess((v) => {
        if (v == null) return v
        if (typeof v === 'number') return v
        const n = Number(v)
        return Number.isFinite(n) ? n : v
      }, z.number().int().min(1).max(2))
      .optional()
      .nullable(),
  })
  .strict()

async function handleManagerFields(req: any, res: any) {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  const role = String(user.role || '')
  if (role !== 'customer_service') return res.status(403).json({ message: 'forbidden' })
  const body0 = req.body || {}
  if (Object.prototype.hasOwnProperty.call(body0, 'keys_required')) {
    return res.status(400).json({ message: 'keys_required 已迁移到订单主数据（order_id）更新，请升级前端后重试' })
  }
  const parsed = managerFieldsSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  if (!hasPg || !pgPool) return res.status(500).json({ message: 'pg not available' })
  try {
    await ensureCleaningCustomerColumns()
    const repId = String(parsed.data.task_ids[0] || '').trim()
    let propertyCode = ''
    let prevRow: any = null
    try {
      const r = await pgPool.query(
        `SELECT t.order_id::text AS order_id, t.checkout_time, t.checkin_time, t.old_code, t.new_code, t.guest_special_request, t.keys_required,
                COALESCE(p_id.code, p_code.code, t.property_id::text) AS property_code
         FROM cleaning_tasks t
         LEFT JOIN properties p_id ON (p_id.id::text) = (t.property_id::text)
         LEFT JOIN properties p_code ON upper(p_code.code) = upper(t.property_id::text)
         WHERE t.id=$1 LIMIT 1`,
        [repId],
      )
      prevRow = r?.rows?.[0] || null
      propertyCode = String(prevRow?.property_code || '').trim()
    } catch {}
    const fields: string[] = []
    const vals: any[] = []
    const push = (sql: string, v: any) => {
      vals.push(v)
      fields.push(`${sql} = $${vals.length}`)
    }
    const norm = (v: any) => String(v ?? '').replace(/\s+/g, ' ').trim()
    const eqNorm = (a: any, b: any) => norm(a) === norm(b)
    let nextKeysRequired: number | null = null
    let prevKeysRequiredMin: number | null = null
    let prevKeysRequiredMax: number | null = null
    let keysOrderIds: string[] = []
    let keysNullIds: string[] = []
    if (parsed.data.checkout_time !== undefined && !eqNorm(parsed.data.checkout_time, prevRow?.checkout_time)) push('checkout_time', parsed.data.checkout_time)
    if (parsed.data.checkin_time !== undefined && !eqNorm(parsed.data.checkin_time, prevRow?.checkin_time)) push('checkin_time', parsed.data.checkin_time)
    if (parsed.data.old_code !== undefined && !eqNorm(parsed.data.old_code, prevRow?.old_code)) push('old_code', parsed.data.old_code)
    if (parsed.data.new_code !== undefined && !eqNorm(parsed.data.new_code, prevRow?.new_code)) push('new_code', parsed.data.new_code)
    if (parsed.data.guest_special_request !== undefined && !eqNorm(parsed.data.guest_special_request, prevRow?.guest_special_request)) push('guest_special_request', parsed.data.guest_special_request)
    if (parsed.data.keys_required !== undefined) {
      const nextK = parsed.data.keys_required == null ? 1 : Number(parsed.data.keys_required)
      if (Number.isFinite(nextK)) {
        const nextK2 = Math.max(1, Math.min(2, Math.trunc(nextK)))
        try {
          const ids0 = Array.from(new Set(parsed.data.task_ids.map((x) => String(x || '').trim()).filter(Boolean)))
          const rrIds = await pgPool.query(
            `SELECT id::text AS id, order_id::text AS order_id, task_type::text AS task_type
             FROM cleaning_tasks
             WHERE id::text = ANY($1::text[])`,
            [ids0],
          )
          const pickedRows = (() => {
            const rows = (rrIds?.rows || []) as any[]
            const checkins = rows.filter((x: any) => String(x?.task_type || '').trim().toLowerCase() === 'checkin_clean')
            if (checkins.length) return checkins
            const checkouts = rows.filter((x: any) => String(x?.task_type || '').trim().toLowerCase() === 'checkout_clean')
            if (checkouts.length) return checkouts
            return rows
          })()
          keysOrderIds = Array.from(new Set(pickedRows.map((x: any) => String(x.order_id || '').trim()).filter(Boolean)))
          keysNullIds = Array.from(new Set(pickedRows.filter((x: any) => !String(x.order_id || '').trim()).map((x: any) => String(x.id || '').trim()).filter(Boolean)))
          if (!keysOrderIds.length && !keysNullIds.length) {
            prevKeysRequiredMin = 1
            prevKeysRequiredMax = 1
          } else {
            const rrk = await pgPool.query(
              `WITH o AS (SELECT unnest($1::text[]) AS order_id),
                    i AS (SELECT unnest($2::text[]) AS id)
               SELECT
                 MIN(COALESCE(t.keys_required, 1)) AS min_k,
                 MAX(COALESCE(t.keys_required, 1)) AS max_k,
                 SUM(CASE WHEN COALESCE(t.keys_required, 1) <> $3 THEN 1 ELSE 0 END) AS diff_count
               FROM cleaning_tasks t
               WHERE (t.order_id::text IN (SELECT order_id FROM o))
                  OR (t.order_id IS NULL AND t.id::text IN (SELECT id FROM i))`,
              [keysOrderIds, keysNullIds, nextK2],
            )
            const minK = rrk?.rows?.[0]?.min_k == null ? 1 : Number(rrk.rows[0].min_k)
            const maxK = rrk?.rows?.[0]?.max_k == null ? 1 : Number(rrk.rows[0].max_k)
            const diffCount = rrk?.rows?.[0]?.diff_count == null ? 0 : Number(rrk.rows[0].diff_count)
            prevKeysRequiredMin = Number.isFinite(minK) ? Math.max(1, Math.min(2, Math.trunc(minK))) : 1
            prevKeysRequiredMax = Number.isFinite(maxK) ? Math.max(1, Math.min(2, Math.trunc(maxK))) : 1
            if (Number.isFinite(diffCount) && diffCount > 0) nextKeysRequired = nextK2
          }
        } catch {
          const fallback = prevRow?.keys_required == null ? 1 : Number(prevRow.keys_required)
          const k0 = Number.isFinite(fallback) ? Math.max(1, Math.min(2, Math.trunc(fallback))) : 1
          prevKeysRequiredMin = k0
          prevKeysRequiredMax = k0
        }
      }
    }
    if (!fields.length && nextKeysRequired == null) return res.json({ ok: true, skipped: 'no_change' })

    if (fields.length) {
      vals.push(parsed.data.task_ids)
      const sql = `UPDATE cleaning_tasks SET ${fields.join(', ')}, updated_at = now() WHERE id::text = ANY($${vals.length}::text[])`
      await pgPool.query(sql, vals)
    }

    const affectedTaskIds = new Set(parsed.data.task_ids.map((x) => String(x || '').trim()).filter(Boolean))
    if (nextKeysRequired != null) {
      const pool = pgPool
      if (!pool) return res.status(500).json({ message: 'pg not available' })
      try {
        const doUpdateOrder = async () => {
          if (!keysOrderIds.length) return
          await pool.query(
            `UPDATE cleaning_tasks
             SET keys_required = $1, updated_at = now()
             WHERE order_id::text = ANY($2::text[])
               AND COALESCE(status,'') <> 'cancelled'
               AND COALESCE(keys_required, 1) <> $1`,
            [nextKeysRequired, keysOrderIds],
          )
          const rIds = await pool.query(
            `SELECT id::text AS id
             FROM cleaning_tasks
             WHERE order_id::text = ANY($1::text[])`,
            [keysOrderIds],
          )
          for (const x of rIds?.rows || []) {
            const id2 = String(x?.id || '').trim()
            if (id2) affectedTaskIds.add(id2)
          }
        }
        const doUpdateNull = async () => {
          if (!keysNullIds.length) return
          await pool.query(
            `UPDATE cleaning_tasks
             SET keys_required = $1, updated_at = now()
             WHERE order_id IS NULL
               AND id::text = ANY($2::text[])
               AND COALESCE(status,'') <> 'cancelled'
               AND COALESCE(keys_required, 1) <> $1`,
            [nextKeysRequired, keysNullIds],
          )
          for (const id2 of keysNullIds) affectedTaskIds.add(String(id2))
        }
        await doUpdateOrder()
        await doUpdateNull()
      } catch {}
    }

    try {
      const { broadcastCleaningEvent } = require('./events')
      for (const id of Array.from(affectedTaskIds)) broadcastCleaningEvent({ event: 'cleaning_task_manager_fields_updated', task_id: String(id) })
    } catch {}
    try {
      const { notifyExpoUsers, listCleaningTaskUserIdsBulk, listManagerUserIds } = require('./notifications')
      const fmt = (label: string, next: any, prev: any) => `${label}：${norm(next) || '-'}（原：${norm(prev) || '-'}）`
      const lines: string[] = []
      if (parsed.data.checkout_time !== undefined && !eqNorm(parsed.data.checkout_time, prevRow?.checkout_time)) lines.push(fmt('退房时间', parsed.data.checkout_time, prevRow?.checkout_time))
      if (parsed.data.checkin_time !== undefined && !eqNorm(parsed.data.checkin_time, prevRow?.checkin_time)) lines.push(fmt('入住时间', parsed.data.checkin_time, prevRow?.checkin_time))
      if (parsed.data.old_code !== undefined && !eqNorm(parsed.data.old_code, prevRow?.old_code)) lines.push(fmt('旧密码', parsed.data.old_code, prevRow?.old_code))
      if (parsed.data.new_code !== undefined && !eqNorm(parsed.data.new_code, prevRow?.new_code)) lines.push(fmt('新密码', parsed.data.new_code, prevRow?.new_code))
      if (parsed.data.guest_special_request !== undefined && !eqNorm(parsed.data.guest_special_request, prevRow?.guest_special_request)) lines.push(fmt('客人需求', parsed.data.guest_special_request, prevRow?.guest_special_request))
      if (parsed.data.keys_required !== undefined) {
        const nextK = parsed.data.keys_required == null ? 1 : Number(parsed.data.keys_required)
        if (Number.isFinite(nextK) && nextKeysRequired != null) {
          const prevLabel =
            prevKeysRequiredMin != null && prevKeysRequiredMax != null && prevKeysRequiredMin !== prevKeysRequiredMax
              ? `${prevKeysRequiredMin}/${prevKeysRequiredMax}`
              : (prevKeysRequiredMax != null ? String(prevKeysRequiredMax) : (prevRow?.keys_required == null ? '1' : String(prevRow.keys_required)))
          lines.push(fmt('需挂钥匙套数', nextKeysRequired, prevLabel))
        }
      }
      if (!lines.length) return res.json({ ok: true, skipped: 'no_change' })
      const hashText = (s: string) => {
        let h = 0
        for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
        return String(h)
      }
      let afterRow: any = null
      try {
        const rAfter = await pgPool.query(
          `SELECT t.checkout_time, t.checkin_time, t.old_code, t.new_code, t.guest_special_request, t.keys_required,
                  COALESCE(p_id.code, p_code.code, t.property_id::text) AS property_code
           FROM cleaning_tasks t
           LEFT JOIN properties p_id ON (p_id.id::text) = (t.property_id::text)
           LEFT JOIN properties p_code ON upper(p_code.code) = upper(t.property_id::text)
           WHERE t.id=$1 LIMIT 1`,
          [repId],
        )
        afterRow = rAfter?.rows?.[0] || null
        if (!propertyCode) propertyCode = String(afterRow?.property_code || '').trim()
      } catch {}
      const keyObj = {
        checkout_time: afterRow?.checkout_time == null ? null : String(afterRow.checkout_time),
        checkin_time: afterRow?.checkin_time == null ? null : String(afterRow.checkin_time),
        old_code: afterRow?.old_code == null ? null : String(afterRow.old_code),
        new_code: afterRow?.new_code == null ? null : String(afterRow.new_code),
        guest_special_request: afterRow?.guest_special_request == null ? null : String(afterRow.guest_special_request),
        keys_required: afterRow?.keys_required == null ? 1 : Number(afterRow.keys_required),
      }
      const fieldsKey = hashText(JSON.stringify(keyObj))
      const to = Array.from(new Set([...(await listCleaningTaskUserIdsBulk(Array.from(affectedTaskIds))), ...(await listManagerUserIds())]))
      await notifyExpoUsers({
        user_ids: to,
        title: propertyCode ? `任务信息更新：${propertyCode}` : '任务信息更新',
        body: lines.length ? lines.join('\n') : '任务信息已更新',
        data: { kind: 'cleaning_task_manager_fields_updated', task_ids: Array.from(affectedTaskIds), property_code: propertyCode, fields_key: fieldsKey, event_id: `manager_fields:${propertyCode || repId}:${fieldsKey}` },
      })
    } catch {}
    return res.status(201).json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'manager_fields_failed' })
  }
}

router.patch('/cleaning-tasks/manager-fields', handleManagerFields)
router.post('/cleaning-tasks/manager-fields', handleManagerFields)

router.get('/checklist-items', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  try {
    if (!hasPg || !pgPool) return res.json([])
    await ensureCleaningChecklistTables()
    const r = await pgPool.query(
      `SELECT id, label, kind, required, requires_photo_when_low, active, sort_order
       FROM cleaning_checklist_items
       WHERE active = true
       ORDER BY sort_order ASC NULLS LAST, created_at ASC`,
    )
    return res.json((r?.rows || []).map((x: any) => ({
      id: String(x.id),
      label: String(x.label || ''),
      kind: String(x.kind || 'consumable'),
      required: !!x.required,
      requires_photo_when_low: !!x.requires_photo_when_low,
    })))
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'checklist_failed' })
  }
})

router.post('/checklist-items', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  const role = String(user.role || '')
  if (role !== 'admin') return res.status(403).json({ message: 'forbidden' })
  const id = String(req.body?.id || '').trim()
  const label = String(req.body?.label || '').trim()
  const kind = String(req.body?.kind || 'consumable').trim()
  const required = req.body?.required === undefined ? true : !!req.body.required
  const requiresPhoto = req.body?.requires_photo_when_low === undefined ? true : !!req.body.requires_photo_when_low
  const sortOrder = req.body?.sort_order === undefined || req.body?.sort_order === null ? null : Number(req.body.sort_order)
  if (!id || !/^[a-z0-9_]{2,64}$/i.test(id)) return res.status(400).json({ message: 'invalid id' })
  if (!label) return res.status(400).json({ message: 'missing label' })
  if (!hasPg || !pgPool) return res.status(500).json({ message: 'pg not available' })
  try {
    await ensureCleaningChecklistTables()
    await pgPool.query(
      `INSERT INTO cleaning_checklist_items (id, label, kind, required, requires_photo_when_low, active, sort_order, created_by)
       VALUES ($1,$2,$3,$4,$5,true,$6,$7)
       ON CONFLICT (id) DO UPDATE SET label=EXCLUDED.label, kind=EXCLUDED.kind, required=EXCLUDED.required, requires_photo_when_low=EXCLUDED.requires_photo_when_low, sort_order=EXCLUDED.sort_order, active=true, updated_at=now()`,
      [id, label, kind, required, requiresPhoto, Number.isFinite(sortOrder as any) ? sortOrder : null, String(user.sub || '')],
    )
    return res.status(201).json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'checklist_upsert_failed' })
  }
})

router.patch('/checklist-items/:id', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  const role = String(user.role || '')
  if (role !== 'admin') return res.status(403).json({ message: 'forbidden' })
  const id = String(req.params.id || '').trim()
  if (!id) return res.status(400).json({ message: 'missing id' })
  if (!hasPg || !pgPool) return res.status(500).json({ message: 'pg not available' })
  try {
    await ensureCleaningChecklistTables()
    const fields: string[] = []
    const vals: any[] = []
    const setField = (k: string, v: any) => {
      vals.push(v)
      fields.push(`${k} = $${vals.length}`)
    }
    if (req.body?.label !== undefined) setField('label', String(req.body.label || '').trim())
    if (req.body?.kind !== undefined) setField('kind', String(req.body.kind || 'consumable').trim())
    if (req.body?.required !== undefined) setField('required', !!req.body.required)
    if (req.body?.requires_photo_when_low !== undefined) setField('requires_photo_when_low', !!req.body.requires_photo_when_low)
    if (req.body?.active !== undefined) setField('active', !!req.body.active)
    if (req.body?.sort_order !== undefined) setField('sort_order', req.body.sort_order === null ? null : Number(req.body.sort_order))
    if (!fields.length) return res.json({ ok: true })
    fields.push(`updated_at = now()`)
    vals.push(id)
    const sql = `UPDATE cleaning_checklist_items SET ${fields.join(', ')} WHERE id = $${vals.length}`
    await pgPool.query(sql, vals)
    return res.json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'checklist_patch_failed' })
  }
})

router.post('/upload', upload.single('file'), async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  if (!req.file) return res.status(400).json({ message: 'missing file' })
  try {
    if (hasR2 && (req.file as any).buffer) {
      const ext = path.extname(req.file.originalname) || ''
      const key = `mzapp/${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`
      const url = await r2Upload(key, req.file.mimetype || 'application/octet-stream', (req.file as any).buffer)
      return res.status(201).json({ url })
    }
    const url = `/uploads/${req.file.filename}`
    return res.status(201).json({ url })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'upload_failed' })
  }
})

router.post('/work-tasks/:id/mark', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  const userId = String(user.sub || '')
  const id = String(req.params.id || '').trim()
  const action = String(req.body?.action || '').trim().toLowerCase()
  const photoUrl = String(req.body?.photo_url || '').trim() || null
  const note = String(req.body?.note || '').trim() || null
  const reason = String(req.body?.reason || '').trim() || null
  const deferTo = dayOnly(req.body?.defer_to)
  if (!id) return res.status(400).json({ message: 'missing id' })
  if (action !== 'done' && action !== 'defer') return res.status(400).json({ message: 'invalid action' })
  if (!hasPg || !pgPool) return res.status(500).json({ message: 'pg not available' })

  try {
    await ensureWorkTasksTable()
    const r0 = await pgPool.query('SELECT * FROM work_tasks WHERE id=$1 LIMIT 1', [id])
    const row = r0?.rows?.[0] || null
    if (!row) return res.status(404).json({ message: 'not found' })
    const assignee = row.assignee_id == null ? '' : String(row.assignee_id)
    if (!canViewAll(user) && assignee !== userId) return res.status(403).json({ message: 'forbidden' })

    const parts: string[] = []
    if (photoUrl) parts.push(`照片: ${photoUrl}`)
    if (note) parts.push(`备注: ${note}`)
    if (action === 'defer' && reason) parts.push(`未完成原因: ${reason}`)
    if (action === 'defer' && deferTo) parts.push(`已挪到: ${deferTo}`)
    const append = parts.length ? `\n${parts.join('\n')}` : ''
    const nextSummary = `${String(row.summary || '')}${append}`.trim() || null

    if (action === 'done') {
      await pgPool.query('UPDATE work_tasks SET status=$1, summary=$2, updated_at=now() WHERE id=$3', ['done', nextSummary, id])
      return res.json({ ok: true })
    }
    if (!reason) return res.status(400).json({ message: 'missing reason' })
    if (deferTo) {
      await pgPool.query('UPDATE work_tasks SET status=$1, scheduled_date=$2::date, summary=$3, updated_at=now() WHERE id=$4', ['todo', deferTo, nextSummary, id])
      return res.json({ ok: true })
    }
    await pgPool.query('UPDATE work_tasks SET status=$1, summary=$2, updated_at=now() WHERE id=$3', ['todo', nextSummary, id])
    return res.json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'mark_failed' })
  }
})

router.get('/work-tasks', async (req, res) => {
  const dateFrom = dayOnly((req.query as any)?.date_from)
  const dateTo = dayOnly((req.query as any)?.date_to)
  if (!dateFrom || !dateTo) return res.status(400).json({ message: 'invalid date range' })
  const view = String((req.query as any)?.view || 'mine').trim().toLowerCase() === 'all' ? 'all' : 'mine'

  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  const userId = String(user.sub || '')

  const allowAll = view === 'all' && canViewAll(user)

  try {
    if (!hasPg || !pgPool) return res.json([])
    await ensureWorkTasksTable()
    await ensureCleaningTaskSortColumns()
    await ensureCleaningTaskMediaTable()
    await ensureCleaningCheckoutColumns()
    await ensureCleaningCustomerColumns()
    try {
      await pgPool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS keys_required integer NOT NULL DEFAULT 1;`)
    } catch {}

    const out: any[] = []

    {
      const where: string[] = []
      const vals: any[] = [dateFrom, dateTo]
      where.push(`w.scheduled_date BETWEEN $1::date AND $2::date`)
      if (!allowAll) {
        vals.push(userId)
        where.push(`w.assignee_id = $${vals.length}`)
      }
      const sql = `
        SELECT
          w.*,
          p.code AS property_code,
          p.address AS property_address,
          p.type AS property_unit_type,
          p.region AS property_region,
          p.access_guide_link AS property_access_guide_link,
          p.wifi_ssid AS property_wifi_ssid,
          p.wifi_password AS property_wifi_password,
          p.router_location AS property_router_location
        FROM work_tasks w
        LEFT JOIN properties p ON p.id = w.property_id
        WHERE ${where.join(' AND ')}
        ORDER BY w.scheduled_date ASC, w.urgency DESC, w.updated_at DESC, w.id DESC`
      const r = await pgPool.query(sql, vals)
      for (const x of (r?.rows || [])) {
        out.push({
          id: String(x.id),
          task_kind: String(x.task_kind || ''),
          source_type: String(x.source_type || ''),
          source_id: String(x.source_id || ''),
          property_id: x.property_id ? String(x.property_id) : null,
          title: String(x.title || ''),
          summary: x.summary !== undefined && x.summary !== null ? String(x.summary || '') : null,
          scheduled_date: x.scheduled_date ? String(x.scheduled_date).slice(0, 10) : null,
          start_time: x.start_time !== undefined && x.start_time !== null ? String(x.start_time || '') : null,
          end_time: x.end_time !== undefined && x.end_time !== null ? String(x.end_time || '') : null,
          assignee_id: x.assignee_id ? String(x.assignee_id) : null,
          status: normStatus(x.status),
          urgency: normUrgency(x.urgency),
          property: x.property_id
            ? {
                id: String(x.property_id),
                code: x.property_code ? String(x.property_code) : '',
                address: x.property_address ? String(x.property_address) : '',
                unit_type: x.property_unit_type ? String(x.property_unit_type) : '',
                region: x.property_region ? String(x.property_region) : null,
                access_guide_link: x.property_access_guide_link ? String(x.property_access_guide_link) : null,
                wifi_ssid: x.property_wifi_ssid ? String(x.property_wifi_ssid) : null,
                wifi_password: x.property_wifi_password ? String(x.property_wifi_password) : null,
                router_location: x.property_router_location ? String(x.property_router_location) : null,
              }
            : null,
        })
      }
    }

    {
      const isCleanerView = isCleanerRole(user) || isCleanerInspectorRole(user)
      const isInspectorView = isInspectorRole(user) || isCleanerInspectorRole(user)
      const wantCleaner = allowAll || isCleanerView
      const wantInspector = allowAll || isInspectorView

      if (wantCleaner || wantInspector) {
        const sql = `
          SELECT
            t.id,
            t.order_id,
            COALESCE(o.keys_required, 1) AS order_keys_required,
            t.nights_override,
            COALESCE(p_id.id::text, p_code.id::text, t.property_id::text) AS property_id,
            COALESCE(p_id.code::text, p_code.code::text) AS property_code,
            COALESCE(p_id.region::text, p_code.region::text) AS property_region,
            COALESCE(p_id.address::text, p_code.address::text) AS property_address,
            COALESCE(p_id.type::text, p_code.type::text) AS property_unit_type,
            COALESCE(p_id.access_guide_link::text, p_code.access_guide_link::text) AS property_access_guide_link,
            COALESCE(p_id.wifi_ssid::text, p_code.wifi_ssid::text) AS property_wifi_ssid,
            COALESCE(p_id.wifi_password::text, p_code.wifi_password::text) AS property_wifi_password,
            COALESCE(p_id.router_location::text, p_code.router_location::text) AS property_router_location,
            t.task_type,
            COALESCE(t.task_date, t.date)::text AS task_date,
            t.status,
            t.assignee_id,
            t.cleaner_id,
            t.inspector_id,
            COALESCE(cu.username, cu.email, cu.id::text) AS cleaner_name,
            COALESCE(iu.username, iu.email, iu.id::text) AS inspector_name,
            t.checkout_time,
            t.checkin_time,
            t.old_code,
            t.new_code,
            t.guest_special_request,
            CASE
              WHEN t.order_id IS NULL THEN COALESCE(t.keys_required, 1)
              ELSE COALESCE(o.keys_required, 1)
            END AS keys_required,
            t.checked_out_at,
            o.checkin::text AS order_checkin,
            o.checkout::text AS order_checkout,
            COALESCE(t.nights_override, o.nights, (o.checkout - o.checkin)) AS order_nights,
            (
              SELECT m.url
              FROM cleaning_task_media m
              WHERE m.task_id::text = t.id::text AND m.type = 'key_photo'
              ORDER BY m.captured_at DESC NULLS LAST, m.created_at DESC
              LIMIT 1
            ) AS key_photo_url,
            (
              SELECT m.url
              FROM cleaning_task_media m
              WHERE m.task_id::text = t.id::text AND m.type = 'lockbox_video'
              ORDER BY m.captured_at DESC NULLS LAST, m.created_at DESC
              LIMIT 1
            ) AS lockbox_video_url,
            t.sort_index_cleaner,
            t.sort_index_inspector,
            t.updated_at
          FROM cleaning_tasks t
          LEFT JOIN orders o ON (o.id::text) = (t.order_id::text)
          LEFT JOIN properties p_id ON (p_id.id::text) = (t.property_id::text)
          LEFT JOIN properties p_code ON upper(p_code.code) = upper(t.property_id::text)
          LEFT JOIN users cu ON (cu.id::text) = (COALESCE(t.cleaner_id, t.assignee_id)::text)
          LEFT JOIN users iu ON (iu.id::text) = (t.inspector_id::text)
          WHERE (COALESCE(t.task_date, t.date)::date) >= ($1::date) AND (COALESCE(t.task_date, t.date)::date) <= ($2::date)
            AND COALESCE(t.status,'') <> 'cancelled'
            AND (t.order_id IS NULL OR o.id IS NOT NULL)
            AND (
              t.order_id IS NULL
              OR (
                COALESCE(o.status, '') <> ''
                AND lower(COALESCE(o.status, '')) <> 'invalid'
                AND lower(COALESCE(o.status, '')) NOT LIKE '%cancel%'
              )
            )
          ORDER BY COALESCE(t.task_date, t.date) ASC, COALESCE(p_id.code, p_code.code) NULLS LAST, t.id`
        const r = await pgPool.query(sql, [dateFrom, dateTo])
        const taskIds = Array.from(new Set((r?.rows || []).map((x: any) => String(x.id || '')).filter(Boolean)))
        const restockByTaskId = new Map<string, any[]>()
        if (taskIds.length) {
          const rr = await pgPool.query(
            `SELECT task_id::text AS task_id, item_id::text AS item_id, COALESCE(item_label,'') AS item_label, qty, note, photo_url, COALESCE(status,'') AS status
             FROM cleaning_consumable_usages
             WHERE task_id::text = ANY($1::text[])
               AND (COALESCE(status,'') = 'low' OR need_restock = true)
             ORDER BY created_at ASC`,
            [taskIds],
          )
          for (const x of rr?.rows || []) {
            const k = String(x.task_id || '')
            const arr = restockByTaskId.get(k) || []
            arr.push({
              item_id: String(x.item_id || ''),
              label: String(x.item_label || x.item_id || ''),
              qty: x.qty == null ? null : Number(x.qty),
              note: x.note == null ? null : String(x.note || ''),
              photo_url: x.photo_url == null ? null : String(x.photo_url || ''),
              status: String(x.status || ''),
            })
            restockByTaskId.set(k, arr)
          }
        }
        const completionAreasByTaskId = new Map<string, Set<string>>()
        if (taskIds.length) {
          const cr = await pgPool.query(
            `SELECT task_id::text AS task_id, type
             FROM cleaning_task_media
             WHERE task_id::text = ANY($1::text[])
               AND type LIKE 'completion_%'`,
            [taskIds],
          )
          for (const x of cr?.rows || []) {
            const tid = String(x.task_id || '').trim()
            if (!tid) continue
            const type = String(x.type || '')
            const area = type.startsWith('completion_') ? type.slice('completion_'.length) : type
            if (!area) continue
            const set = completionAreasByTaskId.get(tid) || new Set<string>()
            set.add(area)
            completionAreasByTaskId.set(tid, set)
          }
        }
        const cleanerGroups = new Map<string, any[]>()
        const inspectorGroups = new Map<string, any[]>()
        for (const row of (r?.rows || [])) {
          const d = String(row.task_date || row.date || '').slice(0, 10)
          const propId = row.property_id ? String(row.property_id) : null
          const prop = propId
            ? {
                id: propId,
                code: row.property_code ? String(row.property_code) : '',
                address: row.property_address ? String(row.property_address) : '',
                unit_type: row.property_unit_type ? String(row.property_unit_type) : '',
                region: row.property_region ? String(row.property_region) : null,
                access_guide_link: row.property_access_guide_link ? String(row.property_access_guide_link) : null,
                wifi_ssid: row.property_wifi_ssid ? String(row.property_wifi_ssid) : null,
                wifi_password: row.property_wifi_password ? String(row.property_wifi_password) : null,
                router_location: row.property_router_location ? String(row.property_router_location) : null,
              }
            : null

          const raw_status = String(row.status ?? '').trim().toLowerCase()
          const status = mapCleaningTaskStatus(raw_status)

          const effectiveCleanerId = row.cleaner_id ? String(row.cleaner_id) : (row.assignee_id ? String(row.assignee_id) : null)
          const inspectorId = row.inspector_id ? String(row.inspector_id) : null
          const orderId = row.order_id ? String(row.order_id) : null
          const orderKeysRequired = row.order_keys_required == null ? null : Number(row.order_keys_required)

          const base = {
            __raw_id: String(row.id),
            __date: d,
            __prop_id: propId,
            __assignee_cleaner: effectiveCleanerId,
            __assignee_inspector: inspectorId,
            order_id: orderId,
            order_keys_required: orderKeysRequired,
            raw_status,
            task_type: String(row.task_type || ''),
            checkout_time: row.checkout_time,
            checkin_time: row.checkin_time,
            old_code: row.old_code,
            new_code: row.new_code,
            guest_special_request: row.guest_special_request,
            keys_required: row.keys_required == null ? 1 : Number(row.keys_required),
            checked_out_at: row.checked_out_at,
            key_photo_url: row.key_photo_url,
            lockbox_video_url: row.lockbox_video_url,
            restock_items: restockByTaskId.get(String(row.id)) || [],
            completion_areas: Array.from(completionAreasByTaskId.get(String(row.id)) || []),
            nights_override: row.nights_override == null ? null : Number(row.nights_override),
            order_checkin: row.order_checkin,
            order_checkout: row.order_checkout,
            order_nights: row.order_nights == null ? null : Number(row.order_nights),
            cleaner_name: row.cleaner_name,
            inspector_name: row.inspector_name,
            sort_index_cleaner: row.sort_index_cleaner,
            sort_index_inspector: row.sort_index_inspector,
            status,
            property: prop,
          }

          if (wantCleaner && effectiveCleanerId && (allowAll || effectiveCleanerId === userId)) {
            const k = `${d}|${propId || ''}|${effectiveCleanerId}`
            const arr = cleanerGroups.get(k) || []
            arr.push(base)
            cleanerGroups.set(k, arr)
          }

          if (wantInspector && inspectorId && (allowAll || inspectorId === userId)) {
            const k = `${d}|${propId || ''}|${inspectorId}`
            const arr = inspectorGroups.get(k) || []
            arr.push(base)
            inspectorGroups.set(k, arr)
          }
        }

        const buildMerged = (roleKind: 'cleaner' | 'inspector', rows: any[], assigneeId: string) => {
          const date = String(rows?.[0]?.__date || '')
          const propId = rows?.[0]?.__prop_id ? String(rows[0].__prop_id) : null
          const prop = rows?.[0]?.property || null

          const checkouts = rows.filter((x) => cleaningType(x.task_type) === 'checkout')
          const checkins = rows.filter((x) => cleaningType(x.task_type) === 'checkin')
          const stayovers = rows.filter((x) => cleaningType(x.task_type) === 'stayover')

          const pickPrimary = () => {
            if (checkouts.length && checkins.length) return { kind: 'turnover', a: checkouts[0], b: checkins[0], ids: [checkouts[0].__raw_id, checkins[0].__raw_id] }
            if (checkouts.length) return { kind: 'checkout', a: checkouts[0], b: null, ids: [checkouts[0].__raw_id] }
            if (checkins.length) return { kind: 'checkin', a: checkins[0], b: null, ids: [checkins[0].__raw_id] }
            if (stayovers.length) return { kind: 'stayover', a: stayovers[0], b: null, ids: [stayovers[0].__raw_id] }
            return { kind: 'other', a: rows[0], b: null, ids: [rows[0].__raw_id] }
          }

          const p = pickPrimary()
          const checkoutTime = p.kind === 'turnover' || p.kind === 'checkout' ? normalizeTimeOrDefault(p.a.checkout_time, '10am') : ''
          const checkinTime = p.kind === 'turnover' || p.kind === 'checkin' ? normalizeTimeOrDefault((p.kind === 'turnover' ? p.b?.checkin_time : p.a.checkin_time), '3pm') : ''
          const summary =
            p.kind === 'turnover'
              ? `${checkoutTime}退房 ${checkinTime}入住`
              : p.kind === 'checkout'
                ? `${checkoutTime}退房`
                : p.kind === 'checkin'
                  ? `${checkinTime}入住`
                  : p.kind === 'stayover'
                    ? '清洁'
                    : (summaryFromCleaningTimes(p.a.checkout_time, p.a.checkin_time) || null)

          const oldCode = firstNonEmpty(p.a.old_code, p.b?.old_code, ...rows.map((x) => x.old_code))
          const newCode = firstNonEmpty(p.a.new_code, p.b?.new_code, ...rows.map((x) => x.new_code))
          const guestSpecialRequest = firstNonEmpty(p.a.guest_special_request, p.b?.guest_special_request, ...rows.map((x) => x.guest_special_request))
          const checkedOutAt = firstNonEmpty(p.a.checked_out_at, p.b?.checked_out_at, ...rows.map((x) => x.checked_out_at))
          const keyPhotoUrl = firstNonEmpty(p.a.key_photo_url, p.b?.key_photo_url, ...rows.map((x) => x.key_photo_url))
          const lockboxVideoUrl = firstNonEmpty(p.a.lockbox_video_url, p.b?.lockbox_video_url, ...rows.map((x) => x.lockbox_video_url))
          const keysRequired = Math.max(...rows.map((x) => (x.keys_required == null ? 1 : Number(x.keys_required))).filter((x) => Number.isFinite(x) && x > 0), 1)
          const cleanerName = firstNonEmpty(p.a.cleaner_name, p.b?.cleaner_name, ...rows.map((x) => x.cleaner_name))
          const inspectorName = firstNonEmpty(p.a.inspector_name, p.b?.inspector_name, ...rows.map((x) => x.inspector_name))
          const inspectorAssigned = firstNonEmpty(p.a.__assignee_inspector, p.b?.__assignee_inspector, ...rows.map((x) => x.__assignee_inspector))
          const requireSelfComplete =
            roleKind === 'cleaner' &&
            (p.kind === 'checkout' || p.kind === 'turnover') &&
            !String(inspectorAssigned || '').trim()
          const completionAreas = new Set<string>()
          for (const sId of p.ids) {
            const arr = rows.filter((x) => String(x.__raw_id) === String(sId)).flatMap((x) => (Array.isArray(x.completion_areas) ? x.completion_areas : []))
            for (const a of arr) {
              const k = String(a || '').trim()
              if (k) completionAreas.add(k)
            }
          }
          const requiredAreas = ['toilet', 'living', 'sofa', 'bedroom', 'kitchen']
          const completionPhotosOk = requiredAreas.every((a) => completionAreas.has(a))
          const restockItems: any[] = []
          const seen = new Set<string>()
          for (const sId of p.ids) {
            const arr = rows.filter((x) => String(x.__raw_id) === String(sId)).flatMap((x) => (Array.isArray(x.restock_items) ? x.restock_items : []))
            for (const it of arr) {
              const iid = String(it?.item_id || it?.label || '').trim()
              if (!iid) continue
              if (seen.has(iid)) continue
              seen.add(iid)
              restockItems.push(it)
            }
          }
          const raw = String(p.a.raw_status ?? '').trim().toLowerCase()
          const isDoneLike = raw === 'cleaned' || raw === 'restock_pending' || raw === 'restocked' || raw === 'ready' || raw === 'inspected'
          const nightsFor = (x: any) => {
            const n0 =
              x?.nights_override != null
                ? Number(x.nights_override)
                : x?.order_nights != null
                  ? Number(x.order_nights)
                  : null
            if (Number.isFinite(n0 as any)) return Math.max(0, Math.trunc(n0 as any))
            const d0 = daysBetweenYmd(x?.order_checkin, x?.order_checkout)
            return d0 == null ? null : Math.max(0, Math.trunc(d0))
          }
          const stayedAndRemaining = (() => {
            if (p.kind === 'turnover') return { stayed: nightsFor(p.a), remaining: nightsFor(p.b) }
            if (p.kind === 'checkout') return { stayed: nightsFor(p.a), remaining: 0 }
            if (p.kind === 'checkin') return { stayed: 0, remaining: nightsFor(p.a) }
            if (p.kind === 'stayover') {
              const total = nightsFor(p.a)
              const r0 = computeStayedRemaining({ checkin: p.a.order_checkin, checkout: p.a.order_checkout, taskDate: date, nightsTotal: total })
              return { stayed: r0.stayed, remaining: r0.remaining }
            }
            return { stayed: null as number | null, remaining: null as number | null }
          })()
          const statusOut =
            roleKind === 'inspector'
              ? (lockboxVideoUrl ? 'keys_hung' : (raw === 'cleaned' || raw === 'restock_pending' ? 'to_inspect' : p.a.status))
              : (requireSelfComplete && isDoneLike && !lockboxVideoUrl ? 'to_hang_keys'
                  : requireSelfComplete && isDoneLike && !completionPhotosOk ? 'to_complete'
                    : (raw === 'cleaned' || raw === 'restock_pending' ? 'done' : p.a.status))
          const sortIndex =
            roleKind === 'cleaner'
              ? Math.min(...rows.map((x) => (x.sort_index_cleaner == null ? Number.POSITIVE_INFINITY : Number(x.sort_index_cleaner))).filter((x) => Number.isFinite(x)))
              : Math.min(...rows.map((x) => (x.sort_index_inspector == null ? Number.POSITIVE_INFINITY : Number(x.sort_index_inspector))).filter((x) => Number.isFinite(x)))
          const sort_index = Number.isFinite(sortIndex) && sortIndex !== Number.POSITIVE_INFINITY ? sortIndex : null
          const cleanerSortIndex = Math.min(...rows.map((x) => (x.sort_index_cleaner == null ? Number.POSITIVE_INFINITY : Number(x.sort_index_cleaner))).filter((x) => Number.isFinite(x)))
          const inspectorSortIndex = Math.min(...rows.map((x) => (x.sort_index_inspector == null ? Number.POSITIVE_INFINITY : Number(x.sort_index_inspector))).filter((x) => Number.isFinite(x)))
          const sort_index_cleaner = Number.isFinite(cleanerSortIndex) && cleanerSortIndex !== Number.POSITIVE_INFINITY ? cleanerSortIndex : null
          const sort_index_inspector = Number.isFinite(inspectorSortIndex) && inspectorSortIndex !== Number.POSITIVE_INFINITY ? inspectorSortIndex : null

          const outId = p.kind === 'turnover' ? `cleaning_tasks_${roleKind}_turnover:${date}:${propId || 'unknown'}:${assigneeId}` : `cleaning_tasks_${roleKind}:${p.ids.join(',')}`
          const primarySourceId = String(p.a.__raw_id)
          const checkoutKeys =
            p.kind === 'turnover' || p.kind === 'checkout'
              ? (p.a?.keys_required == null ? 1 : Number(p.a.keys_required))
              : null
          const checkinKeys =
            p.kind === 'turnover'
              ? (p.b?.keys_required == null ? 1 : Number(p.b.keys_required))
              : p.kind === 'checkin'
                ? (p.a?.keys_required == null ? 1 : Number(p.a.keys_required))
                : null
          const checkoutOrderId =
            (p.kind === 'turnover' || p.kind === 'checkout') && p.a?.order_id ? String(p.a.order_id) : null
          const checkinOrderId =
            p.kind === 'turnover'
              ? (p.b?.order_id ? String(p.b.order_id) : null)
              : (p.kind === 'checkin' && p.a?.order_id ? String(p.a.order_id) : null)
          const singleOrderId = p.kind === 'turnover' ? null : (p.a?.order_id ? String(p.a.order_id) : null)
          const checkoutKeysOut =
            checkoutOrderId && checkoutKeys != null && Number.isFinite(checkoutKeys) ? Math.max(1, Math.min(2, Math.trunc(checkoutKeys))) : null
          const checkinKeysOut =
            checkinOrderId && checkinKeys != null && Number.isFinite(checkinKeys) ? Math.max(1, Math.min(2, Math.trunc(checkinKeys))) : null

          return {
            id: outId,
            task_kind: roleKind === 'cleaner' ? 'cleaning' : 'inspection',
            source_type: 'cleaning_tasks',
            source_id: primarySourceId,
            source_ids: p.ids,
            order_id: singleOrderId,
            order_id_checkout: checkoutOrderId,
            order_id_checkin: checkinOrderId,
            property_id: propId,
            title: prop?.code || (propId ? String(propId) : primarySourceId),
            summary: summary || null,
            scheduled_date: date,
            start_time: checkoutTime || null,
            end_time: checkinTime || null,
            task_type: p.kind === 'turnover' ? 'turnover' : String(p.a.task_type || ''),
            assignee_id: assigneeId,
            inspector_id: inspectorAssigned ? String(inspectorAssigned) : null,
            status: statusOut,
            urgency: 'medium',
            sort_index,
            sort_index_cleaner,
            sort_index_inspector,
            old_code: oldCode,
            new_code: newCode,
            guest_special_request: guestSpecialRequest,
            keys_required: keysRequired,
            keys_required_checkout: checkoutKeysOut,
            keys_required_checkin: checkinKeysOut,
            checked_out_at: checkedOutAt,
            key_photo_url: keyPhotoUrl,
            lockbox_video_url: lockboxVideoUrl,
            restock_items: restockItems,
            completion_photos_ok: completionPhotosOk,
            stayed_nights: stayedAndRemaining.stayed,
            remaining_nights: stayedAndRemaining.remaining,
            cleaner_name: cleanerName,
            inspector_name: inspectorName,
            property: prop,
          }
        }

        for (const [k, rows] of cleanerGroups) {
          const parts = k.split('|')
          const assigneeId = parts[2] || ''
          if (!assigneeId) continue
          out.push(buildMerged('cleaner', rows, assigneeId))
        }

        for (const [k, rows] of inspectorGroups) {
          const parts = k.split('|')
          const assigneeId = parts[2] || ''
          if (!assigneeId) continue
          out.push(buildMerged('inspector', rows, assigneeId))
        }
      }
    }

    if (allowAll && (hasRole(user, 'customer_service') || hasRole(user, 'admin') || hasRole(user, 'offline_manager'))) {
      const merged: any[] = []
      const byKey = new Map<string, any[]>()
      for (const it of out) {
        const isCleaning = String(it?.source_type || '') === 'cleaning_tasks'
        const d = String(it?.scheduled_date || '').slice(0, 10)
        const code = String(it?.property?.code || '').trim()
        const pid = it?.property_id ? String(it.property_id) : ''
        const propKey = code || pid || String(it?.title || '').trim()
        if (!isCleaning || !d || !propKey) {
          merged.push(it)
          continue
        }
        const k = `${d}|${propKey}`
        const arr = byKey.get(k) || []
        arr.push(it)
        byKey.set(k, arr)
      }

      const rankStatus = (s0: any) => {
        const s = String(s0 || '').trim().toLowerCase()
        if (!s) return 50
        if (s === 'in_progress') return 10
        if (s === 'to_hang_keys') return 12
        if (s === 'to_complete') return 13
        if (s === 'to_inspect') return 15
        if (s === 'to_clean') return 20
        if (s === 'checked_out') return 25
        if (s === 'keys_hung') return 80
        if (s === 'done') return 90
        return 60
      }

      for (const [k, arr0] of byKey) {
        const arr = (arr0 || []).filter(Boolean)
        if (!arr.length) continue
        const preferred = arr.find((x) => String(x?.task_kind || '') === 'inspection') || arr[0]
        const [d, propKey] = k.split('|')
        const srcIds = Array.from(new Set(arr.flatMap((x) => (Array.isArray(x?.source_ids) ? x.source_ids : []))))
        const cleaningTaskIds = Array.from(
          new Set(arr.filter((x) => String(x?.task_kind || '') === 'cleaning').flatMap((x) => (Array.isArray(x?.source_ids) ? x.source_ids : []))),
        )
        const inspectionTaskIds = Array.from(
          new Set(arr.filter((x) => String(x?.task_kind || '') === 'inspection').flatMap((x) => (Array.isArray(x?.source_ids) ? x.source_ids : []))),
        )
        const cleaningStatus = (arr.find((x) => String(x?.task_kind || '') === 'cleaning') || null)?.status || null
        const inspectionStatus = (arr.find((x) => String(x?.task_kind || '') === 'inspection') || null)?.status || null
        const startTime = firstNonEmpty(...arr.map((x) => x.start_time))
        const endTime = firstNonEmpty(...arr.map((x) => x.end_time))
        const keyPhotoUrl = firstNonEmpty(...arr.map((x) => x.key_photo_url))
        const lockboxVideoUrl = firstNonEmpty(...arr.map((x) => x.lockbox_video_url))
        const keysRequired = Math.max(...arr.map((x) => (x?.keys_required == null ? 1 : Number(x.keys_required))).filter((x) => Number.isFinite(x) && x > 0), 1)
        const checkoutKeys = Math.max(
          ...arr.map((x) => (x?.keys_required_checkout == null ? 0 : Number(x.keys_required_checkout))).filter((x) => Number.isFinite(x) && x > 0),
          0,
        )
        const checkinKeys = Math.max(
          ...arr.map((x) => (x?.keys_required_checkin == null ? 0 : Number(x.keys_required_checkin))).filter((x) => Number.isFinite(x) && x > 0),
          0,
        )
        const orderIdCheckin = firstNonEmpty(
          ...arr.map((x) => x.order_id_checkin),
          ...arr.map((x) => (String(x?.task_type || '').trim().toLowerCase() === 'checkin_clean' ? x.order_id : null)),
        )
        const orderIdCheckout = firstNonEmpty(
          ...arr.map((x) => x.order_id_checkout),
          ...arr.map((x) => (String(x?.task_type || '').trim().toLowerCase() === 'checkout_clean' ? x.order_id : null)),
        )
        const checkoutKeysOut = orderIdCheckout && checkoutKeys ? checkoutKeys : null
        const checkinKeysOut = orderIdCheckin && checkinKeys ? checkinKeys : null
        const cleanerName = firstNonEmpty(...arr.map((x) => x.cleaner_name))
        const inspectorName = firstNonEmpty(...arr.map((x) => x.inspector_name))
        const restockItems: any[] = []
        const seenRestock = new Set<string>()
        for (const it of arr.flatMap((x) => (Array.isArray(x?.restock_items) ? x.restock_items : []))) {
          const iid = String(it?.item_id || it?.label || '').trim()
          if (!iid) continue
          if (seenRestock.has(iid)) continue
          seenRestock.add(iid)
          restockItems.push(it)
        }
        const statusOut =
          cleaningStatus && rankStatus(cleaningStatus) < 80
            ? cleaningStatus
            : inspectionStatus
              ? inspectionStatus
              : arr
                  .map((x) => x.status)
                  .sort((a: any, b: any) => rankStatus(a) - rankStatus(b))[0]

        merged.push({
          ...preferred,
          id: `cleaning_tasks_merged:${d}:${propKey}`,
          start_time: startTime || null,
          end_time: endTime || null,
          task_kind: arr.some((x) => String(x?.task_kind || '') === 'inspection') ? 'inspection' : 'cleaning',
          source_ids: srcIds.length ? srcIds : (Array.isArray(preferred?.source_ids) ? preferred.source_ids : undefined),
          cleaning_task_ids: cleaningTaskIds,
          inspection_task_ids: inspectionTaskIds,
          cleaning_status: cleaningStatus,
          inspection_status: inspectionStatus,
          assignee_id: null,
          status: statusOut,
          key_photo_url: keyPhotoUrl,
          lockbox_video_url: lockboxVideoUrl,
          order_id: null,
          order_id_checkin: orderIdCheckin || null,
          order_id_checkout: orderIdCheckout || null,
          keys_required: keysRequired,
          keys_required_checkout: checkoutKeysOut,
          keys_required_checkin: checkinKeysOut,
          cleaner_name: cleanerName,
          inspector_name: inspectorName,
          restock_items: restockItems,
        })
      }

      out.length = 0
      out.push(...merged)
    }

    out.sort((a, b) => {
      const ad = String(a.scheduled_date || '')
      const bd = String(b.scheduled_date || '')
      const d = ad.localeCompare(bd)
      if (d) return d
      const aIsCleaning = String(a.source_type || '') === 'cleaning_tasks'
      const bIsCleaning = String(b.source_type || '') === 'cleaning_tasks'
      if (aIsCleaning && bIsCleaning) {
        if (allowAll) {
          const aa = String(a.assignee_id || '')
          const ba = String(b.assignee_id || '')
          const u0 = aa.localeCompare(ba)
          if (u0) return u0
        }
        const ai = a.sort_index == null ? Number.POSITIVE_INFINITY : Number(a.sort_index)
        const bi = b.sort_index == null ? Number.POSITIVE_INFINITY : Number(b.sort_index)
        const o = ai - bi
        if (o) return o
      } else {
        const ur = urgencyRank(String(b.urgency || '')) - urgencyRank(String(a.urgency || ''))
        if (ur) return ur
      }
      return String(a.title || '').localeCompare(String(b.title || ''))
    })

    return res.json(out)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'mzapp_work_tasks_failed' })
  }
})

const dailyNecessitiesStatusSchema = z.enum(['need_replace', 'in_progress', 'replaced', 'no_action'])

const feedbackCreateSchema = z
  .object({
    kind: z.enum(['maintenance', 'deep_cleaning', 'daily_necessities']),
    property_id: z.string().min(1),
    source_task_id: z.string().optional(),

    area: z.string().optional(),
    areas: z.array(z.string().min(1)).optional(),
    category: z.string().optional(),
    detail: z.string().optional(),
    media_urls: z.array(z.string().min(1)).optional(),

    items: z
      .array(
        z.object({
          area: z.string().min(1),
          category: z.string().min(1),
          detail: z.string().min(1),
          media_urls: z.array(z.string().min(1)).optional(),
        }),
      )
      .optional(),

    status: dailyNecessitiesStatusSchema.optional(),
    item_name: z.string().optional(),
    quantity: z
      .preprocess((v) => {
        if (v == null) return v
        if (typeof v === 'number') return v
        const n = Number(v)
        return Number.isFinite(n) ? n : v
      }, z.number().int())
      .optional(),
    note: z.string().optional(),
  })
  .strict()

function mapWorkStatus(raw: any): 'open' | 'in_progress' | 'resolved' | 'cancelled' {
  const s = String(raw ?? '').trim().toLowerCase()
  if (s === 'in_progress') return 'in_progress'
  if (s === 'completed' || s === 'done' || s === 'ready') return 'resolved'
  if (s === 'canceled' || s === 'cancelled') return 'cancelled'
  return 'open'
}

const colTypeCache = new Map<string, 'jsonb' | 'text[]' | 'unknown'>()

async function getColumnType(table: string, column: string): Promise<'jsonb' | 'text[]' | 'unknown'> {
  if (!pgPool) return 'unknown'
  const key = `${table}.${column}`
  const cached = colTypeCache.get(key)
  if (cached) return cached
  try {
    const r = await pgPool.query(
      `SELECT data_type, udt_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = $1
          AND column_name = $2
        LIMIT 1`,
      [table, column],
    )
    const row = r.rows?.[0]
    const dataType = String(row?.data_type || '').trim().toLowerCase()
    const udt = String(row?.udt_name || '').trim().toLowerCase()
    const t: 'jsonb' | 'text[]' | 'unknown' =
      dataType === 'jsonb' || udt === 'jsonb' ? 'jsonb' : udt === '_text' ? 'text[]' : 'unknown'
    colTypeCache.set(key, t)
    return t
  } catch {
    colTypeCache.set(key, 'unknown')
    return 'unknown'
  }
}

function sha256Hex(input: string) {
  return crypto.createHash('sha256').update(input).digest('hex')
}

function normalizeForFingerprint(input: any) {
  const s0 = String(input ?? '').trim()
  if (!s0) return ''
  const s1 = s0.replace(/\s+/g, ' ')
  const s2 = s1.replace(/[，。！？、,.!?;:()（）【】\[\]{}'"“”‘’\-_/\\]+/g, ' ')
  return s2.replace(/\s+/g, ' ').trim().toLowerCase()
}

function makeFeedbackFingerprint(args: {
  kind: 'maintenance' | 'deep_cleaning'
  property_id: string
  area?: string
  category_detail?: string
  areas?: string[]
  detail?: string
}) {
  const pid = String(args.property_id || '').trim()
  const kind = args.kind
  const detail = normalizeForFingerprint(args.detail).slice(0, 160)
  if (kind === 'maintenance') {
    const area = String(args.area || '').trim()
    const cat = String(args.category_detail || '').trim()
    return sha256Hex([pid, kind, area, cat, detail].join('|'))
  }
  const areas = (args.areas || []).map((s) => String(s || '').trim()).filter(Boolean).sort()
  return sha256Hex([pid, kind, areas.join(','), detail].join('|'))
}

async function ensurePropertyMaintenanceColumns() {
  if (!pgPool) return
  await pgPool.query(`CREATE TABLE IF NOT EXISTS property_maintenance (
    id text PRIMARY KEY,
    property_id text,
    occurred_at date,
    worker_name text,
    details text,
    notes text,
    created_by text,
    created_at timestamptz DEFAULT now()
  );`)
  await pgPool.query('ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS property_code text;')
  await pgPool.query('ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS status text;')
  await pgPool.query('ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS submitted_at timestamptz;')
  await pgPool.query('ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS submitter_name text;')
  await pgPool.query('ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS category text;')
  await pgPool.query('ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS category_detail text;')
  await pgPool.query('ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS photo_urls jsonb;')
  await pgPool.query('ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS area text;')
  await pgPool.query('ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS work_no text;')
  await pgPool.query('ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS dedup_fingerprint text;')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_property_maintenance_dedup ON property_maintenance(property_id, dedup_fingerprint, submitted_at);')
}

async function ensurePropertyDeepCleaningColumns() {
  if (!pgPool) return
  await pgPool.query(`CREATE TABLE IF NOT EXISTS property_deep_cleaning (
    id text PRIMARY KEY,
    property_id text,
    occurred_at date,
    details text,
    notes text,
    created_by text,
    created_at timestamptz DEFAULT now()
  );`)
  await pgPool.query('ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS property_code text;')
  await pgPool.query('ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS status text;')
  await pgPool.query('ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS submitted_at timestamptz;')
  await pgPool.query('ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS submitter_name text;')
  await pgPool.query('ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS project_desc text;')
  await pgPool.query('ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS photo_urls jsonb;')
  await pgPool.query('ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS attachment_urls jsonb;')
  await pgPool.query('ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS work_no text;')
  await pgPool.query('ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS dedup_fingerprint text;')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_property_deep_cleaning_dedup ON property_deep_cleaning(property_id, dedup_fingerprint, submitted_at);')
}

async function ensurePropertyDailyNecessitiesColumns() {
  if (!pgPool) return
  await pgPool.query(`CREATE TABLE IF NOT EXISTS property_daily_necessities (
    id text PRIMARY KEY,
    property_id text,
    created_by text,
    created_at timestamptz DEFAULT now()
  );`)
  await pgPool.query('ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS property_code text;')
  await pgPool.query('ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS status text;')
  await pgPool.query('ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS item_name text;')
  await pgPool.query('ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS quantity integer;')
  await pgPool.query('ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS note text;')
  await pgPool.query('ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS photo_urls jsonb;')
  await pgPool.query('ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS source_task_id text;')
  await pgPool.query('ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS submitted_at timestamptz;')
  await pgPool.query('ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS submitter_name text;')
  await pgPool.query('ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS dedup_fingerprint text;')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_property_daily_necessities_prop ON property_daily_necessities(property_id);')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_property_daily_necessities_status ON property_daily_necessities(status);')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_property_daily_necessities_created_at ON property_daily_necessities(created_at);')
}

router.get('/property-feedbacks', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  const propertyId = String((req.query as any)?.property_id || '').trim()
  const propertyCode = String((req.query as any)?.property_code || '').trim()
  if (!propertyId && !propertyCode) return res.status(400).json({ message: 'missing property_id' })

  const statusRaw = String((req.query as any)?.status || 'open,in_progress').trim()
  const want = statusRaw
    .split(',')
    .map((s) => String(s || '').trim())
    .filter(Boolean)

  const wantOpen = want.length ? want.includes('open') : true
  const wantInProgress = want.length ? want.includes('in_progress') : true
  const wantResolved = want.length ? want.includes('resolved') : false
  const wantCancelled = want.length ? want.includes('cancelled') : false
  const openView = wantOpen && wantInProgress && !wantResolved && !wantCancelled

  const dailyStatusSet = new Set(['need_replace', 'in_progress', 'replaced', 'no_action'])
  const dailyWanted = want.filter((s) => dailyStatusSet.has(String(s || '').trim()))
  const dailyFilter = dailyWanted.length ? dailyWanted : ['need_replace', 'in_progress']

  const limit0 = Number((req.query as any)?.limit || 20)
  const limit = Number.isFinite(limit0) ? Math.max(1, Math.min(50, limit0)) : 20

  try {
    if (!hasPg || !pgPool) return res.json([])
    const out: any[] = []
    const errors: string[] = []

    const unresolvedMaintSql = openView
      ? `(m.status IS NULL OR lower(m.status) NOT IN ('completed','done','ready','canceled','cancelled'))`
      : `true`
    const unresolvedDeepSql = openView
      ? `(d.status IS NULL OR lower(d.status) NOT IN ('completed','done','ready','canceled','cancelled'))`
      : `true`
    const unresolvedRepairSql = openView
      ? `(r.status IS NULL OR lower(r.status) NOT IN ('completed','done','ready','canceled','cancelled'))`
      : `true`

    try {
      try {
        await ensurePropertyMaintenanceColumns()
      } catch {}
      const r = await pgPool.query(
        `SELECT m.id, m.property_id, COALESCE(m.property_code, p.code) AS property_code,
                m.area, m.category, m.category_detail, m.details, m.notes, m.photo_urls, m.submitter_name,
                m.submitted_at, m.created_at, m.status
           FROM property_maintenance m
           LEFT JOIN properties p ON p.id = m.property_id
          WHERE (
              ($1::text IS NOT NULL AND m.property_id = $1)
              OR (
                $2::text IS NOT NULL
                AND (
                  COALESCE(m.property_code, p.code) = $2
                  OR m.property_id = $2
                  OR m.property_id IN (SELECT id FROM properties WHERE code = $2 LIMIT 5)
                )
              )
            )
            AND (${unresolvedMaintSql})
          ORDER BY COALESCE(m.submitted_at, m.created_at) DESC
          LIMIT $3`,
        [propertyId || null, propertyCode || null, limit],
      )
      for (const row of (r?.rows || [])) {
        const mapped = mapWorkStatus(row.status)
        out.push({
          id: String(row.id),
          property_id: row.property_id ? String(row.property_id) : propertyId || null,
          kind: 'maintenance',
          area: row.area || null,
          category: row.category_detail || row.category || null,
          detail: String(row.notes || row.details || ''),
          media_urls: Array.isArray(row.photo_urls) ? row.photo_urls : row.photo_urls ? row.photo_urls : [],
          created_by_name: row.submitter_name || null,
          created_at: row.submitted_at || row.created_at || null,
          status: mapped,
        })
      }
    } catch (e: any) {
      errors.push(`maintenance:${String(e?.message || e)}`.slice(0, 220))
    }

    try {
      const r = await pgPool.query(
        `SELECT r.id, r.property_id, p.code AS property_code,
                r.category, r.category_detail, r.detail, r.remark, r.attachment_urls, r.submitter_name,
                r.submitted_at, r.created_at, r.status
           FROM repair_orders r
           LEFT JOIN properties p ON p.id = r.property_id
          WHERE (($1::text IS NOT NULL AND r.property_id = $1) OR ($2::text IS NOT NULL AND p.code = $2))
            AND (${unresolvedRepairSql})
          ORDER BY COALESCE(r.submitted_at, r.created_at) DESC
          LIMIT $3`,
        [propertyId || null, propertyCode || null, limit],
      )
      for (const row of (r?.rows || [])) {
        const mapped = mapWorkStatus(row.status)
        out.push({
          id: String(row.id),
          property_id: row.property_id ? String(row.property_id) : propertyId || null,
          kind: 'maintenance',
          area: null,
          category: row.category_detail || row.category || null,
          detail: String(row.detail || row.remark || ''),
          media_urls: Array.isArray(row.attachment_urls) ? row.attachment_urls : row.attachment_urls ? row.attachment_urls : [],
          created_by_name: row.submitter_name || null,
          created_at: row.submitted_at || row.created_at || null,
          status: mapped,
        })
      }
    } catch (e: any) {
      errors.push(`repair_orders:${String(e?.message || e)}`.slice(0, 220))
    }

    try {
      try {
        await ensurePropertyDeepCleaningColumns()
      } catch {}
      const r = await pgPool.query(
        `SELECT d.id, d.property_id, COALESCE(d.property_code, p.code) AS property_code,
                d.project_desc, d.details, d.notes, d.photo_urls, d.attachment_urls, d.submitter_name,
                d.submitted_at, d.created_at, d.status
           FROM property_deep_cleaning d
           LEFT JOIN properties p ON p.id = d.property_id
          WHERE (
              ($1::text IS NOT NULL AND d.property_id = $1)
              OR (
                $2::text IS NOT NULL
                AND (
                  COALESCE(d.property_code, p.code) = $2
                  OR d.property_id = $2
                  OR d.property_id IN (SELECT id FROM properties WHERE code = $2 LIMIT 5)
                )
              )
            )
            AND (${unresolvedDeepSql})
          ORDER BY COALESCE(d.submitted_at, d.created_at) DESC
          LIMIT $3`,
        [propertyId || null, propertyCode || null, limit],
      )
      for (const row of (r?.rows || [])) {
        const mapped = mapWorkStatus(row.status)
        const areas = String(row.project_desc || '')
          .split('、')
          .map((s) => String(s || '').trim())
          .filter(Boolean)
        const media =
          Array.isArray(row.attachment_urls) && row.attachment_urls.length
            ? row.attachment_urls
            : Array.isArray(row.photo_urls)
              ? row.photo_urls
              : []
        out.push({
          id: String(row.id),
          property_id: row.property_id ? String(row.property_id) : propertyId || null,
          kind: 'deep_cleaning',
          areas,
          detail: String(row.details || row.notes || ''),
          media_urls: media,
          created_by_name: row.submitter_name || null,
          created_at: row.submitted_at || row.created_at || null,
          status: mapped,
        })
      }
    } catch (e: any) {
      errors.push(`deep_cleaning:${String(e?.message || e)}`.slice(0, 220))
    }

    try {
      try {
        await ensurePropertyDailyNecessitiesColumns()
      } catch {}
      const params: any[] = [propertyId || null, propertyCode || null, dailyFilter, limit]
      const r = await pgPool.query(
        `SELECT n.id, n.property_id, COALESCE(n.property_code, p.code) AS property_code,
                n.status, n.item_name, n.quantity, n.note, n.photo_urls, n.submitter_name,
                n.submitted_at, n.created_at
           FROM property_daily_necessities n
           LEFT JOIN properties p ON p.id = n.property_id
          WHERE (
              ($1::text IS NOT NULL AND n.property_id = $1)
              OR (
                $2::text IS NOT NULL
                AND (
                  COALESCE(n.property_code, p.code) = $2
                  OR n.property_id = $2
                  OR n.property_id IN (SELECT id FROM properties WHERE code = $2 LIMIT 5)
                )
              )
            )
            AND COALESCE(n.status, '') = ANY($3::text[])
          ORDER BY COALESCE(n.submitted_at, n.created_at) DESC
          LIMIT $4`,
        params,
      )
      for (const row of (r?.rows || [])) {
        out.push({
          id: String(row.id),
          property_id: row.property_id ? String(row.property_id) : propertyId || null,
          kind: 'daily_necessities',
          status: String(row.status || '').trim(),
          item_name: row.item_name ? String(row.item_name) : null,
          quantity: row.quantity == null ? null : Number(row.quantity),
          note: row.note ? String(row.note) : null,
          detail: String(row.note || ''),
          media_urls: Array.isArray(row.photo_urls) ? row.photo_urls : row.photo_urls ? row.photo_urls : [],
          created_by_name: row.submitter_name || null,
          created_at: row.submitted_at || row.created_at || null,
        })
      }
    } catch (e: any) {
      errors.push(`daily_necessities:${String(e?.message || e)}`.slice(0, 220))
    }

    out.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
    if (!out.length && errors.length) return res.status(500).json({ message: 'property_feedbacks_failed', errors })
    return res.json(out.slice(0, limit))
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'property_feedbacks_failed' })
  }
})

router.post('/property-feedbacks', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  const parsed = feedbackCreateSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'pg not available' })
    const now = new Date()
    const createdAt = now.toISOString()
    const occurredAt = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const submitterName = String(user.username || user.sub || '').trim() || 'unknown'
    const createdBy = String(user.sub || '').trim() || submitterName
    const id = require('uuid').v4()
    const duplicateWindowHours = 24

    if (parsed.data.kind === 'maintenance') {
      try {
        await ensurePropertyMaintenanceColumns()
      } catch {}
      const photoType = await getColumnType('property_maintenance', 'photo_urls')
      const photoExpr = photoType === 'jsonb' ? '$13::jsonb' : photoType === 'text[]' ? '$13::text[]' : '$13'

      const items = Array.isArray((parsed.data as any).items) && (parsed.data as any).items.length ? ((parsed.data as any).items as any[]) : null
      const prepared = (items || []).map((x) => ({
        area: String(x?.area || '').trim(),
        category: String(x?.category || '').trim(),
        detail: String(x?.detail || '').trim(),
        media_urls: Array.isArray(x?.media_urls) ? (x.media_urls as any[]) : [],
      }))

      if (items) {
        for (const it of prepared) {
          if (!it.area) return res.status(400).json({ message: 'missing area' })
          if (!it.category) return res.status(400).json({ message: 'missing category' })
          if (!it.detail) return res.status(400).json({ message: 'missing detail' })
        }
        for (const it of prepared) {
          const fingerprint = makeFeedbackFingerprint({
            kind: 'maintenance',
            property_id: parsed.data.property_id,
            area: it.area,
            category_detail: it.category,
            detail: it.detail,
          })
          const dup = await pgPool.query(
            `SELECT id
               FROM property_maintenance
              WHERE property_id = $1
                AND dedup_fingerprint = $2
                AND (status IS NULL OR lower(status) NOT IN ('completed','done','ready','canceled','cancelled'))
                AND COALESCE(submitted_at, created_at) >= now() - ($3::int * interval '1 hour')
              ORDER BY COALESCE(submitted_at, created_at) DESC
              LIMIT 1`,
            [parsed.data.property_id, fingerprint, duplicateWindowHours],
          )
          if (dup.rowCount) return res.status(409).json({ message: 'duplicate', existing_id: String(dup.rows[0].id) })
        }

        const createdIds: string[] = []
        for (const it of prepared) {
          const rowId = require('uuid').v4()
          const workNo = makeWorkNo('R', occurredAt)
          const fingerprint = makeFeedbackFingerprint({
            kind: 'maintenance',
            property_id: parsed.data.property_id,
            area: it.area,
            category_detail: it.category,
            detail: it.detail,
          })
          const photoValue = photoType === 'jsonb' ? JSON.stringify(it.media_urls || []) : (it.media_urls || [])
          await pgPool.query(
            `INSERT INTO property_maintenance(
              id, property_id, occurred_at, details, notes, created_by, created_at,
              status, submitted_at, submitter_name, category, category_detail, photo_urls, work_no, area, dedup_fingerprint
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,${photoExpr},$14,$15,$16)
            RETURNING id`,
            [
              rowId,
              parsed.data.property_id,
              occurredAt,
              it.detail,
              it.detail,
              createdBy,
              createdAt,
              'pending',
              createdAt,
              submitterName,
              it.area,
              it.category,
              photoValue,
              workNo,
              it.area,
              fingerprint,
            ],
          )
          createdIds.push(rowId)
        }
        return res.status(201).json({ ok: true, ids: createdIds })
      }

      const area = String(parsed.data.area || '').trim()
      const categoryLabel = String(parsed.data.category || '').trim()
      const detail = String((parsed.data as any).detail || '').trim()
      if (!area) return res.status(400).json({ message: 'missing area' })
      if (!categoryLabel) return res.status(400).json({ message: 'missing category' })
      if (!detail) return res.status(400).json({ message: 'missing detail' })
      const mediaUrls = (parsed.data as any).media_urls || []
      const photoValue = photoType === 'jsonb' ? JSON.stringify(mediaUrls) : mediaUrls
      const workNo = makeWorkNo('R', occurredAt)
      const fingerprint = makeFeedbackFingerprint({
        kind: 'maintenance',
        property_id: parsed.data.property_id,
        area,
        category_detail: categoryLabel,
        detail,
      })
      const dup = await pgPool.query(
        `SELECT id
           FROM property_maintenance
          WHERE property_id = $1
            AND dedup_fingerprint = $2
            AND (status IS NULL OR lower(status) NOT IN ('completed','done','ready','canceled','cancelled'))
            AND COALESCE(submitted_at, created_at) >= now() - ($3::int * interval '1 hour')
          ORDER BY COALESCE(submitted_at, created_at) DESC
          LIMIT 1`,
        [parsed.data.property_id, fingerprint, duplicateWindowHours],
      )
      if (dup.rowCount) return res.status(409).json({ message: 'duplicate', existing_id: String(dup.rows[0].id) })
      await pgPool.query(
        `INSERT INTO property_maintenance(
          id, property_id, occurred_at, details, notes, created_by, created_at,
          status, submitted_at, submitter_name, category, category_detail, photo_urls, work_no, area, dedup_fingerprint
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,${photoExpr},$14,$15,$16)
        RETURNING id`,
        [
          id,
          parsed.data.property_id,
          occurredAt,
          detail,
          detail,
          createdBy,
          createdAt,
          'pending',
          createdAt,
          submitterName,
          area,
          categoryLabel,
          photoValue,
          workNo,
          area,
          fingerprint,
        ],
      )
      return res.status(201).json({ ok: true, id })
    }

    if (parsed.data.kind === 'daily_necessities') {
      try {
        await ensurePropertyDailyNecessitiesColumns()
      } catch {}
      const status = String((parsed.data as any).status || '').trim()
      const itemName = String((parsed.data as any).item_name || '').trim()
      const quantity0 = (parsed.data as any).quantity
      const quantity = quantity0 == null ? NaN : Number(quantity0)
      const note = String((parsed.data as any).note || '').trim()
      const mediaUrls = Array.isArray((parsed.data as any).media_urls) ? (parsed.data as any).media_urls : []
      if (!dailyNecessitiesStatusSchema.safeParse(status).success) return res.status(400).json({ message: 'invalid status' })
      if (!itemName) return res.status(400).json({ message: 'missing item_name' })
      if (!Number.isFinite(quantity) || quantity < 1) return res.status(400).json({ message: 'invalid quantity' })
      if (!note && !mediaUrls.length) return res.status(400).json({ message: 'missing note' })

      const fingerprint = sha256Hex([parsed.data.property_id, status, normalizeForFingerprint(itemName), String(quantity), normalizeForFingerprint(note)].join('|'))
      const dup = await pgPool.query(
        `SELECT id
           FROM property_daily_necessities
          WHERE property_id = $1
            AND dedup_fingerprint = $2
            AND COALESCE(submitted_at, created_at) >= now() - ($3::int * interval '1 hour')
          ORDER BY COALESCE(submitted_at, created_at) DESC
          LIMIT 1`,
        [parsed.data.property_id, fingerprint, duplicateWindowHours],
      )
      if (dup.rowCount) return res.status(409).json({ message: 'duplicate', existing_id: String(dup.rows[0].id) })

      await pgPool.query(
        `INSERT INTO property_daily_necessities(
          id, property_id, status, item_name, quantity, note, photo_urls,
          source_task_id, created_by, created_at, submitted_at, submitter_name, dedup_fingerprint
        ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13)
        RETURNING id`,
        [
          id,
          parsed.data.property_id,
          status,
          itemName,
          Math.trunc(quantity),
          note || null,
          JSON.stringify(mediaUrls),
          (parsed.data as any).source_task_id || null,
          createdBy,
          createdAt,
          createdAt,
          submitterName,
          fingerprint,
        ],
      )
      return res.status(201).json({ ok: true, id })
    }

    const areas = parsed.data.areas || []
    if (!areas.length) return res.status(400).json({ message: 'missing areas' })
    const mediaUrls = parsed.data.media_urls || []
    if (!mediaUrls.length) return res.status(400).json({ message: 'missing photos' })
    const detail = String((parsed.data as any).detail || '').trim()
    if (!detail) return res.status(400).json({ message: 'missing detail' })
    const projectDesc = areas.join('、')
    const deepPhotoType = await getColumnType('property_deep_cleaning', 'photo_urls')
    const deepAttachType = await getColumnType('property_deep_cleaning', 'attachment_urls')
    const photoExpr = deepPhotoType === 'jsonb' ? '$12::jsonb' : deepPhotoType === 'text[]' ? '$12::text[]' : '$12'
    const attachExpr = deepAttachType === 'jsonb' ? '$13::jsonb' : deepAttachType === 'text[]' ? '$13::text[]' : '$13'
    const photoValue = deepPhotoType === 'jsonb' ? JSON.stringify(mediaUrls) : mediaUrls
    const attachValue = deepAttachType === 'jsonb' ? JSON.stringify(mediaUrls) : mediaUrls
    const workNo = makeWorkNo('DC', occurredAt)
    await pgPool.query('ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS dedup_fingerprint text;')
    const fingerprint = makeFeedbackFingerprint({
      kind: 'deep_cleaning',
      property_id: parsed.data.property_id,
      areas,
      detail,
    })
    const dup = await pgPool.query(
      `SELECT id
         FROM property_deep_cleaning
        WHERE property_id = $1
          AND dedup_fingerprint = $2
          AND (status IS NULL OR lower(status) NOT IN ('completed','done','ready','canceled','cancelled'))
          AND COALESCE(submitted_at, created_at) >= now() - ($3::int * interval '1 hour')
        ORDER BY COALESCE(submitted_at, created_at) DESC
        LIMIT 1`,
      [parsed.data.property_id, fingerprint, duplicateWindowHours],
    )
    if (dup.rowCount) return res.status(409).json({ message: 'duplicate', existing_id: String(dup.rows[0].id) })
    await pgPool.query(
      `INSERT INTO property_deep_cleaning(
        id, property_id, occurred_at, project_desc, details, created_by, created_at,
        status, submitted_at, submitter_name, work_no, photo_urls, attachment_urls, review_status, dedup_fingerprint
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,${photoExpr},${attachExpr},$14,$15)
      RETURNING id`,
      [
        id,
        parsed.data.property_id,
        occurredAt,
        projectDesc,
        detail,
        createdBy,
        createdAt,
        'pending',
        createdAt,
        submitterName,
        workNo,
        photoValue,
        attachValue,
        'pending',
        fingerprint,
      ],
    )
    try {
      await pgPool.query(
        `UPDATE property_deep_cleaning
            SET work_no = COALESCE(NULLIF(work_no, ''), $2)
          WHERE id = $1`,
        [id, workNo],
      )
    } catch {}
    return res.status(201).json({ ok: true, id })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'property_feedbacks_create_failed' })
  }
})

function urgencyRank(u: string) {
  const s = String(u || '').trim().toLowerCase()
  if (s === 'urgent') return 3
  if (s === 'high') return 2
  if (s === 'medium') return 1
  return 0
}
