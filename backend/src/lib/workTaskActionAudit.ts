import { hasPg, pgPool } from '../dbAdapter'
import type { WorkTaskActionId } from './workTaskActions'
import crypto from 'crypto'

export type WorkTaskActionAuditInput = {
  sourceType: string
  sourceId: string
  performedAsAction: WorkTaskActionId
  actorUserId: string
  performedByUserId?: string | null
  performedByName?: string | null
  statusBefore?: string | null
  statusAfter?: string | null
  metadata?: Record<string, any> | null
}

export type CleaningTaskTransitionInput = {
  taskId: string
  actionId: WorkTaskActionId
  actorUserId: string
  performedByUserId?: string | null
  performedByName?: string | null
  needsRestock?: boolean
  isStayover?: boolean
  metadata?: Record<string, any> | null
}

type Queryable = {
  query: (sql: string, params?: any[]) => Promise<any>
}

export type CleaningSubmissionState = {
  consumables_submitted: boolean
  property_photo_submitted: boolean
  ready: boolean
}

function cleanText(value: any) {
  return String(value ?? '').trim()
}

function lower(value: any) {
  return cleanText(value).toLowerCase()
}

const INSPECTION_PHOTO_MEDIA_TYPES = [
  'inspection_toilet',
  'inspection_living',
  'inspection_sofa',
  'inspection_bedroom',
  'inspection_kitchen',
  'inspection_bathroom',
  'inspection_shower_drain',
  'inspection_unclean',
]

let workTaskActionAuditsEnsured = false
let workTaskActionAuditsEnsuring: Promise<void> | null = null

export async function getCleaningSubmissionState(taskId: string, executor: Queryable | null = pgPool): Promise<CleaningSubmissionState> {
  const id = cleanText(taskId)
  if (!id || !executor) {
    return { consumables_submitted: false, property_photo_submitted: false, ready: false }
  }
  const result = await executor.query(
    `SELECT
       EXISTS (
         SELECT 1
         FROM cleaning_consumable_usages u
         WHERE u.task_id::text = $1::text
       ) AS consumables_submitted,
       EXISTS (
         SELECT 1
         FROM cleaning_task_media m
         WHERE m.task_id::text = $1::text
           AND m.type = 'consumable_living_room_photo'
           AND COALESCE(TRIM(m.url), '') <> ''
       ) AS property_photo_submitted`,
    [id],
  )
  const row = result?.rows?.[0] || {}
  const consumablesSubmitted = row.consumables_submitted === true
  const propertyPhotoSubmitted = row.property_photo_submitted === true
  return {
    consumables_submitted: consumablesSubmitted,
    property_photo_submitted: propertyPhotoSubmitted,
    ready: consumablesSubmitted && propertyPhotoSubmitted,
  }
}

export function cleaningSubmissionRequiredPayload(state: CleaningSubmissionState) {
  const missing_requirements = [
    ...(!state.consumables_submitted ? ['cleaning_consumables'] : []),
    ...(!state.property_photo_submitted ? ['cleaning_property_photo'] : []),
  ]
  return {
    message: 'cleaning_submission_required',
    code: 'CLEANING_SUBMISSION_REQUIRED',
    missing_requirements,
  }
}

export async function assertCleaningSubmissionReady(taskId: string, executor: Queryable | null = pgPool) {
  const id = cleanText(taskId)
  if (!id || !executor) return null
  const taskResult = await executor.query(
    `SELECT lower(COALESCE(inspection_scope, '')) AS inspection_scope,
            lower(COALESCE(task_type, type, '')) AS task_type
       FROM cleaning_tasks
      WHERE id::text = $1::text
      LIMIT 1`,
    [id],
  )
  const task = taskResult?.rows?.[0]
  if (
    !task
    || lower(task.inspection_scope) === 'password_only'
    || lower(task.task_type) === 'checkin_clean'
  ) return null
  const state = await getCleaningSubmissionState(id, executor)
  if (!state.ready) {
    const error: any = new Error('cleaning_submission_required')
    error.code = 'CLEANING_SUBMISSION_REQUIRED'
    error.statusCode = 409
    error.details = cleaningSubmissionRequiredPayload(state)
    throw error
  }
  return state
}

