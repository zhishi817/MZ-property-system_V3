ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS ref_type text;
ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS ref_id text;
ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS generated_from text;

ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS ref_type text;
ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS ref_id text;
ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS generated_from text;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_property_expenses_ref
ON property_expenses(ref_type, ref_id)
WHERE ref_type IS NOT NULL AND ref_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_company_expenses_ref
ON company_expenses(ref_type, ref_id)
WHERE ref_type IS NOT NULL AND ref_id IS NOT NULL;
