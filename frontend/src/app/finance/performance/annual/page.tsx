"use client"

import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
  Descriptions,
  Drawer,
  Empty,
  Input,
  InputNumber,
  List,
  Progress,
  Select,
  Space,
  Spin,
  Statistic,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd'
import { EditOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import FiscalYearStatement from '../../../../components/FiscalYearStatement'
import TableRowActions from '../../../../components/TableRowActions'
import { deleteJSON, getJSON, putJSON } from '../../../../lib/api'
import { hasPerm } from '../../../../lib/auth'
import {
  ANNUAL_REPORT_LANGUAGE_OPTIONS,
  ANNUAL_REPORT_LINE_LABELS,
  SUPPORTED_ANNUAL_REPORT_FISCAL_YEARS,
  annualReportHasIssues,
  canDownloadAnnualReport,
  formatAnnualReportFilename,
  formatAnnualReportMoney,
  formatAnnualReportWarningMessage,
  type AnnualReportLanguage,
  type AnnualPropertyReport,
  type AnnualReportLineKey,
  type AnnualReportMonth,
  type AnnualReportSummaryStatus,
} from '../../../../lib/annualReport'
import { exportElementToPdfBlob } from '../../../../lib/pdfExport'
import styles from './page.module.scss'

type AnnualReportSummary = {
  property: { id: string; code: string | null; address: string | null; region: string | null }
  report_status: AnnualReportSummaryStatus
  complete_month_count: number
  missing_month_count: number
  warning_count: number
}
type AnnualReportSummaryResponse = { fiscal_year: number; reports: AnnualReportSummary[] }
type ReportStatusFilter = 'all' | AnnualReportSummaryStatus
type WorkspaceTab = 'overview' | 'months' | 'preview'

type ManualDraft = {
  is_complete: boolean
  note: string
  lines: Record<AnnualReportLineKey, number | null>
}

const MANUAL_ROW_KEYS: AnnualReportLineKey[] = [
  'rent_income',
  'other_income',
  'management_fee',
  'consumables',
  'electricity',
  'gas',
  'water',
  'internet',
  'carpark',
  'council',
  'bodycorp',
  'other_expense',
]

const REPORT_STATUS_META: Record<AnnualReportSummaryStatus, { color: string; label: string }> = {
  complete: { color: 'green', label: '完整' },
  draft_incomplete: { color: 'orange', label: '待补录' },
  unavailable: { color: 'red', label: '无法读取' },
}

const MONTH_STATUS_META: Record<AnnualReportMonth['status'], { color: string; label: string }> = {
  complete: { color: 'green', label: '完整' },
  missing_manual: { color: 'orange', label: '待补录' },
  missing_system_data: { color: 'red', label: '系统数据缺失' },
  warning: { color: 'gold', label: '警告' },
}

function buildDraftFromReport(report: AnnualPropertyReport | null) {
  const out: Record<string, ManualDraft> = {}
  for (const month of report?.months || []) {
    if (!month.editable) continue
    out[month.month_key] = {
      is_complete: month.is_complete,
      note: month.note || '',
      lines: { ...month.lines },
    }
  }
  return out
}

function emptyManualLines() {
  return MANUAL_ROW_KEYS.reduce((out, key) => {
    out[key] = null
    return out
  }, {} as Record<AnnualReportLineKey, number | null>)
}

function normalizeManualDraftForSave(draft: ManualDraft): ManualDraft {
  const lines = { ...draft.lines }
  if (draft.is_complete) {
    for (const key of MANUAL_ROW_KEYS) {
      if (lines[key] == null) lines[key] = 0
    }
  }
  return { ...draft, lines }
}

function summaryIssueCount(summary: AnnualReportSummary | null | undefined) {
  return Number(summary?.missing_month_count || 0) + Number(summary?.warning_count || 0)
}

function propertyTitle(summary: AnnualReportSummary | null | undefined, report: AnnualPropertyReport | null) {
  return summary?.property.code || report?.property.code || summary?.property.address || report?.property.address || '-'
}

function reportStatusTag(status: AnnualReportSummaryStatus) {
  const meta = REPORT_STATUS_META[status]
  return <Tag color={meta.color}>{meta.label}</Tag>
}

function monthStatusTag(month: AnnualReportMonth) {
  const meta = MONTH_STATUS_META[month.status]
  return <Tag color={meta.color}>{meta.label}</Tag>
}

export default function AnnualReportPage() {
  const { message, modal } = App.useApp()
  const [fiscalYear, setFiscalYear] = useState<number>(SUPPORTED_ANNUAL_REPORT_FISCAL_YEARS[0])
  const [reportLanguage, setReportLanguage] = useState<AnnualReportLanguage>('bilingual')
  const [statusFilter, setStatusFilter] = useState<ReportStatusFilter>('all')
  const [regionFilter, setRegionFilter] = useState<string>('all')
  const [searchText, setSearchText] = useState('')
  const [propertyId, setPropertyId] = useState<string | undefined>(undefined)
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>('overview')
  const [reportSummaries, setReportSummaries] = useState<AnnualReportSummary[]>([])
  const [summariesLoading, setSummariesLoading] = useState(false)
  const [summariesLoadError, setSummariesLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [reportLoadError, setReportLoadError] = useState<string | null>(null)
  const [savingManualMonths, setSavingManualMonths] = useState(false)
  const [deletingMonthKey, setDeletingMonthKey] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [report, setReport] = useState<AnnualPropertyReport | null>(null)
  const [draftByMonth, setDraftByMonth] = useState<Record<string, ManualDraft>>({})
  const [dirtyMonthKeys, setDirtyMonthKeys] = useState<Set<string>>(new Set())
  const [editOpen, setEditOpen] = useState(false)
  const [activeEditMonthKey, setActiveEditMonthKey] = useState<string | null>(null)
  const canEditAnnualReport = hasPerm('finance.payout')
  const reportRequestRef = useRef(0)
  const printRef = useRef<HTMLDivElement>(null)

  const loadReportSummaries = useCallback(async () => {
    setSummariesLoading(true)
    setSummariesLoadError(null)
    try {
      const response = await getJSON<AnnualReportSummaryResponse>(`/finance/annual-report/summaries?${new URLSearchParams({ fy: String(fiscalYear) }).toString()}`)
      setReportSummaries(Array.isArray(response?.reports) ? response.reports : [])
    } catch {
      setReportSummaries([])
      setSummariesLoadError('年度报告记录加载失败，请刷新后重试。')
    } finally {
      setSummariesLoading(false)
    }
  }, [fiscalYear])

  useEffect(() => {
    loadReportSummaries().catch(() => {})
  }, [loadReportSummaries])

  const loadReport = useCallback(async (pid: string) => {
    const targetPropertyId = String(pid || '').trim()
    if (!targetPropertyId) return
    const requestId = reportRequestRef.current + 1
    reportRequestRef.current = requestId
    setLoading(true)
    setReportLoadError(null)
    try {
      const nextReport = await getJSON<AnnualPropertyReport>(`/finance/annual-report?${new URLSearchParams({ property_id: targetPropertyId, fy: String(fiscalYear) }).toString()}`)
      if (requestId !== reportRequestRef.current) return
      setReport(nextReport)
      setDraftByMonth(buildDraftFromReport(nextReport))
      setDirtyMonthKeys(new Set())
      setActiveEditMonthKey((current) => {
        if (current && nextReport.months.some((month) => month.month_key === current)) return current
        return nextReport.months.find((month) => month.editable && !month.is_complete)?.month_key
          || nextReport.months.find((month) => month.editable)?.month_key
          || nextReport.months[0]?.month_key
          || null
      })
    } catch (error: any) {
      if (requestId !== reportRequestRef.current) return
      setReport(null)
      setDraftByMonth({})
      setDirtyMonthKeys(new Set())
      setReportLoadError(error?.message || '加载年度报告失败')
    } finally {
      if (requestId === reportRequestRef.current) setLoading(false)
    }
  }, [fiscalYear])

  useEffect(() => {
    if (!propertyId) {
      reportRequestRef.current += 1
      setLoading(false)
      setReport(null)
      setReportLoadError(null)
      setDraftByMonth({})
      setDirtyMonthKeys(new Set())
      return
    }
    loadReport(propertyId).catch(() => {})
  }, [loadReport, propertyId])

  const regionOptions = useMemo(() => Array.from(new Set(
    reportSummaries.map((summary) => String(summary.property.region || '').trim()).filter(Boolean),
  )).sort((left, right) => left.localeCompare(right)), [reportSummaries])

  const filteredSummaries = useMemo(() => {
    const query = searchText.trim().toLowerCase()
    return reportSummaries.filter((summary) => {
      if (statusFilter !== 'all' && summary.report_status !== statusFilter) return false
      if (regionFilter !== 'all' && String(summary.property.region || '') !== regionFilter) return false
      if (!query) return true
      return [summary.property.code, summary.property.address, summary.property.region]
        .some((value) => String(value || '').toLowerCase().includes(query))
    })
  }, [regionFilter, reportSummaries, searchText, statusFilter])

  const selectedSummary = useMemo(
    () => reportSummaries.find((summary) => summary.property.id === propertyId) || null,
    [propertyId, reportSummaries],
  )
  const activeEditMonth = useMemo(
    () => report?.months.find((month) => month.month_key === activeEditMonthKey) || null,
    [activeEditMonthKey, report],
  )
  const manualMonths = useMemo(() => (report?.months || []).filter((month) => month.editable), [report])
  const downloadLabel = report && annualReportHasIssues(report) ? '下载草稿' : '下载 PDF'

  const resetDrafts = useCallback(() => {
    setDraftByMonth(buildDraftFromReport(report))
    setDirtyMonthKeys(new Set())
  }, [report])

  const afterDiscardCheck = useCallback((action: () => void) => {
    if (!dirtyMonthKeys.size) {
      action()
      return
    }
    modal.confirm({
      title: '放弃未保存的修改？',
      content: `当前有 ${dirtyMonthKeys.size} 个月份尚未保存。`,
      okText: '放弃修改',
      cancelText: '继续编辑',
      okButtonProps: { danger: true },
      onOk: () => {
        resetDrafts()
        action()
      },
    })
  }, [dirtyMonthKeys.size, modal, resetDrafts])

  const selectReport = useCallback((summary: AnnualReportSummary, tab: WorkspaceTab = 'overview') => {
    afterDiscardCheck(() => {
      const nextPropertyId = summary.property.id
      if (nextPropertyId !== propertyId) {
        setReport(null)
        setReportLoadError(null)
      }
      setPropertyId(nextPropertyId)
      setWorkspaceTab(tab)
    })
  }, [afterDiscardCheck, propertyId])

  const openEditor = useCallback((summary?: AnnualReportSummary) => {
    if (!canEditAnnualReport) return
    afterDiscardCheck(() => {
      if (summary && summary.property.id !== propertyId) {
        setReport(null)
        setReportLoadError(null)
        setPropertyId(summary.property.id)
      }
      setWorkspaceTab('months')
      setEditOpen(true)
    })
  }, [afterDiscardCheck, canEditAnnualReport, propertyId])

  const closeEditor = useCallback(() => {
    afterDiscardCheck(() => setEditOpen(false))
  }, [afterDiscardCheck])

  const handleFiscalYearChange = (value: number) => {
    afterDiscardCheck(() => {
      reportRequestRef.current += 1
      setFiscalYear(value)
      setPropertyId(undefined)
      setReport(null)
      setWorkspaceTab('overview')
      setEditOpen(false)
    })
  }

  const updateDraftValue = (monthKey: string, key: AnnualReportLineKey, value: number | null) => {
    setDirtyMonthKeys((previous) => new Set(previous).add(monthKey))
    setDraftByMonth((previous) => ({
      ...previous,
      [monthKey]: {
        ...(previous[monthKey] || { is_complete: true, note: '', lines: emptyManualLines() }),
        lines: {
          ...(previous[monthKey]?.lines || {}),
          [key]: value,
        },
      },
    }))
  }

  const updateDraftMeta = (monthKey: string, patch: Partial<ManualDraft>) => {
    setDirtyMonthKeys((previous) => new Set(previous).add(monthKey))
    setDraftByMonth((previous) => {
      const current = previous[monthKey] || { is_complete: true, note: '', lines: emptyManualLines() }
      const next = { ...current, ...patch, lines: { ...current.lines, ...(patch.lines || {}) } }
      return { ...previous, [monthKey]: patch.is_complete ? normalizeManualDraftForSave(next) : next }
    })
  }

  const saveManualMonths = async () => {
    if (!propertyId || !report || !canEditAnnualReport) return
    const pendingMonths = manualMonths.filter((month) => dirtyMonthKeys.has(month.month_key))
    if (!pendingMonths.length) {
      message.info('没有待保存的修改')
      return
    }
    setSavingManualMonths(true)
    try {
      for (const month of pendingMonths) {
        const draft = normalizeManualDraftForSave(draftByMonth[month.month_key] || {
          is_complete: false,
          note: '',
          lines: emptyManualLines(),
        })
        await putJSON(`/finance/annual-report/manual-months/${encodeURIComponent(propertyId)}/${encodeURIComponent(month.month_key)}`, {
          currency: report.totals.currency || 'AUD',
          note: draft.note || null,
          is_complete: draft.is_complete,
          ...draft.lines,
        })
      }
      await Promise.all([loadReport(propertyId), loadReportSummaries()])
      message.success(`已保存 ${pendingMonths.length} 个月份的修改`)
    } catch (error: any) {
      message.error(error?.message || '保存修改失败')
    } finally {
      setSavingManualMonths(false)
    }
  }

  const deleteManualMonth = async (monthKey: string) => {
    if (!propertyId || !canEditAnnualReport) return
    setDeletingMonthKey(monthKey)
    try {
      await deleteJSON(`/finance/annual-report/manual-months/${encodeURIComponent(propertyId)}/${encodeURIComponent(monthKey)}`)
      await Promise.all([loadReport(propertyId), loadReportSummaries()])
      message.success(`${monthKey} 的手工记录已删除`)
    } catch (error: any) {
      message.error(error?.message || '删除失败')
    } finally {
      setDeletingMonthKey(null)
    }
  }

  const confirmDeleteManualMonth = (monthKey: string) => {
    modal.confirm({
      title: `删除 ${monthKey} 的手工记录？`,
      content: '删除后该月份会回到待补录状态，不会自动改用系统数据。',
      okText: '删除',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: () => deleteManualMonth(monthKey),
    })
  }

  const downloadPdf = async () => {
    if (!printRef.current || !report) return
    setExporting(true)
    try {
      const { blob } = await exportElementToPdfBlob({
        element: printRef.current,
        orientation: 'l',
        rootWidthMm: 277,
        marginMm: 12,
        scale: 3,
        imageQuality: 0.95,
        imageType: 'png',
      })
      const anchor = document.createElement('a')
      const url = URL.createObjectURL(blob)
      anchor.href = url
      anchor.download = formatAnnualReportFilename({
        fiscalYear: report.fiscal_year,
        propertyCode: report.property.code,
        propertyAddress: report.property.address,
      })
      document.body.appendChild(anchor)
      anchor.click()
      document.body.removeChild(anchor)
      URL.revokeObjectURL(url)
    } catch (error: any) {
      message.error(error?.message || '导出 PDF 失败')
    } finally {
      setExporting(false)
    }
  }

  const overviewMonthColumns = [
    { title: '月份', dataIndex: 'month_key', width: 90 },
    {
      title: '来源',
      dataIndex: 'source',
      width: 90,
      render: (source: AnnualReportMonth['source']) => source === 'manual' ? '手工' : '系统',
    },
    { title: '状态', key: 'status', width: 125, render: (_: unknown, month: AnnualReportMonth) => monthStatusTag(month) },
    {
      title: '完成情况',
      key: 'progress',
      width: 125,
      render: (_: unknown, month: AnnualReportMonth) => (
        <Progress percent={month.is_complete ? 100 : 0} size="small" showInfo={false} status={month.is_complete ? 'success' : 'normal'} />
      ),
    },
    { title: '问题数量', key: 'issues', width: 90, align: 'right' as const, render: (_: unknown, month: AnnualReportMonth) => month.warnings.length },
  ]

  const detailMonthColumns = [
    ...overviewMonthColumns.slice(0, 3),
    { title: '收入', dataIndex: 'income', width: 120, align: 'right' as const, render: formatAnnualReportMoney },
    { title: '支出', dataIndex: 'expense', width: 120, align: 'right' as const, render: formatAnnualReportMoney },
    { title: '净收入', dataIndex: 'net_income', width: 120, align: 'right' as const, render: formatAnnualReportMoney },
    { title: '备注', dataIndex: 'note', width: 180, ellipsis: true, render: (value: string | null) => value || '-' },
    {
      title: '操作',
      key: 'actions',
      width: 90,
      fixed: 'right' as const,
      render: (_: unknown, month: AnnualReportMonth) => month.editable && canEditAnnualReport ? (
        <TableRowActions actions={[{
          key: 'edit',
          label: '编辑',
          onClick: () => {
            setActiveEditMonthKey(month.month_key)
            setEditOpen(true)
          },
        }]} />
      ) : '-',
    },
  ]

  const workspaceTabs = report ? [
    {
      key: 'overview',
      label: '概览',
      children: (
        <div className={styles.overviewGrid}>
          <div className={styles.overviewMain}>
            <div className={styles.metricsGrid}>
              <Card size="small"><Statistic title="年度状态" value={report.report_status === 'complete' ? '完整' : '待补录'} valueStyle={{ color: report.report_status === 'complete' ? '#389e0d' : '#d46b08', fontSize: 22 }} /></Card>
              <Card size="small"><Statistic title="完成月份" value={report.totals.complete_month_count} suffix="/ 12" /></Card>
              <Card size="small"><Statistic title="待处理" value={summaryIssueCount(selectedSummary)} suffix="项" /></Card>
              <Card size="small"><Statistic title="年度净收入" value={formatAnnualReportMoney(report.totals.net_income)} /></Card>
            </div>

            <Card size="small" title="月份完整度" className={styles.innerCard}>
              <Table
                rowKey="month_key"
                size="small"
                pagination={false}
                dataSource={report.months}
                columns={overviewMonthColumns}
                scroll={{ x: 520 }}
              />
            </Card>
          </div>

          <div className={styles.overviewAside}>
            <Card size="small" title="报告信息" className={styles.innerCard}>
              <Descriptions column={1} size="small" colon={false}>
                <Descriptions.Item label="房源">{propertyTitle(selectedSummary, report)}</Descriptions.Item>
                <Descriptions.Item label="财年">FY{report.fiscal_year}</Descriptions.Item>
                <Descriptions.Item label="期间">{report.period_start} 至 {report.period_end}</Descriptions.Item>
                <Descriptions.Item label="房东">{report.report_owner_snapshot?.name || report.report_owner_snapshot?.company_name || '-'}</Descriptions.Item>
              </Descriptions>
            </Card>

            <Card
              size="small"
              title="待处理事项"
              extra={<Tag color={report.warnings.length ? 'orange' : 'green'}>{report.warnings.length}</Tag>}
              className={styles.innerCard}
            >
              {report.warnings.length ? (
                <List
                  size="small"
                  dataSource={report.warnings}
                  renderItem={(warning) => (
                    <List.Item>
                      <div>
                        {warning.month_key ? <Tag>{warning.month_key}</Tag> : null}
                        <span>{formatAnnualReportWarningMessage(warning, reportLanguage)}</span>
                      </div>
                    </List.Item>
                  )}
                />
              ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无待处理事项" />}
            </Card>
          </div>
        </div>
      ),
    },
    {
      key: 'months',
      label: '12个月数据',
      children: (
        <Card
          size="small"
          title="月份数据"
          extra={canEditAnnualReport ? <Button icon={<EditOutlined />} onClick={() => openEditor()}>编辑手工月份</Button> : null}
          className={styles.innerCard}
        >
          <Alert
            type="info"
            showIcon
            message="系统月份由营收数据生成，仅手工月份、完整状态和备注可以修改。"
            className={styles.sectionAlert}
          />
          <Table
            rowKey="month_key"
            size="small"
            pagination={false}
            dataSource={report.months}
            columns={detailMonthColumns}
            scroll={{ x: 1050 }}
          />
        </Card>
      ),
    },
    {
      key: 'preview',
      label: '报告预览',
      children: (
        <div className={styles.previewViewport}>
          {annualReportHasIssues(report) ? (
            <Alert
              type="warning"
              showIcon
              message="当前为待补录草稿"
              description="预览会保留缺失月份和警告标识；补录并保存后，报告状态会自动更新。"
              className={styles.sectionAlert}
            />
          ) : null}
          <div className={styles.previewSurface}>
            <FiscalYearStatement report={report} showChinese={reportLanguage === 'bilingual'} />
          </div>
        </div>
      ),
    },
  ] : []

  return (
    <Card title="房源年度报告" className={styles.pageCard}>
      <div className={styles.filters}>
        <Select
          value={fiscalYear}
          onChange={handleFiscalYearChange}
          className={styles.filterControl}
          options={SUPPORTED_ANNUAL_REPORT_FISCAL_YEARS.map((value) => ({ value, label: `FY${value}` }))}
        />
        <Select
          value={reportLanguage}
          onChange={setReportLanguage}
          className={styles.languageControl}
          options={ANNUAL_REPORT_LANGUAGE_OPTIONS.map((value) => ({
            value,
            label: value === 'en' ? 'English' : 'English + 中文',
          }))}
        />
        <Select<ReportStatusFilter>
          value={statusFilter}
          onChange={setStatusFilter}
          className={styles.statusControl}
          options={[
            { value: 'all', label: '状态：全部' },
            { value: 'complete', label: '状态：完整' },
            { value: 'draft_incomplete', label: '状态：待补录' },
            { value: 'unavailable', label: '状态：无法读取' },
          ]}
        />
        <Select
          value={regionFilter}
          onChange={setRegionFilter}
          className={styles.regionControl}
          options={[{ value: 'all', label: '区域：全部' }, ...regionOptions.map((region) => ({ value: region, label: region }))]}
        />
        <Space.Compact className={styles.searchControl}>
          <Input
            allowClear
            value={searchText}
            onChange={(event) => setSearchText(event.target.value)}
            placeholder="搜索房号或地址"
          />
          <Button aria-label="搜索" icon={<SearchOutlined />} />
        </Space.Compact>
        <Button icon={<ReloadOutlined />} loading={summariesLoading} onClick={() => loadReportSummaries().catch(() => {})}>刷新</Button>
      </div>

      {summariesLoadError ? (
        <Alert
          type="error"
          showIcon
          className={styles.loadAlert}
          message="年度报告记录加载失败"
          description={summariesLoadError}
          action={<Button size="small" onClick={() => loadReportSummaries().catch(() => {})}>重试</Button>}
        />
      ) : null}

      <div className={styles.workspaceGrid}>
        <Card
          size="small"
          title={`FY${fiscalYear} 年度报告记录`}
          extra={<Typography.Text type="secondary">{filteredSummaries.length}/{reportSummaries.length} 个房源</Typography.Text>}
          className={styles.listCard}
        >
          <Table
            rowKey={(summary) => summary.property.id}
            loading={summariesLoading}
            size="small"
            pagination={{ pageSize: 20, showSizeChanger: false }}
            dataSource={filteredSummaries}
            rowClassName={(summary) => summary.property.id === propertyId ? styles.selectedRow : ''}
            onRow={(summary) => ({
              onClick: () => selectReport(summary, 'overview'),
            })}
            columns={[
              {
                title: '房源',
                key: 'property',
                width: 160,
                render: (_: unknown, summary: AnnualReportSummary) => (
                  <div>
                    <div className={styles.propertyCode}>{summary.property.code || summary.property.address || summary.property.id}</div>
                    {summary.property.address && summary.property.address !== summary.property.code ? (
                      <div className={styles.propertyMeta}>{summary.property.address}</div>
                    ) : null}
                    <div className={styles.propertyProgress}>{summary.complete_month_count}/12 个月 · {summaryIssueCount(summary)} 项待处理</div>
                  </div>
                ),
              },
              { title: '区域', dataIndex: ['property', 'region'], width: 80, ellipsis: true, render: (value: string | null) => value || '-' },
              { title: '状态', dataIndex: 'report_status', width: 70, render: reportStatusTag },
              {
                title: '操作',
                key: 'actions',
                width: 130,
                fixed: 'right' as const,
                render: (_: unknown, summary: AnnualReportSummary) => (
                  <div onClick={(event) => event.stopPropagation()}>
                    <TableRowActions actions={[
                      { key: 'detail', label: '详情', onClick: () => selectReport(summary, 'overview') },
                      { key: 'edit', label: '编辑', onClick: () => openEditor(summary), hidden: !canEditAnnualReport || summary.report_status === 'unavailable' },
                    ]} />
                  </div>
                ),
              },
            ]}
            scroll={{ x: 440, y: 'calc(100vh - 370px)' }}
          />
        </Card>

        <Card className={styles.reportCard} styles={{ body: { paddingTop: 8 } }}>
          {!propertyId ? (
            <div className={styles.emptyWorkspace}>
              <Empty description="请选择左侧房源查看年度报告" />
            </div>
          ) : null}

          {propertyId && loading ? (
            <div className={styles.emptyWorkspace}><Spin /></div>
          ) : null}

          {propertyId && !loading && reportLoadError ? (
            <Alert
              type="error"
              showIcon
              message="年度报告加载失败"
              description={reportLoadError}
              action={<Button size="small" onClick={() => loadReport(propertyId).catch(() => {})}>重试</Button>}
            />
          ) : null}

          {propertyId && !loading && report ? (
            <>
              <div className={styles.reportHeader}>
                <div>
                  <Space align="center" wrap>
                    <Typography.Title level={4} className={styles.reportTitle}>{propertyTitle(selectedSummary, report)} 年度报告</Typography.Title>
                    {reportStatusTag(report.report_status)}
                  </Space>
                  <Typography.Text type="secondary">FY{report.fiscal_year}{selectedSummary?.property.region ? ` · ${selectedSummary.property.region}` : ''}</Typography.Text>
                  {report.property.address ? <div className={styles.reportAddress}>{report.property.address}</div> : null}
                </div>
                <TableRowActions actions={[
                  { key: 'detail', label: '详情', onClick: () => setWorkspaceTab('overview') },
                  { key: 'edit', label: '编辑', onClick: () => openEditor(), hidden: !canEditAnnualReport },
                  { key: 'preview', label: '预览', onClick: () => setWorkspaceTab('preview') },
                  { key: 'download', label: downloadLabel, onClick: () => downloadPdf().catch(() => {}), loading: exporting, disabled: !canDownloadAnnualReport(report, propertyId) },
                ]} />
              </div>

              <Tabs
                activeKey={workspaceTab}
                onChange={(key) => setWorkspaceTab(key as WorkspaceTab)}
                items={workspaceTabs}
              />
            </>
          ) : null}
        </Card>
      </div>

      <Drawer
        title="编辑年度报告"
        width={860}
        open={editOpen}
        maskClosable={!dirtyMonthKeys.size}
        closable={!savingManualMonths}
        onClose={closeEditor}
        destroyOnClose={false}
        extra={report ? <Tag color={report.report_status === 'complete' ? 'green' : 'orange'}>{report.report_status === 'complete' ? '完整' : '待补录'}</Tag> : null}
        footer={(
          <div className={styles.drawerFooter}>
            <Typography.Text type={dirtyMonthKeys.size ? 'warning' : 'secondary'}>
              {dirtyMonthKeys.size ? `${dirtyMonthKeys.size} 个月份有未保存修改` : '当前没有未保存修改'}
            </Typography.Text>
            <Space>
              <Button onClick={closeEditor} disabled={savingManualMonths}>取消</Button>
              <Button type="primary" loading={savingManualMonths} disabled={!dirtyMonthKeys.size || !report} onClick={() => saveManualMonths().catch(() => {})}>保存修改</Button>
            </Space>
          </div>
        )}
      >
        {loading ? <div className={styles.drawerLoading}><Spin /></div> : null}
        {!loading && reportLoadError ? <Alert type="error" showIcon message="年度报告加载失败" description={reportLoadError} /> : null}
        {!loading && report ? (
          <>
            <div className={styles.drawerReportMeta}>
              <div>
                <Typography.Title level={5}>{propertyTitle(selectedSummary, report)} · FY{report.fiscal_year}</Typography.Title>
                <Typography.Text type="secondary">{report.property.address || selectedSummary?.property.region || '-'}</Typography.Text>
              </div>
              <Progress type="circle" size={58} percent={Math.round((report.totals.complete_month_count / 12) * 100)} format={() => `${report.totals.complete_month_count}/12`} />
            </div>

            <Alert
              type="info"
              showIcon
              message="系统生成数据为只读；仅手工月份、完整状态和备注可以修改。"
              className={styles.sectionAlert}
            />

            <div className={styles.editorGrid}>
              <div className={styles.monthSelector}>
                {report.months.map((month) => {
                  const selected = month.month_key === activeEditMonthKey
                  return (
                    <Button
                      key={month.month_key}
                      type={selected ? 'primary' : 'default'}
                      ghost={selected}
                      block
                      className={styles.monthButton}
                      onClick={() => setActiveEditMonthKey(month.month_key)}
                    >
                      <span>{month.month_key}</span>
                      <Tag color={MONTH_STATUS_META[month.status].color}>{month.editable ? MONTH_STATUS_META[month.status].label : '系统数据'}</Tag>
                    </Button>
                  )
                })}
              </div>

              <div className={styles.monthEditor}>
                {!activeEditMonth ? <Empty description="请选择月份" /> : null}

                {activeEditMonth && !activeEditMonth.editable ? (
                  <Card size="small" title={`${activeEditMonth.month_key} 系统月份`}>
                    <Alert type="info" showIcon message="本月由系统营收数据自动生成，不能在年度报告中直接修改。" className={styles.sectionAlert} />
                    <Descriptions bordered size="small" column={2}>
                      <Descriptions.Item label="状态">{monthStatusTag(activeEditMonth)}</Descriptions.Item>
                      <Descriptions.Item label="净收入">{formatAnnualReportMoney(activeEditMonth.net_income)}</Descriptions.Item>
                      {MANUAL_ROW_KEYS.map((key) => (
                        <Descriptions.Item key={key} label={ANNUAL_REPORT_LINE_LABELS[key]}>
                          {formatAnnualReportMoney(activeEditMonth.lines[key])}
                        </Descriptions.Item>
                      ))}
                    </Descriptions>
                  </Card>
                ) : null}

                {activeEditMonth?.editable ? (
                  <Card
                    size="small"
                    title={`${activeEditMonth.month_key} 手工月份`}
                    extra={activeEditMonth.has_saved_manual_record ? (
                      <Button
                        danger
                        loading={deletingMonthKey === activeEditMonth.month_key}
                        disabled={savingManualMonths}
                        onClick={() => confirmDeleteManualMonth(activeEditMonth.month_key)}
                      >
                        删除本月补录
                      </Button>
                    ) : null}
                  >
                    <div className={styles.moneyGrid}>
                      {MANUAL_ROW_KEYS.map((key) => (
                        <label key={key} className={styles.fieldLabel}>
                          <span>{ANNUAL_REPORT_LINE_LABELS[key]}</span>
                          <InputNumber
                            prefix="$"
                            value={draftByMonth[activeEditMonth.month_key]?.lines?.[key] ?? null}
                            onChange={(value) => updateDraftValue(activeEditMonth.month_key, key, value == null ? null : Number(value))}
                            min={0}
                            precision={2}
                            className={styles.moneyInput}
                          />
                        </label>
                      ))}
                    </div>

                    <div className={styles.editorMetaFields}>
                      <Checkbox
                        checked={draftByMonth[activeEditMonth.month_key]?.is_complete ?? activeEditMonth.is_complete}
                        onChange={(event) => updateDraftMeta(activeEditMonth.month_key, { is_complete: event.target.checked })}
                      >
                        标记为完整
                      </Checkbox>
                      <label className={styles.fieldLabel}>
                        <span>备注</span>
                        <Input.TextArea
                          rows={4}
                          maxLength={2000}
                          showCount
                          placeholder="填写本月补录说明"
                          value={draftByMonth[activeEditMonth.month_key]?.note ?? ''}
                          onChange={(event) => updateDraftMeta(activeEditMonth.month_key, { note: event.target.value })}
                        />
                      </label>
                    </div>
                  </Card>
                ) : null}
              </div>
            </div>
          </>
        ) : null}
      </Drawer>

      {report ? (
        <div className={styles.printSource} aria-hidden="true">
          <div ref={printRef}>
            <FiscalYearStatement report={report} showChinese={reportLanguage === 'bilingual'} />
          </div>
        </div>
      ) : null}
    </Card>
  )
}
