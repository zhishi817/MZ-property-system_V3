BEGIN;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS email_header_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS year_inferred boolean;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS raw_checkin_text text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS raw_checkout_text text;
COMMIT;
