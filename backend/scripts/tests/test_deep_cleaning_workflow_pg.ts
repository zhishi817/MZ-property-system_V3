import assert from 'node:assert/strict'
import net from 'node:net'
import path from 'node:path'
import os from 'node:os'
import { mkdtempSync, realpathSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

// Self-contained synthetic PostgreSQL only. Never accepts an existing database URL.
if (process.env.DATABASE_URL) throw new Error('run_with_cleared_environment')
const root = mkdtempSync(path.join(os.tmpdir(),'mz115-pg-'))
const data = path.join(root,'data')
const user = os.userInfo().username
const bin = '/opt/homebrew/opt/postgresql@16/bin'
const env = {PATH:process.env.PATH || '',HOME:root,LC_ALL:'C',LANG:'C'}
function command(name:string,args:string[]) {
  const result=spawnSync(path.join(bin,name),args,{env,encoding:'utf8'})
  if(result.status!==0)throw new Error(`${name}_failed:${result.stderr}`)
}
let pool:any;let appPool:any;let running=false
const pg=require('pg');const NativePool=pg.Pool
async function main(){
  const listener=net.createServer();await new Promise<void>(resolve=>listener.listen(0,'127.0.0.1',resolve));const port=(listener.address() as net.AddressInfo).port;await new Promise<void>(resolve=>listener.close(()=>resolve()))
  assert.notEqual(port,5432)
  command('initdb',['-D',data,'-A','trust','-U',user,'--no-locale'])
  assert(realpathSync(data).startsWith(realpathSync(os.tmpdir())+path.sep))
  command('pg_ctl',['-D',data,'-l',path.join(root,'server.log'),'-o',`-h 127.0.0.1 -p ${port} -k ${root}`,'-w','start']);running=true
  const originalConnect=net.Socket.prototype.connect
  net.Socket.prototype.connect=function(...args:any[]){let options=(net as any)._normalizeArgs(args)[0];while(Array.isArray(options))options=options[0];if(options.path||options.host!=='127.0.0.1'||Number(options.port)!==port)throw new Error('test_network_denied');return originalConnect.apply(this,args as any)} as any
  const connection=`postgresql://${encodeURIComponent(user)}@127.0.0.1:${port}/postgres`
  pool=new NativePool({connectionString:connection,ssl:false,max:6})
  const identity=(await pool.query("SELECT current_database() AS database,inet_server_addr()::text AS address,inet_server_port() AS port,current_setting('data_directory') AS data")).rows[0]
  assert.equal(identity.database,'postgres');assert.equal(identity.address.split('/')[0],'127.0.0.1');assert.equal(identity.port,port);assert.equal(realpathSync(identity.data),realpathSync(data))
  // The only database written is the just-created identity-verified cluster.
  await pool.query(`
    CREATE TABLE schema_migrations(version text PRIMARY KEY);
    INSERT INTO schema_migrations VALUES('20260903_maintenance_runtime_schema'),('20260902_r5_2a_core_task_schema');
    CREATE TABLE users(id text PRIMARY KEY,role text,username text,display_name text);
    CREATE TABLE user_roles(user_id text,role_name text);
    INSERT INTO users VALUES('admin','admin','Admin','Admin'),('worker','cleaner','Worker','Worker'),('other','cleaner','Other','Other'),('manager','offline_manager','Manager','Manager'),('finance','finance','Finance','Finance'),('cs','customer_service','CS','CS'),('mixed','admin','Mixed','Mixed'),('no-role',NULL,'NoRole','NoRole'),('owner','owner','Owner','Owner'),('hr','hr','HR','HR');
    INSERT INTO user_roles VALUES('mixed','customer_service');
    CREATE TABLE properties(id text PRIMARY KEY,code text,address text);
    INSERT INTO properties VALUES('property','SYNTHETIC','Synthetic fixture');
    CREATE TABLE property_deep_cleaning(id text PRIMARY KEY,property_id text,property_code text,occurred_at date,status text,assignee_id text,worker_name text,eta date,photo_urls jsonb,repair_photo_urls jsonb,repair_notes text,review_status text,total_cost numeric,labor_cost numeric,consumables jsonb,pay_method text,gst_type text,reviewed_by text,reviewed_at timestamptz,review_notes text,completed_at timestamptz,created_at timestamptz DEFAULT now(),updated_at timestamptz,deleted_at timestamptz,project_desc text,details text,work_no text,urgency text,notes text,submitted_at timestamptz,submitter_name text,created_by text,created_by_user_id text,attachment_urls jsonb,source_task_id text,client_item_id text,started_at timestamptz,ended_at timestamptz,duration_minutes integer,category text,checklist jsonb,labor_minutes integer);
    CREATE TABLE cleaning_tasks(id text,property_id text,cleaner_id text,inspector_id text,assignee_id text,status text,execution_state text);
    CREATE TABLE work_task_participants(source_type text,source_id text,user_id text,source_relation text,action_ids jsonb);
    CREATE TABLE work_task_action_audits(source_type text,source_id text,performed_by_user_id text,actor_user_id text,performed_as_action text,metadata jsonb,status_after text);
    INSERT INTO cleaning_tasks VALUES('origin-task','property','manager',NULL,NULL,'pending','active');
    CREATE TABLE work_tasks(id text PRIMARY KEY,task_kind text,source_type text,source_id text,property_id text,title text,summary text,scheduled_date date,assignee_id text,status text,urgency text,photo_urls jsonb,completion_photo_urls jsonb,completion_note text,created_at timestamptz,updated_at timestamptz,UNIQUE(source_type,source_id));
    CREATE TABLE app_submit_receipts(id text PRIMARY KEY,scope_type text,scope_id text,submit_id text,step_key text,payload_hash text,response_json jsonb,created_at timestamptz,updated_at timestamptz,UNIQUE(scope_type,scope_id,submit_id,step_key));
    CREATE TABLE work_task_event_versions(task_id text PRIMARY KEY,last_version bigint,updated_at timestamptz DEFAULT now());
    CREATE SEQUENCE work_task_events_sequence_no_seq;
    CREATE TABLE work_task_events(id text PRIMARY KEY,event_id text UNIQUE,sequence_no bigint UNIQUE,task_id text,task_version bigint,source_type text,source_ref_ids text[],event_type text,change_scope text,changed_fields text[],payload jsonb,occurred_at timestamptz,caused_by_user_id text,visibility_hints jsonb,created_at timestamptz DEFAULT now());
    CREATE TABLE property_expenses(id text PRIMARY KEY,property_id text,occurred_at date,amount numeric,currency text,category text,category_detail text,note text,pay_method text,generated_from text,ref_type text,ref_id text,month_key text,due_date date,is_auto boolean,source_title text,source_summary text,status text,manual_override boolean);
    CREATE TABLE company_expenses(LIKE property_expenses INCLUDING ALL);
    CREATE UNIQUE INDEX property_expense_ref ON property_expenses(ref_type,ref_id) WHERE ref_type IS NOT NULL AND ref_id IS NOT NULL;
    CREATE UNIQUE INDEX company_expense_ref ON company_expenses(ref_type,ref_id) WHERE ref_type IS NOT NULL AND ref_id IS NOT NULL;
    CREATE TABLE maintenance_workflow_events(maintenance_domain text,record_id text,to_status text,event_type text);
    CREATE TABLE audit_logs(id text PRIMARY KEY,entity text,entity_id text,action text,actor_id text,before_json jsonb,after_json jsonb,created_at timestamptz);
    CREATE TABLE failure_fixture(name text PRIMARY KEY);
    CREATE FUNCTION fixture_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS(SELECT 1 FROM failure_fixture WHERE name=TG_TABLE_NAME) THEN RAISE EXCEPTION 'synthetic_failure';END IF;RETURN NEW;END $$;
    CREATE TRIGGER fail_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION fixture_fail();
    CREATE TRIGGER fail_event BEFORE INSERT ON work_task_events FOR EACH ROW EXECUTE FUNCTION fixture_fail();
    CREATE TRIGGER fail_expense BEFORE INSERT ON company_expenses FOR EACH ROW EXECUTE FUNCTION fixture_fail();
    CREATE TRIGGER fail_receipt BEFORE INSERT ON app_submit_receipts FOR EACH ROW EXECUTE FUNCTION fixture_fail();
  `)
  let applicationDdlAttempts=0
  class LocalOnlyPool extends NativePool{constructor(config:any){assert.equal(config.connectionString,connection);super({...config,ssl:false});this.on('connect',(client:any)=>{const original=client.query.bind(client);client.query=(query:any,...args:any[])=>{const sql=typeof query==='string'?query:query?.text || '';if (/^\s*(CREATE|ALTER|DROP|TRUNCATE)\b/i.test(sql)){applicationDdlAttempts++;throw new Error('application_ddl_forbidden_in_test')}return original(query,...args)}})}}
  pg.Pool=LocalOnlyPool;process.env.DATABASE_URL=connection
  const authKey=require.resolve('../../src/auth');const pass=(_r:any,_s:any,next:any)=>next();require.cache[authKey]={id:authKey,filename:authKey,loaded:true,exports:{userHasAnyPerm:async(u:any)=>['admin','offline_manager'].includes(u.role),requirePerm:()=>pass,requireAnyPerm:()=>pass,requireResourcePerm:()=>pass}} as any
  const adapter=require('../../src/dbAdapter');appPool=adapter.pgPool
  await require('../../src/lib/maintenanceRuntimeSchema').warmupMaintenanceRuntimeSchema()
  await require('../../src/lib/r5RequestSchema').warmupR5TaskRuntimeSchema()
  let notices=0
  require('../../src/modules/mzapp').notifyPropertyFeedbackCreated=async()=>{notices++}
  require('../../src/services/notificationEvents').emitNotificationEvent=async()=>({sent:0})
  const router=require('../../src/modules/deep_cleaning_workflow').deepCleaningWorkflowRouter
  const handler=router.stack.find((s:any)=>s.route?.path==='/records/:id/workflow/:action').route.stack[0].handle
  const call=async(id:string,action:string,body:any,actor='admin',role?:string)=>{const res:any={statusCode:200,status(n:number){this.statusCode=n;return this},json(v:any){this.body=v;return this}};await handler({params:{id,action},body,user:{sub:actor,role:role|| (actor==='admin'?'admin':actor==='manager'?'offline_manager':'cleaner')}},res);return res}
  const seed=async(id:string,status='assigned')=>pool.query(`INSERT INTO property_deep_cleaning(id,property_id,occurred_at,status,assignee_id,photo_urls,repair_photo_urls,consumables,review_status) VALUES($1,'property','2026-11-12',$2,'worker','["mzapp/before.jpg"]','[]','[{"cost":999}]','pending')`,[id,status])
  const snapshot=async(id:string)=>(await pool.query('SELECT * FROM property_deep_cleaning WHERE id=$1',[id])).rows[0]
  const count=async(table:string)=>(await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n
  const complete={operation_id:'complete-0001',completion_photo_urls:['mzapp/after.jpg']}
  const review={operation_id:'review-00001',pricing_mode:'total',total_amount:123.45,pay_method:'company_pay',gst_type:'GST_INCLUDED_10'}
  const newId='11111111-1111-4111-8111-111111111111'
  const report={operation_id:'report-00001',assignee_id:'worker',completion_photo_urls:['mzapp/after.jpg'],initial_report:{property_id:'property',areas:['厨房'],detail:'Synthetic completed report',photo_urls:['mzapp/before.jpg'],client_item_id:'report-client-1'},started_at:'2026-11-12T00:00:00Z',ended_at:'2026-11-12T01:00:00Z'}
  assert.equal((await call(newId,'record_complete',report,'worker')).statusCode,403)
  await pool.query("INSERT INTO failure_fixture VALUES('work_task_events')")
  assert.equal((await call(newId,'record_complete',report,'manager')).statusCode,500)
  assert.equal(await snapshot(newId),undefined,'new report rolls back with failed event')
  await pool.query('DELETE FROM failure_fixture')
  let recorded=await call(newId,'record_complete',report,'manager');assert.equal(recorded.statusCode,200,JSON.stringify(recorded.body));assert.equal((await snapshot(newId)).status,'pending_review');assert.equal((await snapshot(newId)).assignee_id,'worker');assert.equal((await snapshot(newId)).duration_minutes,60)
  assert.equal((await call(newId,'record_complete',report,'manager')).statusCode,200);assert.equal(notices,1,'report notice only after commit and not on replay')
  assert.equal((await call('22222222-2222-4222-8222-222222222222','record_complete',report,'manager')).statusCode,409,'stable client item cannot create duplicate report under another id')
  await seed('checkpoint','pending')
  assert.equal((await call('checkpoint','record_complete',{operation_id:'checkpoint-001',assignee_id:'other',completion_photo_urls:['mzapp/after.jpg']},'manager')).statusCode,200)
  assert.equal((await snapshot('checkpoint')).assignee_id,'other')
  await seed('existing-time')
  await pool.query("UPDATE property_deep_cleaning SET started_at='2026-11-12T00:00:00Z',ended_at='2026-11-12T02:00:00Z' WHERE id='existing-time'")
  assert.equal((await call('existing-time','complete',{...complete,started_at:{value:'invalid'}},'worker')).statusCode,400)
  assert.equal((await call('existing-time','complete',complete,'worker')).statusCode,200,'existing DB Date time works when omitted from request')
  assert.equal((await snapshot('existing-time')).duration_minutes,120)
  await seed('before-phase')
  const beforeComplete={...complete,before_photo_urls:['mzapp/before.jpg','mzapp/before-added.jpg','mzapp/before-added.jpg']}
  assert.equal((await call('before-phase','complete',beforeComplete,'other')).statusCode,403)
  for (const value of [null,'bad',[null],['file:///local'],['data:image/x'],[' file://x'],['\tdata:image/x'],[' blob:x']]) assert.equal((await call('before-phase','complete',{...complete,before_photo_urls:value},'worker')).statusCode,400)
  const phaseProjectionBefore=(await pool.query("SELECT * FROM work_tasks WHERE source_id='before-phase'")).rows
  const phaseReceiptCount=await count('app_submit_receipts')
  for (const legacy of [{unexpected:true},[null],[''],[' file://old'],'not-json','null']) {
    await pool.query("UPDATE property_deep_cleaning SET photo_urls=$1::jsonb WHERE id='before-phase'",[JSON.stringify(legacy)])
    const invalidOriginal=await snapshot('before-phase')
    assert.equal((await call('before-phase','complete',beforeComplete,'worker')).statusCode,409)
    assert.deepEqual(await snapshot('before-phase'),invalidOriginal)
    assert.deepEqual((await pool.query("SELECT * FROM work_tasks WHERE source_id='before-phase'")).rows,phaseProjectionBefore)
    assert.equal(await count('app_submit_receipts'),phaseReceiptCount)
  }
  await pool.query("UPDATE property_deep_cleaning SET photo_urls=$1::jsonb WHERE id='before-phase'",[JSON.stringify(['mzapp/before.jpg'])])
  const beforePhaseOriginal=await snapshot('before-phase')
  for (const table of ['work_task_events','app_submit_receipts']) {
    await pool.query('INSERT INTO failure_fixture VALUES($1)',[table])
    assert.equal((await call('before-phase','complete',beforeComplete,'worker')).statusCode,500)
    assert.deepEqual(await snapshot('before-phase'),beforePhaseOriginal,'before evidence rolls back with failed completion')
    await pool.query('DELETE FROM failure_fixture')
  }
  const beforePhaseRes=await call('before-phase','complete',beforeComplete,'worker')
  assert.equal(beforePhaseRes.body.media_access_work_task_id,'property_deep_cleaning:before-phase')
  assert.equal(beforePhaseRes.statusCode,200);assert.deepEqual(beforePhaseRes.body.photo_urls,['mzapp/before.jpg','mzapp/before-added.jpg']);assert.deepEqual(beforePhaseRes.body.repair_photo_urls,['mzapp/after.jpg'])
  assert.deepEqual((await pool.query("SELECT photo_urls,completion_photo_urls FROM work_tasks WHERE source_id='before-phase'")).rows[0],{photo_urls:['mzapp/before.jpg','mzapp/before-added.jpg'],completion_photo_urls:['mzapp/after.jpg']})
  assert.equal((await call('before-phase','complete',beforeComplete,'worker')).statusCode,200)
  assert.equal((await call('before-phase','complete',{...beforeComplete,before_photo_urls:['mzapp/conflict.jpg']},'worker')).statusCode,409)
  assert.equal((await call('before-phase','complete',{...beforeComplete,operation_id:'before-second-001'},'worker')).statusCode,409)
  for (const [id,stored] of [['legacy-json-before',JSON.stringify([' mzapp/legacy.jpg '])],['null-before',null],['empty-before','']] as const) {
    await seed(id);await pool.query('UPDATE property_deep_cleaning SET photo_urls=$2::jsonb WHERE id=$1',[id,JSON.stringify(stored)])
    const saved=await call(id,'complete',{...complete,before_photo_urls:['mzapp/added.jpg']},'worker')
    assert.equal(saved.statusCode,200,JSON.stringify(saved.body))
    assert.deepEqual(saved.body.photo_urls,id==='legacy-json-before'?[' mzapp/legacy.jpg ','mzapp/added.jpg']:['mzapp/added.jpg'])
  }
  await seed('main')
  assert.equal((await call('main','assign',{operation_id:'assign-00001',assignee_id:'cs'})).statusCode,400)
  assert.equal((await call('main','assign',{operation_id:'assign-00002',assignee_id:'worker'})).statusCode,200)
  assert.equal((await snapshot('main')).total_cost,null)
  assert.equal((await call('main','complete',complete,'other')).statusCode,403)
  let res=await call('main','complete',complete,'worker');assert.equal(res.statusCode,200,JSON.stringify(res.body));assert.equal((await snapshot('main')).status,'pending_review');assert.equal(await count('company_expenses'),0);assert.equal(res.body.consumables,undefined);assert.equal(res.body.total_cost,undefined)
  assert.equal((await call('main','review',review,'manager')).statusCode,403)
  assert.equal((await call('main','review',review,'manager','admin')).statusCode,403)
  await seed('downgrade')
  await pool.query("UPDATE property_deep_cleaning SET assignee_id='admin',total_cost=99,pay_method='company_pay' WHERE id='downgrade'")
  assert.equal((await call('downgrade','complete',complete,'admin')).body.total_cost,'99')
  await pool.query("UPDATE users SET role='cleaner' WHERE id='admin'")
  const downgraded=await call('downgrade','complete',complete,'admin','admin')
  assert.equal(downgraded.statusCode,200);assert.equal(downgraded.body.total_cost,undefined);assert.equal(downgraded.body.pay_method,undefined)
  await pool.query("UPDATE users SET role='admin' WHERE id='admin'")
  const before=await snapshot('main');const eventCount=await count('work_task_events');const receiptCount=await count('app_submit_receipts')
  for(const table of ['company_expenses','work_task_events','app_submit_receipts','audit_logs']){
    await pool.query('INSERT INTO failure_fixture VALUES($1)',[table]);res=await call('main','review',review);assert.equal(res.statusCode,500,JSON.stringify(res.body));assert.deepEqual(await snapshot('main'),before);assert.equal(await count('company_expenses'),0);assert.equal(await count('work_task_events'),eventCount);assert.equal(await count('app_submit_receipts'),receiptCount);await pool.query('DELETE FROM failure_fixture')
  }
  const concurrent=await Promise.all([call('main','review',review),call('main','review',review)])
  concurrent.forEach(r=>assert.equal(r.statusCode,200,JSON.stringify(r.body)))
  assert.equal(await count('company_expenses'),1);assert.equal((await snapshot('main')).total_cost,'123.45')
  assert.equal((await call('main','review',{...review,total_amount:500})).statusCode,409)
  assert.equal((await call('main','review',{...review,operation_id:'review-00002'})).statusCode,409)
  await seed('items');await call('items','complete',complete,'worker')
  res=await call('items','review',{operation_id:'items-00001',pricing_mode:'items',price_items:[{id:'a',description:'Kitchen',amount:20},{id:'b',description:'Bath',amount:30}],pay_method:'landlord_pay',gst_type:'INPUT_TAXED'})
  assert.equal(res.statusCode,200,JSON.stringify(res.body));assert.equal((await snapshot('items')).total_cost,'50');assert.equal(await count('property_expenses'),1)
  await seed('zero');await call('zero','complete',complete,'worker');assert.equal((await call('zero','review',{...review,total_amount:null})).statusCode,400);assert.equal((await call('zero','review',{...review,total_amount:0})).statusCode,200);assert.equal(await count('company_expenses'),1)
  await seed('legacy','completed');await pool.query("UPDATE property_deep_cleaning SET assignee_id=NULL WHERE id='legacy'");assert.equal((await call('legacy','review',{...review,assignee_id:'other'})).statusCode,200);assert.equal((await snapshot('legacy')).assignee_id,'other')
  await seed('override');await call('override','complete',complete,'worker');await pool.query("INSERT INTO company_expenses(id,ref_type,ref_id,manual_override,amount) VALUES('manual','deep_cleaning','override',true,9)");assert.equal((await call('override','review',review)).statusCode,400);assert.equal((await snapshot('override')).status,'pending_review')
  const event=(await pool.query("SELECT payload,event_type FROM work_task_events WHERE source_ref_ids=ARRAY['main']::text[] ORDER BY sequence_no DESC LIMIT 1")).rows[0];assert.equal(event.payload.deep_cleaning_review,undefined,'SSE never carries review price');const audit=(await pool.query("SELECT after_json FROM audit_logs WHERE entity_id='main' AND action='deep_cleaning_review'")).rows[0];assert.equal(audit.after_json.deep_cleaning_review.total_amount,123.45);assert(!event.payload.patch.deep_cleaning_workflow)
  await pool.query("UPDATE work_tasks SET id='actual-legacy-projection' WHERE source_type='property_deep_cleaning' AND source_id='before-phase'")
  assert.equal((await call('before-phase','complete',beforeComplete,'worker')).body.media_access_work_task_id,'actual-legacy-projection','receipt reads actual projected id, never guesses')
  const contextHelper=require('../../src/lib/deepCleaningWorkflow').deepCleaningMediaContexts
  await pool.query("UPDATE work_tasks SET property_id='wrong' WHERE id='actual-legacy-projection'")
  assert.equal((await contextHelper(pool,[await snapshot('before-phase')])).get('before-phase'),undefined)
  await pool.query("UPDATE work_tasks SET property_id='property' WHERE id='actual-legacy-projection'")
  const dto=await require('../../src/lib/deepCleaningWorkflow').enrichDeepCleaningWorkflowRows(pool,[await snapshot('main')],{sub:'admin',role:'admin'},true);assert.equal(dto[0].pricing_mode,'total');assert.deepEqual(dto[0].available_actions,[])
  const recoveryHandler=router.stack.find((s:any)=>s.route?.path==='/records/:id/recovery-context').route.stack[0].handle
  const recover=async(actor:string,source='origin-task')=>{const res:any={statusCode:200,status(n:number){this.statusCode=n;return this},json(v:any){this.body=v;return this}};await recoveryHandler({params:{id:newId},query:{source_task_id:source},user:{sub:actor,role:'offline_manager'}},res);return res}
  await pool.query("UPDATE property_deep_cleaning SET source_task_id='origin-task' WHERE id=$1",[newId])
  const recovery=await recover('manager');assert.equal(recovery.statusCode,200,JSON.stringify(recovery.body));assert.equal(recovery.body.can_resume,false);assert.deepEqual(recovery.body.completion_photo_urls,['mzapp/after.jpg']);assert.equal(recovery.body.total_cost,undefined)
  assert.equal((await recover('admin')).statusCode,404);assert.equal((await recover('worker')).statusCode,403);assert.equal((await recover('manager','wrong')).statusCode,403)
  const crud = require('../../src/modules/crud').default
  const createHandler=crud.stack.find((s:any)=>s.route?.path==='/:resource' && s.route.methods.post).route.stack.at(-1).handle
  const create=async(id:string)=>{const res:any={statusCode:200,setHeader(){},status(n:number){this.statusCode=n;return this},json(v:any){this.body=v;return this}};await createHandler({params:{resource:'property_deep_cleaning'},body:{id,property_id:'property',occurred_at:'2026-11-12',project_desc:'Generic pending'},user:{sub:'admin',role:'admin'},headers:{}},res);return res}
  await pool.query("INSERT INTO failure_fixture VALUES('audit_logs')")
  assert.equal((await create('create-rollback')).statusCode,500);assert.equal(await snapshot('create-rollback'),undefined)
  await pool.query('DELETE FROM failure_fixture')
  const created=await create('generic-created');assert.equal(created.statusCode,201,JSON.stringify(created.body));assert.equal((await snapshot('generic-created')).total_cost,null)
  const patchHandler = crud.stack.find((s:any)=>s.route?.path==='/:resource/:id' && s.route.methods.patch).route.stack.at(-1).handle
  const patch = async(id:string,body:any)=>{const res:any={statusCode:200,setHeader(){},status(n:number){this.statusCode=n;return this},json(v:any){this.body=v;return this}};await patchHandler({params:{resource:'property_deep_cleaning',id},body,user:{sub:'admin',role:'admin'},headers:{}},res);return res}
  assert.equal((await patch('main',{property_id:'another'})).statusCode,409)
  assert.equal((await patch('main',{occurred_at:'2026-12-01'})).statusCode,409)
  const expenseBefore=(await pool.query('SELECT * FROM company_expenses ORDER BY id')).rows
  let edited=await patch('main',{details:'content only',repair_notes:'Updated note'});assert.equal(edited.statusCode,200,JSON.stringify(edited.body))
  assert.deepEqual((await pool.query('SELECT * FROM company_expenses ORDER BY id')).rows,expenseBefore)
  await seed('fresh','pending');await pool.query("UPDATE property_deep_cleaning SET assignee_id=NULL,consumables='[]'::jsonb WHERE id='fresh'")
  assert.equal((await patch('fresh',{property_id:'another'})).statusCode,200)
  assert.equal((await snapshot('fresh')).property_id,'another')
  const managerDto=require('../../src/lib/deepCleaningWorkflow').deepCleaningWorkflowResponse({...await snapshot('main'),invoice_description_en:'secret',checklist:[{amount:8}]},{sub:'manager',role:'offline_manager'},true)
  for(const key of ['total_cost','pay_method','invoice_description_en','checklist']) assert.equal(managerDto[key],undefined)
  const executorHandler=router.stack.find((s:any)=>s.route?.path==='/executors').route.stack[0].handle
  const executorRes:any={statusCode:200,status(n:number){this.statusCode=n;return this},json(v:any){this.body=v;return this}}
  await executorHandler({user:{sub:'admin',role:'admin'}},executorRes)
  assert.equal(executorRes.statusCode,200)
  for(const id of ['finance','no-role','owner','hr','admin','worker']) assert(executorRes.body.some((u:any)=>u.id===id))
  for(const id of ['cs','mixed']) assert(!executorRes.body.some((u:any)=>u.id===id))
  await seed('finance-execution')
  assert.equal((await call('finance-execution','assign',{operation_id:'finance-assign-1',assignee_id:'finance'})).statusCode,200)
  assert.equal((await call('finance-execution','complete',complete,'finance')).statusCode,200)
  assert.equal((await call('finance-execution','review',review,'finance')).statusCode,403)
  for(const actor of ['no-role','owner','hr']) { await seed(`execute-${actor}`);assert.equal((await call(`execute-${actor}`,'assign',{operation_id:`assign-${actor}-001`,assignee_id:actor})).statusCode,200);assert.equal((await call(`execute-${actor}`,'complete',complete,actor)).statusCode,200);assert.equal((await call(`execute-${actor}`,'review',review,actor)).statusCode,403) }
  await seed('mixed-reject')
  assert.equal((await call('mixed-reject','assign',{operation_id:'mixed-assign-1',assignee_id:'mixed'})).statusCode,400)
  assert.equal((await call('mixed-reject','record_complete',{operation_id:'mixed-record-1',assignee_id:'mixed',completion_photo_urls:['mzapp/after.jpg']},'manager')).statusCode,400)
  await pool.query("UPDATE property_deep_cleaning SET status='completed',review_status='pending',assignee_id=NULL WHERE id='mixed-reject'")
  assert.equal((await call('mixed-reject','review',{...review,assignee_id:'mixed'})).statusCode,400)
  const validateUsers=require('../../src/modules/task_center').lockAndValidateTaskCenterAssignmentUsers
  await validateUsers(pool,[],[],['finance','owner','no-role'])
  await assert.rejects(()=>validateUsers(pool,[],[],['cs']),/task_assignee_invalid/)
  await assert.rejects(()=>validateUsers(pool,[],[],['mixed']),/task_assignee_invalid/)
  await assert.rejects(()=>validateUsers(pool,['finance'],[],[]),/task_assignee_invalid/,'other or unknown task types keep shared finance exclusion')
  await assert.rejects(()=>validateUsers(pool,['finance'],[],['finance']),/task_assignee_invalid/,'mixed batch cannot exempt finance from ordinary task rule')
  await assert.rejects(()=>validateUsers(pool,[],[],['missing']),/task_assignee_invalid/,'missing users fail closed')
  await seed('finance-existing');await pool.query("UPDATE property_deep_cleaning SET assignee_id='finance' WHERE id='finance-existing'");assert.equal((await call('finance-existing','complete',complete,'finance')).statusCode,200)
  const publicRouter=require('../../src/modules/public').default
  const publicPatchHandler=publicRouter.stack.find((s:any)=>s.route?.path==='/deep-cleaning-share/:token' && s.route.methods.patch).route.stack[0].handle
  const shareToken='synthetic-share-token'
  const shareHash=require('crypto').createHash('sha256').update(shareToken).digest('hex')
  const shareJwt=require('jsonwebtoken').sign({scope:'deep_cleaning_share',deep_cleaning_id:'main',token_hash:shareHash},'dev-secret',{expiresIn:'1h'})
  await pool.query("CREATE TABLE public_access(area text,password_hash text,password_updated_at timestamptz);INSERT INTO public_access VALUES('deep_cleaning_share','synthetic',now()-interval '1 day');CREATE TABLE deep_cleaning_share_links(token_hash text,deep_cleaning_id text,revoked_at timestamptz,expires_at timestamptz)")
  await pool.query("INSERT INTO deep_cleaning_share_links VALUES($1,'main',NULL,now()+interval '1 day')",[shareHash])
  const share=async(body:any,jwt=shareJwt,token=shareToken)=>{const res:any={statusCode:200,status(n:number){this.statusCode=n;return this},json(v:any){this.body=v;return this}};await publicPatchHandler({params:{token},headers:{authorization:`Bearer ${jwt}`},body},res);return res}
  assert.equal((await share({notes:'safe'},'invalid')).statusCode,401)
  assert.equal((await share({notes:'safe'},shareJwt,'wrong')).statusCode,401)
  assert.equal((await share({total_cost:999})).statusCode,409)
  assert.equal((await share({status:'pending_review'})).statusCode,409,'approved cannot reopen')
  await pool.query("UPDATE property_deep_cleaning SET labor_cost=12.50 WHERE id='main'")
  assert.equal((await share({labor_cost:12.5})).statusCode,200,'PG numeric scale preserves unchanged historical value')
  const publicBefore=await snapshot('main')
  const publicResult=await share({notes:'Public evidence',total_cost:publicBefore.total_cost,labor_cost:publicBefore.labor_cost,status:publicBefore.status})
  assert.equal(publicResult.statusCode,200,JSON.stringify(publicResult.body));assert.equal((await snapshot('main')).total_cost,publicBefore.total_cost)
  assert.deepEqual((await pool.query('SELECT * FROM company_expenses ORDER BY id')).rows,expenseBefore)
  await pool.query("UPDATE property_deep_cleaning SET review_status='pending',status='completed' WHERE id='main'")
  assert.equal((await share({notes:'legacy evidence',status:'completed'})).statusCode,200);assert.equal((await snapshot('main')).status,'completed')
  await pool.query("UPDATE property_deep_cleaning SET status='assigned' WHERE id='main'")
  assert.equal((await share({status:'completed'})).statusCode,200);assert.equal((await snapshot('main')).status,'pending_review')
  await pool.query("UPDATE deep_cleaning_share_links SET revoked_at=now()")
  assert.equal((await share({notes:'revoked'})).statusCode,404)
  await pool.query('ALTER TABLE audit_logs RENAME TO audit_logs_unavailable')
  await seed('schema-missing')
  const missingResult=await call('schema-missing','complete',complete,'worker')
  // Complete does not depend on private price audit; review fails closed, without DDL.
  assert.equal(missingResult.statusCode,200)
  assert.equal((await call('schema-missing','review',review)).statusCode,503)
  assert.equal((await snapshot('schema-missing')).status,'pending_review')
  await pool.query('ALTER TABLE audit_logs_unavailable RENAME TO audit_logs')
  await pool.query('ALTER TABLE property_deep_cleaning ALTER COLUMN photo_urls TYPE text[] USING ARRAY[photo_urls->>0], ALTER COLUMN attachment_urls TYPE text[] USING ARRAY[]::text[], ALTER COLUMN repair_photo_urls TYPE text[] USING ARRAY[repair_photo_urls->>0]')
  const textId='33333333-3333-4333-8333-333333333333'
  const textResult=await call(textId,'record_complete',{...report,initial_report:{...report.initial_report,client_item_id:'text-array'}},'manager')
  assert.equal(textResult.statusCode,200,JSON.stringify(textResult.body));assert.deepEqual((await snapshot(textId)).photo_urls,['mzapp/before.jpg']);assert.deepEqual(textResult.body.repair_photo_urls,['mzapp/after.jpg'])
  const textCreated=await create('generic-text-array');assert.equal(textCreated.statusCode,201,JSON.stringify(textCreated.body));assert.deepEqual((await snapshot('generic-text-array')).photo_urls,[])
  await pool.query("UPDATE property_deep_cleaning SET status='assigned',assignee_id='worker' WHERE id='generic-text-array'")
  const textComplete=await call('generic-text-array','complete',{...complete,before_photo_urls:['mzapp/text-before.jpg']},'worker')
  assert.equal(textComplete.statusCode,200,JSON.stringify(textComplete.body));assert.deepEqual(textComplete.body.photo_urls,['mzapp/text-before.jpg']);assert.deepEqual(textComplete.body.repair_photo_urls,['mzapp/after.jpg'])
  await pool.query("INSERT INTO public_access VALUES('deep_cleaning_upload','synthetic',now()-interval '1 day')")
  const uploadJwt=require('jsonwebtoken').sign({scope:'deep_cleaning_upload'},'dev-secret',{expiresIn:'1h'})
  const uploadSubmit=publicRouter.stack.find((s:any)=>s.route?.path==='/deep-cleaning-upload/submit').route.stack[0].handle
  const uploadRes:any={statusCode:200,status(n:number){this.statusCode=n;return this},json(v:any){this.body=v;return this}}
  const publicUploadRequest= {headers:{authorization:`Bearer ${uploadJwt}`},body:{property_id:'property',worker_name:'Reported Name',details:[{project_desc:'Text array public',started_at:'2026-11-12T00:00:00Z',ended_at:'2026-11-12T01:00:00Z',pre_photo_urls:['mzapp/before.jpg'],post_photo_urls:['mzapp/after.jpg']}]}}
  const beforeUploadCount=await count('property_deep_cleaning')
  await pool.query("INSERT INTO failure_fixture VALUES('audit_logs')")
  await uploadSubmit(publicUploadRequest,uploadRes);assert.equal(uploadRes.statusCode,500);assert.equal(await count('property_deep_cleaning'),beforeUploadCount)
  await pool.query('DELETE FROM failure_fixture')
  await pool.query(`CREATE FUNCTION fail_second_public() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.project_desc='second item fails' THEN RAISE EXCEPTION 'synthetic_second_item';END IF;RETURN NEW;END $$;CREATE TRIGGER fail_second_public BEFORE INSERT ON property_deep_cleaning FOR EACH ROW EXECUTE FUNCTION fail_second_public()`)
  await uploadSubmit({...publicUploadRequest,body:{...publicUploadRequest.body,details:[...publicUploadRequest.body.details,{...publicUploadRequest.body.details[0],project_desc:'second item fails'}]}},uploadRes)
  assert.equal(uploadRes.statusCode,500);assert.equal(await count('property_deep_cleaning'),beforeUploadCount,'second item failure rolls back first item and audit')
  await uploadSubmit(publicUploadRequest,uploadRes)
  assert.equal(uploadRes.statusCode,201,JSON.stringify(uploadRes.body));const publicCreated=await snapshot(uploadRes.body.ids[0]);assert.equal(publicCreated.review_status,'pending');assert.equal(publicCreated.total_cost,null);assert.equal(publicCreated.assignee_id,null)
  // Real writes, not read-only labels: Web creator, mobile submitter, executor and reviewer stay distinct.
  const identityFields = (row:any) => ({submitter_name:row.submitter_name,created_by:row.created_by,created_by_user_id:row.created_by_user_id})
  const webIdentity = identityFields(await snapshot('generic-created'))
  assert.deepEqual(webIdentity,{submitter_name:null,created_by:'admin',created_by_user_id:null})
  const mobileIdentity = identityFields(await snapshot(newId))
  assert.deepEqual(mobileIdentity,{submitter_name:'Manager',created_by:'manager',created_by_user_id:'manager'})
  assert.equal((await snapshot(newId)).assignee_id,'worker','mobile authenticated submitter differs from selected cleaner')
  assert.equal((await call('generic-created','assign',{operation_id:'submitter-assign-1',assignee_id:'other'})).statusCode,200)
  assert.deepEqual(identityFields(await snapshot('generic-created')),webIdentity)
  assert.equal((await call('generic-created','complete',complete,'other')).statusCode,200)
  assert.deepEqual(identityFields(await snapshot('generic-created')),webIdentity)
  for (const [id,original] of [['generic-created',webIdentity],[newId,mobileIdentity]] as const) {
    const reviewed=await call(id,'review',{...review,operation_id:'submitter-review-1',total_amount:0})
    assert.equal(reviewed.statusCode,200,JSON.stringify(reviewed.body))
    const saved=await snapshot(id)
    assert.deepEqual(identityFields(saved),original,'review never rewrites submitting identity')
    assert.equal(saved.reviewed_by,'admin','reviewer identity is separate from mobile submitter and executor')
    assert.notEqual(saved.assignee_id,saved.reviewed_by)
    assert.equal((await patch(id,{notes:'submitter-preserving edit'})).statusCode,200)
    assert.deepEqual(identityFields(await snapshot(id)),original,'ordinary edit preserves original identity')
    const refreshed=(await require('../../src/lib/deepCleaningWorkflow').enrichDeepCleaningWorkflowRows(pool,[await snapshot(id)],{sub:'admin',role:'admin'},true))[0]
    assert.equal(refreshed.submitter_name,original.submitter_name)
    assert.equal(refreshed.submitter_display_name,id===newId?'Manager':'Admin')
    assert.equal(refreshed.submitter_display_source,id===newId?'recorded':'created_by')
  }
  assert.equal(applicationDdlAttempts,0,'application routes never execute runtime DDL')
  await adapter.pgPool.end();appPool=null
  console.log('PASS real PostgreSQL deep-cleaning route: authorization, optional price, pending review, total/items/zero, concurrent replay, expense/event/receipt rollback, legacy and manual override; no production access')
}
main().finally(async()=>{if(appPool)await appPool.end();if(pool)await pool.end();if(running)command('pg_ctl',['-D',data,'-m','fast','-w','stop'])}).catch(e=>{console.error(e);process.exitCode=1})
