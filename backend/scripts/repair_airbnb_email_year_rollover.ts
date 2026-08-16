import dotenv from 'dotenv'
import path from 'path'
import { Client } from 'pg'

dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), override: false })
dotenv.config()

type Candidate = {
  id: string
  checkin: string
  checkout: string
  next_checkin: string
  next_checkout: string
  email_header_at: Date
  nights_mismatch: boolean
  rollover_day_mismatch: boolean
  locked_task_count: number
  collision_task_count: number
}

const args = new Set(process.argv.slice(2))
const apply = args.has('--apply')
const acknowledgeCleaningJobs = args.has('--acknowledge-cleaning-jobs')
const expectedArg = [...args].find((arg) => arg.startsWith('--expected-count='))
const expectedCount = expectedArg ? Number(expectedArg.slice('--expected-count='.length)) : NaN

function stop(message: string): never {
  throw new Error(message)
}

function printUsage() {
  console.log([
    'Usage:',
    '  ts-node-dev --transpile-only scripts/repair_airbnb_email_year_rollover.ts',
    '  AIRBNB_EMAIL_YEAR_REPAIR_ALLOW_APPLY=1 ts-node-dev --transpile-only scripts/repair_airbnb_email_year_rollover.ts --apply --expected-count=<exact-count> --acknowledge-cleaning-jobs',
    '',
    'Default mode is read-only. Apply mode updates only high-confidence missing-year Airbnb email orders and enqueues the existing cleaning-sync jobs.',
  ].join('\n'))
}

const candidateSql = `
  WITH candidates AS (
    SELECT
      o.id::text AS id,
      o.checkin::date AS checkin,
      o.checkout::date AS checkout,
      (o.checkin::date + INTERVAL '1 year')::date AS next_checkin,
      (o.checkout::date + INTERVAL '1 year')::date AS next_checkout,
      o.email_header_at,
      o.nights,
      o.property_id::text AS property_id
    FROM orders o
    WHERE o.source IN ('airbnb_email', 'airbnb_email_import_v1')
      AND lower(COALESCE(o.status, '')) NOT IN ('cancelled', 'canceled', 'invalid')
      AND o.email_header_at IS NOT NULL
      AND COALESCE(o.year_inferred, false) = false
      AND o.raw_checkin_text IS NOT NULL
      AND o.raw_checkout_text IS NOT NULL
      AND COALESCE(o.raw_checkin_text, '') !~* '(?:^|[^0-9])(?:19|20)[0-9]{2}(?:[^0-9]|$)'
      AND COALESCE(o.raw_checkout_text, '') !~* '(?:^|[^0-9])(?:19|20)[0-9]{2}(?:[^0-9]|$)'
      AND o.checkin::date < ((o.email_header_at AT TIME ZONE 'Australia/Melbourne')::date)
      AND o.checkout::date < ((o.email_header_at AT TIME ZONE 'Australia/Melbourne')::date)
  )
  SELECT
    c.id,
    c.checkin::text,
    c.checkout::text,
    c.next_checkin::text,
    c.next_checkout::text,
    c.email_header_at,
    (c.checkin >= c.checkout OR c.nights IS NULL OR c.nights <= 0 OR (c.checkout - c.checkin) <> c.nights) AS nights_mismatch,
    (to_char(c.checkin, 'MM-DD') <> to_char(c.next_checkin, 'MM-DD') OR to_char(c.checkout, 'MM-DD') <> to_char(c.next_checkout, 'MM-DD')) AS rollover_day_mismatch,
    (
      SELECT COUNT(*)::int
      FROM cleaning_tasks t
      WHERE t.order_id::text = c.id
        AND COALESCE(t.execution_state, CASE WHEN lower(COALESCE(t.status, '')) IN ('cancelled', 'canceled') THEN 'cancelled' ELSE 'active' END) = 'active'
        AND lower(COALESCE(t.status, '')) IN ('in_progress', 'completed', 'checked', 'cleaned', 'restocked', 'restock_pending', 'inspected', 'keys_hung', 'done', 'ready', 'to_inspect', 'to_hang_keys')
    ) AS locked_task_count,
    (
      SELECT COUNT(*)::int
      FROM cleaning_tasks t
      WHERE t.order_id::text <> c.id
        AND t.property_id::text = c.property_id
        AND COALESCE(t.execution_state, CASE WHEN lower(COALESCE(t.status, '')) IN ('cancelled', 'canceled') THEN 'cancelled' ELSE 'active' END) = 'active'
        AND (
          (t.task_type = 'checkin_clean' AND t.task_date::date = c.next_checkin)
          OR (t.task_type = 'checkout_clean' AND t.task_date::date = c.next_checkout)
        )
    ) AS collision_task_count
  FROM candidates c
  ORDER BY c.id
`

