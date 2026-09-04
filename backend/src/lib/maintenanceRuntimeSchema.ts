import { hasPg, pgPool } from '../dbAdapter'

export const MAINTENANCE_RUNTIME_SCHEMA_MIGRATION = '20260903_maintenance_runtime_schema'

type RuntimeSchemaStatus = 'pending' | 'ready' | 'not_ready'

let maintenanceRuntimeSchemaStatus: RuntimeSchemaStatus = hasPg ? 'pending' : 'ready'

export class MaintenanceRuntimeSchemaNotReady extends Error {
  constructor() {
    super('maintenance_runtime_schema_not_ready')
    this.name = 'MaintenanceRuntimeSchemaNotReady'
  }
}

type SqlClient = {
  query: (sql: string, params?: any[]) => Promise<unknown>
}

/**
 * The migration marker is checked at startup. Request paths only read this
 * in-memory readiness state and never attempt schema changes themselves.
 */
export async function warmupMaintenanceRuntimeSchema() {
  if (!hasPg) {
    maintenanceRuntimeSchemaStatus = 'ready'
    return
  }
  if (!pgPool) {
    maintenanceRuntimeSchemaStatus = 'not_ready'
    throw new MaintenanceRuntimeSchemaNotReady()
  }
  try {
    const result = await pgPool.query(
      'SELECT 1 FROM schema_migrations WHERE version=$1 LIMIT 1',
      [MAINTENANCE_RUNTIME_SCHEMA_MIGRATION],
    )
    if (!result.rowCount) throw new MaintenanceRuntimeSchemaNotReady()
    maintenanceRuntimeSchemaStatus = 'ready'
  } catch (error) {
    maintenanceRuntimeSchemaStatus = 'not_ready'
    if (error instanceof MaintenanceRuntimeSchemaNotReady) throw error
    throw new MaintenanceRuntimeSchemaNotReady()
  }
}

export function isMaintenanceRuntimeSchemaReady() {
  return !hasPg || maintenanceRuntimeSchemaStatus === 'ready'
}

export function assertMaintenanceRuntimeSchemaReady() {
  if (!isMaintenanceRuntimeSchemaReady()) throw new MaintenanceRuntimeSchemaNotReady()
}

export async function assertMaintenanceShareLinksSchemaReady(client: SqlClient) {
  assertMaintenanceRuntimeSchemaReady()
  try {
    await client.query(
      `SELECT token_hash, maintenance_id, created_at, expires_at, revoked_at
         FROM maintenance_share_links
        LIMIT 0`,
    )
  } catch {
    throw new MaintenanceRuntimeSchemaNotReady()
  }
}
