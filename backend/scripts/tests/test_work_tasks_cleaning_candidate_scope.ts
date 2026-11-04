import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const source = fs.readFileSync(path.resolve(__dirname, '../../src/modules/mzapp.ts'), 'utf8')
const completionEvidenceSource = fs.readFileSync(path.resolve(__dirname, '../../src/lib/cleaningCompletionEvidence.ts'), 'utf8')
const routeStart = source.indexOf("router.get('/work-tasks'")
const routeEnd = source.indexOf("router.post('/guest-ready-notifications'", routeStart)
assert.ok(routeStart >= 0 && routeEnd > routeStart, 'work-tasks route must remain discoverable')

const route = source.slice(routeStart, routeEnd)
const scheduledMatchStart = route.indexOf('WITH scheduled_match_ids AS MATERIALIZED')
const scheduledCandidateStart = route.indexOf('scheduled_candidate_ids AS MATERIALIZED', scheduledMatchStart)
const latestCancellationStart = route.indexOf('latest_cancellation_ids AS MATERIALIZED', scheduledCandidateStart)
const lockboxCandidateStart = route.indexOf('lockbox_video_candidate_task_ids AS MATERIALIZED', latestCancellationStart)
const currentLockboxStart = route.indexOf('current_lockbox_video AS MATERIALIZED', lockboxCandidateStart)
const currentLockboxActorStart = route.indexOf('current_lockbox_video_actor AS MATERIALIZED', currentLockboxStart)
const historicalStart = route.indexOf('historical_candidate_ids AS MATERIALIZED', currentLockboxActorStart)
const cancelledScheduledStart = route.indexOf('cancelled_scheduled_candidate_ids AS MATERIALIZED', historicalStart)
const candidateSourcesStart = route.indexOf('candidate_task_id_sources AS MATERIALIZED', cancelledScheduledStart)
const candidateIdsStart = route.indexOf('candidate_task_ids AS MATERIALIZED', candidateSourcesStart)
const candidateRowsStart = route.indexOf('candidate_tasks AS (', candidateIdsStart)
const latestMediaStart = route.indexOf('latest_media_raw AS (', candidateRowsStart)
assert.ok(
  scheduledMatchStart >= 0
    && scheduledCandidateStart > scheduledMatchStart
    && latestCancellationStart > scheduledCandidateStart
    && lockboxCandidateStart > latestCancellationStart
    && currentLockboxStart > lockboxCandidateStart
    && currentLockboxActorStart > currentLockboxStart
    && historicalStart > currentLockboxActorStart
    && cancelledScheduledStart > historicalStart
    && candidateSourcesStart > cancelledScheduledStart
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

const latestCancellations = route.slice(latestCancellationStart, lockboxCandidateStart)
assert.match(latestCancellations, /left\(event\.task_id, length\('cleaning_task:'\)\) = 'cleaning_task:'/)
assert.doesNotMatch(latestCancellations, /event\.task_id LIKE 'cleaning_task:%'/)
assert.match(latestCancellations, /'cancelled', 'canceled'/)
assert.doesNotMatch(latestCancellations, /event\.event_type = 'TASK_REMOVED'/)
assert.match(latestCancellations, /SELECT DISTINCT ON \(event\.task_id\)[\s\S]*?ORDER BY event\.task_id, event\.occurred_at DESC, event\.sequence_no DESC/)

const lockboxCandidates = route.slice(lockboxCandidateStart, currentLockboxStart)
assert.match(lockboxCandidates, /SELECT id FROM scheduled_candidate_ids/)
assert.match(lockboxCandidates, /FROM cleaning_task_media media/)
assert.match(lockboxCandidates, /COALESCE\(media\.captured_at, media\.created_at\)/)
assert.match(lockboxCandidates, /FROM work_task_action_audits audit/)
assert.match(lockboxCandidates, /audit\.performed_as_action = 'upload_access_video'/)
assert.match(lockboxCandidates, /cleaningAuditBusinessDateSql\('audit'\)/)

const currentLockbox = route.slice(currentLockboxStart, currentLockboxActorStart)
assert.match(currentLockbox, /SELECT DISTINCT ON \(media\.task_id::text\)/)
assert.match(currentLockbox, /media\.type = 'lockbox_video'/)
assert.match(currentLockbox, /JOIN lockbox_video_candidate_task_ids candidate ON candidate\.id = media\.task_id::text/)
assert.doesNotMatch(currentLockbox, /\$1::date|\$2::date/, 'date narrowing must choose task ids before selecting the globally current video')
assert.match(currentLockbox, /ORDER BY media\.task_id::text, media\.created_at DESC NULLS LAST/)

const currentLockboxActor = route.slice(currentLockboxActorStart, historicalStart)
assert.match(currentLockboxActor, /audit\.performed_as_action = 'upload_access_video'/)
assert.match(currentLockboxActor, /audit\.created_at = video\.created_at/)
assert.match(currentLockboxActor, /latest_upload\.record_date AS audit_record_date/)
assert.match(currentLockboxActor, /latest_upload\.actor_user_id AS audit_actor_user_id/)
assert.doesNotMatch(currentLockboxActor, /COALESCE\(video\.uploader_id, latest_upload\.actor_user_id\)/, 'uploader and audit actor are independent legal evidence')

const historicalIds = route.slice(historicalStart, cancelledScheduledStart)
assert.match(historicalIds, /cleaningCompletionAuditWhereSql\('audit'\)/)
assert.match(historicalIds, /inspectionSubmissionAuditWhereSql\('audit'\)/)
assert.match(historicalIds, /COALESCE\(audit\.performed_by_user_id, audit\.actor_user_id\)::text = \$3::text/)
assert.match(historicalIds, /cleaningAuditBusinessDateSql\('audit'\)/)
assert.match(historicalIds, /FROM cleaning_task_media media/)
assert.match(historicalIds, /JOIN cleaning_tasks media_task ON media_task\.id::text = media\.task_id::text/)
assert.match(historicalIds, /NOT \([\s\S]*?media_task\.inspection_scope[\s\S]*?= 'password_only'/, 'checkout, self-complete and ordinary inspection videos retain the origin\/Dev uploader history path')
assert.match(historicalIds, /FROM current_lockbox_video_actor video/)
assert.match(historicalIds, /JOIN cleaning_tasks video_task ON video_task\.id::text = video\.task_id/)
assert.match(historicalIds, /lower\(COALESCE\(video_task\.task_type, video_task\.type, ''\)\) = 'checkin_clean'/)
assert.match(historicalIds, /lower\(COALESCE\(video_task\.inspection_scope, 'inspect_and_hang'\)\) = 'password_only'/)
assert.match(historicalIds, /video\.uploader_id = \$3::text/)
assert.match(historicalIds, /video\.audit_actor_user_id = \$3::text/)
assert.match(historicalIds, /video\.audit_record_date BETWEEN \$1::date AND \$2::date/)
assert.match(historicalIds, /latest_cancellation\.occurred_at AT TIME ZONE 'Australia\/Melbourne'/)

const cancelledScheduledIds = route.slice(cancelledScheduledStart, candidateSourcesStart)
assert.match(cancelledScheduledIds, /FROM scheduled_match_ids scheduled/)
assert.match(cancelledScheduledIds, /JOIN latest_cancellation_ids latest_cancellation ON latest_cancellation\.id = scheduled\.id/)

const candidateSources = route.slice(candidateSourcesStart, candidateIdsStart)
assert.match(candidateSources, /SELECT id, false AS historical_evidence FROM scheduled_candidate_ids[\s\S]*UNION ALL[\s\S]*SELECT id, true AS historical_evidence FROM historical_candidate_ids/)

const candidateIds = route.slice(candidateIdsStart, candidateRowsStart)
assert.match(candidateIds, /SELECT id, bool_or\(historical_evidence\) AS historical_evidence[\s\S]*FROM candidate_task_id_sources[\s\S]*GROUP BY id/)

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
assert.match(candidateRows, /cleaningCompletionAuditWhereSql\('audit'\)/)
assert.match(candidateRows, /inspectionSubmissionAuditWhereSql\('audit'\)/)
assert.match(candidateRows, /FROM current_lockbox_video_actor video/)
assert.match(candidateRows, /lower\(COALESCE\(t\.task_type, t\.type, ''\)\) = 'checkin_clean'/)
assert.match(candidateRows, /lower\(COALESCE\(t\.inspection_scope, 'inspect_and_hang'\)\) = 'password_only'/)
assert.match(candidateRows, /video\.audit_actor_user_id IS DISTINCT FROM video\.uploader_id/)
assert.match(candidateRows, /video\.audit_actor_user_id = \$3::text/)
assert.match(candidateRows, /video\.uploader_id = \$3::text/)
assert.match(candidateRows, /FROM cleaning_task_media media/)
assert.match(candidateRows, /NOT \([\s\S]*?t\.inspection_scope[\s\S]*?= 'password_only'/, 'non-password-only executor records retain their original media evidence path')
assert.match(candidateRows, /evidence\.evidence_priority/)
assert.match(candidateRows, /event\.task_id = \('cleaning_task:' \|\| t\.id::text\)/)
assert.match(
  candidateRows,
  /WHERE COALESCE\(candidate_cancellation\.is_deleted, false\) = false[\s\S]*?lower\(COALESCE\(t\.execution_state, ''\)\) <> 'superseded'[\s\S]*?OR candidate_id\.historical_evidence = true/,
  'superseded rows may be read only when immutable historical evidence selected them',
)
assert.match(route, /isActiveCleaningTurnoverCandidate\(row\)/, 'superseded historical rows must not re-enter live role groups')
assert.match(
  route,
  /keyHandoverSourceIds\.includes\(String\(row\?\.__raw_id \|\| row\?\.source_id \|\| row\?\.id \|\| ''\)\)/,
  'canonical relation rows must retain raw query ids when the visible phase is later manager-merged',
)
assert.match(
  route,
  /__raw_id: row\.__raw_id \|\| row\.source_id \|\| row\.id/,
  'manager merge handover source rows must preserve the exact source identity',
)

const latestMediaEnd = route.indexOf('latest_media AS (', latestMediaStart)
const latestMediaRaw = route.slice(latestMediaStart, latestMediaEnd)
assert.match(
  latestMediaRaw,
  /WHEN m\.type = 'lockbox_video'[\s\S]*?ct\.task_type[\s\S]*?= 'checkin_clean'[\s\S]*?ct\.inspection_scope[\s\S]*?= 'password_only'[\s\S]*?THEN m\.created_at/,
  'created-at current-video ordering is limited to password-only tasks',
)
assert.match(
  latestMediaRaw,
  /m\.captured_at DESC NULLS LAST, m\.created_at DESC/,
  'checkout, self-complete and ordinary inspection videos retain the origin/Dev captured-at ordering',
)

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

const completionAuditHelperStart = completionEvidenceSource.indexOf('export function cleaningCompletionAuditWhereSql')
assert.ok(completionAuditHelperStart >= 0)
const completionAuditHelper = completionEvidenceSource.slice(completionAuditHelperStart)
assert.match(completionAuditHelper, /performed_as_action = 'complete_cleaning'/)
assert.match(completionAuditHelper, /performed_as_action = 'fill_supplies'/)
assert.match(completionAuditHelper, /mzapp\.cleaning_tasks\.restock_proof/)
assert.match(completionAuditHelper, /completion_photos_saved/)
const inspectionAuditHelperStart = completionEvidenceSource.indexOf('export function inspectionSubmissionAuditWhereSql')
assert.ok(inspectionAuditHelperStart >= 0)
const inspectionAuditHelper = completionEvidenceSource.slice(inspectionAuditHelperStart, completionAuditHelperStart)
assert.match(inspectionAuditHelper, /performed_as_action = 'submit_inspection'/)
assert.match(inspectionAuditHelper, /LEGACY_RESTOCK_INSPECTION_AUDIT_ROUTE/)
assert.match(completionEvidenceSource, /LEGACY_RESTOCK_INSPECTION_AUDIT_ROUTE = 'mzapp\.cleaning_tasks\.restock_proof'/)
for (const status of [
  'cleaned',
  'restock_pending',
  'restocked',
  'to_inspect',
  'to_hang_keys',
  'keys_hung',
  'inspected',
  'ready',
  'completed',
  'done',
]) {
  assert.match(completionEvidenceSource, new RegExp(`'${status}'`), `missing completion status ${status}`)
}

console.log('work-tasks cleaning candidate scope contract passed')
