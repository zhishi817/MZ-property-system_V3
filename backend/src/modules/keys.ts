import { Router } from 'express'
import { db } from '../store'
import { z } from 'zod'
import multer from 'multer'
import path from 'path'
import { hasR2, r2Upload } from '../r2'
import { requirePerm } from '../auth'
import { addAudit } from '../store'
import { hasPg, pgSelect, pgInsert, pgUpdate, pgDelete } from '../dbAdapter'
import { v4 as uuidv4 } from 'uuid'
import type { KeySet } from '../store'

export const router = Router()

router.get('/', async (_req, res) => {
  try {
    if (hasPg) {
      const sets: any[] = (await pgSelect('key_sets')) || []
      const items: any[] = (await pgSelect('key_items')) || []
      const grouped = sets.map((s) => ({ ...s, items: items.filter((it) => it.key_set_id === s.id) }))
      return res.json(grouped)
    }
    // Supabase branch removed
  } catch (e: any) {}
  const codes = (db.properties || []).map((p: any) => p.code).filter(Boolean)
  const types: Array<'guest'|'spare_1'|'spare_2'|'other'> = ['guest','spare_1','spare_2','other']
  codes.forEach((code) => {
    types.forEach((t) => {
      if (!db.keySets.find((s) => s.code === code && s.set_type === t)) {
        db.keySets.push({ id: uuidv4(), set_type: t, status: 'available', code, items: [] })
      }
    })
  })
  res.json(db.keySets)
})

const createSetSchema = z.object({
  set_type: z.enum(['guest', 'spare_1', 'spare_2', 'other']),
  code: z.string().min(1).optional(),
  property_code: z.string().min(1).optional(),
}).transform((v) => ({
  set_type: v.set_type,
  code: v.code || v.property_code || '',
}))

router.post('/sets', requirePerm('keyset.manage'), async (req, res) => {
  const parsed = createSetSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (hasPg) {
      const existed: any[] = (await pgSelect('key_sets', '*', { code: parsed.data.code, set_type: parsed.data.set_type })) || []
      if (existed && existed[0]) {
        const row = await pgUpdate('key_sets', existed[0].id, { status: 'available', code: parsed.data.code } as any)
        return res.status(200).json({ ...row, items: [] })
      }
      const row = await pgInsert('key_sets', { id: uuidv4(), set_type: parsed.data.set_type, status: 'available', code: parsed.data.code } as any)
      return res.status(201).json({ ...row, items: [] })
    }
  // Supabase branch removed
  } catch (e: any) {}
  const set: KeySet = { id: uuidv4(), set_type: parsed.data.set_type, status: 'available', code: parsed.data.code || '', items: [] }
  db.keySets.push(set)
  res.status(201).json(set)
})

const flowSchema = z.object({
  action: z.enum(['borrow', 'return', 'lost', 'replace']),
  note: z.string().optional(),
  new_code: z.string().optional(),
})

router.post('/sets/:id/flows', requirePerm('key.flow'), async (req, res) => {
  const { id } = req.params
  const parsed = flowSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (hasPg) {
      const rows: any = await pgSelect('key_sets', '*', { id })
      const set = rows && rows[0]
      if (!set) return res.status(404).json({ message: 'set not found' })
      const oldCode = set.code
      let newStatus = set.status
      if (parsed.data.action === 'borrow') newStatus = 'in_transit'
      else if (parsed.data.action === 'return') newStatus = 'available'
      else if (parsed.data.action === 'lost') newStatus = 'lost'
      else if (parsed.data.action === 'replace') newStatus = 'replaced'
      const newCode = parsed.data.action === 'replace' && parsed.data.new_code ? parsed.data.new_code : set.code
      const updated = await pgUpdate('key_sets', id, { status: newStatus, code: newCode } as any) || { id, status: newStatus, code: newCode }
      const flow = await pgInsert('key_flows', { id: require('uuid').v4(), key_set_id: id, action: parsed.data.action, timestamp: new Date().toISOString(), note: parsed.data.note, old_code: oldCode, new_code: newCode } as any)
      addAudit('KeySet', id, 'flow', { status: set.status, code: oldCode }, { status: updated.status, code: updated.code })
      return res.status(201).json({ set: updated, flow })
    }
    // Supabase branch removed
  } catch (e: any) {}
  const set = db.keySets.find((s) => s.id === id)
  if (!set) return res.status(404).json({ message: 'set not found' })
  const oldCode = set.code
  if (parsed.data.action === 'borrow') set.status = 'in_transit'
  else if (parsed.data.action === 'return') set.status = 'available'
  else if (parsed.data.action === 'lost') set.status = 'lost'
  else if (parsed.data.action === 'replace') {
    set.status = 'replaced'
    if (parsed.data.new_code) set.code = parsed.data.new_code
  }
  const flow = {
    id: uuidv4(),
    key_set_id: set.id,
    action: parsed.data.action,
    timestamp: new Date().toISOString(),
    note: parsed.data.note,
    old_code: oldCode,
    new_code: set.code,
  }
  db.keyFlows.push(flow)
  addAudit('KeySet', set.id, 'flow', { status: set.status, code: oldCode }, { status: set.status, code: set.code })
  res.status(201).json({ set, flow })
})

