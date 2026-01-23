BEGIN;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS confirmation_code text;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_orders_source_confirmation_code_unique') THEN DROP INDEX idx_orders_source_confirmation_code_unique; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_orders_conf_pid_unique') THEN DROP INDEX idx_orders_conf_pid_unique; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_confirmation_code_unique ON orders(confirmation_code) WHERE confirmation_code IS NOT NULL;
COMMIT;
