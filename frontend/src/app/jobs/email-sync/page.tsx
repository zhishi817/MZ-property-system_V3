"use client"
import { Card, Table, Space, Tag, Button, App, Descriptions } from 'antd'
import { useEffect, useState } from 'react'
import dayjs from 'dayjs'
import { getJSON, postJSON, API_BASE, authHeaders } from '../../../lib/api'
import { hasPerm } from '../../../lib/auth'

type SyncRun = {
  id: number
  account: string
  scanned?: number
  matched?: number
  inserted?: number
  failed?: number
  skipped_duplicate?: number
  last_uid_before?: number
  last_uid_after?: number
  duration_ms?: number
  status?: string
  error_code?: string
  error_message?: string
  started_at?: string
  ended_at?: string
}

type StatusItem = {
  account: string
  running: boolean
  last_run: SyncRun | null
  last_uid: number
  last_connected_at?: string | null
  consecutive_failures?: number
  cooldown_until?: string | null
}

export default function EmailSyncStatusPage() {
  const { message } = App.useApp()
  const [items, setItems] = useState<StatusItem[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedAccount, setSelectedAccount] = useState<string | null>(null)
  const [runs, setRuns] = useState<SyncRun[]>([])
  const [runsLoading, setRunsLoading] = useState(false)
  const [triggering, setTriggering] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  async function loadStatus() {
    setLoading(true)
    try {
      const j = await getJSON<{ items: StatusItem[] }>(`/jobs/email-sync-status`)
      const arr = Array.isArray(j?.items) ? j.items : []
      setItems(arr)
      if (!selectedAccount && arr[0]) setSelectedAccount(arr[0].account)
    } catch (e: any) { message.error('拉取状态失败') } finally { setLoading(false) }
  }
  async function loadRuns(acc?: string) {
    const account = acc || selectedAccount
    if (!account) return
    setRunsLoading(true)
    try {
      const j = await getJSON<{ items: SyncRun[], notice?: string }>(`/jobs/email-sync-runs?account=${encodeURIComponent(account)}&limit=50`)
      setRuns(Array.isArray(j?.items) ? j.items : [])
      setNotice(j?.notice || null)
    } catch { message.error('拉取运行记录失败') } finally { setRunsLoading(false) }
  }
  async function triggerSync(acc?: string) {
    const account = acc || selectedAccount
    try {
      setTriggering(true)
      const body = { mode: 'incremental', max_per_run: 100, batch_size: 20, concurrency: 3, batch_sleep_ms: 500 }
      const res = await fetch(`${API_BASE}/jobs/email-sync-airbnb`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(body) })
      const j = await res.json().catch(()=>null)
      if (res.status === 409) {
        const r = String(j?.reason||'')
        if (r==='cooldown') message.warning(`冷却中，cooldown_until=${String(j?.cooldown_until||'')}`)
        else if (r==='min_interval') message.warning(`未到最小间隔，next_allowed_at=${String(j?.next_allowed_at||'')}`)
        else message.warning(`有任务正在运行，运行开始时间=${String(j?.running_since||'')}`)
      }
      else if (res.status === 429) { message.warning(`冷却中，cooldown_until=${String(j?.cooldown_until||'')}`) }
      else if (res.ok) { message.success('已触发同步'); loadStatus(); loadRuns(account || undefined) }
      else { message.error(j?.message || `触发失败（HTTP ${res.status}）`) }
    } catch { message.error('触发失败') } finally { setTriggering(false) }
  }

  useEffect(() => { loadStatus() }, [])
  useEffect(() => { loadRuns() }, [selectedAccount])

  const columns = [
    { title: '账户', dataIndex: 'account' },
    { title: '运行中', dataIndex: 'running', render: (v: boolean) => v ? <Tag color="blue">running</Tag> : <Tag>idle</Tag> },
    { title: '最近运行', render: (_: any, r: StatusItem) => {
      const lr = r.last_run
      if (!lr) return <span>无</span>
      const dur = Number(lr.duration_ms || 0)
      return (
        <Space wrap>
          <Tag color={lr.status==='completed'?'green':(lr.status==='failed'?'red':'blue')}>{lr.status || ''}</Tag>
          <Tag>扫描 {Number(lr.scanned||0)}</Tag>
          <Tag color="green">命中 {Number(lr.matched||0)}</Tag>
          <Tag>新增 {Number(lr.inserted||0)}</Tag>
          <Tag>重复 {Number(lr.skipped_duplicate||0)}</Tag>
          <Tag color="red">失败 {Number(lr.failed||0)}</Tag>
          <Tag>耗时 {dur}ms</Tag>
        </Space>
      )
    } },
    { title: '断点 last_uid', dataIndex: 'last_uid' },
    { title: '最小间隔上次连接', dataIndex: 'last_connected_at', render: (v: any) => v ? dayjs(v).format('YYYY-MM-DD HH:mm') : '' },
    { title: '失败次数', dataIndex: 'consecutive_failures' },
    { title: '冷却到', dataIndex: 'cooldown_until', render: (v: any) => v ? <Tag color="orange">{dayjs(v).format('YYYY-MM-DD HH:mm')}</Tag> : '' },
    { title: '操作', render: (_: any, r: StatusItem) => (
      <Space>
        <Button size="small" onClick={() => setSelectedAccount(r.account)}>查看记录</Button>
        {hasPerm('order.manage') ? <Button size="small" type="primary" onClick={() => triggerSync(r.account)} disabled={r.running || triggering}>触发同步</Button> : null}
      </Space>
    ) },
  ];

  const runCols = [
    { title: 'RunID', dataIndex: 'run_id', render: (v:any)=> <span style={{ fontFamily: 'monospace' }}>{String(v||'')}</span> },
    { title: '创建时间', dataIndex: 'created_at', render: (v:any)=> v ? dayjs(v).format('YYYY-MM-DD HH:mm:ss') : '', sorter: (a:any,b:any)=> dayjs(a.created_at).valueOf() - dayjs(b.created_at).valueOf(), defaultSortOrder: 'descend' },
    { title: '开始', dataIndex: 'started_at', render: (v:any)=> v ? dayjs(v).format('YYYY-MM-DD HH:mm:ss') : '' },
    { title: '结束', dataIndex: 'ended_at', render: (v:any)=> v ? dayjs(v).format('YYYY-MM-DD HH:mm:ss') : '' },
    { title: '状态', dataIndex: 'status', render: (v:any)=> <Tag color={v==='completed'?'green':(v==='failed'?'red':'blue')}>{String(v||'')}</Tag> },
    { title: '提示', dataIndex: 'error_code', render: (_:any, row:any)=> {
      const scanned = Number(row?.scanned || 0)
      const code = String(row?.error_code || '')
      const lastUid = row?.last_uid_before != null ? String(row.last_uid_before) : ''
      if (scanned === 0 && code === 'no_new_uid') {
        return <Tag color="default">本次无新邮件（last_uid={lastUid}）</Tag>
      }
      return null
    } },
    { title: '扫描', dataIndex: 'scanned' },
    { title: '命中', dataIndex: 'matched' },
    { title: '新增', dataIndex: 'inserted' },
    { title: '重复', dataIndex: 'skipped_duplicate' },
    { title: '失败', dataIndex: 'failed' },
    { title: '断点前', dataIndex: 'last_uid_before' },
    { title: '断点后', dataIndex: 'last_uid_after' },
    { title: '错误代码', dataIndex: 'error_code', render: (v:any)=> v ? <Tag color="red">{String(v)}</Tag> : '' },
    { title: '错误描述', dataIndex: 'error_message', render: (v:any)=> <span style={{ wordBreak:'break-word' }}>{String(v||'')}</span> },
    { title: '耗时(ms)', dataIndex: 'duration_ms' },
  ];

  return (
    <Card title="邮件同步状态" extra={<Space><Button size="small" onClick={loadStatus} disabled={loading}>刷新</Button>{selectedAccount ? <Button size="small" onClick={()=> loadRuns(selectedAccount!)} disabled={runsLoading}>刷新记录</Button> : null}{selectedAccount && hasPerm('order.manage') ? <Button size="small" type="primary" onClick={()=> triggerSync(selectedAccount!)}>触发同步</Button> : null}</Space>}>
      <Table rowKey={(r:any)=> String(r.account)} columns={columns as any} dataSource={items} loading={loading} pagination={{ defaultPageSize: 10, showSizeChanger: true }} scroll={{ x: 'max-content' }} />
      <Card size="small" style={{ marginTop: 12 }} title={`运行记录${selectedAccount ? `（${selectedAccount}）` : ''}`}>
        {notice==='no_runs_yet' ? <Tag color="gold">尚未发生任何同步运行</Tag> : null}
        <Table size="small" rowKey={(r:any)=> String((r as any).id || (r as any).run_id)} columns={runCols as any} dataSource={runs} loading={runsLoading} pagination={{ defaultPageSize: 10, showSizeChanger: true }} scroll={{ x: 'max-content' }} />
      </Card>
      <Card size="small" style={{ marginTop: 12 }} title="接口说明">
        <Descriptions bordered size="small" column={1}>
          <Descriptions.Item label="状态总览">GET `/jobs/email-sync-status`</Descriptions.Item>
          <Descriptions.Item label="运行记录">GET `/jobs/email-sync-runs?account=&lt;email&gt;&limit=50`</Descriptions.Item>
          <Descriptions.Item label="触发同步">POST `/jobs/email-sync-airbnb`</Descriptions.Item>
        </Descriptions>
      </Card>
    </Card>
  )
}