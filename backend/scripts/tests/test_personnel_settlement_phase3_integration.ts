import assert from 'assert'
import { randomUUID } from 'crypto'
import { pgPool } from '../../src/dbAdapter'
import { warmupPersonnelSettlementSchema } from '../../src/lib/personnelSettlementSchema'
import { CLEANING_PROPERTY_TYPES } from '../../src/lib/personnelSettlement'
import { resetChromiumBrowser } from '../../src/lib/playwright'
import {
  createPersonnelClaim,
  listPersonnelClaimOptions,
  reviewPersonnelClaim,
  submitPersonnelClaim,
  updatePersonnelClaim,
} from '../../src/lib/personnelWorkloadClaims'
import {
  adjustPersonnelSettlement,
  confirmPersonnelSettlementPaid,
  generatePersonnelSettlementWeek,
  getPersonnelWeeklySettlement,
  issuePersonnelSettlementConfirmation,
  listPersonnelWeeklySettlements,
  reviewPersonnelSettlementDisputeClaim,
  resolvePersonnelSettlementDispute,
  respondPersonnelSettlement,
  voidPersonnelSettlement,
} from '../../src/lib/personnelSettlementWorkflow'

const PREFIX = 'dev-preview-phase3-'
const WEEK_START = '2010-01-04'
const WEEK_END = '2010-01-10'
const ACTOR_ID = 'admin'

const users = {
  cleaner: `${PREFIX}cleaner`,
  inspector: `${PREFIX}inspector`,
  warehouse: `${PREFIX}warehouse`,
  mixed: `${PREFIX}mixed`,
}

function requirePreviewWriteGuard() {
  assert.strictEqual(process.env.MZ_DEV_PREVIEW, '1', 'MZ_DEV_PREVIEW must be 1')
  assert.strictEqual(process.env.APP_ENV, 'dev', 'APP_ENV must be dev')
  assert.strictEqual(process.env.DATABASE_ROLE, 'dev', 'DATABASE_ROLE must be dev')
  assert.strictEqual(process.env.MZ_PHASE3_INTEGRATION_WRITE, '1', 'MZ_PHASE3_INTEGRATION_WRITE must be 1')
}

async function expectReject(run: () => Promise<unknown>, pattern: RegExp) {
  let thrown: unknown = null
  try { await run() } catch (error) { thrown = error }
  assert.ok(thrown instanceof Error, `expected rejection matching ${pattern}`)
  assert.match((thrown as Error).message, pattern)
}

