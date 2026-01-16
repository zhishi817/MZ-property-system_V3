-- Fix email sync db_error issues caused by overly strict constraints

-- 1) Drop the confirmation_code unique index if it exists.
--    We currently rely on idempotency_key for deduplication in the
--    email-import pipeline. A global unique index on confirmation_code
--    can cause inserts from different sources to fail with
--    "duplicate key" errors, which surface as db_error in the
--    email_sync_items table.

DO $$ BEGIN
  BEGIN
    DROP INDEX IF EXISTS idx_orders_confirmation_code_unique;
  EXCEPTION WHEN others THEN NULL;
  END;
END $$;

-- 2) Ensure the idempotency_key unique index still exists for
--    deduplication of repeated email imports.

DO $$ BEGIN
  BEGIN
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS idempotency_key text;
  EXCEPTION WHEN others THEN NULL;
  END;
END $$;

DO $$ BEGIN
  BEGIN
    CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_idempotency_key_unique ON orders(idempotency_key);
  EXCEPTION WHEN others THEN NULL;
  END;
END $$;

