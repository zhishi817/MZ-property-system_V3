import { Router, text } from 'express'
import { db, Order, CleaningTask } from '../store'
import { z } from 'zod'
import { requirePerm, requireAnyPerm } from '../auth'
import { hasSupabase, supaSelect, supaInsert, supaUpdate, supaDelete, supaUpsertConflict } from '../supabase'
import { hasPg, pgSelect, pgInsert, pgUpdate, pgDelete } from '../dbAdapter'

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
    if (hasPg) {
      const remote: any[] = (await pgSelect('orders')) || []
      const local = db.orders
      const merged = [...remote, ...local.filter((l) => !remote.some((r: any) => r.id === l.id))]
      let pRows: any[] = []
      try { pRows = (await pgSelect('properties', 'id,code,address')) as any[] || [] } catch {}
      const byId: Record<string, any> = Object.fromEntries((pRows || []).map((p: any) => [String(p.id), p]))
      const byCode: Record<string, any> = Object.fromEntries((pRows || []).map((p: any) => [String(p.code || ''), p]))
      const labeled = merged.map((o: any) => {
        const pid = String(o.property_id || '')
        const prop = byId[pid] || byCode[pid]
        const label = (o.property_code || prop?.code || prop?.address || pid)
        return { ...o, property_code: label }
      })
      return res.json(labeled)
    }
    if (hasSupabase) {
      const remote: any[] = (await supaSelect('orders')) || []
      const local = db.orders
      const merged = [...remote, ...local.filter((l) => !remote.some((r: any) => r.id === l.id))]
      let pRows: any[] = []
      try { pRows = (await supaSelect('properties', 'id,code,address')) as any[] || [] } catch {}
      const byId: Record<string, any> = Object.fromEntries((pRows || []).map((p: any) => [String(p.id), p]))
      const byCode: Record<string, any> = Object.fromEntries((pRows || []).map((p: any) => [String(p.code || ''), p]))
      const labeled = merged.map((o: any) => {
        const pid = String(o.property_id || '')
        const prop = byId[pid] || byCode[pid]
        const label = (o.property_code || prop?.code || prop?.address || pid)
        return { ...o, property_code: label }
      })
      return res.json(labeled)
    }
    return res.json(db.orders.map((o) => {
      const prop = db.properties.find((p) => String(p.id) === String(o.property_id)) || db.properties.find((p) => String(p.code || '') === String(o.property_id || ''))
      return { ...o, property_code: (o.property_code || prop?.code || prop?.address || o.property_id || '') }
    }))
  } catch {
    return res.json(db.orders.map((o) => {
      const prop = db.properties.find((p) => String(p.id) === String(o.property_id)) || db.properties.find((p) => String(p.code || '') === String(o.property_id || ''))
      return { ...o, property_code: (o.property_code || prop?.code || prop?.address || o.property_id || '') }
    }))
  }
})

