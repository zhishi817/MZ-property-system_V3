import { hasPg, pgPool } from '../dbAdapter'

export const PERSONNEL_SETTLEMENT_PHASE5_SCHEMA_MIGRATION = '20260911_personnel_settlement_phase5'

type Queryable = { query: (sql: string, params?: any[]) => Promise<any> }

export class PersonnelSettlementPhase5SchemaNotReady extends Error {
  constructor() {
    super('personnel_settlement_phase5_schema_not_ready')
    this.name = 'PersonnelSettlementPhase5SchemaNotReady'
  }
}

export async function isPersonnelSettlementPhase5SchemaReady(executor: Queryable | null = pgPool) {
  if (!hasPg) return true
  if (!executor) return false
  try {
    const result = await executor.query(
      'SELECT 1 FROM schema_migrations WHERE version=$1 LIMIT 1',
      [PERSONNEL_SETTLEMENT_PHASE5_SCHEMA_MIGRATION],
    )
    return Number(result.rowCount || 0) > 0
  } catch {
    return false
  }
}

export async function assertPersonnelSettlementPhase5SchemaReady(executor: Queryable | null = pgPool) {
  if (!(await isPersonnelSettlementPhase5SchemaReady(executor))) {
    throw new PersonnelSettlementPhase5SchemaNotReady()
  }
}
