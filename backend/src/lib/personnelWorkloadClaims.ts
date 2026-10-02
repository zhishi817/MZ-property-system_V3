import { randomUUID } from 'crypto'
import { pgPool, pgRunInTransaction } from '../dbAdapter'
import {
  calculateSettlementLine,
  decimalQuantityToRatio,
  getMelbourneDate,
  getSettlementWeekStart,
  type SettlementComponentType,
  type SettlementPriceBasis,
} from './personnelSettlement'
import { assertPersonnelSettlementSchemaReady } from './personnelSettlementSchema'

type Queryable = { query: (sql: string, params?: any[]) => Promise<any> }

export type PersonnelClaimType = Exclude<SettlementComponentType, 'cleaning_task' | 'inspection_day' | 'weekly_fixed'>
export type PersonnelClaimReviewAction = 'approve' | 'return' | 'reject'

export type PersonnelClaimInputMode = 'amount' | 'quantity' | 'day' | 'time_range'
export type PersonnelClaimBusinessType = 'warehouse' | 'overtime' | 'subsidy' | 'new_property' | 'external' | 'custom'

export type PersonnelClaimOption = {
  business_type: PersonnelClaimBusinessType
  claim_type: PersonnelClaimType
  label: string
  calculation_label: string
  input_mode: PersonnelClaimInputMode
  evidence_required: boolean
  property_required: boolean
  rule_configured: boolean
}

export type PersonnelClaimInput = {
  client_request_id?: string | null
  service_date: string
  claim_type: PersonnelClaimType
  property_id?: string | null
  cleaning_task_id?: string | null
  started_at?: string | null
  ended_at?: string | null
  duration_minutes?: number | null
  requested_quantity?: number | string | null
  requested_amount_cents?: number | null
  note: string
}

export type PersonnelClaimReviewInput = {
  action: PersonnelClaimReviewAction
  approved_duration_minutes?: number | null
  approved_quantity?: number | string | null
  approved_amount_cents?: number | null
  review_note?: string | null
}

export type PersonnelClaimEstimateInput = {
  serviceDate: string
  claimType: PersonnelClaimType
  durationMinutes?: number | null
  requestedQuantity?: number | string | null
  requestedAmountCents?: number | null
}

export type PersonnelClaimReviewEstimateInput = {
  claimId: string
  durationMinutes?: number | null
  requestedQuantity?: number | string | null
  requestedAmountCents?: number | null
}

export type PersonnelClaimEstimateRule = {
  ruleId: string | null
  ruleName: string | null
  effectiveFrom: string
  priceBasis: SettlementPriceBasis
  unitRateCents: number | null
  gstStatus: 'unconfirmed' | 'registered' | 'not_registered'
}

const CLAIM_TYPES = new Set<PersonnelClaimType>([
  'warehouse_hour',
  'trial_task', 'trial_day', 'trial_hour',
  'external_task', 'external_day', 'external_hour',
  'subsidy_amount', 'overtime_hour', 'new_property_task', 'custom_amount',
])
const HOUR_TYPES = new Set<PersonnelClaimType>([
  'warehouse_hour', 'trial_hour', 'external_hour', 'overtime_hour', 'new_property_task',
])
const TIME_RANGE_INPUT_TYPES = new Set<PersonnelClaimType>(HOUR_TYPES)
const DIRECT_AMOUNT_TYPES = new Set<PersonnelClaimType>(['subsidy_amount', 'custom_amount'])
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
const CLIENT_REQUEST_ID = /^[a-zA-Z0-9_-]{8,120}$/

const SELF_SERVICE_OPTION_BY_CLAIM_TYPE: Partial<Record<PersonnelClaimType, PersonnelClaimOption>> = {
  warehouse_hour: {
    business_type: 'warehouse', claim_type: 'warehouse_hour', label: '仓管工作',
    calculation_label: '系统按小时计算', input_mode: 'time_range', evidence_required: true, property_required: false,
    rule_configured: true,
  },
  overtime_hour: {
    business_type: 'overtime', claim_type: 'overtime_hour', label: '加班',
    calculation_label: '系统按小时计算', input_mode: 'time_range', evidence_required: true, property_required: false,
    rule_configured: true,
  },
  subsidy_amount: {
    business_type: 'subsidy', claim_type: 'subsidy_amount', label: '补贴',
    calculation_label: '按填写金额提交，公司核对后决定是否计入', input_mode: 'amount', evidence_required: true, property_required: false,
    rule_configured: true,
  },
  new_property_task: {
    business_type: 'new_property', claim_type: 'new_property_task', label: '上新房',
    calculation_label: '系统按小时计算', input_mode: 'time_range', evidence_required: false, property_required: true,
    rule_configured: true,
  },
  external_task: {
    business_type: 'external', claim_type: 'external_task', label: '编外合作',
    calculation_label: '系统按次计算', input_mode: 'quantity', evidence_required: true, property_required: false,
    rule_configured: true,
  },
  external_day: {
    business_type: 'external', claim_type: 'external_day', label: '编外合作',
    calculation_label: '系统按天计算', input_mode: 'day', evidence_required: true, property_required: false,
    rule_configured: true,
  },
  external_hour: {
    business_type: 'external', claim_type: 'external_hour', label: '编外合作',
    calculation_label: '系统按小时计算', input_mode: 'time_range', evidence_required: true, property_required: false,
    rule_configured: true,
  },
  custom_amount: {
    business_type: 'custom', claim_type: 'custom_amount', label: '其他费用',
    calculation_label: '按填写金额提交，公司核对后决定是否计入', input_mode: 'amount', evidence_required: true, property_required: false,
    rule_configured: true,
  },
}

