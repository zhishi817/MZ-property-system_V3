ALTER TABLE property_daily_necessities
  ADD COLUMN IF NOT EXISTS pay_method text;

CREATE INDEX IF NOT EXISTS idx_property_daily_necessities_pay_method
  ON property_daily_necessities(pay_method);
