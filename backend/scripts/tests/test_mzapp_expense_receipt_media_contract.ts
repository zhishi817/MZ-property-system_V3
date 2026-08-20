import assert from 'node:assert/strict'
import fs from 'node:fs'
import express from 'express'

process.env.R2_PUBLIC_BASE_URL = process.env.R2_PUBLIC_BASE_URL || 'https://receipt-contract.r2.dev'

const dbAdapter = require('../../src/dbAdapter')
const r2 = require('../../src/r2')
const receiptId = 'receipt-1'
const imageId = 'receipt-image-1'
const receiptKey = 'mzapp/expenses/receipt-1.png'
const receipt = {
  id: receiptId,
  created_by: 'owner-1',
  generated_from: 'mzapp',
  deleted_at: null,
  receipt_total_amount: 10,
}
const images = [{ id: imageId, receipt_id: receiptId, url: `https://receipt-contract.r2.dev/${receiptKey}`, sort_index: 0 }]
const items = [{ id: 'item-1', receipt_id: receiptId, scope: 'company', amount: 10 }]
let objectReadCount = 0
let objectAvailable = true
let schemaWriteAttemptCount = 0

dbAdapter.hasPg = true
dbAdapter.pgPool = {
  async query(sql: string, params: any[] = []) {
    if (/^\s*(CREATE|ALTER)\b/i.test(sql)) {
      schemaWriteAttemptCount += 1
      throw new Error('receipt-media GET must never attempt schema DDL')
    }
    if (/FROM expense_receipts/.test(sql)) {
      const id = String(params[0] || '')
      return { rows: id === receiptId ? [receipt] : [], rowCount: id === receiptId ? 1 : 0 }
    }
    if (/FROM expense_receipt_images/.test(sql)) return { rows: String(params[0] || '') === receiptId ? images : [], rowCount: 1 }
    if (/FROM expense_receipt_items/.test(sql)) return { rows: String(params[0] || '') === receiptId ? items : [], rowCount: 1 }
    if (/FROM company_expenses|FROM property_expenses/.test(sql)) return { rows: [], rowCount: 0 }
    if (/FROM role_permissions/.test(sql)) {
      const roleIds = Array.isArray(params[0]) ? params[0].map(String) : []
      const owner = roleIds.includes('cleaner')
      return { rows: owner ? [{ permission_code: 'cleaning_app.expense.company.view.self' }] : [], rowCount: owner ? 1 : 0 }
    }
    return { rows: [], rowCount: 0 }
  },
}
r2.hasR2 = true
r2.r2GetObjectByKey = async (key: string) => {
  assert.equal(key, receiptKey, 'only the exact receipt image object key may reach R2')
  objectReadCount += 1
  return objectAvailable
    ? { body: Buffer.from([0x89, 0x50, 0x4e, 0x47]), contentType: 'image/png', etag: 'receipt-test' }
    : null
}

const { router, canViewMzappExpenseReceiptMedia, mzappExpenseReceiptMediaObjectKey, selectMzappExpenseReceiptImage } = require('../../src/modules/mzapp')

const moduleSource = fs.readFileSync(require.resolve('../../src/modules/mzapp'), 'utf8')
const routeStart = moduleSource.indexOf("router.get('/expense-receipts/:receiptId/images/:imageId'")
const routeEnd = moduleSource.indexOf("router.get('/expense-receipts/mine/:id'", routeStart)
assert(routeStart >= 0 && routeEnd > routeStart, 'expense receipt reader must be a dedicated route before the detail route')
const routeSource = moduleSource.slice(routeStart, routeEnd)
assert.match(routeSource, /buildReceiptDetail\(receiptId, pgPool\)/, 'reader must resolve the persisted receipt before bytes are read')
assert.match(routeSource, /selectMzappExpenseReceiptImage\(receipt, imageId\)/, 'reader must bind the image id to the requested receipt')
assert.match(routeSource, /canViewMzappExpenseReceiptMedia/, 'reader must re-check receipt authorization before bytes are read')
assert.match(routeSource, /r2GetObjectByKey\(objectKey\)/, 'reader must obtain private object bytes server-side')
assert.match(routeSource, /private, no-store, max-age=0/, 'receipt bytes must not be cacheable as a public URL fallback')
assert.doesNotMatch(routeSource, /cleaning-app\/media\/image/, 'finance receipts must not use the cleaning-media proxy')
assert.doesNotMatch(routeSource, /ensureMzappExpenseReceiptSchema/, 'receipt-media GET must not run a schema bootstrap')

