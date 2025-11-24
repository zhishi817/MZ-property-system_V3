"use client"
import { Card, DatePicker, Button, Select, message } from 'antd'
import dayjs from 'dayjs'
import { useEffect, useMemo, useRef, useState } from 'react'
import { getJSON, API_BASE } from '../../../lib/api'

type Order = { id: string; property_id?: string; checkin?: string; checkout?: string; price?: number; cleaning_fee?: number }
type Tx = { id: string; kind: 'income'|'expense'; amount: number; currency: string; property_id?: string; occurred_at: string }

export default function MonthlyStatementPage() {
  const [month, setMonth] = useState<any>(dayjs())
  const [propertyId, setPropertyId] = useState<string | undefined>(undefined)
  const [orders, setOrders] = useState<Order[]>([])
  const [txs, setTxs] = useState<Tx[]>([])
  const [properties, setProperties] = useState<{ id: string; code?: string; address?: string }[]>([])
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { getJSON<any>('/properties').then(j => setProperties(j || [])).catch(() => setProperties([])) }, [])
  useEffect(() => { getJSON<Order[]>('/orders').then(setOrders).catch(() => setOrders([])); getJSON<Tx[]>('/finance').then(setTxs).catch(() => setTxs([])) }, [])
  const ym = month ? { y: month.year(), m: month.month()+1 } : null
  const list = useMemo(() => {
    if (!ym) return [] as any[]
    const start = dayjs(`${ym.y}-${String(ym.m).padStart(2,'0')}-01`)
    const end = start.endOf('month')
    const o = orders.filter(o => (!propertyId || o.property_id === propertyId) && o.checkout && dayjs(o.checkout).isAfter(start.subtract(1,'day')) && dayjs(o.checkout).isBefore(end.add(1,'day')))
    const income = o.reduce((s, x) => s + Number(x.price || 0), 0)
    const cleaning = o.reduce((s, x) => s + Number(x.cleaning_fee || 0), 0)
    const exp = txs.filter(t => t.kind === 'expense' && (!propertyId || t.property_id === propertyId) && dayjs(t.occurred_at).isAfter(start.subtract(1,'day')) && dayjs(t.occurred_at).isBefore(end.add(1,'day')))
    const otherExp = exp.reduce((s, x) => s + Number(x.amount || 0), 0)
    return [{ income, cleaning, otherExp, net: income - cleaning - otherExp }]
  }, [orders, txs, ym, propertyId])
  function downloadPdf() {
    if (!ref.current) return
    window.print()
  }
  async function sendEmail() {
    const p = properties.find(p => p.id === propertyId)
    const res = await fetch(`${API_BASE}/finance/send-monthly`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` }, body: JSON.stringify({ landlord_id: 'landlord', month: month.format('YYYY-MM') }) })
    if (res.ok) message.success('已触发发送'); else message.error('发送失败')
  }
  return (
    <Card title="月度收入报表">
      <div style={{ marginBottom: 12 }}>
        <DatePicker picker="month" value={month} onChange={setMonth as any} />
        <Select allowClear placeholder="选择房源" style={{ width: 220, marginLeft: 8 }} options={properties.map(p => ({ value: p.id, label: p.code || p.address || p.id }))} value={propertyId} onChange={setPropertyId} />
        <Button style={{ marginLeft: 8 }} onClick={downloadPdf}>下载PDF</Button>
        <Button type="primary" style={{ marginLeft: 8 }} onClick={sendEmail}>发送邮件</Button>
      </div>
      <div ref={ref}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr><th style={{ textAlign:'left' }}>指标</th><th>金额 (AUD)</th></tr>
          </thead>
          <tbody>
            <tr><td>租金总收入</td><td>{list[0]?.income || 0}</td></tr>
            <tr><td>清洁费</td><td>{list[0]?.cleaning || 0}</td></tr>
            <tr><td>其他支出</td><td>{list[0]?.otherExp || 0}</td></tr>
            <tr><td><b>净收入</b></td><td><b>{list[0]?.net || 0}</b></td></tr>
          </tbody>
        </table>
      </div>
    </Card>
  )
}

