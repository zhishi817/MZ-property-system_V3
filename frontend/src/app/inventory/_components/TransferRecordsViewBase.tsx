"use client"

import { PlusOutlined } from '@ant-design/icons'
import { App, Button, Card, DatePicker, Descriptions, Drawer, Empty, Form, Input, InputNumber, Select, Space, Table, Tag, Typography } from 'antd'
import { useEffect, useMemo, useState } from 'react'
import dayjs, { type Dayjs } from 'dayjs'
import { getJSON, patchJSON, postJSON } from '../../../lib/api'

type Warehouse = { id: string; code: string; name: string; active: boolean }
type StockRow = { item_id: string; quantity: number; name: string; sku: string; category: string; unit: string }
type TransferLine = { item_id: string; item_name: string; item_sku: string; quantity: number; item_category?: string; key?: string; unit?: string; name?: string; sku?: string }
type TransferRecordRow = {
  id: string
  created_at: string
  updated_at?: string | null
  status: 'completed' | 'cancelled'
  note?: string | null
  cancelled_by?: string | null
  cancelled_at?: string | null
  from_warehouse_id: string
  from_warehouse_code: string
  from_warehouse_name: string
  to_warehouse_id: string
  to_warehouse_code: string
  to_warehouse_name: string
  item_count: number
  quantity_total: number
  lines: TransferLine[]
}

type Props = {
  category: 'daily' | 'consumable' | 'other'
  title: string
  itemLabel: string
}

function resolveSmWarehouse(rows: Warehouse[]) {
  return (rows || []).find((w) => {
    const id = String(w.id || '').trim().toLowerCase()
    const code = String(w.code || '').trim().toLowerCase()
    const name = String(w.name || '').trim().toLowerCase()
    return id === 'wh.south_melbourne' || code === 'sm' || code === 'sou' || name.includes('south melbourne') || name.includes('sm')
  }) || null
}

function statusTag(status: string) {
  return status === 'cancelled' ? <Tag color="red">已作废</Tag> : <Tag color="green">已完成</Tag>
}

