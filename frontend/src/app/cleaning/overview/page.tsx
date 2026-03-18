"use client"
import { Alert, Button, DatePicker, Drawer, Form, Input, Popconfirm, Select, Space, message } from 'antd'
import { useCallback, useEffect, useState } from 'react'
import dayjs, { type Dayjs } from 'dayjs'
import utc from 'dayjs/plugin/utc'
import timezone from 'dayjs/plugin/timezone'
import { API_BASE, deleteJSON, getJSON, patchJSON } from '../../../lib/api'
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { sortProperties } from '../../../lib/properties'
import { ClockCircleOutlined, DeleteOutlined, EditOutlined, EyeOutlined, RiseOutlined } from '@ant-design/icons'
import styles from './cleaningOverview.module.scss'

type OverviewResp = {
  date: string
  today: {
    total: number
    unassigned: number
    by_status: {
      pending: number
      assigned: number
      in_progress: number
      completed: number
      cancelled: number
    }
  }
  next7days: { date: string; check_out_count: number; check_in_count: number }[]
}

type OfflineTask = {
  id: string
  date: string
  task_type: 'property' | 'company' | 'other'
  title: string
  content?: string | null
  kind: string
  status: 'todo' | 'done'
  urgency: 'low' | 'medium' | 'high' | 'urgent'
  property_id?: string | null
  assignee_id?: string | null
}

type StaffLite = { id: string; name: string }
type PropertyLite = { id: string; code?: string; address?: string }
type CleaningHistoryRow = {
  id: string
  task_date?: string | null
  date?: string | null
  task_type?: string | null
  type?: string | null
  status?: string | null
  assignee_id?: string | null
  cleaner_id?: string | null
  inspector_id?: string | null
  checkout_time?: string | null
  checkin_time?: string | null
  note?: string | null
  property_id?: string | null
  property_code?: string | null
  property_region?: string | null
}

type CleaningHistoryDisplayRow =
  | { kind: 'single'; key: string; dateStr: string; row: CleaningHistoryRow }
  | { kind: 'turnover'; key: string; dateStr: string; checkout: CleaningHistoryRow; checkin: CleaningHistoryRow }

const kindLabel: Record<string, string> = {
  key_hanging: '挂钥匙',
  password_change: '换密码',
  restock: '补消耗品',
  maintenance: '维修',
  inspection: '检查（Inspection）',
  other: '其他',
}

dayjs.extend(utc)
dayjs.extend(timezone)
dayjs.tz.setDefault('Australia/Melbourne')

