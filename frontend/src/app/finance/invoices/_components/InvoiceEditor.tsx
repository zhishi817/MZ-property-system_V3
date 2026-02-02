"use client"

import { useEffect, useMemo, useRef, useState } from 'react'
import { App, Button, Card, Col, Collapse, DatePicker, Divider, Form, Grid, Input, InputNumber, Modal, Row, Select, Space, Steps, Table, Tag } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import dayjs from 'dayjs'
import { useRouter } from 'next/navigation'
import { API_BASE, authHeaders, getJSON, patchJSON, postJSON } from '../../../../lib/api'
import { hasPerm } from '../../../../lib/auth'
import { canBackendAutosaveDraft, computeLine, computeTotals, extractDiscount, normalizeLineItemsForSave, stableHash, type GstType, type InvoiceLineItemInput } from '../../../../lib/invoiceEditorModel'
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
  invoice_no?: string
  status?: string
  issue_date?: string
  due_date?: string
  currency?: string
  bill_to_name?: string
  bill_to_email?: string
  bill_to_address?: string
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
  if (typeof a === 'string' && a) v.issue_date = dayjs(a)
  if (typeof b === 'string' && b) v.due_date = dayjs(b)
  return v
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
  const [discountAmount, setDiscountAmount] = useState<number>(0)
  const [auditRows, setAuditRows] = useState<any[]>([])
  const [sendLogs, setSendLogs] = useState<any[]>([])
  const [formVersion, setFormVersion] = useState(0)

  const [form] = Form.useForm()
  const lastSavedHashRef = useRef<string>('')

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

  async function loadInvoice(id: string) {
    setLoading(true)
    try {
      const j = await getJSON<any>(`/invoices/${id}`)
      setInvoice(j)
      const extracted = extractDiscount(j.line_items || [])
      setDiscountAmount(Number(extracted.discount_amount || 0))
      form.setFieldsValue({
        company_id: j.company_id,
        currency: j.currency || 'AUD',
        invoice_no: j.invoice_no || '',
        issue_date: j.issue_date ? dayjs(j.issue_date) : null,
        due_date: j.due_date ? dayjs(j.due_date) : null,
        bill_to_name: j.bill_to_name || '',
        bill_to_email: j.bill_to_email || '',
        bill_to_address: j.bill_to_address || '',
        notes: j.notes || '',
        terms: j.terms || '',
        line_items: (extracted.user_items || []).map((x: any) => ({
          description: x.description,
          quantity: Number(x.quantity || 0),
          unit_price: Number(x.unit_price || 0),
          gst_type: (x.gst_type || 'GST_10') as GstType,
        })),
      })
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

  function buildPayload(values: any) {
    const userItems = (values.line_items || []) as InvoiceLineItemInput[]
    const items = normalizeLineItemsForSave({ user_items: userItems, discount_amount: discountAmount })
    return {
      company_id: values.company_id,
      currency: values.currency || 'AUD',
      bill_to_name: values.bill_to_name || undefined,
      bill_to_email: values.bill_to_email || undefined,
      bill_to_address: values.bill_to_address || undefined,
      notes: values.notes || undefined,
      terms: values.terms || undefined,
      issue_date: values.issue_date ? dayjs(values.issue_date).format('YYYY-MM-DD') : undefined,
      due_date: values.due_date ? dayjs(values.due_date).format('YYYY-MM-DD') : undefined,
      line_items: items.map((x) => ({ description: x.description, quantity: Number(x.quantity), unit_price: Number(x.unit_price), gst_type: x.gst_type })),
    }
  }

  async function saveDraft(params?: { silent?: boolean; fromAutosave?: boolean }): Promise<string | null> {
    const values = form.getFieldsValue(true)
    const payload = buildPayload(values)
    const hash = stableHash({ ...values, discountAmount })
    try {
      try {
        const k = invoiceId ? `invoice:draft:${invoiceId}` : 'invoice:draft:new'
        window.localStorage.setItem(k, JSON.stringify({ values, discountAmount, updatedAt: Date.now() }))
      } catch {
      }

      if (!canBackendAutosaveDraft({ company_id: payload.company_id, line_items: values.line_items })) {
        if (!params?.silent && !params?.fromAutosave) message.warning('请先填写开票主体与至少 1 条项目描述再保存草稿')
        return invoiceId
      }

      if (params?.fromAutosave && hash === lastSavedHashRef.current) return invoiceId

      if (!invoiceId) {
        const created = await postJSON<any>('/invoices', payload)
        setInvoiceId(created.id)
        lastSavedHashRef.current = hash
        if (!params?.silent) message.success('草稿已保存')
        router.replace(`/finance/invoices/${created.id}`)
        return created.id
      }
      const updated = await patchJSON<any>(`/invoices/${invoiceId}`, payload)
      lastSavedHashRef.current = hash
      if (!params?.silent) message.success('草稿已保存')
      if (invoiceId) {
        await loadInvoice(invoiceId)
        await loadAudits(invoiceId)
      }
      setInvoice(prev => prev ? { ...prev, ...updated } : prev)
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

  useEffect(() => {
    loadCompanies().then(() => {})
  }, [])

  useEffect(() => {
    if (!companies.length) return
    if (mode === 'new') {
      const def = companies.find(c => c.is_default) || companies[0]
      form.setFieldsValue({
        company_id: def?.id,
        currency: 'AUD',
        issue_date: dayjs(),
        due_date: dayjs().add(14, 'day'),
        line_items: [{ description: '', quantity: 1, unit_price: 0, gst_type: 'GST_10' as GstType }],
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
    if (mode !== 'edit') return
    const id = String(props.invoiceId || '')
    if (!id) return
    setInvoiceId(id)
    loadInvoice(id).then(() => {})
    loadAudits(id).then(() => {})
    loadSendLogs(id).then(() => {})
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
    { title: '项目描述', dataIndex: 'description', width: isMobile ? undefined : 420, render: (_: any, _r: any, idx: number) => (
      <Form.Item name={['line_items', idx, 'description']} rules={[{ required: true, message: '请输入项目描述' }]} style={{ marginBottom: 0 }}>
        <Input placeholder="输入项目描述" />
      </Form.Item>
    ) },
    { title: '数量', dataIndex: 'quantity', width: 120, render: (_: any, _r: any, idx: number) => (
      <Form.Item name={['line_items', idx, 'quantity']} rules={[{ required: true, message: '数量必填' }]} style={{ marginBottom: 0 }}>
        <InputNumber min={0} step={1} style={{ width: '100%' }} />
      </Form.Item>
    ) },
    { title: '单价 (AUD)', dataIndex: 'unit_price', width: 160, render: (_: any, _r: any, idx: number) => (
      <Form.Item name={['line_items', idx, 'unit_price']} rules={[{ required: true, message: '单价必填' }]} style={{ marginBottom: 0 }}>
        <InputNumber min={0} step={1} style={{ width: '100%' }} prefix="$" />
      </Form.Item>
    ) },
    { title: '税率', dataIndex: 'gst_type', width: 140, render: (_: any, _r: any, idx: number) => (
      <Form.Item name={['line_items', idx, 'gst_type']} rules={[{ required: true }]} style={{ marginBottom: 0 }}>
        <Select options={[
          { value: 'GST_10', label: '10%' },
          { value: 'GST_FREE', label: '免税' },
          { value: 'INPUT_TAXED', label: 'Input' },
        ]} />
      </Form.Item>
    ) },
    { title: '小计 (AUD)', dataIndex: 'subtotal', width: 150, align: 'right', render: (_: any, _r: any, idx: number) => {
      const v = form.getFieldValue(['line_items', idx]) || {}
      const c = computeLine({ quantity: Number(v.quantity || 0), unit_price: Number(v.unit_price || 0), gst_type: (v.gst_type || 'GST_10') as GstType })
      return <b>{fmtMoney(c.line_total)}</b>
    } },
    { title: '操作', key: 'act', width: 90, render: (_: any, _r: any, idx: number) => (
      <Button danger type="text" onClick={() => {
        const list = (form.getFieldValue('line_items') || []) as any[]
        const next = list.filter((_: any, i: number) => i !== idx)
        form.setFieldValue('line_items', next.length ? next : [{ description: '', quantity: 1, unit_price: 0, gst_type: 'GST_10' }])
      }}>删除</Button>
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
                  <Col xs={24} md={12}>
                    <Form.Item name="company_id" label="开票主体" rules={[{ required: true, message: '请选择开票主体' }]}>
                      <Select placeholder="选择开票主体" options={companyOptions} showSearch optionFilterProp="label" />
                    </Form.Item>
                  </Col>
                  <Col xs={24} md={6}>
                    <Form.Item name="currency" label="币种" initialValue="AUD" rules={[{ required: true }]}>
                      <Select options={[{ value: 'AUD', label: 'AUD' }]} />
                    </Form.Item>
                  </Col>
                  <Col xs={24} md={6}>
                    <Form.Item name="invoice_no" label="发票号">
                      <Input disabled placeholder="出号后自动生成" />
                    </Form.Item>
                  </Col>
                </Row>
                <Row gutter={16}>
                  <Col xs={24} md={12}>
                    <Form.Item name="issue_date" label="开票日期" rules={[{ required: true, message: '请选择开票日期' }]}>
                      <DatePicker style={{ width: '100%' }} />
                    </Form.Item>
                  </Col>
                  <Col xs={24} md={12}>
                    <Form.Item name="due_date" label="到期日期" rules={[{ required: true, message: '请选择到期日期' }]}>
                      <DatePicker style={{ width: '100%' }} />
                    </Form.Item>
                  </Col>
                </Row>
              </Card>

              <Card className={styles.sectionCard} title={<div className={styles.sectionTitle}><span>购买方信息</span><span className={styles.muted}>选填</span></div>} style={{ marginBottom: 12 }}>
                <Row gutter={16}>
                  <Col xs={24} md={8}>
                    <Form.Item name="bill_to_name" label="姓名">
                      <Input placeholder="购买方姓名" />
                    </Form.Item>
                  </Col>
                  <Col xs={24} md={8}>
                    <Form.Item name="bill_to_email" label="邮箱" rules={[{ type: 'email', message: '邮箱格式不正确' }]}>
                      <Input placeholder="name@example.com" />
                    </Form.Item>
                  </Col>
                  <Col xs={24} md={8}>
                    <Form.Item name="bill_to_address" label="地址">
                      <Input placeholder="地址" />
                    </Form.Item>
                  </Col>
                </Row>
              </Card>

              <Card
                className={styles.sectionCard}
                title={<div className={styles.sectionTitle}><span>项目明细</span><span className={styles.muted}>必填</span></div>}
                extra={(
                  <Button type="primary" onClick={() => {
                    const list = (form.getFieldValue('line_items') || []) as any[]
                    form.setFieldValue('line_items', [...list, { description: '', quantity: 1, unit_price: 0, gst_type: 'GST_10' }])
                  }}>添加项目</Button>
                )}
                style={{ marginBottom: 12 }}
              >
                {!isMobile ? (
                  <Table
                    rowKey={(_, idx) => String(idx)}
                    dataSource={(form.getFieldValue('line_items') || []) as any[]}
                    columns={itemColumns}
                    pagination={false}
                  />
                ) : (
                  <div style={{ display:'grid', gap: 10 }}>
                    {((form.getFieldValue('line_items') || []) as any[]).map((_x: any, idx: number) => (
                      <Card key={idx} size="small">
                        <Form.Item name={['line_items', idx, 'description']} label="项目描述" rules={[{ required: true, message: '请输入项目描述' }]}>
                          <Input placeholder="输入项目描述" />
                        </Form.Item>
                        <Row gutter={12}>
                          <Col span={8}>
                            <Form.Item name={['line_items', idx, 'quantity']} label="数量" rules={[{ required: true, message: '必填' }]}>
                              <InputNumber min={0} step={1} style={{ width: '100%' }} />
                            </Form.Item>
                          </Col>
                          <Col span={10}>
                            <Form.Item name={['line_items', idx, 'unit_price']} label="单价" rules={[{ required: true, message: '必填' }]}>
                              <InputNumber min={0} step={1} style={{ width: '100%' }} prefix="$" />
                            </Form.Item>
                          </Col>
                          <Col span={6}>
                            <Form.Item name={['line_items', idx, 'gst_type']} label="税率" rules={[{ required: true }]}>
                              <Select options={[
                                { value: 'GST_10', label: '10%' },
                                { value: 'GST_FREE', label: '免税' },
                                { value: 'INPUT_TAXED', label: 'Input' },
                              ]} />
                            </Form.Item>
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
                        <div style={{ marginTop: 8, textAlign:'right' }}>
                          <Button danger type="text" onClick={() => {
                            const list = (form.getFieldValue('line_items') || []) as any[]
                            const next = list.filter((_: any, i: number) => i !== idx)
                            form.setFieldValue('line_items', next.length ? next : [{ description: '', quantity: 1, unit_price: 0, gst_type: 'GST_10' }])
                          }}>删除</Button>
                        </div>
                      </Card>
                    ))}
                  </div>
                )}
              </Card>

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
                <div className={styles.summaryRow}><span>% 税率</span><span>10%</span></div>
                <div className={styles.summaryRow}><span>税费 (GST)</span><b>{fmtMoney(derived.totals.tax_total)}</b></div>
                <div className={styles.summaryRow} style={{ alignItems:'center' }}>
                  <span>$ 折扣</span>
                  <InputNumber min={0} step={1} value={discountAmount} onChange={(v) => setDiscountAmount(Number(v || 0))} style={{ width: 140 }} />
                </div>
                <div className={styles.summaryTotal}><span>总计</span><span style={{ color: '#0052D9' }}>{fmtMoney(derived.totals.total)} {String(form.getFieldValue('currency') || 'AUD')}</span></div>
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
              <Button onClick={() => saveDraft({})} loading={saving}>保存草稿</Button>
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
