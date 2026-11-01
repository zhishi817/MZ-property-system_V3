BEGIN;

DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'schema_migrations_missing';
  END IF;
  IF to_regclass('public.cleaning_tasks') IS NULL THEN
    RAISE EXCEPTION 'cleaning_tasks_missing';
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
       OR OLD.assignee_id IS DISTINCT FROM NEW.assignee_id
       OR OLD.cleaner_id IS DISTINCT FROM NEW.cleaner_id
       OR OLD.inspector_id IS DISTINCT FROM NEW.inspector_id
     ) THEN
    NEW.guest_ready_checkin_requirement_version := COALESCE(OLD.guest_ready_checkin_requirement_version, 0) + 1;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_guest_ready_checkin_requirement_version ON cleaning_tasks;
CREATE TRIGGER trg_guest_ready_checkin_requirement_version
BEFORE UPDATE OF checkin_time, order_id, task_type, type, status, execution_state, task_date, date, property_id, assignee_id, cleaner_id, inspector_id
ON cleaning_tasks
FOR EACH ROW
EXECUTE FUNCTION bump_guest_ready_checkin_requirement_version();

CREATE TABLE IF NOT EXISTS cleaning_task_guest_ready_notifications (
  task_id text PRIMARY KEY REFERENCES cleaning_tasks(id) ON DELETE CASCADE,
  notified_at timestamptz,
  notified_by_user_id text,
  notified_requirement_version bigint,
  version integer NOT NULL DEFAULT 0,
  last_action text NOT NULL,
  last_action_at timestamptz NOT NULL DEFAULT now(),
  last_actor_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cleaning_task_guest_ready_notification_pair_check
    CHECK ((notified_at IS NULL) = (notified_by_user_id IS NULL)),
  CONSTRAINT cleaning_task_guest_ready_notification_binding_check
    CHECK (
      (notified_at IS NULL) = (notified_requirement_version IS NULL)
      AND (notified_requirement_version IS NULL OR notified_requirement_version >= 0)
    ),
  CONSTRAINT cleaning_task_guest_ready_notification_version_check
    CHECK (version >= 0),
  CONSTRAINT cleaning_task_guest_ready_notification_last_action_check
    CHECK (last_action IN ('mark', 'revoke'))
);

CREATE TABLE IF NOT EXISTS cleaning_task_guest_ready_notification_events (
  id text PRIMARY KEY,
  task_id text REFERENCES cleaning_tasks(id) ON DELETE SET NULL,
  task_id_snapshot text NOT NULL,
  order_id_at_action text,
  action text NOT NULL,
  changed boolean NOT NULL,
  actor_user_id text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  operation_id text NOT NULL,
  expected_version integer NOT NULL,
  previous_notified_at timestamptz,
  previous_notified_by_user_id text,
  previous_notified_requirement_version bigint,
  resulting_notified_at timestamptz,
  resulting_notified_by_user_id text,
  resulting_notified_requirement_version bigint,
  resulting_version integer NOT NULL,
  property_id text,
  task_date date,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT cleaning_task_guest_ready_notification_events_action_check
    CHECK (action IN ('mark', 'revoke')),
  CONSTRAINT cleaning_task_guest_ready_notification_events_previous_pair_check
    CHECK ((previous_notified_at IS NULL) = (previous_notified_by_user_id IS NULL)),
  CONSTRAINT cleaning_task_guest_ready_notification_events_result_pair_check
    CHECK ((resulting_notified_at IS NULL) = (resulting_notified_by_user_id IS NULL)),
  CONSTRAINT cleaning_task_guest_ready_notification_events_binding_check
    CHECK (
      (previous_notified_at IS NULL) = (previous_notified_requirement_version IS NULL)
      AND (resulting_notified_at IS NULL) = (resulting_notified_requirement_version IS NULL)
      AND (previous_notified_requirement_version IS NULL OR previous_notified_requirement_version >= 0)
      AND (resulting_notified_requirement_version IS NULL OR resulting_notified_requirement_version >= 0)
    ),
  CONSTRAINT cleaning_task_guest_ready_notification_events_version_check
    CHECK (expected_version >= 0 AND resulting_version >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_cleaning_task_guest_ready_notification_operation
  ON cleaning_task_guest_ready_notification_events(task_id_snapshot, operation_id);
CREATE INDEX IF NOT EXISTS idx_cleaning_task_guest_ready_notification_events_task_time
  ON cleaning_task_guest_ready_notification_events(task_id_snapshot, occurred_at DESC);

INSERT INTO schema_migrations (version)
VALUES ('20261101_manual_task_guest_ready_notification')
ON CONFLICT (version) DO NOTHING;

COMMIT;
