-- Adds per-assignee ordering indexes for cleaning/inspection task lists
ALTER TABLE IF EXISTS cleaning_tasks
  ADD COLUMN IF NOT EXISTS sort_index_cleaner integer;

ALTER TABLE IF EXISTS cleaning_tasks
  ADD COLUMN IF NOT EXISTS sort_index_inspector integer;

CREATE INDEX IF NOT EXISTS idx_cleaning_tasks_sort_cleaner
  ON cleaning_tasks (COALESCE(task_date, date), cleaner_id, sort_index_cleaner);

CREATE INDEX IF NOT EXISTS idx_cleaning_tasks_sort_inspector
  ON cleaning_tasks (COALESCE(task_date, date), inspector_id, sort_index_inspector);

