BEGIN;

ALTER TABLE job_locks
  ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz NOT NULL DEFAULT now();

COMMIT;

