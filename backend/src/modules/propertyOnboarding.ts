import { Router } from 'express'
import { hasPg, pgSelect, pgInsert, pgUpdate, pgDelete, pgRunInTransaction } from '../dbAdapter'
import { v4 as uuid } from 'uuid'
import { z } from 'zod'
import { requireAnyPerm, requirePerm } from '../auth'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import { hasR2, r2Upload, r2Status, r2DeleteByUrl } from '../r2'

export const router = Router()

const upload = multer({ storage: multer.memoryStorage() })

const createSchema = z.object({ property_id: z.string(), onboarding_date: z.string().optional(), owner_user_id: z.string().optional(), remark: z.string().optional() })
router.post('/', requirePerm('onboarding.manage'), async (req, res) => {
  const parsed = createSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const id = uuid()
  const actor = (req as any).user || {}
  const payload: any = { id, status: 'draft', created_at: new Date().toISOString(), created_by: actor?.sub || actor?.username || null, ...parsed.data }
  try {
    if (hasPg) {
      let address = ''
      try { const rows = await pgSelect('properties', 'address', { id: parsed.data.property_id }); address = rows?.[0]?.address || '' } catch {}
      payload.address_snapshot = address
      const row = await pgInsert('property_onboarding', payload as any)
      return res.status(201).json(row || payload)
    }
    return res.status(201).json(payload)
  } catch (e: any) { return res.status(500).json({ message: e?.message || 'create failed' }) }
})

router.get('/', requireAnyPerm(['onboarding.manage','onboarding.read']), async (req, res) => {
  const { property_id, property_code } = (req.query || {}) as any
  try {
    if (hasPg) {
      // 优先使用 property_id 精确筛选
      if (property_id) {
        const rows = await pgSelect('property_onboarding', '*', { property_id })
        if (Array.isArray(rows) && rows.length > 0) return res.json(rows)
        // 兼容历史数据：若没有命中，尝试以房源 code 作为 property_id 存储的情况
        try {
          const props = await pgSelect('properties', '*', { id: property_id })
          const code = props?.[0]?.code
          if (code) {
            const altRows = await pgSelect('property_onboarding', '*', { property_id: code })
            return res.json(Array.isArray(altRows) ? altRows : [])
          }
        } catch {}
        return res.json([])
      }
      // 若提供 property_code，则按 code 反查
      if (property_code) {
        try {
          const props = await pgSelect('properties', '*', { code: property_code })
          const pid = props?.[0]?.id
          if (pid) {
            const rows = await pgSelect('property_onboarding', '*', { property_id: pid })
            if (Array.isArray(rows) && rows.length > 0) return res.json(rows)
          }
        } catch {}
        // 同时尝试历史存储形式（直接以 code 存在 property_onboarding.property_id）
        const altRows = await pgSelect('property_onboarding', '*', { property_id: property_code })
        return res.json(Array.isArray(altRows) ? altRows : [])
      }
      // 未提供筛选则返回全部
      const all = await pgSelect('property_onboarding', '*')
      return res.json(Array.isArray(all) ? all : [])
    }
    return res.json([])
  } catch (e: any) { return res.status(500).json({ message: e?.message || 'list failed' }) }
})

