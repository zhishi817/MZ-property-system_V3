CREATE TABLE IF NOT EXISTS property_daily_necessities (
  id text PRIMARY KEY,
  property_id text,
  created_by text,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS property_code text;
ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS status text;
ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS item_name text;
ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS quantity integer;
ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS note text;
ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS photo_urls jsonb;
ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS before_photo_urls jsonb;
ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS after_photo_urls jsonb;
ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS source_task_id text;
ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS submitted_at timestamptz;
ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS submitter_name text;
ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS dedup_fingerprint text;
ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS item_id text;
ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS replacement_at timestamptz;
ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS replacer_name text;
ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS pay_method text;
ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_property_daily_necessities_prop ON property_daily_necessities(property_id);
CREATE INDEX IF NOT EXISTS idx_property_daily_necessities_status ON property_daily_necessities(status);
CREATE INDEX IF NOT EXISTS idx_property_daily_necessities_pay_method ON property_daily_necessities(pay_method);
CREATE INDEX IF NOT EXISTS idx_property_daily_necessities_created_at ON property_daily_necessities(created_at);
CREATE INDEX IF NOT EXISTS idx_property_daily_necessities_dedup ON property_daily_necessities(property_id, dedup_fingerprint, submitted_at);
