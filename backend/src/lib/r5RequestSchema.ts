import type { NextFunction, Request, Response } from 'express'
import { hasPg, pgPool } from '../dbAdapter'

export const R5_REQUEST_SCHEMA_MIGRATION = '20260902_r5_1_request_schema'
export const R5_TASK_RUNTIME_SCHEMA_MIGRATION = '20260902_r5_2a_core_task_schema'

type R5RequestSchemaStatus = 'pending' | 'ready' | 'not_ready'

let r5RequestSchemaStatus: R5RequestSchemaStatus = hasPg ? 'pending' : 'ready'
let r5TaskRuntimeSchemaStatus: R5RequestSchemaStatus = hasPg ? 'pending' : 'ready'

export class R5RequestSchemaNotReady extends Error {
  constructor() {
    super('r5_request_schema_not_ready')
    this.name = 'R5RequestSchemaNotReady'
  }
}

export class R5TaskRuntimeSchemaNotReady extends Error {
  readonly code = 'r5_task_runtime_schema_not_ready'
  readonly status = 503

  constructor() {
    super('r5_task_runtime_schema_not_ready')
    this.name = 'R5TaskRuntimeSchemaNotReady'
  }
}

/**
 * The controlled migration owns DDL. A process checks one fixed migration
 * marker during startup; request paths never inspect or mutate the schema.
 */
export async function warmupR5RequestSchema() {
  if (!hasPg) {
    r5RequestSchemaStatus = 'ready'
    return
  }
  if (!pgPool) {
    r5RequestSchemaStatus = 'not_ready'
    throw new R5RequestSchemaNotReady()
  }
  try {
    const result = await pgPool.query(
      'SELECT 1 FROM schema_migrations WHERE version=$1 LIMIT 1',
      [R5_REQUEST_SCHEMA_MIGRATION],
    )
    if (!result?.rowCount) throw new R5RequestSchemaNotReady()
    r5RequestSchemaStatus = 'ready'
  } catch (error) {
    r5RequestSchemaStatus = 'not_ready'
    if (error instanceof R5RequestSchemaNotReady) throw error
    throw new R5RequestSchemaNotReady()
  }
}

/**
 * R5-2A uses the same startup-only marker pattern as R5-1. The result is
 * retained in memory so task HTTP, cron, worker, SSE and event paths do not
 * add another readiness query to their normal database traffic.
 */
export async function warmupR5TaskRuntimeSchema() {
  if (!hasPg) {
    r5TaskRuntimeSchemaStatus = 'ready'
    return
  }
  if (!pgPool) {
    r5TaskRuntimeSchemaStatus = 'not_ready'
    throw new R5TaskRuntimeSchemaNotReady()
  }
  try {
    const result = await pgPool.query(
      'SELECT 1 FROM schema_migrations WHERE version=$1 LIMIT 1',
      [R5_TASK_RUNTIME_SCHEMA_MIGRATION],
    )
    if (!result?.rowCount) throw new R5TaskRuntimeSchemaNotReady()
    r5TaskRuntimeSchemaStatus = 'ready'
  } catch (error) {
    r5TaskRuntimeSchemaStatus = 'not_ready'
    if (error instanceof R5TaskRuntimeSchemaNotReady) throw error
    throw new R5TaskRuntimeSchemaNotReady()
  }
}

export function requireR5RequestSchema(_req: Request, res: Response, next: NextFunction) {
  if (isR5RequestSchemaReady()) return next()
  return res.status(503).json({ code: 'r5_request_schema_not_ready' })
}

export function isR5RequestSchemaReady() {
  return !hasPg || r5RequestSchemaStatus === 'ready'
}

export function requireR5TaskRuntimeSchema(req: Request, res: Response, next: NextFunction) {
  // app.use(auth) hydrates identity but deliberately lets anonymous requests
  // reach their route-level 401/permission middleware.  Preserve that existing
  // authorization result instead of leaking task-schema marker state first.
  if (!(req as any).user) return next()
  if (isR5TaskRuntimeSchemaReady()) return next()
  return res.status(503).json({ code: 'r5_task_runtime_schema_not_ready' })
}

export function assertR5TaskRuntimeSchemaReady() {
  if (isR5TaskRuntimeSchemaReady()) return
  throw new R5TaskRuntimeSchemaNotReady()
}

export function isR5TaskRuntimeSchemaReady() {
  return !hasPg || r5TaskRuntimeSchemaStatus === 'ready'
}
