"use client"

import { App, Button, Card, DatePicker, Descriptions, Divider, Form, Input, InputNumber, Modal, Select, Space, Table, Tag, Typography } from 'antd'
import { DeleteOutlined, EditOutlined, EyeOutlined, PlusOutlined } from '@ant-design/icons'
import { useEffect, useMemo, useRef, useState } from 'react'
import dayjs, { type Dayjs } from 'dayjs'
import { getJSON, patchJSON, postJSON } from '../../../lib/api'

type Warehouse = { id: string; code: string; name: string; active: boolean; stocktake_enabled?: boolean }
type RoomType = { code: string; name: string; sort_order: number; active: boolean }

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
  stocktake_lines: Array<{
    room_type_code?: string
    remaining_sets?: number
  }>
}

const DEFAULT_RANGE: [Dayjs, Dayjs] = [dayjs().subtract(30, 'day'), dayjs()]

function statusTag(status: string) {
  if (status === 'cancelled') return <Tag color="red">已作废</Tag>
  return <Tag color="green">已完成</Tag>
}

export default function LinenTransfersView() {
  const { message, modal } = App.useApp()
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [roomTypes, setRoomTypes] = useState<RoomType[]>([])
  const [records, setRecords] = useState<LinenDeliveryRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)
  const [detailOpen, setDetailOpen] = useState(false)
  const [editingRecordId, setEditingRecordId] = useState<string>('')
  const [detail, setDetail] = useState<LinenDeliveryRecordDetail | null>(null)
  const [dateRange, setDateRange] = useState<[Dayjs, Dayjs] | null>(DEFAULT_RANGE)
  const [fromWarehouseId, setFromWarehouseId] = useState('')
  const [toWarehouseId, setToWarehouseId] = useState('')
  const [status, setStatus] = useState('')
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

  async function loadBase() {
    const [warehouseRows, roomTypeRows] = await Promise.all([
      getJSON<Warehouse[]>('/inventory/warehouses'),
      getJSON<RoomType[]>('/inventory/room-types'),
    ])
    setWarehouses((warehouseRows || []).filter((item) => item.active))
    setRoomTypes((roomTypeRows || []).filter((item) => item.active).sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0)))
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
    } finally {
      setLoading(false)
    }
  }

  async function loadDetail(id: string, open = true) {
    setDetailLoading(true)
    try {
      const data = await getJSON<LinenDeliveryRecordDetail>(`/inventory/linen/delivery-records/${id}`)
      setDetail(data || null)
      if (open) setDetailOpen(true)
      return data
    } finally {
      setDetailLoading(false)
    }
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
      from_warehouse_id: '',
      to_warehouse_id: '',
      note: '',
      dirty_bag_note: '',
      lines: [{ room_type_code: undefined, sets: 1 }],
      stocktake_lines: roomTypes.map((roomType) => ({ room_type_code: roomType.code, remaining_sets: 0 })),
    })
  }

  function openCreate() {
    resetEditor()
    setEditorOpen(true)
  }

  async function openEdit(recordId: string) {
    const current = await loadDetail(recordId, false)
    if (!current) return
    setEditingRecordId(recordId)
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
      stocktake_lines: roomTypes.map((roomType) => {
        const existing = (current.stocktake?.lines || []).find((line) => line.room_type_code === roomType.code)
        return {
          room_type_code: roomType.code,
          remaining_sets: existing?.remaining_sets ?? 0,
        }
      }),
    })
    setEditorOpen(true)
  }

  function normalizeEditorLines(values: DeliveryEditorValues['lines']) {
    const lines = (values || []).map((line) => ({
      room_type_code: String(line?.room_type_code || '').trim(),
      sets: Number(line?.sets || 0),
    })).filter((line) => line.room_type_code || line.sets)

    if (!lines.length) throw new Error('请至少填写一条配送明细')

    const seen = new Set<string>()
    for (const line of lines) {
      if (!line.room_type_code) throw new Error('房型不能为空')
      if (!Number.isInteger(line.sets) || line.sets < 1) throw new Error('配送套数必须大于 0')
      if (seen.has(line.room_type_code)) throw new Error('同一配送单内房型不能重复')
      seen.add(line.room_type_code)
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

  async function submitEditor() {
    if (submitLockRef.current || saving) return
    submitLockRef.current = true
    const values = await editorForm.validateFields()
    try {
      const lines = normalizeEditorLines(values.lines)
      const stocktakeLines = normalizeStocktakeLines(values.stocktake_lines)
      if (values.from_warehouse_id === values.to_warehouse_id) throw new Error('来源仓和目标分仓不能相同')

      setSaving(true)
      const payload = {
        delivery_date: dayjs(values.delivery_date).format('YYYY-MM-DD'),
        from_warehouse_id: values.from_warehouse_id,
        to_warehouse_id: values.to_warehouse_id,
        note: values.note || undefined,
        dirty_bag_note: values.dirty_bag_note || undefined,
        lines,
        stocktake_lines: stocktakeLines,
      }
      if (editingRecordId) {
        await patchJSON(`/inventory/linen/delivery-records/${editingRecordId}`, payload)
        message.success('配送单已更新')
      } else {
        await postJSON('/inventory/linen/delivery-records', payload)
        message.success('配送单已创建')
      }
      setEditorOpen(false)
      resetEditor()
      await loadRecords()
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
        await postJSON(`/inventory/linen/delivery-records/${record.id}/cancel`, {})
        message.success('配送单已作废')
        if (detail?.id === record.id) {
          await loadDetail(record.id, true)
        }
        await loadRecords()
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
        <Space size="small">
          <Button size="small" icon={<EyeOutlined />} onClick={() => loadDetail(row.id, true).catch((e) => message.error(e?.message || '加载详情失败'))}>查看</Button>
          <Button size="small" icon={<EditOutlined />} disabled={row.status !== 'completed'} onClick={() => openEdit(row.id).catch((e) => message.error(e?.message || '加载编辑数据失败'))}>编辑</Button>
          <Button size="small" danger icon={<DeleteOutlined />} disabled={row.status !== 'completed'} onClick={() => cancelRecord(row).catch((e) => message.error(e?.message || '作废失败'))}>作废</Button>
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
            setStatus('')
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

      <Modal
        open={editorOpen}
        title={editingRecordId ? '编辑配送单' : '新建配送单'}
        width={880}
        destroyOnClose
        onCancel={() => {
          if (saving) return
          setEditorOpen(false)
          resetEditor()
        }}
        onOk={() => submitEditor().catch((e) => message.error(e?.message || '保存失败'))}
        confirmLoading={saving}
      >
        <Form form={editorForm} layout="vertical" initialValues={{ delivery_date: dayjs(), lines: [{ room_type_code: undefined, sets: 1 }], stocktake_lines: roomTypes.map((roomType) => ({ room_type_code: roomType.code, remaining_sets: 0 })) }}>
          <Space align="start" style={{ width: '100%' }} size={16}>
            <Form.Item name="delivery_date" label="配送日期" rules={[{ required: true, message: '请选择配送日期' }]} style={{ minWidth: 180 }}>
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="from_warehouse_id" label="来源仓" rules={[{ required: true, message: '请选择来源仓' }]} style={{ minWidth: 220 }}>
              <Select options={warehouseOptions} />
            </Form.Item>
            <Form.Item name="to_warehouse_id" label="目标分仓" rules={[{ required: true, message: '请选择目标分仓' }]} style={{ minWidth: 220 }}>
              <Select options={stocktakeWarehouseOptions} />
            </Form.Item>
          </Space>
          <Form.Item name="note" label="备注">
            <Input placeholder="可记录本次配送说明" />
          </Form.Item>
          <Form.Item name="dirty_bag_note" label="脏床品袋数备注">
            <Input placeholder="只做现场备注，不参与库存换算" />
          </Form.Item>

          <Typography.Title level={5} style={{ marginTop: 8 }}>房型配送明细</Typography.Title>
          <Form.List name="lines">
            {(fields, { add, remove }) => (
              <>
                {fields.map((field, index) => (
                  <Space key={field.key} align="start" style={{ display: 'flex', marginBottom: 12 }}>
                    <Form.Item
                      {...field}
                      name={[field.name, 'room_type_code']}
                      label={index === 0 ? '房型' : ' '}
                      rules={[{ required: true, message: '请选择房型' }]}
                      style={{ minWidth: 320 }}
                    >
                      <Select options={roomTypeOptions} placeholder="选择房型" />
                    </Form.Item>
                    <Form.Item
                      {...field}
                      name={[field.name, 'sets']}
                      label={index === 0 ? '配送套数' : ' '}
                      rules={[{ required: true, message: '请输入套数' }]}
                      style={{ minWidth: 160 }}
                    >
                      <InputNumber min={1} precision={0} style={{ width: '100%' }} />
                    </Form.Item>
                    <Button danger style={{ marginTop: 30 }} onClick={() => remove(field.name)} disabled={fields.length <= 1}>删除</Button>
                  </Space>
                ))}
                <Button type="dashed" onClick={() => add({ room_type_code: undefined, sets: 1 })} icon={<PlusOutlined />}>
                  添加房型
                </Button>
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
                {fields.map((field, index) => (
                  <Space key={field.key} align="start" style={{ display: 'flex', marginBottom: 12 }}>
                    <Form.Item
                      {...field}
                      name={[field.name, 'room_type_code']}
                      label={index === 0 ? '房型' : ' '}
                      style={{ minWidth: 320 }}
                    >
                      <Select options={roomTypeOptions} disabled />
                    </Form.Item>
                    <Form.Item
                      {...field}
                      name={[field.name, 'remaining_sets']}
                      label={index === 0 ? '剩余套数' : ' '}
                      rules={[{ required: true, message: '请输入剩余套数' }]}
                      style={{ minWidth: 160 }}
                    >
                      <InputNumber min={0} precision={0} style={{ width: '100%' }} />
                    </Form.Item>
                  </Space>
                ))}
              </>
            )}
          </Form.List>
        </Form>
      </Modal>

      <Modal
        open={detailOpen}
        title="配送单详情"
        width={960}
        footer={<Button onClick={() => setDetailOpen(false)}>关闭</Button>}
        onCancel={() => setDetailOpen(false)}
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
      </Modal>
    </>
  )
}
