"use client"

import { App, Button, Card, DatePicker, Descriptions, Drawer, Empty, Form, Input, InputNumber, Select, Space, Table, Tag, Typography, message } from 'antd'
import { PlusOutlined } from '@ant-design/icons'
import { useEffect, useMemo, useState } from 'react'
import dayjs from 'dayjs'
import { getJSON, postJSON } from '../../../lib/api'

type Warehouse = { id: string; code: string; name: string; active: boolean }
type DailyStockItem = {
  id: string
  item_id: string
  category?: string | null
  item_name: string
  sku: string
  unit?: string | null
  default_quantity?: number | null
  unit_price: number
  currency?: string | null
  stock_by_warehouse: Array<{ warehouse_id: string; quantity: number }>
  total_quantity: number
}

type DailyStockOverview = {
  warehouses: Warehouse[]
  items: DailyStockItem[]
}

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
  lines: Array<{
    id: string
    item_id: string
    item_name: string
    item_sku: string
    item_unit?: string | null
    previous_quantity: number
    counted_quantity: number
    delta_quantity: number
  }>
}

const DAILY_CATEGORY_ORDER: Record<string, number> = {
  '卧室': 1,
  '厨房': 2,
  '卫生间': 3,
  '其他': 4,
}

function sortDailyStockItems(rows: DailyStockItem[]) {
  return [...(rows || [])].sort((a, b) => {
    const orderA = DAILY_CATEGORY_ORDER[String(a.category || '').trim()] ?? 99
    const orderB = DAILY_CATEGORY_ORDER[String(b.category || '').trim()] ?? 99
    if (orderA !== orderB) return orderA - orderB
    return String(a.item_name || '').localeCompare(String(b.item_name || ''), 'zh')
  })
}

