ALTER TABLE property_maintenance
  ADD COLUMN IF NOT EXISTS work_no text,
  ADD COLUMN IF NOT EXISTS category text,
  ADD COLUMN IF NOT EXISTS category_detail text,
  ADD COLUMN IF NOT EXISTS status text,
  ADD COLUMN IF NOT EXISTS urgency text,
  ADD COLUMN IF NOT EXISTS submitter_name text,
  ADD COLUMN IF NOT EXISTS assignee_id text,
  ADD COLUMN IF NOT EXISTS eta date,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS submitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS repair_notes text,
  ADD COLUMN IF NOT EXISTS maintenance_amount numeric,
  ADD COLUMN IF NOT EXISTS has_parts boolean,
  ADD COLUMN IF NOT EXISTS parts_amount numeric,
  ADD COLUMN IF NOT EXISTS maintenance_amount_includes_parts boolean,
  ADD COLUMN IF NOT EXISTS has_gst boolean,
  ADD COLUMN IF NOT EXISTS maintenance_amount_includes_gst boolean,
  ADD COLUMN IF NOT EXISTS pay_method text,
  ADD COLUMN IF NOT EXISTS pay_other_note text,
  ADD COLUMN IF NOT EXISTS property_code text,
  ADD COLUMN IF NOT EXISTS started_at timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz;

ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS photo_urls jsonb;
ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS repair_photo_urls jsonb;

CREATE INDEX IF NOT EXISTS idx_pm_work_no ON property_maintenance(work_no);
CREATE INDEX IF NOT EXISTS idx_pm_status ON property_maintenance(status);
CREATE INDEX IF NOT EXISTS idx_pm_urgency ON property_maintenance(urgency);
CREATE INDEX IF NOT EXISTS idx_pm_submitted ON property_maintenance(submitted_at);
CREATE INDEX IF NOT EXISTS idx_pm_eta ON property_maintenance(eta);
