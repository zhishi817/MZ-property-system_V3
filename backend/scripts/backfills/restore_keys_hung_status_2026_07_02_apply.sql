BEGIN;

WITH last_lockbox_action AS (
  SELECT
    source_id::text AS task_id,
    max(performed_at) AS last_uploaded_at
  FROM work_task_action_audits
  WHERE source_type = 'cleaning_tasks'
    AND performed_as_action = 'upload_access_video'
    AND lower(COALESCE(status_after, '')) = 'keys_hung'
  GROUP BY source_id::text
),
lockbox_media AS (
  SELECT
    task_id::text AS task_id,
    max(COALESCE(captured_at, created_at)) AS last_media_at,
    count(*)::int AS media_count
  FROM cleaning_task_media
  WHERE type = 'lockbox_video'
  GROUP BY task_id::text
),
candidates AS (
  SELECT
    t.id::text AS task_id,
    t.status AS current_status,
    a.last_uploaded_at,
    m.last_media_at,
    COALESCE(m.media_count, 0) AS media_count
  FROM cleaning_tasks t
  JOIN last_lockbox_action a ON a.task_id = t.id::text
  LEFT JOIN lockbox_media m ON m.task_id = t.id::text
  WHERE lower(COALESCE(t.status, '')) IN ('assigned', 'pending', 'todo', 'scheduled', 'in_progress')
    AND (t.lockbox_video_uploaded_at IS NOT NULL OR COALESCE(m.media_count, 0) > 0)
),
updated AS (
  UPDATE cleaning_tasks t
  SET status = 'keys_hung',
      updated_at = now()
  FROM candidates c
  WHERE t.id::text = c.task_id
  RETURNING
    t.id::text AS task_id,
    t.property_id::text AS property_id,
    t.task_type,
    COALESCE(t.task_date, t.date)::date AS task_date,
    c.current_status AS previous_status,
    t.status AS new_status,
    t.assignee_id,
    t.cleaner_id,
    t.inspector_id,
    t.lockbox_video_uploaded_at,
    c.last_uploaded_at,
    c.last_media_at,
    c.media_count
)
SELECT *
FROM updated
ORDER BY task_date DESC NULLS LAST, property_id, task_id;

COMMIT;
