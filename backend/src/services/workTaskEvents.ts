import type { Request, Response } from 'express'
import jwt from 'jsonwebtoken'
import { v4 as uuid } from 'uuid'
import { hasPg, pgPool } from '../dbAdapter'

export type WorkTaskEventType =
  | 'TASK_CREATED'
  | 'TASK_UPDATED'
  | 'TASK_REMOVED'
  | 'TASK_ASSIGNMENT_CHANGED'
  | 'TASK_COMPLETED'
  | 'TASK_DETAIL_ASSET_CHANGED'

export type WorkTaskChangeScope = 'list' | 'detail' | 'membership'

type DbExecutor = { query: (sql: string, params?: any[]) => Promise<any> }

type WorkTaskEventRow = {
  id: string
  event_id: string
  sequence_no: string | number
  task_id: string
  task_version: string | number
  source_type: string
  source_ref_ids: string[] | null
  event_type: WorkTaskEventType
  change_scope: WorkTaskChangeScope
  changed_fields: string[] | null
  payload: any
  occurred_at: string
  caused_by_user_id: string | null
  visibility_hints: any
  created_at: string
}

export type WorkTaskEvent = {
  id: string
  event_id: string
  sequence_no: number
  task_id: string
  task_version: number
  source_type: string
  source_ref_ids: string[]
  event_type: WorkTaskEventType
  change_scope: WorkTaskChangeScope
  changed_fields: string[]
  payload: Record<string, any>
  occurred_at: string
  caused_by_user_id: string | null
  visibility_hints: Record<string, any> | null
  created_at: string
}

export type EmitWorkTaskEventInput = {
  taskId: string
  sourceType: string
  sourceRefIds?: string[]
  eventType: WorkTaskEventType
  changeScope: WorkTaskChangeScope
  changedFields?: string[]
  patch?: Record<string, any> | null
  payload?: Record<string, any> | null
  occurredAt?: string
  causedByUserId?: string | null
  visibilityHints?: Record<string, any> | null
}

type SSEClient = {
  req: Request
  res: Response
  user: any
  pingTimer: NodeJS.Timeout
}

const DEFAULT_RESYNC_GAP = 100
const PING_INTERVAL_MS = 25000
const SECRET = process.env.JWT_SECRET || 'dev-secret'
const clients = new Set<SSEClient>()
let schemaEnsured = false
let schemaEnsuring: Promise<void> | null = null
let listenerStarted = false
let listenerStarting: Promise<void> | null = null

function roleNamesOf(user: any) {
  const values = Array.isArray(user?.roles) ? user.roles : []
  const ids: string[] = values.map((x: any) => String(x || '').trim()).filter(Boolean)
  const primary = String(user?.role || '').trim()
  if (primary) ids.unshift(primary)
  return Array.from(new Set(ids)) as string[]
}

function getUserId(user: any) {
  const id = String(user?.sub || user?.id || '').trim()
  return id || null
}

function toArray(values: any): string[] {
  if (!Array.isArray(values)) return []
  return Array.from(new Set(values.map((x) => String(x || '').trim()).filter(Boolean)))
}

function readAccessToken(req: Request) {
  const h = String(req.headers.authorization || '').trim()
  if (/^bearer\s+/i.test(h)) return h.replace(/^bearer\s+/i, '').trim()
  const queryToken = String((req.query as any)?.access_token || '').trim()
  if (queryToken) return queryToken
  return ''
}

function resolveRequestUser(req: Request) {
  const existing = (req as any).user
  if (existing) return existing
  const token = readAccessToken(req)
  if (!token) return null
  try {
    const decoded = jwt.verify(token, SECRET)
    ;(req as any).user = decoded
    return decoded
  } catch {
    return null
  }
}

function normalizeEvent(row: WorkTaskEventRow): WorkTaskEvent {
  return {
    id: String(row.id || ''),
    event_id: String(row.event_id || ''),
    sequence_no: Number(row.sequence_no || 0),
    task_id: String(row.task_id || ''),
    task_version: Number(row.task_version || 0),
    source_type: String(row.source_type || ''),
    source_ref_ids: toArray(row.source_ref_ids),
    event_type: row.event_type,
    change_scope: row.change_scope,
    changed_fields: toArray(row.changed_fields),
    payload: row.payload && typeof row.payload === 'object' ? row.payload : {},
    occurred_at: String(row.occurred_at || ''),
    caused_by_user_id: row.caused_by_user_id ? String(row.caused_by_user_id) : null,
    visibility_hints: row.visibility_hints && typeof row.visibility_hints === 'object' ? row.visibility_hints : null,
    created_at: String(row.created_at || ''),
  }
}

