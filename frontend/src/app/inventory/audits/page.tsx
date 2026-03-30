"use client"
import { Card, Table, Space, Select, message } from 'antd'
import { useEffect, useMemo, useState } from 'react'
import dayjs from 'dayjs'
import { getJSON } from '../../../lib/api'

type Audit = { id: string; actor_id?: string; action: string; entity: string; entity_id: string; created_at?: string; actor?: any }

export default function InventoryAuditsPage() {
  const [data, setData] = useState<Audit[]>([])
  const [entity, setEntity] = useState<string>('')

  const entityOptions = useMemo(() => ([
    { value: '', label: '全部实体' },
    { value: 'Warehouse', label: 'Warehouse' },
    { value: 'InventoryItem', label: 'InventoryItem' },
    { value: 'WarehouseStock', label: 'WarehouseStock' },
    { value: 'Supplier', label: 'Supplier' },
    { value: 'RegionSupplierRule', label: 'RegionSupplierRule' },
    { value: 'PurchaseOrder', label: 'PurchaseOrder' },
    { value: 'PurchaseDelivery', label: 'PurchaseDelivery' },
  ]), [])

  async function load(nextEntity?: string) {
    const e = nextEntity ?? entity
    const qs = new URLSearchParams({ limit: '200', ...(e ? { entity: e } : {}) } as any).toString()
    const j = await getJSON<any>(`/audits?${qs}`)
    const rows = Array.isArray(j) ? j : (Array.isArray(j?.items) ? j.items : [])
    setData(Array.isArray(rows) ? rows : [])
  }

  useEffect(() => { load().catch((e) => message.error(e?.message || '加载失败')) }, [])

  const columns = [
    { title: '时间', dataIndex: 'created_at', render: (v: any) => v ? dayjs(v).format('YYYY-MM-DD HH:mm:ss') : '' },
    { title: '实体', dataIndex: 'entity' },
    { title: '动作', dataIndex: 'action' },
    { title: '实体ID', dataIndex: 'entity_id' },
    { title: '操作者', render: (_: any, r: any) => String(r?.actor?.display_name || r?.actor?.username || r?.actor?.email || r?.actor_id || '') },
  ]

  return (
    <Card title="操作日志">
      <Space style={{ marginBottom: 12 }} wrap>
        <Select value={entity} options={entityOptions} onChange={(v) => { setEntity(v); load(v).catch((e) => message.error(e?.message || '加载失败')) }} style={{ width: 260 }} />
      </Space>
      <Table rowKey={(r) => r.id} columns={columns as any} dataSource={data} pagination={{ pageSize: 20 }} />
    </Card>
  )
}

