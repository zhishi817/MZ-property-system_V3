import assert from 'node:assert/strict'

// Synthetic actual-route test. Every database/storage operation is replaced
// before module imports; no HTTP server, live database, object storage, or writes.
process.env.DATABASE_URL = ''
process.env.R2_STORAGE_NAMESPACE = 'test-current'
process.env.R2_BUCKET = 'synthetic-bucket'
process.env.R2_ENDPOINT = ''
process.env.R2_PUBLIC_BASE_URL = ''
process.env.R2_PUBLIC_BASE = ''
const key = 'mzapp/historic-report.jpg'
const reference = `r2://test-current/${key}`
const reads: string[] = []
const queries: string[] = []
let offlineRows: any[] = []
let feedbackRows: any[] = []
let authorized = true
let authorizationCalls = 0
const fail = () => { throw new Error('Forbidden offline test operation') }
const fakePool = { async query(sql: string) {
  queries.push(sql)
  assert(/^SELECT\b/.test(sql), 'read route must issue SELECT only')
  if (sql.includes("w.source_type = 'cleaning_offline_tasks'")) return { rows: offlineRows }
  if (sql.includes("SELECT 'property_maintenance'::text AS feedback_source_type")) return { rows: feedbackRows }
  if (sql.includes('FROM cleaning_tasks')) return { rows: [{ id: 'task-a', cleaner_id: 'cleaner-a' }] }
  throw new Error(`Unexpected offline SQL: ${sql}`)
} }
function stub(modulePath: string, exports: any) {
  const resolved = require.resolve(modulePath)
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports } as any
}
const adapter = { hasPg: false, pgPool: fakePool, pgSelect: fail, pgInsert: fail, pgUpdate: fail, pgDelete: fail, pgRunInTransaction: fail, pgRunWithAdvisoryLock: fail }
stub('../../src/dbAdapter', adapter)
stub('../../src/r2', { hasR2: true, r2KeyFromUrl: () => null, r2Upload: fail, r2UploadImmutable: fail, async r2GetObjectByKey(value: string) { reads.push(value); return { body: Buffer.from('synthetic-image') } } })
const image = require('../../src/lib/cleaningMediaImage')
image.encodeCleaningImageToJpeg = async (body: Buffer) => body
const mzapp = require('../../src/modules/mzapp')
mzapp.canViewMzappPropertyFeedback = async () => { authorizationCalls++; return authorized }
mzapp.canViewMzappRecordedCleaningMedia = async () => authorized
mzapp.canViewMzappOfflineWorkTaskMedia = async () => false
mzapp.propertyFeedbackSourceTaskAccess = async () => { authorizationCalls++; return { canViewHistory: authorized } }
const media = require('../../src/modules/cleaning_app')
const route = media.router.stack.find((entry: any) => entry.route?.path === '/media/image' && entry.route.methods.get).route
async function invoke(query: any = { url: reference }) {
  const res: any = { statusCode: 200, body: undefined, setHeader() {}, status(code: number) { this.statusCode = code; return this }, json(body: any) { this.body = body; return this }, send(body: any) { this.body = body; return this } }
  await route.stack[route.stack.length - 1].handle({ query, user: { sub: 'cleaner-a', role: 'cleaner' } }, res)
  return res
}
const fixture = { feedback_source_type: 'property_deep_cleaning', feedback_source_id: 'deep-a', property_id: 'property-a', source_task_id: 'task-a', photo_urls: [reference] }
async function denied(query: any) {
  reads.length = 0
  const res = await invoke(query)
  assert.equal(res.statusCode, 403, JSON.stringify(res.body))
  assert.deepEqual(reads, [], 'denied request never reads storage')
}
async function main() {
  adapter.hasPg = true
  feedbackRows = [fixture]
  for (const query of [{ url: reference }, { key: reference }, { url: reference, history_scope: 'property', source_task_id: 'current-task' }]) {
    reads.length = 0
    const res = await invoke(query)
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    assert.deepEqual(reads, [key])
  }
  assert(authorizationCalls > 0, 'existing authorization is still consulted')
  authorized = false
  await denied({ url: reference })
  await denied({ url: reference, history_scope: 'property', source_task_id: 'current-task' })
  authorized = true
  for (const url of [reference.replace('test-current', 'other-namespace'), `${reference}?x=1`, `${reference}#x`, 'r2:/test-current/mzapp/image.jpg', 'r2://test-current/mzapp/../secret.jpg', 'r2://test-current/mzapp/%2e%2e/secret.jpg', 'r2://test-current/mzapp/image name.jpg']) await denied({ url })
  for (const stored of [reference.replace('test-current', 'other-namespace'), `${reference}?x=1`, `${reference}.other`, 'mzapp/not-the-request.jpg']) {
    feedbackRows = [{ ...fixture, photo_urls: [stored] }]
    await denied({ url: reference })
  }
  feedbackRows = [fixture, { ...fixture, feedback_source_id: 'deep-b' }]
  await denied({ url: reference })
  feedbackRows = [fixture]
  offlineRows = [{ id: 'offline-a', photo_urls: [reference] }]
  await denied({ url: reference, history_scope: 'property', source_task_id: 'current-task' })
  await denied({ url: reference, work_task_id: 'unrelated-offline' })
  await denied({ url: reference })
  offlineRows.push({ id: 'offline-b', photo_urls: [reference] })
  await denied({ url: reference })
  assert(queries.every(sql => /^SELECT\b/.test(sql)))
  console.log('PASS canonical r2 feedback actual route: exact namespace/reference, existing authorization, offline collisions, malformed/query/traversal denied; no live I/O')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
