"use client"

import { Alert, Button, DatePicker, Empty, Modal, Segmented, Select, Skeleton, Space, Tag, message, Input } from 'antd'
import { CaretDownOutlined, CaretRightOutlined, HolderOutlined, LeftOutlined, PlusOutlined, ReloadOutlined, RightOutlined } from '@ant-design/icons'
import { useCallback, useEffect, useMemo, useState } from 'react'
import dayjs, { type Dayjs } from 'dayjs'
import { apiList, apiUpdate, getJSON, patchJSON, postJSON } from '../../lib/api'
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
  auto_sync_enabled?: boolean
  old_code?: string | null
  new_code?: string | null
  nights?: number | null
  summary_checkout_time?: string | null
  summary_checkin_time?: string | null
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

type RepairOrder = {
  id: string
  property_id?: string
  category?: string
  category_detail?: string
  details?: string
  work_no?: string
  urgency?: 'urgent' | 'normal' | 'not_urgent' | 'high' | 'medium' | 'low'
  status?: 'pending' | 'assigned' | 'in_progress' | 'completed' | 'canceled'
  assignee_id?: string | null
  eta?: string | null
  submitted_at?: string
}

export default function TaskCenterPage() {
  const [date, setDate] = useState<Dayjs>(() => dayjs())
  const dateStr = useMemo(() => date.format('YYYY-MM-DD'), [date])

  const [tab, setTab] = useState<'cleaning' | 'inspection' | 'offline' | 'maintenance'>('cleaning')

  const [staff, setStaff] = useState<Staff[]>([])
  const [properties, setProperties] = useState<{ id: string; code?: string; address?: string; region?: string | null }[]>([])

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [cleaningItems, setCleaningItems] = useState<CalendarItem[]>([])
  const [offlineTasks, setOfflineTasks] = useState<OfflineTask[]>([])
  const [repairs, setRepairs] = useState<RepairOrder[]>([])

  const [dragOverKey, setDragOverKey] = useState<string | null>(null)

  const [createOpen, setCreateOpen] = useState(false)
  const [createLoading, setCreateLoading] = useState(false)

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
  const [poolView, setPoolView] = useState<'all' | 'cleaning' | 'inspection' | 'maintenance' | 'other'>('all')
  const [staffFilter, setStaffFilter] = useState<'all' | 'busy' | 'idle'>('all')
  const [staffSearch, setStaffSearch] = useState('')
  const [staffFocusId, setStaffFocusId] = useState<string | null>(null)
  const [expandedStaff, setExpandedStaff] = useState<Record<string, 'preview' | 'expanded' | 'collapsed'>>({})

  const entityIds = useCallback((it: CalendarItem) => {
    const ids = Array.isArray(it.entity_ids) && it.entity_ids.length ? it.entity_ids : [it.entity_id]
    return Array.from(new Set(ids.map((x) => String(x)).filter(Boolean)))
  }, [])

  const parseDragPayload = useCallback((payloadText: string): { ids: string[]; task_type?: string | null; source?: 'cleaning' | 'offline' } => {
    try {
      const j = JSON.parse(payloadText)
      const ids = Array.isArray(j?.ids) ? j.ids.map((x: any) => String(x)).filter(Boolean) : []
      const sourceRaw = String(j?.source || '').trim().toLowerCase()
      const source = sourceRaw === 'offline' ? 'offline' : (sourceRaw === 'cleaning' ? 'cleaning' : undefined)
      return { ids, task_type: j?.task_type != null ? String(j.task_type) : undefined, source }
    } catch {
      return { ids: [] }
    }
  }, [])

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
      const [itemsRes, tasksRes, repairsRes] = await Promise.allSettled([
        getJSON<CalendarItem[]>(`/cleaning/calendar-range?from=${encodeURIComponent(day)}&to=${encodeURIComponent(day)}`),
        getJSON<OfflineTask[]>(`/cleaning/offline-tasks?date=${encodeURIComponent(day)}&include_overdue=1`),
        apiList<RepairOrder[]>('property_maintenance'),
      ])

      if (itemsRes.status === 'fulfilled') {
        const items = itemsRes.value
        setCleaningItems(Array.isArray(items) ? items.filter((x) => x.source === 'cleaning_tasks') : [])
      }
      if (tasksRes.status === 'fulfilled') {
        const tasks = tasksRes.value
        setOfflineTasks(Array.isArray(tasks) ? tasks : [])
      }
      if (repairsRes.status === 'fulfilled') {
        const rs = repairsRes.value
        setRepairs(Array.isArray(rs) ? rs : [])
      }

      const hadError = [itemsRes, tasksRes, repairsRes].some((r) => r.status === 'rejected')
      if (hadError) setError('部分数据加载失败')
    } catch (e: any) {
      setError(String(e?.message || '加载失败'))
    } finally {
      setLoading(false)
    }
  }, [dateStr])

  const dayTaskIds = useMemo(() => {
    const out: string[] = []
    for (const it of cleaningItems) {
      if (it.source !== 'cleaning_tasks') continue
      out.push(String(it.entity_id))
    }
    return Array.from(new Set(out.map((x) => String(x)).filter(Boolean)))
  }, [cleaningItems])

  const lockDay = useCallback(async () => {
    if (!dayTaskIds.length) { message.warning('当日无可锁定任务'); return }
    Modal.confirm({
      title: '确认锁定当日安排？',
      content: '锁定后将禁用拖拽分配与快速指派，需手动解锁才能继续修改。',
      okText: '锁定',
      okButtonProps: { danger: true },
      onOk: async () => {
        await postJSON('/cleaning/tasks/bulk-lock-auto-sync', { ids: dayTaskIds })
        setCleaningItems((prev) => {
          const idSet = new Set(dayTaskIds.map((x) => String(x)))
          return prev.map((it) => (it.source === 'cleaning_tasks' && idSet.has(String(it.entity_id)) ? { ...it, auto_sync_enabled: false } : it))
        })
        message.success('已锁定当日安排')
      },
    })
  }, [dayTaskIds])

  const unlockDay = useCallback(async () => {
    if (!dayTaskIds.length) { message.warning('当日无可解锁任务'); return }
    Modal.confirm({
      title: '确认解锁当日安排？',
      content: '解锁后允许拖拽与快速指派，并恢复自动同步。',
      okText: '解锁',
      onOk: async () => {
        await postJSON('/cleaning/tasks/bulk-restore-auto-sync', { ids: dayTaskIds })
        setCleaningItems((prev) => {
          const idSet = new Set(dayTaskIds.map((x) => String(x)))
          return prev.map((it) => (it.source === 'cleaning_tasks' && idSet.has(String(it.entity_id)) ? { ...it, auto_sync_enabled: true } : it))
        })
        message.success('已解锁当日安排')
      },
    })
  }, [dayTaskIds])

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
    const mode = tab === 'maintenance' ? 'maintenance' : (tab === 'inspection' ? 'inspection' : 'cleaning')
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

  const isCheckinLikeTaskType = useCallback((taskType: string | null | undefined) => {
    const tt = String(taskType || '').toLowerCase()
    return tt === 'checkin_clean' || tt === 'turnover'
  }, [])

  const effectiveCleaningStatus = useCallback((it: CalendarItem) => {
    const raw = String(it.status || 'pending')
    if (raw === 'completed' || raw === 'in_progress' || raw === 'cancelled') return raw
    const inspector = String(it.inspector_id || '').trim()
    if (inspector && isCheckinLikeTaskType(it.task_type || null)) return 'assigned'
    return raw
  }, [isCheckinLikeTaskType])

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
      const arr = byProp.get(pid) || []
      arr.push(it)
      byProp.set(pid, arr)
    }

    const isStayover = (x: CalendarItem) => String(x.task_type || '').toLowerCase() === 'stayover_clean' || String(x.label || '').includes('入住中清洁') || `${x.label}`.toLowerCase().includes('stayover')
    const isCheckin = (x: CalendarItem) => !isStayover(x) && (String(x.task_type || '').toLowerCase() === 'checkin_clean' || (String(x.label || '').includes('入住') && !String(x.label || '').includes('入住中清洁')) || `${x.label}`.toLowerCase().includes('checkin'))
    const isCheckout = (x: CalendarItem) => String(x.task_type || '').toLowerCase() === 'checkout_clean' || String(x.label || '').includes('退房') || `${x.label}`.toLowerCase().includes('checkout')
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
          auto_sync_enabled: autoSync,
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
    return { region, code, detail: parts.join(' ') }
  }, [])

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

  const filterOfflineItems = useCallback((items: OfflineTask[]) => {
    if (!filterQuery) return items
    return items.filter((t) => {
      const p = String(t.property_id || '').trim()
      const title = String(t.title || '').trim()
      const content = String(t.content || '').trim()
      return `${p} ${title} ${content}`.toLowerCase().includes(filterQuery)
    })
  }, [filterQuery])

  const summaryFromDetails = useCallback((details?: string) => {
    const s = String(details || '')
    if (!s) return ''
    try {
      const arr = JSON.parse(s)
      if (Array.isArray(arr) && arr[0] && typeof arr[0].content === 'string') return String(arr[0].content || '')
    } catch {}
    return s
  }, [])

  const filterRepairs = useCallback((items: RepairOrder[]) => {
    const base = items.filter((r) => {
      const status = String(r.status || '').trim()
      if (status === 'completed' || status === 'canceled') return false
      return true
    })
    const day = dateStr
    const withEta = base.filter((r) => String((r as any).eta || '').slice(0, 10) === day)
    const withoutEta = base.filter((r) => !String((r as any).eta || '').trim())
    const merged = [...withoutEta, ...withEta]
    if (!filterQuery) return merged
    return merged.filter((r) => {
      const code = String(r.property_id || '').trim()
      const workNo = String((r as any).work_no || r.id || '').trim()
      const sum = summaryFromDetails(r.details)
      return `${code} ${workNo} ${sum}`.toLowerCase().includes(filterQuery)
    })
  }, [dateStr, filterQuery, summaryFromDetails])

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

  const updateCleaningTasks = useCallback(async (ids: string[], patch: any) => {
    const normIds = Array.from(new Set(ids.map((x) => String(x)).filter(Boolean)))
    if (!normIds.length) return
    await postJSON('/cleaning/tasks/bulk-patch', { ids: normIds, patch })
    setCleaningItems((prev) => {
      const idSet = new Set(normIds)
      return prev.map((it) => {
        if (it.source !== 'cleaning_tasks') return it
        if (!idSet.has(String(it.entity_id))) return it
        const next: any = { ...it }
        if (Object.prototype.hasOwnProperty.call(patch, 'cleaner_id')) {
          const v = patch.cleaner_id == null ? null : String(patch.cleaner_id)
          next.cleaner_id = v
          next.assignee_id = v
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'inspector_id')) {
          next.inspector_id = patch.inspector_id == null ? null : String(patch.inspector_id)
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'status')) {
          next.status = String(patch.status)
        }
        return next
      })
    })
  }, [])

  const updateOfflineTask = useCallback(async (id: string, patch: Partial<Pick<OfflineTask, 'status' | 'urgency' | 'title' | 'content' | 'kind' | 'property_id' | 'task_type' | 'assignee_id' | 'date'>>) => {
    await patchJSON(`/cleaning/offline-tasks/${encodeURIComponent(id)}`, patch)
    setOfflineTasks((prev) => prev.map((t) => (String(t.id) === String(id) ? { ...t, ...patch } as any : t)))
  }, [])

  const updateRepair = useCallback(async (id: string, patch: Partial<Pick<RepairOrder, 'status' | 'assignee_id' | 'eta' | 'urgency' | 'details'>>) => {
    await apiUpdate('property_maintenance', id, patch)
    setRepairs((prev) => prev.map((r) => (String(r.id) === String(id) ? { ...r, ...patch } as any : r)))
  }, [])

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

  const staffOptionsAll = useMemo(() => (
    activeAllStaff.map((s) => ({ value: s.id, label: s.name }))
  ), [activeAllStaff])

  const submitCreate = useCallback(async () => {
    setCreateLoading(true)
    try {
      if (!offlineCreate) return
      const payload: any = {
        date: dayjs(offlineCreate.date || dateStr).format('YYYY-MM-DD'),
        task_type: offlineCreate.task_type,
        title: String(offlineCreate.title || '').trim(),
        content: String(offlineCreate.content || '').trim(),
        kind: 'other',
        status: 'todo',
        urgency: offlineCreate.urgency,
        property_id: offlineCreate.task_type === 'property' ? (offlineCreate.property_id || undefined) : undefined,
        assignee_id: offlineCreate.assignee_id || undefined,
      }
      if (!payload.title) { message.warning('请输入任务标题'); return }
      const created = await postJSON<OfflineTask>('/cleaning/offline-tasks', payload)
      if (String(created.date || '').slice(0, 10) === dateStr) setOfflineTasks((prev) => [created, ...prev])
      else setDate(dayjs(String(created.date).slice(0, 10)))
      message.success('任务已创建')
      setCreateOpen(false)
    } catch (e: any) {
      message.error(e?.message || '创建失败')
    } finally {
      setCreateLoading(false)
    }
  }, [dateStr, offlineCreate])

  const TaskBoardCleaning = useMemo(() => {
    const base = filterCleanItems(mergedCleaningItems)
    if (tab !== 'cleaning' && tab !== 'inspection') return null
    const mode = tab
    const offlineBase = filterOfflineItems(offlineTasks).filter((t) => String(t.status || '') !== 'done')
    const poolCleaning = base.filter((it) => {
      if (mode === 'inspection') {
        const st = effectiveCleaningStatus(it)
        if (st === 'assigned') return false
        return !String(it.inspector_id || '').trim()
      }
      {
        const st = effectiveCleaningStatus(it)
        if (st === 'assigned') return false
        return !String(it.cleaner_id || it.assignee_id || '').trim()
      }
    })
    const poolOffline = offlineBase.filter((t) => !String(t.assignee_id || '').trim())

    type BoardItem = { source: 'cleaning'; it: CalendarItem } | { source: 'offline'; it: OfflineTask }

    const pool: BoardItem[] = (() => {
      if (poolView === 'other') return poolOffline.map((it) => ({ source: 'offline' as const, it }))
      if (poolView === 'cleaning' || poolView === 'inspection') return poolCleaning.map((it) => ({ source: 'cleaning' as const, it }))
      return [
        ...poolCleaning.map((it) => ({ source: 'cleaning' as const, it })),
        ...poolOffline.map((it) => ({ source: 'offline' as const, it })),
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
      arr.push({ source: 'offline', it: t })
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
      <div className={styles.boardWrap}>
        <div
          className={`${styles.poolPane} ${dragOverKey === poolKey ? styles.dropActive : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragOverKey(poolKey) }}
          onDragLeave={() => setDragOverKey((k) => (k === poolKey ? null : k))}
          onDrop={(e) => {
            e.preventDefault()
            const { ids, task_type, source } = parseDragPayload(e.dataTransfer.getData('text/plain'))
            if (!ids.length) { setDragOverKey(null); return }
            if (source === 'offline') {
              const id = ids[0]
              if (!id) { setDragOverKey(null); return }
              updateOfflineTask(id, { assignee_id: null, date: dateStr }).catch((err: any) => message.error(err?.message || '更新失败'))
                .finally(() => setDragOverKey(null))
              return
            }
            const patch: any = mode === 'cleaning' ? { cleaner_id: null } : { inspector_id: null }
            if (mode === 'inspection' && isCheckinLikeTaskType(task_type || null)) patch.status = 'pending'
            updateCleaningTasks(ids, patch).catch((err: any) => message.error(err?.message || '更新失败'))
              .finally(() => setDragOverKey(null))
          }}
        >
          <div className={styles.poolHead}>
            <div className={styles.poolTitle}>{poolTitle}</div>
            <div className={styles.poolCount}>{pool.length}</div>
          </div>
          <div className={styles.poolTools}>
            <Segmented
              size="small"
              options={[
                { label: '全部', value: 'all' },
                { label: '清洁', value: 'cleaning' },
                { label: '检查', value: 'inspection' },
                { label: '维修', value: 'maintenance' },
                { label: '其他', value: 'other' },
              ]}
              value={poolView}
              onChange={(v) => {
                const val = v as any
                if (val === 'maintenance') { setPoolView('maintenance'); setTab('maintenance'); return }
                if (val === 'inspection') { setPoolView('inspection'); setTab('inspection'); return }
                if (val === 'cleaning') { setPoolView('cleaning'); setTab('cleaning'); return }
                if (val === 'other') { setPoolView('other'); return }
                setPoolView('all')
              }}
            />
            <Input
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              placeholder="搜索房源..."
              allowClear
            />
          </div>
          <div className={styles.poolList}>
            {loading && !pool.length ? (
              <>
                <div className={styles.taskChip}><Skeleton active paragraph={{ rows: 1 }} /></div>
                <div className={styles.taskChip}><Skeleton active paragraph={{ rows: 1 }} /></div>
              </>
            ) : pool.length ? pool.map((x) => {
              if (x.source === 'offline') {
                const t = x.it
                const stripe = stripeColorForUrgency(t.urgency)
                const code = propertyCodeById(t.property_id || null)
                const title = String(t.title || '').trim()
                const detail = String(t.content || '').trim()
                const st = t.status === 'done' ? 'done' : (String(t.assignee_id || '').trim() ? 'assigned' : 'todo')
                return (
                  <div
                    key={`offline:${t.id}`}
                    className={`${styles.taskChip} ${styles.taskChipDraggable}`}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData('text/plain', JSON.stringify({ source: 'offline', ids: [t.id] }))
                      e.dataTransfer.effectAllowed = 'move'
                    }}
                    onDragEnd={() => setDragOverKey(null)}
                    title={title}
                    onDoubleClick={() => {
                      const next = t.status === 'done' ? 'todo' : 'done'
                      updateOfflineTask(t.id, { status: next }).catch((err: any) => message.error(err?.message || '更新失败'))
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
              const st = effectiveCleaningStatus(it)
              const draggable = !dayLocked && (it.auto_sync_enabled !== false || !String(it.order_id || '').trim())
              const isMerged = Array.isArray(it.entity_ids) && it.entity_ids.length > 1
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
                  onDragEnd={() => setDragOverKey(null)}
                  title={title}
                >
                  <span className={styles.taskGrip}><HolderOutlined /></span>
                  <div className={styles.taskStripe} style={{ backgroundColor: stripe }} />
                  <div className={styles.taskMain}>
                    <div className={styles.taskTopRow}>
                      <span className={`${styles.statusChip} ${statusChipCls(st)}`}>{statusText(st)}</span>
                      {isMerged ? <Tag>合并 {ids.length}</Tag> : null}
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

        <div className={styles.staffPane}>
          <div className={styles.staffTools}>
            <div className={styles.staffToolsRow}>
              <Segmented
                size="small"
                options={[
                  { label: '全部人员', value: 'all' },
                  { label: '有任务', value: 'busy' },
                  { label: '空闲', value: 'idle' },
                ]}
                value={staffFilter}
                onChange={(v) => setStaffFilter(v as any)}
              />
              <Input
                className={styles.staffJump}
                value={staffSearch}
                onChange={(e) => setStaffSearch(e.target.value)}
                placeholder="搜索人员并定位…"
                allowClear
              />
            </div>
          </div>
          <div className={styles.staffBoard}>
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
                className={`${styles.staffCol} ${dragOverKey === key ? styles.dropActive : ''} ${staffFocusId === sid ? styles.staffHighlight : ''}`}
                onDragOver={(e) => { e.preventDefault(); setDragOverKey(key) }}
                onDragLeave={() => setDragOverKey((k) => (k === key ? null : k))}
                onDrop={(e) => {
                  e.preventDefault()
                  const { ids, task_type, source } = parseDragPayload(e.dataTransfer.getData('text/plain'))
                  if (!ids.length) { setDragOverKey(null); return }
                  if (source === 'offline') {
                    const id = ids[0]
                    if (!id) { setDragOverKey(null); return }
                    updateOfflineTask(id, { assignee_id: sid, date: dateStr }).catch((err: any) => message.error(err?.message || '更新失败'))
                      .finally(() => setDragOverKey(null))
                    return
                  }
                  const patch: any = mode === 'cleaning' ? { cleaner_id: sid } : { inspector_id: sid }
                  if (mode === 'inspection' && isCheckinLikeTaskType(task_type || null)) patch.status = 'assigned'
                  updateCleaningTasks(ids, patch).catch((err: any) => message.error(err?.message || '更新失败'))
                    .finally(() => setDragOverKey(null))
                }}
              >
                <div
                  className={styles.staffColHead}
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
                <div className={styles.staffColBody}>
                  {dragOverKey === key ? <div className={styles.dropHint}>放至此处分配</div> : null}
                  {!collapsed ? (
                    <div className={expanded ? styles.staffExpandedList : styles.staffPreviewList}>
                      {arr.map((x) => {
                    if (x.source === 'offline') {
                      const t = x.it
                      const stripe = stripeColorForUrgency(t.urgency)
                      const code = propertyCodeById(t.property_id || null)
                      const title = String(t.title || '').trim()
                      const detail = String(t.content || '').trim()
                      const st = t.status === 'done' ? 'done' : (String(t.assignee_id || '').trim() ? 'assigned' : 'todo')
                      return (
                        <div
                          key={`offline:assigned:${t.id}`}
                          className={`${styles.taskChip} ${styles.taskChipDraggable}`}
                          draggable
                          onDragStart={(e) => {
                            e.dataTransfer.setData('text/plain', JSON.stringify({ source: 'offline', ids: [t.id] }))
                            e.dataTransfer.effectAllowed = 'move'
                          }}
                          onDragEnd={() => setDragOverKey(null)}
                          title={title}
                          onDoubleClick={() => {
                            const next = t.status === 'done' ? 'todo' : 'done'
                            updateOfflineTask(t.id, { status: next }).catch((err: any) => message.error(err?.message || '更新失败'))
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
                    const st = effectiveCleaningStatus(it)
                    const draggable = !dayLocked && (it.auto_sync_enabled !== false || !String(it.order_id || '').trim())
                    const isMerged = Array.isArray(it.entity_ids) && it.entity_ids.length > 1
                    return (
                      <div
                        key={`assigned:${it.entity_id}`}
                        className={`${styles.taskChip} ${draggable ? styles.taskChipDraggable : styles.taskChipDisabled}`}
                        draggable={draggable}
                        onDragStart={(e) => {
                          if (!draggable) return
                          e.dataTransfer.setData('text/plain', JSON.stringify({ source: 'cleaning', ids, task_type: it.task_type || null }))
                          e.dataTransfer.effectAllowed = 'move'
                        }}
                        onDragEnd={() => setDragOverKey(null)}
                        title={title}
                      >
                        <span className={styles.taskGrip}><HolderOutlined /></span>
                        <div className={styles.taskStripe} style={{ backgroundColor: stripe }} />
                        <div className={styles.taskMain}>
                          <div className={styles.taskTopRow}>
                            <span className={`${styles.statusChip} ${statusChipCls(st)}`}>{statusText(st)}</span>
                            {isMerged ? <Tag>合并 {ids.length}</Tag> : null}
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
                  {!expanded ? <div className={`${styles.dropZone} ${collapsed ? styles.dropZoneCollapsed : (arr.length ? styles.dropZoneCompact : '')}`}>放入分配</div> : null}
                </div>
              </div>
            )
          })}
          </div>
        </div>
      </div>
    )
  }, [activeCleaners, activeInspectors, dateStr, dayLocked, dragOverKey, effectiveCleaningStatus, entityIds, expandedStaff, filterCleanItems, filterOfflineItems, filterText, isCheckinLikeTaskType, kindOfCleaningItem, loading, mergedCleaningItems, offlineTasks, parseDragPayload, poolView, propertyCodeById, staffFilter, staffFocusId, staffSearch, statusChipCls, statusText, stripeColorForKind, stripeColorForUrgency, summaryText, tab, taskTextForCleaningItem, updateCleaningTasks, updateOfflineTask])

  const TaskBoardMaintenance = useMemo(() => {
    if (tab !== 'maintenance') return null
    const base = filterRepairs(repairs)
    const pool = base.filter((r) => {
      const assignee = String(r.assignee_id || '').trim()
      const eta = String((r as any).eta || '').slice(0, 10)
      return !assignee || eta !== dateStr
    })
    const groups = new Map<string, RepairOrder[]>()
    for (const r of base) {
      const eta = String((r as any).eta || '').slice(0, 10)
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
      <div className={styles.boardWrap}>
        <div
          className={`${styles.poolPane} ${dragOverKey === poolKey ? styles.dropActive : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragOverKey(poolKey) }}
          onDragLeave={() => setDragOverKey((k) => (k === poolKey ? null : k))}
          onDrop={(e) => {
            e.preventDefault()
            const { ids } = parseDragPayload(e.dataTransfer.getData('text/plain'))
            const id = ids[0]
            if (!id) { setDragOverKey(null); return }
            updateRepair(id, { assignee_id: null, eta: null }).catch((err: any) => message.error(err?.message || '更新失败'))
              .finally(() => setDragOverKey(null))
          }}
        >
          <div className={styles.poolHead}>
            <div className={styles.poolTitle}>未安排维修</div>
            <div className={styles.poolCount}>{pool.length}</div>
          </div>
          <div className={styles.poolTools}>
            <Segmented
              size="small"
              options={[
                { label: '全部', value: 'all' },
                { label: '清洁', value: 'cleaning' },
                { label: '检查', value: 'inspection' },
                { label: '维修', value: 'maintenance' },
                { label: '其他', value: 'other' },
              ]}
              value={poolView}
              onChange={(v) => {
                const val = v as any
                if (val === 'maintenance') { setPoolView('maintenance'); setTab('maintenance'); return }
                if (val === 'inspection') { setPoolView('inspection'); setTab('inspection'); return }
                if (val === 'cleaning') { setPoolView('cleaning'); setTab('cleaning'); return }
                if (val === 'other') { setPoolView('other'); setTab('cleaning'); return }
                setPoolView('all')
              }}
            />
            <Input
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              placeholder="搜索房源..."
              allowClear
            />
          </div>
          <div className={styles.poolList}>
            {loading && !pool.length ? (
              <>
                <div className={styles.taskChip}><Skeleton active paragraph={{ rows: 1 }} /></div>
                <div className={styles.taskChip}><Skeleton active paragraph={{ rows: 1 }} /></div>
              </>
            ) : pool.length ? pool.map((r) => {
              const stripe = stripeColorForUrgency(String(r.urgency || ''))
              const workNo = String((r as any).work_no || '').trim()
              const code = propertyCodeById(r.property_id || null)
              const summary = summaryFromDetails(r.details)
              const title = `${code} ${workNo} ${summary}`.trim()
              return (
                <div
                  key={`repair:${r.id}`}
                  className={`${styles.taskChip} ${styles.taskChipDraggable}`}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData('text/plain', JSON.stringify({ ids: [r.id] }))
                    e.dataTransfer.effectAllowed = 'move'
                  }}
                  onDragEnd={() => setDragOverKey(null)}
                  title={title}
                >
                  <span className={styles.taskGrip}><HolderOutlined /></span>
                  <div className={styles.taskStripe} style={{ backgroundColor: stripe }} />
                  <div className={styles.taskMain}>
                    <div className={styles.taskTitleRow}>
                      <span className={styles.taskCode}>{code}</span>
                      {workNo ? <span className={styles.taskDetail}>{workNo}</span> : null}
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

        <div className={styles.staffPane}>
          <div className={styles.staffTools}>
            <div className={styles.staffToolsRow}>
              <Segmented
                size="small"
                options={[
                  { label: '全部人员', value: 'all' },
                  { label: '有任务', value: 'busy' },
                  { label: '空闲', value: 'idle' },
                ]}
                value={staffFilter}
                onChange={(v) => setStaffFilter(v as any)}
              />
              <Input
                className={styles.staffJump}
                value={staffSearch}
                onChange={(e) => setStaffSearch(e.target.value)}
                placeholder="搜索人员并定位…"
                allowClear
              />
            </div>
          </div>
          <div className={styles.staffBoard}>
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
                className={`${styles.staffCol} ${dragOverKey === key ? styles.dropActive : ''} ${staffFocusId === sid ? styles.staffHighlight : ''}`}
                onDragOver={(e) => { e.preventDefault(); setDragOverKey(key) }}
                onDragLeave={() => setDragOverKey((k) => (k === key ? null : k))}
                onDrop={(e) => {
                  e.preventDefault()
                  const { ids } = parseDragPayload(e.dataTransfer.getData('text/plain'))
                  const id = ids[0]
                  if (!id) { setDragOverKey(null); return }
                  updateRepair(id, { assignee_id: sid, eta: dateStr }).catch((err: any) => message.error(err?.message || '更新失败'))
                    .finally(() => setDragOverKey(null))
                }}
              >
                <div
                  className={styles.staffColHead}
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
                <div className={styles.staffColBody}>
                  {dragOverKey === key ? <div className={styles.dropHint}>放至此处分配</div> : null}
                  {!collapsed ? (
                    <div className={expanded ? styles.staffExpandedList : styles.staffPreviewList}>
                      {arr.map((r) => {
                    const stripe = stripeColorForUrgency(String(r.urgency || ''))
                    const workNo = String((r as any).work_no || '').trim()
                    const code = propertyCodeById(r.property_id || null)
                    const summary = summaryFromDetails(r.details)
                    const title = `${code} ${workNo} ${summary}`.trim()
                    return (
                      <div
                        key={`repair:assigned:${r.id}`}
                        className={`${styles.taskChip} ${styles.taskChipDraggable}`}
                        draggable
                        onDragStart={(e) => {
                          e.dataTransfer.setData('text/plain', JSON.stringify({ ids: [r.id] }))
                          e.dataTransfer.effectAllowed = 'move'
                        }}
                        onDragEnd={() => setDragOverKey(null)}
                        title={title}
                      >
                        <span className={styles.taskGrip}><HolderOutlined /></span>
                        <div className={styles.taskStripe} style={{ backgroundColor: stripe }} />
                        <div className={styles.taskMain}>
                          <div className={styles.taskTitleRow}>
                            <span className={styles.taskCode}>{code}</span>
                            {workNo ? <span className={styles.taskDetail}>{workNo}</span> : null}
                          </div>
                          <div className={styles.taskSubRow}>{summary || '\u00A0'}</div>
                        </div>
                      </div>
                    )
                  })}
                    </div>
                  ) : null}
                  {!expanded ? <div className={`${styles.dropZone} ${collapsed ? styles.dropZoneCollapsed : (arr.length ? styles.dropZoneCompact : '')}`}>放入分配</div> : null}
                </div>
              </div>
            )
          })}
          </div>
        </div>
      </div>
    )
  }, [activeMaintenanceStaff, dateStr, dragOverKey, expandedStaff, filterRepairs, filterText, loading, parseDragPayload, poolView, propertyCodeById, repairs, staffFilter, staffFocusId, staffSearch, stripeColorForUrgency, summaryFromDetails, tab, updateRepair])

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
            <Button className={styles.secondaryBtn} onClick={lockDay} disabled={!dayTaskIds.length}>
              锁定当日
            </Button>
            <Button className={styles.secondaryBtn} onClick={unlockDay} disabled={!dayTaskIds.length}>
              解锁当日
            </Button>
            <Button className={styles.primaryBtn} icon={<PlusOutlined />} onClick={openCreateModal}>
              新增线下任务
            </Button>
          </div>
        </div>

        <div className={styles.card}>
          <div className={styles.detailsHead}>
            <div>
              <div className={styles.detailsTitle}>任务分配</div>
              <div className={styles.detailsDate}>拖拽任务到人员列完成分配</div>
            </div>
            <div className={styles.filters}>
              <Segmented
                options={[
                  { label: '清洁', value: 'cleaning' },
                  { label: '检查', value: 'inspection' },
                  { label: '维修', value: 'maintenance' },
                ]}
                value={tab}
                onChange={(v) => {
                  const next = v as any
                  setTab(next)
                  setDragOverKey(null)
                  if (next === 'maintenance') setPoolView('maintenance')
                  else if (next === 'inspection') setPoolView('inspection')
                  else setPoolView('all')
                }}
              />
            </div>
          </div>

          {tab === 'cleaning' || tab === 'inspection' ? TaskBoardCleaning : null}
          {tab === 'maintenance' ? TaskBoardMaintenance : null}
        </div>
      </div>

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
            <Alert type="info" showIcon message="提示：线下任务可在任务中心拖拽分配；双击任务可切换完成状态。" />
          </Space>
        ) : null}
      </Modal>
    </div>
  )
}
