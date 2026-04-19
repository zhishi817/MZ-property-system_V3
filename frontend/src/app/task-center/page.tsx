"use client"

import { Alert, Button, DatePicker, Empty, Modal, Segmented, Select, Skeleton, Space, Tag, Tooltip, message, Input } from 'antd'
import { CalendarOutlined, CaretDownOutlined, CaretRightOutlined, HolderOutlined, LeftOutlined, PlusOutlined, ReloadOutlined, RightOutlined } from '@ant-design/icons'
import { useCallback, useEffect, useMemo, useState } from 'react'
import dayjs, { type Dayjs } from 'dayjs'
import { getJSON, patchJSON, postJSON } from '../../lib/api'
import { cleaningColorKind } from '../../lib/cleaningColor'
import styles from '../cleaning/cleaningSchedule.module.scss'

type Staff = { id: string; name: string; kind?: 'cleaner' | 'inspector' | 'maintenance'; is_active?: boolean; color_hex?: string | null }

type CalendarItem = {
  source: 'cleaning_tasks' | 'offline_tasks' | 'calendar_events'
  entity_id: string
  entity_ids?: string[]
  order_id: string | null
  order_code?: string | null
  property_id: string | null
  property_code?: string | null
  property_region?: string | null
  task_type?: string | null
  label: string
  task_date: string
  status: string
  assignee_id: string | null
  cleaner_id?: string | null
  inspector_id?: string | null
  scheduled_at: string | null
  key_photo_uploaded_at?: string | null
  has_key_photo?: boolean
  auto_sync_enabled?: boolean
  inspection_mode?: 'pending_decision' | 'same_day' | 'self_complete' | 'deferred' | null
  inspection_due_date?: string | null
  cleaning_board_enabled?: boolean
  inspection_board_enabled?: boolean
  deferred_inspection_view?: boolean
  old_code?: string | null
  new_code?: string | null
  nights?: number | null
  summary_checkout_time?: string | null
  summary_checkin_time?: string | null
}

type WorkTask = {
  id: string
  task_kind: string
  source_type: string
  source_id: string
  property_id: string | null
  title: string
  summary: string | null
  scheduled_date: string | null
  start_time: string | null
  end_time: string | null
  assignee_id: string | null
  status: 'todo' | 'assigned' | 'in_progress' | 'done' | 'cancelled'
  urgency: 'low' | 'medium' | 'high' | 'urgent'
}

type TaskCenterDay = { date: string; pool: WorkTask[]; groups: Record<string, WorkTask[]>; tasks: WorkTask[] }

