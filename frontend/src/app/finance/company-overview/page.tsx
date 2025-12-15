"use client"
import { Card, DatePicker, Table, Select, Button, Modal, message } from 'antd'
import html2canvas from 'html2canvas'
import { jsPDF } from 'jspdf'
import dayjs from 'dayjs'
import { useEffect, useMemo, useRef, useState } from 'react'
import { getJSON, apiList, API_BASE, authHeaders } from '../../../lib/api'
import MonthlyStatementView from '../../../components/MonthlyStatement'
import FiscalYearStatement from '../../../components/FiscalYearStatement'

type Order = { id: string; property_id?: string; checkin?: string; checkout?: string; price?: number; cleaning_fee?: number; nights?: number }
type Tx = { id: string; kind: 'income'|'expense'; amount: number; currency: string; property_id?: string; occurred_at: string; category?: string }
type Landlord = { id: string; name: string; management_fee_rate?: number; property_ids?: string[] }

export default function PropertyRevenuePage() {
  const [month, setMonth] = useState<any>(dayjs())
  const [orders, setOrders] = useState<Order[]>([])
  const [txs, setTxs] = useState<Tx[]>([])
  const [properties, setProperties] = useState<{ id: string; code?: string; address?: string }[]>([])
  const [landlords, setLandlords] = useState<Landlord[]>([])
  const [selectedPid, setSelectedPid] = useState<string | undefined>(undefined)
  const [previewPid, setPreviewPid] = useState<string | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const printRef = useRef<HTMLDivElement>(null)
  const [period, setPeriod] = useState<'month'|'year'|'half-year'|'fiscal-year'>('month')
  const [startMonth, setStartMonth] = useState<any>(dayjs())
  useEffect(() => {
    getJSON<Order[]>('/orders').then(setOrders).catch(()=>setOrders([]))
    ;(async () => {
      try {
        const fin: any[] = await getJSON<Tx[]>('/finance')
        const pexp: any[] = await apiList<any[]>('property_expenses')
        const mapCat = (c?: string) => {
          const v = String(c || '')
          if (v === 'gas_hot_water') return 'gas'
          if (v === 'consumables') return 'consumable'
          if (v === 'owners_corp') return 'property_fee'
          if (v === 'council_rate') return 'council'
          return v
        }
        const peMapped: Tx[] = (Array.isArray(pexp) ? pexp : []).map((r: any) => ({
          id: r.id,
          kind: 'expense',
          amount: Number(r.amount || 0),
          currency: r.currency || 'AUD',
          property_id: r.property_id || undefined,
          occurred_at: r.occurred_at,
          category: mapCat(r.category),
          // 其他支出描述
          ...(r.category_detail ? { category_detail: r.category_detail } : {}),
          ...(r.invoice_url ? { invoice_url: r.invoice_url } : {})
        }))
        const finMapped: Tx[] = (Array.isArray(fin) ? fin : []).map((t: any) => ({
          id: t.id,
          kind: t.kind,
          amount: Number(t.amount || 0),
          currency: t.currency || 'AUD',
          property_id: t.property_id || undefined,
          occurred_at: t.occurred_at,
          category: mapCat(t.category),
          ...(t.category_detail ? { category_detail: t.category_detail } : {})
          ,...(t.invoice_url ? { invoice_url: t.invoice_url } : {})
        }))
        setTxs([...finMapped, ...peMapped])
      } catch { setTxs([]) }
    })()
    getJSON<any>('/properties').then((j)=>setProperties(j||[])).catch(()=>setProperties([]))
    getJSON<Landlord[]>('/landlords').then(setLandlords).catch(()=>setLandlords([]))
  }, [])
  const start = useMemo(() => {
    const base = month || dayjs()
    if (period === 'fiscal-year') {
      const fyStartYear = base.month() >= 6 ? base.year() : base.year() - 1
      return dayjs(`${fyStartYear}-07-01`)
    }
    if (period === 'year') return base.startOf('year')
    if (period === 'half-year') return (startMonth || base).startOf('month')
    return base.startOf('month')
  }, [month, period, startMonth])
  const end = useMemo(() => {
    const base = month || dayjs()
    if (period === 'fiscal-year') {
      const fyStartYear = base.month() >= 6 ? base.year() : base.year() - 1
      return dayjs(`${fyStartYear + 1}-06-30`).endOf('day')
    }
    if (period === 'year') return base.endOf('year')
    if (period === 'half-year') return (startMonth || base).startOf('month').add(5, 'month').endOf('month')
    return base.endOf('month')
  }, [month, period, startMonth])

  const rows = useMemo(() => {
    if (!start || !end) return [] as any[]
    const list = selectedPid ? properties.filter(pp => pp.id === selectedPid) : properties
    const out: any[] = []
    const rangeMonths: { start: any, end: any, label: string }[] = []
    let cur = start.startOf('month')
    const last = end.startOf('month')
    while (cur.isSame(last, 'month') || cur.isBefore(last, 'month')) {
      rangeMonths.push({ start: cur.startOf('month'), end: cur.endOf('month'), label: cur.format('MM/YYYY') })
      cur = cur.add(1,'month')
    }
    for (const p of list) {
      for (const rm of rangeMonths) {
        const related = orders.filter(x => x.property_id === p.id && x.checkin && x.checkout && dayjs(x.checkout).isAfter(rm.start) && dayjs(x.checkin).isBefore(rm.end))
        const e = txs.filter(x => x.kind==='expense' && x.property_id === p.id && dayjs(x.occurred_at).isAfter(rm.start.subtract(1,'day')) && dayjs(x.occurred_at).isBefore(rm.end.add(1,'day')))
        const rentIncome = related.reduce((s,x)=> {
          const ci = dayjs(x.checkin!)
          const co = dayjs(x.checkout!)
          const totalN = Math.max(co.diff(ci,'day'), 0)
          const segStart = ci.isAfter(rm.start) ? ci : rm.start
          const segEnd = co.isBefore(rm.end) ? co : rm.end
          const segN = Math.max(segEnd.diff(segStart,'day'), 0)
          const perDay = totalN ? Number(x.price||0) / totalN : 0
          return s + perDay * segN
        }, 0)
        const otherIncomeTx = txs.filter(x => x.kind==='income' && x.property_id === p.id && dayjs(x.occurred_at).isAfter(rm.start.subtract(1,'day')) && dayjs(x.occurred_at).isBefore(rm.end.add(1,'day')))
        const otherIncome = otherIncomeTx.reduce((s,x)=> s + Number(x.amount||0), 0)
        const mapIncomeCatLabel = (c?: string) => {
          const v = String(c || '')
          if (v === 'late_checkout') return '晚退房费'
          if (v === 'cancel_fee') return '取消费'
          return v || '-'
        }
        const otherIncomeDesc = Array.from(new Set(otherIncomeTx.map(t => mapIncomeCatLabel(t.category)))).filter(Boolean).join('、') || '-'
        const totalIncome = rentIncome + otherIncome
        const nights = related.reduce((s,x)=> {
          const ci = dayjs(x.checkin!)
          const co = dayjs(x.checkout!)
          const segStart = ci.isAfter(rm.start) ? ci : rm.start
          const segEnd = co.isBefore(rm.end) ? co : rm.end
          const segN = Math.max(segEnd.diff(segStart,'day'), 0)
          return s + segN
        }, 0)
        const daysInMonth = rm.end.diff(rm.start,'day') + 1
        const occRate = daysInMonth ? Math.round(((nights / daysInMonth)*100 + Number.EPSILON)*100)/100 : 0
        const avg = nights ? Math.round(((totalIncome / nights) + Number.EPSILON)*100)/100 : 0
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
        const otherExpenseDesc = (e.filter(xx=>xx.category==='other' && (xx as any).category_detail).map(xx => String((xx as any).category_detail || '').trim()).filter(Boolean))
        const otherExpenseDescStr = Array.from(new Set(otherExpenseDesc)).join('、') || '-'
        const totalExp = mgmt + electricity + water + gas + internet + consumable + carpark + ownercorp + council + other
        const net = Math.round(((totalIncome - totalExp) + Number.EPSILON)*100)/100
        out.push({ key: `${p.id}-${rm.label}`, pid: p.id, month: rm.label, code: p.code || p.id, address: p.address, occRate, avg, totalIncome, rentIncome, otherIncome, otherIncomeDesc, mgmt, electricity, water, gas, internet, consumable, carpark, ownercorp, council, other, otherExpenseDesc: otherExpenseDescStr, totalExp, net })
      }
    }
    return out
  }, [properties, orders, txs, landlords, start, end, selectedPid])

  const totals = useMemo(() => {
    const sum = (arr: any[], key: string) => arr.reduce((s, x) => s + Number(x?.[key] || 0), 0)
    const income = sum(rows, 'totalIncome')
    const expense = sum(rows, 'totalExp')
    const net = income - expense
    const fmt2 = (n: number) => (n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    return { income: fmt2(income), expense: fmt2(expense), net: fmt2(net) }
  }, [rows])

  const fmt = (n: number) => (n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const columns = [
    { title:'月份', dataIndex:'month' },
    { title:'房号', dataIndex:'code' },
    { title:'地址', dataIndex:'address' },
    { title:'入住率', dataIndex:'occRate', render:(v: number)=> `${fmt(v)}%` },
    { title:'日均租金', dataIndex:'avg', render:(v: number)=> `$${fmt(v)}` },
    { title:'总收入', dataIndex:'totalIncome', render:(v: number)=> `$${fmt(v)}` },
    { title:'租金收入', dataIndex:'rentIncome', render:(v: number)=> `$${fmt(v)}` },
    { title:'其他收入', dataIndex:'otherIncome', render:(v: number)=> `$${fmt(v)}` },
    { title:'其他收入描述', dataIndex:'otherIncomeDesc' },
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
    { title:'其他支出描述', dataIndex:'otherExpenseDesc' },
    { title:'总支出', dataIndex:'totalExp', render:(v: number)=> `-$${fmt(v)}` },
    { title:'净收入', dataIndex:'net', render:(v: number)=> `$${fmt(v)}` },
    { title:'操作', render: (_: any, r: any) => (
      <Button onClick={() => { setPreviewPid(r.pid); setPreviewOpen(true) }}>预览/导出</Button>
    ) },
  ]

  return (
    <Card title="房源营收">
      <div style={{ marginBottom: 12, display:'flex', gap:8, alignItems:'center' }}>
        <DatePicker picker="month" value={month} onChange={setMonth as any} />
        <Select
          allowClear
          placeholder="选择范围(年/半年/财年)"
          value={period==='month' ? undefined : period}
          onChange={(v) => setPeriod((v as any) || 'month')}
          style={{ width: 220 }}
          options={[{value:'year',label:'全年(自然年)'},{value:'half-year',label:'半年'},{value:'fiscal-year',label:'财年(7月至次年6月)'}]}
        />
        {period==='half-year' ? <DatePicker picker="month" value={startMonth} onChange={setStartMonth as any} /> : null}
        <Select allowClear placeholder="按房号筛选" style={{ width: 240 }} options={properties.map(p=>({ value:p.id, label:p.code || p.address || p.id }))} value={selectedPid} onChange={setSelectedPid} />
        <Button type="primary" onClick={() => { if (!selectedPid) { message.warning('请先选择房号'); return } setPreviewPid(selectedPid); setPreviewOpen(true) }}>生成报表</Button>
      </div>
      {/* totals summary removed per request */}
      <Table rowKey={(r)=>r.key} columns={columns as any} dataSource={rows} scroll={{ x: 'max-content' }} pagination={{ pageSize: 20 }} />
      <Modal title={period==='month' ? '月度报告' : (period==='year' ? '年度报告' : (period==='fiscal-year' ? '财年报告' : '半年报告'))} open={previewOpen} onCancel={() => setPreviewOpen(false)} footer={<>
        <Button onClick={async () => {
          if (!printRef.current) return
          const style = `
            <style>
              html, body { font-family: 'Times New Roman', Times, serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
              @page { margin: 12mm; size: A4 ${period==='fiscal-year' ? 'landscape' : 'portrait'}; }
              body { width: ${period==='fiscal-year' ? '277mm' : '190mm'}; margin: 0 auto; }
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
          const html = `<html><head><title>Statement</title>${style}<base href="${location.origin}"></head><body>${printRef.current.innerHTML}</body></html>`
          doc.open(); doc.write(html); doc.close()
          const imgs = Array.from(doc.images || [])
          await Promise.all(imgs.map((img: any) => img.complete ? Promise.resolve(null) : new Promise((resolve) => { img.addEventListener('load', resolve); img.addEventListener('error', resolve) })))
          await new Promise(r => setTimeout(r, 50))
          try { (iframe.contentWindow as any).focus(); (iframe.contentWindow as any).print() } catch {}
          setTimeout(() => { try { document.body.removeChild(iframe) } catch {} }, 500)
        }}>导出PDF</Button>
        <Button type="primary" onClick={async () => {
          if (!printRef.current || !previewPid) return
          const node = printRef.current as HTMLElement
          const canvas = await html2canvas(node, { scale: 2 })
          const imgData = canvas.toDataURL('image/png')
          const pdf = new jsPDF('p', 'mm', 'a4')
          const pageWidth = 210
          const imgWidth = pageWidth - 20
          const imgHeight = (canvas.height * imgWidth) / canvas.width
          pdf.addImage(imgData, 'PNG', 10, 10, imgWidth, imgHeight)
          const statementBlob = pdf.output('blob') as Blob
          // Upload the generated statement PDF first
          const fd = new FormData()
          fd.append('file', statementBlob, `statement-${month.format('YYYY-MM')}.pdf`)
          const upRes = await fetch(`${API_BASE}/finance/invoices`, { method: 'POST', headers: { ...authHeaders() }, body: fd })
          if (!upRes.ok) throw new Error(`HTTP ${upRes.status}`)
          const upJson = await upRes.json()
          const statementUrl = upJson?.url
          const invUrls = txs.filter(t => t.kind==='expense' && t.property_id===previewPid && dayjs(t.occurred_at).isAfter(start!.subtract(1,'day')) && dayjs(t.occurred_at).isBefore(end!.add(1,'day'))).map(t => (t as any).invoice_url).filter((u: any) => !!u)
          try {
            const resp = await fetch(`${API_BASE}/finance/merge-pdf`, { method:'POST', headers: { 'Content-Type':'application/json', ...authHeaders() }, body: JSON.stringify({ statement_pdf_url: statementUrl, invoice_urls: invUrls }) })
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
            const blob = await resp.blob()
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            a.download = `statement-merged-${month.format('YYYY-MM')}.pdf`
            document.body.appendChild(a)
            a.click()
            document.body.removeChild(a)
            URL.revokeObjectURL(url)
          } catch (e: any) {
            message.error(e?.message || '合并下载失败')
          }
        }}>合并PDF下载</Button>
      </>} width={900}>
        {previewPid ? (
          period==='month' ? (
            <MonthlyStatementView ref={printRef} month={month.format('YYYY-MM')} propertyId={previewPid || undefined} orders={orders} txs={txs} properties={properties} landlords={landlords} />
          ) : period==='fiscal-year' ? (
            <FiscalYearStatement ref={printRef} baseMonth={month} propertyId={previewPid!} orders={orders} txs={txs} properties={properties} landlords={landlords} />
          ) : (
            <div ref={printRef as any}>
              {(() => {
                const pid = previewPid || undefined
                const prop = properties.find(p=>p.id===pid)
                const anchor = (function(){
                  const base = month || dayjs()
                  if (period==='year') return base.startOf('year')
                  return (startMonth || base).startOf('month')
                })()
                const endAnchor = (function(){
                  const base = month || dayjs()
                  if (period==='year') return base.endOf('year')
                  return anchor.add(5,'month').endOf('month')
                })()
                let cur = anchor.startOf('month')
                const rowz: any[] = []
                while (cur.isBefore(endAnchor.add(1,'day'))) {
                  const mStart = cur.startOf('month')
                  const mEnd = cur.endOf('month')
                  const o1 = orders.filter(o => o.property_id===pid && o.checkout && dayjs(o.checkout).isAfter(mStart.subtract(1,'day')) && dayjs(o.checkout).isBefore(mEnd.add(1,'day')))
                  const inc = o1.reduce((s,x)=> s + Number(x.price||0), 0)
                  const clean = o1.reduce((s,x)=> s + Number(x.cleaning_fee||0), 0)
                  const exp1 = txs.filter(t => t.kind==='expense' && t.property_id===pid && dayjs(t.occurred_at).isAfter(mStart.subtract(1,'day')) && dayjs(t.occurred_at).isBefore(mEnd.add(1,'day')))
                  const other = exp1.reduce((s,x)=> s + Number(x.amount||0), 0)
                  rowz.push({ month: mStart.format('MM/YYYY'), income: inc, cleaning: clean, other, net: inc - clean - other })
                  cur = cur.add(1,'month')
                }
                return (
                  <div>
                    <div style={{ display:'flex', justifyContent:'space-between', marginBottom:8 }}>
                      <div style={{ fontSize:18, fontWeight:700 }}>{period==='year' ? `${anchor.format('YYYY')} 年` : `${anchor.format('MM/YYYY')} 至 ${endAnchor.format('MM/YYYY')}`}</div>
                      <div style={{ textAlign:'right' }}>{prop?.code || ''} {prop?.address || ''}</div>
                    </div>
                    <table>
                      <thead>
                        <tr><th>月份</th><th>租金收入</th><th>清洁费</th><th>其他支出</th><th>净收入</th></tr>
                      </thead>
                      <tbody>
                        {rowz.map(r => (<tr key={r.month}><td>{r.month}</td><td>{r.income}</td><td>{r.cleaning}</td><td>{r.other}</td><td>{r.net}</td></tr>))}
                      </tbody>
                    </table>
                  </div>
                )
              })()}
            </div>
          )
        ) : null}
      </Modal>
    </Card>
  )
}
