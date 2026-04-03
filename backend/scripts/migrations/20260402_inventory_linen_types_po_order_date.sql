-- Inventory: linen types (dynamic) + PO order date

CREATE TABLE IF NOT EXISTS inventory_linen_types (
  code text PRIMARY KEY,
  name text NOT NULL,
  in_set boolean NOT NULL DEFAULT true,
  set_divisor integer NOT NULL DEFAULT 1,
  sort_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_inventory_linen_types_active_sort ON inventory_linen_types(active, sort_order, code);

INSERT INTO inventory_linen_types (code, name, in_set, set_divisor, sort_order, active) VALUES
  ('bedsheet','床单',true,1,10,true),
  ('duvet_cover','被套',true,1,20,true),
  ('pillowcase','枕套',true,2,30,true),
  ('bath_towel','浴巾',true,1,40,true)
ON CONFLICT (code) DO NOTHING;

ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS linen_type_code text;
CREATE INDEX IF NOT EXISTS idx_inventory_items_linen_type ON inventory_items(linen_type_code);

ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS ordered_date date;
CREATE INDEX IF NOT EXISTS idx_purchase_orders_ordered_date ON purchase_orders(ordered_date);

