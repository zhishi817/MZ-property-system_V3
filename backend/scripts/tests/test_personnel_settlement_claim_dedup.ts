import assert from 'assert'
import {
  assertNoApprovedPersonnelClaimDuplicate,
  personnelClaimBusinessDuplicateKey,
} from '../../src/lib/personnelWorkloadClaims'

const baseClaim = {
  id: 'claim-a',
  submitter_user_id: 'person-1',
  service_date: '2026-09-21',
  claim_type: 'overtime_hour',
  property_id: null,
  cleaning_task_id: null,
  started_at: '2026-09-21T07:00:00.000Z',
  ended_at: '2026-09-21T08:00:00.000Z',
  duration_minutes: 60,
  requested_quantity: null,
  requested_amount_cents: null,
  note: 'Extra shift',
}

async function main() {
  assert.strictEqual(
    personnelClaimBusinessDuplicateKey(baseClaim),
    personnelClaimBusinessDuplicateKey({ ...baseClaim, id: 'claim-b' }),
    'different request IDs must not change the business duplicate key',
  )
  assert.notStrictEqual(
    personnelClaimBusinessDuplicateKey(baseClaim),
    personnelClaimBusinessDuplicateKey({
      ...baseClaim,
      id: 'claim-c',
      started_at: '2026-09-21T09:00:00.000Z',
      ended_at: '2026-09-21T10:00:00.000Z',
    }),
    'separate time ranges remain independently approvable',
  )

  const calls: Array<{ sql: string; params: unknown[] }> = []
  const noDuplicateExecutor = {
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params })
      if (sql.includes('FROM personnel_workload_claims')) return { rows: [] }
      return { rows: [{ pg_advisory_xact_lock: null }] }
    },
  }
  await assertNoApprovedPersonnelClaimDuplicate(baseClaim, noDuplicateExecutor)
  assert.match(calls[0].sql, /pg_advisory_xact_lock\(hashtextextended/)
  assert.match(calls[1].sql, /status = 'approved'/)
  assert.ok(calls[1].sql.includes('started_at IS NOT DISTINCT FROM'))
  assert.ok(calls[1].sql.includes('requested_amount_cents IS NOT DISTINCT FROM'))

  const duplicateExecutor = {
    async query(sql: string) {
      if (sql.includes('FROM personnel_workload_claims')) return { rows: [{ id: 'claim-existing' }] }
      return { rows: [{ pg_advisory_xact_lock: null }] }
    },
  }
  await assert.rejects(
    () => assertNoApprovedPersonnelClaimDuplicate({ ...baseClaim, id: 'claim-new' }, duplicateExecutor),
    /duplicate_approved_claim/,
  )

  console.log('personnel settlement claim duplicate protection tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