// price list routes placed BEFORE any /:id routes to avoid shadowing
router.get('/daily-items-prices', requireAnyPerm(['onboarding.manage','onboarding.read']), async (req, res) => {
  const { category } = (req.query || {}) as any
  try {
    if (hasPg) {
      await ensurePriceListColumns()
      try {
        const rows = await pgSelect('daily_items_price_list', '*', category ? { category } : undefined)
        return res.json(Array.isArray(rows) ? rows : [])
      } catch (e: any) {
        const msg = String(e?.message || '')
        const { pgPool } = require('../dbAdapter')
        if (pgPool && /relation\s+"?daily_items_price_list"?\s+does\s+not\s+exist/i.test(msg)) {
          await pgPool.query(`CREATE TABLE IF NOT EXISTS daily_items_price_list (
            id text PRIMARY KEY,
            category text,
            item_name text NOT NULL,
            unit_price numeric NOT NULL,
            currency text DEFAULT 'AUD',
            is_active boolean DEFAULT true,
            updated_at timestamptz,
            updated_by text
          );`)
          await pgPool.query('CREATE UNIQUE INDEX IF NOT EXISTS uniq_daily_items_price ON daily_items_price_list(category, item_name);')
          const rows2 = await pgSelect('daily_items_price_list', '*', category ? { category } : undefined)
          return res.json(Array.isArray(rows2) ? rows2 : [])
        }
        throw e
      }
    }
  } catch (e: any) { return res.status(500).json({ message: e?.message || 'list failed' }) }
  return res.json([])
})
router.post('/daily-items-prices', requirePerm('onboarding.manage'), async (req, res) => {
  const body = req.body || {}
  if (!body.item_name || typeof body.unit_price === 'undefined') return res.status(400).json({ message: 'missing item_name/unit_price' })
  const row: any = { id: uuid(), category: body.category || null, item_name: String(body.item_name), unit_price: Number(body.unit_price || 0), currency: body.currency || 'AUD', unit: body.unit || null, default_quantity: body.default_quantity != null ? Number(body.default_quantity) : null, is_active: body.is_active != null ? !!body.is_active : true, updated_at: new Date().toISOString(), updated_by: (req as any)?.user?.sub || (req as any)?.user?.username || null }
  try {
    if (hasPg) {
      await ensurePriceListColumns()
      try {
        const created = await pgInsert('daily_items_price_list', row)
        return res.status(201).json(created || row)
      } catch (e: any) {
        const msg = String(e?.message || '')
        const { pgPool } = require('../dbAdapter')
        if (pgPool && /relation\s+"?daily_items_price_list"?\s+does\s+not\s+exist/i.test(msg)) {
          await pgPool.query(`CREATE TABLE IF NOT EXISTS daily_items_price_list (
            id text PRIMARY KEY,
            category text,
            item_name text NOT NULL,
            unit_price numeric NOT NULL,
            currency text DEFAULT 'AUD',
            is_active boolean DEFAULT true,
            updated_at timestamptz,
            updated_by text
          );`)
          await pgPool.query('CREATE UNIQUE INDEX IF NOT EXISTS uniq_daily_items_price ON daily_items_price_list(category, item_name);')
          const created2 = await pgInsert('daily_items_price_list', row)
          return res.status(201).json(created2 || row)
        }
        throw e
      }
    }
    return res.status(201).json(row)
  } catch (e: any) { return res.status(500).json({ message: e?.message || 'create failed' }) }
})
router.patch('/daily-items-prices/:id', requirePerm('onboarding.manage'), async (req, res) => {
  const { id } = req.params
  const body = req.body || {}
  try {
    if (hasPg) {
      await ensurePriceListColumns()
      try {
        const updated = await pgUpdate('daily_items_price_list', id, body as any)
        return res.json(updated || { id, ...body })
      } catch (e: any) {
        const msg = String(e?.message || '')
        const { pgPool } = require('../dbAdapter')
        if (pgPool && /relation\s+"?daily_items_price_list"?\s+does\s+not\s+exist/i.test(msg)) {
          await pgPool.query(`CREATE TABLE IF NOT EXISTS daily_items_price_list (
            id text PRIMARY KEY,
            category text,
            item_name text NOT NULL,
            unit_price numeric NOT NULL,
            currency text DEFAULT 'AUD',
            is_active boolean DEFAULT true,
            updated_at timestamptz,
            updated_by text
          );`)
          await pgPool.query('CREATE UNIQUE INDEX IF NOT EXISTS uniq_daily_items_price ON daily_items_price_list(category, item_name);')
          const updated2 = await pgUpdate('daily_items_price_list', id, body as any)
          return res.json(updated2 || { id, ...body })
        }
        throw e
      }
    }
  } catch (e: any) { return res.status(500).json({ message: e?.message || 'update failed' }) }
  return res.json({ id, ...body })
})
router.delete('/daily-items-prices/:id', requirePerm('onboarding.manage'), async (req, res) => {
  const { id } = req.params
  try {
    if (hasPg) {
      await ensurePriceListColumns()
      try {
        await pgDelete('daily_items_price_list', id)
        return res.json({ ok: true })
      } catch (e: any) {
        const msg = String(e?.message || '')
        const { pgPool } = require('../dbAdapter')
        if (pgPool && /relation\s+"?daily_items_price_list"?\s+does\s+not\s+exist/i.test(msg)) {
          await pgPool.query(`CREATE TABLE IF NOT EXISTS daily_items_price_list (
            id text PRIMARY KEY,
            category text,
            item_name text NOT NULL,
            unit_price numeric NOT NULL,
            currency text DEFAULT 'AUD',
            is_active boolean DEFAULT true,
            updated_at timestamptz,
            updated_by text,
            unit text,
            default_quantity integer
          );`)
          await pgPool.query('CREATE UNIQUE INDEX IF NOT EXISTS uniq_daily_items_price ON daily_items_price_list(category, item_name);')
          await pgDelete('daily_items_price_list', id)
          return res.json({ ok: true })
        }
        throw e
      }
    }
    return res.json({ ok: true })
  } catch (e: any) { return res.status(500).json({ message: e?.message || 'delete failed' }) }
})
router.post('/daily-items-prices/bulk', requirePerm('onboarding.manage'), async (req, res) => {
  const list = Array.isArray(req.body) ? req.body : []
  if (!list.length) return res.status(400).json({ message: 'empty payload' })
  try {
    if (hasPg) {
      const { pgPool } = require('../dbAdapter')
      if (!pgPool) return res.status(500).json({ message: 'database not available' })
      const actor = (req as any).user || {}
      const client = await pgPool.connect()
      try {
        await client.query('BEGIN')
        for (const it of list) {
          const category = String(it.category || '') || null
          const name = String(it.item_name || '')
          const unit = Number(it.unit_price || 0)
          const currency = String(it.currency || 'AUD')
          if (!name) continue
          const sql = `INSERT INTO daily_items_price_list (id, category, item_name, unit_price, currency, is_active, updated_at, updated_by)
                       VALUES ($1,$2,$3,$4,$5,TRUE,now(),$6)
                       ON CONFLICT (category, item_name) DO UPDATE SET unit_price=EXCLUDED.unit_price, currency=EXCLUDED.currency, is_active=TRUE, updated_at=now(), updated_by=EXCLUDED.updated_by`
          const { v4: uuid } = require('uuid')
          await client.query(sql, [uuid(), category, name, unit, currency, actor?.sub || actor?.username || null])
        }
        await client.query('COMMIT')
        return res.json({ ok: true, count: list.length })
      } catch (e: any) {
        try { await client.query('ROLLBACK') } catch {}
        return res.status(500).json({ message: e?.message || 'bulk upsert failed' })
      } finally {
        client.release()
      }
    }
    return res.json({ ok: true, count: list.length })
  } catch (e: any) { return res.status(500).json({ message: e?.message || 'bulk failed' }) }
})

