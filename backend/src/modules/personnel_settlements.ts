import { Router } from 'express'
import multer from 'multer'
import { z } from 'zod'
import { requireAnyPerm, requirePerm, userHasAnyPerm } from '../auth'
import { hasPg, pgPool } from '../dbAdapter'
import { buildPersonnelSettlementPreview } from '../lib/personnelSettlementPreview'
import { CLEANING_PROPERTY_TYPES } from '../lib/personnelSettlement'
import {
  getPersonnelSettlementProfile,
  listPersonnelSettlementProfiles,
  savePersonnelSettlementProfile,
  type PersonnelProfilePatch,
} from '../lib/personnelSettlementProfiles'
import {
  assertPersonnelSettlementSchemaReady,
  PersonnelSettlementSchemaNotReady,
} from '../lib/personnelSettlementSchema'
import { PersonnelSettlementPhase5SchemaNotReady } from '../lib/personnelSettlementPhase5Schema'
import {
  ensurePersonnelSettlementDocument,
  getPersonnelSettlementDocument,
  readPersonnelSettlementDocumentBytes,
  selectCurrentPersonnelSettlementDocuments,
  serializePersonnelSettlementDocument,
} from '../lib/personnelSettlementDocuments'
import {
  listPersonnelSettlementJobRuns,
} from '../lib/personnelSettlementWeeklyJob'
import {
  getPersonnelFeeRuleEffectiveDateConstraint,
  listPersonnelFeeRuleHistory,
  savePersonnelFeeRule,
  type PersonnelFeeRuleInput,
} from '../lib/personnelSettlementRules'
import {
  createPersonnelClaim,
  estimatePersonnelClaim,
  estimatePersonnelClaimForReview,
  getPersonnelClaim,
  listPersonnelClaimOptions,
  listPersonnelClaims,
  reviewPersonnelClaim,
  submitPersonnelClaim,
  updatePersonnelClaim,
  type PersonnelClaimInput,
  type PersonnelClaimReviewInput,
} from '../lib/personnelWorkloadClaims'
import {
  getPersonnelClaimEvidence,
  PERSONNEL_CLAIM_EVIDENCE_MAX_BYTES,
  readPersonnelClaimEvidenceBytes,
  savePersonnelClaimEvidence,
} from '../lib/personnelClaimEvidence'
import { CLEANING_IMAGE_FORMAT_ERROR } from '../lib/cleaningMediaImage'
import {
  adjustPersonnelSettlement,
  confirmPersonnelSettlementPaid,
  getPersonnelSettlementSubmissionPreview,
  getPersonnelWeeklySettlement,
  listPersonnelWeeklySettlements,
  reopenPersonnelSettlement,
  reviewPersonnelSettlementDisputeClaim,
  resolvePersonnelSettlementDispute,
  returnPersonnelSettlementForConfirmation,
  respondPersonnelSettlement,
  submitPersonnelSettlementWeek,
  submitPersonnelSettlementClaimForReconciliation,
  voidPersonnelSettlement,
} from '../lib/personnelSettlementWorkflow'

