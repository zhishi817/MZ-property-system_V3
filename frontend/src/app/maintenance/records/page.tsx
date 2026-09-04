"use client"
import { Alert, Card, Table, Space, Button, Input, Select, DatePicker, Modal, Form, App, Upload, Grid, Drawer, Image, InputNumber, Switch, Typography, Tag, Row, Col, Divider, Spin, Descriptions, Progress, Steps } from 'antd'
import { AppstoreOutlined, CreditCardOutlined, EnvironmentOutlined, InfoCircleOutlined, PercentageOutlined, DollarCircleOutlined, PictureOutlined, CheckCircleOutlined } from '@ant-design/icons'
import html2canvas from 'html2canvas'
import type { UploadFile } from 'antd/es/upload/interface'
import dayjs from 'dayjs'
import { useEffect, useMemo, useRef, useState } from 'react'
import { apiUpdate, getJSON, API_BASE, authHeaders } from '../../../lib/api'
import { hasPerm } from '../../../lib/auth'
import { downloadNamedBlob } from '../../../lib/download'
import { sortProperties } from '../../../lib/properties'
import TableRowActions from '../../../components/TableRowActions'
import MaintenanceFeedbackImage from '../../../components/MaintenanceFeedbackImage'
import { loadMaintenanceFeedbackMedia, maintenanceAfterPhotoReferences } from '../../../lib/maintenanceFeedbackMedia'
import { approveInternalMaintenance, assignInternalMaintenance, correctInternalMaintenanceCompletion, createInternalMaintenanceFeedback, deleteInternalMaintenanceFeedback, internalMaintenanceAssignmentChanged, internalMaintenanceHasNewCompletionPhoto, manageInternalMaintenanceWorkflow, shouldAutoApproveInternalMaintenanceSettlement, shouldUpdateInternalMaintenanceRecordViaCrud } from '../../../lib/maintenanceWorkflowActions'
import { runWorkRecordPdfJob } from '../../../lib/workRecordPdfJobs'
import styles from './records.module.scss'

type RepairOrder = {
  id: string
  property_id?: string
  area?: string
  category?: string
  invoice_description_en?: string
  detail?: string
  details?: string
  attachment_urls?: string[]
  work_no?: string
  submitter_name?: string
  submitter_id?: string
  submitted_at?: string
  urgency?: 'urgent'|'normal'|'not_urgent'|'high'|'medium'|'low'
  status?: 'pending_assignment'|'pending'|'assigned'|'in_progress'|'repairing'|'started'|'pending_review'|'review_pending'|'awaiting_review'|'completed'|'done'|'ready'|'closed'|'canceled'|'cancelled'
  assignee_id?: string
  eta?: string
  completed_at?: string
  remark?: string
  repair_notes?: string
  repair_photo_urls?: string[]
  completion_photo_urls?: string[]
  photo_urls?: string[]
  assignee_name?: string | null
  maintenance_amount?: number | string | null
  has_parts?: boolean | null
  parts_amount?: number | string | null
  maintenance_amount_includes_parts?: boolean | null
  has_gst?: boolean | null
  maintenance_amount_includes_gst?: boolean | null
  pay_method?: string | null
  pay_other_note?: string | null
}

