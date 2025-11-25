"use client"
import dayjs from 'dayjs'
import { Table } from 'antd'
import { forwardRef } from 'react'

type Order = { id: string; property_id?: string; checkin?: string; checkout?: string; price?: number; nights?: number }
type Tx = { id: string; kind: 'income'|'expense'; amount: number; currency: string; property_id?: string; occurred_at: string; category?: string; invoice_url?: string; note?: string }
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
  const totalIncome = orderIncomeShare
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

  return (
    <div ref={ref as any} style={{ padding: 24, fontFamily: 'Times New Roman, Times, serif' }}>
      <div className="print-header" style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
        <img src="/company-logo.png" alt="Company Logo" style={{ height: 64 }} />
        <div style={{ flex: 1, marginLeft: 12 }}></div>
        <div style={{ textAlign:'right', minWidth: 420 }}>
          <div style={{ fontSize: 34, fontWeight: 700, letterSpacing: 1 }}>MONTHLY STATEMENT</div>
          <div style={{ borderTop: '2px solid #000', marginTop: 6 }}></div>
          <div style={{ display:'flex', flexDirection:'column', alignItems:'flex-end', marginTop: 6 }}>
            <div style={{ fontSize: 22, fontWeight: 700 }}>{dayjs(`${month}-01`).format('MMM YYYY')}</div>
            <div style={{ fontSize: 16, marginTop: 4 }}>{landlord?.name || ''}</div>
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
              <td style={{ padding:6 }}>{r.checkin}</td>
              <td style={{ padding:6 }}>{r.checkout}</td>
              <td style={{ padding:6, textAlign:'right' }}>{r.nights ?? Math.max(dayjs(r.checkout!).diff(dayjs(r.checkin!), 'day'), 0)}</td>
              <td style={{ padding:6, textAlign:'right' }}>${fmt(Number(r.price||0))}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ marginTop: 24, fontWeight: 600, background:'#eef3fb', padding:'6px 8px' }}>Expense Invoices 支出发票</div>
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
  )
})
