import { createHash, randomUUID } from 'crypto'
import { pgPool, pgRunInTransaction } from '../dbAdapter'
import {
  buildSettlementPeriod,
  getMelbourneDate,
  getSettlementWeekStart,
  PERSONNEL_SETTLEMENT_CALCULATION_VERSION,
  type SettlementLineAmounts,
} from './personnelSettlement'
import { buildPersonnelSettlementPreview } from './personnelSettlementPreview'
import { assertPersonnelSettlementSchemaReady } from './personnelSettlementSchema'
import { ensurePersonnelSettlementDocument, listPersonnelSettlementDocuments } from './personnelSettlementDocuments'
import { isPersonnelSettlementPhase5SchemaReady } from './personnelSettlementPhase5Schema'
import { emitNotificationEvent } from '../services/notificationEvents'
import {
  listPersonnelClaimsWithEvidence,
  reviewPersonnelClaimInTransaction,
  submitPersonnelClaimInTransaction,
  type PersonnelClaimReviewInput,
} from './personnelWorkloadClaims'

type Queryable = { query: (sql: string, params?: any[]) => Promise<any> }

export type PersonnelSettlementStatus =
  | 'draft'
  | 'awaiting_confirmation'
  | 'confirmed'
  | 'disputed'
  | 'finance_approved'
  | 'paid'
  | 'void'

export type PersonnelSettlementAction =
  | 'issue_confirmation'
  | 'confirm'
  | 'dispute'
  | 'resolve_dispute'
  | 'return_for_confirmation'
  | 'adjust'
  | 'reopen'
  | 'confirm_paid'
  | 'void'

const SETTLEMENT_STATUSES = new Set<PersonnelSettlementStatus>([
  'draft', 'awaiting_confirmation', 'confirmed', 'disputed', 'finance_approved', 'paid', 'void',
])
const ACTION_ALLOWED_STATUSES: Record<PersonnelSettlementAction, PersonnelSettlementStatus[]> = {
  issue_confirmation: ['draft'],
  confirm: ['awaiting_confirmation'],
  dispute: ['awaiting_confirmation'],
  resolve_dispute: ['disputed'],
  return_for_confirmation: ['confirmed'],
  adjust: ['draft'],
  reopen: ['awaiting_confirmation', 'confirmed'],
  confirm_paid: ['confirmed', 'finance_approved'],
  void: ['draft', 'awaiting_confirmation', 'confirmed', 'disputed', 'finance_approved'],
}
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

function cleanText(value: unknown) {
  return String(value ?? '').trim()
}

function requireReason(value: unknown, code = 'settlement_action_reason_required') {
  const reason = cleanText(value)
  if (!reason) throw new Error(code)
  if (reason.length > 1000) throw new Error('settlement_action_reason_too_long')
  return reason
}

function safeInteger(value: unknown, field: string, options?: { min?: number; max?: number }) {
  const parsed = Number(value)
  const minimum = options?.min ?? 0
  const maximum = options?.max ?? 100_000_000
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`invalid_${field}`)
  return parsed
}

function parseJsonObject(value: unknown): Record<string, any> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return { ...(value as Record<string, any>) }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {}
  }
  return {}
}

export function getPersonnelSettlementReturnDeliveryRetry(row: any) {
  if (cleanText(row?.status) !== 'awaiting_confirmation') return null
  const ruleSnapshot = parseJsonObject(row?.rule_snapshot)
  const financeReturn = parseJsonObject(ruleSnapshot.finance_return)
  const confirmationRequest = parseJsonObject(ruleSnapshot.confirmation_request)
  const confirmationRevision = cleanText(confirmationRequest.revision)
  if (cleanText(confirmationRequest.round) !== 'finance_return' || !confirmationRevision || !cleanText(financeReturn.returned_at)) {
    return null
  }
  return {
    userId: cleanText(row?.user_id),
    weekStart: cleanText(row?.week_start),
    weekEnd: cleanText(row?.week_end),
    confirmationRevision,
  }
}

export function assertPersonnelSettlementTransition(action: PersonnelSettlementAction, status: string) {
  if (!SETTLEMENT_STATUSES.has(status as PersonnelSettlementStatus)) throw new Error('invalid_settlement_status')
  if (!ACTION_ALLOWED_STATUSES[action]?.includes(status as PersonnelSettlementStatus)) {
    throw new Error('settlement_transition_invalid')
  }
}

export function getPersonnelSettlementAvailableActions(status: string) {
  return (Object.keys(ACTION_ALLOWED_STATUSES) as PersonnelSettlementAction[])
    .filter((action) => ACTION_ALLOWED_STATUSES[action].includes(status as PersonnelSettlementStatus))
}

function moneyFields(row: any) {
  return {
    subtotal_cents: safeInteger(row?.subtotal_cents ?? 0, 'subtotal_cents'),
    gst_cents: safeInteger(row?.gst_cents ?? 0, 'gst_cents'),
    total_cents: safeInteger(row?.total_cents ?? 0, 'total_cents'),
  }
}

export type PersonnelSettlementDisputeDecision = 'keep_amount' | 'edit_amount'

export function calculatePersonnelSettlementDisputeResolution(input: {
  decision: PersonnelSettlementDisputeDecision
  baseSubtotalCents: number
  baseGstCents: number
  currentTotalCents: number
  finalTotalCents?: number | null
}) {
  const baseSubtotalCents = safeInteger(input.baseSubtotalCents, 'subtotal_cents')
  const baseGstCents = safeInteger(input.baseGstCents, 'gst_cents')
  const currentTotalCents = safeInteger(input.currentTotalCents, 'total_cents')
  if (input.decision !== 'keep_amount' && input.decision !== 'edit_amount') {
    throw new Error('invalid_settlement_dispute_decision')
  }
  const finalTotalCents = input.decision === 'keep_amount'
    ? currentTotalCents
    : safeInteger(input.finalTotalCents, 'final_total_cents')
  const subtotalCents = finalTotalCents - baseGstCents
  if (subtotalCents < 0) throw new Error('settlement_adjustment_exceeds_total')
  const adjustmentCents = safeInteger(
    subtotalCents - baseSubtotalCents,
    'settlement_adjustment_cents',
    { min: -100_000_000, max: 100_000_000 },
  )
  return {
    adjustment_cents: adjustmentCents,
    subtotal_cents: subtotalCents,
    gst_cents: baseGstCents,
    total_cents: finalTotalCents,
  }
}

