import { hasPg, pgPool } from '../dbAdapter'
import type { WorkTaskActionId } from './workTaskActions'
import crypto from 'crypto'
import { inspectionSubmissionAuditWhereSql } from './cleaningCompletionEvidence'

export type WorkTaskActionAuditInput = {
  sourceType: string
  sourceId: string
  performedAsAction: WorkTaskActionId
  actorUserId: string
  performedByUserId?: string | null
  performedByName?: string | null
  statusBefore?: string | null
  statusAfter?: string | null
  performedAt?: string | null
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
  'inspection_balcony',
  'inspection_shower_drain',
  'inspection_unclean',
]

const PAYABLE_EXECUTION_ACTIONS = new Set<WorkTaskActionId>([
  'fill_supplies',
  'complete_cleaning',
  'submit_inspection',
])

function melbourneDate(value: string) {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Melbourne',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${byType.year}-${byType.month}-${byType.day}`
}

function executionKind(actionId: WorkTaskActionId) {
  return actionId === 'submit_inspection' ? 'inspection' : 'cleaning'
}

/**
 * Freeze the business facts used by settlement before later schedule/status edits
 * can change their meaning. This deliberately lives in the existing immutable
 * action-audit metadata so MZ-031 needs no schema or historical write-back.
 */
export async function buildWorkExecutionSnapshot(input: {
  taskId: string
  actionId: WorkTaskActionId
  performedAt: string
  performedByUserId: string | null
  performedByName: string | null
  statusBefore: string | null
  statusAfter: string | null
  inspectionSubmissionComplete?: boolean
  finalizationPending?: boolean
}, executor: Queryable): Promise<Record<string, any>> {
  if (!PAYABLE_EXECUTION_ACTIONS.has(input.actionId)) return {}
  const kind = executionKind(input.actionId)
  let task: any = null
  let evidence: any[] = []
  try {
    const taskResult = await executor.query(
      `SELECT t.id::text AS task_id,
              t.property_id::text AS property_id,
              COALESCE(NULLIF(TRIM(p.code), ''), NULLIF(TRIM(p.address), ''), t.property_id::text) AS property_label,
              NULLIF(TRIM(p.type), '') AS property_type,
              COALESCE(NULLIF(TRIM(t.task_type), ''), NULLIF(TRIM(t.type), '')) AS task_type,
              COALESCE(t.task_date, t.date)::text AS scheduled_service_date,
              t.inspection_due_date::text AS inspection_due_date,
              t.inspection_mode,
              t.inspection_scope,
              t.assignee_id::text AS assignee_id,
              t.cleaner_id::text AS cleaner_id,
              t.inspector_id::text AS inspector_id
         FROM cleaning_tasks t
         LEFT JOIN properties p ON p.id::text = t.property_id::text OR upper(p.code::text) = upper(t.property_id::text)
        WHERE t.id::text = $1::text
        LIMIT 1`,
      [input.taskId],
    )
    task = taskResult?.rows?.[0] || null
  } catch {
    task = null
  }
  try {
    const mediaTypes = kind === 'inspection'
      ? INSPECTION_PHOTO_MEDIA_TYPES
      : ['consumable_living_room_photo', 'completion_photo', 'key_photo']
    const mediaResult = await executor.query(
      `SELECT id::text AS media_id, type, url, note, captured_at::text, created_at::text
         FROM cleaning_task_media
        WHERE task_id::text = $1::text
          AND (
            type = ANY($2::text[])
            OR ($3::boolean = true AND type LIKE 'completion_%')
          )
          AND COALESCE(TRIM(url), '') <> ''
        ORDER BY captured_at NULLS LAST, created_at, id`,
      [input.taskId, mediaTypes, kind === 'cleaning'],
    )
    evidence = (mediaResult?.rows || []).map((row: any) => ({
      media_id: cleanText(row.media_id) || null,
      type: cleanText(row.type) || null,
      reference_hash: cleanText(row.url)
        ? crypto.createHash('sha256').update(cleanText(row.url)).digest('hex')
        : null,
      note: cleanText(row.note) || null,
      captured_at: cleanText(row.captured_at || row.created_at) || null,
    }))
  } catch {
    evidence = []
  }
  const serviceDate = melbourneDate(input.performedAt)
  return {
    execution_record_version: 'mz031-v1',
    execution_key: `${kind}:${input.taskId}`,
    execution_kind: kind,
    execution_state: input.finalizationPending === true ? 'submitted' : 'completed',
    actual_service_date: serviceDate || null,
    performed_at: input.performedAt,
    performed_by_user_id: input.performedByUserId,
    performed_by_name: input.performedByName,
    status_before_snapshot: input.statusBefore,
    status_after_snapshot: input.statusAfter,
    inspection_submission_complete: input.inspectionSubmissionComplete === true,
    task_snapshot: {
      task_id: input.taskId,
      task_type: cleanText(task?.task_type) || null,
      scheduled_service_date: cleanText(task?.scheduled_service_date).slice(0, 10) || null,
      inspection_due_date: cleanText(task?.inspection_due_date).slice(0, 10) || null,
      inspection_mode: cleanText(task?.inspection_mode) || null,
      inspection_scope: cleanText(task?.inspection_scope) || null,
    },
    property_snapshot: {
      property_id: cleanText(task?.property_id) || null,
      property_label: cleanText(task?.property_label) || null,
      property_type: cleanText(task?.property_type) || null,
    },
    assignment_snapshot: {
      assignee_id: cleanText(task?.assignee_id) || null,
      cleaner_id: cleanText(task?.cleaner_id) || null,
      inspector_id: cleanText(task?.inspector_id) || null,
    },
    evidence_snapshot: evidence,
    evidence_count: evidence.length,
  }
}

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

