// Integration tests for Cleaning Tasks Module
// Usage: node backend/scripts/test_cleaning_tasks_module.js [API_BASE]

const fs = require('fs')
const path = require('path')
const API_BASE = process.argv[2] || process.env.API_BASE || 'http://localhost:4001'
const tokenFile = path.resolve(__dirname, '../tokenA_admin.json')
let TOKEN = process.env.AUTH_TOKEN || ''
try { const raw = fs.readFileSync(tokenFile, 'utf-8'); const j = JSON.parse(raw); TOKEN = j?.token || TOKEN } catch {}

if (!global.fetch) { global.fetch = require('node-fetch') }

async function http(method, url, body) {
  const headers = { 'Content-Type': 'application/json' }
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`
  const r = await fetch(API_BASE + url, { method, headers, body: body ? JSON.stringify(body) : undefined })
  const txt = await r.text()
  let data = null
  try { data = JSON.parse(txt) } catch { data = txt }
  return { status: r.status, data }
}

async function run() {
  console.log(`[test] API_BASE=${API_BASE}`)
  if (!TOKEN) { console.log('[test] WARN no token; some routes may fail') }
  const today = new Date().toISOString().slice(0,10)
  const list = await http('GET', `/cleaning-app/tasks?from=${today}&to=${today}`)
  console.log('[list]', list.status, Array.isArray(list.data) ? list.data.length : list.data)
  const firstId = Array.isArray(list.data) && list.data[0]?.id
  if (!firstId) { console.log('[test] No tasks today; test will exit'); return }
  // upload
  let uploadUrl = null
  try {
    const fd = new (require('form-data'))()
    fd.append('file', Buffer.from('hello'), { filename: 'test.txt', contentType: 'text/plain' })
    const headers = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}
    const r = await fetch(API_BASE + '/cleaning-app/upload', { method: 'POST', headers, body: fd })
    const j = await r.json(); uploadUrl = j.url
  } catch {}
  // start
  const started = await http('POST', `/cleaning-app/tasks/${firstId}/start`, { media_url: uploadUrl || 'local://mock', lat: -37.8136, lng: 144.9631 })
  console.log('[start]', started.status, started.data?.status || started.data)
  // consumables
  const consum = await http('POST', `/cleaning-app/tasks/${firstId}/consumables`, { items: [] })
  console.log('[consumables]', consum.status, consum.data?.status || consum.data)
  // restock
  const restock = await http('PATCH', `/cleaning-app/tasks/${firstId}/restock`)
  console.log('[restock]', restock.status, restock.data?.status || restock.data)
  // inspect
  const inspect = await http('POST', `/cleaning-app/tasks/${firstId}/inspection-complete`, { media_url: uploadUrl || 'local://mock' })
  console.log('[inspect]', inspect.status, inspect.data?.status || inspect.data)
  // ready
  const ready = await http('PATCH', `/cleaning-app/tasks/${firstId}/ready`)
  console.log('[ready]', ready.status, ready.data?.status || ready.data)
}

run().catch(e => { console.error('[test] failed', e); process.exit(1) })