function settlementAuditSummary(row: any) {
  return {
    id: String(row?.id || ''),
    batch_id: String(row?.batch_id || ''),
    user_id: String(row?.user_id || ''),
    status: String(row?.status || ''),
    ...moneyFields(row),
    company_expense_id: row?.company_expense_id ? String(row.company_expense_id) : null,
    paid_at: row?.paid_at ? String(row.paid_at) : null,
    payment_reference: row?.payment_reference ? String(row.payment_reference) : null,
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

async function insertPersonnelSettlementLine(client: Queryable, settlementId: string, line: any) {
  const lineId = randomUUID()
  const inserted = await client.query(
    `INSERT INTO personnel_settlement_lines (
       id, settlement_id, component_type, service_date, source_type, source_id,
       source_audit_id, property_id, task_type, description,
       quantity_numerator, quantity_denominator, unit_rate_cents,
       subtotal_cents, gst_cents, total_cents, price_basis, calculation_snapshot
     ) VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb)
     ON CONFLICT (settlement_id, component_type, source_type, source_id) DO NOTHING
     RETURNING id`,
    [
      lineId, settlementId, line.component_type, line.service_date,
      line.source_type, line.source_id, line.source_audit_id, line.property_id,
      line.task_type, line.description, line.quantity_numerator,
      line.quantity_denominator, line.unit_rate_cents, line.subtotal_cents,
      line.gst_cents, line.total_cents, line.price_basis,
      JSON.stringify({
        profile_id: line.profile_id,
        gst_registered: line.gst_registered,
        rule_id: line.rule_id,
        rule_item_id: line.rule_item_id,
        property_label: line.property_label,
        property_type: line.property_type,
      }),
    ],
  )
  return inserted.rows?.[0]?.id ? String(inserted.rows[0].id) : null
}

function sanitizePaymentSnapshot(snapshot: unknown, includeBankDetails: boolean) {
  const value = parseJsonObject(snapshot)
  if (includeBankDetails) return value
  const accountNumber = cleanText(value.bank_account_number).replace(/\D/g, '')
  const bsb = cleanText(value.bank_bsb).replace(/\D/g, '')
  return {
    bank_details_complete: Boolean(value.bank_account_name && bsb && accountNumber),
    bank_account_name: value.bank_account_name ? '已登记' : null,
    bank_bsb_masked: bsb ? `•••-${bsb.slice(-3)}` : null,
    bank_account_masked: accountNumber ? `•••• ${accountNumber.slice(-4)}` : null,
    payment_amount_cents: value.payment_amount_cents == null ? null : Number(value.payment_amount_cents),
    payment_date: value.payment_date || null,
  }
}

function serializeSettlement(row: any, includeBankDetails = false) {
  const ruleSnapshot = parseJsonObject(row.rule_snapshot)
  const disputeResolution = parseJsonObject(ruleSnapshot.dispute_resolution)
  return {
    ...row,
    ...moneyFields(row),
    line_count: Number(row.line_count || 0),
    evidence_count: Number(row.evidence_count || 0),
    finance_adjustment_cents: Number(ruleSnapshot.finance_adjustment?.amount_cents || 0),
    dispute_resolution: Object.keys(disputeResolution).length ? {
      decision: cleanText(disputeResolution.decision) || null,
      previous_total_cents: Number(disputeResolution.previous_total_cents || 0),
      final_total_cents: Number(disputeResolution.final_total_cents || 0),
      resolved_at: cleanText(disputeResolution.resolved_at) || null,
    } : null,
    available_actions: getPersonnelSettlementAvailableActions(String(row.status || '')),
    payment_destination_snapshot: row.payment_destination_snapshot
      ? sanitizePaymentSnapshot(row.payment_destination_snapshot, includeBankDetails)
      : null,
  }
}

async function refreshBatchStatus(client: Queryable, batchId: string, actorUserId?: string) {
  const result = await client.query(
    `SELECT status, COUNT(*)::int AS count
       FROM personnel_weekly_settlements
      WHERE batch_id=$1 AND status <> 'void'
      GROUP BY status`,
    [batchId],
  )
  const counts = new Map<string, number>((result.rows || []).map((row: any) => [String(row.status), Number(row.count || 0)]))
  const total = Array.from(counts.values()).reduce((sum, count) => sum + count, 0)
  let status = 'draft'
  if (counts.get('draft')) status = 'draft'
  else if (counts.get('awaiting_confirmation')) status = 'open_confirmation'
  else if (counts.get('confirmed') || counts.get('disputed')) status = 'under_finance_review'
  else if (total > 0 && (counts.get('finance_approved') || 0) + (counts.get('paid') || 0) === total) status = 'finalized'
  await client.query(
    `UPDATE personnel_settlement_batches
        SET status=$1,
            finalized_by=CASE WHEN $1='finalized' THEN COALESCE(finalized_by,$2) ELSE NULL END,
            finalized_at=CASE WHEN $1='finalized' THEN COALESCE(finalized_at,now()) ELSE NULL END
      WHERE id=$3`,
    [status, actorUserId || null, batchId],
  )
  return status
}

const SETTLEMENT_LIST_SELECT = `
  SELECT settlement.id, settlement.batch_id, settlement.user_id,
         settlement.profile_snapshot, settlement.rule_snapshot,
         settlement.subtotal_cents, settlement.gst_cents, settlement.total_cents,
         settlement.currency, settlement.status,
         settlement.workload_amount_confirmed_at::text,
         settlement.workload_amount_confirmation_note,
         settlement.disputed_at::text, settlement.dispute_note,
         settlement.finance_reviewed_by, settlement.finance_reviewed_at::text,
         settlement.company_expense_id, settlement.paid_by, settlement.paid_at::text,
         settlement.payment_reference, settlement.payment_destination_snapshot,
         settlement.created_at::text, settlement.updated_at::text,
         batch.week_start::text, batch.week_end::text, batch.timezone,
         batch.source_cutoff_at::text, batch.calculation_version, batch.status AS batch_status,
         COALESCE(NULLIF(TRIM(u.display_name),''), NULLIF(TRIM(u.username),''),
                  NULLIF(TRIM(u.legal_name),''), u.id::text) AS user_name,
         COUNT(DISTINCT line.id)::int AS line_count,
         COUNT(DISTINCT evidence.id)::int AS evidence_count
    FROM personnel_weekly_settlements settlement
    JOIN personnel_settlement_batches batch ON batch.id=settlement.batch_id
    JOIN users u ON u.id::text=settlement.user_id::text
    LEFT JOIN personnel_settlement_lines line ON line.settlement_id=settlement.id
    LEFT JOIN personnel_workload_claim_evidence evidence
      ON line.source_type='workload_claim' AND evidence.claim_id=line.source_id`

export async function listPersonnelWeeklySettlements(input: {
  weekStart?: string
  status?: string
  search?: string
  userId?: string
}, executor: Queryable | null = pgPool) {
  if (!executor) throw new Error('pg_required')
  assertPersonnelSettlementSchemaReady()
  const params: any[] = []
  const where: string[] = []
  if (input.weekStart) {
    const period = buildSettlementPeriod(input.weekStart)
    params.push(period.week_start); where.push(`batch.week_start=$${params.length}::date`)
  }
  if (input.status) { params.push(input.status); where.push(`settlement.status=$${params.length}`) }
  if (input.userId) { params.push(input.userId); where.push(`settlement.user_id=$${params.length}`) }
  if (cleanText(input.search)) {
    params.push(`%${cleanText(input.search).replace(/[%_]/g, '\\$&')}%`)
    where.push(`(COALESCE(u.display_name,'') ILIKE $${params.length} ESCAPE '\\' OR COALESCE(u.username,'') ILIKE $${params.length} ESCAPE '\\' OR COALESCE(u.legal_name,'') ILIKE $${params.length} ESCAPE '\\')`)
  }
  const result = await executor.query(
    `${SETTLEMENT_LIST_SELECT}
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     GROUP BY settlement.id, batch.id, u.id
     ORDER BY batch.week_start DESC, user_name, settlement.id
     LIMIT 500`,
    params,
  )
  return (result.rows || []).map((row: any) => serializeSettlement(row, false))
}

export async function getPersonnelWeeklySettlement(input: {
  settlementId: string
  requestingUserId?: string
  includeBankDetails?: boolean
}, executor: Queryable | null = pgPool) {
  if (!executor) throw new Error('pg_required')
  assertPersonnelSettlementSchemaReady()
  const params: any[] = [input.settlementId]
  const ownerFilter = input.requestingUserId ? 'AND settlement.user_id=$2' : ''
  if (input.requestingUserId) params.push(input.requestingUserId)
  const result = await executor.query(
    `${SETTLEMENT_LIST_SELECT}
      WHERE settlement.id=$1 ${ownerFilter}
      GROUP BY settlement.id, batch.id, u.id`,
    params,
  )
  const row = result.rows?.[0]
  if (!row) return null
  const linesResult = await executor.query(
    `SELECT line.id, line.component_type, line.service_date::text, line.source_type,
            line.source_id, line.source_audit_id, line.property_id, line.task_type,
            line.description, line.quantity_numerator, line.quantity_denominator,
            line.unit_rate_cents, line.subtotal_cents, line.gst_cents, line.total_cents,
            line.price_basis, line.calculation_snapshot, line.created_at::text,
            COALESCE(evidence.count,0)::int AS evidence_count
       FROM personnel_settlement_lines line
       LEFT JOIN (
         SELECT claim_id, COUNT(*)::int AS count
           FROM personnel_workload_claim_evidence
          GROUP BY claim_id
       ) evidence ON line.source_type='workload_claim' AND evidence.claim_id=line.source_id
      WHERE line.settlement_id=$1
      ORDER BY line.service_date, line.created_at, line.id`,
    [input.settlementId],
  )
  const lines = (linesResult.rows || []).map((line: any) => ({
    ...line,
    quantity_numerator: Number(line.quantity_numerator),
    quantity_denominator: Number(line.quantity_denominator),
    unit_rate_cents: Number(line.unit_rate_cents),
    subtotal_cents: Number(line.subtotal_cents),
    gst_cents: Number(line.gst_cents),
    total_cents: Number(line.total_cents),
    evidence_count: Number(line.evidence_count || 0),
  }))
  const lineTotals: SettlementLineAmounts = lines.reduce((sum: SettlementLineAmounts, line: any) => ({
    subtotal_cents: sum.subtotal_cents + line.subtotal_cents,
    gst_cents: sum.gst_cents + line.gst_cents,
    total_cents: sum.total_cents + line.total_cents,
  }), { subtotal_cents: 0, gst_cents: 0, total_cents: 0 })
  const auditsResult = await executor.query(
    `SELECT a.id, a.action, a.actor_id, a.before_json, a.after_json, a.created_at::text,
            COALESCE(NULLIF(TRIM(u.display_name),''), NULLIF(TRIM(u.username),''), u.id::text) AS actor_name
       FROM audit_logs a
       LEFT JOIN users u ON u.id::text=a.actor_id::text
      WHERE a.entity='personnel_weekly_settlement' AND a.entity_id=$1
      ORDER BY a.created_at DESC, a.id DESC`,
    [input.settlementId],
  )
  const settlement = serializeSettlement(row, !!input.includeBankDetails)
  const paymentDestinationPreview = input.includeBankDetails
    ? (settlement.payment_destination_snapshot || (await executor.query(
        `SELECT bank_account_name, bank_bsb, bank_account_number
           FROM users
          WHERE id::text=$1`,
        [row.user_id],
      )).rows?.[0] || null)
    : null
  const phase5SchemaReady = await isPersonnelSettlementPhase5SchemaReady(executor)
  const documents = phase5SchemaReady
    ? await listPersonnelSettlementDocuments(input.settlementId, executor)
    : []
  const relatedClaims = await listPersonnelClaimsWithEvidence({
    userId: String(row.user_id),
    weekStart: String(row.week_start),
    excludeDrafts: true,
  }, executor)
  const includedClaimIds = new Set(
    lines
      .filter((line: any) => line.source_type === 'workload_claim')
      .map((line: any) => String(line.source_id || '')),
  )
  return {
    ...settlement,
    payment_destination_preview: paymentDestinationPreview,
    lines,
    base_totals: lineTotals,
    finance_adjustment_cents: settlement.subtotal_cents - lineTotals.subtotal_cents,
    audits: auditsResult.rows || [],
    documents,
    related_claims: relatedClaims.map((claim: any) => ({
      ...claim,
      included_in_settlement: includedClaimIds.has(String(claim.id)),
    })),
    phase5_schema_ready: phase5SchemaReady,
  }
}

export async function generatePersonnelSettlementWeek(input: {
  weekStart: string
  actorUserId: string
  userIds?: string[]
  triggerSource?: 'manual' | 'scheduled'
}) {
  assertPersonnelSettlementSchemaReady()
  if (!pgPool) throw new Error('pg_required')
  const period = buildSettlementPeriod(input.weekStart)
  if (period.week_end >= getMelbourneDate()) throw new Error('settlement_week_not_finished')
  const requestedUserIds = Array.from(new Set((input.userIds || []).map(cleanText).filter(Boolean)))
  if (requestedUserIds.length > 100) throw new Error('too_many_user_ids')

  const generation = await pgRunInTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('personnel-settlement-week'), hashtext($1))", [period.week_start])
    const preview = await buildPersonnelSettlementPreview({
      week_start: period.week_start,
      user_ids: requestedUserIds,
    }, client)
    const blockedUserIds = new Set(
      (preview.manual_review?.warnings || []).map((warning: any) => String(warning.user_id || '')).filter(Boolean),
    )
    const blockingIssues = (preview.manual_review?.warnings || []).map((warning: any) => ({
      user_id: String(warning.user_id || ''),
      user_name: cleanText(warning.user_name) || String(warning.user_id || ''),
      source_type: cleanText(warning.source_type),
      source_id: cleanText(warning.source_id),
      code: cleanText(warning.reason) || 'manual_review_required',
    }))
    const eligiblePeople = (preview.people || []).filter((person: any) => (
      person.profile && person.lines?.length > 0 && !blockedUserIds.has(String(person.user_id))
    ))
    const sourceCutoffAt = new Date().toISOString()
    const batchId = randomUUID()
    await client.query(
      `INSERT INTO personnel_settlement_batches (
         id, week_start, week_end, timezone, source_cutoff_at,
         calculation_version, status, generated_by, generated_at, error_summary
       ) VALUES ($1,$2::date,$3::date,$4,$5::timestamptz,$6,'draft',$7,now(),$8::jsonb)
       ON CONFLICT (week_start, week_end) DO NOTHING`,
      [
        batchId, period.week_start, period.week_end, period.timezone, sourceCutoffAt,
        preview.calculation_version, input.actorUserId,
        JSON.stringify({
          excluded_candidates: preview.source_summary.excluded_auxiliary_candidates,
          conflicting_tasks_requiring_manual_review: preview.source_summary.conflicting_tasks_requiring_manual_review,
          cleaning_assignment_candidates: preview.source_summary.cleaning_assignment_candidates,
          excluded_cancelled_cleaning_assignments: preview.source_summary.excluded_cancelled_cleaning_assignments,
          blocked_user_ids: Array.from(blockedUserIds),
          blocking_issues: blockingIssues,
        }),
      ],
    )
    const batchResult = await client.query(
      'SELECT * FROM personnel_settlement_batches WHERE week_start=$1::date AND week_end=$2::date FOR UPDATE',
      [period.week_start, period.week_end],
    )
    const batch = batchResult.rows?.[0]
    if (!batch) throw new Error('settlement_batch_create_failed')
    const locked = await client.query(
      `SELECT id, status
         FROM personnel_weekly_settlements
        WHERE batch_id=$1 AND status <> ALL($2::text[])
        FOR UPDATE`,
      [batch.id, ['draft', 'void']],
    )
    if (locked.rowCount) throw new Error('settlement_batch_locked')

    const existingResult = await client.query(
      'SELECT * FROM personnel_weekly_settlements WHERE batch_id=$1 FOR UPDATE',
      [batch.id],
    )
    const existingByUser = new Map((existingResult.rows || []).map((row: any) => [String(row.user_id), row]))
    const generatedUserIds = new Set<string>()

    for (const person of eligiblePeople) {
      const userId = String(person.user_id)
      const profile = person.profile
      if (!profile) continue
      generatedUserIds.add(userId)
      const existing: any = existingByUser.get(userId)
      const settlementId = existing?.id || randomUUID()
      const appliedRuleIds = Array.from(new Set((person.lines || []).map((line: any) => String(line.rule_id))))
      const ruleSnapshot = {
        calculation_version: preview.calculation_version,
        source_cutoff_at: sourceCutoffAt,
        applied_rule_ids: appliedRuleIds,
        finance_adjustment: null,
      }
      const profileSnapshot = {
        id: profile.id,
        user_id: profile.user_id,
        person_type: profile.person_type,
        supplier_legal_name: profile.supplier_legal_name,
        supplier_business_name: profile.supplier_business_name,
        abn: profile.abn,
        gst_status: profile.gst_status,
        invoice_document_type: profile.invoice_document_type,
        currency: profile.currency,
        effective_from: profile.effective_from,
        effective_to: profile.effective_to,
      }
      let saved: any
      if (existing) {
        await client.query('DELETE FROM personnel_settlement_lines WHERE settlement_id=$1', [settlementId])
        const update = await client.query(
          `UPDATE personnel_weekly_settlements
              SET profile_snapshot=$1::jsonb, rule_snapshot=$2::jsonb,
                  subtotal_cents=$3, gst_cents=$4, total_cents=$5,
                  currency='AUD', status='draft',
                  workload_amount_confirmed_at=NULL, workload_amount_confirmation_note=NULL,
                  disputed_at=NULL, dispute_note=NULL, finance_reviewed_by=NULL,
                  finance_reviewed_at=NULL, company_expense_id=NULL, paid_by=NULL,
                  paid_at=NULL, payment_reference=NULL, payment_destination_snapshot=NULL,
                  updated_at=now()
            WHERE id=$6
            RETURNING *`,
          [JSON.stringify(profileSnapshot), JSON.stringify(ruleSnapshot), person.totals.subtotal_cents, person.totals.gst_cents, person.totals.total_cents, settlementId],
        )
        saved = update.rows[0]
      } else {
        const insert = await client.query(
          `INSERT INTO personnel_weekly_settlements (
             id, batch_id, user_id, profile_snapshot, rule_snapshot,
             subtotal_cents, gst_cents, total_cents, currency, status
           ) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,'AUD','draft')
           RETURNING *`,
          [settlementId, batch.id, userId, JSON.stringify(profileSnapshot), JSON.stringify(ruleSnapshot), person.totals.subtotal_cents, person.totals.gst_cents, person.totals.total_cents],
        )
        saved = insert.rows[0]
      }
      for (const line of person.lines || []) {
        await insertPersonnelSettlementLine(client, settlementId, line)
      }
      await insertAudit(
        client,
        'personnel_weekly_settlement',
        settlementId,
        existing ? 'recalculate_draft' : 'generate_draft',
        input.actorUserId,
        existing ? settlementAuditSummary(existing) : null,
        settlementAuditSummary(saved),
      )
    }

    for (const existing of existingResult.rows || []) {
      if (generatedUserIds.has(String(existing.user_id)) || String(existing.status) === 'void') continue
      await client.query('DELETE FROM personnel_settlement_lines WHERE settlement_id=$1', [existing.id])
      const voided = await client.query(
        `UPDATE personnel_weekly_settlements
            SET status='void', updated_at=now()
          WHERE id=$1
          RETURNING *`,
        [existing.id],
      )
      await insertAudit(
        client,
        'personnel_weekly_settlement',
        existing.id,
        'void_removed_from_recalculation',
        input.actorUserId,
        settlementAuditSummary(existing),
        settlementAuditSummary(voided.rows[0]),
      )
    }

    await client.query(
      `UPDATE personnel_settlement_batches
          SET source_cutoff_at=$1::timestamptz, calculation_version=$2,
              status='draft', generated_by=$3, generated_at=now(),
              finalized_by=NULL, finalized_at=NULL, error_summary=$4::jsonb
        WHERE id=$5`,
      [sourceCutoffAt, preview.calculation_version, input.actorUserId, JSON.stringify({
        source_summary: preview.source_summary,
        blocked_user_ids: Array.from(blockedUserIds),
        blocking_issues: blockingIssues,
      }), batch.id],
    )
    await insertAudit(client, 'personnel_settlement_batch', batch.id, input.triggerSource === 'scheduled' ? 'scheduled_generate' : 'manual_generate', input.actorUserId, {
      status: batch.status,
      source_cutoff_at: batch.source_cutoff_at,
    }, {
      status: 'draft',
      source_cutoff_at: sourceCutoffAt,
      generated_count: eligiblePeople.length,
      blocked_user_ids: Array.from(blockedUserIds),
      blocking_issues: blockingIssues,
    })
    return {
      batch_id: String(batch.id),
      generated_count: eligiblePeople.length,
      blocked_user_ids: Array.from(blockedUserIds),
      blocking_issues: blockingIssues,
    }
  })
  if (!generation) throw new Error('settlement_generation_failed')
  return {
    ...generation,
    settlements: await listPersonnelWeeklySettlements({ weekStart: period.week_start }),
  }
}