// Furniture/Appliance price list
router.get('/fa-items-prices', requireAnyPerm(['onboarding.manage','onboarding.read']), async (req, res) => {
  const { grp } = (req.query || {}) as any
  try { if (hasPg) { await ensureFAListColumns(); const rows = await pgSelect('fa_items_price_list', '*', grp ? { grp } : undefined); return res.json(Array.isArray(rows) ? rows : []) } } catch (e: any) { return res.status(500).json({ message: e?.message || 'list failed' }) }
  return res.json([])
})
router.post('/fa-items-prices', requirePerm('onboarding.manage'), async (req, res) => {
  const b = req.body || {}
  if (!b.item_name || typeof b.unit_price === 'undefined' || !b.grp) return res.status(400).json({ message: 'missing grp/item_name/unit_price' })
  const row: any = { id: uuid(), grp: String(b.grp), item_name: String(b.item_name), unit_price: Number(b.unit_price || 0), currency: b.currency || 'AUD', unit: b.unit || null, default_quantity: b.default_quantity != null ? Number(b.default_quantity) : null, is_active: b.is_active != null ? !!b.is_active : true, updated_at: new Date().toISOString(), updated_by: (req as any)?.user?.sub || (req as any)?.user?.username || null }
  try { if (hasPg) { await ensureFAListColumns(); const created = await pgInsert('fa_items_price_list', row); return res.status(201).json(created || row) } return res.status(201).json(row) } catch (e: any) { return res.status(500).json({ message: e?.message || 'create failed' }) }
})
router.patch('/fa-items-prices/:id', requirePerm('onboarding.manage'), async (req, res) => {
  const { id } = req.params
  const body = req.body || {}
  try { if (hasPg) { await ensureFAListColumns(); const updated = await pgUpdate('fa_items_price_list', id, body as any); return res.json(updated || { id, ...body }) } } catch (e: any) { return res.status(500).json({ message: e?.message || 'update failed' }) }
  return res.json({ id, ...body })
})
router.delete('/fa-items-prices/:id', requirePerm('onboarding.manage'), async (req, res) => {
  const { id } = req.params
  try { if (hasPg) { await ensureFAListColumns(); await pgDelete('fa_items_price_list', id); return res.json({ ok: true }) } return res.json({ ok: true }) } catch (e: any) { return res.status(500).json({ message: e?.message || 'delete failed' }) }
})

router.get('/:id', requireAnyPerm(['onboarding.manage','onboarding.read']), async (req, res) => {
  const { id } = req.params
  try {
    if (hasPg) {
      const rows = await pgSelect('property_onboarding', '*', { id })
      if (rows && rows[0]) return res.json(rows[0])
    }
    return res.status(404).json({ message: 'not found' })
  } catch (e: any) { return res.status(500).json({ message: e?.message || 'get failed' }) }
})

const updateSchema = z.object({ onboarding_date: z.coerce.string().optional(), owner_user_id: z.coerce.string().optional(), remark: z.coerce.string().optional() })
router.patch('/:id', requirePerm('onboarding.manage'), async (req, res) => {
  const parsed = updateSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const { id } = req.params
  const actor = (req as any).user || {}
  const payload: any = { ...parsed.data, updated_at: new Date(), updated_by: actor?.sub || actor?.username || null }
  try { if (hasPg) { const row = await pgUpdate('property_onboarding', id, payload as any); return res.json(row || { id, ...payload }) } } catch (e: any) { return res.status(500).json({ message: e?.message || 'update failed' }) }
  return res.json({ id, ...payload })
})

router.post('/:id/confirm', requirePerm('onboarding.manage'), async (req, res) => {
  const { id } = req.params
  try { if (hasPg) { const row = await pgUpdate('property_onboarding', id, { status: 'confirmed' } as any); return res.json(row || { id, status: 'confirmed' }) } } catch (e: any) { return res.status(500).json({ message: e?.message || 'confirm failed' }) }
  return res.json({ id, status: 'confirmed' })
})

router.post('/:id/unlock', requirePerm('onboarding.manage'), async (req, res) => {
  const { id } = req.params
  try { if (hasPg) { const row = await pgUpdate('property_onboarding', id, { status: 'draft' } as any); return res.json(row || { id, status: 'draft' }) } } catch (e: any) { return res.status(500).json({ message: e?.message || 'unlock failed' }) }
  return res.json({ id, status: 'draft' })
})

// delete onboarding record and its linked items/fees/attachments
router.delete('/:id', requirePerm('onboarding.manage'), async (req, res) => {
  const { id } = req.params
  try {
    if (hasPg) {
      await pgRunInTransaction(async (client) => {
        await client.query('DELETE FROM property_onboarding_items WHERE onboarding_id=$1', [id])
        await client.query('DELETE FROM property_onboarding_fees WHERE onboarding_id=$1', [id])
        await client.query('DELETE FROM property_onboarding_attachments WHERE onboarding_id=$1', [id])
        await client.query('DELETE FROM property_onboarding WHERE id=$1', [id])
      })
      return res.json({ ok: true })
    }
    return res.json({ ok: true })
  } catch (e: any) { return res.status(500).json({ message: e?.message || 'delete failed' }) }
})

