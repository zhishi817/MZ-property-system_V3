import { isVoidedTx, normalizeReportCategory } from './financeTx'

export type StatementTxKind = 'income' | 'expense'

export type StatementTx = {
  id: string
  kind: StatementTxKind
  amount: number
  currency: string
  property_id?: string
  property_code?: string
  occurred_at: string
  category?: string
  report_category?: string
  category_detail?: string
  note?: string
  pay_method?: string
  pay_other_note?: string
  fixed_expense_id?: string
  month_key?: string
  due_date?: string
  status?: string
  ref_type?: string
  ref_id?: string
  source_title?: string
  source_summary?: any
  invoice_url?: string
  vendor_name?: string
}

export type BuildStatementTxContext = {
  properties: { id: string; code?: string }[]
  recurring_payments?: any[]
  excludeOrphanFixedSnapshots?: boolean
}

export type BuildStatementTxsResult = {
  txs: StatementTx[]
  orphanRows: any[]
  orphanCount: number
  orphanTotal: number
}

function normalizeStatementCategory(c?: any): string {
  const v = String(c || '')
  if (v === 'gas_hot_water') return 'gas'
  if (v === 'consumables') return 'consumable'
  if (v === 'owners_corp') return 'property_fee'
  if (v === 'council_rate') return 'council'
  const vl = v.toLowerCase()
  if (vl === 'nbn' || vl === 'internet' || v.includes('网')) return 'internet'
  return v
}