async function loadSettlementForUpdate(client: Queryable, settlementId: string) {
  const result = await client.query(
    `SELECT settlement.*, batch.week_start::text, batch.week_end::text
       FROM personnel_weekly_settlements settlement
       JOIN personnel_settlement_batches batch ON batch.id=settlement.batch_id
      WHERE settlement.id=$1
      FOR UPDATE OF settlement`,
    [settlementId],
  )
  const row = result.rows?.[0]
  if (!row) throw new Error('settlement_not_found')
  return row
}

async function assertSettlementReadyForConfirmation(client: Queryable, current: any, settlementId: string) {
  const profile = parseJsonObject(current.profile_snapshot)
  if (!cleanText(profile.supplier_legal_name) || !cleanText(profile.abn)) throw new Error('settlement_supplier_profile_incomplete')
  if (profile.gst_status === 'unconfirmed') throw new Error('settlement_gst_unconfirmed')
  const lineCount = await client.query('SELECT COUNT(*)::int AS count FROM personnel_settlement_lines WHERE settlement_id=$1', [settlementId])
  if (Number(lineCount.rows?.[0]?.count || 0) < 1) throw new Error('settlement_lines_required')
  const unresolvedClaims = await client.query(
    `SELECT COUNT(*)::int AS count
       FROM personnel_workload_claims
      WHERE submitter_user_id=$1
        AND service_date BETWEEN $2::date AND $3::date
        AND status IN ('draft','submitted','returned')`,
    [current.user_id, current.week_start, current.week_end],
  )
  if (Number(unresolvedClaims.rows?.[0]?.count || 0) > 0) throw new Error('settlement_claims_pending')
  const approvedUnincludedClaims = await client.query(
    `SELECT COUNT(*)::int AS count
       FROM personnel_workload_claims claim
      WHERE claim.submitter_user_id=$1
        AND claim.service_date BETWEEN $2::date AND $3::date
        AND claim.status='approved'
        AND NOT EXISTS (
          SELECT 1
            FROM personnel_settlement_lines line
           WHERE line.settlement_id=$4
             AND line.source_type='workload_claim'
             AND line.source_id=claim.id
        )`,
    [current.user_id, current.week_start, current.week_end, settlementId],
  )
  if (Number(approvedUnincludedClaims.rows?.[0]?.count || 0) > 0) throw new Error('settlement_claims_pending')
  const ruleSnapshot = parseJsonObject(current.rule_snapshot)
  const submission = parseJsonObject(ruleSnapshot.partner_submission)
  if (Array.isArray(submission.blocking_issues) && submission.blocking_issues.length > 0) {
    throw new Error('settlement_calculation_blocked')
  }
}

