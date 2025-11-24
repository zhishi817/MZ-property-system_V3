"use client"
import { Card, DatePicker, Table, Select, Button, Modal } from 'antd'
import dayjs from 'dayjs'
import { useEffect, useMemo, useRef, useState } from 'react'
import { getJSON } from '../../../lib/api'
import MonthlyStatementView from '../../../components/MonthlyStatement'

type Order = { id: string; property_id?: string; checkin?: string; checkout?: string; price?: number; nights?: number }
type Tx = { id: string; kind: 'income'|'expense'; amount: number; currency: string; property_id?: string; occurred_at: string; category?: string }
type Landlord = { id: string; management_fee_rate?: number; property_ids?: string[] }

export default function PropertyRevenuePage() {
  const [month, setMonth] = useState<any>(dayjs())
  const [orders, setOrders] = useState<Order[]>([])
  const [txs, setTxs] = useState<Tx[]>([])
  const [properties, setProperties] = useState<{ id: string; code?: string; address?: string }[]>([])
  const [landlords, setLandlords] = useState<Landlord[]>([])
  const [previewPid, setPreviewPid] = useState<string | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const printRef = useRef<HTMLDivElement>(null)
  useEffect(() => { getJSON<Order[]>('/orders').then(setOrders).catch(()=>setOrders([])); getJSON<Tx[]>('/finance').then(setTxs).catch(()=>setTxs([])); getJSON<any>('/properties').then((j)=>setProperties(j||[])).catch(()=>setProperties([])); getJSON<Landlord[]>('/landlords').then(setLandlords).catch(()=>setLandlords([])) }, [])
  const ym = month ? { y: month.year(), m: month.month()+1 } : null
  const start = ym ? dayjs(`${ym.y}-${String(ym.m).padStart(2,'0')}-01`) : null
  const end = start ? start.endOf('month') : null

  const rows = useMemo(() => {
    if (!start || !end) return [] as any[]
    return properties.map(p => {
      const o = orders.filter(x => x.property_id === p.id && x.checkout && dayjs(x.checkout).isAfter(start.subtract(1,'day')) && dayjs(x.checkout).isBefore(end.add(1,'day')))
      const e = txs.filter(x => x.kind==='expense' && x.property_id === p.id && dayjs(x.occurred_at).isAfter(start.subtract(1,'day')) && dayjs(x.occurred_at).isBefore(end.add(1,'day')))
      const rentIncome = o.reduce((s,x)=> s + Number(x.price||0), 0)
      const extraInc = txs.filter(x => x.kind==='income' && x.property_id === p.id && ['late_checkout','cancel_fee'].includes(String(x.category||'')) && dayjs(x.occurred_at).isAfter(start.subtract(1,'day')) && dayjs(x.occurred_at).isBefore(end.add(1,'day'))).reduce((s,x)=> s + Number(x.amount||0), 0)
      const income = rentIncome + extraInc
      const nights = o.reduce((s,x)=> s + Number(x.nights ?? Math.max(dayjs(x.checkout!).diff(dayjs(x.checkin!), 'day'), 0)), 0)
      const daysInMonth = end.diff(start,'day') + 1
      const occRate = daysInMonth ? Math.round(((nights / daysInMonth)*100 + Number.EPSILON)*100)/100 : 0
      const avg = nights ? Math.round(((income / nights) + Number.EPSILON)*100)/100 : 0
      const landlord = landlords.find(l => (l.property_ids||[]).includes(p.id))
      const mgmt = landlord?.management_fee_rate ? Math.round(((rentIncome * landlord.management_fee_rate) + Number.EPSILON)*100)/100 : 0
      const sumCat = (c: string) => e.filter(xx=>xx.category===c).reduce((s,x)=> s + Number(x.amount||0), 0)
      const electricity = sumCat('electricity')
      const water = sumCat('water')
      const gas = sumCat('gas')
      const internet = sumCat('internet')
      const consumable = sumCat('consumable')
      const carpark = sumCat('carpark')
      const ownercorp = sumCat('property_fee')
      const council = sumCat('council')
      const other = sumCat('other')
      const totalExp = mgmt + electricity + water + gas + internet + consumable + carpark + ownercorp + council + other
      const net = Math.round(((income - totalExp) + Number.EPSILON)*100)/100
      return { key: p.id, code: p.code || p.id, address: p.address, occRate, avg, income, mgmt, electricity, water, gas, internet, consumable, carpark, ownercorp, council, other, totalExp, net }
    })
  }, [properties, orders, txs, landlords, start, end])

  const fmt = (n: number) => (n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const columns = [
    { title:'房号', dataIndex:'code' },
    { title:'地址', dataIndex:'address' },
    { title:'入住率', dataIndex:'occRate', render:(v: number)=> `${fmt(v)}%` },
    { title:'日均租金', dataIndex:'avg', render:(v: number)=> `$${fmt(v)}` },
    { title:'租金收入', dataIndex:'income', render:(v: number)=> `$${fmt(v)}` },
    { title:'管理费', dataIndex:'mgmt', render:(v: number)=> `-$${fmt(v)}` },
    { title:'电费', dataIndex:'electricity', render:(v: number)=> `-$${fmt(v)}` },
    { title:'水费', dataIndex:'water', render:(v: number)=> `-$${fmt(v)}` },
    { title:'气费', dataIndex:'gas', render:(v: number)=> `-$${fmt(v)}` },
    { title:'网费', dataIndex:'internet', render:(v: number)=> `-$${fmt(v)}` },
    { title:'消耗品费', dataIndex:'consumable', render:(v: number)=> `-$${fmt(v)}` },
    { title:'车位费', dataIndex:'carpark', render:(v: number)=> `-$${fmt(v)}` },
    { title:'物业费', dataIndex:'ownercorp', render:(v: number)=> `-$${fmt(v)}` },
    { title:'市政费', dataIndex:'council', render:(v: number)=> `-$${fmt(v)}` },
    { title:'其他支出', dataIndex:'other', render:(v: number)=> `-$${fmt(v)}` },
    { title:'总支出', dataIndex:'totalExp', render:(v: number)=> `-$${fmt(v)}` },
    { title:'净收入', dataIndex:'net', render:(v: number)=> `$${fmt(v)}` },
    { title:'操作', render: (_: any, r: any) => (
      <Button onClick={() => { setPreviewPid(r.key); setPreviewOpen(true) }}>预览/导出</Button>
    ) },
  ]

  return (
    <Card title="房源营收">
      <div style={{ marginBottom: 12, display:'flex', gap:8 }}>
        <DatePicker picker="month" value={month} onChange={setMonth as any} />
        <Select allowClear placeholder="按房号筛选" style={{ width: 240 }} options={properties.map(p=>({ value:p.id, label:p.code || p.address || p.id }))} onChange={(pid)=>{ /* 单房源筛选可后续扩展 */ }} />
      </div>
      <Table rowKey={(r)=>r.key} columns={columns as any} dataSource={rows} scroll={{ x: 'max-content' }} pagination={{ pageSize: 20 }} />
      <Modal title="月度报告" open={previewOpen} onCancel={() => setPreviewOpen(false)} footer={<Button type="primary" onClick={async () => {
        if (!printRef.current) return
        const style = `
          <style>
            html, body { font-family: 'Times New Roman', Times, serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
            @page { margin: 15mm; size: A4 portrait; }
            table { width: 100%; border-collapse: collapse; }
            th, td { border-bottom: 1px solid #ddd; }
          </style>
        `
        const iframe = document.createElement('iframe')
        iframe.style.position = 'fixed'
        iframe.style.left = '-9999px'
        iframe.style.top = '-9999px'
        iframe.style.width = '0'
        iframe.style.height = '0'
        document.body.appendChild(iframe)
        const doc = iframe.contentDocument || (iframe as any).document
        const html = `<html><head><title>Monthly Statement</title>${style}<base href="${location.origin}"></head><body>${printRef.current.innerHTML}</body></html>`
        doc.open(); doc.write(html); doc.close()
        const imgs = Array.from(doc.images || [])
        await Promise.all(imgs.map((img: any) => img.complete ? Promise.resolve(null) : new Promise((resolve) => { img.addEventListener('load', resolve); img.addEventListener('error', resolve) })))
        await new Promise(r => setTimeout(r, 50))
        try { (iframe.contentWindow as any).focus(); (iframe.contentWindow as any).print() } catch {}
        setTimeout(() => { try { document.body.removeChild(iframe) } catch {} }, 500)
      }}>导出PDF</Button>} width={900}>
        {previewPid ? (
          <MonthlyStatementView ref={printRef} month={month.format('YYYY-MM')} propertyId={previewPid || undefined} orders={orders} txs={txs} properties={properties} landlords={landlords} />
        ) : null}
      </Modal>
    </Card>
  )
}
