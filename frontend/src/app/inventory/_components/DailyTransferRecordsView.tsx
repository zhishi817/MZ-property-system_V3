"use client"

import { ArrowLeftOutlined, PlusOutlined } from '@ant-design/icons'
import { App, Button, Card, DatePicker, Descriptions, Drawer, Empty, Form, Input, InputNumber, Select, Space, Table, Tag, Typography } from 'antd'
import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import dayjs, { type Dayjs } from 'dayjs'
import { getJSON, postJSON } from '../../../lib/api'

type Warehouse = { id: string; code: string; name: string; active: boolean }
type StockRow = {
  item_id: string
  quantity: number
  name: string
  sku: string
  category: string
  unit: string
}
type TransferRecordRow = {
  id: string
  created_at: string
  note?: string | null
  from_warehouse_id: string
  from_warehouse_code: string
  from_warehouse_name: string
  to_warehouse_id: string
  to_warehouse_code: string
  to_warehouse_name: string
  item_count: number
  quantity_total: number
  lines: Array<{
    item_id: string
    item_name: string
    item_sku: string
    quantity: number
  }>
}

type TransferRecordDetail = TransferRecordRow

function resolveSmWarehouse(rows: Warehouse[]) {
  return (rows || []).find((w) => {
    const id = String(w.id || '').trim().toLowerCase()
    const code = String(w.code || '').trim().toLowerCase()
    const name = String(w.name || '').trim().toLowerCase()
    return id === 'wh.south_melbourne' || code === 'sm' || code === 'sou' || name.includes('south melbourne') || name.includes('sm')
  }) || null
}

