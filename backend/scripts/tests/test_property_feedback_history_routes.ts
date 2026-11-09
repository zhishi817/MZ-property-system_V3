import assert from 'node:assert/strict'

// No server, sockets, database connection or credentials. Invoke the actual route
// handlers with a fail-closed in-memory adapter, not a second implementation.
process.env.DATABASE_URL = ''
process.env.MZ_DEV_PREVIEW_DISABLE_RUNTIME_DDL = '1'
const queries: Array<{ sql: string; params: any[] }> = []
let fixtures: any[] = []
let currentRow: any = null
let deniedTask = false
let lockEvidence: Record<string, boolean> = {}
let lockEvidenceUnavailable = false
let mutations: string[] = []
let user = { sub: 'cleaner-a', role: 'cleaner', roles: ['cleaner'] }
const result = (rows: any[]) => ({ rows, rowCount: rows.length })
const fakePool = {
  async query(raw: string, params: any[] = []) {
    const sql = raw.replace(/\s+/g, ' ').trim()
    queries.push({ sql, params })
    if (/^(CREATE|ALTER)\b/.test(sql)) return result([]) // Existing daily schema preflight, mocked only.
    if (/LIMIT 0$/.test(sql)) return result([])
    if (sql.includes('FROM information_schema.columns')) return result([{ data_type: 'jsonb', udt_name: 'jsonb' }])
    if (sql.includes('FROM cleaning_tasks t') && sql.includes('has_execution_evidence')) {
      assert.equal(params[1], 'property-a')
      assert.equal(params[2], user.sub)
      return result(deniedTask || params[0] !== 'current-task' ? [] : [{ id: 'current-task', property_id: 'property-a', cleaner_id: user.sub }])
    }
    if (sql.includes('FROM properties')) return result(params[0] === 'property-a' ? [{ id: 'property-a', code: 'A' }] : [])
    if (sql.startsWith('SELECT EXISTS') && sql.includes('feedback_has_expense')) {
      if (lockEvidenceUnavailable) throw new Error('synthetic lock evidence failure')
      return result([{ feedback_has_assignment: false, feedback_has_expense: false, feedback_has_history: false, ...lockEvidence }])
    }
    if (sql.startsWith('SELECT *') && /FROM property_(maintenance|deep_cleaning|daily_necessities)/.test(sql)) return result(currentRow ? [currentRow] : [])
    if (/^SELECT [mdn]\.\*/.test(sql)) {
      const alias = sql[7]
      const kind = alias === 'm' ? 'maintenance' : alias === 'd' ? 'deep_cleaning' : 'daily_necessities'
      let rows = fixtures.filter(row => (row.kind || 'maintenance') === kind && row.property_id === params[0] && !row.deleted_at && !['deleted', 'cancelled'].includes(row.status))
      const source = params[alias === 'n' ? 3 : 2]
      if (source) rows = rows.filter(row => row.source_task_id === source)
      if (alias === 'n') rows = rows.filter(row => params[1].includes(row.status))
      // The SQL is separately asserted against the exported status predicate.
      // Evaluate its requested group in this fixture adapter before applying LIMIT.
      const accepted = new Set<string>()
      for (const match of sql.matchAll(/lower\(COALESCE\([md]\.status, ''\)\) IN \(([^)]+)\)/g)) {
        for (const value of match[1].matchAll(/'([^']*)'/g)) accepted.add(value[1])
      }
      for (const match of sql.matchAll(/lower\(COALESCE\([md]\.status, ''\)\) = '([^']*)'/g)) accepted.add(match[1])
      if (accepted.size) rows = rows.filter(row => accepted.has(row.status))
      return result(rows.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id)).slice(0, params[alias === 'n' ? 2 : 1]))
    }
    if (/^UPDATE property_(maintenance|deep_cleaning|daily_necessities) SET/.test(sql)) {
      mutations.push(sql)
      if (sql.includes('SET deleted_at')) currentRow = { ...currentRow, deleted_at: 'mock-now' }
      else if (sql.startsWith('UPDATE property_maintenance')) currentRow = { ...currentRow, details: params[3] }
      else if (sql.startsWith('UPDATE property_deep_cleaning')) currentRow = { ...currentRow, project_desc: params[1], details: params[2] }
      else currentRow = { ...currentRow, note: params[4] }
      return result([currentRow])
    }
    if (sql.startsWith('DELETE FROM work_tasks')) { mutations.push(sql); return result([]) }
    if (/^UPDATE (property|company)_expenses SET source_summary/.test(sql)) return result([])

    throw new Error(`Unexpected mock query (no live fallback): ${sql}`)
  },
}
const db = require('../../src/dbAdapter')
db.hasPg = true
db.pgPool = fakePool
db.pgRunInTransaction = async (callback: any) => callback(fakePool)
const auth = require('../../src/auth')
auth.userHasAnyPerm = async () => false
const runtime = require('../../src/lib/maintenanceRuntimeSchema')
runtime.assertMaintenanceRuntimeSchemaReady = () => undefined
runtime.isMaintenanceRuntimeSchemaReady = () => true
const schema = require('../../src/lib/maintenanceWorkflowSchema')
schema.assertMaintenanceWorkflowSchemaReady = async () => undefined
require('../../src/lib/maintenanceWorkflowStore').insertMaintenanceWorkflowEvent = async () => undefined
const mzapp = require('../../src/modules/mzapp')

