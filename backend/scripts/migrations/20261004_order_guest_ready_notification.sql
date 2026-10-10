BEGIN;

DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'schema_migrations_missing';
  END IF;
END $$;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS guest_ready_notified_at timestamptz,
  ADD COLUMN IF NOT EXISTS guest_ready_notified_by text,
  ADD COLUMN IF NOT EXISTS guest_ready_notification_version integer NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'orders_guest_ready_notification_pair_check'
       AND conrelid = 'orders'::regclass
  ) THEN
    ALTER TABLE orders
      ADD CONSTRAINT orders_guest_ready_notification_pair_check
      CHECK ((guest_ready_notified_at IS NULL) = (guest_ready_notified_by IS NULL));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS order_guest_ready_notification_events (
  id text PRIMARY KEY,
  order_id text REFERENCES orders(id) ON DELETE SET NULL,
  order_id_snapshot text NOT NULL,
  action text NOT NULL,
  changed boolean NOT NULL,
  actor_user_id text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  operation_id text NOT NULL,
  expected_version integer,
  previous_notified_at timestamptz,
  previous_notified_by text,
  resulting_notified_at timestamptz,
  resulting_notified_by text,
  resulting_version integer NOT NULL,
  property_id text,
  checkin_task_id text,
  task_date date,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT order_guest_ready_notification_events_action_check
    CHECK (action IN ('mark', 'revoke')),
  CONSTRAINT order_guest_ready_notification_events_previous_pair_check
    CHECK ((previous_notified_at IS NULL) = (previous_notified_by IS NULL)),
  CONSTRAINT order_guest_ready_notification_events_result_pair_check
    CHECK ((resulting_notified_at IS NULL) = (resulting_notified_by IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_order_guest_ready_notification_operation
  ON order_guest_ready_notification_events(order_id_snapshot, operation_id);
CREATE INDEX IF NOT EXISTS idx_order_guest_ready_notification_events_order_time
  ON order_guest_ready_notification_events(order_id_snapshot, occurred_at DESC);

CREATE TABLE IF NOT EXISTS role_permissions (
  id text PRIMARY KEY,
  role_id text NOT NULL,
  permission_code text NOT NULL,
  created_at timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_role_perm ON role_permissions(role_id, permission_code);

WITH target_roles AS (
  SELECT id
    FROM roles
   WHERE id IN ('role.customer_service', 'customer_service')
      OR name = 'customer_service'
)
INSERT INTO role_permissions (id, role_id, permission_code)
SELECT md5(target_roles.id || ':order.guest_ready_notification.manage'),
       target_roles.id,
       'order.guest_ready_notification.manage'
  FROM target_roles
ON CONFLICT (role_id, permission_code) DO NOTHING;

INSERT INTO schema_migrations (version)
VALUES ('20261004_order_guest_ready_notification')
ON CONFLICT (version) DO NOTHING;

COMMIT;
