BEGIN;

DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'schema_migrations_missing';
  END IF;
  IF to_regclass('public.recurring_payments') IS NULL
     OR to_regclass('public.finance_transactions') IS NULL THEN
    RAISE EXCEPTION 'recurring_fixed_income_base_schema_missing';
  END IF;
END $$;

ALTER TABLE recurring_payments
  ADD COLUMN IF NOT EXISTS cashflow_type text NOT NULL DEFAULT 'expense';

UPDATE recurring_payments
   SET cashflow_type = 'expense'
 WHERE cashflow_type IS NULL OR cashflow_type NOT IN ('expense', 'income');

ALTER TABLE finance_transactions
  ADD COLUMN IF NOT EXISTS recurring_payment_id text;

ALTER TABLE finance_transactions
  ADD COLUMN IF NOT EXISTS month_key text;

ALTER TABLE finance_transactions
  ADD COLUMN IF NOT EXISTS due_date date;

ALTER TABLE finance_transactions
  ADD COLUMN IF NOT EXISTS received_at date;

ALTER TABLE finance_transactions
  ADD COLUMN IF NOT EXISTS status text;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_finance_transactions_recurring_income_month
  ON finance_transactions(recurring_payment_id, month_key);

CREATE INDEX IF NOT EXISTS idx_finance_transactions_recurring_income_month_status
  ON finance_transactions(month_key, status, recurring_payment_id)
  WHERE ref_type = 'recurring_income';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'recurring_payments_cashflow_type_check'
       AND conrelid = 'recurring_payments'::regclass
  ) THEN
    ALTER TABLE recurring_payments
      ADD CONSTRAINT recurring_payments_cashflow_type_check
      CHECK (cashflow_type IN ('expense', 'income'));
  END IF;
END $$;

INSERT INTO schema_migrations (version)
VALUES ('20260922_recurring_fixed_income')
ON CONFLICT (version) DO NOTHING;

COMMIT;