function buildProfileSnapshot(profile: any, userId: string) {
  return {
    id: cleanText(profile?.id) || null,
    user_id: cleanText(profile?.user_id) || userId,
    person_type: cleanText(profile?.person_type) || null,
    supplier_legal_name: cleanText(profile?.supplier_legal_name) || null,
    supplier_business_name: cleanText(profile?.supplier_business_name) || null,
    abn: cleanText(profile?.abn) || null,
    gst_status: cleanText(profile?.gst_status) || 'unconfirmed',
    invoice_document_type: cleanText(profile?.invoice_document_type) || null,
    currency: cleanText(profile?.currency) || 'AUD',
    effective_from: cleanText(profile?.effective_from) || null,
    effective_to: cleanText(profile?.effective_to) || null,
  }
}

function submissionBlockingIssues(person: any) {
  return (person?.warnings || []).map((warning: any) => ({
    source_type: cleanText(warning.source_type),
    source_id: cleanText(warning.source_id),
    code: cleanText(warning.reason) || 'manual_review_required',
  }))
}

function serializeSubmissionPreviewLine(line: any, index: number) {
  const sourceType = cleanText(line?.source_type)
  const sourceId = cleanText(line?.source_id)
  const componentType = cleanText(line?.component_type)
  return {
    id: [sourceType, sourceId, componentType].filter(Boolean).join(':')
      || `preview:${index}:${cleanText(line?.service_date)}:${componentType || 'line'}`,
    component_type: componentType,
    service_date: cleanText(line?.service_date),
    source_type: sourceType || null,
    source_id: sourceId || null,
    description: cleanText(line?.description) || null,
    quantity_numerator: Number(line?.quantity_numerator || 0),
    quantity_denominator: Number(line?.quantity_denominator || 1),
    unit_rate_cents: Number(line?.unit_rate_cents || 0),
    subtotal_cents: Number(line?.subtotal_cents || 0),
    gst_cents: Number(line?.gst_cents || 0),
    total_cents: Number(line?.total_cents || 0),
    price_basis: cleanText(line?.price_basis) || null,
    evidence_count: Number(line?.evidence_count || 0),
  }
}

export function buildPersonnelSettlementSubmissionSnapshot(input: {
  weekStart: string
  weekEnd: string
  person: any
}) {
  const lines = (Array.isArray(input.person?.lines) ? input.person.lines : []).map(serializeSubmissionPreviewLine)
  const totals = input.person?.totals || {}
  const snapshot = {
    week_start: cleanText(input.weekStart),
    week_end: cleanText(input.weekEnd),
    subtotal_cents: Number(totals.subtotal_cents || 0),
    gst_cents: Number(totals.gst_cents || 0),
    total_cents: Number(totals.total_cents || 0),
    line_count: lines.length,
    lines,
    blocking_issues: submissionBlockingIssues(input.person),
  }
  return {
    ...snapshot,
    confirmation_token: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),
  }
}

export async function getPersonnelSettlementSubmissionPreview(input: {
  weekStart: string
  userId: string
}) {
  assertPersonnelSettlementSchemaReady()
  if (!pgPool) throw new Error('pg_required')
  const period = buildSettlementPeriod(input.weekStart)
  if (period.week_end >= getMelbourneDate()) throw new Error('settlement_week_not_finished')
  const preview = await buildPersonnelSettlementPreview({
    week_start: period.week_start,
    user_ids: [input.userId],
  })
  const person = (preview.people || []).find((item: any) => cleanText(item.user_id) === cleanText(input.userId))
  const existing = (await listPersonnelWeeklySettlements({
    weekStart: period.week_start,
    userId: input.userId,
  }))[0] || null
  const snapshot = buildPersonnelSettlementSubmissionSnapshot({
    weekStart: period.week_start,
    weekEnd: period.week_end,
    person,
  })
  return {
    ...snapshot,
    status: existing?.status || 'not_submitted',
    settlement: existing,
  }
}

