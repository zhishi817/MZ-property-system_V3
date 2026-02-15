"use client"
import { Alert, Button, Card, Col, Drawer, Input, List, Modal, Row, Select, Space, Tag, Typography } from 'antd'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { API_BASE, getJSON, patchJSON, postJSON } from '../../../lib/api'
import { useRouter } from 'next/navigation'
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { computePeak, flattenOrdersByPlatform, type OrderLite, type Platform, type TodayBlock } from '../../../lib/cleaningOverview'

type OverviewResp = {
  date: string
  today: {
    checkins: TodayBlock
    checkouts: TodayBlock
  }
  next7days: { date: string; checkin_count: number; checkout_count: number }[]
}

type OfflineTask = {
  id: string
  date: string
  title: string
  kind: string
  status: 'todo' | 'done'
  urgency: 'low' | 'medium' | 'high' | 'urgent'
  property_id?: string | null
}

const platformLabel: Record<Platform, string> = {
  airbnb: 'Airbnb',
  booking: 'Booking',
  direct: 'Direct',
  other: '其他',
}

const urgencyColor: Record<OfflineTask['urgency'], string> = {
  low: 'default',
  medium: 'blue',
  high: 'orange',
  urgent: 'red',
}

export default function CleaningOverviewPage() {
  const router = useRouter()
  const [data, setData] = useState<OverviewResp | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [drawerTitle, setDrawerTitle] = useState('')
  const [drawerOrders, setDrawerOrders] = useState<OrderLite[]>([])
  const [offlineTasks, setOfflineTasks] = useState<OfflineTask[]>([])
  const [createOpen, setCreateOpen] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newKind, setNewKind] = useState('other')
  const [newUrgency, setNewUrgency] = useState<OfflineTask['urgency']>('medium')

  const reload = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true)
    if (!opts?.silent) setLoadError(null)
    try {
      const [resp, tasks] = await Promise.all([
        getJSON<OverviewResp>('/stats/cleaning-overview'),
        getJSON<OfflineTask[]>('/cleaning/offline-tasks'),
      ])
      setData(resp)
      setOfflineTasks(Array.isArray(tasks) ? tasks : [])
    } catch (e: any) {
      if (!opts?.silent) setLoadError(String(e?.message || '加载失败'))
    } finally {
      if (!opts?.silent) setLoading(false)
    }
  }, [])

  useEffect(() => {
    reload().catch(() => {})
  }, [reload])
  useEffect(() => {
    const id = window.setInterval(() => {
      reload({ silent: true }).catch(() => {})
    }, 5 * 60 * 1000)
    return () => window.clearInterval(id)
  }, [reload])
  useEffect(() => {
    let es: EventSource | null = null
    try {
      es = new EventSource(`${API_BASE}/events/orders`)
      es.onmessage = () => reload({ silent: true }).catch(() => {})
    } catch {}
    return () => { try { es?.close() } catch {} }
  }, [reload])

  const allTodayCheckins = useMemo(() => {
    return flattenOrdersByPlatform(data?.today?.checkins?.orders_by_platform)
  }, [data])

  const allTodayCheckouts = useMemo(() => {
    return flattenOrdersByPlatform(data?.today?.checkouts?.orders_by_platform)
  }, [data])

  const openOrders = useCallback((kind: 'checkin' | 'checkout', platform?: Platform) => {
    const base = kind === 'checkin' ? data?.today?.checkins : data?.today?.checkouts
    const orders =
      platform ? (base?.orders_by_platform?.[platform] || []) : (kind === 'checkin' ? allTodayCheckins : allTodayCheckouts)
    if (orders.length === 1) {
      router.push(`/orders/${orders[0].id}`)
      return
    }
    const titleBase = kind === 'checkin' ? '今日入住' : '今日退房'
    setDrawerTitle(platform ? `${titleBase} · ${platformLabel[platform]}` : titleBase)
    setDrawerOrders(orders)
    setDrawerOpen(true)
  }, [allTodayCheckins, allTodayCheckouts, data, router])

  const dateLabel = data?.date ? `（${data.date}）` : ''
  const peak = useMemo(() => computePeak(data?.next7days), [data])

  const updateOfflineTask = useCallback(async (id: string, patch: Partial<Pick<OfflineTask, 'status' | 'urgency' | 'title' | 'kind' | 'property_id'>>) => {
    const updated = await patchJSON<OfflineTask>(`/cleaning/offline-tasks/${id}`, patch)
    setOfflineTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...updated } : t)))
  }, [])

  const createOfflineTask = useCallback(async () => {
    const title = newTitle.trim()
    if (!title) return
    const created = await postJSON<OfflineTask>('/cleaning/offline-tasks', { title, kind: newKind, urgency: newUrgency, date: data?.date })
    setOfflineTasks((prev) => [created, ...prev])
    setCreateOpen(false)
    setNewTitle('')
    setNewKind('other')
    setNewUrgency('medium')
  }, [data?.date, newKind, newTitle, newUrgency])

  return (
    <Space direction="vertical" style={{ width: '100%' }} size={16}>
      <Card title={`清洁总览${dateLabel}`} loading={loading}>
        {loadError ? <Alert type="error" showIcon message="清洁总览数据加载失败" description={loadError} style={{ marginBottom: 12 }} /> : null}
        <Row gutter={[12, 12]}>
          <Col xs={24} md={12}>
            <Card size="small" title="今日退房数量" styles={{ body: { padding: 12 } }}>
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                <Typography.Link onClick={() => openOrders('checkout')} style={{ fontSize: 28, fontWeight: 700 }}>
                  {data?.today?.checkouts?.total ?? 0}
                </Typography.Link>
                <Space wrap>
                  {(Object.keys(platformLabel) as Platform[]).map((p) => (
                    <Tag key={p} style={{ cursor: 'pointer' }} onClick={() => openOrders('checkout', p)}>
                      {platformLabel[p]}：{data?.today?.checkouts?.by_platform?.[p] ?? 0}
                    </Tag>
                  ))}
                </Space>
              </Space>
            </Card>
          </Col>
          <Col xs={24} md={12}>
            <Card size="small" title="今日入住数量" styles={{ body: { padding: 12 } }}>
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                <Typography.Link onClick={() => openOrders('checkin')} style={{ fontSize: 28, fontWeight: 700 }}>
                  {data?.today?.checkins?.total ?? 0}
                </Typography.Link>
                <Space wrap>
                  {(Object.keys(platformLabel) as Platform[]).map((p) => (
                    <Tag key={p} style={{ cursor: 'pointer' }} onClick={() => openOrders('checkin', p)}>
                      {platformLabel[p]}：{data?.today?.checkins?.by_platform?.[p] ?? 0}
                    </Tag>
                  ))}
                </Space>
              </Space>
            </Card>
          </Col>
        </Row>
      </Card>

      <Card
        title="未来7天入住/退房趋势"
        extra={peak ? <Tag color="volcano">清洁压力峰值：{peak.date}（{peak.total}）</Tag> : null}
      >
        <div style={{ width: '100%', height: 320 }}>
          <ResponsiveContainer>
            <BarChart data={data?.next7days || []} margin={{ top: 12, right: 16, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="date" />
              <YAxis allowDecimals={false} />
              <Tooltip />
              <Legend />
              <Bar dataKey="checkout_count" name="退房" fill="#4AB1F2" />
              <Bar dataKey="checkin_count" name="入住" fill="#F98743" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <Card
        title="今日其他线下任务"
        extra={<Button onClick={() => setCreateOpen(true)}>新增任务</Button>}
      >
        <List
          dataSource={offlineTasks}
          rowKey={(t) => t.id}
          pagination={offlineTasks.length > 20 ? { pageSize: 20, size: 'small' } : false}
          renderItem={(t) => (
            <List.Item
              actions={[
                <Select
                  key="status"
                  size="small"
                  value={t.status}
                  style={{ width: 120 }}
                  options={[
                    { label: '未完成', value: 'todo' },
                    { label: '已完成', value: 'done' },
                  ]}
                  onChange={(v) => updateOfflineTask(t.id, { status: v as any }).catch(() => {})}
                />,
                <Select
                  key="urgency"
                  size="small"
                  value={t.urgency}
                  style={{ width: 120 }}
                  options={[
                    { label: '低', value: 'low' },
                    { label: '中', value: 'medium' },
                    { label: '高', value: 'high' },
                    { label: '紧急', value: 'urgent' },
                  ]}
                  onChange={(v) => updateOfflineTask(t.id, { urgency: v as any }).catch(() => {})}
                />,
              ]}
            >
              <List.Item.Meta
                title={
                  <Space wrap>
                    <span>{t.title}</span>
                    <Tag color={urgencyColor[t.urgency]}>{t.urgency === 'low' ? '低' : t.urgency === 'medium' ? '中' : t.urgency === 'high' ? '高' : '紧急'}</Tag>
                    <Tag>{t.kind}</Tag>
                  </Space>
                }
                description={t.property_id ? `房源：${t.property_id}` : null}
              />
            </List.Item>
          )}
        />
      </Card>

      <Drawer open={drawerOpen} title={drawerTitle} onClose={() => setDrawerOpen(false)} width={520}>
        <List
          dataSource={drawerOrders}
          rowKey={(o) => o.id}
          renderItem={(o) => (
            <List.Item
              actions={[
                <Typography.Link key="detail" onClick={() => router.push(`/orders/${o.id}`)}>
                  查看详情
                </Typography.Link>,
              ]}
            >
              <List.Item.Meta
                title={<span>{o.property_code || o.property_id}</span>}
                description={
                  <span>
                    {o.guest_name ? `${o.guest_name} · ` : ''}
                    {o.source || 'unknown'}
                    {o.status ? ` · ${o.status}` : ''}
                  </span>
                }
              />
            </List.Item>
          )}
        />
      </Drawer>

      <Modal
        open={createOpen}
        title="新增线下任务"
        okText="创建"
        onOk={() => createOfflineTask().catch(() => {})}
        onCancel={() => setCreateOpen(false)}
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <Input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="任务内容（例如：挂钥匙 / 换密码 / 补消耗品 / 维修 / Inspection）" />
          <Select
            value={newKind}
            onChange={setNewKind}
            options={[
              { label: '挂钥匙', value: 'key_hanging' },
              { label: '换密码', value: 'password_change' },
              { label: '补消耗品', value: 'restock' },
              { label: '维修', value: 'maintenance' },
              { label: '检查（Inspection）', value: 'inspection' },
              { label: '其他', value: 'other' },
            ]}
          />
          <Select
            value={newUrgency}
            onChange={(v) => setNewUrgency(v as any)}
            options={[
              { label: '低', value: 'low' },
              { label: '中', value: 'medium' },
              { label: '高', value: 'high' },
              { label: '紧急', value: 'urgent' },
            ]}
          />
        </Space>
      </Modal>
    </Space>
  )
}
