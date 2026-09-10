import { hasPg, pgPool } from '../dbAdapter'

export const PROPERTY_GUIDE_RUNTIME_SCHEMA_MIGRATION = '20260910_r5_2b_property_guides_schema'

type PropertyGuideRuntimeSchemaStatus = 'pending' | 'ready' | 'not_ready'

let propertyGuideRuntimeSchemaStatus: PropertyGuideRuntimeSchemaStatus = hasPg ? 'pending' : 'ready'

export class PropertyGuideRuntimeSchemaNotReady extends Error {
  readonly code = 'property_guide_runtime_schema_not_ready'
  readonly status = 503

  constructor() {
    super('property_guide_runtime_schema_not_ready')
    this.name = 'PropertyGuideRuntimeSchemaNotReady'
  }
}

/**
 * Property Guide migrations own every CREATE/ALTER/INDEX operation. Startup
 * reads the fixed migration marker once; HTTP and task-list paths use only the
 * retained in-memory result and never inspect or repair schema themselves.
 */
export async function warmupPropertyGuideRuntimeSchema() {
  if (!hasPg) {
    propertyGuideRuntimeSchemaStatus = 'ready'
    return
  }
  if (!pgPool) {
    propertyGuideRuntimeSchemaStatus = 'not_ready'
    throw new PropertyGuideRuntimeSchemaNotReady()
  }
  try {
    const result = await pgPool.query(
      'SELECT 1 FROM schema_migrations WHERE version=$1 LIMIT 1',
      [PROPERTY_GUIDE_RUNTIME_SCHEMA_MIGRATION],
    )
    if (!result?.rowCount) throw new PropertyGuideRuntimeSchemaNotReady()
    propertyGuideRuntimeSchemaStatus = 'ready'
  } catch (error) {
    propertyGuideRuntimeSchemaStatus = 'not_ready'
    if (error instanceof PropertyGuideRuntimeSchemaNotReady) throw error
    throw new PropertyGuideRuntimeSchemaNotReady()
  }
}

export function isPropertyGuideRuntimeSchemaReady() {
  return !hasPg || propertyGuideRuntimeSchemaStatus === 'ready'
}

export function assertPropertyGuideRuntimeSchemaReady() {
  if (isPropertyGuideRuntimeSchemaReady()) return
  throw new PropertyGuideRuntimeSchemaNotReady()
}
