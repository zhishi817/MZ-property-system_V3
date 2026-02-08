"use client"

import { useEffect, useMemo, useState } from 'react'
import { App, Button, Card, DatePicker, Dropdown, Grid, Input, Modal, Select, Space, Table, Tag } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import dayjs from 'dayjs'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { API_BASE, authHeaders, deleteJSON, getJSON, postJSON } from '../../../lib/api'
import { hasPerm } from '../../../lib/auth'
import { buildInvoiceTemplateHtml, normalizeAssetUrl } from '../../../lib/invoiceTemplateHtml'
import { InvoiceCompaniesManager } from '../../../components/invoice/InvoiceCompaniesManager'
import { InvoiceCustomersManager } from '../../../components/invoice/InvoiceCustomersManager'
import styles from './InvoicesCenter.module.css'

type Company = {
  id: string
  code?: string
  legal_name: string
  abn: string
  is_default?: boolean
}

type Invoice = {
  id: string
  company_id: string
  invoice_no?: string
  status?: string
  issue_date?: string
  due_date?: string
  currency?: string
  bill_to_name?: string
  bill_to_email?: string
  total?: number
  amount_due?: number
  created_at?: string
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

export default function InvoicesCenterClient() {
  const { message } = App.useApp()
  const screens = Grid.useBreakpoint()
  const isMobile = !screens.md
  const router = useRouter()
  const searchParams = useSearchParams()
  const initialTab = String(searchParams.get('tab') || 'records')
  const [activeTab, setActiveTab] = useState<string>(initialTab)

  const [companies, setCompanies] = useState<Company[]>([])
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedInvoiceIds, setSelectedInvoiceIds] = useState<string[]>([])
  const [filterCompany, setFilterCompany] = useState<string>('')
  const [filterStatus, setFilterStatus] = useState<string>('')
  const [filterRange, setFilterRange] = useState<any>(null)

  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewId, setPreviewId] = useState<string>('')
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewInvoice, setPreviewInvoice] = useState<any>(null)

  function isR2Url(u: string) {
    try {
      const url = new URL(u)
      const host = String(url.hostname || '').toLowerCase()
      return host.endsWith('.r2.dev') || host.includes('r2.cloudflarestorage.com')
    } catch {
      return false
    }
  }

  async function tryFetchDataUrl(url: string) {
    const u = String(url || '').trim()
    if (!u) return null
    if (u.startsWith('data:')) return u
    try {
      const resp = await fetch(u, { credentials: 'include' })
      if (!resp.ok) return null
      const blob = await resp.blob()
      const dataUrl: string = await new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result || ''))
        reader.onerror = () => reject(new Error('read_logo_failed'))
        reader.readAsDataURL(blob)
      })
      if (!String(dataUrl || '').startsWith('data:')) return null
      return dataUrl
    } catch {
      return null
    }
  }

  useEffect(() => {
    setActiveTab(String(searchParams.get('tab') || 'records'))
  }, [searchParams])

  const tabList = useMemo(() => ([
    { key: 'records', tab: '开票记录' },
    { key: 'companies', tab: '开票主体管理' },
    { key: 'customers', tab: '常用客户管理' },
  ]), [])

  function setTabAndSyncUrl(k: string) {
    setActiveTab(k)
    const qs = new URLSearchParams(searchParams.toString())
    if (k === 'records') qs.delete('tab')
    else qs.set('tab', k)
    router.replace(`/finance/invoices${qs.toString() ? `?${qs.toString()}` : ''}`)
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
      const def = (rows || []).find(x => x.is_default)
      if (def && !filterCompany) setFilterCompany(def.id)
    } catch {
    }
  }

  async function loadInvoices() {
    setLoading(true)
    try {
      const params: any = {}
      if (filterCompany) params.company_id = filterCompany
      if (filterStatus) params.status = filterStatus
      if (filterRange && filterRange[0] && filterRange[1]) {
        params.from = dayjs(filterRange[0]).format('YYYY-MM-DD')
        params.to = dayjs(filterRange[1]).format('YYYY-MM-DD')
      }
      const qs = new URLSearchParams(params).toString()
      const rows = await getJSON<Invoice[]>(`/invoices${qs ? `?${qs}` : ''}`)
      setInvoices(rows || [])
      setSelectedInvoiceIds([])
    } catch (e: any) {
      message.error(String(e?.message || '加载失败'))
    } finally {
      setLoading(false)
    }
  }

  async function mergeExportSelected() {
    if (!selectedInvoiceIds.length) { message.error('请选择要合并导出的发票'); return }
    try {
      const res = await fetch(`${API_BASE}/invoices/merge-pdf`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ invoice_ids: selectedInvoiceIds })
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `invoices_merged_${dayjs().format('YYYYMMDD_HHmm')}.pdf`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      message.success('已导出')
    } catch (e: any) {
      message.error(String(e?.message || '导出失败'))
    }
  }

  async function waitForIframeAssets(doc: Document) {
    try {
      const fonts: any = (doc as any).fonts
      if (fonts?.ready) {
        await Promise.race([fonts.ready, new Promise((r) => setTimeout(r, 1500))])
      }
    } catch {}
    try {
      const imgs = Array.from(doc.images || [])
      const loaders = imgs.map((img) => {
        if (img.complete) return Promise.resolve()
        return new Promise<void>((resolve) => {
          const done = () => {
            img.removeEventListener('load', done)
            img.removeEventListener('error', done)
            resolve()
          }
          img.addEventListener('load', done)
          img.addEventListener('error', done)
        })
      })
      await Promise.race([Promise.all(loaders), new Promise((r) => setTimeout(r, 4000))])
    } catch {}
  }

  async function withTempStyle<T>(doc: Document, id: string, cssText: string, fn: () => Promise<T>): Promise<T> {
    const prev = doc.getElementById(id)
    if (prev) prev.remove()
    const st = doc.createElement('style')
    st.id = id
    st.textContent = cssText
    doc.head.appendChild(st)
    try {
      return await fn()
    } finally {
      try { st.remove() } catch {}
    }
  }

  async function printGeneratedInvoice(id: string) {
    const key = `invoice-print-${id}`
    message.loading({ content: '正在准备打印…', key, duration: 0 })
    let iframe: HTMLIFrameElement | null = null
    let printed = false
    try {
      const j = await getJSON<any>(`/invoices/${id}`)
      const inv = { ...(j || {}), company: { ...(j?.company || {}) } }
      const logo = String(inv.company?.logo_url || '').trim()
      if (logo) {
        const abs = normalizeAssetUrl(logo)
        const proxied = isR2Url(abs) ? `${normalizeAssetUrl('/public/r2-image')}?url=${encodeURIComponent(abs)}` : abs
        const inlined = await tryFetchDataUrl(proxied)
        inv.company.logo_url = inlined || proxied
      }

      const srcDoc = buildInvoiceTemplateHtml({ template: 'classic', data: { invoice: inv, company: inv.company || {} } })
      iframe = document.createElement('iframe')
      iframe.style.position = 'fixed'
      iframe.style.left = '-10000px'
      iframe.style.top = '0'
      iframe.style.width = '1200px'
      iframe.style.height = '1600px'
      iframe.style.border = '0'
      iframe.style.opacity = '0'
      document.body.appendChild(iframe)
      await new Promise<void>((resolve) => {
        iframe!.onload = () => resolve()
        iframe!.srcdoc = srcDoc
      })

      const doc = iframe.contentDocument
      if (!doc) throw new Error('missing_iframe')
      await new Promise(r => setTimeout(r, 60))
      await waitForIframeAssets(doc)
      const w = iframe.contentWindow
      if (!w) throw new Error('missing_print_window')
      message.success({ content: '已打开打印', key, duration: 1 })
      w.onafterprint = () => {
        try { iframe?.remove() } catch {}
      }
      w.focus()
      w.print()
      printed = true
      setTimeout(() => {
        try { iframe?.remove() } catch {}
      }, 10000)
    } catch (e: any) {
      message.error({ content: String(e?.message || '打印失败'), key, duration: 2 })
    } finally {
      if (!printed) {
        try { iframe?.remove() } catch {}
      }
    }
  }

  useEffect(() => {
    if (!previewOpen || !previewId) return
    setPreviewLoading(true)
    getJSON<any>(`/invoices/${previewId}`)
      .then(async (j) => {
        const next = { ...(j || {}), company: { ...(j?.company || {}) } }
        const logo = String(next.company?.logo_url || '').trim()
        if (logo) {
          const abs = normalizeAssetUrl(logo)
          const proxied = isR2Url(abs) ? `${normalizeAssetUrl('/public/r2-image')}?url=${encodeURIComponent(abs)}` : abs
          const inlined = await tryFetchDataUrl(proxied)
          next.company.logo_url = inlined || proxied
        }
        setPreviewInvoice(next || null)
      })
      .catch((e: any) => message.error(String(e?.message || '加载失败')))
      .finally(() => setPreviewLoading(false))
  }, [previewOpen, previewId])

  const previewBestFile = useMemo(() => {
    const files = Array.isArray(previewInvoice?.files) ? previewInvoice.files : []
    const sorted = [...files].sort((a: any, b: any) => String(b?.created_at || '').localeCompare(String(a?.created_at || '')))
    const pdf = sorted.find((x: any) => /pdf/i.test(String(x?.mime_type || '')) || /\.pdf($|\?)/i.test(String(x?.url || '')))
    const img = sorted.find((x: any) => /(png|jpg|jpeg|webp)/i.test(String(x?.mime_type || '')) || /\.(png|jpg|jpeg|webp)($|\?)/i.test(String(x?.url || '')))
    return pdf || img || null
  }, [previewInvoice])

  const previewFileUrl = useMemo(() => {
    const u = String(previewBestFile?.url || '').trim()
    return u ? normalizeAssetUrl(u) : ''
  }, [previewBestFile])

  const previewFileKind = useMemo(() => {
    const u = String(previewBestFile?.url || '').trim().toLowerCase()
    const mt = String(previewBestFile?.mime_type || '').toLowerCase()
    if (mt.includes('pdf') || u.endsWith('.pdf') || u.includes('.pdf?')) return 'pdf'
    if (mt.startsWith('image/') || /\.(png|jpg|jpeg|webp)($|\?)/i.test(u)) return 'image'
    return ''
  }, [previewBestFile])

  const previewHtml = useMemo(() => {
    if (!previewInvoice) return ''
    const data = { invoice: previewInvoice, company: previewInvoice.company || {} }
    return buildInvoiceTemplateHtml({ template: 'classic', data })
  }, [previewInvoice])

  useEffect(() => {
    loadCompanies().then(() => {})
  }, [])

  useEffect(() => {
    if (!companies.length) return
    loadInvoices().then(() => {})
  }, [companies.length])

  const columns: ColumnsType<Invoice> = [
    { title: '单号', dataIndex: 'invoice_no', width: 160, render: (v) => v || '-' },
    { title: '公司', dataIndex: 'company_id', width: 240, render: (v) => {
      const c = companyById[String(v)]
      return c ? `${c.code || 'INV'} · ${c.legal_name}` : String(v || '')
    }},
    { title: '状态', dataIndex: 'status', width: 120, render: (v) => statusTag(String(v || 'draft')) },
    { title: '开票日', dataIndex: 'issue_date', width: 120, render: (v) => v ? String(v).slice(0,10) : '-' },
    { title: '到期日', dataIndex: 'due_date', width: 120, render: (v) => v ? String(v).slice(0,10) : '-' },
    { title: '收件人', dataIndex: 'bill_to_name', width: 180, render: (v, r) => v || r.bill_to_email || '-' },
    { title: '总计', dataIndex: 'total', width: 120, align: 'right', render: (v) => fmtMoney(v) },
    { title: '未收', dataIndex: 'amount_due', width: 120, align: 'right', render: (v) => fmtMoney(v) },
    { title: '操作', key: 'act', width: isMobile ? 120 : 320, render: (_: any, r) => {
      const st = String(r.status || 'draft')
      const canVoid = hasPerm('invoice.void') && st !== 'refunded'
      const canDiscard = hasPerm('invoice.draft.create') && st === 'draft'
      if (isMobile) {
        return (
          <Dropdown
            trigger={['click']}
            placement="bottomRight"
            menu={{
              items: [
                { key: 'view', label: '查看' },
                { key: 'print', label: '打印' },
                { key: 'edit', label: '编辑' },
                ...(st === 'draft'
                  ? [{ key: 'discard', label: '丢弃', danger: true, disabled: !canDiscard } as any]
                  : [{ key: 'delete', label: '删除', danger: true, disabled: !canVoid } as any]),
              ],
              onClick: async ({ key }) => {
                if (key === 'view') {
                  setPreviewId(String(r.id))
                  setPreviewInvoice(null)
                  setPreviewOpen(true)
                  return
                }
                if (key === 'print') {
                  await printGeneratedInvoice(String(r.id))
                  return
                }
                if (key === 'edit') {
                  router.push(`/finance/invoices/${r.id}`)
                  return
                }
                if (key === 'discard') {
                  Modal.confirm({
                    title: '确认丢弃该草稿？',
                    okText: '确认',
                    okType: 'danger',
                    cancelText: '取消',
                    async onOk() {
                      try {
                        await deleteJSON<any>(`/invoices/${r.id}`)
                        await loadInvoices()
                      } catch (e: any) {
                        message.error(String(e?.message || '丢弃失败'))
                      }
                    }
                  })
                  return
                }
                if (key === 'delete') {
                  let reason = '用户删除'
                  Modal.confirm({
                    title: '确认删除',
                    okText: '删除',
                    okType: 'danger',
                    cancelText: '取消',
                    content: (
                      <div style={{ display:'grid', gap: 10 }}>
                        <div style={{ color:'rgba(17,24,39,0.65)' }}>将把该记录标记为 void（作废），不可撤销。</div>
                        <Input defaultValue={reason} placeholder="请输入删除原因" onChange={(e) => { reason = String(e.target.value || '') }} />
                      </div>
                    ),
                    async onOk() {
                      try {
                        await postJSON<any>(`/invoices/${r.id}/void`, { reason: String(reason || '').trim() || '用户删除' })
                        message.success('已删除')
                        await loadInvoices()
                      } catch (e: any) {
                        message.error(String(e?.message || '删除失败'))
                      }
                    }
                  })
                }
              }
            }}
          >
            <Button size="small" shape="round">操作</Button>
          </Dropdown>
        )
      }
      return (
        <Space size={8} wrap>
          <Button
            size="small"
            shape="round"
            onClick={() => {
              setPreviewId(String(r.id))
              setPreviewInvoice(null)
              setPreviewOpen(true)
            }}
          >
            查看
          </Button>
          <Button size="small" shape="round" onClick={() => printGeneratedInvoice(String(r.id))}>打印</Button>
          <Button size="small" shape="round" onClick={() => router.push(`/finance/invoices/${r.id}`)}>编辑</Button>
          {st === 'draft' ? (
            <Button
              size="small"
              shape="round"
              danger
              disabled={!canDiscard}
              onClick={() => {
                Modal.confirm({
                  title: '确认丢弃该草稿？',
                  okText: '确认',
                  okType: 'danger',
                  cancelText: '取消',
                  async onOk() {
                    try {
                      await deleteJSON<any>(`/invoices/${r.id}`)
                      await loadInvoices()
                    } catch (e: any) {
                      message.error(String(e?.message || '丢弃失败'))
                    }
                  }
                })
              }}
            >
              丢弃
            </Button>
          ) : (
            <Button
              size="small"
              shape="round"
              danger
              disabled={!canVoid}
              onClick={() => {
                let reason = '用户删除'
                Modal.confirm({
                  title: '确认删除',
                  okText: '删除',
                  okType: 'danger',
                  cancelText: '取消',
                  content: (
                    <div style={{ display:'grid', gap: 10 }}>
                      <div style={{ color:'rgba(17,24,39,0.65)' }}>将把该记录标记为 void（作废），不可撤销。</div>
                      <Input defaultValue={reason} placeholder="请输入删除原因" onChange={(e) => { reason = String(e.target.value || '') }} />
                    </div>
                  ),
                  async onOk() {
                    try {
                      await postJSON<any>(`/invoices/${r.id}/void`, { reason: String(reason || '').trim() || '用户删除' })
                      message.success('已删除')
                      await loadInvoices()
                    } catch (e: any) {
                      message.error(String(e?.message || '删除失败'))
                    }
                  }
                })
              }}
            >
              删除
            </Button>
          )}
        </Space>
      )
    }},
  ]

  return (
    <div style={{ background: '#F5F7FA', padding: 16, minHeight: 'calc(100vh - 64px)' }}>
      <Card
        title="发票中心"
        className={styles.invoiceCenterCard}
        tabList={tabList as any}
        activeTabKey={activeTab}
        onTabChange={setTabAndSyncUrl as any}
        styles={{ body: { padding: 16 } }}
      >
        {activeTab === 'records' ? (
          <>
            <Space wrap style={{ justifyContent: isMobile ? 'flex-start' : 'flex-end', marginBottom: 12 }}>
              <Select style={{ width: 260 }} allowClear placeholder="选择开票主体" value={filterCompany || undefined} options={companyOptions} onChange={(v) => setFilterCompany(String(v || ''))} />
              <Select style={{ width: 140 }} allowClear placeholder="状态" value={filterStatus || undefined} options={[
                { value: 'draft', label: 'draft' },
                { value: 'issued', label: 'issued' },
                { value: 'sent', label: 'sent' },
                { value: 'paid', label: 'paid' },
                { value: 'void', label: 'void' },
                { value: 'refunded', label: 'refunded' },
              ]} onChange={(v) => setFilterStatus(String(v || ''))} />
              <DatePicker.RangePicker value={filterRange} onChange={(v) => setFilterRange(v)} />
              <Button onClick={loadInvoices}>刷新</Button>
              <Button onClick={mergeExportSelected} disabled={!selectedInvoiceIds.length}>合并导出</Button>
              <Link href="/finance/invoices/new" prefetch={false}><Button type="primary">新建发票</Button></Link>
            </Space>
            <Table
              rowKey="id"
              columns={columns}
              dataSource={invoices}
              loading={loading}
              rowSelection={{ selectedRowKeys: selectedInvoiceIds, onChange: (keys) => setSelectedInvoiceIds(keys as any) }}
              pagination={{ pageSize: 20 }}
            />
            <Modal
              open={previewOpen}
              onCancel={() => { setPreviewOpen(false); setPreviewId(''); setPreviewInvoice(null) }}
              width={isMobile ? '95vw' : 900}
              centered
              keyboard
              footer={null}
              destroyOnClose
              styles={{ body: { height: isMobile ? '80vh' : 600, padding: 0, overflow: 'hidden' } }}
            >
              <div style={{ width: '100%', height: '100%' }}>
                {previewLoading ? (
                  <div style={{ width: '100%', height: '100%', display:'flex', alignItems:'center', justifyContent:'center', color:'rgba(17,24,39,0.65)' }}>
                    加载中…
                  </div>
                ) : previewFileUrl && previewFileKind === 'pdf' ? (
                  <iframe title="invoice-preview-pdf" src={previewFileUrl} style={{ width: '100%', height: '100%', border: 0 }} />
                ) : previewFileUrl && previewFileKind === 'image' ? (
                  <div style={{ width: '100%', height: '100%', overflow: 'auto', background: '#0b1220', padding: 12 }}>
                    <img alt="invoice-preview" src={previewFileUrl} style={{ maxWidth: '100%', height: 'auto', display: 'block', margin: '0 auto' }} />
                  </div>
                ) : (
                  <iframe title="invoice-preview-html" srcDoc={previewHtml} style={{ width: '100%', height: '100%', border: 0 }} />
                )}
              </div>
            </Modal>
          </>
        ) : activeTab === 'companies' ? (
          <InvoiceCompaniesManager
            bordered
            onChanged={() => {
              loadCompanies().then(() => {})
            }}
          />
        ) : (
          <InvoiceCustomersManager bordered />
        )}
      </Card>
    </div>
  )
}
