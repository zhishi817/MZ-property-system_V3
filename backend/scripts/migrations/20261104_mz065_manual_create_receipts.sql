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
  IF to_regclass('public.properties') IS NULL THEN
    RAISE EXCEPTION 'properties_missing';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS manual_cleaning_task_create_receipts (
  actor_user_id text NOT NULL,
  request_id text NOT NULL,
  request_hash text NOT NULL,
  task_ids text[] NOT NULL,
  task_types text[] NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (actor_user_id, request_id),
  CHECK (status IN ('pending', 'completed'))
);

-- The original order-insert trigger used the raw property_id as its advisory
-- lock key. Historical task/order rows may contain either a property code or
-- the UUID for the same property, so normalize both representations into the
-- UUID lock domain used by the application before taking boundary locks.
CREATE OR REPLACE FUNCTION mz065_lock_order_turnover_boundaries()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  boundary record;
  canonical_property_key text;
BEGIN
  SELECT COALESCE(p_id.id::text, p_code.id::text, NEW.property_id::text)
    INTO canonical_property_key
    FROM (SELECT 1) seed
    LEFT JOIN properties p_id ON p_id.id::text = NEW.property_id::text
    LEFT JOIN properties p_code ON upper(p_code.code) = upper(NEW.property_id::text)
   LIMIT 1;

  FOR boundary IN
    SELECT DISTINCT key_parts.property_key, key_parts.boundary_day
      FROM (VALUES
        (canonical_property_key, NEW.checkin::date),
        (canonical_property_key, NEW.checkout::date)
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
VALUES ('20261104_mz065_manual_create_receipts')
ON CONFLICT (version) DO NOTHING;

COMMIT;
