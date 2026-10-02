"use client"

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Alert,
  App,
  Button,
  DatePicker,
  Descriptions,
  Drawer,
  Form,
  Image,
  Input,
  InputNumber,
  Modal,
  Select,
  Skeleton,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import type { Dayjs } from 'dayjs'
import TableRowActions from '../../../components/TableRowActions'
import { getJSON, postJSON } from '../../../lib/api'
import { hasPerm } from '../../../lib/auth'
import {
  CLAIM_STATUS_META,
  CLAIM_TYPE_LABELS,
  formatClaimTimeRange,
  formatDateOnly,
  formatDateTime,
  formatMoney,
  formatPersonnelDuration,
  formatSettlementWeekRange,
  getClaimReviewInputMode,
  mondayForDate,
  previousCompletedWeekStart,
  type ClaimStatus,
} from './settlementWorkflowUi'
import {
  loadPersonnelClaimEvidenceObjectUrl,
  releasePersonnelClaimEvidenceObjectUrls,
} from './claimEvidenceImage'
import styles from './WorkloadClaimsPanel.module.css'

type ClaimEvidence = {
  id: string
  media_id: string | null
  mime_type: string | null
  byte_size: number | null
  original_file_name: string | null
  created_at: string
}

type WorkloadClaim = {
  id: string
  submitter_user_id: string
  submitter_name: string
  service_date: string
  claim_type: string
  property_id: string | null
  started_at: string | null
  ended_at: string | null
  duration_minutes: number | null
  approved_duration_minutes: number | null
  requested_quantity: string | null
  approved_quantity: string | null
  requested_amount_cents: number | null
  approved_amount_cents: number | null
  note: string
  status: ClaimStatus
  evidence_count: number
  submitted_at: string | null
  reviewed_at: string | null
  reviewer_name: string | null
  review_note: string | null
  evidence?: ClaimEvidence[]
}

type ReviewAction = 'approve' | 'return' | 'reject'
type ReviewState = { action: ReviewAction; claim: WorkloadClaim } | null
type ReviewValues = {
  approved_duration_minutes?: number
  approved_quantity?: number
  approved_amount?: number
  review_note?: string
}

type ClaimEstimate = {
  available: false
  reason: string
} | {
  available: true
  reason: null
  rule_id: string | null
  rule_name: string | null
  effective_from: string
  price_basis: 'exclusive_gst' | 'inclusive_gst'
  unit_rate_cents: number
  gst_status: 'registered' | 'not_registered'
  quantity_numerator: number
  quantity_denominator: number
  subtotal_cents: number
  gst_cents: number
  total_cents: number
}

const REVIEW_TITLES: Record<ReviewAction, string> = {
  approve: '确认工作量并计入',
  return: '请合作方补充资料',
  reject: '本次不纳入结算',
}

function claimStatusTag(status: ClaimStatus) {
  const meta = CLAIM_STATUS_META[status] || { label: status, color: 'default' }
  return <Tag color={meta.color}>{meta.label}</Tag>
}

function errorMessage(error: any) {
  const code = String(error?.code || error?.message || '')
  const labels: Record<string, string> = {
    claim_not_reviewable: '这条反馈已处理，请刷新列表。',
    claim_period_locked: '该合作方本周结算已进入确认或付款阶段；只有处于“待重新核对”时才能继续核对。',
    claim_evidence_required: '反馈缺少证明材料，不能确认计入。',
    duplicate_approved_claim: '已有内容完全相同的反馈确认计入；如为两笔不同工作，请先退回并补充可区分的时间或说明。',
    approved_duration_or_amount_required: '请确认有效工时。',
    approved_amount_or_quantity_required: '请确认金额或数量。',
    manual_amount_not_allowed_for_claim_type: '该费用按规则自动计算，不能直接填写金额。',
    missing_effective_rule: '该工作日期没有生效的费用规则，请先配置规则。',
    missing_rule_item: '当前费用规则缺少对应计算方式，请先补充规则。',
    missing_effective_profile: '该工作日期没有生效的结算资料。',
    gst_status_unconfirmed: '该合作方的 GST 状态尚未确认，暂时无法计算金额。',
  }
  return labels[code] || code || '操作失败'
}

