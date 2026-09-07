import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const backendRoot = path.resolve(__dirname, '../..')
const read = (relativePath: string) => fs.readFileSync(path.join(backendRoot, relativePath), 'utf8')
const source = (relativePath: string) => read(`src/${relativePath}`)

const migration = read('scripts/migrations/20260902_r5_2a_core_task_schema.sql')
const readiness = source('lib/r5RequestSchema.ts')
const startup = source('index.ts')
const events = source('services/workTaskEvents.ts')
const actionAudit = source('lib/workTaskActionAudit.ts')
const streamRouter = source('modules/work_task_events.ts')
const keyUpload = source('lib/keyUploadSlaJob.ts')
const dayEnd = source('lib/dayEndHandoverReminderJob.ts')
const auth = source('auth.ts')
const workTasks = source('modules/work_tasks.ts')
const cleaningApp = source('modules/cleaning_app.ts')
const cleaning = source('modules/cleaning.ts')
const mzapp = source('modules/mzapp.ts')
const taskCenter = source('modules/task_center.ts')
const rbac = source('modules/rbac.ts')
const cleaningSync = source('services/cleaningSync.ts')
const syncWorker = source('worker_cleaning_sync.ts')
const backfillWorker = source('worker_cleaning_backfill.ts')

for (const sql of [
  'CREATE SEQUENCE IF NOT EXISTS work_task_events_sequence_no_seq AS bigint',
  "SET LOCAL lock_timeout = '5s'",
  'CREATE TABLE IF NOT EXISTS work_task_event_versions',
  'CREATE TABLE IF NOT EXISTS work_task_events',
  'CREATE TABLE IF NOT EXISTS work_task_action_audits',
  'CREATE INDEX IF NOT EXISTS idx_work_task_action_audits_source',
  'CREATE INDEX IF NOT EXISTS idx_work_task_action_audits_actor',
  'CREATE INDEX IF NOT EXISTS idx_work_task_action_audits_performer',
  'CREATE INDEX IF NOT EXISTS idx_work_task_events_sequence_no',
  'CREATE INDEX IF NOT EXISTS idx_work_task_events_task_id_version',
  'CREATE INDEX IF NOT EXISTS idx_work_task_events_occurred_at',
  "PERFORM setval('work_task_events_sequence_no_seq', event_max, true)",
  'ALTER TABLE work_tasks ADD COLUMN IF NOT EXISTS sort_index integer',
  "ALTER TABLE work_tasks ADD COLUMN IF NOT EXISTS photo_urls jsonb NOT NULL DEFAULT '[]'::jsonb",
  "ALTER TABLE work_tasks ADD COLUMN IF NOT EXISTS completion_photo_urls jsonb NOT NULL DEFAULT '[]'::jsonb",
  'ALTER TABLE work_tasks ADD COLUMN IF NOT EXISTS completion_note text',
  'ALTER TABLE work_tasks ADD COLUMN IF NOT EXISTS completion_reason text',
  'ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS sort_index_cleaner integer',
  'ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS sort_index_inspector integer',
  'ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS checked_out_at timestamptz',
  'ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS checkout_marked_by text',
  'ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS guest_special_request text',
  'ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS keys_required integer NOT NULL DEFAULT 1',
  'ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS inspection_mode text',
  'ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS inspection_scope text',
  'ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS inspection_due_date date',
  'ALTER TABLE orders ADD COLUMN IF NOT EXISTS keys_required integer NOT NULL DEFAULT 1',
  'CREATE TABLE IF NOT EXISTS work_task_participants',
  'CREATE UNIQUE INDEX IF NOT EXISTS uniq_work_task_participants_manual',
  'ALTER TABLE users ADD COLUMN IF NOT EXISTS delete_password_hash text',
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS color_hex text NOT NULL DEFAULT '#3B82F6'",
  "INSERT INTO schema_migrations (version) VALUES ('20260902_r5_2a_core_task_schema')",
]) assert.ok(migration.includes(sql), `migration must own: ${sql}`)

