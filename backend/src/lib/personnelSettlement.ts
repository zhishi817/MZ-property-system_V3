export const PERSONNEL_SETTLEMENT_TIMEZONE = 'Australia/Melbourne'
export const PERSONNEL_SETTLEMENT_CALCULATION_VERSION = 'phase7-checkout-cleaning-v1'

export const CLEANING_PROPERTY_TYPES = [
  '一房一卫',
  '两房一卫',
  '两房两卫',
  '三房两卫',
  '三房三卫',
  '4房3.5卫',
] as const

export type CleaningPropertyType = typeof CLEANING_PROPERTY_TYPES[number]

export type SettlementPriceBasis = 'exclusive_gst' | 'inclusive_gst'

export type SettlementComponentType =
  | 'cleaning_task'
  | 'inspection_day'
  | 'warehouse_hour'
  | 'trial_task'
  | 'trial_day'
  | 'trial_hour'
  | 'external_task'
  | 'external_day'
  | 'external_hour'
  | 'weekly_fixed'
  | 'subsidy_amount'
  | 'overtime_hour'
  | 'new_property_task'
  | 'custom_amount'

export type SettlementRuleItem = {
  id: string
  rule_id: string
  component_type: SettlementComponentType
  property_id?: string | null
  task_type?: string | null
  conditions?: {
    property_type?: string | null
  }
  priority: number
  rate_cents: number
}

export type SettlementLineCalculationInput = {
  quantity_numerator: number
  quantity_denominator: number
  unit_rate_cents: number
  price_basis: SettlementPriceBasis
  gst_registered: boolean
}

export type SettlementLineAmounts = {
  subtotal_cents: number
  gst_cents: number
  total_cents: number
}

export type SettlementPeriod = {
  week_start: string
  week_end: string
  timezone: typeof PERSONNEL_SETTLEMENT_TIMEZONE
}

export type WorkloadAuditCandidate = {
  audit_id: string
  task_id: string
  user_id: string
  performed_by_name: string | null
  action: string
  performed_at: string
  service_date: string
  property_id: string | null
  property_label: string | null
  property_type: string | null
  task_type: string | null
  task_status: string | null
  status_after: string | null
  metadata: Record<string, unknown>
}

export type CandidateDecision = {
  eligibility: 'eligible' | 'excluded' | 'manual_review'
  component_type: 'cleaning_task' | 'inspection_day' | null
  reason: string
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/
const DONE_CLEANING_STATUSES = new Set([
  'cleaned',
  'restock_pending',
  'restocked',
  'to_inspect',
  'to_hang_keys',
  'keys_hung',
  'inspected',
  'ready',
  'completed',
  'done',
])
const DONE_INSPECTION_STATUSES = new Set([
  'inspected',
  'to_hang_keys',
  'keys_hung',
  'ready',
  'completed',
  'done',
])

function cleanText(value: unknown) {
  return String(value ?? '').trim()
}

function assertSafeNonNegativeInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name}_must_be_non_negative_safe_integer`)
}

function roundRatioHalfUp(numerator: number, denominator: number) {
  assertSafeNonNegativeInteger(numerator, 'numerator')
  assertSafeNonNegativeInteger(denominator, 'denominator')
  if (denominator === 0) throw new Error('denominator_must_be_positive')
  return Math.floor((numerator + Math.floor(denominator / 2)) / denominator)
}

export function addSettlementDays(date: string, days: number) {
  const match = DATE_ONLY.exec(date)
  if (!match) throw new Error('invalid_week_start')
  const value = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  if (
    value.getUTCFullYear() !== Number(match[1])
    || value.getUTCMonth() !== Number(match[2]) - 1
    || value.getUTCDate() !== Number(match[3])
  ) throw new Error('invalid_week_start')
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

export function buildSettlementPeriod(weekStart: string): SettlementPeriod {
  const normalized = cleanText(weekStart)
  const match = DATE_ONLY.exec(normalized)
  if (!match) throw new Error('invalid_week_start')
  const utc = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  if (utc.toISOString().slice(0, 10) !== normalized || utc.getUTCDay() !== 1) {
    throw new Error('week_start_must_be_monday')
  }
  return {
    week_start: normalized,
    week_end: addSettlementDays(normalized, 6),
    timezone: PERSONNEL_SETTLEMENT_TIMEZONE,
  }
}

export function getSettlementWeekStart(serviceDate: string) {
  const normalized = cleanText(serviceDate)
  const match = DATE_ONLY.exec(normalized)
  if (!match) throw new Error('invalid_service_date')
  const utc = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  if (utc.toISOString().slice(0, 10) !== normalized) throw new Error('invalid_service_date')
  const daysSinceMonday = (utc.getUTCDay() + 6) % 7
  return addSettlementDays(normalized, -daysSinceMonday)
}

export function getMelbourneDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: PERSONNEL_SETTLEMENT_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${byType.year}-${byType.month}-${byType.day}`
}

