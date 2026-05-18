# Production Cost Reduction Runbook

This runbook supports the production cost reduction rollout for Neon + Render.

## Scope

- Keep external cron as the primary email sync scheduler.
- Disable duplicate in-process email sync scheduling by default.
- Observe 24h / 72h / 7d before removing watchdog or changing Neon suspend settings.
- Drain retryable backlog before disabling watchdog.

## New Ops Endpoints

These routes are mounted under `/jobs` and require `order.manage`.

- `GET /jobs/email-sync-runs`
  - Recent email sync runs, now including `trigger_source`.
- `GET /jobs/email-sync-status`
  - Per-account last run, running flag, cooldown, and latest `trigger_source`.
- `GET /jobs/state-changes`
  - Raw state transition log with `trigger_source`.
- `GET /jobs/email-sync-backlog-summary?account=&since_hours=`
  - Backlog summary for `failed` / `retry` / `skipped` email items.
  - Includes retryable backlog rollup and unresolved raw candidate count.
- `GET /jobs/email-sync-observability?account=`
  - 24h / 72h / 7d email sync baseline.
  - Includes trigger-source breakdown, hourly and daily buckets, backlog breakdown, and minutes since last success.
- `GET /jobs/cleaning-sync-observability`
  - 24h / 7d cleaning sync baseline.
  - Includes `cleaning_sync_logs` hourly/daily counts, action breakdown, and related `job_runs`.
- `GET /jobs/db-query-observability`
  - Returns top statements from `pg_stat_statements` when installed.

## Production Rollout Order

### Phase 1

- Deploy code first.
- Do not disable watchdog yet.
- Confirm `GET /jobs/email-sync-observability` and `GET /jobs/cleaning-sync-observability` both return data.
- Confirm `GET /jobs/db-query-observability` reports whether `pg_stat_statements` is installed.

### Phase 2

- Keep GitHub Actions external cron as the primary email sync trigger.
- Leave `/jobs/email-sync/cron-trigger`, `/jobs/email-sync/run`, and backfill endpoints available for manual recovery.
- Do not enable `EMAIL_SYNC_SCHEDULE_ENABLED` in production unless external cron is unavailable.

### Phase 3

- Use `GET /jobs/email-sync-backlog-summary` to measure retryable backlog.
- Drain backlog in batches:
  - `POST /jobs/email-sync/retry`
  - `POST /jobs/email-sync/run`
  - `POST /jobs/email-sync/backfill-raw-failed`
- Keep each batch limited to `50` UIDs/items to avoid creating new spikes.

### Phase 4

- Only after backlog remains low for at least 24h:
  - disable `EMAIL_SYNC_WATCHDOG_ENABLED`
- Keep external cron and manual recovery routes in place.

### Phase 5

- Review `GET /jobs/cleaning-sync-observability` before changing:
  - `CLEANING_SYNC_JOBS_ENABLED`
  - `CLEANING_BACKFILL_FAST_ENABLED`
  - `CLEANING_BACKFILL_SLOW_ENABLED`
  - `CLEANING_SYNC_RETRY_ENABLED`

### Phase 6

- After email sync and cleaning sync activity are both reduced:
  - adjust Neon production suspend timeout outside the repo
- Do not change Neon suspend timeout before activity has been reduced, or you risk replacing steady compute with repeated cold starts.

## Suggested Observation Windows

- `24h`
  - Confirm external cron continues to advance email sync without gaps.
  - Confirm no large new failure wave.
- `72h`
  - Confirm email sync run count drops below the previous baseline.
  - Confirm retryable backlog stays down.
- `7d`
  - Confirm lower Neon compute growth and lower cleaning/email noise.

## Manual External Settings Checklist

These are not controlled by this repo and still require dashboard/env changes:

- Production Render env:
  - `EMAIL_SYNC_SCHEDULE_ENABLED`
  - `EMAIL_SYNC_WATCHDOG_ENABLED`
  - `EMAIL_SYNC_CRON`
  - `EMAIL_SYNC_MIN_INTERVAL_MS`
  - `CLEANING_SYNC_JOBS_ENABLED`
  - `CLEANING_BACKFILL_FAST_ENABLED`
  - `CLEANING_BACKFILL_SLOW_ENABLED`
  - `CLEANING_SYNC_RETRY_ENABLED`
- Neon production:
  - install `pg_stat_statements`
  - note: the current MCP SQL path may run in a read-only transaction, so `CREATE EXTENSION` may still need to be executed from a writable Neon session or console
  - later adjust production suspend timeout from `0` to a real auto-suspend value
