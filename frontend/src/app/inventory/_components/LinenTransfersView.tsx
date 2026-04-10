"use client"

import { App, Button, Card, DatePicker, Descriptions, Divider, Drawer, Form, Input, InputNumber, Select, Space, Table, Tag, Typography } from 'antd'
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons'
import { useEffect, useMemo, useRef, useState } from 'react'
import dayjs, { type Dayjs } from 'dayjs'
import { getApiFailureKind, getJSON, patchJSON, postJSON } from '../../../lib/api'

type Warehouse = { id: string; code: string; name: string; active: boolean; stocktake_enabled?: boolean }
type RoomType = { code: string; name: string; sort_order: number; active: boolean }
type LinenType = { code: string; name: string; sort_order?: number; active?: boolean }

type LinenDeliveryRecord = {
  id: string
  delivery_date: string
  from_warehouse_id: string
  from_warehouse_code: string
  from_warehouse_name: string
  to_warehouse_id: string
  to_warehouse_code: string
  to_warehouse_name: string
  status: 'completed' | 'cancelled'
  total_sets: number
  room_type_count: number
  extra_linen_total?: number
  note?: string | null
  dirty_bag_note?: string | null
  created_by?: string | null
  created_at?: string
  updated_at?: string | null
  cancelled_by?: string | null
  cancelled_at?: string | null
}

type LinenDeliveryRecordLineBreakdown = {
  linen_type_code: string
  item_id: string
  item_name: string
  item_sku: string
  quantity_per_set: number
  quantity_total: number
}

type LinenDeliveryRecordLine = {
  id: string
  record_id: string
  room_type_code: string
  room_type_name: string
  sets: number
  breakdown: LinenDeliveryRecordLineBreakdown[]
}

type LinenDeliveryRecordDetail = LinenDeliveryRecord & {
  lines: LinenDeliveryRecordLine[]
  extra_lines: Array<{
    id: string
    record_id: string
    linen_type_code: string
    linen_type_name: string
    quantity: number
    breakdown: LinenDeliveryRecordLineBreakdown[]
  }>
  stocktake?: {
    id: string
    warehouse_id: string
    warehouse_code: string
    warehouse_name: string
    stocktake_date: string
    dirty_bag_note?: string | null
    note?: string | null
    created_at?: string | null
    updated_at?: string | null
    lines: Array<{
      id: string
      record_id: string
      room_type_code: string
      room_type_name: string
      remaining_sets: number
    }>
  } | null
  breakdown_summary: Array<{
    linen_type_code: string
    item_id: string
    item_name: string
    item_sku: string
    quantity_total: number
  }>
}

type DeliveryEditorValues = {
  delivery_date: Dayjs
  from_warehouse_id: string
  to_warehouse_id: string
  note?: string
  dirty_bag_note?: string
  lines: Array<{
    room_type_code?: string
    sets?: number
  }>
  extra_linen_lines: Array<{
    linen_type_code?: string
    quantity?: number
  }>
  stocktake_lines: Array<{
    room_type_code?: string
    remaining_sets?: number
  }>
}

type DeliverySaveResponse = {
  id: string
  delivery_date: string
  status: string
  created_at?: string | null
  updated_at?: string | null
  cancelled_by?: string | null
  cancelled_at?: string | null
  deduped?: boolean
  details_degraded?: boolean
  trace_id?: string
}

const DEFAULT_RANGE: [Dayjs, Dayjs] = [dayjs().subtract(30, 'day'), dayjs()]

