BEGIN;

DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'schema_migrations_missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations
     WHERE version = '20260902_r5_2a_core_task_schema'
  ) THEN
    RAISE EXCEPTION 'required_migration_missing:20260902_r5_2a_core_task_schema';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION enforce_effective_inspection_assignment_conflict()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  requested_inspector text;
  requested_service_date date;
  existing_inspector text;
  order_is_valid boolean := true;
BEGIN
  IF lower(COALESCE(NEW.inspection_mode, '')) NOT IN ('same_day', 'deferred')
     OR lower(COALESCE(NEW.inspection_scope, 'inspect_and_hang')) = 'password_only'
     OR NOT (
       COALESCE(NEW.execution_state, CASE
         WHEN lower(COALESCE(NEW.status, '')) IN ('cancelled', 'canceled') THEN 'cancelled'
         ELSE 'active'
       END) = 'active'
       AND lower(COALESCE(NEW.status, '')) NOT IN ('cancelled', 'canceled')
     ) THEN
    RETURN NEW;
  END IF;

  IF NEW.order_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM orders o
       WHERE o.id::text = NEW.order_id::text
         AND NULLIF(TRIM(COALESCE(o.status, '')), '') IS NOT NULL
         AND lower(COALESCE(o.status, '')) <> 'invalid'
         AND lower(COALESCE(o.status, '')) NOT LIKE '%cancel%'
    ) INTO order_is_valid;
    IF NOT order_is_valid THEN RETURN NEW; END IF;
  END IF;

  -- Save-board writes the arrangement event after commit.  Its transaction-
  -- local boundary marks make close/reopen visible to this deferred trigger;
  -- persisted events remain the durable fallback for later transactions.
  IF COALESCE(NULLIF(current_setting('mz.inspection_management_closed_task_ids', true), ''), '[]')::jsonb ? NEW.id::text THEN
    RETURN NEW;
  END IF;
  IF NOT (
    COALESCE(NULLIF(current_setting('mz.inspection_management_reopened_task_ids', true), ''), '[]')::jsonb ? NEW.id::text
  ) AND EXISTS (
    SELECT 1
      FROM LATERAL (
        SELECT latest.payload#>'{arrangement_revision,reasons}' @> '["management_closed"]'::jsonb AS is_closed
          FROM work_task_events latest
         WHERE latest.task_id = 'cleaning_task:' || NEW.id::text
           AND latest.payload#>>'{arrangement_revision,version}' = 'mz031-v1'
           AND (
             latest.payload#>'{arrangement_revision,reasons}' @> '["management_closed"]'::jsonb
             OR latest.payload#>'{arrangement_revision,reasons}' @> '["management_reopened"]'::jsonb
           )
         ORDER BY latest.sequence_no DESC
         LIMIT 1
      ) latest_boundary
     WHERE latest_boundary.is_closed
  ) THEN
    RETURN NEW;
  END IF;

  -- Inspector ownership is explicit.  A check-in assignee is the on-site
  -- executor and must never be promoted to inspector by task shape or mode.
  requested_inspector := NEW.inspector_id::text;
  requested_service_date := CASE
    WHEN lower(COALESCE(NEW.inspection_mode, '')) = 'deferred' AND NEW.inspection_due_date IS NOT NULL
      THEN NEW.inspection_due_date
    ELSE COALESCE(NEW.task_date, NEW.date)
  END;
  IF NULLIF(TRIM(requested_inspector), '') IS NULL
     OR NEW.property_id IS NULL
     OR requested_service_date IS NULL THEN
    RETURN NEW;
  END IF;

  -- Serialize every writer (manager UI, sync, retry, and concurrent requests)
  -- on the same property/date without forbidding multiple task rows owned by
  -- the same effective inspector.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(NEW.property_id::text || ':' || requested_service_date::text, 34034)
  );

  SELECT other.inspector_id::text
    INTO existing_inspector
    FROM cleaning_tasks other
    LEFT JOIN orders other_order ON other_order.id::text = other.order_id::text
   WHERE other.id::text <> NEW.id::text
     AND other.property_id::text = NEW.property_id::text
     AND lower(COALESCE(other.inspection_mode, '')) IN ('same_day', 'deferred')
     AND lower(COALESCE(other.inspection_scope, 'inspect_and_hang')) <> 'password_only'
     AND (CASE
            WHEN lower(COALESCE(other.inspection_mode, '')) = 'deferred' AND other.inspection_due_date IS NOT NULL
              THEN other.inspection_due_date
            ELSE COALESCE(other.task_date, other.date)
          END) = requested_service_date
     AND COALESCE(other.execution_state, CASE
           WHEN lower(COALESCE(other.status, '')) IN ('cancelled', 'canceled') THEN 'cancelled'
           ELSE 'active'
         END) = 'active'
     AND lower(COALESCE(other.status, '')) NOT IN ('cancelled', 'canceled')
     AND NOT (
       COALESCE(NULLIF(current_setting('mz.inspection_management_closed_task_ids', true), ''), '[]')::jsonb ? other.id::text
     )
     AND (
       COALESCE(NULLIF(current_setting('mz.inspection_management_reopened_task_ids', true), ''), '[]')::jsonb ? other.id::text
       OR NOT EXISTS (
         SELECT 1
           FROM LATERAL (
             SELECT latest.payload#>'{arrangement_revision,reasons}' @> '["management_closed"]'::jsonb AS is_closed
               FROM work_task_events latest
              WHERE latest.task_id = 'cleaning_task:' || other.id::text
                AND latest.payload#>>'{arrangement_revision,version}' = 'mz031-v1'
                AND (
                  latest.payload#>'{arrangement_revision,reasons}' @> '["management_closed"]'::jsonb
                  OR latest.payload#>'{arrangement_revision,reasons}' @> '["management_reopened"]'::jsonb
                )
              ORDER BY latest.sequence_no DESC
              LIMIT 1
           ) latest_boundary
          WHERE latest_boundary.is_closed
       )
     )
     AND (
       other.order_id IS NULL
       OR (
         other_order.id IS NOT NULL
         AND NULLIF(TRIM(COALESCE(other_order.status, '')), '') IS NOT NULL
         AND lower(COALESCE(other_order.status, '')) <> 'invalid'
         AND lower(COALESCE(other_order.status, '')) NOT LIKE '%cancel%'
       )
     )
     AND NULLIF(TRIM(other.inspector_id::text), '') IS NOT NULL
     AND other.inspector_id::text IS DISTINCT FROM requested_inspector
   LIMIT 1;

  IF existing_inspector IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inspection_assignment_property_date_conflict',
      MESSAGE = 'inspection_assignment_property_date_conflict',
      DETAIL = format(
        'property_id=%s service_date=%s existing_inspector_id=%s requested_inspector_id=%s',
        NEW.property_id, requested_service_date, existing_inspector, requested_inspector
      );
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION first_effective_inspection_assignment_conflict()
RETURNS TABLE(
  conflict_property_id text,
  conflict_service_date date,
  existing_inspector_id text,
  requested_inspector_id text
)
LANGUAGE sql
STABLE
AS $$
  WITH effective_assignments AS (
    SELECT t.property_id::text AS property_id,
           CASE
             WHEN lower(COALESCE(t.inspection_mode, '')) = 'deferred' AND t.inspection_due_date IS NOT NULL
               THEN t.inspection_due_date
             ELSE COALESCE(t.task_date, t.date)
           END AS service_date,
           t.inspector_id::text AS inspector_id
      FROM cleaning_tasks t
      LEFT JOIN orders o ON o.id::text = t.order_id::text
     WHERE t.property_id IS NOT NULL
       AND lower(COALESCE(t.inspection_mode, '')) IN ('same_day', 'deferred')
       AND lower(COALESCE(t.inspection_scope, 'inspect_and_hang')) <> 'password_only'
       AND COALESCE(t.execution_state, CASE
             WHEN lower(COALESCE(t.status, '')) IN ('cancelled', 'canceled') THEN 'cancelled'
             ELSE 'active'
           END) = 'active'
       AND lower(COALESCE(t.status, '')) NOT IN ('cancelled', 'canceled')
       AND NULLIF(TRIM(t.inspector_id::text), '') IS NOT NULL
       AND (
         t.order_id IS NULL
         OR (
           o.id IS NOT NULL
           AND NULLIF(TRIM(COALESCE(o.status, '')), '') IS NOT NULL
           AND lower(COALESCE(o.status, '')) <> 'invalid'
           AND lower(COALESCE(o.status, '')) NOT LIKE '%cancel%'
         )
       )
       AND NOT (
         COALESCE(NULLIF(current_setting('mz.inspection_management_closed_task_ids', true), ''), '[]')::jsonb ? t.id::text
       )
       AND (
         COALESCE(NULLIF(current_setting('mz.inspection_management_reopened_task_ids', true), ''), '[]')::jsonb ? t.id::text
         OR NOT EXISTS (
           SELECT 1
             FROM LATERAL (
               SELECT latest.payload#>'{arrangement_revision,reasons}' @> '["management_closed"]'::jsonb AS is_closed
                 FROM work_task_events latest
                WHERE latest.task_id = 'cleaning_task:' || t.id::text
                  AND latest.payload#>>'{arrangement_revision,version}' = 'mz031-v1'
                  AND (
                    latest.payload#>'{arrangement_revision,reasons}' @> '["management_closed"]'::jsonb
                    OR latest.payload#>'{arrangement_revision,reasons}' @> '["management_reopened"]'::jsonb
                  )
                ORDER BY latest.sequence_no DESC
                LIMIT 1
             ) latest_boundary
            WHERE latest_boundary.is_closed
         )
       )
  ), conflicts AS (
    SELECT property_id, service_date,
           MIN(inspector_id) AS first_inspector_id,
           MAX(inspector_id) AS second_inspector_id
      FROM effective_assignments
     WHERE service_date IS NOT NULL
     GROUP BY property_id, service_date
    HAVING COUNT(DISTINCT inspector_id) > 1
     ORDER BY service_date, property_id
     LIMIT 1
  )
  SELECT property_id, service_date, first_inspector_id, second_inspector_id
    FROM conflicts;