async function cleanup() {
  if (!pgPool) return
  await pgPool.query('BEGIN')
  try {
    const batch = await pgPool.query(
      'SELECT id FROM personnel_settlement_batches WHERE week_start=$1::date AND week_end=$2::date',
      [WEEK_START, WEEK_END],
    )
    const batchIds = (batch.rows || []).map((row) => String(row.id))
    const settlements = batchIds.length
      ? await pgPool.query('SELECT id FROM personnel_weekly_settlements WHERE batch_id=ANY($1::text[])', [batchIds])
      : { rows: [] }
    const settlementIds = (settlements.rows || []).map((row: any) => String(row.id))
    await pgPool.query('DELETE FROM event_queue WHERE user_id LIKE $1', [`${PREFIX}%`])
    await pgPool.query('DELETE FROM user_notifications WHERE user_id LIKE $1', [`${PREFIX}%`])
    if (settlementIds.length) {
      const phase5Documents = await pgPool.query("SELECT to_regclass('public.personnel_settlement_documents')::text AS table_name")
      if (phase5Documents.rows?.[0]?.table_name) {
        await pgPool.query('DELETE FROM personnel_settlement_documents WHERE settlement_id=ANY($1::text[])', [settlementIds])
      }
      await pgPool.query('DELETE FROM audit_logs WHERE entity_id=ANY($1::text[])', [settlementIds])
      await pgPool.query("DELETE FROM company_expenses WHERE ref_type='personnel_weekly_settlement' AND ref_id=ANY($1::text[])", [settlementIds])
      await pgPool.query('DELETE FROM personnel_settlement_lines WHERE settlement_id=ANY($1::text[])', [settlementIds])
      await pgPool.query('DELETE FROM personnel_weekly_settlements WHERE id=ANY($1::text[])', [settlementIds])
    }
    if (batchIds.length) {
      await pgPool.query('DELETE FROM audit_logs WHERE entity_id=ANY($1::text[])', [batchIds])
      await pgPool.query('DELETE FROM personnel_settlement_batches WHERE id=ANY($1::text[])', [batchIds])
    }
    const claims = await pgPool.query("SELECT id FROM personnel_workload_claims WHERE submitter_user_id LIKE $1", [`${PREFIX}%`])
    const claimIds = (claims.rows || []).map((row) => String(row.id))
    if (claimIds.length) {
      await pgPool.query('DELETE FROM audit_logs WHERE entity_id=ANY($1::text[])', [claimIds])
      await pgPool.query('DELETE FROM personnel_workload_claim_evidence WHERE claim_id=ANY($1::text[])', [claimIds])
      await pgPool.query('DELETE FROM personnel_workload_claims WHERE id=ANY($1::text[])', [claimIds])
    }
    const rules = await pgPool.query('SELECT id FROM personnel_fee_rules WHERE user_id LIKE $1', [`${PREFIX}%`])
    const ruleIds = (rules.rows || []).map((row) => String(row.id))
    if (ruleIds.length) await pgPool.query('DELETE FROM personnel_fee_rule_items WHERE rule_id=ANY($1::text[])', [ruleIds])
    await pgPool.query('DELETE FROM personnel_fee_rules WHERE user_id LIKE $1', [`${PREFIX}%`])
    await pgPool.query('DELETE FROM personnel_settlement_profile_audits WHERE user_id LIKE $1', [`${PREFIX}%`])
    await pgPool.query('DELETE FROM personnel_settlement_profiles WHERE user_id LIKE $1', [`${PREFIX}%`])
    await pgPool.query("DELETE FROM work_task_action_audits WHERE id LIKE $1 OR source_id LIKE $1", [`${PREFIX}%`])
    await pgPool.query('DELETE FROM cleaning_tasks WHERE id LIKE $1', [`${PREFIX}%`])
    await pgPool.query('DELETE FROM properties WHERE id LIKE $1', [`${PREFIX}%`])
    await pgPool.query('DELETE FROM user_roles WHERE user_id LIKE $1', [`${PREFIX}%`])
    await pgPool.query('DELETE FROM users WHERE id LIKE $1', [`${PREFIX}%`])
    await pgPool.query('COMMIT')
  } catch (error) {
    await pgPool.query('ROLLBACK')
    throw error
  }
}

