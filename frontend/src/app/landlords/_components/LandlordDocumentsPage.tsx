"use client"

import { AutoComplete, Button, Card, Col, DatePicker, Descriptions, Divider, Drawer, Form, Input, InputNumber, Modal, Row, Select, Space, Table, Tag, Upload, message } from 'antd'
import type { UploadProps } from 'antd'
import dayjs from 'dayjs'
import { useEffect, useMemo, useRef, useState } from 'react'
import { API_BASE, authHeaders, deleteJSON, getJSON, patchJSON, postJSON } from '../../../lib/api'
import { hasPerm } from '../../../lib/auth'
import SignaturePad, { type SignaturePadHandle } from '../../../components/SignaturePad'

type DocumentType = 'agency_authority' | 'property_service_agreement'
type VersionKind = 'draft' | 'signed'

type DocumentVersion = {
  id: string
  kind: VersionKind
  version_no: number
  file_url: string
  file_name?: string
  file_size?: number
  is_current?: boolean
  notes?: string
  created_at?: string
}

type LandlordDocument = {
  id: string
  type: DocumentType
  document_no?: string
  landlord_id?: string | null
  property_id?: string | null
  landlord_name?: string
  property_code?: string
  property_address?: string
  status: 'draft' | 'sent_for_signature' | 'signed' | 'archived'
  fields?: Record<string, any>
  notes?: string
  current_draft_url?: string
  current_signed_url?: string
  current_draft_version_id?: string
  current_signed_version_id?: string
  versions?: DocumentVersion[]
  created_at?: string
  updated_at?: string
}

type PropertyLite = {
  id: string
  code?: string
  address?: string
  landlord_id?: string | null
}

type LandlordLite = {
  id: string
  name?: string
  email?: string
  emails?: string[]
  phone?: string
  abn?: string
  property_ids?: string[]
}

type Props = {
  type: DocumentType
  title: string
}

type SavedMzSignature = {
  signed_name: string
  signature_data_url: string
}

const MZ_SIGNATURE_STORAGE_KEY = 'landlord_documents_mz_signature_v1'
const AGENCY_AUTHORITY_TEMPLATE_VERSION = 'authorisation-detail-v7-page-filled-2026-05-18'

const statusText: Record<string, string> = {
  draft: '草稿',
  sent_for_signature: '待签署',
  signed: '已签署',
  archived: '已归档',
}

const statusColor: Record<string, string> = {
  draft: 'default',
  sent_for_signature: 'processing',
  signed: 'success',
  archived: 'warning',
}

function fmtDate(v?: string) {
  if (!v) return '-'
  const d = dayjs(v)
  return d.isValid() ? d.format('YYYY-MM-DD HH:mm') : v
}

function fileSize(n?: number) {
  const x = Number(n || 0)
  if (!x) return '-'
  if (x < 1024 * 1024) return `${Math.round(x / 1024)} KB`
  return `${(x / 1024 / 1024).toFixed(1)} MB`
}

function safeFilenamePart(value: any) {
  return String(value || '').trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
}

function documentDownloadName(row: LandlordDocument, suffix = '') {
  const propertyCode = safeFilenamePart(row.property_code || row.fields?.property_code)
  const documentNo = safeFilenamePart(row.document_no || row.id)
  return [propertyCode, documentNo].filter(Boolean).join('-') + `${suffix}.pdf`
}

function statusOptions() {
  return [
    { value: '', label: '全部状态' },
    { value: 'draft', label: '草稿' },
    { value: 'sent_for_signature', label: '待签署' },
    { value: 'signed', label: '已签署' },
    { value: 'archived', label: '已归档' },
  ]
}

const propertyTypeOptions = [
  { value: '1 Bedroom 1 Bathroom', label: '1 Bedroom 1 Bathroom' },
  { value: '2 Bedrooms 1 Bathroom', label: '2 Bedrooms 1 Bathroom' },
  { value: '2 Bedrooms 2 Bathrooms', label: '2 Bedrooms 2 Bathrooms' },
  { value: '3 Bedrooms 2 Bathrooms', label: '3 Bedrooms 2 Bathrooms' },
  { value: '3 Bedrooms 3 Bathrooms', label: '3 Bedrooms 3 Bathrooms' },
]

const parkingOptions = [
  { value: 'yes', label: 'Parking available' },
  { value: 'no', label: 'No parking' },
]

const melbourneSuburbPostcodes: Record<string, string> = {
  melbourne: '3000',
  southbank: '3006',
  docklands: '3008',
  'south melbourne': '3205',
  'west melbourne': '3003',
  'north melbourne': '3051',
  carlton: '3053',
  fitzroy: '3065',
  collingwood: '3066',
  richmond: '3121',
  cremorne: '3121',
  'south yarra': '3141',
  prahran: '3181',
  windsor: '3181',
  'st kilda': '3182',
  'port melbourne': '3207',
  'east melbourne': '3002',
}

