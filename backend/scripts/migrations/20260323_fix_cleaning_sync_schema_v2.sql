BEGIN;

CREATE TABLE IF NOT EXISTS cleaning_tasks (
  id text PRIMARY KEY,
  property_id text REFERENCES properties(id) ON DELETE SET NULL,
  date date,
  status text,
  assignee_id text,
  scheduled_at timestamptz,
  old_code text,
  new_code text,
  note text,
  checkout_time text,
  checkin_time text,
  order_id text,
  task_type text,
  task_date date,
  auto_sync_enabled boolean DEFAULT true,
  sync_fingerprint text,
  source text DEFAULT 'auto',
  updated_at timestamptz DEFAULT now(),
  cleaner_id text,
  inspector_id text,
  nights_override int,
  type text,
  auto_managed boolean,
  locked boolean,
  reschedule_required boolean,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS old_code text;
ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS new_code text;
ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS note text;
ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS checkout_time text;
ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS checkin_time text;
ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS order_id text;
ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS task_type text;
ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS task_date date;
ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS auto_sync_enabled boolean DEFAULT true;
ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS sync_fingerprint text;
ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS source text DEFAULT 'auto';
ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS cleaner_id text;
ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS inspector_id text;
ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS nights_override int;
ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS type text;
ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS auto_managed boolean;
ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS locked boolean;
ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS reschedule_required boolean;

CREATE INDEX IF NOT EXISTS idx_cleaning_tasks_task_date ON cleaning_tasks(task_date);
CREATE INDEX IF NOT EXISTS idx_cleaning_tasks_order_id ON cleaning_tasks(order_id);
CREATE INDEX IF NOT EXISTS idx_cleaning_tasks_status ON cleaning_tasks(status);

DO $$ DECLARE dup int; BEGIN
  SELECT COUNT(*)::int INTO dup
  FROM (
    SELECT 1
    FROM cleaning_tasks
    WHERE order_id IS NOT NULL AND task_type IS NOT NULL
    GROUP BY order_id, task_type
    HAVING COUNT(*) > 1
  ) x;
  IF dup > 0 THEN
    RAISE EXCEPTION 'cannot add uniq_cleaning_tasks_order_task_type_v3: duplicates exist (% groups)', dup;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_cleaning_tasks_order_task_type_v3') THEN
    ALTER TABLE cleaning_tasks ADD CONSTRAINT uniq_cleaning_tasks_order_task_type_v3 UNIQUE (order_id, task_type);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS cleaning_sync_logs (
  id text PRIMARY KEY,
  job_id text,
  order_id text,
  task_id text,
  action text,
  before jsonb,
  after jsonb,
  meta jsonb,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE cleaning_sync_logs ADD COLUMN IF NOT EXISTS job_id text;
CREATE INDEX IF NOT EXISTS idx_cleaning_sync_logs_order ON cleaning_sync_logs(order_id);
CREATE INDEX IF NOT EXISTS idx_cleaning_sync_logs_created_at ON cleaning_sync_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_cleaning_sync_logs_action ON cleaning_sync_logs(action);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_cleaning_sync_logs_job_action_task
  ON cleaning_sync_logs(job_id, action, task_id)
  WHERE job_id IS NOT NULL;

COMMIT;

