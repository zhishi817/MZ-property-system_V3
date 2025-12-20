"use client"
import { Card, Table } from 'antd'
import dayjs from 'dayjs'
import minMax from 'dayjs/plugin/minMax'
dayjs.extend(minMax)
import { useEffect, useMemo, useState } from 'react'
import { getJSON } from '../../../../lib/api'
import { sortPropertiesByRegionThenCode } from '../../../../lib/properties'

type Order = { id: string; property_id?: string; checkin?: string; checkout?: string; price?: number; cleaning_fee?: number }
type Property = { id: string; code?: string; address?: string }

export default function PerformanceOverviewPage() {
  const [orders, setOrders] = useState<Order[]>([])
  const [properties, setProperties] = useState<Property[]>([])
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
    const base = dayjs()
    const defs = [0,1,2,3].map(i => {
      const mStart = base.subtract(i,'month').startOf('month')
      const mEnd = base.subtract(i,'month').endOf('month')
      const daysInMonth = mEnd.diff(mStart,'day') + 1
      const occNights = orders.reduce((sum, o) => sum + overlapNights(o.checkin, o.checkout, mStart, mEnd), 0)
      const rentIncome = orders.reduce((sum, o) => {
        if (!o.checkin || !o.checkout) return sum
        const ci = dayjs(o.checkin).startOf('day'); const co = dayjs(o.checkout).startOf('day')
        const totalN = Math.max(co.diff(ci,'day'), 0)
        if (!totalN) return sum
        const a = dayjs.max(ci, mStart); const b = dayjs.min(co, mEnd)
        const segN = Math.max(b.diff(a,'day'), 0)
        const perDay = Number(o.price || 0) / totalN
        return sum + perDay * segN
      }, 0)
      const cleaningCount = orders.filter(o => o.checkout && dayjs(o.checkout).isSame(mStart, 'month')).length
      const cleaningFee = orders.filter(o => o.checkout && dayjs(o.checkout).isSame(mStart, 'month')).reduce((s,o)=> s + Number(o.cleaning_fee || 0), 0)
      const vacancyNights = Math.max(0, (properties.length * daysInMonth) - occNights)
      const occRate = properties.length ? Math.round(((occNights / (properties.length * daysInMonth)) * 100) * 100) / 100 : 0
      const adr = occNights ? Math.round(((rentIncome / occNights) + Number.EPSILON) * 100) / 100 : 0
      return { key: mStart.format('YYYY-MM'), label: mStart.format('YYYY-MM'), start: mStart, end: mEnd, daysInMonth, rentIncome: Math.round(rentIncome * 100) / 100, vacancy: vacancyNights, occRate, adr, cleaningFee: Math.round(cleaningFee * 100) / 100, cleaningCount }
    })
    return defs
  }, [orders, properties])

  const propRows = useMemo(() => {
    function propMonthStats(pid: string, start: any, end: any, dim: number) {
      const occNights = orders.filter(o => String(o.property_id) === pid).reduce((sum, o) => sum + overlapNights(o.checkin, o.checkout, start, end), 0)
      const rentIncome = orders.filter(o => String(o.property_id) === pid).reduce((sum, o) => {
        if (!o.checkin || !o.checkout) return sum
        const ci = dayjs(o.checkin).startOf('day'); const co = dayjs(o.checkout).startOf('day')
        const totalN = Math.max(co.diff(ci,'day'), 0)
        if (!totalN) return sum
        const a = dayjs.max(ci, start); const b = dayjs.min(co, end)
        const segN = Math.max(b.diff(a,'day'), 0)
        const perDay = Number(o.price || 0) / totalN
        return sum + perDay * segN
      }, 0)
      const cleaningFee = orders.filter(o => String(o.property_id) === pid && o.checkout && dayjs(o.checkout).isSame(start, 'month')).reduce((s,o)=> s + Number(o.cleaning_fee || 0), 0)
      const cleaningCount = orders.filter(o => String(o.property_id) === pid && o.checkout && dayjs(o.checkout).isSame(start, 'month')).length
      const occRate = dim ? Math.round(((occNights / dim) * 100) * 100) / 100 : 0
      const adr = occNights ? Math.round(((rentIncome / occNights) + Number.EPSILON) * 100) / 100 : 0
      return { rentIncome: Math.round(rentIncome * 100) / 100, vacancy: Math.max(0, dim - occNights), occRate, adr, cleaningFee: Math.round(cleaningFee * 100) / 100, cleaningCount }
    }
    return sortPropertiesByRegionThenCode(properties as any).map(p => {
      const row: any = { id: p.id, code: p.code || p.address || p.id }
      months.forEach((m, idx) => {
        const key = idx === 0 ? 'm0' : `m${idx}`
        const stats = propMonthStats(String(p.id), m.start, m.end, m.daysInMonth)
        row[`${key}_income`] = stats.rentIncome
        row[`${key}_vacancy`] = stats.vacancy
        row[`${key}_occ`] = stats.occRate
        row[`${key}_adr`] = stats.adr
        row[`${key}_clean_fee`] = stats.cleaningFee
        row[`${key}_clean_cnt`] = stats.cleaningCount
      })
      return row
    })
  }, [properties, months, orders])

  return (
    <Card title="经营分析">
      <Card size="small" title="房源月度汇总（当月 + 前三个月）">
        <Table rowKey={(r:any)=> r.id} pagination={{ pageSize: 20 }} dataSource={propRows} scroll={{ x: 'max-content' }}
          columns={[
            { title: '房号', dataIndex: 'code', fixed: 'left', render: (_:any, r:any)=> r.code || r.id },
            {
              title: months[0]?.label ? `${months[0].label}（当月）` : '当月',
              children: [
                { title: '租金收入', dataIndex: 'm0_income', render: (v: number)=> `$${(v||0).toLocaleString(undefined,{ minimumFractionDigits:2, maximumFractionDigits:2 })}` },
                { title: 'Vacancy', dataIndex: 'm0_vacancy' },
                { title: '入住率', dataIndex: 'm0_occ', render: (v: number)=> `${v||0}%` },
                { title: '平均房价', dataIndex: 'm0_adr', render: (v: number)=> `$${(v||0).toLocaleString(undefined,{ minimumFractionDigits:2, maximumFractionDigits:2 })}` },
                { title: '清洁费', dataIndex: 'm0_clean_fee', render: (v: number)=> `$${(v||0).toLocaleString(undefined,{ minimumFractionDigits:2, maximumFractionDigits:2 })}` },
                { title: '清洁次数', dataIndex: 'm0_clean_cnt' },
              ]
            },
            {
              title: months[1]?.label || '上月',
              children: [
                { title: '租金收入', dataIndex: 'm1_income', render: (v: number)=> `$${(v||0).toLocaleString(undefined,{ minimumFractionDigits:2, maximumFractionDigits:2 })}` },
                { title: 'Vacancy', dataIndex: 'm1_vacancy' },
                { title: '入住率', dataIndex: 'm1_occ', render: (v: number)=> `${v||0}%` },
                { title: '平均房价', dataIndex: 'm1_adr', render: (v: number)=> `$${(v||0).toLocaleString(undefined,{ minimumFractionDigits:2, maximumFractionDigits:2 })}` },
                { title: '清洁费', dataIndex: 'm1_clean_fee', render: (v: number)=> `$${(v||0).toLocaleString(undefined,{ minimumFractionDigits:2, maximumFractionDigits:2 })}` },
                { title: '清洁次数', dataIndex: 'm1_clean_cnt' },
              ]
            },
            {
              title: months[2]?.label || '前2月',
              children: [
                { title: '租金收入', dataIndex: 'm2_income', render: (v: number)=> `$${(v||0).toLocaleString(undefined,{ minimumFractionDigits:2, maximumFractionDigits:2 })}` },
                { title: 'Vacancy', dataIndex: 'm2_vacancy' },
                { title: '入住率', dataIndex: 'm2_occ', render: (v: number)=> `${v||0}%` },
                { title: '平均房价', dataIndex: 'm2_adr', render: (v: number)=> `$${(v||0).toLocaleString(undefined,{ minimumFractionDigits:2, maximumFractionDigits:2 })}` },
                { title: '清洁费', dataIndex: 'm2_clean_fee', render: (v: number)=> `$${(v||0).toLocaleString(undefined,{ minimumFractionDigits:2, maximumFractionDigits:2 })}` },
                { title: '清洁次数', dataIndex: 'm2_clean_cnt' },
              ]
            },
            {
              title: months[3]?.label || '前3月',
              children: [
                { title: '租金收入', dataIndex: 'm3_income', render: (v: number)=> `$${(v||0).toLocaleString(undefined,{ minimumFractionDigits:2, maximumFractionDigits:2 })}` },
                { title: 'Vacancy', dataIndex: 'm3_vacancy' },
                { title: '入住率', dataIndex: 'm3_occ', render: (v: number)=> `${v||0}%` },
                { title: '平均房价', dataIndex: 'm3_adr', render: (v: number)=> `$${(v||0).toLocaleString(undefined,{ minimumFractionDigits:2, maximumFractionDigits:2 })}` },
                { title: '清洁费', dataIndex: 'm3_clean_fee', render: (v: number)=> `$${(v||0).toLocaleString(undefined,{ minimumFractionDigits:2, maximumFractionDigits:2 })}` },
                { title: '清洁次数', dataIndex: 'm3_clean_cnt' },
              ]
            },
          ] as any} />
      </Card>
    </Card>
  )
}