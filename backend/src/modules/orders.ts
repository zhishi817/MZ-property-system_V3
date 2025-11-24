import { Router } from 'express'
import { db, Order, CleaningTask } from '../store'
import { z } from 'zod'
import { requirePerm } from '../auth'
import { hasSupabase, supaSelect, supaInsert, supaUpdate, supaDelete, supaUpsertConflict } from '../supabase'

export const router = Router()

let pendingInsert: Order[] = []
let pendingUpdate: { id: string; payload: Partial<Order> }[] = []
let pendingDelete: string[] = []
let retryTimer: any = null
function startRetry() {
  if (retryTimer) return
  retryTimer = setInterval(async () => {
    if (!hasSupabase) return
    if (pendingInsert.length) {
      const rest: Order[] = []
      for (const o of pendingInsert) {
        try { await supaUpsertConflict('orders', o, 'id') } catch { rest.push(o) }
      }
      pendingInsert = rest
    }
    if (pendingUpdate.length) {
      const rest: { id: string; payload: Partial<Order> }[] = []
      for (const u of pendingUpdate) {
        try { await supaUpdate('orders', u.id, u.payload) } catch { rest.push(u) }
      }
      pendingUpdate = rest
    }
    if (pendingDelete.length) {
      const rest: string[] = []
      for (const id of pendingDelete) {
        try { await supaDelete('orders', id) } catch { rest.push(id) }
      }
      pendingDelete = rest
    }
  }, 5000)
}
startRetry()

router.get('/', async (_req, res) => {
  try {
    if (!hasSupabase) return res.json(db.orders)
    const remote: any[] = (await supaSelect('orders')) || []
    const local = db.orders
    const merged = [...remote, ...local.filter((l) => !remote.some((r: any) => r.id === l.id))]
    return res.json(merged)
  } catch {
    return res.json(db.orders)
  }
})

router.get('/:id', async (req, res) => {
  const { id } = req.params
  const local = db.orders.find((o) => o.id === id)
  if (local) return res.json(local)
  try {
    if (hasSupabase) {
      const remote = await supaSelect('orders', '*', { id })
      const row = Array.isArray(remote) ? remote[0] : null
      if (row) return res.json(row)
    }
  } catch {}
  return res.status(404).json({ message: 'order not found' })
})
router.get('/:id', (req, res) => {
  const { id } = req.params
  const order = db.orders.find((o) => o.id === id)
  if (!order) return res.status(404).json({ message: 'order not found' })
  return res.json(order)
})

const createOrderSchema = z.object({
  source: z.string(),
  external_id: z.string().optional(),
  property_id: z.string().optional(),
  property_code: z.string().optional(),
  guest_name: z.string().optional(),
  checkin: z.string().optional(),
  checkout: z.string().optional(),
  price: z.number().optional(),
  cleaning_fee: z.number().optional(),
  net_income: z.number().optional(),
  avg_nightly_price: z.number().optional(),
  nights: z.number().optional(),
  currency: z.string().optional(),
  status: z.string().optional(),
  idempotency_key: z.string().optional(),
})
const updateOrderSchema = createOrderSchema.partial()

function parseDate(s?: string): Date | null {
  if (!s) return null
  const d = new Date(s)
  return isNaN(d.getTime()) ? null : d
}

function rangesOverlap(aStart?: string, aEnd?: string, bStart?: string, bEnd?: string): boolean {
  const as = parseDate(aStart); const ae = parseDate(aEnd); const bs = parseDate(bStart); const be = parseDate(bEnd)
  if (!as || !ae || !bs || !be) return false
  return as <= be && bs <= ae
}

async function hasOrderOverlap(propertyId?: string, checkin?: string, checkout?: string, excludeId?: string): Promise<boolean> {
  if (!propertyId || !checkin || !checkout) return false
  const localHit = db.orders.some(o => o.property_id === propertyId && o.id !== excludeId && rangesOverlap(checkin, checkout, o.checkin, o.checkout))
  if (localHit) return true
  try {
    if (hasSupabase) {
      const rows: any[] = (await supaSelect('orders', '*', { property_id: propertyId })) || []
      const remoteHit = rows.some(o => o.id !== excludeId && rangesOverlap(checkin, checkout, o.checkin, o.checkout))
      if (remoteHit) return true
    }
  } catch {}
  return false
}

router.post('/sync', requirePerm('order.sync'), async (req, res) => {
  const parsed = createOrderSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const o = parsed.data
  const key = o.idempotency_key || `${o.property_id || ''}-${o.checkin || ''}-${o.checkout || ''}`
  const exists = db.orders.find((x) => x.idempotency_key === key)
  if (exists) return res.status(409).json({ message: '订单已存在：同一房源同时间段重复创建', order: exists })
  const { v4: uuid } = require('uuid')
  // derive values if not provided
  let nights = o.nights
  if (!nights && o.checkin && o.checkout) {
    try {
      const ci = new Date(o.checkin)
      const co = new Date(o.checkout)
      const ms = co.getTime() - ci.getTime()
      nights = ms > 0 ? Math.round(ms / (1000 * 60 * 60 * 24)) : 0
    } catch { nights = 0 }
  }
  const cleaning = o.cleaning_fee || 0
  const price = o.price || 0
  const net = o.net_income != null ? o.net_income : (price - cleaning)
  const avg = o.avg_nightly_price != null ? o.avg_nightly_price : (nights && nights > 0 ? Number((net / nights).toFixed(2)) : 0)
  const newOrder: Order = { id: uuid(), ...o, nights, net_income: net, avg_nightly_price: avg, idempotency_key: key, status: 'confirmed' }
  // overlap guard
  const conflict = await hasOrderOverlap(newOrder.property_id, newOrder.checkin, newOrder.checkout)
  if (conflict) return res.status(409).json({ message: '订单时间冲突：同一房源在该时段已有订单' })
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
  supaUpsertConflict('orders', newOrder, 'id')
    .then((row) => res.status(201).json(row))
    .catch((_err) => { pendingInsert.push(newOrder); startRetry(); return res.status(201).json(newOrder) })
})

