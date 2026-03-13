BEGIN;

CREATE TABLE IF NOT EXISTS cleaning_sync_jobs (
  id text PRIMARY KEY,
  order_id text NOT NULL,
  action text NOT NULL,
  fingerprint text,
  payload_snapshot jsonb,
  status text NOT NULL DEFAULT 'pending',
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 10,
  next_retry_at timestamptz NOT NULL DEFAULT now(),
  running_started_at timestamptz,
  last_error_code text,
  last_error_message text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cleaning_sync_jobs_status_next ON cleaning_sync_jobs(status, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_cleaning_sync_jobs_order ON cleaning_sync_jobs(order_id);
CREATE INDEX IF NOT EXISTS idx_cleaning_sync_jobs_running ON cleaning_sync_jobs(running_started_at);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_cleaning_sync_jobs_order_action_active ON cleaning_sync_jobs(order_id, action) WHERE status IN ('pending','running');

COMMIT;