router.get('/sets/:id/history', async (req, res) => {
  try {
    if (hasPg) {
      const flows: any = await pgSelect('key_flows', '*', { key_set_id: req.params.id })
      return res.json(flows || [])
    }
    // Supabase branch removed
  } catch (e: any) {}
  const { id } = req.params
  const flows = db.keyFlows.filter((f) => f.key_set_id === id)
  res.json(flows)
})

router.get('/sets/:id', async (req, res) => {
  try {
    if (hasPg) {
      const rows: any = await pgSelect('key_sets', '*', { id: req.params.id })
      const set = rows && rows[0]
      if (!set) return res.status(404).json({ message: 'set not found' })
      const items: any = await pgSelect('key_items', '*', { key_set_id: set.id })
      return res.json({ ...set, items: items || [] })
    }
    // Supabase branch removed
  } catch (e: any) {}
  const set = db.keySets.find((s) => s.id === req.params.id)
  if (!set) return res.status(404).json({ message: 'set not found' })
  res.json(set)
})

const upload = hasR2 ? multer({ storage: multer.memoryStorage() }) : multer({ storage: multer.diskStorage({
  destination: (_req: any, _file: any, cb: any) => cb(null, path.join(process.cwd(), 'uploads')),
  filename: (_req: any, file: any, cb: any) => {
    const ext = path.extname(file.originalname)
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`)
  },
}) })

const addItemSchema = z.object({
  item_type: z.enum(['key', 'fob']),
  code: z.string().min(1),
  set_type: z.enum(['guest','spare_1','spare_2','other']).optional(),
  property_code: z.string().optional(),
})

router.post('/sets/:id/items', requirePerm('keyset.manage'), upload.single('photo'), async (req, res) => {
  const parsed = addItemSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (hasPg) {
      let rows: any = await pgSelect('key_sets', '*', { id: req.params.id })
      let set = rows && rows[0]
      if (!set) {
        const local = db.keySets.find((s) => s.id === req.params.id)
        const code = local?.code || (req.body && (req.body as any).property_code)
        const sType = local?.set_type || (req.body && (req.body as any).set_type)
        if (!code || !sType) return res.status(404).json({ message: 'set not found' })
        const byCode: any = await pgSelect('key_sets', '*', { code, set_type: sType })
        set = byCode && byCode[0]
        if (!set) {
          const { v4: uuidv4 } = require('uuid')
          set = await pgInsert('key_sets', { id: uuidv4(), set_type: sType, status: (local?.status || 'available'), code } as any)
        }
      }
      const existed: any = await pgSelect('key_items', '*', { key_set_id: set.id, item_type: parsed.data.item_type })
      const existing = existed && existed[0]
      if (existing) {
        let photoUrl = existing.photo_url
        if ((req as any).file) {
          if (hasR2 && (req as any).file.buffer) {
            const ext = path.extname((req as any).file.originalname)
            const key = `key-items/${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`
            photoUrl = await r2Upload(key, (req as any).file.mimetype || 'application/octet-stream', (req as any).file.buffer)
          } else {
            photoUrl = `/uploads/${(req as any).file.filename}`
          }
        }
        const updated = await pgUpdate('key_items', existing.id, { code: parsed.data.code, photo_url: photoUrl } as any)
        return res.status(200).json(updated)
      }
      let photoUrl: string | null = null
      if ((req as any).file) {
        if (hasR2 && (req as any).file.buffer) {
          const ext = path.extname((req as any).file.originalname)
          const key = `key-items/${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`
          photoUrl = await r2Upload(key, (req as any).file.mimetype || 'application/octet-stream', (req as any).file.buffer)
        } else {
          photoUrl = `/uploads/${(req as any).file.filename}`
        }
      }
      const created = await pgInsert('key_items', { id: uuidv4(), key_set_id: set.id, item_type: parsed.data.item_type, code: parsed.data.code, photo_url: photoUrl } as any)
      return res.status(201).json(created)
    }
    // Supabase branch removed
  } catch (e: any) {}
  const set = db.keySets.find((s) => s.id === req.params.id)
  if (!set) return res.status(404).json({ message: 'set not found' })
  const existing = (set.items || []).find((it: any) => it.item_type === parsed.data.item_type)
  if (existing) {
    existing.code = parsed.data.code
    if ((req as any).file) existing.photo_url = `/uploads/${(req as any).file.filename}`
    return res.status(200).json(existing)
  }
  const created = { id: uuidv4(), item_type: parsed.data.item_type, code: parsed.data.code, photo_url: (req as any).file ? `/uploads/${(req as any).file.filename}` : undefined }
  set.items.push(created)
  res.status(201).json(created)
})

router.patch('/sets/:id/items/:itemId', requirePerm('keyset.manage'), upload.single('photo'), async (req, res) => {
  try {
    if (hasPg) {
      const payload: any = {}
      if (req.body && req.body.code) payload.code = String(req.body.code)
      if ((req as any).file) {
        if (hasR2 && (req as any).file.buffer) {
          const ext = path.extname((req as any).file.originalname)
          const key = `key-items/${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`
          payload.photo_url = await r2Upload(key, (req as any).file.mimetype || 'application/octet-stream', (req as any).file.buffer)
        } else {
          payload.photo_url = `/uploads/${(req as any).file.filename}`
        }
      }
      const item = await pgUpdate('key_items', req.params.itemId, payload)
      return res.json(item)
    }
    // Supabase branch removed
  } catch (e: any) {}
  const set = db.keySets.find((s) => s.id === req.params.id)
  if (!set) return res.status(404).json({ message: 'set not found' })
  const item = set.items.find((it: any) => it.id === req.params.itemId)
  if (!item) return res.status(404).json({ message: 'item not found' })
  const code = (req.body && (req.body as any).code) ? String((req.body as any).code) : undefined
  if (code) item.code = code
  if ((req as any).file) {
    if (hasR2 && (req as any).file.buffer) {
      const ext = path.extname((req as any).file.originalname)
      const key = `key-items/${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`
      item.photo_url = await r2Upload(key, (req as any).file.mimetype || 'application/octet-stream', (req as any).file.buffer)
    } else {
      item.photo_url = `/uploads/${(req as any).file.filename}`
    }
  }
  res.json(item)
})

router.delete('/sets/:id/items/:itemId', requirePerm('keyset.manage'), async (req, res) => {
  try {
    if (hasPg) {
      await pgDelete('key_items', req.params.itemId)
      return res.json({ ok: true })
    }
    // Supabase branch removed
  } catch (e: any) {}
  const set = db.keySets.find((s) => s.id === req.params.id)
  if (!set) return res.status(404).json({ message: 'set not found' })
  const idx = set.items.findIndex((it: any) => it.id === req.params.itemId)
  if (idx === -1) return res.status(404).json({ message: 'item not found' })
  set.items.splice(idx, 1)
  res.json({ ok: true })
})

router.get('/sets', async (req, res) => {
  const { property_code } = req.query as any
  try {
    if (hasPg) {
      if (!property_code) {
        const sets: any = await pgSelect('key_sets')
        return res.json(sets)
      }
      const rows: any = await pgSelect('key_sets', '*', { code: property_code })
      return res.json(rows)
    }
    // Supabase branch removed
  } catch (e: any) {}
  if (!property_code) return res.json(db.keySets)
  const types: Array<'guest'|'spare_1'|'spare_2'|'other'> = ['guest','spare_1','spare_2','other']
  types.forEach((t) => {
    if (!db.keySets.find((s) => s.code === property_code && s.set_type === t)) {
      db.keySets.push({ id: uuidv4(), set_type: t, status: 'available', code: property_code, items: [] })
    }
  })
  res.json(db.keySets.filter(s => s.code === property_code))
})