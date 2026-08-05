import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { IDEMPOTENCY_SUBMIT_ID_MAX_LENGTH } from '../../src/lib/idempotentStepReceipts'

async function main() {
  assert.equal(IDEMPOTENCY_SUBMIT_ID_MAX_LENGTH, 256)
  const sharedLimit = /submit_id: z\.string\(\)\.trim\(\)\.min\(1\)\.max\(IDEMPOTENCY_SUBMIT_ID_MAX_LENGTH\)/

  for (const moduleName of ['cleaning_app', 'mzapp']) {
    const source = fs.readFileSync(path.resolve(__dirname, `../../src/modules/${moduleName}.ts`), 'utf8')
    assert.match(source, /IDEMPOTENCY_SUBMIT_ID_MAX_LENGTH/, `${moduleName} must import the shared submit id limit`)
    assert.match(source, sharedLimit, `${moduleName} must use the shared submit id limit`)
    assert.doesNotMatch(source, /submit_id: z\.string\(\)\.trim\(\)\.min\(1\)\.max\(120\)/, `${moduleName} must not keep the old submit id limit`)
  }

  const cleaningAppSource = fs.readFileSync(path.resolve(__dirname, '../../src/modules/cleaning_app.ts'), 'utf8')
  const mzappSource = fs.readFileSync(path.resolve(__dirname, '../../src/modules/mzapp.ts'), 'utf8')
  const maintenanceSource = fs.readFileSync(path.resolve(__dirname, '../../src/modules/maintenance.ts'), 'utf8')
  const receiptSource = fs.readFileSync(path.resolve(__dirname, '../../src/lib/idempotentStepReceipts.ts'), 'utf8')
  const receiptMigration = fs.readFileSync(path.resolve(__dirname, '../../scripts/migrations/20260805_app_submit_receipts.sql'), 'utf8')
  const deepCleaningMigration = fs.readFileSync(path.resolve(__dirname, '../../scripts/migrations/20260805_property_deep_cleaning_foundation.sql'), 'utf8')
  const rootPackage = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8')) as { scripts?: Record<string, string> }
  assert.match(receiptSource, /assertIdempotentStepReceiptsReady/)
  assert.doesNotMatch(receiptSource, /\b(?:CREATE|ALTER)\s+(?:TABLE|INDEX)/i, 'receipt helper must not perform request-path DDL')
  assert.match(receiptMigration, /CREATE TABLE IF NOT EXISTS app_submit_receipts/)
  assert.match(receiptMigration, /CREATE UNIQUE INDEX IF NOT EXISTS uniq_app_submit_receipts_scope/)
  assert.match(maintenanceSource, /assertIdempotentStepReceiptsReady\(pgPool\)/)
  assert.match(mzappSource, /assertIdempotentStepReceiptsReady\(pool\)/)
  assert.equal(rootPackage.scripts?.['check:ci'], 'npm run check:fast', 'PR workflow check:ci entry must remain available')
  assert.match(String(rootPackage.scripts?.['check:fast'] || ''), /test:ledger-range-audit/, 'fast CI must include ledger range-audit regression coverage')
  const deepCleaningReadiness = mzappSource.match(/class PropertyDeepCleaningSchemaNotReady[\s\S]*?type FeedbackKind/)?.[0] || ''
  assert.ok(deepCleaningReadiness, 'deep-cleaning readiness helper must remain discoverable')
  assert.match(deepCleaningReadiness, /SELECT id, property_id, status[\s\S]*?client_item_id[\s\S]*?FROM property_deep_cleaning/)
  assert.doesNotMatch(deepCleaningReadiness, /\b(?:CREATE|ALTER)\s+(?:TABLE|INDEX)/i, 'deep-cleaning request readiness must not perform DDL')
  assert.match(deepCleaningMigration, /CREATE TABLE IF NOT EXISTS property_deep_cleaning/)
  assert.match(deepCleaningMigration, /client_item_id text/)
  assert.match(deepCleaningMigration, /CREATE UNIQUE INDEX IF NOT EXISTS uniq_property_deep_cleaning_client_item/)
  const requiredCompletionAreas = "['toilet', 'living', 'sofa', 'bedroom', 'kitchen', 'shower_drain', 'remote_tv', 'vacuum_used']"
  assert.match(cleaningAppSource, new RegExp(`const REQUIRED_COMPLETION_PHOTO_AREAS = ${requiredCompletionAreas.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), 'self-complete endpoint must require bathroom drain, TV remote, and vacuum photo areas')
  assert.match(mzappSource, new RegExp(`const REQUIRED_COMPLETION_PHOTO_AREAS = ${requiredCompletionAreas.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), 'work-task status must use the same self-complete photo areas')
  assert.match(cleaningAppSource, /const consumableSchema = z\.object\([\s\S]*?submit_id: z\.string\(\)\.trim\(\)\.min\(1\)\.max\(IDEMPOTENCY_SUBMIT_ID_MAX_LENGTH\)/, 'consumables must accept the shared submit id limit')
  assert.match(cleaningAppSource, /scopeType: 'cleaning_task_consumables'/, 'consumables must use a dedicated idempotency scope')
  assert.match(cleaningAppSource, /stepKey = 'consumables_submit'/, 'consumables must use a stable idempotency step key')
  assert.match(cleaningAppSource, /loadIdempotentStepReceipt\(client/, 'consumables must check an existing receipt inside the transaction')
  assert.match(cleaningAppSource, /saveIdempotentStepReceipt\(client/, 'consumables must save a receipt inside the transaction')
  assert.match(cleaningAppSource, /pgRunInTransaction\(async \(client\)/, 'consumables must use one database transaction')
  assert.match(cleaningAppSource, /FROM cleaning_tasks[\s\S]*FOR UPDATE/, 'consumables must lock the task row before replacing records')
  const consumablesRoute = cleaningAppSource.match(/router\.post\('\/tasks\/:id\/consumables'[\s\S]*?\/\/ Restock done/)?.[0] || ''
  assert.ok(consumablesRoute, 'consumables route must remain discoverable')
  assert.doesNotMatch(consumablesRoute, /CREATE TABLE|ALTER TABLE/, 'consumables request path must not perform schema checks')
  assert.match(cleaningAppSource, /export async function warmupCleaningAppModule/, 'consumables schema must have a startup warmup')
  assert.match(cleaningAppSource, /media_id[\s\S]*cleaning\/media\//, 'cleaning media upload must derive a stable R2 key from media_id')
  assert.match(cleaningAppSource, /const completionPhotosSchema[\s\S]*?submit_id: z\.string\(\)\.trim\(\)\.min\(1\)\.max\(IDEMPOTENCY_SUBMIT_ID_MAX_LENGTH\)/, 'completion photos must accept the shared submit id limit')
  assert.match(cleaningAppSource, /const completionPhotosSchema[\s\S]*?remote_tv[\s\S]*?remote_ac/, 'completion photos API must accept TV and optional AC remote areas')
  assert.match(cleaningAppSource, /scopeType: 'cleaning_task_completion_photos'/, 'completion photos must use a dedicated idempotency scope')
  assert.match(cleaningAppSource, /stepKey: 'completion_photos'|step_key: z\.string\(\)\.trim\(\)\.min\(1\)\.max\(120\)/, 'completion photos must expose a stable idempotency step')
  const completionRoute = cleaningAppSource.match(/router\.post\('\/tasks\/:id\/completion-photos'[\s\S]*?const lockboxVideoSchema/)?.[0] || ''
  assert.ok(completionRoute, 'completion photos route must remain discoverable')
  assert.match(completionRoute, /pgRunInTransaction\(async \(client\)/, 'completion photos must use one database transaction')
  assert.match(completionRoute, /FROM cleaning_tasks[\s\S]*FOR UPDATE/, 'completion photos must lock the task row before replacing records')
  assert.match(completionRoute, /loadIdempotentStepReceipt\(client/, 'completion photos must check an existing receipt inside the transaction')
  assert.match(completionRoute, /saveIdempotentStepReceipt\(client/, 'completion photos must save a receipt inside the transaction')
  assert.match(mzappSource, /async function canSubmitMzappSelfCompleteRestock/, 'self-complete restock must have a dedicated authorization boundary')
  assert.match(mzappSource, /stepKey === 'self_complete_restock'/, 'self-complete restock must use an explicit stable step key')
  assert.match(mzappSource, /SELECT 1 FROM cleaning_consumable_usages/, 'self-complete restock must still require consumables before saving proof')
  assert.match(mzappSource, /performedAsAction: selfCompleteRestock \? 'fill_supplies' : 'submit_inspection'/, 'self-complete restock must record the cleaner action instead of inspection')

  assert.match(mzappSource, /const feedbackProjectCreateSchema[\s\S]*?submit_id: z\.string\(\)\.trim\(\)\.min\(1\)\.max\(IDEMPOTENCY_SUBMIT_ID_MAX_LENGTH\)[\s\S]*?step_key:[\s\S]*?client_item_id:/, 'feedback project creation must accept the stable retry identifiers')
  assert.match(mzappSource, /const feedbackProjectCompleteSchema[\s\S]*?submit_id: z\.string\(\)\.trim\(\)\.min\(1\)\.max\(IDEMPOTENCY_SUBMIT_ID_MAX_LENGTH\)[\s\S]*?step_key:[\s\S]*?client_item_id:/, 'feedback project completion must accept the stable retry identifiers')
  const feedbackProjectCreateRoute = mzappSource.match(/router\.post\('\/property-feedbacks\/:kind\/:id\/projects'[\s\S]*?router\.patch\('\/property-feedbacks\/:kind\/:id\/projects\/:projectId'/)?.[0] || ''
  const feedbackProjectCompleteRoute = mzappSource.match(/router\.post\('\/property-feedbacks\/:kind\/:id\/projects\/:projectId\/complete'[\s\S]*?function urgencyRank/)?.[0] || ''
  assert.ok(feedbackProjectCreateRoute, 'feedback project create route must remain discoverable')
  assert.ok(feedbackProjectCompleteRoute, 'feedback project completion route must remain discoverable')
  for (const [name, route, scopeType] of [
    ['create', feedbackProjectCreateRoute, 'property_feedback_project_create'],
    ['complete', feedbackProjectCompleteRoute, 'property_feedback_project_complete'],
  ] as const) {
    assert.match(route, /pgRunInTransaction\(async \(client\)/, `feedback project ${name} must share the receipt and business write transaction`)
    assert.match(route, /loadPropertyFeedbackRow\(kind, id, client, true\)/, `feedback project ${name} must lock the parent feedback row before checking the receipt`)
    assert.match(route, new RegExp(`scopeType: '${scopeType}'`), `feedback project ${name} must use its own receipt scope`)
    assert.match(route, /loadIdempotentStepReceipt\(client, receiptScope\)/, `feedback project ${name} must return its saved receipt on retry`)
    assert.match(route, /saveIdempotentStepReceipt\(client, receiptScope, payloadHash, body\)/, `feedback project ${name} must save its response before commit`)
  }
  assert.match(mzappSource, /persistFeedbackProjects\([\s\S]*?transactionClient\?: any/, 'project persistence must accept the route transaction client')
  assert.match(mzappSource, /async function loadPropertyFeedbackByClientItemId/, 'feedback creation must have a durable stable-draft lookup')
  assert.match(mzappSource, /property_maintenance WHERE property_id = \$1 AND client_item_id = \$2/, 'maintenance feedback retries must use the stable-draft key')
  assert.match(mzappSource, /property_deep_cleaning WHERE property_id = \$1 AND client_item_id = \$2/, 'deep-cleaning feedback retries must use the stable-draft key')
  assert.match(mzappSource, /clientItemId: clientItemId \|\| null/, 'maintenance feedback creation must persist the stable-draft key')
  assert.match(mzappSource, /dedup_fingerprint, client_item_id/, 'deep-cleaning feedback creation must persist the stable-draft key')

  const selfCompleteLockboxRoute = cleaningAppSource.match(/router\.post\('\/tasks\/:id\/lockbox-video'[\s\S]*?async function handleDeleteLockboxVideo/)?.[0] || ''
  assert.ok(selfCompleteLockboxRoute, 'self-complete lockbox route must remain discoverable')
  assert.match(selfCompleteLockboxRoute, /canPerformCleaningTaskAction\(user, String\(id\), \['upload_access_video'\]\)/, 'self-complete lockbox must authorize the video action, not inspection submission')
  assert.match(selfCompleteLockboxRoute, /const selfCompleteLockbox = effectiveInspectionMode\(taskRow\) === 'self_complete'/, 'self-complete lockbox must identify its mode from the task')
  assert.match(selfCompleteLockboxRoute, /self_complete_lockbox: selfCompleteLockbox/, 'self-complete lockbox must mark the shared transition explicitly')
  assert.match(selfCompleteLockboxRoute, /pgRunInTransaction\(async \(client\)/, 'self-complete lockbox media and transition must share one transaction')

  const mzappLockboxRoute = mzappSource.match(/router\.post\('\/cleaning-tasks\/:id\/lockbox-video'[\s\S]*?async function handleDeleteMzappLockboxVideo/)?.[0] || ''
  assert.ok(mzappLockboxRoute, 'MZapp lockbox route must remain discoverable')
  assert.match(mzappLockboxRoute, /const selfCompleteLockbox = await canSubmitMzappSelfCompleteLockboxVideo\(user, row, userId\)/, 'MZapp must recognize self-complete lockbox uploads')
  assert.doesNotMatch(mzappLockboxRoute, /assertCleaningSubmissionReady|CLEANING_SUBMISSION_REQUIRED/, 'inspection lockbox evidence must not wait for cleaner evidence')
  assert.ok(
    mzappLockboxRoute.indexOf("VALUES ($1,$2,'lockbox_video'") < mzappLockboxRoute.indexOf('applyCleaningTaskActionTransition'),
    'MZapp must save the lockbox video before reconciling shared task finalization',
  )
  assert.match(mzappLockboxRoute, /self_complete_lockbox: selfCompleteLockbox/, 'MZapp must mark the shared transition explicitly')
  assert.match(mzappLockboxRoute, /pgRunInTransaction\(async \(client\)/, 'MZapp lockbox media and transition must share one transaction')

  process.stdout.write('test_idempotency_submit_id_contract: ok\n')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
