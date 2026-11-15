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
let deepProjection:any = null
let deepRecord:any = null
let canonicalTask:any = {id:'task-a',property_id:'property-a',cleaner_id:'cleaner-a'}
let authorized = true
let authorizationCalls = 0
const fail = () => { throw new Error('Forbidden offline test operation') }
const fakePool = { async query(sql: string,params:any[]=[]) {
  queries.push(sql)
  assert(/^SELECT\b/.test(sql), 'read route must issue SELECT only')
  if (sql.includes('FROM property_deep_cleaning d WHERE d.id::text=$1')) {
    const [recordId,propertyId,actorId]=params
    const matches=deepRecord && recordId===deepRecord.id && propertyId===deepRecord.property_id && !deepRecord.deleted_at && !deepProjection
    return {rows:matches?[{...deepRecord,is_admin:actorId==='real-admin'}]:[]}
  }
  if (sql.includes('SELECT d.assignee_id::text AS assignee_id,d.photo_urls,d.repair_photo_urls')) {
    const [taskId,sourceId,propertyId,actorId]=params
    const matches=deepProjection && taskId===deepProjection.id && sourceId===deepProjection.source_id && propertyId===deepProjection.property_id && deepProjection.source_type==='property_deep_cleaning' && deepProjection.assignee_id===deepProjection.source_assignee_id && !deepProjection.deleted_at
    return {rows:matches?[{assignee_id:deepProjection.source_assignee_id,photo_urls:deepProjection.photo_urls,repair_photo_urls:deepProjection.repair_photo_urls,attachment_urls:deepProjection.attachment_urls,is_admin:actorId==='real-admin'}]:[]}
  }
  if (sql.includes("w.source_type = 'cleaning_offline_tasks'")) return { rows: offlineRows }
  if (sql.includes("SELECT 'property_maintenance'::text AS feedback_source_type")) return { rows: feedbackRows }
  if (sql.includes('FROM cleaning_tasks')) return {rows:canonicalTask && (!params[0] || params[0]===canonicalTask.id) && (!sql.includes('LEFT JOIN properties') || params[1]===canonicalTask.property_id) ? [canonicalTask] : []}
  if (sql.includes('FROM work_task_participants')) return {rows:[]}
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
const realFeedbackAccess=mzapp.canViewMzappPropertyFeedback
const realRecordedMediaAccess=mzapp.canViewMzappRecordedCleaningMedia
const realSourceTaskAccess=mzapp.propertyFeedbackSourceTaskAccess
mzapp.canViewMzappPropertyFeedback = async () => { authorizationCalls++; return authorized }
mzapp.canViewMzappRecordedCleaningMedia = async () => authorized
mzapp.canViewMzappOfflineWorkTaskMedia = async () => false
mzapp.propertyFeedbackSourceTaskAccess = async () => { authorizationCalls++; return { canViewHistory: authorized } }
const media = require('../../src/modules/cleaning_app')
const route = media.router.stack.find((entry: any) => entry.route?.path === '/media/image' && entry.route.methods.get).route
async function invoke(query: any = { url: reference }, user:any = { sub: 'cleaner-a', role: 'cleaner' }) {
  const res: any = { statusCode: 200, body: undefined, setHeader() {}, status(code: number) { this.statusCode = code; return this }, json(body: any) { this.body = body; return this }, send(body: any) { this.body = body; return this } }
  await route.stack[route.stack.length - 1].handle({ query, user }, res)
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
  // New deep-only source binding uses the real handler, not the broad feedback
  // authorization stub: only this matching stored tuple can unlock object reads.
  offlineRows=[];authorized=false
  deepProjection={id:'property_deep_cleaning:deep-a',source_id:'deep-a',source_type:'property_deep_cleaning',property_id:'property-a',assignee_id:'cleaner-a',source_assignee_id:'cleaner-a',photo_urls:[reference],repair_photo_urls:[]}
  feedbackRows=[{...fixture,source_task_id:null}]
  const context={url:reference,work_task_id:deepProjection.id}
  for (const actor of [{sub:'cleaner-a',role:'finance_staff'},{sub:'real-admin',role:'cleaner'}]) {
    reads.length=0;assert.equal((await invoke(context,actor)).statusCode,200);assert.deepEqual(reads,[key])
  }
  deepProjection.photo_urls=[];deepProjection.repair_photo_urls=[reference]
  assert.equal((await invoke(context)).statusCode,200,'bound after evidence uses the same exact source gate')
  for (const actor of [{sub:'previous',role:'cleaner'},{sub:'unrelated',role:'admin'},{sub:'manager',role:'offline_manager'}]) {
    reads.length=0;assert.equal((await invoke(context,actor)).statusCode,403);assert.deepEqual(reads,[])
  }
  await denied({...context,work_task_id:'property_deep_cleaning:wrong'})
  await denied({...context,source_task_id:'unrelated-cleaning-source'})
  for (const patch of [{source_id:'wrong-source'},{property_id:'wrong-property'},{source_type:'property_maintenance'},{source_assignee_id:'new-assignee'},{deleted_at:'2026-11-12'}]) {
    const previous={...deepProjection};deepProjection={...deepProjection,...patch};await denied(context);deepProjection=previous
  }
  deepProjection.repair_photo_urls=[];await denied(context)
  deepProjection.attachment_urls=[reference]
  feedbackRows=[{...fixture,source_task_id:null,photo_urls:[],attachment_urls:[reference]}]
  for (const actor of [{sub:'cleaner-a',role:'cleaner'},{sub:'real-admin',role:'cleaner'}]) {
    reads.length=0;assert.equal((await invoke(context,actor)).statusCode,200,'existing attachment-only image remains accessible');assert.deepEqual(reads,[key])
  }
  await denied({...context,work_task_id:'property_deep_cleaning:wrong'})
  deepProjection.attachment_urls=[];await denied(context)
  deepProjection.attachment_urls=[reference]
  feedbackRows.push({...feedbackRows[0],feedback_source_id:'second-source'})
  await denied(context)

  feedbackRows=[];await denied(context)
  // Restore the real legacy permission helpers: database fixture supplies only
  // canonical source/participant evidence, never a blanket authorization result.
  mzapp.canViewMzappPropertyFeedback=realFeedbackAccess
  mzapp.canViewMzappRecordedCleaningMedia=realRecordedMediaAccess
  mzapp.propertyFeedbackSourceTaskAccess=realSourceTaskAccess
  require('../../src/auth').userHasAnyPerm=async()=>false // no new report/write grant
  feedbackRows=[{...fixture,source_task_id:'task-a'}]
  canonicalTask={id:'task-a',property_id:'property-a',cleaner_id:'original-participant'}
  deepProjection.photo_urls=[reference];deepProjection.attachment_urls=[]
  for (const actor of [{sub:'legacy-manager',role:'offline_manager'},{sub:'original-participant',role:'cleaner'}]) {
    assert.equal((await invoke({url:reference},actor)).statusCode,200,'legacy canonical source is genuinely authorized')
    assert.equal((await invoke(context,actor)).statusCode,200,'correct new context preserves the original authorization')
    reads.length=0;assert.equal((await invoke({...context,work_task_id:'wrong-task'},actor)).statusCode,403);assert.deepEqual(reads,[])
  }
  for (const patch of [{source_id:'wrong-source'},{property_id:'wrong-property'},{source_assignee_id:'inconsistent-current'}, {photo_urls:[]}]) {
    const saved={...deepProjection};deepProjection={...deepProjection,...patch}
    reads.length=0;assert.equal((await invoke(context,{sub:'legacy-manager',role:'offline_manager'})).statusCode,403);assert.deepEqual(reads,[]);deepProjection=saved
  }
  reads.length=0;assert.equal((await invoke({...context,source_task_id:'wrong-source-context'},{sub:'legacy-manager',role:'offline_manager'})).statusCode,403);assert.deepEqual(reads,[])
  for (const actor of [{sub:'previous',role:'cleaner'},{sub:'unrelated',role:'cleaner'}]) {reads.length=0;assert.equal((await invoke(context,actor)).statusCode,403);assert.deepEqual(reads,[])}
  canonicalTask=null
  reads.length=0;assert.equal((await invoke(context,{sub:'legacy-manager',role:'offline_manager'})).statusCode,403);assert.deepEqual(reads,[])
  canonicalTask={id:'task-a',property_id:'wrong-property',cleaner_id:'original-participant'}
  reads.length=0;assert.equal((await invoke(context,{sub:'original-participant',role:'cleaner'})).statusCode,403);assert.deepEqual(reads,[])
  // Admin review of new unassigned / legacy pending records with no projection.
  deepProjection=null
  deepRecord={id:'deep-a',property_id:'property-a',photo_urls:[reference],repair_photo_urls:[],attachment_urls:[]}
  feedbackRows=[{...fixture,source_task_id:null}]
  canonicalTask=null
  const recordContext={url:reference,deep_record_id:'deep-a'}
  for (const status of ['pending','completed']) {
    deepRecord.status=status;deepRecord.review_status='pending'
    reads.length=0;assert.equal((await invoke(recordContext,{sub:'real-admin',role:'cleaner'})).statusCode,200);assert.deepEqual(reads,[key])
  }
  for(const field of ['repair_photo_urls','attachment_urls']) {
    deepRecord.photo_urls=[];deepRecord.repair_photo_urls=[];deepRecord.attachment_urls=[];deepRecord[field]=[reference]
    feedbackRows=[{...fixture,source_task_id:null,photo_urls:[],[field]:[reference]}]
    assert.equal((await invoke(recordContext,{sub:'real-admin',role:'cleaner'})).statusCode,200)
  }
  for(const actor of [{sub:'cleaner-a',role:'cleaner'},{sub:'fake-admin',role:'admin'},{sub:'manager',role:'offline_manager'}]) {reads.length=0;assert.equal((await invoke(recordContext,actor)).statusCode,403);assert.deepEqual(reads,[])}
  for(const query of [{...recordContext,deep_record_id:'wrong-record'},{...recordContext,work_task_id:'wrong-task'}]) {reads.length=0;assert.equal((await invoke(query,{sub:'real-admin',role:'admin'})).statusCode,403);assert.deepEqual(reads,[])}
  for(const patch of [{deleted_at:'2026-11-12'},{property_id:'wrong-property'},{attachment_urls:[]}]) {
    const saved={...deepRecord};deepRecord={...deepRecord,...patch};reads.length=0;assert.equal((await invoke(recordContext,{sub:'real-admin',role:'admin'})).statusCode,403);assert.deepEqual(reads,[]);deepRecord=saved
  }
  feedbackRows.push({...feedbackRows[0],feedback_source_id:'collision-record'});reads.length=0;assert.equal((await invoke(recordContext,{sub:'real-admin',role:'admin'})).statusCode,403);assert.deepEqual(reads,[])
  feedbackRows=[{...fixture,source_task_id:'task-a'}];deepRecord.photo_urls=[reference]
  canonicalTask={id:'task-a',property_id:'property-a',cleaner_id:'original-participant'}
  for(const actor of [{sub:'original-participant',role:'cleaner'},{sub:'legacy-manager',role:'offline_manager'}]) {
    assert.equal((await invoke({url:reference},actor)).statusCode,200)
    assert.equal((await invoke(recordContext,actor)).statusCode,200,'correct record id preserves complete existing source authorization')
  }
  deepProjection={id:'present-task'};reads.length=0;assert.equal((await invoke(recordContext,{sub:'real-admin',role:'admin'})).statusCode,403,'record-only path cannot bypass an existing task projection');assert.deepEqual(reads,[])
  assert(queries.every(sql => /^SELECT\b/.test(sql)))
  console.log('PASS canonical r2 feedback actual route: exact namespace/reference, existing authorization, offline collisions, malformed/query/traversal denied; no live I/O')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
