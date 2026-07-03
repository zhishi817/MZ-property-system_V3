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

function cleanText(value: any) {
  return String(value ?? '').trim()
}

function lower(value: any) {
  return cleanText(value).toLowerCase()
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

export function resolveCleaningTaskActionStatus(input: {
  actionId: WorkTaskActionId
  statusBefore: string
  needsRestock?: boolean
  isStayover?: boolean
}) {
  const current = lower(input.statusBefore)
  if (isTerminalCleaningStatus(current)) return current || null
  if (input.actionId === 'upload_key_photo') return current && isDoneLikeCleaningStatus(current) ? current : 'in_progress'
  if (input.actionId === 'fill_supplies') return input.needsRestock ? 'restock_pending' : 'cleaned'
  if (input.actionId === 'complete_cleaning') return input.isStayover ? 'cleaned' : (input.needsRestock ? 'restock_pending' : 'cleaned')
  if (input.actionId === 'submit_inspection') return 'inspected'
  if (input.actionId === 'upload_access_video') return 'keys_hung'
  return current || null
}

export async function ensureWorkTaskActionAuditsTable(executor: Queryable | null = pgPool) {
  if (!hasPg || !executor) return
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
  const statusAfter = resolveCleaningTaskActionStatus({
    actionId: input.actionId,
    statusBefore,
    needsRestock: !!input.needsRestock,
    isStayover: input.isStayover === true || taskType === 'stayover_clean',
  })
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
    metadata: input.metadata || null,
  }, executor)
  return { status_before: statusBefore || null, status_after: statusAfter || null, audit }
}