export const router = Router()

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
const previewQuerySchema = z.object({
  week_start: z.string().trim().regex(DATE_ONLY),
  user_ids: z.union([z.string(), z.array(z.string())]).optional(),
})
const profileListQuerySchema = z.object({ search: z.string().trim().max(120).optional() })
const selfProfilePatchFields = {
  legal_name: z.string().trim().max(120).optional().nullable(),
  supplier_business_name: z.string().trim().max(160).optional().nullable(),
  personal_abn: z.string().trim().max(32).optional().nullable(),
  gst_status: z.enum(['unconfirmed', 'registered', 'not_registered']).optional(),
  bank_account_name: z.string().trim().max(120).optional().nullable(),
  bank_bsb: z.string().trim().max(32).optional().nullable(),
  bank_account_number: z.string().trim().max(32).optional().nullable(),
}
const profilePatchFields = {
  ...selfProfilePatchFields,
  settlement_enabled: z.boolean().optional(),
  person_type: z.enum(['cleaner', 'inspector', 'warehouse', 'trial', 'external', 'mixed']).optional(),
}
const selfProfilePatchSchema = z.object({
  effective_date: z.string().trim().regex(DATE_ONLY),
  ...selfProfilePatchFields,
}).strict()
const adminProfilePatchSchema = z.object({
  effective_date: z.string().trim().regex(DATE_ONLY),
  reason: z.string().trim().min(1).max(500),
  ...profilePatchFields,
}).strict()
const feeRuleItemSchema = z.object({
  component_type: z.enum([
    'cleaning_task', 'inspection_day', 'warehouse_hour',
    'trial_task', 'trial_day', 'trial_hour',
    'external_task', 'external_day', 'external_hour',
    'weekly_fixed', 'subsidy_amount', 'overtime_hour',
    'new_property_task', 'custom_amount',
  ]),
  property_id: z.string().trim().max(120).optional().nullable(),
  task_type: z.string().trim().max(120).optional().nullable(),
  conditions: z.object({
    property_type: z.enum(CLEANING_PROPERTY_TYPES).optional().nullable(),
  }).strict().optional().nullable(),
  priority: z.number().int().min(0).max(100000).optional(),
  rate_cents: z.number().int().min(0).max(100_000_000),
}).strict()
const feeRuleSchema = z.object({
  name: z.string().trim().min(1).max(120),
  effective_date: z.string().trim().regex(DATE_ONLY),
  price_basis: z.enum(['exclusive_gst', 'inclusive_gst']),
  notes: z.string().trim().max(1000).optional().nullable(),
  items: z.array(feeRuleItemSchema).min(1).max(50),
}).strict()
const claimTypeSchema = z.enum([
  'warehouse_hour',
  'trial_task', 'trial_day', 'trial_hour',
  'external_task', 'external_day', 'external_hour',
  'subsidy_amount', 'overtime_hour', 'new_property_task', 'custom_amount',
])
const claimInputSchema = z.object({
  client_request_id: z.string().trim().regex(/^[a-zA-Z0-9_-]{8,120}$/).optional().nullable(),
  service_date: z.string().trim().regex(DATE_ONLY),
  claim_type: claimTypeSchema,
  property_id: z.string().trim().max(120).optional().nullable(),
  cleaning_task_id: z.string().trim().max(120).optional().nullable(),
  started_at: z.string().trim().max(64).optional().nullable(),
  ended_at: z.string().trim().max(64).optional().nullable(),
  duration_minutes: z.number().int().min(0).max(10080).optional().nullable(),
  requested_quantity: z.union([z.number().nonnegative().max(1_000_000), z.string().trim().max(32)]).optional().nullable(),
  requested_amount_cents: z.number().int().min(0).max(100_000_000).optional().nullable(),
  note: z.string().trim().min(1).max(1000),
}).strict()
export const myClaimEstimateQuerySchema = z.object({
  service_date: z.string().trim().regex(DATE_ONLY),
  claim_type: claimTypeSchema,
  duration_minutes: z.coerce.number().int().min(0).max(10080).optional(),
  requested_quantity: z.string().trim().max(32).optional(),
  requested_amount_cents: z.coerce.number().int().min(0).max(100_000_000).optional(),
  _: z.union([z.string().trim().max(64), z.array(z.string().trim().max(64)).max(5)]).optional(),
}).strict()
export const claimReviewEstimateQuerySchema = z.object({
  duration_minutes: z.coerce.number().int().min(0).max(10080).optional(),
  requested_quantity: z.string().trim().max(32).optional(),
  requested_amount_cents: z.coerce.number().int().min(0).max(100_000_000).optional(),
  _: z.union([z.string().trim().max(64), z.array(z.string().trim().max(64)).max(5)]).optional(),
}).strict()
const claimEvidenceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: PERSONNEL_CLAIM_EVIDENCE_MAX_BYTES },
})
const transportCacheQuerySchema = z.union([
  z.string().trim().max(64),
  z.array(z.string().trim().max(64)).max(5),
]).optional()
export const claimListQuerySchema = z.object({
  week_start: z.string().trim().regex(DATE_ONLY).optional(),
  status: z.enum(['draft', 'submitted', 'approved', 'rejected', 'returned']).optional(),
  search: z.string().trim().max(120).optional(),
  _: transportCacheQuerySchema,
}).strict()
const claimReviewSchema = z.object({
  action: z.enum(['approve', 'return', 'reject']),
  approved_duration_minutes: z.number().int().min(0).max(10080).optional().nullable(),
  approved_quantity: z.union([z.number().nonnegative().max(1_000_000), z.string().trim().max(32)]).optional().nullable(),
  approved_amount_cents: z.number().int().min(0).max(100_000_000).optional().nullable(),
  review_note: z.string().trim().max(1000).optional().nullable(),
}).strict()
export const weeklyListQuerySchema = z.object({
  week_start: z.string().trim().regex(DATE_ONLY).optional(),
  status: z.enum(['draft', 'awaiting_confirmation', 'confirmed', 'disputed', 'finance_approved', 'paid', 'void']).optional(),
  search: z.string().trim().max(120).optional(),
  _: transportCacheQuerySchema,
}).strict()
export const myClaimListQuerySchema = claimListQuerySchema.pick({ week_start: true, status: true, _: true })
export const myWeeklyListQuerySchema = weeklyListQuerySchema.pick({ week_start: true, status: true, _: true })
export const myClaimOptionsQuerySchema = z.object({
  service_date: z.string().trim().regex(DATE_ONLY),
  _: transportCacheQuerySchema,
}).strict()
export const myWeeklySubmissionQuerySchema = z.object({
  week_start: z.string().trim().regex(DATE_ONLY),
  _: transportCacheQuerySchema,
}).strict()
export const myWeeklySubmissionBodySchema = z.object({
  week_start: z.string().trim().regex(DATE_ONLY),
  confirmation_token: z.string().trim().regex(/^[a-f0-9]{64}$/),
}).strict()
const settlementNoteSchema = z.object({ note: z.string().trim().max(1000).optional().nullable() }).strict()
const settlementReasonSchema = z.object({ reason: z.string().trim().min(1).max(1000) }).strict()
const settlementAdjustmentSchema = z.object({
  adjustment_cents: z.number().int().min(-100_000_000).max(100_000_000),
  reason: z.string().trim().min(1).max(1000),
}).strict()
const settlementDisputeResolutionSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('keep_amount') }).strict(),
  z.object({
    decision: z.literal('edit_amount'),
    final_total_cents: z.number().int().min(0).max(100_000_000),
  }).strict(),
])
const settlementConfirmPaidSchema = z.object({
  payment_date: z.string().trim().regex(DATE_ONLY),
  payment_reference: z.string().trim().max(120).optional().nullable(),
}).strict()
const legacySettlementPaymentSchema = z.object({
  payment_date: z.string().trim().regex(DATE_ONLY),
  payment_amount_cents: z.number().int().min(0).max(100_000_000),
  payment_reference: z.string().trim().max(120).optional().nullable(),
  note: z.string().trim().max(1000).optional().nullable(),
}).strict()

