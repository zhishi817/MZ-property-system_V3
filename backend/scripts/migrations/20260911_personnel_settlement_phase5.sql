BEGIN;

DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'schema_migrations_missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations
     WHERE version = '20260910_personnel_settlement_phase1'
  ) THEN
    RAISE EXCEPTION 'personnel_settlement_phase5_requires_phase1';
  END IF;
  IF to_regclass('public.invoice_companies') IS NULL THEN
    RAISE EXCEPTION 'personnel_settlement_phase5_requires_invoice_companies';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS personnel_settlement_documents (
  id text PRIMARY KEY,
  settlement_id text NOT NULL REFERENCES personnel_weekly_settlements(id) ON DELETE RESTRICT,
  document_stage text NOT NULL,
  document_kind text NOT NULL,
  version integer NOT NULL,
  invoice_number text,
  source_sha256 text NOT NULL,
  content_sha256 text NOT NULL,
  storage_key text NOT NULL,
  mime_type text NOT NULL DEFAULT 'application/pdf',
  byte_size bigint NOT NULL,
  supplier_snapshot jsonb NOT NULL,
  buyer_snapshot jsonb NOT NULL,
  totals_snapshot jsonb NOT NULL,
  status_snapshot jsonb NOT NULL,
  generated_by text,
  generated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT personnel_settlement_documents_stage_check CHECK (
    document_stage IN ('awaiting_confirmation', 'confirmed', 'finance_approved', 'paid')
  ),
  CONSTRAINT personnel_settlement_documents_kind_check CHECK (
    document_kind IN ('settlement_draft', 'tax_invoice', 'invoice')
  ),
  CONSTRAINT personnel_settlement_documents_version_check CHECK (version > 0),
  CONSTRAINT personnel_settlement_documents_hash_check CHECK (
    source_sha256 ~ '^[0-9a-f]{64}$' AND content_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT personnel_settlement_documents_size_check CHECK (byte_size > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_personnel_settlement_documents_stage_version
  ON personnel_settlement_documents(settlement_id, document_stage, version);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_personnel_settlement_documents_source
  ON personnel_settlement_documents(settlement_id, document_stage, source_sha256);
CREATE INDEX IF NOT EXISTS idx_personnel_settlement_documents_settlement
  ON personnel_settlement_documents(settlement_id, generated_at DESC);

CREATE TABLE IF NOT EXISTS personnel_settlement_job_runs (
  id text PRIMARY KEY,
  week_start date NOT NULL,
  week_end date NOT NULL,
  trigger_source text NOT NULL,
  status text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  generated_count integer NOT NULL DEFAULT 0,
  issued_count integer NOT NULL DEFAULT 0,
  skipped_count integer NOT NULL DEFAULT 0,
  error_summary jsonb NOT NULL DEFAULT '[]'::jsonb,
  initiated_by text,
  calculation_version text,
  CONSTRAINT personnel_settlement_job_runs_period_check CHECK (week_end = week_start + 6),
  CONSTRAINT personnel_settlement_job_runs_trigger_check CHECK (trigger_source IN ('scheduled', 'manual')),
  CONSTRAINT personnel_settlement_job_runs_status_check CHECK (status IN ('running', 'succeeded', 'partial', 'failed', 'skipped')),
  CONSTRAINT personnel_settlement_job_runs_counts_check CHECK (
    generated_count >= 0 AND issued_count >= 0 AND skipped_count >= 0
  )
);
CREATE INDEX IF NOT EXISTS idx_personnel_settlement_job_runs_started
  ON personnel_settlement_job_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_personnel_settlement_job_runs_week
  ON personnel_settlement_job_runs(week_start DESC, started_at DESC);

INSERT INTO schema_migrations (version)
VALUES ('20260911_personnel_settlement_phase5')
ON CONFLICT (version) DO NOTHING;

COMMIT;
