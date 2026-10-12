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
  work_items: SettlementWorkItem[]
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
  status: 'completed' | 'rescheduled' | 'incomplete' | 'management_closed' | 'legacy_completed_unverified' | 'cancelled'
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

const LEGACY_COMPLETED_CLEANING_STATUSES = new Set([
  'cleaned', 'restock_pending', 'restocked', 'to_inspect', 'to_hang_keys',
  'keys_hung', 'inspected', 'ready', 'completed', 'done',
])
const LEGACY_COMPLETED_INSPECTION_STATUSES = new Set([
  'inspected', 'to_hang_keys', 'keys_hung', 'ready', 'completed', 'done',
])

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
            AND ($3::text[] IS NULL OR (CASE
              WHEN lower(COALESCE(t.task_type, t.type, '')) = 'checkin_clean'
                THEN COALESCE(t.inspector_id::text, t.assignee_id::text)
              WHEN lower(COALESCE(t.inspection_mode, '')) = 'self_complete'
                THEN COALESCE(t.inspector_id::text, t.cleaner_id::text, t.assignee_id::text)
              ELSE t.inspector_id::text
            END) = ANY($3::text[]))
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
              t.status AS task_status, a.status_after, a.metadata
         FROM work_task_action_audits a
         LEFT JOIN cleaning_tasks t ON t.id::text = a.source_id::text
         LEFT JOIN properties p ON p.id::text = COALESCE(
           NULLIF(TRIM(a.metadata->'property_snapshot'->>'property_id'), ''),
           t.property_id::text
         )
        WHERE a.source_type = 'cleaning_tasks'
          AND a.performed_as_action = ANY($4::text[])
          AND NULLIF(TRIM(a.performed_by_user_id), '') IS NOT NULL
          AND a.source_id::text IN (SELECT task_id FROM scoped_tasks)
        ORDER BY a.performed_at, a.id`,
      [period.week_start, period.week_end, userFilter, ['submit_inspection', 'fill_supplies', 'complete_cleaning']],
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
                (CASE
                  WHEN lower(COALESCE(t.task_type, t.type, '')) = 'checkin_clean'
                    THEN COALESCE(t.inspector_id::text, t.assignee_id::text)
                  WHEN lower(COALESCE(t.inspection_mode, '')) = 'self_complete'
                    THEN COALESCE(t.inspector_id::text, t.cleaner_id::text, t.assignee_id::text)
                  ELSE t.inspector_id::text
                END) AS user_id,
                COALESCE(
                  NULLIF(TRIM(u.display_name), ''), NULLIF(TRIM(u.username), ''),
                  NULLIF(TRIM(u.legal_name), ''),
                  (CASE
                    WHEN lower(COALESCE(t.task_type, t.type, '')) = 'checkin_clean'
                      THEN COALESCE(t.inspector_id::text, t.assignee_id::text)
                    WHEN lower(COALESCE(t.inspection_mode, '')) = 'self_complete'
                      THEN COALESCE(t.inspector_id::text, t.cleaner_id::text, t.assignee_id::text)
                    ELSE t.inspector_id::text
                  END)
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
           LEFT JOIN users u ON u.id::text = (CASE
             WHEN lower(COALESCE(t.task_type, t.type, '')) = 'checkin_clean'
               THEN COALESCE(t.inspector_id::text, t.assignee_id::text)
             WHEN lower(COALESCE(t.inspection_mode, '')) = 'self_complete'
               THEN COALESCE(t.inspector_id::text, t.cleaner_id::text, t.assignee_id::text)
             ELSE t.inspector_id::text
           END)
          WHERE (CASE
                  WHEN lower(COALESCE(t.inspection_mode, '')) = 'deferred' AND t.inspection_due_date IS NOT NULL
                    THEN t.inspection_due_date
                  ELSE COALESCE(t.task_date, t.date)
                END) BETWEEN $1::date AND $2::date
            AND lower(COALESCE(t.task_type, t.type, '')) IN ('checkout_clean', 'checkin_clean')
            AND lower(COALESCE(t.inspection_mode, '')) IN ('same_day', 'deferred')
            AND lower(COALESCE(t.inspection_scope, 'inspect_and_hang')) <> 'password_only'
            AND (CASE
              WHEN lower(COALESCE(t.task_type, t.type, '')) = 'checkin_clean'
                THEN COALESCE(t.inspector_id::text, t.assignee_id::text)
              WHEN lower(COALESCE(t.inspection_mode, '')) = 'self_complete'
                THEN COALESCE(t.inspector_id::text, t.cleaner_id::text, t.assignee_id::text)
              ELSE t.inspector_id::text
            END) IS NOT NULL
            AND ($3::text[] IS NULL OR (CASE
              WHEN lower(COALESCE(t.task_type, t.type, '')) = 'checkin_clean'
                THEN COALESCE(t.inspector_id::text, t.assignee_id::text)
              WHEN lower(COALESCE(t.inspection_mode, '')) = 'self_complete'
                THEN COALESCE(t.inspector_id::text, t.cleaner_id::text, t.assignee_id::text)
              ELSE t.inspector_id::text
            END) = ANY($3::text[]))
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
                t.property_id, COALESCE(NULLIF(TRIM(p.code), ''), NULLIF(TRIM(p.address), ''), t.property_id) AS property_label,
                NULLIF(TRIM(p.type), '') AS property_type,
                COALESCE(NULLIF(TRIM(t.task_type), ''), NULLIF(TRIM(t.type), '')) AS task_type,
                1 AS plan_priority,
                e.sequence_no AS plan_order
           FROM work_task_events e
           JOIN cleaning_tasks t ON e.task_id = 'cleaning_task:' || t.id::text
           LEFT JOIN properties p ON p.id::text = t.property_id::text
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
                  WHEN (CASE
                    WHEN lower(COALESCE(t.task_type, t.type, '')) = 'checkin_clean' THEN COALESCE(
                      NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspector_id}'), ''),
                      NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,assignee_id}'), '')
                    )
                    WHEN lower(COALESCE(NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspection_mode}'), ''), '')) = 'self_complete' THEN COALESCE(
                      NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspector_id}'), ''),
                      NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,cleaner_id}'), ''),
                      NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,assignee_id}'), '')
                    )
                    ELSE NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspector_id}'), '')
                  END) IS DISTINCT FROM (CASE
                    WHEN lower(COALESCE(t.task_type, t.type, '')) = 'checkin_clean' THEN COALESCE(
                      NULLIF(TRIM(e.payload#>>'{arrangement_revision,after,inspector_id}'), ''),
                      NULLIF(TRIM(e.payload#>>'{arrangement_revision,after,assignee_id}'), '')
                    )
                    WHEN lower(COALESCE(NULLIF(TRIM(e.payload#>>'{arrangement_revision,after,inspection_mode}'), ''), '')) = 'self_complete' THEN COALESCE(
                      NULLIF(TRIM(e.payload#>>'{arrangement_revision,after,inspector_id}'), ''),
                      NULLIF(TRIM(e.payload#>>'{arrangement_revision,after,cleaner_id}'), ''),
                      NULLIF(TRIM(e.payload#>>'{arrangement_revision,after,assignee_id}'), '')
                    )
                    ELSE NULLIF(TRIM(e.payload#>>'{arrangement_revision,after,inspector_id}'), '')
                  END) THEN 'reassigned_after_plan'
                  ELSE 'inspection_plan_changed_after_plan'
                END AS arrangement_reason,
                NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspection_due_date}'), '')::date::text AS inspection_due_date,
                NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspection_mode}'), '') AS inspection_mode,
                t.status AS task_status,
                (CASE
                  WHEN lower(COALESCE(t.task_type, t.type, '')) = 'checkin_clean' THEN COALESCE(
                    NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspector_id}'), ''),
                    NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,assignee_id}'), '')
                  )
                  WHEN lower(COALESCE(NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspection_mode}'), ''), '')) = 'self_complete' THEN COALESCE(
                    NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspector_id}'), ''),
                    NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,cleaner_id}'), ''),
                    NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,assignee_id}'), '')
                  )
                  ELSE NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspector_id}'), '')
                END) AS user_id,
                COALESCE(NULLIF(TRIM(u.display_name), ''), NULLIF(TRIM(u.username), ''), NULLIF(TRIM(u.legal_name), ''), u.id::text) AS user_name,
                t.property_id, COALESCE(NULLIF(TRIM(p.code), ''), NULLIF(TRIM(p.address), ''), t.property_id) AS property_label,
                NULLIF(TRIM(p.type), '') AS property_type,
                COALESCE(NULLIF(TRIM(t.task_type), ''), NULLIF(TRIM(t.type), '')) AS task_type,
                1 AS plan_priority,
                e.sequence_no AS plan_order
           FROM work_task_events e
           JOIN cleaning_tasks t ON e.task_id = 'cleaning_task:' || t.id::text
           LEFT JOIN properties p ON p.id::text = t.property_id::text
           LEFT JOIN users u ON u.id::text = (CASE
             WHEN lower(COALESCE(t.task_type, t.type, '')) = 'checkin_clean' THEN COALESCE(
               NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspector_id}'), ''),
               NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,assignee_id}'), '')
             )
             WHEN lower(COALESCE(NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspection_mode}'), ''), '')) = 'self_complete' THEN COALESCE(
               NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspector_id}'), ''),
               NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,cleaner_id}'), ''),
               NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,assignee_id}'), '')
             )
             ELSE NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspector_id}'), '')
           END)
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
              OR (CASE
                WHEN lower(COALESCE(t.task_type, t.type, '')) = 'checkin_clean' THEN COALESCE(
                  NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspector_id}'), ''),
                  NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,assignee_id}'), '')
                )
                ELSE NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspector_id}'), '')
              END) IS DISTINCT FROM (CASE
                WHEN lower(COALESCE(t.task_type, t.type, '')) = 'checkin_clean' THEN COALESCE(
                  NULLIF(TRIM(e.payload#>>'{arrangement_revision,after,inspector_id}'), ''),
                  NULLIF(TRIM(e.payload#>>'{arrangement_revision,after,assignee_id}'), '')
                )
                ELSE NULLIF(TRIM(e.payload#>>'{arrangement_revision,after,inspector_id}'), '')
              END)
              OR NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspection_mode}'), '')
                IS DISTINCT FROM NULLIF(TRIM(e.payload#>>'{arrangement_revision,after,inspection_mode}'), '')
              OR NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspection_scope}'), '')
                IS DISTINCT FROM NULLIF(TRIM(e.payload#>>'{arrangement_revision,after,inspection_scope}'), '')
            )
            AND (CASE
              WHEN lower(COALESCE(NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspection_mode}'), ''), '')) = 'deferred'
                AND NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspection_due_date}'), '') IS NOT NULL
                THEN NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspection_due_date}'), '')::date
              ELSE NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,scheduled_service_date}'), '')::date
            END) BETWEEN $1::date AND $2::date
            AND (CASE
              WHEN lower(COALESCE(t.task_type, t.type, '')) = 'checkin_clean' THEN COALESCE(
                NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspector_id}'), ''),
                NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,assignee_id}'), '')
              )
              WHEN lower(COALESCE(NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspection_mode}'), ''), '')) = 'self_complete' THEN COALESCE(
                NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspector_id}'), ''),
                NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,cleaner_id}'), ''),
                NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,assignee_id}'), '')
              )
              ELSE NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspector_id}'), '')
            END) IS NOT NULL
            AND ($3::text[] IS NULL OR (CASE
              WHEN lower(COALESCE(t.task_type, t.type, '')) = 'checkin_clean' THEN COALESCE(
                NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspector_id}'), ''),
                NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,assignee_id}'), '')
              )
              WHEN lower(COALESCE(NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspection_mode}'), ''), '')) = 'self_complete' THEN COALESCE(
                NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspector_id}'), ''),
                NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,cleaner_id}'), ''),
                NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,assignee_id}'), '')
              )
              ELSE NULLIF(TRIM(e.payload#>>'{arrangement_revision,before,inspector_id}'), '')
            END) = ANY($3::text[]))
       )
       SELECT DISTINCT ON (task_id, component_type, user_id, service_date)
              task_id, component_type, service_date, current_service_date, arrangement_reason,
              inspection_due_date, inspection_mode, task_status, user_id, user_name,
              property_id, property_label, property_type, task_type
         FROM planned
        ORDER BY task_id, component_type, user_id, service_date, plan_priority DESC, plan_order DESC`,
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

  const warn = (
    userId: string,
    userName: string | null,
    sourceType: string,
    sourceId: string,
    reason: string,
    detail?: { service_date?: string; component_type?: SettlementComponentType; description?: string },
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
  const isRequestedUser = (userId: string) => !userFilter || userFilter.includes(userId)
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
  for (const candidate of candidates) {
    const decision = classifyWorkloadAudit(candidate)
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
    if (decision.component_type === 'inspection_day' || decision.component_type === 'cleaning_task') {
      eligibleCandidates.push({ candidate, component: decision.component_type })
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
    const executionKey = `${component === 'cleaning_task' ? 'cleaning' : 'inspection'}:${assignment.task_id}`
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
    const legacyCompleted = component === 'cleaning_task'
      ? LEGACY_COMPLETED_CLEANING_STATUSES.has(taskStatus)
      : LEGACY_COMPLETED_INSPECTION_STATUSES.has(taskStatus)
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
        component === 'cleaning_task' ? 'cleaning_task_assignment' : 'inspection_task_assignment',
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

  const inspectionDays = new Map<string, {
    user_id: string
    user_name: string | null
    service_date: string
    work_items: SettlementWorkItem[]
  }>()
  for (const { candidate, component } of dedupedEligible.values()) {
    if (!isRequestedUser(candidate.user_id)) continue
    if (!inPeriod(candidate.service_date)) continue
    const workItem = candidateWorkItem(candidate, component)
    if (component === 'cleaning_task') {
      appendLine({
        user_id: candidate.user_id,
        user_name: candidate.performed_by_name,
        component_type: 'cleaning_task',
        service_date: candidate.service_date,
        source_type: 'work_task_action_audit',
        source_id: workItem.execution_key,
        source_audit_id: candidate.audit_id,
        property_id: candidate.property_id,
        property_label: candidate.property_label,
        property_type: candidate.property_type,
        task_type: candidate.task_type,
        description: candidate.property_label
          ? `Cleaning · ${candidate.property_label} · ${candidate.property_type || '房型未登记'}`
          : `Cleaning task · ${candidate.property_type || '房型未登记'}`,
        quantity_numerator: 1,
        quantity_denominator: 1,
        work_items: [workItem],
      })
      continue
    }
    const key = `${candidate.user_id}:${candidate.service_date}`
    const day = inspectionDays.get(key) || {
      user_id: candidate.user_id,
      user_name: candidate.performed_by_name,
      service_date: candidate.service_date,
      work_items: [],
    }
    day.work_items.push(workItem)
    inspectionDays.set(key, day)
  }
  for (const day of inspectionDays.values()) {
    const propertyCount = new Set(day.work_items.map((item) => item.property_id || item.property_label || item.task_id)).size
    appendLine({
      user_id: day.user_id,
      user_name: day.user_name,
      component_type: 'inspection_day',
      service_date: day.service_date,
      source_type: 'work_task_action_audit',
      source_id: `inspection-day:${day.service_date}`,
      description: `Inspection day · ${propertyCount} property(ies) · ${day.work_items.length} task(s)`,
      quantity_numerator: 1,
      quantity_denominator: 1,
      work_items: day.work_items,
    })
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
      executed_cleaning_tasks: peopleResult.flatMap((person) => person.lines)
        .filter((line) => line.component_type === 'cleaning_task' && line.source_type === 'work_task_action_audit').length,
      executed_inspection_tasks: peopleResult.flatMap((person) => person.lines)
        .filter((line) => line.component_type === 'inspection_day')
        .reduce((count, line) => count + line.work_items.length, 0),
      excluded_auxiliary_candidates: excludedCandidates.length,
      conflicting_tasks_requiring_manual_review: requestedConflictingTaskKeys.size,
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
      warnings: peopleResult.flatMap((person) => person.warnings.map((warning) => ({
        user_id: person.user_id,
        user_name: person.user_name,
        ...warning,
      }))),
    },
  }
}
