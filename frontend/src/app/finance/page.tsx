"use client"
import { Table, Card, Space, Button, Form, InputNumber, Select, DatePicker, Input, App, Modal, Tag } from 'antd'
import dayjs from 'dayjs'
import { useEffect, useState, useMemo } from 'react'
import { API_BASE, authHeaders } from '../../lib/api'
import { hasPerm } from '../../lib/auth'

type Tx = { id: string; kind: 'income'|'expense'; amount: number; currency: string; occurred_at: string; note?: string; category?: string }
type Order = { id: string; source?: string; checkin?: string; checkout?: string; price?: number; property_id?: string }
type Payout = { id: string; landlord_id: string; period_from: string; period_to: string; amount: number; invoice_no?: string; status: string }
type Landlord = { id: string; name: string }

export default function FinancePage() {
  const [txs, setTxs] = useState<Tx[]>([])
  const [payouts, setPayouts] = useState<Payout[]>([])
  const [landlords, setLandlords] = useState<Landlord[]>([])
  const [orders, setOrders] = useState<Order[]>([])
  const [txOpen, setTxOpen] = useState(false)
  const [payoutOpen, setPayoutOpen] = useState(false)
  const [payoutEditOpen, setPayoutEditOpen] = useState(false)
  const [txForm] = Form.useForm()
  const [pForm] = Form.useForm()
  const [pEditForm] = Form.useForm()
  const { message, modal } = App.useApp()
  const [editingPayout, setEditingPayout] = useState<Payout | null>(null)

  async function load() {
    const [t, p, l, o] = await Promise.all([
      fetch(`${API_BASE}/finance`).then(r => r.json()),
      fetch(`${API_BASE}/finance/payouts`).then(r => r.json()),
      fetch(`${API_BASE}/landlords`).then(r => r.json()),
      fetch(`${API_BASE}/orders`).then(r => r.json()),
    ])
    setTxs(t); setPayouts(p); setLandlords(l); setOrders(Array.isArray(o) ? o : [])
  }
  useEffect(() => { load() }, [])

  const totals = useMemo(() => {
    const income = txs.filter(t => t.kind === 'income').reduce((s, x) => s + Number(x.amount || 0), 0)
    const expense = txs.filter(t => t.kind === 'expense').reduce((s, x) => s + Number(x.amount || 0), 0)
    const net = Math.round(((income - expense) + Number.EPSILON) * 100) / 100
    return { totalIncome: income, totalExpense: expense, net }
  }, [txs])

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

  return (
    <Card title="财务管理" extra={null}>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:12, marginBottom: 12 }}>
        <Card size="small" title="总流水收入">${totals.totalIncome.toFixed(2)}</Card>
        <Card size="small" title="总支出">${totals.totalExpense.toFixed(2)}</Card>
        <Card size="small" title="公司净收入"><b>${totals.net.toFixed(2)}</b></Card>
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginBottom: 12 }}>
        <Card size="small" title="各平台订单占比">
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
        <Card size="small" title="近半年公司利润趋势">
          <div style={{ height: 200, padding: 12 }}>
            {(() => {
              const W = 520
              const H = 160
              const pts = last6MonthsTrend
              const maxAbs = Math.max(1, ...pts.map(p => Math.abs(p.net)))
              const xs = pts.map((_, i) => 20 + i * ((W - 40) / (pts.length - 1)))
              const ys = pts.map(p => 20 + (H - 40) * (1 - ((p.net + maxAbs) / (2 * maxAbs))))
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
                  {pts.map((p, i) => (<text key={`t${i}`} x={xs[i]-10} y={H} fontSize="10">{p.month}</text>))}
                </svg>
              )
            })()}
          </div>
        </Card>
      </div>
      <Card size="small" title={`公司支出分类（${currentMonth}）`}>
        <div style={{ display:'flex', gap:16, alignItems:'flex-start', padding: 12 }}>
          {(() => {
            const W = 700
            const H = 220
            const padL = 40
            const padB = 28
            const rows = expenseByCategory
            const max = Math.max(1, ...rows.map(r => r.value))
            const bw = Math.max(24, Math.floor((W - padL - 20) / Math.max(1, rows.length)))
            return (
              <svg width={W} height={H}>
                <rect x={padL} y={10} width={W - padL - 10} height={H - padB - 10} fill="#fff" stroke="#f0f0f0" />
                {[0.25,0.5,0.75].map((g,i)=> (
                  <line key={i} x1={padL} x2={W-10} y1={10 + (H - padB - 10) * (1 - g)} y2={10 + (H - padB - 10) * (1 - g)} stroke="#eee" />
                ))}
                {rows.map((r, i) => {
                  const x = padL + 10 + i * bw
                  const h = Math.round((r.value / max) * (H - padB - 20))
                  const y = 10 + (H - padB - 10) - h
                  const label = `$${Number(r.value||0).toFixed(2)}`
                  return (
                    <g key={r.key}>
                      <rect x={x} y={y} width={bw - 12} height={h} fill="#5B8FF9" rx={4} />
                      <text x={x + (bw - 12)/2} y={y - 6} fontSize="11" textAnchor="middle" fill="#595959">{label}</text>
                      <text x={x + (bw - 12)/2} y={H - 8} fontSize="11" textAnchor="middle" style={{ textTransform:'capitalize' }}>{r.key}</text>
                    </g>
                  )
                })}
              </svg>
            )
          })()}
          <div style={{ display:'grid', gap:8 }}>
            {expenseByCategory.map(r => (
              <div key={r.key} style={{ display:'flex', alignItems:'center', gap:8 }}>
                <span style={{ display:'inline-block', width:12, height:12, borderRadius:2, background:'#5B8FF9' }} />
                <span style={{ width: 160, textTransform:'capitalize' }}>{r.key}</span>
                <span>${Number(r.value||0).toFixed(2)}</span>
              </div>
            ))}
          </div>
        </div>
      </Card>
    </Card>
  )
}
