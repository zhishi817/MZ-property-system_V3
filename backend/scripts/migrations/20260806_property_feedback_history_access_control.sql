-- Property feedback history access control.
-- Do not backfill created_by_user_id from legacy display fields: where identity
-- cannot be proven, ordinary users remain read-only and managers retain control.

ALTER TABLE IF EXISTS property_maintenance
  ADD COLUMN IF NOT EXISTS created_by_user_id text,
  ADD COLUMN IF NOT EXISTS updated_by_user_id text,
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by_user_id text;

ALTER TABLE IF EXISTS property_deep_cleaning
  ADD COLUMN IF NOT EXISTS created_by_user_id text,
  ADD COLUMN IF NOT EXISTS updated_by_user_id text,
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by_user_id text;

ALTER TABLE IF EXISTS property_daily_necessities
  ADD COLUMN IF NOT EXISTS created_by_user_id text,
  ADD COLUMN IF NOT EXISTS updated_by_user_id text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by_user_id text;

DO $$
BEGIN
  IF to_regclass('public.property_maintenance') IS NOT NULL THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_property_maintenance_feedback_visible ON property_maintenance (property_id, submitted_at DESC) WHERE deleted_at IS NULL';
  END IF;
  IF to_regclass('public.property_deep_cleaning') IS NOT NULL THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_property_deep_cleaning_feedback_visible ON property_deep_cleaning (property_id, submitted_at DESC) WHERE deleted_at IS NULL';
  END IF;
  IF to_regclass('public.property_daily_necessities') IS NOT NULL THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_property_daily_necessities_feedback_visible ON property_daily_necessities (property_id, submitted_at DESC) WHERE deleted_at IS NULL';
  END IF;
END $$;