$$;

CREATE OR REPLACE FUNCTION enforce_inspection_management_event_conflict()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  affected_task_id text;
  old_task_id text;
  new_task_id text;
  requested_property_id text;
  requested_service_date date;
  latest_is_closed boolean;
  requires_check boolean := false;
  conflict record;
BEGIN
  -- A boundary event can change effective inspection ownership without
  -- updating cleaning_tasks.  Validate insert/update/delete so replacing or
  -- removing a later close cannot reveal an unchecked reopen either.
  IF TG_OP = 'INSERT' THEN
    new_task_id := NEW.task_id;
    IF NEW.payload#>>'{arrangement_revision,version}' IS DISTINCT FROM 'mz031-v1'
       OR NOT COALESCE((
         NEW.payload#>'{arrangement_revision,reasons}' @> '["management_closed"]'::jsonb
         OR NEW.payload#>'{arrangement_revision,reasons}' @> '["management_reopened"]'::jsonb
       ), false) THEN
      RETURN NEW;
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    old_task_id := OLD.task_id;
    IF OLD.payload#>>'{arrangement_revision,version}' IS DISTINCT FROM 'mz031-v1'
       OR NOT COALESCE((
         OLD.payload#>'{arrangement_revision,reasons}' @> '["management_closed"]'::jsonb
         OR OLD.payload#>'{arrangement_revision,reasons}' @> '["management_reopened"]'::jsonb
       ), false) THEN
      RETURN OLD;
    END IF;
  ELSE
    old_task_id := OLD.task_id;
    new_task_id := NEW.task_id;
    IF NOT COALESCE((
      (
        NEW.payload#>>'{arrangement_revision,version}' = 'mz031-v1'
        AND (
          NEW.payload#>'{arrangement_revision,reasons}' @> '["management_closed"]'::jsonb
          OR NEW.payload#>'{arrangement_revision,reasons}' @> '["management_reopened"]'::jsonb
        )
      )
      OR (
        OLD.payload#>>'{arrangement_revision,version}' = 'mz031-v1'
        AND (
          OLD.payload#>'{arrangement_revision,reasons}' @> '["management_closed"]'::jsonb
          OR OLD.payload#>'{arrangement_revision,reasons}' @> '["management_reopened"]'::jsonb
        )
      )
    ), false) THEN
      RETURN NEW;
    END IF;
  END IF;

  -- An UPDATE may move a boundary event between task ids. Lock every task
  -- whose final boundary is not closed (reopened or absent), in deterministic
  -- order, before the global invariant check so the old and new groups cannot
  -- race each other. Deleting/moving the only close makes the task effective.
  FOR affected_task_id IN
    SELECT DISTINCT candidate.task_id
      FROM unnest(ARRAY[old_task_id, new_task_id]) AS candidate(task_id)
     WHERE candidate.task_id LIKE 'cleaning_task:%'
     ORDER BY candidate.task_id
  LOOP
    latest_is_closed := NULL;
    SELECT latest.payload#>'{arrangement_revision,reasons}' @> '["management_closed"]'::jsonb
      INTO latest_is_closed
      FROM work_task_events latest
     WHERE latest.task_id = affected_task_id
       AND latest.payload#>>'{arrangement_revision,version}' = 'mz031-v1'
       AND (
         latest.payload#>'{arrangement_revision,reasons}' @> '["management_closed"]'::jsonb
         OR latest.payload#>'{arrangement_revision,reasons}' @> '["management_reopened"]'::jsonb
       )
     ORDER BY latest.sequence_no DESC, latest.id DESC
     LIMIT 1;
    IF FOUND AND latest_is_closed THEN CONTINUE; END IF;

    requested_property_id := NULL;
    requested_service_date := NULL;
    SELECT t.property_id::text,
           CASE
             WHEN lower(COALESCE(t.inspection_mode, '')) = 'deferred' AND t.inspection_due_date IS NOT NULL
               THEN t.inspection_due_date
             ELSE COALESCE(t.task_date, t.date)
           END
      INTO requested_property_id, requested_service_date
      FROM cleaning_tasks t
     WHERE 'cleaning_task:' || t.id::text = affected_task_id;
    IF requested_property_id IS NULL OR requested_service_date IS NULL THEN CONTINUE; END IF;

    PERFORM pg_advisory_xact_lock(
      hashtextextended(requested_property_id || ':' || requested_service_date::text, 34034)
    );
    requires_check := true;
  END LOOP;

  IF NOT requires_check THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  SELECT * INTO conflict FROM first_effective_inspection_assignment_conflict();
  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inspection_assignment_property_date_conflict',
      MESSAGE = 'inspection_assignment_property_date_conflict',
      DETAIL = format(
        'property_id=%s service_date=%s existing_inspector_id=%s requested_inspector_id=%s',
        conflict.conflict_property_id, conflict.conflict_service_date,
        conflict.existing_inspector_id, conflict.requested_inspector_id
      );
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;

