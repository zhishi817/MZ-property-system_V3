BEGIN;

-- Internal maintenance remains in property_maintenance. New records will be
-- created only from a feedback source in a later workflow/API phase.
ALTER TABLE property_maintenance
  ADD COLUMN IF NOT EXISTS feedback_source text NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS source_task_id text,
  ADD COLUMN IF NOT EXISTS property_code text,
  ADD COLUMN IF NOT EXISTS status text,
  ADD COLUMN IF NOT EXISTS assignee_id text,
  ADD COLUMN IF NOT EXISTS eta date,
  ADD COLUMN IF NOT EXISTS assigned_at timestamptz,
  ADD COLUMN IF NOT EXISTS assigned_by text,
  ADD COLUMN IF NOT EXISTS started_at timestamptz,
  ADD COLUMN IF NOT EXISTS submitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS submitter_name text,
  ADD COLUMN IF NOT EXISTS completion_photo_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS photo_urls jsonb,
  ADD COLUMN IF NOT EXISTS repair_photo_urls jsonb,
  ADD COLUMN IF NOT EXISTS repair_notes text,
  ADD COLUMN IF NOT EXISTS area text,
  ADD COLUMN IF NOT EXISTS work_no text,
  ADD COLUMN IF NOT EXISTS category_detail text,
  ADD COLUMN IF NOT EXISTS project_items jsonb,
  ADD COLUMN IF NOT EXISTS invoice_description_en text,
  ADD COLUMN IF NOT EXISTS dedup_fingerprint text,
  ADD COLUMN IF NOT EXISTS client_item_id text,
  ADD COLUMN IF NOT EXISTS review_status text,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS reviewed_by text,
  ADD COLUMN IF NOT EXISTS review_note text,
  ADD COLUMN IF NOT EXISTS review_notes text,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS closed_at timestamptz,
  ADD COLUMN IF NOT EXISTS closed_by text,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_by text,
  ADD COLUMN IF NOT EXISTS cancel_reason text,
  ADD COLUMN IF NOT EXISTS reopened_at timestamptz,
  ADD COLUMN IF NOT EXISTS reopened_by text,
  ADD COLUMN IF NOT EXISTS reopen_reason text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_property_maintenance_dedup
  ON property_maintenance(property_id, dedup_fingerprint, submitted_at);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_property_maintenance_client_item
  ON property_maintenance(property_id, client_item_id)
  WHERE client_item_id IS NOT NULL;

-- External jobs deliberately do not reference properties: they represent
-- third-party apartments and must remain separate from managed inventory.
CREATE TABLE IF NOT EXISTS external_maintenance_orders (
  id text PRIMARY KEY,
  order_no text,
  client_name text NOT NULL DEFAULT '',
  client_contact_name text,
  client_contact_phone text,
  client_contact_email text,
  site_name text NOT NULL DEFAULT '',
  site_address text,
  access_notes text,
  external_reference text,
  source_channel text NOT NULL DEFAULT 'external_manual',
  requested_at date,
  scheduled_date date,
  area text,
  details text NOT NULL DEFAULT '',
  urgency text NOT NULL DEFAULT 'medium',
  status text NOT NULL DEFAULT 'pending_assignment'
    CHECK (status IN ('pending_assignment', 'assigned', 'in_progress', 'pending_review', 'closed', 'cancelled')),
  assignee_id text,
  assigned_at timestamptz,
  assigned_by text,
  started_at timestamptz,
  submitted_at timestamptz,
  completion_photo_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
  completion_notes text,
  reviewed_at timestamptz,
  reviewed_by text,
  review_note text,
  closed_at timestamptz,
  closed_by text,
  cancelled_at timestamptz,
  cancelled_by text,
  cancel_reason text,
  reopened_at timestamptz,
  reopened_by text,
  reopen_reason text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_external_maintenance_orders_order_no
  ON external_maintenance_orders(order_no)
  WHERE NULLIF(BTRIM(order_no), '') IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_external_maintenance_orders_status_schedule
  ON external_maintenance_orders(status, scheduled_date);
CREATE INDEX IF NOT EXISTS idx_external_maintenance_orders_assignee_status
  ON external_maintenance_orders(assignee_id, status);
CREATE INDEX IF NOT EXISTS idx_external_maintenance_orders_client
  ON external_maintenance_orders(client_name, created_at DESC);

CREATE TABLE IF NOT EXISTS maintenance_workflow_events (
  id text PRIMARY KEY,
  maintenance_domain text NOT NULL CHECK (maintenance_domain IN ('internal', 'external')),
  record_id text NOT NULL,
  event_type text NOT NULL,
  from_status text,
  to_status text,
  actor_user_id text,
  actor_name text,
  reason text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_maintenance_workflow_events_record
  ON maintenance_workflow_events(maintenance_domain, record_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_maintenance_workflow_events_type
  ON maintenance_workflow_events(event_type, created_at DESC);

COMMIT;