const BANK_FIELDS = ['bank_account_name', 'bank_bsb', 'bank_account_number'] as const

function parseUserIds(value: string | string[] | undefined) {
  const values = Array.isArray(value) ? value : value ? [value] : []
  return Array.from(new Set(
    values.flatMap((item) => String(item || '').split(',')).map((item) => item.trim()).filter(Boolean),
  ))
}

function errorStatus(error: any) {
  const code = String(error?.message || '')
  if (['user_not_found', 'claim_not_found', 'settlement_not_found', 'settlement_document_not_found'].includes(code)) return 404
  if (
    code === 'profile_effective_date_locked'
    || code === 'rule_effective_date_locked'
    || code === 'claim_not_editable'
    || code === 'claim_not_submittable'
    || code === 'claim_not_reviewable'
    || code === 'claim_period_locked'
    || code === 'settlement_batch_locked'
    || code === 'settlement_transition_invalid'
    || code === 'settlement_already_paid'
    || code === 'company_expense_manual_override'
    || code === 'company_expense_paid_lock'
    || code === 'claim_request_conflict'
    || code === 'claim_evidence_media_conflict'
    || code === 'settlement_claims_pending'
  ) return 409
  if (code === 'claim_evidence_file_too_large') return 413
  if (code === 'image_format_unsupported' || error?.code === CLEANING_IMAGE_FORMAT_ERROR) return 415
  if (code === 'invalid_claim_evidence_reference') return 403
  if (code === 'media_storage_unavailable') return 503
  if (code === 'pg_required') return 400
  if (
    code.startsWith('invalid_')
    || code === 'effective_date_in_future'
    || code.endsWith('_required')
    || code.endsWith('_too_long')
    || code === 'abn_required_for_gst'
    || code.startsWith('invalid_rule_')
    || code === 'duplicate_rule_item_scope'
    || code === 'rule_notes_too_long'
    || code.startsWith('claim_')
    || code.startsWith('approved_')
    || code.startsWith('settlement_')
    || code.startsWith('payment_')
    || code === 'company_expense_required'
  ) return 400
  return 500
}

function handleClaimEvidenceUpload(req: any, res: any, next: any) {
  claimEvidenceUpload.single('file')(req, res, (error: any) => {
    if (error?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ code: 'claim_evidence_file_too_large' })
    return error ? next(error) : next()
  })
}

async function sendClaimEvidenceImage(res: any, row: any) {
  const object = await readPersonnelClaimEvidenceBytes(row)
  if (!object?.body?.length) return res.status(404).json({ code: 'claim_evidence_file_not_found' })
  res.setHeader('Content-Type', object.contentType || 'image/jpeg')
  res.setHeader('Cache-Control', 'private, max-age=0, no-store')
  res.setHeader('Content-Disposition', 'inline')
  return res.status(200).send(object.body)
}

function sendProfileError(res: any, error: any) {
  if (error instanceof PersonnelSettlementSchemaNotReady || error instanceof PersonnelSettlementPhase5SchemaNotReady) {
    return res.status(503).json({ code: String(error.message) })
  }
  const code = String(error?.message || 'personnel_settlement_profile_failed')
  const status = errorStatus(error)
  if (status >= 500) {
    console.error('[personnel-settlements] profile request failed', {
      code: 'personnel_settlement_profile_failed',
      error_name: String(error?.name || 'Error'),
    })
  }
  const payload: any = { code: status >= 500 ? 'personnel_settlement_profile_failed' : code }
  if (code === 'rule_effective_date_locked' && error?.constraints) payload.constraints = error.constraints
  return res.status(status).json(payload)
}

async function sendSettlementDocument(res: any, row: any) {
  const object = await readPersonnelSettlementDocumentBytes(row)
  if (!object?.body?.length) return res.status(404).json({ code: 'settlement_document_file_not_found' })
  const serialized = serializePersonnelSettlementDocument(row)
  res.setHeader('Content-Type', object.contentType || 'application/pdf')
  res.setHeader('Cache-Control', 'private, max-age=0, no-store')
  res.setHeader('Content-Disposition', `inline; filename="${serialized.file_name.replace(/[^a-zA-Z0-9._-]/g, '_')}"`)
  return res.status(200).send(object.body)
}

router.get('/my-profile', async (req, res) => {
  const userId = String((req as any).user?.sub || '').trim()
  if (!userId) return res.status(401).json({ code: 'unauthorized' })
  if (!hasPg || !pgPool) return res.status(400).json({ code: 'pg_required' })
  try {
    const profile = await getPersonnelSettlementProfile({ userId, includeBankDetails: true }, pgPool)
    if (!profile) return res.status(404).json({ code: 'user_not_found' })
    return res.json({ ...profile, settlement_profile_available: true })
  } catch (error: any) {
    return sendProfileError(res, error)
  }
})