const SELF_SERVICE_BUSINESS_TYPE_ORDER: PersonnelClaimBusinessType[] = [
  'warehouse', 'overtime', 'subsidy', 'new_property', 'external',
]

const SELF_SERVICE_FALLBACK_OPTION_BY_BUSINESS_TYPE: Record<PersonnelClaimBusinessType, PersonnelClaimOption> = {
  warehouse: SELF_SERVICE_OPTION_BY_CLAIM_TYPE.warehouse_hour!,
  overtime: SELF_SERVICE_OPTION_BY_CLAIM_TYPE.overtime_hour!,
  subsidy: SELF_SERVICE_OPTION_BY_CLAIM_TYPE.subsidy_amount!,
  new_property: SELF_SERVICE_OPTION_BY_CLAIM_TYPE.new_property_task!,
  external: SELF_SERVICE_OPTION_BY_CLAIM_TYPE.external_task!,
  custom: SELF_SERVICE_OPTION_BY_CLAIM_TYPE.custom_amount!,
}

const UNCONFIGURED_CLAIM_CALCULATION_LABEL = '可先反馈，公司核对时确认计算方式'

function cleanText(value: unknown) {
  return String(value ?? '').trim()
}

type PersonnelClaimDuplicateCandidate = {
  id?: unknown
  submitter_user_id?: unknown
  service_date?: unknown
  claim_type?: unknown
  property_id?: unknown
  cleaning_task_id?: unknown
  started_at?: unknown
  ended_at?: unknown
  duration_minutes?: unknown
  requested_quantity?: unknown
  requested_amount_cents?: unknown
  note?: unknown
}

function nullableCleanText(value: unknown) {
  return cleanText(value) || null
}

function duplicateDateOnly(value: unknown) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString().slice(0, 10)
  const normalized = cleanText(value)
  const match = normalized.match(/^\d{4}-\d{2}-\d{2}/)
  return match?.[0] || normalized
}

function duplicateTimestamp(value: unknown) {
  if (value === undefined || value === null || value === '') return null
  const parsed = value instanceof Date ? value : new Date(String(value))
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : cleanText(value)
}

function duplicateNumber(value: unknown) {
  if (value === undefined || value === null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? String(parsed) : cleanText(value)
}

export function personnelClaimBusinessDuplicateKey(input: PersonnelClaimDuplicateCandidate) {
  return JSON.stringify([
    cleanText(input.submitter_user_id),
    duplicateDateOnly(input.service_date),
    cleanText(input.claim_type),
    nullableCleanText(input.property_id),
    nullableCleanText(input.cleaning_task_id),
    duplicateTimestamp(input.started_at),
    duplicateTimestamp(input.ended_at),
    duplicateNumber(input.duration_minutes),
    duplicateNumber(input.requested_quantity),
    duplicateNumber(input.requested_amount_cents),
    cleanText(input.note),
  ])
}

export async function assertNoApprovedPersonnelClaimDuplicate(
  current: PersonnelClaimDuplicateCandidate,
  executor: Queryable,
) {
  const duplicateKey = personnelClaimBusinessDuplicateKey(current)
  await executor.query(
    'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
    [duplicateKey],
  )
  const duplicate = await executor.query(
    `SELECT id
       FROM personnel_workload_claims
      WHERE id <> $1
        AND status = 'approved'
        AND submitter_user_id = $2
        AND service_date = $3::date
        AND claim_type = $4
        AND NULLIF(TRIM(property_id), '') IS NOT DISTINCT FROM $5::text
        AND NULLIF(TRIM(cleaning_task_id), '') IS NOT DISTINCT FROM $6::text
        AND started_at IS NOT DISTINCT FROM $7::timestamptz
        AND ended_at IS NOT DISTINCT FROM $8::timestamptz
        AND duration_minutes IS NOT DISTINCT FROM $9::integer
        AND requested_quantity IS NOT DISTINCT FROM $10::numeric
        AND requested_amount_cents IS NOT DISTINCT FROM $11::integer
        AND TRIM(note) = $12
      LIMIT 1`,
    [
      cleanText(current.id),
      cleanText(current.submitter_user_id),
      duplicateDateOnly(current.service_date),
      cleanText(current.claim_type),
      nullableCleanText(current.property_id),
      nullableCleanText(current.cleaning_task_id),
      duplicateTimestamp(current.started_at),
      duplicateTimestamp(current.ended_at),
      duplicateNumber(current.duration_minutes),
      duplicateNumber(current.requested_quantity),
      duplicateNumber(current.requested_amount_cents),
      cleanText(current.note),
    ],
  )
  if (duplicate.rows?.length) throw new Error('duplicate_approved_claim')
}

function parseJsonObject(value: unknown): Record<string, any> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, any>
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {}
  }
  return {}
}

function nullableText(value: unknown, maximum = 500) {
  const normalized = cleanText(value)
  if (normalized.length > maximum) throw new Error('claim_text_too_long')
  return normalized || null
}

function optionalSafeInteger(value: unknown, field: string, maximum = 100_000_000) {
  if (value === undefined || value === null || value === '') return null
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) throw new Error(`invalid_${field}`)
  return parsed
}

function optionalQuantity(value: unknown, field: string) {
  if (value === undefined || value === null || value === '') return null
  const normalized = cleanText(value)
  if (!/^\d+(?:\.\d{1,3})?$/.test(normalized)) throw new Error(`invalid_${field}`)
  const parsed = Number(normalized)
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1_000_000) throw new Error(`invalid_${field}`)
  return normalized
}

function optionalTimestamp(value: unknown, field: string) {
  const normalized = cleanText(value)
  if (!normalized) return null
  const parsed = new Date(normalized)
  if (!Number.isFinite(parsed.getTime())) throw new Error(`invalid_${field}`)
  return parsed.toISOString()
}

