"use client"
import { Card, Select, DatePicker } from 'antd'
import dayjs from 'dayjs'
import { useEffect, useState } from 'react'
import { getJSON } from '../../../../lib/api'
import { sortProperties } from '../../../../lib/properties'
import MonthlyStatementView from '../../../../components/MonthlyStatement'

type Order = { id: string }
type Tx = { id: string }
type Property = { id: string; code?: string; address?: string }
type Landlord = { id: string; name: string; management_fee_rate?: number; property_ids?: string[] }

export default function SinglePropertyAnalysisPage() {
  const [month, setMonth] = useState<any>(dayjs())
  const [pid, setPid] = useState<string | undefined>(undefined)
  const [orders, setOrders] = useState<Order[]>([])
  const [txs, setTxs] = useState<Tx[]>([])
  const [properties, setProperties] = useState<Property[]>([])
  const [landlords, setLandlords] = useState<Landlord[]>([])
  useEffect(() => {
    getJSON<Order[]>('/orders').then((j)=> setOrders(Array.isArray(j)?j:[])).catch(()=>setOrders([]))
    getJSON<Tx[]>('/finance').then((j)=> setTxs(Array.isArray(j)?j:[])).catch(()=>setTxs([]))
    getJSON<Property[]>('/properties').then((j)=> setProperties(Array.isArray(j)?j:[])).catch(()=>setProperties([]))
    getJSON<Landlord[]>('/landlords').then((j)=> setLandlords(Array.isArray(j)?j:[])).catch(()=>setLandlords([]))
  }, [])
  return (
    <Card title="单房源分析">
      <div style={{ display:'flex', gap:12, alignItems:'center', marginBottom: 12 }}>
        <DatePicker picker="month" value={month} onChange={setMonth as any} />
        <Select showSearch optionFilterProp="label" filterOption={(input, option)=> String((option as any)?.label||'').toLowerCase().includes(String(input||'').toLowerCase())} placeholder="选择房号" style={{ width: 280 }}
          options={sortProperties(properties).map(p=>({ value: p.id, label: p.code || p.address || p.id }))}
          value={pid} onChange={setPid} />
      </div>
      {pid ? (
        <MonthlyStatementView month={month.format('YYYY-MM')} propertyId={pid} orders={orders as any} txs={txs as any} properties={properties as any} landlords={landlords as any} />
      ) : (<div style={{ color:'#999' }}>请选择房号</div>)}
    </Card>
  )
}