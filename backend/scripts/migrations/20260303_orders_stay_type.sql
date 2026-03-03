ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS stay_type text NOT NULL DEFAULT 'guest';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_stay_type_check'
  ) THEN
    ALTER TABLE orders
      ADD CONSTRAINT orders_stay_type_check
      CHECK (stay_type IN ('guest', 'owner'));
  END IF;
END $$;
