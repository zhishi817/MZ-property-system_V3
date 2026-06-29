ALTER TABLE cleaning_tasks
  ADD COLUMN IF NOT EXISTS execution_state text,
  ADD COLUMN IF NOT EXISTS manual_task_purpose text,
  ADD COLUMN IF NOT EXISTS superseded_by text,
  ADD COLUMN IF NOT EXISTS superseded_reason text,
  ADD COLUMN IF NOT EXISTS superseded_at timestamptz,
  ADD COLUMN IF NOT EXISTS supersede_conflicts jsonb NOT NULL DEFAULT '[]'::jsonb;

UPDATE cleaning_tasks
   SET execution_state = CASE
     WHEN lower(COALESCE(status, '')) IN ('cancelled','canceled') THEN 'cancelled'
     ELSE 'active'
   END
 WHERE execution_state IS NULL
    OR execution_state NOT IN ('active','superseded','cancelled');

ALTER TABLE cleaning_tasks
  ALTER COLUMN execution_state SET DEFAULT 'active',
  ALTER COLUMN execution_state SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cleaning_tasks_execution_state
  ON cleaning_tasks(execution_state);

CREATE INDEX IF NOT EXISTS idx_cleaning_tasks_active_lookup
  ON cleaning_tasks(property_id, task_date, task_type)
  WHERE execution_state = 'active';
