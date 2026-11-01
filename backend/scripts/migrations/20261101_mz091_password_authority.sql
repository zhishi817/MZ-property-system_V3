BEGIN;

DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'schema_migrations_missing';
  END IF;
  IF to_regclass('public.cleaning_tasks') IS NULL THEN
    RAISE EXCEPTION 'cleaning_tasks_missing';
  END IF;
  IF to_regclass('public.work_task_events') IS NULL THEN
    RAISE EXCEPTION 'work_task_events_missing';
  END IF;
END $$;

ALTER TABLE cleaning_tasks
  ADD COLUMN IF NOT EXISTS old_code_authority_status text,
  ADD COLUMN IF NOT EXISTS new_code_authority_status text,
  ADD COLUMN IF NOT EXISTS old_code_source_task_id text,
  ADD COLUMN IF NOT EXISTS old_code_source_order_id text,
  ADD COLUMN IF NOT EXISTS old_code_source_field text,
  ADD COLUMN IF NOT EXISTS old_code_authority_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS new_code_authority_updated_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'cleaning_tasks_old_code_authority_status_check'
      AND conrelid = 'public.cleaning_tasks'::regclass
  ) THEN
    ALTER TABLE cleaning_tasks
      ADD CONSTRAINT cleaning_tasks_old_code_authority_status_check
      CHECK (
        old_code_authority_status IS NULL
        OR old_code_authority_status IN ('needs_review', 'auto_derived', 'source_linked', 'manual_confirmed', 'not_applicable')
      ) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'cleaning_tasks_new_code_authority_status_check'
      AND conrelid = 'public.cleaning_tasks'::regclass
  ) THEN
    ALTER TABLE cleaning_tasks
      ADD CONSTRAINT cleaning_tasks_new_code_authority_status_check
      CHECK (
        new_code_authority_status IS NULL
        OR new_code_authority_status IN ('needs_review', 'auto_derived', 'source_linked', 'manual_confirmed', 'not_applicable')
      ) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'cleaning_tasks_old_code_source_field_check'
      AND conrelid = 'public.cleaning_tasks'::regclass
  ) THEN
    ALTER TABLE cleaning_tasks
      ADD CONSTRAINT cleaning_tasks_old_code_source_field_check
      CHECK (
        old_code_source_field IS NULL
        OR old_code_source_field IN ('old_code', 'new_code', 'manual')
      ) NOT VALID;
  END IF;
END $$;

ALTER TABLE cleaning_tasks VALIDATE CONSTRAINT cleaning_tasks_old_code_authority_status_check;
ALTER TABLE cleaning_tasks VALIDATE CONSTRAINT cleaning_tasks_new_code_authority_status_check;
ALTER TABLE cleaning_tasks VALIDATE CONSTRAINT cleaning_tasks_old_code_source_field_check;

CREATE TABLE IF NOT EXISTS cleaning_password_authority_receipts (
  request_id text NOT NULL,
  task_id text NOT NULL,
  field text NOT NULL CHECK (field IN ('old_code', 'new_code')),
  actor_user_id text,
  actor_role text,
  client text NOT NULL CHECK (client IN ('web', 'mobile', 'api')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, task_id, field)
);

INSERT INTO schema_migrations(version)
VALUES ('20261101_mz091_password_authority')
ON CONFLICT (version) DO NOTHING;

COMMIT;