export async function submitPersonnelSettlementWeek(input: {
  weekStart: string
  userId: string
  confirmationToken: string
}) {
  assertPersonnelSettlementSchemaReady()
  if (!pgPool) throw new Error('pg_required')
  const period = buildSettlementPeriod(input.weekStart)
  if (period.week_end >= getMelbourneDate()) throw new Error('settlement_week_not_finished')
  const settlementId = await pgRunInTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('personnel-settlement-week'), hashtext($1))", [period.week_start])
    const batchId = randomUUID()
    await client.query(
      `INSERT INTO personnel_settlement_batches (
         id, week_start, week_end, timezone, source_cutoff_at,
         calculation_version, status, generated_by, generated_at, error_summary
       ) VALUES ($1,$2::date,$3::date,$4,now(),$5,'draft',$6,now(),'{}'::jsonb)
       ON CONFLICT (week_start, week_end) DO NOTHING`,
      [batchId, period.week_start, period.week_end, period.timezone, PERSONNEL_SETTLEMENT_CALCULATION_VERSION, input.userId],
    )
    const batchResult = await client.query(
      'SELECT * FROM personnel_settlement_batches WHERE week_start=$1::date AND week_end=$2::date FOR UPDATE',
      [period.week_start, period.week_end],
    )
    const batch = batchResult.rows?.[0]
    if (!batch) throw new Error('settlement_batch_create_failed')
    const existingResult = await client.query(
      'SELECT * FROM personnel_weekly_settlements WHERE batch_id=$1 AND user_id=$2 FOR UPDATE',
      [batch.id, input.userId],
    )
    const existing = existingResult.rows?.[0]
    if (existing && ['confirmed', 'paid', 'finance_approved'].includes(String(existing.status))) return String(existing.id)
    if (existing && String(existing.status) === 'awaiting_confirmation') {
      const updated = await client.query(
        `UPDATE personnel_weekly_settlements
            SET status='confirmed', workload_amount_confirmed_at=now(),
                workload_amount_confirmation_note='已确认财务退回的工作量及金额',
                disputed_at=NULL, updated_at=now()
          WHERE id=$1 RETURNING *`,
        [existing.id],
      )
      await insertAudit(client, 'personnel_weekly_settlement', existing.id, 'partner_resubmit', input.userId, settlementAuditSummary(existing), settlementAuditSummary(updated.rows[0]))
      await refreshBatchStatus(client, batch.id, input.userId)
      return String(existing.id)
    }
    if (existing && String(existing.status) === 'disputed') throw new Error('settlement_transition_invalid')

    const preview = await buildPersonnelSettlementPreview({
      week_start: period.week_start,
      user_ids: [input.userId],
    }, client)
    const person = (preview.people || []).find((item: any) => cleanText(item.user_id) === cleanText(input.userId))
    const submissionSnapshot = buildPersonnelSettlementSubmissionSnapshot({
      weekStart: period.week_start,
      weekEnd: period.week_end,
      person,
    })
    if (submissionSnapshot.confirmation_token !== cleanText(input.confirmationToken)) {
      throw new Error('settlement_preview_changed')
    }
    const profile = person?.profile || person?.effective_profiles?.[0] || null
    const lines = Array.isArray(person?.lines) ? person.lines : []
    const blockingIssues = submissionBlockingIssues(person)
    const now = new Date().toISOString()
    const ruleSnapshot = {
      calculation_version: preview.calculation_version,
      source_cutoff_at: now,
      applied_rule_ids: Array.from(new Set(lines.map((line: any) => cleanText(line.rule_id)).filter(Boolean))),
      finance_adjustment: null,
      partner_submission: {
        submitted_at: now,
        blocking_issues: blockingIssues,
        confirmation_token: submissionSnapshot.confirmation_token,
      },
    }
    const totals = person?.totals || { subtotal_cents: 0, gst_cents: 0, total_cents: 0 }
    const id = existing?.id || randomUUID()
    if (existing) {
      await client.query('DELETE FROM personnel_settlement_lines WHERE settlement_id=$1', [id])
      await client.query(
        `UPDATE personnel_weekly_settlements
            SET profile_snapshot=$1::jsonb, rule_snapshot=$2::jsonb,
                subtotal_cents=$3, gst_cents=$4, total_cents=$5,
                status='confirmed', workload_amount_confirmed_at=now(),
                workload_amount_confirmation_note='合作方已提交本周工作量',
                disputed_at=NULL, dispute_note=NULL, updated_at=now()
          WHERE id=$6`,
        [JSON.stringify(buildProfileSnapshot(profile, input.userId)), JSON.stringify(ruleSnapshot), totals.subtotal_cents, totals.gst_cents, totals.total_cents, id],
      )
    } else {
      await client.query(
        `INSERT INTO personnel_weekly_settlements (
           id, batch_id, user_id, profile_snapshot, rule_snapshot,
           subtotal_cents, gst_cents, total_cents, currency, status,
           workload_amount_confirmed_at, workload_amount_confirmation_note
         ) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,'AUD','confirmed',now(),'合作方已提交本周工作量')`,
        [id, batch.id, input.userId, JSON.stringify(buildProfileSnapshot(profile, input.userId)), JSON.stringify(ruleSnapshot), totals.subtotal_cents, totals.gst_cents, totals.total_cents],
      )
    }
    for (const line of lines) await insertPersonnelSettlementLine(client, id, line)
    const saved = await loadSettlementForUpdate(client, id)
    await insertAudit(client, 'personnel_weekly_settlement', id, existing ? 'partner_resubmit' : 'partner_submit', input.userId, existing ? settlementAuditSummary(existing) : null, {
      ...settlementAuditSummary(saved),
      blocking_issues: blockingIssues,
    })
    await refreshBatchStatus(client, batch.id, input.userId)
    return String(id)
  })
  if (!settlementId) throw new Error('settlement_submission_failed')
  return getPersonnelWeeklySettlement({ settlementId, requestingUserId: input.userId })
}

function normalizeConfirmationRevision(value: unknown) {
  const parsed = new Date(value as any)
  if (!Number.isFinite(parsed.getTime())) throw new Error('invalid_confirmation_revision')
  return parsed.toISOString().replace(/\D/g, '')
}

async function publishPersonnelSettlementConfirmationRequest(input: {
  settlementId: string
  actorUserId: string
  userId: string
  weekStart: string
  weekEnd: string
  confirmationRevision: string
  isDisputeResolution?: boolean
}) {
  if (!(await isPersonnelSettlementPhase5SchemaReady(pgPool))) return
  await ensurePersonnelSettlementDocument({ settlementId: input.settlementId, actorUserId: input.actorUserId })
  await emitNotificationEvent({
    type: 'PERSONNEL_SETTLEMENT_CONFIRMATION_REQUESTED',
    entity: 'personnel_weekly_settlement',
    entityId: input.settlementId,
    eventId: `personnel-settlement-confirmation-requested:${input.settlementId}:${normalizeConfirmationRevision(input.confirmationRevision)}`,
    recipientUserIds: [input.userId],
    excludeActor: false,
    priority: 'high',
    title: input.isDisputeResolution ? '请再次确认上周费用结算' : '请确认上周费用结算',
    body: input.isDisputeResolution
      ? '财务已退回本周结算，请核对最新工作量、金额和退回说明。'
      : `${input.weekStart} 至 ${input.weekEnd} 的工作量与金额已生成，请核对并确认。`,
    data: {
      kind: 'personnel_settlement_confirmation_requested',
      action: 'open_personnel_settlement',
      settlement_id: input.settlementId,
      week_start: input.weekStart,
      week_end: input.weekEnd,
      confirmation_revision: input.confirmationRevision,
      confirmation_round: input.isDisputeResolution ? 'dispute_resolution' : 'initial',
    },
  })
}

export async function returnPersonnelSettlementForConfirmation(input: {
  settlementId: string
  actorUserId: string
  reason: string
}) {
  assertPersonnelSettlementSchemaReady()
  if (!pgPool) throw new Error('pg_required')
  const reason = requireReason(input.reason, 'settlement_return_reason_required')
  const returned = await pgRunInTransaction(async (client) => {
    const current = await loadSettlementForUpdate(client, input.settlementId)
    const deliveryRetry = getPersonnelSettlementReturnDeliveryRetry(current)
    if (deliveryRetry) return deliveryRetry
    assertPersonnelSettlementTransition('return_for_confirmation', current.status)
    const preview = await buildPersonnelSettlementPreview({
      week_start: cleanText(current.week_start),
      user_ids: [cleanText(current.user_id)],
    }, client)
    const person = (preview.people || []).find((item: any) => cleanText(item.user_id) === cleanText(current.user_id))
    const blockingIssues = submissionBlockingIssues(person)
    if (blockingIssues.length) throw new Error('settlement_calculation_blocked')
    const lines = Array.isArray(person?.lines) ? person.lines : []
    if (!lines.length) throw new Error('settlement_lines_required')
    const profile = person?.profile || person?.effective_profiles?.[0] || null
    const confirmationRevision = new Date().toISOString()
    const ruleSnapshot = parseJsonObject(current.rule_snapshot)
    ruleSnapshot.calculation_version = preview.calculation_version
    ruleSnapshot.source_cutoff_at = confirmationRevision
    ruleSnapshot.applied_rule_ids = Array.from(new Set(lines.map((line: any) => cleanText(line.rule_id)).filter(Boolean)))
    ruleSnapshot.partner_submission = {
      ...parseJsonObject(ruleSnapshot.partner_submission),
      blocking_issues: [],
    }
    ruleSnapshot.finance_return = {
      reason,
      returned_by: input.actorUserId,
      returned_at: confirmationRevision,
      previous_total_cents: Number(current.total_cents || 0),
      revised_total_cents: Number(person?.totals?.total_cents || 0),
    }
    ruleSnapshot.confirmation_request = {
      revision: confirmationRevision,
      round: 'finance_return',
    }
    await client.query('DELETE FROM personnel_settlement_lines WHERE settlement_id=$1', [input.settlementId])
    for (const line of lines) await insertPersonnelSettlementLine(client, input.settlementId, line)
    const totals = person?.totals || { subtotal_cents: 0, gst_cents: 0, total_cents: 0 }
    const updated = await client.query(
      `UPDATE personnel_weekly_settlements
          SET profile_snapshot=$1::jsonb, rule_snapshot=$2::jsonb,
              subtotal_cents=$3, gst_cents=$4, total_cents=$5,
              status='awaiting_confirmation', workload_amount_confirmed_at=NULL,
              workload_amount_confirmation_note=NULL, disputed_at=NULL,
              dispute_note=$6, updated_at=$7::timestamptz
        WHERE id=$8
        RETURNING *`,
      [
        JSON.stringify(buildProfileSnapshot(profile, cleanText(current.user_id))),
        JSON.stringify(ruleSnapshot),
        totals.subtotal_cents,
        totals.gst_cents,
        totals.total_cents,
        reason,
        confirmationRevision,
        input.settlementId,
      ],
    )
    await assertSettlementReadyForConfirmation(client, updated.rows[0], input.settlementId)
    await insertAudit(client, 'personnel_weekly_settlement', input.settlementId, 'return_for_confirmation', input.actorUserId, settlementAuditSummary(current), {
      ...settlementAuditSummary(updated.rows[0]),
      reason,
    })
    await refreshBatchStatus(client, current.batch_id, input.actorUserId)
    return {
      userId: cleanText(current.user_id),
      weekStart: cleanText(current.week_start),
      weekEnd: cleanText(current.week_end),
      confirmationRevision,
    }
  })
  if (returned) {
    await publishPersonnelSettlementConfirmationRequest({
      settlementId: input.settlementId,
      actorUserId: input.actorUserId,
      ...returned,
      isDisputeResolution: true,
    })
  }
  return getPersonnelWeeklySettlement({ settlementId: input.settlementId })
}