export default function DailyStocksView() {
  const { message } = App.useApp()
  const [loading, setLoading] = useState(false)
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [rows, setRows] = useState<DailyStockItem[]>([])
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
      const [data, stocktakes] = await Promise.all([
        getJSON<DailyStockOverview>('/inventory/daily-stock-overview'),
        getJSON<StocktakeRow[]>('/inventory/stocktakes?category=daily&limit=10'),
      ])
      setWarehouses(data?.warehouses || [])
      setRows(sortDailyStockItems(data?.items || []))
      setStocktakeRows(stocktakes || [])
    } catch (e: any) {
      message.error(e?.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load().catch(() => {})
  }, [])

  const itemMap = useMemo(() => new Map(rows.map((row) => [String(row.item_id), row])), [rows])
  const watchedLinesByItem = Form.useWatch('linesByItem', form) || {}

  const itemOptions = useMemo(
    () => rows
      .filter((item) => !selectedItemIds.includes(item.item_id))
      .map((item) => ({
        value: item.item_id,
        label: `${item.item_name} (${item.sku})`,
      })),
    [rows, selectedItemIds],
  )

  const stockColumns = useMemo(() => {
    const warehouseColumns = warehouses.map((warehouse) => ({
      title: (
        <div style={{ lineHeight: 1.2 }}>
          <div>{warehouse.code}</div>
          <div style={{ color: '#8c8c8c', fontSize: 12 }}>{warehouse.name}</div>
        </div>
      ),
      width: 110,
      align: 'right' as const,
      render: (_: any, row: DailyStockItem) => {
        const quantity = Number(row.stock_by_warehouse.find((item) => item.warehouse_id === warehouse.id)?.quantity || 0)
        return quantity > 0 ? quantity : <span style={{ color: '#bfbfbf' }}>0</span>
      },
    }))
    return [
      {
        title: '日用品',
        width: 240,
        render: (_: any, row: DailyStockItem) => (
          <div>
            <div style={{ fontWeight: 500 }}>{row.item_name}</div>
            <div style={{ marginTop: 4 }}>
              <Tag>{row.sku}</Tag>
            </div>
          </div>
        ),
      },
      { title: '分类', dataIndex: 'category', width: 110, render: (value: string | null | undefined) => value || '-' },
      { title: '单位', dataIndex: 'unit', width: 90, render: (value: string | null | undefined) => value || '-' },
      ...warehouseColumns,
      { title: '总库存', dataIndex: 'total_quantity', width: 100, align: 'right' as const },
    ]
  }, [warehouses])

  const selectedRows = useMemo(() => {
    return selectedItemIds
      .map((itemId) => itemMap.get(itemId))
      .filter(Boolean)
      .map((item) => ({
        ...item!,
        countedQuantity: Number(watchedLinesByItem?.[item!.item_id]?.counted_quantity || 0),
      }))
  }, [selectedItemIds, itemMap, watchedLinesByItem])

  function openStocktake(type: 'initial' | 'routine') {
    setStocktakeType(type)
    setSelectedItemIds([])
    setPendingItemIds([])
    form.resetFields()
    form.setFieldsValue({
      warehouse_id: undefined,
      stocktake_date: dayjs(),
      note: '',
      linesByItem: {},
    })
    setStocktakeOpen(true)
  }

  function addItems() {
    if (!pendingItemIds.length) {
      message.warning('请先选择一个或多个日用品')
      return
    }
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
      const lines = selectedRows
        .map((item) => ({
          item_id: item.item_id,
          counted_quantity: Number(values?.linesByItem?.[item.item_id]?.counted_quantity ?? 0),
        }))
        .filter((line) => line.item_id)
      if (!lines.length) throw new Error('请至少填写一条盘点明细')

      await postJSON('/inventory/stocktakes', {
        warehouse_id: values.warehouse_id,
        category: 'daily',
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

  const warehouseOptions = useMemo(
    () => (warehouses || []).filter((row) => row.active).map((row) => ({ value: row.id, label: `${row.code} - ${row.name}` })),
    [warehouses],
  )

  const stocktakeEditorColumns: any[] = [
    {
      title: '日用品',
      render: (_: any, row: any) => (
        <div>
          <div style={{ fontWeight: 500 }}>{row.item_name}</div>
          <div style={{ color: '#8c8c8c', fontSize: 12 }}>{row.sku}</div>
        </div>
      ),
    },
    { title: '单位', dataIndex: 'unit', width: 90, render: (value: string) => value || '-' },
    {
      title: '当前库存',
      width: 100,
      render: (_: any, row: DailyStockItem) => {
        const warehouseId = String(form.getFieldValue('warehouse_id') || '')
        const current = row.stock_by_warehouse.find((entry) => entry.warehouse_id === warehouseId)
        return Number(current?.quantity || 0)
      },
    },
    {
      title: '盘点数量',
      width: 140,
      render: (_: any, row: any) => (
        <Form.Item name={['linesByItem', row.item_id, 'counted_quantity']} style={{ marginBottom: 0 }}>
          <InputNumber min={0} precision={0} style={{ width: '100%' }} />
        </Form.Item>
      ),
    },
    {
      title: '操作',
      width: 100,
      render: (_: any, row: any) => <Button danger onClick={() => removeItem(String(row.item_id))}>删除</Button>,
    },
  ]

  const stocktakeRecordColumns: any[] = [
    { title: '盘点日期', dataIndex: 'stocktake_date', width: 120 },
    { title: '仓库', render: (_: any, row: StocktakeRow) => `${row.warehouse_code} - ${row.warehouse_name}` },
    { title: '类型', dataIndex: 'stocktake_type', width: 120, render: (value: string) => value === 'initial' ? <Tag color="blue">初始化</Tag> : <Tag color="green">定期更新</Tag> },
    { title: '物品数', dataIndex: 'line_count', width: 90 },
    { title: '盘点总数', dataIndex: 'counted_total', width: 100 },
    { title: '备注', dataIndex: 'note', ellipsis: true, render: (value: string | null | undefined) => value || '-' },
    { title: '时间', dataIndex: 'created_at', width: 170, render: (value: string) => value ? dayjs(value).format('YYYY-MM-DD HH:mm') : '-' },
    { title: '操作', width: 100, render: (_: any, row: StocktakeRow) => <Button onClick={() => openDetail(row.id).catch((e) => message.error(e?.message || '加载详情失败'))}>详情</Button> },
  ]

  const detailColumns: any[] = [
    { title: '日用品', dataIndex: 'item_name' },
    { title: 'SKU', dataIndex: 'item_sku', width: 160, render: (value: string) => value || '-' },
    { title: '盘前库存', dataIndex: 'previous_quantity', width: 100 },
    { title: '盘点数量', dataIndex: 'counted_quantity', width: 100 },
    { title: '变化量', dataIndex: 'delta_quantity', width: 100, render: (value: number) => value > 0 ? `+${value}` : value },
  ]

  return (
    <>
      <Card
        title="日用品库存"
        extra={
          <Space>
            <Button onClick={() => openStocktake('initial')} icon={<PlusOutlined />}>初始化库存</Button>
            <Button type="primary" onClick={() => openStocktake('routine')}>库存更新</Button>
            <Button onClick={() => load().catch(() => {})}>刷新</Button>
          </Space>
        }
      >
        <Table rowKey={(row) => row.id} loading={loading} columns={stockColumns as any} dataSource={rows} pagination={{ pageSize: 20 }} scroll={{ x: 960 }} />
      </Card>

      <Card title="最近库存清点记录" style={{ marginTop: 16 }}>
        <Table rowKey="id" loading={loading} columns={stocktakeRecordColumns} dataSource={stocktakeRows} pagination={false} locale={{ emptyText: '暂无清点记录' }} />
      </Card>

      <Drawer
        title={stocktakeType === 'initial' ? '初始化库存清点' : '定期库存更新'}
        placement="right"
        width={860}
        open={stocktakeOpen}
        onClose={() => setStocktakeOpen(false)}
        extra={
          <Space>
            <Button onClick={() => setStocktakeOpen(false)}>取消</Button>
            <Button type="primary" loading={submitting} onClick={() => submitStocktake().catch(() => {})}>保存</Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(220px, 1fr))', gap: 16 }}>
            <Form.Item name="warehouse_id" label="盘点仓库" rules={[{ required: true, message: '请选择盘点仓库' }]}>
              <Select options={warehouseOptions} placeholder="请选择盘点仓库" />
            </Form.Item>
            <Form.Item name="stocktake_date" label="盘点日期" rules={[{ required: true, message: '请选择盘点日期' }]}>
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
          </div>

          <div style={{ padding: 16, border: '1px solid #f0f0f0', borderRadius: 12, background: '#fafafa', marginBottom: 16 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 12, alignItems: 'start' }}>
              <div>
                <div style={{ marginBottom: 8, fontWeight: 500 }}>盘点物品</div>
                <Select
                  mode="multiple"
                  showSearch
                  value={pendingItemIds}
                  onChange={(value) => setPendingItemIds((value || []).map((item) => String(item)))}
                  options={itemOptions}
                  placeholder="输入日用品名称或 SKU 搜索，可多选"
                  optionFilterProp="label"
                  optionLabelProp="label"
                  style={{ width: '100%' }}
                  notFoundContent="没有可添加的日用品"
                />
                <div style={{ marginTop: 6, color: '#8c8c8c', fontSize: 12 }}>
                  输入关键字后可多选日用品，再点“添加物品”统一加入本次清点
                </div>
              </div>
              <div>
                <div style={{ marginBottom: 8, fontWeight: 500, visibility: 'hidden' }}>操作</div>
                <Button type="primary" onClick={addItems}>添加物品</Button>
              </div>
            </div>
          </div>

          {selectedRows.length ? (
            <Table rowKey="item_id" columns={stocktakeEditorColumns} dataSource={selectedRows} pagination={false} scroll={{ x: 760 }} />
          ) : (
            <div style={{ border: '1px dashed #d9d9d9', borderRadius: 12, padding: 32, background: '#fff' }}>
              <Empty description="先选择日用品，再填写盘点数量" />
            </div>
          )}

          <Form.Item name="note" label="备注" style={{ marginTop: 24 }}>
            <Input.TextArea rows={3} placeholder={stocktakeType === 'initial' ? '可填写初始化来源或说明' : '可填写本次盘点说明'} />
          </Form.Item>
        </Form>
      </Drawer>

      <Drawer
        title="库存清点详情"
        placement="right"
        width={760}
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
      >
        {detail ? (
          <div style={{ display: 'grid', gap: 16 }}>
            <Descriptions bordered column={1} size="small">
              <Descriptions.Item label="盘点日期">{detail.stocktake_date}</Descriptions.Item>
              <Descriptions.Item label="仓库">{detail.warehouse_code} - {detail.warehouse_name}</Descriptions.Item>
              <Descriptions.Item label="类型">{detail.stocktake_type === 'initial' ? '初始化库存' : '定期库存更新'}</Descriptions.Item>
              <Descriptions.Item label="备注">{detail.note || '-'}</Descriptions.Item>
              <Descriptions.Item label="创建时间">{detail.created_at ? dayjs(detail.created_at).format('YYYY-MM-DD HH:mm') : '-'}</Descriptions.Item>
            </Descriptions>
            <Table rowKey="id" loading={detailLoading} columns={detailColumns} dataSource={detail.lines || []} pagination={false} />
          </div>
        ) : (
          <Empty description="暂无详情" />
        )}
      </Drawer>
    </>
  )
}
