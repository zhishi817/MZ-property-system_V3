import { pgPool } from '../dbAdapter'
import {
  CLEANING_PROPERTY_TYPES,
  PERSONNEL_SETTLEMENT_CALCULATION_VERSION,
  aggregateSettlementAmounts,
  buildSettlementPeriod,
  calculateSettlementLine,
  chooseRuleItem,
  classifyWorkloadAudit,
  decimalQuantityToRatio,
  type SettlementComponentType,
  type SettlementLineAmounts,
  type SettlementPriceBasis,
  type SettlementRuleItem,
  type WorkloadAuditCandidate,
} from './personnelSettlement'

type Queryable = { query: (sql: string, params?: any[]) => Promise<any> }

type ProfileRow = {
  id: string
  user_id: string
  user_name: string
  effective_from: string
  effective_to: string | null
  person_type: string
  supplier_legal_name: string | null
  supplier_business_name: string | null
  abn: string | null
  gst_status: 'unconfirmed' | 'registered' | 'not_registered'
  payment_method: 'bank_transfer' | 'cash' | 'foreign_currency' | 'other'
  invoice_document_type: string
  currency: string
}

type RuleRow = {
  rule_id: string
  user_id: string
  rule_name: string
  effective_from: string
  effective_to: string | null
  price_basis: SettlementPriceBasis
  currency: string
  item_id: string | null
  component_type: SettlementComponentType | null
  property_id: string | null
  task_type: string | null
  conditions: Record<string, unknown> | null
  priority: number | null
  rate_cents: string | number | null
}

type Rule = {
  id: string
  user_id: string
  name: string
  effective_from: string
  effective_to: string | null
  price_basis: SettlementPriceBasis
  currency: string
  items: SettlementRuleItem[]
}

type ClaimRow = {
  id: string
  submitter_user_id: string
  service_date: string
  claim_type: SettlementComponentType
  property_id: string | null
  cleaning_task_id: string | null
  duration_minutes: number | null
  approved_duration_minutes: number | null
  requested_quantity: string | number | null
  approved_quantity: string | number | null
  approved_amount_cents: string | number | null
  note: string | null
}

type CleaningAssignmentCandidate = {
  task_id: string
  user_id: string
  user_name: string | null
  service_date: string
  task_status: string | null
  property_id: string | null
  property_label: string | null
  property_type: string | null
  task_type: string | null
}

type PreviewLine = SettlementLineAmounts & {
  component_type: SettlementComponentType
  service_date: string
  source_type: 'cleaning_task_assignment' | 'work_task_action_audit' | 'workload_claim' | 'weekly_rule'
  source_id: string
  source_audit_id: string | null
  property_id: string | null
  property_label: string | null
  property_type: string | null
  task_type: string | null
  description: string
  quantity_numerator: number
  quantity_denominator: number
  unit_rate_cents: number
  price_basis: SettlementPriceBasis
  profile_id: string
  gst_registered: boolean
  rule_id: string | null
  rule_item_id: string | null
}

type PersonPreview = {
  user_id: string
  user_name: string
  profile: ProfileRow | null
  effective_profiles: ProfileRow[]
  lines: PreviewLine[]
  totals: SettlementLineAmounts
  warnings: Array<{ source_type: string; source_id: string; reason: string }>
}

function cleanText(value: unknown) {
  return String(value ?? '').trim()
}

const CLEANING_PROPERTY_TYPE_SET = new Set<string>(CLEANING_PROPERTY_TYPES)
const DIRECT_AMOUNT_COMPONENT_TYPE_SET = new Set<SettlementComponentType>(['subsidy_amount', 'custom_amount'])

function dateContains(row: { effective_from: string; effective_to: string | null }, date: string) {
  return row.effective_from <= date && (!row.effective_to || row.effective_to >= date)
}

