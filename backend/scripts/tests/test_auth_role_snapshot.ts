import assert from 'node:assert/strict'
import fs from 'node:fs'

process.env.DATABASE_URL = ''

type LookupResult =
  | { kind: 'found'; snapshot: { role: string; roles: string[] } }
  | { kind: 'missing' }
  | { kind: 'db_error' }

async function main() {
  const authModule = await import('../../src/auth')
  const testApi = authModule.__authRoleSnapshotTestOnly
  const decoded = { sub: 'user-1', role: 'jwt_role', roles: ['jwt_role'], username: 'User One' }

  testApi.clear()
  let successfulLookupCalls = 0
  const successfulLookup = async (): Promise<LookupResult> => {
    successfulLookupCalls += 1
    await new Promise((resolve) => setTimeout(resolve, 5))
    return { kind: 'found', snapshot: { role: 'cleaner', roles: ['cleaner', 'cleaning_inspector'] } }
  }
  const concurrent = await Promise.all(Array.from({ length: 10 }, () => testApi.hydrate(decoded, successfulLookup)))
  assert.equal(successfulLookupCalls, 1, 'concurrent cache misses for one user must share one role lookup')
  concurrent.forEach((result) => {
    assert.equal(result.kind, 'found')
    if (result.kind === 'found') assert.deepEqual(result.user.roles, ['cleaner', 'cleaning_inspector'])
  })
  const cached = await testApi.hydrate(decoded, successfulLookup)
  assert.equal(cached.kind, 'found')
  assert.equal(successfulLookupCalls, 1, 'a successful role lookup must be cached for the TTL')

  testApi.invalidateUser('user-1')
  await testApi.hydrate(decoded, successfulLookup)
  assert.equal(successfulLookupCalls, 2, 'user invalidation must bypass an earlier role snapshot')

  testApi.clear()
  let resolveInFlight: ((result: LookupResult) => void) | null = null
  const inFlightLookup = () => new Promise<LookupResult>((resolve) => {
    resolveInFlight = resolve
  })
  const inFlight = testApi.hydrate({ ...decoded, sub: 'user-in-flight' }, inFlightLookup)
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(testApi.inflightSize(), 1, 'test setup must keep one role lookup in flight')
  testApi.invalidateUser('user-in-flight')
  assert.equal(testApi.versionStateSize(), 1, 'the invalidation version must survive while an older lookup can still finish')
  resolveInFlight!({ kind: 'found', snapshot: { role: 'stale_role', roles: ['stale_role'] } })
  await inFlight
  assert.equal(testApi.cacheSize(), 0, 'an invalidated in-flight result must never repopulate the role snapshot')
  assert.equal(testApi.inflightSize(), 0, 'completed single-flight lookups must be released')
  assert.equal(testApi.versionStateSize(), 0, 'a version with no cache or in-flight lookup must be released')

  for (let index = 0; index < 2000; index += 1) {
    testApi.invalidateUser(`invalidated-user-${index}`)
  }
  assert.equal(testApi.versionStateSize(), 0, 'invalidating many idle users must not retain unbounded version state')

  testApi.clear()
  let emptyRoleLookupCalls = 0
  const emptyRoleLookup = async (): Promise<LookupResult> => {
    emptyRoleLookupCalls += 1
    return { kind: 'found', snapshot: { role: '', roles: [] } }
  }
  const emptyFirst = await testApi.hydrate({ sub: 'user-empty', roles: [] }, emptyRoleLookup)
  const emptySecond = await testApi.hydrate({ sub: 'user-empty', roles: [] }, emptyRoleLookup)
  assert.equal(emptyFirst.kind, 'found', 'a successful user lookup with no assigned roles is valid')
  assert.equal(emptySecond.kind, 'found', 'a successful empty role set must remain cacheable')
  assert.equal(emptyRoleLookupCalls, 1, 'an empty role set must not be treated as a database failure')

  testApi.clear()
  let missingLookupCalls = 0
  const missingLookup = async (): Promise<LookupResult> => {
    missingLookupCalls += 1
    return { kind: 'missing' }
  }
  const missing = await testApi.hydrate(decoded, missingLookup)
  assert.equal(missing.kind, 'missing', 'a successful zero-row users query must not fall back to JWT roles')
  assert.equal(testApi.cacheSize(), 0, 'a missing user must not create a role snapshot')
  await testApi.hydrate(decoded, missingLookup)
  assert.equal(missingLookupCalls, 2, 'a missing user result must not be cached')

  testApi.clear()
  let failedLookupCalls = 0
  const failedLookup = async (): Promise<LookupResult> => {
    failedLookupCalls += 1
    return { kind: 'db_error' }
  }
  const fallback = await testApi.hydrate(decoded, failedLookup)
  assert.equal(fallback.kind, 'fallback', 'only a database failure may use the JWT fallback')
  if (fallback.kind === 'fallback') assert.deepEqual(fallback.user.roles, ['jwt_role'])
  await testApi.hydrate(decoded, failedLookup)
  assert.equal(failedLookupCalls, 2, 'a database-error fallback must not be cached')

  const authSource = fs.readFileSync(require.resolve('../../src/auth'), 'utf8')
  const rbacSource = fs.readFileSync(require.resolve('../../src/modules/rbac'), 'utf8')
  assert.match(authSource, /const ROLE_SNAPSHOT_TTL_MS = 15000/, 'role snapshot TTL must remain 15 seconds')
  assert.match(authSource, /if \(roleResolution\.kind === 'missing'\) return res\.status\(401\)/, 'auth must reject a deleted user')
  assert.match(authSource, /requestAuthState\(req, token\)[\s\S]{0,260}return next\(\)/, 'repeated auth middleware in one request must reuse hydrated identity')
  assert.match(authSource, /\.finally\(\(\) => \{[\s\S]{0,180}roleSnapshotInflight\.delete/, 'single-flight entries must be released after success or failure')
  assert.match(authSource, /function pruneRoleSnapshotUserVersions\(\)/, 'version metadata must have a lifecycle cleanup path')
  assert.doesNotMatch(authSource.slice(authSource.indexOf('export async function me'), authSource.indexOf('export async function setDeletePassword')), /hydrateCurrentUserRoles/, '/auth/me must reuse request hydration')
  assert.match(rbacSource, /router\.get\('\/my-permissions', auth, async/, 'RBAC must retain explicit auth middleware and rely on idempotence')
  assert.match(rbacSource, /await pgRunInTransaction\(async \(client: any\) =>/, 'user role writes must use one transaction')
  assert.match(rbacSource, /if \(invalidatesAuth\) invalidateUserAuthState/, 'user auth cache invalidation must occur only after the transaction resolves')

  process.stdout.write('test_auth_role_snapshot: ok\n')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