router.patch('/my-profile', async (req, res) => {
  const userId = String((req as any).user?.sub || '').trim()
  if (!userId) return res.status(401).json({ code: 'unauthorized' })
  const parsed = selfProfilePatchSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json({ code: 'invalid_personnel_profile', details: parsed.error.format() })
  try {
    const { effective_date, ...patch } = parsed.data
    const profile = await savePersonnelSettlementProfile({
      userId,
      actorUserId: userId,
      source: 'mobile_self',
      effectiveDate: effective_date,
      patch: patch as PersonnelProfilePatch,
    })
    return res.json({ ...profile, settlement_profile_available: true })
  } catch (error: any) {
    return sendProfileError(res, error)
  }
})

router.get('/profiles', requirePerm('personnel_settlements.profiles.view'), async (req, res) => {
  const parsed = profileListQuerySchema.safeParse(req.query || {})
  if (!parsed.success) return res.status(400).json({ code: 'invalid_profile_query', details: parsed.error.format() })
  if (!hasPg || !pgPool) return res.status(400).json({ code: 'pg_required' })
  try {
    return res.json(await listPersonnelSettlementProfiles({
      search: parsed.data.search,
      includeBankDetails: false,
    }, pgPool))
  } catch (error: any) {
    return sendProfileError(res, error)
  }
})

router.get('/profiles/:userId', requirePerm('personnel_settlements.profiles.view'), async (req, res) => {
  const userId = String(req.params.userId || '').trim()
  if (!userId) return res.status(400).json({ code: 'user_id_required' })
  try {
    const includeBankDetails = await userHasAnyPerm((req as any).user, ['personnel_settlements.bank.manage'])
    const profile = await getPersonnelSettlementProfile({ userId, includeBankDetails }, pgPool)
    if (!profile) return res.status(404).json({ code: 'user_not_found' })
    return res.json(profile)
  } catch (error: any) {
    return sendProfileError(res, error)
  }
})

router.patch('/profiles/:userId', requirePerm('personnel_settlements.profiles.manage'), async (req, res) => {
  const userId = String(req.params.userId || '').trim()
  if (!userId) return res.status(400).json({ code: 'user_id_required' })
  const parsed = adminProfilePatchSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json({ code: 'invalid_personnel_profile', details: parsed.error.format() })
  const changesBank = BANK_FIELDS.some((field) => parsed.data[field] !== undefined)
  if (changesBank && !(await userHasAnyPerm((req as any).user, ['personnel_settlements.bank.manage']))) {
    return res.status(403).json({ code: 'bank_permission_required' })
  }
  try {
    const actorUserId = String((req as any).user?.sub || '').trim()
    const { effective_date, reason, ...patch } = parsed.data
    return res.json(await savePersonnelSettlementProfile({
      userId,
      actorUserId,
      source: 'web_admin',
      reason,
      effectiveDate: effective_date,
      patch: patch as PersonnelProfilePatch,
    }))
  } catch (error: any) {
    return sendProfileError(res, error)
  }
})

router.get('/profiles/:userId/rules', requirePerm('personnel_settlements.rules.manage'), async (req, res) => {
  const userId = String(req.params.userId || '').trim()
  if (!userId) return res.status(400).json({ code: 'user_id_required' })
  try {
    return res.json(await listPersonnelFeeRuleHistory(userId))
  } catch (error: any) {
    return sendProfileError(res, error)
  }
})

router.get('/profiles/:userId/rule-constraints', requirePerm('personnel_settlements.rules.manage'), async (req, res) => {
  const userId = String(req.params.userId || '').trim()
  if (!userId) return res.status(400).json({ code: 'user_id_required' })
  try {
    return res.json(await getPersonnelFeeRuleEffectiveDateConstraint(userId))
  } catch (error: any) {
    return sendProfileError(res, error)
  }
})

router.post('/profiles/:userId/rules', requirePerm('personnel_settlements.rules.manage'), async (req, res) => {
  const userId = String(req.params.userId || '').trim()
  if (!userId) return res.status(400).json({ code: 'user_id_required' })
  const parsed = feeRuleSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json({ code: 'invalid_fee_rule', details: parsed.error.format() })
  try {
    const actorUserId = String((req as any).user?.sub || '').trim()
    return res.json(await savePersonnelFeeRule({
      userId,
      actorUserId,
      rule: parsed.data as PersonnelFeeRuleInput,
    }))
  } catch (error: any) {
    return sendProfileError(res, error)
  }
})

router.get('/my-claims', async (req, res) => {
  const userId = String((req as any).user?.sub || '').trim()
  if (!userId) return res.status(401).json({ code: 'unauthorized' })
  const parsed = myClaimListQuerySchema.safeParse(req.query || {})
  if (!parsed.success) return res.status(400).json({ code: 'invalid_claim_query', details: parsed.error.format() })
  try {
    return res.json(await listPersonnelClaims({ userId, weekStart: parsed.data.week_start, status: parsed.data.status }))
  } catch (error: any) {
    return sendProfileError(res, error)
  }
})

router.get('/my-claim-options', async (req, res) => {
  const userId = String((req as any).user?.sub || '').trim()
  if (!userId) return res.status(401).json({ code: 'unauthorized' })
  const parsed = myClaimOptionsQuerySchema.safeParse(req.query || {})
  if (!parsed.success) return res.status(400).json({ code: 'invalid_claim_options_query', details: parsed.error.format() })
  try {
    return res.json(await listPersonnelClaimOptions({ userId, serviceDate: parsed.data.service_date }))
  } catch (error: any) {
    return sendProfileError(res, error)
  }
})