function claimSummary(row: any) {
  return {
    id: String(row?.id || ''),
    status: String(row?.status || ''),
    service_date: String(row?.service_date || ''),
    claim_type: String(row?.claim_type || ''),
    duration_minutes: row?.duration_minutes == null ? null : Number(row.duration_minutes),
    approved_duration_minutes: row?.approved_duration_minutes == null ? null : Number(row.approved_duration_minutes),
    requested_quantity: row?.requested_quantity == null ? null : String(row.requested_quantity),
    approved_quantity: row?.approved_quantity == null ? null : String(row.approved_quantity),
    requested_amount_cents: row?.requested_amount_cents == null ? null : Number(row.requested_amount_cents),
    approved_amount_cents: row?.approved_amount_cents == null ? null : Number(row.approved_amount_cents),
  }
}

export function validatePersonnelClaimClientRequestId(value: unknown) {
  if (value === undefined || value === null || value === '') return null
  const clientRequestId = cleanText(value)
  if (!CLIENT_REQUEST_ID.test(clientRequestId)) throw new Error('invalid_claim_client_request_id')
  return clientRequestId
}

export function getPersonnelClaimAvailableActions(status: string) {
  return ['draft', 'returned'].includes(cleanText(status)) ? ['edit', 'submit'] : []
}

export function personnelClaimRequiresEvidence(claimType: unknown) {
  return cleanText(claimType) !== 'new_property_task'
}

export function buildPersonnelClaimOptions(
  ruleItems: ReadonlyArray<{ component_type?: unknown }> | null | undefined,
) {
  const configuredByBusinessType = new Map<PersonnelClaimBusinessType, PersonnelClaimOption>()
  for (const item of ruleItems || []) {
    const option = SELF_SERVICE_OPTION_BY_CLAIM_TYPE[cleanText(item?.component_type) as PersonnelClaimType]
    if (!option || configuredByBusinessType.has(option.business_type)) continue
    configuredByBusinessType.set(option.business_type, { ...option, rule_configured: true })
  }
  return SELF_SERVICE_BUSINESS_TYPE_ORDER.map((businessType) => {
    const configured = configuredByBusinessType.get(businessType)
    if (configured) return configured
    const fallback = SELF_SERVICE_FALLBACK_OPTION_BY_BUSINESS_TYPE[businessType]
    if (DIRECT_AMOUNT_TYPES.has(fallback.claim_type)) {
      return { ...fallback, rule_configured: true }
    }
    return {
      ...fallback,
      calculation_label: UNCONFIGURED_CLAIM_CALCULATION_LABEL,
      rule_configured: false,
    }
  })
}

export function personnelClaimOptionAllowsClaim(
  options: ReadonlyArray<Pick<PersonnelClaimOption, 'claim_type'>> | null | undefined,
  claimType: unknown,
) {
  const normalizedClaimType = cleanText(claimType)
  return Boolean(normalizedClaimType && (options || []).some((option) => option.claim_type === normalizedClaimType))
}

export async function listPersonnelClaimOptions(input: {
  userId: string
  serviceDate: string
}, executor: Queryable | null = pgPool) {
  if (!executor) throw new Error('pg_required')
  assertPersonnelSettlementSchemaReady()
  const serviceDate = cleanText(input.serviceDate)
  if (!DATE_ONLY.test(serviceDate)) throw new Error('invalid_claim_service_date')
  try { getSettlementWeekStart(serviceDate) } catch { throw new Error('invalid_claim_service_date') }
  const result = await executor.query(
    `WITH selected_rule AS (
       SELECT id, name
         FROM personnel_fee_rules
        WHERE user_id=$1
          AND status='active'
          AND effective_from <= $2::date
          AND (effective_to IS NULL OR effective_to >= $2::date)
        ORDER BY effective_from DESC, created_at DESC, id
        LIMIT 1
     )
     SELECT selected_rule.id AS rule_id, selected_rule.name AS rule_name,
            item.component_type, item.priority, item.id AS item_id
       FROM selected_rule
       LEFT JOIN personnel_fee_rule_items item ON item.rule_id=selected_rule.id
      ORDER BY item.priority DESC, item.id`,
    [input.userId, serviceDate],
  )
  const first = result.rows?.[0]
  return {
    service_date: serviceDate,
    rule_id: first?.rule_id ? String(first.rule_id) : null,
    rule_name: first?.rule_name ? String(first.rule_name) : null,
    options: buildPersonnelClaimOptions(result.rows || []),
  }
}

export function calculatePersonnelClaimEstimate(input: PersonnelClaimEstimateInput & {
  rule: PersonnelClaimEstimateRule
}) {
  let quantityNumerator = 1
  let quantityDenominator = 1
  let unitRateCents = optionalSafeInteger(input.rule.unitRateCents, 'rule_rate_cents')

  if (input.rule.gstStatus === 'unconfirmed') {
    return { available: false as const, reason: 'gst_status_unconfirmed' as const }
  }
  if (HOUR_TYPES.has(input.claimType)) {
    const durationMinutes = optionalSafeInteger(input.durationMinutes, 'claim_duration_minutes', 7 * 24 * 60)
    if (!durationMinutes) return { available: false as const, reason: 'claim_duration_required' as const }
    quantityNumerator = durationMinutes
    quantityDenominator = 60
  } else if (DIRECT_AMOUNT_TYPES.has(input.claimType)) {
    const requestedAmountCents = optionalSafeInteger(input.requestedAmountCents, 'requested_amount_cents')
    if (!requestedAmountCents) return { available: false as const, reason: 'claim_amount_required' as const }
    unitRateCents = requestedAmountCents
  } else if (!input.claimType.endsWith('_day')) {
    const ratio = decimalQuantityToRatio(input.requestedQuantity ?? '')
    if (!ratio || ratio.numerator <= 0) return { available: false as const, reason: 'claim_quantity_required' as const }
    quantityNumerator = ratio.numerator
    quantityDenominator = ratio.denominator
  }

  if (unitRateCents == null) return { available: false as const, reason: 'missing_rule_item' as const }
  return {
    available: true as const,
    reason: null,
    rule_id: input.rule.ruleId,
    rule_name: input.rule.ruleName,
    effective_from: input.rule.effectiveFrom,
    price_basis: input.rule.priceBasis,
    unit_rate_cents: unitRateCents,
    gst_status: input.rule.gstStatus,
    quantity_numerator: quantityNumerator,
    quantity_denominator: quantityDenominator,
    ...calculateSettlementLine({
      quantity_numerator: quantityNumerator,
      quantity_denominator: quantityDenominator,
      unit_rate_cents: unitRateCents,
      price_basis: input.rule.priceBasis,
      gst_registered: input.rule.gstStatus === 'registered',
    }),
  }
}

