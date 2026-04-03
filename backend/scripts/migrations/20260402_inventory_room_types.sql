-- Inventory: room types + per-room-type linen requirements + bind properties.room_type_code

CREATE TABLE IF NOT EXISTS inventory_room_types (
  code text PRIMARY KEY,
  name text NOT NULL,
  bedrooms integer,
  bathrooms integer,
  sort_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_inventory_room_types_active_sort ON inventory_room_types(active, sort_order, code);

CREATE TABLE IF NOT EXISTS inventory_room_type_requirements (
  room_type_code text NOT NULL REFERENCES inventory_room_types(code) ON DELETE CASCADE,
  linen_type_code text NOT NULL REFERENCES inventory_linen_types(code) ON DELETE RESTRICT,
  quantity integer NOT NULL,
  PRIMARY KEY (room_type_code, linen_type_code)
);
CREATE INDEX IF NOT EXISTS idx_inventory_room_type_req_room ON inventory_room_type_requirements(room_type_code);

ALTER TABLE properties ADD COLUMN IF NOT EXISTS room_type_code text;
CREATE INDEX IF NOT EXISTS idx_properties_room_type_code ON properties(room_type_code);

-- Optional: seed common room types (adjust to your naming)
INSERT INTO inventory_room_types (code, name, bedrooms, bathrooms, sort_order, active) VALUES
  ('1b1b', '一房一卫', 1, 1, 10, true),
  ('2b1b', '两房一卫', 2, 1, 20, true),
  ('2b2b', '两房两卫', 2, 2, 30, true),
  ('3b2b', '三房两卫', 3, 2, 40, true),
  ('3b3b', '三房三卫', 3, 3, 50, true)
ON CONFLICT (code) DO NOTHING;

-- Optional: seed requirements (example only; please confirm quantities)
-- INSERT INTO inventory_room_type_requirements (room_type_code, linen_type_code, quantity) VALUES
--   ('1b1b','bedsheet',1),('1b1b','duvet_cover',1),('1b1b','pillowcase',2),('1b1b','bath_towel',2)
-- ON CONFLICT (room_type_code, linen_type_code) DO NOTHING;