router.get('/my-claim-estimate', async (req, res) => {
  const userId = String((req as any).user?.sub || '').trim()
  if (!userId) return res.status(401).json({ code: 'unauthorized' })
  const parsed = myClaimEstimateQuerySchema.safeParse(req.query || {})
  if (!parsed.success) return res.status(400).json({ code: 'invalid_claim_estimate_query', details: parsed.error.format() })
  try {
    return res.json(await estimatePersonnelClaim({
      userId,
      estimate: {
        serviceDate: parsed.data.service_date,
        claimType: parsed.data.claim_type,
        durationMinutes: parsed.data.duration_minutes,
        requestedQuantity: parsed.data.requested_quantity,
        requestedAmountCents: parsed.data.requested_amount_cents,
      },
    }))
  } catch (error: any) {
    return sendProfileError(res, error)
  }
})

router.post('/my-claims', async (req, res) => {
  const userId = String((req as any).user?.sub || '').trim()
  if (!userId) return res.status(401).json({ code: 'unauthorized' })
  const parsed = claimInputSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json({ code: 'invalid_claim', details: parsed.error.format() })
  try {
    return res.status(201).json(await createPersonnelClaim({ userId, claim: parsed.data as PersonnelClaimInput }))
  } catch (error: any) {
    return sendProfileError(res, error)
  }
})

router.post('/my-claims/:claimId/evidence', handleClaimEvidenceUpload, async (req, res) => {
  const userId = String((req as any).user?.sub || '').trim()
  if (!userId) return res.status(401).json({ code: 'unauthorized' })
  if (!req.file?.buffer?.length) return res.status(400).json({ code: 'claim_evidence_file_required' })
  try {
    return res.status(201).json(await savePersonnelClaimEvidence({
      userId,
      claimId: String(req.params.claimId || '').trim(),
      mediaId: String(req.body?.media_id || '').trim(),
      originalFileName: req.file.originalname,
      contentType: req.file.mimetype,
      body: req.file.buffer,
    }))
  } catch (error: any) {
    return sendProfileError(res, error)
  }
})

router.get('/my-claims/:claimId/evidence/:evidenceId/image', async (req, res) => {
  const userId = String((req as any).user?.sub || '').trim()
  if (!userId) return res.status(401).json({ code: 'unauthorized' })
  try {
    const evidence = await getPersonnelClaimEvidence({
      claimId: String(req.params.claimId || '').trim(),
      evidenceId: String(req.params.evidenceId || '').trim(),
      requestingUserId: userId,
    })
    if (!evidence) return res.status(404).json({ code: 'claim_evidence_not_found' })
    return await sendClaimEvidenceImage(res, evidence)
  } catch (error: any) {
    return sendProfileError(res, error)
  }
})

router.get('/my-claims/:claimId', async (req, res) => {
  const userId = String((req as any).user?.sub || '').trim()
  if (!userId) return res.status(401).json({ code: 'unauthorized' })
  try {
    const claim = await getPersonnelClaim({ claimId: String(req.params.claimId || ''), requestingUserId: userId })
    if (!claim) return res.status(404).json({ code: 'claim_not_found' })
    return res.json(claim)
  } catch (error: any) {
    return sendProfileError(res, error)
  }
})

router.patch('/my-claims/:claimId', async (req, res) => {
  const userId = String((req as any).user?.sub || '').trim()
  if (!userId) return res.status(401).json({ code: 'unauthorized' })
  const parsed = claimInputSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json({ code: 'invalid_claim', details: parsed.error.format() })
  try {
    return res.json(await updatePersonnelClaim({
      userId,
      claimId: String(req.params.claimId || ''),
      claim: parsed.data as PersonnelClaimInput,
    }))
  } catch (error: any) {
    return sendProfileError(res, error)
  }
})

router.post('/my-claims/:claimId/submit', async (req, res) => {
  const userId = String((req as any).user?.sub || '').trim()
  if (!userId) return res.status(401).json({ code: 'unauthorized' })
  try {
    return res.json(await submitPersonnelClaim({ userId, claimId: String(req.params.claimId || '') }))
  } catch (error: any) {
    return sendProfileError(res, error)
  }
})

router.get('/claims', requirePerm('personnel_settlements.profiles.view'), async (req, res) => {
  const parsed = claimListQuerySchema.safeParse(req.query || {})
  if (!parsed.success) return res.status(400).json({ code: 'invalid_claim_query', details: parsed.error.format() })
  try {
    return res.json(await listPersonnelClaims({
      weekStart: parsed.data.week_start,
      status: parsed.data.status,
      search: parsed.data.search,
    }))
  } catch (error: any) {
    return sendProfileError(res, error)
  }
})

router.get('/claims/:claimId', requirePerm('personnel_settlements.profiles.view'), async (req, res) => {
  try {
    const claim = await getPersonnelClaim({ claimId: String(req.params.claimId || '') })
    if (!claim) return res.status(404).json({ code: 'claim_not_found' })
    return res.json(claim)
  } catch (error: any) {
    return sendProfileError(res, error)
  }
})

router.get('/claims/:claimId/estimate', requirePerm('personnel_settlements.profiles.view'), async (req, res) => {
  const parsed = claimReviewEstimateQuerySchema.safeParse(req.query || {})
  if (!parsed.success) return res.status(400).json({ code: 'invalid_claim_estimate_query', details: parsed.error.format() })
  try {
    return res.json(await estimatePersonnelClaimForReview({
      claimId: String(req.params.claimId || ''),
      durationMinutes: parsed.data.duration_minutes,
      requestedQuantity: parsed.data.requested_quantity,
      requestedAmountCents: parsed.data.requested_amount_cents,
    }))
  } catch (error: any) {
    return sendProfileError(res, error)
  }
})

