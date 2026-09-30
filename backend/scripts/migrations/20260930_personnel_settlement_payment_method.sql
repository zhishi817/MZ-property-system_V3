BEGIN;

DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'schema_migrations_missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM schema_migrations
     WHERE version = '20260910_personnel_settlement_phase1'
  ) THEN
    RAISE EXCEPTION 'personnel_settlement_payment_method_requires_phase1';
  END IF;
END $$;

ALTER TABLE personnel_settlement_profiles
  ADD COLUMN IF NOT EXISTS payment_method text NOT NULL DEFAULT 'bank_transfer';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'personnel_settlement_profiles_payment_method_check'
       AND conrelid = 'personnel_settlement_profiles'::regclass
  ) THEN
    ALTER TABLE personnel_settlement_profiles
      ADD CONSTRAINT personnel_settlement_profiles_payment_method_check CHECK (
        payment_method IN ('bank_transfer', 'cash', 'foreign_currency', 'other')
      );
  END IF;
END $$;

INSERT INTO schema_migrations (version)
VALUES ('20260930_personnel_settlement_payment_method')
ON CONFLICT (version) DO NOTHING;

COMMIT;
