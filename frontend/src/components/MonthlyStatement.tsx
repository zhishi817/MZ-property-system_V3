"use client"
import dayjs from 'dayjs'
import { monthSegments, toDayStr, parseDateOnly, isOwnerStay } from '../lib/orders'
import { normalizeReportCategory, shouldIncludeIncomeTxInPropertyOtherIncome, txInMonth, txMatchesProperty } from '../lib/financeTx'
import { computeMonthlyStatementBalanceDebug, isFurnitureOwnerPayment, isFurnitureRecoverableCharge } from '../lib/statementBalances'
import { formatStatementDesc } from '../lib/statementDesc'
import { Table } from 'antd'
import { forwardRef, useEffect, useRef, useState } from 'react'
import { API_BASE, authHeaders, fetchWithTimeout } from '../lib/api'
import { DEFAULT_MONTHLY_STATEMENT_CARRY_START_MONTH } from '../lib/monthlyStatementPrint'
import { findLandlordForProperty, resolveManagementFeeRuleForMonth, type LandlordWithManagementFeeRules } from '../lib/managementFeeRules'

type Order = { id: string; property_id?: string; checkin?: string; checkout?: string; price?: number; nights?: number; status?: string; count_in_income?: boolean }
type Tx = { id: string; kind: 'income'|'expense'; amount: number; currency: string; property_id?: string; occurred_at: string; category?: string; category_detail?: string; note?: string; invoice_url?: string; ref_type?: string; ref_id?: string }
type Landlord = LandlordWithManagementFeeRules
type ExpenseInvoice = { id: string; expense_id: string; url: string; file_name?: string; mime_type?: string; file_size?: number }
type DeepCleaning = { id: string; work_no?: string; property_id?: string; occurred_at?: string; completed_at?: string; started_at?: string; ended_at?: string; category?: string; status?: string; review_status?: string; photo_urls?: any; repair_photo_urls?: any; pay_method?: string; total_cost?: any }
type Maintenance = { id: string; work_no?: string; property_id?: string; occurred_at?: string; completed_at?: string; started_at?: string; ended_at?: string; category?: string; status?: string; review_status?: string; details?: any; repair_notes?: string; photo_urls?: any; repair_photo_urls?: any }

function safeJsonParse(v: any) {
  if (v === null || v === undefined) return null
  if (typeof v === 'object') return v
  const s = String(v || '').trim()
  if (!s) return null
  try { return JSON.parse(s) } catch { return null }
}

function summaryFromDetails(details: any): string {
  const v = safeJsonParse(details)
  if (!v) return ''
  if (typeof v === 'string') return v
  if (Array.isArray(v)) {
    const parts = v.map((x: any) => String(x?.item || x?.content || x?.desc || '').trim()).filter(Boolean)
    return parts.join('\n')
  }
  const one = String((v as any)?.item || (v as any)?.content || '').trim()
  return one
}

