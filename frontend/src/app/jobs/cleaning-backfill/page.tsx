"use client"
import { Alert, Card, Table, Space, Tag, Button, App, Descriptions, Drawer, InputNumber, Select } from 'antd'
import { useEffect, useState } from 'react'
import dayjs from 'dayjs'
import { getJSON, postJSON } from '../../../lib/api'
import { hasPerm } from '../../../lib/auth'

type BackfillLock = {
  name: string
  locked_by?: string | null
  locked_until?: string | null
  heartbeat_at?: string | null
  updated_at?: string | null
} | null

type BackfillConfig = {
  lock_name: string
  lock_ttl_ms: number
  lock_renew_ms: number
  time_zone: string
  min_interval_ms: number
  fast: { enabled: boolean; cron: string; past_days: number; future_days: number; concurrency: number }
  slow: { enabled: boolean; cron: string; past_days: number; future_days: number; concurrency: number }
}

type BackfillRun = {
  id: string
  job_name: string
  schedule_name?: string | null
  trigger_source?: string | null
  run_id?: string | null
  lock_name?: string | null
  lock_acquired?: boolean | null
  skipped?: boolean | null
  skipped_reason?: string | null
  date_from?: string | null
  date_to?: string | null
  time_zone?: string | null
  concurrency?: number | null
  orders_scanned?: number | null
  orders_succeeded?: number | null
  orders_failed?: number | null
  tasks_created?: number | null
  tasks_updated?: number | null
  tasks_cancelled?: number | null
  tasks_skipped_locked?: number | null
  tasks_no_change?: number | null
  started_at?: string | null
  finished_at?: string | null
  duration_ms?: number | null
  error_message?: string | null
  result?: any
}

