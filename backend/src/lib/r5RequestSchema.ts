import type { NextFunction, Request, Response } from 'express'
import { hasPg, pgPool } from '../dbAdapter'

export const R5_REQUEST_SCHEMA_MIGRATION = '20260902_r5_1_request_schema'

type R5RequestSchemaStatus = 'pending' | 'ready' | 'not_ready'

let r5RequestSchemaStatus: R5RequestSchemaStatus = hasPg ? 'pending' : 'ready'

export class R5RequestSchemaNotReady extends Error {
  constructor() {
    super('r5_request_schema_not_ready')
    this.name = 'R5RequestSchemaNotReady'
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

export function requireR5RequestSchema(_req: Request, res: Response, next: NextFunction) {
  if (isR5RequestSchemaReady()) return next()
  return res.status(503).json({ code: 'r5_request_schema_not_ready' })
}

export function isR5RequestSchemaReady() {
  return !hasPg || r5RequestSchemaStatus === 'ready'
}
