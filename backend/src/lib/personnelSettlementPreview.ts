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
import { activeCleaningTaskWhereSql, validCleaningTaskOrderWhereSql } from '../services/cleaningSync'
import { openDeferredInspectionStatusSql } from './cleaningInspection'

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
  status: 'submitted' | 'approved'
  submitter_user_id: string
  service_date: string
  claim_type: SettlementComponentType
  property_id: string | null
  cleaning_task_id: string | null
  duration_minutes: number | null
  approved_duration_minutes: number | null
  requested_quantity: string | number | null
  approved_quantity: string | number | null
  requested_amount_cents: string | number | null
  approved_amount_cents: string | number | null
  note: string | null
}

type CleaningAssignmentCandidate = {
  task_id: string
  component_type?: 'cleaning_task' | 'inspection_day'
  user_id: string
  user_name: string | null
  service_date: string
  current_service_date?: string | null
  arrangement_reason?: string | null
  inspection_due_date?: string | null
  inspection_mode?: string | null
  task_status: string | null
  property_id: string | null
  property_label: string | null
  property_type: string | null
  task_type: string | null
}

type CleaningPaymentAssignment = {
  task_id: string
  business_key: string
  duplicate_count: string | number | null
  user_id: string
  user_name: string | null
  service_date: string
  scheduled_service_date: string
  actual_service_date: string | null
  actual_audit_id: string | null
  actual_performed_at: string | null
  actual_metadata: Record<string, unknown> | null
  property_id: string | null
  property_label: string | null
  property_type: string | null
  task_type: string | null
  inspection_due_date: string | null
  inspection_mode: string | null
}

type InspectionPaymentAssignment = {
  task_id: string
  inspection_key: string
  execution_task_id: string
  user_id: string | null
  user_name: string | null
  service_date: string
  scheduled_service_date: string | null
  property_id: string | null
  property_label: string | null
  property_type: string | null
  task_type: string | null
  inspection_due_date: string | null
  inspection_mode: string | null
  assignment_source: 'current' | 'preserved_auto_change'
  inspection_scope_state: 'billable' | 'legacy_default' | 'requires_review'
  inspection_scope_issue: 'inspection_scope_invalid_for_task' | null
  property_snapshot_missing: boolean
  execution_assignment_conflict: boolean
  is_payable: boolean
  submission_count: string | number | null
  submitter_user_ids: string[] | null
  latest_audit_id: string | null
  latest_performed_at: string | null
  latest_performed_by_user_id: string | null
  latest_performed_by_name: string | null
  latest_metadata: Record<string, unknown> | null
}

type CarryAdjustmentRow = {
  id: string
  source_settlement_id: string
  source_adjustment_id: string
  user_id: string
  source_week_start: string
  source_week_end: string
  target_week_start: string
  target_week_end: string
  recorded_subtotal_difference_cents: string | number
  recorded_gst_difference_cents: string | number
  recorded_total_difference_cents: string | number
  previously_applied_subtotal_cents: string | number
  previously_applied_gst_cents: string | number
  previously_applied_total_cents: string | number
  applied_subtotal_cents: string | number
  applied_gst_cents: string | number
  applied_total_cents: string | number
  reason: string
  applied_by: string
  applied_at: string
}

type SettlementAuditCandidate = WorkloadAuditCandidate & {
  current_assignee_user_id?: string | null
  task_execution_state?: string | null
  task_order_id?: string | null
  order_status?: string | null
}

type PreviewLine = SettlementLineAmounts & {
  component_type: SettlementComponentType
  service_date: string
  source_type: 'cleaning_task_assignment' | 'inspection_task_assignment' | 'work_task_action_audit' | 'workload_claim' | 'weekly_rule' | 'post_payment_adjustment'
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
  work_items: SettlementWorkItem[]
  carry_adjustment?: {
    source_settlement_id: string
    source_adjustment_id: string
    source_week_start: string
    source_week_end: string
    recorded_subtotal_difference_cents: number
    recorded_gst_difference_cents: number
    recorded_total_difference_cents: number
    previously_applied_subtotal_cents: number
    previously_applied_gst_cents: number
    previously_applied_total_cents: number
    applied_subtotal_cents: number
    applied_gst_cents: number
    applied_total_cents: number
    applied_by: string
    applied_at: string
  }
}

export type SettlementWorkItem = {
  execution_key: string
  audit_id: string | null
  task_id: string
  component_type: 'cleaning_task' | 'inspection_day'
  service_date: string | null
  performed_at: string | null
  performed_by_user_id: string | null
  performed_by_name: string | null
  property_id: string | null
  property_label: string | null
  property_type: string | null
  task_type: string | null
  scheduled_service_date: string | null
  current_scheduled_service_date: string | null
  inspection_due_date: string | null
  inspection_mode: string | null
  evidence_count: number
  evidence: Array<Record<string, unknown>>
  status: 'completed' | 'payable' | 'expected' | 'rescheduled' | 'incomplete' | 'management_closed' | 'legacy_completed_unverified' | 'cancelled'
  status_reason: string
  included_in_amount: boolean
  requires_manual_review: boolean
}

type PersonPreview = {
  user_id: string
  user_name: string
  profile: ProfileRow | null
  effective_profiles: ProfileRow[]
  lines: PreviewLine[]
  work_checklist: SettlementWorkItem[]
  totals: SettlementLineAmounts
  warnings: Array<{
    source_type: string
    source_id: string
    reason: string
    service_date?: string
    component_type?: SettlementComponentType
    description?: string
    task_id?: string
    property_id?: string | null
    property_label?: string | null
    work_items?: SettlementWorkItem[]
  }>
}

function cleanText(value: unknown) {
  return String(value ?? '').trim()
}

function jsonObject(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
}

function candidateExecutionKey(candidate: WorkloadAuditCandidate, component: 'cleaning_task' | 'inspection_day') {
  const metadata = jsonObject(candidate.metadata)
  const canonicalPrefix = component === 'cleaning_task' ? 'cleaning' : 'inspection'
  const raw = cleanText(metadata.execution_key)
  if (!raw) return `${canonicalPrefix}:${candidate.task_id}`
  if (raw === `cleaning_task:${candidate.task_id}` || raw === `inspection_day:${candidate.task_id}`) {
    return `${canonicalPrefix}:${candidate.task_id}`
  }
  return raw
}

function candidateWorkItem(candidate: WorkloadAuditCandidate, component: 'cleaning_task' | 'inspection_day'): SettlementWorkItem {
  const metadata = jsonObject(candidate.metadata)
  const taskSnapshot = jsonObject(metadata.task_snapshot)
  const evidence = Array.isArray(metadata.evidence_snapshot)
    ? metadata.evidence_snapshot.filter((item: unknown) => item && typeof item === 'object') as Array<Record<string, unknown>>
    : []
  return {
    execution_key: candidateExecutionKey(candidate, component),
    audit_id: candidate.audit_id,
    task_id: candidate.task_id,
    component_type: component,
    service_date: candidate.service_date,
    performed_at: candidate.performed_at,
    performed_by_user_id: candidate.user_id,
    performed_by_name: candidate.performed_by_name,
    property_id: candidate.property_id,
    property_label: candidate.property_label,
    property_type: candidate.property_type,
    task_type: candidate.task_type,
    scheduled_service_date: cleanText(taskSnapshot.scheduled_service_date).slice(0, 10) || null,
    current_scheduled_service_date: null,
    inspection_due_date: cleanText(taskSnapshot.inspection_due_date).slice(0, 10) || null,
    inspection_mode: cleanText(taskSnapshot.inspection_mode) || null,
    evidence_count: Number.isSafeInteger(Number(metadata.evidence_count))
      ? Math.max(0, Number(metadata.evidence_count))
      : evidence.length,
    evidence,
    status: 'completed',
    status_reason: 'completed_with_execution_audit',
    included_in_amount: true,
    requires_manual_review: false,
  }
}

function cleaningPaymentWorkItem(assignment: CleaningPaymentAssignment): SettlementWorkItem {
  const metadata = jsonObject(assignment.actual_metadata)
  const evidence = Array.isArray(metadata.evidence_snapshot)
    ? metadata.evidence_snapshot.filter((item: unknown) => item && typeof item === 'object') as Array<Record<string, unknown>>
    : []
  const hasActualExecution = !!cleanText(assignment.actual_audit_id)
  return {
    execution_key: `cleaning:${assignment.task_id}`,
    audit_id: hasActualExecution ? assignment.actual_audit_id : null,
    task_id: assignment.task_id,
    component_type: 'cleaning_task',
    service_date: assignment.service_date,
    performed_at: hasActualExecution ? assignment.actual_performed_at : null,
    performed_by_user_id: hasActualExecution ? assignment.user_id : null,
    performed_by_name: hasActualExecution ? assignment.user_name : null,
    property_id: assignment.property_id,
    property_label: assignment.property_label,
    property_type: assignment.property_type,
    task_type: assignment.task_type,
    scheduled_service_date: assignment.scheduled_service_date,
    current_scheduled_service_date: assignment.scheduled_service_date,
    inspection_due_date: cleanText(assignment.inspection_due_date).slice(0, 10) || null,
    inspection_mode: cleanText(assignment.inspection_mode) || null,
    evidence_count: Number.isSafeInteger(Number(metadata.evidence_count))
      ? Math.max(0, Number(metadata.evidence_count))
      : evidence.length,
    evidence,
    // Settlement eligibility is assignment-based.  Do not manufacture a
    // completed workflow state when the cleaner never submitted completion.
    status: hasActualExecution ? 'completed' : 'incomplete',
    status_reason: hasActualExecution
      ? 'active_assignment_with_execution_date'
      : 'active_assignment_without_execution_record',
    included_in_amount: true,
    requires_manual_review: false,
  }
}

function inspectionPaymentWorkItem(assignment: InspectionPaymentAssignment): SettlementWorkItem {
  const metadata = jsonObject(assignment.latest_metadata)
  const evidence = Array.isArray(metadata.evidence_snapshot)
    ? metadata.evidence_snapshot.filter((item: unknown) => item && typeof item === 'object') as Array<Record<string, unknown>>
    : []
  const submissionCount = Math.max(0, Number(assignment.submission_count || 0))
  return {
    execution_key: assignment.inspection_key || `inspection:${assignment.task_id}`,
    audit_id: cleanText(assignment.latest_audit_id) || null,
    task_id: assignment.task_id,
    component_type: 'inspection_day',
    service_date: assignment.service_date,
    performed_at: cleanText(assignment.latest_performed_at) || null,
    performed_by_user_id: submissionCount > 0 ? assignment.latest_performed_by_user_id : null,
    performed_by_name: submissionCount > 0 ? assignment.latest_performed_by_name : null,
    property_id: assignment.property_id,
    property_label: assignment.property_label,
    property_type: assignment.property_type,
    task_type: assignment.task_type,
    scheduled_service_date: assignment.scheduled_service_date,
    current_scheduled_service_date: assignment.service_date,
    inspection_due_date: assignment.inspection_due_date,
    inspection_mode: assignment.inspection_mode,
    evidence_count: Number.isSafeInteger(Number(metadata.evidence_count))
      ? Math.max(0, Number(metadata.evidence_count))
      : evidence.length,
    evidence,
    status: assignment.is_payable ? 'payable' : 'expected',
    status_reason: assignment.is_payable
      ? 'effective_inspection_assignment_after_day_end'
      : 'effective_inspection_assignment_expected',
    included_in_amount: assignment.is_payable,
    requires_manual_review: false,
  }
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

function toSafeSignedInteger(value: unknown, field: string) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < -100_000_000 || parsed > 100_000_000) {
    throw new Error(`${field}_invalid`)
  }
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
    work_checklist: [],
    totals: { subtotal_cents: 0, gst_cents: 0, total_cents: 0 },
    warnings: [],
  }
}

