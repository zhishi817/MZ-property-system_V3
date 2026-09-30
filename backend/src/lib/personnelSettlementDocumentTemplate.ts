export type PersonnelSettlementDocumentStage = 'awaiting_confirmation' | 'confirmed' | 'finance_approved' | 'paid'
export type PersonnelSettlementDocumentKind = 'settlement_draft' | 'tax_invoice' | 'invoice'

export const PERSONNEL_SETTLEMENT_DOCUMENT_TEMPLATE_VERSION = 'daily-summary-invoice-v1'

export type PersonnelSettlementDocumentInput = {
  documentStage: PersonnelSettlementDocumentStage
  documentKind: PersonnelSettlementDocumentKind
  invoiceNumber: string | null
  issueDate: string
  weekStart: string
  weekEnd: string
  currency: 'AUD'
  supplier: { legal_name: string; business_name?: string | null; abn: string; gst_registered: boolean }
  buyer: { legal_name: string; trading_name?: string | null; abn: string; address: string }
  lines: Array<{
    service_date: string
    component_type?: string | null
    property_id?: string | null
    property_label?: string | null
    description: string
    quantity_numerator: number
    quantity_denominator: number
    unit_rate_cents: number
    subtotal_cents: number
    gst_cents: number
    total_cents: number
  }>
  totals: { subtotal_cents: number; gst_cents: number; total_cents: number }
  confirmedAt?: string | null
  paidAt?: string | null
  paymentReference?: string | null
}

function escapeHtml(value: unknown) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function money(cents: number) {
  return new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(Number(cents || 0) / 100)
}

const COMPONENT_LABELS: Record<string, string> = {
  inspection_day: 'Inspection',
  warehouse_hour: 'Warehouse',
  trial_task: 'Trial shift',
  trial_day: 'Trial shift',
  trial_hour: 'Trial shift',
  external_task: 'External work',
  external_day: 'External work',
  external_hour: 'External work',
  weekly_fixed: 'Weekly fee',
  subsidy_amount: 'Subsidy',
  overtime_hour: 'Overtime',
  new_property_task: 'New property setup',
  custom_amount: 'Other',
  finance_adjustment: 'Adjustment',
}

type PersonnelSettlementDocumentLine = PersonnelSettlementDocumentInput['lines'][number]

export type PersonnelSettlementDailySummary = {
  service_date: string
  description: string
  subtotal_cents: number
  gst_cents: number
  total_cents: number
}

function cleanText(value: unknown) {
  return String(value ?? '').trim()
}

function isCleaningLine(line: PersonnelSettlementDocumentLine) {
  return cleanText(line.component_type) === 'cleaning_task' || /^cleaning(?:\s|[·:-]|$)/i.test(cleanText(line.description))
}

function cleaningPropertyLabel(line: PersonnelSettlementDocumentLine) {
  const frozenLabel = cleanText(line.property_label)
  if (frozenLabel) return frozenLabel
  const parts = cleanText(line.description).split(/\s*·\s*/).filter(Boolean)
  if (/^cleaning(?:\s+task)?$/i.test(parts[0] || '') && parts[1]) return parts[1]
  return ''
}

function lineDescription(line: PersonnelSettlementDocumentLine) {
  const raw = cleanText(line.description)
  const componentType = cleanText(line.component_type)
  const label = COMPONENT_LABELS[componentType]
    || componentType.replace(/_/g, ' ').replace(/^./, (value) => value.toUpperCase())
    || 'Other'
  if (!raw || raw === componentType) return label
  const normalizedRaw = raw.toLocaleLowerCase('en-AU')
  const normalizedLabel = label.toLocaleLowerCase('en-AU')
  if (normalizedRaw === normalizedLabel || normalizedRaw.startsWith(`${normalizedLabel} -`)
    || normalizedRaw.startsWith(`${normalizedLabel} ·`) || normalizedRaw.startsWith(`${normalizedLabel}:`)
    || normalizedRaw.startsWith(`${normalizedLabel} `)) return raw
  return `${label} - ${raw}`
}

function appendCountedDescription(target: Map<string, number>, value: string) {
  const clean = cleanText(value)
  if (!clean) return
  target.set(clean, (target.get(clean) || 0) + 1)
}

