"use client"

import { Alert, Button, DatePicker, Empty, Input, Modal, Segmented, Select, Skeleton, Space, message } from 'antd'
import { EditOutlined, LeftOutlined, ReloadOutlined, RightOutlined } from '@ant-design/icons'
import { useCallback, useEffect, useMemo, useState } from 'react'
import dayjs, { type Dayjs } from 'dayjs'
import { API_BASE, getJSON, patchJSON, postJSON } from '../../lib/api'
import { cleaningColorKind } from '../../lib/cleaningColor'
import { formatTaskTime, isTaskLocked } from '../../lib/cleaningTaskUi'
import styles from './cleaningSchedule.module.scss'

type Staff = { id: string; name: string; capacity_per_day: number }

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
  scheduled_at: string | null
  auto_sync_enabled?: boolean
  old_code?: string | null
  new_code?: string | null
  nights?: number | null
  summary_checkout_time?: string | null
  summary_checkin_time?: string | null
  checkin_order_id?: string | null
  checkout_order_id?: string | null
  checkin_order_code?: string | null
  checkout_order_code?: string | null
  checkin_old_code?: string | null
  checkin_new_code?: string | null
  checkout_old_code?: string | null
  checkout_new_code?: string | null
}

type CleaningTaskRow = {
  id: string
  order_id?: string | null
  property_id?: string | null
  task_type?: string | null
  task_date?: string | null
  status?: string | null
  assignee_id?: string | null
  scheduled_at?: string | null
  note?: string | null
  auto_sync_enabled?: boolean | null
  old_code?: string | null
  new_code?: string | null
}

type EditTaskForm = {
  ids: string[]
  task_date: Dayjs
  status: string
  assignee_id: string | null
  scheduled_at: Dayjs | null
  note: string
  auto_sync_enabled: boolean
}

