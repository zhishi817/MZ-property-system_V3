CREATE TABLE IF NOT EXISTS landlord_management_fee_rules (
  id text PRIMARY KEY,
  landlord_id text NOT NULL REFERENCES landlords(id) ON DELETE CASCADE,
  effective_from_month text NOT NULL,
  management_fee_rate numeric NOT NULL,
  note text,
  created_at timestamptz DEFAULT now(),
  created_by text
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_landlord_management_fee_rules_landlord_month
ON landlord_management_fee_rules(landlord_id, effective_from_month);

CREATE INDEX IF NOT EXISTS idx_landlord_management_fee_rules_lookup
ON landlord_management_fee_rules(landlord_id, effective_from_month DESC);
