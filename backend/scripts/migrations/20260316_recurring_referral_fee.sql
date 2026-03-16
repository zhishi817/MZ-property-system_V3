ALTER TABLE recurring_payments
  ADD COLUMN IF NOT EXISTS frequency_months integer;

UPDATE recurring_payments
  SET frequency_months = 1
  WHERE frequency_months IS NULL;

ALTER TABLE recurring_payments
  ALTER COLUMN frequency_months SET DEFAULT 1;

ALTER TABLE recurring_payments
  ADD COLUMN IF NOT EXISTS amount_mode text;

UPDATE recurring_payments
  SET amount_mode = 'fixed'
  WHERE amount_mode IS NULL;

ALTER TABLE recurring_payments
  ALTER COLUMN amount_mode SET DEFAULT 'fixed';

ALTER TABLE recurring_payments
  ALTER COLUMN amount_mode SET NOT NULL;

ALTER TABLE recurring_payments
  ADD COLUMN IF NOT EXISTS income_base text;

UPDATE recurring_payments
  SET income_base = 'total_income'
  WHERE income_base IS NULL;

ALTER TABLE recurring_payments
  ALTER COLUMN income_base SET DEFAULT 'total_income';

ALTER TABLE recurring_payments
  ALTER COLUMN income_base SET NOT NULL;

ALTER TABLE recurring_payments
  ADD COLUMN IF NOT EXISTS rate_percent numeric;