export async function issuePersonnelSettlementConfirmation(input: {
  settlementId: string
  actorUserId: string
}) {
  assertPersonnelSettlementSchemaReady()
  if (!pgPool) throw new Error('pg_required')
  const issued = await pgRunInTransaction(async (client) => {
    const current = await loadSettlementForUpdate(client, input.settlementId)
    const ruleSnapshot = parseJsonObject(current.rule_snapshot)
    const existingConfirmationRequest = parseJsonObject(ruleSnapshot.confirmation_request)
    let confirmationRevision = cleanText(existingConfirmationRequest.revision) || cleanText(current.updated_at)
    if (String(current.status) !== 'awaiting_confirmation') {
      assertPersonnelSettlementTransition('issue_confirmation', current.status)
      await assertSettlementReadyForConfirmation(client, current, input.settlementId)
      confirmationRevision = new Date().toISOString()
      ruleSnapshot.confirmation_request = {
        revision: confirmationRevision,
        round: 'initial',
      }
      const updated = await client.query(
        `UPDATE personnel_weekly_settlements
            SET status='awaiting_confirmation', rule_snapshot=$1::jsonb, updated_at=$2::timestamptz
          WHERE id=$3
          RETURNING *`,
        [JSON.stringify(ruleSnapshot), confirmationRevision, input.settlementId],
      )
      await insertAudit(client, 'personnel_weekly_settlement', input.settlementId, 'issue_confirmation', input.actorUserId, settlementAuditSummary(current), settlementAuditSummary(updated.rows[0]))
      await refreshBatchStatus(client, current.batch_id, input.actorUserId)
    }
    return {
      userId: cleanText(current.user_id),
      weekStart: cleanText(current.week_start),
      weekEnd: cleanText(current.week_end),
      confirmationRevision,
    }
  })
  if (issued) {
    await publishPersonnelSettlementConfirmationRequest({
      settlementId: input.settlementId,
      actorUserId: input.actorUserId,
      ...issued,
    })
  }
  return getPersonnelWeeklySettlement({ settlementId: input.settlementId })
}

export async function respondPersonnelSettlement(input: {
  settlementId: string
  userId: string
  action: 'confirm' | 'dispute'
  note?: string | null
}) {
  assertPersonnelSettlementSchemaReady()
  if (!pgPool) throw new Error('pg_required')
  const note = input.action === 'dispute'
    ? requireReason(input.note, 'settlement_dispute_reason_required')
    : cleanText(input.note).slice(0, 1000) || null
  await pgRunInTransaction(async (client) => {
    const current = await loadSettlementForUpdate(client, input.settlementId)
    if (String(current.user_id) !== input.userId) throw new Error('settlement_not_found')
    const targetStatus = input.action === 'confirm' ? 'confirmed' : 'disputed'
    if (String(current.status) === targetStatus) return
    assertPersonnelSettlementTransition(input.action, current.status)
    const updated = await client.query(
      `UPDATE personnel_weekly_settlements
          SET status=$1,
              workload_amount_confirmed_at=CASE WHEN $1='confirmed' THEN now() ELSE NULL END,
              workload_amount_confirmation_note=CASE WHEN $1='confirmed' THEN $2 ELSE NULL END,
              disputed_at=CASE WHEN $1='disputed' THEN now() ELSE NULL END,
              dispute_note=CASE WHEN $1='disputed' THEN $2 ELSE NULL END,
              updated_at=now()
        WHERE id=$3
        RETURNING *`,
      [targetStatus, note, input.settlementId],
    )
    await insertAudit(client, 'personnel_weekly_settlement', input.settlementId, input.action, input.userId, settlementAuditSummary(current), settlementAuditSummary(updated.rows[0]))
    await refreshBatchStatus(client, current.batch_id, input.userId)
  })
  if (input.action === 'confirm' && await isPersonnelSettlementPhase5SchemaReady(pgPool)) {
    await ensurePersonnelSettlementDocument({ settlementId: input.settlementId, actorUserId: input.userId })
  }
  return getPersonnelWeeklySettlement({ settlementId: input.settlementId, requestingUserId: input.userId })
}

export async function submitPersonnelSettlementClaimForReconciliation(input: {
  settlementId: string
  claimId: string
  userId: string
  note: string
}) {
  assertPersonnelSettlementSchemaReady()
  if (!pgPool) throw new Error('pg_required')
  const note = requireReason(input.note, 'settlement_dispute_reason_required')
  await pgRunInTransaction(async (client) => {
    const current = await loadSettlementForUpdate(client, input.settlementId)
    if (cleanText(current.user_id) !== cleanText(input.userId)) throw new Error('settlement_not_found')
    if (!['awaiting_confirmation', 'disputed'].includes(String(current.status))) {
      throw new Error('settlement_transition_invalid')
    }

    const claim = await submitPersonnelClaimInTransaction({
      userId: input.userId,
      claimId: input.claimId,
    }, client)
    const serviceDate = cleanText(claim?.service_date).slice(0, 10)
    if (serviceDate < cleanText(current.week_start) || serviceDate > cleanText(current.week_end)) {
      throw new Error('settlement_claim_period_mismatch')
    }

    if (String(current.status) === 'awaiting_confirmation') {
      const updated = await client.query(
        `UPDATE personnel_weekly_settlements
            SET status='disputed', workload_amount_confirmed_at=NULL,
                workload_amount_confirmation_note=NULL, disputed_at=now(),
                dispute_note=$1, updated_at=now()
          WHERE id=$2
          RETURNING *`,
        [note, input.settlementId],
      )
      await insertAudit(
        client,
        'personnel_weekly_settlement',
        input.settlementId,
        'submit_claim_for_reconciliation',
        input.userId,
        settlementAuditSummary(current),
        settlementAuditSummary(updated.rows[0]),
      )
      await refreshBatchStatus(client, current.batch_id, input.userId)
    }
  })
  return getPersonnelWeeklySettlement({ settlementId: input.settlementId, requestingUserId: input.userId })
}

