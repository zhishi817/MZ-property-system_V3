"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.router = void 0;
const express_1 = require("express");
const store_1 = require("../store");
const zod_1 = require("zod");
const auth_1 = require("../auth");
const dbAdapter_1 = require("../dbAdapter");
const uuid_1 = require("uuid");
const multer_1 = __importDefault(require("multer"));
const path_1 = __importDefault(require("path"));
const uploadImageResize_1 = require("../lib/uploadImageResize");
const r2_1 = require("../r2");
exports.router = (0, express_1.Router)();
const upload = (0, multer_1.default)({ storage: multer_1.default.memoryStorage() });
function actorId(req) {
    const u = (req === null || req === void 0 ? void 0 : req.user) || {};
    return (u === null || u === void 0 ? void 0 : u.sub) || (u === null || u === void 0 ? void 0 : u.username) || null;
}
function randomSuffix(len) {
    const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let s = '';
    for (let i = 0; i < len; i++)
        s += chars[Math.floor(Math.random() * chars.length)];
    return s;
}
function isSmWarehouseRow(row) {
    const id = String((row === null || row === void 0 ? void 0 : row.id) || '').trim().toLowerCase();
    const code = String((row === null || row === void 0 ? void 0 : row.code) || '').trim().toLowerCase();
    const name = String((row === null || row === void 0 ? void 0 : row.name) || '').trim().toLowerCase();
    return id === 'wh.south_melbourne' || code === 'sou' || name.includes('south melbourne');
}
function toDayStartIsoMelbourne(daysFromToday = 0) {
    const now = new Date();
    const utc = now.getTime() + now.getTimezoneOffset() * 60000;
    const mel = new Date(utc + 10 * 60 * 60000);
    mel.setHours(0, 0, 0, 0);
    mel.setDate(mel.getDate() + Number(daysFromToday || 0));
    return mel.toISOString();
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
      linen_capacity_sets integer,
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
        await dbAdapter_1.pgPool.query('ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS sub_type text;');
        await dbAdapter_1.pgPool.query('ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS linen_type_code text;');
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_inventory_items_category_sub_type ON inventory_items(category, sub_type);');
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_inventory_items_linen_type ON inventory_items(linen_type_code);');
        await dbAdapter_1.pgPool.query(`CREATE TABLE IF NOT EXISTS inventory_linen_types (
      code text PRIMARY KEY,
      name text NOT NULL,
      psl_code text,
      in_set boolean NOT NULL DEFAULT true,
      set_divisor integer NOT NULL DEFAULT 1,
      sort_order integer NOT NULL DEFAULT 0,
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz
    );`);
        await dbAdapter_1.pgPool.query('ALTER TABLE inventory_linen_types ADD COLUMN IF NOT EXISTS psl_code text;');
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_inventory_linen_types_active_sort ON inventory_linen_types(active, sort_order, code);');
        await dbAdapter_1.pgPool.query(`INSERT INTO inventory_linen_types (code, name, in_set, set_divisor, sort_order, active) VALUES
      ('bedsheet','床单',true,1,10,true),
      ('duvet_cover','被套',true,1,20,true),
      ('pillowcase','枕套',true,2,30,true),
      ('bath_towel','浴巾',true,1,40,true)
    ON CONFLICT (code) DO NOTHING;`);
        await dbAdapter_1.pgPool.query(`INSERT INTO inventory_items (id, name, sku, category, linen_type_code, unit, default_threshold, bin_location, active, is_key_item)
      VALUES
        ('item.linen_type.bedsheet','床单','LT:bedsheet','linen','bedsheet','pcs',0,NULL,true,false),
        ('item.linen_type.duvet_cover','被套','LT:duvet_cover','linen','duvet_cover','pcs',0,NULL,true,false),
        ('item.linen_type.pillowcase','枕套','LT:pillowcase','linen','pillowcase','pcs',0,NULL,true,false),
        ('item.linen_type.bath_towel','浴巾','LT:bath_towel','linen','bath_towel','pcs',0,NULL,true,false)
      ON CONFLICT (id) DO NOTHING;`);
        await dbAdapter_1.pgPool.query(`
      INSERT INTO inventory_items (id, name, sku, category, linen_type_code, unit, default_threshold, bin_location, active, is_key_item)
      SELECT
        'item.linen_type.' || lt.code AS id,
        lt.name,
        'LT:' || lt.code AS sku,
        'linen' AS category,
        lt.code AS linen_type_code,
        'pcs' AS unit,
        0 AS default_threshold,
        NULL AS bin_location,
        lt.active,
        false AS is_key_item
      FROM inventory_linen_types lt
      WHERE NOT EXISTS (
        SELECT 1
        FROM inventory_items i
        WHERE i.category = 'linen' AND i.linen_type_code = lt.code
      )
      ON CONFLICT (id) DO UPDATE
      SET name = EXCLUDED.name,
          active = EXCLUDED.active,
          linen_type_code = EXCLUDED.linen_type_code
    `);
        await dbAdapter_1.pgPool.query(`CREATE TABLE IF NOT EXISTS inventory_room_types (
      code text PRIMARY KEY,
      name text NOT NULL,
      bedrooms integer,
      bathrooms integer,
      sort_order integer NOT NULL DEFAULT 0,
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz
    );`);
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_inventory_room_types_active_sort ON inventory_room_types(active, sort_order, code);');
        await dbAdapter_1.pgPool.query(`INSERT INTO inventory_room_types (code, name, bedrooms, bathrooms, sort_order, active) VALUES
      ('1b1b','一房一卫',1,1,10,true),
      ('2b1b','两房一卫',2,1,20,true),
      ('2b2b','两房两卫',2,2,30,true),
      ('3b2b','三房两卫',3,2,40,true),
      ('3b3b','三房三卫',3,3,50,true)
    ON CONFLICT (code) DO NOTHING;`);
        await dbAdapter_1.pgPool.query(`CREATE TABLE IF NOT EXISTS inventory_room_type_requirements (
      room_type_code text NOT NULL REFERENCES inventory_room_types(code) ON DELETE CASCADE,
      linen_type_code text NOT NULL REFERENCES inventory_linen_types(code) ON DELETE RESTRICT,
      quantity integer NOT NULL,
      PRIMARY KEY (room_type_code, linen_type_code)
    );`);
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_inventory_room_type_req_room ON inventory_room_type_requirements(room_type_code);');
        await dbAdapter_1.pgPool.query('ALTER TABLE properties ADD COLUMN IF NOT EXISTS room_type_code text;');
        await dbAdapter_1.pgPool.query('ALTER TABLE properties ADD COLUMN IF NOT EXISTS linen_service_warehouse_id text;');
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_properties_room_type_code ON properties(room_type_code);');
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
        await dbAdapter_1.pgPool.query(`CREATE TABLE IF NOT EXISTS inventory_stock_policies (
      id text PRIMARY KEY,
      warehouse_id text NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      item_id text NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
      reserve_qty integer NOT NULL DEFAULT 0,
      updated_at timestamptz
    );`);
        await dbAdapter_1.pgPool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'unique_inventory_stock_policy') THEN
        ALTER TABLE inventory_stock_policies ADD CONSTRAINT unique_inventory_stock_policy UNIQUE (warehouse_id, item_id);
      END IF;
    END $$;`);
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_inventory_stock_policies_wh ON inventory_stock_policies(warehouse_id);');
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_inventory_stock_policies_item ON inventory_stock_policies(item_id);');
        await dbAdapter_1.pgPool.query(`CREATE TABLE IF NOT EXISTS suppliers (
      id text PRIMARY KEY,
      name text NOT NULL,
      kind text NOT NULL DEFAULT 'linen',
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now()
    );`);
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_suppliers_active ON suppliers(active);');
        await dbAdapter_1.pgPool.query(`CREATE TABLE IF NOT EXISTS supplier_item_prices (
      id text PRIMARY KEY,
      supplier_id text NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
      item_id text NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
      purchase_unit_price numeric NOT NULL DEFAULT 0,
      refund_unit_price numeric NOT NULL DEFAULT 0,
      effective_from date,
      active boolean NOT NULL DEFAULT true,
      updated_at timestamptz
    );`);
        await dbAdapter_1.pgPool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'unique_supplier_item_price') THEN
        ALTER TABLE supplier_item_prices ADD CONSTRAINT unique_supplier_item_price UNIQUE (supplier_id, item_id);
      END IF;
    END $$;`);
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_supplier_item_prices_supplier ON supplier_item_prices(supplier_id);');
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_supplier_item_prices_item ON supplier_item_prices(item_id);');
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
      po_no text,
      supplier_id text NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
      warehouse_id text NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
      status text NOT NULL DEFAULT 'draft',
      ordered_date date,
      requested_delivery_date date,
      region text,
      property_id text,
      note text,
      subtotal_amount numeric NOT NULL DEFAULT 0,
      gst_amount numeric NOT NULL DEFAULT 0,
      total_amount_inc_gst numeric NOT NULL DEFAULT 0,
      created_by text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz
    );`);
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_purchase_orders_supplier ON purchase_orders(supplier_id);');
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_purchase_orders_warehouse ON purchase_orders(warehouse_id);');
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_purchase_orders_status ON purchase_orders(status);');
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_purchase_orders_created_at ON purchase_orders(created_at);');
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_purchase_orders_region ON purchase_orders(region);');
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_purchase_orders_property ON purchase_orders(property_id);');
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_purchase_orders_ordered_date ON purchase_orders(ordered_date);');
        await dbAdapter_1.pgPool.query('ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS po_no text;');
        await dbAdapter_1.pgPool.query('ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS subtotal_amount numeric NOT NULL DEFAULT 0;');
        await dbAdapter_1.pgPool.query('ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS gst_amount numeric NOT NULL DEFAULT 0;');
        await dbAdapter_1.pgPool.query('ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS total_amount_inc_gst numeric NOT NULL DEFAULT 0;');
        await dbAdapter_1.pgPool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_purchase_orders_po_no_unique ON purchase_orders(po_no) WHERE po_no IS NOT NULL;');
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
        await dbAdapter_1.pgPool.query('ALTER TABLE purchase_order_lines ADD COLUMN IF NOT EXISTS amount_total numeric;');
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
      photo_url text,
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
        await dbAdapter_1.pgPool.query(`CREATE TABLE IF NOT EXISTS stock_change_requests (
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
    );`);
        await dbAdapter_1.pgPool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_change_requests_type_check') THEN
        ALTER TABLE stock_change_requests
          ADD CONSTRAINT stock_change_requests_type_check
          CHECK (type IN ('out'));
      END IF;
    END $$;`);
        await dbAdapter_1.pgPool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_change_requests_status_check') THEN
        ALTER TABLE stock_change_requests
          ADD CONSTRAINT stock_change_requests_status_check
          CHECK (status IN ('pending','approved','rejected'));
      END IF;
    END $$;`);
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_stock_change_requests_status ON stock_change_requests(status);');
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_stock_change_requests_reason ON stock_change_requests(reason);');
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_stock_change_requests_wh ON stock_change_requests(warehouse_id);');
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_stock_change_requests_item ON stock_change_requests(item_id);');
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_stock_change_requests_created_at ON stock_change_requests(created_at);');
        await dbAdapter_1.pgPool.query(`CREATE TABLE IF NOT EXISTS linen_delivery_plans (
      id text PRIMARY KEY,
      plan_date date NOT NULL,
      from_warehouse_id text NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
      date_from date,
      date_to date,
      vehicle_capacity_sets integer,
      status text NOT NULL DEFAULT 'draft',
      note text,
      created_by text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz
    );`);
        await dbAdapter_1.pgPool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'linen_delivery_plans_status_check') THEN
        ALTER TABLE linen_delivery_plans
          ADD CONSTRAINT linen_delivery_plans_status_check
          CHECK (status IN ('draft','planned','dispatched','cancelled'));
      END IF;
    END $$;`);
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_linen_delivery_plans_plan_date ON linen_delivery_plans(plan_date DESC);');
        await dbAdapter_1.pgPool.query(`CREATE TABLE IF NOT EXISTS linen_delivery_plan_lines (
      id text PRIMARY KEY,
      plan_id text NOT NULL REFERENCES linen_delivery_plans(id) ON DELETE CASCADE,
      to_warehouse_id text NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
      room_type_code text REFERENCES inventory_room_types(code) ON DELETE SET NULL,
      current_sets integer NOT NULL DEFAULT 0,
      demand_sets integer NOT NULL DEFAULT 0,
      target_sets integer NOT NULL DEFAULT 0,
      suggested_sets integer NOT NULL DEFAULT 0,
      actual_sets integer NOT NULL DEFAULT 0,
      warehouse_capacity_sets integer,
      vehicle_load_sets integer NOT NULL DEFAULT 0,
      note text
    );`);
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_linen_delivery_plan_lines_plan ON linen_delivery_plan_lines(plan_id);');
        await dbAdapter_1.pgPool.query(`CREATE TABLE IF NOT EXISTS linen_supplier_return_batches (
      id text PRIMARY KEY,
      supplier_id text NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
      warehouse_id text NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
      status text NOT NULL DEFAULT 'draft',
      returned_at timestamptz,
      note text,
      created_by text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz
    );`);
        await dbAdapter_1.pgPool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'linen_supplier_return_batches_status_check') THEN
        ALTER TABLE linen_supplier_return_batches
          ADD CONSTRAINT linen_supplier_return_batches_status_check
          CHECK (status IN ('draft','returned','settled'));
      END IF;
    END $$;`);
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_linen_supplier_return_batches_supplier ON linen_supplier_return_batches(supplier_id);');
        await dbAdapter_1.pgPool.query(`CREATE TABLE IF NOT EXISTS linen_supplier_return_batch_lines (
      id text PRIMARY KEY,
      batch_id text NOT NULL REFERENCES linen_supplier_return_batches(id) ON DELETE CASCADE,
      item_id text NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
      quantity integer NOT NULL,
      refund_unit_price numeric NOT NULL DEFAULT 0,
      amount_total numeric NOT NULL DEFAULT 0,
      note text
    );`);
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_linen_supplier_return_batch_lines_batch ON linen_supplier_return_batch_lines(batch_id);');
        await dbAdapter_1.pgPool.query(`CREATE TABLE IF NOT EXISTS linen_supplier_refunds (
      id text PRIMARY KEY,
      batch_id text NOT NULL REFERENCES linen_supplier_return_batches(id) ON DELETE CASCADE,
      supplier_id text NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
      warehouse_id text NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
      expected_amount numeric NOT NULL DEFAULT 0,
      received_amount numeric NOT NULL DEFAULT 0,
      variance_amount numeric NOT NULL DEFAULT 0,
      status text NOT NULL DEFAULT 'pending',
      received_at timestamptz,
      note text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz
    );`);
        await dbAdapter_1.pgPool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'linen_supplier_refunds_status_check') THEN
        ALTER TABLE linen_supplier_refunds
          ADD CONSTRAINT linen_supplier_refunds_status_check
          CHECK (status IN ('pending','partial','settled','disputed'));
      END IF;
    END $$;`);
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_linen_supplier_refunds_supplier ON linen_supplier_refunds(supplier_id);');
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_linen_supplier_refunds_status ON linen_supplier_refunds(status);');
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
        await dbAdapter_1.pgPool.query(`UPDATE warehouses
      SET linen_capacity_sets = CASE
        WHEN id = 'wh.south_melbourne' THEN COALESCE(linen_capacity_sets, 500)
        WHEN id = 'wh.msq' THEN COALESCE(linen_capacity_sets, 120)
        WHEN id = 'wh.wsp' THEN COALESCE(linen_capacity_sets, 120)
        WHEN id = 'wh.my80' THEN COALESCE(linen_capacity_sets, 100)
        ELSE linen_capacity_sets
      END;`);
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
async function ensurePurchaseOrderNo(client, rowOrId) {
    const id = typeof rowOrId === 'string' ? String(rowOrId) : String((rowOrId === null || rowOrId === void 0 ? void 0 : rowOrId.id) || '');
    if (!id)
        return null;
    const current = typeof rowOrId === 'object' ? String((rowOrId === null || rowOrId === void 0 ? void 0 : rowOrId.po_no) || '').trim() : '';
    if (current)
        return current;
    let date = typeof rowOrId === 'object'
        ? String((rowOrId === null || rowOrId === void 0 ? void 0 : rowOrId.ordered_date) || (rowOrId === null || rowOrId === void 0 ? void 0 : rowOrId.created_at) || '').slice(0, 10)
        : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
        date = new Date().toISOString().slice(0, 10);
    const base = date.replace(/-/g, '').slice(2);
    const prefix = `PO-${base}-`;
    let candidate = `${prefix}${randomSuffix(4)}`;
    for (let i = 0; i < 8; i++) {
        const chk = await client.query('SELECT 1 FROM purchase_orders WHERE po_no = $1 LIMIT 1', [candidate]);
        if (!chk.rowCount)
            break;
        candidate = `${prefix}${randomSuffix(4 + Math.min(i, 2))}`;
    }
    await client.query(`UPDATE purchase_orders SET po_no = $1 WHERE id = $2 AND COALESCE(po_no, '') = ''`, [candidate, id]);
    return candidate;
}
async function ensureLinenInventoryItem(client, linenTypeCode) {
    var _a, _b, _c, _d;
    const code = String(linenTypeCode || '').trim();
    if (!code)
        return null;
    const existing = await client.query(`SELECT id, name, sku, linen_type_code
     FROM inventory_items
     WHERE category = 'linen' AND linen_type_code = $1
     ORDER BY active DESC, name ASC, id ASC
     LIMIT 1`, [code]);
    if ((_b = (_a = existing.rows) === null || _a === void 0 ? void 0 : _a[0]) === null || _b === void 0 ? void 0 : _b.id)
        return existing.rows[0];
    const linenType = await client.query(`SELECT code, name, active
     FROM inventory_linen_types
     WHERE code = $1
     LIMIT 1`, [code]);
    const row = (_c = linenType.rows) === null || _c === void 0 ? void 0 : _c[0];
    if (!row)
        return null;
    const itemId = `item.linen_type.${code}`;
    const inserted = await client.query(`INSERT INTO inventory_items (id, name, sku, category, linen_type_code, unit, default_threshold, bin_location, active, is_key_item)
     VALUES ($1,$2,$3,'linen',$4,'pcs',0,NULL,$5,false)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, active = EXCLUDED.active, linen_type_code = EXCLUDED.linen_type_code
     RETURNING id, name, sku, linen_type_code`, [itemId, row.name, `LT:${code}`, code, row.active]);
    return ((_d = inserted.rows) === null || _d === void 0 ? void 0 : _d[0]) || null;
}
async function getSmWarehouse() {
    if (!dbAdapter_1.pgPool)
        return null;
    const rows = await dbAdapter_1.pgPool.query(`SELECT id, code, name, linen_capacity_sets FROM warehouses ORDER BY code ASC`);
    const list = rows.rows || [];
    return list.find((r) => isSmWarehouseRow(r)) || list[0] || null;
}
async function getActiveLinenTypes(client) {
    const rows = await client.query(`SELECT code, name, in_set, set_divisor, sort_order
     FROM inventory_linen_types
     WHERE active = true
     ORDER BY sort_order ASC, code ASC`);
    return rows.rows || [];
}
async function getRoomTypeRequirementMaps(client) {
    const [roomTypesRows, reqRows] = await Promise.all([
        client.query(`SELECT code, name, sort_order
       FROM inventory_room_types
       WHERE active = true
       ORDER BY sort_order ASC, code ASC`),
        client.query(`SELECT room_type_code, linen_type_code, quantity FROM inventory_room_type_requirements`),
    ]);
    const roomTypes = roomTypesRows.rows || [];
    const reqMap = new Map();
    for (const r of reqRows.rows || []) {
        const roomTypeCode = String(r.room_type_code || '');
        const linenTypeCode = String(r.linen_type_code || '');
        const quantity = Number(r.quantity || 0);
        if (!roomTypeCode || !linenTypeCode || quantity <= 0)
            continue;
        if (!reqMap.has(roomTypeCode))
            reqMap.set(roomTypeCode, new Map());
        reqMap.get(roomTypeCode).set(linenTypeCode, quantity);
    }
    return { roomTypes, reqMap };
}
function computeSetsForRoomType(countsByLinenType, requirements) {
    if (!requirements || !requirements.size)
        return 0;
    const candidates = [];
    for (const [linenTypeCode, quantity] of requirements.entries()) {
        const stockQty = Number(countsByLinenType[linenTypeCode] || 0);
        candidates.push(Math.floor(stockQty / Math.max(1, quantity)));
    }
    return candidates.length ? Math.max(0, Math.min(...candidates)) : 0;
}
function resolveWarehouseForProperty(property, warehouses) {
    const explicit = String((property === null || property === void 0 ? void 0 : property.linen_service_warehouse_id) || '').trim();
    if (explicit)
        return explicit;
    const region = String((property === null || property === void 0 ? void 0 : property.region) || '').trim().toLowerCase();
    if (!region)
        return null;
    const found = (warehouses || []).find((w) => {
        const code = String(w.code || '').trim().toLowerCase();
        const name = String(w.name || '').trim().toLowerCase();
        return code === region || name === region || name.includes(region) || region.includes(code);
    });
    return found ? String(found.id) : null;
}
async function getLinenReserveMap(client, warehouseId) {
    const rows = await client.query(`SELECT item_id, reserve_qty
     FROM inventory_stock_policies
     WHERE warehouse_id = $1`, [warehouseId]);
    return new Map((rows.rows || []).map((r) => [String(r.item_id), Number(r.reserve_qty || 0)]));
}
async function getLatestSupplierItemPrice(client, supplierId) {
    const rows = await client.query(`SELECT sip.id, sip.supplier_id, sip.item_id, sip.purchase_unit_price, sip.refund_unit_price, sip.effective_from, sip.active,
            i.name AS item_name, i.sku AS item_sku, i.linen_type_code
     FROM supplier_item_prices sip
     JOIN inventory_items i ON i.id = sip.item_id
     WHERE sip.supplier_id = $1
       AND sip.active = true
     ORDER BY COALESCE(sip.effective_from, DATE '1970-01-01') DESC, sip.updated_at DESC NULLS LAST, sip.id DESC`, [supplierId]);
    const out = new Map();
    for (const row of rows.rows || []) {
        const itemId = String(row.item_id || '');
        if (!itemId || out.has(itemId))
            continue;
        out.set(itemId, row);
    }
    return out;
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
    await client.query(`INSERT INTO stock_movements (id, warehouse_id, item_id, type, reason, quantity, property_id, ref_type, ref_id, actor_id, note, photo_url)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [
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
    ]);
    const after = await client.query(`SELECT * FROM warehouse_stocks WHERE id = $1`, [row.id]);
    return { ok: true, stock: ((_b = after.rows) === null || _b === void 0 ? void 0 : _b[0]) || null, movement_id: moveId };
}
exports.router.get('/warehouses', (0, auth_1.requirePerm)('inventory.view'), async (req, res) => {
    try {
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            await ensureInventorySchema();
            const rows = await dbAdapter_1.pgPool.query(`SELECT id, code, name, linen_capacity_sets, active FROM warehouses ORDER BY code ASC`);
            return res.json(rows.rows || []);
        }
        return res.json([
            { id: 'wh.south_melbourne', code: 'SOU', name: 'South Melbourne', linen_capacity_sets: 500, active: true },
            { id: 'wh.msq', code: 'MSQ', name: 'MSQ', linen_capacity_sets: 120, active: true },
            { id: 'wh.wsp', code: 'WSP', name: 'WSP', linen_capacity_sets: 120, active: true },
            { id: 'wh.my80', code: 'MY80', name: 'My80', linen_capacity_sets: 100, active: true },
        ]);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
const linenTypeSchema = zod_1.z.object({
    code: zod_1.z.string().min(1),
    name: zod_1.z.string().min(1),
    psl_code: zod_1.z.string().optional(),
    in_set: zod_1.z.boolean().optional(),
    set_divisor: zod_1.z.number().int().min(1).optional(),
    sort_order: zod_1.z.number().int().optional(),
    active: zod_1.z.boolean().optional(),
});
exports.router.get('/linen-types', (0, auth_1.requirePerm)('inventory.view'), async (req, res) => {
    try {
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            await ensureInventorySchema();
            const rows = await dbAdapter_1.pgPool.query(`
        SELECT lt.code,
               lt.name,
               lt.psl_code,
               lt.in_set,
               lt.set_divisor,
               lt.sort_order,
               lt.active,
               (
                 SELECT i.id
                 FROM inventory_items i
                 WHERE i.category = 'linen' AND i.linen_type_code = lt.code
                 ORDER BY i.active DESC, i.name ASC, i.id ASC
                 LIMIT 1
               ) AS item_id
        FROM inventory_linen_types lt
        ORDER BY lt.active DESC, lt.sort_order ASC, lt.code ASC
      `);
            return res.json(rows.rows || []);
        }
        return res.json([]);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.post('/linen-types', (0, auth_1.requirePerm)('inventory.item.manage'), async (req, res) => {
    var _a, _b, _c, _d, _e, _f, _g, _h;
    const parsed = linenTypeSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureInventorySchema();
        const v = parsed.data;
        const row = await dbAdapter_1.pgPool.query(`INSERT INTO inventory_linen_types (code, name, psl_code, in_set, set_divisor, sort_order, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING code, name, psl_code, in_set, set_divisor, sort_order, active`, [v.code, v.name, (_a = v.psl_code) !== null && _a !== void 0 ? _a : null, (_b = v.in_set) !== null && _b !== void 0 ? _b : true, (_c = v.set_divisor) !== null && _c !== void 0 ? _c : 1, (_d = v.sort_order) !== null && _d !== void 0 ? _d : 0, (_e = v.active) !== null && _e !== void 0 ? _e : true]);
        const itemId = `item.linen_type.${v.code}`;
        await dbAdapter_1.pgPool.query(`INSERT INTO inventory_items (id, name, sku, category, linen_type_code, unit, default_threshold, bin_location, active, is_key_item)
       VALUES ($1,$2,$3,'linen',$4,'pcs',0,NULL,$5,false)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, active = EXCLUDED.active, linen_type_code = EXCLUDED.linen_type_code`, [itemId, v.name, `LT:${v.code}`, v.code, (_f = v.active) !== null && _f !== void 0 ? _f : true]);
        (0, store_1.addAudit)('InventoryLinenType', v.code, 'create', null, ((_g = row.rows) === null || _g === void 0 ? void 0 : _g[0]) || null, actorId(req));
        return res.status(201).json(((_h = row.rows) === null || _h === void 0 ? void 0 : _h[0]) || null);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.patch('/linen-types/:code', (0, auth_1.requirePerm)('inventory.item.manage'), async (req, res) => {
    var _a, _b, _c, _d;
    const code = String(req.params.code || '').trim();
    const parsed = linenTypeSchema.partial().safeParse({ ...req.body, code });
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureInventorySchema();
        const before = await dbAdapter_1.pgPool.query(`SELECT * FROM inventory_linen_types WHERE code = $1`, [code]);
        const b = (_a = before.rows) === null || _a === void 0 ? void 0 : _a[0];
        if (!b)
            return res.status(404).json({ message: 'not found' });
        const payload = parsed.data;
        const keys = Object.keys(payload).filter(k => payload[k] !== undefined && k !== 'code');
        if (!keys.length)
            return res.json(b);
        const sets = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ');
        const values = keys.map(k => payload[k]);
        const sql = `UPDATE inventory_linen_types SET ${sets}, updated_at = now() WHERE code = $${keys.length + 1} RETURNING code, name, psl_code, in_set, set_divisor, sort_order, active`;
        const after = await dbAdapter_1.pgPool.query(sql, [...values, code]);
        const a = (_b = after.rows) === null || _b === void 0 ? void 0 : _b[0];
        if (a) {
            const itemId = `item.linen_type.${code}`;
            await dbAdapter_1.pgPool.query(`INSERT INTO inventory_items (id, name, sku, category, linen_type_code, unit, default_threshold, bin_location, active, is_key_item)
         VALUES ($1,$2,$3,'linen',$4,'pcs',0,NULL,$5,false)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, active = EXCLUDED.active, linen_type_code = EXCLUDED.linen_type_code`, [itemId, a.name, `LT:${code}`, code, a.active]);
        }
        (0, store_1.addAudit)('InventoryLinenType', code, 'update', b, ((_c = after.rows) === null || _c === void 0 ? void 0 : _c[0]) || null, actorId(req));
        return res.json(((_d = after.rows) === null || _d === void 0 ? void 0 : _d[0]) || null);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.delete('/linen-types/:code', (0, auth_1.requirePerm)('inventory.item.manage'), async (req, res) => {
    var _a;
    const code = String(req.params.code || '').trim();
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureInventorySchema();
        const itemId = `item.linen_type.${code}`;
        const used1 = await dbAdapter_1.pgPool.query(`SELECT 1 FROM warehouse_stocks WHERE item_id = $1 LIMIT 1`, [itemId]);
        if ((used1.rows || []).length)
            return res.status(409).json({ message: '该类型已有库存记录，无法删除' });
        const used2 = await dbAdapter_1.pgPool.query(`SELECT 1 FROM stock_movements WHERE item_id = $1 LIMIT 1`, [itemId]);
        if ((used2.rows || []).length)
            return res.status(409).json({ message: '该类型已有流水记录，无法删除' });
        const used3 = await dbAdapter_1.pgPool.query(`SELECT 1 FROM purchase_order_lines WHERE item_id = $1 LIMIT 1`, [itemId]);
        if ((used3.rows || []).length)
            return res.status(409).json({ message: '该类型已有采购记录，无法删除' });
        const before = await dbAdapter_1.pgPool.query(`SELECT * FROM inventory_linen_types WHERE code = $1`, [code]);
        const b = ((_a = before.rows) === null || _a === void 0 ? void 0 : _a[0]) || null;
        await (0, dbAdapter_1.pgRunInTransaction)(async (client) => {
            await client.query(`DELETE FROM inventory_linen_types WHERE code = $1`, [code]);
            await client.query(`DELETE FROM inventory_items WHERE id = $1`, [itemId]);
            return { ok: true };
        });
        (0, store_1.addAudit)('InventoryLinenType', code, 'delete', b, null, actorId(req));
        return res.json({ ok: true });
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
const roomTypeSchema = zod_1.z.object({
    code: zod_1.z.string().min(1),
    name: zod_1.z.string().min(1),
    bedrooms: zod_1.z.number().int().min(0).optional(),
    bathrooms: zod_1.z.number().int().min(0).optional(),
    sort_order: zod_1.z.number().int().optional(),
    active: zod_1.z.boolean().optional(),
});
exports.router.get('/room-types', (0, auth_1.requirePerm)('inventory.view'), async (req, res) => {
    try {
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            await ensureInventorySchema();
            const rows = await dbAdapter_1.pgPool.query(`SELECT code, name, bedrooms, bathrooms, sort_order, active FROM inventory_room_types ORDER BY active DESC, sort_order ASC, code ASC`);
            return res.json(rows.rows || []);
        }
        return res.json([]);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.post('/room-types', (0, auth_1.requirePerm)('inventory.item.manage'), async (req, res) => {
    var _a, _b, _c, _d, _e, _f;
    const parsed = roomTypeSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureInventorySchema();
        const v = parsed.data;
        const row = await dbAdapter_1.pgPool.query(`INSERT INTO inventory_room_types (code, name, bedrooms, bathrooms, sort_order, active)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING code, name, bedrooms, bathrooms, sort_order, active`, [v.code, v.name, (_a = v.bedrooms) !== null && _a !== void 0 ? _a : null, (_b = v.bathrooms) !== null && _b !== void 0 ? _b : null, (_c = v.sort_order) !== null && _c !== void 0 ? _c : 0, (_d = v.active) !== null && _d !== void 0 ? _d : true]);
        (0, store_1.addAudit)('InventoryRoomType', v.code, 'create', null, ((_e = row.rows) === null || _e === void 0 ? void 0 : _e[0]) || null, actorId(req));
        return res.status(201).json(((_f = row.rows) === null || _f === void 0 ? void 0 : _f[0]) || null);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.patch('/room-types/:code', (0, auth_1.requirePerm)('inventory.item.manage'), async (req, res) => {
    var _a, _b, _c;
    const code = String(req.params.code || '').trim();
    const parsed = roomTypeSchema.partial().safeParse({ ...req.body, code });
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureInventorySchema();
        const before = await dbAdapter_1.pgPool.query(`SELECT * FROM inventory_room_types WHERE code = $1`, [code]);
        const b = (_a = before.rows) === null || _a === void 0 ? void 0 : _a[0];
        if (!b)
            return res.status(404).json({ message: 'not found' });
        const payload = parsed.data;
        const keys = Object.keys(payload).filter(k => payload[k] !== undefined && k !== 'code');
        if (!keys.length)
            return res.json(b);
        const sets = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ');
        const values = keys.map(k => payload[k]);
        const sql = `UPDATE inventory_room_types SET ${sets}, updated_at = now() WHERE code = $${keys.length + 1} RETURNING code, name, bedrooms, bathrooms, sort_order, active`;
        const after = await dbAdapter_1.pgPool.query(sql, [...values, code]);
        (0, store_1.addAudit)('InventoryRoomType', code, 'update', b, ((_b = after.rows) === null || _b === void 0 ? void 0 : _b[0]) || null, actorId(req));
        return res.json(((_c = after.rows) === null || _c === void 0 ? void 0 : _c[0]) || null);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.delete('/room-types/:code', (0, auth_1.requirePerm)('inventory.item.manage'), async (req, res) => {
    var _a;
    const code = String(req.params.code || '').trim();
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureInventorySchema();
        const used1 = await dbAdapter_1.pgPool.query(`SELECT 1 FROM inventory_room_type_requirements WHERE room_type_code = $1 LIMIT 1`, [code]);
        if ((used1.rows || []).length)
            return res.status(409).json({ message: '该房型已有占用配置，无法删除' });
        const used2 = await dbAdapter_1.pgPool.query(`SELECT 1 FROM properties WHERE room_type_code = $1 LIMIT 1`, [code]);
        if ((used2.rows || []).length)
            return res.status(409).json({ message: '该房型已被房源使用，无法删除' });
        const before = await dbAdapter_1.pgPool.query(`SELECT * FROM inventory_room_types WHERE code = $1`, [code]);
        const b = ((_a = before.rows) === null || _a === void 0 ? void 0 : _a[0]) || null;
        await dbAdapter_1.pgPool.query(`DELETE FROM inventory_room_types WHERE code = $1`, [code]);
        (0, store_1.addAudit)('InventoryRoomType', code, 'delete', b, null, actorId(req));
        return res.json({ ok: true });
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.get('/room-types/:code/requirements', (0, auth_1.requirePerm)('inventory.view'), async (req, res) => {
    var _a;
    const code = String(req.params.code || '').trim();
    try {
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            await ensureInventorySchema();
            const [rt, reqs, types] = await Promise.all([
                dbAdapter_1.pgPool.query(`SELECT code, name, bedrooms, bathrooms, sort_order, active FROM inventory_room_types WHERE code = $1`, [code]),
                dbAdapter_1.pgPool.query(`SELECT linen_type_code, quantity FROM inventory_room_type_requirements WHERE room_type_code = $1`, [code]),
                dbAdapter_1.pgPool.query(`SELECT code, name, sort_order, active FROM inventory_linen_types WHERE active = true ORDER BY sort_order ASC, code ASC`),
            ]);
            const roomType = ((_a = rt.rows) === null || _a === void 0 ? void 0 : _a[0]) || null;
            if (!roomType)
                return res.status(404).json({ message: 'not found' });
            const map = new Map((reqs.rows || []).map((r) => [String(r.linen_type_code), Number(r.quantity || 0)]));
            const out = (types.rows || []).map((t) => ({
                linen_type_code: String(t.code),
                linen_type_name: String(t.name),
                quantity: Number(map.get(String(t.code)) || 0),
            }));
            return res.json({ room_type: roomType, requirements: out });
        }
        return res.json({ room_type: null, requirements: [] });
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
const roomTypeRequirementsSchema = zod_1.z.object({
    requirements: zod_1.z.array(zod_1.z.object({
        linen_type_code: zod_1.z.string().min(1),
        quantity: zod_1.z.number().int().min(0),
    })),
});
exports.router.put('/room-types/:code/requirements', (0, auth_1.requirePerm)('inventory.item.manage'), async (req, res) => {
    var _a;
    const code = String(req.params.code || '').trim();
    const parsed = roomTypeRequirementsSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureInventorySchema();
        const rt = await dbAdapter_1.pgPool.query(`SELECT * FROM inventory_room_types WHERE code = $1`, [code]);
        const roomType = (_a = rt.rows) === null || _a === void 0 ? void 0 : _a[0];
        if (!roomType)
            return res.status(404).json({ message: 'not found' });
        const next = (parsed.data.requirements || []).map((r) => ({ linen_type_code: String(r.linen_type_code), quantity: Number(r.quantity || 0) }));
        const nextMap = new Map(next.map((r) => [r.linen_type_code, r.quantity]));
        const old = await dbAdapter_1.pgPool.query(`SELECT linen_type_code, quantity FROM inventory_room_type_requirements WHERE room_type_code = $1`, [code]);
        const oldRows = old.rows || [];
        const oldMap = new Map(oldRows.map((r) => [String(r.linen_type_code), Number(r.quantity || 0)]));
        await (0, dbAdapter_1.pgRunInTransaction)(async (client) => {
            for (const [k] of oldMap.entries()) {
                if (!nextMap.has(k))
                    await client.query(`DELETE FROM inventory_room_type_requirements WHERE room_type_code = $1 AND linen_type_code = $2`, [code, k]);
            }
            for (const [k, qty] of nextMap.entries()) {
                if (qty <= 0) {
                    await client.query(`DELETE FROM inventory_room_type_requirements WHERE room_type_code = $1 AND linen_type_code = $2`, [code, k]);
                }
                else {
                    await client.query(`INSERT INTO inventory_room_type_requirements (room_type_code, linen_type_code, quantity)
             VALUES ($1,$2,$3)
             ON CONFLICT (room_type_code, linen_type_code)
             DO UPDATE SET quantity = EXCLUDED.quantity`, [code, k, qty]);
                }
            }
            return { ok: true };
        });
        (0, store_1.addAudit)('InventoryRoomType', code, 'update_requirements', { requirements: oldRows }, { requirements: next }, actorId(req));
        return res.json({ ok: true });
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.get('/items', (0, auth_1.requirePerm)('inventory.view'), async (req, res) => {
    var _a, _b, _c, _d;
    try {
        const q = String(((_a = req.query) === null || _a === void 0 ? void 0 : _a.q) || '').trim();
        const category = String(((_b = req.query) === null || _b === void 0 ? void 0 : _b.category) || '').trim();
        const active = String(((_c = req.query) === null || _c === void 0 ? void 0 : _c.active) || '').trim().toLowerCase();
        const linenTypeCode = String(((_d = req.query) === null || _d === void 0 ? void 0 : _d.linen_type_code) || '').trim();
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            await ensureInventorySchema();
            const where = [];
            const values = [];
            const linenAlias = category === 'linen' ? 'i' : '';
            const col = (name) => linenAlias ? `${linenAlias}.${name}` : name;
            if (q) {
                values.push(`%${q}%`);
                values.push(`%${q}%`);
                where.push(`(${col('name')} ILIKE $${values.length - 1} OR ${col('sku')} ILIKE $${values.length})`);
            }
            if (category) {
                values.push(category);
                where.push(`${col('category')} = $${values.length}`);
            }
            if (active === 'true' || active === 'false') {
                values.push(active === 'true');
                where.push(`${col('active')} = $${values.length}`);
            }
            if (linenTypeCode) {
                values.push(linenTypeCode);
                where.push(`${col('linen_type_code')} = $${values.length}`);
            }
            const sql = category === 'linen'
                ? `SELECT i.id, i.name, i.sku, i.category, i.sub_type, i.linen_type_code, i.unit, i.default_threshold, i.bin_location, i.active, i.is_key_item
             FROM inventory_items i
             LEFT JOIN inventory_linen_types lt ON lt.code = i.linen_type_code
             ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
             ORDER BY COALESCE(lt.sort_order, 9999) ASC, COALESCE(lt.code, i.linen_type_code, i.name) ASC, i.name ASC`
                : `SELECT id, name, sku, category, sub_type, linen_type_code, unit, default_threshold, bin_location, active, is_key_item
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
    sub_type: zod_1.z.string().optional(),
    linen_type_code: zod_1.z.string().optional(),
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
                sub_type: parsed.data.sub_type || null,
                linen_type_code: parsed.data.linen_type_code || null,
                unit: parsed.data.unit,
                default_threshold: (_a = parsed.data.default_threshold) !== null && _a !== void 0 ? _a : 0,
                bin_location: parsed.data.bin_location || null,
                active: (_b = parsed.data.active) !== null && _b !== void 0 ? _b : true,
                is_key_item: (_c = parsed.data.is_key_item) !== null && _c !== void 0 ? _c : false,
            };
            const row = await dbAdapter_1.pgPool.query(`INSERT INTO inventory_items (id, name, sku, category, sub_type, linen_type_code, unit, default_threshold, bin_location, active, is_key_item)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING *`, [item.id, item.name, item.sku, item.category, item.sub_type, item.linen_type_code, item.unit, item.default_threshold, item.bin_location, item.active, item.is_key_item]);
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
    var _a, _b, _c, _d;
    const warehouse_id = String(((_a = req.query) === null || _a === void 0 ? void 0 : _a.warehouse_id) || '').trim();
    if (!warehouse_id)
        return res.status(400).json({ message: 'warehouse_id required' });
    const warningsOnly = String(((_b = req.query) === null || _b === void 0 ? void 0 : _b.warnings_only) || '').toLowerCase() === 'true';
    const keyOnly = String(((_c = req.query) === null || _c === void 0 ? void 0 : _c.key_only) || '').toLowerCase() === 'true';
    const category = String(((_d = req.query) === null || _d === void 0 ? void 0 : _d.category) || '').trim();
    try {
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            await ensureInventorySchema();
            if (category) {
                const itemVals = [category];
                let itemSql = category === 'linen'
                    ? `SELECT i.id, i.name, i.sku, i.category, i.sub_type, i.linen_type_code, i.unit, i.default_threshold, i.bin_location, i.active, i.is_key_item, lt.sort_order
               FROM inventory_items i
               LEFT JOIN inventory_linen_types lt ON lt.code = i.linen_type_code
               WHERE i.category = $1`
                    : `SELECT id, name, sku, category, sub_type, linen_type_code, unit, default_threshold, bin_location, active, is_key_item
               FROM inventory_items
               WHERE category = $1`;
                if (keyOnly)
                    itemSql += ` AND is_key_item = true`;
                itemSql += category === 'linen'
                    ? ` ORDER BY COALESCE(lt.sort_order, 9999) ASC, COALESCE(lt.code, i.linen_type_code, i.name) ASC, i.name ASC`
                    : ` ORDER BY name ASC`;
                const items = await dbAdapter_1.pgPool.query(itemSql, itemVals);
                const itemRows = items.rows || [];
                if (!itemRows.length)
                    return res.json([]);
                const itemMap = new Map(itemRows.map((r) => [String(r.id), r]));
                const ids = itemRows.map((r) => String(r.id));
                const stocks = await dbAdapter_1.pgPool.query(`SELECT id, warehouse_id, item_id, quantity, threshold
           FROM warehouse_stocks
           WHERE warehouse_id = $1 AND item_id = ANY($2::text[])
           ORDER BY item_id ASC`, [warehouse_id, ids]);
                let out = (stocks.rows || []).map((s) => {
                    const it = itemMap.get(String(s.item_id)) || {};
                    const eff = s.threshold === null || s.threshold === undefined ? Number(it.default_threshold || 0) : Number(s.threshold || 0);
                    return {
                        ...s,
                        name: it.name,
                        sku: it.sku,
                        category: it.category,
                        sub_type: it.sub_type,
                        sort_order: it.sort_order,
                        unit: it.unit,
                        default_threshold: it.default_threshold,
                        bin_location: it.bin_location,
                        active: it.active,
                        is_key_item: it.is_key_item,
                        threshold_effective: eff,
                    };
                }).sort((a, b) => {
                    if (category === 'linen') {
                        const sortA = Number.isFinite(Number(a.sort_order)) ? Number(a.sort_order) : 9999;
                        const sortB = Number.isFinite(Number(b.sort_order)) ? Number(b.sort_order) : 9999;
                        if (sortA !== sortB)
                            return sortA - sortB;
                    }
                    return String(a.name || '').localeCompare(String(b.name || ''), 'zh');
                });
                if (warningsOnly)
                    out = out.filter((x) => Number(x.quantity || 0) < Number(x.threshold_effective || 0));
                return res.json(out);
            }
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
    photo_url: zod_1.z.string().optional(),
});
exports.router.get('/transfers', (0, auth_1.requirePerm)('inventory.view'), async (req, res) => {
    try {
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            await ensureInventorySchema();
            const q = req.query || {};
            const fromWh = String(q.from_warehouse_id || '').trim();
            const toWh = String(q.to_warehouse_id || '').trim();
            const itemId = String(q.item_id || '').trim();
            const category = String(q.category || '').trim();
            const from = String(q.from || '').trim();
            const to = String(q.to || '').trim();
            const limit = Math.min(500, Math.max(1, Number(q.limit || 200)));
            let itemIdsByCategory = null;
            if (category) {
                const its = await dbAdapter_1.pgPool.query(`SELECT id FROM inventory_items WHERE category = $1`, [category]);
                itemIdsByCategory = (its.rows || []).map((r) => String(r.id));
                if (!itemIdsByCategory.length)
                    return res.json([]);
            }
            const where = [`m.ref_type = 'transfer'`];
            const values = [];
            if (fromWh) {
                values.push(fromWh);
                where.push(`(m.type = 'out' AND m.warehouse_id = $${values.length})`);
            }
            if (toWh) {
                values.push(toWh);
                where.push(`(m.type = 'in' AND m.warehouse_id = $${values.length})`);
            }
            if (itemId) {
                values.push(itemId);
                where.push(`m.item_id = $${values.length}`);
            }
            if (itemIdsByCategory) {
                values.push(itemIdsByCategory);
                where.push(`m.item_id = ANY($${values.length}::text[])`);
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
            const moves = await dbAdapter_1.pgPool.query(`SELECT
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
         LIMIT $${values.length}`, values);
            const rows = moves.rows || [];
            if (!rows.length)
                return res.json([]);
            const byRef = new Map();
            for (const r of rows) {
                const ref = String(r.ref_id || '');
                if (!ref)
                    continue;
                const key = `${ref}:${String(r.item_id)}`;
                const cur = byRef.get(key) || { transfer_id: ref, item_id: String(r.item_id) };
                if (r.type === 'out')
                    cur.from_warehouse_id = String(r.warehouse_id);
                if (r.type === 'in')
                    cur.to_warehouse_id = String(r.warehouse_id);
                cur.quantity = Number(r.quantity || 0);
                cur.created_at = cur.created_at ? (String(cur.created_at) > String(r.created_at) ? cur.created_at : r.created_at) : r.created_at;
                if (r.note && !cur.note)
                    cur.note = r.note;
                if (r.photo_url && !cur.photo_url)
                    cur.photo_url = r.photo_url;
                byRef.set(key, cur);
            }
            const list = Array.from(byRef.values());
            const warehouseIds = Array.from(new Set(list.flatMap((x) => [x.from_warehouse_id, x.to_warehouse_id]).filter(Boolean)));
            const itemIds = Array.from(new Set(list.map((x) => x.item_id).filter(Boolean)));
            const [whRows, itRows] = await Promise.all([
                warehouseIds.length ? dbAdapter_1.pgPool.query(`SELECT id, code, name FROM warehouses WHERE id = ANY($1::text[])`, [warehouseIds]) : Promise.resolve({ rows: [] }),
                itemIds.length ? dbAdapter_1.pgPool.query(`SELECT id, name, sku, category, sub_type FROM inventory_items WHERE id = ANY($1::text[])`, [itemIds]) : Promise.resolve({ rows: [] }),
            ]);
            const whMap = new Map(whRows.rows.map((r) => [String(r.id), r]));
            const itMap = new Map(itRows.rows.map((r) => [String(r.id), r]));
            const out = list.map((x) => {
                const fw = whMap.get(String(x.from_warehouse_id)) || {};
                const tw = whMap.get(String(x.to_warehouse_id)) || {};
                const it = itMap.get(String(x.item_id)) || {};
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
                };
            }).sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
            return res.json(out);
        }
        return res.json([]);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
const transferRoomTypeSchema = zod_1.z.object({
    from_warehouse_id: zod_1.z.string().min(1),
    to_warehouse_id: zod_1.z.string().min(1),
    room_type_code: zod_1.z.string().min(1),
    sets: zod_1.z.number().int().min(1),
    delivery_plan_id: zod_1.z.string().optional(),
    note: zod_1.z.string().optional(),
    photo_url: zod_1.z.string().optional(),
});
exports.router.post('/transfers/room-type', (0, auth_1.requirePerm)('inventory.move'), async (req, res) => {
    const parsed = transferRoomTypeSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    if (parsed.data.from_warehouse_id === parsed.data.to_warehouse_id)
        return res.status(400).json({ message: 'same warehouse' });
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'transfer not available without PG' });
        await ensureInventorySchema();
        const transferId = (0, uuid_1.v4)();
        const result = await (0, dbAdapter_1.pgRunInTransaction)(async (client) => {
            const reqs = await client.query(`SELECT linen_type_code, quantity
         FROM inventory_room_type_requirements
         WHERE room_type_code = $1`, [parsed.data.room_type_code]);
            const lines = (reqs.rows || [])
                .map((r) => ({ linen_type_code: String(r.linen_type_code), quantity: Number(r.quantity || 0) }))
                .filter((r) => r.linen_type_code && r.quantity > 0);
            if (!lines.length)
                return { ok: false, code: 400, message: '该房型未配置占用清单' };
            for (const ln of lines) {
                const item_id = `item.linen_type.${ln.linen_type_code}`;
                const qty = parsed.data.sets * ln.quantity;
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
                });
                if (!out.ok)
                    return out;
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
                });
                if (!inn.ok)
                    return inn;
            }
            if (parsed.data.delivery_plan_id) {
                await client.query(`UPDATE linen_delivery_plan_lines
           SET actual_sets = $1, vehicle_load_sets = $1
           WHERE plan_id = $2
             AND to_warehouse_id = $3
             AND room_type_code = $4`, [parsed.data.sets, parsed.data.delivery_plan_id, parsed.data.to_warehouse_id, parsed.data.room_type_code]);
                await client.query(`UPDATE linen_delivery_plans
           SET status = 'dispatched', updated_at = now()
           WHERE id = $1`, [parsed.data.delivery_plan_id]);
            }
            return { ok: true, transfer_id: transferId };
        });
        if (!result)
            return res.status(500).json({ message: 'db not ready' });
        if (!result.ok)
            return res.status(result.code).json({ message: result.message });
        return res.json(result);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
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
                    photo_url: parsed.data.photo_url || null,
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
                    photo_url: parsed.data.photo_url || null,
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
exports.router.post('/upload', (0, auth_1.requirePerm)('inventory.move'), upload.single('file'), async (req, res) => {
    if (!req.file)
        return res.status(400).json({ message: 'missing file' });
    try {
        if (!r2_1.hasR2 || !req.file.buffer)
            return res.status(500).json({ message: 'R2 not configured' });
        const img = await (0, uploadImageResize_1.resizeUploadImage)({ buffer: req.file.buffer, contentType: req.file.mimetype, originalName: req.file.originalname });
        const ext = img.ext || path_1.default.extname(req.file.originalname) || '';
        const key = `inventory/${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
        const url = await (0, r2_1.r2Upload)(key, img.contentType || req.file.mimetype || 'application/octet-stream', img.buffer);
        return res.status(201).json({ url });
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'upload failed' });
    }
});
exports.router.get('/category-dashboard', (0, auth_1.requirePerm)('inventory.view'), async (req, res) => {
    var _a, _b, _c, _d, _e;
    const category = String(((_a = req.query) === null || _a === void 0 ? void 0 : _a.category) || '').trim();
    if (!category)
        return res.status(400).json({ message: 'category required' });
    try {
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            await ensureInventorySchema();
            const ws = await dbAdapter_1.pgPool.query(`SELECT id, code, name, active FROM warehouses ORDER BY code ASC`);
            const warehouses = (ws.rows || []).filter((w) => w.active);
            const linenTypes = category === 'linen'
                ? await dbAdapter_1.pgPool.query(`SELECT code, name, in_set, set_divisor, sort_order
           FROM inventory_linen_types
           WHERE active = true
           ORDER BY sort_order ASC, code ASC`)
                : { rows: [] };
            const roomTypes = category === 'linen'
                ? await dbAdapter_1.pgPool.query(`SELECT code, name, bedrooms, bathrooms, sort_order
           FROM inventory_room_types
           WHERE active = true
           ORDER BY sort_order ASC, code ASC`)
                : { rows: [] };
            const roomTypeReqs = category === 'linen'
                ? await dbAdapter_1.pgPool.query(`SELECT room_type_code, linen_type_code, quantity
           FROM inventory_room_type_requirements`)
                : { rows: [] };
            const its = category === 'linen'
                ? await dbAdapter_1.pgPool.query(`SELECT i.id, i.name, i.sku, i.category, i.sub_type, i.linen_type_code, i.unit, i.default_threshold, i.bin_location, i.active, i.is_key_item, lt.sort_order
           FROM inventory_items i
           LEFT JOIN inventory_linen_types lt ON lt.code = i.linen_type_code
           WHERE i.category = $1
           ORDER BY COALESCE(lt.sort_order, 9999) ASC, COALESCE(lt.code, i.linen_type_code, i.name) ASC, i.name ASC`, [category])
                : await dbAdapter_1.pgPool.query(`SELECT id, name, sku, category, sub_type, linen_type_code, unit, default_threshold, bin_location, active, is_key_item
           FROM inventory_items
           WHERE category = $1`, [category]);
            const items = its.rows || [];
            const itemIds = items.map((r) => String(r.id));
            const itemMap = new Map(items.map((r) => [String(r.id), r]));
            const stocksRaw = itemIds.length
                ? await dbAdapter_1.pgPool.query(`SELECT id, warehouse_id, item_id, quantity, threshold
           FROM warehouse_stocks
           WHERE item_id = ANY($1::text[])`, [itemIds])
                : { rows: [] };
            const stocks = (stocksRaw.rows || []).map((s) => {
                const it = itemMap.get(String(s.item_id)) || {};
                const eff = s.threshold === null || s.threshold === undefined ? Number(it.default_threshold || 0) : Number(s.threshold || 0);
                const qty = Number(s.quantity || 0);
                const status = qty <= 0 ? 'out_of_stock' :
                    qty < eff ? 'warning' :
                        'normal';
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
                };
            });
            const totalQty = stocks.reduce((sum, r) => sum + Number(r.quantity || 0), 0);
            const lowSkuCount = stocks.filter((r) => Number(r.quantity || 0) < Number(r.threshold_effective || 0)).length;
            const byWarehouse = new Map();
            for (const w of warehouses) {
                byWarehouse.set(String(w.id), {
                    warehouse_id: String(w.id),
                    warehouse_code: String(w.code),
                    warehouse_name: String(w.name),
                    counts_by_sub_type: {},
                    available_sets: 0,
                    low_stock: false,
                });
            }
            for (const r of stocks) {
                const wh = byWarehouse.get(String(r.warehouse_id));
                if (!wh)
                    continue;
                const st = category === 'linen'
                    ? String(r.linen_type_code || r.sub_type || 'other')
                    : String(r.sub_type || 'other');
                wh.counts_by_sub_type[st] = Number(wh.counts_by_sub_type[st] || 0) + Number(r.quantity || 0);
                if (Number(r.quantity || 0) < Number(r.threshold_effective || 0))
                    wh.low_stock = true;
            }
            const roomTypeMap = new Map((roomTypes.rows || []).map((r) => [String(r.code), r]));
            const reqMap = new Map();
            for (const r of roomTypeReqs.rows || []) {
                const rt = String(r.room_type_code || '');
                const lt = String(r.linen_type_code || '');
                const qty = Number(r.quantity || 0);
                if (!rt || !lt || qty <= 0)
                    continue;
                if (!reqMap.has(rt))
                    reqMap.set(rt, new Map());
                reqMap.get(rt).set(lt, qty);
            }
            const roomTypesArr = roomTypes.rows || [];
            const defaultRoomType = category === 'linen' && roomTypesArr.length ? roomTypesArr[0] : null;
            const defaultRoomTypeCode = defaultRoomType ? String(defaultRoomType.code) : null;
            const defaultRoomTypeName = defaultRoomType ? String(defaultRoomType.name) : null;
            let availableSetsTotal = 0;
            for (const wh of byWarehouse.values()) {
                const c = wh.counts_by_sub_type || {};
                if (category === 'linen') {
                    wh.available_sets_by_room_type = {};
                    for (const [rtCode] of roomTypeMap.entries()) {
                        const reqs = reqMap.get(rtCode);
                        if (!reqs || reqs.size === 0) {
                            wh.available_sets_by_room_type[rtCode] = 0;
                            continue;
                        }
                        const candidates = [];
                        for (const [lt, qty] of reqs.entries()) {
                            const stockQty = Number(c[lt] || 0);
                            candidates.push(Math.floor(stockQty / Math.max(1, qty)));
                        }
                        const sets = candidates.length ? Math.min(...candidates) : 0;
                        wh.available_sets_by_room_type[rtCode] = isFinite(sets) ? Math.max(0, sets) : 0;
                    }
                    wh.available_sets = defaultRoomTypeCode ? Number(wh.available_sets_by_room_type[defaultRoomTypeCode] || 0) : 0;
                }
                else {
                    wh.available_sets = 0;
                }
                availableSetsTotal += Number(wh.available_sets || 0);
            }
            const damagePending = itemIds.length
                ? await dbAdapter_1.pgPool.query(`SELECT COUNT(*)::int AS c
           FROM stock_change_requests
           WHERE status = 'pending'
             AND reason = 'damage'
             AND item_id = ANY($1::text[])`, [itemIds])
                : { rows: [{ c: 0 }] };
            const damagePendingCount = Number(((_c = (_b = damagePending.rows) === null || _b === void 0 ? void 0 : _b[0]) === null || _c === void 0 ? void 0 : _c.c) || 0);
            const todayMoves = itemIds.length
                ? await dbAdapter_1.pgPool.query(`SELECT type, COALESCE(SUM(quantity),0)::int AS qty
           FROM stock_movements
           WHERE item_id = ANY($1::text[])
             AND created_at >= (date_trunc('day', now() AT TIME ZONE 'Australia/Melbourne') AT TIME ZONE 'Australia/Melbourne')
           GROUP BY type`, [itemIds])
                : { rows: [] };
            const todayMap = new Map(todayMoves.rows.map((r) => [String(r.type), Number(r.qty || 0)]));
            const todayIn = Number(todayMap.get('in') || 0);
            const todayOut = Number(todayMap.get('out') || 0);
            const cards = {
                total_qty: totalQty,
                available_sets_total: availableSetsTotal,
                available_sets_total_room_type_code: defaultRoomTypeCode,
                available_sets_total_room_type_name: defaultRoomTypeName,
                low_sku_count: lowSkuCount,
                damage_pending_count: damagePendingCount,
                today_in_qty: todayIn,
                today_out_qty: todayOut,
            };
            let unboundPropertyCount = 0;
            if (category === 'linen') {
                try {
                    const c = await dbAdapter_1.pgPool.query(`SELECT COUNT(*)::int AS c FROM properties WHERE room_type_code IS NULL`);
                    unboundPropertyCount = Number(((_e = (_d = c.rows) === null || _d === void 0 ? void 0 : _d[0]) === null || _e === void 0 ? void 0 : _e.c) || 0);
                }
                catch (_f) { }
            }
            return res.json({
                category,
                linen_types: linenTypes.rows || [],
                room_types: roomTypes.rows || [],
                unbound_property_count: unboundPropertyCount,
                cards,
                warehouses: Array.from(byWarehouse.values()).sort((a, b) => String(a.warehouse_code).localeCompare(String(b.warehouse_code))),
                stocks,
            });
        }
        return res.status(501).json({ message: 'not available without PG' });
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.get('/unbound-properties', (0, auth_1.requirePerm)('inventory.view'), async (req, res) => {
    var _a;
    const limit = Math.min(500, Math.max(1, Number(((_a = req.query) === null || _a === void 0 ? void 0 : _a.limit) || 200)));
    try {
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            await ensureInventorySchema();
            const rows = await dbAdapter_1.pgPool.query(`SELECT id, code, address, type, region
         FROM properties
         WHERE room_type_code IS NULL
         ORDER BY code NULLS LAST, address ASC
         LIMIT $1`, [limit]);
            return res.json(rows.rows || []);
        }
        return res.json([]);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
const changeRequestCreateSchema = zod_1.z.object({
    warehouse_id: zod_1.z.string().min(1),
    item_id: zod_1.z.string().min(1),
    quantity: zod_1.z.number().int().min(1),
    reason: zod_1.z.enum(['damage', 'return_to_supplier']),
    note: zod_1.z.string().optional(),
    photo_url: zod_1.z.string().optional(),
});
exports.router.post('/stock-change-requests', (0, auth_1.requirePerm)('inventory.move'), async (req, res) => {
    var _a, _b;
    const parsed = changeRequestCreateSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureInventorySchema();
        const id = (0, uuid_1.v4)();
        const created_by = actorId(req);
        const r = await dbAdapter_1.pgPool.query(`INSERT INTO stock_change_requests (id, warehouse_id, item_id, type, quantity, reason, note, photo_url, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`, [
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
        ]);
        (0, store_1.addAudit)('StockChangeRequest', id, 'create', null, ((_a = r.rows) === null || _a === void 0 ? void 0 : _a[0]) || null, actorId(req));
        return res.status(201).json(((_b = r.rows) === null || _b === void 0 ? void 0 : _b[0]) || null);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.get('/stock-change-requests', (0, auth_1.requirePerm)('inventory.view'), async (req, res) => {
    try {
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            await ensureInventorySchema();
            const q = req.query || {};
            const status = String(q.status || '').trim();
            const reason = String(q.reason || '').trim();
            const warehouse_id = String(q.warehouse_id || '').trim();
            const item_id = String(q.item_id || '').trim();
            const category = String(q.category || '').trim();
            const from = String(q.from || '').trim();
            const to = String(q.to || '').trim();
            const limit = Math.min(500, Math.max(1, Number(q.limit || 200)));
            let itemIdsByCategory = null;
            if (category) {
                const its = await dbAdapter_1.pgPool.query(`SELECT id FROM inventory_items WHERE category = $1`, [category]);
                itemIdsByCategory = (its.rows || []).map((r) => String(r.id));
                if (!itemIdsByCategory.length)
                    return res.json([]);
            }
            const where = [];
            const values = [];
            if (status) {
                values.push(status);
                where.push(`r.status = $${values.length}`);
            }
            if (reason) {
                values.push(reason);
                where.push(`r.reason = $${values.length}`);
            }
            if (warehouse_id) {
                values.push(warehouse_id);
                where.push(`r.warehouse_id = $${values.length}`);
            }
            if (item_id) {
                values.push(item_id);
                where.push(`r.item_id = $${values.length}`);
            }
            if (itemIdsByCategory) {
                values.push(itemIdsByCategory);
                where.push(`r.item_id = ANY($${values.length}::text[])`);
            }
            if (from) {
                values.push(from);
                where.push(`r.created_at >= $${values.length}::timestamptz`);
            }
            if (to) {
                values.push(to);
                where.push(`r.created_at <= $${values.length}::timestamptz`);
            }
            values.push(limit);
            const sql = `
        SELECT r.*
        FROM stock_change_requests r
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY r.created_at DESC
        LIMIT $${values.length}
      `;
            const rr = await dbAdapter_1.pgPool.query(sql, values);
            const rows = rr.rows || [];
            if (!rows.length)
                return res.json([]);
            const warehouseIds = Array.from(new Set(rows.map((x) => String(x.warehouse_id || '')).filter(Boolean)));
            const itemIds = Array.from(new Set(rows.map((x) => String(x.item_id || '')).filter(Boolean)));
            const [whRows, itRows] = await Promise.all([
                warehouseIds.length ? dbAdapter_1.pgPool.query(`SELECT id, code, name FROM warehouses WHERE id = ANY($1::text[])`, [warehouseIds]) : Promise.resolve({ rows: [] }),
                itemIds.length ? dbAdapter_1.pgPool.query(`SELECT id, name, sku, category, sub_type FROM inventory_items WHERE id = ANY($1::text[])`, [itemIds]) : Promise.resolve({ rows: [] }),
            ]);
            const whMap = new Map(whRows.rows.map((r) => [String(r.id), r]));
            const itMap = new Map(itRows.rows.map((r) => [String(r.id), r]));
            const out = rows.map((r) => {
                const w = whMap.get(String(r.warehouse_id)) || {};
                const it = itMap.get(String(r.item_id)) || {};
                return {
                    ...r,
                    warehouse_code: w.code,
                    warehouse_name: w.name,
                    item_name: it.name,
                    item_sku: it.sku,
                    item_category: it.category,
                    item_sub_type: it.sub_type,
                };
            });
            return res.json(out);
        }
        return res.json([]);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
const changeRequestPatchSchema = zod_1.z.object({
    status: zod_1.z.enum(['approved', 'rejected']),
});
exports.router.patch('/stock-change-requests/:id', (0, auth_1.requirePerm)('inventory.move'), async (req, res) => {
    var _a, _b, _c;
    const id = String(req.params.id || '');
    const parsed = changeRequestPatchSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureInventorySchema();
        const handled_by = actorId(req);
        const handled_at = new Date().toISOString();
        if (parsed.data.status === 'rejected') {
            const before = await dbAdapter_1.pgPool.query(`SELECT * FROM stock_change_requests WHERE id = $1`, [id]);
            const b = (_a = before.rows) === null || _a === void 0 ? void 0 : _a[0];
            if (!b)
                return res.status(404).json({ message: 'not found' });
            if (String(b.status) !== 'pending')
                return res.status(409).json({ message: 'already handled' });
            const after = await dbAdapter_1.pgPool.query(`UPDATE stock_change_requests
         SET status = 'rejected', handled_by = $1, handled_at = $2
         WHERE id = $3
         RETURNING *`, [handled_by, handled_at, id]);
            (0, store_1.addAudit)('StockChangeRequest', id, 'update', b, ((_b = after.rows) === null || _b === void 0 ? void 0 : _b[0]) || null, actorId(req));
            return res.json(((_c = after.rows) === null || _c === void 0 ? void 0 : _c[0]) || null);
        }
        const result = await (0, dbAdapter_1.pgRunInTransaction)(async (client) => {
            var _a, _b;
            const r0 = await client.query(`SELECT * FROM stock_change_requests WHERE id = $1 FOR UPDATE`, [id]);
            const row = (_a = r0.rows) === null || _a === void 0 ? void 0 : _a[0];
            if (!row)
                return { ok: false, code: 404, message: 'not found' };
            if (String(row.status) !== 'pending')
                return { ok: false, code: 409, message: 'already handled' };
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
            });
            if (!move.ok)
                return move;
            const after = await client.query(`UPDATE stock_change_requests
         SET status = 'approved', handled_by = $1, handled_at = $2, movement_id = $3
         WHERE id = $4
         RETURNING *`, [handled_by, handled_at, move.movement_id, id]);
            return { ok: true, row: ((_b = after.rows) === null || _b === void 0 ? void 0 : _b[0]) || null };
        });
        if (!result)
            return res.status(500).json({ message: 'db not ready' });
        if (!result.ok)
            return res.status(result.code).json({ message: result.message });
        (0, store_1.addAudit)('StockChangeRequest', id, 'approve', null, result.row || null, actorId(req));
        return res.json(result.row || null);
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
exports.router.delete('/suppliers/:id', (0, auth_1.requirePerm)('inventory.po.manage'), async (req, res) => {
    var _a;
    const id = String(req.params.id || '');
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureInventorySchema();
        const before = await dbAdapter_1.pgPool.query(`SELECT * FROM suppliers WHERE id = $1`, [id]);
        const row = (_a = before.rows) === null || _a === void 0 ? void 0 : _a[0];
        if (!row)
            return res.status(404).json({ message: 'supplier not found' });
        const refs = await Promise.all([
            dbAdapter_1.pgPool.query(`SELECT 1 FROM purchase_orders WHERE supplier_id = $1 LIMIT 1`, [id]),
            dbAdapter_1.pgPool.query(`SELECT 1 FROM region_supplier_rules WHERE supplier_id = $1 LIMIT 1`, [id]),
            dbAdapter_1.pgPool.query(`SELECT 1 FROM supplier_item_prices WHERE supplier_id = $1 LIMIT 1`, [id]),
            dbAdapter_1.pgPool.query(`SELECT 1 FROM linen_supplier_return_batches WHERE supplier_id = $1 LIMIT 1`, [id]),
            dbAdapter_1.pgPool.query(`SELECT 1 FROM linen_supplier_refunds WHERE supplier_id = $1 LIMIT 1`, [id]),
        ]);
        if (refs.some((r) => (r.rows || []).length > 0)) {
            return res.status(409).json({ message: '该供应商已有采购、价格、规则或返厂退款记录，无法删除' });
        }
        await dbAdapter_1.pgPool.query(`DELETE FROM suppliers WHERE id = $1`, [id]);
        (0, store_1.addAudit)('Supplier', id, 'delete', row, null, actorId(req));
        return res.json({ ok: true });
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.post('/suppliers/:id/delete', (0, auth_1.requirePerm)('inventory.po.manage'), async (req, res) => {
    var _a;
    const id = String(req.params.id || '');
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureInventorySchema();
        const before = await dbAdapter_1.pgPool.query(`SELECT * FROM suppliers WHERE id = $1`, [id]);
        const row = (_a = before.rows) === null || _a === void 0 ? void 0 : _a[0];
        if (!row)
            return res.status(404).json({ message: 'supplier not found' });
        const refs = await Promise.all([
            dbAdapter_1.pgPool.query(`SELECT 1 FROM purchase_orders WHERE supplier_id = $1 LIMIT 1`, [id]),
            dbAdapter_1.pgPool.query(`SELECT 1 FROM region_supplier_rules WHERE supplier_id = $1 LIMIT 1`, [id]),
            dbAdapter_1.pgPool.query(`SELECT 1 FROM supplier_item_prices WHERE supplier_id = $1 LIMIT 1`, [id]),
            dbAdapter_1.pgPool.query(`SELECT 1 FROM linen_supplier_return_batches WHERE supplier_id = $1 LIMIT 1`, [id]),
            dbAdapter_1.pgPool.query(`SELECT 1 FROM linen_supplier_refunds WHERE supplier_id = $1 LIMIT 1`, [id]),
        ]);
        if (refs.some((r) => (r.rows || []).length > 0)) {
            return res.status(409).json({ message: '该供应商已有采购、价格、规则或返厂退款记录，无法删除' });
        }
        await dbAdapter_1.pgPool.query(`DELETE FROM suppliers WHERE id = $1`, [id]);
        (0, store_1.addAudit)('Supplier', id, 'delete', row, null, actorId(req));
        return res.json({ ok: true });
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
    ordered_date: zod_1.z.string().optional(),
    requested_delivery_date: zod_1.z.string().optional(),
    note: zod_1.z.string().optional(),
    lines: zod_1.z.array(zod_1.z.union([
        zod_1.z.object({
            item_id: zod_1.z.string().min(1),
            quantity: zod_1.z.number().int().min(1),
            unit: zod_1.z.string().optional(),
            unit_price: zod_1.z.number().optional(),
            note: zod_1.z.string().optional(),
        }),
        zod_1.z.object({
            room_type_code: zod_1.z.string().min(1),
            sets: zod_1.z.number().int().min(1),
        }),
    ])).min(1),
});
exports.router.get('/purchase-orders', (0, auth_1.requirePerm)('inventory.po.manage'), async (req, res) => {
    try {
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            await ensureInventorySchema();
            const q = req.query || {};
            const status = String(q.status || '').trim();
            const supplier_id = String(q.supplier_id || '').trim();
            const warehouse_id = String(q.warehouse_id || '').trim();
            const category = String(q.category || '').trim();
            let poIds = null;
            if (category) {
                const its = await dbAdapter_1.pgPool.query(`SELECT id FROM inventory_items WHERE category = $1`, [category]);
                const itemIds = (its.rows || []).map((r) => String(r.id));
                if (!itemIds.length)
                    return res.json([]);
                const prs = await dbAdapter_1.pgPool.query(`SELECT DISTINCT po_id FROM purchase_order_lines WHERE item_id = ANY($1::text[])`, [itemIds]);
                poIds = (prs.rows || []).map((r) => String(r.po_id));
                if (!poIds.length)
                    return res.json([]);
            }
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
            if (poIds) {
                values.push(poIds);
                where.push(`po.id = ANY($${values.length}::text[])`);
            }
            const sql = `
        SELECT po.*
        FROM purchase_orders po
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY COALESCE(po.ordered_date, (po.created_at AT TIME ZONE 'Australia/Melbourne')::date) DESC, po.created_at DESC
        LIMIT 200
      `;
            const poRows = await dbAdapter_1.pgPool.query(sql, values);
            const rows = poRows.rows || [];
            for (const row of rows) {
                if (!String((row === null || row === void 0 ? void 0 : row.po_no) || '').trim()) {
                    ;
                    row.po_no = await ensurePurchaseOrderNo(dbAdapter_1.pgPool, row);
                }
            }
            if (!rows.length)
                return res.json([]);
            const supplierIds = Array.from(new Set(rows.map((r) => String(r.supplier_id || '')).filter(Boolean)));
            const warehouseIds = Array.from(new Set(rows.map((r) => String(r.warehouse_id || '')).filter(Boolean)));
            const [supRows, whRows, aggRows] = await Promise.all([
                supplierIds.length ? dbAdapter_1.pgPool.query(`SELECT id, name FROM suppliers WHERE id = ANY($1::text[])`, [supplierIds]) : Promise.resolve({ rows: [] }),
                warehouseIds.length ? dbAdapter_1.pgPool.query(`SELECT id, code, name FROM warehouses WHERE id = ANY($1::text[])`, [warehouseIds]) : Promise.resolve({ rows: [] }),
                dbAdapter_1.pgPool.query(`SELECT po_id,
                  COUNT(*)::int AS line_count,
                  COALESCE(SUM(quantity),0)::int AS quantity_total,
                  COALESCE(SUM(COALESCE(unit_price,0) * quantity),0) AS amount_total
           FROM purchase_order_lines
           WHERE po_id = ANY($1::text[])
           GROUP BY po_id`, [rows.map((r) => String(r.id))]),
            ]);
            const supMap = new Map(supRows.rows.map((r) => [String(r.id), r]));
            const whMap = new Map(whRows.rows.map((r) => [String(r.id), r]));
            const aggMap = new Map(aggRows.rows.map((r) => [String(r.po_id), r]));
            const out = rows.map((r) => {
                const s = supMap.get(String(r.supplier_id)) || {};
                const w = whMap.get(String(r.warehouse_id)) || {};
                const a = aggMap.get(String(r.id)) || {};
                return {
                    ...r,
                    supplier_name: s.name,
                    warehouse_name: w.name,
                    warehouse_code: w.code,
                    line_count: Number(a.line_count || 0),
                    quantity_total: Number(a.quantity_total || 0),
                    amount_total: a.amount_total !== undefined && a.amount_total !== null ? String(a.amount_total) : '0',
                    subtotal_amount: r.subtotal_amount !== undefined && r.subtotal_amount !== null ? String(r.subtotal_amount) : '0',
                    gst_amount: r.gst_amount !== undefined && r.gst_amount !== null ? String(r.gst_amount) : '0',
                    total_amount_inc_gst: r.total_amount_inc_gst !== undefined && r.total_amount_inc_gst !== null ? String(r.total_amount_inc_gst) : '0',
                };
            });
            return res.json(out);
        }
        return res.json([]);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.get('/purchase-order-lines', (0, auth_1.requirePerm)('inventory.po.manage'), async (req, res) => {
    try {
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            await ensureInventorySchema();
            const q = req.query || {};
            const status = String(q.status || '').trim();
            const supplier_id = String(q.supplier_id || '').trim();
            const warehouse_id = String(q.warehouse_id || '').trim();
            const category = String(q.category || '').trim();
            const from = String(q.from || '').trim();
            const to = String(q.to || '').trim();
            let itemIdsByCategory = null;
            let poIdsByCategory = null;
            if (category) {
                const its = await dbAdapter_1.pgPool.query(`SELECT id FROM inventory_items WHERE category = $1`, [category]);
                itemIdsByCategory = (its.rows || []).map((r) => String(r.id));
                if (!itemIdsByCategory.length)
                    return res.json([]);
                const prs = await dbAdapter_1.pgPool.query(`SELECT DISTINCT po_id FROM purchase_order_lines WHERE item_id = ANY($1::text[])`, [itemIdsByCategory]);
                poIdsByCategory = (prs.rows || []).map((r) => String(r.po_id));
                if (!poIdsByCategory.length)
                    return res.json([]);
            }
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
            if (from) {
                values.push(from);
                where.push(`po.created_at >= $${values.length}::timestamptz`);
            }
            if (to) {
                values.push(to);
                where.push(`po.created_at <= $${values.length}::timestamptz`);
            }
            if (poIdsByCategory) {
                values.push(poIdsByCategory);
                where.push(`po.id = ANY($${values.length}::text[])`);
            }
            const pos = await dbAdapter_1.pgPool.query(`SELECT po.*
         FROM purchase_orders po
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY po.created_at DESC
         LIMIT 200`, values);
            const poRows = pos.rows || [];
            if (!poRows.length)
                return res.json([]);
            const poIds = poRows.map((r) => String(r.id));
            const lineWhere = [`po_id = ANY($1::text[])`];
            const lineVals = [poIds];
            if (itemIdsByCategory) {
                lineVals.push(itemIdsByCategory);
                lineWhere.push(`item_id = ANY($${lineVals.length}::text[])`);
            }
            const lines = await dbAdapter_1.pgPool.query(`SELECT l.*, i.name AS item_name, i.sku AS item_sku, lt.sort_order
         FROM purchase_order_lines l
         JOIN inventory_items i ON i.id = l.item_id
         LEFT JOIN inventory_linen_types lt ON lt.code = i.linen_type_code
         WHERE ${lineWhere.join(' AND ')}
         ORDER BY l.po_id ASC, COALESCE(lt.sort_order, 9999) ASC, COALESCE(lt.code, i.linen_type_code, i.name) ASC, i.name ASC`, lineVals);
            const lineRows = lines.rows || [];
            if (!lineRows.length)
                return res.json([]);
            const supplierIds = Array.from(new Set(poRows.map((r) => String(r.supplier_id || '')).filter(Boolean)));
            const warehouseIds = Array.from(new Set(poRows.map((r) => String(r.warehouse_id || '')).filter(Boolean)));
            const itemIds = Array.from(new Set(lineRows.map((r) => String(r.item_id || '')).filter(Boolean)));
            const [supRows, whRows, itRows] = await Promise.all([
                supplierIds.length ? dbAdapter_1.pgPool.query(`SELECT id, name FROM suppliers WHERE id = ANY($1::text[])`, [supplierIds]) : Promise.resolve({ rows: [] }),
                warehouseIds.length ? dbAdapter_1.pgPool.query(`SELECT id, code, name FROM warehouses WHERE id = ANY($1::text[])`, [warehouseIds]) : Promise.resolve({ rows: [] }),
                itemIds.length ? dbAdapter_1.pgPool.query(`SELECT id, name, sku, category, sub_type FROM inventory_items WHERE id = ANY($1::text[])`, [itemIds]) : Promise.resolve({ rows: [] }),
            ]);
            const poMap = new Map(poRows.map((r) => [String(r.id), r]));
            const supMap = new Map(supRows.rows.map((r) => [String(r.id), r]));
            const whMap = new Map(whRows.rows.map((r) => [String(r.id), r]));
            const itMap = new Map(itRows.rows.map((r) => [String(r.id), r]));
            const out = lineRows.map((l) => {
                const po = poMap.get(String(l.po_id)) || {};
                const s = supMap.get(String(po.supplier_id)) || {};
                const w = whMap.get(String(po.warehouse_id)) || {};
                const it = itMap.get(String(l.item_id)) || {};
                const qty = Number(l.quantity || 0);
                const unitPrice = l.unit_price === null || l.unit_price === undefined ? null : Number(l.unit_price);
                const amount = unitPrice === null ? null : unitPrice * qty;
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
                };
            }).sort((a, b) => String(b.po_created_at || '').localeCompare(String(a.po_created_at || '')));
            return res.json(out);
        }
        return res.json([]);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.post('/purchase-orders', (0, auth_1.requirePerm)('inventory.po.manage'), async (req, res) => {
    var _a;
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
        let regionExplicit = String(parsed.data.region || '').trim();
        const propertyIdExplicit = String(parsed.data.property_id || '').trim();
        let propertyRow = null;
        if (propertyIdExplicit) {
            const propRes = await pool.query(`SELECT id, region FROM properties WHERE id = $1`, [propertyIdExplicit]);
            propertyRow = ((_a = propRes.rows) === null || _a === void 0 ? void 0 : _a[0]) || null;
            if (!regionExplicit && (propertyRow === null || propertyRow === void 0 ? void 0 : propertyRow.region))
                regionExplicit = String(propertyRow.region || '').trim();
        }
        let regionFinal = regionExplicit;
        const supplier_id = supplierIdExplicit || (regionFinal ? await pickSupplierIdForRegion(regionFinal) : null);
        if (!supplier_id)
            return res.status(400).json({ message: '无法确定供应商，请手动选择 supplier_id' });
        const poId = (0, uuid_1.v4)();
        const created_by = actorId(req);
        const smWarehouse = await getSmWarehouse();
        const warehouseDefault = (smWarehouse === null || smWarehouse === void 0 ? void 0 : smWarehouse.id) ? String(smWarehouse.id) : 'wh.south_melbourne';
        const warehouseFinal = String(parsed.data.warehouse_id || '').trim() || warehouseDefault;
        const orderedDate = String(parsed.data.ordered_date || '').trim();
        const result = await (0, dbAdapter_1.pgRunInTransaction)(async (client) => {
            var _a, _b, _c, _d, _e, _f, _g, _h;
            const poRow = await client.query(`INSERT INTO purchase_orders (id, supplier_id, warehouse_id, status, ordered_date, requested_delivery_date, region, property_id, note, created_by)
         VALUES ($1,$2,$3,$4,COALESCE(NULLIF($5,'')::date, (now() AT TIME ZONE 'Australia/Melbourne')::date),$6,$7,$8,$9,$10)
         RETURNING *`, [
                poId,
                supplier_id,
                warehouseFinal,
                'draft',
                orderedDate,
                parsed.data.requested_delivery_date ? parsed.data.requested_delivery_date : null,
                regionFinal || null,
                propertyIdExplicit || null,
                parsed.data.note || null,
                created_by,
            ]);
            await ensurePurchaseOrderNo(client, ((_a = poRow.rows) === null || _a === void 0 ? void 0 : _a[0]) || { id: poId, ordered_date: orderedDate });
            const poRowWithNo = await client.query(`SELECT * FROM purchase_orders WHERE id = $1`, [poId]);
            const priceMap = await getLatestSupplierItemPrice(client, supplier_id);
            const qtyByItem = new Map();
            const metaByItem = new Map();
            for (const ln of parsed.data.lines) {
                if (ln.item_id) {
                    const item_id = String(ln.item_id);
                    const qty = Number(ln.quantity || 0);
                    qtyByItem.set(item_id, (qtyByItem.get(item_id) || 0) + qty);
                    const priceRow = priceMap.get(item_id);
                    metaByItem.set(item_id, {
                        unit_price: (_b = ln.unit_price) !== null && _b !== void 0 ? _b : (priceRow ? Number(priceRow.purchase_unit_price || 0) : null),
                        note: ln.note || null,
                        unit: ln.unit || null,
                    });
                    continue;
                }
                if (ln.room_type_code) {
                    const roomTypeCode = String(ln.room_type_code);
                    const sets = Number(ln.sets || 0);
                    const reqs = await client.query(`SELECT linen_type_code, quantity
             FROM inventory_room_type_requirements
             WHERE room_type_code = $1`, [roomTypeCode]);
                    for (const r of reqs.rows || []) {
                        const linenTypeCode = String(r.linen_type_code);
                        const perSet = Number(r.quantity || 0);
                        if (perSet <= 0)
                            continue;
                        const item_id = `item.linen_type.${linenTypeCode}`;
                        const qty = sets * perSet;
                        qtyByItem.set(item_id, (qtyByItem.get(item_id) || 0) + qty);
                        if (!metaByItem.has(item_id))
                            metaByItem.set(item_id, { unit_price: null, note: null, unit: null });
                    }
                }
            }
            const linesOut = [];
            for (const [item_id, quantity] of qtyByItem.entries()) {
                const item = await client.query(`SELECT id, unit FROM inventory_items WHERE id = $1`, [item_id]);
                const meta = metaByItem.get(item_id) || { unit_price: null, note: null, unit: null };
                const unit = meta.unit || ((_d = (_c = item.rows) === null || _c === void 0 ? void 0 : _c[0]) === null || _d === void 0 ? void 0 : _d.unit);
                if (!unit)
                    throw new Error('unit missing');
                const lineId = (0, uuid_1.v4)();
                const row = await client.query(`INSERT INTO purchase_order_lines (id, po_id, item_id, quantity, unit, unit_price, amount_total, note)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           RETURNING *`, [
                    lineId,
                    poId,
                    item_id,
                    quantity,
                    unit,
                    meta.unit_price,
                    meta.unit_price === null || meta.unit_price === undefined ? null : Number(meta.unit_price) * Number(quantity || 0),
                    meta.note,
                ]);
                linesOut.push(((_e = row.rows) === null || _e === void 0 ? void 0 : _e[0]) || null);
            }
            await refreshPurchaseOrderTotals(client, poId);
            const poFinal = await client.query(`SELECT * FROM purchase_orders WHERE id = $1`, [poId]);
            return { po: ((_f = poFinal.rows) === null || _f === void 0 ? void 0 : _f[0]) || ((_g = poRowWithNo.rows) === null || _g === void 0 ? void 0 : _g[0]) || ((_h = poRow.rows) === null || _h === void 0 ? void 0 : _h[0]) || null, lines: linesOut };
        });
        (0, store_1.addAudit)('PurchaseOrder', poId, 'create', null, result, actorId(req));
        return res.status(201).json(result);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.get('/purchase-orders/:id', (0, auth_1.requirePerm)('inventory.po.manage'), async (req, res) => {
    var _a, _b, _c;
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
        if (!String(((_c = (_b = po.rows) === null || _b === void 0 ? void 0 : _b[0]) === null || _c === void 0 ? void 0 : _c.po_no) || '').trim()) {
            po.rows[0].po_no = await ensurePurchaseOrderNo(dbAdapter_1.pgPool, po.rows[0]);
        }
        const lines = await dbAdapter_1.pgPool.query(`SELECT l.*, i.name AS item_name, i.sku AS item_sku, lt.sort_order
       FROM purchase_order_lines l
       JOIN inventory_items i ON i.id = l.item_id
       LEFT JOIN inventory_linen_types lt ON lt.code = i.linen_type_code
       WHERE l.po_id = $1
       ORDER BY COALESCE(lt.sort_order, 9999) ASC, COALESCE(lt.code, i.linen_type_code, i.name) ASC, i.name ASC`, [id]);
        const deliveries = await dbAdapter_1.pgPool.query(`SELECT d.* FROM purchase_deliveries d WHERE d.po_id = $1 ORDER BY d.received_at DESC`, [id]);
        return res.json({ po: po.rows[0], lines: lines.rows || [], deliveries: deliveries.rows || [] });
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
const poPatchSchema = zod_1.z.object({
    status: zod_1.z.enum(['draft', 'ordered', 'received', 'closed']).optional(),
    supplier_id: zod_1.z.string().min(1).optional(),
    warehouse_id: zod_1.z.string().min(1).optional(),
    ordered_date: zod_1.z.string().optional(),
    requested_delivery_date: zod_1.z.string().optional(),
    note: zod_1.z.string().optional(),
    lines: zod_1.z.array(zod_1.z.object({
        id: zod_1.z.string().min(1),
        quantity: zod_1.z.number(),
        note: zod_1.z.string().optional(),
        unit_price: zod_1.z.number().nullable().optional(),
    })).optional(),
});
async function refreshPurchaseOrderTotals(client, poId) {
    var _a, _b;
    const totals = await client.query(`SELECT
       COALESCE(SUM(COALESCE(amount_total,0)),0)::numeric AS subtotal_amount
     FROM purchase_order_lines
     WHERE po_id = $1`, [poId]);
    const subtotal = Number(((_b = (_a = totals.rows) === null || _a === void 0 ? void 0 : _a[0]) === null || _b === void 0 ? void 0 : _b.subtotal_amount) || 0);
    const gst = Number((subtotal * 0.1).toFixed(2));
    const totalInclGst = Number((subtotal + gst).toFixed(2));
    await client.query(`UPDATE purchase_orders
     SET subtotal_amount = $1::numeric,
         gst_amount = $2::numeric,
         total_amount_inc_gst = $3::numeric,
         updated_at = now()
     WHERE id = $4`, [subtotal, gst, totalInclGst, poId]);
}
exports.router.patch('/purchase-orders/:id', (0, auth_1.requirePerm)('inventory.po.manage'), async (req, res) => {
    var _a, _b, _c, _d;
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
        if (String(b.status || '') === 'received' || String(b.status || '') === 'closed') {
            return res.status(400).json({ message: '已到货或已关闭的采购单不可编辑' });
        }
        const payload = parsed.data;
        const client = await dbAdapter_1.pgPool.connect();
        try {
            await client.query('BEGIN');
            const { lines: linePayload, ...poPayload } = payload;
            const keys = Object.keys(poPayload).filter((k) => poPayload[k] !== undefined);
            let afterRow = b;
            if (keys.length) {
                const sets = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ');
                const values = keys.map((k) => poPayload[k]);
                const sql = `UPDATE purchase_orders SET ${sets}, updated_at = now() WHERE id = $${keys.length + 1} RETURNING *`;
                const after = await client.query(sql, [...values, id]);
                afterRow = ((_b = after.rows) === null || _b === void 0 ? void 0 : _b[0]) || afterRow;
            }
            if (Array.isArray(linePayload) && linePayload.length) {
                for (const line of linePayload) {
                    const existing = await client.query(`SELECT id, po_id, quantity, unit_price, note
             FROM purchase_order_lines
             WHERE id = $1 AND po_id = $2`, [line.id, id]);
                    const current = (_c = existing.rows) === null || _c === void 0 ? void 0 : _c[0];
                    if (!current)
                        continue;
                    const quantity = Number(line.quantity || 0);
                    const unitPrice = line.unit_price === undefined ? Number(current.unit_price || 0) : (line.unit_price === null ? null : Number(line.unit_price));
                    await client.query(`UPDATE purchase_order_lines
             SET quantity = $1::integer,
                 note = $2,
                 unit_price = $3::numeric,
                 amount_total = CASE
                   WHEN $3 IS NULL THEN NULL
                   ELSE ROUND(($1::numeric * $3::numeric), 2)
                 END
             WHERE id = $4 AND po_id = $5`, [quantity, line.note || null, unitPrice, line.id, id]);
                }
            }
            await refreshPurchaseOrderTotals(client, id);
            const afterPo = await client.query(`SELECT * FROM purchase_orders WHERE id = $1`, [id]);
            const afterLines = await client.query(`SELECT * FROM purchase_order_lines WHERE po_id = $1 ORDER BY id ASC`, [id]);
            await client.query('COMMIT');
            const result = { po: ((_d = afterPo.rows) === null || _d === void 0 ? void 0 : _d[0]) || afterRow, lines: afterLines.rows || [] };
            (0, store_1.addAudit)('PurchaseOrder', id, 'update', b, result.po || null, actorId(req));
            return res.json(result);
        }
        catch (txErr) {
            try {
                await client.query('ROLLBACK');
            }
            catch (_e) { }
            throw txErr;
        }
        finally {
            client.release();
        }
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
        const lines = await dbAdapter_1.pgPool.query(`SELECT i.name AS item_name, i.sku AS item_sku, l.quantity, l.unit, l.unit_price, l.note, lt.sort_order
       FROM purchase_order_lines l
       JOIN inventory_items i ON i.id = l.item_id
       LEFT JOIN inventory_linen_types lt ON lt.code = i.linen_type_code
       WHERE l.po_id = $1
       ORDER BY COALESCE(lt.sort_order, 9999) ASC, COALESCE(lt.code, i.linen_type_code, i.name) ASC, i.name ASC`, [id]);
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
            const receivedAt = String(parsed.data.received_at || '').trim();
            const d = await client.query(`INSERT INTO purchase_deliveries (id, po_id, received_at, received_by, note)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING *`, [deliveryId, po_id, receivedAt || new Date().toISOString(), actorId(req), parsed.data.note || null]);
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
exports.router.get('/deliveries', (0, auth_1.requirePerm)('inventory.view'), async (req, res) => {
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.json([]);
        await ensureInventorySchema();
        const q = req.query || {};
        const supplierId = String(q.supplier_id || '').trim();
        const warehouseId = String(q.warehouse_id || '').trim();
        const category = String(q.category || '').trim();
        const from = String(q.from || '').trim();
        const to = String(q.to || '').trim();
        const where = [];
        const values = [];
        if (supplierId) {
            values.push(supplierId);
            where.push(`po.supplier_id = $${values.length}`);
        }
        if (warehouseId) {
            values.push(warehouseId);
            where.push(`po.warehouse_id = $${values.length}`);
        }
        if (from) {
            values.push(from);
            where.push(`d.received_at >= $${values.length}::timestamptz`);
        }
        if (to) {
            values.push(to);
            where.push(`d.received_at <= $${values.length}::timestamptz`);
        }
        if (category) {
            values.push(category);
            where.push(`EXISTS (
        SELECT 1
        FROM purchase_delivery_lines dl
        JOIN inventory_items i ON i.id = dl.item_id
        WHERE dl.delivery_id = d.id
          AND i.category = $${values.length}
      )`);
        }
        const rows = await dbAdapter_1.pgPool.query(`SELECT d.id, d.po_id, d.received_at, d.received_by, d.note,
              po.supplier_id, po.warehouse_id,
              s.name AS supplier_name,
              w.code AS warehouse_code, w.name AS warehouse_name,
              COUNT(dl.id)::int AS line_count,
              COALESCE(SUM(dl.quantity_received),0)::int AS quantity_total
       FROM purchase_deliveries d
       JOIN purchase_orders po ON po.id = d.po_id
       JOIN suppliers s ON s.id = po.supplier_id
       JOIN warehouses w ON w.id = po.warehouse_id
       LEFT JOIN purchase_delivery_lines dl ON dl.delivery_id = d.id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       GROUP BY d.id, d.po_id, d.received_at, d.received_by, d.note, po.supplier_id, po.warehouse_id, s.name, w.code, w.name
       ORDER BY d.received_at DESC
       LIMIT 200`, values);
        return res.json(rows.rows || []);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
const optionalNonEmptyString = zod_1.z.preprocess((v) => {
    if (v === undefined || v === null)
        return undefined;
    const s = String(v).trim();
    return s ? s : undefined;
}, zod_1.z.string().min(1).optional());
const supplierItemPriceSchema = zod_1.z.object({
    supplier_id: zod_1.z.string().min(1),
    item_id: optionalNonEmptyString,
    linen_type_code: optionalNonEmptyString,
    purchase_unit_price: zod_1.z.number().min(0),
    refund_unit_price: zod_1.z.number().min(0).optional(),
    effective_from: zod_1.z.string().optional(),
    active: zod_1.z.boolean().optional(),
});
exports.router.get('/supplier-item-prices', (0, auth_1.requirePerm)('inventory.po.manage'), async (req, res) => {
    var _a, _b, _c;
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.json([]);
        await ensureInventorySchema();
        const supplierId = String(((_a = req.query) === null || _a === void 0 ? void 0 : _a.supplier_id) || '').trim();
        const itemId = String(((_b = req.query) === null || _b === void 0 ? void 0 : _b.item_id) || '').trim();
        const active = String(((_c = req.query) === null || _c === void 0 ? void 0 : _c.active) || '').trim().toLowerCase();
        const where = [];
        const values = [];
        if (supplierId) {
            values.push(supplierId);
            where.push(`sip.supplier_id = $${values.length}`);
        }
        if (itemId) {
            values.push(itemId);
            where.push(`sip.item_id = $${values.length}`);
        }
        if (active === 'true' || active === 'false') {
            values.push(active === 'true');
            where.push(`sip.active = $${values.length}`);
        }
        const rows = await dbAdapter_1.pgPool.query(`SELECT sip.*, s.name AS supplier_name, i.name AS item_name, i.sku AS item_sku, i.linen_type_code
       FROM supplier_item_prices sip
       JOIN suppliers s ON s.id = sip.supplier_id
       JOIN inventory_items i ON i.id = sip.item_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY s.name ASC, i.name ASC, COALESCE(sip.effective_from, DATE '1970-01-01') DESC`, values);
        return res.json(rows.rows || []);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.post('/supplier-item-prices', (0, auth_1.requirePerm)('inventory.po.manage'), async (req, res) => {
    var _a, _b, _c;
    const parsed = supplierItemPriceSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureInventorySchema();
        const body = parsed.data;
        let itemId = String(body.item_id || '').trim();
        if (!itemId && body.linen_type_code) {
            const item = await ensureLinenInventoryItem(dbAdapter_1.pgPool, String(body.linen_type_code));
            itemId = String((item === null || item === void 0 ? void 0 : item.id) || '');
        }
        if (!itemId)
            return res.status(400).json({ message: 'item_id required' });
        const id = (0, uuid_1.v4)();
        const row = await dbAdapter_1.pgPool.query(`INSERT INTO supplier_item_prices (id, supplier_id, item_id, purchase_unit_price, refund_unit_price, effective_from, active, updated_at)
       VALUES ($1,$2,$3,$4,$5,NULLIF($6,'')::date,$7,now())
       ON CONFLICT (supplier_id, item_id)
       DO UPDATE SET purchase_unit_price = EXCLUDED.purchase_unit_price,
                     refund_unit_price = EXCLUDED.refund_unit_price,
                     effective_from = EXCLUDED.effective_from,
                     active = EXCLUDED.active,
                     updated_at = now()
       RETURNING *`, [id, body.supplier_id, itemId, body.purchase_unit_price, (_a = body.refund_unit_price) !== null && _a !== void 0 ? _a : body.purchase_unit_price, body.effective_from || null, (_b = body.active) !== null && _b !== void 0 ? _b : true]);
        return res.status(201).json(((_c = row.rows) === null || _c === void 0 ? void 0 : _c[0]) || null);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.patch('/supplier-item-prices/:id', (0, auth_1.requirePerm)('inventory.po.manage'), async (req, res) => {
    var _a;
    const parsed = supplierItemPriceSchema.partial().safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureInventorySchema();
        const id = String(req.params.id || '');
        const payload = parsed.data;
        const keys = Object.keys(payload).filter((k) => payload[k] !== undefined);
        if (!keys.length)
            return res.json(null);
        const sets = keys.map((k, i) => k === 'effective_from' ? `"${k}" = NULLIF($${i + 1}, '')::date` : `"${k}" = $${i + 1}`).join(', ');
        const values = keys.map((k) => payload[k]);
        const row = await dbAdapter_1.pgPool.query(`UPDATE supplier_item_prices
       SET ${sets}, updated_at = now()
       WHERE id = $${keys.length + 1}
       RETURNING *`, [...values, id]);
        return res.json(((_a = row.rows) === null || _a === void 0 ? void 0 : _a[0]) || null);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.delete('/supplier-item-prices/:id', (0, auth_1.requirePerm)('inventory.po.manage'), async (req, res) => {
    var _a;
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureInventorySchema();
        const id = String(req.params.id || '');
        const before = await dbAdapter_1.pgPool.query(`SELECT * FROM supplier_item_prices WHERE id = $1`, [id]);
        const row = (_a = before.rows) === null || _a === void 0 ? void 0 : _a[0];
        if (!row)
            return res.status(404).json({ message: 'not found' });
        await dbAdapter_1.pgPool.query(`DELETE FROM supplier_item_prices WHERE id = $1`, [id]);
        return res.json({ ok: true });
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.get('/linen/reserve-policies', (0, auth_1.requirePerm)('inventory.view'), async (req, res) => {
    var _a;
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.json([]);
        await ensureInventorySchema();
        const warehouseId = String(((_a = req.query) === null || _a === void 0 ? void 0 : _a.warehouse_id) || '').trim();
        const rows = await dbAdapter_1.pgPool.query(`SELECT p.id, p.warehouse_id, p.item_id, p.reserve_qty, w.code AS warehouse_code, w.name AS warehouse_name,
              i.name AS item_name, i.sku AS item_sku, i.linen_type_code
       FROM inventory_stock_policies p
       JOIN warehouses w ON w.id = p.warehouse_id
       JOIN inventory_items i ON i.id = p.item_id
       ${warehouseId ? 'WHERE p.warehouse_id = $1' : ''}
       ORDER BY w.code ASC, i.name ASC`, warehouseId ? [warehouseId] : []);
        return res.json(rows.rows || []);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
const reservePolicySchema = zod_1.z.object({
    warehouse_id: zod_1.z.string().min(1),
    item_id: zod_1.z.string().min(1),
    reserve_qty: zod_1.z.number().int().min(0),
});
exports.router.put('/linen/reserve-policies', (0, auth_1.requirePerm)('inventory.item.manage'), async (req, res) => {
    var _a;
    const parsed = reservePolicySchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureInventorySchema();
        const body = parsed.data;
        const id = `reserve.${body.warehouse_id}.${body.item_id}`;
        const row = await dbAdapter_1.pgPool.query(`INSERT INTO inventory_stock_policies (id, warehouse_id, item_id, reserve_qty, updated_at)
       VALUES ($1,$2,$3,$4,now())
       ON CONFLICT (warehouse_id, item_id)
       DO UPDATE SET reserve_qty = EXCLUDED.reserve_qty, updated_at = now()
       RETURNING *`, [id, body.warehouse_id, body.item_id, body.reserve_qty]);
        return res.json(((_a = row.rows) === null || _a === void 0 ? void 0 : _a[0]) || null);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.get('/linen/dashboard', (0, auth_1.requirePerm)('inventory.view'), async (req, res) => {
    var _a, _b;
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureInventorySchema();
        const client = dbAdapter_1.pgPool;
        const smWarehouse = await getSmWarehouse();
        const smWarehouseId = String((smWarehouse === null || smWarehouse === void 0 ? void 0 : smWarehouse.id) || '');
        const [warehousesRes, itemsRes, stocksRes, roomRes, pendingRefundRes] = await Promise.all([
            client.query(`SELECT id, code, name, linen_capacity_sets, active FROM warehouses WHERE active = true ORDER BY code ASC`),
            client.query(`SELECT i.id, i.name, i.sku, i.linen_type_code, lt.sort_order
         FROM inventory_items i
         LEFT JOIN inventory_linen_types lt ON lt.code = i.linen_type_code
         WHERE i.category = 'linen' AND i.active = true
         ORDER BY COALESCE(lt.sort_order, 9999) ASC, COALESCE(lt.code, i.linen_type_code, i.name) ASC, i.name ASC`),
            client.query(`SELECT warehouse_id, item_id, quantity FROM warehouse_stocks WHERE item_id IN (SELECT id FROM inventory_items WHERE category = 'linen')`),
            getRoomTypeRequirementMaps(client),
            client.query(`SELECT COALESCE(SUM(expected_amount - received_amount),0) AS pending_amount FROM linen_supplier_refunds WHERE status <> 'settled'`),
        ]);
        const warehouses = warehousesRes.rows || [];
        const items = itemsRes.rows || [];
        const reserveMap = smWarehouseId ? await getLinenReserveMap(client, smWarehouseId) : new Map();
        const itemMap = new Map(items.map((r) => [String(r.id), r]));
        const countsByWarehouse = new Map();
        for (const row of stocksRes.rows || []) {
            const warehouseId = String(row.warehouse_id || '');
            if (!countsByWarehouse.has(warehouseId))
                countsByWarehouse.set(warehouseId, {});
            const item = itemMap.get(String(row.item_id || ''));
            const linenTypeCode = String((item === null || item === void 0 ? void 0 : item.linen_type_code) || '');
            if (!linenTypeCode)
                continue;
            countsByWarehouse.get(warehouseId)[linenTypeCode] = Number(countsByWarehouse.get(warehouseId)[linenTypeCode] || 0) + Number(row.quantity || 0);
        }
        const dispatchableByType = {};
        if (smWarehouseId) {
            for (const item of items) {
                const itemId = String(item.id);
                const linenTypeCode = String(item.linen_type_code || '');
                const qty = Number((countsByWarehouse.get(smWarehouseId) || {})[linenTypeCode] || 0);
                const reserveQty = Number(reserveMap.get(itemId) || 0);
                dispatchableByType[linenTypeCode] = Math.max(0, qty - reserveQty);
            }
        }
        const roomTypes = roomRes.roomTypes || [];
        const rows = warehouses.map((warehouse) => {
            const counts = countsByWarehouse.get(String(warehouse.id)) || {};
            const availableSetsByRoomType = {};
            for (const roomType of roomTypes) {
                availableSetsByRoomType[String(roomType.code)] = computeSetsForRoomType(counts, roomRes.reqMap.get(String(roomType.code)));
            }
            return {
                warehouse_id: warehouse.id,
                warehouse_code: warehouse.code,
                warehouse_name: warehouse.name,
                linen_capacity_sets: warehouse.linen_capacity_sets,
                is_sm: isSmWarehouseRow(warehouse),
                counts_by_sub_type: counts,
                available_sets_by_room_type: availableSetsByRoomType,
            };
        });
        const pendingReturnRows = await client.query(`SELECT i.linen_type_code,
              COALESCE(SUM(CASE WHEN m.reason = 'return_from_subwarehouse' AND m.type = 'in' THEN m.quantity ELSE 0 END),0) -
              COALESCE(SUM(CASE WHEN m.reason = 'return_to_supplier' AND m.type = 'out' THEN m.quantity ELSE 0 END),0) AS qty
       FROM stock_movements m
       JOIN inventory_items i ON i.id = m.item_id
       WHERE i.category = 'linen'
         AND m.warehouse_id = $1
       GROUP BY i.linen_type_code`, [smWarehouseId || '']);
        const pendingReturnsByType = {};
        for (const row of pendingReturnRows.rows || [])
            pendingReturnsByType[String(row.linen_type_code || '')] = Math.max(0, Number(row.qty || 0));
        return res.json({
            sm_warehouse_id: smWarehouseId || null,
            room_types: roomTypes,
            linen_items: items,
            reserve_policies: items.map((item) => ({
                item_id: item.id,
                item_name: item.name,
                item_sku: item.sku,
                linen_type_code: item.linen_type_code,
                reserve_qty: Number(reserveMap.get(String(item.id)) || 0),
            })),
            dispatchable_by_type: dispatchableByType,
            pending_returns_by_type: pendingReturnsByType,
            pending_refund_amount: Number(((_b = (_a = pendingRefundRes.rows) === null || _a === void 0 ? void 0 : _a[0]) === null || _b === void 0 ? void 0 : _b.pending_amount) || 0),
            warehouses: rows,
        });
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.get('/linen/delivery-suggestions', (0, auth_1.requirePerm)('inventory.view'), async (req, res) => {
    var _a, _b, _c, _d;
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureInventorySchema();
        const client = dbAdapter_1.pgPool;
        const dateFrom = String(((_a = req.query) === null || _a === void 0 ? void 0 : _a.date_from) || '').trim() || toDayStartIsoMelbourne(0).slice(0, 10);
        const dateTo = String(((_b = req.query) === null || _b === void 0 ? void 0 : _b.date_to) || '').trim() || toDayStartIsoMelbourne(7).slice(0, 10);
        const vehicleCapacitySets = Math.max(1, Number(((_c = req.query) === null || _c === void 0 ? void 0 : _c.vehicle_capacity_sets) || 80));
        const smWarehouse = await getSmWarehouse();
        const warehousesRes = await client.query(`SELECT id, code, name, linen_capacity_sets FROM warehouses WHERE active = true ORDER BY code ASC`);
        const warehouses = warehousesRes.rows || [];
        const smWarehouseId = String((smWarehouse === null || smWarehouse === void 0 ? void 0 : smWarehouse.id) || '');
        const [roomData, itemsRes, stocksRes, ordersRes] = await Promise.all([
            getRoomTypeRequirementMaps(client),
            client.query(`SELECT id, name, sku, linen_type_code FROM inventory_items WHERE category = 'linen' AND active = true`),
            client.query(`SELECT warehouse_id, item_id, quantity FROM warehouse_stocks WHERE item_id IN (SELECT id FROM inventory_items WHERE category = 'linen')`),
            client.query(`SELECT o.id, substring(o.checkout::text,1,10) AS checkout_day, p.id AS property_id, p.code AS property_code, p.region,
                p.room_type_code, p.linen_service_warehouse_id
         FROM orders o
         JOIN properties p ON p.id = o.property_id
         WHERE substring(o.checkout::text,1,10) >= $1
           AND substring(o.checkout::text,1,10) <= $2
           AND lower(coalesce(o.status,'')) NOT LIKE '%cancel%'
           AND lower(coalesce(o.status,'')) NOT LIKE '%void%'`, [dateFrom, dateTo]),
        ]);
        const items = itemsRes.rows || [];
        const itemMap = new Map(items.map((r) => [String(r.id), r]));
        const reserveMap = smWarehouseId ? await getLinenReserveMap(client, smWarehouseId) : new Map();
        const countsByWarehouse = new Map();
        for (const row of stocksRes.rows || []) {
            const warehouseId = String(row.warehouse_id || '');
            if (!countsByWarehouse.has(warehouseId))
                countsByWarehouse.set(warehouseId, {});
            const item = itemMap.get(String(row.item_id || ''));
            const linenTypeCode = String((item === null || item === void 0 ? void 0 : item.linen_type_code) || '');
            if (!linenTypeCode)
                continue;
            countsByWarehouse.get(warehouseId)[linenTypeCode] = Number(countsByWarehouse.get(warehouseId)[linenTypeCode] || 0) + Number(row.quantity || 0);
        }
        const dispatchableByType = {};
        for (const item of items) {
            const itemId = String(item.id);
            const linenTypeCode = String(item.linen_type_code || '');
            const qty = Number((countsByWarehouse.get(smWarehouseId) || {})[linenTypeCode] || 0);
            const reserveQty = Number(reserveMap.get(itemId) || 0);
            dispatchableByType[linenTypeCode] = Math.max(0, qty - reserveQty);
        }
        const demandMap = new Map();
        const unmatchedProperties = [];
        for (const orderRow of ordersRes.rows || []) {
            const warehouseId = resolveWarehouseForProperty(orderRow, warehouses);
            const roomTypeCode = String(orderRow.room_type_code || '');
            if (!warehouseId || !roomTypeCode) {
                unmatchedProperties.push({
                    property_id: orderRow.property_id,
                    property_code: orderRow.property_code,
                    room_type_code: roomTypeCode || null,
                    warehouse_id: warehouseId || null,
                });
                continue;
            }
            if (!demandMap.has(warehouseId))
                demandMap.set(warehouseId, new Map());
            demandMap.get(warehouseId).set(roomTypeCode, Number(demandMap.get(warehouseId).get(roomTypeCode) || 0) + 1);
        }
        const lines = [];
        let vehicleRemaining = vehicleCapacitySets;
        for (const warehouse of warehouses.filter((w) => !isSmWarehouseRow(w))) {
            const warehouseId = String(warehouse.id);
            const counts = countsByWarehouse.get(warehouseId) || {};
            for (const roomType of roomData.roomTypes || []) {
                const roomTypeCode = String(roomType.code || '');
                const currentSets = computeSetsForRoomType(counts, roomData.reqMap.get(roomTypeCode));
                const demandSets = Number(((_d = demandMap.get(warehouseId)) === null || _d === void 0 ? void 0 : _d.get(roomTypeCode)) || 0);
                const capacitySets = Number(warehouse.linen_capacity_sets || 0);
                const targetSets = capacitySets > 0 ? Math.min(capacitySets, demandSets) : demandSets;
                let suggestedSets = Math.max(0, targetSets - currentSets);
                if (suggestedSets <= 0 || vehicleRemaining <= 0)
                    continue;
                const reqs = roomData.reqMap.get(roomTypeCode);
                if (!reqs || !reqs.size)
                    continue;
                let maxByDispatchable = suggestedSets;
                for (const [linenTypeCode, quantity] of reqs.entries()) {
                    maxByDispatchable = Math.min(maxByDispatchable, Math.floor(Number(dispatchableByType[linenTypeCode] || 0) / Math.max(1, quantity)));
                }
                suggestedSets = Math.max(0, Math.min(suggestedSets, maxByDispatchable, vehicleRemaining));
                if (suggestedSets <= 0)
                    continue;
                for (const [linenTypeCode, quantity] of reqs.entries()) {
                    dispatchableByType[linenTypeCode] = Math.max(0, Number(dispatchableByType[linenTypeCode] || 0) - suggestedSets * quantity);
                }
                vehicleRemaining -= suggestedSets;
                lines.push({
                    to_warehouse_id: warehouseId,
                    to_warehouse_code: warehouse.code,
                    to_warehouse_name: warehouse.name,
                    room_type_code: roomTypeCode,
                    room_type_name: roomType.name,
                    current_sets: currentSets,
                    demand_sets: demandSets,
                    target_sets: targetSets,
                    suggested_sets: suggestedSets,
                    warehouse_capacity_sets: capacitySets || null,
                    vehicle_load_sets: suggestedSets,
                });
            }
        }
        lines.sort((a, b) => Number(b.demand_sets - b.current_sets) - Number(a.demand_sets - a.current_sets));
        return res.json({
            from_warehouse_id: smWarehouseId || null,
            from_warehouse_name: (smWarehouse === null || smWarehouse === void 0 ? void 0 : smWarehouse.name) || null,
            date_from: dateFrom,
            date_to: dateTo,
            vehicle_capacity_sets: vehicleCapacitySets,
            vehicle_remaining_sets: vehicleRemaining,
            unmatched_properties: unmatchedProperties,
            lines,
        });
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
const linenDeliveryPlanCreateSchema = zod_1.z.object({
    plan_date: zod_1.z.string().min(1),
    date_from: zod_1.z.string().optional(),
    date_to: zod_1.z.string().optional(),
    from_warehouse_id: zod_1.z.string().min(1),
    vehicle_capacity_sets: zod_1.z.number().int().min(1).optional(),
    note: zod_1.z.string().optional(),
    lines: zod_1.z.array(zod_1.z.object({
        to_warehouse_id: zod_1.z.string().min(1),
        room_type_code: zod_1.z.string().min(1),
        current_sets: zod_1.z.number().int().min(0),
        demand_sets: zod_1.z.number().int().min(0),
        target_sets: zod_1.z.number().int().min(0),
        suggested_sets: zod_1.z.number().int().min(0),
        warehouse_capacity_sets: zod_1.z.number().int().nullable().optional(),
        vehicle_load_sets: zod_1.z.number().int().min(0).optional(),
        note: zod_1.z.string().optional(),
    })).min(1),
});
exports.router.get('/linen/delivery-plans', (0, auth_1.requirePerm)('inventory.view'), async (req, res) => {
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.json([]);
        await ensureInventorySchema();
        const rows = await dbAdapter_1.pgPool.query(`SELECT p.*, fw.code AS from_warehouse_code, fw.name AS from_warehouse_name,
              COUNT(l.id)::int AS line_count,
              COALESCE(SUM(l.actual_sets),0)::int AS actual_sets_total,
              COALESCE(SUM(l.suggested_sets),0)::int AS suggested_sets_total
       FROM linen_delivery_plans p
       JOIN warehouses fw ON fw.id = p.from_warehouse_id
       LEFT JOIN linen_delivery_plan_lines l ON l.plan_id = p.id
       GROUP BY p.id, fw.code, fw.name
       ORDER BY p.plan_date DESC, p.created_at DESC
       LIMIT 100`);
        return res.json(rows.rows || []);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.post('/linen/delivery-plans', (0, auth_1.requirePerm)('inventory.move'), async (req, res) => {
    const parsed = linenDeliveryPlanCreateSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureInventorySchema();
        const body = parsed.data;
        const planId = (0, uuid_1.v4)();
        const result = await (0, dbAdapter_1.pgRunInTransaction)(async (client) => {
            var _a, _b, _c, _d, _e;
            const planRow = await client.query(`INSERT INTO linen_delivery_plans (id, plan_date, from_warehouse_id, date_from, date_to, vehicle_capacity_sets, status, note, created_by)
         VALUES ($1,$2::date,$3,NULLIF($4,'')::date,NULLIF($5,'')::date,$6,'planned',$7,$8)
         RETURNING *`, [planId, body.plan_date, body.from_warehouse_id, body.date_from || null, body.date_to || null, (_a = body.vehicle_capacity_sets) !== null && _a !== void 0 ? _a : null, body.note || null, actorId(req)]);
            const lines = [];
            for (const line of body.lines) {
                const row = await client.query(`INSERT INTO linen_delivery_plan_lines (id, plan_id, to_warehouse_id, room_type_code, current_sets, demand_sets, target_sets, suggested_sets, actual_sets, warehouse_capacity_sets, vehicle_load_sets, note)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,$9,$10,$11)
           RETURNING *`, [(0, uuid_1.v4)(), planId, line.to_warehouse_id, line.room_type_code, line.current_sets, line.demand_sets, line.target_sets, line.suggested_sets, (_b = line.warehouse_capacity_sets) !== null && _b !== void 0 ? _b : null, (_c = line.vehicle_load_sets) !== null && _c !== void 0 ? _c : line.suggested_sets, line.note || null]);
                lines.push(((_d = row.rows) === null || _d === void 0 ? void 0 : _d[0]) || null);
            }
            return { plan: ((_e = planRow.rows) === null || _e === void 0 ? void 0 : _e[0]) || null, lines };
        });
        return res.status(201).json(result);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
const linenReturnIntakeSchema = zod_1.z.object({
    from_warehouse_id: zod_1.z.string().min(1),
    quantity: zod_1.z.number().int().min(1),
    item_id: zod_1.z.string().min(1),
    note: zod_1.z.string().optional(),
});
exports.router.post('/linen/return-intakes', (0, auth_1.requirePerm)('inventory.move'), async (req, res) => {
    const parsed = linenReturnIntakeSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureInventorySchema();
        const smWarehouse = await getSmWarehouse();
        const smWarehouseId = String((smWarehouse === null || smWarehouse === void 0 ? void 0 : smWarehouse.id) || '');
        const intakeId = (0, uuid_1.v4)();
        const result = await (0, dbAdapter_1.pgRunInTransaction)(async (client) => {
            const out = await applyStockDeltaInTx(client, {
                warehouse_id: parsed.data.from_warehouse_id,
                item_id: parsed.data.item_id,
                type: 'out',
                quantity: parsed.data.quantity,
                reason: 'return_from_subwarehouse',
                ref_type: 'linen_return_intake',
                ref_id: intakeId,
                actor_id: actorId(req),
                note: parsed.data.note || null,
            });
            if (!out.ok)
                return out;
            const inn = await applyStockDeltaInTx(client, {
                warehouse_id: smWarehouseId,
                item_id: parsed.data.item_id,
                type: 'in',
                quantity: parsed.data.quantity,
                reason: 'return_from_subwarehouse',
                ref_type: 'linen_return_intake',
                ref_id: intakeId,
                actor_id: actorId(req),
                note: parsed.data.note || null,
            });
            if (!inn.ok)
                return inn;
            return { ok: true, intake_id: intakeId };
        });
        if (!(result === null || result === void 0 ? void 0 : result.ok))
            return res.status(result.code).json({ message: result.message });
        return res.status(201).json(result);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
const supplierReturnBatchSchema = zod_1.z.object({
    supplier_id: zod_1.z.string().min(1),
    warehouse_id: zod_1.z.string().optional(),
    returned_at: zod_1.z.string().optional(),
    note: zod_1.z.string().optional(),
    lines: zod_1.z.array(zod_1.z.object({
        item_id: zod_1.z.string().min(1),
        quantity: zod_1.z.number().int().min(1),
        refund_unit_price: zod_1.z.number().min(0).optional(),
        note: zod_1.z.string().optional(),
    })).min(1),
});
exports.router.get('/linen/supplier-return-batches', (0, auth_1.requirePerm)('inventory.view'), async (req, res) => {
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.json([]);
        await ensureInventorySchema();
        const rows = await dbAdapter_1.pgPool.query(`SELECT b.*, s.name AS supplier_name, w.code AS warehouse_code, w.name AS warehouse_name,
              COALESCE(SUM(l.quantity),0)::int AS quantity_total,
              COALESCE(SUM(l.amount_total),0) AS amount_total
       FROM linen_supplier_return_batches b
       JOIN suppliers s ON s.id = b.supplier_id
       JOIN warehouses w ON w.id = b.warehouse_id
       LEFT JOIN linen_supplier_return_batch_lines l ON l.batch_id = b.id
       GROUP BY b.id, s.name, w.code, w.name
       ORDER BY COALESCE(b.returned_at, b.created_at) DESC
       LIMIT 100`);
        return res.json(rows.rows || []);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.post('/linen/supplier-return-batches', (0, auth_1.requirePerm)('inventory.move'), async (req, res) => {
    const parsed = supplierReturnBatchSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureInventorySchema();
        const smWarehouse = await getSmWarehouse();
        const warehouseId = String(parsed.data.warehouse_id || (smWarehouse === null || smWarehouse === void 0 ? void 0 : smWarehouse.id) || '').trim();
        const batchId = (0, uuid_1.v4)();
        const result = await (0, dbAdapter_1.pgRunInTransaction)(async (client) => {
            var _a, _b, _c, _d;
            const priceMap = await getLatestSupplierItemPrice(client, parsed.data.supplier_id);
            const batchRow = await client.query(`INSERT INTO linen_supplier_return_batches (id, supplier_id, warehouse_id, status, returned_at, note, created_by)
         VALUES ($1,$2,$3,'returned',$4,$5,$6)
         RETURNING *`, [batchId, parsed.data.supplier_id, warehouseId, parsed.data.returned_at || new Date().toISOString(), parsed.data.note || null, actorId(req)]);
            const lines = [];
            let expectedAmount = 0;
            for (const line of parsed.data.lines) {
                const priceRow = priceMap.get(String(line.item_id));
                const refundUnitPrice = (_a = line.refund_unit_price) !== null && _a !== void 0 ? _a : (priceRow ? Number(priceRow.refund_unit_price || 0) : 0);
                const amountTotal = Number(refundUnitPrice || 0) * Number(line.quantity || 0);
                const row = await client.query(`INSERT INTO linen_supplier_return_batch_lines (id, batch_id, item_id, quantity, refund_unit_price, amount_total, note)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           RETURNING *`, [(0, uuid_1.v4)(), batchId, line.item_id, line.quantity, refundUnitPrice, amountTotal, line.note || null]);
                lines.push(((_b = row.rows) === null || _b === void 0 ? void 0 : _b[0]) || null);
                expectedAmount += amountTotal;
                const applied = await applyStockDeltaInTx(client, {
                    warehouse_id: warehouseId,
                    item_id: line.item_id,
                    type: 'out',
                    quantity: line.quantity,
                    reason: 'return_to_supplier',
                    actor_id: actorId(req),
                    note: parsed.data.note || null,
                    ref_type: 'linen_supplier_return_batch',
                    ref_id: batchId,
                });
                if (!applied.ok)
                    return applied;
            }
            const refundRow = await client.query(`INSERT INTO linen_supplier_refunds (id, batch_id, supplier_id, warehouse_id, expected_amount, received_amount, variance_amount, status, note, updated_at)
         VALUES ($1,$2,$3,$4,$5,0,$6,'pending',$7,now())
         RETURNING *`, [(0, uuid_1.v4)(), batchId, parsed.data.supplier_id, warehouseId, expectedAmount, 0 - expectedAmount, parsed.data.note || null]);
            await client.query(`UPDATE linen_supplier_return_batches SET updated_at = now() WHERE id = $1`, [batchId]);
            return { ok: true, batch: ((_c = batchRow.rows) === null || _c === void 0 ? void 0 : _c[0]) || null, lines, refund: ((_d = refundRow.rows) === null || _d === void 0 ? void 0 : _d[0]) || null };
        });
        if (!(result === null || result === void 0 ? void 0 : result.ok))
            return res.status(result.code).json({ message: result.message });
        return res.status(201).json(result);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.get('/linen/supplier-refunds', (0, auth_1.requirePerm)('inventory.view'), async (req, res) => {
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.json([]);
        await ensureInventorySchema();
        const rows = await dbAdapter_1.pgPool.query(`SELECT r.*, s.name AS supplier_name, w.code AS warehouse_code, w.name AS warehouse_name
       FROM linen_supplier_refunds r
       JOIN suppliers s ON s.id = r.supplier_id
       JOIN warehouses w ON w.id = r.warehouse_id
       ORDER BY r.created_at DESC
       LIMIT 100`);
        return res.json(rows.rows || []);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
const supplierRefundPatchSchema = zod_1.z.object({
    received_amount: zod_1.z.number().min(0).optional(),
    status: zod_1.z.enum(['pending', 'partial', 'settled', 'disputed']).optional(),
    received_at: zod_1.z.string().optional(),
    note: zod_1.z.string().optional(),
});
exports.router.patch('/linen/supplier-refunds/:id', (0, auth_1.requirePerm)('inventory.po.manage'), async (req, res) => {
    var _a, _b, _c;
    const parsed = supplierRefundPatchSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureInventorySchema();
        const id = String(req.params.id || '');
        const before = await dbAdapter_1.pgPool.query(`SELECT * FROM linen_supplier_refunds WHERE id = $1`, [id]);
        const row = (_a = before.rows) === null || _a === void 0 ? void 0 : _a[0];
        if (!row)
            return res.status(404).json({ message: 'not found' });
        const nextReceivedAmount = (_b = parsed.data.received_amount) !== null && _b !== void 0 ? _b : Number(row.received_amount || 0);
        const expectedAmount = Number(row.expected_amount || 0);
        let nextStatus = parsed.data.status;
        if (!nextStatus) {
            if (nextReceivedAmount <= 0)
                nextStatus = 'pending';
            else if (Math.abs(nextReceivedAmount - expectedAmount) < 0.0001)
                nextStatus = 'settled';
            else if (nextReceivedAmount < expectedAmount)
                nextStatus = 'partial';
            else
                nextStatus = 'disputed';
        }
        const updated = await dbAdapter_1.pgPool.query(`UPDATE linen_supplier_refunds
       SET received_amount = $1,
           variance_amount = $1 - expected_amount,
           status = $2,
           received_at = COALESCE(NULLIF($3,'')::timestamptz, received_at),
           note = COALESCE($4, note),
           updated_at = now()
       WHERE id = $5
       RETURNING *`, [nextReceivedAmount, nextStatus, parsed.data.received_at || null, parsed.data.note || null, id]);
        return res.json(((_c = updated.rows) === null || _c === void 0 ? void 0 : _c[0]) || null);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