function countedDescriptions(values: Map<string, number>) {
  return Array.from(values.entries()).map(([value, count]) => count > 1 ? `${value} ×${count}` : value)
}

export function summarizePersonnelSettlementDocumentLines(
  lines: PersonnelSettlementDocumentInput['lines'],
): PersonnelSettlementDailySummary[] {
  const days = new Map<string, {
    cleaningProperties: Map<string, number>
    unlabelledCleaningCount: number
    descriptions: Map<string, number>
    subtotal_cents: number
    gst_cents: number
    total_cents: number
  }>()
  for (const line of lines) {
    const serviceDate = cleanText(line.service_date)
    const day = days.get(serviceDate) || {
      cleaningProperties: new Map<string, number>(),
      unlabelledCleaningCount: 0,
      descriptions: new Map<string, number>(),
      subtotal_cents: 0,
      gst_cents: 0,
      total_cents: 0,
    }
    if (isCleaningLine(line)) {
      const propertyLabel = cleaningPropertyLabel(line)
      if (propertyLabel) appendCountedDescription(day.cleaningProperties, propertyLabel)
      else day.unlabelledCleaningCount += 1
    } else {
      appendCountedDescription(day.descriptions, lineDescription(line))
    }
    day.subtotal_cents += Number(line.subtotal_cents || 0)
    day.gst_cents += Number(line.gst_cents || 0)
    day.total_cents += Number(line.total_cents || 0)
    days.set(serviceDate, day)
  }
  return Array.from(days.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([serviceDate, day]) => {
      const descriptions: string[] = []
      const properties = countedDescriptions(day.cleaningProperties)
      if (properties.length) descriptions.push(`Cleaning - ${properties.join(' / ')}`)
      if (day.unlabelledCleaningCount) {
        descriptions.push(day.unlabelledCleaningCount > 1 ? `Cleaning ×${day.unlabelledCleaningCount}` : 'Cleaning')
      }
      descriptions.push(...countedDescriptions(day.descriptions))
      return {
        service_date: serviceDate,
        description: descriptions.join('; '),
        subtotal_cents: day.subtotal_cents,
        gst_cents: day.gst_cents,
        total_cents: day.total_cents,
      }
    })
}

function timestamp(value: string) {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return new Intl.DateTimeFormat('en-AU', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Australia/Melbourne',
  }).format(parsed)
}

export function resolvePersonnelSettlementDocumentKind(gstRegistered: boolean, stage: PersonnelSettlementDocumentStage): PersonnelSettlementDocumentKind {
  if (stage === 'awaiting_confirmation') return 'settlement_draft'
  return gstRegistered ? 'tax_invoice' : 'invoice'
}

