"use client"
import { Card, Table, Space, Select, Button, DatePicker, message, Tag, Input, Modal, Image } from 'antd'
import { useEffect, useMemo, useState } from 'react'
import dayjs from 'dayjs'
import { getJSON } from '../../../../../lib/api'

type PropertyRow = { id: string; code?: string | null; address?: string | null }
type ReplacementRow = {
  id: string
  property_id?: string | null
  property_code?: string | null
  property_address?: string | null
  status?: string | null
  item_name?: string | null
  quantity?: number | null
  note?: string | null
  photo_urls?: string[] | null
  submitter_name?: string | null
  submitted_at?: string | null
  created_at?: string | null
}

export default function DailyReplacementsPage() {
  const [properties, setProperties] = useState<PropertyRow[]>([])
  const [rows, setRows] = useState<ReplacementRow[]>([])
  const [propertyId, setPropertyId] = useState<string>('')
  const [status, setStatus] = useState<string>('need_replace,in_progress')
  const [range, setRange] = useState<[any, any] | null>(null)
  const [q, setQ] = useState<string>('')
  const [viewerOpen, setViewerOpen] = useState(false)
  const [viewerUrls, setViewerUrls] = useState<string[]>([])

  async function loadBase() {
    const ps = await getJSON<PropertyRow[]>('/properties')
    setProperties(ps || [])
  }

  async function load() {
    const params: Record<string, string> = { limit: '200' }
    if (propertyId) params.property_id = propertyId
    if (status) params.status = status
    if (range?.[0]) params.from = dayjs(range[0]).toISOString()
    if (range?.[1]) params.to = dayjs(range[1]).toISOString()
    const data = await getJSON<ReplacementRow[]>(`/inventory/daily-replacements?${new URLSearchParams(params as any).toString()}`)
    const filtered = q
      ? (data || []).filter(r => `${r.property_code || ''} ${r.property_address || ''} ${r.item_name || ''} ${r.note || ''}`.toLowerCase().includes(q.toLowerCase()))
      : (data || [])
    setRows(filtered)
  }

  useEffect(() => { loadBase().then(() => load()).catch((e) => message.error(e?.message || '加载失败')) }, [])

  const propOptions = useMemo(
    () => [{ value: '', label: '全部房源' }, ...(properties || []).map(p => ({ value: p.id, label: `${p.code || ''} ${p.address || ''}`.trim() }))],
    [properties],
  )

  const statusOptions = [
    { value: 'need_replace,in_progress', label: '待处理+处理中' },
    { value: 'need_replace', label: '需更换' },
    { value: 'in_progress', label: '处理中' },
    { value: 'replaced', label: '已更换' },
    { value: 'no_action', label: '无需处理' },
    { value: 'need_replace,in_progress,replaced,no_action', label: '全部' },
  ]

  const statusTag = (v: any) => {
    const s = String(v || '').trim()
    if (s === 'need_replace') return <Tag color="red">需更换</Tag>
    if (s === 'in_progress') return <Tag color="orange">处理中</Tag>
    if (s === 'replaced') return <Tag color="green">已更换</Tag>
    if (s === 'no_action') return <Tag>无需处理</Tag>
    return <Tag>{s || '-'}</Tag>
  }

  const columns: any[] = [
    { title: '时间', dataIndex: 'submitted_at', render: (_: any, r: ReplacementRow) => dayjs(r.submitted_at || r.created_at).format('YYYY-MM-DD HH:mm') },
    { title: '房源', dataIndex: 'property_code', render: (_: any, r: ReplacementRow) => `${r.property_code || ''} ${r.property_address || ''}`.trim() || '-' },
    { title: '状态', dataIndex: 'status', render: statusTag },
    { title: '物品名称', dataIndex: 'item_name' },
    { title: '数量', dataIndex: 'quantity', render: (v: any) => (v == null ? '-' : v) },
    { title: '备注', dataIndex: 'note', render: (v: any) => (v ? String(v) : '-') },
    {
      title: '附件',
      dataIndex: 'photo_urls',
      render: (_: any, r: ReplacementRow) => {
        const urls = Array.isArray(r.photo_urls) ? r.photo_urls.filter(Boolean) : []
        if (!urls.length) return '-'
        return (
          <Button
            type="link"
            onClick={() => {
              setViewerUrls(urls)
              setViewerOpen(true)
            }}
          >
            查看({urls.length})
          </Button>
        )
      },
    },
    { title: '提交人', dataIndex: 'submitter_name', render: (v: any) => (v ? String(v) : '-') },
  ]

  return (
    <>
      <Card title="日用品更换记录">
        <Space wrap style={{ marginBottom: 12 }}>
          <Select value={propertyId} options={propOptions} onChange={setPropertyId} style={{ minWidth: 260 }} showSearch optionFilterProp="label" />
          <Select value={status} options={statusOptions} onChange={setStatus} style={{ width: 180 }} />
          <DatePicker.RangePicker value={range as any} onChange={(v) => setRange(v as any)} allowClear />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="关键字筛选" style={{ width: 180 }} allowClear />
          <Button type="primary" onClick={() => load().catch((e) => message.error(e?.message || '加载失败'))}>查询</Button>
        </Space>
        <Table rowKey={(r) => r.id} columns={columns} dataSource={rows} pagination={{ pageSize: 20 }} />
      </Card>

      <Modal open={viewerOpen} onCancel={() => setViewerOpen(false)} footer={null} width={860}>
        <Image.PreviewGroup items={viewerUrls}>
          <Space wrap>
            {viewerUrls.map((u) => (
              <Image key={u} src={u} width={240} />
            ))}
          </Space>
        </Image.PreviewGroup>
      </Modal>
    </>
  )
}

