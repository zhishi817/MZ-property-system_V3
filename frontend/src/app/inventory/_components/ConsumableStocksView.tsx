"use client"

import { App, Button, Card, DatePicker, Descriptions, Drawer, Empty, Form, Input, InputNumber, Select, Space, Table, Tag, Typography } from 'antd'
import { PlusOutlined } from '@ant-design/icons'
import { useEffect, useMemo, useState } from 'react'
import dayjs from 'dayjs'
import { getJSON, postJSON } from '../../../lib/api'

type Warehouse = { id: string; code: string; name: string; active: boolean }
type ConsumableStockItem = {
  id: string
  item_id: string
  item_name: string
  sku: string
  unit?: string | null
  default_quantity?: number | null
  unit_price: number
  currency?: string | null
  stock_by_warehouse: Array<{ warehouse_id: string; quantity: number }>
  total_quantity: number
}
type ConsumableStockOverview = { warehouses: Warehouse[]; items: ConsumableStockItem[] }
type StocktakeRow = {
  id: string
  warehouse_id: string
  warehouse_code: string
  warehouse_name: string
  category: string
  stocktake_type: 'initial' | 'routine'
  stocktake_date: string
  note?: string | null
  created_at: string
  line_count: number
  counted_total: number
}
type StocktakeDetail = StocktakeRow & {
  lines: Array<{ id: string; item_id: string; item_name: string; item_sku: string; item_unit?: string | null; previous_quantity: number; counted_quantity: number; delta_quantity: number }>
}

