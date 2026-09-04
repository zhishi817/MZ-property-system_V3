BEGIN;

-- This marker is inserted only after every structure used by the maintenance
-- close and auto-expense paths exists. Request handlers never run this DDL.
CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE property_maintenance
  ADD COLUMN IF NOT EXISTS feedback_source text NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS source_task_id text,
  ADD COLUMN IF NOT EXISTS status text,
  ADD COLUMN IF NOT EXISTS urgency text,
  ADD COLUMN IF NOT EXISTS assignee_id text,
  ADD COLUMN IF NOT EXISTS eta date,
  ADD COLUMN IF NOT EXISTS assigned_at timestamptz,
  ADD COLUMN IF NOT EXISTS assigned_by text,
  ADD COLUMN IF NOT EXISTS started_at timestamptz,
  ADD COLUMN IF NOT EXISTS submitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS submitter_name text,
  ADD COLUMN IF NOT EXISTS completion_photo_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS photo_urls text[],
  ADD COLUMN IF NOT EXISTS repair_photo_urls jsonb,
  ADD COLUMN IF NOT EXISTS repair_notes text,
  ADD COLUMN IF NOT EXISTS completion_reason text,
  ADD COLUMN IF NOT EXISTS maintenance_amount numeric(12,2),
  ADD COLUMN IF NOT EXISTS has_parts boolean,
  ADD COLUMN IF NOT EXISTS parts_amount numeric(12,2),
  ADD COLUMN IF NOT EXISTS maintenance_amount_includes_parts boolean,
  ADD COLUMN IF NOT EXISTS has_gst boolean,
  ADD COLUMN IF NOT EXISTS maintenance_amount_includes_gst boolean,
  ADD COLUMN IF NOT EXISTS total_amount numeric(12,2),
  ADD COLUMN IF NOT EXISTS pay_method text,
  ADD COLUMN IF NOT EXISTS pay_other_note text,
  ADD COLUMN IF NOT EXISTS area text,
  ADD COLUMN IF NOT EXISTS work_no text,
  ADD COLUMN IF NOT EXISTS property_code text,
  ADD COLUMN IF NOT EXISTS category text,
  ADD COLUMN IF NOT EXISTS category_detail text,
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

ALTER TABLE property_maintenance
  ALTER COLUMN details TYPE text USING details::text;

DO $$
DECLARE
  photo_urls_udt text;
BEGIN
  SELECT c.udt_name INTO photo_urls_udt
    FROM information_schema.columns c
   WHERE c.table_schema='public' AND c.table_name='property_maintenance' AND c.column_name='photo_urls'
   LIMIT 1;

  IF photo_urls_udt IS DISTINCT FROM '_text' THEN
    ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS photo_urls_text text[];
    UPDATE property_maintenance SET photo_urls_text=ARRAY[]::text[] WHERE photo_urls_text IS NULL;
    UPDATE property_maintenance
       SET photo_urls_text=ARRAY(SELECT jsonb_array_elements_text(to_jsonb(photo_urls)))
     WHERE jsonb_typeof(to_jsonb(photo_urls))='array';
    UPDATE property_maintenance
       SET photo_urls_text=ARRAY[trim(both '"' from to_jsonb(photo_urls)::text)]
     WHERE jsonb_typeof(to_jsonb(photo_urls))='string';
    ALTER TABLE property_maintenance DROP COLUMN photo_urls;
    ALTER TABLE property_maintenance RENAME COLUMN photo_urls_text TO photo_urls;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_property_maintenance_dedup
  ON property_maintenance(property_id, dedup_fingerprint, submitted_at);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_property_maintenance_client_item
  ON property_maintenance(property_id, client_item_id)
  WHERE client_item_id IS NOT NULL;

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
  completion_reason text,
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
ALTER TABLE external_maintenance_orders
  ADD COLUMN IF NOT EXISTS completion_reason text;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_external_maintenance_orders_order_no
  ON external_maintenance_orders(order_no)
  WHERE NULLIF(BTRIM(order_no), '') IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_external_maintenance_orders_status_schedule
  ON external_maintenance_orders(status, scheduled_date);
CREATE INDEX IF NOT EXISTS idx_external_maintenance_orders_assignee_status
  ON external_maintenance_orders(assignee_id, status);

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

