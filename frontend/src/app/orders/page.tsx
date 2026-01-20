"use client"
import { Table, Card, Space, Button, Modal, Form, Input, DatePicker, Select, Tag, InputNumber, Checkbox, Upload, Radio, Calendar, App, Drawer, Descriptions, Tabs } from 'antd'
import { useRouter } from 'next/navigation'
import type { UploadProps } from 'antd'
import { useEffect, useState, useRef } from 'react'
import dayjs from 'dayjs'
import { API_BASE, getJSON, authHeaders } from '../../lib/api'
import { sortOrders } from '../../lib/orderSort'
import { monthSegments, getMonthSegmentsForProperty } from '../../lib/orders'
import { sortProperties } from '../../lib/properties'
import { hasPerm } from '../../lib/auth'

type Order = { id: string; source?: string; checkin?: string; checkout?: string; status?: string; property_id?: string; property_code?: string; confirmation_code?: string; guest_name?: string; guest_phone?: string; price?: number; cleaning_fee?: number; net_income?: number; avg_nightly_price?: number; nights?: number; email_header_at?: string }
// guest_phone 在后端已支持，这里表单也支持录入
type CleaningTask = { id: string; status: 'pending'|'scheduled'|'done' }
const debugOnce = (..._args: any[]) => {}

export default function OrdersPage() {
  const { message } = App.useApp()
  const router = useRouter()
  const [data, setData] = useState<Order[]>([])
  const [open, setOpen] = useState(false)
  const [form] = Form.useForm()
  const [editOpen, setEditOpen] = useState(false)
  const [editForm] = Form.useForm()
  const [current, setCurrent] = useState<Order | null>(null)
  const [codeQuery, setCodeQuery] = useState('')
  const [confQuery, setConfQuery] = useState('')
  const [dateRange, setDateRange] = useState<[any, any] | null>(null)
  const [properties, setProperties] = useState<{ id: string; code?: string; address?: string }[]>([])
  const [importOpen, setImportOpen] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importSummary, setImportSummary] = useState<{ inserted: number; skipped: number; reason_counts?: Record<string, number> } | null>(null)
  const [importResults, setImportResults] = useState<any[]>([])
  const [importErrors, setImportErrors] = useState<any[]>([])
  const [unmatched, setUnmatched] = useState<any[]>([])
  const [importPlatform, setImportPlatform] = useState<'airbnb'|'booking'|'other'>('airbnb')
  const [view, setView] = useState<'list'|'calendar'>('list')
  const [calMonth, setCalMonth] = useState(dayjs())
  const [calPid, setCalPid] = useState<string | undefined>(undefined)
  const calRef = useRef<HTMLDivElement | null>(null)
  const [monthFilter, setMonthFilter] = useState<any | null>(null)
  const [sortKey, setSortKey] = useState<'email_header_at'|'checkin'|'checkout'>('email_header_at')
  const [sortOrder, setSortOrder] = useState<'ascend'|'descend'>('descend')
  const [deductAmountEdit, setDeductAmountEdit] = useState<number>(0)
  const [deductDescEdit, setDeductDescEdit] = useState<string>('')
  const [deductNoteEdit, setDeductNoteEdit] = useState<string>('')
  const [detailOpen, setDetailOpen] = useState(false)
  const [detail, setDetail] = useState<Order | null>(null)
  const [detailDeductions, setDetailDeductions] = useState<any[]>([])
  const [detailDedAmount, setDetailDedAmount] = useState<number>(0)
  const [detailDedDesc, setDetailDedDesc] = useState<string>('')
  const [detailDedNote, setDetailDedNote] = useState<string>('')
  const [detailEditing, setDetailEditing] = useState<any | null>(null)
  const [detailLoading, setDetailLoading] = useState<boolean>(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewSamples, setPreviewSamples] = useState<any[]>([])
  const [previewStats, setPreviewStats] = useState<any | null>(null)
  const [previewFailures, setPreviewFailures] = useState<any[]>([])
  const [previewSkips, setPreviewSkips] = useState<any[]>([])
  const [previewDryRun, setPreviewDryRun] = useState<boolean>(true)
  const [previewJobId, setPreviewJobId] = useState<string>('')
  const [previewFailuresHistory, setPreviewFailuresHistory] = useState<any[]>([])
  const [previewAutoUids, setPreviewAutoUids] = useState<number[]>([])
  const [previewDay, setPreviewDay] = useState<any>(dayjs())
  const [previewUidsText, setPreviewUidsText] = useState<string>('')
  type PreviewRow = { confirmation_code?: string; guest_name?: string; listing_name?: string; checkin?: string; checkout?: string; nights?: number; youEarn?: number | null; cleaning_fee?: number | null; net_income?: number | null; avg_nightly_price?: number | null; property_match?: boolean }
  const [rows, setRows] = useState<PreviewRow[]>([])
  const [selfCheckOpen, setSelfCheckOpen] = useState(false)
  const [selfCheckLoading, setSelfCheckLoading] = useState(false)
  const [selfCheckData, setSelfCheckData] = useState<any | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [dupOpen, setDupOpen] = useState(false)
  const [dupLoading, setDupLoading] = useState(false)
  const [dupResult, setDupResult] = useState<any | null>(null)
  function getPropertyById(id?: string) { return (Array.isArray(properties) ? properties : []).find(p => p.id === id) }
  function getPropertyCodeLabel(o: Order) {
    const p = getPropertyById(o.property_id)
    const byCodeAsId = (Array.isArray(properties) ? properties : []).find(px => (px.code || '') === (o.property_id || ''))
    return (p?.code || byCodeAsId?.code || o.property_code || p?.address || o.property_id || '')
  }
  function toDayStr(raw?: any): string {
    const str = String(raw || '')
    if (/^\d{4}-\d{2}-\d{2}T/.test(str)) return dayjs(str).format('YYYY-MM-DD')
    const m = str.match(/^(\d{4}-\d{2}-\d{2})$/)
    return m ? m[1] : dayjs(str).format('YYYY-MM-DD')
  }
  function fmtDay(s?: string) {
    if (!s) return ''
    const ds = toDayStr(s)
    const d = dayjs(ds, 'YYYY-MM-DD', true)
    return d.isValid() ? d.format('DD/MM/YYYY') : s
  }
  const uploadProps: UploadProps = {
    customRequest: async (options: any) => {
      const { file, onSuccess, onError } = options || {}
      console.log('IMPORT CLICKED')
      console.log('CSV FILE', file)
      setImporting(true)
      try {
        const f: File = file as File
        const isCsv = (f.type || '').includes('csv') || (f.name || '').toLowerCase().endsWith('.csv')
        if (isCsv) {
          const text = await f.text()
          const headers = { 'Content-Type': 'text/csv', ...authHeaders() }
          console.log('CALLING IMPORT API', `${API_BASE}/orders/import?channel=${importPlatform}`)
          const res = await fetch(`${API_BASE}/orders/import?channel=${importPlatform}`, { method: 'POST', headers, body: text })
          const j = await res.json().catch(() => null)
          console.log('IMPORT API RESP', res.status, j)
          if (res.ok) {
            setImportSummary({ inserted: Number(j?.inserted || 0), skipped: Number(j?.skipped || 0), reason_counts: j?.reason_counts || {} })
            setImportResults(Array.isArray(j?.results) ? (j.results || []).slice(0, 20) : [])
            setImportErrors([])
            message.success(`导入完成：新增 ${j?.inserted || 0}，跳过 ${j?.skipped || 0}`)
            const list = Array.isArray(j?.results) ? j.results.filter((r:any)=> r && r.error === 'unmatched_property').map((r:any)=> ({ id: r.id, listing_name: r.listing_name, confirmation_code: r.confirmation_code, channel: r.source || 'unknown', reason: 'unmatched_property' })) : []
            setUnmatched(list)
            onSuccess && onSuccess(j, file)
            load()
          } else {
            onError && onError(j)
            message.error(j?.message || '导入失败')
          }
        } else {
          const reader = new FileReader()
          const b64: string = await new Promise((resolve) => { reader.onload = () => resolve(String(reader.result)); reader.readAsDataURL(f) })
          const headers = { 'Content-Type': 'application/json', ...authHeaders() }
          const payload = { platform: importPlatform, fileType: 'excel', fileContent: b64 }
          console.log('CALLING IMPORT API (excel)', `${API_BASE}/orders/actions/importBookings`)
          const res = await fetch(`${API_BASE}/orders/actions/importBookings`, { method: 'POST', headers, body: JSON.stringify(payload) })
          const j = await res.json().catch(() => null)
          console.log('IMPORT API RESP (excel)', res.status, j)
          if (res.ok) {
            const errors = Array.isArray(j?.errors) ? j.errors : []
            setImportSummary({ inserted: Number(j?.successCount || 0), skipped: Number(j?.errorCount || 0) })
            setImportResults([])
            setImportErrors(errors.slice(0, 200))
            message.success(`导入完成：新增 ${j?.successCount || 0}，失败 ${j?.errorCount || 0}`)
            const list = errors.filter((e:any)=> e?.reason === '找不到房号' || e?.reason === 'unmatched_property').map((e:any)=> ({ id: e.stagingId, listing_name: e.listing_name, confirmation_code: e.confirmation_code, channel: 'unknown', reason: 'unmatched_property' }))
            setUnmatched(list)
            onSuccess && onSuccess(j, file)
            load()
          } else {
            onError && onError(j)
            message.error(j?.message || '导入失败')
          }
        }
      } catch (err: any) {
        console.error('IMPORT ERROR', err)
        onError && onError(err)
        message.error('导入失败')
      }
      setImporting(false)
    },
    onChange(info) { console.log('UPLOAD CHANGE', info?.file?.status, info) },
    onDrop(e) { console.log('UPLOAD DROP', e?.dataTransfer?.files) },
    multiple: false,
    showUploadList: false,
    accept: '.csv,.xlsx,.xls,application/json,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel'
  }

  async function load() {
    const res = await getJSON<Order[]>('/orders')
    setData(res)
  }
  

  async function manualSyncOrders() {
    try {
      setSyncing(true)
      const body = { mode: 'incremental', max_per_run: 50, max_messages: 50, batch_size: 20, concurrency: 3, batch_sleep_ms: 500 }
      const res = await fetch(`${API_BASE}/jobs/email-sync/run`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(body) })
      const j = await res.json().catch(()=>null)
      if (res.status === 409) {
        const r = String(j?.reason||'')
        if (r==='cooldown') message.warning(`冷却中，cooldown_until=${String(j?.cooldown_until||'')}`)
        else if (r==='min_interval') message.warning(`未到最小间隔，next_allowed_at=${String(j?.next_allowed_at||'')}`)
        else message.warning(`有任务正在运行，运行开始时间=${String(j?.running_since||'')}`)
      }
      else if (res.status === 429) { message.warning(`冷却中，cooldown_until=${String(j?.cooldown_until||'')}`) }
      else if (res.ok) { message.success('已触发手动同步'); load() }
      else { message.error(j?.message || `触发失败（HTTP ${res.status}）`) }
    } catch { message.error('触发失败') } finally { setSyncing(false) }
  }
  async function previewTodayEmails() {
    if (previewLoading) return
    setPreviewOpen(true)
    setPreviewLoading(true)
    try {
      const body = previewDryRun
        ? { mode: 'preview', mel_day: previewDay.format('YYYY-MM-DD'), dry_run: true, batch_tag: 'airbnb_email_import_preview', max_messages: 50, limit: 200, job_timeout_ms: 60000, preview_limit: 20 }
        : { mode: 'backfill', from_date: previewDay.format('YYYY-MM-DD'), to_date: previewDay.format('YYYY-MM-DD'), dry_run: false, batch_tag: 'airbnb_email_import_preview', max_messages: 50, limit: 200, job_timeout_ms: 60000, preview_limit: 20 }
      const res = await fetch(`${API_BASE}/jobs/email-sync-airbnb`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(body) })
      const j = await res.json().catch(() => null)
      if (res.status === 409) {
        message.warning('正在同步中，请稍后再试')
      } else if (res.ok) {
        setPreviewStats((j?.summary || j) || {})
        setPreviewJobId(String(j?.job_id || ''))
        const arrDry = Array.isArray(j?.previewRows) ? j.previewRows : []
        const arrReal = Array.isArray(j?.insertedRows) ? j.insertedRows : []
        const baseArr = previewDryRun ? arrDry : arrReal
        const responseRows: PreviewRow[] = (Array.isArray(baseArr) ? baseArr : []).map((r: any) => ({
          confirmation_code: r?.confirmation_code ?? r?.code ?? null,
          guest_name: r?.guest_name ?? r?.guest ?? null,
          listing_name: r?.listing_name ?? r?.listing ?? null,
          checkin: r?.checkin ?? null,
          checkout: r?.checkout ?? null,
          nights: r?.nights ?? null,
          youEarn: r?.youEarn ?? r?.you_earn ?? r?.price ?? null,
          cleaning_fee: r?.cleaning_fee ?? null,
          net_income: r?.net_income ?? null,
          avg_nightly_price: r?.avg_nightly_price ?? null,
          property_match: r?.property_match ?? null,
        }))
        console.log('[email-sync-airbnb rows]', responseRows)
        setRows(responseRows)
        const fails = Array.isArray(j?.failures) ? j.failures : []
        setPreviewFailures(fails)
        const skips = Array.isArray(j?.skipped) ? j.skipped : []
        setPreviewSkips(skips)
        try {
          if (j?.job_id) {
            const r2 = await fetch(`${API_BASE}/jobs/runs/${encodeURIComponent(String(j.job_id))}/failures`, { headers: { ...authHeaders() } })
            const h = await r2.json().catch(()=>[])
            setPreviewFailuresHistory(Array.isArray(h) ? h : [])
          }
        } catch {}
        const s = (j?.summary || {})
        message.success(`预览完成：扫描 ${Number(s.scanned||0)}，命中 ${Number(s.matched||0)}，失败 ${Number(s.failed||0)}`)
        try {
          const counts: Record<string, number> = {}
          skips.forEach((x:any)=>{ const r = String(x?.reason||''); counts[r] = (counts[r]||0) + 1 })
          const parts = Object.keys(counts).map(k=> `${k}:${counts[k]}`)
          if (parts.length) message.info(`跳过 ${skips.length}（${parts.join(', ')}）`)
        } catch {}
      } else {
        let msg = (j && j.message) ? String(j.message) : `预览失败（HTTP ${res.status}）`
        if (/imap/i.test(msg)) msg = 'IMAP 连接失败'
        message.error(msg)
      }
    } catch {
      message.error('预览失败')
    } finally {
      setPreviewLoading(false)
    }
  }
  
  async function ingestAllAutoUids() {
    if (previewLoading) return
    const ids = Array.isArray(previewAutoUids) ? previewAutoUids : []
    if (!ids.length) { message.warning('无可导入 UID'); return }
    setPreviewLoading(true)
    try {
      const body = { mode: 'uids', uids: ids, dry_run: false, preview_limit: Math.max(20, ids.length), job_timeout_ms: 60000 }
      const res = await fetch(`${API_BASE}/jobs/email-sync-airbnb`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(body) })
      const j = await res.json().catch(() => null)
      if (res.ok) {
        setPreviewStats((j?.summary || j) || {})
        const arr = Array.isArray(j?.insertedRows) ? j.insertedRows : []
        const responseRows: PreviewRow[] = (Array.isArray(arr) ? arr : []).map((r: any) => ({
          confirmation_code: r?.confirmation_code ?? r?.code ?? null,
          guest_name: r?.guest_name ?? r?.guest ?? null,
          listing_name: r?.listing_name ?? r?.listing ?? null,
          checkin: r?.checkin ?? null,
          checkout: r?.checkout ?? null,
          nights: r?.nights ?? null,
          youEarn: r?.youEarn ?? r?.you_earn ?? r?.price ?? null,
          cleaning_fee: r?.cleaning_fee ?? null,
          net_income: r?.net_income ?? null,
          avg_nightly_price: r?.avg_nightly_price ?? null,
          property_match: r?.property_match ?? null,
        }))
        setRows(responseRows)
        const s = (j?.summary || {})
        message.success(`导入完成：扫描 ${Number(s.scanned||0)}，命中 ${Number(s.matched||0)}，新增 ${Number(s.inserted||0)}，重复 ${Number(s.duplicates||0)}，失败 ${Number(s.failed||0)}`)
        load()
      } else {
        let msg = (j && j.message) ? String(j.message) : `导入失败（HTTP ${res.status}）`
        message.error(msg)
      }
    } catch {
      message.error('导入失败')
    } finally { setPreviewLoading(false) }
  }
  async function previewByUids() {
    if (previewLoading) return
    const ids = String(previewUidsText || '')
      .split(',')
      .map(s => Number(s.trim()))
      .filter(n => Number.isFinite(n))
      .slice(0, 50)
    if (!ids.length) { message.warning('请输入 UID 列表，例如：74258,74259'); return }
    setPreviewOpen(true)
    setPreviewLoading(true)
    try {
      const body = { mode: 'uids', uids: ids, dry_run: true, preview_limit: Math.max(20, ids.length), job_timeout_ms: 60000 }
      const res = await fetch(`${API_BASE}/jobs/email-sync-airbnb`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(body) })
      const j = await res.json().catch(() => null)
      if (res.ok) {
        setPreviewStats((j?.summary || j) || {})
        setPreviewJobId(String(j?.job_id || ''))
        const arr = Array.isArray(j?.previewRows) ? j.previewRows : []
        const responseRows: PreviewRow[] = (Array.isArray(arr) ? arr : []).map((r: any) => ({
          confirmation_code: r?.confirmation_code ?? r?.code ?? null,
          guest_name: r?.guest_name ?? r?.guest ?? null,
          listing_name: r?.listing_name ?? r?.listing ?? null,
          checkin: r?.checkin ?? null,
          checkout: r?.checkout ?? null,
          nights: r?.nights ?? null,
          youEarn: r?.youEarn ?? r?.you_earn ?? r?.price ?? null,
          cleaning_fee: r?.cleaning_fee ?? null,
          net_income: r?.net_income ?? null,
          avg_nightly_price: r?.avg_nightly_price ?? null,
          property_match: r?.property_match ?? null,
        }))
        setRows(responseRows)
        const fails = Array.isArray(j?.failures) ? j.failures : []
        setPreviewFailures(fails)
        const skips = Array.isArray(j?.skipped) ? j.skipped : []
        setPreviewSkips(skips)
        const s = (j?.summary || {})
        message.success(`UID 预览完成：扫描 ${Number(s.scanned||0)}，命中 ${Number(s.matched||0)}，失败 ${Number(s.failed||0)}`)
      } else {
        let msg = (j && j.message) ? String(j.message) : `预览失败（HTTP ${res.status}）`
        message.error(msg)
      }
    } catch {
      message.error('预览失败')
    } finally {
      setPreviewLoading(false)
    }
  }
  async function ingestByUids() {
    if (previewLoading) return
    const ids = String(previewUidsText || '')
      .split(',')
      .map(s => Number(s.trim()))
      .filter(n => Number.isFinite(n))
      .slice(0, 50)
    if (!ids.length) { message.warning('请输入 UID 列表，例如：74258,74259'); return }
    setPreviewOpen(true)
    setPreviewLoading(true)
    try {
      const body = { mode: 'uids', uids: ids, dry_run: false, preview_limit: Math.max(20, ids.length), job_timeout_ms: 60000 }
      const res = await fetch(`${API_BASE}/jobs/email-sync-airbnb`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(body) })
      const j = await res.json().catch(() => null)
      if (res.ok) {
        setPreviewStats((j?.summary || j) || {})
        setPreviewJobId(String(j?.job_id || ''))
        const arr = Array.isArray(j?.insertedRows) ? j.insertedRows : []
        const responseRows: PreviewRow[] = (Array.isArray(arr) ? arr : []).map((r: any) => ({
          confirmation_code: r?.confirmation_code ?? r?.code ?? null,
          guest_name: r?.guest_name ?? r?.guest ?? null,
          listing_name: r?.listing_name ?? r?.listing ?? null,
          checkin: r?.checkin ?? null,
          checkout: r?.checkout ?? null,
          nights: r?.nights ?? null,
          youEarn: r?.youEarn ?? r?.you_earn ?? r?.price ?? null,
          cleaning_fee: r?.cleaning_fee ?? null,
          net_income: r?.net_income ?? null,
          avg_nightly_price: r?.avg_nightly_price ?? null,
          property_match: r?.property_match ?? null,
        }))
        setRows(responseRows)
        const fails = Array.isArray(j?.failures) ? j.failures : []
        setPreviewFailures(fails)
        const skips = Array.isArray(j?.skipped) ? j.skipped : []
        setPreviewSkips(skips)
        const s = (j?.summary || {})
        message.success(`UID 导入完成：扫描 ${Number(s.scanned||0)}，命中 ${Number(s.matched||0)}，新增 ${Number(s.inserted||0)}，重复 ${Number(s.duplicates||0)}，失败 ${Number(s.failed||0)}`)
        load()
      } else {
        let msg = (j && j.message) ? String(j.message) : `导入失败（HTTP ${res.status}）`
        message.error(msg)
      }
    } catch {
      message.error('导入失败')
    } finally {
      setPreviewLoading(false)
    }
  }
  async function previewAllMatchedUids() {
    if (previewLoading) return
    setPreviewLoading(true)
    try {
      const body = { mode: 'list_uids_first', first_limit: 50, preview_limit: 50, limit: 50, max_messages: 50, job_timeout_ms: 60000 }
      const res = await fetch(`${API_BASE}/jobs/email-sync-airbnb`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(body) })
      const j = await res.json().catch(() => null)
      if (res.status === 409) {
        await fetch(`${API_BASE}/jobs/email-sync-airbnb/unlock`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify({ scope: 'preview' }) }).catch(()=>{})
        const res2 = await fetch(`${API_BASE}/jobs/email-sync-airbnb`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(body) })
        const j2 = await res2.json().catch(()=>null)
        if (!res2.ok) { let msg = (j2 && j2.message) ? String(j2.message) : `拉取失败（HTTP ${res2.status}）`; message.error(msg); return }
        const ids2: number[] = Array.isArray(j2?.matched_uids) ? j2.matched_uids : []
        setPreviewAutoUids(ids2)
        const s2 = (j2?.summary || {})
        message.success(`拉取 UID（前200）：扫描 ${Number(s2.scanned||0)}，命中 ${ids2.length}`)
        const bodyPreview = { mode: 'uids', uids: ids2, dry_run: true, preview_limit: Math.max(20, ids2.length), job_timeout_ms: 60000 }
        const r3 = await fetch(`${API_BASE}/jobs/email-sync-airbnb`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(bodyPreview) })
        const j3 = await r3.json().catch(()=>null)
        if (!r3.ok) { let msg = (j3 && j3.message) ? String(j3.message) : `预览失败（HTTP ${r3.status}）`; message.error(msg); return }
        setPreviewStats((j3?.summary || j3) || {})
        setPreviewJobId(String(j3?.job_id || ''))
        const arr3 = Array.isArray(j3?.previewRows) ? j3.previewRows : []
        const responseRows3: PreviewRow[] = (Array.isArray(arr3) ? arr3 : []).map((r: any) => ({
          confirmation_code: r?.confirmation_code ?? r?.code ?? null,
          guest_name: r?.guest_name ?? r?.guest ?? null,
          listing_name: r?.listing_name ?? r?.listing ?? null,
          checkin: r?.checkin ?? null,
          checkout: r?.checkout ?? null,
          nights: r?.nights ?? null,
          youEarn: r?.youEarn ?? r?.you_earn ?? r?.price ?? null,
          cleaning_fee: r?.cleaning_fee ?? null,
          net_income: r?.net_income ?? null,
          avg_nightly_price: r?.avg_nightly_price ?? null,
          property_match: r?.property_match ?? null,
        }))
        setRows(responseRows3)
      } else if (res.ok) {
        const ids: number[] = Array.isArray(j?.matched_uids) ? j.matched_uids : []
        setPreviewAutoUids(ids)
        const s = (j?.summary || {})
        message.success(`拉取 UID（前200）：扫描 ${Number(s.scanned||0)}，命中 ${ids.length}`)
        const bodyPreview = { mode: 'uids', uids: ids, dry_run: true, preview_limit: Math.max(20, ids.length), job_timeout_ms: 60000 }
        const r3 = await fetch(`${API_BASE}/jobs/email-sync-airbnb`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(bodyPreview) })
        const j3 = await r3.json().catch(()=>null)
        if (!r3.ok) { let msg = (j3 && j3.message) ? String(j3.message) : `预览失败（HTTP ${r3.status}）`; message.error(msg); return }
        setPreviewStats((j3?.summary || j3) || {})
        setPreviewJobId(String(j3?.job_id || ''))
        const arr3 = Array.isArray(j3?.previewRows) ? j3.previewRows : []
        const responseRows3: PreviewRow[] = (Array.isArray(arr3) ? arr3 : []).map((r: any) => ({
          confirmation_code: r?.confirmation_code ?? r?.code ?? null,
          guest_name: r?.guest_name ?? r?.guest ?? null,
          listing_name: r?.listing_name ?? r?.listing ?? null,
          checkin: r?.checkin ?? null,
          checkout: r?.checkout ?? null,
          nights: r?.nights ?? null,
          youEarn: r?.youEarn ?? r?.you_earn ?? r?.price ?? null,
          cleaning_fee: r?.cleaning_fee ?? null,
          net_income: r?.net_income ?? null,
          avg_nightly_price: r?.avg_nightly_price ?? null,
          property_match: r?.property_match ?? null,
        }))
        setRows(responseRows3)
      } else {
        let msg = (j && j.message) ? String(j.message) : `拉取失败（HTTP ${res.status}）`
        message.error(msg)
      }
    } catch {
      message.error('拉取失败')
    } finally {
      setPreviewLoading(false)
    }
  }
  async function selfCheckUid(uid: number) {
    if (selfCheckLoading) return
    setSelfCheckOpen(true)
    setSelfCheckLoading(true)
    try {
      const body = { mode: 'single_uid', uid, dry_run: true, debug: true, dump_body_preview_len: 500 }
      const res = await fetch(`${API_BASE}/jobs/email-sync-airbnb`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(body) })
      const j = await res.json().catch(()=>null)
      if (res.ok) {
        setSelfCheckData(j || {})
        message.success(`自检完成：扫描 ${Number(j?.scanned||0)}，命中 ${Number(j?.matched||0)}，插入 ${Number(j?.inserted||0)}，失败 ${Number(j?.failed||0)}`)
      } else {
        message.error((j && j.message) ? String(j.message) : `自检失败（HTTP ${res.status}）`)
      }
    } catch {
      message.error('自检失败')
    } finally {
      setSelfCheckLoading(false)
    }
  }
  async function manualInsertFromEmail(rec: any) {
    try {
      const uid = Number(rec?.uid || 0)
      const message_id = String(rec?.message_id || rec?.id || '')
      if (!uid && !message_id) { message.warning('缺少UID或message_id'); return }
      const pid = (rec as any).__pid || ''
      const res = await fetch(`${API_BASE}/jobs/email-orders-raw/resolve`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify({ uid, message_id, property_id: pid }) })
      const j = await res.json().catch(()=>null)
      if (res.ok) { message.success('已手动插入订单'); openFailures(); load() } else { message.error(j?.message || `插入失败（HTTP ${res.status}）`) }
    } catch { message.error('插入失败') }
  }
  const [failOpen, setFailOpen] = useState(false)
  const [failLoading, setFailLoading] = useState(false)
  const [failRows, setFailRows] = useState<any[]>([])
  async function openFailures() {
    setFailOpen(true)
    setFailLoading(true)
    try {
      const res = await fetch(`${API_BASE}/jobs/email-orders-raw/failures?limit=200&since_days=14`, { headers: { ...authHeaders() } })
      if (!res.ok) {
        const ct = res.headers.get('content-type')||''
        const j = /application\/json/i.test(ct) ? await res.json().catch(()=>({})) : { message: await res.text().catch(()=>`HTTP ${res.status}`) }
        message.error(String((j as any)?.message || `拉取失败（HTTP ${res.status}）`))
        setFailRows([])
      } else {
        const j = await res.json().catch(()=>[])
        const arr = Array.isArray(j) ? j : []
        if (arr.length === 0) {
          const res2 = await fetch(`${API_BASE}/jobs/email-orders-raw/failures?limit=200&since_days=365`, { headers: { ...authHeaders() } })
          const j2 = await res2.json().catch(()=>[])
          setFailRows(Array.isArray(j2) ? j2 : [])
        } else {
          setFailRows(arr)
        }
      }
    } catch { message.error('拉取失败记录失败') }
    setFailLoading(false)
  }
  async function openDetail(record: Order | string) {
    if (typeof record !== 'string') setDetail(record)
    setDetailOpen(true)
    setDetailLoading(true)
    setDetailDedAmount(0); setDetailDedDesc(''); setDetailDedNote(''); setDetailEditing(null)
    const id = typeof record === 'string' ? record : record.id
    try {
      const [o, ds] = await Promise.all([
        getJSON<Order>(`/orders/${id}`).catch(() => null as any),
        fetch(`${API_BASE}/orders/${id}/internal-deductions`, { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } }).then(r => r.json()).catch(() => [])
      ])
      if (o) setDetail(o)
      setDetailDeductions(Array.isArray(ds) ? ds : [])
    } finally { setDetailLoading(false) }
  }
  async function saveDetailDeduction() {
    if (!detail) return
    const payload = { amount: detailDedAmount, item_desc: detailDedDesc, note: detailDedNote }
    const url = `${API_BASE}/orders/${detail.id}/internal-deductions${detailEditing ? `/${detailEditing.id}` : ''}`
    const method = detailEditing ? 'PATCH' : 'POST'
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(payload) })
    if (res.ok) { message.success('已保存'); openDetail(detail.id) } else { const j = await res.json().catch(()=>({})); message.error(j?.message || '保存失败') }
  }
  async function deleteDetailDeduction(rec: any) {
    if (!detail) return
    const res = await fetch(`${API_BASE}/orders/${detail.id}/internal-deductions/${rec.id}`, { method: 'DELETE', headers: { ...authHeaders() } })
    if (res.ok) { message.success('已删除'); openDetail(detail.id) } else { const j = await res.json().catch(()=>({})); message.error(j?.message || '删除失败') }
  }
  useEffect(() => { load(); getJSON<any>('/properties?include_archived=true').then((j) => setProperties(Array.isArray(j) ? j : [])).catch(() => setProperties([])) }, [])

  async function openEdit(o: Order) {
    setCurrent(o)
    // 先展示弹窗并填充当前行数据，提升交互稳定性
    setEditOpen(true)
    const pid0 = o.property_id
    const p0 = (Array.isArray(properties) ? properties : []).find(x => x.id === pid0)
    editForm.setFieldsValue({
      ...o,
      confirmation_code: o.confirmation_code || '',
      property_id: pid0,
      property_code: p0 ? (p0.code || p0.address || pid0) : o.property_code,
      price: o.price != null ? o.price : 0,
      cleaning_fee: o.cleaning_fee != null ? o.cleaning_fee : 0,
      checkin: o.checkin ? dayjs(o.checkin) : undefined,
      checkout: o.checkout ? dayjs(o.checkout) : undefined,
      status: o.status || 'confirmed',
      payment_currency: (o as any).payment_currency || 'AUD',
      guest_phone: (o as any).guest_phone || ''
    })
    // 再异步拉取完整数据并二次填充（失败时保持现有值）
    try {
      const full = await getJSON<Order>(`/orders/${o.id}`)
      const pid = full.property_id
      const p = (Array.isArray(properties) ? properties : []).find(x => x.id === pid)
      editForm.setFieldsValue({
        ...full,
        confirmation_code: (full as any).confirmation_code || '',
        property_id: pid,
        property_code: p ? (p.code || p.address || pid) : full.property_code,
        price: full.price != null ? full.price : 0,
        cleaning_fee: full.cleaning_fee != null ? full.cleaning_fee : 0,
        checkin: full.checkin ? dayjs(full.checkin) : undefined,
        checkout: full.checkout ? dayjs(full.checkout) : undefined,
        status: full.status || 'confirmed',
        payment_currency: (full as any).payment_currency || 'AUD',
        guest_phone: (full as any).guest_phone || ''
      })
      setDeductAmountEdit(0); setDeductDescEdit(''); setDeductNoteEdit('')
    } catch {
      message.warning('加载订单详情失败，使用列表数据进行编辑')
    }
  }

  async function genCleaning(id: string) {
    const res = await fetch(`${API_BASE}/orders/${id}/generate-cleaning`, { method: 'POST' })
    if (res.ok) { message.success('已生成清洁任务') } else { message.error('生成失败') }
  }

  async function submitCreate() {
    const v = await form.validateFields()
    const nights = v.checkin && v.checkout ? Math.max(0, dayjs(v.checkout).diff(dayjs(v.checkin), 'day')) : 0
    const price = Number(v.price || 0)
    const cleaning = Number(v.cleaning_fee || 0)
    const lateFee = v.late_checkout ? 20 : Number(v.late_checkout_fee || 0)
    const cancelFee = Number(v.cancel_fee || 0)
    const net = Math.max(0, price + lateFee + cancelFee - cleaning)
    const avg = nights > 0 ? Number((net / nights).toFixed(2)) : 0
    const selectedNew = (Array.isArray(properties) ? properties : []).find(p => p.id === v.property_id)
    const payload = {
      source: v.source,
      status: v.status || 'confirmed',
      property_id: v.property_id,
      property_code: v.property_code || selectedNew?.code || selectedNew?.address || v.property_id,
      confirmation_code: v.confirmation_code,
      guest_name: v.guest_name,
      guest_phone: v.guest_phone,
      checkin: v.checkin.format('YYYY-MM-DD') + 'T12:00:00',
      checkout: v.checkout.format('YYYY-MM-DD') + 'T11:59:59',
      price: Number(price).toFixed(2) ? Number(Number(price).toFixed(2)) : price,
      cleaning_fee: Number(cleaning).toFixed(2) ? Number(Number(cleaning).toFixed(2)) : cleaning,
      net_income: Number(net).toFixed(2) ? Number(Number(net).toFixed(2)) : net,
      avg_nightly_price: Number(avg).toFixed(2) ? Number(Number(avg).toFixed(2)) : avg,
      nights,
      currency: 'AUD',
    }
    setDupLoading(true)
    try {
      const pre = await fetch(`${API_BASE}/orders/validate-duplicate`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(payload) })
      const j = await pre.json().catch(()=>null)
      setDupResult(j || null)
      if (pre.ok && j?.is_duplicate) {
        setDupOpen(true)
        setDupLoading(false)
        return
      }
    } catch {}
    setDupLoading(false)
    const res = await fetch(`${API_BASE}/orders/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(payload) })
    if (res.status === 201) {
      const created = await res.json()
      async function writeIncome(amount: number, cat: string, note: string) {
        if (!amount || amount <= 0) return
        const tx = { kind: 'income', amount: Number(amount), currency: 'AUD', occurred_at: v.checkout.format('YYYY-MM-DD'), note, category: cat, property_id: v.property_id, ref_type: 'order', ref_id: created?.id }
        await fetch(`${API_BASE}/finance`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(tx) }).catch(() => {})
      }
      await writeIncome(lateFee, 'late_checkout', 'Late checkout income')
      if ((v.status || '') === 'canceled') await writeIncome(cancelFee, 'cancel_fee', 'Cancelation fee')
      message.success('订单已创建'); setOpen(false); form.resetFields(); load()
    }
    else if (res.status === 200) {
      message.error('订单已存在')
    } else {
      let msg = '创建失败'
      try { const j = await res.json(); if (j?.message) msg = j.message } catch { try { msg = await res.text() } catch {} }
      message.error(msg)
    }
  }

  async function proceedCreateForce() {
    const v = form.getFieldsValue()
    const nights = v.checkin && v.checkout ? Math.max(0, dayjs(v.checkout).diff(dayjs(v.checkin), 'day')) : 0
    const price = Number(v.price || 0)
    const cleaning = Number(v.cleaning_fee || 0)
    const lateFee = v.late_checkout ? 20 : Number(v.late_checkout_fee || 0)
    const cancelFee = Number(v.cancel_fee || 0)
    const net = Math.max(0, price + lateFee + cancelFee - cleaning)
    const avg = nights > 0 ? Number((net / nights).toFixed(2)) : 0
    const selectedNew = (Array.isArray(properties) ? properties : []).find(p => p.id === v.property_id)
    const payload = {
      source: v.source,
      status: v.status || 'confirmed',
      property_id: v.property_id,
      property_code: v.property_code || selectedNew?.code || selectedNew?.address || v.property_id,
      confirmation_code: v.confirmation_code,
      guest_name: v.guest_name,
      guest_phone: v.guest_phone,
      checkin: v.checkin.format('YYYY-MM-DD') + 'T12:00:00',
      checkout: v.checkout.format('YYYY-MM-DD') + 'T11:59:59',
      price: Number(price).toFixed(2) ? Number(Number(price).toFixed(2)) : price,
      cleaning_fee: Number(cleaning).toFixed(2) ? Number(Number(cleaning).toFixed(2)) : cleaning,
      net_income: Number(net).toFixed(2) ? Number(Number(net).toFixed(2)) : net,
      avg_nightly_price: Number(avg).toFixed(2) ? Number(Number(avg).toFixed(2)) : avg,
      nights,
      currency: 'AUD',
      force: true
    }
    const res = await fetch(`${API_BASE}/orders/sync?force=true`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(payload) })
    if (res.status === 201 || res.status === 200) {
      const created = await res.json().catch(()=>null)
      message.success(res.status===201 ? '订单已创建' : '已覆盖更新重复订单')
      setDupOpen(false); setOpen(false); form.resetFields(); load()
      const lateFee2 = v.late_checkout ? 20 : Number(v.late_checkout_fee || 0)
      const cancelFee2 = Number(v.cancel_fee || 0)
      async function writeIncome(amount: number, cat: string, note: string) {
        if (!amount || amount <= 0) return
        const tx = { kind: 'income', amount: Number(amount), currency: 'AUD', occurred_at: v.checkout.format('YYYY-MM-DD'), note, category: cat, property_id: v.property_id, ref_type: 'order', ref_id: created?.id }
        await fetch(`${API_BASE}/finance`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(tx) }).catch(() => {})
      }
      await writeIncome(lateFee2, 'late_checkout', 'Late checkout income')
      if ((v.status || '') === 'canceled') await writeIncome(cancelFee2, 'cancel_fee', 'Cancelation fee')
    } else {
      const j = await res.json().catch(()=>({}))
      message.error(j?.message || '覆盖创建失败')
    }
  }

  async function resolveImport(id: string, property_id?: string) {
    if (!property_id) { message.warning('请选择房号'); return }
    try {
      const res = await fetch(`${API_BASE}/orders/import/resolve/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify({ property_id }) })
      if (res.ok || res.status === 201) { message.success('已导入到订单'); setUnmatched(u => u.filter(x => x.id !== id)); load() } else { const j = await res.json().catch(()=>({} as any)); message.error(j?.message || '导入失败') }
    } catch { message.error('导入失败') }
  }

  function money(v?: number) { const n = Number(v || 0); if (!isFinite(n)) return ''; return Number(n.toFixed(2)).toFixed(2) }
  function calcMonthAmounts(o: Order) {
    const rawCi = (o as any).__src_checkin || o.checkin
    const rawCo = (o as any).__src_checkout || o.checkout
    const ci = dayjs(toDayStr(rawCi)).startOf('day')
    const co = dayjs(toDayStr(rawCo)).startOf('day')
    const ms = (monthFilter || dayjs()).startOf('month')
    const meNext = ms.add(1, 'month').startOf('month')
    const a = ci.isAfter(ms) ? ci : ms
    const b = co.isBefore(meNext) ? co : meNext
    const nightsMonth = Math.max(0, b.diff(a, 'day'))
    const totalNightsAll = Number((o as any).__src_nights ?? Math.max(0, co.diff(ci, 'day')))
    const totalPrice = Number((o as any).__src_price ?? o.price ?? 0)
    const totalCleaning = Number((o as any).__src_cleaning_fee ?? o.cleaning_fee ?? 0)
    const netTotal = Math.max(0, Number((totalPrice - totalCleaning).toFixed(2)))
    const dailyNet = totalNightsAll ? netTotal / totalNightsAll : 0
    const netMonth = Number((dailyNet * nightsMonth).toFixed(2))
    const isLastMonth = co.isSame(ms, 'month')
    const checkoutIsFirstDay = co.date() === 1
    const prevMonthOfCheckout = co.subtract(1,'month')
    const cleanMonth = (isLastMonth || (checkoutIsFirstDay && prevMonthOfCheckout.isSame(ms, 'month'))) ? totalCleaning : 0
    const priceMonth = Number((netMonth + cleanMonth).toFixed(2))
    const avgMonth = nightsMonth ? Number((netMonth / nightsMonth).toFixed(2)) : 0
    return { nightsMonth, netMonth, cleanMonth, priceMonth, avgMonth }
  }
  const columns = [
    { title: '房号', dataIndex: 'property_code', render: (_: any, r: Order) => {
      const label = getPropertyCodeLabel(r)
      const hasDed = Number(((r as any).internal_deduction ?? (r as any).internal_deduction_total ?? 0)) > 0
      return hasDed ? (<Space><span>{label}</span><Tag color="red">扣减</Tag></Space>) : label
    } },
    { title: '确认码', dataIndex: 'confirmation_code' },
    { title: '来源', dataIndex: 'source' },
    { title: '付款币种', dataIndex: 'payment_currency', render: (v:any)=> (v || 'AUD') },
    { title: '客人', dataIndex: 'guest_name' },
    // 可按需求增加显示客人电话
    { title: '入住', dataIndex: 'checkin', render: (_: any, r: Order) => fmtDay((r as any).__src_checkin || r.checkin) },
    { title: '退房', dataIndex: 'checkout', render: (_: any, r: Order) => fmtDay((r as any).__src_checkout || r.checkout) },
    { title: '邮件时间', dataIndex: 'email_header_at', render: (v:any)=> v ? dayjs(v).format('YYYY-MM-DD HH:mm') : '',
      sorter: (a: any, b: any) => { const av = a.email_header_at ? dayjs(a.email_header_at).valueOf() : 0; const bv = b.email_header_at ? dayjs(b.email_header_at).valueOf() : 0; return av - bv },
      sortDirections: ['ascend','descend'], sortOrder: sortKey==='email_header_at' ? sortOrder : undefined },
    { title: '天数', dataIndex: 'nights', render: (_: any, r: Order) => {
      if (!monthFilter) return Number(((r as any).__src_nights ?? r.nights ?? 0))
      const rawCi = (r as any).__src_checkin || r.checkin
      const rawCo = (r as any).__src_checkout || r.checkout
      const ci = dayjs(toDayStr(rawCi)).startOf('day')
      const co = dayjs(toDayStr(rawCo)).startOf('day')
      const ms = (monthFilter || dayjs()).startOf('month')
      const meNext = ms.add(1, 'month').startOf('month')
      const a = ci.isAfter(ms) ? ci : ms
      const b = co.isBefore(meNext) ? co : meNext
      return Math.max(0, b.diff(a, 'day'))
    } },
    { title: '当月租金(AUD)', dataIndex: 'price', render: (_:any, r:Order)=> monthFilter ? money(((r as any).visible_net_income ?? calcMonthAmounts(r).netMonth)) : money((r as any).__src_price ?? r.price) },
    { title: '订单总租金', dataIndex: '__src_price', render: (_:any, r:Order)=> {
      const total = ((r as any).__src_price ?? r.price ?? (((r as any).net_income || 0) + ((r as any).cleaning_fee || 0)))
      return money(total)
    } },
    { title: '清洁费', dataIndex: 'cleaning_fee', render: (_:any, r:Order)=> monthFilter ? money(calcMonthAmounts(r).cleanMonth) : money(r.cleaning_fee) },
    { title: '总收入', dataIndex: 'net_income', render: (_:any, r:Order)=> monthFilter ? money(((r as any).visible_net_income ?? calcMonthAmounts(r).netMonth)) : money((r as any).net_income ?? r.net_income) },
    { title: '晚均价', dataIndex: 'avg_nightly_price', render: (_:any, r:Order)=> monthFilter ? money(calcMonthAmounts(r).avgMonth) : money((r as any).avg_nightly_price ?? r.avg_nightly_price) },
    { title: '状态', dataIndex: 'status' },
    { title: '到账', dataIndex: 'payment_received', render: (v:any)=> v ? <Tag color="green">已到账</Tag> : <Tag>未到账</Tag> },
    { title: '操作', render: (_: any, r: Order) => (
      <Space>
        <Button onClick={() => openDetail(r)}>查看</Button>
        {!((r as any).payment_received) ? <Button type="primary" onClick={async ()=>{
          const res = await fetch(`${API_BASE}/orders/${r.id}/confirm-payment`, { method: 'POST', headers: { ...authHeaders() } })
          if (res.ok) {
            message.success('已确认到账')
            setData(prev => prev.map(x => x.id === r.id ? ({ ...x, payment_received: true } as any) : x))
          } else { const j = await res.json().catch(()=>({})); message.error(j?.message || '操作失败') }
        }}>确认到账</Button> : null}
        {hasPerm('order.write') ? <Button onClick={() => openEdit(r)}>编辑</Button> : null}
        {hasPerm('order.write') ? <Button danger onClick={() => {
          Modal.confirm({
            title: '确认删除订单',
            content: `确定删除订单（房号：${r.property_code || ''}，入住：${r.checkin || ''}）？`,
            okText: '删除',
            okType: 'danger',
            cancelText: '取消',
            onOk: async () => {
              const res = await fetch(`${API_BASE}/orders/${r.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } })
              if (res.ok) { message.success('订单已删除'); load() } else { message.error('删除失败') }
            }
          })
        }}>删除</Button> : null}
      </Space>
    ) },
  ]

  const sourceColor: Record<string, string> = {
    airbnb: '#FF9F97',
    booking: '#98B6EC',
    offline: '#DC8C03',
    other: '#98B6EC'
  }

  const baseMonth = calMonth || dayjs()
  const monthStart = baseMonth.startOf('month')
  const monthEnd = baseMonth.endOf('month')
  function dayStr(v: any): string { try { return toDayStr(v) } catch { return '' } }
  function applySort(list: any[]): any[] {
    return sortOrders(list as any, sortKey, sortOrder)
  }
  function splitOrderByMonths(o: Order): (Order & { __rid?: string })[] {
    const ciDay = dayStr(o.checkin)
    const coDay = dayStr(o.checkout)
    const ci = dayjs(ciDay).startOf('day')
    const co = dayjs(coDay).startOf('day')
    const totalNights = Math.max(0, co.diff(ci, 'day'))
    if (totalNights <= 0) return []
    const totalPrice = Number(o.price || 0)
    const totalCleaning = Number(o.cleaning_fee || 0)
    const dailyNet = totalNights ? (Number((totalPrice - totalCleaning).toFixed(2)) / totalNights) : 0
    const segments: (Order & { __rid?: string })[] = []
    let s = ci
    while (s.isBefore(co)) {
      const boundary = s.add(1, 'month').startOf('month')
      const e = co.isBefore(boundary) ? co : boundary
      const nights = Math.max(0, e.startOf('day').diff(s.startOf('day'), 'day'))
      const net = Number((dailyNet * nights).toFixed(2))
      const clean = e.isSame(co) ? totalCleaning : 0
      const price = Number((net + clean).toFixed(2))
      const avg = nights > 0 ? Number((net / nights).toFixed(2)) : 0
      const __rid = `${o.id}|${s.format('YYYYMM')}`
      segments.push({ ...o, __rid, checkin: s.format('YYYY-MM-DD') + 'T12:00:00', checkout: e.format('YYYY-MM-DD') + 'T11:59:59', nights, price, cleaning_fee: clean, net_income: net, avg_nightly_price: avg } as any)
      s = e
    }
    return segments
  }
  const monthOrders = (data || []).filter(o => {
    if (!calPid) return false
    if (o.property_id !== calPid) return false
    const ciDay = dayStr(o.checkin)
    const coDay = dayStr(o.checkout)
    if (!ciDay || !coDay) return false
    const ms = monthStart.format('YYYY-MM-DD')
    const me = monthEnd.format('YYYY-MM-DD')
    return coDay > ms && ciDay < me
  })
  const orderLane = (function(){
    const lanesEnd: number[] = []
    const map: Record<string, number> = {}
    const toDayIndex = (d: any) => d.startOf('day').diff(monthStart.startOf('day'), 'day')
    const segs = monthOrders.map(o => {
      const s = dayjs(dayStr(o.checkin) || monthStart)
      const e = dayjs(dayStr(o.checkout) || monthEnd)
      return { id: o.id, startIdx: toDayIndex(s), endIdx: toDayIndex(e) }
    }).sort((a,b)=> a.startIdx - b.startIdx || a.endIdx - b.endIdx)
    for (const seg of segs) {
      let placed = false
      for (let i = 0; i < lanesEnd.length; i++) {
        if (seg.startIdx >= lanesEnd[i]) { map[seg.id] = i; lanesEnd[i] = seg.endIdx; placed = true; break }
      }
      if (!placed) { map[seg.id] = lanesEnd.length; lanesEnd.push(seg.endIdx) }
    }
    return map
  })()
  function dayCell(date: any) {
    if (!calPid) return null
    const dateStr = dayjs(date).format('YYYY-MM-DD')
    const orders = sortOrders(
      data
      .filter(o => {
        const ciDay = dayStr(o.checkin)
        const coDay = dayStr(o.checkout)
        return o.property_id === calPid && ciDay && coDay && ciDay <= dateStr && coDay > dateStr
      }) as any,
      sortKey,
      sortOrder
    )
    if (!orders.length) return null
    return (
      <div style={{ position:'relative', minHeight: 64, overflow:'visible' }}>
        {orders.slice(0,6).map((o)=> {
          const accent = sourceColor[o.source || 'other'] || '#999'
          const ciDay = dayStr(o.checkin)
          const coDay = dayStr(o.checkout)
          const isStart = ciDay === dateStr
          const nextStr = dayjs(dateStr).add(1,'day').format('YYYY-MM-DD')
          const isEnd = coDay === nextStr // last day shown is checkout-1
          const radiusLeft = isStart ? 16 : 3
          const radiusRight = isEnd ? 16 : 3
          const lane = orderLane[o.id!] || 0
          return (
            <div key={o.id} style={{
              position:'absolute',
              left: -6,
              right: -6,
              top: 4 + lane * 32,
              height: 'auto',
              minHeight: 28,
              background: '#f5f5f5',
              color:'#000',
              borderRadius: `${radiusLeft}px ${radiusRight}px ${radiusRight}px ${radiusLeft}px`,
              padding:'0 8px',
              display:'flex',
              alignItems:'center',
              fontSize:11,
              lineHeight:'14px'
            }}>
              {isStart ? <span style={{ position:'absolute', left: -6, top:0, bottom:0, width: '33%', background: accent, borderRadius: `${radiusLeft}px 0 0 ${radiusLeft}px` }} /> : null}
              {isEnd ? <span style={{ position:'absolute', right: -6, top:0, bottom:0, width: '33%', background: accent, borderRadius: `0 ${radiusRight}px ${radiusRight}px 0` }} /> : null}
              <span style={{ overflow:'visible', textOverflow:'clip', whiteSpace:'normal', wordBreak:'break-word', marginLeft: isStart ? '33%' : 0, marginRight: isEnd ? '33%' : 0 }}>{(o.guest_name || '').toString()} ${money(o.price)}</span>
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <Card title="订单管理" extra={<Space>{hasPerm('order.sync') ? <Button type="primary" onClick={() => setOpen(true)}>新建订单</Button> : null}{hasPerm('order.manage') ? <Button onClick={() => setImportOpen(true)}>批量导入</Button> : null}{hasPerm('order.manage') ? <Button onClick={manualSyncOrders} disabled={syncing}>手动同步订单</Button> : null}{hasPerm('order.manage') ? <Button onClick={openFailures}>失败订单邮件手动入库</Button> : null}</Space>}>
      <Space style={{ marginBottom: 12 }} wrap>
        <Radio.Group value={view} onChange={(e)=>setView(e.target.value)}>
          <Radio.Button value="list">列表</Radio.Button>
          <Radio.Button value="calendar">日历</Radio.Button>
        </Radio.Group>
        <Select value={`${sortKey}:${sortOrder}`} onChange={(v)=>{ const [k, o] = String(v).split(':') as any; setSortKey(k); setSortOrder(o) }}
          options={[
            { value: 'email_header_at:descend', label: '按邮件时间(新→旧)' },
            { value: 'email_header_at:ascend', label: '按邮件时间(旧→新)' },
            { value: 'checkin:ascend', label: '按入住(早→晚)' },
            { value: 'checkin:descend', label: '按入住(晚→早)' },
            { value: 'checkout:ascend', label: '按退房(早→晚)' },
            { value: 'checkout:descend', label: '按退房(晚→早)' }
          ]}
        />
        {view==='list' ? (
          <>
            <Input placeholder="按房号搜索" allowClear value={codeQuery} onChange={(e) => setCodeQuery(e.target.value)} style={{ width: 200 }} />
            <Input placeholder="按确认码搜索" allowClear value={confQuery} onChange={(e) => setConfQuery(e.target.value)} style={{ width: 200 }} />
            <DatePicker picker="month" value={monthFilter as any} onChange={setMonthFilter as any} allowClear placeholder="选择月份(可选)" />
            <DatePicker.RangePicker onChange={(v) => setDateRange(v as any)} format="DD/MM/YYYY" />
          </>
        ) : (
          <>
            <DatePicker picker="month" value={calMonth} onChange={setCalMonth as any} />
            <Select showSearch optionFilterProp="label" filterOption={(input, option)=> String((option as any)?.label||'').toLowerCase().includes(String(input||'').toLowerCase())} placeholder="选择房号" style={{ width: 220 }} value={calPid} onChange={setCalPid} options={sortProperties(properties).map(p=>({value:p.id,label:p.code||p.id}))} />
            <Button onClick={async () => {
              if (!calPid) { message.warning('请选择房号'); return }
              if (!calRef.current) return
              const style = `
                <style>
                  html, body { font-family: 'Times New Roman', Times, serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
                  @page { margin: 12mm; size: A4 landscape; }
                  body { width: 277mm; margin: 0 auto; }
                  .cal-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; }
                  .cal-title { font-size:18px; font-weight:700; }
                </style>
              `
              const iframe = document.createElement('iframe')
              iframe.style.position = 'fixed'
              iframe.style.left = '-9999px'
              iframe.style.top = '-9999px'
              iframe.style.width = '0'
              iframe.style.height = '0'
              document.body.appendChild(iframe)
              const doc = iframe.contentDocument || (iframe as any).document
              const prop = properties.find(p=>p.id===calPid)
              const header = `<div class="cal-header"><div class="cal-title">订单日历 ${calMonth.format('YYYY-MM')}</div><div>${prop?.code || ''} ${prop?.address || ''}</div></div>`
              const html = `<html><head><title>Order Calendar</title>${style}<base href="${location.origin}"></head><body>${header}${calRef.current.innerHTML}</body></html>`
              doc.open(); doc.write(html); doc.close()
              await new Promise(r => setTimeout(r, 50))
              try { (iframe.contentWindow as any).focus(); (iframe.contentWindow as any).print() } catch {}
              setTimeout(() => { try { document.body.removeChild(iframe) } catch {} }, 500)
            }}>导出日历</Button>
          </>
        )}
      </Space>
      {view==='list' ? (
        <Table
          rowKey={(r) => String((r as any).__rid || r.id)}
          columns={columns as any}
          dataSource={(function(){
            const ms = (monthFilter || dayjs()).startOf('month')
            const me = ms.add(1, 'month').startOf('month')
            const input = String(codeQuery || '').trim().toLowerCase()
            const confInput = String(confQuery || '').trim().toLowerCase()
            if (confInput) {
              const raw = (Array.isArray(data) ? data : []).map((o: any) => {
                const ciStr = String(o.checkin || '').slice(0,10)
                const coStr = String(o.checkout || '').slice(0,10)
                const ci = dayjs(ciStr, 'YYYY-MM-DD', true)
                const co = dayjs(coStr, 'YYYY-MM-DD', true)
                const nights = (ci.isValid() && co.isValid()) ? Math.max(0, co.diff(ci, 'day')) : Number(o.nights || 0)
              const price = Number(o.price || 0)
              const cleaning = Number(o.cleaning_fee || 0)
              const net = Number((price - cleaning).toFixed(2))
              const avg = nights > 0 ? Number((net / nights).toFixed(2)) : 0
                return { ...o, __rid: o.id, nights, net_income: net, avg_nightly_price: avg, __src_price: price }
              })
              const filtered1 = raw.filter(o => {
                const codeText = (getPropertyCodeLabel(o) || '').toLowerCase()
                const listingText = String((o as any).listing_name || '').toLowerCase()
                const sourceText = String(o.source || '').toLowerCase()
                const guestText = String(o.guest_name || '').toLowerCase()
                const okText = !input || codeText.includes(input) || listingText.includes(input) || sourceText.includes(input) || guestText.includes(input)
                const confText = String((o as any).confirmation_code || '').toLowerCase()
                const okConf = confText.includes(confInput)
                return okText && okConf
              })
              return applySort(filtered1)
            }
            if (monthFilter) {
              const baseSegs: (Order & { __rid?: string })[] = monthSegments(data as any, ms) as any
              const rowsPrimary = baseSegs.filter(o => {
                const codeText = (getPropertyCodeLabel(o) || '').toLowerCase()
                const listingText = String((o as any).listing_name || '').toLowerCase()
                const sourceText = String(o.source || '').toLowerCase()
                const guestText = String(o.guest_name || '').toLowerCase()
                const okText = !input || codeText.includes(input) || listingText.includes(input) || sourceText.includes(input) || guestText.includes(input)
                const confText = String((o as any).confirmation_code || '').toLowerCase()
                const okConf = !confInput || confText.includes(confInput)
                const rangeOk = !dateRange || (
                  (!dateRange[0] || dayjs(o.checkout).diff(dateRange[0], 'day') > 0) &&
                  (!dateRange[1] || dayjs(o.checkin).diff(dateRange[1], 'day') <= 0)
                )
                return okText && okConf && rangeOk
              })
              if (rowsPrimary.length) return applySort(rowsPrimary)
            }
            // 默认显示原始订单（全部），可选按月份/范围筛选
            const raw = (Array.isArray(data) ? data : []).map((o: any) => {
              const ciStr = String(o.checkin || '').slice(0,10)
              const coStr = String(o.checkout || '').slice(0,10)
              const ci = dayjs(ciStr, 'YYYY-MM-DD', true)
              const co = dayjs(coStr, 'YYYY-MM-DD', true)
              const nights = (ci.isValid() && co.isValid()) ? Math.max(0, co.diff(ci, 'day')) : Number(o.nights || 0)
              const price = Number(o.price || 0)
              const cleaning = Number(o.cleaning_fee || 0)
              const net = Number((price - cleaning).toFixed(2))
              const avg = nights > 0 ? Number((net / nights).toFixed(2)) : 0
              return { ...o, __rid: o.id, nights, net_income: net, avg_nightly_price: avg, __src_price: price }
            })
            const filtered2 = raw.filter(o => {
              const codeText = (getPropertyCodeLabel(o) || '').toLowerCase()
              const listingText = String((o as any).listing_name || '').toLowerCase()
              const sourceText = String(o.source || '').toLowerCase()
              const guestText = String(o.guest_name || '').toLowerCase()
              const okText = !input || codeText.includes(input) || listingText.includes(input) || sourceText.includes(input) || guestText.includes(input)
              const confText = String((o as any).confirmation_code || '').toLowerCase()
              const okConf = !confInput || confText.includes(confInput)
              const ci = dayjs(String(o.checkin || '').slice(0,10))
              const co = dayjs(String(o.checkout || '').slice(0,10))
              const monthOverlap = !monthFilter ? true : (ci.isValid() && co.isValid() ? (ci.isBefore(me) && co.isAfter(ms)) : true)
              const rangeOk = !dateRange || (
                (!dateRange[0] || dayjs(o.checkout).diff(dateRange[0], 'day') > 0) &&
                (!dateRange[1] || dayjs(o.checkin).diff(dateRange[1], 'day') <= 0)
              )
              return okText && okConf && monthOverlap && rangeOk
            })
            return applySort(filtered2)
          })()}
          pagination={{ defaultPageSize: 10, showSizeChanger: true, pageSizeOptions: [10, 20, 50, 100] }}
          scroll={{ x: 'max-content' }}
        />
      ) : (
        <div ref={calRef}>
          <Calendar value={calMonth} onChange={setCalMonth as any} fullscreen cellRender={(date:any, info:any) => (info?.type === 'date' ? (dayCell(date) as any) : undefined)} headerRender={() => null} />
        </div>
      )}
      <Modal open={open} onCancel={() => setOpen(false)} onOk={submitCreate} title="新建订单">
      <Form form={form} layout="vertical">
        <Form.Item name="confirmation_code" label="确认码" rules={[{ required: true, message: '确认码必填' }]}>
          <Input placeholder="平台订单确认码或唯一编号" />
        </Form.Item>
        <Form.Item name="source" label="来源" rules={[{ required: true }]}> 
          <Select options={[{ value: 'airbnb', label: 'airbnb' }, { value: 'booking', label: 'booking.com' }, { value: 'offline', label: '线下' }, { value: 'other', label: '其他' }]} />
        </Form.Item>
        <Form.Item name="status" label="状态" initialValue="confirmed"> 
          <Select options={[{ value: 'confirmed', label: '已确认' }, { value: 'canceled', label: '已取消' }]} />
        </Form.Item>
        <Form.Item name="property_id" label="房号" rules={[{ required: true }]}> 
          <Select
            showSearch
            optionFilterProp="label"
            options={sortProperties(Array.isArray(properties) ? properties : []).map(p => ({ value: p.id, label: p.code || p.address || p.id }))}
            onChange={(val, opt) => {
              const label = (opt as any)?.label || ''
              form.setFieldsValue({ property_code: label })
            }}
          />
        </Form.Item>
        <Form.Item name="property_code" hidden><Input /></Form.Item>
        <Form.Item name="guest_name" label="客人姓名">
          <Input />
        </Form.Item>
        <Form.Item name="guest_phone" label="客人电话">
          <Input placeholder="用于生成旧/新密码（后四位）" />
        </Form.Item>
        <Form.Item name="checkin" label="入住" rules={[{ required: true }, { validator: async (_: any, v: any) => { const c = form.getFieldValue('checkout'); if (v && c && !v.isBefore(c, 'day')) throw new Error('入住日期必须早于退房日期') } }]}> 
          <DatePicker style={{ width: '100%' }} format="DD/MM/YYYY" disabledDate={(d) => { const c = form.getFieldValue('checkout'); return c ? d.isSame(c, 'day') || d.isAfter(c, 'day') : false }} />
        </Form.Item>
        <Form.Item name="checkout" label="退房" rules={[{ required: true }, { validator: async (_: any, v: any) => { const ci = form.getFieldValue('checkin'); if (v && ci && !ci.isBefore(v, 'day')) throw new Error('退房日期必须晚于入住日期') } }]}> 
          <DatePicker style={{ width: '100%' }} format="DD/MM/YYYY" disabledDate={(d) => { const ci = form.getFieldValue('checkin'); return ci ? d.isSame(ci, 'day') || d.isBefore(ci, 'day') : false }} />
        </Form.Item>
        <Form.Item name="price" label="总租金(AUD)" rules={[{ required: true }]}> 
          <InputNumber min={0} step={1} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item name="cleaning_fee" label="清洁费" rules={[{ required: true }]}> 
          <InputNumber min={0} step={1} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item label="晚退收入">
          <Space>
            <Form.Item name="late_checkout" valuePropName="checked" noStyle>
              <Checkbox>晚退(+20)</Checkbox>
            </Form.Item>
            <Form.Item name="late_checkout_fee" noStyle>
              <InputNumber min={0} step={1} placeholder="自定义金额(可选)" />
            </Form.Item>
          </Space>
        </Form.Item>
        <Form.Item shouldUpdate>
          {() => {
            const st = form.getFieldValue('status')
            if (st === 'canceled') {
              return (
                <Form.Item name="cancel_fee" label="取消费(AUD)">
                  <InputNumber min={0} step={1} style={{ width: '100%' }} />
                </Form.Item>
              )
            }
            return null
          }}
        </Form.Item>
        <Form.Item shouldUpdate noStyle>
          {() => {
            const v = form.getFieldsValue()
            const nights = v.checkin && v.checkout ? Math.max(0, dayjs(v.checkout).diff(dayjs(v.checkin), 'day')) : 0
            const price = Number(v.price || 0)
            const cleaning = Number(v.cleaning_fee || 0)
            const lateFee = v.late_checkout ? 20 : Number(v.late_checkout_fee || 0)
            const cancelFee = Number(v.cancel_fee || 0)
            const net = Math.max(0, price + lateFee + cancelFee - cleaning)
            const avg = nights > 0 ? Number((net / nights).toFixed(2)) : 0
            return (
              <Card size="small" style={{ marginTop: 8 }}>
                <Space wrap>
                  <Tag color="blue">入住天数: {nights}</Tag>
                  <Tag color="green">总收入: {Number(net).toFixed(2)}</Tag>
                  {v.late_checkout || v.late_checkout_fee ? <Tag color="purple">晚退收入: {lateFee}</Tag> : null}
                  {v.cancel_fee ? <Tag color="orange">取消费: {cancelFee}</Tag> : null}
                  <Tag color="purple">晚均价: {Number(avg).toFixed(2)}</Tag>
                </Space>
              </Card>
            )
          }}
        </Form.Item>
      </Form>
    </Modal>
    <Modal open={dupOpen} onCancel={()=> setDupOpen(false)} footer={null} title="疑似重复订单" width={900}>
      {dupLoading ? <div>校验中...</div> : null}
      {!dupLoading && dupResult && dupResult.is_duplicate ? (
        <>
          <Space style={{ marginBottom: 12 }} wrap>
            {(dupResult?.reasons || []).map((r:string)=> (<Tag key={r} color="red">{r.replace('confirmation_code_duplicate','确认码重复').replace('content_duplicate','内容重复').replace('recent_duplicate','15分钟内重复')}</Tag>))}
          </Space>
          <Table rowKey={(r:any)=> String(r.id||r.confirmation_code||'')} dataSource={Array.isArray(dupResult?.similar_orders)? dupResult.similar_orders : []} pagination={{ defaultPageSize: 5 }} size="small" scroll={{ x: 'max-content' }}
            columns={[
              { title: '房号', dataIndex: 'property_code' },
              { title: '确认码', dataIndex: 'confirmation_code' },
              { title: '客人', dataIndex: 'guest_name' },
              { title: '入住', dataIndex: 'checkin' },
              { title: '退房', dataIndex: 'checkout' },
              { title: '状态', dataIndex: 'status' },
              { title: '操作', render: (_:any, r:any)=> (<Space><Button size="small" onClick={()=> openDetail(r.id)}>查看</Button>{hasPerm('order.cancel.override') ? <Button size="small" danger onClick={async ()=> { const res = await fetch(`${API_BASE}/orders/${r.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify({ status: 'cancelled' }) }); if (res.ok) { message.success('已取消重复订单'); setDupOpen(false); load() } else { const j = await res.json().catch(()=>({})); message.error(j?.message || '取消失败') } }}>取消</Button> : null}</Space>) }
            ] as any}
          />
          <Space style={{ marginTop: 12 }}>
            {hasPerm('order.create.override') ? <Button type="primary" onClick={proceedCreateForce}>继续创建（覆盖）</Button> : <Tag color="orange">无覆盖创建权限</Tag>}
            <Button onClick={()=> setDupOpen(false)}>返回</Button>
          </Space>
        </>
      ) : null}
    </Modal>
    <Modal open={failOpen} onCancel={()=> setFailOpen(false)} footer={null} title="失败订单邮件（可手动入库）" width={1000}>
      <Space style={{ marginBottom: 12 }}>
        <Button size="small" onClick={openFailures} disabled={failLoading}>刷新</Button>
        <Button size="small" type="primary" onClick={async ()=>{
          try {
            const items = (failRows || []).map((r:any)=> ({ uid: Number(r?.uid||0)||undefined, message_id: String(r?.message_id||'')||undefined, property_id: String((r as any).__pid||'') })).filter(x=> !!x.property_id)
            if (!items.length) { message.warning('请选择房号'); return }
            const res = await fetch(`${API_BASE}/jobs/email-orders-raw/resolve-bulk`, { method: 'POST', headers: { 'Content-Type':'application/json', ...authHeaders() }, body: JSON.stringify({ items }) })
            const j = await res.json().catch(()=>null)
            if (res.ok) {
              const s = j || {}
              message.success(`已插入 ${Number(s.inserted||0)}，重复 ${Number(s.duplicate||0)}，失败 ${Number(s.failed||0)}`)
              openFailures(); load()
            } else { message.error(j?.message || '批量插入失败') }
          } catch { message.error('批量插入失败') }
        }}>全部插入</Button>
      </Space>
      <Table size="small" loading={failLoading} rowKey={(r:any)=> String(r.id||r.uid||'')} dataSource={failRows} pagination={{ defaultPageSize: 10, showSizeChanger: true, pageSizeOptions: [10, 20, 50, 100] }} scroll={{ x: 'max-content' }}
        columns={[
          { title: 'UID', dataIndex: 'uid' },
          { title: '主题', dataIndex: 'subject', render: (v:any)=> <span style={{ wordBreak:'break-word' }}>{v||''}</span> },
          { title: '确认码', dataIndex: 'confirmation_code' },
          { title: '客人', dataIndex: 'guest_name' },
          { title: 'Listing', dataIndex: 'listing_name', render: (v:any)=> <span style={{ wordBreak:'break-word' }}>{v||''}</span> },
          { title: '入住', dataIndex: 'checkin', render: (v:any)=> fmtDay(v) },
          { title: '退房', dataIndex: 'checkout', render: (v:any)=> fmtDay(v) },
          { title: '天数', dataIndex: 'nights' },
          { title: '总租金', dataIndex: 'price' },
          { title: '清洁费', dataIndex: 'cleaning_fee' },
          { title: '状态', dataIndex: 'status', render: (v:any)=> <Tag color="red">{String(v||'')}</Tag> },
          { title: '失败原因', dataIndex: 'reason', render: (v:any, r:any)=> <span style={{ wordBreak:'break-word' }}>{String(v||'')}</span> },
          { title: '房号', render: (_:any, r:any)=> (
            <Select showSearch optionFilterProp="label" placeholder="选择房号" style={{ width: 220 }}
              options={sortProperties(properties).map(p=>({value:p.id,label:p.code||p.address||p.id}))}
              onChange={(pid, opt)=>{ (r as any).__pid = pid; (r as any).__pcode = (opt as any)?.label }} />
          ) },
          { title: '操作', render: (_:any, r:any)=> (
            <Space>
              <Button size="small" type="primary" onClick={()=> manualInsertFromEmail(r)}>手动插入</Button>
            </Space>
          ) },
        ] as any}
      />
    </Modal>
    <Modal open={previewOpen} onCancel={() => setPreviewOpen(false)} footer={null} title="Airbnb 邮件预览" width={1000}>
      {previewStats ? (
        <Space style={{ marginBottom: 12 }}>
          <Tag color="blue">扫描 {Number(previewStats.scanned||0)}</Tag>
          <Tag color="green">命中 {Number(previewStats.matched||0)}</Tag>
          <Tag color="gold">跳过 {Number(previewStats.skipped||0)}</Tag>
          <Tag>新增 {Number(previewStats.inserted||0)}</Tag>
          <Tag>重复 {Number(previewStats.duplicates||0)}</Tag>
          <Tag color="red">失败 {Number(previewStats.failed||0)}</Tag>
        </Space>
      ) : null}
      <Space style={{ marginBottom: 12 }}>
        <Button size="small" type="primary" onClick={previewAllMatchedUids} disabled={previewLoading}>刷新</Button>
        <Button size="small" danger onClick={ingestAllAutoUids} disabled={previewLoading}>正式导入全部</Button>
      </Space>
      <Space style={{ marginBottom: 12 }}>
        <Button size="small" type="primary" onClick={previewAllMatchedUids} disabled={previewLoading}>刷新</Button>
        <Button size="small" danger onClick={ingestAllAutoUids} disabled={previewLoading}>正式导入全部</Button>
      </Space>
      <Table rowKey={(r:any)=> String(r.confirmation_code||'') + String(r.checkin||'')} dataSource={rows} pagination={{ defaultPageSize: 10, showSizeChanger: true, pageSizeOptions: [10, 20, 50, 100] }} size="small" scroll={{ x: 'max-content' }} loading={previewLoading}
        columns={[
          { title: '确认码', dataIndex: 'confirmation_code' },
          { title: '客人', dataIndex: 'guest_name' },
          { title: 'Listing 名称', dataIndex: 'listing_name' },
          { title: '入住', dataIndex: 'checkin' },
          { title: '退房', dataIndex: 'checkout' },
          { title: '天数', dataIndex: 'nights' },
          { title: 'You earn', dataIndex: 'youEarn' },
          { title: '清洁费', dataIndex: 'cleaning_fee' },
          { title: '净收入', dataIndex: 'net_income' },
          { title: '晚均价', dataIndex: 'avg_nightly_price' },
          { title: '房号匹配', dataIndex: 'property_match', render: (v:any)=> (v===true ? <Tag color="green">已匹配</Tag> : <Tag color="red">未匹配</Tag>) },
        ] as any}
      />
      <Card size="small" style={{ marginTop: 12 }}>
        <Tabs items={[
          {
            key: 'current',
            label: `本次导入失败（${previewFailures.filter((x:any)=> String(x?.status||'') !== 'resolved').length}）`,
            children: (
              <Table rowKey={(r:any)=> String(r.uid||'') + String(r.subject||'')} dataSource={previewFailures.filter((x:any)=> String(x?.status||'') !== 'resolved')} pagination={{ defaultPageSize: 10, showSizeChanger: true, pageSizeOptions: [10, 20, 50, 100] }} size="small" scroll={{ x: 'max-content' }}
                columns={[
                  { title: 'UID', dataIndex: 'uid' },
                  { title: '主题', dataIndex: 'subject', render: (v:any)=> <span style={{ wordBreak:'break-word' }}>{v||''}</span> },
                  { title: '发件人', dataIndex: 'from' },
                  { title: '日期', dataIndex: 'date' },
                  { title: '阶段', dataIndex: 'stage' },
                  { title: '原因代码', dataIndex: 'reason', render: (v:any)=> <Tag color="red">{v}</Tag> },
                  { title: '原因描述', dataIndex: 'reason_message' },
                  { title: '解析预览', dataIndex: 'parse_preview', render: (v:any)=> <span style={{ wordBreak:'break-word' }}>{v||''}</span> },
                  { title: '房号', render: (_:any, r:any)=> (
                    <Select showSearch optionFilterProp="label" placeholder="选择房号" style={{ width: 220 }}
                      options={sortProperties(properties).map(p=>({value:p.id,label:p.code||p.address||p.id}))}
                      onChange={(pid)=>{ (r as any).__pid = pid }} />
                  ) },
                  { title: '操作', render: (_:any, r:any)=> (
                    <Space>
                      <Button size="small" onClick={()=> selfCheckUid(Number(r?.uid))}>自检</Button>
                      <Button size="small" type="primary" onClick={()=> manualInsertFromEmail(r)}>手动插入</Button>
                    </Space>
                  ) },
                ] as any}
              />
            )
          },
          {
            key: 'history',
            label: `历史失败（${previewFailuresHistory.length}）`,
            children: (
              <Table rowKey={(r:any)=> String(r.uid||'') + String(r.subject||'') + String(r.created_at||'')} dataSource={previewFailuresHistory} pagination={{ defaultPageSize: 10, showSizeChanger: true, pageSizeOptions: [10, 20, 50, 100] }} size="small" scroll={{ x: 'max-content' }}
                columns={[
                  { title: 'UID', dataIndex: 'uid' },
                  { title: '主题', dataIndex: 'subject', render: (v:any)=> <span style={{ wordBreak:'break-word' }}>{v||''}</span> },
                  { title: '发件人', dataIndex: 'sender' },
                  { title: '日期', dataIndex: 'email_date' },
                  { title: '阶段', dataIndex: 'stage' },
                  { title: '原因代码', dataIndex: 'reason_code', render: (v:any)=> <Tag color="red">{v}</Tag> },
                  { title: '原因描述', dataIndex: 'reason_message' },
                  { title: '状态', dataIndex: 'status', render: (v:any)=> v==='resolved'? <Tag color="green">resolved</Tag> : <Tag>unresolved</Tag> },
                  { title: '解析预览', dataIndex: 'parse_preview', render: (v:any)=> <span style={{ wordBreak:'break-word' }}>{v||''}</span> },
                ] as any}
              />
            )
          }
        ]} />
      </Card>
      <Card size="small" style={{ marginTop: 12 }} title={`跳过详情（${previewSkips.length}）`}>
        <Table rowKey={(r:any)=> String(r.uid||'') + String(r.subject||'')} dataSource={previewSkips} pagination={{ defaultPageSize: 10, showSizeChanger: true, pageSizeOptions: [10, 20, 50, 100] }} size="small" scroll={{ x: 'max-content' }}
          columns={[
            { title: 'UID', dataIndex: 'uid' },
            { title: '主题', dataIndex: 'subject', render: (v:any)=> <span style={{ wordBreak:'break-word' }}>{v||''}</span> },
            { title: '发件人', dataIndex: 'from' },
            { title: '日期', dataIndex: 'date' },
            { title: '原因', dataIndex: 'reason', render: (v:any)=> <Tag>{String(v||'')}</Tag> },
          ] as any}
        />
      </Card>
    </Modal>
    <Modal open={selfCheckOpen} onCancel={()=> setSelfCheckOpen(false)} footer={null} title="指定 UID 自检" width={900}>
      <Descriptions bordered size="small" column={1}>
        <Descriptions.Item label="Job ID">{selfCheckData?.job_id || ''}</Descriptions.Item>
        <Descriptions.Item label="统计">扫描 {Number(selfCheckData?.scanned||0)}，命中 {Number(selfCheckData?.matched||0)}，插入 {Number(selfCheckData?.inserted||0)}，失败 {Number(selfCheckData?.failed||0)}</Descriptions.Item>
      </Descriptions>
      <Card style={{ marginTop: 12 }} size="small" title="阶段日志">
        <pre style={{ whiteSpace:'pre-wrap' }}>{JSON.stringify(selfCheckData?.stage_logs || [], null, 2)}</pre>
      </Card>
      <Card style={{ marginTop: 12 }} size="small" title="解析结果">
        <pre style={{ whiteSpace:'pre-wrap' }}>{JSON.stringify(selfCheckData?.parsed_results || [], null, 2)}</pre>
      </Card>
      <Card style={{ marginTop: 12 }} size="small" title="失败详情">
        <pre style={{ whiteSpace:'pre-wrap' }}>{JSON.stringify(selfCheckData?.failed_details || [], null, 2)}</pre>
      </Card>
    </Modal>
    <Modal open={editOpen} onCancel={() => setEditOpen(false)} onOk={async () => {
        const v = await editForm.validateFields()
        const nights = v.checkin && v.checkout ? Math.max(0, dayjs(v.checkout).diff(dayjs(v.checkin), 'day')) : 0
        const price = Number(v.price || 0)
        const cleaning = Number(v.cleaning_fee || 0)
        const net = Math.max(0, price - cleaning)
        const avg = nights > 0 ? Number((net / nights).toFixed(2)) : 0
        const selectedEdit = (Array.isArray(properties) ? properties : []).find(p => p.id === v.property_id)
        const payload = { ...v, property_code: (v.property_code || selectedEdit?.code || selectedEdit?.address || v.property_id), checkin: dayjs(v.checkin).format('YYYY-MM-DD') + 'T12:00:00', checkout: dayjs(v.checkout).format('YYYY-MM-DD') + 'T11:59:59', nights, net_income: Number(net).toFixed(2) ? Number(Number(net).toFixed(2)) : net, avg_nightly_price: Number(avg).toFixed(2) ? Number(Number(avg).toFixed(2)) : avg, price: Number(price).toFixed(2) ? Number(Number(price).toFixed(2)) : price, cleaning_fee: Number(cleaning).toFixed(2) ? Number(Number(cleaning).toFixed(2)) : cleaning, payment_currency: (v.payment_currency || 'AUD') }
        let res: Response | null = null
        try {
          res = await fetch(`${API_BASE}/orders/${current?.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify({ ...payload, force: true }) })
        } catch (e: any) {
          message.error('网络错误，更新失败')
          return
        }
        if (res!.ok) {
          async function writeIncome(amount: number, cat: string, note: string) {
            if (!amount || amount <= 0) return
            const tx = { kind: 'income', amount: Number(amount), currency: 'AUD', occurred_at: dayjs(v.checkout).format('YYYY-MM-DD'), note, category: cat, property_id: v.property_id, ref_type: 'order', ref_id: current?.id }
            await fetch(`${API_BASE}/finance`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(tx) }).catch(() => {})
          }
          const lateFee = v.late_checkout ? 20 : Number(v.late_checkout_fee || 0)
          const cancelFee = Number(v.cancel_fee || 0)
          await writeIncome(lateFee, 'late_checkout', 'Late checkout income')
          if ((v.status || '') === 'canceled') await writeIncome(cancelFee, 'cancel_fee', 'Cancelation fee')
          message.success('订单已更新'); setEditOpen(false); load()
        }
        else {
          let msg = '更新失败'
          try { const j = await res!.json(); if (j?.message) msg = j.message } catch { try { msg = await res!.text() } catch {} }
          message.error(msg)
        }
      }} title="编辑订单">
        <Form form={editForm} layout="vertical">
          <Form.Item name="confirmation_code" label="确认码" rules={[{ required: true, message: '确认码必填' }]}>
            <Input />
          </Form.Item>
          <Form.Item name="source" label="来源" rules={[{ required: true }]}> 
            <Select options={[{ value: 'airbnb', label: 'airbnb' }, { value: 'booking', label: 'booking.com' }, { value: 'offline', label: '线下' }, { value: 'other', label: '其他' }]} />
          </Form.Item>
          <Form.Item name="status" label="状态" initialValue="confirmed"> 
            <Select options={[{ value: 'confirmed', label: '已确认' }, { value: 'canceled', label: '已取消' }]} />
          </Form.Item>
          <Form.Item name="property_id" label="房号" rules={[{ required: true }]}> 
            <Select
              showSearch
              optionFilterProp="label"
              options={sortProperties(Array.isArray(properties) ? properties : []).map(p => ({ value: p.id, label: p.code || p.address || p.id }))}
              onChange={(val, opt) => {
                const label = (opt as any)?.label || ''
                editForm.setFieldsValue({ property_code: label })
              }}
            />
          </Form.Item>
          <Form.Item name="property_code" hidden><Input /></Form.Item>
          <Form.Item name="guest_name" label="客人姓名"><Input /></Form.Item>
          <Form.Item name="guest_phone" label="客人电话"><Input placeholder="用于生成旧/新密码（后四位）" /></Form.Item>
          <Form.Item name="checkin" label="入住" rules={[{ required: true }, { validator: async (_: any, v: any) => { const c = editForm.getFieldValue('checkout'); if (v && c && !v.isBefore(c, 'day')) throw new Error('入住日期必须早于退房日期') } }]}><DatePicker style={{ width: '100%' }} format="DD/MM/YYYY" disabledDate={(d) => { const c = editForm.getFieldValue('checkout'); return c ? d.isSame(c, 'day') || d.isAfter(c, 'day') : false }} /></Form.Item>
          <Form.Item name="checkout" label="退房" rules={[{ required: true }, { validator: async (_: any, v: any) => { const ci = editForm.getFieldValue('checkin'); if (v && ci && !ci.isBefore(v, 'day')) throw new Error('退房日期必须晚于入住日期') } }]}><DatePicker style={{ width: '100%' }} format="DD/MM/YYYY" disabledDate={(d) => { const ci = editForm.getFieldValue('checkin'); return ci ? d.isSame(ci, 'day') || d.isBefore(ci, 'day') : false }} /></Form.Item>
          <Form.Item name="price" label="总租金(AUD)"><InputNumber min={0} step={1} style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="cleaning_fee" label="清洁费"><InputNumber min={0} step={1} style={{ width: '100%' }} /></Form.Item>
          <Form.Item label="晚退收入">
            <Space>
              <Form.Item name="late_checkout" valuePropName="checked" noStyle>
                <Checkbox>晚退(+20)</Checkbox>
              </Form.Item>
              <Form.Item name="late_checkout_fee" noStyle>
                <InputNumber min={0} step={1} placeholder="自定义金额(可选)" />
              </Form.Item>
            </Space>
          </Form.Item>
          <Form.Item shouldUpdate>
            {() => {
              const st = editForm.getFieldValue('status')
              if (st === 'canceled') {
                return (
                  <Form.Item name="cancel_fee" label="取消费(AUD)">
                    <InputNumber min={0} step={1} style={{ width: '100%' }} />
                  </Form.Item>
                )
              }
              return null
            }}
          </Form.Item>
          <Form.Item shouldUpdate noStyle>
            {() => {
              const v = editForm.getFieldsValue()
              const nights = v.checkin && v.checkout ? Math.max(0, dayjs(v.checkout).diff(dayjs(v.checkin), 'day')) : 0
              const price = Number(v.price || 0)
              const cleaning = Number(v.cleaning_fee || 0)
              const lateFee = v.late_checkout ? 20 : Number(v.late_checkout_fee || 0)
              const cancelFee = Number(v.cancel_fee || 0)
              const net = Math.max(0, price + lateFee + cancelFee - cleaning)
              const avg = nights > 0 ? Number((net / nights).toFixed(2)) : 0
              const visible = Math.max(0, net - Number(deductAmountEdit || 0))
              return (
                <Card size="small" style={{ marginTop: 8 }}>
                  <Space wrap>
                    <Tag color="blue">入住天数: {nights}</Tag>
                    <Tag color="green">总收入: {Number(net).toFixed(2)}</Tag>
                    {v.late_checkout || v.late_checkout_fee ? <Tag color="purple">晚退收入: {lateFee}</Tag> : null}
                    {v.cancel_fee ? <Tag color="orange">取消费: {cancelFee}</Tag> : null}
                    <Tag color="purple">晚均价: {Number(avg).toFixed(2)}</Tag>
                    {hasPerm('order.deduction.manage') ? <Tag color="red">可见净额: {Number(visible).toFixed(2)}</Tag> : null}
                  </Space>
                </Card>
              )
            }}
          </Form.Item>
          {hasPerm('order.deduction.manage') ? (
            <Card size="small" style={{ marginTop: 8 }} title="内部扣减">
              <Space direction="vertical" style={{ width: '100%' }}>
                <InputNumber style={{ width: '100%' }} value={deductAmountEdit} onChange={(v)=> setDeductAmountEdit(Number(v||0))} min={0} />
                <Input value={deductDescEdit} onChange={(e)=> setDeductDescEdit(e.target.value)} placeholder="减扣事项描述" />
                <Input value={deductNoteEdit} onChange={(e)=> setDeductNoteEdit(e.target.value)} placeholder="备注" />
                <Button type="primary" onClick={async () => {
                  if (!current) return
                  const payload = { amount: deductAmountEdit, item_desc: deductDescEdit, note: deductNoteEdit }
                  const resp = await fetch(`${API_BASE}/orders/${current.id}/internal-deductions`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(payload) })
                  if (resp.ok) { message.success('扣减已保存'); setDeductAmountEdit(0); setDeductNoteEdit(''); load() } else { const j = await resp.json().catch(()=>({})); message.error(j?.message || '保存失败') }
                }}>保存扣减</Button>
              </Space>
            </Card>
          ) : null}
        </Form>
    </Modal>
    <Drawer open={view==='list' && detailOpen} onClose={() => setDetailOpen(false)} title="订单详情" width={520}>
      {detailLoading ? <div style={{ padding: 8 }}><span>加载中...</span></div> : null}
      {detail && (
        <Descriptions bordered size="small" column={1}>
          <Descriptions.Item label="来源">{detail.source}</Descriptions.Item>
          <Descriptions.Item label="入住">{detail.checkin ? dayjs(detail.checkin).format('DD/MM/YYYY') : ''}</Descriptions.Item>
          <Descriptions.Item label="退房">{detail.checkout ? dayjs(detail.checkout).format('DD/MM/YYYY') : ''}</Descriptions.Item>
          <Descriptions.Item label="状态">{detail.status}</Descriptions.Item>
          <Descriptions.Item label="付款币种">{(detail as any).payment_currency || 'AUD'}</Descriptions.Item>
          <Descriptions.Item label="到账状态">{(detail as any).payment_received ? '已到账' : '未到账'}</Descriptions.Item>
          <Descriptions.Item label="原始净额">{(detail as any).net_income ?? 0}</Descriptions.Item>
          <Descriptions.Item label="内部扣减汇总">{(detail as any).internal_deduction_total ?? 0}</Descriptions.Item>
          <Descriptions.Item label="可见净额">{(detail as any).visible_net_income ?? (((detail as any).net_income ?? 0))}</Descriptions.Item>
        </Descriptions>
      )}
      <Card style={{ marginTop: 12 }} title="内部扣减" extra={hasPerm('order.deduction.manage') ? (<Button onClick={() => { setDetailEditing(null); setDetailDedAmount(0); setDetailDedDesc(''); setDetailDedNote(''); }}>新增</Button>) : null}>
        <Table size="small" pagination={false} dataSource={detailDeductions} rowKey="id" columns={[
          { title: '金额', dataIndex: 'amount', align: 'right' },
          { title: '币种', dataIndex: 'currency' },
          { title: '事项描述', dataIndex: 'item_desc' },
          { title: '备注', dataIndex: 'note' },
          { title: '状态', dataIndex: 'is_active', render: (v: any) => v ? 'active' : 'void' },
          { title: '操作', render: (_: any, r: any) => hasPerm('order.deduction.manage') ? (
            <Space>
              <Button size="small" onClick={() => { setDetailEditing(r); setDetailDedAmount(Number(r.amount||0)); setDetailDedDesc(r.item_desc || ''); setDetailDedNote(r.note || ''); }}>编辑</Button>
              <Button size="small" danger onClick={() => deleteDetailDeduction(r)}>删除</Button>
            </Space>
          ) : null }
        ]} />
        {hasPerm('order.deduction.manage') ? (
          <Space direction="vertical" style={{ width: '100%', marginTop: 12 }}>
            <InputNumber value={detailDedAmount} onChange={(v) => setDetailDedAmount(Number(v||0))} min={0} style={{ width: '100%' }} />
            <Input value={detailDedDesc} onChange={(e) => setDetailDedDesc(e.target.value)} placeholder="减扣事项描述" />
            <Input value={detailDedNote} onChange={(e) => setDetailDedNote(e.target.value)} placeholder="备注" />
            <Button type="primary" onClick={saveDetailDeduction}>保存扣减</Button>
          </Space>
        ) : null}
      </Card>
    </Drawer>
    <Modal open={importOpen} onCancel={() => setImportOpen(false)} footer={null} title="批量导入订单" width={960} styles={{ body: { maxHeight: 520, overflow: 'auto' } }}>
      <Upload.Dragger {...uploadProps} disabled={importing}>
        <p>点击或拖拽上传 CSV 或 Excel 文件</p>
        <p>平台导出 CSV 按表头解析（不依赖列顺序）：</p>
        <p>Airbnb: Listing, Start date, End date, Amount, Cleaning fee, Guest, Confirmation Code</p>
        <p>Booking: Property Name, Arrival, Departure, Total Payment, Booker Name, Reservation Number, Status</p>
      </Upload.Dragger>
      <Space style={{ marginTop: 12 }}>
        <span>Excel 平台：</span>
        <Radio.Group value={importPlatform} onChange={(e)=> setImportPlatform(e.target.value)}>
          <Radio.Button value="airbnb">Airbnb</Radio.Button>
          <Radio.Button value="booking">Booking.com</Radio.Button>
          <Radio.Button value="other">其他平台</Radio.Button>
        </Radio.Group>
      </Space>
      {importSummary ? (
        <Card size="small" style={{ marginTop: 12 }}>
          <Space wrap>
            <Tag color="green">新增: {importSummary.inserted}</Tag>
            <Tag color="red">跳过: {importSummary.skipped}</Tag>
            {Object.entries(importSummary.reason_counts || {}).map(([k,v]) => (<Tag key={k}>{k}: {v as any}</Tag>))}
          </Space>
          {importResults.length ? (
            <Table rowKey="id" dataSource={importResults} pagination={false} style={{ marginTop: 12 }} size="small" scroll={{ x: 'max-content', y: 240 }}
              columns={[
                { title: '结果', dataIndex: 'ok', render: (v:any)=> v ? <Tag color="green">成功</Tag> : <Tag color="red">失败</Tag> },
                { title: '错误', dataIndex: 'error', render: (v:any)=> v ? <span style={{ wordBreak:'break-all' }}>{String(v)}</span> : '' },
                { title: '来源', dataIndex: 'source' },
                { title: '确认码', dataIndex: 'confirmation_code', render: (v:any)=> <span style={{ wordBreak:'break-all' }}>{v||''}</span> },
                { title: 'Listing 名称', dataIndex: 'listing_name', render: (v:any)=> <span style={{ wordBreak:'break-all' }}>{v||''}</span> },
                { title: '房号', dataIndex: 'property_code' },
                { title: '详情', dataIndex: 'detail', render: (v:any)=> v ? <span style={{ wordBreak:'break-all' }}>{String(v)}</span> : '' },
              ] as any}
            />
          ) : null}
          {importErrors.length ? (
            <Table rowKey={(r:any)=> String(r?.stagingId||r?.confirmation_code||r?.rowIndex||Math.random())}
              dataSource={importErrors}
              pagination={false}
              style={{ marginTop: 12 }}
              size="small"
              scroll={{ x: 'max-content', y: 240 }}
              columns={[
                { title: '行号', dataIndex: 'rowIndex' },
                { title: '确认码', dataIndex: 'confirmation_code', render: (v:any)=> <span style={{ wordBreak:'break-all' }}>{v||''}</span> },
                { title: 'Listing 名称', dataIndex: 'listing_name', render: (v:any)=> <span style={{ wordBreak:'break-all' }}>{v||''}</span> },
                { title: '失败原因', dataIndex: 'reason', render: (v:any)=> <span style={{ wordBreak:'break-all' }}>{String(v||'')}</span> },
              ] as any}
            />
          ) : null}
          {unmatched.length ? (
            <Table rowKey="id" dataSource={unmatched} pagination={false} style={{ marginTop: 12 }} size="small" scroll={{ x: 'max-content', y: 300 }}
              columns={[
                { title: '来源', dataIndex: 'channel' },
                { title: '确认码', dataIndex: 'confirmation_code', render: (v:any)=> <span style={{ wordBreak:'break-all' }}>{v||''}</span> },
                { title: 'Listing 名称', dataIndex: 'listing_name', render: (v:any)=> <span style={{ wordBreak:'break-all' }}>{v||''}</span> },
                { title: '失败原因', dataIndex: 'reason', render: (v:any)=> <Tag color="red">{String(v||'').replace('unmatched_property','找不到房号').replace('missing_confirmation_code','确认码为空').replace('write_failed','写入失败')}</Tag> },
                { title: '选择房号并导入', render: (_:any, r:any) => (
                  <Space>
                    <Select showSearch optionFilterProp="label" filterOption={(input, option)=> String((option as any)?.label||'').toLowerCase().includes(String(input||'').toLowerCase())} placeholder="选择房号" style={{ width: 220 }} options={sortProperties(properties).map(p=>({value:p.id,label:p.code||p.address||p.id}))}
                      onChange={(pid)=>{ (r as any).__pid = pid }} />
                    <Button type="primary" onClick={()=> resolveImport(r.id, (r as any).__pid)}>导入</Button>
                  </Space>
                ) }
              ] as any}
            />
          ) : <p style={{ marginTop: 12 }}>无未匹配记录</p>}
        </Card>
      ) : null}
    </Modal>
    </Card>
  )
}
  async function taskStatus(orderId: string) {
    const res = await fetch(`${API_BASE}/cleaning/order/${orderId}`)
    const tasks: CleaningTask[] = await res.json()
    if (!tasks.length) return <Tag>无任务</Tag>
    const anyScheduled = tasks.some(t => t.status === 'scheduled')
    const allDone = tasks.every(t => t.status === 'done')
    if (allDone) return <Tag color="green">已完成</Tag>
    if (anyScheduled) return <Tag color="blue">已排班</Tag>
    return <Tag color="orange">待安排</Tag>
  }
          <Form.Item name="payment_currency" label="付款币种" initialValue="AUD">
            <Select options={[{ value: 'AUD', label: 'AUD' }, { value: 'RMB', label: 'RMB' }, { value: 'USD', label: 'USD' }, { value: 'EUR', label: 'EUR' }, { value: 'OTHER', label: 'Other' }]} />
          </Form.Item>
  
