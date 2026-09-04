import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { maintenanceAutoExpenseOccurredAt, maintenanceAutoExpenseStatus } from '../../src/lib/maintenanceAutoExpense'

assert.equal(maintenanceAutoExpenseStatus({ status: 'pending_review', review_status: null }), 'void')
assert.equal(maintenanceAutoExpenseStatus({ status: 'completed', review_status: null }), 'void')
assert.equal(maintenanceAutoExpenseStatus({ status: 'closed', review_status: null }), 'void')
assert.equal(maintenanceAutoExpenseStatus({ status: 'closed', review_status: 'approved' }), 'completed')
assert.equal(maintenanceAutoExpenseStatus({ status: 'completed', review_status: 'approved' }), 'completed')
assert.equal(maintenanceAutoExpenseStatus({ status: 'cancelled', review_status: 'approved' }), 'void')
assert.equal(maintenanceAutoExpenseStatus({ status: 'reopened', review_status: 'approved' }), 'void')

assert.equal(
  maintenanceAutoExpenseOccurredAt({
    completed_at: '2026-09-02T10:30:00+10:00',
    occurred_at: '2026-08-31',
    created_at: '2026-08-31T08:00:00+10:00',
  }),
  '2026-09-02',
)
assert.equal(maintenanceAutoExpenseOccurredAt({ occurred_at: '2026-08-31' }), '2026-08-31')
assert.equal(maintenanceAutoExpenseOccurredAt({ created_at: '2026-08-31T08:00:00+10:00' }), '2026-08-31')

const backendRoot = path.resolve(__dirname, '../..')
const read = (relativePath: string) => fs.readFileSync(path.join(backendRoot, relativePath), 'utf8')
const maintenance = read('src/modules/maintenance.ts')
const crud = read('src/modules/crud.ts')
const finance = read('src/modules/finance.ts')
const reconcile = read('src/lib/monthlyStatementExpenseReconcile.ts')
const runtimeSchema = read('src/lib/maintenanceRuntimeSchema.ts')
const runtimeMigration = read('scripts/migrations/20260903_maintenance_runtime_schema.sql')

assert.match(maintenance, /action === 'submit'[\s\S]*completed_at: new Date\(\)\.toISOString\(\)/)
assert.match(maintenance, /action === 'executor_complete'[\s\S]*completed_at: new Date\(\)\.toISOString\(\)/)
assert.match(maintenance, /action === 'review_approved'[\s\S]*syncInternalMaintenanceAutoExpenseWithClient\(client, updated\)/)
assert.match(maintenance, /completionCorrection\?\.accountingDateChanged === true[\s\S]*syncInternalMaintenanceAutoExpenseWithClient\(client, updated\)/)
assert.match(maintenance, /action === 'correct_completion'[\s\S]*maintenance_auto_expense_manual_override/)
assert.match(maintenance, /maintenance_auto_expense_\$\{autoExpenseSync\.error\}/)
assert.match(crud, /kind === 'maintenance' \? maintenanceAutoExpenseStatus\(row\) : normStatus\(row\?\.status\)/)
assert.match(crud, /assertMaintenanceRuntimeSchemaReady\(\)/)
assert.doesNotMatch(crud, /ensureAutoExpenseSchema/)
assert.match(runtimeSchema, /maintenance_runtime_schema_not_ready/)
assert.match(runtimeMigration, /CREATE TABLE IF NOT EXISTS property_expenses/)
assert.match(runtimeMigration, /INSERT INTO schema_migrations \(version\) VALUES \('20260903_maintenance_runtime_schema'\)/)
assert.match(finance, /kind === 'maintenance' \? maintenanceAutoExpenseStatus\(row\) : autoNormStatus\(row\?\.status\)/)
assert.match(reconcile, /kind === 'maintenance' \? maintenanceAutoExpenseStatus\(row\) : autoNormStatus\(row\?\.status\)/)

console.log('test_maintenance_auto_expense: ok')
