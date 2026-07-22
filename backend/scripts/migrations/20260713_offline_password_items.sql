-- Repurpose the existing encrypted secret-item storage for offline physical passwords.
-- Existing rows stay classified as legacy and are not exposed by the offline-password UI.
ALTER TABLE company_secret_items ADD COLUMN IF NOT EXISTS item_type text NOT NULL DEFAULT 'legacy';
ALTER TABLE company_secret_items ADD COLUMN IF NOT EXISTS property_code text;
ALTER TABLE company_secret_items ADD COLUMN IF NOT EXISTS property_codes text[];
ALTER TABLE company_secret_items ADD COLUMN IF NOT EXISTS property_ids text[];
ALTER TABLE company_secret_items ADD COLUMN IF NOT EXISTS secret_kind text;
ALTER TABLE company_secret_items ADD COLUMN IF NOT EXISTS box_number text;
ALTER TABLE company_secret_items ADD COLUMN IF NOT EXISTS location text;
ALTER TABLE company_secret_items ADD COLUMN IF NOT EXISTS rotation_interval_days integer;
ALTER TABLE company_secret_items ADD COLUMN IF NOT EXISTS next_rotation_at date;
ALTER TABLE company_secret_items ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';

CREATE INDEX IF NOT EXISTS idx_company_secret_items_type_updated
  ON company_secret_items(item_type, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_company_secret_items_property
  ON company_secret_items(property_code);
