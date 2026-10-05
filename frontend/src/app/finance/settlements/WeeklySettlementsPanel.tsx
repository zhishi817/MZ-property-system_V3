"use client"

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Alert,
  App,
  Button,
  DatePicker,
  Descriptions,
  Divider,
  Drawer,
  Form,
  Image,
  Input,
  InputNumber,
  Modal,
  Radio,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
} from 'antd'
import { CheckCircleFilled, CloseCircleFilled, EyeOutlined, InfoCircleOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import dayjs, { type Dayjs } from 'dayjs'
import TableRowActions from '../../../components/TableRowActions'
import { getBlob, getJSON, postJSON } from '../../../lib/api'
import { hasPerm } from '../../../lib/auth'
import {
  CLAIM_STATUS_META,
  CLAIM_TYPE_LABELS,
  COMPONENT_TYPE_LABELS,
  SETTLEMENT_STATUS_META,
  canUseSettlementAction,
  formatDateOnly,
  formatDateTime,
  formatMoney,
  formatSettlementWeekRange,
  mondayForDate,
  previousCompletedWeekStart,
  type SettlementAction,
  type SettlementStatus,
} from './settlementWorkflowUi'
import {
  loadPersonnelClaimEvidenceObjectUrl,
  personnelClaimEvidenceFailureMessage,
  releasePersonnelClaimEvidenceObjectUrls,
} from './claimEvidenceImage'
import {
  PERSONNEL_PAYMENT_METHOD_LABELS,
  normalizePersonnelPaymentMethod,
  personnelPaymentMethodRequiresBankDetails,
} from './personnelProfileUi'
import styles from './WeeklySettlementsPanel.module.css'

type ClaimEvidence = {
  id: string
  media_id: string | null
  mime_type: string | null
  byte_size: number | null
  original_file_name: string | null
  created_at: string
}

type RelatedClaim = {
  id: string
  service_date: string
  claim_type: string
  duration_minutes: number | null
  approved_duration_minutes: number | null
  requested_quantity: string | null
  approved_quantity: string | null
  requested_amount_cents: number | null
  approved_amount_cents: number | null
  note: string
  status: keyof typeof CLAIM_STATUS_META
  included_in_settlement: boolean
  evidence?: ClaimEvidence[]
}

type SettlementLine = {
  id: string
  component_type: string
  service_date: string
  description: string | null
  quantity_numerator: number
  quantity_denominator: number
  unit_rate_cents: number
  subtotal_cents: number
  gst_cents: number
  total_cents: number
  evidence_count: number
}

type SettlementAudit = {
  id: string
  action: string
  actor_name: string | null
  actor_id: string | null
  created_at: string
}

type SettlementDocument = {
  id: string
  settlement_id: string
  document_stage: string
  document_kind: 'settlement_draft' | 'tax_invoice' | 'invoice'
  document_label: string
  version: number
  invoice_number: string | null
  byte_size: number
  generated_at: string | null
  file_name: string
}

type WeeklySettlement = {
  id: string
  user_id: string
  user_name: string
  week_start: string
  week_end: string
  status: SettlementStatus
  subtotal_cents: number
  gst_cents: number
  total_cents: number
  line_count: number
  evidence_count: number
  workload_amount_confirmed_at: string | null
  dispute_note: string | null
  finance_reviewed_at: string | null
  company_expense_id: string | null
  paid_at: string | null
  payment_destination_snapshot: Record<string, unknown> | null
  payment_destination_preview?: Record<string, unknown> | null
  profile_snapshot: Record<string, unknown>
  rule_snapshot: Record<string, unknown>
  base_totals?: { subtotal_cents: number; gst_cents: number; total_cents: number }
  finance_adjustment_cents?: number
  lines?: SettlementLine[]
  audits?: SettlementAudit[]
  documents?: SettlementDocument[]
  related_claims?: RelatedClaim[]
  phase5_schema_ready?: boolean
}

type ActionState = { action: SettlementAction; settlement: WeeklySettlement } | null
type ActionValues = {
  reason?: string
  adjustment_amount?: number
  dispute_decision?: 'keep_amount' | 'edit_amount'
  final_total_amount?: number
  payment_date?: Dayjs
}

const ACTION_TITLES: Record<SettlementAction, string> = {
  resolve_dispute: '重新核对',
  return_for_confirmation: '退回合作方再次确认',
  adjust: '调整结算金额',
  reopen: '重新打开为草稿',
  confirm_paid: '确认已付款',
  void: '作废本周结算',
}

const ERROR_LABELS: Record<string, string> = {
  settlement_week_not_finished: '只能生成已经结束的完整周结算。',
  settlement_batch_locked: '本周结算已经提交或进入后续状态，不能整周重算。',
  settlement_supplier_profile_incomplete: '合作方法定姓名不完整，或已注册 GST 但缺少有效 ABN，不能退回再次确认或付款。',
  settlement_gst_unconfirmed: 'GST 状态尚未确认，不能退回再次确认或付款。',
  settlement_bank_details_incomplete: '银行资料不完整，不能确认付款。',
  settlement_approval_step_removed: '财务确认步骤已取消，请直接使用“确认已付款”。',
  settlement_document_generation_failed: '付款已经登记，但最终结算 PDF 生成失败，请稍后在详情中重新生成。',
  settlement_transition_invalid: '当前状态不允许执行这个操作，请刷新后重试。',
  invalid_settlement_dispute_resolution: '请选择核对方式，并检查调整后的应付总额。',
  invalid_final_total_cents: '调整后的应付总额无效。',
  settlement_adjustment_exceeds_total: '调整后的应付总额不能低于本周 GST。',
  company_expense_manual_override: '对应公司费用已被人工修改，系统不会自动覆盖。',
  company_expense_paid_lock: '对应公司费用已付款，不能作废。',
  payment_amount_mismatch: '转账金额必须与结算总额完全一致。',
  personnel_settlement_phase5_schema_not_ready: '阶段 5 数据库尚未启用，自动任务和 PDF 暂不可用。',
  settlement_claims_pending: '该合作方本周仍有草稿、待公司核对、需要补充资料或尚未计入的工作量反馈，暂不能退回再次确认或付款。',
  settlement_calculation_blocked: '本周仍有无法自动计算的工作量，请先补齐费用规则、GST 或人员资料。',
  settlement_buyer_profile_incomplete: 'Homixa 开票资料不完整，请先维护默认公司名称、ABN 和地址。',
  missing_or_unsupported_property_type: '清洁任务对应的房源没有登记可用房型。',
  missing_cleaning_property_type_rate: '该人员没有配置这个房型的清洁单价。',
  missing_effective_profile: '该人员在任务日期没有已启用的结算资料。',
  ambiguous_effective_profile: '该人员在任务日期存在重叠的结算资料版本。',
  gst_status_unconfirmed: '该人员在任务日期的 GST 状态尚未确认。',
  missing_effective_rule: '该人员在任务日期没有生效的费用规则。',
  ambiguous_effective_rule: '该人员在任务日期存在重叠的费用规则版本。',
  claim_not_reviewable: '这条反馈已处理，请刷新后重试。',
  claim_period_locked: '该合作方本周结算已进入确认或付款阶段，不能再核对补充内容。',
  claim_evidence_required: '反馈缺少证明材料，不能确认计入。',
  duplicate_approved_claim: '已有内容完全相同的反馈确认计入；如为两笔不同工作，请先退回并补充可区分的时间或说明。',
  settlement_claim_calculation_failed: '这条反馈暂时无法按生效费用规则计算，请检查合作方资料、GST 状态和对应计费项目。',
}

function errorMessage(error: any) {
  const code = String(error?.code || error?.message || '')
  return ERROR_LABELS[code] || code || '操作失败'
}

function statusTag(status: SettlementStatus) {
  const meta = SETTLEMENT_STATUS_META[status] || { label: status, color: 'default' }
  return <Tag color={meta.color}>{meta.label}</Tag>
}

function claimStatusTag(status: RelatedClaim['status']) {
  const meta = CLAIM_STATUS_META[status] || { label: status, color: 'default' }
  return <Tag color={meta.color}>{meta.label}</Tag>
}

function actionEndpoint(action: SettlementAction) {
  if (action === 'resolve_dispute') return 'resolve-dispute'
  if (action === 'return_for_confirmation') return 'return-for-confirmation'
  if (action === 'confirm_paid') return 'confirm-paid'
  return action
}

export default function WeeklySettlementsPanel() {
  const { message } = App.useApp()
  const [form] = Form.useForm<ActionValues>()
  const disputeDecision = Form.useWatch('dispute_decision', form)
  const disputeFinalTotalAmount = Form.useWatch('final_total_amount', form)
  const [weekStart, setWeekStart] = useState<Dayjs>(previousCompletedWeekStart())
  const [status, setStatus] = useState<SettlementStatus | undefined>()
  const [search, setSearch] = useState('')
  const [rows, setRows] = useState<WeeklySettlement[]>([])
  const [loading, setLoading] = useState(false)
  const [detail, setDetail] = useState<WeeklySettlement | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [actionState, setActionState] = useState<ActionState>(null)
  const [actionDetailLoading, setActionDetailLoading] = useState(false)
  const [actionSaving, setActionSaving] = useState(false)
  const [claimReviewBusy, setClaimReviewBusy] = useState<string | null>(null)
  const [actionEvidencePreviewId, setActionEvidencePreviewId] = useState<string | null>(null)
  const [actionEvidenceUrls, setActionEvidenceUrls] = useState<Record<string, string>>({})
  const [actionEvidenceFailures, setActionEvidenceFailures] = useState<Record<string, string>>({})
  const actionEvidenceUrlsRef = useRef<Record<string, string>>({})
  const actionRequestRef = useRef(0)
  const [documentBusy, setDocumentBusy] = useState<string | null>(null)
  const canManage = hasPerm('personnel_settlements.rules.manage')
  const canPayout = hasPerm('finance.payout')
  const canBank = hasPerm('personnel_settlements.bank.manage')
  const canReviewClaims = canManage || canPayout

  const replaceActionEvidenceUrls = useCallback((next: Record<string, string>) => {
    releasePersonnelClaimEvidenceObjectUrls(actionEvidenceUrlsRef.current)
    actionEvidenceUrlsRef.current = next
    setActionEvidenceUrls(next)
  }, [])

  useEffect(() => () => {
    actionRequestRef.current += 1
    releasePersonnelClaimEvidenceObjectUrls(actionEvidenceUrlsRef.current)
  }, [])

  const loadRows = useCallback(async () => {
    setLoading(true)
    try {
      const query = new URLSearchParams({ week_start: weekStart.format('YYYY-MM-DD') })
      if (status) query.set('status', status)
      if (search.trim()) query.set('search', search.trim())
      setRows(await getJSON<WeeklySettlement[]>(`/finance/settlements/weekly?${query.toString()}`, { authSensitive: true }))
    } catch (error: any) {
      setRows([])
      message.error(errorMessage(error))
    } finally {
      setLoading(false)
    }
  }, [message, search, status, weekStart])

  useEffect(() => { void loadRows() }, [loadRows])

  async function openDetail(settlement: WeeklySettlement) {
    setDetailLoading(true)
    setDetail(settlement)
    try {
      setDetail(await getJSON<WeeklySettlement>(`/finance/settlements/weekly/${encodeURIComponent(settlement.id)}`, { authSensitive: true }))
    } catch (error: any) {
      message.error(errorMessage(error))
      setDetail(null)
    } finally {
      setDetailLoading(false)
    }
  }

  async function hydrateDisputeAction(settlement: WeeklySettlement, requestId: number) {
    const nextDetail = await getJSON<WeeklySettlement>(
      `/finance/settlements/weekly/${encodeURIComponent(settlement.id)}`,
      { authSensitive: true },
    )
    const loaded = await Promise.all((nextDetail.related_claims || []).flatMap((claim) =>
      (claim.evidence || []).map(async (item) => {
        try {
          return [item.id, await loadPersonnelClaimEvidenceObjectUrl(claim.id, item.id), null] as const
        } catch (error) {
          return [item.id, null, personnelClaimEvidenceFailureMessage(error)] as const
        }
      }),
    ))
    if (requestId !== actionRequestRef.current) {
      const staleUrls: Record<string, string> = {}
      for (const [id, url] of loaded) {
        if (url) staleUrls[id] = url
      }
      releasePersonnelClaimEvidenceObjectUrls(staleUrls)
      return
    }
    const nextUrls: Record<string, string> = {}
    const nextFailures: Record<string, string> = {}
    for (const [id, url, failure] of loaded) {
      if (url) nextUrls[id] = url
      else nextFailures[id] = failure || '照片读取失败，请稍后重试'
    }
    replaceActionEvidenceUrls(nextUrls)
    setActionEvidenceFailures(nextFailures)
    setActionState((current) => current?.settlement.id === settlement.id
      ? { ...current, settlement: nextDetail }
      : current)
    form.setFieldValue('final_total_amount', Number(nextDetail.total_cents || 0) / 100)
  }

  async function openAction(action: SettlementAction, settlement: WeeklySettlement) {
    actionRequestRef.current += 1
    replaceActionEvidenceUrls({})
    setActionEvidenceFailures({})
    setActionEvidencePreviewId(null)
    form.resetFields()
    form.setFieldsValue({
      payment_date: dayjs(),
      adjustment_amount: Number(settlement.finance_adjustment_cents || 0) / 100,
      dispute_decision: 'keep_amount',
      final_total_amount: Number(settlement.total_cents || 0) / 100,
    })
    setActionState({ action, settlement })
    const requestId = actionRequestRef.current
    if (action === 'confirm_paid') {
      setActionDetailLoading(true)
      try {
        const nextDetail = await getJSON<WeeklySettlement>(
          `/finance/settlements/weekly/${encodeURIComponent(settlement.id)}`,
          { authSensitive: true },
        )
        if (requestId === actionRequestRef.current) {
          setActionState({ action, settlement: nextDetail })
        }
      } catch (error: any) {
        if (requestId === actionRequestRef.current) {
          message.error(errorMessage(error))
          closeAction()
        }
      } finally {
        if (requestId === actionRequestRef.current) setActionDetailLoading(false)
      }
      return
    }
    if (action !== 'resolve_dispute') return
    setActionDetailLoading(true)
    try {
      await hydrateDisputeAction(settlement, requestId)
    } catch (error: any) {
      if (requestId === actionRequestRef.current) {
        message.error(errorMessage(error))
        closeAction()
      }
    } finally {
      if (requestId === actionRequestRef.current) setActionDetailLoading(false)
    }
  }

  function closeAction() {
    actionRequestRef.current += 1
    replaceActionEvidenceUrls({})
    setActionEvidenceFailures({})
    setActionEvidencePreviewId(null)
    setActionState(null)
    setActionDetailLoading(false)
    setClaimReviewBusy(null)
    form.resetFields()
  }

  async function reviewRelatedClaim(claim: RelatedClaim, action: 'approve' | 'reject') {
    if (!actionState || actionState.action !== 'resolve_dispute') return
    setClaimReviewBusy(claim.id)
    try {
      const updated = await postJSON<WeeklySettlement>(
        `/finance/settlements/weekly/${encodeURIComponent(actionState.settlement.id)}/claims/${encodeURIComponent(claim.id)}/review`,
        action === 'approve'
          ? {
              action,
              approved_duration_minutes: claim.duration_minutes,
              approved_quantity: claim.requested_quantity,
              approved_amount_cents: claim.requested_amount_cents,
              review_note: null,
            }
          : {
              action,
              approved_duration_minutes: null,
              approved_quantity: null,
              approved_amount_cents: null,
              review_note: '财务核对本周结算时确认本次不纳入',
            },
        { authSensitive: true },
      )
      setActionState((current) => current?.settlement.id === updated.id
        ? { ...current, settlement: updated }
        : current)
      setRows((current) => current.map((row) => row.id === updated.id
        ? {
            ...row,
            subtotal_cents: updated.subtotal_cents,
            gst_cents: updated.gst_cents,
            total_cents: updated.total_cents,
            line_count: updated.lines?.length ?? row.line_count,
          }
        : row))
      form.setFieldsValue({
        dispute_decision: 'keep_amount',
        final_total_amount: Number(updated.total_cents || 0) / 100,
      })
      message.success(action === 'approve'
        ? `反馈已确认并自动计入，应付总额 ${formatMoney(updated.total_cents)}`
        : '反馈已标记为本次不纳入')
    } catch (error: any) {
      message.error(errorMessage(error))
    } finally {
      setClaimReviewBusy(null)
    }
  }

  async function openDocument(settlementId: string, document: SettlementDocument) {
    setDocumentBusy(document.id)
    try {
      const blob = await getBlob(
        `/finance/settlements/weekly/${encodeURIComponent(settlementId)}/documents/${encodeURIComponent(document.id)}`,
        { authSensitive: true, timeoutMs: 60000 },
      )
      const objectUrl = URL.createObjectURL(blob)
      window.open(objectUrl, '_blank', 'noopener,noreferrer')
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000)
    } catch (error: any) {
      message.error(errorMessage(error))
    } finally {
      setDocumentBusy(null)
    }
  }

  async function generateCurrentDocument() {
    if (!detail) return
    setDocumentBusy('generate')
    try {
      await postJSON(`/finance/settlements/weekly/${encodeURIComponent(detail.id)}/generate-document`, {}, { authSensitive: true, timeoutMs: 120000 })
      await openDetail(detail)
      message.success('当前状态 PDF 已生成')
    } catch (error: any) {
      message.error(errorMessage(error))
    } finally {
      setDocumentBusy(null)
    }
  }

  async function submitAction() {
    if (!actionState) return
    const { action, settlement } = actionState
    let values: ActionValues = {}
    values = await form.validateFields()
    let payload: Record<string, unknown> = {}
    if (action === 'adjust') {
      payload = {
        adjustment_cents: Math.round(Number(values.adjustment_amount || 0) * 100),
        reason: values.reason?.trim(),
      }
    } else if (action === 'resolve_dispute') {
      payload = values.dispute_decision === 'edit_amount'
        ? {
            decision: 'edit_amount',
            final_total_cents: Math.round(Number(values.final_total_amount || 0) * 100),
          }
        : { decision: 'keep_amount' }
    } else if (action === 'return_for_confirmation' || action === 'reopen' || action === 'void') {
      payload = { reason: values.reason?.trim() }
    } else if (action === 'confirm_paid') {
      payload = {
        payment_date: values.payment_date?.format('YYYY-MM-DD'),
      }
    }
    setActionSaving(true)
    try {
      const updated = await postJSON<WeeklySettlement & { document_warning?: string | null }>(
        `/finance/settlements/weekly/${encodeURIComponent(settlement.id)}/${actionEndpoint(action)}`,
        payload,
        { authSensitive: true },
      )
      if (updated.document_warning) {
        message.warning(errorMessage({ code: updated.document_warning }))
      } else {
        message.success(action === 'resolve_dispute' ? '已完成重新核对，并再次发送合作方确认' : `${ACTION_TITLES[action]}成功`)
      }
      closeAction()
      setDetail(null)
      await loadRows()
    } catch (error: any) {
      message.error(errorMessage(error))
    } finally {
      setActionSaving(false)
    }
  }

  const permissions = { canManage, canPayout, canBank }
  const columns: ColumnsType<WeeklySettlement> = [
    { title: '人员', dataIndex: 'user_name', fixed: 'left', width: 170 },
    { title: '周期', key: 'week', width: 190, render: (_, row) => `${row.week_start} 至 ${row.week_end}` },
    { title: '状态', dataIndex: 'status', width: 120, render: statusTag },
    { title: '明细', dataIndex: 'line_count', width: 80, align: 'right' },
    { title: '未税金额', dataIndex: 'subtotal_cents', width: 120, align: 'right', render: formatMoney },
    { title: 'GST', dataIndex: 'gst_cents', width: 105, align: 'right', render: formatMoney },
    { title: '应付总额', dataIndex: 'total_cents', width: 125, align: 'right', render: (value) => <strong>{formatMoney(value)}</strong> },
    {
      title: '合作方提交',
      key: 'confirmation',
      width: 150,
      render: (_, row) => row.dispute_note
        ? <Typography.Text type="danger" ellipsis={{ tooltip: row.dispute_note }}>{row.dispute_note}</Typography.Text>
        : formatDateTime(row.workload_amount_confirmed_at),
    },
    {
      title: '付款日期',
      key: 'paid',
      width: 130,
      render: (_, row) => formatDateOnly(
        typeof row.payment_destination_snapshot?.payment_date === 'string'
          ? row.payment_destination_snapshot.payment_date
          : row.paid_at,
      ),
    },
    {
      title: '操作',
      key: 'actions',
      fixed: 'right',
      width: 390,
      render: (_, row) => <TableRowActions actions={[
        { key: 'detail', label: '详情', onClick: () => { void openDetail(row) } },
        { key: 'resolve-dispute', label: '重新核对', hidden: !canUseSettlementAction(row.status, 'resolve_dispute', permissions), onClick: () => { void openAction('resolve_dispute', row) } },
        { key: 'return', label: '退回再次确认', hidden: !canUseSettlementAction(row.status, 'return_for_confirmation', permissions), onClick: () => { void openAction('return_for_confirmation', row) } },
        { key: 'adjust', label: '调整', hidden: !canUseSettlementAction(row.status, 'adjust', permissions), onClick: () => { void openAction('adjust', row) } },
        { key: 'reopen', label: '重新打开', hidden: !canUseSettlementAction(row.status, 'reopen', permissions), onClick: () => { void openAction('reopen', row) } },
        { key: 'confirm-paid', label: '确认已付款', hidden: !canUseSettlementAction(row.status, 'confirm_paid', permissions), onClick: () => { void openAction('confirm_paid', row) } },
        { key: 'void', label: '作废', danger: true, hidden: !canUseSettlementAction(row.status, 'void', permissions), onClick: () => { void openAction('void', row) } },
      ]} />,
    },
  ]

  const lineColumns: ColumnsType<SettlementLine> = [
    { title: '日期', dataIndex: 'service_date', width: 105 },
    { title: '项目', dataIndex: 'component_type', width: 115, render: (value) => COMPONENT_TYPE_LABELS[value] || value },
    { title: '说明', dataIndex: 'description', ellipsis: true, render: (value) => value || '-' },
    { title: '数量', key: 'quantity', width: 90, align: 'right', render: (_, row) => `${row.quantity_numerator}/${row.quantity_denominator}` },
    { title: '单价', dataIndex: 'unit_rate_cents', width: 105, align: 'right', render: formatMoney },
    { title: 'GST', dataIndex: 'gst_cents', width: 95, align: 'right', render: formatMoney },
    { title: '合计', dataIndex: 'total_cents', width: 110, align: 'right', render: formatMoney },
  ]
  const disputeClaims = actionState?.action === 'resolve_dispute'
    ? actionState.settlement.related_claims || []
    : []
  const unresolvedDisputeClaims = disputeClaims.filter((claim) => claim.status === 'submitted' || claim.status === 'returned')
  const approvedUnincludedClaims = disputeClaims.filter((claim) => claim.status === 'approved' && !claim.included_in_settlement)
  const claimsBlockingResolution = [...unresolvedDisputeClaims, ...approvedUnincludedClaims]
  const paymentSettlement = actionState?.action === 'confirm_paid' ? actionState.settlement : null
  const paymentDestination = paymentSettlement?.payment_destination_preview || paymentSettlement?.payment_destination_snapshot || {}
  const paymentProfile = paymentSettlement?.profile_snapshot || {}
  const paymentMethod = normalizePersonnelPaymentMethod(paymentDestination.payment_method || paymentProfile.payment_method)
  const partnerName = String(
    paymentProfile.supplier_business_name
    || paymentProfile.supplier_legal_name
    || paymentSettlement?.user_name
    || '-',
  )
  const paymentAccountName = String(paymentDestination.bank_account_name || '')
  const paymentBsb = String(paymentDestination.bank_bsb || '')
  const paymentAccountNumber = String(paymentDestination.bank_account_number || '')
  const paymentDetailsComplete = !personnelPaymentMethodRequiresBankDetails(paymentMethod)
    || Boolean(paymentAccountName && paymentBsb && paymentAccountNumber)

  return <>
    <Alert
      type="info"
      showIcon
      message="合作方先在移动端提交上一完整周的工作量；财务在这里核对。无问题时按人员资料中的付款方式完成付款并确认；有问题时退回合作方再次确认。"
      style={{ marginBottom: 12 }}
    />
    <Space wrap style={{ marginBottom: 12 }}>
      <Typography.Text strong>结算周</Typography.Text>
      <DatePicker
        picker="week"
        value={weekStart}
        format={formatSettlementWeekRange}
        allowClear={false}
        onChange={(value) => value && setWeekStart(mondayForDate(value))}
        disabledDate={(value) => !mondayForDate(value).add(6, 'day').isBefore(dayjs(), 'day')}
        style={{ width: 250 }}
      />
      <Select
        allowClear
        placeholder="全部状态"
        value={status}
        onChange={setStatus}
        style={{ width: 150 }}
        options={Object.entries(SETTLEMENT_STATUS_META).map(([value, meta]) => ({ value, label: meta.label }))}
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
    <Table<WeeklySettlement>
      rowKey="id"
      loading={loading}
      dataSource={rows}
      columns={columns}
      scroll={{ x: 1500 }}
      pagination={{ pageSize: 50, showSizeChanger: true }}
    />

    <Drawer
      width={920}
      open={!!detail}
      loading={detailLoading}
      title="周结算详情"
      onClose={() => setDetail(null)}
      footer={<div style={{ textAlign: 'right' }}><Button onClick={() => setDetail(null)}>关闭</Button></div>}
    >
      {detail ? <>
        <Descriptions bordered size="small" column={2}>
          <Descriptions.Item label="人员">{detail.user_name}</Descriptions.Item>
          <Descriptions.Item label="状态">{statusTag(detail.status)}</Descriptions.Item>
          <Descriptions.Item label="结算周期">{detail.week_start} 至 {detail.week_end}</Descriptions.Item>
          <Descriptions.Item label="合作方提交/确认">{formatDateTime(detail.workload_amount_confirmed_at)}</Descriptions.Item>
          <Descriptions.Item label="基础未税金额">{formatMoney(detail.base_totals?.subtotal_cents)}</Descriptions.Item>
          <Descriptions.Item label="财务调整">{formatMoney(detail.finance_adjustment_cents)}</Descriptions.Item>
          <Descriptions.Item label="GST">{formatMoney(detail.gst_cents)}</Descriptions.Item>
          <Descriptions.Item label="应付总额"><strong>{formatMoney(detail.total_cents)}</strong></Descriptions.Item>
          <Descriptions.Item label="公司费用编号">{detail.company_expense_id || '-'}</Descriptions.Item>
          <Descriptions.Item label="付款日期">{formatDateOnly(
            typeof detail.payment_destination_snapshot?.payment_date === 'string'
              ? detail.payment_destination_snapshot.payment_date
              : detail.paid_at,
          )}</Descriptions.Item>
          <Descriptions.Item label="付款方式">{PERSONNEL_PAYMENT_METHOD_LABELS[normalizePersonnelPaymentMethod(
            detail.payment_destination_snapshot?.payment_method || detail.profile_snapshot?.payment_method,
          )]}</Descriptions.Item>
          <Descriptions.Item label="重新核对说明" span={2}>{detail.dispute_note || '-'}</Descriptions.Item>
          <Descriptions.Item label="收款账户" span={2}>
            {personnelPaymentMethodRequiresBankDetails(
              detail.payment_destination_snapshot?.payment_method || detail.profile_snapshot?.payment_method,
            )
              ? [
                  detail.payment_destination_snapshot?.bank_account_name,
                  detail.payment_destination_snapshot?.bank_bsb || detail.payment_destination_snapshot?.bank_bsb_masked,
                  detail.payment_destination_snapshot?.bank_account_number || detail.payment_destination_snapshot?.bank_account_masked,
                ].filter(Boolean).join(' · ') || '-'
              : '不适用'}
          </Descriptions.Item>
        </Descriptions>
        <Divider orientation="left">结算文件</Divider>
        {detail.phase5_schema_ready === false ? <Alert type="warning" showIcon message="阶段 5 数据库尚未启用，暂未生成 PDF。" /> : <>
          {canManage && ['awaiting_confirmation', 'confirmed', 'finance_approved', 'paid'].includes(detail.status) ? <Button loading={documentBusy === 'generate'} onClick={() => void generateCurrentDocument()} style={{ marginBottom: 10 }}>生成当前状态文件</Button> : null}
          <Table<SettlementDocument>
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={detail.documents || []}
            locale={{ emptyText: '暂无结算文件' }}
            columns={[
              { title: '文件', dataIndex: 'document_label' },
              { title: '状态版本', key: 'version', width: 120, render: (_, row) => `${row.document_stage} · v${row.version}` },
              { title: '发票号', dataIndex: 'invoice_number', width: 190, render: (value) => value || '-' },
              { title: '生成时间', dataIndex: 'generated_at', width: 165, render: formatDateTime },
              { title: '操作', key: 'open', width: 90, render: (_, row) => <Button type="link" loading={documentBusy === row.id} onClick={() => void openDocument(detail.id, row)}>查看 PDF</Button> },
            ]}
          />
        </>}
        <Divider orientation="left">费用明细</Divider>
        <Table<SettlementLine>
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={detail.lines || []}
          columns={lineColumns}
          scroll={{ x: 850 }}
        />
        <Divider orientation="left">操作记录</Divider>
        <Table<SettlementAudit>
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={detail.audits || []}
          columns={[
            { title: '时间', dataIndex: 'created_at', width: 165, render: formatDateTime },
            { title: '操作', dataIndex: 'action', width: 220 },
            { title: '操作人', key: 'actor', render: (_, row) => row.actor_name || row.actor_id || '-' },
          ]}
        />
      </> : null}
    </Drawer>

    <Modal
      open={!!actionState}
      width={actionState?.action === 'resolve_dispute' ? 820 : actionState?.action === 'confirm_paid' ? 680 : 760}
      title={actionState?.action === 'resolve_dispute'
        ? <Space size={10}><span>重新核对结算</span><Tag color="error" className={styles.disputeTitleTag}>待重新核对</Tag></Space>
        : actionState ? ACTION_TITLES[actionState.action] : ''}
      okText={actionState?.action === 'resolve_dispute'
        ? '确认并重新发起'
        : actionState?.action === 'confirm_paid'
          ? '确认已付款'
        : '确认'}
      cancelText="取消"
      confirmLoading={actionSaving}
      className={actionState?.action === 'resolve_dispute'
        ? styles.disputeModal
        : actionState?.action === 'confirm_paid'
          ? styles.paymentModal
          : undefined}
      style={actionState?.action === 'resolve_dispute' ? { top: 24 } : undefined}
      styles={actionState?.action === 'resolve_dispute'
        ? { body: { maxHeight: 'calc(100vh - 180px)', overflowY: 'auto' } }
        : undefined}
      okButtonProps={{
        danger: actionState?.action === 'void',
        disabled: (actionState?.action === 'resolve_dispute'
          && (actionDetailLoading || !!claimReviewBusy || claimsBlockingResolution.length > 0))
          || (actionState?.action === 'confirm_paid' && (actionDetailLoading || !paymentDetailsComplete)),
      }}
      onCancel={() => { if (!actionSaving && !claimReviewBusy) closeAction() }}
      onOk={() => void submitAction()}
    >
      {actionState?.action === 'return_for_confirmation' ? <Alert
        showIcon
        type="warning"
        message="系统会按最新费用规则重新计算，并退回合作方再次确认。"
        description="如仍存在缺失费用规则、GST 未确认或待核对的工作量反馈，本次退回会被阻止。"
        style={{ marginBottom: 16 }}
      /> : null}
      {actionState?.action === 'resolve_dispute' ? <>
        <div className={styles.disputeSummary}>
          <div className={styles.summaryItem}>
            <Typography.Text type="secondary">人员</Typography.Text>
            <Typography.Text strong>{actionState.settlement.user_name}</Typography.Text>
          </div>
          <div className={styles.summaryItem}>
            <Typography.Text type="secondary">结算周期</Typography.Text>
            <Typography.Text strong>{actionState.settlement.week_start} 至 {actionState.settlement.week_end}</Typography.Text>
          </div>
          <div className={`${styles.summaryItem} ${styles.summaryAmount}`}>
            <Typography.Text type="secondary">当前应付总额</Typography.Text>
            <Typography.Text className={styles.summaryAmountValue}>{formatMoney(actionState.settlement.total_cents)}</Typography.Text>
          </div>
        </div>
        <div className={styles.disputeReason}>
          <CloseCircleFilled />
          <Typography.Text strong>合作方反馈</Typography.Text>
          <Typography.Text>{actionState.settlement.dispute_note || '未填写重新核对说明'}</Typography.Text>
        </div>
        <div className={styles.sectionHeading}>
          <Typography.Title level={5}>本周补充内容</Typography.Title>
          <span />
        </div>
        <Spin spinning={actionDetailLoading} tip="正在读取补充内容和证明照片">
          <Space direction="vertical" size={12} className={styles.claimsSection}>
            {!actionDetailLoading && !disputeClaims.length ? (
              <Alert type="info" showIcon message="本周没有关联的工作量反馈，财务可按合作方说明确认或修改总额。" />
            ) : null}
            {disputeClaims.length ? <div className={styles.claimList}>
              <div className={styles.claimGridHeader} aria-hidden="true">
                <span>补充内容</span>
                <span>金额</span>
                <span>说明</span>
                <span>证明照片</span>
                <span>状态</span>
              </div>
              {disputeClaims.map((claim) => <div key={claim.id} className={styles.claimRow}>
                <div className={styles.claimIdentity}>
                  <Space size={6} wrap>
                    <Typography.Text strong>{CLAIM_TYPE_LABELS[claim.claim_type] || claim.claim_type}</Typography.Text>
                    <Typography.Text type="secondary">· {claim.service_date}</Typography.Text>
                  </Space>
                  <Space size={4} wrap>
                    {claimStatusTag(claim.status)}
                    {claim.included_in_settlement ? <Tag color="green">已计入当前金额</Tag> : null}
                  </Space>
                </div>
                <div className={styles.claimCell} data-label="金额">
                  <Typography.Text strong className={styles.claimAmount}>
                    {claim.approved_amount_cents != null
                      ? formatMoney(claim.approved_amount_cents)
                      : claim.requested_amount_cents == null ? '按费用规则计算' : formatMoney(claim.requested_amount_cents)}
                  </Typography.Text>
                  {claim.status !== 'approved' && claim.requested_amount_cents != null
                    ? <Typography.Text type="secondary" className={styles.claimSecondary}>提交金额</Typography.Text>
                    : null}
                </div>
                <div className={styles.claimCell} data-label="说明">
                  <Typography.Text>{claim.note || '-'}</Typography.Text>
                </div>
                <div className={styles.claimCell} data-label="证明照片">
                  {(claim.evidence || []).length ? <Space wrap align="start" size={8}>
                    {(claim.evidence || []).map((item) => <div key={item.id} className={styles.evidenceItem}>
                      {actionEvidenceUrls[item.id]
                        ? <>
                            <Image
                              src={actionEvidenceUrls[item.id]}
                              alt="工作量证明"
                              width={112}
                              height={76}
                              preview={{
                                visible: actionEvidencePreviewId === item.id,
                                onVisibleChange: (visible) => setActionEvidencePreviewId(visible ? item.id : null),
                              }}
                              style={{ objectFit: 'cover', borderRadius: 6 }}
                            />
                            <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => setActionEvidencePreviewId(item.id)}>查看证明</Button>
                          </>
                        : <div className={styles.evidencePlaceholder}>
                            {actionEvidenceFailures[item.id] || '照片加载中'}
                          </div>}
                    </div>)}
                  </Space> : <Typography.Text type="secondary">未关联证明材料</Typography.Text>}
                </div>
                <div className={styles.claimCell} data-label="状态">
                  {claim.included_in_settlement
                    ? <span className={styles.includedStatus}><CheckCircleFilled />已自动计入本周结算</span>
                    : <Typography.Text type="secondary">{claim.status === 'submitted' ? '等待财务核对' : '尚未计入'}</Typography.Text>}
                </div>
                {(claim.status === 'submitted' || (claim.status === 'approved' && !claim.included_in_settlement)) && canReviewClaims ? <Space className={styles.claimActions} wrap>
                  <Button type="primary" size="small" loading={claimReviewBusy === claim.id} onClick={() => void reviewRelatedClaim(claim, 'approve')}>
                    {claim.status === 'submitted' ? '确认并自动计入' : '计入当前金额'}
                  </Button>
                  {claim.status === 'submitted' ? <Button size="small" disabled={!!claimReviewBusy} onClick={() => void reviewRelatedClaim(claim, 'reject')}>不计入</Button> : null}
                </Space> : null}
              </div>)}
            </div> : null}
            {unresolvedDisputeClaims.length ? <Alert
              type="warning"
              showIcon
              message="请先核对全部待处理内容"
              description="确认后系统会按生效费用规则和 GST 自动计入本周总额；选择本次不纳入不会改变金额。需要补充资料的内容可由合作方完善后重新提交。"
            /> : null}
            {approvedUnincludedClaims.length ? <Alert
              type="info"
              showIcon
              message="发现旧流程中已确认但尚未计入的反馈，请点击“计入当前金额”完成自动重算。"
            /> : null}
          </Space>
        </Spin>
      </> : null}
      {actionState?.action === 'confirm_paid' ? <Spin spinning={actionDetailLoading} tip="正在读取收款账户">
        <div className={styles.paymentSummary}>
          <div className={styles.paymentAmountBlock}>
            <Typography.Text type="secondary">本次付款金额</Typography.Text>
            <Typography.Text className={styles.paymentAmountValue}>{formatMoney(paymentSettlement?.total_cents)}</Typography.Text>
            <Typography.Text type="secondary">
              税前 {formatMoney(paymentSettlement?.subtotal_cents)} · GST {formatMoney(paymentSettlement?.gst_cents)}
            </Typography.Text>
          </div>
          <Descriptions bordered size="small" column={2}>
            <Descriptions.Item label="合作方">{partnerName}</Descriptions.Item>
            <Descriptions.Item label="结算周期">{paymentSettlement?.week_start} 至 {paymentSettlement?.week_end}</Descriptions.Item>
            <Descriptions.Item label="付款方式">{PERSONNEL_PAYMENT_METHOD_LABELS[paymentMethod]}</Descriptions.Item>
            {personnelPaymentMethodRequiresBankDetails(paymentMethod) ? <>
              <Descriptions.Item label="收款人">{paymentAccountName || '未登记'}</Descriptions.Item>
              <Descriptions.Item label="BSB">{paymentBsb || '未登记'}</Descriptions.Item>
              <Descriptions.Item label="银行账号" span={2}>
                {paymentAccountNumber
                  ? <Typography.Text copyable={{ text: paymentAccountNumber }}>{paymentAccountNumber}</Typography.Text>
                  : '未登记'}
              </Descriptions.Item>
            </> : <Descriptions.Item label="付款说明" span={2}>结算账面金额仍以 AUD 记录；请在线下完成该付款方式后再确认。</Descriptions.Item>}
          </Descriptions>
        </div>
        {personnelPaymentMethodRequiresBankDetails(paymentMethod) && !paymentDetailsComplete && !actionDetailLoading ? <Alert
          showIcon
          type="error"
          message="收款账户资料不完整"
          description="请先在人员资料中补充收款人、BSB 和银行账号，再确认付款。"
          style={{ marginBottom: 16 }}
        /> : null}
        <Alert
          showIcon
          type="warning"
          message={`请先完成${PERSONNEL_PAYMENT_METHOD_LABELS[paymentMethod]}`}
          description="点击“确认已付款”只登记已经完成的付款，不会发起实际支付。确认后结算与公司支出将锁定为已付款。"
          style={{ marginBottom: 16 }}
        />
      </Spin> : null}
      {actionState?.action === 'void' ? <Alert showIcon type="error" message="作废会同步作废尚未付款的公司费用；已经付款的结算不能作废。" style={{ marginBottom: 16 }} /> : null}
      {actionState?.action ? <Form form={form} layout="vertical">
        {actionState.action === 'resolve_dispute' ? <>
          <div className={styles.sectionHeading}>
            <Typography.Title level={5}>财务核对</Typography.Title>
            <span />
          </div>
          <Form.Item name="dispute_decision" rules={[{ required: true, message: '请选择处理方式' }]}>
            <Radio.Group optionType="button" buttonStyle="solid" className={styles.decisionGroup}>
              <Radio.Button value="keep_amount">确认自动汇总金额</Radio.Button>
              <Radio.Button value="edit_amount">特殊调整总额</Radio.Button>
            </Radio.Group>
          </Form.Item>
          {disputeDecision === 'edit_amount' ? <Form.Item
            label="特殊调整后的应付总额（AUD）"
            name="final_total_amount"
            rules={[{ required: true, message: '请输入调整后的应付总额' }]}
          >
            <InputNumber precision={2} min={0} max={1_000_000} style={{ width: '100%' }} />
          </Form.Item> : null}
          <div className={styles.reissueSummary}>
            <div>
              <Typography.Text strong>重新发起给 {actionState.settlement.user_name} 确认</Typography.Text>
              <Typography.Text type="secondary">本人将再次核对工作量及金额</Typography.Text>
            </div>
            <div className={styles.reissueAmount}>
              <Typography.Text type="secondary">金额</Typography.Text>
              <Typography.Text strong>{disputeDecision === 'edit_amount'
                ? formatMoney(Math.round(Number(disputeFinalTotalAmount || 0) * 100))
                : formatMoney(actionState.settlement.total_cents)}</Typography.Text>
            </div>
          </div>
          <div className={styles.reissueHint}><InfoCircleOutlined />确认后将重新发送给本人核对工作量及金额</div>
        </> : null}
        {actionState.action === 'adjust' ? <Form.Item label="调整金额（AUD，可为负数）" name="adjustment_amount" rules={[{ required: true, message: '请输入调整金额' }]}><InputNumber precision={2} min={-1_000_000} max={1_000_000} style={{ width: '100%' }} /></Form.Item> : null}
        {actionState.action === 'return_for_confirmation' ? <Form.Item label="退回说明" name="reason" rules={[{ required: true, whitespace: true, message: '请填写需要合作方再次确认的原因' }]}><Input.TextArea maxLength={1000} showCount rows={3} placeholder="请写明需要核对的日期、工作内容或金额" /></Form.Item> : null}
        {actionState.action === 'adjust' || actionState.action === 'reopen' || actionState.action === 'void' ? <Form.Item label="原因" name="reason" rules={[{ required: true, whitespace: true, message: '请填写原因' }]}><Input.TextArea maxLength={1000} showCount rows={3} /></Form.Item> : null}
        {actionState.action === 'confirm_paid' ? <>
          <Form.Item label="付款日期" name="payment_date" rules={[{ required: true, message: '请选择付款日期' }]}><DatePicker style={{ width: '100%' }} format="DD/MM/YYYY" disabledDate={(value) => value.isAfter(dayjs(), 'day')} /></Form.Item>
        </> : null}
      </Form> : null}
    </Modal>
  </>
}