export async function estimatePersonnelClaim(input: {
  userId: string
  estimate: PersonnelClaimEstimateInput
}, executor: Queryable | null = pgPool, options?: { allowManagedClaimTypes?: boolean }) {
  if (!executor) throw new Error('pg_required')
  assertPersonnelSettlementSchemaReady()
  const serviceDate = cleanText(input.estimate.serviceDate)
  const claimType = cleanText(input.estimate.claimType) as PersonnelClaimType
  if (!DATE_ONLY.test(serviceDate)) throw new Error('invalid_claim_service_date')
  try { getSettlementWeekStart(serviceDate) } catch { throw new Error('invalid_claim_service_date') }
  if (
    !CLAIM_TYPES.has(claimType)
    || (!options?.allowManagedClaimTypes && !SELF_SERVICE_OPTION_BY_CLAIM_TYPE[claimType])
  ) {
    throw new Error('claim_type_not_available')
  }

  if (DIRECT_AMOUNT_TYPES.has(claimType)) {
    const profileResult = await executor.query(
      `SELECT effective_from::text, gst_status
         FROM personnel_settlement_profiles
        WHERE user_id=$1
          AND effective_from <= $2::date
          AND (effective_to IS NULL OR effective_to >= $2::date)
        ORDER BY effective_from DESC, updated_at DESC, id
        LIMIT 1`,
      [input.userId, serviceDate],
    )
    const profile = profileResult.rows?.[0]
    if (!['unconfirmed', 'registered', 'not_registered'].includes(cleanText(profile?.gst_status))) {
      return { available: false as const, reason: 'missing_effective_profile' as const }
    }
    return calculatePersonnelClaimEstimate({
      ...input.estimate,
      serviceDate,
      claimType,
      rule: {
        ruleId: null,
        ruleName: null,
        effectiveFrom: String(profile.effective_from || ''),
        priceBasis: 'inclusive_gst',
        unitRateCents: null,
        gstStatus: profile.gst_status,
      },
    })
  }

  const result = await executor.query(
    `WITH selected_rule AS (
       SELECT id, name, effective_from::text, price_basis
         FROM personnel_fee_rules
        WHERE user_id=$1
          AND status='active'
          AND effective_from <= $2::date
          AND (effective_to IS NULL OR effective_to >= $2::date)
        ORDER BY effective_from DESC, created_at DESC, id
        LIMIT 1
     ), selected_profile AS (
       SELECT gst_status
         FROM personnel_settlement_profiles
        WHERE user_id=$1
          AND effective_from <= $2::date
          AND (effective_to IS NULL OR effective_to >= $2::date)
        ORDER BY effective_from DESC, updated_at DESC, id
        LIMIT 1
     )
     SELECT rule.id AS rule_id, rule.name AS rule_name, rule.effective_from,
            rule.price_basis, item.id AS item_id, item.rate_cents,
            profile.gst_status
       FROM selected_rule rule
       LEFT JOIN personnel_fee_rule_items item
         ON item.rule_id=rule.id AND item.component_type=$3
       LEFT JOIN selected_profile profile ON TRUE
      ORDER BY item.priority DESC, item.id
      LIMIT 1`,
    [input.userId, serviceDate, claimType],
  )
  const row = result.rows?.[0]
  if (!row?.rule_id) return { available: false as const, reason: 'missing_effective_rule' as const }
  if (!row?.item_id) return { available: false as const, reason: 'missing_rule_item' as const }
  if (!['unconfirmed', 'registered', 'not_registered'].includes(cleanText(row.gst_status))) {
    return { available: false as const, reason: 'missing_effective_profile' as const }
  }
  return calculatePersonnelClaimEstimate({
    ...input.estimate,
    serviceDate,
    claimType,
    rule: {
      ruleId: String(row.rule_id),
      ruleName: String(row.rule_name || ''),
      effectiveFrom: String(row.effective_from || ''),
      priceBasis: row.price_basis as SettlementPriceBasis,
      unitRateCents: Number(row.rate_cents),
      gstStatus: row.gst_status,
    },
  })
}

