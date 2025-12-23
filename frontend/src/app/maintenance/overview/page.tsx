"use client"
import { Card, Space } from 'antd'
import dayjs from 'dayjs'
import { useEffect, useMemo, useState } from 'react'
import { getJSON } from '../../../lib/api'

type Row = { id: string; occurred_at: string; notes?: string; details?: any }

export default function MaintenanceOverviewPage() {
  const [rows, setRows] = useState<Row[]>([])
  useEffect(() => { getJSON<Row[]>('/crud/property_maintenance').then(j=> setRows(Array.isArray(j)?j:[])).catch(()=>setRows([])) }, [])
  const monthStart = useMemo(() => dayjs().startOf('month'), [])
  const monthEnd = useMemo(() => dayjs().endOf('month'), [])
  const monthlyCount = useMemo(() => rows.filter(r => r.occurred_at && dayjs(r.occurred_at).isSame(monthStart, 'month')).length, [rows, monthStart])
  const pendingCount = useMemo(() => rows.filter(r => {
    const note = String(r.notes || '').toLowerCase()
    const isPendingNote = note.includes('待维修') || note.includes('pending')
    const detailsArr = Array.isArray(r.details) ? r.details : (typeof r.details === 'string' ? (()=>{ try { return JSON.parse(r.details) } catch { return [] } })() : [])
    const isEmptyWork = !detailsArr || detailsArr.length === 0
    return isPendingNote || isEmptyWork
  }).length, [rows])

  return (
    <Space direction="vertical" style={{ width:'100%' }}>
      <Card title="维修总览">
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(220px, 1fr))', gap:12 }}>
          <Card size="small" title="当月维修数量" styles={{ body:{ display:'flex', alignItems:'center', justifyContent:'center' } }}>{monthlyCount}</Card>
          <Card size="small" title="待维修数量" styles={{ body:{ display:'flex', alignItems:'center', justifyContent:'center' } }}>{pendingCount}</Card>
        </div>
      </Card>
    </Space>
  )
}