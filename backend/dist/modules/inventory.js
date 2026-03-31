"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.router = void 0;
const express_1 = require("express");
const store_1 = require("../store");
const zod_1 = require("zod");
const auth_1 = require("../auth");
const dbAdapter_1 = require("../dbAdapter");
const uuid_1 = require("uuid");
exports.router = (0, express_1.Router)();
function actorId(req) {
    const u = (req === null || req === void 0 ? void 0 : req.user) || {};
    return (u === null || u === void 0 ? void 0 : u.sub) || (u === null || u === void 0 ? void 0 : u.username) || null;
}
let inventorySchemaEnsured = false;
async function ensureInventorySchema() {
    if (!dbAdapter_1.pgPool)
        return;
    if (inventorySchemaEnsured)
        return;
    inventorySchemaEnsured = true;
    try {
        await dbAdapter_1.pgPool.query(`CREATE TABLE IF NOT EXISTS warehouses (
      id text PRIMARY KEY,
      code text NOT NULL,
      name text NOT NULL,
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now()
    );`);
        await dbAdapter_1.pgPool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'unique_warehouses_code') THEN
        ALTER TABLE warehouses ADD CONSTRAINT unique_warehouses_code UNIQUE (code);
      END IF;
    END $$;`);
        await dbAdapter_1.pgPool.query(`CREATE TABLE IF NOT EXISTS inventory_items (
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
    );`);
        await dbAdapter_1.pgPool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'unique_inventory_items_sku') THEN
        ALTER TABLE inventory_items ADD CONSTRAINT unique_inventory_items_sku UNIQUE (sku);
      END IF;
    END $$;`);
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_inventory_items_category ON inventory_items(category);');
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_inventory_items_active ON inventory_items(active);');
        await dbAdapter_1.pgPool.query(`CREATE TABLE IF NOT EXISTS warehouse_stocks (
      id text PRIMARY KEY,
      warehouse_id text NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      item_id text NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
      quantity integer NOT NULL DEFAULT 0,
      threshold integer,
      updated_at timestamptz
    );`);
        await dbAdapter_1.pgPool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'unique_warehouse_item') THEN
        ALTER TABLE warehouse_stocks ADD CONSTRAINT unique_warehouse_item UNIQUE (warehouse_id, item_id);
      END IF;
    END $$;`);
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_warehouse_stocks_wh ON warehouse_stocks(warehouse_id);');
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_warehouse_stocks_item ON warehouse_stocks(item_id);');
        await dbAdapter_1.pgPool.query(`CREATE TABLE IF NOT EXISTS suppliers (
      id text PRIMARY KEY,
      name text NOT NULL,
      kind text NOT NULL DEFAULT 'linen',
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now()
    );`);
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_suppliers_active ON suppliers(active);');
        await dbAdapter_1.pgPool.query(`CREATE TABLE IF NOT EXISTS region_supplier_rules (
      id text PRIMARY KEY,
      region_key text NOT NULL,
      supplier_id text NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
      priority integer NOT NULL DEFAULT 0,
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now()
    );`);
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_region_supplier_rules_region ON region_supplier_rules(region_key);');
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_region_supplier_rules_active ON region_supplier_rules(active);');
        await dbAdapter_1.pgPool.query(`CREATE TABLE IF NOT EXISTS purchase_orders (
      id text PRIMARY KEY,
      supplier_id text NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
      warehouse_id text NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
      status text NOT NULL DEFAULT 'draft',
      requested_delivery_date date,
      note text,
      created_by text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz
    );`);
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_purchase_orders_supplier ON purchase_orders(supplier_id);');
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_purchase_orders_warehouse ON purchase_orders(warehouse_id);');
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_purchase_orders_status ON purchase_orders(status);');
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_purchase_orders_created_at ON purchase_orders(created_at);');
        await dbAdapter_1.pgPool.query(`CREATE TABLE IF NOT EXISTS purchase_order_lines (
      id text PRIMARY KEY,
      po_id text NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
      item_id text NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
      quantity integer NOT NULL,
      unit text NOT NULL,
      unit_price numeric,
      note text
    );`);
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_purchase_order_lines_po ON purchase_order_lines(po_id);');
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_purchase_order_lines_item ON purchase_order_lines(item_id);');
        await dbAdapter_1.pgPool.query(`CREATE TABLE IF NOT EXISTS purchase_deliveries (
      id text PRIMARY KEY,
      po_id text NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
      received_at timestamptz NOT NULL DEFAULT now(),
      received_by text,
      note text,
      created_at timestamptz NOT NULL DEFAULT now()
    );`);
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_purchase_deliveries_po ON purchase_deliveries(po_id);');
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_purchase_deliveries_received_at ON purchase_deliveries(received_at);');
        await dbAdapter_1.pgPool.query(`CREATE TABLE IF NOT EXISTS purchase_delivery_lines (
      id text PRIMARY KEY,
      delivery_id text NOT NULL REFERENCES purchase_deliveries(id) ON DELETE CASCADE,
      item_id text NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
      quantity_received integer NOT NULL,
      note text
    );`);
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_purchase_delivery_lines_delivery ON purchase_delivery_lines(delivery_id);');
        await dbAdapter_1.pgPool.query(`CREATE TABLE IF NOT EXISTS stock_movements (
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
    );`);
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_stock_movements_wh ON stock_movements(warehouse_id);');
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_stock_movements_item ON stock_movements(item_id);');
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_stock_movements_property ON stock_movements(property_id);');
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_stock_movements_created_at ON stock_movements(created_at);');
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_stock_movements_ref ON stock_movements(ref_type, ref_id);');
        await dbAdapter_1.pgPool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_movements_type_check') THEN
        ALTER TABLE stock_movements
          ADD CONSTRAINT stock_movements_type_check
          CHECK (type IN ('in','out','adjust'));
      END IF;
    END $$;`);
        await dbAdapter_1.pgPool.query(`INSERT INTO warehouses (id, code, name) VALUES
      ('wh.south_melbourne', 'SOU', 'South Melbourne'),
      ('wh.msq', 'MSQ', 'MSQ'),
      ('wh.wsp', 'WSP', 'WSP'),
      ('wh.my80', 'MY80', 'My80')
    ON CONFLICT (id) DO NOTHING;`);
        await dbAdapter_1.pgPool.query(`INSERT INTO suppliers (id, name, kind) VALUES
      ('sup.linen.1', '床品供应商1', 'linen'),
      ('sup.linen.2', '床品供应商2', 'linen')
    ON CONFLICT (id) DO NOTHING;`);
        await dbAdapter_1.pgPool.query(`INSERT INTO region_supplier_rules (id, region_key, supplier_id, priority) VALUES
      ('rsr.southbank', 'Southbank', 'sup.linen.1', 100),
      ('rsr.default', '*', 'sup.linen.2', 0)
    ON CONFLICT (id) DO NOTHING;`);
    }
    catch (e) {
        inventorySchemaEnsured = false;
        throw e;
    }
}
async function pickSupplierIdForRegion(region) {
    var _a, _b;
    if (!dbAdapter_1.pgPool)
        return null;
    await ensureInventorySchema();
    const r = String(region || '').trim();
    const rows = await dbAdapter_1.pgPool.query(`SELECT supplier_id
     FROM region_supplier_rules
     WHERE active = true
       AND (region_key = $1 OR region_key = '*')
     ORDER BY (CASE WHEN region_key = $1 THEN 1 ELSE 0 END) DESC, priority DESC
     LIMIT 1`, [r || '__none__']);
    return ((_b = (_a = rows.rows) === null || _a === void 0 ? void 0 : _a[0]) === null || _b === void 0 ? void 0 : _b.supplier_id) || null;
}
async function ensureWarehouseStockRow(client, warehouse_id, item_id) {
    const id = `ws.${warehouse_id}.${item_id}`;
    await client.query(`INSERT INTO warehouse_stocks (id, warehouse_id, item_id, quantity)
     VALUES ($1, $2, $3, 0)
     ON CONFLICT (warehouse_id, item_id) DO NOTHING`, [id, warehouse_id, item_id]);
}
async function applyStockDeltaInTx(client, input) {
    var _a, _b;
    await ensureWarehouseStockRow(client, input.warehouse_id, input.item_id);
    const lock = await client.query(`SELECT id, quantity
     FROM warehouse_stocks
     WHERE warehouse_id = $1 AND item_id = $2
     FOR UPDATE`, [input.warehouse_id, input.item_id]);
    const row = (_a = lock.rows) === null || _a === void 0 ? void 0 : _a[0];
    if (!row)
        throw new Error('warehouse stock missing');
    const delta = input.type === 'in' ? input.quantity : input.type === 'out' ? -input.quantity : input.quantity;
    const nextQty = Number(row.quantity || 0) + Number(delta || 0);
    if (nextQty < 0)
        return { ok: false, code: 409, message: 'insufficient stock' };
    await client.query(`UPDATE warehouse_stocks SET quantity = $1, updated_at = now() WHERE id = $2`, [nextQty, row.id]);
    const moveId = (0, uuid_1.v4)();
    await client.query(`INSERT INTO stock_movements (id, warehouse_id, item_id, type, reason, quantity, property_id, ref_type, ref_id, actor_id, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [
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
    ]);
    const after = await client.query(`SELECT * FROM warehouse_stocks WHERE id = $1`, [row.id]);
    return { ok: true, stock: ((_b = after.rows) === null || _b === void 0 ? void 0 : _b[0]) || null, movement_id: moveId };
}
exports.router.get('/warehouses', (0, auth_1.requirePerm)('inventory.view'), async (req, res) => {
    try {
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            await ensureInventorySchema();
            const rows = await dbAdapter_1.pgPool.query(`SELECT id, code, name, active FROM warehouses ORDER BY code ASC`);
            return res.json(rows.rows || []);
        }
        return res.json([
            { id: 'wh.south_melbourne', code: 'SOU', name: 'South Melbourne', active: true },
            { id: 'wh.msq', code: 'MSQ', name: 'MSQ', active: true },
            { id: 'wh.wsp', code: 'WSP', name: 'WSP', active: true },
            { id: 'wh.my80', code: 'MY80', name: 'My80', active: true },
        ]);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.get('/items', (0, auth_1.requirePerm)('inventory.view'), async (req, res) => {
    var _a, _b, _c;
    try {
        const q = String(((_a = req.query) === null || _a === void 0 ? void 0 : _a.q) || '').trim();
        const category = String(((_b = req.query) === null || _b === void 0 ? void 0 : _b.category) || '').trim();
        const active = String(((_c = req.query) === null || _c === void 0 ? void 0 : _c.active) || '').trim().toLowerCase();
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            await ensureInventorySchema();
            const where = [];
            const values = [];
            if (q) {
                values.push(`%${q}%`);
                values.push(`%${q}%`);
                where.push(`(name ILIKE $${values.length - 1} OR sku ILIKE $${values.length})`);
            }
            if (category) {
                values.push(category);
                where.push(`category = $${values.length}`);
            }
            if (active === 'true' || active === 'false') {
                values.push(active === 'true');
                where.push(`active = $${values.length}`);
            }
            const sql = `SELECT id, name, sku, category, unit, default_threshold, bin_location, active, is_key_item
                   FROM inventory_items
                   ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                   ORDER BY name ASC`;
            const rows = await dbAdapter_1.pgPool.query(sql, values);
            return res.json(rows.rows || []);
        }
        return res.json(store_1.db.inventoryItems || []);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
const createItemSchema = zod_1.z.object({
    name: zod_1.z.string().min(1),
    sku: zod_1.z.string().min(1),
    category: zod_1.z.enum(['linen', 'consumable', 'daily']).optional(),
    unit: zod_1.z.string().min(1),
    default_threshold: zod_1.z.number().int().min(0).optional(),
    bin_location: zod_1.z.string().optional(),
    active: zod_1.z.boolean().optional(),
    is_key_item: zod_1.z.boolean().optional(),
});
exports.router.post('/items', (0, auth_1.requirePerm)('inventory.item.manage'), async (req, res) => {
    var _a, _b, _c, _d, _e, _f;
    const parsed = createItemSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    try {
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            await ensureInventorySchema();
            const item = {
                id: (0, uuid_1.v4)(),
                name: parsed.data.name,
                sku: parsed.data.sku,
                category: parsed.data.category || 'consumable',
                unit: parsed.data.unit,
                default_threshold: (_a = parsed.data.default_threshold) !== null && _a !== void 0 ? _a : 0,
                bin_location: parsed.data.bin_location || null,
                active: (_b = parsed.data.active) !== null && _b !== void 0 ? _b : true,
                is_key_item: (_c = parsed.data.is_key_item) !== null && _c !== void 0 ? _c : false,
            };
            const row = await dbAdapter_1.pgPool.query(`INSERT INTO inventory_items (id, name, sku, category, unit, default_threshold, bin_location, active, is_key_item)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING *`, [item.id, item.name, item.sku, item.category, item.unit, item.default_threshold, item.bin_location, item.active, item.is_key_item]);
            (0, store_1.addAudit)('InventoryItem', item.id, 'create', null, ((_d = row.rows) === null || _d === void 0 ? void 0 : _d[0]) || item, actorId(req));
            return res.status(201).json(((_e = row.rows) === null || _e === void 0 ? void 0 : _e[0]) || item);
        }
        const item = { id: (0, uuid_1.v4)(), threshold: (_f = parsed.data.default_threshold) !== null && _f !== void 0 ? _f : 0, quantity: 0, ...parsed.data, category: parsed.data.category || 'consumable' };
        store_1.db.inventoryItems.push(item);
        (0, store_1.addAudit)('InventoryItem', item.id, 'create', null, item, actorId(req));
        return res.status(201).json(item);
    }
    catch (e) {
        const msg = String((e === null || e === void 0 ? void 0 : e.message) || '');
        if (/unique_inventory_items_sku/i.test(msg) || /duplicate key value/i.test(msg))
            return res.status(400).json({ message: 'SKU 已存在' });
        return res.status(500).json({ message: msg || 'failed' });
    }
});
const patchItemSchema = createItemSchema.partial();
exports.router.patch('/items/:id', (0, auth_1.requirePerm)('inventory.item.manage'), async (req, res) => {
    var _a, _b, _c;
    const parsed = patchItemSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    const id = String(req.params.id || '');
    try {
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            await ensureInventorySchema();
            const before = await dbAdapter_1.pgPool.query(`SELECT * FROM inventory_items WHERE id = $1`, [id]);
            const b = (_a = before.rows) === null || _a === void 0 ? void 0 : _a[0];
            if (!b)
                return res.status(404).json({ message: 'item not found' });
            const payload = parsed.data;
            const keys = Object.keys(payload).filter(k => payload[k] !== undefined);
            if (!keys.length)
                return res.json(b);
            const sets = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ');
            const values = keys.map(k => payload[k]);
            const sql = `UPDATE inventory_items SET ${sets}, updated_at = now() WHERE id = $${keys.length + 1} RETURNING *`;
            const after = await dbAdapter_1.pgPool.query(sql, [...values, id]);
            (0, store_1.addAudit)('InventoryItem', id, 'update', b, ((_b = after.rows) === null || _b === void 0 ? void 0 : _b[0]) || null, actorId(req));
            return res.json(((_c = after.rows) === null || _c === void 0 ? void 0 : _c[0]) || null);
        }
        const it = store_1.db.inventoryItems.find((x) => x.id === id);
        if (!it)
            return res.status(404).json({ message: 'item not found' });
        const before = { ...it };
        Object.assign(it, parsed.data);
        (0, store_1.addAudit)('InventoryItem', id, 'update', before, it, actorId(req));
        return res.json(it);
    }
    catch (e) {
        const msg = String((e === null || e === void 0 ? void 0 : e.message) || '');
        if (/unique_inventory_items_sku/i.test(msg) || /duplicate key value/i.test(msg))
            return res.status(400).json({ message: 'SKU 已存在' });
        return res.status(500).json({ message: msg || 'failed' });
    }
});
exports.router.get('/stocks', (0, auth_1.requirePerm)('inventory.view'), async (req, res) => {
    var _a, _b, _c;
    const warehouse_id = String(((_a = req.query) === null || _a === void 0 ? void 0 : _a.warehouse_id) || '').trim();
    if (!warehouse_id)
        return res.status(400).json({ message: 'warehouse_id required' });
    const warningsOnly = String(((_b = req.query) === null || _b === void 0 ? void 0 : _b.warnings_only) || '').toLowerCase() === 'true';
    const keyOnly = String(((_c = req.query) === null || _c === void 0 ? void 0 : _c.key_only) || '').toLowerCase() === 'true';
    try {
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            await ensureInventorySchema();
            const values = [warehouse_id];
            const where = [`s.warehouse_id = $1`];
            if (keyOnly)
                where.push(`i.is_key_item = true`);
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
      `;
            const rows = await dbAdapter_1.pgPool.query(sql, values);
            let out = (rows.rows || []).map((r) => ({
                ...r,
                threshold_effective: r.threshold === null || r.threshold === undefined ? Number(r.default_threshold || 0) : Number(r.threshold || 0),
            }));
            if (warningsOnly)
                out = out.filter((x) => Number(x.quantity || 0) < Number(x.threshold_effective || 0));
            return res.json(out);
        }
        return res.json([]);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.get('/warnings', (0, auth_1.requirePerm)('inventory.view'), async (req, res) => {
    var _a;
    const warehouse_id = String(((_a = req.query) === null || _a === void 0 ? void 0 : _a.warehouse_id) || '').trim();
    try {
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            await ensureInventorySchema();
            const values = [];
            const where = [];
            if (warehouse_id) {
                values.push(warehouse_id);
                where.push(`s.warehouse_id = $${values.length}`);
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
      `;
            const rows = await dbAdapter_1.pgPool.query(sql, values);
            const out = (rows.rows || []).map((r) => {
                const eff = r.threshold === null || r.threshold === undefined ? Number(r.default_threshold || 0) : Number(r.threshold || 0);
                return { ...r, threshold_effective: eff };
            }).filter((x) => Number(x.quantity || 0) < Number(x.threshold_effective || 0));
            return res.json(out);
        }
        return res.json((store_1.db.inventoryItems || []).filter((i) => i.quantity < i.threshold));
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
const movementSchema = zod_1.z.object({
    warehouse_id: zod_1.z.string().min(1),
    item_id: zod_1.z.string().min(1),
    type: zod_1.z.enum(['in', 'out', 'adjust']),
    quantity: zod_1.z.number().int(),
    reason: zod_1.z.string().optional(),
    property_id: zod_1.z.string().optional(),
    ref_type: zod_1.z.string().optional(),
    ref_id: zod_1.z.string().optional(),
    note: zod_1.z.string().optional(),
}).superRefine((v, ctx) => {
    if (v.type === 'in' || v.type === 'out') {
        if (v.quantity <= 0)
            ctx.addIssue({ code: 'custom', message: 'quantity must be >= 1', path: ['quantity'] });
    }
    else {
        if (v.quantity === 0)
            ctx.addIssue({ code: 'custom', message: 'quantity must not be 0', path: ['quantity'] });
    }
});
exports.router.post('/movements', (0, auth_1.requirePerm)('inventory.move'), async (req, res) => {
    const parsed = movementSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    try {
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            await ensureInventorySchema();
            const result = await (0, dbAdapter_1.pgRunInTransaction)(async (client) => {
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
                });
                if (!r.ok)
                    return r;
                const stockRow = r.stock;
                (0, store_1.addAudit)('WarehouseStock', (stockRow === null || stockRow === void 0 ? void 0 : stockRow.id) || `${parsed.data.warehouse_id}.${parsed.data.item_id}`, 'movement', null, { movement_id: r.movement_id, stock: stockRow }, actorId(req));
                return r;
            });
            if (!result)
                return res.status(500).json({ message: 'db not ready' });
            if (!result.ok)
                return res.status(result.code).json({ message: result.message });
            return res.json(result.stock || null);
        }
        const item = store_1.db.inventoryItems.find((i) => i.id === parsed.data.item_id);
        if (!item)
            return res.status(404).json({ message: 'item not found' });
        const before = { ...item };
        if (parsed.data.type === 'in')
            item.quantity += parsed.data.quantity;
        else if (parsed.data.type === 'out') {
            if (item.quantity < parsed.data.quantity)
                return res.status(409).json({ message: 'insufficient stock' });
            item.quantity -= parsed.data.quantity;
        }
        else
            item.quantity += parsed.data.quantity;
        store_1.db.stockMovements.push({ id: (0, uuid_1.v4)(), item_id: item.id, type: parsed.data.type, quantity: parsed.data.quantity, timestamp: new Date().toISOString() });
        (0, store_1.addAudit)('InventoryItem', item.id, 'movement', before, item, actorId(req));
        return res.json(item);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
const transferSchema = zod_1.z.object({
    from_warehouse_id: zod_1.z.string().min(1),
    to_warehouse_id: zod_1.z.string().min(1),
    item_id: zod_1.z.string().min(1),
    quantity: zod_1.z.number().int().min(1),
    note: zod_1.z.string().optional(),
});
exports.router.post('/transfers', (0, auth_1.requirePerm)('inventory.move'), async (req, res) => {
    const parsed = transferSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    if (parsed.data.from_warehouse_id === parsed.data.to_warehouse_id)
        return res.status(400).json({ message: 'same warehouse' });
    try {
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            await ensureInventorySchema();
            const transferId = (0, uuid_1.v4)();
            const result = await (0, dbAdapter_1.pgRunInTransaction)(async (client) => {
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
                });
                if (!out.ok)
                    return out;
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
                });
                if (!inn.ok)
                    return inn;
                return { ok: true, transfer_id: transferId, from_stock: out.stock, to_stock: inn.stock };
            });
            if (!result)
                return res.status(500).json({ message: 'db not ready' });
            if (!result.ok)
                return res.status(result.code).json({ message: result.message });
            return res.json(result);
        }
        return res.status(501).json({ message: 'transfer not available without PG' });
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.get('/movements', (0, auth_1.requirePerm)('inventory.view'), async (req, res) => {
    try {
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            await ensureInventorySchema();
            const q = req.query || {};
            const wh = String(q.warehouse_id || '').trim();
            const item = String(q.item_id || '').trim();
            const prop = String(q.property_id || '').trim();
            const type = String(q.type || '').trim();
            const category = String(q.category || '').trim();
            const reason = String(q.reason || '').trim();
            const from = String(q.from || '').trim();
            const to = String(q.to || '').trim();
            const limit = Math.min(500, Math.max(1, Number(q.limit || 100)));
            const where = [];
            const values = [];
            if (wh) {
                values.push(wh);
                where.push(`m.warehouse_id = $${values.length}`);
            }
            if (item) {
                values.push(item);
                where.push(`m.item_id = $${values.length}`);
            }
            if (prop) {
                values.push(prop);
                where.push(`m.property_id = $${values.length}`);
            }
            if (type) {
                values.push(type);
                where.push(`m.type = $${values.length}`);
            }
            if (category) {
                values.push(category);
                where.push(`i.category = $${values.length}`);
            }
            if (reason) {
                values.push(reason);
                where.push(`m.reason = $${values.length}`);
            }
            if (from) {
                values.push(from);
                where.push(`m.created_at >= $${values.length}::timestamptz`);
            }
            if (to) {
                values.push(to);
                where.push(`m.created_at <= $${values.length}::timestamptz`);
            }
            values.push(limit);
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
      `;
            const rows = await dbAdapter_1.pgPool.query(sql, values);
            return res.json(rows.rows || []);
        }
        return res.json(store_1.db.stockMovements || []);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
async function ensureDailyNecessitiesSchema() {
    if (!dbAdapter_1.pgPool)
        return;
    await dbAdapter_1.pgPool.query(`CREATE TABLE IF NOT EXISTS property_daily_necessities (
    id text PRIMARY KEY,
    property_id text,
    created_by text,
    created_at timestamptz DEFAULT now()
  );`);
    await dbAdapter_1.pgPool.query('ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS property_code text;');
    await dbAdapter_1.pgPool.query('ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS status text;');
    await dbAdapter_1.pgPool.query('ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS item_name text;');
    await dbAdapter_1.pgPool.query('ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS quantity integer;');
    await dbAdapter_1.pgPool.query('ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS note text;');
    await dbAdapter_1.pgPool.query('ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS photo_urls jsonb;');
    await dbAdapter_1.pgPool.query('ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS source_task_id text;');
    await dbAdapter_1.pgPool.query('ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS submitted_at timestamptz;');
    await dbAdapter_1.pgPool.query('ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS submitter_name text;');
    await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_property_daily_necessities_prop ON property_daily_necessities(property_id);');
    await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_property_daily_necessities_status ON property_daily_necessities(status);');
    await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_property_daily_necessities_created_at ON property_daily_necessities(created_at);');
}
exports.router.get('/daily-replacements', (0, auth_1.requirePerm)('inventory.view'), async (req, res) => {
    try {
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            await ensureInventorySchema();
            await ensureDailyNecessitiesSchema();
            const q = req.query || {};
            const statusRaw = String(q.status || '').trim();
            const statuses = statusRaw
                ? statusRaw
                    .split(',')
                    .map((s) => String(s || '').trim())
                    .filter(Boolean)
                : [];
            const prop = String(q.property_id || '').trim();
            const code = String(q.property_code || '').trim();
            const from = String(q.from || '').trim();
            const to = String(q.to || '').trim();
            const limit = Math.min(500, Math.max(1, Number(q.limit || 100)));
            const where = [];
            const values = [];
            if (prop) {
                values.push(prop);
                where.push(`n.property_id = $${values.length}`);
            }
            if (code) {
                values.push(code);
                where.push(`COALESCE(n.property_code, p.code) = $${values.length}`);
            }
            if (statuses.length) {
                values.push(statuses);
                where.push(`COALESCE(n.status,'') = ANY($${values.length}::text[])`);
            }
            if (from) {
                values.push(from);
                where.push(`COALESCE(n.submitted_at, n.created_at) >= $${values.length}::timestamptz`);
            }
            if (to) {
                values.push(to);
                where.push(`COALESCE(n.submitted_at, n.created_at) <= $${values.length}::timestamptz`);
            }
            values.push(limit);
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
      `;
            const r = await dbAdapter_1.pgPool.query(sql, values);
            return res.json(r.rows || []);
        }
        return res.json([]);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.get('/suppliers', (0, auth_1.requirePerm)('inventory.po.manage'), async (req, res) => {
    try {
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            await ensureInventorySchema();
            const rows = await dbAdapter_1.pgPool.query(`SELECT id, name, kind, active FROM suppliers ORDER BY name ASC`);
            return res.json(rows.rows || []);
        }
        return res.json([]);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
const supplierSchema = zod_1.z.object({ name: zod_1.z.string().min(1), kind: zod_1.z.string().optional(), active: zod_1.z.boolean().optional() });
exports.router.post('/suppliers', (0, auth_1.requirePerm)('inventory.po.manage'), async (req, res) => {
    var _a, _b, _c;
    const parsed = supplierSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    try {
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            await ensureInventorySchema();
            const id = (0, uuid_1.v4)();
            const row = await dbAdapter_1.pgPool.query(`INSERT INTO suppliers (id, name, kind, active) VALUES ($1,$2,$3,$4) RETURNING *`, [id, parsed.data.name, parsed.data.kind || 'linen', (_a = parsed.data.active) !== null && _a !== void 0 ? _a : true]);
            (0, store_1.addAudit)('Supplier', id, 'create', null, ((_b = row.rows) === null || _b === void 0 ? void 0 : _b[0]) || null, actorId(req));
            return res.status(201).json(((_c = row.rows) === null || _c === void 0 ? void 0 : _c[0]) || null);
        }
        return res.status(501).json({ message: 'not available without PG' });
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.patch('/suppliers/:id', (0, auth_1.requirePerm)('inventory.po.manage'), async (req, res) => {
    var _a, _b, _c;
    const parsed = supplierSchema.partial().safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    const id = String(req.params.id || '');
    try {
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            await ensureInventorySchema();
            const before = await dbAdapter_1.pgPool.query(`SELECT * FROM suppliers WHERE id = $1`, [id]);
            const b = (_a = before.rows) === null || _a === void 0 ? void 0 : _a[0];
            if (!b)
                return res.status(404).json({ message: 'supplier not found' });
            const payload = parsed.data;
            const keys = Object.keys(payload).filter(k => payload[k] !== undefined);
            if (!keys.length)
                return res.json(b);
            const sets = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ');
            const values = keys.map(k => payload[k]);
            const sql = `UPDATE suppliers SET ${sets} WHERE id = $${keys.length + 1} RETURNING *`;
            const after = await dbAdapter_1.pgPool.query(sql, [...values, id]);
            (0, store_1.addAudit)('Supplier', id, 'update', b, ((_b = after.rows) === null || _b === void 0 ? void 0 : _b[0]) || null, actorId(req));
            return res.json(((_c = after.rows) === null || _c === void 0 ? void 0 : _c[0]) || null);
        }
        return res.status(501).json({ message: 'not available without PG' });
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.get('/region-supplier-rules', (0, auth_1.requirePerm)('inventory.po.manage'), async (req, res) => {
    try {
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            await ensureInventorySchema();
            const rows = await dbAdapter_1.pgPool.query(`SELECT r.*, s.name AS supplier_name
         FROM region_supplier_rules r
         JOIN suppliers s ON s.id = r.supplier_id
         ORDER BY r.region_key ASC, r.priority DESC`);
            return res.json(rows.rows || []);
        }
        return res.json([]);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
const regionRuleSchema = zod_1.z.object({
    region_key: zod_1.z.string().min(1),
    supplier_id: zod_1.z.string().min(1),
    priority: zod_1.z.number().int().optional(),
    active: zod_1.z.boolean().optional(),
});
exports.router.post('/region-supplier-rules', (0, auth_1.requirePerm)('inventory.po.manage'), async (req, res) => {
    var _a, _b, _c, _d;
    const parsed = regionRuleSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    try {
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            await ensureInventorySchema();
            const id = (0, uuid_1.v4)();
            const row = await dbAdapter_1.pgPool.query(`INSERT INTO region_supplier_rules (id, region_key, supplier_id, priority, active)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING *`, [id, parsed.data.region_key, parsed.data.supplier_id, (_a = parsed.data.priority) !== null && _a !== void 0 ? _a : 0, (_b = parsed.data.active) !== null && _b !== void 0 ? _b : true]);
            (0, store_1.addAudit)('RegionSupplierRule', id, 'create', null, ((_c = row.rows) === null || _c === void 0 ? void 0 : _c[0]) || null, actorId(req));
            return res.status(201).json(((_d = row.rows) === null || _d === void 0 ? void 0 : _d[0]) || null);
        }
        return res.status(501).json({ message: 'not available without PG' });
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.patch('/region-supplier-rules/:id', (0, auth_1.requirePerm)('inventory.po.manage'), async (req, res) => {
    var _a, _b, _c;
    const parsed = regionRuleSchema.partial().safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    const id = String(req.params.id || '');
    try {
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            await ensureInventorySchema();
            const before = await dbAdapter_1.pgPool.query(`SELECT * FROM region_supplier_rules WHERE id = $1`, [id]);
            const b = (_a = before.rows) === null || _a === void 0 ? void 0 : _a[0];
            if (!b)
                return res.status(404).json({ message: 'rule not found' });
            const payload = parsed.data;
            const keys = Object.keys(payload).filter(k => payload[k] !== undefined);
            if (!keys.length)
                return res.json(b);
            const sets = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ');
            const values = keys.map(k => payload[k]);
            const sql = `UPDATE region_supplier_rules SET ${sets} WHERE id = $${keys.length + 1} RETURNING *`;
            const after = await dbAdapter_1.pgPool.query(sql, [...values, id]);
            (0, store_1.addAudit)('RegionSupplierRule', id, 'update', b, ((_b = after.rows) === null || _b === void 0 ? void 0 : _b[0]) || null, actorId(req));
            return res.json(((_c = after.rows) === null || _c === void 0 ? void 0 : _c[0]) || null);
        }
        return res.status(501).json({ message: 'not available without PG' });
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
const poCreateSchema = zod_1.z.object({
    supplier_id: zod_1.z.string().optional(),
    warehouse_id: zod_1.z.string().min(1),
    property_id: zod_1.z.string().optional(),
    region: zod_1.z.string().optional(),
    requested_delivery_date: zod_1.z.string().optional(),
    note: zod_1.z.string().optional(),
    lines: zod_1.z.array(zod_1.z.object({
        item_id: zod_1.z.string().min(1),
        quantity: zod_1.z.number().int().min(1),
        unit: zod_1.z.string().optional(),
        unit_price: zod_1.z.number().optional(),
        note: zod_1.z.string().optional(),
    })).min(1),
});
exports.router.get('/purchase-orders', (0, auth_1.requirePerm)('inventory.po.manage'), async (req, res) => {
    try {
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            await ensureInventorySchema();
            const q = req.query || {};
            const status = String(q.status || '').trim();
            const supplier_id = String(q.supplier_id || '').trim();
            const warehouse_id = String(q.warehouse_id || '').trim();
            const where = [];
            const values = [];
            if (status) {
                values.push(status);
                where.push(`po.status = $${values.length}`);
            }
            if (supplier_id) {
                values.push(supplier_id);
                where.push(`po.supplier_id = $${values.length}`);
            }
            if (warehouse_id) {
                values.push(warehouse_id);
                where.push(`po.warehouse_id = $${values.length}`);
            }
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
      `;
            const rows = await dbAdapter_1.pgPool.query(sql, values);
            return res.json(rows.rows || []);
        }
        return res.json([]);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.post('/purchase-orders', (0, auth_1.requirePerm)('inventory.po.manage'), async (req, res) => {
    const parsed = poCreateSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureInventorySchema();
        const supplierIdExplicit = String(parsed.data.supplier_id || '').trim();
        const pool = dbAdapter_1.pgPool;
        if (!pool)
            throw new Error('db not ready');
        const supplierFromRegion = async () => {
            var _a, _b;
            const region = String(parsed.data.region || '').trim();
            if (region)
                return pickSupplierIdForRegion(region);
            const pid = String(parsed.data.property_id || '').trim();
            if (!pid)
                return null;
            const pr = await pool.query(`SELECT region FROM properties WHERE id = $1`, [pid]);
            const r = ((_b = (_a = pr.rows) === null || _a === void 0 ? void 0 : _a[0]) === null || _b === void 0 ? void 0 : _b.region) || null;
            return pickSupplierIdForRegion(r);
        };
        const supplier_id = supplierIdExplicit || (await supplierFromRegion());
        if (!supplier_id)
            return res.status(400).json({ message: '无法确定供应商，请手动选择 supplier_id' });
        const poId = (0, uuid_1.v4)();
        const created_by = actorId(req);
        const result = await (0, dbAdapter_1.pgRunInTransaction)(async (client) => {
            var _a, _b, _c, _d, _e;
            const poRow = await client.query(`INSERT INTO purchase_orders (id, supplier_id, warehouse_id, status, requested_delivery_date, note, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING *`, [
                poId,
                supplier_id,
                parsed.data.warehouse_id,
                'draft',
                parsed.data.requested_delivery_date ? parsed.data.requested_delivery_date : null,
                parsed.data.note || null,
                created_by,
            ]);
            const linesOut = [];
            for (const ln of parsed.data.lines) {
                const item = await client.query(`SELECT id, unit FROM inventory_items WHERE id = $1`, [ln.item_id]);
                const unit = ln.unit || ((_b = (_a = item.rows) === null || _a === void 0 ? void 0 : _a[0]) === null || _b === void 0 ? void 0 : _b.unit);
                if (!unit)
                    throw new Error('unit missing');
                const lineId = (0, uuid_1.v4)();
                const row = await client.query(`INSERT INTO purchase_order_lines (id, po_id, item_id, quantity, unit, unit_price, note)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           RETURNING *`, [lineId, poId, ln.item_id, ln.quantity, unit, (_c = ln.unit_price) !== null && _c !== void 0 ? _c : null, ln.note || null]);
                linesOut.push(((_d = row.rows) === null || _d === void 0 ? void 0 : _d[0]) || null);
            }
            return { po: ((_e = poRow.rows) === null || _e === void 0 ? void 0 : _e[0]) || null, lines: linesOut };
        });
        (0, store_1.addAudit)('PurchaseOrder', poId, 'create', null, result, actorId(req));
        return res.status(201).json(result);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.get('/purchase-orders/:id', (0, auth_1.requirePerm)('inventory.po.manage'), async (req, res) => {
    var _a;
    const id = String(req.params.id || '');
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureInventorySchema();
        const po = await dbAdapter_1.pgPool.query(`SELECT po.*, s.name AS supplier_name, w.name AS warehouse_name, w.code AS warehouse_code
       FROM purchase_orders po
       JOIN suppliers s ON s.id = po.supplier_id
       JOIN warehouses w ON w.id = po.warehouse_id
       WHERE po.id = $1`, [id]);
        if (!((_a = po.rows) === null || _a === void 0 ? void 0 : _a[0]))
            return res.status(404).json({ message: 'po not found' });
        const lines = await dbAdapter_1.pgPool.query(`SELECT l.*, i.name AS item_name, i.sku AS item_sku
       FROM purchase_order_lines l
       JOIN inventory_items i ON i.id = l.item_id
       WHERE l.po_id = $1
       ORDER BY i.name ASC`, [id]);
        const deliveries = await dbAdapter_1.pgPool.query(`SELECT d.* FROM purchase_deliveries d WHERE d.po_id = $1 ORDER BY d.received_at DESC`, [id]);
        return res.json({ po: po.rows[0], lines: lines.rows || [], deliveries: deliveries.rows || [] });
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
const poPatchSchema = zod_1.z.object({
    status: zod_1.z.enum(['draft', 'ordered', 'received', 'closed']).optional(),
    requested_delivery_date: zod_1.z.string().optional(),
    note: zod_1.z.string().optional(),
});
exports.router.patch('/purchase-orders/:id', (0, auth_1.requirePerm)('inventory.po.manage'), async (req, res) => {
    var _a, _b, _c;
    const parsed = poPatchSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    const id = String(req.params.id || '');
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureInventorySchema();
        const before = await dbAdapter_1.pgPool.query(`SELECT * FROM purchase_orders WHERE id = $1`, [id]);
        const b = (_a = before.rows) === null || _a === void 0 ? void 0 : _a[0];
        if (!b)
            return res.status(404).json({ message: 'po not found' });
        const payload = parsed.data;
        const keys = Object.keys(payload).filter(k => payload[k] !== undefined);
        if (!keys.length)
            return res.json(b);
        const sets = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ');
        const values = keys.map(k => payload[k]);
        const sql = `UPDATE purchase_orders SET ${sets}, updated_at = now() WHERE id = $${keys.length + 1} RETURNING *`;
        const after = await dbAdapter_1.pgPool.query(sql, [...values, id]);
        (0, store_1.addAudit)('PurchaseOrder', id, 'update', b, ((_b = after.rows) === null || _b === void 0 ? void 0 : _b[0]) || null, actorId(req));
        return res.json(((_c = after.rows) === null || _c === void 0 ? void 0 : _c[0]) || null);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.post('/purchase-orders/:id/export', (0, auth_1.requirePerm)('inventory.po.manage'), async (req, res) => {
    var _a, _b, _c;
    const id = String(req.params.id || '');
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureInventorySchema();
        const po = await dbAdapter_1.pgPool.query(`SELECT po.id, po.status, po.created_at, s.name AS supplier_name, w.name AS warehouse_name
       FROM purchase_orders po
       JOIN suppliers s ON s.id = po.supplier_id
       JOIN warehouses w ON w.id = po.warehouse_id
       WHERE po.id = $1`, [id]);
        if (!((_a = po.rows) === null || _a === void 0 ? void 0 : _a[0]))
            return res.status(404).json({ message: 'po not found' });
        const lines = await dbAdapter_1.pgPool.query(`SELECT i.name AS item_name, i.sku AS item_sku, l.quantity, l.unit, l.unit_price, l.note
       FROM purchase_order_lines l
       JOIN inventory_items i ON i.id = l.item_id
       WHERE l.po_id = $1
       ORDER BY i.name ASC`, [id]);
        const header = ['物料', 'SKU', '数量', '单位', '单价', '备注'];
        const esc = (v) => {
            const s = String(v !== null && v !== void 0 ? v : '');
            if (/[\",\n]/.test(s))
                return `"${s.replace(/\"/g, '""')}"`;
            return s;
        };
        const rows = [header.join(',')];
        for (const r of (lines.rows || [])) {
            rows.push([r.item_name, r.item_sku, r.quantity, r.unit, (_b = r.unit_price) !== null && _b !== void 0 ? _b : '', (_c = r.note) !== null && _c !== void 0 ? _c : ''].map(esc).join(','));
        }
        const csv = rows.join('\n');
        const filename = `PO_${esc(po.rows[0].supplier_name)}_${id}.csv`.replace(/[^\w\-.()]+/g, '_');
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        return res.send('\ufeff' + csv);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
const deliverySchema = zod_1.z.object({
    received_at: zod_1.z.string().optional(),
    note: zod_1.z.string().optional(),
    lines: zod_1.z.array(zod_1.z.object({ item_id: zod_1.z.string().min(1), quantity_received: zod_1.z.number().int().min(1), note: zod_1.z.string().optional() })).min(1),
});
exports.router.post('/purchase-orders/:id/deliveries', (0, auth_1.requirePerm)('inventory.po.manage'), async (req, res) => {
    var _a;
    const parsed = deliverySchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    const po_id = String(req.params.id || '');
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureInventorySchema();
        const result = await (0, dbAdapter_1.pgRunInTransaction)(async (client) => {
            var _a, _b, _c, _d;
            const po = await client.query(`SELECT * FROM purchase_orders WHERE id = $1`, [po_id]);
            const p = (_a = po.rows) === null || _a === void 0 ? void 0 : _a[0];
            if (!p)
                return { ok: false, code: 404, message: 'po not found' };
            const deliveryId = (0, uuid_1.v4)();
            const d = await client.query(`INSERT INTO purchase_deliveries (id, po_id, received_at, received_by, note)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING *`, [deliveryId, po_id, parsed.data.received_at ? parsed.data.received_at : null, actorId(req), parsed.data.note || null]);
            const lineRows = [];
            for (const ln of parsed.data.lines) {
                const dlId = (0, uuid_1.v4)();
                const row = await client.query(`INSERT INTO purchase_delivery_lines (id, delivery_id, item_id, quantity_received, note)
           VALUES ($1,$2,$3,$4,$5)
           RETURNING *`, [dlId, deliveryId, ln.item_id, ln.quantity_received, ln.note || null]);
                lineRows.push(((_b = row.rows) === null || _b === void 0 ? void 0 : _b[0]) || null);
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
                });
                if (!applied.ok)
                    return applied;
            }
            const poAfter = await client.query(`UPDATE purchase_orders SET status = $1, updated_at = now() WHERE id = $2 RETURNING *`, ['received', po_id]);
            return { ok: true, delivery: ((_c = d.rows) === null || _c === void 0 ? void 0 : _c[0]) || null, lines: lineRows, po: ((_d = poAfter.rows) === null || _d === void 0 ? void 0 : _d[0]) || null };
        });
        if (!(result === null || result === void 0 ? void 0 : result.ok))
            return res.status(result.code).json({ message: result.message });
        (0, store_1.addAudit)('PurchaseDelivery', ((_a = result === null || result === void 0 ? void 0 : result.delivery) === null || _a === void 0 ? void 0 : _a.id) || po_id, 'create', null, result, actorId(req));
        return res.status(201).json(result);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