router.get('/daily-items-prices', requireAnyPerm(['onboarding.manage','onboarding.read']), async (req, res) => {
  const { category } = (req.query || {}) as any
  try {
    if (hasPg) {
      try {
        const rows = await pgSelect('daily_items_price_list', '*', category ? { category } : undefined)
        return res.json(Array.isArray(rows) ? rows : [])
      } catch (e: any) {
        const msg = String(e?.message || '')
        const { pgPool } = require('../dbAdapter')
        if (pgPool && /relation\s+"?daily_items_price_list"?\s+does\s+not\s+exist/i.test(msg)) {
          await pgPool.query(`CREATE TABLE IF NOT EXISTS daily_items_price_list (
            id text PRIMARY KEY,
            category text,
            item_name text NOT NULL,
            unit_price numeric NOT NULL,
            currency text DEFAULT 'AUD',
            is_active boolean DEFAULT true,
            updated_at timestamptz,
            updated_by text
          );`)
          await pgPool.query('CREATE UNIQUE INDEX IF NOT EXISTS uniq_daily_items_price ON daily_items_price_list(category, item_name);')
          const rows2 = await pgSelect('daily_items_price_list', '*', category ? { category } : undefined)
          return res.json(Array.isArray(rows2) ? rows2 : [])
        }
        throw e
      }
    }
  } catch (e: any) { return res.status(500).json({ message: e?.message || 'list failed' }) }
  return res.json([])
})
router.post('/daily-items-prices', requirePerm('onboarding.manage'), async (req, res) => {
  const body = req.body || {}
  if (!body.item_name || typeof body.unit_price === 'undefined') return res.status(400).json({ message: 'missing item_name/unit_price' })
  const row: any = { id: uuid(), category: body.category || null, item_name: String(body.item_name), unit_price: Number(body.unit_price || 0), currency: body.currency || 'AUD', is_active: body.is_active != null ? !!body.is_active : true, updated_at: new Date().toISOString(), updated_by: (req as any)?.user?.sub || (req as any)?.user?.username || null }
  try {
    if (hasPg) {
      try {
        const created = await pgInsert('daily_items_price_list', row)
        return res.status(201).json(created || row)
      } catch (e: any) {
        const msg = String(e?.message || '')
        const { pgPool } = require('../dbAdapter')
        if (pgPool && /relation\s+"?daily_items_price_list"?\s+does\s+not\s+exist/i.test(msg)) {
          await pgPool.query(`CREATE TABLE IF NOT EXISTS daily_items_price_list (
            id text PRIMARY KEY,
            category text,
            item_name text NOT NULL,
            unit_price numeric NOT NULL,
            currency text DEFAULT 'AUD',
            is_active boolean DEFAULT true,
            updated_at timestamptz,
            updated_by text
          );`)
          await pgPool.query('CREATE UNIQUE INDEX IF NOT EXISTS uniq_daily_items_price ON daily_items_price_list(category, item_name);')
          const created2 = await pgInsert('daily_items_price_list', row)
          return res.status(201).json(created2 || row)
        }
        throw e
      }
    }
    return res.status(201).json(row)
  } catch (e: any) { return res.status(500).json({ message: e?.message || 'create failed' }) }
})
router.patch('/daily-items-prices/:id', requirePerm('onboarding.manage'), async (req, res) => {
  const { id } = req.params
  const body = req.body || {}
  try {
    if (hasPg) {
      try {
        const updated = await pgUpdate('daily_items_price_list', id, body as any)
        return res.json(updated || { id, ...body })
      } catch (e: any) {
        const msg = String(e?.message || '')
        const { pgPool } = require('../dbAdapter')
        if (pgPool && /relation\s+"?daily_items_price_list"?\s+does\s+not\s+exist/i.test(msg)) {
          await pgPool.query(`CREATE TABLE IF NOT EXISTS daily_items_price_list (
            id text PRIMARY KEY,
            category text,
            item_name text NOT NULL,
            unit_price numeric NOT NULL,
            currency text DEFAULT 'AUD',
            is_active boolean DEFAULT true,
            updated_at timestamptz,
            updated_by text
          );`)
          await pgPool.query('CREATE UNIQUE INDEX IF NOT EXISTS uniq_daily_items_price ON daily_items_price_list(category, item_name);')
          const updated2 = await pgUpdate('daily_items_price_list', id, body as any)
          return res.json(updated2 || { id, ...body })
        }
        throw e
      }
    }
  } catch (e: any) { return res.status(500).json({ message: e?.message || 'update failed' }) }
  return res.json({ id, ...body })
})

// bulk upsert daily items prices
router.post('/daily-items-prices/bulk', requirePerm('onboarding.manage'), async (req, res) => {
  const list = Array.isArray(req.body) ? req.body : []
  if (!list.length) return res.status(400).json({ message: 'empty payload' })
  try {
    if (hasPg) {
      const { pgPool } = require('../dbAdapter')
      if (!pgPool) return res.status(500).json({ message: 'database not available' })
      const actor = (req as any).user || {}
      const client = await pgPool.connect()
      try {
        await client.query('BEGIN')
        for (const it of list) {
          const category = String(it.category || '') || null
          const name = String(it.item_name || '')
          const unit = Number(it.unit_price || 0)
          const currency = String(it.currency || 'AUD')
          if (!name) continue
          const sql = `INSERT INTO daily_items_price_list (id, category, item_name, unit_price, currency, is_active, updated_at, updated_by)
                       VALUES ($1,$2,$3,$4,$5,TRUE,now(),$6)
                       ON CONFLICT (category, item_name) DO UPDATE SET unit_price=EXCLUDED.unit_price, currency=EXCLUDED.currency, is_active=TRUE, updated_at=now(), updated_by=EXCLUDED.updated_by`
          const { v4: uuid } = require('uuid')
          await client.query(sql, [uuid(), category, name, unit, currency, actor?.sub || actor?.username || null])
        }
        await client.query('COMMIT')
        return res.json({ ok: true, count: list.length })
      } catch (e: any) {
        try { await client.query('ROLLBACK') } catch {}
        return res.status(500).json({ message: e?.message || 'bulk upsert failed' })
      } finally {
        client.release()
      }
    }
    return res.json({ ok: true, count: list.length })
  } catch (e: any) { return res.status(500).json({ message: e?.message || 'bulk failed' }) }
})

