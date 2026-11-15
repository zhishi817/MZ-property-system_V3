import assert from 'node:assert/strict'
import { deepCleaningAvailableActions, deepCleaningReviewPrice, isDeepCleaningExecutorEligibleRoleNames } from '../../src/lib/deepCleaningWorkflow'

for (const roles of [[],['finance'],['finance_staff'],['finance_manager'],['admin'],['owner'],['partner'],['cleaner']]) assert.equal(isDeepCleaningExecutorEligibleRoleNames(roles),true)
for (const roles of [['customer_service'],['admin',' Customer_Service '],['finance','customer_service']]) assert.equal(isDeepCleaningExecutorEligibleRoleNames(roles),false)
// Offline synthetic fixtures only. Adapter/auth/storage are replaced before route imports.
const base = {pay_method:'company_pay',gst_type:'GST_INCLUDED_10'}
assert.equal(deepCleaningReviewPrice({...base,pricing_mode:'total',total_amount:0}).total_amount,0)
for (const value of [null,undefined,'',NaN,-1,1.001]) assert.throws(() => deepCleaningReviewPrice({...base,pricing_mode:'total',total_amount:value}))
assert.equal(deepCleaningReviewPrice({...base,gst_type:'INPUT_TAXED',pricing_mode:'items',price_items:[{id:'a',description:'A',amount:0.1},{id:'b',description:'B',amount:0.2}]}).total_amount,0.3)
assert.throws(() => deepCleaningReviewPrice({...base,pricing_mode:'items',total_amount:3,price_items:[{id:'a',description:'A',amount:3}]}))
assert.throws(() => deepCleaningReviewPrice({...base,pricing_mode:'items',price_items:[{id:'a',description:'A',amount:3},{id:'a',description:'B',amount:3}]}))
assert.deepEqual(deepCleaningAvailableActions({status:'pending_review'},{role:'offline_manager',roles:['finance']}),[])
assert.deepEqual(deepCleaningAvailableActions({status:'pending_review'},{role:'admin'}),['review'])
assert.deepEqual(deepCleaningAvailableActions({status:'completed'},{role:'admin'},true),[])
assert.deepEqual(deepCleaningAvailableActions({status:'assigned',assignee_id:'worker'},{sub:'worker'}),['complete'])
assert.deepEqual(deepCleaningAvailableActions({status:'assigned',assignee_id:'worker'},{sub:'other'}),[])
function stub(path:string,exports:any) { const key=require.resolve(path); require.cache[key]={id:key,filename:key,loaded:true,exports} as any }
let row:any = {id:'synthetic',status:'assigned',assignee_id:'worker',photo_urls:['mzapp/before.jpg'],repair_photo_urls:[],consumables:[{cost:99}],total_cost:null,property_id:'property',eta:'2026-11-12'}
let audits:any[]=[]; let events:any[]=[]; let expenses:any[]=[]; let receipts:any[]=[]; let eventFailure=false; let expenseFailure=false
const queries:string[]=[]
const client:any = {async query(sql:string,params:any[]=[]) {
  queries.push(sql)
  if (/^(CREATE|ALTER|DROP|TRUNCATE)/i.test(sql.trim())) throw new Error('forbidden_ddl')
  if (sql.includes('pg_advisory_xact_lock')) return {rows:[]}
  if (sql.includes('FROM app_submit_receipts')) return {rows:sql.includes('LIMIT 0') ? [] : receipts.filter(x=>x.scope===JSON.stringify(params)).map(x=>x.receipt)}
  if (sql.includes('INSERT INTO app_submit_receipts')) {receipts.push({scope:JSON.stringify(params.slice(1,5)),receipt:{payload_hash:params[5],response_json:JSON.parse(params[6])}});return {rows:[]}}
  if (sql.startsWith('UPDATE property_deep_cleaning SET photo_urls=')) {row.photo_urls=JSON.parse(params[1]);return {rows:[{...row}]}}
  if (sql.includes('FROM users WHERE')) {const id=params[0];return {rows:id==='missing'?[]:[{id,role:id==='admin'?'admin':id==='finance'?'finance':id==='cs'?'customer_service':'cleaner',username:id}]}}
  if (sql.includes('FROM user_roles')) return {rows:[]}
  if (sql.includes('FROM information_schema.columns')) return {rows:[{data_type:'jsonb',udt_name:'jsonb'}]}
  if (sql.includes('INSERT INTO audit_logs')) {audits.push({entity_id:params[1],review:JSON.parse(params[4]).deep_cleaning_review});return {rows:[]}}
  if (sql.includes('SELECT w.id::text AS id,w.source_id::text')) return {rows:[{id:'real-projected-task',source_id:row.id}]}
  if (sql.includes('FROM audit_logs')) return {rows:audits}
  if (sql.includes('SELECT * FROM property_deep_cleaning') || sql.includes('SELECT "id"') && sql.includes('property_deep_cleaning')) return {rows:[{...row}]}
  if (sql.includes('SELECT COUNT(*)')) return {rows:[{total:1}]}
  if (sql.startsWith('UPDATE property_deep_cleaning')) {
    if (sql.includes("status='assigned'")) row={...row,assignee_id:params[1],worker_name:params[2],eta:params[3],status:'assigned'}
    else if (sql.includes("status='pending_review'")) row={...row,status:'pending_review',review_status:'pending',repair_photo_urls:JSON.parse(params[1]),repair_notes:params[2],completed_at:'2026-11-12T00:00:00Z'}
    else if (sql.includes("review_status='approved'")) row={...row,status:'completed',review_status:'approved',total_cost:params[1],pay_method:params[2],gst_type:params[3],reviewed_by:params[4]}
    else throw new Error('unexpected_update')
    return {rows:[{...row}]}
  }
  if (sql.includes('INSERT INTO work_tasks')) return {rows:[]}
  throw new Error('unexpected_sql:'+sql)
}}
const adapter:any = {hasPg:true,pgPool:client,pgSelect:async (table:string)=>table==='properties'?[]:table==='property_deep_cleaning'?[{...row}]:[],pgInsert:()=>{throw new Error('unexpected')},pgUpdate:()=>{throw new Error('unexpected')},pgDelete:()=>{throw new Error('unexpected')},pgRunWithAdvisoryLock:()=>{throw new Error('unexpected')},pgRunInTransaction:async(fn:any)=>{
  const snapshot=JSON.stringify({row,events,audits,expenses,receipts})
  try{return await fn(client)}catch(e){({row,events,audits,expenses,receipts}=JSON.parse(snapshot));throw e}
}}
stub('../../src/dbAdapter',adapter)
const pass=(_req:any,_res:any,next:any)=>next()
stub('../../src/auth',{requireAnyPerm:()=>pass,requireResourcePerm:()=>pass,userHasAnyPerm:async(user:any)=>user.role==='admin'||user.role==='offline_manager'})
stub('../../src/lib/maintenanceRuntimeSchema',{assertMaintenanceRuntimeSchemaReady:()=>{},isMaintenanceRuntimeSchemaReady:()=>true})
stub('../../src/services/workTaskEvents',{buildWorkTaskVisibilityHints:()=>({user_ids:[]}),emitWorkTaskEvent:async(e:any)=>{if(eventFailure)throw new Error('fixture_event_failure');events.push(e);return {eventId:'synthetic'}}})
stub('../../src/services/notificationEvents',{emitNotificationEvent:async()=>({sent:0})})
const crudPath=require.resolve('../../src/modules/crud')
const crud=require(crudPath).default
async function invoke(router:any,path:string,method:string,req:any) {
  const route=router.stack.find((s:any)=>s.route?.path===path&&s.route.methods[method]).route
  const res:any={statusCode:200,body:null,setHeader(){},status(n:number){this.statusCode=n;return this},json(v:any){this.body=v;return this}}
  await route.stack[route.stack.length-1].handle(req,res);return res
}
async function main(){
  // Actual PostgreSQL GET handler, including deep-only enrichment and source-read contract.
  let res=await invoke(crud,'/:resource','get',{params:{resource:'property_deep_cleaning'},query:{},user:{sub:'admin',role:'admin'}})
  assert.equal(res.statusCode,200,JSON.stringify(res.body));assert.equal(res.body[0].can_assign,true);assert.equal(res.body[0].pricing_mode,undefined)
  res=await invoke(crud,'/:resource/:id','get',{params:{resource:'property_deep_cleaning',id:row.id},query:{},user:{sub:'worker',role:'cleaner'}})
  assert.equal(res.statusCode,200,JSON.stringify(res.body));assert.deepEqual(res.body.available_actions,['complete'])
  // Existing CRUD read permission is already granted by the route middleware;
  // non-admin readers retain the same financial fields as before this workflow.
  row.total_cost=17
  for (const path of ['/:resource','/:resource/:id']) {
    res=await invoke(crud,path,'get',{params:{resource:'property_deep_cleaning',id:row.id},query:{},user:{sub:'manager',role:'offline_manager'}})
    assert.equal(res.statusCode,200)
    const read=Array.isArray(res.body) ? res.body[0] : res.body
    assert.equal(read.total_cost,17,'authorized CRUD read preserves existing record fields')
    assert.equal(read.can_review,false,'read permission never grants admin review')
  }
  row.total_cost=null
  for(const field of ['status','review_status','total_cost','assignee_id']){
    res=await invoke(crud,'/:resource/:id','patch',{params:{resource:'property_deep_cleaning',id:row.id},body:{[field]:'bypass'},user:{sub:'admin',role:'admin'}})
    assert.equal(res.statusCode,409)
  }
  // Stub accounting only, retaining actual domain route and receipt implementation.
  stub('../../src/modules/crud',{syncDeepCleaningReviewedExpenseWithClient:async(_c:any,r:any)=>{if(expenseFailure)throw new Error('fixture_expense_failure');expenses.push({id:r.id,total:r.total_cost})}})
  const router=require('../../src/modules/deep_cleaning_workflow').deepCleaningWorkflowRouter
  const run=(action:string,body:any,user:any={sub:'admin',role:'admin'})=>invoke(router,'/records/:id/workflow/:action','post',{params:{id:row.id,action},body,user})
  res=await run('assign',{operation_id:'assign-0001',assignee_id:'cs'});assert.equal(res.statusCode,400)
  res=await run('assign',{operation_id:'assign-finance',assignee_id:'finance'});assert.equal(res.statusCode,200)
  res=await run('assign',{operation_id:'assign-0002',assignee_id:'worker'});assert.equal(res.statusCode,200);assert.equal(row.total_cost,null)
  res=await run('complete',{operation_id:'complete-0001',completion_photo_urls:['mzapp/after.jpg']},{sub:'other',role:'cleaner'});assert.equal(res.statusCode,403)
  const completion={operation_id:'complete-0002',before_photo_urls:['mzapp/before.jpg','mzapp/before-extra.jpg'],completion_photo_urls:['mzapp/after.jpg']}
  res=await run('complete',{...completion,before_photo_urls:null},{sub:'worker',role:'cleaner'});assert.equal(res.statusCode,400)
  res=await run('complete',{...completion,before_photo_urls:[' file://x']},{sub:'worker',role:'cleaner'});assert.equal(res.statusCode,400)
  eventFailure=true;res=await run('complete',completion,{sub:'worker',role:'cleaner'});assert.equal(res.statusCode,500);assert.deepEqual(row.photo_urls,['mzapp/before.jpg']);eventFailure=false
  res=await run('complete',completion,{sub:'worker',role:'cleaner'});assert.equal(res.statusCode,200);assert.equal(row.status,'pending_review');assert.equal(expenses.length,0);assert.deepEqual(row.photo_urls,['mzapp/before.jpg','mzapp/before-extra.jpg']);assert.deepEqual(row.repair_photo_urls,['mzapp/after.jpg'])
  assert(!('deep_cleaning_workflow' in events.at(-1).patch),'actor capabilities must not be broadcast');assert.equal(events.at(-1).eventType,'TASK_UPDATED')
  res=await run('complete',completion,{sub:'worker',role:'cleaner'});assert.equal(res.statusCode,200,'receipt replay after state change')
  const review={...base,pricing_mode:'total',total_amount:100,operation_id:'review-00001'}
  res=await run('review',review,{sub:'manager',role:'offline_manager'});assert.equal(res.statusCode,403)
  res=await run('review',review,{sub:'manager',role:'admin'});assert.equal(res.statusCode,403,'fresh DB role beats stale token')
  eventFailure=true;res=await run('review',review);assert.equal(res.statusCode,500);assert.equal(row.status,'pending_review');assert.equal(expenses.length,0);assert.deepEqual(row.photo_urls,['mzapp/before.jpg','mzapp/before-extra.jpg']);assert.deepEqual(row.repair_photo_urls,['mzapp/after.jpg'])
  eventFailure=false;expenseFailure=true;res=await run('review',review);assert.equal(res.statusCode,500);assert.equal(row.status,'pending_review')
  expenseFailure=false;res=await run('review',review);assert.equal(res.statusCode,200,JSON.stringify(res.body));assert.equal(row.total_cost,100,'whole price does not add consumables');assert.equal(expenses.length,1)
  res=await run('review',review);assert.equal(res.statusCode,200);assert.equal(expenses.length,1)
  res=await run('review',{...review,total_amount:200});assert.equal(res.statusCode,409)
  res=await run('review',{...review,operation_id:'review-00002'});assert.equal(res.statusCode,409)
  res=await invoke(crud,'/:resource','get',{params:{resource:'property_deep_cleaning'},query:{},user:{sub:'admin',role:'admin'}})
  assert.equal(res.statusCode,200);assert.equal(res.body[0].pricing_mode,'total');assert.equal(res.body[0].total_amount,100);assert.deepEqual(res.body[0].available_actions,[])
  assert(!queries.some(q=>/^(CREATE|ALTER|DROP|TRUNCATE)/i.test(q.trim())))
  console.log('deep cleaning workflow offline actual-route contracts PASS')
}
main().catch(e=>{console.error(e);process.exitCode=1})
