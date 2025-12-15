"use client"
import { Table, Card, Space, Button, Form, InputNumber, Select, DatePicker, Input, App, Modal, Tag } from 'antd'
import dayjs from 'dayjs'
import minMax from 'dayjs/plugin/minMax'
import isSameOrAfter from 'dayjs/plugin/isSameOrAfter'
dayjs.extend(minMax)
dayjs.extend(isSameOrAfter)
import { useEffect, useState, useMemo, useRef } from 'react'
import { API_BASE, authHeaders } from '../../lib/api'
import { hasPerm } from '../../lib/auth'

type Tx = { id: string; kind: 'income'|'expense'; amount: number; currency: string; occurred_at: string; note?: string; category?: string }
type Order = { id: string; source?: string; checkin?: string; checkout?: string; price?: number; property_id?: string; avg_nightly_price?: number; nights?: number; net_income?: number }
type Payout = { id: string; landlord_id: string; period_from: string; period_to: string; amount: number; invoice_no?: string; status: string }
type Landlord = { id: string; name: string }
type Property = { id: string; code?: string; region?: string }
type PropertyExpense = { id: string; property_id?: string; amount?: number; occurred_at?: string }

export default function FinancePage() {
  const [txs, setTxs] = useState<Tx[]>([])
  const [payouts, setPayouts] = useState<Payout[]>([])
  const [landlords, setLandlords] = useState<Landlord[]>([])
  const [orders, setOrders] = useState<Order[]>([])
  const [properties, setProperties] = useState<Property[]>([])
  const [propExpenses, setPropExpenses] = useState<PropertyExpense[]>([])
  const [txOpen, setTxOpen] = useState(false)
  const [payoutOpen, setPayoutOpen] = useState(false)
  const [payoutEditOpen, setPayoutEditOpen] = useState(false)
  const [txForm] = Form.useForm()
  const [pForm] = Form.useForm()
  const [pEditForm] = Form.useForm()
  const { message, modal } = App.useApp()
  const [editingPayout, setEditingPayout] = useState<Payout | null>(null)

  async function load() {
    const [t, p, l, o, props, exps] = await Promise.all([
      fetch(`${API_BASE}/finance`, { headers: authHeaders() }).then(r => r.ok ? r.json() : []),
      fetch(`${API_BASE}/finance/payouts`, { headers: authHeaders() }).then(r => r.ok ? r.json() : []),
      fetch(`${API_BASE}/landlords`, { headers: authHeaders() }).then(r => r.ok ? r.json() : []),
      fetch(`${API_BASE}/orders`, { headers: authHeaders() }).then(r => r.ok ? r.json() : []),
      fetch(`${API_BASE}/properties`, { headers: authHeaders() }).then(r => r.ok ? r.json() : []),
      fetch(`${API_BASE}/crud/property_expenses`, { headers: authHeaders() }).then(r => r.ok ? r.json() : []),
    ])
    setTxs(t); setPayouts(p); setLandlords(l); setOrders(Array.isArray(o) ? o : [])
    setProperties(Array.isArray(props) ? props : [])
    setPropExpenses(Array.isArray(exps) ? exps : [])
  }
  useEffect(() => { load() }, [])

  const monthStart = useMemo(() => dayjs().startOf('month'), [])
  const monthEnd = useMemo(() => dayjs().endOf('month'), [])

  const totals = useMemo(() => {
    const inMonth = (d: string) => {
      const x = dayjs(d)
      return x.isAfter(monthStart.subtract(1, 'millisecond')) && x.isBefore(monthEnd.add(1, 'millisecond'))
    }
    const txIncome = txs.filter(t => t.kind === 'income' && inMonth(t.occurred_at)).reduce((s, x) => s + Number(x.amount || 0), 0)
    const txExpense = txs.filter(t => t.kind === 'expense' && inMonth(t.occurred_at)).reduce((s, x) => s + Number(x.amount || 0), 0)
    const rentIncome = orders.reduce((s, x) => {
      const ci = x.checkin ? dayjs(x.checkin) : null
      const co = x.checkout ? dayjs(x.checkout) : null
      if (!ci || !co) return s
      const totalN = Math.max(co.diff(ci, 'day'), 0)
      if (!totalN) return s
      const segStart = ci.isAfter(monthStart) ? ci : monthStart
      const segEnd = co.isBefore(monthEnd) ? co : monthEnd
      const segN = Math.max(segEnd.diff(segStart, 'day'), 0)
      const perDay = Number(x.price || 0) / totalN
      return s + perDay * segN
    }, 0)
    const propExp = propExpenses.reduce((s, ex) => {
      const t = ex.occurred_at ? dayjs(ex.occurred_at) : null
      if (!t) return s
      if (t.isAfter(monthStart.subtract(1,'day')) && t.isBefore(monthEnd.add(1,'day'))) return s + Number(ex.amount || 0)
      return s
    }, 0)
    const income = rentIncome + txIncome
    const expense = txExpense + propExp
    const net = Math.round(((income - expense) + Number.EPSILON) * 100) / 100
    return { totalIncome: Math.round((income + Number.EPSILON) * 100) / 100, totalExpense: Math.round((expense + Number.EPSILON) * 100) / 100, net }
  }, [txs, orders, propExpenses, monthStart, monthEnd])

  const platformShare = useMemo(() => {
    const byKey: Record<string, number> = {}
    for (const o of orders) {
      const k = (o.source || 'other').toLowerCase()
      byKey[k] = (byKey[k] || 0) + Number(o.price || 0)
    }
    const total = Object.values(byKey).reduce((s, v) => s + v, 0)
    const rows = Object.entries(byKey).map(([key, value]) => ({ key, value, ratio: total > 0 ? (value / total) : 0, percent: total > 0 ? Math.round((value / total) * 100) : 0 }))
    rows.sort((a, b) => b.value - a.value)
    return rows
  }, [orders])

  const last6MonthsTrend = useMemo(() => {
    const base = dayjs()
    const months: { month: string; net: number }[] = []
    for (let i = 5; i >= 0; i--) {
      const mStart = base.subtract(i, 'month').startOf('month')
      const mEnd = base.subtract(i, 'month').endOf('month')
      const inMonth = (d: string) => {
        const x = dayjs(d)
        return x.isAfter(mStart.subtract(1, 'millisecond')) && x.isBefore(mEnd.add(1, 'millisecond'))
      }
      const income = txs.filter(t => t.kind === 'income' && inMonth(t.occurred_at)).reduce((s, x) => s + Number(x.amount || 0), 0)
      const expense = txs.filter(t => t.kind === 'expense' && inMonth(t.occurred_at)).reduce((s, x) => s + Number(x.amount || 0), 0)
      months.push({ month: mStart.format('MM/YYYY'), net: Math.round(((income - expense) + Number.EPSILON) * 100) / 100 })
    }
    return months
  }, [txs])

  const expenseByCategory = useMemo(() => {
    const start = dayjs().startOf('month')
    const end = dayjs().endOf('month')
    const inMonth = (d: string) => {
      const x = dayjs(d)
      return x.isAfter(start.subtract(1, 'millisecond')) && x.isBefore(end.add(1, 'millisecond'))
    }
    const filtered = txs.filter(t => t.kind === 'expense' && inMonth(t.occurred_at))
    const total = filtered.reduce((s, x) => s + Number(x.amount || 0), 0)
    const byCat: Record<string, number> = {}
    for (const t of filtered) {
      const k = (t.category || 'uncategorized').toLowerCase()
      byCat[k] = (byCat[k] || 0) + Number(t.amount || 0)
    }
    const rows = Object.entries(byCat).map(([key, value]) => ({ key, value, ratio: total > 0 ? value / total : 0 }))
    rows.sort((a, b) => b.value - a.value)
    return rows
  }, [txs])

  const currentMonth = useMemo(() => dayjs().format('MM/YYYY'), [])

  const incomeByCategory = useMemo(() => {
    const total = txs.filter(t => t.kind === 'income').reduce((s, x) => s + Number(x.amount || 0), 0)
    const byCat: Record<string, number> = {}
    for (const t of txs) {
      if (t.kind !== 'income') continue
      const k = (t.category || 'booking').toLowerCase()
      byCat[k] = (byCat[k] || 0) + Number(t.amount || 0)
    }
    const rows = Object.entries(byCat).map(([key, value]) => ({ key, value, percent: total > 0 ? (value / total) : 0 }))
    rows.sort((a, b) => b.value - a.value)
    return { total, rows }
  }, [txs])

  const incomeColors: Record<string, string> = {
    booking: '#5B8FF9',
    late: '#a0d911',
    damage: '#faad14',
    service: '#722ed1',
    other: '#13c2c2',
  }

  const donutGradient = useMemo(() => {
    const segments = incomeByCategory.rows
    if (!incomeByCategory.total || segments.length === 0) return 'conic-gradient(#d9d9d9 0 360deg)'
    let acc = 0
    const parts: string[] = []
    for (const seg of segments) {
      const pct = seg.percent
      const deg = pct * 360
      const color = incomeColors[seg.key] || '#5B8FF9'
      parts.push(`${color} ${acc}deg ${acc + deg}deg`)
      acc += deg
    }
    return `conic-gradient(${parts.join(', ')})`
  }, [incomeByCategory])

  const platformColors: Record<string, string> = {
    airbnb: '#FF9F97',
    booking: '#98B6EC',
    offline: '#DC8C03',
    other: '#98B6EC',
  }

  const platformDonutGradient = useMemo(() => {
    const segments = platformShare
    if (!segments.length) return 'conic-gradient(#d9d9d9 0 360deg)'
    let acc = 0
    const parts: string[] = []
    for (const seg of segments) {
      const deg = seg.ratio * 360
      const color = platformColors[seg.key] || '#5B8FF9'
      parts.push(`${color} ${acc}deg ${acc + deg}deg`)
      acc += deg
    }
    return `conic-gradient(${parts.join(', ')})`
  }, [platformShare])

  async function submitTx() {
    const v = await txForm.validateFields()
    const payload = { kind: v.kind, amount: v.amount, currency: v.currency, occurred_at: v.occurred_at.format('YYYY-MM-DD'), note: v.note }
    const res = await fetch(`${API_BASE}/finance`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(payload) })
    if (res.ok) { message.success('已记账'); setTxOpen(false); txForm.resetFields(); load() }
    else { try { const err = await res.json(); message.error(err?.message || `记账失败 (${res.status})`) } catch { message.error(`记账失败 (${res.status})`) } }
  }

  async function submitPayout() {
    const v = await pForm.validateFields()
    const payload = { landlord_id: v.landlord_id, period_from: v.period[0].format('YYYY-MM-DD'), period_to: v.period[1].format('YYYY-MM-DD'), amount: v.amount, invoice_no: v.invoice_no }
    const res = await fetch(`${API_BASE}/finance/payouts`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(payload) })
    if (res.ok) { message.success('结算已生成'); setPayoutOpen(false); pForm.resetFields(); load() }
    else { try { const err = await res.json(); message.error(err?.message || `生成失败 (${res.status})`) } catch { message.error(`生成失败 (${res.status})`) } }
  }

  async function submitPayoutEdit() {
    const v = await pEditForm.validateFields()
    if (!editingPayout) return
    const payload: Partial<Payout> = { amount: v.amount, invoice_no: v.invoice_no, status: v.status }
    const res = await fetch(`${API_BASE}/finance/payouts/${editingPayout.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(payload) })
    if (res.ok) { message.success('已更新结算'); setPayoutEditOpen(false); setEditingPayout(null); pEditForm.resetFields(); load() }
    else { try { const err = await res.json(); message.error(err?.message || `更新失败 (${res.status})`) } catch { message.error(`更新失败 (${res.status})`) } }
  }

  const txCols: any[] = []
  const payoutCols: any[] = []

  const regions = ['City','Southbank','St Kilda','Docklands']
  const regionCounts = regions.map(reg => ({ region: reg, count: properties.filter(p => (p.region || '').toLowerCase() === reg.toLowerCase()).length }))
  function overlapNights(ci?: string, co?: string) {
    if (!ci || !co) return 0
    const s = dayjs(ci).startOf('day'); const e = dayjs(co).startOf('day')
    const a = dayjs.max(s, monthStart); const b = dayjs.min(e, monthEnd)
    const diff = b.diff(a, 'day')
    return Math.max(0, diff)
  }
  const daysInMonth = monthEnd.diff(monthStart, 'day') + 1
  const monthOrders = useMemo(() => orders.filter(o => overlapNights(o.checkin, o.checkout) > 0), [orders, monthStart, monthEnd])
  const dar = useMemo(() => {
    const arr = monthOrders.map(o => Number(o.avg_nightly_price || 0)).filter(n => n > 0)
    const avg = arr.length ? arr.reduce((a,b)=>a+b,0) / arr.length : 0
    return Math.round(avg * 100) / 100
  }, [monthOrders])
  const adrSpark = useMemo(() => {
    const end = dayjs(monthEnd)
    const start = end.subtract(6, 'day')
    const series: number[] = []
    for (let i = 0; i < 7; i++) {
      const d = start.add(i, 'day')
      const arr = monthOrders.filter(o => {
        const s = dayjs(o.checkin).startOf('day'); const e = dayjs(o.checkout).startOf('day')
        return d.isSameOrAfter(s) && d.isBefore(e)
      }).map(o => Number(o.avg_nightly_price || 0)).filter(n => n > 0)
      const v = arr.length ? arr.reduce((a,b)=>a+b,0) / arr.length : 0
      series.push(Math.round(v * 100) / 100)
    }
    return series
  }, [monthOrders, monthEnd])
  const occupancyByRegion = regions.map(reg => {
    const propIds = properties.filter(p => (p.region || '').toLowerCase() === reg.toLowerCase()).map(p => p.id)
    const regOrders = orders.filter(o => propIds.includes(String(o.property_id)))
    const nights = regOrders.reduce((sum, o) => sum + overlapNights(o.checkin, o.checkout), 0)
    const occ = propIds.length ? (nights / (propIds.length * daysInMonth)) * 100 : 0
    return { region: reg, occ: Math.round(occ * 100) / 100 }
  })
  const incomeByProp = useMemo(() => {
    const acc = new Map<string, number>()
    monthOrders.forEach(o => {
      const pid = String(o.property_id)
      const v = Number(typeof o.net_income === 'number' ? o.net_income : (o.avg_nightly_price || 0) * (o.nights || overlapNights(o.checkin, o.checkout)))
      acc.set(pid, (acc.get(pid) || 0) + v)
    })
    return acc
  }, [monthOrders])
  const expenseByProp = useMemo(() => {
    const acc = new Map<string, number>()
    propExpenses.forEach(ex => {
      const t = ex.occurred_at ? dayjs(ex.occurred_at) : null
      if (t && t.isSame(monthStart, 'month')) {
        const pid = String(ex.property_id || '')
        const v = Number(ex.amount || 0)
        acc.set(pid, (acc.get(pid) || 0) + v)
      }
    })
    return acc
  }, [propExpenses, monthStart])
  const occupancyByProperty = useMemo(() => {
    const map = new Map<string, number>()
    properties.forEach(p => map.set(String(p.id), 0))
    monthOrders.forEach(o => {
      const pid = String(o.property_id)
      const nights = overlapNights(o.checkin, o.checkout)
      map.set(pid, (map.get(pid) || 0) + nights)
    })
    const res = Array.from(map.entries()).map(([pid, nights]) => ({ pid, occ: daysInMonth ? Math.round(((nights / daysInMonth) * 100) * 100) / 100 : 0 }))
    return res
  }, [monthOrders, properties, daysInMonth])
  const bottomNet = useMemo(() => {
    const rows = properties.map(p => {
      const pid = String(p.id)
      const income = incomeByProp.get(pid) || 0
      const expense = expenseByProp.get(pid) || 0
      const net = income - expense
      const occ = occupancyByProperty.find(x => x.pid === pid)?.occ || 0
      return { pid, code: p.code || '', region: p.region || '', income: Math.round(income * 100) / 100, expense: Math.round(expense * 100) / 100, net: Math.round(net * 100) / 100, occ }
    })
    return rows.sort((a,b)=> a.net - b.net).slice(0,5)
  }, [properties, incomeByProp, expenseByProp, occupancyByProperty])

  function SparkBars({ data }: { data: number[] }) {
    const max = Math.max(1, ...data.map(v => Math.abs(v)))
    return <div style={{ display:'flex', alignItems:'flex-end', gap:4 }}>
      {data.map((v, i) => (<div key={i} style={{ width: 10, height: Math.max(4, (v / max) * 24), background:'#1677ff', borderRadius:2 }} title={`$${v}`} />))}
    </div>
  }
  function LineChart({ data }: { data: number[] }) {
    const w = 480
    const h = 160
    const max = Math.max(1, ...data)
    const min = Math.min(...data)
    const pad = 8
    const pts = data.map((v, i) => {
      const x = pad + (i * (w - pad * 2)) / Math.max(1, (data.length - 1))
      const y = h - pad - ((v - min) / Math.max(1, max - min)) * (h - pad * 2)
      return `${x},${y}`
    }).join(' ')
    const first = `${pad},${h-pad}`
    const last = `${w-pad},${h-pad}`
    return (
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
        <defs>
          <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#1677ff" stopOpacity="0.3" />
            <stop offset="100%" stopColor="#1677ff" stopOpacity="0" />
          </linearGradient>
        </defs>
        <polyline fill="none" stroke="#1677ff" strokeWidth="2" points={pts} />
        <polyline fill="url(#g)" stroke="none" points={`${first} ${pts} ${last}`} />
      </svg>
    )
  }

  const [trendW, setTrendW] = useState<number>(520)
  const trendRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    function update() {
      const el = trendRef.current
      if (el) setTrendW(Math.max(320, el.clientWidth - 24))
    }
    update()
    let ro: any = null
    if ((window as any).ResizeObserver) {
      ro = new (window as any).ResizeObserver(update)
      if (trendRef.current) ro.observe(trendRef.current)
    }
    window.addEventListener('resize', update)
    return () => { try { if (ro && trendRef.current) ro.unobserve(trendRef.current) } catch {} ; window.removeEventListener('resize', update) }
  }, [])

  const monthOrderCount = useMemo(() => monthOrders.length, [monthOrders])

  return (
    <Card title="财务管理" extra={null}>
      <div className="finance-page">
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(220px, 1fr))', gap:12, marginBottom: 12, alignItems:'stretch' }}>
        <Card size="small" title="总流水收入" styles={{ body:{ display:'flex', alignItems:'center', justifyContent:'center' } }} style={{ height:'100%' }}>${totals.totalIncome.toFixed(2)}</Card>
        <Card size="small" title="总支出" styles={{ body:{ display:'flex', alignItems:'center', justifyContent:'center' } }} style={{ height:'100%' }}>${totals.totalExpense.toFixed(2)}</Card>
        <Card size="small" title="公司净收入" styles={{ body:{ display:'flex', alignItems:'center', justifyContent:'center' } }} style={{ height:'100%' }}><b>${totals.net.toFixed(2)}</b></Card>
        <Card size="small" title="本月订单数" styles={{ body:{ display:'flex', alignItems:'center', justifyContent:'center' } }} style={{ height:'100%' }}>{monthOrderCount}</Card>
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(300px, 1fr))', gap:12, marginBottom: 12, alignItems:'stretch' }}>
        <Card size="small" title="各平台订单占比" style={{ height:'100%', display:'flex', flexDirection:'column' }}>
          <div style={{ display:'flex', gap:16, alignItems:'center' }}>
            <div style={{ width: 180, height: 180, borderRadius: '50%', background: platformDonutGradient, position:'relative' }}>
              <div style={{ position:'absolute', left:'50%', top:'50%', transform:'translate(-50%, -50%)', width: 100, height: 100, borderRadius: '50%', background:'#fff' }} />
            </div>
            <div style={{ display:'grid', gap:8 }}>
              {platformShare.map(r => (
                <div key={r.key} style={{ display:'flex', alignItems:'center', gap:8 }}>
                  <span style={{ display:'inline-block', width:12, height:12, borderRadius:2, background: platformColors[r.key] || '#5B8FF9' }} />
                  <span style={{ width: 160 }}>{r.key==='airbnb' ? 'Airbnb' : r.key==='booking' ? 'Booking.com' : r.key==='offline' ? '线下客人' : '其他平台'}</span>
                  <span>{r.percent}%</span>
                </div>
              ))}
            </div>
          </div>
        </Card>
        <Card size="small" title="近半年公司利润趋势" style={{ height:'100%', display:'flex', flexDirection:'column' }}>
          <div ref={trendRef} style={{ height: 220, padding: 12, overflow: 'hidden' }}>
            {(() => {
              const W = trendW
              const H = 180
              const pts = last6MonthsTrend
              const maxAbs = Math.max(1, ...pts.map(p => Math.abs(p.net)))
              const mL = 24
              const mR = 56
              const mT = 20
              const mB = 24
              const denom = Math.max(1, pts.length - 1)
              const xs = pts.map((_, i) => mL + i * ((W - mL - mR) / denom))
              const ys = pts.map(p => mT + (H - mT - mB) * (1 - ((p.net + maxAbs) / (2 * maxAbs))))
              const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xs[i]} ${ys[i]}`).join(' ')
              return (
                <svg width={W} height={H}>
                  <defs>
                    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#52c41a" stopOpacity="0.4" />
                      <stop offset="100%" stopColor="#52c41a" stopOpacity="0" />
                    </linearGradient>
                  </defs>
                  <path d={d} fill="none" stroke="#13c2c2" strokeWidth="2" />
                  {pts.map((p, i) => (<circle key={i} cx={xs[i]} cy={ys[i]} r="3" fill="#13c2c2" />))}
                  {pts.map((p, i) => (<text key={`t${i}`} x={xs[i]} y={H - 6} fontSize="10" textAnchor="middle">{p.month}</text>))}
                </svg>
              )
            })()}
          </div>
        </Card>
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(300px, 1fr))', gap:12, marginBottom: 12, alignItems:'stretch' }}>
        <Card size="small" title="每日平均房价" style={{ height:'100%', display:'flex', flexDirection:'column' }}>
          <Space direction="vertical" style={{ width:'100%' }}>
            <div style={{ fontSize: 18 }}>$ {dar}/晚</div>
            <SparkBars data={adrSpark} />
          </Space>
        </Card>
        <Card size="small" title="最多房源区域" styles={{ header:{ minHeight: 48, fontSize: 16, fontWeight: 500 } }} style={{ height:'100%', display:'flex', flexDirection:'column', justifyContent:'center' }}>
          <div style={{ fontSize: 16 }}>{regionCounts.sort((a,b)=> b.count - a.count)[0]?.region || ''} – {regionCounts.sort((a,b)=> b.count - a.count)[0]?.count || 0} 套</div>
        </Card>
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(300px, 1fr))', gap:12, marginBottom: 12, alignItems:'stretch' }}>
        <Card size="small" title="各区域入住率" style={{ height:'100%', display:'flex', flexDirection:'column' }}>
          <Space direction="vertical" style={{ width: '100%' }}>
            {occupancyByRegion.map(r => (
              <div key={r.region} style={{ display:'flex', alignItems:'center', gap:8 }}>
                <div style={{ width: 120 }}>{r.region}</div>
                <div style={{ width: 240, background:'#eee', borderRadius:4 }}><div style={{ width: `${Math.min(100, Math.max(0, r.occ))}%`, height: 12, background:'#52c41a', borderRadius:4 }} /></div>
                <div>{r.occ}%</div>
              </div>
            ))}
          </Space>
        </Card>
        <Card size="small" title="每日平均房价（近30天）">
          <LineChart data={(() => {
            const end = dayjs(monthEnd)
            const start = end.subtract(29, 'day')
            const series: number[] = []
            for (let i = 0; i < 30; i++) {
              const d = start.add(i, 'day')
              const arr = orders.filter(o => {
                const s = dayjs(o.checkin).startOf('day'); const e = dayjs(o.checkout).startOf('day')
                return d.isSameOrAfter(s) && d.isBefore(e)
              }).map(o => Number(o.avg_nightly_price || 0)).filter(n => n > 0)
              const v = arr.length ? arr.reduce((a,b)=>a+b,0) / arr.length : 0
              series.push(Math.round(v * 100) / 100)
            }
            return series
          })()} />
        </Card>
      </div>
      <Card size="small" title="本月净收益最低房源 Top 5">
        {bottomNet.length === 0 ? <div style={{ color:'#999' }}>暂无数据</div> : (
          <Table size="middle" pagination={false} rowKey={(r)=>r.pid} columns={[
            { title:'排名', render: (_:any, r:any, idx:number)=> idx+1, width: 80 },
            { title:'房号', dataIndex:'code' },
            { title:'区域', dataIndex:'region', width: 120 },
            { title:'本月收入', dataIndex:'income', render:(v:number)=> `$${v}` },
            { title:'本月支出', dataIndex:'expense', render:(v:number)=> `$${v}` },
            { title:'净收益（Net Income）', dataIndex:'net', render:(v:number)=> (<span style={{ color: v < 0 ? '#ff4d4f' : 'inherit' }}>$${v}</span>) },
            { title:'入住率', dataIndex:'occ', render:(v:number)=> `${v}%` },
          ]} dataSource={bottomNet} />
        )}
      </Card>
      
      </div>
      <style jsx>{`
        :global(.finance-page .ant-card-head) { min-height: 48px; }
        :global(.finance-page .ant-card-head .ant-card-head-wrapper) { min-height: 48px; display: flex; align-items: center; }
        :global(.finance-page .ant-card-head .ant-card-head-title) { font-size: 16px; font-weight: 500; }
      `}</style>
    </Card>
  )
}
