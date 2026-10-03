import assert from 'assert'
import fs from 'fs'
import path from 'path'

process.env.R2_STORAGE_NAMESPACE = 'personnel-claim-contract'
delete process.env.R2_BUCKET
delete process.env.R2_ENDPOINT
delete process.env.R2_ACCESS_KEY_ID
delete process.env.R2_SECRET_ACCESS_KEY

const {
  personnelClaimEvidenceR2KeyFromReference,
  personnelClaimEvidenceStorageKey,
  readPersonnelClaimEvidenceBytes,
} = require('../../src/lib/personnelClaimEvidence') as typeof import('../../src/lib/personnelClaimEvidence')
const { classifyR2ObjectReadError } = require('../../src/r2') as typeof import('../../src/r2')

async function main() {
  const key = personnelClaimEvidenceStorageKey({
    userId: 'user-1',
    claimId: 'claim-1',
    mediaId: 'media_abc12345',
  })
  assert.equal(key, 'mzapp/personnel-claims/user-1/claim-1/media_abc12345.jpg')
  assert.equal(
    personnelClaimEvidenceR2KeyFromReference(`r2://personnel-claim-contract/${key}`),
    key,
    'new evidence references must resolve only inside the configured storage namespace',
  )
  assert.equal(
    personnelClaimEvidenceR2KeyFromReference(key),
    key,
    'legacy bare personnel evidence keys remain readable',
  )
  assert.equal(personnelClaimEvidenceR2KeyFromReference(`r2://another-store/${key}`), null)
  assert.equal(personnelClaimEvidenceR2KeyFromReference('mzapp/personnel-claims/../private.jpg'), null)

  await assert.rejects(
    readPersonnelClaimEvidenceBytes({ storage_key: `r2://personnel-claim-contract/${key}` }),
    /claim_evidence_storage_unavailable/,
    'missing R2 credentials must report storage unavailable for a valid current reference',
  )
  delete process.env.R2_STORAGE_NAMESPACE
  await assert.rejects(
    readPersonnelClaimEvidenceBytes({ storage_key: `r2://personnel-claim-contract/${key}` }),
    /claim_evidence_storage_unavailable/,
    'a valid namespaced reference must report storage unavailable when the current storage identity is missing',
  )
  process.env.R2_STORAGE_NAMESPACE = 'INVALID NAMESPACE'
  await assert.rejects(
    readPersonnelClaimEvidenceBytes({ storage_key: `r2://personnel-claim-contract/${key}` }),
    /claim_evidence_storage_unavailable/,
    'an invalid current storage namespace must not turn a valid stored reference into a permission error',
  )
  process.env.R2_STORAGE_NAMESPACE = 'personnel-claim-contract'
  await assert.rejects(
    readPersonnelClaimEvidenceBytes({ storage_key: `r2://another-store/${key}` }),
    /invalid_claim_evidence_reference/,
    'a valid but mismatched namespace must continue to fail closed',
  )

  assert.equal(classifyR2ObjectReadError({ name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } }), 'not_found')
  assert.equal(classifyR2ObjectReadError({ name: 'NoSuchBucket', $metadata: { httpStatusCode: 404 } }), 'unavailable')
  assert.equal(classifyR2ObjectReadError({ name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }), 'unavailable')
  assert.equal(classifyR2ObjectReadError(new Error('network timeout')), 'unavailable')

  const backendRoot = path.resolve(__dirname, '../..')
  const router = fs.readFileSync(path.join(backendRoot, 'src/modules/personnel_settlements.ts'), 'utf8')
  const evidence = fs.readFileSync(path.join(backendRoot, 'src/lib/personnelClaimEvidence.ts'), 'utf8')
  const r2 = fs.readFileSync(path.join(backendRoot, 'src/r2.ts'), 'utf8')

  assert.match(router, /claim_evidence_storage_unavailable/)
  assert.match(router, /safeServerCode = code === 'claim_evidence_storage_unavailable'/)
  assert.match(evidence, /createMzappTaskPhotoRemoteReference\(key\)/, 'new R2 writes must persist a namespaced server reference')
  assert.match(evidence, /result\.status === 'not_found'/, 'missing objects must remain distinct from storage outages')
  assert.match(evidence, /result\.status === 'unavailable'/, 'storage outages must not be reported as missing photos')
  assert.match(r2, /await verifyUploadedR2Object\(key, contentType, body\.length\)/, 'R2 writes must be verified before evidence association')

  console.log('personnel claim evidence storage contract tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
