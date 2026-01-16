const assert = require('assert')
async function main() {
  const base = process.env.API_BASE || 'http://localhost:4001'
  const lr = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'cleaner', password: process.env.CLEANER_PASSWORD || 'cleaner' }) })
  const lj = await lr.json()
  assert(lj.token)
  const token = lj.token
  const pr = await fetch(`${base}/properties`, { headers: { Authorization: `Bearer ${token}` } })
  const props = await pr.json()
  const pid = props[0]?.id || null
  const today = new Date().toISOString().slice(0,10)
  await fetch(`${base}/cleaning/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ property_id: pid, date: today }) })
  const tr = await fetch(`${base}/cleaning-app/tasks`, { headers: { Authorization: `Bearer ${token}` } })
  const tasks = await tr.json()
  const t = tasks[0]
  if (!t) throw new Error('no tasks')
  const sr = await fetch(`${base}/cleaning-app/tasks/${t.id}/start`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ media_url: 'https://example.com/key.jpg' }) })
  if (!sr.ok) {
    const txt = await sr.text()
    console.error('start status', sr.status, txt)
    throw new Error('start failed')
  }
  const cr = await fetch(`${base}/cleaning-app/tasks/${t.id}/consumables`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ items: [{ item_id: 'tissue', qty: 1, need_restock: true }] }) })
  if (!cr.ok) throw new Error('consumables failed')
  console.log('ok')
}
main().catch(e => { console.error(e); process.exit(1) })
