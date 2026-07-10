WITH candidates AS (
  SELECT t.id
  FROM cleaning_tasks t
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
UPDATE cleaning_tasks t
SET status = 'assigned',
    updated_at = now()
FROM candidates c
WHERE t.id = c.id
RETURNING
  t.id,
  COALESCE(t.task_date, t.date)::date AS task_day,
  t.property_id,
  COALESCE(t.task_type, t.type) AS task_type,
  t.status,
  t.assignee_id,
  t.cleaner_id,
  t.inspector_id,
  t.inspection_scope;
