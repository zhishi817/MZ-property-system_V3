import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const backendRoot = path.resolve(__dirname, '../..')
const read = (relativePath: string) => fs.readFileSync(path.join(backendRoot, relativePath), 'utf8')

const users = read('src/modules/users.ts')
const cleaningApp = read('src/modules/cleaning_app.ts')
const mzapp = read('src/modules/mzapp.ts')
const startup = read('src/index.ts')
const readiness = read('src/lib/r5RequestSchema.ts')
const migration = read('scripts/migrations/20260902_r5_1_request_schema.sql')

const profileRoutes = users.slice(users.indexOf("router.get('/contacts'"), users.indexOf("router.post('/me/change-password'"))
assert.ok(profileRoutes.length > 0, 'profile routes must be present')
assert.doesNotMatch(profileRoutes, /\b(CREATE|ALTER|DROP)\s+(TABLE|INDEX|COLUMN)\b/i, 'profile requests must not execute DDL')
assert.doesNotMatch(profileRoutes, /information_schema|ensureProfileColumns/i, 'profile requests must not inspect the schema')
for (const route of ["router.get('/contacts', requireR5RequestSchema", "router.get('/me', requireR5RequestSchema", "router.get('/me/profile-documents/:documentType', requireR5RequestSchema", "router.patch('/me', requireR5RequestSchema"]) {
  assert.ok(users.includes(route), `${route} must fail closed until the migration marker is ready`)
}

assert.doesNotMatch(cleaningApp, /ensureCleaningTaskMediaNote|ensureCleaningDayEndMediaTable|ensureCleaningDayEndHandoverTable/, 'cleaning request helpers must not mutate schema')
assert.doesNotMatch(mzapp, /ensureCleaningTaskMediaTable|CREATE TABLE IF NOT EXISTS cleaning_task_media|ALTER TABLE cleaning_task_media|CREATE INDEX IF NOT EXISTS idx_cleaning_task_media/, 'MZapp cleaning-media requests and warmup must not mutate schema')
for (const route of [
  "router.get('/tasks/:id/inspection-photos', requireAnyPerm(['cleaning_app.inspect.finish', 'cleaning_app.tasks.finish']), requireR5RequestSchema",
  "router.post('/tasks/:id/inspection-photos', requireAnyPerm(['cleaning_app.inspect.finish', 'cleaning_app.tasks.finish']), requireR5RequestSchema",
  "router.post('/tasks/:id/inspection-issue-photos', requireAnyPerm(['cleaning_app.inspect.finish', 'cleaning_app.issues.report']), requireR5RequestSchema",
  "router.get('/tasks/:id/completion-photos', requirePerm('cleaning_app.tasks.finish'), requireR5RequestSchema",
  "router.post('/tasks/:id/completion-photos', requirePerm('cleaning_app.tasks.finish'), requireR5RequestSchema",
  "router.post('/tasks/:id/lockbox-video', requirePerm('cleaning_app.tasks.finish'), requireR5RequestSchema",
  "router.delete('/tasks/:id/lockbox-video', requirePerm('cleaning_app.tasks.finish'), requireR5RequestSchema",
  "router.post('/tasks/:id/lockbox-video/delete', requirePerm('cleaning_app.tasks.finish'), requireR5RequestSchema",
  "router.post('/tasks/:id/self-complete', requirePerm('cleaning_app.tasks.finish'), requireR5RequestSchema",
  "router.get('/tasks/:id/restock-proof', requireAnyPerm(['cleaning_app.inspect.finish', 'cleaning_app.tasks.finish']), requireR5RequestSchema",
  "router.post('/tasks/:id/restock-proof', requireAnyPerm(['cleaning_app.inspect.finish', 'cleaning_app.tasks.finish']), requireR5RequestSchema",
  "router.get('/day-end/backup-keys', requireAnyPerm(['cleaning_app.tasks.finish', 'cleaning_app.inspect.finish', 'cleaning_app.calendar.view.all']), requireR5RequestSchema",
  "router.get('/day-end/handover', requireAnyPerm(['cleaning_app.tasks.finish', 'cleaning_app.inspect.finish', 'cleaning_app.calendar.view.all']), requireR5RequestSchema",
  "router.post('/day-end/backup-keys', requireAnyPerm(['cleaning_app.tasks.finish', 'cleaning_app.inspect.finish']), requireR5RequestSchema",
  "router.post('/day-end/handover', requireAnyPerm(['cleaning_app.tasks.finish', 'cleaning_app.inspect.finish']), requireR5RequestSchema",
]) {
  assert.ok(cleaningApp.includes(route), `${route} must be protected by the migration readiness gate`)
}

