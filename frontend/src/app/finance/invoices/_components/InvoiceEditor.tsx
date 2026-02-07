"use client"

import { useEffect, useMemo, useRef, useState } from 'react'
import { App, Button, Card, Checkbox, Col, Collapse, DatePicker, Divider, Form, Grid, Input, InputNumber, Modal, Popconfirm, Row, Select, Space, Steps, Table, Tag, Tooltip } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import dayjs from 'dayjs'
import { useRouter } from 'next/navigation'
import { PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons'
import { API_BASE, authHeaders, getJSON, patchJSON, postJSON } from '../../../../lib/api'
import { hasPerm } from '../../../../lib/auth'
import { buildInvoicePayload } from '../../../../lib/invoicePayload'
import { canBackendAutosaveDraft, computeLine, computeTotals, extractDiscount, normalizeLineItemsForSave, stableHash, type GstType } from '../../../../lib/invoiceEditorModel'
import styles from './InvoiceEditor.module.css'

type Company = {
  id: string
  code?: string
  legal_name: string
  trading_name?: string
  abn: string
  logo_url?: string
  status?: string
  is_default?: boolean
  bank_account_name?: string
  bank_bsb?: string
  bank_account_no?: string
  payment_note?: string
  address_line1?: string
  address_line2?: string
  address_city?: string
  address_state?: string
  address_postcode?: string
  address_country?: string
  phone?: string
  email?: string
}

type InvoiceDetail = {
  id: string
  company_id: string
  invoice_type?: string
  invoice_no?: string
  status?: string
  issue_date?: string
  due_date?: string
  valid_until?: string
  currency?: string
  customer_id?: string
  bill_to_name?: string
  bill_to_email?: string
  bill_to_phone?: string
  bill_to_abn?: string
  bill_to_address?: string
  payment_method?: string
  payment_method_note?: string
  paid_at?: string
  notes?: string
  terms?: string
  subtotal?: number
  tax_total?: number
  total?: number
  amount_paid?: number
  amount_due?: number
  created_at?: string
  updated_at?: string
  company?: Company
  line_items?: any[]
  files?: any[]
}

function fmtMoney(n: any) {
  const x = Number(n || 0)
  const v = Number.isFinite(x) ? x : 0
  return `$${v.toFixed(2)}`
}

function statusTag(s: string) {
  const v = String(s || 'draft')
  if (v === 'draft') return <Tag>draft</Tag>
  if (v === 'issued') return <Tag color="blue">issued</Tag>
  if (v === 'sent') return <Tag color="gold">sent</Tag>
  if (v === 'paid') return <Tag color="green">paid</Tag>
  if (v === 'void') return <Tag color="red">void</Tag>
  if (v === 'refunded') return <Tag color="purple">refunded</Tag>
  return <Tag>{v}</Tag>
}

function normalizeDraftDates(values: any) {
  const v = { ...(values || {}) }
  const a = v.issue_date
  const b = v.due_date
  const c = v.valid_until
  if (typeof a === 'string' && a) v.issue_date = dayjs(a)
  if (typeof b === 'string' && b) v.due_date = dayjs(b)
  if (typeof c === 'string' && c) v.valid_until = dayjs(c)
  return v
}

function splitItemDesc(raw: any) {
  const s0 = String(raw || '').replace(/\r\n/g, '\n').trim()
  if (!s0) return { title: '', content: '' }
  const parts = s0.split('\n')
  const title = String(parts.shift() || '').trim()
  const content = parts.join('\n').trim()
  return { title, content }
}

function joinItemDesc(title: any, content: any) {
  const t = String(title || '').trim()
  const c = String(content || '').trim()
  if (!t && !c) return ''
  if (!c) return t
  if (!t) return c
  return `${t}\n${c}`
}

export function InvoiceEditor(props: { mode: 'new' | 'edit'; invoiceId?: string }) {
  const { mode } = props
  const router = useRouter()
  const { message } = App.useApp()
  const screens = Grid.useBreakpoint()
  const isMobile = !screens.md

  const [companies, setCompanies] = useState<Company[]>([])
  const [loading, setLoading] = useState(() => mode === 'edit')
  const [saving, setSaving] = useState(false)
  const [autosaving, setAutosaving] = useState(false)
  const [invoiceId, setInvoiceId] = useState<string | null>(props.invoiceId || null)
  const [invoice, setInvoice] = useState<InvoiceDetail | null>(null)
  const status = String(invoice?.status || 'draft')
  const lineItemsLocked = mode === 'edit' && status !== 'draft'
  const [discountAmount, setDiscountAmount] = useState<number>(0)
  const [savedCustomers, setSavedCustomers] = useState<Array<{ id: string; name?: string; email?: string; phone?: string; abn?: string; address?: string }>>([])
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | undefined>(undefined)
  const [saveAsCommonCustomer, setSaveAsCommonCustomer] = useState(false)
  const [auditRows, setAuditRows] = useState<any[]>([])
  const [sendLogs, setSendLogs] = useState<any[]>([])
  const [paymentEvents, setPaymentEvents] = useState<any[]>([])
  const [formVersion, setFormVersion] = useState(0)

  const [form] = Form.useForm()
  const lastSavedHashRef = useRef<string>('')
  const lineItems = Form.useWatch('line_items', form) as any[] | undefined
  const invoiceType = String(Form.useWatch('invoice_type', form) || 'invoice')
  const watchedIssueDate = Form.useWatch('issue_date', form)
  const watchedValidUntil = Form.useWatch('valid_until', form)
  const canSwitchInvoiceType = hasPerm('invoice.type.switch')
  const [itemModalOpen, setItemModalOpen] = useState(false)
  const [itemModalIndex, setItemModalIndex] = useState<number | null>(null)
  const [itemModalForm] = Form.useForm()
  function setLineItems(next: any[]) {
    form.setFieldsValue({ line_items: next })
    setFormVersion(v => v + 1)
  }

  const companyOptions = useMemo(() => companies.map(c => ({ value: c.id, label: `${c.code || 'INV'} · ${c.legal_name} (${c.abn})` })), [companies])
  const companyById = useMemo(() => {
    const m: Record<string, Company> = {}
    companies.forEach(c => { m[String(c.id)] = c })
    return m
  }, [companies])

  async function loadCompanies() {
    try {
      const rows = await getJSON<Company[]>('/invoices/companies')
      setCompanies(rows || [])
    } catch {
    }
  }

  async function loadSavedCustomers() {
    try {
      const rows = await getJSON<any[]>('/invoices/customers')
      const list = Array.isArray(rows) ? rows : []
      setSavedCustomers(list.filter((x: any) => String(x?.status || 'active') === 'active').map((x: any) => ({
        id: String(x?.id || ''),
        name: String(x?.name || '') || undefined,
        email: String(x?.email || '') || undefined,
        phone: String(x?.phone || '') || undefined,
        abn: String(x?.abn || '') || undefined,
        address: String(x?.address || '') || undefined,
      })).filter((x: any) => x.id))
    } catch {
      setSavedCustomers([])
    }
  }

  async function loadInvoice(id: string) {
    setLoading(true)
    try {
      const j = await getJSON<any>(`/invoices/${id}`)
      setInvoice(j)
      const extracted = extractDiscount(j.line_items || [])
      setDiscountAmount(Number(extracted.discount_amount || 0))
      form.setFieldsValue({
        company_id: j.company_id,
        invoice_type: j.invoice_type || 'invoice',
        currency: j.currency || 'AUD',
        invoice_no: j.invoice_no || '',
        issue_date: j.issue_date ? dayjs(j.issue_date) : null,
        due_date: j.due_date ? dayjs(j.due_date) : null,
        valid_until: j.valid_until ? dayjs(j.valid_until) : null,
        customer_id: j.customer_id || '',
        bill_to_name: j.bill_to_name || '',
        bill_to_email: j.bill_to_email || '',
        bill_to_phone: j.bill_to_phone || '',
        bill_to_abn: j.bill_to_abn || '',
        bill_to_address: j.bill_to_address || '',
        payment_method: j.payment_method || '',
        payment_method_note: j.payment_method_note || '',
        notes: j.notes || '',
        terms: j.terms || '',
        line_items: (extracted.user_items || []).map((x: any) => ({
          description: x.description,
          quantity: Number(x.quantity || 0),
          unit_price: Number(x.unit_price || 0),
          gst_type: (x.gst_type || 'GST_10') as GstType,
        })),
      })
      setSelectedCustomerId(j.customer_id ? String(j.customer_id) : undefined)
      setSaveAsCommonCustomer(false)
      const base = form.getFieldsValue(true)
      lastSavedHashRef.current = stableHash({ ...base, discountAmount: Number(extracted.discount_amount || 0) })
      try {
        const raw = window.localStorage.getItem(`invoice:draft:${id}`)
        if (raw) {
          const parsed = JSON.parse(raw)
          const draftAt = Number(parsed?.updatedAt || 0)
          const serverAt = j?.updated_at ? new Date(String(j.updated_at)).getTime() : 0
          if (draftAt && draftAt > serverAt + 30000 && parsed?.values) {
            Modal.confirm({
              title: '发现未保存的草稿',
              content: '检测到本地有更新的草稿内容，是否恢复？',
              okText: '恢复',
              cancelText: '忽略',
              onOk() {
                try {
                  form.setFieldsValue(normalizeDraftDates(parsed.values))
                  if (parsed.discountAmount != null) setDiscountAmount(Number(parsed.discountAmount || 0))
                  setFormVersion(v => v + 1)
                  message.success('已恢复草稿')
                } catch {
                }
              }
            })
          }
        }
      } catch {
      }
    } catch (e: any) {
      message.error(String(e?.message || '加载失败'))
    } finally {
      setLoading(false)
    }
  }

  async function loadAudits(id: string) {
    try {
      const rows = await getJSON<any[]>(`/audits?entity=Invoice&entity_id=${encodeURIComponent(id)}`)
      setAuditRows(Array.isArray(rows) ? rows : [])
    } catch {
      setAuditRows([])
    }
  }

  async function loadSendLogs(id: string) {
    try {
      const rows = await getJSON<any[]>(`/invoices/${id}/send-logs`)
      setSendLogs(Array.isArray(rows) ? rows : [])
    } catch {
      setSendLogs([])
    }
  }

  async function loadPaymentHistory(id: string) {
    try {
      const rows = await getJSON<any[]>(`/invoices/${id}/payment-history`)
      setPaymentEvents(Array.isArray(rows) ? rows : [])
    } catch {
      setPaymentEvents([])
    }
  }

  function buildPayload(values: any, status: string) {
    return buildInvoicePayload(values, status, discountAmount)
  }

  async function saveCustomerIfNeeded(params?: { silent?: boolean; fromAutosave?: boolean }) {
    try {
      if (!saveAsCommonCustomer) return null
      if (params?.fromAutosave) return null
      const name = String(form.getFieldValue('bill_to_name') || '').trim()
      const email = String(form.getFieldValue('bill_to_email') || '').trim()
      const phone = String(form.getFieldValue('bill_to_phone') || '').trim()
      const abn = String(form.getFieldValue('bill_to_abn') || '').trim()
      const address = String(form.getFieldValue('bill_to_address') || '').trim()
      if (!name) { message.warning('请先填写客户姓名再保存为常用客户'); return null }
      const created = await postJSON<any>('/invoices/customers', { name, email: email || undefined, phone: phone || undefined, abn: abn || undefined, address: address || undefined })
      const id = String(created?.id || '')
      if (!id) return null
      form.setFieldsValue({ customer_id: id })
      setSelectedCustomerId(id)
      setSaveAsCommonCustomer(false)
      await loadSavedCustomers()
      if (!params?.silent) message.success('已保存为常用客户')
      return id
    } catch (e: any) {
      if (!params?.silent) message.error(String(e?.message || '保存常用客户失败'))
      return null
    }
  }

  async function saveDraft(params?: { silent?: boolean; fromAutosave?: boolean }): Promise<string | null> {
    await saveCustomerIfNeeded(params)
    const values = form.getFieldsValue(true)
    const status = String(invoice?.status || 'draft')
    const payload = buildPayload(values, status)
    const hash = stableHash({ ...values, discountAmount })
    const shouldMarkPaidAfterSave = invoiceType === 'receipt' && !params?.fromAutosave
    try {
      try {
        const k = invoiceId ? `invoice:draft:${invoiceId}` : 'invoice:draft:new'
        window.localStorage.setItem(k, JSON.stringify({ values, discountAmount, updatedAt: Date.now() }))
      } catch {
      }

      if (status === 'draft') {
        if (!canBackendAutosaveDraft({ company_id: (payload as any).company_id, line_items: values.line_items })) {
          if (!params?.silent && !params?.fromAutosave) message.warning('请先填写开票主体与至少 1 条项目描述再保存草稿')
          return invoiceId
        }
      }

      if (params?.fromAutosave && hash === lastSavedHashRef.current) return invoiceId

      if (!invoiceId) {
        const created = await postJSON<any>('/invoices', payload)
        setInvoiceId(created.id)
        lastSavedHashRef.current = hash
        if (!params?.silent) message.success('草稿已保存')
        router.replace(`/finance/invoices/${created.id}`)
        if (shouldMarkPaidAfterSave) {
          const method = String(form.getFieldValue('payment_method') || '').trim()
          if (method) {
            try {
              const row = await postJSON<any>(`/invoices/${created.id}/mark-paid`, { payment_method: method })
              setInvoice(row)
              await loadInvoice(created.id)
              await loadAudits(created.id)
              await loadPaymentHistory(created.id)
            } catch (e: any) {
              if (!params?.silent) message.error(String(e?.message || '标记已收款失败'))
            }
          }
        }
        return created.id
      }
      const updated = await patchJSON<any>(`/invoices/${invoiceId}`, payload)
      lastSavedHashRef.current = hash
      if (!params?.silent) message.success('草稿已保存')
      if (invoiceId) {
        await loadInvoice(invoiceId)
        await loadAudits(invoiceId)
        await loadPaymentHistory(invoiceId)
      }
      setInvoice(prev => prev ? { ...prev, ...updated } : prev)
      if (shouldMarkPaidAfterSave && invoiceId) {
        const st = String(invoice?.status || 'draft')
        if (st !== 'paid') {
          const method = String(form.getFieldValue('payment_method') || '').trim()
          if (method) {
            try {
              const row = await postJSON<any>(`/invoices/${invoiceId}/mark-paid`, { payment_method: method })
              setInvoice(row)
              await loadInvoice(invoiceId)
              await loadAudits(invoiceId)
              await loadPaymentHistory(invoiceId)
            } catch (e: any) {
              if (!params?.silent) message.error(String(e?.message || '标记已收款失败'))
            }
          }
        }
      }
      return invoiceId
    } catch (e: any) {
      if (!params?.silent) message.error(String(e?.message || '保存失败'))
      return invoiceId
    }
  }

  async function submitPrimary() {
    const status = String(invoice?.status || (mode === 'new' ? 'draft' : ''))
    if (!hasPerm('invoice.issue') && status === 'draft') { message.error('无权限提交'); return }
    setSaving(true)
    try {
      await form.validateFields()
      const id = (await saveDraft({ silent: true })) || invoiceId
      if (!id) return
      const latest = await getJSON<any>(`/invoices/${id}`)
      setInvoice(latest)
      if (String(latest.status || '') === 'draft') {
        await postJSON<any>(`/invoices/${id}/issue`, {})
      }
      await loadInvoice(id)
      await loadAudits(id)
      message.success('已提交')
      try { router.push(`/finance/invoices/${id}/preview`) } catch {}
    } catch (e: any) {
      message.error(String(e?.message || '提交失败'))
    } finally {
      setSaving(false)
    }
  }

  const derived = useMemo(() => {
    const v = form.getFieldsValue(true)
    const items = normalizeLineItemsForSave({ user_items: (v.line_items || []) as any, discount_amount: discountAmount })
    const lines = items.map((x) => ({ ...computeLine({ quantity: x.quantity, unit_price: x.unit_price, gst_type: x.gst_type }) }))
    return { items, totals: computeTotals(lines as any, Number(invoice?.amount_paid || 0)) }
  }, [form, formVersion, discountAmount, invoice?.amount_paid, invoice?.line_items, invoice?.updated_at])

  const gstModeLabel = useMemo(() => {
    const items = (derived.items || []) as any[]
    let hasInc = false
    let hasExc = false
    for (const it of items) {
      const t = String(it?.gst_type || '')
      if (t === 'GST_INCLUDED_10') hasInc = true
      else if (t === 'GST_10') hasExc = true
    }
    if (hasInc && !hasExc) return 'Included GST'
    if (hasExc && !hasInc) return 'Excluded GST'
    if (!hasInc && !hasExc) return 'No GST'
    return 'Mixed'
  }, [derived.items])

  const payStatusLabel = useMemo(() => {
    const st = String(invoice?.status || 'draft')
    if (st === 'paid') return 'PAID'
    if (st === 'void') return 'VOID'
    if (st === 'refunded') return 'REFUNDED'
    if (Number(derived.totals?.amount_due || 0) <= 0 && Number(derived.totals?.total || 0) > 0) return 'PAID'
    return 'UNPAID'
  }, [invoice?.status, derived.totals?.amount_due, derived.totals?.total])

  const watchedPaymentMethod = Form.useWatch('payment_method', form)
  const watchedPaymentMethodNote = Form.useWatch('payment_method_note', form)
  const markPaidBusyRef = useRef(false)

  useEffect(() => {
    if (invoiceType === 'receipt') return
    let id = invoiceId
    const method = String(watchedPaymentMethod || '').trim()
    if (!method) return
    if (!form.isFieldTouched('payment_method')) return
    if (markPaidBusyRef.current) return
    const st = String(invoice?.status || '')
    if (st === 'paid') return
    markPaidBusyRef.current = true
    ;(async () => {
      try {
        if (!id) {
          const created = await saveDraft({ silent: true })
          if (!created) { message.warning('请先保存草稿后再选择付款方式'); return }
          id = created
          setInvoiceId(created)
        }
        const row = await postJSON<any>(`/invoices/${id}/mark-paid`, { payment_method: method, payment_method_note: String(watchedPaymentMethodNote || '').trim() || undefined })
        setInvoice(row)
        await loadAudits(id)
        await loadPaymentHistory(id)
        message.success('已标记为已收款')
      } catch (e: any) {
        message.error(String(e?.message || '标记已收款失败'))
      } finally {
        markPaidBusyRef.current = false
      }
    })()
  }, [invoiceType, invoiceId, watchedPaymentMethod])

  useEffect(() => {
    loadCompanies().then(() => {})
    loadSavedCustomers().then(() => {})
  }, [])

  useEffect(() => {
    if (!companies.length) return
    if (mode === 'new') {
      const def = companies.find(c => c.is_default) || companies[0]
      form.setFieldsValue({
        company_id: def?.id,
        invoice_type: 'invoice',
        currency: 'AUD',
        issue_date: dayjs(),
        due_date: dayjs().add(14, 'day'),
        valid_until: dayjs().add(30, 'day'),
        line_items: [],
      })
      lastSavedHashRef.current = stableHash({ ...form.getFieldsValue(true), discountAmount: 0 })
      try {
        const raw = window.localStorage.getItem('invoice:draft:new')
        if (raw) {
          const parsed = JSON.parse(raw)
          const draftAt = Number(parsed?.updatedAt || 0)
          if (draftAt && parsed?.values) {
            Modal.confirm({
              title: '恢复上次未完成的发票？',
              content: '检测到本地有未完成的草稿内容，是否恢复？',
              okText: '恢复',
              cancelText: '忽略',
              onOk() {
                try {
                  form.setFieldsValue(normalizeDraftDates(parsed.values))
                  if (parsed.discountAmount != null) setDiscountAmount(Number(parsed.discountAmount || 0))
                  setFormVersion(v => v + 1)
                  message.success('已恢复草稿')
                } catch {
                }
              }
            })
          }
        }
      } catch {
      }
      return
    }
  }, [companies.length, mode, props.invoiceId])

  useEffect(() => {
    if (canSwitchInvoiceType) return
    if (invoiceType !== 'invoice') {
      form.setFieldsValue({ invoice_type: 'invoice' })
      setFormVersion(v => v + 1)
    }
  }, [canSwitchInvoiceType, invoiceType])

  useEffect(() => {
    if (invoiceType === 'invoice') return
    const list = (form.getFieldValue('line_items') || []) as any[]
    if (!Array.isArray(list) || !list.length) return
    const needs = list.some((x) => String(x?.gst_type || '') !== 'GST_FREE')
    if (!needs) return
    setLineItems(list.map((x: any) => ({ ...x, gst_type: 'GST_FREE' })))
  }, [invoiceType])

  useEffect(() => {
    if (invoiceType !== 'quote') return
    if (!watchedValidUntil && watchedIssueDate) {
      form.setFieldsValue({ valid_until: dayjs(watchedIssueDate).add(30, 'day') })
      setFormVersion(v => v + 1)
    }
    if (form.getFieldValue('due_date')) {
      form.setFieldsValue({ due_date: null })
      setFormVersion(v => v + 1)
    }
  }, [invoiceType, watchedIssueDate, watchedValidUntil])

  function openItemEditor(params: { mode: 'add' } | { mode: 'edit'; index: number }) {
    if (lineItemsLocked) {
      message.error('已开票发票不可修改项目明细')
      return
    }
    if (params.mode === 'add') {
      setItemModalIndex(null)
      itemModalForm.setFieldsValue({ title: '', content: '', quantity: 1, unit_price: 0, gst_type: (invoiceType === 'invoice' ? 'GST_10' : 'GST_FREE') })
      setItemModalOpen(true)
      return
    }
    const idx = params.index
    setItemModalIndex(idx)
    const v = form.getFieldValue(['line_items', idx]) || {}
    const d = splitItemDesc(v.description)
    itemModalForm.setFieldsValue({
      title: d.title,
      content: d.content,
      quantity: Number(v.quantity || 1),
      unit_price: Number(v.unit_price || 0),
      gst_type: (v.gst_type || 'GST_10') as GstType,
    })
    setItemModalOpen(true)
  }

  async function applyItemEditor() {
    const v = await itemModalForm.validateFields()
    const desc = joinItemDesc(v.title, v.content)
    if (!desc) throw new Error('请输入项目标题或内容')
    const nextItem = { description: desc, quantity: Number(v.quantity || 0), unit_price: Number(v.unit_price || 0), gst_type: (v.gst_type || 'GST_10') as GstType }
    if (itemModalIndex == null) {
      const list = (form.getFieldValue('line_items') || []) as any[]
      setLineItems([...list, nextItem])
      message.success('已添加项目')
    } else {
      const list = (form.getFieldValue('line_items') || []) as any[]
      const next = list.map((x: any, i: number) => i === itemModalIndex ? nextItem : x)
      setLineItems(next)
      message.success('已更新项目')
    }
    setItemModalOpen(false)
  }

  useEffect(() => {
    if (mode !== 'edit') return
    const id = String(props.invoiceId || '')
    if (!id) return
    setInvoiceId(id)
    loadInvoice(id).then(() => {})
    loadAudits(id).then(() => {})
    loadSendLogs(id).then(() => {})
    loadPaymentHistory(id).then(() => {})
  }, [mode, props.invoiceId])

  useEffect(() => {
    const id = invoiceId
    const tick = async () => {
      if (!form.isFieldsTouched(true)) return
      if (autosaving) return
      setAutosaving(true)
      try { await saveDraft({ silent: true, fromAutosave: true }) } finally { setAutosaving(false) }
    }
    const iv = setInterval(() => { tick().then(() => {}) }, 30000)
    return () => clearInterval(iv)
  }, [invoiceId, autosaving, discountAmount])

  const steps = useMemo(() => {
    if (mode === 'new') return [{ title: '填写' }, { title: '核对' }, { title: '提交' }]
    return [{ title: '查看' }, { title: '修改' }, { title: '保存' }]
  }, [mode])

  const currentStep = useMemo(() => {
    if (mode === 'new') {
      if (!invoiceId) return 0
      const s = String(invoice?.status || 'draft')
      if (s === 'draft') return 1
      return 2
    }
    if (!form.isFieldsTouched(true)) return 0
    return 1
  }, [mode, invoiceId, invoice?.status, form, formVersion])

  const itemColumns: ColumnsType<any> = [
    { title: '项目描述', dataIndex: 'description', width: isMobile ? undefined : 420, render: (_: any, _r: any, idx: number) => {
      const raw = form.getFieldValue(['line_items', idx, 'description'])
      const d = splitItemDesc(raw)
      const title = d.title || '（未填写标题）'
      const content = d.content
      return (
        <div style={{ display:'flex', gap: 8, alignItems:'flex-start' }}>
          <Form.Item name={['line_items', idx, 'description']} rules={[{ required: true, message: '请输入项目描述' }]} hidden>
            <Input />
          </Form.Item>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, whiteSpace:'pre-wrap', wordBreak:'break-word', overflowWrap:'anywhere' }}>{title}</div>
            {content ? <div className={styles.muted} style={{ marginTop: 2, whiteSpace:'pre-wrap', wordBreak:'break-word', overflowWrap:'anywhere' }}>{content}</div> : null}
          </div>
        </div>
      )
    } },
    { title: '数量', dataIndex: 'quantity', width: 120, render: (_: any, _r: any, idx: number) => (
      <Form.Item name={['line_items', idx, 'quantity']} rules={[{ required: true, message: '数量必填' }]} style={{ marginBottom: 0 }}>
        <InputNumber min={0} step={1} style={{ width: '100%' }} disabled={lineItemsLocked} />
      </Form.Item>
    ) },
    { title: '单价 (AUD)', dataIndex: 'unit_price', width: 160, render: (_: any, _r: any, idx: number) => (
      <Form.Item name={['line_items', idx, 'unit_price']} rules={[{ required: true, message: '单价必填' }]} style={{ marginBottom: 0 }}>
        <InputNumber min={0} step={1} style={{ width: '100%' }} prefix="$" disabled={lineItemsLocked} />
      </Form.Item>
    ) },
    { title: '税率', dataIndex: 'gst_type', width: 140, render: (_: any, _r: any, idx: number) => (
      invoiceType === 'invoice' ? (
        <Form.Item name={['line_items', idx, 'gst_type']} rules={[{ required: true }]} style={{ marginBottom: 0 }}>
          <Select options={[
            { value: 'GST_INCLUDED_10', label: 'Included GST' },
            { value: 'GST_10', label: 'Excluded GST' },
            { value: 'GST_FREE', label: 'No GST' },
          ]} disabled={lineItemsLocked} />
        </Form.Item>
      ) : (
        <>
          <Form.Item name={['line_items', idx, 'gst_type']} hidden initialValue="GST_FREE">
            <Input />
          </Form.Item>
          <span className={styles.muted}>No GST</span>
        </>
      )
    ) },
    { title: '小计 (AUD)', dataIndex: 'subtotal', width: 150, align: 'right', render: (_: any, _r: any, idx: number) => {
      const v = form.getFieldValue(['line_items', idx]) || {}
      const c = computeLine({ quantity: Number(v.quantity || 0), unit_price: Number(v.unit_price || 0), gst_type: (v.gst_type || 'GST_10') as GstType })
      return <b>{fmtMoney(c.line_total)}</b>
    } },
    { title: '操作', key: 'act', width: 96, render: (_: any, _r: any, idx: number) => (
      <Space size={6}>
        <Tooltip title="编辑">
          <Button
            type="text"
            aria-label="编辑"
            icon={<EditOutlined />}
            disabled={lineItemsLocked}
            onClick={() => openItemEditor({ mode: 'edit', index: idx })}
          />
        </Tooltip>
        <Popconfirm
          title="确认删除该项目？"
          okText="删除"
          cancelText="取消"
          disabled={lineItemsLocked}
          onConfirm={() => {
            const list = (form.getFieldValue('line_items') || []) as any[]
            setLineItems(list.filter((_: any, i: number) => i !== idx))
          }}
        >
          <Tooltip title="删除">
            <Button type="text" danger aria-label="删除" icon={<DeleteOutlined />} disabled={lineItemsLocked} />
          </Tooltip>
        </Popconfirm>
      </Space>
    ) },
  ]

  const header = (
    <div className={styles.headerRow}>
      <div style={{ display:'flex', alignItems:'center', gap: 10 }}>
        <span className={styles.headerTitle}>{mode === 'new' ? '新建发票' : '编辑发票'}</span>
        {invoice ? statusTag(String(invoice.status || 'draft')) : null}
        {autosaving ? <span className={styles.muted}>自动保存中…</span> : null}
      </div>
      <div style={{ minWidth: isMobile ? '100%' : 520, flex: isMobile ? '0 0 100%' : '0 0 auto' }}>
        <Steps items={steps as any} current={currentStep} size={isMobile ? 'small' : 'default'} />
      </div>
    </div>
  )

  return (
    <div className={styles.page}>
      <Card loading={loading} title={header}>
        <Form form={form} layout="vertical" onValuesChange={() => setFormVersion(v => v + 1)}>
          <Row gutter={16} className={styles.contentGrid}>
            <Col xs={24} lg={16}>
              <Card className={styles.sectionCard} title={<div className={styles.sectionTitle}><span>发票信息</span><span className={styles.muted}>必填</span></div>} style={{ marginBottom: 12 }}>
                <Row gutter={16}>
                  <Col xs={24} md={10}>
                    <Form.Item name="company_id" label="开票主体" rules={[{ required: true, message: '请选择开票主体' }]}>
                      <Select placeholder="选择开票主体" options={companyOptions} showSearch optionFilterProp="label" disabled={mode === 'edit' && status !== 'draft'} />
                    </Form.Item>
                  </Col>
                  <Col xs={24} md={6}>
                    <Form.Item name="invoice_type" label="发票类型" initialValue="invoice" rules={[{ required: true, message: '请选择发票类型' }]}>
                      <Select
                        options={[
                          { value: 'quote', label: '报价单（Quote）' },
                          { value: 'invoice', label: '发票（Invoice）' },
                          { value: 'receipt', label: '收据（Receipt）' },
                        ]}
                        disabled={!canSwitchInvoiceType || (mode === 'edit' && status !== 'draft')}
                      />
                    </Form.Item>
                  </Col>
                  <Col xs={24} md={4}>
                    <Form.Item name="currency" label="币种" initialValue="AUD" rules={[{ required: true }]}>
                      <Select options={[{ value: 'AUD', label: 'AUD' }]} disabled={mode === 'edit' && status !== 'draft'} />
                    </Form.Item>
                  </Col>
                  <Col xs={24} md={4}>
                    <Form.Item name="invoice_no" label={invoiceType === 'quote' ? '报价单号' : (invoiceType === 'receipt' ? '收据号' : '发票号')}>
                      <Input disabled placeholder="出号后自动生成" />
                    </Form.Item>
                  </Col>
                </Row>
                <Row gutter={16}>
                  <Col xs={24} md={12}>
                    <Form.Item name="issue_date" label={invoiceType === 'quote' ? '报价日期' : (invoiceType === 'receipt' ? '收款日期' : '开票日期')} rules={[{ required: true, message: '请选择日期' }]}>
                      <DatePicker style={{ width: '100%' }} disabled={mode === 'edit' && status !== 'draft'} />
                    </Form.Item>
                  </Col>
                  <Col xs={24} md={12}>
                    {invoiceType === 'invoice' ? (
                      <Form.Item name="due_date" label="到期日期" rules={[{ required: true, message: '请选择到期日期' }]}>
                        <DatePicker style={{ width: '100%' }} />
                      </Form.Item>
                    ) : invoiceType === 'quote' ? (
                      <Form.Item name="valid_until" label="有效期至" rules={[{ required: true, message: '请选择有效期' }]}>
                        <DatePicker style={{ width: '100%' }} disabled={mode === 'edit' && status !== 'draft'} />
                      </Form.Item>
                    ) : (
                      <Form.Item name="payment_method" label="收款方式" rules={[{ required: true, message: '请选择收款方式' }]}>
                        <Select
                          placeholder="选择收款方式"
                          options={[
                            { value: 'bank_transfer', label: '银行转账' },
                            { value: 'bpay', label: 'BPAY' },
                            { value: 'payid', label: 'PayID' },
                            { value: 'cash', label: '现金' },
                            { value: 'rent_deduction', label: '租金扣除' },
                            { value: 'other', label: '其他' },
                          ]}
                          disabled={mode === 'edit' && status !== 'draft'}
                        />
                      </Form.Item>
                    )}
                  </Col>
                </Row>
                {invoiceType === 'quote' ? (
                  <div className={styles.muted} style={{ marginTop: -6, marginBottom: 6 }}>此报价有效期为30天</div>
                ) : null}
              </Card>

              <Card className={styles.sectionCard} title={<div className={styles.sectionTitle}><span>客户信息</span><span className={styles.muted}>选填</span></div>} style={{ marginBottom: 12 }}>
                <div style={{ display:'flex', gap: 10, alignItems:'center', flexWrap:'wrap', marginBottom: 10 }}>
                  <Select
                    style={{ minWidth: 260 }}
                    placeholder="选择常用客户"
                    value={selectedCustomerId}
                    options={savedCustomers.map((c) => ({
                      value: c.id,
                      label: `${c.name || '-'}${c.email ? ` · ${c.email}` : ''}`,
                    }))}
                    onChange={(v) => {
                      if (!v) {
                        setSelectedCustomerId(undefined)
                        form.setFieldsValue({ customer_id: '' })
                        setFormVersion(x => x + 1)
                        return
                      }
                      setSelectedCustomerId(v)
                      const c = savedCustomers.find(x => x.id === v)
                      if (!c) return
                      form.setFieldsValue({
                        customer_id: c.id,
                        bill_to_name: c.name || '',
                        bill_to_email: c.email || '',
                        bill_to_phone: c.phone || '',
                        bill_to_abn: c.abn || '',
                        bill_to_address: c.address || '',
                      })
                      setFormVersion(x => x + 1)
                    }}
                    allowClear
                  />
                  <Checkbox checked={saveAsCommonCustomer} onChange={(e) => setSaveAsCommonCustomer(e.target.checked)}>保存为常用客户</Checkbox>
                  <Button onClick={() => { try { router.push('/finance/invoices?tab=customers') } catch {} }}>管理常用客户</Button>
                </div>
                <Form.Item name="customer_id" hidden>
                  <Input />
                </Form.Item>
                <Row gutter={16}>
                  <Col xs={24} md={8}>
                    <Form.Item name="bill_to_name" label="姓名">
                      <Input placeholder="客户姓名" disabled={mode === 'edit' && status !== 'draft'} />
                    </Form.Item>
                  </Col>
                  <Col xs={24} md={8}>
                    <Form.Item name="bill_to_email" label="邮箱" rules={[{ type: 'email', message: '邮箱格式不正确' }]}>
                      <Input placeholder="name@example.com" />
                    </Form.Item>
                  </Col>
                  {invoiceType !== 'receipt' ? (
                    <Col xs={24} md={8}>
                      <Form.Item name="bill_to_address" label="地址">
                        <Input placeholder="地址" />
                      </Form.Item>
                    </Col>
                  ) : null}
                </Row>
                <Row gutter={16}>
                  <Col xs={24} md={8}>
                    <Form.Item name="bill_to_phone" label="电话">
                      <Input placeholder="联系电话" />
                    </Form.Item>
                  </Col>
                  {invoiceType === 'invoice' ? (
                    <Col xs={24} md={8}>
                      <Form.Item name="bill_to_abn" label="税号">
                        <Input placeholder="税号/ABN" />
                      </Form.Item>
                    </Col>
                  ) : null}
                </Row>
              </Card>

              <Card
                className={styles.sectionCard}
                title={<div className={styles.sectionTitle}><span>项目明细</span><span className={styles.muted}>必填</span></div>}
                extra={(
                  <Tooltip title="添加项目">
                    <Button
                      type="primary"
                      shape="circle"
                      aria-label="添加项目"
                      icon={<PlusOutlined />}
                      disabled={lineItemsLocked}
                      onClick={(e) => {
                        try { e.preventDefault(); e.stopPropagation() } catch {}
                        openItemEditor({ mode: 'add' })
                      }}
                    />
                  </Tooltip>
                )}
                style={{ marginBottom: 12 }}
              >
                  {!isMobile ? (
                    <Table
                      rowKey={(_, idx) => String(idx)}
                      dataSource={((form.getFieldValue('line_items') || []) as any[])}
                      columns={itemColumns}
                      pagination={false}
                    />
                  ) : (
                    <div style={{ display:'grid', gap: 10 }}>
                      {(((form.getFieldValue('line_items') || []) as any[]) as any[]).map((_x: any, idx: number) => (
                        <Card key={idx} size="small">
                          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', gap: 10, marginBottom: 6 }}>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <Form.Item name={['line_items', idx, 'description']} rules={[{ required: true, message: '请输入项目描述' }]} hidden>
                                <Input />
                              </Form.Item>
                              {(() => {
                                const raw = form.getFieldValue(['line_items', idx, 'description'])
                                const d = splitItemDesc(raw)
                                const title = d.title || '（未填写标题）'
                                const content = d.content
                                return (
                                  <>
                                    <div style={{ fontWeight: 700, whiteSpace:'pre-wrap', wordBreak:'break-word', overflowWrap:'anywhere' }}>{title}</div>
                                    {content ? <div className={styles.muted} style={{ marginTop: 2, whiteSpace:'pre-wrap', wordBreak:'break-word', overflowWrap:'anywhere' }}>{content}</div> : null}
                                  </>
                                )
                              })()}
                            </div>
                            <Space size={6}>
                              <Tooltip title="编辑">
                                <Button type="text" aria-label="编辑" icon={<EditOutlined />} disabled={lineItemsLocked} onClick={() => openItemEditor({ mode: 'edit', index: idx })} />
                              </Tooltip>
                              <Popconfirm title="确认删除该项目？" okText="删除" cancelText="取消" disabled={lineItemsLocked} onConfirm={() => {
                                const list = (form.getFieldValue('line_items') || []) as any[]
                                setLineItems(list.filter((_: any, i: number) => i !== idx))
                              }}>
                                <Tooltip title="删除">
                                  <Button type="text" danger aria-label="删除" icon={<DeleteOutlined />} disabled={lineItemsLocked} />
                                </Tooltip>
                              </Popconfirm>
                            </Space>
                          </div>
                          <Row gutter={12}>
                            <Col span={8}>
                              <Form.Item name={['line_items', idx, 'quantity']} label="数量" rules={[{ required: true, message: '必填' }]}>
                                <InputNumber min={0} step={1} style={{ width: '100%' }} disabled={lineItemsLocked} />
                              </Form.Item>
                            </Col>
                            <Col span={10}>
                              <Form.Item name={['line_items', idx, 'unit_price']} label="单价" rules={[{ required: true, message: '必填' }]}>
                                <InputNumber min={0} step={1} style={{ width: '100%' }} prefix="$" disabled={lineItemsLocked} />
                              </Form.Item>
                            </Col>
                            <Col span={6}>
                              {invoiceType === 'invoice' ? (
                                <Form.Item name={['line_items', idx, 'gst_type']} label="税率" rules={[{ required: true }]}>
                                  <Select options={[
                                    { value: 'GST_INCLUDED_10', label: 'Included GST' },
                                    { value: 'GST_10', label: 'Excluded GST' },
                                    { value: 'GST_FREE', label: 'No GST' },
                                  ]} disabled={lineItemsLocked} />
                                </Form.Item>
                              ) : (
                                <>
                                  <Form.Item name={['line_items', idx, 'gst_type']} hidden initialValue="GST_FREE">
                                    <Input />
                                  </Form.Item>
                                  <Form.Item label="税率" style={{ marginBottom: 0 }}>
                                    <Input value="No GST" disabled />
                                  </Form.Item>
                                </>
                              )}
                            </Col>
                          </Row>
                          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                            <span className={styles.muted}>小计</span>
                            <b>{(() => {
                              const v = form.getFieldValue(['line_items', idx]) || {}
                              const c = computeLine({ quantity: Number(v.quantity || 0), unit_price: Number(v.unit_price || 0), gst_type: (v.gst_type || 'GST_10') as GstType })
                              return fmtMoney(c.line_total)
                            })()}</b>
                          </div>
                        </Card>
                      ))}
                    </div>
                  )}
              </Card>

              <Modal
                open={itemModalOpen}
                title={itemModalIndex == null ? '新增项目' : '编辑项目'}
                okText={itemModalIndex == null ? '添加' : '保存'}
                cancelText="取消"
                onCancel={() => setItemModalOpen(false)}
                onOk={async () => {
                  try {
                    await applyItemEditor()
                  } catch (e: any) {
                    message.error(String(e?.message || '操作失败'))
                  }
                }}
              >
                <Form form={itemModalForm} layout="vertical">
                  <Form.Item name="title" label="项目标题" rules={[{ required: true, message: '请输入项目标题' }]}>
                    <Input placeholder="请输入项目标题" />
                  </Form.Item>
                  <Form.Item name="content" label="项目内容描述（文本）">
                    <Input.TextArea rows={4} placeholder="请输入项目内容描述（可选）" />
                  </Form.Item>
                  <Row gutter={12}>
                    <Col span={8}>
                      <Form.Item name="quantity" label="数量" rules={[{ required: true, message: '必填' }]}>
                        <InputNumber min={0} step={1} style={{ width: '100%' }} />
                      </Form.Item>
                    </Col>
                    <Col span={10}>
                      <Form.Item name="unit_price" label="单价 (AUD)" rules={[{ required: true, message: '必填' }]}>
                        <InputNumber min={0} step={1} style={{ width: '100%' }} prefix="$" />
                      </Form.Item>
                    </Col>
                    <Col span={6}>
                      {invoiceType === 'invoice' ? (
                        <Form.Item name="gst_type" label="税率" rules={[{ required: true }]}>
                          <Select options={[
                            { value: 'GST_INCLUDED_10', label: 'Included GST' },
                            { value: 'GST_10', label: 'Excluded GST' },
                            { value: 'GST_FREE', label: 'No GST' },
                          ]} />
                        </Form.Item>
                      ) : (
                        <Form.Item name="gst_type" label="税率" initialValue="GST_FREE">
                          <Select disabled options={[{ value: 'GST_FREE', label: 'No GST' }]} />
                        </Form.Item>
                      )}
                    </Col>
                  </Row>
                </Form>
              </Modal>

              <Card className={styles.sectionCard} title={<div className={styles.sectionTitle}><span>备注与条款</span><span className={styles.muted}>选填</span></div>} style={{ marginBottom: 12 }}>
                <Row gutter={16}>
                  <Col xs={24} md={12}>
                    <Form.Item name="notes" label="备注">
                      <Input.TextArea rows={3} placeholder="备注（可选）" />
                    </Form.Item>
                  </Col>
                  <Col xs={24} md={12}>
                    <Form.Item name="terms" label="条款">
                      <Input.TextArea rows={3} placeholder="条款（可选）" />
                    </Form.Item>
                  </Col>
                </Row>
              </Card>

              {mode === 'edit' && invoiceId ? (
                <Collapse
                  items={[
                    {
                      key: 'audits',
                      label: '变更记录',
                      children: (
                        <div style={{ display:'grid', gap: 12 }}>
                          <div>
                            {auditRows.length ? (
                              <Table
                                size="small"
                                rowKey="id"
                                dataSource={auditRows}
                                pagination={{ pageSize: 10 }}
                                columns={[
                                  { title: '时间', dataIndex: 'created_at', width: 180, render: (v: any) => String(v || '').replace('T', ' ').slice(0, 19) },
                                  { title: '操作人', dataIndex: 'actor_id', width: 160, render: (v: any) => v || '-' },
                                  { title: '动作', dataIndex: 'action', width: 160 },
                                ]}
                              />
                            ) : (
                              <div className={styles.muted}>暂无变更记录</div>
                            )}
                          </div>
                          <div>
                            <Divider style={{ margin: '10px 0' }} />
                            <b>发送记录</b>
                            <div style={{ marginTop: 6 }}>
                              {sendLogs.length ? (
                                <Table
                                  size="small"
                                  rowKey="id"
                                  dataSource={sendLogs}
                                  pagination={{ pageSize: 5 }}
                                  columns={[
                                    { title: '时间', dataIndex: 'created_at', width: 180, render: (v: any) => String(v || '').replace('T', ' ').slice(0, 19) },
                                    { title: 'To', dataIndex: 'to_email', render: (v: any) => v || '-' },
                                    { title: '状态', dataIndex: 'status', width: 100, render: (v: any) => v || 'sent' },
                                  ]}
                                />
                              ) : (
                                <div className={styles.muted}>暂无发送记录</div>
                              )}
                            </div>
                          </div>
                          <div>
                            <Divider style={{ margin: '10px 0' }} />
                            <b>付款记录</b>
                            <div style={{ marginTop: 6 }}>
                              {paymentEvents.length ? (
                                <Table
                                  size="small"
                                  rowKey="id"
                                  dataSource={paymentEvents}
                                  pagination={{ pageSize: 5 }}
                                  columns={[
                                    { title: '时间', dataIndex: 'created_at', width: 180, render: (v: any) => String(v || '').replace('T', ' ').slice(0, 19) },
                                    { title: '状态', dataIndex: 'status', width: 110, render: (v: any) => v || '-' },
                                    { title: '方式', dataIndex: 'payment_method', width: 160, render: (v: any) => v || '-' },
                                    { title: '备注', dataIndex: 'payment_method_note', render: (v: any) => v || '-' },
                                  ]}
                                />
                              ) : (
                                <div className={styles.muted}>暂无付款记录</div>
                              )}
                            </div>
                          </div>
                        </div>
                      ),
                    },
                  ]}
                />
              ) : null}
            </Col>

            <Col xs={24} lg={8}>
              <Card className={styles.summaryCard} title="金额计算" styles={{ body: { padding: 16 } }}>
                <div className={styles.summaryRow}><span>小计</span><b>{fmtMoney(derived.totals.subtotal)}</b></div>
                {invoiceType === 'invoice' ? (
                  <>
                    <div className={styles.summaryRow}><span>GST 模式</span><span>{gstModeLabel}</span></div>
                    <div className={styles.summaryRow}><span>税费 (GST)</span><b>{fmtMoney(derived.totals.tax_total)}</b></div>
                  </>
                ) : null}
                <div className={styles.summaryRow} style={{ alignItems:'center' }}>
                  <span>$ 折扣</span>
                  <InputNumber min={0} step={1} value={discountAmount} onChange={(v) => setDiscountAmount(Number(v || 0))} style={{ width: 140 }} />
                </div>
                <div className={styles.summaryTotal}><span>总计</span><span style={{ color: '#0052D9' }}>{fmtMoney(derived.totals.total)} {String(form.getFieldValue('currency') || 'AUD')}</span></div>
                <div className={styles.summaryRow}><span>状态</span><Tag color={payStatusLabel === 'PAID' ? 'blue' : (payStatusLabel === 'UNPAID' ? 'default' : 'red')}>{payStatusLabel}</Tag></div>
                <Divider style={{ margin: '10px 0' }} />
                {invoiceType !== 'receipt' ? (
                  <>
                    <Form.Item name="payment_method" label="付款方式" style={{ marginBottom: 8 }}>
                      <Select
                        placeholder="选择付款方式（可选）"
                        options={[
                          { value: 'bank_transfer', label: '银行转账' },
                          { value: 'bpay', label: 'BPAY' },
                          { value: 'payid', label: 'PayID' },
                          { value: 'cash', label: '现金' },
                          { value: 'rent_deduction', label: '租金扣除' },
                          { value: 'other', label: '其他' },
                        ]}
                      />
                    </Form.Item>
                    <Form.Item name="payment_method_note" label="付款方式备注" style={{ marginBottom: 0 }}>
                      <Input placeholder="例如：参考号/说明（可选）" />
                    </Form.Item>
                  </>
                ) : null}
                <div className={styles.muted} style={{ marginTop: 10 }}>
                  开票主体：{(() => {
                    const c = companyById[String(form.getFieldValue('company_id') || '')]
                    return c ? `${c.legal_name} (${c.abn})` : '-'
                  })()}
                </div>
              </Card>
            </Col>
          </Row>

          <div className={styles.stickyFooter}>
            <div className={styles.footerInner}>
              <Button
                onClick={() => {
                  try {
                    if (typeof window !== 'undefined' && window.history.length > 1) router.back()
                    else router.push('/finance/invoices')
                  } catch {
                    try { router.push('/finance/invoices') } catch {}
                  }
                }}
              >
                取消
              </Button>
              <Button onClick={() => saveDraft({})} loading={saving}>{status === 'draft' ? '保存草稿' : '保存'}</Button>
              <Button onClick={() => {
                if (!invoiceId) { message.warning('请先保存草稿'); return }
                try { router.push(`/finance/invoices/${invoiceId}/preview`) } catch {}
              }} disabled={!invoiceId}>预览/打印</Button>
              <Button type="primary" onClick={submitPrimary} loading={saving} disabled={!hasPerm('invoice.draft.create') && !hasPerm('invoice.issue')}>
                {String(invoice?.status || 'draft') === 'draft' ? '提交' : '保存'}
              </Button>
            </div>
          </div>
        </Form>
      </Card>
    </div>
  )
}
