"use client"
import { Card, Table, Space, Button, Tag, Select, message } from 'antd'
import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { getJSON } from '../../../lib/api'
import { hasPerm } from '../../../lib/auth'

type Warehouse = { id: string; code: string; name: string; active: boolean }
type Supplier = { id: string; name: string; kind: string; active: boolean }
type PoRow = {
  id: string
  supplier_id: string
  warehouse_id: string
  status: string
  requested_delivery_date?: string | null
  note?: string | null
  created_by?: string | null
  created_at: string
  supplier_name: string
  warehouse_name: string
  warehouse_code: string
}

export default function PurchaseOrdersPage() {
  const [rows, setRows] = useState<PoRow[]>([])
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [status, setStatus] = useState<string>('')
  const [warehouseId, setWarehouseId] = useState<string>('')
  const [supplierId, setSupplierId] = useState<string>('')

  const canManage = hasPerm('inventory.po.manage')

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
    if (status) params.status = status
    if (warehouseId) params.warehouse_id = warehouseId
    if (supplierId) params.supplier_id = supplierId
    const data = await getJSON<PoRow[]>(`/inventory/purchase-orders?${new URLSearchParams(params).toString()}`)
    setRows(data || [])
  }

  useEffect(() => { loadBase().then(load).catch((e) => message.error(e?.message || '加载失败')) }, [])

  const statusTag = (s: string) => {
    if (s === 'draft') return <Tag>草稿</Tag>
    if (s === 'ordered') return <Tag color="blue">已下单</Tag>
    if (s === 'received') return <Tag color="green">已到货</Tag>
    if (s === 'closed') return <Tag color="default">已关闭</Tag>
    return <Tag>{s}</Tag>
  }

  const warehouseOptions = useMemo(() => [{ value: '', label: '全部仓库' }, ...(warehouses || []).filter(w => w.active).map(w => ({ value: w.id, label: `${w.code} - ${w.name}` }))], [warehouses])
  const supplierOptions = useMemo(() => [{ value: '', label: '全部供应商' }, ...(suppliers || []).filter(s => s.active).map(s => ({ value: s.id, label: s.name }))], [suppliers])

  const columns: any[] = [
    { title: '创建时间', dataIndex: 'created_at' },
    { title: '供应商', dataIndex: 'supplier_name' },
    { title: '送货仓库', dataIndex: 'warehouse_name', render: (_: any, r: PoRow) => `${r.warehouse_code} - ${r.warehouse_name}` },
    { title: '状态', dataIndex: 'status', render: (v: string) => statusTag(v) },
    { title: '备注', dataIndex: 'note' },
    { title: '操作', dataIndex: '_op', render: (_: any, r: PoRow) => <Link href={`/inventory/purchase-orders/${r.id}`} prefetch={false}><Button>详情</Button></Link> },
  ]

  return (
    <Card
      title="采购单（PO）"
      extra={
        <Space>
          <Link href="/inventory/stocks" prefetch={false}><Button type="link">库存</Button></Link>
          <Link href="/inventory/movements" prefetch={false}><Button type="link">流水</Button></Link>
          <Link href="/inventory/purchase-orders" prefetch={false}><Button type="link">采购单</Button></Link>
          <Link href="/inventory/items" prefetch={false}><Button type="link">物料</Button></Link>
          {canManage ? <Link href="/inventory/purchase-orders/new" prefetch={false}><Button type="primary">新建采购单</Button></Link> : null}
        </Space>
      }
    >
      <Space wrap style={{ marginBottom: 12 }}>
        <Select value={status} onChange={setStatus} options={[{ value: '', label: '全部状态' }, { value: 'draft', label: '草稿' }, { value: 'ordered', label: '已下单' }, { value: 'received', label: '已到货' }, { value: 'closed', label: '已关闭' }]} style={{ width: 140 }} />
        <Select value={warehouseId} onChange={setWarehouseId} options={warehouseOptions} style={{ width: 220 }} />
        <Select value={supplierId} onChange={setSupplierId} options={supplierOptions} style={{ width: 220 }} />
        <Button type="primary" onClick={() => load().catch((e) => message.error(e?.message || '加载失败'))}>查询</Button>
      </Space>
      <Table rowKey={(r) => r.id} columns={columns} dataSource={rows} pagination={{ pageSize: 20 }} />
    </Card>
  )
}

