"use client"
import { App, Button, Card, Form, Input, InputNumber, Modal, Select, Space, Table, Tabs, Tag } from 'antd'
import { useEffect, useMemo, useState } from 'react'
import dayjs from 'dayjs'
import { getJSON, patchJSON, postJSON } from '../../../lib/api'

type Warehouse = { id: string; code: string; name: string; active: boolean }
type Supplier = { id: string; name: string; kind: string; active: boolean }
type Item = { id: string; name: string; sku: string; active: boolean }
type MovementRow = {
  id: string
  created_at: string
  warehouse_code: string
  warehouse_name: string
  item_name: string
  item_sku: string
  quantity: number
  note?: string | null
}
type ReturnBatch = {
  id: string
  supplier_name: string
  warehouse_code: string
  warehouse_name: string
  status: string
  returned_at?: string | null
  quantity_total: number
  amount_total: number
  note?: string | null
}
type RefundRow = {
  id: string
  supplier_name: string
  warehouse_code: string
  warehouse_name: string
  expected_amount: number
  received_amount: number
  variance_amount: number
  status: string
  received_at?: string | null
  note?: string | null
}
type DamageRow = {
  id: string
  warehouse_code?: string | null
  warehouse_name?: string | null
  item_name?: string | null
  item_sku?: string | null
  quantity: number
  status: string
  note?: string | null
  created_at: string
}

