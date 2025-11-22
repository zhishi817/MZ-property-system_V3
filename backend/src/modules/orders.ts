import { Router } from 'express'
import { db, Order, CleaningTask } from '../store'
import { z } from 'zod'
import { requirePerm } from '../auth'
import { hasSupabase, supaSelect, supaInsert } from '../supabase'

export const router = Router()

router.get('/', (req, res) => {
  if (!hasSupabase) return res.json(db.orders)
  supaSelect('orders')
    .then((data) => res.json(data))
    .catch((err) => res.status(500).json({ message: err.message }))
})

const createOrderSchema = z.object({
  source: z.string(),
  external_id: z.string().optional(),
  property_id: z.string().optional(),
  guest_name: z.string().optional(),
  checkin: z.string().optional(),
  checkout: z.string().optional(),
  price: z.number().optional(),
  currency: z.string().optional(),
  idempotency_key: z.string().optional(),
})

router.post('/sync', requirePerm('order.sync'), (req, res) => {
  const parsed = createOrderSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const o = parsed.data
  const key = o.idempotency_key || `${o.external_id || ''}-${o.checkout || ''}`
  const exists = db.orders.find((x) => x.idempotency_key === key)
  if (exists) return res.status(200).json(exists)
  const { v4: uuid } = require('uuid')
  const newOrder: Order = { id: uuid(), ...o, idempotency_key: key, status: 'confirmed' }
  db.orders.push(newOrder)
  if (newOrder.checkout) {
    const date = newOrder.checkout
    const hasTask = db.cleaningTasks.find((t) => t.date === date && t.property_id === newOrder.property_id)
    if (!hasTask) {
      const task = { id: uuid(), property_id: newOrder.property_id, date, status: 'pending' as const }
      db.cleaningTasks.push(task)
    }
  }
  if (!hasSupabase) return res.status(201).json(newOrder)
  supaInsert('orders', newOrder)
    .then((row) => res.status(201).json(row))
    .catch((err) => res.status(500).json({ message: err.message }))
})

router.post('/:id/generate-cleaning', requirePerm('order.manage'), (req, res) => {
  const { id } = req.params
  const order = db.orders.find((o) => o.id === id)
  if (!order) return res.status(404).json({ message: 'order not found' })
  const { v4: uuid } = require('uuid')
  const date = order.checkout || new Date().toISOString().slice(0, 10)
  const exists = db.cleaningTasks.find((t) => t.date === date && t.property_id === order.property_id)
  if (exists) return res.status(200).json(exists)
  const task: CleaningTask = { id: uuid(), property_id: order.property_id, date, status: 'pending' }
  db.cleaningTasks.push(task)
  res.status(201).json(task)
})