router.patch('/:id', requirePerm('order.manage'), async (req, res) => {
  const { id } = req.params
  const parsed = updateOrderSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const o = parsed.data
  const idx = db.orders.findIndex((x) => x.id === id)
  const prev = idx !== -1 ? db.orders[idx] : undefined
  if (!prev && !hasSupabase) return res.status(404).json({ message: 'order not found' })

  const base = prev || ({} as Order)
  let nights = o.nights
  const checkin = o.checkin || base.checkin
  const checkout = o.checkout || base.checkout
  if (!nights && checkin && checkout) {
    try {
      const ci = new Date(checkin)
      const co = new Date(checkout)
      const ms = co.getTime() - ci.getTime()
      nights = ms > 0 ? Math.round(ms / (1000 * 60 * 60 * 24)) : 0
    } catch { nights = 0 }
  }
  const price = o.price != null ? o.price : (base.price || 0)
  const cleaning = o.cleaning_fee != null ? o.cleaning_fee : (base.cleaning_fee || 0)
  const net = o.net_income != null ? o.net_income : (price - cleaning)
  const avg = o.avg_nightly_price != null ? o.avg_nightly_price : (nights && nights > 0 ? Number((net / nights).toFixed(2)) : 0)
  const updated: Order = { ...base, ...o, id, nights, net_income: net, avg_nightly_price: avg }
  // overlap guard on update
  const conflict = await hasOrderOverlap(updated.property_id, updated.checkin, updated.checkout, id)
  if (conflict) return res.status(409).json({ message: '订单时间冲突：同一房源在该时段已有订单' })

  if (idx !== -1) {
    db.orders[idx] = updated
  }

  if (hasSupabase) {
    try {
      const row = await supaUpdate('orders', id, updated)
      return res.json(row || updated)
    } catch {
      pendingUpdate.push({ id, payload: updated }); startRetry()
      return res.json(updated)
    }
  }
  return res.json(updated)
})
router.patch('/:id', requirePerm('order.manage'), (req, res) => {
  const { id } = req.params
  const parsed = createOrderSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const o = parsed.data
  const idx = db.orders.findIndex((x) => x.id === id)
  if (idx === -1) return res.status(404).json({ message: 'order not found' })
  const prev = db.orders[idx]
  let nights = o.nights
  const checkin = o.checkin || prev.checkin
  const checkout = o.checkout || prev.checkout
  if (!nights && checkin && checkout) {
    try {
      const ci = new Date(checkin)
      const co = new Date(checkout)
      const ms = co.getTime() - ci.getTime()
      nights = ms > 0 ? Math.round(ms / (1000 * 60 * 60 * 24)) : 0
    } catch { nights = 0 }
  }
  const price = o.price != null ? o.price : (prev.price || 0)
  const cleaning = o.cleaning_fee != null ? o.cleaning_fee : (prev.cleaning_fee || 0)
  const net = o.net_income != null ? o.net_income : (price - cleaning)
  const avg = o.avg_nightly_price != null ? o.avg_nightly_price : (nights && nights > 0 ? Number((net / nights).toFixed(2)) : 0)
  const updated: Order = { ...prev, ...o, nights, net_income: net, avg_nightly_price: avg }
  // local overlap guard on update
  if (updated.property_id && updated.checkin && updated.checkout) {
    const hit = db.orders.some(x => x.id !== id && x.property_id === updated.property_id && rangesOverlap(updated.checkin, updated.checkout, x.checkin, x.checkout))
    if (hit) return res.status(409).json({ message: '订单时间冲突：同一房源在该时段已有订单' })
  }
  db.orders[idx] = updated
  // try remote update; if fails, still respond with updated local record
  if (hasSupabase) {
    supaUpdate('orders', id, updated).catch(() => { pendingUpdate.push({ id, payload: updated }); startRetry() })
  }
  return res.json(updated)
})

router.delete('/:id', requirePerm('order.manage'), async (req, res) => {
  const { id } = req.params
  const idx = db.orders.findIndex((x) => x.id === id)
  let removed: Order | null = null
  if (idx !== -1) {
    removed = db.orders[idx]
    db.orders.splice(idx, 1)
  }
  if (hasSupabase) {
    try {
      const row = await supaDelete('orders', id)
      removed = removed || (row as Order)
      return res.json({ ok: true, id })
    } catch {
      pendingDelete.push(id); startRetry()
      return res.json({ ok: true, id })
    }
  }
  if (!removed) return res.status(404).json({ message: 'order not found' })
  return res.json({ ok: true, id: removed.id })
})
router.delete('/:id', requirePerm('order.manage'), async (req, res) => {
  const { id } = req.params
  const idx = db.orders.findIndex((x) => x.id === id)
  if (idx === -1) return res.status(404).json({ message: 'order not found' })
  const removed = db.orders[idx]
  db.orders.splice(idx, 1)
  if (hasSupabase) await supaDelete('orders', id).catch(() => { pendingDelete.push(id); startRetry() })
  return res.json({ ok: true, id: removed.id })
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
