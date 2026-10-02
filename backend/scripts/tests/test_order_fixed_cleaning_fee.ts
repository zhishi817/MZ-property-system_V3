import assert from 'assert'
import express from 'express'
import fs from 'fs'
import path from 'path'

process.env.DATABASE_URL = ''

const dbAdapter = require('../../src/dbAdapter')
const auth = require('../../src/auth')

let autoDuplicateOrder: any = null
let rawRow: any = null
let manualDuplicateOrder: any = null
let propertyRow: any = null
let autoDuplicateFilters: any = null
const sqlCalls: string[] = []

dbAdapter.hasPg = true
dbAdapter.pgSelect = async (table: string, _fields: string, filters: any) => {
  if (table !== 'orders') return []
  autoDuplicateFilters = filters
  return autoDuplicateOrder ? [autoDuplicateOrder] : []
}
dbAdapter.pgInsert = async (table: string) => {
  sqlCalls.push(`pgInsert:${table}`)
  return null
}
dbAdapter.pgRunInTransaction = async () => undefined
dbAdapter.pgPool = {
  async query(sql: string) {
    sqlCalls.push(sql)
    return { rows: [], rowCount: 0 }
  },
  async connect() {
    return {
      async query(sql: string) {
        sqlCalls.push(sql)
        if (/FROM email_orders_raw/.test(sql)) return { rows: rawRow ? [rawRow] : [], rowCount: rawRow ? 1 : 0 }
        if (/FROM orders WHERE confirmation_code/.test(sql)) return { rows: manualDuplicateOrder ? [manualDuplicateOrder] : [], rowCount: manualDuplicateOrder ? 1 : 0 }
        if (/FROM properties WHERE id/.test(sql)) return { rows: propertyRow ? [propertyRow] : [], rowCount: propertyRow ? 1 : 0 }
        if (/INSERT INTO orders/.test(sql)) throw new Error('test must not insert an order in duplicate/manual-review cases')
        return { rows: [], rowCount: 0 }
      },
      release() {},
    }
  },
}
auth.requirePerm = () => (_req: any, _res: any, next: any) => next()
auth.allowCronTokenOrPerm = () => (_req: any, _res: any, next: any) => next()

