import { Router } from 'express'
import { db } from '../store'
import { z } from 'zod'
import multer from 'multer'
import path from 'path'
import { requirePerm } from '../auth'
import { addAudit } from '../store'

export const router = Router()

router.get('/', (req, res) => {
  // ensure key sets exist for all properties by property code
  const codes = (db.properties || []).map((p: any) => p.code).filter(Boolean)
  const types: Array<'guest'|'spare_1'|'spare_2'|'other'> = ['guest','spare_1','spare_2','other']
  const { v4: uuidv4 } = require('uuid')
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

router.post('/sets', requirePerm('keyset.manage'), (req, res) => {
  const parsed = createSetSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const { v4: uuid } = require('uuid')
  const set = { id: uuid(), set_type: parsed.data.set_type, status: 'available', code: parsed.data.code, items: [] }
  db.keySets.push(set)
  res.status(201).json(set)
})

const flowSchema = z.object({
  action: z.enum(['borrow', 'return', 'lost', 'replace']),
  note: z.string().optional(),
  new_code: z.string().optional(),
})

router.post('/sets/:id/flows', requirePerm('key.flow'), (req, res) => {
  const { id } = req.params
  const parsed = flowSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const set = db.keySets.find((s) => s.id === id)
  if (!set) return res.status(404).json({ message: 'set not found' })
  const { v4: uuid } = require('uuid')
  const oldCode = set.code
  if (parsed.data.action === 'borrow') set.status = 'in_transit'
  else if (parsed.data.action === 'return') set.status = 'available'
  else if (parsed.data.action === 'lost') set.status = 'lost'
  else if (parsed.data.action === 'replace') {
    set.status = 'replaced'
    if (parsed.data.new_code) set.code = parsed.data.new_code
  }
  const flow = {
    id: uuid(),
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

router.get('/sets/:id/history', (req, res) => {
  const { id } = req.params
  const flows = db.keyFlows.filter((f) => f.key_set_id === id)
  res.json(flows)
})

router.get('/sets/:id', (req, res) => {
  const set = db.keySets.find((s) => s.id === req.params.id)
  if (!set) return res.status(404).json({ message: 'set not found' })
  res.json(set)
})

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, path.join(process.cwd(), 'uploads')),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname)
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`)
  },
})
const upload = multer({ storage })

const addItemSchema = z.object({ item_type: z.enum(['key', 'fob']), code: z.string().min(1) })

router.post('/sets/:id/items', requirePerm('keyset.manage'), upload.single('photo'), (req, res) => {
  const set = db.keySets.find((s) => s.id === req.params.id)
  if (!set) return res.status(404).json({ message: 'set not found' })
  const parsed = addItemSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const { v4: uuidv4 } = require('uuid')
  const item = {
    id: uuidv4(),
    item_type: parsed.data.item_type,
    code: parsed.data.code,
    photo_url: req.file ? `/uploads/${req.file.filename}` : undefined,
  }
  set.items.push(item)
  res.status(201).json(item)
})

router.patch('/sets/:id/items/:itemId', requirePerm('keyset.manage'), upload.single('photo'), (req, res) => {
  const set = db.keySets.find((s) => s.id === req.params.id)
  if (!set) return res.status(404).json({ message: 'set not found' })
  const item = set.items.find((it: any) => it.id === req.params.itemId)
  if (!item) return res.status(404).json({ message: 'item not found' })
  const code = (req.body && req.body.code) ? String(req.body.code) : undefined
  if (code) item.code = code
  if (req.file) item.photo_url = `/uploads/${req.file.filename}`
  res.json(item)
})

router.delete('/sets/:id/items/:itemId', requirePerm('keyset.manage'), (req, res) => {
  const set = db.keySets.find((s) => s.id === req.params.id)
  if (!set) return res.status(404).json({ message: 'set not found' })
  const idx = set.items.findIndex((it: any) => it.id === req.params.itemId)
  if (idx === -1) return res.status(404).json({ message: 'item not found' })
  set.items.splice(idx, 1)
  res.json({ ok: true })
})

router.get('/sets', (req, res) => {
  const { property_code } = req.query as any
  if (!property_code) return res.json(db.keySets)
  const types: Array<'guest'|'spare_1'|'spare_2'|'other'> = ['guest','spare_1','spare_2','other']
  const { v4: uuidv4 } = require('uuid')
  types.forEach((t) => {
    if (!db.keySets.find((s) => s.code === property_code && s.set_type === t)) {
      db.keySets.push({ id: uuidv4(), set_type: t, status: 'available', code: property_code, items: [] })
    }
  })
  res.json(db.keySets.filter(s => s.code === property_code))
})