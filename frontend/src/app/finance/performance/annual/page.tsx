"use client"
import { Alert, Button, Card, Checkbox, Input, InputNumber, Select, Space, Spin, Table, message } from 'antd'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import FiscalYearStatement from '../../../../components/FiscalYearStatement'
import { deleteJSON, getJSON, putJSON } from '../../../../lib/api'
import {
  ANNUAL_REPORT_LANGUAGE_OPTIONS,
  ANNUAL_REPORT_LINE_LABELS,
  SUPPORTED_ANNUAL_REPORT_FISCAL_YEARS,
  annualReportHasIssues,
  canDownloadAnnualReport,
  formatAnnualReportFilename,
  type AnnualReportLanguage,
  type AnnualPropertyReport,
  type AnnualReportLineKey,
} from '../../../../lib/annualReport'
import { exportElementToPdfBlob } from '../../../../lib/pdfExport'
import { sortActivePropertiesByRegionThenCode } from '../../../../lib/properties'

type PropertyOption = { id: string; code?: string; address?: string; region?: string | null; archived?: boolean | null }

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

export default function AnnualReportPage() {
  const [fiscalYear, setFiscalYear] = useState<number>(SUPPORTED_ANNUAL_REPORT_FISCAL_YEARS[0])
  const [reportLanguage, setReportLanguage] = useState<AnnualReportLanguage>('bilingual')
  const [propertyId, setPropertyId] = useState<string | undefined>(undefined)
  const [properties, setProperties] = useState<PropertyOption[]>([])
  const [loading, setLoading] = useState(false)
  const [savingMonthKey, setSavingMonthKey] = useState<string | null>(null)
  const [report, setReport] = useState<AnnualPropertyReport | null>(null)
  const [draftByMonth, setDraftByMonth] = useState<Record<string, ManualDraft>>({})
  const printRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    getJSON<PropertyOption[]>('/properties')
      .then((rows) => setProperties(sortActivePropertiesByRegionThenCode(Array.isArray(rows) ? rows : [])))
      .catch(() => setProperties([]))
  }, [])

  const loadReport = useCallback(async (pid?: string) => {
    const targetPropertyId = String(pid || propertyId || '').trim()
    if (!targetPropertyId) {
      setReport(null)
      setDraftByMonth({})
      return
    }
    setLoading(true)
    try {
      const nextReport = await getJSON<AnnualPropertyReport>(`/finance/annual-report?${new URLSearchParams({ property_id: targetPropertyId, fy: String(fiscalYear) }).toString()}`)
      setReport(nextReport)
      setDraftByMonth(buildDraftFromReport(nextReport))
    } catch (e: any) {
      setReport(null)
      setDraftByMonth({})
      message.error(e?.message || '加载年度报告失败')
    } finally {
      setLoading(false)
    }
  }, [fiscalYear, propertyId])

  useEffect(() => {
    if (!propertyId) {
      setReport(null)
      setDraftByMonth({})
      return
    }
    loadReport(propertyId).catch(() => {})
  }, [loadReport, propertyId])

  const manualMonths = useMemo(() => (report?.months || []).filter((month) => month.editable), [report])
  const downloadLabel = report && annualReportHasIssues(report) ? '下载 Draft / Incomplete PDF' : '下载 PDF'

  const updateDraftValue = (monthKey: string, key: AnnualReportLineKey, value: number | null) => {
    setDraftByMonth((prev) => ({
      ...prev,
      [monthKey]: {
        ...(prev[monthKey] || { is_complete: true, note: '', lines: {} as Record<AnnualReportLineKey, number | null> }),
        lines: {
          ...(prev[monthKey]?.lines || {}),
          [key]: value,
        },
      },
    }))
  }

  const updateDraftMeta = (monthKey: string, patch: Partial<ManualDraft>) => {
    setDraftByMonth((prev) => ({
      ...prev,
      [monthKey]: {
        ...(prev[monthKey] || { is_complete: true, note: '', lines: {} as Record<AnnualReportLineKey, number | null> }),
        ...patch,
      },
    }))
  }

  const saveManualMonth = async (monthKey: string) => {
    const draft = draftByMonth[monthKey]
    if (!draft) return
    if (draft.is_complete) {
      const missing = MANUAL_ROW_KEYS.filter((key) => draft.lines[key] == null)
      if (missing.length) {
        message.error(`完整月份必须填写全部字段：${missing.join(', ')}`)
        return
      }
    }
    setSavingMonthKey(monthKey)
    try {
      await putJSON(`/finance/annual-report/manual-months/${encodeURIComponent(String(propertyId || ''))}/${encodeURIComponent(monthKey)}`, {
        currency: report?.totals.currency || 'AUD',
        note: draft.note || null,
        is_complete: draft.is_complete,
        ...draft.lines,
      })
      await loadReport(propertyId)
      message.success(`${monthKey} 已保存`)
    } catch (e: any) {
      message.error(e?.message || '保存失败')
    } finally {
      setSavingMonthKey(null)
    }
  }

  const deleteManualMonth = async (monthKey: string) => {
    setSavingMonthKey(monthKey)
    try {
      await deleteJSON(`/finance/annual-report/manual-months/${encodeURIComponent(String(propertyId || ''))}/${encodeURIComponent(monthKey)}`)
      await loadReport(propertyId)
      message.success(`${monthKey} 已删除`)
    } catch (e: any) {
      message.error(e?.message || '删除失败')
    } finally {
      setSavingMonthKey(null)
    }
  }

  const downloadPdf = async () => {
    if (!printRef.current || !report) return
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
      const a = document.createElement('a')
      const url = URL.createObjectURL(blob)
      a.href = url
      a.download = formatAnnualReportFilename({
        fiscalYear: report.fiscal_year,
        propertyCode: report.property.code,
        propertyAddress: report.property.address,
      })
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (e: any) {
      message.error(e?.message || '导出 PDF 失败')
    }
  }

  return (
    <Card title="房源年度报告">
      <Space wrap style={{ marginBottom: 16 }}>
        <Select
          value={fiscalYear}
          onChange={setFiscalYear}
          style={{ width: 160 }}
          options={SUPPORTED_ANNUAL_REPORT_FISCAL_YEARS.map((value) => ({ value, label: `FY${value}` }))}
        />
        <Select
          value={reportLanguage}
          onChange={setReportLanguage}
          style={{ width: 180 }}
          options={ANNUAL_REPORT_LANGUAGE_OPTIONS.map((value) => ({
            value,
            label: value === 'en' ? 'English' : 'English + 中文',
          }))}
        />
        <Select
          allowClear
          showSearch
          placeholder="选择房源"
          optionFilterProp="label"
          style={{ width: 320 }}
          options={properties.map((property) => ({
            value: property.id,
            label: `${property.code || property.address || property.id}${property.region ? ` (${property.region})` : ''}`,
          }))}
          value={propertyId}
          onChange={setPropertyId}
        />
        <Button type="primary" disabled={!canDownloadAnnualReport(report, propertyId)} onClick={() => downloadPdf().catch(() => {})}>
          {downloadLabel}
        </Button>
      </Space>

      {!propertyId ? (
        <Alert type="info" showIcon message="请选择房源后查看年度报告。" />
      ) : null}

      {report && annualReportHasIssues(report) ? (
        <Alert
          style={{ marginBottom: 16 }}
          type="warning"
          showIcon
          message="Draft / Incomplete"
          description={`当前报告存在缺失月份或 warning。缺失月份：${report.months.filter((month) => !month.is_complete).map((month) => month.month_key).join(', ') || '无'}。`}
        />
      ) : null}

      {loading ? (
        <div style={{ padding: 48, textAlign: 'center' }}>
          <Spin />
        </div>
      ) : null}

      {!loading && report ? (
        <>
          <Card size="small" title="手工月份录入" style={{ marginBottom: 16 }}>
            <div style={{ marginBottom: 12, color: '#666' }}>仅 `2025-07` 到 `2026-01` 可编辑。删除后月份会回到缺失状态，不会自动回落成系统月。</div>
            <Table
              rowKey="month_key"
              pagination={false}
              size="small"
              scroll={{ x: 2200 }}
              dataSource={manualMonths}
              columns={[
                {
                  title: '月份',
                  dataIndex: 'month_key',
                  width: 110,
                  fixed: 'left',
                },
                ...MANUAL_ROW_KEYS.map((key) => ({
                  title: ANNUAL_REPORT_LINE_LABELS[key],
                  dataIndex: key,
                  width: 140,
                  render: (_: any, row: any) => (
                    <InputNumber
                      value={draftByMonth[row.month_key]?.lines?.[key] ?? null}
                      onChange={(value) => updateDraftValue(row.month_key, key, value == null ? null : Number(value))}
                      style={{ width: '100%' }}
                      min={0}
                    />
                  ),
                })),
                {
                  title: '完整',
                  width: 90,
                  render: (_: any, row: any) => (
                    <Checkbox
                      checked={draftByMonth[row.month_key]?.is_complete ?? row.is_complete}
                      onChange={(event) => updateDraftMeta(row.month_key, { is_complete: event.target.checked })}
                    />
                  ),
                },
                {
                  title: '备注',
                  width: 220,
                  render: (_: any, row: any) => (
                    <Input
                      value={draftByMonth[row.month_key]?.note ?? ''}
                      onChange={(event) => updateDraftMeta(row.month_key, { note: event.target.value })}
                    />
                  ),
                },
                {
                  title: '操作',
                  width: 160,
                  fixed: 'right',
                  render: (_: any, row: any) => (
                    <Space>
                      <Button size="small" type="primary" loading={savingMonthKey === row.month_key} onClick={() => saveManualMonth(row.month_key).catch(() => {})}>
                        保存
                      </Button>
                      <Button
                        size="small"
                        danger
                        disabled={!row.has_saved_manual_record}
                        loading={savingMonthKey === row.month_key}
                        onClick={() => deleteManualMonth(row.month_key).catch(() => {})}
                      >
                        删除
                      </Button>
                    </Space>
                  ),
                },
              ]}
            />
          </Card>

          <Card
            size="small"
            title={`报告预览 ${report.property.code || report.property.address || report.property.id} FY${report.fiscal_year}`}
            extra={<span style={{ color: report.report_status === 'complete' ? '#389e0d' : '#cf1322' }}>{report.report_status === 'complete' ? 'Complete' : 'Draft / Incomplete'}</span>}
          >
            <div ref={printRef}>
              <FiscalYearStatement report={report} showChinese={reportLanguage === 'bilingual'} />
            </div>
          </Card>
        </>
      ) : null}
    </Card>
  )
}
