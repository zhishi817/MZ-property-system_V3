"use client"
import { Card, DatePicker, Table, Select, Button, Modal, message, Switch, Progress, Spin } from 'antd'
import styles from './ExpandedRow.module.css'
import dayjs from 'dayjs'
import { useEffect, useMemo, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'
import { getJSON, apiList, API_BASE, authHeaders, patchJSON } from '../../../lib/api'
import { sortProperties, sortPropertiesByRegionThenCode } from '../../../lib/properties'
import MonthlyStatementView from '../../../components/MonthlyStatement'
import { monthSegments, toDayStr, getMonthSegmentsForProperty, isOwnerStay } from '../../../lib/orders'
import { normalizeReportCategory, shouldIncludeIncomeTxInPropertyOtherIncome } from '../../../lib/financeTx'
import { computeMonthlyStatementBalanceDebug, isFurnitureOwnerPayment, isFurnitureRecoverableCharge } from '../../../lib/statementBalances'
import { formatStatementDesc } from '../../../lib/statementDesc'
import FiscalYearStatement from '../../../components/FiscalYearStatement'
import { MailOutlined, CreditCardOutlined, CheckOutlined } from '@ant-design/icons'
import { nextToggleValue } from '../../../lib/toggleStatus'
import { exportElementToPdfBlob } from '../../../lib/pdfExport'
import { buildStatementTxs, type StatementTx } from '../../../lib/statementTx'
import { DEFAULT_MONTHLY_STATEMENT_CARRY_START_MONTH } from '../../../lib/monthlyStatementPrint'
import { canDownloadSplitPart, pickSplitPhotosMode, splitPartPhotoCount, type MergeSplitInfo } from '../../../lib/monthlyStatementPhotoSplit'
import { findLandlordForProperty, resolveManagementFeeRuleForMonth, type LandlordWithManagementFeeRules } from '../../../lib/managementFeeRules'

type Order = { id: string; property_id?: string; stay_type?: 'guest' | 'owner'; checkin?: string; checkout?: string; price?: number; cleaning_fee?: number; nights?: number; status?: string; count_in_income?: boolean }
type Tx = StatementTx
type Landlord = LandlordWithManagementFeeRules
type DeepCleaning = { id: string; property_id?: string; property_code?: string; code?: string; occurred_at?: string; completed_at?: string; submitted_at?: string; created_at?: string; pay_method?: any; total_cost?: any; labor_cost?: any; consumables?: any; work_no?: string }
type RevenueStatus = { scheduled_email_set: boolean; transferred: boolean }
type PendingOps = Record<string, { scheduled?: boolean; transfer?: boolean }>
type MergeUiStatus = 'active' | 'exception' | 'success'

export default function PropertyRevenuePage() {
  const getDefaultRevenueMonth = (now = dayjs()) => (now.date() < 6 ? now.subtract(1, 'month') : now)
  const pathname = usePathname()
  const [month, setMonth] = useState<any>(getDefaultRevenueMonth())
  const [orders, setOrders] = useState<Order[]>([])
  const [rentIncomeByMonth, setRentIncomeByMonth] = useState<Record<string, Record<string, number>>>({})
  const rentIncomeByMonthRef = useRef<Record<string, Record<string, number>>>({})
  const rangeRef = useRef<{ start: any; end: any } | null>(null)
  const [rentSegByKey, setRentSegByKey] = useState<Record<string, { loading: boolean; segments: any[]; rent_income: number; error?: string }>>({})
  const rentKey = (pid: string, monthKey: string) => `${String(pid)}__${String(monthKey)}`
  const [txs, setTxs] = useState<Tx[]>([])
  const [deepCleaningExpenseTxs, setDeepCleaningExpenseTxs] = useState<Tx[]>([])
  const [pageLoading, setPageLoading] = useState<boolean>(true)
  const [rangeLoading, setRangeLoading] = useState<boolean>(false)
  const [excludeOrphanFixedSnapshots, setExcludeOrphanFixedSnapshots] = useState<boolean>(true)
  const [orphanFixedSnapshots, setOrphanFixedSnapshots] = useState<any[]>([])
  const [orphanOpen, setOrphanOpen] = useState(false)
  const [properties, setProperties] = useState<{ id: string; code?: string; address?: string; region?: string }[]>([])
  const [landlords, setLandlords] = useState<Landlord[]>([])
  const [selectedPid, setSelectedPid] = useState<string | undefined>(undefined)
  const [selectedRegion, setSelectedRegion] = useState<string | undefined>(undefined)
  const [previewPid, setPreviewPid] = useState<string | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewReady, setPreviewReady] = useState(false)
  const [carryDiagOpen, setCarryDiagOpen] = useState(false)
  const [, setStatementPdfMode] = useState(false)
  const [exportQuality, setExportQuality] = useState<'standard' | 'high' | 'ultra'>('ultra')
  const [mergeUi, setMergeUi] = useState<{ open: boolean; percent: number; status: MergeUiStatus; stage: string; detail?: string }>({ open: false, percent: 0, status: 'active', stage: '', detail: '' })
  const [mergeSplit, setMergeSplit] = useState<MergeSplitInfo | null>(null)
  const [mergeNoPhotos, setMergeNoPhotos] = useState<boolean>(false)
  const [splitDl, setSplitDl] = useState<{ maintenance: boolean; deepCleaning: boolean }>({ maintenance: false, deepCleaning: false })
  const [exportPreview, setExportPreview] = useState<{ open: boolean; url: string; pageCount: number; filename: string; loading: boolean }>({ open: false, url: '', pageCount: 0, filename: '', loading: false })
  const printRef = useRef<HTMLDivElement>(null)
  const mergeStartBtnRef = useRef<HTMLButtonElement | null>(null)
  const [period, setPeriod] = useState<'month'|'year'|'half-year'|'fiscal-year'>('month')
  const [startMonth, setStartMonth] = useState<any>(getDefaultRevenueMonth())
  const [showChinese, setShowChinese] = useState<boolean>(true)
  const [revenueStatusByKey, setRevenueStatusByKey] = useState<Record<string, RevenueStatus>>({})
  const [baselineStatusByKey, setBaselineStatusByKey] = useState<Record<string, Partial<RevenueStatus>>>({})
  const [pendingOps, setPendingOps] = useState<PendingOps>({})
  const statusKeyOf = (pid: string, monthKey: string) => `${String(pid)}__${String(monthKey)}`
  const isMerging = mergeUi.open && mergeUi.status === 'active'
  const rawRef = useRef<{ fin: any[]; pexp: any[]; recurs: any[] } | null>(null)
  const deepCleaningCacheRef = useRef<Map<string, Tx[]>>(new Map())
  const monthPhotoStatsSigRef = useRef<string>('')
  const mountedRef = useRef<boolean>(true)
  const reloadTimerRef = useRef<any>(null)
  const reloadInFlightRef = useRef<boolean>(false)
  const reloadOrdersOnlyRef = useRef<null | (() => void)>(null)
  useEffect(() => { rentIncomeByMonthRef.current = rentIncomeByMonth }, [rentIncomeByMonth])
  const closeExportPreview = () => {
    setExportPreview((prev) => {
      try { if (prev.url) URL.revokeObjectURL(prev.url) } catch {}
      return { ...prev, open: false, url: '', loading: false }
    })
  }
  const downloadNamedBlob = (blob: Blob, filename: string) => {
    try {
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch {}
  }
  const downloadSplitPart = async (kind: 'maintenance' | 'deep_cleaning') => {
    if (!previewPid) return
    const partCount = splitPartPhotoCount(mergeSplit, kind)
    if (mergeSplit && partCount <= 0) {
      message.warning(kind === 'maintenance' ? '本月没有可下载的维修照片分卷' : '本月没有可下载的深清照片分卷')
      return
    }
    const key = kind === 'maintenance' ? 'maintenance' : 'deepCleaning'
    setSplitDl((prev) => ({ ...prev, [key]: true }))
    try {
      const prop = properties.find(p => String(p.id) === String(previewPid || ''))
      const codeLabel = (prop?.code || prop?.address || String(previewPid || '')).toString().trim()
      const prefix = `Monthly Statement - ${month.format('YYYY-MM')}`
      const label = kind === 'maintenance' ? 'Maintenance Photos' : 'Deep Cleaning Photos'
      const filename = `${prefix}${codeLabel ? ' - ' + codeLabel : ''} - ${label}.pdf`
      const requestSplitPdf = async (mode: 'compressed' | 'thumbnail', cfg: { photo_w: number; photo_q: number }) => {
        return fetch(`${API_BASE}/finance/monthly-statement-photos-pdf`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ month: month.format('YYYY-MM'), property_id: previewPid, showChinese, includePhotosMode: mode, sections: kind, ...cfg }),
        })
      }
      const primaryMode = pickSplitPhotosMode(partCount, exportQuality)
      const primaryCfg = primaryMode === 'thumbnail'
        ? { photo_w: 1000, photo_q: 55 }
        : (exportQuality === 'standard' ? { photo_w: 1200, photo_q: 65 } : { photo_w: 1600, photo_q: 72 })
      let resp: Response
      try {
        resp = await requestSplitPdf(primaryMode, primaryCfg)
      } catch {
        resp = await requestSplitPdf('thumbnail', { photo_w: 820, photo_q: 45 })
      }
      if (!resp.ok && (resp.status === 502 || resp.status === 504)) {
        resp = await requestSplitPdf('thumbnail', { photo_w: 820, photo_q: 45 })
      }
      if (!resp.ok) {
        let msg = `HTTP ${resp.status}`
        try {
          const j = await resp.json() as any
          const diagParts = [
            j?.diagnosticKind ? `kind=${String(j.diagnosticKind)}` : '',
            j?.reqId ? `reqId=${String(j.reqId)}` : '',
            j?.rawUrls !== undefined ? `raw=${Number(j.rawUrls || 0)}` : '',
            j?.cleanedUrls !== undefined ? `cleaned=${Number(j.cleanedUrls || 0)}` : '',
            j?.imageCount !== undefined ? `images=${Number(j.imageCount || 0)}` : '',
          ].filter(Boolean)
          msg = String(j?.message || msg)
          if (diagParts.length) msg = `${msg} (${diagParts.join(', ')})`
        } catch {}
        throw new Error(msg)
      }
      const blob = await resp.blob()
      downloadNamedBlob(blob, filename)
    } catch (e: any) {
      message.error(e?.message || '下载失败')
    } finally {
      setSplitDl((prev) => ({ ...prev, [key]: false }))
    }
  }

  const pickExportParams = (mode: 'standard' | 'high' | 'ultra') => {
    if (mode === 'standard') return { scale: 2, imageQuality: 0.82, imageType: 'jpeg' as const }
    if (mode === 'high') return { scale: 3, imageQuality: 0.9, imageType: 'jpeg' as const }
    return { scale: 4, imageQuality: 0.98, imageType: 'png' as const }
  }
  const pickMonthPhotoCfg = (level: 'normal' | 'low') => {
    if (exportQuality === 'standard') return level === 'low' ? { photo_w: 1000, photo_q: 55 } : { photo_w: 1200, photo_q: 65 }
    return level === 'low' ? { photo_w: 1200, photo_q: 60 } : { photo_w: 1600, photo_q: 72 }
  }
  const resolveMonthPdfCfg = (splitInfo: any | null, noPhotos = false) => {
    const shouldSplit = !!splitInfo?.shouldSplit
    const hardSplit = !!splitInfo?.hardSplit
    const photosMode: 'full' | 'compressed' | 'thumbnail' | 'off' = noPhotos
      ? 'off'
      : ((shouldSplit || hardSplit) ? 'off' : (exportQuality === 'ultra' ? 'full' : 'compressed'))
    const photoCfg = photosMode === 'compressed' ? pickMonthPhotoCfg('normal') : null
    const sectionsApi = photosMode === 'off' ? 'base' : 'all'
    const sectionsView = [sectionsApi]
    return { shouldSplit, hardSplit, photosMode, photoCfg, sectionsApi, sectionsView }
  }
  const buildTxsFromRaw = (fin: any[], pexp: any[], recurs: any[], props: any[], excludeOrphans: boolean) => {
    const propsArr = Array.isArray(props) ? props : []
    return buildStatementTxs(Array.isArray(fin) ? fin : [], Array.isArray(pexp) ? pexp : [], {
      properties: propsArr,
      recurring_payments: Array.isArray(recurs) ? recurs : [],
      excludeOrphanFixedSnapshots: excludeOrphans,
    })
  }

  const fetchRentIncomeByProperty = async (monthKey: string, force = false) => {
    const mk = String(monthKey || '').trim()
    if (!/^\d{4}-\d{2}$/.test(mk)) return
    if (!force && rentIncomeByMonthRef.current[mk]) return
    const qs = new URLSearchParams({ month: mk }).toString()
    const resp = await getJSON<any>(`/finance/rent-income-by-property?${qs}`).catch(() => null as any)
    const map: Record<string, number> = {}
    const rows = Array.isArray(resp?.rows) ? resp.rows : []
    for (const r of rows) {
      const pid = String(r?.property_id || '').trim()
      if (!pid) continue
      map[pid] = Number(r?.rent_income || 0) || 0
    }
    setRentIncomeByMonth((prev) => ({ ...prev, [mk]: map }))
  }

  const refreshRentIncomeForRange = async (force = false) => {
    const rr = rangeRef.current
    if (!rr?.start || !rr?.end) return
    const monthKeys: string[] = []
    let cur = rr.start.startOf('month')
    const last = rr.end.startOf('month')
    while (cur.isSame(last, 'month') || cur.isBefore(last, 'month')) {
      monthKeys.push(cur.format('YYYY-MM'))
      cur = cur.add(1, 'month')
    }
    await Promise.all(monthKeys.map((mk) => fetchRentIncomeByProperty(mk, force)))
  }

  const fetchRentSegments = async (pidRaw: string, monthKeyRaw: string) => {
    const pid = String(pidRaw || '').trim()
    const mk = String(monthKeyRaw || '').trim()
    if (!pid || !/^\d{4}-\d{2}$/.test(mk)) return
    const k = rentKey(pid, mk)
    const cur = rentSegByKey[k]
    if (cur?.loading) return
    if (Array.isArray(cur?.segments) && cur.segments.length) return
    setRentSegByKey((m) => ({ ...m, [k]: { loading: true, segments: [], rent_income: 0 } }))
    try {
      const qs = new URLSearchParams({ month: mk, property_id: pid }).toString()
      const resp = await getJSON<any>(`/finance/rent-segments?${qs}`)
      const segs = Array.isArray(resp?.segments) ? resp.segments : []
      const rentIncome = Number(resp?.rent_income || 0) || 0
      setRentSegByKey((m) => ({ ...m, [k]: { loading: false, segments: segs, rent_income: rentIncome } }))
    } catch (e: any) {
      setRentSegByKey((m) => ({ ...m, [k]: { loading: false, segments: [], rent_income: 0, error: String(e?.message || '加载失败') } }))
    }
  }

  useEffect(() => {
    mountedRef.current = true
    const reload = async (opts?: { ordersOnly?: boolean }) => {
      const ordersOnly = !!opts?.ordersOnly
      if (reloadInFlightRef.current) return
      reloadInFlightRef.current = true
      try {
        if (ordersOnly) {
          setRangeLoading(true)
          const ordersRes = await getJSON<Order[]>('/orders').catch(() => [] as any[])
          if (!mountedRef.current) return
          setOrders(Array.isArray(ordersRes) ? ordersRes : [])
          await refreshRentIncomeForRange(true).catch(() => {})
          return
        }
        setPageLoading(true)
        const [ordersRes, propsRes, landlordsRes, finRes, pexpRes, recursRes] = await Promise.all([
          getJSON<Order[]>('/orders').catch(() => [] as any[]),
          getJSON<any>('/properties').catch(() => [] as any[]),
          getJSON<Landlord[]>('/landlords').catch(() => [] as any[]),
          getJSON<Tx[]>('/finance').catch(() => [] as any[]),
          apiList<any[]>('property_expenses').catch(() => [] as any[]),
          apiList<any[]>('recurring_payments').catch(() => [] as any[]),
        ])
        if (!mountedRef.current) return
        const propsArr = Array.isArray(propsRes) ? propsRes : []
        setOrders(Array.isArray(ordersRes) ? ordersRes : [])
        setProperties(propsArr)
        setLandlords(Array.isArray(landlordsRes) ? landlordsRes : [])
        rawRef.current = { fin: Array.isArray(finRes) ? finRes : [], pexp: Array.isArray(pexpRes) ? pexpRes : [], recurs: Array.isArray(recursRes) ? recursRes : [] }
        const built = buildTxsFromRaw(rawRef.current.fin, rawRef.current.pexp, rawRef.current.recurs, propsArr, excludeOrphanFixedSnapshots)
        setOrphanFixedSnapshots(built.orphanRows)
        if (built.orphanCount > 0) {
          const amt = (built.orphanTotal || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
          message.warning({
            key: 'orphanFixedExpenseSnapshots',
            content: (
              <span>
                检测到 {built.orphanCount} 条孤儿固定支出快照（合计 ${amt}）。当前{excludeOrphanFixedSnapshots ? '已排除' : '仍计入'}房源营收统计。
                <Button type="link" style={{ padding: 0, marginLeft: 8 }} onClick={() => setOrphanOpen(true)}>查看明细</Button>
              </span>
            ),
            duration: 8
          })
        } else {
          message.destroy('orphanFixedExpenseSnapshots')
        }
        setTxs(built.txs)
        await refreshRentIncomeForRange(true).catch(() => {})
      } finally {
        if (mountedRef.current) {
          setPageLoading(false)
          setRangeLoading(false)
        }
        reloadInFlightRef.current = false
      }
    }
    const scheduleReloadOrders = () => {
      try { if (reloadTimerRef.current) clearTimeout(reloadTimerRef.current) } catch {}
      reloadTimerRef.current = setTimeout(() => { reload({ ordersOnly: true }) }, 350)
    }
    reloadOrdersOnlyRef.current = scheduleReloadOrders
    const onVis = () => { if (document.visibilityState === 'visible') scheduleReloadOrders() }
    const onFocus = () => { scheduleReloadOrders() }

    reload()
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('focus', onFocus)
    return () => {
      mountedRef.current = false
      try { if (reloadTimerRef.current) clearTimeout(reloadTimerRef.current) } catch {}
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  useEffect(() => {
    const p = String(pathname || '')
    if (p === '/finance/properties-overview' || p === '/finance/performance/revenue') {
      try { reloadOrdersOnlyRef.current?.() } catch {}
    }
  }, [pathname])

  useEffect(() => {
    const raw = rawRef.current
    if (!raw) return
    if (!properties.length) return
    const built = buildTxsFromRaw(raw.fin, raw.pexp, raw.recurs, properties as any, excludeOrphanFixedSnapshots)
    setOrphanFixedSnapshots(built.orphanRows)
    if (built.orphanCount > 0) {
      const amt = (built.orphanTotal || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      message.warning({
        key: 'orphanFixedExpenseSnapshots',
        content: (
          <span>
            检测到 {built.orphanCount} 条孤儿固定支出快照（合计 ${amt}）。当前{excludeOrphanFixedSnapshots ? '已排除' : '仍计入'}房源营收统计。
            <Button type="link" style={{ padding: 0, marginLeft: 8 }} onClick={() => setOrphanOpen(true)}>查看明细</Button>
          </span>
        ),
        duration: 8
      })
    } else {
      message.destroy('orphanFixedExpenseSnapshots')
    }
    setTxs(built.txs)
  }, [excludeOrphanFixedSnapshots, properties])
  const start = useMemo(() => {
    const base = month || dayjs()
    if (period === 'fiscal-year') {
      const fyStartYear = base.month() >= 6 ? base.year() : base.year() - 1
      return dayjs(`${fyStartYear}-07-01`)
    }
    if (period === 'year') return base.startOf('year')
    if (period === 'half-year') return (startMonth || base).startOf('month')
    return base.startOf('month')
  }, [month, period, startMonth])
  const end = useMemo(() => {
    const base = month || dayjs()
    if (period === 'fiscal-year') {
      const fyStartYear = base.month() >= 6 ? base.year() : base.year() - 1
      return dayjs(`${fyStartYear + 1}-06-30`).endOf('day')
    }
    if (period === 'year') return base.endOf('year')
    if (period === 'half-year') return (startMonth || base).startOf('month').add(5, 'month').endOf('month')
    return base.endOf('month')
  }, [month, period, startMonth])

  useEffect(() => {
    if (!start || !end) { rangeRef.current = null; return }
    rangeRef.current = { start, end }
  }, [start, end])

  useEffect(() => {
    refreshRentIncomeForRange(false).catch(() => {})
  }, [start?.format('YYYY-MM'), end?.format('YYYY-MM')])

  const statusRange = useMemo(() => {
    if (!start || !end) return null
    return { from: start.format('YYYY-MM'), to: end.format('YYYY-MM') }
  }, [start, end])

  useEffect(() => {
    ;(async () => {
      try {
        if (!start || !end) { setDeepCleaningExpenseTxs([]); return }
        if (pageLoading) return
        const normCode = (raw?: any) => {
          const s0 = String(raw || '').trim()
          if (!s0) return ''
          const s = s0.split('(')[0].trim()
          const t = s.split(/\s+/)[0].trim()
          return t || s || s0
        }
        const isOwnerPay = (v: any) => {
          const raw = String(v || '')
          const s = raw.trim().toLowerCase()
          if (!s) return false
          if (s === 'landlord_pay') return true
          if (s.includes('landlord') || s.includes('owner')) return true
          if (raw.includes('房东')) return true
          return false
        }
        const parseArr = (raw: any) => {
          if (Array.isArray(raw)) return raw
          if (typeof raw === 'string') { try { const j = JSON.parse(raw); return Array.isArray(j) ? j : [] } catch { return [] } }
          return []
        }
        const from = start.startOf('month').format('YYYY-MM-DD')
        const to = end.endOf('month').format('YYYY-MM-DD')
        const cacheKey = `${start.format('YYYY-MM')}|${end.format('YYYY-MM')}`
        const cached = deepCleaningCacheRef.current.get(cacheKey)
        if (cached) { setDeepCleaningExpenseTxs(cached); return }
        setRangeLoading(true)
        const list = await apiList<DeepCleaning[]>('property_deep_cleaning', { occurred_at_from: from, occurred_at_to: to, limit: 5000 } as any).catch(() => [])
        const propsById = new Map((properties || []).map(p => [String(p.id), p]))
        const propsByCode = new Map((properties || []).map(p => [normCode((p as any).code), p]))
        const out: Tx[] = []
        for (const d of (Array.isArray(list) ? list : [])) {
          if (!isOwnerPay((d as any).pay_method)) continue
          const pidRaw = String((d as any).property_id || '').trim()
          const codeRaw = String((d as any).property_code || (d as any).code || '').trim()
          const pid = pidRaw && propsById.has(pidRaw) ? pidRaw : (propsByCode.get(normCode(codeRaw))?.id || '')
          if (!pid) continue
          const labor = Number((d as any).labor_cost || 0)
          const laborN = Number.isFinite(labor) ? labor : 0
          const arr = parseArr((d as any).consumables)
          const sum = arr.reduce((s: number, x: any) => {
            const n = Number(x?.cost || 0)
            return s + (Number.isFinite(n) ? n : 0)
          }, 0)
          const fallback = Math.round(((laborN + sum) + Number.EPSILON) * 100) / 100
          const amount = Number(((d as any).total_cost !== undefined && (d as any).total_cost !== null) ? (d as any).total_cost : fallback) || 0
          if (!(amount > 0)) continue
          const dt = String((d as any).occurred_at || (d as any).completed_at || (d as any).created_at || '').slice(0, 10) || from
          out.push({
            id: `deep-cleaning-${String((d as any).id || '')}`,
            kind: 'expense',
            amount,
            currency: 'AUD',
            property_id: pid,
            occurred_at: dt,
            category: 'other',
            category_detail: 'Deep cleaning maintenance',
            ref_type: 'deep_cleaning',
            ref_id: String((d as any).id || ''),
          } as any)
        }
        deepCleaningCacheRef.current.set(cacheKey, out)
        setDeepCleaningExpenseTxs(out)
      } catch {
        setDeepCleaningExpenseTxs((prev) => prev)
      } finally {
        setRangeLoading(false)
      }
    })()
  }, [start?.format('YYYY-MM'), end?.format('YYYY-MM'), properties, pageLoading])

  const txsAll = useMemo(() => {
    const base = Array.isArray(txs) ? txs : []
    const extra = Array.isArray(deepCleaningExpenseTxs) ? deepCleaningExpenseTxs : []
    if (!extra.length) return base
    return base.concat(extra)
  }, [txs, deepCleaningExpenseTxs])

  useEffect(() => {
    if (!statusRange?.from || !statusRange?.to) return
    const qs = new URLSearchParams({ from: statusRange.from, to: statusRange.to, ...(selectedPid ? { property_id: selectedPid } : {}) }).toString()
    getJSON<any[]>(`/finance/property-revenue-status?${qs}`)
      .then((list) => {
        const map: Record<string, RevenueStatus> = {}
        for (const r of (Array.isArray(list) ? list : [])) {
          const k = statusKeyOf(String((r as any).property_id || ''), String((r as any).month_key || ''))
          map[k] = { scheduled_email_set: !!(r as any).scheduled_email_set, transferred: !!(r as any).transferred }
        }
        setRevenueStatusByKey(map)
      })
      .catch(() => setRevenueStatusByKey({}))
  }, [statusRange?.from, statusRange?.to, selectedPid])

  useEffect(() => {
    if (!previewOpen || !previewPid || period !== 'month') return
    const pid = String(previewPid || '').trim()
    const monthKey = month?.format?.('YYYY-MM') || ''
    if (!pid || !monthKey) return
    const sig = `${pid}__${monthKey}`
    if (monthPhotoStatsSigRef.current === sig) return
    monthPhotoStatsSigRef.current = sig
    setMergeSplit(null)
    let cancelled = false
    ;(async () => {
      try {
        const resp = await fetch(`${API_BASE}/finance/monthly-statement-photo-stats?pid=${encodeURIComponent(pid)}&month=${encodeURIComponent(monthKey)}`, { headers: authHeaders() })
        if (cancelled) return
        if (resp.ok) {
          const j = await resp.json()
          if (!cancelled) setMergeSplit(j as any)
        }
      } catch {}
    })()
    return () => { cancelled = true }
  }, [previewOpen, previewPid, period, month?.format?.('YYYY-MM')])

  useEffect(() => {
    if (!previewOpen || !previewPid || period !== 'month') return
    const pid = String(previewPid || '').trim()
    const mk = month?.format?.('YYYY-MM') || ''
    if (!pid || !mk) return
    fetchRentSegments(pid, mk).catch(() => {})
  }, [previewOpen, previewPid, period, month?.format?.('YYYY-MM')])

  const monthPdfCfg = useMemo(() => {
    if (period !== 'month' || !previewPid) return null
    return resolveMonthPdfCfg(mergeSplit, mergeNoPhotos)
  }, [period, previewPid, mergeSplit, mergeNoPhotos, exportQuality])

  const previewCarryDebug = useMemo(() => {
    if (!previewPid || period !== 'month') return null
    const monthKey = month?.format?.('YYYY-MM') || ''
    if (!/^\d{4}-\d{2}$/.test(monthKey)) return null
    const property = properties.find(p => String(p.id) === String(previewPid))
    const landlord = findLandlordForProperty(landlords, String(previewPid), (property as any)?.landlord_id)
    const rule = resolveManagementFeeRuleForMonth(landlord, monthKey)
    return computeMonthlyStatementBalanceDebug({
      month: monthKey,
      propertyId: String(previewPid),
      propertyCode: property?.code,
      orders,
      txs: txsAll,
      managementFeeRate: rule.rate ?? undefined,
      carryStartMonth: DEFAULT_MONTHLY_STATEMENT_CARRY_START_MONTH,
    })
  }, [previewPid, period, month, properties, landlords, orders, txsAll])

  useEffect(() => {
    if (!previewOpen || !previewPid || period !== 'month') { setPreviewReady(true); return }
    let cancelled = false
    setPreviewReady(false)
    ;(async () => {
      const el = printRef.current as HTMLElement | null
      if (!el) return
      const t0 = Date.now()
      while (Date.now() - t0 < 12000) {
        if (cancelled) return
        if (String(el.getAttribute('data-monthly-statement-root') || '') !== '1') { await new Promise(r => setTimeout(r, 80)); continue }
        const deepLoaded = String(el.getAttribute('data-deep-clean-loaded') || '') === '1'
        const maintLoaded = String(el.getAttribute('data-maint-loaded') || '') === '1'
        if (deepLoaded && maintLoaded) break
        await new Promise(r => setTimeout(r, 80))
      }
      const deepCnt = Number(el.getAttribute('data-deep-clean-count') || 0)
      if (Number.isFinite(deepCnt) && deepCnt > 0) {
        while (Date.now() - t0 < 12000) {
          if (cancelled) return
          if (el.querySelector('[data-deep-clean-section="1"]')) break
          await new Promise(r => setTimeout(r, 80))
        }
      }
      const maintCnt = Number(el.getAttribute('data-maint-count') || 0)
      if (Number.isFinite(maintCnt) && maintCnt > 0) {
        while (Date.now() - t0 < 12000) {
          if (cancelled) return
          if (el.querySelector('[data-maint-section="1"]')) break
          await new Promise(r => setTimeout(r, 80))
        }
      }
      if (!cancelled) setPreviewReady(true)
    })()
    return () => { cancelled = true }
  }, [previewOpen, previewPid, period, month?.format?.('YYYY-MM'), showChinese])

  const orderById = useMemo(() => new Map((orders || []).map(o => [String(o.id), o])), [orders])
  const txBucketIndex = useMemo(() => {
    const txMonthKey = (tx: any): string => {
      const mk = String(tx?.month_key || '')
      if (/^\d{4}-\d{2}$/.test(mk)) return mk
      const raw: any = tx?.paid_date || tx?.occurred_at || tx?.due_date || tx?.created_at
      const d = toDayStr(raw)
      if (!d) return ''
      return dayjs(d).format('YYYY-MM')
    }
    const mapIncomeCatLabel = (c?: string) => {
      const v = String(c || '')
      if (v === 'late_checkout') return '晚退房费'
      if (v === 'cancel_fee') return '取消费'
      return v || '-'
    }
    const parseMaybeJson = (raw: any): any => {
      if (raw === null || raw === undefined) return raw
      if (typeof raw !== 'string') return raw
      const s = raw.trim()
      if (!s) return ''
      const head = s[0]
      if (head !== '{' && head !== '[') return s
      try { return JSON.parse(s) } catch { return s }
    }
    const extractHumanText = (raw: any): string => {
      const v = parseMaybeJson(raw)
      if (!v) return ''
      if (Array.isArray(v)) {
        for (const it of v) {
          const i = String((it as any)?.item || '').trim()
          if (i) return i
          const c = String((it as any)?.content || '').trim()
          if (c) return c
          const s = String(it || '').trim()
          if (s) return s
        }
        return ''
      }
      if (typeof v === 'object') {
        const i = String((v as any)?.item || '').trim()
        if (i) return i
        const c = String((v as any)?.content || '').trim()
        if (c) return c
      }
      return String(v || '').trim()
    }
    const squeezeInstruction = (s: string): string => {
      const m = s.match(/只(?:要)?显示[:：]?\s*([^，,。]+)\s*/i)
      if (m?.[1]) return String(m[1]).trim()
      return s
    }
    const cleanOtherDesc = (raw?: any): string => {
      let s = String(raw || '').trim()
      if (!s) return ''
      s = s.replace(/^other\s*,\s*/i, '')
      s = s.replace(/^其他\s*[，,]\s*/i, '')
      if (/^(other|其他)$/i.test(s)) return ''
      if (/^fixed\s*payment$/i.test(s)) return ''
      s = squeezeInstruction(s)
      return s
    }
    const otherDescOfTx = (t: any): string => {
      const rt = String((t as any)?.ref_type || '').trim().toLowerCase()
      if (rt === 'maintenance' || rt === 'deep_cleaning') return cleanOtherDesc(extractHumanText((t as any)?.source_summary || ''))
      return cleanOtherDesc(extractHumanText((t as any)?.category_detail || (t as any)?.note || ''))
    }
    const propsArr = Array.isArray(properties) ? properties : []
    const codeToId = new Map(propsArr.map(p => [String((p as any).code || '').trim().toLowerCase(), String((p as any).id || '')]))
    const idx = new Map<string, Map<string, any>>()
    for (const t of (Array.isArray(txsAll) ? txsAll : [])) {
      const kind = String((t as any).kind || '')
      if (kind !== 'income' && kind !== 'expense') continue
      let pid = String((t as any).property_id || '').trim()
      if (!pid) {
        const code = String((t as any).property_code || '').trim().toLowerCase()
        pid = code ? (codeToId.get(code) || '') : ''
      }
      if (!pid) continue
      const mk = txMonthKey(t)
      if (!/^\d{4}-\d{2}$/.test(mk)) continue
      let byMonth = idx.get(pid)
      if (!byMonth) { byMonth = new Map(); idx.set(pid, byMonth) }
      let b = byMonth.get(mk)
      if (!b) {
        b = { expSums: {}, otherItems: [], otherFmt: { text: '-', full: '-' }, otherIncome: 0, otherIncomeCats: new Set(), furnitureCharge: 0, furnitureOwnerPaid: 0 }
        byMonth.set(mk, b)
      }
      if (kind === 'expense') {
        const amt = Number((t as any).amount || 0)
        if (!Number.isFinite(amt) || !(amt > 0)) continue
        if (isFurnitureRecoverableCharge(t as any)) {
          b.furnitureCharge += amt
          continue
        }
        const cat = normalizeReportCategory((t as any).report_category || (t as any).category)
        if (cat === 'other') {
          const pm = String((t as any).pay_method || (t as any).payment_type || '').trim().toLowerCase()
          if (pm) {
            const isRentDeduction = pm.includes('rent_deduction') || pm.includes('rent-deduction') || pm.includes('租金')
            if (isRentDeduction) continue
            const isLandlordPay = pm.includes('landlord') || pm.includes('owner') || pm.includes('房东')
            if (!isLandlordPay) continue
          }
        }
        b.expSums[cat] = Number(b.expSums[cat] || 0) + amt
        if (cat === 'other') {
          const d = otherDescOfTx(t)
          if (d) b.otherItems.push(d)
        }
        continue
      }
      const amt = Number((t as any).amount || 0)
      if (!Number.isFinite(amt) || !(amt > 0)) continue
      if (isFurnitureOwnerPayment(t as any)) {
        b.furnitureOwnerPaid += amt
        continue
      }
      if (String((t as any).category || '').toLowerCase() === 'late_checkout') continue
      if (!shouldIncludeIncomeTxInPropertyOtherIncome(t as any, orderById as any)) continue
      b.otherIncome += amt
      b.otherIncomeCats.add(mapIncomeCatLabel((t as any).category))
    }
    for (const [, byMonth] of idx) {
      for (const [, b] of byMonth) {
        const items = Array.from(new Set<string>((b.otherItems || []).map((x: any) => String(x || '').trim()).filter((x: string) => !!x)))
        const fmt0 = formatStatementDesc({ items, lang: 'en' })
        b.otherFmt = fmt0
        b.otherItems = items
      }
    }
    return idx
  }, [txsAll, properties, orderById])

  const regionOptions = useMemo(() => {
    const sorted = sortPropertiesByRegionThenCode(properties as any)
    const seen = new Set<string>()
    const opts: { value: string; label: string }[] = []
    for (const p of sorted) {
      const r = String((p as any)?.region || '').trim()
      if (!r || seen.has(r)) continue
      seen.add(r)
      opts.push({ value: r, label: r })
    }
    return opts
  }, [properties])

  const filteredProperties = useMemo(() => {
    const arr = Array.isArray(properties) ? properties : []
    if (!selectedRegion) return arr
    return arr.filter(p => String((p as any)?.region || '') === String(selectedRegion))
  }, [properties, selectedRegion])

  const rows = useMemo(() => {
    if (!start || !end) return [] as any[]
    const list = selectedPid
      ? properties.filter(pp => pp.id === selectedPid)
      : (selectedRegion ? sortProperties(filteredProperties as any) : sortPropertiesByRegionThenCode(properties as any))
    const out: any[] = []
    const rangeMonths: { start: any, end: any, label: string }[] = []
    let cur = start.startOf('month')
    const last = end.startOf('month')
    while (cur.isSame(last, 'month') || cur.isBefore(last, 'month')) {
      rangeMonths.push({ start: cur.startOf('month'), end: cur.add(1,'month').startOf('month'), label: cur.format('MM/YYYY') })
      cur = cur.add(1,'month')
    }
    for (const p of list) {
      for (const rm of rangeMonths) {
        const related = getMonthSegmentsForProperty(orders as any, rm.start, String(p.id))
        const mk = rm.start.format('YYYY-MM')
        const rentIncome = Number(rentIncomeByMonth[mk]?.[String(p.id)] ?? 0) || 0
        const b = txBucketIndex.get(String(p.id))?.get(mk)
        const otherIncome = Number(b?.otherIncome || 0)
        const otherIncomeDesc = b?.otherIncomeCats ? Array.from(b.otherIncomeCats).filter(Boolean).join('、') || '-' : '-'
        const totalIncome = rentIncome + otherIncome
        const ownerNights = related.reduce((s, x) => s + (isOwnerStay(x) ? Number(x.nights || 0) : 0), 0)
        const guestNights = related.reduce((s, x) => s + (!isOwnerStay(x) ? Number(x.nights || 0) : 0), 0)
        const daysInMonth = rm.end.diff(rm.start,'day')
        const availableDays = Math.max(0, daysInMonth - ownerNights)
        const occRate = availableDays ? Math.round(((guestNights / availableDays)*100 + Number.EPSILON)*100)/100 : 0
        const avg = guestNights ? Math.round(((rentIncome / guestNights) + Number.EPSILON)*100)/100 : 0
        const landlord = findLandlordForProperty(landlords, String(p.id), String((p as any).landlord_id || ''))
        const rate = Number(resolveManagementFeeRuleForMonth(landlord, mk).rate || 0)
        const sums = (b?.expSums || {}) as any
        const mgmtRecorded = Number(sums.management_fee || 0)
        const mgmt = mgmtRecorded ? mgmtRecorded : (rate ? Math.round(((rentIncome * rate) + Number.EPSILON)*100)/100 : 0)
        const carpark = Number(sums.parking_fee || 0)
        const electricity = Number(sums.electricity || 0)
        const water = Number(sums.water || 0)
        const gas = Number(sums.gas || 0)
        const internet = Number(sums.internet || 0)
        const consumable = Number(sums.consumables || 0)
        const ownercorp = Number(sums.body_corp || 0)
        const council = Number(sums.council || 0)
        const other = Number(sums.other || 0)
        const otherExpenseDescFmt = b?.otherFmt || { text: '-', full: '-' }
        const totalExp = mgmt + electricity + water + gas + internet + consumable + carpark + ownercorp + council + other
        const net = Math.round(((totalIncome - totalExp) + Number.EPSILON)*100)/100
        const monthKey = rm.start.format('YYYY-MM')
        const payableToOwner = Math.max(0, Number(net || 0))
        out.push({ key: `${p.id}-${rm.label}`, pid: p.id, month: rm.label, monthKey, code: p.code || p.id, address: p.address, occRate, avg, totalIncome, rentIncome, otherIncome, otherIncomeDesc, mgmt, electricity, water, gas, internet, consumable, carpark, ownercorp, council, other, otherExpenseDesc: otherExpenseDescFmt.text, otherExpenseDescFull: otherExpenseDescFmt.full, totalExp, net, payableToOwner })
      }
    }
    return out
  }, [properties, filteredProperties, orders, txBucketIndex, landlords, start, end, selectedPid, selectedRegion])

  const fmt = (n: number) => (n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const formatMoney = (n?: number) => `$${fmt(Number(n || 0))}`

  const normalizeStatus = (raw?: Partial<RevenueStatus> | null): RevenueStatus => ({
    scheduled_email_set: !!raw?.scheduled_email_set,
    transferred: !!raw?.transferred,
  })

  const upsertRevenueStatus = async (pid: string, monthKey: string, patch: Partial<RevenueStatus>) => {
    return patchJSON<any>('/finance/property-revenue-status', {
      property_id: pid,
      month_key: monthKey,
      scheduled_email_set: patch.scheduled_email_set,
      transferred: patch.transferred,
    })
  }

  const setPending = (statusKey: string, op: 'scheduled' | 'transfer', on: boolean) => {
    setPendingOps((m) => {
      const prev = m[statusKey] || {}
      const next = { ...prev, [op]: on ? true : undefined }
      const keep = Object.entries(next).some(([, v]) => !!v)
      if (!keep) {
        const { [statusKey]: _drop, ...rest } = m
        return rest
      }
      return { ...m, [statusKey]: next }
    })
  }

  const ensureBaseline = (statusKey: string, field: keyof RevenueStatus, current: RevenueStatus) => {
    const existing = (baselineStatusByKey[statusKey] || {}) as any
    if (existing[field] !== undefined) return existing[field] as boolean
    const baseline = current[field]
    setBaselineStatusByKey((m) => ({ ...m, [statusKey]: { ...(m[statusKey] || {}), [field]: baseline } }))
    return baseline
  }

  const toggleStatus = async (r: any, field: keyof RevenueStatus, op: 'scheduled' | 'transfer') => {
    const pid = String(r?.pid || '')
    const monthKey = String(r?.monthKey || '')
    if (!pid || !monthKey) return
    const sk = statusKeyOf(pid, monthKey)
    if (op === 'scheduled' && pendingOps[sk]?.scheduled) return
    if (op === 'transfer' && pendingOps[sk]?.transfer) return
    const current = normalizeStatus(revenueStatusByKey[sk])
    const baseline = ensureBaseline(sk, field, current)
    const nextVal = nextToggleValue(baseline, current[field])
    const next = { ...current, [field]: nextVal }
    setPending(sk, op, true)
    setRevenueStatusByKey((m) => ({ ...m, [sk]: next }))
    try {
      await upsertRevenueStatus(pid, monthKey, { [field]: nextVal } as any)
      message.success(field === 'scheduled_email_set' ? (nextVal ? '已确认发送邮件' : '已恢复邮件原始状态') : (nextVal ? '已标记转账' : '已恢复转账原始状态'))
    } catch (e: any) {
      setRevenueStatusByKey((m) => ({ ...m, [sk]: current }))
      message.error(`操作失败：${String(e?.message || '未知错误')}`)
    } finally {
      setPending(sk, op, false)
    }
  }

  const RevenueStatusBar = (props: {
    status: RevenueStatus
    isPendingScheduled: boolean
    isPendingTransfer: boolean
    onToggleScheduled: () => void
    onToggleTransfer: () => void
    onPreview: () => void
  }) => {
    const { status, isPendingScheduled, isPendingTransfer, onToggleScheduled, onToggleTransfer, onPreview } = props
    return (
      <div className={styles.opBar}>
        <div className={styles.statusGroup}>
          <Button
            size="small"
            icon={status.scheduled_email_set ? <CheckOutlined /> : <MailOutlined />}
            loading={isPendingScheduled}
            className={`${styles.toggleBtn} ${status.scheduled_email_set ? styles.toggleBtnOn : styles.toggleBtnOff}`}
            onClick={onToggleScheduled}
          >
            {status.scheduled_email_set ? '已设置邮件' : '设置邮件'}
          </Button>
          <Button
            size="small"
            icon={status.transferred ? <CheckOutlined /> : <CreditCardOutlined />}
            loading={isPendingTransfer}
            className={`${styles.toggleBtn} ${status.transferred ? styles.toggleBtnOn : styles.toggleBtnOff}`}
            onClick={onToggleTransfer}
          >
            {status.transferred ? '已转账' : '标记转账'}
          </Button>
        </div>
        <div className={styles.actionGroup}>
          <Button size="small" className={`${styles.toggleBtn} ${styles.toggleBtnNeutral}`} onClick={onPreview}>预览/导出</Button>
        </div>
      </div>
    )
  }
  const columns = [
    { title:'月份', dataIndex:'month', width: 96, fixed: 'left' as const },
    { title:'房号', dataIndex:'code', width: 96, fixed: 'left' as const },
    { title:'地址', dataIndex:'address' },
    { title:'入住率', dataIndex:'occRate', align:'right', render:(v: number)=> `${fmt(v)}%` },
    { title:'日均租金', dataIndex:'avg', align:'right', render:(v: number)=> `$${fmt(v)}` },
    { title:'总收入', dataIndex:'totalIncome', align:'right', render:(v: number)=> `$${fmt(v)}` },
    { title:'租金收入', dataIndex:'rentIncome', align:'right', render:(v: number)=> `$${fmt(v)}` },
    { title:'其他收入', dataIndex:'otherIncome', align:'right', render:(v: number)=> `$${fmt(v)}` },
    { title:'其他收入描述', dataIndex:'otherIncomeDesc' },
    { title:'管理费', dataIndex:'mgmt', align:'right', render:(v: number)=> `-$${fmt(v)}` },
    { title:'电费', dataIndex:'electricity', align:'right', render:(v: number)=> `-$${fmt(v)}` },
    { title:'水费', dataIndex:'water', align:'right', render:(v: number)=> `-$${fmt(v)}` },
    { title:'气费', dataIndex:'gas', align:'right', render:(v: number)=> `-$${fmt(v)}` },
    { title:'网费', dataIndex:'internet', align:'right', render:(v: number)=> `-$${fmt(v)}` },
    { title:'消耗品费', dataIndex:'consumable', align:'right', render:(v: number)=> `-$${fmt(v)}` },
    { title:'车位费', dataIndex:'carpark', align:'right', render:(v: number)=> `-$${fmt(v)}` },
    { title:'物业费', dataIndex:'ownercorp', align:'right', render:(v: number)=> `-$${fmt(v)}` },
    { title:'市政费', dataIndex:'council', align:'right', render:(v: number)=> `-$${fmt(v)}` },
    { title:'其他支出', dataIndex:'other', align:'right', render:(v: number)=> `-$${fmt(v)}` },
    { title:'其他支出描述', dataIndex:'otherExpenseDesc', render: (_: any, r: any) => <div style={{ whiteSpace:'normal', wordBreak:'break-word', overflowWrap:'anywhere', textAlign:'right' }} title={r.otherExpenseDescFull || r.otherExpenseDesc}>{r.otherExpenseDesc}</div> },
    { title:'总支出', dataIndex:'totalExp', align:'right', render:(v: number)=> `-$${fmt(v)}` },
    { title:'净收入', dataIndex:'net', align:'right', render:(v: number)=> `$${fmt(v)}` },
    { title:'本月应支付房东费用', dataIndex:'payableToOwner', align:'right', render:(v: number)=> `$${fmt(Math.max(0, Number(v || 0)))}` },
    { title:'操作', render: (_: any, r: any) => {
      const pid = String(r?.pid || '')
      const monthKey = String(r?.monthKey || '')
      const sk = statusKeyOf(pid, monthKey)
      const st = normalizeStatus(revenueStatusByKey[sk])
      const isPendingScheduled = !!pendingOps[sk]?.scheduled
      const isPendingTransfer = !!pendingOps[sk]?.transfer
      return (
        <RevenueStatusBar
          status={st}
          isPendingScheduled={isPendingScheduled}
          isPendingTransfer={isPendingTransfer}
          onToggleScheduled={() => toggleStatus(r, 'scheduled_email_set', 'scheduled')}
          onToggleTransfer={() => toggleStatus(r, 'transferred', 'transfer')}
          onPreview={() => { setPreviewPid(r.pid); setPreviewOpen(true) }}
        />
      )
    } },
  ]

  return (
    <Card title="房源营收" loading={pageLoading}>
      <div style={{ marginBottom: 12, display:'flex', gap:8, alignItems:'center' }}>
        <DatePicker picker="month" value={month} onChange={setMonth as any} disabled={pageLoading || rangeLoading} />
        <Select
          allowClear
          placeholder="选择范围(年/半年/财年)"
          value={period==='month' ? undefined : period}
          onChange={(v) => setPeriod((v as any) || 'month')}
          style={{ width: 220 }}
          disabled={pageLoading || rangeLoading}
          options={[{value:'year',label:'全年(自然年)'},{value:'half-year',label:'半年'},{value:'fiscal-year',label:'财年(7月至次年6月)'}]}
        />
        {period==='half-year' ? <DatePicker picker="month" value={startMonth} onChange={setStartMonth as any} disabled={pageLoading || rangeLoading} /> : null}
        <Select
          allowClear
          placeholder="按区域筛选"
          style={{ width: 180 }}
          options={regionOptions}
          value={selectedRegion}
          onChange={(v) => {
            const next = (v as any) || undefined
            setSelectedRegion(next)
            if (!next) return
            if (!selectedPid) return
            const p = properties.find(pp => String(pp.id) === String(selectedPid))
            const r = String((p as any)?.region || '').trim()
            if (r && r !== String(next)) setSelectedPid(undefined)
          }}
          disabled={pageLoading || rangeLoading}
        />
        <Select allowClear showSearch optionFilterProp="label" filterOption={(input, option)=> String((option as any)?.label||'').toLowerCase().includes(String(input||'').toLowerCase())} placeholder="按房号筛选" style={{ width: 240 }} options={sortProperties(filteredProperties).map(p=>({ value:p.id, label:p.code || p.address || p.id }))} value={selectedPid} onChange={setSelectedPid} disabled={pageLoading || rangeLoading} />
        <Button type="primary" onClick={() => { if (!selectedPid) { message.warning('请先选择房号'); return } setPreviewPid(selectedPid); setPreviewOpen(true) }} disabled={pageLoading || rangeLoading}>生成报表</Button>
        <span style={{ marginLeft: 8 }}>排除孤儿快照</span>
        <Switch checked={excludeOrphanFixedSnapshots} onChange={setExcludeOrphanFixedSnapshots as any} disabled={pageLoading || rangeLoading} />
      </div>
      <Modal
        open={orphanOpen}
        onCancel={() => setOrphanOpen(false)}
        onOk={() => setOrphanOpen(false)}
        okText="关闭"
        cancelButtonProps={{ style: { display: 'none' } }}
        title="孤儿固定支出快照明细"
        width={980}
      >
        <Table
          rowKey={(r: any) => String(r.id)}
          size="small"
          pagination={{ pageSize: 20 }}
          dataSource={orphanFixedSnapshots || []}
          columns={[
            { title: 'expense_id', dataIndex: 'id', width: 220, render: (v: any) => <span style={{ fontFamily: 'monospace' }}>{String(v || '')}</span> },
            { title: 'month', dataIndex: 'month_key', width: 90 },
            { title: 'occurred_at', dataIndex: 'occurred_at', width: 110 },
            { title: 'amount', dataIndex: 'amount', width: 110, align: 'right', render: (v: any) => `$${(Number(v || 0)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` },
            { title: 'category', dataIndex: 'category', width: 140 },
            { title: 'note', dataIndex: 'note', width: 220, render: (v: any) => <span style={{ whiteSpace: 'normal' }}>{String(v || '')}</span> },
            { title: 'fixed_expense_id', dataIndex: 'fixed_expense_id', width: 220, render: (v: any) => <span style={{ fontFamily: 'monospace' }}>{String(v || '')}</span> },
            { title: 'generated_from', dataIndex: 'generated_from', width: 160 },
            { title: 'property_id', dataIndex: 'property_id', width: 220, render: (v: any) => <span style={{ fontFamily: 'monospace' }}>{String(v || '')}</span> },
          ]}
        />
      </Modal>
      {/* totals summary removed per request */}
      <div className={styles.tableOuter}>
      <Table
        rowKey={(r)=>r.key}
        columns={columns as any}
        dataSource={rows}
        loading={pageLoading || rangeLoading}
        scroll={{ x: 'max-content' }}
        pagination={{ pageSize: 20 }}
        size="small"
        style={{ fontSize: 12 }}
        expandable={{
          expandRowByClick: true,
          expandIconColumnIndex: 0,
          fixed: 'left' as const,
          rowExpandable: () => true,
          columnWidth: 40,
          onExpand: (expanded: boolean, r: any) => {
            if (!expanded) return
            try { fetchRentSegments(String(r?.pid || ''), String(r?.monthKey || '')) } catch {}
          },
          expandedRowRender: (r: any) => {
            const pid = String(r?.pid || '').trim()
            const monthKey = String(r?.monthKey || '').trim()
            const k = rentKey(pid, monthKey)
            const cached = rentSegByKey[k]
            const segsRaw: any[] = Array.isArray(cached?.segments) ? cached.segments : []
            const segs = [...segsRaw].sort((a: any, b: any) => {
              const aci = a?.checkin ? dayjs(toDayStr(a.checkin)).valueOf() : 0
              const bci = b?.checkin ? dayjs(toDayStr(b.checkin)).valueOf() : 0
              if (aci !== bci) return aci - bci
              const aco = a?.checkout ? dayjs(toDayStr(a.checkout)).valueOf() : 0
              const bco = b?.checkout ? dayjs(toDayStr(b.checkout)).valueOf() : 0
              if (aco !== bco) return aco - bco
              const aid = String(a?.__rid || a?.id || '')
              const bid = String(b?.__rid || b?.id || '')
              return aid.localeCompare(bid)
            })
            const fmt2 = (n: number) => (n||0).toLocaleString(undefined,{ minimumFractionDigits:2, maximumFractionDigits:2 })
            const rentIncome = Number(cached?.rent_income || 0) || 0
            const childColumns = [
              { title: '入住', dataIndex: 'check_in', width: 130, fixed: 'left' as const, align: 'left' as const, ellipsis: true, render: (v: any)=> dayjs(v).format('DD/MM/YYYY') },
              { title: '退房', dataIndex: 'check_out', width: 130, align: 'left' as const, ellipsis: true, render: (v: any)=> dayjs(v).format('DD/MM/YYYY') },
              { title: '晚数', dataIndex: 'nights', width: 80, align: 'center' as const },
              { title: '净租金', dataIndex: 'net_rent', width: 140, align: 'right' as const, render: (v: any)=> formatMoney(Number(v||0)) },
            ]
            return (
              <div className={styles.childContainer}>
                <div className={styles.leftBar} />
                <div className={styles.childHeader}>分段明细</div>
                {cached?.error ? <div style={{ padding: '8px 0', color: '#cf1322' }}>{cached.error}</div> : null}
                <Table
                  className={styles.childTable}
                  columns={childColumns as any}
                  dataSource={segs.map(s => ({ key: s.__rid || s.id, check_in: s.checkin, check_out: s.checkout, nights: s.nights, net_rent: ((s as any).visible_net_income ?? (s as any).net_income ?? 0) }))}
                  pagination={false}
                  size="small"
                  tableLayout="fixed"
                  scroll={{ x: 480 }}
                  loading={!!cached?.loading}
                  summary={() => (
                    <Table.Summary>
                      <Table.Summary.Row>
                        <Table.Summary.Cell index={0} colSpan={3}>分段合计净租金</Table.Summary.Cell>
                        <Table.Summary.Cell index={3} align="right"><strong>${fmt2(rentIncome)}</strong></Table.Summary.Cell>
                      </Table.Summary.Row>
                    </Table.Summary>
                  )}
                />
              </div>
            )
          }
        }}
      />
      </div>
      <Modal title={period==='month' ? '月度报告' : (period==='year' ? '年度报告' : (period==='fiscal-year' ? '财年报告' : '半年报告'))} open={previewOpen} onCancel={() => { setPreviewOpen(false); setPreviewReady(false); setStatementPdfMode(false); setCarryDiagOpen(false) }} footer={<>
        <Button onClick={async () => {
          if (!printRef.current) return
          const waitMonthlyReady = async () => {
            const el = printRef.current as HTMLElement
            if (!el) return
            if (String(el.getAttribute('data-monthly-statement-root') || '') !== '1') return
            const t0 = Date.now()
            while (Date.now() - t0 < 8000) {
              const loaded = String(el.getAttribute('data-deep-clean-loaded') || '') === '1'
              const maintLoaded = String(el.getAttribute('data-maint-loaded') || '') === '1'
              const pdfOk = String(el.getAttribute('data-pdf-mode') || '') === '1'
              if (loaded && maintLoaded && pdfOk) break
              await new Promise(r => setTimeout(r, 80))
            }
            const cnt = Number(el.getAttribute('data-deep-clean-count') || 0)
            if (Number.isFinite(cnt) && cnt > 0) {
              while (Date.now() - t0 < 8000) {
                if (el.querySelector('[data-deep-clean-section="1"]')) break
                await new Promise(r => setTimeout(r, 80))
              }
            }
            const mcnt = Number(el.getAttribute('data-maint-count') || 0)
            if (Number.isFinite(mcnt) && mcnt > 0) {
              while (Date.now() - t0 < 8000) {
                if (el.querySelector('[data-maint-section="1"]')) break
                await new Promise(r => setTimeout(r, 80))
              }
            }
          }
          setStatementPdfMode(true)
          await new Promise(r => setTimeout(r, 0))
          await waitMonthlyReady()
          const style = `
            <style>
              html, body { font-family: 'Times New Roman', Times, serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
              @page { margin: 12mm; size: A4 ${period==='fiscal-year' ? 'landscape' : 'portrait'}; }
              body { width: ${period==='fiscal-year' ? '277mm' : '190mm'}; margin: 0 auto; box-sizing: border-box; padding: 0 2mm; }
              table { width: 100%; border-collapse: collapse; }
              th, td { border-bottom: 1px solid #ddd; }
              .landlord-calendar .mz-booking { border-radius: 0; }
              .landlord-calendar .fc-event-start .mz-booking { border-top-left-radius: 8px; border-bottom-left-radius: 8px; }
              .landlord-calendar .fc-event-end .mz-booking { border-top-right-radius: 8px; border-bottom-right-radius: 8px; }
              .landlord-calendar .mz-evt--airbnb .mz-booking { background-color: #FFE4E6 !important; border-color: #FB7185 !important; color: #881337 !important; }
              .landlord-calendar .mz-evt--booking .mz-booking { background-color: #DBEAFE !important; border-color: #60A5FA !important; color: #1E3A8A !important; }
              .landlord-calendar .mz-evt--other .mz-booking { background-color: #F3F4F6 !important; border-color: #9CA3AF !important; color: #111827 !important; }
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
          const prop = properties.find(p => String(p.id) === String(previewPid || ''))
          const codeLabel = (prop?.code || prop?.address || String(previewPid || '')).toString().trim()
          const fileTitle = `Monthly Statement - ${month.format('YYYY-MM')}${codeLabel ? ' - ' + codeLabel : ''}`
          const html = `<html><head><title>${fileTitle}</title>${style}<base href="${location.origin}"></head><body>${printRef.current.innerHTML}</body></html>`
          doc.open(); doc.write(html); doc.close()
          const imgs = Array.from(doc.images || [])
          await Promise.all(imgs.map((img: any) => img.complete ? Promise.resolve(null) : new Promise((resolve) => { img.addEventListener('load', resolve); img.addEventListener('error', resolve) })))
          await new Promise(r => setTimeout(r, 50))
          try { (iframe.contentWindow as any).focus(); (iframe.contentWindow as any).print() } catch {}
          setTimeout(() => { try { document.body.removeChild(iframe) } catch {} }, 500)
          setTimeout(() => setStatementPdfMode(false), 800)
        }}>导出PDF</Button>
        <Button onClick={async () => {
          if (!printRef.current) return
          if (exportPreview.loading) return
          setExportPreview((prev) => ({ ...prev, loading: true }))
          try {
            const orientation = period === 'fiscal-year' ? 'l' : 'p'
            const rootWidthMm = period === 'fiscal-year' ? 277 : 190
            const prop = properties.find(p => String(p.id) === String(previewPid || ''))
            const codeLabel = (prop?.code || prop?.address || String(previewPid || '')).toString().trim()
            const prefix = period === 'month'
              ? `Monthly Statement - ${month.format('YYYY-MM')}`
              : period === 'year'
                ? `Annual Statement - ${month.format('YYYY')}`
                : period === 'fiscal-year'
                  ? `Fiscal Year Statement - ${month.format('YYYY-MM')}`
                  : `Statement - ${month.format('YYYY-MM')}`
            const filename = `${prefix}${codeLabel ? ' - ' + codeLabel : ''}.pdf`

            if (period === 'month' && previewPid) {
              const cfg = monthPdfCfg || resolveMonthPdfCfg(mergeSplit)
              const resp = await fetch(`${API_BASE}/finance/monthly-statement-pdf`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders() },
                body: JSON.stringify({ month: month.format('YYYY-MM'), property_id: previewPid, showChinese, includePhotosMode: cfg.photosMode, sections: cfg.sectionsApi, ...(cfg.photoCfg || {}), excludeOrphanFixedSnapshots, carryStartMonth: DEFAULT_MONTHLY_STATEMENT_CARRY_START_MONTH }),
              })
              if (!resp.ok) {
                let msg = `HTTP ${resp.status}`
                try { const j = await resp.json() as any; msg = String(j?.message || msg) } catch {}
                throw new Error(msg)
              }
              const blob = await resp.blob()
              const url = URL.createObjectURL(blob)
              setExportPreview((prev) => {
                try { if (prev.url) URL.revokeObjectURL(prev.url) } catch {}
                return { ...prev, open: true, url, pageCount: 0, filename, loading: false }
              })
              return
            }

            const waitMonthlyReady = async () => {
              const el = printRef.current as HTMLElement
              if (!el) return
              if (String(el.getAttribute('data-monthly-statement-root') || '') !== '1') return
              const t0 = Date.now()
              while (Date.now() - t0 < 8000) {
                const loaded = String(el.getAttribute('data-deep-clean-loaded') || '') === '1'
              const maintLoaded = String(el.getAttribute('data-maint-loaded') || '') === '1'
                const pdfOk = String(el.getAttribute('data-pdf-mode') || '') === '1'
              if (loaded && maintLoaded && pdfOk) break
                await new Promise(r => setTimeout(r, 80))
              }
              const cnt = Number(el.getAttribute('data-deep-clean-count') || 0)
              if (Number.isFinite(cnt) && cnt > 0) {
                while (Date.now() - t0 < 8000) {
                  if (el.querySelector('[data-deep-clean-section="1"]')) break
                  await new Promise(r => setTimeout(r, 80))
                }
              }
            const mcnt = Number(el.getAttribute('data-maint-count') || 0)
            if (Number.isFinite(mcnt) && mcnt > 0) {
              while (Date.now() - t0 < 8000) {
                  if (el.querySelector('[data-maint-section="1"]')) break
                await new Promise(r => setTimeout(r, 80))
              }
            }
            }
            setStatementPdfMode(true)
            await new Promise(r => setTimeout(r, 0))
            await waitMonthlyReady()
            const imgCount = Number((printRef.current as any)?.getAttribute?.('data-deep-clean-count') || 0) || 0
            const chosenQuality: 'standard' | 'high' | 'ultra' = (exportQuality === 'ultra' && imgCount > 12) ? 'high' : exportQuality
            if (exportQuality === 'ultra' && chosenQuality !== 'ultra') {
              message.warning('图片较多，已自动使用“高清（平衡）”以避免导出文件过大')
            }
            const exp = pickExportParams(chosenQuality)
            const { blob, pageCount } = await exportElementToPdfBlob({
              element: printRef.current as HTMLElement,
              orientation,
              rootWidthMm,
              marginMm: 12,
              scale: exp.scale,
              imageQuality: exp.imageQuality,
              imageType: exp.imageType,
              minSlicePx: 80,
              reservePx: 60,
              tailGapPx: 16,
              cssText: `
                html, body { font-family: 'Times New Roman', Times, serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; background:#ffffff; }
                body { margin: 0; }
                .__pdf_capture_root__ { padding: 0 4mm; }
                table { width: 100%; border-collapse: collapse; }
                th, td { border-bottom: 1px solid #ddd; }
                .landlord-calendar .mz-booking { border-radius: 0; }
                .landlord-calendar .fc-event-start .mz-booking { border-top-left-radius: 8px; border-bottom-left-radius: 8px; }
                .landlord-calendar .fc-event-end .mz-booking { border-top-right-radius: 8px; border-bottom-right-radius: 8px; }
                .landlord-calendar .mz-evt--airbnb .mz-booking { background-color: #FFE4E6 !important; border-color: #FB7185 !important; color: #881337 !important; }
                .landlord-calendar .mz-evt--booking .mz-booking { background-color: #DBEAFE !important; border-color: #60A5FA !important; color: #1E3A8A !important; }
                .landlord-calendar .mz-evt--other .mz-booking { background-color: #F3F4F6 !important; border-color: #9CA3AF !important; color: #111827 !important; }
              `,
            })
            const url = URL.createObjectURL(blob)
            setExportPreview((prev) => {
              try { if (prev.url) URL.revokeObjectURL(prev.url) } catch {}
              return { ...prev, open: true, url, pageCount, filename, loading: false }
            })
          } catch (e: any) {
            message.error(String(e?.message || '生成导出预览失败'))
            setExportPreview((prev) => ({ ...prev, loading: false }))
          } finally {
            setStatementPdfMode(false)
          }
        }} loading={exportPreview.loading}>导出预览</Button>
        <Button type="primary" ref={mergeStartBtnRef} onClick={async () => {
          if (!printRef.current || !previewPid) return
          if (isMerging) return
          const waitMonthlyReady = async () => {
            const el = printRef.current as HTMLElement
            if (!el) return
            if (String(el.getAttribute('data-monthly-statement-root') || '') !== '1') return
            const t0 = Date.now()
            while (Date.now() - t0 < 8000) {
              const loaded = String(el.getAttribute('data-deep-clean-loaded') || '') === '1'
              const maintLoaded = String(el.getAttribute('data-maint-loaded') || '') === '1'
              const pdfOk = String(el.getAttribute('data-pdf-mode') || '') === '1'
              if (loaded && maintLoaded && pdfOk) break
              await new Promise(r => setTimeout(r, 80))
            }
            const cnt = Number(el.getAttribute('data-deep-clean-count') || 0)
            if (Number.isFinite(cnt) && cnt > 0) {
              while (Date.now() - t0 < 8000) {
                if (el.querySelector('[data-deep-clean-section="1"]')) break
                await new Promise(r => setTimeout(r, 80))
              }
            }
            const mcnt = Number(el.getAttribute('data-maint-count') || 0)
            if (Number.isFinite(mcnt) && mcnt > 0) {
              while (Date.now() - t0 < 8000) {
                if (el.querySelector('[data-maint-section="1"]')) break
                await new Promise(r => setTimeout(r, 80))
              }
            }
          }
          const updateMerge = (percent: number, stage: string, detail?: string) => {
            setMergeUi((prev) => ({ ...prev, open: true, percent: Math.max(0, Math.min(100, Math.round(percent))), status: 'active', stage, detail }))
          }
          const mergeFail = (reason: string, fallback: boolean) => {
            const text = String(reason || '合并下载失败')
            setMergeUi((prev) => ({ ...prev, open: true, percent: 100, status: 'exception', stage: fallback ? '合并失败，已回退下载原报表' : '合并失败', detail: text }))
            message.error(text)
          }
          const mergeSuccess = (detail?: string, keepOpen?: boolean) => {
            setMergeUi((prev) => ({ ...prev, open: true, percent: 100, status: 'success', stage: '合并完成，开始下载', detail: detail || prev.detail }))
            if (!keepOpen) setTimeout(() => setMergeUi((prev) => ({ ...prev, open: false })), 1200)
          }
          updateMerge(5, '正在准备合并任务...')
          try {
            const orientation = period === 'fiscal-year' ? 'l' : 'p'
            const rootWidthMm = period === 'fiscal-year' ? 277 : 190
            const imgCount = Number((printRef.current as any)?.getAttribute?.('data-deep-clean-count') || 0) || 0
            const chosenQuality: 'standard' | 'high' | 'ultra' = (exportQuality === 'ultra' && imgCount > 12) ? 'high' : exportQuality
            if (exportQuality === 'ultra' && chosenQuality !== 'ultra') {
              message.warning('图片较多，已自动使用“高清（平衡）”以避免导出文件过大')
            }
            const exp = pickExportParams(chosenQuality)
            const prop = properties.find(p => String(p.id) === String(previewPid || ''))
            const codeLabel = (prop?.code || prop?.address || String(previewPid || '')).toString().trim()
            const prefix = period === 'month'
              ? `Monthly Statement - ${month.format('YYYY-MM')}`
              : period === 'year'
                ? `Annual Statement - ${month.format('YYYY')}`
                : period === 'fiscal-year'
                  ? `Fiscal Year Statement - ${month.format('YYYY-MM')}`
                  : `Statement - ${month.format('YYYY-MM')}`
            const filename = `${prefix}${codeLabel ? ' - ' + codeLabel : ''}.pdf`
            const downloadBlob = (blob: Blob, forcedName?: string) => {
              try {
                const url = URL.createObjectURL(blob)
                const a = document.createElement('a')
                a.href = url
                a.download = forcedName || filename
                document.body.appendChild(a)
                a.click()
                document.body.removeChild(a)
                URL.revokeObjectURL(url)
              } catch {}
            }
            const downloadMergeJobFile = async (jobId: string, kind?: string, forcedName?: string) => {
              try {
                const qs = kind ? `?kind=${encodeURIComponent(kind)}` : ''
                const resp = await fetch(`${API_BASE}/finance/merge-monthly-pack/${encodeURIComponent(jobId)}/download${qs}`, { headers: authHeaders() })
                if (!resp.ok) {
                  let msg = `HTTP ${resp.status}`
                  try { const j = await resp.json() as any; msg = String(j?.message || msg) } catch {}
                  throw new Error(msg)
                }
                const blob = await resp.blob()
                downloadBlob(blob, forcedName)
              } catch (e: any) {
                message.error(e?.message || '下载失败')
              }
            }
            let statementBlob: Blob
            let pageCount = 0
            let splitInfo: any = null
            let monthPhotosMode: 'full' | 'compressed' | 'thumbnail' | 'off' = 'full'
            let monthPhotoCfg: null | { photo_w: number; photo_q: number } = null
            const genMonthly = async (photosMode: 'full' | 'compressed' | 'thumbnail' | 'off', sections: string, photoCfg?: { photo_w: number; photo_q: number } | null) => {
              const resp = await fetch(`${API_BASE}/finance/monthly-statement-pdf`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders() },
                body: JSON.stringify({ month: month.format('YYYY-MM'), property_id: previewPid, showChinese, includePhotosMode: photosMode, sections, ...(photoCfg || {}), excludeOrphanFixedSnapshots, carryStartMonth: DEFAULT_MONTHLY_STATEMENT_CARRY_START_MONTH }),
              })
              if (!resp.ok) {
                let msg = `HTTP ${resp.status}`
                try { const j = await resp.json() as any; msg = String(j?.message || msg) } catch {}
                throw new Error(msg)
              }
              return await resp.blob()
            }

            if (period === 'month') {
              setMergeSplit(null)
              setMergeNoPhotos(false)
              updateMerge(8, '正在检查照片体积...')
              try {
                const stats = await fetch(`${API_BASE}/finance/monthly-statement-photo-stats?pid=${encodeURIComponent(previewPid!)}&month=${encodeURIComponent(month.format('YYYY-MM'))}`, { headers: authHeaders() })
                if (stats.ok) {
                  const j = await stats.json() as any
                  splitInfo = j
                  setMergeSplit(j)
                  const total = Number(j?.totalPhotoCount || 0)
                  if (Number.isFinite(total) && total > 0) {
                    const detail = `照片数：${Number(j.totalPhotoCount || 0)}（维修 ${Number(j.maintenancePhotoCount || 0)} / 深清 ${Number(j.deepCleaningPhotoCount || 0)}）`
                    updateMerge(9, '照片统计完成', detail)
                  }
                }
              } catch {}
              updateMerge(10, '正在创建后台合并任务...')
              try {
                const create = await fetch(`${API_BASE}/finance/merge-monthly-pack`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', ...authHeaders() },
                  body: JSON.stringify({
                    month: month.format('YYYY-MM'),
                    property_id: previewPid,
                    showChinese,
                    excludeOrphanFixedSnapshots,
                    carryStartMonth: DEFAULT_MONTHLY_STATEMENT_CARRY_START_MONTH,
                    exportQuality,
                    mergeInvoices: true,
                    forceNew: false,
                  }),
                })
                if (!create.ok) {
                  let msg = `HTTP ${create.status}`
                  try { const j = await create.json() as any; msg = String(j?.message || msg) } catch {}
                  throw new Error(msg)
                }
                const j = await create.json() as any
                const jobId = String(j?.job_id || j?.id || '').trim()
                if (!jobId) throw new Error('创建任务失败（missing job_id）')
                updateMerge(15, j?.reused ? '已复用后台任务，正在生成...' : '任务已创建，正在生成...', `任务ID：${jobId}`)
                const t0 = Date.now()
                const basePollMs = Math.max(1200, Math.min(6000, Number((window as any).__mergePollMs || 2000)))
                let pollCount = 0
                while (Date.now() - t0 < 12 * 60 * 1000) {
                  const pollMs = Math.min(8000, basePollMs + pollCount * 500)
                  await new Promise(r => setTimeout(r, pollMs))
                  pollCount += 1
                  const st = await fetch(`${API_BASE}/finance/merge-monthly-pack/${encodeURIComponent(jobId)}`, { headers: authHeaders() })
                  if (!st.ok) continue
                  const s = await st.json() as any
                  const percent = Number(s?.progress || 0)
                  const jobStage = String(s?.stage || '')
                  const stage = jobStage || '处理中...'
                  const detail = String(s?.detail || '')
                  const attempts = Number(s?.attempts || 0)
                  const nextRetryAtRaw = String(s?.next_retry_at || '')
                  const nextRetryAt = nextRetryAtRaw ? Date.parse(nextRetryAtRaw) : NaN
                  updateMerge(Number.isFinite(percent) ? percent : 0, stage, detail)
                  if (jobStage === 'failed') throw new Error(String(s?.last_error_message || s?.detail || '合并失败'))
                  if (jobStage === 'queued' && attempts > 0 && Number.isFinite(nextRetryAt) && nextRetryAt - Date.now() > 12_000) {
                    const when = new Date(nextRetryAt).toLocaleString()
                    throw new Error(`任务已进入重试队列（attempts=${attempts}），下次重试时间：${when}。请点击“重试”创建新任务立即执行。`)
                  }
                  if (jobStage === 'done') {
                    const files = Array.isArray(s?.result_files) ? s.result_files : []
                    const pick = (k: string) => files.find((x: any) => String(x?.kind || '') === k)
                    const merged = pick('statement_merged_invoices')
                    const base = pick('statement_base')
                    const best = merged || base
                    if (!best?.url) throw new Error('合并完成但未返回下载链接')
                    setMergeNoPhotos(true)
                    await downloadMergeJobFile(jobId, String(best?.kind || ''), filename)
                    const extraParts = files.filter((x: any) => String(x?.kind || '') === 'invoices_part')
                    const mergedInv = files.find((x: any) => String(x?.kind || '') === 'statement_merged_invoices')
                    const invCount = Number(mergedInv?.source_count || 0) + extraParts.reduce((n: number, x: any) => n + Number(x?.source_count || 0), 0)
                    const hasPhotos = Number((splitInfo as any)?.totalPhotoCount || 0) > 0
                    mergeSuccess(`附件数：${invCount || 0}${extraParts.length ? `；发票分卷：${extraParts.length}` : ''}${hasPhotos ? '（报表不含照片，可下载照片分卷）' : ''}`, true)
                    return
                  }
                }
                throw new Error('合并超时，请稍后在页面重试')
              } catch (e: any) {
                mergeFail(e?.message || '合并下载失败', false)
                return
              }
            } else {
              updateMerge(26, '正在渲染页面...')
              setStatementPdfMode(true)
              await new Promise(r => setTimeout(r, 0))
              await waitMonthlyReady()
              const r = await exportElementToPdfBlob({
                element: printRef.current as HTMLElement,
                orientation,
                rootWidthMm,
                marginMm: 12,
                scale: exp.scale,
                imageQuality: exp.imageQuality,
                imageType: exp.imageType,
                minSlicePx: 80,
                reservePx: 60,
                tailGapPx: 16,
                cssText: `
                  html, body { font-family: 'Times New Roman', Times, serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; background:#ffffff; }
                  body { margin: 0; }
                  .__pdf_capture_root__ { padding: 0 4mm; }
                  table { width: 100%; border-collapse: collapse; }
                  th, td { border-bottom: 1px solid #ddd; }
                  .landlord-calendar .mz-booking { border-radius: 0; }
                  .landlord-calendar .fc-event-start .mz-booking { border-top-left-radius: 8px; border-bottom-left-radius: 8px; }
                  .landlord-calendar .fc-event-end .mz-booking { border-top-right-radius: 8px; border-bottom-right-radius: 8px; }
                  .landlord-calendar .mz-evt--airbnb .mz-booking { background-color: #FFE4E6 !important; border-color: #FB7185 !important; color: #881337 !important; }
                  .landlord-calendar .mz-evt--booking .mz-booking { background-color: #DBEAFE !important; border-color: #60A5FA !important; color: #1E3A8A !important; }
                  .landlord-calendar .mz-evt--other .mz-booking { background-color: #F3F4F6 !important; border-color: #9CA3AF !important; color: #111827 !important; }
                `,
              })
              statementBlob = r.blob
              pageCount = r.pageCount
            }
            updateMerge(55, '正在准备合并附件...', `报表页数：${pageCount}`)
            if (statementBlob.size > 18 * 1024 * 1024) {
              mergeFail(`报表PDF过大（${Math.round(statementBlob.size / 1024 / 1024)}MB），已回退仅下载报表。建议使用“标准/高清（平衡）”导出或拆分下载。`, true)
              downloadBlob(statementBlob)
              return
            }
            let invUrls: string[] = []
            try {
              updateMerge(60, '正在收集发票附件...')
              const from = start!.format('YYYY-MM-DD')
              const to = end!.format('YYYY-MM-DD')
              const invList = await getJSON<any[]>(`/finance/expense-invoices/search?property_id=${encodeURIComponent(previewPid!)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
              invUrls = (Array.isArray(invList) ? invList : [])
                .map((r: any) => (r.url && /^https?:\/\//.test(r.url)) ? r.url : (r.url ? `${API_BASE}${r.url}` : ''))
                .filter((u: any) => !!u)
            } catch {}
            if (!invUrls.length) {
              try {
                updateMerge(62, '正在从交易/支出中补齐附件...')
                const codeLabel2 = (prop?.code || '').toString().trim()
                const expCandidates = (txs || []).filter((x: any) => {
                  if (x.kind !== 'expense') return false
                  const pidOk = (x.property_id === previewPid) || (!!codeLabel2 && String((x as any).property_code || '') === codeLabel2)
                  const baseDateRaw: any = (x as any).paid_date || x.occurred_at || (x as any).created_at
                  const inMonth = baseDateRaw ? dayjs(toDayStr(baseDateRaw)).isSame(start, 'month') : false
                  return pidOk && inMonth
                })
                const extra = await Promise.all(expCandidates.map(async (e: any) => {
                  try {
                    const r = await fetch(`${API_BASE}/finance/expense-invoices/${encodeURIComponent(String(e.id))}`, { headers: authHeaders() })
                    const arr: any[] = r.ok ? (await r.json()) : []
                    return arr
                  } catch { return [] }
                }))
                const flat = ([] as any[]).concat(...extra)
                const urls2 = flat.map((r: any) => (r.url && /^https?:\/\//.test(r.url)) ? r.url : (r.url ? `${API_BASE}${r.url}` : '')).filter(Boolean)
                invUrls = urls2.length ? urls2 : invUrls
              } catch {}
            }
            if (!invUrls.length) {
              const txUrls = (txs || [])
                .filter((x: any) => x.kind === 'expense' && (!!x.invoice_url) && ((x.property_id === previewPid) || String((x as any).property_code || '') === String((properties.find(p => p.id===previewPid)?.code || ''))))
                .filter((x: any) => {
                  const baseDateRaw: any = (x as any).paid_date || x.occurred_at || (x as any).created_at
                  return baseDateRaw ? dayjs(toDayStr(baseDateRaw)).isSame(start, 'month') : false
                })
                .map((x: any) => (/^https?:\/\//.test(String(x.invoice_url || '')) ? String(x.invoice_url) : `${API_BASE}${String(x.invoice_url || '')}`))
                .filter(Boolean)
              if (txUrls.length) invUrls = txUrls
            }
            try {
              updateMerge(70, '正在合并PDF...', `附件数：${invUrls.length}`)
              updateMerge(78, '正在上传报表PDF...')
              const fd = new FormData()
              fd.append('statement', statementBlob, filename)
              fd.append('invoice_urls', JSON.stringify(invUrls))
              updateMerge(85, '正在请求后端合并...')
              const resp = await fetch(`${API_BASE}/finance/merge-pdf`, { method:'POST', headers: { ...authHeaders() }, body: fd })
              if (!resp.ok) {
                let reason = resp.status === 413 ? `上传内容过大（HTTP 413）` : `合并失败（HTTP ${resp.status}）`
                try { const j = await resp.json(); if (j?.message) reason = j.message } catch { try { const t = await resp.text(); if (t) reason = t } catch {} }
                mergeFail(reason || '合并下载失败', true)
                downloadBlob(statementBlob)
                return
              }
              updateMerge(95, '正在下载合并后的PDF...')
              const blob = await resp.blob()
              downloadBlob(blob, filename)
              mergeSuccess(`附件数：${invUrls.length}`)
            } catch (e: any) {
              mergeFail(e?.message || '合并下载失败', true)
              downloadBlob(statementBlob)
            }
          } catch (e: any) {
            mergeFail(e?.message || '合并下载失败', false)
          } finally {
            setStatementPdfMode(false)
          }
        }} loading={isMerging} disabled={isMerging}>合并PDF下载</Button>
      </>} width={900}>
        {previewPid ? (
          period==='month' ? (
            <>
              <div style={{ display:'flex', justifyContent:'flex-end', alignItems:'center', gap: 12, marginBottom: 8 }}>
                <span>导出质量</span>
                <Select
                  value={exportQuality}
                  onChange={setExportQuality as any}
                  style={{ width: 180 }}
                  options={[
                    { value: 'standard', label: '标准（小文件）' },
                    { value: 'high', label: '高清（平衡）' },
                    { value: 'ultra', label: '超清（大文件）' },
                  ]}
                />
                <span>包含中文说明</span>
                <Switch checked={showChinese} onChange={setShowChinese as any} />
                <Button onClick={() => setCarryDiagOpen(true)}>结转来源诊断</Button>
              </div>
              {(monthPdfCfg?.shouldSplit) ? (
                <div style={{ marginBottom: 8, padding: '8px 12px', borderRadius: 8, border: '1px solid #ffd591', background: '#fff7e6', color: 'rgba(0,0,0,0.72)' }}>
                  照片较多（共 {Number(mergeSplit?.totalPhotoCount || 0)} 张；维修 {Number(mergeSplit?.maintenancePhotoCount || 0)} / 深清 {Number(mergeSplit?.deepCleaningPhotoCount || 0)}）。
                  合并PDF下载将{monthPdfCfg.photosMode === 'off' ? '生成无照片版报表，并提供照片分卷下载。' : '压缩照片以控制体积（如仍过大将自动生成无照片版报表）。'}
                </div>
              ) : null}
              <div style={{ position:'relative' }}>
                {!previewReady ? (
                  <div style={{ position:'absolute', inset: 0, display:'flex', alignItems:'center', justifyContent:'center', background:'#fff', zIndex: 2 }}>
                    <Spin />
                  </div>
                ) : null}
                <div style={{ visibility: previewReady ? 'visible' : 'hidden' }}>
                  <MonthlyStatementView
                    ref={printRef}
                    month={month.format('YYYY-MM')}
                    propertyId={previewPid || undefined}
                    orders={orders}
                    orderSegments={(rentSegByKey[rentKey(previewPid, month.format('YYYY-MM'))]?.segments as any) || undefined}
                    txs={txs}
                    properties={properties}
                    landlords={landlords}
                    showChinese={showChinese}
                    showInvoices={false}
                    sections={monthPdfCfg?.sectionsView}
                    includeJobPhotos={monthPdfCfg ? (monthPdfCfg.photosMode !== 'off') : true}
                    photosMode={monthPdfCfg?.photosMode}
                    photoW={monthPdfCfg?.photoCfg?.photo_w}
                    photoQ={monthPdfCfg?.photoCfg?.photo_q}
                    mode="pdf"
                    pdfMode
                    renderEngine="print"
                  />
                </div>
              </div>
            </>
          ) : period==='fiscal-year' ? (
            <FiscalYearStatement ref={printRef} baseMonth={month} propertyId={previewPid!} orders={orders} txs={txs} properties={properties} landlords={landlords} showChinese={showChinese} />
          ) : (
            <div ref={printRef as any}>
              {(() => {
                const pid = previewPid || undefined
                const prop = properties.find(p=>p.id===pid)
                const anchor = (function(){
                  const base = month || dayjs()
                  if (period==='year') return base.startOf('year')
                  return (startMonth || base).startOf('month')
                })()
                const endAnchor = (function(){
                  const base = month || dayjs()
                  if (period==='year') return base.endOf('year')
                  return anchor.add(5,'month').endOf('month')
                })()
                let cur = anchor.startOf('month')
                const rowz: any[] = []
                while (cur.isBefore(endAnchor.add(1,'day'))) {
                  const mStart = cur.startOf('month')
                  const mEnd = cur.endOf('month')
                  const oSeg = monthSegments(orders.filter(o => o.property_id===pid), mStart)
                  const inc = oSeg.reduce((s,x)=> s + Number(((x as any).visible_net_income ?? (x as any).net_income ?? 0)), 0)
                  const clean = oSeg.reduce((s,x)=> s + Number(x.cleaning_fee||0), 0)
                  const exp1 = txs.filter(t => t.kind==='expense' && t.property_id===pid && dayjs(t.occurred_at).isAfter(mStart.subtract(1,'day')) && dayjs(t.occurred_at).isBefore(mEnd.add(1,'day')))
                  const other = exp1.reduce((s,x)=> s + Number(x.amount||0), 0)
                  rowz.push({ month: mStart.format('MM/YYYY'), income: inc, cleaning: clean, other, net: inc - other })
                  cur = cur.add(1,'month')
                }
                return (
                  <div>
                    <div style={{ display:'flex', justifyContent:'space-between', marginBottom:8 }}>
                      <div style={{ fontSize:18, fontWeight:700 }}>{period==='year' ? `${anchor.format('YYYY')} 年` : `${anchor.format('MM/YYYY')} 至 ${endAnchor.format('MM/YYYY')}`}</div>
                      <div style={{ textAlign:'right' }}>{prop?.code || ''} {prop?.address || ''}</div>
                    </div>
                    <table>
                      <thead>
                        <tr><th>月份</th><th>租金收入</th><th>清洁费</th><th>其他支出</th><th>净收入</th></tr>
                      </thead>
                      <tbody>
                        {rowz.map(r => (<tr key={r.month}><td>{r.month}</td><td>{r.income}</td><td>{r.cleaning}</td><td>{r.other}</td><td>{r.net}</td></tr>))}
                      </tbody>
                    </table>
                  </div>
                )
              })()}
            </div>
          )
        ) : null}
      </Modal>
      <Modal title={exportPreview.pageCount ? `导出预览（${exportPreview.pageCount}页）` : '导出预览'} open={exportPreview.open} onCancel={closeExportPreview} footer={<>
        <Button onClick={closeExportPreview}>关闭</Button>
        <Button type="primary" onClick={() => {
          try {
            if (!exportPreview.url) return
            const a = document.createElement('a')
            a.href = exportPreview.url
            a.download = exportPreview.filename || 'statement.pdf'
            document.body.appendChild(a)
            a.click()
            document.body.removeChild(a)
          } catch {}
        }} disabled={!exportPreview.url}>下载</Button>
      </>} width={1000}>
        {exportPreview.url ? (
          <iframe title="statement-export-preview" src={exportPreview.url} style={{ width: '100%', height: '70vh', border: '1px solid rgba(0,0,0,0.08)', borderRadius: 8, background: '#fff' }} />
        ) : null}
      </Modal>
      <Modal
        title="结转来源诊断"
        open={carryDiagOpen}
        onCancel={() => setCarryDiagOpen(false)}
        footer={<Button onClick={() => setCarryDiagOpen(false)}>关闭</Button>}
        width={920}
      >
        {previewCarryDebug ? (
          <div>
            <div style={{ marginBottom: 12, padding: '10px 12px', borderRadius: 8, background: '#fafafa', border: '1px solid rgba(0,0,0,0.08)' }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>{previewCarryDebug.summary.carrySourceLabel}</div>
              <div style={{ color: 'rgba(0,0,0,0.65)' }}>
                {previewCarryDebug.summary.showBalance
                  ? `目标月份 ${previewCarryDebug.target.month} 的应付房东金额为 $${previewCarryDebug.target.payable_to_owner.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}。`
                  : `目标月份 ${previewCarryDebug.target.month} 没有结转或家具抵扣，应付房东金额为 $${previewCarryDebug.target.payable_to_owner.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}。`}
              </div>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left', padding: '8px 6px', borderBottom: '1px solid #ddd' }}>月份</th>
                    <th style={{ textAlign: 'right', padding: '8px 6px', borderBottom: '1px solid #ddd' }}>经营净收入</th>
                    <th style={{ textAlign: 'right', padding: '8px 6px', borderBottom: '1px solid #ddd' }}>期初结转</th>
                    <th style={{ textAlign: 'right', padding: '8px 6px', borderBottom: '1px solid #ddd' }}>期末结转</th>
                    <th style={{ textAlign: 'right', padding: '8px 6px', borderBottom: '1px solid #ddd' }}>家具新增</th>
                    <th style={{ textAlign: 'right', padding: '8px 6px', borderBottom: '1px solid #ddd' }}>房东已付家具</th>
                    <th style={{ textAlign: 'right', padding: '8px 6px', borderBottom: '1px solid #ddd' }}>家具租金抵扣</th>
                    <th style={{ textAlign: 'right', padding: '8px 6px', borderBottom: '1px solid #ddd' }}>抵扣前应付</th>
                    <th style={{ textAlign: 'right', padding: '8px 6px', borderBottom: '1px solid #ddd' }}>本月应付房东</th>
                    <th style={{ textAlign: 'left', padding: '8px 6px', borderBottom: '1px solid #ddd' }}>来源判断</th>
                  </tr>
                </thead>
                <tbody>
                  {previewCarryDebug.months.map((row) => {
                    const isTarget = row.month === previewCarryDebug.target.month
                    const money = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                    const sourceLabel =
                      row.carry_source_kind === 'mixed'
                        ? '负净收入 + 家具待抵扣'
                        : row.carry_source_kind === 'prior_operating_loss'
                          ? '前序负净收入'
                          : row.carry_source_kind === 'furniture_outstanding'
                            ? '家具待抵扣'
                            : '无'
                    return (
                      <tr key={row.month} style={isTarget ? { background: '#f6ffed' } : undefined}>
                        <td style={{ padding: '8px 6px', borderBottom: '1px solid #eee', fontWeight: isTarget ? 700 : 400 }}>{row.month}</td>
                        <td style={{ padding: '8px 6px', borderBottom: '1px solid #eee', textAlign: 'right' }}>${money(row.operating_net_income)}</td>
                        <td style={{ padding: '8px 6px', borderBottom: '1px solid #eee', textAlign: 'right' }}>${money(row.opening_carry_net)}</td>
                        <td style={{ padding: '8px 6px', borderBottom: '1px solid #eee', textAlign: 'right' }}>${money(row.closing_carry_net)}</td>
                        <td style={{ padding: '8px 6px', borderBottom: '1px solid #eee', textAlign: 'right' }}>${money(row.furniture_charge)}</td>
                        <td style={{ padding: '8px 6px', borderBottom: '1px solid #eee', textAlign: 'right' }}>${money(row.furniture_owner_paid)}</td>
                        <td style={{ padding: '8px 6px', borderBottom: '1px solid #eee', textAlign: 'right' }}>${money(row.furniture_offset_from_rent)}</td>
                        <td style={{ padding: '8px 6px', borderBottom: '1px solid #eee', textAlign: 'right' }}>${money(row.payable_before_furniture)}</td>
                        <td style={{ padding: '8px 6px', borderBottom: '1px solid #eee', textAlign: 'right', fontWeight: isTarget ? 700 : 400 }}>${money(row.payable_to_owner)}</td>
                        <td style={{ padding: '8px 6px', borderBottom: '1px solid #eee' }}>{sourceLabel}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div style={{ color: 'rgba(0,0,0,0.65)' }}>当前只有单个房源月报预览支持结转来源诊断。</div>
        )}
      </Modal>
      <Modal title="合并PDF下载" open={mergeUi.open} onCancel={() => setMergeUi((prev) => ({ ...prev, open: false }))} footer={<>
        {(period === 'month' && mergeUi.status === 'exception') ? (
          <Button type="primary" onClick={() => { try { mergeStartBtnRef.current?.click() } catch {} }}>重试</Button>
        ) : null}
        <Button onClick={() => setMergeUi((prev) => ({ ...prev, open: false }))}>{mergeUi.status === 'active' ? '隐藏' : '关闭'}</Button>
      </>} width={520} maskClosable={mergeUi.status !== 'active'} keyboard={mergeUi.status !== 'active'} closable={mergeUi.status !== 'active'}>
        <div style={{ marginBottom: 8, fontWeight: 600 }}>{mergeUi.stage || '处理中...'}</div>
        <Progress percent={mergeUi.percent || 0} status={mergeUi.status === 'active' ? 'active' : (mergeUi.status === 'success' ? 'success' : 'exception')} />
        {mergeUi.detail ? <div style={{ marginTop: 8, color: mergeUi.status === 'exception' ? '#cf1322' : 'rgba(0,0,0,0.65)' }}>{mergeUi.detail}</div> : null}
        {mergeUi.status === 'active' ? <div style={{ marginTop: 8, color: 'rgba(0,0,0,0.45)' }}>请勿关闭页面，合并完成后会自动触发下载。</div> : null}
        {(period === 'month' && mergeNoPhotos && mergeUi.status !== 'active') ? (
          <div style={{ marginTop: 12 }}>
            <div style={{ marginBottom: 8, color: 'rgba(0,0,0,0.65)' }}>
              本次下载的报表不包含照片，可在这里下载照片分卷{mergeSplit && Number(mergeSplit.totalPhotoCount || 0) === 0 ? '（本月无照片）' : ''}：
            </div>
            <div style={{ display:'flex', flexWrap:'wrap', gap: 10 }}>
              <Button
                onClick={() => downloadSplitPart('maintenance')}
                loading={splitDl.maintenance}
                disabled={!!mergeSplit && !canDownloadSplitPart(mergeSplit, 'maintenance')}
              >
                下载维修照片分卷
              </Button>
              <Button
                onClick={() => downloadSplitPart('deep_cleaning')}
                loading={splitDl.deepCleaning}
                disabled={!!mergeSplit && !canDownloadSplitPart(mergeSplit, 'deep_cleaning')}
              >
                下载深清照片分卷
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>
    </Card>
  )
}