async function ensureWorkTaskEventSchemaInternal(executor: DbExecutor) {
  await executor.query(`CREATE SEQUENCE IF NOT EXISTS work_task_events_sequence_no_seq AS bigint;`)
  await executor.query(`CREATE TABLE IF NOT EXISTS work_task_event_versions (
    task_id text PRIMARY KEY,
    last_version bigint NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now()
  );`)
  await executor.query(`CREATE TABLE IF NOT EXISTS work_task_events (
    id text PRIMARY KEY,
    event_id text NOT NULL UNIQUE,
    sequence_no bigint NOT NULL UNIQUE,
    task_id text NOT NULL,
    task_version bigint NOT NULL,
    source_type text NOT NULL,
    source_ref_ids text[] NOT NULL DEFAULT '{}',
    event_type text NOT NULL,
    change_scope text NOT NULL,
    changed_fields text[] NOT NULL DEFAULT '{}',
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    occurred_at timestamptz NOT NULL,
    caused_by_user_id text,
    visibility_hints jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
  );`)
  await executor.query(`CREATE INDEX IF NOT EXISTS idx_work_task_events_sequence_no ON work_task_events(sequence_no);`)
  await executor.query(`CREATE INDEX IF NOT EXISTS idx_work_task_events_task_id_version ON work_task_events(task_id, task_version);`)
  await executor.query(`CREATE INDEX IF NOT EXISTS idx_work_task_events_occurred_at ON work_task_events(occurred_at DESC);`)
}

export async function ensureWorkTaskEventSchema() {
  if (!hasPg || !pgPool) return
  if (schemaEnsured) return
  if (schemaEnsuring) return schemaEnsuring
  schemaEnsuring = (async () => {
    await ensureWorkTaskEventSchemaInternal(pgPool)
    schemaEnsured = true
    schemaEnsuring = null
  })().catch((error) => {
    schemaEnsuring = null
    throw error
  })
  return schemaEnsuring
}

