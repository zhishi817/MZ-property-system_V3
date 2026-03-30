"use client"
import { Card, Table, Space, Select, Button, DatePicker, message, Tag, Input } from 'antd'
import Link from 'next/link'
import { Suspense, useEffect, useMemo, useState } from 'react'
import dayjs from 'dayjs'
import { getJSON } from '../../../lib/api'
import { useSearchParams } from 'next/navigation'

type Warehouse = { id: string; code: string; name: string; active: boolean }
type Item = { id: string; name: string; sku: string; unit: string; category: string; active: boolean }
type PropertyRow = { id: string; code?: string | null; address?: string | null }
type MovementRow = {
  id: string
  warehouse_id: string
  item_id: string
  type: 'in' | 'out' | 'adjust'
  reason?: string | null
  quantity: number
  property_id?: string | null
  ref_type?: string | null
  ref_id?: string | null
  actor_id?: string | null
  note?: string | null
  created_at: string
  item_name: string
  item_sku: string
  warehouse_code: string
  warehouse_name: string
  property_code?: string | null
  property_address?: string | null
}

function InventoryMovementsInner() {
  const searchParams = useSearchParams()
  const category = String(searchParams?.get('category') || '').trim()
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [items, setItems] = useState<Item[]>([])
  const [properties, setProperties] = useState<PropertyRow[]>([])
  const [rows, setRows] = useState<MovementRow[]>([])
  const [warehouseId, setWarehouseId] = useState<string>('')
  const [itemId, setItemId] = useState<string>('')
  const [propertyId, setPropertyId] = useState<string>('')
  const [type, setType] = useState<string>('')
  const [q, setQ] = useState<string>('')
  const [range, setRange] = useState<[any, any] | null>(null)

  async function loadBase() {
    const [ws, its, ps] = await Promise.all([
      getJSON<Warehouse[]>('/inventory/warehouses'),
      getJSON<Item[]>('/inventory/items?active=true'),
      getJSON<PropertyRow[]>('/properties'),
    ])
    setWarehouses(ws || [])
    setItems(its || [])
    setProperties(ps || [])
  }

  async function load() {
    const params: Record<string, string> = { limit: '200' }
    if (warehouseId) params.warehouse_id = warehouseId
    if (itemId) params.item_id = itemId
    if (propertyId) params.property_id = propertyId
    if (type) params.type = type
    if (category) params.category = category
    if (range?.[0]) params.from = dayjs(range[0]).toISOString()
    if (range?.[1]) params.to = dayjs(range[1]).toISOString()
    const data = await getJSON<MovementRow[]>(`/inventory/movements?${new URLSearchParams(params as any).toString()}`)
    const filtered = q
      ? (data || []).filter(r => `${r.item_name} ${r.item_sku} ${r.property_code || ''} ${r.property_address || ''}`.toLowerCase().includes(q.toLowerCase()))
      : (data || [])
    setRows(filtered)
  }

  useEffect(() => { loadBase().then(() => load()).catch((e) => message.error(e?.message || '加载失败')) }, [])

  const whOptions = useMemo(() => [{ value: '', label: '全部仓库' }, ...(warehouses || []).filter(w => w.active).map(w => ({ value: w.id, label: `${w.code} - ${w.name}` }))], [warehouses])
  const itemOptions = useMemo(() => {
    const xs = category ? (items || []).filter((i) => String(i.category || '').trim() === category) : (items || [])
    return [{ value: '', label: '全部物料' }, ...xs.map(i => ({ value: i.id, label: `${i.name} (${i.sku})` }))]
  }, [items, category])
  const propOptions = useMemo(() => [{ value: '', label: '全部房源' }, ...(properties || []).map(p => ({ value: p.id, label: `${p.code || ''} ${p.address || ''}`.trim() }))], [properties])

  const columns: any[] = [
    { title: '时间', dataIndex: 'created_at', render: (v: string) => dayjs(v).format('YYYY-MM-DD HH:mm') },
    { title: '仓库', dataIndex: 'warehouse_name', render: (_: any, r: MovementRow) => `${r.warehouse_code} - ${r.warehouse_name}` },
    { title: '物料', dataIndex: 'item_name', render: (_: any, r: MovementRow) => <Space><span>{r.item_name}</span><Tag>{r.item_sku}</Tag></Space> },
    { title: '类型', dataIndex: 'type', render: (v: string) => v === 'in' ? <Tag color="green">入库</Tag> : v === 'out' ? <Tag color="orange">出库</Tag> : <Tag>调整</Tag> },
    { title: '数量', dataIndex: 'quantity' },
    { title: '房源', dataIndex: 'property_code', render: (_: any, r: MovementRow) => r.property_id ? `${r.property_code || ''} ${r.property_address || ''}`.trim() : '-' },
    { title: '原因', dataIndex: 'reason' },
    { title: '备注', dataIndex: 'note' },
  ]

  return (
    <Card
      title={category ? `${category === 'daily' ? '日用品' : category}库存流水` : '库存流水'}
      extra={
        <Space>
          <Link href="/inventory/stocks" prefetch={false}><Button type="link">库存</Button></Link>
          <Link href="/inventory/movements" prefetch={false}><Button type="link">流水</Button></Link>
          <Link href="/inventory/purchase-orders" prefetch={false}><Button type="link">采购单</Button></Link>
          <Link href="/inventory/items" prefetch={false}><Button type="link">物料</Button></Link>
        </Space>
      }
    >
      <Space wrap style={{ marginBottom: 12 }}>
        <Select value={warehouseId} options={whOptions} onChange={setWarehouseId} style={{ minWidth: 200 }} />
        <Select value={itemId} options={itemOptions} onChange={setItemId} style={{ minWidth: 240 }} showSearch optionFilterProp="label" />
        <Select value={propertyId} options={propOptions} onChange={setPropertyId} style={{ minWidth: 240 }} showSearch optionFilterProp="label" />
        <Select value={type} options={[{ value: '', label: '全部类型' }, { value: 'in', label: '入库' }, { value: 'out', label: '出库' }, { value: 'adjust', label: '调整' }]} onChange={setType} style={{ width: 140 }} />
        <DatePicker.RangePicker value={range as any} onChange={(v) => setRange(v as any)} allowClear />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="关键字筛选" style={{ width: 180 }} allowClear />
        <Button type="primary" onClick={() => load().catch((e) => message.error(e?.message || '加载失败'))}>查询</Button>
      </Space>
      <Table rowKey={(r) => r.id} columns={columns} dataSource={rows} pagination={{ pageSize: 20 }} />
    </Card>
  )
}

export default function InventoryMovementsPage() {
  return (
    <Suspense fallback={<Card title="库存流水" loading />}>
      <InventoryMovementsInner />
    </Suspense>
  )
}
