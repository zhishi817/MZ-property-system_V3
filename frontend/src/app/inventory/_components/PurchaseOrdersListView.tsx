"use client"
import { Card, Table, Space, Button, Tag, Select, message, Modal, Form, Input, InputNumber, DatePicker } from 'antd'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useState } from 'react'
import dayjs from 'dayjs'
import { getJSON, patchJSON, postJSON } from '../../../lib/api'
import { hasPerm } from '../../../lib/auth'
import TableRowActions from '../../../components/TableRowActions'

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
  paid_expense_id?: string | null
  paid_at?: string | null
}
type DeliveryLine = { item_id: string; item_name: string; item_sku: string; quantity: number }

export type PurchaseOrdersListViewProps = {
  title: string
  category?: string
}

export default function PurchaseOrdersListView(props: PurchaseOrdersListViewProps) {
  const { title, category } = props
  const router = useRouter()
  const newPath = category ? `/inventory/category/${category}/purchase-orders/new` : '/inventory/purchase-orders/new'
  const [rows, setRows] = useState<PoRow[]>([])
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [status, setStatus] = useState<string>('')
  const [warehouseId, setWarehouseId] = useState<string>('')
  const [supplierId, setSupplierId] = useState<string>('')
  const [deliveryPo, setDeliveryPo] = useState<PoRow | null>(null)
  const [deliveryLines, setDeliveryLines] = useState<DeliveryLine[]>([])
  const [deliverySaving, setDeliverySaving] = useState(false)
  const [payingId, setPayingId] = useState<string>('')
  const [deliveryForm] = Form.useForm()

  const canManage = hasPerm('inventory.po.manage')
  const canMarkPaid = category === 'linen' && (hasPerm('inventory_linen_purchase_orders.pay') || hasPerm('finance.tx.write') || hasPerm('company_expenses.write'))

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
      received_at: dayjs(),
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
      const receivedAt = values.received_at ? dayjs(values.received_at).format('YYYY-MM-DD') : undefined
      await postJSON(`/inventory/purchase-orders/${deliveryPo.id}/deliveries`, {
        received_at: receivedAt,
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

  function markPaid(row: PoRow) {
    Modal.confirm({
      title: '确认标记已支付？',
      content: `采购单 ${row.po_no || row.id} 将记录为公司支出。`,
      okText: '确认已支付',
      cancelText: '取消',
      onOk: async () => {
        setPayingId(row.id)
        try {
          await postJSON(`/inventory/purchase-orders/${row.id}/mark-paid`, {})
          message.success('已记录公司支出')
          await load()
        } finally {
          setPayingId('')
        }
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

  const detailPath = (id: string) => category ? `/inventory/purchase-orders/${id}?category=${category}` : `/inventory/purchase-orders/${id}`
  const editPath = (id: string) => category ? `/inventory/purchase-orders/${id}?edit=1&category=${category}` : `/inventory/purchase-orders/${id}?edit=1`

  const columns: any[] = [
    { title: '采购单号', dataIndex: 'po_no', width: 180, render: (v: string, r: PoRow) => v || r.id },
    { title: '下单日期', dataIndex: 'ordered_date', width: 140, render: (v: string | null) => v || '-' },
    { title: '供应商', dataIndex: 'supplier_name' },
    { title: '送货仓库', dataIndex: 'warehouse_name', render: (_: any, r: PoRow) => `${r.warehouse_code} - ${r.warehouse_name}` },
    { title: '总金额', dataIndex: 'total_amount_inc_gst', width: 140, render: (v: string | null) => `$${Number(v || 0).toFixed(2)}` },
    { title: '状态', dataIndex: 'status', render: (v: string) => statusTag(v) },
    { title: '付款', dataIndex: 'paid_at', width: 120, render: (_value: string | null, r: PoRow) => r.paid_expense_id ? <Tag color="green">已支付</Tag> : '-' },
    { title: '备注', dataIndex: 'note' },
    {
      title: '操作',
      dataIndex: '_op',
      width: 360,
      render: (_: any, r: PoRow) => (
        <TableRowActions
          actions={[
            { key: 'detail', label: '详情', onClick: () => router.push(detailPath(r.id)) },
            { key: 'edit', label: '编辑', onClick: () => router.push(editPath(r.id)), hidden: !canManage || r.status === 'received' || r.status === 'closed' },
            { key: 'order', label: '下单', onClick: () => markOrdered(r).catch((e) => message.error(e?.message || '下单失败')), hidden: !canManage || r.status !== 'draft' },
            { key: 'receive', label: '登记到货', onClick: () => openDelivery(r).catch((e) => message.error(e?.message || '加载到货明细失败')), hidden: !canManage || r.status !== 'ordered' },
            { key: 'paid', label: '确认已支付', onClick: () => markPaid(r), hidden: !canMarkPaid || !!r.paid_expense_id || !['ordered', 'received'].includes(String(r.status || '')), loading: payingId === r.id },
            { key: 'archive', label: '归档', onClick: () => archiveRow(r), danger: true, hidden: !canManage },
          ]}
        />
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
        width={1120}
      >
        <Form form={deliveryForm} layout="vertical" initialValues={{ received_at: dayjs(), lines: [] }}>
          <Form.Item name="received_at" label="到货时间">
            <DatePicker format="YYYY-MM-DD" allowClear={false} style={{ width: 160 }} />
          </Form.Item>
          <Form.List name="lines">
            {(fields) => (
              <div style={{ display: 'grid', gap: 12 }}>
                {fields.map((f, idx) => {
                  const line = deliveryLines[idx]
                  return (
                    <div key={f.key} style={{ display: 'grid', gridTemplateColumns: '320px 120px 140px minmax(260px, 1fr)', gap: 16, alignItems: 'start' }}>
                      <div style={{ paddingTop: 2 }}>
                        <div style={{ fontSize: 14, color: 'rgba(0,0,0,0.88)', marginBottom: 8 }}>床品类型</div>
                        <div style={{ fontWeight: 600 }}>{line?.item_name || '-'}</div>
                        <div style={{ color: '#666', fontSize: 12 }}>{line?.item_sku || ''}</div>
                      </div>
                      <Form.Item {...f} name={[f.name, 'item_id']} hidden><Input /></Form.Item>
                      <Form.Item label="采购数量" style={{ marginBottom: 0 }}>
                        <InputNumber value={line?.quantity || 0} disabled style={{ width: 120 }} />
                      </Form.Item>
                      <Form.Item {...f} name={[f.name, 'quantity_received']} label="到货数量" rules={[{ required: true, message: '请输入到货数量' }]} style={{ marginBottom: 0 }}>
                        <InputNumber min={0} precision={0} style={{ width: 140 }} />
                      </Form.Item>
                      <Form.Item {...f} name={[f.name, 'note']} label="备注" style={{ marginBottom: 0 }}>
                        <Input />
                      </Form.Item>
                    </div>
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
