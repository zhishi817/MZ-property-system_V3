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

export type MonthlyStatementBalanceDebugMonth = MonthlyStatementBalanceResult & {
  carry_source_kind: 'none' | 'prior_operating_loss' | 'furniture_outstanding' | 'mixed'
  contributing_order_ids: string[]
  contributing_income_tx_ids: string[]
  contributing_expense_tx_ids: string[]
  contributing_furniture_charge_tx_ids: string[]
  contributing_furniture_owner_paid_tx_ids: string[]
  operating_entries: Array<{
    id: string
    source: 'opening_carry' | 'order_rent' | 'income_tx' | 'expense_tx' | 'management_fee'
    date: string
    signed_amount: number
    label: string
    ref_type?: string
    ref_id?: string
  }>
  negative_carry_trigger: null | {
    id: string
    source: 'opening_carry' | 'order_rent' | 'income_tx' | 'expense_tx' | 'management_fee'
    date: string
    signed_amount: number
    label: string
    running_before: number
    running_after: number
    ref_type?: string
    ref_id?: string
  }
}

export type MonthlyStatementBalanceDebugResult = {
  result: MonthlyStatementBalanceResult
  months: MonthlyStatementBalanceDebugMonth[]
  target: MonthlyStatementBalanceDebugMonth
  summary: {
    showBalance: boolean
    hasCarry: boolean
    hasFurniture: boolean
    carrySourceKind: 'none' | 'prior_operating_loss' | 'furniture_outstanding' | 'mixed'
    carrySourceLabel: string
  }
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
}): {
  operatingNet: number
  relatedOrders: Order[]
  otherIncomeTxs: Tx[]
  expenseTxs: Tx[]
  managementFee: number
} {
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
  const managementFeeRecorded = sumByCat('management_fee')
  const expenseTxs = expensesOperating.filter(e => catKey(e) !== 'management_fee')

  const managementFee = managementFeeRecorded > 0
    ? round2(managementFeeRecorded)
    : (input.managementFeeRate ? round2(rentIncome * Number(input.managementFeeRate || 0)) : 0)
  const totalExpenseOperating = managementFee + catElectricity + catWater + catGas + catInternet + catConsumable + catCarpark + catOwnerCorp + catCouncil + catOther
  const operatingNet = round2((rentIncome + otherIncome) - totalExpenseOperating)
  return {
    operatingNet,
    relatedOrders,
    otherIncomeTxs: txs
      .filter(t => {
        if (t.kind !== 'income') return false
        if (!txMatchesProperty(t as any, { id: property.id, code: property.code })) return false
        if (!txInMonth(t as any, start)) return false
        if (isFurnitureOwnerPayment(t)) return false
        if (String((t as any).category || '').toLowerCase() === 'late_checkout') return false
        return shouldIncludeIncomeTxInPropertyOtherIncome(t, orderById)
      }),
    expenseTxs,
    managementFee,
  }
}

function calcMonthFurniture(input: {
  monthStart: any
  property: { id: string; code?: string }
  txs: Tx[]
}): { charge: number; ownerPaid: number; chargeTxs: Tx[]; ownerPaidTxs: Tx[] } {
  const start = dayjs(input.monthStart).startOf('month')
  const list = (input.txs || []).filter(t => txMatchesProperty(t as any, { id: input.property.id, code: input.property.code }) && txInMonth(t as any, start))
  const chargeTxs = list.filter(isFurnitureRecoverableCharge)
  const ownerPaidTxs = list.filter(isFurnitureOwnerPayment)
  const charge = chargeTxs.reduce((s, x) => s + Number(x.amount || 0), 0)
  const ownerPaid = ownerPaidTxs.reduce((s, x) => s + Number(x.amount || 0), 0)
  return { charge: round2(charge), ownerPaid: round2(ownerPaid), chargeTxs, ownerPaidTxs }
}

