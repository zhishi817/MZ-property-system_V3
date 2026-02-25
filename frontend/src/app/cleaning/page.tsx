"use client"

import { Alert, Button, Checkbox, DatePicker, Empty, Input, InputNumber, Modal, Segmented, Select, Skeleton, Space, message } from 'antd'
import { DeleteOutlined, EditOutlined, LeftOutlined, ReloadOutlined, RightOutlined } from '@ant-design/icons'
import { useCallback, useEffect, useMemo, useState } from 'react'
import dayjs, { type Dayjs } from 'dayjs'
import { API_BASE, getJSON, patchJSON, postJSON } from '../../lib/api'
import { cleaningColorKind } from '../../lib/cleaningColor'
import { isTaskLocked } from '../../lib/cleaningTaskUi'
import styles from './cleaningSchedule.module.scss'

type Staff = { id: string; name: string; capacity_per_day: number; kind?: 'cleaner' | 'inspector'; is_active?: boolean; color_hex?: string | null }

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
  date?: string | null
  status?: string | null
  assignee_id?: string | null
  cleaner_id?: string | null
  inspector_id?: string | null
  scheduled_at?: string | null
  note?: string | null
  auto_sync_enabled?: boolean | null
  old_code?: string | null
  new_code?: string | null
  checkout_time?: string | null
  checkin_time?: string | null
  nights_override?: number | null
}

type EditTaskForm = {
  ids: string[]
  task_date: Dayjs
  property_id: string | null
  status: string
  cleaner_id: string | null
  inspector_id: string | null
  note: string
  nights_override: number | null
  checkout_ids: string[]
  checkin_ids: string[]
  checkout_password: string
  checkin_password: string
  checkout_time: string
  checkin_time: string
  checkin_task_date: Dayjs
  can_add_checkout: boolean
  can_add_checkin: boolean
  pending_add_checkout: boolean
  pending_add_checkin: boolean
  auto_sync_enabled: boolean
}

