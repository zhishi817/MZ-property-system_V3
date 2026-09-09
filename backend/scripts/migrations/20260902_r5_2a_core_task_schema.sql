BEGIN;
SET LOCAL lock_timeout = '5s';

-- R5-2A depends on the R5-1 marker table. Runtime code must never recreate it.
DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'schema_migrations_missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations WHERE version = '20260902_r5_1_request_schema'
  ) THEN
    RAISE EXCEPTION 'r5_1_request_schema_not_ready';
  END IF;
END $$;

-- The event allocator is deliberately independent: application code calls nextval
-- explicitly, so do not attach a column DEFAULT or OWNED BY relationship here.
CREATE SEQUENCE IF NOT EXISTS work_task_events_sequence_no_seq AS bigint;

CREATE TABLE IF NOT EXISTS work_task_event_versions (
  task_id text PRIMARY KEY,
  last_version bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS work_task_events (
  id text PRIMARY KEY,
  event_id text NOT NULL UNIQUE,
  sequence_no bigint NOT NULL UNIQUE,
  task_id text NOT NULL,
  task_version bigint NOT NULL,
  source_type text NOT NULL,
  source_ref_ids text[] NOT NULL DEFAULT '{}',
  event_type text NOT NULL,
  change_scope text NOT NULL,
  changed_fields text[] NOT NULL DEFAULT '{}',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL,
  caused_by_user_id text,
  visibility_hints jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_work_task_events_sequence_no ON work_task_events(sequence_no);
CREATE INDEX IF NOT EXISTS idx_work_task_events_task_id_version ON work_task_events(task_id, task_version);
CREATE INDEX IF NOT EXISTS idx_work_task_events_occurred_at ON work_task_events(occurred_at DESC);

-- Never reset or decrease an existing allocator. If a legacy event table exists
-- but its sequence has not yet been called at its current maximum, advance once.
LOCK TABLE work_task_events IN ACCESS EXCLUSIVE MODE;
DO $$
DECLARE
  event_max bigint;
  sequence_last bigint;
  sequence_called boolean;
BEGIN
  SELECT COALESCE(MAX(sequence_no), 0) INTO event_max FROM work_task_events;
  SELECT last_value, is_called
    INTO sequence_last, sequence_called
    FROM work_task_events_sequence_no_seq;
  IF event_max > 0 AND (sequence_last < event_max OR (sequence_last = event_max AND NOT sequence_called)) THEN
    PERFORM setval('work_task_events_sequence_no_seq', event_max, true);
  END IF;
END $$;

-- A partially-created legacy table must fail migration rather than leave the
-- application to rediscover or mutate schema during an event write.
DO $$
DECLARE
  required_column text;
BEGIN
  FOREACH required_column IN ARRAY ARRAY[
    'id', 'event_id', 'sequence_no', 'task_id', 'task_version', 'source_type',
    'source_ref_ids', 'event_type', 'change_scope', 'changed_fields', 'payload',
    'occurred_at', 'caused_by_user_id', 'visibility_hints', 'created_at'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_attribute
      WHERE attrelid = 'work_task_events'::regclass
        AND attname = required_column
        AND NOT attisdropped
    ) THEN
      RAISE EXCEPTION 'work_task_events.%_missing', required_column;
    END IF;
  END LOOP;
  IF to_regclass('public.idx_work_task_events_sequence_no') IS NULL
     OR to_regclass('public.idx_work_task_events_task_id_version') IS NULL
     OR to_regclass('public.idx_work_task_events_occurred_at') IS NULL THEN
    RAISE EXCEPTION 'work_task_events_indexes_missing';
  END IF;
  FOREACH required_column IN ARRAY ARRAY['task_id', 'last_version', 'updated_at'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_attribute
      WHERE attrelid = 'work_task_event_versions'::regclass
        AND attname = required_column
        AND NOT attisdropped
    ) THEN
      RAISE EXCEPTION 'work_task_event_versions.%_missing', required_column;
    END IF;
  END LOOP;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'work_task_events'::regclass
      AND contype = 'p'
      AND conkey = ARRAY[(
        SELECT attnum FROM pg_attribute
        WHERE attrelid = 'work_task_events'::regclass
          AND attname = 'id'
          AND NOT attisdropped
      )]
  ) THEN
    RAISE EXCEPTION 'work_task_events.id_primary_key_missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'work_task_events'::regclass
      AND contype = 'u'
      AND conkey = ARRAY[(
        SELECT attnum FROM pg_attribute
        WHERE attrelid = 'work_task_events'::regclass
          AND attname = 'event_id'
          AND NOT attisdropped
      )]
  ) THEN
    RAISE EXCEPTION 'work_task_events.event_id_unique_missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'work_task_events'::regclass
      AND contype = 'u'
      AND conkey = ARRAY[(
        SELECT attnum FROM pg_attribute
        WHERE attrelid = 'work_task_events'::regclass
          AND attname = 'sequence_no'
          AND NOT attisdropped
      )]
  ) THEN
    RAISE EXCEPTION 'work_task_events.sequence_no_unique_missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'work_task_event_versions'::regclass
      AND contype = 'p'
      AND conkey = ARRAY[(
        SELECT attnum FROM pg_attribute
        WHERE attrelid = 'work_task_event_versions'::regclass
          AND attname = 'task_id'
          AND NOT attisdropped
      )]
  ) THEN
    RAISE EXCEPTION 'work_task_event_versions.task_id_primary_key_missing';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS work_task_action_audits (
  id text PRIMARY KEY,
  source_type text NOT NULL,
  source_id text NOT NULL,
  performed_by_user_id text,
  performed_by_name text,
  performed_as_action text NOT NULL,
  performed_at timestamptz NOT NULL DEFAULT now(),
  actor_user_id text,
  status_before text,
  status_after text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_work_task_action_audits_source ON work_task_action_audits(source_type, source_id, performed_at DESC);
CREATE INDEX IF NOT EXISTS idx_work_task_action_audits_actor ON work_task_action_audits(actor_user_id, performed_at DESC);
CREATE INDEX IF NOT EXISTS idx_work_task_action_audits_performer ON work_task_action_audits(performed_by_user_id, performed_at DESC);

-- Action transitions depend on this audit history for both behavior and
-- diagnostics. A partial legacy table must stop the migration, never trigger
-- request-time repair.
DO $$
DECLARE
  required_column text;
BEGIN
  FOREACH required_column IN ARRAY ARRAY[
    'id', 'source_type', 'source_id', 'performed_by_user_id', 'performed_by_name',
    'performed_as_action', 'performed_at', 'actor_user_id', 'status_before',
    'status_after', 'metadata', 'created_at'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_attribute
      WHERE attrelid = 'work_task_action_audits'::regclass
        AND attname = required_column
        AND NOT attisdropped
    ) THEN
      RAISE EXCEPTION 'work_task_action_audits.%_missing', required_column;
    END IF;
  END LOOP;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'work_task_action_audits'::regclass
      AND contype = 'p'
      AND conkey = ARRAY[(
        SELECT attnum FROM pg_attribute
        WHERE attrelid = 'work_task_action_audits'::regclass
          AND attname = 'id'
          AND NOT attisdropped
      )]
  ) THEN
    RAISE EXCEPTION 'work_task_action_audits.id_primary_key_missing';
  END IF;
  IF to_regclass('public.idx_work_task_action_audits_source') IS NULL
     OR to_regclass('public.idx_work_task_action_audits_actor') IS NULL
     OR to_regclass('public.idx_work_task_action_audits_performer') IS NULL THEN
    RAISE EXCEPTION 'work_task_action_audits_indexes_missing';
  END IF;
