"use client"
import { Card, Table, Space, Button, Input, Select, DatePicker, Modal, Form, App, Upload, Grid, Drawer, Image, InputNumber, Switch, Typography, Tag, Row, Col, Divider, Spin, Descriptions, Progress } from 'antd'
import { AppstoreOutlined, CreditCardOutlined, EnvironmentOutlined, InfoCircleOutlined, PercentageOutlined, DollarCircleOutlined, PictureOutlined, CheckCircleOutlined } from '@ant-design/icons'
import html2canvas from 'html2canvas'
import type { UploadFile } from 'antd/es/upload/interface'
import dayjs from 'dayjs'
import { useEffect, useMemo, useRef, useState } from 'react'
import { apiUpdate, apiDelete, apiCreate, getJSON, API_BASE, authHeaders } from '../../../lib/api'
import { hasPerm } from '../../../lib/auth'
import { downloadNamedBlob } from '../../../lib/download'
import { sortProperties } from '../../../lib/properties'
import { runWorkRecordPdfJob } from '../../../lib/workRecordPdfJobs'
import styles from './records.module.scss'

type RepairOrder = {
  id: string
  property_id?: string
  category?: string
  category_detail?: string
  detail?: string
  details?: string
  attachment_urls?: string[]
  work_no?: string
  submitter_name?: string
  submitter_id?: string
  submitted_at?: string
  urgency?: 'urgent'|'normal'|'not_urgent'|'high'|'medium'|'low'
  status?: 'pending'|'assigned'|'in_progress'|'completed'|'canceled'
  assignee_id?: string
  eta?: string
  completed_at?: string
  remark?: string
  repair_notes?: string
  repair_photo_urls?: string[]
  photo_urls?: string[]
  maintenance_amount?: number | string | null
  has_parts?: boolean | null
  parts_amount?: number | string | null
  maintenance_amount_includes_parts?: boolean | null
  has_gst?: boolean | null
  maintenance_amount_includes_gst?: boolean | null
  pay_method?: string | null
  pay_other_note?: string | null
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
  const [filterCat, setFilterCat] = useState<string | undefined>(undefined)
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
          const raw = localStorage.getItem('mz_cache_rbac_users_v1')
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
        const opts = (Array.isArray(users) ? users : []).map(u => ({ value: String(u?.id || ''), label: String(u?.username || u?.name || u?.id || '') })).filter(x => x.value && x.label)
        setUserOptions(opts)
        if (typeof window !== 'undefined') {
          try { localStorage.setItem('mz_cache_rbac_users_v1', JSON.stringify({ ts: Date.now(), data: opts })) } catch {}
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
      filterCat: String(filterCat || ''),
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
      if (filterCat) params.category = filterCat
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
  }, [filterCode, filterPropertyId, filterWorkNo, filterSubmitter, filterPayMethod, filterStatus, filterCat, dateRange, pageSize])
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
      status: row.status || 'pending',
      assignee_id: row.assignee_id || '',
      eta: row.eta ? dayjs(row.eta) : null,
      notes: (row as any).notes || (row as any).remark || '',
      urgency: row.urgency || 'normal',
      details: summaryFromDetails(row.details),
      submitter_name: String((row as any)?.submitter_name || (row as any)?.worker_name || (row as any)?.created_by || ''),
      completed_at: row.completed_at ? dayjs(row.completed_at) : null,
      maintenance_amount: (row as any)?.maintenance_amount !== undefined ? Number((row as any)?.maintenance_amount || 0) : undefined,
      has_parts: (row as any)?.has_parts ?? undefined,
      parts_amount: (row as any)?.parts_amount !== undefined ? Number((row as any)?.parts_amount || 0) : undefined,
      maintenance_amount_includes_parts: (row as any)?.maintenance_amount_includes_parts ?? undefined,
      has_gst: (row as any)?.has_gst ?? undefined,
      maintenance_amount_includes_gst: (row as any)?.maintenance_amount_includes_gst ?? undefined,
      pay_method: (row as any)?.pay_method ?? undefined,
      pay_other_note: (row as any)?.pay_other_note ?? undefined,
    })
    const rawRepair: any = (row as any).repair_photo_urls
    let urls: string[] = Array.isArray(rawRepair) ? rawRepair : []
    if (!urls.length && typeof rawRepair === 'string') {
      try {
        const j = JSON.parse(rawRepair)
        if (Array.isArray(j)) urls = j
      } catch {}
    }
    setRepairPhotos(urls)
    setFiles(urls.map((u: string, i: number) => ({ uid: String(i), name: `photo-${i+1}`, status: 'done', url: u } as UploadFile)))
    const preUrls: string[] = Array.isArray((row as any)?.photo_urls) ? (row as any)?.photo_urls! : []
    setPrePhotos(preUrls)
    setPreFiles(preUrls.map((u: string, i: number) => ({ uid: `pre-${i}`, name: `pre-${i+1}`, status: 'done', url: u } as UploadFile)))
    setOpen(true)
  }

  async function save() {
    try {
      if (saving) return
      if (files.some((f) => f.status === 'uploading') || preFiles.some((f) => f.status === 'uploading')) {
        message.warning('照片上传中，请稍后再保存')
        return
      }
      setSaving(true)
      message.loading({ key: 'maint-record-save', content: '保存中…', duration: 0 })

      const v = await form.validateFields()
      const payload: any = {
        property_id: v.property_id || undefined,
        submitter_name: v.submitter_name || undefined,
        status: v.status,
        assignee_id: v.assignee_id || undefined,
        eta: v.eta ? dayjs(v.eta).format('YYYY-MM-DD') : undefined,
        notes: v.notes || undefined,
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
      const st = String(v.status || '')
      if (st === 'in_progress' || st === 'completed') {
        if (repairPhotos.length) payload.repair_photo_urls = repairPhotos
        if (Object.prototype.hasOwnProperty.call(v, 'repair_notes')) {
          const repairNotes = String(v.repair_notes || '').trim()
          payload.repair_notes = repairNotes || null
        }
      }
      if (prePhotos.length) payload.photo_urls = prePhotos
      if (st === 'completed') {
        const existing = (editing as any)?.completed_at
        payload.completed_at = v.completed_at ? dayjs(v.completed_at).toDate().toISOString() : (existing ? String(existing) : new Date().toISOString())
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

      let updated: RepairOrder | null = null
      if (editing) updated = await apiUpdate<RepairOrder>('property_maintenance', editing.id, payload)

      if (updated?.id) {
        setList((prev) => prev.map((x) => (String(x.id) === String(updated!.id) ? { ...x, ...updated! } : x)))
      }
      message.success({ key: 'maint-record-save', content: '已保存' })
      setOpen(false)
      setEditing(null)
      loadMaintenance(page === 1, { silent: true, page })
    } catch (e: any) {
      message.error({ key: 'maint-record-save', content: e?.message || '保存失败' })
    } finally {
      setSaving(false)
    }
  }

  const statusWatch = Form.useWatch('status', form)
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

  const statusOptions = [
    { value: 'pending', label: '待维修' },
    { value: 'assigned', label: '已分配' },
    { value: 'in_progress', label: '维修中' },
    { value: 'completed', label: '已完成' },
  ]
  function statusLabel(s?: string) {
    const v = String(s || '')
    if (v === 'pending') return '待维修'
    if (v === 'assigned') return '已分配'
    if (v === 'in_progress') return '维修中'
    if (v === 'completed') return '已完成'
    if (v === 'canceled') return '已取消'
    return v || '-'
  }
  function statusTag(s?: string) {
    const v = String(s || '')
    const label = statusLabel(v)
    if (v === 'pending') return <Tag color="default">{label}</Tag>
    if (v === 'assigned') return <Tag color="blue">{label}</Tag>
    if (v === 'in_progress') return <Tag color="orange">{label}</Tag>
    if (v === 'completed') return <Tag color="green">{label}</Tag>
    if (v === 'canceled') return <Tag color="red">{label}</Tag>
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
    const direct = String(r?.category || r?.category_detail || '').trim()
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
  async function remove(id: string) {
    try {
      await apiDelete('property_maintenance', id)
      message.success('已删除'); setPage(1); loadMaintenance(true)
    } catch (e: any) { message.error(e?.message || '删除失败') }
  }
  async function fetchAllForExport() {
    const all: any[] = []
    const limit = 500
    let offset = 0
    for (;;) {
      const params: Record<string, any> = { limit: String(limit), offset: String(offset) }
      if (filterStatus) params.status = filterStatus
      if (filterCat) params.category = filterCat
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
            setFilterCat(undefined)
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
                          <div style={{ gridColumn:'1 / span 2' }}>提交时间：{(r.submitted_at || (r as any).occurred_at || (r as any).created_at) ? dayjs(r.submitted_at || (r as any).occurred_at || (r as any).created_at).format('YYYY-MM-DD') : '-'}</div>
                          <div style={{ gridColumn:'1 / span 2' }}>问题摘要：{summaryFromDetails(r.details)}</div>
                          <div>维修金额：{fmtAmount(calcTotalAmount(r)?.total)}</div>
                          <div>是否有配件费：{(r as any).has_parts === true ? '是' : (r as any).has_parts === false ? '否' : '-'}</div>
                          <div>配件费：{fmtAmount((r as any).parts_amount)}</div>
                          <div>扣款方式：{payMethodLabel((r as any).pay_method)}</div>
                          {(r as any).pay_method === 'other_pay' ? (
                            <div style={{ gridColumn:'1 / span 2' }}>其他人备注：{String((r as any).pay_other_note || '-')}</div>
                          ) : null}
                        </div>
                        <Space>
                          <Button onClick={()=>openView(r)}>详情</Button>
                          <Button onClick={()=>shareLink(r)}>分享</Button>
                          <Button onClick={()=>openExportPdf(r)} loading={downloadingId === String(r.id)} disabled={!canDownload}>导出PDF</Button>
                          <Button onClick={()=>openEdit(r)} disabled={!hasPerm('property_maintenance.write')}>编辑</Button>
                          <Button danger onClick={()=>remove(r.id)} disabled={!hasPerm('property_maintenance.delete')}>删除</Button>
                        </Space>
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
                const v = (r as any)?.submitted_at || (r as any)?.occurred_at || (r as any)?.created_at
                return v ? dayjs(v).format('YYYY-MM-DD') : '-'
              } },
              { title:'维修金额', dataIndex:'maintenance_amount', width: 140, render:(_:any, r:any)=> fmtAmount(calcTotalAmount(r)?.total) },
              { title:'是否有配件费', dataIndex:'has_parts', width: 120, render:(b:boolean)=> b === true ? '是' : b === false ? '否' : '-' },
              { title:'配件费金额', dataIndex:'parts_amount', width: 140, render:(a:any)=> fmtAmount(a) },
              { title:'扣款方式', dataIndex:'pay_method', width: 140, render:(v:string)=> payMethodLabel(v) },
              { title:'其他人备注', dataIndex:'pay_other_note', width: 160 },
              { title:'状态', dataIndex:'status', width: 120, render:(s:string)=> statusTag(s) },
              { title:'分配人员', dataIndex:'assignee_id', width: 140 },
              { title:'操作', width: 320, render: (_:any, r:RepairOrder) => (
                <Space wrap>
                  <Button onClick={()=>openView(r)}>详情</Button>
                  <Button onClick={()=>shareLink(r)}>分享</Button>
                  <Button onClick={()=>openExportPdf(r)} loading={downloadingId === String(r.id)} disabled={!canDownload}>导出PDF</Button>
                  <Button onClick={()=>openEdit(r)} disabled={!hasPerm('property_maintenance.write')}>编辑</Button>
                  <Button danger onClick={()=>remove(r.id)} disabled={!hasPerm('property_maintenance.delete')}>删除</Button>
                </Space>
              ) },
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
                  scroll={{ x: 1800 }}
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
              <Descriptions.Item label="提交时间">{((viewRow as any)?.submitted_at || (viewRow as any)?.occurred_at || (viewRow as any)?.created_at) ? dayjs((viewRow as any)?.submitted_at || (viewRow as any)?.occurred_at || (viewRow as any)?.created_at).format('YYYY-MM-DD') : '-'}</Descriptions.Item>
              <Descriptions.Item label="完成日期">{(viewRow as any)?.completed_at ? dayjs((viewRow as any).completed_at).format('YYYY-MM-DD') : '-'}</Descriptions.Item>
            </Descriptions>

            <Divider orientation="left">问题详情</Divider>
            <Descriptions bordered column={1} labelStyle={{ width: '120px' }}>
              <Descriptions.Item label="问题摘要" style={{ whiteSpace: 'pre-wrap' }}>
                {summaryFromDetails(viewRow?.details) || (viewRow as any)?.detail || '-'}
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
                          <Image key={i} src={u} width="100%" height={140} style={{ objectFit: 'cover', borderRadius: 8 }} />
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
                  const raw: any = (viewRow as any)?.repair_photo_urls
                  let arr: string[] = Array.isArray(raw) ? raw : []
                  if (!arr.length && typeof raw === 'string') {
                    try { const j = JSON.parse(raw); if (Array.isArray(j)) arr = j } catch {}
                  }
                  if (!arr.length) return '-'
                  return (
                    <Image.PreviewGroup>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
                        {arr.map((u: string, i: number) => (
                          <Image key={i} src={u} width="100%" height={140} style={{ objectFit: 'cover', borderRadius: 8 }} />
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
      <Modal open={createOpen} onCancel={()=>{ setCreateOpen(false); createForm.resetFields(); setCreateFiles([]); setCreatePhotos([]) }} onOk={async ()=>{
        const v = await createForm.validateFields()
        const payload: any = {
          property_id: v.property_id,
          category: v.category,
          status: 'pending',
          submitted_at: new Date().toISOString(),
        }
        if (v.details) {
          try { payload.details = JSON.stringify([{ content: String(v.details || '') }]) } catch { payload.details = String(v.details || '') }
        }
        if (v.submitter_name) payload.submitter_name = v.submitter_name
        if (createPhotos.length) payload.photo_urls = createPhotos
        try {
          await apiCreate('property_maintenance', payload)
          message.success('已新增维修记录')
          setCreateOpen(false); createForm.resetFields(); setCreateFiles([]); setCreatePhotos([])
          setPage(1); loadMaintenance(true)
        } catch (e: any) { message.error(e?.message || '新增失败') }
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
          <Form.Item name="category" label="问题区域" rules={[{ required: true }]}>
            <Select options={['入户走廊','客厅','厨房','卧室','阳台','浴室','其他'].map(x => ({ value:x, label:x }))} />
          </Form.Item>
          <Form.Item name="submitter_name" label="提交人" rules={[{ required: true }]}>
            <Input placeholder="请输入提交人姓名" />
          </Form.Item>
          <Form.Item name="details" label="问题摘要" rules={[{ required: true, min: 3 }]}>
            <Input.TextArea rows={3} />
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
        title="更新维修记录"
        width={720}
        onClose={() => { if (!saving) setOpen(false) }}
        open={open}
        closable={!saving}
        maskClosable={!saving}
        footer={
          <div style={{ textAlign: 'right' }}>
            <Space>
              <Button onClick={() => setOpen(false)} disabled={saving}>取消</Button>
              <Button type="primary" onClick={save} loading={saving} disabled={saving}>保存</Button>
            </Space>
          </div>
        }
      >
        <Spin spinning={saving} tip="保存中…">
        <Form form={form} layout="vertical">
          <Divider orientation="left">基础信息</Divider>
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
              <Form.Item name="status" label="状态" rules={[{ required: true }]}>
                <Select options={statusOptions} />
              </Form.Item>
            </Col>
            <Col span={12}>
              {(String(statusWatch || '') === 'pending' || String(statusWatch || '') === 'assigned' || String(statusWatch || '') === 'in_progress') ? (
                <Form.Item name="urgency" label="紧急程度">
                  <Select options={[
                    { value:'urgent', label:'紧急' },
                    { value:'normal', label:'普通' },
                    { value:'not_urgent', label:'不紧急' },
                  ]} />
                </Form.Item>
              ) : null}
            </Col>
            <Col span={12}>
              {(String(statusWatch || '') === 'pending' || String(statusWatch || '') === 'assigned' || String(statusWatch || '') === 'in_progress') ? (
                <Form.Item name="assignee_id" label="分配维修人员">
                  <Select
                    allowClear
                    showSearch
                    optionFilterProp="label"
                    options={userOptions}
                    placeholder="请选择维修人员"
                  />
                </Form.Item>
              ) : null}
            </Col>
            <Col span={12}>
              {(String(statusWatch || '') === 'pending' || String(statusWatch || '') === 'assigned' || String(statusWatch || '') === 'in_progress') ? (
                <Form.Item name="eta" label="预计完成时间"><DatePicker style={{ width: '100%' }} /></Form.Item>
              ) : null}
            </Col>
            <Col span={24}>
              <Form.Item name="details" label="问题摘要"><Input.TextArea rows={3} /></Form.Item>
            </Col>
            <Col span={24}>
              <Form.Item label="维修前照片">
                <Upload listType="picture-card" multiple fileList={preFiles} onRemove={(f)=>{ setPreFiles(fl=>fl.filter(x=>x.uid!==f.uid)); if ((f as any).url) setPrePhotos(u=>u.filter(x=>x!==(f as any).url)) }}
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

          {(String(statusWatch || '') === 'in_progress' || String(statusWatch || '') === 'completed') ? (
            <>
              <Divider orientation="left">维修反馈</Divider>
              <Row gutter={16}>
                <Col span={24}>
                  <Form.Item name="repair_notes" label="维修记录描述"><Input.TextArea rows={3} /></Form.Item>
                </Col>
                <Col span={24}>
                  <Form.Item label="维修后照片">
                    <Upload listType="picture-card" multiple fileList={files} onRemove={(f)=>{ setFiles(fl=>fl.filter(x=>x.uid!==f.uid)); if (f.url) setRepairPhotos(u=>u.filter(x=>x!==f.url)) }}
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
              </Row>
            </>
          ) : null}

          {String(statusWatch || '') === 'completed' ? (
            <>
              <Divider orientation="left">费用结算</Divider>
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
                  <Form.Item name="completed_at" label="完成时间">
                    <DatePicker style={{ width: '100%' }} />
                  </Form.Item>
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
            </>
          ) : null}
          <Divider orientation="left">其他</Divider>
          <Form.Item name="notes" label="内部备注"><Input.TextArea rows={2} /></Form.Item>
        </Form>
        </Spin>
      </Drawer>
    </Space>
  )
}