async function hasInspectionPhotoMedia(taskId: string, executor: Queryable, allowGuestArrivalSkip = false) {
  const result = await executor.query(
    `SELECT 1
       FROM cleaning_tasks t
      WHERE t.id::text = $1::text
        AND (
          $3::boolean
          OR EXISTS (
            SELECT 1
              FROM cleaning_task_media m
             WHERE m.task_id::text = $1::text
               AND m.type = ANY($2::text[])
               AND COALESCE(TRIM(m.url), '') <> ''
          )
          OR EXISTS (
            SELECT 1
              FROM work_task_action_audits a
             WHERE a.source_type = 'cleaning_tasks'
               AND a.source_id::text = $1::text
               AND a.performed_as_action = 'submit_inspection'
               AND COALESCE(a.metadata->>'guest_arrival_skip', 'false') = 'true'
          )
        )
      LIMIT 1`,
    [taskId, INSPECTION_PHOTO_MEDIA_TYPES, allowGuestArrivalSkip],
  )
  return !!result?.rows?.length
}

function isTerminalCleaningStatus(status: any) {
  const raw = lower(status)
  return raw === 'cancelled' || raw === 'canceled' || raw === 'ready' || raw === 'completed' || raw === 'done'
}

function isDoneLikeCleaningStatus(status: any) {
  const raw = lower(status)
  return [
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
  ].includes(raw)
}

export function keyPhotoUploadStatus(statusBefore: any, statusAfter: any, recoveredStatus?: any) {
  const before = lower(statusBefore)
  const recovered = lower(recoveredStatus)
  if (before === 'in_progress' && isDoneLikeCleaningStatus(recovered)) return recovered
  if (isDoneLikeCleaningStatus(before)) return before
  return lower(statusAfter)
}

async function latestCompletedStatusBeforeKeyUpload(taskId: string, executor: Queryable) {
  const result = await executor.query(
    `SELECT status_after
       FROM work_task_action_audits
      WHERE source_type = 'cleaning_tasks'
        AND source_id::text = $1::text
        AND performed_as_action = ANY($2::text[])
        AND lower(COALESCE(status_after, '')) = ANY($3::text[])
      ORDER BY performed_at DESC, created_at DESC
      LIMIT 1`,
    [
      taskId,
      ['fill_supplies', 'complete_cleaning', 'submit_inspection', 'upload_access_video'],
      ['cleaned', 'restock_pending', 'restocked', 'to_inspect', 'to_hang_keys', 'keys_hung', 'inspected', 'ready', 'completed', 'done'],
    ],
  )
  const status = lower(result?.rows?.[0]?.status_after)
  return isDoneLikeCleaningStatus(status) ? status : ''
}

export function resolveCleaningTaskActionStatus(input: {
  actionId: WorkTaskActionId
  statusBefore: string
  needsRestock?: boolean
  isStayover?: boolean
  inspectionPhotosSaved?: boolean
  isPasswordOnly?: boolean
}) {
  const current = lower(input.statusBefore)
  if (isTerminalCleaningStatus(current)) return current || null
  if (input.actionId === 'upload_key_photo') return current && isDoneLikeCleaningStatus(current) ? current : 'in_progress'
  if (input.actionId === 'fill_supplies') return input.needsRestock ? 'restock_pending' : 'cleaned'
  if (input.actionId === 'complete_cleaning') return input.isStayover ? 'cleaned' : (input.needsRestock ? 'restock_pending' : 'cleaned')
  if (input.actionId === 'submit_inspection') return input.inspectionPhotosSaved === false ? current || null : 'inspected'
  if (input.actionId === 'upload_access_video') return input.isPasswordOnly ? 'inspected' : 'keys_hung'
  return current || null
}

export function buildKeyPhotoUploadTaskPatch(input: {
  statusBefore: any
  statusAfter: any
  startedAt?: any
  keyPhotoUploadedAt?: any
  now: string
  lat?: number
  lng?: number
}) {
  const statusBefore = lower(input.statusBefore)
  const statusAfter = keyPhotoUploadStatus(input.statusBefore, input.statusAfter)
  const patch: Record<string, any> = {}
  if (statusAfter && statusAfter !== statusBefore) patch.status = statusAfter
  if (statusAfter === 'in_progress' && !cleanText(input.startedAt)) patch.started_at = input.now
  if (!cleanText(input.keyPhotoUploadedAt)) patch.key_photo_uploaded_at = input.now
  if (input.lat !== undefined) patch.geo_lat = input.lat
  if (input.lng !== undefined) patch.geo_lng = input.lng
  return patch
}