export async function estimatePersonnelClaimForReview(
  input: PersonnelClaimReviewEstimateInput,
  executor: Queryable | null = pgPool,
) {
  if (!executor) throw new Error('pg_required')
  assertPersonnelSettlementSchemaReady()
  const result = await executor.query(
    `SELECT id, submitter_user_id, service_date::text, claim_type,
            duration_minutes, approved_duration_minutes,
            requested_quantity, approved_quantity,
            requested_amount_cents, approved_amount_cents
       FROM personnel_workload_claims
      WHERE id=$1`,
    [input.claimId],
  )
  const claim = result.rows?.[0]
  if (!claim) throw new Error('claim_not_found')
  return estimatePersonnelClaim({
    userId: String(claim.submitter_user_id || ''),
    estimate: {
      serviceDate: String(claim.service_date || '').slice(0, 10),
      claimType: claim.claim_type as PersonnelClaimType,
      durationMinutes: input.durationMinutes
        ?? (claim.approved_duration_minutes == null ? claim.duration_minutes : claim.approved_duration_minutes),
      requestedQuantity: input.requestedQuantity
        ?? (claim.approved_quantity == null ? claim.requested_quantity : claim.approved_quantity),
      requestedAmountCents: input.requestedAmountCents
        ?? (claim.approved_amount_cents == null ? claim.requested_amount_cents : claim.approved_amount_cents),
    },
  }, executor, { allowManagedClaimTypes: true })
}

async function assertPersonnelSelfServiceClaimAllowed(input: {
  userId: string
  serviceDate: string
  claimType: PersonnelClaimType
  allowHistoricalCustomAmount?: boolean
}, executor: Queryable) {
  if (input.claimType === 'custom_amount' && input.allowHistoricalCustomAmount) return
  const available = await listPersonnelClaimOptions({
    userId: input.userId,
    serviceDate: input.serviceDate,
  }, executor)
  if (!personnelClaimOptionAllowsClaim(available.options, input.claimType)) {
    throw new Error('claim_type_not_available')
  }
}

async function insertAudit(
  client: Queryable,
  entity: string,
  entityId: string,
  action: string,
  actorUserId: string,
  before: unknown,
  after: unknown,
) {
  await client.query(
    `INSERT INTO audit_logs (
       id, entity, entity_id, action, actor_id, before_json, after_json, created_at
     ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,now())`,
    [randomUUID(), entity, entityId, action, actorUserId, JSON.stringify(before ?? null), JSON.stringify(after ?? null)],
  )
}

