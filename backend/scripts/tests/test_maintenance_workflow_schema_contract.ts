import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const backendRoot = path.resolve(__dirname, '../..')
const read = (relativePath: string) => fs.readFileSync(path.join(backendRoot, relativePath), 'utf8')

const foundation = read('src/lib/maintenanceWorkflowSchema.ts')
const migration = read('scripts/migrations/20260731_maintenance_workflow_foundation.sql')
const mzapp = read('src/modules/mzapp.ts')
const maintenanceRouter = read('src/modules/maintenance.ts')

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
assert.doesNotMatch(legacyMaintenanceUpgrade, /\b(?:CREATE|ALTER)\s+(?:TABLE|INDEX)/i)
assert.match(foundation, /maintenance_workflow_schema_not_ready/)
assert.match(maintenanceRouter, /assertMaintenanceWorkflowSchemaReady\(pgPool\)/)
assert.doesNotMatch(maintenanceRouter, /ensureMaintenanceWorkflowFoundation|ensureMaintenanceWorkTasksTable/)

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
