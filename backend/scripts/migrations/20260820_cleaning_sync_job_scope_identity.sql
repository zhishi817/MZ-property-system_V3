BEGIN;

DROP INDEX IF EXISTS uniq_cleaning_sync_jobs_order_action_active;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_cleaning_sync_jobs_order_action_active
  ON cleaning_sync_jobs(
    order_id,
    action,
    COALESCE(NULLIF(lower(trim(payload_snapshot->>'sync_scope')), ''), 'full')
  )
  WHERE status IN ('pending','running');

COMMIT;
