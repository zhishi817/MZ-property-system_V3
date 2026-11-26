'use strict'
const fs=require('node:fs')
const path=require('node:path')
const assert=require('node:assert/strict')
try {
 const data=JSON.parse(fs.readFileSync(process.argv[2],'utf8'))
 assert.equal(data.mode,'isolated-pilot')
 assert.equal(data.status,'pass')
 const expected=[
  '账号搜索命中并清空',
  '取消不写数据库',
  '保存付款方后刷新保留且不改模板',
  '确认停用后刷新持久化；取消、同类模板和历史保护通过',
  '按原周期恢复，无新增历史；生成逻辑另复用底层断言',
  '只读无写入按钮，服务端拒绝停用',
 ]
 assert.deepEqual(data.record,expected)
 const approved=process.argv[3]
 if(approved) {
  assert.notEqual(fs.realpathSync(path.dirname(process.argv[2])),fs.realpathSync(approved),'candidate cannot be its own approved baseline')
  for(const n of ['01-房源账单列表','02-房源账单详情','03-停用确认弹窗','04-窄屏只读详情']){
   const f=n+'.png'
   assert(fs.readFileSync(path.join(path.dirname(process.argv[2]),f)).equals(fs.readFileSync(path.join(approved,f))), 'visual difference: '+f)
  }
  console.log('Approved screenshot comparison passed.')
 } else console.log('UI baseline not supplied; visual acceptance not run.')
 console.log('Local pilot evidence complete; not a GitHub merge verdict, and not approval of screenshot baselines.')
} catch(e) {
 console.error('BLOCKED: missing or incomplete local pilot results:', e.message)
 process.exitCode=1
}
