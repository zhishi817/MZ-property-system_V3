BEGIN;

DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'schema_migrations_missing';
  END IF;
  IF to_regclass('public.cleaning_tasks') IS NULL THEN
    RAISE EXCEPTION 'cleaning_tasks_missing';
  END IF;
  IF to_regclass('public.orders') IS NULL THEN
    RAISE EXCEPTION 'orders_missing';
  END IF;
END $$;

ALTER TABLE cleaning_tasks
  ADD COLUMN IF NOT EXISTS linked_checkout_task_id text;

CREATE INDEX IF NOT EXISTS idx_cleaning_tasks_linked_checkout_active
  ON cleaning_tasks(linked_checkout_task_id)
  WHERE linked_checkout_task_id IS NOT NULL
    AND COALESCE(execution_state, 'active') = 'active'
    AND lower(COALESCE(status, '')) NOT IN ('cancelled', 'canceled');

CREATE OR REPLACE FUNCTION mz065_lock_order_turnover_boundaries()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  boundary record;
BEGIN
  FOR boundary IN
    SELECT DISTINCT key_parts.property_key, key_parts.boundary_day
    FROM (VALUES
      (NEW.property_id::text, NEW.checkin::date),
      (NEW.property_id::text, NEW.checkout::date)
    ) AS key_parts(property_key, boundary_day)
    WHERE key_parts.property_key IS NOT NULL
      AND key_parts.boundary_day IS NOT NULL
    ORDER BY key_parts.property_key, key_parts.boundary_day
  LOOP
    PERFORM pg_advisory_xact_lock(
      hashtext('cleaning-turnover:' || boundary.property_key),
      hashtext(boundary.boundary_day::text)
    );
  END LOOP;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mz065_lock_order_turnover_boundaries ON orders;
CREATE TRIGGER trg_mz065_lock_order_turnover_boundaries
BEFORE INSERT ON orders
FOR EACH ROW
EXECUTE FUNCTION mz065_lock_order_turnover_boundaries();

INSERT INTO schema_migrations(version)
VALUES ('20261021_mz065_manual_checkin_turnover_link')
ON CONFLICT (version) DO NOTHING;

COMMIT;
