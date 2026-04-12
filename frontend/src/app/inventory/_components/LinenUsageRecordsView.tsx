"use client"
import { Alert, Button, Card, DatePicker, Select, Space, Table, Tag, Typography, message } from 'antd'
import { useEffect, useMemo, useState } from 'react'
import dayjs from 'dayjs'
import { getJSON } from '../../../lib/api'

type Warehouse = { id: string; code: string; name: string; active: boolean }
type PropertyRow = { id: string; code?: string | null; address?: string | null }
type LinenType = { code: string; name: string; active?: boolean }
type RoomType = { code: string; name: string; active?: boolean }

type LinenUsageRow = {
  id: string
  usage_key: string
  usage_date: string
  source_type: string
  source_label: string
  source_ref: string
  cleaning_task_id?: string | null
  property_id?: string | null
  property_code?: string | null
  property_address?: string | null
  room_type_code?: string | null
  room_type_name?: string | null
  warehouse_id?: string | null
  warehouse_code?: string | null
  warehouse_name?: string | null
  linen_type_code: string
  linen_type_name?: string | null
  quantity: number
  note?: string | null
  created_at: string
}

type GroupedLinenUsageRow = {
  id: string
  usage_date: string
  property_id?: string | null
  property_code?: string | null
  property_address?: string | null
  room_type_code?: string | null
  room_type_name?: string | null
  warehouse_id?: string | null
  warehouse_code?: string | null
  warehouse_name?: string | null
  source_type: string
  source_label: string
  note?: string | null
  created_at: string
  total_quantity: number
  detail_count: number
  details: LinenUsageRow[]
}

