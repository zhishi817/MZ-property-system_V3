"use client"
import { Card, Table, Space, Select, Button, DatePicker, message } from 'antd'
import { useEffect, useMemo, useState } from 'react'
import dayjs from 'dayjs'
import { getJSON } from '../../../lib/api'

type Warehouse = { id: string; code: string; name: string; active: boolean }
type Supplier = { id: string; name: string; kind: string; active: boolean }
type DeliveryRow = {
  id: string
  po_id: string
  received_at: string
  received_by?: string | null
  note?: string | null
  supplier_id: string
  warehouse_id: string
  supplier_name: string
  warehouse_code: string
  warehouse_name: string
  line_count: number
  quantity_total: number
}

export type DeliveriesListViewProps = {
  title: string
  category?: string
}

export default function DeliveriesListView(props: DeliveriesListViewProps) {
  const { title, category } = props
  const [rows, setRows] = useState<DeliveryRow[]>([])
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [warehouseId, setWarehouseId] = useState<string>('')
  const [supplierId, setSupplierId] = useState<string>('')
  const [range, setRange] = useState<[any, any] | null>(null)

  async function loadBase() {
    const [ws, ss] = await Promise.all([
      getJSON<Warehouse[]>('/inventory/warehouses'),
      getJSON<Supplier[]>('/inventory/suppliers'),
    ])
    setWarehouses(ws || [])
    setSuppliers(ss || [])
  }

  async function load() {
    const params: any = {}
    if (warehouseId) params.warehouse_id = warehouseId
    if (supplierId) params.supplier_id = supplierId
    if (category) params.category = category
    if (range?.[0]) params.from = dayjs(range[0]).toISOString()
    if (range?.[1]) params.to = dayjs(range[1]).toISOString()
    const data = await getJSON<DeliveryRow[]>(`/inventory/deliveries?${new URLSearchParams(params).toString()}`)
    setRows(data || [])
  }

  useEffect(() => { loadBase().then(load).catch((e) => message.error(e?.message || '加载失败')) }, [])

  const warehouseOptions = useMemo(() => [{ value: '', label: '全部仓库' }, ...(warehouses || []).filter(w => w.active).map(w => ({ value: w.id, label: `${w.code} - ${w.name}` }))], [warehouses])
  const supplierOptions = useMemo(() => [{ value: '', label: '全部供应商' }, ...(suppliers || []).filter(s => s.active).map(s => ({ value: s.id, label: s.name }))], [suppliers])

  const columns: any[] = [
    { title: '到货时间', dataIndex: 'received_at', render: (v: string) => v ? dayjs(v).format('YYYY-MM-DD HH:mm') : '' },
    { title: '供应商', dataIndex: 'supplier_name' },
    { title: '送货仓库', render: (_: any, r: DeliveryRow) => `${r.warehouse_code} - ${r.warehouse_name}` },
    { title: '行数', dataIndex: 'line_count' },
    { title: '到货总量', dataIndex: 'quantity_total' },
    { title: '收货人', dataIndex: 'received_by' },
    { title: '备注', dataIndex: 'note' },
  ]

  return (
    <Card title={title}>
      <Space wrap style={{ marginBottom: 12 }}>
        <Select value={warehouseId} onChange={setWarehouseId} options={warehouseOptions} style={{ width: 220 }} />
        <Select value={supplierId} onChange={setSupplierId} options={supplierOptions} style={{ width: 220 }} />
        <DatePicker.RangePicker value={range as any} onChange={(v) => setRange(v as any)} allowClear />
        <Button type="primary" onClick={() => load().catch((e) => message.error(e?.message || '加载失败'))}>查询</Button>
      </Space>
      <Table rowKey={(r) => r.id} columns={columns} dataSource={rows} pagination={{ pageSize: 20 }} />
    </Card>
  )
}

