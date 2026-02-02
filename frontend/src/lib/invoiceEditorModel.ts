export type GstType = 'GST_10' | 'GST_FREE' | 'INPUT_TAXED'

export type InvoiceLineItemInput = {
  description: string
  quantity: number
  unit_price: number
  gst_type: GstType
}

export type InvoiceTotals = {
  subtotal: number
  tax_total: number
  total: number
  amount_due: number
  amount_paid: number
}

function round2(n: any) {
  const x = Number(n || 0)
  return Math.round(x * 100) / 100
}

export function computeLine(item: { quantity: number; unit_price: number; gst_type: GstType }) {
  const qty = Number(item.quantity || 0)
  const unit = Number(item.unit_price || 0)
  const lineSubtotal = round2(qty * unit)
  let tax = 0
  if (item.gst_type === 'GST_10') tax = round2(lineSubtotal * 0.1)
  const lineTotal = round2(lineSubtotal + tax)
  return { line_subtotal: lineSubtotal, tax_amount: tax, line_total: lineTotal }
}

export function computeTotals(lines: Array<{ line_subtotal: number; tax_amount: number; line_total: number }>, amountPaid: any): InvoiceTotals {
  const subtotal = round2(lines.reduce((s, x) => s + Number(x.line_subtotal || 0), 0))
  const taxTotal = round2(lines.reduce((s, x) => s + Number(x.tax_amount || 0), 0))
  const total = round2(lines.reduce((s, x) => s + Number(x.line_total || 0), 0))
  const paid = round2(amountPaid)
  const due = round2(total - paid)
  return { subtotal, tax_total: taxTotal, total, amount_paid: paid, amount_due: due }
}

export function normalizeLineItemsForSave(params: { user_items: InvoiceLineItemInput[]; discount_amount?: number }) {
  const user = (params.user_items || []).map((x) => ({
    description: String(x.description || '').trim(),
    quantity: Number(x.quantity || 0),
    unit_price: Number(x.unit_price || 0),
    gst_type: x.gst_type as GstType,
  })).filter((x) => x.description)
  const discount = round2(Number(params.discount_amount || 0))
  if (discount > 0) {
    user.push({ description: 'Discount', quantity: 1, unit_price: -discount, gst_type: 'GST_FREE' })
  }
  return user
}

export function extractDiscount(items: Array<{ description?: any; quantity?: any; unit_price?: any; gst_type?: any }>) {
  const list = Array.isArray(items) ? items : []
  const idx = list.findIndex((x) => String(x?.description || '').trim().toLowerCase() === 'discount' && Number(x?.unit_price || 0) < 0)
  if (idx < 0) return { discount_amount: 0, user_items: list }
  const d = round2(Math.abs(Number(list[idx]?.unit_price || 0)))
  const user = list.filter((_, i) => i !== idx)
  return { discount_amount: d, user_items: user }
}

export function canBackendAutosaveDraft(params: { company_id?: any; line_items?: InvoiceLineItemInput[] }) {
  const companyId = String(params.company_id || '').trim()
  if (!companyId) return false
  const items = Array.isArray(params.line_items) ? params.line_items : []
  const ok = items.some((x) => String(x?.description || '').trim().length > 0)
  return ok
}

export function stableHash(obj: any) {
  const s = JSON.stringify(obj, (_k, v) => {
    if (v === undefined) return null
    if (typeof v === 'string') return v.trim()
    if (typeof v === 'number') return Number.isFinite(v) ? round2(v) : 0
    return v
  })
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0
  }
  return String(h)
}

