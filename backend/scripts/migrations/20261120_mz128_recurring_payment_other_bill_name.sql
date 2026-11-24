BEGIN;

ALTER TABLE recurring_payments
  ADD COLUMN IF NOT EXISTS other_bill_name text;

INSERT INTO schema_migrations (version) VALUES ('20261120_mz128_recurring_payment_other_bill_name')
ON CONFLICT (version) DO NOTHING;

COMMIT;