export function buildKeyPhotoUploadEventPatch(input: {
  statusBefore: any
  statusAfter: any
  keyPhotoUrl?: any
}) {
  const statusBefore = lower(input.statusBefore)
  const statusAfter = keyPhotoUploadStatus(input.statusBefore, input.statusAfter)
  const patch: Record<string, any> = {}
  if (statusAfter && statusAfter !== statusBefore) patch.status = statusAfter
  const keyPhotoUrl = cleanText(input.keyPhotoUrl)
  if (keyPhotoUrl) patch.key_photo_url = keyPhotoUrl
  return patch
}

export async function ensureWorkTaskActionAuditsTable(executor: Queryable | null = pgPool) {
  if (!hasPg || !executor) return
  if (workTaskActionAuditsEnsured) return
  if (workTaskActionAuditsEnsuring) return workTaskActionAuditsEnsuring
  workTaskActionAuditsEnsuring = (async () => {
    await executor.query(`CREATE TABLE IF NOT EXISTS work_task_action_audits (
      id text PRIMARY KEY,
      source_type text NOT NULL,
      source_id text NOT NULL,
      performed_by_user_id text,
      performed_by_name text,
      performed_as_action text NOT NULL,
      performed_at timestamptz NOT NULL DEFAULT now(),
      actor_user_id text,
      status_before text,
      status_after text,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );`)
    await executor.query(`CREATE INDEX IF NOT EXISTS idx_work_task_action_audits_source ON work_task_action_audits(source_type, source_id, performed_at DESC);`)
    await executor.query(`CREATE INDEX IF NOT EXISTS idx_work_task_action_audits_actor ON work_task_action_audits(actor_user_id, performed_at DESC);`)
    await executor.query(`CREATE INDEX IF NOT EXISTS idx_work_task_action_audits_performer ON work_task_action_audits(performed_by_user_id, performed_at DESC);`)
    workTaskActionAuditsEnsured = true
  })()
    .catch((error) => {
      workTaskActionAuditsEnsuring = null
      throw error
    })
    .finally(() => {
      if (workTaskActionAuditsEnsured) workTaskActionAuditsEnsuring = null
    })
  return workTaskActionAuditsEnsuring
}

export async function resolvePerformedByName(userId: string, fallback?: string | null, executor: Queryable | null = pgPool) {
  const explicit = cleanText(fallback)
  if (explicit) return explicit
  const uid = cleanText(userId)
  if (!uid || !hasPg || !executor) return uid || null
  try {
    const r = await executor.query(
      `SELECT COALESCE(
          NULLIF(TRIM(display_name), ''),
          NULLIF(TRIM(username), ''),
          NULLIF(TRIM(legal_name), ''),
          NULLIF(TRIM(email), ''),
          id::text
        ) AS name
       FROM users
       WHERE id::text = $1::text
       LIMIT 1`,
      [uid],
    )
    return cleanText(r?.rows?.[0]?.name) || uid
  } catch {
    return uid
  }
}

export function actorAndPerformerFromRequest(user: any, body: any) {
  const actorUserId = cleanText(user?.sub)
  const performedByUserId = cleanText(body?.performed_by_user_id) || actorUserId
  const performedByName = cleanText(body?.performed_by_name) || null
  return { actorUserId, performedByUserId, performedByName }
}

