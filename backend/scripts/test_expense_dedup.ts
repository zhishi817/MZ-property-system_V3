import fetch from 'node-fetch'

async function main() {
  const API_BASE = process.env.API_BASE || 'http://localhost:4001'
  const token = process.env.AUTH_TOKEN || (require('fs').existsSync('backend/tokenA_test.json') ? JSON.parse(require('fs').readFileSync('backend/tokenA_test.json','utf-8')).token : '')
  const headers = { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }
  const props = await fetch(`${API_BASE}/properties?include_archived=true`, { headers }).then(r => r.json()).catch(()=>[])
  const pid = Array.isArray(props) && props[0]?.id ? String(props[0].id) : ''
  if (!pid) throw new Error('no property_id')
  const today = new Date()
  const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
  const payload = { kind:'expense', amount: 88.9, currency: 'AUD', category: 'internet', property_id: pid, note: 'NBN monthly', occurred_at: day(today), paid_date: day(today) }
  const v = await fetch(`${API_BASE}/finance/expenses/validate-duplicate`, { method:'POST', headers, body: JSON.stringify(payload) }).then(r => r.json()).catch(()=>null)
  console.log('validate#1', v)
  const c1 = await fetch(`${API_BASE}/crud/property_expenses`, { method:'POST', headers, body: JSON.stringify(payload) })
  console.log('create#1', c1.status)
  const v2 = await fetch(`${API_BASE}/finance/expenses/validate-duplicate`, { method:'POST', headers, body: JSON.stringify(payload) }).then(r => r.json()).catch(()=>null)
  console.log('validate#2', v2)
  const c2 = await fetch(`${API_BASE}/crud/property_expenses`, { method:'POST', headers, body: JSON.stringify(payload) })
  const j2 = await c2.json().catch(()=>null)
  console.log('create#2', c2.status, j2)
}

main().catch(e => { console.error(e); process.exit(1) })
