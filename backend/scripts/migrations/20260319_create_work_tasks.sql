-- Create unified work_tasks table (task center indexing layer)

CREATE TABLE IF NOT EXISTS work_tasks (
  id text PRIMARY KEY,
  task_kind text NOT NULL,
  source_type text NOT NULL,
  source_id text NOT NULL,
  property_id text,
  title text NOT NULL DEFAULT '',
  summary text,
  scheduled_date date,
  start_time text,
  end_time text,
  assignee_id text,
  status text NOT NULL DEFAULT 'todo',
  urgency text NOT NULL DEFAULT 'medium',
  created_by text,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_work_tasks_source ON work_tasks(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_work_tasks_day_assignee ON work_tasks(scheduled_date, assignee_id, status);
CREATE INDEX IF NOT EXISTS idx_work_tasks_kind_day ON work_tasks(task_kind, scheduled_date);
CREATE INDEX IF NOT EXISTS idx_work_tasks_day ON work_tasks(scheduled_date);

-- Backfill: offline tasks -> work_tasks
INSERT INTO work_tasks(
  id, task_kind, source_type, source_id, property_id,
  title, summary,
  scheduled_date, assignee_id,
  status, urgency,
  created_at, updated_at
)
SELECT
  ('cleaning_offline_tasks:' || t.id) AS id,
  'offline' AS task_kind,
  'cleaning_offline_tasks' AS source_type,
  t.id AS source_id,
  t.property_id,
  COALESCE(t.title, '') AS title,
  NULLIF(COALESCE(t.content, ''), '') AS summary,
  t.date::date AS scheduled_date,
  t.assignee_id,
  CASE
    WHEN t.status = 'done' THEN 'done'
    ELSE 'todo'
  END AS status,
  COALESCE(NULLIF(t.urgency, ''), 'medium') AS urgency,
  COALESCE(t.updated_at, t.created_at, now()) AS created_at,
  COALESCE(t.updated_at, t.created_at, now()) AS updated_at
FROM cleaning_offline_tasks t
ON CONFLICT (source_type, source_id) DO NOTHING;

-- Backfill: maintenance -> work_tasks
INSERT INTO work_tasks(
  id, task_kind, source_type, source_id, property_id,
  title, summary,
  scheduled_date, assignee_id,
  status, urgency,
  created_at, updated_at
)
SELECT
  ('property_maintenance:' || m.id) AS id,
  'maintenance' AS task_kind,
  'property_maintenance' AS source_type,
  m.id AS source_id,
  m.property_id,
  COALESCE(NULLIF(m.work_no, ''), m.id) AS title,
  NULLIF(COALESCE(m.details, ''), '') AS summary,
  m.eta AS scheduled_date,
  m.assignee_id,
  CASE
    WHEN m.status IN ('completed','done') THEN 'done'
    WHEN m.status IN ('cancelled','canceled') THEN 'cancelled'
    ELSE 'todo'
  END AS status,
  COALESCE(NULLIF(m.urgency, ''), 'medium') AS urgency,
  COALESCE(m.updated_at, m.created_at, now()) AS created_at,
  COALESCE(m.updated_at, m.created_at, now()) AS updated_at
FROM property_maintenance m
WHERE COALESCE(m.status, '') NOT IN ('completed','done','cancelled','canceled')
ON CONFLICT (source_type, source_id) DO NOTHING;

-- Backfill: deep cleaning -> work_tasks
INSERT INTO work_tasks(
  id, task_kind, source_type, source_id, property_id,
  title, summary,
  scheduled_date, assignee_id,
  status, urgency,
  created_at, updated_at
)
SELECT
  ('property_deep_cleaning:' || d.id) AS id,
  'deep_cleaning' AS task_kind,
  'property_deep_cleaning' AS source_type,
  d.id AS source_id,
  d.property_id,
  COALESCE(NULLIF(d.work_no, ''), d.id) AS title,
  NULLIF(COALESCE(d.project_desc, d.details, ''), '') AS summary,
  d.eta AS scheduled_date,
  d.assignee_id,
  CASE
    WHEN d.status IN ('completed','done') THEN 'done'
    WHEN d.status IN ('cancelled','canceled') THEN 'cancelled'
    ELSE 'todo'
  END AS status,
  COALESCE(NULLIF(d.urgency, ''), 'medium') AS urgency,
  COALESCE(d.updated_at, d.created_at, now()) AS created_at,
  COALESCE(d.updated_at, d.created_at, now()) AS updated_at
FROM property_deep_cleaning d
WHERE COALESCE(d.status, '') NOT IN ('completed','done','cancelled','canceled')
ON CONFLICT (source_type, source_id) DO NOTHING;
