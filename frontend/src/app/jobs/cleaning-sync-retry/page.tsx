"use client"
import { Card, Table, Space, Tag, Button, App, Select, InputNumber } from 'antd'
import { useEffect, useState } from 'react'
import dayjs from 'dayjs'
import { getJSON, API_BASE, authHeaders } from '../../../lib/api'
import { hasPerm } from '../../../lib/auth'

type RetryJob = {
  id: string
  order_id: string
  action: string
  status: string
  attempts: number
  max_attempts: number
  next_retry_at: string
  last_error_code?: string | null
  last_error_message?: string | null
  created_at?: string
  updated_at?: string
}

export default function CleaningSyncRetryPage() {
  const { message } = App.useApp()
  const [items, setItems] = useState<RetryJob[]>([])
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState<string>('pending')
  const [limit, setLimit] = useState<number>(50)
  const [running, setRunning] = useState(false)

  async function load() {
    setLoading(true)
    try {
      const qs = new URLSearchParams()
      if (status) qs.set('status', status)
      qs.set('limit', String(limit || 50))
      const j = await getJSON<{ items: RetryJob[] }>(`/jobs/cleaning-sync-retry-jobs?${qs.toString()}`)
      setItems(Array.isArray(j?.items) ? j.items : [])
    } catch {
      message.error('拉取失败')
    } finally {
      setLoading(false)
    }
  }

  async function retry(id: string) {
    try {
      const res = await fetch(`${API_BASE}/jobs/cleaning-sync-retry-jobs/${encodeURIComponent(id)}/retry`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify({}) })
      const j = await res.json().catch(() => null)
      if (res.ok) { message.success('已重新排队'); load() }
      else message.error(j?.message || `操作失败（HTTP ${res.status}）`)
    } catch { message.error('操作失败') }
  }

  async function runDue() {
    try {
      setRunning(true)
      const res = await fetch(`${API_BASE}/jobs/cleaning-sync-retry-jobs/run-due`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify({ limit: 10 }) })
      const j = await res.json().catch(() => null)
      if (res.ok) { message.success(`已执行：processed=${j?.processed || 0} ok=${j?.ok || 0} failed=${j?.failed || 0}`); load() }
      else message.error(j?.message || `执行失败（HTTP ${res.status}）`)
    } catch { message.error('执行失败') } finally { setRunning(false) }
  }

  useEffect(() => { load() }, [status, limit])

  const columns: any[] = [
    { title: '状态', dataIndex: 'status', render: (v: any) => {
      const s = String(v || '')
      const color = s === 'done' ? 'green' : (s === 'failed' ? 'red' : (s === 'running' ? 'blue' : 'gold'))
      return <Tag color={color}>{s}</Tag>
    } },
    { title: '订单ID', dataIndex: 'order_id', render: (v: any) => <span style={{ fontFamily: 'monospace' }}>{String(v || '')}</span> },
    { title: '动作', dataIndex: 'action' },
    { title: '重试', render: (_: any, r: RetryJob) => `${Number(r.attempts || 0)}/${Number(r.max_attempts || 0)}` },
    { title: '下次重试', dataIndex: 'next_retry_at', render: (v: any) => v ? dayjs(v).format('YYYY-MM-DD HH:mm:ss') : '' },
    { title: '错误码', dataIndex: 'last_error_code', render: (v: any) => v ? <Tag color="red">{String(v)}</Tag> : '' },
    { title: '错误信息', dataIndex: 'last_error_message', render: (v: any) => <span style={{ wordBreak: 'break-word' }}>{String(v || '')}</span> },
    { title: '更新时间', dataIndex: 'updated_at', render: (v: any) => v ? dayjs(v).format('YYYY-MM-DD HH:mm:ss') : '' },
    { title: '操作', render: (_: any, r: RetryJob) => (
      <Space>
        <Button size="small" onClick={() => retry(r.id)} disabled={!hasPerm('order.manage')}>手动重试</Button>
      </Space>
    ) },
  ]

  return (
    <Card
      title="清洁同步重试队列"
      extra={
        <Space wrap>
          <Select
            value={status}
            onChange={setStatus}
            style={{ width: 140 }}
            options={[
              { value: 'pending', label: 'pending' },
              { value: 'running', label: 'running' },
              { value: 'failed', label: 'failed' },
              { value: 'done', label: 'done' },
              { value: '', label: 'all' },
            ]}
          />
          <InputNumber min={1} max={200} value={limit} onChange={(v) => setLimit(Number(v || 50))} />
          <Button onClick={load} disabled={loading}>刷新</Button>
          <Button type="primary" onClick={runDue} disabled={!hasPerm('order.manage') || running}>执行到期重试</Button>
        </Space>
      }
    >
      <Table
        rowKey={(r: any) => String(r.id)}
        columns={columns}
        dataSource={items}
        loading={loading}
        pagination={{ defaultPageSize: 20, showSizeChanger: true }}
        scroll={{ x: 'max-content' }}
      />
    </Card>
  )
}

