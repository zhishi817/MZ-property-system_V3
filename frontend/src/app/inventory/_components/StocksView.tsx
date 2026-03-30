"use client"
import { Card, Table, Space, Select, Button, Modal, Form, InputNumber, Input, message, Tag, Switch } from 'antd'
import { useEffect, useMemo, useState } from 'react'
import { getJSON, postJSON } from '../../../lib/api'
import { hasPerm } from '../../../lib/auth'

type Warehouse = { id: string; code: string; name: string; active: boolean }
type StockRow = {
  id: string
  warehouse_id: string
  item_id: string
  quantity: number
  threshold: number | null
  name: string
  sku: string
  category: string
  unit: string
  default_threshold: number
  bin_location?: string | null
  active: boolean
  is_key_item: boolean
  threshold_effective: number
}
type PropertyRow = { id: string; code?: string | null; address?: string | null; region?: string | null }

export type StocksViewProps = {
  title: string
  category?: string
  showCategoryColumn?: boolean
}

export default function StocksView(props: StocksViewProps) {
  const { title, category, showCategoryColumn } = props
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [warehouseId, setWarehouseId] = useState<string>('')
  const [stocks, setStocks] = useState<StockRow[]>([])
  const [warningsOnly, setWarningsOnly] = useState(false)
  const [keyOnly, setKeyOnly] = useState(false)
  const [moveOpen, setMoveOpen] = useState(false)
  const [transferOpen, setTransferOpen] = useState(false)
  const [properties, setProperties] = useState<PropertyRow[]>([])
  const [moveForm] = Form.useForm()
  const [transferForm] = Form.useForm()

  const canMove = hasPerm('inventory.move')

  async function loadWarehouses() {
    const ws = await getJSON<Warehouse[]>('/inventory/warehouses')
    setWarehouses(ws || [])
    if (!warehouseId && (ws || []).length) setWarehouseId((ws || [])[0].id)
  }

  async function loadStocks(id: string, warningsOnlyVal?: boolean, keyOnlyVal?: boolean) {
    if (!id) return
    const warn = warningsOnlyVal ?? warningsOnly
    const key = keyOnlyVal ?? keyOnly
    const params: any = { warehouse_id: id }
    if (warn) params.warnings_only = 'true'
    if (key) params.key_only = 'true'
    if (category) params.category = category
    const rows = await getJSON<StockRow[]>(`/inventory/stocks?${new URLSearchParams(params).toString()}`)
    setStocks(rows || [])
  }

  async function ensureProperties() {
    if (properties.length) return
    const ps = await getJSON<PropertyRow[]>('/properties')
    setProperties(ps || [])
  }

  useEffect(() => { loadWarehouses() }, [])
  useEffect(() => { if (warehouseId) loadStocks(warehouseId) }, [warehouseId])

  const whOptions = useMemo(() => (warehouses || []).filter(w => w.active).map(w => ({ value: w.id, label: `${w.code} - ${w.name}` })), [warehouses])
  const toWhOptions = useMemo(() => (warehouses || []).filter(w => w.active && w.id !== warehouseId).map(w => ({ value: w.id, label: `${w.code} - ${w.name}` })), [warehouses, warehouseId])

  async function submitMove() {
    const v = await moveForm.validateFields()
    await postJSON('/inventory/movements', {
      warehouse_id: warehouseId,
      item_id: v.item_id,
      type: v.type,
      quantity: v.quantity,
      property_id: v.property_id || undefined,
      reason: v.type === 'out' ? 'property_issue' : 'manual',
    })
    message.success('已提交')
    setMoveOpen(false)
    moveForm.resetFields()
    await loadStocks(warehouseId)
  }

  async function submitTransfer() {
    const v = await transferForm.validateFields()
    await postJSON('/inventory/transfers', {
      from_warehouse_id: warehouseId,
      to_warehouse_id: v.to_warehouse_id,
      item_id: v.item_id,
      quantity: v.quantity,
      note: v.note || undefined,
    })
    message.success('已调拨')
    setTransferOpen(false)
    transferForm.resetFields()
    await loadStocks(warehouseId)
  }

  const columns: any[] = [
    { title: '物料', dataIndex: 'name', render: (_: any, r: StockRow) => <Space><span>{r.name}</span>{r.quantity < r.threshold_effective ? <Tag color="red">低库存</Tag> : null}</Space> },
    { title: 'SKU', dataIndex: 'sku' },
    (showCategoryColumn ?? !category) ? { title: '分类', dataIndex: 'category' } : null,
    { title: '单位', dataIndex: 'unit' },
    { title: '库存', dataIndex: 'quantity' },
    { title: '预警阈值', dataIndex: 'threshold_effective' },
    { title: '仓位', dataIndex: 'bin_location' },
  ].filter(Boolean)

  return (
    <Card title={title}>
      <Space style={{ marginBottom: 12 }} wrap>
        <span>仓库</span>
        <Select value={warehouseId} options={whOptions} onChange={(v) => setWarehouseId(v)} style={{ minWidth: 220 }} />
        <Space>
          <span>仅低库存</span>
          <Switch checked={warningsOnly} onChange={(v) => { setWarningsOnly(v); loadStocks(warehouseId, v, undefined) }} />
        </Space>
        <Space>
          <span>仅关键SKU</span>
          <Switch checked={keyOnly} onChange={(v) => { setKeyOnly(v); loadStocks(warehouseId, undefined, v) }} />
        </Space>
        <Button onClick={() => loadStocks(warehouseId)}>刷新</Button>
        {canMove ? (
          <Space>
            <Button type="primary" onClick={async () => { await ensureProperties(); setMoveOpen(true) }}>入库/出库</Button>
            <Button onClick={() => setTransferOpen(true)}>调拨</Button>
          </Space>
        ) : null}
      </Space>
      <Table rowKey={(r) => r.id} columns={columns} dataSource={stocks} pagination={{ pageSize: 20 }} />

      <Modal open={moveOpen} title="入库/出库" onCancel={() => setMoveOpen(false)} onOk={submitMove}>
        <Form form={moveForm} layout="vertical">
          <Form.Item name="item_id" label="物料" rules={[{ required: true }]}>
            <Select
              showSearch
              optionFilterProp="label"
              options={(stocks || []).map(s => ({ value: s.item_id, label: `${s.name} (${s.sku})` }))}
            />
          </Form.Item>
          <Form.Item name="type" label="类型" rules={[{ required: true }]}>
            <Select options={[{ value: 'in', label: '入库' }, { value: 'out', label: '出库（关联房源）' }]} />
          </Form.Item>
          <Form.Item shouldUpdate={(p, c) => p.type !== c.type} noStyle>
            {({ getFieldValue }) => getFieldValue('type') === 'out' ? (
              <Form.Item name="property_id" label="房源" rules={[{ required: true }]}>
                <Select
                  showSearch
                  optionFilterProp="label"
                  options={(properties || []).map(p => ({ value: p.id, label: `${p.code || ''} ${p.address || ''}`.trim() }))}
                />
              </Form.Item>
            ) : null}
          </Form.Item>
          <Form.Item name="quantity" label="数量" rules={[{ required: true }]}>
            <InputNumber min={1} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal open={transferOpen} title="仓库调拨" onCancel={() => setTransferOpen(false)} onOk={submitTransfer}>
        <Form form={transferForm} layout="vertical">
          <Form.Item name="to_warehouse_id" label="目标仓库" rules={[{ required: true }]}>
            <Select options={toWhOptions} />
          </Form.Item>
          <Form.Item name="item_id" label="物料" rules={[{ required: true }]}>
            <Select
              showSearch
              optionFilterProp="label"
              options={(stocks || []).map(s => ({ value: s.item_id, label: `${s.name} (${s.sku})` }))}
            />
          </Form.Item>
          <Form.Item name="quantity" label="数量" rules={[{ required: true }]}>
            <InputNumber min={1} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="note" label="备注">
            <Input />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  )
}