export default function DailyTransferRecordsView() {
  const { message } = App.useApp()
  const [form] = Form.useForm()
  const [rows, setRows] = useState<TransferRecordRow[]>([])
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [smStocks, setSmStocks] = useState<StockRow[]>([])
  const [selectedItemIds, setSelectedItemIds] = useState<string[]>([])
  const [pendingItemIds, setPendingItemIds] = useState<string[]>([])
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [detailOpen, setDetailOpen] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detail, setDetail] = useState<TransferRecordDetail | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [loading, setLoading] = useState(false)
  const [targetWarehouseId, setTargetWarehouseId] = useState('')
  const [dateRange, setDateRange] = useState<[Dayjs, Dayjs] | null>([dayjs().subtract(30, 'day'), dayjs()])

  const smWarehouse = useMemo(() => resolveSmWarehouse(warehouses), [warehouses])
  const watchedLinesByItem = Form.useWatch('linesByItem', form) || {}

  async function loadBase() {
    const ws = await getJSON<Warehouse[]>('/inventory/warehouses')
    const active = (ws || []).filter((row) => row.active)
    setWarehouses(active)
    const sm = resolveSmWarehouse(active)
    if (!sm) return
    const stockRows = await getJSON<StockRow[]>(`/inventory/stocks?${new URLSearchParams({ warehouse_id: sm.id, category: 'daily' }).toString()}`)
    setSmStocks((stockRows || []).filter((row) => Number(row.quantity || 0) > 0))
  }

  async function loadRecords() {
    setLoading(true)
    try {
      const params = new URLSearchParams({ category: 'daily' })
      if (targetWarehouseId) params.set('to_warehouse_id', targetWarehouseId)
      if (dateRange?.[0]) params.set('from', dateRange[0].startOf('day').toISOString())
      if (dateRange?.[1]) params.set('to', dateRange[1].endOf('day').toISOString())
      const data = await getJSON<TransferRecordRow[]>(`/inventory/transfer-records?${params.toString()}`)
      setRows(data || [])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadBase()
      .then(() => loadRecords())
      .catch((e) => message.error(e?.message || '加载失败'))
  }, [])

  const toWarehouseOptions = useMemo(
    () => (warehouses || [])
      .filter((row) => row.active && row.id !== smWarehouse?.id)
      .map((row) => ({ value: row.id, label: `${row.code} - ${row.name}` })),
    [warehouses, smWarehouse],
  )

  const itemMap = useMemo(() => new Map(smStocks.map((row) => [String(row.item_id), row])), [smStocks])
  const addItemOptions = useMemo(
    () => smStocks
      .filter((item) => !selectedItemIds.includes(item.item_id))
      .map((item) => ({
        value: item.item_id,
        label: `${item.name} (${item.sku})`,
      })),
    [smStocks, selectedItemIds],
  )

  const selectedRows = useMemo(() => {
    return selectedItemIds
      .map((itemId) => itemMap.get(itemId))
      .filter(Boolean)
      .map((item) => {
        const quantity = Number(watchedLinesByItem?.[item!.item_id]?.quantity || 0)
        return {
          ...item!,
          key: item!.item_id,
          transferQuantity: quantity,
        }
      })
  }, [selectedItemIds, itemMap, watchedLinesByItem])

  function resetEditor() {
    setSelectedItemIds([])
    setPendingItemIds([])
    form.resetFields()
    form.setFieldsValue({
      from_warehouse_id: smWarehouse?.id,
      to_warehouse_id: undefined,
      note: '',
      linesByItem: {},
    })
  }

  function openCreate() {
    resetEditor()
    setDrawerOpen(true)
  }

  function addItems() {
    if (!pendingItemIds.length) {
      message.warning('请先选择一个或多个日用品')
      return
    }
    setSelectedItemIds((current) => Array.from(new Set([...current, ...pendingItemIds])))
    const currentLines = form.getFieldValue('linesByItem') || {}
    for (const itemId of pendingItemIds) {
      if (!currentLines?.[itemId]) {
        form.setFieldValue(['linesByItem', itemId, 'quantity'], 1)
      }
    }
    setPendingItemIds([])
  }

  function removeItem(itemId: string) {
    setSelectedItemIds((current) => current.filter((id) => id !== itemId))
    form.setFieldValue(['linesByItem', itemId, 'quantity'], 0)
  }

  async function openDetail(id: string) {
    setDetailLoading(true)
    try {
      const data = await getJSON<TransferRecordDetail>(`/inventory/transfer-records/${id}`)
      setDetail(data || null)
      setDetailOpen(true)
    } finally {
      setDetailLoading(false)
    }
  }

  async function submit() {
    setSubmitting(true)
    try {
      const values = await form.validateFields()
      if (!smWarehouse?.id) throw new Error('未找到 SM 总仓')
      const lines = selectedRows
        .map((item) => ({
          item_id: item.item_id,
          quantity: Number(values?.linesByItem?.[item.item_id]?.quantity || 0),
        }))
        .filter((line) => Number(line.quantity || 0) > 0)
      if (!lines.length) throw new Error('请至少填写一条配送明细')

      await postJSON('/inventory/transfer-records', {
        from_warehouse_id: smWarehouse.id,
        to_warehouse_id: values.to_warehouse_id,
        note: values.note || undefined,
        lines,
      })
      message.success('日用品配送单已创建')
      setDrawerOpen(false)
      resetEditor()
      await Promise.all([loadBase(), loadRecords()])
    } catch (e: any) {
      message.error(e?.message || '创建失败')
    } finally {
      setSubmitting(false)
    }
  }

  const columns: any[] = [
    { title: '配送时间', dataIndex: 'created_at', width: 170, render: (value: string) => value ? dayjs(value).format('YYYY-MM-DD HH:mm') : '-' },
    { title: '来源仓', render: (_: any, row: TransferRecordRow) => `${row.from_warehouse_code} - ${row.from_warehouse_name}` },
    { title: '目标仓', render: (_: any, row: TransferRecordRow) => `${row.to_warehouse_code} - ${row.to_warehouse_name}` },
    {
      title: '日用品明细',
      render: (_: any, row: TransferRecordRow) => (
        <div style={{ display: 'grid', gap: 4 }}>
          {(row.lines || []).slice(0, 2).map((line) => (
            <div key={line.item_id}>{line.item_name} x {line.quantity}</div>
          ))}
          {(row.lines || []).length > 2 ? <Typography.Text type="secondary">还有 {(row.lines || []).length - 2} 项</Typography.Text> : null}
        </div>
      ),
    },
    { title: '总数量', dataIndex: 'quantity_total', width: 100 },
    { title: '备注', dataIndex: 'note', ellipsis: true, render: (value: string | null | undefined) => value || '-' },
    {
      title: '操作',
      width: 100,
      render: (_: any, row: TransferRecordRow) => <Button onClick={() => openDetail(row.id).catch((e) => message.error(e?.message || '加载详情失败'))}>详情</Button>,
    },
  ]

  const detailColumns: any[] = [
    { title: '日用品', dataIndex: 'item_name' },
    { title: 'SKU', dataIndex: 'item_sku', width: 160, render: (value: string) => value || '-' },
    { title: '配送数量', dataIndex: 'quantity', width: 100 },
  ]

  const editorColumns: any[] = [
    {
      title: '日用品',
      render: (_: any, row: any) => (
        <div>
          <div style={{ fontWeight: 500 }}>{row.name}</div>
          <div style={{ color: '#8c8c8c', fontSize: 12 }}>{row.sku}</div>
        </div>
      ),
    },
    { title: '单位', dataIndex: 'unit', width: 90, render: (value: string) => value || '-' },
    { title: 'SM 库存', dataIndex: 'quantity', width: 100 },
    {
      title: '配送数量',
      width: 140,
      render: (_: any, row: any) => (
        <Form.Item name={['linesByItem', row.item_id, 'quantity']} style={{ marginBottom: 0 }}>
          <InputNumber min={1} precision={0} max={Number(row.quantity || 0)} style={{ width: '100%' }} />
        </Form.Item>
      ),
    },
    {
      title: '操作',
      width: 100,
      render: (_: any, row: any) => <Button danger onClick={() => removeItem(String(row.item_id))}>删除</Button>,
    },
  ]

  return (
    <>
      <Card
        title="日用品配送记录"
        extra={
          <Space>
            <Button onClick={() => loadRecords().catch((e) => message.error(e?.message || '刷新失败'))}>刷新</Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新建配送单</Button>
          </Space>
        }
      >
        <Space wrap style={{ marginBottom: 16 }}>
          <DatePicker.RangePicker value={dateRange as any} onChange={(value) => setDateRange(value as [Dayjs, Dayjs] | null)} allowClear />
          <Select
            allowClear
            placeholder="目标仓"
            style={{ width: 220 }}
            value={targetWarehouseId || undefined}
            onChange={(value) => setTargetWarehouseId(String(value || ''))}
            options={toWarehouseOptions}
          />
          <Button type="primary" onClick={() => loadRecords().catch((e) => message.error(e?.message || '加载失败'))}>查询</Button>
        </Space>

        <Table rowKey="id" loading={loading} columns={columns} dataSource={rows} pagination={{ pageSize: 20 }} />
      </Card>

      <Drawer
        title="新建日用品配送单"
        placement="right"
        width={860}
        open={drawerOpen}
        onClose={() => { setDrawerOpen(false); resetEditor() }}
        extra={
          <Space>
            <Button onClick={() => { setDrawerOpen(false); resetEditor() }}>取消</Button>
            <Button type="primary" loading={submitting} onClick={() => submit().catch(() => {})}>保存配送单</Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(220px, 1fr))', gap: 16 }}>
            <Form.Item label="来源仓">
              <Input value={smWarehouse ? `${smWarehouse.code} - ${smWarehouse.name}` : ''} disabled />
            </Form.Item>
            <Form.Item name="to_warehouse_id" label="目标仓" rules={[{ required: true, message: '请选择目标仓' }]}>
              <Select options={toWarehouseOptions} placeholder="请选择目标仓" />
            </Form.Item>
          </div>

          <div style={{ padding: 16, border: '1px solid #f0f0f0', borderRadius: 12, background: '#fafafa', marginBottom: 16 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 12, alignItems: 'start' }}>
              <div>
                <div style={{ marginBottom: 8, fontWeight: 500 }}>配送物品</div>
                <Select
                  mode="multiple"
                  showSearch
                  value={pendingItemIds}
                  onChange={(value) => setPendingItemIds((value || []).map((item) => String(item)))}
                  options={addItemOptions}
                  placeholder="输入日用品名称或 SKU 搜索，可多选"
                  optionFilterProp="label"
                  optionLabelProp="label"
                  style={{ width: '100%' }}
                  notFoundContent="没有可添加的日用品"
                />
                <div style={{ marginTop: 6, color: '#8c8c8c', fontSize: 12 }}>
                  输入关键字后可多选日用品，再点“添加物品”统一加入配送单
                </div>
              </div>
              <div>
                <div style={{ marginBottom: 8, fontWeight: 500, visibility: 'hidden' }}>操作</div>
                <Button type="primary" onClick={addItems}>添加物品</Button>
              </div>
            </div>
            <div style={{ marginTop: 6, color: '#8c8c8c', fontSize: 12 }}>
              仅显示 SM 总仓当前有库存的日用品
            </div>
          </div>

          {selectedRows.length ? (
            <Table rowKey="item_id" columns={editorColumns} dataSource={selectedRows} pagination={false} scroll={{ x: 760 }} />
          ) : (
            <div style={{ border: '1px dashed #d9d9d9', borderRadius: 12, padding: 32, background: '#fff' }}>
              <Empty description="先选择日用品，再填写配送数量" />
            </div>
          )}

          <Form.Item name="note" label="备注" style={{ marginTop: 24 }}>
            <Input.TextArea rows={3} placeholder="可选" />
          </Form.Item>
        </Form>
      </Drawer>

      <Drawer
        title="配送详情"
        placement="right"
        width={720}
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
      >
        {detail ? (
          <div style={{ display: 'grid', gap: 16 }}>
            <Descriptions bordered column={1} size="small">
              <Descriptions.Item label="配送时间">{detail.created_at ? dayjs(detail.created_at).format('YYYY-MM-DD HH:mm') : '-'}</Descriptions.Item>
              <Descriptions.Item label="来源仓">{detail.from_warehouse_code} - {detail.from_warehouse_name}</Descriptions.Item>
              <Descriptions.Item label="目标仓">{detail.to_warehouse_code} - {detail.to_warehouse_name}</Descriptions.Item>
              <Descriptions.Item label="总数量">{detail.quantity_total}</Descriptions.Item>
              <Descriptions.Item label="备注">{detail.note || '-'}</Descriptions.Item>
            </Descriptions>
            <Table
              rowKey="item_id"
              loading={detailLoading}
              columns={detailColumns}
              dataSource={detail.lines || []}
              pagination={false}
            />
          </div>
        ) : (
          <Empty description="暂无详情" />
        )}
      </Drawer>
    </>
  )
}
