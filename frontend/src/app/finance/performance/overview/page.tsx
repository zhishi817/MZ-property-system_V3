"use client"
import { Card, Table, DatePicker, Select, Space } from 'antd'
import dayjs from 'dayjs'
import minMax from 'dayjs/plugin/minMax'
dayjs.extend(minMax)
import { useEffect, useMemo, useState } from 'react'
import { getJSON } from '../../../../lib/api'
import { monthSegments } from '../../../../lib/orders'
import { sortPropertiesByRegionThenCode } from '../../../../lib/properties'

type Order = { id: string; property_id?: string; checkin?: string; checkout?: string; price?: number; cleaning_fee?: number }
type Property = { id: string; code?: string; address?: string }

export default function PerformanceOverviewPage() {
  const [orders, setOrders] = useState<Order[]>([])
  const [properties, setProperties] = useState<Property[]>([])
  const [month, setMonth] = useState<any>(dayjs())
  const [selectedPid, setSelectedPid] = useState<string | undefined>(undefined)
  useEffect(() => {
    getJSON<Order[]>('/orders').then(j=> setOrders(Array.isArray(j)?j:[])).catch(()=>setOrders([]))
    getJSON<Property[]>('/properties').then(j=> setProperties(Array.isArray(j)?j:[])).catch(()=>setProperties([]))
  }, [])

  function overlapNights(ci?: string, co?: string, mStart?: any, mEnd?: any) {
    if (!ci || !co || !mStart || !mEnd) return 0
    const s = dayjs(ci).startOf('day'); const e = dayjs(co).startOf('day')
    const a = dayjs.max(s, mStart); const b = dayjs.min(e, mEnd)
    const diff = b.diff(a, 'day')
    return Math.max(0, diff)
  }

  const months = useMemo(() => {
    const base = month || dayjs()
    const offsets = [-4,-3,-2,-1,0,1,2,3,4]
    const defs = offsets.map(off => {
      const mStart = base.add(off,'month').startOf('month')
      const mEndNext = mStart.add(1,'month').startOf('month')
      const daysInMonth = mEndNext.diff(mStart,'day')
      const segsAll = monthSegments(orders, mStart)
      // 仅显示有订单的月份
      if (!segsAll.length) return null
      const occNights = segsAll.reduce((sum, o) => sum + Number(o.nights || 0), 0)
      const rentIncome = segsAll.reduce((sum, o) => sum + Number(((o as any).visible_net_income ?? (o as any).net_income ?? 0)), 0)
      const cleaningCount = segsAll.filter(o => Number(o.cleaning_fee || 0) > 0).length
      const cleaningFee = segsAll.reduce((s,o)=> s + Number(o.cleaning_fee || 0), 0)
      const vacancyNights = Math.max(0, (properties.length * daysInMonth) - occNights)
      const occRate = properties.length ? Math.round(((occNights / (properties.length * daysInMonth)) * 100) * 100) / 100 : 0
      const adr = occNights ? Math.round(((rentIncome / occNights) + Number.EPSILON) * 100) / 100 : 0
      return { key: mStart.format('YYYY-MM'), label: mStart.format('YYYY-MM'), start: mStart, end: mEndNext, daysInMonth, rentIncome: Math.round(rentIncome * 100) / 100, vacancy: vacancyNights, occRate, adr, cleaningFee: Math.round(cleaningFee * 100) / 100, cleaningCount }
    }).filter(Boolean) as any[]
    return defs
  }, [orders, properties, month])

  const propRows = useMemo(() => {
    function propMonthStats(pid: string, start: any, end: any, dim: number) {
      const segs = monthSegments(orders.filter(o => String(o.property_id) === pid), start)
      const occNights = segs.reduce((sum, o) => sum + Number(o.nights || 0), 0)
      const rentIncome = segs.reduce((sum, o) => sum + Number(((o as any).visible_net_income ?? (o as any).net_income ?? 0)), 0)
      const cleaningFee = segs.reduce((s,o)=> s + Number(o.cleaning_fee || 0), 0)
      const cleaningCount = segs.filter(o => Number(o.cleaning_fee || 0) > 0).length
      const occRate = dim ? Math.round(((occNights / dim) * 100) * 100) / 100 : 0
      const adr = occNights ? Math.round(((rentIncome / occNights) + Number.EPSILON) * 100) / 100 : 0
      const seen = new Set<string>()
      segs.forEach(s => {
        const ci = dayjs(s.checkin).startOf('day')
        const co = dayjs(s.checkout).startOf('day')
        const a = dayjs.max(ci, start)
        const b = dayjs.min(co, end)
        let d = a.startOf('day')
        while (d.isBefore(b)) { seen.add(d.format('YYYY-MM-DD')); d = d.add(1,'day') }
      })
      const vacantDays: string[] = []
      for (let i = 0; i < dim; i++) {
        const ds = start.startOf('day').add(i,'day').format('YYYY-MM-DD')
        if (!seen.has(ds)) vacantDays.push(ds)
      }
      return { rentIncome: Math.round(rentIncome * 100) / 100, vacancy: Math.max(0, dim - occNights), occRate, adr, cleaningFee: Math.round(cleaningFee * 100) / 100, cleaningCount, vacantDays }
    }
    const plist = selectedPid ? (properties || []).filter(p => p.id === selectedPid) : sortPropertiesByRegionThenCode(properties as any)
    const out: any[] = []
    let curRegion: string | undefined
    plist.forEach(p => {
      const region = (p as any).region || '未分区'
      if (!selectedPid && region !== curRegion) {
        curRegion = region
        out.push({ id: `region-${region}`, code: region, isRegion: true })
      }
      const row: any = { id: p.id, code: p.code || p.address || p.id }
      months.forEach((m, idx) => {
        const key = `m${idx}`
        const stats = propMonthStats(String(p.id), m.start, m.end, m.daysInMonth)
        row[`${key}_income`] = stats.rentIncome
        row[`${key}_vacancy`] = stats.vacancy
        row[`${key}_vacant_days`] = stats.vacantDays
        row[`${key}_occ`] = stats.occRate
        row[`${key}_adr`] = stats.adr
        row[`${key}_clean_fee`] = stats.cleaningFee
        row[`${key}_clean_cnt`] = stats.cleaningCount
      })
      out.push(row)
    })
    return out
  }, [properties, months, orders, selectedPid])

  return (
    <Card title="经营分析">
      <Space style={{ marginBottom: 12 }} wrap>
        <DatePicker picker="month" value={month} onChange={setMonth as any} />
        <Select allowClear showSearch placeholder="按房号筛选" optionFilterProp="label" style={{ width: 240 }} value={selectedPid} onChange={setSelectedPid as any}
          options={sortPropertiesByRegionThenCode(properties as any).map(p => ({ value: p.id, label: p.code || p.address || p.id }))} />
      </Space>
      <Card size="small" title="房源月度汇总（动态9个月，含未来月份）">
        <Table rowKey={(r:any)=> r.id} pagination={{ pageSize: 20 }} dataSource={propRows} scroll={{ x: 'max-content' }} rowClassName={(r:any)=> r.isRegion ? 'region-row' : ''}
          columns={([
            { title: '房号/区域', dataIndex: 'code', fixed: 'left' as const, render: (_:any, r:any)=> r.isRegion ? (<span style={{ fontWeight: 700 }}>{r.code}</span>) : (r.code || r.id) },
            ...months.map((m, idx) => ({
              title: m.label + (idx === months.findIndex(mm => mm.label === (month || dayjs()).startOf('month').format('YYYY-MM')) ? '（基准）' : ''),
              children: [
                { title: '租金收入', dataIndex: `m${idx}_income`, render: (v: number, r:any)=> r.isRegion ? '' : `$${(v||0).toLocaleString(undefined,{ minimumFractionDigits:2, maximumFractionDigits:2 })}` },
                { title: 'Vacancy', dataIndex: `m${idx}_vacancy`, render: (v: number, r:any)=> r.isRegion ? '' : v },
                { title: '入住率', dataIndex: `m${idx}_occ`, render: (v: number, r:any)=> r.isRegion ? '' : `${v||0}%` },
                { title: '平均房价', dataIndex: `m${idx}_adr`, render: (v: number, r:any)=> r.isRegion ? '' : `$${(v||0).toLocaleString(undefined,{ minimumFractionDigits:2, maximumFractionDigits:2 })}` },
                { title: '清洁费', dataIndex: `m${idx}_clean_fee`, render: (v: number, r:any)=> r.isRegion ? '' : `$${(v||0).toLocaleString(undefined,{ minimumFractionDigits:2, maximumFractionDigits:2 })}` },
                { title: '清洁次数', dataIndex: `m${idx}_clean_cnt`, className: 'month-sep', render: (v: number, r:any)=> r.isRegion ? '' : v },
              ]
            }))
          ]) as any} />
      <style jsx>{`
        :global(.ant-table-thead .month-sep),
        :global(.ant-table-tbody .month-sep) { position: relative; }
        :global(.ant-table-thead .month-sep::after),
        :global(.ant-table-tbody .month-sep::after) {
          content: '';
          position: absolute;
          right: 0;
          top: 0;
          width: 2px;
          height: 100%;
          background: #e8e8e8;
        }
        :global(.region-row td) {
          border-top: 8px solid #efefef;
          background: transparent;
          font-weight: 700;
        }
      `}</style>
      </Card>
    </Card>
  )
}