router.get(
  '/claims/:claimId/evidence/:evidenceId/image',
  requirePerm('personnel_settlements.profiles.view'),
  async (req, res) => {
    try {
      const evidence = await getPersonnelClaimEvidence({
        claimId: String(req.params.claimId || '').trim(),
        evidenceId: String(req.params.evidenceId || '').trim(),
      })
      if (!evidence) return res.status(404).json({ code: 'claim_evidence_not_found' })
      return await sendClaimEvidenceImage(res, evidence)
    } catch (error: any) {
      return sendProfileError(res, error)
    }
  },
)

router.post(
  '/claims/:claimId/review',
  requireAnyPerm(['personnel_settlements.rules.manage', 'finance.payout']),
  async (req, res) => {
    const parsed = claimReviewSchema.safeParse(req.body || {})
    if (!parsed.success) return res.status(400).json({ code: 'invalid_claim_review', details: parsed.error.format() })
    try {
      return res.json(await reviewPersonnelClaim({
        claimId: String(req.params.claimId || ''),
        actorUserId: String((req as any).user?.sub || ''),
        review: parsed.data as PersonnelClaimReviewInput,
      }))
    } catch (error: any) {
      return sendProfileError(res, error)
    }
  },
)

router.get('/my-settlements', async (req, res) => {
  const userId = String((req as any).user?.sub || '').trim()
  if (!userId) return res.status(401).json({ code: 'unauthorized' })
  const parsed = myWeeklyListQuerySchema.safeParse(req.query || {})
  if (!parsed.success) return res.status(400).json({ code: 'invalid_weekly_settlement_query', details: parsed.error.format() })
  try {
    return res.json(await listPersonnelWeeklySettlements({
      userId,
      weekStart: parsed.data.week_start,
      status: parsed.data.status,
    }))
  } catch (error: any) {
    return sendProfileError(res, error)
  }
})

router.get('/my-settlements-preview', async (req, res) => {
  const userId = String((req as any).user?.sub || '').trim()
  if (!userId) return res.status(401).json({ code: 'unauthorized' })
  const parsed = myWeeklySubmissionQuerySchema.safeParse(req.query || {})
  if (!parsed.success) return res.status(400).json({ code: 'invalid_weekly_submission_preview', details: parsed.error.format() })
  try {
    return res.json(await getPersonnelSettlementSubmissionPreview({
      userId,
      weekStart: parsed.data.week_start,
    }))
  } catch (error: any) {
    return sendProfileError(res, error)
  }
})

router.post('/my-settlements-submit', async (req, res) => {
  const userId = String((req as any).user?.sub || '').trim()
  if (!userId) return res.status(401).json({ code: 'unauthorized' })
  const parsed = myWeeklySubmissionBodySchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json({ code: 'invalid_weekly_submission', details: parsed.error.format() })
  try {
    return res.json(await submitPersonnelSettlementWeek({
      userId,
      weekStart: parsed.data.week_start,
      confirmationToken: parsed.data.confirmation_token,
    }))
  } catch (error: any) {
    return sendProfileError(res, error)
  }
})

router.get('/my-settlements/:settlementId', async (req, res) => {
  const userId = String((req as any).user?.sub || '').trim()
  if (!userId) return res.status(401).json({ code: 'unauthorized' })
  try {
    const settlement = await getPersonnelWeeklySettlement({
      settlementId: String(req.params.settlementId || ''),
      requestingUserId: userId,
    })
    if (!settlement) return res.status(404).json({ code: 'settlement_not_found' })
    return res.json({
      ...settlement,
      documents: selectCurrentPersonnelSettlementDocuments(settlement.documents || [], settlement.status),
    })
  } catch (error: any) {
    return sendProfileError(res, error)
  }
})

router.get('/my-settlements/:settlementId/documents/:documentId', async (req, res) => {
  const userId = String((req as any).user?.sub || '').trim()
  if (!userId) return res.status(401).json({ code: 'unauthorized' })
  try {
    const document = await getPersonnelSettlementDocument({
      settlementId: String(req.params.settlementId || ''),
      documentId: String(req.params.documentId || ''),
      requestingUserId: userId,
    })
    if (!document) return res.status(404).json({ code: 'settlement_document_not_found' })
    return await sendSettlementDocument(res, document)
  } catch (error: any) {
    return sendProfileError(res, error)
  }
})

router.post('/my-settlements/:settlementId/confirm', async (req, res) => {
  const userId = String((req as any).user?.sub || '').trim()
  if (!userId) return res.status(401).json({ code: 'unauthorized' })
  const parsed = settlementNoteSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json({ code: 'invalid_settlement_confirmation', details: parsed.error.format() })
  try {
    return res.json(await respondPersonnelSettlement({
      settlementId: String(req.params.settlementId || ''),
      userId,
      action: 'confirm',
      note: parsed.data.note,
    }))
  } catch (error: any) {
    return sendProfileError(res, error)
  }
})

