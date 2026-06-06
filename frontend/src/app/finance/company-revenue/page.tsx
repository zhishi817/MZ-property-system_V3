"use client"

import dynamic from 'next/dynamic'
import {
  App as AntApp,
  Badge,
  Button,
  Card,
  Col,
  DatePicker,
  Descriptions,
  Divider,
  Drawer,
  Dropdown,
  Form,
  Input,
  InputNumber,
  Modal,
  Popover,
  Row,
  Segmented,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
  Upload,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  BellOutlined,
  DownloadOutlined,
  LeftOutlined,
  MoreOutlined,
  PlusOutlined,
  RightOutlined,
  SearchOutlined,
  WalletOutlined,
} from '@ant-design/icons'
import dayjs, { type Dayjs } from 'dayjs'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { API_BASE, apiCreate, apiDelete, apiUpdate, authHeaders, getJSON } from '../../../lib/api'
import { getRole, hasPerm } from '../../../lib/auth'
import {
  buildCompanyRevenueCsv,
  COMPANY_EXPENSE_CATEGORY_OPTIONS,
  COMPANY_INCOME_CATEGORY_OPTIONS,
  filterCompanyRevenueRows,
  sumEffectiveCompanyRevenueRows,
  type CompanyRevenueCategorySummary,
  type CompanyRevenueKind,
  type CompanyRevenueReport,
  type CompanyRevenueRow,
} from '../../../lib/companyRevenue'
import { downloadNamedBlob } from '../../../lib/download'
import { sortProperties } from '../../../lib/properties'
import AuditTrail from '../../../components/AuditTrail'
import styles from './page.module.css'

const CompanyRevenueComposition = dynamic(
  () => import('./_components/CompanyRevenueComposition').then((mod) => mod.CompanyRevenueComposition),
  { ssr: false },
)

type ExpenseInvoice = {
  id: string
  url: string
  file_name?: string | null
  mime_type?: string | null
  file_size?: number | null
  created_at?: string | null
}

type ReceiptSourceDetail = {
  id: string
  receipt_date?: string | null
  receipt_total_amount?: number | null
  note?: string | null
  scope_summary?: string | null
  images?: Array<{ id: string; url: string }>
  items?: Array<{
    id: string
    line_no?: number | null
    scope?: string | null
    property_code?: string | null
    property_address?: string | null
    expense_name?: string | null
    amount?: number | null
    category?: string | null
    category_detail?: string | null
    note?: string | null
    company_expense_id?: string | null
    property_expense_id?: string | null
  }>
}

const CATEGORY_COLORS: Record<string, string> = {
  mgmt_fee: '#0f9f63',
  cleaning_fee: '#43c483',
  cancel_fee: '#f6b73c',
  late_checkout: '#3d8bfd',
  other: '#9aa4b2',
  office: '#ff8a3d',
  bedding_fee: '#f7b731',
  office_rent: '#f04444',
  company_warehouse_rent: '#ff6b57',
  car_loan: '#8c5ce6',
  electricity: '#f5a623',
  internet: '#3d8bfd',
  water: '#20a4f3',
  fuel: '#ff7b54',
  parking_fee: '#667eea',
  maintenance_materials: '#a5673f',
  tax: '#d64562',
  service: '#5d6d7e',
}

