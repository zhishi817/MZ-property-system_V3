BEGIN;

CREATE TABLE IF NOT EXISTS job_locks (
  name text PRIMARY KEY,
  locked_until timestamptz NOT NULL,
  locked_by text NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE job_locks
  ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS job_locks_locked_until_idx ON job_locks (locked_until);
CREATE INDEX IF NOT EXISTS job_locks_heartbeat_at_idx ON job_locks (heartbeat_at);

COMMIT;