function newMaintenanceWorkflowOperationId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `maintenance-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function isCancelledMaintenanceStatus(status?: string | null) {
  return ['canceled', 'cancelled'].includes(String(status || '').trim().toLowerCase())
}

function normalizedMaintenanceWorkflowStatus(status?: string | null) {
  const value = String(status || '').trim().toLowerCase()
  if (value === 'closed') return 'closed'
  if (value === 'canceled' || value === 'cancelled') return 'cancelled'
  if (['pending_review', 'review_pending', 'awaiting_review', 'completed', 'done', 'ready'].includes(value)) return 'pending_review'
  if (['in_progress', 'repairing', 'started'].includes(value)) return 'in_progress'
  if (value === 'assigned') return 'assigned'
  return 'pending_assignment'
}

function maintenanceWorkflowTargetOptions(status?: string | null) {
  const current = normalizedMaintenanceWorkflowStatus(status)
  const optionsByStatus: Record<string, { value: string; label: string }[]> = {
    pending_assignment: [
      { value: 'pending_assignment', label: '待分派（不变）' },
      { value: 'in_progress', label: '维修中' },
      { value: 'pending_review', label: '待审核（需维修后照片）' },
      { value: 'closed', label: '关闭（需维修后照片）' },
      { value: 'cancelled', label: '取消' },
    ],
    assigned: [
      { value: 'assigned', label: '已分配（不变）' },
      { value: 'in_progress', label: '维修中' },
      { value: 'pending_review', label: '待审核（需维修后照片）' },
      { value: 'closed', label: '关闭（需维修后照片）' },
      { value: 'cancelled', label: '取消' },
    ],
    in_progress: [
      { value: 'in_progress', label: '维修中（不变）' },
      { value: 'pending_review', label: '待审核（需维修后照片）' },
      { value: 'closed', label: '关闭（需维修后照片）' },
      { value: 'cancelled', label: '取消' },
    ],
    pending_review: [
      { value: 'pending_review', label: '待审核（不变）' },
      { value: 'closed', label: '审核关闭' },
      { value: 'pending_assignment', label: '退回维修（待分派）' },
    ],
    closed: [
      { value: 'closed', label: '已关闭（不变）' },
      { value: 'in_progress', label: '重新打开维修' },
    ],
    cancelled: [{ value: 'cancelled', label: '已取消（不变）' }],
  }
  return optionsByStatus[current] || []
}

function maintenanceWorkflowStep(status?: string | null) {
  const current = normalizedMaintenanceWorkflowStatus(status)
  if (current === 'in_progress') return 1
  if (current === 'pending_review') return 2
  if (current === 'closed') return 3
  return 0
}

function maintenanceDrawerActionCopy(input: { currentStatus?: string | null; targetStatus?: string | null; hasCompletionPhoto: boolean; canManageWorkflow: boolean }) {
  const current = normalizedMaintenanceWorkflowStatus(input.currentStatus)
  const target = normalizedMaintenanceWorkflowStatus(input.targetStatus || current)

  if (!input.canManageWorkflow) {
    return { title: '保存记录', detail: '保存本次填写的记录内容；状态仍由具备流程权限的人员处理。' }
  }
  if (current === 'closed' && target === 'closed') {
    return { title: '保存完成信息', detail: '可直接更新实际完成日期、维修人员、完工说明或照片；系统会自动保留修正记录，房东支付费用会同步归属月份。' }
  }
  if (target === 'cancelled' && target !== current) {
    return { title: '取消维修', detail: '需要填写取消原因，保存后记录将停止流转。' }
  }
  if (target === 'pending_assignment' && current === 'pending_review') {
    return { title: '退回维修', detail: '需要填写退回原因；保存后回到待分派，并解除原维修人员和预计时间。' }
  }
  if (target === 'in_progress' && current === 'closed') {
    return { title: '重新打开维修', detail: '需要填写重新打开原因；记录会回到维修中。' }
  }
  if (target === 'in_progress' && target !== current) {
    return { title: '开始维修', detail: '保存后记录进入维修中。' }
  }
  if (target === 'closed' && target !== current) {
    return { title: '审核并关闭', detail: '登记实际维修人员、完成日期和维修后照片后，按既有流程审核关闭。' }
  }
  if (target === 'pending_review' && target !== current) {
    return { title: '提交审核', detail: '登记实际维修人员、完成日期和至少一张维修后照片后，保存进入待审核。' }
  }
  if (['pending_assignment', 'assigned', 'in_progress'].includes(current) && input.hasCompletionPhoto) {
    return { title: '提交审核', detail: '检测到维修后照片；保存后会按既有流程进入待审核。' }
  }
  return { title: '保存更新', detail: '保存本次填写的记录内容，不直接改写生命周期状态。' }
}

export default function MaintenanceRecordsUnified() {
  const [list, setList] = useState<RepairOrder[]>([])
  const [props, setProps] = useState<{ id: string; code?: string }[]>([])
  const [filterCode, setFilterCode] = useState('')
  const [filterPropertyId, setFilterPropertyId] = useState<string | undefined>(undefined)
  const [filterWorkNo, setFilterWorkNo] = useState('')
  const [filterSubmitter, setFilterSubmitter] = useState('')
  const [filterPayMethod, setFilterPayMethod] = useState<string | undefined>(undefined)
  const [filterStatus, setFilterStatus] = useState<string | undefined>(undefined)
  const [dateRange, setDateRange] = useState<[any, any] | null>(null)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const [pdfPreview, setPdfPreview] = useState<{ open: boolean; url: string; title: string; showChinese: boolean; blob: Blob | null; row: RepairOrder | null; loading: boolean }>({ open: false, url: '', title: '', showChinese: false, blob: null, row: null, loading: false })
  const [pdfJobUi, setPdfJobUi] = useState<{ open: boolean; stage: string; detail: string; progress: number; timeout: boolean }>({ open: false, stage: '', detail: '', progress: 0, timeout: false })
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<RepairOrder | null>(null)
  const [saving, setSaving] = useState(false)
  const [form] = Form.useForm()
  const { message } = App.useApp()
  const canDownload = hasPerm('property_maintenance.view') || hasPerm('property_maintenance.write') || hasPerm('rbac.manage')
  const canDeleteMaintenance = hasPerm('property_maintenance.delete')
  const canManageMaintenanceWorkflow = hasPerm('property_maintenance.workflow.manage')
  const [pwdOpen, setPwdOpen] = useState(false)
  const [pwdForm] = Form.useForm()
  const [viewOpen, setViewOpen] = useState(false)
  const [viewRow, setViewRow] = useState<RepairOrder | null>(null)
  const [files, setFiles] = useState<UploadFile[]>([])
  const [repairPhotos, setRepairPhotos] = useState<string[]>([])
  const [preFiles, setPreFiles] = useState<UploadFile[]>([])
  const [prePhotos, setPrePhotos] = useState<string[]>([])
  const [createOpen, setCreateOpen] = useState(false)
  const [createForm] = Form.useForm()
  const [createFiles, setCreateFiles] = useState<UploadFile[]>([])
  const [createSaving, setCreateSaving] = useState(false)
  const storedPhotoPreviewVersionRef = useRef(0)
  const storedPhotoObjectUrlsRef = useRef(new Set<string>())
  const assignmentOperationRef = useRef<{ key: string; id: string } | null>(null)
  const reviewOperationRef = useRef<{ key: string; id: string } | null>(null)
  const workflowOperationRef = useRef<{ key: string; id: string } | null>(null)
  const createOperationRef = useRef<{ key: string; id: string } | null>(null)

  const releaseStoredPhotoObjectUrls = () => {
    storedPhotoObjectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url))
    storedPhotoObjectUrlsRef.current.clear()
  }

  const closeEdit = () => {
    if (saving) return
    storedPhotoPreviewVersionRef.current += 1
    releaseStoredPhotoObjectUrls()
    setOpen(false)
  }

  useEffect(() => () => releaseStoredPhotoObjectUrls(), [])

  function storedPhotoUrl(file: UploadFile) {
    return String((file as any)?.response?.original_url || (file as any)?.url || '').trim()
  }

  function storedPhotoFiles(urls: string[], prefix: string) {
    return urls.map((url, index) => ({
      uid: `${prefix}-${index}`,
      name: `${prefix}-${index + 1}`,
      status: 'done' as const,
      response: { original_url: url },
    } as UploadFile))
  }

  async function hydrateStoredPhotoFiles(urls: string[], prefix: string, version: number, setFileList: (next: UploadFile[]) => void) {
    const resolved = await Promise.all(urls.map(async (originalUrl, index) => {
      try {
        const media = await loadMaintenanceFeedbackMedia(originalUrl)
        if (media.revoke) {
          if (storedPhotoPreviewVersionRef.current !== version) URL.revokeObjectURL(media.src)
          else storedPhotoObjectUrlsRef.current.add(media.src)
        }
        return {
          uid: `${prefix}-${index}`,
          name: `${prefix}-${index + 1}`,
          status: 'done' as const,
          url: media.src,
          thumbUrl: media.src,
          response: { original_url: originalUrl },
        } as UploadFile
      } catch {
        return {
          uid: `${prefix}-${index}`,
          name: `${prefix}-${index + 1}`,
          status: 'error' as const,
          response: { original_url: originalUrl },
        } as UploadFile
      }
    }))
    if (storedPhotoPreviewVersionRef.current === version) setFileList(resolved)
  }
  const [createPhotos, setCreatePhotos] = useState<string[]>([])
  const [userOptions, setUserOptions] = useState<{ value: string; label: string }[]>([])

  const screens = Grid.useBreakpoint()
  const isMobile = !screens.md
  const [captureEnabled, setCaptureEnabled] = useState(false)
  const maintenanceAbortRef = useRef<AbortController | null>(null)
  const skipInitialFilterEffectRef = useRef(true)
  const skipInitialPageEffectRef = useRef(true)
  const propsLoadingRef = useRef<Promise<void> | null>(null)
  const usersLoadingRef = useRef<Promise<void> | null>(null)

  useEffect(() => {
    try {
      const qs = typeof window !== 'undefined' ? window.location.search : ''
      const sp = new URLSearchParams(qs || '')
      setCaptureEnabled(String(sp.get('capture') || '') === '1')
    } catch {
      setCaptureEnabled(false)
    }
  }, [])

  async function ensurePropsLoaded() {
    if (props && props.length) return
    if (propsLoadingRef.current) return propsLoadingRef.current
    const p = (async () => {
      if (typeof window !== 'undefined') {
        try {
          const raw = localStorage.getItem('mz_cache_properties_v1')
          if (raw) {
            const j = JSON.parse(raw || '{}')
            const ts = Number(j?.ts || 0)
            const data = Array.isArray(j?.data) ? j.data : null
            if (data && data.length > 0 && Number.isFinite(ts) && Date.now() - ts < 12 * 60 * 60 * 1000) {
              setProps(data)
              return
            }
          }
        } catch {}
      }
      try {
        const ps = await getJSON<any[]>('/properties').catch(()=>[])
        const data = Array.isArray(ps) ? ps : []
        setProps(data)
        if (typeof window !== 'undefined') {
          try { localStorage.setItem('mz_cache_properties_v1', JSON.stringify({ ts: Date.now(), data })) } catch {}
        }
      } catch { setProps([]) }
    })().finally(() => { propsLoadingRef.current = null })
    propsLoadingRef.current = p
    return p
  }
  async function ensureUserOptionsLoaded() {
    if (userOptions && userOptions.length) return
    if (usersLoadingRef.current) return usersLoadingRef.current
    const p = (async () => {
      if (typeof window !== 'undefined') {
        try {
          const raw = localStorage.getItem('mz_cache_rbac_users_v2')
          if (raw) {
            const j = JSON.parse(raw || '{}')
            const ts = Number(j?.ts || 0)
            const data = Array.isArray(j?.data) ? j.data : null
            if (data && Number.isFinite(ts) && Date.now() - ts < 60 * 60 * 1000) {
              setUserOptions(data)
              return
            }
          }
        } catch {}
      }
      try {
        const users = await getJSON<any[]>('/rbac/users').catch(()=>[])
        const opts = (Array.isArray(users) ? users : []).map(u => ({ value: String(u?.id || ''), label: String(u?.display_name || u?.username || u?.name || '') })).filter(x => x.value && x.label)
        setUserOptions(opts)
        if (typeof window !== 'undefined') {
          try { localStorage.setItem('mz_cache_rbac_users_v2', JSON.stringify({ ts: Date.now(), data: opts })) } catch {}
        }
      } catch { setUserOptions([]) }
    })().finally(() => { usersLoadingRef.current = null })
    usersLoadingRef.current = p
    return p
  }
  function maintenanceQueryKey() {
    const dr0 = dateRange?.[0] ? dayjs(dateRange[0]).format('YYYY-MM-DD') : ''
    const dr1 = dateRange?.[1] ? dayjs(dateRange[1]).format('YYYY-MM-DD') : ''
    return JSON.stringify({
      filterCode: String(filterCode || ''),
      filterPropertyId: String(filterPropertyId || ''),
      filterWorkNo: String(filterWorkNo || ''),
      filterSubmitter: String(filterSubmitter || ''),
      filterPayMethod: String(filterPayMethod || ''),
      filterStatus: String(filterStatus || ''),
      dateRange: [dr0, dr1],
      pageSize: Number(pageSize || 10),
      page: 1,
    })
  }
  async function loadMaintenance(reset?: boolean, opts?: { silent?: boolean; page?: number }) {
    const showLoading = !opts?.silent || !list?.length
    if (showLoading) setLoading(true)
    const effectivePage = Number.isFinite(Number(opts?.page)) ? Number(opts?.page) : (reset ? 1 : page)
    try {
      try { maintenanceAbortRef.current?.abort() } catch {}
      const controller = new AbortController()
      maintenanceAbortRef.current = controller
      const params: Record<string, any> = {
        withTotal: '1',
        limit: String(pageSize),
        offset: String(Math.max(0, (effectivePage - 1) * pageSize)),
      }
      if (filterStatus) params.status = filterStatus
      if (filterPropertyId) params.property_id = filterPropertyId
      if (filterPayMethod) params.pay_method = filterPayMethod
      if (dateRange?.[0]) params.submitted_at_from = dayjs(dateRange[0]).startOf('day').toISOString()
      if (dateRange?.[1]) params.submitted_at_to = dayjs(dateRange[1]).endOf('day').toISOString()
      const q = [filterWorkNo, filterSubmitter, filterCode].map(s => String(s || '').trim()).filter(Boolean).join(' ')
      if (q) params.q = q
      const qs = new URLSearchParams(params as any).toString()
      const res = await fetch(`${API_BASE}/crud/property_maintenance?${qs}`, { cache: 'no-store', headers: authHeaders(), signal: controller.signal })
      if (res.status === 401) { window.location.href = '/login'; return }
      const data = await res.json().catch(()=>[])
      const items = Array.isArray(data) ? data : []
      const tot = Number(res.headers.get('x-total-count') || 0)
      if (Number.isFinite(tot) && tot >= 0) setTotal(tot)
      if (isMobile) {
        if (reset || effectivePage === 1) setList(items)
        else {
          setList(prev => {
            const seen = new Set(prev.map(x => String(x.id)))
            const next = [...prev]
            for (const it of items) {
              if (!seen.has(String(it.id))) next.push(it)
            }
            return next
          })
        }
      } else {
        setList(items)
      }
      if (typeof window !== 'undefined' && (reset || effectivePage === 1)) {
        try {
          sessionStorage.setItem('mz_cache_maintenance_records_v1', JSON.stringify({ ts: Date.now(), key: maintenanceQueryKey(), list: items, total: tot }))
        } catch {}
      }
    } catch {
      if (reset || effectivePage === 1 || !isMobile) setList([])
      setTotal(0)
    } finally {
      if (showLoading) setLoading(false)
    }
  }
  useEffect(() => {
    if (typeof window !== 'undefined') {
      try {
        const raw = sessionStorage.getItem('mz_cache_maintenance_records_v1')
        if (raw) {
          const j = JSON.parse(raw || '{}')
          const ts = Number(j?.ts || 0)
          const key = String(j?.key || '')
          const cachedList = Array.isArray(j?.list) ? j.list : null
          const cachedTotal = Number(j?.total || 0)
          if (cachedList && Number.isFinite(ts) && Date.now() - ts < 5 * 60 * 1000 && key === maintenanceQueryKey()) {
            setList(cachedList)
            if (Number.isFinite(cachedTotal) && cachedTotal >= 0) setTotal(cachedTotal)
          }
        }
      } catch {}
    }
    loadMaintenance(true, { silent: true, page: 1 })
    const t = setTimeout(() => { ensurePropsLoaded().catch(()=>{}) }, 1200)
    return () => { clearTimeout(t); try { maintenanceAbortRef.current?.abort() } catch {} }
  }, [])
  useEffect(() => {
    if (skipInitialFilterEffectRef.current) { skipInitialFilterEffectRef.current = false; return }
    const t = setTimeout(() => { setPage(1); loadMaintenance(true, { page: 1 }) }, 250)
    return () => clearTimeout(t)
  }, [filterCode, filterPropertyId, filterWorkNo, filterSubmitter, filterPayMethod, filterStatus, dateRange, pageSize])
  useEffect(() => {
    if (skipInitialPageEffectRef.current) { skipInitialPageEffectRef.current = false; return }
    loadMaintenance(page === 1, { page })
  }, [page])

  const rows = useMemo(() => {
    const byId: Record<string, any> = Object.fromEntries(props.map(p => [String(p.id), p]))
    return (list || []).map(r => {
      const p = byId[String(r.property_id || '')]
      const code = p?.code || (r as any)?.code || (r as any)?.property_code || r.property_id || ''
      return { ...r, code }
    })
  }, [list, props])

  const filtered = rows

  const propOptions = useMemo(() => sortProperties(props).map(p => ({ value: p.id, label: p.code || p.id })), [props])

  function openEdit(row: RepairOrder) {
    ensureUserOptionsLoaded().catch(()=>{})
    setEditing(row)
    form.setFieldsValue({
      property_id: row.property_id || '',
      status: normalizedMaintenanceWorkflowStatus(row.status),
      workflow_target_status: normalizedMaintenanceWorkflowStatus(row.status),
      workflow_reason: '',
      assignee_id: row.assignee_id || '',
      eta: row.eta ? dayjs(row.eta) : null,
      completed_at: row.completed_at ? dayjs(row.completed_at) : null,
      urgency: row.urgency || 'normal',
      details: summaryFromDetails(row.details),
      invoice_description_en: (row as any).invoice_description_en || '',
      repair_notes: (row as any).repair_notes || '',
      submitter_name: String((row as any)?.submitter_name || (row as any)?.worker_name || (row as any)?.created_by || ''),
      maintenance_amount: (row as any)?.maintenance_amount !== undefined ? Number((row as any)?.maintenance_amount || 0) : undefined,
      has_parts: (row as any)?.has_parts ?? undefined,
      parts_amount: (row as any)?.parts_amount !== undefined ? Number((row as any)?.parts_amount || 0) : undefined,
      maintenance_amount_includes_parts: (row as any)?.maintenance_amount_includes_parts ?? undefined,
      has_gst: (row as any)?.has_gst ?? undefined,
      maintenance_amount_includes_gst: (row as any)?.maintenance_amount_includes_gst ?? undefined,
      pay_method: (row as any)?.pay_method ?? undefined,
      pay_other_note: (row as any)?.pay_other_note ?? undefined,
    })
    storedPhotoPreviewVersionRef.current += 1
    const previewVersion = storedPhotoPreviewVersionRef.current
    releaseStoredPhotoObjectUrls()
    const urls = maintenanceAfterPhotoReferences(row)
    setRepairPhotos(urls)
    setFiles(storedPhotoFiles(urls, 'photo'))
    const preUrls: string[] = Array.isArray((row as any)?.photo_urls) ? (row as any)?.photo_urls! : []
    setPrePhotos(preUrls)
    setPreFiles(storedPhotoFiles(preUrls, 'pre'))
    void hydrateStoredPhotoFiles(urls, 'photo', previewVersion, setFiles)
    void hydrateStoredPhotoFiles(preUrls, 'pre', previewVersion, setPreFiles)
    setOpen(true)
  }

  async function save() {
    let workflowTransitionAttempted = false
    let recordFieldsSaved = false
    try {
      if (saving) return
      if (files.some((f) => f.status === 'uploading') || preFiles.some((f) => f.status === 'uploading')) {
        message.warning('照片上传中，请稍后再保存')
        return
      }
      setSaving(true)
      message.loading({ key: 'maint-record-save', content: '保存中…', duration: 0 })

      const v = await form.validateFields()
      if (!editing) throw new Error('维修记录不存在，请刷新后重试')
      const currentWorkflowStatus = normalizedMaintenanceWorkflowStatus(editing.status)
      const workflowAssignable = ['pending_assignment', 'assigned', 'in_progress'].includes(currentWorkflowStatus)
      const nextAssigneeId = String(v.assignee_id || '').trim()
      const nextScheduledDate = v.eta ? dayjs(v.eta).format('YYYY-MM-DD') : null
      const hasNewCompletionPhoto = internalMaintenanceHasNewCompletionPhoto(
        maintenanceAfterPhotoReferences(editing),
        repairPhotos,
      )
      const assignmentChanged = workflowAssignable && internalMaintenanceAssignmentChanged({
        currentAssigneeId: editing.assignee_id,
        currentScheduledDate: editing.eta,
        nextAssigneeId,
        nextScheduledDate,
      })
      if (assignmentChanged && !nextAssigneeId) {
        throw new Error('请选择维修人员后再保存')
      }
      if (!nextAssigneeId && nextScheduledDate) {
        throw new Error('请选择维修人员后再设置预计完成时间')
      }
      const requestedWorkflowStatus = canManageMaintenanceWorkflow
        ? normalizedMaintenanceWorkflowStatus(v.workflow_target_status || currentWorkflowStatus)
        : currentWorkflowStatus
      const pendingReviewActualRepairerRequired = canManageMaintenanceWorkflow
        && currentWorkflowStatus === 'pending_review'
        && !String(editing.assignee_id || '').trim()
        && requestedWorkflowStatus !== 'pending_assignment'
        && (requestedWorkflowStatus === 'closed'
          || shouldAutoApproveInternalMaintenanceSettlement({
            status: currentWorkflowStatus,
            payMethod: v.pay_method,
            canManageWorkflow: canManageMaintenanceWorkflow,
          }))
      if (pendingReviewActualRepairerRequired && !nextAssigneeId) {
        throw new Error('请选择实际维修人员后再审核关闭')
      }
      const canRecordActualRepairerWithCompletion = canManageMaintenanceWorkflow
        && assignmentChanged
        && ['pending_assignment', 'assigned', 'in_progress'].includes(currentWorkflowStatus)
        && (['pending_review', 'closed'].includes(requestedWorkflowStatus)
          || (requestedWorkflowStatus === currentWorkflowStatus && repairPhotos.length > 0 && hasNewCompletionPhoto))
      if (assignmentChanged && requestedWorkflowStatus !== currentWorkflowStatus && !canRecordActualRepairerWithCompletion) {
        throw new Error('分配维修人员和修改状态请分两次保存，避免覆盖流程记录')
      }
      const shouldAutoCompleteAfterPhoto = canManageMaintenanceWorkflow
        && requestedWorkflowStatus === currentWorkflowStatus
        && ['pending_assignment', 'assigned', 'in_progress'].includes(currentWorkflowStatus)
        && repairPhotos.length > 0
        && hasNewCompletionPhoto
      const targetWorkflowStatus = shouldAutoCompleteAfterPhoto ? 'pending_review' : requestedWorkflowStatus
      const recordActualRepairerWithCompletion = canRecordActualRepairerWithCompletion
        && ['pending_review', 'closed'].includes(targetWorkflowStatus)
      const workflowReason = String(v.workflow_reason || '').trim()
      const currentCompletionPhotoUrls = maintenanceAfterPhotoReferences(editing)
      const nextCompletionPhotoUrls = Array.from(new Set(repairPhotos.map((url) => String(url || '').trim()).filter(Boolean)))
      const currentCompletedDate = editing.completed_at ? dayjs(editing.completed_at).format('YYYY-MM-DD') : ''
      const nextCompletedDate = v.completed_at ? dayjs(v.completed_at).format('YYYY-MM-DD') : ''
      const completionDateChanged = !!nextCompletedDate && nextCompletedDate !== currentCompletedDate
      const completionPhotosChanged = JSON.stringify(nextCompletionPhotoUrls) !== JSON.stringify(currentCompletionPhotoUrls)
      const currentCompletionNote = String(editing.repair_notes || '').trim() || null
      const nextCompletionNote = String(v.repair_notes || '').trim() || null
      const completionNoteChanged = nextCompletionNote !== currentCompletionNote
      const completionAssigneeChanged = nextAssigneeId !== String(editing.assignee_id || '').trim()
      const closedCompletionFieldsChanged = canManageMaintenanceWorkflow
        && currentWorkflowStatus === 'closed'
        && (completionDateChanged || completionPhotosChanged || completionNoteChanged || completionAssigneeChanged)
      const automaticCompletionCorrectionReason = '管理员直接修正已关闭维修完成信息'
      const correctionTouchesOrdinaryFields = form.isFieldsTouched([
        'property_id', 'submitter_name', 'urgency', 'details', 'invoice_description_en',
        'maintenance_amount', 'has_parts', 'parts_amount', 'maintenance_amount_includes_parts',
        'has_gst', 'maintenance_amount_includes_gst', 'pay_method', 'pay_other_note',
      ]) || JSON.stringify(prePhotos) !== JSON.stringify((editing.photo_urls || []).map((url) => String(url || '').trim()).filter(Boolean))
      if (closedCompletionFieldsChanged && requestedWorkflowStatus !== currentWorkflowStatus) {
        throw new Error('修正完成信息不能与重新打开或其他状态变更同时保存')
      }
      if (closedCompletionFieldsChanged && !nextAssigneeId) {
        throw new Error('请填写实际维修人员后再保存完成信息')
      }
      if (closedCompletionFieldsChanged && correctionTouchesOrdinaryFields) {
        throw new Error('修正完成信息请单独保存；金额、扣款方式和报修资料请另行保存')
      }
      if (closedCompletionFieldsChanged && nextCompletionPhotoUrls.length < 1) {
        throw new Error('已关闭维修必须至少保留一张维修后照片')
      }
      if (targetWorkflowStatus === 'cancelled' && targetWorkflowStatus !== currentWorkflowStatus && !workflowReason) {
        throw new Error('取消维修记录必须填写原因')
      }
      if (((targetWorkflowStatus === 'pending_assignment' && currentWorkflowStatus === 'pending_review')
        || (targetWorkflowStatus === 'in_progress' && currentWorkflowStatus === 'closed')) && !workflowReason) {
        throw new Error(currentWorkflowStatus === 'closed' ? '重新打开维修必须填写原因' : '退回维修必须填写原因')
      }
      if (['pending_review', 'closed'].includes(targetWorkflowStatus)
        && ['pending_assignment', 'assigned', 'in_progress'].includes(currentWorkflowStatus)
        && repairPhotos.length < 1) {
        throw new Error('完成维修前必须至少上传一张维修后照片')
      }
      const payload: any = {
        property_id: v.property_id || undefined,
        submitter_name: v.submitter_name || undefined,
        urgency: v.urgency || undefined,
      }
      if (Object.prototype.hasOwnProperty.call(v, 'details')) {
        const detailsText = String(v.details || '').trim()
        if (detailsText) {
          try {
            payload.details = JSON.stringify([{ content: detailsText }])
          } catch {
            payload.details = detailsText
          }
        } else {
          payload.details = null
        }
      }
      if (Object.prototype.hasOwnProperty.call(v, 'invoice_description_en')) {
        const invoiceDescriptionEn = String(v.invoice_description_en || '').trim()
        payload.invoice_description_en = invoiceDescriptionEn || null
      }
      const recordCanBeEdited = currentWorkflowStatus !== 'cancelled'
      const completionResultCanBeEditedViaCrud = recordCanBeEdited && currentWorkflowStatus !== 'closed'
      if (completionResultCanBeEditedViaCrud) {
        if (repairPhotos.length) payload.repair_photo_urls = repairPhotos
        if (Object.prototype.hasOwnProperty.call(v, 'repair_notes')) {
          const repairNotes = String(v.repair_notes || '').trim()
          payload.repair_notes = repairNotes || null
        }
      }
      if (prePhotos.length) payload.photo_urls = prePhotos
      if (recordCanBeEdited) {
        if (v.maintenance_amount !== undefined) payload.maintenance_amount = Number(v.maintenance_amount || 0)
        if (v.has_parts === true) {
          payload.has_parts = true
          if (v.parts_amount !== undefined) payload.parts_amount = Number(v.parts_amount || 0)
          if (v.maintenance_amount_includes_parts !== undefined) payload.maintenance_amount_includes_parts = !!v.maintenance_amount_includes_parts
        } else if (v.has_parts === false) {
          payload.has_parts = false
          payload.parts_amount = null
          payload.maintenance_amount_includes_parts = null
        }
        if (v.has_gst === true) {
          payload.has_gst = true
          if (v.maintenance_amount_includes_gst !== undefined) payload.maintenance_amount_includes_gst = !!v.maintenance_amount_includes_gst
        } else if (v.has_gst === false) {
          payload.has_gst = false
          payload.maintenance_amount_includes_gst = null
        }
        if (v.pay_method) payload.pay_method = String(v.pay_method)
        if (String(v.pay_method || '') === 'other_pay' && v.pay_other_note) payload.pay_other_note = String(v.pay_other_note)
        if (String(v.pay_method || '') !== 'other_pay') payload.pay_other_note = undefined
      }

      const recordPatch = Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined))
      let nextEditing: RepairOrder = editing
      let automaticallyApproved = false
      let completionCorrectionPerformed = false
      if (assignmentChanged && !recordActualRepairerWithCompletion) {
        message.loading({ key: 'maint-record-save', content: '分配维修人员中…', duration: 0 })
        const operationKey = JSON.stringify({
          id: editing.id,
          assignee_id: nextAssigneeId,
          scheduled_date: nextScheduledDate,
          record_patch: recordPatch,
        })
        const operationId = assignmentOperationRef.current?.key === operationKey
          ? assignmentOperationRef.current.id
          : newMaintenanceWorkflowOperationId()
        assignmentOperationRef.current = { key: operationKey, id: operationId }
        const assigned = await assignInternalMaintenance({
          recordId: editing.id,
          assigneeId: nextAssigneeId,
          scheduledDate: nextScheduledDate,
          recordPatch,
          operationId,
        })
        nextEditing = {
          ...nextEditing,
          ...recordPatch,
          status: String(assigned?.status || 'assigned') as RepairOrder['status'],
          assignee_id: nextAssigneeId,
          eta: nextScheduledDate || undefined,
        }
        assignmentOperationRef.current = null
      }
      if (closedCompletionFieldsChanged) {
        message.loading({ key: 'maint-record-save', content: '保存完成信息并同步费用中…', duration: 0 })
        const operationKey = JSON.stringify({
          id: editing.id,
          action: 'correct_completion',
          completed_at: completionDateChanged ? nextCompletedDate : undefined,
          assignee_id: completionAssigneeChanged ? nextAssigneeId : undefined,
          completion_photo_urls: completionPhotosChanged ? nextCompletionPhotoUrls : undefined,
          completion_note: completionNoteChanged ? nextCompletionNote : undefined,
          reason: automaticCompletionCorrectionReason,
        })
        const operationId = workflowOperationRef.current?.key === operationKey
          ? workflowOperationRef.current.id
          : newMaintenanceWorkflowOperationId()
        workflowOperationRef.current = { key: operationKey, id: operationId }
        workflowTransitionAttempted = true
        await correctInternalMaintenanceCompletion({
          recordId: editing.id,
          completedAt: completionDateChanged ? nextCompletedDate : undefined,
          assigneeId: completionAssigneeChanged ? nextAssigneeId : undefined,
          completionPhotoUrls: completionPhotosChanged ? nextCompletionPhotoUrls : undefined,
          completionNote: completionNoteChanged ? nextCompletionNote : undefined,
          reason: automaticCompletionCorrectionReason,
          operationId,
        })
        workflowOperationRef.current = null
        nextEditing = {
          ...nextEditing,
          ...(completionDateChanged ? { completed_at: nextCompletedDate } : {}),
          ...(completionAssigneeChanged ? { assignee_id: nextAssigneeId } : {}),
          ...(completionPhotosChanged ? { completion_photo_urls: nextCompletionPhotoUrls } : {}),
          ...(completionNoteChanged ? { repair_notes: nextCompletionNote || undefined } : {}),
        }
        completionCorrectionPerformed = true
      }
      if (!closedCompletionFieldsChanged && shouldUpdateInternalMaintenanceRecordViaCrud({ assignmentChanged, recordActualRepairerWithCompletion }) && Object.keys(recordPatch).length) {
        const updated = await apiUpdate<RepairOrder>('property_maintenance', editing.id, recordPatch)
        recordFieldsSaved = true
        if (updated?.id) nextEditing = { ...nextEditing, ...updated }
      }

      let workflowStatusAfter = assignmentChanged && !recordActualRepairerWithCompletion ? 'assigned' : currentWorkflowStatus
      const runWorkflowAction = async (action: 'manager_start' | 'manager_complete' | 'review' | 'reopen' | 'cancel', input: Record<string, any> = {}) => {
        const operationKey = JSON.stringify({ id: editing.id, action, ...input })
        const operationId = workflowOperationRef.current?.key === operationKey
          ? workflowOperationRef.current.id
          : newMaintenanceWorkflowOperationId()
        workflowOperationRef.current = { key: operationKey, id: operationId }
        workflowTransitionAttempted = true
        const response = await manageInternalMaintenanceWorkflow({ recordId: editing.id, action, operationId, ...input })
        workflowOperationRef.current = null
        workflowStatusAfter = normalizedMaintenanceWorkflowStatus(response?.status)
        nextEditing = { ...nextEditing, status: workflowStatusAfter as RepairOrder['status'] }
        return response
      }

      if (!(assignmentChanged && !recordActualRepairerWithCompletion) && targetWorkflowStatus !== currentWorkflowStatus) {
        if (targetWorkflowStatus === 'pending_assignment' && currentWorkflowStatus === 'pending_review') {
          message.loading({ key: 'maint-record-save', content: '退回待分派中…', duration: 0 })
          await runWorkflowAction('review', { decision: 'rejected', reason: workflowReason })
          nextEditing = { ...nextEditing, assignee_id: undefined, eta: undefined, completed_at: undefined }
        } else if (targetWorkflowStatus === 'in_progress') {
          if (['pending_assignment', 'assigned'].includes(currentWorkflowStatus)) {
            message.loading({ key: 'maint-record-save', content: '更新为维修中…', duration: 0 })
            await runWorkflowAction('manager_start')
          } else if (currentWorkflowStatus === 'closed') {
            message.loading({ key: 'maint-record-save', content: '重新打开维修中…', duration: 0 })
            await runWorkflowAction('reopen', { reason: workflowReason })
          }
        } else if (targetWorkflowStatus === 'pending_review' && ['pending_assignment', 'assigned', 'in_progress'].includes(currentWorkflowStatus)) {
          message.loading({ key: 'maint-record-save', content: '提交维修后照片中…', duration: 0 })
          const completedAt = v.completed_at ? dayjs(v.completed_at).format('YYYY-MM-DD') : undefined
          await runWorkflowAction('manager_complete', {
            assigneeId: recordActualRepairerWithCompletion ? nextAssigneeId : undefined,
            completionPhotoUrls: repairPhotos,
            completionNote: String(v.repair_notes || '').trim() || null,
            completedAt,
          })
          nextEditing = {
            ...nextEditing,
            ...(recordActualRepairerWithCompletion ? { assignee_id: nextAssigneeId } : {}),
            completed_at: completedAt || new Date().toISOString(),
            completion_photo_urls: repairPhotos,
          }
        } else if (targetWorkflowStatus === 'cancelled') {
          message.loading({ key: 'maint-record-save', content: '取消维修记录中…', duration: 0 })
          await runWorkflowAction('cancel', { reason: workflowReason })
        }
      }

      const shouldExplicitlyClose = !(assignmentChanged && !recordActualRepairerWithCompletion)
        && targetWorkflowStatus === 'closed'
        && currentWorkflowStatus !== 'closed'
      if (shouldExplicitlyClose && ['pending_assignment', 'assigned', 'in_progress'].includes(currentWorkflowStatus)) {
        message.loading({ key: 'maint-record-save', content: '提交维修后照片中…', duration: 0 })
        const completedAt = v.completed_at ? dayjs(v.completed_at).format('YYYY-MM-DD') : undefined
        await runWorkflowAction('manager_complete', {
          assigneeId: recordActualRepairerWithCompletion ? nextAssigneeId : undefined,
          completionPhotoUrls: repairPhotos,
          completionNote: String(v.repair_notes || '').trim() || null,
          completedAt,
        })
        nextEditing = {
          ...nextEditing,
          ...(recordActualRepairerWithCompletion ? { assignee_id: nextAssigneeId } : {}),
          completed_at: completedAt || new Date().toISOString(),
          completion_photo_urls: repairPhotos,
        }
      }

      const automaticReview = shouldAutoApproveInternalMaintenanceSettlement({
        status: workflowStatusAfter,
        payMethod: v.pay_method,
        canManageWorkflow: canManageMaintenanceWorkflow,
      })
      if (!(assignmentChanged && !recordActualRepairerWithCompletion) && workflowStatusAfter === 'pending_review' && (shouldExplicitlyClose || automaticReview)) {
        message.loading({ key: 'maint-record-save', content: shouldExplicitlyClose ? '审核关闭中…' : '保存费用并审核关闭中…', duration: 0 })
        const reviewCompletedAt = v.completed_at ? dayjs(v.completed_at).format('YYYY-MM-DD') : undefined
        const operationKey = JSON.stringify({
          id: editing.id,
          status: workflowStatusAfter,
          pay_method: String(v.pay_method || '').trim(),
          explicit_close: shouldExplicitlyClose,
          assignee_id: pendingReviewActualRepairerRequired ? nextAssigneeId : undefined,
          completed_at: reviewCompletedAt,
        })
        const operationId = reviewOperationRef.current?.key === operationKey
          ? reviewOperationRef.current.id
          : newMaintenanceWorkflowOperationId()
        reviewOperationRef.current = { key: operationKey, id: operationId }
        workflowTransitionAttempted = true
        const reviewActualRepairerId = pendingReviewActualRepairerRequired ? nextAssigneeId : undefined
        const approved = await approveInternalMaintenance({
          recordId: editing.id,
          assigneeId: reviewActualRepairerId,
          completedAt: reviewCompletedAt,
          operationId,
        })
        reviewOperationRef.current = null
        nextEditing = {
          ...nextEditing,
          ...(reviewActualRepairerId ? { assignee_id: reviewActualRepairerId } : {}),
          ...(reviewCompletedAt ? { completed_at: reviewCompletedAt } : {}),
          status: String(approved?.status || 'closed') as RepairOrder['status'],
        }
        automaticallyApproved = true
      }
      setList((prev) => prev.map((x) => (String(x.id) === String(editing.id) ? { ...x, ...nextEditing } : x)))
      message.success({
        key: 'maint-record-save',
        content: recordActualRepairerWithCompletion
          ? automaticallyApproved
            ? '已记录实际维修人员并审核关闭'
            : '已记录实际维修人员并进入待审核'
          : completionCorrectionPerformed
            ? completionDateChanged
              ? '完成信息已保存，费用归属已同步'
              : '完成信息已保存，并已留下修正记录'
            : assignmentChanged
            ? '已保存并分配维修人员'
            : currentWorkflowStatus === 'pending_review' && workflowStatusAfter === 'pending_assignment'
              ? '已退回待分派'
            : automaticallyApproved
              ? '已保存费用并审核关闭'
              : targetWorkflowStatus === 'pending_review' && workflowStatusAfter === 'pending_review'
                ? '已保存并进入待审核'
                : '已保存',
      })
      setOpen(false)
      setEditing(null)
      loadMaintenance(page === 1, { silent: true, page })
    } catch (e: any) {
      const detail = e?.message || '保存失败'
      if (workflowTransitionAttempted) void loadMaintenance(page === 1, { silent: true, page })
      message.error({ key: 'maint-record-save', content: recordFieldsSaved && workflowTransitionAttempted ? `记录字段已保存，但状态更新失败，请重试：${detail}` : detail })
    } finally {
      setSaving(false)
    }
  }

  const workflowTargetStatusWatch = Form.useWatch('workflow_target_status', form)
  const hasPartsWatch = Form.useWatch('has_parts', form)
  const maintenanceAmountWatch = Form.useWatch('maintenance_amount', form)
  const partsAmountWatch = Form.useWatch('parts_amount', form)
  const includesPartsWatch = Form.useWatch('maintenance_amount_includes_parts', form)
  const hasGstWatch = Form.useWatch('has_gst', form)
  const includesGstWatch = Form.useWatch('maintenance_amount_includes_gst', form)
  const payMethodWatch = Form.useWatch('pay_method', form)

  const feeTotal = useMemo(() => calcTotalAmount({
    maintenance_amount: maintenanceAmountWatch,
    has_parts: hasPartsWatch,
    parts_amount: partsAmountWatch,
    maintenance_amount_includes_parts: includesPartsWatch,
    has_gst: hasGstWatch,
    maintenance_amount_includes_gst: includesGstWatch,
  }), [hasGstWatch, hasPartsWatch, includesGstWatch, includesPartsWatch, maintenanceAmountWatch, partsAmountWatch])

  const editCurrentWorkflowStatus = normalizedMaintenanceWorkflowStatus(editing?.status)
  const editTargetWorkflowStatus = canManageMaintenanceWorkflow
    ? normalizedMaintenanceWorkflowStatus(workflowTargetStatusWatch || editCurrentWorkflowStatus)
    : editCurrentWorkflowStatus
  const closedCompletionFieldsReadOnly = editCurrentWorkflowStatus === 'closed' && !canManageMaintenanceWorkflow
  const drawerAction = maintenanceDrawerActionCopy({
    currentStatus: editCurrentWorkflowStatus,
    targetStatus: editTargetWorkflowStatus,
    hasCompletionPhoto: repairPhotos.length > 0,
    canManageWorkflow: canManageMaintenanceWorkflow,
  })
  const editingPropertyCode = String((editing as any)?.code
    || (editing as any)?.property_code
    || props.find((property) => String(property.id) === String(editing?.property_id || ''))?.code
    || editing?.property_id
    || '-')
  const workflowReasonRequired = canManageMaintenanceWorkflow
    && ((editTargetWorkflowStatus === 'cancelled' && editTargetWorkflowStatus !== editCurrentWorkflowStatus)
      || (editTargetWorkflowStatus === 'pending_assignment' && editCurrentWorkflowStatus === 'pending_review')
      || (editTargetWorkflowStatus === 'in_progress' && editCurrentWorkflowStatus === 'closed'))
  const completionPhotoRequired = canManageMaintenanceWorkflow
    && ['pending_review', 'closed'].includes(editTargetWorkflowStatus)
    && ['pending_assignment', 'assigned', 'in_progress'].includes(editCurrentWorkflowStatus)
  const recordingCompletion = canManageMaintenanceWorkflow
    && ['pending_review', 'closed'].includes(editTargetWorkflowStatus)
    && ['pending_assignment', 'assigned', 'in_progress'].includes(editCurrentWorkflowStatus)
  const pendingReviewActualRepairerRequired = canManageMaintenanceWorkflow
    && editCurrentWorkflowStatus === 'pending_review'
    && !String(editing?.assignee_id || '').trim()
    && editTargetWorkflowStatus !== 'pending_assignment'
    && (editTargetWorkflowStatus === 'closed'
      || shouldAutoApproveInternalMaintenanceSettlement({
        status: editCurrentWorkflowStatus,
        payMethod: payMethodWatch,
        canManageWorkflow: canManageMaintenanceWorkflow,
      }))
  const recordingActualRepairer = recordingCompletion || pendingReviewActualRepairerRequired
    || (canManageMaintenanceWorkflow && editCurrentWorkflowStatus === 'closed')

  const statusOptions = [
    { value: 'pending_assignment', label: '待分派' },
    { value: 'assigned', label: '已分配' },
    { value: 'in_progress', label: '维修中' },
    { value: 'pending_review', label: '待审核' },
    { value: 'closed', label: '已关闭' },
    { value: 'cancelled', label: '已取消' },
  ]
  function statusLabel(s?: string) {
    const v = String(s || '')
    if (v === 'pending_assignment' || v === 'pending') return '待分派'
    if (v === 'assigned') return '已分配'
    if (v === 'in_progress' || v === 'repairing' || v === 'started') return '维修中'
    if (v === 'pending_review' || v === 'review_pending' || v === 'awaiting_review' || v === 'completed' || v === 'done' || v === 'ready') return '待审核'
    if (v === 'closed') return '已关闭'
    if (v === 'canceled' || v === 'cancelled') return '已取消'
    return v || '-'
  }
  function statusTag(s?: string) {
    const v = String(s || '')
    const label = statusLabel(v)
    if (v === 'pending_assignment' || v === 'pending') return <Tag color="default">{label}</Tag>
    if (v === 'assigned') return <Tag color="blue">{label}</Tag>
    if (v === 'in_progress' || v === 'repairing' || v === 'started') return <Tag color="orange">{label}</Tag>
    if (v === 'pending_review' || v === 'review_pending' || v === 'awaiting_review' || v === 'completed' || v === 'done' || v === 'ready') return <Tag color="gold">{label}</Tag>
    if (v === 'completed' || v === 'closed') return <Tag color="purple">{label}</Tag>
    if (v === 'canceled' || v === 'cancelled') return <Tag color="red">{label}</Tag>
    return <Tag>{label}</Tag>
  }

  function urgencyLabel(u?: string) {
    const s = String(u || '')
    if (s === 'urgent') return '紧急'
    if (s === 'normal') return '普通'
    if (s === 'not_urgent') return '不紧急'
    if (s === 'high') return '高'
    if (s === 'medium') return '中'
    if (s === 'low') return '低'
    return '-'
  }
  function urgencyTag(u?: string) {
    const label = urgencyLabel(u)
    if (String(u || '') === 'urgent') {
      return (
        <span style={{ display:'inline-block', padding:'2px 8px', border:'1px solid #ff4d4f', background:'#fff1f0', borderRadius:12, color:'#cf1322', fontSize:12 }}>
          {label}
        </span>
      )
    }
    return <span>{label}</span>
  }
  function fmtAmount(a?: any) {
    if (a === undefined || a === null || a === '') return '-'
    const n = Number(a)
    if (isNaN(n)) return String(a)
    try {
      return new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(n).replace('A$', '$')
    } catch {
      return `$${n.toFixed(2)}`
    }
  }
  function calcTotalAmount(row?: any) {
    const hasBase = row?.maintenance_amount !== undefined && row?.maintenance_amount !== null && row?.maintenance_amount !== ''
    const hasPartsAmt = row?.parts_amount !== undefined && row?.parts_amount !== null && row?.parts_amount !== ''
    if (!hasBase && !hasPartsAmt) return null

    const base = hasBase ? Number(row?.maintenance_amount || 0) : 0
    const parts = hasPartsAmt ? Number(row?.parts_amount || 0) : 0
    const hasParts = row?.has_parts === true
    const hasGst = row?.has_gst === true
    const includesParts = row?.maintenance_amount_includes_parts === true
    const includesGst = row?.maintenance_amount_includes_gst === true

    let total = Number.isFinite(base) ? base : 0
    if (hasParts && !includesParts) total += (Number.isFinite(parts) ? parts : 0)

    let gstExtra = 0
    if (hasGst && !includesGst) {
      gstExtra = total * 0.1
      total += gstExtra
    }

    return {
      base: Number.isFinite(base) ? base : 0,
      parts: Number.isFinite(parts) ? parts : 0,
      gstExtra: Number.isFinite(gstExtra) ? gstExtra : 0,
      total: Number.isFinite(total) ? total : 0,
      hasParts,
      hasGst,
      includesParts,
      includesGst,
    }
  }
  function payMethodLabel(v?: string | null) {
    const s = String(v || '')
    if (!s) return '-'
    if (s === 'rent_deduction') return '租金扣除'
    if (s === 'tenant_pay') return '房客支付'
    if (s === 'company_pay') return '公司承担'
    if (s === 'landlord_pay') return '房东支付'
    if (s === 'other_pay') return '其他人支付'
    return s
  }
function issueAreaLabel(r?: any): string {
    const direct = String(r?.area || r?.category || '').trim()
    if (direct) return direct
    const known = new Set(['入户走廊','客厅','厨房','卧室','阳台','浴室','其他'])
    const s = String(r?.details || '')
    if (!s) return ''
    try {
      const arr = JSON.parse(s)
      if (!Array.isArray(arr) || !arr.length) return ''
      const norm = (v: any) => String(v || '').trim()
      const pickItem = (x: any) => norm(x?.item ?? x?.label ?? x?.key ?? x?.name)
      const pickContent = (x: any) => norm(x?.content ?? x?.value ?? x?.text)
      for (const x of arr) {
        const item = pickItem(x)
        const content = pickContent(x)
        const itemLower = item.toLowerCase()
        if (known.has(content) && (item.includes('区域') || item.includes('位置') || itemLower.includes('category') || itemLower.includes('area'))) return content
      }
      for (const x of arr) {
        const content = pickContent(x)
        if (known.has(content)) return content
      }
    } catch {}
    return ''
  }
  function summaryFromDetails(details?: string) {
    const s = String(details || '')
    if (!s) return ''
    try {
      const arr = JSON.parse(s)
      if (Array.isArray(arr) && arr[0] && typeof arr[0].content === 'string') return arr[0].content
    } catch {}
    return s
  }
  function openView(r: RepairOrder) { setViewRow(r); setViewOpen(true) }
  async function shareLink(r: RepairOrder) {
    try {
      const res = await fetch(`${API_BASE}/maintenance/share-link/${r.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() } })
      const j = await res.json().catch(()=>null)
      if (!res.ok) { message.error(j?.message || '生成分享链接失败'); return }
      const origin = typeof window !== 'undefined' ? window.location.origin : ''
      const link = `${origin}/public/maintenance-share/${String(j?.token || '')}`
      try { await navigator.clipboard?.writeText(link) } catch {}
      message.success('已复制分享链接')
    } catch (e: any) {
      message.error('生成分享链接失败')
    }
  }
  const closePdfPreview = () => {
    setPdfPreview((prev) => {
      try { if (prev.url) URL.revokeObjectURL(prev.url) } catch {}
      return { open: false, url: '', title: '', showChinese: false, blob: null, row: null, loading: false }
    })
  }
  async function fetchPdfBlob(r: RepairOrder, showChinese: boolean) {
    if (!r?.id) return
    const out = await runWorkRecordPdfJob({
      createPath: `/maintenance/pdf-jobs/${String(r.id)}`,
      statusPath: (jobId) => `/maintenance/pdf-jobs/${encodeURIComponent(jobId)}`,
      downloadPath: (jobId) => `/maintenance/pdf-jobs/${encodeURIComponent(jobId)}/download`,
      showChinese,
      onUpdate: (patch) => setPdfJobUi(prev => ({ ...prev, ...patch })),
    })
    return out.blob
  }

  async function openExportPdf(r: RepairOrder) {
    if (!r?.id) return
    setDownloadingId(String(r.id))
    try {
      setPdfJobUi({ open: true, stage: '创建任务', detail: '正在准备导出 PDF...', progress: 3, timeout: false })
      const blob = await fetchPdfBlob(r, false)
      if (!blob) return
      const url = URL.createObjectURL(blob)
      const workNo = String((r as any)?.work_no || (r as any)?.id || '').trim()
      const title = `Maintenance${workNo ? ` - ${workNo}` : ''}`
      setPdfPreview((prev) => {
        try { if (prev.url) URL.revokeObjectURL(prev.url) } catch {}
        return { open: true, url, title, showChinese: false, blob, row: r, loading: false }
      })
    } catch (e: any) {
      message.error(e?.message || '预览失败')
    } finally {
      setPdfJobUi(prev => ({ ...prev, open: false }))
      setDownloadingId(null)
    }
  }
  async function exportFromPreview() {
    const r = pdfPreview.row
    if (!r?.id) return
    setPdfPreview(p => ({ ...p, loading: true }))
    try {
      setPdfJobUi({ open: true, stage: '创建任务', detail: '正在准备导出 PDF...', progress: 3, timeout: false })
      const blob = pdfPreview.showChinese ? await fetchPdfBlob(r, true) : pdfPreview.blob
      if (!blob) return
      const workNo = String((r as any)?.work_no || (r as any)?.id || '').trim()
      const suffix = pdfPreview.showChinese ? '-cn' : ''
      const filename = `maintenance-${(workNo || String(r.id)).replace(/[^a-zA-Z0-9._-]+/g, '-')}${suffix}.pdf`
      downloadNamedBlob(blob, filename)
    } catch (e: any) {
      message.error(e?.message || '导出失败')
    } finally {
      setPdfJobUi(prev => ({ ...prev, open: false }))
      setPdfPreview(p => ({ ...p, loading: false }))
    }
  }
  function remove(record: RepairOrder) {
    const id = String(record?.id || '').trim()
    if (!id) return
    if (isCancelledMaintenanceStatus(record.status)) {
      message.info('已取消的维修记录无需删除')
      return
    }
    Modal.confirm({
      title: '确认删除维修记录？',
      content: '删除后将从维修记录和任务中心移除；历史审计保留，关联照片不再可访问。',
      okText: '确认删除',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await deleteInternalMaintenanceFeedback(id)
          message.success('已删除')
          setPage(1)
          await loadMaintenance(true)
        } catch (e: any) {
          message.error(e?.message || '删除失败')
          throw e
        }
      },
    })
  }
  function maintenanceRowActions(record: RepairOrder) {
    return [
      { key: 'detail', label: '详情', onClick: () => openView(record) },
      { key: 'share', label: '分享', onClick: () => shareLink(record) },
      { key: 'export', label: '导出PDF', onClick: () => openExportPdf(record), loading: downloadingId === String(record.id), hidden: !canDownload },
      { key: 'edit', label: '编辑', onClick: () => openEdit(record), hidden: !hasPerm('property_maintenance.write') },
      {
        key: 'delete',
        label: '删除',
        danger: true,
        onClick: () => remove(record),
        hidden: !canDeleteMaintenance || isCancelledMaintenanceStatus(record.status),
      },
    ]
  }
  function maintenanceTableRowActions(record: RepairOrder) {
    const actions = maintenanceRowActions(record)
    return (
      <Space direction="vertical" size={8}>
        <TableRowActions actions={actions.filter((action) => ['detail', 'share', 'export'].includes(action.key))} />
        <TableRowActions actions={actions.filter((action) => ['edit', 'delete'].includes(action.key))} />
      </Space>
    )
  }
  async function fetchAllForExport() {
    const all: any[] = []
    const limit = 500
    let offset = 0
    for (;;) {
      const params: Record<string, any> = { limit: String(limit), offset: String(offset) }
      if (filterStatus) params.status = filterStatus
      if (filterPropertyId) params.property_id = filterPropertyId
      if (filterPayMethod) params.pay_method = filterPayMethod
      if (dateRange?.[0]) params.submitted_at_from = dayjs(dateRange[0]).startOf('day').toISOString()
      if (dateRange?.[1]) params.submitted_at_to = dayjs(dateRange[1]).endOf('day').toISOString()
      const q = [filterWorkNo, filterSubmitter, filterCode].map(s => String(s || '').trim()).filter(Boolean).join(' ')
      if (q) params.q = q
      const qs = new URLSearchParams(params as any).toString()
      const res = await fetch(`${API_BASE}/crud/property_maintenance?${qs}`, { cache: 'no-store', headers: authHeaders() })
      if (res.status === 401) { window.location.href = '/login'; return [] }
      const data = await res.json().catch(()=>[])
      const items = Array.isArray(data) ? data : []
      if (!items.length) break
      all.push(...items)
      offset += items.length
      if (items.length < limit) break
      if (all.length > 20000) break
    }
    return all
  }
  function downloadBlob(filename: string, blob: Blob) {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }
  async function exportExcel() {
    const key = 'export'
    message.loading({ content: '正在导出...', key, duration: 0 })
    try {
      const data = await fetchAllForExport()
      const byId: Record<string, any> = Object.fromEntries(props.map(p => [String(p.id), p]))
      const header = ['房号','工单号','状态','紧急程度','问题区域','问题摘要','提交人','提交时间','维修金额(AUD)','是否有配件费','配件费(AUD)','扣款方式','其他人备注']
      const rows = data.map(r => {
        const p = byId[String(r.property_id || '')]
        const code = p?.code || r.property_id || ''
        const summary = summaryFromDetails((r as any).details)
        return [
          code,
          String((r as any).work_no || ''),
          statusLabel((r as any).status),
          urgencyLabel((r as any).urgency),
          issueAreaLabel(r),
          String(summary || ''),
          String((r as any).submitter_name || (r as any).worker_name || (r as any).created_by || ''),
          (r as any).submitted_at ? dayjs((r as any).submitted_at).format('YYYY-MM-DD') : '',
          String(calcTotalAmount(r)?.total ?? ''),
          (r as any).has_parts === true ? '是' : (r as any).has_parts === false ? '否' : '',
          String((r as any).parts_amount ?? ''),
          payMethodLabel((r as any).pay_method),
          String((r as any).pay_other_note || ''),
        ]
      })
      const csv = [header, ...rows].map(line => line.map(v => {
        const s = String(v ?? '')
        const escaped = s.replace(/"/g, '""')
        return `"${escaped}"`
      }).join(',')).join('\n')
      const bom = '\uFEFF'
      downloadBlob(`维修记录导出-${dayjs().format('YYYYMMDD-HHmm')}.csv`, new Blob([bom + csv], { type: 'text/csv;charset=utf-8' }))
      message.success({ content: '已导出（Excel 可直接打开 CSV）', key })
    } catch (e: any) {
      message.error({ content: e?.message || '导出失败', key })
    }
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Card title={
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>维修记录</span>
          <Button type="primary" onClick={() => setCreateOpen(true)} style={{ width: isMobile ? '100%' : undefined }}>新增维修记录</Button>
        </div>
      }>
        <Space style={{ marginBottom: 12, width: '100%' }} wrap>
          <Select placeholder="房号搜索" allowClear options={propOptions} value={filterPropertyId} onChange={v=>setFilterPropertyId(v)} style={{ width: isMobile ? '100%' : 220 }} showSearch optionFilterProp="label" filterOption={(input, option) => String(option?.label || '').toLowerCase().includes(input.toLowerCase())} />
          <Input placeholder="按工单号搜索" value={filterWorkNo} onChange={e=>setFilterWorkNo(e.target.value)} style={{ width: isMobile ? '100%' : 180 }} />
          <Input placeholder="按提交人搜索" value={filterSubmitter} onChange={e=>setFilterSubmitter(e.target.value)} style={{ width: isMobile ? '100%' : 180 }} />
          <Select
            placeholder="扣款方式"
            allowClear
            value={filterPayMethod}
            onChange={v => setFilterPayMethod(v)}
            style={{ width: isMobile ? '100%' : 180 }}
            options={[
              { value: 'rent_deduction', label: payMethodLabel('rent_deduction') },
              { value: 'tenant_pay', label: payMethodLabel('tenant_pay') },
              { value: 'company_pay', label: payMethodLabel('company_pay') },
              { value: 'landlord_pay', label: payMethodLabel('landlord_pay') },
              { value: 'other_pay', label: payMethodLabel('other_pay') },
            ]}
          />
          <Select placeholder="按状态" allowClear options={statusOptions} value={filterStatus} onChange={v=>setFilterStatus(v)} style={{ width: isMobile ? '100%' : 160 }} />
          <DatePicker
            placeholder="选择日期"
            value={dateRange?.[0] ? dayjs(dateRange[0]) : null}
            onChange={v => setDateRange(v ? [v, v] : null)}
            style={{ width: isMobile ? '100%' : undefined }}
          />
          <Button onClick={()=>{
            setFilterPropertyId(undefined)
            setFilterCode('')
            setFilterWorkNo('')
            setFilterSubmitter('')
            setFilterPayMethod(undefined)
            setFilterStatus(undefined)
            setDateRange(null)
            setPage(1)
            loadMaintenance(true)
          }}>重置</Button>
          <Button onClick={exportExcel}>导出Excel</Button>
          {captureEnabled ? (
            <Button onClick={async ()=>{
              const el = document.querySelector('[data-page-root="maintenance-records"]') as HTMLElement
              const target = el || document.body
              const canvas = await html2canvas(target, { scale: 2 })
              const url = canvas.toDataURL('image/png')
              const a = document.createElement('a')
              a.href = url
              a.download = `maintenance-records-${window.innerWidth}.png`
              a.click()
            }} style={{ width: isMobile ? '100%' : undefined }}>导出截图</Button>
          ) : null}
        </Space>
        <div data-export-root="maintenance-records">
          {(() => {
            if (isMobile) {
              return (
                <Space direction="vertical" style={{ width: '100%' }} data-page-root="maintenance-records">
                  {filtered.map(r => (
                    <Card
                      size="small"
                      key={r.id}
                      style={{ borderRadius: 12, cursor: 'pointer' }}
                      onClick={(e: any) => {
                        const t = (e as any)?.target as any
                        const hit = t?.closest?.('button,a,input,textarea,select,option,.ant-select,.ant-dropdown,.ant-checkbox-wrapper,.ant-popover,.ant-modal,.ant-drawer')
                        if (hit) return
                        openView(r)
                      }}
                    >
                      <Space direction="vertical" style={{ width: '100%' }}>
                        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap: 8 }}>
                          <div>房号：{String((r as any).code || r.property_id || '')}</div>
                          <div>工单号：{String((r as any).work_no || '') || '-'}</div>
                          <div>状态：{statusTag(r.status)}</div>
                          <div>紧急：{urgencyTag(r.urgency)}</div>
                          <div>问题区域：{issueAreaLabel(r) || '-'}</div>
                          <div>提交人：{String((r as any)?.submitter_name || (r as any)?.worker_name || (r as any)?.created_by || '-')}</div>
                          <div style={{ gridColumn:'1 / span 2' }}>完成日期：{(r as any)?.completed_at ? dayjs((r as any).completed_at).format('YYYY-MM-DD') : '-'}</div>
                          <div style={{ gridColumn:'1 / span 2' }}>提交时间：{r.submitted_at ? dayjs(r.submitted_at).format('YYYY-MM-DD') : '-'}</div>
                          <div style={{ gridColumn:'1 / span 2' }}>问题摘要：{summaryFromDetails(r.details)}</div>
                          <div>维修金额：{fmtAmount(calcTotalAmount(r)?.total)}</div>
                          <div>是否有配件费：{(r as any).has_parts === true ? '是' : (r as any).has_parts === false ? '否' : '-'}</div>
                          <div>配件费：{fmtAmount((r as any).parts_amount)}</div>
                          <div>扣款方式：{payMethodLabel((r as any).pay_method)}</div>
                          {(r as any).pay_method === 'other_pay' ? (
                            <div style={{ gridColumn:'1 / span 2' }}>其他人备注：{String((r as any).pay_other_note || '-')}</div>
                          ) : null}
                        </div>
                        <TableRowActions actions={maintenanceRowActions(r)} />
                      </Space>
                    </Card>
                  ))}
                  {list.length < total ? (
                    <Button block loading={loading} onClick={()=>setPage(p=>p+1)}>加载更多</Button>
                  ) : null}
                </Space>
              )
            }
            const columns = [
              { title:'房号', dataIndex:'code', width: 120, ellipsis: true, fixed: 'left' },
              { title:'工单号', dataIndex:'work_no', width: 160, render: (_: any, r: any) => String((r as any)?.work_no || (r as any)?.id || '') },
              { title:'紧急程度', dataIndex:'urgency', width: 120, render:(u:string)=> urgencyTag(u) },
              { title:'问题区域', dataIndex:'category', width: 120, render: (_: any, r: any) => issueAreaLabel(r) },
              { title:'问题摘要', dataIndex:'details', ellipsis: true, width: 280, render:(d:string)=> summaryFromDetails(d) },
              { title:'提交人', dataIndex:'submitter_name', width: 120, render: (_: any, r: any) => String((r as any)?.submitter_name || (r as any)?.worker_name || (r as any)?.created_by || '') },
              { title:'完成时间', dataIndex:'completed_at', width: 180, render:(d:string)=> d ? dayjs(d).format('YYYY-MM-DD') : '-' },
              { title:'提交时间', dataIndex:'submitted_at', width: 180, render: (_: any, r: any) => {
                const v = (r as any)?.submitted_at
                return v ? dayjs(v).format('YYYY-MM-DD') : '-'
              } },
              { title:'维修金额', dataIndex:'maintenance_amount', width: 140, render:(_:any, r:any)=> fmtAmount(calcTotalAmount(r)?.total) },
              { title:'是否有配件费', dataIndex:'has_parts', width: 120, render:(b:boolean)=> b === true ? '是' : b === false ? '否' : '-' },
              { title:'配件费金额', dataIndex:'parts_amount', width: 140, render:(a:any)=> fmtAmount(a) },
              { title:'扣款方式', dataIndex:'pay_method', width: 140, render:(v:string)=> payMethodLabel(v) },
              { title:'其他人备注', dataIndex:'pay_other_note', width: 160 },
              { title:'状态', dataIndex:'status', width: 120, render:(s:string)=> statusTag(s) },
              { title:'分配人员', dataIndex:'assignee_name', width: 140, render: (_: any, r: RepairOrder) => String(r.assignee_name || '-') },
              { title:'操作', width: 400, fixed: 'right', render: (_:any, r:RepairOrder) => maintenanceTableRowActions(r) },
            ]
            return (
              <div style={{ width:'100%', overflowX:'auto' }}>
                <Table
                  rowKey={r=>r.id}
                  dataSource={filtered}
                  loading={loading}
                  onRow={(record: any) => ({
                    onClick: (e: any) => {
                      const t = (e as any)?.target as any
                      const hit = t?.closest?.('button,a,input,textarea,select,option,.ant-select,.ant-dropdown,.ant-checkbox-wrapper,.ant-popover,.ant-modal,.ant-drawer')
                      if (hit) return
                      openView(record as any)
                    },
                    style: { cursor: 'pointer' },
                  })}
                  pagination={{
                    current: page,
                    pageSize,
                    total,
                    showSizeChanger: true,
                    onChange: (p, ps) => {
                      if (ps !== pageSize) { setPageSize(ps); setPage(1) } else { setPage(p) }
                    }
                  }}
                  scroll={{ x: 1880 }}
                  columns={columns as any}
                />
              </div>
            )
          })()}
        </div>
      </Card>

      <Modal open={pdfJobUi.open} footer={null} closable={false} maskClosable={false} title="正在生成 PDF" width={isMobile ? '92vw' : 520}>
        <Space direction="vertical" style={{ width: '100%' }} size={14}>
          <Progress percent={Math.max(0, Math.min(100, Number(pdfJobUi.progress || 0)))} status={pdfJobUi.timeout ? 'exception' : 'active'} />
          <div style={{ fontWeight: 600 }}>{pdfJobUi.stage || '处理中...'}</div>
          <div style={{ color: 'rgba(0,0,0,0.65)' }}>{pdfJobUi.detail || '正在处理，请稍候...'}</div>
          {pdfJobUi.timeout ? <div style={{ color: '#d97706' }}>当前网络较慢，任务可能仍在后台继续执行。</div> : null}
        </Space>
      </Modal>

      <Modal
        open={pdfPreview.open}
        onCancel={closePdfPreview}
        title={pdfPreview.title || 'PDF预览'}
        width={isMobile ? '100%' : 980}
        style={{ top: 12 }}
        footer={
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
            <Space>
              <span>包含中文</span>
              <Switch checked={pdfPreview.showChinese} onChange={(v) => setPdfPreview(p => ({ ...p, showChinese: !!v }))} disabled={pdfPreview.loading} />
            </Space>
            <Space>
              <Button onClick={closePdfPreview}>关闭</Button>
              <Button type="primary" onClick={exportFromPreview} disabled={!pdfPreview.blob} loading={pdfPreview.loading}>导出</Button>
            </Space>
          </div>
        }
      >
        {pdfPreview.url ? (
          <iframe src={pdfPreview.url} style={{ width: '100%', height: isMobile ? '75vh' : '80vh', border: 'none' }} />
        ) : null}
      </Modal>

      <Drawer
        open={viewOpen}
        onClose={()=>setViewOpen(false)}
        placement="right"
        width={isMobile ? 420 : 720}
        footer={
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button onClick={() => setViewOpen(false)}>关闭</Button>
            {viewRow && hasPerm('property_maintenance.write') ? <Button type="primary" onClick={() => { setViewOpen(false); openEdit(viewRow) }}>编辑记录</Button> : null}
          </div>
        }
      >
        {viewRow ? (
          <>
            <Descriptions title="基本信息" bordered column={2} labelStyle={{ width: '120px' }}>
              <Descriptions.Item label="工单号">{String((viewRow as any)?.work_no || viewRow?.id || '-')}</Descriptions.Item>
              <Descriptions.Item label="状态">{statusTag((viewRow as any)?.status)}</Descriptions.Item>
              <Descriptions.Item label="房号">{String((viewRow as any)?.code || (viewRow as any)?.property_code || viewRow?.property_id || '-')}</Descriptions.Item>
              <Descriptions.Item label="紧急程度">{urgencyTag((viewRow as any)?.urgency)}</Descriptions.Item>
              <Descriptions.Item label="问题区域">{issueAreaLabel(viewRow) || '-'}</Descriptions.Item>
              <Descriptions.Item label="提交人">{String((viewRow as any)?.submitter_name || (viewRow as any)?.worker_name || (viewRow as any)?.created_by || '-')}</Descriptions.Item>
              <Descriptions.Item label="提交时间">{(viewRow as any)?.submitted_at ? dayjs((viewRow as any)?.submitted_at).format('YYYY-MM-DD') : '-'}</Descriptions.Item>
              <Descriptions.Item label="完成日期">{(viewRow as any)?.completed_at ? dayjs((viewRow as any).completed_at).format('YYYY-MM-DD') : '-'}</Descriptions.Item>
            </Descriptions>

            <Divider orientation="left">问题详情</Divider>
            <Descriptions bordered column={1} labelStyle={{ width: '120px' }}>
              <Descriptions.Item label="问题摘要" style={{ whiteSpace: 'pre-wrap' }}>
                {summaryFromDetails(viewRow?.details) || (viewRow as any)?.detail || '-'}
              </Descriptions.Item>
              <Descriptions.Item label="开票英文描述" style={{ whiteSpace: 'pre-wrap' }}>
                {String((viewRow as any)?.invoice_description_en || '-')}
              </Descriptions.Item>
            </Descriptions>

            <Divider orientation="left">费用信息</Divider>
            {(() => {
              const c = calcTotalAmount(viewRow)
              const partsHint = (viewRow as any)?.has_parts === true ? (c?.includesParts ? '包含' : '额外') : '-'
              const gstText = (viewRow as any)?.has_gst === true ? (c?.includesGst ? '包含' : fmtAmount(c?.gstExtra)) : '-'
              return (
                <Descriptions bordered column={2} labelStyle={{ width: '120px' }}>
                  <Descriptions.Item label="总金额">{fmtAmount(c?.total)}</Descriptions.Item>
                  <Descriptions.Item label="扣款方式">{payMethodLabel((viewRow as any)?.pay_method)}</Descriptions.Item>
                  <Descriptions.Item label="维修金额">{fmtAmount((viewRow as any)?.maintenance_amount)}</Descriptions.Item>
                  <Descriptions.Item label="配件费">{fmtAmount((viewRow as any)?.parts_amount)}（{partsHint}）</Descriptions.Item>
                  <Descriptions.Item label="GST">{gstText}</Descriptions.Item>
                  <Descriptions.Item label="其他人备注">{String((viewRow as any)?.pay_method || '') === 'other_pay' ? String((viewRow as any)?.pay_other_note || '-') : '-'}</Descriptions.Item>
                </Descriptions>
              )
            })()}

            <Divider orientation="left">维修前照片</Divider>
            <Descriptions bordered column={1} labelStyle={{ width: '120px' }}>
              <Descriptions.Item label="照片">
                {(() => {
                  const arr = Array.isArray((viewRow as any)?.photo_urls) ? (viewRow as any).photo_urls : []
                  if (!arr.length) return '-'
                  return (
                    <Image.PreviewGroup>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
                        {arr.map((u: string, i: number) => (
                          <MaintenanceFeedbackImage key={i} reference={u} width="100%" height={140} style={{ objectFit: 'cover', borderRadius: 8 }} />
                        ))}
                      </div>
                    </Image.PreviewGroup>
                  )
                })()}
              </Descriptions.Item>
            </Descriptions>

            <Divider orientation="left">维修后照片</Divider>
            <Descriptions bordered column={1} labelStyle={{ width: '120px' }}>
              <Descriptions.Item label="照片">
                {(() => {
                  const arr = maintenanceAfterPhotoReferences(viewRow)
                  if (!arr.length) return '-'
                  return (
                    <Image.PreviewGroup>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
                        {arr.map((u: string, i: number) => (
                          <MaintenanceFeedbackImage key={i} reference={u} width="100%" height={140} style={{ objectFit: 'cover', borderRadius: 8 }} />
                        ))}
                      </div>
                    </Image.PreviewGroup>
                  )
                })()}
              </Descriptions.Item>
            </Descriptions>
          </>
        ) : null}
      </Drawer>
      <Modal open={pwdOpen} onCancel={()=>setPwdOpen(false)} onOk={async ()=>{
        const v = await pwdForm.validateFields()
        const pass = String(v.new_password || '')
        try {
          const res = await fetch(`${API_BASE}/public/cleaning-guide/reset-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({ new_password: pass })
          })
          if (res.ok) { message.success('已更新上报密码'); setPwdOpen(false); pwdForm.resetFields() } else {
            const j = await res.json().catch(()=>null); message.error(j?.message || '更新失败')
          }
        } catch (e: any) { message.error('更新失败') }
      }} title="设置房源报修表密码" okText="保存">
        <Form form={pwdForm} layout="vertical">
          <Form.Item
            name="new_password"
            label="新密码（4-6位数字）"
            rules={[
              { required: true, message: '请输入密码' },
              { validator: (_, val) => {
                const s = String(val || '')
                if (s.length < 4 || s.length > 6) return Promise.reject(new Error('长度需为4-6位'))
                if (!/^\d+$/.test(s)) return Promise.reject(new Error('仅允许数字'))
                return Promise.resolve()
              } }
            ]}
          >
            <Input placeholder="例如 1234" maxLength={6} />
          </Form.Item>
        </Form>
      </Modal>
      <Modal open={createOpen} confirmLoading={createSaving} okButtonProps={{ disabled: createSaving }} onCancel={()=>{ if (createSaving) return; createOperationRef.current = null; setCreateOpen(false); createForm.resetFields(); setCreateFiles([]); setCreatePhotos([]) }} onOk={async ()=>{
        if (createSaving) return
        try {
          setCreateSaving(true)
          const v = await createForm.validateFields()
          const detail = String(v.details || '').trim()
          const invoiceDescriptionEn = String(v.invoice_description_en || '').trim() || null
          const operationKey = JSON.stringify({ property_id: v.property_id, area: v.area, detail, media_urls: createPhotos, invoice_description_en: invoiceDescriptionEn })
          const submitId = createOperationRef.current?.key === operationKey
            ? createOperationRef.current.id
            : newMaintenanceWorkflowOperationId()
          createOperationRef.current = { key: operationKey, id: submitId }
          await createInternalMaintenanceFeedback({
            propertyId: String(v.property_id || ''),
            area: String(v.area || ''),
            detail,
            mediaUrls: createPhotos,
            invoiceDescriptionEn,
            submitId,
          })
          message.success('已新增维修记录')
          createOperationRef.current = null
          setCreateOpen(false); createForm.resetFields(); setCreateFiles([]); setCreatePhotos([])
          setPage(1); loadMaintenance(true)
        } catch (e: any) { message.error(e?.message || '新增失败') } finally { setCreateSaving(false) }
      }} title="新增维修记录" okText="保存">
        <Form form={createForm} layout="vertical">
          <Form.Item name="property_id" label="房号" rules={[{ required: true }]}>
            <Select
              options={propOptions}
              showSearch
              optionFilterProp="label"
              filterOption={(input, option) => {
                const lbl = String((option as any)?.label || '')
                return lbl.toLowerCase().includes(String(input || '').toLowerCase())
              }}
              filterSort={(a, b) => String((a as any).label || '').localeCompare(String((b as any).label || ''), 'zh')}
            />
          </Form.Item>
          <Form.Item name="area" label="问题区域" rules={[{ required: true }]}>
            <Select options={['入户走廊','客厅','厨房','卧室','阳台','浴室','其他'].map(x => ({ value:x, label:x }))} />
          </Form.Item>
          <Typography.Text type="secondary">提交人将由系统按当前登录账号记录。</Typography.Text>
          <Form.Item name="details" label="问题摘要" rules={[{ required: true, min: 3 }]}>
            <Input.TextArea rows={3} />
          </Form.Item>
          <Form.Item name="invoice_description_en" label="开票英文描述">
            <Input.TextArea rows={3} placeholder="Optional English description for invoices" />
          </Form.Item>
          <Form.Item label="维修前照片">
            <Upload listType="picture" multiple fileList={createFiles} onRemove={(f)=>{ setCreateFiles(fl=>fl.filter(x=>x.uid!==f.uid)); if (f.url) setCreatePhotos(u=>u.filter(x=>x!==f.url)) }}
              customRequest={async ({ file, onProgress, onSuccess, onError }: any) => {
                const fd = new FormData(); fd.append('file', file)
                try {
                  const xhr = new XMLHttpRequest()
                  xhr.open('POST', `${API_BASE}/maintenance/upload`)
                  const headers = authHeaders() as any
                  Object.keys(headers || {}).forEach(k => xhr.setRequestHeader(k, headers[k]))
                  const uid = Math.random().toString(36).slice(2)
                  setCreateFiles(fl => [...fl, { uid, name: (file as any)?.name || 'image', status: 'uploading', percent: 0 } as UploadFile])
                  xhr.upload.onprogress = (evt) => {
                    if (evt.lengthComputable && onProgress) {
                      const pct = Number((((evt.loaded || 0) / (evt.total || 1)) * 100).toFixed(0))
                      onProgress({ percent: pct })
                      setCreateFiles(fl => fl.map(x => x.uid === uid ? { ...x, percent: pct, status: 'uploading' } as UploadFile : x))
                    }
                  }
                  xhr.onreadystatechange = () => {
                    if (xhr.readyState === 4) {
                      try {
                        const j = JSON.parse(xhr.responseText || '{}')
                        if (xhr.status >= 200 && xhr.status < 300 && j?.url) {
                          setCreatePhotos(u=>[...u, j.url])
                          setCreateFiles(fl=>fl.map(x => x.uid === uid ? { ...x, status: 'done', url: j.url, percent: 100 } as UploadFile : x))
                          onSuccess && onSuccess(j, file)
                        } else {
                          setCreateFiles(fl => fl.map(x => x.uid === uid ? { ...x, status: 'error' } as UploadFile : x))
                          onError && onError(j)
                        }
                      } catch (e) { onError && onError(e) }
                    }
                  }
                  xhr.onerror = (e) => { onError && onError(e) }
                  xhr.send(fd)
                } catch (e) { onError && onError(e) }
              }}>
              <Button>上传照片</Button>
            </Upload>
          </Form.Item>
        </Form>
      </Modal>
      <Drawer
        title={
          <div className={styles.drawerTitle}>
            <div>
              <div className={styles.drawerTitleText}>更新维修记录</div>
              <div className={styles.drawerSubtitle}>房号 {editingPropertyCode} · {String(editing?.work_no || editing?.id || '未生成工单号')}</div>
            </div>
            {editing ? statusTag(editing.status) : null}
          </div>
        }
        width={isMobile ? '100%' : 760}
        className={styles.maintenanceDrawer}
        onClose={closeEdit}
        open={open}
        closable={!saving}
        maskClosable={!saving}
        footer={
          <div className={styles.drawerFooter}>
            <div className={styles.drawerFooterSummary}>
              <span>本次处理</span>
              <strong>{drawerAction.title}</strong>
            </div>
            <Space>
              <Button onClick={closeEdit} disabled={saving}>取消</Button>
              <Button type="primary" onClick={save} loading={saving} disabled={saving}>{drawerAction.title}</Button>
            </Space>
          </div>
        }
      >
        <Spin spinning={saving} tip="保存中…">
        <Form form={form} layout="vertical">
          <div className={styles.workflowOverview}>
            <div className={styles.workflowOverviewHeader}>
              <div>
                <div className={styles.eyebrow}>维修流程</div>
                <div className={styles.workflowOverviewTitle}>当前处于「{statusLabel(editing?.status)}」</div>
              </div>
              {editing?.urgency ? urgencyTag(editing.urgency) : null}
            </div>
            <Steps
              size="small"
              current={maintenanceWorkflowStep(editing?.status)}
              status={editCurrentWorkflowStatus === 'cancelled' ? 'error' : 'process'}
              items={[
                { title: '待分派' },
                { title: '维修中' },
                { title: '待审核' },
                { title: '已关闭' },
              ]}
            />
          </div>

          <div className={styles.workflowActionPanel}>
            <div className={styles.workflowActionHeading}>
              <div>
                <div className={styles.eyebrow}>本次处理</div>
                <div className={styles.workflowActionTitle}>{drawerAction.title}</div>
              </div>
              <Typography.Text type="secondary">{drawerAction.detail}</Typography.Text>
            </div>
            {canManageMaintenanceWorkflow ? (
              <>
                <Form.Item name="workflow_target_status" label="选择处理动作" className={styles.compactFormItem}>
                  <Select options={maintenanceWorkflowTargetOptions(editing?.status)} disabled={saving} />
                </Form.Item>
                {workflowReasonRequired ? (
                  <Form.Item name="workflow_reason" label="状态变更原因" rules={[{ required: true, whitespace: true, message: '请填写状态变更原因' }]} className={styles.compactFormItem}>
                    <Input.TextArea rows={2} placeholder="请说明取消、退回维修或重新打开的原因" />
                  </Form.Item>
                ) : null}
              </>
            ) : (
              <Alert
                type="info"
                showIcon
                message="当前账号可编辑记录内容"
                description="如需分配、完工、审核、重开或取消维修，请在权限管理中授予“维修流程管理”权限。"
              />
            )}
          </div>

          <Divider orientation="left" className={styles.drawerSectionDivider}>工单与分派</Divider>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="property_id" label="房号">
                <Select allowClear showSearch optionFilterProp="label" options={propOptions} placeholder="请选择房号" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="submitter_name" label="提交人">
                <Input placeholder="提交人" />
              </Form.Item>
            </Col>
            <Col span={12}>
              {['pending_assignment', 'assigned', 'in_progress'].includes(editCurrentWorkflowStatus) ? (
                <Form.Item name="urgency" label="紧急程度">
                  <Select options={[
                    { value:'urgent', label:'紧急' },
                    { value:'normal', label:'普通' },
                    { value:'not_urgent', label:'不紧急' },
                  ]} />
                </Form.Item>
              ) : null}
            </Col>
            {canManageMaintenanceWorkflow && ['pending_assignment', 'pending', 'assigned', 'in_progress'].includes(String(editing?.status || '')) && !recordingCompletion ? (
              <>
                <Col span={12}>
                  <Form.Item name="assignee_id" label="分配维修人员" extra="选择后点击保存，即会完成分配。">
                    <Select
                      allowClear
                      showSearch
                      optionFilterProp="label"
                      options={userOptions}
                      placeholder="请选择维修人员"
                      disabled={saving}
                    />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item name="eta" label="预计完成时间">
                    <DatePicker style={{ width: '100%' }} disabled={saving} />
                  </Form.Item>
                </Col>
              </>
            ) : (
              <Col span={24}>
                <Typography.Text type="secondary">{canManageMaintenanceWorkflow ? '当前状态不能分配维修人员。' : '当前账号没有维修流程管理权限，不能分配维修人员。'}</Typography.Text>
              </Col>
            )}
          </Row>

          <details className={styles.issueDisclosure}>
            <summary>
              <span>
                <strong>问题与维修前照片</strong>
                <em>{summaryFromDetails(editing?.details) || '展开查看或编辑报修内容'}</em>
              </span>
              <span className={styles.disclosureHint}>展开</span>
            </summary>
            <div className={styles.issueDisclosureBody}>
              <Row gutter={16}>
            <Col span={24}>
              <Form.Item name="details" label="问题摘要"><Input.TextArea rows={3} /></Form.Item>
            </Col>
            <Col span={24}>
              <Form.Item name="invoice_description_en" label="开票英文描述">
                <Input.TextArea rows={3} placeholder="Optional English description for invoices" />
              </Form.Item>
            </Col>
            <Col span={24}>
              <Form.Item label="维修前照片">
                <Upload listType="picture-card" multiple fileList={preFiles} onRemove={(f)=>{ setPreFiles(fl=>fl.filter(x=>x.uid!==f.uid)); const originalUrl = storedPhotoUrl(f); if (originalUrl) setPrePhotos(u=>u.filter(x=>x!==originalUrl)) }}
                  customRequest={async ({ file, onProgress, onSuccess, onError }: any) => {
                    const fd = new FormData(); fd.append('file', file)
                    try {
                      const xhr = new XMLHttpRequest()
                      xhr.open('POST', `${API_BASE}/maintenance/upload`)
                      const headers = authHeaders() as any
                      Object.keys(headers || {}).forEach(k => xhr.setRequestHeader(k, headers[k]))
                      const uid = Math.random().toString(36).slice(2)
                      setPreFiles(fl => [...fl, { uid, name: (file as any)?.name || 'image', status: 'uploading', percent: 0 } as UploadFile])
                      xhr.upload.onprogress = (evt) => {
                        if (evt.lengthComputable && onProgress) {
                          const pct = Number((((evt.loaded || 0) / (evt.total || 1)) * 100).toFixed(0))
                          onProgress({ percent: pct })
                          setPreFiles(fl => fl.map(x => x.uid === uid ? { ...x, percent: pct, status: 'uploading' } as UploadFile : x))
                        }
                      }
                      xhr.onreadystatechange = () => {
                        if (xhr.readyState === 4) {
                          try {
                            const j = JSON.parse(xhr.responseText || '{}')
                            if (xhr.status >= 200 && xhr.status < 300 && j?.url) {
                              setPrePhotos(u=>[...u, j.url])
                              setPreFiles(fl => fl.map(x => x.uid === uid ? { ...x, status: 'done', url: j.url, percent: 100 } as UploadFile : x))
                              onSuccess && onSuccess(j, file)
                            } else {
                              setPreFiles(fl => fl.map(x => x.uid === uid ? { ...x, status: 'error' } as UploadFile : x))
                              onError && onError(j)
                            }
                          } catch (e) { onError && onError(e) }
                        }
                      }
                      xhr.onerror = (e) => { onError && onError(e) }
                      xhr.send(fd)
                    } catch (e) { onError && onError(e) }
                  }}>
                  <div>
                    <PictureOutlined />
                    <div style={{ marginTop: 8 }}>上传</div>
                  </div>
                </Upload>
              </Form.Item>
            </Col>
              </Row>
            </div>
          </details>

          {normalizedMaintenanceWorkflowStatus(editing?.status) !== 'cancelled' ? (
            <>
              <section className={styles.drawerSection}>
              <div className={styles.sectionTitleRow}>
                <div>
                  <div className={styles.eyebrow}>维修结果</div>
                  <div className={styles.sectionTitle}>维修说明、完成照片与实际完成日期</div>
                </div>
                <Tag color={completionPhotoRequired ? 'gold' : 'default'}>{completionPhotoRequired ? '提交审核时必填' : '按需补充'}</Tag>
              </div>
              <Row gutter={16}>
                <Col span={24}>
                  <Form.Item name="repair_notes" label="维修说明"><Input.TextArea rows={3} placeholder="说明维修完成内容或需要注意的事项" disabled={saving || closedCompletionFieldsReadOnly} /></Form.Item>
                </Col>
                {recordingActualRepairer ? (
                  <Col span={12}>
                    <Form.Item
                      name="assignee_id"
                      label="实际维修人员"
                      extra="关闭或提交审核时，记录实际完成维修的人员；不填写预计完成时间。"
                      rules={editCurrentWorkflowStatus === 'closed' || editing?.assignee_id ? undefined : [{ required: true, message: '请选择实际维修人员' }]}
                    >
                      <Select
                        showSearch
                        optionFilterProp="label"
                        options={userOptions}
                        placeholder="请选择实际维修人员"
                        disabled={saving || closedCompletionFieldsReadOnly}
                      />
                    </Form.Item>
                  </Col>
                ) : null}
                <Col span={24}>
                  <Form.Item label="维修后照片" extra={editCurrentWorkflowStatus === 'closed' && canManageMaintenanceWorkflow ? '可直接更新；保存时系统会保留修正记录，且必须至少保留一张。' : closedCompletionFieldsReadOnly ? '已关闭记录的完成照片受流程保护。' : completionPhotoRequired ? '提交审核前至少上传一张维修后照片。' : '建议上传维修后的现场照片，作为结算和审核依据。'}>
                    <Upload listType="picture-card" multiple fileList={files} disabled={saving || closedCompletionFieldsReadOnly} onRemove={(f)=>{ setFiles(fl=>fl.filter(x=>x.uid!==f.uid)); const originalUrl = storedPhotoUrl(f); if (originalUrl) setRepairPhotos(u=>u.filter(x=>x!==originalUrl)) }}
                      customRequest={async ({ file, onProgress, onSuccess, onError }: any) => {
                        const fd = new FormData(); fd.append('file', file)
                        try {
                          const xhr = new XMLHttpRequest()
                          xhr.open('POST', `${API_BASE}/maintenance/upload`)
                          const headers = authHeaders() as any
                          Object.keys(headers || {}).forEach(k => xhr.setRequestHeader(k, headers[k]))
                          const uid = Math.random().toString(36).slice(2)
                          setFiles(fl => [...fl, { uid, name: (file as any)?.name || 'image', status: 'uploading', percent: 0 } as UploadFile])
                          xhr.upload.onprogress = (evt) => {
                            if (evt.lengthComputable && onProgress) {
                              const pct = Number((((evt.loaded || 0) / (evt.total || 1)) * 100).toFixed(0))
                              onProgress({ percent: pct })
                              setFiles(fl => fl.map(x => x.uid === uid ? { ...x, percent: pct, status: 'uploading' } as UploadFile : x))
                            }
                          }
                          xhr.onreadystatechange = () => {
                            if (xhr.readyState === 4) {
                              try {
                                const j = JSON.parse(xhr.responseText || '{}')
                                if (xhr.status >= 200 && xhr.status < 300 && j?.url) {
                                  setRepairPhotos(u=>[...u, j.url])
                                  setFiles(fl => fl.map(x => x.uid === uid ? { ...x, status: 'done', url: j.url, percent: 100 } as UploadFile : x))
                                  onSuccess && onSuccess(j, file)
                                } else {
                                  setFiles(fl => fl.map(x => x.uid === uid ? { ...x, status: 'error' } as UploadFile : x))
                                  onError && onError(j)
                                }
                              } catch (e) { onError && onError(e) }
                            }
                          }
                          xhr.onerror = (e) => { onError && onError(e) }
                          xhr.send(fd)
                        } catch (e) { onError && onError(e) }
                      }}>
                      <div>
                        <PictureOutlined />
                        <div style={{ marginTop: 8 }}>上传</div>
                      </div>
                    </Upload>
                  </Form.Item>
                </Col>
                {canManageMaintenanceWorkflow ? (
                  <Col span={12}>
                    <Form.Item name="completed_at" label="实际完成日期" extra="用于维修费用的入账日期；留空则由完成流程写入当前日期。">
                      <DatePicker style={{ width: '100%' }} disabled={saving || closedCompletionFieldsReadOnly} />
                    </Form.Item>
                  </Col>
                ) : null}
              </Row>
              </section>
            </>
          ) : null}

          {normalizedMaintenanceWorkflowStatus(editing?.status) !== 'cancelled' ? (
            <>
              <section className={styles.drawerSection}>
              <div className={styles.sectionTitleRow}>
                <div>
                  <div className={styles.eyebrow}>费用结算</div>
                  <div className={styles.sectionTitle}>登记金额与费用承担方式</div>
                </div>
                <Typography.Text type="secondary">总计 {fmtAmount(feeTotal?.total)}</Typography.Text>
              </div>
              <div className={styles.feeGrid}>
                <div className={styles.feeRow2}>
                  <Form.Item name="maintenance_amount" label="维修金额（AUD）">
                    <InputNumber
                      min={0}
                      step={1}
                      style={{ width: '100%' }}
                      formatter={(v) => `$ ${v || ''}`}
                      parser={(v: any) => {
                        const n = Number(String(v || '').replace(/\$\s?/g, ''))
                        return Number.isFinite(n) ? n : 0
                      }}
                    />
                  </Form.Item>
                  <Typography.Text type="secondary">费用和扣款方式可先登记；进入待审核或关闭时会按流程结算。</Typography.Text>
                </div>
                <div className={styles.feeRow1}>
                  <Form.Item label="总金额（AUD）">
                    <InputNumber
                      disabled
                      value={feeTotal?.total ?? undefined}
                      style={{ width: '100%' }}
                      formatter={(v) => `$ ${v || ''}`}
                      parser={(v: any) => {
                        const n = Number(String(v || '').replace(/\$\s?/g, ''))
                        return Number.isFinite(n) ? n : 0
                      }}
                    />
                  </Form.Item>
                </div>

                <div className={styles.feeToggleRow}>
                  <div className={styles.feeToggleCard}>
                    <div className={styles.feeToggleLeft}>
                      <span className={styles.feeToggleIcon}><AppstoreOutlined /></span>
                      <span className={styles.feeToggleText}>是否有配件费</span>
                    </div>
                    <Form.Item name="has_parts" valuePropName="checked" noStyle>
                      <Switch onChange={(checked) => { if (!checked) form.setFieldsValue({ parts_amount: undefined, maintenance_amount_includes_parts: undefined }) }} />
                    </Form.Item>
                  </div>

                  <div className={styles.feeToggleCard}>
                    <div className={styles.feeToggleLeft}>
                      <span className={styles.feeToggleIcon}><PercentageOutlined /></span>
                      <span className={styles.feeToggleText}>是否有 GST</span>
                    </div>
                    <Form.Item name="has_gst" valuePropName="checked" noStyle>
                      <Switch onChange={(checked) => { if (!checked) form.setFieldsValue({ maintenance_amount_includes_gst: undefined }) }} />
                    </Form.Item>
                  </div>
                </div>

                {hasPartsWatch ? (
                  <div className={styles.feeDashedBox}>
                    <div className={styles.feeDashedRow}>
                      <div>
                        <div className={styles.feeInlineLabel}>配件费金额（AUD）</div>
                        <Form.Item name="parts_amount" noStyle>
                          <InputNumber
                            min={0}
                            step={1}
                            style={{ width: '100%' }}
                            formatter={(v) => `$ ${v || ''}`}
                            parser={(v: any) => {
                              const n = Number(String(v || '').replace(/\$\s?/g, ''))
                              return Number.isFinite(n) ? n : 0
                            }}
                          />
                        </Form.Item>
                      </div>
                      <div>
                        <div className={styles.feeInlineLabel}>维修金额是否包含配件费</div>
                        <div className={styles.feeToggleLine}>
                          <Form.Item name="maintenance_amount_includes_parts" valuePropName="checked" noStyle>
                            <Switch />
                          </Form.Item>
                          <span className={styles.feeHint}>额外支付</span>
                        </div>
                      </div>
                    </div>
                  </div>
                ) : null}

                <div className={styles.feePayBox}>
                  <Form.Item name="pay_method" label={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><CreditCardOutlined />扣款方式</span>}>
                    <Select
                      options={[
                        { value: 'rent_deduction', label: '租金扣除' },
                        { value: 'tenant_pay', label: '房客支付' },
                        { value: 'company_pay', label: '公司承担' },
                        { value: 'landlord_pay', label: '房东支付' },
                        { value: 'other_pay', label: '其他人支付' },
                      ]}
                    />
                  </Form.Item>
                  <Form.Item name="pay_other_note" label="其他人备注" style={{ display: String(payMethodWatch || '') === 'other_pay' ? 'block' : 'none' }}>
                    <Input />
                  </Form.Item>
                </div>
              </div>
              </section>
            </>
          ) : null}
        </Form>
        </Spin>
      </Drawer>
    </Space>
  )
}
