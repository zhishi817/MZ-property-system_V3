import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const backendRoot = path.resolve(__dirname, '../..')
const read = (relativePath: string) => fs.readFileSync(path.join(backendRoot, relativePath), 'utf8')

const foundation = read('src/lib/maintenanceWorkflowSchema.ts')
const migration = read('scripts/migrations/20260731_maintenance_workflow_foundation.sql')
const runtimeMigration = read('scripts/migrations/20260903_maintenance_runtime_schema.sql')
const runtimeSchema = read('src/lib/maintenanceRuntimeSchema.ts')
const mzapp = read('src/modules/mzapp.ts')
const maintenanceRouter = read('src/modules/maintenance.ts')
const taskCenter = read('src/modules/task_center.ts')
const publicRouter = read('src/modules/public.ts')
const workRecordPdf = read('src/lib/workRecordPdf.ts')
const pdfJobsWorker = read('src/services/pdfJobsWorker.ts')
const crud = read('src/modules/crud.ts')
const index = read('src/index.ts')

for (const status of ['pending_assignment', 'assigned', 'in_progress', 'pending_review', 'closed', 'cancelled']) {
  assert.match(foundation, new RegExp(`'${status}'`))
  assert.match(migration, new RegExp(`'${status}'`))
}

for (const source of ['cleaning_feedback', 'inspection_feedback', 'manager_feedback']) {
  assert.match(foundation, new RegExp(`'${source}'`))
}

for (const field of [
  'feedback_source',
  'source_task_id',
  'status',
  'assignee_id',
  'eta',
  'assigned_at',
  'submitted_at',
  'completion_photo_urls',
  'reviewed_at',
  'closed_at',
  'cancel_reason',
  'reopen_reason',
]) {
  assert.match(migration, new RegExp(`ADD COLUMN IF NOT EXISTS ${field}`))
}

