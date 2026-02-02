import dayjs from 'dayjs'
import { monthSegments, toDayStr } from './orders'
import { shouldIncludeIncomeTxInPropertyOtherIncome, txInMonth, txMatchesProperty } from './financeTx'

type Order = { id: string; property_id?: string; checkin?: string; checkout?: string; price?: number; nights?: number; status?: string; count_in_income?: boolean }
type Tx = {
  id: string
  kind: 'income' | 'expense'
  amount: number
  currency?: string
  property_id?: string
  occurred_at?: string
  paid_date?: string
  due_date?: string
  created_at?: string
  month_key?: string
  category?: string
  category_detail?: string
  note?: string
  ref_type?: string
  ref_id?: string
  report_category?: string
  property_code?: string
}

export type MonthlyStatementBalanceResult = {
  month: string
  operating_net_income: number
  opening_carry_net: number
  closing_carry_net: number
  furniture_opening_outstanding: number
  furniture_charge: number
  furniture_owner_paid: number
  furniture_offset_from_rent: number
  furniture_closing_outstanding: number
  payable_before_furniture: number
  payable_to_owner: number
}

function round2(n: number): number {
  return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100
}

function txMonthKey(tx: Tx): string {
  const mk = String((tx as any)?.month_key || '')
  if (/^\d{4}-\d{2}$/.test(mk)) return mk
  const raw: any = (tx as any)?.paid_date || (tx as any)?.occurred_at || (tx as any)?.due_date || (tx as any)?.created_at
  const d = toDayStr(raw)
  if (!d) return ''
  return dayjs(d).format('YYYY-MM')
}

