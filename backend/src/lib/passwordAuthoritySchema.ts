import type { NextFunction, Request, Response } from 'express'
import { hasPg, pgPool } from '../dbAdapter'

export const PASSWORD_AUTHORITY_SCHEMA_MIGRATION = '20261101_mz091_password_authority'

type PasswordAuthoritySchemaStatus = 'pending' | 'ready' | 'not_ready'

let passwordAuthoritySchemaStatus: PasswordAuthoritySchemaStatus = hasPg ? 'pending' : 'ready'

export class PasswordAuthoritySchemaNotReady extends Error {
  readonly code = 'password_authority_schema_not_ready'
  readonly status = 503

  constructor() {
    super('password_authority_schema_not_ready')
    this.name = 'PasswordAuthoritySchemaNotReady'
  }
}

export async function warmupPasswordAuthoritySchema() {
  if (!hasPg) {
    passwordAuthoritySchemaStatus = 'ready'
    return
  }
  if (!pgPool) {
    passwordAuthoritySchemaStatus = 'not_ready'
    throw new PasswordAuthoritySchemaNotReady()
  }
  try {
    const result = await pgPool.query(
      'SELECT 1 FROM schema_migrations WHERE version=$1 LIMIT 1',
      [PASSWORD_AUTHORITY_SCHEMA_MIGRATION],
    )
    if (!result?.rowCount) throw new PasswordAuthoritySchemaNotReady()
    passwordAuthoritySchemaStatus = 'ready'
  } catch (error) {
    passwordAuthoritySchemaStatus = 'not_ready'
    if (error instanceof PasswordAuthoritySchemaNotReady) throw error
    throw new PasswordAuthoritySchemaNotReady()
  }
}

export function isPasswordAuthoritySchemaReady() {
  return !hasPg || passwordAuthoritySchemaStatus === 'ready'
}

export function assertPasswordAuthoritySchemaReady() {
  if (isPasswordAuthoritySchemaReady()) return
  throw new PasswordAuthoritySchemaNotReady()
}

export function requirePasswordAuthoritySchema(req: Request, res: Response, next: NextFunction) {
  if (!(req as any).user) return next()
  if (isPasswordAuthoritySchemaReady()) return next()
  return res.status(503).json({ code: 'password_authority_schema_not_ready' })
}
