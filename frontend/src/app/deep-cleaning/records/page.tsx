"use client"
import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, App, Button, Card, DatePicker, Descriptions, Divider, Drawer, Form, Grid, Image, Input, InputNumber, Modal, Progress, Select, Space, Switch, Table, Tag, TimePicker, Typography, Upload } from 'antd'
import type { UploadFile, UploadProps } from 'antd'
import dayjs from 'dayjs'
import { CheckCircleOutlined, EnvironmentOutlined, InfoCircleOutlined, PictureOutlined, ShareAltOutlined } from '@ant-design/icons'
import { API_BASE, apiCreate, apiDelete, apiUpdate, authHeaders, getJSON } from '../../../lib/api'
import { hasPerm } from '../../../lib/auth'
import { downloadNamedBlob } from '../../../lib/download'
import { sortProperties } from '../../../lib/properties'
import DeepCleaningMedia from '../../../components/DeepCleaningMedia'
import TableRowActions from '../../../components/TableRowActions'
import { deepCleaningExecutionUploadReference, deepCleaningCompletionPayload, deepCleaningCanAct, deepCleaningExecutorLabel, mergeDeepCleaningAuthoritativeRow, deepCleaningNeedsReviewAssignee, deepCleaningReviewPayload, newDeepCleaningOperationId } from '../../../lib/deepCleaningWorkflow'
import { DEEP_CLEANING_AREAS, deepCleaningSubmitterEditPatch, deepCleaningSubmitterDisplay, deepCleaningAreas, deepCleaningDetails, deepCleaningSummary, deepCleaningDisplayCost, deepCleaningMediaReferences, deepCleaningDate, deepCleaningDateBound, deepCleaningVisibleAttachments } from '../../../lib/deepCleaningRecordDisplay'
import { runWorkRecordPdfJob } from '../../../lib/workRecordPdfJobs'

type DeepCleaningRecord = {
  id: string
  property_id?: string
  code?: string
  property_code?: string
  work_no?: string
  occurred_at?: string
  worker_name?: string
  project_desc?: string
  started_at?: string
  ended_at?: string
  duration_minutes?: number
  category?: string
  status?: string
  urgency?: string
  submitter_name?: string
  submitter_display_name?: string | null
  submitter_display_source?: string
  submitted_at?: string
  created_by?: string
  assignee_id?: string
  eta?: string
  completed_at?: string
  details?: any
  invoice_description_en?: string
  notes?: string
  photo_urls?: string[]
  repair_notes?: string
  repair_photo_urls?: string[]
  attachment_urls?: string[]
  checklist?: any[]
  consumables?: any[]
  labor_minutes?: number
  labor_cost?: number
  total_cost?: number
  pay_method?: string
  gst_type?: string
  review_status?: string
  review_notes?: string
  reviewed_by?: string
  reviewed_at?: string
  created_at?: string
  updated_at?: string
  media_access_work_task_id?: string | null
  workflow_status?: string
  available_actions?: string[]
  can_review?: boolean
  can_assign?: boolean
  pricing_mode?: string
  price_items?: { id: string; description: string; amount: number }[]
}

function safeJsonParse(v: any) {
  if (v === null || v === undefined) return null
  if (typeof v === 'object') return v
  const s = String(v || '').trim()
  if (!s) return null
  try { return JSON.parse(s) } catch { return null }
}

function toUploadFileList(urls: string[] | undefined): UploadFile[] {
  return deepCleaningMediaReferences(urls).map((u, idx) => ({
    uid: `${idx}-${u}`,
    name: String(u).split('/').pop() || `file-${idx + 1}`,
    status: 'done',
    url: u,
  }))
}

function fmtMinutes(m?: any): string {
  if (m === null || m === undefined || m === '') return '-'
  const n = Number(m)
  if (!Number.isFinite(n) || n < 0) return '-'
  const h = Math.floor(n / 60)
  const mm = n % 60
  if (h <= 0) return `${mm} 分钟`
  return `${h} 小时 ${mm} 分钟`
}

