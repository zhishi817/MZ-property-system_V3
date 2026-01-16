import { Router } from 'express'
import { z } from 'zod'
import { requirePerm, requireAnyPerm } from '../auth'
import { hasPg, pgSelect, pgUpdate, pgInsert } from '../dbAdapter'
import multer from 'multer'
import path from 'path'
import { hasR2, r2Upload } from '../r2'
import { broadcastCleaningEvent } from './events'

export const router = Router()
const upload = hasR2 ? multer({ storage: multer.memoryStorage() }) : multer({ dest: path.join(process.cwd(), 'uploads') })

// List tasks for app (self or all)
router.get('/tasks', requireAnyPerm(['cleaning_app.calendar.view.all','cleaning_app.tasks.view.self']), async (req, res) => {
  const { assignee_id, from, to, status } = req.query as { assignee_id?: string; from?: string; to?: string; status?: string }
  try {
    if (hasPg) {
      const where: any = {}
      if (assignee_id) where.assignee_id = assignee_id
      if (status) where.status = status
      let rows = await pgSelect('cleaning_tasks', '*', Object.keys(where).length ? where : undefined)
      if (from || to) {
        const f = from || '0001-01-01'
        const t = to || '9999-12-31'
        rows = rows.filter((r: any) => {
          const d = String(r.date || '').slice(0,10)
          return d >= f && d <= t
        })
      }
      return res.json(rows)
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

// Submit consumables
const consumableSchema = z.object({ items: z.array(z.object({ item_id: z.string(), qty: z.number().int().min(1), need_restock: z.boolean().optional(), note: z.string().optional() })) })
router.post('/tasks/:id/consumables', requirePerm('cleaning_app.tasks.finish'), async (req, res) => {
  const { id } = req.params
  const parsed = consumableSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (hasPg) {
      for (const it of parsed.data.items) {
        const row = { id: require('uuid').v4(), task_id: id, item_id: it.item_id, qty: it.qty, need_restock: !!it.need_restock, note: it.note || null }
        await pgInsert('cleaning_consumable_usages', row as any)
      }
      const needsRestock = parsed.data.items.some((i) => !!i.need_restock)
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
router.post('/upload', requirePerm('cleaning_app.media.upload'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'missing file' })
  try {
    if (hasR2 && (req.file as any).buffer) {
      const ext = path.extname(req.file.originalname) || ''
      const key = `cleaning/${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`
      const url = await r2Upload(key, req.file.mimetype || 'application/octet-stream', (req.file as any).buffer)
      return res.status(201).json({ url })
    }
    const url = `/uploads/${req.file.filename}`
    return res.status(201).json({ url })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'upload failed' })
  }
})
