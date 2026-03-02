ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS pay_method text;
ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS pay_other_note text;

UPDATE property_expenses
SET pay_method = 'landlord_pay'
WHERE pay_method IS NULL OR pay_method = '';

CREATE INDEX IF NOT EXISTS idx_property_expenses_pay_method
ON property_expenses(pay_method);
