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
          t.inspector_id,
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
            inspector_id: row.inspector_id === null || row.inspector_id === undefined ? null : String(row.inspector_id),
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
      try { broadcastCleaningEvent({ event: 'started', task_id: id }) } catch {}
      return res.json(up || patch)
    }
    return res.json({ id, status: 'in_progress' })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'error' })
  }
})

// Report issue
const issueSchema = z.object({ title: z.string().min(1), detail: z.string().optional(), severity: z.string().optional(), media_url: z.string().optional() })
router.post('/tasks/:id/issues', requirePerm('cleaning_app.issues.report'), async (req, res) => {
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
      try { broadcastCleaningEvent({ event: 'issue', task_id: id }) } catch {}
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
router.post('/tasks/:id/consumables', requirePerm('cleaning_app.tasks.finish'), async (req, res) => {
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

      for (const it of parsed.data.items) {
        const meta: any = byId.get(String(it.item_id)) || null
        const requiresPhoto = meta ? !!meta.requires_photo_when_low : true
        if (it.status === 'low' && requiresPhoto && !String(it.photo_url || '').trim()) {
          return res.status(400).json({ message: '不足项必须拍照', item_id: it.item_id })
        }
        if (it.status === 'low' && (!it.qty || it.qty < 1)) {
          return res.status(400).json({ message: '不足项必须填写数量', item_id: it.item_id })
        }
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
      const patch: any = { status: needsRestock ? 'restock_pending' : 'cleaned', finished_at: new Date().toISOString() }
      const up = await pgUpdate('cleaning_tasks', id, patch)
      try { broadcastCleaningEvent({ event: 'consumables_submitted', task_id: id, restock_pending: needsRestock }) } catch {}
      return res.json(up || patch)
    }
    return res.json({ id, status: 'cleaned' })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'error' })
  }
})

// Restock done
router.patch('/tasks/:id/restock', requirePerm('cleaning_app.restock.manage'), async (req, res) => {
  const { id } = req.params
  try {
    if (hasPg) {
      const up = await pgUpdate('cleaning_tasks', id, { status: 'restocked' } as any)
      try { broadcastCleaningEvent({ event: 'restock_done', task_id: id }) } catch {}
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
      try { broadcastCleaningEvent({ event: 'inspected', task_id: id }) } catch {}
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

const inspectionPhotosSchema = z
  .object({
    items: z.array(
      z.object({
        area: z.enum(['toilet', 'living', 'sofa', 'bedroom', 'kitchen', 'unclean']),
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
  const { id } = req.params
  const parsed = inspectionPhotosSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    const limits: Record<string, number> = { toilet: 9, living: 3, sofa: 2, bedroom: 8, kitchen: 2, unclean: 12 }
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

router.get('/tasks/:id/restock-proof', requirePerm('cleaning_app.inspect.finish'), async (req, res) => {
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

router.post('/tasks/:id/restock-proof', requirePerm('cleaning_app.inspect.finish'), async (req, res) => {
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
      return res.status(201).json({ ok: true })
    }
    return res.status(201).json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'error' })
  }
})

// Set ready
router.patch('/tasks/:id/ready', requirePerm('cleaning_app.ready.set'), async (req, res) => {
  const { id } = req.params
  try {
    if (hasPg) {
      const up = await pgUpdate('cleaning_tasks', id, { status: 'ready' } as any)
      try { broadcastCleaningEvent({ event: 'ready', task_id: id }) } catch {}
      return res.json(up || { id, status: 'ready' })
    }
    return res.json({ id, status: 'ready' })
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
