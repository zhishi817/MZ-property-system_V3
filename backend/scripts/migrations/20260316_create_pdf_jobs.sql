BEGIN;

CREATE TABLE IF NOT EXISTS pdf_jobs (
  id text PRIMARY KEY,
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  progress int NOT NULL DEFAULT 0,
  stage text,
  detail text,
  params jsonb,
  result_files jsonb,
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 3,
  next_retry_at timestamptz NOT NULL DEFAULT now(),
  locked_by text,
  lease_expires_at timestamptz,
  running_started_at timestamptz,
  last_error_code text,
  last_error_message text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pdf_jobs_status_next ON pdf_jobs(status, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_pdf_jobs_kind_status ON pdf_jobs(kind, status);
CREATE INDEX IF NOT EXISTS idx_pdf_jobs_lease ON pdf_jobs(lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_pdf_jobs_created ON pdf_jobs(created_at);

COMMIT;

