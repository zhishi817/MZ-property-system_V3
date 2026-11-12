import assert from 'node:assert/strict'

// Offline only: replace the adapter before importing the actual CRUD router.
// No server, credentials, sockets, PostgreSQL, or runtime schema writes.
process.env.DATABASE_URL = ''
const queries: Array<{ sql: string; params: any[] }> = []
const unexpected: string[] = []
let queryError: { code?: string; message: string } | null = null
const fail = (...args: any[]) => { throw new Error(`Unexpected offline adapter action: ${String(args[0])}`) }
const adapter: any = {
  hasPg: false,
  pgPool: { async query(sql: string, params: any[] = []) {
    queries.push({ sql, params })
    if (queryError) throw Object.assign(new Error(queryError.message), { code: queryError.code })
    if (!/^SELECT\b/.test(sql)) { unexpected.push(sql); return fail(sql) }
    if (sql.startsWith('SELECT COUNT(*)')) return { rows: [{ total: 1 }] }
    if (sql.startsWith('SELECT * FROM property_deep_cleaning')) return { rows: [{ id: 'mock-row', occurred_at: '2026-11-09' }] }
    unexpected.push(sql)
    return fail(sql)
  } },
  pgSelect: async (table: string) => table === 'properties' ? [] : fail(table),
  pgInsert: fail, pgUpdate: fail, pgDelete: fail, pgRunInTransaction: fail, pgRunWithAdvisoryLock: fail,
}
const adapterPath = require.resolve('../../src/dbAdapter')
require.cache[adapterPath] = { id: adapterPath, filename: adapterPath, loaded: true, exports: adapter } as any
const { db } = require('../../src/store')
const router = require('../../src/modules/crud').default
const route = router.stack.find((entry: any) => entry.route?.path === '/:resource' && entry.route.methods.get).route
assert(route.stack.length > 1, 'resource permission middleware remains on the route')
async function invoke(query: any = {}, resource = 'property_deep_cleaning', expectedStatus = 200) {
  const headers: Record<string, string> = {}
  const res: any = { statusCode: 200, body: undefined, setHeader(k: string, v: string) { headers[k] = v }, status(code: number) { this.statusCode = code; return this }, json(body: any) { this.body = body; return this } }
  await route.stack[route.stack.length - 1].handle({ params: { resource }, query, user: { role: 'admin', roles: ['admin'] } }, res)
  assert.equal(res.statusCode, expectedStatus)
  return { ...res, headers }
}
const fixtures = [
  { id: 'pending', category: null, project_desc: '厨房、客厅', completed_at: null, occurred_at: '2026-11-09', submitted_at: '2026-11-10T08:00:00Z' },
  { id: 'done', category: '厨房', completed_at: '2026-11-09T23:59:59Z', occurred_at: '2026-10-01', submitted_at: '2026-11-09T00:00:00Z' },
  { id: 'outside', category: '厨房', completed_at: '2026-11-10T00:00:00Z', occurred_at: '2026-11-09' },
  { id: 'prose', project_desc: '厨房需要彻底清洁', occurred_at: '2026-11-09' },
  { id: 'mixed-prose', project_desc: '厨房、需要彻底清洁', occurred_at: '2026-11-09' },
  { id: 'explicit-category', category: '卧室', project_desc: '厨房', occurred_at: '2026-11-09' },
  { id: 'null-date', project_desc: '厨房' },
]
async function main() {
  db.propertyDeepCleaning = fixtures
  // camelToArrayKey is generic plural-free camelCase in this resource.
  const range = { record_date_from: '2026-11-09T00:00:00Z', record_date_to: '2026-11-09T23:59:59.999Z' }
  let res = await invoke({ ...range, area: '厨房', withTotal: '1' })
  assert.deepEqual(res.body.map((r: any) => r.id), ['pending', 'done'])
  assert.equal(res.headers['X-Total-Count'], '2')
  res = await invoke({ ...range, area: '厨房', limit: '1', offset: '1' })
  assert.deepEqual(res.body.map((r: any) => r.id), ['done'])
  db.propertyDeepCleaning = [
    { id: 'z', occurred_at: '2026-11-10', submitted_at: '2026-11-01' },
    { id: 'b', occurred_at: '2026-01-01', created_at: '2026-11-09' },
    { id: 'a', occurred_at: '2026-01-01', submitted_at: '2026-11-09' },
    { id: 'old', occurred_at: '2026-11-08' }, { id: 'null' },
  ]
  res = await invoke({})
  assert.deepEqual(res.body.map((r: any) => r.id), ['a', 'b', 'old', 'z', 'null'])
  // Melbourne 2026-11-09 (AEDT, UTC+11): [Nov 8 13:00Z, Nov 9 13:00Z).
  const melbourneDay = { record_date_from: '2026-11-08T13:00:00.000Z', record_date_to: '2026-11-09T12:59:59.999Z' }
  db.propertyDeepCleaning = [
    { id: 'before', completed_at: '2026-11-08T12:59:59.999Z', occurred_at: '2026-11-09' },
    { id: 'start', completed_at: '2026-11-08T13:00:00.000Z', occurred_at: '2026-10-01' },
    { id: 'end', completed_at: '2026-11-09T12:59:59.999Z', occurred_at: '2026-10-01' },
    { id: 'after', completed_at: '2026-11-09T13:00:00.000Z', occurred_at: '2026-11-09' },
    { id: 'pending', completed_at: null, occurred_at: '2026-11-09' },
  ]
  res = await invoke(melbourneDay)
  assert.deepEqual(res.body.map((r: any) => r.id).sort(), ['end', 'pending', 'start'])
  adapter.hasPg = true
  queries.length = 0
  res = await invoke({ ...range, area: '厨房', limit: '1', offset: '1', withTotal: '1' })
  assert.equal(res.body[0].id, 'mock-row', 'actual PostgreSQL route returns stub rows')
  assert.deepEqual(unexpected, [], 'read route issues no DDL or mutations')
  const select = queries.find(q => q.sql.startsWith('SELECT *'))!
  const count = queries.find(q => q.sql.startsWith('SELECT COUNT'))!
  assert(select.sql.includes('COALESCE("completed_at", "occurred_at") >= $1'))
  assert(select.sql.includes('COALESCE("completed_at", "occurred_at") <= $2'))
  assert(select.sql.includes('"category" = $3'))
  assert(select.sql.includes('NULLIF(btrim("category"), \'\') IS NULL'))
  assert(select.sql.includes("string_to_array(COALESCE(\"project_desc\", ''), '、')"))
  assert(select.sql.includes('btrim(selected_area.value) = $3'))
  assert(select.sql.includes('NOT EXISTS') && select.sql.includes("'全屋'"))
  assert(select.sql.includes('ORDER BY COALESCE(submitted_at, created_at, occurred_at) DESC NULLS LAST, id ASC LIMIT $4 OFFSET $5'))
  assert.equal(count.sql.slice(count.sql.indexOf(' WHERE ')), select.sql.slice(select.sql.indexOf(' WHERE '), select.sql.indexOf(' ORDER BY ')))
  assert.deepEqual(select.params, [range.record_date_from, range.record_date_to, '厨房', 1, 1])
  queries.length = 0
  await invoke({ completed_at_from: range.record_date_from, occurred_at_to: range.record_date_to, category: '厨房' })
  const legacy = queries[0]
  assert(legacy.sql.includes('"completed_at" >= $1') && legacy.sql.includes('"occurred_at" <= $2') && legacy.sql.includes('"category" = $3'))
  assert(!legacy.sql.includes('string_to_array'))
  assert.deepEqual(unexpected, [])
  for (const code of ['42P01', '42703']) {
    queryError = { code, message: 'synthetic missing schema' }
    res = await invoke({}, 'property_deep_cleaning', 503)
    assert.deepEqual(res.body, { code: 'property_deep_cleaning_schema_not_ready' }, 'missing schema cannot silently serve in-memory records')
  }
  for (const error of [
    { code: 'ECONNREFUSED', message: 'synthetic connection refused' },
    { code: '08006', message: 'synthetic connection failure' },
    { code: '57014', message: 'synthetic query timeout' },
    { message: 'synthetic connection timeout' },
  ]) {
    queryError = error
    res = await invoke({}, 'property_deep_cleaning', 503)
    assert.deepEqual(res.body, { code: 'property_deep_cleaning_data_unavailable' }, 'database errors must not silently serve in-memory records')
  }
  queryError = null
  console.log('PASS deep-cleaning actual CRUD route: offline memory filters/sort/pagination, captured SQL/date compatibility, no read DDL')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