function estimateUnavailableMessage(reason: string | undefined) {
  return errorMessage({ code: reason || '金额暂时无法计算' })
}

async function loadEvidenceMaps(claim: WorkloadClaim) {
  const loaded = await Promise.all((claim.evidence || []).map(async (item) => {
    try {
      return [item.id, await loadPersonnelClaimEvidenceObjectUrl(claim.id, item.id)] as const
    } catch {
      return [item.id, null] as const
    }
  }))
  const urls: Record<string, string> = {}
  const failures: Record<string, boolean> = {}
  for (const [id, url] of loaded) {
    if (url) urls[id] = url
    else failures[id] = true
  }
  return { urls, failures }
}

function estimateFormula(estimate: Extract<ClaimEstimate, { available: true }>, claim: WorkloadClaim, values: ReviewValues) {
  const mode = getClaimReviewInputMode(claim.claim_type)
  const rate = formatMoney(estimate.unit_rate_cents)
  if (mode === 'time_range') return `${rate}/小时 × ${values.approved_duration_minutes || 0}分钟 ÷ 60`
  if (mode === 'day') return `${rate}/天 × ${values.approved_quantity || 1}`
  if (mode === 'quantity') return `${rate}/次 × ${values.approved_quantity || 0}`
  return `核对金额 ${formatMoney(Math.round(Number(values.approved_amount || 0) * 100))}`
}