export async function reviewPersonnelSettlementDisputeClaim(input: {
  settlementId: string
  claimId: string
  actorUserId: string
  review: PersonnelClaimReviewInput
}) {
  assertPersonnelSettlementSchemaReady()
  if (!pgPool) throw new Error('pg_required')
  await pgRunInTransaction(async (client) => {
    const current = await loadSettlementForUpdate(client, input.settlementId)
    if (String(current.status) !== 'disputed') throw new Error('settlement_transition_invalid')

    const claim = await reviewPersonnelClaimInTransaction({
      claimId: input.claimId,
      actorUserId: input.actorUserId,
      review: input.review,
    }, client, { allowDisputedSettlementId: input.settlementId })
    const claimServiceDate = cleanText(claim?.service_date)
    if (
      cleanText(claim?.submitter_user_id) !== cleanText(current.user_id)
      || claimServiceDate < cleanText(current.week_start)
      || claimServiceDate > cleanText(current.week_end)
    ) {
      throw new Error('settlement_claim_period_mismatch')
    }
    if (input.review.action !== 'approve') return

    const existingLine = await client.query(
      `SELECT id
         FROM personnel_settlement_lines
        WHERE settlement_id=$1 AND source_type='workload_claim' AND source_id=$2
        FOR UPDATE`,
      [input.settlementId, input.claimId],
    )
    let insertedLineId: string | null = null
    let appliedRuleId: string | null = null
    if (!existingLine.rowCount) {
      const preview = await buildPersonnelSettlementPreview({
        week_start: cleanText(current.week_start),
        user_ids: [cleanText(current.user_id)],
      }, client)
      const person = (preview.people || []).find((item: any) => cleanText(item.user_id) === cleanText(current.user_id))
      const line = (person?.lines || []).find((item: any) => (
        item.source_type === 'workload_claim' && cleanText(item.source_id) === input.claimId
      ))
      if (!line) throw new Error('settlement_claim_calculation_failed')
      insertedLineId = await insertPersonnelSettlementLine(client, input.settlementId, line)
      appliedRuleId = cleanText(line.rule_id) || null
    }

    const lineTotalsResult = await client.query(
      `SELECT COALESCE(SUM(subtotal_cents),0)::text AS subtotal_cents,
              COALESCE(SUM(gst_cents),0)::text AS gst_cents,
              COALESCE(SUM(total_cents),0)::text AS total_cents
         FROM personnel_settlement_lines
        WHERE settlement_id=$1`,
      [input.settlementId],
    )
    const base = moneyFields(lineTotalsResult.rows?.[0] || {})
    const ruleSnapshot = parseJsonObject(current.rule_snapshot)
    const financeAdjustment = parseJsonObject(ruleSnapshot.finance_adjustment)
    const adjustmentCents = safeInteger(
      financeAdjustment.amount_cents ?? 0,
      'settlement_adjustment_cents',
      { min: -100_000_000, max: 100_000_000 },
    )
    const subtotalCents = safeInteger(
      base.subtotal_cents + adjustmentCents,
      'subtotal_cents',
      { max: 100_000_000 },
    )
    const totalCents = safeInteger(subtotalCents + base.gst_cents, 'total_cents')
    if (appliedRuleId) {
      ruleSnapshot.applied_rule_ids = Array.from(new Set([
        ...(Array.isArray(ruleSnapshot.applied_rule_ids) ? ruleSnapshot.applied_rule_ids.map(cleanText) : []),
        appliedRuleId,
      ].filter(Boolean)))
    }
    const updated = await client.query(
      `UPDATE personnel_weekly_settlements
          SET rule_snapshot=$1::jsonb, subtotal_cents=$2, gst_cents=$3,
              total_cents=$4, updated_at=now()
        WHERE id=$5
        RETURNING *`,
      [JSON.stringify(ruleSnapshot), subtotalCents, base.gst_cents, totalCents, input.settlementId],
    )
    if (insertedLineId) {
      await insertAudit(
        client,
        'personnel_weekly_settlement',
        input.settlementId,
        'include_approved_claim',
        input.actorUserId,
        settlementAuditSummary(current),
        {
          ...settlementAuditSummary(updated.rows[0]),
          claim_id: input.claimId,
          settlement_line_id: insertedLineId,
          calculation_source: 'effective_fee_rule',
        },
      )
    }
  })
  return getPersonnelWeeklySettlement({ settlementId: input.settlementId })
}

export async function resolvePersonnelSettlementDispute(input: {
  settlementId: string
  actorUserId: string
  decision: PersonnelSettlementDisputeDecision
  finalTotalCents?: number | null
}) {
  assertPersonnelSettlementSchemaReady()
  if (!pgPool) throw new Error('pg_required')
  const resolved = await pgRunInTransaction(async (client) => {
    const current = await loadSettlementForUpdate(client, input.settlementId)
    const currentRuleSnapshot = parseJsonObject(current.rule_snapshot)
    const previousResolution = parseJsonObject(currentRuleSnapshot.dispute_resolution)
    if (String(current.status) === 'awaiting_confirmation' && cleanText(previousResolution.confirmation_revision)) {
      return {
        userId: cleanText(current.user_id),
        weekStart: cleanText(current.week_start),
        weekEnd: cleanText(current.week_end),
        confirmationRevision: cleanText(previousResolution.confirmation_revision),
      }
    }
    assertPersonnelSettlementTransition('resolve_dispute', current.status)
    await assertSettlementReadyForConfirmation(client, current, input.settlementId)

    const lineTotalsResult = await client.query(
      `SELECT COALESCE(SUM(subtotal_cents),0)::text AS subtotal_cents,
              COALESCE(SUM(gst_cents),0)::text AS gst_cents,
              COALESCE(SUM(total_cents),0)::text AS total_cents
         FROM personnel_settlement_lines
        WHERE settlement_id=$1`,
      [input.settlementId],
    )
    const base = moneyFields(lineTotalsResult.rows?.[0] || {})
    const amounts = calculatePersonnelSettlementDisputeResolution({
      decision: input.decision,
      baseSubtotalCents: base.subtotal_cents,
      baseGstCents: base.gst_cents,
      currentTotalCents: Number(current.total_cents || 0),
      finalTotalCents: input.finalTotalCents,
    })
    const confirmationRevision = new Date().toISOString()
    const ruleSnapshot = currentRuleSnapshot
    if (input.decision === 'edit_amount') {
      ruleSnapshot.finance_adjustment = {
        amount_cents: amounts.adjustment_cents,
        reason: '',
        actor_user_id: input.actorUserId,
        updated_at: confirmationRevision,
        gst_treatment: 'outside_gst',
      }
    }
    ruleSnapshot.dispute_resolution = {
      decision: input.decision,
      original_dispute_note: cleanText(current.dispute_note),
      previous_total_cents: Number(current.total_cents || 0),
      final_total_cents: amounts.total_cents,
      resolved_at: confirmationRevision,
      confirmation_revision: confirmationRevision,
    }
    ruleSnapshot.confirmation_request = {
      revision: confirmationRevision,
      round: 'dispute_resolution',
    }
    const updated = await client.query(
      `UPDATE personnel_weekly_settlements
          SET status='awaiting_confirmation', rule_snapshot=$1::jsonb,
              subtotal_cents=$2, gst_cents=$3, total_cents=$4,
              workload_amount_confirmed_at=NULL, workload_amount_confirmation_note=NULL,
              disputed_at=NULL, dispute_note=NULL, updated_at=$5::timestamptz
        WHERE id=$6
        RETURNING *`,
      [
        JSON.stringify(ruleSnapshot),
        amounts.subtotal_cents,
        amounts.gst_cents,
        amounts.total_cents,
        confirmationRevision,
        input.settlementId,
      ],
    )
    await insertAudit(client, 'personnel_weekly_settlement', input.settlementId, 'resolve_dispute', input.actorUserId, settlementAuditSummary(current), {
      ...settlementAuditSummary(updated.rows[0]),
      decision: input.decision,
      previous_total_cents: Number(current.total_cents || 0),
      final_total_cents: amounts.total_cents,
    })
    await refreshBatchStatus(client, current.batch_id, input.actorUserId)
    return {
      userId: cleanText(current.user_id),
      weekStart: cleanText(current.week_start),
      weekEnd: cleanText(current.week_end),
      confirmationRevision,
    }
  })
  if (resolved) {
    await publishPersonnelSettlementConfirmationRequest({
      settlementId: input.settlementId,
      actorUserId: input.actorUserId,
      ...resolved,
      isDisputeResolution: true,
    })
  }
  return getPersonnelWeeklySettlement({ settlementId: input.settlementId })
}

export async function adjustPersonnelSettlement(input: {
  settlementId: string
  actorUserId: string
  adjustmentCents: number
  reason: string
}) {
  assertPersonnelSettlementSchemaReady()
  if (!pgPool) throw new Error('pg_required')
  const adjustmentCents = safeInteger(input.adjustmentCents, 'settlement_adjustment_cents', { min: -100_000_000, max: 100_000_000 })
  const reason = requireReason(input.reason)
  await pgRunInTransaction(async (client) => {
    const current = await loadSettlementForUpdate(client, input.settlementId)
    assertPersonnelSettlementTransition('adjust', current.status)
    const lineTotalsResult = await client.query(
      `SELECT COALESCE(SUM(subtotal_cents),0)::text AS subtotal_cents,
              COALESCE(SUM(gst_cents),0)::text AS gst_cents,
              COALESCE(SUM(total_cents),0)::text AS total_cents
         FROM personnel_settlement_lines
        WHERE settlement_id=$1`,
      [input.settlementId],
    )
    const base = moneyFields(lineTotalsResult.rows?.[0] || {})
    const subtotalCents = base.subtotal_cents + adjustmentCents
    const totalCents = subtotalCents + base.gst_cents
    if (subtotalCents < 0 || totalCents < 0) throw new Error('settlement_adjustment_exceeds_total')
    const ruleSnapshot = parseJsonObject(current.rule_snapshot)
    ruleSnapshot.finance_adjustment = {
      amount_cents: adjustmentCents,
      reason,
      actor_user_id: input.actorUserId,
      updated_at: new Date().toISOString(),
      gst_treatment: 'outside_gst',
    }
    const updated = await client.query(
      `UPDATE personnel_weekly_settlements
          SET rule_snapshot=$1::jsonb, subtotal_cents=$2, gst_cents=$3,
              total_cents=$4, updated_at=now()
        WHERE id=$5
        RETURNING *`,
      [JSON.stringify(ruleSnapshot), subtotalCents, base.gst_cents, totalCents, input.settlementId],
    )
    await insertAudit(client, 'personnel_weekly_settlement', input.settlementId, 'adjust', input.actorUserId, settlementAuditSummary(current), {
      ...settlementAuditSummary(updated.rows[0]),
      adjustment_cents: adjustmentCents,
      reason,
    })
  })
  return getPersonnelWeeklySettlement({ settlementId: input.settlementId })
}