async function seedBaseData() {
  if (!pgPool) throw new Error('pg_required')
  const existingBatch = await pgPool.query(
    'SELECT id FROM personnel_settlement_batches WHERE week_start=$1::date AND week_end=$2::date',
    [WEEK_START, WEEK_END],
  )
  assert.strictEqual(existingBatch.rowCount, 0, 'reserved synthetic test week must be unused')
  await pgPool.query('BEGIN')
  try {
    for (const [kind, userId] of Object.entries(users)) {
      await pgPool.query(
        `INSERT INTO users (
           id, username, password_hash, role, display_name, legal_name,
           bank_account_name, bank_bsb, bank_account_number, personal_abn
         ) VALUES ($1,$2,$3,'cleaner',$4,$4,$4,'123456',$5,'53004085616')`,
        [userId, userId, 'synthetic-not-login-capable', `Phase 3 ${kind}`, `9900${Object.keys(users).indexOf(kind) + 1}234`],
      )
      await pgPool.query(
        `INSERT INTO personnel_settlement_profiles (
           id, user_id, effective_from, settlement_enabled, person_type,
           supplier_legal_name, abn, gst_status, gst_effective_from,
           invoice_document_type, currency, created_by, updated_by
         ) VALUES ($1,$2,'2010-01-01',true,$3,$4,'53004085616',$5,'2010-01-01','supplier_invoice','AUD',$6,$6)`,
        [`${PREFIX}profile-${kind}`, userId, kind, `Phase 3 ${kind}`, kind === 'cleaner' || kind === 'mixed' ? 'registered' : 'not_registered', ACTOR_ID],
      )
      await pgPool.query(
        `INSERT INTO personnel_fee_rules (
           id, user_id, name, status, effective_from, price_basis, currency, created_by, updated_by
         ) VALUES ($1,$2,$3,'active','2010-01-01','exclusive_gst','AUD',$4,$4)`,
        [`${PREFIX}rule-${kind}`, userId, `Phase 3 ${kind} rule`, ACTOR_ID],
      )
    }
    const items = [
      ['cleaner', 'cleaning_task', 10000],
      ['inspector', 'inspection_day', 25000],
      ['warehouse', 'warehouse_hour', 3000],
      ['mixed', 'cleaning_task', 8000],
      ['mixed', 'overtime_hour', 5000],
    ] as const
    for (const [kind, component, rate] of items) {
      if (component === 'cleaning_task') {
        for (const [index, propertyType] of CLEANING_PROPERTY_TYPES.entries()) {
          await pgPool.query(
            `INSERT INTO personnel_fee_rule_items (id, rule_id, component_type, conditions, priority, rate_cents)
             VALUES ($1,$2,$3,$4::jsonb,$5,$6)`,
            [`${PREFIX}item-${kind}-${component}-${index}`, `${PREFIX}rule-${kind}`, component, JSON.stringify({ property_type: propertyType }), CLEANING_PROPERTY_TYPES.length - index, rate],
          )
        }
        continue
      }
      await pgPool.query(
        `INSERT INTO personnel_fee_rule_items (id, rule_id, component_type, priority, rate_cents)
         VALUES ($1,$2,$3,0,$4)`,
        [`${PREFIX}item-${kind}-${component}`, `${PREFIX}rule-${kind}`, component, rate],
      )
    }
    await pgPool.query(
      "INSERT INTO properties (id, address, code, type) VALUES ($1,'Synthetic Preview Property','PHASE3','一房一卫')",
      [`${PREFIX}property`],
    )
    const tasks = [
      ['cleaner-1', users.cleaner, '2010-01-05', 'cleaned', 'complete_cleaning'],
      ['cleaner-2', users.cleaner, '2010-01-06', 'cleaned', 'fill_supplies'],
      ['inspector-1', users.inspector, '2010-01-07', 'inspected', 'submit_inspection'],
      ['inspector-2', users.inspector, '2010-01-07', 'inspected', 'submit_inspection'],
      ['mixed-1', users.mixed, '2010-01-08', 'cleaned', 'complete_cleaning'],
    ] as const
    for (const [suffix, userId, date, status, action] of tasks) {
      const taskId = `${PREFIX}task-${suffix}`
      await pgPool.query(
        `INSERT INTO cleaning_tasks (
           id, property_id, date, task_date, status, type, task_type, source,
           cleaner_id, inspector_id, assignee_id
         ) VALUES ($1,$2,$3::date,$3::date,$4,'checkout_cleaning','checkout_cleaning','manual',$5,$6,$7)`,
        [taskId, `${PREFIX}property`, date, status, action === 'submit_inspection' ? null : userId, action === 'submit_inspection' ? userId : null, userId],
      )
      await pgPool.query(
        `INSERT INTO work_task_action_audits (
           id, source_type, source_id, performed_by_user_id, performed_by_name,
           performed_as_action, performed_at, actor_user_id, status_before, status_after, metadata
         ) VALUES ($1,'cleaning_tasks',$2,$3,$4,$5,($6::date + time '12:00') AT TIME ZONE 'Australia/Melbourne',$3,'in_progress',$7,'{}'::jsonb)`,
        [`${PREFIX}audit-${suffix}`, taskId, userId, userId, action, date, status],
      )
    }
    await pgPool.query('COMMIT')
  } catch (error) {
    await pgPool.query('ROLLBACK')
    throw error
  }
}

async function addSyntheticEvidence(claimId: string, userId: string) {
  if (!pgPool) throw new Error('pg_required')
  const id = `${PREFIX}evidence-${randomUUID()}`
  await pgPool.query(
    `INSERT INTO personnel_workload_claim_evidence (
       id, claim_id, media_id, storage_key, mime_type, byte_size, original_file_name, uploaded_by
     ) VALUES ($1,$2,$3,$4,'image/jpeg',1234,'synthetic-proof.jpg',$5)`,
    [id, claimId, `${id}-media`, `dev-preview/${id}.jpg`, userId],
  )
}

