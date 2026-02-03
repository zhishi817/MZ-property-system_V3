"use client"
import { Card, DatePicker, Table, Select, Button, Modal, message, Switch, Progress } from 'antd'
import styles from './ExpandedRow.module.css'
import html2canvas from 'html2canvas'
import { jsPDF } from 'jspdf'
import dayjs from 'dayjs'
import { useEffect, useMemo, useRef, useState } from 'react'
import { getJSON, apiList, API_BASE, authHeaders, patchJSON } from '../../../lib/api'
import { sortProperties, sortPropertiesByRegionThenCode } from '../../../lib/properties'
import MonthlyStatementView from '../../../components/MonthlyStatement'
import { monthSegments, toDayStr, getMonthSegmentsForProperty, parseDateOnly } from '../../../lib/orders'
import { normalizeReportCategory, shouldIncludeIncomeTxInPropertyOtherIncome, txInMonth, txMatchesProperty } from '../../../lib/financeTx'
import { computeMonthlyStatementBalance, isFurnitureOwnerPayment, isFurnitureRecoverableCharge } from '../../../lib/statementBalances'
import { formatStatementDesc } from '../../../lib/statementDesc'
const debugOnce = (..._args: any[]) => {}
import FiscalYearStatement from '../../../components/FiscalYearStatement'
import { MailOutlined, CreditCardOutlined, CheckOutlined } from '@ant-design/icons'
import { nextToggleValue } from '../../../lib/toggleStatus'

type Order = { id: string; property_id?: string; checkin?: string; checkout?: string; price?: number; cleaning_fee?: number; nights?: number; status?: string; count_in_income?: boolean }
type Tx = { id: string; kind: 'income'|'expense'; amount: number; currency: string; property_id?: string; occurred_at: string; category?: string; category_detail?: string; note?: string; ref_type?: string; ref_id?: string }
type Landlord = { id: string; name: string; management_fee_rate?: number; property_ids?: string[] }
type RevenueStatus = { scheduled_email_set: boolean; transferred: boolean }
type PendingOps = Record<string, { scheduled?: boolean; transfer?: boolean }>
type MergeUiStatus = 'active' | 'exception' | 'success'

