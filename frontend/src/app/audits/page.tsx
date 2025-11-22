"use client"
import { Card, Table } from 'antd'
import { useEffect, useState } from 'react'
import { API_BASE } from '../../lib/api'

type Audit = { id: string; actor_id?: string; action: string; entity: string; entity_id: string; timestamp: string }

export default function AuditsPage() {
  const [data, setData] = useState<Audit[]>([])
  useEffect(() => { fetch(`${API_BASE}/audits`).then(r => r.json()).then(setData) }, [])
  const columns = [
    { title: '时间', dataIndex: 'timestamp' },
    { title: '实体', dataIndex: 'entity' },
    { title: '动作', dataIndex: 'action' },
    { title: '实体ID', dataIndex: 'entity_id' },
    { title: '操作者', dataIndex: 'actor_id' },
  ]
  return (
    <Card title="审计记录">
      <Table rowKey={(r) => r.id} columns={columns as any} dataSource={data} pagination={{ pageSize: 20 }} />
    </Card>
  )
}