-- Refuse installation over ambiguous existing ownership.  This makes cleanup
-- an explicit release prerequisite instead of causing unrelated later writes
-- to fail under the newly installed deferred trigger.
-- Hold every mutation surface until COMMIT so no conflict can slip between
-- the preflight snapshot and trigger installation.
LOCK TABLE cleaning_tasks, orders, work_task_events IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  conflict record;
BEGIN
  SELECT * INTO conflict FROM first_effective_inspection_assignment_conflict();
  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'inspection_assignment_property_date_conflict',
      MESSAGE = 'existing_inspection_assignment_property_date_conflict',
      DETAIL = format(
        'property_id=%s service_date=%s existing_inspector_id=%s requested_inspector_id=%s',
        conflict.conflict_property_id, conflict.conflict_service_date,
        conflict.existing_inspector_id, conflict.requested_inspector_id
      ),
      HINT = 'Resolve existing inspection ownership conflicts before applying this migration.';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION enforce_order_reactivation_inspection_conflict()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  requested record;
  existing_inspector text;
BEGIN
  IF NULLIF(TRIM(COALESCE(NEW.status, '')), '') IS NULL
     OR lower(COALESCE(NEW.status, '')) = 'invalid'
     OR lower(COALESCE(NEW.status, '')) LIKE '%cancel%' THEN
    RETURN NEW;
  END IF;
  IF NULLIF(TRIM(COALESCE(OLD.status, '')), '') IS NOT NULL
     AND lower(COALESCE(OLD.status, '')) <> 'invalid'
     AND lower(COALESCE(OLD.status, '')) NOT LIKE '%cancel%' THEN
    RETURN NEW;
  END IF;

  FOR requested IN
    SELECT t.id::text AS task_id,
           t.property_id::text AS property_id,
           CASE
             WHEN lower(COALESCE(t.inspection_mode, '')) = 'deferred' AND t.inspection_due_date IS NOT NULL
               THEN t.inspection_due_date
             ELSE COALESCE(t.task_date, t.date)
           END AS service_date,
           t.inspector_id::text AS inspector_id
      FROM cleaning_tasks t
     WHERE t.order_id::text = NEW.id::text
       AND t.property_id IS NOT NULL
       AND lower(COALESCE(t.inspection_mode, '')) IN ('same_day', 'deferred')
       AND lower(COALESCE(t.inspection_scope, 'inspect_and_hang')) <> 'password_only'
       AND COALESCE(t.execution_state, CASE
             WHEN lower(COALESCE(t.status, '')) IN ('cancelled', 'canceled') THEN 'cancelled'
             ELSE 'active'
           END) = 'active'
       AND lower(COALESCE(t.status, '')) NOT IN ('cancelled', 'canceled')
       AND NULLIF(TRIM(t.inspector_id::text), '') IS NOT NULL
       AND NOT (
         COALESCE(NULLIF(current_setting('mz.inspection_management_closed_task_ids', true), ''), '[]')::jsonb ? t.id::text
       )
       AND (
         COALESCE(NULLIF(current_setting('mz.inspection_management_reopened_task_ids', true), ''), '[]')::jsonb ? t.id::text
         OR NOT EXISTS (
           SELECT 1
             FROM LATERAL (
               SELECT latest.payload#>'{arrangement_revision,reasons}' @> '["management_closed"]'::jsonb AS is_closed
                 FROM work_task_events latest
                WHERE latest.task_id = 'cleaning_task:' || t.id::text
                  AND latest.payload#>>'{arrangement_revision,version}' = 'mz031-v1'
                  AND (
                    latest.payload#>'{arrangement_revision,reasons}' @> '["management_closed"]'::jsonb
                    OR latest.payload#>'{arrangement_revision,reasons}' @> '["management_reopened"]'::jsonb
                  )
                ORDER BY latest.sequence_no DESC
                LIMIT 1
             ) latest_boundary
            WHERE latest_boundary.is_closed
         )
       )
     ORDER BY t.property_id::text, service_date, t.id::text
  LOOP
    IF requested.service_date IS NULL THEN CONTINUE; END IF;
    PERFORM pg_advisory_xact_lock(
      hashtextextended(requested.property_id || ':' || requested.service_date::text, 34034)
    );

    SELECT other.inspector_id::text
      INTO existing_inspector
      FROM cleaning_tasks other
      LEFT JOIN orders other_order ON other_order.id::text = other.order_id::text
     WHERE other.id::text <> requested.task_id
       AND other.property_id::text = requested.property_id
       AND lower(COALESCE(other.inspection_mode, '')) IN ('same_day', 'deferred')
       AND lower(COALESCE(other.inspection_scope, 'inspect_and_hang')) <> 'password_only'
       AND (CASE
              WHEN lower(COALESCE(other.inspection_mode, '')) = 'deferred' AND other.inspection_due_date IS NOT NULL
                THEN other.inspection_due_date
              ELSE COALESCE(other.task_date, other.date)
            END) = requested.service_date
       AND COALESCE(other.execution_state, CASE
             WHEN lower(COALESCE(other.status, '')) IN ('cancelled', 'canceled') THEN 'cancelled'
             ELSE 'active'
           END) = 'active'
       AND lower(COALESCE(other.status, '')) NOT IN ('cancelled', 'canceled')
       AND NULLIF(TRIM(other.inspector_id::text), '') IS NOT NULL
       AND NOT (
         COALESCE(NULLIF(current_setting('mz.inspection_management_closed_task_ids', true), ''), '[]')::jsonb ? other.id::text
       )
       AND (
         COALESCE(NULLIF(current_setting('mz.inspection_management_reopened_task_ids', true), ''), '[]')::jsonb ? other.id::text
         OR NOT EXISTS (
           SELECT 1
             FROM LATERAL (
               SELECT latest.payload#>'{arrangement_revision,reasons}' @> '["management_closed"]'::jsonb AS is_closed
                 FROM work_task_events latest
                WHERE latest.task_id = 'cleaning_task:' || other.id::text
                  AND latest.payload#>>'{arrangement_revision,version}' = 'mz031-v1'
                  AND (
                    latest.payload#>'{arrangement_revision,reasons}' @> '["management_closed"]'::jsonb
                    OR latest.payload#>'{arrangement_revision,reasons}' @> '["management_reopened"]'::jsonb
                  )
                ORDER BY latest.sequence_no DESC
                LIMIT 1
             ) latest_boundary
            WHERE latest_boundary.is_closed
         )
       )
       AND (
         other.order_id IS NULL
         OR (
           other_order.id IS NOT NULL
           AND NULLIF(TRIM(COALESCE(other_order.status, '')), '') IS NOT NULL
           AND lower(COALESCE(other_order.status, '')) <> 'invalid'
           AND lower(COALESCE(other_order.status, '')) NOT LIKE '%cancel%'
         )
       )
       AND other.inspector_id::text IS DISTINCT FROM requested.inspector_id
     LIMIT 1;

    IF existing_inspector IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'inspection_assignment_property_date_conflict',
        MESSAGE = 'inspection_assignment_property_date_conflict',
        DETAIL = format(
          'property_id=%s service_date=%s existing_inspector_id=%s requested_inspector_id=%s',
          requested.property_id, requested.service_date, existing_inspector, requested.inspector_id
        );
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_effective_inspection_assignment_conflict ON cleaning_tasks;
CREATE CONSTRAINT TRIGGER trg_effective_inspection_assignment_conflict
AFTER INSERT OR UPDATE
ON cleaning_tasks
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_effective_inspection_assignment_conflict();

