import { Router } from 'express'
import { db, addAudit } from '../store'
import { z } from 'zod'
import { requirePerm } from '../auth'
import { hasPg, pgPool, pgRunInTransaction } from '../dbAdapter'
import { v4 as uuidv4 } from 'uuid'
import multer from 'multer'
import path from 'path'
import { resizeUploadImage } from '../lib/uploadImageResize'
import { hasR2, r2Upload } from '../r2'

export const router = Router()

const upload = multer({ storage: multer.memoryStorage() })

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
    await pgPool.query('ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS sub_type text;')
    await pgPool.query('ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS linen_type_code text;')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_inventory_items_category_sub_type ON inventory_items(category, sub_type);')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_inventory_items_linen_type ON inventory_items(linen_type_code);')

    await pgPool.query(`CREATE TABLE IF NOT EXISTS inventory_linen_types (
      code text PRIMARY KEY,
      name text NOT NULL,
      in_set boolean NOT NULL DEFAULT true,
      set_divisor integer NOT NULL DEFAULT 1,
      sort_order integer NOT NULL DEFAULT 0,
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz
    );`)
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_inventory_linen_types_active_sort ON inventory_linen_types(active, sort_order, code);')
    await pgPool.query(`INSERT INTO inventory_linen_types (code, name, in_set, set_divisor, sort_order, active) VALUES
      ('bedsheet','床单',true,1,10,true),
      ('duvet_cover','被套',true,1,20,true),
      ('pillowcase','枕套',true,2,30,true),
      ('bath_towel','浴巾',true,1,40,true)
    ON CONFLICT (code) DO NOTHING;`)

    await pgPool.query(`INSERT INTO inventory_items (id, name, sku, category, linen_type_code, unit, default_threshold, bin_location, active, is_key_item)
      VALUES
        ('item.linen_type.bedsheet','床单','LT:bedsheet','linen','bedsheet','pcs',0,NULL,true,false),
        ('item.linen_type.duvet_cover','被套','LT:duvet_cover','linen','duvet_cover','pcs',0,NULL,true,false),
        ('item.linen_type.pillowcase','枕套','LT:pillowcase','linen','pillowcase','pcs',0,NULL,true,false),
        ('item.linen_type.bath_towel','浴巾','LT:bath_towel','linen','bath_towel','pcs',0,NULL,true,false)
      ON CONFLICT (id) DO NOTHING;`)

    await pgPool.query(`CREATE TABLE IF NOT EXISTS inventory_room_types (
      code text PRIMARY KEY,
      name text NOT NULL,
      bedrooms integer,
      bathrooms integer,
      sort_order integer NOT NULL DEFAULT 0,
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz
    );`)
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_inventory_room_types_active_sort ON inventory_room_types(active, sort_order, code);')
    await pgPool.query(`INSERT INTO inventory_room_types (code, name, bedrooms, bathrooms, sort_order, active) VALUES
      ('1b1b','一房一卫',1,1,10,true),
      ('2b1b','两房一卫',2,1,20,true),
      ('2b2b','两房两卫',2,2,30,true),
      ('3b2b','三房两卫',3,2,40,true),
      ('3b3b','三房三卫',3,3,50,true)
    ON CONFLICT (code) DO NOTHING;`)

    await pgPool.query(`CREATE TABLE IF NOT EXISTS inventory_room_type_requirements (
      room_type_code text NOT NULL REFERENCES inventory_room_types(code) ON DELETE CASCADE,
      linen_type_code text NOT NULL REFERENCES inventory_linen_types(code) ON DELETE RESTRICT,
      quantity integer NOT NULL,
      PRIMARY KEY (room_type_code, linen_type_code)
    );`)
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_inventory_room_type_req_room ON inventory_room_type_requirements(room_type_code);')

    await pgPool.query('ALTER TABLE properties ADD COLUMN IF NOT EXISTS room_type_code text;')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_properties_room_type_code ON properties(room_type_code);')

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
      ordered_date date,
      requested_delivery_date date,
      region text,
      property_id text,
      note text,
      created_by text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz
    );`)
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_purchase_orders_supplier ON purchase_orders(supplier_id);')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_purchase_orders_warehouse ON purchase_orders(warehouse_id);')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_purchase_orders_status ON purchase_orders(status);')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_purchase_orders_created_at ON purchase_orders(created_at);')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_purchase_orders_region ON purchase_orders(region);')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_purchase_orders_property ON purchase_orders(property_id);')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_purchase_orders_ordered_date ON purchase_orders(ordered_date);')

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
      photo_url text,
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

    await pgPool.query(`CREATE TABLE IF NOT EXISTS stock_change_requests (
      id text PRIMARY KEY,
      warehouse_id text NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
      item_id text NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
      type text NOT NULL DEFAULT 'out',
      quantity integer NOT NULL,
      reason text NOT NULL,
      note text,
      photo_url text,
      status text NOT NULL DEFAULT 'pending',
      created_by text,
      created_at timestamptz NOT NULL DEFAULT now(),
      handled_by text,
      handled_at timestamptz,
      movement_id text
    );`)
    await pgPool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_change_requests_type_check') THEN
        ALTER TABLE stock_change_requests
          ADD CONSTRAINT stock_change_requests_type_check
          CHECK (type IN ('out'));
      END IF;
    END $$;`)
    await pgPool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_change_requests_status_check') THEN
        ALTER TABLE stock_change_requests
          ADD CONSTRAINT stock_change_requests_status_check
          CHECK (status IN ('pending','approved','rejected'));
      END IF;
    END $$;`)
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_stock_change_requests_status ON stock_change_requests(status);')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_stock_change_requests_reason ON stock_change_requests(reason);')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_stock_change_requests_wh ON stock_change_requests(warehouse_id);')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_stock_change_requests_item ON stock_change_requests(item_id);')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_stock_change_requests_created_at ON stock_change_requests(created_at);')

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
  photo_url?: string | null
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
    `INSERT INTO stock_movements (id, warehouse_id, item_id, type, reason, quantity, property_id, ref_type, ref_id, actor_id, note, photo_url)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
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
      input.photo_url || null,
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

const linenTypeSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  in_set: z.boolean().optional(),
  set_divisor: z.number().int().min(1).optional(),
  sort_order: z.number().int().optional(),
  active: z.boolean().optional(),
})

