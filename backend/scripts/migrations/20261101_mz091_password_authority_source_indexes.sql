BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM schema_migrations
    WHERE version = '20261101_mz091_password_authority'
  ) THEN
    RAISE EXCEPTION '20261101_mz091_password_authority must run before source indexes';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS cleaning_tasks_old_code_source_order_idx
  ON cleaning_tasks(old_code_source_order_id)
  WHERE old_code_source_order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS cleaning_tasks_old_code_source_task_idx
  ON cleaning_tasks(old_code_source_task_id)
  WHERE old_code_source_task_id IS NOT NULL;

INSERT INTO schema_migrations(version)
VALUES ('20261101_mz091_password_authority_source_indexes')
ON CONFLICT (version) DO NOTHING;

COMMIT;
