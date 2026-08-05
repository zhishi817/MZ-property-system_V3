BEGIN;

CREATE TABLE IF NOT EXISTS app_submit_receipts (
  id text PRIMARY KEY,
  scope_type text NOT NULL,
  scope_id text NOT NULL,
  submit_id text NOT NULL,
  step_key text NOT NULL,
  payload_hash text NOT NULL,
  response_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_app_submit_receipts_scope
  ON app_submit_receipts(scope_type, scope_id, submit_id, step_key);

COMMIT;