function formatAmount(value: number | null | undefined) {
  if (value === null || value === undefined) return '-'
  return Number(value || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

function KpiCard(props: {
  title: string
  value: number | null
  color: string
  iconBackground: string
  icon: React.ReactNode
  primary?: boolean
  meta?: string
}) {
  return (
    <Card className={`${styles.kpiCard} ${props.primary ? styles.kpiPrimary : ''}`}>
      <div className={styles.kpiInner}>
        <span className={styles.kpiIcon} style={{ color: props.color, background: props.iconBackground }}>
          {props.icon}
        </span>
        <div>
          <span className={styles.kpiLabel}>{props.title}</span>
          <span className={styles.kpiValue} style={{ color: props.color }}>
            {props.value === null ? '-' : `$${formatAmount(props.value)}`}
          </span>
          {props.meta ? <div className={styles.kpiMeta}>{props.meta}</div> : null}
        </div>
      </div>
    </Card>
  )
}

function SummaryColumn(props: {
  title: string
  data: CompanyRevenueCategorySummary[]
  color: string
  onSelect: (category: string) => void
}) {
  return (
    <div className={styles.summaryColumn}>
      <div className={styles.summaryHeading}>{props.title}</div>
      {props.data.map((row) => (
        <button
          key={row.category}
          type="button"
          className={styles.summaryRow}
          onClick={() => props.onSelect(row.category)}
          style={{ width: '100%', background: 'transparent', borderTop: 0, borderLeft: 0, borderRight: 0, cursor: 'pointer' }}
        >
          <span className={styles.summaryName}>
            <span className={styles.colorDot} style={{ background: CATEGORY_COLORS[row.category] || props.color }} />
            {row.label}
          </span>
          <span className={styles.summaryAmount}>${formatAmount(row.total)}</span>
          <span className={styles.summaryPercent} style={{ color: row.total ? props.color : undefined }}>
            {row.percentage.toFixed(1)}%
          </span>
        </button>
      ))}
    </div>
  )
}

export default function CompanyRevenuePage() {
  const { message, modal } = AntApp.useApp()
  const [month, setMonth] = useState<Dayjs>(dayjs())
  const [report, setReport] = useState<CompanyRevenueReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [properties, setProperties] = useState<Array<{ id: string; code?: string; address?: string }>>([])
  const [view, setView] = useState<'overview' | 'details'>('overview')
  const [detailKind, setDetailKind] = useState<CompanyRevenueKind>('income')
  const [categoryFilters, setCategoryFilters] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [dateRange, setDateRange] = useState<[Dayjs | null, Dayjs | null] | null>([
    dayjs().startOf('month'),
    dayjs().endOf('month'),
  ])
  const [includeDeleted, setIncludeDeleted] = useState(false)
  const [detailOpen, setDetailOpen] = useState(false)
  const [detailRow, setDetailRow] = useState<CompanyRevenueRow | null>(null)
  const [expenseInvoices, setExpenseInvoices] = useState<ExpenseInvoice[]>([])
  const [receiptDetail, setReceiptDetail] = useState<ReceiptSourceDetail | null>(null)
  const [incomeOpen, setIncomeOpen] = useState(false)
  const [expenseOpen, setExpenseOpen] = useState(false)
  const [editingIncome, setEditingIncome] = useState<CompanyRevenueRow | null>(null)
  const [editingExpense, setEditingExpense] = useState<CompanyRevenueRow | null>(null)
  const [savingIncome, setSavingIncome] = useState(false)
  const [savingExpense, setSavingExpense] = useState(false)
  const [expenseInvoiceFiles, setExpenseInvoiceFiles] = useState<any[]>([])
  const [authCapabilities, setAuthCapabilities] = useState({
    role: null as string | null,
    canWriteIncome: false,
    canDeleteIncome: false,
    canWriteExpense: false,
    canDeleteExpense: false,
  })
  const [incomeForm] = Form.useForm()
  const [expenseForm] = Form.useForm()
  const reportRequestRef = useRef(0)
  const monthKey = month.format('YYYY-MM')

  const {
    role,
    canWriteIncome,
    canDeleteIncome,
    canWriteExpense,
    canDeleteExpense,
  } = authCapabilities
  const canIncludeDeleted = report?.capabilities.can_include_deleted || role === 'admin' || role === 'finance_staff'

  useEffect(() => {
    const nextRole = getRole()
    setAuthCapabilities({
      role: nextRole,
      canWriteIncome: nextRole === 'admin' || hasPerm('company_incomes.write') || hasPerm('finance.tx.write'),
      canDeleteIncome: nextRole === 'admin' || hasPerm('company_incomes.delete') || hasPerm('finance.tx.write'),
      canWriteExpense: nextRole === 'admin' || hasPerm('company_expenses.write') || hasPerm('finance.tx.write'),
      canDeleteExpense: nextRole === 'admin' || hasPerm('company_expenses.delete') || hasPerm('finance.tx.write'),
    })
  }, [])

  const loadReport = useCallback(async () => {
    const requestId = ++reportRequestRef.current
    setLoading(true)
    try {
      const include = includeDeleted ? '&include_deleted=1' : ''
      const next = await getJSON<CompanyRevenueReport>(`/finance/company-revenue/report?month=${encodeURIComponent(monthKey)}${include}`)
      if (requestId !== reportRequestRef.current) return
      setReport(next)
      if (!next.capabilities.can_view_income && next.capabilities.can_view_expense) setDetailKind('expense')
    } catch (error: any) {
      if (requestId !== reportRequestRef.current) return
      setReport(null)
      message.error(error?.message || '加载公司营收失败')
    } finally {
      if (requestId === reportRequestRef.current) setLoading(false)
    }
  }, [includeDeleted, message, monthKey])

  useEffect(() => {
    loadReport()
  }, [loadReport])

  useEffect(() => {
    getJSON<any[]>('/properties')
      .then((rows) => setProperties(Array.isArray(rows) ? rows : []))
      .catch(() => setProperties([]))
  }, [])

  useEffect(() => {
    setDateRange([month.startOf('month'), month.endOf('month')])
    setCategoryFilters([])
    setQuery('')
  }, [month])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (!detailOpen || detailRow?.kind !== 'expense' || !detailRow?.record_id) {
        setExpenseInvoices([])
        return
      }
      try {
        const rows = await getJSON<ExpenseInvoice[]>(`/finance/expense-invoices/company/${detailRow.record_id}`)
        if (!cancelled) setExpenseInvoices(Array.isArray(rows) ? rows : [])
      } catch {
        if (!cancelled) setExpenseInvoices([])
      }
    })()
    return () => { cancelled = true }
  }, [detailOpen, detailRow?.kind, detailRow?.record_id])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (!detailOpen || detailRow?.kind !== 'expense' || !detailRow?.receipt_id) {
        setReceiptDetail(null)
        return
      }
      try {
        const include = detailRow.deleted_at ? '?include_deleted=1' : ''
        const data = await getJSON<ReceiptSourceDetail>(`/mzapp/expense-receipts/admin/${detailRow.receipt_id}${include}`)
        if (!cancelled) setReceiptDetail(data || null)
      } catch {
        if (!cancelled) setReceiptDetail(null)
      }
    })()
    return () => { cancelled = true }
  }, [detailOpen, detailRow?.deleted_at, detailRow?.kind, detailRow?.receipt_id])

  const filteredRows = useMemo(() => {
    const rows = detailKind === 'income' ? (report?.income_rows || []) : (report?.expense_rows || [])
    return filterCompanyRevenueRows(rows, {
      categories: categoryFilters,
      query,
      dateFrom: dateRange?.[0]?.format('YYYY-MM-DD'),
      dateTo: dateRange?.[1]?.format('YYYY-MM-DD'),
    })
  }, [categoryFilters, dateRange, detailKind, query, report?.expense_rows, report?.income_rows])
  const filteredTotal = useMemo(() => sumEffectiveCompanyRevenueRows(filteredRows), [filteredRows])
  const categoryOptions = detailKind === 'income' ? COMPANY_INCOME_CATEGORY_OPTIONS : COMPANY_EXPENSE_CATEGORY_OPTIONS

  function resetFilters() {
    setCategoryFilters([])
    setQuery('')
    setDateRange([month.startOf('month'), month.endOf('month')])
  }

  function openDetails(kind: CompanyRevenueKind, category?: string) {
    setDetailKind(kind)
    setView('details')
    setCategoryFilters(category ? [category] : [])
    setQuery('')
    setDateRange([month.startOf('month'), month.endOf('month')])
  }

  function openDetailRow(row: CompanyRevenueRow) {
    setDetailRow(row)
    setDetailOpen(true)
  }

  function openEditIncomeRow(row: CompanyRevenueRow) {
    if (!row.record_id || !row.editable) return
    setEditingIncome(row)
    incomeForm.setFieldsValue({
      date: dayjs(row.occurred_at),
      amount: Number(row.amount || 0),
      category: row.category,
      note: row.note,
      property_id: row.property_id || undefined,
    })
    setIncomeOpen(true)
  }

  function openEditExpenseRow(row: CompanyRevenueRow) {
    if (!row.record_id || !row.editable) return
    setEditingExpense(row)
    const invoice = String(row.invoice_url || '')
    expenseForm.setFieldsValue({
      date: dayjs(row.occurred_at),
      amount: Number(row.amount || 0),
      category: row.category,
      expense_name: row.expense_name || undefined,
      other_detail: row.category === 'other' ? row.category_detail : undefined,
      note: row.note,
      invoice_url: invoice || undefined,
    })
    setExpenseInvoiceFiles(invoice ? [{
      uid: 'invoice',
      name: invoice.split('/').pop() || 'invoice',
      status: 'done',
      url: absUrl(invoice),
    }] : [])
    setExpenseOpen(true)
  }

  function openCreateIncome() {
    setEditingIncome(null)
    incomeForm.resetFields()
    incomeForm.setFieldsValue({ date: dayjs(), category: 'other' })
    setIncomeOpen(true)
  }

  function openCreateExpense() {
    setEditingExpense(null)
    expenseForm.resetFields()
    expenseForm.setFieldsValue({ date: dayjs(), category: 'other' })
    setExpenseInvoiceFiles([])
    setExpenseOpen(true)
  }

  function absUrl(value?: string | null): string {
    const url = String(value || '').trim()
    if (!url) return ''
    if (/^https?:\/\//i.test(url)) return url
    return `${API_BASE}${url.startsWith('/') ? url : `/${url}`}`
  }

  async function uploadInvoice(file: File): Promise<string> {
    const body = new FormData()
    body.append('file', file)
    const response = await fetch(`${API_BASE}/finance/invoices`, {
      method: 'POST',
      headers: { ...authHeaders() },
      body,
    })
    const payload = await response.json().catch(() => ({} as any))
    if (!response.ok) throw new Error(String(payload?.message || '上传失败'))
    const url = String(payload?.url || '')
    if (!url) throw new Error('上传失败')
    return url
  }

  async function submitIncome() {
    if (savingIncome) return
    setSavingIncome(true)
    try {
      const values = await incomeForm.validateFields()
      const payload = {
        occurred_at: dayjs(values.date).format('YYYY-MM-DD'),
        amount: Number(values.amount || 0),
        currency: 'AUD',
        category: values.category,
        note: values.note,
        property_id: values.property_id,
      }
      if (editingIncome?.record_id) await apiUpdate('company_incomes', editingIncome.record_id, payload)
      else await apiCreate('company_incomes', payload)
      message.success(editingIncome ? '收入已更新' : '收入已记录')
      setIncomeOpen(false)
      setEditingIncome(null)
      incomeForm.resetFields()
      await loadReport()
    } catch (error: any) {
      if (error?.errorFields) return
      message.error(error?.message || '记录失败')
    } finally {
      setSavingIncome(false)
    }
  }

  async function submitExpense() {
    if (savingExpense) return
    setSavingExpense(true)
    try {
      const values = await expenseForm.validateFields()
      const payload = {
        amount: Number(values.amount || 0),
        currency: 'AUD',
        occurred_at: dayjs(values.date).format('YYYY-MM-DD'),
        category: values.category,
        expense_name: values.expense_name || undefined,
        category_detail: values.category === 'other' ? (values.other_detail || '') : undefined,
        note: values.note,
        invoice_url: values.invoice_url || undefined,
      }
      if (editingExpense?.record_id) await apiUpdate('company_expenses', editingExpense.record_id, payload)
      else await apiCreate('company_expenses', payload)
      message.success(editingExpense ? '支出已更新' : '支出已记录')
      setExpenseOpen(false)
      setEditingExpense(null)
      setExpenseInvoiceFiles([])
      expenseForm.resetFields()
      await loadReport()
    } catch (error: any) {
      if (error?.errorFields) return
      message.error(error?.message || '记录失败')
    } finally {
      setSavingExpense(false)
    }
  }

  function confirmDelete(row: CompanyRevenueRow) {
    if (!row.record_id) return
    const resource = row.kind === 'income' ? 'company_incomes' : 'company_expenses'
    modal.confirm({
      title: row.kind === 'income' ? '确认删除收入？' : '确认删除支出？',
      okType: 'danger',
      onOk: async () => {
        try {
          await apiDelete(resource, row.record_id as string)
          message.success('已删除')
          if (detailRow?.id === row.id) {
            setDetailOpen(false)
            setDetailRow(null)
          }
          await loadReport()
        } catch (error: any) {
          message.error(error?.message || '删除失败')
        }
      },
    })
  }

  function exportFilteredRows() {
    const csv = buildCompanyRevenueCsv(detailKind, filteredRows)
    const filename = `${detailKind === 'income' ? '公司收入明细' : '公司支出明细'}-${monthKey}.csv`
    downloadNamedBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), filename)
    message.success(`已导出 ${filteredRows.length} 条明细`)
  }

  const incomeColumns: ColumnsType<CompanyRevenueRow> = [
    {
      title: '日期',
      dataIndex: 'occurred_at',
      width: 118,
      render: (value: string) => dayjs(value).format('DD/MM/YYYY'),
    },
    {
      title: '类别',
      dataIndex: 'category_label',
      width: 150,
      render: (_value, row) => (
        <span className={styles.categoryCell}>
          <span className={styles.colorDot} style={{ background: CATEGORY_COLORS[row.category] || '#9aa4b2' }} />
          {row.category_label}
        </span>
      ),
    },
    { title: '房号', dataIndex: 'property_code', width: 125, render: (value) => value || '-' },
    {
      title: '来源/说明',
      key: 'source',
      width: 260,
      ellipsis: true,
      render: (_value, row) => (
        <Space direction="vertical" size={0}>
          <Typography.Text>{row.description || row.source_label || '-'}</Typography.Text>
          <span className={styles.derivedTag}>{row.source_label}</span>
        </Space>
      ),
    },
    {
      title: '金额 (AUD)',
      dataIndex: 'amount',
      width: 145,
      align: 'right',
      render: (value: number) => <span className={styles.tableAmount} style={{ color: '#0f9f63' }}>${formatAmount(value)}</span>,
    },
    { title: '备注', dataIndex: 'note', width: 220, ellipsis: true, render: (value) => value || '-' },
    {
      title: '操作',
      key: 'actions',
      width: 170,
      fixed: 'right',
      render: (_value, row) => (
        <Space size={4}>
          <Button type="link" size="small" onClick={() => openDetailRow(row)}>详情</Button>
          {row.editable && canWriteIncome ? <Button type="link" size="small" onClick={() => openEditIncomeRow(row)}>编辑</Button> : null}
          {row.editable && canDeleteIncome ? (
            <Dropdown
              menu={{ items: [{ key: 'delete', label: '删除', danger: true, onClick: () => confirmDelete(row) }] }}
              trigger={['click']}
            >
              <Button type="text" size="small" icon={<MoreOutlined />} />
            </Dropdown>
          ) : null}
        </Space>
      ),
    },
  ]

  const expenseColumns: ColumnsType<CompanyRevenueRow> = [
    {
      title: '日期',
      dataIndex: 'occurred_at',
      width: 118,
      render: (value: string) => dayjs(value).format('DD/MM/YYYY'),
    },
    {
      title: '支出名称',
      dataIndex: 'expense_name',
      width: 180,
      ellipsis: true,
      render: (value, row) => value || row.description || '-',
    },
    {
      title: '类别',
      dataIndex: 'category_label',
      width: 160,
      render: (_value, row) => (
        <span className={styles.categoryCell}>
          <span className={styles.colorDot} style={{ background: CATEGORY_COLORS[row.category] || '#f04444' }} />
          {row.category_label}
        </span>
      ),
    },
    {
      title: '状态',
      key: 'status',
      width: 100,
      align: 'center',
      render: (_value, row) => row.deleted_at
        ? <Tag color="red">已删除</Tag>
        : (String(row.status || '').toLowerCase() === 'void' ? <Tag>已作废</Tag> : <Tag color="green">有效</Tag>),
    },
    {
      title: '金额 (AUD)',
      dataIndex: 'amount',
      width: 145,
      align: 'right',
      render: (value: number) => <span className={styles.tableAmount} style={{ color: '#f04444' }}>${formatAmount(value)}</span>,
    },
    {
      title: '来源/说明',
      key: 'source',
      width: 240,
      ellipsis: true,
      render: (_value, row) => row.description || row.source_label || '-',
    },
    {
      title: '发票',
      key: 'invoice',
      width: 90,
      align: 'center',
      render: (_value, row) => row.invoice_url || row.receipt_id
        ? <Button type="link" size="small" onClick={() => openDetailRow(row)}>查看</Button>
        : '-',
    },
    { title: '备注', dataIndex: 'note', width: 190, ellipsis: true, render: (value) => value || '-' },
    {
      title: '操作',
      key: 'actions',
      width: 170,
      fixed: 'right',
      render: (_value, row) => (
        <Space size={4}>
          <Button type="link" size="small" onClick={() => openDetailRow(row)}>详情</Button>
          {row.editable && canWriteExpense ? <Button type="link" size="small" onClick={() => openEditExpenseRow(row)}>编辑</Button> : null}
          {row.editable && canDeleteExpense ? (
            <Dropdown
              menu={{ items: [{ key: 'delete', label: '删除', danger: true, onClick: () => confirmDelete(row) }] }}
              trigger={['click']}
            >
              <Button type="text" size="small" icon={<MoreOutlined />} />
            </Dropdown>
          ) : null}
        </Space>
      ),
    },
  ]

  const summary = report?.summary
  const netMeta = summary?.net_margin === null || summary?.net_margin === undefined
    ? undefined
    : `净营收率 ${summary.net_margin.toFixed(1)}%`

  return (
    <>
      <Card
        className={styles.pageCard}
        title="公司营收"
        extra={
          <div className={styles.headerActions}>
            {report?.warnings?.length ? (
              <Popover
                placement="bottomRight"
                trigger="click"
                title="数据提示"
                content={
                  <div className={styles.warningPopover}>
                    <Typography.Paragraph type="secondary" className={styles.warningIntro}>
                      以下房源缺少 {monthKey} 可用的管理费率规则，对应管理费暂未计入统计。
                    </Typography.Paragraph>
                    <div className={styles.warningList}>
                      {report.warnings.map((warning, index) => (
                        <div className={styles.warningItem} key={`${warning.property_id || warning.property_code || 'warning'}-${index}`}>
                          <span className={styles.warningIndex}>{index + 1}</span>
                          <div>
                            <Typography.Text strong>{warning.property_code || '未知房源'}</Typography.Text>
                            <div className={styles.warningMessage}>{warning.message}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                }
              >
                <Badge count={report.warnings.length} overflowCount={99} size="small">
                  <Button icon={<BellOutlined />}>数据提示</Button>
                </Badge>
              </Popover>
            ) : null}
            {canIncludeDeleted ? (
              <Tooltip title="已删除和已作废支出仅显示在明细中，永不计入统计">
                <Space size={6}>
                  <Typography.Text type="secondary">包含已删除</Typography.Text>
                  <Switch size="small" checked={includeDeleted} onChange={setIncludeDeleted} />
                </Space>
              </Tooltip>
            ) : null}
            {canWriteIncome ? <Button type="primary" icon={<PlusOutlined />} onClick={openCreateIncome}>新增收入</Button> : null}
            {canWriteExpense ? <Button type="primary" icon={<PlusOutlined />} onClick={openCreateExpense}>新增支出</Button> : null}
          </div>
        }
      >
        <div className={styles.toolbar}>
          <div className={styles.monthControls}>
            <Button aria-label="上个月" icon={<LeftOutlined />} onClick={() => setMonth((value) => value.subtract(1, 'month'))} />
            <DatePicker
              picker="month"
              allowClear={false}
              format="YYYY-MM"
              value={month}
              onChange={(value) => value && setMonth(value)}
            />
            <Button aria-label="下个月" icon={<RightOutlined />} onClick={() => setMonth((value) => value.add(1, 'month'))} />
            <Button onClick={() => setMonth(dayjs())}>本月</Button>
          </div>
          <Segmented
            className={styles.viewSegment}
            options={[
              { label: '经营概览', value: 'overview' },
              { label: '收支明细', value: 'details' },
            ]}
            value={view}
            onChange={(value) => setView(value as 'overview' | 'details')}
          />
        </div>

        <Row gutter={[16, 16]} className={`${styles.kpiRow} ${view === 'details' ? styles.compactKpi : ''}`}>
          <Col xs={24} lg={8}>
            <KpiCard
              title="总收入"
              value={summary?.total_income ?? null}
              color="#0f9f63"
              iconBackground="#eaf8f1"
              icon={<ArrowUpOutlined />}
            />
          </Col>
          <Col xs={24} lg={8}>
            <KpiCard
              title="总支出"
              value={summary?.total_expense ?? null}
              color="#f04444"
              iconBackground="#fff0f0"
              icon={<ArrowDownOutlined />}
            />
          </Col>
          <Col xs={24} lg={8}>
            <KpiCard
              title="净营收"
              value={summary?.net_revenue ?? null}
              color="#0b5bd3"
              iconBackground="#edf4ff"
              icon={<WalletOutlined />}
              primary
              meta={netMeta}
            />
          </Col>
        </Row>

        {view === 'overview' ? (
          <>
            <Row gutter={[16, 16]} className={styles.analysisGrid}>
              {report?.capabilities.can_view_income ? (
                <Col xs={24} xl={12}>
                  <CompanyRevenueComposition
                    kind="income"
                    title="收入构成"
                    total={Number(summary?.total_income || 0)}
                    data={report?.income_categories || []}
                    onSelect={(category) => openDetails('income', category)}
                  />
                </Col>
              ) : null}
              {report?.capabilities.can_view_expense ? (
                <Col xs={24} xl={12}>
                  <CompanyRevenueComposition
                    kind="expense"
                    title="支出构成"
                    total={Number(summary?.total_expense || 0)}
                    data={report?.expense_categories || []}
                    onSelect={(category) => openDetails('expense', category)}
                  />
                </Col>
              ) : null}
            </Row>

            <Card className={styles.summaryCard} title="本月收支摘要" loading={loading}>
              <div className={styles.summaryColumns}>
                <SummaryColumn
                  title="收入类别"
                  data={report?.income_categories || []}
                  color="#0f9f63"
                  onSelect={(category) => openDetails('income', category)}
                />
                <SummaryColumn
                  title="支出类别"
                  data={report?.expense_categories || []}
                  color="#f04444"
                  onSelect={(category) => openDetails('expense', category)}
                />
              </div>
            </Card>
          </>
        ) : (
          <Card className={styles.detailsCard} loading={loading}>
            <div className={styles.detailKindTabs} role="tablist" aria-label="收支明细类型">
              {report?.capabilities.can_view_income ? (
                <button
                  type="button"
                  role="tab"
                  aria-selected={detailKind === 'income'}
                  className={`${styles.detailKindTab} ${detailKind === 'income' ? styles.incomeTabActive : styles.incomeTab}`}
                  onClick={() => {
                    setDetailKind('income')
                    resetFilters()
                  }}
                >
                  <ArrowUpOutlined />
                  收入明细
                </button>
              ) : null}
              {report?.capabilities.can_view_expense ? (
                <button
                  type="button"
                  role="tab"
                  aria-selected={detailKind === 'expense'}
                  className={`${styles.detailKindTab} ${detailKind === 'expense' ? styles.expenseTabActive : styles.expenseTab}`}
                  onClick={() => {
                    setDetailKind('expense')
                    resetFilters()
                  }}
                >
                  <ArrowDownOutlined />
                  支出明细
                </button>
              ) : null}
            </div>

            <div className={styles.filters}>
              <div className={styles.filterField}>
                <span className={styles.filterLabel}>{detailKind === 'income' ? '收入类别' : '支出类别'}</span>
                <Select
                  mode="multiple"
                  maxTagCount="responsive"
                  allowClear
                  value={categoryFilters}
                  onChange={setCategoryFilters}
                  placeholder={detailKind === 'income' ? '全部收入类别' : '全部支出类别'}
                  options={categoryOptions}
                  style={{ width: '100%' }}
                />
              </div>
              <div className={styles.filterField}>
                <span className={styles.filterLabel}>关键词搜索</span>
                <Input
                  allowClear
                  prefix={<SearchOutlined />}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={detailKind === 'income' ? '搜索房号、来源或备注' : '搜索名称、来源或备注'}
                />
              </div>
              <div className={styles.filterField}>
                <span className={styles.filterLabel}>日期范围</span>
                <DatePicker.RangePicker
                  value={dateRange}
                  onChange={(value) => setDateRange(value as [Dayjs | null, Dayjs | null] | null)}
                  format="YYYY-MM-DD"
                  style={{ width: '100%' }}
                />
              </div>
              <div className={styles.filterActions}>
                <Button onClick={resetFilters}>重置</Button>
                <Button icon={<DownloadOutlined />} onClick={exportFilteredRows} disabled={!filteredRows.length}>导出明细</Button>
              </div>
            </div>

            <div className={styles.filterSummary}>
              <span>筛选结果 {filteredRows.length} 条 · 有效合计</span>
              <strong style={{ color: detailKind === 'income' ? '#0f9f63' : '#f04444' }}>${formatAmount(filteredTotal)}</strong>
            </div>

            <Table
              rowKey="id"
              columns={detailKind === 'income' ? incomeColumns : expenseColumns}
              dataSource={filteredRows}
              pagination={{
                defaultPageSize: 20,
                showSizeChanger: true,
                pageSizeOptions: [10, 20, 50, 100],
                showTotal: (total) => `共 ${total} 条`,
              }}
              scroll={{ x: detailKind === 'income' ? 1180 : 1450 }}
              rowClassName={(row) => row.is_effective ? '' : styles.invalidRow}
              onRow={(row) => ({
                onClick: (event: any) => {
                  const target = event?.target as HTMLElement | undefined
                  if (target?.closest?.('button,a,input,textarea,select,.ant-select,.ant-dropdown,.ant-picker')) return
                  openDetailRow(row)
                },
              })}
            />
          </Card>
        )}
      </Card>

      <Drawer
        open={detailOpen}
        onClose={() => {
          setDetailOpen(false)
          setDetailRow(null)
        }}
        title={detailRow?.kind === 'expense' ? '支出详情' : '收入详情'}
        width={600}
        footer={
          <div className={styles.drawerFooter}>
            <Button onClick={() => setDetailOpen(false)}>关闭</Button>
            {detailRow?.editable && (
              (detailRow.kind === 'income' && canWriteIncome) || (detailRow.kind === 'expense' && canWriteExpense)
            ) ? (
              <Button type="primary" onClick={() => {
                const row = detailRow
                setDetailOpen(false)
                if (row.kind === 'income') openEditIncomeRow(row)
                else openEditExpenseRow(row)
              }}>编辑记录</Button>
            ) : null}
          </div>
        }
      >
        {detailRow ? (
          <>
            <Descriptions bordered size="small" column={1}>
              <Descriptions.Item label="日期">{detailRow.occurred_at || '-'}</Descriptions.Item>
              <Descriptions.Item label="类别">{detailRow.category_label}</Descriptions.Item>
              <Descriptions.Item label="金额">${formatAmount(detailRow.amount)}</Descriptions.Item>
              <Descriptions.Item label="房号">{detailRow.property_code || '-'}</Descriptions.Item>
              <Descriptions.Item label="来源">{detailRow.source_label || '-'}</Descriptions.Item>
              <Descriptions.Item label="说明">{detailRow.description || '-'}</Descriptions.Item>
              {detailRow.calculation ? <Descriptions.Item label="计算方式">{detailRow.calculation}</Descriptions.Item> : null}
              {detailRow.ref_id ? <Descriptions.Item label="关联记录">{detailRow.ref_type || '记录'} / {detailRow.ref_id}</Descriptions.Item> : null}
              {detailRow.kind === 'expense' ? <Descriptions.Item label="支出名称">{detailRow.expense_name || '-'}</Descriptions.Item> : null}
              <Descriptions.Item label="备注">{detailRow.note || '-'}</Descriptions.Item>
              {detailRow.kind === 'expense' && !detailRow.is_effective ? (
                <>
                  <Descriptions.Item label="状态">{detailRow.deleted_at ? '已删除' : '已作废'}</Descriptions.Item>
                  {detailRow.deleted_at ? <Descriptions.Item label="删除时间">{String(detailRow.deleted_at)}</Descriptions.Item> : null}
                  {detailRow.deleted_by ? <Descriptions.Item label="删除人">{detailRow.deleted_by}</Descriptions.Item> : null}
                  {detailRow.delete_source ? <Descriptions.Item label="删除来源">{detailRow.delete_source}</Descriptions.Item> : null}
                </>
              ) : null}
              {detailRow.kind === 'expense' ? (
                <Descriptions.Item label="发票">
                  <Space wrap>
                    {expenseInvoices.length ? expenseInvoices.map((item) => (
                      <Button key={item.id} size="small" onClick={() => {
                        const url = absUrl(item.url)
                        if (url) window.open(url, '_blank', 'noopener,noreferrer')
                      }}>
                        {item.file_name || '查看发票'}
                      </Button>
                    )) : (detailRow.invoice_url ? (
                      <Button size="small" onClick={() => {
                        const url = absUrl(detailRow.invoice_url)
                        if (url) window.open(url, '_blank', 'noopener,noreferrer')
                      }}>查看发票</Button>
                    ) : '-')}
                  </Space>
                </Descriptions.Item>
              ) : null}
            </Descriptions>

            {detailRow.kind === 'expense' && receiptDetail ? (
              <>
                <Divider orientation="left">原始发票</Divider>
                <Descriptions bordered size="small" column={1}>
                  <Descriptions.Item label="发票日期">{String(receiptDetail.receipt_date || '').slice(0, 10) || '-'}</Descriptions.Item>
                  <Descriptions.Item label="发票总金额">${formatAmount(Number(receiptDetail.receipt_total_amount || 0))}</Descriptions.Item>
                  <Descriptions.Item label="支出范围">{receiptDetail.scope_summary || '-'}</Descriptions.Item>
                  <Descriptions.Item label="发票备注">{receiptDetail.note || '-'}</Descriptions.Item>
                  <Descriptions.Item label="发票图片">
                    <Space wrap>
                      {(receiptDetail.images || []).length ? (receiptDetail.images || []).map((item) => (
                        <Button key={item.id} size="small" onClick={() => {
                          const url = absUrl(item.url)
                          if (url) window.open(url, '_blank', 'noopener,noreferrer')
                        }}>查看图片</Button>
                      )) : '-'}
                    </Space>
                  </Descriptions.Item>
                </Descriptions>
                <Table
                  size="small"
                  pagination={false}
                  rowKey="id"
                  style={{ marginTop: 12 }}
                  columns={[
                    { title: '#', dataIndex: 'line_no', width: 54 },
                    { title: '归属', render: (_value, row: any) => row.scope === 'property' ? '房源支出' : '公司支出' },
                    { title: '房号/对象', render: (_value, row: any) => row.scope === 'property' ? (row.property_code || row.property_address || '-') : '公司' },
                    { title: '支出名称', dataIndex: 'expense_name' },
                    { title: '金额', render: (_value, row: any) => `$${formatAmount(Number(row.amount || 0))}` },
                    { title: '类别', render: (_value, row: any) => row.category === 'other' ? `其他 · ${row.category_detail || ''}` : (row.category || '-') },
                  ]}
                  dataSource={receiptDetail.items || []}
                  scroll={{ x: 720 }}
                />
              </>
            ) : null}

            {detailRow.record_id ? (
              <>
                <Divider orientation="left">操作记录</Divider>
                <AuditTrail refs={[
                  { entity: detailRow.kind === 'income' ? 'company_incomes' : 'company_expenses', entity_id: detailRow.record_id },
                  { entity: detailRow.kind === 'income' ? 'CompanyIncome' : 'CompanyExpense', entity_id: detailRow.record_id },
                ]} />
              </>
            ) : null}
          </>
        ) : null}
      </Drawer>

      <Modal
        title={editingIncome ? '编辑收入' : '记录收入'}
        open={incomeOpen}
        onCancel={() => {
          setIncomeOpen(false)
          setEditingIncome(null)
        }}
        onOk={submitIncome}
        confirmLoading={savingIncome}
      >
        <Form form={incomeForm} layout="vertical">
          <Form.Item name="date" label="日期" rules={[{ required: true, message: '请选择日期' }]}>
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="amount" label="金额" rules={[{ required: true, message: '请输入金额' }]}>
            <InputNumber min={0} precision={2} step={1} style={{ width: '100%' }} prefix="$" />
          </Form.Item>
          <Form.Item name="category" label="类别" rules={[{ required: true, message: '请选择类别' }]}>
            <Select options={COMPANY_INCOME_CATEGORY_OPTIONS} />
          </Form.Item>
          <Form.Item name="property_id" label="房号（可选）">
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              filterOption={(input, option) => String((option as any)?.label || '').toLowerCase().includes(String(input || '').toLowerCase())}
              options={sortProperties(properties).map((property) => ({
                value: property.id,
                label: property.code || property.address || property.id,
              }))}
            />
          </Form.Item>
          <Form.Item name="note" label="备注"><Input /></Form.Item>
        </Form>
        {editingIncome?.record_id ? (
          <>
            <Divider orientation="left">操作记录</Divider>
            <AuditTrail refs={[
              { entity: 'company_incomes', entity_id: editingIncome.record_id },
              { entity: 'CompanyIncome', entity_id: editingIncome.record_id },
            ]} />
          </>
        ) : null}
      </Modal>

      <Modal
        title={editingExpense ? '编辑支出' : '记录支出'}
        open={expenseOpen}
        onCancel={() => {
          setExpenseOpen(false)
          setEditingExpense(null)
          setExpenseInvoiceFiles([])
        }}
        onOk={submitExpense}
        confirmLoading={savingExpense}
      >
        <Form form={expenseForm} layout="vertical">
          <Form.Item name="date" label="日期" rules={[{ required: true, message: '请选择日期' }]}>
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="amount" label="金额" rules={[{ required: true, message: '请输入金额' }]}>
            <InputNumber min={0} precision={2} step={1} style={{ width: '100%' }} prefix="$" />
          </Form.Item>
          <Form.Item name="category" label="类别" rules={[{ required: true, message: '请选择类别' }]}>
            <Select options={COMPANY_EXPENSE_CATEGORY_OPTIONS} />
          </Form.Item>
          <Form.Item name="expense_name" label="支出名称"><Input /></Form.Item>
          <Form.Item noStyle shouldUpdate>
            {() => expenseForm.getFieldValue('category') === 'other' ? (
              <Form.Item name="other_detail" label="其他支出描述" rules={[{ required: true, message: '请输入描述' }]}>
                <Input />
              </Form.Item>
            ) : null}
          </Form.Item>
          <Form.Item name="note" label="备注"><Input /></Form.Item>
          <Form.Item name="invoice_url" label="发票（可选）">
            <Upload
              fileList={expenseInvoiceFiles}
              maxCount={1}
              onRemove={() => {
                expenseForm.setFieldsValue({ invoice_url: undefined })
                setExpenseInvoiceFiles([])
                return true
              }}
              customRequest={async (options: any) => {
                const file = options?.file as File
                try {
                  const url = await uploadInvoice(file)
                  expenseForm.setFieldsValue({ invoice_url: url })
                  setExpenseInvoiceFiles([{
                    uid: String((file as any)?.uid || Date.now()),
                    name: String((file as any)?.name || 'invoice'),
                    status: 'done',
                    url: absUrl(url),
                  }])
                  options?.onSuccess?.({ url })
                } catch (error: any) {
                  setExpenseInvoiceFiles([{
                    uid: String((file as any)?.uid || Date.now()),
                    name: String((file as any)?.name || 'invoice'),
                    status: 'error',
                  }])
                  message.error(error?.message || '上传失败')
                  options?.onError?.(error)
                }
              }}
            >
              <Button>上传发票</Button>
            </Upload>
          </Form.Item>
        </Form>
        {editingExpense?.record_id ? (
          <>
            <Divider orientation="left">操作记录</Divider>
            <AuditTrail refs={[
              { entity: 'company_expenses', entity_id: editingExpense.record_id },
              { entity: 'CompanyExpense', entity_id: editingExpense.record_id },
            ]} />
          </>
        ) : null}
      </Modal>

    </>
  )
}
