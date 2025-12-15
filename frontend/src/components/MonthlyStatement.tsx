"use client"
import dayjs from 'dayjs'
import { Table } from 'antd'
import { forwardRef } from 'react'
const API_BASE = process.env.NEXT_PUBLIC_API_BASE || 'http://localhost:4001'

type Order = { id: string; property_id?: string; checkin?: string; checkout?: string; price?: number; nights?: number }
type Tx = { id: string; kind: 'income'|'expense'; amount: number; currency: string; property_id?: string; occurred_at: string; category?: string; category_detail?: string; invoice_url?: string; note?: string }
type Landlord = { id: string; name: string; management_fee_rate?: number; property_ids?: string[] }

export default forwardRef<HTMLDivElement, {
  month: string
  propertyId?: string
  orders: Order[]
  txs: Tx[]
  properties: { id: string; code?: string; address?: string }[]
  landlords: Landlord[]
}>(function MonthlyStatementView({ month, propertyId, orders, txs, properties, landlords }, ref) {
  const start = dayjs(`${month}-01`)
  const end = start.endOf('month')
  const relatedOrders = orders.filter(o => (!propertyId || o.property_id === propertyId) && o.checkin && o.checkout && dayjs(o.checkout).isAfter(start) && dayjs(o.checkin).isBefore(end))
  const expensesInMonth = txs.filter(t => t.kind === 'expense' && (!propertyId || t.property_id === propertyId) && dayjs(t.occurred_at).isAfter(start.subtract(1,'day')) && dayjs(t.occurred_at).isBefore(end.add(1,'day')))
  const orderIncomeShare = relatedOrders.reduce((s, x) => {
    const ci = dayjs(x.checkin!)
    const co = dayjs(x.checkout!)
    const totalN = Math.max(co.diff(ci,'day'), 0)
    const segStart = ci.isAfter(start) ? ci : start
    const segEnd = co.isBefore(end) ? co : end
    const segN = Math.max(segEnd.diff(segStart,'day'), 0)
    const perDay = totalN ? Number(x.price||0) / totalN : 0
    return s + perDay * segN
  }, 0)
  const rentIncome = orderIncomeShare
  const otherIncomeTx = txs.filter(t => t.kind === 'income' && (!propertyId || t.property_id === propertyId) && dayjs(t.occurred_at).isAfter(start.subtract(1,'day')) && dayjs(t.occurred_at).isBefore(end.add(1,'day')))
  const otherIncome = otherIncomeTx.reduce((s,x)=> s + Number(x.amount || 0), 0)
  const mapIncomeCatLabel = (c?: string) => {
    const v = String(c || '')
    if (v === 'late_checkout') return '晚退房费'
    if (v === 'cancel_fee') return '取消费'
    return v || '-'
  }
  const otherIncomeDesc = Array.from(new Set(otherIncomeTx.map(t => mapIncomeCatLabel(t.category)))).filter(Boolean).join('、') || '-'
  const totalIncome = rentIncome + otherIncome
  const occupiedNights = relatedOrders.reduce((s, x) => {
    const ci = dayjs(x.checkin!)
    const co = dayjs(x.checkout!)
    const segStart = ci.isAfter(start) ? ci : start
    const segEnd = co.isBefore(end) ? co : end
    const segN = Math.max(segEnd.diff(segStart,'day'), 0)
    return s + segN
  }, 0)
  const daysInMonth = end.diff(start, 'day') + 1
  const occupancyRate = daysInMonth ? Math.round(((occupiedNights / daysInMonth) * 100 + Number.EPSILON) * 100) / 100 : 0
  const dailyAverage = occupiedNights ? Math.round(((totalIncome / occupiedNights) + Number.EPSILON) * 100) / 100 : 0
  const landlord = landlords.find(l => (l.property_ids || []).includes(propertyId || ''))
  const property = properties.find(pp => pp.id === (propertyId || ''))
  const managementFee = landlord?.management_fee_rate ? Math.round(((rentIncome * landlord.management_fee_rate) + Number.EPSILON) * 100) / 100 : 0
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
  const otherExpenseDesc = Array.from(new Set(expensesInMonth.filter(e => e.category === 'other' && (e as any).category_detail).map(e => String((e as any).category_detail || '').trim()).filter(Boolean))).join('、') || '-'
  const totalExpense = managementFee + catElectricity + catWater + catGas + catInternet + catConsumable + catCarpark + catOwnerCorp + catCouncil + catOther
  const netIncome = Math.round(((totalIncome - totalExpense) + Number.EPSILON) * 100) / 100
  const isImg = (u?: string) => !!u && /\.(png|jpg|jpeg|gif)$/i.test(u)
  const isPdf = (u?: string) => !!u && /\.pdf$/i.test(u)
  const resolveUrl = (u?: string) => (u && /^https?:\/\//.test(u)) ? u : (u ? `${API_BASE}${u}` : '')
  const fmt = (n: number) => (n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  function perDayPrice(o: Order): number {
    const ci = o.checkin ? dayjs(o.checkin) : null
    const co = o.checkout ? dayjs(o.checkout) : null
    if (!ci || !co) return 0
    const totalN = Math.max(co.diff(ci, 'day'), 0)
    if (!totalN) return 0
    return Number(o.price || 0) / totalN
  }
  const weekStart = start.startOf('week')
  const weekEnd = end.endOf('week')
  const days: any[] = []
  { let d = weekStart.clone(); while (d.isBefore(weekEnd.add(1,'day'))) { days.push(d.clone()); d = d.add(1,'day') } }
  function buildWeekSegments(ws: any, we: any) {
    const segs: Array<{ id: string; startIdx: number; endIdx: number; o: Order }> = []
    relatedOrders.forEach((o) => {
      const ci = o.checkin ? dayjs(o.checkin).startOf('day') : null
      const co = o.checkout ? dayjs(o.checkout).startOf('day') : null
      if (!ci || !co) return
      const s = ci.isAfter(ws) ? ci : ws
      const e = co.isBefore(we.add(1,'millisecond')) ? co : we.add(1,'millisecond')
      if (!(e.isAfter(s))) return
      const startIdx = Math.max(0, s.diff(ws.startOf('day'), 'day'))
      const endIdx = Math.max(0, e.subtract(1,'day').diff(ws.startOf('day'), 'day'))
      segs.push({ id: o.id, startIdx, endIdx, o })
    })
    segs.sort((a,b)=> a.startIdx - b.startIdx || a.endIdx - b.endIdx)
    const lanesEnd: number[] = []
    const laneMap: Record<string, number> = {}
    segs.forEach(seg => {
      let placed = false
      for (let i = 0; i < lanesEnd.length; i++) {
        if (seg.startIdx > lanesEnd[i]) { laneMap[seg.id] = i; lanesEnd[i] = seg.endIdx; placed = true; break }
      }
      if (!placed) { laneMap[seg.id] = lanesEnd.length; lanesEnd.push(seg.endIdx) }
    })
    return { segs, laneMap, laneCount: lanesEnd.length }
  }
  const sourceColor: Record<string, string> = { airbnb: '#FF9F97', booking: '#98B6EC', offline: '#DC8C03', other: '#98B6EC' }

  return (
    <div ref={ref as any} style={{ padding: 24, fontFamily: 'Times New Roman, Times, serif' }}>
      <div className="print-header" style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
        <img src="/company-logo.png" alt="Company Logo" style={{ height: 64 }} />
        <div style={{ flex: 1, marginLeft: 12 }}></div>
        <div style={{ textAlign:'right', minWidth: 420 }}>
          <div style={{ fontSize: 34, fontWeight: 700, letterSpacing: 1 }}>MONTHLY STATEMENT</div>
          <div style={{ borderTop: '2px solid #000', marginTop: 6 }}></div>
          <div style={{ display:'flex', flexDirection:'column', alignItems:'flex-end', marginTop: 6 }}>
            <div style={{ fontSize: 22, fontWeight: 700 }}>{dayjs(`${month}-01`).format('MM/YYYY')}</div>
          <div style={{ fontSize: 16, marginTop: 4 }}>{landlord?.name || ''}</div>
          <div style={{ fontSize: 14 }}>{property?.code || ''}</div>
          <div style={{ fontSize: 14 }}>{property?.address || ''}</div>
          </div>
        </div>
      </div>
      <div style={{ borderTop: '2px solid transparent', margin: '8px 0' }}></div>
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
          <tr><td style={{ padding:6, textIndent:'4ch' }}>Rent Income 租金收入</td><td style={{ textAlign:'right', padding:6 }}>${fmt(rentIncome)}</td></tr>
          <tr><td style={{ padding:6, textIndent:'4ch' }}>Other Income 其他收入</td><td style={{ textAlign:'right', padding:6 }}>${fmt(otherIncome)}</td></tr>
          <tr><td style={{ padding:6, textIndent:'4ch' }}>Other Income Desc 其他收入描述</td><td style={{ textAlign:'right', padding:6 }}>{otherIncomeDesc}</td></tr>
        </tbody>
      </table>

      <div style={{ fontWeight: 700, display:'flex', justifyContent:'space-between', padding:'6px 8px', marginTop: 8 }}>
        <span>Total Expense 总支出</span><span>${fmt(totalExpense)}</span>
      </div>
      <table style={{ width:'100%' }}>
        <tbody>
          <tr><td style={{ padding:6, textIndent:'4ch' }}>Management Fee 管理费</td><td style={{ textAlign:'right', padding:6 }}>-${fmt(managementFee)}</td></tr>
          <tr><td style={{ padding:6, textIndent:'4ch' }}>Electricity 电费</td><td style={{ textAlign:'right', padding:6 }}>-${fmt(catElectricity)}</td></tr>
          <tr><td style={{ padding:6, textIndent:'4ch' }}>Water 水费</td><td style={{ textAlign:'right', padding:6 }}>-${fmt(catWater)}</td></tr>
          <tr><td style={{ padding:6, textIndent:'4ch' }}>Gas / Hot water 煤气费 / 热水费</td><td style={{ textAlign:'right', padding:6 }}>-${fmt(catGas)}</td></tr>
          <tr><td style={{ padding:6, textIndent:'4ch' }}>Internet 网费</td><td style={{ textAlign:'right', padding:6 }}>-${fmt(catInternet)}</td></tr>
          <tr><td style={{ padding:6, textIndent:'4ch' }}>Monthly Consumable 消耗品费</td><td style={{ textAlign:'right', padding:6 }}>-${fmt(catConsumable)}</td></tr>
          <tr><td style={{ padding:6, textIndent:'4ch' }}>Carpark 车位费</td><td style={{ textAlign:'right', padding:6 }}>-${fmt(catCarpark)}</td></tr>
          <tr><td style={{ padding:6, textIndent:'4ch' }}>Owner's Corporation 物业费</td><td style={{ textAlign:'right', padding:6 }}>-${fmt(catOwnerCorp)}</td></tr>
          <tr><td style={{ padding:6, textIndent:'4ch' }}>Council Rate 市政费</td><td style={{ textAlign:'right', padding:6 }}>-${fmt(catCouncil)}</td></tr>
          <tr><td style={{ padding:6, textIndent:'4ch' }}>Other Expense 其他支出</td><td style={{ textAlign:'right', padding:6 }}>-${fmt(catOther)}</td></tr>
          <tr><td style={{ padding:6, textIndent:'4ch' }}>Other Expense Desc 其他支出描述</td><td style={{ textAlign:'right', padding:6 }}>{otherExpenseDesc}</td></tr>
        </tbody>
      </table>

      <div style={{ fontWeight: 700, display:'flex', justifyContent:'space-between', padding:'6px 8px', marginTop: 8 }}>
        <span>Net Income 净收入</span><span>${fmt(netIncome)}</span>
      </div>

      <div style={{ marginTop: 24, fontWeight: 600, background:'#eef3fb', padding:'6px 8px' }}>Rent Records</div>
      <table style={{ width:'100%', borderCollapse:'collapse' }}>
        <thead>
          <tr>
            <th style={{ textAlign:'left', padding:6, borderBottom:'1px solid #ddd' }}>入住</th>
            <th style={{ textAlign:'left', padding:6, borderBottom:'1px solid #ddd' }}>退房</th>
            <th style={{ textAlign:'right', padding:6, borderBottom:'1px solid #ddd' }}>晚数</th>
            <th style={{ textAlign:'right', padding:6, borderBottom:'1px solid #ddd' }}>金额</th>
          </tr>
        </thead>
        <tbody>
          {relatedOrders.map(r => (
            <tr key={r.id}>
              <td style={{ padding:6 }}>{r.checkin ? dayjs(r.checkin).format('DD/MM/YYYY') : ''}</td>
              <td style={{ padding:6 }}>{r.checkout ? dayjs(r.checkout).format('DD/MM/YYYY') : ''}</td>
              <td style={{ padding:6, textAlign:'right' }}>{r.nights ?? Math.max(dayjs(r.checkout!).diff(dayjs(r.checkin!), 'day'), 0)}</td>
              <td style={{ padding:6, textAlign:'right' }}>${fmt(Number(r.price||0))}</td>
            </tr>
          ))}
        </tbody>
      </table>


      <div style={{ marginTop: 16, fontWeight: 600, background:'#eef3fb', padding:'6px 8px' }}>Order Calendar</div>
      {(() => {
        const weeks: Array<{ ws: any; we: any }> = []
        let cur = weekStart.clone()
        while (cur.isBefore(weekEnd.add(1,'day'))) { const ws = cur.clone(); const we = cur.clone().endOf('week'); weeks.push({ ws, we }); cur = cur.add(1,'week') }
        return (
          <div>
            {weeks.map(({ ws, we }, idx) => {
              const { segs, laneMap, laneCount } = buildWeekSegments(ws, we)
              const daysRow = Array.from({ length: 7 }).map((_, i) => ws.startOf('day').add(i, 'day'))
              return (
                <div key={idx} style={{ position:'relative', minHeight: Math.max(44, laneCount * 24 + 24), margin:'6px 0', background:'#fff' }}>
                  <div style={{ display:'grid', gridTemplateColumns:'repeat(7, 1fr)', gap:0, padding:'2px 0', color:'#888', fontSize:11 }}>
                    {daysRow.map((d, i) => (
                      <div key={i} style={{ textAlign:'center' }}>{d.format('DD/MM')}</div>
                    ))}
                  </div>
                  {[0,1,2,3,4,5,6].map(dIdx => (
                    <div key={dIdx} style={{ position:'absolute', left: `${(dIdx * 100) / 7}%`, width: `${100/7}%`, top: 22, bottom:0, borderRight:'1px dashed #eee' }} />
                  ))}
                  {segs.map(seg => {
                    const o = seg.o as any
                    const isStart = seg.startIdx === Math.max(0, dayjs(o.checkin).diff(ws.startOf('day'),'day'))
                    const isEnd = seg.endIdx === Math.max(0, dayjs(o.checkout).subtract(1,'day').diff(ws.startOf('day'),'day'))
                    const accent = sourceColor[o.source || 'other'] || '#999'
                    const leftPct = (seg.startIdx * 100) / 7
                    const rightPct = ((6 - seg.endIdx) * 100) / 7
                    const lane = laneMap[seg.id] || 0
                    const radiusLeft = isStart ? 12 : 3
                    const radiusRight = isEnd ? 12 : 3
                    return (
                      <div key={seg.id} style={{ position:'absolute', left: `${leftPct}%`, right: `${rightPct}%`, top: 26 + lane * 24, height: 20, background:'#f5f5f5', borderRadius: `${radiusLeft}px ${radiusRight}px ${radiusRight}px ${radiusLeft}px`, padding:'0 8px', display:'flex', alignItems:'center', fontSize:11, lineHeight:'20px' }}>
                        {isStart ? <span style={{ position:'absolute', left: -6, top:0, bottom:0, width: '33%', background: accent, borderRadius: `${radiusLeft}px 0 0 ${radiusLeft}px` }} /> : null}
                        {isEnd ? <span style={{ position:'absolute', right: -6, top:0, bottom:0, width: '33%', background: accent, borderRadius: `0 ${radiusRight}px ${radiusRight}px 0` }} /> : null}
                        <span style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', marginLeft: isStart ? '33%' : 0, marginRight: isEnd ? '33%' : 0 }}>{String(o.guest_name || '')} ${fmt(Number(o.price || 0))}</span>
                      </div>
                    )
                  })}
                </div>
              )
            })}
          </div>
        )
      })()}

      <div style={{ marginTop: 24, fontWeight: 600, background:'#eef3fb', padding:'6px 8px' }}>Expense Invoices 支出发票</div>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(2, 1fr)', gap: 12 }}>
        {expensesInMonth.map(e => (
          <div key={e.id} style={{ border:'1px solid #eee', padding:8 }}>
            <div style={{ display:'flex', justifyContent:'space-between' }}>
              <span>{e.category || '其他'}</span>
              <span>-${fmt(Number(e.amount||0))}</span>
            </div>
            <div style={{ fontSize:12 }}>{dayjs(e.occurred_at).format('DD/MM/YYYY')}</div>
            {isImg(e.invoice_url) ? (
              <img src={resolveUrl(e.invoice_url)} style={{ width:'100%', marginTop:6 }} alt="invoice" />
            ) : isPdf(e.invoice_url) ? (
              <object data={resolveUrl(e.invoice_url)} type="application/pdf" style={{ width:'100%', height: 600, marginTop:6 }}>
                <a href={resolveUrl(e.invoice_url)} target="_blank" rel="noreferrer">查看发票</a>
              </object>
            ) : e.invoice_url ? (
              <a href={resolveUrl(e.invoice_url)} target="_blank" rel="noreferrer" style={{ display:'inline-block', marginTop:6 }}>查看发票</a>
            ) : (
              <div style={{ fontSize:12, color:'#888', marginTop:6 }}>未上传发票</div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
})