function toReportCat(raw?: any): string {
  const v = String(raw || '').toLowerCase()
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

function isSnapshotOfRecurringFixedExpense(r: any): boolean {
  const genFrom = String(r?.generated_from || '')
  const note = String(r?.note || '')
  return genFrom === 'recurring_payments' || /^fixed payment/i.test(note)
}

function buildRecurringMaps(recurs: any[] | undefined): {
  reportById: Record<string, string>
  vendorById: Record<string, string>
  recurringIdSet: Set<string>
} {
  const arr = Array.isArray(recurs) ? recurs : []
  const reportById: Record<string, string> = {}
  const vendorById: Record<string, string> = {}
  const recurringIdSet = new Set<string>()
  for (const r of arr) {
    const id = String((r as any)?.id || '')
    if (!id) continue
    recurringIdSet.add(id)
    reportById[id] = String((r as any)?.report_category || '')
    vendorById[id] = String((r as any)?.vendor || '')
  }
  return { reportById, vendorById, recurringIdSet }
}

function normalizePropertyId(raw: any, properties: { id: string; code?: string }[]): { property_id?: string; property_code?: string } {
  const pidRaw = raw?.property_id ? String(raw.property_id) : ''
  if (pidRaw && properties.some(pp => pp.id === pidRaw)) return { property_id: pidRaw }
  const code = String(raw?.property_code || '').trim()
  if (!code) return pidRaw ? { property_id: pidRaw } : {}
  const match = properties.find(pp => String(pp.code || '').trim() === code)
  if (match?.id) return { property_id: match.id, property_code: code }
  return pidRaw ? { property_id: pidRaw, property_code: code } : { property_code: code }
}

export function mapTxForStatement(rawTx: any, ctx: BuildStatementTxContext): StatementTx | null {
  if (!rawTx) return null
  const kindRaw = String(rawTx.kind || '').trim().toLowerCase()
  if (kindRaw !== 'income' && kindRaw !== 'expense') {
    if (rawTx.amount !== undefined && rawTx.occurred_at && (rawTx.category !== undefined || rawTx.category_detail !== undefined)) {
      const guess: StatementTxKind = rawTx.fixed_expense_id || rawTx.property_code || rawTx.due_date ? 'expense' : 'income'
      return mapTxForStatement({ ...rawTx, kind: guess }, ctx)
    }
    return null
  }
  const kind = kindRaw as StatementTxKind
  const id = String(rawTx.id || '').trim()
  if (!id) return null
  const amount0 = Number(rawTx.amount || 0)
  const amount = Number.isFinite(amount0) ? amount0 : 0
  const currency = String(rawTx.currency || 'AUD')
  const occurred_at = String(rawTx.occurred_at || '').trim()
  if (!occurred_at) return null
  const category = normalizeStatementCategory(rawTx.category)
  const { reportById, vendorById } = buildRecurringMaps(ctx.recurring_payments)
  const fixedId = String(rawTx.fixed_expense_id || '').trim()
  const vendor = fixedId ? String(vendorById[fixedId] || '').trim() : ''
  const baseDetail = String(rawTx.category_detail || '').trim()
  const injectedDetail = (!baseDetail && vendor) ? vendor : baseDetail
  const reportCategoryRaw = fixedId ? (reportById[fixedId] || '') : ''
  const report_category = normalizeReportCategory(reportCategoryRaw || toReportCat(rawTx.category || rawTx.category_detail))
  const pid = normalizePropertyId(rawTx, ctx.properties)
  const out: StatementTx = {
    id,
    kind,
    amount,
    currency,
    occurred_at,
    ...(pid.property_id ? { property_id: pid.property_id } : {}),
    ...(pid.property_code ? { property_code: pid.property_code } : {}),
    category,
    report_category,
    ...(injectedDetail ? { category_detail: injectedDetail } : {}),
    ...(rawTx.note ? { note: rawTx.note } : {}),
    ...(rawTx.pay_method ? { pay_method: rawTx.pay_method } : {}),
    ...(rawTx.pay_other_note ? { pay_other_note: rawTx.pay_other_note } : {}),
    ...(fixedId ? { fixed_expense_id: fixedId } : {}),
    ...(rawTx.month_key ? { month_key: rawTx.month_key } : {}),
    ...(rawTx.due_date ? { due_date: rawTx.due_date } : {}),
    ...(rawTx.status ? { status: rawTx.status } : {}),
    ...(rawTx.ref_type ? { ref_type: rawTx.ref_type } : {}),
    ...(rawTx.ref_id ? { ref_id: rawTx.ref_id } : {}),
    ...(rawTx.source_title ? { source_title: rawTx.source_title } : {}),
    ...(rawTx.source_summary ? { source_summary: rawTx.source_summary } : {}),
    ...(rawTx.invoice_url ? { invoice_url: rawTx.invoice_url } : {}),
    ...(rawTx.vendor_name ? { vendor_name: rawTx.vendor_name } : {}),
  }
  return out
}

export function buildStatementTxs(fin: any[], pexp: any[], ctx: BuildStatementTxContext): BuildStatementTxsResult {
  const { recurringIdSet } = buildRecurringMaps(ctx.recurring_payments)
  const excludeOrphans = !!ctx.excludeOrphanFixedSnapshots
  const orphanRows: any[] = []
  let orphanCount = 0
  let orphanTotal = 0

  const peOut: StatementTx[] = []
  for (const r of (Array.isArray(pexp) ? pexp : [])) {
    if (isVoidedTx(r)) continue
    const fid = String((r as any)?.fixed_expense_id || '').trim()
    const isSnapshot = fid ? isSnapshotOfRecurringFixedExpense(r) : false
    const isOrphanSnapshot = !!(fid && isSnapshot && !recurringIdSet.has(fid))
    if (isOrphanSnapshot) {
      orphanCount += 1
      const a0 = Number((r as any)?.amount || 0)
      orphanTotal += Number.isFinite(a0) ? a0 : 0
      if (orphanRows.length < 50) orphanRows.push(r)
      if (excludeOrphans) continue
    }
    const mapped = mapTxForStatement({ ...(r as any), kind: 'expense' }, ctx)
    if (mapped) peOut.push(mapped)
  }

  const finOut: StatementTx[] = []
  for (const t of (Array.isArray(fin) ? fin : [])) {
    const mapped = mapTxForStatement(t, ctx)
    if (mapped) finOut.push(mapped)
  }

  return { txs: [...finOut, ...peOut], orphanRows, orphanCount, orphanTotal }
}