const itemCreateSchema = z.object({ group: z.enum(['daily','furniture','appliance','decor']), category: z.string().optional(), item_name: z.string(), brand: z.string().optional(), condition: z.enum(['New','Used']).optional(), quantity: z.coerce.number().int().min(1), unit_price: z.coerce.number().min(0), is_custom: z.boolean().optional(), price_list_id: z.string().optional(), remark: z.string().optional() })
router.get('/:id/items', requireAnyPerm(['onboarding.manage','onboarding.read']), async (req, res) => {
  const { id } = req.params
  const { group } = (req.query || {}) as any
  try { if (hasPg) { const rows = await pgSelect('property_onboarding_items', '*', group ? { onboarding_id: id, group } as any : { onboarding_id: id } as any); return res.json(Array.isArray(rows) ? rows : []) } } catch (e: any) { return res.status(500).json({ message: e?.message || 'list failed' }) }
  return res.json([])
})
router.post('/:id/items', requirePerm('onboarding.manage'), async (req, res) => {
  const { id } = req.params
  const parsed = itemCreateSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const body = parsed.data
  let qty = Number(body.quantity || 0)
  let unitPrice = Number(body.unit_price || 0)
  let unitStr: string | null = null
  // if daily and quantity not provided, default from price_list
  if (body.group === 'daily' && (!qty || qty <= 0) && body.price_list_id) {
    try {
      const rows = await pgSelect('daily_items_price_list', '*', { id: body.price_list_id })
      const p = rows && rows[0]
      if (p) {
        qty = Number(p.default_quantity || 1)
        unitStr = p.unit || null
        if (!unitPrice || unitPrice <= 0) unitPrice = Number(p.unit_price || 0)
      }
    } catch {}
  }
  if (!qty || qty <= 0) qty = 1
  const total = unitPrice * qty
  const row: any = { id: uuid(), onboarding_id: id, group: body.group, category: body.category || null, item_name: body.item_name, brand: body.brand || null, condition: body.condition || null, quantity: qty, unit_price: unitPrice, total_price: total, unit: unitStr, is_custom: !!body.is_custom, price_list_id: body.price_list_id || null, remark: body.remark || null }
  try {
    if (hasPg) {
      const created = await pgInsert('property_onboarding_items', row)
      await recomputeTotals(id)
      return res.status(201).json(created || row)
    }
    return res.status(201).json(row)
  } catch (e: any) { return res.status(500).json({ message: e?.message || 'create failed' }) }
})
router.patch('/:id/items/:itemId', requirePerm('onboarding.manage'), async (req, res) => {
  const { id, itemId } = req.params
  const body = req.body || {}
  if (hasPg) {
    try {
      const prevRows = await pgSelect('property_onboarding_items', '*', { id: itemId }) as any[]
      const prev = prevRows && prevRows[0]
      if (prev) {
        const u = body.unit_price != null ? Number(body.unit_price) : Number(prev.unit_price || 0)
        const q = body.quantity != null ? Number(body.quantity) : Number(prev.quantity || 0)
        body.total_price = Number.isFinite(u) && Number.isFinite(q) ? (u * q) : undefined
      } else if (body.unit_price != null || body.quantity != null) {
        const u = Number(body.unit_price ?? 0)
        const q = Number(body.quantity ?? 0)
        body.total_price = Number.isFinite(u) && Number.isFinite(q) ? (u * q) : undefined
      }
    } catch {}
  } else if (body.unit_price != null || body.quantity != null) {
    const u = Number(body.unit_price ?? 0)
    const q = Number(body.quantity ?? 0)
    body.total_price = Number.isFinite(u) && Number.isFinite(q) ? (u * q) : undefined
  }
  try {
    if (hasPg) {
      const updated = await pgUpdate('property_onboarding_items', itemId, body as any)
      await recomputeTotals(id)
      return res.json(updated || { id: itemId, ...body })
    }
    return res.json({ id: itemId, ...body })
  } catch (e: any) { return res.status(500).json({ message: e?.message || 'update failed' }) }
})
router.delete('/:id/items/:itemId', requirePerm('onboarding.manage'), async (req, res) => {
  const { id, itemId } = req.params
  try { if (hasPg) { await pgDelete('property_onboarding_items', itemId); await recomputeTotals(id); return res.json({ ok: true }) } } catch (e: any) { return res.status(500).json({ message: e?.message || 'delete failed' }) }
  return res.json({ ok: true })
})

const feeCreateSchema = z.object({ fee_type: z.string(), name: z.string(), unit_price: z.coerce.number().min(0), quantity: z.coerce.number().int().min(1).default(1), include_in_property_cost: z.boolean().default(true), waived: z.boolean().default(false), remark: z.string().optional() })
router.get('/:id/fees', requireAnyPerm(['onboarding.manage','onboarding.read']), async (req, res) => {
  const { id } = req.params
  try { if (hasPg) { await ensureFeesColumns(); const rows = await pgSelect('property_onboarding_fees', '*', { onboarding_id: id }); return res.json(Array.isArray(rows) ? rows : []) } } catch (e: any) { return res.status(500).json({ message: e?.message || 'list failed' }) }
  return res.json([])
})
router.post('/:id/fees', requirePerm('onboarding.manage'), async (req, res) => {
  const { id } = req.params
  const parsed = feeCreateSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const body = parsed.data
  const total = Number(body.unit_price || 0) * Number(body.quantity || 1)
  const row: any = { id: uuid(), onboarding_id: id, fee_type: body.fee_type, name: body.name, unit_price: Number(body.unit_price || 0), quantity: Number(body.quantity || 1), total_price: total, include_in_property_cost: !!body.include_in_property_cost, waived: !!body.waived, remark: body.remark || null }
  try { if (hasPg) { await ensureFeesColumns(); const created = await pgInsert('property_onboarding_fees', row); await recomputeTotals(id); return res.status(201).json(created || row) } } catch (e: any) { return res.status(500).json({ message: e?.message || 'create failed' }) }
  return res.status(201).json(row)
})
router.patch('/:id/fees/:feeId', requirePerm('onboarding.manage'), async (req, res) => {
  const { id, feeId } = req.params
  const body = req.body || {}
  if (hasPg) {
    try {
      await ensureFeesColumns()
      const prevRows = await pgSelect('property_onboarding_fees', '*', { id: feeId }) as any[]
      const prev = prevRows && prevRows[0]
      if (prev) {
        const u = body.unit_price != null ? Number(body.unit_price) : Number(prev.unit_price || 0)
        const q = body.quantity != null ? Number(body.quantity) : Number(prev.quantity || 0)
        body.total_price = Number.isFinite(u) && Number.isFinite(q) ? (u * q) : undefined
      } else if (body.unit_price != null || body.quantity != null) {
        const u = Number(body.unit_price ?? 0)
        const q = Number(body.quantity ?? 0)
        body.total_price = Number.isFinite(u) && Number.isFinite(q) ? (u * q) : undefined
      }
    } catch {}
  } else if (body.unit_price != null || body.quantity != null) {
    const u = Number(body.unit_price ?? 0)
    const q = Number(body.quantity ?? 0)
    body.total_price = Number.isFinite(u) && Number.isFinite(q) ? (u * q) : undefined
  }
  try { if (hasPg) { const updated = await pgUpdate('property_onboarding_fees', feeId, body as any); await recomputeTotals(id); return res.json(updated || { id: feeId, ...body }) } } catch (e: any) { return res.status(500).json({ message: e?.message || 'update failed' }) }
  return res.json({ id: feeId, ...body })
})
router.delete('/:id/fees/:feeId', requirePerm('onboarding.manage'), async (req, res) => {
  const { id, feeId } = req.params
  try { if (hasPg) { await pgDelete('property_onboarding_fees', feeId); await recomputeTotals(id); return res.json({ ok: true }) } } catch (e: any) { return res.status(500).json({ message: e?.message || 'delete failed' }) }
  return res.json({ ok: true })
})

