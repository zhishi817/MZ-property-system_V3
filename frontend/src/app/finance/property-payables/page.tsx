"use client"

import { App, Button, Card, Col, DatePicker, Descriptions, Drawer, Empty, Form, Input, InputNumber, Modal, Row, Segmented, Select, Space, Statistic, Table, Tag, Upload } from 'antd'
import { UploadOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import dynamic from 'next/dynamic'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { API_BASE, authHeaders, getJSON, postJSON } from '../../../lib/api'
import { sortActivePropertiesByRegionThenCode } from '../../../lib/properties'
import {
  PROPERTY_PAYABLE_CATEGORY_OPTIONS,
  PROPERTY_PAYABLE_FREQUENCY_OPTIONS,
  PROPERTY_PAYABLE_PAYMENT_TYPE_OPTIONS,
  PROPERTY_PAYABLE_TEMPLATE_KIND,
  canMarkPropertyPayablePaid,
  formatPropertyPayableMonthKey,
  propertyPayableCategoryLabel,
  propertyPayablePaymentTypeLabel,
  toPropertyPayableMonthValue,
} from '../../../lib/propertyPayables'
import AuditTrail from '../../../components/AuditTrail'
import PropertyPayableVendorInput from '../../../components/PropertyPayableVendorInput'
import dayGridPlugin from '@fullcalendar/daygrid'
import interactionPlugin from '@fullcalendar/interaction'

const FullCalendar = dynamic(() => import('@fullcalendar/react'), { ssr: false })

type Property = { id: string; code?: string; address?: string; region?: string; archived?: boolean | null }
type WorkbenchRow = {
  template_id: string
  snapshot_id?: string | null
  property_id?: string | null
  property_code?: string | null
  property_address?: string | null
  vendor: string
  category?: string | null
  category_detail?: string | null
  start_month_key?: string | null
  due_day_of_month?: number
  frequency_months?: number
  report_category?: string | null
  template_note?: string | null
  bill_account_no?: string | null
  template_status?: string | null
  payment_type?: string | null
  pay_account_name?: string | null
  pay_bsb?: string | null
  pay_account_number?: string | null
  pay_ref?: string | null
  bpay_code?: string | null
  pay_mobile_number?: string | null
  amount?: number
  due_date?: string | null
  paid_date?: string | null
  status?: string
  note?: string | null
  amount_confirmed?: boolean
  amount_confirmed_by?: string | null
  amount_confirmed_at?: string | null
  paid_by?: string | null
  paid_confirmed_at?: string | null
  remind_days_before?: number
  is_overdue?: boolean
  is_due_soon?: boolean
}
type ExpenseInvoice = { id: string; expense_id: string; url: string; file_name?: string; mime_type?: string; file_size?: number }
type WorkbenchMonthData = { rows: WorkbenchRow[]; summary: any; month_key?: string }
type WorkbenchBatchData = WorkbenchMonthData & { months?: Record<string, WorkbenchMonthData>; month_keys?: string[] }

function monthKey(d: dayjs.Dayjs) {
  return d.format('YYYY-MM')
}

function surroundingMonthKeys(d: dayjs.Dayjs) {
  return [d.subtract(1, 'month').format('YYYY-MM'), d.format('YYYY-MM'), d.add(1, 'month').format('YYYY-MM')]
}

function statusTag(row: WorkbenchRow) {
  if (row.status === 'paid') return <Tag color="green">已付</Tag>
  if (row.is_overdue) return <Tag color="red">逾期</Tag>
  if (row.is_due_soon) return <Tag color="gold">快到期</Tag>
  if (!row.amount_confirmed) return <Tag>待确认金额</Tag>
  return <Tag>待付款</Tag>
}

function sameWorkbenchRow(a?: WorkbenchRow | null, b?: WorkbenchRow | null) {
  if (!a || !b) return false
  return String(a.template_id || '') === String(b.template_id || '') && String(a.due_date || '') === String(b.due_date || '')
}

function isDueSoon(row?: WorkbenchRow | null) {
  if (!row || row.status === 'paid' || row.is_overdue || !row.due_date) return false
  if (row.is_due_soon === true) return true
  const today = dayjs().startOf('day')
  const due = dayjs(String(row.due_date), 'YYYY-MM-DD')
  if (!due.isValid()) return false
  const diff = due.diff(today, 'day')
  return diff >= 0 && diff <= 3
}

function workbenchMonthKey(row?: WorkbenchRow | null, fallback?: string) {
  const dueDate = String(row?.due_date || '').trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return dueDate.slice(0, 7)
  return String(fallback || '').trim()
}

export default function PropertyPayablesPage() {
  const { message } = App.useApp()
  const [month, setMonth] = useState(dayjs())
  const [calendarScale, setCalendarScale] = useState<'month' | 'week' | 'day'>('month')
  const [rows, setRows] = useState<WorkbenchRow[]>([])
  const [calendarRows, setCalendarRows] = useState<WorkbenchRow[]>([])
  const [summary, setSummary] = useState({ unpaid_amount: 0, awaiting_confirmation_count: 0, overdue_count: 0, paid_amount: 0 })
  const [properties, setProperties] = useState<Property[]>([])
  const [selectedPropertyId, setSelectedPropertyId] = useState<string | undefined>()
  const [loading, setLoading] = useState(true)
  const [dayOpen, setDayOpen] = useState(false)
  const [selectedDay, setSelectedDay] = useState<string | null>(null)
  const [detailRow, setDetailRow] = useState<WorkbenchRow | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [confirmingRow, setConfirmingRow] = useState<WorkbenchRow | null>(null)
  const [confirmForm] = Form.useForm()
  const [confirmSaving, setConfirmSaving] = useState(false)
  const [templateOpen, setTemplateOpen] = useState(false)
  const [templateSaving, setTemplateSaving] = useState(false)
  const [editingTemplate, setEditingTemplate] = useState<WorkbenchRow | null>(null)
  const [templateForm] = Form.useForm()
  const watchedTemplatePaymentType = Form.useWatch('payment_type', templateForm) || 'bank_account'
  const [invoiceOpen, setInvoiceOpen] = useState<{ expenseId: string } | null>(null)
  const [invoices, setInvoices] = useState<ExpenseInvoice[]>([])
  const currentCalendarCardRef = useRef<HTMLDivElement | null>(null)

  const selectedMonthKey = monthKey(month)

  const fetchWorkbenchMonths = useCallback(async (targetMonthKeys: string[], currentMonthKey: string) => {
    const params = new URLSearchParams()
    params.set('month_key', currentMonthKey)
    params.set('month_keys', targetMonthKeys.join(','))
    return getJSON<WorkbenchBatchData>(`/recurring/property-payables/workbench?${params.toString()}`)
  }, [])

  const loadWorkbench = useCallback(async () => {
    setLoading(true)
    try {
      const monthKeys = surroundingMonthKeys(month)
      const currentMonthKey = monthKey(month)
      const data = await fetchWorkbenchMonths(monthKeys, currentMonthKey)
      const dataByMonth = data?.months || {}
      const currentData = dataByMonth[currentMonthKey] || data
      const mergedCalendarRows = monthKeys
        .map((mk) => dataByMonth[mk] || (mk === currentMonthKey ? currentData : null))
        .flatMap((item) => Array.isArray(item?.rows) ? item.rows : [])
        .filter((item, index, list) => list.findIndex((row) => `${row.template_id}:${row.due_date || ''}` === `${item.template_id}:${item.due_date || ''}`) === index)
      setRows(Array.isArray(currentData?.rows) ? currentData.rows : [])
      setCalendarRows(mergedCalendarRows)
      setSummary({
        unpaid_amount: Number(currentData?.summary?.unpaid_amount || 0),
        awaiting_confirmation_count: Number(currentData?.summary?.awaiting_confirmation_count || 0),
        overdue_count: Number(currentData?.summary?.overdue_count || 0),
        paid_amount: Number(currentData?.summary?.paid_amount || 0),
      })
    } catch (e: any) {
      message.error(e?.message || '加载房源代付失败')
      setRows([])
      setCalendarRows([])
    } finally {
      setLoading(false)
    }
  }, [fetchWorkbenchMonths, message, month])

  async function loadProperties() {
    const data = await getJSON<Property[]>('/properties').catch(() => [])
    setProperties(Array.isArray(data) ? data : [])
  }

  useEffect(() => {
    loadProperties()
  }, [])

  useEffect(() => {
    void loadWorkbench()
  }, [loadWorkbench])

  const propertyOptions = useMemo(() => sortActivePropertiesByRegionThenCode(properties || []).map((item) => {
    const code = String(item.code || '').trim()
    const address = String(item.address || '').trim()
    const region = String(item.region || '').trim()
    return {
      value: item.id,
      label: code || address || item.id,
      searchText: [code, address, region].filter(Boolean).join(' ').toLowerCase(),
    }
  }), [properties])

  const filteredRows = useMemo(
    () => selectedPropertyId ? rows.filter((row) => String(row.property_id || '') === selectedPropertyId) : rows,
    [rows, selectedPropertyId]
  )

  const filteredCalendarRows = useMemo(
    () => selectedPropertyId ? calendarRows.filter((row) => String(row.property_id || '') === selectedPropertyId) : calendarRows,
    [calendarRows, selectedPropertyId]
  )

  const visibleSummary = useMemo(() => {
    if (!selectedPropertyId) return summary
    return {
      unpaid_amount: filteredRows.filter((row) => row.status !== 'paid').reduce((sum, row) => sum + Number(row.amount || 0), 0),
      awaiting_confirmation_count: filteredRows.filter((row) => row.status !== 'paid' && !row.amount_confirmed).length,
      overdue_count: filteredRows.filter((row) => row.is_overdue).length,
      paid_amount: filteredRows.filter((row) => row.status === 'paid').reduce((sum, row) => sum + Number(row.amount || 0), 0),
    }
  }, [filteredRows, selectedPropertyId, summary])

  const rowsByDueDate = useMemo(() => {
    const map = new Map<string, WorkbenchRow[]>()
    for (const row of filteredCalendarRows) {
      const key = String(row.due_date || '').trim()
      if (!key) continue
      const list = map.get(key) || []
      list.push(row)
      map.set(key, list)
    }
    map.forEach((list, key) => {
      map.set(
        key,
        list.slice().sort((a, b) => {
          if (Boolean(a.is_overdue) !== Boolean(b.is_overdue)) return a.is_overdue ? -1 : 1
          if (isDueSoon(a) !== isDueSoon(b)) return isDueSoon(a) ? -1 : 1
          const ap = String(a.property_code || a.property_address || '')
          const bp = String(b.property_code || b.property_address || '')
          if (ap !== bp) return ap.localeCompare(bp)
          return String(a.vendor || '').localeCompare(String(b.vendor || ''))
        })
      )
    })
    return map
  }, [filteredCalendarRows])

  const selectedDayRows = useMemo(() => {
    if (!selectedDay) return []
    return rowsByDueDate.get(selectedDay) || []
  }, [rowsByDueDate, selectedDay])

  const calendarStripPeriods = useMemo(() => {
    if (calendarScale === 'week') return [month.subtract(1, 'week'), month, month.add(1, 'week')]
    if (calendarScale === 'day') return [month.subtract(1, 'day'), month, month.add(1, 'day')]
    return [month.subtract(1, 'month'), month, month.add(1, 'month')]
  }, [calendarScale, month])

  const calendarEvents = useMemo(() => {
    return filteredCalendarRows
      .filter((row) => !!row.due_date)
      .map((row) => {
        const stateClass = row.status === 'paid'
          ? 'paid'
          : row.is_overdue
            ? 'overdue'
            : isDueSoon(row)
              ? 'due-soon'
              : 'normal'
        return {
          id: `${row.template_id}:${row.due_date || ''}`,
          start: String(row.due_date),
          allDay: true,
          classNames: ['property-payable-event', `property-payable-event--${stateClass}`],
          extendedProps: {
            row,
            propertyLabel: row.property_code || row.property_address || '-',
            categoryLabel: propertyPayableCategoryLabel(row.category || ''),
            amountLabel: `$${Number(row.amount || 0).toFixed(2)}`,
          },
        }
      })
  }, [filteredCalendarRows])

  const calendarTitle = useMemo(() => {
    if (calendarScale === 'month') return month.format('YYYY 年 MM 月')
    if (calendarScale === 'week') {
      const start = month.startOf('week')
      const end = month.endOf('week')
      return `${start.format('MM/DD')} - ${end.format('MM/DD')}`
    }
    return month.format('YYYY-MM-DD')
  }, [calendarScale, month])

  useEffect(() => {
    const node = currentCalendarCardRef.current
    if (!node) return
    const timer = window.setTimeout(() => {
      node.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' })
    }, 30)
    return () => window.clearTimeout(timer)
  }, [calendarScale, month])

  function calendarPeriodTitle(value: dayjs.Dayjs) {
    if (calendarScale === 'month') return value.format('YYYY 年 MM 月')
    if (calendarScale === 'week') {
      const start = value.startOf('week')
      const end = value.endOf('week')
      return `${start.format('MM/DD')} - ${end.format('MM/DD')}`
    }
    return value.format('YYYY-MM-DD')
  }

  function openConfirm(row: WorkbenchRow) {
    setConfirmingRow(row)
    confirmForm.setFieldsValue({
      amount: Number(row.amount || 0),
      due_date: row.due_date ? dayjs(row.due_date) : null,
      note: row.note || '',
    })
    setConfirmOpen(true)
  }

  async function saveConfirmedAmount() {
    if (!confirmingRow) return
    const values = await confirmForm.validateFields()
    setConfirmSaving(true)
    try {
      await postJSON(`/recurring/payments/${confirmingRow.template_id}/confirm-amount`, {
        month_key: workbenchMonthKey(confirmingRow, selectedMonthKey),
        amount: Number(values.amount || 0),
        due_date: values.due_date ? dayjs(values.due_date).format('YYYY-MM-DD') : undefined,
        note: values.note || undefined,
      })
      message.success('本月账单已确认')
      setConfirmOpen(false)
      setConfirmingRow(null)
      await loadWorkbench()
    } catch (e: any) {
      message.error(e?.message || '确认账单失败')
    } finally {
      setConfirmSaving(false)
    }
  }

  function openTemplate(row?: WorkbenchRow | null) {
    setEditingTemplate(row || null)
    templateForm.resetFields()
    templateForm.setFieldsValue({
      property_id: row?.property_id || undefined,
      vendor: row?.vendor || '',
      category: row?.category || 'electricity',
      category_detail: row?.category_detail || '',
      amount: row?.amount == null ? undefined : Number(row.amount || 0),
      bill_account_no: row?.bill_account_no || '',
      start_month_key: toPropertyPayableMonthValue(row?.start_month_key || selectedMonthKey),
      due_day_of_month: Number(row?.due_day_of_month || (row?.due_date ? Number(String(row.due_date).slice(8, 10)) : 15)),
      frequency_months: Number(row?.frequency_months || 1),
      remind_days_before: Number(row?.remind_days_before || 3),
      payment_type: row?.payment_type || 'bank_account',
      pay_account_name: row?.pay_account_name || '',
      pay_bsb: row?.pay_bsb || '',
      pay_account_number: row?.pay_account_number || '',
      pay_ref: row?.pay_ref || '',
      bpay_code: row?.bpay_code || '',
      pay_mobile_number: row?.pay_mobile_number || '',
      note: row?.template_note || '',
    })
    setTemplateOpen(true)
  }

  async function saveTemplate() {
    const values = await templateForm.validateFields()
    const body = {
      scope: 'property',
      property_id: values.property_id,
      vendor: values.vendor,
      category: values.category,
      category_detail: values.category_detail || undefined,
      amount: values.amount == null ? 0 : Number(values.amount || 0),
      due_day_of_month: Number(values.due_day_of_month || 1),
      frequency_months: Number(values.frequency_months || 1),
      remind_days_before: Number(values.remind_days_before || 3),
      payment_type: values.payment_type || 'bank_account',
      pay_account_name: values.pay_account_name || undefined,
      pay_bsb: values.pay_bsb || undefined,
      pay_account_number: values.pay_account_number || undefined,
      pay_ref: values.pay_ref || undefined,
      bpay_code: values.bpay_code || undefined,
      pay_mobile_number: values.pay_mobile_number || undefined,
      start_month_key: formatPropertyPayableMonthKey(values.start_month_key),
      bill_account_no: values.bill_account_no || undefined,
      note: values.note || undefined,
      template_kind: PROPERTY_PAYABLE_TEMPLATE_KIND,
      status: editingTemplate?.template_status || 'active',
    }
    setTemplateSaving(true)
    try {
      if (editingTemplate) {
        const resp = await fetch(`${API_BASE}/recurring/payments/${editingTemplate.template_id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify(body),
        })
        const json = await resp.json().catch(() => ({}))
        if (!resp.ok) throw new Error(json?.message || `HTTP ${resp.status}`)
      } else {
        const resp = await fetch(`${API_BASE}/recurring/payments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ id: crypto.randomUUID(), ...body, initial_mark: 'unpaid' }),
        })
        const json = await resp.json().catch(() => ({}))
        if (!resp.ok) throw new Error(json?.message || `HTTP ${resp.status}`)
      }
      message.success(editingTemplate ? '模板已更新' : '模板已创建')
      setTemplateOpen(false)
      setEditingTemplate(null)
      await loadWorkbench()
    } catch (e: any) {
      message.error(e?.message || '保存模板失败')
    } finally {
      setTemplateSaving(false)
    }
  }

  async function toggleTemplatePause(row: WorkbenchRow) {
    const paused = row.template_status === 'paused'
    try {
      const resp = await fetch(`${API_BASE}/recurring/payments/${row.template_id}/${paused ? 'resume' : 'pause'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(paused ? { month_key: selectedMonthKey } : {}),
      })
      const json = await resp.json().catch(() => ({}))
      if (!resp.ok) throw new Error(json?.message || `HTTP ${resp.status}`)
      message.success(paused ? '模板已恢复' : '模板已暂停')
      await loadWorkbench()
    } catch (e: any) {
      message.error(e?.message || '更新模板状态失败')
    }
  }

  async function markPaid(row: WorkbenchRow) {
    try {
      const resp = await fetch(`${API_BASE}/recurring/payments/${row.template_id}/mark-paid`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ month_key: workbenchMonthKey(row, selectedMonthKey), paid_date: dayjs().format('YYYY-MM-DD') }),
      })
      const json = await resp.json().catch(() => ({}))
      if (!resp.ok) throw new Error(json?.message || `HTTP ${resp.status}`)
      message.success('已标记为已付')
      await loadWorkbench()
    } catch (e: any) {
      message.error(e?.message || '标记已付失败')
    }
  }

  async function unmarkPaid(row: WorkbenchRow) {
    try {
      const resp = await fetch(`${API_BASE}/recurring/payments/${row.template_id}/unmark-paid`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ month_key: workbenchMonthKey(row, selectedMonthKey) }),
      })
      const json = await resp.json().catch(() => ({}))
      if (!resp.ok) throw new Error(json?.message || `HTTP ${resp.status}`)
      message.success('已取消已付')
      await loadWorkbench()
    } catch (e: any) {
      message.error(e?.message || '取消已付失败')
    }
  }

  useEffect(() => {
    if (!detailRow) return
    const next = rowsByDueDate.get(String(detailRow.due_date || ''))?.find((row) => sameWorkbenchRow(row, detailRow))
      || filteredCalendarRows.find((row) => sameWorkbenchRow(row, detailRow))
    if (next && next !== detailRow) setDetailRow(next)
  }, [detailRow, filteredCalendarRows, rowsByDueDate])

  async function openInvoices(row: WorkbenchRow) {
    if (!row.snapshot_id) {
      message.warning('当前月份账单快照暂不可用，请先确认账单')
      return
    }
    try {
      const data = await getJSON<ExpenseInvoice[]>(`/finance/expense-invoices/${row.snapshot_id}`)
      setInvoices(Array.isArray(data) ? data : [])
      setInvoiceOpen({ expenseId: row.snapshot_id })
    } catch {
      setInvoices([])
      setInvoiceOpen({ expenseId: row.snapshot_id })
    }
  }

  async function uploadExpenseInvoice(expenseId: string, file: any) {
    const fd = new FormData()
    fd.append('file', file)
    const res = await fetch(`${API_BASE}/finance/expense-invoices/${expenseId}/upload`, { method: 'POST', headers: authHeaders(), body: fd })
    if (!res.ok) throw new Error('上传失败')
    const data = await getJSON<ExpenseInvoice[]>(`/finance/expense-invoices/${expenseId}`).catch(() => [])
    setInvoices(Array.isArray(data) ? data : [])
    message.success('本月支出发票已上传')
    return false
  }

  async function removeExpenseInvoice(id: string, expenseId: string) {
    const res = await fetch(`${API_BASE}/finance/expense-invoices/${id}`, { method: 'DELETE', headers: authHeaders() })
    if (!res.ok) {
      message.error('删除失败')
      return
    }
    message.success('已删除')
    const data = await getJSON<ExpenseInvoice[]>(`/finance/expense-invoices/${expenseId}`).catch(() => [])
    setInvoices(Array.isArray(data) ? data : [])
  }

  function openDay(dateISO: string) {
    setSelectedDay(dateISO)
    setDayOpen(true)
  }

  function shiftCalendar(step: number) {
    if (calendarScale === 'month') {
      setMonth((prev) => prev.add(step, 'month'))
      return
    }
    if (calendarScale === 'week') {
      setMonth((prev) => prev.add(step, 'week'))
      return
    }
    setMonth((prev) => prev.add(step, 'day'))
  }

  const columns = [
    { title: '房源', key: 'property', render: (_: any, row: WorkbenchRow) => row.property_code || row.property_address || '-' },
    { title: '收费公司/事项', dataIndex: 'vendor' },
    { title: '类别', dataIndex: 'category', render: (v: string) => propertyPayableCategoryLabel(v) },
    { title: '本月金额', dataIndex: 'amount', render: (v: number) => `$${Number(v || 0).toFixed(2)}` },
    { title: '到期日', dataIndex: 'due_date', render: (v: string) => v || '-' },
    { title: '状态', key: 'status', render: (_: any, row: WorkbenchRow) => statusTag(row) },
    { title: '确认人', dataIndex: 'amount_confirmed_by', render: (v: string, row: WorkbenchRow) => row.amount_confirmed ? (v || '-') : '-' },
    { title: '付款人', dataIndex: 'paid_by', render: (v: string) => v || '-' },
    {
      title: '操作',
      key: 'ops',
      render: (_: any, row: WorkbenchRow) => (
        <Space wrap>
          <Button onClick={() => { setDetailRow(row); setDetailOpen(true) }}>详情</Button>
          <Button onClick={() => openConfirm(row)} disabled={row.status === 'paid'}>调整本月账单</Button>
          <Button onClick={() => openInvoices(row)} disabled={!row.snapshot_id}>上传本月支出发票</Button>
          {row.status === 'paid'
            ? <Button onClick={() => unmarkPaid(row)}>取消已付</Button>
            : <Button type="primary" onClick={() => markPaid(row)} disabled={!canMarkPropertyPayablePaid(row)}>已付</Button>}
          <Button onClick={() => openTemplate(row)}>编辑模板</Button>
          <Button danger={row.template_status !== 'paused'} onClick={() => toggleTemplatePause(row)}>
            {row.template_status === 'paused' ? '恢复模板' : '暂停模板'}
          </Button>
        </Space>
      ),
    },
  ]

  return (
    <Card
      title="房源代付"
      extra={
        <Space>
          <Segmented
            value={calendarScale}
            onChange={(value) => setCalendarScale(value as 'month' | 'week' | 'day')}
            options={[
              { label: '月视图', value: 'month' },
              { label: '周视图', value: 'week' },
              { label: '天视图', value: 'day' },
            ]}
          />
          <Button onClick={() => shiftCalendar(-1)}>上一{calendarScale === 'month' ? '月' : calendarScale === 'week' ? '周' : '天'}</Button>
          <Button onClick={() => setMonth(dayjs())}>今天</Button>
          <Button onClick={() => shiftCalendar(1)}>下一{calendarScale === 'month' ? '月' : calendarScale === 'week' ? '周' : '天'}</Button>
          <DatePicker
            picker={calendarScale === 'month' ? 'month' : 'date'}
            value={month}
            onChange={(value) => setMonth(value || dayjs())}
          />
          <Button type="primary" onClick={() => openTemplate(null)}>新增代付模板</Button>
        </Space>
      }
    >
      <div style={{ marginBottom: 12 }}>
        <Select
          allowClear
          showSearch
          value={selectedPropertyId}
          placeholder="按房号搜索"
          options={propertyOptions}
          onChange={(value) => setSelectedPropertyId(value || undefined)}
          filterOption={(input, option) => String((option as any)?.searchText || (option as any)?.label || '').includes(input.trim().toLowerCase())}
          notFoundContent="没有匹配的房源"
          style={{ width: 320, maxWidth: '100%' }}
        />
      </div>

      <Row gutter={[12, 12]}>
        <Col xs={24} md={6}><Card><Statistic title="本月待付金额" prefix="$" precision={2} value={visibleSummary.unpaid_amount} /></Card></Col>
        <Col xs={24} md={6}><Card><Statistic title="本月待确认数量" value={visibleSummary.awaiting_confirmation_count} valueStyle={{ color: visibleSummary.awaiting_confirmation_count ? '#fa8c16' : undefined }} /></Card></Col>
        <Col xs={24} md={6}><Card><Statistic title="逾期数量" value={visibleSummary.overdue_count} valueStyle={{ color: visibleSummary.overdue_count ? '#cf1322' : undefined }} /></Card></Col>
        <Col xs={24} md={6}><Card><Statistic title="本月已付金额" prefix="$" precision={2} value={visibleSummary.paid_amount} /></Card></Col>
      </Row>

      <Card
        style={{ marginTop: 12 }}
        bodyStyle={{ padding: 12 }}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Card size="small">
            上方日历用于看付款节奏和房号分布，下方列表用于集中处理账单、确认金额和标记已付。
          </Card>
          <Card
            size="small"
            title={`连续${calendarScale === 'month' ? '月历' : calendarScale === 'week' ? '周历' : '日历'} · 当前定位 ${calendarTitle}`}
            extra={<span style={{ color: '#8c8c8c', fontSize: 12 }}>左右滑动可连续查看前后{calendarScale === 'month' ? '月份' : calendarScale === 'week' ? '周' : '天'}</span>}
          >
            <div className="property-payable-calendar-strip">
              {calendarStripPeriods.map((calendarPeriod, index) => {
                const initialView = calendarScale === 'month' ? 'dayGridMonth' : calendarScale === 'week' ? 'dayGridWeek' : 'dayGridDay'
                return (
                  <div
                    key={`${calendarScale}-strip:${calendarPeriod.format('YYYY-MM-DD')}`}
                    ref={index === 1 ? currentCalendarCardRef : null}
                    className={`property-payable-calendar-period-card${index === 1 ? ' is-current' : ''}`}
                  >
                    <div className="property-payable-calendar-period-heading">{calendarPeriodTitle(calendarPeriod)}</div>
                    <div className="property-payable-calendar">
                      <FullCalendar
                        key={`${calendarScale}:${calendarPeriod.format('YYYY-MM-DD')}`}
                        plugins={[dayGridPlugin, interactionPlugin]}
                        initialView={initialView}
                        initialDate={calendarPeriod.format('YYYY-MM-DD')}
                        headerToolbar={{ start: '', center: '', end: '' }}
                        height="auto"
                        firstDay={1}
                        fixedWeekCount={false}
                        dayMaxEvents={calendarScale === 'month' ? 5 : false}
                        moreLinkClick="popover"
                        selectable
                        selectMirror={false}
                        dateClick={(info) => openDay(info.dateStr)}
                        eventClick={(info) => {
                          const row = (info.event.extendedProps as any)?.row as WorkbenchRow | undefined
                          if (row) {
                            setDetailRow(row)
                            setDetailOpen(true)
                          }
                        }}
                        events={calendarEvents as any}
                        eventContent={(arg) => {
                          const props = (arg.event.extendedProps as any) || {}
                          return (
                            <div className="property-payable-event-card">
                              <div className="property-payable-event-title">{props.propertyLabel}</div>
                              <div className="property-payable-event-subtitle">{props.categoryLabel}</div>
                            </div>
                          )
                        }}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          </Card>
        </Space>
      </Card>

      <Card style={{ marginTop: 12 }} bodyStyle={{ padding: 0 }}>
        <div style={{ padding: '16px 16px 8px', fontWeight: 700 }}>记录列表</div>
        <Table
          rowKey={(row) => `${row.template_id}:${selectedMonthKey}`}
          columns={columns as any}
          dataSource={filteredRows}
          loading={loading}
          pagination={{ pageSize: 20 }}
          rowClassName={(row) => row.is_overdue ? 'property-payable-row-overdue' : (isDueSoon(row) ? 'property-payable-row-due-soon' : '')}
        />
      </Card>

      <Drawer open={dayOpen} onClose={() => setDayOpen(false)} width={720} title={selectedDay ? `${selectedDay} 待付款账单` : '当天账单'}>
        {selectedDayRows.length ? (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            {selectedDayRows.map((row) => (
              <Card
                key={`${row.template_id}:${selectedDay}`}
                size="small"
                className={row.is_overdue ? 'property-payable-card-overdue' : (isDueSoon(row) ? 'property-payable-card-due-soon' : '')}
                title={`${row.property_code || row.property_address || '-'} · ${row.vendor || '-'}`}
                extra={statusTag(row)}
              >
                <Descriptions size="small" column={2}>
                  <Descriptions.Item label="类别">{propertyPayableCategoryLabel(row.category || '')}</Descriptions.Item>
                  <Descriptions.Item label="金额">{`$${Number(row.amount || 0).toFixed(2)}`}</Descriptions.Item>
                  <Descriptions.Item label="付款方式">{propertyPayablePaymentTypeLabel(row.payment_type || '')}</Descriptions.Item>
                  <Descriptions.Item label="付款人">{row.paid_by || '-'}</Descriptions.Item>
                  <Descriptions.Item label="确认人">{row.amount_confirmed_by || '-'}</Descriptions.Item>
                  <Descriptions.Item label="Account Number">{row.bill_account_no || '-'}</Descriptions.Item>
                </Descriptions>
                <Space wrap style={{ marginTop: 12 }}>
                  <Button onClick={() => { setDetailRow(row); setDetailOpen(true) }}>详情</Button>
                  <Button onClick={() => openConfirm(row)} disabled={row.status === 'paid'}>调整本月账单</Button>
                  {row.status === 'paid'
                    ? <Button onClick={() => unmarkPaid(row)}>取消已付</Button>
                    : <Button type="primary" onClick={() => markPaid(row)} disabled={!canMarkPropertyPayablePaid(row)}>已付</Button>}
                </Space>
              </Card>
            ))}
          </Space>
        ) : (
          <Empty description="当天没有到期账单" />
        )}
      </Drawer>

      <Drawer
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        width={760}
        title="代付详情"
        extra={detailRow ? (
          <Space wrap>
            <Button onClick={() => openConfirm(detailRow)} disabled={detailRow.status === 'paid'}>调整本月账单</Button>
            <Button onClick={() => openInvoices(detailRow)} disabled={!detailRow.snapshot_id}>上传本月支出发票</Button>
            {detailRow.status === 'paid'
              ? <Button onClick={() => unmarkPaid(detailRow)}>取消已付</Button>
              : <Button type="primary" onClick={() => markPaid(detailRow)} disabled={!canMarkPropertyPayablePaid(detailRow)}>登记支付</Button>}
          </Space>
        ) : null}
      >
        {detailRow ? (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Descriptions bordered column={2} size="small">
              <Descriptions.Item label="房源">{detailRow.property_code || detailRow.property_address || '-'}</Descriptions.Item>
              <Descriptions.Item label="收费公司/事项">{detailRow.vendor || '-'}</Descriptions.Item>
              <Descriptions.Item label="类别">{propertyPayableCategoryLabel(detailRow.category || '')}</Descriptions.Item>
              <Descriptions.Item label="Account Number">{detailRow.bill_account_no || '-'}</Descriptions.Item>
              <Descriptions.Item label="本月金额">{`$${Number(detailRow.amount || 0).toFixed(2)}`}</Descriptions.Item>
              <Descriptions.Item label="到期日">{detailRow.due_date || '-'}</Descriptions.Item>
              <Descriptions.Item label="状态">{statusTag(detailRow)}</Descriptions.Item>
              <Descriptions.Item label="模板状态">{detailRow.template_status === 'paused' ? '已暂停' : '启用中'}</Descriptions.Item>
              <Descriptions.Item label="模板起始月份">{detailRow.start_month_key || '-'}</Descriptions.Item>
              <Descriptions.Item label="付款周期">
                {PROPERTY_PAYABLE_FREQUENCY_OPTIONS.find((item) => item.value === Number(detailRow.frequency_months || 1))?.label || `${Number(detailRow.frequency_months || 1)} 个月`}
              </Descriptions.Item>
              <Descriptions.Item label="付款方式">{propertyPayablePaymentTypeLabel(detailRow.payment_type || '')}</Descriptions.Item>
              <Descriptions.Item label="收款方">{detailRow.pay_account_name || '-'}</Descriptions.Item>
              <Descriptions.Item label="模板备注" span={2}>{detailRow.template_note || '-'}</Descriptions.Item>
              <Descriptions.Item label="本月备注" span={2}>{detailRow.note || '-'}</Descriptions.Item>
              <Descriptions.Item label="金额确认人">{detailRow.amount_confirmed_by || '-'}</Descriptions.Item>
              <Descriptions.Item label="金额确认时间">{detailRow.amount_confirmed_at || '-'}</Descriptions.Item>
              <Descriptions.Item label="付款人">{detailRow.paid_by || '-'}</Descriptions.Item>
              <Descriptions.Item label="付款时间">{detailRow.paid_confirmed_at || detailRow.paid_date || '-'}</Descriptions.Item>
            </Descriptions>
            <Card size="small" title="支付登记">
              <Space wrap>
                <Button onClick={() => openConfirm(detailRow)} disabled={detailRow.status === 'paid'}>确认本月金额</Button>
                <Button onClick={() => openInvoices(detailRow)} disabled={!detailRow.snapshot_id}>上传本月支出发票</Button>
                {detailRow.status === 'paid'
                  ? <Button onClick={() => unmarkPaid(detailRow)}>取消已付</Button>
                  : <Button type="primary" onClick={() => markPaid(detailRow)} disabled={!canMarkPropertyPayablePaid(detailRow)}>登记支付</Button>}
              </Space>
              {!detailRow.amount_confirmed && detailRow.status !== 'paid' ? (
                <div style={{ marginTop: 8, color: '#ad6800', fontSize: 12 }}>
                  浮动费用必须先确认本月金额，确认后才能登记支付。
                </div>
              ) : null}
            </Card>
            <AuditTrail
              refs={[
                { entity: 'RecurringPayment', entity_id: detailRow.template_id },
                ...(detailRow.snapshot_id ? [{ entity: 'property_expenses', entity_id: detailRow.snapshot_id }] : []),
              ]}
            />
          </Space>
        ) : null}
      </Drawer>

      <Drawer
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        width={520}
        title="调整本月账单（仅修改本月快照）"
        extra={<Button type="primary" loading={confirmSaving} onClick={saveConfirmedAmount}>保存并确认金额</Button>}
      >
        <Form form={confirmForm} layout="vertical">
          <Card size="small" style={{ marginBottom: 16 }}>
            这里只会更新当前月份账单快照的金额、到期日和备注，不会改动代付模板的默认金额、周期或付款方式。
          </Card>
          <Form.Item name="amount" label="本月实际金额" rules={[{ required: true, message: '请输入金额' }]}>
            <InputNumber min={0} step={0.01} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="due_date" label="本月到期日" rules={[{ required: true, message: '请选择到期日' }]}>
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="note" label="本月备注">
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Drawer>

      <Drawer
        open={templateOpen}
        onClose={() => setTemplateOpen(false)}
        width={720}
        title={editingTemplate ? '编辑代付模板' : '新增代付模板'}
        extra={<Button type="primary" loading={templateSaving} onClick={saveTemplate}>保存模板</Button>}
      >
        <Form form={templateForm} layout="vertical">
          <Row gutter={[16, 12]}>
            <Col span={12}>
              <Form.Item name="property_id" label="房源" rules={[{ required: true, message: '请选择房源' }]}>
                <Select showSearch optionFilterProp="label" options={propertyOptions} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="vendor" label="收费公司/事项" rules={[{ required: true, message: '请输入收费公司或事项' }]}>
                <PropertyPayableVendorInput />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="category" label="类别" rules={[{ required: true, message: '请选择类别' }]}>
                <Select options={PROPERTY_PAYABLE_CATEGORY_OPTIONS.map((item) => ({ value: item.value, label: item.label }))} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="amount" label="默认金额">
                <InputNumber min={0} step={1} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="bill_account_no" label="Account Number">
                <Input />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="start_month_key" label="起始月份" rules={[{ required: true, message: '请选择起始月份' }]}>
                <DatePicker picker="month" format="YYYY-MM" style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="due_day_of_month" label="每月到期日" rules={[{ required: true, message: '请输入到期日' }]}>
                <InputNumber min={1} max={31} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="frequency_months" label="付款周期">
                <Select options={PROPERTY_PAYABLE_FREQUENCY_OPTIONS.map((item) => ({ value: item.value, label: item.label }))} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="remind_days_before" label="提前提示天数">
                <InputNumber min={0} max={30} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="payment_type" label="付款方式">
                <Select options={PROPERTY_PAYABLE_PAYMENT_TYPE_OPTIONS.map((item) => ({ value: item.value, label: item.label }))} />
              </Form.Item>
            </Col>
            {watchedTemplatePaymentType === 'bank_account' ? (
              <>
                <Col span={12}>
                  <Form.Item name="pay_account_name" label="收款方">
                    <Input />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item name="pay_bsb" label="BSB">
                    <Input />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item name="pay_account_number" label="Account No.">
                    <Input />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item name="pay_ref" label="付款 Reference">
                    <Input />
                  </Form.Item>
                </Col>
              </>
            ) : null}
            {watchedTemplatePaymentType === 'bpay' ? (
              <>
                <Col span={12}>
                  <Form.Item name="bpay_code" label="BPAY Code">
                    <Input />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item name="pay_ref" label="付款 Reference">
                    <Input />
                  </Form.Item>
                </Col>
              </>
            ) : null}
            {watchedTemplatePaymentType === 'payid' ? (
              <>
                <Col span={12}>
                  <Form.Item name="pay_account_name" label="收款方">
                    <Input />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item name="pay_mobile_number" label="PayID 手机号">
                    <Input />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item name="pay_ref" label="付款 Reference">
                    <Input />
                  </Form.Item>
                </Col>
              </>
            ) : null}
            {watchedTemplatePaymentType === 'cash' ? (
              <Col span={24}>
                <Card size="small">现金付款无需填写收款账户信息。</Card>
              </Col>
            ) : null}
            {watchedTemplatePaymentType === 'rent_deduction' ? (
              <Col span={24}>
                <Card size="small">租金扣除无需填写银行或 BPAY 信息。</Card>
              </Col>
            ) : null}
            <Col span={24}>
              <Form.Item name="note" label="模板备注">
                <Input.TextArea rows={3} />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Drawer>

      <Modal open={!!invoiceOpen} title="本月支出发票" footer={null} onCancel={() => setInvoiceOpen(null)} width={760}>
        {invoiceOpen ? (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Upload
              showUploadList={false}
              customRequest={async ({ file, onSuccess, onError }: any) => {
                try {
                  await uploadExpenseInvoice(invoiceOpen.expenseId, file)
                  onSuccess?.({}, file)
                } catch (e) {
                  onError?.(e)
                }
              }}
            >
              <Button icon={<UploadOutlined />}>上传本月支出发票</Button>
            </Upload>
            <Table
              rowKey={(row) => row.id}
              dataSource={invoices}
              pagination={false}
              columns={[
                { title: '文件名', dataIndex: 'file_name', render: (v: string) => v || '-' },
                {
                  title: '操作',
                  key: 'ops',
                  render: (_: any, row: ExpenseInvoice) => (
                    <Space>
                      <Button size="small" onClick={() => window.open(/^https?:\/\//.test(String(row.url || '')) ? String(row.url) : `${API_BASE}${String(row.url || '')}`, '_blank', 'noopener,noreferrer')}>查看</Button>
                      <Button size="small" danger onClick={() => removeExpenseInvoice(row.id, invoiceOpen.expenseId)}>删除</Button>
                    </Space>
                  ),
                },
              ]}
            />
          </Space>
        ) : null}
      </Modal>

      <style jsx global>{`
        .property-payable-row-overdue td {
          background: #fff1f0 !important;
        }
        .property-payable-row-pending td {
          background: #fff7e6 !important;
        }
        .property-payable-row-due-soon td {
          background: #fff7e6 !important;
        }
        .property-payable-card-overdue {
          border-color: #ffccc7;
          background: #fff1f0;
        }
        .property-payable-card-pending {
          border-color: #ffe7ba;
          background: #fff7e6;
        }
        .property-payable-card-due-soon {
          border-color: #ffe7ba;
          background: #fff7e6;
        }
        .property-payable-calendar-strip {
          display: flex;
          gap: 16px;
          overflow-x: auto;
          padding-bottom: 8px;
          -webkit-overflow-scrolling: touch;
          overscroll-behavior-x: contain;
          scroll-snap-type: x mandatory;
        }
        .property-payable-calendar-strip::-webkit-scrollbar {
          height: 10px;
        }
        .property-payable-calendar-strip::-webkit-scrollbar-thumb {
          background: #d9d9d9;
          border-radius: 999px;
        }
        .property-payable-calendar-period-card {
          flex: 0 0 auto;
          width: min(1040px, calc(100vw - 112px));
          min-width: 320px;
          border: 1px solid #f0f0f0;
          border-radius: 16px;
          background: #fff;
          padding: 10px;
          scroll-snap-align: center;
        }
        .property-payable-calendar-period-card.is-current {
          border-color: #91caff;
          box-shadow: 0 0 0 2px rgba(22, 119, 255, 0.08);
        }
        .property-payable-calendar-period-heading {
          margin-bottom: 8px;
          padding: 0 4px;
          color: #262626;
          font-size: 14px;
          font-weight: 700;
        }
        .property-payable-calendar .fc {
          box-shadow: none;
        }
        .property-payable-calendar .fc-toolbar {
          display: none;
        }
        .property-payable-calendar .fc-daygrid-day-frame {
          min-height: 110px;
        }
        .property-payable-calendar .fc-event {
          cursor: pointer;
          border-radius: 10px;
          border-width: 1.5px;
          padding: 0;
          opacity: 1 !important;
        }
        .property-payable-calendar .fc-event-main {
          padding: 0;
          color: inherit !important;
        }
        .property-payable-calendar .fc-daygrid-event {
          margin-top: 4px !important;
        }
        .property-payable-calendar .fc-event-title,
        .property-payable-calendar .fc-event-time,
        .property-payable-calendar .fc-event-main-frame,
        .property-payable-calendar .fc-event-main-frame * {
          color: inherit !important;
        }
        .property-payable-event-card {
          padding: 6px 8px;
          line-height: 1.25;
          color: inherit !important;
        }
        .property-payable-event-title {
          font-size: 13px;
          font-weight: 800;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          color: inherit !important;
        }
        .property-payable-event-subtitle {
          font-size: 12px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          opacity: 1;
          color: inherit !important;
        }
        .property-payable-calendar .property-payable-event--overdue {
          background: #ffe0dc;
          border-color: #ff7875;
          color: #7f1d1d;
        }
        .property-payable-calendar .property-payable-event--due-soon {
          background: #ffefcc;
          border-color: #ffb84d;
          color: #7c4300;
        }
        .property-payable-calendar .property-payable-event--normal {
          background: #ffffff;
          border-color: #d9d9d9;
          color: #262626;
        }
        .property-payable-calendar .property-payable-event--paid {
          background: #e8f8d9;
          border-color: #95de64;
          color: #1f5f1f;
        }
      `}</style>
    </Card>
  )
}
