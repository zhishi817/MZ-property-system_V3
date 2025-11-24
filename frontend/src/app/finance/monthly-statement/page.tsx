"use client"
import { Card, DatePicker, Button, Select, Table } from 'antd'
import dayjs from 'dayjs'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { getJSON } from '../../../lib/api'

type Order = { id: string; property_id?: string; checkin?: string; checkout?: string; price?: number; nights?: number }
type Tx = { id: string; kind: 'income'|'expense'; amount: number; currency: string; property_id?: string; occurred_at: string; category?: string; invoice_url?: string; note?: string }
type Landlord = { id: string; name: string; management_fee_rate?: number; property_ids?: string[] }

export default function MonthlyStatementPage() {
  const sp = useSearchParams()
  const [month, setMonth] = useState<any>(sp.get('month') ? dayjs(sp.get('month') as string) : dayjs())
  const [propertyId, setPropertyId] = useState<string | undefined>(sp.get('pid') || undefined)
  const [orders, setOrders] = useState<Order[]>([])
  const [txs, setTxs] = useState<Tx[]>([])
  const [properties, setProperties] = useState<{ id: string; code?: string; address?: string }[]>([])
  const [landlords, setLandlords] = useState<Landlord[]>([])
  const ref = useRef<HTMLDivElement>(null)
  const printed = useRef<boolean>(false)
  useEffect(() => { getJSON<any>('/properties').then(j => setProperties(j || [])).catch(() => setProperties([])) }, [])
  useEffect(() => { getJSON<Order[]>('/orders').then(setOrders).catch(() => setOrders([])); getJSON<Tx[]>('/finance').then(setTxs).catch(() => setTxs([])); getJSON<Landlord[]>('/landlords').then(setLandlords).catch(() => setLandlords([])) }, [])
  const ym = month ? { y: month.year(), m: month.month()+1 } : null
  const start = ym ? dayjs(`${ym.y}-${String(ym.m).padStart(2,'0')}-01`) : null
  const end = start ? start.endOf('month') : null
  const ordersInMonth = useMemo(() => {
    if (!start || !end) return [] as Order[]
    return orders.filter(o => (!propertyId || o.property_id === propertyId) && o.checkout && dayjs(o.checkout).isAfter(start.subtract(1,'day')) && dayjs(o.checkout).isBefore(end.add(1,'day')))
  }, [orders, propertyId, start, end])
  const expensesInMonth = useMemo(() => {
    if (!start || !end) return [] as Tx[]
    return txs.filter(t => t.kind === 'expense' && (!propertyId || t.property_id === propertyId) && dayjs(t.occurred_at).isAfter(start.subtract(1,'day')) && dayjs(t.occurred_at).isBefore(end.add(1,'day')))
  }, [txs, propertyId, start, end])
  const totalIncome = useMemo(() => ordersInMonth.reduce((s, x) => s + Number(x.price || 0), 0), [ordersInMonth])
  const occupiedNights = useMemo(() => ordersInMonth.reduce((s, x) => s + Number(x.nights ?? Math.max(dayjs(x.checkout!).diff(dayjs(x.checkin!), 'day'), 0)), 0), [ordersInMonth])
  const daysInMonth = end && start ? end.diff(start, 'day') + 1 : 30
  const occupancyRate = daysInMonth ? Math.round(((occupiedNights / daysInMonth) * 100 + Number.EPSILON) * 100) / 100 : 0
  const dailyAverage = occupiedNights ? Math.round(((totalIncome / occupiedNights) + Number.EPSILON) * 100) / 100 : 0
  const landlord = useMemo(() => landlords.find(l => (l.property_ids || []).includes(propertyId || '')), [landlords, propertyId])
  const managementFee = landlord?.management_fee_rate ? Math.round(((totalIncome * landlord.management_fee_rate) + Number.EPSILON) * 100) / 100 : 0
  const sumByCat = (cat: string) => expensesInMonth.filter(e => e.category === cat).reduce((s, x) => s + Number(x.amount || 0), 0)
  const catElectricity = sumByCat('electricity')
  const catWater = sumByCat('water')
  const catGas = sumByCat('gas')
  const catInternet = sumByCat('internet')
  const catConsumable = sumByCat('consumable')
  const catCarpark = sumByCat('carpark')
  const catOwnerCorp = sumByCat('property_fee')
  const catCouncil = sumByCat('council')
  const catOther = sumByCat('other')
  const totalExpense = managementFee + catElectricity + catWater + catGas + catInternet + catConsumable + catCarpark + catOwnerCorp + catCouncil + catOther
  const netIncome = Math.round(((totalIncome - totalExpense) + Number.EPSILON) * 100) / 100
  const isImg = (u?: string) => !!u && /\.(png|jpg|jpeg|gif)$/i.test(u)
  const fmt = (n: number) => (n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })

  function downloadPdf() { if (ref.current) window.print() }

  useEffect(() => {
    if (!printed.current && sp.get('autoprint') === '1' && ref.current) {
      printed.current = true
      try { window.print() } catch {}
    }
  }, [orders, txs, properties, landlords, sp])

  return (
    <Card title="月度收入报表">
      <div style={{ marginBottom: 12 }}>
        <DatePicker picker="month" value={month} onChange={setMonth as any} />
        <Select allowClear placeholder="选择房源" style={{ width: 220, marginLeft: 8 }} options={properties.map(p => ({ value: p.id, label: p.code || p.address || p.id }))} value={propertyId} onChange={setPropertyId} />
        <Button style={{ marginLeft: 8 }} onClick={downloadPdf}>下载PDF</Button>
      </div>
      <div ref={ref} style={{ padding: 24 }}>
        <div style={{ textAlign:'center', fontSize: 24, fontWeight: 700 }}>MONTHLY STATEMENT</div>
        <div style={{ textAlign:'center', marginBottom: 8 }}>{month.format('MMM YYYY')}</div>
        <div style={{ borderTop: '2px solid #000', margin: '12px 0' }}></div>
        <div style={{ fontWeight: 600, marginTop: 8, background:'#eef3fb', padding:'6px 8px' }}>Monthly Overview Data</div>
        <table style={{ width: '100%', borderCollapse:'collapse' }}>
          <tbody>
            <tr><td style={{ padding:6 }}>Total rent income 总租金</td><td style={{ textAlign:'right', padding:6 }}>${fmt(totalIncome)}</td></tr>
            <tr><td style={{ padding:6 }}>Occupancy Rate 入住率</td><td style={{ textAlign:'right', padding:6 }}>{fmt(occupancyRate)}%</td></tr>
            <tr><td style={{ padding:6 }}>Daily Average 日平均租金</td><td style={{ textAlign:'right', padding:6 }}>${fmt(dailyAverage)}</td></tr>
          </tbody>
        </table>

        <div style={{ fontWeight: 600, marginTop: 16, background:'#eef3fb', padding:'6px 8px' }}>Rental Details</div>
        <div style={{ fontWeight: 700, display:'flex', justifyContent:'space-between', padding:'6px 8px' }}>
          <span>Total Income 总收入</span><span>${fmt(totalIncome)}</span>
        </div>
        <table style={{ width:'100%' }}>
          <tbody>
            <tr><td style={{ padding:6 }}>Rent Income 租金收入</td><td style={{ textAlign:'right', padding:6 }}>${fmt(totalIncome)}</td></tr>
            <tr><td style={{ padding:6 }}>Other Income 其他收入</td><td style={{ textAlign:'right', padding:6 }}>$0.00</td></tr>
          </tbody>
        </table>

        <div style={{ fontWeight: 700, display:'flex', justifyContent:'space-between', padding:'6px 8px', marginTop: 8 }}>
          <span>Total Expense 总支出</span><span>${fmt(totalExpense)}</span>
        </div>
        <table style={{ width:'100%' }}>
          <tbody>
            <tr><td style={{ padding:6 }}>Management Fee 管理费</td><td style={{ textAlign:'right', padding:6 }}>-${fmt(managementFee)}</td></tr>
            <tr><td style={{ padding:6 }}>Electricity 电费</td><td style={{ textAlign:'right', padding:6 }}>-${fmt(catElectricity)}</td></tr>
            <tr><td style={{ padding:6 }}>Water 水费</td><td style={{ textAlign:'right', padding:6 }}>-${fmt(catWater)}</td></tr>
            <tr><td style={{ padding:6 }}>Gas / Hot water 煤气费 / 热水费</td><td style={{ textAlign:'right', padding:6 }}>-${fmt(catGas)}</td></tr>
            <tr><td style={{ padding:6 }}>Internet 网费</td><td style={{ textAlign:'right', padding:6 }}>-${fmt(catInternet)}</td></tr>
            <tr><td style={{ padding:6 }}>Monthly Consumable 消耗品费</td><td style={{ textAlign:'right', padding:6 }}>-${fmt(catConsumable)}</td></tr>
            <tr><td style={{ padding:6 }}>Carpark 车位费</td><td style={{ textAlign:'right', padding:6 }}>-${fmt(catCarpark)}</td></tr>
            <tr><td style={{ padding:6 }}>Owner's Corporation 物业费</td><td style={{ textAlign:'right', padding:6 }}>-${fmt(catOwnerCorp)}</td></tr>
            <tr><td style={{ padding:6 }}>Council Rate 市政费</td><td style={{ textAlign:'right', padding:6 }}>-${fmt(catCouncil)}</td></tr>
            <tr><td style={{ padding:6 }}>Other Expense 其他支出</td><td style={{ textAlign:'right', padding:6 }}>-${fmt(catOther)}</td></tr>
          </tbody>
        </table>

        <div style={{ fontWeight: 700, display:'flex', justifyContent:'space-between', padding:'6px 8px', marginTop: 8 }}>
          <span>Net Income 净收入</span><span>${fmt(netIncome)}</span>
        </div>

        <div style={{ pageBreakBefore: 'always', marginTop: 24, fontWeight: 600, background:'#eef3fb', padding:'6px 8px' }}>Rent Records</div>
        <Table size="small" pagination={false} dataSource={ordersInMonth} rowKey={r => r.id} columns={[{ title:'入住', dataIndex:'checkin' }, { title:'退房', dataIndex:'checkout' }, { title:'晚数', render: (_: any, r: Order) => r.nights ?? Math.max(dayjs(r.checkout!).diff(dayjs(r.checkin!), 'day'), 0) }, { title:'金额', render: (_: any, r: Order) => `$${fmt(Number(r.price||0))}` }]} />

        <div style={{ pageBreakBefore: 'always', marginTop: 24, fontWeight: 600, background:'#eef3fb', padding:'6px 8px' }}>Expense Invoices 支出发票</div>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(2, 1fr)', gap: 12 }}>
          {expensesInMonth.map(e => (
            <div key={e.id} style={{ border:'1px solid #eee', padding:8 }}>
              <div style={{ display:'flex', justifyContent:'space-between' }}>
                <span>{e.category || '其他'}</span>
                <span>-${fmt(Number(e.amount||0))}</span>
              </div>
              <div style={{ fontSize:12 }}>{dayjs(e.occurred_at).format('YYYY-MM-DD')}</div>
              {isImg(e.invoice_url) ? (
                <img src={e.invoice_url} style={{ width:'100%', marginTop:6 }} alt="invoice" />
              ) : e.invoice_url ? (
                <a href={e.invoice_url} target="_blank" rel="noreferrer" style={{ display:'inline-block', marginTop:6 }}>查看发票</a>
              ) : (
                <div style={{ fontSize:12, color:'#888', marginTop:6 }}>未上传发票</div>
              )}
            </div>
          ))}
        </div>
      </div>
    </Card>
  )
}