async function hasLockboxVideoMedia(taskId: string, executor: Queryable) {
  const result = await executor.query(
    `SELECT 1
       FROM cleaning_task_media m
      WHERE m.task_id::text = $1::text
        AND m.type = 'lockbox_video'
        AND COALESCE(TRIM(m.url), '') <> ''
      LIMIT 1`,
    [taskId],
  )
  return !!result?.rows?.length
}

export function isTerminalCleaningStatus(status: any) {
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

function isCleaningCompletionWorkRecordStatus(status: any) {
  return [
    'cleaned',
    'restock_pending',
    'restocked',
    'keys_hung',
    'inspected',
    'ready',
    'completed',
    'done',
    'cancelled',
    'canceled',
  ].includes(lower(status))
}

export function isCleaningAccessVideoWorkRecordStatus(status: any) {
  return ['keys_hung', 'ready', 'completed', 'done'].includes(lower(status))
}

/**
 * A submitted role record is immutable.  The check is actor-scoped so a real
 * reassignment can still produce a new assignee record, while a direct API
 * retry cannot replace the former actor's evidence.  The status fallback
 * protects legacy rows that reached the access-video terminal state before
 * action auditing was introduced.
 */
export async function assertCleaningTaskRoleRecordMutable(input: {
  taskId: string
  actionId: WorkTaskActionId
  actorUserId?: string | null
  performedByUserId?: string | null
  statusBefore?: string | null
}, executor: Queryable) {
  const taskId = cleanText(input.taskId)
  const actorUserId = cleanText(input.actorUserId) || cleanText(input.performedByUserId)
  if (!taskId) return
  if (input.actionId === 'upload_key_photo' && isDoneLikeCleaningStatus(input.statusBefore)) {
    throw Object.assign(new Error('work_record_read_only'), {
      code: 'work_record_read_only',
      statusCode: 409,
    })
  }
  if (input.actionId === 'complete_cleaning' && isCleaningCompletionWorkRecordStatus(input.statusBefore)) {
    throw Object.assign(new Error('work_record_read_only'), {
      code: 'work_record_read_only',
      statusCode: 409,
    })
  }
  if (input.actionId === 'upload_access_video' && isCleaningAccessVideoWorkRecordStatus(input.statusBefore)) {
    throw Object.assign(new Error('work_record_read_only'), {
      code: 'work_record_read_only',
      statusCode: 409,
    })
  }

  const terminalActions = input.actionId === 'upload_key_photo'
    ? ['fill_supplies', 'complete_cleaning']
    : ['fill_supplies', 'complete_cleaning', 'submit_inspection', 'upload_access_video'].includes(input.actionId)
      ? [input.actionId]
      : []
  if (!actorUserId || !terminalActions.length) return
  const previous = await executor.query(
    `SELECT 1
       FROM work_task_action_audits audit
      WHERE audit.source_type = 'cleaning_tasks'
        AND audit.source_id::text = $1::text
        AND audit.performed_as_action = ANY($2::text[])
        AND COALESCE(NULLIF(audit.actor_user_id::text, ''), audit.performed_by_user_id::text) = $3::text
        AND (${input.actionId === 'submit_inspection' ? inspectionSubmissionAuditWhereSql('audit') : 'TRUE'})
      LIMIT 1`,
    [taskId, terminalActions, actorUserId],
  )
  if (previous?.rowCount) {
    throw Object.assign(new Error('work_record_read_only'), {
      code: 'work_record_read_only',
      statusCode: 409,
    })
  }
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
        AND (
          performed_as_action <> 'submit_inspection'
          OR ${inspectionSubmissionAuditWhereSql('work_task_action_audits')}
        )
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
  isCheckinInspectAndHang?: boolean
}) {
  const current = lower(input.statusBefore)
  if (isTerminalCleaningStatus(current)) return current || null
  if (input.actionId === 'upload_key_photo') return current && isDoneLikeCleaningStatus(current) ? current : 'in_progress'
  if (input.actionId === 'fill_supplies') return input.needsRestock ? 'restock_pending' : 'cleaned'
  if (input.actionId === 'complete_cleaning') return input.isStayover ? 'cleaned' : (input.needsRestock ? 'restock_pending' : 'cleaned')
  if (input.actionId === 'submit_inspection') {
    if (input.inspectionPhotosSaved === false) return current || null
    return input.isCheckinInspectAndHang ? 'to_hang_keys' : 'inspected'
  }
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
  // Field clients still send these legacy keys, but a field action must never
  // be able to redirect settlement credit or forge a display name.  A future
  // managed on-behalf-of flow needs its own permission and server-side target
  // validation; ordinary task endpoints always credit the authenticated actor.
  void body
  return { actorUserId, performedByUserId: actorUserId, performedByName: null }
}

