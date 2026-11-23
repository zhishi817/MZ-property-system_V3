BEGIN;

CREATE TABLE IF NOT EXISTS property_bill_configurations (
  property_id text NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  category text NOT NULL CHECK (category IN ('water','electricity','gas_hot_water','internet','council_rate','owners_corp','other')),
  status text NOT NULL CHECK (status IN ('owner','company','pending','not_applicable')),
  account_number text,
  vendor text,
  cycle_months integer CHECK (cycle_months BETWEEN 1 AND 24),
  due_date date,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (property_id, category),
  CHECK (status = 'company' OR (account_number IS NULL AND vendor IS NULL AND cycle_months IS NULL AND due_date IS NULL))
);

INSERT INTO schema_migrations (version) VALUES ('20261120_mz128_property_bill_configurations')
ON CONFLICT (version) DO NOTHING;

COMMIT;