function normText(...parts: any[]): string {
  return parts
    .map(x => String(x || '').trim())
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

export function isFurnitureRecoverableCharge(tx: Tx): boolean {
  if (tx.kind !== 'expense') return false
  const c = String(tx.category || '').trim().toLowerCase()
  if (c === 'furniture_recoverable' || c === 'recoverable_furniture' || c === 'owner_charge_furniture') return true
  const t = normText(tx.category, tx.category_detail, tx.note, (tx as any).report_category)
  if (t.includes('furniture_recoverable') || t.includes('recoverable_furniture') || t.includes('owner_charge_furniture')) return true
  const hasFurniture = t.includes('furniture') || t.includes('家具')
  const hasRecoverable = t.includes('recoverable') || t.includes('应收') || t.includes('抵扣') || t.includes('扣') || t.includes('房东')
  return hasFurniture && hasRecoverable
}

export function isFurnitureOwnerPayment(tx: Tx): boolean {
  if (tx.kind !== 'income') return false
  const c = String(tx.category || '').trim().toLowerCase()
  if (c === 'furniture_owner_payment' || c === 'owner_payment_furniture' || c === 'furniture_payment_owner') return true
  const t = normText(tx.category, tx.category_detail, tx.note)
  if (t.includes('furniture_owner_payment') || t.includes('owner_payment_furniture') || t.includes('furniture_payment_owner')) return true
  const hasFurniture = t.includes('furniture') || t.includes('家具')
  const hasOwnerPay = t.includes('owner') || t.includes('landlord') || t.includes('房东')
  const hasPaid = t.includes('paid') || t.includes('payment') || t.includes('转') || t.includes('已付') || t.includes('付款')
  return hasFurniture && hasOwnerPay && hasPaid
}

function calcMonthOperatingNet(input: {
  monthStart: any
  property: { id: string; code?: string }
  orders: Order[]
  txs: Tx[]
  managementFeeRate?: number
}): { operatingNet: number } {
  const { monthStart, property, orders, txs } = input
  const start = dayjs(monthStart).startOf('month')

  const relatedOrders = monthSegments(
    orders.filter(o => {
      if (property?.id && o.property_id !== property.id) return false
      const st = String((o as any).status || '').toLowerCase()
      const isCanceled = st.includes('cancel')
      const include = (!isCanceled) || !!(o as any).count_in_income
      return include
    }),
    start
  )

  const rentIncome = relatedOrders.reduce((s, x) => s + Number(((x as any).visible_net_income ?? (x as any).net_income ?? 0)), 0)
  const orderById = new Map((orders || []).map(o => [String(o.id), o]))

  const otherIncome = txs
    .filter(t => {
      if (t.kind !== 'income') return false
      if (!txMatchesProperty(t as any, { id: property.id, code: property.code })) return false
      if (!txInMonth(t as any, start)) return false
      if (isFurnitureOwnerPayment(t)) return false
      if (String((t as any).category || '').toLowerCase() === 'late_checkout') return false
      return shouldIncludeIncomeTxInPropertyOtherIncome(t, orderById)
    })
    .reduce((s, x) => s + Number(x.amount || 0), 0)

  const expensesOperating = txs.filter(t => {
    if (t.kind !== 'expense') return false
    if (!txMatchesProperty(t as any, { id: property.id, code: property.code })) return false
    if (!txInMonth(t as any, start)) return false
    if (isFurnitureRecoverableCharge(t)) return false
    return true
  })

  function catKey(e: any): string {
    const raw = String((e as any).report_category || (e as any).category || '').toLowerCase()
    if (!raw) return 'other'
    if (raw === 'parking_fee') return 'carpark'
    if (raw === 'body_corp' || raw === 'property_fee') return 'property_fee'
    if (raw === 'consumables' || raw === 'consumable') return 'consumable'
    if (raw === 'gas_hot_water') return 'gas'
    if (raw === 'owners_corp') return 'property_fee'
    if (raw === 'council_rate') return 'council'
    if (raw === 'internet' || raw === 'nbn') return 'internet'
    return raw
  }

  const sumByCat = (cat: string) => expensesOperating.filter(e => catKey(e) === cat).reduce((s, x) => s + Number(x.amount || 0), 0)
  const catElectricity = sumByCat('electricity')
  const catWater = sumByCat('water')
  const catGas = sumByCat('gas')
  const catInternet = sumByCat('internet')
  const catConsumable = sumByCat('consumable')
  const catCarpark = sumByCat('carpark')
  const catOwnerCorp = sumByCat('property_fee')
  const catCouncil = sumByCat('council')
  const catOther = sumByCat('other')

  const managementFee = input.managementFeeRate ? round2(rentIncome * Number(input.managementFeeRate || 0)) : 0
  const totalExpenseOperating = managementFee + catElectricity + catWater + catGas + catInternet + catConsumable + catCarpark + catOwnerCorp + catCouncil + catOther
  const operatingNet = round2((rentIncome + otherIncome) - totalExpenseOperating)
  return { operatingNet }
}

function calcMonthFurniture(input: {
  monthStart: any
  property: { id: string; code?: string }
  txs: Tx[]
}): { charge: number; ownerPaid: number } {
  const start = dayjs(input.monthStart).startOf('month')
  const list = (input.txs || []).filter(t => txMatchesProperty(t as any, { id: input.property.id, code: input.property.code }) && txInMonth(t as any, start))
  const charge = list.filter(isFurnitureRecoverableCharge).reduce((s, x) => s + Number(x.amount || 0), 0)
  const ownerPaid = list.filter(isFurnitureOwnerPayment).reduce((s, x) => s + Number(x.amount || 0), 0)
  return { charge: round2(charge), ownerPaid: round2(ownerPaid) }
}

export function computeMonthlyStatementBalance(input: {
  month: string
  propertyId: string
  propertyCode?: string
  orders: Order[]
  txs: Tx[]
  managementFeeRate?: number
}): MonthlyStatementBalanceResult {
  const monthKey = String(input.month || '').trim()
  const targetStart = dayjs(`${monthKey}-01`).startOf('month')
  const property = { id: String(input.propertyId || ''), code: input.propertyCode }

  const monthsWithData: string[] = []
  for (const o of input.orders || []) {
    if (String(o.property_id || '') !== property.id) continue
    const ci = toDayStr((o as any).__src_checkin || o.checkin)
    const co = toDayStr((o as any).__src_checkout || o.checkout)
    if (ci) monthsWithData.push(dayjs(ci).format('YYYY-MM'))
    if (co) monthsWithData.push(dayjs(co).format('YYYY-MM'))
  }
  for (const t of input.txs || []) {
    if (!txMatchesProperty(t as any, { id: property.id, code: property.code })) continue
    const mk = txMonthKey(t)
    if (mk) monthsWithData.push(mk)
  }

  const firstMonth = (() => {
    const list = monthsWithData.filter(m => /^\d{4}-\d{2}$/.test(m)).sort()
    return list.length ? list[0] : targetStart.format('YYYY-MM')
  })()

  let cur = dayjs(`${firstMonth}-01`).startOf('month')
  let carryNet = 0
  let furnitureOutstanding = 0
  let openingCarryNet = 0
  let furnitureOpening = 0
  let operatingNetTarget = 0
  let furnitureChargeTarget = 0
  let furniturePaidTarget = 0
  let payableBeforeFurnitureTarget = 0
  let furnitureOffsetTarget = 0
  let payableTarget = 0
  let closingCarryNet = 0
  let furnitureClosing = 0

  while (cur.isBefore(targetStart.add(1, 'month'))) {
    const mk = cur.format('YYYY-MM')
    const { operatingNet } = calcMonthOperatingNet({
      monthStart: cur,
      property,
      orders: input.orders || [],
      txs: input.txs || [],
      managementFeeRate: input.managementFeeRate,
    })
    const { charge, ownerPaid } = calcMonthFurniture({ monthStart: cur, property, txs: input.txs || [] })

    const openingCN = carryNet
    const openingFO = furnitureOutstanding

    const netAfterCarry = openingCN + operatingNet
    const payableBeforeFurniture = Math.max(0, netAfterCarry)
    const newCarryNet = Math.min(0, netAfterCarry)

    let newOutstanding = round2(openingFO + charge - ownerPaid)
    if (newOutstanding < 0) newOutstanding = 0

    const offset = round2(Math.min(payableBeforeFurniture, newOutstanding))
    const payableToOwner = round2(payableBeforeFurniture - offset)
    newOutstanding = round2(newOutstanding - offset)

    if (mk === monthKey) {
      openingCarryNet = round2(openingCN)
      furnitureOpening = round2(openingFO)
      operatingNetTarget = round2(operatingNet)
      furnitureChargeTarget = round2(charge)
      furniturePaidTarget = round2(ownerPaid)
      payableBeforeFurnitureTarget = round2(payableBeforeFurniture)
      furnitureOffsetTarget = round2(offset)
      payableTarget = round2(payableToOwner)
      closingCarryNet = round2(newCarryNet)
      furnitureClosing = round2(newOutstanding)
    }

    carryNet = newCarryNet
    furnitureOutstanding = newOutstanding
    cur = cur.add(1, 'month').startOf('month')
  }

  return {
    month: monthKey,
    operating_net_income: operatingNetTarget,
    opening_carry_net: openingCarryNet,
    closing_carry_net: closingCarryNet,
    furniture_opening_outstanding: furnitureOpening,
    furniture_charge: furnitureChargeTarget,
    furniture_owner_paid: furniturePaidTarget,
    furniture_offset_from_rent: furnitureOffsetTarget,
    furniture_closing_outstanding: furnitureClosing,
    payable_before_furniture: payableBeforeFurnitureTarget,
    payable_to_owner: payableTarget,
  }
}
