-- Merge repair_orders into property_maintenance (keep property_maintenance as unified store)
-- 1) Backup
CREATE TABLE IF NOT EXISTS property_maintenance_backup AS TABLE property_maintenance WITH NO DATA;
INSERT INTO property_maintenance_backup SELECT * FROM property_maintenance;

-- 2) Extend property_maintenance with unified workflow columns
ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS work_no text;
ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS category text;
ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS status text;
ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS urgency text;
ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS assignee_id text;
ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS eta date;
ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS completed_at timestamptz;
ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS submitted_at timestamptz;
ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS repair_notes text;
ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS repair_photo_urls jsonb;

-- 3) Migrate data from repair_orders
INSERT INTO property_maintenance (
  id, property_id, occurred_at, worker_name,
  details, notes, created_by, photo_urls, property_code,
  work_no, category, status, urgency, assignee_id, eta, completed_at, submitted_at,
  repair_notes, repair_photo_urls
)
SELECT
  r.id,
  r.property_id,
  COALESCE(r.submitted_at::date, now()::date),
  NULL, -- worker_name unknown in orders
  r.detail::text, -- store raw detail text as details
  r.remark::text, -- map remark -> notes
  r.submitter_id, -- creator id
  r.attachment_urls, -- initial photos
  NULL,
  ('R-' || to_char(COALESCE(r.submitted_at, now()), 'YYYYMMDD') || '-' || substr(r.id, 1, 4)),
  r.category,
  r.status,
  r.urgency,
  r.assignee_id,
  r.eta,
  r.completed_at,
  COALESCE(r.submitted_at, now()),
  NULL,
  r.attachment_urls
FROM repair_orders r
ON CONFLICT (id) DO NOTHING;

-- 4) Index optimize
CREATE INDEX IF NOT EXISTS idx_pm_work_no ON property_maintenance(work_no);
CREATE INDEX IF NOT EXISTS idx_pm_status ON property_maintenance(status);
CREATE INDEX IF NOT EXISTS idx_pm_urgency ON property_maintenance(urgency);
CREATE INDEX IF NOT EXISTS idx_pm_submitted ON property_maintenance(submitted_at);
CREATE INDEX IF NOT EXISTS idx_pm_eta ON property_maintenance(eta);

-- 5) Drop old table if desired (comment out for dry-run)
-- DROP TABLE IF EXISTS repair_orders;
