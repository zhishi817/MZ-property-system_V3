BEGIN;

ALTER TABLE property_deep_cleaning
  ADD COLUMN IF NOT EXISTS source_task_id text;

CREATE INDEX IF NOT EXISTS idx_property_deep_cleaning_source_task
  ON property_deep_cleaning(source_task_id)
  WHERE source_task_id IS NOT NULL;

INSERT INTO schema_migrations(version)
VALUES ('20261022_property_deep_cleaning_source_task')
ON CONFLICT (version) DO NOTHING;

COMMIT;
