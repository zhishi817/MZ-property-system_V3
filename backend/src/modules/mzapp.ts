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

function canViewAll(role: string) {
  return role === 'admin' || role === 'offline_manager' || role === 'customer_service'
}

function isCleanerRole(role: string) {
  return role === 'cleaner'
}

function isInspectorRole(role: string) {
  return role === 'cleaning_inspector'
}

function isCleanerInspectorRole(role: string) {
  return role === 'cleaner_inspector'
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
  const role = String(user.role || '')
  const userId = String(user.sub || '')
  const kind = String(req.body?.kind || '').trim().toLowerCase()
  const date = dayOnly(req.body?.date)
  const groups = Array.isArray(req.body?.groups) ? req.body.groups : null
  if (!date) return res.status(400).json({ message: 'invalid date' })
  if (kind !== 'cleaner' && kind !== 'inspector') return res.status(400).json({ message: 'invalid kind' })
  if (!groups || !groups.length) return res.status(400).json({ message: 'groups required' })

  if (kind === 'cleaner') {
    if (!(isCleanerRole(role) || isCleanerInspectorRole(role))) return res.status(403).json({ message: 'forbidden' })
  } else {
    if (!(isInspectorRole(role) || isCleanerInspectorRole(role))) return res.status(403).json({ message: 'forbidden' })
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
  const role = String(user.role || '')
  const userId = String(user.sub || '')
  const id = String(req.params.id || '').trim()
  const mediaUrl = String(req.body?.media_url || '').trim()
  if (!id) return res.status(400).json({ message: 'missing id' })
  if (!mediaUrl) return res.status(400).json({ message: 'missing media_url' })
  if (!(isInspectorRole(role) || isCleanerInspectorRole(role) || canViewAll(role))) return res.status(403).json({ message: 'forbidden' })
  if (!hasPg || !pgPool) return res.status(500).json({ message: 'pg not available' })
  try {
    await ensureCleaningTaskMediaTable()
    const r0 = await pgPool.query('SELECT id, inspector_id FROM cleaning_tasks WHERE id=$1 LIMIT 1', [id])
    const row = r0?.rows?.[0] || null
    if (!row) return res.status(404).json({ message: 'not found' })
    const inspectorId = row.inspector_id ? String(row.inspector_id) : ''
    if (!canViewAll(role) && inspectorId !== userId) return res.status(403).json({ message: 'forbidden' })

    const uuid = require('uuid')
    await pgPool.query(
      `INSERT INTO cleaning_task_media (id, task_id, type, url, captured_at, uploader_id)
       VALUES ($1,$2,'lockbox_video',$3,now(),$4)`,
      [uuid.v4(), id, mediaUrl, userId],
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
      const { notifyExpoAll } = require('./notifications')
      await notifyExpoAll({ exclude_user_id: userId, title: '挂钥匙视频已上传', body: '检查员已上传挂钥匙视频', data: { kind: 'lockbox_video_uploaded', task_id: id, event_id: `lockbox_video_uploaded:${id}:${Date.now()}` } })
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
  const role = String(user.role || '')
  const userId = String(user.sub || '')
  const id = String(req.params.id || '').trim()
  if (!id) return res.status(400).json({ message: 'missing id' })
  if (!(isInspectorRole(role) || isCleanerInspectorRole(role) || canViewAll(role))) return res.status(403).json({ message: 'forbidden' })
  if (!hasPg || !pgPool) return res.status(500).json({ message: 'pg not available' })
  try {
    await ensureCleaningTaskMediaTable()
    const r0 = await pgPool.query('SELECT id, inspector_id, cleaner_id, assignee_id FROM cleaning_tasks WHERE id=$1 LIMIT 1', [id])
    const row = r0?.rows?.[0] || null
    if (!row) return res.status(404).json({ message: 'not found' })
    const inspectorId = row.inspector_id ? String(row.inspector_id) : ''
    const cleanerId = row.cleaner_id ? String(row.cleaner_id) : ''
    const assigneeId = row.assignee_id ? String(row.assignee_id) : ''
    if (!canViewAll(role) && inspectorId !== userId && cleanerId !== userId && assigneeId !== userId) return res.status(403).json({ message: 'forbidden' })

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
  const role = String(user.role || '')
  const userId = String(user.sub || '')
  const id = String(req.params.id || '').trim()
  if (!id) return res.status(400).json({ message: 'missing id' })
  if (!(isInspectorRole(role) || isCleanerInspectorRole(role) || canViewAll(role))) return res.status(403).json({ message: 'forbidden' })
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
    if (!canViewAll(role) && inspectorId !== userId && cleanerId !== userId && assigneeId !== userId) return res.status(403).json({ message: 'forbidden' })

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
      const { notifyExpoAll } = require('./notifications')
      await notifyExpoAll({ exclude_user_id: userId, title: '检查照片已提交', body: '检查员已上传检查照片', data: { kind: 'inspection_photos_saved', task_id: id, event_id: `inspection_photos_saved:${id}:${Date.now()}` } })
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
  const role = String(user.role || '')
  const userId = String(user.sub || '')
  const id = String(req.params.id || '').trim()
  if (!id) return res.status(400).json({ message: 'missing id' })
  if (!(isInspectorRole(role) || isCleanerInspectorRole(role) || canViewAll(role))) return res.status(403).json({ message: 'forbidden' })
  if (!hasPg || !pgPool) return res.status(500).json({ message: 'pg not available' })
  try {
    await ensureCleaningTaskMediaTable()
    const r0 = await pgPool.query('SELECT id, inspector_id, cleaner_id, assignee_id FROM cleaning_tasks WHERE id=$1 LIMIT 1', [id])
    const row = r0?.rows?.[0] || null
    if (!row) return res.status(404).json({ message: 'not found' })
    const inspectorId = row.inspector_id ? String(row.inspector_id) : ''
    const cleanerId = row.cleaner_id ? String(row.cleaner_id) : ''
    const assigneeId = row.assignee_id ? String(row.assignee_id) : ''
    if (!canViewAll(role) && inspectorId !== userId && cleanerId !== userId && assigneeId !== userId) return res.status(403).json({ message: 'forbidden' })

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
  const role = String(user.role || '')
  const userId = String(user.sub || '')
  const id = String(req.params.id || '').trim()
  if (!id) return res.status(400).json({ message: 'missing id' })
  if (!(isInspectorRole(role) || isCleanerInspectorRole(role) || canViewAll(role))) return res.status(403).json({ message: 'forbidden' })
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
    if (!canViewAll(role) && inspectorId !== userId && cleanerId !== userId && assigneeId !== userId) return res.status(403).json({ message: 'forbidden' })

    const uniq = new Set<string>()
    for (const it of parsed.data.items) {
      const k = String(it.item_id || '').trim()
      if (!k) continue
      if (uniq.has(k)) return res.status(400).json({ message: '重复 item_id', item_id: k })
      uniq.add(k)
    }

    await pgPool.query(`DELETE FROM cleaning_task_media WHERE task_id=$1 AND type LIKE 'restock_proof:%'`, [id])
    const uuid = require('uuid')
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
      const { notifyExpoAll } = require('./notifications')
      await notifyExpoAll({ exclude_user_id: userId, title: '补货凭证已提交', body: '检查员已提交补货凭证', data: { kind: 'restock_proof_saved', task_id: id, event_id: `restock_proof_saved:${id}:${Date.now()}` } })
    } catch {}
    return res.status(201).json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'restock_proof_failed' })
  }
})