export async function reopenPersonnelSettlement(input: {
  settlementId: string
  actorUserId: string
  reason: string
}) {
  assertPersonnelSettlementSchemaReady()
  if (!pgPool) throw new Error('pg_required')
  const reason = requireReason(input.reason)
  await pgRunInTransaction(async (client) => {
    const current = await loadSettlementForUpdate(client, input.settlementId)
    if (String(current.status) === 'draft') return
    assertPersonnelSettlementTransition('reopen', current.status)
    const updated = await client.query(
      `UPDATE personnel_weekly_settlements
          SET status='draft', workload_amount_confirmed_at=NULL,
              workload_amount_confirmation_note=NULL, disputed_at=NULL,
              dispute_note=NULL, updated_at=now()
        WHERE id=$1
        RETURNING *`,
      [input.settlementId],
    )
    await insertAudit(client, 'personnel_weekly_settlement', input.settlementId, 'reopen', input.actorUserId, settlementAuditSummary(current), {
      ...settlementAuditSummary(updated.rows[0]), reason,
    })
    await refreshBatchStatus(client, current.batch_id, input.actorUserId)
  })
  return getPersonnelWeeklySettlement({ settlementId: input.settlementId })
}

export function validatePersonnelSettlementPayment(input: {
  payment_date: string
}, now = new Date()) {
  const paymentDate = cleanText(input.payment_date)
  if (!DATE_ONLY.test(paymentDate)) throw new Error('invalid_payment_date')
  try { getSettlementWeekStart(paymentDate) } catch { throw new Error('invalid_payment_date') }
  if (paymentDate > getMelbourneDate(now)) throw new Error('invalid_payment_date')
  return { payment_date: paymentDate }
}

export async function confirmPersonnelSettlementPaid(input: {
  settlementId: string
  actorUserId: string
  payment: {
    payment_date: string
  }
  expectedPaymentAmountCents?: number | null
}) {
  assertPersonnelSettlementSchemaReady()
  if (!pgPool) throw new Error('pg_required')
  const payment = validatePersonnelSettlementPayment(input.payment)
  await pgRunInTransaction(async (client) => {
    const current = await loadSettlementForUpdate(client, input.settlementId)
    const totalCents = safeInteger(current.total_cents, 'total_cents')
    if (String(current.status) === 'paid') {
      const snapshot = parseJsonObject(current.payment_destination_snapshot)
      if (
        Number(snapshot.payment_amount_cents) === totalCents
        && String(snapshot.payment_date || '') === payment.payment_date
      ) return
      throw new Error('settlement_already_paid')
    }
    assertPersonnelSettlementTransition('confirm_paid', current.status)
    await assertSettlementReadyForConfirmation(client, current, input.settlementId)
    if (input.expectedPaymentAmountCents != null && input.expectedPaymentAmountCents !== totalCents) {
      throw new Error('payment_amount_mismatch')
    }
    const bankResult = await client.query(
      `SELECT bank_account_name, bank_bsb, bank_account_number
         FROM users WHERE id::text=$1 FOR UPDATE`,
      [current.user_id],
    )
    const existingPaymentDestination = parseJsonObject(current.payment_destination_snapshot)
    const frozenBankComplete = cleanText(existingPaymentDestination.bank_account_name)
      && cleanText(existingPaymentDestination.bank_bsb)
      && cleanText(existingPaymentDestination.bank_account_number)
    const bank = frozenBankComplete ? existingPaymentDestination : bankResult.rows?.[0]
    if (!cleanText(bank?.bank_account_name) || !cleanText(bank?.bank_bsb) || !cleanText(bank?.bank_account_number)) {
      throw new Error('settlement_bank_details_incomplete')
    }
    const expenseId = cleanText(current.company_expense_id) || randomUUID()
    const profile = parseJsonObject(current.profile_snapshot)
    const supplierName = cleanText(profile.supplier_business_name) || cleanText(profile.supplier_legal_name) || String(current.user_id)
    const amount = (totalCents / 100).toFixed(2)
    const expenseResult = await client.query(
      `INSERT INTO company_expenses (
         id, occurred_at, amount, currency, category, category_detail,
         expense_name, note, created_by, due_date, paid_date, status, generated_from,
         ref_type, ref_id, is_auto, manual_override, source_title, source_summary
       ) VALUES ($1,$2::date,$3::numeric,'AUD','cleaning_expense','personnel_settlement',
         $4,$5,$6,$7::date,$7::date,'paid','personnel_settlement',$8,$9,true,false,$4,$10)
       ON CONFLICT (ref_type, ref_id) WHERE ref_type IS NOT NULL AND ref_id IS NOT NULL
       DO UPDATE SET occurred_at=EXCLUDED.occurred_at, amount=EXCLUDED.amount,
         currency=EXCLUDED.currency, category=EXCLUDED.category,
         category_detail=EXCLUDED.category_detail, expense_name=EXCLUDED.expense_name,
         note=EXCLUDED.note, due_date=EXCLUDED.due_date, paid_date=EXCLUDED.paid_date,
         status='paid', generated_from=EXCLUDED.generated_from, is_auto=true,
         source_title=EXCLUDED.source_title, source_summary=EXCLUDED.source_summary
       WHERE COALESCE(company_expenses.manual_override,false)=false
       RETURNING id`,
      [
        expenseId, current.week_end, amount, `${supplierName} 周费用结算`,
        `合作方周结算 ${current.week_start} 至 ${current.week_end}`,
        input.actorUserId, payment.payment_date, 'personnel_weekly_settlement', current.id,
        `服务周期 ${current.week_start} 至 ${current.week_end}`,
      ],
    )
    if (!expenseResult.rowCount) throw new Error('company_expense_manual_override')
    const snapshot = {
      bank_account_name: cleanText(bank.bank_account_name),
      bank_bsb: cleanText(bank.bank_bsb),
      bank_account_number: cleanText(bank.bank_account_number),
      captured_at: new Date().toISOString(),
      payment_amount_cents: totalCents,
      payment_date: payment.payment_date,
    }
    const updated = await client.query(
      `UPDATE personnel_weekly_settlements
          SET status='paid', finance_reviewed_by=$1, finance_reviewed_at=now(),
              paid_by=$1, paid_at=($2::date::timestamp AT TIME ZONE 'Australia/Melbourne'),
              payment_destination_snapshot=$3::jsonb,
              company_expense_id=$4, updated_at=now()
        WHERE id=$5
        RETURNING *`,
      [
        input.actorUserId, payment.payment_date,
        JSON.stringify(snapshot), expenseResult.rows[0].id, input.settlementId,
      ],
    )
    await insertAudit(client, 'personnel_weekly_settlement', input.settlementId, 'confirm_paid', input.actorUserId, settlementAuditSummary(current), {
      ...settlementAuditSummary(updated.rows[0]),
      payment_destination_complete: true,
    })
    await refreshBatchStatus(client, current.batch_id, input.actorUserId)
  })
  let documentWarning: string | null = null
  if (await isPersonnelSettlementPhase5SchemaReady(pgPool)) {
    try {
      await ensurePersonnelSettlementDocument({ settlementId: input.settlementId, actorUserId: input.actorUserId })
    } catch {
      documentWarning = 'settlement_document_generation_failed'
    }
  }
  const settlement = await getPersonnelWeeklySettlement({ settlementId: input.settlementId })
  return documentWarning ? { ...settlement, document_warning: documentWarning } : settlement
}

export async function voidPersonnelSettlement(input: {
  settlementId: string
  actorUserId: string
  reason: string
}) {
  assertPersonnelSettlementSchemaReady()
  if (!pgPool) throw new Error('pg_required')
  const reason = requireReason(input.reason)
  await pgRunInTransaction(async (client) => {
    const current = await loadSettlementForUpdate(client, input.settlementId)
    if (String(current.status) === 'void') return
    assertPersonnelSettlementTransition('void', current.status)
    if (cleanText(current.company_expense_id)) {
      const expenseResult = await client.query(
        `UPDATE company_expenses
            SET status='void'
          WHERE id=$1 AND ref_type='personnel_weekly_settlement' AND ref_id=$2
            AND COALESCE(status,'') <> 'paid'
          RETURNING id`,
        [current.company_expense_id, input.settlementId],
      )
      if (!expenseResult.rowCount) throw new Error('company_expense_paid_lock')
    }
    const updated = await client.query(
      `UPDATE personnel_weekly_settlements
          SET status='void', updated_at=now()
        WHERE id=$1
        RETURNING *`,
      [input.settlementId],
    )
    await insertAudit(client, 'personnel_weekly_settlement', input.settlementId, 'void', input.actorUserId, settlementAuditSummary(current), {
      ...settlementAuditSummary(updated.rows[0]), reason,
    })
    await refreshBatchStatus(client, current.batch_id, input.actorUserId)
  })
  return getPersonnelWeeklySettlement({ settlementId: input.settlementId })
}