function toSafeNonNegativeInteger(value: unknown, field: string) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${field}_invalid`)
  return parsed
}

function groupRules(rows: RuleRow[]) {
  const byId = new Map<string, Rule>()
  for (const row of rows) {
    let rule = byId.get(row.rule_id)
    if (!rule) {
      rule = {
        id: row.rule_id,
        user_id: row.user_id,
        name: row.rule_name,
        effective_from: row.effective_from,
        effective_to: row.effective_to,
        price_basis: row.price_basis,
        currency: row.currency,
        items: [],
      }
      byId.set(row.rule_id, rule)
    }
    if (row.item_id && row.component_type) {
      rule.items.push({
        id: row.item_id,
        rule_id: row.rule_id,
        component_type: row.component_type,
        property_id: row.property_id,
        task_type: row.task_type,
        conditions: row.conditions && typeof row.conditions === 'object'
          ? { property_type: cleanText(row.conditions.property_type) || null }
          : {},
        priority: Number(row.priority || 0),
        rate_cents: toSafeNonNegativeInteger(row.rate_cents, 'rate_cents'),
      })
    }
  }
  return Array.from(byId.values())
}

function selectUniqueEffective<T extends { effective_from: string; effective_to: string | null }>(rows: T[], date: string) {
  const matching = rows.filter((row) => dateContains(row, date))
  return matching.length === 1 ? matching[0] : null
}

function newPerson(userId: string, userName?: string | null): PersonPreview {
  return {
    user_id: userId,
    user_name: cleanText(userName) || userId,
    profile: null,
    effective_profiles: [],
    lines: [],
    totals: { subtotal_cents: 0, gst_cents: 0, total_cents: 0 },
    warnings: [],
  }
}

export async function buildPersonnelSettlementPreview(input: {
  week_start: string
  user_ids?: string[]
}, executor: Queryable | null = pgPool) {
  if (!executor) throw new Error('pg_required')
  const period = buildSettlementPeriod(input.week_start)
  const userIds = Array.from(new Set((input.user_ids || []).map(cleanText).filter(Boolean)))
  const userFilter = userIds.length ? userIds : null
  const params = [period.week_start, period.week_end, userFilter]

  const [profileResult, ruleResult, auditResult, claimResult, cleaningAssignmentResult] = await Promise.all([
    executor.query(
      `SELECT p.id, p.user_id, p.effective_from::text, p.effective_to::text,
              p.person_type, p.supplier_legal_name, p.supplier_business_name,
              p.abn, p.gst_status, p.payment_method, p.invoice_document_type, p.currency,
              COALESCE(
                NULLIF(TRIM(u.display_name), ''),
                NULLIF(TRIM(u.username), ''),
                NULLIF(TRIM(u.legal_name), ''),
                NULLIF(TRIM(u.email), ''),
                u.id::text
              ) AS user_name
         FROM personnel_settlement_profiles p
         JOIN users u ON u.id::text = p.user_id::text
        WHERE p.settlement_enabled = true
          AND p.effective_from <= $2::date
          AND (p.effective_to IS NULL OR p.effective_to >= $1::date)
          AND ($3::text[] IS NULL OR p.user_id = ANY($3::text[]))
        ORDER BY p.user_id, p.effective_from, p.id`,
      params,
    ),
    executor.query(
      `SELECT r.id AS rule_id, r.user_id, r.name AS rule_name,
              r.effective_from::text, r.effective_to::text, r.price_basis, r.currency,
              i.id AS item_id, i.component_type, i.property_id, i.task_type,
              i.conditions, i.priority, i.rate_cents
         FROM personnel_fee_rules r
         LEFT JOIN personnel_fee_rule_items i ON i.rule_id = r.id
        WHERE r.status = 'active'
          AND r.effective_from <= $2::date
          AND (r.effective_to IS NULL OR r.effective_to >= $1::date)
          AND ($3::text[] IS NULL OR r.user_id = ANY($3::text[]))
        ORDER BY r.user_id, r.effective_from, r.id, i.priority DESC, i.id`,
      params,
    ),
    executor.query(
      `SELECT a.id AS audit_id, a.source_id AS task_id,
              a.performed_by_user_id AS user_id, a.performed_by_name,
              a.performed_as_action AS action, a.performed_at::text,
              CASE
                WHEN a.performed_as_action = 'submit_inspection'
                  THEN (a.performed_at AT TIME ZONE 'Australia/Melbourne')::date
                ELSE COALESCE(t.task_date, t.date, (a.performed_at AT TIME ZONE 'Australia/Melbourne')::date)
              END::text AS service_date,
              t.property_id, COALESCE(NULLIF(TRIM(p.code), ''), NULLIF(TRIM(p.address), ''), t.property_id) AS property_label,
              NULLIF(TRIM(p.type), '') AS property_type,
              COALESCE(NULLIF(TRIM(t.task_type), ''), NULLIF(TRIM(t.type), '')) AS task_type,
              t.status AS task_status, a.status_after, a.metadata
         FROM work_task_action_audits a
         JOIN cleaning_tasks t ON t.id::text = a.source_id::text
         LEFT JOIN properties p ON p.id::text = t.property_id::text
        WHERE a.source_type = 'cleaning_tasks'
          AND a.performed_as_action = ANY($4::text[])
          AND NULLIF(TRIM(a.performed_by_user_id), '') IS NOT NULL
          AND CASE
                WHEN a.performed_as_action = 'submit_inspection'
                  THEN (a.performed_at AT TIME ZONE 'Australia/Melbourne')::date
                ELSE COALESCE(t.task_date, t.date, (a.performed_at AT TIME ZONE 'Australia/Melbourne')::date)
              END BETWEEN $1::date AND $2::date
          AND ($3::text[] IS NULL OR a.performed_by_user_id = ANY($3::text[]))
        ORDER BY a.performed_at, a.id`,
      [...params, ['submit_inspection']],
    ),
    executor.query(
      `SELECT id, submitter_user_id, service_date::text, claim_type, property_id,
              cleaning_task_id, duration_minutes, approved_duration_minutes,
              requested_quantity, approved_quantity, approved_amount_cents, note
         FROM personnel_workload_claims
        WHERE status = 'approved'
          AND service_date BETWEEN $1::date AND $2::date
          AND ($3::text[] IS NULL OR submitter_user_id = ANY($3::text[]))
        ORDER BY service_date, id`,
      params,
    ),
    executor.query(
      `SELECT t.id::text AS task_id,
              COALESCE(t.task_date, t.date)::text AS service_date,
              t.status AS task_status, t.cleaner_id::text AS user_id,
              COALESCE(
                NULLIF(TRIM(u.display_name), ''),
                NULLIF(TRIM(u.username), ''),
                NULLIF(TRIM(u.legal_name), ''),
                t.cleaner_id::text
              ) AS user_name,
              t.property_id, COALESCE(NULLIF(TRIM(p.code), ''), NULLIF(TRIM(p.address), ''), t.property_id) AS property_label,
              NULLIF(TRIM(p.type), '') AS property_type,
              COALESCE(NULLIF(TRIM(t.task_type), ''), NULLIF(TRIM(t.type), '')) AS task_type
         FROM cleaning_tasks t
         LEFT JOIN properties p ON p.id::text = t.property_id::text
         LEFT JOIN users u ON u.id::text = t.cleaner_id::text
        WHERE COALESCE(t.task_date, t.date) BETWEEN $1::date AND $2::date
          AND NULLIF(TRIM(t.cleaner_id::text), '') IS NOT NULL
          AND ($3::text[] IS NULL OR t.cleaner_id::text = ANY($3::text[]))
        ORDER BY COALESCE(t.task_date, t.date), t.id`,
      params,
    ),
  ])

  const profiles = (profileResult.rows || []) as ProfileRow[]
  const rules = groupRules((ruleResult.rows || []) as RuleRow[])
  const candidates = (auditResult.rows || []) as WorkloadAuditCandidate[]
  const claims = (claimResult.rows || []) as ClaimRow[]
  const cleaningAssignments = (cleaningAssignmentResult.rows || []) as CleaningAssignmentCandidate[]
  const people = new Map<string, PersonPreview>()

  const profilesByUser = new Map<string, ProfileRow[]>()
  for (const profile of profiles) {
    const existing = profilesByUser.get(profile.user_id) || []
    existing.push(profile)
    profilesByUser.set(profile.user_id, existing)
    if (!people.has(profile.user_id)) people.set(profile.user_id, newPerson(profile.user_id, profile.user_name))
  }
  const rulesByUser = new Map<string, Rule[]>()
  for (const rule of rules) {
    const existing = rulesByUser.get(rule.user_id) || []
    existing.push(rule)
    rulesByUser.set(rule.user_id, existing)
  }

  const warn = (userId: string, userName: string | null, sourceType: string, sourceId: string, reason: string) => {
    const person = people.get(userId) || newPerson(userId, userName)
    person.warnings.push({ source_type: sourceType, source_id: sourceId, reason })
    people.set(userId, person)
  }

  const appendLine = (inputLine: {
    user_id: string
    user_name?: string | null
    component_type: SettlementComponentType
    service_date: string
    source_type: PreviewLine['source_type']
    source_id: string
    source_audit_id?: string | null
    property_id?: string | null
    property_label?: string | null
    property_type?: string | null
    task_type?: string | null
    description: string
    quantity_numerator: number
    quantity_denominator: number
    approved_amount_cents?: number | null
  }) => {
    const userProfiles = profilesByUser.get(inputLine.user_id) || []
    const profile = selectUniqueEffective(userProfiles, inputLine.service_date)
    if (!profile) {
      warn(inputLine.user_id, inputLine.user_name || null, inputLine.source_type, inputLine.source_id,
        userProfiles.filter((row) => dateContains(row, inputLine.service_date)).length > 1
          ? 'ambiguous_effective_profile'
          : 'missing_effective_profile')
      return
    }
    if (profile.gst_status === 'unconfirmed') {
      warn(inputLine.user_id, profile.user_name, inputLine.source_type, inputLine.source_id, 'gst_status_unconfirmed')
      return
    }
    const propertyType = cleanText(inputLine.property_type)
    if (
      inputLine.approved_amount_cents != null
      && DIRECT_AMOUNT_COMPONENT_TYPE_SET.has(inputLine.component_type)
    ) {
      const amounts = calculateSettlementLine({
        quantity_numerator: 1,
        quantity_denominator: 1,
        unit_rate_cents: inputLine.approved_amount_cents,
        price_basis: 'inclusive_gst',
        gst_registered: profile.gst_status === 'registered',
      })
      const person = people.get(inputLine.user_id) || newPerson(inputLine.user_id, profile.user_name)
      person.user_name = profile.user_name
      person.profile = profile
      person.lines.push({
        ...inputLine,
        source_audit_id: inputLine.source_audit_id || null,
        property_id: inputLine.property_id || null,
        property_label: inputLine.property_label || null,
        property_type: propertyType || null,
        task_type: inputLine.task_type || null,
        quantity_numerator: 1,
        quantity_denominator: 1,
        unit_rate_cents: inputLine.approved_amount_cents,
        price_basis: 'inclusive_gst',
        profile_id: profile.id,
        gst_registered: profile.gst_status === 'registered',
        rule_id: null,
        rule_item_id: null,
        ...amounts,
      })
      people.set(inputLine.user_id, person)
      return
    }
    const userRules = rulesByUser.get(inputLine.user_id) || []
    const rule = selectUniqueEffective(userRules, inputLine.service_date)
    if (!rule) {
      warn(inputLine.user_id, inputLine.user_name || profile.user_name, inputLine.source_type, inputLine.source_id,
        userRules.filter((row) => dateContains(row, inputLine.service_date)).length > 1
          ? 'ambiguous_effective_rule'
          : 'missing_effective_rule')
      return
    }
    if (inputLine.component_type === 'cleaning_task' && !CLEANING_PROPERTY_TYPE_SET.has(propertyType)) {
      warn(inputLine.user_id, profile.user_name, inputLine.source_type, inputLine.source_id, 'missing_or_unsupported_property_type')
      return
    }
    const selected = chooseRuleItem(
      rule.items,
      inputLine.component_type,
      inputLine.property_id,
      inputLine.task_type,
      propertyType,
    )
    if (selected.ambiguous && inputLine.approved_amount_cents == null) {
      warn(inputLine.user_id, profile.user_name, inputLine.source_type, inputLine.source_id, 'ambiguous_rule_item')
      return
    }
    if (!selected.item && inputLine.approved_amount_cents == null) {
      warn(
        inputLine.user_id,
        profile.user_name,
        inputLine.source_type,
        inputLine.source_id,
        inputLine.component_type === 'cleaning_task' ? 'missing_cleaning_property_type_rate' : 'missing_rule_item',
      )
      return
    }
    const unitRateCents = inputLine.approved_amount_cents == null
      ? selected.item!.rate_cents
      : inputLine.approved_amount_cents
    const amounts = calculateSettlementLine({
      quantity_numerator: inputLine.approved_amount_cents == null ? inputLine.quantity_numerator : 1,
      quantity_denominator: inputLine.approved_amount_cents == null ? inputLine.quantity_denominator : 1,
      unit_rate_cents: unitRateCents,
      price_basis: rule.price_basis,
      gst_registered: profile.gst_status === 'registered',
    })
    const person = people.get(inputLine.user_id) || newPerson(inputLine.user_id, profile.user_name)
    person.user_name = profile.user_name
    person.profile = profile
    person.lines.push({
      ...inputLine,
      source_audit_id: inputLine.source_audit_id || null,
      property_id: inputLine.property_id || null,
      property_label: inputLine.property_label || null,
      property_type: propertyType || null,
      task_type: inputLine.task_type || null,
      quantity_numerator: inputLine.approved_amount_cents == null ? inputLine.quantity_numerator : 1,
      quantity_denominator: inputLine.approved_amount_cents == null ? inputLine.quantity_denominator : 1,
      unit_rate_cents: unitRateCents,
      price_basis: rule.price_basis,
      profile_id: profile.id,
      gst_registered: profile.gst_status === 'registered',
      rule_id: rule.id,
      rule_item_id: selected.item?.id || 'approved_amount',
      ...amounts,
    })
    people.set(inputLine.user_id, person)
  }

  const uniqueCleaningAssignments = new Map<string, CleaningAssignmentCandidate>()
  for (const assignment of cleaningAssignments) {
    if (!uniqueCleaningAssignments.has(assignment.task_id)) {
      uniqueCleaningAssignments.set(assignment.task_id, assignment)
    }
  }
  let cancelledCleaningAssignments = 0
  let nonCancelledCleaningAssignments = 0
  let excludedNonCheckoutCleaningAssignments = 0
  for (const assignment of uniqueCleaningAssignments.values()) {
    const taskType = cleanText(assignment.task_type).toLowerCase()
    if (taskType !== 'checkout_clean') {
      excludedNonCheckoutCleaningAssignments += 1
      continue
    }
    const status = cleanText(assignment.task_status).toLowerCase()
    if (status === 'cancelled' || status === 'canceled') {
      cancelledCleaningAssignments += 1
      continue
    }
    nonCancelledCleaningAssignments += 1
    appendLine({
      user_id: assignment.user_id,
      user_name: assignment.user_name,
      component_type: 'cleaning_task',
      service_date: assignment.service_date,
      source_type: 'cleaning_task_assignment',
      source_id: assignment.task_id,
      property_id: assignment.property_id,
      property_label: assignment.property_label,
      property_type: assignment.property_type,
      task_type: assignment.task_type,
      description: assignment.property_label
        ? `Cleaning · ${assignment.property_label} · ${assignment.property_type || '房型未登记'}`
        : `Cleaning task · ${assignment.property_type || '房型未登记'}`,
      quantity_numerator: 1,
      quantity_denominator: 1,
    })
  }

  const eligibleCandidates: Array<{ candidate: WorkloadAuditCandidate; component: 'inspection_day' }> = []
  const excludedCandidates: Array<{
    audit_id: string
    task_id: string
    user_id: string
    action: string
    service_date: string
    reason: string
  }> = []
  for (const candidate of candidates) {
    const decision = classifyWorkloadAudit(candidate)
    if (decision.eligibility === 'excluded') {
      excludedCandidates.push({
        audit_id: candidate.audit_id,
        task_id: candidate.task_id,
        user_id: candidate.user_id,
        action: candidate.action,
        service_date: candidate.service_date,
        reason: decision.reason,
      })
      continue
    }
    if (decision.eligibility === 'manual_review' || !decision.component_type) {
      warn(candidate.user_id, candidate.performed_by_name, 'work_task_action_audit', candidate.audit_id, decision.reason)
      continue
    }
    if (decision.component_type === 'inspection_day') {
      eligibleCandidates.push({ candidate, component: 'inspection_day' })
    }
  }

  const performersByTask = new Map<string, Set<string>>()
  for (const entry of eligibleCandidates) {
    const key = `${entry.candidate.task_id}:${entry.component}`
    const performers = performersByTask.get(key) || new Set<string>()
    performers.add(entry.candidate.user_id)
    performersByTask.set(key, performers)
  }
  const conflictingTaskKeys = new Set(
    Array.from(performersByTask.entries()).filter(([, performers]) => performers.size > 1).map(([key]) => key),
  )
  const dedupedEligible = new Map<string, { candidate: WorkloadAuditCandidate; component: 'inspection_day' }>()
  const conflictWarnings = new Set<string>()
  for (const entry of eligibleCandidates) {
    const taskKey = `${entry.candidate.task_id}:${entry.component}`
    if (conflictingTaskKeys.has(taskKey)) {
      const warningKey = `${entry.candidate.user_id}:${taskKey}`
      if (!conflictWarnings.has(warningKey)) {
        warn(
          entry.candidate.user_id,
          entry.candidate.performed_by_name,
          'work_task_action_audit',
          entry.candidate.task_id,
          'multiple_performers_for_task',
        )
        conflictWarnings.add(warningKey)
      }
      continue
    }
    const key = `${entry.candidate.user_id}:${entry.candidate.task_id}:${entry.component}`
    if (!dedupedEligible.has(key)) dedupedEligible.set(key, entry)
  }

  const inspectionDays = new Map<string, { user_id: string; user_name: string | null; service_date: string; task_ids: string[] }>()
  for (const { candidate, component } of dedupedEligible.values()) {
    const key = `${candidate.user_id}:${candidate.service_date}`
    const day = inspectionDays.get(key) || {
      user_id: candidate.user_id,
      user_name: candidate.performed_by_name,
      service_date: candidate.service_date,
      task_ids: [],
    }
    day.task_ids.push(candidate.task_id)
    inspectionDays.set(key, day)
  }
  for (const day of inspectionDays.values()) {
    appendLine({
      user_id: day.user_id,
      user_name: day.user_name,
      component_type: 'inspection_day',
      service_date: day.service_date,
      source_type: 'work_task_action_audit',
      source_id: `inspection-day:${day.service_date}`,
      description: `Inspection day · ${day.task_ids.length} task(s)`,
      quantity_numerator: 1,
      quantity_denominator: 1,
    })
  }

  for (const claim of claims) {
    const approvedAmount = claim.approved_amount_cents == null
      ? null
      : toSafeNonNegativeInteger(claim.approved_amount_cents, 'approved_amount_cents')
    let ratio: { numerator: number; denominator: number } | null = null
    if (approvedAmount == null) {
      if (claim.claim_type.endsWith('_hour') || claim.claim_type === 'new_property_task') {
        const minutes = claim.approved_duration_minutes ?? claim.duration_minutes
        if (minutes != null) ratio = { numerator: toSafeNonNegativeInteger(minutes, 'duration_minutes'), denominator: 60 }
      } else {
        ratio = decimalQuantityToRatio(claim.approved_quantity ?? claim.requested_quantity ?? '1')
      }
    }
    if (approvedAmount == null && !ratio) {
      warn(claim.submitter_user_id, null, 'workload_claim', claim.id, 'approved_quantity_or_amount_missing')
      continue
    }
    appendLine({
      user_id: claim.submitter_user_id,
      component_type: claim.claim_type,
      service_date: claim.service_date,
      source_type: 'workload_claim',
      source_id: claim.id,
      property_id: claim.property_id,
      description: claim.note || claim.claim_type,
      quantity_numerator: ratio?.numerator || 1,
      quantity_denominator: ratio?.denominator || 1,
      approved_amount_cents: approvedAmount,
    })
  }

  for (const [userId, userProfiles] of profilesByUser.entries()) {
    const profile = selectUniqueEffective(userProfiles, period.week_end)
    const userRules = rulesByUser.get(userId) || []
    const rule = selectUniqueEffective(userRules, period.week_end)
    if (!profile || !rule) continue
    const selected = chooseRuleItem(rule.items, 'weekly_fixed')
    if (!selected.item || selected.ambiguous) continue
    appendLine({
      user_id: userId,
      user_name: profile.user_name,
      component_type: 'weekly_fixed',
      service_date: period.week_end,
      source_type: 'weekly_rule',
      source_id: `${rule.id}:${period.week_start}`,
      description: 'Weekly fixed fee',
      quantity_numerator: 1,
      quantity_denominator: 1,
    })
  }

  const peopleResult = Array.from(people.values()).map((person) => {
    person.lines.sort((a, b) => a.service_date.localeCompare(b.service_date) || a.source_id.localeCompare(b.source_id))
    person.totals = aggregateSettlementAmounts(person.lines)
    if (!person.profile) {
      person.profile = selectUniqueEffective(profilesByUser.get(person.user_id) || [], period.week_end)
    }
    person.effective_profiles = profilesByUser.get(person.user_id) || []
    return person
  }).sort((a, b) => a.user_name.localeCompare(b.user_name) || a.user_id.localeCompare(b.user_id))

  return {
    mode: 'read_only_preview' as const,
    calculation_version: PERSONNEL_SETTLEMENT_CALCULATION_VERSION,
    period,
    people: peopleResult,
    totals: aggregateSettlementAmounts(peopleResult.map((person) => person.totals)),
    source_summary: {
      audited_candidates: candidates.length,
      eligible_deduplicated_candidates: dedupedEligible.size,
      excluded_auxiliary_candidates: excludedCandidates.length,
      conflicting_tasks_requiring_manual_review: conflictingTaskKeys.size,
      cleaning_assignment_candidates: uniqueCleaningAssignments.size,
      non_cancelled_cleaning_assignments: nonCancelledCleaningAssignments,
      excluded_cancelled_cleaning_assignments: cancelledCleaningAssignments,
      excluded_non_checkout_cleaning_assignments: excludedNonCheckoutCleaningAssignments,
      approved_claims: claims.length,
      legacy_tasks_requiring_manual_review: 0,
    },
    excluded_candidates: excludedCandidates,
    manual_review: {
      legacy_tasks_without_performer_audit: [],
      warnings: peopleResult.flatMap((person) => person.warnings.map((warning) => ({
        user_id: person.user_id,
        user_name: person.user_name,
        ...warning,
      }))),
    },
  }
}
