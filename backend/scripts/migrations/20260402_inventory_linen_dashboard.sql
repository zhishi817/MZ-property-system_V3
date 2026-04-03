-- Inventory: linen dashboard + transfer photos + stock change requests

ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS sub_type text;
CREATE INDEX IF NOT EXISTS idx_inventory_items_category_sub_type ON inventory_items(category, sub_type);

ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS photo_url text;

CREATE TABLE IF NOT EXISTS stock_change_requests (
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
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_change_requests_type_check') THEN
    ALTER TABLE stock_change_requests
      ADD CONSTRAINT stock_change_requests_type_check
      CHECK (type IN ('out'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_change_requests_status_check') THEN
    ALTER TABLE stock_change_requests
      ADD CONSTRAINT stock_change_requests_status_check
      CHECK (status IN ('pending','approved','rejected'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_stock_change_requests_status ON stock_change_requests(status);
CREATE INDEX IF NOT EXISTS idx_stock_change_requests_reason ON stock_change_requests(reason);
CREATE INDEX IF NOT EXISTS idx_stock_change_requests_wh ON stock_change_requests(warehouse_id);
CREATE INDEX IF NOT EXISTS idx_stock_change_requests_item ON stock_change_requests(item_id);
CREATE INDEX IF NOT EXISTS idx_stock_change_requests_created_at ON stock_change_requests(created_at);

ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS region text;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS property_id text;
CREATE INDEX IF NOT EXISTS idx_purchase_orders_region ON purchase_orders(region);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_property ON purchase_orders(property_id);

