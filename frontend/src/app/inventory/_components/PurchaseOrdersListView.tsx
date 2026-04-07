"use client"
import { Card, Table, Space, Button, Tag, Select, message, Modal, Form, Input, InputNumber } from 'antd'
import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import dayjs from 'dayjs'
import { getJSON, patchJSON, postJSON } from '../../../lib/api'
import { hasPerm } from '../../../lib/auth'

type Warehouse = { id: string; code: string; name: string; active: boolean }
type Supplier = { id: string; name: string; kind: string; active: boolean }
type PoRow = {
  id: string
  po_no?: string | null
  supplier_id: string
  warehouse_id: string
  status: string
  ordered_date?: string | null
  requested_delivery_date?: string | null
  note?: string | null
  created_by?: string | null
  created_at: string
  supplier_name: string
  warehouse_name: string
  warehouse_code: string
  total_amount_inc_gst?: string | null
}
type DeliveryLine = { item_id: string; item_name: string; item_sku: string; quantity: number }

export type PurchaseOrdersListViewProps = {
  title: string
  category?: string
}

export default function PurchaseOrdersListView(props: PurchaseOrdersListViewProps) {
  const { title, category } = props
  const newPath = '/inventory/purchase-orders/new'
  const [rows, setRows] = useState<PoRow[]>([])
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [status, setStatus] = useState<string>('')
  const [warehouseId, setWarehouseId] = useState<string>('')
  const [supplierId, setSupplierId] = useState<string>('')
  const [deliveryPo, setDeliveryPo] = useState<PoRow | null>(null)
  const [deliveryLines, setDeliveryLines] = useState<DeliveryLine[]>([])
  const [deliverySaving, setDeliverySaving] = useState(false)
  const [deliveryForm] = Form.useForm()

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
    if (category) params.category = category
    const data = await getJSON<PoRow[]>(`/inventory/purchase-orders?${new URLSearchParams(params).toString()}`)
    setRows(data || [])
  }

  useEffect(() => { loadBase().then(load).catch((e) => message.error(e?.message || '加载失败')) }, [])

  async function markOrdered(row: PoRow) {
    await patchJSON(`/inventory/purchase-orders/${row.id}`, {
      status: 'ordered',
      ordered_date: row.ordered_date || dayjs().format('YYYY-MM-DD'),
    })
    message.success('采购单已下单')
    await load()
  }

  async function openDelivery(row: PoRow) {
    const detail = await getJSON<any>(`/inventory/purchase-orders/${row.id}`)
    const po = detail?.po || row
    const lines = (detail?.lines || []).map((line: any) => ({
      item_id: String(line.item_id),
      item_name: String(line.item_name || ''),
      item_sku: String(line.item_sku || ''),
      quantity: Number(line.quantity || 0),
    }))
    setDeliveryPo(po)
    setDeliveryLines(lines)
    deliveryForm.setFieldsValue({
      lines: lines.map((line: DeliveryLine) => ({
        item_id: line.item_id,
        quantity_received: line.quantity,
        note: '',
      })),
      note: '',
    })
  }

  async function submitDelivery() {
    if (!deliveryPo) return
    setDeliverySaving(true)
    try {
      const values = await deliveryForm.validateFields()
      await postJSON(`/inventory/purchase-orders/${deliveryPo.id}/deliveries`, {
        note: values.note || undefined,
        lines: (values.lines || []).map((line: any) => ({
          item_id: line.item_id,
          quantity_received: Number(line.quantity_received || 0),
          note: line.note || undefined,
        })),
      })
      message.success('到货已登记，采购单状态已更新')
      setDeliveryPo(null)
      setDeliveryLines([])
      deliveryForm.resetFields()
      await load()
    } finally {
      setDeliverySaving(false)
    }
  }

  function archiveRow(row: PoRow) {
    Modal.confirm({
      title: '确认归档采购单？',
      content: `采购单 ${row.po_no || row.id} 将被标记为已关闭。`,
      okText: '归档',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        await patchJSON(`/inventory/purchase-orders/${row.id}`, { status: 'closed' })
        message.success('已归档')
        await load()
      },
    })
  }

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
    { title: '采购单号', dataIndex: 'po_no', width: 180, render: (v: string, r: PoRow) => v || r.id },
    { title: '下单日期', dataIndex: 'ordered_date', width: 140, render: (v: string | null) => v || '-' },
    { title: '供应商', dataIndex: 'supplier_name' },
    { title: '送货仓库', dataIndex: 'warehouse_name', render: (_: any, r: PoRow) => `${r.warehouse_code} - ${r.warehouse_name}` },
    { title: '总金额', dataIndex: 'total_amount_inc_gst', width: 140, render: (v: string | null) => `$${Number(v || 0).toFixed(2)}` },
    { title: '状态', dataIndex: 'status', render: (v: string) => statusTag(v) },
    { title: '备注', dataIndex: 'note' },
    {
      title: '操作',
      dataIndex: '_op',
      width: 220,
      render: (_: any, r: PoRow) => (
        <Space>
          <Link href={`/inventory/purchase-orders/${r.id}`} prefetch={false}><Button>详情</Button></Link>
          {canManage && r.status !== 'received' && r.status !== 'closed' ? <Link href={`/inventory/purchase-orders/${r.id}?edit=1`} prefetch={false}><Button>编辑</Button></Link> : null}
          {canManage && r.status === 'draft' ? <Button type="primary" onClick={() => markOrdered(r).catch((e) => message.error(e?.message || '下单失败'))}>下单</Button> : null}
          {canManage && r.status === 'ordered' ? <Button onClick={() => openDelivery(r).catch((e) => message.error(e?.message || '加载到货明细失败'))}>登记到货</Button> : null}
          {canManage ? <Button danger onClick={() => archiveRow(r)}>归档</Button> : null}
        </Space>
      ),
    },
  ]

  return (
    <Card
      title={title}
      extra={canManage ? <Link href={newPath} prefetch={false}><Button type="primary">新建采购单</Button></Link> : null}
    >
      <Space wrap style={{ marginBottom: 12 }}>
        <Select value={status} onChange={setStatus} options={[{ value: '', label: '全部状态' }, { value: 'draft', label: '草稿' }, { value: 'ordered', label: '已下单' }, { value: 'received', label: '已到货' }, { value: 'closed', label: '已关闭' }]} style={{ width: 140 }} />
        <Select value={warehouseId} onChange={setWarehouseId} options={warehouseOptions} style={{ width: 220 }} />
        <Select value={supplierId} onChange={setSupplierId} options={supplierOptions} style={{ width: 220 }} />
        <Button type="primary" onClick={() => load().catch((e) => message.error(e?.message || '加载失败'))}>查询</Button>
      </Space>
      <Table
        rowKey={(r) => r.id}
        columns={columns}
        dataSource={rows}
        pagination={{ pageSize: 20 }}
      />

      <Modal
        open={!!deliveryPo}
        title={deliveryPo ? `登记到货 · ${deliveryPo.po_no || deliveryPo.id}` : '登记到货'}
        onCancel={() => { setDeliveryPo(null); setDeliveryLines([]); deliveryForm.resetFields() }}
        onOk={() => submitDelivery().catch((e) => message.error(e?.message || '登记到货失败'))}
        confirmLoading={deliverySaving}
        okText="确认入库"
        cancelText="取消"
        width={880}
      >
        <Form form={deliveryForm} layout="vertical" initialValues={{ lines: [] }}>
          <Form.List name="lines">
            {(fields) => (
              <div style={{ display: 'grid', gap: 12 }}>
                {fields.map((f, idx) => {
                  const line = deliveryLines[idx]
                  return (
                    <Space key={f.key} align="baseline" style={{ display: 'flex' }} wrap>
                      <div style={{ minWidth: 280 }}>
                        <div style={{ fontWeight: 600 }}>{line?.item_name || '-'}</div>
                        <div style={{ color: '#666', fontSize: 12 }}>{line?.item_sku || ''}</div>
                      </div>
                      <Form.Item {...f} name={[f.name, 'item_id']} hidden><Input /></Form.Item>
                      <Form.Item label="采购数量">
                        <InputNumber value={line?.quantity || 0} disabled style={{ width: 120 }} />
                      </Form.Item>
                      <Form.Item {...f} name={[f.name, 'quantity_received']} label="到货数量" rules={[{ required: true, message: '请输入到货数量' }]}>
                        <InputNumber min={1} style={{ width: 140 }} />
                      </Form.Item>
                      <Form.Item {...f} name={[f.name, 'note']} label="备注" style={{ minWidth: 220 }}>
                        <Input />
                      </Form.Item>
                    </Space>
                  )
                })}
              </div>
            )}
          </Form.List>
          <Form.Item name="note" label="到货备注" style={{ marginTop: 16 }}>
            <Input />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  )
}
