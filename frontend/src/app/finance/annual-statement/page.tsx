"use client"
import { Card, Select, Button, message, DatePicker, Table } from 'antd'
import dayjs from 'dayjs'
import { useEffect, useMemo, useRef, useState } from 'react'
import { getJSON, API_BASE } from '../../../lib/api'

type Order = { id: string; property_id?: string; checkin?: string; checkout?: string; price?: number; cleaning_fee?: number }
type Tx = { id: string; kind: 'income'|'expense'; amount: number; currency: string; property_id?: string; occurred_at: string }

export default function AnnualStatementPage() {
  const [year, setYear] = useState<number>(dayjs().year())
  const [period, setPeriod] = useState<'year'|'half-year'>('year')
  const [startMonth, setStartMonth] = useState<any>(dayjs().startOf('year'))
  const [propertyId, setPropertyId] = useState<string | undefined>(undefined)
  const [orders, setOrders] = useState<Order[]>([])
  const [txs, setTxs] = useState<Tx[]>([])
  const [properties, setProperties] = useState<{ id: string; code?: string; address?: string }[]>([])
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { getJSON<any>('/properties').then(j => setProperties(j || [])).catch(() => setProperties([])) }, [])
  useEffect(() => { getJSON<Order[]>('/orders').then(setOrders).catch(() => setOrders([])); getJSON<Tx[]>('/finance').then(setTxs).catch(() => setTxs([])) }, [])
  const range = useMemo(() => {
    if (period === 'year') return { start: dayjs(`${year}-01-01`), end: dayjs(`${year}-12-31`) }
    const sm = startMonth ? dayjs(startMonth).startOf('month') : dayjs(`${year}-01-01`)
    const em = sm.add(5, 'month').endOf('month')
    return { start: sm, end: em }
  }, [year, period, startMonth])
  const stats = useMemo(() => {
    const o = orders.filter(o => (!propertyId || o.property_id === propertyId) && o.checkout && dayjs(o.checkout).isAfter(range.start.subtract(1,'day')) && dayjs(o.checkout).isBefore(range.end.add(1,'day')))
    const income = o.reduce((s, x) => s + Number(x.price || 0), 0)
    const cleaning = o.reduce((s, x) => s + Number(x.cleaning_fee || 0), 0)
    const exp = txs.filter(t => t.kind === 'expense' && (!propertyId || t.property_id === propertyId) && dayjs(t.occurred_at).isAfter(range.start.subtract(1,'day')) && dayjs(t.occurred_at).isBefore(range.end.add(1,'day')))
    const otherExp = exp.reduce((s, x) => s + Number(x.amount || 0), 0)
    return { income, cleaning, otherExp, net: income - cleaning - otherExp }
  }, [orders, txs, propertyId, year])
  const breakdown = useMemo(() => {
    const rows: { month: string; income: number; cleaning: number; other: number; net: number }[] = []
    let cur = range.start.startOf('month')
    while (cur.isBefore(range.end.add(1, 'day'))) {
      const mStart = cur.startOf('month')
      const mEnd = cur.endOf('month')
      const o = orders.filter(o => (!propertyId || o.property_id === propertyId) && o.checkout && dayjs(o.checkout).isAfter(mStart.subtract(1,'day')) && dayjs(o.checkout).isBefore(mEnd.add(1,'day')))
      const income = o.reduce((s, x) => s + Number(x.price || 0), 0)
      const cleaning = o.reduce((s, x) => s + Number(x.cleaning_fee || 0), 0)
      const exp = txs.filter(t => t.kind === 'expense' && (!propertyId || t.property_id === propertyId) && dayjs(t.occurred_at).isAfter(mStart.subtract(1,'day')) && dayjs(t.occurred_at).isBefore(mEnd.add(1,'day')))
      const other = exp.reduce((s, x) => s + Number(x.amount || 0), 0)
      const net = income - cleaning - other
      rows.push({ month: mStart.format('MM/YYYY'), income, cleaning, other, net })
      cur = cur.add(1, 'month')
    }
    return rows
  }, [orders, txs, propertyId, range])
  function downloadPdf() { window.print() }
  async function sendEmail() {
    const res = await fetch(`${API_BASE}/finance/send-annual`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` }, body: JSON.stringify({ landlord_id: 'landlord', year }) })
    if (res.ok) message.success('已触发发送'); else message.error('发送失败')
  }
  return (
    <Card title="年度报表">
      <div style={{ marginBottom: 12 }}>
        <Select value={year} onChange={setYear} style={{ width: 120 }} options={[...Array(5)].map((_,i)=>({value: dayjs().year()-i, label: String(dayjs().year()-i)}))} />
        <Select value={period} onChange={setPeriod} style={{ width: 140, marginLeft: 8 }} options={[{value:'year',label:'全年'},{value:'half-year',label:'半年'}]} />
        {period==='half-year' ? <DatePicker picker="month" value={startMonth} onChange={setStartMonth as any} style={{ marginLeft: 8 }} /> : null}
        <Select allowClear placeholder="选择房源" style={{ width: 220, marginLeft: 8 }} options={properties.map(p => ({ value: p.id, label: p.code || p.address || p.id }))} value={propertyId} onChange={setPropertyId} />
        <Button style={{ marginLeft: 8 }} onClick={downloadPdf}>下载PDF</Button>
        <Button type="primary" style={{ marginLeft: 8 }} onClick={sendEmail}>发送邮件</Button>
      </div>
      <div ref={ref}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <tbody>
            <tr><td>年度租金总收入</td><td>{stats.income}</td></tr>
            <tr><td>清洁费</td><td>{stats.cleaning}</td></tr>
            <tr><td>其他支出</td><td>{stats.otherExp}</td></tr>
            <tr><td><b>净收入</b></td><td><b>{stats.net}</b></td></tr>
          </tbody>
        </table>
        <div style={{ marginTop: 12 }}>
          <Table rowKey={(r)=>r.month} pagination={false} dataSource={breakdown} columns={[{title:'月份',dataIndex:'month'},{title:'租金收入',dataIndex:'income'},{title:'清洁费',dataIndex:'cleaning'},{title:'其他支出',dataIndex:'other'},{title:'净收入',dataIndex:'net'}]} />
        </div>
      </div>
    </Card>
  )
}