async function main() {
  const {
    deriveFixedCleaningAmounts,
    fixedCleaningFeeAudForPropertyType,
  } = await import('../../src/lib/orderCleaningFee')
  const { processMessage, router } = await import('../../src/modules/jobs')

  assert.equal(fixedCleaningFeeAudForPropertyType('studio'), 85)
  assert.equal(fixedCleaningFeeAudForPropertyType('一房一卫'), 90)
  assert.equal(fixedCleaningFeeAudForPropertyType('两房一卫'), 125)
  assert.equal(fixedCleaningFeeAudForPropertyType('两房两卫'), 135)
  assert.equal(fixedCleaningFeeAudForPropertyType('三房两卫'), 220)
  assert.equal(fixedCleaningFeeAudForPropertyType('三房三卫'), 220)
  assert.equal(fixedCleaningFeeAudForPropertyType('4房3.5卫'), 280)
  assert.equal(fixedCleaningFeeAudForPropertyType('两房'), null)
  assert.equal(fixedCleaningFeeAudForPropertyType('未知房型'), null)

  assert.deepEqual(deriveFixedCleaningAmounts(2142.59, '一房一卫', 10), {
    cleaningFeeAud: 90,
    finalAmountAud: 2052.59,
    averageNightlyAmountAud: 205.26,
  })
  assert.equal(deriveFixedCleaningAmounts(undefined, '一房一卫', 10), null)
  assert.equal(deriveFixedCleaningAmounts(null, '一房一卫', 10), null)
  assert.equal(deriveFixedCleaningAmounts(0, '一房一卫', 10), null)

  const source = Buffer.from([
    'From: Airbnb <noreply@airbnb.com>',
    'To: orders@example.invalid',
    'Subject: New booking confirmed! Test Guest arrives Feb 11',
    'Date: Tue, 29 Sep 2026 10:05:39 +0000',
    'Message-ID: <fixed-cleaning-test@example.invalid>',
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<html><body>',
    '<h1>New booking confirmed! Test Guest arrives Feb 11</h1>',
    '<a href="https://www.airbnb.com/rooms/123">Demo Listing</a>',
    '<div>Check-in Thu, 11 Feb 2027</div>',
    '<div>Check-out Sun, 21 Feb 2027</div>',
    '<div>TST23XX83F</div>',
    '<div>10 nights room fee</div>',
    '<div>Cleaning fee A$999.00</div>',
    '<div>You earn A$2,142.59</div>',
    '</body></html>',
  ].join('\r\n'))

  const account = { user: 'orders@example.invalid', pass: 'unused', folder: 'INBOX' }
  const matched = await processMessage(
    account,
    { uid: 1, source },
    { 'demo listing': { id: 'property-1', type: '一房一卫' } },
    true,
    'airbnb_email',
  )
  assert.equal(matched.matched, true)
  assert.equal(matched.sample.cleaning_fee, 90)
  assert.equal(matched.sample.net_income, 2052.59)
  assert.equal(matched.sample.avg_nightly_price, 205.26)

  const manualReview = await processMessage(
    account,
    { uid: 2, source },
    { 'demo listing': { id: 'property-2', type: '未知房型' } },
    true,
    'airbnb_email',
  )
  assert.equal(manualReview.matched, false)
  assert.equal(manualReview.failed, true)
  assert.equal(manualReview.reason, 'unrecognized_property_type')
  assert.equal(manualReview.sample.cleaning_fee, null)

  autoDuplicateOrder = { id: 'existing-order-1' }
  autoDuplicateFilters = null
  const duplicate = await processMessage(
    account,
    { uid: 3, source },
    {},
    false,
    'airbnb_email_import_v1',
  )
  assert.equal(duplicate.skipped_duplicate, true)
  assert.equal(duplicate.order_id, 'existing-order-1')
  assert.equal(duplicate.reason, undefined)
  assert.deepEqual(autoDuplicateFilters, { confirmation_code: 'TST23XX83F' })
  autoDuplicateOrder = null

  const missingPriceSource = Buffer.from(source.toString('utf8').replace('<div>You earn A$2,142.59</div>', ''))
  const missingPrice = await processMessage(
    account,
    { uid: 4, source: missingPriceSource },
    { 'demo listing': { id: 'property-4', type: '一房一卫' } },
    false,
    'airbnb_email',
  )
  assert.equal(missingPrice.reason, 'missing_or_invalid_price')
  assert.equal(missingPrice.sample.net_income, null)
  assert.equal(sqlCalls.some(sql => /INSERT INTO orders/.test(sql)), false)

  const app = express()
  app.use(express.json())
  app.use(router)
  const server = await new Promise<any>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
  })
  try {
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const post = async (route: string, body: any) => {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      return { status: response.status, body: await response.json() as any }
    }

    rawRow = { uid: 10, confirmation_code: 'DUP23XX83F', price: null }
    manualDuplicateOrder = { id: 'existing-order-2', property_id: 'existing-property' }
    propertyRow = null
    sqlCalls.length = 0
    const duplicateResolve = await post('/email-orders-raw/resolve', { uid: 10, property_id: 'unknown-property' })
    assert.equal(duplicateResolve.status, 409)
    assert.equal(duplicateResolve.body.message, 'duplicate')
    assert.equal(sqlCalls.some(sql => /FROM properties WHERE id/.test(sql)), false)

    rawRow = { uid: 11, confirmation_code: 'NEW23XX83F', price: null, checkin: '2027-02-11', checkout: '2027-02-21' }
    manualDuplicateOrder = null
    propertyRow = { id: 'property-1', type: '一房一卫' }
    sqlCalls.length = 0
    const missingResolve = await post('/email-orders-raw/resolve', { uid: 11, property_id: 'property-1' })
    assert.equal(missingResolve.status, 422)
    assert.equal(missingResolve.body.message, 'order_amount_requires_manual_review')
    assert.equal(sqlCalls.some(sql => /^BEGIN/.test(sql) || /INSERT INTO orders/.test(sql)), false)

    rawRow = { uid: 12, confirmation_code: 'DUP24XX83F', price: null }
    manualDuplicateOrder = { id: 'existing-order-3', property_id: 'existing-property' }
    propertyRow = null
    sqlCalls.length = 0
    const bulk = await post('/email-orders-raw/resolve-bulk', { items: [{ uid: 12, property_id: 'unknown-property' }] })
    assert.equal(bulk.status, 200)
    assert.equal(bulk.body.duplicate, 1)
    assert.equal(sqlCalls.some(sql => /FROM properties WHERE id/.test(sql)), false)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error: Error | undefined) => error ? reject(error) : resolve()))
  }

  const jobsSource = fs.readFileSync(path.resolve(__dirname, '../../src/modules/jobs.ts'), 'utf8')
  assert.equal(jobsSource.includes('Number(row.cleaning_fee'), false)
  assert.equal(jobsSource.includes('orders_amount_backfill_done'), false)
  assert.equal((jobsSource.match(/deriveFixedCleaningAmounts\(price, property\.type, nights\)/g) || []).length, 3)

  process.stdout.write('test_order_fixed_cleaning_fee: ok\n')
}

main().catch((error) => {
  process.stderr.write(String((error as any)?.stack || (error as any)?.message || error) + '\n')
  process.exit(1)
})
