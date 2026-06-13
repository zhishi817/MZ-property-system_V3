"use client"

import { AutoComplete, Button, Card, Col, DatePicker, Descriptions, Divider, Drawer, Dropdown, Form, Input, InputNumber, Modal, Row, Select, Space, Table, Tag, Upload, message } from 'antd'
import type { MenuProps, UploadProps } from 'antd'
import dayjs from 'dayjs'
import { useEffect, useMemo, useRef, useState } from 'react'
import { API_BASE, authHeaders, deleteJSON, getJSON, patchJSON, postJSON } from '../../../lib/api'
import { hasPerm } from '../../../lib/auth'
import SignaturePad, { type SignaturePadHandle } from '../../../components/SignaturePad'
import TableRowActions from '../../../components/TableRowActions'

type DocumentType = 'agency_authority' | 'property_service_agreement'
type VersionKind = 'draft' | 'signed'
type ServiceAgreementVariant = 'management_standard' | 'management_sale' | 'leased_to_mz'
type AttachmentCategory = 'agency_contract' | 'condition_report'

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

type DocumentAttachment = {
  id: string
  document_id: string
  category: AttachmentCategory
  file_url: string
  file_name?: string
  file_size?: number
  content_type?: string
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
  attachments?: DocumentAttachment[]
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
const SERVICE_AGREEMENT_TEMPLATE_VERSION = 'service-agreement-v4-2026-05-21'
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const ATTACHMENT_ACCEPT = '.pdf,.doc,.docx,.jpg,.jpeg,.png'

const serviceAgreementVariantText: Record<ServiceAgreementVariant, string> = {
  management_standard: '正常管理费短租',
  management_sale: '边卖边做短租',
  leased_to_mz: '中介包租给我们',
}

const serviceAgreementVariantOptions = [
  { value: 'management_standard', label: serviceAgreementVariantText.management_standard },
  { value: 'management_sale', label: serviceAgreementVariantText.management_sale },
  { value: 'leased_to_mz', label: serviceAgreementVariantText.leased_to_mz },
]

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

function normalizeEmailList(value: any): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const push = (item: any) => {
    if (item == null) return
    if (Array.isArray(item)) {
      item.forEach(push)
      return
    }
    const raw = String(item ?? '').trim()
    if (!raw) return
    if ((raw.startsWith('[') && raw.endsWith(']')) || (raw.startsWith('"') && raw.endsWith('"'))) {
      try {
        push(JSON.parse(raw))
        return
      } catch {}
    }
    const parts = raw
      .split(/[\n,;，；]+/g)
      .map((x) => x.trim())
      .filter(Boolean)
    for (const part of parts) {
      const cleaned = part.replace(/^[\s["']+|[\s"'\]]+$/g, '').trim()
      if (!cleaned) continue
      const key = cleaned.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(cleaned)
    }
  }
  push(value)
  return out
}

function formatEmailList(value: any, fallback = '-') {
  const emails = normalizeEmailList(value)
  return emails.length ? emails.join(', ') : fallback
}

function formatPropertyDisplay(code: any, address: any, fallback = '-') {
  const propertyCode = String(code || '').trim()
  const propertyAddress = String(address || '').trim()
  const text = [propertyCode, propertyAddress].filter(Boolean).join(' / ')
  return text || fallback
}

function normalizeServiceAgreementVariant(value: any): ServiceAgreementVariant {
  const raw = String(value || '').trim()
  if (raw === 'management_sale' || raw === 'leased_to_mz') return raw
  return 'management_standard'
}

function defaultManagementFeePercent(variant: ServiceAgreementVariant) {
  if (variant === 'management_sale') return 50
  if (variant === 'leased_to_mz') return null
  return 18.5
}

function normalizePercentInput(value: any) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function percentToRate(value: any) {
  const n = normalizePercentInput(value)
  if (n == null) return null
  if (n <= 1) return n
  return n / 100
}

function rateToPercent(value: any) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return null
  return n <= 1 ? Number((n * 100).toFixed(3)) : n
}

function formatManagementFeeText(rate: number | null) {
  if (!(typeof rate === 'number' && Number.isFinite(rate) && rate > 0)) return ''
  const pct = Number((rate * 100).toFixed(3))
  return `${String(pct).replace(/\.0+$/,'').replace(/(\.\d*?)0+$/,'$1')}% of Net Rental Income`
}

function parseManagementFeeTextToPercent(value: any) {
  const raw = String(value || '').trim()
  if (!raw) return null
  const m = raw.match(/(\d+(?:\.\d+)?)/)
  return m ? Number(m[1]) : null
}

function isLeasedVariant(value: any) {
  return normalizeServiceAgreementVariant(value) === 'leased_to_mz'
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
  const [templateDownloading, setTemplateDownloading] = useState('')
  const [mzSignForm] = Form.useForm()
  const mzSignPadRef = useRef<SignaturePadHandle | null>(null)
  const submitLockRef = useRef(false)
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
    const label = [
      r.document_no,
      f.owner_name || f.landlord_name,
      formatPropertyDisplay(r.property_code || f.property_code, r.property_address || f.property_address, ''),
    ].filter(Boolean).join(' / ')
    return { value: r.id, label: label || r.id }
  }), [sourceContracts])

  const propertyOptions = useMemo(() => properties.map((p) => {
    const label = formatPropertyDisplay(p.code, p.address, p.id)
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
    setSourceContracts((Array.isArray(list) ? list : []).filter((x) => !isLeasedVariant(x.fields?.contract_variant)))
  }

  async function loadDocumentReferences() {
    if (type !== 'agency_authority' && type !== 'property_service_agreement') return
    const [propertyList, landlordList] = await Promise.all([
      getJSON<PropertyLite[]>('/properties').catch(() => []),
      getJSON<LandlordLite[]>('/landlords').catch(() => []),
    ])
    setProperties(Array.isArray(propertyList) ? propertyList : [])
    setLandlords(Array.isArray(landlordList) ? landlordList : [])
  }

  useEffect(() => { loadSourceContracts() }, [type])
  useEffect(() => { loadDocumentReferences() }, [type])
  useEffect(() => { load() }, [type, status])
  useEffect(() => { setDefaultMzSignature(loadStoredMzSignature()) }, [])
  useEffect(() => { setCanWrite(hasPerm('landlord.manage')) }, [])

  function defaultFields() {
    const baseRate = defaultManagementFeePercent('management_standard')
    const fields: Record<string, any> = {
      contract_variant: 'management_standard',
      landlord_name: '',
      landlord_email: [],
      landlord_phone: '',
      owner_name: '',
      owner_email: [],
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
      term: 'Ongoing with 60 days termination notice',
      initial_property_visit: 'Included',
      setup_fee: '0.00',
      management_fee_rate: baseRate,
      management_fee: formatManagementFeeText(percentToRate(baseRate)),
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

  async function openEdit(row: LandlordDocument) {
    const full = await getJSON<LandlordDocument>(`/landlord-documents/${row.id}`).catch(() => row)
    setEditing(full)
    form.resetFields()
    const hydratedFields = hydrateDateFields(full.fields || {})
    form.setFieldsValue({
      landlord_id: full.landlord_id || null,
      property_id: full.property_id || null,
      notes: full.notes || undefined,
      fields: {
        ...hydratedFields,
        ...(type === 'agency_authority' ? { landlord_email: normalizeEmailList(hydratedFields.landlord_email) } : {}),
        ...(type === 'property_service_agreement' ? { owner_email: normalizeEmailList(hydratedFields.owner_email) } : {}),
      },
    })
    setEditorOpen(true)
  }

  async function openDetail(row: LandlordDocument) {
    const full = await getJSON<LandlordDocument>(`/landlord-documents/${row.id}`).catch(() => row)
    setDetail(full)
    setDetailOpen(true)
  }

  async function submit() {
    if (submitLockRef.current) return
    submitLockRef.current = true
    setSaving(true)
    try {
      const v = await form.validateFields()
      const payload = {
        type,
        landlord_id: v.landlord_id || null,
        property_id: v.property_id || null,
        notes: v.notes || null,
        fields: applyAutoMzSignature(normalizeFormFields(v.fields || {})),
      }
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
      submitLockRef.current = false
      setSaving(false)
    }
  }

  function normalizeFormFields(fields: Record<string, any>) {
    const out: Record<string, any> = { ...fields }
    for (const k of ['sign_date', 'commencement_date']) {
      if (out[k] && dayjs.isDayjs(out[k])) out[k] = out[k].format('YYYY-MM-DD')
    }
    if ('landlord_email' in out) out.landlord_email = normalizeEmailList(out.landlord_email)
    if ('owner_email' in out) out.owner_email = normalizeEmailList(out.owner_email)
    if (type === 'property_service_agreement') {
      const variant = normalizeServiceAgreementVariant(out.contract_variant)
      out.contract_variant = variant
      const rate = variant === 'leased_to_mz' ? null : percentToRate(out.management_fee_rate ?? defaultManagementFeePercent(variant))
      out.management_fee_rate = rate
      out.management_fee = variant === 'leased_to_mz' ? '' : formatManagementFeeText(rate)
    }
    out.parking_details = buildParkingDetails(out)
    out.number_of_keys = normalizeKeySets(out.number_of_keys)
    return out
  }

  function applyAutoMzSignature(fields: Record<string, any>) {
    const out: Record<string, any> = { ...fields }
    const signedName = String(out.mz_signed_name || defaultMzSignature?.signed_name || out.mz_agent_name || 'MZ Property').trim()
    if (!String(out.mz_signed_name || '').trim()) out.mz_signed_name = signedName
    if (!String(out.mz_signed_at || '').trim()) {
      out.mz_signed_at = String(out.sign_date || out.commencement_date || new Date().toISOString()).trim()
    }
    if (!String(out.mz_signature_data_url || '').trim() && defaultMzSignature?.signature_data_url) {
      out.mz_signature_data_url = defaultMzSignature.signature_data_url
    }
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
    if (type === 'property_service_agreement') {
      const variant = normalizeServiceAgreementVariant(out.contract_variant)
      out.contract_variant = variant
      out.owner_email = normalizeEmailList(out.owner_email)
      out.management_fee_rate = rateToPercent(out.management_fee_rate) ?? parseManagementFeeTextToPercent(out.management_fee) ?? defaultManagementFeePercent(variant)
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

  function needsServiceAgreementDraftRefresh(row: LandlordDocument) {
    if (row.type !== 'property_service_agreement') return false
    if (row.status === 'signed' || row.status === 'archived') return false
    if (isLeasedVariant(row.fields?.contract_variant)) return false
    if (!row.current_draft_url) return false
    return String(row.fields?.property_service_agreement_template_version || '') !== SERVICE_AGREEMENT_TEMPLATE_VERSION
  }

  async function openPreview(row: LandlordDocument) {
    try {
      if (row.type === 'property_service_agreement' && isLeasedVariant(row.fields?.contract_variant)) {
        message.warning('该类型合同仅支持上传附件，不生成 PDF')
        return
      }
      const target = await ensureDraft(row, needsAuthorityDraftRefresh(row) || needsServiceAgreementDraftRefresh(row))
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
      if (row.type === 'property_service_agreement' && isLeasedVariant(row.fields?.contract_variant)) {
        message.warning('该类型合同没有草稿 PDF')
        return
      }
      const target = await ensureDraft(row, needsAuthorityDraftRefresh(row) || needsServiceAgreementDraftRefresh(row))
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
      message.error(String(e?.message || '生成签署链接失败'))
    } finally {
      setSaving(false)
    }
  }

  async function uploadSigned() {
    if (!uploadTarget?.id) return
    const isReplacing = Boolean(uploadTarget.current_signed_url)
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
      message.success(isReplacing ? '签署版已重新上传，可在详情删除旧版本' : '签署版已上传')
      setUploadOpen(false)
      await load()
      if (detail?.id === uploadTarget.id) await openDetail(uploadTarget)
    } catch (e: any) {
      message.error(e?.message || '上传失败')
    } finally {
      setSaving(false)
    }
  }

  async function uploadLeasedAttachment(row: LandlordDocument, category: AttachmentCategory, file: File) {
    const fd = new FormData()
    fd.append('file', file)
    fd.append('category', category)
    setSaving(true)
    try {
      const res = await fetch(`${API_BASE}/landlord-documents/${row.id}/attachments/upload`, {
        method: 'POST',
        headers: authHeaders(),
        body: fd,
      })
      if (!res.ok) {
        const j = await res.json().catch(() => null)
        throw new Error(j?.message || '上传失败')
      }
      const j = await res.json().catch(() => null)
      const next = (j?.document || await getJSON<LandlordDocument>(`/landlord-documents/${row.id}`).catch(() => row)) as LandlordDocument
      setEditing((prev) => prev?.id === row.id ? next : prev)
      setDetail((prev) => prev?.id === row.id ? next : prev)
      await load()
      message.success('附件已上传')
    } catch (e: any) {
      message.error(e?.message || '上传失败')
    } finally {
      setSaving(false)
    }
  }

  async function deleteLeasedAttachment(row: LandlordDocument, attachment: DocumentAttachment) {
    setSaving(true)
    try {
      const res = await fetch(`${API_BASE}/landlord-documents/${row.id}/attachments/${attachment.id}`, {
        method: 'DELETE',
        headers: authHeaders(),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => null)
        throw new Error(j?.message || '删除失败')
      }
      const j = await res.json().catch(() => null)
      const next = (j?.document || await getJSON<LandlordDocument>(`/landlord-documents/${row.id}`).catch(() => row)) as LandlordDocument
      setEditing((prev) => prev?.id === row.id ? next : prev)
      setDetail((prev) => prev?.id === row.id ? next : prev)
      await load()
      message.success('附件已删除')
    } catch (e: any) {
      message.error(e?.message || '删除失败')
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

  async function deleteSignedVersion(version: DocumentVersion) {
    if (!detail?.id) return
    const documentId = detail.id
    Modal.confirm({
      title: '删除旧签署版？',
      content: `将删除签署版 v${version.version_no}，文件也会从存储中移除。`,
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      async onOk() {
        try {
          const r = await deleteJSON<{ document: LandlordDocument }>(`/landlord-documents/${documentId}/signed-versions/${version.id}`)
          message.success('旧签署版已删除')
          setDetail(r.document)
          await load()
        } catch (e: any) {
          message.error(e?.message || '删除失败')
        }
      },
    })
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

  async function downloadBlankTemplate(variant?: ServiceAgreementVariant) {
    const typeLabel = type === 'agency_authority'
      ? '授权协议'
      : (variant === 'management_sale' ? '边卖边做短租合同' : '正常管理费短租合同')
    setTemplateDownloading(variant || type)
    try {
      const qs = new URLSearchParams({ type })
      if (type === 'property_service_agreement' && variant) qs.set('variant', variant)
      const res = await fetch(`${API_BASE}/landlord-documents/templates/blank?${qs.toString()}`, { headers: authHeaders() })
      if (!res.ok) {
        const j = await res.json().catch(() => null)
        throw new Error(j?.message || '下载失败')
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = type === 'agency_authority'
        ? 'agency-authority-blank-template.pdf'
        : `service-agreement-blank-template-${variant === 'management_sale' ? 'sale' : 'standard'}.pdf`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      message.success(`${typeLabel}空白模版已下载`)
    } catch (e: any) {
      message.error(e?.message || '下载空白模版失败')
    } finally {
      setTemplateDownloading('')
    }
  }

  const columns = [
    { title: '编号', dataIndex: 'document_no', width: 150, render: (v: string) => v || '-' },
    {
      title: '合同类型',
      key: 'contract_variant',
      width: 150,
      render: (_: any, r: LandlordDocument) => r.type === 'property_service_agreement'
        ? <Tag>{serviceAgreementVariantText[normalizeServiceAgreementVariant(r.fields?.contract_variant)]}</Tag>
        : '-'
    },
    { title: '房东', dataIndex: 'landlord_name', width: 150, render: (_: any, r: LandlordDocument) => r.landlord_name || r.fields?.landlord_name || r.fields?.owner_name || '-' },
    { title: '房源', dataIndex: 'property_code', render: (_: any, r: LandlordDocument) => formatPropertyDisplay(r.property_code || r.fields?.property_code, r.property_address || r.fields?.property_address) },
    { title: '状态', dataIndex: 'status', width: 110, render: (v: string) => <Tag color={statusColor[v] || 'default'}>{statusText[v] || v}</Tag> },
    { title: '草稿', dataIndex: 'current_draft_url', width: 90, render: (v: string) => v ? <Tag color="blue">有</Tag> : <Tag>无</Tag> },
    { title: '签署版', dataIndex: 'current_signed_url', width: 90, render: (v: string) => v ? <Tag color="green">有</Tag> : <Tag>无</Tag> },
    { title: '更新', dataIndex: 'updated_at', width: 145, render: fmtDate },
    {
      title: '操作',
      key: 'actions',
      width: 520,
      render: (_: any, r: LandlordDocument) => (
        <TableRowActions
          actions={[
            { key: 'detail', label: '详情', onClick: () => openDetail(r) },
            { key: 'edit', label: '编辑', onClick: () => openEdit(r), hidden: !canWrite },
            {
              key: 'preview',
              label: '预览',
              onClick: () => openPreview(r),
              disabled: !r.current_draft_url && !canWrite,
              hidden: r.type === 'property_service_agreement' && isLeasedVariant(r.fields?.contract_variant),
            },
            {
              key: 'signed',
              label: r.current_signed_url ? '下载签署版' : '上传签署版',
              onClick: () => downloadSigned(r),
              hidden: !canWrite || (r.type === 'property_service_agreement' && isLeasedVariant(r.fields?.contract_variant)),
            },
            {
              key: 'replace-signed',
              label: '重新上传',
              onClick: () => openUpload(r),
              hidden: !canWrite || !r.current_signed_url || (r.type === 'property_service_agreement' && isLeasedVariant(r.fields?.contract_variant)),
            },
            { key: 'archive', label: '归档', onClick: () => archive(r), danger: true, disabled: r.status === 'archived', hidden: !canWrite },
          ]}
        />
      ),
    },
  ]

  const uploadProps: UploadProps = {
    accept: '.pdf,application/pdf',
    maxCount: 1,
    beforeUpload: () => false,
  }

  const blankTemplateMenu: MenuProps = {
    items: [
      { key: 'management_standard', label: '正常管理费短租' },
      { key: 'management_sale', label: '边卖边做短租' },
    ],
    onClick: ({ key }) => downloadBlankTemplate(key as ServiceAgreementVariant),
  }

  return (
      <Card
      title={title}
      extra={(
        <Space>
          {type === 'agency_authority' ? (
            <Button loading={templateDownloading === type} onClick={() => downloadBlankTemplate()}>下载空白模版</Button>
          ) : (
            <Dropdown menu={blankTemplateMenu} trigger={['click']}>
              <Button loading={templateDownloading === 'management_standard' || templateDownloading === 'management_sale'}>下载空白模版</Button>
            </Dropdown>
          )}
          {canWrite ? <Button onClick={() => openMzSign(null)}>设置我方默认签名</Button> : null}
          {canWrite ? <Button type="primary" onClick={openCreate}>新增{title}</Button> : null}
        </Space>
      )}
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
        extra={<Space><Button disabled={saving} onClick={() => setEditorOpen(false)}>取消</Button><Button type="primary" loading={saving} disabled={saving} onClick={submit}>保存</Button></Space>}
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
            <ServiceAgreementFields
              form={form}
              hydrateDateFields={hydrateDateFields}
              addrOptions={addrOptions}
              onAddrSearch={handleAddrSearch}
              properties={properties}
              landlords={landlords}
              propertyOptions={propertyOptions}
              currentDocument={editing}
              canWrite={canWrite}
              saving={saving}
              onUploadAttachment={uploadLeasedAttachment}
              onDeleteAttachment={deleteLeasedAttachment}
            />
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
              {detail.type === 'property_service_agreement' ? <Descriptions.Item label="合同类型">{serviceAgreementVariantText[normalizeServiceAgreementVariant(detail.fields?.contract_variant)]}</Descriptions.Item> : null}
              <Descriptions.Item label="房东">{detail.landlord_name || detail.fields?.landlord_name || detail.fields?.owner_name || '-'}</Descriptions.Item>
              <Descriptions.Item label="房源">{formatPropertyDisplay(detail.property_code || detail.fields?.property_code, detail.property_address || detail.fields?.property_address)}</Descriptions.Item>
              <Descriptions.Item label="MZ 签署">{detail.fields?.mz_signed_at ? `${detail.fields?.mz_signed_name || '-'} / ${String(detail.fields?.mz_signed_at || '').slice(0, 10)}` : '-'}</Descriptions.Item>
              <Descriptions.Item label="房东签署">{detail.fields?.landlord_signed_at ? `${detail.fields?.landlord_signed_name || '-'} / ${String(detail.fields?.landlord_signed_at || '').slice(0, 10)}` : '-'}</Descriptions.Item>
              <Descriptions.Item label="当前草稿">{detail.type === 'property_service_agreement' && isLeasedVariant(detail.fields?.contract_variant) ? '不适用' : (detail.current_draft_url ? <Button size="small" onClick={() => downloadDraft(detail)}>下载草稿</Button> : '-')}</Descriptions.Item>
              <Descriptions.Item label="当前签署版">
                {detail.type === 'property_service_agreement' && isLeasedVariant(detail.fields?.contract_variant) ? '不适用' : (
                  detail.current_signed_url ? (
                    <Space>
                      <Button size="small" onClick={() => downloadSigned(detail)}>下载签署版</Button>
                      {canWrite ? <Button size="small" onClick={() => openUpload(detail)}>重新上传</Button> : null}
                    </Space>
                  ) : (canWrite ? <Button size="small" onClick={() => openUpload(detail)}>上传签署版</Button> : '-')
                )}
              </Descriptions.Item>
              <Descriptions.Item label="备注" span={2}>{detail.notes || '-'}</Descriptions.Item>
            </Descriptions>
            {detail.type === 'property_service_agreement' && isLeasedVariant(detail.fields?.contract_variant) ? (
              <LeaseAttachmentSection
                document={detail}
                canWrite={canWrite}
                saving={saving}
                onUpload={uploadLeasedAttachment}
                onDelete={deleteLeasedAttachment}
              />
            ) : (
              <>
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
                    {
                      title: '操作',
                      width: 180,
                      render: (_: any, r: DocumentVersion) => r.kind === 'signed' && !r.is_current && canWrite ? (
                        <Space>
                          <Button size="small" onClick={() => setCurrentSigned(r)}>设为当前</Button>
                          <Button size="small" danger onClick={() => deleteSignedVersion(r)}>删除</Button>
                        </Space>
                      ) : null,
                    },
                  ] as any}
                />
              </>
            )}
          </>
        ) : null}
      </Drawer>

      <Modal
        title={uploadTarget?.current_signed_url ? '重新上传签署版 PDF' : '上传签署版 PDF'}
        open={uploadOpen}
        onCancel={() => setUploadOpen(false)}
        onOk={uploadSigned}
        confirmLoading={saving}
        okText={uploadTarget?.current_signed_url ? '重新上传' : '上传'}
        cancelText="取消"
      >
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
          <Form.Item label="手写签名" required extra={mzSignTarget ? '请在下方完成 MZ 签名，系统会刷新草稿 PDF。' : '默认签名保存后，新建的合同和授权协议会自动带上我方签名。'}>
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
  const currentLandlordEmailValue = Form.useWatch(['fields', 'landlord_email'], form)
  const currentPropertyCodeValue = Form.useWatch(['fields', 'property_code'], form)
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
    const landlordEmail = normalizeEmailList(Array.isArray(landlord?.emails) && landlord.emails.length ? landlord.emails : landlord?.email)
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
        landlord_email: normalizeEmailList(f.owner_email || f.landlord_email),
        landlord_phone: f.owner_phone || f.landlord_phone || '',
        property_code: doc.property_code || f.property_code || '',
        property_address: f.property_address || '',
      },
    })
  }
  const selectedProperty = properties.find((x) => x.id === selectedPropertyId)
  const selectedLandlord = resolveLandlordForProperty(selectedProperty) || landlords.find((x) => x.id === form.getFieldValue('landlord_id'))
  const landlordEmail = formatEmailList(
    (Array.isArray(selectedLandlord?.emails) && selectedLandlord.emails.length ? selectedLandlord.emails : selectedLandlord?.email)
      || currentLandlordEmailValue
  )
  const landlordName = String(selectedLandlord?.name || form.getFieldValue(['fields', 'landlord_name']) || '').trim() || '-'
  const landlordPhone = String(selectedLandlord?.phone || form.getFieldValue(['fields', 'landlord_phone']) || '').trim() || '-'
  const landlordAbn = String(selectedLandlord?.abn || form.getFieldValue(['fields', 'landlord_abn']) || '').trim() || '-'
  const propertyDisplay = formatPropertyDisplay(selectedProperty?.code || currentPropertyCodeValue, selectedProperty?.address || form.getFieldValue(['fields', 'property_address']))
  const hasPropertySummary = propertyDisplay !== '-'
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
      {selectedPropertyId || hasPropertySummary ? (
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
            { key: 'property', label: '房源', children: propertyDisplay },
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
        <Col span={12}><Form.Item
          name={['fields', 'landlord_email']}
          label="房东邮箱"
          rules={[{
            validator: (_, v) => normalizeEmailList(v).every((x) => EMAIL_RE.test(x))
              ? Promise.resolve()
              : Promise.reject('邮箱格式不正确')
          }]}
        >
          <Select mode="tags" tokenSeparators={[',', ';', '，', '；', ' ']} open={false} placeholder="输入后按回车，可添加多个邮箱" />
        </Form.Item></Col>
        <Col span={12}><Form.Item name={['fields', 'landlord_phone']} label="房东电话"><Input /></Form.Item></Col>
        <Col span={12}><Form.Item name={['fields', 'landlord_abn']} label="房东 ABN"><Input /></Form.Item></Col>
      </Row>
      <Divider orientation="left">房源信息</Divider>
      <Row gutter={12}>
        <Col span={24}>
          <Form.Item name={['fields', 'property_address']} label="房源地址（墨尔本）" rules={[{ required: true, message: '请填写房源地址' }]} extra="输入门牌号和街道，会优先提示 Melbourne / VIC / Australia 地址。">
            <AutoComplete options={addrOptions} onSearch={onAddrSearch}>
              <Input addonBefore={String(selectedProperty?.code || currentPropertyCodeValue || '').trim() || '房号'} placeholder="例如：18 Hoff Boulevard, Southbank VIC 3006, Australia" />
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
  properties,
  landlords,
  propertyOptions,
  currentDocument,
  canWrite,
  saving,
  onUploadAttachment,
  onDeleteAttachment,
}: {
  form: any
  hydrateDateFields: (f: Record<string, any>) => Record<string, any>
  addrOptions: { value: string; label: string }[]
  onAddrSearch: (input: string) => void
  properties: PropertyLite[]
  landlords: LandlordLite[]
  propertyOptions: { value: string; label: string }[]
  currentDocument: LandlordDocument | null
  canWrite: boolean
  saving: boolean
  onUploadAttachment: (row: LandlordDocument, category: AttachmentCategory, file: File) => Promise<void>
  onDeleteAttachment: (row: LandlordDocument, attachment: DocumentAttachment) => Promise<void>
}) {
  const selectedPropertyId = Form.useWatch('property_id', form)
  const watchedVariant = normalizeServiceAgreementVariant(Form.useWatch(['fields', 'contract_variant'], form))
  const variantRef = useRef<ServiceAgreementVariant | null>(null)
  const currentOwnerEmail = Form.useWatch(['fields', 'owner_email'], form)
  const currentPropertyCode = Form.useWatch(['fields', 'property_code'], form)
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
  useEffect(() => {
    const previous = variantRef.current
    const currentRate = form.getFieldValue(['fields', 'management_fee_rate'])
    const currentText = form.getFieldValue(['fields', 'management_fee'])
    if (watchedVariant === 'leased_to_mz') {
      form.setFieldsValue({ fields: { ...(form.getFieldValue('fields') || {}), contract_variant: watchedVariant, management_fee_rate: null, management_fee: '' } })
    } else {
      const pct = defaultManagementFeePercent(watchedVariant)
      const shouldReset = previous != null && previous !== watchedVariant
      if (shouldReset || (currentRate == null && !String(currentText || '').trim())) {
        form.setFieldsValue({
          fields: {
            ...(form.getFieldValue('fields') || {}),
            contract_variant: watchedVariant,
            management_fee_rate: pct,
            management_fee: formatManagementFeeText(percentToRate(pct)),
          },
        })
      }
    }
    variantRef.current = watchedVariant
  }, [watchedVariant, form])
  function fillFromProperty(id: string) {
    const property = properties.find((x) => x.id === id)
    if (!property) return
    const landlord = resolveLandlordForProperty(property)
    const ownerEmail = normalizeEmailList(Array.isArray(landlord?.emails) && landlord.emails.length ? landlord.emails : landlord?.email)
    form.setFieldsValue({
      property_id: property.id,
      landlord_id: landlord?.id || property.landlord_id || null,
      fields: {
        ...(form.getFieldValue('fields') || {}),
        owner_name: landlord?.name || '',
        owner_email: ownerEmail,
        owner_phone: landlord?.phone || '',
        account_name: landlord?.name || '',
        bsb: (landlord as any)?.payout_bsb || '',
        account_number: (landlord as any)?.payout_account || '',
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
  const selectedProperty = properties.find((x) => x.id === selectedPropertyId)
  const selectedLandlord = resolveLandlordForProperty(selectedProperty) || landlords.find((x) => x.id === form.getFieldValue('landlord_id'))
  const ownerEmail = formatEmailList(
    (Array.isArray(selectedLandlord?.emails) && selectedLandlord.emails.length ? selectedLandlord.emails : selectedLandlord?.email)
      || currentOwnerEmail
  )
  const ownerName = String(selectedLandlord?.name || form.getFieldValue(['fields', 'owner_name']) || '').trim() || '-'
  const ownerPhone = String(selectedLandlord?.phone || form.getFieldValue(['fields', 'owner_phone']) || '').trim() || '-'
  const propertyDisplay = formatPropertyDisplay(selectedProperty?.code || currentPropertyCode, selectedProperty?.address || form.getFieldValue(['fields', 'property_address']))
  const hasPropertySummary = propertyDisplay !== '-'
  const isLeased = watchedVariant === 'leased_to_mz'
  return (
    <>
      <Form.Item name="landlord_id" hidden><Input /></Form.Item>
      <Divider orientation="left">合同类型</Divider>
      <Row gutter={12}>
        <Col span={24}>
          <Form.Item name={['fields', 'contract_variant']} label="房源合同类型" rules={[{ required: true, message: '请选择合同类型' }]}>
            <Select options={serviceAgreementVariantOptions} />
          </Form.Item>
        </Col>
      </Row>
      <Divider orientation="left">从已有房源带入</Divider>
      <Row gutter={12}>
        <Col span={24}>
          <Form.Item
            name="property_id"
            label="已有房源"
            extra="如已有房源可直接选择自动带入；新房源可留空，下面手动填写房源编码、地址和房东信息。"
          >
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder="选择已有房源；如果是新房源，这里可以留空"
              options={propertyOptions}
              onChange={(v) => v ? fillFromProperty(String(v)) : form.setFieldsValue({ property_id: null, landlord_id: null })}
            />
          </Form.Item>
        </Col>
      </Row>
      {selectedPropertyId || hasPropertySummary ? (
        <Descriptions
          size="small"
          bordered
          column={2}
          style={{ marginBottom: 16 }}
          items={[
            { key: 'owner_name', label: '房东姓名', children: ownerName },
            { key: 'owner_email', label: '房东邮箱', children: ownerEmail },
            { key: 'owner_phone', label: '房东电话', children: ownerPhone },
            { key: 'property', label: '房源', children: propertyDisplay },
          ]}
        />
      ) : null}
      <Divider orientation="left">Owner 信息</Divider>
      <Row gutter={12}>
        <Col span={8}><Form.Item name={['fields', 'owner_name']} label="Owner 姓名" rules={[{ required: true, message: '请填写 Owner 姓名' }]}><Input /></Form.Item></Col>
        <Col span={8}><Form.Item name={['fields', 'owner_phone']} label="Owner 电话"><Input /></Form.Item></Col>
        <Col span={8}><Form.Item
          name={['fields', 'owner_email']}
          label="Owner 邮箱"
          rules={[{
            validator: (_, v) => normalizeEmailList(v).every((x) => EMAIL_RE.test(x))
              ? Promise.resolve()
              : Promise.reject('邮箱格式不正确')
          }]}
        ><Select mode="tags" tokenSeparators={[',', ';', '，', '；', ' ']} open={false} placeholder="输入后按回车，可添加多个邮箱" /></Form.Item></Col>
      </Row>
      <Divider orientation="left">房源信息</Divider>
      <Row gutter={12}>
        <Col span={12}>
          <Form.Item
            name={['fields', 'property_code']}
            label="房源编码"
            rules={selectedPropertyId ? [] : [{ required: true, message: '新房源请填写房源编码' }]}
            extra={selectedPropertyId ? '已从已有房源带入。' : '新房源请填写一个临时或正式房源编码，例如 MV1708。'}
          >
            <Input placeholder="例如：MV1708" readOnly={!!selectedPropertyId} />
          </Form.Item>
        </Col>
        <Col span={24}>
          <Form.Item name={['fields', 'property_address']} label="房源地址（墨尔本）" rules={[{ required: true, message: '请填写房源地址' }]} extra="输入门牌号和街道，会优先提示 Melbourne / VIC / Australia 地址。">
            <AutoComplete options={addrOptions} onSearch={onAddrSearch}>
              <Input addonBefore={String(selectedProperty?.code || currentPropertyCode || '').trim() || '房号'} placeholder="例如：18 Hoff Boulevard, Southbank VIC 3006, Australia" />
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
        {!isLeased ? (
          <>
            <Col span={8}><Form.Item name={['fields', 'number_of_keys']} label="Keys / Fobs"><Input addonAfter="Set(s)" placeholder="e.g. 2" /></Form.Item></Col>
            <Col span={8}><Form.Item name={['fields', 'maximum_guests']} label="Maximum Guests"><Input /></Form.Item></Col>
            <Col span={8}><Form.Item name={['fields', 'minimum_nights']} label="Minimum Nights"><Input /></Form.Item></Col>
            <Col span={24}><Form.Item name={['fields', 'special_instructions']} label="Special Instructions"><Input /></Form.Item></Col>
          </>
        ) : null}
      </Row>
      {isLeased ? (
        <LeaseAttachmentSection
          document={currentDocument}
          canWrite={canWrite}
          saving={saving}
          onUpload={onUploadAttachment}
          onDelete={onDeleteAttachment}
          emptyHint="先保存该记录，然后上传中介给我们的合同和 Condition Report。"
        />
      ) : (
        <>
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
            <Col span={8}><Form.Item name={['fields', 'management_fee_rate']} label="Management Fee (%)"><InputNumber min={0} max={100} precision={3} style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={8}><Form.Item name={['fields', 'management_fee']} label="Management Fee 文本"><Input readOnly /></Form.Item></Col>
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
      )}
    </>
  )
}

function LeaseAttachmentSection({
  document,
  canWrite,
  saving,
  onUpload,
  onDelete,
  emptyHint,
}: {
  document: LandlordDocument | null
  canWrite: boolean
  saving: boolean
  onUpload: (row: LandlordDocument, category: AttachmentCategory, file: File) => Promise<void>
  onDelete: (row: LandlordDocument, attachment: DocumentAttachment) => Promise<void>
  emptyHint?: string
}) {
  const groups: Record<AttachmentCategory, DocumentAttachment[]> = {
    agency_contract: (document?.attachments || []).filter((x) => x.category === 'agency_contract'),
    condition_report: (document?.attachments || []).filter((x) => x.category === 'condition_report'),
  }
  const items: Array<{ category: AttachmentCategory; title: string }> = [
    { category: 'agency_contract', title: '中介给我们的合同' },
    { category: 'condition_report', title: 'Condition Report' },
  ]
  return (
    <>
      <Divider orientation="left">附件归档</Divider>
      {!document?.id ? <div style={{ marginBottom: 12, color: '#667085' }}>{emptyHint || '请先保存记录，再上传附件。'}</div> : null}
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {items.map((item) => (
          <Card key={item.category} size="small" title={item.title}>
            <Space direction="vertical" size={8} style={{ width: '100%' }}>
              {document?.id && canWrite ? (
                <Upload
                  accept={ATTACHMENT_ACCEPT}
                  showUploadList={false}
                  customRequest={async ({ file, onSuccess, onError }) => {
                    try {
                      await onUpload(document, item.category, file as File)
                      onSuccess?.({}, file as any)
                    } catch (e) {
                      onError?.(e as any)
                    }
                  }}
                >
                  <Button loading={saving}>上传{item.title}</Button>
                </Upload>
              ) : <Button disabled>上传{item.title}</Button>}
              {groups[item.category].length ? groups[item.category].map((attachment) => (
                <Space key={attachment.id} style={{ justifyContent: 'space-between', width: '100%' }}>
                  <a href={attachment.file_url} target="_blank">{attachment.file_name || attachment.file_url}</a>
                  <Space>
                    <span style={{ color: '#667085' }}>{fmtDate(attachment.created_at)}</span>
                    {document?.id && canWrite ? <Button size="small" danger loading={saving} onClick={() => onDelete(document, attachment)}>删除</Button> : null}
                  </Space>
                </Space>
              )) : <div style={{ color: '#667085' }}>暂未上传</div>}
            </Space>
          </Card>
        ))}
      </Space>
    </>
  )
}
