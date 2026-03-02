"use client"
import dayjs from 'dayjs'
import { monthSegments, toDayStr, parseDateOnly } from '../lib/orders'
import { normalizeReportCategory, shouldIncludeIncomeTxInPropertyOtherIncome, txInMonth, txMatchesProperty } from '../lib/financeTx'
import { computeMonthlyStatementBalance, isFurnitureOwnerPayment, isFurnitureRecoverableCharge } from '../lib/statementBalances'
import { formatStatementDesc } from '../lib/statementDesc'
import { Table } from 'antd'
import { forwardRef, useEffect, useState } from 'react'
import { API_BASE, authHeaders } from '../lib/api'

type Order = { id: string; property_id?: string; checkin?: string; checkout?: string; price?: number; nights?: number; status?: string; count_in_income?: boolean }
type Tx = { id: string; kind: 'income'|'expense'; amount: number; currency: string; property_id?: string; occurred_at: string; category?: string; category_detail?: string; note?: string; invoice_url?: string; ref_type?: string; ref_id?: string }
type Landlord = { id: string; name: string; management_fee_rate?: number; property_ids?: string[] }
type ExpenseInvoice = { id: string; expense_id: string; url: string; file_name?: string; mime_type?: string; file_size?: number }
type DeepCleaning = { id: string; work_no?: string; property_id?: string; occurred_at?: string; completed_at?: string; started_at?: string; ended_at?: string; category?: string; photo_urls?: any; repair_photo_urls?: any; pay_method?: string; total_cost?: any }
type Maintenance = { id: string; work_no?: string; property_id?: string; occurred_at?: string; completed_at?: string; started_at?: string; ended_at?: string; category?: string; details?: any; repair_notes?: string; photo_urls?: any; repair_photo_urls?: any }

function safeJsonParse(v: any) {
  if (v === null || v === undefined) return null
  if (typeof v === 'object') return v
  const s = String(v || '').trim()
  if (!s) return null
  try { return JSON.parse(s) } catch { return null }
}

function summaryFromDetails(details: any): string {
  const v = safeJsonParse(details)
  if (!v) return ''
  if (typeof v === 'string') return v
  if (Array.isArray(v)) {
    const parts = v.map((x: any) => String(x?.item || x?.content || x?.desc || '').trim()).filter(Boolean)
    return parts.join('\n')
  }
  const one = String((v as any)?.item || (v as any)?.content || '').trim()
  return one
}