export async function recordWorkTaskActionAudit(input: WorkTaskActionAuditInput, executor: Queryable | null = pgPool) {
  if (!hasPg || !executor) return null
  const sourceType = cleanText(input.sourceType)
  const sourceId = cleanText(input.sourceId)
  const actorUserId = cleanText(input.actorUserId) || null
  const performedByUserId = cleanText(input.performedByUserId) || actorUserId
  if (!sourceType || !sourceId || !input.performedAsAction) return null
  const performedByName = await resolvePerformedByName(performedByUserId || '', input.performedByName, executor)
  const id = crypto.randomUUID()
  const performedAt = cleanText(input.performedAt) || new Date().toISOString()
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
  const r = await executor.query(
    `SELECT id::text AS id,
            COALESCE(status, '') AS status,
            task_type,
            inspection_scope,
            inspection_mode,
            finished_at
       FROM cleaning_tasks
      WHERE id::text = $1::text
      LIMIT 1
      FOR UPDATE`,
    [taskId],
  )
  const row = r?.rows?.[0] || null
  if (!row) return { status_before: null, status_after: null, audit: null }
  const statusBefore = cleanText(row.status)
  if (lower(statusBefore) === 'cancelled' || lower(statusBefore) === 'canceled') {
    throw new Error('task_is_cancelled')
  }
  await assertCleaningTaskRoleRecordMutable({
    taskId,
    actionId: input.actionId,
    actorUserId: input.actorUserId,
    performedByUserId: input.performedByUserId,
    statusBefore,
  }, executor)
  const taskType = lower(row.task_type)
  const requiresInspectionPhotos = lower(row.inspection_scope) !== 'password_only'
  const isCheckinInspectAndHang = taskType === 'checkin_clean' && requiresInspectionPhotos
  const selfCompleteLockboxVideo = input.actionId === 'upload_access_video' && input.metadata?.self_complete_lockbox === true
  const checksInspectionPhotos = !selfCompleteLockboxVideo
    && requiresInspectionPhotos
    && (input.actionId === 'submit_inspection' || input.actionId === 'upload_access_video')
  const guestArrivalSkip = input.metadata?.guest_arrival_skip === true
  const regularCheckoutInspection = requiresInspectionPhotos
    && taskType !== 'checkin_clean'
    && lower(row.inspection_mode) !== 'self_complete'
    && !selfCompleteLockboxVideo
  const evaluatesSharedFinalization = regularCheckoutInspection
    && ['submit_inspection', 'upload_access_video', 'fill_supplies'].includes(input.actionId)
  const cleaningSubmission = evaluatesSharedFinalization
    ? await getCleaningSubmissionState(taskId, executor)
    : null
  const inspectionPhotosSaved = (checksInspectionPhotos || evaluatesSharedFinalization)
    ? await hasInspectionPhotoMedia(taskId, executor, guestArrivalSkip)
    : true
  let statusAfter = resolveCleaningTaskActionStatus({
    actionId: input.actionId,
    statusBefore,
    needsRestock: !!input.needsRestock,
    isStayover: input.isStayover === true || taskType === 'stayover_clean',
    inspectionPhotosSaved,
    isPasswordOnly: !requiresInspectionPhotos,
    isCheckinInspectAndHang,
  })
  let recoveredStatus = ''
  if (input.actionId === 'upload_key_photo' && lower(statusBefore) === 'in_progress') {
    recoveredStatus = await latestCompletedStatusBeforeKeyUpload(taskId, executor)
    statusAfter = keyPhotoUploadStatus(statusBefore, statusAfter, recoveredStatus)
  }
  let finalizationPending = checksInspectionPhotos && !inspectionPhotosSaved
  let missingRequirements = finalizationPending ? ['inspection_photos'] : []
  if (regularCheckoutInspection && (input.actionId === 'submit_inspection' || input.actionId === 'upload_access_video')) {
    missingRequirements = [
      ...(!cleaningSubmission?.consumables_submitted ? ['cleaning_consumables'] : []),
      ...(!cleaningSubmission?.property_photo_submitted ? ['cleaning_property_photo'] : []),
      ...(!inspectionPhotosSaved ? ['inspection_photos'] : []),
    ]
    finalizationPending = missingRequirements.length > 0
    if (finalizationPending) {
      // Inspection evidence is saved independently. Do not advance the shared
      // task to an inspector terminal status until the cleaner's evidence exists.
      statusAfter = statusBefore || null
    }
  }
  if (
    input.actionId === 'submit_inspection'
    && requiresInspectionPhotos
    && inspectionPhotosSaved
    && !finalizationPending
    && await hasLockboxVideoMedia(taskId, executor)
  ) {
    // A weak-network queue can save the exact-task lockbox video before its
    // inspection-photo business record.  When the photos later succeed, keep
    // that already-saved handover fact instead of regressing to `inspected`.
    statusAfter = 'keys_hung'
  }
  if (
    regularCheckoutInspection
    && input.actionId === 'fill_supplies'
    && cleaningSubmission?.ready
    && inspectionPhotosSaved
    && !input.needsRestock
    && await hasLockboxVideoMedia(taskId, executor)
  ) {
    // The cleaner can be the last writer. Reconcile already-saved inspection
    // evidence here so the task does not stay open merely because it arrived first.
    statusAfter = 'keys_hung'
  }
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
  const performedAt = new Date().toISOString()
  const performedByUserId = cleanText(input.performedByUserId) || cleanText(input.actorUserId) || null
  const performedByName = await resolvePerformedByName(performedByUserId || '', input.performedByName, executor)
  const executionSnapshot = await buildWorkExecutionSnapshot({
    taskId,
    actionId: input.actionId,
    performedAt,
    performedByUserId,
    performedByName,
    statusBefore: statusBefore || null,
    statusAfter: statusAfter || null,
    inspectionSubmissionComplete: input.actionId === 'submit_inspection' && inspectionPhotosSaved,
    finalizationPending,
  }, executor)
  const audit = await recordWorkTaskActionAudit({
    sourceType: 'cleaning_tasks',
    sourceId: taskId,
    performedAsAction: input.actionId,
    actorUserId: input.actorUserId,
    performedByUserId,
    performedByName,
    statusBefore,
    statusAfter,
    performedAt,
    metadata: {
      ...(input.metadata || {}),
      ...executionSnapshot,
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
