-- Inventory linen upgrade: reserve stock, supplier prices, delivery plans, supplier returns/refunds

ALTER TABLE inventory_linen_types
ADD COLUMN IF NOT EXISTS psl_code text;

ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS linen_capacity_sets integer;

ALTER TABLE properties ADD COLUMN IF NOT EXISTS linen_service_warehouse_id text;

CREATE TABLE IF NOT EXISTS inventory_stock_policies (
  id text PRIMARY KEY,
  warehouse_id text NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  item_id text NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  reserve_qty integer NOT NULL DEFAULT 0,
  updated_at timestamptz
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'unique_inventory_stock_policy') THEN
    ALTER TABLE inventory_stock_policies ADD CONSTRAINT unique_inventory_stock_policy UNIQUE (warehouse_id, item_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_inventory_stock_policies_wh ON inventory_stock_policies(warehouse_id);
CREATE INDEX IF NOT EXISTS idx_inventory_stock_policies_item ON inventory_stock_policies(item_id);

CREATE TABLE IF NOT EXISTS supplier_item_prices (
  id text PRIMARY KEY,
  supplier_id text NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  item_id text NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  linen_type_code text,
  purchase_unit_price numeric NOT NULL DEFAULT 0,
  refund_unit_price numeric NOT NULL DEFAULT 0,
  effective_from date,
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz
);

ALTER TABLE supplier_item_prices
ADD COLUMN IF NOT EXISTS linen_type_code text;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'unique_supplier_item_price') THEN
    ALTER TABLE supplier_item_prices ADD CONSTRAINT unique_supplier_item_price UNIQUE (supplier_id, item_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_supplier_item_prices_supplier ON supplier_item_prices(supplier_id);
CREATE INDEX IF NOT EXISTS idx_supplier_item_prices_item ON supplier_item_prices(item_id);
CREATE INDEX IF NOT EXISTS idx_supplier_item_prices_linen_type_code ON supplier_item_prices(linen_type_code);

UPDATE supplier_item_prices sip
SET linen_type_code = i.linen_type_code
FROM inventory_items i
WHERE i.id = sip.item_id
  AND COALESCE(sip.linen_type_code, '') = '';

ALTER TABLE purchase_order_lines ADD COLUMN IF NOT EXISTS amount_total numeric;

ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS po_no text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_purchase_orders_po_no_unique
ON purchase_orders (po_no)
WHERE po_no IS NOT NULL;

UPDATE purchase_orders
SET po_no = 'PO-' || to_char(COALESCE(ordered_date, created_at::date), 'YYMMDD') || '-' || upper(substr(md5(id), 1, 4))
WHERE COALESCE(po_no, '') = '';

CREATE TABLE IF NOT EXISTS linen_delivery_plans (
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
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'linen_delivery_plans_status_check') THEN
    ALTER TABLE linen_delivery_plans
      ADD CONSTRAINT linen_delivery_plans_status_check
      CHECK (status IN ('draft','planned','dispatched','cancelled'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_linen_delivery_plans_plan_date ON linen_delivery_plans(plan_date DESC);

CREATE TABLE IF NOT EXISTS linen_delivery_plan_lines (
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
);

CREATE INDEX IF NOT EXISTS idx_linen_delivery_plan_lines_plan ON linen_delivery_plan_lines(plan_id);

CREATE TABLE IF NOT EXISTS linen_supplier_return_batches (
  id text PRIMARY KEY,
  supplier_id text NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  warehouse_id text NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'draft',
  returned_at timestamptz,
  note text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'linen_supplier_return_batches_status_check') THEN
    ALTER TABLE linen_supplier_return_batches
      ADD CONSTRAINT linen_supplier_return_batches_status_check
      CHECK (status IN ('draft','returned','settled'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_linen_supplier_return_batches_supplier ON linen_supplier_return_batches(supplier_id);

CREATE TABLE IF NOT EXISTS linen_supplier_return_batch_lines (
  id text PRIMARY KEY,
  batch_id text NOT NULL REFERENCES linen_supplier_return_batches(id) ON DELETE CASCADE,
  item_id text NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
  quantity integer NOT NULL,
  refund_unit_price numeric NOT NULL DEFAULT 0,
  amount_total numeric NOT NULL DEFAULT 0,
  note text
);

CREATE INDEX IF NOT EXISTS idx_linen_supplier_return_batch_lines_batch ON linen_supplier_return_batch_lines(batch_id);

CREATE TABLE IF NOT EXISTS linen_supplier_refunds (
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
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'linen_supplier_refunds_status_check') THEN
    ALTER TABLE linen_supplier_refunds
      ADD CONSTRAINT linen_supplier_refunds_status_check
      CHECK (status IN ('pending','partial','settled','disputed'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_linen_supplier_refunds_supplier ON linen_supplier_refunds(supplier_id);
CREATE INDEX IF NOT EXISTS idx_linen_supplier_refunds_status ON linen_supplier_refunds(status);

UPDATE warehouses
SET linen_capacity_sets = CASE
  WHEN id = 'wh.south_melbourne' THEN COALESCE(linen_capacity_sets, 500)
  WHEN id = 'wh.msq' THEN COALESCE(linen_capacity_sets, 120)
  WHEN id = 'wh.wsp' THEN COALESCE(linen_capacity_sets, 120)
  WHEN id = 'wh.my80' THEN COALESCE(linen_capacity_sets, 100)
  ELSE linen_capacity_sets
END;

ALTER TABLE purchase_orders
ADD COLUMN IF NOT EXISTS subtotal_amount numeric NOT NULL DEFAULT 0;

ALTER TABLE purchase_orders
ADD COLUMN IF NOT EXISTS gst_amount numeric NOT NULL DEFAULT 0;

ALTER TABLE purchase_orders
ADD COLUMN IF NOT EXISTS total_amount_inc_gst numeric NOT NULL DEFAULT 0;

WITH po_totals AS (
  SELECT
    po.id,
    COALESCE(SUM(COALESCE(pol.amount_total, 0)), 0)::numeric AS subtotal_amount
  FROM purchase_orders po
  LEFT JOIN purchase_order_lines pol ON pol.po_id = po.id
  GROUP BY po.id
)
UPDATE purchase_orders po
SET subtotal_amount = t.subtotal_amount,
    gst_amount = ROUND(t.subtotal_amount * 0.1, 2),
    total_amount_inc_gst = ROUND(t.subtotal_amount * 1.1, 2)
FROM po_totals t
WHERE t.id = po.id;
