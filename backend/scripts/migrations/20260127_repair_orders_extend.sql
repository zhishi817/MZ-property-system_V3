-- Extend repair_orders for unified workflow
ALTER TABLE repair_orders ADD COLUMN IF NOT EXISTS work_no text;
ALTER TABLE repair_orders ADD COLUMN IF NOT EXISTS repair_notes text;
ALTER TABLE repair_orders ADD COLUMN IF NOT EXISTS repair_photo_urls jsonb;
ALTER TABLE repair_orders ADD COLUMN IF NOT EXISTS started_at timestamptz;
-- Helpful indexes
CREATE INDEX IF NOT EXISTS idx_repair_orders_work_no ON repair_orders(work_no);
CREATE INDEX IF NOT EXISTS idx_repair_orders_started ON repair_orders(started_at);