DROP TRIGGER IF EXISTS trg_order_reactivation_inspection_conflict ON orders;
CREATE CONSTRAINT TRIGGER trg_order_reactivation_inspection_conflict
AFTER UPDATE
ON orders
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (
  NULLIF(TRIM(COALESCE(NEW.status, '')), '') IS NOT NULL
  AND lower(COALESCE(NEW.status, '')) <> 'invalid'
  AND lower(COALESCE(NEW.status, '')) NOT LIKE '%cancel%'
  AND (
    NULLIF(TRIM(COALESCE(OLD.status, '')), '') IS NULL
    OR lower(COALESCE(OLD.status, '')) = 'invalid'
    OR lower(COALESCE(OLD.status, '')) LIKE '%cancel%'
  )
)
EXECUTE FUNCTION enforce_order_reactivation_inspection_conflict();

DROP TRIGGER IF EXISTS trg_inspection_management_event_conflict ON work_task_events;
CREATE CONSTRAINT TRIGGER trg_inspection_management_event_conflict
AFTER INSERT OR UPDATE OR DELETE
ON work_task_events
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_inspection_management_event_conflict();

INSERT INTO schema_migrations (version)
VALUES ('20261013_inspection_assignment_conflict_guard')
ON CONFLICT (version) DO NOTHING;

COMMIT;