export default function LinenUsageRecordsView() {
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [properties, setProperties] = useState<PropertyRow[]>([])
  const [linenTypes, setLinenTypes] = useState<LinenType[]>([])
  const [roomTypes, setRoomTypes] = useState<RoomType[]>([])
  const [rows, setRows] = useState<LinenUsageRow[]>([])
  const [warehouseId, setWarehouseId] = useState('')
  const [propertyId, setPropertyId] = useState('')
  const [roomTypeCode, setRoomTypeCode] = useState('')
  const [linenTypeCode, setLinenTypeCode] = useState('')
  const [sourceType, setSourceType] = useState('')
  const [range, setRange] = useState<[any, any] | null>(null)

  async function loadBase() {
    const [ws, ps, lt, rt] = await Promise.all([
      getJSON<Warehouse[]>('/inventory/warehouses'),
      getJSON<PropertyRow[]>('/properties'),
      getJSON<LinenType[]>('/inventory/linen-types'),
      getJSON<RoomType[]>('/inventory/room-types'),
    ])
    setWarehouses(ws || [])
    setProperties(ps || [])
    setLinenTypes((lt || []).filter((item) => item.active !== false))
    setRoomTypes((rt || []).filter((item) => item.active !== false))
  }

  async function load() {
    const params: Record<string, string> = { limit: '200' }
    if (warehouseId) params.warehouse_id = warehouseId
    if (propertyId) params.property_id = propertyId
    if (roomTypeCode) params.room_type_code = roomTypeCode
    if (linenTypeCode) params.linen_type_code = linenTypeCode
    if (sourceType) params.source_type = sourceType
    if (range?.[0]) params.from = dayjs(range[0]).format('YYYY-MM-DD')
    if (range?.[1]) params.to = dayjs(range[1]).format('YYYY-MM-DD')
    const data = await getJSON<LinenUsageRow[]>(`/inventory/linen-usage-records?${new URLSearchParams(params as any).toString()}`)
    setRows(data || [])
  }

  useEffect(() => {
    loadBase().then(load).catch((e) => message.error(e?.message || '加载失败'))
  }, [])

  const whOptions = useMemo(() => [{ value: '', label: '全部仓库' }, ...(warehouses || []).filter((w) => w.active).map((w) => ({ value: w.id, label: `${w.code} - ${w.name}` }))], [warehouses])
  const propOptions = useMemo(() => [{ value: '', label: '全部房源' }, ...(properties || []).map((p) => ({ value: p.id, label: `${p.code || ''} ${p.address || ''}`.trim() }))], [properties])
  const roomTypeOptions = useMemo(() => [{ value: '', label: '全部房型' }, ...(roomTypes || []).map((r) => ({ value: r.code, label: r.name }))], [roomTypes])
  const linenTypeOptions = useMemo(() => [{ value: '', label: '全部床品类型' }, ...(linenTypes || []).map((r) => ({ value: r.code, label: r.name }))], [linenTypes])

  const groupedRows = useMemo<GroupedLinenUsageRow[]>(() => {
    const map = new Map<string, GroupedLinenUsageRow>()
    for (const row of rows) {
      const groupKey = [
        String(row.usage_date || ''),
        String(row.property_id || row.property_code || ''),
        String(row.source_type || ''),
        String(row.source_ref || ''),
      ].join('::')
      const current = map.get(groupKey)
      if (current) {
        current.total_quantity += Number(row.quantity || 0)
        current.detail_count += 1
        current.details.push(row)
        if (String(row.created_at || '') > String(current.created_at || '')) current.created_at = row.created_at
      } else {
        map.set(groupKey, {
          id: groupKey,
          usage_date: row.usage_date,
          property_id: row.property_id,
          property_code: row.property_code,
          property_address: row.property_address,
          room_type_code: row.room_type_code,
          room_type_name: row.room_type_name,
          warehouse_id: row.warehouse_id,
          warehouse_code: row.warehouse_code,
          warehouse_name: row.warehouse_name,
          source_type: row.source_type,
          source_label: row.source_label,
          note: row.note,
          created_at: row.created_at,
          total_quantity: Number(row.quantity || 0),
          detail_count: 1,
          details: [row],
        })
      }
    }
    return Array.from(map.values()).sort((a, b) => {
      const byDate = String(b.usage_date || '').localeCompare(String(a.usage_date || ''))
      if (byDate) return byDate
      return String(b.created_at || '').localeCompare(String(a.created_at || ''))
    })
  }, [rows])

  const columns: any[] = [
    { title: '日期', dataIndex: 'usage_date', render: (v: string) => dayjs(v).format('YYYY-MM-DD') },
    { title: '房源', dataIndex: 'property_code', render: (_: any, r: GroupedLinenUsageRow) => r.property_code || '-' },
    { title: '房型', dataIndex: 'room_type_name', render: (_: any, r: GroupedLinenUsageRow) => r.room_type_name || r.room_type_code || '-' },
    { title: '仓库', dataIndex: 'warehouse_name', render: (_: any, r: GroupedLinenUsageRow) => r.warehouse_id ? `${r.warehouse_code || ''} ${r.warehouse_name || ''}`.trim() : '-' },
    { title: '床品项目数', dataIndex: 'detail_count' },
    { title: '合计数量', dataIndex: 'total_quantity' },
    { title: '来源', dataIndex: 'source_label', render: (_: any, r: GroupedLinenUsageRow) => <Tag color={r.source_type === 'day_end_reject_usage' ? 'gold' : 'blue'}>{r.source_label || r.source_type}</Tag> },
    { title: '备注', dataIndex: 'note', render: (v: string) => v || '-' },
    { title: '记录时间', dataIndex: 'created_at', render: (v: string) => dayjs(v).format('YYYY-MM-DD HH:mm') },
  ]

  const detailColumns: any[] = [
    { title: '床品类型', dataIndex: 'linen_type_name', render: (_: any, r: LinenUsageRow) => <Space><span>{r.linen_type_name || r.linen_type_code}</span><Tag>{r.linen_type_code}</Tag></Space> },
    { title: '数量', dataIndex: 'quantity' },
    { title: '备注', dataIndex: 'note', render: (v: string) => v || '-' },
  ]

  return (
    <Card title="床品使用记录">
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="这里只统计清洁完成后的房型床品使用，以及日终 Reject 补记的备用床品使用；仓库间调配和配送不会计入使用记录。"
      />
      <Space wrap style={{ marginBottom: 12 }}>
        <Select value={warehouseId} options={whOptions} onChange={setWarehouseId} style={{ minWidth: 220 }} />
        <Select value={propertyId} options={propOptions} onChange={setPropertyId} style={{ minWidth: 240 }} showSearch optionFilterProp="label" />
        <Select value={roomTypeCode} options={roomTypeOptions} onChange={setRoomTypeCode} style={{ minWidth: 160 }} />
        <Select value={linenTypeCode} options={linenTypeOptions} onChange={setLinenTypeCode} style={{ minWidth: 180 }} />
        <Select
          value={sourceType}
          onChange={setSourceType}
          style={{ minWidth: 180 }}
          options={[
            { value: '', label: '全部来源' },
            { value: 'cleaning_task_standard', label: '清洁完成自动记录' },
            { value: 'day_end_reject_usage', label: '备用床品补记' },
          ]}
        />
        <DatePicker.RangePicker value={range as any} onChange={(v) => setRange(v as any)} allowClear />
        <Button type="primary" onClick={() => load().catch((e) => message.error(e?.message || '加载失败'))}>查询</Button>
      </Space>
      <Table
        rowKey={(r) => r.id}
        columns={columns}
        dataSource={groupedRows}
        pagination={{ pageSize: 20 }}
        expandable={{
          expandedRowRender: (record: GroupedLinenUsageRow) => (
            <div style={{ padding: '4px 8px' }}>
              <Typography.Text strong style={{ display: 'block', marginBottom: 8 }}>床品明细</Typography.Text>
              <Table
                rowKey={(r) => r.id}
                columns={detailColumns}
                dataSource={record.details.slice().sort((a, b) => String(a.linen_type_code || '').localeCompare(String(b.linen_type_code || '')))}
                pagination={false}
                size="small"
              />
            </div>
          ),
          rowExpandable: (record: GroupedLinenUsageRow) => record.details.length > 0,
          expandRowByClick: true,
        }}
      />
    </Card>
  )
}
