import assert from 'assert'
import fs from 'fs'
import path from 'path'
import {
  personnelClaimEvidenceStorageKey,
  serializePersonnelClaimEvidence,
  validatePersonnelClaimEvidenceMediaId,
} from '../../src/lib/personnelClaimEvidence'
import {
  getPersonnelClaimAvailableActions,
  validatePersonnelClaimClientRequestId,
  validatePersonnelClaimInput,
} from '../../src/lib/personnelWorkloadClaims'

const backendRoot = path.resolve(__dirname, '../..')
const router = fs.readFileSync(path.join(backendRoot, 'src/modules/personnel_settlements.ts'), 'utf8')
const evidence = fs.readFileSync(path.join(backendRoot, 'src/lib/personnelClaimEvidence.ts'), 'utf8')
const mobileScreen = fs.readFileSync(path.resolve(backendRoot, '../../mobile/src/screens/me/PersonnelSettlementScreen.tsx'), 'utf8')
const webPanel = fs.readFileSync(path.resolve(backendRoot, '../frontend/src/app/finance/settlements/WorkloadClaimsPanel.tsx'), 'utf8')

assert.equal(validatePersonnelClaimClientRequestId('claim_abc12345'), 'claim_abc12345')
assert.throws(() => validatePersonnelClaimClientRequestId('short'), /invalid_claim_client_request_id/)
assert.equal(validatePersonnelClaimEvidenceMediaId('media_abc12345'), 'media_abc12345')
assert.throws(() => validatePersonnelClaimEvidenceMediaId('../secret'), /invalid_claim_evidence_media_id/)
assert.equal(
  personnelClaimEvidenceStorageKey({ userId: 'user-1', claimId: 'claim-1', mediaId: 'media_abc12345' }),
  'mzapp/personnel-claims/user-1/claim-1/media_abc12345.jpg',
)
assert.deepEqual(getPersonnelClaimAvailableActions('draft'), ['edit', 'submit'])
assert.deepEqual(getPersonnelClaimAvailableActions('returned'), ['edit', 'submit'])
assert.deepEqual(getPersonnelClaimAvailableActions('submitted'), [])

const validated = validatePersonnelClaimInput({
  client_request_id: 'claim_abc12345',
  service_date: '2026-09-10',
  claim_type: 'subsidy_amount',
  requested_amount_cents: 3500,
  note: 'Travel subsidy',
}, new Date('2026-09-11T00:00:00Z'))
assert.equal(validated.client_request_id, 'claim_abc12345')

const safe = serializePersonnelClaimEvidence({
  id: 'evidence-1',
  claim_id: 'claim-1',
  media_id: 'media_abc12345',
  storage_key: 'mzapp/personnel-claims/private.jpg',
  mime_type: 'image/jpeg',
  byte_size: 123,
})
assert.equal((safe as any).storage_key, undefined, 'private storage references must never be serialized')

assert.match(router, /router\.post\('\/my-claims\/:claimId\/evidence'/)
assert.match(router, /router\.get\('\/my-claims\/:claimId\/evidence\/:evidenceId\/image'/)
assert.match(router, /requirePerm\('personnel_settlements\.profiles\.view'\)/)
assert.match(router, /Cache-Control', 'private, max-age=0, no-store'/)
assert.match(evidence, /claim\.submitter_user_id=\$3/)
assert.match(evidence, /WHERE evidence\.claim_id=\$1 AND evidence\.id=\$2/)
assert.doesNotMatch(evidence.slice(evidence.indexOf('export function serializePersonnelClaimEvidence'), evidence.indexOf('async function findEvidenceByMediaId')), /storage_key:/)
assert.match(mobileScreen, /确认：工作量及金额正确/)
assert.match(mobileScreen, /草稿和照片已保留，可稍后重试/)
assert.match(webPanel, /loadPersonnelClaimEvidenceObjectUrl/)

console.log('personnel settlement phase4 contract tests passed')