router.post('/:id/attachments/upload', requireAnyPerm(['onboarding.manage']), upload.any(), async (req, res) => {
  const { id } = req.params
  const files = (req.files || []) as Express.Multer.File[]
  if (!files || !files.length) return res.status(400).json({ message: 'missing files' })
  try {
    const actor = (req as any).user || {}
    const out: any[] = []
    for (const f of files) {
      const ext = path.extname(f.originalname) || ''
      let url = ''
      if (hasR2 && (f as any).buffer) {
        const key = `onboarding/${id}/${uuid()}${ext}`
        url = await r2Upload(key, f.mimetype || 'application/octet-stream', (f as any).buffer)
      } else {
        const dir = path.join(process.cwd(), 'uploads', 'onboarding', id)
        await fs.promises.mkdir(dir, { recursive: true })
        const name = `${uuid()}${ext}`
        const full = path.join(dir, name)
        await fs.promises.writeFile(full, (f as any).buffer)
        url = `/uploads/onboarding/${id}/${name}`
      }
      if (hasPg) {
        // 去重：相同文件名和大小则跳过重复插入
        try {
          const exist = await pgSelect('property_onboarding_attachments', '*', { onboarding_id: id, file_name: f.originalname, file_size: f.size })
          if (Array.isArray(exist) && exist.length) {
            out.push(exist[0])
            continue
          }
        } catch {}
        await pgInsert('property_onboarding_attachments', { id: uuid(), onboarding_id: id, url, file_name: f.originalname, mime_type: f.mimetype, file_size: f.size, created_by: actor?.sub || actor?.username || null } as any)
      }
      out.push({ url })
    }
    return res.status(201).json(out)
  } catch (e: any) { return res.status(500).json({ message: e?.message || 'upload failed' }) }
})

// list attachments
router.get('/:id/attachments', requireAnyPerm(['onboarding.manage','onboarding.read']), async (req, res) => {
  const { id } = req.params
  try {
    if (hasPg) {
      const rows = await pgSelect('property_onboarding_attachments', '*', { onboarding_id: id })
      return res.json(Array.isArray(rows) ? rows : [])
    }
    return res.json([])
  } catch (e: any) { return res.status(500).json({ message: e?.message || 'list failed' }) }
})

router.delete('/:id/attachments/:attId', requireAnyPerm(['onboarding.manage']), async (req, res) => {
  const { id, attId } = req.params
  try {
    if (hasPg) {
      let url: string | null = null
      try { const rows = await pgSelect('property_onboarding_attachments', '*', { id: attId }); url = rows?.[0]?.url || null } catch {}
      await pgDelete('property_onboarding_attachments', attId)
      // 删除本地文件
      if (url && /^\/uploads\//.test(url)) {
        try { const full = path.join(process.cwd(), url.replace(/^\/+/, '')); await fs.promises.unlink(full) } catch {}
      }
      // 删除 R2 对象
      if (url && /^https?:\/\//.test(url)) {
        try { await r2DeleteByUrl(url) } catch {}
      }
      return res.json({ ok: true })
    }
    return res.json({ ok: true })
  } catch (e: any) { return res.status(500).json({ message: e?.message || 'delete failed' }) }
})

router.get('/storage-info', requireAnyPerm(['onboarding.manage','onboarding.read']), async (_req, res) => {
  try {
    const info = r2Status()
    return res.json(info)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'status failed' })
  }
})

router.get('/r2-test', requireAnyPerm(['onboarding.manage','onboarding.read']), async (_req, res) => {
  try {
    const info = r2Status()
    if (!info.hasR2) return res.status(400).json({ ok: false, reason: 'r2_not_configured', info })
    const key = `onboarding/r2-test/${uuid()}.txt`
    const buf = Buffer.from('ok')
    const url = await r2Upload(key, 'text/plain', buf)
    let status = 0
    let size = 0
    try {
      const proto = url.startsWith('https') ? require('https') : require('http')
      await new Promise<void>((resolve, reject) => {
        const req2 = proto.get(url, (resp: any) => {
          status = Number(resp.statusCode || 0)
          const chunks: Buffer[] = []
          resp.on('data', (c: any) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
          resp.on('end', () => { size = Buffer.concat(chunks).length; resolve() })
        })
        req2.on('error', reject)
      })
    } catch {}
    return res.json({ ok: true, url, get_status: status, bytes: size })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'r2 test failed' })
  }
})

router.post('/:id/generate-pdf', requirePerm('onboarding.manage'), async (req, res) => {
  const { id } = req.params
  const { pdf_base64 } = req.body || {}
  if (!pdf_base64 || typeof pdf_base64 !== 'string') return res.status(400).json({ message: 'missing pdf_base64' })
  try {
    const b64 = pdf_base64.replace(/^data:application\/pdf;base64,/, '')
    const buf = Buffer.from(b64, 'base64')
    let url = ''
    const name = `onboarding-${id}.pdf`
    if (hasR2) {
      const key = `onboarding/${id}/${name}`
      url = await r2Upload(key, 'application/pdf', buf)
    } else {
      const dir = path.join(process.cwd(), 'uploads', 'onboarding', id)
      await fs.promises.mkdir(dir, { recursive: true })
      const full = path.join(dir, name)
      await fs.promises.writeFile(full, buf)
      url = `/uploads/onboarding/${id}/${name}`
    }
    if (hasPg) {
      await pgRunInTransaction(async (client) => {
        await client.query('INSERT INTO property_onboarding_attachments (id,onboarding_id,url,file_name,mime_type,file_size) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING', [uuid(), id, url, name, 'application/pdf', buf.length])
        await client.query('UPDATE property_onboarding SET status=$1 WHERE id=$2', ['pdf_generated', id])
      })
    }
    return res.status(201).json({ url })
  } catch (e: any) { return res.status(500).json({ message: e?.message || 'generate failed' }) }
})