export function renderPersonnelSettlementDocumentHtml(input: PersonnelSettlementDocumentInput) {
  const draft = input.documentKind === 'settlement_draft'
  const title = draft ? 'Weekly Settlement Draft' : input.documentKind === 'tax_invoice' ? 'Tax Invoice' : 'Invoice'
  const statusLabel = ({
    awaiting_confirmation: 'Awaiting supplier confirmation',
    confirmed: 'Workload and amount confirmed',
    finance_approved: 'Approved for payment',
    paid: 'Paid',
  } as const)[input.documentStage]
  const dailySummaries = summarizePersonnelSettlementDocumentLines(input.lines)
  const rows = dailySummaries.map((line) => `
    <tr>
      <td>${escapeHtml(line.service_date)}</td>
      <td>${escapeHtml(line.description)}</td>
      <td class="num">${escapeHtml(money(line.total_cents))}</td>
    </tr>`).join('')
  const supplierName = input.supplier.business_name || input.supplier.legal_name
  const confirmation = input.confirmedAt ? `Confirmed: ${escapeHtml(timestamp(input.confirmedAt))}` : 'Confirmation pending'
  const payment = input.documentStage === 'paid'
    ? `<div class="payment">Paid: ${escapeHtml(input.paidAt ? timestamp(input.paidAt) : '')}${input.paymentReference ? ` · Reference: ${escapeHtml(input.paymentReference)}` : ''}</div>`
    : ''
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  @page { size: A4; margin: 16mm; }
  * { box-sizing: border-box; }
  body { margin: 0; color: #172033; font: 12px -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans CJK SC", Arial, sans-serif; }
  .top { display:flex; justify-content:space-between; align-items:flex-start; border-bottom:3px solid #172033; padding-bottom:14px; }
  h1 { margin:0; font-size:28px; letter-spacing:.4px; }
  .draft { margin-top:8px; padding:8px 10px; border:2px solid #b45309; color:#92400e; background:#fffbeb; font-weight:700; }
  .status { margin-top:8px; color:#475569; }
  .invoice-no { text-align:right; line-height:1.7; }
  .parties { display:grid; grid-template-columns:1fr 1fr; gap:18px; margin:20px 0; }
  .party { border:1px solid #d9dee8; border-radius:8px; padding:12px; min-height:110px; }
  .party h2 { margin:0 0 8px; font-size:12px; text-transform:uppercase; color:#64748b; }
  .name { font-size:16px; font-weight:700; margin-bottom:6px; }
  table { width:100%; border-collapse:collapse; table-layout:fixed; margin-top:12px; }
  th { background:#172033; color:white; text-align:left; padding:8px 6px; }
  td { border-bottom:1px solid #e5e7eb; padding:8px 6px; vertical-align:top; }
  th:first-child, td:first-child { width:105px; white-space:nowrap; }
  th:last-child, td:last-child { width:105px; }
  tbody tr { break-inside:avoid; page-break-inside:avoid; }
  .num { text-align:right; white-space:nowrap; }
  .totals { width:310px; margin:18px 0 0 auto; }
  .total-row { display:flex; justify-content:space-between; padding:6px 0; }
  .grand { border-top:2px solid #172033; margin-top:4px; padding-top:9px; font-size:17px; font-weight:800; }
  .foot { margin-top:28px; border-top:1px solid #d9dee8; padding-top:12px; color:#475569; line-height:1.6; }
  .payment { margin-top:8px; color:#166534; font-weight:700; }
</style></head><body>
  <div class="top"><div><h1>${escapeHtml(title)}</h1><div class="status">${escapeHtml(statusLabel)}</div>${draft ? '<div class="draft">待本人确认 · NOT A TAX INVOICE</div>' : ''}</div>
  <div class="invoice-no"><strong>${draft ? 'Settlement reference' : 'Invoice number'}</strong><br>${escapeHtml(input.invoiceNumber || `DRAFT-${input.weekEnd}`)}<br><strong>Issue date</strong><br>${escapeHtml(input.issueDate)}</div></div>
  <div class="parties">
    <div class="party"><h2>Supplier / 服务提供方</h2><div class="name">${escapeHtml(supplierName)}</div><div>${escapeHtml(input.supplier.legal_name)}</div><div>ABN ${escapeHtml(input.supplier.abn)}</div><div>GST: ${input.supplier.gst_registered ? 'Registered' : 'Not registered'}</div></div>
    <div class="party"><h2>Bill to / 付款方</h2><div class="name">${escapeHtml(input.buyer.trading_name || input.buyer.legal_name)}</div><div>${escapeHtml(input.buyer.legal_name)}</div><div>ABN ${escapeHtml(input.buyer.abn)}</div><div>${escapeHtml(input.buyer.address)}</div></div>
  </div>
  <div><strong>Service period:</strong> ${escapeHtml(input.weekStart)} to ${escapeHtml(input.weekEnd)}</div>
  <table><thead><tr><th>Date</th><th>Description</th><th class="num">Total</th></tr></thead><tbody>${rows}</tbody></table>
  <div class="totals"><div class="total-row"><span>Subtotal</span><span>${escapeHtml(money(input.totals.subtotal_cents))}</span></div><div class="total-row"><span>GST</span><span>${escapeHtml(money(input.totals.gst_cents))}</span></div><div class="total-row grand"><span>Total ${escapeHtml(input.currency)}</span><span>${escapeHtml(money(input.totals.total_cents))}</span></div></div>
  <div class="foot">${confirmation}<br>This document was prepared by Homixa on behalf of the supplier from the locked weekly settlement record.${draft ? '<br>It is a review draft only and cannot be used as a tax invoice.' : ''}${payment}</div>
</body></html>`
}
