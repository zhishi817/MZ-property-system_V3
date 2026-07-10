"use client"

import { App, Button, Card, Col, DatePicker, Descriptions, Drawer, Empty, Form, Input, InputNumber, Modal, Popconfirm, Row, Segmented, Select, Space, Statistic, Table, Tag, Upload } from 'antd'
import { LeftOutlined, PlusOutlined, RightOutlined, UploadOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { API_BASE, authHeaders, getJSON, postJSON } from '../../../lib/api'
import { sortActivePropertiesByRegionThenCode } from '../../../lib/properties'
import {
  PROPERTY_PAYABLE_CATEGORY_OPTIONS,
  PROPERTY_PAYABLE_FIXED_DUE_DAY_OF_MONTH,
  PROPERTY_PAYABLE_FREQUENCY_OPTIONS,
  PROPERTY_PAYABLE_PAYMENT_TYPE_OPTIONS,
  PROPERTY_PAYABLE_TEMPLATE_KIND,
  canMarkPropertyPayablePaid,
  formatPropertyPayableMonthKey,
  isPropertyPayableDueSoon,
  isPropertyPayableOverdue,
  normalizePropertyPayableFrequency,
  propertyPayableCategoryLabel,
  propertyPayableFrequencyLabel,
  propertyPayablePaymentTypeLabel,
  toPropertyPayableMonthValue,
} from '../../../lib/propertyPayables'
import AuditTrail from '../../../components/AuditTrail'
import PropertyPayableVendorInput, { rememberPropertyPayableVendors } from '../../../components/PropertyPayableVendorInput'

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
  bill_expected_day_of_month?: number | null
  bill_period_start_day_of_month?: number | null
  bill_period_start_month_offset?: number | null
  bill_period_end_day_of_month?: number | null
  bill_period_end_month_offset?: number | null
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
  bill_expected_date?: string | null
  bill_received_date?: string | null
  bill_period_start?: string | null
  bill_period_end?: string | null
  paid_date?: string | null
  status?: string
  workflow_status?: string
  bill_status?: string
  payment_status?: string
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
type PropertyPayablesView = 'queue' | 'calendar' | 'paid' | 'templates'
type PropertyPayableStatusFilter = 'bill_not_received' | 'awaiting_confirmation' | 'payment_overdue' | 'payment_due_soon' | 'awaiting_payment' | 'paid'

function monthKey(d: dayjs.Dayjs) {
  return d.format('YYYY-MM')
}

function surroundingMonthKeys(d: dayjs.Dayjs) {
  return [d.subtract(1, 'month').format('YYYY-MM'), d.format('YYYY-MM'), d.add(1, 'month').format('YYYY-MM')]
}

function statusTag(row: WorkbenchRow) {
  if (row.status === 'paid') return <Tag color="green">已付</Tag>
  if (row.workflow_status === 'bill_not_received') return <Tag color="red">账单未收到</Tag>
  if (row.workflow_status === 'awaiting_bill') return <Tag color="blue">待收账单</Tag>
  if (row.workflow_status === 'payment_overdue') return <Tag color="red">付款逾期</Tag>
  if (row.workflow_status === 'payment_due_soon') return <Tag color="gold">付款快到期</Tag>
  if (isPropertyPayableOverdue(row)) return <Tag color="red">逾期</Tag>
  if (isPropertyPayableDueSoon(row)) return <Tag color="gold">快到期</Tag>
  if (!row.amount_confirmed) return <Tag>待确认金额</Tag>
  return <Tag>待付款</Tag>
}

function statusKey(row: WorkbenchRow): PropertyPayableStatusFilter | 'awaiting_bill' {
  if (row.status === 'paid') return 'paid'
  if (row.workflow_status === 'bill_not_received') return 'bill_not_received'
  if (row.workflow_status === 'awaiting_bill') return 'awaiting_bill'
  if (row.workflow_status === 'payment_overdue' || isPropertyPayableOverdue(row)) return 'payment_overdue'
  if (row.workflow_status === 'payment_due_soon' || isPropertyPayableDueSoon(row)) return 'payment_due_soon'
  if (!row.amount_confirmed) return 'awaiting_confirmation'
  return 'awaiting_payment'
}

function statusTone(row: WorkbenchRow): 'red' | 'amber' | 'blue' | 'green' | 'gray' {
  const key = statusKey(row)
  if (key === 'payment_overdue' || key === 'bill_not_received') return 'red'
  if (key === 'awaiting_confirmation' || key === 'payment_due_soon') return 'amber'
  if (key === 'awaiting_payment' || key === 'awaiting_bill') return 'blue'
  if (key === 'paid') return 'green'
  return 'gray'
}

function rowSortPriority(row: WorkbenchRow) {
  const key = statusKey(row)
  if (key === 'payment_overdue') return 0
  if (key === 'bill_not_received') return 1
  if (key === 'payment_due_soon') return 2
  if (key === 'awaiting_confirmation') return 3
  if (key === 'awaiting_bill') return 4
  if (key === 'awaiting_payment') return 5
  return 6
}

function formatMoney(value: any) {
  const n = Number(value || 0)
  return `$${Number.isFinite(n) ? n.toFixed(2) : '0.00'}`
}

function sameWorkbenchRow(a?: WorkbenchRow | null, b?: WorkbenchRow | null) {
  if (!a || !b) return false
  return String(a.template_id || '') === String(b.template_id || '') && String(a.due_date || '') === String(b.due_date || '')
}

function isDueSoon(row?: WorkbenchRow | null) {
  if (!row || row.status === 'paid' || isPropertyPayableOverdue(row) || !row.due_date) return false
  if (isPropertyPayableDueSoon(row)) return true
  if (!row.amount_confirmed) return false
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
  const [activeView, setActiveView] = useState<PropertyPayablesView>('queue')
  const [statusFilter, setStatusFilter] = useState<PropertyPayableStatusFilter | undefined>()
  const [rows, setRows] = useState<WorkbenchRow[]>([])
  const [calendarRows, setCalendarRows] = useState<WorkbenchRow[]>([])
  const [summary, setSummary] = useState({ unpaid_amount: 0, bill_not_received_count: 0, awaiting_confirmation_count: 0, overdue_count: 0, paid_amount: 0 })
  const [properties, setProperties] = useState<Property[]>([])
  const [selectedPropertyId, setSelectedPropertyId] = useState<string | undefined>()
  const [loading, setLoading] = useState(true)
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
        bill_not_received_count: Number(currentData?.summary?.bill_not_received_count || 0),
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
    () => rows
      .filter((row) => !selectedPropertyId || String(row.property_id || '') === selectedPropertyId)
      .filter((row) => !statusFilter || statusKey(row) === statusFilter),
    [rows, selectedPropertyId, statusFilter]
  )

  const filteredCalendarRows = useMemo(
    () => calendarRows
      .filter((row) => !selectedPropertyId || String(row.property_id || '') === selectedPropertyId)
      .filter((row) => !statusFilter || statusKey(row) === statusFilter),
    [calendarRows, selectedPropertyId, statusFilter]
  )

  const visibleSummary = useMemo(() => {
    if (!selectedPropertyId && !statusFilter) return summary
    return {
      unpaid_amount: filteredRows.filter((row) => row.status !== 'paid').reduce((sum, row) => sum + Number(row.amount || 0), 0),
      bill_not_received_count: filteredRows.filter((row) => row.workflow_status === 'bill_not_received').length,
      awaiting_confirmation_count: filteredRows.filter((row) => row.status !== 'paid' && !row.amount_confirmed && row.workflow_status !== 'awaiting_bill' && row.workflow_status !== 'bill_not_received').length,
      overdue_count: filteredRows.filter((row) => isPropertyPayableOverdue(row)).length,
      paid_amount: filteredRows.filter((row) => row.status === 'paid').reduce((sum, row) => sum + Number(row.amount || 0), 0),
    }
  }, [filteredRows, selectedPropertyId, statusFilter, summary])

  const sortedRows = useMemo(() => filteredRows.slice().sort((a, b) => {
    const ap = rowSortPriority(a)
    const bp = rowSortPriority(b)
    if (ap !== bp) return ap - bp
    const ad = String(a.due_date || '9999-12-31')
    const bd = String(b.due_date || '9999-12-31')
    if (ad !== bd) return ad.localeCompare(bd)
    const ar = String(a.property_code || a.property_address || '')
    const br = String(b.property_code || b.property_address || '')
    if (ar !== br) return ar.localeCompare(br)
    return String(a.vendor || '').localeCompare(String(b.vendor || ''))
  }), [filteredRows])

  const queueGroups = useMemo(() => [
    { key: 'payment_overdue', title: '付款逾期', rows: sortedRows.filter((row) => statusKey(row) === 'payment_overdue'), tone: 'red' },
    { key: 'bill_not_received', title: '账单未收到', rows: sortedRows.filter((row) => statusKey(row) === 'bill_not_received'), tone: 'red' },
    { key: 'awaiting_confirmation', title: '待确认账单', rows: sortedRows.filter((row) => statusKey(row) === 'awaiting_confirmation' || statusKey(row) === 'awaiting_bill'), tone: 'amber' },
    { key: 'payment_due_soon', title: '付款快到期', rows: sortedRows.filter((row) => statusKey(row) === 'payment_due_soon'), tone: 'amber' },
    { key: 'awaiting_payment', title: '待付款', rows: sortedRows.filter((row) => statusKey(row) === 'awaiting_payment'), tone: 'blue' },
  ], [sortedRows])

  const paidRows = useMemo(() => sortedRows.filter((row) => row.status === 'paid'), [sortedRows])

  const templateRows = useMemo(() => {
    const seen = new Map<string, WorkbenchRow>()
    for (const row of rows) {
      if (selectedPropertyId && String(row.property_id || '') !== selectedPropertyId) continue
      if (!seen.has(row.template_id)) seen.set(row.template_id, row)
    }
    return Array.from(seen.values()).sort((a, b) => {
      const ap = String(a.property_code || a.property_address || '')
      const bp = String(b.property_code || b.property_address || '')
      if (ap !== bp) return ap.localeCompare(bp)
      return String(a.vendor || '').localeCompare(String(b.vendor || ''))
    })
  }, [rows, selectedPropertyId])

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
          const apx = rowSortPriority(a)
          const bpx = rowSortPriority(b)
          if (apx !== bpx) return apx - bpx
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

  const calendarDays = useMemo(() => {
    const first = month.startOf('month')
    const offset = (first.day() + 6) % 7
    const start = first.subtract(offset, 'day')
    return Array.from({ length: 42 }, (_, index) => start.add(index, 'day'))
  }, [month])

  useEffect(() => {
    const preferred = month.isSame(dayjs(), 'month') ? dayjs().format('YYYY-MM-DD') : month.startOf('month').format('YYYY-MM-DD')
    setSelectedDay((prev) => {
      if (prev && prev.slice(0, 7) === selectedMonthKey) return prev
      return preferred
    })
  }, [month, selectedMonthKey])

  function openConfirm(row: WorkbenchRow) {
    setConfirmingRow(row)
    confirmForm.setFieldsValue({
      amount: Number(row.amount || 0),
      bill_received_date: row.bill_received_date ? dayjs(row.bill_received_date) : dayjs(),
      note: row.note || '',
    })
    setConfirmOpen(true)
  }

  async function saveConfirmedAmount() {
    if (!confirmingRow) return
    const values = await confirmForm.validateFields()
    setConfirmSaving(true)
    try {
      await postJSON(`/recurring/payments/${confirmingRow.template_id}/confirm-bill`, {
        month_key: workbenchMonthKey(confirmingRow, selectedMonthKey),
        amount: Number(values.amount || 0),
        bill_received_date: values.bill_received_date ? dayjs(values.bill_received_date).format('YYYY-MM-DD') : undefined,
        note: values.note || undefined,
      })
      message.success('本月账单信息已确认')
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
      due_day_of_month: PROPERTY_PAYABLE_FIXED_DUE_DAY_OF_MONTH,
      bill_expected_day_of_month: row?.bill_expected_day_of_month == null ? undefined : Number(row.bill_expected_day_of_month || 0),
      bill_period_start_month_offset: 0,
      bill_period_start_day_of_month: undefined,
      bill_period_end_month_offset: 0,
      bill_period_end_day_of_month: undefined,
      frequency_months: normalizePropertyPayableFrequency(row?.frequency_months),
      remind_days_before: 3,
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
      due_day_of_month: PROPERTY_PAYABLE_FIXED_DUE_DAY_OF_MONTH,
      bill_expected_day_of_month: values.bill_expected_day_of_month == null ? null : Number(values.bill_expected_day_of_month || 0),
      bill_period_start_month_offset: 0,
      bill_period_start_day_of_month: undefined,
      bill_period_end_month_offset: 0,
      bill_period_end_day_of_month: undefined,
      frequency_months: normalizePropertyPayableFrequency(values.frequency_months),
      remind_days_before: 3,
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
      rememberPropertyPayableVendors(body.vendor)
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

  async function deleteTemplate(row: WorkbenchRow) {
    try {
      const resp = await fetch(`${API_BASE}/recurring/payments/${row.template_id}`, {
        method: 'DELETE',
        headers: authHeaders(),
      })
      const json = await resp.json().catch(() => ({}))
      if (!resp.ok) throw new Error(json?.message || `HTTP ${resp.status}`)
      message.success('模板已删除')
      if (detailRow?.template_id === row.template_id) {
        setDetailOpen(false)
        setDetailRow(null)
      }
      await loadWorkbench()
    } catch (e: any) {
      message.error(e?.message || '删除模板失败')
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
  }

  function shiftCalendar(step: number) {
    setMonth((prev) => prev.add(step, 'month'))
  }

  const statusFilterOptions = [
    { value: 'payment_overdue', label: '付款逾期' },
    { value: 'bill_not_received', label: '账单未收到' },
    { value: 'awaiting_confirmation', label: '待确认账单' },
    { value: 'payment_due_soon', label: '付款快到期' },
    { value: 'awaiting_payment', label: '待付款' },
    { value: 'paid', label: '已付' },
  ]

  const columns = [
    { title: '房源', key: 'property', render: (_: any, row: WorkbenchRow) => row.property_code || row.property_address || '-' },
    { title: '收费公司/事项', dataIndex: 'vendor' },
    { title: '类别', dataIndex: 'category', render: (v: string) => propertyPayableCategoryLabel(v) },
    { title: '本月金额', dataIndex: 'amount', render: (v: number) => `$${Number(v || 0).toFixed(2)}` },
    { title: '预计收到账单日', dataIndex: 'bill_expected_date', render: (v: string) => v || '-' },
    { title: '实际收到账单日', dataIndex: 'bill_received_date', render: (v: string) => v || '-' },
    { title: '付款截止日', dataIndex: 'due_date', render: (v: string) => v || '-' },
    { title: '状态', key: 'status', render: (_: any, row: WorkbenchRow) => statusTag(row) },
    { title: '确认人', dataIndex: 'amount_confirmed_by', render: (v: string, row: WorkbenchRow) => row.amount_confirmed ? (v || '-') : '-' },
    { title: '付款人', dataIndex: 'paid_by', render: (v: string) => v || '-' },
    {
      title: '操作',
      key: 'ops',
      render: (_: any, row: WorkbenchRow) => (
        <Space wrap>
          <Button onClick={() => { setDetailRow(row); setDetailOpen(true) }}>详情</Button>
          <Button onClick={() => openTemplate(row)}>编辑模板</Button>
          <Button onClick={() => openConfirm(row)} disabled={row.status === 'paid'}>调整本月账单</Button>
          <Button onClick={() => openInvoices(row)} disabled={!row.snapshot_id}>上传本月支出发票</Button>
          {row.status === 'paid'
            ? <Button onClick={() => unmarkPaid(row)}>取消已付</Button>
            : <Button type="primary" onClick={() => markPaid(row)} disabled={!canMarkPropertyPayablePaid(row)}>已付</Button>}
          <Popconfirm
            title="删除代付模板？"
            description="会停止后续自动生成，并清理本月未付和未来账单；历史已付记录会保留。"
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => deleteTemplate(row)}
          >
            <Button danger>删除模板</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  const renderRowActions = (row: WorkbenchRow, compact = false) => (
    <Space wrap size={compact ? 6 : 8}>
      <Button size={compact ? 'small' : 'middle'} onClick={() => { setDetailRow(row); setDetailOpen(true) }}>详情</Button>
      {!compact ? <Button onClick={() => openTemplate(row)}>编辑模板</Button> : null}
      <Button size={compact ? 'small' : 'middle'} onClick={() => openConfirm(row)} disabled={row.status === 'paid'}>{compact ? '确认账单' : '调整本月账单'}</Button>
      <Button size={compact ? 'small' : 'middle'} onClick={() => openInvoices(row)} disabled={!row.snapshot_id}>上传发票</Button>
      {row.status === 'paid'
        ? <Button size={compact ? 'small' : 'middle'} onClick={() => unmarkPaid(row)}>取消已付</Button>
        : <Button size={compact ? 'small' : 'middle'} type="primary" onClick={() => markPaid(row)} disabled={!canMarkPropertyPayablePaid(row)}>登记支付</Button>}
    </Space>
  )

  const renderBillCard = (row: WorkbenchRow, mode: 'queue' | 'detail' = 'queue') => {
    const tone = statusTone(row)
    return (
      <Card
        key={`${row.template_id}:${row.due_date || selectedMonthKey}:${mode}`}
        size="small"
        className={`property-payable-work-card property-payable-work-card--${tone}`}
      >
        <div className="property-payable-work-card-head">
          <div>
            <div className="property-payable-work-room">{row.property_code || row.property_address || '-'}</div>
            <div className="property-payable-work-vendor">{row.vendor || '-'} · {propertyPayableCategoryLabel(row.category || '')}</div>
          </div>
          <div className="property-payable-work-amount">{row.amount_confirmed || row.status === 'paid' ? formatMoney(row.amount) : '待确认'}</div>
        </div>
        <Descriptions size="small" column={2} className="property-payable-work-meta">
          <Descriptions.Item label="付款截止日">{row.due_date || '-'}</Descriptions.Item>
          <Descriptions.Item label="状态">{statusTag(row)}</Descriptions.Item>
          <Descriptions.Item label="预计收到账单">{row.bill_expected_date || '-'}</Descriptions.Item>
          <Descriptions.Item label="实际收到账单">{row.bill_received_date || '-'}</Descriptions.Item>
          {mode === 'detail' ? <Descriptions.Item label="付款方式" span={2}>{propertyPayablePaymentTypeLabel(row.payment_type || '')}</Descriptions.Item> : null}
        </Descriptions>
        {renderRowActions(row, true)}
      </Card>
    )
  }

  const renderCalendarDay = (day: dayjs.Dayjs) => {
    const dateISO = day.format('YYYY-MM-DD')
    const dayRows = rowsByDueDate.get(dateISO) || []
    const inMonth = day.isSame(month, 'month')
    const selected = selectedDay === dateISO
    const visible = dayRows.slice(0, 3)
    return (
      <button
        key={dateISO}
        type="button"
        className={`property-payable-month-day${inMonth ? '' : ' is-muted'}${selected ? ' is-selected' : ''}`}
        onClick={() => openDay(dateISO)}
      >
        <span className="property-payable-month-date">
          <span>{day.date()}</span>
          {dayRows.length ? <span className="property-payable-month-count">{dayRows.length}</span> : null}
        </span>
        <span className="property-payable-month-events">
          {visible.map((row) => (
            <span key={`${row.template_id}:${row.due_date}`} className={`property-payable-month-pill property-payable-month-pill--${statusTone(row)}`}>
              {row.property_code || row.property_address || '-'}
            </span>
          ))}
          {dayRows.length > visible.length ? <span className="property-payable-month-more">+{dayRows.length - visible.length} more</span> : null}
        </span>
      </button>
    )
  }

  return (
    <Card
      className="property-payables-page"
      title="房源代付"
      extra={
        <div className="property-payables-header-actions">
          <Button icon={<LeftOutlined />} onClick={() => shiftCalendar(-1)}>
            {month.subtract(1, 'month').format('YYYY-MM')}
          </Button>
          <Button onClick={() => setMonth(dayjs())}>{selectedMonthKey}</Button>
          <Button onClick={() => shiftCalendar(1)}>
            {month.add(1, 'month').format('YYYY-MM')} <RightOutlined />
          </Button>
          <Select
            allowClear
            showSearch
            value={selectedPropertyId}
            placeholder="全部房源"
            options={propertyOptions}
            onChange={(value) => setSelectedPropertyId(value || undefined)}
            filterOption={(input, option) => String((option as any)?.searchText || (option as any)?.label || '').includes(input.trim().toLowerCase())}
            notFoundContent="没有匹配的房源"
            className="property-payables-header-select property-payables-header-select--property"
          />
          <Select
            allowClear
            value={statusFilter}
            placeholder="全部状态"
            onChange={(value) => setStatusFilter(value || undefined)}
            options={statusFilterOptions}
            className="property-payables-header-select"
          />
          <Button type="primary" icon={<PlusOutlined />} onClick={() => openTemplate(null)}>新增代付模板</Button>
        </div>
      }
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <div className="property-payables-metrics">
          <Card><Statistic title="本月待付金额" prefix="$" precision={2} value={visibleSummary.unpaid_amount} /></Card>
          <Card><Statistic title="账单未收到" value={visibleSummary.bill_not_received_count} valueStyle={{ color: visibleSummary.bill_not_received_count ? '#cf1322' : undefined }} /></Card>
          <Card><Statistic title="待确认账单" value={visibleSummary.awaiting_confirmation_count} valueStyle={{ color: visibleSummary.awaiting_confirmation_count ? '#fa8c16' : undefined }} /></Card>
          <Card><Statistic title="付款逾期" value={visibleSummary.overdue_count} valueStyle={{ color: visibleSummary.overdue_count ? '#cf1322' : undefined }} /></Card>
          <Card><Statistic title="本月已付金额" prefix="$" precision={2} value={visibleSummary.paid_amount} /></Card>
        </div>

        <Card bodyStyle={{ padding: 0 }} className="property-payables-workbench-card">
          <div className="property-payables-workbench-tabs">
            <Segmented
              value={activeView}
              onChange={(value) => setActiveView(value as PropertyPayablesView)}
              options={[
                { label: '待处理', value: 'queue' },
                { label: '日历', value: 'calendar' },
                { label: '已付记录', value: 'paid' },
                { label: '模板管理', value: 'templates' },
              ]}
            />
            <span className="property-payables-workbench-hint">单月日历，无横向拖动；点击日期后在右侧处理当天账单。</span>
          </div>

          {activeView === 'queue' || activeView === 'calendar' ? (
            <div className={`property-payables-workbench property-payables-workbench--${activeView}`}>
              {activeView === 'queue' ? (
                <section className="property-payables-panel property-payables-queue-panel">
                  <div className="property-payables-panel-header">
                    <div>
                      <strong>处理队列</strong>
                      <span>按业务优先级排序</span>
                    </div>
                    <Tag color="red">{sortedRows.filter((row) => row.status !== 'paid').length} 待处理</Tag>
                  </div>
                  <div className="property-payables-panel-scroll">
                    {queueGroups.some((group) => group.rows.length) ? queueGroups.map((group) => group.rows.length ? (
                      <div className="property-payables-queue-group" key={group.key}>
                        <div className="property-payables-queue-title">
                          <span>{group.title}</span>
                          <Tag color={group.tone === 'red' ? 'red' : group.tone === 'amber' ? 'gold' : 'blue'}>{group.rows.length}</Tag>
                        </div>
                        {group.rows.map((row) => renderBillCard(row))}
                      </div>
                    ) : null) : <Empty description="当前筛选下没有待处理账单" />}
                  </div>
                </section>
              ) : null}

              <section className="property-payables-panel property-payables-calendar-panel">
                <div className="property-payables-panel-header">
                  <div>
                    <strong>{month.format('YYYY 年 MM 月')}</strong>
                    <span>只显示当前月，避免滑动和页面滚动冲突</span>
                  </div>
                  <Space>
                    <Button onClick={() => shiftCalendar(-1)}>‹</Button>
                    <Button onClick={() => setMonth(dayjs())}>本月</Button>
                    <Button onClick={() => shiftCalendar(1)}>›</Button>
                  </Space>
                </div>
                <div className="property-payables-calendar-shell">
                  <div className="property-payables-weekdays">
                    {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((item) => <div key={item}>{item}</div>)}
                  </div>
                  <div className="property-payables-month-grid">
                    {calendarDays.map(renderCalendarDay)}
                  </div>
                </div>
              </section>

              <aside className="property-payables-panel property-payables-day-panel">
                <div className="property-payables-panel-header">
                  <div>
                    <strong>{selectedDay || '选择日期'}</strong>
                    <span>当天付款截止账单</span>
                  </div>
                  <Tag color={selectedDayRows.length ? 'red' : undefined}>{selectedDayRows.length}</Tag>
                </div>
                <div className="property-payables-panel-scroll">
                  {selectedDayRows.length ? selectedDayRows.map((row) => renderBillCard(row, 'detail')) : <Empty description="当天没有付款截止账单" />}
                </div>
              </aside>
            </div>
          ) : null}

          {activeView === 'paid' ? (
            <div className="property-payables-table-panel">
              <Table
                rowKey={(row) => `${row.template_id}:${row.due_date || selectedMonthKey}:paid`}
                columns={columns as any}
                dataSource={paidRows}
                loading={loading}
                pagination={{ pageSize: 20 }}
              />
            </div>
          ) : null}

          {activeView === 'templates' ? (
            <div className="property-payables-table-panel">
              <Table
                rowKey={(row) => row.template_id}
                dataSource={templateRows}
                loading={loading}
                pagination={{ pageSize: 20 }}
                columns={[
                  { title: '房源', key: 'property', render: (_: any, row: WorkbenchRow) => row.property_code || row.property_address || '-' },
                  { title: '收费公司/事项', dataIndex: 'vendor' },
                  { title: '类别', dataIndex: 'category', render: (v: string) => propertyPayableCategoryLabel(v) },
                  { title: '默认金额', dataIndex: 'amount', render: (v: number) => formatMoney(v) },
                  { title: '账单周期', dataIndex: 'frequency_months', render: (v: number) => propertyPayableFrequencyLabel(v) },
                  { title: '预计收到账单日', dataIndex: 'bill_expected_day_of_month', render: (v: number) => v ? `账单月 ${v} 号` : '-' },
                  { title: '付款截止日', dataIndex: 'due_day_of_month', render: () => `账单月 ${PROPERTY_PAYABLE_FIXED_DUE_DAY_OF_MONTH} 号` },
                  {
                    title: '操作',
                    key: 'ops',
                    render: (_: any, row: WorkbenchRow) => (
                      <Space wrap>
                        <Button onClick={() => { setDetailRow(row); setDetailOpen(true) }}>详情</Button>
                        <Button onClick={() => openTemplate(row)}>编辑模板</Button>
                        <Popconfirm
                          title="删除代付模板？"
                          description="会停止后续自动生成，并清理本月未付和未来账单；历史已付记录会保留。"
                          okText="删除"
                          cancelText="取消"
                          okButtonProps={{ danger: true }}
                          onConfirm={() => deleteTemplate(row)}
                        >
                          <Button danger>删除模板</Button>
                        </Popconfirm>
                      </Space>
                    ),
                  },
                ] as any}
              />
            </div>
          ) : null}
        </Card>
      </Space>

      <Drawer
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        width={760}
        title="代付详情"
        extra={detailRow ? (
          <Space wrap>
            <Button onClick={() => openTemplate(detailRow)}>编辑模板</Button>
            <Button onClick={() => openConfirm(detailRow)} disabled={detailRow.status === 'paid'}>调整本月账单</Button>
            <Button onClick={() => openInvoices(detailRow)} disabled={!detailRow.snapshot_id}>上传本月支出发票</Button>
            {detailRow.status === 'paid'
              ? <Button onClick={() => unmarkPaid(detailRow)}>取消已付</Button>
              : <Button type="primary" onClick={() => markPaid(detailRow)} disabled={!canMarkPropertyPayablePaid(detailRow)}>登记支付</Button>}
            <Popconfirm
              title="删除代付模板？"
              description="会停止后续自动生成，并清理本月未付和未来账单；历史已付记录会保留。"
              okText="删除"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              onConfirm={() => deleteTemplate(detailRow)}
            >
              <Button danger>删除模板</Button>
            </Popconfirm>
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
              <Descriptions.Item label="付款截止日">{detailRow.due_date || '-'}</Descriptions.Item>
              <Descriptions.Item label="预计收到账单日">{detailRow.bill_expected_date || '-'}</Descriptions.Item>
              <Descriptions.Item label="实际收到账单日">{detailRow.bill_received_date || '-'}</Descriptions.Item>
              <Descriptions.Item label="状态">{statusTag(detailRow)}</Descriptions.Item>
              <Descriptions.Item label="模板状态">{detailRow.template_status === 'paused' ? '已暂停' : '启用中'}</Descriptions.Item>
              <Descriptions.Item label="模板起始月份">{detailRow.start_month_key || '-'}</Descriptions.Item>
              <Descriptions.Item label="账单周期">{propertyPayableFrequencyLabel(detailRow.frequency_months)}</Descriptions.Item>
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
        title="确认本月账单信息（仅修改本月快照）"
        extra={<Button type="primary" loading={confirmSaving} onClick={saveConfirmedAmount}>保存并确认账单</Button>}
      >
        <Form form={confirmForm} layout="vertical">
          <Card size="small" style={{ marginBottom: 16 }}>
            这里只会更新当前账单月份快照的实际收到账单日期、金额和备注，不会改动代付模板；付款截止日固定为账单月 {PROPERTY_PAYABLE_FIXED_DUE_DAY_OF_MONTH} 号。
          </Card>
          <Form.Item name="bill_received_date" label="实际收到账单日期" rules={[{ required: true, message: '请选择收到账单日期' }]}>
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="amount" label="本月实际金额" rules={[{ required: true, message: '请输入金额' }]}>
            <InputNumber min={0} step={0.01} style={{ width: '100%' }} />
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
              <Form.Item name="frequency_months" label="账单周期" initialValue={1}>
                <Select options={PROPERTY_PAYABLE_FREQUENCY_OPTIONS.map((item) => ({ value: item.value, label: item.label }))} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="bill_expected_day_of_month" label="预计收到账单日">
                <InputNumber min={1} max={31} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label="付款截止日">
                <Input value={`账单月 ${PROPERTY_PAYABLE_FIXED_DUE_DAY_OF_MONTH} 号`} disabled />
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

    </Card>
  )
}
