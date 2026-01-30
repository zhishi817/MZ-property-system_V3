import dayjs from 'dayjs'
import { toDayStr } from './orders'

export type OrderIncomeFlag = { id: string; status?: string; count_in_income?: boolean }
export type IncomeTxLike = { category?: string; ref_type?: string; ref_id?: string }
export type TxDateLike = { occurred_at?: string; paid_date?: string; due_date?: string; created_at?: string; month_key?: string }

export function normalizeReportCategory(raw?: any) {
  const v = String(raw || '').toLowerCase()
  if (!v) return 'other'
  if (v === 'parking_fee' || v === 'carpark' || v.includes('车位')) return 'parking_fee'
  if (v === 'management_fee' || v.includes('management') || v.includes('管理费')) return 'management_fee'
  if (v === 'body_corp' || v === 'bodycorp' || v === 'owners_corp' || v === 'ownerscorp' || v === 'property_fee' || v.includes('物业')) return 'body_corp'
  if (v === 'internet' || v.includes('internet') || v === 'nbn' || v.includes('网')) return 'internet'
  if (v === 'electricity' || v.includes('electric') || v.includes('电')) return 'electricity'
  if (v === 'water' || ((v.includes('water') || v.includes('水')) && !v.includes('热'))) return 'water'
  if (v === 'gas' || v === 'gas_hot_water' || v === 'hot_water' || v.includes('gas') || v.includes('热水') || v.includes('煤气')) return 'gas'
  if (v === 'consumables' || v === 'consumable' || v.includes('consumable') || v.includes('消耗')) return 'consumables'
  if (v === 'council' || v === 'council_rate' || v.includes('council') || v.includes('市政')) return 'council'
  if (v === 'other' || v.includes('其他')) return 'other'
  return 'other'
}

export function shouldIncludeIncomeTxInPropertyOtherIncome(tx: IncomeTxLike, orderById: Map<string, OrderIncomeFlag>) {
  const cat = String(tx.category || '').toLowerCase()
  if (cat !== 'cancel_fee') return true
  if (String(tx.ref_type || '') !== 'order') return true
  const oid = String(tx.ref_id || '')
  if (!oid) return true
  const o = orderById.get(oid)
  const st = String(o?.status || '').toLowerCase()
  const isCanceled = st.includes('cancel')
  return (!isCanceled) || !!o?.count_in_income
}

export function txInMonth(tx: TxDateLike, monthStart: any) {
  const mk = String((tx as any).month_key || '')
  if (/^\d{4}-\d{2}$/.test(mk)) return mk === dayjs(monthStart).format('YYYY-MM')
  const raw: any = (tx as any).paid_date || (tx as any).occurred_at || (tx as any).due_date || (tx as any).created_at
  const d = toDayStr(raw)
  if (!d) return false
  return dayjs(d).isSame(dayjs(monthStart), 'month')
}

export function txMatchesProperty(tx: any, property: { id?: string; code?: string }) {
  const txPid = String((tx as any)?.property_id || '').trim()
  const txCode = String((tx as any)?.property_code || '').trim()
  const pid = String(property?.id || '').trim()
  const code = String(property?.code || '').trim()
  const a = txPid.toLowerCase()
  const b = txCode.toLowerCase()
  const p = pid.toLowerCase()
  const c = code.toLowerCase()
  if (a && p && a === p) return true
  if (a && c && a === c) return true
  if (b && c && b === c) return true
  return false
}