export default function TaskCenterPage() {
  const [date, setDate] = useState<Dayjs>(() => dayjs())
  const dateStr = useMemo(() => date.format('YYYY-MM-DD'), [date])

  const [tab, setTab] = useState<'cleaning' | 'inspection' | 'maintenance' | 'deep_cleaning'>('cleaning')

  const [staff, setStaff] = useState<Staff[]>([])
  const [properties, setProperties] = useState<{ id: string; code?: string; address?: string; region?: string | null }[]>([])

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [cleaningItems, setCleaningItems] = useState<CalendarItem[]>([])
  const [taskCenterDay, setTaskCenterDay] = useState<TaskCenterDay | null>(null)

  const [dragOverKey, setDragOverKey] = useState<string | null>(null)
  const [pendingTaskKeys, setPendingTaskKeys] = useState<string[]>([])

  const [createOpen, setCreateOpen] = useState(false)
  const [createLoading, setCreateLoading] = useState(false)
  const [inspectionPlanOpen, setInspectionPlanOpen] = useState(false)
  const [inspectionPlanLoading, setInspectionPlanLoading] = useState(false)
  const [inspectionPlanItem, setInspectionPlanItem] = useState<CalendarItem | null>(null)
  const [inspectionPlanMode, setInspectionPlanMode] = useState<'pending_decision' | 'same_day' | 'self_complete' | 'deferred'>('pending_decision')
  const [inspectionPlanDate, setInspectionPlanDate] = useState<Dayjs | null>(null)
  const [inspectionPlanInspectorId, setInspectionPlanInspectorId] = useState<string | null>(null)

  const [offlineCreate, setOfflineCreate] = useState<{
    date: Dayjs
    task_type: 'property' | 'company' | 'other'
    title: string
    content: string
    urgency: 'low' | 'medium' | 'high' | 'urgent'
    property_id: string | null
    assignee_id: string | null
  } | null>(null)

  const [filterText, setFilterText] = useState('')
  const [poolView, setPoolView] = useState<'all' | 'cleaning' | 'inspection' | 'self_complete' | 'maintenance' | 'deep_cleaning' | 'other'>('all')
  const [staffFilter, setStaffFilter] = useState<'all' | 'busy' | 'idle'>('all')
  const [staffSearch, setStaffSearch] = useState('')
  const [staffFocusId, setStaffFocusId] = useState<string | null>(null)
  const [expandedStaff, setExpandedStaff] = useState<Record<string, 'preview' | 'expanded' | 'collapsed'>>({})

  const staffFilterOptions = useMemo(() => ([
    { label: '全部人员', value: 'all' },
    { label: '有任务', value: 'busy' },
    { label: '空闲', value: 'idle' },
  ]), [])

  const cleaningPoolFilterOptions = useMemo(() => ([
    { label: '全部', value: 'all' },
    { label: '清洁', value: 'cleaning' },
    { label: '检查', value: 'inspection' },
    { label: '自完成', value: 'self_complete' },
    { label: '维修', value: 'maintenance' },
    { label: '深清', value: 'deep_cleaning' },
    { label: '其他', value: 'other' },
  ]), [])

  const workPoolFilterOptions = useMemo(() => ([
    { label: '全部', value: 'all' },
    { label: '清洁', value: 'cleaning' },
    { label: '检查', value: 'inspection' },
    { label: '维修', value: 'maintenance' },
    { label: '深清', value: 'deep_cleaning' },
    { label: '其他', value: 'other' },
  ]), [])

  const entityIds = useCallback((it: CalendarItem) => {
    const ids = Array.isArray(it.entity_ids) && it.entity_ids.length ? it.entity_ids : [it.entity_id]
    return Array.from(new Set(ids.map((x) => String(x)).filter(Boolean)))
  }, [])

  const parseDragPayload = useCallback((payloadText: string): { ids: string[]; task_type?: string | null; source?: 'cleaning' | 'work' } => {
    try {
      const j = JSON.parse(payloadText)
      const ids = Array.isArray(j?.ids) ? j.ids.map((x: any) => String(x)).filter(Boolean) : []
      const sourceRaw = String(j?.source || '').trim().toLowerCase()
      const source = sourceRaw === 'work' ? 'work' : (sourceRaw === 'cleaning' ? 'cleaning' : undefined)
      return { ids, task_type: j?.task_type != null ? String(j.task_type) : undefined, source }
    } catch {
      return { ids: [] }
    }
  }, [])

  const activateDragTarget = useCallback((key: string) => {
    setDragOverKey((prev) => (prev === key ? prev : key))
  }, [])

  const clearDragTarget = useCallback((key?: string | null) => {
    setDragOverKey((prev) => {
      if (!key) return prev == null ? prev : null
      return prev === key ? null : prev
    })
  }, [])

  const handlePoolViewChange = useCallback((value: string | number) => {
    const val = value as typeof poolView
    if (val === 'maintenance') { setPoolView('maintenance'); setTab('maintenance'); return }
    if (val === 'deep_cleaning') { setPoolView('deep_cleaning'); setTab('deep_cleaning'); return }
    if (val === 'inspection') { setPoolView('inspection'); setTab('inspection'); return }
    if (val === 'cleaning') { setPoolView('cleaning'); setTab('cleaning'); return }
    if (val === 'self_complete') { setPoolView('self_complete'); setTab('cleaning'); return }
    if (val === 'other') { setPoolView('other'); return }
    setPoolView('all')
  }, [])

  const renderPoolTools = useCallback((options: { label: string; value: string }[]) => (
    <div className={`${styles.poolTools} ${styles.taskCenterPoolTools}`}>
      <div className={styles.taskCenterToolBlock}>
        <div className={styles.taskCenterToolLabel}>任务范围</div>
        <Segmented
          size="small"
          className={styles.taskCenterPoolSegment}
          options={options}
          value={poolView}
          onChange={handlePoolViewChange}
        />
      </div>
      <div className={styles.taskCenterToolBlock}>
        <div className={styles.taskCenterToolLabel}>快速搜索</div>
        <Input
          className={styles.taskCenterPoolSearch}
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
          placeholder="搜索房源、区域或任务..."
          allowClear
        />
      </div>
    </div>
  ), [filterText, handlePoolViewChange, poolView])

  const renderStaffTools = useCallback(() => (
    <div className={`${styles.staffTools} ${styles.taskCenterStaffTools}`}>
      <div className={styles.taskCenterStaffToolsBar}>
        <div className={styles.taskCenterToolBlock}>
          <div className={styles.taskCenterToolLabel}>人员状态</div>
          <Segmented
            size="small"
            className={styles.taskCenterStaffSegment}
            options={staffFilterOptions}
            value={staffFilter}
            onChange={(v) => setStaffFilter(v as any)}
          />
        </div>
        <div className={`${styles.taskCenterToolBlock} ${styles.taskCenterStaffSearchBlock}`}>
          <div className={styles.taskCenterToolLabel}>搜索定位</div>
          <Input
            className={`${styles.staffJump} ${styles.taskCenterStaffSearch}`}
            value={staffSearch}
            onChange={(e) => setStaffSearch(e.target.value)}
            placeholder="搜索人员并定位..."
            allowClear
          />
        </div>
      </div>
    </div>
  ), [staffFilter, staffFilterOptions, staffSearch])

  const loadStaff = useCallback(async () => {
    const rows = await getJSON<Staff[]>('/cleaning/staff').catch(() => [])
    setStaff(Array.isArray(rows) ? rows : [])
  }, [])

  const loadProps = useCallback(async () => {
    const p = await getJSON<any>('/properties?include_archived=true').catch(() => [])
    setProperties(Array.isArray(p) ? p : [])
  }, [])

  const loadDay = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const day = dateStr
      const [itemsRes, dayRes] = await Promise.allSettled([
        getJSON<CalendarItem[]>(`/cleaning/calendar-range?from=${encodeURIComponent(day)}&to=${encodeURIComponent(day)}&include_deferred_inspection=1`),
        getJSON<TaskCenterDay>(`/task-center/day?date=${encodeURIComponent(day)}&include_overdue=1&include_unscheduled=1&include_future=1`, { timeoutMs: 20000 }),
      ])

      if (itemsRes.status === 'fulfilled') {
        const items = itemsRes.value
        setCleaningItems(Array.isArray(items) ? items.filter((x) => x.source === 'cleaning_tasks') : [])
      }
      if (dayRes.status === 'fulfilled') setTaskCenterDay(dayRes.value || null)

      const hadError = [itemsRes, dayRes].some((r) => r.status === 'rejected')
      if (hadError) setError('部分数据加载失败')
    } catch (e: any) {
      setError(String(e?.message || '加载失败'))
    } finally {
      setLoading(false)
    }
  }, [dateStr])

  const daySyncTaskIds = useMemo(() => {
    const out: string[] = []
    for (const it of cleaningItems) {
      if (it.source !== 'cleaning_tasks') continue
      if (!String(it.order_id || '').trim()) continue
      out.push(String(it.entity_id))
    }
    return Array.from(new Set(out.map((x) => String(x)).filter(Boolean)))
  }, [cleaningItems])

  const lockTaskIds = useMemo(() => {
    const idSet = new Set<string>()
    for (const it of cleaningItems) {
      if (it.source !== 'cleaning_tasks') continue
      if (!String(it.order_id || '').trim()) continue
      if (it.auto_sync_enabled === false) continue
      idSet.add(String(it.entity_id))
    }
    return Array.from(idSet)
  }, [cleaningItems])

  const unlockTaskIds = useMemo(() => {
    const idSet = new Set<string>()
    for (const it of cleaningItems) {
      if (it.source !== 'cleaning_tasks') continue
      if (!String(it.order_id || '').trim()) continue
      if (it.auto_sync_enabled !== false) continue
      idSet.add(String(it.entity_id))
    }
    return Array.from(idSet)
  }, [cleaningItems])

  const lockDay = useCallback(async () => {
    if (!daySyncTaskIds.length) { message.warning('当日无可锁定任务'); return }
    if (!lockTaskIds.length) { message.info('当日已处于锁定状态'); return }
    Modal.confirm({
      title: '确认锁定当日安排？',
      content: '锁定后将禁用拖拽分配与快速指派，需手动解锁才能继续修改。',
      okText: '锁定',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await postJSON('/cleaning/tasks/bulk-lock-auto-sync', { ids: lockTaskIds }, { timeoutMs: 20000 })
        } catch (e: any) {
          const name = String(e?.name || '')
          const msg = name === 'AbortError' ? '锁定超时，请稍后重试' : String(e?.message || '锁定失败')
          message.error(msg)
          throw e
        }
        setCleaningItems((prev) => {
          const idSet = new Set(lockTaskIds.map((x) => String(x)))
          return prev.map((it) => (it.source === 'cleaning_tasks' && idSet.has(String(it.entity_id)) ? { ...it, auto_sync_enabled: false } : it))
        })
        message.success('已锁定当日安排')
      },
    })
  }, [daySyncTaskIds, lockTaskIds])

  const unlockDay = useCallback(async () => {
    if (!daySyncTaskIds.length) { message.warning('当日无可解锁任务'); return }
    if (!unlockTaskIds.length) { message.info('当日已处于解锁状态'); return }
    Modal.confirm({
      title: '确认解锁当日安排？',
      content: '解锁后允许拖拽与快速指派，并恢复自动同步。',
      okText: '解锁',
      onOk: async () => {
        try {
          await postJSON('/cleaning/tasks/bulk-restore-auto-sync', { ids: unlockTaskIds }, { timeoutMs: 20000 })
        } catch (e: any) {
          const name = String(e?.name || '')
          const msg = name === 'AbortError' ? '解锁超时，请稍后重试' : String(e?.message || '解锁失败')
          message.error(msg)
          throw e
        }
        setCleaningItems((prev) => {
          const idSet = new Set(unlockTaskIds.map((x) => String(x)))
          return prev.map((it) => (it.source === 'cleaning_tasks' && idSet.has(String(it.entity_id)) ? { ...it, auto_sync_enabled: true } : it))
        })
        message.success('已解锁当日安排')
      },
    })
  }, [daySyncTaskIds, unlockTaskIds])

  useEffect(() => {
    loadStaff().catch(() => {})
    loadProps().catch(() => {})
  }, [loadProps, loadStaff])

  useEffect(() => {
    loadDay().catch(() => {})
  }, [loadDay])

  const goPrev = useCallback(() => setDate((d) => d.subtract(1, 'day')), [])
  const goNext = useCallback(() => setDate((d) => d.add(1, 'day')), [])

  const activeCleaners = useMemo(() => staff.filter((s) => (s.kind || 'cleaner') === 'cleaner' && s.is_active !== false), [staff])
  const activeInspectors = useMemo(() => staff.filter((s) => (s.kind || 'cleaner') === 'inspector' && s.is_active !== false), [staff])
  const activeMaintenanceStaff = useMemo(() => {
    const ms = staff.filter((s) => (s as any).kind === 'maintenance' && s.is_active !== false)
    return ms.length ? ms : staff.filter((s) => s.is_active !== false)
  }, [staff])
  const activeAllStaff = useMemo(() => staff.filter((s) => s.is_active !== false), [staff])

  const filterQuery = useMemo(() => filterText.trim().toLowerCase(), [filterText])

  const propertyCodeById = useCallback((propertyId?: string | null) => {
    const pid = String(propertyId || '').trim()
    if (!pid) return '-'
    const p = properties.find((x) => String(x.id) === pid)
    return String(p?.code || pid).trim() || '-'
  }, [properties])

  useEffect(() => {
    const q = staffSearch.trim().toLowerCase()
    if (!q) { setStaffFocusId(null); return }
    const list = tab === 'maintenance' ? activeMaintenanceStaff : (tab === 'inspection' ? activeInspectors : activeCleaners)
    const m = list.find((s) => String(s.name || '').toLowerCase().includes(q))
    if (m) setStaffFocusId(String(m.id))
  }, [activeCleaners, activeInspectors, activeMaintenanceStaff, staffSearch, tab])

  useEffect(() => {
    if (!staffFocusId) return
    const mode = tab === 'maintenance'
      ? 'maintenance'
      : (tab === 'inspection' ? 'inspection' : (tab === 'deep_cleaning' ? 'deep-cleaning' : 'cleaning'))
    const el = document.getElementById(`staffcol-${mode}-${staffFocusId}`)
    if (el) el.scrollIntoView({ block: 'start' })
  }, [staffFocusId, tab])

  const dayLocked = useMemo(() => {
    return cleaningItems.some((it) => !!String(it.order_id || '').trim() && it.auto_sync_enabled === false)
  }, [cleaningItems])

  const mergedStatus = useCallback((statuses: string[]) => {
    const ss = statuses.map((s) => String(s || 'pending'))
    if (ss.length && ss.every((x) => x === 'cancelled')) return 'cancelled'
    if (ss.includes('pending')) return 'pending'
    if (ss.includes('assigned')) return 'assigned'
    if (ss.includes('in_progress')) return 'in_progress'
    if (ss.includes('completed')) return 'completed'
    if (ss.length) return ss[0]
    return 'pending'
  }, [])

  const inspectionModeOf = useCallback((it: CalendarItem) => {
    const raw = String(it.inspection_mode || '').trim().toLowerCase()
    if (raw === 'pending_decision' || raw === 'same_day' || raw === 'self_complete' || raw === 'deferred') return raw
    const tt = String(it.task_type || '').trim().toLowerCase()
    if (tt === 'stayover_clean') return 'self_complete'
    if (tt === 'checkin_clean') return 'same_day'
    if (String(it.inspector_id || '').trim()) return 'same_day'
    return 'pending_decision'
  }, [])

  const inspectionModeLabel = useCallback((it: CalendarItem) => {
    const mode = inspectionModeOf(it)
    if (mode === 'pending_decision') return '待确认检查安排'
    if (mode === 'self_complete') return '自完成'
    if (mode === 'deferred') {
      const due = String(it.inspection_due_date || '').trim()
      return due ? `延后检查 ${due}` : '延后检查'
    }
    return '同日检查'
  }, [inspectionModeOf])

  const canConfigureInspection = useCallback((it: CalendarItem) => {
    if (String(it.source || '') !== 'cleaning_tasks') return false
    if (it.deferred_inspection_view) return false
    const tt = String(it.task_type || '').trim().toLowerCase()
    return tt === 'checkout_clean' || tt === 'turnover'
  }, [])

  const shouldShowInspectionPlanAction = useCallback((it: CalendarItem) => {
    if (!canConfigureInspection(it)) return false
    if (String(it.inspector_id || '').trim()) return false
    return true
  }, [canConfigureInspection])

  const inspectionActionLabel = useCallback((it: CalendarItem) => {
    const mode = inspectionModeOf(it)
    return mode === 'pending_decision' ? '安排检查' : '修改检查安排'
  }, [inspectionModeOf])

  const effectiveCleaningStatus = useCallback((it: CalendarItem, board: 'cleaning' | 'inspection') => {
    const raw = String(it.status || 'pending')
    const lowered = raw.trim().toLowerCase()
    const cleaner = String(it.cleaner_id || it.assignee_id || '').trim()
    const inspector = String(it.inspector_id || '').trim()
    const doneLike = lowered === 'completed' || lowered === 'done' || lowered === 'ready' || lowered === 'inspected' || lowered === 'keys_hung'
    const cleanedLike = lowered === 'cleaned' || lowered === 'restock_pending' || lowered === 'restocked'
    if (lowered === 'cancelled') return 'cancelled'
    if (board === 'inspection') {
      if (doneLike) return 'completed'
      if (lowered === 'in_progress') return 'in_progress'
      if (cleanedLike) return inspector ? 'assigned' : 'pending'
      if (lowered === 'assigned') return inspector ? 'assigned' : 'pending'
      return inspector ? 'assigned' : 'pending'
    }
    if (doneLike || cleanedLike) return 'completed'
    if (lowered === 'in_progress') return 'in_progress'
    if (lowered === 'assigned') return 'assigned'
    return cleaner || inspector ? 'assigned' : 'pending'
  }, [])

  const statusText = useCallback((s: string | null | undefined) => {
    const v = String(s || '').trim()
    if (v === 'pending') return '待处理'
    if (v === 'assigned') return '已分配'
    if (v === 'in_progress') return '进行中'
    if (v === 'completed') return '已完成'
    if (v === 'cancelled') return '已取消'
    if (v === 'todo') return '待处理'
    if (v === 'done') return '已完成'
    return v || '-'
  }, [])

  const statusChipCls = useCallback((s: string | null | undefined) => {
    const v = String(s || '').trim()
    if (v === 'completed' || v === 'done') return styles.statusDone
    if (v === 'in_progress') return styles.statusInProgress
    if (v === 'assigned') return styles.statusAssigned
    if (v === 'cancelled') return styles.statusCancelled
    return styles.statusPending
  }, [])

  const mergedCleaningItems = useMemo(() => {
    const list = Array.isArray(cleaningItems) ? cleaningItems.filter((x) => x.source === 'cleaning_tasks') : []
    const byProp = new Map<string, CalendarItem[]>()
    for (const it of list) {
      const pid = String(it.property_id || '').trim()
      const groupKey = `${pid}|${it.deferred_inspection_view ? `deferred:${String(it.inspection_due_date || '').trim() || String(it.task_date || '').trim()}` : 'normal'}`
      const arr = byProp.get(groupKey) || []
      arr.push(it)
      byProp.set(groupKey, arr)
    }

    const isStayover = (x: CalendarItem) => String(x.task_type || '').toLowerCase() === 'stayover_clean' || String(x.label || '').includes('入住中清洁') || `${x.label}`.toLowerCase().includes('stayover')
    const isCheckin = (x: CalendarItem) => !isStayover(x) && (String(x.task_type || '').toLowerCase() === 'checkin_clean' || (String(x.label || '').includes('入住') && !String(x.label || '').includes('入住中清洁')) || `${x.label}`.toLowerCase().includes('checkin'))
    const isCheckout = (x: CalendarItem) => String(x.task_type || '').toLowerCase() === 'checkout_clean' || String(x.label || '').includes('退房') || `${x.label}`.toLowerCase().includes('checkout')
    const keyUploaded = (x: CalendarItem) => !!(x?.has_key_photo || x?.key_photo_uploaded_at)
    const anyKeyUploaded = (xs: CalendarItem[]) => xs.some((x) => keyUploaded(x))
    const firstKeyUploadedAt = (xs: CalendarItem[]) => {
      const hit = xs.find((x) => !!x?.key_photo_uploaded_at)
      return hit?.key_photo_uploaded_at || null
    }
    const preferOrderLinked = (xs: CalendarItem[]) => {
      const withOrder = xs.filter((x) => !!(x.order_id || x.order_code))
      return withOrder.length ? withOrder : xs
    }

    const out: CalendarItem[] = []
    for (const items of byProp.values()) {
      const stayovers0 = items.filter(isStayover)
      const checkins0 = preferOrderLinked(items.filter(isCheckin))
      const checkouts0 = preferOrderLinked(items.filter(isCheckout))

      if (checkins0.length && checkouts0.length) {
        const all = [...checkins0, ...checkouts0]
        const ids = all.map((x) => String(x.entity_id))
        const assignee = all.every((x) => String(x.assignee_id || '') === String(all[0].assignee_id || '')) ? all[0].assignee_id : null
        const cleanerKey = (x: CalendarItem) => String(x.cleaner_id || x.assignee_id || '').trim()
        const inspectorKey = (x: CalendarItem) => String(x.inspector_id || '').trim()
        const cleanerId = all.every((x) => cleanerKey(x) === cleanerKey(all[0])) ? (cleanerKey(all[0]) || null) : null
        const inspectorId = all.every((x) => inspectorKey(x) === inspectorKey(all[0])) ? (inspectorKey(all[0]) || null) : null
        const sched = all.every((x) => String(x.scheduled_at || '') === String(all[0].scheduled_at || '')) ? all[0].scheduled_at : null
        const status = mergedStatus(all.map((x) => String(x.status || 'pending')))
        const autoSync = all.every((x) => x.auto_sync_enabled !== false)
        const checkout = checkouts0[0]
        const checkin = checkins0[0]
        const inspectionBase = checkout || checkin || all[0]
        out.push({
          source: 'cleaning_tasks',
          entity_id: ids.join(','),
          entity_ids: ids,
          order_id: null,
          order_code: null,
          property_id: all[0].property_id,
          property_code: all[0].property_code || null,
          property_region: all[0].property_region || null,
          task_type: 'turnover',
          label: '退房 入住',
          task_date: String(all[0].task_date || '').slice(0, 10),
          status,
          assignee_id: assignee,
          cleaner_id: cleanerId,
          inspector_id: inspectorId,
          scheduled_at: sched,
          key_photo_uploaded_at: firstKeyUploadedAt(all),
          has_key_photo: anyKeyUploaded(all),
          auto_sync_enabled: autoSync,
          inspection_mode: inspectionBase?.inspection_mode || null,
          inspection_due_date: inspectionBase?.inspection_due_date || null,
          cleaning_board_enabled: all.some((x) => x.cleaning_board_enabled !== false),
          inspection_board_enabled: all.some((x) => x.inspection_board_enabled === true),
          deferred_inspection_view: all.every((x) => x.deferred_inspection_view === true),
          nights: all.find((x) => x.nights != null)?.nights ?? null,
          summary_checkout_time: checkout?.summary_checkout_time || null,
          summary_checkin_time: checkin?.summary_checkin_time || null,
          old_code: null,
          new_code: null,
        })
        const rest = items.filter((x) => !isCheckin(x) && !isCheckout(x))
        out.push(...rest)
      } else {
        if (stayovers0.length) out.push(...stayovers0)
        const rest = items.filter((x) => !isStayover(x))
        out.push(...rest)
      }
    }
    const regionKey = (x: any) => {
      const r = String(x?.property_region || '').trim()
      return r ? r.toLowerCase() : '\uffff'
    }
    const codeKey = (x: any) => {
      const c = String(x?.property_code || '').trim()
      return c ? c.toLowerCase() : String(x?.property_id || '').trim().toLowerCase()
    }
    out.sort((a, b) =>
      regionKey(a).localeCompare(regionKey(b)) ||
      codeKey(a).localeCompare(codeKey(b)) ||
      String(a.label || '').localeCompare(String(b.label || '')) ||
      String(a.entity_id || '').localeCompare(String(b.entity_id || ''))
    )
    return out
  }, [cleaningItems, mergedStatus])

  const isLateCheckoutTime = useCallback((raw: string | null | undefined) => {
    const s = String(raw || '').trim().toLowerCase()
    if (!s) return false
    const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/)
    if (!m) return false
    let hour = Number(m[1] || 0)
    const minute = Number(m[2] || 0)
    const meridiem = String(m[3] || '').trim()
    if (meridiem === 'am') {
      if (hour === 12) hour = 0
    } else if (meridiem === 'pm') {
      if (hour < 12) hour += 12
    }
    return hour * 60 + minute > 10 * 60
  }, [])

  const hasLateCheckout = useCallback((it: CalendarItem) => {
    const type = String(it.task_type || '').toLowerCase()
    const label = String(it.label || '')
    const isTurnover = type === 'turnover' || (label.includes('退房') && label.includes('入住'))
    const isCheckout = type === 'checkout_clean' || label.includes('退房')
    if (!isTurnover && !isCheckout) return false
    return isLateCheckoutTime(it.summary_checkout_time)
  }, [isLateCheckoutTime])

  const summaryText = useCallback((it: CalendarItem) => {
    const region = String(it.property_region || '').trim()
    const code = String(it.property_code || '').trim() || String(it.property_id || '').trim()
    const checkoutT = String(it.summary_checkout_time || '').trim() || '10am'
    const type = String(it.task_type || '').toLowerCase()
    const label = String(it.label || '')
    const isTurnover = type === 'turnover' || (label.includes('退房') && label.includes('入住'))
    const isStayover = type === 'stayover_clean' || label.includes('入住中清洁')
    const isCheckout = type === 'checkout_clean' || label.includes('退房')
    const isCheckin = (type === 'checkin_clean' || label.includes('入住')) && !isStayover
    const parts: string[] = []
    if (isTurnover) {
      const checkinT = String(it.summary_checkin_time || '').trim() || '3pm'
      parts.push(`${checkoutT}退房`, `${checkinT}入住`)
    } else if (isCheckout) parts.push(`${checkoutT}退房`)
    else if (isStayover) parts.push('清洁')
    else if (isCheckin) {
      const checkinT = String(it.summary_checkin_time || '').trim() || '3pm'
      parts.push(`${checkinT}入住`)
    }
    if (hasLateCheckout(it)) parts.push('晚退房')
    return { region, code, detail: parts.join(' ') }
  }, [hasLateCheckout])

  const isSelfCompleteCleaningItem = useCallback((it: CalendarItem) => {
    if (String(it.source || '') !== 'cleaning_tasks') return false
    if (it.deferred_inspection_view) return false
    return inspectionModeOf(it) === 'self_complete'
  }, [inspectionModeOf])

  const taskTextForCleaningItem = useCallback((it: CalendarItem) => {
    const region = String(it.property_region || '').trim()
    const code = String(it.property_code || '').trim() || String(it.property_id || '').trim()
    const t = `${region ? `${region} ` : ''}${code ? `${code} ` : ''}${String(it.label || '')}`.trim()
    return t || String(it.entity_id)
  }, [])

  const filterCleanItems = useCallback((items: CalendarItem[]) => {
    if (!filterQuery) return items
    return items.filter((it) => taskTextForCleaningItem(it).toLowerCase().includes(filterQuery))
  }, [filterQuery, taskTextForCleaningItem])

  const filterOfflineItems = useCallback((items: WorkTask[]) => {
    if (!filterQuery) return items
    return items.filter((t) => {
      const p = String(t.property_id || '').trim()
      const title = String(t.title || '').trim()
      const content = String(t.summary || '').trim()
      return `${p} ${title} ${content}`.toLowerCase().includes(filterQuery)
    })
  }, [filterQuery])

  const filterRepairs = useCallback((items: WorkTask[]) => {
    const base = items.filter((t) => {
      if (String(t.task_kind || '') !== 'maintenance') return false
      const status = String(t.status || '').trim()
      if (status === 'done' || status === 'cancelled') return false
      return true
    })
    if (!filterQuery) return base
    return base.filter((t) => {
      const code = String(t.property_id || '').trim()
      const workNo = String(t.title || t.id || '').trim()
      const sum = String(t.summary || '').trim()
      return `${code} ${workNo} ${sum}`.toLowerCase().includes(filterQuery)
    })
  }, [filterQuery])

  const filterDeepCleaning = useCallback((items: WorkTask[]) => {
    const base = items.filter((t) => {
      if (String(t.task_kind || '') !== 'deep_cleaning') return false
      const status = String(t.status || '').trim()
      if (status === 'done' || status === 'cancelled') return false
      return true
    })
    if (!filterQuery) return base
    return base.filter((t) => {
      const code = String(t.property_id || '').trim()
      const workNo = String(t.title || t.id || '').trim()
      const sum = String(t.summary || '').trim()
      return `${code} ${workNo} ${sum}`.toLowerCase().includes(filterQuery)
    })
  }, [filterQuery])

  const kindOfCleaningItem = useCallback((it: CalendarItem) => cleaningColorKind(it as any), [])
  const stripeColorForKind = useCallback((kind: string) => {
    if (kind === 'checkout') return 'rgba(239, 68, 68, 0.85)'
    if (kind === 'checkin') return 'rgba(29, 78, 216, 0.85)'
    if (kind === 'combined') return 'rgba(249, 115, 22, 0.85)'
    if (kind === 'unassigned') return 'rgba(24, 144, 255, 0.85)'
    return 'rgba(24, 144, 255, 0.85)'
  }, [])

  const stripeColorForUrgency = useCallback((urgency: string) => {
    const u = String(urgency || '').toLowerCase()
    if (u === 'urgent') return 'rgba(239, 68, 68, 0.85)'
    if (u === 'high') return 'rgba(249, 115, 22, 0.85)'
    if (u === 'medium') return 'rgba(59, 130, 246, 0.85)'
    return 'rgba(148, 163, 184, 0.85)'
  }, [])

  const workSummaryText = useCallback((raw: string | null | undefined) => {
    const s = String(raw || '').trim()
    if (!s) return ''
    try {
      const j: any = JSON.parse(s)
      if (Array.isArray(j)) {
        const parts = j
          .map((x) => (x && typeof x === 'object' ? String((x as any).content || '').trim() : ''))
          .filter(Boolean)
        if (parts.length) return parts.join(' ')
      }
      if (j && typeof j === 'object') {
        const c = String((j as any).content || '').trim()
        if (c) return c
      }
    } catch {}
    return s
  }, [])

  const cleaningPendingKeys = useCallback((ids: string[]) => (
    Array.from(new Set(ids.map((id) => `cleaning:${String(id)}`).filter(Boolean)))
  ), [])

  const workPendingKey = useCallback((id: string) => `work:${String(id)}`, [])

  const hasPendingKey = useCallback((key: string) => pendingTaskKeys.includes(key), [pendingTaskKeys])

  const hasAnyPendingKey = useCallback((keys: string[]) => keys.some((key) => pendingTaskKeys.includes(key)), [pendingTaskKeys])

  const updateCleaningTasks = useCallback(async (ids: string[], patch: any) => {
    const normIds = Array.from(new Set(ids.map((x) => String(x)).filter(Boolean)))
    if (!normIds.length) return
    const nextPendingKeys = cleaningPendingKeys(normIds)
    if (hasAnyPendingKey(nextPendingKeys)) return
    setPendingTaskKeys((prev) => Array.from(new Set([...prev, ...nextPendingKeys])))
    setCleaningItems((prev) => {
      const idSet = new Set(normIds)
      return prev.map((it) => {
        if (it.source !== 'cleaning_tasks') return it
        const itemIds = Array.isArray(it.entity_ids) && it.entity_ids.length ? it.entity_ids.map((x) => String(x)) : [String(it.entity_id)]
        if (!itemIds.some((x) => idSet.has(x))) return it
        const next: any = { ...it }
        const touchesCleaner = Object.prototype.hasOwnProperty.call(patch, 'cleaner_id')
        const touchesAssignee = Object.prototype.hasOwnProperty.call(patch, 'assignee_id')
        const touchesInspector = Object.prototype.hasOwnProperty.call(patch, 'inspector_id')
        const touchesInspectionPlan = Object.prototype.hasOwnProperty.call(patch, 'inspection_mode') || Object.prototype.hasOwnProperty.call(patch, 'inspection_due_date')
        const touchesStatus = Object.prototype.hasOwnProperty.call(patch, 'status')
        if (Object.prototype.hasOwnProperty.call(patch, 'cleaner_id')) {
          const v = patch.cleaner_id == null ? null : String(patch.cleaner_id)
          next.cleaner_id = v
          if (!touchesAssignee) next.assignee_id = v
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'assignee_id')) {
          const v = patch.assignee_id == null ? null : String(patch.assignee_id)
          next.assignee_id = v
          if (!touchesCleaner) next.cleaner_id = v
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'inspector_id')) {
          next.inspector_id = patch.inspector_id == null ? null : String(patch.inspector_id)
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'inspection_mode')) {
          next.inspection_mode = patch.inspection_mode == null ? null : String(patch.inspection_mode)
          if (next.inspection_mode === 'pending_decision' || next.inspection_mode === 'self_complete') {
            next.inspector_id = null
          }
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'inspection_due_date')) {
          next.inspection_due_date = patch.inspection_due_date == null ? null : String(patch.inspection_due_date)
        }
        if (touchesStatus) {
          next.status = String(patch.status)
        } else {
          const beforeStatus = String(it.status || 'pending')
          const statusAutoEligible = beforeStatus === 'pending' || beforeStatus === 'assigned'
          if ((touchesCleaner || touchesAssignee || touchesInspector || touchesInspectionPlan) && statusAutoEligible) {
            const cleaner = String(next.cleaner_id || next.assignee_id || '').trim()
            const inspector = String(next.inspector_id || '').trim()
            next.status = cleaner || inspector ? 'assigned' : 'pending'
          }
        }
        return next
      })
    })
    try {
      await postJSON('/cleaning/tasks/bulk-patch', { ids: normIds, patch })
    } catch (e) {
      await loadDay().catch(() => {})
      throw e
    } finally {
      setPendingTaskKeys((prev) => prev.filter((key) => !nextPendingKeys.includes(key)))
    }
  }, [cleaningPendingKeys, hasAnyPendingKey, loadDay])

  const updateWorkTask = useCallback(async (id: string, patch: Partial<Pick<WorkTask, 'status' | 'urgency' | 'title' | 'summary' | 'property_id' | 'assignee_id' | 'scheduled_date'>>) => {
    const pendingKey = workPendingKey(id)
    if (hasPendingKey(pendingKey)) return
    setPendingTaskKeys((prev) => Array.from(new Set([...prev, pendingKey])))
    setTaskCenterDay((prev) => {
      if (!prev) return prev
      const nextTasks = prev.tasks.map((t) => (String(t.id) === String(id) ? { ...t, ...patch } as any : t))
      const pool: WorkTask[] = []
      const groups: Record<string, WorkTask[]> = {}
      for (const t of nextTasks) {
        const aid = String(t.assignee_id || '').trim()
        if (!aid || String(t.scheduled_date || '') !== String(prev.date || '')) pool.push(t)
        else {
          groups[aid] = groups[aid] || []
          groups[aid].push(t)
        }
      }
      return { ...prev, tasks: nextTasks, pool, groups }
    })
    try {
      await patchJSON(`/work-tasks/${encodeURIComponent(id)}`, patch, { timeoutMs: 20000 })
    } catch (e) {
      await loadDay().catch(() => {})
      throw e
    } finally {
      setPendingTaskKeys((prev) => prev.filter((key) => key !== pendingKey))
    }
  }, [hasPendingKey, loadDay, workPendingKey])

  const openCreateModal = useCallback(() => {
    setOfflineCreate({
      date,
      task_type: 'other',
      title: '',
      content: '',
      urgency: 'medium',
      property_id: null,
      assignee_id: null,
    })
    setCreateOpen(true)
  }, [date])

  const submitCreate = useCallback(async () => {
    setCreateLoading(true)
    try {
      if (!offlineCreate) return
      const day = dayjs(offlineCreate.date || dateStr).format('YYYY-MM-DD')
      const title = String(offlineCreate.title || '').trim()
      const content = String(offlineCreate.content || '').trim()
      if (!title) { message.warning('请输入任务标题'); return }
      const payload: any = {
        date: day,
        task_type: offlineCreate.task_type,
        title,
        content,
        kind: 'other',
        status: 'todo',
        urgency: offlineCreate.urgency,
        property_id: offlineCreate.task_type === 'property' ? (offlineCreate.property_id || undefined) : undefined,
        assignee_id: offlineCreate.assignee_id || undefined,
      }
      await postJSON('/cleaning/offline-tasks', payload, { timeoutMs: 20000 })
      if (day === dateStr) await loadDay()
      else setDate(dayjs(day))
      message.success('任务已创建')
      setCreateOpen(false)
    } catch (e: any) {
      message.error(e?.message || '创建失败')
    } finally {
      setCreateLoading(false)
    }
  }, [dateStr, loadDay, offlineCreate])

  const openInspectionPlanModal = useCallback((it: CalendarItem) => {
    setInspectionPlanItem(it)
    setInspectionPlanMode((inspectionModeOf(it) as any) || 'pending_decision')
    setInspectionPlanDate(it.inspection_due_date ? dayjs(it.inspection_due_date) : null)
    setInspectionPlanInspectorId(it.inspector_id ? String(it.inspector_id) : null)
    setInspectionPlanOpen(true)
  }, [inspectionModeOf])

  const submitInspectionPlan = useCallback(async () => {
    if (!inspectionPlanItem) return
    const ids = entityIds(inspectionPlanItem)
    if (!ids.length) return
    if (inspectionPlanMode === 'deferred' && !inspectionPlanDate) {
      message.warning('请选择延后检查日期')
      return
    }
    const patch: any = {
      inspection_mode: inspectionPlanMode,
      inspection_due_date: inspectionPlanMode === 'deferred' ? inspectionPlanDate?.format('YYYY-MM-DD') : null,
      inspector_id: inspectionPlanMode === 'pending_decision' || inspectionPlanMode === 'self_complete'
        ? null
        : (inspectionPlanInspectorId || null),
    }
    setInspectionPlanLoading(true)
    try {
      await updateCleaningTasks(ids, patch)
      message.success('检查安排已更新')
      setInspectionPlanOpen(false)
      setInspectionPlanItem(null)
    } catch (e: any) {
      message.error(String(e?.message || '更新失败'))
    } finally {
      setInspectionPlanLoading(false)
    }
  }, [entityIds, inspectionPlanDate, inspectionPlanInspectorId, inspectionPlanItem, inspectionPlanMode, updateCleaningTasks])

  const TaskBoardCleaning = useMemo(() => {
    if (tab !== 'cleaning' && tab !== 'inspection') return null
    const mode = tab
    const base = filterCleanItems(
      mergedCleaningItems.filter((it) => (mode === 'cleaning' ? it.cleaning_board_enabled !== false : it.inspection_board_enabled === true)),
    )
    const allWork = Array.isArray(taskCenterDay?.tasks) ? taskCenterDay!.tasks : []
    const offlineBase = filterOfflineItems(
      allWork
        .filter((t) => String(t.task_kind || '') === 'offline')
        .filter((t) => !t.scheduled_date || String(t.scheduled_date) <= dateStr)
        .filter((t) => t.status !== 'done' && t.status !== 'cancelled')
    )
    const poolCleaning = base.filter((it) => {
      if (mode === 'inspection') {
        const st = effectiveCleaningStatus(it, 'inspection')
        if (st === 'assigned' || st === 'completed' || st === 'cancelled') return false
        return !String(it.inspector_id || '').trim()
      }
      {
        const st = effectiveCleaningStatus(it, 'cleaning')
        if (st === 'assigned' || st === 'completed' || st === 'cancelled') return false
        return !String(it.cleaner_id || it.assignee_id || '').trim()
      }
    })
    const poolSelfComplete = poolCleaning.filter(isSelfCompleteCleaningItem)
    const poolOffline = offlineBase.filter((t) => !String(t.assignee_id || '').trim())

    type BoardItem = { source: 'cleaning'; it: CalendarItem } | { source: 'work'; it: WorkTask }

    const pool: BoardItem[] = (() => {
      if (poolView === 'other') return poolOffline.map((it) => ({ source: 'work' as const, it }))
      if (poolView === 'self_complete') return poolSelfComplete.map((it) => ({ source: 'cleaning' as const, it }))
      if (poolView === 'cleaning' || poolView === 'inspection') return poolCleaning.map((it) => ({ source: 'cleaning' as const, it }))
      return [
        ...poolCleaning.map((it) => ({ source: 'cleaning' as const, it })),
        ...poolOffline.map((it) => ({ source: 'work' as const, it })),
      ]
    })()

    const groups = new Map<string, BoardItem[]>()
    for (const it of base) {
      const key = mode === 'cleaning'
        ? String(it.cleaner_id || it.assignee_id || '').trim()
        : String(it.inspector_id || '').trim()
      if (!key) continue
      const arr = groups.get(key) || []
      arr.push({ source: 'cleaning', it })
      groups.set(key, arr)
    }
    for (const t of offlineBase) {
      const key = String(t.assignee_id || '').trim()
      if (!key) continue
      const arr = groups.get(key) || []
      arr.push({ source: 'work', it: t })
      groups.set(key, arr)
    }
    const staffListRaw = mode === 'cleaning' ? activeCleaners : activeInspectors
    const staffList = staffListRaw.filter((s) => {
      const sid = String(s.id)
      const c = (groups.get(sid) || []).length
      if (staffFilter === 'busy') return c > 0
      if (staffFilter === 'idle') return c === 0
      return true
    })
    const poolKey = mode === 'cleaning' ? 'pool:cleaning' : 'pool:inspection'
    const poolTitle = '未安排任务'
    return (
      <div className={`${styles.boardWrap} ${styles.taskCenterBoardWrap}`}>
        <div
          className={`${styles.poolPane} ${styles.taskCenterPoolPane} ${dragOverKey === poolKey ? styles.dropActive : ''}`}
          onDragOver={(e) => { e.preventDefault(); activateDragTarget(poolKey) }}
          onDragLeave={() => clearDragTarget(poolKey)}
          onDrop={(e) => {
            e.preventDefault()
            const { ids, source } = parseDragPayload(e.dataTransfer.getData('text/plain'))
            if (!ids.length) { clearDragTarget(); return }
            if (source === 'work') {
              const id = ids[0]
              if (!id || hasPendingKey(workPendingKey(id))) { clearDragTarget(); return }
              updateWorkTask(id, { assignee_id: null, scheduled_date: dateStr }).catch((err: any) => message.error(err?.message || '更新失败'))
                .finally(() => clearDragTarget())
              return
            }
            if (hasAnyPendingKey(cleaningPendingKeys(ids))) { clearDragTarget(); return }
            const patch: any = mode === 'cleaning' ? { cleaner_id: null } : {}
            if (mode === 'inspection') {
              const targetItems = mergedCleaningItems.filter((it) => ids.some((id) => entityIds(it).includes(id)))
              const hasDeferredProjection = targetItems.some((it) => it.deferred_inspection_view)
              patch.inspector_id = null
              if (!hasDeferredProjection) patch.inspection_mode = 'pending_decision'
            }
            updateCleaningTasks(ids, patch).catch((err: any) => message.error(err?.message || '更新失败'))
              .finally(() => clearDragTarget())
          }}
        >
          <div className={`${styles.poolHead} ${styles.taskCenterPoolHead}`}>
            <div className={styles.poolTitle}>{poolTitle}</div>
            <div className={styles.poolCount}>{pool.length}</div>
          </div>
          {renderPoolTools(cleaningPoolFilterOptions)}
          <div className={styles.poolList}>
            {loading && !pool.length ? (
              <>
                <div className={styles.taskChip}><Skeleton active paragraph={{ rows: 1 }} /></div>
                <div className={styles.taskChip}><Skeleton active paragraph={{ rows: 1 }} /></div>
              </>
            ) : pool.length ? pool.map((x) => {
              if (x.source === 'work') {
                const t = x.it
                const pending = hasPendingKey(workPendingKey(t.id))
                const stripe = stripeColorForUrgency(t.urgency)
                const code = propertyCodeById(t.property_id || null)
                const title = String(t.title || '').trim()
                const detail = workSummaryText(t.summary)
                const st = t.status === 'done' ? 'done' : (String(t.assignee_id || '').trim() ? 'assigned' : 'todo')
                return (
                  <div
                    key={`work:${t.id}`}
                    className={`${styles.taskChip} ${pending ? styles.taskChipDisabled : styles.taskChipDraggable}`}
                    draggable={!pending}
                    onDragStart={(e) => {
                      if (pending) return
                      e.dataTransfer.setData('text/plain', JSON.stringify({ source: 'work', ids: [t.id] }))
                      e.dataTransfer.effectAllowed = 'move'
                    }}
                    onDragEnd={() => clearDragTarget()}
                    title={title}
                    onDoubleClick={() => {
                      if (pending) return
                      const next = t.status === 'done' ? 'todo' : 'done'
                      updateWorkTask(t.id, { status: next }).catch((err: any) => message.error(err?.message || '更新失败'))
                    }}
                  >
                    <span className={styles.taskGrip}><HolderOutlined /></span>
                    <div className={styles.taskStripe} style={{ backgroundColor: stripe }} />
                    <div className={styles.taskMain}>
                      <div className={styles.taskTopRow}>
                        <span className={`${styles.statusChip} ${statusChipCls(st)}`}>{statusText(st)}</span>
                      </div>
                      <div className={styles.taskTitleRow}>
                        <span className={styles.taskCode}>{code}</span>
                        {title ? <span className={styles.taskDetail}>{title}</span> : null}
                      </div>
                      <div className={styles.taskSubRow}>{detail || '\u00A0'}</div>
                    </div>
                  </div>
                )
              }
              const it = x.it
              const ids = entityIds(it)
              const kind = kindOfCleaningItem(it)
              const stripe = stripeColorForKind(kind)
              const sum = summaryText(it)
              const title = taskTextForCleaningItem(it)
              const st = effectiveCleaningStatus(it, mode)
              const pending = hasAnyPendingKey(cleaningPendingKeys(ids))
              const draggable = !pending && !dayLocked && (it.auto_sync_enabled !== false || !String(it.order_id || '').trim())
              const isMerged = Array.isArray(it.entity_ids) && it.entity_ids.length > 1
              const hasAssignee = !!String(it.cleaner_id || it.assignee_id || '').trim()
              const isKeyUploaded = !!(it.has_key_photo || it.key_photo_uploaded_at)
              const showKeyMissing = mode === 'cleaning' && hasAssignee && !isKeyUploaded && String(st || '').toLowerCase() !== 'cancelled' && String(st || '').toLowerCase() !== 'done' && String(st || '').toLowerCase() !== 'completed'
              const planLabel = inspectionModeLabel(it)
              const showInspectionAction = shouldShowInspectionPlanAction(it)
              return (
                <div
                  key={`cleaning:${it.entity_id}`}
                  className={`${styles.taskChip} ${draggable ? styles.taskChipDraggable : styles.taskChipDisabled}`}
                  draggable={draggable}
                  onDragStart={(e) => {
                    if (!draggable) return
                    e.dataTransfer.setData('text/plain', JSON.stringify({ source: 'cleaning', ids, task_type: it.task_type || null }))
                    e.dataTransfer.effectAllowed = 'move'
                  }}
                  onDragEnd={() => clearDragTarget()}
                  title={title}
                >
                  <span className={styles.taskGrip}><HolderOutlined /></span>
                  <div className={styles.taskStripe} style={{ backgroundColor: stripe }} />
                  <div className={styles.taskMain}>
                    <div className={styles.taskTopMetaRow}>
                      <div className={styles.taskTopRow}>
                        <span className={`${styles.statusChip} ${statusChipCls(st)}`}>{statusText(st)}</span>
                        {isMerged ? <Tag>合并 {ids.length}</Tag> : null}
                        {canConfigureInspection(it) ? <Tag color="geekblue">{planLabel}</Tag> : null}
                        {!canConfigureInspection(it) && mode === 'inspection' && it.deferred_inspection_view ? <Tag color="geekblue">{planLabel}</Tag> : null}
                        {hasLateCheckout(it) ? <Tag color="orange">晚退房</Tag> : null}
                        {showKeyMissing ? <Tag color="red">钥匙未上传</Tag> : null}
                      </div>
                      {showInspectionAction ? (
                        <Tooltip title={inspectionActionLabel(it)}>
                          <Button
                            size="small"
                            shape="circle"
                            icon={<CalendarOutlined />}
                            aria-label={inspectionActionLabel(it)}
                            className={styles.taskInlineActionBtn}
                            onClick={(e) => {
                              e.preventDefault()
                              e.stopPropagation()
                              openInspectionPlanModal(it)
                            }}
                          />
                        </Tooltip>
                      ) : null}
                    </div>
                    <div className={styles.taskTitleRow}>
                      {sum.region ? <span className={styles.taskRegion}>{sum.region}</span> : null}
                      <span className={styles.taskCode}>{sum.code || '-'}</span>
                    </div>
                    <div className={styles.taskSubRow}>{sum.detail || '\u00A0'}</div>
                  </div>
                </div>
              )
            }) : (
              <div className={styles.taskChip}><Empty description="无未安排任务" /></div>
            )}
          </div>
        </div>

        <div className={`${styles.staffPane} ${styles.taskCenterStaffPane}`}>
          {renderStaffTools()}
          <div className={`${styles.staffBoard} ${styles.taskCenterStaffBoard}`}>
          {staffList.map((s) => {
            const sid = String(s.id)
            const key = `staff:${mode}:${sid}`
            const arr = groups.get(sid) || []
            const expKey = `${mode}:${sid}`
            const viewMode = expandedStaff[expKey] || 'preview'
            const expanded = viewMode === 'expanded'
            const collapsed = viewMode === 'collapsed'
            return (
              <div
                key={sid}
                id={`staffcol-${mode}-${sid}`}
                className={`${styles.staffCol} ${styles.taskCenterStaffRow} ${dragOverKey === key ? styles.dropActive : ''} ${staffFocusId === sid ? styles.staffHighlight : ''}`}
                onDragOver={(e) => { e.preventDefault(); activateDragTarget(key) }}
                onDragLeave={() => clearDragTarget(key)}
                onDrop={(e) => {
                  e.preventDefault()
                  const { ids, source } = parseDragPayload(e.dataTransfer.getData('text/plain'))
                  if (!ids.length) { clearDragTarget(); return }
                  if (source === 'work') {
                    const id = ids[0]
                    if (!id || hasPendingKey(workPendingKey(id))) { clearDragTarget(); return }
                    updateWorkTask(id, { assignee_id: sid, scheduled_date: dateStr }).catch((err: any) => message.error(err?.message || '更新失败'))
                      .finally(() => clearDragTarget())
                    return
                  }
                  if (hasAnyPendingKey(cleaningPendingKeys(ids))) { clearDragTarget(); return }
                  const patch: any =
                    mode === 'cleaning'
                      ? { cleaner_id: sid }
                      : { inspector_id: sid, inspection_mode: 'same_day' }
                  updateCleaningTasks(ids, patch).catch((err: any) => message.error(err?.message || '更新失败'))
                    .finally(() => clearDragTarget())
                }}
              >
                <div
                  className={`${styles.staffColHead} ${styles.taskCenterStaffRowHead}`}
                  onClick={() => setExpandedStaff((p) => {
                    const cur = p[expKey] || 'preview'
                    const next = cur === 'expanded' ? 'collapsed' : 'expanded'
                    return { ...p, [expKey]: next }
                  })}
                  style={{ cursor: 'pointer' }}
                >
                  <div className={styles.staffName}>{s.name}</div>
                  <div className={styles.staffHeadRight}>
                    <div className={styles.staffCount}>{arr.length}</div>
                    {expanded ? <CaretDownOutlined /> : <CaretRightOutlined />}
                  </div>
                </div>
                <div className={`${styles.staffColBody} ${styles.taskCenterStaffRowBody}`}>
                  {dragOverKey === key ? <div className={`${styles.dropHint} ${styles.taskCenterDropHint}`}>放至此处分配</div> : null}
                  {!collapsed ? (
                    <div className={`${expanded ? styles.staffExpandedList : styles.staffPreviewList} ${styles.taskCenterTaskRail} ${expanded ? styles.taskCenterTaskRailExpanded : styles.taskCenterTaskRailPreview}`}>
                      {arr.map((x) => {
                    if (x.source === 'work') {
                      const t = x.it
                      const pending = hasPendingKey(workPendingKey(t.id))
                      const stripe = stripeColorForUrgency(t.urgency)
                      const code = propertyCodeById(t.property_id || null)
                      const title = String(t.title || '').trim()
                const detail = workSummaryText(t.summary)
                      const st = t.status === 'done' ? 'done' : (String(t.assignee_id || '').trim() ? 'assigned' : 'todo')
                      return (
                        <div
                          key={`work:assigned:${t.id}`}
                          className={`${styles.taskChip} ${pending ? styles.taskChipDisabled : styles.taskChipDraggable} ${styles.taskCenterAssignedChip}`}
                          draggable={!pending}
                          onDragStart={(e) => {
                            if (pending) return
                            e.dataTransfer.setData('text/plain', JSON.stringify({ source: 'work', ids: [t.id] }))
                            e.dataTransfer.effectAllowed = 'move'
                          }}
                          onDragEnd={() => clearDragTarget()}
                          title={title}
                          onDoubleClick={() => {
                            if (pending) return
                            const next = t.status === 'done' ? 'todo' : 'done'
                            updateWorkTask(t.id, { status: next }).catch((err: any) => message.error(err?.message || '更新失败'))
                          }}
                        >
                          <span className={styles.taskGrip}><HolderOutlined /></span>
                          <div className={styles.taskStripe} style={{ backgroundColor: stripe }} />
                          <div className={styles.taskMain}>
                            <div className={styles.taskTopRow}>
                              <span className={`${styles.statusChip} ${statusChipCls(st)}`}>{statusText(st)}</span>
                            </div>
                            <div className={styles.taskTitleRow}>
                              <span className={styles.taskCode}>{code}</span>
                              {title ? <span className={styles.taskDetail}>{title}</span> : null}
                            </div>
                            <div className={styles.taskSubRow}>{detail || '\u00A0'}</div>
                          </div>
                        </div>
                      )
                    }
                    const it = x.it
                    const ids = entityIds(it)
                    const kind = kindOfCleaningItem(it)
                    const stripe = stripeColorForKind(kind)
                    const sum = summaryText(it)
                    const title = taskTextForCleaningItem(it)
                    const st = effectiveCleaningStatus(it, mode)
                    const pending = hasAnyPendingKey(cleaningPendingKeys(ids))
                    const draggable = !pending && !dayLocked && (it.auto_sync_enabled !== false || !String(it.order_id || '').trim())
                    const isMerged = Array.isArray(it.entity_ids) && it.entity_ids.length > 1
                    const isSelfComplete = isSelfCompleteCleaningItem(it)
                    const planLabel = inspectionModeLabel(it)
                    const showInspectionAction = shouldShowInspectionPlanAction(it)
                    return (
                      <div
                        key={`assigned:${it.entity_id}`}
                        className={`${styles.taskChip} ${draggable ? styles.taskChipDraggable : styles.taskChipDisabled} ${styles.taskCenterAssignedChip}`}
                        draggable={draggable}
                        onDragStart={(e) => {
                          if (!draggable) return
                          e.dataTransfer.setData('text/plain', JSON.stringify({ source: 'cleaning', ids, task_type: it.task_type || null }))
                          e.dataTransfer.effectAllowed = 'move'
                        }}
                        onDragEnd={() => clearDragTarget()}
                        title={title}
                      >
                        <span className={styles.taskGrip}><HolderOutlined /></span>
                        <div className={styles.taskStripe} style={{ backgroundColor: stripe }} />
                        <div className={styles.taskMain}>
                          <div className={styles.taskTopMetaRow}>
                            <div className={styles.taskTopRow}>
                              <span className={`${styles.statusChip} ${statusChipCls(st)}`}>{statusText(st)}</span>
                              {isMerged ? <Tag>合并 {ids.length}</Tag> : null}
                              {isSelfComplete ? <Tag color="blue">自完成</Tag> : null}
                              {canConfigureInspection(it) ? <Tag color="geekblue">{planLabel}</Tag> : null}
                              {!canConfigureInspection(it) && mode === 'inspection' && it.deferred_inspection_view ? <Tag color="geekblue">{planLabel}</Tag> : null}
                            </div>
                            {showInspectionAction ? (
                              <Tooltip title={inspectionActionLabel(it)}>
                                <Button
                                  size="small"
                                  shape="circle"
                                  icon={<CalendarOutlined />}
                                  aria-label={inspectionActionLabel(it)}
                                  className={styles.taskInlineActionBtn}
                                  onClick={(e) => {
                                    e.preventDefault()
                                    e.stopPropagation()
                                    openInspectionPlanModal(it)
                                  }}
                                />
                              </Tooltip>
                            ) : null}
                          </div>
                          <div className={styles.taskTitleRow}>
                            {sum.region ? <span className={styles.taskRegion}>{sum.region}</span> : null}
                            <span className={styles.taskCode}>{sum.code || '-'}</span>
                          </div>
                          <div className={styles.taskSubRow}>{sum.detail || '\u00A0'}</div>
                        </div>
                      </div>
                    )
                  })}
                    </div>
                  ) : null}
                  {!expanded ? <div className={`${styles.dropZone} ${styles.taskCenterDropZone} ${collapsed ? styles.dropZoneCollapsed : (arr.length ? styles.dropZoneCompact : '')}`}>放入分配</div> : null}
                </div>
              </div>
            )
          })}
          </div>
        </div>
      </div>
    )
  }, [activateDragTarget, activeCleaners, activeInspectors, canConfigureInspection, cleaningPendingKeys, cleaningPoolFilterOptions, clearDragTarget, dateStr, dayLocked, dragOverKey, effectiveCleaningStatus, entityIds, expandedStaff, filterCleanItems, filterOfflineItems, hasAnyPendingKey, hasLateCheckout, hasPendingKey, inspectionActionLabel, inspectionModeLabel, isSelfCompleteCleaningItem, kindOfCleaningItem, loading, mergedCleaningItems, openInspectionPlanModal, parseDragPayload, poolView, propertyCodeById, renderPoolTools, renderStaffTools, shouldShowInspectionPlanAction, staffFilter, staffFocusId, statusChipCls, statusText, stripeColorForKind, stripeColorForUrgency, summaryText, tab, taskCenterDay, taskTextForCleaningItem, updateCleaningTasks, updateWorkTask, workPendingKey, workSummaryText])

  const TaskBoardMaintenance = useMemo(() => {
    if (tab !== 'maintenance') return null
    const allWork = Array.isArray(taskCenterDay?.tasks) ? taskCenterDay!.tasks : []
    const base = filterRepairs(allWork)
    const pool = base.filter((r) => {
      const assignee = String(r.assignee_id || '').trim()
      const eta = String(r.scheduled_date || '').slice(0, 10)
      return !assignee || eta !== dateStr
    })
    const groups = new Map<string, WorkTask[]>()
    for (const r of base) {
      const eta = String(r.scheduled_date || '').slice(0, 10)
      if (eta !== dateStr) continue
      const key = String(r.assignee_id || '').trim()
      if (!key) continue
      const arr = groups.get(key) || []
      arr.push(r)
      groups.set(key, arr)
    }
    const poolKey = 'pool:maintenance'
    const staffList = activeMaintenanceStaff.filter((s) => {
      const sid = String(s.id)
      const c = (groups.get(sid) || []).length
      if (staffFilter === 'busy') return c > 0
      if (staffFilter === 'idle') return c === 0
      return true
    })
    return (
      <div className={`${styles.boardWrap} ${styles.taskCenterBoardWrap}`}>
        <div
          className={`${styles.poolPane} ${styles.taskCenterPoolPane} ${dragOverKey === poolKey ? styles.dropActive : ''}`}
          onDragOver={(e) => { e.preventDefault(); activateDragTarget(poolKey) }}
          onDragLeave={() => clearDragTarget(poolKey)}
          onDrop={(e) => {
            e.preventDefault()
            const { ids, source } = parseDragPayload(e.dataTransfer.getData('text/plain'))
            if (source !== 'work') { clearDragTarget(); return }
            const id = ids[0]
            if (!id || hasPendingKey(workPendingKey(id))) { clearDragTarget(); return }
            updateWorkTask(id, { assignee_id: null, scheduled_date: null }).catch((err: any) => message.error(err?.message || '更新失败'))
              .finally(() => clearDragTarget())
          }}
        >
          <div className={`${styles.poolHead} ${styles.taskCenterPoolHead}`}>
            <div className={styles.poolTitle}>未安排维修</div>
            <div className={styles.poolCount}>{pool.length}</div>
          </div>
          {renderPoolTools(workPoolFilterOptions)}
          <div className={styles.poolList}>
            {loading && !pool.length ? (
              <>
                <div className={styles.taskChip}><Skeleton active paragraph={{ rows: 1 }} /></div>
                <div className={styles.taskChip}><Skeleton active paragraph={{ rows: 1 }} /></div>
              </>
            ) : pool.length ? pool.map((r) => {
              const pending = hasPendingKey(workPendingKey(r.id))
              const stripe = stripeColorForUrgency(String(r.urgency || ''))
              const workNo = String(r.title || '').trim()
              const code = propertyCodeById(r.property_id || null)
              const summary = workSummaryText(r.summary)
              const title = `${code} ${workNo} ${summary}`.trim()
              const st = String(r.status || '').trim()
              return (
                <div
                  key={`work:maintenance:${r.id}`}
                  className={`${styles.taskChip} ${pending ? styles.taskChipDisabled : styles.taskChipDraggable}`}
                  draggable={!pending}
                  onDragStart={(e) => {
                    if (pending) return
                    e.dataTransfer.setData('text/plain', JSON.stringify({ source: 'work', ids: [r.id] }))
                    e.dataTransfer.effectAllowed = 'move'
                  }}
                  onDragEnd={() => clearDragTarget()}
                  title={title}
                >
                  <span className={styles.taskGrip}><HolderOutlined /></span>
                  <div className={styles.taskStripe} style={{ backgroundColor: stripe }} />
                  <div className={styles.taskMain}>
                    <div className={styles.taskTopRow}>
                      <span className={`${styles.statusChip} ${statusChipCls(st)}`}>{statusText(st)}</span>
                    </div>
                    <div className={styles.taskTitleRow}>
                      <span className={styles.taskCode}>{code}</span>
                      {workNo ? <span className={styles.taskDetailPlain}>{workNo}</span> : null}
                    </div>
                    <div className={styles.taskSubRow}>{summary || '\u00A0'}</div>
                  </div>
                </div>
              )
            }) : (
              <div className={styles.taskChip}><Empty description="无未安排维修" /></div>
            )}
          </div>
        </div>

        <div className={`${styles.staffPane} ${styles.taskCenterStaffPane}`}>
          {renderStaffTools()}
          <div className={`${styles.staffBoard} ${styles.taskCenterStaffBoard}`}>
          {staffList.map((s) => {
            const sid = String(s.id)
            const key = `staff:maintenance:${sid}`
            const arr = groups.get(sid) || []
            const expKey = `maintenance:${sid}`
            const viewMode = expandedStaff[expKey] || 'preview'
            const expanded = viewMode === 'expanded'
            const collapsed = viewMode === 'collapsed'
            return (
              <div
                key={sid}
                id={`staffcol-maintenance-${sid}`}
                className={`${styles.staffCol} ${styles.taskCenterStaffRow} ${dragOverKey === key ? styles.dropActive : ''} ${staffFocusId === sid ? styles.staffHighlight : ''}`}
                onDragOver={(e) => { e.preventDefault(); activateDragTarget(key) }}
                onDragLeave={() => clearDragTarget(key)}
                onDrop={(e) => {
                  e.preventDefault()
                  const { ids, source } = parseDragPayload(e.dataTransfer.getData('text/plain'))
                  if (source !== 'work') { clearDragTarget(); return }
                  const id = ids[0]
                  if (!id || hasPendingKey(workPendingKey(id))) { clearDragTarget(); return }
                  updateWorkTask(id, { assignee_id: sid, scheduled_date: dateStr }).catch((err: any) => message.error(err?.message || '更新失败'))
                    .finally(() => clearDragTarget())
                }}
              >
                <div
                  className={`${styles.staffColHead} ${styles.taskCenterStaffRowHead}`}
                  onClick={() => setExpandedStaff((p) => {
                    const cur = p[expKey] || 'preview'
                    const next = cur === 'expanded' ? 'collapsed' : 'expanded'
                    return { ...p, [expKey]: next }
                  })}
                  style={{ cursor: 'pointer' }}
                >
                  <div className={styles.staffName}>{s.name}</div>
                  <div className={styles.staffHeadRight}>
                    <div className={styles.staffCount}>{arr.length}</div>
                    {expanded ? <CaretDownOutlined /> : <CaretRightOutlined />}
                  </div>
                </div>
                <div className={`${styles.staffColBody} ${styles.taskCenterStaffRowBody}`}>
                  {dragOverKey === key ? <div className={`${styles.dropHint} ${styles.taskCenterDropHint}`}>放至此处分配</div> : null}
                  {!collapsed ? (
                    <div className={`${expanded ? styles.staffExpandedList : styles.staffPreviewList} ${styles.taskCenterTaskRail} ${expanded ? styles.taskCenterTaskRailExpanded : styles.taskCenterTaskRailPreview}`}>
                      {arr.map((r) => {
                    const pending = hasPendingKey(workPendingKey(r.id))
                    const stripe = stripeColorForUrgency(String(r.urgency || ''))
                    const workNo = String(r.title || '').trim()
                    const code = propertyCodeById(r.property_id || null)
                    const summary = workSummaryText(r.summary)
                    const title = `${code} ${workNo} ${summary}`.trim()
                    const st = String(r.status || '').trim()
                    return (
                      <div
                        key={`work:maintenance:assigned:${r.id}`}
                        className={`${styles.taskChip} ${pending ? styles.taskChipDisabled : styles.taskChipDraggable} ${styles.taskCenterAssignedChip}`}
                        draggable={!pending}
                        onDragStart={(e) => {
                          if (pending) return
                          e.dataTransfer.setData('text/plain', JSON.stringify({ source: 'work', ids: [r.id] }))
                          e.dataTransfer.effectAllowed = 'move'
                        }}
                        onDragEnd={() => clearDragTarget()}
                        title={title}
                      >
                        <span className={styles.taskGrip}><HolderOutlined /></span>
                        <div className={styles.taskStripe} style={{ backgroundColor: stripe }} />
                        <div className={styles.taskMain}>
                          <div className={styles.taskTopRow}>
                            <span className={`${styles.statusChip} ${statusChipCls(st)}`}>{statusText(st)}</span>
                          </div>
                          <div className={styles.taskTitleRow}>
                            <span className={styles.taskCode}>{code}</span>
                            {workNo ? <span className={styles.taskDetailPlain}>{workNo}</span> : null}
                          </div>
                          <div className={styles.taskSubRow}>{summary || '\u00A0'}</div>
                        </div>
                      </div>
                    )
                  })}
                    </div>
                  ) : null}
                  {!expanded ? <div className={`${styles.dropZone} ${styles.taskCenterDropZone} ${collapsed ? styles.dropZoneCollapsed : (arr.length ? styles.dropZoneCompact : '')}`}>放入分配</div> : null}
                </div>
              </div>
            )
          })}
          </div>
        </div>
      </div>
    )
  }, [activateDragTarget, activeMaintenanceStaff, clearDragTarget, dateStr, dragOverKey, expandedStaff, filterRepairs, hasPendingKey, loading, parseDragPayload, propertyCodeById, renderPoolTools, renderStaffTools, staffFilter, staffFocusId, statusChipCls, statusText, stripeColorForUrgency, tab, taskCenterDay, updateWorkTask, workPendingKey, workPoolFilterOptions, workSummaryText])

  const TaskBoardDeepCleaning = useMemo(() => {
    if (tab !== 'deep_cleaning') return null
    const allWork = Array.isArray(taskCenterDay?.tasks) ? taskCenterDay!.tasks : []
    const base = filterDeepCleaning(allWork)
    const pool = base.filter((r) => {
      const assignee = String(r.assignee_id || '').trim()
      const eta = String(r.scheduled_date || '').slice(0, 10)
      return !assignee || eta !== dateStr
    })
    const groups = new Map<string, WorkTask[]>()
    for (const r of base) {
      const eta = String(r.scheduled_date || '').slice(0, 10)
      if (eta !== dateStr) continue
      const key = String(r.assignee_id || '').trim()
      if (!key) continue
      const arr = groups.get(key) || []
      arr.push(r)
      groups.set(key, arr)
    }
    const poolKey = 'pool:deep_cleaning'
    const staffList = activeCleaners.filter((s) => {
      const sid = String(s.id)
      const c = (groups.get(sid) || []).length
      if (staffFilter === 'busy') return c > 0
      if (staffFilter === 'idle') return c === 0
      return true
    })
    return (
      <div className={`${styles.boardWrap} ${styles.taskCenterBoardWrap}`}>
        <div
          className={`${styles.poolPane} ${styles.taskCenterPoolPane} ${dragOverKey === poolKey ? styles.dropActive : ''}`}
          onDragOver={(e) => { e.preventDefault(); activateDragTarget(poolKey) }}
          onDragLeave={() => clearDragTarget(poolKey)}
          onDrop={(e) => {
            e.preventDefault()
            const { ids, source } = parseDragPayload(e.dataTransfer.getData('text/plain'))
            if (source !== 'work') { clearDragTarget(); return }
            const id = ids[0]
            if (!id || hasPendingKey(workPendingKey(id))) { clearDragTarget(); return }
            updateWorkTask(id, { assignee_id: null, scheduled_date: null }).catch((err: any) => message.error(err?.message || '更新失败'))
              .finally(() => clearDragTarget())
          }}
        >
          <div className={`${styles.poolHead} ${styles.taskCenterPoolHead}`}>
            <div className={styles.poolTitle}>未安排深清</div>
            <div className={styles.poolCount}>{pool.length}</div>
          </div>
          {renderPoolTools(workPoolFilterOptions)}
          <div className={styles.poolList}>
            {loading && !pool.length ? (
              <>
                <div className={styles.taskChip}><Skeleton active paragraph={{ rows: 1 }} /></div>
                <div className={styles.taskChip}><Skeleton active paragraph={{ rows: 1 }} /></div>
              </>
            ) : pool.length ? pool.map((r) => {
              const pending = hasPendingKey(workPendingKey(r.id))
              const stripe = stripeColorForUrgency(String(r.urgency || ''))
              const workNo = String(r.title || '').trim()
              const code = propertyCodeById(r.property_id || null)
              const summary = workSummaryText(r.summary)
              const title = `${code} ${workNo} ${summary}`.trim()
              const st = String(r.status || '').trim()
              return (
                <div
                  key={`work:deep:${r.id}`}
                  className={`${styles.taskChip} ${pending ? styles.taskChipDisabled : styles.taskChipDraggable}`}
                  draggable={!pending}
                  onDragStart={(e) => {
                    if (pending) return
                    e.dataTransfer.setData('text/plain', JSON.stringify({ source: 'work', ids: [r.id] }))
                    e.dataTransfer.effectAllowed = 'move'
                  }}
                  onDragEnd={() => clearDragTarget()}
                  title={title}
                >
                  <span className={styles.taskGrip}><HolderOutlined /></span>
                  <div className={styles.taskStripe} style={{ backgroundColor: stripe }} />
                  <div className={styles.taskMain}>
                    <div className={styles.taskTopRow}>
                      <span className={`${styles.statusChip} ${statusChipCls(st)}`}>{statusText(st)}</span>
                    </div>
                    <div className={styles.taskTitleRow}>
                      <span className={styles.taskCode}>{code}</span>
                      {workNo ? <span className={styles.taskDetailPlain}>{workNo}</span> : null}
                    </div>
                    <div className={styles.taskSubRow}>{summary || '\u00A0'}</div>
                  </div>
                </div>
              )
            }) : (
              <div className={styles.taskChip}><Empty description="无未安排深清" /></div>
            )}
          </div>
        </div>

        <div className={`${styles.staffPane} ${styles.taskCenterStaffPane}`}>
          {renderStaffTools()}
          <div className={`${styles.staffBoard} ${styles.taskCenterStaffBoard}`}>
          {staffList.map((s) => {
            const sid = String(s.id)
            const key = `staff:deep_cleaning:${sid}`
            const arr = groups.get(sid) || []
            const expKey = `deep_cleaning:${sid}`
            const viewMode = expandedStaff[expKey] || 'preview'
            const expanded = viewMode === 'expanded'
            const collapsed = viewMode === 'collapsed'
            return (
              <div
                key={sid}
                id={`staffcol-deep-cleaning-${sid}`}
                className={`${styles.staffCol} ${styles.taskCenterStaffRow} ${dragOverKey === key ? styles.dropActive : ''} ${staffFocusId === sid ? styles.staffHighlight : ''}`}
                onDragOver={(e) => { e.preventDefault(); activateDragTarget(key) }}
                onDragLeave={() => clearDragTarget(key)}
                onDrop={(e) => {
                  e.preventDefault()
                  const { ids, source } = parseDragPayload(e.dataTransfer.getData('text/plain'))
                  if (source !== 'work') { clearDragTarget(); return }
                  const id = ids[0]
                  if (!id || hasPendingKey(workPendingKey(id))) { clearDragTarget(); return }
                  updateWorkTask(id, { assignee_id: sid, scheduled_date: dateStr }).catch((err: any) => message.error(err?.message || '更新失败'))
                    .finally(() => clearDragTarget())
                }}
              >
                <div
                  className={`${styles.staffColHead} ${styles.taskCenterStaffRowHead}`}
                  onClick={() => setExpandedStaff((p) => {
                    const cur = p[expKey] || 'preview'
                    const next = cur === 'expanded' ? 'collapsed' : 'expanded'
                    return { ...p, [expKey]: next }
                  })}
                  style={{ cursor: 'pointer' }}
                >
                  <div className={styles.staffName}>{s.name}</div>
                  <div className={styles.staffHeadRight}>
                    <div className={styles.staffCount}>{arr.length}</div>
                    {expanded ? <CaretDownOutlined /> : <CaretRightOutlined />}
                  </div>
                </div>
                <div className={`${styles.staffColBody} ${styles.taskCenterStaffRowBody}`}>
                  {dragOverKey === key ? <div className={`${styles.dropHint} ${styles.taskCenterDropHint}`}>放至此处分配</div> : null}
                  {!collapsed ? (
                    <div className={`${expanded ? styles.staffExpandedList : styles.staffPreviewList} ${styles.taskCenterTaskRail} ${expanded ? styles.taskCenterTaskRailExpanded : styles.taskCenterTaskRailPreview}`}>
                      {arr.map((r) => {
                    const pending = hasPendingKey(workPendingKey(r.id))
                    const stripe = stripeColorForUrgency(String(r.urgency || ''))
                    const workNo = String(r.title || '').trim()
                    const code = propertyCodeById(r.property_id || null)
                    const summary = workSummaryText(r.summary)
                    const title = `${code} ${workNo} ${summary}`.trim()
                    const st = String(r.status || '').trim()
                    return (
                      <div
                        key={`work:deep:assigned:${r.id}`}
                        className={`${styles.taskChip} ${pending ? styles.taskChipDisabled : styles.taskChipDraggable} ${styles.taskCenterAssignedChip}`}
                        draggable={!pending}
                        onDragStart={(e) => {
                          if (pending) return
                          e.dataTransfer.setData('text/plain', JSON.stringify({ source: 'work', ids: [r.id] }))
                          e.dataTransfer.effectAllowed = 'move'
                        }}
                        onDragEnd={() => clearDragTarget()}
                        title={title}
                      >
                        <span className={styles.taskGrip}><HolderOutlined /></span>
                        <div className={styles.taskStripe} style={{ backgroundColor: stripe }} />
                        <div className={styles.taskMain}>
                          <div className={styles.taskTopRow}>
                            <span className={`${styles.statusChip} ${statusChipCls(st)}`}>{statusText(st)}</span>
                          </div>
                          <div className={styles.taskTitleRow}>
                            <span className={styles.taskCode}>{code}</span>
                            {workNo ? <span className={styles.taskDetailPlain}>{workNo}</span> : null}
                          </div>
                          <div className={styles.taskSubRow}>{summary || '\u00A0'}</div>
                        </div>
                      </div>
                    )
                  })}
                    </div>
                  ) : null}
                  {!expanded ? <div className={`${styles.dropZone} ${styles.taskCenterDropZone} ${collapsed ? styles.dropZoneCollapsed : (arr.length ? styles.dropZoneCompact : '')}`}>放入分配</div> : null}
                </div>
              </div>
            )
          })}
          </div>
        </div>
      </div>
    )
  }, [activateDragTarget, activeCleaners, clearDragTarget, dateStr, dragOverKey, expandedStaff, filterDeepCleaning, hasPendingKey, loading, parseDragPayload, propertyCodeById, renderPoolTools, renderStaffTools, staffFilter, staffFocusId, statusChipCls, statusText, stripeColorForUrgency, tab, taskCenterDay, updateWorkTask, workPendingKey, workPoolFilterOptions, workSummaryText])

  const staffOptionsAll = useMemo(() => (
    activeAllStaff.map((s) => ({ value: s.id, label: s.name }))
  ), [activeAllStaff])

  const createTitle = '新增线下任务'

  return (
    <div className={styles.page}>
      <div className={styles.container}>
        {error ? <Alert type="error" showIcon message="任务中心数据加载失败" description={error} /> : null}

        <div className={`${styles.card} ${styles.headerCard}`}>
          <div className={styles.navGroup}>
            <Button className={styles.navBtn} icon={<LeftOutlined />} onClick={goPrev} />
            <div className={styles.monthTitle}>任务中心（{dateStr}）</div>
            <Button className={styles.navBtn} icon={<RightOutlined />} onClick={goNext} />
            <Button className={styles.todayBtn} onClick={() => setDate(dayjs())}>今天</Button>
          </div>
          <div className={styles.rightGroup}>
            <DatePicker value={date} onChange={(v) => v && setDate(v)} />
            <Button className={styles.secondaryBtn} icon={<ReloadOutlined />} onClick={() => loadDay().catch(() => {})} loading={loading}>
              刷新
            </Button>
            <Button className={styles.secondaryBtn} onClick={lockDay} disabled={!lockTaskIds.length}>
              锁定当日
            </Button>
            <Button className={styles.secondaryBtn} onClick={unlockDay} disabled={!unlockTaskIds.length}>
              解锁当日
            </Button>
            <Button className={styles.primaryBtn} icon={<PlusOutlined />} onClick={openCreateModal}>
              新增线下任务
            </Button>
          </div>
        </div>

        <div className={`${styles.card} ${styles.taskCenterCard}`}>
          <div className={styles.detailsHead}>
            <div>
              <div className={styles.detailsTitle}>任务分配</div>
              <div className={styles.detailsDate}>拖拽任务到人员列完成分配</div>
            </div>
          </div>

          {tab === 'cleaning' || tab === 'inspection' ? TaskBoardCleaning : null}
          {tab === 'maintenance' ? TaskBoardMaintenance : null}
          {tab === 'deep_cleaning' ? TaskBoardDeepCleaning : null}
        </div>
      </div>

      <Modal
        open={inspectionPlanOpen}
        title="检查安排"
        okText="保存"
        confirmLoading={inspectionPlanLoading}
        onOk={() => submitInspectionPlan().catch(() => {})}
        onCancel={() => {
          if (inspectionPlanLoading) return
          setInspectionPlanOpen(false)
          setInspectionPlanItem(null)
        }}
      >
        {inspectionPlanItem ? (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Alert
              type="info"
              showIcon
              message={taskTextForCleaningItem(inspectionPlanItem)}
              description="退房任务由线下经理确认检查安排；未确认前不会进入检查池。"
            />
            <div>
              <div className={styles.fieldLabel}>检查安排</div>
              <Select
                value={inspectionPlanMode}
                onChange={(v) => {
                  const mode = String(v) as 'pending_decision' | 'same_day' | 'self_complete' | 'deferred'
                  setInspectionPlanMode(mode)
                  if (mode !== 'deferred') setInspectionPlanDate(null)
                  if (mode === 'pending_decision' || mode === 'self_complete') setInspectionPlanInspectorId(null)
                }}
                style={{ width: '100%' }}
                options={[
                  { label: '待确认', value: 'pending_decision' },
                  { label: '同日检查', value: 'same_day' },
                  { label: '自完成', value: 'self_complete' },
                  { label: '延后检查', value: 'deferred' },
                ]}
              />
            </div>
            {inspectionPlanMode === 'deferred' ? (
              <div>
                <div className={styles.fieldLabel}>检查日期</div>
                <DatePicker value={inspectionPlanDate} onChange={(v) => setInspectionPlanDate(v)} style={{ width: '100%' }} />
              </div>
            ) : null}
            {(inspectionPlanMode === 'same_day' || inspectionPlanMode === 'deferred') ? (
              <div>
                <div className={styles.fieldLabel}>检查人员（可选）</div>
                <Select
                  allowClear
                  showSearch
                  optionFilterProp="label"
                  value={inspectionPlanInspectorId || undefined}
                  onChange={(v) => setInspectionPlanInspectorId(v ? String(v) : null)}
                  style={{ width: '100%' }}
                  options={activeInspectors.map((s) => ({ value: s.id, label: s.name }))}
                />
              </div>
            ) : null}
          </Space>
        ) : null}
      </Modal>

      <Modal
        open={createOpen}
        title={createTitle}
        okText="创建"
        confirmLoading={createLoading}
        onOk={() => submitCreate().catch(() => {})}
        onCancel={() => setCreateOpen(false)}
      >
        {offlineCreate ? (
          <Space direction="vertical" style={{ width: '100%' }}>
            <div>
              <div className={styles.fieldLabel}>日期</div>
              <DatePicker
                value={offlineCreate.date}
                onChange={(v) => v && setOfflineCreate((p) => (p ? { ...p, date: v } : p))}
                style={{ width: '100%' }}
              />
            </div>
            <div>
              <div className={styles.fieldLabel}>任务类型</div>
              <Select
                value={offlineCreate.task_type}
                onChange={(v) => setOfflineCreate((p) => (p ? { ...p, task_type: v } : p))}
                style={{ width: '100%' }}
                options={[
                  { label: '房源任务', value: 'property' },
                  { label: '公司任务', value: 'company' },
                  { label: '其他任务', value: 'other' },
                ]}
              />
            </div>
            {offlineCreate.task_type === 'property' ? (
              <div>
                <div className={styles.fieldLabel}>房号</div>
                <Select
                  showSearch
                  optionFilterProp="label"
                  value={offlineCreate.property_id || undefined}
                  onChange={(v) => setOfflineCreate((p) => (p ? { ...p, property_id: v ? String(v) : null } : p))}
                  style={{ width: '100%' }}
                  options={properties.map((p) => ({ value: p.id, label: p.code || p.address || p.id }))}
                />
              </div>
            ) : null}
            <div>
              <div className={styles.fieldLabel}>标题</div>
              <Input
                value={offlineCreate.title}
                onChange={(e) => setOfflineCreate((p) => (p ? { ...p, title: e.target.value } : p))}
                placeholder="例如：采购清洁剂 / 更换床单 / 跟进维修"
              />
            </div>
            <div>
              <div className={styles.fieldLabel}>内容</div>
              <Input.TextArea
                rows={4}
                value={offlineCreate.content}
                onChange={(e) => setOfflineCreate((p) => (p ? { ...p, content: e.target.value } : p))}
              />
            </div>
            <div>
              <div className={styles.fieldLabel}>紧急程度</div>
              <Select
                value={offlineCreate.urgency}
                onChange={(v) => setOfflineCreate((p) => (p ? { ...p, urgency: v } : p))}
                style={{ width: '100%' }}
                options={[
                  { label: '低', value: 'low' },
                  { label: '中', value: 'medium' },
                  { label: '高', value: 'high' },
                  { label: '紧急', value: 'urgent' },
                ]}
              />
            </div>
            <div>
              <div className={styles.fieldLabel}>分配给</div>
              <Select
                allowClear
                showSearch
                optionFilterProp="label"
                value={offlineCreate.assignee_id || undefined}
                onChange={(v) => setOfflineCreate((p) => (p ? { ...p, assignee_id: v ? String(v) : null } : p))}
                style={{ width: '100%' }}
                options={staffOptionsAll}
              />
            </div>
            <Alert type="info" showIcon message="提示：任务可在任务中心拖拽分配；线下任务可双击切换完成状态。" />
          </Space>
        ) : null}
      </Modal>
    </div>
  )
}