async function invoke(method: string, query: any, params: any = {}, body: any = {}) {
  const routePath = method === 'get' ? '/property-feedbacks' : method === 'post' ? '/property-feedbacks/:kind/:id/move' : '/property-feedbacks/:kind/:id'
  const layer = mzapp.router.stack.find((entry: any) => entry.route?.path === routePath && entry.route.methods[method])
  assert(layer, `${method} route exists`)
  const response: any = { statusCode: 200, body: undefined, status(code: number) { this.statusCode = code; return this }, json(value: any) { this.body = value; return this } }
  await layer.route.stack[layer.route.stack.length - 1].handle({ user, query, params, body }, response)
  return response
}
const row = (id: string, source_task_id: any, status = 'pending_assignment', created_at = '2020-01-01') => ({
  id, property_id: 'property-a', source_task_id, status, created_at, created_by_user_id: user.sub,
  area: 'Kitchen', details: 'Old report', photo_urls: ['maintenance/report.jpg'], amount: 999,
  project_items: [{ id: 'project-a', title: 'Repair', amount: 888, cost: 777, price: 666, before_photos: ['maintenance/report.jpg'] }],
})
async function main() {
  const query = { property_id: 'property-a', source_task_id: 'current-task', history_scope: 'property', status: 'open,in_progress', limit: 50 }
  fixtures = [row('legacy', null), row('other-author', 'obsolete-projection')]
  fixtures[1].created_by_user_id = 'someone-else'
  let response = await invoke('get', query)
  assert.equal(response.statusCode, 200, JSON.stringify(response.body))
  assert.deepEqual(response.body.map((item: any) => item.id).sort(), ['legacy', 'other-author'])
  assert.equal(response.body[1].capabilities.can_edit_content, false)
  const assertRedacted = (value: any) => {
    if (!value || typeof value !== 'object') return
    for (const [key, child] of Object.entries(value)) {
      assert(!['amount', 'cost', 'price', 'fee', 'invoice_description_en'].includes(key), `financial field leaked: ${key}`)
      assertRedacted(child)
    }
  }
  assertRedacted(response.body)
  const list = queries.find(item => item.sql.startsWith('SELECT m.*'))!
  assert.equal(list.params[2], null, 'property mode removes only original source filter')
  assert(list.sql.includes(mzapp.propertyFeedbackHistoryStatusWhereSql('m', ['open', 'in_progress'])), 'route uses the exported group predicate before ORDER/LIMIT')
  response = await invoke('get', { ...query, history_scope: undefined })
  assert.deepEqual(response.body, [], 'legacy exact-source mode does not acquire broader history access')
  deniedTask = true
  response = await invoke('get', query)
  assert.equal(response.statusCode, 403)
  deniedTask = false
  assert.equal((await invoke('get', { ...query, source_task_id: '' })).statusCode, 400)
  currentRow = { ...row('own-legacy', null), project_items: [], amount: null }
  deniedTask = true
  for (const method of ['patch', 'delete']) {
    response = await invoke(method, query, { kind: 'maintenance', id: currentRow.id }, { detail: 'Changed' })
    assert.equal(response.statusCode, 403, `${method}: ${JSON.stringify(response.body)}`)
  }
  deniedTask = false
  currentRow = { ...currentRow, assignee_id: 'executor', status: 'assigned' }
  for (const method of ['patch', 'delete']) {
    response = await invoke(method, query, { kind: 'maintenance', id: currentRow.id }, { detail: 'Changed' })
    assert([403, 409].includes(response.statusCode), `${method}: ${JSON.stringify(response.body)}`)
  }
  fixtures = [...Array.from({ length: 60 }, (_, index) => row(`resolved-${index}`, null, 'closed', '2026-11-07')), row('old-pending', null)]
  response = await invoke('get', query)
  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.body.map((item: any) => item.id), ['old-pending'], 'resolved records cannot crowd pending group before LIMIT')
  fixtures.push(row('review', 'old-source', 'pending_review', '2026-11-06'), row('cancelled', null, 'cancelled'))
  response = await invoke('get', { ...query, status: 'pending_review' })
  assert.deepEqual(response.body.map((item: any) => item.id), ['review'])
  assert.equal(response.body[0].status, 'pending_review')
  response = await invoke('get', { ...query, status: 'resolved,closed' })
  assert.equal(response.body.length, 50)
  assert(response.body.every((item: any) => item.status === 'resolved'))
  const kinds = ['maintenance', 'deep_cleaning', 'daily_necessities']
  const cleanRow = (kind: string, source: any = null) => ({ ...row(`own-${kind}`, source, kind === 'daily_necessities' ? 'need_replace' : 'pending_assignment'), kind, amount: null, project_items: [], project_desc: 'Kitchen', item_name: 'Soap', quantity: 1, note: 'Replace soap' })
  const patchFor = (kind: string) => kind === 'daily_necessities' ? { note: 'Updated soap report' } : { detail: 'Updated report' }
  fixtures = kinds.flatMap(kind => [cleanRow(kind), { ...cleanRow(kind, 'obsolete-projection'), id: `other-${kind}`, created_by_user_id: 'other-person' }])
  response = await invoke('get', { ...query, status: 'open,in_progress,need_replace' })
  assert.equal(response.body.length, 6)
  assert.deepEqual(new Set(response.body.map((item: any) => item.kind)), new Set(kinds))
  assertRedacted(response.body)
  for (const kind of kinds) {
    for (const source of [null, 'old-cleaning-task', 'obsolete-projection']) {
      currentRow = cleanRow(kind, source)
      mutations = []
      response = await invoke('patch', query, { kind, id: currentRow.id }, patchFor(kind))
      assert.equal(response.statusCode, 200, `${kind} own PATCH: ${JSON.stringify(response.body)}`)
      assert.equal(mutations.length, 1)
      assertRedacted(response.body)
      response = await invoke('delete', query, { kind, id: currentRow.id })
      assert.equal(response.statusCode, 200, `${kind} own DELETE: ${JSON.stringify(response.body)}`)
      assert.equal(response.body.deleted, true)
      assert(currentRow.deleted_at)
    }
    for (const evidence of ['feedback_has_expense', 'feedback_has_history', 'feedback_has_assignment']) {
      currentRow = cleanRow(kind)
      lockEvidence = { [evidence]: true }
      for (const method of ['patch', 'delete']) {
        mutations = []
        response = await invoke(method, query, { kind, id: currentRow.id }, patchFor(kind))
        assert([403, 409].includes(response.statusCode), `${kind} owner ${method} must honor ${evidence}`)
        assert.deepEqual(mutations, [])
      }
    }
    lockEvidence = {}
    currentRow = { ...cleanRow(kind), created_by_user_id: 'other-person' }
    for (const method of ['patch', 'delete']) {
      mutations = []
      response = await invoke(method, query, { kind, id: currentRow.id }, patchFor(kind))
      assert.equal(response.statusCode, 403, `${kind} other-author ${method}`)
      assert.deepEqual(mutations, [])
    }
    for (const role of ['admin', 'offline_manager', 'customer_service']) {
      user = { sub: 'manager-a', role, roles: [role] }
      currentRow = { ...cleanRow(kind), created_by_user_id: 'other-person' }
      response = await invoke('delete', query, { kind, id: currentRow.id })
      assert.equal(response.statusCode, 200, `${role} ${kind} unlocked delete: ${JSON.stringify(response.body)}`)
      for (const evidence of ['feedback_has_expense', 'feedback_has_history', 'feedback_has_assignment']) {
        currentRow = { ...cleanRow(kind), created_by_user_id: 'other-person' }
        lockEvidence = { [evidence]: true }
        mutations = []
        response = await invoke('delete', query, { kind, id: currentRow.id })
        assert.equal(response.statusCode, 403, `${role} ${kind} ${evidence}`)
        assert.deepEqual(mutations, [])
        if (kind !== 'maintenance' && role !== 'customer_service') {
          response = await invoke('post', {}, { kind, id: currentRow.id }, { target_kind: 'maintenance' })
          assert.equal(response.statusCode, 403, `${role} ${kind} move must not bypass ${evidence}: ${JSON.stringify(response.body)}`)
          assert.deepEqual(mutations, [])
        }
      }
      lockEvidence = {}
      for (const recordLock of [{ assignee_id: 'executor-a' }, { completed_at: '2026-11-07' }, { amount: 12 }]) {
        currentRow = { ...cleanRow(kind), ...recordLock, created_by_user_id: 'other-person' }
        mutations = []
        response = await invoke('delete', query, { kind, id: currentRow.id })
        assert.equal(response.statusCode, 403, `${role} ${kind} record lock ${JSON.stringify(recordLock)}`)
        assert.deepEqual(mutations, [])
      }
      currentRow = { ...cleanRow(kind), created_by_user_id: 'other-person' }
      if (role === 'customer_service') {
        response = await invoke('patch', query, { kind, id: currentRow.id }, patchFor(kind))
        assert.equal(response.statusCode, 403, 'delete privilege does not grant customer-service edit privilege')
      }
    }
    user = { sub: 'cleaner-a', role: 'cleaner', roles: ['cleaner'] }
  }
  fixtures = Array.from({ length: 180 }, (_, index) => ({ ...cleanRow(kinds[index % 3]), id: `page-${String(index).padStart(3, '0')}`, created_at: '2026-11-07' }))
  const pages: any[] = []
  for (const offset of [0, 50, 100, 150]) {
    const queryStart = queries.length
    response = await invoke('get', { ...query, status: 'open,in_progress,need_replace', offset })
    for (const call of queries.slice(queryStart).filter(call => /^SELECT [mdn]\.\*/.test(call.sql))) {
      assert.equal(call.params[call.sql[7] === 'n' ? 2 : 1], offset + 50, 'each table fetches enough rows for global offset')
      assert.match(call.sql, /ORDER BY .* DESC NULLS LAST, [mdn]\.id::text DESC LIMIT/)
    }
    assert.equal(response.statusCode, 200)
    assert.equal(response.body.length, offset === 150 ? 30 : 50)
    const lockQueries = queries.slice(queryStart).filter(call => call.sql.startsWith('SELECT EXISTS') && call.sql.includes('feedback_has_expense'))
    assert.equal(lockQueries.length, response.body.length, 'only the final page loads per-record lock evidence, regardless of offset')
    assert.deepEqual(new Set(lockQueries.map(call => call.params[1])), new Set(response.body.map((item: any) => item.id)))
    pages.push(...response.body)
  }
  assert.equal(new Set(pages.map(item => item.id)).size, 180, 'same-group pagination has no overlap or loss')
  assert.deepEqual(pages.map(item => item.id), [...fixtures].sort((a, b) => b.kind.localeCompare(a.kind) || b.id.localeCompare(a.id)).map(item => item.id), 'timestamp ties use deterministic descending kind/ID order')
  const emptyPageQueryStart = queries.length
  response = await invoke('get', { ...query, status: 'open,in_progress,need_replace', offset: 1000 })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.body, [])
  assert.equal(queries.slice(emptyPageQueryStart).filter(call => call.sql.startsWith('SELECT EXISTS') && call.sql.includes('feedback_has_expense')).length, 0, 'empty pages never load lock evidence')
  lockEvidenceUnavailable = true
  response = await invoke('get', { ...query, status: 'open,in_progress,need_replace', offset: 150 })
  assert.equal(response.statusCode, 500, 'page enrichment failure stays fail-closed')
  assert.equal(response.body.message, 'property_feedbacks_failed')
  assert(!JSON.stringify(response.body).includes('synthetic lock evidence failure'), 'raw evidence errors are not exposed')
  lockEvidenceUnavailable = false
  console.log('property feedback history routes: passed (actual handlers; in-memory adapter; no network/database)')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
