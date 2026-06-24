CREATE TABLE IF NOT EXISTS property_annual_report_manual_months (
  id text PRIMARY KEY,
  property_id text NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  month_key text NOT NULL,
  fiscal_year integer NOT NULL,
  currency text NOT NULL DEFAULT 'AUD',
  rent_income numeric,
  other_income numeric,
  management_fee numeric,
  consumables numeric,
  electricity numeric,
  gas numeric,
  water numeric,
  internet numeric,
  carpark numeric,
  council numeric,
  bodycorp numeric,
  other_expense numeric,
  note text,
  is_complete boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text,
  updated_by text
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_property_annual_report_manual_months_property_month
  ON property_annual_report_manual_months(property_id, month_key);

CREATE INDEX IF NOT EXISTS idx_property_annual_report_manual_months_fy
  ON property_annual_report_manual_months(fiscal_year, property_id, month_key);