export default function CleaningOverviewPage() {
  const [data, setData] = useState<OverviewResp | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [offlineTasks, setOfflineTasks] = useState<OfflineTask[]>([])
  const [staff, setStaff] = useState<StaffLite[]>([])
  const [properties, setProperties] = useState<PropertyLite[]>([])
  const [editForm] = Form.useForm()
  const [editOpen, setEditOpen] = useState(false)
  const [editing, setEditing] = useState<OfflineTask | null>(null)
  const [dbStatus, setDbStatus] = useState<any>(null)
  const [historyPropertyId, setHistoryPropertyId] = useState<string | null>(null)
  const [historyRange, setHistoryRange] = useState<[Dayjs, Dayjs]>(() => [dayjs().subtract(180, 'day'), dayjs()])
  const [historyRows, setHistoryRows] = useState<CleaningHistoryDisplayRow[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)

  const reload = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoadError(null)
    try {
      const resp = await getJSON<OverviewResp>('/stats/cleaning-overview')
      const tasks = await getJSON<OfflineTask[]>(`/cleaning/offline-tasks?date=${encodeURIComponent(resp.date)}&include_overdue=1`)
      setData(resp)
      setOfflineTasks(Array.isArray(tasks) ? tasks : [])
    } catch (e: any) {
      if (!opts?.silent) setLoadError(String(e?.message || '加载失败'))
    }
  }, [])

  useEffect(() => {
    reload().catch(() => {})
  }, [reload])
  useEffect(() => {
    getJSON<StaffLite[]>('/cleaning/staff')
      .then((rows) => setStaff(Array.isArray(rows) ? rows : []))
      .catch(() => setStaff([]))
    getJSON<PropertyLite[]>('/properties')
      .then((rows) => setProperties(Array.isArray(rows) ? rows : []))
      .catch(() => setProperties([]))
    getJSON<any>('/health/db').then(setDbStatus).catch(() => setDbStatus(null))
  }, [])
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

  const dateLabel = data?.date ? `（${data.date}）` : ''
  const viewDate = data?.date || dayjs().format('YYYY-MM-DD')
  const today = data?.today

  const updateOfflineTask = useCallback(async (id: string, patch: Partial<Pick<OfflineTask, 'status' | 'urgency' | 'title' | 'content' | 'kind' | 'property_id' | 'task_type' | 'assignee_id' | 'date'>>) => {
    const updated = await patchJSON<OfflineTask>(`/cleaning/offline-tasks/${id}`, patch)
    setOfflineTasks((prev) => {
      const next = prev.map((t) => (t.id === id ? { ...t, ...updated } : t))
      const u = next.find((t) => t.id === id)
      if (u && String(u.date).slice(0, 10) !== viewDate) return next.filter((t) => t.id !== id)
      return next
    })
    return updated
  }, [viewDate])

  const openEdit = useCallback((t: OfflineTask) => {
    setEditing(t)
    setEditOpen(true)
    editForm.setFieldsValue({
      date: dayjs(String(t.date).slice(0, 10)),
      task_type: t.task_type || 'other',
      title: t.title || '',
      content: t.content || '',
      kind: t.kind || 'other',
      urgency: t.urgency || 'medium',
      property_id: t.property_id || undefined,
      assignee_id: t.assignee_id || undefined,
      status: t.status,
    })
  }, [editForm])

  const saveEdit = useCallback(async () => {
    if (!editing) return
    const v = await editForm.validateFields()
    const patch: any = {
      date: v.date ? dayjs(v.date).format('YYYY-MM-DD') : undefined,
      task_type: v.task_type,
      title: String(v.title || '').trim(),
      content: String(v.content || '').trim(),
      kind: v.kind,
      urgency: v.urgency,
      status: v.status,
      property_id: v.task_type === 'property' ? (v.property_id || null) : null,
      assignee_id: v.assignee_id || null,
    }
    const updated = await updateOfflineTask(editing.id, patch)
    setEditing(updated)
    if (String(updated.date).slice(0, 10) !== viewDate) setEditOpen(false)
    message.success('已保存')
  }, [editForm, editing, updateOfflineTask, viewDate])

  const deleteOfflineTask = useCallback(async (id: string) => {
    await deleteJSON(`/cleaning/offline-tasks/${id}`)
    setOfflineTasks((prev) => prev.filter((t) => t.id !== id))
    if (editing?.id === id) setEditOpen(false)
    message.success('已删除')
  }, [editing?.id])

  const staffNameById = useCallback((id?: string | null) => {
    if (!id) return null
    return staff.find((s) => String(s.id) === String(id))?.name || String(id)
  }, [staff])

  const propertyLabelById = useCallback((id?: string | null) => {
    if (!id) return null
    const p = properties.find((x) => String(x.id) === String(id))
    return p ? (p.code || p.address || p.id) : String(id)
  }, [properties])

  const taskTypeLabel = useCallback((t: CleaningHistoryRow) => {
    const tt = String(t.task_type || t.type || '').toLowerCase()
    if (tt === 'stayover_clean') return '清洁'
    if (tt.startsWith('checkout')) return '退房清洁'
    if (tt.startsWith('checkin')) return '入住清洁'
    if (tt.includes('turnover')) return '退房+入住'
    return tt || '-'
  }, [])

  const mergeHistory = useCallback((rows: CleaningHistoryRow[]): CleaningHistoryDisplayRow[] => {
    const isCheckout = (t: CleaningHistoryRow) => String(t.task_type || t.type || '').toLowerCase().startsWith('checkout')
    const isCheckin = (t: CleaningHistoryRow) => String(t.task_type || t.type || '').toLowerCase().startsWith('checkin')
    const buckets = new Map<string, { checkout: CleaningHistoryRow | null; checkin: CleaningHistoryRow | null; singles: CleaningHistoryRow[] }>()
    const order: string[] = []
    for (const r of rows) {
      const dateStr = String(r.task_date || r.date || '').slice(0, 10)
      if (!dateStr) continue
      let b = buckets.get(dateStr)
      if (!b) {
        b = { checkout: null, checkin: null, singles: [] }
        buckets.set(dateStr, b)
        order.push(dateStr)
      }
      if (isCheckout(r)) {
        if (!b.checkout) b.checkout = r
        else b.singles.push(r)
        continue
      }
      if (isCheckin(r)) {
        if (!b.checkin) b.checkin = r
        else b.singles.push(r)
        continue
      }
      b.singles.push(r)
    }
    const out: CleaningHistoryDisplayRow[] = []
    for (const dateStr of order) {
      const b = buckets.get(dateStr)
      if (!b) continue
      if (b.checkout && b.checkin) {
        out.push({ kind: 'turnover', key: `${dateStr}:turnover:${b.checkout.id}:${b.checkin.id}`, dateStr, checkout: b.checkout, checkin: b.checkin })
      } else if (b.checkout) {
        out.push({ kind: 'single', key: b.checkout.id, dateStr, row: b.checkout })
      } else if (b.checkin) {
        out.push({ kind: 'single', key: b.checkin.id, dateStr, row: b.checkin })
      }
      for (const s of b.singles) out.push({ kind: 'single', key: s.id, dateStr, row: s })
    }
    return out
  }, [])

  const loadHistory = useCallback(async () => {
    if (!historyPropertyId) {
      setHistoryRows([])
      return
    }
    setHistoryLoading(true)
    try {
      const from = historyRange?.[0] ? dayjs(historyRange[0]).format('YYYY-MM-DD') : undefined
      const to = historyRange?.[1] ? dayjs(historyRange[1]).format('YYYY-MM-DD') : undefined
      const qs = new URLSearchParams()
      qs.set('property_id', historyPropertyId)
      if (from) qs.set('from', from)
      if (to) qs.set('to', to)
      qs.set('limit', '500')
      const rows = await getJSON<CleaningHistoryRow[]>(`/cleaning/history?${qs.toString()}`)
      setHistoryRows(mergeHistory(Array.isArray(rows) ? rows : []))
    } catch (e: any) {
      setHistoryRows([])
      message.error(String(e?.message || '加载失败'))
    } finally {
      setHistoryLoading(false)
    }
  }, [historyPropertyId, historyRange, mergeHistory])

  const weekLabel = useCallback((dateStr: string) => {
    const d = dayjs.tz(`${String(dateStr).slice(0, 10)}T00:00:00`, 'Australia/Melbourne')
    const map = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
    return map[d.day()] || ''
  }, [])

  return (
    <div className={styles.page}>
      <div className={styles.container}>
        <div className={styles.topTitle}>清洁总览{dateLabel}</div>
        {loadError ? <Alert type="error" showIcon message="清洁总览数据加载失败" description={loadError} /> : null}
        {dbStatus && dbStatus.pg === false ? <Alert type="warning" showIcon message="后端未连接数据库" description={String(dbStatus.pg_error || 'pg=false')} /> : null}

        <div className={styles.row2} aria-label="统计卡片">
          <div className={`${styles.card} ${styles.metricCard}`} aria-label="今日清洁任务">
            <div className={styles.metricHead}>
              <div className={styles.metricTitle}>今日清洁任务</div>
              <div className={styles.metricIcon} aria-hidden="true">
                <RiseOutlined />
              </div>
            </div>
            <div className={styles.metricValue}>
              {today?.total ?? 0}
              <span className={styles.metricUnit}>间</span>
            </div>
            <div className={styles.divider} aria-hidden="true" />
            <div className={styles.platformGrid} aria-label="状态拆分">
              <div><div className={styles.platformK}>PENDING</div><div className={styles.platformV}>{today?.by_status?.pending ?? 0}</div></div>
              <div><div className={styles.platformK}>ASSIGNED</div><div className={styles.platformV}>{today?.by_status?.assigned ?? 0}</div></div>
              <div><div className={styles.platformK}>IN PROGRESS</div><div className={styles.platformV}>{today?.by_status?.in_progress ?? 0}</div></div>
              <div><div className={styles.platformK}>COMPLETED</div><div className={styles.platformV}>{today?.by_status?.completed ?? 0}</div></div>
            </div>
          </div>

          <div className={`${styles.card} ${styles.metricCard}`} aria-label="今日未分配数量">
            <div className={styles.metricHead}>
              <div className={styles.metricTitle}>今日未分配</div>
              <div className={`${styles.metricIcon} ${styles.metricIconOrange}`} aria-hidden="true">
                <RiseOutlined />
              </div>
            </div>
            <div className={`${styles.metricValue} ${styles.metricValueOrange}`}>
              {today?.unassigned ?? 0}
              <span className={styles.metricUnit}>个</span>
            </div>
            <div className={styles.divider} aria-hidden="true" />
            <div className={styles.platformGrid} aria-label="今日取消/完成">
              <div><div className={styles.platformK}>CANCELLED</div><div className={styles.platformV}>{today?.by_status?.cancelled ?? 0}</div></div>
              <div><div className={styles.platformK}>COMPLETED</div><div className={styles.platformV}>{today?.by_status?.completed ?? 0}</div></div>
            </div>
          </div>
        </div>

        <div className={`${styles.card} ${styles.sectionCard}`} aria-label="未来7天清洁任务趋势">
          <div className={styles.cardHead}>
            <div className={styles.cardTitle}>未来 7 天清洁任务趋势</div>
          </div>
          <div className={styles.chartWrap}>
            <div className={styles.chartBox}>
              <ResponsiveContainer>
                <BarChart
                  data={data?.next7days || []}
                  margin={{ top: 18, right: 18, left: 8, bottom: 22 }}
                  barCategoryGap={26}
                  barGap={6}
                >
                  <CartesianGrid stroke="var(--clean-overview-divider)" strokeDasharray="2 6" vertical={false} />
                  <XAxis
                    dataKey="date"
                    axisLine={false}
                    tickLine={false}
                    height={44}
                    tickMargin={10}
                    tick={({ x, y, payload }: any) => {
                      const v = String(payload?.value || '')
                      const top = dayjs(v).format('MM-DD')
                      const bottom = weekLabel(v)
                      return (
                        <g transform={`translate(${x},${y})`}>
                          <text x={0} y={0} textAnchor="middle" fill="var(--clean-overview-subtle)" fontSize={12} fontWeight={600}>
                            <tspan x={0} dy={0}>{top}</tspan>
                            <tspan x={0} dy={14}>{bottom}</tspan>
                          </text>
                        </g>
                      )
                    }}
                  />
                  <YAxis allowDecimals={false} axisLine={false} tickLine={false} tick={{ fill: 'var(--clean-overview-subtle)', fontSize: 12, fontWeight: 600 }} />
                  <Tooltip
                    labelFormatter={(v) => {
                      const ds = String(v || '')
                      return `${ds} ${weekLabel(ds)}`
                    }}
                  />
                  <Legend
                    verticalAlign="top"
                    align="right"
                    content={() => (
                      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 14, padding: '0 6px 4px' }}>
                        <span className={styles.legendItem}><span className={`${styles.dot} ${styles.dotBlue}`} />退房</span>
                        <span className={styles.legendItem}><span className={`${styles.dot} ${styles.dotOrange}`} />入住</span>
                      </div>
                    )}
                  />
                  <Bar dataKey="check_out_count" name="退房" fill="var(--clean-overview-blue)" radius={[6, 6, 0, 0]} maxBarSize={36} />
                  <Bar dataKey="check_in_count" name="入住" fill="var(--clean-overview-orange)" radius={[6, 6, 0, 0]} maxBarSize={36} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>

        <div className={`${styles.card} ${styles.sectionCard}`} aria-label="房源清洁历史">
          <div className={styles.cardHead}>
            <div className={styles.taskHeaderLeft}>
              <div className={styles.cardTitle}>房源清洁历史</div>
              <div className={styles.countPill}>{historyRows.length} 条</div>
            </div>
            <Space wrap>
              <Select
                showSearch
                optionFilterProp="label"
                placeholder="选择房源"
                style={{ width: 260 }}
                value={historyPropertyId || undefined}
                onChange={(v) => setHistoryPropertyId(v ? String(v) : null)}
                options={sortProperties(properties as any).map((p: any) => {
                  const code = String(p.code || '').trim()
                  const addr = String(p.address || '').trim()
                  const label = code ? (addr ? `${code} ${addr}` : code) : (addr || String(p.id))
                  return { value: String(p.id), label }
                })}
              />
              <DatePicker.RangePicker
                value={historyRange}
                onChange={(v) => {
                  if (!v || v.length !== 2 || !v[0] || !v[1]) return
                  setHistoryRange([v[0], v[1]])
                }}
              />
              <Button type="primary" className={styles.primaryBtn} loading={historyLoading} disabled={!historyPropertyId} onClick={() => loadHistory().catch(() => {})}>
                查询
              </Button>
            </Space>
          </div>

          <div className={styles.tableWrap} role="table" aria-label="清洁历史表格">
            <div className={`${styles.tableRow} ${styles.tableHeadRow}`} role="row">
              <div className={styles.cell} role="columnheader">日期</div>
              <div className={styles.cell} role="columnheader">类型</div>
              <div className={styles.cell} role="columnheader">清洁</div>
              <div className={styles.cell} role="columnheader">检查</div>
              <div className={styles.cell} role="columnheader">状态</div>
              <div className={styles.cell} role="columnheader">时间</div>
              <div className={styles.cell} role="columnheader">备注</div>
            </div>
            {historyRows.length ? historyRows.map((t) => {
              const statusRank = (s: string) => {
                const st = String(s || '').toLowerCase()
                if (st === 'in_progress') return 5
                if (st === 'assigned') return 4
                if (st === 'pending') return 3
                if (st === 'completed') return 2
                if (st === 'cancelled' || st === 'canceled') return 1
                return 3
              }
              const statusLabel = (s: string) => {
                const st = String(s || '').toLowerCase()
                return st === 'assigned' ? '已分配' : st === 'in_progress' ? '进行中' : st === 'completed' ? '已完成' : st === 'cancelled' ? '已取消' : '待处理'
              }
              const joinNames = (a?: string | null, b?: string | null) => {
                const x = staffNameById(a) || ''
                const y = staffNameById(b) || ''
                const uniq = Array.from(new Set([x, y].map((z) => String(z || '').trim()).filter(Boolean)))
                return uniq.length ? uniq.join(' / ') : '-'
              }
              const joinNotes = (a?: string | null, b?: string | null) => {
                const uniq = Array.from(new Set([a, b].map((z) => String(z || '').trim()).filter(Boolean)))
                return uniq.length ? uniq.join(' / ') : '-'
              }
              const timePart = (time: any, label: string) => {
                const t0 = String(time || '').trim()
                return t0 ? `${t0}${label}` : ''
              }

              const dateStr = t.dateStr
              const typeLabel = t.kind === 'turnover' ? '退房+入住' : taskTypeLabel(t.row)
              const st0 = t.kind === 'turnover'
                ? (statusRank(String(t.checkout.status || '')) >= statusRank(String(t.checkin.status || '')) ? String(t.checkout.status || '') : String(t.checkin.status || ''))
                : String(t.row.status || '')
              const stLabel = statusLabel(st0)
              const cleanerName = t.kind === 'turnover'
                ? joinNames(t.checkout.cleaner_id || t.checkout.assignee_id, t.checkin.cleaner_id || t.checkin.assignee_id)
                : (staffNameById(t.row.cleaner_id || t.row.assignee_id) || '-')
              const inspectorName = t.kind === 'turnover'
                ? joinNames(t.checkout.inspector_id, t.checkin.inspector_id)
                : (staffNameById(t.row.inspector_id) || '-')
              const timeStr = (() => {
                if (t.kind === 'turnover') {
                  const parts = [timePart(t.checkout.checkout_time, '退房'), timePart(t.checkin.checkin_time, '入住')].filter(Boolean)
                  return parts.length ? parts.join(' ') : '-'
                }
                const tt = String(t.row.task_type || t.row.type || '').toLowerCase()
                if (tt === 'stayover_clean') return String(t.row.checkin_time || '').trim() || ''
                return tt.startsWith('checkout') ? String(t.row.checkout_time || '').trim() : String(t.row.checkin_time || '').trim()
              })()
              const noteStr = t.kind === 'turnover' ? joinNotes(t.checkout.note, t.checkin.note) : (String(t.row.note || '').trim() || '-')
              return (
                <div key={t.key} className={`${styles.tableRow} ${styles.bodyRow} ${styles.rowHover}`} role="row">
                  <div className={styles.cell} role="cell">{dateStr || '-'}</div>
                  <div className={styles.cell} role="cell"><span className={`${styles.pill} ${styles.pillBlue}`}>{typeLabel}</span></div>
                  <div className={styles.cell} role="cell"><span className={`${styles.pill} ${styles.pillGreen}`}>{cleanerName}</span></div>
                  <div className={styles.cell} role="cell"><span className={`${styles.pill} ${styles.pillGreen}`}>{inspectorName}</span></div>
                  <div className={styles.cell} role="cell"><span className={styles.pill}>{stLabel}</span></div>
                  <div className={styles.cell} role="cell">{timeStr || '-'}</div>
                  <div className={styles.cell} role="cell">{noteStr}</div>
                </div>
              )
            }) : (
              <div className={`${styles.tableRow} ${styles.bodyRow}`} role="row">
                <div className={styles.cell} role="cell" style={{ gridColumn: '1 / -1', color: 'var(--clean-overview-subtle)' }}>
                  {historyPropertyId ? (historyLoading ? '加载中…' : '暂无记录') : '请选择房源后查询'}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className={`${styles.card} ${styles.sectionCard}`} aria-label="今日其他线下任务">
          <div className={styles.cardHead}>
            <div className={styles.taskHeaderLeft}>
              <div className={styles.cardTitle}>今日其他线下任务</div>
              <div className={styles.countPill}>{offlineTasks.length} 个任务</div>
            </div>
          </div>

          <div className={styles.tableWrap} role="table" aria-label="线下任务表格">
            <div className={`${styles.tableRow} ${styles.tableHeadRow}`} role="row">
              <div className={styles.cell} role="columnheader">任务信息</div>
              <div className={styles.cell} role="columnheader">执行人</div>
              <div className={styles.cell} role="columnheader">房源 ID</div>
              <div className={styles.cell} role="columnheader">优先级</div>
              <div className={styles.cell} role="columnheader">状态</div>
              <div className={styles.cell} role="columnheader">操作</div>
            </div>
            {offlineTasks.map((t) => {
              const urgencyLabel = t.urgency === 'low' ? '低' : t.urgency === 'medium' ? '中' : t.urgency === 'high' ? '高' : '紧急'
              const isDone = t.status === 'done'
              return (
                <div key={t.id} className={`${styles.tableRow} ${styles.bodyRow} ${styles.rowHover} ${isDone ? styles.doneRow : ''}`} role="row">
                  <div className={styles.cell} role="cell">
                    <div className={styles.taskInfo}>
                      <div className={styles.taskIcon} aria-hidden="true"><ClockCircleOutlined /></div>
                      <div className={styles.taskMeta}>
                        <div className={styles.taskTitleLink} onClick={() => openEdit(t)}>{t.title}</div>
                        <div className={styles.taskSub}>
                          <span>{String(t.date || '').slice(0, 10)}</span>
                          <span className={styles.pill}>{kindLabel[t.kind] || t.kind}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className={styles.cell} role="cell">
                    <span className={`${styles.pill} ${styles.pillGreen}`}>{staffNameById(t.assignee_id) || '-'}</span>
                  </div>
                  <div className={styles.cell} role="cell">
                    <span>{t.property_id ? (propertyLabelById(t.property_id) || t.property_id) : '-'}</span>
                  </div>
                  <div className={styles.cell} role="cell">
                    <span className={`${styles.pill} ${styles.pillBlue}`}>{urgencyLabel}</span>
                  </div>
                  <div className={styles.cell} role="cell">
                    <Select
                      size="small"
                      value={t.status}
                      style={{ width: 120 }}
                      options={[
                        { label: '未完成', value: 'todo' },
                        { label: '已完成', value: 'done' },
                      ]}
                      onChange={(v) => updateOfflineTask(t.id, { status: v as any }).catch(() => {})}
                    />
                  </div>
                  <div className={styles.cell} role="cell">
                    <div className={styles.ops}>
                      <Button className={styles.iconBtn} icon={<EyeOutlined />} aria-label="查看" onClick={() => openEdit(t)} />
                      <Button className={styles.iconBtn} icon={<EditOutlined />} aria-label="编辑" onClick={() => openEdit(t)} />
                      <Popconfirm title="确认删除该任务？" okText="删除" cancelText="取消" onConfirm={() => deleteOfflineTask(t.id).catch(() => {})}>
                        <Button className={styles.iconBtn} icon={<DeleteOutlined />} aria-label="删除" />
                      </Popconfirm>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>

      <Drawer
        open={editOpen}
        title="查看 / 编辑线下任务"
        width={560}
        onClose={() => setEditOpen(false)}
        footer={
          <div style={{ textAlign: 'right' }}>
            <Space>
              <Popconfirm title="确认删除该任务？" okText="删除" cancelText="取消" onConfirm={() => (editing ? deleteOfflineTask(editing.id).catch((e) => message.error(e?.message || '删除失败')) : undefined)}>
                <Button danger disabled={!editing}>
                  删除
                </Button>
              </Popconfirm>
              <Button onClick={() => setEditOpen(false)}>关闭</Button>
              <Button type="primary" onClick={() => saveEdit().catch((e) => message.error(e?.message || '保存失败'))} disabled={!editing}>
                保存
              </Button>
            </Space>
          </div>
        }
      >
        <Form
          form={editForm}
          layout="vertical"
          onValuesChange={(changed, all) => {
            if (changed?.task_type && all.task_type !== 'property') editForm.setFieldsValue({ property_id: undefined })
          }}
        >
          <Form.Item name="date" label="执行日期" rules={[{ required: true, message: '请选择执行日期' }]}>
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="task_type" label="任务类型" rules={[{ required: true, message: '请选择任务类型' }]}>
            <Select options={[{ label: '房源', value: 'property' }, { label: '公司', value: 'company' }, { label: '其他', value: 'other' }]} />
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(prev, cur) => prev.task_type !== cur.task_type}>
            {() => (editForm.getFieldValue('task_type') === 'property' ? (
              <Form.Item name="property_id" label="房源" rules={[{ required: true, message: '请选择房源' }]}>
                <Select
                  showSearch
                  optionFilterProp="label"
                  filterOption={(input, option) => String((option as any)?.label || '').toLowerCase().includes(String(input || '').toLowerCase())}
                  options={sortProperties(Array.isArray(properties) ? properties : []).map((p) => ({ value: p.id, label: p.code || p.address || p.id }))}
                />
              </Form.Item>
            ) : null)}
          </Form.Item>
          <Form.Item name="title" label="任务标题" rules={[{ required: true, message: '请输入任务标题' }]}>
            <Input />
          </Form.Item>
          <Form.Item name="content" label="任务具体内容">
            <Input.TextArea rows={4} />
          </Form.Item>
          <Form.Item name="assignee_id" label="分配人员">
            <Select allowClear options={staff.map((s) => ({ value: s.id, label: s.name }))} />
          </Form.Item>
          <Form.Item name="kind" label="任务分类" rules={[{ required: true, message: '请选择任务分类' }]}>
            <Select
              options={[
                { label: '挂钥匙', value: 'key_hanging' },
                { label: '换密码', value: 'password_change' },
                { label: '补消耗品', value: 'restock' },
                { label: '维修', value: 'maintenance' },
                { label: '检查（Inspection）', value: 'inspection' },
                { label: '其他', value: 'other' },
              ]}
            />
          </Form.Item>
          <Form.Item name="urgency" label="紧急程度" rules={[{ required: true, message: '请选择紧急程度' }]}>
            <Select
              options={[
                { label: '低', value: 'low' },
                { label: '中', value: 'medium' },
                { label: '高', value: 'high' },
                { label: '紧急', value: 'urgent' },
              ]}
            />
          </Form.Item>
          <Form.Item name="status" label="完成状态" rules={[{ required: true, message: '请选择状态' }]}>
            <Select options={[{ label: '未完成', value: 'todo' }, { label: '已完成', value: 'done' }]} />
          </Form.Item>
        </Form>
      </Drawer>
      </div>
    </div>
  )
}