router.post('/cleaning-tasks/:id/guest-checked-out', async (req, res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  const role = String(user.role || '')
  const userId = String(user.sub || '')
  if (role !== 'customer_service' && role !== 'admin' && role !== 'offline_manager') return res.status(403).json({ message: 'forbidden' })
  const id = String(req.params.id || '').trim()
  if (!id) return res.status(400).json({ message: 'missing id' })
  if (!hasPg || !pgPool) return res.status(500).json({ message: 'pg not available' })
  try {
    await ensureCleaningCheckoutColumns()
    const action = String(req.body?.action || 'set').trim().toLowerCase()
    const r0 = await pgPool.query('SELECT id, checked_out_at FROM cleaning_tasks WHERE id=$1 LIMIT 1', [id])
    const row = r0?.rows?.[0] || null
    if (!row) return res.status(404).json({ message: 'not found' })
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
        const { notifyExpoAll } = require('./notifications')
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
        await notifyExpoAll({
          exclude_user_id: userId,
          title: propertyCode ? `取消已退房：${propertyCode}` : '取消已退房',
          body: '已取消退房',
          data: { kind: 'guest_checked_out_cancelled', task_id: id, property_code: propertyCode, event_id: `guest_checked_out_cancelled:${propertyCode || id}:${Date.now()}` },
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
      const { notifyExpoAll } = require('./notifications')
      let checkedOutAt: string | null = null
      let propertyCode = ''
      try {
        const r = await pgPool.query(
          `SELECT t.checked_out_at, COALESCE(p_id.code, p_code.code, t.property_id::text) AS property_code
           FROM cleaning_tasks t
           LEFT JOIN properties p_id ON (p_id.id::text) = (t.property_id::text)
           LEFT JOIN properties p_code ON upper(p_code.code) = upper(t.property_id::text)
           WHERE t.id=$1 LIMIT 1`,
          [id],
        )
        checkedOutAt = r?.rows?.[0]?.checked_out_at ? String(r.rows[0].checked_out_at) : null
        propertyCode = String(r?.rows?.[0]?.property_code || '').trim()
      } catch {}
      await notifyExpoAll({
        exclude_user_id: userId,
        title: propertyCode ? `已退房：${propertyCode}` : '已退房',
        body: '已退房',
        data: { kind: 'guest_checked_out', task_id: id, property_code: propertyCode, checked_out_at: checkedOutAt, event_id: `guest_checked_out:${propertyCode || id}:${checkedOutAt || ''}` },
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
  const role = String(user.role || '')
  const userId = String(user.sub || '')
  if (role !== 'customer_service' && role !== 'admin' && role !== 'offline_manager') return res.status(403).json({ message: 'forbidden' })
  const parsed = guestCheckedOutBulkSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  if (!hasPg || !pgPool) return res.status(500).json({ message: 'pg not available' })
  const ids = Array.from(new Set(parsed.data.task_ids.map((x) => String(x || '').trim()).filter(Boolean)))
  if (!ids.length) return res.status(400).json({ message: 'missing task_ids' })
  try {
    await ensureCleaningCheckoutColumns()
    const action = String(parsed.data.action || 'set').trim().toLowerCase()
    if (action === 'unset' || action === 'clear' || action === 'cancel') {
      await pgPool.query(
        `UPDATE cleaning_tasks
         SET checked_out_at = NULL,
             checkout_marked_by = NULL,
             updated_at = now()
         WHERE id::text = ANY($1::text[])`,
        [ids],
      )
      try {
        const { broadcastCleaningEvent } = require('./events')
        for (const id of ids) broadcastCleaningEvent({ event: 'guest_checked_out_cancelled', task_id: id })
      } catch {}
      let propertyCode = ''
      try {
        const r = await pgPool.query(
          `SELECT COALESCE(p_id.code, p_code.code, t.property_id::text) AS property_code
           FROM cleaning_tasks t
           LEFT JOIN properties p_id ON (p_id.id::text) = (t.property_id::text)
           LEFT JOIN properties p_code ON upper(p_code.code) = upper(t.property_id::text)
           WHERE t.id=$1 LIMIT 1`,
          [ids[0]],
        )
        propertyCode = String(r?.rows?.[0]?.property_code || '').trim()
      } catch {}
      try {
        const { notifyExpoAll } = require('./notifications')
        await notifyExpoAll({
          exclude_user_id: userId,
          title: propertyCode ? `取消已退房：${propertyCode}` : '取消已退房',
          body: '已取消退房',
          data: { kind: 'guest_checked_out_cancelled', task_ids: ids, property_code: propertyCode, event_id: `guest_checked_out_cancelled:${propertyCode || ids[0]}:${Date.now()}` },
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
      [ids, userId],
    )
    try {
      const { broadcastCleaningEvent } = require('./events')
      for (const id of ids) broadcastCleaningEvent({ event: 'guest_checked_out', task_id: id })
    } catch {}

    let checkedOutAt: string | null = null
    let propertyCode = ''
    try {
      const r = await pgPool.query(
        `SELECT t.checked_out_at, COALESCE(p_id.code, p_code.code, t.property_id::text) AS property_code
         FROM cleaning_tasks t
         LEFT JOIN properties p_id ON (p_id.id::text) = (t.property_id::text)
         LEFT JOIN properties p_code ON upper(p_code.code) = upper(t.property_id::text)
         WHERE t.id=$1 LIMIT 1`,
        [ids[0]],
      )
      checkedOutAt = r?.rows?.[0]?.checked_out_at ? String(r.rows[0].checked_out_at) : null
      propertyCode = String(r?.rows?.[0]?.property_code || '').trim()
    } catch {}
    const eventId = `guest_checked_out:${propertyCode || ids[0]}:${checkedOutAt || ''}`
    try {
      const { notifyExpoAll } = require('./notifications')
      await notifyExpoAll({
        exclude_user_id: userId,
        title: propertyCode ? `已退房：${propertyCode}` : '已退房',
        body: '已退房',
        data: { kind: 'guest_checked_out', task_ids: ids, property_code: propertyCode, checked_out_at: checkedOutAt, event_id: eventId },
      })
    } catch {}
    return res.status(201).json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'guest_checked_out_bulk_failed' })
  }
})

const managerFieldsSchema = z
  .object({
    task_ids: z.array(z.string().trim().min(1)).min(1).max(10),
    checkout_time: z.string().trim().max(32).optional().nullable(),
    checkin_time: z.string().trim().max(32).optional().nullable(),
    old_code: z.string().trim().max(64).optional().nullable(),
    new_code: z.string().trim().max(64).optional().nullable(),
    guest_special_request: z.string().trim().max(1500).optional().nullable(),
  })
  .strict()

async function handleManagerFields(req: any, res: any) {
  const user = (req as any).user
  if (!user) return res.status(401).json({ message: 'unauthorized' })
  const role = String(user.role || '')
  if (role !== 'customer_service') return res.status(403).json({ message: 'forbidden' })
  const parsed = managerFieldsSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  if (!hasPg || !pgPool) return res.status(500).json({ message: 'pg not available' })
  try {
    await ensureCleaningCustomerColumns()
    const fields: string[] = []
    const vals: any[] = []
    const push = (sql: string, v: any) => {
      vals.push(v)
      fields.push(`${sql} = $${vals.length}`)
    }
    if (parsed.data.checkout_time !== undefined) push('checkout_time', parsed.data.checkout_time)
    if (parsed.data.checkin_time !== undefined) push('checkin_time', parsed.data.checkin_time)
    if (parsed.data.old_code !== undefined) push('old_code', parsed.data.old_code)
    if (parsed.data.new_code !== undefined) push('new_code', parsed.data.new_code)
    if (parsed.data.guest_special_request !== undefined) push('guest_special_request', parsed.data.guest_special_request)
    if (!fields.length) return res.status(400).json({ message: 'no fields' })

    vals.push(parsed.data.task_ids)
    const sql = `UPDATE cleaning_tasks SET ${fields.join(', ')}, updated_at = now() WHERE id::text = ANY($${vals.length}::text[])`
    await pgPool.query(sql, vals)
    try {
      const { broadcastCleaningEvent } = require('./events')
      for (const id of parsed.data.task_ids) broadcastCleaningEvent({ event: 'cleaning_task_manager_fields_updated', task_id: String(id) })
    } catch {}
    try {
      const { notifyExpoAll } = require('./notifications')
      await notifyExpoAll({
        exclude_user_id: String(user.sub || ''),
        title: '任务信息更新',
        body: '入住/退房时间、密码或客人需求已更新',
        data: { kind: 'cleaning_task_manager_fields_updated', task_ids: parsed.data.task_ids, event_id: `cleaning_task_manager_fields_updated:${parsed.data.task_ids.join(',')}:${Date.now()}` },
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
  const role = String(user.role || '')
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
    if (!canViewAll(role) && assignee !== userId) return res.status(403).json({ message: 'forbidden' })

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
  const role = String(user.role || '')
  const userId = String(user.sub || '')

  const allowAll = view === 'all' && canViewAll(role)

  try {
    if (!hasPg || !pgPool) return res.json([])
    await ensureWorkTasksTable()
    await ensureCleaningTaskSortColumns()
    await ensureCleaningTaskMediaTable()
    await ensureCleaningCheckoutColumns()
    await ensureCleaningCustomerColumns()

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
          p.access_guide_link AS property_access_guide_link
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
              }
            : null,
        })
      }
    }

    {
      const isCleanerView = isCleanerRole(role) || isCleanerInspectorRole(role)
      const isInspectorView = isInspectorRole(role) || isCleanerInspectorRole(role)
      const wantCleaner = allowAll || isCleanerView
      const wantInspector = allowAll || isInspectorView

      if (wantCleaner || wantInspector) {
        const sql = `
          SELECT
            t.id,
            t.order_id,
            COALESCE(p_id.id::text, p_code.id::text, t.property_id::text) AS property_id,
            COALESCE(p_id.code::text, p_code.code::text) AS property_code,
            COALESCE(p_id.region::text, p_code.region::text) AS property_region,
            COALESCE(p_id.address::text, p_code.address::text) AS property_address,
            COALESCE(p_id.type::text, p_code.type::text) AS property_unit_type,
            COALESCE(p_id.access_guide_link::text, p_code.access_guide_link::text) AS property_access_guide_link,
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
            t.checked_out_at,
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
        const cleanerGroups = new Map<string, any[]>()
        const inspectorGroups = new Map<string, any[]>()
        for (const row of (r?.rows || [])) {
          const d = String(row.task_date || '').slice(0, 10)
          const propId = row.property_id ? String(row.property_id) : null
          const prop = propId
            ? {
                id: propId,
                code: row.property_code ? String(row.property_code) : '',
                address: row.property_address ? String(row.property_address) : '',
                unit_type: row.property_unit_type ? String(row.property_unit_type) : '',
                region: row.property_region ? String(row.property_region) : null,
                access_guide_link: row.property_access_guide_link ? String(row.property_access_guide_link) : null,
              }
            : null

          const raw_status = String(row.status ?? '').trim().toLowerCase()
          const status = mapCleaningTaskStatus(raw_status)

          const effectiveCleanerId = row.cleaner_id ? String(row.cleaner_id) : (row.assignee_id ? String(row.assignee_id) : null)
          const inspectorId = row.inspector_id ? String(row.inspector_id) : null

          const base = {
            __raw_id: String(row.id),
            __date: d,
            __prop_id: propId,
            __assignee_cleaner: effectiveCleanerId,
            __assignee_inspector: inspectorId,
            raw_status,
            task_type: String(row.task_type || ''),
            checkout_time: row.checkout_time,
            checkin_time: row.checkin_time,
            old_code: row.old_code,
            new_code: row.new_code,
            guest_special_request: row.guest_special_request,
            checked_out_at: row.checked_out_at,
            key_photo_url: row.key_photo_url,
            lockbox_video_url: row.lockbox_video_url,
            restock_items: restockByTaskId.get(String(row.id)) || [],
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
          const cleanerName = firstNonEmpty(p.a.cleaner_name, p.b?.cleaner_name, ...rows.map((x) => x.cleaner_name))
          const inspectorName = firstNonEmpty(p.a.inspector_name, p.b?.inspector_name, ...rows.map((x) => x.inspector_name))
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
          const statusOut =
            roleKind === 'inspector'
              ? (lockboxVideoUrl ? 'keys_hung' : (raw === 'cleaned' || raw === 'restock_pending' ? 'to_inspect' : p.a.status))
              : (raw === 'cleaned' || raw === 'restock_pending' ? 'done' : p.a.status)
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

          return {
            id: outId,
            task_kind: roleKind === 'cleaner' ? 'cleaning' : 'inspection',
            source_type: 'cleaning_tasks',
            source_id: primarySourceId,
            source_ids: p.ids,
            property_id: propId,
            title: prop?.code || (propId ? String(propId) : primarySourceId),
            summary: summary || null,
            scheduled_date: date,
            start_time: checkoutTime || null,
            end_time: checkinTime || null,
            assignee_id: assigneeId,
            status: statusOut,
            urgency: 'medium',
            sort_index,
            sort_index_cleaner,
            sort_index_inspector,
            old_code: oldCode,
            new_code: newCode,
            guest_special_request: guestSpecialRequest,
            checked_out_at: checkedOutAt,
            key_photo_url: keyPhotoUrl,
            lockbox_video_url: lockboxVideoUrl,
            restock_items: restockItems,
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

    if (allowAll && (role === 'customer_service' || role === 'admin' || role === 'offline_manager')) {
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

const feedbackCreateSchema = z.object({
  kind: z.enum(['maintenance', 'deep_cleaning']),
  property_id: z.string().min(1),
  source_task_id: z.string().optional(),
  area: z.string().optional(),
  areas: z.array(z.string().min(1)).optional(),
  category: z.string().optional(),
  detail: z.string().min(1),
  media_urls: z.array(z.string().min(1)).optional(),
})

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
      const area = String(parsed.data.area || '').trim()
      const categoryLabel = String(parsed.data.category || '').trim()
      if (!area) return res.status(400).json({ message: 'missing area' })
      if (!categoryLabel) return res.status(400).json({ message: 'missing category' })
      const detail = String(parsed.data.detail || '').trim()
      const mediaUrls = parsed.data.media_urls || []
      const details = detail

      await pgPool.query('ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS area text;')
      await pgPool.query('ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS work_no text;')
      await pgPool.query('ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS dedup_fingerprint text;')
      const photoType = await getColumnType('property_maintenance', 'photo_urls')
      const photoExpr = photoType === 'jsonb' ? '$13::jsonb' : photoType === 'text[]' ? '$13::text[]' : '$13'
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
          details,
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
      try {
        await pgPool.query(
          `UPDATE property_maintenance
              SET work_no = COALESCE(NULLIF(work_no, ''), $2)
            WHERE id = $1`,
          [id, workNo],
        )
      } catch {}
      return res.status(201).json({ ok: true, id })
    }

    const areas = parsed.data.areas || []
    if (!areas.length) return res.status(400).json({ message: 'missing areas' })
    const mediaUrls = parsed.data.media_urls || []
    if (!mediaUrls.length) return res.status(400).json({ message: 'missing photos' })
    const detail = String(parsed.data.detail || '').trim()
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