export default function ConsumableStocksView() {
  const { message } = App.useApp()
  const [loading, setLoading] = useState(false)
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [rows, setRows] = useState<ConsumableStockItem[]>([])
  const [stocktakeRows, setStocktakeRows] = useState<StocktakeRow[]>([])
  const [stocktakeOpen, setStocktakeOpen] = useState(false)
  const [detailOpen, setDetailOpen] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detail, setDetail] = useState<StocktakeDetail | null>(null)
  const [stocktakeType, setStocktakeType] = useState<'initial' | 'routine'>('routine')
  const [selectedItemIds, setSelectedItemIds] = useState<string[]>([])
  const [pendingItemIds, setPendingItemIds] = useState<string[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [form] = Form.useForm()

  async function load() {
    setLoading(true)
    try {
      const [overviewResult, stocktakeResult] = await Promise.allSettled([
        getJSON<ConsumableStockOverview>('/inventory/consumable-stock-overview'),
        getJSON<StocktakeRow[]>('/inventory/stocktakes?category=consumable&limit=10'),
      ])

      if (overviewResult.status === 'fulfilled') {
        setWarehouses(overviewResult.value?.warehouses || [])
        setRows(overviewResult.value?.items || [])
      } else {
        throw overviewResult.reason
      }

      if (stocktakeResult.status === 'fulfilled') {
        setStocktakeRows(stocktakeResult.value || [])
      } else {
        setStocktakeRows([])
        message.warning(stocktakeResult.reason?.message || '库存更新记录暂时加载失败')
      }
    } catch (e: any) {
      message.error(e?.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load().catch(() => {}) }, [])

  const itemMap = useMemo(() => new Map(rows.map((row) => [String(row.item_id), row])), [rows])
  const watchedLinesByItem = Form.useWatch('linesByItem', form) || {}
  const itemOptions = useMemo(
    () => rows.filter((item) => !selectedItemIds.includes(item.item_id)).map((item) => ({ value: item.item_id, label: `${item.item_name} (${item.sku})` })),
    [rows, selectedItemIds],
  )

  const stockColumns = useMemo(() => {
    const warehouseColumns = warehouses.map((warehouse) => ({
      title: <div style={{ lineHeight: 1.2 }}><div>{warehouse.code}</div><div style={{ color: '#8c8c8c', fontSize: 12 }}>{warehouse.name}</div></div>,
      width: 110,
      align: 'right' as const,
      render: (_: any, row: ConsumableStockItem) => {
        const quantity = Number(row.stock_by_warehouse.find((item) => item.warehouse_id === warehouse.id)?.quantity || 0)
        return quantity > 0 ? quantity : <span style={{ color: '#bfbfbf' }}>0</span>
      },
    }))
    return [
      {
        title: '消耗品',
        width: 240,
        render: (_: any, row: ConsumableStockItem) => <div><div style={{ fontWeight: 500 }}>{row.item_name}</div><div style={{ marginTop: 4 }}><Tag>{row.sku}</Tag></div></div>,
      },
      { title: '单位', dataIndex: 'unit', width: 90, render: (value: string | null | undefined) => value || '-' },
      ...warehouseColumns,
      { title: '总库存', dataIndex: 'total_quantity', width: 100, align: 'right' as const },
    ]
  }, [warehouses])

  const selectedRows = useMemo(() => selectedItemIds.map((itemId) => itemMap.get(itemId)).filter(Boolean).map((item) => ({ ...item!, countedQuantity: Number(watchedLinesByItem?.[item!.item_id]?.counted_quantity || 0) })), [selectedItemIds, itemMap, watchedLinesByItem])

  function openStocktake(type: 'initial' | 'routine') {
    setStocktakeType(type)
    setSelectedItemIds([])
    setPendingItemIds([])
    form.resetFields()
    form.setFieldsValue({ warehouse_id: undefined, stocktake_date: dayjs(), note: '', linesByItem: {} })
    setStocktakeOpen(true)
  }

  function addItems() {
    if (!pendingItemIds.length) return message.warning('请先选择一个或多个消耗品')
    setSelectedItemIds((current) => Array.from(new Set([...current, ...pendingItemIds])))
    for (const itemId of pendingItemIds) {
      const item = itemMap.get(itemId)
      const currentWarehouseId = form.getFieldValue('warehouse_id')
      const warehouseStock = item?.stock_by_warehouse.find((entry) => entry.warehouse_id === currentWarehouseId)
      form.setFieldValue(['linesByItem', itemId, 'counted_quantity'], Number(warehouseStock?.quantity || 0))
    }
    setPendingItemIds([])
  }

  function removeItem(itemId: string) {
    setSelectedItemIds((current) => current.filter((id) => id !== itemId))
    form.setFieldValue(['linesByItem', itemId, 'counted_quantity'], undefined)
  }

  async function openDetail(id: string) {
    setDetailLoading(true)
    try {
      const data = await getJSON<StocktakeDetail>(`/inventory/stocktakes/${id}`)
      setDetail(data || null)
      setDetailOpen(true)
    } finally {
      setDetailLoading(false)
    }
  }

  async function submitStocktake() {
    setSubmitting(true)
    try {
      const values = await form.validateFields()
      const lines = selectedRows.map((item) => ({ item_id: item.item_id, counted_quantity: Number(values?.linesByItem?.[item.item_id]?.counted_quantity ?? 0) })).filter((line) => line.item_id)
      if (!lines.length) throw new Error('请至少填写一条盘点明细')
      await postJSON('/inventory/stocktakes', {
        warehouse_id: values.warehouse_id,
        category: 'consumable',
        stocktake_type: stocktakeType,
        stocktake_date: dayjs(values.stocktake_date).format('YYYY-MM-DD'),
        note: values.note || undefined,
        lines,
      })
      message.success(stocktakeType === 'initial' ? '初始化库存已保存' : '库存更新已保存')
      setStocktakeOpen(false)
      await load()
    } catch (e: any) {
      message.error(e?.message || '保存失败')
    } finally {
      setSubmitting(false)
    }
  }

  const warehouseOptions = useMemo(() => warehouses.filter((row) => row.active).map((row) => ({ value: row.id, label: `${row.code} - ${row.name}` })), [warehouses])
  const stocktakeEditorColumns: any[] = [
    { title: '消耗品', render: (_: any, row: any) => <div><div style={{ fontWeight: 500 }}>{row.item_name}</div><div style={{ color: '#8c8c8c', fontSize: 12 }}>{row.sku}</div></div> },
    { title: '单位', dataIndex: 'unit', width: 90, render: (value: string) => value || '-' },
    { title: '当前库存', width: 100, render: (_: any, row: ConsumableStockItem) => Number(row.stock_by_warehouse.find((entry) => entry.warehouse_id === String(form.getFieldValue('warehouse_id') || ''))?.quantity || 0) },
    { title: '盘点数量', width: 140, render: (_: any, row: any) => <Form.Item name={['linesByItem', row.item_id, 'counted_quantity']} style={{ marginBottom: 0 }}><InputNumber min={0} precision={0} style={{ width: '100%' }} /></Form.Item> },
    { title: '操作', width: 100, render: (_: any, row: any) => <Button danger onClick={() => removeItem(String(row.item_id))}>删除</Button> },
  ]

  return (
    <>
      <Card title="消耗品库存" extra={<Space><Button onClick={() => load().catch(() => {})}>刷新</Button><Button onClick={() => openStocktake('initial')}>初始化库存</Button><Button type="primary" icon={<PlusOutlined />} onClick={() => openStocktake('routine')}>库存更新</Button></Space>}>
        <Table rowKey={(row) => row.item_id} loading={loading} columns={stockColumns as any} dataSource={rows} pagination={{ pageSize: 20 }} scroll={{ x: 980 }} />
      </Card>

      <Card title="库存更新记录" style={{ marginTop: 16 }}>
        <Table
          rowKey={(row) => row.id}
          columns={[
            { title: '盘点日期', dataIndex: 'stocktake_date', width: 120 },
            { title: '仓库', render: (_: any, row: StocktakeRow) => `${row.warehouse_code} - ${row.warehouse_name}` },
            { title: '类型', dataIndex: 'stocktake_type', width: 100, render: (value: string) => value === 'initial' ? '初始化' : '库存更新' },
            { title: '物品数', dataIndex: 'line_count', width: 100 },
            { title: '盘点总数', dataIndex: 'counted_total', width: 100 },
            { title: '备注', dataIndex: 'note', render: (value: string | null | undefined) => value || '-' },
            { title: '操作', width: 100, render: (_: any, row: StocktakeRow) => <Button onClick={() => openDetail(row.id).catch(() => {})}>详情</Button> },
          ] as any}
          dataSource={stocktakeRows}
          pagination={false}
        />
      </Card>

      <Drawer title={stocktakeType === 'initial' ? '初始化消耗品库存' : '更新消耗品库存'} placement="right" width={860} open={stocktakeOpen} onClose={() => setStocktakeOpen(false)} extra={<Space><Button onClick={() => setStocktakeOpen(false)}>取消</Button><Button type="primary" loading={submitting} onClick={() => submitStocktake().catch(() => {})}>保存</Button></Space>}>
        <Form form={form} layout="vertical">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(220px, 1fr))', gap: 16 }}>
            <Form.Item name="warehouse_id" label="仓库" rules={[{ required: true, message: '请选择仓库' }]}><Select options={warehouseOptions} placeholder="请选择仓库" /></Form.Item>
            <Form.Item name="stocktake_date" label="盘点日期" rules={[{ required: true, message: '请选择盘点日期' }]}><DatePicker style={{ width: '100%' }} /></Form.Item>
            <Form.Item name="note" label="备注"><Input placeholder="可选" /></Form.Item>
          </div>

          <div style={{ padding: 16, border: '1px solid #f0f0f0', borderRadius: 12, background: '#fafafa', marginBottom: 16 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 12, alignItems: 'start' }}>
              <div>
                <div style={{ marginBottom: 8, fontWeight: 500 }}>盘点物品</div>
                <Select mode="multiple" showSearch value={pendingItemIds} onChange={(value) => setPendingItemIds((value || []).map((item) => String(item)))} options={itemOptions} placeholder="输入消耗品名称或 SKU 搜索，可多选" optionFilterProp="label" optionLabelProp="label" style={{ width: '100%' }} notFoundContent="没有可添加的消耗品" />
              </div>
              <div><div style={{ marginBottom: 8, fontWeight: 500, visibility: 'hidden' }}>操作</div><Button type="primary" onClick={addItems}>添加物品</Button></div>
            </div>
          </div>

          {selectedRows.length ? <Table rowKey="item_id" columns={stocktakeEditorColumns} dataSource={selectedRows} pagination={false} scroll={{ x: 760 }} /> : <div style={{ border: '1px dashed #d9d9d9', borderRadius: 12, padding: 32, background: '#fff' }}><Empty description="先选择消耗品，再填写盘点数量" /></div>}
        </Form>
      </Drawer>

      <Drawer title="库存更新详情" placement="right" width={760} open={detailOpen} onClose={() => setDetailOpen(false)}>
        {detailLoading ? null : detail ? (
          <div style={{ display: 'grid', gap: 16 }}>
            <Descriptions bordered column={1} size="small">
              <Descriptions.Item label="盘点日期">{detail.stocktake_date}</Descriptions.Item>
              <Descriptions.Item label="仓库">{`${detail.warehouse_code} - ${detail.warehouse_name}`}</Descriptions.Item>
              <Descriptions.Item label="类型">{detail.stocktake_type === 'initial' ? '初始化' : '库存更新'}</Descriptions.Item>
              <Descriptions.Item label="备注">{detail.note || '-'}</Descriptions.Item>
            </Descriptions>
            <Table rowKey={(row) => row.id} pagination={false} columns={[
              { title: '消耗品', dataIndex: 'item_name' },
              { title: 'SKU', dataIndex: 'item_sku', width: 140 },
              { title: '盘前库存', dataIndex: 'previous_quantity', width: 100 },
              { title: '盘点数量', dataIndex: 'counted_quantity', width: 100 },
              { title: '变化量', dataIndex: 'delta_quantity', width: 100 },
            ] as any} dataSource={detail.lines || []} />
          </div>
        ) : null}
      </Drawer>
    </>
  )
}