assert.match(migration, /work_task_events\.%_missing/, 'legacy partial event tables must fail the migration')
assert.match(migration, /work_task_participants\.%_missing/, 'legacy partial participant tables must fail the migration')
for (const verification of [
  'canonical contract mismatch',
  'work_task_events_sequence_no_seq_type_mismatch',
  'work_task_events_sequence_no_seq_owned_by_column',
  'work_task_events.sequence_no_default_present',
  'canonical index mismatch',
  'canonical constraint missing',
  'pg_get_indexdef',
  'format_type(attribute.atttypid, attribute.atttypmod)',
  'work_task_events.id_primary_key_missing',
  'work_task_events.event_id_unique_missing',
  'work_task_events.sequence_no_unique_missing',
  'work_task_event_versions.task_id_primary_key_missing',
  'work_task_event_versions.%_missing',
  'work_task_action_audits.%_missing',
  'work_task_action_audits.id_primary_key_missing',
  'work_task_action_audits_indexes_missing',
  'user_roles_indexes_missing',
  'roles_missing',
  'role_permissions_missing',
  'roles_index_missing',
  'role_permissions_index_missing',
  'mzapp_alerts_indexes_missing',
  'cleaning_day_end_handover_index_missing',
  'cleaning_task_media_task_type_index_missing',
  'cleaning_tasks.sort_index_cleaner_index_missing',
  'cleaning_tasks.r5_2a_task_list_columns_missing',
  'orders.keys_required_missing',
  'cleaning_sync_logs_missing',
  'cleaning_sync_logs.job_id_missing',
  'cleaning_tasks.cleaning_sync_dependencies_missing',
  'cleaning_tasks.unique_order_task_type_missing',
  'cleaning_tasks.cleaning_sync_indexes_missing',
]) assert.ok(migration.includes(verification), `existing canonical dependency must be verified: ${verification}`)
assert.ok(
  migration.indexOf("INSERT INTO schema_migrations (version) VALUES ('20260902_r5_2a_core_task_schema')")
    > migration.indexOf('cleaning_tasks.sort_index_cleaner_missing'),
  'marker must be recorded after all owned DDL and dependency validation',
)

assert.match(readiness, /R5_TASK_RUNTIME_SCHEMA_MIGRATION = '20260902_r5_2a_core_task_schema'/)
assert.match(readiness, /function warmupR5TaskRuntimeSchema\(\)/)
assert.match(readiness, /status\(503\)\.json\(\{ code: 'r5_task_runtime_schema_not_ready' \}\)/)
assert.match(readiness, /if \(!\(req as any\)\.user\) return next\(\)/, 'the task marker must preserve existing anonymous 401/permission handling')
assert.match(startup, /function areRequiredR5WarmupsReady\(\)/, 'readiness must depend on both R5 marker warmups')
assert.match(startup, /r5_schema_ready: areRequiredR5WarmupsReady\(\)/, 'readiness must expose the required R5 marker state')
assert.match(startup, /if \(!result\.r5_schema_ready\)[\s\S]{0,180}status\(503\)\.json\(result\)/, 'missing R5 marker must keep the instance out of readiness')
const taskWarmup = startup.indexOf("{ name: 'r5_task_runtime_schema', run: warmupR5TaskRuntimeSchema }")
assert.ok(taskWarmup >= 0, 'task schema marker must warm during process startup')
assert.ok(taskWarmup < startup.indexOf("{ name: 'auth', run: warmupAuthModule }"), 'task marker must be checked before auth warmup')
for (const worker of [syncWorker, backfillWorker]) {
  assert.match(worker, /await warmupR5TaskRuntimeSchema\(\)/, 'cleaning worker must check the task marker once before work')
}

for (const [name, value] of [
  ['task events', events],
  ['task action audit', actionAudit],
  ['Key Upload cron', keyUpload],
  ['day-end cron', dayEnd],
  ['auth role hydrate', auth],
  ['work-tasks routes', workTasks],
  ['RBAC roles and permissions', rbac],
  ['cleaning sync bootstrap and business paths', cleaningSync],
] as const) {
  assert.doesNotMatch(value, /\b(CREATE|ALTER|DROP)\s+(TABLE|SEQUENCE|INDEX|COLUMN)\b/i, `${name} must not execute R5-2A DDL`)
}