router.post('/my-settlements/:settlementId/dispute', async (req, res) => {
  const userId = String((req as any).user?.sub || '').trim()
  if (!userId) return res.status(401).json({ code: 'unauthorized' })
  const parsed = settlementReasonSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json({ code: 'invalid_settlement_dispute', details: parsed.error.format() })
  try {
    return res.json(await respondPersonnelSettlement({
      settlementId: String(req.params.settlementId || ''),
      userId,
      action: 'dispute',
      note: parsed.data.reason,
    }))
  } catch (error: any) {
    return sendProfileError(res, error)
  }
})

router.post('/my-settlements/:settlementId/claims/:claimId/submit-for-reconciliation', async (req, res) => {
  const userId = String((req as any).user?.sub || '').trim()
  if (!userId) return res.status(401).json({ code: 'unauthorized' })
  const parsed = settlementReasonSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json({ code: 'invalid_settlement_reconciliation_request', details: parsed.error.format() })
  try {
    return res.json(await submitPersonnelSettlementClaimForReconciliation({
      settlementId: String(req.params.settlementId || ''),
      claimId: String(req.params.claimId || ''),
      userId,
      note: parsed.data.reason,
    }))
  } catch (error: any) {
    return sendProfileError(res, error)
  }
})

router.get('/weekly', requirePerm('personnel_settlements.profiles.view'), async (req, res) => {
  const parsed = weeklyListQuerySchema.safeParse(req.query || {})
  if (!parsed.success) return res.status(400).json({ code: 'invalid_weekly_settlement_query', details: parsed.error.format() })
  try {
    return res.json(await listPersonnelWeeklySettlements({
      weekStart: parsed.data.week_start,
      status: parsed.data.status,
      search: parsed.data.search,
    }))
  } catch (error: any) {
    return sendProfileError(res, error)
  }
})

router.post('/weekly/generate', requirePerm('personnel_settlements.rules.manage'), async (req, res) => {
  return res.status(410).json({ code: 'settlement_finance_first_flow_removed' })
})

router.post('/weekly/run', requirePerm('personnel_settlements.rules.manage'), async (req, res) => {
  return res.status(410).json({ code: 'settlement_finance_first_flow_removed' })
})

router.get('/weekly-runs', requirePerm('personnel_settlements.profiles.view'), async (req, res) => {
  try {
    return res.json(await listPersonnelSettlementJobRuns(Number(req.query?.limit || 30)))
  } catch (error: any) {
    return sendProfileError(res, error)
  }
})

router.get('/weekly/:settlementId', requirePerm('personnel_settlements.profiles.view'), async (req, res) => {
  try {
    const includeBankDetails = await userHasAnyPerm((req as any).user, ['personnel_settlements.bank.manage'])
    const settlement = await getPersonnelWeeklySettlement({
      settlementId: String(req.params.settlementId || ''),
      includeBankDetails,
    })
    if (!settlement) return res.status(404).json({ code: 'settlement_not_found' })
    return res.json(settlement)
  } catch (error: any) {
    return sendProfileError(res, error)
  }
})

router.post(
  '/weekly/:settlementId/claims/:claimId/review',
  requireAnyPerm(['personnel_settlements.rules.manage', 'finance.payout']),
  async (req, res) => {
    const parsed = claimReviewSchema.safeParse(req.body || {})
    if (!parsed.success) return res.status(400).json({ code: 'invalid_claim_review', details: parsed.error.format() })
    try {
      return res.json(await reviewPersonnelSettlementDisputeClaim({
        settlementId: String(req.params.settlementId || ''),
        claimId: String(req.params.claimId || ''),
        actorUserId: String((req as any).user?.sub || ''),
        review: parsed.data as PersonnelClaimReviewInput,
      }))
    } catch (error: any) {
      return sendProfileError(res, error)
    }
  },
)

router.get('/weekly/:settlementId/documents/:documentId', requirePerm('personnel_settlements.profiles.view'), async (req, res) => {
  try {
    const document = await getPersonnelSettlementDocument({
      settlementId: String(req.params.settlementId || ''),
      documentId: String(req.params.documentId || ''),
    })
    if (!document) return res.status(404).json({ code: 'settlement_document_not_found' })
    return await sendSettlementDocument(res, document)
  } catch (error: any) {
    return sendProfileError(res, error)
  }
})

router.post('/weekly/:settlementId/generate-document', requirePerm('personnel_settlements.rules.manage'), async (req, res) => {
  try {
    return res.json(await ensurePersonnelSettlementDocument({
      settlementId: String(req.params.settlementId || ''),
      actorUserId: String((req as any).user?.sub || ''),
    }))
  } catch (error: any) {
    return sendProfileError(res, error)
  }
})

router.post('/weekly/:settlementId/issue-confirmation', requirePerm('personnel_settlements.rules.manage'), async (req, res) => {
  return res.status(410).json({ code: 'settlement_finance_first_flow_removed' })
})

router.post('/weekly/:settlementId/adjust', requirePerm('personnel_settlements.rules.manage'), async (req, res) => {
  const parsed = settlementAdjustmentSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json({ code: 'invalid_settlement_adjustment', details: parsed.error.format() })
  try {
    return res.json(await adjustPersonnelSettlement({
      settlementId: String(req.params.settlementId || ''),
      actorUserId: String((req as any).user?.sub || ''),
      adjustmentCents: parsed.data.adjustment_cents,
      reason: parsed.data.reason,
    }))
  } catch (error: any) {
    return sendProfileError(res, error)
  }
})