export default function CleaningPage() {
  const [view, setView] = useState<'day' | 'week' | 'month'>('month')
  const [month, setMonth] = useState<Dayjs>(() => dayjs())
  const [selectedDate, setSelectedDate] = useState<Dayjs>(() => dayjs())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [items, setItems] = useState<CalendarItem[]>([])
  const [staff, setStaff] = useState<Staff[]>([])
  const [filterRoom, setFilterRoom] = useState('')
  const [filterStatus, setFilterStatus] = useState<string | undefined>(undefined)
  const [properties, setProperties] = useState<{ id: string; code?: string; address?: string }[]>([])
  const [dbStatus, setDbStatus] = useState<any>(null)
  const [tasksMinMax, setTasksMinMax] = useState<{ min: string | null; max: string | null; from: string } | null>(null)
  const [tasksMinMaxError, setTasksMinMaxError] = useState<string | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  const [editForm, setEditForm] = useState<EditTaskForm | null>(null)
  const [backfillOpen, setBackfillOpen] = useState(false)
  const [backfillFrom, setBackfillFrom] = useState<Dayjs>(() => dayjs().subtract(90, 'day'))
  const [backfillTo, setBackfillTo] = useState<Dayjs>(() => dayjs().add(365, 'day'))
  const [backfillLoading, setBackfillLoading] = useState(false)
  const [debugOpen, setDebugOpen] = useState(false)
  const [debugLoading, setDebugLoading] = useState(false)
  const [debugState, setDebugState] = useState<any>(null)

  const monthLabel = useMemo(() => `${month.year()}年${String(month.month() + 1).padStart(2, '0')}月`, [month])
  const selectedDateStr = useMemo(() => selectedDate.format('YYYY-MM-DD'), [selectedDate])

  const visibleRange = useMemo(() => {
    if (view === 'day') {
      return { start: selectedDate.startOf('week'), end: selectedDate.endOf('week') }
    }
    if (view === 'week') {
      return { start: selectedDate.startOf('week'), end: selectedDate.endOf('week') }
    }
    const start = month.startOf('month').startOf('week')
    const end = month.endOf('month').endOf('week')
    return { start, end }
  }, [month, selectedDate, view])

  const days = useMemo(() => {
    const { start, end } = visibleRange
    const out: Dayjs[] = []
    let cur = start
    while (cur.isBefore(end) || cur.isSame(end, 'day')) {
      out.push(cur)
      cur = cur.add(1, 'day')
    }
    return out
  }, [visibleRange])

  const propertyLabelById = useCallback((id?: string | null) => {
    if (!id) return ''
    const p = properties.find((x) => String(x.id) === String(id))
    return p ? (p.code || p.address || p.id) : String(id)
  }, [properties])

  const propertyLabelForItem = useCallback((it: CalendarItem) => {
    const byId = propertyLabelById(it.property_id)
    if (byId && byId !== String(it.property_id || '')) return byId
    return (it.property_code || byId || (it.property_id ? String(it.property_id) : '')) || ''
  }, [propertyLabelById])

  const summaryText = useCallback((it: CalendarItem) => {
    const region = String(it.property_region || '').trim()
    const code = String(it.property_code || '').trim() || propertyLabelForItem(it)
    const checkoutT = String(it.summary_checkout_time || '11:30').trim()
    const checkinT = String(it.summary_checkin_time || '3pm').trim()
    const type = String(it.task_type || '').toLowerCase()
    const label = String(it.label || '')
    const isTurnover = type === 'turnover' || (label.includes('退房') && label.includes('入住'))
    const isCheckout = type === 'checkout_clean' || label.includes('退房')
    const isCheckin = type === 'checkin_clean' || label.includes('入住')
    const parts: string[] = []
    if (isTurnover) parts.push(`${checkoutT}退房`, `${checkinT}入住`)
    else if (isCheckout) parts.push(`${checkoutT}退房`)
    else if (isCheckin) parts.push(`${checkinT}入住`)
    return { region, code, detail: parts.join(' ') }
  }, [propertyLabelForItem])

  const entityIds = useCallback((it: CalendarItem) => {
    const ids = Array.isArray(it.entity_ids) && it.entity_ids.length ? it.entity_ids : [it.entity_id]
    return Array.from(new Set(ids.map((x) => String(x)).filter(Boolean)))
  }, [])

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

  const itemsByDate = useMemo(() => {
    const m = new Map<string, CalendarItem[]>()
    for (const it of items) {
      const d = String(it.task_date || '').slice(0, 10)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue
      const arr = m.get(d) || []
      arr.push(it)
      m.set(d, arr)
    }
    for (const [k, arr] of m.entries()) {
      const cleaning = arr.filter((x) => x.source === 'cleaning_tasks')
      const other = arr.filter((x) => x.source !== 'cleaning_tasks')
      const byProp = new Map<string, CalendarItem[]>()
      for (const it of cleaning) {
        const pid = String(it.property_id || '')
        const list = byProp.get(pid) || []
        list.push(it)
        byProp.set(pid, list)
      }
      const mergedCleaning: CalendarItem[] = []
      const isCheckin = (x: CalendarItem) => String(x.task_type || '').toLowerCase() === 'checkin_clean' || String(x.label || '').includes('入住') || `${x.label}`.toLowerCase().includes('checkin')
      const isCheckout = (x: CalendarItem) => String(x.task_type || '').toLowerCase() === 'checkout_clean' || String(x.label || '').includes('退房') || `${x.label}`.toLowerCase().includes('checkout')
      const preferOrderLinked = (xs: CalendarItem[]) => {
        const withOrder = xs.filter((x) => !!(x.order_id || x.order_code))
        return withOrder.length ? withOrder : xs
      }
      for (const list of byProp.values()) {
        const checkins0 = preferOrderLinked(list.filter(isCheckin))
        const checkouts0 = preferOrderLinked(list.filter(isCheckout))

        if (checkins0.length && checkouts0.length) {
          const all = [...checkins0, ...checkouts0]
          const ids = all.map((x) => String(x.entity_id))
          const assignee = all.every((x) => String(x.assignee_id || '') === String(all[0].assignee_id || '')) ? all[0].assignee_id : null
          const sched = all.every((x) => String(x.scheduled_at || '') === String(all[0].scheduled_at || '')) ? all[0].scheduled_at : null
          const status = mergedStatus(all.map((x) => String(x.status || 'pending')))
          const autoSync = all.every((x) => x.auto_sync_enabled !== false)
          const checkout = checkouts0[0]
          const checkin = checkins0[0]
          mergedCleaning.push({
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
            scheduled_at: sched,
            auto_sync_enabled: autoSync,
            nights: all.find((x) => x.nights != null)?.nights ?? null,
            summary_checkout_time: all[0].summary_checkout_time || null,
            summary_checkin_time: all[0].summary_checkin_time || null,
            checkout_order_id: checkout?.order_id ? String(checkout.order_id) : null,
            checkin_order_id: checkin?.order_id ? String(checkin.order_id) : null,
            checkout_order_code: checkout?.order_code ? String(checkout.order_code) : null,
            checkin_order_code: checkin?.order_code ? String(checkin.order_code) : null,
            checkout_old_code: checkout?.old_code != null ? String(checkout.old_code || '') : null,
            checkout_new_code: checkout?.new_code != null ? String(checkout.new_code || '') : null,
            checkin_old_code: checkin?.old_code != null ? String(checkin.old_code || '') : null,
            checkin_new_code: checkin?.new_code != null ? String(checkin.new_code || '') : null,
          })
          const rest = list.filter((x) => !isCheckin(x) && !isCheckout(x))
          mergedCleaning.push(...rest)
        } else if (checkins0.length > 1) {
          const ids = checkins0.map((x) => String(x.entity_id))
          const status = mergedStatus(checkins0.map((x) => String(x.status || 'pending')))
          const autoSync = checkins0.every((x) => x.auto_sync_enabled !== false)
          const assignee = checkins0.every((x) => String(x.assignee_id || '') === String(checkins0[0].assignee_id || '')) ? checkins0[0].assignee_id : null
          const sched = checkins0.every((x) => String(x.scheduled_at || '') === String(checkins0[0].scheduled_at || '')) ? checkins0[0].scheduled_at : null
          mergedCleaning.push({
            source: 'cleaning_tasks',
            entity_id: ids.join(','),
            entity_ids: ids,
            order_id: null,
            order_code: null,
            property_id: checkins0[0].property_id,
            property_code: checkins0[0].property_code || null,
            task_type: 'checkin_clean',
            label: `入住 x${checkins0.length}`,
            task_date: String(checkins0[0].task_date || '').slice(0, 10),
            status,
            assignee_id: assignee,
            scheduled_at: sched,
            auto_sync_enabled: autoSync,
            checkin_order_id: null,
            checkout_order_id: null,
            checkin_order_code: checkins0.map((x) => String(x.order_code || x.order_id || '')).filter(Boolean).join(','),
            checkout_order_code: null,
            checkin_old_code: checkins0.map((x) => String(x.old_code || '')).filter(Boolean).join(','),
            checkin_new_code: checkins0.map((x) => String(x.new_code || '')).filter(Boolean).join(','),
            checkout_old_code: null,
            checkout_new_code: null,
          })
          const rest = list.filter((x) => !isCheckin(x) && !isCheckout(x))
          mergedCleaning.push(...rest)
        } else if (checkouts0.length > 1) {
          const ids = checkouts0.map((x) => String(x.entity_id))
          const status = mergedStatus(checkouts0.map((x) => String(x.status || 'pending')))
          const autoSync = checkouts0.every((x) => x.auto_sync_enabled !== false)
          const assignee = checkouts0.every((x) => String(x.assignee_id || '') === String(checkouts0[0].assignee_id || '')) ? checkouts0[0].assignee_id : null
          const sched = checkouts0.every((x) => String(x.scheduled_at || '') === String(checkouts0[0].scheduled_at || '')) ? checkouts0[0].scheduled_at : null
          mergedCleaning.push({
            source: 'cleaning_tasks',
            entity_id: ids.join(','),
            entity_ids: ids,
            order_id: null,
            order_code: null,
            property_id: checkouts0[0].property_id,
            property_code: checkouts0[0].property_code || null,
            task_type: 'checkout_clean',
            label: `退房 x${checkouts0.length}`,
            task_date: String(checkouts0[0].task_date || '').slice(0, 10),
            status,
            assignee_id: assignee,
            scheduled_at: sched,
            auto_sync_enabled: autoSync,
            checkout_order_id: null,
            checkin_order_id: null,
            checkout_order_code: checkouts0.map((x) => String(x.order_code || x.order_id || '')).filter(Boolean).join(','),
            checkin_order_code: null,
            checkout_old_code: checkouts0.map((x) => String(x.old_code || '')).filter(Boolean).join(','),
            checkout_new_code: checkouts0.map((x) => String(x.new_code || '')).filter(Boolean).join(','),
            checkin_old_code: null,
            checkin_new_code: null,
          })
          const rest = list.filter((x) => !isCheckin(x) && !isCheckout(x))
          mergedCleaning.push(...rest)
        } else {
          mergedCleaning.push(...list)
        }
      }
      const next = [...mergedCleaning, ...other]
      next.sort((a, b) => (a.source || '').localeCompare(b.source || '') || String(a.property_id || '').localeCompare(String(b.property_id || '')) || String(a.label || '').localeCompare(String(b.label || '')))
      m.set(k, next)
    }
    for (const [k, arr] of m.entries()) {
      arr.sort((a, b) => (a.source || '').localeCompare(b.source || '') || String(a.property_id || '').localeCompare(String(b.property_id || '')) || String(a.label || '').localeCompare(String(b.label || '')))
      m.set(k, arr)
    }
    return m
  }, [items, mergedStatus])

  const selectedList = useMemo(() => {
    const base = itemsByDate.get(selectedDateStr) || []
    const q = filterRoom.trim().toLowerCase()
    return base.filter((it) => {
      if (filterStatus && String(it.status || '') !== filterStatus) return false
      if (!q) return true
      const label = propertyLabelForItem(it).toLowerCase()
      return label.includes(q)
    })
  }, [filterRoom, filterStatus, itemsByDate, propertyLabelForItem, selectedDateStr])

  const loadStaff = useCallback(async () => {
    const s = await getJSON<Staff[]>('/cleaning/staff').catch(() => [])
    setStaff(Array.isArray(s) ? s : [])
  }, [])

  const loadProps = useCallback(async () => {
    const p = await getJSON<any>('/properties?include_archived=true').catch(() => [])
    setProperties(Array.isArray(p) ? p : [])
  }, [])

  const loadRangeItems = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const from = visibleRange.start.format('YYYY-MM-DD')
      const to = visibleRange.end.format('YYYY-MM-DD')
      const rows = await getJSON<CalendarItem[]>(`/cleaning/calendar-range?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
      setItems(Array.isArray(rows) ? rows : [])
      setTasksMinMaxError(null)
      const today = dayjs().format('YYYY-MM-DD')
      getJSON<any>(`/cleaning/tasks/minmax?from=${encodeURIComponent(today)}`)
        .then((mm) => {
          if (mm && mm.ok) setTasksMinMax({ min: mm.min || null, max: mm.max || null, from: mm.from || today })
          else setTasksMinMax(null)
        })
        .catch((e: any) => {
          setTasksMinMax(null)
          setTasksMinMaxError(String(e?.message || 'minmax_failed'))
        })
    } catch (e: any) {
      setError(e?.message || '加载失败')
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [visibleRange.end, visibleRange.start])

  useEffect(() => {
    loadStaff().catch(() => {})
    loadProps().catch(() => {})
    getJSON<any>('/health/db').then(setDbStatus).catch(() => setDbStatus(null))
  }, [loadProps, loadStaff])

  useEffect(() => {
    loadRangeItems().catch(() => {})
  }, [loadRangeItems])

  const openEdit = useCallback(async (it: CalendarItem) => {
    if (it.source !== 'cleaning_tasks') return
    const date = String(it.task_date || '').slice(0, 10)
    const rows = await getJSON<CleaningTaskRow[]>(`/cleaning/tasks?date=${encodeURIComponent(date)}`).catch(() => [])
    const ids = entityIds(it)
    const selectedRows = ids.map((id) => (Array.isArray(rows) ? rows : []).find((r) => String(r.id) === String(id)) || null)
    const baseRow = selectedRows[0]
    const note = ids.length === 1 ? (baseRow?.note != null ? String(baseRow.note || '') : '') : ''
    const scheduledAt0 = baseRow?.scheduled_at ? dayjs(String(baseRow.scheduled_at)) : (it.scheduled_at ? dayjs(String(it.scheduled_at)) : null)
    const scheduledAt = scheduledAt0 && scheduledAt0.isValid() ? scheduledAt0 : null
    const status = ids.length === 1 ? String(baseRow?.status || it.status || 'pending') : mergedStatus(selectedRows.map((r) => String(r?.status || it.status || 'pending')))
    const assigneeId =
      ids.length === 1
        ? (baseRow?.assignee_id ? String(baseRow.assignee_id) : (it.assignee_id ? String(it.assignee_id) : null))
        : (selectedRows.every((r) => String(r?.assignee_id || '') === String(selectedRows[0]?.assignee_id || '')) ? (selectedRows[0]?.assignee_id ? String(selectedRows[0]?.assignee_id) : null) : null)
    const autoSync = selectedRows.every((r) => (r?.auto_sync_enabled !== false)) && it.auto_sync_enabled !== false
    setEditForm({
      ids,
      task_date: dayjs(date),
      status,
      assignee_id: assigneeId,
      scheduled_at: scheduledAt,
      note,
      auto_sync_enabled: autoSync,
    })
    setEditOpen(true)
  }, [entityIds, mergedStatus])

  const submitEdit = useCallback(async () => {
    if (!editForm) return
    const payload: any = {
      task_date: editForm.task_date.format('YYYY-MM-DD'),
      status: editForm.status,
      assignee_id: editForm.assignee_id,
      scheduled_at: editForm.scheduled_at ? editForm.scheduled_at.toISOString() : null,
      note: editForm.note || null,
    }
    await Promise.all(editForm.ids.map((id) => patchJSON(`/cleaning/tasks/${encodeURIComponent(id)}`, payload)))
    setEditOpen(false)
    setEditForm(null)
    message.success('已更新')
    loadRangeItems().catch(() => {})
  }, [editForm, loadRangeItems])

  const restoreAutoSync = useCallback(async (it: CalendarItem) => {
    if (it.source !== 'cleaning_tasks') return
    const ids = entityIds(it)
    await Promise.all(ids.map((id) => postJSON(`/cleaning/tasks/${encodeURIComponent(id)}/restore-auto-sync`, {})))
    message.success('已恢复自动同步')
    loadRangeItems().catch(() => {})
  }, [entityIds, loadRangeItems])

  const submitBackfill = useCallback(async () => {
    const from = backfillFrom.format('YYYY-MM-DD')
    const to = backfillTo.format('YYYY-MM-DD')
    setBackfillLoading(true)
    try {
      const r = await postJSON<any>(`/cleaning/backfill?date_from=${encodeURIComponent(from)}&date_to=${encodeURIComponent(to)}`, {})
      const created = Number(r?.created || 0)
      const updated = Number(r?.updated || 0)
      const cancelled = Number(r?.cancelled || 0)
      const skippedLocked = Number(r?.skipped_locked || 0)
      const failed = Number(r?.failed || 0)
      const tasksAfter = r?.tasks_after
      message.success(`Backfill 完成：created=${created} updated=${updated} cancelled=${cancelled} skipped_locked=${skippedLocked} failed=${failed} tasks_after=${tasksAfter ?? '-'}`)
      setBackfillOpen(false)
      loadRangeItems().catch(() => {})
    } catch (e: any) {
      message.error(e?.message || 'Backfill 失败')
    } finally {
      setBackfillLoading(false)
    }
  }, [backfillFrom, backfillTo, loadRangeItems])

  const openDebug = useCallback(async () => {
    setDebugOpen(true)
    setDebugLoading(true)
    try {
      const s = await getJSON<any>('/cleaning/debug/state')
      setDebugState(s)
    } catch (e: any) {
      setDebugState({ error: String(e?.message || 'debug_failed') })
    } finally {
      setDebugLoading(false)
    }
  }, [])

  const itemKind = useCallback((it: CalendarItem) => cleaningColorKind(it as any), [])

  const staffNameById = useCallback((id: string | null) => {
    if (!id) return '-'
    return staff.find((s) => String(s.id) === String(id))?.name || String(id)
  }, [staff])

  const updateTaskQuick = useCallback(async (ids: string[], patch: any) => {
    await Promise.all(ids.map((id) => patchJSON(`/cleaning/tasks/${encodeURIComponent(id)}`, patch)))
    loadRangeItems().catch(() => {})
  }, [loadRangeItems])

  const goPrev = useCallback(() => {
    if (view === 'month') setMonth((m) => m.subtract(1, 'month'))
    else if (view === 'week') setSelectedDate((d) => d.subtract(1, 'week'))
    else setSelectedDate((d) => d.subtract(1, 'day'))
  }, [view])

  const goNext = useCallback(() => {
    if (view === 'month') setMonth((m) => m.add(1, 'month'))
    else if (view === 'week') setSelectedDate((d) => d.add(1, 'week'))
    else setSelectedDate((d) => d.add(1, 'day'))
  }, [view])

  return (
    <div className={styles.page}>
      <div className={styles.container}>
        {error ? <Alert type="error" showIcon message="清洁日历数据加载失败" description={error} /> : null}
        {dbStatus && dbStatus.pg === false ? <Alert type="warning" showIcon message="后端未连接数据库" description={String(dbStatus.pg_error || 'pg=false')} /> : null}

        <div className={`${styles.card} ${styles.headerCard}`}>
          <div className={styles.navGroup}>
            <Button className={styles.navBtn} icon={<LeftOutlined />} onClick={goPrev} />
            <div className={styles.monthTitle}>{monthLabel}</div>
            <Button className={styles.navBtn} icon={<RightOutlined />} onClick={goNext} />
            <Button className={styles.todayBtn} onClick={() => { setSelectedDate(dayjs()); setMonth(dayjs()); }}>
              今天
            </Button>
          </div>
          <div className={styles.rightGroup}>
            <Segmented
              className={styles.viewSegment}
              options={[
                { label: '日', value: 'day' },
                { label: '周', value: 'week' },
                { label: '月', value: 'month' },
              ]}
              value={view}
              onChange={(v) => setView(v as any)}
            />
            <Button className={styles.secondaryBtn} icon={<ReloadOutlined />} onClick={() => loadRangeItems().catch(() => {})} loading={loading}>
              刷新
            </Button>
            <Button className={styles.primaryBtn} onClick={() => setBackfillOpen(true)}>
              Backfill
            </Button>
            <Button className={styles.secondaryBtn} onClick={() => openDebug().catch(() => {})} loading={debugLoading}>
              调试
            </Button>
          </div>
        </div>

        {API_BASE ? <Alert type="info" showIcon message={`API_BASE=${API_BASE}`} /> : <Alert type="warning" showIcon message="NEXT_PUBLIC_API_BASE_URL 未设置" />}
        {tasksMinMaxError ? <Alert type="warning" showIcon message="任务范围查询失败" description={tasksMinMaxError} /> : null}
        {tasksMinMax?.min || tasksMinMax?.max ? <Alert type="info" showIcon message={`任务范围：${tasksMinMax.min || '-'} ～ ${tasksMinMax.max || '-'}`} /> : null}

        <div className={`${styles.card} ${styles.calendarCard}`}>
          <div className={styles.weekHeader}>
            {['日', '一', '二', '三', '四', '五', '六'].map((w) => <div key={w}>{w}</div>)}
          </div>
          <div className={styles.grid} aria-label="清洁日历">
            {days.map((d) => {
              const dateStr = d.format('YYYY-MM-DD')
              const inMonth = view !== 'month' ? true : d.month() === month.month()
              const isSelected = dateStr === selectedDateStr
              const arr = itemsByDate.get(dateStr) || []
              return (
                <div
                  key={dateStr}
                  className={`${styles.cell} ${inMonth ? '' : styles.cellMuted} ${isSelected ? styles.cellActive : ''}`}
                  onClick={() => {
                    setSelectedDate(d)
                    if (view === 'month' && d.month() !== month.month()) setMonth(d.startOf('month'))
                  }}
                  role="button"
                  tabIndex={0}
                >
                  <div className={styles.dayNum}>{d.date()}</div>
                  <div className={styles.pills}>
                    {arr.slice(0, 3).map((it) => {
                      const k = itemKind(it)
                      const pillCls =
                        k === 'unassigned'
                          ? styles.pillUnassigned
                          : k === 'checkin'
                            ? styles.pillCheckin
                            : k === 'combined'
                              ? styles.pillCombined
                              : styles.pillCheckout
                      const room = propertyLabelForItem(it) || '-'
                      const title = `${room} ${it.label}`.trim()
                      return (
                        <div key={`${it.source}:${it.entity_id}`} className={`${styles.pill} ${pillCls}`} title={title}>
                          {title}
                        </div>
                      )
                    })}
                    {arr.length > 3 ? (
                      <div className={`${styles.pill} ${styles.pillCombined}`}>+{arr.length - 3}</div>
                    ) : null}
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        <div className={styles.card}>
          <div className={styles.detailsHead}>
            <div>
              <div className={styles.detailsTitle}>当日任务</div>
              <div className={styles.detailsDate}>{selectedDateStr}</div>
            </div>
            <div className={styles.filters}>
              <Input
                value={filterRoom}
                onChange={(e) => setFilterRoom(e.target.value)}
                placeholder="筛选房源（code/id）"
                style={{ width: 220 }}
                allowClear
              />
              <Select
                value={filterStatus}
                onChange={(v) => setFilterStatus(v)}
                placeholder="筛选状态"
                allowClear
                style={{ width: 180 }}
                options={[
                  { label: 'pending', value: 'pending' },
                  { label: 'assigned', value: 'assigned' },
                  { label: 'in_progress', value: 'in_progress' },
                  { label: 'completed', value: 'completed' },
                  { label: 'cancelled', value: 'cancelled' },
                  { label: 'todo（线下）', value: 'todo' },
                  { label: 'done（线下）', value: 'done' },
                ]}
              />
            </div>
          </div>

          <div className={styles.missionList}>
            {loading ? (
              <>
                <div className={styles.missionCard}><Skeleton active paragraph={{ rows: 2 }} /></div>
                <div className={styles.missionCard}><Skeleton active paragraph={{ rows: 2 }} /></div>
              </>
            ) : selectedList.length ? selectedList.map((it) => {
              const kind = itemKind(it)
              const room = propertyLabelForItem(it) || '-'
              const sum = summaryText(it)
              const timeStr = formatTaskTime(it.scheduled_at)
              const accentCls =
                kind === 'unassigned' ? styles.accentUnassigned : kind === 'checkout' ? styles.accentCheckout : kind === 'combined' ? styles.accentCombined : ''
              const nameCls =
                kind === 'unassigned' ? styles.missionNameUnassigned : kind === 'checkout' ? styles.missionNameCheckout : kind === 'combined' ? styles.missionNameCombined : styles.missionNameCheckin
              const isMerged = Array.isArray(it.entity_ids) && it.entity_ids.length > 1
              const orderDisplay = (id: string | null | undefined, code: string | null | undefined) => {
                const v = String(code || id || '').trim()
                return v ? v : '-'
              }
              const showPwd = (label: string, oldCode?: string | null, newCode?: string | null) => {
                const o = String(oldCode || '').trim()
                const n = String(newCode || '').trim()
                if (!o && !n) return null
                return (
                  <>
                    {o ? <div className={styles.infoItem}>{label}旧:{o}</div> : null}
                    {n ? <div className={styles.infoItem}>{label}新:{n}</div> : null}
                  </>
                )
              }
              return (
                <div key={`${it.source}:${it.entity_id}`} className={styles.missionCard}>
                  <div className={`${styles.accent} ${accentCls}`} />
                  <div className={styles.missionTop}>
                    <div className={styles.summaryRow}>
                      <div className={styles.summaryDot} />
                      <div className={styles.summaryTitle}>
                        {sum.region ? <span className={styles.summaryRegion}>{sum.region}</span> : null}
                        <span className={styles.summaryCode}>{sum.code || room}</span>
                        {sum.detail ? <span className={styles.summaryDetail}>{sum.detail}</span> : null}
                      </div>
                    </div>
                    {it.source === 'cleaning_tasks' ? (
                      <div className={styles.taskActions}>
                        <Button className={`${styles.taskBtn} ${styles.taskBtnGhost}`} size="small" icon={<EditOutlined />} onClick={() => openEdit(it).catch((e) => message.error(e?.message || '打开失败'))}>
                          编辑
                        </Button>
                        {isTaskLocked(it.auto_sync_enabled) ? (
                          <Button className={`${styles.taskBtn} ${styles.taskBtnSubtle}`} size="small" onClick={() => restoreAutoSync(it).catch((e) => message.error(e?.message || '恢复失败'))}>
                            恢复自动同步
                          </Button>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                  <div className={styles.missionBody}>
                    <div className={styles.infoPills}>
                      {it.nights != null ? <div className={`${styles.infoItem} ${styles.codeBox}`}>{`${it.nights}晚`}</div> : null}
                      <div className={`${styles.infoItem} ${styles.codeBox}`}>{it.label}</div>
                      <div className={styles.infoItem}>{it.status}</div>
                      <div className={styles.infoItem}>{it.source}</div>
                      {timeStr ? <div className={styles.infoItem}>{timeStr}</div> : null}
                      {isTaskLocked(it.auto_sync_enabled) ? <div className={`${styles.infoItem} ${styles.codeBoxOrange}`}>已锁定</div> : null}
                      {isMerged ? (
                        <>
                          <div className={styles.infoItem}>退房单:{orderDisplay(it.checkout_order_id, it.checkout_order_code)}</div>
                          <div className={styles.infoItem}>入住单:{orderDisplay(it.checkin_order_id, it.checkin_order_code)}</div>
                          {showPwd('退房', it.checkout_old_code, it.checkout_new_code)}
                          {showPwd('入住', it.checkin_old_code, it.checkin_new_code)}
                        </>
                      ) : (
                        <>
                          {it.order_id || it.order_code ? <div className={styles.infoItem}>订单:{orderDisplay(it.order_id, it.order_code)}</div> : null}
                          {showPwd('', it.old_code, it.new_code)}
                        </>
                      )}
                    </div>
                    <div className={styles.assignees}>
                      {it.source === 'cleaning_tasks' ? (
                        <div className={styles.assigneeGroup}>
                          <div className={styles.assigneeLabel}>执行人</div>
                          <Select
                            className={styles.assigneeSelect}
                            allowClear
                            value={it.assignee_id || undefined}
                            options={staff.map((s) => ({ value: s.id, label: s.name }))}
                            onChange={(v) => updateTaskQuick(entityIds(it), { assignee_id: v ? String(v) : null }).catch((e) => message.error(e?.message || '更新失败'))}
                            placeholder={staffNameById(it.assignee_id)}
                          />
                        </div>
                      ) : null}
                      {it.source === 'cleaning_tasks' ? (
                        <div className={styles.assigneeGroup}>
                          <div className={styles.assigneeLabel}>状态</div>
                          <Select
                            className={styles.assigneeSelect}
                            value={String(it.status || 'pending')}
                            options={[
                              { label: 'pending', value: 'pending' },
                              { label: 'assigned', value: 'assigned' },
                              { label: 'in_progress', value: 'in_progress' },
                              { label: 'completed', value: 'completed' },
                              { label: 'cancelled', value: 'cancelled' },
                            ]}
                            onChange={(v) => updateTaskQuick(entityIds(it), { status: v }).catch((e) => message.error(e?.message || '更新失败'))}
                          />
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
              )
            }) : (
              <div className={styles.missionCard}>
                <Empty description="当日无任务" />
              </div>
            )}
          </div>
        </div>
      </div>

      <Modal
        open={editOpen}
        title="编辑清洁任务"
        okText="保存"
        onOk={() => submitEdit().catch((e) => message.error(e?.message || '保存失败'))}
        onCancel={() => { setEditOpen(false); setEditForm(null) }}
      >
        {editForm ? (
          <Space direction="vertical" style={{ width: '100%' }}>
            <div>
              <div className={styles.fieldLabel}>清洁日期</div>
              <DatePicker value={editForm.task_date} onChange={(v) => v && setEditForm((p) => (p ? { ...p, task_date: v } : p))} style={{ width: '100%' }} />
            </div>
            <div>
              <div className={styles.fieldLabel}>状态</div>
              <Select
                value={editForm.status}
                onChange={(v) => setEditForm((p) => (p ? { ...p, status: v } : p))}
                style={{ width: '100%' }}
                options={[
                  { label: 'pending', value: 'pending' },
                  { label: 'assigned', value: 'assigned' },
                  { label: 'in_progress', value: 'in_progress' },
                  { label: 'completed', value: 'completed' },
                  { label: 'cancelled', value: 'cancelled' },
                ]}
              />
            </div>
            <div>
              <div className={styles.fieldLabel}>分配人员</div>
              <Select
                allowClear
                value={editForm.assignee_id || undefined}
                onChange={(v) => setEditForm((p) => (p ? { ...p, assignee_id: v ? String(v) : null } : p))}
                style={{ width: '100%' }}
                options={staff.map((s) => ({ value: s.id, label: s.name }))}
              />
            </div>
            <div>
              <div className={styles.fieldLabel}>时间</div>
              <DatePicker
                picker="time"
                value={editForm.scheduled_at}
                onChange={(v) => setEditForm((p) => (p ? { ...p, scheduled_at: v } : p))}
                style={{ width: '100%' }}
              />
            </div>
            <div>
              <div className={styles.fieldLabel}>备注</div>
              <Input.TextArea
                rows={4}
                value={editForm.note}
                onChange={(e) => setEditForm((p) => (p ? { ...p, note: e.target.value } : p))}
              />
            </div>
            {!editForm.auto_sync_enabled ? <Alert type="warning" showIcon message="该任务已锁定自动同步" /> : null}
          </Space>
        ) : null}
      </Modal>

      <Modal
        open={backfillOpen}
        title="Backfill 清洁任务"
        okText="执行"
        confirmLoading={backfillLoading}
        onOk={() => submitBackfill().catch(() => {})}
        onCancel={() => setBackfillOpen(false)}
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <div>
            <div className={styles.fieldLabel}>date_from</div>
            <DatePicker value={backfillFrom} onChange={(v) => v && setBackfillFrom(v)} style={{ width: '100%' }} />
          </div>
          <div>
            <div className={styles.fieldLabel}>date_to</div>
            <DatePicker value={backfillTo} onChange={(v) => v && setBackfillTo(v)} style={{ width: '100%' }} />
          </div>
        </Space>
      </Modal>

      <Modal
        open={debugOpen}
        title="清洁模块调试信息"
        footer={null}
        onCancel={() => setDebugOpen(false)}
        width={860}
      >
        <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0 }}>
          {JSON.stringify(debugState, null, 2)}
        </pre>
      </Modal>
    </div>
  )
}