function fmtAmount(a?: any) {
  if (a === undefined || a === null || a === '') return '-'
  const n = Number(a)
  if (!Number.isFinite(n)) return String(a)
  try {
    return new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(n).replace('A$', '$')
  } catch {
    return `$${n.toFixed(2)}`
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

function gstTypeLabel(v?: string | null) {
  const s = String(v || '')
  if (!s) return '-'
  if (s === 'GST_INCLUDED_10') return '含GST'
  if (s === 'GST_10') return '不含GST（另计）'
  if (s === 'GST_FREE') return '免GST'
  if (s === 'INPUT_TAXED') return 'INPUT_TAXED'
  return s
}

function combineDateAndTimeToIso(dateRaw: any, timeRaw: any): string | null {
  if (!dateRaw || !timeRaw) return null
  const d = dayjs(dateRaw)
  const t = dayjs(timeRaw)
  if (!d.isValid() || !t.isValid()) return null
  return d.hour(t.hour()).minute(t.minute()).second(0).millisecond(0).toISOString()
}

export default function DeepCleaningRecordsPage() {
  const { message, modal } = App.useApp()
  const screens = Grid.useBreakpoint()
  const isMobile = !screens.md
  const [mounted, setMounted] = useState(false)
  useEffect(() => { setMounted(true) }, [])
  const canWrite = mounted && hasPerm('property_deep_cleaning.write')
  const canDownload = mounted && (hasPerm('property_deep_cleaning.view') || canWrite)

  const [list, setList] = useState<DeepCleaningRecord[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [listError, setListError] = useState('')
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const [pdfPreview, setPdfPreview] = useState<{ open: boolean; url: string; title: string; showChinese: boolean; blob: Blob | null; row: DeepCleaningRecord | null; loading: boolean }>({ open: false, url: '', title: '', showChinese: false, blob: null, row: null, loading: false })
  const [pdfJobUi, setPdfJobUi] = useState<{ open: boolean; stage: string; detail: string; progress: number; timeout: boolean }>({ open: false, stage: '', detail: '', progress: 0, timeout: false })
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)

  const [props, setProps] = useState<{ id: string; code?: string }[]>([])
  const [userOptions, setUserOptions] = useState<{ value: string; label: string }[]>([])

  const [filterPropertyId, setFilterPropertyId] = useState<string | undefined>(undefined)
  const [filterStatus, setFilterStatus] = useState<string | undefined>(undefined)
  const [filterCat, setFilterCat] = useState<string | undefined>(undefined)
  const [filterPayMethod, setFilterPayMethod] = useState<string | undefined>(undefined)
  const [dateRange, setDateRange] = useState<[any, any] | null>(null)

  const [createOpen, setCreateOpen] = useState(false)
  const [editing, setEditing] = useState<DeepCleaningRecord | null>(null)
  const [savingEdit, setSavingEdit] = useState(false)
  const [savingCreate, setSavingCreate] = useState(false)
  const [workflow, setWorkflow] = useState<{ row: DeepCleaningRecord; action: 'assign' | 'review' | 'complete'; operationId: string } | null>(null)
  const [savingWorkflow, setSavingWorkflow] = useState(false)
  const [executorOptions, setExecutorOptions] = useState<{ value: string; label: string }[]>([])
  const [executorError, setExecutorError] = useState('')
  const [completeFiles, setCompleteFiles] = useState<UploadFile[]>([])
  const [completeBeforeFiles, setCompleteBeforeFiles] = useState<UploadFile[]>([])
  const [workflowForm] = Form.useForm()
  const [viewing, setViewing] = useState<DeepCleaningRecord | null>(null)
  const [mediaPreviewContext, setMediaPreviewContext] = useState<DeepCleaningRecord | null>(null)
  const [mediaPreview, setMediaPreview] = useState<string | null>(null)

  const [createForm] = Form.useForm()
  const [editForm] = Form.useForm()

  const [createBeforeFiles, setCreateBeforeFiles] = useState<UploadFile[]>([])
  const [createAttachFiles, setCreateAttachFiles] = useState<UploadFile[]>([])
  const [editBeforeFiles, setEditBeforeFiles] = useState<UploadFile[]>([])
  const [editAfterFiles, setEditAfterFiles] = useState<UploadFile[]>([])
  const [editAttachFiles, setEditAttachFiles] = useState<UploadFile[]>([])

  const abortRef = useRef<AbortController | null>(null)
  const editSnapshotRef = useRef('')

  const statusOptions = [
    { value: 'pending', label: '待清洁' },
    { value: 'assigned', label: '已分配' },
    { value: 'in_progress', label: '清洁中' },
    { value: 'pending_review', label: '待审核' },
    { value: 'review_pending', label: '待审核（历史）' },
    { value: 'completed', label: '已完成' },
    { value: 'canceled', label: '已取消' },
  ]
  const catOptions = DEEP_CLEANING_AREAS.map(x => ({ value: x, label: x }))
  const urgencyOptions = [
    { value: 'low', label: '低' },
    { value: 'normal', label: '中' },
    { value: 'high', label: '高' },
  ]
  const payMethodOptions = [
    { value: 'rent_deduction', label: '租金扣除' },
    { value: 'tenant_pay', label: '房客支付' },
    { value: 'company_pay', label: '公司承担' },
    { value: 'landlord_pay', label: '房东支付' },
    { value: 'other_pay', label: '其他人支付' },
  ]
  const gstTypeOptions = [
    { value: 'GST_INCLUDED_10', label: '含GST' },
    { value: 'GST_10', label: '不含GST（另计）' },
    { value: 'GST_FREE', label: '免GST' },
    { value: 'INPUT_TAXED', label: 'INPUT_TAXED' },
  ]
  const reviewOptions = [
    { value: 'pending', label: '待审核' },
    { value: 'approved', label: '已通过' },
    { value: 'rejected', label: '已驳回' },
  ]

  function statusTag(s?: string) {
    const v = String(s || '')
    const label = statusOptions.find(x => x.value === v)?.label || v || '-'
    if (v === 'pending') return <Tag color="default">{label}</Tag>
    if (v === 'assigned') return <Tag color="blue">{label}</Tag>
    if (v === 'in_progress') return <Tag color="orange">{label}</Tag>
    if (v === 'review_pending' || v === 'pending_review') return <Tag color="gold">{label}</Tag>
    if (v === 'completed') return <Tag color="purple">{label}</Tag>
    if (v === 'canceled') return <Tag color="red">{label}</Tag>
    return <Tag>{label}</Tag>
  }
  function reviewTag(s?: string) {
    const v = String(s || '')
    const label = reviewOptions.find(x => x.value === v)?.label || v || '-'
    if (v === 'pending') return <Tag color="default">{label}</Tag>
    if (v === 'approved') return <Tag color="green">{label}</Tag>
    if (v === 'rejected') return <Tag color="red">{label}</Tag>
    return <Tag>{label}</Tag>
  }

  const propOptions = useMemo(() => sortProperties(props).map(p => ({ value: p.id, label: p.code || p.id })), [props])
  const submitterOptions = useMemo(() => {
    const seen = new Set<string>()
    const out: { value: string; label: string }[] = []
    for (const u of (userOptions || [])) {
      const v = String((u as any)?.label || '').trim()
      if (!v || seen.has(v)) continue
      seen.add(v)
      out.push({ value: v, label: v })
    }
    return out
  }, [userOptions])

  const [localPreviewVideo, setLocalPreviewVideo] = useState(false)
  const localUploadPreviewUrls = useRef(new Map<string, string>())
  useEffect(() => () => { localUploadPreviewUrls.current.forEach(url => URL.revokeObjectURL(url)) }, [])

  async function uploadFile(file: File, execution = false) {
    const fd = new FormData()
    fd.append('file', file)
    const res = await fetch(`${API_BASE}${execution ? "/mzapp/upload" : "/deep-cleaning/upload"}`, { method: 'POST', headers: authHeaders(), body: fd })
    if (!res.ok) {
      const j = await res.json().catch(()=>null)
      throw new Error(j?.message || `HTTP ${res.status}`)
    }
    const j = await res.json().catch(()=>null)
    const url = execution ? deepCleaningExecutionUploadReference(j) : String(j?.url || '')
    if (!url) throw new Error('upload failed')
    const previousPreview = localUploadPreviewUrls.current.get(url)
    if (previousPreview) URL.revokeObjectURL(previousPreview)
    localUploadPreviewUrls.current.set(url, URL.createObjectURL(file))
    return url
  }

  const makeUploadProps = (setFiles: (v: UploadFile[])=>void, execution = false, context?: DeepCleaningRecord | null): UploadProps => ({
    multiple: true,
    accept: 'image/*,video/*',
    // Never replace file.url: save payloads retain the original stored reference.
    itemRender: (_origin, file, _files, actions) => <Space>
      <Button type="link" disabled={!file.url} onClick={() => { setMediaPreviewContext(context || null); setLocalPreviewVideo(!!file.type?.startsWith('video/')); setMediaPreview(file.originFileObj ? localUploadPreviewUrls.current.get(file.url || '') || null : file.url || null) }}>{file.name}</Button>
      {file.status === 'uploading' ? <span>上传中 {Math.round(file.percent || 0)}%</span> : null}
      {file.status === 'error' ? <span>上传失败</span> : null}
      <Button size="small" onClick={actions.remove}>删除</Button>
    </Space>,
    customRequest: async (options) => {
      const { file, onSuccess, onError } = options as any
      try {
        const url = await uploadFile(file as File, execution)
        onSuccess?.({ url }, file)
      } catch (e: any) {
        onError?.(e)
      }
    },
    onChange: (info) => {
      const next = (info.fileList || []).map(f => {
        const r: any = (f as any).response
        if (r?.url) return { ...f, url: r.url, status: 'done' as any }
        return f
      })
      setFiles(next)
    },
  })

  async function loadProps() {
    try {
      const ps = await getJSON<any[]>('/properties').catch(()=>[])
      setProps(Array.isArray(ps) ? ps : [])
    } catch { setProps([]) }
  }
  async function loadUsers() {
    try {
      const users = await getJSON<any[]>('/rbac/users').catch(()=>[])
      const opts = (Array.isArray(users) ? users : []).map(u => ({ value: String(u?.id || ''), label: String(u?.display_name || u?.username || u?.name || u?.id || '') })).filter(x => x.value && x.label)
      setUserOptions(opts)
    } catch { setUserOptions([]) }
  }
  async function loadList(reset = false) {
    if (reset && page !== 1) { setPage(1); return }
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setLoading(true)
    setListError('')
    try {
      const params: Record<string, string> = {
        withTotal: '1', limit: String(pageSize),
        offset: String(Math.max(0, ((reset ? 1 : page) - 1) * pageSize)),
      }
      if (filterPropertyId) params.property_id = filterPropertyId
      if (filterStatus) params.status = filterStatus
      if (filterCat) params.area = filterCat
      if (filterPayMethod) params.pay_method = filterPayMethod
      if (dateRange?.[0]) params.record_date_from = deepCleaningDateBound(dateRange[0])
      if (dateRange?.[1]) params.record_date_to = deepCleaningDateBound(dateRange[1], true)
      const res = await fetch(`${API_BASE}/crud/property_deep_cleaning?${new URLSearchParams(params)}`, { cache: 'no-store', headers: authHeaders(), signal: controller.signal })
      if (controller.signal.aborted) return
      if (res.status === 401) { window.location.href = '/login'; return }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      if (controller.signal.aborted) return
      if (!Array.isArray(data)) throw new Error('invalid_list_response')
      const tot = Number(res.headers.get('x-total-count') || 0)
      const nextTotal = Number.isFinite(tot) && tot >= 0 ? tot : 0
      setTotal(nextTotal)
      const lastPage = Math.max(1, Math.ceil(nextTotal / pageSize))
      if (page > lastPage) { setPage(lastPage); return }
      setList(data)
    } catch {
      if (controller.signal.aborted) return
      setList([]); setTotal(0)
      setListError('记录加载失败，请重试。')
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }

  useEffect(() => { loadProps(); loadUsers() }, [])
  useEffect(() => {
    const t = setTimeout(() => { void loadList() }, 150)
    return () => { clearTimeout(t); abortRef.current?.abort() }
  }, [filterPropertyId, filterStatus, filterCat, filterPayMethod, dateRange, pageSize, page])

  const rows = useMemo(() => {
    const byId: Record<string, any> = Object.fromEntries((props || []).map(p => [String(p.id), p]))
    return (list || []).map(r => {
      const p = byId[String(r.property_id || '')]
      const code = p?.code || r.code || r.property_code || r.property_id || ''
      return { ...r, code }
    })
  }, [list, props])

  function openCreate() {
    createForm.resetFields()
    setCreateBeforeFiles([])
    setCreateAttachFiles([])
    createForm.setFieldsValue({
      status: 'pending',
      urgency: 'normal',
      occurred_at: dayjs(),
      checklist: [{ item: '全屋表面除尘', done: false }, { item: '厨房油污清洁', done: false }, { item: '浴室除垢消毒', done: false }],
      consumables: [],
    })
    setCreateOpen(true)
  }

  async function createSubmit() {
    if (savingCreate) return
    setSavingCreate(true)
    try {
      const v = await createForm.validateFields()
      if ([...createBeforeFiles, ...createAttachFiles].some(f => f.status === 'uploading' || f.status === 'error')) throw new Error('请等待材料上传成功后再保存')
      await apiCreate('property_deep_cleaning', {
        started_at: combineDateAndTimeToIso(dayjs(v.occurred_at), v.started_time),
        ended_at: combineDateAndTimeToIso(dayjs(v.occurred_at), v.ended_time),
        duration_minutes: v.duration_minutes ?? null,
        consumables: Array.isArray(v.consumables) ? v.consumables : [],
        property_id: v.property_id,
        occurred_at: dayjs(v.occurred_at).format('YYYY-MM-DD'),
        category: v.category, urgency: v.urgency || 'normal',
        submitter_name: String(v.submitter_name || '').trim(),
        details: String(v.details || ''), notes: String(v.notes || ''),
        invoice_description_en: String(v.invoice_description_en || ''),
        photo_urls: deepCleaningMediaReferences(createBeforeFiles.map(f => f.url || (f.response as any)?.url)),
        attachment_urls: deepCleaningMediaReferences(createAttachFiles.map(f => f.url || (f.response as any)?.url)),
        checklist: Array.isArray(v.checklist) ? v.checklist : [],
      })
      message.success('已新增，请在记录上选择派工')
      setCreateOpen(false)
      await loadList(true)
    } catch (e: any) { if (!e?.errorFields) message.error(e?.message || '新增失败') }
    finally { setSavingCreate(false) }
  }

  function openEdit(r: DeepCleaningRecord) {
    setEditing(r)
    const checklist = safeJsonParse(r.checklist) || []
    editForm.resetFields()
    editForm.setFieldsValue({
      urgency: r.urgency || 'normal',
      submitter_name: r.submitter_name || '',
      category: r.category || '',
      details: typeof r.details === 'string' ? r.details : (r.details ? JSON.stringify(r.details) : ''),
      invoice_description_en: r.invoice_description_en || '',
      notes: r.notes || '',
      repair_notes: r.repair_notes || '',
      checklist,
      started_time: r.started_at ? dayjs(r.started_at) : null,
      ended_time: r.ended_at ? dayjs(r.ended_at) : null,
      duration_minutes: r.duration_minutes ?? undefined,
      consumables: safeJsonParse(r.consumables) || [],
    })
    editSnapshotRef.current = JSON.stringify(editForm.getFieldsValue(true))
    setEditBeforeFiles(toUploadFileList(r.photo_urls))
    setEditAfterFiles(toUploadFileList(r.repair_photo_urls))
    setEditAttachFiles(toUploadFileList(r.attachment_urls))
  }

  async function saveEdit() {
    if (!editing || savingEdit || !canWrite) return
    setSavingEdit(true)
    try {
      const v = await editForm.validateFields()
      if ([...editBeforeFiles, ...editAfterFiles, ...editAttachFiles].some(f => f.status === 'uploading' || f.status === 'error')) throw new Error('请等待材料上传成功后再保存')
      await apiUpdate('property_deep_cleaning', String(editing.id), {
        started_at: combineDateAndTimeToIso(editing.occurred_at || editing.completed_at || dayjs(), v.started_time),
        ended_at: combineDateAndTimeToIso(editing.occurred_at || editing.completed_at || dayjs(), v.ended_time),
        duration_minutes: v.duration_minutes ?? null,
        consumables: Array.isArray(v.consumables) ? v.consumables : [],
        urgency: v.urgency, ...deepCleaningSubmitterEditPatch(editing.submitter_name, v.submitter_name),
        category: v.category || '', details: String(v.details || ''),
        invoice_description_en: String(v.invoice_description_en || ''), notes: String(v.notes || ''),
        repair_notes: String(v.repair_notes || ''),
        photo_urls: deepCleaningMediaReferences(editBeforeFiles.map(f => f.url || (f.response as any)?.url)),
        repair_photo_urls: deepCleaningMediaReferences(editAfterFiles.map(f => f.url || (f.response as any)?.url)),
        attachment_urls: deepCleaningMediaReferences(editAttachFiles.map(f => f.url || (f.response as any)?.url)),
        checklist: Array.isArray(v.checklist) ? v.checklist : [],
      })
      message.success('已保存')
      setEditing(null)
      await loadList(false)
    } catch (e: any) { if (!e?.errorFields) message.error(e?.message || '保存失败') }
    finally { setSavingEdit(false) }
  }

  async function openWorkflow(row: DeepCleaningRecord, action: 'assign' | 'review' | 'complete') {
    if (!deepCleaningCanAct(row, action)) return
    workflowForm.resetFields()
    setCompleteFiles(toUploadFileList(row.repair_photo_urls))
    setCompleteBeforeFiles([])
    workflowForm.setFieldsValue(action === 'assign' ? {
      assignee_id: row.assignee_id || undefined, scheduled_date: row.eta ? dayjs(row.eta) : null,
    } : {
      pricing_mode: row.pricing_mode === 'items' ? 'items' : 'total',
      total_amount: row.total_cost ?? undefined, price_items: row.price_items || [],
      pay_method: row.pay_method || undefined, gst_type: row.gst_type || undefined,
      review_notes: '', completion_note: row.repair_notes || '',
    })
    setWorkflow({ row, action, operationId: newDeepCleaningOperationId() })
    if (action === 'assign' || (action === 'review' && deepCleaningNeedsReviewAssignee(row))) {
      setExecutorOptions([]); setExecutorError('')
      try {
        const users = await getJSON<{ id: string; name: string }[]>('/deep-cleaning/executors')
        setExecutorOptions(users.map(u => ({ value: u.id, label: u.name })))
      } catch { setExecutorError('人员加载失败，请关闭后重试。') }
    }
  }

  function syncWorkflowRecord(incoming: DeepCleaningRecord) {
    setList(previous => previous.map(row => mergeDeepCleaningAuthoritativeRow(row, incoming)))
    setViewing(previous => previous ? mergeDeepCleaningAuthoritativeRow(previous, incoming) : null)
    if (editing && String(editing.id) === String(incoming.id)) {
      setEditing(previous => previous ? mergeDeepCleaningAuthoritativeRow(previous, incoming) : null)
      // Never reset the ordinary form here: action receipts update headers and
      // only untouched completion evidence, preserving any current local draft.
      if (JSON.stringify(deepCleaningMediaReferences(editBeforeFiles.map(file => file.url))) === JSON.stringify(deepCleaningMediaReferences(editing.photo_urls))) {
        setEditBeforeFiles(toUploadFileList(incoming.photo_urls ?? editing.photo_urls))
      }
      if (JSON.stringify(deepCleaningMediaReferences(editAfterFiles.map(file => file.url))) === JSON.stringify(deepCleaningMediaReferences(editing.repair_photo_urls))) {
        setEditAfterFiles(toUploadFileList(incoming.repair_photo_urls ?? editing.repair_photo_urls))
      }
      if (incoming.repair_notes !== undefined && editForm.getFieldValue('repair_notes') === (editing.repair_notes || '')) {
        editForm.setFieldValue('repair_notes', incoming.repair_notes)
        const original = JSON.parse(editSnapshotRef.current || '{}')
        editSnapshotRef.current = JSON.stringify({ ...original, repair_notes: incoming.repair_notes })
      }
    }
  }

  function openEditorWorkflow(action: 'assign' | 'review' | 'complete') {
    if (!editing) return
    const refs = (files: UploadFile[]) => deepCleaningMediaReferences(files.map(file => file.url || (file.response as any)?.url))
    const changed = JSON.stringify(editForm.getFieldsValue(true)) !== editSnapshotRef.current
      || JSON.stringify(refs(editBeforeFiles)) !== JSON.stringify(deepCleaningMediaReferences(editing.photo_urls))
      || JSON.stringify(refs(editAfterFiles)) !== JSON.stringify(deepCleaningMediaReferences(editing.repair_photo_urls))
      || JSON.stringify(refs(editAttachFiles)) !== JSON.stringify(deepCleaningMediaReferences(editing.attachment_urls))
      || [...editBeforeFiles, ...editAfterFiles, ...editAttachFiles].some(file => file.status === 'uploading' || file.status === 'error')
    if (changed) {
      modal.info({ title: '请先保存当前编辑', content: '未保存的内容仍保留在编辑抽屉。请先保存，或取消本次编辑，再进行派工、完成提交或审核。流程操作不会自动保存这些修改。' })
      return
    }
    void openWorkflow(editing, action)
  }

  async function submitWorkflow() {
    if (!workflow || savingWorkflow) return
    setSavingWorkflow(true)
    try {
      const v = await workflowForm.validateFields()
      if (workflow.action === 'complete' && [...completeFiles, ...completeBeforeFiles].some(f => f.status === 'uploading' || f.status === 'error')) throw new Error('请等待材料上传成功后再提交')
      const completionPhotos = deepCleaningMediaReferences(completeFiles.map(f => f.url || (f.response as any)?.url))
      if (workflow.action === 'complete' && !completionPhotos.length) throw new Error('请上传清洁后照片')
      const payload = workflow.action === 'complete' ? deepCleaningCompletionPayload(completionPhotos, completeBeforeFiles.map(f => f.url || (f.response as any)?.url), v.completion_note, workflow.operationId) : workflow.action === 'review' ? deepCleaningReviewPayload(v, workflow.operationId, workflow.row) : {
        assignee_id: v.assignee_id, scheduled_date: v.scheduled_date ? dayjs(v.scheduled_date).format('YYYY-MM-DD') : null,
        operation_id: workflow.operationId,
      }
      const res = await fetch(`${API_BASE}/deep-cleaning/records/${encodeURIComponent(workflow.row.id)}/workflow/${workflow.action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(payload),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.message || data?.error || `HTTP ${res.status}`)
      if (data && String(data.id || '') === String(workflow.row.id)) syncWorkflowRecord(data)
      message.success(workflow.action === 'review' ? '审核已通过' : workflow.action === 'complete' ? '已提交，等待管理员审核' : '已分配')
      setWorkflow(null)
      await loadList(false)
    } catch (e: any) { if (!e?.errorFields) message.error(e?.message || '操作失败，请重试') }
    finally { setSavingWorkflow(false) }
  }

  async function remove(id: string) {
    modal.confirm({
      title: '确认删除？',
      content: '删除后不可恢复',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await apiDelete('property_deep_cleaning', String(id))
          message.success('已删除')
          loadList(true)
        } catch (e: any) {
          message.error(e?.message || '删除失败')
        }
      }
    })
  }

  async function shareLink(r: DeepCleaningRecord) {
    try {
      const res = await fetch(`${API_BASE}/deep-cleaning/share-link/${r.id}`, { method: 'POST', headers: authHeaders() })
      const j = await res.json().catch(()=>null)
      if (!res.ok) throw new Error(j?.message || `HTTP ${res.status}`)
      const token = String(j?.token || '')
      if (!token) throw new Error('missing token')
      const origin = typeof window !== 'undefined' ? window.location.origin : ''
      const link = `${origin}/public/deep-cleaning-share/${token}`
      await navigator.clipboard?.writeText(link)
      message.success('已复制分享链接')
    } catch (e: any) {
      message.error(e?.message || '分享失败')
    }
  }

  const closePdfPreview = () => {
    setPdfPreview((prev) => {
      try { if (prev.url) URL.revokeObjectURL(prev.url) } catch {}
      return { open: false, url: '', title: '', showChinese: false, blob: null, row: null, loading: false }
    })
  }

  async function fetchPdfBlob(r: DeepCleaningRecord, showChinese: boolean) {
    if (!r?.id) return
    const out = await runWorkRecordPdfJob({
      createPath: `/deep-cleaning/pdf-jobs/${String(r.id)}`,
      statusPath: (jobId) => `/deep-cleaning/pdf-jobs/${encodeURIComponent(jobId)}`,
      downloadPath: (jobId) => `/deep-cleaning/pdf-jobs/${encodeURIComponent(jobId)}/download`,
      showChinese,
      onUpdate: (patch) => setPdfJobUi(prev => ({ ...prev, ...patch })),
    })
    return out.blob
  }

  async function openExportPdf(r: DeepCleaningRecord) {
    if (!r?.id) return
    setDownloadingId(String(r.id))
    try {
      setPdfJobUi({ open: true, stage: '创建任务', detail: '正在准备导出 PDF...', progress: 3, timeout: false })
      const blob = await fetchPdfBlob(r, false)
      if (!blob) return
      const url = URL.createObjectURL(blob)
      const workNo = String((r as any)?.work_no || (r as any)?.id || '').trim()
      const title = `Deep Cleaning${workNo ? ` - ${workNo}` : ''}`
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
      const filename = `deep-cleaning-${(workNo || String(r.id)).replace(/[^a-zA-Z0-9._-]+/g, '-')}${suffix}.pdf`
      downloadNamedBlob(blob, filename)
    } catch (e: any) {
      message.error(e?.message || '导出失败')
    } finally {
      setPdfJobUi(prev => ({ ...prev, open: false }))
      setPdfPreview(p => ({ ...p, loading: false }))
    }
  }

  const columns: any[] = [
    { title:'房号', dataIndex:'code', width: 120, ellipsis: true, fixed: 'left' as const },
    { title:'工单号', dataIndex:'work_no', width: 160, render: (_: any, r: any) => String((r as any)?.work_no || (r as any)?.id || '') },
    { title:'记录日期', dataIndex:'completed_at', width: 120, render: (_: any, r: any) => {
      const v = (r as any)?.completed_at || (r as any)?.occurred_at
      return deepCleaningDate(v)
    } },
    { title:'问题描述', width: 260, ellipsis: true, render: (_: any, r: DeepCleaningRecord) => deepCleaningSummary(r) || '-' },
    { title:'提交人员', dataIndex:'submitter_name', width: 160, ellipsis: true, render:(_v:string, r:DeepCleaningRecord)=> deepCleaningSubmitterDisplay(r) },
    { title:'执行人员', dataIndex:'worker_name', width: 180, ellipsis: true, render:(_:string, r: DeepCleaningRecord)=> deepCleaningExecutorLabel(r, userOptions) },
    { title:'提交时间', dataIndex:'submitted_at', width: 160, render:(v:string, r: any)=> deepCleaningDate(v || r.created_at, 'YYYY-MM-DD HH:mm') },
    { title:'总费用', dataIndex:'total_cost', width: 120, render: (_: any, r: any) => {
      const v = (r as any)?.total_cost
      const fallback = deepCleaningDisplayCost(r)
      return fmtAmount(v !== undefined && v !== null ? v : fallback)
    } },
    { title:'扣款方式', dataIndex:'pay_method', width: 140, render: (v: any) => payMethodLabel(v) },
    { title:'GST', dataIndex:'gst_type', width: 140, render: (v: any) => gstTypeLabel(v) },
    { title:'区域', width: 140, render: (_: any, r: DeepCleaningRecord) => deepCleaningAreas(r) || '-' },
    { title:'状态', dataIndex:'status', width: 120, render:(s:string, r: DeepCleaningRecord)=> statusTag(r.workflow_status || s) },
    { title:'审核', dataIndex:'review_status', width: 120, render:(s:string)=> reviewTag(s) },
    { title:'操作', width: 560, fixed: 'right' as const, render: (_:any, r:DeepCleaningRecord) => (
      <TableRowActions actions={[
        { key: 'detail', label: '详情', onClick: () => setViewing(r) },
        { key: 'edit', label: '编辑', onClick: () => openEdit(r), hidden: !canWrite },
        { key: 'assign', label: '派工', onClick: () => { void openWorkflow(r, 'assign') }, hidden: !deepCleaningCanAct(r, 'assign') },
        { key: 'complete', label: '提交待审核', onClick: () => { void openWorkflow(r, 'complete') }, hidden: !deepCleaningCanAct(r, 'complete') },
        { key: 'review', label: '审核', onClick: () => { void openWorkflow(r, 'review') }, hidden: !deepCleaningCanAct(r, 'review') },
        { key: 'share', label: '分享', onClick: () => { void shareLink(r) } },
        { key: 'export', label: '导出PDF', onClick: () => { void openExportPdf(r) }, loading: downloadingId === String(r.id), hidden: !canDownload },
        { key: 'delete', label: '删除', onClick: () => { void remove(String(r.id)) }, danger: true, hidden: !hasPerm('property_deep_cleaning.delete') },
      ]} />
    ) },
  ]

  return (
    <Space direction="vertical" style={{ width:'100%' }}>
      {process.env.NODE_ENV === 'development' && process.env.NEXT_PUBLIC_DEEP_CLEANING_PREVIEW === 'synthetic' ? <Alert type="info" showIcon message="开发预览：仅使用模拟记录与示例图片，不连接生产数据库；保存、上传、删除及导出已由预览服务禁用。" /> : null}
      <Card title="深度清洁记录" extra={
        <Button type="primary" onClick={openCreate} disabled={!canWrite}>新增深度清洁</Button>
      }>
        <Space style={{ width:'100%', marginBottom: 12 }} wrap>
          <Select
            placeholder="房号"
            allowClear
            options={propOptions}
            value={filterPropertyId}
            onChange={v=>{ setFilterPropertyId(v); setPage(1) }}
            style={{ width: isMobile ? '100%' : 180 }}
            showSearch
            optionFilterProp="label"
            filterOption={(input, option) => String((option as any)?.label ?? '').toLowerCase().includes(String(input || '').toLowerCase())}
          />
          <Select placeholder="状态" allowClear options={statusOptions} value={filterStatus} onChange={v=>{ setFilterStatus(v); setPage(1) }} style={{ width: isMobile ? '100%' : 160 }} />
          <Select placeholder="区域" allowClear options={catOptions} value={filterCat} onChange={v=>{ setFilterCat(v); setPage(1) }} style={{ width: isMobile ? '100%' : 160 }} />
          <Select
            placeholder="扣款方式"
            allowClear
            value={filterPayMethod}
            onChange={v => { setFilterPayMethod(v); setPage(1) }}
            style={{ width: isMobile ? '100%' : 180 }}
            options={[
              { value: 'rent_deduction', label: payMethodLabel('rent_deduction') },
              { value: 'tenant_pay', label: payMethodLabel('tenant_pay') },
              { value: 'company_pay', label: payMethodLabel('company_pay') },
              { value: 'landlord_pay', label: payMethodLabel('landlord_pay') },
              { value: 'other_pay', label: payMethodLabel('other_pay') },
            ]}
          />
          <DatePicker.RangePicker value={dateRange as any} placeholder={['记录开始日期', '记录结束日期']} onChange={v=>{ setDateRange(v as any); setPage(1) }} allowClear style={{ width: isMobile ? '100%' : undefined }} />
          <Button onClick={()=>{
            setFilterPropertyId(undefined); setFilterStatus(undefined); setFilterCat(undefined); setFilterPayMethod(undefined); setDateRange(null)
            setPage(1)

          }}>重置</Button>
        </Space>
        <Typography.Text type="secondary">记录日期：完成日期优先，未完成时为记录发生日期；按墨尔本时间显示，最新提交优先。</Typography.Text>
        {listError ? <Alert type="error" showIcon message={listError} action={<Button onClick={() => loadList()}>重试</Button>} /> : null}
        <div style={{ width:'100%', overflowX:'auto' }}>
          <Table
            rowKey={r=>String((r as any).id)}
            dataSource={rows}
            loading={loading}
            onRow={(record: any) => ({
              onClick: (e: any) => {
                const t = (e as any)?.target as any
                const hit = t?.closest?.('button,a,input,textarea,select,option,.ant-select,.ant-dropdown,.ant-checkbox-wrapper,.ant-popover,.ant-modal,.ant-drawer')
                if (hit) return
                setViewing(record as any)
              },
              style: { cursor: 'pointer' },
            })}
            pagination={{
              current: page,
              pageSize,
              total,
              showSizeChanger: true,
              onChange: (p, ps) => { setPage(ps !== pageSize ? 1 : p); setPageSize(ps) }
            }}
            scroll={{ x: 2060 }}
            columns={columns as any}
          />
        </div>
      </Card>

      <Modal open={!!mediaPreview} onCancel={() => setMediaPreview(null)} footer={null} title="材料预览" destroyOnClose>
        {mediaPreview?.startsWith("blob:") ? (localPreviewVideo ? <video src={mediaPreview} controls style={{ width: "100%", maxHeight: 480, objectFit: "contain" }} /> : <Image src={mediaPreview} alt="待提交材料本地预览" style={{ maxHeight: 480, objectFit: "contain" }} />) : mediaPreview ? <DeepCleaningMedia references={[mediaPreview]} context={mediaPreviewContext} /> : null}
      </Modal>
      <Modal open={createOpen} onCancel={()=>{ if (!savingCreate) setCreateOpen(false) }} onOk={createSubmit} confirmLoading={savingCreate} maskClosable={!savingCreate} closable={!savingCreate} title="新增深度清洁" okText="保存" width={isMobile ? '100%' : 780}>
        <Form form={createForm} layout="vertical" disabled={savingCreate}>
          <div style={{ display:'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 12 }}>
            <Form.Item name="property_id" label="房号" rules={[{ required: true, message:'请选择房号' }]}>
              <Select options={propOptions} showSearch optionFilterProp="label" />
            </Form.Item>
            <Form.Item name="occurred_at" label="清洁日期" rules={[{ required: true, message:'请选择日期' }]}>
              <DatePicker style={{ width:'100%' }} />
            </Form.Item>
            <Form.Item name="category" label="区域" rules={[{ required: true, message:'请选择区域' }]}>
              <Select options={catOptions} />
            </Form.Item>
            <Form.Item name="submitter_name" label="提交人员" extra="记录提交者，不是任务执行人员；保存记录后，通过派工指定执行人员。">
              <Select allowClear showSearch optionFilterProp="label" options={submitterOptions} placeholder="未记录（可选择提交人员）" />
            </Form.Item>
            <Form.Item name="urgency" label="紧急程度">
              <Select options={urgencyOptions} />
            </Form.Item>
          </div>
          <Form.Item name="details" label="清洁摘要（可写清洁重点）">
            <Input.TextArea rows={3} placeholder="例如：厨房重油污、浴室除垢、全屋消毒" />
          </Form.Item>
          <Form.Item name="invoice_description_en" label="开票英文描述">
            <Input.TextArea rows={3} placeholder="Optional English description for invoices" />
          </Form.Item>
          <Form.Item name="checklist" label="清洁项目清单">
            <Form.List name="checklist">
              {(fields, { add, remove }) => (
                <Space direction="vertical" style={{ width:'100%' }}>
                  {fields.map(f => (
                    <div key={f.key} style={{ display:'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 110px 1fr 60px', gap: 8, alignItems:'center' }}>
                      <Form.Item name={[f.name, 'item']} rules={[{ required: true, message:'请输入项目' }]} style={{ marginBottom: 0 }}>
                        <Input placeholder="项目" />
                      </Form.Item>
                      <Form.Item name={[f.name, 'done']} style={{ marginBottom: 0 }}>
                        <Select options={[{ value: true, label: '完成' }, { value: false, label: '未完成' }]} />
                      </Form.Item>
                      <Form.Item name={[f.name, 'note']} style={{ marginBottom: 0 }}>
                        <Input placeholder="备注" />
                      </Form.Item>
                      <Button onClick={() => remove(f.name)}>删除</Button>
                    </div>
                  ))}
                  <Button onClick={() => add({ item: '', done: false })}>新增项目</Button>
                </Space>
              )}
            </Form.List>
          </Form.Item>
          <Form.Item label="清洁前材料（图片/视频）">
            <Upload {...makeUploadProps(setCreateBeforeFiles)} fileList={createBeforeFiles} listType="picture">
              <Button>上传</Button>
            </Upload>
          </Form.Item>
          <Form.Item label="附件（图片/视频）">
            <Upload {...makeUploadProps(setCreateAttachFiles)} fileList={createAttachFiles}>
              <Button>上传</Button>
            </Upload>
          </Form.Item>
          <Form.Item name="notes" label="备注">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Card size="small" title="清洁时间（可选，不影响固定价格）" style={{ marginBottom: 12 }}>
            <div style={{ display:'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 12 }}>
              <Form.Item name="started_time" label="开始时间">
                <TimePicker
                  format="HH:mm"
                  style={{ width:'100%' }}
                  minuteStep={5}
                  onChange={(t) => {
                    const end = createForm.getFieldValue('ended_time')
                    const dur = createForm.getFieldValue('duration_minutes')
                    if (t && end) {
                      createForm.setFieldsValue({ duration_minutes: Math.max(0, dayjs(end).diff(dayjs(t), 'minute')) })
                      return
                    }
                    if (t && dur !== undefined && dur !== null) {
                      const nn = Number(dur)
                      if (Number.isFinite(nn)) createForm.setFieldsValue({ ended_time: dayjs(t).add(nn, 'minute') })
                    }
                  }}
                />
              </Form.Item>
              <Form.Item name="ended_time" label="结束时间">
                <TimePicker
                  format="HH:mm"
                  style={{ width:'100%' }}
                  minuteStep={5}
                  onChange={(t) => {
                    const start = createForm.getFieldValue('started_time')
                    if (start && t) {
                      createForm.setFieldsValue({ duration_minutes: Math.max(0, dayjs(t).diff(dayjs(start), 'minute')) })
                    }
                  }}
                />
              </Form.Item>
              <Form.Item name="duration_minutes" label="清洁时长（分钟）">
                <InputNumber min={0} style={{ width:'100%' }} onChange={(n) => {
                  const start = createForm.getFieldValue('started_time')
                  if (start && n !== undefined && n !== null) {
                    const nn = Number(n)
                    if (Number.isFinite(nn)) createForm.setFieldsValue({ ended_time: dayjs(start).add(nn, 'minute') })
                  }
                }} />
              </Form.Item>
              <Form.Item label="时长预览">
                <Form.Item noStyle shouldUpdate={(p, c) => p.started_time !== c.started_time || p.ended_time !== c.ended_time || p.duration_minutes !== c.duration_minutes}>
                  {() => {
                    const start = createForm.getFieldValue('started_time')
                    const end = createForm.getFieldValue('ended_time')
                    if (start && end) return <span>{fmtMinutes(dayjs(end).diff(dayjs(start), 'minute'))}</span>
                    const dur = createForm.getFieldValue('duration_minutes')
                    return <span>{fmtMinutes(dur)}</span>
                  }}
                </Form.Item>
              </Form.Item>
            </div>
          </Card>
          <Card size="small" title="耗材记录（可选）" style={{ marginBottom: 12 }}>
            <Form.Item name="consumables" label="耗材记录">
              <Form.List name="consumables">
                {(fields, { add, remove }) => (
                  <Space direction="vertical" style={{ width:'100%' }}>
                    {fields.map(f => (
                      <div key={f.key} style={{ display:'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 120px 120px 120px 60px', gap: 8, alignItems:'center' }}>
                        <Form.Item name={[f.name, 'name']} rules={[{ required: true, message:'名称必填' }]} style={{ marginBottom: 0 }}>
                          <Input placeholder="耗材名称" />
                        </Form.Item>
                        <Form.Item name={[f.name, 'qty']} style={{ marginBottom: 0 }}>
                          <InputNumber min={0} style={{ width:'100%' }} placeholder="数量" />
                        </Form.Item>
                        <Form.Item name={[f.name, 'unit']} style={{ marginBottom: 0 }}>
                          <Input placeholder="单位" />
                        </Form.Item>
                        <Form.Item name={[f.name, 'cost']} style={{ marginBottom: 0 }}>
                          <InputNumber min={0} style={{ width:'100%' }} placeholder="金额" />
                        </Form.Item>
                        <Button onClick={() => remove(f.name)}>删除</Button>
                      </div>
                    ))}
                    <Button onClick={() => add({ name: '', qty: 1 })}>新增耗材</Button>
                  </Space>
                )}
              </Form.List>
            </Form.Item>
          </Card>
          <Alert type="info" message="创建后选择真实人员派工；价格与扣款方式由管理员在完成审核时确认。固定价无需填写工时。" />
        </Form>
      </Modal>

      <Drawer
        open={!!editing}
        destroyOnClose
        onClose={() => { if (!savingEdit) setEditing(null) }}
        closable={!savingEdit}
        maskClosable={!savingEdit}
        title="编辑深度清洁"
        width={isMobile ? '100%' : 860}
        footer={
          <div style={{ textAlign:'right' }}>
            <Space>
              <Button onClick={() => setEditing(null)} disabled={savingEdit}>取消</Button>
              <Button type="primary" onClick={saveEdit} loading={savingEdit} disabled={!canWrite || savingEdit}>保存</Button>
            </Space>
          </div>
        }
      >
        <Form form={editForm} layout="vertical" disabled={savingEdit}>
          <Descriptions size="small" column={2}><Descriptions.Item label="状态">{statusTag(editing?.workflow_status || editing?.status)}</Descriptions.Item><Descriptions.Item label="执行人员">{deepCleaningExecutorLabel(editing || {}, userOptions)}</Descriptions.Item></Descriptions>
          <Alert type="info" showIcon style={{ marginBottom: 12 }} message="状态由派工、提交待审核、管理员审核依次变更，不直接修改状态。执行人员与下方提交人员是不同字段。" />
          {editing ? <Space wrap style={{ marginBottom: 16 }}>
            {deepCleaningCanAct(editing, 'assign') ? <Button onClick={() => openEditorWorkflow('assign')}>{editing.assignee_id ? '改派执行人员' : '派工'}</Button> : null}
            {deepCleaningCanAct(editing, 'complete') ? <Button onClick={() => openEditorWorkflow('complete')}>提交待审核</Button> : null}
            {deepCleaningCanAct(editing, 'review') ? <Button onClick={() => openEditorWorkflow('review')}>管理员审核</Button> : null}
          </Space> : null}
          <div style={{ display:'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 12 }}>
            <Form.Item name="urgency" label="紧急程度">
              <Select options={urgencyOptions} />
            </Form.Item>
            <Form.Item name="submitter_name" label="提交人员" extra={editing?.submitter_name?.trim() ? "记录提交者，不是任务执行人员。" : deepCleaningSubmitterDisplay(editing) === "未记录" ? "提交人员未记录；不会用执行人员代替。可手动选择，不选择则保持原记录。" : `当前显示：${deepCleaningSubmitterDisplay(editing)}（经核验的创建账号）；此显示不会自动写入提交人员字段。`}>
              <Select allowClear showSearch optionFilterProp="label" options={submitterOptions} placeholder="未记录（可选择提交人员）" />
            </Form.Item>
            <Form.Item name="category" label="区域" extra={!editing?.category && editing && deepCleaningAreas(editing) ? `原反馈区域：${deepCleaningAreas(editing)}；此处保留原执行区域设置。` : undefined}>
              <Select options={catOptions} />
            </Form.Item>
          </div>
          <Form.Item name="details" label="清洁摘要">
            <Input.TextArea rows={3} />
          </Form.Item>
          <Form.Item name="invoice_description_en" label="开票英文描述">
            <Input.TextArea rows={3} placeholder="Optional English description for invoices" />
          </Form.Item>
          <Form.Item name="notes" label="备注">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Form.Item name="checklist" label="清洁项目清单">
            <Form.List name="checklist">
              {(fields, { add, remove }) => (
                <Space direction="vertical" style={{ width:'100%' }}>
                  {fields.map(f => (
                    <div key={f.key} style={{ display:'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 110px 1fr 60px', gap: 8, alignItems:'center' }}>
                      <Form.Item name={[f.name, 'item']} rules={[{ required: true, message:'请输入项目' }]} style={{ marginBottom: 0 }}>
                        <Input placeholder="项目" />
                      </Form.Item>
                      <Form.Item name={[f.name, 'done']} style={{ marginBottom: 0 }}>
                        <Select options={[{ value: true, label: '完成' }, { value: false, label: '未完成' }]} />
                      </Form.Item>
                      <Form.Item name={[f.name, 'note']} style={{ marginBottom: 0 }}>
                        <Input placeholder="备注" />
                      </Form.Item>
                      <Button onClick={() => remove(f.name)}>删除</Button>
                    </div>
                  ))}
                  <Button onClick={() => add({ item: '', done: false })}>新增项目</Button>
                </Space>
              )}
            </Form.List>
          </Form.Item>
          <Card size="small" title="材料上传" style={{ marginBottom: 12 }}>
            <Space direction="vertical" style={{ width:'100%' }}>
              <div>
                <div style={{ marginBottom: 6, fontWeight: 600 }}>清洁前（图片/视频）</div>
                {editing ? <DeepCleaningMedia context={editing} references={editBeforeFiles.filter(file => !file.originFileObj).map(file => file.url).filter(Boolean)} /> : null}
                <Upload {...makeUploadProps(setEditBeforeFiles, false, editing)} fileList={editBeforeFiles}>
                  <Button>上传</Button>
                </Upload>
              </div>
              <div>
                <div style={{ marginBottom: 6, fontWeight: 600 }}>清洁后（图片/视频）</div>
                {editing ? <DeepCleaningMedia context={editing} references={editAfterFiles.filter(file => !file.originFileObj).map(file => file.url).filter(Boolean)} /> : null}
                <Upload {...makeUploadProps(setEditAfterFiles, false, editing)} fileList={editAfterFiles}><Button>上传</Button></Upload>
                <Typography.Text type="secondary">此处仅保存照片，不会自动提交完成或通过审核。</Typography.Text>
              </div>
              <div>
                <div style={{ marginBottom: 6, fontWeight: 600 }}>附件</div>
                {editing ? <DeepCleaningMedia context={editing} references={deepCleaningVisibleAttachments(editAttachFiles.filter(file => !file.originFileObj).map(file => file.url), editBeforeFiles.map(file => file.url), editAfterFiles.map(file => file.url))} /> : null}
                <Upload {...makeUploadProps(setEditAttachFiles, false, editing)} fileList={editAttachFiles} itemRender={(node, file, files, actions) => deepCleaningVisibleAttachments([file.url], editBeforeFiles.map(f => f.url), editAfterFiles.map(f => f.url)).length || !file.url ? makeUploadProps(setEditAttachFiles, false, editing).itemRender?.(node, file, files, actions) : null}>
                  <Button>上传</Button>
                </Upload>
              </div>
            </Space>
          </Card>
          <Form.Item name="repair_notes" label="执行说明"><Input.TextArea rows={3} /></Form.Item>
          <Card size="small" title="清洁时间（可选，不影响固定价格）" style={{ marginBottom: 12 }}>
            <div style={{ display:'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 12 }}>
              <Form.Item name="started_time" label="开始时间">
                <TimePicker
                  format="HH:mm"
                  style={{ width:'100%' }}
                  minuteStep={5}
                  onChange={(t) => {
                    const end = editForm.getFieldValue('ended_time')
                    const dur = editForm.getFieldValue('duration_minutes')
                    if (t && end) {
                      editForm.setFieldsValue({ duration_minutes: Math.max(0, dayjs(end).diff(dayjs(t), 'minute')) })
                      return
                    }
                    if (t && dur !== undefined && dur !== null) {
                      const nn = Number(dur)
                      if (Number.isFinite(nn)) editForm.setFieldsValue({ ended_time: dayjs(t).add(nn, 'minute') })
                    }
                  }}
                />
              </Form.Item>
              <Form.Item name="ended_time" label="结束时间">
                <TimePicker
                  format="HH:mm"
                  style={{ width:'100%' }}
                  minuteStep={5}
                  onChange={(t) => {
                    const start = editForm.getFieldValue('started_time')
                    if (start && t) {
                      editForm.setFieldsValue({ duration_minutes: Math.max(0, dayjs(t).diff(dayjs(start), 'minute')) })
                    }
                  }}
                />
              </Form.Item>
              <Form.Item name="duration_minutes" label="清洁时长（分钟）">
                <InputNumber min={0} style={{ width:'100%' }} onChange={(n) => {
                  const start = editForm.getFieldValue('started_time')
                  if (start && n !== undefined && n !== null) {
                    const nn = Number(n)
                    if (Number.isFinite(nn)) editForm.setFieldsValue({ ended_time: dayjs(start).add(nn, 'minute') })
                  }
                }} />
              </Form.Item>
              <Form.Item label="时长预览">
                <Form.Item noStyle shouldUpdate={(p, c) => p.started_time !== c.started_time || p.ended_time !== c.ended_time || p.duration_minutes !== c.duration_minutes}>
                  {() => {
                    const start = editForm.getFieldValue('started_time')
                    const end = editForm.getFieldValue('ended_time')
                    if (start && end) return <span>{fmtMinutes(dayjs(end).diff(dayjs(start), 'minute'))}</span>
                    const dur = editForm.getFieldValue('duration_minutes')
                    return <span>{fmtMinutes(dur)}</span>
                  }}
                </Form.Item>
              </Form.Item>
            </div>
          </Card>
          <Card size="small" title="耗材记录（可选）" style={{ marginBottom: 12 }}>
            <Form.Item name="consumables" label="耗材记录">
              <Form.List name="consumables">
                {(fields, { add, remove }) => (
                  <Space direction="vertical" style={{ width:'100%' }}>
                    {fields.map(f => (
                      <div key={f.key} style={{ display:'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 120px 120px 120px 60px', gap: 8, alignItems:'center' }}>
                        <Form.Item name={[f.name, 'name']} rules={[{ required: true, message:'名称必填' }]} style={{ marginBottom: 0 }}>
                          <Input placeholder="耗材名称" />
                        </Form.Item>
                        <Form.Item name={[f.name, 'qty']} style={{ marginBottom: 0 }}>
                          <InputNumber min={0} style={{ width:'100%' }} placeholder="数量" />
                        </Form.Item>
                        <Form.Item name={[f.name, 'unit']} style={{ marginBottom: 0 }}>
                          <Input placeholder="单位" />
                        </Form.Item>
                        <Form.Item name={[f.name, 'cost']} style={{ marginBottom: 0 }}>
                          <InputNumber min={0} style={{ width:'100%' }} placeholder="金额" />
                        </Form.Item>
                        <Button onClick={() => remove(f.name)}>删除</Button>
                      </div>
                    ))}
                    <Button onClick={() => add({ name: '', qty: 1 })}>新增耗材</Button>
                  </Space>
                )}
              </Form.List>
            </Form.Item>
          </Card>
          <Alert type="info" message="派工、完成提交与审核由独立操作处理。此处不修改审核金额、扣款方式。工时、耗材仅记录，不会重新计算审核总价。" />
          <Descriptions size="small" column={2} style={{ marginTop: 12 }}>
            <Descriptions.Item label="已记录时长">{fmtMinutes(editing?.duration_minutes)}</Descriptions.Item>
            <Descriptions.Item label="已记录总费用">{fmtAmount(deepCleaningDisplayCost(editing || {}))}</Descriptions.Item>
            <Descriptions.Item label="扣款方式">{payMethodLabel(editing?.pay_method)}</Descriptions.Item>
          </Descriptions>
        </Form>
      </Drawer>

      <Drawer open={!!workflow} destroyOnClose title={workflow?.action === 'assign' ? '分配深度清洁执行人员' : workflow?.action === 'complete' ? '提交深度清洁完成材料' : '管理员审核深度清洁'} width={isMobile ? '100%' : 640}
        onClose={() => { if (!savingWorkflow) setWorkflow(null) }} closable={!savingWorkflow} maskClosable={!savingWorkflow}
        footer={<Space style={{ display: 'flex', justifyContent: 'flex-end' }}><Button disabled={savingWorkflow} onClick={() => setWorkflow(null)}>取消</Button><Button type="primary" loading={savingWorkflow} onClick={submitWorkflow} disabled={savingWorkflow || (workflow?.action === 'assign' && !executorOptions.length)}>{workflow?.action === 'assign' ? '确认派工' : workflow?.action === 'complete' ? '提交待审核' : '确认金额并通过审核'}</Button></Space>}>
        <Form form={workflowForm} layout="vertical" disabled={savingWorkflow}>
          {workflow?.action === 'assign' ? <>
            <Alert type="info" message="分配给系统中的真实人员，无需填写价格。" style={{ marginBottom: 16 }} />
            {executorError ? <Alert type="error" message={executorError} /> : null}
            <Form.Item name="assignee_id" label="执行人员" rules={[{ required: true, message: '请选择执行人员' }]}><Select showSearch optionFilterProp="label" options={executorOptions} placeholder="选择人员" /></Form.Item>
            <Form.Item name="scheduled_date" label="预计完成日期"><DatePicker style={{ width: '100%' }} /></Form.Item>
          </> : workflow?.action === 'complete' ? <>
            <Alert type="info" message="提交后进入待审核，无需填写价格。" style={{ marginBottom: 16 }} />
            <Divider orientation="left">清洁前照片</Divider><DeepCleaningMedia context={workflow?.row} references={workflow.row.photo_urls} />
            <Typography.Paragraph type="secondary">已有清洁前照片保留不变；新上传材料可点击文件名本地预览，提交成功后才关联记录并进入待审核。</Typography.Paragraph>
            <Upload {...makeUploadProps(setCompleteBeforeFiles, true, workflow.row)} fileList={completeBeforeFiles}><Button>补传清洁前照片</Button></Upload>
            <Divider orientation="left">清洁后照片</Divider><DeepCleaningMedia context={workflow?.row} references={completeFiles.filter(file => !file.originFileObj).map(file => file.url).filter(Boolean)} />
            <Upload {...makeUploadProps(setCompleteFiles, true, workflow.row)} fileList={completeFiles}><Button>上传清洁后照片</Button></Upload>
            <Form.Item name="completion_note" label="执行说明"><Input.TextArea rows={3} /></Form.Item>
          </> : <>
            <Divider orientation="left">清洁前照片</Divider><DeepCleaningMedia context={workflow?.row} references={workflow?.row.photo_urls} />
            <Divider orientation="left">清洁后照片</Divider><DeepCleaningMedia context={workflow?.row} references={workflow?.row.repair_photo_urls} />
            <Descriptions size="small"><Descriptions.Item label="执行说明">{workflow?.row.repair_notes || '-'}</Descriptions.Item></Descriptions>
            <Alert type="info" message="确认的是整单最终费用，已包含耗材，不会再次叠加。固定价格无需填写工时。本次不进入人员结算。" style={{ marginBottom: 16 }} />
            {workflow && deepCleaningNeedsReviewAssignee(workflow.row) ? <>
              <Alert type="warning" message="这条历史记录尚未关联真实执行人。请选择人员，随本次审核一起确认；不会自动按旧姓名匹配。" style={{ marginBottom: 16 }} />
              {executorError ? <Alert type="error" message={executorError} /> : null}
              <Form.Item name="assignee_id" label="实际执行人" rules={[{ required: true, message: '请选择实际执行人' }]}><Select showSearch optionFilterProp="label" options={executorOptions} placeholder="请选择实际执行人，不会自动匹配" /></Form.Item>
            </> : null}
            <Form.Item name="pricing_mode" label="定价方式" rules={[{ required: true }]}><Select options={[{ value: 'total', label: '整单总价' }, { value: 'items', label: '分项目价格' }]} /></Form.Item>
            <Form.Item noStyle shouldUpdate={(p, c) => p.pricing_mode !== c.pricing_mode}>
              {() => workflowForm.getFieldValue('pricing_mode') === 'items' ? <Form.List name="price_items">
                {(fields, { add, remove }) => <Space direction="vertical" style={{ width: '100%', marginBottom: 16 }}>
                  {fields.map(f => <div key={f.key} style={{ display: 'grid', gridTemplateColumns: '1fr 130px 60px', gap: 8 }}>
                    <Form.Item name={[f.name, 'id']} hidden><Input /></Form.Item>
                    <Form.Item name={[f.name, 'description']} rules={[{ required: true, whitespace: true, message: '请输入项目' }]}><Input placeholder="项目" /></Form.Item>
                    <Form.Item name={[f.name, 'amount']} rules={[{ required: true, message: '请输入金额' }]}><InputNumber min={0} precision={2} style={{ width: '100%' }} placeholder="金额" /></Form.Item>
                    <Button onClick={() => remove(f.name)}>删除</Button>
                  </div>)}
                  <Button onClick={() => add({ id: newDeepCleaningOperationId(), description: '' })}>新增价格项目</Button>
                  <Form.Item noStyle shouldUpdate>{() => <Typography.Text>合计：{fmtAmount((workflowForm.getFieldValue('price_items') || []).reduce((sum: number, item: any) => sum + (Number(item?.amount) || 0), 0))}</Typography.Text>}</Form.Item>
                </Space>}
              </Form.List> : <Form.Item name="total_amount" label="整单总价（AUD）" rules={[{ required: true, message: '请确认整单金额，零费用请填 0' }]}><InputNumber min={0} precision={2} style={{ width: '100%' }} /></Form.Item>}
            </Form.Item>
            <Form.Item name="pay_method" label="扣款方式" rules={[{ required: true, message: '请选择扣款方式' }]}><Select options={payMethodOptions} /></Form.Item>
            <Form.Item name="gst_type" label="GST" rules={[{ required: true, message: '请选择 GST' }]}><Select options={gstTypeOptions} /></Form.Item>
            <Form.Item name="review_notes" label="审核备注"><Input.TextArea rows={3} /></Form.Item>
          </>}
        </Form>
      </Drawer>

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
        open={!!viewing}
        destroyOnClose
        onClose={()=>setViewing(null)}
        placement="right"
        width={isMobile ? 420 : 780}
        footer={
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button onClick={() => setViewing(null)}>关闭</Button>
            {viewing && canWrite ? <Button type="primary" onClick={() => { const v = viewing; setViewing(null); openEdit(v) }}>编辑记录</Button> : null}
          </div>
        }
      >
        {viewing ? (
          <>
            <Descriptions title="基本信息" bordered column={2} labelStyle={{ width: '120px' }}>
              <Descriptions.Item label="工单号">{String(viewing?.work_no || viewing?.id || '-')}</Descriptions.Item>
              <Descriptions.Item label="状态">{statusTag(viewing?.workflow_status || viewing?.status)}</Descriptions.Item>
              <Descriptions.Item label="房号">{String(viewing?.code || viewing?.property_code || viewing?.property_id || '-')}</Descriptions.Item>
              <Descriptions.Item label="区域">{deepCleaningAreas(viewing) || '-'}</Descriptions.Item>
              <Descriptions.Item label="记录日期">{deepCleaningDate(viewing.completed_at || viewing.occurred_at)}</Descriptions.Item>
              <Descriptions.Item label="执行人员">{deepCleaningExecutorLabel(viewing || {}, userOptions)}</Descriptions.Item>
              <Descriptions.Item label="提交人员">{deepCleaningSubmitterDisplay(viewing)}</Descriptions.Item>
              <Descriptions.Item label="完成时间">{deepCleaningDate(viewing.completed_at, 'YYYY-MM-DD HH:mm')}</Descriptions.Item>
              <Descriptions.Item label="提交时间">{deepCleaningDate(viewing.submitted_at || viewing.created_at, 'YYYY-MM-DD HH:mm')}</Descriptions.Item>
              <Descriptions.Item label="总费用">{fmtAmount(deepCleaningDisplayCost(viewing))}</Descriptions.Item>
              <Descriptions.Item label="扣款方式">{payMethodLabel((viewing as any)?.pay_method)}</Descriptions.Item>
              <Descriptions.Item label="GST">{gstTypeLabel((viewing as any)?.gst_type)}</Descriptions.Item>
            </Descriptions>

            {viewing.pricing_mode === 'items' && viewing.price_items?.length ? <><Divider orientation="left">审核价格项目</Divider><Table size="small" pagination={false} rowKey="id" dataSource={viewing.price_items} columns={[{ title: '项目', dataIndex: 'description' }, { title: '金额', dataIndex: 'amount', render: fmtAmount }]} /></> : null}
            <Divider orientation="left">清洁项目</Divider>
            <Descriptions bordered column={2} labelStyle={{ width: '120px' }}>
            <Descriptions.Item label="项目描述" span={2} style={{ whiteSpace: 'pre-wrap' }}>
                {String(viewing?.project_desc || '-')}
              </Descriptions.Item>
              <Descriptions.Item label="问题描述" span={2} style={{ whiteSpace: 'pre-wrap' }}>{deepCleaningDetails(viewing.details) || '-'}</Descriptions.Item>
              <Descriptions.Item label="开票英文描述" span={2} style={{ whiteSpace: 'pre-wrap' }}>
                {String(viewing?.invoice_description_en || '-')}
              </Descriptions.Item>
              <Descriptions.Item label="开始时间">{deepCleaningDate(viewing.started_at, 'HH:mm')}</Descriptions.Item>
              <Descriptions.Item label="结束时间">{deepCleaningDate(viewing.ended_at, 'HH:mm')}</Descriptions.Item>
              <Descriptions.Item label="清洁时长">{fmtMinutes(viewing?.duration_minutes)}</Descriptions.Item>
              <Descriptions.Item label="审核">{reviewTag(viewing?.review_status)}</Descriptions.Item>
              <Descriptions.Item label="备注" span={2} style={{ whiteSpace: 'pre-wrap' }}>{String(viewing?.notes || '-')}</Descriptions.Item>
            </Descriptions>

            <Divider orientation="left">清洁前照片</Divider>
            <Descriptions bordered column={1} labelStyle={{ width: '120px' }}>
              <Descriptions.Item label="照片">
                <DeepCleaningMedia context={viewing} references={viewing.photo_urls} />
              </Descriptions.Item>
            </Descriptions>

            <Divider orientation="left">清洁后照片</Divider>
            <Descriptions bordered column={1} labelStyle={{ width: '120px' }}>
              <Descriptions.Item label="照片">
                <DeepCleaningMedia context={viewing} references={viewing.repair_photo_urls} />
              </Descriptions.Item>
            </Descriptions>

            {(() => {
              const attachments = deepCleaningVisibleAttachments(viewing.attachment_urls, viewing.photo_urls, viewing.repair_photo_urls)
              return attachments.length ? <><Divider orientation="left">附件</Divider><DeepCleaningMedia context={viewing} references={attachments} /></> : null
            })()}

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
              <Button icon={<ShareAltOutlined />} onClick={() => shareLink(viewing)}>分享</Button>
            </div>
          </>
        ) : null}
      </Drawer>
    </Space>
  )
}
