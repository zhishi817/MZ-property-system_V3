"use client"

import { useEffect, useMemo, useState } from 'react'
import { App, Button, Card, DatePicker, Grid, Select, Space, Table, Tag } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import dayjs from 'dayjs'
import Link from 'next/link'
import { API_BASE, authHeaders, getJSON } from '../../../lib/api'

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

export default function InvoicesListPage() {
  const { message } = App.useApp()
  const screens = Grid.useBreakpoint()
  const isMobile = !screens.md

  const [companies, setCompanies] = useState<Company[]>([])
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedInvoiceIds, setSelectedInvoiceIds] = useState<string[]>([])
  const [filterCompany, setFilterCompany] = useState<string>('')
  const [filterStatus, setFilterStatus] = useState<string>('')
  const [filterRange, setFilterRange] = useState<any>(null)

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
    { title: '操作', key: 'act', width: 140, render: (_: any, r) => (
      <Link href={`/finance/invoices/${r.id}`} prefetch={false}>查看/编辑</Link>
    )},
  ]

  return (
    <div style={{ background: '#F5F7FA', padding: 16, minHeight: 'calc(100vh - 64px)' }}>
      <Card
        title="发票中心"
        extra={(
          <Space wrap style={{ justifyContent: isMobile ? 'flex-start' : 'flex-end' }}>
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
        )}
      >
        <Table
          rowKey="id"
          columns={columns}
          dataSource={invoices}
          loading={loading}
          rowSelection={{ selectedRowKeys: selectedInvoiceIds, onChange: (keys) => setSelectedInvoiceIds(keys as any) }}
          pagination={{ pageSize: 20 }}
        />
      </Card>
    </div>
  )
}