export function validatePersonnelClaimInput(input: PersonnelClaimInput, now = new Date()) {
  const serviceDate = cleanText(input.service_date)
  if (!DATE_ONLY.test(serviceDate)) throw new Error('invalid_claim_service_date')
  try { getSettlementWeekStart(serviceDate) } catch { throw new Error('invalid_claim_service_date') }
  if (serviceDate > getMelbourneDate(now)) throw new Error('claim_service_date_in_future')

  const claimType = cleanText(input.claim_type) as PersonnelClaimType
  if (!CLAIM_TYPES.has(claimType)) throw new Error('invalid_claim_type')
  const note = cleanText(input.note)
  if (!note) throw new Error('claim_note_required')
  if (note.length > 1000) throw new Error('claim_note_too_long')

  const startedAt = optionalTimestamp(input.started_at, 'claim_started_at')
  const endedAt = optionalTimestamp(input.ended_at, 'claim_ended_at')
  if ((startedAt && !endedAt) || (!startedAt && endedAt)) throw new Error('claim_time_range_incomplete')
  let durationMinutes = optionalSafeInteger(input.duration_minutes, 'claim_duration_minutes', 7 * 24 * 60)
  if (startedAt && endedAt) {
    const derived = Math.round((new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 60_000)
    if (derived <= 0 || derived > 7 * 24 * 60) throw new Error('invalid_claim_time_range')
    if (durationMinutes != null && Math.abs(durationMinutes - derived) > 1) throw new Error('claim_duration_mismatch')
    durationMinutes = derived
  }
  const requestedQuantity = optionalQuantity(input.requested_quantity, 'claim_requested_quantity')
  const requestedAmountCents = optionalSafeInteger(input.requested_amount_cents, 'claim_requested_amount_cents')

  if (TIME_RANGE_INPUT_TYPES.has(claimType) && (!durationMinutes || durationMinutes <= 0)) {
    throw new Error('claim_duration_required')
  }
  if (DIRECT_AMOUNT_TYPES.has(claimType) && requestedAmountCents == null && requestedQuantity == null) {
    throw new Error('claim_amount_or_quantity_required')
  }
  if (claimType === 'new_property_task' && !cleanText(input.property_id)) {
    throw new Error('claim_property_required')
  }

  return {
    client_request_id: validatePersonnelClaimClientRequestId(input.client_request_id),
    service_date: serviceDate,
    claim_type: claimType,
    property_id: nullableText(input.property_id, 120),
    cleaning_task_id: nullableText(input.cleaning_task_id, 120),
    started_at: startedAt,
    ended_at: endedAt,
    duration_minutes: durationMinutes,
    requested_quantity: requestedQuantity ?? (HOUR_TYPES.has(claimType) ? null : '1'),
    requested_amount_cents: requestedAmountCents,
    note,
  }
}

export function validatePersonnelClaimReviewInput(input: PersonnelClaimReviewInput) {
  const action = cleanText(input.action) as PersonnelClaimReviewAction
  if (!['approve', 'return', 'reject'].includes(action)) throw new Error('invalid_claim_review_action')
  const reviewNote = nullableText(input.review_note, 1000)
  if ((action === 'return' || action === 'reject') && !reviewNote) throw new Error('claim_review_note_required')
  return {
    action,
    approved_duration_minutes: optionalSafeInteger(input.approved_duration_minutes, 'approved_duration_minutes', 7 * 24 * 60),
    approved_quantity: optionalQuantity(input.approved_quantity, 'approved_quantity'),
    approved_amount_cents: optionalSafeInteger(input.approved_amount_cents, 'approved_amount_cents'),
    review_note: reviewNote,
  }
}

function serializeClaim(row: any) {
  return {
    ...row,
    duration_minutes: row.duration_minutes == null ? null : Number(row.duration_minutes),
    approved_duration_minutes: row.approved_duration_minutes == null ? null : Number(row.approved_duration_minutes),
    requested_quantity: row.requested_quantity == null ? null : String(row.requested_quantity),
    approved_quantity: row.approved_quantity == null ? null : String(row.approved_quantity),
    requested_amount_cents: row.requested_amount_cents == null ? null : Number(row.requested_amount_cents),
    approved_amount_cents: row.approved_amount_cents == null ? null : Number(row.approved_amount_cents),
    evidence_count: Number(row.evidence_count || 0),
    available_actions: getPersonnelClaimAvailableActions(String(row.status || '')),
  }
}

const CLAIM_SELECT = `
  SELECT c.id, c.submitter_user_id, c.service_date::text, c.claim_type,
         c.property_id, c.cleaning_task_id, c.started_at::text, c.ended_at::text,
         c.duration_minutes, c.approved_duration_minutes,
         c.requested_quantity, c.approved_quantity,
         c.requested_amount_cents, c.approved_amount_cents,
         c.note, c.status, c.submitted_at::text, c.reviewed_by,
         c.reviewed_at::text, c.review_note, c.created_at::text, c.updated_at::text,
         COALESCE(NULLIF(TRIM(u.display_name),''), NULLIF(TRIM(u.username),''),
                  NULLIF(TRIM(u.legal_name),''), u.id::text) AS submitter_name,
         COUNT(e.id)::int AS evidence_count
    FROM personnel_workload_claims c
    JOIN users u ON u.id::text=c.submitter_user_id::text
    LEFT JOIN personnel_workload_claim_evidence e ON e.claim_id=c.id`

export async function listPersonnelClaims(input: {
  userId?: string
  weekStart?: string
  status?: string
  search?: string
}, executor: Queryable | null = pgPool) {
  if (!executor) throw new Error('pg_required')
  assertPersonnelSettlementSchemaReady()
  const params: any[] = []
  const where: string[] = []
  if (input.userId) { params.push(input.userId); where.push(`c.submitter_user_id=$${params.length}`) }
  if (input.weekStart) {
    const weekStart = getSettlementWeekStart(input.weekStart)
    params.push(weekStart); where.push(`c.service_date BETWEEN $${params.length}::date AND $${params.length}::date + 6`)
  }
  if (input.status) { params.push(input.status); where.push(`c.status=$${params.length}`) }
  if (cleanText(input.search)) {
    params.push(`%${cleanText(input.search).replace(/[%_]/g, '\\$&')}%`)
    where.push(`(COALESCE(u.display_name,'') ILIKE $${params.length} ESCAPE '\\' OR COALESCE(u.username,'') ILIKE $${params.length} ESCAPE '\\' OR COALESCE(u.legal_name,'') ILIKE $${params.length} ESCAPE '\\')`)
  }
  const result = await executor.query(
    `${CLAIM_SELECT}
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     GROUP BY c.id, u.id
     ORDER BY c.service_date DESC, c.created_at DESC
     LIMIT 500`,
    params,
  )
  return (result.rows || []).map(serializeClaim)
}

export async function listPersonnelClaimsWithEvidence(input: {
  userId: string
  weekStart: string
  excludeDrafts?: boolean
}, executor: Queryable | null = pgPool) {
  if (!executor) throw new Error('pg_required')
  const claims = await listPersonnelClaims({ userId: input.userId, weekStart: input.weekStart }, executor)
  const visibleClaims = input.excludeDrafts
    ? claims.filter((claim: any) => String(claim.status) !== 'draft')
    : claims
  const claimIds = visibleClaims.map((claim: any) => String(claim.id)).filter(Boolean)
  if (!claimIds.length) return []
  const evidenceResult = await executor.query(
    `SELECT id, claim_id, media_id, mime_type, byte_size, original_file_name, created_at::text
       FROM personnel_workload_claim_evidence
      WHERE claim_id=ANY($1::text[])
      ORDER BY created_at, id`,
    [claimIds],
  )
  const evidenceByClaim = new Map<string, any[]>()
  for (const evidence of evidenceResult.rows || []) {
    const claimId = String(evidence.claim_id || '')
    const existing = evidenceByClaim.get(claimId) || []
    const { claim_id: _claimId, ...safeEvidence } = evidence
    existing.push(safeEvidence)
    evidenceByClaim.set(claimId, existing)
  }
  return visibleClaims.map((claim: any) => ({
    ...claim,
    evidence: evidenceByClaim.get(String(claim.id)) || [],
  }))
}

export async function getPersonnelClaim(input: {
  claimId: string
  requestingUserId?: string
}, executor: Queryable | null = pgPool) {
  if (!executor) throw new Error('pg_required')
  assertPersonnelSettlementSchemaReady()
  const params: any[] = [input.claimId]
  const ownerFilter = input.requestingUserId ? `AND c.submitter_user_id=$2` : ''
  if (input.requestingUserId) params.push(input.requestingUserId)
  const result = await executor.query(
    `${CLAIM_SELECT}
      WHERE c.id=$1 ${ownerFilter}
      GROUP BY c.id, u.id`,
    params,
  )
  const row = result.rows?.[0]
  if (!row) return null
  const evidence = await executor.query(
    `SELECT id, media_id, mime_type, byte_size, original_file_name, created_at::text
       FROM personnel_workload_claim_evidence
      WHERE claim_id=$1
      ORDER BY created_at, id`,
    [input.claimId],
  )
  return { ...serializeClaim(row), evidence: evidence.rows || [] }
}

export async function createPersonnelClaim(input: {
  userId: string
  claim: PersonnelClaimInput
}) {
  assertPersonnelSettlementSchemaReady()
  if (!pgPool) throw new Error('pg_required')
  const claim = validatePersonnelClaimInput(input.claim)
  const claimId = claim.client_request_id || randomUUID()
  await pgRunInTransaction(async (client) => {
    const existing = await client.query(
      'SELECT id, submitter_user_id FROM personnel_workload_claims WHERE id=$1 FOR UPDATE',
      [claimId],
    )
    if (existing.rowCount) {
      if (String(existing.rows[0]?.submitter_user_id || '') !== input.userId) throw new Error('claim_request_conflict')
      return
    }
    const user = await client.query('SELECT id FROM users WHERE id::text=$1 FOR UPDATE', [input.userId])
    if (!user.rowCount) throw new Error('user_not_found')
    await assertPersonnelSelfServiceClaimAllowed({
      userId: input.userId,
      serviceDate: claim.service_date,
      claimType: claim.claim_type,
    }, client)
    await client.query(
      `INSERT INTO personnel_workload_claims (
         id, submitter_user_id, service_date, claim_type, property_id, cleaning_task_id,
         started_at, ended_at, duration_minutes, requested_quantity,
         requested_amount_cents, note, status
       ) VALUES ($1,$2,$3::date,$4,$5,$6,$7::timestamptz,$8::timestamptz,$9,$10::numeric,$11,$12,'draft')`,
      [
        claimId, input.userId, claim.service_date, claim.claim_type, claim.property_id,
        claim.cleaning_task_id, claim.started_at, claim.ended_at, claim.duration_minutes,
        claim.requested_quantity, claim.requested_amount_cents, claim.note,
      ],
    )
    await insertAudit(client, 'personnel_workload_claim', claimId, 'create_draft', input.userId, null, {
      id: claimId,
      status: 'draft',
      service_date: claim.service_date,
      claim_type: claim.claim_type,
    })
  })
  return getPersonnelClaim({ claimId, requestingUserId: input.userId })
}

export async function updatePersonnelClaim(input: {
  userId: string
  claimId: string
  claim: PersonnelClaimInput
}) {
  assertPersonnelSettlementSchemaReady()
  if (!pgPool) throw new Error('pg_required')
  const claim = validatePersonnelClaimInput(input.claim)
  await pgRunInTransaction(async (client) => {
    const currentResult = await client.query(
      `SELECT * FROM personnel_workload_claims
        WHERE id=$1 AND submitter_user_id=$2
        FOR UPDATE`,
      [input.claimId, input.userId],
    )
    const current = currentResult.rows?.[0]
    if (!current) throw new Error('claim_not_found')
    if (!['draft', 'returned'].includes(String(current.status))) throw new Error('claim_not_editable')
    await assertPersonnelSelfServiceClaimAllowed({
      userId: input.userId,
      serviceDate: claim.service_date,
      claimType: claim.claim_type,
      allowHistoricalCustomAmount: current.claim_type === 'custom_amount' && claim.claim_type === 'custom_amount',
    }, client)
    const updated = await client.query(
      `UPDATE personnel_workload_claims
          SET service_date=$1::date, claim_type=$2, property_id=$3, cleaning_task_id=$4,
              started_at=$5::timestamptz, ended_at=$6::timestamptz, duration_minutes=$7,
              requested_quantity=$8::numeric, requested_amount_cents=$9, note=$10,
              status='draft', submitted_at=NULL, reviewed_by=NULL, reviewed_at=NULL,
              review_note=NULL, approved_duration_minutes=NULL, approved_quantity=NULL,
              approved_amount_cents=NULL, updated_at=now()
        WHERE id=$11
        RETURNING *`,
      [
        claim.service_date, claim.claim_type, claim.property_id, claim.cleaning_task_id,
        claim.started_at, claim.ended_at, claim.duration_minutes, claim.requested_quantity,
        claim.requested_amount_cents, claim.note, input.claimId,
      ],
    )
    await insertAudit(
      client,
      'personnel_workload_claim',
      input.claimId,
      'update_draft',
      input.userId,
      claimSummary(current),
      claimSummary(updated.rows[0]),
    )
  })
  return getPersonnelClaim({ claimId: input.claimId, requestingUserId: input.userId })
}

export async function submitPersonnelClaimInTransaction(
  input: { userId: string; claimId: string },
  client: Queryable,
) {
  const currentResult = await client.query(
    `SELECT * FROM personnel_workload_claims
      WHERE id=$1 AND submitter_user_id=$2
      FOR UPDATE`,
    [input.claimId, input.userId],
  )
  const current = currentResult.rows?.[0]
  if (!current) throw new Error('claim_not_found')
  if (String(current.status) === 'submitted') return current
  if (String(current.status) !== 'draft') throw new Error('claim_not_submittable')
  await assertPersonnelSelfServiceClaimAllowed({
    userId: input.userId,
    serviceDate: String(current.service_date || '').slice(0, 10),
    claimType: current.claim_type as PersonnelClaimType,
    allowHistoricalCustomAmount: current.claim_type === 'custom_amount',
  }, client)
  const evidence = await client.query(
    'SELECT COUNT(*)::int AS count FROM personnel_workload_claim_evidence WHERE claim_id=$1',
    [input.claimId],
  )
  if (personnelClaimRequiresEvidence(current.claim_type) && Number(evidence.rows?.[0]?.count || 0) < 1) {
    throw new Error('claim_evidence_required')
  }
  const updated = await client.query(
    `UPDATE personnel_workload_claims
        SET status='submitted', submitted_at=now(), updated_at=now()
      WHERE id=$1
      RETURNING *`,
    [input.claimId],
  )
  await insertAudit(
    client,
    'personnel_workload_claim',
    input.claimId,
    'submit',
    input.userId,
    claimSummary(current),
    claimSummary(updated.rows[0]),
  )
  return updated.rows[0]
}

export async function submitPersonnelClaim(input: { userId: string; claimId: string }) {
  assertPersonnelSettlementSchemaReady()
  if (!pgPool) throw new Error('pg_required')
  await pgRunInTransaction(async (client) => {
    await submitPersonnelClaimInTransaction(input, client)
  })
  return getPersonnelClaim({ claimId: input.claimId, requestingUserId: input.userId })
}

export async function reviewPersonnelClaimInTransaction(input: {
  claimId: string
  actorUserId: string
  review: PersonnelClaimReviewInput
}, client: Queryable, options?: { allowDisputedSettlementId?: string | null }) {
  const review = validatePersonnelClaimReviewInput(input.review)
  const currentResult = await client.query(
    'SELECT * FROM personnel_workload_claims WHERE id=$1 FOR UPDATE',
    [input.claimId],
  )
  const current = currentResult.rows?.[0]
  if (!current) throw new Error('claim_not_found')
  const currentStatus = String(current.status)
  const expectedStatus = review.action === 'approve' ? 'approved' : review.action === 'return' ? 'returned' : 'rejected'
  if (currentStatus === expectedStatus) return current
  if (currentStatus !== 'submitted') throw new Error('claim_not_reviewable')

  if (review.action === 'approve') {
    const weekStart = getSettlementWeekStart(String(current.service_date))
    const locked = await client.query(
      `SELECT settlement.id, settlement.status, settlement.rule_snapshot
         FROM personnel_weekly_settlements settlement
         JOIN personnel_settlement_batches batch ON batch.id=settlement.batch_id
        WHERE settlement.user_id=$1
          AND batch.week_start=$2::date
          AND settlement.status=ANY($3::text[])
        ORDER BY settlement.updated_at DESC, settlement.id
        LIMIT 1`,
      [current.submitter_user_id, weekStart, ['disputed', 'awaiting_confirmation', 'confirmed', 'finance_approved', 'paid']],
    )
    const lockedSettlement = locked.rows?.[0]
    const isAllowedDispute = String(lockedSettlement?.status || '') === 'disputed'
      && String(lockedSettlement?.id || '') === cleanText(options?.allowDisputedSettlementId)
    const lockedRuleSnapshot = parseJsonObject(lockedSettlement?.rule_snapshot)
    const isPartnerSubmittedFinanceReview = String(lockedSettlement?.status || '') === 'confirmed'
      && Object.keys(parseJsonObject(lockedRuleSnapshot.partner_submission)).length > 0
    if (locked.rowCount && !isAllowedDispute && !isPartnerSubmittedFinanceReview) throw new Error('claim_period_locked')
    const evidence = await client.query(
      'SELECT COUNT(*)::int AS count FROM personnel_workload_claim_evidence WHERE claim_id=$1',
      [input.claimId],
    )
    if (personnelClaimRequiresEvidence(current.claim_type) && Number(evidence.rows?.[0]?.count || 0) < 1) {
      throw new Error('claim_evidence_required')
    }
  }

  const approvedDuration = review.action === 'approve'
    ? review.approved_duration_minutes ?? (current.duration_minutes == null ? null : Number(current.duration_minutes))
    : null
  const approvedQuantity = review.action === 'approve'
    ? review.approved_quantity ?? (current.requested_quantity == null ? null : String(current.requested_quantity))
    : null
  const approvedAmount = review.action === 'approve'
    ? review.approved_amount_cents ?? (current.requested_amount_cents == null ? null : Number(current.requested_amount_cents))
    : null
  if (review.action === 'approve' && !DIRECT_AMOUNT_TYPES.has(current.claim_type) && review.approved_amount_cents != null) {
    throw new Error('manual_amount_not_allowed_for_claim_type')
  }
  if (review.action === 'approve' && TIME_RANGE_INPUT_TYPES.has(current.claim_type) && (!approvedDuration || approvedDuration <= 0) && approvedAmount == null) {
    throw new Error('approved_duration_or_amount_required')
  }
  if (review.action === 'approve' && DIRECT_AMOUNT_TYPES.has(current.claim_type) && approvedAmount == null && approvedQuantity == null) {
    throw new Error('approved_amount_or_quantity_required')
  }

  let calculationPreview: Awaited<ReturnType<typeof estimatePersonnelClaimForReview>> | null = null
  if (review.action === 'approve') {
    await assertNoApprovedPersonnelClaimDuplicate(current, client)
    calculationPreview = await estimatePersonnelClaimForReview({
      claimId: input.claimId,
      durationMinutes: approvedDuration,
      requestedQuantity: approvedQuantity,
      requestedAmountCents: approvedAmount,
    }, client)
    if (!calculationPreview.available) throw new Error(calculationPreview.reason)
  }

  const updated = await client.query(
    `UPDATE personnel_workload_claims
        SET status=$1, approved_duration_minutes=$2, approved_quantity=$3::numeric,
            approved_amount_cents=$4, reviewed_by=$5, reviewed_at=now(),
            review_note=$6, updated_at=now()
      WHERE id=$7
      RETURNING *`,
    [expectedStatus, approvedDuration, approvedQuantity, approvedAmount, input.actorUserId, review.review_note, input.claimId],
  )
  await insertAudit(
    client,
    'personnel_workload_claim',
    input.claimId,
    review.action,
    input.actorUserId,
    claimSummary(current),
    calculationPreview
      ? { ...claimSummary(updated.rows[0]), calculation_preview: calculationPreview }
      : claimSummary(updated.rows[0]),
  )
  return updated.rows[0]
}

export async function reviewPersonnelClaim(input: {
  claimId: string
  actorUserId: string
  review: PersonnelClaimReviewInput
}) {
  assertPersonnelSettlementSchemaReady()
  if (!pgPool) throw new Error('pg_required')
  await pgRunInTransaction(async (client) => {
    await reviewPersonnelClaimInTransaction(input, client)
  })
  return getPersonnelClaim({ claimId: input.claimId })
}