export default function CleaningBackfillJobsPage() {
  const { message } = App.useApp()
  const [statusLoading, setStatusLoading] = useState(false)
  const [runsLoading, setRunsLoading] = useState(false)
  const [running, setRunning] = useState(false)
  const [config, setConfig] = useState<BackfillConfig | null>(null)
  const [lock, setLock] = useState<BackfillLock>(null)
  const [runs, setRuns] = useState<BackfillRun[]>([])
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [drawerItem, setDrawerItem] = useState<BackfillRun | null>(null)
  const [mode, setMode] = useState<'fast' | 'slow' | 'custom'>('fast')
  const [pastDays, setPastDays] = useState<number>(1)
  const [futureDays, setFutureDays] = useState<number>(7)
  const [concurrency, setConcurrency] = useState<number>(10)

  async function loadStatus() {
    setStatusLoading(true)
    try {
      const j = await getJSON<{ ok: boolean; config: BackfillConfig; lock: BackfillLock }>(`/jobs/cleaning-backfill/status`)
      setConfig(j?.config || null)
      setLock(j?.lock ?? null)
      const c = j?.config
      if (c) {
        if (mode === 'fast') { setPastDays(Number(c.fast.past_days || 0)); setFutureDays(Number(c.fast.future_days || 0)); setConcurrency(Number(c.fast.concurrency || 10)) }
        if (mode === 'slow') { setPastDays(Number(c.slow.past_days || 0)); setFutureDays(Number(c.slow.future_days || 0)); setConcurrency(Number(c.slow.concurrency || 10)) }
      }
    } catch (e: any) {
      message.error('拉取状态失败')
    } finally {
      setStatusLoading(false)
    }
  }

  async function loadRuns() {
    setRunsLoading(true)
    try {
      const j = await getJSON<{ ok: boolean; items: BackfillRun[] }>(`/jobs/cleaning-backfill/runs?limit=100`)
      setRuns(Array.isArray(j?.items) ? j.items : [])
    } catch {
      message.error('拉取运行记录失败')
    } finally {
      setRunsLoading(false)
    }
  }

  async function triggerRun() {
    if (!hasPerm('order.manage')) return
    setRunning(true)
    try {
      const body: any = { schedule_name: mode }
      if (mode === 'custom') {
        body.past_days = Number(pastDays || 0)
        body.future_days = Number(futureDays || 0)
        body.concurrency = Number(concurrency || 1)
      }
      const j = await postJSON<{ ok: boolean; result: any }>(`/jobs/cleaning-backfill/run`, body)
      if (j?.ok) message.success('已触发')
      await loadStatus()
      await loadRuns()
    } catch (e: any) {
      message.error(String(e?.message || '触发失败'))
    } finally {
      setRunning(false)
    }
  }

  useEffect(() => { loadStatus(); loadRuns() }, [])

  const lockRunning = (() => {
    if (!lock?.locked_until) return false
    try { return dayjs(lock.locked_until).valueOf() > Date.now() } catch { return false }
  })()

  const anyScheduleEnabled = !!(config?.fast?.enabled || config?.slow?.enabled)
  const lastRun = runs.length ? runs[0] : null
  const lastRunAt = lastRun?.started_at ? dayjs(lastRun.started_at) : null
  const lastRunAgeHours = lastRunAt ? Math.floor((Date.now() - lastRunAt.valueOf()) / (60 * 60 * 1000)) : null

  const columns: any[] = [
    { title: '开始', dataIndex: 'started_at', render: (v: any) => v ? dayjs(v).format('YYYY-MM-DD HH:mm:ss') : '' },
    { title: '结束', dataIndex: 'finished_at', render: (v: any) => v ? dayjs(v).format('YYYY-MM-DD HH:mm:ss') : '' },
    { title: 'Schedule', dataIndex: 'schedule_name', render: (v: any) => <Tag>{String(v || '')}</Tag> },
    { title: 'Trigger', dataIndex: 'trigger_source', render: (v: any) => <Tag>{String(v || '')}</Tag> },
    { title: '窗口', render: (_: any, r: BackfillRun) => <Tag>{String(r.date_from || '')} → {String(r.date_to || '')}</Tag> },
    { title: '锁', render: (_: any, r: BackfillRun) => {
      const acq = !!r.lock_acquired
      const skipped = !!r.skipped
      if (skipped) return <Tag color="default">skipped</Tag>
      return acq ? <Tag color="green">acquired</Tag> : <Tag color="red">no</Tag>
    } },
    { title: '扫描订单', dataIndex: 'orders_scanned', render: (v: any) => <Tag color="blue">{Number(v || 0)}</Tag> },
    { title: '失败订单', dataIndex: 'orders_failed', render: (v: any) => Number(v || 0) > 0 ? <Tag color="red">{Number(v || 0)}</Tag> : <Tag>0</Tag> },
    { title: '创建', dataIndex: 'tasks_created', render: (v: any) => <Tag color="green">{Number(v || 0)}</Tag> },
    { title: '更新', dataIndex: 'tasks_updated', render: (v: any) => <Tag color="green">{Number(v || 0)}</Tag> },
    { title: '跳过(锁)', dataIndex: 'tasks_skipped_locked', render: (v: any) => <Tag>{Number(v || 0)}</Tag> },
    { title: '耗时(ms)', dataIndex: 'duration_ms', render: (v: any) => <Tag>{Number(v || 0)}</Tag> },
    { title: '错误', dataIndex: 'error_message', render: (v: any) => v ? <Tag color="red">{String(v)}</Tag> : '' },
    { title: '操作', render: (_: any, r: BackfillRun) => <Button size="small" onClick={() => { setDrawerItem(r); setDrawerOpen(true) }}>详情</Button> },
  ]

  return (
    <Card
      title="清洁回填自动化"
      extra={
        <Space>
          <Button size="small" onClick={loadStatus} disabled={statusLoading}>刷新状态</Button>
          <Button size="small" onClick={loadRuns} disabled={runsLoading}>刷新记录</Button>
        </Space>
      }
    >
      {!anyScheduleEnabled ? (
        <Alert
          type="warning"
          showIcon
          message="自动定时未启用"
          description="FAST/SLOW 均为 disabled，所以不会自动产生运行记录。请在部署环境开启 CLEANING_BACKFILL_FAST_ENABLED 或使用外部 Cron 调用 /jobs/cleaning-backfill/cron-trigger。"
          style={{ marginBottom: 12 }}
        />
      ) : (lastRunAgeHours != null && lastRunAgeHours >= 8) ? (
        <Alert
          type="warning"
          showIcon
          message="最近运行记录过旧"
          description={`最近一次记录是 ${lastRunAt ? lastRunAt.format('YYYY-MM-DD HH:mm:ss') : '-'}（约 ${lastRunAgeHours} 小时前）。若你依赖 node-cron，请确认后端/worker 进程持续运行；若依赖外部 Cron，请确认触发器配置正常。`}
          style={{ marginBottom: 12 }}
        />
      ) : null}

      <Card size="small" title="当前状态">
        <Space wrap>
          {lockRunning ? <Tag color="blue">running</Tag> : <Tag>idle</Tag>}
          {lock?.locked_by ? <Tag>owner {String(lock.locked_by)}</Tag> : null}
          {lock?.locked_until ? <Tag>until {dayjs(lock.locked_until).format('YYYY-MM-DD HH:mm:ss')}</Tag> : null}
          {lock?.heartbeat_at ? <Tag>heartbeat {dayjs(lock.heartbeat_at).format('YYYY-MM-DD HH:mm:ss')}</Tag> : null}
        </Space>
        <Descriptions bordered size="small" column={2} style={{ marginTop: 12 }}>
          <Descriptions.Item label="Time Zone">{config?.time_zone || ''}</Descriptions.Item>
          <Descriptions.Item label="Lock Name">{config?.lock_name || ''}</Descriptions.Item>
          <Descriptions.Item label="Lock TTL(ms)">{String(config?.lock_ttl_ms ?? '')}</Descriptions.Item>
          <Descriptions.Item label="Renew(ms)">{String(config?.lock_renew_ms ?? '')}</Descriptions.Item>
          <Descriptions.Item label="Min Interval(ms)">{String(config?.min_interval_ms ?? '')}</Descriptions.Item>
          <Descriptions.Item label="Fast">{config ? `${config.fast.enabled ? 'enabled' : 'disabled'} cron=${config.fast.cron} past=${config.fast.past_days} future=${config.fast.future_days} conc=${config.fast.concurrency}` : ''}</Descriptions.Item>
          <Descriptions.Item label="Slow">{config ? `${config.slow.enabled ? 'enabled' : 'disabled'} cron=${config.slow.cron} past=${config.slow.past_days} future=${config.slow.future_days} conc=${config.slow.concurrency}` : ''}</Descriptions.Item>
        </Descriptions>
      </Card>

      <Card size="small" title="手动触发" style={{ marginTop: 12 }}>
        <Space wrap>
          <Select value={mode} style={{ width: 140 }} onChange={(v) => {
            const nv = v as any
            setMode(nv)
            const c = config
            if (c && nv === 'fast') { setPastDays(Number(c.fast.past_days || 0)); setFutureDays(Number(c.fast.future_days || 0)); setConcurrency(Number(c.fast.concurrency || 10)) }
            if (c && nv === 'slow') { setPastDays(Number(c.slow.past_days || 0)); setFutureDays(Number(c.slow.future_days || 0)); setConcurrency(Number(c.slow.concurrency || 10)) }
          }} options={[{ value: 'fast', label: 'FAST' }, { value: 'slow', label: 'SLOW' }, { value: 'custom', label: '自定义' }]} />
          <span>过去天数</span>
          <InputNumber value={pastDays} min={0} max={365} onChange={(v) => setPastDays(Number(v || 0))} disabled={mode !== 'custom'} />
          <span>未来天数</span>
          <InputNumber value={futureDays} min={0} max={365} onChange={(v) => setFutureDays(Number(v || 0))} disabled={mode !== 'custom'} />
          <span>并发</span>
          <InputNumber value={concurrency} min={1} max={25} onChange={(v) => setConcurrency(Number(v || 1))} disabled={mode !== 'custom'} />
          {hasPerm('order.manage') ? <Button type="primary" onClick={triggerRun} disabled={running || lockRunning}>运行一次</Button> : <Tag color="orange">无权限</Tag>}
        </Space>
      </Card>

      <Card size="small" title="运行记录" style={{ marginTop: 12 }}>
        <Table
          size="small"
          rowKey={(r: any) => String(r.id)}
          columns={columns}
          dataSource={runs}
          loading={runsLoading}
          pagination={{ defaultPageSize: 20, showSizeChanger: true }}
          scroll={{ x: 'max-content' }}
        />
      </Card>

      <Card size="small" title="说明" style={{ marginTop: 12 }}>
        <Space direction="vertical" style={{ width: '100%' }}>
          <span>清洁回填自动化：按时间窗口扫描订单，批量补齐/修正 cleaning_tasks（幂等）。</span>
          <span>清洁同步队列：订单变更后的实时同步主链路（异步队列 + 重试 + 回收卡死任务），建议保留。</span>
          <span>清洁同步重试：历史遗留的另一套重试队列，建议迁移引用后再下线页面/接口。</span>
        </Space>
      </Card>

      <Drawer
        title="运行详情"
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        width={720}
      >
        <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {JSON.stringify(drawerItem, null, 2)}
        </pre>
      </Drawer>
    </Card>
  )
}
