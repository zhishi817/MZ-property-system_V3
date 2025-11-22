import { Router } from 'express'
import { db, addAudit } from '../store'
import { z } from 'zod'
import { requirePerm } from '../auth'

export const router = Router()

router.get('/items', (req, res) => {
  res.json(db.inventoryItems)
})

router.get('/warnings', (req, res) => {
  res.json(db.inventoryItems.filter(i => i.quantity < i.threshold))
})

const itemSchema = z.object({ name: z.string(), sku: z.string(), unit: z.string(), threshold: z.number().int().min(0), bin_location: z.string().optional(), quantity: z.number().int().min(0) })

router.post('/items', requirePerm('inventory.move'), (req, res) => {
  const parsed = itemSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const { v4: uuid } = require('uuid')
  const item = { id: uuid(), ...parsed.data }
  db.inventoryItems.push(item)
  addAudit('InventoryItem', item.id, 'create', null, item)
  res.status(201).json(item)
})

const moveSchema = z.object({ item_id: z.string(), type: z.enum(['in','out']), quantity: z.number().int().min(1) })

router.post('/movements', requirePerm('inventory.move'), (req, res) => {
  const parsed = moveSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const item = db.inventoryItems.find(i => i.id === parsed.data.item_id)
  if (!item) return res.status(404).json({ message: 'item not found' })
  const before = { ...item }
  if (parsed.data.type === 'in') item.quantity += parsed.data.quantity
  else {
    if (item.quantity < parsed.data.quantity) return res.status(409).json({ message: 'insufficient stock' })
    item.quantity -= parsed.data.quantity
  }
  const { v4: uuid } = require('uuid')
  db.stockMovements.push({ id: uuid(), item_id: item.id, type: parsed.data.type, quantity: parsed.data.quantity, timestamp: new Date().toISOString() })
  addAudit('InventoryItem', item.id, 'movement', before, item)
  res.json(item)
})