assert.match(migration, /CREATE TABLE IF NOT EXISTS external_maintenance_orders/)
assert.match(migration, /CREATE TABLE IF NOT EXISTS maintenance_workflow_events/)
assert.match(migration, /maintenance_domain IN \('internal', 'external'\)/)
assert.match(foundation, /external: 'external_maintenance_orders'/)
assert.match(foundation, /internal: 'property_maintenance'/)
const legacyMaintenanceUpgrade = mzapp.slice(
  mzapp.indexOf('async function ensurePropertyMaintenanceColumns()'),
  mzapp.indexOf('type InternalMaintenanceFeedbackSource'),
)
assert.match(legacyMaintenanceUpgrade, /assertMaintenanceWorkflowSchemaReady\(pgPool\)/)
assert.match(legacyMaintenanceUpgrade, /assertMaintenanceRuntimeSchemaReady\(\)/, 'maintenance feedback paths must check the runtime migration marker before reading property_maintenance')
assert.doesNotMatch(legacyMaintenanceUpgrade, /\b(?:CREATE|ALTER)\s+(?:TABLE|INDEX)/i)
assert.match(foundation, /maintenance_workflow_schema_not_ready/)
assert.match(maintenanceRouter, /assertMaintenanceWorkflowSchemaReady\(pgPool\)/)
assert.doesNotMatch(maintenanceRouter, /ensureMaintenanceWorkflowFoundation|ensureMaintenanceWorkTasksTable/)
assert.match(runtimeSchema, /MAINTENANCE_RUNTIME_SCHEMA_MIGRATION = '20260903_maintenance_runtime_schema'/)
assert.match(runtimeSchema, /SELECT 1 FROM schema_migrations WHERE version=\$1 LIMIT 1/)
assert.doesNotMatch(runtimeSchema, /\b(?:CREATE|ALTER|DROP)\s+(?:TABLE|INDEX)/i)
assert.match(index, /maintenance_runtime_schema.*warmupMaintenanceRuntimeSchema/)
assert.match(runtimeMigration, /INSERT INTO schema_migrations \(version\) VALUES \('20260903_maintenance_runtime_schema'\)/)
assert.match(runtimeMigration, /ADD COLUMN IF NOT EXISTS completion_reason text/)
assert.match(runtimeMigration, /CREATE TABLE IF NOT EXISTS property_expenses/)
assert.match(runtimeMigration, /CREATE TABLE IF NOT EXISTS company_expenses/)
assert.match(runtimeMigration, /CREATE TABLE IF NOT EXISTS maintenance_share_links/)
assert.match(runtimeMigration, /CREATE INDEX IF NOT EXISTS idx_maintenance_share_mid/)
assert.match(runtimeMigration, /CREATE INDEX IF NOT EXISTS idx_maintenance_share_expires/)
for (const independentTable of ['public_access', 'pdf_jobs', 'task_center_board_rows', 'task_center_board_items']) {
  assert.doesNotMatch(
    runtimeMigration,
    new RegExp(`CREATE TABLE IF NOT EXISTS ${independentTable}`),
    `${independentTable} must retain its independent schema contract`,
  )
}
assert.ok(
  runtimeMigration.indexOf('CREATE TABLE IF NOT EXISTS maintenance_share_links')
    < runtimeMigration.indexOf("INSERT INTO schema_migrations (version) VALUES ('20260903_maintenance_runtime_schema')"),
  'share-link schema must be created before the maintenance marker is recorded',
)
for (const field of ['start_time', 'end_time', 'sort_index', 'photo_urls']) {
  assert.match(runtimeMigration, new RegExp(`ADD COLUMN IF NOT EXISTS ${field}`))
  assert.match(foundation, new RegExp(`\\b${field}\\b`))
}
for (const field of [
  'maintenance_amount',
  'has_parts',
  'parts_amount',
  'maintenance_amount_includes_parts',
  'has_gst',
  'maintenance_amount_includes_gst',
  'total_amount',
  'property_code',
  'category',
]) {
  assert.match(runtimeMigration, new RegExp(`ADD COLUMN IF NOT EXISTS ${field}`))
}
assert.match(runtimeMigration, /DO \$\$/)
assert.match(runtimeMigration, /photo_urls_text/)
assert.match(runtimeMigration, /CREATE INDEX IF NOT EXISTS idx_work_tasks_kind_day/)
assert.match(runtimeMigration, /CREATE INDEX IF NOT EXISTS idx_work_tasks_day/)
const workTaskReadiness = mzapp.slice(
  mzapp.indexOf('async function assertWorkTasksSchemaReady()'),
  mzapp.indexOf('let workTaskParticipantsEnsured'),
)
assert.match(workTaskReadiness, /assertMaintenanceWorkflowSchemaReady\(pgPool\)/)
assert.match(workTaskReadiness, /assertMaintenanceRuntimeSchemaReady\(\)/, 'MZapp work-task read and reorder paths must fail closed when the maintenance migration marker is absent')
assert.doesNotMatch(workTaskReadiness, /\b(?:CREATE|ALTER)\s+(?:TABLE|INDEX)/i)
const workTasksRoute = mzapp.slice(
  mzapp.indexOf("router.get('/work-tasks'"),
  mzapp.indexOf("const dailyNecessitiesStatusSchema"),
)
const workTaskReorderRoute = mzapp.slice(
  mzapp.indexOf("router.post('/work-tasks/reorder'"),
  mzapp.indexOf("router.post('/work-tasks/mixed-reorder'"),
)
assert.match(mzapp, /function sendMaintenanceRuntimeSchemaNotReady\(res: any, error: unknown\)[\s\S]*status\(503\)\.json\(\{ code: 'maintenance_runtime_schema_not_ready' \}\)/)
assert.match(workTasksRoute, /sendMaintenanceRuntimeSchemaNotReady\(res, e\)/, 'work-task reads must preserve the marker-not-ready 503 instead of converting it to 500')
assert.match(workTaskReorderRoute, /sendMaintenanceRuntimeSchemaNotReady\(res, e\)/, 'work-task reordering must preserve the marker-not-ready 503 instead of converting it to 500')
const workTaskRoutes = mzapp.slice(
  mzapp.indexOf("router.post('/work-tasks/:id/mark'"),
  mzapp.indexOf("router.get('/property-feedbacks'"),
)
assert.equal((workTaskRoutes.match(/sendMaintenanceRuntimeSchemaNotReady\(res, e\)/g) || []).length, 6, 'every work-task route that uses the marker assertion must preserve its controlled 503 response')
const propertyFeedbackReadRoute = mzapp.slice(
  mzapp.indexOf("router.get('/property-feedbacks'"),
  mzapp.indexOf("router.post('/property-feedbacks'"),
)
assert.match(propertyFeedbackReadRoute, /const scopedPropertyId[\s\S]*assertMaintenanceRuntimeSchemaReady\(\)[\s\S]*Promise\.all/, 'maintenance feedback reads must fail closed before issuing the property_maintenance query')
assert.match(propertyFeedbackReadRoute, /catch \(e: any\) \{\s*if \(sendMaintenanceRuntimeSchemaNotReady\(res, e\)\) return\s*return res\.status\(500\)/, 'maintenance feedback reads must preserve marker-not-ready as a controlled 503')
const mzappWarmup = mzapp.slice(
  mzapp.indexOf('export async function warmupMzappModule()'),
  mzapp.indexOf('let checkoutEnsured'),
)
assert.match(mzappWarmup, /await assertWorkTasksSchemaReady\(\)/)
assert.doesNotMatch(mzappWarmup, /ensureWorkTasksTable/)
assert.doesNotMatch(crud, /ensureAutoExpenseSchema/)
assert.match(crud, /assertMaintenanceRuntimeSchemaReady\(\)/)
assert.match(crud, /async function assertPropertyMaintenanceSchema\(\)/)
assert.match(crud, /async function assertWorkTasksSchema\(\)/)
assert.match(crud, /await assertPropertyMaintenanceSchema\(\)/)
assert.match(crud, /await assertWorkTasksSchema\(\)/)
assert.match(crud, /router\.get\('\/:resource'[\s\S]*?resource === 'property_maintenance' && !isMaintenanceRuntimeSchemaReady\(\)/)
assert.match(crud, /router\.get\('\/:resource\/:id'[\s\S]*?resource === 'property_maintenance' && !isMaintenanceRuntimeSchemaReady\(\)/)
assert.doesNotMatch(crud, /ensurePropertyMaintenanceSchema|ensureWorkTasksSchema/)
assert.doesNotMatch(crud, /CREATE TABLE IF NOT EXISTS property_maintenance|ALTER TABLE property_maintenance|DROP COLUMN photo_urls/)

const taskCenterReadiness = taskCenter.slice(
  taskCenter.indexOf('async function assertTaskCenterMaintenanceSchemaReady()'),
  taskCenter.indexOf('async function syncPropertyFollowupWorkTasks()'),
)
assert.match(taskCenterReadiness, /assertMaintenanceRuntimeSchemaReady\(\)/)
assert.match(taskCenterReadiness, /assertMaintenanceWorkflowSchemaReady\(pgPool\)/)
assert.doesNotMatch(taskCenterReadiness, /\b(?:CREATE|ALTER|DROP)\s+(?:TABLE|INDEX)/i)
assert.doesNotMatch(taskCenter, /ensureWorkTasksTable|ensureMaintenanceWorkflowFoundation/)
const taskCenterSync = taskCenter.slice(
  taskCenter.indexOf('async function syncPropertyFollowupWorkTasks()'),
  taskCenter.indexOf('async function hasCleaningOfflineTasksTable()'),
)
assert.match(taskCenterSync, /assertTaskCenterMaintenanceSchemaReady\(\)[\s\S]*DELETE FROM work_tasks/)
const taskCenterDay = taskCenter.slice(
  taskCenter.indexOf("router.get('/day'"),
  taskCenter.indexOf("router.post('/save-board'"),
)
assert.match(taskCenterDay, /syncPropertyFollowupWorkTasks\(\)/)
assert.match(taskCenterDay, /sendMaintenanceRuntimeSchemaNotReady\(res, e\)/)
const taskCenterSaveBoard = taskCenter.slice(
  taskCenter.indexOf("router.post('/save-board'"),
  taskCenter.indexOf("router.post('/layout'"),
)
assert.match(taskCenterSaveBoard, /assertTaskCenterMaintenanceSchemaReady\(\)[\s\S]*SELECT id::text AS id, source_type[\s\S]*ensureCleaningSchemaV2\(\)/)
assert.equal((taskCenterSaveBoard.match(/sendMaintenanceRuntimeSchemaNotReady\(res, e\)/g) || []).length, 2)

assert.match(runtimeSchema, /async function assertMaintenanceShareLinksSchemaReady/)
assert.match(runtimeSchema, /assertMaintenanceRuntimeSchemaReady\(\)[\s\S]*FROM maintenance_share_links[\s\S]*LIMIT 0/)
const maintenanceShareCreate = maintenanceRouter.slice(
  maintenanceRouter.indexOf("router.post('/share-link/:id'"),
  maintenanceRouter.indexOf("router.post('/pdf/:id'"),
)
assert.match(maintenanceShareCreate, /assertMaintenanceRouteSchemaReady\(\{ shareLinks: true \}\)[\s\S]*INSERT INTO maintenance_share_links/)
assert.match(maintenanceShareCreate, /sendMaintenanceRuntimeSchemaNotReady\(res, e\)/)
const maintenancePdfRoutes = maintenanceRouter.slice(
  maintenanceRouter.indexOf("router.post('/pdf/:id'"),
  maintenanceRouter.indexOf("router.get('/pdf-jobs/:id'"),
)
assert.equal((maintenancePdfRoutes.match(/await assertMaintenanceRouteSchemaReady\(\)/g) || []).length, 2)
assert.equal((maintenancePdfRoutes.match(/sendMaintenanceRuntimeSchemaNotReady\(res, e\)/g) || []).length, 2)
assert.doesNotMatch(maintenanceRouter, /ensurePropertyMaintenanceTable|ensureMaintenanceShareTables/)
const maintenancePdfReadiness = workRecordPdf.slice(
  workRecordPdf.indexOf('export async function assertWorkRecordPdfSchemaReady'),
  workRecordPdf.indexOf('function dayStrAtTZ'),
)
assert.match(maintenancePdfReadiness, /assertMaintenanceRuntimeSchemaReady\(\)/)
assert.match(maintenancePdfReadiness, /FROM property_maintenance[\s\S]*LIMIT 0/)
assert.doesNotMatch(maintenancePdfReadiness, /\b(?:CREATE|ALTER|DROP)\s+(?:TABLE|INDEX)/i)
assert.doesNotMatch(workRecordPdf, /ensurePropertyMaintenanceTable/)
const maintenancePdfWorker = pdfJobsWorker.slice(
  pdfJobsWorker.indexOf('async function runWorkRecordPdfJob'),
  pdfJobsWorker.indexOf('async function runStatementPhotoPackJob'),
)
assert.match(maintenancePdfWorker, /assertWorkRecordPdfSchemaReady\(kind\)[\s\S]*updateJob\(id, \{ progress: 8/)
const pdfWorkerDispatch = pdfJobsWorker.slice(
  pdfJobsWorker.indexOf('export async function processPdfJobsOnce'),
  pdfJobsWorker.indexOf('export async function processPdfJobsDrain'),
)
assert.match(pdfWorkerDispatch, /assertWorkRecordPdfSchemaReady\('maintenance'\)[\s\S]*reclaimExpiredLeases\(maintenanceRecordPdfReady\)[\s\S]*claimJobs\([^\n]+maintenanceRecordPdfReady\)/)
assert.match(pdfJobsWorker, /\$1::boolean OR kind <> 'maintenance_record_pdf'/)
assert.match(pdfJobsWorker, /\$4::boolean OR kind <> 'maintenance_record_pdf'/)

const maintenanceAccess = publicRouter.slice(
  publicRouter.indexOf('async function getOrInitMaintenanceShareAccess()'),
  publicRouter.indexOf('async function getOrInitDeepCleaningShareAccess()'),
)
assert.match(maintenanceAccess, /assertPublicAccessTableReady\(\)/)
assert.doesNotMatch(maintenanceAccess, /ensurePublicAccessTable\(\)/)
const publicAccessReadiness = publicRouter.slice(
  publicRouter.indexOf('async function assertPublicAccessTableReady()'),
  publicRouter.indexOf('async function assertMaintenanceShareRouteSchemaReady()'),
)
assert.match(publicAccessReadiness, /FROM public_access[\s\S]*LIMIT 0/)
assert.doesNotMatch(publicAccessReadiness, /\b(?:CREATE|ALTER|DROP)\s+(?:TABLE|INDEX)/i)
assert.doesNotMatch(publicRouter, /ensureMaintenanceShareLinksTable/)
const publicMaintenanceShareRoutes = publicRouter.slice(
  publicRouter.indexOf("router.get('/maintenance-share/:token'"),
  publicRouter.indexOf("router.get('/deep-cleaning-share/:token'"),
)
for (const routeStart of [
  "router.get('/maintenance-share/:token'",
  "router.post('/maintenance-share/login'",
  "router.post('/maintenance-share/upload'",
  "router.patch('/maintenance-share/:token'",
]) {
  const start = publicMaintenanceShareRoutes.indexOf(routeStart)
  assert.ok(start >= 0, `${routeStart} must remain registered`)
  const nextRoute = publicMaintenanceShareRoutes.indexOf('\nrouter.', start + routeStart.length)
  const routeSource = publicMaintenanceShareRoutes.slice(start, nextRoute >= 0 ? nextRoute : undefined)
  assert.match(routeSource, /assertMaintenanceShareRouteSchemaReady\(\)/)
  assert.match(routeSource, /sendMaintenanceRuntimeSchemaNotReady\(res, e\)/)
}
assert.doesNotMatch(publicMaintenanceShareRoutes, /ensurePropertyMaintenanceShareColumns|ensureMaintenanceShareLinksTable/)

const feedbackProjectPersistence = mzapp.slice(
  mzapp.indexOf('async function persistFeedbackProjects'),
  mzapp.indexOf("router.post('/property-feedbacks/:kind/:id/projects'"),
)
const maintenanceProjectPersistence = feedbackProjectPersistence.slice(
  feedbackProjectPersistence.indexOf("if (kind === 'maintenance') {"),
  feedbackProjectPersistence.indexOf('  } else {'),
)
assert.match(maintenanceProjectPersistence, /details = COALESCE\(NULLIF\(\$3, ''\), details\)/)
assert.match(maintenanceProjectPersistence, /const beforeExpr = beforeType === 'text\[\]' \? '\$4::text\[\]' : '\$4::jsonb'/)
assert.match(maintenanceProjectPersistence, /const afterExpr = afterType === 'text\[\]' \? '\$5::text\[\]' : '\$5::jsonb'/)
assert.doesNotMatch(maintenanceProjectPersistence, /\bnotes\s*=/)

const externalTable = migration.slice(migration.indexOf('CREATE TABLE IF NOT EXISTS external_maintenance_orders'), migration.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS uniq_external_maintenance_orders_order_no'))
assert.doesNotMatch(externalTable, /REFERENCES\s+properties/i)

console.log('maintenance workflow schema contract: PASS')