async function main() {
  requirePreviewWriteGuard()
  if (!pgPool) throw new Error('pg_required')
  await warmupPersonnelSettlementSchema()
  await cleanup()
  try {
    await seedBaseData()

    const mixedClaimOptions = await listPersonnelClaimOptions({
      userId: users.mixed,
      serviceDate: '2010-01-08',
    })
    assert.deepStrictEqual(mixedClaimOptions.options.map((option) => option.business_type), [
      'warehouse', 'overtime', 'subsidy', 'new_property', 'external', 'custom',
    ])
    assert.strictEqual(mixedClaimOptions.options.find((option) => option.business_type === 'overtime')?.rule_configured, true)
    assert.strictEqual(mixedClaimOptions.options.find((option) => option.business_type === 'new_property')?.rule_configured, false)

    const newPropertyDraft: any = await createPersonnelClaim({
      userId: users.cleaner,
      claim: {
        service_date: '2010-01-08', claim_type: 'new_property_task',
        property_id: `${PREFIX}property`,
        started_at: '2010-01-08T00:00:00Z', ended_at: '2010-01-08T02:00:00Z',
        note: 'New property setup without required photo',
      },
    })
    const newPropertySubmitted: any = await submitPersonnelClaim({
      userId: users.cleaner,
      claimId: newPropertyDraft.id,
    })
    assert.strictEqual(newPropertySubmitted.status, 'submitted')
    await reviewPersonnelClaim({
      claimId: newPropertyDraft.id,
      actorUserId: ACTOR_ID,
      review: { action: 'reject', review_note: 'Synthetic no-photo submission verified' },
    })

    const warehouseDraft: any = await createPersonnelClaim({
      userId: users.warehouse,
      claim: {
        service_date: '2010-01-06', claim_type: 'warehouse_hour',
        started_at: '2010-01-06T00:00:00Z', ended_at: '2010-01-06T02:00:00Z',
        note: 'Two-hour warehouse shift',
      },
    })
    await addSyntheticEvidence(warehouseDraft.id, users.warehouse)
    await submitPersonnelClaim({ userId: users.warehouse, claimId: warehouseDraft.id })
    const returned: any = await reviewPersonnelClaim({
      claimId: warehouseDraft.id,
      actorUserId: ACTOR_ID,
      review: { action: 'return', review_note: 'Please clarify shift time' },
    })
    assert.strictEqual(returned.status, 'returned')
    await updatePersonnelClaim({
      userId: users.warehouse,
      claimId: warehouseDraft.id,
      claim: {
        service_date: '2010-01-06', claim_type: 'warehouse_hour',
        duration_minutes: 120, note: 'Confirmed two-hour warehouse shift',
      },
    })
    await submitPersonnelClaim({ userId: users.warehouse, claimId: warehouseDraft.id })
    const warehouseApproved: any = await reviewPersonnelClaim({
      claimId: warehouseDraft.id,
      actorUserId: ACTOR_ID,
      review: { action: 'approve', approved_duration_minutes: 120, review_note: 'Approved' },
    })
    assert.strictEqual(warehouseApproved.status, 'approved')

    const mixedDraft: any = await createPersonnelClaim({
      userId: users.mixed,
      claim: {
        service_date: '2010-01-08', claim_type: 'overtime_hour',
        duration_minutes: 60, note: 'One hour overtime',
      },
    })
    await addSyntheticEvidence(mixedDraft.id, users.mixed)
    await submitPersonnelClaim({ userId: users.mixed, claimId: mixedDraft.id })
    await reviewPersonnelClaim({
      claimId: mixedDraft.id,
      actorUserId: ACTOR_ID,
      review: { action: 'approve', approved_duration_minutes: 60 },
    })

    const rejectedDraft: any = await createPersonnelClaim({
      userId: users.cleaner,
      claim: {
        service_date: '2010-01-08', claim_type: 'subsidy_amount',
        requested_amount_cents: 999, note: 'Rejected synthetic subsidy',
      },
    })
    await addSyntheticEvidence(rejectedDraft.id, users.cleaner)
    await submitPersonnelClaim({ userId: users.cleaner, claimId: rejectedDraft.id })
    const rejected: any = await reviewPersonnelClaim({
      claimId: rejectedDraft.id,
      actorUserId: ACTOR_ID,
      review: { action: 'reject', review_note: 'Not supported by evidence' },
    })
    assert.strictEqual(rejected.status, 'rejected')

    const generated = await generatePersonnelSettlementWeek({
      weekStart: WEEK_START,
      actorUserId: ACTOR_ID,
      userIds: Object.values(users),
    })
    assert.strictEqual(generated.generated_count, 4)
    assert.deepStrictEqual(generated.blocked_user_ids, [])
    const byUser = new Map((generated.settlements as any[]).map((row) => [row.user_id, row]))
    assert.strictEqual(byUser.get(users.cleaner)?.total_cents, 22000)
    assert.strictEqual(byUser.get(users.inspector)?.total_cents, 25000)
    assert.strictEqual(byUser.get(users.warehouse)?.total_cents, 6000)
    assert.strictEqual(byUser.get(users.mixed)?.total_cents, 14300)

    for (const settlement of byUser.values()) {
      await issuePersonnelSettlementConfirmation({ settlementId: settlement.id, actorUserId: ACTOR_ID })
    }
    const inspector = byUser.get(users.inspector)!
    const disputedSupplement: any = await createPersonnelClaim({
      userId: users.inspector,
      claim: {
        service_date: '2010-01-09', claim_type: 'subsidy_amount',
        requested_amount_cents: 1000, note: 'Synthetic disputed-week allowance',
      },
    })
    await addSyntheticEvidence(disputedSupplement.id, users.inspector)
    await submitPersonnelClaim({ userId: users.inspector, claimId: disputedSupplement.id })
    await respondPersonnelSettlement({
      settlementId: inspector.id, userId: users.inspector, action: 'dispute', note: 'Missing approved allowance',
    })
    const disputedDetail: any = await getPersonnelWeeklySettlement({ settlementId: inspector.id })
    const visibleSupplement = disputedDetail.related_claims.find((claim: any) => claim.id === disputedSupplement.id)
    assert.ok(visibleSupplement, 'disputed settlement detail must include the submitted claim')
    assert.strictEqual(visibleSupplement.requested_amount_cents, 1000)
    assert.strictEqual(visibleSupplement.note, 'Synthetic disputed-week allowance')
    assert.strictEqual(visibleSupplement.included_in_settlement, false)
    assert.strictEqual(visibleSupplement.evidence.length, 1)
    assert.strictEqual(visibleSupplement.evidence[0].storage_key, undefined)
    await expectReject(() => reviewPersonnelClaim({
      claimId: disputedSupplement.id,
      actorUserId: ACTOR_ID,
      review: { action: 'approve', approved_amount_cents: 1000 },
    }), /claim_period_locked/)
    const reviewedSupplement: any = await reviewPersonnelSettlementDisputeClaim({
      settlementId: inspector.id, claimId: disputedSupplement.id,
      actorUserId: ACTOR_ID,
      review: { action: 'approve', approved_amount_cents: 1000 },
    })
    assert.strictEqual(reviewedSupplement.status, 'disputed')
    assert.strictEqual(reviewedSupplement.total_cents, 26000, 'approved supplementary claim must be added automatically')
    assert.strictEqual(reviewedSupplement.base_totals.total_cents, 26000)
    assert.strictEqual(reviewedSupplement.finance_adjustment_cents, 0)
    assert.strictEqual(reviewedSupplement.related_claims.find((claim: any) => claim.id === disputedSupplement.id)?.status, 'approved')
    assert.strictEqual(reviewedSupplement.related_claims.find((claim: any) => claim.id === disputedSupplement.id)?.included_in_settlement, true)
    assert.strictEqual(reviewedSupplement.lines.filter((line: any) => line.source_type === 'workload_claim' && line.source_id === disputedSupplement.id).length, 1)
    const repeatedSupplement: any = await reviewPersonnelSettlementDisputeClaim({
      settlementId: inspector.id, claimId: disputedSupplement.id,
      actorUserId: ACTOR_ID,
      review: { action: 'approve', approved_amount_cents: 1000 },
    })
    assert.strictEqual(repeatedSupplement.total_cents, 26000, 'repeated approval must not add the same claim twice')
    assert.strictEqual(repeatedSupplement.lines.filter((line: any) => line.source_type === 'workload_claim' && line.source_id === disputedSupplement.id).length, 1)
    const adjusted: any = await resolvePersonnelSettlementDispute({
      settlementId: inspector.id, actorUserId: ACTOR_ID, decision: 'keep_amount',
    })
    assert.strictEqual(adjusted.status, 'awaiting_confirmation')
    assert.strictEqual(adjusted.total_cents, 26000)
    assert.strictEqual(adjusted.dispute_resolution.decision, 'keep_amount')
    assert.strictEqual(adjusted.dispute_resolution.previous_total_cents, 26000)
    assert.strictEqual(adjusted.dispute_resolution.final_total_cents, 26000)
    assert.strictEqual(adjusted.related_claims.find((claim: any) => claim.id === disputedSupplement.id)?.status, 'approved')
    assert.strictEqual(adjusted.related_claims.find((claim: any) => claim.id === disputedSupplement.id)?.included_in_settlement, true)
    await respondPersonnelSettlement({ settlementId: inspector.id, userId: users.inspector, action: 'confirm', note: 'Corrected' })

    const cleaner = byUser.get(users.cleaner)!
    const gstSupplement: any = await createPersonnelClaim({
      userId: users.cleaner,
      claim: {
        service_date: '2010-01-09', claim_type: 'subsidy_amount',
        requested_amount_cents: 3500, note: 'Synthetic GST allowance',
      },
    })
    await addSyntheticEvidence(gstSupplement.id, users.cleaner)
    await submitPersonnelClaim({ userId: users.cleaner, claimId: gstSupplement.id })
    await respondPersonnelSettlement({
      settlementId: cleaner.id, userId: users.cleaner, action: 'dispute', note: 'Missing GST allowance',
    })
    const gstIncluded: any = await reviewPersonnelSettlementDisputeClaim({
      settlementId: cleaner.id, claimId: gstSupplement.id,
      actorUserId: ACTOR_ID,
      review: { action: 'approve', approved_amount_cents: 3500 },
    })
    assert.strictEqual(gstIncluded.subtotal_cents, 23500)
    assert.strictEqual(gstIncluded.gst_cents, 2350)
    assert.strictEqual(gstIncluded.total_cents, 25850, 'exclusive GST claim must add its GST through the fee rule')
    assert.strictEqual(gstIncluded.finance_adjustment_cents, 0)
    await resolvePersonnelSettlementDispute({
      settlementId: cleaner.id, actorUserId: ACTOR_ID, decision: 'keep_amount',
    })

    for (const [userId, settlement] of byUser.entries()) {
      if (userId !== users.inspector) {
        await respondPersonnelSettlement({ settlementId: settlement.id, userId, action: 'confirm', note: 'Workload and amount correct' })
      }
    }

    const beforePayment: any = await getPersonnelWeeklySettlement({ settlementId: byUser.get(users.cleaner)!.id, includeBankDetails: true })
    assert.strictEqual(beforePayment.payment_destination_preview.bank_account_number, '99001234')

    const legacySettlement = byUser.get(users.warehouse)!
    await pgPool.query(
      `UPDATE personnel_weekly_settlements
          SET status='finance_approved',
              payment_destination_snapshot=$1::jsonb,
              payment_reference='HISTORICAL-REF'
        WHERE id=$2`,
      [JSON.stringify({
        bank_account_name: 'Phase 3 warehouse',
        bank_bsb: '123456',
        bank_account_number: '99003234',
        captured_at: '2026-09-10T00:00:00.000Z',
      }), legacySettlement.id],
    )
    await pgPool.query(
      `UPDATE users SET bank_account_number='99112233' WHERE id=$1`,
      [users.warehouse],
    )
    const legacyBeforePayment: any = await getPersonnelWeeklySettlement({ settlementId: legacySettlement.id, includeBankDetails: true })
    assert.strictEqual(legacyBeforePayment.payment_destination_preview.bank_account_number, '99003234')

    for (const settlement of byUser.values()) {
      await confirmPersonnelSettlementPaid({
        settlementId: settlement.id,
        actorUserId: ACTOR_ID,
        payment: {
          payment_date: '2026-09-11',
        },
      })
    }
    const expenseCount = await pgPool.query(
      "SELECT COUNT(*)::int AS count FROM company_expenses WHERE ref_type='personnel_weekly_settlement' AND ref_id=ANY($1::text[]) AND category='cleaning_expense' AND status='paid'",
      [Array.from(byUser.values()).map((row) => row.id)],
    )
    assert.strictEqual(expenseCount.rows[0].count, 4, 'confirm paid must write one paid cleaning expense per settlement')
    const paymentReferences = await pgPool.query(
      'SELECT id::text, payment_reference FROM personnel_weekly_settlements WHERE id=ANY($1::text[])',
      [Array.from(byUser.values()).map((row) => row.id)],
    )
    assert.strictEqual(
      paymentReferences.rows.find((row) => String(row.id) === legacySettlement.id)?.payment_reference,
      'HISTORICAL-REF',
      'historical transfer references must remain unchanged',
    )
    assert.ok(
      paymentReferences.rows
        .filter((row) => String(row.id) !== legacySettlement.id)
        .every((row) => row.payment_reference == null),
      'new payment confirmations must not store transfer references',
    )

    const masked: any = await getPersonnelWeeklySettlement({ settlementId: byUser.get(users.cleaner)!.id })
    assert.strictEqual(masked.payment_destination_snapshot.bank_account_number, undefined)
    assert.match(masked.payment_destination_snapshot.bank_account_masked, /234$/)
    const full: any = await getPersonnelWeeklySettlement({ settlementId: byUser.get(users.cleaner)!.id, includeBankDetails: true })
    assert.strictEqual(full.payment_destination_snapshot.bank_account_number, '99001234')
    const legacyFull: any = await getPersonnelWeeklySettlement({ settlementId: legacySettlement.id, includeBankDetails: true })
    assert.strictEqual(legacyFull.payment_destination_snapshot.bank_account_number, '99003234', 'legacy finance-approved bank snapshot must remain frozen')

    const lateClaim: any = await createPersonnelClaim({
      userId: users.cleaner,
      claim: {
        service_date: '2010-01-09', claim_type: 'overtime_hour', duration_minutes: 30, note: 'Late claim',
      },
    })
    await addSyntheticEvidence(lateClaim.id, users.cleaner)
    await submitPersonnelClaim({ userId: users.cleaner, claimId: lateClaim.id })
    await expectReject(() => reviewPersonnelClaim({
      claimId: lateClaim.id,
      actorUserId: ACTOR_ID,
      review: { action: 'approve', approved_duration_minutes: 30 },
    }), /claim_period_locked/)

    await expectReject(() => voidPersonnelSettlement({
      settlementId: inspector.id, actorUserId: ACTOR_ID, reason: 'Must fail because expense is paid',
    }), /settlement_transition_invalid/)
    const cleanerId = byUser.get(users.cleaner)!.id
    await confirmPersonnelSettlementPaid({
      settlementId: cleanerId,
      actorUserId: ACTOR_ID,
      payment: {
        payment_date: '2026-09-11',
      },
    })
    await expectReject(() => adjustPersonnelSettlement({
      settlementId: cleanerId, actorUserId: ACTOR_ID, adjustmentCents: 1, reason: 'Must remain immutable',
    }), /settlement_transition_invalid/)
    const finalRows: any[] = await listPersonnelWeeklySettlements({ weekStart: WEEK_START })
    assert.strictEqual(finalRows.length, 4)
    assert.ok(finalRows.every((row) => row.status === 'paid'))
    assert.strictEqual(finalRows.find((row) => row.user_id === users.inspector)?.finance_adjustment_cents, 0)

    console.log('personnel settlement phase3 Preview integration passed: cleaner, inspector, warehouse, mixed')
  } finally {
    await cleanup()
    await resetChromiumBrowser()
    await pgPool.end()
  }
}

main().catch(async (error) => {
  console.error(error)
  try { await cleanup() } catch {}
  try { await resetChromiumBrowser() } catch {}
  try { await pgPool?.end() } catch {}
  process.exit(1)
})
