"use client"

import { App, Button, Card, DatePicker, Descriptions, Drawer, Image, Input, Select, Space, Table, Tag } from 'antd'
import { useEffect, useMemo, useState } from 'react'
import dayjs, { type Dayjs } from 'dayjs'
import { getJSON } from '../../../lib/api'

type PropertyRow = {
  id: string
  code?: string | null
  address?: string | null
}

type ConsumableItemRow = {
  id: string
  item_name: string
  sku?: string | null
}

type UsageRow = {
  id: string
  task_id: string
  item_id: string
  item_name: string
  status: string
  quantity: number
  note?: string | null
  photo_url?: string | null
  created_at?: string | null
  occurred_on?: string | null
  property_id?: string | null
  property_code?: string | null
  property_address?: string | null
  submitter_name?: string | null
}

export default function ConsumableUsageRecordsView() {
  const { message } = App.useApp()
  const [rows, setRows] = useState<UsageRow[]>([])
  const [properties, setProperties] = useState<PropertyRow[]>([])
  const [items, setItems] = useState<ConsumableItemRow[]>([])
  const [loading, setLoading] = useState(false)
  const [propertyId, setPropertyId] = useState('')
  const [itemId, setItemId] = useState('')
  const [keyword, setKeyword] = useState('')
  const [range, setRange] = useState<[Dayjs, Dayjs] | null>([dayjs().subtract(30, 'day'), dayjs()])
  const [detailOpen, setDetailOpen] = useState(false)
  const [detailRow, setDetailRow] = useState<UsageRow | null>(null)

  async function loadBase() {
    const [propertyRows, itemRows] = await Promise.all([
      getJSON<PropertyRow[]>('/properties'),
      getJSON<ConsumableItemRow[]>('/inventory/consumable-items-prices'),
    ])
    setProperties(propertyRows || [])
    setItems(itemRows || [])
  }

  async function load() {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (propertyId) params.set('property_id', propertyId)
      if (itemId) params.set('item_id', itemId)
      if (keyword.trim()) params.set('keyword', keyword.trim())
      if (range?.[0]) params.set('from', range[0].format('YYYY-MM-DD'))
      if (range?.[1]) params.set('to', range[1].format('YYYY-MM-DD'))
      const data = await getJSON<UsageRow[]>(`/inventory/consumable-usage-records?${params.toString()}`)
      setRows(data || [])
    } catch (e: any) {
      message.error(e?.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadBase()
      .then(() => load())
      .catch((e) => message.error(e?.message || '加载失败'))
  }, [])

  const propertyOptions = useMemo(
    () => [{ value: '', label: '全部房源' }, ...(properties || []).map((row) => ({ value: row.id, label: row.code || row.address || row.id }))],
    [properties],
  )

  const itemOptions = useMemo(
    () => [{ value: '', label: '全部消耗品' }, ...(items || []).map((row) => ({ value: row.id, label: row.item_name }))],
    [items],
  )

  const columns: any[] = [
    {
      title: '日期',
      dataIndex: 'occurred_on',
      width: 120,
      render: (value: string | null | undefined, row: UsageRow) => {
        const raw = value || row.created_at || ''
        return raw ? dayjs(raw).format('YYYY-MM-DD') : '-'
      },
    },
    {
      title: '房号',
      dataIndex: 'property_code',
      width: 120,
      render: (value: string | null | undefined) => value || '-',
    },
    {
      title: '消耗品',
      dataIndex: 'item_name',
      render: (_: any, row: UsageRow) => (
        <div style={{ display: 'grid', gap: 2 }}>
          <span>{row.item_name || '-'}</span>
          {row.property_address ? <span style={{ color: '#8c8c8c', fontSize: 12 }}>{row.property_address}</span> : null}
        </div>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (value: string) => value === 'low' ? <Tag color="orange">不足</Tag> : <Tag>{value || '-'}</Tag>,
    },
    { title: '数量', dataIndex: 'quantity', width: 90 },
    { title: '提交人', dataIndex: 'submitter_name', width: 120, render: (value: string | null | undefined) => value || '-' },
    { title: '备注', dataIndex: 'note', ellipsis: true, render: (value: string | null | undefined) => value || '-' },
    {
      title: '照片',
      width: 90,
      render: (_: any, row: UsageRow) => row.photo_url ? <Tag color="blue">已上传</Tag> : '-',
    },
    {
      title: '操作',
      width: 100,
      render: (_: any, row: UsageRow) => <Button onClick={() => { setDetailRow(row); setDetailOpen(true) }}>详情</Button>,
    },
  ]

  return (
    <>
      <Card title="消耗品使用记录">
        <Space wrap style={{ marginBottom: 12 }}>
          <Select value={propertyId} options={propertyOptions} onChange={setPropertyId} style={{ minWidth: 180 }} showSearch optionFilterProp="label" />
          <Select value={itemId} options={itemOptions} onChange={setItemId} style={{ minWidth: 200 }} showSearch optionFilterProp="label" />
          <DatePicker.RangePicker value={range as any} onChange={(value) => setRange(value as any)} allowClear />
          <Input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="房号 / 物品 / 备注搜索" style={{ width: 220 }} />
          <Button type="primary" onClick={() => load().catch(() => {})}>查询</Button>
        </Space>
        <Table rowKey={(row) => row.id} loading={loading} columns={columns} dataSource={rows} pagination={{ pageSize: 20 }} scroll={{ x: 980 }} />
      </Card>

      <Drawer
        title="消耗品使用详情"
        placement="right"
        width={640}
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        extra={<Button onClick={() => setDetailOpen(false)}>取消</Button>}
      >
        {detailRow ? (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Descriptions bordered column={2} labelStyle={{ width: 110 }}>
              <Descriptions.Item label="日期">{detailRow.occurred_on ? dayjs(detailRow.occurred_on).format('YYYY-MM-DD') : '-'}</Descriptions.Item>
              <Descriptions.Item label="房号">{detailRow.property_code || '-'}</Descriptions.Item>
              <Descriptions.Item label="消耗品">{detailRow.item_name || '-'}</Descriptions.Item>
              <Descriptions.Item label="数量">{detailRow.quantity ?? '-'}</Descriptions.Item>
              <Descriptions.Item label="状态">{detailRow.status === 'low' ? '不足' : detailRow.status || '-'}</Descriptions.Item>
              <Descriptions.Item label="提交人">{detailRow.submitter_name || '-'}</Descriptions.Item>
              <Descriptions.Item label="备注" span={2}>{detailRow.note || '-'}</Descriptions.Item>
            </Descriptions>
            {detailRow.photo_url ? (
              <div>
                <div style={{ fontWeight: 500, marginBottom: 8 }}>现场照片</div>
                <Image src={detailRow.photo_url} alt="现场照片" width={220} />
              </div>
            ) : null}
          </Space>
        ) : null}
      </Drawer>
    </>
  )
}
