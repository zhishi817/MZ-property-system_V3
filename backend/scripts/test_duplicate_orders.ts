import fetch from 'node-fetch'

async function main() {
  const API_BASE = process.env.API_BASE || 'http://localhost:4001'
  const token = process.env.AUTH_TOKEN || (require('fs').existsSync('backend/tokenA_test.json') ? JSON.parse(require('fs').readFileSync('backend/tokenA_test.json','utf-8')).token : '')
  const headers = { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }
  const propsRes = await fetch(`${API_BASE}/properties?include_archived=true`, { headers })
  const props = await propsRes.json().catch(()=>[])
  const pid = Array.isArray(props) && props[0]?.id ? String(props[0].id) : ''
  if (!pid) throw new Error('no property_id found')
  const now = new Date()
  const ci = new Date(now); ci.setDate(ci.getDate()+1)
  const co = new Date(ci); co.setDate(ci.getDate()+2)
  function day(d: Date) { const yyyy = d.getFullYear(); const mm = String(d.getMonth()+1).padStart(2,'0'); const dd = String(d.getDate()).padStart(2,'0'); return `${yyyy}-${mm}-${dd}` }
  const confirmation = `DUPTEST-${Date.now()}`
  const payload = {
    source: 'offline',
    status: 'confirmed',
    property_id: pid,
    property_code: '',
    confirmation_code: confirmation,
    guest_name: 'Test Guest',
    guest_phone: '0400000000',
    checkin: day(ci) + 'T12:00:00',
    checkout: day(co) + 'T11:59:59',
    price: 300,
    cleaning_fee: 60,
    net_income: 240,
    avg_nightly_price: 120,
    nights: 2,
    currency: 'AUD'
  }
  const r1 = await fetch(`${API_BASE}/orders/sync`, { method: 'POST', headers, body: JSON.stringify(payload) })
  const j1 = await r1.json().catch(()=>null)
  console.log('create1', r1.status, j1?.id || j1?.message)
  const r2 = await fetch(`${API_BASE}/orders/validate-duplicate`, { method: 'POST', headers, body: JSON.stringify(payload) })
  const j2 = await r2.json().catch(()=>null)
  console.log('validate', r2.status, j2)
  const r3 = await fetch(`${API_BASE}/orders/sync`, { method: 'POST', headers, body: JSON.stringify(payload) })
  const j3 = await r3.json().catch(()=>null)
  console.log('create2', r3.status, j3?.message)
  const r4 = await fetch(`${API_BASE}/orders/sync?force=true`, { method: 'POST', headers, body: JSON.stringify({ ...payload, force: true }) })
  const j4 = await r4.json().catch(()=>null)
  console.log('force', r4.status, j4?.id || j4?.message)
}

main().catch(e => { console.error(e); process.exit(1) })