export default forwardRef<HTMLDivElement, {
  month: string
  propertyId?: string
  orders: Order[]
  orderSegments?: Order[]
  txs: Tx[]
  properties: { id: string; code?: string; address?: string }[]
  landlords: Landlord[]
  ordersLoaded?: boolean
  txsLoaded?: boolean
  propertiesLoaded?: boolean
  landlordsLoaded?: boolean
  showChinese?: boolean
  showInvoices?: boolean
  sections?: string[]
  includeJobPhotos?: boolean
  photosMode?: 'full' | 'compressed' | 'thumbnail' | 'off'
  photoW?: number
  photoQ?: number
  mode?: 'preview' | 'pdf'
  pdfMode?: boolean
  renderEngine?: 'canvas' | 'print'
}>(function MonthlyStatementView({ month, propertyId, orders, orderSegments, txs, properties, landlords, ordersLoaded, txsLoaded, propertiesLoaded, landlordsLoaded, showChinese = true, showInvoices = false, sections, includeJobPhotos = true, photosMode = 'full', photoW, photoQ, mode, pdfMode = false, renderEngine = 'canvas' }, ref) {
  const resolvedMode: 'preview' | 'pdf' = mode || ((pdfMode || renderEngine === 'print') ? 'pdf' : 'preview')
  const isPdfMode = resolvedMode === 'pdf'
  const sectionSet = new Set((Array.isArray(sections) ? sections : []).map(s => String(s || '').trim().toLowerCase()).filter(Boolean))
  const showAllSections = sectionSet.size === 0 || sectionSet.has('all')
  const showBaseSections = showAllSections || sectionSet.has('base')
  const showDeepSection = showAllSections || sectionSet.has('deep_cleaning') || sectionSet.has('deepcleaning')
  const showMaintSection = showAllSections || sectionSet.has('maintenance')
  const photosModeNorm: 'full' | 'compressed' | 'thumbnail' | 'off' = (() => {
    const v = String(photosMode || 'full').toLowerCase()
    if (v === 'off') return 'off'
    if (v === 'compressed') return 'compressed'
    if (v === 'thumbnail') return 'thumbnail'
    return 'full'
  })()
  const canIncludeJobPhotos = includeJobPhotos !== false && photosModeNorm !== 'off'
  const hideReportHeader = isPdfMode && !showBaseSections && (showDeepSection || showMaintSection)
  const showDeepSectionFinal = showDeepSection
  const showMaintSectionFinal = showMaintSection
  const needDeepData = showDeepSectionFinal || (isPdfMode && showBaseSections)
  const needMaintData = showMaintSectionFinal || (isPdfMode && showBaseSections)
  const start = dayjs(`${month}-01`)
  const endNext = start.add(1, 'month').startOf('month')
  const calendarWeekCount = Math.max(1, endNext.subtract(1, 'day').endOf('week').diff(start.startOf('week'), 'week') + 1)
  const calendarShouldStartNewPage = isPdfMode && renderEngine === 'print' && calendarWeekCount >= 5
  const fetchTimeoutMs = isPdfMode ? 20000 : 30000
  const relatedOrdersRaw = Array.isArray(orderSegments) && orderSegments.length
    ? orderSegments
    : monthSegments(
      orders.filter(o => {
        if (propertyId && o.property_id !== propertyId) return false
        const st = String((o as any).status || '').toLowerCase()
        const isCanceled = st.includes('cancel')
        const include = (!isCanceled) || !!(o as any).count_in_income
        return include
      }),
      start
    )
  const relatedOrders = relatedOrdersRaw.filter(r => {
    const st = String((r as any).status || '').toLowerCase()
    const isCanceled = st.includes('cancel')
    return (!isCanceled) || !!(r as any).count_in_income
  })
  const relatedOrdersSorted = [...relatedOrders].sort((a: any, b: any) => {
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
  const simpleMode = false
  const property = properties.find(pp => pp.id === (propertyId || ''))
  const expensesInMonthAll = txs.filter(t => {
    if (t.kind !== 'expense') return false
    if (propertyId) {
      if (!txMatchesProperty(t, { id: propertyId, code: property?.code })) return false
    }
    return txInMonth(t as any, start)
  })
  const expensesInMonthForReport = expensesInMonthAll.filter(t => !isFurnitureRecoverableCharge(t as any))
  const [invoiceMap, setInvoiceMap] = useState<Record<string, ExpenseInvoice[]>>({})
  const [deepCleanings, setDeepCleanings] = useState<DeepCleaning[]>([])
  const [deepCleaningsLoaded, setDeepCleaningsLoaded] = useState(false)
  const [maintenances, setMaintenances] = useState<Maintenance[]>([])
  const [maintenancesLoaded, setMaintenancesLoaded] = useState(false)
  const [expandAllDeepClean, setExpandAllDeepClean] = useState(false)
  const [expandedDeepClean, setExpandedDeepClean] = useState<Record<string, boolean>>({})
  const [expandAllMaintenance, setExpandAllMaintenance] = useState(false)
  const [expandedMaintenance, setExpandedMaintenance] = useState<Record<string, boolean>>({})
  const calendarRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    (async () => {
      try {
        if (!showInvoices || !showBaseSections) { setInvoiceMap({}); return }
        if (!propertyId) { setInvoiceMap({}); return }
        const res = await fetch(`${API_BASE}/finance/expense-invoices/search?property_id=${encodeURIComponent(propertyId)}&month=${encodeURIComponent(start.format('YYYY-MM'))}`, { headers: authHeaders() })
        const rows: ExpenseInvoice[] = res.ok ? (await res.json()) : []
        const map: Record<string, ExpenseInvoice[]> = {}
        rows.forEach((r: any) => { const k = String(r.expense_id); (map[k] = map[k] || []).push(r) })
        const missingIds = expensesInMonthAll.map(e => String(e.id)).filter(id => !(id in map))
        if (missingIds.length) {
          const extraLists = await Promise.all(missingIds.map(async (eid) => {
            try {
              const r = await fetch(`${API_BASE}/finance/expense-invoices/${encodeURIComponent(eid)}`, { headers: authHeaders() })
              const arr: ExpenseInvoice[] = r.ok ? (await r.json()) : []
              return { eid, arr }
            } catch { return { eid, arr: [] as ExpenseInvoice[] } }
          }))
          extraLists.forEach(({ eid, arr }) => {
            if (arr && arr.length) { map[eid] = (map[eid] || []).concat(arr) }
          })
        }
        // 进一步回补：若某支出在交易记录中自带 invoice_url，也作为发票处理
        expensesInMonthAll.forEach((e) => {
          const eid = String((e as any).id)
          const tx = (txs || []).find(t => t.kind === 'expense' && String(t.id) === eid && !!(t as any).invoice_url)
          const urlRaw = (tx as any)?.invoice_url || ''
          if (urlRaw) {
            const url = /^https?:\/\//.test(urlRaw) ? urlRaw : `${API_BASE}${urlRaw}`
            const pseudo: ExpenseInvoice = { id: `tx-${eid}`, expense_id: eid, url }
            map[eid] = (map[eid] || []).concat([pseudo])
          }
        })
        setInvoiceMap(map)
      } catch { setInvoiceMap({}) }
    })()
  }, [propertyId, month, expensesInMonthAll.length, showInvoices, showBaseSections])
  useEffect(() => {
    (async () => {
      try {
        setDeepCleaningsLoaded(false)
        if (!propertyId || !needDeepData) { setDeepCleanings([]); setDeepCleaningsLoaded(true); return }
        const codeRaw = String(property?.code || '').trim()
        const code = (() => {
          if (!codeRaw) return ''
          const s = codeRaw.split('(')[0].trim()
          const t = s.split(/\s+/)[0].trim()
          return t || s || codeRaw
        })()
        const buildUrl = (params: Record<string, string>) => {
          const qs = new URLSearchParams({ ...params, limit: '5000' })
          return `${API_BASE}/crud/property_deep_cleaning?${qs.toString()}`
        }
        const fetchList = async (u: string) => {
          try {
            const res = await fetchWithTimeout(u, { headers: authHeaders() }, { timeoutMs: fetchTimeoutMs })
            return res.ok ? await res.json() : []
          } catch {
            return []
          }
        }
        const primary = await fetchList(buildUrl({ property_id: propertyId }))
        const fallbackUrls = (!primary?.length)
          ? [
              ...(code ? [buildUrl({ property_code: code })] : []),
              ...(codeRaw && codeRaw !== code ? [buildUrl({ property_code: codeRaw })] : []),
            ]
          : []
        const fallbackLists = fallbackUrls.length ? await Promise.all(fallbackUrls.map(fetchList)) : []
        const merged = ([] as any[]).concat(primary || [], ...fallbackLists)
        const map = new Map<string, any>()
        for (const r of merged) {
          const id = String(r?.id || '')
          if (id) map.set(id, r)
        }
        const list = Array.from(map.values())
        const inMonth = list.filter((d: any) => isCompletedInMonth(d))
        setDeepCleanings(inMonth as any)
      } catch {
        setDeepCleanings([])
      } finally {
        setDeepCleaningsLoaded(true)
      }
    })()
  }, [propertyId, month, needDeepData, property?.code])
  useEffect(() => {
    ;(async () => {
      try {
        setMaintenancesLoaded(false)
        if (!propertyId || !needMaintData) { setMaintenances([]); setMaintenancesLoaded(true); return }
        const buildUrl = (params: Record<string, string>) => {
          const qs = new URLSearchParams({ ...params, limit: '5000' })
          return `${API_BASE}/crud/property_maintenance?${qs.toString()}`
        }
        const fetchList = async (u: string) => {
          try {
            const res = await fetchWithTimeout(u, { headers: authHeaders() }, { timeoutMs: fetchTimeoutMs })
            return res.ok ? await res.json() : []
          } catch {
            return []
          }
        }
        const primary = await fetchList(buildUrl({ property_id: propertyId }))
        const codeRaw = String(property?.code || '').trim()
        const code = (() => {
          if (!codeRaw) return ''
          const s = codeRaw.split('(')[0].trim()
          const t = s.split(/\s+/)[0].trim()
          return t || s || codeRaw
        })()
        const fallbackUrls = (!primary?.length)
          ? [
              ...(code ? [buildUrl({ property_code: code })] : []),
              ...(codeRaw && codeRaw !== code ? [buildUrl({ property_code: codeRaw })] : []),
            ]
          : []
        const fallbackLists = fallbackUrls.length ? await Promise.all(fallbackUrls.map(fetchList)) : []
        const merged = ([] as any[]).concat(primary || [], ...fallbackLists)
        const map = new Map<string, any>()
        for (const r of merged) {
          const id = String(r?.id || '')
          if (id) map.set(id, r)
        }
        const list = Array.from(map.values())
        const inMonth = list.filter((d: any) => isCompletedInMonth(d))
        setMaintenances(inMonth as any)
      } catch {
        setMaintenances([])
      } finally {
        setMaintenancesLoaded(true)
      }
    })()
  }, [propertyId, month, needMaintData, property?.code])
  const orderIncomeShare = relatedOrders.reduce((s, x) => s + Number(((x as any).visible_net_income ?? (x as any).net_income ?? 0)), 0)
  const rentIncome = orderIncomeShare
  const orderById = new Map((orders || []).map(o => [String(o.id), o]))
  const otherIncomeTx = txs.filter(t => {
    if (t.kind !== 'income') return false
    if (propertyId && t.property_id !== propertyId) return false
    if (!dayjs(toDayStr(t.occurred_at)).isSame(start, 'month')) return false
    if (isFurnitureOwnerPayment(t as any)) return false
    if (String(t.category || '').toLowerCase() === 'late_checkout') return false
    return shouldIncludeIncomeTxInPropertyOtherIncome(t, orderById)
  })
  const otherIncome = otherIncomeTx.reduce((s,x)=> s + Number(x.amount || 0), 0)
  const mapIncomeCatLabel = (c?: string) => {
    const v = String(c || '')
    if (v === 'late_checkout') return showChinese ? '晚退房费' : 'Late checkout fee'
    if (v === 'cancel_fee') return showChinese ? '取消费' : 'Cancellation fee'
    return v || '-'
  }
  const otherIncomeDescFmt = formatStatementDesc({
    items: Array.from(new Set(otherIncomeTx.map(t => mapIncomeCatLabel(t.category)))).filter(Boolean) as any,
    lang: showChinese ? 'zh' : 'en',
  })
  const totalIncome = rentIncome + otherIncome
  const ownerNights = relatedOrders.reduce((s, x) => s + (isOwnerStay(x) ? Number(x.nights || 0) : 0), 0)
  const guestNights = relatedOrders.reduce((s, x) => s + (!isOwnerStay(x) ? Number(x.nights || 0) : 0), 0)
  const daysInMonth = endNext.diff(start, 'day')
  const availableDays = Math.max(0, daysInMonth - ownerNights)
  const occupancyRate = availableDays ? Math.round(((guestNights / availableDays) * 100 + Number.EPSILON) * 100) / 100 : 0
  const dailyAverage = guestNights ? Math.round(((totalIncome / guestNights) + Number.EPSILON) * 100) / 100 : 0
  const landlord = findLandlordForProperty(landlords, propertyId || '', (property as any)?.landlord_id)
  const managementFeeRule = resolveManagementFeeRuleForMonth(landlord, month)
  const managementFeeRecorded = txs
    .filter((t: any) => {
      if (String(t?.kind || '') !== 'expense') return false
      if (!txMatchesProperty(t as any, { id: propertyId, code: property?.code })) return false
      if (!txInMonth(t as any, start)) return false
      return normalizeReportCategory((t as any)?.report_category || (t as any)?.category) === 'management_fee'
    })
    .reduce((s, x) => s + Number((x as any)?.amount || 0), 0)
  const managementFee = managementFeeRecorded > 0
    ? Math.round((managementFeeRecorded + Number.EPSILON) * 100) / 100
    : (managementFeeRule.rate ? Math.round(((rentIncome * managementFeeRule.rate) + Number.EPSILON) * 100) / 100 : 0)
  const managementFeeRuleMissing = managementFeeRecorded <= 0 && !managementFeeRule.rule
  function catKey(e: any): string {
    const raw = normalizeReportCategory(e?.report_category || e?.category)
    if (raw === 'parking_fee') return 'carpark'
    if (raw === 'body_corp') return 'property_fee'
    if (raw === 'consumables') return 'consumable'
    return raw
  }
  const deepCleanOwnerTxs = (deepCleanings || [])
    .filter((d: any) => {
      const raw = String(d?.pay_method || '')
      const pm = raw.trim().toLowerCase()
      if (pm === 'landlord_pay') return true
      if (pm.includes('landlord') || pm.includes('owner')) return true
      if (raw.includes('房东')) return true
      return false
    })
    .map((d: any) => {
      const parseArr = (raw: any) => {
        if (Array.isArray(raw)) return raw
        if (typeof raw === 'string') { try { const j = JSON.parse(raw); return Array.isArray(j) ? j : [] } catch { return [] } }
        return []
      }
      const labor = Number(d?.labor_cost || 0)
      const laborN = Number.isFinite(labor) ? labor : 0
      const arr = parseArr(d?.consumables)
      const sum = arr.reduce((s: number, x: any) => {
        const n = Number(x?.cost || 0)
        return s + (Number.isFinite(n) ? n : 0)
      }, 0)
      const fallbackTotal = Math.round(((laborN + sum) + Number.EPSILON) * 100) / 100
      const amount = Number((d?.total_cost !== undefined && d?.total_cost !== null) ? d.total_cost : fallbackTotal) || 0
      const dateKey = toDayStr(d?.completed_at) || start.format('YYYY-MM-DD')
      return {
        id: `deep-cleaning-${String(d?.id || '')}`,
        kind: 'expense',
        amount,
        currency: 'AUD',
        property_id: propertyId,
        occurred_at: dateKey,
        category: 'other',
        category_detail: 'Deep cleaning maintenance',
        note: '',
        ref_type: 'deep_cleaning',
        ref_id: String(d?.id || ''),
      }
    })
    .filter((t: any) => t.ref_id && t.amount > 0)
  const expensesInMonthForReportAll = expensesInMonthForReport.concat(deepCleanOwnerTxs as any)
  const sumByCat = (cat: string) => expensesInMonthForReportAll.filter(e => catKey(e) === cat).reduce((s, x) => s + Number(x.amount || 0), 0)
  const catElectricity = sumByCat('electricity')
  const catWater = sumByCat('water')
  const catGas = sumByCat('gas')
  const catInternet = sumByCat('internet')
  const catConsumable = sumByCat('consumable')
  const catCarpark = sumByCat('carpark')
  const catOwnerCorp = sumByCat('property_fee')
  const catCouncil = sumByCat('council')
  const catOther = sumByCat('other')
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
  function cleanOtherDesc(raw?: any): string {
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
  const areaToEn = (raw: any): string => {
    const s = String(raw || '').trim()
    if (!s) return '-'
    const k = s.toLowerCase()
    if (k === 'bedroom' || s === '卧室') return 'Bedroom'
    if (k === 'living room' || k === 'livingroom' || s === '客厅') return 'Living room'
    if (k === 'kitchen' || s === '厨房') return 'Kitchen'
    if (k === 'bathroom' || s === '浴室' || s === '卫生间') return 'Bathroom'
    if (k === 'balcony' || s === '阳台') return 'Balcony'
    if (k === 'hallway' || s === '走廊' || s === '入户走廊') return 'Hallway'
    if (k === 'common area' || k === 'common' || s === '公共区域') return 'Common area'
    if (k === 'whole house' || k === 'all' || s === '全屋') return 'Whole house'
    if (k === 'other' || s === '其他') return 'Other'
    return s
  }
  const countUrlList = (v: any): number => {
    const arr = toUrlStrings(v)
    return arr.length
  }
  const toUrlStrings = (raw: any): string[] => {
    if (!raw) return []
    if (Array.isArray(raw)) {
      return raw
        .map((x) => {
          if (!x) return ''
          if (typeof x === 'string') return x
          if (typeof x === 'object') return String((x as any).url || (x as any).src || (x as any).path || '')
          return String(x || '')
        })
        .map((s) => String(s || '').trim())
        .filter(Boolean)
    }
    if (typeof raw === 'string') {
      const s = raw.trim()
      if (!s) return []
      try {
        const j = JSON.parse(s)
        if (Array.isArray(j)) return toUrlStrings(j)
      } catch {}
      if (/^https?:\/\//i.test(s) || s.startsWith('/')) return [s]
      return []
    }
    if (typeof raw === 'object') {
      const u = String((raw as any).url || (raw as any).src || (raw as any).path || '').trim()
      if (u) return [u]
    }
    return []
  }
  const urlArr = (raw: any) => toUrlStrings(raw)
  const recordBusinessDateRaw = (row: any): any => (
    row?.completed_at ||
    row?.occurred_at ||
    row?.ended_at ||
    row?.started_at ||
    row?.submitted_at ||
    row?.created_at
  )
  const recordCompletedDateRaw = (row: any): any => row?.completed_at || null
  const isCompletedInMonth = (row: any): boolean => {
    const completedAt = recordCompletedDateRaw(row)
    if (!completedAt) return false
    return isInMonth(completedAt)
  }
  const isInMonth = (raw: any): boolean => {
    if (!raw) return false
    const s = String(raw || '').trim()
    if (!s) return false
    const day = toDayStr(s)
    if (day) return dayjs(day).isSame(start, 'month')
    const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/)
    if (m) {
      const mm = String(m[2]).padStart(2, '0')
      const dd = String(m[1]).padStart(2, '0')
      return dayjs(`${m[3]}-${mm}-${dd}`).isSame(start, 'month')
    }
    const d = dayjs(s)
    if (d.isValid()) return d.isSame(start, 'month')
    return false
  }
  const dayLabel = (raw: any): string => {
    if (!raw) return ''
    const s = String(raw || '').trim()
    if (!s) return ''
    const day = toDayStr(s)
    if (day) return day
    const d = dayjs(s)
    if (d.isValid()) return d.format('YYYY-MM-DD')
    return ''
  }
  const otherExpenseEntries = expensesInMonthForReportAll
    .filter(e => catKey(e) === 'other')
    .map((e) => {
      const desc = otherDescOfTx(e)
      const amount = Number((e as any)?.amount || 0)
      if (!desc || !(amount > 0)) return null
      return { desc, amount }
    })
    .filter(Boolean) as Array<{ desc: string; amount: number }>
  const otherItems = otherExpenseEntries.map((e) => e.desc)
  const otherExpenseDescFmt = formatStatementDesc({
    items: otherItems,
    lang: 'en',
  })
  const totalExpense = (managementFee + catElectricity + catWater + catGas + catInternet + catConsumable + catCarpark + catOwnerCorp + catCouncil + catOther)
  const balanceDebug = (propertyId ? computeMonthlyStatementBalanceDebug({
    month,
    propertyId,
    propertyCode: property?.code,
    orders,
    txs: (txs as any).concat(deepCleanOwnerTxs as any),
    managementFeeRate: managementFeeRule.rate ?? undefined,
    carryStartMonth: DEFAULT_MONTHLY_STATEMENT_CARRY_START_MONTH,
  }) : null)
  const balance = balanceDebug?.result || null
  const netIncome = balance ? balance.operating_net_income : Math.round(((totalIncome - totalExpense) + Number.EPSILON) * 100) / 100
  const hasCarry = !!balance && ([
    balance.opening_carry_net,
    balance.closing_carry_net,
  ].some(v => Math.abs(Number(v || 0)) > 0.005))
  const hasFurniture = !!balance && ([
    balance.furniture_opening_outstanding,
    balance.furniture_charge,
    balance.furniture_owner_paid,
    balance.furniture_offset_from_rent,
    balance.furniture_closing_outstanding,
  ].some(v => Math.abs(Number(v || 0)) > 0.005))
  const showBalance = !!balance && (hasCarry || hasFurniture)
  const isImg = (u?: string) => {
    if (!u) return false
    const s = String(u || '')
    const base = s.split('?')[0]
    return /\.(png|jpg|jpeg|gif|webp)$/i.test(base)
  }
  const isPdf = (u?: string) => !!u && /\.pdf$/i.test(u)
  const compressCfg = (() => {
    const w = Math.max(600, Math.min(2400, Number.isFinite(Number(photoW)) && Number(photoW) > 0 ? Number(photoW) : 1400))
    const q = Math.max(40, Math.min(85, Number.isFinite(Number(photoQ)) && Number(photoQ) > 0 ? Number(photoQ) : 72))
    return { w, q }
  })()
  const thumbCfg = (() => {
    const w = Math.max(700, Math.min(1600, Number.isFinite(Number(photoW)) && Number(photoW) > 0 ? Math.min(Number(photoW), 1200) : 1000))
    const q = Math.max(45, Math.min(80, Number.isFinite(Number(photoQ)) && Number(photoQ) > 0 ? Math.min(Number(photoQ), 60) : 55))
    return { w, q }
  })()
  const resolveUrl = (u?: string) => {
    if (!u) return ''
    const raw = String(u || '').trim()
    if (/^https?:\/\//.test(raw)) {
      if (raw.includes('.r2.dev/') || raw.includes('r2.cloudflarestorage.com')) {
        const base = `${API_BASE}/public/r2-image?url=${encodeURIComponent(raw)}`
        if (photosModeNorm === 'compressed') return `${base}&fmt=jpeg&w=${compressCfg.w}&q=${compressCfg.q}`
        if (photosModeNorm === 'thumbnail') return `${base}&fmt=jpeg&w=${thumbCfg.w}&q=${thumbCfg.q}`
        return base
      }
      return raw
    }
    return `${API_BASE}${raw}`
  }
  const fmt = (n: number) => (n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  function perDayPrice(o: Order): number {
    const ci = o.checkin ? parseDateOnly(toDayStr(o.checkin)) : null
    const co = o.checkout ? parseDateOnly(toDayStr(o.checkout)) : null
    if (!ci || !co) return 0
    const totalN = Math.max(co.diff(ci, 'day'), 0)
    if (!totalN) return 0
    return Number(o.price || 0) / totalN
  }
  const weekStart = start.startOf('week')
  const weekEnd = endNext.subtract(1,'day').endOf('week')
  const days: any[] = []
  { let d = weekStart.clone(); while (d.isBefore(weekEnd.add(1,'day'))) { days.push(d.clone()); d = d.add(1,'day') } }
  function buildWeekSegments(ws: any, we: any) {
    const segs: Array<{ id: string; startIdx: number; endIdx: number; o: Order }> = []
      relatedOrders.forEach((o) => {
      const ci = o.checkin ? parseDateOnly(toDayStr(o.checkin)) : null
      const co = o.checkout ? parseDateOnly(toDayStr(o.checkout)) : null
      if (!ci || !co) return
      const s = ci.isAfter(ws) ? ci : ws
      const e = co.isBefore(we.add(1,'millisecond')) ? co : we.add(1,'millisecond')
      if (!(e.isAfter(s))) return
      const startIdx = Math.max(0, s.diff(ws.startOf('day'), 'day'))
      const endIdx = Math.max(0, e.subtract(1,'day').diff(ws.startOf('day'), 'day'))
      segs.push({ id: o.id, startIdx, endIdx, o })
    })
    segs.sort((a,b)=> a.startIdx - b.startIdx || a.endIdx - b.endIdx)
    const lanesEnd: number[] = []
    const laneMap: Record<string, number> = {}
    segs.forEach(seg => {
      let placed = false
      for (let i = 0; i < lanesEnd.length; i++) {
        if (seg.startIdx > lanesEnd[i]) { laneMap[seg.id] = i; lanesEnd[i] = seg.endIdx; placed = true; break }
      }
      if (!placed) { laneMap[seg.id] = lanesEnd.length; lanesEnd.push(seg.endIdx) }
    })
    return { segs, laneMap, laneCount: lanesEnd.length }
  }
  const sourceColor: Record<string, string> = { airbnb: '#FF9F97', booking: '#98B6EC', offline: '#DC8C03', other: '#98B6EC' }
  const baseDataReady = (() => {
    if (!(isPdfMode && renderEngine === 'print')) return true
    const o = (typeof ordersLoaded === 'boolean') ? ordersLoaded : true
    const t = (typeof txsLoaded === 'boolean') ? txsLoaded : true
    const p = (typeof propertiesLoaded === 'boolean') ? propertiesLoaded : true
    const l = (typeof landlordsLoaded === 'boolean') ? landlordsLoaded : true
    return o && t && p && l
  })()
  const [deepRendered, setDeepRendered] = useState(false)
  const [maintRendered, setMaintRendered] = useState(false)

  useEffect(() => {
    if (!(isPdfMode && renderEngine === 'print')) { setDeepRendered(true); return }
    if (!showDeepSectionFinal) { setDeepRendered(true); return }
    if (!deepCleaningsLoaded) { setDeepRendered(false); return }
    if (!deepCleanings.length) { setDeepRendered(true); return }
    let cancelled = false
    const t0 = Date.now()
    const tick = () => {
      if (cancelled) return
      const root = document.querySelector('[data-monthly-statement-root="1"]') as HTMLElement | null
      if (root?.querySelector?.('[data-deep-clean-section="1"]')) { setDeepRendered(true); return }
      if (Date.now() - t0 > 4000) { setDeepRendered(true); return }
      requestAnimationFrame(tick)
    }
    tick()
    return () => { cancelled = true }
  }, [isPdfMode, renderEngine, showDeepSectionFinal, deepCleaningsLoaded, deepCleanings.length, propertyId, month])

  useEffect(() => {
    if (!(isPdfMode && renderEngine === 'print')) { setMaintRendered(true); return }
    if (!showMaintSectionFinal) { setMaintRendered(true); return }
    if (!maintenancesLoaded) { setMaintRendered(false); return }
    if (!maintenances.length) { setMaintRendered(true); return }
    let cancelled = false
    const t0 = Date.now()
    const tick = () => {
      if (cancelled) return
      const root = document.querySelector('[data-monthly-statement-root="1"]') as HTMLElement | null
      if (root?.querySelector?.('[data-maint-section="1"]')) { setMaintRendered(true); return }
      if (Date.now() - t0 > 4000) { setMaintRendered(true); return }
      requestAnimationFrame(tick)
    }
    tick()
    return () => { cancelled = true }
  }, [isPdfMode, renderEngine, showMaintSectionFinal, maintenancesLoaded, maintenances.length, propertyId, month])

  const monthlyStatementReady =
    !!propertyId &&
    baseDataReady &&
    (needDeepData ? deepCleaningsLoaded : true) &&
    (needMaintData ? maintenancesLoaded : true) &&
    deepRendered &&
    maintRendered

  return (
    <div
      ref={ref as any}
      data-monthly-statement-root="1"
      data-monthly-statement-ready={monthlyStatementReady ? '1' : '0'}
      data-mode={resolvedMode}
      data-pdf-mode={isPdfMode ? '1' : '0'}
      data-deep-clean-loaded={deepCleaningsLoaded ? '1' : '0'}
      data-deep-clean-count={String((deepCleanings || []).length)}
      data-maint-loaded={maintenancesLoaded ? '1' : '0'}
      data-maint-count={String((maintenances || []).length)}
      data-balance-show={balanceDebug?.summary?.showBalance ? '1' : '0'}
      data-balance-opening-carry={String(Number(balance?.opening_carry_net || 0))}
      data-balance-closing-carry={String(Number(balance?.closing_carry_net || 0))}
      data-balance-payable={String(Number(balance?.payable_to_owner || 0))}
      data-balance-carry-source={String(balanceDebug?.summary?.carrySourceKind || 'none')}
      data-balance-carry-start-month={DEFAULT_MONTHLY_STATEMENT_CARRY_START_MONTH}
      style={{ padding: 24, fontFamily: "StatementFont, serif" }}
    >
      <style>{`
        @font-face {
          font-family: 'StatementFont';
          src: local('Times New Roman'), local('Times');
          font-weight: 400;
          unicode-range: U+0000-00FF, U+0100-024F, U+1E00-1EFF;
        }
        @font-face {
          font-family: 'StatementFont';
          src: local('PingFang SC'), local('PingFangSC-Regular'), local('Noto Sans CJK SC'), local('Noto Sans SC'), local('Microsoft YaHei');
          font-weight: 400;
          unicode-range: U+3000-303F, U+3400-4DBF, U+4E00-9FFF, U+F900-FAFF, U+FF00-FFEF;
        }
        @font-face {
          font-family: 'StatementFont';
          src: local('Times New Roman Bold'), local('TimesNewRomanPS-BoldMT'), local('Times Bold');
          font-weight: 700;
          unicode-range: U+0000-00FF, U+0100-024F, U+1E00-1EFF;
        }
        @font-face {
          font-family: 'StatementFont';
          src: local('PingFang SC Semibold'), local('PingFangSC-Semibold'), local('PingFang SC Medium'), local('PingFangSC-Medium'), local('Noto Sans CJK SC'), local('Noto Sans SC'), local('Microsoft YaHei');
          font-weight: 700;
          unicode-range: U+3000-303F, U+3400-4DBF, U+4E00-9FFF, U+F900-FAFF, U+FF00-FFEF;
        }
        [data-monthly-statement-root="1"] table { width: 100%; border-collapse: collapse; }
        [data-monthly-statement-root="1"] table tr > * { border-bottom: 1px solid #ddd; }
        [data-monthly-statement-root="1"] [data-statement-row="1"] { border-bottom: 1px solid #ddd; }
        @media print {
          @page { size: A4; margin: 12mm; }
          html, body { margin: 0; padding: 0; font-family: StatementFont, serif; -webkit-font-smoothing: antialiased; text-rendering: geometricPrecision; }
          [data-monthly-statement-root="1"] [data-keep-with-next="true"] { break-after: avoid; page-break-after: avoid; }
          [data-monthly-statement-root="1"] [data-print-break-before="true"] { break-before: page; page-break-before: always; }
          [data-monthly-statement-root="1"] tr { break-inside: avoid; page-break-inside: avoid; }
          [data-monthly-statement-root="1"] [data-calendar-week="1"] { break-inside: avoid; page-break-inside: avoid; }
        }
      `}</style>
      {!hideReportHeader ? (
        <>
          <div className="print-header" style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
            <img src="/mz-logo.png" alt="Company Logo" style={{ height: 64 }} />
            <div style={{ flex: 1, marginLeft: 12 }}></div>
            <div style={{ textAlign:'right', minWidth: 420 }}>
              <div style={{ fontSize: 34, fontWeight: 700, letterSpacing: 1, display:'flex', justifyContent:'flex-end', alignItems:'baseline', gap: 10 }}>
                <span>MONTHLY STATEMENT</span>
              </div>
              <div style={{ borderTop: '2px solid #000', marginTop: 6 }}></div>
              <div style={{ display:'flex', flexDirection:'column', alignItems:'flex-end', marginTop: 6 }}>
                <div style={{ fontSize: 22, fontWeight: 700 }}>{dayjs(`${month}-01`).format('MM/YYYY')}</div>
              <div style={{ fontSize: 16, marginTop: 4 }}>{landlord?.name || ''}</div>
              <div style={{ fontSize: 14 }}>
                {String(property?.code || '').trim() ? `${String(property?.code || '').trim()} / ` : ''}
                {property?.address || ''}
              </div>
              </div>
            </div>
          </div>
          <div style={{ borderTop: '2px solid transparent', margin: '8px 0' }}></div>
        </>
      ) : null}
      {showBaseSections ? (
        <>
      <div data-keep-with-next="true" style={{ marginTop: 24, fontWeight: 700, background:'#eef3fb', padding:'6px 8px' }}>{showChinese ? 'Monthly Overview Data 月度概览数据' : 'Monthly Overview Data'}</div>
      <table style={{ width: '100%', borderCollapse:'collapse' }}>
        <tbody>
          <tr><td style={{ padding:6 }}>{showChinese ? 'Total rent income 总租金' : 'Total rent income'}</td><td style={{ textAlign:'right', padding:6 }}>${fmt(rentIncome)}</td></tr>
          <tr><td style={{ padding:6 }}>{showChinese ? 'Occupancy Rate 入住率' : 'Occupancy Rate'}</td><td style={{ textAlign:'right', padding:6 }}>{fmt(occupancyRate)}%</td></tr>
          <tr><td style={{ padding:6 }}>{showChinese ? 'Daily Average 日平均租金' : 'Daily Average'}</td><td style={{ textAlign:'right', padding:6 }}>${fmt(dailyAverage)}</td></tr>
        </tbody>
      </table>

      <div data-keep-with-next="true" style={{ marginTop: 16, fontWeight: 700, background:'#eef3fb', padding:'6px 8px' }}>{showChinese ? 'Rental Details 租赁明细' : 'Rental Details'}</div>
      <div data-statement-row="1" style={{ fontWeight: 700, display:'flex', justifyContent:'space-between', padding:'6px 8px' }}>
        <span>{showChinese ? 'Total Income 总收入' : 'Total Income'}</span><span>${fmt(totalIncome)}</span>
      </div>
      <table style={{ width:'100%' }}>
        <tbody>
          <tr><td style={{ padding:6, textIndent:'4ch' }}>{showChinese ? 'Rent Income 租金收入' : 'Rent Income'}</td><td style={{ textAlign:'right', padding:6 }}>${fmt(rentIncome)}</td></tr>
          {!simpleMode && (<tr><td style={{ padding:6, textIndent:'4ch' }}>{showChinese ? 'Other Income 其他收入' : 'Other Income'}</td><td style={{ textAlign:'right', padding:6 }}>${fmt(otherIncome)}</td></tr>)}
          {!simpleMode && (
            <tr>
              <td style={{ padding:6, textIndent:'4ch', whiteSpace:'nowrap' }}>{showChinese ? 'Other Income Desc 其他收入描述' : 'Other Income Desc'}</td>
              <td
                style={{ padding:6, textAlign:'right', whiteSpace:'normal', wordBreak:'break-word', overflowWrap:'anywhere' }}
                title={otherIncomeDescFmt.full || undefined}
              >
                {otherIncomeDescFmt.text}
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {!simpleMode && (
        <>
          <div data-statement-row="1" style={{ fontWeight: 700, display:'flex', justifyContent:'space-between', padding:'6px 8px', marginTop: 8 }}>
            <span>{showChinese ? 'Total Expense 总支出' : 'Total Expense'}</span><span>${fmt(totalExpense)}</span>
          </div>
          <table style={{ width:'100%' }}>
            <tbody>
              <tr><td style={{ padding:6, textIndent:'4ch' }}>{showChinese ? 'Management Fee 管理费' : 'Management Fee'}</td><td style={{ textAlign:'right', padding:6 }}>-${fmt(managementFee)}</td></tr>
              {managementFeeRuleMissing ? (
                <tr>
                  <td style={{ padding:6, textIndent:'4ch', color:'#b42318' }}>{showChinese ? '管理费提示' : 'Management Fee Note'}</td>
                  <td style={{ textAlign:'right', padding:6, color:'#b42318' }}>
                    {showChinese ? '缺少费率基线规则，未自动重算管理费' : 'Missing fee baseline rule; management fee was not auto-calculated'}
                  </td>
                </tr>
              ) : null}
              <tr><td style={{ padding:6, textIndent:'4ch' }}>{showChinese ? 'Electricity 电费' : 'Electricity'}</td><td style={{ textAlign:'right', padding:6 }}>-${fmt(catElectricity)}</td></tr>
              <tr><td style={{ padding:6, textIndent:'4ch' }}>{showChinese ? 'Water 水费' : 'Water'}</td><td style={{ textAlign:'right', padding:6 }}>-${fmt(catWater)}</td></tr>
              <tr><td style={{ padding:6, textIndent:'4ch' }}>{showChinese ? 'Gas / Hot water 煤气费 / 热水费' : 'Gas / Hot water'}</td><td style={{ textAlign:'right', padding:6 }}>-${fmt(catGas)}</td></tr>
              <tr><td style={{ padding:6, textIndent:'4ch' }}>{showChinese ? 'Internet 网费' : 'Internet'}</td><td style={{ textAlign:'right', padding:6 }}>-${fmt(catInternet)}</td></tr>
              <tr><td style={{ padding:6, textIndent:'4ch' }}>{showChinese ? 'Monthly Consumable 消耗品费' : 'Monthly Consumable'}</td><td style={{ textAlign:'right', padding:6 }}>-${fmt(catConsumable)}</td></tr>
              <tr><td style={{ padding:6, textIndent:'4ch' }}>{showChinese ? 'Carpark 车位费' : 'Carpark'}</td><td style={{ textAlign:'right', padding:6 }}>-${fmt(catCarpark)}</td></tr>
              <tr><td style={{ padding:6, textIndent:'4ch' }}>{showChinese ? `Owner's Corporation 物业费` : `Owner's Corporation`}</td><td style={{ textAlign:'right', padding:6 }}>-${fmt(catOwnerCorp)}</td></tr>
              <tr><td style={{ padding:6, textIndent:'4ch' }}>{showChinese ? 'Council Rate 市政费' : 'Council Rate'}</td><td style={{ textAlign:'right', padding:6 }}>-${fmt(catCouncil)}</td></tr>
              <tr><td style={{ padding:6, textIndent:'4ch' }}>{showChinese ? 'Other Expense Total 其他支出合计' : 'Other Expense Total'}</td><td style={{ textAlign:'right', padding:6 }}>-${fmt(catOther)}</td></tr>
              {otherExpenseEntries.length ? otherExpenseEntries.map((entry, idx) => (
                <tr key={`other-expense-${idx}`}>
                  <td style={{ padding:6, textIndent:'6ch', whiteSpace:'normal', wordBreak:'break-word', overflowWrap:'anywhere', fontSize: 12 }}>
                    {idx === 0
                      ? (showChinese ? 'Other Expense Item 其他支出明细' : 'Other Expense Item')
                      : ''}
                    {idx === 0 ? ': ' : ''}
                    {entry.desc}
                  </td>
                  <td style={{ textAlign:'right', padding:6, whiteSpace:'nowrap', fontSize: 12 }}>-${fmt(entry.amount)}</td>
                </tr>
              )) : (
                <tr>
                  <td style={{ padding:6, textIndent:'4ch', whiteSpace:'nowrap' }}>{showChinese ? 'Other Expense Desc 其他支出描述' : 'Other Expense Desc'}</td>
                  <td
                    style={{ padding:6, textAlign:'right', whiteSpace:'normal', wordBreak:'break-word', overflowWrap:'anywhere' }}
                    title={otherExpenseDescFmt.full || undefined}
                  >
                    {otherExpenseDescFmt.text}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </>
      )}

      <div data-statement-row="1" style={{ fontWeight: 700, display:'flex', justifyContent:'space-between', padding:'6px 8px', marginTop: 8 }}>
        <span>{showChinese ? 'Net Income 净收入' : 'Net Income'}</span><span>${fmt(netIncome)}</span>
      </div>

      {showBalance && balance && (
        <>
          <div data-keep-with-next="true" style={{ fontWeight: 700, marginTop: 16, background:'#eef3fb', padding:'6px 8px' }}>
            {hasFurniture ? (showChinese ? 'Furniture cost & carry-over 家具费用与结转' : 'Furniture cost & carry-over') : (showChinese ? 'Carry-over 结转' : 'Carry-over')}
          </div>
          <table style={{ width:'100%' }}>
            <tbody>
              {hasCarry ? (
                <tr>
                  <td style={{ padding:6, textIndent:'4ch' }}>{showChinese ? 'Carry-over from last month 上月结转金额' : 'Carry-over from last month'}</td>
                  <td style={{ textAlign:'right', padding:6 }}>${fmt(balance.opening_carry_net)}</td>
                </tr>
              ) : null}

              {hasFurniture ? (
                <tr>
                  <td style={{ padding:6, textIndent:'4ch' }}>{showChinese ? 'Furniture balance to offset (start) 家具费用待抵扣（期初）' : 'Furniture balance to offset (start)'}</td>
                  <td style={{ textAlign:'right', padding:6 }}>${fmt(balance.furniture_opening_outstanding)}</td>
                </tr>
              ) : null}
              {hasFurniture ? (
                <tr>
                  <td style={{ padding:6, textIndent:'4ch' }}>{showChinese ? 'New furniture cost this month 本月新增家具费用' : 'New furniture cost this month'}</td>
                  <td style={{ textAlign:'right', padding:6 }}>${fmt(balance.furniture_charge)}</td>
                </tr>
              ) : null}
              {hasFurniture ? (
                <tr>
                  <td style={{ padding:6, textIndent:'4ch' }}>{showChinese ? 'Owner paid furniture cost 房东本月已支付家具费用' : 'Owner paid furniture cost'}</td>
                  <td style={{ textAlign:'right', padding:6 }}>${fmt(balance.furniture_owner_paid)}</td>
                </tr>
              ) : null}
              {hasFurniture ? (
                <tr>
                  <td style={{ padding:6, textIndent:'4ch' }}>{showChinese ? 'Offset from rent this month 本月从租金中抵扣家具费用' : 'Offset from rent this month'}</td>
                  <td style={{ textAlign:'right', padding:6 }}>-${fmt(balance.furniture_offset_from_rent)}</td>
                </tr>
              ) : null}
              {hasFurniture ? (
                <tr>
                  <td style={{ padding:6, textIndent:'4ch' }}>{showChinese ? 'Furniture balance to offset (end) 家具费用待抵扣（期末）' : 'Furniture balance to offset (end)'}</td>
                  <td style={{ textAlign:'right', padding:6 }}>${fmt(balance.furniture_closing_outstanding)}</td>
                </tr>
              ) : null}

              {hasCarry ? (
                <tr>
                  <td style={{ padding:6, textIndent:'4ch' }}>{showChinese ? 'Carry-over to next month 下月结转金额' : 'Carry-over to next month'}</td>
                  <td style={{ textAlign:'right', padding:6 }}>${fmt(balance.closing_carry_net)}</td>
                </tr>
              ) : null}
            </tbody>
          </table>
          <div data-statement-row="1" style={{ fontWeight: 700, display:'flex', justifyContent:'space-between', padding:'6px 8px', marginTop: 8 }}>
            <span>{showChinese ? 'Amount payable to owner 本月应付房东' : 'Amount payable to owner'}</span><span>${fmt(balance.payable_to_owner)}</span>
          </div>
        </>
      )}

      <div data-keep-with-next="true" style={{ marginTop: 16, fontWeight: 700, background:'#eef3fb', padding:'6px 8px' }}>{showChinese ? 'Rent Records 租金记录' : 'Rent Records'}</div>
      <table style={{ width:'100%', borderCollapse:'collapse' }}>
        <thead>
          <tr>
            <th style={{ textAlign:'left', padding:6, borderBottom:'1px solid #ddd', fontWeight: 700 }}>{showChinese ? '入住' : 'Check-in'}</th>
            <th style={{ textAlign:'left', padding:6, borderBottom:'1px solid #ddd', fontWeight: 700 }}>{showChinese ? '退房' : 'Check-out'}</th>
            <th style={{ textAlign:'right', padding:6, borderBottom:'1px solid #ddd', fontWeight: 700 }}>{showChinese ? '晚数' : 'Nights'}</th>
            <th style={{ textAlign:'right', padding:6, borderBottom:'1px solid #ddd', fontWeight: 700 }}>{showChinese ? '金额' : 'Amount'}</th>
          </tr>
        </thead>
        <tbody>
          {relatedOrdersSorted.map(r => (
            <tr key={(r as any).__rid || r.id}>
              <td style={{ padding:6 }}>{r.checkin ? dayjs(toDayStr(r.checkin)).format('DD/MM/YYYY') : ''}</td>
              <td style={{ padding:6 }}>{r.checkout ? dayjs(toDayStr(r.checkout)).format('DD/MM/YYYY') : ''}</td>
              <td style={{ padding:6, textAlign:'right' }}>{r.nights ?? Math.max(dayjs(toDayStr(r.checkout!)).startOf('day').diff(dayjs(toDayStr(r.checkin!)).startOf('day'), 'day'), 0)}</td>
              <td style={{ padding:6, textAlign:'right' }}>${fmt(Number(((r as any).visible_net_income ?? (r as any).net_income ?? 0)))}</td>
            </tr>
          ))}
        </tbody>
      </table>


      <div
        data-keep-with-next="true"
        data-pdf-break-before={calendarShouldStartNewPage ? 'true' : undefined}
        style={{ marginTop: 16, fontWeight: 700, background:'#eef3fb', padding:'6px 8px' }}
      >
        {showChinese ? 'Order Calendar 订单日历' : 'Order Calendar'}
      </div>
      {(() => {
        const weeks: Array<{ ws: any; we: any }> = []
        let cur = weekStart.clone()
        while (cur.isBefore(weekEnd.add(1,'day'))) { const ws = cur.clone(); const we = cur.clone().endOf('week'); weeks.push({ ws, we }); cur = cur.add(1,'week') }
        const calendarPadding = isPdfMode ? 6 : 8
        const weekMargin = isPdfMode ? '4px 0' : '6px 0'
        const weekMinBase = isPdfMode ? 110 : 120
        const laneRowHeight = isPdfMode ? 30 : 36
        const weekBottomPad = isPdfMode ? 14 : 18
        const daysFontSize = isPdfMode ? 10 : 11
        const daysPadding = isPdfMode ? '1px 0' : '2px 0'
        const gridTop = isPdfMode ? 20 : 22
        const eventTopBase = isPdfMode ? 26 : 28
        const eventHeight = isPdfMode ? 24 : 28
        const eventFontSize = isPdfMode ? 11 : 12
        const eventPadX = isPdfMode ? 6 : 8
        return (
          <div
            ref={calendarRef}
            className="landlord-calendar"
            style={{
              background:'#fff',
              border: isPdfMode && renderEngine === 'print' ? 'none' : '1px solid #eef2f7',
              borderRadius: isPdfMode && renderEngine === 'print' ? 0 : 12,
              padding: isPdfMode && renderEngine === 'print' ? 0 : calendarPadding,
            }}
          >
            {weeks.map(({ ws, we }, idx) => {
              const { segs, laneMap, laneCount } = buildWeekSegments(ws, we)
              const daysRow = Array.from({ length: 7 }).map((_, i) => ws.startOf('day').add(i, 'day'))
              const hasMonthDay = daysRow.some(d => d.isSame(start, 'month'))
              if (!hasMonthDay && segs.length === 0) return null
              const weekInnerPad = isPdfMode ? 6 : 8
              const weekMinHeight = Math.max(
                weekMinBase,
                eventTopBase + weekInnerPad + Math.max(0, laneCount - 1) * laneRowHeight + eventHeight + weekBottomPad
              )
              return (
                <div
                  key={idx}
                  data-calendar-week="1"
                  data-pdf-avoid-cut="true"
                  style={{
                    position:'relative',
                    minHeight: weekMinHeight,
                    margin: weekMargin,
                    border:'1px solid #eef2f7',
                    borderRadius: 12,
                    background:'#fff',
                    overflow:'hidden',
                    padding: weekInnerPad,
                  }}
                >
                  <div style={{ display:'grid', gridTemplateColumns:'repeat(7, 1fr)', gap:0, padding: daysPadding, fontSize: daysFontSize }}>
                    {daysRow.map((d, i) => {
                      const inMonth = d.isSame(start, 'month')
                      return (
                        <div key={i} style={{ textAlign:'center', color: inMonth ? '#4b5563' : '#bfbfbf', fontWeight: inMonth ? 700 : 400 }}>
                          {d.format('DD/MM')}
                        </div>
                      )
                    })}
                  </div>
                  {daysRow.map((d, dIdx) => {
                    const inMonth = d.isSame(start, 'month')
                    return (
                      <div key={dIdx} style={{ position:'absolute', left: `${(dIdx * 100) / 7}%`, width: `${100/7}%`, top: gridTop + (isPdfMode ? 6 : 8), bottom:0 }}>
                        {!inMonth ? <div style={{ position:'absolute', inset:0, background:'#f9fafb', opacity:0.7, pointerEvents:'none', zIndex:0 }} /> : null}
                        <div style={{ position:'absolute', right:0, top:0, bottom:0, width:1, borderRight:'1px dashed #eee' }} />
                      </div>
                    )
                  })}
                  {segs.map(seg => {
                    const o = seg.o as any
                    const isStart = seg.startIdx === Math.max(0, parseDateOnly(toDayStr(o.checkin)).diff(ws.startOf('day'),'day'))
                    const isEnd = seg.endIdx === Math.max(0, parseDateOnly(toDayStr(o.checkout)).subtract(1,'day').diff(ws.startOf('day'),'day'))
                    const platform = (() => {
                      const s = String(o.source || '').toLowerCase()
                      if (s.startsWith('airbnb')) return 'airbnb'
                      if (s.startsWith('booking')) return 'booking'
                      if (s === 'offline') return 'offline'
                      return 'other'
                    })()
                    const leftPct = (seg.startIdx * 100) / 7
                    const rightPct = ((6 - seg.endIdx) * 100) / 7
                    const lane = laneMap[seg.id] || 0
                    return (
                      <div
                        key={seg.id}
                        className={`mz-evt mz-evt--${platform} mz-lane-${lane} ${isStart ? 'fc-event-start' : ''} ${isEnd ? 'fc-event-end' : ''}`}
                        style={{ position:'absolute', left: `${leftPct}%`, right: `${rightPct}%`, top: eventTopBase + (isPdfMode ? 6 : 8) + lane * laneRowHeight, height: eventHeight, zIndex: 1 }}
                      >
                        <div
                          className="mz-booking"
                          style={{ borderWidth: 2, borderStyle:'solid', width:'100%', height:'100%', padding:`0 ${eventPadX}px`, boxSizing:'border-box', display:'flex', alignItems:'center', justifyContent:'space-between', fontSize: eventFontSize }}
                        >
                          <span className="bar-left" style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', fontWeight:500 }}>
                            {String(o.guest_name || '')}
                          </span>
                          <span className="bar-right" style={{ fontWeight:700 }}>
                            {(() => {
                              const v = Number((o as any).visible_net_income ?? (o as any).net_income ?? 0)
                              const visibleNet = Math.max(0, Number(v.toFixed(2)))
                              return `$${fmt(visibleNet)}`
                            })()}
                          </span>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )
            })}
          </div>
        )
      })()}
        </>
      ) : null}

      {(showDeepSectionFinal && deepCleanings.length) ? (
        <div data-deep-clean-section="1" data-pdf-break-before={isPdfMode ? 'true' : undefined}>
          {isPdfMode ? (
            <div style={{ display:'flex', flexDirection:'column', gap: 12 }}>
              {deepCleanings
                .slice()
                .sort((a: any, b: any) => String(a?.completed_at || '').localeCompare(String(b?.completed_at || '')))
                .map((d: any, idx: number) => {
                  const date = dayLabel(d?.completed_at)
                  const startTime = d?.started_at ? dayjs(String(d.started_at)).format('HH:mm') : ''
                  const endTime = d?.ended_at ? dayjs(String(d.ended_at)).format('HH:mm') : ''
                  const timeLabel = [date, (startTime || endTime) ? `${startTime || '-'}~${endTime || '-'}` : ''].filter(Boolean).join(' ')
                  const did = String(d?.id || '')
                  const beforeArr = urlArr((d as any)?.photo_urls).map((u: any) => String(u || '')).filter(Boolean)
                  const afterArr = urlArr((d as any)?.repair_photo_urls).map((u: any) => String(u || '')).filter(Boolean)
                  const beforePdfArr = beforeArr
                  const afterPdfArr = afterArr
                  const allowPhotosInPdf = (beforePdfArr.length + afterPdfArr.length) > 0
                  const title = showChinese ? 'Deep Cleaning Maintenance 深度清洁维护' : 'Deep Cleaning Maintenance'
                  const labelJob = showChinese ? '工单编号  JOB NUMBER' : 'JOB NUMBER'
                  const labelCompletion = showChinese ? '完成时间  COMPLETION DATE' : 'COMPLETION DATE'
                  const labelArea = showChinese ? '维护区域  SERVICE AREA' : 'SERVICE AREA'
                  const labelDetails = showChinese ? '维护详情对比  Service Details' : 'Service Details'
                  const areaCn = String(d?.category || '').trim()
                  const areaEn = areaToEn(areaCn)
                  const areaShow = showChinese ? [areaCn, areaEn].filter(Boolean).join(' ') : (areaEn || areaCn)
                  const jobNo = String(d?.work_no || d?.id || '')
                  const renderPhase = (phaseText: string, urls: string[]) => {
                    if (!urls.length) return null
                    const cell = (u: string, idx: number) => {
                      const src = resolveUrl(u)
                      return (
                        <div key={`${idx}-${u}`} style={{ minWidth: 0, padding: 0, margin: 0, border: 'none', borderRadius: 0, background: 'transparent', boxShadow: 'none', breakInside:'avoid', pageBreakInside:'avoid' }}>
                          {isImg(u) ? (
                            renderEngine === 'print'
                              ? <img crossOrigin="anonymous" src={src} style={{ width:'100%', height: '76mm', objectFit:'contain', display:'block', background:'#fff', border:'none', borderRadius: 0, boxShadow:'none', outline:'none' }} />
                              : <div style={{ width:'100%', height: '76mm', backgroundColor:'#fff', backgroundImage: `url(${src})`, backgroundRepeat:'no-repeat', backgroundPosition:'center', backgroundSize:'contain' }} />
                          ) : (
                            <a href={src} target="_blank" rel="noreferrer">{String(u).split('/').pop() || 'file'}</a>
                          )}
                        </div>
                      )
                    }
                    return (
                      <div style={{ width:'100%', marginTop: 18, breakInside:'avoid', pageBreakInside:'avoid' }}>
                        <div style={{ fontSize: 16, fontWeight: 700, color:'#111' }}>{phaseText}</div>
                        <div style={{ height: 2, background: '#c4cddd', marginTop: 10, marginBottom: 12 }} />
                        <div style={{ display:'grid', gridTemplateColumns:'repeat(3, minmax(0, 1fr))', gap: 16, alignItems: 'start' }}>
                          {urls.map((u, idx) => cell(u, idx))}
                        </div>
                      </div>
                    )
                  }
                  return (
                    <div
                      key={did || String(d?.work_no || '')}
                      style={{ marginTop: idx === 0 ? 16 : 0 }}
                    >
                      {(() => {
                        const phases: Array<{ label: string; urls: string[] }> = []
                        if (beforePdfArr.length) phases.push({ label: showChinese ? 'Before（前）' : 'Before', urls: beforePdfArr })
                        if (afterPdfArr.length) phases.push({ label: showChinese ? 'After（后）' : 'After', urls: afterPdfArr })
                        const firstPhase = phases[0] || null
                        const secondPhase = phases[1] || null
                        const canShow = allowPhotosInPdf && canIncludeJobPhotos && !!firstPhase
                        return (
                          <>
                            <div data-pdf-avoid-cut="true" style={{ breakInside:'avoid', pageBreakInside:'avoid' }}>
                              <div style={{ background: '#eef3fb', padding: '6px 8px', marginBottom: 10 }}>
                                <div style={{ fontWeight: 700, fontSize: 16, lineHeight: 1.2 }}>{title}</div>
                              </div>
                              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap: 22, padding: '2px 0 10px' }}>
                                <div style={{ minWidth: 0 }}>
                                  <div style={{ fontSize: 12, fontWeight: 700, color:'#6b778c', letterSpacing: 0.2, textTransform:'uppercase' }}>{labelJob}</div>
                                  <div style={{ marginTop: 8, fontSize: 16, fontWeight: 700, color:'#1f5cff', overflowWrap:'anywhere', lineHeight: 1.25 }}>{jobNo || '-'}</div>
                                </div>
                                <div style={{ minWidth: 0 }}>
                                  <div style={{ fontSize: 12, fontWeight: 700, color:'#6b778c', letterSpacing: 0.2, textTransform:'uppercase' }}>{labelCompletion}</div>
                                  <div style={{ marginTop: 8, fontSize: 16, fontWeight: 700, color:'#111', overflowWrap:'anywhere', lineHeight: 1.25 }}>{timeLabel || '-'}</div>
                                </div>
                                <div style={{ minWidth: 0 }}>
                                  <div style={{ fontSize: 12, fontWeight: 700, color:'#6b778c', letterSpacing: 0.2, textTransform:'uppercase' }}>{labelArea}</div>
                                  <div style={{ marginTop: 8, fontSize: 16, fontWeight: 700, color:'#111', overflowWrap:'anywhere', lineHeight: 1.25 }}>{areaShow || '-'}</div>
                                </div>
                              </div>
                              <div style={{ marginTop: 16, display:'flex', alignItems:'center', gap: 10 }}>
                                <div style={{ width: 4, height: 16, background:'#1f5cff', borderRadius: 2 }} />
                                <div style={{ fontSize: 16, fontWeight: 700, color:'#2b3a55', letterSpacing: 0.2, lineHeight: 1.2 }}>{labelDetails}</div>
                              </div>
                              {canShow ? (
                                <div style={{ marginTop: 6 }}>
                                  {renderPhase(firstPhase!.label, firstPhase!.urls)}
                                </div>
                              ) : null}
                            </div>
                            {(allowPhotosInPdf && canIncludeJobPhotos && !!secondPhase) ? (
                              <div style={{ marginTop: 6 }}>
                                {renderPhase(secondPhase!.label, secondPhase!.urls)}
                              </div>
                            ) : null}
                          </>
                        )
                      })()}
                    </div>
                  )
                })}
            </div>
          ) : (
            <>
              <div style={{ display:'flex', justifyContent:'flex-end', marginTop: 8 }}>
                <button
                  type="button"
                  onClick={() => setExpandAllDeepClean(v => !v)}
                  style={{ border:'1px solid #e5e7eb', background:'#fff', borderRadius: 8, padding:'6px 10px', fontSize: 12, cursor:'pointer' }}
                >
                  {expandAllDeepClean ? '收起全部照片' : '展开全部照片'}
                </button>
              </div>
              {(() => {
                const buildItems = (phase: 'before' | 'after') => {
                  const phaseLabel = phase === 'before' ? (showChinese ? '清洁前' : 'Before') : (showChinese ? '清洁后' : 'After')
                  const out: Array<{ url: string; caption: string }> = []
                  for (const r of deepCleanings || []) {
                    const workNo = String((r as any)?.work_no || (r as any)?.id || '').trim()
                    const day = toDayStr((r as any)?.completed_at)
                    const urls = urlArr(phase === 'before' ? (r as any)?.photo_urls : (r as any)?.repair_photo_urls)
                      .map((u: any) => String(u || '').trim())
                      .filter(Boolean)
                    for (const u of urls) out.push({ url: u, caption: `DC${workNo ? ` ${workNo}` : ''}${day ? ` • ${day}` : ''} • ${phaseLabel}` })
                  }
                  return out
                }
                const beforeItems = buildItems('before')
                const afterItems = buildItems('after')
                const beforeShow = expandAllDeepClean ? beforeItems : beforeItems.slice(0, 12)
                const afterShow = expandAllDeepClean ? afterItems : afterItems.slice(0, 12)
                return (
                  <div style={{ display:'flex', flexDirection:'column', gap: 14, marginTop: 10 }}>
                    <div>
                      <div style={{ fontWeight: 700, marginBottom: 6 }}>{showChinese ? '清洁前' : 'Before'}</div>
                      <div style={{ display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap: 10 }}>
                        {beforeShow.map((it, idx) => (
                          <div key={idx} style={{ border:'1px solid #eee', borderRadius: 10, padding: 0, overflow:'hidden', background:'#fff' }}>
                            {isImg(it.url)
                              ? <img crossOrigin="anonymous" loading={idx < 6 ? 'eager' : 'lazy'} decoding="async" src={resolveUrl(it.url)} style={{ width:'100%', height: 170, objectFit:'cover', borderRadius: 8 }} />
                              : <a href={resolveUrl(it.url)} target="_blank" rel="noreferrer">{String(it.url).split('/').pop() || 'file'}</a>}
                            <div style={{ fontSize: 12, color:'#333', padding:'6px 4px' }}>{it.caption}</div>
                          </div>
                        ))}
                      </div>
                      {(!expandAllDeepClean && beforeItems.length > beforeShow.length) ? <div style={{ marginTop: 6, fontSize: 12, color:'#6b7280' }}>{`+${beforeItems.length - beforeShow.length}`}</div> : null}
                    </div>
                    <div>
                      <div style={{ fontWeight: 700, marginBottom: 6 }}>{showChinese ? '清洁后' : 'After'}</div>
                      <div style={{ display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap: 10 }}>
                        {afterShow.map((it, idx) => (
                          <div key={idx} style={{ border:'1px solid #eee', borderRadius: 10, padding: 0, overflow:'hidden', background:'#fff' }}>
                            {isImg(it.url)
                              ? <img crossOrigin="anonymous" loading={idx < 6 ? 'eager' : 'lazy'} decoding="async" src={resolveUrl(it.url)} style={{ width:'100%', height: 170, objectFit:'cover', borderRadius: 8 }} />
                              : <a href={resolveUrl(it.url)} target="_blank" rel="noreferrer">{String(it.url).split('/').pop() || 'file'}</a>}
                            <div style={{ fontSize: 12, color:'#333', padding:'6px 4px' }}>{it.caption}</div>
                          </div>
                        ))}
                      </div>
                      {(!expandAllDeepClean && afterItems.length > afterShow.length) ? <div style={{ marginTop: 6, fontSize: 12, color:'#6b7280' }}>{`+${afterItems.length - afterShow.length}`}</div> : null}
                    </div>
                  </div>
                )
              })()}
            </>
          )}
        </div>
      ) : null}

      {(showMaintSectionFinal && maintenances.length) ? (
        <div data-maint-section="1" data-pdf-break-before={isPdfMode ? 'true' : undefined}>
          {isPdfMode ? (
            <div style={{ display:'flex', flexDirection:'column', gap: 12 }}>
              {maintenances
                .slice()
                .sort((a: any, b: any) => String(a?.completed_at || '').localeCompare(String(b?.completed_at || '')))
                .map((m: any, idx: number) => {
                  const date = dayLabel(m?.completed_at)
                  const startTime = m?.started_at ? dayjs(String(m.started_at)).format('HH:mm') : ''
                  const endTime = m?.ended_at ? dayjs(String(m.ended_at)).format('HH:mm') : ''
                  const timeLabel = [date, (startTime || endTime) ? `${startTime || '-'}~${endTime || '-'}` : ''].filter(Boolean).join(' ')
                  const mid = String(m?.id || '')
                  const beforeArr = urlArr((m as any)?.photo_urls).map((u: any) => String(u || '')).filter(Boolean)
                  const afterArr = urlArr((m as any)?.repair_photo_urls).map((u: any) => String(u || '')).filter(Boolean)
                  const beforePdfArr = beforeArr
                  const afterPdfArr = afterArr
                  const allowPhotosInPdf = (beforePdfArr.length + afterPdfArr.length) > 0
                  const title = showChinese ? 'Maintenance Repairs 维修记录' : 'Maintenance Repairs'
                  const labelJob = showChinese ? '工单编号  JOB NUMBER' : 'JOB NUMBER'
                  const labelCompletion = showChinese ? '完成时间  COMPLETION DATE' : 'COMPLETION DATE'
                  const labelArea = showChinese ? '维护区域  SERVICE AREA' : 'SERVICE AREA'
                  const labelDetails = showChinese ? '维护详情对比  Service Details' : 'Service Details'
                  const areaCn = String(m?.area || m?.category_detail || m?.category || '').trim()
                  const areaEn = areaToEn(areaCn)
                  const areaShow = showChinese ? [areaCn, areaEn].filter(Boolean).join(' ') : (areaEn || areaCn)
                  const jobNo = String(m?.work_no || m?.id || '')
                  const renderPhase = (phaseText: string, urls: string[]) => {
                    if (!urls.length) return null
                    const cell = (u: string, idx: number) => {
                      const src = resolveUrl(u)
                      return (
                        <div key={`${idx}-${u}`} style={{ minWidth: 0, padding: 0, margin: 0, border: 'none', borderRadius: 0, background: 'transparent', boxShadow: 'none', breakInside:'avoid', pageBreakInside:'avoid' }}>
                          {isImg(u) ? (
                            renderEngine === 'print'
                              ? <img crossOrigin="anonymous" src={src} style={{ width:'100%', height: '76mm', objectFit:'contain', display:'block', background:'#fff', border:'none', borderRadius: 0, boxShadow:'none', outline:'none' }} />
                              : <div style={{ width:'100%', height: '76mm', backgroundColor:'#fff', backgroundImage: `url(${src})`, backgroundRepeat:'no-repeat', backgroundPosition:'center', backgroundSize:'contain' }} />
                          ) : (
                            <a href={src} target="_blank" rel="noreferrer">{String(u).split('/').pop() || 'file'}</a>
                          )}
                        </div>
                      )
                    }
                    return (
                      <div style={{ width:'100%', marginTop: 18, breakInside:'avoid', pageBreakInside:'avoid' }}>
                        <div style={{ fontSize: 16, fontWeight: 700, color:'#111' }}>{phaseText}</div>
                        <div style={{ height: 2, background: '#c4cddd', marginTop: 10, marginBottom: 12 }} />
                        <div style={{ display:'grid', gridTemplateColumns:'repeat(3, minmax(0, 1fr))', gap: 16, alignItems: 'start' }}>
                          {urls.map((u, idx) => cell(u, idx))}
                        </div>
                      </div>
                    )
                  }
                  return (
                    <div key={mid || String(m?.work_no || '')} style={{ marginTop: idx === 0 ? 16 : 0 }}>
                      {(() => {
                        const phases: Array<{ label: string; urls: string[] }> = []
                        if (beforePdfArr.length) phases.push({ label: showChinese ? 'Before（前）' : 'Before', urls: beforePdfArr })
                        if (afterPdfArr.length) phases.push({ label: showChinese ? 'After（后）' : 'After', urls: afterPdfArr })
                        const firstPhase = phases[0] || null
                        const secondPhase = phases[1] || null
                        const canShow = allowPhotosInPdf && canIncludeJobPhotos && !!firstPhase
                        return (
                          <>
                            <div data-pdf-avoid-cut="true" style={{ breakInside:'avoid', pageBreakInside:'avoid' }}>
                              <div style={{ background: '#eef3fb', padding: '6px 8px', marginBottom: 10 }}>
                                <div style={{ fontWeight: 700, fontSize: 16, lineHeight: 1.2 }}>{title}</div>
                              </div>
                              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap: 22, padding: '2px 0 10px' }}>
                                <div style={{ minWidth: 0 }}>
                                  <div style={{ fontSize: 12, fontWeight: 700, color:'#6b778c', letterSpacing: 0.2, textTransform:'uppercase' }}>{labelJob}</div>
                                  <div style={{ marginTop: 8, fontSize: 16, fontWeight: 700, color:'#1f5cff', overflowWrap:'anywhere', lineHeight: 1.25 }}>{jobNo || '-'}</div>
                                </div>
                                <div style={{ minWidth: 0 }}>
                                  <div style={{ fontSize: 12, fontWeight: 700, color:'#6b778c', letterSpacing: 0.2, textTransform:'uppercase' }}>{labelCompletion}</div>
                                  <div style={{ marginTop: 8, fontSize: 16, fontWeight: 700, color:'#111', overflowWrap:'anywhere', lineHeight: 1.25 }}>{timeLabel || '-'}</div>
                                </div>
                                <div style={{ minWidth: 0 }}>
                                  <div style={{ fontSize: 12, fontWeight: 700, color:'#6b778c', letterSpacing: 0.2, textTransform:'uppercase' }}>{labelArea}</div>
                                  <div style={{ marginTop: 8, fontSize: 16, fontWeight: 700, color:'#111', overflowWrap:'anywhere', lineHeight: 1.25 }}>{areaShow || '-'}</div>
                                </div>
                              </div>
                              <div style={{ marginTop: 16, display:'flex', alignItems:'center', gap: 10 }}>
                                <div style={{ width: 4, height: 16, background:'#1f5cff', borderRadius: 2 }} />
                                <div style={{ fontSize: 16, fontWeight: 700, color:'#2b3a55', letterSpacing: 0.2, lineHeight: 1.2 }}>{labelDetails}</div>
                              </div>
                              {canShow ? (
                                <div style={{ marginTop: 6 }}>
                                  {renderPhase(firstPhase!.label, firstPhase!.urls)}
                                </div>
                              ) : null}
                            </div>
                            {(allowPhotosInPdf && canIncludeJobPhotos && !!secondPhase) ? (
                              <div style={{ marginTop: 6 }}>
                                {renderPhase(secondPhase!.label, secondPhase!.urls)}
                              </div>
                            ) : null}
                          </>
                        )
                      })()}
                    </div>
                  )
                })}
            </div>
          ) : (
            <>
              <div data-keep-with-next="true" style={{ marginTop: 16, fontWeight: 700, background:'#eef3fb', padding:'6px 8px' }}>
                {showChinese ? 'Maintenance Repairs 维修记录' : 'Maintenance Repairs'}
              </div>
              <div style={{ display:'flex', justifyContent:'flex-end', marginTop: 8 }}>
                <button
                  type="button"
                  onClick={() => setExpandAllMaintenance(v => !v)}
                  style={{ border:'1px solid #e5e7eb', background:'#fff', borderRadius: 8, padding:'6px 10px', fontSize: 12, cursor:'pointer' }}
                >
                  {expandAllMaintenance ? '收起全部照片' : '展开全部照片'}
                </button>
              </div>
              {(() => {
                const buildItems = (phase: 'before' | 'after') => {
                  const phaseLabel = phase === 'before' ? (showChinese ? '维修前' : 'Before') : (showChinese ? '维修后' : 'After')
                  const out: Array<{ url: string; caption: string }> = []
                  for (const r of maintenances || []) {
                    const workNo = String((r as any)?.work_no || (r as any)?.id || '').trim()
                    const day = toDayStr((r as any)?.completed_at)
                    const urls = urlArr(phase === 'before' ? (r as any)?.photo_urls : (r as any)?.repair_photo_urls)
                      .map((u: any) => String(u || '').trim())
                      .filter(Boolean)
                    for (const u of urls) out.push({ url: u, caption: `R${workNo ? ` ${workNo}` : ''}${day ? ` • ${day}` : ''} • ${phaseLabel}` })
                  }
                  return out
                }
                const beforeItems = buildItems('before')
                const afterItems = buildItems('after')
                const beforeShow = expandAllMaintenance ? beforeItems : beforeItems.slice(0, 12)
                const afterShow = expandAllMaintenance ? afterItems : afterItems.slice(0, 12)
                return (
                  <div style={{ display:'flex', flexDirection:'column', gap: 14, marginTop: 10 }}>
                    <div>
                      <div style={{ fontWeight: 700, marginBottom: 6 }}>{showChinese ? '维修前' : 'Before'}</div>
                      <div style={{ display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap: 10 }}>
                        {beforeShow.map((it, idx) => (
                          <div key={idx} style={{ border:'1px solid #eee', borderRadius: 10, padding: 0, overflow:'hidden', background:'#fff' }}>
                            {isImg(it.url)
                              ? <img crossOrigin="anonymous" loading={idx < 6 ? 'eager' : 'lazy'} decoding="async" src={resolveUrl(it.url)} style={{ width:'100%', height: 170, objectFit:'cover', borderRadius: 8 }} />
                              : <a href={resolveUrl(it.url)} target="_blank" rel="noreferrer">{String(it.url).split('/').pop() || 'file'}</a>}
                            <div style={{ fontSize: 12, color:'#333', padding:'6px 4px' }}>{it.caption}</div>
                          </div>
                        ))}
                      </div>
                      {(!expandAllMaintenance && beforeItems.length > beforeShow.length) ? <div style={{ marginTop: 6, fontSize: 12, color:'#6b7280' }}>{`+${beforeItems.length - beforeShow.length}`}</div> : null}
                    </div>
                    <div>
                      <div style={{ fontWeight: 700, marginBottom: 6 }}>{showChinese ? '维修后' : 'After'}</div>
                      <div style={{ display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap: 10 }}>
                        {afterShow.map((it, idx) => (
                          <div key={idx} style={{ border:'1px solid #eee', borderRadius: 10, padding: 0, overflow:'hidden', background:'#fff' }}>
                            {isImg(it.url)
                              ? <img crossOrigin="anonymous" loading={idx < 6 ? 'eager' : 'lazy'} decoding="async" src={resolveUrl(it.url)} style={{ width:'100%', height: 170, objectFit:'cover', borderRadius: 8 }} />
                              : <a href={resolveUrl(it.url)} target="_blank" rel="noreferrer">{String(it.url).split('/').pop() || 'file'}</a>}
                            <div style={{ fontSize: 12, color:'#333', padding:'6px 4px' }}>{it.caption}</div>
                          </div>
                        ))}
                      </div>
                      {(!expandAllMaintenance && afterItems.length > afterShow.length) ? <div style={{ marginTop: 6, fontSize: 12, color:'#6b7280' }}>{`+${afterItems.length - afterShow.length}`}</div> : null}
                    </div>
                  </div>
                )
              })()}
            </>
          )}
        </div>
      ) : null}

      {(showBaseSections && showInvoices) && (
      <>
      <div data-keep-with-next="true" style={{ marginTop: 24, fontWeight: 700, background:'#eef3fb', padding:'6px 8px' }}>{showChinese ? 'Expense Invoices 支出发票' : 'Expense Invoices'}</div>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(2, 1fr)', gap: 12 }}>
        {expensesInMonthAll.map(e => {
          const eid = String((e as any).id)
          const invs = (invoiceMap[eid] || []).slice()
          if (!invs.length) {
            const cat = catKey(e)
            const txInv = (txs || []).filter(t => {
              if (t.kind !== 'expense') return false
              const baseDateRaw: any = (t as any).paid_date || t.occurred_at || (t as any).created_at
              const inMonth = baseDateRaw ? dayjs(toDayStr(baseDateRaw)).isSame(start, 'month') : false
              const sameCat = catKey(t) === cat
              const hasUrl = !!(t as any).invoice_url
              const samePid = (!propertyId) || (t.property_id === propertyId)
              return inMonth && sameCat && hasUrl && samePid
            })
            txInv.forEach((t: any, idx: number) => {
              const url = /^https?:\/\//.test(String(t.invoice_url || '')) ? String(t.invoice_url) : `${API_BASE}${String(t.invoice_url || '')}`
              invs.push({ id: `tx-${eid}-${idx}`, expense_id: eid, url } as any)
            })
          }
          return (
            <div key={eid} style={{ border:'1px solid #eee', padding:8 }}>
              <div style={{ display:'flex', justifyContent:'space-between' }}>
                <span>{(e as any).category || (showChinese ? '其他' : 'Other')}</span>
                <span>-${fmt(Number((e as any).amount||0))}</span>
              </div>
              <div style={{ fontSize:12 }}>{dayjs(toDayStr((e as any).occurred_at)).format('DD/MM/YYYY')}</div>
              {invs.length ? (
                <div style={{ display:'grid', gridTemplateColumns:'repeat(2, 1fr)', gap: 8, marginTop:6 }}>
                  {invs.map((iv) => {
                    const u = resolveUrl(iv.url)
                    return isImg(iv.url) ? (
                      <img key={iv.id} src={u} style={{ width:'100%' }} alt="invoice" />
                    ) : isPdf(iv.url) ? (
                      <object key={iv.id} data={u} type="application/pdf" style={{ width:'100%', height: 300 }}>
                        <a href={u} target="_blank" rel="noreferrer">{showChinese ? '查看发票' : 'View invoice'}</a>
                      </object>
                    ) : (
                      <a key={iv.id} href={u} target="_blank" rel="noreferrer">{showChinese ? '查看发票' : 'View invoice'}</a>
                    )
                  })}
                </div>
              ) : (
                <div style={{ fontSize:12, color:'#888', marginTop:6 }}>{showChinese ? '未上传发票' : 'No invoice uploaded'}</div>
              )}
            </div>
          )
        })}
      </div>
      </>
      )}
    </div>
  )
})