router.post('/:id/merge-pdf', requireAnyPerm(['onboarding.manage','onboarding.read']), async (req, res) => {
  const { id } = req.params
  const { pdf_base64 } = req.body || {}
  if (!pdf_base64 || typeof pdf_base64 !== 'string') return res.status(400).json({ message: 'missing pdf_base64' })
  try {
    const { PDFDocument } = require('pdf-lib')
    const b64 = pdf_base64.replace(/^data:application\/pdf;base64,/, '')
    const baseBuf: Buffer = Buffer.from(b64, 'base64')
    const merged = await PDFDocument.create()
    const baseDoc = await PDFDocument.load(baseBuf)
    const basePages = await merged.copyPages(baseDoc, baseDoc.getPageIndices())
    basePages.forEach((p: any) => merged.addPage(p))
    let atts: any[] = []
    if (hasPg) {
      const rows = await pgSelect('property_onboarding_attachments', '*', { onboarding_id: id })
      atts = Array.isArray(rows) ? rows : []
    }
    const nameMain = `onboarding-${id}.pdf`
    const seen = new Set<string>()
    const list = atts.filter(a => {
      const name = String(a.file_name||'')
      const url = String(a.url||'')
      if (name === nameMain || /onboarding\/[^/]+\/${nameMain}$/i.test(url)) return false
      const isPdf = /application\/pdf/i.test(String(a.mime_type||'')) || /\.pdf(\?|$)/i.test(String(name||url))
      if (!isPdf) return false
      const key = url || name
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    const imgList = atts.filter(a => {
      const name = String(a.file_name||'')
      const url = String(a.url||'')
      const isImg = /image\/(jpeg|jpg|png)/i.test(String(a.mime_type||'')) || /\.(jpeg|jpg|png)(\?|$)/i.test(String(name||url))
      if (!isImg) return false
      const key = url || name
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    async function readBuf(u: string): Promise<Buffer> {
      try {
        const clean = String(u).replace(/\?[^#]*$/, '')
        if (/^https?:\/\//i.test(clean)) {
          const proto = u.startsWith('https') ? require('https') : require('http')
          return await new Promise((resolve, reject) => {
            const req2 = proto.get(clean, (resp: any) => {
              const chunks: Buffer[] = []
              resp.on('data', (c: any) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
              resp.on('end', () => resolve(Buffer.concat(chunks)))
            })
            req2.on('error', reject)
          })
        }
        if (clean.startsWith('/')) {
          const full = path.join(process.cwd(), clean.replace(/^\/+/, ''))
          return await fs.promises.readFile(full)
        }
      } catch {}
      return Buffer.alloc(0)
    }
    for (const a of list) {
      const buf = await readBuf(String(a.url||''))
      if (buf && buf.length) {
        try {
          const doc = await PDFDocument.load(buf)
          const pages = await merged.copyPages(doc, doc.getPageIndices())
          pages.forEach((p: any) => merged.addPage(p))
        } catch {}
      }
    }
    // append images as single-page A4
    const A4 = { w: 595, h: 842 }
    for (const a of imgList) {
      const b = await readBuf(String(a.url||''))
      if (!b || !b.length) continue
      try {
        const isJpeg = /\.(jpe?g)(\?|$)/i.test(String(a.file_name||a.url||'')) || /image\/jpeg/i.test(String(a.mime_type||''))
        const img = isJpeg ? await merged.embedJpg(b) : await merged.embedPng(b)
        const page = merged.addPage([A4.w, A4.h])
        const margin = 24
        const maxW = A4.w - margin * 2
        const maxH = A4.h - margin * 2
        const iw = img.width, ih = img.height
        const scale = Math.min(maxW / iw, maxH / ih)
        const dw = iw * scale, dh = ih * scale
        const dx = (A4.w - dw) / 2, dy = (A4.h - dh) / 2
        page.drawImage(img, { x: dx, y: dy, width: dw, height: dh })
      } catch {}
    }
    const out = Buffer.from(await merged.save())
    const fname = `Property Onboarding Listing - ${id}.pdf`
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`)
    return res.send(out)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'merge failed' })
  }
})

router.post('/:id/merge-pdf-binary', requireAnyPerm(['onboarding.manage','onboarding.read']), (require('express').raw({ type: 'application/pdf', limit: '100mb' })), async (req, res) => {
  const { id } = req.params
  try {
    const { PDFDocument } = require('pdf-lib')
    const baseBuf: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from([])
    if (!baseBuf || baseBuf.length === 0) return res.status(400).json({ message: 'empty pdf buffer' })
    const merged = await PDFDocument.create()
    const baseDoc = await PDFDocument.load(baseBuf)
    const basePages = await merged.copyPages(baseDoc, baseDoc.getPageIndices())
    basePages.forEach((p: any) => merged.addPage(p))
    let atts: any[] = []
    if (hasPg) {
      const rows = await pgSelect('property_onboarding_attachments', '*', { onboarding_id: id })
      atts = Array.isArray(rows) ? rows : []
    }
    const nameMain = `onboarding-${id}.pdf`
    const seen = new Set<string>()
    const list = atts.filter(a => {
      const name = String(a.file_name||'')
      const url = String(a.url||'')
      if (name === nameMain || /onboarding\/[^/]+\/${nameMain}$/i.test(url)) return false
      const isPdf = /application\/pdf/i.test(String(a.mime_type||'')) || /\.pdf(\?|$)/i.test(String(name||url))
      if (!isPdf) return false
      const key = url || name
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    const imgList = atts.filter(a => {
      const name = String(a.file_name||'')
      const url = String(a.url||'')
      const isImg = /image\/(jpeg|jpg|png)/i.test(String(a.mime_type||'')) || /\.(jpeg|jpg|png)(\?|$)/i.test(String(name||url))
      if (!isImg) return false
      const key = url || name
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    async function readBuf(u: string): Promise<Buffer> {
      try {
        const clean = String(u).replace(/\?[^#]*$/, '')
        if (/^https?:\/\//i.test(clean)) {
          const proto = u.startsWith('https') ? require('https') : require('http')
          return await new Promise((resolve, reject) => {
            const req2 = proto.get(clean, (resp: any) => {
              const chunks: Buffer[] = []
              resp.on('data', (c: any) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
              resp.on('end', () => resolve(Buffer.concat(chunks)))
            })
            req2.on('error', reject)
          })
        }
        if (clean.startsWith('/')) {
          const full = path.join(process.cwd(), clean.replace(/^\/+/, ''))
          return await fs.promises.readFile(full)
        }
      } catch {}
      return Buffer.alloc(0)
    }
    for (const a of list) {
      const buf = await readBuf(String(a.url||''))
      if (buf && buf.length) {
        try {
        const doc = await PDFDocument.load(buf)
        const pages = await merged.copyPages(doc, doc.getPageIndices())
        pages.forEach((p: any) => merged.addPage(p))
        } catch {}
      }
    }
    const A4 = { w: 595, h: 842 }
    for (const a of imgList) {
      const b = await readBuf(String(a.url||''))
      if (!b || !b.length) continue
      try {
        const isJpeg = /\.(jpe?g)(\?|$)/i.test(String(a.file_name||a.url||'')) || /image\/jpeg/i.test(String(a.mime_type||''))
        const img = isJpeg ? await merged.embedJpg(b) : await merged.embedPng(b)
        const page = merged.addPage([A4.w, A4.h])
        const margin = 24
        const maxW = A4.w - margin * 2
        const maxH = A4.h - margin * 2
        const iw = img.width, ih = img.height
        const scale = Math.min(maxW / iw, maxH / ih)
        const dw = iw * scale, dh = ih * scale
        const dx = (A4.w - dw) / 2, dy = (A4.h - dh) / 2
        page.drawImage(img, { x: dx, y: dy, width: dw, height: dh })
      } catch {}
    }
    const out = Buffer.from(await merged.save())
    const fname = `Property Onboarding Listing - ${id}.pdf`
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`)
    return res.send(out)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'merge failed' })
  }
})

async function recomputeTotals(onboardingId: string) {
  try {
    if (!hasPg) return
    const { pgPool } = require('../dbAdapter')
    if (!pgPool) return
    const sql = `
      WITH sums AS (
        SELECT
          COALESCE(SUM(CASE WHEN "group"='daily' THEN total_price ELSE 0 END),0) AS daily,
          COALESCE(SUM(CASE WHEN "group" IN ('furniture','appliance') THEN total_price ELSE 0 END),0) AS furn,
          COALESCE(SUM(CASE WHEN "group"='decor' THEN total_price ELSE 0 END),0) AS decor
        FROM property_onboarding_items WHERE onboarding_id = $1
      ), fees AS (
        SELECT COALESCE(SUM(total_price),0) AS fees_total, COALESCE(SUM(CASE WHEN include_in_property_cost AND NOT COALESCE(waived,false) THEN total_price ELSE 0 END),0) AS fees_cost
        FROM property_onboarding_fees WHERE onboarding_id = $1
      )
      SELECT s.daily AS daily, s.furn AS furn, s.decor AS decor, f.fees_total AS fees_total, (s.daily + s.furn + s.decor + f.fees_cost) AS grand
      FROM sums s CROSS JOIN fees f`
    const r = await pgPool.query(sql, [onboardingId])
    const row = r.rows?.[0] || { daily: 0, furn: 0, decor: 0, fees_total: 0, grand: 0 }
    await pgUpdate('property_onboarding', onboardingId, {
      daily_items_total: Number(row.daily || 0),
      furniture_appliance_total: Number(row.furn || 0),
      decor_total: Number(row.decor || 0),
      oneoff_fees_total: Number(row.fees_total || 0),
      grand_total: Number(row.grand || 0),
    } as any)
  } catch {}
}

export default router
async function ensurePriceListColumns() {
  try {
    if (!hasPg) return
    const { pgPool } = require('../dbAdapter')
    if (pgPool) {
      await pgPool.query('ALTER TABLE daily_items_price_list ADD COLUMN IF NOT EXISTS unit text;')
      await pgPool.query('ALTER TABLE daily_items_price_list ADD COLUMN IF NOT EXISTS default_quantity integer;')
    }
  } catch {}
}

async function ensureFAListColumns() {
  try {
    if (!hasPg) return
    const { pgPool } = require('../dbAdapter')
    if (pgPool) {
      await pgPool.query(`CREATE TABLE IF NOT EXISTS fa_items_price_list (
        id text PRIMARY KEY,
        grp text,
        item_name text NOT NULL,
        unit_price numeric NOT NULL,
        currency text DEFAULT 'AUD',
        unit text,
        default_quantity integer,
        is_active boolean DEFAULT true,
        updated_at timestamptz,
        updated_by text
      );`)
      await pgPool.query('CREATE UNIQUE INDEX IF NOT EXISTS uniq_fa_items_price ON fa_items_price_list(grp, item_name);')
    }
  } catch {}
}

async function ensureFeesColumns() {
  try {
    if (!hasPg) return
    const { pgPool } = require('../dbAdapter')
    if (pgPool) {
      await pgPool.query('ALTER TABLE property_onboarding_fees ADD COLUMN IF NOT EXISTS waived boolean DEFAULT false;')
    }
  } catch {}
}