assert.doesNotMatch(events, /ensureWorkTaskEventSchema/, 'event writes must not call schema ensure')
assert.doesNotMatch(actionAudit, /ensureWorkTaskActionAuditsTable/, 'task action audit writes must not call schema ensure')
assert.match(events, /INSERT INTO work_task_event_versions/, 'event writes must preserve version-row initialization')
assert.match(events, /SELECT nextval\('work_task_events_sequence_no_seq'\)/, 'event writes must preserve explicit sequence allocation')
assert.match(events, /SELECT pg_notify\(/, 'event writes must notify only after inserting the event')
assert.match(streamRouter, /router\.get\('\/stream', requireR5TaskRuntimeSchema/, 'SSE stream must fail closed before marker readiness')
assert.match(streamRouter, /error instanceof R5TaskRuntimeSchemaNotReady[\s\S]{0,140}status\(503\)\.json\(\{ code: error\.code \}\)/, 'query-token SSE marker failures must remain stable 503 responses')
assert.match(taskCenter, /router\.post\('\/save-board', requirePerm\('cleaning\.task\.assign'\), requireR5TaskRuntimeSchema, async/, 'Task Center save-board must pass existing permission before the task marker so it cannot commit without its task events')
assert.match(taskCenter, /Promise\.allSettled\(eventInputs\.map\(\(eventInput\) => emitWorkTaskEvent\(eventInput\)\)\)/, 'Task Center marker preflight is required only because save-board emits task events after commit')
assert.match(keyUpload, /assertR5TaskRuntimeSchemaReady\(\)/, 'Key Upload cron must fail closed before marker readiness')
assert.match(dayEnd, /assertR5TaskRuntimeSchemaReady\(\)/, 'day-end cron must fail closed before marker readiness')
assert.match(cleaningApp, /router\.delete\('\/tasks\/:id\/lockbox-video', requirePerm\('cleaning_app\.tasks\.finish'\), requireR5RequestSchema, requireR5TaskRuntimeSchema, handleDeleteLockboxVideo\)/, 'cleaning-app lockbox delete must preserve auth before the task marker')
assert.match(cleaningApp, /router\.post\('\/tasks\/:id\/inspection-complete', requirePerm\('cleaning_app\.inspect\.finish'\), requireR5TaskRuntimeSchema, async/, 'cleaning-app inspection complete must preserve auth before the task marker')
for (const route of [
  "router.get('/tasks', requireAnyPerm(['cleaning.view', 'cleaning.schedule.manage', 'cleaning.task.assign']), requireR5TaskRuntimeSchema, async",
  "router.patch('/tasks/:id', requirePerm('cleaning.task.assign'), requireR5TaskRuntimeSchema, async",
  "router.post('/tasks', requireCleaningManualCreateAccess, requireR5TaskRuntimeSchema, async",
  "router.delete('/tasks/:id', requirePerm('cleaning.task.assign'), requireR5TaskRuntimeSchema, async",
  "router.post('/tasks/bulk-delete', requirePerm('cleaning.task.assign'), requireR5TaskRuntimeSchema, async",
  "router.post('/tasks/bulk-patch', requirePerm('cleaning.task.assign'), requireR5TaskRuntimeSchema, async",
  "router.post('/backfill', requirePerm('cleaning.schedule.manage'), requireR5TaskRuntimeSchema, async",
]) assert.ok(cleaning.includes(route), `${route} must fail closed after its existing authorization check`)
assert.match(cleaning, /router\.get\('\/calendar-range', requireAnyPerm\(\['cleaning\.view', 'cleaning\.schedule\.manage', 'cleaning\.task\.assign'\]\), async/, 'calendar-range remains outside R5-2A because it reaches deferred offline projection schema paths')
for (const retiredHelper of [
  'ensureCleaningTaskSortColumns',
  'ensureCleaningCheckoutColumns',
  'ensureCleaningCustomerColumns',
  'ensureCleaningInspectionColumns',
]) assert.doesNotMatch(mzapp, new RegExp(retiredHelper), `${retiredHelper} must not remain in MZapp runtime paths`)
assert.doesNotMatch(mzapp, /ALTER TABLE orders ADD COLUMN IF NOT EXISTS keys_required/i, 'MZapp must not add orders.keys_required at runtime')
assert.doesNotMatch(mzapp, /information_schema\.columns[\s\S]{0,500}sort_index_(?:cleaner|inspector)/i, 'MZapp task-list sorting must not inspect schema at runtime')
assert.match(mzapp, /router\.get\('\/work-tasks', requireR5TaskRuntimeSchema/, 'MZapp work-task list must fail closed before marker readiness')
for (const route of [
  "router.post('/cleaning-tasks/:id/lockbox-video'",
  "router.post('/cleaning-tasks/:id/inspection-photos'",
  "router.post('/cleaning-tasks/:id/restock-proof'",
]) {
  const routeStart = mzapp.indexOf(route)
  assert.ok(routeStart >= 0, `${route} must remain registered`)
  const nextRoute = mzapp.indexOf('\nrouter.', routeStart + route.length)
  const routeBody = mzapp.slice(routeStart, nextRoute < 0 ? undefined : nextRoute)
  assert.match(routeBody, /isR5TaskRuntimeSchemaReady\(\).*r5_task_runtime_schema_not_ready/s, `${route} must fail closed after its existing authorization check`)
}
const mzappLockboxDeleteStart = mzapp.indexOf('async function handleDeleteMzappLockboxVideo')
assert.ok(mzappLockboxDeleteStart >= 0, 'MZapp lockbox delete handler must remain registered')
const mzappLockboxDeleteBody = mzapp.slice(mzappLockboxDeleteStart, mzapp.indexOf("router.delete('/cleaning-tasks/:id/lockbox-video'", mzappLockboxDeleteStart))
assert.match(mzappLockboxDeleteBody, /isR5TaskRuntimeSchemaReady\(\).*r5_task_runtime_schema_not_ready/s, 'MZapp lockbox delete must fail closed after its existing authorization check')
for (const path of [
  '/cleaning-tasks/reorder',
  '/cleaning-tasks/:id/guest-checked-out',
  '/cleaning-tasks/guest-checked-out',
  '/cleaning-tasks/order-checked-out',
  '/cleaning-tasks/order-keys-required',
]) assert.match(mzapp, new RegExp(`router\\.post\\('${path.replace(/[/:]/g, '\\$&')}', requireR5TaskRuntimeSchema`), `${path} must fail closed before using migrated task fields`)
for (const method of ['patch', 'post']) assert.match(mzapp, new RegExp(`router\\.${method}\\('\\/cleaning-tasks\\/manager-fields', requireR5TaskRuntimeSchema`), `manager-fields ${method} must fail closed before using migrated task fields`)

for (const [name, value] of [
  ['selected MZapp task/participants/alerts', mzapp],
  ['cleaning-app participants', cleaningApp],
  ['RBAC users/roles', rbac],
] as const) {
  assert.doesNotMatch(value, /ensureWorkTasksTable|ensureWorkTaskParticipantsTable|ensureMzappAlertsTable|ensureUserRolesTable/, `${name} must not retain a retired R5-2A schema helper`)
}
assert.match(mzapp, /router\.get\('\/alerts', requireR5TaskRuntimeSchema/, 'alerts reads must fail closed before marker readiness')
assert.match(mzapp, /router\.post\('\/alerts\/:id\/read', requireR5TaskRuntimeSchema/, 'alerts writes must fail closed before marker readiness')
assert.match(workTasks, /router\.get\('\/day',[\s\S]*?requireR5TaskRuntimeSchema/, 'work-task reads must be guarded')
assert.match(rbac, /router\.get\('\/users', requirePerm\('rbac\.manage'\), requireR5TaskRuntimeSchema/, 'RBAC user reads must be guarded')
assert.match(rbac, /router\.patch\('\/roles\/:id', requirePerm\('rbac\.manage'\), requireR5TaskRuntimeSchema/, 'RBAC role rename must be guarded')
for (const [method, path] of [
  ['get', '/roles'],
  ['post', '/roles'],
  ['delete', '/roles/:id'],
  ['get', '/role-permissions'],
  ['post', '/role-permissions'],
  ['delete', '/role-permissions'],
  ['get', '/my-permissions'],
] as const) {
  assert.match(rbac, new RegExp(`router\\.${method}\\('${path.replace(/[/:]/g, '\\$&')}'[^\\n]*requireR5TaskRuntimeSchema`), `${method} ${path} must fail closed before using R5-2A RBAC tables`)
}
assert.doesNotMatch(rbac, /ensureRolesTable/, 'RBAC must not retain the retired roles schema helper')
assert.doesNotMatch(auth, /R5TaskRuntimeSchema/, 'global auth must stay independent of the R5-2A task marker so deferred protected routes are not newly blocked')
assert.doesNotMatch(cleaningSync, /assertR5TaskRuntimeSchemaReady\(\)/, 'shared cleaning sync compatibility shim must not broaden R5 failure handling into deferred modules')
assert.doesNotMatch(cleaningSync, /\b(?:information_schema|pg_catalog|to_regclass)\b/i, 'cleaning sync business paths must not inspect schema catalogs')

console.log('r5-2a core task schema contract: PASS')