const lockboxUpload = mzapp.slice(mzapp.indexOf("router.post('/cleaning-tasks/:id/lockbox-video'"), mzapp.indexOf('async function handleDeleteMzappLockboxVideo'))
const lockboxDelete = mzapp.slice(mzapp.indexOf('async function handleDeleteMzappLockboxVideo'), mzapp.indexOf("router.delete('/cleaning-tasks/:id/lockbox-video'"))
const restockProof = mzapp.slice(mzapp.indexOf("router.post('/cleaning-tasks/:id/restock-proof'"))
for (const [name, source, permissionCheck] of [
  ['lockbox upload', lockboxUpload, 'canManageMzappLockboxVideo'],
  ['lockbox delete', lockboxDelete, 'canManageMzappLockboxVideo'],
  ['restock proof', restockProof, 'canSubmitMzappInspection'],
] as const) {
  assert.ok(source.length > 0, `${name} route must be present`)
  assert.ok(source.includes('isR5RequestSchemaReady()'), `${name} must fail closed until the migration marker is ready`)
  assert.ok(source.indexOf(permissionCheck) < source.indexOf('isR5RequestSchemaReady()'), `${name} must check existing access rules before schema readiness`)
}

assert.match(readiness, /R5_REQUEST_SCHEMA_MIGRATION = '20260902_r5_1_request_schema'/)
assert.match(readiness, /SELECT 1 FROM schema_migrations WHERE version=\$1 LIMIT 1/)
assert.doesNotMatch(readiness, /information_schema|\b(CREATE|ALTER|DROP)\b/i, 'startup readiness must only read one migration marker')
assert.match(readiness, /status\(503\)\.json\(\{ code: 'r5_request_schema_not_ready' \}\)/)
assert.match(startup, /\{ name: 'r5_request_schema', run: warmupR5RequestSchema \}/)

for (const sql of [
  'CREATE TABLE IF NOT EXISTS schema_migrations',
  'ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name text',
  'ALTER TABLE users ADD COLUMN IF NOT EXISTS visa_grant_number text',
  'CREATE TABLE IF NOT EXISTS cleaning_day_end_media',
  'CREATE TABLE IF NOT EXISTS cleaning_day_end_handover',
  'CREATE TABLE IF NOT EXISTS cleaning_day_end_reject_items',
  'CREATE TABLE IF NOT EXISTS cleaning_task_media',
  'ALTER TABLE cleaning_task_media ADD COLUMN IF NOT EXISTS note text',
  'CREATE INDEX IF NOT EXISTS idx_cleaning_task_media_task ON cleaning_task_media(task_id)',
  'CREATE INDEX IF NOT EXISTS idx_cleaning_task_media_type ON cleaning_task_media(type)',
  'CREATE INDEX IF NOT EXISTS idx_cleaning_task_media_task_type',
  'CREATE INDEX IF NOT EXISTS idx_cleaning_task_media_task_type_captured_created',
  "INSERT INTO schema_migrations (version) VALUES ('20260902_r5_1_request_schema')",
]) {
  assert.ok(migration.includes(sql), `migration must contain: ${sql}`)
}
assert.ok(migration.indexOf("INSERT INTO schema_migrations (version) VALUES ('20260902_r5_1_request_schema')") > migration.indexOf('ALTER TABLE cleaning_task_media ADD COLUMN IF NOT EXISTS note text'), 'migration marker must be recorded only after all target DDL')

console.log('r5 request schema contract: PASS')
