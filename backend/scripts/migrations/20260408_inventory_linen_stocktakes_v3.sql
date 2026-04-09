-- Inventory linen stocktakes v3: stocktake-driven sub-warehouse availability

CREATE TABLE IF NOT EXISTS linen_stocktake_records (
  id text PRIMARY KEY,
  warehouse_id text NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  delivery_record_id text REFERENCES linen_delivery_records(id) ON DELETE SET NULL,
  stocktake_date date NOT NULL,
  dirty_bag_note text,
  note text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_linen_stocktake_records_wh_date
ON linen_stocktake_records(warehouse_id, stocktake_date DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_linen_stocktake_records_delivery_record
ON linen_stocktake_records(delivery_record_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_linen_stocktake_records_delivery_record_unique
ON linen_stocktake_records(delivery_record_id)
WHERE delivery_record_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS linen_stocktake_record_lines (
  id text PRIMARY KEY,
  record_id text NOT NULL REFERENCES linen_stocktake_records(id) ON DELETE CASCADE,
  room_type_code text NOT NULL REFERENCES inventory_room_types(code) ON DELETE RESTRICT,
  remaining_sets integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_linen_stocktake_record_lines_record
ON linen_stocktake_record_lines(record_id);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'linen_stocktake_record_lines_unique_room_type') THEN
    ALTER TABLE linen_stocktake_record_lines
      ADD CONSTRAINT linen_stocktake_record_lines_unique_room_type
      UNIQUE (record_id, room_type_code);
  END IF;
END $$;
