"use client"
import { Card, DatePicker, Button, Select, Switch } from 'antd'
import dayjs from 'dayjs'
import { useEffect, useRef, useState } from 'react'
import { apiList, getJSON } from '../../../lib/api'
import MonthlyStatementView from '../../../components/MonthlyStatement'
import { buildStatementTxs } from '../../../lib/statementTx'

type Order = { id: string; property_id?: string; checkin?: string; checkout?: string; price?: number; nights?: number }
type Tx = { id: string; kind: 'income'|'expense'; amount: number; currency: string; property_id?: string; occurred_at: string; category?: string; category_detail?: string; note?: string; ref_type?: string; ref_id?: string }
type Landlord = { id: string; name: string; management_fee_rate?: number; property_ids?: string[] }

export default function MonthlyStatementPage() {
  const [month, setMonth] = useState<any>(dayjs())
  const [propertyId, setPropertyId] = useState<string | undefined>(undefined)
  const [orders, setOrders] = useState<Order[]>([])
  const [txs, setTxs] = useState<Tx[]>([])
  const [properties, setProperties] = useState<{ id: string; code?: string; address?: string }[]>([])
  const [landlords, setLandlords] = useState<Landlord[]>([])
  const [showChinese, setShowChinese] = useState<boolean>(true)
  const [embed, setEmbed] = useState<boolean>(false)
  const [pdfMode, setPdfMode] = useState<boolean>(false)
  const ref = useRef<HTMLDivElement>(null)
  const printed = useRef<boolean>(false)
  const inited = useRef<boolean>(false)
  const autoPrint = useRef<boolean>(false)
  useEffect(() => {
    if (inited.current) return
    inited.current = true
    try {
      const qs = typeof window !== 'undefined' ? window.location.search : ''
      const sp = new URLSearchParams(qs || '')
      const m = sp.get('month') || ''
      const pid = sp.get('pid') || ''
      autoPrint.current = sp.get('autoprint') === '1'
      setEmbed(sp.get('embed') === '1')
      setPdfMode(sp.get('pdf') === '1')
      const sc = sp.get('showChinese')
      if (sc === '0' || sc === '1') setShowChinese(sc === '1')
      if (m) setMonth(dayjs(m))
      if (pid) setPropertyId(pid)
    } catch {}
  }, [])
  useEffect(() => { getJSON<any>('/properties').then(j => setProperties(j || [])).catch(() => setProperties([])) }, [])
  useEffect(() => {
    getJSON<Order[]>('/orders').then(setOrders).catch(() => setOrders([]))
    ;(async () => {
      try {
        const fin: any[] = await getJSON<Tx[]>('/finance')
        const pexp: any[] = await apiList<any[]>('property_expenses')
        const recurs: any[] = await apiList<any[]>('recurring_payments')
        const built = buildStatementTxs(Array.isArray(fin) ? fin : [], Array.isArray(pexp) ? pexp : [], {
          properties,
          recurring_payments: Array.isArray(recurs) ? recurs : [],
          excludeOrphanFixedSnapshots: false,
        })
        setTxs(built.txs as any)
      } catch { setTxs([]) }
    })()
    getJSON<Landlord[]>('/landlords').then(setLandlords).catch(() => setLandlords([]))
  }, [properties])

  function downloadPdf() { if (ref.current) window.print() }

  useEffect(() => {
    if (!printed.current && autoPrint.current && ref.current) {
      printed.current = true
      try { window.print() } catch {}
    }
  }, [orders, txs, properties, landlords])

  return (
    <Card title={embed ? undefined : '月度收入报表'} bordered={!embed}>
      {!embed ? (
        <div style={{ marginBottom: 12 }}>
          <DatePicker picker="month" value={month} onChange={setMonth as any} />
          <Select allowClear placeholder="选择房源" style={{ width: 220, marginLeft: 8 }} options={properties.map(p => ({ value: p.id, label: p.code || p.address || p.id }))} value={propertyId} onChange={setPropertyId} />
          <span style={{ marginLeft: 12 }}>包含中文说明</span>
          <Switch style={{ marginLeft: 8 }} checked={showChinese} onChange={setShowChinese as any} />
          <Button style={{ marginLeft: 8 }} onClick={downloadPdf}>下载PDF</Button>
        </div>
      ) : null}
      {propertyId ? (
        <MonthlyStatementView
          ref={ref}
          month={month.format('YYYY-MM')}
          propertyId={propertyId}
          orders={orders as any}
          txs={txs as any}
          properties={properties as any}
          landlords={landlords as any}
          showChinese={showChinese}
          showInvoices={!embed}
          pdfMode={pdfMode}
          renderEngine="print"
        />
      ) : (
        embed ? <div /> : <div style={{ padding: 24, color:'#999' }}>请选择房源</div>
      )}
    </Card>
  )
}