router.get('/:id', async (req, res) => {
  const { id } = req.params
  const local = db.orders.find((o) => o.id === id)
  if (local) return res.json(local)
  try {
    if (hasPg) {
      const remote = await pgSelect('orders', '*', { id })
      const row = Array.isArray(remote) ? remote[0] : null
      if (row) return res.json(row)
    }
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
  guest_phone: z.string().optional(),
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
function normalizeStart(s?: string): Date | null {
  if (!s) return null
  const hasTime = /T\d{2}:\d{2}/.test(s)
  const d = new Date(hasTime ? s : `${s}T12:00:00`)
  return isNaN(d.getTime()) ? null : d
}
function normalizeEnd(s?: string): Date | null {
  if (!s) return null
  const hasTime = /T\d{2}:\d{2}/.test(s)
  const d = new Date(hasTime ? s : `${s}T11:59:59`)
  return isNaN(d.getTime()) ? null : d
}

function rangesOverlap(aStart?: string, aEnd?: string, bStart?: string, bEnd?: string): boolean {
  const ds = (s?: string) => (s ? String(s).slice(0,10) : '')
  const as = ds(aStart); const ae = ds(aEnd); const bs = ds(bStart); const be = ds(bEnd)
  if (!as || !ae || !bs || !be) return false
  const asDay = new Date(`${as}T00:00:00`)
  const aeDay = new Date(`${ae}T00:00:00`)
  const bsDay = new Date(`${bs}T00:00:00`)
  const beDay = new Date(`${be}T00:00:00`)
  // day-level exclusive end: [checkin, checkout)
  return asDay < beDay && bsDay < aeDay
}

function toIsoString(v: any): string {
  if (!v) return ''
  if (typeof v === 'string') return v
  try { const d = new Date(v); return isNaN(d.getTime()) ? '' : d.toISOString() } catch { return '' }
}
async function hasOrderOverlap(propertyId?: string, checkin?: string, checkout?: string, excludeId?: string): Promise<boolean> {
  if (!propertyId || !checkin || !checkout) return false
  const ciDay = String(checkin || '').slice(0,10)
  const coDay = String(checkout || '').slice(0,10)
  const localHit = db.orders.some(o => {
    if (o.property_id !== propertyId || o.id === excludeId) return false
    const oCiDay = String(o.checkin || '').slice(0,10)
    const oCoDay = String(o.checkout || '').slice(0,10)
    if (oCoDay === ciDay || coDay === oCiDay) return false
    return rangesOverlap(checkin, checkout, o.checkin, o.checkout)
  })
  if (localHit) return true
  try {
    if (hasPg) {
      const rows: any[] = (await pgSelect('orders', '*', { property_id: propertyId })) || []
      const remoteHit = rows.some((o: any) => {
        if (o.id === excludeId) return false
        const oCiDay = String(o.checkin || '').slice(0,10)
        const oCoDay = String(o.checkout || '').slice(0,10)
        if (oCoDay === ciDay || coDay === oCiDay) return false
        return rangesOverlap(checkin, checkout, o.checkin, o.checkout)
      })
      if (remoteHit) return true
    }
    if (hasSupabase) {
      const rows: any[] = (await supaSelect('orders', '*', { property_id: propertyId })) || []
      const remoteHit = rows.some((o: any) => {
        if (o.id === excludeId) return false
        const oCiDay = String(o.checkin || '').slice(0,10)
        const oCoDay = String(o.checkout || '').slice(0,10)
        if (oCoDay === ciDay || coDay === oCiDay) return false
        return rangesOverlap(checkin, checkout, o.checkin, o.checkout)
      })
      if (remoteHit) return true
    }
  } catch {}
  return false
}

router.post('/sync', requireAnyPerm(['order.create','order.manage']), async (req, res) => {
  const parsed = createOrderSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const o = parsed.data
  try {
    const ci = normalizeStart(o.checkin || '')
    const co = normalizeEnd(o.checkout || '')
    if (ci && co && !(ci < co)) return res.status(400).json({ message: '入住日期必须早于退房日期' })
  } catch {}
  let propertyId = o.property_id || (o.property_code ? (db.properties.find(p => (p.code || '') === o.property_code)?.id) : undefined)
  // 如果传入的 property_id 不存在于 PG，则尝试用房号 code 在 PG 中查找并替换
  if (hasPg) {
    try {
      const byId: any[] = propertyId ? (await pgSelect('properties', 'id', { id: propertyId })) || [] : []
      const existsById = Array.isArray(byId) && !!byId[0]
      if (!existsById && o.property_code) {
        const byCode: any[] = (await pgSelect('properties', '*', { code: o.property_code })) || []
        if (Array.isArray(byCode) && byCode[0]?.id) propertyId = byCode[0].id
      }
    } catch {}
  }
  const key = o.idempotency_key || `${propertyId || ''}-${o.checkin || ''}-${o.checkout || ''}`
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
  const newOrder: Order = { id: uuid(), ...o, property_id: propertyId, nights, net_income: net, avg_nightly_price: avg, idempotency_key: key, status: 'confirmed' }
  // overlap guard
  const conflict = await hasOrderOverlap(newOrder.property_id, newOrder.checkin, newOrder.checkout)
  if (conflict) return res.status(409).json({ message: '订单时间冲突：同一房源在该时段已有订单' })
  if (hasPg) {
    try {
      if (newOrder.property_id) {
        try {
          const propRows: any[] = (await pgSelect('properties', 'id', { id: newOrder.property_id })) || []
          const existsProp = Array.isArray(propRows) && propRows[0]
          if (!existsProp) {
            const localProp = db.properties.find(p => p.id === newOrder.property_id)
            const code = (newOrder.property_code || localProp?.code)
            const payload: any = { id: newOrder.property_id }
            if (code) payload.code = code
            if (localProp?.address) payload.address = localProp.address
            await pgInsert('properties', payload)
          }
        } catch {}
      }
      const insertOrder: any = { ...newOrder }
      delete insertOrder.property_code
      const row = await pgInsert('orders', insertOrder)
      db.orders.push(row as any)
      if (newOrder.checkout) {
        const date = newOrder.checkout
        const hasTask = db.cleaningTasks.find((t) => t.date === date && t.property_id === newOrder.property_id)
        if (!hasTask) {
          const task = { id: uuid(), property_id: newOrder.property_id, date, status: 'pending' as const }
          db.cleaningTasks.push(task)
        }
      }
      return res.status(201).json(row)
    } catch (e: any) {
      const msg = String(e?.message || '')
      if (msg.includes('duplicate') || msg.includes('unique')) return res.status(409).json({ message: '订单已存在：唯一键冲突' })
      return res.status(500).json({ message: '数据库写入失败', error: msg })
    }
  }
  if (hasSupabase) {
    supaUpsertConflict('orders', newOrder, 'id')
      .then((row) => res.status(201).json(row))
      .catch((_err) => { pendingInsert.push(newOrder); startRetry(); return res.status(201).json(newOrder) })
    return
  }
  // 无远端数据库，使用内存存储
  db.orders.push(newOrder)
  if (newOrder.checkout) {
    const date = newOrder.checkout
    const hasTask = db.cleaningTasks.find((t) => t.date === date && t.property_id === newOrder.property_id)
    if (!hasTask) {
      const task = { id: uuid(), property_id: newOrder.property_id, date, status: 'pending' as const }
      db.cleaningTasks.push(task)
    }
  }
  return res.status(201).json(newOrder)
})

router.patch('/:id', requirePerm('order.write'), async (req, res) => {
  const { id } = req.params
  const parsed = updateOrderSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const o = parsed.data
  const force = String((req.body as any).force ?? (req.query as any).force ?? '').toLowerCase() === 'true'
  const idx = db.orders.findIndex((x) => x.id === id)
  const prev = idx !== -1 ? db.orders[idx] : undefined
  if (!prev && !hasSupabase) return res.status(404).json({ message: 'order not found' })

  const base = prev || ({} as Order)
  let nights = o.nights
  const checkin = o.checkin || base.checkin
  const checkout = o.checkout || base.checkout
  try {
    const ci0 = normalizeStart(checkin || '')
    const co0 = normalizeEnd(checkout || '')
    if (ci0 && co0 && !(ci0 < co0)) return res.status(400).json({ message: '入住日期必须早于退房日期' })
  } catch {}
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
  const changedCore = (
    (updated.property_id || '') !== (prev?.property_id || '') ||
    ((updated.checkin || '').slice(0,10)) !== ((prev?.checkin || '').slice(0,10)) ||
    ((updated.checkout || '').slice(0,10)) !== ((prev?.checkout || '').slice(0,10))
  )
  // 编辑场景不再阻断，允许覆盖更新（冲突仅在创建时校验）
  // 保留内部工具函数供日志或后续使用，但不阻塞响应

  if (idx !== -1) {
    db.orders[idx] = updated
  }

  if (hasPg) {
    try {
      const row = await pgUpdate('orders', id, updated as any)
      if (idx !== -1) db.orders[idx] = row as any
      return res.json(row)
    } catch (e) {
      return res.status(500).json({ message: '数据库更新失败' })
    }
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
router.patch('/:id', requirePerm('order.write'), (req, res) => {
  const { id } = req.params
  const parsed = createOrderSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const o = parsed.data
  const force = String((req.body as any).force ?? (req.query as any).force ?? '').toLowerCase() === 'true'
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
  // local overlap guard on update，仅在关键字段变更时检查
  const changedCore2 = (
    (updated.property_id || '') !== (prev?.property_id || '') ||
    ((updated.checkin || '').slice(0,10)) !== ((prev?.checkin || '').slice(0,10)) ||
    ((updated.checkout || '').slice(0,10)) !== ((prev?.checkout || '').slice(0,10))
  )
  // 编辑场景：不再返回 409 冲突
  db.orders[idx] = updated
  // try remote update; if fails, still respond with updated local record
  if (hasSupabase) {
    supaUpdate('orders', id, updated).catch(() => { pendingUpdate.push({ id, payload: updated }); startRetry() })
  }
  return res.json(updated)
})

router.delete('/:id', requirePerm('order.write'), async (req, res) => {
  const { id } = req.params
  const idx = db.orders.findIndex((x) => x.id === id)
  let removed: Order | null = null
  if (idx !== -1) {
    removed = db.orders[idx]
    db.orders.splice(idx, 1)
  }
  if (hasPg) {
    try {
      const row = await pgDelete('orders', id)
      removed = removed || (row as any)
      return res.json({ ok: true, id })
    } catch (e) {
      return res.status(500).json({ message: '数据库删除失败' })
    }
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
router.delete('/:id', requirePerm('order.write'), async (req, res) => {
  const { id } = req.params
  const idx = db.orders.findIndex((x) => x.id === id)
  if (idx === -1) return res.status(404).json({ message: 'order not found' })
  const removed = db.orders[idx]
  db.orders.splice(idx, 1)
  if (hasPg) {
    try { await pgDelete('orders', id) } catch {}
  } else if (hasSupabase) {
    await supaDelete('orders', id).catch(() => { pendingDelete.push(id); startRetry() })
  }
  return res.json({ ok: true, id: removed.id })
})

router.post('/:id/generate-cleaning', requirePerm('order.write'), (req, res) => {
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

router.post('/import', requirePerm('order.manage'), text({ type: ['text/csv','text/plain'] }), async (req, res) => {
  function toNumber(v: any): number | undefined {
    if (v == null || v === '') return undefined
    const n = Number(v)
    return isNaN(n) ? undefined : n
  }
  function parseCsv(s: string): any[] {
    const lines = (s || '').split(/\r?\n/).filter(l => l.trim().length)
    if (!lines.length) return []
    const header = lines[0].split(',').map(h => h.trim())
    const rows = lines.slice(1).map(l => l.split(',')).map(cols => {
      const obj: any = {}
      header.forEach((h, i) => { obj[h] = (cols[i] || '').trim() })
      return obj
    })
    return rows
  }
  const rawBody = typeof req.body === 'string' ? req.body : ''
  const rowsInput: any[] = Array.isArray((req as any).body) ? (req as any).body : parseCsv(rawBody)
  const results: { ok: boolean; id?: string; error?: string }[] = []
  let inserted = 0
  let skipped = 0
  for (const r of rowsInput) {
    try {
      const source = String(r.source || 'offline')
      const property_code = r.property_code || r.propertyCode || undefined
      const property_id = r.property_id || r.propertyId || (property_code ? (db.properties.find(p => (p.code || '') === property_code)?.id) : undefined)
      const guest_name = r.guest_name || r.guest || undefined
      const checkin = r.checkin || r.check_in || r.start_date || undefined
      const checkout = r.checkout || r.check_out || r.end_date || undefined
      const price = toNumber(r.price)
      const cleaning_fee = toNumber(r.cleaning_fee)
      const currency = r.currency || 'AUD'
      const status = r.status || 'confirmed'
      const parsed = createOrderSchema.safeParse({ source, property_id, property_code, guest_name, checkin, checkout, price, cleaning_fee, currency, status })
      if (!parsed.success) { results.push({ ok: false, error: 'invalid row' }); skipped++; continue }
      const o = parsed.data
      const key = o.idempotency_key || `${o.property_id || ''}-${o.checkin || ''}-${o.checkout || ''}`
      const exists = db.orders.find((x) => x.idempotency_key === key)
      if (exists) { results.push({ ok: false, error: 'duplicate' }); skipped++; continue }
      const { v4: uuid } = require('uuid')
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
      const total = o.price || 0
      const net = o.net_income != null ? o.net_income : (total - cleaning)
      const avg = o.avg_nightly_price != null ? o.avg_nightly_price : (nights && nights > 0 ? Number((net / nights).toFixed(2)) : 0)
      const newOrder: Order = { id: uuid(), ...o, nights, net_income: net, avg_nightly_price: avg, idempotency_key: key }
      const conflict = await hasOrderOverlap(newOrder.property_id, newOrder.checkin, newOrder.checkout)
      if (conflict) { results.push({ ok: false, error: 'overlap' }); skipped++; continue }
      db.orders.push(newOrder)
      if (newOrder.checkout) {
        const date = newOrder.checkout
        const hasTask = db.cleaningTasks.find((t) => t.date === date && t.property_id === newOrder.property_id)
        if (!hasTask) {
          const task = { id: uuid(), property_id: newOrder.property_id, date, status: 'pending' as const }
          db.cleaningTasks.push(task)
        }
      }
      if (hasPg) {
        try { await pgInsert('orders', newOrder as any) } catch {}
      } else if (hasSupabase) {
        try { await supaUpsertConflict('orders', newOrder, 'id') } catch { pendingInsert.push(newOrder); startRetry() }
      }
      inserted++
      results.push({ ok: true, id: newOrder.id })
    } catch (e: any) {
      results.push({ ok: false, error: e?.message || 'error' }); skipped++
    }
  }
  res.json({ inserted, skipped, results })
})
