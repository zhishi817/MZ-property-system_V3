const path = require('path')
const dotenv = require('dotenv')
const { Pool } = require('pg')

dotenv.config({ path: path.join(process.cwd(), '.env.local'), override: true })
dotenv.config({ path: path.join(process.cwd(), '..', '.env.local'), override: true })
dotenv.config()

function normStatus(v) {
  const s = String(v || '').trim()
  const low = s.toLowerCase()
  if (!low) return ''
  if (low === 'completed' || s.includes('已完成') || s === '完成') return 'completed'
  if (low === 'canceled' || s.includes('取消')) return 'canceled'
  return low
}

function normPay(v) {
  const s = String(v || '').trim()
  const low = s.toLowerCase()
  if (!low) return ''
  if (low === 'landlord_pay' || s.includes('房东')) return 'landlord_pay'
  if (low === 'company_pay' || s.includes('公司')) return 'company_pay'
  if (low === 'rent_deduction' || s.includes('租金')) return 'rent_deduction'
  if (low === 'tenant_pay' || s.includes('房客')) return 'tenant_pay'
  if (low === 'other_pay' || s.includes('其他')) return 'other_pay'
  return low
}

function toDateOnly(v) {
  if (!v) return null
  if (typeof v === 'string') {
    const t = v.trim()
    if (!t) return null
    if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10)
    const d0 = new Date(t)
    if (!isNaN(d0.getTime())) return d0.toISOString().slice(0, 10)
    return null
  }
  const d = new Date(v)
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10)
  return null
}

function toNum(v) {
  if (v === null || v === undefined || v === '') return 0
  const n0 = Number(v)
  if (Number.isFinite(n0)) return n0
  const s = String(v || '').replace(/[^0-9.\-]/g, '')
  const n1 = Number(s)
  return Number.isFinite(n1) ? n1 : 0
}

function calcMaint(r) {
  const base = toNum(r.maintenance_amount)
  const hasParts = r.has_parts === true
  if (!hasParts) return Math.round((base + Number.EPSILON) * 100) / 100
  const includes = r.maintenance_amount_includes_parts === true
  if (includes) return Math.round((base + Number.EPSILON) * 100) / 100
  const parts = toNum(r.parts_amount)
  return Math.round(((base + parts) + Number.EPSILON) * 100) / 100
}

function calcDC(r) {
  const raw = (r.total_cost !== undefined && r.total_cost !== null) ? r.total_cost : null
  if (raw !== null) return toNum(raw)
  const labor = toNum(r.labor_cost)
  let arr = []
  let c = r.consumables
  if (typeof c === 'string') {
    try { c = JSON.parse(c) } catch { c = [] }
  }
  if (Array.isArray(c)) arr = c
  const sum = arr.reduce((s, x) => s + toNum(x && x.cost), 0)
  return Math.round(((labor + sum) + Number.EPSILON) * 100) / 100
}

async function main() {
  const conn = process.env.DATABASE_URL || ''
  if (!conn) {
    console.log(JSON.stringify({ ok: false, error: 'DATABASE_URL not set' }, null, 2))
    return
  }

  const pool = new Pool({ connectionString: conn, ssl: { rejectUnauthorized: false }, max: 2 })
  const from = process.env.DRYRUN_FROM || '2000-01-01'
  const to = process.env.DRYRUN_TO || '2100-01-01'
  const limit = Math.max(1, Math.min(20000, Number(process.env.DRYRUN_LIMIT || 5000)))

  const out = {
    ok: true,
    range: { from, to },
    limit,
    type: 'all',
    scanned: 0,
    would_property: 0,
    would_company: 0,
    would_void: 0,
    would_cleaned_opposite: 0,
    skipped_manual_override: 0,
    notes: [],
  }

  let manualSet = new Set()
  try {
    const q1 = await pool.query("SELECT ref_type, ref_id FROM property_expenses WHERE manual_override=true AND ref_type IN ('maintenance','deep_cleaning') AND ref_id IS NOT NULL")
    for (const r of (q1.rows || [])) manualSet.add(String(r.ref_type || '') + ':' + String(r.ref_id || ''))
    const q2 = await pool.query("SELECT ref_type, ref_id FROM company_expenses WHERE manual_override=true AND ref_type IN ('maintenance','deep_cleaning') AND ref_id IS NOT NULL")
    for (const r of (q2.rows || [])) manualSet.add(String(r.ref_type || '') + ':' + String(r.ref_id || ''))
  } catch {
    out.notes.push('manual_override column missing or query failed; treating as none')
  }

  const mt = await pool.query(
    "SELECT id, property_id, status, pay_method, work_no, maintenance_amount, has_parts, parts_amount, maintenance_amount_includes_parts, completed_at, occurred_at, created_at FROM property_maintenance WHERE coalesce(completed_at::date, occurred_at, created_at::date) BETWEEN $1::date AND $2::date ORDER BY coalesce(completed_at::date, occurred_at, created_at::date) ASC LIMIT $3",
    [from, to, limit]
  )
  const dc = await pool.query(
    "SELECT id, property_id, status, pay_method, work_no, total_cost, labor_cost, consumables, completed_at, occurred_at, created_at FROM property_deep_cleaning WHERE coalesce(completed_at::date, occurred_at, created_at::date) BETWEEN $1::date AND $2::date ORDER BY coalesce(completed_at::date, occurred_at, created_at::date) ASC LIMIT $3",
    [from, to, limit]
  )

  const items = []
  for (const r of (mt.rows || [])) items.push({ kind: 'maintenance', row: r })
  for (const r of (dc.rows || [])) items.push({ kind: 'deep_cleaning', row: r })
  out.scanned = items.length

  for (const it of items) {
    const refType = it.kind === 'maintenance' ? 'maintenance' : 'deep_cleaning'
    const r = it.row || {}
    const refId = String(r.id || '')
    if (!refId) continue

    if (manualSet.has(refType + ':' + refId)) {
      out.skipped_manual_override++
      continue
    }

    const st = normStatus(r.status)
    const pm = normPay(r.pay_method)
    const occurredAt = toDateOnly(r.completed_at) || toDateOnly(r.occurred_at) || toDateOnly(r.created_at)
    const amount = it.kind === 'maintenance' ? calcMaint(r) : calcDC(r)
    const propertyId = String(r.property_id || '')

    const okBase = (st === 'completed' && amount > 0 && !!occurredAt)
    if (!okBase) { out.would_void++; continue }

    if (pm === 'landlord_pay') {
      if (!propertyId) { out.would_void++; continue }
      out.would_property++
      out.would_cleaned_opposite++
      continue
    }

    if (pm === 'company_pay') {
      out.would_company++
      out.would_cleaned_opposite++
      continue
    }

    out.would_void++
  }

  console.log(JSON.stringify(out, null, 2))
  await pool.end()
}

main().catch((e) => {
  console.log(JSON.stringify({ ok: false, error: String(e?.message || e || '') }, null, 2))
  process.exitCode = 1
})

