BEGIN;

DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'schema_migrations_missing';
  END IF;
END $$;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS guest_ready_outside_key_required boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS guest_ready_outside_key_registered_at timestamptz,
  ADD COLUMN IF NOT EXISTS guest_ready_outside_key_registered_by text,
  ADD COLUMN IF NOT EXISTS guest_ready_notified_checkin_task_id text,
  ADD COLUMN IF NOT EXISTS guest_ready_notified_requirement_version bigint;

ALTER TABLE cleaning_tasks
  ADD COLUMN IF NOT EXISTS guest_ready_checkin_requirement_version bigint NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'orders_guest_ready_outside_key_registration_check'
       AND conrelid = 'orders'::regclass
  ) THEN
    ALTER TABLE orders
      ADD CONSTRAINT orders_guest_ready_outside_key_registration_check
      CHECK (
        (guest_ready_outside_key_required = true
          AND guest_ready_outside_key_registered_at IS NOT NULL
          AND guest_ready_outside_key_registered_by IS NOT NULL)
        OR
        (guest_ready_outside_key_required = false
          AND guest_ready_outside_key_registered_at IS NULL
          AND guest_ready_outside_key_registered_by IS NULL)
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'orders_guest_ready_notification_binding_check'
       AND conrelid = 'orders'::regclass
  ) THEN
    ALTER TABLE orders
      ADD CONSTRAINT orders_guest_ready_notification_binding_check
      CHECK (
        (guest_ready_notified_checkin_task_id IS NULL)
          = (guest_ready_notified_requirement_version IS NULL)
        AND (
          guest_ready_notified_requirement_version IS NULL
          OR guest_ready_notified_requirement_version >= 0
        )
        AND (
          guest_ready_notified_checkin_task_id IS NULL
          OR guest_ready_notified_at IS NOT NULL
        )
      );
  END IF;
END $$;

CREATE OR REPLACE FUNCTION bump_guest_ready_checkin_requirement_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_kind text := lower(COALESCE(NULLIF(TRIM(OLD.task_type), ''), NULLIF(TRIM(OLD.type), ''), ''));
  new_kind text := lower(COALESCE(NULLIF(TRIM(NEW.task_type), ''), NULLIF(TRIM(NEW.type), ''), ''));
  old_active boolean := (
    COALESCE(OLD.execution_state, CASE WHEN lower(COALESCE(OLD.status, '')) IN ('cancelled', 'canceled') THEN 'cancelled' ELSE 'active' END) = 'active'
    AND lower(COALESCE(OLD.status, '')) NOT IN ('cancelled', 'canceled')
  );
  new_active boolean := (
    COALESCE(NEW.execution_state, CASE WHEN lower(COALESCE(NEW.status, '')) IN ('cancelled', 'canceled') THEN 'cancelled' ELSE 'active' END) = 'active'
    AND lower(COALESCE(NEW.status, '')) NOT IN ('cancelled', 'canceled')
  );
BEGIN
  IF (old_kind = 'checkin_clean' OR new_kind = 'checkin_clean')
     AND (
       OLD.checkin_time IS DISTINCT FROM NEW.checkin_time
       OR OLD.order_id IS DISTINCT FROM NEW.order_id
       OR old_kind IS DISTINCT FROM new_kind
       OR old_active IS DISTINCT FROM new_active
       OR OLD.task_date IS DISTINCT FROM NEW.task_date
       OR OLD.date IS DISTINCT FROM NEW.date
       OR OLD.property_id IS DISTINCT FROM NEW.property_id
     ) THEN
    NEW.guest_ready_checkin_requirement_version := COALESCE(OLD.guest_ready_checkin_requirement_version, 0) + 1;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_guest_ready_checkin_requirement_version ON cleaning_tasks;
CREATE TRIGGER trg_guest_ready_checkin_requirement_version
BEFORE UPDATE OF checkin_time, order_id, task_type, type, status, execution_state, task_date, date, property_id
ON cleaning_tasks
FOR EACH ROW
EXECUTE FUNCTION bump_guest_ready_checkin_requirement_version();

ALTER TABLE order_guest_ready_notification_events
  DROP CONSTRAINT IF EXISTS order_guest_ready_notification_events_action_check;

ALTER TABLE order_guest_ready_notification_events
  ADD CONSTRAINT order_guest_ready_notification_events_action_check
  CHECK (action IN ('mark', 'revoke', 'register_outside_key', 'cancel_outside_key'));

INSERT INTO schema_migrations (version)
VALUES ('20261011_order_guest_ready_outside_key')
ON CONFLICT (version) DO NOTHING;

COMMIT;
