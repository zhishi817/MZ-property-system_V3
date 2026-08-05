BEGIN;

CREATE TABLE IF NOT EXISTS property_deep_cleaning (
  id text PRIMARY KEY,
  property_id text,
  occurred_at date,
  details text,
  notes text,
  created_by text,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS property_code text;
ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS status text;
ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS submitted_at timestamptz;
ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS submitter_name text;
ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS project_desc text;
ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS started_at timestamptz;
ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS ended_at timestamptz;
ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS duration_minutes integer;
ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS photo_urls jsonb;
ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS repair_photo_urls jsonb;
ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS repair_notes text;
ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS attachment_urls jsonb;
ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS work_no text;
ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS completed_at timestamptz;
ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS updated_at timestamptz;
ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS review_status text;
ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS reviewed_by text;
ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS review_notes text;
ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS project_items jsonb;
ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS invoice_description_en text;
ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS dedup_fingerprint text;
ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS client_item_id text;

CREATE INDEX IF NOT EXISTS idx_property_deep_cleaning_dedup
  ON property_deep_cleaning(property_id, dedup_fingerprint, submitted_at);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_property_deep_cleaning_client_item
  ON property_deep_cleaning(property_id, client_item_id)
  WHERE client_item_id IS NOT NULL;

COMMIT;
