-- orders uniqueness
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

DO $$ BEGIN
  BEGIN
    CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_confirmation_code_unique ON orders(confirmation_code);
  EXCEPTION WHEN others THEN NULL;
  END;
END $$;

-- email_sync_items status check constraint (optional, tolerant)
DO $$ BEGIN
  BEGIN
    ALTER TABLE email_sync_items ADD CONSTRAINT chk_email_sync_items_status CHECK (status IN ('scanned','matched','raw_saved','parsed','mapped','inserted','updated','skipped','failed'));
  EXCEPTION WHEN others THEN NULL;
  END;
END $$;

-- email_orders_raw uniqueness already ensured by ensureEmailSyncItemsTables