export default function PropertyRevenuePage() {
  const [month, setMonth] = useState<any>(dayjs())
  const [orders, setOrders] = useState<Order[]>([])
  const [txs, setTxs] = useState<Tx[]>([])
  const [excludeOrphanFixedSnapshots, setExcludeOrphanFixedSnapshots] = useState<boolean>(true)
  const [orphanFixedSnapshots, setOrphanFixedSnapshots] = useState<any[]>([])
  const [orphanOpen, setOrphanOpen] = useState(false)
  const [properties, setProperties] = useState<{ id: string; code?: string; address?: string }[]>([])
  const [landlords, setLandlords] = useState<Landlord[]>([])
  const [selectedPid, setSelectedPid] = useState<string | undefined>(undefined)
  const [previewPid, setPreviewPid] = useState<string | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [mergeUi, setMergeUi] = useState<{ open: boolean; percent: number; status: MergeUiStatus; stage: string; detail?: string }>({ open: false, percent: 0, status: 'active', stage: '', detail: '' })
  const printRef = useRef<HTMLDivElement>(null)
  const [period, setPeriod] = useState<'month'|'year'|'half-year'|'fiscal-year'>('month')
  const [startMonth, setStartMonth] = useState<any>(dayjs())
  const [showChinese, setShowChinese] = useState<boolean>(true)
  const [revenueStatusByKey, setRevenueStatusByKey] = useState<Record<string, RevenueStatus>>({})
  const [baselineStatusByKey, setBaselineStatusByKey] = useState<Record<string, Partial<RevenueStatus>>>({})
  const [pendingOps, setPendingOps] = useState<PendingOps>({})
  const statusKeyOf = (pid: string, monthKey: string) => `${String(pid)}__${String(monthKey)}`
  const isMerging = mergeUi.open && mergeUi.status === 'active'
  useEffect(() => {
    getJSON<Order[]>('/orders').then(setOrders).catch(()=>setOrders([]))
    ;(async () => {
      try {
        const fin: any[] = await getJSON<Tx[]>('/finance')
        const pexp: any[] = await apiList<any[]>('property_expenses')
        const recurs: any[] = await apiList<any[]>('recurring_payments')
        const mapCat = (c?: string) => {
          const v = String(c || '')
          if (v === 'gas_hot_water') return 'gas'
          if (v === 'consumables') return 'consumable'
          if (v === 'owners_corp') return 'property_fee'
          if (v === 'council_rate') return 'council'
          if (v.toLowerCase() === 'nbn' || v.toLowerCase() === 'internet' || v.includes('网')) return 'internet'
          return v
        }
        const recurringArr = Array.isArray(recurs) ? recurs : []
        const recurringIdSet = new Set(recurringArr.map((r: any) => String(r.id)))
        const mapReport: Record<string, string> = Object.fromEntries(recurringArr.map((r:any)=>[String(r.id), String(r.report_category||'')]))
        const mapVendor: Record<string, string> = Object.fromEntries(recurringArr.map((r:any)=>[String(r.id), String(r.vendor||'')]))
        const toReportCat = (raw?: string) => {
          const v = String(raw||'').toLowerCase()
          if (v.includes('management_fee') || v.includes('管理费')) return 'management_fee'
          if (v.includes('carpark') || v.includes('车位')) return 'parking_fee'
          if (v.includes('owners') || v.includes('body') || v.includes('物业')) return 'body_corp'
          if (v.includes('internet') || v.includes('nbn') || v.includes('网')) return 'internet'
          if (v.includes('electric') || v.includes('电')) return 'electricity'
          if ((v.includes('water') || v.includes('水')) && !v.includes('hot') && !v.includes('热')) return 'water'
          if (v.includes('gas') || v.includes('hot') || v.includes('热水') || v.includes('煤气')) return 'gas'
          if (v.includes('consumable') || v.includes('消耗')) return 'consumables'
          if (v.includes('council') || v.includes('市政')) return 'council'
          return 'other'
        }
        let orphanCount = 0
        let orphanTotal = 0
        const orphanRows: any[] = []
        const peMapped: Tx[] = (Array.isArray(pexp) ? pexp : []).flatMap((r: any) => {
          const code = String(r.property_code || '').trim()
          const pidRaw = r.property_id || undefined
          const match = properties.find(pp => (pp.code || '') === code)
          const pidNorm = (pidRaw && properties.some(pp => pp.id === pidRaw)) ? pidRaw : (match ? match.id : pidRaw)
          const fid = String(r.fixed_expense_id || '')
          const genFrom = String(r.generated_from || '')
          const note = String(r.note || '')
          const isSnapshot = genFrom === 'recurring_payments' || /^fixed payment/i.test(note)
          const isOrphanSnapshot = !!(fid && isSnapshot && !recurringIdSet.has(fid))
          if (isOrphanSnapshot) {
            orphanCount += 1
            orphanTotal += Number(r.amount || 0)
            if (orphanRows.length < 50) orphanRows.push(r)
            if (excludeOrphanFixedSnapshots) return []
          }
          const vendor = fid ? String(mapVendor[fid] || '') : ''
          const baseDetail = String(r.category_detail || '').trim()
          const injectedDetail = (!baseDetail && vendor) ? vendor : baseDetail
          return [{
            id: r.id,
            kind: 'expense',
            amount: Number(r.amount || 0),
            currency: r.currency || 'AUD',
            property_id: pidNorm,
            occurred_at: r.occurred_at,
            category: mapCat(r.category),
            // 其他支出描述
            ...(r.property_code ? { property_code: r.property_code } : {}),
            ...(injectedDetail ? { category_detail: injectedDetail } : {}),
            ...(r.note ? { note: r.note } : {}),
            ...(r.fixed_expense_id ? { fixed_expense_id: r.fixed_expense_id } : {}),
            ...(r.month_key ? { month_key: r.month_key } : {}),
            ...(r.due_date ? { due_date: r.due_date } : {}),
            ...(r.status ? { status: r.status } : {}),
            report_category: normalizeReportCategory((r.fixed_expense_id ? (mapReport[String(r.fixed_expense_id)] || '') : '') || toReportCat(r.category || r.category_detail))
          }]
        })
        const finMapped: Tx[] = (Array.isArray(fin) ? fin : []).map((t: any) => ({
          id: t.id,
          kind: t.kind,
          amount: Number(t.amount || 0),
          currency: t.currency || 'AUD',
          property_id: t.property_id || undefined,
          occurred_at: t.occurred_at,
          category: mapCat(t.category),
          ...(t.category_detail ? { category_detail: t.category_detail } : {}),
          ...(t.note ? { note: t.note } : {}),
          ...(t.ref_type ? { ref_type: t.ref_type } : {}),
          ...(t.ref_id ? { ref_id: t.ref_id } : {}),
          ...(t.invoice_url ? { invoice_url: t.invoice_url } : {})
        }))
        setOrphanFixedSnapshots(orphanRows)
        if (orphanCount > 0) {
          const amt = (orphanTotal || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
          message.warning({
            key: 'orphanFixedExpenseSnapshots',
            content: (
              <span>
                检测到 {orphanCount} 条孤儿固定支出快照（合计 ${amt}）。当前{excludeOrphanFixedSnapshots ? '已排除' : '仍计入'}房源营收统计。
                <Button type="link" style={{ padding: 0, marginLeft: 8 }} onClick={() => setOrphanOpen(true)}>查看明细</Button>
              </span>
            ),
            duration: 8
          })
        } else {
          message.destroy('orphanFixedExpenseSnapshots')
        }
        setTxs([...finMapped, ...peMapped])
      } catch { setTxs([]) }
    })()
    getJSON<any>('/properties').then((j)=>setProperties(j||[])).catch(()=>setProperties([]))
    getJSON<Landlord[]>('/landlords').then(setLandlords).catch(()=>setLandlords([]))
  }, [excludeOrphanFixedSnapshots])

  useEffect(() => {
    ;(async () => {
      try {
        const fin: any[] = await getJSON<Tx[]>('/finance')
        const pexp: any[] = await apiList<any[]>('property_expenses')
        const recurs: any[] = await apiList<any[]>('recurring_payments')
        const mapCat = (c?: string) => {
          const v = String(c || '')
          if (v === 'gas_hot_water') return 'gas'
          if (v === 'consumables') return 'consumable'
          if (v === 'owners_corp') return 'property_fee'
          if (v === 'council_rate') return 'council'
          if (v.toLowerCase() === 'nbn' || v.toLowerCase() === 'internet' || v.includes('网')) return 'internet'
          return v
        }
        const recurringArr = Array.isArray(recurs) ? recurs : []
        const recurringIdSet = new Set(recurringArr.map((r: any) => String(r.id)))
        const mapReport: Record<string, string> = Object.fromEntries(recurringArr.map((r:any)=>[String(r.id), String(r.report_category||'')]))
        const mapVendor: Record<string, string> = Object.fromEntries(recurringArr.map((r:any)=>[String(r.id), String(r.vendor||'')]))
        const toReportCat = (raw?: string) => {
          const v = String(raw||'').toLowerCase()
          if (v.includes('management_fee') || v.includes('管理费')) return 'management_fee'
          if (v.includes('carpark') || v.includes('车位')) return 'parking_fee'
          if (v.includes('owners') || v.includes('body') || v.includes('物业')) return 'body_corp'
          if (v.includes('internet') || v.includes('nbn') || v.includes('网')) return 'internet'
          if (v.includes('electric') || v.includes('电')) return 'electricity'
          if ((v.includes('water') || v.includes('水')) && !v.includes('hot')) return 'water'
          if (v.includes('gas') || v.includes('hot') || v.includes('热水')) return 'gas'
          if (v.includes('consumable') || v.includes('消耗')) return 'consumables'
          if (v.includes('council') || v.includes('市政')) return 'council'
          return 'other'
        }
        let orphanCount = 0
        let orphanTotal = 0
        const orphanRows: any[] = []
        const peMapped: Tx[] = (Array.isArray(pexp) ? pexp : []).flatMap((r: any) => {
          const code = String(r.property_code || '').trim()
          const pidRaw = r.property_id || undefined
          const match = properties.find(pp => (pp.code || '') === code)
          const pidNorm = (pidRaw && properties.some(pp => pp.id === pidRaw)) ? pidRaw : (match ? match.id : pidRaw)
          const fid = String(r.fixed_expense_id || '')
          const genFrom = String(r.generated_from || '')
          const note = String(r.note || '')
          const isSnapshot = genFrom === 'recurring_payments' || /^fixed payment/i.test(note)
          const isOrphanSnapshot = !!(fid && isSnapshot && !recurringIdSet.has(fid))
          if (isOrphanSnapshot) {
            orphanCount += 1
            orphanTotal += Number(r.amount || 0)
            if (orphanRows.length < 50) orphanRows.push(r)
            if (excludeOrphanFixedSnapshots) return []
          }
          const vendor = fid ? String(mapVendor[fid] || '') : ''
          const baseDetail = String(r.category_detail || '').trim()
          const injectedDetail = (!baseDetail && vendor) ? vendor : baseDetail
          return [{
            id: r.id,
            kind: 'expense',
            amount: Number(r.amount || 0),
            currency: r.currency || 'AUD',
            property_id: pidNorm,
            occurred_at: r.occurred_at,
            category: mapCat(r.category),
            ...(r.property_code ? { property_code: r.property_code } : {}),
            ...(injectedDetail ? { category_detail: injectedDetail } : {}),
            ...(r.note ? { note: r.note } : {}),
            ...(r.fixed_expense_id ? { fixed_expense_id: r.fixed_expense_id } : {}),
            ...(r.month_key ? { month_key: r.month_key } : {}),
            ...(r.due_date ? { due_date: r.due_date } : {}),
            ...(r.status ? { status: r.status } : {}),
            report_category: normalizeReportCategory((r.fixed_expense_id ? (mapReport[String(r.fixed_expense_id)] || '') : '') || toReportCat(r.category || r.category_detail))
          }]
        })
        const finMapped: Tx[] = (Array.isArray(fin) ? fin : []).map((t: any) => ({
          id: t.id,
          kind: t.kind,
          amount: Number(t.amount || 0),
          currency: t.currency || 'AUD',
          property_id: t.property_id || undefined,
          occurred_at: t.occurred_at,
          category: mapCat(t.category),
          ...(t.category_detail ? { category_detail: t.category_detail } : {}),
          ...(t.note ? { note: t.note } : {}),
          ...(t.ref_type ? { ref_type: t.ref_type } : {}),
          ...(t.ref_id ? { ref_id: t.ref_id } : {})
        }))
        setOrphanFixedSnapshots(orphanRows)
        if (orphanCount > 0) {
          const amt = (orphanTotal || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
          message.warning({
            key: 'orphanFixedExpenseSnapshots',
            content: (
              <span>
                检测到 {orphanCount} 条孤儿固定支出快照（合计 ${amt}）。当前{excludeOrphanFixedSnapshots ? '已排除' : '仍计入'}房源营收统计。
                <Button type="link" style={{ padding: 0, marginLeft: 8 }} onClick={() => setOrphanOpen(true)}>查看明细</Button>
              </span>
            ),
            duration: 8
          })
        } else {
          message.destroy('orphanFixedExpenseSnapshots')
        }
        setTxs([...finMapped, ...peMapped])
      } catch {}
    })()
  }, [month, excludeOrphanFixedSnapshots])
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

  const statusRange = useMemo(() => {
    if (!start || !end) return null
    return { from: start.format('YYYY-MM'), to: end.format('YYYY-MM') }
  }, [start, end])

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

  const rows = useMemo(() => {
    if (!start || !end) return [] as any[]
    const list = selectedPid ? properties.filter(pp => pp.id === selectedPid) : sortPropertiesByRegionThenCode(properties as any)
    const orderById = new Map((orders || []).map(o => [String(o.id), o]))
    const out: any[] = []
    const rangeMonths: { start: any, end: any, label: string }[] = []
    let cur = start.startOf('month')
    const last = end.startOf('month')
    while (cur.isSame(last, 'month') || cur.isBefore(last, 'month')) {
      rangeMonths.push({ start: cur.startOf('month'), end: cur.add(1,'month').startOf('month'), label: cur.format('MM/YYYY') })
      cur = cur.add(1,'month')
    }
    for (const p of list) {
      if (process.env.NODE_ENV === 'development') {
        const selectedPropertyCode = String(p.code || '')
        const selectedMonth = (month || dayjs()).format('YYYY-MM')
        const monthKey = (x: any) => dayjs(toDayStr((x as any).occurred_at)).format('YYYY-MM')
        const expenses = (txs || []).filter(x => x.kind==='expense')
        console.log('expense candidates for code', selectedPropertyCode,
          expenses.filter(x => String((x as any).property_code || '').includes(selectedPropertyCode) || String((x as any).property_id || '').includes(String(p.id)))
        )
        console.log('expense after month filter', expenses.filter(x => monthKey(x) === selectedMonth))
      }
      for (const rm of rangeMonths) {
        const related = getMonthSegmentsForProperty(orders as any, rm.start, String(p.id))
        debugOnce(`REVENUE_DEBUG ${rm.label} ${String(p.id)}`, related.map(s => s.id))
        const e = txs.filter(x => {
          if (x.kind !== 'expense') return false
          if (!txMatchesProperty(x, p as any)) return false
          return txInMonth(x as any, rm.start)
        }).filter(x => !isFurnitureRecoverableCharge(x as any))
        function overlap(s: any) {
          const ci = parseDateOnly(toDayStr(s.checkin))
          const co = parseDateOnly(toDayStr(s.checkout))
          const a = ci.isAfter(rm.start) ? ci : rm.start
          const b = co.isBefore(rm.end) ? co : rm.end
          return Math.max(0, b.diff(a, 'day'))
        }
        const rentIncome = related.reduce((sum, seg) => sum + Number(((seg as any).visible_net_income ?? (seg as any).net_income ?? 0)), 0)
        const otherIncomeTx = txs.filter(x => {
          if (x.kind !== 'income') return false
          if (x.property_id !== p.id) return false
          if (!dayjs(toDayStr(x.occurred_at)).isSame(rm.start, 'month')) return false
          if (isFurnitureOwnerPayment(x as any)) return false
          if (String(x.category || '').toLowerCase() === 'late_checkout') return false
          return shouldIncludeIncomeTxInPropertyOtherIncome(x, orderById)
        })
        const otherIncome = otherIncomeTx.reduce((s,x)=> s + Number(x.amount||0), 0)
        const mapIncomeCatLabel = (c?: string) => {
          const v = String(c || '')
          if (v === 'late_checkout') return '晚退房费'
          if (v === 'cancel_fee') return '取消费'
          return v || '-'
        }
        const otherIncomeDesc = Array.from(new Set(otherIncomeTx.map(t => mapIncomeCatLabel(t.category)))).filter(Boolean).join('、') || '-'
        const totalIncome = rentIncome + otherIncome
        const nights = related.reduce((s,x)=> s + Number(x.nights || 0), 0)
        const daysInMonth = rm.end.diff(rm.start,'day')
        const occRate = daysInMonth ? Math.round(((nights / daysInMonth)*100 + Number.EPSILON)*100)/100 : 0
        const avg = nights ? Math.round(((rentIncome / nights) + Number.EPSILON)*100)/100 : 0
        const landlordByList = landlords.find(l => (l.property_ids||[]).includes(p.id))
        const landlordByLink = landlords.find(l => String((l as any).id||'') === String((p as any).landlord_id||''))
        const rate = landlordByList?.management_fee_rate ?? landlordByLink?.management_fee_rate ?? 0
        const mgmtRecorded = e.filter(xx=> String((xx as any).report_category||'')==='management_fee').reduce((s,x)=> s + Number(x.amount||0), 0)
        const mgmt = mgmtRecorded ? mgmtRecorded : (rate ? Math.round(((rentIncome * rate) + Number.EPSILON)*100)/100 : 0)
        const byReport = (key: string) => e.filter(xx => normalizeReportCategory((xx as any).report_category || (xx as any).category) === key).reduce((s,x)=> s + Number(x.amount||0), 0)
        const carpark = byReport('parking_fee')
        const electricity = byReport('electricity')
        const water = byReport('water')
        const gas = byReport('gas')
        const internet = byReport('internet')
        const consumable = byReport('consumables')
        const ownercorp = byReport('body_corp')
        const council = byReport('council')
        const other = byReport('other')
        function cleanOtherDesc(raw?: any): string {
          let s = String(raw || '').trim()
          if (!s) return ''
          s = s.replace(/^other\s*,\s*/i, '')
          s = s.replace(/^其他\s*[，,]\s*/i, '')
          if (/^(other|其他)$/i.test(s)) return ''
          if (/^fixed\s*payment$/i.test(s)) return ''
          return s
        }
        const otherItems = e
          .filter(xx => normalizeReportCategory((xx as any).report_category || (xx as any).category) === 'other')
          .map(xx => cleanOtherDesc((xx as any).category_detail || (xx as any).note || ''))
          .filter(Boolean)
        const otherExpenseDescFmt = formatStatementDesc({ items: otherItems, lang: 'en' })
        const totalExp = mgmt + electricity + water + gas + internet + consumable + carpark + ownercorp + council + other
        const net = Math.round(((totalIncome - totalExp) + Number.EPSILON)*100)/100
        const monthKey = rm.start.format('YYYY-MM')
        const landlord = landlords.find(l => (l.property_ids || []).includes(p.id))
        let payableToOwner = 0
        let netFromBalance: number | null = null
        try {
          const b = computeMonthlyStatementBalance({
            month: monthKey,
            propertyId: p.id,
            propertyCode: p.code || undefined,
            orders: orders as any,
            txs: txs as any,
            managementFeeRate: landlord?.management_fee_rate,
          })
          netFromBalance = Number(b.operating_net_income || 0)
          payableToOwner = Math.max(0, Number(b.payable_to_owner || 0))
          if (!Number.isFinite(payableToOwner)) payableToOwner = 0
        } catch {
          payableToOwner = Math.max(0, Number(net || 0))
        }
        if (process.env.NODE_ENV === 'development' && netFromBalance != null) {
          const diff = Math.abs(Number(netFromBalance) - Number(net || 0))
          if (diff > 0.02) console.warn('payableToOwner: net mismatch', { property: p.code || p.id, month: monthKey, net, netFromBalance })
        }
        out.push({ key: `${p.id}-${rm.label}`, pid: p.id, month: rm.label, monthKey, code: p.code || p.id, address: p.address, occRate, avg, totalIncome, rentIncome, otherIncome, otherIncomeDesc, mgmt, electricity, water, gas, internet, consumable, carpark, ownercorp, council, other, otherExpenseDesc: otherExpenseDescFmt.text, otherExpenseDescFull: otherExpenseDescFmt.full, totalExp, net, payableToOwner })
      }
    }
    return out
  }, [properties, orders, txs, landlords, start, end, selectedPid])

  const totals = useMemo(() => {
    const sum = (arr: any[], key: string) => arr.reduce((s, x) => s + Number(x?.[key] || 0), 0)
    const income = sum(rows, 'totalIncome')
    const expense = sum(rows, 'totalExp')
    const net = income - expense
    const fmt2 = (n: number) => (n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    return { income: fmt2(income), expense: fmt2(expense), net: fmt2(net) }
  }, [rows])

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
    <Card title="房源营收">
      <div style={{ marginBottom: 12, display:'flex', gap:8, alignItems:'center' }}>
        <DatePicker picker="month" value={month} onChange={setMonth as any} />
        <Select
          allowClear
          placeholder="选择范围(年/半年/财年)"
          value={period==='month' ? undefined : period}
          onChange={(v) => setPeriod((v as any) || 'month')}
          style={{ width: 220 }}
          options={[{value:'year',label:'全年(自然年)'},{value:'half-year',label:'半年'},{value:'fiscal-year',label:'财年(7月至次年6月)'}]}
        />
        {period==='half-year' ? <DatePicker picker="month" value={startMonth} onChange={setStartMonth as any} /> : null}
        <Select allowClear showSearch optionFilterProp="label" filterOption={(input, option)=> String((option as any)?.label||'').toLowerCase().includes(String(input||'').toLowerCase())} placeholder="按房号筛选" style={{ width: 240 }} options={sortProperties(properties).map(p=>({ value:p.id, label:p.code || p.address || p.id }))} value={selectedPid} onChange={setSelectedPid} />
        <Button type="primary" onClick={() => { if (!selectedPid) { message.warning('请先选择房号'); return } setPreviewPid(selectedPid); setPreviewOpen(true) }}>生成报表</Button>
        <span style={{ marginLeft: 8 }}>排除孤儿快照</span>
        <Switch checked={excludeOrphanFixedSnapshots} onChange={setExcludeOrphanFixedSnapshots as any} />
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
          expandedRowRender: (r: any) => {
            const mStart = dayjs(r.month, 'MM/YYYY').startOf('month')
            const segsRaw: any[] = monthSegments(orders.filter(o => o.property_id===r.pid), mStart)
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
            const sumNet = segs.reduce((s,x)=> s + Number(((x as any).visible_net_income ?? (x as any).net_income ?? 0)), 0)
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
                <Table
                  className={styles.childTable}
                  columns={childColumns as any}
                  dataSource={segs.map(s => ({ key: s.__rid || s.id, check_in: s.checkin, check_out: s.checkout, nights: s.nights, net_rent: ((s as any).visible_net_income ?? (s as any).net_income ?? 0) }))}
                  pagination={false}
                  size="small"
                  tableLayout="fixed"
                  scroll={{ x: 480 }}
                  summary={() => (
                    <Table.Summary>
                      <Table.Summary.Row>
                        <Table.Summary.Cell index={0} colSpan={3}>分段合计净租金</Table.Summary.Cell>
                        <Table.Summary.Cell index={3} align="right"><strong>${fmt2(sumNet)}</strong></Table.Summary.Cell>
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
      <Modal title={period==='month' ? '月度报告' : (period==='year' ? '年度报告' : (period==='fiscal-year' ? '财年报告' : '半年报告'))} open={previewOpen} onCancel={() => setPreviewOpen(false)} footer={<>
        <Button onClick={async () => {
          if (!printRef.current) return
          const style = `
            <style>
              html, body { font-family: 'Times New Roman', Times, serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
              @page { margin: 12mm; size: A4 ${period==='fiscal-year' ? 'landscape' : 'portrait'}; }
              body { width: ${period==='fiscal-year' ? '277mm' : '190mm'}; margin: 0 auto; }
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
        }}>导出PDF</Button>
        <Button type="primary" onClick={async () => {
          if (!printRef.current || !previewPid) return
          if (isMerging) return
          const updateMerge = (percent: number, stage: string, detail?: string) => {
            setMergeUi((prev) => ({ ...prev, open: true, percent: Math.max(0, Math.min(100, Math.round(percent))), status: 'active', stage, detail }))
          }
          const mergeFail = (reason: string, fallback: boolean) => {
            const text = String(reason || '合并下载失败')
            setMergeUi((prev) => ({ ...prev, open: true, percent: 100, status: 'exception', stage: fallback ? '合并失败，已回退下载原报表' : '合并失败', detail: text }))
            message.error(text)
          }
          const mergeSuccess = (detail?: string) => {
            setMergeUi((prev) => ({ ...prev, open: true, percent: 100, status: 'success', stage: '合并完成，开始下载', detail: detail || prev.detail }))
            setTimeout(() => setMergeUi((prev) => ({ ...prev, open: false })), 1200)
          }
          updateMerge(5, '正在生成报表PDF...')
          try {
            const nodeOrig = printRef.current as HTMLElement
            const node = nodeOrig.cloneNode(true) as HTMLElement
            const mmWidth = period==='fiscal-year' ? '277mm' : '190mm'
            const styleEl = document.createElement('style')
            styleEl.innerHTML = `
              html, body { font-family: 'Times New Roman', Times, serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; background:#ffffff; }
              body { margin: 0; }
              .__pdf_root__ { width: ${mmWidth}; margin: 0 auto; }
              table { width: 100%; border-collapse: collapse; }
              th, td { border-bottom: 1px solid #ddd; }
              .landlord-calendar .mz-booking { border-radius: 0; }
              .landlord-calendar .fc-event-start .mz-booking { border-top-left-radius: 8px; border-bottom-left-radius: 8px; }
              .landlord-calendar .fc-event-end .mz-booking { border-top-right-radius: 8px; border-bottom-right-radius: 8px; }
              .landlord-calendar .mz-evt--airbnb .mz-booking { background-color: #FFE4E6 !important; border-color: #FB7185 !important; color: #881337 !important; }
              .landlord-calendar .mz-evt--booking .mz-booking { background-color: #DBEAFE !important; border-color: #60A5FA !important; color: #1E3A8A !important; }
              .landlord-calendar .mz-evt--other .mz-booking { background-color: #F3F4F6 !important; border-color: #9CA3AF !important; color: #111827 !important; }
            `
            const sandbox = document.createElement('div')
            sandbox.style.position = 'fixed'
            sandbox.style.left = '-9999px'
            sandbox.style.top = '0'
            sandbox.style.width = '0'
            sandbox.style.height = '0'
            document.body.appendChild(sandbox)
            sandbox.appendChild(styleEl)
            node.className = `${node.className} __pdf_root__`.trim()
            sandbox.appendChild(node)
            const scaleFactor = 2
            updateMerge(20, '正在渲染页面...')
            const canvas = await html2canvas(node, { scale: scaleFactor, useCORS: true, allowTaint: true, backgroundColor: '#ffffff' })
            try { document.body.removeChild(sandbox) } catch {}
            updateMerge(40, '正在生成PDF分页...')
            const pdf = new jsPDF('p', 'mm', 'a4')
            const pageWidth = pdf.internal.pageSize.getWidth()
            const pageHeight = pdf.internal.pageSize.getHeight()
            const margin = 10
            const contentWidthMm = pageWidth - margin * 2
            const contentHeightMm = pageHeight - margin * 2
            const pxPerMm = canvas.width / contentWidthMm
            const pageContentHeightPx = contentHeightMm * pxPerMm
            const anchors = Array.from(node.querySelectorAll('[data-keep-with-next="true"]')) as HTMLElement[]
            const anchorYs = anchors.map(a => a.offsetTop * scaleFactor).sort((a,b)=>a-b)
            const reserve = 60 * scaleFactor
            let y = 0
            while (y < canvas.height) {
              let sliceHeightPx = Math.min(pageContentHeightPx, canvas.height - y)
              const endCandidate = y + sliceHeightPx
              const near = anchorYs.find(pos => pos > y && pos <= endCandidate && (endCandidate - pos) < reserve)
              if (near) sliceHeightPx = Math.max(10, near - y)
              const sliceCanvas = document.createElement('canvas')
              sliceCanvas.width = canvas.width
              sliceCanvas.height = sliceHeightPx
              const ctx = sliceCanvas.getContext('2d')!
              ctx.drawImage(canvas, 0, y, canvas.width, sliceHeightPx, 0, 0, canvas.width, sliceHeightPx)
              const sliceImg = sliceCanvas.toDataURL('image/jpeg', 0.82)
              const sliceHeightMm = sliceHeightPx / pxPerMm
              if (y === 0) {
                pdf.addImage(sliceImg, 'JPEG', margin, margin, contentWidthMm, sliceHeightMm)
              } else {
                pdf.addPage()
                pdf.addImage(sliceImg, 'JPEG', margin, margin, contentWidthMm, sliceHeightMm)
              }
              y += sliceHeightPx
            }
            updateMerge(55, '正在准备合并附件...')
            const statementBlob = pdf.output('blob') as Blob
            const prop = properties.find(p => String(p.id) === String(previewPid || ''))
            const codeLabel = (prop?.code || prop?.address || String(previewPid || '')).toString().trim()
            const filename = `Monthly Statement - ${month.format('YYYY-MM')}${codeLabel ? ' - ' + codeLabel : ''}.pdf`
            const downloadBlob = (blob: Blob) => {
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
              downloadBlob(blob)
              mergeSuccess(`附件数：${invUrls.length}`)
            } catch (e: any) {
              mergeFail(e?.message || '合并下载失败', true)
              downloadBlob(statementBlob)
            }
          } catch (e: any) {
            mergeFail(e?.message || '合并下载失败', false)
          }
        }} loading={isMerging} disabled={isMerging}>合并PDF下载</Button>
      </>} width={900}>
        {previewPid ? (
          period==='month' ? (
            <>
              <div style={{ display:'flex', justifyContent:'flex-end', marginBottom: 8 }}>
                <span style={{ marginRight: 8 }}>包含中文说明</span>
                <Switch checked={showChinese} onChange={setShowChinese as any} />
              </div>
              <MonthlyStatementView ref={printRef} month={month.format('YYYY-MM')} propertyId={previewPid || undefined} orders={orders} txs={txs} properties={properties} landlords={landlords} showChinese={showChinese} showInvoices={false} />
            </>
          ) : period==='fiscal-year' ? (
            <FiscalYearStatement ref={printRef} baseMonth={month} propertyId={previewPid!} orders={orders} txs={txs} properties={properties} landlords={landlords} />
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
      <Modal title="合并PDF下载" open={mergeUi.open} onCancel={() => setMergeUi((prev) => ({ ...prev, open: false }))} footer={<>
        <Button onClick={() => setMergeUi((prev) => ({ ...prev, open: false }))}>{mergeUi.status === 'active' ? '隐藏' : '关闭'}</Button>
      </>} width={520} maskClosable={mergeUi.status !== 'active'} keyboard={mergeUi.status !== 'active'} closable={mergeUi.status !== 'active'}>
        <div style={{ marginBottom: 8, fontWeight: 600 }}>{mergeUi.stage || '处理中...'}</div>
        <Progress percent={mergeUi.percent || 0} status={mergeUi.status === 'active' ? 'active' : (mergeUi.status === 'success' ? 'success' : 'exception')} />
        {mergeUi.detail ? <div style={{ marginTop: 8, color: mergeUi.status === 'exception' ? '#cf1322' : 'rgba(0,0,0,0.65)' }}>{mergeUi.detail}</div> : null}
        {mergeUi.status === 'active' ? <div style={{ marginTop: 8, color: 'rgba(0,0,0,0.45)' }}>请勿关闭页面，合并完成后会自动触发下载。</div> : null}
      </Modal>
    </Card>
  )
}
