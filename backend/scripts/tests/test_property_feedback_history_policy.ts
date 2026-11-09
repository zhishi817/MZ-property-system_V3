import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
process.env.DATABASE_URL = ''
async function main() {
  const { propertyFeedbackMutationLocked, enrichPropertyFeedbackLocks, lockPropertyFeedbackMutationSource, lockPropertyFeedbackExpenseReferences, assertPropertyFeedbackExpenseReferenceUnchanged } = await import('../../src/lib/propertyFeedbackPolicy')
  const { propertyFeedbackCapabilities: capabilities, propertyFeedbackResponseFromRow: response, propertyFeedbackHistoryStatusWhereSql: statusSql } = await import('../../src/modules/mzapp')
  const creator = { sub: 'creator', role: 'cleaner' }
  const pending = { id: 'report', property_id: 'property-a', created_by_user_id: 'creator', status: 'pending', source_task_id: null }
  for (const kind of ['maintenance', 'deep_cleaning', 'daily_necessities'] as const) {
    assert.equal(capabilities(creator, kind, pending).can_edit_content, true)
    assert.equal(capabilities(creator, kind, pending).can_delete, true)
    assert.equal(capabilities({ sub: 'other', role: 'cleaner' }, kind, pending).can_delete, false)
    assert.equal(capabilities(creator, kind, { ...pending, created_by_user_id: null, submitter_name: 'creator' }).can_edit_content, false)
    for (const patch of [
      { status: 'assigned' }, { status: 'in_progress' }, { status: 'pending_review' }, { status: 'completed' }, { status: 'resolved' }, { status: 'closed' }, { status: 'replaced' }, { status: 'cancelled' },
      { assigned_at: '2026-01-01', assignee_id: null }, { completed_at: '2026-01-01' }, { assignee_id: 'worker' },
      { feedback_has_history: true }, { feedback_has_assignment: true }, { feedback_has_expense: true, total_amount: 0 },
      { labor_cost: 12 }, { maintenance_amount: 10 }, { consumables: [{ cost: 2 }] },
      { project_items: JSON.stringify([{ status: 'completed' }]) }, { project_items: [{ amount: 10 }] },
    ]) {
      const row = { ...pending, ...patch }
      assert.equal(propertyFeedbackMutationLocked(row), true, JSON.stringify(patch))
      assert.equal(capabilities(creator, kind, row).can_edit_content, false)
      for (const role of ['cleaner', 'admin', 'customer_service', 'offline_manager']) {
        assert.equal(capabilities({ sub: role === 'cleaner' ? 'creator' : 'manager', role }, kind, row).can_delete, false)
      }
    }
    assert.equal(capabilities({ sub: 'manager', role: 'customer_service' }, kind, pending).can_edit_content, false)
    assert.equal(capabilities({ sub: 'manager', role: 'customer_service' }, kind, pending).can_delete, true)
    assert.equal(capabilities({ sub: 'manager', role: 'offline_manager' }, kind, { ...pending, feedback_has_expense: true }).can_edit_content, true)
    const dto = response(kind, { ...pending, total_amount: 999, invoice_description_en: 'financial secret', invoice_url: 'invoice.jpg', attachment_urls: kind === 'maintenance' ? ['private-invoice.jpg'] : [], project_items: [{ name: 'problem', detail: 'broken tap', amount: 99, invoice_url: 'nested-invoice.jpg', before_photos: ['report.jpg'] }] }, creator, { propertyHistory: true })
    assert(!JSON.stringify(dto).includes('financial secret'))
    assert(!JSON.stringify(dto).includes('invoice.jpg'))
    assert(!JSON.stringify(dto).includes('amount'))
  }
  assert.equal(response('maintenance', { ...pending, status: 'pending_review' }, creator, { propertyHistory: true })?.status, 'pending_review')
  assert.equal(response('maintenance', { ...pending, status: 'closed' }, creator, { propertyHistory: true })?.status, 'resolved')
  assert.equal(statusSql('m', ['need_replace']), 'false')
  assert(!statusSql('m', ['open', 'in_progress']).includes("'closed'"))
  assert(!statusSql('m', ['resolved']).includes("'pending_review'"))
  assert(statusSql('m', ['pending_review']).includes("'pending_review'"))
  const queries: any[] = []
  const mock = { query: async (sql: string, params: any[]) => { queries.push({ sql, params }); return { rows: [{ feedback_has_expense: true }] } } }
  const enriched = await enrichPropertyFeedbackLocks(mock, 'daily_necessities', pending)
  assert.equal(propertyFeedbackMutationLocked(enriched), true)
  assert.deepEqual(queries[0].params, ['property_daily_necessities', 'report', 'daily_necessities'])
  for (const evidence of ['property_expenses', 'company_expenses', 'generated_from', 'ref_id', 'maintenance_workflow_events', 'audit_logs', 'before_json', 'after_json']) assert(queries[0].sql.includes(evidence))
  assert(!queries[0].sql.includes('amount >'), 'expense existence, including zero/void/manual rows, locks mutation')
  assert(!queries[0].sql.match(/(?:INSERT|UPDATE|DELETE|ALTER|CREATE)\s/i))
  await assert.rejects(() => enrichPropertyFeedbackLocks({ query: async () => ({ rows: [] }) }, 'maintenance', pending))
  const root = path.resolve(__dirname, '../..')
  const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8')
  const policy = read('src/lib/propertyFeedbackPolicy.ts')
  const store = read('src/store.ts')
  for (const column of ['before_json jsonb', 'after_json jsonb', 'entity_id text']) assert(store.includes(column))
  const workflow = read('src/lib/maintenanceWorkflowStore.ts')
  for (const column of ['maintenance_domain', 'record_id', 'event_type', 'to_status']) assert(workflow.includes(column) && policy.includes(column))
  const crud = read('src/modules/crud.ts')
  assert.match(crud, /resource === 'property_maintenance'\) \{\s*return res.status\(409\).json\(\{ code: 'maintenance_cancel_required'/)
  assert.match(crud, /SELECT \* FROM \$\{resource\} WHERE id = \$1 FOR UPDATE[\s\S]*enrichPropertyFeedbackLocks[\s\S]*propertyFeedbackMutationLocked\(row\)[\s\S]*pgDelete\(resource, id, client\)/)
  const lockCalls: string[] = []
  const lockClient = { query: async (sql: string, params: any[]) => {
    lockCalls.push(sql)
    if (sql.startsWith('SELECT *')) return { rows: [pending] }
    if (sql.startsWith('SELECT EXISTS')) return { rows: [{ feedback_has_expense: true, feedback_has_history: false }] }
    if (sql.startsWith('INSERT INTO audit_logs')) { assert.equal(params[4], JSON.stringify({ feedback_history_locked: true })); return { rows: [] } }
    throw new Error('Unexpected query')
  } }
  assert.equal(await lockPropertyFeedbackMutationSource(lockClient, 'property_maintenance', 'report', 'manager'), true)
  assert.match(lockCalls[0], /deleted_at IS NULL FOR UPDATE/)
  assert(lockCalls[2].startsWith('INSERT INTO audit_logs'), 'permanent lock evidence is persisted before clearing current fields')
  assert.equal(await lockPropertyFeedbackMutationSource({ query: async () => ({ rows: [] }) }, 'property_maintenance', 'deleted', ''), false)
  assert.equal(await lockPropertyFeedbackMutationSource({ query: async () => { throw new Error('unrelated source queried') } }, 'guest_luggage', 'id', ''), true)
  await assert.rejects(() => lockPropertyFeedbackExpenseReferences({ query: async () => ({ rows: [] }) }, [{ ref_type: 'maintenance', ref_id: 'deleted' }]), /property_feedback_not_found/)
  await lockPropertyFeedbackExpenseReferences({ query: async () => ({ rows: [] }) }, [{ ref_type: 'maintenance', ref_id: 'old-orphan' }], [{ ref_type: 'maintenance', ref_id: 'old-orphan' }])
  await assert.rejects(() => assertPropertyFeedbackExpenseReferenceUnchanged({ query: async () => ({ rows: [{ ref_type: 'maintenance', ref_id: 'B' }] }) }, 'property_expenses', 'expense', { ref_type: 'maintenance', ref_id: 'A' }), /feedback_expense_reference_conflict/)
  const workTasks = read('src/modules/work_tasks.ts')
  assert.equal((workTasks.match(/await lockPropertyFeedbackMutationSource\(client, sourceType, sourceId/g) || []).length, 3)
  assert.match(workTasks, /await client.query\('BEGIN'\)[\s\S]*?lockPropertyFeedbackMutationSource[\s\S]*?SELECT \* FROM work_tasks WHERE source_type=\$1 AND source_id=\$2 LIMIT 1 FOR UPDATE/)
  const inventory = read('src/modules/inventory.ts')
  const inventoryPatch = inventory.slice(inventory.indexOf("router.patch('/daily-replacements/:id'"), inventory.indexOf("router.delete('/daily-replacements/:id'"))
  assert.match(inventoryPatch, /pgRunInTransaction[\s\S]*lockPropertyFeedbackMutationSource[\s\S]*UPDATE property_daily_necessities[\s\S]*deleted_at IS NULL[\s\S]*syncDailyNecessityAutoExpenseWithClient\(client, updatedRow\)/)
  const inventoryDelete = inventory.slice(inventory.indexOf("router.delete('/daily-replacements/:id'"), inventory.indexOf("router.get('/suppliers'"))
  assert.match(inventoryDelete, /FOR UPDATE[\s\S]*enrichPropertyFeedbackLocks[\s\S]*propertyFeedbackMutationLocked[\s\S]*DELETE FROM property_daily_necessities/)
  assert.match(crud, /async function pgInsert[\s\S]*lockPropertyFeedbackExpenseReferences[\s\S]*rawPgInsert\(resource, payload, tx\)/)
  assert.match(crud, /async function pgUpdate[\s\S]*lockPropertyFeedbackExpenseReferences[\s\S]*rawPgUpdate\(resource, id, payload, tx\)/)
  assert.match(crud, /async function pgDelete[\s\S]*lockPropertyFeedbackExpenseReferences[\s\S]*rawPgDelete\(resource, id, tx\)/)
  assert.match(crud, /lockPropertyFeedbackExpenseKeys\(client, resource, \[toInsert\]\)[\s\S]*lockPropertyFeedbackExpenseReferences\(client[\s\S]*assertPropertyFeedbackExpenseReferenceUnchanged\(client[\s\S]*return client.query\(sql, vals\)/)
  console.log('property feedback history policy: PASS (isolated fixtures and mocked evidence queries)')
}
main().catch(e => { console.error(e); process.exitCode = 1 })
