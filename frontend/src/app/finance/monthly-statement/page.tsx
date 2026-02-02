"use client"
import { Card, DatePicker, Button, Select, Switch } from 'antd'
import dayjs from 'dayjs'
import { useEffect, useRef, useState } from 'react'
import { apiList, getJSON } from '../../../lib/api'
import MonthlyStatementView from '../../../components/MonthlyStatement'
import { normalizeReportCategory } from '../../../lib/financeTx'

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
        const mapCat = (c?: string) => {
          const v = String(c || '')
          if (v === 'gas_hot_water') return 'gas'
          if (v === 'consumables') return 'consumable'
          if (v === 'owners_corp') return 'property_fee'
          if (v === 'council_rate') return 'council'
          if (v.toLowerCase() === 'nbn' || v.toLowerCase() === 'internet' || v.includes('网')) return 'internet'
          return v
        }
        const mapReport: Record<string, string> = Object.fromEntries((Array.isArray(recurs) ? recurs : []).map((r: any) => [String(r.id), String(r.report_category || '')]))
        const mapVendor: Record<string, string> = Object.fromEntries((Array.isArray(recurs) ? recurs : []).map((r: any) => [String(r.id), String(r.vendor || '')]))
        const toReportCat = (raw?: string) => {
          const v = String(raw || '').toLowerCase()
          if (v.includes('management_fee') || v.includes('管理费')) return 'management_fee'
          if (v.includes('carpark') || v.includes('车位')) return 'parking_fee'
          if (v.includes('owners') || v.includes('body') || v.includes('物业')) return 'body_corp'
          if (v.includes('internet') || v.includes('nbn') || v.includes('网')) return 'internet'
          if (v.includes('electric') || v.includes('电')) return 'electricity'
          if ((v.includes('water') || v.includes('水')) && !v.includes('hot') && !v.includes('热')) return 'water'
          if (v.includes('gas') || v.includes('hot') || v.includes('热水') || v.includes('煤气')) return 'gas'
          if (v.includes('consumable') || v.includes('消耗')) return 'consumables'
          if (v.includes('council') || v.includes('市政')) return 'council'
          return 'other'
        }
        const peMapped: any[] = (Array.isArray(pexp) ? pexp : []).map((r: any) => {
          const code = String(r.property_code || '').trim()
          const pidRaw = r.property_id || undefined
          const match = properties.find(pp => (pp.code || '') === code)
          const pidNorm = (pidRaw && properties.some(pp => pp.id === pidRaw)) ? pidRaw : (match ? match.id : pidRaw)
          const fid = String(r.fixed_expense_id || '')
          const vendor = fid ? String(mapVendor[fid] || '') : ''
          const baseDetail = String(r.category_detail || '').trim()
          const injectedDetail = (!baseDetail && vendor) ? vendor : baseDetail
          return ({
            id: r.id,
            kind: 'expense',
            amount: Number(r.amount || 0),
            currency: r.currency || 'AUD',
            property_id: pidNorm,
            occurred_at: r.occurred_at,
            category: mapCat(r.category),
            ...(r.property_code ? { property_code: r.property_code } : {}),
            ...(injectedDetail ? { category_detail: injectedDetail } : {}),
            ...(r.note ? { note: r.note } : {}),
            ...(r.fixed_expense_id ? { fixed_expense_id: r.fixed_expense_id } : {}),
            ...(r.month_key ? { month_key: r.month_key } : {}),
            ...(r.due_date ? { due_date: r.due_date } : {}),
            ...(r.status ? { status: r.status } : {}),
            report_category: normalizeReportCategory((r.fixed_expense_id ? (mapReport[String(r.fixed_expense_id)] || '') : '') || toReportCat(r.category || r.category_detail))
          })
        })
        const finMapped: any[] = (Array.isArray(fin) ? fin : []).map((t: any) => ({
          id: t.id,
          kind: t.kind,
          amount: Number(t.amount || 0),
          currency: t.currency || 'AUD',
          property_id: t.property_id || undefined,
          occurred_at: t.occurred_at,
          category: mapCat(t.category),
          ...(t.category_detail ? { category_detail: t.category_detail } : {}),
          ...(t.note ? { note: t.note } : {}),
          ...(t.ref_type ? { ref_type: t.ref_type } : {}),
          ...(t.ref_id ? { ref_id: t.ref_id } : {}),
          ...(t.invoice_url ? { invoice_url: t.invoice_url } : {})
        }))
        setTxs([...finMapped, ...peMapped] as any)
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
    <Card title="月度收入报表">
      <div style={{ marginBottom: 12 }}>
        <DatePicker picker="month" value={month} onChange={setMonth as any} />
        <Select allowClear placeholder="选择房源" style={{ width: 220, marginLeft: 8 }} options={properties.map(p => ({ value: p.id, label: p.code || p.address || p.id }))} value={propertyId} onChange={setPropertyId} />
        <span style={{ marginLeft: 12 }}>包含中文说明</span>
        <Switch style={{ marginLeft: 8 }} checked={showChinese} onChange={setShowChinese as any} />
        <Button style={{ marginLeft: 8 }} onClick={downloadPdf}>下载PDF</Button>
      </div>
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
          showInvoices={true}
        />
      ) : (
        <div style={{ padding: 24, color:'#999' }}>请选择房源</div>
      )}
    </Card>
  )
}