function statusTag(status: string) {
  if (status === 'cancelled') return <Tag color="red">已作废</Tag>
  return <Tag color="green">已完成</Tag>
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export default function LinenTransfersView() {
  const { message, modal } = App.useApp()
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [roomTypes, setRoomTypes] = useState<RoomType[]>([])
  const [linenTypes, setLinenTypes] = useState<LinenType[]>([])
  const [records, setRecords] = useState<LinenDeliveryRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [cancellingId, setCancellingId] = useState('')
  const [editorOpen, setEditorOpen] = useState(false)
  const [detailOpen, setDetailOpen] = useState(false)
  const [editingRecordId, setEditingRecordId] = useState<string>('')
  const [detail, setDetail] = useState<LinenDeliveryRecordDetail | null>(null)
  const [dateRange, setDateRange] = useState<[Dayjs, Dayjs] | null>(DEFAULT_RANGE)
  const [fromWarehouseId, setFromWarehouseId] = useState('')
  const [toWarehouseId, setToWarehouseId] = useState('')
  const [status, setStatus] = useState<'completed' | 'cancelled' | ''>('completed')
  const [editorForm] = Form.useForm<DeliveryEditorValues>()
  const submitLockRef = useRef(false)

  const warehouseOptions = useMemo(
    () => (warehouses || []).filter((item) => item.active).map((item) => ({ value: item.id, label: `${item.code} - ${item.name}` })),
    [warehouses],
  )
  const stocktakeWarehouseOptions = useMemo(
    () => (warehouses || [])
      .filter((item) => item.active && item.stocktake_enabled !== false)
      .map((item) => ({ value: item.id, label: `${item.code} - ${item.name}` })),
    [warehouses],
  )
  const roomTypeOptions = useMemo(
    () => (roomTypes || []).filter((item) => item.active).map((item) => ({ value: item.code, label: item.name })),
    [roomTypes],
  )
  const linenTypeOptions = useMemo(
    () => (linenTypes || []).filter((item) => item.active !== false).map((item) => ({ value: item.code, label: item.name })),
    [linenTypes],
  )
  const smWarehouseId = useMemo(() => {
    const hit = (warehouses || []).find((item) => {
      const id = String(item.id || '').trim().toLowerCase()
      const code = String(item.code || '').trim().toLowerCase()
      const name = String(item.name || '').trim().toLowerCase()
      return id === 'wh.south_melbourne' || code === 'sm' || code === 'sou' || name.includes('south melbourne')
    })
    return String(hit?.id || '')
  }, [warehouses])

  async function loadBase() {
    const [warehouseRows, roomTypeRows, linenTypeRows] = await Promise.all([
      getJSON<Warehouse[]>('/inventory/warehouses'),
      getJSON<RoomType[]>('/inventory/room-types'),
      getJSON<LinenType[]>('/inventory/linen-types'),
    ])
    setWarehouses((warehouseRows || []).filter((item) => item.active))
    setRoomTypes((roomTypeRows || []).filter((item) => item.active).sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0)))
    setLinenTypes((linenTypeRows || []).filter((item) => item.active !== false).sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0)))
  }

  async function loadRecords() {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (dateRange?.[0]) params.set('date_from', dateRange[0].format('YYYY-MM-DD'))
      if (dateRange?.[1]) params.set('date_to', dateRange[1].format('YYYY-MM-DD'))
      if (fromWarehouseId) params.set('from_warehouse_id', fromWarehouseId)
      if (toWarehouseId) params.set('to_warehouse_id', toWarehouseId)
      if (status) params.set('status', status)
      const data = await getJSON<LinenDeliveryRecord[]>(`/inventory/linen/delivery-records?${params.toString()}`)
      setRecords(data || [])
      return data || []
    } finally {
      setLoading(false)
    }
  }

  async function loadDetail(id: string, open = true) {
    setDetailLoading(true)
    if (open) {
      setDetail(null)
      setDetailOpen(true)
    }
    try {
      const data = await getJSON<LinenDeliveryRecordDetail>(`/inventory/linen/delivery-records/${id}`)
      setDetail(data || null)
      return data
    } finally {
      setDetailLoading(false)
    }
  }

  function fillEditorFromDetail(current: LinenDeliveryRecordDetail) {
    setEditingRecordId(current.id)
    editorForm.setFieldsValue({
      delivery_date: current.delivery_date ? dayjs(current.delivery_date) : dayjs(),
      from_warehouse_id: current.from_warehouse_id,
      to_warehouse_id: current.to_warehouse_id,
      note: current.note || '',
      dirty_bag_note: current.stocktake?.dirty_bag_note || current.dirty_bag_note || '',
      lines: (current.lines || []).map((line) => ({
        room_type_code: line.room_type_code,
        sets: line.sets,
      })),
      extra_linen_lines: (current.extra_lines || []).map((line) => ({
        linen_type_code: line.linen_type_code,
        quantity: line.quantity,
      })),
      stocktake_lines: roomTypes.map((roomType) => {
        const existing = (current.stocktake?.lines || []).find((line) => line.room_type_code === roomType.code)
        return {
          room_type_code: roomType.code,
          remaining_sets: existing?.remaining_sets ?? 0,
        }
      }),
    })
  }

  function applyCancelledRecordLocally(record: LinenDeliveryRecord, response?: DeliverySaveResponse | null) {
    const nextUpdatedAt = response?.updated_at || dayjs().toISOString()
    const nextCancelledAt = response?.cancelled_at || dayjs().toISOString()
    setRecords((current) => {
      const next = current.map((item) => (
        item.id === record.id
          ? {
              ...item,
              status: 'cancelled',
              updated_at: nextUpdatedAt,
              cancelled_at: nextCancelledAt,
              cancelled_by: response?.cancelled_by ?? item.cancelled_by ?? null,
            }
          : item
      ))
      return status === 'completed' ? next.filter((item) => item.id !== record.id) : next
    })
    setDetail((current) => (
      current && current.id === record.id
        ? {
            ...current,
            status: 'cancelled',
            updated_at: nextUpdatedAt,
            cancelled_at: nextCancelledAt,
            cancelled_by: response?.cancelled_by ?? current.cancelled_by ?? null,
          }
        : current
    ))
  }

  useEffect(() => {
    loadBase()
      .then(() => loadRecords())
      .catch((e) => message.error(e?.message || '加载失败'))
  }, [])

  function resetEditor() {
    setEditingRecordId('')
    editorForm.resetFields()
    editorForm.setFieldsValue({
      delivery_date: dayjs(),
      from_warehouse_id: smWarehouseId || '',
      to_warehouse_id: '',
      note: '',
      dirty_bag_note: '',
      lines: [],
      extra_linen_lines: [],
      stocktake_lines: roomTypes.map((roomType) => ({ room_type_code: roomType.code, remaining_sets: 0 })),
    })
  }

  function openCreate() {
    resetEditor()
    setEditorOpen(true)
  }

  async function openEdit(recordId: string) {
    const current = detail?.id === recordId ? detail : await loadDetail(recordId, false)
    if (!current) return
    fillEditorFromDetail(current)
    setDetailOpen(false)
    setEditorOpen(true)
  }

  function normalizeEditorLines(values: DeliveryEditorValues['lines']) {
    const lines = (values || []).map((line) => ({
      room_type_code: String(line?.room_type_code || '').trim(),
      sets: Number(line?.sets || 0),
    })).filter((line) => line.room_type_code || line.sets)

    const seen = new Set<string>()
    for (const line of lines) {
      if (!line.room_type_code) throw new Error('房型不能为空')
      if (!Number.isInteger(line.sets) || line.sets < 1) throw new Error('配送套数必须大于 0')
      if (seen.has(line.room_type_code)) throw new Error('同一配送单内房型不能重复')
      seen.add(line.room_type_code)
    }
    return lines
  }

  function normalizeExtraLinenLines(values: DeliveryEditorValues['extra_linen_lines']) {
    const lines = (values || []).map((line) => ({
      linen_type_code: String(line?.linen_type_code || '').trim(),
      quantity: Number(line?.quantity || 0),
    })).filter((line) => line.linen_type_code || line.quantity)
    const seen = new Set<string>()
    for (const line of lines) {
      if (!line.linen_type_code) throw new Error('备用床品类型不能为空')
      if (!Number.isInteger(line.quantity) || line.quantity < 1) throw new Error('备用床品数量必须大于 0')
      if (seen.has(line.linen_type_code)) throw new Error('同一配送单内备用床品类型不能重复')
      seen.add(line.linen_type_code)
    }
    return lines
  }

  function normalizeStocktakeLines(values: DeliveryEditorValues['stocktake_lines']) {
    const lines = (values || []).map((line) => ({
      room_type_code: String(line?.room_type_code || '').trim(),
      remaining_sets: Number(line?.remaining_sets ?? 0),
    }))
    if (!lines.length) throw new Error('请填写送后盘点数据')
    const seen = new Set<string>()
    for (const line of lines) {
      if (!line.room_type_code) throw new Error('盘点房型不能为空')
      if (!Number.isInteger(line.remaining_sets) || line.remaining_sets < 0) throw new Error('剩余套数不能小于 0')
      if (seen.has(line.room_type_code)) throw new Error('同一盘点单内房型不能重复')
      seen.add(line.room_type_code)
    }
    return lines
  }

  function buildCreateMatchSignature(payload: {
    delivery_date: string
    from_warehouse_id: string
    to_warehouse_id: string
    note?: string
    lines: Array<{ room_type_code: string; sets: number }>
    extra_linen_lines: Array<{ linen_type_code: string; quantity: number }>
  }) {
    return {
      delivery_date: payload.delivery_date,
      from_warehouse_id: payload.from_warehouse_id,
      to_warehouse_id: payload.to_warehouse_id,
      note: String(payload.note || '').trim(),
      total_sets: (payload.lines || []).reduce((sum, line) => sum + Number(line.sets || 0), 0),
      room_type_count: (payload.lines || []).length,
      extra_linen_total: (payload.extra_linen_lines || []).reduce((sum, line) => sum + Number(line.quantity || 0), 0),
    }
  }

  function findMatchingSavedRecord(
    rows: LinenDeliveryRecord[],
    signature: ReturnType<typeof buildCreateMatchSignature>,
    requestStartedAt: number,
  ) {
    const createdAfterMs = requestStartedAt - 10 * 1000
    return (rows || []).find((row) => {
      if (String(row.delivery_date || '') !== signature.delivery_date) return false
      if (String(row.from_warehouse_id || '') !== signature.from_warehouse_id) return false
      if (String(row.to_warehouse_id || '') !== signature.to_warehouse_id) return false
      if (String(row.note || '').trim() !== signature.note) return false
      if (Number(row.total_sets || 0) !== signature.total_sets) return false
      if (Number(row.room_type_count || 0) !== signature.room_type_count) return false
      if (Number((row as any).extra_linen_total || 0) !== signature.extra_linen_total) return false
      const createdAt = String(row.created_at || '')
      if (!createdAt) return true
      const createdAtMs = Date.parse(createdAt.replace(' ', 'T'))
      if (!Number.isFinite(createdAtMs)) return true
      return createdAtMs >= createdAfterMs
    })
  }

  async function confirmCreateSavedAfterTimeout(
    payload: {
      delivery_date: string
      from_warehouse_id: string
      to_warehouse_id: string
      note?: string
      lines: Array<{ room_type_code: string; sets: number }>
      extra_linen_lines: Array<{ linen_type_code: string; quantity: number }>
    },
    requestStartedAt: number,
  ) {
    const signature = buildCreateMatchSignature(payload)
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (attempt > 0) await delay(3000)
      const refreshed = await loadRecords()
      const matched = findMatchingSavedRecord(refreshed || [], signature, requestStartedAt)
      if (matched) return matched
    }
    return null
  }

  async function submitEditor() {
    if (submitLockRef.current || saving) return
    submitLockRef.current = true
    try {
      const values = await editorForm.validateFields()
      const lines = normalizeEditorLines(values.lines)
      const extraLinenLines = normalizeExtraLinenLines(values.extra_linen_lines)
      const stocktakeLines = normalizeStocktakeLines(values.stocktake_lines)
      if (values.from_warehouse_id === values.to_warehouse_id) throw new Error('来源仓和目标分仓不能相同')
      if (!lines.length && !extraLinenLines.length) throw new Error('请至少填写一条配送明细')

      setSaving(true)
      const payload = {
        delivery_date: dayjs(values.delivery_date).format('YYYY-MM-DD'),
        from_warehouse_id: values.from_warehouse_id,
        to_warehouse_id: values.to_warehouse_id,
        note: values.note || undefined,
        dirty_bag_note: values.dirty_bag_note || undefined,
        lines,
        extra_linen_lines: extraLinenLines,
        stocktake_lines: stocktakeLines,
      }
      const requestStartedAt = Date.now()
      if (editingRecordId) {
        await patchJSON(`/inventory/linen/delivery-records/${editingRecordId}`, payload, { timeoutMs: 30000 })
        message.success('配送单已更新')
      } else {
        try {
          const response = await postJSON<DeliverySaveResponse>('/inventory/linen/delivery-records', payload, { timeoutMs: 30000 })
          message.success(response?.deduped ? '配送单已保存，无重复创建' : '配送单已创建')
        } catch (e: any) {
          const failureKind = getApiFailureKind(e)
          if (failureKind === 'network_unavailable') {
            const hide = message.loading('正在确认是否已保存...', 0)
            try {
              const matched = await confirmCreateSavedAfterTimeout(payload, requestStartedAt)
              if (matched) {
                message.success('已保存，响应超时')
              } else {
                const traceSuffix = e?.trace_id ? `（trace: ${e.trace_id}）` : ''
                throw new Error(`保存结果未确认，请稍后刷新列表检查${traceSuffix}`)
              }
            } finally {
              hide()
            }
          } else {
            throw e
          }
        }
      }
      setEditorOpen(false)
      resetEditor()
      await loadRecords()
    } catch (e: any) {
      const errorFields = Array.isArray(e?.errorFields) ? e.errorFields : []
      if (errorFields.length) {
        const firstField = errorFields[0]
        try { editorForm.scrollToField(firstField.name, { block: 'center' }) } catch {}
        const msg = String(firstField?.errors?.[0] || '')
        message.error(msg || '请先完善表单后再保存')
        return
      }
      const traceSuffix = e?.trace_id ? `（trace: ${e.trace_id}）` : ''
      message.error(`${e?.message || '保存失败'}${traceSuffix}`)
    } finally {
      setSaving(false)
      submitLockRef.current = false
    }
  }

  async function cancelRecord(record: LinenDeliveryRecord) {
    modal.confirm({
      title: '确认作废这张配送单？',
      content: `作废后会回滚 ${record.from_warehouse_code} -> ${record.to_warehouse_code} 的库存影响。`,
      okText: '确认作废',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        if (cancellingId === record.id) return
        setCancellingId(record.id)
        try {
          const response = await postJSON<DeliverySaveResponse>(`/inventory/linen/delivery-records/${record.id}/cancel`, {})
          applyCancelledRecordLocally(record, response)
          message.success('配送单已作废')
        } catch (e: any) {
          const msg = String(e?.message || '')
          if (msg.includes('该配送单已作废')) {
            applyCancelledRecordLocally(record, null)
            message.info('这张配送单已经作废，列表将自动刷新')
            await loadRecords().catch(() => {})
            return
          }
          message.error(msg || '作废失败')
        } finally {
          setCancellingId('')
        }
      },
    })
  }

  const recordColumns: any[] = [
    { title: '配送日期', dataIndex: 'delivery_date', width: 120 },
    { title: '来源仓', render: (_: any, row: LinenDeliveryRecord) => `${row.from_warehouse_code} - ${row.from_warehouse_name}` },
    { title: '目标分仓', render: (_: any, row: LinenDeliveryRecord) => `${row.to_warehouse_code} - ${row.to_warehouse_name}` },
    { title: '总套数', dataIndex: 'total_sets', width: 90 },
    { title: '房型数', dataIndex: 'room_type_count', width: 90 },
    { title: '状态', dataIndex: 'status', width: 100, render: (value: string) => statusTag(value) },
    { title: '备注', dataIndex: 'note', ellipsis: true },
    { title: '创建时间', dataIndex: 'created_at', width: 170, render: (value: string) => value ? dayjs(value).format('YYYY-MM-DD HH:mm') : '-' },
    {
      title: '操作',
      key: 'actions',
      width: 180,
      render: (_: any, row: LinenDeliveryRecord) => (
        <Space>
          <Button onClick={() => loadDetail(row.id, true).catch((e) => message.error(e?.message || '加载详情失败'))}>详情</Button>
          <Button disabled={row.status !== 'completed'} onClick={() => openEdit(row.id).catch((e) => message.error(e?.message || '加载编辑数据失败'))}>编辑</Button>
          <Button danger loading={cancellingId === row.id} disabled={row.status !== 'completed'} onClick={() => cancelRecord(row).catch((e) => message.error(e?.message || '作废失败'))}>作废</Button>
        </Space>
      ),
    },
  ]

  const breakdownColumns: any[] = [
    { title: '床品类型', dataIndex: 'item_name' },
    { title: 'SKU', dataIndex: 'item_sku', width: 140, render: (value: string) => value || '-' },
    { title: '每套用量', dataIndex: 'quantity_per_set', width: 100 },
    { title: '总件数', dataIndex: 'quantity_total', width: 100 },
  ]

  return (
    <>
      <Card
        title="床品配送记录"
        extra={<Space><Button onClick={() => loadRecords().catch((e) => message.error(e?.message || '刷新失败'))}>刷新</Button><Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新建配送单</Button></Space>}
      >
        <Space wrap style={{ marginBottom: 16 }}>
          <DatePicker.RangePicker value={dateRange as any} onChange={(value) => setDateRange(value as [Dayjs, Dayjs] | null)} allowClear />
          <Select allowClear placeholder="来源仓" style={{ width: 220 }} value={fromWarehouseId || undefined} onChange={(value) => setFromWarehouseId(String(value || ''))} options={warehouseOptions} />
          <Select allowClear placeholder="目标分仓" style={{ width: 220 }} value={toWarehouseId || undefined} onChange={(value) => setToWarehouseId(String(value || ''))} options={warehouseOptions} />
          <Select
            allowClear
            placeholder="状态"
            style={{ width: 160 }}
            value={status || undefined}
            onChange={(value) => setStatus(String(value || ''))}
            options={[
              { value: 'completed', label: '已完成' },
              { value: 'cancelled', label: '已作废' },
            ]}
          />
          <Button type="primary" onClick={() => loadRecords().catch((e) => message.error(e?.message || '查询失败'))}>查询</Button>
          <Button onClick={() => {
            setDateRange(DEFAULT_RANGE)
            setFromWarehouseId('')
            setToWarehouseId('')
            setStatus('completed')
          }}
          >
            重置
          </Button>
        </Space>

        <Table
          rowKey={(row) => row.id}
          loading={loading}
          columns={recordColumns}
          dataSource={records}
          pagination={{ pageSize: 20 }}
          scroll={{ x: 1280 }}
        />
      </Card>

      <Drawer
        open={editorOpen}
        title={editingRecordId ? '编辑配送单' : '新建配送单'}
        placement="right"
        width={550}
        onClose={() => {
          if (saving) return
          setEditorOpen(false)
          resetEditor()
        }}
        extra={
          <Space>
            <Button onClick={() => {
              if (saving) return
              setEditorOpen(false)
              resetEditor()
            }}
            >
              取消
            </Button>
            <Button type="primary" loading={saving} onClick={() => { void submitEditor() }}>
              {editingRecordId ? '保存修改' : '保存配送单'}
            </Button>
          </Space>
        }
      >
        <Form
          form={editorForm}
          layout="vertical"
          scrollToFirstError
          initialValues={{ delivery_date: dayjs(), lines: [], extra_linen_lines: [], stocktake_lines: roomTypes.map((roomType) => ({ room_type_code: roomType.code, remaining_sets: 0 })) }}
        >
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '160px minmax(0, 1fr) minmax(0, 1fr)',
              gap: 12,
              alignItems: 'start',
            }}
          >
            <Form.Item name="delivery_date" label="配送日期" rules={[{ required: true, message: '请选择配送日期' }]} style={{ marginBottom: 0 }}>
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="from_warehouse_id" label="来源仓" rules={[{ required: true, message: '来源仓加载失败，请刷新页面后重试' }]} style={{ marginBottom: 0 }}>
              <Select options={warehouseOptions} disabled />
            </Form.Item>
            <Form.Item name="to_warehouse_id" label="目标分仓" rules={[{ required: true, message: '请选择目标分仓' }]} style={{ marginBottom: 0 }}>
              <Select options={stocktakeWarehouseOptions} />
            </Form.Item>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8, marginBottom: 8 }}>
            <Typography.Title level={5} style={{ margin: 0 }}>房型配送明细</Typography.Title>
            <Button type="text" icon={<PlusOutlined />} onClick={() => {
              const current = editorForm.getFieldValue('lines') || []
              editorForm.setFieldValue('lines', [...current, { room_type_code: undefined, sets: 1 }])
            }}>
              添加房型
            </Button>
          </div>
          <Form.List name="lines">
            {(fields, { remove }) => (
              <>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'minmax(0, 1fr) 156px 28px',
                    gap: 8,
                    alignItems: 'center',
                    marginBottom: 8,
                    fontWeight: 500,
                    color: 'rgba(0,0,0,0.88)',
                  }}
                >
                  <div>房型</div>
                  <div>配送套数</div>
                  <div />
                </div>
                {fields.map((field, index) => (
                  <div
                    key={field.key}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'minmax(0, 1fr) 156px 28px',
                      gap: 8,
                      alignItems: 'center',
                      marginBottom: 12,
                    }}
                  >
                    <Form.Item
                      {...field}
                      name={[field.name, 'room_type_code']}
                      rules={[{ required: true, message: '请选择房型' }]}
                      style={{ marginBottom: 0 }}
                    >
                      <Select options={roomTypeOptions} placeholder="选择房型" />
                    </Form.Item>
                    <Form.Item
                      {...field}
                      name={[field.name, 'sets']}
                      rules={[{ required: true, message: '请输入套数' }]}
                      style={{ marginBottom: 0 }}
                    >
                      <InputNumber min={1} precision={0} style={{ width: '100%' }} />
                    </Form.Item>
                    <Button
                      type="text"
                      danger
                      icon={<DeleteOutlined />}
                      aria-label={`删除第 ${index + 1} 行配送明细`}
                      onClick={() => remove(field.name)}
                      disabled={fields.length <= 1}
                    />
                  </div>
                ))}
                {!fields.length ? <Typography.Text type="secondary">可选。不按房型配送时，这里可以留空。</Typography.Text> : null}
              </>
            )}
          </Form.List>

          <Divider />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8, marginBottom: 8 }}>
            <Typography.Title level={5} style={{ margin: 0 }}>备用床品配送</Typography.Title>
            <Button type="text" icon={<PlusOutlined />} onClick={() => {
              const current = editorForm.getFieldValue('extra_linen_lines') || []
              editorForm.setFieldValue('extra_linen_lines', [...current, { linen_type_code: undefined, quantity: 1 }])
            }}>
              添加备用床品
            </Button>
          </div>
          <Form.List name="extra_linen_lines">
            {(fields, { remove }) => (
              <>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'minmax(0, 1fr) 156px 28px',
                    gap: 8,
                    alignItems: 'center',
                    marginBottom: 8,
                    fontWeight: 500,
                    color: 'rgba(0,0,0,0.88)',
                  }}
                >
                  <div>床品类型</div>
                  <div>配送件数</div>
                  <div />
                </div>
                {fields.map((field, index) => (
                  <div
                    key={field.key}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'minmax(0, 1fr) 156px 28px',
                      gap: 8,
                      alignItems: 'center',
                      marginBottom: 12,
                    }}
                  >
                    <Form.Item {...field} name={[field.name, 'linen_type_code']} rules={[{ required: true, message: '请选择床品类型' }]} style={{ marginBottom: 0 }}>
                      <Select options={linenTypeOptions} placeholder="选择床品类型" />
                    </Form.Item>
                    <Form.Item {...field} name={[field.name, 'quantity']} rules={[{ required: true, message: '请输入件数' }]} style={{ marginBottom: 0 }}>
                      <InputNumber min={1} precision={0} style={{ width: '100%' }} />
                    </Form.Item>
                    <Button type="text" danger icon={<DeleteOutlined />} aria-label={`删除第 ${index + 1} 行备用床品`} onClick={() => remove(field.name)} />
                  </div>
                ))}
                {!fields.length ? <Typography.Text type="secondary">可选。需要配送备用床品时，再从右上角添加。</Typography.Text> : null}
              </>
            )}
          </Form.List>

          <Divider />
          <Typography.Title level={5} style={{ marginTop: 8 }}>送后盘点剩余套数</Typography.Title>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
            盘点值将作为该分仓新的有效库存基准，所有启用房型都需要填写，没有库存请填 0。
          </Typography.Paragraph>
          <Form.List name="stocktake_lines">
            {(fields) => (
              <>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'minmax(0, 1fr) 156px',
                    gap: 8,
                    alignItems: 'center',
                    marginBottom: 8,
                    fontWeight: 500,
                    color: 'rgba(0,0,0,0.88)',
                  }}
                >
                  <div>房型</div>
                  <div>剩余套数</div>
                </div>
                {fields.map((field, index) => (
                  <div
                    key={field.key}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'minmax(0, 1fr) 156px',
                      gap: 8,
                      alignItems: 'center',
                      marginBottom: 12,
                    }}
                  >
                    <Form.Item
                      {...field}
                      name={[field.name, 'room_type_code']}
                      style={{ marginBottom: 0 }}
                    >
                      <Select options={roomTypeOptions} disabled />
                    </Form.Item>
                    <Form.Item
                      {...field}
                      name={[field.name, 'remaining_sets']}
                      rules={[{ required: true, message: '请输入剩余套数' }]}
                      style={{ marginBottom: 0 }}
                    >
                      <InputNumber min={0} precision={0} style={{ width: '100%' }} />
                    </Form.Item>
                  </div>
                ))}
              </>
            )}
          </Form.List>

          <Divider />
          <Form.Item name="dirty_bag_note" label="脏床品袋数备注">
            <Input placeholder="只做现场备注，不参与库存换算" />
          </Form.Item>
          <Form.Item name="note" label="备注">
            <Input placeholder="可记录本次配送说明" />
          </Form.Item>
        </Form>
      </Drawer>

      <Drawer
        open={detailOpen}
        title="配送单详情"
        placement="right"
        width={550}
        extra={
          <Space>
            <Button
              type="primary"
              disabled={!detail || detail.status !== 'completed'}
              onClick={() => {
                if (!detail?.id) return
                void openEdit(detail.id).catch((e) => message.error(e?.message || '加载编辑数据失败'))
              }}
            >
              编辑
            </Button>
            <Button onClick={() => setDetailOpen(false)}>关闭</Button>
          </Space>
        }
        onClose={() => setDetailOpen(false)}
      >
        {detailLoading ? (
          <Typography.Text>加载中...</Typography.Text>
        ) : !detail ? (
          <Typography.Text type="secondary">暂无数据</Typography.Text>
        ) : (
          <>
            <Descriptions bordered size="small" column={2}>
              <Descriptions.Item label="配送日期">{detail.delivery_date}</Descriptions.Item>
              <Descriptions.Item label="状态">{statusTag(detail.status)}</Descriptions.Item>
              <Descriptions.Item label="来源仓">{detail.from_warehouse_code} - {detail.from_warehouse_name}</Descriptions.Item>
              <Descriptions.Item label="目标分仓">{detail.to_warehouse_code} - {detail.to_warehouse_name}</Descriptions.Item>
              <Descriptions.Item label="总套数">{detail.total_sets}</Descriptions.Item>
              <Descriptions.Item label="房型数">{detail.room_type_count}</Descriptions.Item>
              <Descriptions.Item label="创建人">{detail.created_by || '-'}</Descriptions.Item>
              <Descriptions.Item label="创建时间">{detail.created_at ? dayjs(detail.created_at).format('YYYY-MM-DD HH:mm') : '-'}</Descriptions.Item>
              <Descriptions.Item label="更新时间">{detail.updated_at ? dayjs(detail.updated_at).format('YYYY-MM-DD HH:mm') : '-'}</Descriptions.Item>
              <Descriptions.Item label="作废时间">{detail.cancelled_at ? dayjs(detail.cancelled_at).format('YYYY-MM-DD HH:mm') : '-'}</Descriptions.Item>
              <Descriptions.Item label="脏床品袋备注" span={2}>{detail.stocktake?.dirty_bag_note || detail.dirty_bag_note || '-'}</Descriptions.Item>
              <Descriptions.Item label="备注" span={2}>{detail.note || '-'}</Descriptions.Item>
            </Descriptions>

            <Divider />
            <Typography.Title level={5}>按房型配送</Typography.Title>
            <Space direction="vertical" style={{ width: '100%' }} size={16}>
              {(detail.lines || []).map((line) => (
                <Card key={line.id} size="small" title={`${line.room_type_name} · ${line.sets} 套`}>
                  <Table
                    size="small"
                    rowKey={(row) => `${line.id}-${row.item_id}`}
                    columns={breakdownColumns}
                    dataSource={line.breakdown || []}
                    pagination={false}
                  />
                </Card>
              ))}
            </Space>

            <Divider />
            <Typography.Title level={5}>备用床品配送</Typography.Title>
            {(detail.extra_lines || []).length ? (
              <Table
                size="small"
                rowKey={(row) => row.id}
                columns={[
                  { title: '床品类型', dataIndex: 'linen_type_name' },
                  { title: '配送件数', dataIndex: 'quantity', width: 120 },
                ]}
                dataSource={detail.extra_lines || []}
                pagination={false}
              />
            ) : (
              <Typography.Text type="secondary">本单没有额外配送备用床品</Typography.Text>
            )}

            <Divider />
            <Typography.Title level={5}>本次盘点</Typography.Title>
            {detail.stocktake ? (
              <>
                <Descriptions bordered size="small" column={2} style={{ marginBottom: 16 }}>
                  <Descriptions.Item label="盘点日期">{detail.stocktake.stocktake_date}</Descriptions.Item>
                  <Descriptions.Item label="盘点时间">{detail.stocktake.created_at ? dayjs(detail.stocktake.created_at).format('YYYY-MM-DD HH:mm') : '-'}</Descriptions.Item>
                  <Descriptions.Item label="盘点分仓">{detail.stocktake.warehouse_code} - {detail.stocktake.warehouse_name}</Descriptions.Item>
                  <Descriptions.Item label="脏床品袋备注">{detail.stocktake.dirty_bag_note || '-'}</Descriptions.Item>
                </Descriptions>
                <Table
                  size="small"
                  rowKey={(row) => row.id}
                  columns={[
                    { title: '房型', dataIndex: 'room_type_name' },
                    { title: '剩余套数', dataIndex: 'remaining_sets', width: 120 },
                  ]}
                  dataSource={detail.stocktake.lines || []}
                  pagination={false}
                />
              </>
            ) : (
              <Typography.Text type="secondary">暂无盘点记录</Typography.Text>
            )}

            <Divider />
            <Typography.Title level={5}>床品件数汇总</Typography.Title>
            <Table
              size="small"
              rowKey={(row) => row.item_id}
              columns={[
                { title: '床品类型', dataIndex: 'item_name' },
                { title: 'SKU', dataIndex: 'item_sku', width: 140, render: (value: string) => value || '-' },
                { title: '总件数', dataIndex: 'quantity_total', width: 120 },
              ]}
              dataSource={detail.breakdown_summary || []}
              pagination={false}
            />
          </>
        )}
      </Drawer>
    </>
  )
}
