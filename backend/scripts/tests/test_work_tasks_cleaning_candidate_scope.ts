import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const source = fs.readFileSync(path.resolve(__dirname, '../../src/modules/mzapp.ts'), 'utf8')
const routeStart = source.indexOf("router.get('/work-tasks'")
const routeEnd = source.indexOf("router.post('/guest-ready-notifications'", routeStart)
assert.ok(routeStart >= 0 && routeEnd > routeStart, 'work-tasks route must remain discoverable')

const route = source.slice(routeStart, routeEnd)
const scheduledMatchStart = route.indexOf('WITH scheduled_match_ids AS MATERIALIZED')
const scheduledCandidateStart = route.indexOf('scheduled_candidate_ids AS MATERIALIZED', scheduledMatchStart)
const latestCancellationStart = route.indexOf('latest_cancellation_ids AS MATERIALIZED', scheduledCandidateStart)
const historicalStart = route.indexOf('historical_candidate_ids AS MATERIALIZED', latestCancellationStart)
const cancelledScheduledStart = route.indexOf('cancelled_scheduled_candidate_ids AS MATERIALIZED', historicalStart)
const candidateIdsStart = route.indexOf('candidate_task_ids AS MATERIALIZED', cancelledScheduledStart)
const candidateRowsStart = route.indexOf('candidate_tasks AS (', candidateIdsStart)
const latestMediaStart = route.indexOf('latest_media_raw AS (', candidateRowsStart)
assert.ok(
  scheduledMatchStart >= 0
    && scheduledCandidateStart > scheduledMatchStart
    && latestCancellationStart > scheduledCandidateStart
    && historicalStart > latestCancellationStart
    && cancelledScheduledStart > historicalStart
    && candidateIdsStart > historicalStart
    && candidateRowsStart > candidateIdsStart
    && latestMediaStart > candidateRowsStart,
  'cleaning candidate query must narrow scheduled and historical task ids before row enrichment',
)

const scheduledMatches = route.slice(scheduledMatchStart, scheduledCandidateStart)
assert.match(scheduledMatches, /COALESCE\(t\.task_date, t\.date\)::date[^\n]+\$1::date[^\n]+\$2::date/)
assert.match(scheduledMatches, /lower\(COALESCE\(t\.inspection_mode, ''\)\) = 'deferred'/)
assert.match(scheduledMatches, /t\.inspection_due_date::date/)
assert.match(scheduledMatches, /FROM cleaning_tasks incoming/)
assert.match(scheduledMatches, /lower\(COALESCE\(incoming\.inspection_scope, 'inspect_and_hang'\)\) <> 'password_only'/)
assert.match(scheduledMatches, /COALESCE\(incoming\.task_date, incoming\.date\)::date BETWEEN COALESCE\(t\.task_date, t\.date\)::date AND t\.inspection_due_date::date/)
assert.match(scheduledMatches, /activeCleaningTaskWhereSql\('incoming'\)/)
assert.match(scheduledMatches, /validCleaningTaskOrderWhereSql\('incoming', 'incoming_order'\)/)
assert.doesNotMatch(scheduledMatches, /activeCleaningTaskWhereSql\('t'\)/)

const scheduledCandidates = route.slice(scheduledCandidateStart, latestCancellationStart)
assert.match(scheduledCandidates, /FROM scheduled_match_ids scheduled/)
assert.match(scheduledCandidates, /activeCleaningTaskWhereSql\('t'\)/)
assert.match(scheduledCandidates, /validCleaningTaskOrderWhereSql\('t', 'o'\)/)

const latestCancellations = route.slice(latestCancellationStart, historicalStart)
assert.match(latestCancellations, /left\(event\.task_id, length\('cleaning_task:'\)\) = 'cleaning_task:'/)
assert.doesNotMatch(latestCancellations, /event\.task_id LIKE 'cleaning_task:%'/)
assert.match(latestCancellations, /event\.event_type = 'TASK_REMOVED'/)
assert.match(latestCancellations, /'cancelled', 'canceled'/)
assert.match(latestCancellations, /SELECT DISTINCT ON \(event\.task_id\)[\s\S]*?ORDER BY event\.task_id, event\.occurred_at DESC, event\.sequence_no DESC/)

const historicalIds = route.slice(historicalStart, cancelledScheduledStart)
assert.match(historicalIds, /audit\.performed_as_action IN \('complete_cleaning', 'submit_inspection'\)/)
assert.match(historicalIds, /COALESCE\(audit\.performed_by_user_id, audit\.actor_user_id\)::text = \$3::text/)
assert.match(historicalIds, /audit\.performed_at AT TIME ZONE 'Australia\/Melbourne'/)
assert.match(historicalIds, /media\.type = 'lockbox_video'/)
assert.match(historicalIds, /media\.uploader_id::text = \$3::text/)
assert.match(historicalIds, /media\.captured_at AT TIME ZONE 'Australia\/Melbourne'/)
assert.match(historicalIds, /latest_cancellation\.occurred_at AT TIME ZONE 'Australia\/Melbourne'/)

const cancelledScheduledIds = route.slice(cancelledScheduledStart, candidateIdsStart)
assert.match(cancelledScheduledIds, /FROM scheduled_match_ids scheduled/)
assert.match(cancelledScheduledIds, /JOIN latest_cancellation_ids latest_cancellation ON latest_cancellation\.id = scheduled\.id/)

const candidateIds = route.slice(candidateIdsStart, candidateRowsStart)
assert.match(candidateIds, /SELECT id FROM scheduled_candidate_ids[\s\S]*UNION[\s\S]*SELECT id FROM historical_candidate_ids[\s\S]*UNION[\s\S]*SELECT id FROM cancelled_scheduled_candidate_ids/)

const candidateRows = route.slice(candidateRowsStart, latestMediaStart)
const narrowedJoin = candidateRows.indexOf('FROM candidate_task_ids candidate_id')
const cleanerHistoryJoin = candidateRows.indexOf('LEFT JOIN LATERAL (')
assert.ok(narrowedJoin >= 0 && cleanerHistoryJoin > narrowedJoin, 'history LATERAL joins must run only after candidate-id narrowing')
assert.doesNotMatch(
  candidateRows.slice(0, narrowedJoin),
  /FROM cleaning_tasks t/,
  'candidate row enrichment must not start from the full cleaning_tasks table',
)
assert.match(candidateRows, /JOIN cleaning_tasks t ON t\.id::text = candidate_id\.id/)
assert.match(candidateRows, /audit\.performed_as_action = 'complete_cleaning'/)
assert.match(candidateRows, /audit\.performed_as_action = 'submit_inspection'/)
assert.match(candidateRows, /media\.type = 'lockbox_video'/)
assert.match(candidateRows, /event\.task_id = \('cleaning_task:' \|\| t\.id::text\)/)

for (const step of [
  'candidate_query',
  'arrangements',
  'guide_links',
  'record_evidence',
  'submission_ready',
  'manual_participants',
  'superseded',
  'guest_luggage_schema',
  'guest_luggage_rows',
  'guest_luggage_details',
  'restock_usage',
  'consumable_ids',
  'carry_forward',
  'completion_media',
  'completion_exceptions',
  'assembly',
]) {
  assert.match(route, new RegExp(`markCleaningPoolStep\\('${step}'\\)`), `missing cleaning_pool timing step ${step}`)
}
assert.match(route, /workTasksTimings\.push\(`cleaning_pool:\$\{Date\.now\(\) - cleaningPoolStartedAt\}`\)/)

console.log('work-tasks cleaning candidate scope contract passed')
