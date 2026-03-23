"use client"
import { Card, Table } from 'antd'
import { useEffect, useState } from 'react'
import dayjs from 'dayjs'
import { getJSON } from '../../lib/api'

type Audit = { id: string; actor_id?: string; action: string; entity: string; entity_id: string; created_at?: string; actor?: any }

export default function AuditsPage() {
  const [data, setData] = useState<Audit[]>([])
  useEffect(() => {
    getJSON<any>('/audits?limit=200')
      .then((j) => {
        const rows = Array.isArray(j) ? j : (Array.isArray(j?.items) ? j.items : [])
        setData(Array.isArray(rows) ? rows : [])
      })
      .catch(() => setData([]))
  }, [])
  const columns = [
    { title: '时间', dataIndex: 'created_at', render: (v: any) => v ? dayjs(v).format('YYYY-MM-DD HH:mm:ss') : '' },
    { title: '实体', dataIndex: 'entity' },
    { title: '动作', dataIndex: 'action' },
    { title: '实体ID', dataIndex: 'entity_id' },
    { title: '操作者', render: (_: any, r: any) => String(r?.actor?.display_name || r?.actor?.username || r?.actor?.email || r?.actor_id || '') },
  ]
  return (
    <Card title="审计记录">
      <Table rowKey={(r) => r.id} columns={columns as any} dataSource={data} pagination={{ pageSize: 20 }} />
    </Card>
  )
}
