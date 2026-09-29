import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { hasPg, pgPool } from '../../src/dbAdapter'
import { hasR2 } from '../../src/r2'
import { warmupPersonnelSettlementSchema } from '../../src/lib/personnelSettlementSchema'
import {
  getPersonnelClaimEvidence,
  readPersonnelClaimEvidenceBytes,
  savePersonnelClaimEvidence,
} from '../../src/lib/personnelClaimEvidence'
import { createPersonnelClaim, submitPersonnelClaim } from '../../src/lib/personnelWorkloadClaims'

const USER_ID = 'dev-preview-phase4-cleaner'
const CLAIM_ID = 'claim_phase4_integration_001'
const MEDIA_ID = 'media_phase4_integration_001'
const PRIVATE_PREFIX = 'local-private:personnel-claims/'

function requirePreviewWriteGuard() {
  assert.equal(process.env.MZ_DEV_PREVIEW, '1', 'MZ_DEV_PREVIEW must be 1')
  assert.equal(process.env.APP_ENV, 'dev', 'APP_ENV must be dev')
  assert.equal(process.env.DATABASE_ROLE, 'dev', 'DATABASE_ROLE must be dev')
  assert.equal(process.env.MZ_PHASE4_INTEGRATION_WRITE, '1', 'MZ_PHASE4_INTEGRATION_WRITE must be 1')
  assert.equal(hasR2, false, 'phase4 integration must use local private storage and never write R2')
}

async function cleanup() {
  if (!pgPool) return
  const refs = await pgPool.query(
    `SELECT evidence.storage_key
       FROM personnel_workload_claim_evidence evidence
       JOIN personnel_workload_claims claim ON claim.id=evidence.claim_id
      WHERE claim.submitter_user_id=$1`,
    [USER_ID],
  )
  await pgPool.query('BEGIN')
  try {
    const claims = await pgPool.query('SELECT id FROM personnel_workload_claims WHERE submitter_user_id=$1', [USER_ID])
    const claimIds = (claims.rows || []).map((row: any) => String(row.id))
    if (claimIds.length) {
      await pgPool.query('DELETE FROM audit_logs WHERE entity_id=ANY($1::text[])', [claimIds])
      await pgPool.query('DELETE FROM personnel_workload_claim_evidence WHERE claim_id=ANY($1::text[])', [claimIds])
      await pgPool.query('DELETE FROM personnel_workload_claims WHERE id=ANY($1::text[])', [claimIds])
    }
    await pgPool.query('DELETE FROM users WHERE id=$1', [USER_ID])
    await pgPool.query('COMMIT')
  } catch (error) {
    await pgPool.query('ROLLBACK')
    throw error
  }
  for (const row of refs.rows || []) {
    const reference = String(row.storage_key || '')
    if (!reference.startsWith(PRIVATE_PREFIX)) continue
    const fileName = reference.slice(PRIVATE_PREFIX.length)
    if (!/^personnel-claim-[a-zA-Z0-9_-]+\.jpg$/.test(fileName)) continue
    const filePath = path.resolve(process.cwd(), 'private-uploads', 'personnel-claims', fileName)
    await fs.promises.unlink(filePath).catch(() => undefined)
  }
}

async function expectReject(run: () => Promise<unknown>, pattern: RegExp) {
  let thrown: unknown = null
  try { await run() } catch (error) { thrown = error }
  assert.ok(thrown instanceof Error)
  assert.match((thrown as Error).message, pattern)
}

async function main() {
  requirePreviewWriteGuard()
  assert.ok(hasPg && pgPool, 'development PostgreSQL is required')
  await warmupPersonnelSettlementSchema()
  await cleanup()
  try {
    await pgPool!.query(
      `INSERT INTO users (id, username, password_hash, role, display_name, legal_name)
       VALUES ($1,$1,'synthetic-not-login-capable','cleaner','Phase 4 Cleaner','Phase 4 Cleaner')`,
      [USER_ID],
    )
    const claim: any = await createPersonnelClaim({
      userId: USER_ID,
      claim: {
        client_request_id: CLAIM_ID,
        service_date: '2010-02-01',
        claim_type: 'subsidy_amount',
        requested_amount_cents: 3500,
        note: 'Synthetic travel subsidy',
      },
    })
    assert.equal(claim.id, CLAIM_ID)
    const retried: any = await createPersonnelClaim({
      userId: USER_ID,
      claim: {
        client_request_id: CLAIM_ID,
        service_date: '2010-02-01',
        claim_type: 'subsidy_amount',
        requested_amount_cents: 3500,
        note: 'Synthetic travel subsidy',
      },
    })
    assert.equal(retried.id, CLAIM_ID, 'claim creation retry must be idempotent')

    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
    const evidence = await savePersonnelClaimEvidence({
      userId: USER_ID,
      claimId: CLAIM_ID,
      mediaId: MEDIA_ID,
      originalFileName: 'proof.png',
      contentType: 'image/png',
      body: png,
    })
    assert.equal(evidence.media_id, MEDIA_ID)
    assert.equal(evidence.mime_type, 'image/jpeg')
    assert.equal((evidence as any).storage_key, undefined)
    const evidenceRetry = await savePersonnelClaimEvidence({
      userId: USER_ID,
      claimId: CLAIM_ID,
      mediaId: MEDIA_ID,
      originalFileName: 'proof.png',
      contentType: 'image/png',
      body: png,
    })
    assert.equal(evidenceRetry.id, evidence.id, 'media retry must return the existing association')

    const owned = await getPersonnelClaimEvidence({ claimId: CLAIM_ID, evidenceId: evidence.id, requestingUserId: USER_ID })
    assert.ok(owned)
    assert.equal(await getPersonnelClaimEvidence({ claimId: CLAIM_ID, evidenceId: evidence.id, requestingUserId: 'other-user' }), null)
    const bytes = await readPersonnelClaimEvidenceBytes(owned)
    assert.ok(bytes?.body?.length)
    assert.equal(bytes?.contentType, 'image/jpeg')

    const submitted: any = await submitPersonnelClaim({ userId: USER_ID, claimId: CLAIM_ID })
    assert.equal(submitted.status, 'submitted')
    await expectReject(() => savePersonnelClaimEvidence({
      userId: USER_ID,
      claimId: CLAIM_ID,
      mediaId: 'media_phase4_integration_002',
      originalFileName: 'late.png',
      contentType: 'image/png',
      body: png,
    }), /claim_not_editable/)
  } finally {
    await cleanup()
  }
  console.log('personnel settlement phase4 integration passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
