'use strict'
const assert=require('node:assert/strict')
const fs=require('node:fs')
const path=require('node:path')
const [front,back,out]=process.argv.slice(2,5).map(x=>path.resolve(x))
const key=process.env.MZ124_PILOT_KEY
assert(key?.length>=32 && out.startsWith('/tmp/'),'pilot key and private temporary output required')
const {chromium}=require(path.join(front,'node_modules/playwright'))
const jwt=require(path.join(back,'node_modules/jsonwebtoken'))
const web='http://127.0.0.1:43171', api='http://127.0.0.1:43172'
const ep='/recurring/property-payables/property-bills'
const water=ep+'/pilot-property/water'
const enc=role=>jwt.sign({role,sub:role},key,{algorithm:'HS256',audience:'mz124-isolated',expiresIn:'15m'})
const roles={editor:'pilot-editor',viewer:'pilot-viewer'}
const syntheticHistory=[{date:'2026-06-28',status:'paid',amount:125.4}]
const record=[]
function note(s){record.push(s);console.log('PASS',s)}
async function http(role,uri,method='GET',data,status=200){
 const res=await fetch(api+uri,{method,headers:{Authorization:'Bearer '+enc(role),'Content-Type':'application/json'},...(data?{body:JSON.stringify(data)}:{})})
 assert.equal(res.status,status,method+' '+uri)
 return res.json().catch(()=>null)
}
async function seen(loc){await loc.waitFor({state:'visible',timeout:18000})}
async function main(){
 fs.mkdirSync(out,{recursive:true,mode:0o700})
 const guard=await(await fetch(api+'/health')).json()
 assert.equal(guard.mode,'isolated-pilot')
 const editor=roles.editor, viewer=roles.viewer
 const browser=await chromium.launch({headless:true})
 const mutate=[]
 try {
  async function open(role,viewport={width:1680,height:1000}){
   const ctx=await browser.newContext({viewport,locale:'zh-CN',timezoneId:'Australia/Melbourne',deviceScaleFactor:1,reducedMotion:'reduce',serviceWorkers:'block'})
   await ctx.route('**/*',route=>{
    let u=new URL(route.request().url())
    return [web,api].includes(u.origin)?route.continue():route.abort()
   })
   await ctx.addCookies([{name:'auth',value:enc(role),url:web}])
   const page=await ctx.newPage()
   page.setDefaultTimeout(12000)
   page.on('request',r=>{if(r.method()==='POST'&&(r.url().startsWith(api+water)||r.url().startsWith(web+'/api'+water)))mutate.push(r.url())})
   page.on('response',r=>{if(process.env.MZ124_PILOT_DEBUG && (r.url().startsWith(api)||r.url().startsWith(web+'/api/')))console.log('DEBUG',r.status(),new URL(r.url()).pathname)})
   page.on('requestfailed',r=>{if(process.env.MZ124_PILOT_DEBUG && (r.url().startsWith(api)||r.url().startsWith(web+'/api/')))console.log('DEBUG failed',new URL(r.url()).pathname,r.failure())})
   page.on('pageerror',e=>{if(process.env.MZ124_PILOT_DEBUG)console.log('DEBUG pageerror',e.message)})
   await page.clock.setFixedTime(new Date('2026-11-26T04:00:00Z'))
   await page.goto(web+'/finance/property-payables',{waitUntil:'domcontentloaded',timeout:90000})
   try { await tab(page) } catch(e) { if(process.env.MZ124_PILOT_DEBUG) console.log('DEBUG body',(await page.locator('body').innerText()).slice(0,1800)); throw e }
   return page
  }
  const tab=async p=>{await seen(p.getByText(/Hi, pilot-/));const radio=p.getByRole('radio',{name:'房源账单'});await p.locator('.ant-segmented-item-label').filter({hasText:'房源账单'}).click();assert(await radio.isChecked());await seen(p.getByText('QA-124-01',{exact:true}))}
  const detail=async p=>{
   const row=p.getByRole('row').filter({hasText:'QA-124-01'})
   await row.getByRole('button',{name:/QA-124-01 水费/}).click()
   await seen(p.getByText('样板水费 A',{exact:true}).first())
   return p.getByRole('dialog')
  }
  const chooseOwner=async (p,d)=>{
   await d.locator('.ant-select-selector').click()
   await p.locator('.ant-select-dropdown:visible').getByText('房东自付',{exact:true}).click()
  }
  const target=(d,which)=>d.locator('.ant-card').filter({hasText:which})
  const pic=async (p,name)=>{
   await p.evaluate(()=>document.fonts.ready)
   // Ant drawer/segmented/popover motion starts a frame after visibility. Stabilize candidate screenshots only.
   await p.waitForTimeout(450)
   if(name!=='01-房源账单列表'){
    const box=await p.getByRole('dialog').boundingBox()
    assert(box && box.x>=0 && box.x+box.width<=p.viewportSize().width+1,'drawer is visually inside viewport')
   }
   if(name==='03-停用确认弹窗') await seen(p.getByText('停用这份代付模板？',{exact:true}))
   await p.screenshot({path:path.join(out,name+'.png'),animations:'disabled',caret:'hide'})
  }
  const p=await open(editor)
  const headings=await p.locator('section[aria-label="房源账单"] thead th').allTextContents()
  assert.deepEqual(headings.map(x=>x.trim()).filter(Boolean),['房号','登记状态','水费','电费','煤气','网络','市政费','物业费','其他账单','操作'])
  await pic(p,'01-房源账单列表')
  const search=p.locator('input[aria-label="搜索房源账单"]')
  await search.fill('QA-ACCT-124')
  await p.locator('section[aria-label="房源账单"] .ant-input-search-button').click()
  await seen(p.getByText('QA-124-01',{exact:true}))
  await p.getByText('QA-124-02',{exact:true}).waitFor({state:'hidden'})
  await search.fill('')
  await seen(p.getByText('QA-124-02',{exact:true}))
  note('账号搜索命中并清空')
  let d=await detail(p)
  await pic(p,'02-房源账单详情')
  const original=await http(editor,water)
  const history=(await http(editor,water+'/history')).rows
  const expected=process.env.MZ124_PILOT_NEGATIVE==='history' ? [] : syntheticHistory
  assert.deepEqual(history,expected,'历史账单对照不成立')
  const peer=original.templates.find(t=>t.template_id==='pilot-sibling')
  const len=mutate.length
  await chooseOwner(p,d)
  await d.getByRole('button',{name:/^取\s*消$/}).click()
  await d.waitFor({state:'hidden'})
  assert.equal(mutate.length,len)
  assert.equal((await http(editor,water)).bill.status,'company')
  note('取消不写数据库')
  d=await detail(p)
  await chooseOwner(p,d)
  await d.getByRole('button',{name:'保存配置'}).click()
  await d.waitFor({state:'hidden'})
  await p.reload({waitUntil:'domcontentloaded'});await tab(p)
  d=await detail(p)
  await seen(d.getByText('水费 · 房东自付',{exact:true}))
  assert.equal((await http(editor,water)).bill.status,'owner')
  assert.deepEqual((await http(editor,water)).templates,original.templates)
  note('保存付款方后刷新保留且不改模板')
  await target(d,'样板水费 A').getByRole('button',{name:/^停\s*用$/}).click()
  await seen(p.getByRole('button',{name:'确认停用',exact:true}))
  await pic(p,'03-停用确认弹窗')
  const cancelCount=mutate.length
  await p.locator('.ant-popconfirm').getByRole('button',{name:/^取\s*消$/}).click()
  await p.getByRole('button',{name:'确认停用',exact:true}).waitFor({state:'hidden'})
  assert.equal(mutate.length,cancelCount)
  assert.equal((await http(editor,water)).templates.find(t=>t.template_id==='pilot-target').template_status,'active')
  await target(d,'样板水费 A').getByRole('button',{name:/^停\s*用$/}).click()
  await p.getByRole('button',{name:'确认停用',exact:true}).click()
  await seen(target(d,'样板水费 A').getByRole('button',{name:'恢复启用',exact:true}))
  await p.reload({waitUntil:'domcontentloaded'});await tab(p);d=await detail(p)
  await seen(target(d,'样板水费 A').getByText('已暂停',{exact:true}))
  assert.deepEqual((await http(editor,water)).templates.find(t=>t.template_id==='pilot-sibling'),peer)
  assert.deepEqual((await http(editor,water+'/history')).rows,history)
  await d.getByRole('button',{name:'查看历史记录'}).click()
  await seen(d.getByText('2026-06-28',{exact:true}))
  note('确认停用后刷新持久化；取消、同类模板和历史保护通过')
  await target(d,'样板水费 A').getByRole('button',{name:'恢复启用',exact:true}).click()
  await p.getByRole('button',{name:'确认恢复',exact:true}).click()
  await seen(target(d,'样板水费 A').getByRole('button',{name:/^停\s*用$/}))
  const after=await http(editor,water)
  const resumed=after.templates.find(t=>t.template_id==='pilot-target')
  const now=new Intl.DateTimeFormat('en-CA',{timeZone:'Australia/Melbourne',year:'numeric',month:'2-digit'}).formatToParts(new Date())
  const month=now.find(p=>p.type==='year').value+'-'+now.find(p=>p.type==='month').value
  assert.equal(resumed.template_status,'active')
  assert(resumed.start_month_key>month)
  assert.equal((Number(resumed.start_month_key.slice(5))-1)%3,0)
  assert.deepEqual((await http(editor,water+'/history')).rows,history)
  assert.deepEqual(after.templates.find(t=>t.template_id==='pilot-sibling'),peer)
  note('按原周期恢复，无新增历史；生成逻辑另复用底层断言')
  const v=await open(viewer,{width:1024,height:820})
  let dv=await detail(v)
  await seen(dv.getByText('只读',{exact:true}))
  assert.equal(await dv.getByRole('button',{name:'保存配置'}).count(),0)
  assert.equal(await dv.getByRole('button',{name:/^停\s*用$/}).count(),0)
  await http(viewer,water+'/templates/pilot-target/stop','POST',{},403)
  assert.equal((await http(editor,water)).templates.find(t=>t.template_id==='pilot-target').template_status,'active')
  await pic(v,'04-窄屏只读详情')
  note('只读无写入按钮，服务端拒绝停用')
  const expect=5+1
  assert.equal(record.length,expect)
  fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({mode:guard.mode,status:'pass',record},null,2))
 } finally {await browser.close()}
}
main().catch(e=>{console.error(e.stack);process.exitCode=1})