export default function LinenReturnsDamageView() {
  const { message } = App.useApp()
  const [tab, setTab] = useState('intakes')
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [items, setItems] = useState<Item[]>([])
  const [intakes, setIntakes] = useState<MovementRow[]>([])
  const [batches, setBatches] = useState<ReturnBatch[]>([])
  const [refunds, setRefunds] = useState<RefundRow[]>([])
  const [damages, setDamages] = useState<DamageRow[]>([])
  const [intakeOpen, setIntakeOpen] = useState(false)
  const [batchOpen, setBatchOpen] = useState(false)
  const [refundOpen, setRefundOpen] = useState(false)
  const [damageOpen, setDamageOpen] = useState(false)
  const [editingRefund, setEditingRefund] = useState<RefundRow | null>(null)
  const [intakeForm] = Form.useForm()
  const [batchForm] = Form.useForm()
  const [refundForm] = Form.useForm()
  const [damageForm] = Form.useForm()

  async function loadBase() {
    const [ws, ss, its] = await Promise.all([
      getJSON<Warehouse[]>('/inventory/warehouses'),
      getJSON<Supplier[]>('/inventory/suppliers'),
      getJSON<Item[]>('/inventory/items?active=true&category=linen'),
    ])
    setWarehouses((ws || []).filter((w) => w.active))
    setSuppliers((ss || []).filter((s) => s.active && s.kind === 'linen'))
    setItems((its || []).filter((i) => i.active))
  }

  async function loadAll() {
    const [intakeRows, batchRows, refundRows, damageRows] = await Promise.all([
      getJSON<MovementRow[]>('/inventory/movements?category=linen&reason=return_from_subwarehouse&limit=200'),
      getJSON<ReturnBatch[]>('/inventory/linen/supplier-return-batches'),
      getJSON<RefundRow[]>('/inventory/linen/supplier-refunds'),
      getJSON<DamageRow[]>('/inventory/stock-change-requests?category=linen&reason=damage&limit=200'),
    ])
    setIntakes(intakeRows || [])
    setBatches(batchRows || [])
    setRefunds(refundRows || [])
    setDamages(damageRows || [])
  }

  useEffect(() => {
    loadBase()
      .then(loadAll)
      .catch((e) => message.error(e?.message || '加载失败'))
  }, [])

  async function submitIntake() {
    const v = await intakeForm.validateFields()
    await postJSON('/inventory/linen/return-intakes', {
      from_warehouse_id: v.from_warehouse_id,
      item_id: v.item_id,
      quantity: Number(v.quantity || 0),
      note: v.note || undefined,
    })
    message.success('已登记脏床品回仓')
    setIntakeOpen(false)
    intakeForm.resetFields()
    await loadAll()
  }

  async function submitBatch() {
    const v = await batchForm.validateFields()
    await postJSON('/inventory/linen/supplier-return-batches', {
      supplier_id: v.supplier_id,
      warehouse_id: v.warehouse_id,
      note: v.note || undefined,
      lines: (v.lines || []).map((line: any) => ({
        item_id: line.item_id,
        quantity: Number(line.quantity || 0),
        refund_unit_price: line.refund_unit_price === undefined ? undefined : Number(line.refund_unit_price || 0),
        note: line.note || undefined,
      })),
    })
    message.success('已登记返厂批次')
    setBatchOpen(false)
    batchForm.resetFields()
    await loadAll()
  }

  async function submitRefund() {
    const v = await refundForm.validateFields()
    if (!editingRefund) return
    await patchJSON(`/inventory/linen/supplier-refunds/${editingRefund.id}`, {
      received_amount: Number(v.received_amount || 0),
      received_at: v.received_at || undefined,
      note: v.note || undefined,
    })
    message.success('退款状态已更新')
    setRefundOpen(false)
    setEditingRefund(null)
    refundForm.resetFields()
    await loadAll()
  }

  async function submitDamage() {
    const v = await damageForm.validateFields()
    await postJSON('/inventory/stock-change-requests', {
      warehouse_id: v.warehouse_id,
      item_id: v.item_id,
      quantity: Number(v.quantity || 0),
      reason: 'damage',
      note: v.note || undefined,
    })
    message.success('报损已提交')
    setDamageOpen(false)
    damageForm.resetFields()
    await loadAll()
  }

  const warehouseOptions = useMemo(() => warehouses.filter((w) => `${w.code}`.toUpperCase() !== 'SOU').map((w) => ({ value: w.id, label: `${w.code} - ${w.name}` })), [warehouses])
  const smWarehouseId = useMemo(() => warehouses.find((w) => `${w.code}`.toUpperCase() === 'SOU')?.id, [warehouses])
  const supplierOptions = useMemo(() => suppliers.map((s) => ({ value: s.id, label: s.name })), [suppliers])
  const itemOptions = useMemo(() => items.map((i) => ({ value: i.id, label: `${i.name} (${i.sku})` })), [items])

  return (
    <>
      <Card title="床品退回 / 返厂 / 退款 / 报损">
        <Tabs
          activeKey={tab}
          onChange={setTab}
          items={[
            {
              key: 'intakes',
              label: '脏床品回仓',
              children: (
                <>
                  <Space style={{ marginBottom: 12 }}>
                    <Button type="primary" onClick={() => { setIntakeOpen(true); intakeForm.resetFields() }}>登记回仓</Button>
                  </Space>
                  <Table
                    rowKey={(r) => r.id}
                    dataSource={intakes}
                    columns={[
                      { title: '时间', dataIndex: 'created_at', render: (v: string) => dayjs(v).format('YYYY-MM-DD HH:mm') },
                      { title: '仓库', render: (_: any, r: MovementRow) => `${r.warehouse_code} - ${r.warehouse_name}` },
                      { title: '床品', render: (_: any, r: MovementRow) => `${r.item_name} (${r.item_sku})` },
                      { title: '数量', dataIndex: 'quantity' },
                      { title: '备注', dataIndex: 'note' },
                    ]}
                    pagination={{ pageSize: 20 }}
                  />
                </>
              ),
            },
            {
              key: 'batches',
              label: '返厂批次',
              children: (
                <>
                  <Space style={{ marginBottom: 12 }}>
                    <Button type="primary" onClick={() => { setBatchOpen(true); batchForm.resetFields(); batchForm.setFieldsValue({ warehouse_id: smWarehouseId, lines: [{ quantity: 1 }] }) }}>新建返厂批次</Button>
                  </Space>
                  <Table
                    rowKey={(r) => r.id}
                    dataSource={batches}
                    columns={[
                      { title: '返厂时间', dataIndex: 'returned_at', render: (v: string) => v ? dayjs(v).format('YYYY-MM-DD HH:mm') : '-' },
                      { title: '供应商', dataIndex: 'supplier_name' },
                      { title: '仓库', render: (_: any, r: ReturnBatch) => `${r.warehouse_code} - ${r.warehouse_name}` },
                      { title: '状态', dataIndex: 'status', render: (v: string) => <Tag color={v === 'returned' ? 'blue' : 'green'}>{v}</Tag> },
                      { title: '数量', dataIndex: 'quantity_total' },
                      { title: '应退金额', dataIndex: 'amount_total' },
                      { title: '备注', dataIndex: 'note' },
                    ]}
                    pagination={{ pageSize: 20 }}
                  />
                </>
              ),
            },
            {
              key: 'refunds',
              label: '退款核销',
              children: (
                <Table
                  rowKey={(r) => r.id}
                  dataSource={refunds}
                  columns={[
                    { title: '供应商', dataIndex: 'supplier_name' },
                    { title: '仓库', render: (_: any, r: RefundRow) => `${r.warehouse_code} - ${r.warehouse_name}` },
                    { title: '应收', dataIndex: 'expected_amount' },
                    { title: '已收', dataIndex: 'received_amount' },
                    { title: '差异', dataIndex: 'variance_amount' },
                    { title: '状态', dataIndex: 'status', render: (v: string) => <Tag color={v === 'settled' ? 'green' : v === 'partial' ? 'orange' : 'blue'}>{v}</Tag> },
                    { title: '到账时间', dataIndex: 'received_at', render: (v: string | null | undefined) => v ? dayjs(v).format('YYYY-MM-DD HH:mm') : '-' },
                    {
                      title: '操作',
                      render: (_: any, r: RefundRow) => (
                        <Button onClick={() => {
                          setEditingRefund(r)
                          setRefundOpen(true)
                          refundForm.setFieldsValue({ received_amount: r.received_amount, received_at: r.received_at || '', note: r.note || '' })
                        }}
                        >
                          更新到账
                        </Button>
                      ),
                    },
                  ]}
                  pagination={{ pageSize: 20 }}
                />
              ),
            },
            {
              key: 'damage',
              label: '报损',
              children: (
                <>
                  <Space style={{ marginBottom: 12 }}>
                    <Button type="primary" onClick={() => { setDamageOpen(true); damageForm.resetFields() }}>新建报损</Button>
                  </Space>
                  <Table
                    rowKey={(r) => r.id}
                    dataSource={damages}
                    columns={[
                      { title: '时间', dataIndex: 'created_at', render: (v: string) => dayjs(v).format('YYYY-MM-DD HH:mm') },
                      { title: '仓库', render: (_: any, r: DamageRow) => `${r.warehouse_code || ''} - ${r.warehouse_name || ''}`.trim() },
                      { title: '床品', render: (_: any, r: DamageRow) => `${r.item_name || '-'} ${r.item_sku ? `(${r.item_sku})` : ''}` },
                      { title: '数量', dataIndex: 'quantity' },
                      { title: '状态', dataIndex: 'status' },
                      { title: '备注', dataIndex: 'note' },
                    ]}
                    pagination={{ pageSize: 20 }}
                  />
                </>
              ),
            },
          ]}
        />
      </Card>

      <Modal open={intakeOpen} title="登记脏床品回仓" onCancel={() => setIntakeOpen(false)} onOk={submitIntake}>
        <Form form={intakeForm} layout="vertical">
          <Form.Item name="from_warehouse_id" label="来源分仓" rules={[{ required: true }]}><Select options={warehouseOptions} /></Form.Item>
          <Form.Item name="item_id" label="床品类型" rules={[{ required: true }]}><Select showSearch optionFilterProp="label" options={itemOptions} /></Form.Item>
          <Form.Item name="quantity" label="数量" rules={[{ required: true }]}><InputNumber min={1} style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="note" label="备注"><Input /></Form.Item>
        </Form>
      </Modal>

      <Modal open={batchOpen} title="新建返厂批次" onCancel={() => setBatchOpen(false)} onOk={submitBatch} width={840}>
        <Form form={batchForm} layout="vertical">
          <Space wrap style={{ width: '100%' }}>
            <Form.Item name="supplier_id" label="供应商" rules={[{ required: true }]} style={{ minWidth: 220 }}><Select options={supplierOptions} /></Form.Item>
            <Form.Item name="warehouse_id" label="返厂仓库" rules={[{ required: true }]} style={{ minWidth: 220 }}><Select options={warehouses.map((w) => ({ value: w.id, label: `${w.code} - ${w.name}` }))} /></Form.Item>
          </Space>
          <Form.Item name="note" label="备注"><Input /></Form.Item>
          <Form.List name="lines" rules={[{ validator: async (_: any, v: any[]) => { if (!v || v.length < 1) throw new Error('至少一条明细') } }]}>
            {(fields, { add, remove }) => (
              <>
                {fields.map((f) => (
                  <Space key={f.key} align="baseline" style={{ display: 'flex', marginBottom: 8 }} wrap>
                    <Form.Item {...f} name={[f.name, 'item_id']} label="床品" rules={[{ required: true }]} style={{ minWidth: 280 }}><Select showSearch optionFilterProp="label" options={itemOptions} /></Form.Item>
                    <Form.Item {...f} name={[f.name, 'quantity']} label="数量" rules={[{ required: true }]} style={{ width: 120 }}><InputNumber min={1} style={{ width: '100%' }} /></Form.Item>
                    <Form.Item {...f} name={[f.name, 'refund_unit_price']} label="退款单价" style={{ width: 140 }}><InputNumber min={0} style={{ width: '100%' }} /></Form.Item>
                    <Form.Item {...f} name={[f.name, 'note']} label="备注" style={{ minWidth: 180 }}><Input /></Form.Item>
                    <Button onClick={() => remove(f.name)} danger>删除</Button>
                  </Space>
                ))}
                <Button onClick={() => add({ quantity: 1 })}>新增明细</Button>
              </>
            )}
          </Form.List>
        </Form>
      </Modal>

      <Modal open={refundOpen} title="更新退款到账" onCancel={() => setRefundOpen(false)} onOk={submitRefund}>
        <Form form={refundForm} layout="vertical">
          <Form.Item name="received_amount" label="已到账金额" rules={[{ required: true }]}><InputNumber min={0} style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="received_at" label="到账时间"><Input placeholder="YYYY-MM-DD HH:mm:ss" /></Form.Item>
          <Form.Item name="note" label="备注"><Input /></Form.Item>
        </Form>
      </Modal>

      <Modal open={damageOpen} title="新建报损" onCancel={() => setDamageOpen(false)} onOk={submitDamage}>
        <Form form={damageForm} layout="vertical">
          <Form.Item name="warehouse_id" label="仓库" rules={[{ required: true }]}><Select options={warehouses.map((w) => ({ value: w.id, label: `${w.code} - ${w.name}` }))} /></Form.Item>
          <Form.Item name="item_id" label="床品类型" rules={[{ required: true }]}><Select showSearch optionFilterProp="label" options={itemOptions} /></Form.Item>
          <Form.Item name="quantity" label="数量" rules={[{ required: true }]}><InputNumber min={1} style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="note" label="备注"><Input /></Form.Item>
        </Form>
      </Modal>
    </>
  )
}
