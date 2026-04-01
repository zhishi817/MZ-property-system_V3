"use client"
import { Card, Select, DatePicker } from 'antd'
import dayjs from 'dayjs'
import { useEffect, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'
import { getJSON } from '../../../../lib/api'
import { sortProperties } from '../../../../lib/properties'
import MonthlyStatementView from '../../../../components/MonthlyStatement'

type Order = { id: string }
type Tx = { id: string }
type Property = { id: string; code?: string; address?: string }
type Landlord = { id: string; name: string; management_fee_rate?: number; property_ids?: string[] }

export default function SinglePropertyAnalysisPage() {
  const pathname = usePathname()
  const [month, setMonth] = useState<any>(dayjs())
  const [pid, setPid] = useState<string | undefined>(undefined)
  const [orders, setOrders] = useState<Order[]>([])
  const [txs, setTxs] = useState<Tx[]>([])
  const [properties, setProperties] = useState<Property[]>([])
  const [landlords, setLandlords] = useState<Landlord[]>([])
  const reloadTimerRef = useRef<any>(null)
  const reloadOrdersOnlyRef = useRef<null | (() => void)>(null)
  useEffect(() => {
    const mountedRef = { current: true }
    const reloadOrdersOnly = async () => {
      const j = await getJSON<Order[]>('/orders').catch(() => [] as any[])
      if (!mountedRef.current) return
      setOrders(Array.isArray(j) ? j : [])
    }
    const reloadAll = async () => {
      const [o, f, p, l] = await Promise.all([
        getJSON<Order[]>('/orders').catch(() => [] as any[]),
        getJSON<Tx[]>('/finance').catch(() => [] as any[]),
        getJSON<Property[]>('/properties').catch(() => [] as any[]),
        getJSON<Landlord[]>('/landlords').catch(() => [] as any[]),
      ])
      if (!mountedRef.current) return
      setOrders(Array.isArray(o) ? o : [])
      setTxs(Array.isArray(f) ? f : [])
      setProperties(Array.isArray(p) ? p : [])
      setLandlords(Array.isArray(l) ? l : [])
    }
    const scheduleReloadOrders = () => {
      try { if (reloadTimerRef.current) clearTimeout(reloadTimerRef.current) } catch {}
      reloadTimerRef.current = setTimeout(() => { reloadOrdersOnly() }, 350)
    }
    reloadOrdersOnlyRef.current = scheduleReloadOrders
    const onVis = () => { if (document.visibilityState === 'visible') scheduleReloadOrders() }
    const onFocus = () => { scheduleReloadOrders() }
    reloadAll()
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('focus', onFocus)
    return () => {
      mountedRef.current = false
      try { if (reloadTimerRef.current) clearTimeout(reloadTimerRef.current) } catch {}
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('focus', onFocus)
    }
  }, [])
  useEffect(() => {
    if (String(pathname || '') === '/finance/performance/property') {
      try { reloadOrdersOnlyRef.current?.() } catch {}
    }
  }, [pathname])
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