CREATE TABLE IF NOT EXISTS work_tasks (
  id text PRIMARY KEY,
  task_kind text NOT NULL,
  source_type text NOT NULL,
  source_id text NOT NULL,
  property_id text,
  title text NOT NULL DEFAULT '',
  summary text,
  scheduled_date date,
  start_time text,
  end_time text,
  assignee_id text,
  status text NOT NULL DEFAULT 'todo',
  urgency text NOT NULL DEFAULT 'medium',
  sort_index integer,
  photo_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
  completion_photo_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
  completion_note text,
  completion_reason text,
  created_by text,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE work_tasks
  ADD COLUMN IF NOT EXISTS start_time text,
  ADD COLUMN IF NOT EXISTS end_time text,
  ADD COLUMN IF NOT EXISTS sort_index integer,
  ADD COLUMN IF NOT EXISTS photo_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS completion_photo_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS completion_note text,
  ADD COLUMN IF NOT EXISTS completion_reason text;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_work_tasks_source ON work_tasks(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_work_tasks_day_assignee ON work_tasks(scheduled_date, assignee_id, status);
CREATE INDEX IF NOT EXISTS idx_work_tasks_kind_day ON work_tasks(task_kind, scheduled_date);
CREATE INDEX IF NOT EXISTS idx_work_tasks_day ON work_tasks(scheduled_date);

CREATE TABLE IF NOT EXISTS company_expenses (
  id text PRIMARY KEY,
  occurred_at date NOT NULL,
  amount numeric NOT NULL,
  currency text NOT NULL DEFAULT 'AUD',
  category text,
  category_detail text,
  expense_name text,
  note text,
  invoice_url text,
  created_at timestamptz DEFAULT now(),
  created_by text,
  deleted_at timestamptz,
  deleted_by text,
  delete_source text,
  fixed_expense_id text,
  month_key text,
  due_date date,
  paid_date date,
  status text,
  generated_from text,
  ref_type text,
  ref_id text,
  is_auto boolean DEFAULT false,
  manual_override boolean DEFAULT false,
  source_title text,
  source_summary text
);
ALTER TABLE company_expenses
  ADD COLUMN IF NOT EXISTS category_detail text,
  ADD COLUMN IF NOT EXISTS expense_name text,
  ADD COLUMN IF NOT EXISTS note text,
  ADD COLUMN IF NOT EXISTS invoice_url text,
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by text,
  ADD COLUMN IF NOT EXISTS delete_source text,
  ADD COLUMN IF NOT EXISTS fixed_expense_id text,
  ADD COLUMN IF NOT EXISTS month_key text,
  ADD COLUMN IF NOT EXISTS due_date date,
  ADD COLUMN IF NOT EXISTS paid_date date,
  ADD COLUMN IF NOT EXISTS status text,
  ADD COLUMN IF NOT EXISTS generated_from text,
  ADD COLUMN IF NOT EXISTS ref_type text,
  ADD COLUMN IF NOT EXISTS ref_id text,
  ADD COLUMN IF NOT EXISTS is_auto boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS manual_override boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS source_title text,
  ADD COLUMN IF NOT EXISTS source_summary text;

CREATE TABLE IF NOT EXISTS property_expenses (
  id text PRIMARY KEY,
  property_id text,
  occurred_at date NOT NULL,
  amount numeric NOT NULL,
  currency text NOT NULL DEFAULT 'AUD',
  category text,
  category_detail text,
  expense_name text,
  note text,
  invoice_url text,
  created_at timestamptz DEFAULT now(),
  created_by text,
  deleted_at timestamptz,
  deleted_by text,
  delete_source text,
  fixed_expense_id text,
  month_key text,
  due_date date,
  paid_date date,
  status text,
  pay_method text,
  pay_other_note text,
  generated_from text,
  ref_type text,
  ref_id text,
  is_auto boolean DEFAULT false,
  manual_override boolean DEFAULT false,
  source_title text,
  source_summary text
);
ALTER TABLE property_expenses
  ADD COLUMN IF NOT EXISTS category_detail text,
  ADD COLUMN IF NOT EXISTS expense_name text,
  ADD COLUMN IF NOT EXISTS note text,
  ADD COLUMN IF NOT EXISTS invoice_url text,
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by text,
  ADD COLUMN IF NOT EXISTS delete_source text,
  ADD COLUMN IF NOT EXISTS fixed_expense_id text,
  ADD COLUMN IF NOT EXISTS month_key text,
  ADD COLUMN IF NOT EXISTS due_date date,
  ADD COLUMN IF NOT EXISTS paid_date date,
  ADD COLUMN IF NOT EXISTS status text,
  ADD COLUMN IF NOT EXISTS pay_method text,
  ADD COLUMN IF NOT EXISTS pay_other_note text,
  ADD COLUMN IF NOT EXISTS generated_from text,
  ADD COLUMN IF NOT EXISTS ref_type text,
  ADD COLUMN IF NOT EXISTS ref_id text,
  ADD COLUMN IF NOT EXISTS is_auto boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS manual_override boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS source_title text,
  ADD COLUMN IF NOT EXISTS source_summary text;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_property_expenses_ref
  ON property_expenses(ref_type, ref_id)
  WHERE ref_type IS NOT NULL AND ref_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_property_expenses_fixed_expense_month_key
  ON property_expenses(fixed_expense_id, month_key)
  WHERE fixed_expense_id IS NOT NULL AND fixed_expense_id <> '' AND month_key IS NOT NULL AND month_key <> '';
CREATE UNIQUE INDEX IF NOT EXISTS uniq_company_expenses_ref
  ON company_expenses(ref_type, ref_id)
  WHERE ref_type IS NOT NULL AND ref_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_company_expenses_fixed_month
  ON company_expenses(fixed_expense_id, month_key)
  WHERE fixed_expense_id IS NOT NULL AND fixed_expense_id <> '' AND month_key IS NOT NULL AND month_key <> '';

CREATE TABLE IF NOT EXISTS maintenance_share_links (
  token_hash text PRIMARY KEY,
  maintenance_id text NOT NULL REFERENCES property_maintenance(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_maintenance_share_mid
  ON maintenance_share_links(maintenance_id);
CREATE INDEX IF NOT EXISTS idx_maintenance_share_expires
  ON maintenance_share_links(expires_at);

INSERT INTO schema_migrations (version) VALUES ('20260903_maintenance_runtime_schema')
ON CONFLICT (version) DO NOTHING;

COMMIT;
