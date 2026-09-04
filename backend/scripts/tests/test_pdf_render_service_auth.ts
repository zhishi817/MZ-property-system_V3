import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import jwt from 'jsonwebtoken'

process.env.DATABASE_URL = ''
process.env.JWT_SECRET = 'pdf-render-service-auth-contract-secret'

type ResponseState = {
  statusCode: number
  body: any
}

function responseFixture() {
  const state: ResponseState = { statusCode: 200, body: undefined }
  const res: any = {
    status(code: number) {
      state.statusCode = code
      return res
    },
    json(body: any) {
      state.body = body
      return res
    },
  }
  return { res, state }
}

async function main() {
  const {
    PDF_RENDER_SERVICE_AUDIENCE,
    hasPdfRenderServiceIntent,
    isPdfRenderServiceClaims,
    isPdfRenderServiceRequestAllowed,
    isPdfRenderServiceUser,
    pdfRenderServiceClaims,
    pdfRenderServiceUser,
  } = await import('../../src/services/pdfRenderServiceAuth')
  const { auth, me, requireAnyPerm, __authRoleSnapshotTestOnly } = await import('../../src/auth')

  const claims = pdfRenderServiceClaims()
  assert.equal(hasPdfRenderServiceIntent(claims), true)
  assert.equal(isPdfRenderServiceClaims(claims), true)
  assert.equal(isPdfRenderServiceUser(pdfRenderServiceUser()), true)
  assert.equal(isPdfRenderServiceClaims({ ...claims, aud: [PDF_RENDER_SERVICE_AUDIENCE] }), true)
  for (const field of ['sub', 'username', 'token_use', 'service', 'scope', 'aud'] as const) {
    assert.equal(isPdfRenderServiceClaims({ ...claims, [field]: 'wrong' }), false, `${field} must be exact`)
  }

  const allowedPaths = [
    '/auth/me',
    '/properties',
    '/orders',
    '/landlords',
    '/finance',
    '/finance/rent-segments?month=2026-08',
    '/crud/property_expenses',
    '/crud/recurring_payments',
    '/crud/property_deep_cleaning/',
    '/crud/property_maintenance',
  ]
  allowedPaths.forEach((requestPath) => {
    assert.equal(isPdfRenderServiceRequestAllowed('GET', requestPath), true, `${requestPath} must remain readable`)
  })
  for (const requestPath of ['/users', '/finance/merge-monthly-pack', '/finance/rent-segments/extra', '/auth/me/extra']) {
    assert.equal(isPdfRenderServiceRequestAllowed('GET', requestPath), false, `${requestPath} must stay outside the service scope`)
  }
  assert.equal(isPdfRenderServiceRequestAllowed('POST', '/finance'), false, 'service identity must be read-only')

  const sign = (payload: any) => jwt.sign(payload, process.env.JWT_SECRET!, { expiresIn: '5m' })
  const validToken = sign(claims)
  const allowedReq: any = {
    method: 'GET',
    path: '/auth/me',
    originalUrl: '/auth/me',
    headers: { authorization: `Bearer ${validToken}` },
    socket: {},
  }
  const allowedResponse = responseFixture()
  let allowedNext = 0
  await auth(allowedReq, allowedResponse.res, () => { allowedNext += 1 })
  assert.equal(allowedNext, 1, 'valid service identity must reach an allowed PDF read route')
  assert.equal(allowedReq.user?.service, 'pdf-render')
  assert.deepEqual(allowedReq.user?.roles, ['admin'])

  const meResponse = responseFixture()
  await me(allowedReq, meResponse.res)
  assert.equal(meResponse.state.statusCode, 200)
  assert.equal(meResponse.state.body?.id, 'u-pdf-job')

  const financeReq: any = {
    method: 'GET',
    path: '/finance/rent-segments',
    originalUrl: '/finance/rent-segments?month=2026-08&property_id=test-property',
    headers: { authorization: `Bearer ${validToken}` },
    socket: {},
  }
  const financeAuthResponse = responseFixture()
  let financeAuthNext = 0
  await auth(financeReq, financeAuthResponse.res, () => { financeAuthNext += 1 })
  assert.equal(financeAuthNext, 1)
  const financePermissionResponse = responseFixture()
  let financePermissionNext = 0
  await requireAnyPerm(['finance.payout', 'property_expenses.view'])(financeReq, financePermissionResponse.res, () => { financePermissionNext += 1 })
  assert.equal(financePermissionNext, 1, 'allowed service reads must pass their existing permission middleware')

  const forbiddenReq: any = {
    method: 'POST',
    path: '/finance',
    originalUrl: '/finance',
    headers: { authorization: `Bearer ${validToken}` },
    socket: {},
  }
  const forbiddenResponse = responseFixture()
  let forbiddenNext = 0
  await auth(forbiddenReq, forbiddenResponse.res, () => { forbiddenNext += 1 })
  assert.equal(forbiddenNext, 0)
  assert.equal(forbiddenResponse.state.statusCode, 403)
  assert.equal(forbiddenResponse.state.body?.message, 'service token forbidden')

  const forbiddenPathReq: any = {
    method: 'GET',
    path: '/users',
    originalUrl: '/users',
    headers: { authorization: `Bearer ${validToken}` },
    socket: {},
  }
  const forbiddenPathResponse = responseFixture()
  let forbiddenPathNext = 0
  await auth(forbiddenPathReq, forbiddenPathResponse.res, () => { forbiddenPathNext += 1 })
  assert.equal(forbiddenPathNext, 0)
  assert.equal(forbiddenPathResponse.state.statusCode, 403)
  assert.equal(forbiddenPathResponse.state.body?.message, 'service token forbidden')

  const invalidReq: any = {
    method: 'GET',
    path: '/auth/me',
    originalUrl: '/auth/me',
    headers: { authorization: `Bearer ${sign({ ...claims, aud: 'wrong' })}` },
    socket: {},
  }
  const invalidResponse = responseFixture()
  let invalidNext = 0
  await auth(invalidReq, invalidResponse.res, () => { invalidNext += 1 })
  assert.equal(invalidNext, 0)
  assert.equal(invalidResponse.state.statusCode, 401)
  assert.equal(invalidResponse.state.body?.message, 'invalid service token')

  __authRoleSnapshotTestOnly.clear()
  const missingHuman = await __authRoleSnapshotTestOnly.hydrate(
    { sub: 'deleted-human', role: 'admin', roles: ['admin'] },
    async () => ({ kind: 'missing' as const }),
  )
  assert.equal(missingHuman.kind, 'missing', 'ordinary deleted users must still fail closed')

  const backendRoot = path.resolve(__dirname, '../..')
  const worker = fs.readFileSync(path.join(backendRoot, 'src/services/pdfJobsWorker.ts'), 'utf8')
  assert.match(worker, /jwt\.sign\(pdfRenderServiceClaims\(\), SECRET/)
  assert.doesNotMatch(worker, /const payload: any = \{ sub: 'u-pdf-job'/)
  assert.match(worker, /code === 'PRINT_AUTH'/)
  assert.match(worker, /data-monthly-statement-error/)
  assert.match(worker, /code: 'PRINT_DATA_LOAD'/)
  assert.match(worker, /ready \|\| !!dataError/)
  const waitStart = worker.indexOf("await page.waitForLoadState('networkidle'")
  const authRedirectCheck = worker.indexOf("urlAfterLoad.includes('/login')", waitStart)
  const statementWait = worker.indexOf("document.querySelector('[data-monthly-statement-root=\"1\"]')", waitStart)
  assert.ok(waitStart >= 0 && authRedirectCheck > waitStart && statementWait > authRedirectCheck, 'login redirect must be detected before waiting for the statement root')

  const propertiesModule = fs.readFileSync(path.join(backendRoot, 'src/modules/properties.ts'), 'utf8')
  assert.match(propertiesModule, /isPdfRenderServiceUser\(\(req as any\)\.user\) && !hasPg/)
  assert.match(propertiesModule, /pdf_render_data_unavailable[^\n]+properties/)

  const ordersModule = fs.readFileSync(path.join(backendRoot, 'src/modules/orders.ts'), 'utf8')
  assert.match(ordersModule, /const pdfRenderReadOnly = isPdfRenderServiceUser/)
  assert.match(ordersModule, /if \(pdfRenderReadOnly\) throw e/)
  assert.match(ordersModule, /pdf_render_data_unavailable[^\n]+orders/)

  const financeModule = fs.readFileSync(path.join(backendRoot, 'src/modules/finance.ts'), 'utf8')
  assert.match(financeModule, /const pdfRenderReadOnly = isPdfRenderServiceUser/)
  assert.match(financeModule, /if \(pdfRenderReadOnly\) throw e/)
  assert.match(financeModule, /pdf_render_data_unavailable[^\n]+finance/)

  const landlordsModule = fs.readFileSync(path.join(backendRoot, 'src/modules/landlords.ts'), 'utf8')
  assert.match(landlordsModule, /ensureSchema: !pdfRenderReadOnly/)
  assert.match(landlordsModule, /requireExistingTable: pdfRenderReadOnly/)
  const managementFeeRules = fs.readFileSync(path.join(backendRoot, 'src/lib/managementFeeRules.ts'), 'utf8')
  assert.match(managementFeeRules, /42P01[^\n]+!options\?\.requireExistingTable/)

  const crudModule = fs.readFileSync(path.join(backendRoot, 'src/modules/crud.ts'), 'utf8')
  assert.match(crudModule, /resource === 'property_deep_cleaning' && !pdfRenderReadOnly/)
  assert.match(crudModule, /if \(pdfRenderReadOnly\) throw e/)
  assert.match(crudModule, /if \(!pdfRenderReadOnly && toFixWorkNo\.length\)/)
  assert.match(crudModule, /if \(!pdfRenderReadOnly && toFixMeta\.length\)/)
  assert.match(crudModule, /pdf_render_data_unavailable[^\n]+source: resource/)

  process.stdout.write('test_pdf_render_service_auth: ok\n')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