function writeSSE(res: Response, event: string, data: any, id?: string) {
  if (id) res.write(`id: ${id}\n`)
  res.write(`event: ${event}\n`)
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

function isVisibleToUser(event: WorkTaskEvent, user: any) {
  const roles: string[] = roleNamesOf(user)
  const userId = getUserId(user)
  const hints = event.visibility_hints || {}
  const userIds = toArray(hints.user_ids)
  const roleNames = toArray(hints.role_names)
  if (roles.some((role) => roleNames.includes(role))) return true
  if (userId && userIds.includes(userId)) return true
  return false
}

async function fetchEventById(eventId: string) {
  if (!hasPg || !pgPool) return null
  await ensureWorkTaskEventSchema()
  const result = await pgPool.query(`SELECT * FROM work_task_events WHERE event_id = $1 LIMIT 1`, [eventId])
  const row = result?.rows?.[0]
  return row ? normalizeEvent(row) : null
}

async function fetchEventsAfterSequence(sequenceNo: number, limit: number) {
  if (!hasPg || !pgPool) return []
  await ensureWorkTaskEventSchema()
  const result = await pgPool.query(
    `SELECT * FROM work_task_events WHERE sequence_no > $1 ORDER BY sequence_no ASC LIMIT $2`,
    [sequenceNo, limit],
  )
  return (result?.rows || []).map(normalizeEvent)
}

async function countEventsAfterSequence(sequenceNo: number) {
  if (!hasPg || !pgPool) return 0
  await ensureWorkTaskEventSchema()
  const result = await pgPool.query(`SELECT COUNT(*)::int AS count FROM work_task_events WHERE sequence_no > $1`, [sequenceNo])
  return Number(result?.rows?.[0]?.count || 0)
}

function broadcastEvent(event: WorkTaskEvent) {
  for (const client of clients) {
    try {
      if (!isVisibleToUser(event, client.user)) continue
      writeSSE(client.res, 'work_task_event', event, event.event_id)
    } catch {}
  }
}

async function startListenerInternal() {
  if (!hasPg || !pgPool) return
  const client = await pgPool.connect()
  const listen = async () => {
    await client.query('LISTEN work_task_events')
  }
  client.on('notification', async (message: any) => {
    const eventId = String(message?.payload || '').trim()
    if (!eventId) return
    try {
      const event = await fetchEventById(eventId)
      if (event) broadcastEvent(event)
    } catch (error: any) {
      try { console.error(`[work-task-events] broadcast_failed message=${String(error?.message || '')}`) } catch {}
    }
  })
  client.on('error', async (error: any) => {
    try { console.error(`[work-task-events] listener_error message=${String(error?.message || '')}`) } catch {}
    listenerStarted = false
    listenerStarting = null
    try { client.release() } catch {}
    setTimeout(() => { void startWorkTaskEventListener() }, 1000)
  })
  await listen()
  listenerStarted = true
}

export async function startWorkTaskEventListener() {
  if (!hasPg || !pgPool) return
  await ensureWorkTaskEventSchema()
  if (listenerStarted) return
  if (listenerStarting) return listenerStarting
  listenerStarting = startListenerInternal()
    .then(() => {
      listenerStarting = null
    })
    .catch((error) => {
      listenerStarting = null
      listenerStarted = false
      throw error
    })
  return listenerStarting
}

export async function emitWorkTaskEvent(input: EmitWorkTaskEventInput, client?: DbExecutor) {
  if (!hasPg || !pgPool) return null
  const executor = client || pgPool
  await ensureWorkTaskEventSchemaInternal(executor)
  const eventId = uuid()
  const id = uuid()
  const occurredAt = input.occurredAt || new Date().toISOString()
  const versionResult = await executor.query(
    `INSERT INTO work_task_event_versions(task_id, last_version)
     VALUES($1, 1)
     ON CONFLICT (task_id) DO UPDATE SET last_version = work_task_event_versions.last_version + 1, updated_at = now()
     RETURNING last_version`,
    [input.taskId],
  )
  const taskVersion = Number(versionResult?.rows?.[0]?.last_version || 1)
  const seqResult = await executor.query(`SELECT nextval('work_task_events_sequence_no_seq') AS sequence_no`)
  const sequenceNo = Number(seqResult?.rows?.[0]?.sequence_no || 0)
  const payload = {
    task_id: input.taskId,
    source_type: input.sourceType,
    source_ref_ids: toArray(input.sourceRefIds),
    event_type: input.eventType,
    change_scope: input.changeScope,
    changed_fields: toArray(input.changedFields),
    patch: input.patch && typeof input.patch === 'object' ? input.patch : {},
    ...(input.payload && typeof input.payload === 'object' ? input.payload : {}),
    occurred_at: occurredAt,
    task_version: taskVersion,
    sequence_no: sequenceNo,
  }
  await executor.query(
    `INSERT INTO work_task_events(
      id, event_id, sequence_no, task_id, task_version, source_type, source_ref_ids,
      event_type, change_scope, changed_fields, payload, occurred_at, caused_by_user_id, visibility_hints
    ) VALUES($1,$2,$3,$4,$5,$6,$7::text[],$8,$9,$10::text[],$11::jsonb,$12::timestamptz,$13,$14::jsonb)`,
    [
      id,
      eventId,
      sequenceNo,
      input.taskId,
      taskVersion,
      input.sourceType,
      toArray(input.sourceRefIds),
      input.eventType,
      input.changeScope,
      toArray(input.changedFields),
      JSON.stringify(payload),
      occurredAt,
      input.causedByUserId || null,
      input.visibilityHints ? JSON.stringify(input.visibilityHints) : null,
    ],
  )
  await executor.query(`SELECT pg_notify('work_task_events', $1)`, [eventId])
  return {
    eventId,
    sequenceNo,
    taskVersion,
  }
}

export async function streamWorkTaskEvents(req: Request, res: Response) {
  if (!hasPg || !pgPool) return res.status(503).json({ message: 'pg_not_available' })
  const user = resolveRequestUser(req)
  if (!user) return res.status(401).json({ message: 'unauthorized' })

  await ensureWorkTaskEventSchema()
  await startWorkTaskEventListener()

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders?.()

  const pingTimer = setInterval(() => {
    try {
      writeSSE(res, 'ping', { t: Date.now() })
    } catch {}
  }, PING_INTERVAL_MS)

  const client: SSEClient = { req, res, user, pingTimer }
  clients.add(client)

  const cleanup = () => {
    clearInterval(pingTimer)
    clients.delete(client)
  }
  req.on('close', cleanup)
  req.on('end', cleanup)

  writeSSE(res, 'connected', { ok: true, t: Date.now() })

  const lastEventIdHeader = String(req.headers['last-event-id'] || '').trim()
  const lastEventIdQuery = String((req.query as any)?.last_event_id || '').trim()
  const lastEventId = lastEventIdHeader || lastEventIdQuery
  if (!lastEventId) return

  const previous = await fetchEventById(lastEventId)
  if (!previous) {
    writeSSE(res, 'resync_required', { reason: 'last_event_id_not_found', last_event_id: lastEventId })
    return
  }

  const gap = await countEventsAfterSequence(previous.sequence_no)
  if (gap > DEFAULT_RESYNC_GAP) {
    writeSSE(res, 'resync_required', {
      reason: 'gap_too_large',
      last_event_id: lastEventId,
      gap,
      threshold: DEFAULT_RESYNC_GAP,
    })
    return
  }

  const events = await fetchEventsAfterSequence(previous.sequence_no, DEFAULT_RESYNC_GAP)
  for (const event of events) {
    if (!isVisibleToUser(event, user)) continue
    writeSSE(res, 'work_task_event', event, event.event_id)
  }
}

export function buildWorkTaskVisibilityHints(row: any) {
  const userIds = toArray([row?.assignee_id])
  return {
    user_ids: userIds,
    role_names: ['admin', 'offline_manager', 'customer_service'],
  }
}

export function buildCleaningTaskVisibilityHints(row: any) {
  const userIds = toArray([row?.assignee_id, row?.cleaner_id, row?.inspector_id])
  return {
    user_ids: userIds,
    role_names: ['admin', 'offline_manager', 'customer_service'],
  }
}