export async function buildPersonnelSettlementPreview(input: {
  week_start: string
  user_ids?: string[]
  include_submitted_claims?: boolean
}, executor: Queryable | null = pgPool) {
  if (!executor) throw new Error('pg_required')
  const period = buildSettlementPeriod(input.week_start)
  const userIds = Array.from(new Set((input.user_ids || []).map(cleanText).filter(Boolean)))
  const userFilter = userIds.length ? userIds : null
  const params = [period.week_start, period.week_end, userFilter]

  const [profileResult, ruleResult, auditResult, claimResult, cleaningAssignmentResult, cleaningPaymentResult] = await Promise.all([
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
      `WITH scoped_tasks AS (
         SELECT DISTINCT a.source_id::text AS task_id
           FROM work_task_action_audits a
          WHERE a.source_type = 'cleaning_tasks'
            AND a.performed_as_action = ANY($4::text[])
            AND NULLIF(TRIM(a.performed_by_user_id), '') IS NOT NULL
            AND COALESCE(
              NULLIF(TRIM(a.metadata->>'actual_service_date'), '')::date,
              (a.performed_at AT TIME ZONE 'Australia/Melbourne')::date
            ) BETWEEN $1::date AND $2::date
            AND ($3::text[] IS NULL OR a.performed_by_user_id = ANY($3::text[]))
         UNION
         SELECT t.id::text AS task_id
           FROM cleaning_tasks t
          WHERE COALESCE(t.task_date, t.date) BETWEEN $1::date AND $2::date
            AND ($3::text[] IS NULL OR COALESCE(t.cleaner_id::text, t.assignee_id::text) = ANY($3::text[]))
         UNION
         SELECT t.id::text AS task_id
           FROM cleaning_tasks t
          WHERE (CASE
                  WHEN lower(COALESCE(t.inspection_mode, '')) = 'deferred' AND t.inspection_due_date IS NOT NULL
                    THEN t.inspection_due_date
                  ELSE COALESCE(t.task_date, t.date)
                END) BETWEEN $1::date AND $2::date
            AND lower(COALESCE(t.inspection_mode, '')) IN ('same_day', 'deferred')
            AND ($3::text[] IS NULL OR t.inspector_id::text = ANY($3::text[]))
         UNION
         SELECT replace(e.task_id, 'cleaning_task:', '') AS task_id
           FROM work_task_events e
          WHERE e.payload#>>'{arrangement_revision,version}' = 'mz031-v1'
            AND (
              NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,scheduled_service_date}'), '')::date BETWEEN $1::date AND $2::date
              OR NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspection_due_date}'), '')::date BETWEEN $1::date AND $2::date
            )
            AND ($3::text[] IS NULL
              OR NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,cleaner_id}'), '') = ANY($3::text[])
              OR NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspector_id}'), '') = ANY($3::text[])
              OR NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,assignee_id}'), '') = ANY($3::text[]))
       )
       SELECT a.id AS audit_id, a.source_id AS task_id,
              a.performed_by_user_id AS user_id, a.performed_by_name,
              a.performed_as_action AS action, a.performed_at::text,
              COALESCE(
                NULLIF(TRIM(a.metadata->>'actual_service_date'), '')::date,
                (a.performed_at AT TIME ZONE 'Australia/Melbourne')::date
              )::text AS service_date,
              COALESCE(NULLIF(TRIM(a.metadata->'property_snapshot'->>'property_id'), ''), t.property_id::text) AS property_id,
              COALESCE(
                NULLIF(TRIM(a.metadata->'property_snapshot'->>'property_label'), ''),
                NULLIF(TRIM(p.code), ''), NULLIF(TRIM(p.address), ''), t.property_id::text
              ) AS property_label,
              COALESCE(NULLIF(TRIM(a.metadata->'property_snapshot'->>'property_type'), ''), NULLIF(TRIM(p.type), '')) AS property_type,
              COALESCE(
                NULLIF(TRIM(a.metadata->'task_snapshot'->>'task_type'), ''),
                NULLIF(TRIM(t.task_type), ''), NULLIF(TRIM(t.type), '')
              ) AS task_type,
              t.status AS task_status, t.execution_state AS task_execution_state,
              t.order_id::text AS task_order_id,
              o.status AS order_status,
              t.inspector_id::text AS current_assignee_user_id,
              a.status_after, a.metadata
         FROM work_task_action_audits a
         LEFT JOIN cleaning_tasks t ON t.id::text = a.source_id::text
         LEFT JOIN orders o ON o.id::text = t.order_id::text
         LEFT JOIN properties p ON p.id::text = COALESCE(
           NULLIF(TRIM(a.metadata->'property_snapshot'->>'property_id'), ''),
           t.property_id::text
         )
        WHERE a.source_type = 'cleaning_tasks'
          AND a.performed_as_action = ANY($4::text[])
          AND NULLIF(TRIM(a.performed_by_user_id), '') IS NOT NULL
          AND a.source_id::text IN (SELECT task_id FROM scoped_tasks)
        ORDER BY a.performed_at, a.id`,
      [period.week_start, period.week_end, userFilter, ['fill_supplies', 'complete_cleaning']],
    ),
    executor.query(
      `SELECT id, status, submitter_user_id, service_date::text, claim_type, property_id,
              cleaning_task_id, duration_minutes, approved_duration_minutes,
              requested_quantity, approved_quantity,
              requested_amount_cents, approved_amount_cents, note
         FROM personnel_workload_claims
        WHERE status = ANY($4::text[])
          AND service_date BETWEEN $1::date AND $2::date
          AND ($3::text[] IS NULL OR submitter_user_id = ANY($3::text[]))
        ORDER BY service_date, id`,
      [...params, input.include_submitted_claims ? ['approved', 'submitted'] : ['approved']],
    ),
    executor.query(
      `WITH planned AS (
         SELECT t.id::text AS task_id,
                'cleaning_task'::text AS component_type,
                COALESCE(t.task_date, t.date)::text AS service_date,
                COALESCE(t.task_date, t.date)::text AS current_service_date,
                (
                  SELECT CASE
                    WHEN latest.payload#>'{arrangement_revision,reasons}' @> '["management_closed"]'::jsonb
                      THEN 'management_closed_without_execution'
                    ELSE NULL
                  END
                    FROM work_task_events latest
                   WHERE latest.task_id = 'cleaning_task:' || t.id::text
                     AND latest.payload#>>'{arrangement_revision,version}' = 'mz031-v1'
                     AND (
                       latest.payload#>'{arrangement_revision,reasons}' @> '["management_closed"]'::jsonb
                       OR latest.payload#>'{arrangement_revision,reasons}' @> '["management_reopened"]'::jsonb
                     )
                   ORDER BY latest.sequence_no DESC
                   LIMIT 1
                ) AS arrangement_reason,
                t.inspection_due_date::text AS inspection_due_date,
                t.inspection_mode,
                t.status AS task_status,
                COALESCE(t.cleaner_id::text, t.assignee_id::text) AS user_id,
                COALESCE(
                  NULLIF(TRIM(u.display_name), ''), NULLIF(TRIM(u.username), ''),
                  NULLIF(TRIM(u.legal_name), ''),
                  COALESCE(t.cleaner_id::text, t.assignee_id::text)
                ) AS user_name,
                t.property_id, COALESCE(NULLIF(TRIM(p.code), ''), NULLIF(TRIM(p.address), ''), t.property_id) AS property_label,
                NULLIF(TRIM(p.type), '') AS property_type,
                COALESCE(NULLIF(TRIM(t.task_type), ''), NULLIF(TRIM(t.type), '')) AS task_type,
                CASE WHEN (
                  SELECT latest.payload#>'{arrangement_revision,reasons}' @> '["management_closed"]'::jsonb
                    FROM work_task_events latest
                   WHERE latest.task_id = 'cleaning_task:' || t.id::text
                     AND latest.payload#>>'{arrangement_revision,version}' = 'mz031-v1'
                     AND (
                       latest.payload#>'{arrangement_revision,reasons}' @> '["management_closed"]'::jsonb
                       OR latest.payload#>'{arrangement_revision,reasons}' @> '["management_reopened"]'::jsonb
                     )
                   ORDER BY latest.sequence_no DESC
                   LIMIT 1
                ) THEN 2 ELSE 0 END AS plan_priority,
                0::bigint AS plan_order
           FROM cleaning_tasks t
           LEFT JOIN properties p ON p.id::text = t.property_id::text
           LEFT JOIN users u ON u.id::text = COALESCE(t.cleaner_id::text, t.assignee_id::text)
          WHERE COALESCE(t.task_date, t.date) BETWEEN $1::date AND $2::date
            AND lower(COALESCE(t.task_type, t.type, '')) = 'checkout_clean'
            AND NULLIF(TRIM(COALESCE(t.cleaner_id::text, t.assignee_id::text)), '') IS NOT NULL
            AND ($3::text[] IS NULL OR COALESCE(t.cleaner_id::text, t.assignee_id::text) = ANY($3::text[]))
         UNION ALL
         SELECT t.id::text AS task_id,
                'inspection_day'::text AS component_type,
                (CASE
                  WHEN lower(COALESCE(t.inspection_mode, '')) = 'deferred' AND t.inspection_due_date IS NOT NULL
                    THEN t.inspection_due_date
                  ELSE COALESCE(t.task_date, t.date)
                END)::text AS service_date,
                (CASE
                  WHEN lower(COALESCE(t.inspection_mode, '')) = 'deferred' AND t.inspection_due_date IS NOT NULL
                    THEN t.inspection_due_date
                  ELSE COALESCE(t.task_date, t.date)
                END)::text AS current_service_date,
                (
                  SELECT CASE
                    WHEN latest.payload#>'{arrangement_revision,reasons}' @> '["management_closed"]'::jsonb
                      THEN 'management_closed_without_execution'
                    ELSE NULL
                  END
                    FROM work_task_events latest
                   WHERE latest.task_id = 'cleaning_task:' || t.id::text
                     AND latest.payload#>>'{arrangement_revision,version}' = 'mz031-v1'
                     AND (
                       latest.payload#>'{arrangement_revision,reasons}' @> '["management_closed"]'::jsonb
                       OR latest.payload#>'{arrangement_revision,reasons}' @> '["management_reopened"]'::jsonb
                     )
                   ORDER BY latest.sequence_no DESC
                   LIMIT 1
                ) AS arrangement_reason,
                t.inspection_due_date::text AS inspection_due_date,
                t.inspection_mode,
                t.status AS task_status,
                t.inspector_id::text AS user_id,
                COALESCE(
                  NULLIF(TRIM(u.display_name), ''), NULLIF(TRIM(u.username), ''),
                  NULLIF(TRIM(u.legal_name), ''),
                  t.inspector_id::text
                ) AS user_name,
                t.property_id, COALESCE(NULLIF(TRIM(p.code), ''), NULLIF(TRIM(p.address), ''), t.property_id) AS property_label,
                NULLIF(TRIM(p.type), '') AS property_type,
                COALESCE(NULLIF(TRIM(t.task_type), ''), NULLIF(TRIM(t.type), '')) AS task_type,
                CASE WHEN (
                  SELECT latest.payload#>'{arrangement_revision,reasons}' @> '["management_closed"]'::jsonb
                    FROM work_task_events latest
                   WHERE latest.task_id = 'cleaning_task:' || t.id::text
                     AND latest.payload#>>'{arrangement_revision,version}' = 'mz031-v1'
                     AND (
                       latest.payload#>'{arrangement_revision,reasons}' @> '["management_closed"]'::jsonb
                       OR latest.payload#>'{arrangement_revision,reasons}' @> '["management_reopened"]'::jsonb
                     )
                   ORDER BY latest.sequence_no DESC
                   LIMIT 1
                ) THEN 2 ELSE 0 END AS plan_priority,
                0::bigint AS plan_order
           FROM cleaning_tasks t
           LEFT JOIN properties p ON p.id::text = t.property_id::text
           LEFT JOIN users u ON u.id::text = t.inspector_id::text
          WHERE (CASE
                  WHEN lower(COALESCE(t.inspection_mode, '')) = 'deferred' AND t.inspection_due_date IS NOT NULL
                    THEN t.inspection_due_date
                  ELSE COALESCE(t.task_date, t.date)
                END) BETWEEN $1::date AND $2::date
            AND lower(COALESCE(t.task_type, t.type, '')) IN ('checkout_clean', 'checkin_clean')
            AND lower(COALESCE(t.inspection_mode, '')) IN ('same_day', 'deferred')
            AND lower(COALESCE(t.inspection_scope, 'inspect_and_hang')) <> 'password_only'
            AND t.inspector_id IS NOT NULL
            AND ($3::text[] IS NULL OR t.inspector_id::text = ANY($3::text[]))
         UNION ALL
         SELECT t.id::text AS task_id,
                'cleaning_task'::text AS component_type,
                NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,scheduled_service_date}'), '')::date::text AS service_date,
                COALESCE(t.task_date, t.date)::text AS current_service_date,
                CASE
                  WHEN NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,scheduled_service_date}'), '')
                    IS DISTINCT FROM NULLIF(TRIM(e.payload#>>'{arrangement_revision,after,scheduled_service_date}'), '')
                    THEN 'rescheduled_after_plan'
                  WHEN COALESCE(
                    NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,cleaner_id}'), ''),
                    NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,assignee_id}'), '')
                  ) IS DISTINCT FROM COALESCE(
                    NULLIF(TRIM(e.payload#>>'{arrangement_revision,after,cleaner_id}'), ''),
                    NULLIF(TRIM(e.payload#>>'{arrangement_revision,after,assignee_id}'), '')
                  ) THEN 'reassigned_after_plan'
                  ELSE 'inspection_plan_changed_after_plan'
                END AS arrangement_reason,
                NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspection_due_date}'), '')::date::text AS inspection_due_date,
                NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspection_mode}'), '') AS inspection_mode,
                t.status AS task_status,
                COALESCE(
                  NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,cleaner_id}'), ''),
                  NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,assignee_id}'), '')
                ) AS user_id,
                COALESCE(
                  NULLIF(TRIM(u.display_name), ''), NULLIF(TRIM(u.username), ''),
                  NULLIF(TRIM(u.legal_name), ''),
                  COALESCE(
                    NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,cleaner_id}'), ''),
                    NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,assignee_id}'), '')
                  )
                ) AS user_name,
                NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,property_id}'), '') AS property_id,
                COALESCE(
                  NULLIF(TRIM(p.code), ''), NULLIF(TRIM(p.address), ''),
                  NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,property_id}'), '')
                ) AS property_label,
                NULLIF(TRIM(p.type), '') AS property_type,
                COALESCE(NULLIF(TRIM(t.task_type), ''), NULLIF(TRIM(t.type), '')) AS task_type,
                1 AS plan_priority,
                e.sequence_no AS plan_order
           FROM work_task_events e
           JOIN cleaning_tasks t ON e.task_id = 'cleaning_task:' || t.id::text
           LEFT JOIN properties p ON p.id::text = NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,property_id}'), '')
           LEFT JOIN users u ON u.id::text = COALESCE(
             NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,cleaner_id}'), ''),
             NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,assignee_id}'), '')
           )
          WHERE e.payload#>>'{arrangement_revision,version}' = 'mz031-v1'
            AND (
              NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,scheduled_service_date}'), '')
                IS DISTINCT FROM NULLIF(TRIM(e.payload#>>'{arrangement_revision,after,scheduled_service_date}'), '')
              OR COALESCE(
                NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,cleaner_id}'), ''),
                NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,assignee_id}'), '')
              ) IS DISTINCT FROM COALESCE(
                NULLIF(TRIM(e.payload#>>'{arrangement_revision,after,cleaner_id}'), ''),
                NULLIF(TRIM(e.payload#>>'{arrangement_revision,after,assignee_id}'), '')
              )
              OR NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,property_id}'), '')
                IS DISTINCT FROM NULLIF(TRIM(e.payload#>>'{arrangement_revision,after,property_id}'), '')
            )
            AND lower(COALESCE(t.task_type, t.type, '')) = 'checkout_clean'
            AND NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,scheduled_service_date}'), '')::date BETWEEN $1::date AND $2::date
            AND COALESCE(
              NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,cleaner_id}'), ''),
              NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,assignee_id}'), '')
            ) IS NOT NULL
            AND ($3::text[] IS NULL OR COALESCE(
              NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,cleaner_id}'), ''),
              NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,assignee_id}'), '')
            ) = ANY($3::text[]))
         UNION ALL
         SELECT t.id::text AS task_id,
                'inspection_day'::text AS component_type,
                (CASE
                  WHEN lower(COALESCE(NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspection_mode}'), ''), '')) = 'deferred'
                    AND NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspection_due_date}'), '') IS NOT NULL
                    THEN NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspection_due_date}'), '')::date
                  ELSE NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,scheduled_service_date}'), '')::date
                END)::text AS service_date,
                (CASE
                  WHEN lower(COALESCE(t.inspection_mode, '')) = 'deferred' AND t.inspection_due_date IS NOT NULL
                    THEN t.inspection_due_date
                  ELSE COALESCE(t.task_date, t.date)
                END)::text AS current_service_date,
                CASE
                  WHEN e.payload#>'{arrangement_revision,reasons}' @> '["deferred_replaced_by_completed_checkin"]'::jsonb
                    THEN 'deferred_replaced_by_completed_checkin'
                  WHEN e.payload#>'{arrangement_revision,reasons}' @> '["management_closed"]'::jsonb
                    THEN 'management_closed_without_execution'
                  WHEN (CASE
                    WHEN lower(COALESCE(NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspection_mode}'), ''), '')) = 'deferred'
                      AND NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspection_due_date}'), '') IS NOT NULL
                      THEN NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspection_due_date}'), '')
                    ELSE NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,scheduled_service_date}'), '')
                  END) IS DISTINCT FROM (CASE
                    WHEN lower(COALESCE(NULLIF(TRIM(e.payload#>>'{arrangement_revision,after,inspection_mode}'), ''), '')) = 'deferred'
                      AND NULLIF(TRIM(e.payload#>>'{arrangement_revision,after,inspection_due_date}'), '') IS NOT NULL
                      THEN NULLIF(TRIM(e.payload#>>'{arrangement_revision,after,inspection_due_date}'), '')
                    ELSE NULLIF(TRIM(e.payload#>>'{arrangement_revision,after,scheduled_service_date}'), '')
                  END) THEN 'rescheduled_after_plan'
                  WHEN NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspector_id}'), '')
                    IS DISTINCT FROM NULLIF(TRIM(e.payload#>>'{arrangement_revision,after,inspector_id}'), '')
                    THEN 'reassigned_after_plan'
                  ELSE 'inspection_plan_changed_after_plan'
                END AS arrangement_reason,
                NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspection_due_date}'), '')::date::text AS inspection_due_date,
                NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspection_mode}'), '') AS inspection_mode,
                t.status AS task_status,
                NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspector_id}'), '') AS user_id,
                COALESCE(NULLIF(TRIM(u.display_name), ''), NULLIF(TRIM(u.username), ''), NULLIF(TRIM(u.legal_name), ''), u.id::text) AS user_name,
                NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,property_id}'), '') AS property_id,
                COALESCE(
                  NULLIF(TRIM(p.code), ''), NULLIF(TRIM(p.address), ''),
                  NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,property_id}'), '')
                ) AS property_label,
                NULLIF(TRIM(p.type), '') AS property_type,
                COALESCE(NULLIF(TRIM(t.task_type), ''), NULLIF(TRIM(t.type), '')) AS task_type,
                1 AS plan_priority,
                e.sequence_no AS plan_order
           FROM work_task_events e
           JOIN cleaning_tasks t ON e.task_id = 'cleaning_task:' || t.id::text
           LEFT JOIN properties p ON p.id::text = NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,property_id}'), '')
           LEFT JOIN users u ON u.id::text = NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspector_id}'), '')
          WHERE e.payload#>>'{arrangement_revision,version}' = 'mz031-v1'
            AND lower(COALESCE(t.task_type, t.type, '')) IN ('checkout_clean', 'checkin_clean')
            AND lower(COALESCE(NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspection_mode}'), ''), '')) IN ('same_day', 'deferred')
            AND lower(COALESCE(NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspection_scope}'), ''), 'inspect_and_hang')) <> 'password_only'
            AND (
              NOT (e.payload#>'{arrangement_revision,reasons}' @> '["management_closed"]'::jsonb)
              OR e.sequence_no = (
                SELECT boundary.sequence_no
                  FROM work_task_events boundary
                 WHERE boundary.task_id = e.task_id
                   AND boundary.payload#>>'{arrangement_revision,version}' = 'mz031-v1'
                   AND (
                     boundary.payload#>'{arrangement_revision,reasons}' @> '["management_closed"]'::jsonb
                     OR boundary.payload#>'{arrangement_revision,reasons}' @> '["management_reopened"]'::jsonb
                   )
                 ORDER BY boundary.sequence_no DESC
                 LIMIT 1
              )
            )
            AND (
              NOT (e.payload#>'{arrangement_revision,reasons}' @> '["deferred_replaced_by_completed_checkin"]'::jsonb)
              OR COALESCE((
                SELECT NOT (replacement_boundary.payload#>'{arrangement_revision,reasons}' @> '["deferred_replacement_restored"]'::jsonb)
                  FROM work_task_events replacement_boundary
                 WHERE replacement_boundary.task_id = e.task_id
                   AND replacement_boundary.payload#>>'{arrangement_revision,version}' = 'mz031-v1'
                   AND (
                     replacement_boundary.payload#>'{arrangement_revision,reasons}' @> '["deferred_replaced_by_completed_checkin"]'::jsonb
                     OR replacement_boundary.payload#>'{arrangement_revision,reasons}' @> '["deferred_replacement_restored"]'::jsonb
                     OR replacement_boundary.payload#>'{arrangement_revision,reasons}' @> '["deferred_replacement_relinked"]'::jsonb
                   )
                 ORDER BY replacement_boundary.sequence_no DESC
                 LIMIT 1
              ), true)
            )
            AND (
              e.payload#>'{arrangement_revision,reasons}' @> '["management_closed"]'::jsonb
              OR (CASE
                WHEN lower(COALESCE(NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspection_mode}'), ''), '')) = 'deferred'
                  AND NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspection_due_date}'), '') IS NOT NULL
                  THEN NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspection_due_date}'), '')
                ELSE NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,scheduled_service_date}'), '')
              END) IS DISTINCT FROM (CASE
                WHEN lower(COALESCE(NULLIF(TRIM(e.payload#>>'{arrangement_revision,after,inspection_mode}'), ''), '')) = 'deferred'
                  AND NULLIF(TRIM(e.payload#>>'{arrangement_revision,after,inspection_due_date}'), '') IS NOT NULL
                  THEN NULLIF(TRIM(e.payload#>>'{arrangement_revision,after,inspection_due_date}'), '')
                ELSE NULLIF(TRIM(e.payload#>>'{arrangement_revision,after,scheduled_service_date}'), '')
              END)
              OR NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspector_id}'), '')
                IS DISTINCT FROM NULLIF(TRIM(e.payload#>>'{arrangement_revision,after,inspector_id}'), '')
              OR NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspection_mode}'), '')
                IS DISTINCT FROM NULLIF(TRIM(e.payload#>>'{arrangement_revision,after,inspection_mode}'), '')
              OR NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspection_scope}'), '')
                IS DISTINCT FROM NULLIF(TRIM(e.payload#>>'{arrangement_revision,after,inspection_scope}'), '')
              OR NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,property_id}'), '')
                IS DISTINCT FROM NULLIF(TRIM(e.payload#>>'{arrangement_revision,after,property_id}'), '')
            )
            AND (CASE
              WHEN lower(COALESCE(NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspection_mode}'), ''), '')) = 'deferred'
                AND NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspection_due_date}'), '') IS NOT NULL
                THEN NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspection_due_date}'), '')::date
              ELSE NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,scheduled_service_date}'), '')::date
            END) BETWEEN $1::date AND $2::date
            AND NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspector_id}'), '') IS NOT NULL
            AND ($3::text[] IS NULL
              OR NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspector_id}'), '') = ANY($3::text[]))
       )
       SELECT DISTINCT ON (task_id, component_type, user_id, service_date)
              task_id, component_type, service_date, current_service_date, arrangement_reason,
              inspection_due_date, inspection_mode, task_status, user_id, user_name,
              property_id, property_label, property_type, task_type
         FROM planned
        ORDER BY task_id, component_type, user_id, service_date, plan_priority DESC, plan_order DESC`,
      params,
    ),
    executor.query(
      `WITH payment_candidates AS (
         SELECT t.id::text AS task_id,
                CASE
                  WHEN t.order_id IS NOT NULL THEN 'checkout-order:' || t.order_id::text
                  WHEN t.property_id IS NOT NULL AND identity.original_scheduled_service_date IS NOT NULL
                    THEN 'checkout-property-date:' || t.property_id::text || ':' || identity.original_scheduled_service_date
                  ELSE 'checkout-task:' || t.id::text
                END AS business_key,
                COALESCE(t.cleaner_id::text, t.assignee_id::text) AS user_id,
                COALESCE(
                  NULLIF(TRIM(u.display_name), ''), NULLIF(TRIM(u.username), ''),
                  NULLIF(TRIM(u.legal_name), ''),
                  COALESCE(t.cleaner_id::text, t.assignee_id::text)
                ) AS user_name,
                COALESCE(t.task_date, t.date)::text AS scheduled_service_date,
                actual.actual_service_date::text AS actual_service_date,
                actual.audit_id::text AS actual_audit_id,
                actual.performed_at::text AS actual_performed_at,
                actual.metadata AS actual_metadata,
                t.property_id::text AS property_id,
                COALESCE(NULLIF(TRIM(p.code), ''), NULLIF(TRIM(p.address), ''), t.property_id::text) AS property_label,
                NULLIF(TRIM(p.type), '') AS property_type,
                COALESCE(NULLIF(TRIM(t.task_type), ''), NULLIF(TRIM(t.type), '')) AS task_type,
                t.inspection_due_date::text AS inspection_due_date,
                t.inspection_mode,
                t.updated_at
           FROM cleaning_tasks t
           LEFT JOIN orders o ON o.id::text = t.order_id::text
           LEFT JOIN LATERAL (
             SELECT COALESCE(
               (
                 SELECT NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,scheduled_service_date}'), '')::date::text
                   FROM work_task_events e
                  WHERE e.task_id = 'cleaning_task:' || t.id::text
                    AND e.payload#>>'{arrangement_revision,version}' = 'mz031-v1'
                    AND NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,scheduled_service_date}'), '') IS NOT NULL
                  ORDER BY e.sequence_no, e.id
                  LIMIT 1
               ),
               COALESCE(t.task_date, t.date)::text
             ) AS original_scheduled_service_date
           ) identity ON true
           LEFT JOIN properties p ON p.id::text = t.property_id::text
           LEFT JOIN users u ON u.id::text = COALESCE(t.cleaner_id::text, t.assignee_id::text)
           LEFT JOIN LATERAL (
             SELECT a.id AS audit_id,
                    a.performed_at,
                    a.metadata,
                    COALESCE(
                      NULLIF(TRIM(a.metadata->>'actual_service_date'), '')::date,
                      (a.performed_at AT TIME ZONE 'Australia/Melbourne')::date
                    ) AS actual_service_date
               FROM work_task_action_audits a
              WHERE a.source_type = 'cleaning_tasks'
                AND a.source_id::text = t.id::text
                AND a.performed_by_user_id = COALESCE(t.cleaner_id::text, t.assignee_id::text)
                AND a.performed_as_action = ANY($4::text[])
                AND lower(COALESCE(a.status_after, '')) IN (
                  'cleaned', 'restock_pending', 'restocked', 'to_inspect', 'to_hang_keys',
                  'keys_hung', 'inspected', 'ready', 'completed', 'done'
                )
                AND lower(COALESCE(a.metadata->>'route', '')) <> 'mzapp.cleaning_tasks.restock_proof'
                AND lower(COALESCE(a.metadata->>'step', '')) <> 'completion_photos_saved'
                AND NOT (
                  COALESCE(a.metadata->>'execution_record_version', '') = 'mz031-v1'
                  AND lower(COALESCE(a.metadata->>'status_before_snapshot', '')) IN ('cancelled', 'canceled')
                )
              ORDER BY COALESCE(
                NULLIF(TRIM(a.metadata->>'actual_service_date'), '')::date,
                (a.performed_at AT TIME ZONE 'Australia/Melbourne')::date
              ), a.performed_at, a.id
              LIMIT 1
           ) actual ON true
          WHERE lower(COALESCE(t.task_type, t.type, '')) = 'checkout_clean'
            AND NULLIF(TRIM(COALESCE(t.cleaner_id::text, t.assignee_id::text)), '') IS NOT NULL
            AND ${activeCleaningTaskWhereSql('t')}
            AND ${validCleaningTaskOrderWhereSql('t', 'o')}
       ), ranked AS (
         SELECT payment_candidates.*,
                ROW_NUMBER() OVER (
                  PARTITION BY business_key
                  ORDER BY updated_at DESC NULLS LAST, task_id DESC
                ) AS canonical_rank,
                COUNT(*) OVER (PARTITION BY business_key) AS duplicate_count
           FROM payment_candidates
       ), canonical AS (
         SELECT *
           FROM ranked
          WHERE canonical_rank = 1
       ), payable AS (
         SELECT canonical.task_id, canonical.business_key, canonical.duplicate_count,
                canonical.user_id, canonical.user_name,
                COALESCE(evidence.actual_service_date, canonical.scheduled_service_date) AS service_date,
                canonical.scheduled_service_date,
                evidence.actual_service_date, evidence.actual_audit_id,
                evidence.actual_performed_at, evidence.actual_metadata,
                canonical.property_id, canonical.property_label, canonical.property_type,
                canonical.task_type, canonical.inspection_due_date, canonical.inspection_mode
           FROM canonical
           LEFT JOIN LATERAL (
             SELECT sibling.actual_service_date, sibling.actual_audit_id,
                    sibling.actual_performed_at, sibling.actual_metadata
               FROM payment_candidates sibling
              WHERE sibling.business_key = canonical.business_key
                AND sibling.user_id = canonical.user_id
                AND sibling.actual_audit_id IS NOT NULL
              ORDER BY sibling.actual_service_date, sibling.actual_performed_at, sibling.actual_audit_id
              LIMIT 1
           ) evidence ON true
       )
       SELECT task_id, business_key, duplicate_count, user_id, user_name,
              service_date, scheduled_service_date, actual_service_date,
              actual_audit_id, actual_performed_at, actual_metadata,
              property_id, property_label, property_type, task_type,
              inspection_due_date, inspection_mode
         FROM payable
        WHERE service_date::date BETWEEN $1::date AND $2::date
          AND ($3::text[] IS NULL OR user_id = ANY($3::text[]))
        ORDER BY service_date, business_key, user_id`,
      [period.week_start, period.week_end, userFilter, ['fill_supplies', 'complete_cleaning']],
    ),
  ])

  // Inspection settlement is owned by the effective manager arrangement, not
  // by an upload/audit event.  The task id is the stable inspection identity.
  // A source-system date refresh after a Melbourne day has ended retains the
  // before-snapshot unless a later explicit manager revision supersedes it.
  const inspectionPaymentResult = await executor.query(
    `WITH current_inspection_assignments AS (
       SELECT t.id::text AS task_id,
              'inspection:' || t.id::text AS inspection_key,
              COALESCE(checkin_arrangement.checkin_task_id, t.id::text) AS execution_task_id,
              t.inspector_id::text AS user_id,
              (CASE
                WHEN lower(COALESCE(t.inspection_mode, '')) = 'deferred'
                  AND checkin_arrangement.effective_inspection_date IS NOT NULL
                  THEN checkin_arrangement.effective_inspection_date
                WHEN lower(COALESCE(t.inspection_mode, '')) = 'deferred' AND t.inspection_due_date IS NOT NULL
                  THEN t.inspection_due_date
                ELSE COALESCE(t.task_date, t.date)
              END) AS service_date,
              COALESCE(t.task_date, t.date) AS scheduled_service_date,
              t.property_id::text AS property_id,
              COALESCE(NULLIF(TRIM(t.task_type), ''), NULLIF(TRIM(t.type), '')) AS task_type,
              t.inspection_due_date,
              lower(COALESCE(t.inspection_mode, '')) AS inspection_mode,
              'current'::text AS assignment_source,
              (CASE
                WHEN lower(COALESCE(NULLIF(TRIM(t.inspection_scope), ''), '')) = 'inspect_and_hang'
                  THEN 'billable'
                WHEN NULLIF(TRIM(t.inspection_scope), '') IS NULL
                  AND lower(COALESCE(NULLIF(TRIM(t.task_type), ''), NULLIF(TRIM(t.type), ''), ''))
                    IN ('checkout_clean', 'checkout_cleaning', 'checkin_clean')
                  THEN 'legacy_default'
                ELSE 'requires_review'
              END)::text AS inspection_scope_state,
              (CASE
                WHEN NULLIF(TRIM(t.inspection_scope), '') IS NULL
                  AND lower(COALESCE(NULLIF(TRIM(t.task_type), ''), NULLIF(TRIM(t.type), ''), ''))
                    IN ('checkout_clean', 'checkout_cleaning', 'checkin_clean')
                  THEN NULL
                WHEN lower(COALESCE(NULLIF(TRIM(t.inspection_scope), ''), '')) <> 'inspect_and_hang'
                  THEN 'inspection_scope_invalid_for_task'
                ELSE NULL
              END)::text AS inspection_scope_issue,
              t.property_id IS NULL AS property_snapshot_missing,
              COALESCE(
                checkin_arrangement.execution_assignment_conflict
                OR arrangement_owners.matching_deferred_count > 1,
                false
              ) AS execution_assignment_conflict
         FROM cleaning_tasks t
         LEFT JOIN orders o ON o.id::text = t.order_id::text
         LEFT JOIN properties task_property_by_id ON task_property_by_id.id::text = t.property_id::text
         LEFT JOIN properties task_property_by_code ON upper(task_property_by_code.code) = upper(t.property_id::text)
         LEFT JOIN LATERAL (
           SELECT
             (ARRAY_AGG(incoming.id::text ORDER BY COALESCE(incoming.task_date, incoming.date)::date, incoming.id::text))[1] AS checkin_task_id,
             (ARRAY_AGG(COALESCE(incoming.task_date, incoming.date)::date ORDER BY COALESCE(incoming.task_date, incoming.date)::date, incoming.id::text))[1] AS effective_inspection_date,
             (
               COUNT(*) > 1
               OR BOOL_OR(
                 t.inspector_id IS NULL
                 OR (incoming.inspector_id IS NULL AND incoming.assignee_id IS NULL)
                 OR (incoming.inspector_id IS NOT NULL AND incoming.inspector_id::text <> t.inspector_id::text)
                 OR (incoming.assignee_id IS NOT NULL AND incoming.assignee_id::text <> t.inspector_id::text)
                 OR NOT (
                   incoming.inspector_id::text = t.inspector_id::text
                   OR incoming.assignee_id::text = t.inspector_id::text
                 )
               )
             ) AS execution_assignment_conflict
           FROM cleaning_tasks incoming
           LEFT JOIN orders incoming_order ON incoming_order.id::text = incoming.order_id::text
           LEFT JOIN properties incoming_property_by_id ON incoming_property_by_id.id::text = incoming.property_id::text
           LEFT JOIN properties incoming_property_by_code ON upper(incoming_property_by_code.code) = upper(incoming.property_id::text)
          WHERE lower(COALESCE(t.inspection_mode, '')) = 'deferred'
            AND t.inspection_due_date IS NOT NULL
            AND ${openDeferredInspectionStatusSql('t')}
            AND lower(COALESCE(t.task_type, t.type, '')) IN ('checkout_clean', 'checkout_cleaning')
            AND lower(COALESCE(incoming.task_type, incoming.type, '')) = 'checkin_clean'
            AND lower(COALESCE(incoming.inspection_scope, 'inspect_and_hang')) <> 'password_only'
            AND COALESCE(incoming.task_date, incoming.date)::date BETWEEN COALESCE(t.task_date, t.date)::date AND t.inspection_due_date::date
            AND COALESCE(incoming_property_by_id.id::text, incoming_property_by_code.id::text, incoming.property_id::text)
                = COALESCE(task_property_by_id.id::text, task_property_by_code.id::text, t.property_id::text)
            AND ${activeCleaningTaskWhereSql('incoming')}
            AND ${validCleaningTaskOrderWhereSql('incoming', 'incoming_order')}
         ) checkin_arrangement ON true
         LEFT JOIN LATERAL (
           SELECT COUNT(*)::int AS matching_deferred_count
             FROM cleaning_tasks competing_deferred
             LEFT JOIN orders competing_order ON competing_order.id::text = competing_deferred.order_id::text
             LEFT JOIN properties competing_property_by_id ON competing_property_by_id.id::text = competing_deferred.property_id::text
             LEFT JOIN properties competing_property_by_code ON upper(competing_property_by_code.code) = upper(competing_deferred.property_id::text)
            WHERE checkin_arrangement.checkin_task_id IS NOT NULL
              AND lower(COALESCE(competing_deferred.task_type, competing_deferred.type, '')) IN ('checkout_clean', 'checkout_cleaning')
              AND lower(COALESCE(competing_deferred.inspection_mode, '')) = 'deferred'
              AND competing_deferred.inspection_due_date IS NOT NULL
              AND ${openDeferredInspectionStatusSql('competing_deferred')}
              AND checkin_arrangement.effective_inspection_date BETWEEN COALESCE(competing_deferred.task_date, competing_deferred.date)::date AND competing_deferred.inspection_due_date::date
              AND COALESCE(competing_property_by_id.id::text, competing_property_by_code.id::text, competing_deferred.property_id::text)
                  = COALESCE(task_property_by_id.id::text, task_property_by_code.id::text, t.property_id::text)
              AND ${activeCleaningTaskWhereSql('competing_deferred')}
              AND ${validCleaningTaskOrderWhereSql('competing_deferred', 'competing_order')}
         ) arrangement_owners ON true
        WHERE lower(COALESCE(t.inspection_mode, '')) IN ('same_day', 'deferred')
          AND NOT (
            lower(COALESCE(NULLIF(TRIM(t.task_type), ''), NULLIF(TRIM(t.type), ''), '')) = 'checkin_clean'
            AND lower(COALESCE(NULLIF(TRIM(t.inspection_scope), ''), '')) = 'password_only'
          )
          AND ${activeCleaningTaskWhereSql('t')}
          AND ${validCleaningTaskOrderWhereSql('t', 'o')}
          AND NOT EXISTS (
            SELECT 1
              FROM LATERAL (
                SELECT latest.payload#>'{arrangement_revision,reasons}' @> '["management_closed"]'::jsonb AS is_closed
                  FROM work_task_events latest
                 WHERE latest.task_id = 'cleaning_task:' || t.id::text
                   AND latest.payload#>>'{arrangement_revision,version}' = 'mz031-v1'
                   AND (
                     latest.payload#>'{arrangement_revision,reasons}' @> '["management_closed"]'::jsonb
                     OR latest.payload#>'{arrangement_revision,reasons}' @> '["management_reopened"]'::jsonb
                   )
                 ORDER BY latest.sequence_no DESC
                 LIMIT 1
              ) latest_boundary
             WHERE latest_boundary.is_closed
          )
     ), preserved_auto_changes AS (
       SELECT DISTINCT ON (t.id)
              t.id::text AS task_id,
              'inspection:' || t.id::text AS inspection_key,
              COALESCE(t.inspection_replaced_by_checkin_task_id::text, t.id::text) AS execution_task_id,
              NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspector_id}'), '') AS user_id,
              (CASE
                WHEN e.payload#>'{arrangement_revision,reasons}' @> '["deferred_replaced_by_completed_checkin"]'::jsonb
                  AND execution_task.id IS NOT NULL
                  THEN COALESCE(execution_task.task_date, execution_task.date)::date
                WHEN lower(COALESCE(e.payload#>>'{arrangement_revision,before,inspection_mode}', '')) = 'deferred'
                  AND NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspection_due_date}'), '') IS NOT NULL
                  THEN NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspection_due_date}'), '')::date
                ELSE NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,scheduled_service_date}'), '')::date
              END) AS service_date,
              NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,scheduled_service_date}'), '')::date AS scheduled_service_date,
              COALESCE(
                NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,property_id}'), ''),
                legacy_sync_snapshot.before_property_id
              ) AS property_id,
              COALESCE(NULLIF(TRIM(t.task_type), ''), NULLIF(TRIM(t.type), '')) AS task_type,
              NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspection_due_date}'), '')::date AS inspection_due_date,
              lower(COALESCE(e.payload#>>'{arrangement_revision,before,inspection_mode}', '')) AS inspection_mode,
              'preserved_auto_change'::text AS assignment_source,
              (CASE
                WHEN lower(COALESCE(NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspection_scope}'), ''), '')) = 'inspect_and_hang'
                  THEN 'billable'
                WHEN NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspection_scope}'), '') IS NULL
                  AND lower(COALESCE(NULLIF(TRIM(t.task_type), ''), NULLIF(TRIM(t.type), ''), ''))
                    IN ('checkout_clean', 'checkout_cleaning', 'checkin_clean')
                  THEN 'legacy_default'
                ELSE 'requires_review'
              END)::text AS inspection_scope_state,
              (CASE
                WHEN NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspection_scope}'), '') IS NULL
                  AND lower(COALESCE(NULLIF(TRIM(t.task_type), ''), NULLIF(TRIM(t.type), ''), ''))
                    IN ('checkout_clean', 'checkout_cleaning', 'checkin_clean')
                  THEN NULL
                WHEN lower(COALESCE(NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspection_scope}'), ''), '')) <> 'inspect_and_hang'
                  THEN 'inspection_scope_invalid_for_task'
                ELSE NULL
              END)::text AS inspection_scope_issue,
              COALESCE(
                NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,property_id}'), ''),
                legacy_sync_snapshot.before_property_id
              ) IS NULL AS property_snapshot_missing,
              (
                execution_task.id IS NOT NULL
                AND (
                  NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspector_id}'), '') IS NULL
                  OR (execution_task.inspector_id IS NULL AND execution_task.assignee_id IS NULL)
                  OR (
                    execution_task.inspector_id IS NOT NULL
                    AND execution_task.inspector_id::text <> NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspector_id}'), '')
                  )
                  OR (
                    execution_task.assignee_id IS NOT NULL
                    AND execution_task.assignee_id::text <> NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspector_id}'), '')
                  )
                )
              ) AS execution_assignment_conflict
         FROM work_task_events e
         JOIN cleaning_tasks t ON e.task_id = 'cleaning_task:' || t.id::text
         LEFT JOIN cleaning_tasks execution_task
           ON execution_task.id::text = t.inspection_replaced_by_checkin_task_id::text
         LEFT JOIN orders o ON o.id::text = t.order_id::text
         LEFT JOIN LATERAL (
           SELECT NULLIF(TRIM(log.before->>'property_id'), '') AS before_property_id
             FROM cleaning_sync_logs log
            WHERE log.task_id::text = t.id::text
              AND log.action = 'updated'
              AND log.created_at BETWEEN e.occurred_at - interval '5 minutes' AND e.occurred_at + interval '5 minutes'
              AND NULLIF(LEFT(TRIM(COALESCE(log.before->>'task_date', log.before->>'date', '')), 10), '')
                    IS NOT DISTINCT FROM NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,scheduled_service_date}'), '')
              AND NULLIF(LEFT(TRIM(COALESCE(log.after->>'task_date', log.after->>'date', '')), 10), '')
                    IS NOT DISTINCT FROM NULLIF(TRIM(e.payload#>>'{arrangement_revision,after,scheduled_service_date}'), '')
              AND NULLIF(TRIM(log.before->>'inspector_id'), '')
                    IS NOT DISTINCT FROM NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspector_id}'), '')
              AND NULLIF(TRIM(log.after->>'inspector_id'), '')
                    IS NOT DISTINCT FROM NULLIF(TRIM(e.payload#>>'{arrangement_revision,after,inspector_id}'), '')
              AND NULLIF(TRIM(log.after->>'property_id'), '') IS NOT DISTINCT FROM t.property_id::text
            ORDER BY ABS(EXTRACT(EPOCH FROM (log.created_at - e.occurred_at))), log.created_at DESC
            LIMIT 1
         ) legacy_sync_snapshot
           ON NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,property_id}'), '') IS NULL
        WHERE e.payload#>>'{arrangement_revision,version}' = 'mz031-v1'
          AND (
            e.caused_by_user_id IS NULL
            OR e.payload#>'{arrangement_revision,reasons}' @> '["deferred_replaced_by_completed_checkin"]'::jsonb
          )
          AND lower(COALESCE(e.payload#>>'{arrangement_revision,before,inspection_mode}', '')) IN ('same_day', 'deferred')
          AND NOT (
            lower(COALESCE(NULLIF(TRIM(t.task_type), ''), NULLIF(TRIM(t.type), ''), '')) = 'checkin_clean'
            AND lower(COALESCE(NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspection_scope}'), ''), '')) = 'password_only'
          )
          AND (
            e.payload#>'{arrangement_revision,reasons}' @> '["deferred_replaced_by_completed_checkin"]'::jsonb
            OR (CASE
                  WHEN e.payload#>'{arrangement_revision,reasons}' @> '["deferred_replaced_by_completed_checkin"]'::jsonb
                    AND execution_task.id IS NOT NULL
                    THEN COALESCE(execution_task.task_date, execution_task.date)::date
                  WHEN lower(COALESCE(e.payload#>>'{arrangement_revision,before,inspection_mode}', '')) = 'deferred'
                    AND NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspection_due_date}'), '') IS NOT NULL
                    THEN NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspection_due_date}'), '')::date
                  ELSE NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,scheduled_service_date}'), '')::date
                END) < (e.occurred_at AT TIME ZONE 'Australia/Melbourne')::date
          )
          AND (CASE
                WHEN e.payload#>'{arrangement_revision,reasons}' @> '["deferred_replaced_by_completed_checkin"]'::jsonb
                  AND execution_task.id IS NOT NULL
                  THEN COALESCE(execution_task.task_date, execution_task.date)::date
                WHEN lower(COALESCE(e.payload#>>'{arrangement_revision,before,inspection_mode}', '')) = 'deferred'
                  AND NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspection_due_date}'), '') IS NOT NULL
                  THEN NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspection_due_date}'), '')::date
                ELSE NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,scheduled_service_date}'), '')::date
              END) < (now() AT TIME ZONE 'Australia/Melbourne')::date
          AND (
            NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,scheduled_service_date}'), '')
              IS DISTINCT FROM NULLIF(TRIM(e.payload#>>'{arrangement_revision,after,scheduled_service_date}'), '')
            OR NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspection_due_date}'), '')
              IS DISTINCT FROM NULLIF(TRIM(e.payload#>>'{arrangement_revision,after,inspection_due_date}'), '')
            OR NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspection_mode}'), '')
              IS DISTINCT FROM NULLIF(TRIM(e.payload#>>'{arrangement_revision,after,inspection_mode}'), '')
            OR NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspection_scope}'), '')
              IS DISTINCT FROM NULLIF(TRIM(e.payload#>>'{arrangement_revision,after,inspection_scope}'), '')
            OR NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,property_id}'), '')
              IS DISTINCT FROM NULLIF(TRIM(e.payload#>>'{arrangement_revision,after,property_id}'), '')
            OR NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspector_id}'), '')
              IS DISTINCT FROM NULLIF(TRIM(e.payload#>>'{arrangement_revision,after,inspector_id}'), '')
          )
          AND ${activeCleaningTaskWhereSql('t')}
          AND ${validCleaningTaskOrderWhereSql('t', 'o')}
          AND NOT EXISTS (
            SELECT 1
              FROM work_task_events manager_revision
             WHERE manager_revision.task_id = e.task_id
               AND manager_revision.sequence_no > e.sequence_no
               AND manager_revision.payload#>>'{arrangement_revision,version}' = 'mz031-v1'
               AND manager_revision.caused_by_user_id IS NOT NULL
          )
        ORDER BY t.id, e.sequence_no
     ), effective_inspection_assignments AS (
       SELECT preserved.* FROM preserved_auto_changes preserved
       UNION ALL
       SELECT current.*
         FROM current_inspection_assignments current
        WHERE NOT EXISTS (
          SELECT 1 FROM preserved_auto_changes preserved WHERE preserved.task_id = current.task_id
        )
     )
     SELECT effective.task_id, effective.inspection_key, effective.execution_task_id, effective.user_id,
            COALESCE(
              NULLIF(TRIM(u.display_name), ''), NULLIF(TRIM(u.username), ''),
              NULLIF(TRIM(u.legal_name), ''), effective.user_id
            ) AS user_name,
            effective.service_date::text AS service_date,
            effective.scheduled_service_date::text AS scheduled_service_date,
            effective.property_id,
            COALESCE(NULLIF(TRIM(p.code), ''), NULLIF(TRIM(p.address), ''), effective.property_id) AS property_label,
            NULLIF(TRIM(p.type), '') AS property_type,
            effective.task_type,
            effective.inspection_due_date::text AS inspection_due_date,
            effective.inspection_mode, effective.assignment_source,
            effective.inspection_scope_state, effective.inspection_scope_issue,
            effective.property_snapshot_missing, effective.execution_assignment_conflict,
            effective.service_date < (now() AT TIME ZONE 'Australia/Melbourne')::date AS is_payable,
            COALESCE(submissions.submission_count, '0'::text) AS submission_count,
            COALESCE(submissions.submitter_user_ids, ARRAY[]::text[]) AS submitter_user_ids,
            latest_submission.latest_audit_id, latest_submission.latest_performed_at,
            latest_submission.latest_performed_by_user_id,
            COALESCE(
              NULLIF(TRIM(latest_performer.display_name), ''), NULLIF(TRIM(latest_performer.username), ''),
              NULLIF(TRIM(latest_performer.legal_name), ''), latest_submission.latest_performed_by_user_id
            ) AS latest_performed_by_name,
            latest_submission.latest_metadata
       FROM effective_inspection_assignments effective
       LEFT JOIN users u ON u.id::text = effective.user_id
       LEFT JOIN properties p ON p.id::text = effective.property_id
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::text AS submission_count,
                ARRAY_REMOVE(ARRAY_AGG(DISTINCT a.performed_by_user_id::text), NULL) AS submitter_user_ids
           FROM work_task_action_audits a
          WHERE a.source_type = 'cleaning_tasks'
            AND a.source_id::text = effective.execution_task_id
            AND a.performed_as_action = 'submit_inspection'
            AND lower(COALESCE(a.metadata->>'step', '')) <> 'inspection_photos_saved'
            AND COALESCE(a.metadata->>'route', '') <> 'mzapp.cleaning_tasks.restock_proof'
       ) submissions ON true
       LEFT JOIN LATERAL (
         SELECT a.id::text AS latest_audit_id, a.performed_at::text AS latest_performed_at,
                a.performed_by_user_id::text AS latest_performed_by_user_id,
                a.metadata AS latest_metadata
           FROM work_task_action_audits a
          WHERE a.source_type = 'cleaning_tasks'
            AND a.source_id::text = effective.execution_task_id
            AND a.performed_as_action = 'submit_inspection'
            AND lower(COALESCE(a.metadata->>'step', '')) <> 'inspection_photos_saved'
            AND COALESCE(a.metadata->>'route', '') <> 'mzapp.cleaning_tasks.restock_proof'
          ORDER BY a.performed_at DESC, a.id DESC
          LIMIT 1
       ) latest_submission ON true
       LEFT JOIN users latest_performer ON latest_performer.id::text = latest_submission.latest_performed_by_user_id
      WHERE effective.service_date BETWEEN $1::date AND $2::date
        AND (
          $3::text[] IS NULL
          OR effective.user_id = ANY($3::text[])
          OR latest_submission.latest_performed_by_user_id = ANY($3::text[])
          OR submissions.submitter_user_ids && $3::text[]
          OR EXISTS (
            SELECT 1
              FROM effective_inspection_assignments requested
             WHERE requested.property_id = effective.property_id
               AND requested.service_date = effective.service_date
               AND requested.user_id = ANY($3::text[])
          )
        )
      ORDER BY effective.service_date, effective.property_id, effective.task_id`,
    params,
  )

  const carryAdjustmentResult = await executor.query(
    `SELECT id, source_settlement_id, source_adjustment_id, user_id,
            source_week_start::text, source_week_end::text,
            target_week_start::text, target_week_end::text,
            recorded_subtotal_difference_cents, recorded_gst_difference_cents,
            recorded_total_difference_cents,
            previously_applied_subtotal_cents, previously_applied_gst_cents,
            previously_applied_total_cents,
            applied_subtotal_cents, applied_gst_cents, applied_total_cents,
            reason, applied_by, applied_at::text
       FROM personnel_settlement_carry_adjustments
      WHERE target_week_start=$1::date
        AND target_week_end=$2::date
        AND status IN ('scheduled','included_in_target')
        AND ($3::text[] IS NULL OR user_id = ANY($3::text[]))
      ORDER BY applied_at, id`,
    params,
  )

  const profiles = (profileResult.rows || []) as ProfileRow[]
  const rules = groupRules((ruleResult.rows || []) as RuleRow[])
  const candidates = (auditResult.rows || []) as SettlementAuditCandidate[]
  const claims = (claimResult.rows || []) as ClaimRow[]
  const cleaningAssignments = (cleaningAssignmentResult.rows || []) as CleaningAssignmentCandidate[]
  const cleaningPaymentAssignments = (cleaningPaymentResult.rows || []) as CleaningPaymentAssignment[]
  const inspectionPaymentAssignments = (inspectionPaymentResult.rows || []) as InspectionPaymentAssignment[]
  const carryAdjustments = (carryAdjustmentResult.rows || []) as CarryAdjustmentRow[]
  const people = new Map<string, PersonPreview>()
  const unassignedInspectionWarnings: Array<PersonPreview['warnings'][number] & {
    user_id: string
    user_name: string
  }> = []

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

  const warn = (
    userId: string,
    userName: string | null,
    sourceType: string,
    sourceId: string,
    reason: string,
    detail?: {
      service_date?: string
      component_type?: SettlementComponentType
      description?: string
      task_id?: string
      property_id?: string | null
      property_label?: string | null
      work_items?: SettlementWorkItem[]
    },
  ) => {
    const person = people.get(userId) || newPerson(userId, userName)
    person.warnings.push({ source_type: sourceType, source_id: sourceId, reason, ...detail })
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
    work_items?: SettlementWorkItem[]
  }) => {
    const warnLine = (reason: string) => warn(
      inputLine.user_id,
      inputLine.user_name || null,
      inputLine.source_type,
      inputLine.source_id,
      reason,
      {
        service_date: inputLine.service_date,
        component_type: inputLine.component_type,
        description: inputLine.description,
        ...(inputLine.work_items?.[0]?.task_id ? { task_id: inputLine.work_items[0].task_id } : {}),
        ...(inputLine.property_id || inputLine.work_items?.[0]?.property_id ? {
          property_id: inputLine.property_id || inputLine.work_items?.[0]?.property_id || null,
        } : {}),
        ...(inputLine.property_label || inputLine.work_items?.[0]?.property_label ? {
          property_label: inputLine.property_label || inputLine.work_items?.[0]?.property_label || null,
        } : {}),
        ...(inputLine.work_items?.length ? { work_items: inputLine.work_items } : {}),
      },
    )
    const userProfiles = profilesByUser.get(inputLine.user_id) || []
    const profile = selectUniqueEffective(userProfiles, inputLine.service_date)
    if (!profile) {
      warnLine(
        userProfiles.filter((row) => dateContains(row, inputLine.service_date)).length > 1
          ? 'ambiguous_effective_profile'
          : 'missing_effective_profile')
      return
    }
    if (profile.gst_status === 'unconfirmed') {
      warnLine('gst_status_unconfirmed')
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
        work_items: inputLine.work_items || [],
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
      warnLine(
        userRules.filter((row) => dateContains(row, inputLine.service_date)).length > 1
          ? 'ambiguous_effective_rule'
          : 'missing_effective_rule')
      return
    }
    if (inputLine.component_type === 'cleaning_task' && !CLEANING_PROPERTY_TYPE_SET.has(propertyType)) {
      warnLine('missing_or_unsupported_property_type')
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
      warnLine('ambiguous_rule_item')
      return
    }
    if (!selected.item && inputLine.approved_amount_cents == null) {
      warnLine(
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
      work_items: inputLine.work_items || [],
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
    const component = assignment.component_type || 'cleaning_task'
    const assignmentKey = `${assignment.task_id}:${component}:${assignment.user_id}:${assignment.service_date}`
    if (!uniqueCleaningAssignments.has(assignmentKey)) {
      uniqueCleaningAssignments.set(assignmentKey, assignment)
    }
  }
  const uniqueCleaningPaymentAssignments = new Map<string, CleaningPaymentAssignment>()
  for (const assignment of cleaningPaymentAssignments) {
    const businessKey = cleanText(assignment.business_key) || `checkout-task:${assignment.task_id}`
    if (!uniqueCleaningPaymentAssignments.has(businessKey)) {
      uniqueCleaningPaymentAssignments.set(businessKey, assignment)
    }
  }
  const deduplicatedCleaningPaymentAssignments = Array.from(uniqueCleaningPaymentAssignments.values())
    .reduce((count, assignment) => count + Math.max(0, Number(assignment.duplicate_count || 1) - 1), 0)
  let cancelledCleaningAssignments = 0
  let nonCancelledCleaningAssignments = 0
  let excludedNonCheckoutCleaningAssignments = 0
  for (const assignment of uniqueCleaningAssignments.values()) {
    if ((assignment.component_type || 'cleaning_task') !== 'cleaning_task') continue
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
  }

  const inPeriod = (serviceDate: string) => serviceDate >= period.week_start && serviceDate <= period.week_end
  const isRequestedUser = (userId: string | null) => !userFilter || (!!userId && userFilter.includes(userId))
  const eligibleCandidates: Array<{
    candidate: WorkloadAuditCandidate
    component: 'cleaning_task' | 'inspection_day'
  }> = []
  const excludedCandidates: Array<{
    audit_id: string
    task_id: string
    user_id: string
    action: string
    service_date: string
    reason: string
  }> = []
  const manualReviewCandidates: Array<{
    candidate: WorkloadAuditCandidate
    component: 'cleaning_task' | 'inspection_day'
    reason: string
  }> = []
  const eligibleCleaningPerformersByTask = new Map<string, Set<string>>()
  for (const candidate of candidates) {
    const candidateAction = cleanText(candidate.action).toLowerCase()
    // Inspection uploads are evidence only. They must never create, move,
    // revive, or conflict with a manager-owned settlement assignment.
    if (candidateAction === 'submit_inspection') continue
    const decision = classifyWorkloadAudit(candidate)
    const isCleaningAudit = candidateAction === 'fill_supplies' || candidateAction === 'complete_cleaning'
    if (decision.eligibility === 'excluded') {
      if (isRequestedUser(candidate.user_id)) {
        excludedCandidates.push({
          audit_id: candidate.audit_id,
          task_id: candidate.task_id,
          user_id: candidate.user_id,
          action: candidate.action,
          service_date: candidate.service_date,
          reason: decision.reason,
        })
      }
      continue
    }
    // Cleaning payment and execution evidence are resolved exclusively by the
    // current effective assignment query. Historical cleaner audits must not
    // create performer conflicts or manual-review blocks after reassignment.
    if (isCleaningAudit) {
      if (decision.eligibility === 'eligible') {
        const performers = eligibleCleaningPerformersByTask.get(candidate.task_id) || new Set<string>()
        performers.add(candidate.user_id)
        eligibleCleaningPerformersByTask.set(candidate.task_id, performers)
      }
      continue
    }
    if (decision.eligibility === 'manual_review' || !decision.component_type) {
      if (isRequestedUser(candidate.user_id) && inPeriod(candidate.service_date)) {
        const isSettlementAction = candidate.action === 'submit_inspection'
          || candidate.action === 'fill_supplies'
          || candidate.action === 'complete_cleaning'
        const manualComponent = candidate.action === 'submit_inspection' ? 'inspection_day' : 'cleaning_task'
        warn(candidate.user_id, candidate.performed_by_name, 'work_task_action_audit', candidate.audit_id, decision.reason, {
          service_date: candidate.service_date,
          component_type: isSettlementAction ? manualComponent : 'inspection_day',
          description: candidate.action,
        })
        if (isSettlementAction) {
          manualReviewCandidates.push({
            candidate,
            component: manualComponent,
            reason: decision.reason,
          })
        }
      }
      continue
    }
    if (decision.component_type !== 'inspection_day' && decision.component_type !== 'cleaning_task') continue
    if (decision.component_type === 'inspection_day' && Object.prototype.hasOwnProperty.call(candidate, 'current_assignee_user_id')) {
      const currentAssignee = cleanText(candidate.current_assignee_user_id)
      const taskStatus = cleanText(candidate.task_status).toLowerCase()
      const executionState = cleanText(candidate.task_execution_state).toLowerCase()
      const taskOrderId = cleanText(candidate.task_order_id)
      const orderStatus = cleanText(candidate.order_status).toLowerCase()
      const currentOwnershipInvalid = !currentAssignee
        || currentAssignee !== candidate.user_id
        || taskStatus === 'cancelled'
        || taskStatus === 'canceled'
        || (!!executionState && executionState !== 'active')
        || (!!taskOrderId && !orderStatus)
        || orderStatus === 'invalid'
        || orderStatus.includes('cancel')
      if (currentOwnershipInvalid) {
        if (isRequestedUser(candidate.user_id) && inPeriod(candidate.service_date)) {
          excludedCandidates.push({
            audit_id: candidate.audit_id,
            task_id: candidate.task_id,
            user_id: candidate.user_id,
            action: candidate.action,
            service_date: candidate.service_date,
            reason: 'inspection_assignment_no_longer_effective',
          })
        }
        continue
      }
    }
    eligibleCandidates.push({ candidate, component: decision.component_type })
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
  const dedupedEligible = new Map<string, {
    candidate: WorkloadAuditCandidate
    component: 'cleaning_task' | 'inspection_day'
  }>()
  const conflictWarnings = new Set<string>()
  const requestedConflictingTaskKeys = new Set<string>()
  for (const entry of eligibleCandidates) {
    const taskKey = `${entry.candidate.task_id}:${entry.component}`
    if (conflictingTaskKeys.has(taskKey)) {
      const warningKey = `${entry.candidate.user_id}:${taskKey}`
      if (isRequestedUser(entry.candidate.user_id) && inPeriod(entry.candidate.service_date) && !conflictWarnings.has(warningKey)) {
        requestedConflictingTaskKeys.add(taskKey)
        warn(
          entry.candidate.user_id,
          entry.candidate.performed_by_name,
          'work_task_action_audit',
          entry.candidate.task_id,
          'multiple_performers_for_task',
          {
            service_date: entry.candidate.service_date,
            component_type: entry.component,
            description: entry.candidate.action,
          },
        )
        conflictWarnings.add(warningKey)
      }
      continue
    }
    const key = candidateExecutionKey(entry.candidate, entry.component)
    if (!dedupedEligible.has(key)) {
      dedupedEligible.set(key, entry)
    } else if (isRequestedUser(entry.candidate.user_id) && inPeriod(entry.candidate.service_date)) {
      excludedCandidates.push({
        audit_id: entry.candidate.audit_id,
        task_id: entry.candidate.task_id,
        user_id: entry.candidate.user_id,
        action: entry.candidate.action,
        service_date: entry.candidate.service_date,
        reason: 'duplicate_execution_already_counted',
      })
    }
  }

  const checklistKeysByUser = new Map<string, Set<string>>()
  const addChecklistItem = (userId: string, userName: string | null, item: SettlementWorkItem) => {
    const key = `${item.component_type}:${item.execution_key}`
    const keys = checklistKeysByUser.get(userId) || new Set<string>()
    const person = people.get(userId) || newPerson(userId, userName)
    if (keys.has(key)) {
      if (item.status === 'legacy_completed_unverified') {
        const index = person.work_checklist.findIndex((existing) => `${existing.component_type}:${existing.execution_key}` === key)
        if (index >= 0 && !person.work_checklist[index].included_in_amount) person.work_checklist[index] = item
      }
      return
    }
    person.work_checklist.push(item)
    people.set(userId, person)
    keys.add(key)
    checklistKeysByUser.set(userId, keys)
  }

  const uniqueInspectionPaymentAssignments = new Map<string, InspectionPaymentAssignment>()
  for (const assignment of inspectionPaymentAssignments) {
    const key = cleanText(assignment.inspection_key) || `inspection:${assignment.task_id}`
    if (!uniqueInspectionPaymentAssignments.has(key)) uniqueInspectionPaymentAssignments.set(key, assignment)
  }
  const inspectionAssignmentsByPropertyDate = new Map<string, InspectionPaymentAssignment[]>()
  for (const assignment of uniqueInspectionPaymentAssignments.values()) {
    if (assignment.inspection_scope_state === 'requires_review') continue
    if (assignment.property_snapshot_missing) continue
    const propertyKey = cleanText(assignment.property_id) || `task:${assignment.task_id}`
    const key = `${propertyKey}:${assignment.service_date}`
    const existing = inspectionAssignmentsByPropertyDate.get(key) || []
    existing.push(assignment)
    inspectionAssignmentsByPropertyDate.set(key, existing)
  }
  const conflictingInspectionKeys = new Set<string>()
  const suppressedCompanionInspectionKeys = new Set<string>()
  for (const assignments of inspectionAssignmentsByPropertyDate.values()) {
    const inspectors = new Set(assignments.map((assignment) => cleanText(assignment.user_id)).filter(Boolean))
    if (inspectors.size > 1) {
      for (const assignment of assignments) {
        if (cleanText(assignment.user_id)) conflictingInspectionKeys.add(assignment.inspection_key)
      }
    }
    const checkoutAssignments = assignments.filter((assignment) => {
      const taskType = cleanText(assignment.task_type).toLowerCase()
      return taskType === 'checkout_clean' || taskType === 'checkout_cleaning'
    })
    if (checkoutAssignments.length !== 1) continue
    const checkoutInspectorId = cleanText(checkoutAssignments[0].user_id)
    if (!checkoutInspectorId) continue
    for (const assignment of assignments) {
      if (cleanText(assignment.task_type).toLowerCase() !== 'checkin_clean') continue
      const checkinInspectorId = cleanText(assignment.user_id)
      if (!checkinInspectorId || checkinInspectorId === checkoutInspectorId) {
        suppressedCompanionInspectionKeys.add(assignment.inspection_key)
      }
    }
  }
  const inspectionDays = new Map<string, {
    user_id: string
    user_name: string | null
    service_date: string
    work_items: SettlementWorkItem[]
  }>()
  for (const assignment of uniqueInspectionPaymentAssignments.values()) {
    if (!inPeriod(assignment.service_date)) continue
    if (suppressedCompanionInspectionKeys.has(assignment.inspection_key)) continue
    const inspectorId = cleanText(assignment.user_id)
    if (assignment.inspection_scope_state === 'requires_review') {
      const scopeReason = assignment.inspection_scope_issue || 'inspection_scope_invalid_for_task'
      const scopeWorkItem: SettlementWorkItem = {
        ...inspectionPaymentWorkItem(assignment),
        status: 'incomplete',
        status_reason: scopeReason,
        included_in_amount: false,
        requires_manual_review: true,
      }
      const warningDetail = {
        service_date: assignment.service_date,
        component_type: 'inspection_day' as const,
        description: `Inspection scope pending review · ${assignment.property_label || assignment.property_id || assignment.task_id}`,
        task_id: assignment.task_id,
        property_id: assignment.property_id,
        property_label: assignment.property_label,
        work_items: [scopeWorkItem],
      }
      if (!inspectorId) {
        unassignedInspectionWarnings.push({
          user_id: '',
          user_name: 'Unassigned inspector',
          source_type: 'inspection_task_assignment',
          source_id: assignment.inspection_key,
          reason: scopeReason,
          ...warningDetail,
        })
        continue
      }
      if (!isRequestedUser(inspectorId)) continue
      addChecklistItem(inspectorId, assignment.user_name, scopeWorkItem)
      warn(
        inspectorId,
        assignment.user_name,
        'inspection_task_assignment',
        assignment.inspection_key,
        scopeReason,
        warningDetail,
      )
      continue
    }
    if (!inspectorId) {
      const pendingWorkItem: SettlementWorkItem = {
        ...inspectionPaymentWorkItem(assignment),
        status: 'incomplete',
        status_reason: 'inspection_inspector_missing',
        included_in_amount: false,
        requires_manual_review: true,
      }
      unassignedInspectionWarnings.push({
        user_id: '',
        user_name: 'Unassigned inspector',
        source_type: 'inspection_task_assignment',
        source_id: assignment.inspection_key,
        reason: 'inspection_inspector_missing',
        service_date: assignment.service_date,
        component_type: 'inspection_day',
        description: `Inspection pending assignment · ${assignment.property_label || assignment.property_id || assignment.task_id}`,
        task_id: assignment.task_id,
        property_id: assignment.property_id,
        property_label: assignment.property_label,
        work_items: [pendingWorkItem],
      })
      continue
    }
    if (assignment.execution_assignment_conflict) {
      const conflictWorkItem: SettlementWorkItem = {
        ...inspectionPaymentWorkItem(assignment),
        status: 'incomplete',
        status_reason: 'inspection_execution_assignment_conflict',
        included_in_amount: false,
        requires_manual_review: true,
      }
      addChecklistItem(inspectorId, assignment.user_name, conflictWorkItem)
      warn(
        inspectorId,
        assignment.user_name,
        'inspection_task_assignment',
        assignment.inspection_key,
        'inspection_execution_assignment_conflict',
        {
          service_date: assignment.service_date,
          component_type: 'inspection_day',
          description: `Inspection execution assignment conflict · ${assignment.property_label || assignment.property_id || assignment.task_id}`,
          task_id: assignment.task_id,
          property_id: assignment.property_id,
          property_label: assignment.property_label,
          work_items: [conflictWorkItem],
        },
      )
      continue
    }
    const actualSubmitterIds = Array.from(new Set([
      ...(Array.isArray(assignment.submitter_user_ids) ? assignment.submitter_user_ids : []),
      assignment.latest_performed_by_user_id,
    ].map(cleanText).filter(Boolean)))
    const mismatchedSubmitterIds = actualSubmitterIds.filter((submitterId) => submitterId !== inspectorId)
    if (mismatchedSubmitterIds.length) {
      const mismatchWorkItem: SettlementWorkItem = {
        ...inspectionPaymentWorkItem(assignment),
        status: 'incomplete',
        status_reason: 'inspection_submitter_differs_from_planned_owner',
        included_in_amount: false,
        requires_manual_review: true,
      }
      const warningDetail = {
        service_date: assignment.service_date,
        component_type: 'inspection_day' as const,
        description: `Inspection submitter differs from planned owner · ${assignment.property_label || assignment.property_id || assignment.task_id}`,
        task_id: assignment.task_id,
        property_id: assignment.property_id,
        property_label: assignment.property_label,
        work_items: [mismatchWorkItem],
      }
      if (isRequestedUser(inspectorId)) {
        addChecklistItem(inspectorId, assignment.user_name, mismatchWorkItem)
        warn(
          inspectorId,
          assignment.user_name,
          'inspection_task_assignment',
          assignment.inspection_key,
          'inspection_submitter_differs_from_planned_owner',
          warningDetail,
        )
      }
      for (const actualSubmitterId of mismatchedSubmitterIds) {
        if (!isRequestedUser(actualSubmitterId)) continue
        warn(
          actualSubmitterId,
          actualSubmitterId === cleanText(assignment.latest_performed_by_user_id)
            ? assignment.latest_performed_by_name
            : actualSubmitterId,
          'inspection_task_assignment',
          assignment.inspection_key,
          'inspection_submitter_differs_from_planned_owner',
          warningDetail,
        )
      }
      continue
    }
    if (!isRequestedUser(inspectorId)) continue
    const assigned = { ...assignment, user_id: inspectorId }
    const baseWorkItem = inspectionPaymentWorkItem(assigned)
    if (assigned.property_snapshot_missing) {
      const missingPropertyReason = assigned.assignment_source === 'current'
        ? 'inspection_property_missing'
        : 'historical_property_snapshot_missing'
      const missingPropertyWorkItem: SettlementWorkItem = {
        ...baseWorkItem,
        status: 'incomplete',
        status_reason: missingPropertyReason,
        included_in_amount: false,
        requires_manual_review: true,
      }
      addChecklistItem(inspectorId, assigned.user_name, missingPropertyWorkItem)
      warn(
        inspectorId,
        assigned.user_name,
        'inspection_task_assignment',
        assigned.inspection_key,
        missingPropertyReason,
        {
          service_date: assigned.service_date,
          component_type: 'inspection_day',
          description: `Inspection assignment · ${assigned.task_id}`,
          task_id: assigned.task_id,
          work_items: [missingPropertyWorkItem],
        },
      )
      continue
    }
    if (conflictingInspectionKeys.has(assigned.inspection_key)) {
      const conflictWorkItem: SettlementWorkItem = {
        ...baseWorkItem,
        status: 'incomplete',
        status_reason: 'inspection_assignment_conflict_for_property_date',
        included_in_amount: false,
        requires_manual_review: true,
      }
      addChecklistItem(inspectorId, assigned.user_name, conflictWorkItem)
      warn(
        inspectorId,
        assigned.user_name,
        'inspection_task_assignment',
        assigned.inspection_key,
        'inspection_assignment_conflict_for_property_date',
        {
          service_date: assigned.service_date,
          component_type: 'inspection_day',
          description: `Inspection assignment conflict · ${assigned.property_label || assigned.property_id || assigned.task_id}`,
          task_id: assigned.task_id,
          property_id: assigned.property_id,
          property_label: assigned.property_label,
          work_items: [conflictWorkItem],
        },
      )
      continue
    }
    addChecklistItem(inspectorId, assigned.user_name, baseWorkItem)
    if (!assigned.is_payable) continue
    const dayKey = `${inspectorId}:${assigned.service_date}`
    const day = inspectionDays.get(dayKey) || {
      user_id: inspectorId,
      user_name: assigned.user_name,
      service_date: assigned.service_date,
      work_items: [],
    }
    day.work_items.push(baseWorkItem)
    inspectionDays.set(dayKey, day)
  }
  for (const day of inspectionDays.values()) {
    const propertyCount = new Set(day.work_items.map((item) => item.property_id || item.property_label || item.task_id)).size
    appendLine({
      user_id: day.user_id,
      user_name: day.user_name,
      component_type: 'inspection_day',
      service_date: day.service_date,
      source_type: 'inspection_task_assignment',
      source_id: `inspection-day:${day.service_date}`,
      description: `Inspection day · ${propertyCount} property(ies) · ${day.work_items.length} task(s)`,
      quantity_numerator: 1,
      quantity_denominator: 1,
      work_items: day.work_items,
    })
  }

  for (const assignment of uniqueCleaningPaymentAssignments.values()) {
    if (!isRequestedUser(assignment.user_id) || !inPeriod(assignment.service_date)) continue
    const workItem = cleaningPaymentWorkItem(assignment)
    addChecklistItem(assignment.user_id, assignment.user_name, workItem)
    appendLine({
      user_id: assignment.user_id,
      user_name: assignment.user_name,
      component_type: 'cleaning_task',
      service_date: assignment.service_date,
      source_type: 'cleaning_task_assignment',
      source_id: assignment.business_key,
      source_audit_id: assignment.actual_audit_id,
      property_id: assignment.property_id,
      property_label: assignment.property_label,
      property_type: assignment.property_type,
      task_type: assignment.task_type,
      description: assignment.property_label
        ? `Cleaning · ${assignment.property_label} · ${assignment.property_type || '房型未登记'}`
        : `Cleaning task · ${assignment.property_type || '房型未登记'}`,
      quantity_numerator: 1,
      quantity_denominator: 1,
      work_items: [workItem],
    })
  }
  const payableCleaningAssignmentByTaskId = new Map<string, CleaningPaymentAssignment>()
  for (const assignment of uniqueCleaningPaymentAssignments.values()) {
    payableCleaningAssignmentByTaskId.set(assignment.task_id, assignment)
  }
  const legacyTasksWithoutPerformerAudit: Array<{
    task_id: string
    component_type: 'cleaning_task' | 'inspection_day'
    user_id: string
    user_name: string | null
    service_date: string
    property_id: string | null
    property_label: string | null
    task_status: string | null
    reason: string
  }> = []
  for (const assignment of uniqueCleaningAssignments.values()) {
    const component = assignment.component_type || 'cleaning_task'
    if (component === 'cleaning_task' && cleanText(assignment.task_type).toLowerCase() !== 'checkout_clean') continue
    if (component === 'inspection_day') {
      const effective = uniqueInspectionPaymentAssignments.get(`inspection:${assignment.task_id}`)
      if (effective
        && effective.user_id === assignment.user_id
        && effective.service_date === assignment.service_date) {
        // The authoritative assignment-owned checklist item was added above.
        continue
      }
      if (effective) {
        addChecklistItem(assignment.user_id, assignment.user_name, {
          execution_key: `inspection-history:${assignment.task_id}:${assignment.service_date}:${assignment.user_id}`,
          audit_id: null,
          task_id: assignment.task_id,
          component_type: 'inspection_day',
          service_date: null,
          performed_at: null,
          performed_by_user_id: null,
          performed_by_name: null,
          property_id: assignment.property_id,
          property_label: assignment.property_label,
          property_type: assignment.property_type,
          task_type: assignment.task_type,
          scheduled_service_date: assignment.service_date,
          current_scheduled_service_date: effective.service_date,
          inspection_due_date: cleanText(assignment.inspection_due_date).slice(0, 10) || null,
          inspection_mode: cleanText(assignment.inspection_mode) || null,
          evidence_count: 0,
          evidence: [],
          status: 'rescheduled',
          status_reason: cleanText(assignment.arrangement_reason) || 'inspection_assignment_superseded',
          included_in_amount: false,
          requires_manual_review: false,
        })
        continue
      }
    }
    const executionKey = `${component === 'cleaning_task' ? 'cleaning' : 'inspection'}:${assignment.task_id}`
    const payableCleaningAssignment = component === 'cleaning_task'
      ? payableCleaningAssignmentByTaskId.get(assignment.task_id)
      : null
    if (payableCleaningAssignment) {
      if (payableCleaningAssignment.user_id === assignment.user_id) {
        // The assignment-owned checklist item was already added above. Raw
        // shared statuses such as keys_hung must not reclassify it as legacy.
        continue
      }
      addChecklistItem(assignment.user_id, assignment.user_name, {
        execution_key: executionKey,
        audit_id: null,
        task_id: assignment.task_id,
        component_type: 'cleaning_task',
        service_date: null,
        performed_at: null,
        performed_by_user_id: null,
        performed_by_name: null,
        property_id: assignment.property_id,
        property_label: assignment.property_label,
        property_type: assignment.property_type,
        task_type: assignment.task_type,
        scheduled_service_date: assignment.service_date,
        current_scheduled_service_date: payableCleaningAssignment.scheduled_service_date,
        inspection_due_date: cleanText(assignment.inspection_due_date).slice(0, 10) || null,
        inspection_mode: cleanText(assignment.inspection_mode) || null,
        evidence_count: 0,
        evidence: [],
        status: 'rescheduled',
        status_reason: cleanText(assignment.arrangement_reason) || 'cleaning_assignment_no_longer_effective',
        included_in_amount: false,
        requires_manual_review: false,
      })
      continue
    }
    const historicalCleaningPerformers = component === 'cleaning_task'
      ? eligibleCleaningPerformersByTask.get(assignment.task_id)
      : null
    if (historicalCleaningPerformers?.size && !historicalCleaningPerformers.has(assignment.user_id)) {
      addChecklistItem(assignment.user_id, assignment.user_name, {
        execution_key: executionKey,
        audit_id: null,
        task_id: assignment.task_id,
        component_type: 'cleaning_task',
        service_date: null,
        performed_at: null,
        performed_by_user_id: null,
        performed_by_name: null,
        property_id: assignment.property_id,
        property_label: assignment.property_label,
        property_type: assignment.property_type,
        task_type: assignment.task_type,
        scheduled_service_date: assignment.service_date,
        current_scheduled_service_date: cleanText(assignment.current_service_date).slice(0, 10) || assignment.service_date,
        inspection_due_date: cleanText(assignment.inspection_due_date).slice(0, 10) || null,
        inspection_mode: cleanText(assignment.inspection_mode) || null,
        evidence_count: 0,
        evidence: [],
        status: 'rescheduled',
        status_reason: cleanText(assignment.arrangement_reason) || 'executed_by_different_performer',
        included_in_amount: false,
        requires_manual_review: false,
      })
      continue
    }
    const executed = dedupedEligible.get(executionKey)
    if (executed?.component === component && executed.candidate.user_id !== assignment.user_id) {
      const arrangementReason = cleanText(assignment.arrangement_reason) || 'executed_by_different_performer'
      addChecklistItem(assignment.user_id, assignment.user_name, {
        execution_key: executionKey,
        audit_id: null,
        task_id: assignment.task_id,
        component_type: component,
        service_date: null,
        performed_at: null,
        performed_by_user_id: null,
        performed_by_name: null,
        property_id: assignment.property_id,
        property_label: assignment.property_label,
        property_type: assignment.property_type,
        task_type: assignment.task_type,
        scheduled_service_date: assignment.service_date,
        current_scheduled_service_date: cleanText(assignment.current_service_date).slice(0, 10) || assignment.service_date,
        inspection_due_date: cleanText(assignment.inspection_due_date).slice(0, 10) || null,
        inspection_mode: cleanText(assignment.inspection_mode) || null,
        evidence_count: 0,
        evidence: [],
        status: 'rescheduled',
        status_reason: arrangementReason,
        included_in_amount: false,
        requires_manual_review: !cleanText(assignment.arrangement_reason),
      })
      continue
    }
    if (executed?.component === component) {
      const actual = candidateWorkItem(executed.candidate, component)
      const actualInPeriod = inPeriod(executed.candidate.service_date)
      const arrangementReason = cleanText(assignment.arrangement_reason)
      addChecklistItem(assignment.user_id, assignment.user_name, {
        ...actual,
        scheduled_service_date: actual.scheduled_service_date || assignment.service_date,
        current_scheduled_service_date: cleanText(assignment.current_service_date).slice(0, 10) || assignment.service_date,
        property_id: actual.property_id || assignment.property_id,
        property_label: actual.property_label || assignment.property_label,
        property_type: actual.property_type || assignment.property_type,
        task_type: actual.task_type || assignment.task_type,
        inspection_due_date: actual.inspection_due_date || cleanText(assignment.inspection_due_date).slice(0, 10) || null,
        inspection_mode: actual.inspection_mode || cleanText(assignment.inspection_mode) || null,
        // A later planning/management event cannot rewrite an already-audited
        // execution into a non-payment checklist state.  Keep the current plan
        // fields for context, but actual in-period execution is authoritative.
        status: actualInPeriod ? 'completed' : 'rescheduled',
        status_reason: actualInPeriod
          ? 'completed_with_execution_audit'
          : (arrangementReason || 'completed_on_different_service_date'),
        included_in_amount: actualInPeriod,
      })
      continue
    }
    const taskStatus = cleanText(assignment.task_status).toLowerCase()
    const arrangementReason = cleanText(assignment.arrangement_reason)
    const managementClosed = arrangementReason === 'management_closed_without_execution'
    // A shared/raw cleaning terminal status is not payment or completion
    // authority in MZ-032. Active assignments are handled by the payment query;
    // all other cleaning plan rows remain non-blocking checklist context.
    const legacyCompleted = false
    const cancelled = taskStatus === 'cancelled' || taskStatus === 'canceled'
    const status: SettlementWorkItem['status'] = cancelled
      ? 'cancelled'
      : managementClosed
      ? 'management_closed'
      : arrangementReason
      ? 'rescheduled'
      : legacyCompleted
      ? 'legacy_completed_unverified'
      : 'incomplete'
    const reason = cancelled
      ? (arrangementReason ? `task_cancelled_after:${arrangementReason}` : 'task_cancelled_without_payment')
      : arrangementReason || (legacyCompleted
      ? 'legacy_completed_status_without_execution_audit'
      : `task_not_completed:${taskStatus || 'unknown'}`)
    addChecklistItem(assignment.user_id, assignment.user_name, {
      execution_key: executionKey,
      audit_id: null,
      task_id: assignment.task_id,
      component_type: component,
      service_date: null,
      performed_at: null,
      performed_by_user_id: null,
      performed_by_name: null,
      property_id: assignment.property_id,
      property_label: assignment.property_label,
      property_type: assignment.property_type,
      task_type: assignment.task_type,
      scheduled_service_date: assignment.service_date,
      current_scheduled_service_date: cleanText(assignment.current_service_date).slice(0, 10) || assignment.service_date,
      inspection_due_date: cleanText(assignment.inspection_due_date).slice(0, 10) || null,
      inspection_mode: cleanText(assignment.inspection_mode) || null,
      evidence_count: 0,
      evidence: [],
      status,
      status_reason: reason,
      included_in_amount: false,
      requires_manual_review: legacyCompleted && !managementClosed,
    })
    if (legacyCompleted && !managementClosed) {
      legacyTasksWithoutPerformerAudit.push({
        task_id: assignment.task_id,
        component_type: component,
        user_id: assignment.user_id,
        user_name: assignment.user_name,
        service_date: assignment.service_date,
        property_id: assignment.property_id,
        property_label: assignment.property_label,
        task_status: assignment.task_status,
        reason,
      })
      warn(
        assignment.user_id,
        assignment.user_name,
        'inspection_task_assignment',
        assignment.task_id,
        'legacy_completed_without_execution_audit',
      )
    }
  }

  for (const entry of manualReviewCandidates) {
    const historical = candidateWorkItem(entry.candidate, entry.component)
    addChecklistItem(entry.candidate.user_id, entry.candidate.performed_by_name, {
      ...historical,
      status: 'legacy_completed_unverified',
      status_reason: entry.reason,
      included_in_amount: false,
      requires_manual_review: true,
    })
  }

  for (const { candidate, component } of dedupedEligible.values()) {
    if (!isRequestedUser(candidate.user_id)) continue
    if (!inPeriod(candidate.service_date)) continue
    addChecklistItem(candidate.user_id, candidate.performed_by_name, candidateWorkItem(candidate, component))
  }

  for (const claim of claims) {
    const useSubmittedValues = claim.status === 'submitted'
    const selectedAmount = useSubmittedValues ? claim.requested_amount_cents : claim.approved_amount_cents
    const approvedAmount = selectedAmount == null
      ? null
      : toSafeNonNegativeInteger(selectedAmount, useSubmittedValues ? 'requested_amount_cents' : 'approved_amount_cents')
    let ratio: { numerator: number; denominator: number } | null = null
    if (approvedAmount == null) {
      if (claim.claim_type.endsWith('_hour') || claim.claim_type === 'new_property_task') {
        const minutes = useSubmittedValues
          ? claim.duration_minutes
          : claim.approved_duration_minutes ?? claim.duration_minutes
        if (minutes != null) ratio = { numerator: toSafeNonNegativeInteger(minutes, 'duration_minutes'), denominator: 60 }
      } else {
        ratio = decimalQuantityToRatio(
          useSubmittedValues
            ? claim.requested_quantity ?? '1'
            : claim.approved_quantity ?? claim.requested_quantity ?? '1',
        )
      }
    }
    if (approvedAmount == null && !ratio) {
      warn(
        claim.submitter_user_id,
        null,
        'workload_claim',
        claim.id,
        'approved_quantity_or_amount_missing',
        { service_date: claim.service_date, component_type: claim.claim_type, description: claim.note || claim.claim_type },
      )
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

  for (const carry of carryAdjustments) {
    const subtotalCents = toSafeSignedInteger(carry.applied_subtotal_cents, 'carry_adjustment_subtotal_cents')
    const gstCents = toSafeSignedInteger(carry.applied_gst_cents, 'carry_adjustment_gst_cents')
    const totalCents = toSafeSignedInteger(carry.applied_total_cents, 'carry_adjustment_total_cents')
    if (subtotalCents + gstCents !== totalCents) throw new Error('carry_adjustment_tax_breakdown_invalid')
    if (subtotalCents === 0 && gstCents === 0) continue
    const userProfiles = profilesByUser.get(carry.user_id) || []
    const profile = selectUniqueEffective(userProfiles, period.week_end)
    if (!profile) {
      warn(
        carry.user_id,
        null,
        'post_payment_adjustment',
        carry.id,
        userProfiles.filter((row) => dateContains(row, period.week_end)).length > 1
          ? 'ambiguous_effective_profile'
          : 'missing_effective_profile',
        {
          service_date: period.week_start,
          component_type: 'post_payment_adjustment',
          description: `Paid settlement adjustment from ${carry.source_week_start} to ${carry.source_week_end}`,
        },
      )
      continue
    }
    if (profile.gst_status === 'unconfirmed') {
      warn(
        carry.user_id,
        profile.user_name,
        'post_payment_adjustment',
        carry.id,
        'gst_status_unconfirmed',
        {
          service_date: period.week_start,
          component_type: 'post_payment_adjustment',
          description: `Paid settlement adjustment from ${carry.source_week_start} to ${carry.source_week_end}`,
        },
      )
      continue
    }
    if (gstCents !== 0 && profile.gst_status !== 'registered') {
      warn(
        carry.user_id,
        profile.user_name,
        'post_payment_adjustment',
        carry.id,
        'post_payment_adjustment_tax_treatment_requires_decision',
        {
          service_date: period.week_start,
          component_type: 'post_payment_adjustment',
          description: `Paid settlement adjustment from ${carry.source_week_start} to ${carry.source_week_end}`,
        },
      )
      continue
    }
    const person = people.get(carry.user_id) || newPerson(carry.user_id, profile.user_name)
    person.user_name = profile.user_name
    person.profile = profile
    person.lines.push({
      component_type: 'post_payment_adjustment',
      service_date: period.week_start,
      source_type: 'post_payment_adjustment',
      source_id: carry.id,
      source_audit_id: null,
      property_id: null,
      property_label: null,
      property_type: null,
      task_type: null,
      description: `${totalCents > 0 ? 'Paid settlement supplement' : totalCents < 0 ? 'Paid settlement offset' : 'Paid settlement tax reclassification'} · ${carry.source_week_start} to ${carry.source_week_end}`,
      quantity_numerator: 1,
      quantity_denominator: 1,
      unit_rate_cents: totalCents,
      subtotal_cents: subtotalCents,
      gst_cents: gstCents,
      total_cents: totalCents,
      price_basis: 'inclusive_gst',
      profile_id: profile.id,
      gst_registered: profile.gst_status === 'registered',
      rule_id: null,
      rule_item_id: null,
      work_items: [],
      carry_adjustment: {
        source_settlement_id: carry.source_settlement_id,
        source_adjustment_id: carry.source_adjustment_id,
        source_week_start: carry.source_week_start,
        source_week_end: carry.source_week_end,
        recorded_subtotal_difference_cents: toSafeSignedInteger(carry.recorded_subtotal_difference_cents, 'carry_recorded_subtotal_difference_cents'),
        recorded_gst_difference_cents: toSafeSignedInteger(carry.recorded_gst_difference_cents, 'carry_recorded_gst_difference_cents'),
        recorded_total_difference_cents: toSafeSignedInteger(carry.recorded_total_difference_cents, 'carry_recorded_total_difference_cents'),
        previously_applied_subtotal_cents: toSafeSignedInteger(carry.previously_applied_subtotal_cents, 'carry_previously_applied_subtotal_cents'),
        previously_applied_gst_cents: toSafeSignedInteger(carry.previously_applied_gst_cents, 'carry_previously_applied_gst_cents'),
        previously_applied_total_cents: toSafeSignedInteger(carry.previously_applied_total_cents, 'carry_previously_applied_total_cents'),
        applied_subtotal_cents: subtotalCents,
        applied_gst_cents: gstCents,
        applied_total_cents: totalCents,
        applied_by: cleanText(carry.applied_by),
        applied_at: cleanText(carry.applied_at),
      },
    })
    people.set(carry.user_id, person)
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
    const includedExecutionKeys = new Set(person.lines.flatMap((line) => (
      line.work_items || []
    )).map((item) => item.execution_key))
    person.work_checklist = person.work_checklist.map((item) => ({
      ...item,
      included_in_amount: includedExecutionKeys.has(item.execution_key),
    }))
    person.work_checklist.sort((a, b) => (
      cleanText(a.scheduled_service_date || a.service_date).localeCompare(cleanText(b.scheduled_service_date || b.service_date))
      || cleanText(a.property_label || a.task_id).localeCompare(cleanText(b.property_label || b.task_id))
      || a.execution_key.localeCompare(b.execution_key)
    ))
    person.totals = aggregateSettlementAmounts(person.lines)
    if (person.totals.subtotal_cents < 0 || person.totals.gst_cents < 0 || person.totals.total_cents < 0) {
      const carryLine = person.lines.find((line) => line.component_type === 'post_payment_adjustment')
      if (carryLine) {
        person.warnings.push({
          source_type: carryLine.source_type,
          source_id: carryLine.source_id,
          reason: 'post_payment_adjustment_exceeds_target_total',
          service_date: carryLine.service_date,
          component_type: carryLine.component_type,
          description: carryLine.description,
        })
      }
    }
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
      audited_candidates: candidates.filter((candidate) => isRequestedUser(candidate.user_id) && inPeriod(candidate.service_date)).length,
      eligible_deduplicated_candidates: Array.from(dedupedEligible.values())
        .filter((entry) => isRequestedUser(entry.candidate.user_id) && inPeriod(entry.candidate.service_date)).length,
      executed_cleaning_tasks: Array.from(uniqueCleaningPaymentAssignments.values())
        .filter((assignment) => isRequestedUser(assignment.user_id)
          && inPeriod(assignment.service_date)
          && !!cleanText(assignment.actual_audit_id)).length,
      payable_cleaning_assignments: peopleResult.flatMap((person) => person.lines)
        .filter((line) => line.component_type === 'cleaning_task' && line.source_type === 'cleaning_task_assignment').length,
      deduplicated_cleaning_assignments: deduplicatedCleaningPaymentAssignments,
      executed_inspection_tasks: peopleResult.flatMap((person) => person.lines)
        .filter((line) => line.component_type === 'inspection_day')
        .reduce((count, line) => count + line.work_items.length, 0),
      excluded_auxiliary_candidates: excludedCandidates.length,
      conflicting_tasks_requiring_manual_review: requestedConflictingTaskKeys.size
        + conflictingInspectionKeys.size
        + unassignedInspectionWarnings.length,
      effective_inspection_assignments: Array.from(uniqueInspectionPaymentAssignments.values())
        .filter((assignment) => !!cleanText(assignment.user_id)).length,
      unassigned_inspection_assignments: unassignedInspectionWarnings.length,
      expected_inspection_assignments: Array.from(uniqueInspectionPaymentAssignments.values())
        .filter((assignment) => !!cleanText(assignment.user_id) && !assignment.is_payable).length,
      cleaning_assignment_candidates: uniqueCleaningAssignments.size,
      non_cancelled_cleaning_assignments: nonCancelledCleaningAssignments,
      excluded_cancelled_cleaning_assignments: cancelledCleaningAssignments,
      excluded_non_checkout_cleaning_assignments: excludedNonCheckoutCleaningAssignments,
      approved_claims: claims.filter((claim) => !claim.status || claim.status === 'approved').length,
      submitted_claims: claims.filter((claim) => claim.status === 'submitted').length,
      planned_work_items: peopleResult.reduce((count, person) => count + person.work_checklist.length, 0),
      incomplete_or_rescheduled_work_items: peopleResult.flatMap((person) => person.work_checklist)
        .filter((item) => item.status === 'incomplete' || item.status === 'rescheduled' || item.status === 'cancelled').length,
      legacy_tasks_requiring_manual_review: legacyTasksWithoutPerformerAudit.length,
    },
    excluded_candidates: excludedCandidates,
    manual_review: {
      legacy_tasks_without_performer_audit: legacyTasksWithoutPerformerAudit,
      warnings: [
        ...peopleResult.flatMap((person) => person.warnings.map((warning) => ({
          user_id: person.user_id,
          user_name: person.user_name,
          ...warning,
        }))),
        ...unassignedInspectionWarnings,
      ],
    },
  }
}
