import { Router } from 'express'
import { db, addAudit } from '../store'
import { z } from 'zod'
import { requirePerm } from '../auth'
import { hasPg, pgPool, pgRunInTransaction } from '../dbAdapter'
import { v4 as uuidv4 } from 'uuid'

export const router = Router()

function actorId(req: any) {
  const u = req?.user || {}
  return u?.sub || u?.username || null
}

let inventorySchemaEnsured = false
async function ensureInventorySchema() {
  if (!pgPool) return
  if (inventorySchemaEnsured) return
  inventorySchemaEnsured = true
  try {
    await pgPool.query(`CREATE TABLE IF NOT EXISTS warehouses (
      id text PRIMARY KEY,
      code text NOT NULL,
      name text NOT NULL,
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now()
    );`)
    await pgPool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'unique_warehouses_code') THEN
        ALTER TABLE warehouses ADD CONSTRAINT unique_warehouses_code UNIQUE (code);
      END IF;
    END $$;`)

    await pgPool.query(`CREATE TABLE IF NOT EXISTS inventory_items (
      id text PRIMARY KEY,
      name text NOT NULL,
      sku text NOT NULL,
      category text NOT NULL DEFAULT 'consumable',
      unit text NOT NULL,
      default_threshold integer NOT NULL DEFAULT 0,
      bin_location text,
      active boolean NOT NULL DEFAULT true,
      is_key_item boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz
    );`)
    await pgPool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'unique_inventory_items_sku') THEN
        ALTER TABLE inventory_items ADD CONSTRAINT unique_inventory_items_sku UNIQUE (sku);
      END IF;
    END $$;`)
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_inventory_items_category ON inventory_items(category);')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_inventory_items_active ON inventory_items(active);')

    await pgPool.query(`CREATE TABLE IF NOT EXISTS warehouse_stocks (
      id text PRIMARY KEY,
      warehouse_id text NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      item_id text NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
      quantity integer NOT NULL DEFAULT 0,
      threshold integer,
      updated_at timestamptz
    );`)
    await pgPool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'unique_warehouse_item') THEN
        ALTER TABLE warehouse_stocks ADD CONSTRAINT unique_warehouse_item UNIQUE (warehouse_id, item_id);
      END IF;
    END $$;`)
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_warehouse_stocks_wh ON warehouse_stocks(warehouse_id);')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_warehouse_stocks_item ON warehouse_stocks(item_id);')

    await pgPool.query(`CREATE TABLE IF NOT EXISTS suppliers (
      id text PRIMARY KEY,
      name text NOT NULL,
      kind text NOT NULL DEFAULT 'linen',
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now()
    );`)
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_suppliers_active ON suppliers(active);')

    await pgPool.query(`CREATE TABLE IF NOT EXISTS region_supplier_rules (
      id text PRIMARY KEY,
      region_key text NOT NULL,
      supplier_id text NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
      priority integer NOT NULL DEFAULT 0,
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now()
    );`)
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_region_supplier_rules_region ON region_supplier_rules(region_key);')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_region_supplier_rules_active ON region_supplier_rules(active);')

    await pgPool.query(`CREATE TABLE IF NOT EXISTS purchase_orders (
      id text PRIMARY KEY,
      supplier_id text NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
      warehouse_id text NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
      status text NOT NULL DEFAULT 'draft',
      requested_delivery_date date,
      note text,
      created_by text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz
    );`)
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_purchase_orders_supplier ON purchase_orders(supplier_id);')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_purchase_orders_warehouse ON purchase_orders(warehouse_id);')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_purchase_orders_status ON purchase_orders(status);')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_purchase_orders_created_at ON purchase_orders(created_at);')

    await pgPool.query(`CREATE TABLE IF NOT EXISTS purchase_order_lines (
      id text PRIMARY KEY,
      po_id text NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
      item_id text NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
      quantity integer NOT NULL,
      unit text NOT NULL,
      unit_price numeric,
      note text
    );`)
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_purchase_order_lines_po ON purchase_order_lines(po_id);')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_purchase_order_lines_item ON purchase_order_lines(item_id);')

    await pgPool.query(`CREATE TABLE IF NOT EXISTS purchase_deliveries (
      id text PRIMARY KEY,
      po_id text NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
      received_at timestamptz NOT NULL DEFAULT now(),
      received_by text,
      note text,
      created_at timestamptz NOT NULL DEFAULT now()
    );`)
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_purchase_deliveries_po ON purchase_deliveries(po_id);')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_purchase_deliveries_received_at ON purchase_deliveries(received_at);')

    await pgPool.query(`CREATE TABLE IF NOT EXISTS purchase_delivery_lines (
      id text PRIMARY KEY,
      delivery_id text NOT NULL REFERENCES purchase_deliveries(id) ON DELETE CASCADE,
      item_id text NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
      quantity_received integer NOT NULL,
      note text
    );`)
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_purchase_delivery_lines_delivery ON purchase_delivery_lines(delivery_id);')

    await pgPool.query(`CREATE TABLE IF NOT EXISTS stock_movements (
      id text PRIMARY KEY,
      warehouse_id text NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
      item_id text NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
      type text NOT NULL,
      reason text,
      quantity integer NOT NULL,
      property_id text REFERENCES properties(id) ON DELETE SET NULL,
      ref_type text,
      ref_id text,
      actor_id text,
      note text,
      created_at timestamptz NOT NULL DEFAULT now()
    );`)
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_stock_movements_wh ON stock_movements(warehouse_id);')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_stock_movements_item ON stock_movements(item_id);')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_stock_movements_property ON stock_movements(property_id);')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_stock_movements_created_at ON stock_movements(created_at);')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_stock_movements_ref ON stock_movements(ref_type, ref_id);')
    await pgPool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_movements_type_check') THEN
        ALTER TABLE stock_movements
          ADD CONSTRAINT stock_movements_type_check
          CHECK (type IN ('in','out','adjust'));
      END IF;
    END $$;`)

    await pgPool.query(`INSERT INTO warehouses (id, code, name) VALUES
      ('wh.south_melbourne', 'SOU', 'South Melbourne'),
      ('wh.msq', 'MSQ', 'MSQ'),
      ('wh.wsp', 'WSP', 'WSP'),
      ('wh.my80', 'MY80', 'My80')
    ON CONFLICT (id) DO NOTHING;`)

    await pgPool.query(`INSERT INTO suppliers (id, name, kind) VALUES
      ('sup.linen.1', '床品供应商1', 'linen'),
      ('sup.linen.2', '床品供应商2', 'linen')
    ON CONFLICT (id) DO NOTHING;`)

    await pgPool.query(`INSERT INTO region_supplier_rules (id, region_key, supplier_id, priority) VALUES
      ('rsr.southbank', 'Southbank', 'sup.linen.1', 100),
      ('rsr.default', '*', 'sup.linen.2', 0)
    ON CONFLICT (id) DO NOTHING;`)
  } catch (e) {
    inventorySchemaEnsured = false
    throw e
  }
}