export default function WorkloadClaimsPanel() {
  const { message } = App.useApp()
  const [form] = Form.useForm<ReviewValues>()
  const [weekStart, setWeekStart] = useState<Dayjs>(previousCompletedWeekStart())
  const [status, setStatus] = useState<ClaimStatus | undefined>()
  const [search, setSearch] = useState('')
  const [rows, setRows] = useState<WorkloadClaim[]>([])
  const [loading, setLoading] = useState(false)
  const [detail, setDetail] = useState<WorkloadClaim | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailEstimate, setDetailEstimate] = useState<ClaimEstimate | null>(null)
  const [detailEstimateLoading, setDetailEstimateLoading] = useState(false)
  const [reviewState, setReviewState] = useState<ReviewState>(null)
  const [reviewLoading, setReviewLoading] = useState(false)
  const [reviewSaving, setReviewSaving] = useState(false)
  const [reviewEstimate, setReviewEstimate] = useState<ClaimEstimate | null>(null)
  const [reviewEstimateError, setReviewEstimateError] = useState('')
  const [reviewEstimateLoading, setReviewEstimateLoading] = useState(false)
  const [evidenceUrls, setEvidenceUrls] = useState<Record<string, string>>({})
  const [evidenceFailures, setEvidenceFailures] = useState<Record<string, boolean>>({})
  const [reviewEvidenceUrls, setReviewEvidenceUrls] = useState<Record<string, string>>({})
  const [reviewEvidenceFailures, setReviewEvidenceFailures] = useState<Record<string, boolean>>({})
  const evidenceUrlsRef = useRef<Record<string, string>>({})
  const reviewEvidenceUrlsRef = useRef<Record<string, string>>({})
  const canReview = hasPerm('personnel_settlements.rules.manage') || hasPerm('finance.payout')
  const approvedDuration = Form.useWatch('approved_duration_minutes', form)
  const approvedQuantity = Form.useWatch('approved_quantity', form)
  const approvedAmount = Form.useWatch('approved_amount', form)

  const replaceEvidenceUrls = useCallback((next: Record<string, string>) => {
    releasePersonnelClaimEvidenceObjectUrls(evidenceUrlsRef.current)
    evidenceUrlsRef.current = next
    setEvidenceUrls(next)
  }, [])

  const replaceReviewEvidenceUrls = useCallback((next: Record<string, string>) => {
    releasePersonnelClaimEvidenceObjectUrls(reviewEvidenceUrlsRef.current)
    reviewEvidenceUrlsRef.current = next
    setReviewEvidenceUrls(next)
  }, [])

  useEffect(() => () => {
    releasePersonnelClaimEvidenceObjectUrls(evidenceUrlsRef.current)
    releasePersonnelClaimEvidenceObjectUrls(reviewEvidenceUrlsRef.current)
  }, [])

  const loadRows = useCallback(async () => {
    setLoading(true)
    try {
      const query = new URLSearchParams({ week_start: weekStart.format('YYYY-MM-DD') })
      if (status) query.set('status', status)
      if (search.trim()) query.set('search', search.trim())
      setRows(await getJSON<WorkloadClaim[]>(`/finance/settlements/claims?${query.toString()}`, { authSensitive: true }))
    } catch (error: any) {
      setRows([])
      message.error(errorMessage(error))
    } finally {
      setLoading(false)
    }
  }, [message, search, status, weekStart])

  useEffect(() => { void loadRows() }, [loadRows])

  async function openDetail(claim: WorkloadClaim) {
    replaceEvidenceUrls({})
    setEvidenceFailures({})
    setDetailEstimate(null)
    setDetail(claim)
    setDetailLoading(true)
    setDetailEstimateLoading(true)
    try {
      const nextDetail = await getJSON<WorkloadClaim>(`/finance/settlements/claims/${encodeURIComponent(claim.id)}`, { authSensitive: true })
      setDetail(nextDetail)
      const [evidence, estimate] = await Promise.all([
        loadEvidenceMaps(nextDetail),
        getJSON<ClaimEstimate>(`/finance/settlements/claims/${encodeURIComponent(nextDetail.id)}/estimate`, { authSensitive: true })
          .catch(() => null),
      ])
      replaceEvidenceUrls(evidence.urls)
      setEvidenceFailures(evidence.failures)
      setDetailEstimate(estimate)
    } catch (error: any) {
      message.error(errorMessage(error))
      closeDetail()
    } finally {
      setDetailLoading(false)
      setDetailEstimateLoading(false)
    }
  }

  function closeDetail() {
    replaceEvidenceUrls({})
    setEvidenceFailures({})
    setDetailEstimate(null)
    setDetail(null)
  }

  async function openReview(action: ReviewAction, claim: WorkloadClaim) {
    form.resetFields()
    form.setFieldsValue({
      approved_duration_minutes: claim.duration_minutes ?? undefined,
      approved_quantity: claim.requested_quantity == null ? undefined : Number(claim.requested_quantity),
      approved_amount: claim.requested_amount_cents == null ? undefined : claim.requested_amount_cents / 100,
    })
    replaceReviewEvidenceUrls({})
    setReviewEvidenceFailures({})
    setReviewEstimate(null)
    setReviewEstimateError('')
    setReviewState({ action, claim })
    if (action !== 'approve') return
    setReviewLoading(true)
    try {
      const nextDetail = await getJSON<WorkloadClaim>(`/finance/settlements/claims/${encodeURIComponent(claim.id)}`, { authSensitive: true })
      setReviewState((current) => current?.claim.id === nextDetail.id ? { ...current, claim: nextDetail } : current)
      const evidence = await loadEvidenceMaps(nextDetail)
      replaceReviewEvidenceUrls(evidence.urls)
      setReviewEvidenceFailures(evidence.failures)
    } catch (error: any) {
      message.error(errorMessage(error))
    } finally {
      setReviewLoading(false)
    }
  }

  useEffect(() => {
    if (!reviewState || reviewState.action !== 'approve') return
    const claim = reviewState.claim
    const mode = getClaimReviewInputMode(claim.claim_type)
    const missingRequiredInput = mode === 'time_range'
      ? approvedDuration == null || approvedDuration <= 0
      : mode === 'quantity'
        ? approvedQuantity == null || approvedQuantity <= 0
        : mode === 'day'
          ? approvedQuantity == null || approvedQuantity < 1
          : approvedAmount == null || approvedAmount < 0
    if (missingRequiredInput) {
      setReviewEstimate(null)
      setReviewEstimateError('')
      setReviewEstimateLoading(false)
      return
    }
    const query = new URLSearchParams()
    if (mode === 'time_range' && approvedDuration != null) query.set('duration_minutes', String(approvedDuration))
    if ((mode === 'quantity' || mode === 'day') && approvedQuantity != null) query.set('requested_quantity', String(approvedQuantity))
    if (mode === 'amount' && approvedAmount != null) query.set('requested_amount_cents', String(Math.round(Number(approvedAmount) * 100)))
    let cancelled = false
    const timer = window.setTimeout(async () => {
      setReviewEstimateLoading(true)
      setReviewEstimateError('')
      try {
        const suffix = query.toString() ? `?${query.toString()}` : ''
        const estimate = await getJSON<ClaimEstimate>(
          `/finance/settlements/claims/${encodeURIComponent(claim.id)}/estimate${suffix}`,
          { authSensitive: true },
        )
        if (!cancelled) setReviewEstimate(estimate)
      } catch (error: any) {
        if (!cancelled) {
          setReviewEstimate(null)
          setReviewEstimateError(errorMessage(error))
        }
      } finally {
        if (!cancelled) setReviewEstimateLoading(false)
      }
    }, 180)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [approvedAmount, approvedDuration, approvedQuantity, reviewState])

  function closeReview() {
    replaceReviewEvidenceUrls({})
    setReviewEvidenceFailures({})
    setReviewEstimate(null)
    setReviewEstimateError('')
    setReviewState(null)
    form.resetFields()
  }

  async function submitReview() {
    if (!reviewState) return
    const values = await form.validateFields()
    const mode = getClaimReviewInputMode(reviewState.claim.claim_type)
    setReviewSaving(true)
    try {
      await postJSON(
        `/finance/settlements/claims/${encodeURIComponent(reviewState.claim.id)}/review`,
        {
          action: reviewState.action,
          approved_duration_minutes: reviewState.action === 'approve' && mode === 'time_range'
            ? values.approved_duration_minutes ?? null
            : null,
          approved_quantity: reviewState.action === 'approve' && (mode === 'quantity' || mode === 'day')
            ? values.approved_quantity ?? null
            : null,
          approved_amount_cents: reviewState.action === 'approve' && mode === 'amount' && values.approved_amount != null
            ? Math.round(values.approved_amount * 100)
            : null,
          review_note: values.review_note?.trim() || null,
        },
        { authSensitive: true },
      )
      message.success(`${REVIEW_TITLES[reviewState.action]}成功`)
      closeReview()
      setDetail(null)
      await loadRows()
    } catch (error: any) {
      message.error(errorMessage(error))
    } finally {
      setReviewSaving(false)
    }
  }

  const reviewMode = reviewState ? getClaimReviewInputMode(reviewState.claim.claim_type) : 'quantity'
  const reviewValues: ReviewValues = { approved_duration_minutes: approvedDuration, approved_quantity: approvedQuantity, approved_amount: approvedAmount }
  const reviewAmount = reviewEstimate?.available ? formatMoney(reviewEstimate.total_cents) : null
  const reviewOkText = reviewState?.action === 'approve' && reviewAmount
    ? `确认并计入 ${reviewAmount}`
    : '确认'
  const reviewEstimateUnavailableReason = reviewEstimate && !reviewEstimate.available ? reviewEstimate.reason : ''
  const reviewApprovalDisabled = reviewState?.action === 'approve'
    && (reviewEstimateLoading || !reviewEstimate?.available || !!reviewEstimateError)

  const columns: ColumnsType<WorkloadClaim> = [
    { title: '人员', dataIndex: 'submitter_name', fixed: 'left', width: 170 },
    { title: '工作日期', dataIndex: 'service_date', width: 110 },
    { title: '类型', dataIndex: 'claim_type', width: 120, render: (value) => CLAIM_TYPE_LABELS[value] || value },
    {
      title: '提交工作量',
      key: 'workload',
      width: 140,
      render: (_, row) => row.requested_amount_cents != null
        ? formatMoney(row.requested_amount_cents)
        : row.duration_minutes != null
          ? formatPersonnelDuration(row.duration_minutes)
          : row.requested_quantity || '-',
    },
    { title: '说明', dataIndex: 'note', width: 240, ellipsis: { showTitle: false }, render: (value) => <Typography.Text ellipsis={{ tooltip: value }}>{value}</Typography.Text> },
    { title: '证明', dataIndex: 'evidence_count', width: 80, align: 'right', render: (value) => `${value} 个` },
    { title: '状态', dataIndex: 'status', width: 105, render: claimStatusTag },
    { title: '核对时间', dataIndex: 'reviewed_at', width: 155, render: formatDateTime },
    {
      title: '操作',
      key: 'actions',
      fixed: 'right',
      width: 330,
      render: (_, row) => <TableRowActions actions={[
        { key: 'detail', label: '详情', onClick: () => { void openDetail(row) } },
        { key: 'approve', label: '确认计入', hidden: !canReview || row.status !== 'submitted', onClick: () => { void openReview('approve', row) } },
        { key: 'return', label: '请补充', hidden: !canReview || row.status !== 'submitted', onClick: () => { void openReview('return', row) } },
        { key: 'reject', label: '不纳入', danger: true, hidden: !canReview || row.status !== 'submitted', onClick: () => { void openReview('reject', row) } },
      ]} />,
    },
  ]

  return <>
    <Alert
      type="info"
      showIcon
      message="先按所属周集中核对补贴、加班、上新房及其他工作量；每条反馈仍保留具体工作日期，证明照片仅通过登录鉴权接口显示。"
      style={{ marginBottom: 12 }}
    />
    <Space wrap style={{ marginBottom: 12 }}>
      <Typography.Text strong>所属周</Typography.Text>
      <DatePicker
        picker="week"
        value={weekStart}
        allowClear={false}
        format={formatSettlementWeekRange}
        onChange={(value) => value && setWeekStart(mondayForDate(value))}
        style={{ width: 250 }}
      />
      <Select
        allowClear
        placeholder="全部状态"
        value={status}
        onChange={setStatus}
        style={{ width: 140 }}
        options={Object.entries(CLAIM_STATUS_META).map(([value, meta]) => ({ value, label: meta.label }))}
      />
      <Input.Search
        allowClear
        placeholder="搜索人员"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        onSearch={() => void loadRows()}
        style={{ width: 240 }}
      />
      <Button onClick={() => void loadRows()} loading={loading}>刷新</Button>
    </Space>
    <Table<WorkloadClaim>
      rowKey="id"
      loading={loading}
      dataSource={rows}
      columns={columns}
      scroll={{ x: 1350 }}
      pagination={{ pageSize: 50, showSizeChanger: true }}
    />

    <Drawer
      width={720}
      open={!!detail}
      loading={detailLoading}
      title="工作量反馈详情"
      onClose={closeDetail}
      footer={<div style={{ textAlign: 'right' }}><Button onClick={closeDetail}>关闭</Button></div>}
    >
      {detail ? <Descriptions bordered size="small" column={1}>
        <Descriptions.Item label="人员">{detail.submitter_name}</Descriptions.Item>
        <Descriptions.Item label="工作日期">{detail.service_date}</Descriptions.Item>
        <Descriptions.Item label="类型">{CLAIM_TYPE_LABELS[detail.claim_type] || detail.claim_type}</Descriptions.Item>
        <Descriptions.Item label="时间">{detail.started_at ? `${formatDateTime(detail.started_at)} 至 ${formatDateTime(detail.ended_at)}` : '-'}</Descriptions.Item>
        <Descriptions.Item label="提交工时">{formatPersonnelDuration(detail.duration_minutes)}</Descriptions.Item>
        <Descriptions.Item label="提交数量">{detail.requested_quantity || '-'}</Descriptions.Item>
        <Descriptions.Item label="提交金额">{detail.requested_amount_cents == null ? '-' : formatMoney(detail.requested_amount_cents)}</Descriptions.Item>
        <Descriptions.Item label={detail.status === 'approved' ? '确认计入金额' : '预计计入金额'}>
          {detailEstimateLoading
            ? '正在计算…'
            : detailEstimate?.available
              ? <Space size={12}>
                <Typography.Text strong style={{ color: '#0958d9', fontSize: 18 }}>{formatMoney(detailEstimate.total_cents)}</Typography.Text>
                <Typography.Text type="secondary">
                  税前 {formatMoney(detailEstimate.subtotal_cents)} · GST {formatMoney(detailEstimate.gst_cents)}
                </Typography.Text>
              </Space>
              : detailEstimate
                ? estimateUnavailableMessage(detailEstimate.reason)
                : '金额暂时无法计算'}
        </Descriptions.Item>
        <Descriptions.Item label="说明">{detail.note}</Descriptions.Item>
        <Descriptions.Item label="状态">{claimStatusTag(detail.status)}</Descriptions.Item>
        <Descriptions.Item label="核对说明">{detail.review_note || '-'}</Descriptions.Item>
        <Descriptions.Item label="证明材料">
          {(detail.evidence || []).length
            ? <Space wrap align="start">{(detail.evidence || []).map((item) => <div key={item.id} style={{ width: 150 }}>
              {evidenceUrls[item.id]
                ? <Image src={evidenceUrls[item.id]} alt="工作量证明" width={140} height={105} style={{ objectFit: 'cover', borderRadius: 6 }} />
                : <div style={{ width: 140, height: 105, display: 'grid', placeItems: 'center', background: '#f5f5f5', color: '#999', borderRadius: 6 }}>
                  {evidenceFailures[item.id] ? '照片读取失败' : '照片加载中'}
                </div>}
              <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12, marginTop: 4 }} ellipsis={{ tooltip: item.original_file_name || item.media_id || item.id }}>
                {item.original_file_name || item.media_id || item.id}
              </Typography.Text>
            </div>)}</Space>
            : '未关联证明材料'}
        </Descriptions.Item>
      </Descriptions> : null}
    </Drawer>

    <Modal
      open={!!reviewState}
      title={reviewState ? REVIEW_TITLES[reviewState.action] : ''}
      width={reviewState?.action === 'approve' ? 720 : 520}
      rootClassName={reviewState?.action === 'approve' ? styles.reviewModal : undefined}
      okText={reviewOkText}
      cancelText="取消"
      confirmLoading={reviewSaving}
      okButtonProps={{ danger: reviewState?.action === 'reject', disabled: reviewApprovalDisabled }}
      onCancel={() => { if (!reviewSaving) closeReview() }}
      onOk={() => void submitReview()}
    >
      <Form form={form} layout="vertical">
        {reviewState?.action === 'approve' ? <>
          <h3 className={styles.sectionTitle}>提交的工作量</h3>
          <div className={styles.claimSummary}>
            {[
              ['人员', reviewState.claim.submitter_name],
              ['工作日期', formatDateOnly(reviewState.claim.service_date)],
              ['类型', CLAIM_TYPE_LABELS[reviewState.claim.claim_type] || reviewState.claim.claim_type],
              ['时间', formatClaimTimeRange(reviewState.claim.started_at, reviewState.claim.ended_at)],
              ['提交工作量', reviewState.claim.duration_minutes != null
                ? formatPersonnelDuration(reviewState.claim.duration_minutes)
                : reviewState.claim.requested_amount_cents != null
                  ? formatMoney(reviewState.claim.requested_amount_cents)
                  : reviewState.claim.requested_quantity || '-'],
            ].map(([label, value]) => <div className={styles.summaryItem} key={label}>
              <span className={styles.summaryLabel}>{label}</span>
              <span className={styles.summaryValue}>{value}</span>
            </div>)}
          </div>

          <div className={styles.detailRow}>
            <span className={styles.detailLabel}>工作说明</span>
            <span>{reviewState.claim.note || '-'}</span>
          </div>
          <div className={styles.detailRow}>
            <span className={styles.detailLabel}>证明材料</span>
            <div className={styles.evidenceList}>
              {reviewLoading && !(reviewState.claim.evidence || []).length
                ? <Skeleton.Image active style={{ width: 140, height: 92 }} />
                : (reviewState.claim.evidence || []).length
                  ? (reviewState.claim.evidence || []).map((item) => reviewEvidenceUrls[item.id]
                    ? <Image
                      key={item.id}
                      src={reviewEvidenceUrls[item.id]}
                      alt="工作量证明"
                      width={140}
                      height={92}
                      style={{ objectFit: 'cover', borderRadius: 6 }}
                    />
                    : <div className={styles.evidencePlaceholder} key={item.id}>
                      {reviewEvidenceFailures[item.id] ? '照片读取失败' : '照片加载中'}
                    </div>)
                  : <span>未关联证明材料</span>}
            </div>
          </div>

          <div className={styles.reviewDivider} />

          {reviewMode === 'time_range' ? <Form.Item
            className={styles.inlineReviewField}
            label="核对工时"
            name="approved_duration_minutes"
            rules={[{ required: true, type: 'number', min: 1, message: '请确认有效工时' }]}
          ><InputNumber min={1} max={10080} addonAfter="分钟" style={{ width: '100%' }} /></Form.Item> : null}
          {reviewMode === 'quantity' ? <Form.Item
            className={styles.inlineReviewField}
            label="核对数量"
            name="approved_quantity"
            rules={[{ required: true, type: 'number', min: 0.001, message: '请确认有效数量' }]}
          ><InputNumber min={0.001} precision={3} style={{ width: '100%' }} /></Form.Item> : null}
          {reviewMode === 'day' ? <Form.Item
            className={styles.inlineReviewField}
            label="核对天数"
            name="approved_quantity"
            rules={[{ required: true, type: 'number', min: 1, message: '请确认有效天数' }]}
          ><InputNumber min={1} precision={0} addonAfter="天" style={{ width: '100%' }} /></Form.Item> : null}
          {reviewMode === 'amount' ? <Form.Item
            className={styles.inlineReviewField}
            label="核对金额（AUD）"
            name="approved_amount"
            rules={[{ required: true, type: 'number', min: 0, message: '请确认金额' }]}
          ><InputNumber min={0} precision={2} prefix="$" style={{ width: '100%' }} /></Form.Item> : null}
          <div className={styles.fieldHelp}>{reviewMode === 'amount'
            ? '核对金额是本次最终计入总额；财务可调整金额，并决定计入、退回或不纳入。'
            : '修改工作量后，系统将按工作日期生效的费用规则自动重新计算金额。'}</div>

          {reviewEstimateLoading ? <div className={styles.estimateState}><Skeleton active paragraph={{ rows: 2 }} /></div> : null}
          {!reviewEstimateLoading && reviewEstimateError
            ? <Alert className={styles.estimateState} type="error" showIcon message={reviewEstimateError} />
            : null}
          {!reviewEstimateLoading && reviewEstimateUnavailableReason
            ? <Alert className={styles.estimateState} type="warning" showIcon message={estimateUnavailableMessage(reviewEstimateUnavailableReason)} />
            : null}
          {!reviewEstimateLoading && reviewEstimate?.available ? <>
            <div className={styles.calculationCard}>
              <div>
                <div className={styles.calculationEyebrow}>系统自动计算</div>
                <div className={styles.calculationFormula}>{estimateFormula(reviewEstimate, reviewState.claim, reviewValues)}</div>
              </div>
              <div className={styles.calculationTotal}>
                <span className={styles.calculationTotalLabel}>确认计入金额</span>
                <span className={styles.calculationTotalValue}>{formatMoney(reviewEstimate.total_cents)}</span>
              </div>
            </div>
            <div className={styles.breakdown}>
              <div className={styles.breakdownRow}>
                <span>税前金额</span>
                <span className={styles.breakdownValue}>{formatMoney(reviewEstimate.subtotal_cents)}</span>
              </div>
              <div className={styles.breakdownRow}>
                <span>{reviewEstimate.gst_status === 'not_registered'
                  ? 'GST（未注册）'
                  : reviewEstimate.price_basis === 'inclusive_gst'
                    ? 'GST（已包含）'
                    : 'GST（另计）'}</span>
                <span className={styles.breakdownValue}>{formatMoney(reviewEstimate.gst_cents)}</span>
              </div>
            </div>
          </> : null}

          <Form.Item label="核对备注（可选）" name="review_note">
            <Input.TextArea rows={3} maxLength={1000} showCount />
          </Form.Item>
        </> : <Form.Item
          label="说明"
          name="review_note"
          rules={[{ required: true, whitespace: true, message: '请填写原因' }]}
        ><Input.TextArea rows={3} maxLength={1000} showCount /></Form.Item>}
      </Form>
    </Modal>
  </>
}
