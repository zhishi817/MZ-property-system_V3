"use client"
import { Card, Row, Col, Statistic, DatePicker, Space, Tag, Table, Button } from 'antd'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import dayjs from 'dayjs'
import minMax from 'dayjs/plugin/minMax'
import isSameOrAfter from 'dayjs/plugin/isSameOrAfter'
dayjs.extend(minMax)
dayjs.extend(isSameOrAfter)
import { useEffect, useMemo, useState } from 'react'
import { API_BASE, getJSON } from '../../lib/api'
import { PieChart as RePieChart, Pie as RePie, Cell as ReCell, Tooltip as ReTooltip, Legend as ReLegend, ResponsiveContainer } from 'recharts'

type Property = { id: string; code?: string; address?: string; region?: string; biz_category?: 'leased'|'management_fee' }
type Order = { id: string; property_id?: string; checkin?: string; checkout?: string; nights?: number; avg_nightly_price?: number; net_income?: number }
type PropertyExpense = { id: string; property_id?: string; amount?: number; occurred_at?: string }
type Landlord = { id: string; name: string }

export default function DashboardPage() {
  const router = useRouter()
  const [month, setMonth] = useState<any>(dayjs())
  const [properties, setProperties] = useState<Property[]>([])
  const [orders, setOrders] = useState<Order[]>([])
  const [expenses, setExpenses] = useState<PropertyExpense[]>([])
  const [landlords, setLandlords] = useState<Landlord[]>([])
  useEffect(() => {
    getJSON<Property[]>('/properties').then((j) => setProperties(Array.isArray(j) ? j : [])).catch(() => setProperties([]))
    getJSON<Order[]>('/orders').then((j) => setOrders(Array.isArray(j) ? j : [])).catch(() => setOrders([]))
    getJSON<PropertyExpense[]>('/crud/property_expenses').then((j) => setExpenses(Array.isArray(j) ? j : [])).catch(() => setExpenses([]))
    getJSON<Landlord[]>('/landlords').then((j) => setLandlords(Array.isArray(j) ? j : [])).catch(() => setLandlords([]))
  }, [])

  const totalProps = properties.length
  const regions = ['City','Southbank','St Kilda','Docklands']
  const regionCounts = regions.map(reg => ({ region: reg, count: properties.filter(p => (p.region || '').toLowerCase() === reg.toLowerCase()).length }))
  const manageStats = (() => {
    const leased = properties.filter(p => (p.biz_category || '').toLowerCase() === 'leased').length
    const managed = properties.filter(p => (p.biz_category || '').toLowerCase() === 'management_fee').length
    const unknown = totalProps - leased - managed
    return { leased, managed, unknown }
  })()

  const leaseCount = manageStats.leased
  const manageCount = manageStats.managed
  const unknownCount = manageStats.unknown
  const data = [
    { name: '包租房源', value: leaseCount },
    { name: '管理费房源', value: manageCount },
    { name: '未知', value: unknownCount },
  ]
  const COLORS = ['#3A7BFA', '#8B5CF6', '#A0AEC0']

  function ManagementTypePieChart() {
    return (
      <div style={{ width: '100%' }}>
        <ResponsiveContainer width="100%" height={260}>
          <RePieChart margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
            <RePie data={data} cx="40%" cy="38%" innerRadius={60} outerRadius={100} paddingAngle={3} dataKey="value">
              {data.map((entry, idx) => (
                <ReCell key={idx} fill={COLORS[idx % COLORS.length]} />
              ))}
            </RePie>
            <ReTooltip />
            {(() => {
              const LegendContent = () => (
                <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                  {data.map((d, i) => (
                    <div key={d.name} style={{ display:'flex', alignItems:'center', gap:8 }}>
                      <span style={{ display:'inline-block', width:10, height:10, background:COLORS[i % COLORS.length], borderRadius:'50%' }}></span>
                      <span>{d.name}</span>
                      <span style={{ marginLeft:'auto' }}>{d.value}</span>
                    </div>
                  ))}
                </div>
              )
              return <ReLegend layout="vertical" verticalAlign="middle" align="right" content={<LegendContent />} />
            })()}
          </RePieChart>
        </ResponsiveContainer>
      </div>
    )
  }

  const monthStart = useMemo(() => dayjs(month).startOf('month'), [month])
  const monthEnd = useMemo(() => dayjs(month).endOf('month'), [month])
  function overlapNights(ci?: string, co?: string) {
    if (!ci || !co) return 0
    const s = dayjs(ci).startOf('day'); const e = dayjs(co).startOf('day')
    const a = dayjs.max(s, monthStart); const b = dayjs.min(e, monthEnd)
    const diff = b.diff(a, 'day')
    return Math.max(0, diff)
  }
  const daysInMonth = monthEnd.diff(monthStart, 'day') + 1
  const occupancyOverall = useMemo(() => {
    const nights = orders.reduce((sum, o) => sum + overlapNights(o.checkin, o.checkout), 0)
    const occ = totalProps ? (nights / (totalProps * daysInMonth)) * 100 : 0
    return Math.round(occ * 100) / 100
  }, [orders, totalProps, daysInMonth, monthStart, monthEnd])
  const prevMonthStart = useMemo(() => dayjs(monthStart).subtract(1, 'month').startOf('month'), [monthStart])
  const prevMonthEnd = useMemo(() => dayjs(monthStart).subtract(1, 'month').endOf('month'), [monthStart])
  function overlapPrev(ci?: string, co?: string) {
    if (!ci || !co) return 0
    const s = dayjs(ci).startOf('day'); const e = dayjs(co).startOf('day')
    const a = dayjs.max(s, prevMonthStart); const b = dayjs.min(e, prevMonthEnd)
    const diff = b.diff(a, 'day')
    return Math.max(0, diff)
  }
  const prevDaysInMonth = prevMonthEnd.diff(prevMonthStart, 'day') + 1
  const occupancyOverallPrev = useMemo(() => {
    const nights = orders.reduce((sum, o) => sum + overlapPrev(o.checkin, o.checkout), 0)
    const occ = totalProps ? (nights / (totalProps * prevDaysInMonth)) * 100 : 0
    return Math.round(occ * 100) / 100
  }, [orders, totalProps, prevDaysInMonth, prevMonthStart, prevMonthEnd])
  const occupancyByRegion = regions.map(reg => {
    const propIds = properties.filter(p => (p.region || '').toLowerCase() === reg.toLowerCase()).map(p => p.id)
    const regOrders = orders.filter(o => propIds.includes(String(o.property_id)))
    const nights = regOrders.reduce((sum, o) => sum + overlapNights(o.checkin, o.checkout), 0)
    const occ = propIds.length ? (nights / (propIds.length * daysInMonth)) * 100 : 0
    return { region: reg, occ: Math.round(occ * 100) / 100 }
  })

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
  const priceByProp = useMemo(() => {
    const acc = new Map<string, { sum: number, cnt: number }>()
    monthOrders.forEach(o => {
      const pid = String(o.property_id)
      const v = Number(o.avg_nightly_price || 0)
      if (!acc.has(pid)) acc.set(pid, { sum: 0, cnt: 0 })
      const cur = acc.get(pid)!
      acc.set(pid, { sum: cur.sum + v, cnt: cur.cnt + (v > 0 ? 1 : 0) })
    })
    return Array.from(acc.entries()).map(([pid, s]) => ({ pid, avg: s.cnt ? s.sum / s.cnt : 0 }))
  }, [monthOrders])
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
    expenses.forEach(ex => {
      const t = ex.occurred_at ? dayjs(ex.occurred_at) : null
      if (t && t.isSame(monthStart, 'month')) {
        const pid = String(ex.property_id || '')
        const v = Number(ex.amount || 0)
        acc.set(pid, (acc.get(pid) || 0) + v)
      }
    })
    return acc
  }, [expenses, monthStart])
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

  function Bar({ value, max }: { value: number, max: number }) {
    const w = max ? Math.max(6, (value / max) * 180) : 6
    return <div style={{ width: w, height: 12, background: '#1677ff', borderRadius: 4 }} />
  }

  const maxRegion = Math.max(1, ...regionCounts.map(r => r.count))

  function Pie({ leased, managed, unknown }: { leased: number, managed: number, unknown: number }) {
    const total = Math.max(leased + managed + unknown, 1)
    const colors = { leased: '#2f80ed', managed: '#8b5cf6', unknown: '#bfbfbf' }
    const lAngle = (leased / total) * 360
    const mAngle = (managed / total) * 360
    const uAngle = Math.max(0, 360 - lAngle - mAngle)
    const radius = 80
    function sector(angle: number, color: string, rotate: number) {
      if (angle <= 0) return null
      const large = angle > 180 ? 1 : 0
      const x = radius + radius * Math.cos((angle * Math.PI) / 180)
      const y = radius + radius * Math.sin((angle * Math.PI) / 180)
      const d = `M ${radius} ${radius} L ${radius} 0 A ${radius} ${radius} 0 ${large} 1 ${x} ${y} Z`
      return <path d={d} fill={color} stroke="#fff" strokeWidth={2} transform={`rotate(${rotate}, ${radius}, ${radius})`} />
    }
    function label(text: string, color: string, rotate: number, angle: number) {
      if (angle <= 0) return null
      const mid = rotate + angle / 2
      const r = radius + 26
      const x = radius + r * Math.cos((mid * Math.PI) / 180)
      const y = radius + r * Math.sin((mid * Math.PI) / 180)
      return <text x={x} y={y} fill={color} fontSize={14} textAnchor="middle">{text}</text>
    }
    const lPct = Math.round((leased / total) * 100)
    const mPct = Math.round((managed / total) * 100)
    const uPct = Math.round((unknown / total) * 100)
    return (
      <div style={{ display:'flex', alignItems:'center', gap:16, width:'100%', justifyContent:'space-between' }}>
        <div style={{ flex: '0 0 auto' }}>
          <svg width={radius*2} height={radius*2} viewBox={`0 0 ${radius*2} ${radius*2}`}>
            {sector(lAngle, colors.leased, 0)}
            {sector(mAngle, colors.managed, lAngle)}
            {sector(uAngle, colors.unknown, lAngle + mAngle)}
            {label(`包租房源 ${lPct}%`, colors.leased, 0, lAngle)}
            {label(`管理费房源 ${mPct}%`, colors.managed, lAngle, mAngle)}
            {unknown > 0 && label(`未知 ${uPct}%`, colors.unknown, lAngle + mAngle, uAngle)}
          </svg>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ display:'flex', alignItems:'center', gap:12 }}>
            <span style={{ display:'inline-block', width:10, height:10, background:colors.leased, borderRadius:'50%' }}></span>
            <span>包租房源：{leased}</span>
            <span style={{ display:'inline-block', width:10, height:10, background:colors.managed, borderRadius:'50%' }}></span>
            <span>管理费房源：{managed}</span>
            {unknown > 0 && (<>
              <span style={{ display:'inline-block', width:10, height:10, background:colors.unknown, borderRadius:'50%' }}></span>
              <span>未知：{unknown}</span>
            </>)}
          </div>
        </div>
      </div>
    )
  }

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

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      
      <Row gutter={[16, 16]}>
        <Col xs={24} md={12}><Card style={{ height: 140 }}><Space direction="vertical" style={{ width:'100%', height:'100%', justifyContent:'center' }}><Statistic title="总房源数量" value={totalProps} valueStyle={{ fontSize: 26 }} /></Space></Card></Col>
        <Col xs={24} md={12}><Card style={{ height: 140 }}><Space direction="vertical" style={{ width:'100%', height:'100%', justifyContent:'center' }}><Statistic title="房东数量" value={landlords.length} valueStyle={{ fontSize: 26 }} /></Space></Card></Col>
      </Row>
      <Row gutter={[16,16]}>
        <Col xs={24} md={12}><Card title="房源管理类型占比" style={{ height: 300 }}><ManagementTypePieChart /></Card></Col>
        <Col xs={24} md={12}><Card title="各区域房源数量" extra={<span>总计：{totalProps}</span>} style={{ height: 300 }}><Space direction="vertical" style={{ width: '100%' }}>{regionCounts.map(rc => {
          const pct = totalProps ? Math.round((rc.count * 100) / totalProps) : 0
          return (
            <div key={rc.region} style={{ display:'flex', alignItems:'center', gap:8 }} title={`${rc.region} - ${rc.count} units`}>
              <div style={{ width: 120 }}>{rc.region}</div>
              <Bar value={rc.count} max={maxRegion} />
              <div style={{ marginLeft:'auto', minWidth: 80, textAlign:'right' }}>{rc.count}（{pct}%）</div>
            </div>
          )
        })}</Space></Card></Col>
      </Row>
      
    </Space>
  )
}
