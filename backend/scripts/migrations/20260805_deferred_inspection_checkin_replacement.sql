BEGIN;

ALTER TABLE cleaning_tasks
  ADD COLUMN IF NOT EXISTS inspection_replaced_by_checkin_task_id text;

ALTER TABLE cleaning_tasks
  ADD COLUMN IF NOT EXISTS inspection_replaced_original_due_date date;

CREATE INDEX IF NOT EXISTS idx_cleaning_tasks_inspection_replacement_source
  ON cleaning_tasks(inspection_replaced_by_checkin_task_id)
  WHERE inspection_replaced_by_checkin_task_id IS NOT NULL;

COMMIT;