router.post('/weekly/:settlementId/reopen', requirePerm('personnel_settlements.rules.manage'), async (req, res) => {
  const parsed = settlementReasonSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json({ code: 'invalid_settlement_reopen', details: parsed.error.format() })
  try {
    return res.json(await reopenPersonnelSettlement({
      settlementId: String(req.params.settlementId || ''),
      actorUserId: String((req as any).user?.sub || ''),
      reason: parsed.data.reason,
    }))
  } catch (error: any) {
    return sendProfileError(res, error)
  }
})

router.post(
  '/weekly/:settlementId/return-for-confirmation',
  requireAnyPerm(['personnel_settlements.rules.manage', 'finance.payout']),
  async (req, res) => {
    const parsed = settlementReasonSchema.safeParse(req.body || {})
    if (!parsed.success) return res.status(400).json({ code: 'invalid_settlement_return', details: parsed.error.format() })
    try {
      return res.json(await returnPersonnelSettlementForConfirmation({
        settlementId: String(req.params.settlementId || ''),
        actorUserId: String((req as any).user?.sub || ''),
        reason: parsed.data.reason,
      }))
    } catch (error: any) {
      return sendProfileError(res, error)
    }
  },
)

router.post(
  '/weekly/:settlementId/resolve-dispute',
  requireAnyPerm(['personnel_settlements.rules.manage', 'finance.payout']),
  async (req, res) => {
    const parsed = settlementDisputeResolutionSchema.safeParse(req.body || {})
    if (!parsed.success) return res.status(400).json({ code: 'invalid_settlement_dispute_resolution', details: parsed.error.format() })
    try {
      return res.json(await resolvePersonnelSettlementDispute({
        settlementId: String(req.params.settlementId || ''),
        actorUserId: String((req as any).user?.sub || ''),
        decision: parsed.data.decision,
        finalTotalCents: parsed.data.decision === 'edit_amount' ? parsed.data.final_total_cents : null,
      }))
    } catch (error: any) {
      return sendProfileError(res, error)
    }
  },
)

router.post('/weekly/:settlementId/approve', requirePerm('finance.payout'), async (req, res) => {
  return res.status(410).json({ code: 'settlement_approval_step_removed' })
})

router.post(
  '/weekly/:settlementId/confirm-paid',
  requirePerm('finance.payout'),
  requirePerm('personnel_settlements.bank.manage'),
  async (req, res) => {
    const parsed = settlementConfirmPaidSchema.safeParse(req.body || {})
    if (!parsed.success) return res.status(400).json({ code: 'invalid_settlement_payment', details: parsed.error.format() })
    try {
      return res.json(await confirmPersonnelSettlementPaid({
        settlementId: String(req.params.settlementId || ''),
        actorUserId: String((req as any).user?.sub || ''),
        payment: { payment_date: parsed.data.payment_date },
      }))
    } catch (error: any) {
      return sendProfileError(res, error)
    }
  },
)

router.post('/weekly/:settlementId/mark-paid', requirePerm('finance.payout'), requirePerm('personnel_settlements.bank.manage'), async (req, res) => {
  const parsed = legacySettlementPaymentSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json({ code: 'invalid_settlement_payment', details: parsed.error.format() })
  try {
    return res.json(await confirmPersonnelSettlementPaid({
      settlementId: String(req.params.settlementId || ''),
      actorUserId: String((req as any).user?.sub || ''),
      payment: {
        payment_date: parsed.data.payment_date,
      },
      expectedPaymentAmountCents: parsed.data.payment_amount_cents,
    }))
  } catch (error: any) {
    return sendProfileError(res, error)
  }
})

router.post('/weekly/:settlementId/void', requirePerm('finance.payout'), async (req, res) => {
  const parsed = settlementReasonSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json({ code: 'invalid_settlement_void', details: parsed.error.format() })
  try {
    return res.json(await voidPersonnelSettlement({
      settlementId: String(req.params.settlementId || ''),
      actorUserId: String((req as any).user?.sub || ''),
      reason: parsed.data.reason,
    }))
  } catch (error: any) {
    return sendProfileError(res, error)
  }
})

router.get(
  '/preview',
  requireAnyPerm(['personnel_settlements.view', 'personnel_settlements.profiles.view', 'finance.payout', 'finance.tx.write']),
  async (req, res) => {
    const parsed = previewQuerySchema.safeParse(req.query)
    if (!parsed.success) {
      return res.status(400).json({ code: 'invalid_settlement_preview_query', details: parsed.error.format() })
    }
    if (!hasPg || !pgPool) return res.status(400).json({ code: 'pg_required' })
    try {
      assertPersonnelSettlementSchemaReady()
      const userIds = parseUserIds(parsed.data.user_ids)
      if (userIds.length > 100) return res.status(400).json({ code: 'too_many_user_ids' })
      const preview = await buildPersonnelSettlementPreview({
        week_start: parsed.data.week_start,
        user_ids: userIds,
      }, pgPool)
      return res.json(preview)
    } catch (error: any) {
      if (error instanceof PersonnelSettlementSchemaNotReady) {
        return res.status(503).json({ code: 'personnel_settlement_schema_not_ready' })
      }
      const message = String(error?.message || '')
      if (message === 'week_start_must_be_monday' || message === 'invalid_week_start') {
        return res.status(400).json({ code: message })
      }
      console.error('[personnel-settlements] preview failed', {
        code: 'personnel_settlement_preview_failed',
        error_name: String(error?.name || 'Error'),
      })
      return res.status(500).json({ code: 'personnel_settlement_preview_failed' })
    }
  },
)
