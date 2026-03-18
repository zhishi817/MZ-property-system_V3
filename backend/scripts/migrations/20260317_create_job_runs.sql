BEGIN;

CREATE TABLE IF NOT EXISTS job_runs (
  id text PRIMARY KEY,
  job_name text NOT NULL,
  schedule_name text,
  trigger_source text,
  run_id text,
  lock_name text,
  lock_acquired boolean,
  skipped boolean,
  skipped_reason text,
  date_from date,
  date_to date,
  time_zone text,
  concurrency int,
  orders_scanned int,
  orders_succeeded int,
  orders_failed int,
  tasks_created int,
  tasks_updated int,
  tasks_cancelled int,
  tasks_skipped_locked int,
  tasks_no_change int,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  duration_ms int,
  error_message text,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_job_runs_job_created ON job_runs(job_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_runs_job_started ON job_runs(job_name, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_runs_job_schedule ON job_runs(job_name, schedule_name, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_runs_job_ok ON job_runs(job_name, lock_acquired, skipped, started_at DESC);

COMMIT;