export function computeMonthlyStatementBalance(input: {
  month: string
  propertyId: string
  propertyCode?: string
  orders: Order[]
  txs: Tx[]
  managementFeeRate?: number
  carryStartMonth?: string
}): MonthlyStatementBalanceResult {
  return computeMonthlyStatementBalanceDebug(input).result
}

export function computeMonthlyStatementBalanceDebug(input: {
  month: string
  propertyId: string
  propertyCode?: string
  orders: Order[]
  txs: Tx[]
  managementFeeRate?: number
  carryStartMonth?: string
}): MonthlyStatementBalanceDebugResult {
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
    const dataFirst = list.length ? list[0] : targetStart.format('YYYY-MM')
    const carryStart = /^\d{4}-\d{2}$/.test(String(input.carryStartMonth || '')) ? String(input.carryStartMonth) : ''
    if (!carryStart) return dataFirst
    return carryStart > dataFirst ? carryStart : dataFirst
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
  const months: MonthlyStatementBalanceDebugMonth[] = []

  while (cur.isBefore(targetStart.add(1, 'month'))) {
    const mk = cur.format('YYYY-MM')
    const { operatingNet, relatedOrders, otherIncomeTxs, expenseTxs, managementFee } = calcMonthOperatingNet({
      monthStart: cur,
      property,
      orders: input.orders || [],
      txs: input.txs || [],
      managementFeeRate: input.managementFeeRate,
    })
    const { charge, ownerPaid, chargeTxs, ownerPaidTxs } = calcMonthFurniture({ monthStart: cur, property, txs: input.txs || [] })

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
    const operatingEntries: MonthlyStatementBalanceDebugMonth['operating_entries'] = []
    if (Math.abs(round2(openingCN)) > 0.005) {
      operatingEntries.push({
        id: `carry-in-${mk}`,
        source: 'opening_carry',
        date: `${mk}-01`,
        signed_amount: round2(openingCN),
        label: 'Opening carry-over',
      })
    }
    for (const o of relatedOrders) {
      operatingEntries.push({
        id: String((o as any).__rid || o.id || ''),
        source: 'order_rent',
        date: String(toDayStr((o as any).__src_checkin || o.checkin) || `${mk}-01`),
        signed_amount: round2(Number(((o as any).visible_net_income ?? (o as any).net_income ?? 0) || 0)),
        label: `Order rent ${String((o as any).guest_name || o.id || '')}`.trim(),
      })
    }
    for (const t of otherIncomeTxs) {
      operatingEntries.push({
        id: String(t.id || ''),
        source: 'income_tx',
        date: String(toDayStr((t as any).paid_date || t.occurred_at || (t as any).created_at) || `${mk}-01`),
        signed_amount: round2(Number(t.amount || 0)),
        label: `Income ${String(t.category || t.category_detail || t.note || t.id || '')}`.trim(),
        ref_type: String((t as any).ref_type || '') || undefined,
        ref_id: String((t as any).ref_id || '') || undefined,
      })
    }
    if (Math.abs(round2(managementFee)) > 0.005) {
      operatingEntries.push({
        id: `management-fee-${mk}`,
        source: 'management_fee',
        date: `${mk}-28`,
        signed_amount: round2(-managementFee),
        label: 'Management fee',
      })
    }
    for (const t of expenseTxs) {
      operatingEntries.push({
        id: String(t.id || ''),
        source: 'expense_tx',
        date: String(toDayStr((t as any).paid_date || t.occurred_at || (t as any).created_at) || `${mk}-01`),
        signed_amount: round2(-Number(t.amount || 0)),
        label: `Expense ${String(t.category || t.category_detail || t.note || t.id || '')}`.trim(),
        ref_type: String((t as any).ref_type || '') || undefined,
        ref_id: String((t as any).ref_id || '') || undefined,
      })
    }
    operatingEntries.sort((a, b) => a.date.localeCompare(b.date) || a.source.localeCompare(b.source) || a.id.localeCompare(b.id))
    let running = 0
    let negativeCarryTrigger: MonthlyStatementBalanceDebugMonth['negative_carry_trigger'] = null
    for (const entry of operatingEntries) {
      const before = round2(running)
      const after = round2(before + Number(entry.signed_amount || 0))
      if (!negativeCarryTrigger && before >= 0 && after < 0) {
        negativeCarryTrigger = {
          ...entry,
          running_before: before,
          running_after: after,
        }
      }
      running = after
    }
    const monthResult: MonthlyStatementBalanceDebugMonth = {
      month: mk,
      operating_net_income: round2(operatingNet),
      opening_carry_net: round2(openingCN),
      closing_carry_net: round2(newCarryNet),
      furniture_opening_outstanding: round2(openingFO),
      furniture_charge: round2(charge),
      furniture_owner_paid: round2(ownerPaid),
      furniture_offset_from_rent: round2(offset),
      furniture_closing_outstanding: round2(newOutstanding),
      payable_before_furniture: round2(payableBeforeFurniture),
      payable_to_owner: round2(payableToOwner),
      carry_source_kind:
        Math.abs(round2(openingCN)) > 0.005 && Math.abs(round2(openingFO)) > 0.005
          ? 'mixed'
          : Math.abs(round2(openingCN)) > 0.005
            ? 'prior_operating_loss'
            : Math.abs(round2(openingFO)) > 0.005
              ? 'furniture_outstanding'
              : 'none',
      contributing_order_ids: relatedOrders.map(o => String((o as any).__rid || o.id || '')).filter(Boolean),
      contributing_income_tx_ids: otherIncomeTxs.map(t => String(t.id || '')).filter(Boolean),
      contributing_expense_tx_ids: expenseTxs.map(t => String(t.id || '')).filter(Boolean),
      contributing_furniture_charge_tx_ids: chargeTxs.map(t => String(t.id || '')).filter(Boolean),
      contributing_furniture_owner_paid_tx_ids: ownerPaidTxs.map(t => String(t.id || '')).filter(Boolean),
      operating_entries: operatingEntries,
      negative_carry_trigger: negativeCarryTrigger,
    }
    months.push(monthResult)

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

  const result: MonthlyStatementBalanceResult = {
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
  const target = months.find(x => x.month === monthKey) || {
    ...result,
    carry_source_kind: 'none' as const,
    contributing_order_ids: [],
    contributing_income_tx_ids: [],
    contributing_expense_tx_ids: [],
    contributing_furniture_charge_tx_ids: [],
    contributing_furniture_owner_paid_tx_ids: [],
    operating_entries: [],
    negative_carry_trigger: null,
  }
  const hasCarry = [result.opening_carry_net, result.closing_carry_net].some(v => Math.abs(Number(v || 0)) > 0.005)
  const hasFurniture = [
    result.furniture_opening_outstanding,
    result.furniture_charge,
    result.furniture_owner_paid,
    result.furniture_offset_from_rent,
    result.furniture_closing_outstanding,
  ].some(v => Math.abs(Number(v || 0)) > 0.005)
  const carrySourceLabel = (() => {
    if (target.carry_source_kind === 'mixed') return '结转同时来自前序月份负净收入与家具待抵扣余额'
    if (target.carry_source_kind === 'prior_operating_loss') return '结转来自前序月份累计负净收入'
    if (target.carry_source_kind === 'furniture_outstanding') return '应付金额变化来自家具待抵扣余额'
    if (hasCarry) return '本月结转来自前序月份累计负净收入'
    if (hasFurniture) return '本月没有净收入结转，但存在家具待抵扣余额'
    return '本月没有结转或家具抵扣'
  })()
  return {
    result,
    months,
    target,
    summary: {
      showBalance: hasCarry || hasFurniture,
      hasCarry,
      hasFurniture,
      carrySourceKind: target.carry_source_kind,
      carrySourceLabel,
    },
  }
}