export default forwardRef<HTMLDivElement, {
  month: string
  propertyId?: string
  orders: Order[]
  txs: Tx[]
  properties: { id: string; code?: string; address?: string }[]
  landlords: Landlord[]
  showChinese?: boolean
  showInvoices?: boolean
  pdfMode?: boolean
  renderEngine?: 'canvas' | 'print'
}>(function MonthlyStatementView({ month, propertyId, orders, txs, properties, landlords, showChinese = true, showInvoices = false, pdfMode = false, renderEngine = 'canvas' }, ref) {
  const start = dayjs(`${month}-01`)
  const endNext = start.add(1, 'month').startOf('month')
  const relatedOrdersRaw = monthSegments(
    orders.filter(o => {
      if (propertyId && o.property_id !== propertyId) return false
      const st = String((o as any).status || '').toLowerCase()
      const isCanceled = st.includes('cancel')
      const include = (!isCanceled) || !!(o as any).count_in_income
      return include
    }),
    start
  )
  const relatedOrders = relatedOrdersRaw.filter(r => {
    const st = String((r as any).status || '').toLowerCase()
    const isCanceled = st.includes('cancel')
    return (!isCanceled) || !!(r as any).count_in_income
  })
  const relatedOrdersSorted = [...relatedOrders].sort((a: any, b: any) => {
    const aci = a?.checkin ? dayjs(toDayStr(a.checkin)).valueOf() : 0
    const bci = b?.checkin ? dayjs(toDayStr(b.checkin)).valueOf() : 0
    if (aci !== bci) return aci - bci
    const aco = a?.checkout ? dayjs(toDayStr(a.checkout)).valueOf() : 0
    const bco = b?.checkout ? dayjs(toDayStr(b.checkout)).valueOf() : 0
    if (aco !== bco) return aco - bco
    const aid = String(a?.__rid || a?.id || '')
    const bid = String(b?.__rid || b?.id || '')
    return aid.localeCompare(bid)
  })
  const simpleMode = false
  const property = properties.find(pp => pp.id === (propertyId || ''))
  const expensesInMonthAll = txs.filter(t => {
    if (t.kind !== 'expense') return false
    if (propertyId) {
      if (!txMatchesProperty(t, { id: propertyId, code: property?.code })) return false
    }
    return txInMonth(t as any, start)
  })
  const expensesInMonthForReport = expensesInMonthAll.filter(t => !isFurnitureRecoverableCharge(t as any))
  const [invoiceMap, setInvoiceMap] = useState<Record<string, ExpenseInvoice[]>>({})
  const [deepCleanings, setDeepCleanings] = useState<DeepCleaning[]>([])
  const [deepCleaningsLoaded, setDeepCleaningsLoaded] = useState(false)
  const [maintenances, setMaintenances] = useState<Maintenance[]>([])
  const [maintenancesLoaded, setMaintenancesLoaded] = useState(false)
  const [expandAllDeepClean, setExpandAllDeepClean] = useState(false)
  const [expandedDeepClean, setExpandedDeepClean] = useState<Record<string, boolean>>({})
  const [expandAllMaintenance, setExpandAllMaintenance] = useState(false)
  const [expandedMaintenance, setExpandedMaintenance] = useState<Record<string, boolean>>({})
  useEffect(() => {
    (async () => {
      try {
        if (!propertyId) { setInvoiceMap({}); return }
        const from = start.format('YYYY-MM-DD')
        const to = endNext.subtract(1,'day').format('YYYY-MM-DD')
        const res = await fetch(`${API_BASE}/finance/expense-invoices/search?property_id=${encodeURIComponent(propertyId)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { headers: authHeaders() })
        const rows: ExpenseInvoice[] = res.ok ? (await res.json()) : []
        const map: Record<string, ExpenseInvoice[]> = {}
        rows.forEach((r: any) => { const k = String(r.expense_id); (map[k] = map[k] || []).push(r) })
        const missingIds = expensesInMonthAll.map(e => String(e.id)).filter(id => !(id in map))
        if (missingIds.length) {
          const extraLists = await Promise.all(missingIds.map(async (eid) => {
            try {
              const r = await fetch(`${API_BASE}/finance/expense-invoices/${encodeURIComponent(eid)}`, { headers: authHeaders() })
              const arr: ExpenseInvoice[] = r.ok ? (await r.json()) : []
              return { eid, arr }
            } catch { return { eid, arr: [] as ExpenseInvoice[] } }
          }))
          extraLists.forEach(({ eid, arr }) => {
            if (arr && arr.length) { map[eid] = (map[eid] || []).concat(arr) }
          })
        }
        // 进一步回补：若某支出在交易记录中自带 invoice_url，也作为发票处理
        expensesInMonthAll.forEach((e) => {
          const eid = String((e as any).id)
          const tx = (txs || []).find(t => t.kind === 'expense' && String(t.id) === eid && !!(t as any).invoice_url)
          const urlRaw = (tx as any)?.invoice_url || ''
          if (urlRaw) {
            const url = /^https?:\/\//.test(urlRaw) ? urlRaw : `${API_BASE}${urlRaw}`
            const pseudo: ExpenseInvoice = { id: `tx-${eid}`, expense_id: eid, url }
            map[eid] = (map[eid] || []).concat([pseudo])
          }
        })
        setInvoiceMap(map)
      } catch { setInvoiceMap({}) }
    })()
  }, [propertyId, month, expensesInMonthAll.length])
  useEffect(() => {
    (async () => {
      try {
        setDeepCleaningsLoaded(false)
        if (!propertyId) { setDeepCleanings([]); setDeepCleaningsLoaded(true); return }
        const codeRaw = String(property?.code || '').trim()
        const code = (() => {
          if (!codeRaw) return ''
          const s = codeRaw.split('(')[0].trim()
          const t = s.split(/\s+/)[0].trim()
          return t || s || codeRaw
        })()
        const buildUrl = (params: Record<string, string>) => {
          const qs = new URLSearchParams({ ...params, limit: '5000' })
          return `${API_BASE}/crud/property_deep_cleaning?${qs.toString()}`
        }
        const urls = [
          buildUrl({ property_id: propertyId }),
          ...(code ? [buildUrl({ property_code: code })] : []),
          ...(codeRaw && codeRaw !== code ? [buildUrl({ property_code: codeRaw })] : []),
        ]
        const rs = await Promise.all(urls.map(async (u) => {
          try {
            const res = await fetch(u, { headers: authHeaders() })
            return res.ok ? await res.json() : []
          } catch {
            return []
          }
        }))
        const merged = ([] as any[]).concat(...rs)
        const map = new Map<string, any>()
        for (const r of merged) {
          const id = String(r?.id || '')
          if (id) map.set(id, r)
        }
        const list = Array.from(map.values())
        const inMonth = list.filter((d: any) => {
          const raw: any = d?.occurred_at || d?.completed_at || d?.started_at || d?.submitted_at || d?.created_at
          const day = toDayStr(raw)
          return day ? dayjs(day).isSame(start, 'month') : false
        })
        setDeepCleanings(inMonth as any)
      } catch {
        setDeepCleanings([])
      } finally {
        setDeepCleaningsLoaded(true)
      }
    })()
  }, [propertyId, month])
  useEffect(() => {
    ;(async () => {
      try {
        setMaintenancesLoaded(false)
        if (!propertyId) { setMaintenances([]); setMaintenancesLoaded(true); return }
        const codeRaw = String(property?.code || '').trim()
        const code = (() => {
          if (!codeRaw) return ''
          const s = codeRaw.split('(')[0].trim()
          const t = s.split(/\s+/)[0].trim()
          return t || s || codeRaw
        })()
        const buildUrl = (params: Record<string, string>) => {
          const qs = new URLSearchParams({ ...params, limit: '5000' })
          return `${API_BASE}/crud/property_maintenance?${qs.toString()}`
        }
        const urls = [
          buildUrl({ property_id: propertyId }),
          ...(code ? [buildUrl({ property_code: code })] : []),
          ...(codeRaw && codeRaw !== code ? [buildUrl({ property_code: codeRaw })] : []),
        ]
        const rs = await Promise.all(urls.map(async (u) => {
          try {
            const res = await fetch(u, { headers: authHeaders() })
            return res.ok ? await res.json() : []
          } catch {
            return []
          }
        }))
        const merged = ([] as any[]).concat(...rs)
        const map = new Map<string, any>()
        for (const r of merged) {
          const id = String(r?.id || '')
          if (id) map.set(id, r)
        }
        const list = Array.from(map.values())
        const inMonth = list.filter((d: any) => {
          const raw: any = d?.occurred_at || d?.completed_at || d?.started_at || d?.submitted_at || d?.created_at
          const day = toDayStr(raw)
          return day ? dayjs(day).isSame(start, 'month') : false
        })
        setMaintenances(inMonth as any)
      } catch {
        setMaintenances([])
      } finally {
        setMaintenancesLoaded(true)
      }
    })()
  }, [propertyId, month])
  const orderIncomeShare = relatedOrders.reduce((s, x) => s + Number(((x as any).visible_net_income ?? (x as any).net_income ?? 0)), 0)
  const rentIncome = orderIncomeShare
  const orderById = new Map((orders || []).map(o => [String(o.id), o]))
  const otherIncomeTx = txs.filter(t => {
    if (t.kind !== 'income') return false
    if (propertyId && t.property_id !== propertyId) return false
    if (!dayjs(toDayStr(t.occurred_at)).isSame(start, 'month')) return false
    if (isFurnitureOwnerPayment(t as any)) return false
    if (String(t.category || '').toLowerCase() === 'late_checkout') return false
    return shouldIncludeIncomeTxInPropertyOtherIncome(t, orderById)
  })
  const otherIncome = otherIncomeTx.reduce((s,x)=> s + Number(x.amount || 0), 0)
  const mapIncomeCatLabel = (c?: string) => {
    const v = String(c || '')
    if (v === 'late_checkout') return showChinese ? '晚退房费' : 'Late checkout fee'
    if (v === 'cancel_fee') return showChinese ? '取消费' : 'Cancellation fee'
    return v || '-'
  }
  const otherIncomeDescFmt = formatStatementDesc({
    items: Array.from(new Set(otherIncomeTx.map(t => mapIncomeCatLabel(t.category)))).filter(Boolean) as any,
    lang: showChinese ? 'zh' : 'en',
  })
  const totalIncome = rentIncome + otherIncome
  const occupiedNights = relatedOrders.reduce((s, x) => s + Number(x.nights || 0), 0)
  const daysInMonth = endNext.diff(start, 'day')
  const occupancyRate = daysInMonth ? Math.round(((occupiedNights / daysInMonth) * 100 + Number.EPSILON) * 100) / 100 : 0
  const dailyAverage = occupiedNights ? Math.round(((totalIncome / occupiedNights) + Number.EPSILON) * 100) / 100 : 0
  const landlord = landlords.find(l => (l.property_ids || []).includes(propertyId || ''))
  const managementFee = (landlord?.management_fee_rate ? Math.round(((rentIncome * landlord.management_fee_rate) + Number.EPSILON) * 100) / 100 : 0)
  function catKey(e: any): string {
    const raw = normalizeReportCategory(e?.report_category || e?.category)
    if (raw === 'parking_fee') return 'carpark'
    if (raw === 'body_corp') return 'property_fee'
    if (raw === 'consumables') return 'consumable'
    return raw
  }
  const deepCleanOwnerTxs = (deepCleanings || [])
    .filter((d: any) => {
      const raw = String(d?.pay_method || '')
      const pm = raw.trim().toLowerCase()
      if (pm === 'landlord_pay') return true
      if (pm.includes('landlord') || pm.includes('owner')) return true
      if (raw.includes('房东')) return true
      return false
    })
    .map((d: any) => {
      const parseArr = (raw: any) => {
        if (Array.isArray(raw)) return raw
        if (typeof raw === 'string') { try { const j = JSON.parse(raw); return Array.isArray(j) ? j : [] } catch { return [] } }
        return []
      }
      const labor = Number(d?.labor_cost || 0)
      const laborN = Number.isFinite(labor) ? labor : 0
      const arr = parseArr(d?.consumables)
      const sum = arr.reduce((s: number, x: any) => {
        const n = Number(x?.cost || 0)
        return s + (Number.isFinite(n) ? n : 0)
      }, 0)
      const fallbackTotal = Math.round(((laborN + sum) + Number.EPSILON) * 100) / 100
      const amount = Number((d?.total_cost !== undefined && d?.total_cost !== null) ? d.total_cost : fallbackTotal) || 0
      const dateKey = toDayStr(d?.occurred_at || d?.completed_at || d?.started_at || d?.submitted_at || d?.created_at) || start.format('YYYY-MM-DD')
      return {
        id: `deep-cleaning-${String(d?.id || '')}`,
        kind: 'expense',
        amount,
        currency: 'AUD',
        property_id: propertyId,
        occurred_at: dateKey,
        category: 'other',
        category_detail: 'Deep cleaning maintenance',
        note: '',
        ref_type: 'deep_cleaning',
        ref_id: String(d?.id || ''),
      }
    })
    .filter((t: any) => t.ref_id && t.amount > 0)
  const expensesInMonthForReportAll = expensesInMonthForReport.concat(deepCleanOwnerTxs as any)
  const sumByCat = (cat: string) => expensesInMonthForReportAll.filter(e => catKey(e) === cat).reduce((s, x) => s + Number(x.amount || 0), 0)
  const catElectricity = sumByCat('electricity')
  const catWater = sumByCat('water')
  const catGas = sumByCat('gas')
  const catInternet = sumByCat('internet')
  const catConsumable = sumByCat('consumable')
  const catCarpark = sumByCat('carpark')
  const catOwnerCorp = sumByCat('property_fee')
  const catCouncil = sumByCat('council')
  const catOther = sumByCat('other')
  function cleanOtherDesc(raw?: any): string {
    let s = String(raw || '').trim()
    if (!s) return ''
    s = s.replace(/^other\s*,\s*/i, '')
    s = s.replace(/^其他\s*[，,]\s*/i, '')
    if (/^(other|其他)$/i.test(s)) return ''
    if (/^fixed\s*payment$/i.test(s)) return ''
    return s
  }
  const otherItems = expensesInMonthForReportAll
    .filter(e => catKey(e) === 'other')
    .map(e => cleanOtherDesc((e as any).category_detail || (e as any).note || ''))
    .filter(Boolean)
  const otherExpenseDescFmt = formatStatementDesc({
    items: otherItems,
    lang: showChinese ? 'zh' : 'en',
    ...(showChinese ? { joiner: '/' } : {}),
  })
  const totalExpense = (managementFee + catElectricity + catWater + catGas + catInternet + catConsumable + catCarpark + catOwnerCorp + catCouncil + catOther)
  const balance = (propertyId ? computeMonthlyStatementBalance({
    month,
    propertyId,
    propertyCode: property?.code,
    orders,
    txs: (txs as any).concat(deepCleanOwnerTxs as any),
    managementFeeRate: landlord?.management_fee_rate,
  }) : null)
  const netIncome = balance ? balance.operating_net_income : Math.round(((totalIncome - totalExpense) + Number.EPSILON) * 100) / 100
  const hasCarry = !!balance && ([
    balance.opening_carry_net,
    balance.closing_carry_net,
  ].some(v => Math.abs(Number(v || 0)) > 0.005))
  const hasFurniture = !!balance && ([
    balance.furniture_opening_outstanding,
    balance.furniture_charge,
    balance.furniture_owner_paid,
    balance.furniture_offset_from_rent,
    balance.furniture_closing_outstanding,
  ].some(v => Math.abs(Number(v || 0)) > 0.005))
  const showBalance = !!balance && (hasCarry || hasFurniture)
  const isImg = (u?: string) => !!u && /\.(png|jpg|jpeg|gif)$/i.test(u)
  const isPdf = (u?: string) => !!u && /\.pdf$/i.test(u)
  const resolveUrl = (u?: string) => {
    if (!u) return ''
    if (/^https?:\/\//.test(u)) {
      if (u.includes('.r2.dev/')) return `${API_BASE}/public/r2-image?url=${encodeURIComponent(u)}`
      return u
    }
    return `${API_BASE}${u}`
  }
  const fmt = (n: number) => (n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  function perDayPrice(o: Order): number {
    const ci = o.checkin ? parseDateOnly(toDayStr(o.checkin)) : null
    const co = o.checkout ? parseDateOnly(toDayStr(o.checkout)) : null
    if (!ci || !co) return 0
    const totalN = Math.max(co.diff(ci, 'day'), 0)
    if (!totalN) return 0
    return Number(o.price || 0) / totalN
  }
  const weekStart = start.startOf('week')
  const weekEnd = endNext.subtract(1,'day').endOf('week')
  const days: any[] = []
  { let d = weekStart.clone(); while (d.isBefore(weekEnd.add(1,'day'))) { days.push(d.clone()); d = d.add(1,'day') } }
  function buildWeekSegments(ws: any, we: any) {
    const segs: Array<{ id: string; startIdx: number; endIdx: number; o: Order }> = []
      relatedOrders.forEach((o) => {
      const ci = o.checkin ? parseDateOnly(toDayStr(o.checkin)) : null
      const co = o.checkout ? parseDateOnly(toDayStr(o.checkout)) : null
      if (!ci || !co) return
      const s = ci.isAfter(ws) ? ci : ws
      const e = co.isBefore(we.add(1,'millisecond')) ? co : we.add(1,'millisecond')
      if (!(e.isAfter(s))) return
      const startIdx = Math.max(0, s.diff(ws.startOf('day'), 'day'))
      const endIdx = Math.max(0, e.subtract(1,'day').diff(ws.startOf('day'), 'day'))
      segs.push({ id: o.id, startIdx, endIdx, o })
    })
    segs.sort((a,b)=> a.startIdx - b.startIdx || a.endIdx - b.endIdx)
    const lanesEnd: number[] = []
    const laneMap: Record<string, number> = {}
    segs.forEach(seg => {
      let placed = false
      for (let i = 0; i < lanesEnd.length; i++) {
        if (seg.startIdx > lanesEnd[i]) { laneMap[seg.id] = i; lanesEnd[i] = seg.endIdx; placed = true; break }
      }
      if (!placed) { laneMap[seg.id] = lanesEnd.length; lanesEnd.push(seg.endIdx) }
    })
    return { segs, laneMap, laneCount: lanesEnd.length }
  }
  const sourceColor: Record<string, string> = { airbnb: '#FF9F97', booking: '#98B6EC', offline: '#DC8C03', other: '#98B6EC' }

  return (
    <div
      ref={ref as any}
      data-monthly-statement-root="1"
      data-pdf-mode={pdfMode ? '1' : '0'}
      data-deep-clean-loaded={deepCleaningsLoaded ? '1' : '0'}
      data-deep-clean-count={String((deepCleanings || []).length)}
      data-maint-loaded={maintenancesLoaded ? '1' : '0'}
      data-maint-count={String((maintenances || []).length)}
      style={{ padding: 24, fontFamily: 'Times New Roman, Times, serif' }}
    >
      <style>{`
        [data-monthly-statement-root="1"] table { width: 100%; border-collapse: collapse; }
        [data-monthly-statement-root="1"] table tr > * { border-bottom: 1px solid #ddd; }
        [data-monthly-statement-root="1"] [data-statement-row="1"] { border-bottom: 1px solid #ddd; }
        @media print {
          @page { size: A4; margin: 12mm; }
          html, body { margin: 0; padding: 0; }
          [data-monthly-statement-root="1"] [data-keep-with-next="true"] { break-after: avoid; page-break-after: avoid; }
          [data-monthly-statement-root="1"] [data-pdf-break-before="true"] { break-before: page; page-break-before: always; }
          [data-monthly-statement-root="1"] [data-pdf-avoid-cut="true"] { break-inside: avoid; page-break-inside: avoid; }
          [data-monthly-statement-root="1"] tr { break-inside: avoid; page-break-inside: avoid; }
        }
      `}</style>
      <div className="print-header" style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
        <img src="/mz-logo.png" alt="Company Logo" style={{ height: 64 }} />
        <div style={{ flex: 1, marginLeft: 12 }}></div>
        <div style={{ textAlign:'right', minWidth: 420 }}>
          <div style={{ fontSize: 34, fontWeight: 700, letterSpacing: 1, display:'flex', justifyContent:'flex-end', alignItems:'baseline', gap: 10 }}>
            <span>MONTHLY STATEMENT</span>
          </div>
          <div style={{ borderTop: '2px solid #000', marginTop: 6 }}></div>
          <div style={{ display:'flex', flexDirection:'column', alignItems:'flex-end', marginTop: 6 }}>
            <div style={{ fontSize: 22, fontWeight: 700 }}>{dayjs(`${month}-01`).format('MM/YYYY')}</div>
          <div style={{ fontSize: 16, marginTop: 4 }}>{landlord?.name || ''}</div>
          <div style={{ fontSize: 14 }}>
            {String(property?.code || '').trim() ? `${String(property?.code || '').trim()} / ` : ''}
            {property?.address || ''}
          </div>
          </div>
        </div>
      </div>
      <div style={{ borderTop: '2px solid transparent', margin: '8px 0' }}></div>
      <div data-keep-with-next="true" style={{ marginTop: 24, fontWeight: 600, background:'#eef3fb', padding:'6px 8px' }}>{showChinese ? 'Monthly Overview Data 月度概览数据' : 'Monthly Overview Data'}</div>
      <table style={{ width: '100%', borderCollapse:'collapse' }}>
        <tbody>
          <tr><td style={{ padding:6 }}>{showChinese ? 'Total rent income 总租金' : 'Total rent income'}</td><td style={{ textAlign:'right', padding:6 }}>${fmt(totalIncome)}</td></tr>
          <tr><td style={{ padding:6 }}>{showChinese ? 'Occupancy Rate 入住率' : 'Occupancy Rate'}</td><td style={{ textAlign:'right', padding:6 }}>{fmt(occupancyRate)}%</td></tr>
          <tr><td style={{ padding:6 }}>{showChinese ? 'Daily Average 日平均租金' : 'Daily Average'}</td><td style={{ textAlign:'right', padding:6 }}>${fmt(dailyAverage)}</td></tr>
        </tbody>
      </table>

      <div data-keep-with-next="true" style={{ marginTop: 16, fontWeight: 600, background:'#eef3fb', padding:'6px 8px' }}>{showChinese ? 'Rental Details 租赁明细' : 'Rental Details'}</div>
      <div data-statement-row="1" style={{ fontWeight: 700, display:'flex', justifyContent:'space-between', padding:'6px 8px' }}>
        <span>{showChinese ? 'Total Income 总收入' : 'Total Income'}</span><span>${fmt(totalIncome)}</span>
      </div>
      <table style={{ width:'100%' }}>
        <tbody>
          <tr><td style={{ padding:6, textIndent:'4ch' }}>{showChinese ? 'Rent Income 租金收入' : 'Rent Income'}</td><td style={{ textAlign:'right', padding:6 }}>${fmt(rentIncome)}</td></tr>
          {!simpleMode && (<tr><td style={{ padding:6, textIndent:'4ch' }}>{showChinese ? 'Other Income 其他收入' : 'Other Income'}</td><td style={{ textAlign:'right', padding:6 }}>${fmt(otherIncome)}</td></tr>)}
          {!simpleMode && (
            <tr>
              <td style={{ padding:6, textIndent:'4ch', whiteSpace:'nowrap' }}>{showChinese ? 'Other Income Desc 其他收入描述' : 'Other Income Desc'}</td>
              <td
                style={{ padding:6, textAlign:'right', whiteSpace:'normal', wordBreak:'break-word', overflowWrap:'anywhere' }}
                title={otherIncomeDescFmt.full || undefined}
              >
                {otherIncomeDescFmt.text}
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {!simpleMode && (
        <>
          <div data-statement-row="1" style={{ fontWeight: 700, display:'flex', justifyContent:'space-between', padding:'6px 8px', marginTop: 8 }}>
            <span>{showChinese ? 'Total Expense 总支出' : 'Total Expense'}</span><span>${fmt(totalExpense)}</span>
          </div>
          <table style={{ width:'100%' }}>
            <tbody>
              <tr><td style={{ padding:6, textIndent:'4ch' }}>{showChinese ? 'Management Fee 管理费' : 'Management Fee'}</td><td style={{ textAlign:'right', padding:6 }}>-${fmt(managementFee)}</td></tr>
              <tr><td style={{ padding:6, textIndent:'4ch' }}>{showChinese ? 'Electricity 电费' : 'Electricity'}</td><td style={{ textAlign:'right', padding:6 }}>-${fmt(catElectricity)}</td></tr>
              <tr><td style={{ padding:6, textIndent:'4ch' }}>{showChinese ? 'Water 水费' : 'Water'}</td><td style={{ textAlign:'right', padding:6 }}>-${fmt(catWater)}</td></tr>
              <tr><td style={{ padding:6, textIndent:'4ch' }}>{showChinese ? 'Gas / Hot water 煤气费 / 热水费' : 'Gas / Hot water'}</td><td style={{ textAlign:'right', padding:6 }}>-${fmt(catGas)}</td></tr>
              <tr><td style={{ padding:6, textIndent:'4ch' }}>{showChinese ? 'Internet 网费' : 'Internet'}</td><td style={{ textAlign:'right', padding:6 }}>-${fmt(catInternet)}</td></tr>
              <tr><td style={{ padding:6, textIndent:'4ch' }}>{showChinese ? 'Monthly Consumable 消耗品费' : 'Monthly Consumable'}</td><td style={{ textAlign:'right', padding:6 }}>-${fmt(catConsumable)}</td></tr>
              <tr><td style={{ padding:6, textIndent:'4ch' }}>{showChinese ? 'Carpark 车位费' : 'Carpark'}</td><td style={{ textAlign:'right', padding:6 }}>-${fmt(catCarpark)}</td></tr>
              <tr><td style={{ padding:6, textIndent:'4ch' }}>{showChinese ? `Owner's Corporation 物业费` : `Owner's Corporation`}</td><td style={{ textAlign:'right', padding:6 }}>-${fmt(catOwnerCorp)}</td></tr>
              <tr><td style={{ padding:6, textIndent:'4ch' }}>{showChinese ? 'Council Rate 市政费' : 'Council Rate'}</td><td style={{ textAlign:'right', padding:6 }}>-${fmt(catCouncil)}</td></tr>
              <tr><td style={{ padding:6, textIndent:'4ch' }}>{showChinese ? 'Other Expense 其他支出' : 'Other Expense'}</td><td style={{ textAlign:'right', padding:6 }}>-${fmt(catOther)}</td></tr>
              <tr>
                <td style={{ padding:6, textIndent:'4ch', whiteSpace:'nowrap' }}>{showChinese ? 'Other Expense Desc 其他支出描述' : 'Other Expense Desc'}</td>
                <td
                  style={{ padding:6, textAlign:'right', whiteSpace:'normal', wordBreak:'break-word', overflowWrap:'anywhere' }}
                  title={otherExpenseDescFmt.full || undefined}
                >
                  {otherExpenseDescFmt.text}
                </td>
              </tr>
            </tbody>
          </table>
        </>
      )}

      <div data-statement-row="1" style={{ fontWeight: 700, display:'flex', justifyContent:'space-between', padding:'6px 8px', marginTop: 8 }}>
        <span>{showChinese ? 'Net Income 净收入' : 'Net Income'}</span><span>${fmt(netIncome)}</span>
      </div>

      {showBalance && balance && (
        <>
          <div data-keep-with-next="true" style={{ fontWeight: 600, marginTop: 16, background:'#eef3fb', padding:'6px 8px' }}>
            {hasFurniture ? (showChinese ? 'Furniture cost & carry-over 家具费用与结转' : 'Furniture cost & carry-over') : (showChinese ? 'Carry-over 结转' : 'Carry-over')}
          </div>
          <table style={{ width:'100%' }}>
            <tbody>
              {hasCarry ? (
                <tr>
                  <td style={{ padding:6, textIndent:'4ch' }}>{showChinese ? 'Carry-over from last month 上月结转金额' : 'Carry-over from last month'}</td>
                  <td style={{ textAlign:'right', padding:6 }}>${fmt(balance.opening_carry_net)}</td>
                </tr>
              ) : null}

              {hasFurniture ? (
                <tr>
                  <td style={{ padding:6, textIndent:'4ch' }}>{showChinese ? 'Furniture balance to offset (start) 家具费用待抵扣（期初）' : 'Furniture balance to offset (start)'}</td>
                  <td style={{ textAlign:'right', padding:6 }}>${fmt(balance.furniture_opening_outstanding)}</td>
                </tr>
              ) : null}
              {hasFurniture ? (
                <tr>
                  <td style={{ padding:6, textIndent:'4ch' }}>{showChinese ? 'New furniture cost this month 本月新增家具费用' : 'New furniture cost this month'}</td>
                  <td style={{ textAlign:'right', padding:6 }}>${fmt(balance.furniture_charge)}</td>
                </tr>
              ) : null}
              {hasFurniture ? (
                <tr>
                  <td style={{ padding:6, textIndent:'4ch' }}>{showChinese ? 'Owner paid furniture cost 房东本月已支付家具费用' : 'Owner paid furniture cost'}</td>
                  <td style={{ textAlign:'right', padding:6 }}>${fmt(balance.furniture_owner_paid)}</td>
                </tr>
              ) : null}
              {hasFurniture ? (
                <tr>
                  <td style={{ padding:6, textIndent:'4ch' }}>{showChinese ? 'Offset from rent this month 本月从租金中抵扣家具费用' : 'Offset from rent this month'}</td>
                  <td style={{ textAlign:'right', padding:6 }}>-${fmt(balance.furniture_offset_from_rent)}</td>
                </tr>
              ) : null}
              {hasFurniture ? (
                <tr>
                  <td style={{ padding:6, textIndent:'4ch' }}>{showChinese ? 'Furniture balance to offset (end) 家具费用待抵扣（期末）' : 'Furniture balance to offset (end)'}</td>
                  <td style={{ textAlign:'right', padding:6 }}>${fmt(balance.furniture_closing_outstanding)}</td>
                </tr>
              ) : null}

              {hasCarry ? (
                <tr>
                  <td style={{ padding:6, textIndent:'4ch' }}>{showChinese ? 'Carry-over to next month 下月结转金额' : 'Carry-over to next month'}</td>
                  <td style={{ textAlign:'right', padding:6 }}>${fmt(balance.closing_carry_net)}</td>
                </tr>
              ) : null}
            </tbody>
          </table>
          <div data-statement-row="1" style={{ fontWeight: 700, display:'flex', justifyContent:'space-between', padding:'6px 8px', marginTop: 8 }}>
            <span>{showChinese ? 'Amount payable to owner 本月应付房东' : 'Amount payable to owner'}</span><span>${fmt(balance.payable_to_owner)}</span>
          </div>
        </>
      )}

      <div data-keep-with-next="true" style={{ marginTop: 16, fontWeight: 600, background:'#eef3fb', padding:'6px 8px' }}>{showChinese ? 'Rent Records 租金记录' : 'Rent Records'}</div>
      <table style={{ width:'100%', borderCollapse:'collapse' }}>
        <thead>
          <tr>
            <th style={{ textAlign:'left', padding:6, borderBottom:'1px solid #ddd' }}>{showChinese ? '入住' : 'Check-in'}</th>
            <th style={{ textAlign:'left', padding:6, borderBottom:'1px solid #ddd' }}>{showChinese ? '退房' : 'Check-out'}</th>
            <th style={{ textAlign:'right', padding:6, borderBottom:'1px solid #ddd' }}>{showChinese ? '晚数' : 'Nights'}</th>
            <th style={{ textAlign:'right', padding:6, borderBottom:'1px solid #ddd' }}>{showChinese ? '金额' : 'Amount'}</th>
          </tr>
        </thead>
        <tbody>
          {relatedOrdersSorted.map(r => (
            <tr key={(r as any).__rid || r.id}>
              <td style={{ padding:6 }}>{r.checkin ? dayjs(toDayStr(r.checkin)).format('DD/MM/YYYY') : ''}</td>
              <td style={{ padding:6 }}>{r.checkout ? dayjs(toDayStr(r.checkout)).format('DD/MM/YYYY') : ''}</td>
              <td style={{ padding:6, textAlign:'right' }}>{r.nights ?? Math.max(dayjs(toDayStr(r.checkout!)).startOf('day').diff(dayjs(toDayStr(r.checkin!)).startOf('day'), 'day'), 0)}</td>
              <td style={{ padding:6, textAlign:'right' }}>${fmt(Number(((r as any).visible_net_income ?? (r as any).net_income ?? 0)))}</td>
            </tr>
          ))}
        </tbody>
      </table>


      <div data-keep-with-next="true" style={{ marginTop: 16, fontWeight: 600, background:'#eef3fb', padding:'6px 8px' }}>{showChinese ? 'Order Calendar 订单日历' : 'Order Calendar'}</div>
      {(() => {
        const weeks: Array<{ ws: any; we: any }> = []
        let cur = weekStart.clone()
        while (cur.isBefore(weekEnd.add(1,'day'))) { const ws = cur.clone(); const we = cur.clone().endOf('week'); weeks.push({ ws, we }); cur = cur.add(1,'week') }
        return (
          <div className="landlord-calendar" style={{ background:'#fff', border:'1px solid #eef2f7', borderRadius:12, padding:8 }}>
            {weeks.map(({ ws, we }, idx) => {
              const { segs, laneMap, laneCount } = buildWeekSegments(ws, we)
              const daysRow = Array.from({ length: 7 }).map((_, i) => ws.startOf('day').add(i, 'day'))
              const hasMonthDay = daysRow.some(d => d.isSame(start, 'month'))
              if (!hasMonthDay && segs.length === 0) return null
              return (
                <div key={idx} data-pdf-avoid-cut="true" style={{ position:'relative', minHeight: Math.max(120, laneCount * 36 + 48), margin:'6px 0' }}>
                  <div style={{ display:'grid', gridTemplateColumns:'repeat(7, 1fr)', gap:0, padding:'2px 0', fontSize:11 }}>
                    {daysRow.map((d, i) => {
                      const inMonth = d.isSame(start, 'month')
                      return (
                        <div key={i} style={{ textAlign:'center', color: inMonth ? '#4b5563' : '#bfbfbf', fontWeight: inMonth ? 600 : 400 }}>
                          {d.format('DD/MM')}
                        </div>
                      )
                    })}
                  </div>
                  {daysRow.map((d, dIdx) => {
                    const inMonth = d.isSame(start, 'month')
                    return (
                      <div key={dIdx} style={{ position:'absolute', left: `${(dIdx * 100) / 7}%`, width: `${100/7}%`, top: 22, bottom:0 }}>
                        {!inMonth ? <div style={{ position:'absolute', inset:0, background:'#f9fafb', opacity:0.7, pointerEvents:'none', zIndex:0 }} /> : null}
                        <div style={{ position:'absolute', right:0, top:0, bottom:0, width:1, borderRight:'1px dashed #eee' }} />
                      </div>
                    )
                  })}
                  {segs.map(seg => {
                    const o = seg.o as any
                    const isStart = seg.startIdx === Math.max(0, parseDateOnly(toDayStr(o.checkin)).diff(ws.startOf('day'),'day'))
                    const isEnd = seg.endIdx === Math.max(0, parseDateOnly(toDayStr(o.checkout)).subtract(1,'day').diff(ws.startOf('day'),'day'))
                    const platform = (() => {
                      const s = String(o.source || '').toLowerCase()
                      if (s.startsWith('airbnb')) return 'airbnb'
                      if (s.startsWith('booking')) return 'booking'
                      if (s === 'offline') return 'offline'
                      return 'other'
                    })()
                    const leftPct = (seg.startIdx * 100) / 7
                    const rightPct = ((6 - seg.endIdx) * 100) / 7
                    const lane = laneMap[seg.id] || 0
                    return (
                      <div
                        key={seg.id}
                        className={`mz-evt mz-evt--${platform} mz-lane-${lane} ${isStart ? 'fc-event-start' : ''} ${isEnd ? 'fc-event-end' : ''}`}
                        style={{ position:'absolute', left: `${leftPct}%`, right: `${rightPct}%`, top: 28 + lane * 36, height: 28, zIndex: 1 }}
                      >
                        <div
                          className="mz-booking"
                          style={{ borderWidth: 2, borderStyle:'solid', width:'100%', height:'100%', padding:'0 8px', boxSizing:'border-box', display:'flex', alignItems:'center', justifyContent:'space-between', fontSize:12 }}
                        >
                          <span className="bar-left" style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', fontWeight:500 }}>
                            {String(o.guest_name || '')}
                          </span>
                          <span className="bar-right" style={{ fontWeight:600 }}>
                            {(() => {
                              const v = Number((o as any).visible_net_income ?? (o as any).net_income ?? 0)
                              const visibleNet = Math.max(0, Number(v.toFixed(2)))
                              return `$${fmt(visibleNet)}`
                            })()}
                          </span>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )
            })}
          </div>
        )
      })()}

      {(deepCleanings && deepCleanings.length) ? (
        <div data-deep-clean-section="1" data-pdf-break-before={pdfMode ? 'true' : undefined}>
          <div data-keep-with-next="true" style={{ marginTop: 16, fontWeight: 600, background:'#eef3fb', padding:'6px 8px' }}>{showChinese ? 'Deep Cleaning Maintenance 深度清洁维护' : 'Deep Cleaning Maintenance'}</div>
          {!pdfMode ? (
            <div style={{ display:'flex', justifyContent:'flex-end', marginTop: 8 }}>
              <button
                type="button"
                onClick={() => setExpandAllDeepClean(v => !v)}
                style={{ border:'1px solid #e5e7eb', background:'#fff', borderRadius: 8, padding:'6px 10px', fontSize: 12, cursor:'pointer' }}
              >
                {expandAllDeepClean ? '收起全部照片' : '展开全部照片'}
              </button>
            </div>
          ) : null}
          <div style={{ display:'flex', flexDirection:'column', gap: 12 }}>
            {deepCleanings
              .slice()
              .sort((a: any, b: any) => String(a?.occurred_at || '').localeCompare(String(b?.occurred_at || '')))
              .map((d: any) => {
                const date = String(d?.completed_at || d?.occurred_at || '').slice(0, 10)
                const startTime = d?.started_at ? dayjs(String(d.started_at)).format('HH:mm') : ''
                const endTime = d?.ended_at ? dayjs(String(d.ended_at)).format('HH:mm') : ''
                const timeLabel = [date, (startTime || endTime) ? `${startTime || '-'}~${endTime || '-'}` : ''].filter(Boolean).join(' ')
                const did = String(d?.id || '')
                const beforeArr = (() => {
                  const raw: any = (d as any)?.photo_urls
                  if (Array.isArray(raw)) return raw
                  if (typeof raw === 'string') { try { const j = JSON.parse(raw); return Array.isArray(j) ? j : [] } catch { return [] } }
                  return []
                })().map((u: any) => String(u || '')).filter(Boolean)
                const afterArr = (() => {
                  const raw: any = (d as any)?.repair_photo_urls
                  if (Array.isArray(raw)) return raw
                  if (typeof raw === 'string') { try { const j = JSON.parse(raw); return Array.isArray(j) ? j : [] } catch { return [] } }
                  return []
                })().map((u: any) => String(u || '')).filter(Boolean)
                const expanded = !!pdfMode || !!expandAllDeepClean || !!expandedDeepClean[did]
                const beforeShow = expanded ? beforeArr : beforeArr.slice(0, 2)
                const afterShow = expanded ? afterArr : afterArr.slice(0, 2)
                const pairRows = (() => {
                  const n = Math.max(beforeArr.length, afterArr.length)
                  const rows: Array<{ b?: string; a?: string; idx: number }> = []
                  for (let i = 0; i < n; i++) rows.push({ b: beforeArr[i], a: afterArr[i], idx: i })
                  return rows
                })()
                return (
                  <div
                    key={did || String(d?.work_no || '')}
                    data-pdf-avoid-cut={pdfMode ? 'true' : undefined}
                    data-pdf-break-before={(pdfMode && pairRows.length > 6) ? 'true' : undefined}
                    style={{ border:'1px solid #eaeef5', borderRadius: 12, padding: 12 }}
                  >
                    <div style={{ display:'flex', justifyContent:'space-between', gap: 12, flexWrap:'wrap' }}>
                      <div style={{ fontWeight: 700 }}>{String(d?.work_no || d?.id || '')}</div>
                      <div style={{ color:'#111' }}>{timeLabel || '-'}</div>
                      <div style={{ color:'#111' }}>{showChinese ? `区域：${String(d?.category || '-')}` : `Area: ${String(d?.category || '-')}`}</div>
                    </div>
                    {pdfMode ? (
                      <div style={{ display:'flex', flexDirection:'column', gap: 10, marginTop: 10 }}>
                        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap: 12, fontWeight: 600 }}>
                          <div>Before</div>
                          <div>After</div>
                        </div>
                        {(pairRows.length ? pairRows : [{ idx: 0 }]).map((r) => (
                          <div key={r.idx} data-pdf-avoid-cut="true" style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap: 12, alignItems:'start' }}>
                            <div style={{ border:'1px solid #eee', borderRadius: 10, padding: 8, minHeight: 240 }}>
                              {r.b ? (isImg(r.b) ? (
                                renderEngine === 'print'
                                  ? <img crossOrigin="anonymous" src={resolveUrl(r.b)} style={{ width:'100%', height: 360, objectFit:'contain', borderRadius: 8 }} />
                                  : <div style={{ width:'100%', height: 360, borderRadius: 8, backgroundColor:'#fff', backgroundImage: `url(${resolveUrl(r.b)})`, backgroundRepeat:'no-repeat', backgroundPosition:'center', backgroundSize:'contain' }} />
                              ) : (
                                <a href={resolveUrl(r.b)} target="_blank" rel="noreferrer">{String(r.b).split('/').pop() || 'file'}</a>
                              )) : <div style={{ color:'#999' }}>-</div>}
                            </div>
                            <div style={{ border:'1px solid #eee', borderRadius: 10, padding: 8, minHeight: 240 }}>
                              {r.a ? (isImg(r.a) ? (
                                renderEngine === 'print'
                                  ? <img crossOrigin="anonymous" src={resolveUrl(r.a)} style={{ width:'100%', height: 360, objectFit:'contain', borderRadius: 8 }} />
                                  : <div style={{ width:'100%', height: 360, borderRadius: 8, backgroundColor:'#fff', backgroundImage: `url(${resolveUrl(r.a)})`, backgroundRepeat:'no-repeat', backgroundPosition:'center', backgroundSize:'contain' }} />
                              ) : (
                                <a href={resolveUrl(r.a)} target="_blank" rel="noreferrer">{String(r.a).split('/').pop() || 'file'}</a>
                              )) : <div style={{ color:'#999' }}>-</div>}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <>
                        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap: 12, marginTop: 10 }}>
                      <div>
                            <div style={{ fontWeight: 600, marginBottom: 6 }}>Before</div>
                            <div style={{ display:'grid', gridTemplateColumns: expanded ? 'repeat(2, 1fr)' : '1fr', gap: 10 }}>
                              {beforeShow.length ? beforeShow.map((u: string, idx: number) => (
                                <div key={idx} style={{ border:'1px solid #eee', borderRadius: 10, padding: 8 }}>
                                  {isImg(u) ? <img crossOrigin="anonymous" loading="lazy" decoding="async" src={resolveUrl(u)} style={{ width:'100%', height: expanded ? 140 : 170, objectFit:'contain', borderRadius: 8 }} /> : <a href={resolveUrl(u)} target="_blank" rel="noreferrer">{u.split('/').pop() || 'file'}</a>}
                                </div>
                              )) : <div style={{ color:'#999' }}>-</div>}
                            </div>
                            {!expanded && beforeArr.length > beforeShow.length ? <div style={{ marginTop: 6, fontSize: 12, color:'#6b7280' }}>{`+${beforeArr.length - beforeShow.length}`}</div> : null}
                          </div>
                          <div>
                            <div style={{ fontWeight: 600, marginBottom: 6 }}>After</div>
                            <div style={{ display:'grid', gridTemplateColumns: expanded ? 'repeat(2, 1fr)' : '1fr', gap: 10 }}>
                              {afterShow.length ? afterShow.map((u: string, idx: number) => (
                                <div key={idx} style={{ border:'1px solid #eee', borderRadius: 10, padding: 8 }}>
                                  {isImg(u) ? <img crossOrigin="anonymous" loading="lazy" decoding="async" src={resolveUrl(u)} style={{ width:'100%', height: expanded ? 140 : 170, objectFit:'contain', borderRadius: 8 }} /> : <a href={resolveUrl(u)} target="_blank" rel="noreferrer">{u.split('/').pop() || 'file'}</a>}
                                </div>
                              )) : <div style={{ color:'#999' }}>-</div>}
                            </div>
                            {!expanded && afterArr.length > afterShow.length ? <div style={{ marginTop: 6, fontSize: 12, color:'#6b7280' }}>{`+${afterArr.length - afterShow.length}`}</div> : null}
                          </div>
                        </div>
                        {(!expanded && (beforeArr.length > 2 || afterArr.length > 2)) ? (
                          <div style={{ display:'flex', justifyContent:'flex-end', marginTop: 10 }}>
                            <button
                              type="button"
                              onClick={() => setExpandedDeepClean(m => ({ ...m, [did]: true }))}
                              style={{ border:'1px solid #e5e7eb', background:'#fff', borderRadius: 8, padding:'6px 10px', fontSize: 12, cursor:'pointer' }}
                            >
                              展开本条照片
                            </button>
                          </div>
                        ) : null}
                      </>
                    )}
                  </div>
                )
              })}
          </div>
        </div>
      ) : null}

      {(maintenances && maintenances.length) ? (
        <div data-maint-section="1" data-pdf-break-before={pdfMode ? 'true' : undefined}>
          <div data-keep-with-next="true" style={{ marginTop: 16, fontWeight: 600, background:'#eef3fb', padding:'6px 8px' }}>
            {showChinese ? 'Maintenance Repairs 维修记录' : 'Maintenance Repairs'}
          </div>
          {!pdfMode ? (
            <div style={{ display:'flex', justifyContent:'flex-end', marginTop: 8 }}>
              <button
                type="button"
                onClick={() => setExpandAllMaintenance(v => !v)}
                style={{ border:'1px solid #e5e7eb', background:'#fff', borderRadius: 8, padding:'6px 10px', fontSize: 12, cursor:'pointer' }}
              >
                {expandAllMaintenance ? '收起全部照片' : '展开全部照片'}
              </button>
            </div>
          ) : null}
          <div style={{ display:'flex', flexDirection:'column', gap: 12 }}>
            {maintenances
              .slice()
              .sort((a: any, b: any) => String(a?.occurred_at || '').localeCompare(String(b?.occurred_at || '')))
              .map((m: any) => {
                const date = String(m?.completed_at || m?.occurred_at || '').slice(0, 10)
                const startTime = m?.started_at ? dayjs(String(m.started_at)).format('HH:mm') : ''
                const endTime = m?.ended_at ? dayjs(String(m.ended_at)).format('HH:mm') : ''
                const timeLabel = [date, (startTime || endTime) ? `${startTime || '-'}~${endTime || '-'}` : ''].filter(Boolean).join(' ')
                const mid = String(m?.id || '')
                const summaryRaw = (summaryFromDetails((m as any)?.details) || '').split('\n').map((x: any) => String(x || '').trim()).filter(Boolean)[0] || ''
                const summary = summaryRaw || String((m as any)?.repair_notes || '').trim() || String(m?.category || '').trim()
                const urlArr = (raw: any) => {
                  if (Array.isArray(raw)) return raw
                  if (typeof raw === 'string') { try { const j = JSON.parse(raw); return Array.isArray(j) ? j : [] } catch { return [] } }
                  return []
                }
                const beforeArr = urlArr((m as any)?.photo_urls).map((u: any) => String(u || '')).filter(Boolean)
                const afterArr = urlArr((m as any)?.repair_photo_urls).map((u: any) => String(u || '')).filter(Boolean)
                const expanded = !!pdfMode || !!expandAllMaintenance || !!expandedMaintenance[mid]
                const beforeShow = expanded ? beforeArr : beforeArr.slice(0, 2)
                const afterShow = expanded ? afterArr : afterArr.slice(0, 2)
                const pairRows = (() => {
                  const n = Math.max(beforeArr.length, afterArr.length)
                  const rows: Array<{ b?: string; a?: string; idx: number }> = []
                  for (let i = 0; i < n; i++) rows.push({ b: beforeArr[i], a: afterArr[i], idx: i })
                  return rows
                })()
                return (
                  <div
                    key={mid || String(m?.work_no || '')}
                    data-pdf-avoid-cut={pdfMode ? 'true' : undefined}
                    data-pdf-break-before={(pdfMode && pairRows.length > 2) ? 'true' : undefined}
                    style={{ border:'1px solid #eaeef5', borderRadius: 12, padding: 12 }}
                  >
                    <div style={{ display:'flex', justifyContent:'space-between', gap: 12, flexWrap:'wrap' }}>
                      <div style={{ fontWeight: 700 }}>{String(m?.work_no || m?.id || '')}</div>
                      <div style={{ color:'#111' }}>{timeLabel || '-'}</div>
                      <div style={{ color:'#111' }}>{showChinese ? `区域：${String(m?.category || '-')}` : `Area: ${String(m?.category || '-')}`}</div>
                    </div>
                    {summary ? <div style={{ marginTop: 8, whiteSpace:'pre-wrap' }}>{summary}</div> : null}
                    {pdfMode ? (
                      <div style={{ display:'flex', flexDirection:'column', gap: 10, marginTop: 10 }}>
                        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap: 12, fontWeight: 600 }}>
                          <div>Before</div>
                          <div>After</div>
                        </div>
                        {(pairRows.length ? pairRows : [{ idx: 0 }]).map((r) => (
                          <div
                            key={r.idx}
                            data-pdf-avoid-cut="true"
                            data-pdf-break-before={(r.idx > 0 && r.idx % 2 === 0) ? 'true' : undefined}
                            style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap: 12, alignItems:'start' }}
                          >
                            <div style={{ border:'1px solid #eee', borderRadius: 10, padding: 8, minHeight: 240 }}>
                              {r.b ? (isImg(r.b) ? (
                                renderEngine === 'print'
                                  ? <img crossOrigin="anonymous" src={resolveUrl(r.b)} style={{ width:'100%', height: 360, objectFit:'contain', borderRadius: 8 }} />
                                  : <div style={{ width:'100%', height: 360, borderRadius: 8, backgroundColor:'#fff', backgroundImage: `url(${resolveUrl(r.b)})`, backgroundRepeat:'no-repeat', backgroundPosition:'center', backgroundSize:'contain' }} />
                              ) : (
                                <a href={resolveUrl(r.b)} target="_blank" rel="noreferrer">{String(r.b).split('/').pop() || 'file'}</a>
                              )) : <div style={{ color:'#999' }}>-</div>}
                            </div>
                            <div style={{ border:'1px solid #eee', borderRadius: 10, padding: 8, minHeight: 240 }}>
                              {r.a ? (isImg(r.a) ? (
                                renderEngine === 'print'
                                  ? <img crossOrigin="anonymous" src={resolveUrl(r.a)} style={{ width:'100%', height: 360, objectFit:'contain', borderRadius: 8 }} />
                                  : <div style={{ width:'100%', height: 360, borderRadius: 8, backgroundColor:'#fff', backgroundImage: `url(${resolveUrl(r.a)})`, backgroundRepeat:'no-repeat', backgroundPosition:'center', backgroundSize:'contain' }} />
                              ) : (
                                <a href={resolveUrl(r.a)} target="_blank" rel="noreferrer">{String(r.a).split('/').pop() || 'file'}</a>
                              )) : <div style={{ color:'#999' }}>-</div>}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <>
                        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap: 12, marginTop: 10 }}>
                          <div>
                            <div style={{ fontWeight: 600, marginBottom: 6 }}>Before</div>
                            <div style={{ display:'grid', gridTemplateColumns: expanded ? 'repeat(2, 1fr)' : '1fr', gap: 10 }}>
                              {beforeShow.length ? beforeShow.map((u: string, idx: number) => (
                                <div key={idx} style={{ border:'1px solid #eee', borderRadius: 10, padding: 8 }}>
                                  {isImg(u) ? <img crossOrigin="anonymous" loading="lazy" decoding="async" src={resolveUrl(u)} style={{ width:'100%', height: expanded ? 140 : 170, objectFit:'contain', borderRadius: 8 }} /> : <a href={resolveUrl(u)} target="_blank" rel="noreferrer">{u.split('/').pop() || 'file'}</a>}
                                </div>
                              )) : <div style={{ color:'#999' }}>-</div>}
                            </div>
                            {!expanded && beforeArr.length > beforeShow.length ? <div style={{ marginTop: 6, fontSize: 12, color:'#6b7280' }}>{`+${beforeArr.length - beforeShow.length}`}</div> : null}
                          </div>
                          <div>
                            <div style={{ fontWeight: 600, marginBottom: 6 }}>After</div>
                            <div style={{ display:'grid', gridTemplateColumns: expanded ? 'repeat(2, 1fr)' : '1fr', gap: 10 }}>
                              {afterShow.length ? afterShow.map((u: string, idx: number) => (
                                <div key={idx} style={{ border:'1px solid #eee', borderRadius: 10, padding: 8 }}>
                                  {isImg(u) ? <img crossOrigin="anonymous" loading="lazy" decoding="async" src={resolveUrl(u)} style={{ width:'100%', height: expanded ? 140 : 170, objectFit:'contain', borderRadius: 8 }} /> : <a href={resolveUrl(u)} target="_blank" rel="noreferrer">{u.split('/').pop() || 'file'}</a>}
                                </div>
                              )) : <div style={{ color:'#999' }}>-</div>}
                            </div>
                            {!expanded && afterArr.length > afterShow.length ? <div style={{ marginTop: 6, fontSize: 12, color:'#6b7280' }}>{`+${afterArr.length - afterShow.length}`}</div> : null}
                          </div>
                        </div>
                        {(!expanded && (beforeArr.length > 2 || afterArr.length > 2)) ? (
                          <div style={{ display:'flex', justifyContent:'flex-end', marginTop: 10 }}>
                            <button
                              type="button"
                              onClick={() => setExpandedMaintenance(mm => ({ ...mm, [mid]: true }))}
                              style={{ border:'1px solid #e5e7eb', background:'#fff', borderRadius: 8, padding:'6px 10px', fontSize: 12, cursor:'pointer' }}
                            >
                              展开本条照片
                            </button>
                          </div>
                        ) : null}
                      </>
                    )}
                  </div>
                )
              })}
          </div>
        </div>
      ) : null}

      {showInvoices && (
      <>
      <div data-keep-with-next="true" style={{ marginTop: 24, fontWeight: 600, background:'#eef3fb', padding:'6px 8px' }}>{showChinese ? 'Expense Invoices 支出发票' : 'Expense Invoices'}</div>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(2, 1fr)', gap: 12 }}>
        {expensesInMonthAll.map(e => {
          const eid = String((e as any).id)
          const invs = (invoiceMap[eid] || []).slice()
          if (!invs.length) {
            const cat = catKey(e)
            const txInv = (txs || []).filter(t => {
              if (t.kind !== 'expense') return false
              const baseDateRaw: any = (t as any).paid_date || t.occurred_at || (t as any).created_at
              const inMonth = baseDateRaw ? dayjs(toDayStr(baseDateRaw)).isSame(start, 'month') : false
              const sameCat = catKey(t) === cat
              const hasUrl = !!(t as any).invoice_url
              const samePid = (!propertyId) || (t.property_id === propertyId)
              return inMonth && sameCat && hasUrl && samePid
            })
            txInv.forEach((t: any, idx: number) => {
              const url = /^https?:\/\//.test(String(t.invoice_url || '')) ? String(t.invoice_url) : `${API_BASE}${String(t.invoice_url || '')}`
              invs.push({ id: `tx-${eid}-${idx}`, expense_id: eid, url } as any)
            })
          }
          return (
            <div key={eid} style={{ border:'1px solid #eee', padding:8 }}>
              <div style={{ display:'flex', justifyContent:'space-between' }}>
                <span>{(e as any).category || (showChinese ? '其他' : 'Other')}</span>
                <span>-${fmt(Number((e as any).amount||0))}</span>
              </div>
              <div style={{ fontSize:12 }}>{dayjs(toDayStr((e as any).occurred_at)).format('DD/MM/YYYY')}</div>
              {invs.length ? (
                <div style={{ display:'grid', gridTemplateColumns:'repeat(2, 1fr)', gap: 8, marginTop:6 }}>
                  {invs.map((iv) => {
                    const u = resolveUrl(iv.url)
                    return isImg(iv.url) ? (
                      <img key={iv.id} src={u} style={{ width:'100%' }} alt="invoice" />
                    ) : isPdf(iv.url) ? (
                      <object key={iv.id} data={u} type="application/pdf" style={{ width:'100%', height: 300 }}>
                        <a href={u} target="_blank" rel="noreferrer">{showChinese ? '查看发票' : 'View invoice'}</a>
                      </object>
                    ) : (
                      <a key={iv.id} href={u} target="_blank" rel="noreferrer">{showChinese ? '查看发票' : 'View invoice'}</a>
                    )
                  })}
                </div>
              ) : (
                <div style={{ fontSize:12, color:'#888', marginTop:6 }}>{showChinese ? '未上传发票' : 'No invoice uploaded'}</div>
              )}
            </div>
          )
        })}
      </div>
      </>
      )}
    </div>
  )
})