async function loadCandidates(client: Client): Promise<Candidate[]> {
  const result = await client.query(candidateSql)
  return (result.rows || []).map((row: any) => ({
    id: String(row.id),
    checkin: String(row.checkin).slice(0, 10),
    checkout: String(row.checkout).slice(0, 10),
    next_checkin: String(row.next_checkin).slice(0, 10),
    next_checkout: String(row.next_checkout).slice(0, 10),
    email_header_at: row.email_header_at instanceof Date ? row.email_header_at : new Date(row.email_header_at),
    nights_mismatch: !!row.nights_mismatch,
    rollover_day_mismatch: !!row.rollover_day_mismatch,
    locked_task_count: Number(row.locked_task_count || 0),
    collision_task_count: Number(row.collision_task_count || 0),
  }))
}

function summarize(rows: Candidate[]) {
  return {
    candidate_count: rows.length,
    nights_mismatch_count: rows.filter((row) => row.nights_mismatch).length,
    rollover_day_mismatch_count: rows.filter((row) => row.rollover_day_mismatch).length,
    locked_task_count: rows.reduce((total, row) => total + row.locked_task_count, 0),
    collision_task_count: rows.reduce((total, row) => total + row.collision_task_count, 0),
  }
}

function hasBlockedCandidate(rows: Candidate[]) {
  return rows.some((row) => row.nights_mismatch || row.rollover_day_mismatch || row.locked_task_count > 0 || row.collision_task_count > 0)
}

async function main() {
  if (args.has('--help') || args.has('-h')) {
    printUsage()
    return
  }

  const connectionString = process.env.NEON_DATABASE_URL_PROD || process.env.DATABASE_URL
  if (!connectionString) stop('database_url_required')

  if (apply) {
    if (!Number.isInteger(expectedCount) || expectedCount <= 0) stop('apply_requires_exact_expected_count')
    if (!acknowledgeCleaningJobs) stop('apply_requires_acknowledge_cleaning_jobs')
    if (process.env.AIRBNB_EMAIL_YEAR_REPAIR_ALLOW_APPLY !== '1') stop('apply_requires_AIRBNB_EMAIL_YEAR_REPAIR_ALLOW_APPLY=1')
  }

  const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } })
  await client.connect()
  try {
    if (!apply) {
      await client.query('BEGIN TRANSACTION READ ONLY')
      const rows = await loadCandidates(client)
      await client.query('ROLLBACK')
      console.log(JSON.stringify({ mode: 'dry-run', ...summarize(rows) }))
      return
    }

    // The canonical queue worker owns task projection; this script must never patch cleaning_tasks directly.
    process.env.DATABASE_URL = connectionString
    const { enqueueCleaningSyncJobTx } = require('../src/services/cleaningSyncJobs') as typeof import('../src/services/cleaningSyncJobs')

    await client.query('BEGIN')
    const before = await loadCandidates(client)
    if (before.length !== expectedCount) stop(`candidate_count_changed: expected=${expectedCount} actual=${before.length}`)
    if (hasBlockedCandidate(before)) stop('candidate_preflight_blocked')

    await client.query('SELECT id FROM orders WHERE id::text = ANY($1::text[]) FOR UPDATE', [before.map((row) => row.id)])
    const rows = await loadCandidates(client)
    if (rows.length !== expectedCount || hasBlockedCandidate(rows)) stop('candidate_changed_while_locked')

    let queuedCleaningSyncJobs = 0
    for (const row of rows) {
      const updated = await client.query(
        `UPDATE orders
         SET checkin=$2::date, checkout=$3::date, year_inferred=true
         WHERE id::text=$1
           AND checkin::date=$4::date
           AND checkout::date=$5::date
           AND email_header_at=$6::timestamptz
         RETURNING id::text AS id`,
        [row.id, row.next_checkin, row.next_checkout, row.checkin, row.checkout, row.email_header_at],
      )
      if (Number(updated.rowCount || 0) !== 1) stop('order_changed_during_repair')
      const job = await enqueueCleaningSyncJobTx(client, {
        order_id: row.id,
        action: 'updated',
        payload_snapshot: { id: row.id, repair: 'airbnb_email_missing_year_rollover' },
      })
      if (!job.id) stop('cleaning_sync_job_not_queued')
      queuedCleaningSyncJobs += 1
    }
    await client.query('COMMIT')
    console.log(JSON.stringify({ mode: 'apply', updated_orders: rows.length, queued_cleaning_sync_jobs: queuedCleaningSyncJobs }))
  } catch (error) {
    try { await client.query('ROLLBACK') } catch {}
    throw error
  } finally {
    await client.end()
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ repair: 'airbnb_email_year_rollover', error: String(error?.message || error) }))
  process.exitCode = 1
})
