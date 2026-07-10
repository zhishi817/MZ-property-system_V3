WITH candidates AS (
  SELECT
    t.id,
    COALESCE(t.task_date, t.date)::date AS task_day,
    p.region,
    p.code AS property_code,
    COALESCE(t.task_type, t.type) AS task_type,
    t.status,
    t.assignee_id,
    t.cleaner_id,
    t.inspector_id,
    t.inspection_scope
  FROM cleaning_tasks t
  LEFT JOIN properties p ON p.id = t.property_id
  WHERE COALESCE(t.execution_state, CASE WHEN lower(COALESCE(t.status, '')) IN ('cancelled', 'canceled') THEN 'cancelled' ELSE 'active' END) = 'active'
    AND lower(COALESCE(t.status, 'pending')) IN ('pending', 'todo', 'unassigned')
    AND (
      (
        lower(COALESCE(t.task_type, t.type, '')) = 'checkin_clean'
        AND COALESCE(NULLIF(t.inspection_scope, ''), 'inspect_and_hang') IN ('inspect_and_hang', 'password_only')
        AND (
          NULLIF(COALESCE(t.assignee_id, ''), '') IS NOT NULL
          OR NULLIF(COALESCE(t.inspector_id, ''), '') IS NOT NULL
        )
      )
      OR (
        NOT (
          lower(COALESCE(t.task_type, t.type, '')) = 'checkin_clean'
          AND COALESCE(NULLIF(t.inspection_scope, ''), 'inspect_and_hang') IN ('inspect_and_hang', 'password_only')
        )
        AND (
          NULLIF(COALESCE(t.cleaner_id, ''), '') IS NOT NULL
          OR NULLIF(COALESCE(t.assignee_id, ''), '') IS NOT NULL
          OR NULLIF(COALESCE(t.inspector_id, ''), '') IS NOT NULL
        )
      )
    )
)
SELECT
  count(*) AS candidate_count,
  count(*) FILTER (WHERE lower(COALESCE(task_type, '')) = 'checkin_clean') AS checkin_clean_count,
  count(*) FILTER (WHERE lower(COALESCE(task_type, '')) <> 'checkin_clean') AS other_cleaning_count
FROM candidates;

WITH candidates AS (
  SELECT
    t.id,
    COALESCE(t.task_date, t.date)::date AS task_day,
    p.region,
    p.code AS property_code,
    COALESCE(t.task_type, t.type) AS task_type,
    t.status,
    t.assignee_id,
    t.cleaner_id,
    t.inspector_id,
    t.inspection_scope
  FROM cleaning_tasks t
  LEFT JOIN properties p ON p.id = t.property_id
  WHERE COALESCE(t.execution_state, CASE WHEN lower(COALESCE(t.status, '')) IN ('cancelled', 'canceled') THEN 'cancelled' ELSE 'active' END) = 'active'
    AND lower(COALESCE(t.status, 'pending')) IN ('pending', 'todo', 'unassigned')
    AND (
      (
        lower(COALESCE(t.task_type, t.type, '')) = 'checkin_clean'
        AND COALESCE(NULLIF(t.inspection_scope, ''), 'inspect_and_hang') IN ('inspect_and_hang', 'password_only')
        AND (
          NULLIF(COALESCE(t.assignee_id, ''), '') IS NOT NULL
          OR NULLIF(COALESCE(t.inspector_id, ''), '') IS NOT NULL
        )
      )
      OR (
        NOT (
          lower(COALESCE(t.task_type, t.type, '')) = 'checkin_clean'
          AND COALESCE(NULLIF(t.inspection_scope, ''), 'inspect_and_hang') IN ('inspect_and_hang', 'password_only')
        )
        AND (
          NULLIF(COALESCE(t.cleaner_id, ''), '') IS NOT NULL
          OR NULLIF(COALESCE(t.assignee_id, ''), '') IS NOT NULL
          OR NULLIF(COALESCE(t.inspector_id, ''), '') IS NOT NULL
        )
      )
    )
)
SELECT *
FROM candidates
ORDER BY task_day DESC, region NULLS LAST, property_code NULLS LAST, task_type, id
LIMIT 100;