END $$;

-- Existing work_tasks is owned by the historical base migration. R5-2A owns
-- only the canonical extension fields that runtime helpers used to add.
DO $$
BEGIN
  IF to_regclass('public.work_tasks') IS NULL THEN
    RAISE EXCEPTION 'work_tasks_missing';
  END IF;
END $$;
ALTER TABLE work_tasks ADD COLUMN IF NOT EXISTS sort_index integer;
ALTER TABLE work_tasks ADD COLUMN IF NOT EXISTS photo_urls jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE work_tasks ADD COLUMN IF NOT EXISTS completion_photo_urls jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE work_tasks ADD COLUMN IF NOT EXISTS completion_note text;
ALTER TABLE work_tasks ADD COLUMN IF NOT EXISTS completion_reason text;

-- `cleaning_tasks` and `orders` are historical table owners. R5-2A owns only
-- these task-list/checkout/customer/inspection extensions previously added by
-- `/mzapp` request and warmup helpers.
DO $$
BEGIN
  IF to_regclass('public.cleaning_tasks') IS NULL THEN
    RAISE EXCEPTION 'cleaning_tasks_missing';
  END IF;
  IF to_regclass('public.orders') IS NULL THEN
    RAISE EXCEPTION 'orders_missing';
  END IF;
END $$;
ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS sort_index_cleaner integer;
ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS sort_index_inspector integer;
ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS checked_out_at timestamptz;
ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS checkout_marked_by text;
ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS guest_special_request text;
ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS keys_required integer NOT NULL DEFAULT 1;
ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS inspection_mode text;
ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS inspection_scope text;
ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS inspection_due_date date;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS keys_required integer NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS work_task_participants (
  id text PRIMARY KEY,
  source_type text NOT NULL,
  source_id text NOT NULL,
  user_id text NOT NULL,
  participant_role text NOT NULL DEFAULT 'collaborator',
  action_ids jsonb NOT NULL DEFAULT '["*"]'::jsonb,
  source_relation text NOT NULL DEFAULT 'manual',
  created_by text,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE work_task_participants ADD COLUMN IF NOT EXISTS participant_role text NOT NULL DEFAULT 'collaborator';
ALTER TABLE work_task_participants ADD COLUMN IF NOT EXISTS action_ids jsonb NOT NULL DEFAULT '["*"]'::jsonb;
ALTER TABLE work_task_participants ADD COLUMN IF NOT EXISTS source_relation text NOT NULL DEFAULT 'manual';
CREATE INDEX IF NOT EXISTS idx_work_task_participants_source ON work_task_participants(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_work_task_participants_user ON work_task_participants(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_work_task_participants_manual ON work_task_participants(source_type, source_id, user_id, source_relation);

DO $$
DECLARE
  required_column text;
BEGIN
  FOREACH required_column IN ARRAY ARRAY[
    'id', 'source_type', 'source_id', 'user_id', 'participant_role', 'action_ids',
    'source_relation', 'created_by', 'updated_by', 'created_at', 'updated_at'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_attribute
      WHERE attrelid = 'work_task_participants'::regclass
        AND attname = required_column
        AND NOT attisdropped
    ) THEN
      RAISE EXCEPTION 'work_task_participants.%_missing', required_column;
    END IF;
  END LOOP;
END $$;

-- users and user_roles are historical schema owners; retain their existing table
-- definitions and add only the legacy RBAC extensions still performed at runtime.
DO $$
BEGIN
  IF to_regclass('public.users') IS NULL THEN
    RAISE EXCEPTION 'users_missing';
  END IF;
  IF to_regclass('public.user_roles') IS NULL THEN
    RAISE EXCEPTION 'user_roles_missing';
  END IF;
  IF to_regclass('public.roles') IS NULL THEN
    RAISE EXCEPTION 'roles_missing';
  END IF;
  IF to_regclass('public.role_permissions') IS NULL THEN
    RAISE EXCEPTION 'role_permissions_missing';
  END IF;
  IF to_regclass('public.idx_user_roles_user_id') IS NULL
     OR to_regclass('public.idx_user_roles_role_name') IS NULL THEN
    RAISE EXCEPTION 'user_roles_indexes_missing';
  END IF;
  IF to_regclass('public.uniq_roles_name') IS NULL THEN
    RAISE EXCEPTION 'roles_index_missing';
  END IF;
  IF to_regclass('public.uniq_role_perm') IS NULL THEN
    RAISE EXCEPTION 'role_permissions_index_missing';
  END IF;
END $$;
ALTER TABLE users ADD COLUMN IF NOT EXISTS delete_password_hash text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS color_hex text NOT NULL DEFAULT '#3B82F6';

-- The marker is a promise that event/action/participant writes can run without
-- any schema repair. Existing objects with the right names but incompatible
-- types, nullability, defaults, constraints or indexes must therefore abort
-- this migration rather than fail later in a request.
DO $$
DECLARE
  expected record;
  actual_type text;
  actual_not_null boolean;
  actual_default text;
  actual_index_definition text;
  actual_constraint_definition text;
BEGIN
  FOR expected IN
    SELECT * FROM (VALUES
      ('work_task_event_versions', 'task_id', 'text', true, NULL::text),
      ('work_task_event_versions', 'last_version', 'bigint', true, '0'),
      ('work_task_event_versions', 'updated_at', 'timestamp with time zone', true, 'now()'),
      ('work_task_events', 'id', 'text', true, NULL::text),
      ('work_task_events', 'event_id', 'text', true, NULL::text),
      ('work_task_events', 'sequence_no', 'bigint', true, NULL::text),
      ('work_task_events', 'task_id', 'text', true, NULL::text),
      ('work_task_events', 'task_version', 'bigint', true, NULL::text),
      ('work_task_events', 'source_type', 'text', true, NULL::text),
      ('work_task_events', 'source_ref_ids', 'text[]', true, '''{}''::text[]'),
      ('work_task_events', 'event_type', 'text', true, NULL::text),
      ('work_task_events', 'change_scope', 'text', true, NULL::text),
      ('work_task_events', 'changed_fields', 'text[]', true, '''{}''::text[]'),
      ('work_task_events', 'payload', 'jsonb', true, '''{}''::jsonb'),
      ('work_task_events', 'occurred_at', 'timestamp with time zone', true, NULL::text),
      ('work_task_events', 'caused_by_user_id', 'text', false, NULL::text),
      ('work_task_events', 'visibility_hints', 'jsonb', false, NULL::text),
      ('work_task_events', 'created_at', 'timestamp with time zone', true, 'now()'),
      ('work_task_action_audits', 'id', 'text', true, NULL::text),
      ('work_task_action_audits', 'source_type', 'text', true, NULL::text),
      ('work_task_action_audits', 'source_id', 'text', true, NULL::text),
      ('work_task_action_audits', 'performed_by_user_id', 'text', false, NULL::text),
      ('work_task_action_audits', 'performed_by_name', 'text', false, NULL::text),
      ('work_task_action_audits', 'performed_as_action', 'text', true, NULL::text),
      ('work_task_action_audits', 'performed_at', 'timestamp with time zone', true, 'now()'),
      ('work_task_action_audits', 'actor_user_id', 'text', false, NULL::text),
      ('work_task_action_audits', 'status_before', 'text', false, NULL::text),
      ('work_task_action_audits', 'status_after', 'text', false, NULL::text),
      ('work_task_action_audits', 'metadata', 'jsonb', true, '''{}''::jsonb'),
      ('work_task_action_audits', 'created_at', 'timestamp with time zone', true, 'now()'),
      ('work_task_participants', 'id', 'text', true, NULL::text),
      ('work_task_participants', 'source_type', 'text', true, NULL::text),
      ('work_task_participants', 'source_id', 'text', true, NULL::text),
      ('work_task_participants', 'user_id', 'text', true, NULL::text),
      ('work_task_participants', 'participant_role', 'text', true, '''collaborator''::text'),
      ('work_task_participants', 'action_ids', 'jsonb', true, '''["*"]''::jsonb'),
      ('work_task_participants', 'source_relation', 'text', true, '''manual''::text'),
      ('work_task_participants', 'created_by', 'text', false, NULL::text),
      ('work_task_participants', 'updated_by', 'text', false, NULL::text),
      ('work_task_participants', 'created_at', 'timestamp with time zone', true, 'now()'),
      ('work_task_participants', 'updated_at', 'timestamp with time zone', true, 'now()'),
      ('work_tasks', 'sort_index', 'integer', false, NULL::text),
      ('work_tasks', 'photo_urls', 'jsonb', true, '''[]''::jsonb'),
      ('work_tasks', 'completion_photo_urls', 'jsonb', true, '''[]''::jsonb'),
      ('work_tasks', 'completion_note', 'text', false, NULL::text),
      ('work_tasks', 'completion_reason', 'text', false, NULL::text),
      ('cleaning_tasks', 'sort_index_cleaner', 'integer', false, NULL::text),
      ('cleaning_tasks', 'sort_index_inspector', 'integer', false, NULL::text),
      ('cleaning_tasks', 'checked_out_at', 'timestamp with time zone', false, NULL::text),
      ('cleaning_tasks', 'checkout_marked_by', 'text', false, NULL::text),
      ('cleaning_tasks', 'guest_special_request', 'text', false, NULL::text),
      ('cleaning_tasks', 'keys_required', 'integer', true, '1'),
      ('cleaning_tasks', 'inspection_mode', 'text', false, NULL::text),
      ('cleaning_tasks', 'inspection_scope', 'text', false, NULL::text),
      ('cleaning_tasks', 'inspection_due_date', 'date', false, NULL::text),
      ('orders', 'keys_required', 'integer', true, '1'),
      ('users', 'delete_password_hash', 'text', false, NULL::text),
      ('users', 'color_hex', 'text', true, '''#3B82F6''::text')
    ) AS expected(table_name, column_name, type_name, required_not_null, default_expression)
  LOOP
    SELECT
      format_type(attribute.atttypid, attribute.atttypmod),
      attribute.attnotnull,
      CASE WHEN attribute.atthasdef THEN pg_get_expr(default_value.adbin, default_value.adrelid) ELSE NULL END
    INTO actual_type, actual_not_null, actual_default
    FROM pg_attribute attribute
    LEFT JOIN pg_attrdef default_value
      ON default_value.adrelid = attribute.attrelid
     AND default_value.adnum = attribute.attnum
    WHERE attribute.attrelid = to_regclass(format('public.%I', expected.table_name))
      AND attribute.attname = expected.column_name
      AND NOT attribute.attisdropped;

    IF actual_type IS DISTINCT FROM expected.type_name
       OR actual_not_null IS DISTINCT FROM expected.required_not_null
       OR actual_default IS DISTINCT FROM expected.default_expression THEN
      RAISE EXCEPTION '% canonical contract mismatch (type %, not_null %, default %)',
        format('%s.%s', expected.table_name, expected.column_name),
        actual_type, actual_not_null, actual_default;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_sequence
    WHERE seqrelid = 'work_task_events_sequence_no_seq'::regclass
      AND seqtypid = 'int8'::regtype
  ) THEN
    RAISE EXCEPTION 'work_task_events_sequence_no_seq_type_mismatch';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_depend
    WHERE classid = 'pg_class'::regclass
      AND objid = 'work_task_events_sequence_no_seq'::regclass
      AND deptype IN ('a', 'i')
  ) THEN
    RAISE EXCEPTION 'work_task_events_sequence_no_seq_owned_by_column';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_attrdef default_value
    JOIN pg_attribute attribute
      ON attribute.attrelid = default_value.adrelid
     AND attribute.attnum = default_value.adnum
    WHERE attribute.attrelid = 'work_task_events'::regclass
      AND attribute.attname = 'sequence_no'
      AND NOT attribute.attisdropped
  ) THEN
    RAISE EXCEPTION 'work_task_events.sequence_no_default_present';
  END IF;

  FOR expected IN
    SELECT * FROM (VALUES
      ('idx_work_task_events_sequence_no', 'CREATE INDEX idx_work_task_events_sequence_no ON public.work_task_events USING btree (sequence_no)'),
      ('idx_work_task_events_task_id_version', 'CREATE INDEX idx_work_task_events_task_id_version ON public.work_task_events USING btree (task_id, task_version)'),
      ('idx_work_task_events_occurred_at', 'CREATE INDEX idx_work_task_events_occurred_at ON public.work_task_events USING btree (occurred_at DESC)'),
      ('idx_work_task_action_audits_source', 'CREATE INDEX idx_work_task_action_audits_source ON public.work_task_action_audits USING btree (source_type, source_id, performed_at DESC)'),
      ('idx_work_task_action_audits_actor', 'CREATE INDEX idx_work_task_action_audits_actor ON public.work_task_action_audits USING btree (actor_user_id, performed_at DESC)'),
      ('idx_work_task_action_audits_performer', 'CREATE INDEX idx_work_task_action_audits_performer ON public.work_task_action_audits USING btree (performed_by_user_id, performed_at DESC)'),
      ('idx_work_task_participants_source', 'CREATE INDEX idx_work_task_participants_source ON public.work_task_participants USING btree (source_type, source_id)'),
      ('idx_work_task_participants_user', 'CREATE INDEX idx_work_task_participants_user ON public.work_task_participants USING btree (user_id)'),
      ('uniq_work_task_participants_manual', 'CREATE UNIQUE INDEX uniq_work_task_participants_manual ON public.work_task_participants USING btree (source_type, source_id, user_id, source_relation)')
    ) AS expected(index_name, index_definition)
  LOOP
    SELECT pg_get_indexdef(index_class.oid)
      INTO actual_index_definition
      FROM pg_class index_class
      WHERE index_class.oid = to_regclass(format('public.%I', expected.index_name));
    IF actual_index_definition IS DISTINCT FROM expected.index_definition THEN
      RAISE EXCEPTION '% canonical index mismatch (%)', expected.index_name, actual_index_definition;
    END IF;
  END LOOP;

  FOR expected IN
    SELECT * FROM (VALUES
      ('work_task_events', 'PRIMARY KEY (id)'),
      ('work_task_events', 'UNIQUE (event_id)'),
      ('work_task_events', 'UNIQUE (sequence_no)'),
      ('work_task_event_versions', 'PRIMARY KEY (task_id)'),
      ('work_task_action_audits', 'PRIMARY KEY (id)'),
      ('work_task_participants', 'PRIMARY KEY (id)')
    ) AS expected(table_name, constraint_definition)
  LOOP
    SELECT pg_get_constraintdef(constraint_row.oid)
      INTO actual_constraint_definition
      FROM pg_constraint constraint_row
      WHERE constraint_row.conrelid = to_regclass(format('public.%I', expected.table_name))
        AND pg_get_constraintdef(constraint_row.oid) = expected.constraint_definition
      LIMIT 1;
    IF actual_constraint_definition IS DISTINCT FROM expected.constraint_definition THEN
      RAISE EXCEPTION '% canonical constraint missing (%)', expected.table_name, expected.constraint_definition;
    END IF;
  END LOOP;
END $$;

-- These dependencies already have canonical migrations. Verify once here rather
-- than recreating them from HTTP or cron code.
DO $$
BEGIN
  IF to_regclass('public.cleaning_sync_logs') IS NULL THEN
    RAISE EXCEPTION 'cleaning_sync_logs_missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'cleaning_sync_logs'::regclass
      AND attname = 'job_id'
      AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'cleaning_sync_logs.job_id_missing';
  END IF;
  IF (
    SELECT COUNT(*) FROM pg_attribute
    WHERE attrelid = 'cleaning_tasks'::regclass
      AND attname = ANY(ARRAY[
        'cleaner_id', 'inspector_id', 'execution_state', 'manual_task_purpose',
        'superseded_by', 'superseded_reason', 'superseded_at', 'supersede_conflicts',
        'inspection_replaced_by_checkin_task_id', 'inspection_replaced_original_due_date'
      ])
      AND NOT attisdropped
  ) <> 10 THEN
    RAISE EXCEPTION 'cleaning_tasks.cleaning_sync_dependencies_missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uniq_cleaning_tasks_order_task_type_v3'
  ) THEN
    RAISE EXCEPTION 'cleaning_tasks.unique_order_task_type_missing';
  END IF;
  IF to_regclass('public.idx_cleaning_tasks_execution_state') IS NULL
     OR to_regclass('public.idx_cleaning_tasks_active_lookup') IS NULL
     OR to_regclass('public.idx_cleaning_tasks_inspection_replacement_source') IS NULL THEN
    RAISE EXCEPTION 'cleaning_tasks.cleaning_sync_indexes_missing';
  END IF;
  IF to_regclass('public.mzapp_alerts') IS NULL THEN
    RAISE EXCEPTION 'mzapp_alerts_missing';
  END IF;
  IF to_regclass('public.idx_mzapp_alerts_target_unread') IS NULL
     OR to_regclass('public.idx_mzapp_alerts_kind') IS NULL
     OR to_regclass('public.uniq_mzapp_alerts_dedupe') IS NULL THEN
    RAISE EXCEPTION 'mzapp_alerts_indexes_missing';
  END IF;
  IF to_regclass('public.cleaning_day_end_handover') IS NULL THEN
    RAISE EXCEPTION 'cleaning_day_end_handover_missing';
  END IF;
  IF to_regclass('public.idx_cleaning_day_end_handover_date') IS NULL THEN
    RAISE EXCEPTION 'cleaning_day_end_handover_index_missing';
  END IF;
  IF to_regclass('public.cleaning_task_media') IS NULL THEN
    RAISE EXCEPTION 'cleaning_task_media_missing';
  END IF;
  IF to_regclass('public.idx_cleaning_task_media_task_type') IS NULL THEN
    RAISE EXCEPTION 'cleaning_task_media_task_type_index_missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'cleaning_tasks'::regclass
      AND attname = 'key_photo_uploaded_at'
      AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'cleaning_tasks.key_photo_uploaded_at_missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'cleaning_tasks'::regclass
      AND attname = 'sort_index_cleaner'
      AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'cleaning_tasks.sort_index_cleaner_missing';
  END IF;
  IF to_regclass('public.idx_cleaning_tasks_sort_cleaner') IS NULL THEN
    RAISE EXCEPTION 'cleaning_tasks.sort_index_cleaner_index_missing';
  END IF;
  IF (
    SELECT COUNT(*) FROM pg_attribute
    WHERE attrelid = 'cleaning_tasks'::regclass
      AND attname = ANY(ARRAY[
        'sort_index_cleaner', 'sort_index_inspector', 'checked_out_at',
        'checkout_marked_by', 'guest_special_request', 'keys_required',
        'inspection_mode', 'inspection_scope', 'inspection_due_date'
      ])
      AND NOT attisdropped
  ) <> 9 THEN
    RAISE EXCEPTION 'cleaning_tasks.r5_2a_task_list_columns_missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'orders'::regclass
      AND attname = 'keys_required'
      AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'orders.keys_required_missing';
  END IF;
END $$;

INSERT INTO schema_migrations (version) VALUES ('20260902_r5_2a_core_task_schema')
ON CONFLICT (version) DO NOTHING;

COMMIT;