export default function LandlordDocumentsPage({ type, title }: Props) {
  const [rows, setRows] = useState<LandlordDocument[]>([])
  const [properties, setProperties] = useState<PropertyLite[]>([])
  const [landlords, setLandlords] = useState<LandlordLite[]>([])
  const [sourceContracts, setSourceContracts] = useState<LandlordDocument[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState('')
  const [keyword, setKeyword] = useState('')
  const [addrOptions, setAddrOptions] = useState<{ value: string; label: string }[]>([])
  const [addrTimer, setAddrTimer] = useState<any>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const [detailOpen, setDetailOpen] = useState(false)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewUrl, setPreviewUrl] = useState('')
  const [previewDoc, setPreviewDoc] = useState<LandlordDocument | null>(null)
  const [editing, setEditing] = useState<LandlordDocument | null>(null)
  const [detail, setDetail] = useState<LandlordDocument | null>(null)
  const [uploadTarget, setUploadTarget] = useState<LandlordDocument | null>(null)
  const [form] = Form.useForm()
  const [uploadForm] = Form.useForm()
  const [mzSignOpen, setMzSignOpen] = useState(false)
  const [mzSignTarget, setMzSignTarget] = useState<LandlordDocument | null>(null)
  const [defaultMzSignature, setDefaultMzSignature] = useState<SavedMzSignature | null>(null)
  const [linkOpen, setLinkOpen] = useState(false)
  const [signLink, setSignLink] = useState('')
  const [signLinkExpiresAt, setSignLinkExpiresAt] = useState('')
  const [mzSignForm] = Form.useForm()
  const mzSignPadRef = useRef<SignaturePadHandle | null>(null)
  const [canWrite, setCanWrite] = useState(false)

  function loadStoredMzSignature() {
    if (typeof window === 'undefined') return null
    try {
      const raw = localStorage.getItem(MZ_SIGNATURE_STORAGE_KEY) || ''
      if (!raw) return null
      const parsed = JSON.parse(raw)
      const signed_name = String(parsed?.signed_name || '').trim()
      const signature_data_url = String(parsed?.signature_data_url || '').trim()
      if (!signed_name || !signature_data_url) return null
      return { signed_name, signature_data_url }
    } catch {
      return null
    }
  }

  function saveStoredMzSignature(value: SavedMzSignature | null) {
    setDefaultMzSignature(value)
    if (typeof window === 'undefined') return
    try {
      if (!value) localStorage.removeItem(MZ_SIGNATURE_STORAGE_KEY)
      else localStorage.setItem(MZ_SIGNATURE_STORAGE_KEY, JSON.stringify(value))
    } catch {}
  }

  const filteredRows = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    if (!kw) return rows
    return rows.filter((r) => {
      const f = r.fields || {}
      return [r.document_no, r.landlord_name, r.property_code, r.property_address, f.landlord_name, f.owner_name, f.property_address]
        .some((x) => String(x || '').toLowerCase().includes(kw))
    })
  }, [keyword, rows])

  const sourceContractOptions = useMemo(() => sourceContracts.map((r) => {
    const f = r.fields || {}
    const label = [r.document_no, f.owner_name || f.landlord_name, f.property_address].filter(Boolean).join(' / ')
    return { value: r.id, label: label || r.id }
  }), [sourceContracts])

  const propertyOptions = useMemo(() => properties.map((p) => {
    const label = [p.code, p.address].filter(Boolean).join(' / ')
    return { value: p.id, label: label || p.id }
  }), [properties])

  async function load() {
    setLoading(true)
    try {
      const qs = new URLSearchParams()
      qs.set('type', type)
      if (status) qs.set('status', status)
      if (status === 'archived') qs.set('include_archived', 'true')
      const list = await getJSON<LandlordDocument[]>(`/landlord-documents?${qs.toString()}`)
      setRows(Array.isArray(list) ? list : [])
    } catch (e: any) {
      message.error(e?.message || '加载失败')
      setRows([])
    } finally {
      setLoading(false)
    }
  }

  async function loadSourceContracts() {
    if (type !== 'agency_authority') return
    const list = await getJSON<LandlordDocument[]>('/landlord-documents?type=property_service_agreement').catch(() => [])
    setSourceContracts(Array.isArray(list) ? list : [])
  }

  async function loadAuthorityReferences() {
    if (type !== 'agency_authority') return
    const [propertyList, landlordList] = await Promise.all([
      getJSON<PropertyLite[]>('/properties').catch(() => []),
      getJSON<LandlordLite[]>('/landlords').catch(() => []),
    ])
    setProperties(Array.isArray(propertyList) ? propertyList : [])
    setLandlords(Array.isArray(landlordList) ? landlordList : [])
  }

  useEffect(() => { loadSourceContracts() }, [type])
  useEffect(() => { loadAuthorityReferences() }, [type])
  useEffect(() => { load() }, [type, status])
  useEffect(() => { setDefaultMzSignature(loadStoredMzSignature()) }, [])
  useEffect(() => { setCanWrite(hasPerm('landlord.manage')) }, [])

  function defaultFields() {
    const fields: Record<string, any> = {
      landlord_name: '',
      landlord_email: '',
      landlord_phone: '',
      owner_name: '',
      owner_email: '',
      owner_phone: '',
      bsb: '',
      account_number: '',
      account_name: '',
      property_address: '',
      property_code: '',
      property_type_description: '',
      parking_available: 'yes',
      parking_count: 1,
      parking_space_number: '',
      parking_details: '1 car space',
      maximum_guests: '',
      mz_company_name: 'MZ Property Pty Ltd',
      mz_company_address: 'G03/87 Gladstone St, South Melbourne VIC 3205',
      mz_company_abn: '42 657 925 365',
      mz_agent_name: 'Ming Xue',
      mz_contact_phone: type === 'agency_authority' ? '0434 782 499' : '+61 430907988',
      mz_contact_email: 'info@mzproperty.com.au',
      termination_notice_days: '60',
      repair_approval_limit: '300',
      utilities_paid_by: 'paid by Owner',
      investment_or_holiday: 'Investment',
      term: 'Ongoing with 3-months termination notice',
      initial_property_visit: 'Included',
      setup_fee: '0.00',
      management_fee: '50%/Month',
      consumable_fee: '0.00 /Month',
      linen_fee: 'Included',
      initial_housekeeping_fee: 'TBC',
      installation_fee: '0.00',
      purchase_fee: '0.00',
      photography_fee: '0.00',
    }
    return fields
  }

  function titleCaseAddressPart(input: string) {
    return String(input || '')
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/\b\w/g, (m) => m.toUpperCase())
      .replace(/\bBvd\b/gi, 'Boulevard')
      .replace(/\bBlvd\b/gi, 'Boulevard')
      .replace(/\bSt\b/gi, 'Street')
      .replace(/\bRd\b/gi, 'Road')
      .replace(/\bAve\b/gi, 'Avenue')
      .replace(/\bDr\b/gi, 'Drive')
      .replace(/\bCres\b/gi, 'Crescent')
      .replace(/\bPde\b/gi, 'Parade')
  }

  function localAddressSuggestions(input: string) {
    const raw = input.trim()
    if (!raw) return []
    const pieces = raw.split(',').map((x) => x.trim()).filter(Boolean)
    const street = titleCaseAddressPart(pieces[0] || raw)
    const suburbRaw = pieces[1] || ''
    const suburbKey = suburbRaw.toLowerCase()
    const matchedSuburb = suburbKey
      ? Object.keys(melbourneSuburbPostcodes).find((name) => name === suburbKey || name.startsWith(suburbKey))
      : ''
    const suburb = titleCaseAddressPart(matchedSuburb || suburbRaw || 'Melbourne')
    const postcode = melbourneSuburbPostcodes[(matchedSuburb || suburbRaw || 'melbourne').toLowerCase()] || ''
    const formatted = `${street}, ${suburb} VIC${postcode ? ` ${postcode}` : ''}, Australia`
    return [{ value: formatted, label: formatted }]
  }

  async function fetchAddrSuggestions(input: string) {
    const q = input.trim()
    if (!q) {
      setAddrOptions([])
      return
    }
    const localOptions = localAddressSuggestions(q)
    try {
      const u = `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=8&countrycodes=au&q=${encodeURIComponent(`${q} Melbourne VIC Australia`)}`
      const res = await fetch(u, { headers: { 'Accept-Language': 'en' } })
      const rows = await res.json().catch(() => [])
      const remoteOptions = (rows || []).map((r: any) => {
        const a = r.address || {}
        const num = a.house_number || ''
        const road = a.road || a.pedestrian || a.cycleway || ''
        if (!road && !num) return null
        const suburb = a.suburb || a.neighbourhood || a.town || a.city || 'Melbourne'
        const state = a.state || 'VIC'
        const pc = a.postcode || ''
        const formatted = `${[num, road].filter(Boolean).join(' ')}${road || num ? ', ' : ''}${suburb}, ${state}${pc ? ` ${pc}` : ''}, Australia`
        return { value: formatted, label: formatted }
      }).filter(Boolean)
      const seen = new Set<string>()
      const opts = [...localOptions, ...remoteOptions].filter((item: any) => {
        const key = String(item?.value || '').toLowerCase()
        if (!key || seen.has(key)) return false
        seen.add(key)
        return true
      })
      setAddrOptions(opts)
    } catch {
      setAddrOptions(localOptions)
    }
  }

  function handleAddrSearch(input: string) {
    if (addrTimer) clearTimeout(addrTimer)
    const t = setTimeout(() => fetchAddrSuggestions(input), 250)
    setAddrTimer(t)
  }

  function openCreate() {
    setEditing(null)
    form.resetFields()
    form.setFieldsValue({ landlord_id: null, property_id: null, fields: defaultFields() })
    setEditorOpen(true)
  }

  function openEdit(row: LandlordDocument) {
    setEditing(row)
    form.resetFields()
    form.setFieldsValue({
      landlord_id: row.landlord_id || null,
      property_id: row.property_id || null,
      notes: row.notes || undefined,
      fields: hydrateDateFields(row.fields || {}),
    })
    setEditorOpen(true)
  }

  async function openDetail(row: LandlordDocument) {
    const full = await getJSON<LandlordDocument>(`/landlord-documents/${row.id}`).catch(() => row)
    setDetail(full)
    setDetailOpen(true)
  }

  async function submit() {
    const v = await form.validateFields()
    const payload = {
      type,
      landlord_id: v.landlord_id || null,
      property_id: v.property_id || null,
      notes: v.notes || null,
      fields: normalizeFormFields(v.fields || {}),
    }
    setSaving(true)
    try {
      if (editing?.id) {
        await patchJSON(`/landlord-documents/${editing.id}`, payload)
        message.success('已保存')
      } else {
        await postJSON('/landlord-documents', payload)
        message.success('已创建')
      }
      setEditorOpen(false)
      await load()
    } catch (e: any) {
      message.error(e?.message || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  function normalizeFormFields(fields: Record<string, any>) {
    const out: Record<string, any> = { ...fields }
    for (const k of ['sign_date', 'commencement_date']) {
      if (out[k] && dayjs.isDayjs(out[k])) out[k] = out[k].format('YYYY-MM-DD')
    }
    out.parking_details = buildParkingDetails(out)
    out.number_of_keys = normalizeKeySets(out.number_of_keys)
    return out
  }

  function hydrateDateFields(fields: Record<string, any>) {
    const out: Record<string, any> = { ...fields }
    for (const k of ['sign_date', 'commencement_date']) {
      if (out[k]) {
        const d = dayjs(out[k])
        if (d.isValid()) out[k] = d
      }
    }
    if (!out.parking_available && out.parking_details) {
      out.parking_available = /no parking|none|无/i.test(String(out.parking_details)) ? 'no' : 'yes'
    }
    if (!out.parking_count && out.parking_available !== 'no') {
      const m = String(out.parking_details || '').match(/(\d+)/)
      out.parking_count = m ? Number(m[1]) : 1
    }
    return out
  }

  function buildParkingDetails(fields: Record<string, any>) {
    if (fields.parking_available === 'no') return 'No parking'
    const count = Math.max(1, Number(fields.parking_count || 1))
    const details = String(fields.parking_space_number || '').trim()
    return [`${count} car space${count > 1 ? 's' : ''}`, details].filter(Boolean).join(' - ')
  }

  function normalizeKeySets(value: any) {
    const raw = String(value || '').trim()
    if (!raw) return raw
    if (/sets?/i.test(raw)) return raw
    return `${raw} Set(s)`
  }

  async function ensureDraft(row: LandlordDocument, forceRefresh = false) {
    const current = row.current_draft_url ? row : await getJSON<LandlordDocument>(`/landlord-documents/${row.id}`).catch(() => row)
    if (current.current_draft_url && !forceRefresh) return current
    if (!canWrite && !current.current_draft_url) return current
    if (!canWrite && current.current_draft_url) return current
    const result = await postJSON<{ document?: LandlordDocument }>(`/landlord-documents/${row.id}/generate-pdf`, { notes: forceRefresh ? 'Auto refresh draft on preview' : 'Auto draft on preview' })
    await load()
    return (result?.document || await getJSON<LandlordDocument>(`/landlord-documents/${row.id}`).catch(() => current)) as LandlordDocument
  }

  function needsAuthorityDraftRefresh(row: LandlordDocument) {
    if (row.type !== 'agency_authority') return false
    if (row.status === 'signed' || row.status === 'archived') return false
    if (!row.current_draft_url) return false
    return String(row.fields?.agency_authority_template_version || '') !== AGENCY_AUTHORITY_TEMPLATE_VERSION
  }

  async function openPreview(row: LandlordDocument) {
    try {
      const target = await ensureDraft(row, needsAuthorityDraftRefresh(row))
      if (!target.current_draft_url) {
        message.warning('当前还没有可预览的草稿 PDF')
        return
      }
      const res = await fetch(`${API_BASE}/landlord-documents/${target.id}/download-current-draft`, { headers: authHeaders() })
      if (!res.ok) {
        const j = await res.json().catch(() => null)
        throw new Error(j?.message || '预览失败')
      }
      const blob = await res.blob()
      if (previewUrl) URL.revokeObjectURL(previewUrl)
      setPreviewUrl(URL.createObjectURL(blob))
      setPreviewDoc(target)
      setPreviewOpen(true)
    } catch (e: any) {
      message.error(e?.message || '预览失败')
    }
  }

  async function reloadPreview(row: LandlordDocument) {
    const latest = await getJSON<LandlordDocument>(`/landlord-documents/${row.id}`).catch(() => row)
    await openPreview(latest)
  }

  function closePreview() {
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    setPreviewUrl('')
    setPreviewDoc(null)
    setPreviewOpen(false)
  }

  async function downloadDraft(row: LandlordDocument) {
    try {
      const target = await ensureDraft(row, needsAuthorityDraftRefresh(row))
      if (!target.current_draft_url) {
        message.warning('当前还没有可下载的草稿 PDF')
        return
      }
      const res = await fetch(`${API_BASE}/landlord-documents/${target.id}/download-current-draft`, { headers: authHeaders() })
      if (!res.ok) {
        const j = await res.json().catch(() => null)
        throw new Error(j?.message || '下载失败')
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = documentDownloadName(target)
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (e: any) {
      message.error(e?.message || '下载失败')
    }
  }

  async function downloadSigned(row: LandlordDocument) {
    try {
      if (!row.current_signed_url) {
        openUpload(row)
        return
      }
      const res = await fetch(`${API_BASE}/landlord-documents/${row.id}/download-current-signed`, { headers: authHeaders() })
      if (!res.ok) {
        const j = await res.json().catch(() => null)
        throw new Error(j?.message || '下载签署版失败')
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = documentDownloadName(row, '-signed')
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (e: any) {
      message.error(e?.message || '下载签署版失败')
    }
  }

  function openUpload(row: LandlordDocument) {
    setUploadTarget(row)
    uploadForm.resetFields()
    setUploadOpen(true)
  }

  async function saveMzSignatureForDocument(row: LandlordDocument, payload: SavedMzSignature) {
    try {
      await postJSON(`/landlord-documents/${row.id}/mz-sign`, payload)
      return
    } catch (e: any) {
      const msg = String(e?.message || '')
      const status = Number(e?.status || 0)
      const shouldFallback = status === 404 || /Cannot POST|not found|route/i.test(msg)
      if (!shouldFallback) throw e
    }
    const nextFields = {
      ...(row.fields || {}),
      mz_signed_name: payload.signed_name,
      mz_signature_data_url: payload.signature_data_url,
      mz_signed_at: new Date().toISOString(),
      landlord_sign_token_hash: '',
      landlord_sign_expires_at: '',
    }
    await patchJSON(`/landlord-documents/${row.id}`, { fields: nextFields, status: 'draft' })
  }

  async function applyDefaultMzSign(row: LandlordDocument, saved?: SavedMzSignature | null) {
    const signature = saved || defaultMzSignature
    if (!signature?.signed_name || !signature?.signature_data_url) {
      openMzSign(row)
      return
    }
    setSaving(true)
    try {
      await saveMzSignatureForDocument(row, signature)
      message.success('已套用默认签名')
      await load()
      if (detail?.id === row.id) await openDetail(row)
      if (previewDoc?.id === row.id) await reloadPreview(row)
    } catch (e: any) {
      message.error(e?.message || '签署失败')
    } finally {
      setSaving(false)
    }
  }

  function openMzSign(row?: LandlordDocument | null) {
    setMzSignTarget(row || null)
    mzSignForm.resetFields()
    mzSignForm.setFieldsValue({
      signed_name: defaultMzSignature?.signed_name || row?.fields?.mz_signed_name || row?.fields?.mz_agent_name || 'MZ Property',
    })
    setMzSignOpen(true)
    setTimeout(() => {
      if (defaultMzSignature?.signature_data_url) mzSignPadRef.current?.loadDataURL(defaultMzSignature.signature_data_url)
      else mzSignPadRef.current?.clear()
    }, 0)
  }

  async function submitMzSign() {
    const v = await mzSignForm.validateFields()
    if (!mzSignPadRef.current || mzSignPadRef.current.isEmpty()) {
      message.error('请先签名')
      return
    }
    const payload = {
      signed_name: String(v.signed_name || '').trim(),
      signature_data_url: mzSignPadRef.current.toDataURL(),
    }
    saveStoredMzSignature(payload)
    if (!mzSignTarget?.id) {
      setMzSignOpen(false)
      message.success('默认签名已保存')
      return
    }
    setSaving(true)
    try {
      await saveMzSignatureForDocument(mzSignTarget, payload)
      message.success('我方已签署')
      setMzSignOpen(false)
      await load()
      if (detail?.id === mzSignTarget.id) await openDetail(mzSignTarget)
      if (previewDoc?.id === mzSignTarget.id) await reloadPreview(mzSignTarget)
    } catch (e: any) {
      message.error(e?.message || '签署失败')
    } finally {
      setSaving(false)
    }
  }

  async function requestLandlordSign(row: LandlordDocument) {
    setSaving(true)
    try {
      if (!String(row.fields?.mz_signature_data_url || '').trim() && defaultMzSignature?.signed_name && defaultMzSignature?.signature_data_url) {
        await saveMzSignatureForDocument(row, defaultMzSignature)
      }
      const result = await postJSON<{ token: string; expires_at: string }>(`/landlord-documents/${row.id}/request-landlord-sign`, {})
      const origin = typeof window !== 'undefined' ? window.location.origin : ''
      const url = `${origin}/public/landlord-documents/sign/${String(result?.token || '')}`
      setSignLink(url)
      setSignLinkExpiresAt(String(result?.expires_at || ''))
      setLinkOpen(true)
      try { await navigator.clipboard?.writeText(url); message.success('签署链接已生成并复制') } catch { message.success('签署链接已生成') }
      await load()
      if (detail?.id === row.id) await openDetail(row)
      if (previewDoc?.id === row.id) await reloadPreview(row)
    } catch (e: any) {
      const msg = String(e?.message || '')
      if (msg === 'missing_mz_signature') message.error('请先完成 MZ 签署')
      else message.error(msg || '生成签署链接失败')
    } finally {
      setSaving(false)
    }
  }

  async function uploadSigned() {
    if (!uploadTarget?.id) return
    const v = await uploadForm.validateFields()
    const file = v.file?.[0]?.originFileObj
    if (!file) {
      message.error('请选择签署 PDF')
      return
    }
    const fd = new FormData()
    fd.append('file', file)
    fd.append('notes', v.notes || '')
    setSaving(true)
    try {
      const res = await fetch(`${API_BASE}/landlord-documents/${uploadTarget.id}/signed-versions/upload`, {
        method: 'POST',
        headers: authHeaders(),
        body: fd,
      })
      if (!res.ok) {
        const j = await res.json().catch(() => null)
        throw new Error(j?.message || '上传失败')
      }
      message.success('签署版已上传')
      setUploadOpen(false)
      await load()
      if (detail?.id === uploadTarget.id) await openDetail(uploadTarget)
    } catch (e: any) {
      message.error(e?.message || '上传失败')
    } finally {
      setSaving(false)
    }
  }

  async function setCurrentSigned(version: DocumentVersion) {
    if (!detail?.id) return
    try {
      const r = await patchJSON<{ document: LandlordDocument }>(`/landlord-documents/${detail.id}/signed-versions/${version.id}/set-current`, {})
      message.success('当前签署版已更新')
      setDetail(r.document)
      await load()
    } catch (e: any) {
      message.error(e?.message || '设置失败')
    }
  }

  async function archive(row: LandlordDocument) {
    Modal.confirm({
      title: '确认归档？',
      content: `将归档 ${row.document_no || row.id}，不会删除已上传文件。`,
      okText: '归档',
      okType: 'danger',
      cancelText: '取消',
      async onOk() {
        try {
          await deleteJSON(`/landlord-documents/${row.id}`)
          message.success('已归档')
          await load()
        } catch (e: any) {
          message.error(e?.message || '归档失败')
        }
      },
    })
  }

  const columns = [
    { title: '编号', dataIndex: 'document_no', width: 150, render: (v: string) => v || '-' },
    { title: '房东', dataIndex: 'landlord_name', width: 150, render: (_: any, r: LandlordDocument) => r.landlord_name || r.fields?.landlord_name || r.fields?.owner_name || '-' },
    { title: '房源', dataIndex: 'property_code', render: (_: any, r: LandlordDocument) => [r.property_code, r.property_address || r.fields?.property_address].filter(Boolean).join(' - ') || '-' },
    { title: '状态', dataIndex: 'status', width: 110, render: (v: string) => <Tag color={statusColor[v] || 'default'}>{statusText[v] || v}</Tag> },
    { title: '草稿', dataIndex: 'current_draft_url', width: 90, render: (v: string) => v ? <Tag color="blue">有</Tag> : <Tag>无</Tag> },
    { title: '签署版', dataIndex: 'current_signed_url', width: 90, render: (v: string) => v ? <Tag color="green">有</Tag> : <Tag>无</Tag> },
    { title: '更新', dataIndex: 'updated_at', width: 145, render: fmtDate },
    {
      title: '操作',
      key: 'actions',
      width: 420,
      render: (_: any, r: LandlordDocument) => (
        <Space>
          <Button onClick={() => openDetail(r)}>详情</Button>
          {canWrite ? <Button onClick={() => openEdit(r)}>编辑</Button> : null}
          <Button disabled={!r.current_draft_url && !canWrite} onClick={() => openPreview(r)}>预览</Button>
          {canWrite ? <Button onClick={() => downloadSigned(r)}>{r.current_signed_url ? '下载签署版' : '上传签署版'}</Button> : null}
          {canWrite ? <Button danger disabled={r.status === 'archived'} onClick={() => archive(r)}>归档</Button> : null}
        </Space>
      ),
    },
  ]

  const uploadProps: UploadProps = {
    accept: '.pdf,application/pdf',
    maxCount: 1,
    beforeUpload: () => false,
  }

  return (
    <Card
      title={title}
      extra={canWrite ? (
        <Space>
          <Button onClick={() => openMzSign(null)}>设置我方默认签名</Button>
          <Button type="primary" onClick={openCreate}>新增{title}</Button>
        </Space>
      ) : null}
    >
      <Space style={{ marginBottom: 16 }} wrap>
        <Input.Search allowClear placeholder="搜索房东/地址/编号" style={{ width: 280 }} value={keyword} onChange={(e) => setKeyword(e.target.value)} />
        <Select style={{ width: 140 }} options={statusOptions()} value={status} onChange={setStatus} />
        <Button onClick={load}>刷新</Button>
      </Space>
      <Table rowKey="id" loading={loading} columns={columns as any} dataSource={filteredRows} pagination={{ pageSize: 10 }} scroll={{ x: 1400 }} />

      <Drawer
        title={editing ? `编辑${title}` : `新增${title}`}
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        width={860}
        extra={<Space><Button onClick={() => setEditorOpen(false)}>取消</Button><Button type="primary" loading={saving} onClick={submit}>保存</Button></Space>}
      >
        <Form form={form} layout="vertical">
          {type === 'agency_authority' ? (
            <AuthorityFields
              form={form}
              hydrateDateFields={hydrateDateFields}
              properties={properties}
              landlords={landlords}
              propertyOptions={propertyOptions}
              sourceContracts={sourceContracts}
              sourceContractOptions={sourceContractOptions}
              addrOptions={addrOptions}
              onAddrSearch={handleAddrSearch}
            />
          ) : (
            <ServiceAgreementFields form={form} hydrateDateFields={hydrateDateFields} addrOptions={addrOptions} onAddrSearch={handleAddrSearch} />
          )}
          <Form.Item name="notes" label="备注"><Input.TextArea rows={2} /></Form.Item>
        </Form>
      </Drawer>

      <Drawer title="文档详情" open={detailOpen} onClose={() => setDetailOpen(false)} width={860}>
        {detail ? (
          <>
            <Descriptions column={2} bordered size="small">
              <Descriptions.Item label="编号">{detail.document_no || '-'}</Descriptions.Item>
              <Descriptions.Item label="状态"><Tag color={statusColor[detail.status]}>{statusText[detail.status] || detail.status}</Tag></Descriptions.Item>
              <Descriptions.Item label="房东">{detail.landlord_name || detail.fields?.landlord_name || detail.fields?.owner_name || '-'}</Descriptions.Item>
              <Descriptions.Item label="房源">{[detail.property_code, detail.property_address || detail.fields?.property_address].filter(Boolean).join(' - ') || '-'}</Descriptions.Item>
              <Descriptions.Item label="MZ 签署">{detail.fields?.mz_signed_at ? `${detail.fields?.mz_signed_name || '-'} / ${String(detail.fields?.mz_signed_at || '').slice(0, 10)}` : '-'}</Descriptions.Item>
              <Descriptions.Item label="房东签署">{detail.fields?.landlord_signed_at ? `${detail.fields?.landlord_signed_name || '-'} / ${String(detail.fields?.landlord_signed_at || '').slice(0, 10)}` : '-'}</Descriptions.Item>
              <Descriptions.Item label="当前草稿">{detail.current_draft_url ? <Button size="small" onClick={() => downloadDraft(detail)}>下载草稿</Button> : '-'}</Descriptions.Item>
              <Descriptions.Item label="当前签署版">{detail.current_signed_url ? <Button size="small" onClick={() => downloadSigned(detail)}>下载签署版</Button> : '-'}</Descriptions.Item>
              <Descriptions.Item label="备注" span={2}>{detail.notes || '-'}</Descriptions.Item>
            </Descriptions>
            <h3 style={{ marginTop: 20 }}>版本历史</h3>
            <Table
              rowKey="id"
              size="small"
              dataSource={detail.versions || []}
              pagination={false}
              columns={[
                { title: '类型', dataIndex: 'kind', width: 90, render: (v: VersionKind) => v === 'draft' ? '草稿' : '签署版' },
                { title: '版本', dataIndex: 'version_no', width: 80, render: (v: number, r: DocumentVersion) => <Space>{`v${v}`}{r.is_current ? <Tag color="green">当前</Tag> : null}</Space> },
                { title: '文件', dataIndex: 'file_name', render: (v: string, r: DocumentVersion) => <a href={r.file_url} target="_blank">{v || r.file_url}</a> },
                { title: '大小', dataIndex: 'file_size', width: 90, render: fileSize },
                { title: '备注', dataIndex: 'notes', render: (v: string) => v || '-' },
                { title: '创建时间', dataIndex: 'created_at', width: 145, render: fmtDate },
                { title: '操作', width: 120, render: (_: any, r: DocumentVersion) => r.kind === 'signed' && !r.is_current && canWrite ? <Button size="small" onClick={() => setCurrentSigned(r)}>设为当前</Button> : null },
              ] as any}
            />
          </>
        ) : null}
      </Drawer>

      <Modal title="上传签署版 PDF" open={uploadOpen} onCancel={() => setUploadOpen(false)} onOk={uploadSigned} confirmLoading={saving} okText="上传" cancelText="取消">
        <Form form={uploadForm} layout="vertical">
          <Form.Item name="file" label="签署 PDF" valuePropName="fileList" getValueFromEvent={(e) => Array.isArray(e) ? e : e?.fileList} rules={[{ required: true, message: '请选择 PDF 文件' }]}>
            <Upload {...uploadProps}><Button>选择 PDF</Button></Upload>
          </Form.Item>
          <Form.Item name="notes" label="备注"><Input.TextArea rows={2} placeholder="例如：房东已签字，2026-05-07 收到" /></Form.Item>
        </Form>
      </Modal>

      <Modal
        title={mzSignTarget ? 'MZ 签署' : '设置我方默认签名'}
        open={mzSignOpen}
        onCancel={() => setMzSignOpen(false)}
        onOk={submitMzSign}
        confirmLoading={saving}
        okText={mzSignTarget ? '确认签署' : '保存默认签名'}
        cancelText="取消"
        width={720}
      >
        <Form form={mzSignForm} layout="vertical">
          <Form.Item name="signed_name" label="签署人姓名" rules={[{ required: true, message: '请填写签署人姓名' }]}>
            <Input />
          </Form.Item>
          <Form.Item label="手写签名" required extra={mzSignTarget ? '请在下方完成 MZ 签名，系统会刷新草稿 PDF。' : '默认签名保存后，后续“我方签署”会自动复用。'}>
            <SignaturePad ref={mzSignPadRef} />
            <Space style={{ marginTop: 8 }}>
              <Button onClick={() => mzSignPadRef.current?.clear()}>清空签名</Button>
              {defaultMzSignature ? <Button danger onClick={() => { saveStoredMzSignature(null); mzSignPadRef.current?.clear(); message.success('默认签名已清除') }}>清除默认签名</Button> : null}
            </Space>
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="房东签署链接"
        open={linkOpen}
        onCancel={() => setLinkOpen(false)}
        footer={<Button type="primary" onClick={() => setLinkOpen(false)}>关闭</Button>}
        width={760}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Input value={signLink} readOnly />
          <div>有效期至：{signLinkExpiresAt ? dayjs(signLinkExpiresAt).format('YYYY-MM-DD HH:mm') : '-'}</div>
          <Space>
            <Button onClick={() => { navigator.clipboard?.writeText?.(signLink); message.success('已复制') }}>复制链接</Button>
            <Button type="primary" href={signLink} target="_blank">打开签署页</Button>
          </Space>
        </Space>
      </Modal>

      <Drawer
        title="PDF 预览"
        open={previewOpen}
        onClose={closePreview}
        width={980}
        extra={(
          <Space>
            {canWrite ? <Button disabled={!previewDoc || previewDoc.status === 'signed'} loading={saving} onClick={() => previewDoc ? applyDefaultMzSign(previewDoc) : undefined}>我方签署</Button> : null}
            {canWrite ? <Button disabled={!previewDoc || previewDoc.status === 'signed'} loading={saving} onClick={() => previewDoc ? requestLandlordSign(previewDoc) : undefined}>发给房东</Button> : null}
            <Button disabled={!previewDoc} onClick={() => previewDoc ? downloadDraft(previewDoc) : undefined}>下载 PDF</Button>
          </Space>
        )}
      >
        {previewUrl ? <iframe title="PDF 预览" src={previewUrl} style={{ width: '100%', height: 'calc(100vh - 150px)', border: 0 }} /> : null}
      </Drawer>
    </Card>
  )
}

function AuthorityFields({
  form,
  hydrateDateFields,
  properties,
  landlords,
  propertyOptions,
  sourceContracts,
  sourceContractOptions,
  addrOptions,
  onAddrSearch,
}: {
  form: any
  hydrateDateFields: (f: Record<string, any>) => Record<string, any>
  properties: PropertyLite[]
  landlords: LandlordLite[]
  propertyOptions: { value: string; label: string }[]
  sourceContracts: LandlordDocument[]
  sourceContractOptions: { value: string; label: string }[]
  addrOptions: { value: string; label: string }[]
  onAddrSearch: (input: string) => void
}) {
  const selectedPropertyId = Form.useWatch('property_id', form)
  function resolveLandlordForProperty(property?: PropertyLite | null) {
    if (!property) return null
    const linked = landlords.find((x) => Array.isArray(x.property_ids) && x.property_ids.some((pid) => String(pid) === String(property.id)))
    if (linked) return linked
    if (property.landlord_id) {
      const direct = landlords.find((x) => x.id === property.landlord_id)
      if (direct) return direct
    }
    return null
  }
  useEffect(() => {
    const f = form.getFieldValue('fields') || {}
    form.setFieldsValue({ fields: hydrateDateFields(f) })
  }, [])
  function fillFromProperty(id: string) {
    const property = properties.find((x) => x.id === id)
    if (!property) return
    const landlord = resolveLandlordForProperty(property)
    const landlordEmail = String(landlord?.emails?.[0] || landlord?.email || '').trim()
    form.setFieldsValue({
      property_id: property.id,
      landlord_id: landlord?.id || property.landlord_id || null,
      fields: {
        ...(form.getFieldValue('fields') || {}),
        landlord_name: landlord?.name || '',
        landlord_email: landlordEmail,
        landlord_phone: landlord?.phone || '',
        landlord_abn: landlord?.abn || '',
        property_address: property.address || '',
        property_code: property.code || '',
      },
    })
  }
  useEffect(() => {
    if (!selectedPropertyId) return
    const property = properties.find((x) => x.id === selectedPropertyId)
    if (!property) return
    const landlordReady = !!resolveLandlordForProperty(property)
    if (!landlordReady) return
    fillFromProperty(String(selectedPropertyId))
  }, [selectedPropertyId, properties, landlords, form])
  function fillFromContract(id: string) {
    const doc = sourceContracts.find((x) => x.id === id)
    const f = doc?.fields || {}
    if (!doc) return
    form.setFieldsValue({
      property_id: doc.property_id || null,
      landlord_id: doc.landlord_id || null,
      fields: {
        ...(form.getFieldValue('fields') || {}),
        source_contract_id: id,
        landlord_name: f.owner_name || f.landlord_name || '',
        landlord_email: f.owner_email || f.landlord_email || '',
        landlord_phone: f.owner_phone || f.landlord_phone || '',
        property_address: f.property_address || '',
      },
    })
  }
  const selectedProperty = properties.find((x) => x.id === selectedPropertyId)
  const selectedLandlord = resolveLandlordForProperty(selectedProperty) || landlords.find((x) => x.id === form.getFieldValue('landlord_id'))
  const landlordEmail = String(selectedLandlord?.emails?.[0] || selectedLandlord?.email || form.getFieldValue(['fields', 'landlord_email']) || '').trim() || '-'
  const landlordName = String(selectedLandlord?.name || form.getFieldValue(['fields', 'landlord_name']) || '').trim() || '-'
  const landlordPhone = String(selectedLandlord?.phone || form.getFieldValue(['fields', 'landlord_phone']) || '').trim() || '-'
  const landlordAbn = String(selectedLandlord?.abn || form.getFieldValue(['fields', 'landlord_abn']) || '').trim() || '-'
  return (
    <>
      <Form.Item name="landlord_id" hidden><Input /></Form.Item>
      <Divider orientation="left">从已有房源带入</Divider>
      <Row gutter={12}>
        <Col span={24}>
          <Form.Item name="property_id" label="已有房源">
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder="选择已有房源，自动带入房东信息和房源地址"
              options={propertyOptions}
              onChange={(v) => v ? fillFromProperty(String(v)) : form.setFieldsValue({ property_id: null, landlord_id: null })}
            />
          </Form.Item>
        </Col>
      </Row>
      {selectedPropertyId ? (
        <Descriptions
          size="small"
          bordered
          column={2}
          style={{ marginBottom: 16 }}
          items={[
            { key: 'landlord_name', label: '房东姓名', children: landlordName },
            { key: 'landlord_email', label: '房东邮箱', children: landlordEmail },
            { key: 'landlord_phone', label: '房东电话', children: landlordPhone },
            { key: 'landlord_abn', label: '房东 ABN', children: landlordAbn },
          ]}
        />
      ) : null}
      <Divider orientation="left">从房源合同带入</Divider>
      <Row gutter={12}>
        <Col span={24}>
          <Form.Item name={['fields', 'source_contract_id']} label="房源合同">
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder="可选择已创建的房源合同，自动带入房东和房源地址"
              options={sourceContractOptions}
              onChange={(v) => v ? fillFromContract(String(v)) : undefined}
            />
          </Form.Item>
        </Col>
      </Row>
      <Divider orientation="left">房东信息</Divider>
      <Row gutter={12}>
        <Col span={12}><Form.Item name={['fields', 'landlord_name']} label="房东姓名" rules={[{ required: true, message: '请填写房东姓名' }]}><Input /></Form.Item></Col>
        <Col span={12}><Form.Item name={['fields', 'landlord_email']} label="房东邮箱"><Input /></Form.Item></Col>
        <Col span={12}><Form.Item name={['fields', 'landlord_phone']} label="房东电话"><Input /></Form.Item></Col>
        <Col span={12}><Form.Item name={['fields', 'landlord_abn']} label="房东 ABN"><Input /></Form.Item></Col>
      </Row>
      <Divider orientation="left">房源信息</Divider>
      <Row gutter={12}>
        <Col span={24}>
          <Form.Item name={['fields', 'property_address']} label="房源地址（墨尔本）" rules={[{ required: true, message: '请填写房源地址' }]} extra="输入门牌号和街道，会优先提示 Melbourne / VIC / Australia 地址。">
            <AutoComplete options={addrOptions} onSearch={onAddrSearch}>
              <Input placeholder="例如：18 Hoff Boulevard, Southbank VIC 3006, Australia" />
            </AutoComplete>
          </Form.Item>
        </Col>
      </Row>
      <Divider orientation="left">授权设置</Divider>
      <Row gutter={12}>
        <Col span={8}><Form.Item name={['fields', 'termination_notice_days']} label="终止通知天数"><Input /></Form.Item></Col>
        <Col span={8}><Form.Item name={['fields', 'repair_approval_limit']} label="维修免批额度"><Input addonBefore="AUD $" /></Form.Item></Col>
        <Col span={8}><Form.Item name={['fields', 'sign_date']} label="签署日期"><DatePicker style={{ width: '100%' }} /></Form.Item></Col>
      </Row>
      <Divider orientation="left">MZ 联系信息</Divider>
      <Row gutter={12}>
        <Col span={8}><Form.Item name={['fields', 'mz_agent_name']} label="MZ 经办人"><Input /></Form.Item></Col>
        <Col span={8}><Form.Item name={['fields', 'mz_contact_phone']} label="MZ 电话"><Input /></Form.Item></Col>
        <Col span={8}><Form.Item name={['fields', 'mz_contact_email']} label="MZ 邮箱"><Input /></Form.Item></Col>
      </Row>
    </>
  )
}

function ServiceAgreementFields({
  form,
  hydrateDateFields,
  addrOptions,
  onAddrSearch,
}: {
  form: any
  hydrateDateFields: (f: Record<string, any>) => Record<string, any>
  addrOptions: { value: string; label: string }[]
  onAddrSearch: (input: string) => void
}) {
  useEffect(() => {
    const f = form.getFieldValue('fields') || {}
    form.setFieldsValue({ fields: hydrateDateFields(f) })
  }, [])
  return (
    <>
      <Divider orientation="left">Owner 信息</Divider>
      <Row gutter={12}>
        <Col span={8}><Form.Item name={['fields', 'owner_name']} label="Owner 姓名" rules={[{ required: true, message: '请填写 Owner 姓名' }]}><Input /></Form.Item></Col>
        <Col span={8}><Form.Item name={['fields', 'owner_phone']} label="Owner 电话"><Input /></Form.Item></Col>
        <Col span={8}><Form.Item name={['fields', 'owner_email']} label="Owner 邮箱"><Input /></Form.Item></Col>
      </Row>
      <Divider orientation="left">房源信息</Divider>
      <Row gutter={12}>
        <Col span={24}>
          <Form.Item name={['fields', 'property_address']} label="房源地址（墨尔本）" rules={[{ required: true, message: '请填写房源地址' }]} extra="输入门牌号和街道，会优先提示 Melbourne / VIC / Australia 地址。">
            <AutoComplete options={addrOptions} onSearch={onAddrSearch}>
              <Input placeholder="例如：18 Hoff Boulevard, Southbank VIC 3006, Australia" />
            </AutoComplete>
          </Form.Item>
        </Col>
        <Col span={12}><Form.Item name={['fields', 'property_type_description']} label="Property Type" rules={[{ required: true, message: 'Please select property type' }]}><Select showSearch optionFilterProp="label" placeholder="Select property type" options={propertyTypeOptions} /></Form.Item></Col>
        <Col span={12}><Form.Item name={['fields', 'investment_or_holiday']} label="Usage"><Input /></Form.Item></Col>
        <Col span={8}><Form.Item name={['fields', 'parking_available']} label="Parking"><Select options={parkingOptions} /></Form.Item></Col>
        <Form.Item noStyle shouldUpdate={(prev, cur) => prev?.fields?.parking_available !== cur?.fields?.parking_available}>
          {() => form.getFieldValue(['fields', 'parking_available']) !== 'no' ? (
            <>
              <Col span={8}><Form.Item name={['fields', 'parking_count']} label="Parking Spaces"><InputNumber min={1} max={10} style={{ width: '100%' }} /></Form.Item></Col>
              <Col span={8}><Form.Item name={['fields', 'parking_space_number']} label="Parking Notes"><Input placeholder="e.g. B2-17 / stacker parking / remote required" /></Form.Item></Col>
            </>
          ) : null}
        </Form.Item>
        <Col span={8}><Form.Item name={['fields', 'number_of_keys']} label="Keys / Fobs"><Input addonAfter="Set(s)" placeholder="e.g. 2" /></Form.Item></Col>
        <Col span={8}><Form.Item name={['fields', 'maximum_guests']} label="Maximum Guests"><Input /></Form.Item></Col>
        <Col span={8}><Form.Item name={['fields', 'minimum_nights']} label="Minimum Nights"><Input /></Form.Item></Col>
        <Col span={24}><Form.Item name={['fields', 'special_instructions']} label="Special Instructions"><Input /></Form.Item></Col>
      </Row>
      <Divider orientation="left">收款信息</Divider>
      <Row gutter={12}>
        <Col span={8}><Form.Item name={['fields', 'account_name']} label="Account Name"><Input /></Form.Item></Col>
        <Col span={8}><Form.Item name={['fields', 'bsb']} label="BSB"><Input /></Form.Item></Col>
        <Col span={8}><Form.Item name={['fields', 'account_number']} label="Account Number"><Input /></Form.Item></Col>
      </Row>
      <Divider orientation="left">合同信息</Divider>
      <Row gutter={12}>
        <Col span={8}><Form.Item name={['fields', 'commencement_date']} label="服务开始日期"><DatePicker style={{ width: '100%' }} /></Form.Item></Col>
        <Col span={16}><Form.Item name={['fields', 'term']} label="合同期限"><Input /></Form.Item></Col>
      </Row>
      <Divider orientation="left">费用设置</Divider>
      <Row gutter={12}>
        <Col span={8}><Form.Item name={['fields', 'setup_fee']} label="Setup Fee"><Input addonBefore="AUD $" /></Form.Item></Col>
        <Col span={8}><Form.Item name={['fields', 'management_fee']} label="Management Fee"><Input /></Form.Item></Col>
        <Col span={8}><Form.Item name={['fields', 'consumable_fee']} label="Consumable Fee"><Input addonBefore="AUD $" /></Form.Item></Col>
        <Col span={8}><Form.Item name={['fields', 'linen_fee']} label="Linen / Amenities"><Input /></Form.Item></Col>
        <Col span={8}><Form.Item name={['fields', 'initial_housekeeping_fee']} label="Initial Housekeeping"><Input addonBefore="AUD $" /></Form.Item></Col>
        <Col span={8}><Form.Item name={['fields', 'installation_fee']} label="Installation Fee"><Input addonBefore="AUD $" /></Form.Item></Col>
        <Col span={8}><Form.Item name={['fields', 'purchase_fee']} label="Purchase Fee"><Input addonBefore="AUD $" /></Form.Item></Col>
        <Col span={8}><Form.Item name={['fields', 'photography_fee']} label="Photography"><Input addonBefore="AUD $" /></Form.Item></Col>
      </Row>
      <Divider orientation="left">MZ 联系信息</Divider>
      <Row gutter={12}>
        <Col span={8}><Form.Item name={['fields', 'mz_company_name']} label="公司名称"><Input /></Form.Item></Col>
        <Col span={8}><Form.Item name={['fields', 'mz_company_abn']} label="ABN"><Input /></Form.Item></Col>
        <Col span={8}><Form.Item name={['fields', 'mz_agent_name']} label="MZ 经办人"><Input /></Form.Item></Col>
        <Col span={8}><Form.Item name={['fields', 'mz_contact_phone']} label="联系电话"><Input /></Form.Item></Col>
        <Col span={8}><Form.Item name={['fields', 'mz_contact_email']} label="邮箱"><Input /></Form.Item></Col>
        <Col span={24}><Form.Item name={['fields', 'mz_company_address']} label="公司地址"><Input /></Form.Item></Col>
      </Row>
    </>
  )
}
