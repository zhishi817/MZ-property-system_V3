"use client"
import { Card, Space, Select, DatePicker, Input, Button, Typography, Tag, Grid } from 'antd'
import dayjs from 'dayjs'
import { useEffect, useMemo, useState } from 'react'
import { getJSON } from '../../../lib/api'
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip as RTooltip, CartesianGrid, LineChart, Line } from 'recharts'

export default function MaintenanceOverviewPage() {
  const [props, setProps] = useState<{ id: string; code?: string }[]>([])
  const [filterPropertyId, setFilterPropertyId] = useState<string | undefined>(undefined)
  const [filterStatus, setFilterStatus] = useState<string | undefined>(undefined)
  const [filterCat, setFilterCat] = useState<string | undefined>(undefined)
  const [filterKeyword, setFilterKeyword] = useState('')
  const [dateRange, setDateRange] = useState<[any, any] | null>([dayjs().add(-29, 'day'), dayjs()])
  const [stats, setStats] = useState<any | null>(null)
  const [loading, setLoading] = useState(false)

  const screens = Grid.useBreakpoint()
  const isMobile = !screens.md

  const propOptions = useMemo(() => (props || []).map(p => ({ value: p.id, label: p.code || p.id })), [props])
  const catOptions = ['入户走廊','客厅','厨房','卧室','阳台','浴室','其他'].map(x => ({ value: x, label: x }))
  const statusOptions = [
    { value: 'pending', label: '待维修' },
    { value: 'assigned', label: '已分配' },
    { value: 'in_progress', label: '维修中' },
    { value: 'completed', label: '已完成' },
    { value: 'canceled', label: '已取消' },
  ]
  function statusLabel(s?: string) {
    const v = String(s || '')
    if (v === 'pending') return '待维修'
    if (v === 'assigned') return '已分配'
    if (v === 'in_progress') return '维修中'
    if (v === 'completed') return '已完成'
    if (v === 'canceled') return '已取消'
    return v || '-'
  }
  function statusTag(s?: string) {
    const v = String(s || '')
    const label = statusLabel(v)
    if (v === 'pending') return <Tag color="default">{label}</Tag>
    if (v === 'assigned') return <Tag color="blue">{label}</Tag>
    if (v === 'in_progress') return <Tag color="orange">{label}</Tag>
    if (v === 'completed') return <Tag color="green">{label}</Tag>
    if (v === 'canceled') return <Tag color="red">{label}</Tag>
    return <Tag>{label}</Tag>
  }

  async function loadProps() {
    try {
      const ps = await getJSON<any[]>('/properties').catch(()=>[])
      setProps(Array.isArray(ps) ? ps : [])
    } catch { setProps([]) }
  }
  async function loadStats() {
    setLoading(true)
    try {
      const params: Record<string, any> = { aggregate: '1' }
      if (filterPropertyId) params.property_id = filterPropertyId
      if (filterStatus) params.status = filterStatus
      if (filterCat) params.category = filterCat
      if (dateRange?.[0]) params.submitted_at_from = dayjs(dateRange[0]).startOf('day').toISOString()
      if (dateRange?.[1]) params.submitted_at_to = dayjs(dateRange[1]).endOf('day').toISOString()
      if (filterKeyword.trim()) params.q = filterKeyword.trim()
      const qs = new URLSearchParams(params as any).toString()
      const data = await getJSON<any>(`/crud/property_maintenance?${qs}`)
      setStats(data || null)
    } catch {
      setStats(null)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadProps() }, [])
  useEffect(() => { loadStats() }, [])

  const total = Number(stats?.total || 0)
  const thisMonthKey = dayjs().format('YYYY-MM')
  const thisMonthCount = useMemo(() => {
    const arr = Array.isArray(stats?.by_month) ? stats.by_month : []
    const hit = arr.find((x: any) => String(x?.key || '') === thisMonthKey)
    return Number(hit?.value || 0)
  }, [stats, thisMonthKey])
  const pendingCount = useMemo(() => {
    const arr = Array.isArray(stats?.by_status) ? stats.by_status : []
    const hit = arr.find((x: any) => String(x?.key || '') === 'pending')
    return Number(hit?.value || 0)
  }, [stats])
  const completedCount = useMemo(() => {
    const arr = Array.isArray(stats?.by_status) ? stats.by_status : []
    const hit = arr.find((x: any) => String(x?.key || '') === 'completed')
    return Number(hit?.value || 0)
  }, [stats])

  return (
    <Space direction="vertical" style={{ width:'100%' }}>
      <Card title="维修总览">
        <Space style={{ width:'100%', marginBottom: 12 }} wrap>
          <Select placeholder="房号" allowClear options={propOptions} value={filterPropertyId} onChange={v=>setFilterPropertyId(v)} style={{ width: isMobile ? '100%' : 200 }} />
          <Select placeholder="状态" allowClear options={statusOptions} value={filterStatus} onChange={v=>setFilterStatus(v)} style={{ width: isMobile ? '100%' : 180 }} />
          <Select placeholder="区域" allowClear options={catOptions} value={filterCat} onChange={v=>setFilterCat(v)} style={{ width: isMobile ? '100%' : 180 }} />
          <DatePicker.RangePicker
            value={dateRange as any}
            onChange={v=>setDateRange(v as any)}
            style={{ width: isMobile ? '100%' : undefined }}
            allowClear
            presets={[
              { label: '近7天', value: [dayjs().add(-6, 'day'), dayjs()] as any },
              { label: '近30天', value: [dayjs().add(-29, 'day'), dayjs()] as any },
              { label: '本月', value: [dayjs().startOf('month'), dayjs().endOf('month')] as any },
            ] as any}
          />
          <Input placeholder="关键词（工单/区域/摘要/人员）" value={filterKeyword} onChange={e=>setFilterKeyword(e.target.value)} style={{ width: isMobile ? '100%' : 260 }} />
          <Button type="primary" onClick={loadStats} loading={loading}>刷新统计</Button>
          <Button onClick={()=>{
            setFilterPropertyId(undefined)
            setFilterStatus(undefined)
            setFilterCat(undefined)
            setFilterKeyword('')
            setDateRange([dayjs().add(-29, 'day'), dayjs()])
            setTimeout(() => { loadStats() }, 0)
          }}>重置</Button>
        </Space>
        <div style={{ display:'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(4, 1fr)', gap:12, marginBottom: 12 }}>
          <Card size="small" title="总记录数" styles={{ body:{ display:'flex', alignItems:'center', justifyContent:'center', fontSize: 22, fontWeight: 700 } }}>{total}</Card>
          <Card size="small" title="本月维修" styles={{ body:{ display:'flex', alignItems:'center', justifyContent:'center', fontSize: 22, fontWeight: 700 } }}>{thisMonthCount}</Card>
          <Card size="small" title="待维修" styles={{ body:{ display:'flex', alignItems:'center', justifyContent:'center', fontSize: 22, fontWeight: 700 } }}>{pendingCount}</Card>
          <Card size="small" title="已完成" styles={{ body:{ display:'flex', alignItems:'center', justifyContent:'center', fontSize: 22, fontWeight: 700 } }}>{completedCount}</Card>
        </div>
        <Card size="small" title="状态分布" style={{ marginBottom: 12 }}>
          <div style={{ display:'flex', flexWrap:'wrap', gap: 10 }}>
            {(Array.isArray(stats?.by_status) ? stats.by_status : []).map((x: any, i: number) => (
              <span key={i} style={{ display:'inline-flex', alignItems:'center', gap: 6 }}>
                {statusTag(x?.key)}
                <Typography.Text type="secondary">{Number(x?.value || 0)}</Typography.Text>
              </span>
            ))}
          </div>
        </Card>
        <div style={{ display:'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 12 }}>
          <Card size="small" title="区域分布（Top 8）">
            <div style={{ height: 260 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={(Array.isArray(stats?.by_category) ? stats.by_category : []).slice(0, 8)}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="key" />
                  <YAxis allowDecimals={false} />
                  <RTooltip />
                  <Bar dataKey="value" fill="#1677ff" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Card>
          <Card size="small" title="趋势（按月）">
            <div style={{ height: 260 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={(Array.isArray(stats?.by_month) ? stats.by_month : [])}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="key" />
                  <YAxis allowDecimals={false} />
                  <RTooltip />
                  <Line type="monotone" dataKey="value" stroke="#16c784" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </Card>
        </div>
      </Card>
    </Space>
  )
}
