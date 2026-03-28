-- Inventory: multi-warehouse + PO (linen suppliers) + property traceability

CREATE TABLE IF NOT EXISTS warehouses (
  id text PRIMARY KEY,
  code text NOT NULL,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'unique_warehouses_code') THEN
    ALTER TABLE warehouses ADD CONSTRAINT unique_warehouses_code UNIQUE (code);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS inventory_items (
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
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'unique_inventory_items_sku') THEN
    ALTER TABLE inventory_items ADD CONSTRAINT unique_inventory_items_sku UNIQUE (sku);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_inventory_items_category ON inventory_items(category);
CREATE INDEX IF NOT EXISTS idx_inventory_items_active ON inventory_items(active);

CREATE TABLE IF NOT EXISTS warehouse_stocks (
  id text PRIMARY KEY,
  warehouse_id text NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  item_id text NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  quantity integer NOT NULL DEFAULT 0,
  threshold integer,
  updated_at timestamptz
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'unique_warehouse_item') THEN
    ALTER TABLE warehouse_stocks ADD CONSTRAINT unique_warehouse_item UNIQUE (warehouse_id, item_id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_warehouse_stocks_wh ON warehouse_stocks(warehouse_id);
CREATE INDEX IF NOT EXISTS idx_warehouse_stocks_item ON warehouse_stocks(item_id);

CREATE TABLE IF NOT EXISTS suppliers (
  id text PRIMARY KEY,
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'linen',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_suppliers_active ON suppliers(active);

CREATE TABLE IF NOT EXISTS region_supplier_rules (
  id text PRIMARY KEY,
  region_key text NOT NULL,
  supplier_id text NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  priority integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_region_supplier_rules_region ON region_supplier_rules(region_key);
CREATE INDEX IF NOT EXISTS idx_region_supplier_rules_active ON region_supplier_rules(active);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id text PRIMARY KEY,
  supplier_id text NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  warehouse_id text NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'draft',
  requested_delivery_date date,
  note text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_supplier ON purchase_orders(supplier_id);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_warehouse ON purchase_orders(warehouse_id);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_status ON purchase_orders(status);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_created_at ON purchase_orders(created_at);

CREATE TABLE IF NOT EXISTS purchase_order_lines (
  id text PRIMARY KEY,
  po_id text NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  item_id text NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
  quantity integer NOT NULL,
  unit text NOT NULL,
  unit_price numeric,
  note text
);
CREATE INDEX IF NOT EXISTS idx_purchase_order_lines_po ON purchase_order_lines(po_id);
CREATE INDEX IF NOT EXISTS idx_purchase_order_lines_item ON purchase_order_lines(item_id);

CREATE TABLE IF NOT EXISTS purchase_deliveries (
  id text PRIMARY KEY,
  po_id text NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  received_at timestamptz NOT NULL DEFAULT now(),
  received_by text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_purchase_deliveries_po ON purchase_deliveries(po_id);
CREATE INDEX IF NOT EXISTS idx_purchase_deliveries_received_at ON purchase_deliveries(received_at);

CREATE TABLE IF NOT EXISTS purchase_delivery_lines (
  id text PRIMARY KEY,
  delivery_id text NOT NULL REFERENCES purchase_deliveries(id) ON DELETE CASCADE,
  item_id text NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
  quantity_received integer NOT NULL,
  note text
);
CREATE INDEX IF NOT EXISTS idx_purchase_delivery_lines_delivery ON purchase_delivery_lines(delivery_id);

CREATE TABLE IF NOT EXISTS stock_movements (
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
);
CREATE INDEX IF NOT EXISTS idx_stock_movements_wh ON stock_movements(warehouse_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_item ON stock_movements(item_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_property ON stock_movements(property_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_created_at ON stock_movements(created_at);
CREATE INDEX IF NOT EXISTS idx_stock_movements_ref ON stock_movements(ref_type, ref_id);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'stock_movements_type_check'
  ) THEN
    ALTER TABLE stock_movements
      ADD CONSTRAINT stock_movements_type_check
      CHECK (type IN ('in','out','adjust'));
  END IF;
END $$;

-- Seed: 4 warehouses
INSERT INTO warehouses (id, code, name) VALUES
  ('wh.south_melbourne', 'SOU', 'South Melbourne'),
  ('wh.msq', 'MSQ', 'MSQ'),
  ('wh.wsp', 'WSP', 'WSP'),
  ('wh.my80', 'MY80', 'My80')
ON CONFLICT (id) DO NOTHING;

-- Seed: 2 linen suppliers
INSERT INTO suppliers (id, name, kind) VALUES
  ('sup.linen.1', '床品供应商1', 'linen'),
  ('sup.linen.2', '床品供应商2', 'linen')
ON CONFLICT (id) DO NOTHING;

-- Seed: region -> supplier rules (exact match then fallback '*')
INSERT INTO region_supplier_rules (id, region_key, supplier_id, priority) VALUES
  ('rsr.southbank', 'Southbank', 'sup.linen.1', 100),
  ('rsr.default', '*', 'sup.linen.2', 0)
ON CONFLICT (id) DO NOTHING;

