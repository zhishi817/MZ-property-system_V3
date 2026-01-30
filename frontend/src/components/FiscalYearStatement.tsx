"use client"
import dayjs from 'dayjs'
import { monthSegments } from '../lib/orders'
import { shouldIncludeIncomeTxInPropertyOtherIncome, txInMonth, txMatchesProperty } from '../lib/financeTx'
import { forwardRef } from 'react'

type Order = { id: string; property_id?: string; checkin?: string; checkout?: string; price?: number; status?: string; count_in_income?: boolean }
type Tx = { id: string; kind: 'income'|'expense'; amount: number; currency: string; property_id?: string; occurred_at: string; category?: string; ref_type?: string; ref_id?: string }
type Landlord = { id: string; name: string; management_fee_rate?: number; property_ids?: string[] }

export default forwardRef<HTMLDivElement, {
  baseMonth: any
  propertyId: string
  orders: Order[]
  txs: Tx[]
  properties: { id: string; code?: string; address?: string }[]
  landlords: Landlord[]
}>(function FiscalYearStatement({ baseMonth, propertyId, orders, txs, properties, landlords }, ref) {
  const base = baseMonth || dayjs()
  const fyStartYear = base.month() >= 6 ? base.year() : base.year() - 1
  const start = dayjs(`${fyStartYear}-07-01`)
  const months = [
    'Jul','Aug','Sep','Oct','Nov','Dec','Jan','Feb','Mar','Apr','May','Jun'
  ]
  const monthRanges = months.map((_, idx) => {
    const d = start.add(idx, 'month')
    return { label: d.format('MMM'), start: d.startOf('month'), end: d.endOf('month') }
  })
  const landlord = landlords.find(l => (l.property_ids||[]).includes(propertyId))
  const property = properties.find(pp => pp.id === propertyId)
  const fmt = (n: number) => (n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const orderById = new Map((orders || []).map(o => [String(o.id), o]))

  const monthValues = monthRanges.map(r => {
    const overlapping = monthSegments(orders.filter(o => o.property_id===propertyId), r.start)
    const rentIncome = overlapping.reduce((s, x) => s + Number(((x as any).visible_net_income ?? (x as any).net_income) || 0), 0)
    const otherIncome = txs.filter(t => {
      if (t.kind !== 'income') return false
      if (!txMatchesProperty(t, { id: propertyId, code: property?.code })) return false
      if (!txInMonth(t as any, r.start)) return false
      return shouldIncludeIncomeTxInPropertyOtherIncome(t, orderById)
    }).reduce((s, x) => s + Number(x.amount || 0), 0)
    const mgmt = landlord?.management_fee_rate ? Math.round(((rentIncome * landlord.management_fee_rate) + Number.EPSILON) * 100) / 100 : 0
    const sumCat = (c: string) => txs.filter(t => t.kind === 'expense' && t.category === c && txMatchesProperty(t, { id: propertyId, code: property?.code }) && txInMonth(t as any, r.start)).reduce((s, x) => s + Number(x.amount || 0), 0)
    const consumable = sumCat('consumable')
    const electricity = sumCat('electricity')
    const gas = sumCat('gas')
    const water = sumCat('water')
    const internet = sumCat('internet')
    const carpark = sumCat('carpark')
    const council = sumCat('council')
    const bodycorp = sumCat('property_fee')
    const otherExp = sumCat('other')
    const totalExp = mgmt + consumable + electricity + gas + water + internet + carpark + council + bodycorp + otherExp
    const netIncome = rentIncome + otherIncome - totalExp
    return { rentIncome, otherIncome, mgmt, consumable, electricity, gas, water, internet, carpark, council, bodycorp, otherExp, netIncome }
  })

  const yearTotals = monthValues.reduce((acc, v) => ({
    rentIncome: acc.rentIncome + v.rentIncome,
    otherIncome: acc.otherIncome + v.otherIncome,
    mgmt: acc.mgmt + v.mgmt,
    consumable: acc.consumable + v.consumable,
    electricity: acc.electricity + v.electricity,
    gas: acc.gas + v.gas,
    water: acc.water + v.water,
    internet: acc.internet + v.internet,
    carpark: acc.carpark + v.carpark,
    council: acc.council + v.council,
    bodycorp: acc.bodycorp + v.bodycorp,
    otherExp: acc.otherExp + v.otherExp,
    netIncome: acc.netIncome + v.netIncome,
  }), { rentIncome:0, otherIncome:0, mgmt:0, consumable:0, electricity:0, gas:0, water:0, internet:0, carpark:0, council:0, bodycorp:0, otherExp:0, netIncome:0 })

  return (
    <div ref={ref as any} style={{ padding: 16, fontFamily: 'Times New Roman, Times, serif' }}>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 2fr 1.4fr', alignItems:'center', columnGap: 16 }}>
        <div style={{ display:'flex', alignItems:'center' }}>
          <img src="/mz-logo.png" alt="Company Logo" style={{ height: 70 }} />
        </div>
        <div style={{ textAlign:'center' }}>
          <div style={{ fontSize: 28, fontWeight: 700, letterSpacing: 1 }}>MONTHLY INCOME AND EXPENDITURE SUMMARY</div>
          <div style={{ fontSize: 14, marginTop: 6 }}>FINANCIAL YEAR {start.format('MMMM YYYY')} TO {start.add(11,'month').endOf('month').format('MMMM YYYY')}</div>
        </div>
        <div>
          <div style={{ background:'#e6ecf6', padding:'6px 8px', fontWeight:700, textAlign:'right', border:'1px solid #dfe6f1' }}>Customer Details</div>
          <div style={{ border:'1px solid #dfe6f1', borderTop:0, padding:8, textAlign:'right' }}>
            <div>{landlord?.name || ''}</div>
            <div style={{ fontSize:12 }}>{property?.address || ''}</div>
          </div>
        </div>
      </div>

      <table style={{ width:'100%', borderCollapse:'collapse', marginTop: 12, fontSize: 12 }}>
        <thead>
          <tr>
            <th style={{ textAlign:'left', padding:6 }}></th>
            {monthRanges.map(m => (<th key={m.label} style={{ padding:6, background:'#e6ecf6' }}>{m.label}</th>))}
            <th style={{ padding:6, background:'#e6ecf6' }}>Year Total</th>
          </tr>
        </thead>
        <tbody>
          <tr><td style={{ padding:6, fontWeight:700 }}>Income</td><td colSpan={13}></td></tr>
          <tr>
            <td style={{ padding:6 }}>Rent Income</td>
            {monthValues.map((v,i)=>(<td key={i} style={{ padding:6, textAlign:'right' }}>${fmt(v.rentIncome)}</td>))}
            <td style={{ padding:6, textAlign:'right' }}>${fmt(yearTotals.rentIncome)}</td>
          </tr>
          <tr>
            <td style={{ padding:6 }}>Other Income</td>
            {monthValues.map((v,i)=>(<td key={i} style={{ padding:6, textAlign:'right' }}>${fmt(v.otherIncome)}</td>))}
            <td style={{ padding:6, textAlign:'right' }}>${fmt(yearTotals.otherIncome)}</td>
          </tr>

          <tr><td style={{ padding:6, fontWeight:700 }}>Expenses</td><td colSpan={13}></td></tr>
          <tr>
            <td style={{ padding:6 }}>Agency Fees</td>
            {monthValues.map((v,i)=>(<td key={i} style={{ padding:6, textAlign:'right' }}>-${fmt(v.mgmt)}</td>))}
            <td style={{ padding:6, textAlign:'right' }}>-${fmt(yearTotals.mgmt)}</td>
          </tr>
          <tr>
            <td style={{ padding:6 }}>Consumables Cost</td>
            {monthValues.map((v,i)=>(<td key={i} style={{ padding:6, textAlign:'right' }}>-${fmt(v.consumable)}</td>))}
            <td style={{ padding:6, textAlign:'right' }}>-${fmt(yearTotals.consumable)}</td>
          </tr>
          <tr>
            <td style={{ padding:6 }}>Electricity</td>
            {monthValues.map((v,i)=>(<td key={i} style={{ padding:6, textAlign:'right' }}>-${fmt(v.electricity)}</td>))}
            <td style={{ padding:6, textAlign:'right' }}>-${fmt(yearTotals.electricity)}</td>
          </tr>
          <tr>
            <td style={{ padding:6 }}>Gas and Hot water</td>
            {monthValues.map((v,i)=>(<td key={i} style={{ padding:6, textAlign:'right' }}>-${fmt(v.gas)}</td>))}
            <td style={{ padding:6, textAlign:'right' }}>-${fmt(yearTotals.gas)}</td>
          </tr>
          <tr>
            <td style={{ padding:6 }}>Water</td>
            {monthValues.map((v,i)=>(<td key={i} style={{ padding:6, textAlign:'right' }}>-${fmt(v.water)}</td>))}
            <td style={{ padding:6, textAlign:'right' }}>-${fmt(yearTotals.water)}</td>
          </tr>
          <tr>
            <td style={{ padding:6 }}>Internet</td>
            {monthValues.map((v,i)=>(<td key={i} style={{ padding:6, textAlign:'right' }}>-${fmt(v.internet)}</td>))}
            <td style={{ padding:6, textAlign:'right' }}>-${fmt(yearTotals.internet)}</td>
          </tr>
          <tr>
            <td style={{ padding:6 }}>Carpark Rent</td>
            {monthValues.map((v,i)=>(<td key={i} style={{ padding:6, textAlign:'right' }}>-${fmt(v.carpark)}</td>))}
            <td style={{ padding:6, textAlign:'right' }}>-${fmt(yearTotals.carpark)}</td>
          </tr>
          <tr>
            <td style={{ padding:6 }}>Council Rate</td>
            {monthValues.map((v,i)=>(<td key={i} style={{ padding:6, textAlign:'right' }}>-${fmt(v.council)}</td>))}
            <td style={{ padding:6, textAlign:'right' }}>-${fmt(yearTotals.council)}</td>
          </tr>
          <tr>
            <td style={{ padding:6 }}>Body Corporation</td>
            {monthValues.map((v,i)=>(<td key={i} style={{ padding:6, textAlign:'right' }}>-${fmt(v.bodycorp)}</td>))}
            <td style={{ padding:6, textAlign:'right' }}>-${fmt(yearTotals.bodycorp)}</td>
          </tr>
          <tr>
            <td style={{ padding:6 }}>Other Expenses</td>
            {monthValues.map((v,i)=>(<td key={i} style={{ padding:6, textAlign:'right' }}>-${fmt(v.otherExp)}</td>))}
            <td style={{ padding:6, textAlign:'right' }}>-${fmt(yearTotals.otherExp)}</td>
          </tr>

          <tr><td style={{ padding:6, fontWeight:700 }}>Net Income</td><td colSpan={13}></td></tr>
          <tr>
            <td style={{ padding:6 }}>Owner Received</td>
            {monthValues.map((v,i)=>(<td key={i} style={{ padding:6, textAlign:'right' }}>${fmt(v.netIncome)}</td>))}
            <td style={{ padding:6, textAlign:'right', fontWeight:700 }}>${fmt(yearTotals.netIncome)}</td>
          </tr>
        </tbody>
      </table>

      <div style={{ textAlign:'center', marginTop: 18, fontSize: 12 }}>
        <div style={{ fontWeight:700 }}>MZ Property Pty Ltd</div>
        <div>ABN: 42 657 925 365</div>
        <div>Address: G3/87 Gladstone St, South Melbourne, VIC3205</div>
        <div>Email: info@mzproperty.com.au</div>
      </div>
    </div>
  )
})