type BulkEditForm = {
  ids: string[]
  status: string
  cleaner: string
  inspector: string
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
  const [filterCleaner, setFilterCleaner] = useState<string | undefined>(undefined)
  const [filterInspector, setFilterInspector] = useState<string | undefined>(undefined)
  const [bulkMode, setBulkMode] = useState(false)
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>([])
  const [properties, setProperties] = useState<{ id: string; code?: string; address?: string }[]>([])
  const [dbStatus, setDbStatus] = useState<any>(null)
  const [tasksMinMax, setTasksMinMax] = useState<{ min: string | null; max: string | null; from: string } | null>(null)
  const [tasksMinMaxError, setTasksMinMaxError] = useState<string | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  const [editForm, setEditForm] = useState<EditTaskForm | null>(null)
  const [bulkEditOpen, setBulkEditOpen] = useState(false)
  const [bulkEditForm, setBulkEditForm] = useState<BulkEditForm | null>(null)
  const [backfillOpen, setBackfillOpen] = useState(false)
  const [backfillFrom, setBackfillFrom] = useState<Dayjs>(() => dayjs().subtract(90, 'day'))
  const [backfillTo, setBackfillTo] = useState<Dayjs>(() => dayjs().add(365, 'day'))
  const [backfillLoading, setBackfillLoading] = useState(false)
  const [debugOpen, setDebugOpen] = useState(false)
  const [debugLoading, setDebugLoading] = useState(false)
  const [debugState, setDebugState] = useState<any>(null)
  const [showDevDebugInfo, setShowDevDebugInfo] = useState(false)

  useEffect(() => {
    try {
      setShowDevDebugInfo(process.env.NODE_ENV === 'development' && new URLSearchParams(window.location.search).get('debug') === 'true')
    } catch {
      setShowDevDebugInfo(false)
    }
  }, [])

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
    const checkoutT = String(it.summary_checkout_time || '').trim() || '10am'
    const checkinT = String(it.summary_checkin_time || '').trim() || '3pm'
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
          const cleanerKey = (x: CalendarItem) => String(x.cleaner_id || x.assignee_id || '').trim()
          const inspectorKey = (x: CalendarItem) => String(x.inspector_id || '').trim()
          const cleanerId = all.every((x) => cleanerKey(x) === cleanerKey(all[0])) ? (cleanerKey(all[0]) || null) : null
          const inspectorId = all.every((x) => inspectorKey(x) === inspectorKey(all[0])) ? (inspectorKey(all[0]) || null) : null
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
            cleaner_id: cleanerId,
            inspector_id: inspectorId,
            scheduled_at: sched,
            auto_sync_enabled: autoSync,
            nights: all.find((x) => x.nights != null)?.nights ?? null,
            summary_checkout_time: checkout?.summary_checkout_time || null,
            summary_checkin_time: checkin?.summary_checkin_time || null,
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
          const cleanerId = checkins0.every((x) => String(x.cleaner_id || x.assignee_id || '') === String(checkins0[0].cleaner_id || checkins0[0].assignee_id || '')) ? (String(checkins0[0].cleaner_id || checkins0[0].assignee_id || '').trim() || null) : null
          const inspectorId = checkins0.every((x) => String(x.inspector_id || '') === String(checkins0[0].inspector_id || '')) ? (String(checkins0[0].inspector_id || '').trim() || null) : null
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
            cleaner_id: cleanerId,
            inspector_id: inspectorId,
            scheduled_at: sched,
            auto_sync_enabled: autoSync,
            summary_checkin_time: checkins0[0].summary_checkin_time || null,
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
          const cleanerId = checkouts0.every((x) => String(x.cleaner_id || x.assignee_id || '') === String(checkouts0[0].cleaner_id || checkouts0[0].assignee_id || '')) ? (String(checkouts0[0].cleaner_id || checkouts0[0].assignee_id || '').trim() || null) : null
          const inspectorId = checkouts0.every((x) => String(x.inspector_id || '') === String(checkouts0[0].inspector_id || '')) ? (String(checkouts0[0].inspector_id || '').trim() || null) : null
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
            cleaner_id: cleanerId,
            inspector_id: inspectorId,
            scheduled_at: sched,
            auto_sync_enabled: autoSync,
            summary_checkout_time: checkouts0[0].summary_checkout_time || null,
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
      const regionKey = (x: any) => {
        const r = String(x?.property_region || '').trim()
        return r ? r.toLowerCase() : '\uffff'
      }
      const codeKey = (x: any) => {
        const c = String(x?.property_code || '').trim()
        return c ? c.toLowerCase() : String(x?.property_id || '').trim().toLowerCase()
      }
      const next = [...mergedCleaning, ...other]
      next.sort((a, b) =>
        regionKey(a).localeCompare(regionKey(b)) ||
        codeKey(a).localeCompare(codeKey(b)) ||
        String(a.label || '').localeCompare(String(b.label || '')) ||
        String(a.source || '').localeCompare(String(b.source || '')) ||
        String(a.entity_id || '').localeCompare(String(b.entity_id || ''))
      )
      m.set(k, next)
    }
    for (const [k, arr] of m.entries()) {
      const regionKey = (x: any) => {
        const r = String(x?.property_region || '').trim()
        return r ? r.toLowerCase() : '\uffff'
      }
      const codeKey = (x: any) => {
        const c = String(x?.property_code || '').trim()
        return c ? c.toLowerCase() : String(x?.property_id || '').trim().toLowerCase()
      }
      arr.sort((a, b) =>
        regionKey(a).localeCompare(regionKey(b)) ||
        codeKey(a).localeCompare(codeKey(b)) ||
        String(a.label || '').localeCompare(String(b.label || '')) ||
        String(a.source || '').localeCompare(String(b.source || '')) ||
        String(a.entity_id || '').localeCompare(String(b.entity_id || ''))
      )
      m.set(k, arr)
    }
    return m
  }, [items, mergedStatus])

  const selectedList = useMemo(() => {
    const base = itemsByDate.get(selectedDateStr) || []
    const q = filterRoom.trim().toLowerCase()
    return base.filter((it) => {
      if (filterStatus && String(it.status || '') !== filterStatus) return false
      if (filterCleaner) {
        const v = String(it.cleaner_id || it.assignee_id || '').trim()
        if (!v || v !== String(filterCleaner)) return false
      }
      if (filterInspector) {
        const v = String(it.inspector_id || '').trim()
        if (!v || v !== String(filterInspector)) return false
      }
      if (!q) return true
      const label = propertyLabelForItem(it).toLowerCase()
      return label.includes(q)
    })
  }, [filterCleaner, filterInspector, filterRoom, filterStatus, itemsByDate, propertyLabelForItem, selectedDateStr])

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
    const clickedIds = entityIds(it)
    const clickedRow = (Array.isArray(rows) ? rows : []).find((r) => String(r.id) === String(clickedIds[0])) || null
    const propertyId = it.property_id ? String(it.property_id) : (clickedRow?.property_id ? String(clickedRow.property_id) : null)
    const rowsForProp = (Array.isArray(rows) ? rows : []).filter((r) => String(r?.property_id || '') && propertyId && String(r.property_id) === String(propertyId))
    const isCheckoutRow = (r: CleaningTaskRow | null) => String(r?.task_type || '').toLowerCase() === 'checkout_clean'
    const isCheckinRow = (r: CleaningTaskRow | null) => String(r?.task_type || '').toLowerCase() === 'checkin_clean'
    const notCancelled = (r: CleaningTaskRow) => String(r?.status || '').toLowerCase() !== 'cancelled'
    const checkoutIdsAll = rowsForProp.filter((r) => notCancelled(r) && isCheckoutRow(r as any)).map((r) => String(r.id))
    const checkinIdsAll = rowsForProp.filter((r) => notCancelled(r) && isCheckinRow(r as any)).map((r) => String(r.id))
    const ids = Array.from(new Set([...clickedIds, ...checkoutIdsAll, ...checkinIdsAll]))
    const selectedRows = ids.map((id) => (Array.isArray(rows) ? rows : []).find((r) => String(r.id) === String(id)) || null)
    const baseRow = selectedRows.find((r) => r && String(r.id) === String(clickedIds[0])) || selectedRows[0]
    const checkoutAllExists = checkoutIdsAll.length > 0
    const checkinAllExists = checkinIdsAll.length > 0
    const note = ids.length === 1 ? (baseRow?.note != null ? String(baseRow.note || '') : '') : ''
    const status = ids.length === 1 ? String(baseRow?.status || it.status || 'pending') : mergedStatus(selectedRows.map((r) => String(r?.status || it.status || 'pending')))
    const getCleaner = (r: CleaningTaskRow | null) => String(r?.cleaner_id || r?.assignee_id || '').trim()
    const getInspector = (r: CleaningTaskRow | null) => String(r?.inspector_id || '').trim()
    const cleanerId =
      ids.length === 1
        ? (getCleaner(baseRow) ? getCleaner(baseRow) : (String(it.cleaner_id || it.assignee_id || '').trim() || null))
        : (selectedRows.every((r) => getCleaner(r) === getCleaner(selectedRows[0])) ? (getCleaner(selectedRows[0]) || null) : null)
    const inspectorId =
      ids.length === 1
        ? (getInspector(baseRow) ? getInspector(baseRow) : (String(it.inspector_id || '').trim() || null))
        : (selectedRows.every((r) => getInspector(r) === getInspector(selectedRows[0])) ? (getInspector(selectedRows[0]) || null) : null)
    const checkoutRows = selectedRows.filter(isCheckoutRow)
    const checkinRows = selectedRows.filter(isCheckinRow)
    const nightsAllSame = checkinRows.length > 0 && checkinRows.every((r) => String(r?.nights_override ?? '') === String(checkinRows[0]?.nights_override ?? ''))
    const nightsOverride =
      checkinRows.length === 1
        ? (checkinRows[0]?.nights_override != null ? Number(checkinRows[0]?.nights_override) : null)
        : (nightsAllSame ? (checkinRows[0]?.nights_override != null ? Number(checkinRows[0]?.nights_override) : null) : null)
    const checkoutKey = (r: CleaningTaskRow | null) => String(r?.old_code ?? '').trim()
    const checkinKey = (r: CleaningTaskRow | null) => String(r?.new_code ?? '').trim()
    const checkoutPwd = checkoutRows.length > 0 && checkoutRows.every((r) => checkoutKey(r) === checkoutKey(checkoutRows[0])) ? (checkoutKey(checkoutRows[0]) || '') : ''
    const checkinPwd = checkinRows.length > 0 && checkinRows.every((r) => checkinKey(r) === checkinKey(checkinRows[0])) ? (checkinKey(checkinRows[0]) || '') : ''
    const checkoutTimeKey = (r: CleaningTaskRow | null) => String(r?.checkout_time ?? '').trim()
    const checkinTimeKey = (r: CleaningTaskRow | null) => String(r?.checkin_time ?? '').trim()
    const checkoutTime = checkoutRows.length > 0 && checkoutRows.every((r) => checkoutTimeKey(r) === checkoutTimeKey(checkoutRows[0])) ? (checkoutTimeKey(checkoutRows[0]) || '10am') : '10am'
    const checkinTime = checkinRows.length > 0 && checkinRows.every((r) => checkinTimeKey(r) === checkinTimeKey(checkinRows[0])) ? (checkinTimeKey(checkinRows[0]) || '3pm') : '3pm'
    const checkinTaskDateKey = (r: CleaningTaskRow | null) => String(r?.task_date || r?.date || '').slice(0, 10)
    const checkinTaskDate =
      checkinRows.length > 0 && checkinRows.every((r) => checkinTaskDateKey(r) === checkinTaskDateKey(checkinRows[0]))
        ? dayjs(checkinTaskDateKey(checkinRows[0]) || date)
        : dayjs(date)
    const autoSync = selectedRows.every((r) => (r?.auto_sync_enabled !== false)) && it.auto_sync_enabled !== false
    setEditForm({
      ids,
      task_date: dayjs(date),
      property_id: propertyId,
      status,
      cleaner_id: cleanerId,
      inspector_id: inspectorId,
      note,
      nights_override: nightsOverride,
      checkout_ids: checkoutIdsAll,
      checkin_ids: checkinIdsAll,
      checkout_password: checkoutPwd,
      checkin_password: checkinPwd,
      checkout_time: checkoutTime,
      checkin_time: checkinTime,
      checkin_task_date: checkinTaskDate,
      can_add_checkout: !!propertyId && !checkoutAllExists,
      can_add_checkin: !!propertyId && !checkinAllExists,
      pending_add_checkout: false,
      pending_add_checkin: false,
      auto_sync_enabled: autoSync,
    })
    setEditOpen(true)
  }, [entityIds, mergedStatus])

  const submitEdit = useCallback(async () => {
    if (!editForm) return
    const toNull = (s: string) => (String(s || '').trim() ? String(s).trim() : null)
    const base: any = {
      task_date: editForm.task_date.format('YYYY-MM-DD'),
      status: editForm.status,
    }
    if (editForm.ids.length === 1 || editForm.cleaner_id !== null) base.cleaner_id = editForm.cleaner_id
    if (editForm.ids.length === 1 || editForm.inspector_id !== null) base.inspector_id = editForm.inspector_id
    if (editForm.ids.length === 1) base.note = editForm.note || null
    else if (String(editForm.note || '').trim()) base.note = editForm.note

    if (editForm.pending_add_checkout && editForm.property_id) {
      await postJSON('/cleaning/tasks', {
        task_type: 'checkout_clean',
        task_date: editForm.task_date.format('YYYY-MM-DD'),
        property_id: editForm.property_id,
        status: editForm.status,
        cleaner_id: editForm.cleaner_id,
        inspector_id: editForm.inspector_id,
        old_code: toNull(editForm.checkout_password),
        checkout_time: toNull(editForm.checkout_time),
      })
    }
    if (editForm.pending_add_checkin && editForm.property_id) {
      await postJSON('/cleaning/tasks', {
        task_type: 'checkin_clean',
        task_date: editForm.checkin_task_date.format('YYYY-MM-DD'),
        property_id: editForm.property_id,
        status: editForm.status,
        cleaner_id: editForm.cleaner_id,
        inspector_id: editForm.inspector_id,
        new_code: toNull(editForm.checkin_password),
        nights_override: editForm.nights_override ?? null,
        checkin_time: toNull(editForm.checkin_time),
      })
    }

    const patches = editForm.ids.map((id) => {
      const p: any = { ...base }
      if (editForm.checkout_ids.some((x) => String(x) === String(id))) {
        p.old_code = toNull(editForm.checkout_password)
        p.checkout_time = toNull(editForm.checkout_time)
      }
      if (editForm.checkin_ids.some((x) => String(x) === String(id))) {
        p.task_date = editForm.checkin_task_date.format('YYYY-MM-DD')
        p.new_code = toNull(editForm.checkin_password)
        p.nights_override = editForm.nights_override ?? null
        p.checkin_time = toNull(editForm.checkin_time)
      }
      return patchJSON(`/cleaning/tasks/${encodeURIComponent(id)}`, p)
    })
    await Promise.all(patches)
    setEditOpen(false)
    setEditForm(null)
    message.success('已更新')
    loadRangeItems().catch(() => {})
  }, [editForm, loadRangeItems])

  const cancelTasksInEdit = useCallback(async (ids: string[], label: string) => {
    const uniq = Array.from(new Set(ids.map((x) => String(x)).filter(Boolean)))
    if (!uniq.length) return
    await postJSON('/cleaning/tasks/bulk-delete', { ids: uniq })
    message.success(`${label}已取消`)
    setEditOpen(false)
    setEditForm(null)
    loadRangeItems().catch(() => {})
  }, [loadRangeItems])

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

  const staffById = useMemo(() => {
    const m = new Map<string, Staff>()
    for (const s of staff) m.set(String(s.id), s)
    return m
  }, [staff])

  const normalizeHex = useCallback((hex: any): string | null => {
    const v = String(hex || '').trim()
    if (!/^#[0-9a-fA-F]{6}$/.test(v)) return null
    return v.toUpperCase()
  }, [])

  const isDarkBg = useCallback((hex: string) => {
    const h = hex.replace('#', '')
    const r = parseInt(h.slice(0, 2), 16) / 255
    const g = parseInt(h.slice(2, 4), 16) / 255
    const b = parseInt(h.slice(4, 6), 16) / 255
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
    return lum < 0.6
  }, [])

  const cleanerColorOf = useCallback((it: CalendarItem) => {
    const id = String(it.cleaner_id || it.assignee_id || '').trim()
    const hex = id ? normalizeHex(staffById.get(id)?.color_hex) : null
    return hex || '#CBD5E1'
  }, [normalizeHex, staffById])

  const cleanerOptions = useMemo(() => (
    staff
      .filter((s) => (s.kind || 'cleaner') === 'cleaner' && s.is_active !== false)
      .reduce((acc, s) => {
        const k = String(s.id)
        if (!acc.some((x) => String(x.value) === k)) acc.push({ value: s.id, label: s.name })
        return acc
      }, [] as { value: string; label: string }[])
  ), [staff])

  const inspectorOptions = useMemo(() => (
    staff
      .filter((s) => (s.kind || 'cleaner') === 'inspector' && s.is_active !== false)
      .reduce((acc, s) => {
        const k = String(s.id)
        if (!acc.some((x) => String(x.value) === k)) acc.push({ value: s.id, label: s.name })
        return acc
      }, [] as { value: string; label: string }[])
  ), [staff])

  const statusOptions = useMemo(() => ([
    { label: '待处理', value: 'pending' },
    { label: '已分配', value: 'assigned' },
    { label: '进行中', value: 'in_progress' },
    { label: '已完成', value: 'completed' },
    { label: '已取消', value: 'cancelled' },
  ]), [])

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

  const timeOptions = useMemo(() => {
    const out: { value: string; label: string }[] = []
    const startMin = 0
    const endMin = 23 * 60 + 30
    for (let m = startMin; m <= endMin; m += 30) {
      const hour24 = Math.floor(m / 60)
      const min = m % 60
      const isAm = hour24 < 12
      let hour12 = hour24 % 12
      if (hour12 === 0) hour12 = 12
      const label =
        min === 0
          ? `${hour12}${isAm ? 'am' : 'pm'}`
          : `${hour12}:${String(min).padStart(2, '0')}${isAm ? 'am' : 'pm'}`
      out.push({ value: label, label })
    }
    return out
  }, [])

  const updateTaskQuick = useCallback(async (ids: string[], patch: any) => {
    const normIds = Array.from(new Set(ids.map((x) => String(x)).filter(Boolean)))
    const idSet = new Set(normIds)
    const keyChanged =
      patch.task_date !== undefined ||
      patch.cleaner_id !== undefined ||
      patch.assignee_id !== undefined ||
      patch.scheduled_at !== undefined

    setItems((prev) => prev.map((it) => {
      if (it.source !== 'cleaning_tasks') return it
      if (!idSet.has(String(it.entity_id))) return it
      const next: any = { ...it }
      if (patch.status !== undefined) next.status = patch.status
      if (patch.task_date !== undefined) next.task_date = patch.task_date
      if (patch.scheduled_at !== undefined) next.scheduled_at = patch.scheduled_at
      if (patch.cleaner_id !== undefined) {
        next.cleaner_id = patch.cleaner_id
        if (patch.assignee_id === undefined) next.assignee_id = patch.cleaner_id
      }
      if (patch.assignee_id !== undefined) {
        next.assignee_id = patch.assignee_id
        if (patch.cleaner_id === undefined) next.cleaner_id = patch.assignee_id
      }
      if (patch.inspector_id !== undefined) next.inspector_id = patch.inspector_id
      if (keyChanged) next.auto_sync_enabled = false
      return next
    }))

    try {
      await postJSON('/cleaning/tasks/bulk-patch', { ids: normIds, patch })
    } catch (e) {
      loadRangeItems().catch(() => {})
      throw e
    }
  }, [loadRangeItems])

  const selectedSet = useMemo(() => new Set(selectedTaskIds.map((x) => String(x))), [selectedTaskIds])

  useEffect(() => {
    setSelectedTaskIds([])
    setBulkMode(false)
    setBulkEditOpen(false)
    setBulkEditForm(null)
  }, [selectedDateStr])

  const toggleSelectItem = useCallback((it: CalendarItem, checked: boolean) => {
    const ids = entityIds(it)
    setSelectedTaskIds((prev) => {
      const set = new Set(prev.map((x) => String(x)))
      for (const id of ids) {
        if (checked) set.add(String(id))
        else set.delete(String(id))
      }
      return Array.from(set)
    })
  }, [entityIds])

  const deleteTasks = useCallback(async (ids: string[]) => {
    const uniq = Array.from(new Set(ids.map((x) => String(x)).filter(Boolean)))
    if (!uniq.length) return
    await postJSON('/cleaning/tasks/bulk-delete', { ids: uniq })
    message.success('已删除')
    setSelectedTaskIds([])
    loadRangeItems().catch(() => {})
  }, [loadRangeItems])

  const openBulkEdit = useCallback(() => {
    const ids = Array.from(new Set(selectedTaskIds.map((x) => String(x)).filter(Boolean)))
    if (!ids.length) {
      message.warning('请先选择任务')
      return
    }
    setBulkEditForm({ ids, status: '__keep__', cleaner: '__keep__', inspector: '__keep__' })
    setBulkEditOpen(true)
  }, [selectedTaskIds])

  const submitBulkEdit = useCallback(async () => {
    if (!bulkEditForm) return
    const patch: any = {}
    if (bulkEditForm.status !== '__keep__') patch.status = bulkEditForm.status
    if (bulkEditForm.cleaner === '__clear__') patch.cleaner_id = null
    else if (bulkEditForm.cleaner !== '__keep__') patch.cleaner_id = bulkEditForm.cleaner
    if (bulkEditForm.inspector === '__clear__') patch.inspector_id = null
    else if (bulkEditForm.inspector !== '__keep__') patch.inspector_id = bulkEditForm.inspector
    if (!Object.keys(patch).length) {
      message.warning('未选择任何要批量修改的字段')
      return
    }
    await postJSON('/cleaning/tasks/bulk-patch', { ids: bulkEditForm.ids, patch })
    setBulkEditOpen(false)
    setBulkEditForm(null)
    message.success('已批量更新')
    loadRangeItems().catch(() => {})
  }, [bulkEditForm, loadRangeItems])

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

        {showDevDebugInfo ? (
          <>
            {API_BASE ? <Alert type="info" showIcon message={`API_BASE=${API_BASE}`} /> : <Alert type="warning" showIcon message="NEXT_PUBLIC_API_BASE_URL 未设置" />}
            {tasksMinMaxError ? <Alert type="warning" showIcon message="任务范围查询失败" description={tasksMinMaxError} /> : null}
            {tasksMinMax?.min || tasksMinMax?.max ? <Alert type="info" showIcon message={`任务范围：${tasksMinMax.min || '-'} ～ ${tasksMinMax.max || '-'}`} /> : null}
          </>
        ) : null}

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
                      const bg = cleanerColorOf(it)
                      const fg = isDarkBg(bg) ? '#ffffff' : '#0f172a'
                      return (
                        <div
                          key={`${it.source}:${it.entity_id}`}
                          className={`${styles.pill} ${pillCls}`}
                          title={title}
                          style={{ backgroundColor: bg, color: fg }}
                        >
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
                value={filterCleaner}
                onChange={(v) => setFilterCleaner(v)}
                placeholder="筛选清洁"
                allowClear
                showSearch
                optionFilterProp="label"
                style={{ width: 180 }}
                options={cleanerOptions}
              />
              <Select
                value={filterInspector}
                onChange={(v) => setFilterInspector(v)}
                placeholder="筛选检查"
                allowClear
                showSearch
                optionFilterProp="label"
                style={{ width: 180 }}
                options={inspectorOptions}
              />
              <Select
                value={filterStatus}
                onChange={(v) => setFilterStatus(v)}
                placeholder="筛选状态"
                allowClear
                style={{ width: 180 }}
                options={[
                  { label: '待处理', value: 'pending' },
                  { label: '已分配', value: 'assigned' },
                  { label: '进行中', value: 'in_progress' },
                  { label: '已完成', value: 'completed' },
                  { label: '已取消', value: 'cancelled' },
                  { label: '待处理（线下）', value: 'todo' },
                  { label: '已完成（线下）', value: 'done' },
                ]}
              />
              <Button
                className={styles.secondaryBtn}
                onClick={() => {
                  setBulkMode((v) => !v)
                  setSelectedTaskIds([])
                }}
              >
                {bulkMode ? '退出批量' : '批量操作'}
              </Button>
              {bulkMode ? (
                <>
                  <Button className={styles.secondaryBtn} onClick={openBulkEdit} disabled={!selectedTaskIds.length}>
                    批量编辑（{selectedTaskIds.length}）
                  </Button>
                  <Button
                    danger
                    className={styles.secondaryBtn}
                    disabled={!selectedTaskIds.length}
                    onClick={() => {
                      Modal.confirm({
                        title: '确认删除所选任务？',
                        content: `将删除 ${selectedTaskIds.length} 个任务（会标记为 cancelled 并从列表移除）`,
                        okText: '删除',
                        okButtonProps: { danger: true },
                        onOk: () => deleteTasks(selectedTaskIds).catch((e) => message.error(e?.message || '删除失败')),
                      })
                    }}
                  >
                    批量删除
                  </Button>
                </>
              ) : null}
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
              const accentCls =
                kind === 'unassigned' ? styles.accentUnassigned : kind === 'checkout' ? styles.accentCheckout : kind === 'combined' ? styles.accentCombined : ''
              const accentColor = cleanerColorOf(it)
              const isMerged = Array.isArray(it.entity_ids) && it.entity_ids.length > 1
              const ids = entityIds(it)
              const selectChecked = it.source === 'cleaning_tasks' && ids.length > 0 && ids.every((x) => selectedSet.has(String(x)))
              const selectIndeterminate = it.source === 'cleaning_tasks' && !selectChecked && ids.some((x) => selectedSet.has(String(x)))
              const orderDisplay = (id: string | null | undefined, code: string | null | undefined) => {
                const v = String(code || id || '').trim()
                return v ? v : '-'
              }
              const isTurnover = String(it.task_type || '').toLowerCase() === 'turnover' || (String(it.label || '').includes('退房') && String(it.label || '').includes('入住'))
              const checkoutCode = isTurnover ? orderDisplay(it.checkout_order_id, it.checkout_order_code) : orderDisplay(it.order_id, it.order_code)
              const checkinCode = orderDisplay(it.checkin_order_id, it.checkin_order_code)
              return (
                <div key={`${it.source}:${it.entity_id}`} className={styles.missionCard}>
                  <div className={`${styles.accent} ${accentCls}`} style={{ backgroundColor: accentColor }} />
                  <div className={styles.missionTop}>
                    <div className={styles.headerLeft}>
                      {bulkMode && it.source === 'cleaning_tasks' ? (
                        <Checkbox
                          checked={selectChecked}
                          indeterminate={selectIndeterminate}
                          onChange={(e) => toggleSelectItem(it, e.target.checked)}
                        />
                      ) : null}
                      <span className={`${styles.statusChip} ${statusChipCls(it.status)}`}>{statusText(it.status)}</span>
                      <div className={styles.headerTitle}>
                        {sum.region ? <span className={styles.headerRegion}>{sum.region}</span> : null}
                        <span className={styles.headerCode}>{sum.code || room}</span>
                        {sum.detail ? <span className={styles.headerDetail}>{sum.detail}</span> : null}
                      </div>
                    </div>
                    {it.source === 'cleaning_tasks' ? (
                      <div className={styles.taskActions}>
                        <Button className={`${styles.taskBtn} ${styles.taskBtnGhost}`} size="small" icon={<EditOutlined />} onClick={() => openEdit(it).catch((e) => message.error(e?.message || '打开失败'))}>
                          编辑
                        </Button>
                        <Button
                          className={`${styles.taskBtn} ${styles.taskBtnDanger}`}
                          size="small"
                          danger
                          icon={<DeleteOutlined />}
                          onClick={() => {
                            Modal.confirm({
                              title: '确认删除任务？',
                              content: isMerged ? `将删除 ${ids.length} 个任务（会标记为 cancelled 并从列表移除）` : '将删除该任务（会标记为 cancelled 并从列表移除）',
                              okText: '删除',
                              okButtonProps: { danger: true },
                              onOk: () => deleteTasks(ids).catch((e) => message.error(e?.message || '删除失败')),
                            })
                          }}
                        >
                          删除
                        </Button>
                      </div>
                    ) : null}
                  </div>
                  <div className={styles.metaRow}>
                    {it.nights != null ? <span className={styles.metaChip}>{`${it.nights}晚`}</span> : null}
                    {checkoutCode !== '-' ? <span className={styles.metaText}><span className={styles.metaKey}>退房</span>{checkoutCode}</span> : null}
                    {isTurnover && checkinCode !== '-' ? <span className={styles.metaText}><span className={styles.metaKey}>入住</span>{checkinCode}</span> : null}
                  </div>
                  <div className={styles.controlsRow}>
                    {it.source === 'cleaning_tasks' ? (
                      <>
                        <div className={styles.assigneeGroup}>
                          <div className={styles.assigneeLabel}>清洁</div>
                          <Select
                            className={styles.assigneeSelect}
                            allowClear
                            showSearch
                            optionFilterProp="label"
                            disabled={bulkMode}
                            value={(it.cleaner_id || it.assignee_id) || undefined}
                            options={cleanerOptions}
                            onChange={(v) => updateTaskQuick(ids, { cleaner_id: v ? String(v) : null }).catch((e) => message.error(e?.message || '更新失败'))}
                            placeholder={staffNameById((it.cleaner_id || it.assignee_id) || null)}
                          />
                        </div>
                        <div className={styles.assigneeGroup}>
                          <div className={styles.assigneeLabel}>检查</div>
                          <Select
                            className={styles.assigneeSelect}
                            allowClear
                            showSearch
                            optionFilterProp="label"
                            disabled={bulkMode}
                            value={it.inspector_id || undefined}
                            options={inspectorOptions}
                            onChange={(v) => updateTaskQuick(ids, { inspector_id: v ? String(v) : null }).catch((e) => message.error(e?.message || '更新失败'))}
                            placeholder={staffNameById(it.inspector_id || null)}
                          />
                        </div>
                        <div className={styles.assigneeGroup}>
                          <div className={styles.assigneeLabel}>状态</div>
                          <Select
                            className={styles.assigneeSelect}
                            disabled={bulkMode}
                            value={String(it.status || 'pending')}
                            options={statusOptions}
                            onChange={(v) => updateTaskQuick(ids, { status: v }).catch((e) => message.error(e?.message || '更新失败'))}
                          />
                        </div>
                      </>
                    ) : null}
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
                options={statusOptions}
              />
            </div>
            <div>
              <div className={styles.fieldLabel}>清洁人员</div>
              <Select
                allowClear
                showSearch
                optionFilterProp="label"
                value={editForm.cleaner_id || undefined}
                onChange={(v) => setEditForm((p) => (p ? { ...p, cleaner_id: v ? String(v) : null } : p))}
                style={{ width: '100%' }}
                options={cleanerOptions}
              />
            </div>
            <div>
              <div className={styles.fieldLabel}>检查人员</div>
              <Select
                allowClear
                showSearch
                optionFilterProp="label"
                value={editForm.inspector_id || undefined}
                onChange={(v) => setEditForm((p) => (p ? { ...p, inspector_id: v ? String(v) : null } : p))}
                style={{ width: '100%' }}
                options={inspectorOptions}
              />
            </div>
            <div>
              <div className={styles.fieldLabel}>新增任务</div>
              <Space wrap>
                {editForm.checkout_ids.length ? (
                  <Button
                    danger
                    onClick={() => {
                      Modal.confirm({
                        title: '确认取消退房任务？',
                        content: `将取消 ${editForm.checkout_ids.length} 个退房任务`,
                        okText: '取消退房',
                        okButtonProps: { danger: true },
                        onOk: () => cancelTasksInEdit(editForm.checkout_ids, '退房').catch((e) => message.error(e?.message || '取消失败')),
                      })
                    }}
                  >
                    取消退房
                  </Button>
                ) : (
                  <Button
                    disabled={!editForm.can_add_checkout && !editForm.pending_add_checkout}
                    onClick={() => setEditForm((p) => {
                      if (!p) return p
                      const next = !p.pending_add_checkout
                      if (!next) return { ...p, pending_add_checkout: false, checkout_password: '', checkout_time: '10am' }
                      return { ...p, pending_add_checkout: true, checkout_time: p.checkout_time || '10am' }
                    })}
                  >
                    {editForm.pending_add_checkout ? '取消新增退房' : '新增退房'}
                  </Button>
                )}

                {editForm.checkin_ids.length ? (
                  <Button
                    danger
                    onClick={() => {
                      Modal.confirm({
                        title: '确认取消入住任务？',
                        content: `将取消 ${editForm.checkin_ids.length} 个入住任务`,
                        okText: '取消入住',
                        okButtonProps: { danger: true },
                        onOk: () => cancelTasksInEdit(editForm.checkin_ids, '入住').catch((e) => message.error(e?.message || '取消失败')),
                      })
                    }}
                  >
                    取消入住
                  </Button>
                ) : (
                  <Button
                    disabled={!editForm.can_add_checkin && !editForm.pending_add_checkin}
                    onClick={() => setEditForm((p) => {
                      if (!p) return p
                      const next = !p.pending_add_checkin
                      if (!next) return { ...p, pending_add_checkin: false, checkin_password: '', nights_override: null, checkin_time: '3pm', checkin_task_date: p.task_date }
                      return { ...p, pending_add_checkin: true, checkin_time: p.checkin_time || '3pm', checkin_task_date: p.checkin_task_date || p.task_date }
                    })}
                  >
                    {editForm.pending_add_checkin ? '取消新增入住' : '新增入住'}
                  </Button>
                )}
              </Space>
              {editForm.pending_add_checkout ? <Alert type="info" showIcon message="保存时将新增退房任务" /> : null}
              {editForm.pending_add_checkin ? <Alert type="info" showIcon message="保存时将新增入住任务" /> : null}
              {!editForm.property_id ? <Alert type="warning" showIcon message="该任务缺少 property_id，无法新增退房/入住" /> : null}
            </div>
            <div>
              <div className={styles.fieldLabel}>退房密码（旧密码）</div>
              <Input
                value={editForm.checkout_password}
                onChange={(e) => setEditForm((p) => (p ? { ...p, checkout_password: e.target.value } : p))}
                placeholder="退房密码"
              />
            </div>
            {editForm.checkout_ids.length || editForm.pending_add_checkout ? (
              <div>
                <div className={styles.fieldLabel}>退房时间</div>
                <Select
                  allowClear
                  showSearch
                  optionFilterProp="label"
                  value={editForm.checkout_time || undefined}
                  onChange={(v) => setEditForm((p) => (p ? { ...p, checkout_time: String(v || '') } : p))}
                  style={{ width: '100%' }}
                  options={timeOptions}
                />
              </div>
            ) : null}
            {editForm.checkin_ids.length || editForm.pending_add_checkin ? (
              <>
                <div>
                  <div className={styles.fieldLabel}>入住日期</div>
                  <DatePicker
                    value={editForm.checkin_task_date}
                    onChange={(v) => setEditForm((p) => (p ? { ...p, checkin_task_date: v || p.task_date } : p))}
                    style={{ width: '100%' }}
                  />
                  {editForm.checkin_task_date && !editForm.checkin_task_date.isSame(editForm.task_date, 'day') ? (
                    <Alert type="info" showIcon message="已标记为隔天入住（入住任务会移动到所选日期）" />
                  ) : null}
                </div>
                <div>
                  <div className={styles.fieldLabel}>入住时间</div>
                  <Select
                    allowClear
                    showSearch
                    optionFilterProp="label"
                    value={editForm.checkin_time || undefined}
                    onChange={(v) => setEditForm((p) => (p ? { ...p, checkin_time: String(v || '') } : p))}
                    style={{ width: '100%' }}
                    options={timeOptions}
                  />
                </div>
                <div>
                  <div className={styles.fieldLabel}>入住天数</div>
                  <InputNumber
                    style={{ width: '100%' }}
                    min={0}
                    placeholder="例如 2"
                    value={editForm.nights_override ?? undefined}
                    onChange={(v) => setEditForm((p) => (p ? { ...p, nights_override: v == null ? null : Number(v) } : p))}
                  />
                </div>
                <div>
                  <div className={styles.fieldLabel}>入住密码（新密码）</div>
                  <Input
                    value={editForm.checkin_password}
                    onChange={(e) => setEditForm((p) => (p ? { ...p, checkin_password: e.target.value } : p))}
                    placeholder="入住密码"
                  />
                </div>
              </>
            ) : null}
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
        open={bulkEditOpen}
        title="批量编辑清洁任务"
        okText="保存"
        onOk={() => submitBulkEdit().catch((e) => message.error(e?.message || '保存失败'))}
        onCancel={() => { setBulkEditOpen(false); setBulkEditForm(null) }}
      >
        {bulkEditForm ? (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Alert type="info" showIcon message={`已选择 ${bulkEditForm.ids.length} 个任务`} />
            <div>
              <div className={styles.fieldLabel}>状态</div>
              <Select
                value={bulkEditForm.status}
                onChange={(v) => setBulkEditForm((p) => (p ? { ...p, status: v } : p))}
                style={{ width: '100%' }}
                options={[
                  { label: '不修改', value: '__keep__' },
                  ...statusOptions,
                ]}
              />
            </div>
            <div>
              <div className={styles.fieldLabel}>清洁人员</div>
              <Select
                showSearch
                optionFilterProp="label"
                value={bulkEditForm.cleaner}
                onChange={(v) => setBulkEditForm((p) => (p ? { ...p, cleaner: v } : p))}
                style={{ width: '100%' }}
                options={[
                  { label: '不修改', value: '__keep__' },
                  { label: '清空', value: '__clear__' },
                  ...cleanerOptions,
                ]}
              />
            </div>
            <div>
              <div className={styles.fieldLabel}>检查人员</div>
              <Select
                showSearch
                optionFilterProp="label"
                value={bulkEditForm.inspector}
                onChange={(v) => setBulkEditForm((p) => (p ? { ...p, inspector: v } : p))}
                style={{ width: '100%' }}
                options={[
                  { label: '不修改', value: '__keep__' },
                  { label: '清空', value: '__clear__' },
                  ...inspectorOptions,
                ]}
              />
            </div>
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