router.get('/linen-types', requirePerm('inventory.view'), async (req, res) => {
  try {
    if (hasPg && pgPool) {
      await ensureInventorySchema()
      const rows = await pgPool.query(`SELECT code, name, in_set, set_divisor, sort_order, active FROM inventory_linen_types ORDER BY active DESC, name ASC, code ASC`)
      return res.json(rows.rows || [])
    }
    return res.json([])
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.post('/linen-types', requirePerm('inventory.item.manage'), async (req, res) => {
  const parsed = linenTypeSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (!(hasPg && pgPool)) return res.status(501).json({ message: 'not available without PG' })
    await ensureInventorySchema()
    const v = parsed.data
    const row = await pgPool.query(
      `INSERT INTO inventory_linen_types (code, name, in_set, set_divisor, sort_order, active)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING code, name, in_set, set_divisor, sort_order, active`,
      [v.code, v.name, v.in_set ?? true, v.set_divisor ?? 1, v.sort_order ?? 0, v.active ?? true],
    )
    const itemId = `item.linen_type.${v.code}`
    await pgPool.query(
      `INSERT INTO inventory_items (id, name, sku, category, linen_type_code, unit, default_threshold, bin_location, active, is_key_item)
       VALUES ($1,$2,$3,'linen',$4,'pcs',0,NULL,$5,false)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, active = EXCLUDED.active, linen_type_code = EXCLUDED.linen_type_code`,
      [itemId, v.name, `LT:${v.code}`, v.code, v.active ?? true],
    )
    addAudit('InventoryLinenType', v.code, 'create', null, row.rows?.[0] || null, actorId(req))
    return res.status(201).json(row.rows?.[0] || null)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.patch('/linen-types/:code', requirePerm('inventory.item.manage'), async (req, res) => {
  const code = String(req.params.code || '').trim()
  const parsed = linenTypeSchema.partial().safeParse({ ...req.body, code })
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (!(hasPg && pgPool)) return res.status(501).json({ message: 'not available without PG' })
    await ensureInventorySchema()
    const before = await pgPool.query(`SELECT * FROM inventory_linen_types WHERE code = $1`, [code])
    const b = before.rows?.[0]
    if (!b) return res.status(404).json({ message: 'not found' })
    const payload = parsed.data as any
    const keys = Object.keys(payload).filter(k => payload[k] !== undefined && k !== 'code')
    if (!keys.length) return res.json(b)
    const sets = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ')
    const values = keys.map(k => (payload as any)[k])
    const sql = `UPDATE inventory_linen_types SET ${sets}, updated_at = now() WHERE code = $${keys.length + 1} RETURNING code, name, in_set, set_divisor, sort_order, active`
    const after = await pgPool.query(sql, [...values, code])
    const a = after.rows?.[0]
    if (a) {
      const itemId = `item.linen_type.${code}`
      await pgPool.query(
        `INSERT INTO inventory_items (id, name, sku, category, linen_type_code, unit, default_threshold, bin_location, active, is_key_item)
         VALUES ($1,$2,$3,'linen',$4,'pcs',0,NULL,$5,false)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, active = EXCLUDED.active, linen_type_code = EXCLUDED.linen_type_code`,
        [itemId, a.name, `LT:${code}`, code, a.active],
      )
    }
    addAudit('InventoryLinenType', code, 'update', b, after.rows?.[0] || null, actorId(req))
    return res.json(after.rows?.[0] || null)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.delete('/linen-types/:code', requirePerm('inventory.item.manage'), async (req, res) => {
  const code = String(req.params.code || '').trim()
  try {
    if (!(hasPg && pgPool)) return res.status(501).json({ message: 'not available without PG' })
    await ensureInventorySchema()
    const itemId = `item.linen_type.${code}`
    const used1 = await pgPool.query(`SELECT 1 FROM warehouse_stocks WHERE item_id = $1 LIMIT 1`, [itemId])
    if ((used1.rows || []).length) return res.status(409).json({ message: '该类型已有库存记录，无法删除' })
    const used2 = await pgPool.query(`SELECT 1 FROM stock_movements WHERE item_id = $1 LIMIT 1`, [itemId])
    if ((used2.rows || []).length) return res.status(409).json({ message: '该类型已有流水记录，无法删除' })
    const used3 = await pgPool.query(`SELECT 1 FROM purchase_order_lines WHERE item_id = $1 LIMIT 1`, [itemId])
    if ((used3.rows || []).length) return res.status(409).json({ message: '该类型已有采购记录，无法删除' })

    const before = await pgPool.query(`SELECT * FROM inventory_linen_types WHERE code = $1`, [code])
    const b = before.rows?.[0] || null
    await pgRunInTransaction(async (client) => {
      await client.query(`DELETE FROM inventory_linen_types WHERE code = $1`, [code])
      await client.query(`DELETE FROM inventory_items WHERE id = $1`, [itemId])
      return { ok: true as const }
    })
    addAudit('InventoryLinenType', code, 'delete', b, null, actorId(req))
    return res.json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

const roomTypeSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  bedrooms: z.number().int().min(0).optional(),
  bathrooms: z.number().int().min(0).optional(),
  sort_order: z.number().int().optional(),
  active: z.boolean().optional(),
})

router.get('/room-types', requirePerm('inventory.view'), async (req, res) => {
  try {
    if (hasPg && pgPool) {
      await ensureInventorySchema()
      const rows = await pgPool.query(`SELECT code, name, bedrooms, bathrooms, sort_order, active FROM inventory_room_types ORDER BY active DESC, sort_order ASC, code ASC`)
      return res.json(rows.rows || [])
    }
    return res.json([])
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.post('/room-types', requirePerm('inventory.item.manage'), async (req, res) => {
  const parsed = roomTypeSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (!(hasPg && pgPool)) return res.status(501).json({ message: 'not available without PG' })
    await ensureInventorySchema()
    const v = parsed.data
    const row = await pgPool.query(
      `INSERT INTO inventory_room_types (code, name, bedrooms, bathrooms, sort_order, active)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING code, name, bedrooms, bathrooms, sort_order, active`,
      [v.code, v.name, v.bedrooms ?? null, v.bathrooms ?? null, v.sort_order ?? 0, v.active ?? true],
    )
    addAudit('InventoryRoomType', v.code, 'create', null, row.rows?.[0] || null, actorId(req))
    return res.status(201).json(row.rows?.[0] || null)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.patch('/room-types/:code', requirePerm('inventory.item.manage'), async (req, res) => {
  const code = String(req.params.code || '').trim()
  const parsed = roomTypeSchema.partial().safeParse({ ...req.body, code })
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (!(hasPg && pgPool)) return res.status(501).json({ message: 'not available without PG' })
    await ensureInventorySchema()
    const before = await pgPool.query(`SELECT * FROM inventory_room_types WHERE code = $1`, [code])
    const b = before.rows?.[0]
    if (!b) return res.status(404).json({ message: 'not found' })
    const payload = parsed.data as any
    const keys = Object.keys(payload).filter(k => payload[k] !== undefined && k !== 'code')
    if (!keys.length) return res.json(b)
    const sets = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ')
    const values = keys.map(k => (payload as any)[k])
    const sql = `UPDATE inventory_room_types SET ${sets}, updated_at = now() WHERE code = $${keys.length + 1} RETURNING code, name, bedrooms, bathrooms, sort_order, active`
    const after = await pgPool.query(sql, [...values, code])
    addAudit('InventoryRoomType', code, 'update', b, after.rows?.[0] || null, actorId(req))
    return res.json(after.rows?.[0] || null)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.delete('/room-types/:code', requirePerm('inventory.item.manage'), async (req, res) => {
  const code = String(req.params.code || '').trim()
  try {
    if (!(hasPg && pgPool)) return res.status(501).json({ message: 'not available without PG' })
    await ensureInventorySchema()
    const used1 = await pgPool.query(`SELECT 1 FROM inventory_room_type_requirements WHERE room_type_code = $1 LIMIT 1`, [code])
    if ((used1.rows || []).length) return res.status(409).json({ message: '该房型已有占用配置，无法删除' })
    const used2 = await pgPool.query(`SELECT 1 FROM properties WHERE room_type_code = $1 LIMIT 1`, [code])
    if ((used2.rows || []).length) return res.status(409).json({ message: '该房型已被房源使用，无法删除' })
    const before = await pgPool.query(`SELECT * FROM inventory_room_types WHERE code = $1`, [code])
    const b = before.rows?.[0] || null
    await pgPool.query(`DELETE FROM inventory_room_types WHERE code = $1`, [code])
    addAudit('InventoryRoomType', code, 'delete', b, null, actorId(req))
    return res.json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.get('/room-types/:code/requirements', requirePerm('inventory.view'), async (req, res) => {
  const code = String(req.params.code || '').trim()
  try {
    if (hasPg && pgPool) {
      await ensureInventorySchema()
      const [rt, reqs, types] = await Promise.all([
        pgPool.query(`SELECT code, name, bedrooms, bathrooms, sort_order, active FROM inventory_room_types WHERE code = $1`, [code]),
        pgPool.query(`SELECT linen_type_code, quantity FROM inventory_room_type_requirements WHERE room_type_code = $1`, [code]),
        pgPool.query(`SELECT code, name, sort_order, active FROM inventory_linen_types WHERE active = true ORDER BY sort_order ASC, code ASC`),
      ])
      const roomType = rt.rows?.[0] || null
      if (!roomType) return res.status(404).json({ message: 'not found' })
      const map = new Map<string, number>((reqs.rows || []).map((r: any) => [String(r.linen_type_code), Number(r.quantity || 0)]))
      const out = (types.rows || []).map((t: any) => ({
        linen_type_code: String(t.code),
        linen_type_name: String(t.name),
        quantity: Number(map.get(String(t.code)) || 0),
      }))
      return res.json({ room_type: roomType, requirements: out })
    }
    return res.json({ room_type: null, requirements: [] })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

const roomTypeRequirementsSchema = z.object({
  requirements: z.array(z.object({
    linen_type_code: z.string().min(1),
    quantity: z.number().int().min(0),
  })),
})

router.put('/room-types/:code/requirements', requirePerm('inventory.item.manage'), async (req, res) => {
  const code = String(req.params.code || '').trim()
  const parsed = roomTypeRequirementsSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (!(hasPg && pgPool)) return res.status(501).json({ message: 'not available without PG' })
    await ensureInventorySchema()
    const rt = await pgPool.query(`SELECT * FROM inventory_room_types WHERE code = $1`, [code])
    const roomType = rt.rows?.[0]
    if (!roomType) return res.status(404).json({ message: 'not found' })

    const next = (parsed.data.requirements || []).map((r) => ({ linen_type_code: String(r.linen_type_code), quantity: Number(r.quantity || 0) }))
    const nextMap = new Map<string, number>(next.map((r) => [r.linen_type_code, r.quantity]))
    const old = await pgPool.query(`SELECT linen_type_code, quantity FROM inventory_room_type_requirements WHERE room_type_code = $1`, [code])
    const oldRows = old.rows || []
    const oldMap = new Map<string, number>(oldRows.map((r: any) => [String(r.linen_type_code), Number(r.quantity || 0)]))

    await pgRunInTransaction(async (client) => {
      for (const [k] of oldMap.entries()) {
        if (!nextMap.has(k)) await client.query(`DELETE FROM inventory_room_type_requirements WHERE room_type_code = $1 AND linen_type_code = $2`, [code, k])
      }
      for (const [k, qty] of nextMap.entries()) {
        if (qty <= 0) {
          await client.query(`DELETE FROM inventory_room_type_requirements WHERE room_type_code = $1 AND linen_type_code = $2`, [code, k])
        } else {
          await client.query(
            `INSERT INTO inventory_room_type_requirements (room_type_code, linen_type_code, quantity)
             VALUES ($1,$2,$3)
             ON CONFLICT (room_type_code, linen_type_code)
             DO UPDATE SET quantity = EXCLUDED.quantity`,
            [code, k, qty],
          )
        }
      }
      return { ok: true as const }
    })
    addAudit('InventoryRoomType', code, 'update_requirements', { requirements: oldRows }, { requirements: next }, actorId(req))
    return res.json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.get('/items', requirePerm('inventory.view'), async (req, res) => {
  try {
    const q = String((req.query as any)?.q || '').trim()
    const category = String((req.query as any)?.category || '').trim()
    const active = String((req.query as any)?.active || '').trim().toLowerCase()
    const linenTypeCode = String((req.query as any)?.linen_type_code || '').trim()
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
      if (linenTypeCode) {
        values.push(linenTypeCode)
        where.push(`linen_type_code = $${values.length}`)
      }
      const sql = `SELECT id, name, sku, category, sub_type, linen_type_code, unit, default_threshold, bin_location, active, is_key_item
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
  sub_type: z.string().optional(),
  linen_type_code: z.string().optional(),
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
        sub_type: parsed.data.sub_type || null,
        linen_type_code: parsed.data.linen_type_code || null,
        unit: parsed.data.unit,
        default_threshold: parsed.data.default_threshold ?? 0,
        bin_location: parsed.data.bin_location || null,
        active: parsed.data.active ?? true,
        is_key_item: parsed.data.is_key_item ?? false,
      }
      const row = await pgPool.query(
        `INSERT INTO inventory_items (id, name, sku, category, sub_type, linen_type_code, unit, default_threshold, bin_location, active, is_key_item)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING *`,
        [item.id, item.name, item.sku, item.category, item.sub_type, item.linen_type_code, item.unit, item.default_threshold, item.bin_location, item.active, item.is_key_item],
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
  const category = String((req.query as any)?.category || '').trim()
  try {
    if (hasPg && pgPool) {
      await ensureInventorySchema()
      if (category) {
        const itemVals: any[] = [category]
        let itemSql = `SELECT id, name, sku, category, sub_type, linen_type_code, unit, default_threshold, bin_location, active, is_key_item FROM inventory_items WHERE category = $1`
        if (keyOnly) itemSql += ` AND is_key_item = true`
        const items = await pgPool.query(itemSql, itemVals)
        const itemRows = items.rows || []
        if (!itemRows.length) return res.json([])
        const itemMap = new Map<string, any>(itemRows.map((r: any) => [String(r.id), r]))
        const ids = itemRows.map((r: any) => String(r.id))
        const stocks = await pgPool.query(
          `SELECT id, warehouse_id, item_id, quantity, threshold
           FROM warehouse_stocks
           WHERE warehouse_id = $1 AND item_id = ANY($2::text[])
           ORDER BY item_id ASC`,
          [warehouse_id, ids],
        )
        let out = (stocks.rows || []).map((s: any) => {
          const it = itemMap.get(String(s.item_id)) || {}
          const eff = s.threshold === null || s.threshold === undefined ? Number(it.default_threshold || 0) : Number(s.threshold || 0)
          return {
            ...s,
            name: it.name,
            sku: it.sku,
            category: it.category,
            sub_type: it.sub_type,
            unit: it.unit,
            default_threshold: it.default_threshold,
            bin_location: it.bin_location,
            active: it.active,
            is_key_item: it.is_key_item,
            threshold_effective: eff,
          }
        }).sort((a: any, b: any) => String(a.name || '').localeCompare(String(b.name || '')))
        if (warningsOnly) out = out.filter((x: any) => Number(x.quantity || 0) < Number(x.threshold_effective || 0))
        return res.json(out)
      }
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
          i.sub_type,
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
  photo_url: z.string().optional(),
})

router.get('/transfers', requirePerm('inventory.view'), async (req, res) => {
  try {
    if (hasPg && pgPool) {
      await ensureInventorySchema()
      const q: any = req.query || {}
      const fromWh = String(q.from_warehouse_id || '').trim()
      const toWh = String(q.to_warehouse_id || '').trim()
      const itemId = String(q.item_id || '').trim()
      const category = String(q.category || '').trim()
      const from = String(q.from || '').trim()
      const to = String(q.to || '').trim()
      const limit = Math.min(500, Math.max(1, Number(q.limit || 200)))

      let itemIdsByCategory: string[] | null = null
      if (category) {
        const its = await pgPool.query(`SELECT id FROM inventory_items WHERE category = $1`, [category])
        itemIdsByCategory = (its.rows || []).map((r: any) => String(r.id))
        if (!itemIdsByCategory.length) return res.json([])
      }

      const where: string[] = [`m.ref_type = 'transfer'`]
      const values: any[] = []
      if (fromWh) { values.push(fromWh); where.push(`(m.type = 'out' AND m.warehouse_id = $${values.length})`) }
      if (toWh) { values.push(toWh); where.push(`(m.type = 'in' AND m.warehouse_id = $${values.length})`) }
      if (itemId) { values.push(itemId); where.push(`m.item_id = $${values.length}`) }
      if (itemIdsByCategory) { values.push(itemIdsByCategory); where.push(`m.item_id = ANY($${values.length}::text[])`) }
      if (from) { values.push(from); where.push(`m.created_at >= $${values.length}::timestamptz`) }
      if (to) { values.push(to); where.push(`m.created_at <= $${values.length}::timestamptz`) }
      values.push(limit)

      const moves = await pgPool.query(
        `SELECT
           m.id,
           m.warehouse_id,
           m.item_id,
           m.type,
           m.quantity,
           m.ref_id,
           m.note,
           m.photo_url,
           m.created_at
         FROM stock_movements m
         WHERE ${where.join(' AND ')}
         ORDER BY m.created_at DESC
         LIMIT $${values.length}`,
        values,
      )
      const rows = moves.rows || []
      if (!rows.length) return res.json([])

      const byRef = new Map<string, any>()
      for (const r of rows) {
        const ref = String(r.ref_id || '')
        if (!ref) continue
        const key = `${ref}:${String(r.item_id)}`
        const cur = byRef.get(key) || { transfer_id: ref, item_id: String(r.item_id) }
        if (r.type === 'out') cur.from_warehouse_id = String(r.warehouse_id)
        if (r.type === 'in') cur.to_warehouse_id = String(r.warehouse_id)
        cur.quantity = Number(r.quantity || 0)
        cur.created_at = cur.created_at ? (String(cur.created_at) > String(r.created_at) ? cur.created_at : r.created_at) : r.created_at
        if (r.note && !cur.note) cur.note = r.note
        if (r.photo_url && !cur.photo_url) cur.photo_url = r.photo_url
        byRef.set(key, cur)
      }
      const list = Array.from(byRef.values())

      const warehouseIds = Array.from(new Set(list.flatMap((x: any) => [x.from_warehouse_id, x.to_warehouse_id]).filter(Boolean)))
      const itemIds = Array.from(new Set(list.map((x: any) => x.item_id).filter(Boolean)))

      const [whRows, itRows] = await Promise.all([
        warehouseIds.length ? pgPool.query(`SELECT id, code, name FROM warehouses WHERE id = ANY($1::text[])`, [warehouseIds]) : Promise.resolve({ rows: [] as any[] }),
        itemIds.length ? pgPool.query(`SELECT id, name, sku, category, sub_type FROM inventory_items WHERE id = ANY($1::text[])`, [itemIds]) : Promise.resolve({ rows: [] as any[] }),
      ])
      const whMap = new Map<string, any>((whRows as any).rows.map((r: any) => [String(r.id), r]))
      const itMap = new Map<string, any>((itRows as any).rows.map((r: any) => [String(r.id), r]))

      const out = list.map((x: any) => {
        const fw = whMap.get(String(x.from_warehouse_id)) || {}
        const tw = whMap.get(String(x.to_warehouse_id)) || {}
        const it = itMap.get(String(x.item_id)) || {}
        return {
          ...x,
          from_warehouse_code: fw.code,
          from_warehouse_name: fw.name,
          to_warehouse_code: tw.code,
          to_warehouse_name: tw.name,
          item_name: it.name,
          item_sku: it.sku,
          item_category: it.category,
          item_sub_type: it.sub_type,
        }
      }).sort((a: any, b: any) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
      return res.json(out)
    }
    return res.json([])
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

const transferRoomTypeSchema = z.object({
  from_warehouse_id: z.string().min(1),
  to_warehouse_id: z.string().min(1),
  room_type_code: z.string().min(1),
  sets: z.number().int().min(1),
  note: z.string().optional(),
  photo_url: z.string().optional(),
})

router.post('/transfers/room-type', requirePerm('inventory.move'), async (req, res) => {
  const parsed = transferRoomTypeSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  if (parsed.data.from_warehouse_id === parsed.data.to_warehouse_id) return res.status(400).json({ message: 'same warehouse' })
  try {
    if (!(hasPg && pgPool)) return res.status(501).json({ message: 'transfer not available without PG' })
    await ensureInventorySchema()
    const transferId = uuidv4()
    const result = await pgRunInTransaction(async (client) => {
      const reqs = await client.query(
        `SELECT linen_type_code, quantity
         FROM inventory_room_type_requirements
         WHERE room_type_code = $1`,
        [parsed.data.room_type_code],
      )
      const lines = (reqs.rows || [])
        .map((r: any) => ({ linen_type_code: String(r.linen_type_code), quantity: Number(r.quantity || 0) }))
        .filter((r: any) => r.linen_type_code && r.quantity > 0)
      if (!lines.length) return { ok: false as const, code: 400 as const, message: '该房型未配置占用清单' }

      for (const ln of lines) {
        const item_id = `item.linen_type.${ln.linen_type_code}`
        const qty = parsed.data.sets * ln.quantity
        const out = await applyStockDeltaInTx(client, {
          warehouse_id: parsed.data.from_warehouse_id,
          item_id,
          type: 'out',
          quantity: qty,
          reason: 'transfer',
          ref_type: 'transfer',
          ref_id: transferId,
          actor_id: actorId(req),
          note: parsed.data.note || null,
          photo_url: parsed.data.photo_url || null,
        })
        if (!out.ok) return out
        const inn = await applyStockDeltaInTx(client, {
          warehouse_id: parsed.data.to_warehouse_id,
          item_id,
          type: 'in',
          quantity: qty,
          reason: 'transfer',
          ref_type: 'transfer',
          ref_id: transferId,
          actor_id: actorId(req),
          note: parsed.data.note || null,
          photo_url: parsed.data.photo_url || null,
        })
        if (!inn.ok) return inn
      }
      return { ok: true as const, transfer_id: transferId }
    })
    if (!result) return res.status(500).json({ message: 'db not ready' })
    if (!(result as any).ok) return res.status((result as any).code).json({ message: (result as any).message })
    return res.json(result)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
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
          photo_url: parsed.data.photo_url || null,
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
          photo_url: parsed.data.photo_url || null,
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

router.post('/upload', requirePerm('inventory.move'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'missing file' })
  try {
    if (!hasR2 || !(req.file as any).buffer) return res.status(500).json({ message: 'R2 not configured' })
    const img = await resizeUploadImage({ buffer: (req.file as any).buffer, contentType: req.file.mimetype, originalName: req.file.originalname })
    const ext = img.ext || path.extname(req.file.originalname) || ''
    const key = `inventory/${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`
    const url = await r2Upload(key, img.contentType || req.file.mimetype || 'application/octet-stream', img.buffer)
    return res.status(201).json({ url })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'upload failed' })
  }
})

router.get('/category-dashboard', requirePerm('inventory.view'), async (req, res) => {
  const category = String((req.query as any)?.category || '').trim()
  if (!category) return res.status(400).json({ message: 'category required' })
  try {
    if (hasPg && pgPool) {
      await ensureInventorySchema()
      const ws = await pgPool.query(`SELECT id, code, name, active FROM warehouses ORDER BY code ASC`)
      const warehouses = (ws.rows || []).filter((w: any) => w.active)

      const linenTypes = category === 'linen'
        ? await pgPool.query(
          `SELECT code, name, in_set, set_divisor, sort_order
           FROM inventory_linen_types
           WHERE active = true
           ORDER BY sort_order ASC, code ASC`,
        )
        : { rows: [] as any[] }

      const roomTypes = category === 'linen'
        ? await pgPool.query(
          `SELECT code, name, bedrooms, bathrooms, sort_order
           FROM inventory_room_types
           WHERE active = true
           ORDER BY sort_order ASC, code ASC`,
        )
        : { rows: [] as any[] }

      const roomTypeReqs = category === 'linen'
        ? await pgPool.query(
          `SELECT room_type_code, linen_type_code, quantity
           FROM inventory_room_type_requirements`,
        )
        : { rows: [] as any[] }

      const its = await pgPool.query(
        `SELECT id, name, sku, category, sub_type, linen_type_code, unit, default_threshold, bin_location, active, is_key_item
         FROM inventory_items
         WHERE category = $1`,
        [category],
      )
      const items = its.rows || []
      const itemIds = items.map((r: any) => String(r.id))
      const itemMap = new Map<string, any>(items.map((r: any) => [String(r.id), r]))

      const stocksRaw = itemIds.length
        ? await pgPool.query(
          `SELECT id, warehouse_id, item_id, quantity, threshold
           FROM warehouse_stocks
           WHERE item_id = ANY($1::text[])`,
          [itemIds],
        )
        : { rows: [] as any[] }

      const stocks = (stocksRaw.rows || []).map((s: any) => {
        const it = itemMap.get(String(s.item_id)) || {}
        const eff = s.threshold === null || s.threshold === undefined ? Number(it.default_threshold || 0) : Number(s.threshold || 0)
        const qty = Number(s.quantity || 0)
        const status =
          qty <= 0 ? 'out_of_stock' :
            qty < eff ? 'warning' :
              'normal'
        return {
          id: s.id,
          warehouse_id: s.warehouse_id,
          item_id: s.item_id,
          item_name: it.name,
          item_sku: it.sku,
          category: it.category,
          sub_type: it.sub_type,
          linen_type_code: it.linen_type_code,
          unit: it.unit,
          bin_location: it.bin_location,
          active: it.active,
          is_key_item: it.is_key_item,
          quantity: qty,
          threshold_effective: eff,
          status,
        }
      })

      const totalQty = stocks.reduce((sum: number, r: any) => sum + Number(r.quantity || 0), 0)
      const lowSkuCount = stocks.filter((r: any) => Number(r.quantity || 0) < Number(r.threshold_effective || 0)).length

      const byWarehouse = new Map<string, any>()
      for (const w of warehouses) {
        byWarehouse.set(String(w.id), {
          warehouse_id: String(w.id),
          warehouse_code: String(w.code),
          warehouse_name: String(w.name),
          counts_by_sub_type: {},
          available_sets: 0,
          low_stock: false,
        })
      }
      for (const r of stocks) {
        const wh = byWarehouse.get(String(r.warehouse_id))
        if (!wh) continue
        const st = category === 'linen'
          ? String(r.linen_type_code || r.sub_type || 'other')
          : String(r.sub_type || 'other')
        wh.counts_by_sub_type[st] = Number(wh.counts_by_sub_type[st] || 0) + Number(r.quantity || 0)
        if (Number(r.quantity || 0) < Number(r.threshold_effective || 0)) wh.low_stock = true
      }

      const roomTypeMap = new Map<string, any>(((roomTypes as any).rows || []).map((r: any) => [String(r.code), r]))
      const reqMap = new Map<string, Map<string, number>>()
      for (const r of (roomTypeReqs as any).rows || []) {
        const rt = String(r.room_type_code || '')
        const lt = String(r.linen_type_code || '')
        const qty = Number(r.quantity || 0)
        if (!rt || !lt || qty <= 0) continue
        if (!reqMap.has(rt)) reqMap.set(rt, new Map())
        reqMap.get(rt)!.set(lt, qty)
      }

      const roomTypesArr = (roomTypes as any).rows || []
      const defaultRoomType = category === 'linen' && roomTypesArr.length ? roomTypesArr[0] : null
      const defaultRoomTypeCode = defaultRoomType ? String(defaultRoomType.code) : null
      const defaultRoomTypeName = defaultRoomType ? String(defaultRoomType.name) : null

      let availableSetsTotal = 0
      for (const wh of byWarehouse.values()) {
        const c = wh.counts_by_sub_type || {}

        if (category === 'linen') {
          wh.available_sets_by_room_type = {}
          for (const [rtCode] of roomTypeMap.entries()) {
            const reqs = reqMap.get(rtCode)
            if (!reqs || reqs.size === 0) { wh.available_sets_by_room_type[rtCode] = 0; continue }
            const candidates: number[] = []
            for (const [lt, qty] of reqs.entries()) {
              const stockQty = Number(c[lt] || 0)
              candidates.push(Math.floor(stockQty / Math.max(1, qty)))
            }
            const sets = candidates.length ? Math.min(...candidates) : 0
            wh.available_sets_by_room_type[rtCode] = isFinite(sets) ? Math.max(0, sets) : 0
          }
          wh.available_sets = defaultRoomTypeCode ? Number(wh.available_sets_by_room_type[defaultRoomTypeCode] || 0) : 0
        } else {
          wh.available_sets = 0
        }

        availableSetsTotal += Number(wh.available_sets || 0)
      }

      const damagePending = itemIds.length
        ? await pgPool.query(
          `SELECT COUNT(*)::int AS c
           FROM stock_change_requests
           WHERE status = 'pending'
             AND reason = 'damage'
             AND item_id = ANY($1::text[])`,
          [itemIds],
        )
        : { rows: [{ c: 0 }] }
      const damagePendingCount = Number((damagePending as any).rows?.[0]?.c || 0)

      const todayMoves = itemIds.length
        ? await pgPool.query(
          `SELECT type, COALESCE(SUM(quantity),0)::int AS qty
           FROM stock_movements
           WHERE item_id = ANY($1::text[])
             AND created_at >= (date_trunc('day', now() AT TIME ZONE 'Australia/Melbourne') AT TIME ZONE 'Australia/Melbourne')
           GROUP BY type`,
          [itemIds],
        )
        : { rows: [] as any[] }
      const todayMap = new Map<string, number>((todayMoves as any).rows.map((r: any) => [String(r.type), Number(r.qty || 0)]))
      const todayIn = Number(todayMap.get('in') || 0)
      const todayOut = Number(todayMap.get('out') || 0)

      const cards = {
        total_qty: totalQty,
        available_sets_total: availableSetsTotal,
        available_sets_total_room_type_code: defaultRoomTypeCode,
        available_sets_total_room_type_name: defaultRoomTypeName,
        low_sku_count: lowSkuCount,
        damage_pending_count: damagePendingCount,
        today_in_qty: todayIn,
        today_out_qty: todayOut,
      }

      let unboundPropertyCount = 0
      if (category === 'linen') {
        try {
          const c = await pgPool.query(`SELECT COUNT(*)::int AS c FROM properties WHERE room_type_code IS NULL`)
          unboundPropertyCount = Number(c.rows?.[0]?.c || 0)
        } catch {}
      }

      return res.json({
        category,
        linen_types: (linenTypes as any).rows || [],
        room_types: (roomTypes as any).rows || [],
        unbound_property_count: unboundPropertyCount,
        cards,
        warehouses: Array.from(byWarehouse.values()).sort((a: any, b: any) => String(a.warehouse_code).localeCompare(String(b.warehouse_code))),
        stocks,
      })
    }
    return res.status(501).json({ message: 'not available without PG' })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.get('/unbound-properties', requirePerm('inventory.view'), async (req, res) => {
  const limit = Math.min(500, Math.max(1, Number((req.query as any)?.limit || 200)))
  try {
    if (hasPg && pgPool) {
      await ensureInventorySchema()
      const rows = await pgPool.query(
        `SELECT id, code, address, type, region
         FROM properties
         WHERE room_type_code IS NULL
         ORDER BY code NULLS LAST, address ASC
         LIMIT $1`,
        [limit],
      )
      return res.json(rows.rows || [])
    }
    return res.json([])
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

const changeRequestCreateSchema = z.object({
  warehouse_id: z.string().min(1),
  item_id: z.string().min(1),
  quantity: z.number().int().min(1),
  reason: z.enum(['damage', 'return_to_supplier']),
  note: z.string().optional(),
  photo_url: z.string().optional(),
})

router.post('/stock-change-requests', requirePerm('inventory.move'), async (req, res) => {
  const parsed = changeRequestCreateSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (!(hasPg && pgPool)) return res.status(501).json({ message: 'not available without PG' })
    await ensureInventorySchema()
    const id = uuidv4()
    const created_by = actorId(req)
    const r = await pgPool.query(
      `INSERT INTO stock_change_requests (id, warehouse_id, item_id, type, quantity, reason, note, photo_url, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        id,
        parsed.data.warehouse_id,
        parsed.data.item_id,
        'out',
        parsed.data.quantity,
        parsed.data.reason,
        parsed.data.note || null,
        parsed.data.photo_url || null,
        'pending',
        created_by,
      ],
    )
    addAudit('StockChangeRequest', id, 'create', null, r.rows?.[0] || null, actorId(req))
    return res.status(201).json(r.rows?.[0] || null)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.get('/stock-change-requests', requirePerm('inventory.view'), async (req, res) => {
  try {
    if (hasPg && pgPool) {
      await ensureInventorySchema()
      const q: any = req.query || {}
      const status = String(q.status || '').trim()
      const reason = String(q.reason || '').trim()
      const warehouse_id = String(q.warehouse_id || '').trim()
      const item_id = String(q.item_id || '').trim()
      const category = String(q.category || '').trim()
      const from = String(q.from || '').trim()
      const to = String(q.to || '').trim()
      const limit = Math.min(500, Math.max(1, Number(q.limit || 200)))

      let itemIdsByCategory: string[] | null = null
      if (category) {
        const its = await pgPool.query(`SELECT id FROM inventory_items WHERE category = $1`, [category])
        itemIdsByCategory = (its.rows || []).map((r: any) => String(r.id))
        if (!itemIdsByCategory.length) return res.json([])
      }

      const where: string[] = []
      const values: any[] = []
      if (status) { values.push(status); where.push(`r.status = $${values.length}`) }
      if (reason) { values.push(reason); where.push(`r.reason = $${values.length}`) }
      if (warehouse_id) { values.push(warehouse_id); where.push(`r.warehouse_id = $${values.length}`) }
      if (item_id) { values.push(item_id); where.push(`r.item_id = $${values.length}`) }
      if (itemIdsByCategory) { values.push(itemIdsByCategory); where.push(`r.item_id = ANY($${values.length}::text[])`) }
      if (from) { values.push(from); where.push(`r.created_at >= $${values.length}::timestamptz`) }
      if (to) { values.push(to); where.push(`r.created_at <= $${values.length}::timestamptz`) }
      values.push(limit)

      const sql = `
        SELECT r.*
        FROM stock_change_requests r
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY r.created_at DESC
        LIMIT $${values.length}
      `
      const rr = await pgPool.query(sql, values)
      const rows = rr.rows || []
      if (!rows.length) return res.json([])

      const warehouseIds = Array.from(new Set(rows.map((x: any) => String(x.warehouse_id || '')).filter(Boolean)))
      const itemIds = Array.from(new Set(rows.map((x: any) => String(x.item_id || '')).filter(Boolean)))

      const [whRows, itRows] = await Promise.all([
        warehouseIds.length ? pgPool.query(`SELECT id, code, name FROM warehouses WHERE id = ANY($1::text[])`, [warehouseIds]) : Promise.resolve({ rows: [] as any[] }),
        itemIds.length ? pgPool.query(`SELECT id, name, sku, category, sub_type FROM inventory_items WHERE id = ANY($1::text[])`, [itemIds]) : Promise.resolve({ rows: [] as any[] }),
      ])
      const whMap = new Map<string, any>((whRows as any).rows.map((r: any) => [String(r.id), r]))
      const itMap = new Map<string, any>((itRows as any).rows.map((r: any) => [String(r.id), r]))

      const out = rows.map((r: any) => {
        const w = whMap.get(String(r.warehouse_id)) || {}
        const it = itMap.get(String(r.item_id)) || {}
        return {
          ...r,
          warehouse_code: w.code,
          warehouse_name: w.name,
          item_name: it.name,
          item_sku: it.sku,
          item_category: it.category,
          item_sub_type: it.sub_type,
        }
      })
      return res.json(out)
    }
    return res.json([])
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

const changeRequestPatchSchema = z.object({
  status: z.enum(['approved', 'rejected']),
})

router.patch('/stock-change-requests/:id', requirePerm('inventory.move'), async (req, res) => {
  const id = String(req.params.id || '')
  const parsed = changeRequestPatchSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (!(hasPg && pgPool)) return res.status(501).json({ message: 'not available without PG' })
    await ensureInventorySchema()
    const handled_by = actorId(req)
    const handled_at = new Date().toISOString()
    if (parsed.data.status === 'rejected') {
      const before = await pgPool.query(`SELECT * FROM stock_change_requests WHERE id = $1`, [id])
      const b = before.rows?.[0]
      if (!b) return res.status(404).json({ message: 'not found' })
      if (String(b.status) !== 'pending') return res.status(409).json({ message: 'already handled' })
      const after = await pgPool.query(
        `UPDATE stock_change_requests
         SET status = 'rejected', handled_by = $1, handled_at = $2
         WHERE id = $3
         RETURNING *`,
        [handled_by, handled_at, id],
      )
      addAudit('StockChangeRequest', id, 'update', b, after.rows?.[0] || null, actorId(req))
      return res.json(after.rows?.[0] || null)
    }

    const result = await pgRunInTransaction(async (client) => {
      const r0 = await client.query(`SELECT * FROM stock_change_requests WHERE id = $1 FOR UPDATE`, [id])
      const row = r0.rows?.[0]
      if (!row) return { ok: false as const, code: 404 as const, message: 'not found' }
      if (String(row.status) !== 'pending') return { ok: false as const, code: 409 as const, message: 'already handled' }

      const move = await applyStockDeltaInTx(client, {
        warehouse_id: String(row.warehouse_id),
        item_id: String(row.item_id),
        type: 'out',
        quantity: Number(row.quantity || 0),
        reason: String(row.reason || ''),
        actor_id: handled_by,
        note: row.note || null,
        photo_url: row.photo_url || null,
        ref_type: 'stock_change_request',
        ref_id: String(row.id),
      })
      if (!move.ok) return move as any

      const after = await client.query(
        `UPDATE stock_change_requests
         SET status = 'approved', handled_by = $1, handled_at = $2, movement_id = $3
         WHERE id = $4
         RETURNING *`,
        [handled_by, handled_at, move.movement_id, id],
      )
      return { ok: true as const, row: after.rows?.[0] || null }
    })
    if (!result) return res.status(500).json({ message: 'db not ready' })
    if (!(result as any).ok) return res.status((result as any).code).json({ message: (result as any).message })
    addAudit('StockChangeRequest', id, 'approve', null, (result as any).row || null, actorId(req))
    return res.json((result as any).row || null)
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
  ordered_date: z.string().optional(),
  requested_delivery_date: z.string().optional(),
  note: z.string().optional(),
  lines: z.array(z.union([
    z.object({
      item_id: z.string().min(1),
      quantity: z.number().int().min(1),
      unit: z.string().optional(),
      unit_price: z.number().optional(),
      note: z.string().optional(),
    }),
    z.object({
      room_type_code: z.string().min(1),
      sets: z.number().int().min(1),
    }),
  ])).min(1),
})

router.get('/purchase-orders', requirePerm('inventory.po.manage'), async (req, res) => {
  try {
    if (hasPg && pgPool) {
      await ensureInventorySchema()
      const q: any = req.query || {}
      const status = String(q.status || '').trim()
      const supplier_id = String(q.supplier_id || '').trim()
      const warehouse_id = String(q.warehouse_id || '').trim()
      const category = String(q.category || '').trim()
      let poIds: string[] | null = null
      if (category) {
        const its = await pgPool.query(`SELECT id FROM inventory_items WHERE category = $1`, [category])
        const itemIds = (its.rows || []).map((r: any) => String(r.id))
        if (!itemIds.length) return res.json([])
        const prs = await pgPool.query(`SELECT DISTINCT po_id FROM purchase_order_lines WHERE item_id = ANY($1::text[])`, [itemIds])
        poIds = (prs.rows || []).map((r: any) => String(r.po_id))
        if (!poIds.length) return res.json([])
      }

      const where: string[] = []
      const values: any[] = []
      if (status) { values.push(status); where.push(`po.status = $${values.length}`) }
      if (supplier_id) { values.push(supplier_id); where.push(`po.supplier_id = $${values.length}`) }
      if (warehouse_id) { values.push(warehouse_id); where.push(`po.warehouse_id = $${values.length}`) }
      if (poIds) { values.push(poIds); where.push(`po.id = ANY($${values.length}::text[])`) }

      const sql = `
        SELECT po.*
        FROM purchase_orders po
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY po.created_at DESC
        LIMIT 200
      `
      const poRows = await pgPool.query(sql, values)
      const rows = poRows.rows || []
      if (!rows.length) return res.json([])

      const supplierIds = Array.from(new Set(rows.map((r: any) => String(r.supplier_id || '')).filter(Boolean)))
      const warehouseIds = Array.from(new Set(rows.map((r: any) => String(r.warehouse_id || '')).filter(Boolean)))

      const [supRows, whRows, aggRows] = await Promise.all([
        supplierIds.length ? pgPool.query(`SELECT id, name FROM suppliers WHERE id = ANY($1::text[])`, [supplierIds]) : Promise.resolve({ rows: [] as any[] }),
        warehouseIds.length ? pgPool.query(`SELECT id, code, name FROM warehouses WHERE id = ANY($1::text[])`, [warehouseIds]) : Promise.resolve({ rows: [] as any[] }),
        pgPool.query(
          `SELECT po_id,
                  COUNT(*)::int AS line_count,
                  COALESCE(SUM(quantity),0)::int AS quantity_total,
                  COALESCE(SUM(COALESCE(unit_price,0) * quantity),0) AS amount_total
           FROM purchase_order_lines
           WHERE po_id = ANY($1::text[])
           GROUP BY po_id`,
          [rows.map((r: any) => String(r.id))],
        ),
      ])

      const supMap = new Map<string, any>((supRows as any).rows.map((r: any) => [String(r.id), r]))
      const whMap = new Map<string, any>((whRows as any).rows.map((r: any) => [String(r.id), r]))
      const aggMap = new Map<string, any>((aggRows as any).rows.map((r: any) => [String(r.po_id), r]))

      const out = rows.map((r: any) => {
        const s = supMap.get(String(r.supplier_id)) || {}
        const w = whMap.get(String(r.warehouse_id)) || {}
        const a = aggMap.get(String(r.id)) || {}
        return {
          ...r,
          supplier_name: s.name,
          warehouse_name: w.name,
          warehouse_code: w.code,
          line_count: Number(a.line_count || 0),
          quantity_total: Number(a.quantity_total || 0),
          amount_total: a.amount_total !== undefined && a.amount_total !== null ? String(a.amount_total) : '0',
        }
      })
      return res.json(out)
    }
    return res.json([])
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.get('/purchase-order-lines', requirePerm('inventory.po.manage'), async (req, res) => {
  try {
    if (hasPg && pgPool) {
      await ensureInventorySchema()
      const q: any = req.query || {}
      const status = String(q.status || '').trim()
      const supplier_id = String(q.supplier_id || '').trim()
      const warehouse_id = String(q.warehouse_id || '').trim()
      const category = String(q.category || '').trim()
      const from = String(q.from || '').trim()
      const to = String(q.to || '').trim()

      let itemIdsByCategory: string[] | null = null
      let poIdsByCategory: string[] | null = null
      if (category) {
        const its = await pgPool.query(`SELECT id FROM inventory_items WHERE category = $1`, [category])
        itemIdsByCategory = (its.rows || []).map((r: any) => String(r.id))
        if (!itemIdsByCategory.length) return res.json([])
        const prs = await pgPool.query(`SELECT DISTINCT po_id FROM purchase_order_lines WHERE item_id = ANY($1::text[])`, [itemIdsByCategory])
        poIdsByCategory = (prs.rows || []).map((r: any) => String(r.po_id))
        if (!poIdsByCategory.length) return res.json([])
      }

      const where: string[] = []
      const values: any[] = []
      if (status) { values.push(status); where.push(`po.status = $${values.length}`) }
      if (supplier_id) { values.push(supplier_id); where.push(`po.supplier_id = $${values.length}`) }
      if (warehouse_id) { values.push(warehouse_id); where.push(`po.warehouse_id = $${values.length}`) }
      if (from) { values.push(from); where.push(`po.created_at >= $${values.length}::timestamptz`) }
      if (to) { values.push(to); where.push(`po.created_at <= $${values.length}::timestamptz`) }
      if (poIdsByCategory) { values.push(poIdsByCategory); where.push(`po.id = ANY($${values.length}::text[])`) }

      const pos = await pgPool.query(
        `SELECT po.*
         FROM purchase_orders po
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY po.created_at DESC
         LIMIT 200`,
        values,
      )
      const poRows = pos.rows || []
      if (!poRows.length) return res.json([])
      const poIds = poRows.map((r: any) => String(r.id))

      const lineWhere: string[] = [`po_id = ANY($1::text[])`]
      const lineVals: any[] = [poIds]
      if (itemIdsByCategory) { lineVals.push(itemIdsByCategory); lineWhere.push(`item_id = ANY($${lineVals.length}::text[])`) }
      const lines = await pgPool.query(
        `SELECT * FROM purchase_order_lines
         WHERE ${lineWhere.join(' AND ')}
         ORDER BY po_id ASC`,
        lineVals,
      )
      const lineRows = lines.rows || []
      if (!lineRows.length) return res.json([])

      const supplierIds = Array.from(new Set(poRows.map((r: any) => String(r.supplier_id || '')).filter(Boolean)))
      const warehouseIds = Array.from(new Set(poRows.map((r: any) => String(r.warehouse_id || '')).filter(Boolean)))
      const itemIds = Array.from(new Set(lineRows.map((r: any) => String(r.item_id || '')).filter(Boolean)))

      const [supRows, whRows, itRows] = await Promise.all([
        supplierIds.length ? pgPool.query(`SELECT id, name FROM suppliers WHERE id = ANY($1::text[])`, [supplierIds]) : Promise.resolve({ rows: [] as any[] }),
        warehouseIds.length ? pgPool.query(`SELECT id, code, name FROM warehouses WHERE id = ANY($1::text[])`, [warehouseIds]) : Promise.resolve({ rows: [] as any[] }),
        itemIds.length ? pgPool.query(`SELECT id, name, sku, category, sub_type FROM inventory_items WHERE id = ANY($1::text[])`, [itemIds]) : Promise.resolve({ rows: [] as any[] }),
      ])
      const poMap = new Map<string, any>(poRows.map((r: any) => [String(r.id), r]))
      const supMap = new Map<string, any>((supRows as any).rows.map((r: any) => [String(r.id), r]))
      const whMap = new Map<string, any>((whRows as any).rows.map((r: any) => [String(r.id), r]))
      const itMap = new Map<string, any>((itRows as any).rows.map((r: any) => [String(r.id), r]))

      const out = lineRows.map((l: any) => {
        const po = poMap.get(String(l.po_id)) || {}
        const s = supMap.get(String(po.supplier_id)) || {}
        const w = whMap.get(String(po.warehouse_id)) || {}
        const it = itMap.get(String(l.item_id)) || {}
        const qty = Number(l.quantity || 0)
        const unitPrice = l.unit_price === null || l.unit_price === undefined ? null : Number(l.unit_price)
        const amount = unitPrice === null ? null : unitPrice * qty
        return {
          ...l,
          po_id: String(l.po_id),
          po_status: po.status,
          po_ordered_date: po.ordered_date,
          po_created_at: po.created_at,
          po_requested_delivery_date: po.requested_delivery_date,
          po_region: po.region,
          po_property_id: po.property_id,
          supplier_id: po.supplier_id,
          supplier_name: s.name,
          warehouse_id: po.warehouse_id,
          warehouse_code: w.code,
          warehouse_name: w.name,
          item_name: it.name,
          item_sku: it.sku,
          item_category: it.category,
          item_sub_type: it.sub_type,
          amount,
        }
      }).sort((a: any, b: any) => String(b.po_created_at || '').localeCompare(String(a.po_created_at || '')))
      return res.json(out)
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
    const regionExplicit = String(parsed.data.region || '').trim()
    let regionFinal = regionExplicit
    const supplier_id = supplierIdExplicit || (regionFinal ? await pickSupplierIdForRegion(regionFinal) : null)
    if (!supplier_id) return res.status(400).json({ message: '无法确定供应商，请手动选择 supplier_id' })

    const poId = uuidv4()
    const created_by = actorId(req)
    const warehouseFinal = 'wh.south_melbourne'
    const orderedDate = String(parsed.data.ordered_date || '').trim()

    const result = await pgRunInTransaction(async (client) => {
      const poRow = await client.query(
        `INSERT INTO purchase_orders (id, supplier_id, warehouse_id, status, ordered_date, requested_delivery_date, region, property_id, note, created_by)
         VALUES ($1,$2,$3,$4,COALESCE(NULLIF($5,'')::date, (now() AT TIME ZONE 'Australia/Melbourne')::date),$6,$7,$8,$9,$10)
         RETURNING *`,
        [
          poId,
          supplier_id,
          warehouseFinal,
          'draft',
          orderedDate,
          parsed.data.requested_delivery_date ? parsed.data.requested_delivery_date : null,
          regionFinal || null,
          null,
          parsed.data.note || null,
          created_by,
        ],
      )

      const qtyByItem = new Map<string, number>()
      const metaByItem = new Map<string, { unit_price: number | null; note: string | null; unit: string | null }>()

      for (const ln of parsed.data.lines as any[]) {
        if (ln.item_id) {
          const item_id = String(ln.item_id)
          const qty = Number(ln.quantity || 0)
          qtyByItem.set(item_id, (qtyByItem.get(item_id) || 0) + qty)
          metaByItem.set(item_id, { unit_price: ln.unit_price ?? null, note: ln.note || null, unit: ln.unit || null })
          continue
        }
        if (ln.room_type_code) {
          const roomTypeCode = String(ln.room_type_code)
          const sets = Number(ln.sets || 0)
          const reqs = await client.query(
            `SELECT linen_type_code, quantity
             FROM inventory_room_type_requirements
             WHERE room_type_code = $1`,
            [roomTypeCode],
          )
          for (const r of reqs.rows || []) {
            const linenTypeCode = String(r.linen_type_code)
            const perSet = Number(r.quantity || 0)
            if (perSet <= 0) continue
            const item_id = `item.linen_type.${linenTypeCode}`
            const qty = sets * perSet
            qtyByItem.set(item_id, (qtyByItem.get(item_id) || 0) + qty)
            if (!metaByItem.has(item_id)) metaByItem.set(item_id, { unit_price: null, note: null, unit: null })
          }
        }
      }

      const linesOut: any[] = []
      for (const [item_id, quantity] of qtyByItem.entries()) {
        const item = await client.query(`SELECT id, unit FROM inventory_items WHERE id = $1`, [item_id])
        const meta = metaByItem.get(item_id) || { unit_price: null, note: null, unit: null }
        const unit = meta.unit || item.rows?.[0]?.unit
        if (!unit) throw new Error('unit missing')
        const lineId = uuidv4()
        const row = await client.query(
          `INSERT INTO purchase_order_lines (id, po_id, item_id, quantity, unit, unit_price, note)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           RETURNING *`,
          [lineId, poId, item_id, quantity, unit, meta.unit_price, meta.note],
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
  ordered_date: z.string().optional(),
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
