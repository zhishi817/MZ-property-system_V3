CREATE TABLE IF NOT EXISTS employment_contracts (
  id text PRIMARY KEY,
  contract_no text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'draft',
  fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes text,
  last_generated_at timestamptz,
  created_by text,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_employment_contracts_status_updated
  ON employment_contracts(status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_employment_contracts_employee_name
  ON employment_contracts ((fields->>'employee_name'));
