import { hasPg, pgPool } from '../dbAdapter'

export const PERSONNEL_SETTLEMENT_SCHEMA_MIGRATION = '20260910_personnel_settlement_phase1'

type SchemaStatus = 'pending' | 'ready' | 'not_ready'
type SqlClient = { query: (sql: string, params?: any[]) => Promise<any> }

let schemaStatus: SchemaStatus = hasPg ? 'pending' : 'ready'

export class PersonnelSettlementSchemaNotReady extends Error {
  constructor() {
    super('personnel_settlement_schema_not_ready')
    this.name = 'PersonnelSettlementSchemaNotReady'
  }
}

export async function warmupPersonnelSettlementSchema() {
  if (!hasPg) {
    schemaStatus = 'ready'
    return
  }
  if (!pgPool) {
    schemaStatus = 'not_ready'
    throw new PersonnelSettlementSchemaNotReady()
  }
  try {
    const result = await pgPool.query(
      'SELECT 1 FROM schema_migrations WHERE version=$1 LIMIT 1',
      [PERSONNEL_SETTLEMENT_SCHEMA_MIGRATION],
    )
    if (!result.rowCount) throw new PersonnelSettlementSchemaNotReady()
    schemaStatus = 'ready'
  } catch (error) {
    schemaStatus = 'not_ready'
    if (error instanceof PersonnelSettlementSchemaNotReady) throw error
    throw new PersonnelSettlementSchemaNotReady()
  }
}

export function assertPersonnelSettlementSchemaReady() {
  if (hasPg && schemaStatus !== 'ready') throw new PersonnelSettlementSchemaNotReady()
}

export async function assertPersonnelSettlementTablesReady(client: SqlClient) {
  assertPersonnelSettlementSchemaReady()
  try {
    await client.query(
      `SELECT p.id, pa.id, r.id, i.id, c.id, e.id, b.id, s.id, l.id
         FROM personnel_settlement_profiles p
         LEFT JOIN personnel_settlement_profile_audits pa ON false
         LEFT JOIN personnel_fee_rules r ON false
         LEFT JOIN personnel_fee_rule_items i ON false
         LEFT JOIN personnel_workload_claims c ON false
         LEFT JOIN personnel_workload_claim_evidence e ON false
         LEFT JOIN personnel_settlement_batches b ON false
         LEFT JOIN personnel_weekly_settlements s ON false
         LEFT JOIN personnel_settlement_lines l ON false
        LIMIT 0`,
    )
  } catch {
    throw new PersonnelSettlementSchemaNotReady()
  }
}
