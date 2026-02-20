-- cleaning_tasks sync migration (order_id nullable, unified status, management flags)
BEGIN;

-- Columns
ALTER TABLE IF EXISTS cleaning_tasks
  ADD COLUMN IF NOT EXISTS order_id text,
  ADD COLUMN IF NOT EXISTS type text DEFAULT 'checkout_cleaning',
  ADD COLUMN IF NOT EXISTS auto_managed boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS locked boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS reschedule_required boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS started_at timestamptz,
  ADD COLUMN IF NOT EXISTS finished_at timestamptz,
  ADD COLUMN IF NOT EXISTS key_photo_uploaded_at timestamptz,
  ADD COLUMN IF NOT EXISTS lockbox_video_uploaded_at timestamptz,
  ADD COLUMN IF NOT EXISTS geo_lat double precision,
  ADD COLUMN IF NOT EXISTS geo_lng double precision,
  ADD COLUMN IF NOT EXISTS cleaned boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS restocked boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS inspected boolean DEFAULT false;

-- Partial unique index for derived tasks only (order-linked)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'uniq_cleaning_tasks_order_type'
  ) THEN
    CREATE UNIQUE INDEX uniq_cleaning_tasks_order_type ON cleaning_tasks(order_id, type) WHERE order_id IS NOT NULL;
  END IF;
END $$;

-- Helpful indexes
CREATE INDEX IF NOT EXISTS idx_cleaning_tasks_property_date ON cleaning_tasks(property_id, date);
CREATE INDEX IF NOT EXISTS idx_cleaning_tasks_status ON cleaning_tasks(status);

COMMIT;
