import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const backendRoot = path.resolve(__dirname, '../..')
const read = (relativePath: string) => fs.readFileSync(path.join(backendRoot, relativePath), 'utf8')

const migration = read('scripts/migrations/20260910_r5_2b_property_guides_schema.sql')
const readiness = read('src/lib/propertyGuideRuntimeSchema.ts')
const startup = read('src/index.ts')
const guides = read('src/modules/property_guides.ts')
const linkSync = read('src/modules/property_guide_link_sync.ts')
const publicRouter = read('src/modules/public.ts')
const maintenanceFoundation = read('src/lib/maintenanceWorkflowSchema.ts')
const maintenanceStore = read('src/lib/maintenanceWorkflowStore.ts')

for (const sql of [
  "SET LOCAL lock_timeout = '5s'",
  'CREATE TABLE IF NOT EXISTS property_guides',
  'ALTER TABLE property_guides ALTER COLUMN property_id DROP NOT NULL',
  'ALTER TABLE property_guides ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1',
  'ALTER TABLE property_guides ADD COLUMN IF NOT EXISTS copied_by text',
  'CREATE UNIQUE INDEX IF NOT EXISTS uq_property_guides_property_id',
  'CREATE TABLE IF NOT EXISTS property_guide_revisions',
  'CREATE TABLE IF NOT EXISTS property_guide_public_links',
  'ALTER TABLE property_guide_public_links ADD COLUMN IF NOT EXISTS token_enc text',
  'ALTER TABLE property_guide_public_links ALTER COLUMN expires_at DROP NOT NULL',
  'CREATE TABLE IF NOT EXISTS property_guide_public_sessions',
  'CREATE TABLE IF NOT EXISTS property_guide_link_sync_logs',
  "INSERT INTO schema_migrations (version) VALUES ('20260910_r5_2b_property_guides_schema')",
]) assert.ok(migration.includes(sql), `migration must own: ${sql}`)

assert.match(migration, /UPDATE property_guides g[\s\S]*base_version[\s\S]*building_key/, 'migration must retain the legacy one-time guide metadata backfill')
assert.match(migration, /WITH ranked AS[\s\S]*SET property_id = NULL,[\s\S]*status = 'archived'/, 'migration must retain deterministic duplicate reconciliation')
assert.match(migration, /token_enc text/, 'historical opaque link tokens must remain structurally supported')
assert.doesNotMatch(migration, /token_enc\s+text\s+NOT\s+NULL/i, 'historical token_enc gaps must preserve existing fallback behaviour')
assert.ok(
  migration.indexOf("INSERT INTO schema_migrations (version) VALUES ('20260910_r5_2b_property_guides_schema')")
    > migration.indexOf('r5_2b_property_guides_indexes_missing'),
  'marker must be written only after the canonical schema and postconditions are complete',
)

assert.match(readiness, /PROPERTY_GUIDE_RUNTIME_SCHEMA_MIGRATION = '20260910_r5_2b_property_guides_schema'/)
assert.match(readiness, /SELECT 1 FROM schema_migrations WHERE version=\$1 LIMIT 1/)
assert.doesNotMatch(readiness, /information_schema|\b(CREATE|ALTER|DROP)\s+(TABLE|SEQUENCE|INDEX|COLUMN)\b/i, 'guide readiness must only read the fixed marker at startup')
assert.match(startup, /\{ name: 'property_guide_runtime_schema', run: warmupPropertyGuideRuntimeSchema \}/)

for (const [name, source] of [
  ['admin guide routes', guides],
  ['guide link synchronisation', linkSync],
  ['retired maintenance foundation helper', maintenanceFoundation],
  ['retired maintenance work-task helper', maintenanceStore],
] as const) {
  assert.doesNotMatch(source, /\b(CREATE|ALTER|DROP)\s+(TABLE|SEQUENCE|INDEX|COLUMN)\b/i, `${name} must not retain runtime DDL`)
}
assert.doesNotMatch(guides, /ensurePropertyGuide/, 'admin guide paths must not retain request-time schema helpers')
assert.match(guides, /assertPropertyGuideRuntimeSchemaReady\(\)/, 'admin guide paths must fail closed after existing permission middleware')
assert.match(guides, /sendPropertyGuideRuntimeSchemaNotReady\(res, e\)/, 'admin guide marker failure must remain a controlled 503')
assert.doesNotMatch(linkSync, /ensureSyncLogsTable/, 'link sync must not create a logs table during sync')
assert.match(linkSync, /!isPropertyGuideRuntimeSchemaReady\(\)\) return out/, 'task-list guide resolution must retain the stored-link fallback while the marker is unavailable')
assert.match(linkSync, /assertPropertyGuideRuntimeSchemaReady\(\)/, 'write and admin sync paths must fail closed without the marker')
assert.match(linkSync, /sendPropertyGuideRuntimeSchemaNotReady\(res, e\)/, 'sync API marker failure must remain a controlled 503')

const publicGuideRoutes = publicRouter.slice(publicRouter.indexOf("router.get('/guide/p/:token/status'"), publicRouter.indexOf('export default router'))
assert.ok(publicGuideRoutes.length > 0, 'public guide routes must remain registered')
assert.doesNotMatch(publicGuideRoutes, /ensurePropertyGuide/, 'public guide paths must not mutate schema')
assert.match(publicGuideRoutes, /assertPropertyGuideRuntimeSchemaReady\(\)/, 'public guide paths must fail closed before guide-table access')
assert.match(publicGuideRoutes, /sendPropertyGuideRuntimeSchemaNotReady\(res, e\)/, 'public guide marker failure must remain a controlled 503')
const publicGuideAccess = publicRouter.slice(publicRouter.indexOf('async function getOrInitPropertyGuideAccess'), publicRouter.indexOf('function sha256Hex'))
assert.match(publicGuideAccess, /assertPublicAccessTableReady\(\)/, 'guide password access must use the existing public-access contract')
assert.doesNotMatch(publicGuideAccess, /ensurePublicAccessTable\(\)/, 'guide password access must not reintroduce public-access DDL')

for (const retiredHelper of [
  'ensureMaintenanceWorkflowFoundation',
  'ensureMaintenanceWorkTasksTable',
  'ensureMaintenanceProgressSubmitSchema',
  'ensurePropertyMaintenanceShareColumns',
]) {
  assert.doesNotMatch(`${maintenanceFoundation}\n${maintenanceStore}\n${publicRouter}`, new RegExp(retiredHelper), `${retiredHelper} must be removed from runtime source`)
}

console.log('r5-2b property guide schema contract: PASS')