async function pickSupplierIdForRegion(region: string | null) {
  if (!pgPool) return null
  await ensureInventorySchema()
  const r = String(region || '').trim()
  const rows = await pgPool.query(
    `SELECT supplier_id
     FROM region_supplier_rules
     WHERE active = true
       AND (region_key = $1 OR region_key = '*')
     ORDER BY (CASE WHEN region_key = $1 THEN 1 ELSE 0 END) DESC, priority DESC
     LIMIT 1`,
    [r || '__none__'],
  )
  return rows.rows?.[0]?.supplier_id || null
}

async function ensureWarehouseStockRow(client: any, warehouse_id: string, item_id: string) {
  const id = `ws.${warehouse_id}.${item_id}`
  await client.query(
    `INSERT INTO warehouse_stocks (id, warehouse_id, item_id, quantity)
     VALUES ($1, $2, $3, 0)
     ON CONFLICT (warehouse_id, item_id) DO NOTHING`,
    [id, warehouse_id, item_id],
  )
}

async function applyStockDeltaInTx(client: any, input: {
  warehouse_id: string
  item_id: string
  type: 'in' | 'out' | 'adjust'
  quantity: number
  reason?: string | null
  property_id?: string | null
  ref_type?: string | null
  ref_id?: string | null
  actor_id?: string | null
  note?: string | null
}) {
  await ensureWarehouseStockRow(client, input.warehouse_id, input.item_id)
  const lock = await client.query(
    `SELECT id, quantity
     FROM warehouse_stocks
     WHERE warehouse_id = $1 AND item_id = $2
     FOR UPDATE`,
    [input.warehouse_id, input.item_id],
  )
  const row = lock.rows?.[0]
  if (!row) throw new Error('warehouse stock missing')

  const delta = input.type === 'in' ? input.quantity : input.type === 'out' ? -input.quantity : input.quantity
  const nextQty = Number(row.quantity || 0) + Number(delta || 0)
  if (nextQty < 0) return { ok: false as const, code: 409 as const, message: 'insufficient stock' }

  await client.query(`UPDATE warehouse_stocks SET quantity = $1, updated_at = now() WHERE id = $2`, [nextQty, row.id])

  const moveId = uuidv4()
  await client.query(
    `INSERT INTO stock_movements (id, warehouse_id, item_id, type, reason, quantity, property_id, ref_type, ref_id, actor_id, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      moveId,
      input.warehouse_id,
      input.item_id,
      input.type,
      input.reason || null,
      input.quantity,
      input.property_id || null,
      input.ref_type || null,
      input.ref_id || null,
      input.actor_id || null,
      input.note || null,
    ],
  )

  const after = await client.query(`SELECT * FROM warehouse_stocks WHERE id = $1`, [row.id])
  return { ok: true as const, stock: after.rows?.[0] || null, movement_id: moveId }
}

router.get('/warehouses', requirePerm('inventory.view'), async (req, res) => {
  try {
    if (hasPg && pgPool) {
      await ensureInventorySchema()
      const rows = await pgPool.query(`SELECT id, code, name, active FROM warehouses ORDER BY code ASC`)
      return res.json(rows.rows || [])
    }
    return res.json([
      { id: 'wh.south_melbourne', code: 'SOU', name: 'South Melbourne', active: true },
      { id: 'wh.msq', code: 'MSQ', name: 'MSQ', active: true },
      { id: 'wh.wsp', code: 'WSP', name: 'WSP', active: true },
      { id: 'wh.my80', code: 'MY80', name: 'My80', active: true },
    ])
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.get('/items', requirePerm('inventory.view'), async (req, res) => {
  try {
    const q = String((req.query as any)?.q || '').trim()
    const category = String((req.query as any)?.category || '').trim()
    const active = String((req.query as any)?.active || '').trim().toLowerCase()
    if (hasPg && pgPool) {
      await ensureInventorySchema()
      const where: string[] = []
      const values: any[] = []
      if (q) {
        values.push(`%${q}%`)
        values.push(`%${q}%`)
        where.push(`(name ILIKE $${values.length - 1} OR sku ILIKE $${values.length})`)
      }
      if (category) {
        values.push(category)
        where.push(`category = $${values.length}`)
      }
      if (active === 'true' || active === 'false') {
        values.push(active === 'true')
        where.push(`active = $${values.length}`)
      }
      const sql = `SELECT id, name, sku, category, unit, default_threshold, bin_location, active, is_key_item
                   FROM inventory_items
                   ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                   ORDER BY name ASC`
      const rows = await pgPool.query(sql, values)
      return res.json(rows.rows || [])
    }
    return res.json(db.inventoryItems || [])
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

const createItemSchema = z.object({
  name: z.string().min(1),
  sku: z.string().min(1),
  category: z.enum(['linen','consumable','daily']).optional(),
  unit: z.string().min(1),
  default_threshold: z.number().int().min(0).optional(),
  bin_location: z.string().optional(),
  active: z.boolean().optional(),
  is_key_item: z.boolean().optional(),
})

router.post('/items', requirePerm('inventory.item.manage'), async (req, res) => {
  const parsed = createItemSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (hasPg && pgPool) {
      await ensureInventorySchema()
      const item: any = {
        id: uuidv4(),
        name: parsed.data.name,
        sku: parsed.data.sku,
        category: parsed.data.category || 'consumable',
        unit: parsed.data.unit,
        default_threshold: parsed.data.default_threshold ?? 0,
        bin_location: parsed.data.bin_location || null,
        active: parsed.data.active ?? true,
        is_key_item: parsed.data.is_key_item ?? false,
      }
      const row = await pgPool.query(
        `INSERT INTO inventory_items (id, name, sku, category, unit, default_threshold, bin_location, active, is_key_item)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING *`,
        [item.id, item.name, item.sku, item.category, item.unit, item.default_threshold, item.bin_location, item.active, item.is_key_item],
      )
      addAudit('InventoryItem', item.id, 'create', null, row.rows?.[0] || item, actorId(req))
      return res.status(201).json(row.rows?.[0] || item)
    }
    const item = { id: uuidv4(), threshold: parsed.data.default_threshold ?? 0, quantity: 0, ...parsed.data, category: parsed.data.category || 'consumable' }
    db.inventoryItems.push(item as any)
    addAudit('InventoryItem', item.id, 'create', null, item, actorId(req))
    return res.status(201).json(item)
  } catch (e: any) {
    const msg = String(e?.message || '')
    if (/unique_inventory_items_sku/i.test(msg) || /duplicate key value/i.test(msg)) return res.status(400).json({ message: 'SKU 已存在' })
    return res.status(500).json({ message: msg || 'failed' })
  }
})

const patchItemSchema = createItemSchema.partial()

router.patch('/items/:id', requirePerm('inventory.item.manage'), async (req, res) => {
  const parsed = patchItemSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const id = String(req.params.id || '')
  try {
    if (hasPg && pgPool) {
      await ensureInventorySchema()
      const before = await pgPool.query(`SELECT * FROM inventory_items WHERE id = $1`, [id])
      const b = before.rows?.[0]
      if (!b) return res.status(404).json({ message: 'item not found' })
      const payload = parsed.data as any
      const keys = Object.keys(payload).filter(k => payload[k] !== undefined)
      if (!keys.length) return res.json(b)
      const sets = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ')
      const values = keys.map(k => (payload as any)[k])
      const sql = `UPDATE inventory_items SET ${sets}, updated_at = now() WHERE id = $${keys.length + 1} RETURNING *`
      const after = await pgPool.query(sql, [...values, id])
      addAudit('InventoryItem', id, 'update', b, after.rows?.[0] || null, actorId(req))
      return res.json(after.rows?.[0] || null)
    }
    const it: any = db.inventoryItems.find((x: any) => x.id === id)
    if (!it) return res.status(404).json({ message: 'item not found' })
    const before = { ...it }
    Object.assign(it, parsed.data)
    addAudit('InventoryItem', id, 'update', before, it, actorId(req))
    return res.json(it)
  } catch (e: any) {
    const msg = String(e?.message || '')
    if (/unique_inventory_items_sku/i.test(msg) || /duplicate key value/i.test(msg)) return res.status(400).json({ message: 'SKU 已存在' })
    return res.status(500).json({ message: msg || 'failed' })
  }
})

router.get('/stocks', requirePerm('inventory.view'), async (req, res) => {
  const warehouse_id = String((req.query as any)?.warehouse_id || '').trim()
  if (!warehouse_id) return res.status(400).json({ message: 'warehouse_id required' })
  const warningsOnly = String((req.query as any)?.warnings_only || '').toLowerCase() === 'true'
  const keyOnly = String((req.query as any)?.key_only || '').toLowerCase() === 'true'
  try {
    if (hasPg && pgPool) {
      await ensureInventorySchema()
      const values: any[] = [warehouse_id]
      const where: string[] = [`s.warehouse_id = $1`]
      if (keyOnly) where.push(`i.is_key_item = true`)
      const sql = `
        SELECT
          s.id,
          s.warehouse_id,
          s.item_id,
          s.quantity,
          s.threshold,
          i.name,
          i.sku,
          i.category,
          i.unit,
          i.default_threshold,
          i.bin_location,
          i.active,
          i.is_key_item
        FROM warehouse_stocks s
        JOIN inventory_items i ON i.id = s.item_id
        WHERE ${where.join(' AND ')}
        ORDER BY i.name ASC
      `
      const rows = await pgPool.query(sql, values)
      let out = (rows.rows || []).map((r: any) => ({
        ...r,
        threshold_effective: r.threshold === null || r.threshold === undefined ? Number(r.default_threshold || 0) : Number(r.threshold || 0),
      }))
      if (warningsOnly) out = out.filter((x: any) => Number(x.quantity || 0) < Number(x.threshold_effective || 0))
      return res.json(out)
    }
    return res.json([])
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.get('/warnings', requirePerm('inventory.view'), async (req, res) => {
  const warehouse_id = String((req.query as any)?.warehouse_id || '').trim()
  try {
    if (hasPg && pgPool) {
      await ensureInventorySchema()
      const values: any[] = []
      const where: string[] = []
      if (warehouse_id) {
        values.push(warehouse_id)
        where.push(`s.warehouse_id = $${values.length}`)
      }
      const sql = `
        SELECT
          s.id,
          s.warehouse_id,
          s.item_id,
          s.quantity,
          s.threshold,
          i.name,
          i.sku,
          i.category,
          i.unit,
          i.default_threshold
        FROM warehouse_stocks s
        JOIN inventory_items i ON i.id = s.item_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      `
      const rows = await pgPool.query(sql, values)
      const out = (rows.rows || []).map((r: any) => {
        const eff = r.threshold === null || r.threshold === undefined ? Number(r.default_threshold || 0) : Number(r.threshold || 0)
        return { ...r, threshold_effective: eff }
      }).filter((x: any) => Number(x.quantity || 0) < Number(x.threshold_effective || 0))
      return res.json(out)
    }
    return res.json((db.inventoryItems || []).filter((i: any) => i.quantity < i.threshold))
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

const movementSchema = z.object({
  warehouse_id: z.string().min(1),
  item_id: z.string().min(1),
  type: z.enum(['in','out','adjust']),
  quantity: z.number().int(),
  reason: z.string().optional(),
  property_id: z.string().optional(),
  ref_type: z.string().optional(),
  ref_id: z.string().optional(),
  note: z.string().optional(),
}).superRefine((v, ctx) => {
  if (v.type === 'in' || v.type === 'out') {
    if (v.quantity <= 0) ctx.addIssue({ code: 'custom', message: 'quantity must be >= 1', path: ['quantity'] })
  } else {
    if (v.quantity === 0) ctx.addIssue({ code: 'custom', message: 'quantity must not be 0', path: ['quantity'] })
  }
})

router.post('/movements', requirePerm('inventory.move'), async (req, res) => {
  const parsed = movementSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (hasPg && pgPool) {
      await ensureInventorySchema()
      const result = await pgRunInTransaction(async (client) => {
        const r = await applyStockDeltaInTx(client, {
          warehouse_id: parsed.data.warehouse_id,
          item_id: parsed.data.item_id,
          type: parsed.data.type,
          quantity: parsed.data.quantity,
          reason: parsed.data.reason || null,
          property_id: parsed.data.property_id || null,
          ref_type: parsed.data.ref_type || null,
          ref_id: parsed.data.ref_id || null,
          actor_id: actorId(req),
          note: parsed.data.note || null,
        })
        if (!r.ok) return r
        const stockRow = r.stock
        addAudit('WarehouseStock', stockRow?.id || `${parsed.data.warehouse_id}.${parsed.data.item_id}`, 'movement', null, { movement_id: r.movement_id, stock: stockRow }, actorId(req))
        return r
      })
      if (!result) return res.status(500).json({ message: 'db not ready' })
      if (!(result as any).ok) return res.status((result as any).code).json({ message: (result as any).message })
      return res.json((result as any).stock || null)
    }
    const item = db.inventoryItems.find((i: any) => i.id === parsed.data.item_id)
    if (!item) return res.status(404).json({ message: 'item not found' })
    const before = { ...item }
    if (parsed.data.type === 'in') item.quantity += parsed.data.quantity
    else if (parsed.data.type === 'out') {
      if (item.quantity < parsed.data.quantity) return res.status(409).json({ message: 'insufficient stock' })
      item.quantity -= parsed.data.quantity
    } else item.quantity += parsed.data.quantity
    db.stockMovements.push({ id: uuidv4(), item_id: item.id, type: parsed.data.type, quantity: parsed.data.quantity, timestamp: new Date().toISOString() } as any)
    addAudit('InventoryItem', item.id, 'movement', before, item, actorId(req))
    return res.json(item)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

const transferSchema = z.object({
  from_warehouse_id: z.string().min(1),
  to_warehouse_id: z.string().min(1),
  item_id: z.string().min(1),
  quantity: z.number().int().min(1),
  note: z.string().optional(),
})

router.post('/transfers', requirePerm('inventory.move'), async (req, res) => {
  const parsed = transferSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  if (parsed.data.from_warehouse_id === parsed.data.to_warehouse_id) return res.status(400).json({ message: 'same warehouse' })
  try {
    if (hasPg && pgPool) {
      await ensureInventorySchema()
      const transferId = uuidv4()
      const result = await pgRunInTransaction(async (client) => {
        const out = await applyStockDeltaInTx(client, {
          warehouse_id: parsed.data.from_warehouse_id,
          item_id: parsed.data.item_id,
          type: 'out',
          quantity: parsed.data.quantity,
          reason: 'transfer',
          ref_type: 'transfer',
          ref_id: transferId,
          actor_id: actorId(req),
          note: parsed.data.note || null,
        })
        if (!out.ok) return out
        const inn = await applyStockDeltaInTx(client, {
          warehouse_id: parsed.data.to_warehouse_id,
          item_id: parsed.data.item_id,
          type: 'in',
          quantity: parsed.data.quantity,
          reason: 'transfer',
          ref_type: 'transfer',
          ref_id: transferId,
          actor_id: actorId(req),
          note: parsed.data.note || null,
        })
        if (!inn.ok) return inn
        return { ok: true as const, transfer_id: transferId, from_stock: out.stock, to_stock: inn.stock }
      })
      if (!result) return res.status(500).json({ message: 'db not ready' })
      if (!(result as any).ok) return res.status((result as any).code).json({ message: (result as any).message })
      return res.json(result)
    }
    return res.status(501).json({ message: 'transfer not available without PG' })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.get('/movements', requirePerm('inventory.view'), async (req, res) => {
  try {
    if (hasPg && pgPool) {
      await ensureInventorySchema()
      const q: any = req.query || {}
      const wh = String(q.warehouse_id || '').trim()
      const item = String(q.item_id || '').trim()
      const prop = String(q.property_id || '').trim()
      const type = String(q.type || '').trim()
      const category = String(q.category || '').trim()
      const reason = String(q.reason || '').trim()
      const from = String(q.from || '').trim()
      const to = String(q.to || '').trim()
      const limit = Math.min(500, Math.max(1, Number(q.limit || 100)))

      const where: string[] = []
      const values: any[] = []
      if (wh) { values.push(wh); where.push(`m.warehouse_id = $${values.length}`) }
      if (item) { values.push(item); where.push(`m.item_id = $${values.length}`) }
      if (prop) { values.push(prop); where.push(`m.property_id = $${values.length}`) }
      if (type) { values.push(type); where.push(`m.type = $${values.length}`) }
      if (category) { values.push(category); where.push(`i.category = $${values.length}`) }
      if (reason) { values.push(reason); where.push(`m.reason = $${values.length}`) }
      if (from) { values.push(from); where.push(`m.created_at >= $${values.length}::timestamptz`) }
      if (to) { values.push(to); where.push(`m.created_at <= $${values.length}::timestamptz`) }
      values.push(limit)

      const sql = `
        SELECT
          m.*,
          i.name AS item_name,
          i.sku AS item_sku,
          w.code AS warehouse_code,
          w.name AS warehouse_name,
          p.code AS property_code,
          p.address AS property_address
        FROM stock_movements m
        JOIN inventory_items i ON i.id = m.item_id
        JOIN warehouses w ON w.id = m.warehouse_id
        LEFT JOIN properties p ON p.id = m.property_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY m.created_at DESC
        LIMIT $${values.length}
      `
      const rows = await pgPool.query(sql, values)
      return res.json(rows.rows || [])
    }
    return res.json(db.stockMovements || [])
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

async function ensureDailyNecessitiesSchema() {
  if (!pgPool) return
  await pgPool.query(`CREATE TABLE IF NOT EXISTS property_daily_necessities (
    id text PRIMARY KEY,
    property_id text,
    created_by text,
    created_at timestamptz DEFAULT now()
  );`)
  await pgPool.query('ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS property_code text;')
  await pgPool.query('ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS status text;')
  await pgPool.query('ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS item_name text;')
  await pgPool.query('ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS quantity integer;')
  await pgPool.query('ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS note text;')
  await pgPool.query('ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS photo_urls jsonb;')
  await pgPool.query('ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS source_task_id text;')
  await pgPool.query('ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS submitted_at timestamptz;')
  await pgPool.query('ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS submitter_name text;')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_property_daily_necessities_prop ON property_daily_necessities(property_id);')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_property_daily_necessities_status ON property_daily_necessities(status);')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_property_daily_necessities_created_at ON property_daily_necessities(created_at);')
}

router.get('/daily-replacements', requirePerm('inventory.view'), async (req, res) => {
  try {
    if (hasPg && pgPool) {
      await ensureInventorySchema()
      await ensureDailyNecessitiesSchema()
      const q: any = req.query || {}
      const statusRaw = String(q.status || '').trim()
      const statuses = statusRaw
        ? statusRaw
            .split(',')
            .map((s) => String(s || '').trim())
            .filter(Boolean)
        : []
      const prop = String(q.property_id || '').trim()
      const code = String(q.property_code || '').trim()
      const from = String(q.from || '').trim()
      const to = String(q.to || '').trim()
      const limit = Math.min(500, Math.max(1, Number(q.limit || 100)))

      const where: string[] = []
      const values: any[] = []
      if (prop) { values.push(prop); where.push(`n.property_id = $${values.length}`) }
      if (code) { values.push(code); where.push(`COALESCE(n.property_code, p.code) = $${values.length}`) }
      if (statuses.length) { values.push(statuses); where.push(`COALESCE(n.status,'') = ANY($${values.length}::text[])`) }
      if (from) { values.push(from); where.push(`COALESCE(n.submitted_at, n.created_at) >= $${values.length}::timestamptz`) }
      if (to) { values.push(to); where.push(`COALESCE(n.submitted_at, n.created_at) <= $${values.length}::timestamptz`) }
      values.push(limit)

      const sql = `
        SELECT
          n.id,
          n.property_id,
          COALESCE(n.property_code, p.code) AS property_code,
          p.address AS property_address,
          n.status,
          n.item_name,
          n.quantity,
          n.note,
          n.photo_urls,
          n.submitter_name,
          n.submitted_at,
          n.created_at
        FROM property_daily_necessities n
        LEFT JOIN properties p ON p.id = n.property_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY COALESCE(n.submitted_at, n.created_at) DESC
        LIMIT $${values.length}
      `
      const r = await pgPool.query(sql, values)
      return res.json(r.rows || [])
    }
    return res.json([])
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.get('/suppliers', requirePerm('inventory.po.manage'), async (req, res) => {
  try {
    if (hasPg && pgPool) {
      await ensureInventorySchema()
      const rows = await pgPool.query(`SELECT id, name, kind, active FROM suppliers ORDER BY name ASC`)
      return res.json(rows.rows || [])
    }
    return res.json([])
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

const supplierSchema = z.object({ name: z.string().min(1), kind: z.string().optional(), active: z.boolean().optional() })

router.post('/suppliers', requirePerm('inventory.po.manage'), async (req, res) => {
  const parsed = supplierSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (hasPg && pgPool) {
      await ensureInventorySchema()
      const id = uuidv4()
      const row = await pgPool.query(
        `INSERT INTO suppliers (id, name, kind, active) VALUES ($1,$2,$3,$4) RETURNING *`,
        [id, parsed.data.name, parsed.data.kind || 'linen', parsed.data.active ?? true],
      )
      addAudit('Supplier', id, 'create', null, row.rows?.[0] || null, actorId(req))
      return res.status(201).json(row.rows?.[0] || null)
    }
    return res.status(501).json({ message: 'not available without PG' })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.patch('/suppliers/:id', requirePerm('inventory.po.manage'), async (req, res) => {
  const parsed = supplierSchema.partial().safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const id = String(req.params.id || '')
  try {
    if (hasPg && pgPool) {
      await ensureInventorySchema()
      const before = await pgPool.query(`SELECT * FROM suppliers WHERE id = $1`, [id])
      const b = before.rows?.[0]
      if (!b) return res.status(404).json({ message: 'supplier not found' })
      const payload = parsed.data as any
      const keys = Object.keys(payload).filter(k => payload[k] !== undefined)
      if (!keys.length) return res.json(b)
      const sets = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ')
      const values = keys.map(k => (payload as any)[k])
      const sql = `UPDATE suppliers SET ${sets} WHERE id = $${keys.length + 1} RETURNING *`
      const after = await pgPool.query(sql, [...values, id])
      addAudit('Supplier', id, 'update', b, after.rows?.[0] || null, actorId(req))
      return res.json(after.rows?.[0] || null)
    }
    return res.status(501).json({ message: 'not available without PG' })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.get('/region-supplier-rules', requirePerm('inventory.po.manage'), async (req, res) => {
  try {
    if (hasPg && pgPool) {
      await ensureInventorySchema()
      const rows = await pgPool.query(
        `SELECT r.*, s.name AS supplier_name
         FROM region_supplier_rules r
         JOIN suppliers s ON s.id = r.supplier_id
         ORDER BY r.region_key ASC, r.priority DESC`,
      )
      return res.json(rows.rows || [])
    }
    return res.json([])
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

const regionRuleSchema = z.object({
  region_key: z.string().min(1),
  supplier_id: z.string().min(1),
  priority: z.number().int().optional(),
  active: z.boolean().optional(),
})

router.post('/region-supplier-rules', requirePerm('inventory.po.manage'), async (req, res) => {
  const parsed = regionRuleSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (hasPg && pgPool) {
      await ensureInventorySchema()
      const id = uuidv4()
      const row = await pgPool.query(
        `INSERT INTO region_supplier_rules (id, region_key, supplier_id, priority, active)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING *`,
        [id, parsed.data.region_key, parsed.data.supplier_id, parsed.data.priority ?? 0, parsed.data.active ?? true],
      )
      addAudit('RegionSupplierRule', id, 'create', null, row.rows?.[0] || null, actorId(req))
      return res.status(201).json(row.rows?.[0] || null)
    }
    return res.status(501).json({ message: 'not available without PG' })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.patch('/region-supplier-rules/:id', requirePerm('inventory.po.manage'), async (req, res) => {
  const parsed = regionRuleSchema.partial().safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const id = String(req.params.id || '')
  try {
    if (hasPg && pgPool) {
      await ensureInventorySchema()
      const before = await pgPool.query(`SELECT * FROM region_supplier_rules WHERE id = $1`, [id])
      const b = before.rows?.[0]
      if (!b) return res.status(404).json({ message: 'rule not found' })
      const payload = parsed.data as any
      const keys = Object.keys(payload).filter(k => payload[k] !== undefined)
      if (!keys.length) return res.json(b)
      const sets = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ')
      const values = keys.map(k => (payload as any)[k])
      const sql = `UPDATE region_supplier_rules SET ${sets} WHERE id = $${keys.length + 1} RETURNING *`
      const after = await pgPool.query(sql, [...values, id])
      addAudit('RegionSupplierRule', id, 'update', b, after.rows?.[0] || null, actorId(req))
      return res.json(after.rows?.[0] || null)
    }
    return res.status(501).json({ message: 'not available without PG' })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

const poCreateSchema = z.object({
  supplier_id: z.string().optional(),
  warehouse_id: z.string().min(1),
  property_id: z.string().optional(),
  region: z.string().optional(),
  requested_delivery_date: z.string().optional(),
  note: z.string().optional(),
  lines: z.array(z.object({
    item_id: z.string().min(1),
    quantity: z.number().int().min(1),
    unit: z.string().optional(),
    unit_price: z.number().optional(),
    note: z.string().optional(),
  })).min(1),
})

router.get('/purchase-orders', requirePerm('inventory.po.manage'), async (req, res) => {
  try {
    if (hasPg && pgPool) {
      await ensureInventorySchema()
      const q: any = req.query || {}
      const status = String(q.status || '').trim()
      const supplier_id = String(q.supplier_id || '').trim()
      const warehouse_id = String(q.warehouse_id || '').trim()
      const where: string[] = []
      const values: any[] = []
      if (status) { values.push(status); where.push(`po.status = $${values.length}`) }
      if (supplier_id) { values.push(supplier_id); where.push(`po.supplier_id = $${values.length}`) }
      if (warehouse_id) { values.push(warehouse_id); where.push(`po.warehouse_id = $${values.length}`) }
      const sql = `
        SELECT
          po.*,
          s.name AS supplier_name,
          w.name AS warehouse_name,
          w.code AS warehouse_code
        FROM purchase_orders po
        JOIN suppliers s ON s.id = po.supplier_id
        JOIN warehouses w ON w.id = po.warehouse_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY po.created_at DESC
        LIMIT 200
      `
      const rows = await pgPool.query(sql, values)
      return res.json(rows.rows || [])
    }
    return res.json([])
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.post('/purchase-orders', requirePerm('inventory.po.manage'), async (req, res) => {
  const parsed = poCreateSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (!(hasPg && pgPool)) return res.status(501).json({ message: 'not available without PG' })
    await ensureInventorySchema()

    const supplierIdExplicit = String(parsed.data.supplier_id || '').trim()
    const pool = pgPool
    if (!pool) throw new Error('db not ready')
    const supplierFromRegion = async () => {
      const region = String(parsed.data.region || '').trim()
      if (region) return pickSupplierIdForRegion(region)
      const pid = String(parsed.data.property_id || '').trim()
      if (!pid) return null
      const pr = await pool.query(`SELECT region FROM properties WHERE id = $1`, [pid])
      const r = pr.rows?.[0]?.region || null
      return pickSupplierIdForRegion(r)
    }
    const supplier_id = supplierIdExplicit || (await supplierFromRegion())
    if (!supplier_id) return res.status(400).json({ message: '无法确定供应商，请手动选择 supplier_id' })

    const poId = uuidv4()
    const created_by = actorId(req)

    const result = await pgRunInTransaction(async (client) => {
      const poRow = await client.query(
        `INSERT INTO purchase_orders (id, supplier_id, warehouse_id, status, requested_delivery_date, note, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING *`,
        [
          poId,
          supplier_id,
          parsed.data.warehouse_id,
          'draft',
          parsed.data.requested_delivery_date ? parsed.data.requested_delivery_date : null,
          parsed.data.note || null,
          created_by,
        ],
      )

      const linesOut: any[] = []
      for (const ln of parsed.data.lines) {
        const item = await client.query(`SELECT id, unit FROM inventory_items WHERE id = $1`, [ln.item_id])
        const unit = ln.unit || item.rows?.[0]?.unit
        if (!unit) throw new Error('unit missing')
        const lineId = uuidv4()
        const row = await client.query(
          `INSERT INTO purchase_order_lines (id, po_id, item_id, quantity, unit, unit_price, note)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           RETURNING *`,
          [lineId, poId, ln.item_id, ln.quantity, unit, ln.unit_price ?? null, ln.note || null],
        )
        linesOut.push(row.rows?.[0] || null)
      }
      return { po: poRow.rows?.[0] || null, lines: linesOut }
    })

    addAudit('PurchaseOrder', poId, 'create', null, result, actorId(req))
    return res.status(201).json(result)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.get('/purchase-orders/:id', requirePerm('inventory.po.manage'), async (req, res) => {
  const id = String(req.params.id || '')
  try {
    if (!(hasPg && pgPool)) return res.status(501).json({ message: 'not available without PG' })
    await ensureInventorySchema()
    const po = await pgPool.query(
      `SELECT po.*, s.name AS supplier_name, w.name AS warehouse_name, w.code AS warehouse_code
       FROM purchase_orders po
       JOIN suppliers s ON s.id = po.supplier_id
       JOIN warehouses w ON w.id = po.warehouse_id
       WHERE po.id = $1`,
      [id],
    )
    if (!po.rows?.[0]) return res.status(404).json({ message: 'po not found' })
    const lines = await pgPool.query(
      `SELECT l.*, i.name AS item_name, i.sku AS item_sku
       FROM purchase_order_lines l
       JOIN inventory_items i ON i.id = l.item_id
       WHERE l.po_id = $1
       ORDER BY i.name ASC`,
      [id],
    )
    const deliveries = await pgPool.query(
      `SELECT d.* FROM purchase_deliveries d WHERE d.po_id = $1 ORDER BY d.received_at DESC`,
      [id],
    )
    return res.json({ po: po.rows[0], lines: lines.rows || [], deliveries: deliveries.rows || [] })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

const poPatchSchema = z.object({
  status: z.enum(['draft','ordered','received','closed']).optional(),
  requested_delivery_date: z.string().optional(),
  note: z.string().optional(),
})

router.patch('/purchase-orders/:id', requirePerm('inventory.po.manage'), async (req, res) => {
  const parsed = poPatchSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const id = String(req.params.id || '')
  try {
    if (!(hasPg && pgPool)) return res.status(501).json({ message: 'not available without PG' })
    await ensureInventorySchema()
    const before = await pgPool.query(`SELECT * FROM purchase_orders WHERE id = $1`, [id])
    const b = before.rows?.[0]
    if (!b) return res.status(404).json({ message: 'po not found' })
    const payload = parsed.data as any
    const keys = Object.keys(payload).filter(k => payload[k] !== undefined)
    if (!keys.length) return res.json(b)
    const sets = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ')
    const values = keys.map(k => (payload as any)[k])
    const sql = `UPDATE purchase_orders SET ${sets}, updated_at = now() WHERE id = $${keys.length + 1} RETURNING *`
    const after = await pgPool.query(sql, [...values, id])
    addAudit('PurchaseOrder', id, 'update', b, after.rows?.[0] || null, actorId(req))
    return res.json(after.rows?.[0] || null)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.post('/purchase-orders/:id/export', requirePerm('inventory.po.manage'), async (req, res) => {
  const id = String(req.params.id || '')
  try {
    if (!(hasPg && pgPool)) return res.status(501).json({ message: 'not available without PG' })
    await ensureInventorySchema()
    const po = await pgPool.query(
      `SELECT po.id, po.status, po.created_at, s.name AS supplier_name, w.name AS warehouse_name
       FROM purchase_orders po
       JOIN suppliers s ON s.id = po.supplier_id
       JOIN warehouses w ON w.id = po.warehouse_id
       WHERE po.id = $1`,
      [id],
    )
    if (!po.rows?.[0]) return res.status(404).json({ message: 'po not found' })
    const lines = await pgPool.query(
      `SELECT i.name AS item_name, i.sku AS item_sku, l.quantity, l.unit, l.unit_price, l.note
       FROM purchase_order_lines l
       JOIN inventory_items i ON i.id = l.item_id
       WHERE l.po_id = $1
       ORDER BY i.name ASC`,
      [id],
    )
    const header = ['物料','SKU','数量','单位','单价','备注']
    const esc = (v: any) => {
      const s = String(v ?? '')
      if (/[\",\n]/.test(s)) return `"${s.replace(/\"/g, '""')}"`
      return s
    }
    const rows = [header.join(',')]
    for (const r of (lines.rows || [])) {
      rows.push([r.item_name, r.item_sku, r.quantity, r.unit, r.unit_price ?? '', r.note ?? ''].map(esc).join(','))
    }
    const csv = rows.join('\n')
    const filename = `PO_${esc(po.rows[0].supplier_name)}_${id}.csv`.replace(/[^\w\-.()]+/g, '_')
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    return res.send('\ufeff' + csv)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

const deliverySchema = z.object({
  received_at: z.string().optional(),
  note: z.string().optional(),
  lines: z.array(z.object({ item_id: z.string().min(1), quantity_received: z.number().int().min(1), note: z.string().optional() })).min(1),
})

router.post('/purchase-orders/:id/deliveries', requirePerm('inventory.po.manage'), async (req, res) => {
  const parsed = deliverySchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const po_id = String(req.params.id || '')
  try {
    if (!(hasPg && pgPool)) return res.status(501).json({ message: 'not available without PG' })
    await ensureInventorySchema()
    const result = await pgRunInTransaction(async (client) => {
      const po = await client.query(`SELECT * FROM purchase_orders WHERE id = $1`, [po_id])
      const p = po.rows?.[0]
      if (!p) return { ok: false as const, code: 404 as const, message: 'po not found' }

      const deliveryId = uuidv4()
      const d = await client.query(
        `INSERT INTO purchase_deliveries (id, po_id, received_at, received_by, note)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING *`,
        [deliveryId, po_id, parsed.data.received_at ? parsed.data.received_at : null, actorId(req), parsed.data.note || null],
      )

      const lineRows: any[] = []
      for (const ln of parsed.data.lines) {
        const dlId = uuidv4()
        const row = await client.query(
          `INSERT INTO purchase_delivery_lines (id, delivery_id, item_id, quantity_received, note)
           VALUES ($1,$2,$3,$4,$5)
           RETURNING *`,
          [dlId, deliveryId, ln.item_id, ln.quantity_received, ln.note || null],
        )
        lineRows.push(row.rows?.[0] || null)

        const applied = await applyStockDeltaInTx(client, {
          warehouse_id: p.warehouse_id,
          item_id: ln.item_id,
          type: 'in',
          quantity: ln.quantity_received,
          reason: 'purchase_delivery',
          ref_type: 'po',
          ref_id: po_id,
          actor_id: actorId(req),
          note: parsed.data.note || null,
        })
        if (!applied.ok) return applied
      }

      const poAfter = await client.query(`UPDATE purchase_orders SET status = $1, updated_at = now() WHERE id = $2 RETURNING *`, ['received', po_id])
      return { ok: true as const, delivery: d.rows?.[0] || null, lines: lineRows, po: poAfter.rows?.[0] || null }
    })

    if (!(result as any)?.ok) return res.status((result as any).code).json({ message: (result as any).message })
    addAudit('PurchaseDelivery', (result as any)?.delivery?.id || po_id, 'create', null, result, actorId(req))
    return res.status(201).json(result)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})