export function calculateSettlementLine(input: SettlementLineCalculationInput): SettlementLineAmounts {
  assertSafeNonNegativeInteger(input.quantity_numerator, 'quantity_numerator')
  assertSafeNonNegativeInteger(input.quantity_denominator, 'quantity_denominator')
  assertSafeNonNegativeInteger(input.unit_rate_cents, 'unit_rate_cents')
  if (input.quantity_denominator === 0) throw new Error('quantity_denominator_must_be_positive')

  const pricedAmount = roundRatioHalfUp(
    input.unit_rate_cents * input.quantity_numerator,
    input.quantity_denominator,
  )
  if (!Number.isSafeInteger(pricedAmount)) throw new Error('calculated_amount_out_of_range')

  if (!input.gst_registered) {
    return { subtotal_cents: pricedAmount, gst_cents: 0, total_cents: pricedAmount }
  }
  if (input.price_basis === 'exclusive_gst') {
    const gstCents = roundRatioHalfUp(pricedAmount, 10)
    return { subtotal_cents: pricedAmount, gst_cents: gstCents, total_cents: pricedAmount + gstCents }
  }
  if (input.price_basis === 'inclusive_gst') {
    const gstCents = roundRatioHalfUp(pricedAmount, 11)
    return { subtotal_cents: pricedAmount - gstCents, gst_cents: gstCents, total_cents: pricedAmount }
  }
  throw new Error('invalid_price_basis')
}

export function aggregateSettlementAmounts(lines: SettlementLineAmounts[]): SettlementLineAmounts {
  return lines.reduce<SettlementLineAmounts>((sum, line) => ({
    subtotal_cents: sum.subtotal_cents + line.subtotal_cents,
    gst_cents: sum.gst_cents + line.gst_cents,
    total_cents: sum.total_cents + line.total_cents,
  }), { subtotal_cents: 0, gst_cents: 0, total_cents: 0 })
}

export function classifyWorkloadAudit(candidate: WorkloadAuditCandidate): CandidateDecision {
  const action = cleanText(candidate.action).toLowerCase()
  const statusAfter = cleanText(candidate.status_after).toLowerCase()
  const taskStatus = cleanText(candidate.task_status).toLowerCase()
  const metadata = candidate.metadata || {}
  const metadataStep = cleanText(metadata.step).toLowerCase()
  const metadataRoute = cleanText(metadata.route).toLowerCase()

  if (taskStatus === 'cancelled' || taskStatus === 'canceled') {
    return { eligibility: 'excluded', component_type: null, reason: 'task_cancelled' }
  }
  if (metadataStep === 'completion_photos_saved') {
    return { eligibility: 'excluded', component_type: null, reason: 'completion_photo_only' }
  }
  if (metadataRoute === 'mzapp.cleaning_tasks.restock_proof') {
    return { eligibility: 'excluded', component_type: null, reason: 'restock_proof_only' }
  }
  if (action === 'fill_supplies' || action === 'complete_cleaning') {
    if (!DONE_CLEANING_STATUSES.has(statusAfter)) {
      return { eligibility: 'manual_review', component_type: null, reason: 'cleaning_action_without_done_status' }
    }
    return { eligibility: 'eligible', component_type: 'cleaning_task', reason: 'audited_cleaning_completion' }
  }
  if (action === 'submit_inspection') {
    if (!DONE_INSPECTION_STATUSES.has(statusAfter) && metadata.guest_arrival_skip !== true) {
      return { eligibility: 'manual_review', component_type: null, reason: 'inspection_action_without_submission_status' }
    }
    return { eligibility: 'eligible', component_type: 'inspection_day', reason: 'audited_inspection_submission' }
  }
  return { eligibility: 'excluded', component_type: null, reason: 'unsupported_action' }
}

export function chooseRuleItem(
  items: SettlementRuleItem[],
  componentType: SettlementComponentType,
  propertyId?: string | null,
  taskType?: string | null,
  propertyType?: string | null,
): { item: SettlementRuleItem | null; ambiguous: boolean } {
  const componentItems = items.filter((item) => item.component_type === componentType)
  const matching = componentItems.filter((item) => {
    const propertyMatches = !cleanText(item.property_id) || cleanText(item.property_id) === cleanText(propertyId)
    const taskTypeMatches = !cleanText(item.task_type) || cleanText(item.task_type) === cleanText(taskType)
    const configuredPropertyType = cleanText(item.conditions?.property_type)
    const propertyTypeMatches = componentType === 'cleaning_task'
      ? Boolean(configuredPropertyType) && configuredPropertyType === cleanText(propertyType)
      : !configuredPropertyType || configuredPropertyType === cleanText(propertyType)
    return propertyMatches && taskTypeMatches && propertyTypeMatches
  }).map((item) => ({
    item,
    specificity: Number(Boolean(cleanText(item.property_id)))
      + Number(Boolean(cleanText(item.task_type)))
      + Number(Boolean(cleanText(item.conditions?.property_type))),
  })).sort((a, b) => (
    b.specificity - a.specificity
    || Number(b.item.priority || 0) - Number(a.item.priority || 0)
    || a.item.id.localeCompare(b.item.id)
  ))

  if (!matching.length) return { item: null, ambiguous: false }
  const best = matching[0]
  const ambiguous = matching.slice(1).some((entry) => (
    entry.specificity === best.specificity
    && Number(entry.item.priority || 0) === Number(best.item.priority || 0)
  ))
  return { item: ambiguous ? null : best.item, ambiguous }
}

export function decimalQuantityToRatio(value: unknown): { numerator: number; denominator: number } | null {
  const raw = cleanText(value)
  if (!/^\d+(?:\.\d{1,3})?$/.test(raw)) return null
  const [whole, fraction = ''] = raw.split('.')
  const denominator = 10 ** fraction.length
  const numerator = Number(whole) * denominator + Number(fraction || 0)
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)) return null
  return { numerator, denominator }
}