export default function TransferRecordsViewBase({ category, title, itemLabel }: Props) {
  const { message, modal } = App.useApp()
  const [form] = Form.useForm()
  const [rows, setRows] = useState<TransferRecordRow[]>([])
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [smStocks, setSmStocks] = useState<StockRow[]>([])
  const [selectedItemIds, setSelectedItemIds] = useState<string[]>([])
  const [pendingItemIds, setPendingItemIds] = useState<string[]>([])
  const [editingOriginalQuantities, setEditingOriginalQuantities] = useState<Record<string, number>>({})
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [detailOpen, setDetailOpen] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detail, setDetail] = useState<TransferRecordRow | null>(null)
  const [editingId, setEditingId] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [loading, setLoading] = useState(false)
  const [cancellingId, setCancellingId] = useState('')
  const [targetWarehouseId, setTargetWarehouseId] = useState('')
  const [status, setStatus] = useState<'completed' | 'cancelled' | ''>('completed')
  const [dateRange, setDateRange] = useState<[Dayjs, Dayjs] | null>([dayjs().subtract(30, 'day'), dayjs()])

  const smWarehouse = useMemo(() => resolveSmWarehouse(warehouses), [warehouses])
  const watchedLinesByItem = Form.useWatch('linesByItem', form) || {}

  async function loadBase() {
    const ws = await getJSON<Warehouse[]>('/inventory/warehouses')
    const active = (ws || []).filter((row) => row.active)
    setWarehouses(active)
    const sm = resolveSmWarehouse(active)
    if (!sm) return
    const stockRows = await getJSON<StockRow[]>(`/inventory/stocks?${new URLSearchParams({ warehouse_id: sm.id, category }).toString()}`)
    setSmStocks((stockRows || []).filter((row) => Number(row.quantity || 0) > 0))
  }

  async function loadRecords() {
    setLoading(true)
    try {
      const params = new URLSearchParams({ category })
      if (targetWarehouseId) params.set('to_warehouse_id', targetWarehouseId)
      if (status) params.set('status', status)
      if (dateRange?.[0]) params.set('from', dateRange[0].startOf('day').toISOString())
      if (dateRange?.[1]) params.set('to', dateRange[1].endOf('day').toISOString())
      const data = await getJSON<TransferRecordRow[]>(`/inventory/transfer-records?${params.toString()}`)
      setRows(data || [])
      return data || []
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadBase().then(loadRecords).catch((e) => message.error(e?.message || '加载失败'))
  }, [])

  const toWarehouseOptions = useMemo(
    () => warehouses.filter((row) => row.active && row.id !== smWarehouse?.id).map((row) => ({ value: row.id, label: `${row.code} - ${row.name}` })),
    [warehouses, smWarehouse],
  )
  const itemMap = useMemo(() => new Map(smStocks.map((row) => [String(row.item_id), row])), [smStocks])
  const addItemOptions = useMemo(
    () => smStocks.filter((item) => !selectedItemIds.includes(item.item_id)).map((item) => ({ value: item.item_id, label: `${item.name} (${item.sku})` })),
    [smStocks, selectedItemIds],
  )
  const selectedRows = useMemo(
    () => selectedItemIds
      .map((itemId) => {
        const stock = itemMap.get(itemId)
        const originalQty = Number(editingOriginalQuantities[itemId] || 0)
        if (stock) return { ...stock, quantity: Number(stock.quantity || 0) + originalQty }
        return originalQty > 0 ? { item_id: itemId, quantity: originalQty, name: itemId, sku: '', category, unit: '' } : null
      })
      .filter(Boolean)
      .map((item) => ({ ...item!, key: item!.item_id, transferQuantity: Number((watchedLinesByItem || {})?.[item!.item_id]?.quantity || 0) })),
    [selectedItemIds, itemMap, watchedLinesByItem, editingOriginalQuantities, category],
  )

  function resetEditor() {
    setEditingId('')
    setSelectedItemIds([])
    setPendingItemIds([])
    setEditingOriginalQuantities({})
    form.resetFields()
    form.setFieldsValue({ from_warehouse_id: smWarehouse?.id, to_warehouse_id: undefined, note: '', linesByItem: {} })
  }

  function openCreate() {
    resetEditor()
    setDrawerOpen(true)
  }

  function addItems() {
    if (!pendingItemIds.length) return message.warning(`请先选择一个或多个${itemLabel}`)
    setSelectedItemIds((current) => Array.from(new Set([...current, ...pendingItemIds])))
    const currentLines = form.getFieldValue('linesByItem') || {}
    for (const itemId of pendingItemIds) {
      if (!currentLines?.[itemId]) form.setFieldValue(['linesByItem', itemId, 'quantity'], 1)
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
      const data = await getJSON<TransferRecordRow>(`/inventory/transfer-records/${id}`)
      setDetail(data || null)
      setDetailOpen(true)
      return data || null
    } finally {
      setDetailLoading(false)
    }
  }

  async function openEdit(id: string) {
    const data = await openDetail(id)
    if (!data) return
    setEditingId(id)
    const originalQuantities: Record<string, number> = {}
    setSelectedItemIds((data.lines || []).map((line) => String(line.item_id || '')))
    const linesByItem: Record<string, { quantity: number }> = {}
    for (const line of data.lines || []) {
      const itemId = String(line.item_id || '')
      linesByItem[itemId] = { quantity: Number(line.quantity || 0) }
      originalQuantities[itemId] = Number(line.quantity || 0)
    }
    setEditingOriginalQuantities(originalQuantities)
    form.setFieldsValue({
      from_warehouse_id: data.from_warehouse_id,
      to_warehouse_id: data.to_warehouse_id,
      note: data.note || '',
      linesByItem,
    })
    setDrawerOpen(true)
    setDetailOpen(false)
  }

  async function submit() {
    setSubmitting(true)
    try {
      const values = await form.validateFields()
      if (!smWarehouse?.id) throw new Error('未找到 SM 总仓')
      const lines = selectedRows
        .map((item) => ({ item_id: item.item_id, quantity: Number(values?.linesByItem?.[item.item_id]?.quantity || 0) }))
        .filter((line) => Number(line.quantity || 0) > 0)
      if (!lines.length) throw new Error('请至少填写一条配送明细')
      const payload = {
        from_warehouse_id: smWarehouse.id,
        to_warehouse_id: values.to_warehouse_id,
        note: values.note || undefined,
        lines,
      }
      if (editingId) {
        await patchJSON(`/inventory/transfer-records/${editingId}`, payload)
        message.success(`${itemLabel}配送单已更新`)
      } else {
        await postJSON('/inventory/transfer-records', payload)
        message.success(`${itemLabel}配送单已创建`)
      }
      setDrawerOpen(false)
      resetEditor()
      await Promise.all([loadBase(), loadRecords()])
    } catch (e: any) {
      message.error(e?.message || (editingId ? '更新失败' : '创建失败'))
    } finally {
      setSubmitting(false)
    }
  }

  function applyCancelledRecordLocally(recordId: string, response?: TransferRecordRow | null) {
    setRows((current) => {
      const next = current.map((row) => row.id === recordId ? { ...row, status: 'cancelled', cancelled_at: response?.cancelled_at || dayjs().toISOString(), updated_at: response?.updated_at || dayjs().toISOString() } : row)
      return status === 'completed' ? next.filter((row) => row.id !== recordId) : next
    })
    setDetail((current) => current && current.id === recordId ? { ...current, status: 'cancelled', cancelled_at: response?.cancelled_at || dayjs().toISOString(), updated_at: response?.updated_at || dayjs().toISOString() } : current)
  }

  async function cancelRecord(row: TransferRecordRow) {
    modal.confirm({
      title: '确认作废这张配送单？',
      content: `作废后会回滚 ${row.from_warehouse_code} -> ${row.to_warehouse_code} 的库存影响。`,
      okText: '确认作废',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: async () => {
        if (cancellingId === row.id) return
        setCancellingId(row.id)
        try {
          const response = await postJSON<TransferRecordRow>(`/inventory/transfer-records/${row.id}/cancel`, {})
          applyCancelledRecordLocally(row.id, response)
          message.success('配送单已作废')
        } catch (e: any) {
          message.error(e?.message || '作废失败')
        } finally {
          setCancellingId('')
        }
      },
    })
  }

  const columns: any[] = [
    { title: '配送时间', dataIndex: 'created_at', width: 170, render: (value: string) => value ? dayjs(value).format('YYYY-MM-DD HH:mm') : '-' },
    { title: '来源仓', render: (_: any, row: TransferRecordRow) => `${row.from_warehouse_code} - ${row.from_warehouse_name}` },
    { title: '目标仓', render: (_: any, row: TransferRecordRow) => `${row.to_warehouse_code} - ${row.to_warehouse_name}` },
    { title: '状态', dataIndex: 'status', width: 100, render: (value: string) => statusTag(value) },
    {
      title: `${itemLabel}明细`,
      render: (_: any, row: TransferRecordRow) => (
        <div style={{ display: 'grid', gap: 4 }}>
          {(row.lines || []).slice(0, 2).map((line) => <div key={line.item_id}>{line.item_name} x {line.quantity}</div>)}
          {(row.lines || []).length > 2 ? <Typography.Text type="secondary">还有 {(row.lines || []).length - 2} 项</Typography.Text> : null}
        </div>
      ),
    },
    { title: '总数量', dataIndex: 'quantity_total', width: 100 },
    { title: '备注', dataIndex: 'note', ellipsis: true, render: (value: string | null | undefined) => value || '-' },
    {
      title: '操作',
      width: 220,
      render: (_: any, row: TransferRecordRow) => (
        <Space>
          <Button onClick={() => openDetail(row.id).catch((e) => message.error(e?.message || '加载详情失败'))}>详情</Button>
          <Button disabled={row.status !== 'completed'} onClick={() => openEdit(row.id).catch((e) => message.error(e?.message || '加载编辑数据失败'))}>编辑</Button>
          <Button danger loading={cancellingId === row.id} disabled={row.status !== 'completed'} onClick={() => cancelRecord(row).catch((e) => message.error(e?.message || '作废失败'))}>作废</Button>
        </Space>
      ),
    },
  ]

  return (
    <>
      <Card title={title} extra={<Space><Button onClick={() => loadRecords().catch((e) => message.error(e?.message || '刷新失败'))}>刷新</Button><Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新建配送单</Button></Space>}>
        <Space wrap style={{ marginBottom: 16 }}>
          <DatePicker.RangePicker value={dateRange as any} onChange={(value) => setDateRange(value as [Dayjs, Dayjs] | null)} allowClear />
          <Select allowClear placeholder="目标仓" style={{ width: 220 }} value={targetWarehouseId || undefined} onChange={(value) => setTargetWarehouseId(String(value || ''))} options={toWarehouseOptions} />
          <Select allowClear placeholder="状态" style={{ width: 160 }} value={status || undefined} onChange={(value) => setStatus((value || '') as any)} options={[{ value: 'completed', label: '已完成' }, { value: 'cancelled', label: '已作废' }]} />
          <Button type="primary" onClick={() => loadRecords().catch((e) => message.error(e?.message || '加载失败'))}>查询</Button>
          <Button onClick={() => { setDateRange([dayjs().subtract(30, 'day'), dayjs()]); setTargetWarehouseId(''); setStatus('completed') }}>重置</Button>
        </Space>
        <Table rowKey="id" loading={loading} columns={columns} dataSource={rows} pagination={{ pageSize: 20 }} />
      </Card>

      <Drawer title={editingId ? `编辑${itemLabel}配送单` : `新建${itemLabel}配送单`} placement="right" width={550} open={drawerOpen} onClose={() => { if (!submitting) { setDrawerOpen(false); resetEditor() } }} extra={<Space><Button onClick={() => { setDrawerOpen(false); resetEditor() }}>取消</Button><Button type="primary" loading={submitting} onClick={() => submit().catch(() => {})}>{editingId ? '保存修改' : '保存配送单'}</Button></Space>}>
        <Form form={form} layout="vertical">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(220px, 1fr))', gap: 16 }}>
            <Form.Item label="来源仓"><Input value={smWarehouse ? `${smWarehouse.code} - ${smWarehouse.name}` : ''} disabled /></Form.Item>
            <Form.Item name="to_warehouse_id" label="目标仓" rules={[{ required: true, message: '请选择目标仓' }]}><Select options={toWarehouseOptions} placeholder="请选择目标仓" /></Form.Item>
          </div>

          <div style={{ padding: 16, border: '1px solid #f0f0f0', borderRadius: 12, background: '#fafafa', marginBottom: 16 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 12, alignItems: 'start' }}>
              <div>
                <div style={{ marginBottom: 8, fontWeight: 500 }}>配送物品</div>
                <Select mode="multiple" showSearch value={pendingItemIds} onChange={(value) => setPendingItemIds((value || []).map((item) => String(item)))} options={addItemOptions} placeholder={`输入${itemLabel}名称或 SKU 搜索，可多选`} optionFilterProp="label" optionLabelProp="label" style={{ width: '100%' }} notFoundContent={`没有可添加的${itemLabel}`} />
                <div style={{ marginTop: 6, color: '#8c8c8c', fontSize: 12 }}>输入关键字后可多选{itemLabel}，再点“添加物品”统一加入配送单</div>
              </div>
              <div><div style={{ marginBottom: 8, fontWeight: 500, visibility: 'hidden' }}>操作</div><Button type="primary" onClick={addItems}>添加物品</Button></div>
            </div>
            <div style={{ marginTop: 6, color: '#8c8c8c', fontSize: 12 }}>仅显示 SM 总仓当前有库存的{itemLabel}</div>
          </div>

          {selectedRows.length ? (
            <Table
              rowKey="item_id"
              pagination={false}
              scroll={{ x: 760 }}
              dataSource={selectedRows}
              columns={[
                { title: itemLabel, render: (_: any, row: any) => <div><div style={{ fontWeight: 500 }}>{row.name}</div><div style={{ color: '#8c8c8c', fontSize: 12 }}>{row.sku}</div></div> },
                { title: '单位', dataIndex: 'unit', width: 90, render: (value: string) => value || '-' },
                { title: 'SM 库存', dataIndex: 'quantity', width: 100 },
                { title: '配送数量', width: 140, render: (_: any, row: any) => <Form.Item name={['linesByItem', row.item_id, 'quantity']} style={{ marginBottom: 0 }}><InputNumber min={1} precision={0} max={Number(row.quantity || 0)} style={{ width: '100%' }} /></Form.Item> },
                { title: '操作', width: 100, render: (_: any, row: any) => <Button danger onClick={() => removeItem(String(row.item_id))}>删除</Button> },
              ] as any}
            />
          ) : (
            <div style={{ border: '1px dashed #d9d9d9', borderRadius: 12, padding: 32, background: '#fff' }}>
              <Empty description={`先选择${itemLabel}，再填写配送数量`} />
            </div>
          )}

          <Form.Item name="note" label="备注" style={{ marginTop: 24 }}><Input.TextArea rows={3} placeholder="可选" /></Form.Item>
        </Form>
      </Drawer>

      <Drawer title="配送记录详情" placement="right" width={550} open={detailOpen} onClose={() => setDetailOpen(false)}>
        {detailLoading ? <Typography.Text>加载中...</Typography.Text> : detail ? (
          <div style={{ display: 'grid', gap: 16 }}>
            <Descriptions bordered column={1} size="small">
              <Descriptions.Item label="配送时间">{detail.created_at ? dayjs(detail.created_at).format('YYYY-MM-DD HH:mm') : '-'}</Descriptions.Item>
              <Descriptions.Item label="状态">{statusTag(detail.status)}</Descriptions.Item>
              <Descriptions.Item label="来源仓">{`${detail.from_warehouse_code} - ${detail.from_warehouse_name}`}</Descriptions.Item>
              <Descriptions.Item label="目标仓">{`${detail.to_warehouse_code} - ${detail.to_warehouse_name}`}</Descriptions.Item>
              <Descriptions.Item label="作废时间">{detail.cancelled_at ? dayjs(detail.cancelled_at).format('YYYY-MM-DD HH:mm') : '-'}</Descriptions.Item>
              <Descriptions.Item label="备注">{detail.note || '-'}</Descriptions.Item>
            </Descriptions>
            <Table rowKey={(row) => `${row.item_id}-${row.quantity}`} pagination={false} columns={[{ title: itemLabel, dataIndex: 'item_name' }, { title: 'SKU', dataIndex: 'item_sku', width: 160 }, { title: '配送数量', dataIndex: 'quantity', width: 100 }] as any} dataSource={detail.lines || []} />
          </div>
        ) : <Empty description="暂无详情" />}
      </Drawer>
    </>
  )
}