export async function recordWorkTaskActionAudit(input: WorkTaskActionAuditInput, executor: Queryable | null = pgPool) {
  if (!hasPg || !executor) return null
  const sourceType = cleanText(input.sourceType)
  const sourceId = cleanText(input.sourceId)
  const actorUserId = cleanText(input.actorUserId) || null
  const performedByUserId = cleanText(input.performedByUserId) || actorUserId
  if (!sourceType || !sourceId || !input.performedAsAction) return null
  await ensureWorkTaskActionAuditsTable(executor)
  const performedByName = await resolvePerformedByName(performedByUserId || '', input.performedByName, executor)
  const id = crypto.randomUUID()
  const performedAt = new Date().toISOString()
  await executor.query(
    `INSERT INTO work_task_action_audits (
       id,
       source_type,
       source_id,
       performed_by_user_id,
       performed_by_name,
       performed_as_action,
       performed_at,
       actor_user_id,
       status_before,
       status_after,
       metadata
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
    [
      id,
      sourceType,
      sourceId,
      performedByUserId,
      performedByName,
      input.performedAsAction,
      performedAt,
      actorUserId,
      input.statusBefore == null ? null : cleanText(input.statusBefore),
      input.statusAfter == null ? null : cleanText(input.statusAfter),
      JSON.stringify(input.metadata || {}),
    ],
  )
  return {
    id,
    source_type: sourceType,
    source_id: sourceId,
    performed_by_user_id: performedByUserId,
    performed_by_name: performedByName,
    performed_as_action: input.performedAsAction,
    performed_at: performedAt,
    actor_user_id: actorUserId,
    status_before: input.statusBefore == null ? null : cleanText(input.statusBefore),
    status_after: input.statusAfter == null ? null : cleanText(input.statusAfter),
  }
}

export async function applyCleaningTaskActionTransition(input: CleaningTaskTransitionInput, executor: Queryable | null = pgPool) {
  if (!hasPg || !executor) return { status_before: null, status_after: null, audit: null }
  const taskId = cleanText(input.taskId)
  if (!taskId) return { status_before: null, status_after: null, audit: null }
  await ensureWorkTaskActionAuditsTable(executor)
  const r = await executor.query(
    `SELECT id::text AS id,
            COALESCE(status, '') AS status,
            task_type,
            inspection_scope,
            finished_at
       FROM cleaning_tasks
      WHERE id::text = $1::text
      LIMIT 1`,
    [taskId],
  )
  const row = r?.rows?.[0] || null
  if (!row) return { status_before: null, status_after: null, audit: null }
  const statusBefore = cleanText(row.status)
  const taskType = lower(row.task_type)
  const requiresInspectionPhotos = lower(row.inspection_scope) !== 'password_only'
  const selfCompleteLockboxVideo = input.actionId === 'upload_access_video' && input.metadata?.self_complete_lockbox === true
  const checksInspectionPhotos = !selfCompleteLockboxVideo
    && requiresInspectionPhotos
    && (input.actionId === 'submit_inspection' || input.actionId === 'upload_access_video')
  if (checksInspectionPhotos) await assertCleaningSubmissionReady(taskId, executor)
  const guestArrivalSkip = input.metadata?.guest_arrival_skip === true
  const inspectionPhotosSaved = checksInspectionPhotos ? await hasInspectionPhotoMedia(taskId, executor, guestArrivalSkip) : true
  let statusAfter = resolveCleaningTaskActionStatus({
    actionId: input.actionId,
    statusBefore,
    needsRestock: !!input.needsRestock,
    isStayover: input.isStayover === true || taskType === 'stayover_clean',
    inspectionPhotosSaved,
    isPasswordOnly: !requiresInspectionPhotos,
  })
  let recoveredStatus = ''
  if (input.actionId === 'upload_key_photo' && lower(statusBefore) === 'in_progress') {
    recoveredStatus = await latestCompletedStatusBeforeKeyUpload(taskId, executor)
    statusAfter = keyPhotoUploadStatus(statusBefore, statusAfter, recoveredStatus)
  }
  const finalizationPending = checksInspectionPhotos && !inspectionPhotosSaved
  const missingRequirements = finalizationPending ? ['inspection_photos'] : []
  const patch: Record<string, any> = {}
  if (statusAfter && statusAfter !== statusBefore) patch.status = statusAfter
  if ((input.actionId === 'fill_supplies' || input.actionId === 'complete_cleaning') && !row.finished_at) patch.finished_at = new Date().toISOString()
  if (Object.keys(patch).length) {
    const sets: string[] = []
    const values: any[] = []
    for (const [key, value] of Object.entries(patch)) {
      values.push(value)
      sets.push(`${key} = $${values.length}`)
    }
    values.push(taskId)
    await executor.query(
      `UPDATE cleaning_tasks
          SET ${sets.join(', ')},
              updated_at = now()
        WHERE id::text = $${values.length}::text`,
      values,
    )
  }
  const audit = await recordWorkTaskActionAudit({
    sourceType: 'cleaning_tasks',
    sourceId: taskId,
    performedAsAction: input.actionId,
    actorUserId: input.actorUserId,
    performedByUserId: input.performedByUserId,
    performedByName: input.performedByName,
    statusBefore,
    statusAfter,
    metadata: {
      ...(input.metadata || {}),
      ...(recoveredStatus ? { key_photo_status_recovered_from: recoveredStatus } : {}),
      ...(finalizationPending ? { finalization_pending: true, missing_requirements: missingRequirements } : {}),
    },
  }, executor)
  return {
    status_before: statusBefore || null,
    status_after: statusAfter || null,
    finalization_pending: finalizationPending,
    missing_requirements: missingRequirements,
    audit,
  }
}