assert.equal(mzappExpenseReceiptMediaObjectKey(`https://receipt-contract.r2.dev/${receiptKey}`), receiptKey)
assert.equal(mzappExpenseReceiptMediaObjectKey('https://receipt-contract.r2.dev/cleaning/not-a-receipt.png'), null)
assert.equal(selectMzappExpenseReceiptImage({ id: receiptId, images }, imageId), images[0])
assert.equal(selectMzappExpenseReceiptImage({ id: receiptId, images }, 'receipt-image-other'), null)

async function withServer(run: (baseUrl: string) => Promise<void>) {
  const app = express()
  app.use((req: any, _res, next) => {
    const role = String(req.headers['x-test-role'] || '')
    const sub = role === 'cleaner' ? 'owner-1' : role === 'maintenance_staff' ? 'other-1' : `${role || 'unknown'}-1`
    req.user = { sub, role, roles: role ? [role] : [] }
    next()
  })
  app.use('/mzapp', router)
  const server = await new Promise<any>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
  })
  try {
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    await run(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

function requestMedia(baseUrl: string, role: string, requestedImageId = imageId) {
  return fetch(`${baseUrl}/mzapp/expense-receipts/${encodeURIComponent(receiptId)}/images/${encodeURIComponent(requestedImageId)}`, {
    headers: { 'x-test-role': role },
  })
}

async function verifyRouteContract() {
  await withServer(async (baseUrl) => {
    for (const role of ['cleaner', 'admin', 'finance_staff', 'customer_service']) {
      const response = await requestMedia(baseUrl, role)
      assert.equal(response.status, 200, `${role} with existing receipt authority may read the exact receipt image`)
      assert.equal(response.headers.get('content-type'), 'image/png')
      assert.equal(response.headers.get('cache-control'), 'private, no-store, max-age=0')
      assert.ok((await response.arrayBuffer()).byteLength > 0)
    }
    assert.equal(objectReadCount, 4, 'only authorized exact-record readers reach R2')

    const wrongImage = await requestMedia(baseUrl, 'finance_staff', 'receipt-image-other')
    assert.equal(wrongImage.status, 403, 'an image id not associated with the requested receipt must be denied')
    assert.equal(objectReadCount, 4, 'wrong receipt-image association must not reach R2')

    const outsider = await requestMedia(baseUrl, 'maintenance_staff')
    assert.equal(outsider.status, 403, 'an unrelated role must be denied before object storage is read')
    assert.equal(objectReadCount, 4, 'unauthorized receipt reader must not reach R2')

    objectAvailable = false
    const missing = await requestMedia(baseUrl, 'finance_staff')
    assert.equal(missing.status, 404, 'an authorized exact receipt image with a missing object must report 404')
    objectAvailable = true
    assert.equal(schemaWriteAttemptCount, 0, 'receipt-media GET must not issue CREATE or ALTER statements')
  })
}

async function main() {
  assert.equal(await canViewMzappExpenseReceiptMedia({ sub: 'owner-1', role: 'cleaner', roles: ['cleaner'] }, { ...receipt, items }), true)
  assert.equal(await canViewMzappExpenseReceiptMedia({ sub: 'other-1', role: 'maintenance_staff', roles: ['maintenance_staff'] }, { ...receipt, items }), false)
  assert.equal(await canViewMzappExpenseReceiptMedia({ sub: 'finance-1', role: 'finance_staff', roles: ['finance_staff'] }, { ...receipt, items }), true)
  await verifyRouteContract()
}

main()
  .then(() => console.log('expense receipt media contract passed'))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
