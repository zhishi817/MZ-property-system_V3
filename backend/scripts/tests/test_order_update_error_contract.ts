import assert from 'assert'
import express from 'express'

process.env.DATABASE_URL = ''

async function requestJson(app: express.Express, body: any) {
  const server = await new Promise<any>((resolve) => {
    const listener = app.listen(0, () => resolve(listener))
  })
  try {
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const response = await fetch(`http://127.0.0.1:${port}/orders/order-error-contract`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const text = await response.text()
    return { status: response.status, body: text ? JSON.parse(text) : null }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

async function main() {
  const { db } = await import('../../src/store')
  const { router } = await import('../../src/modules/orders')
  const app = express()
  app.use(express.json())
  app.use((req: any, _res, next) => {
    req.user = { sub: 'test-admin', role: 'admin', roles: ['admin'] }
    next()
  })
  app.use('/orders', router)

  db.orders.length = 0
  db.orders.push({
    id: 'order-error-contract',
    source: 'airbnb',
    property_id: 'test-property',
    checkin: '2026-10-18',
    checkout: '2026-10-24',
    status: 'confirmed',
    email_header_at: '2026-08-01T01:02:03.000Z',
  } as any)

  const invalidNumber = await requestJson(app, { price: 'not-a-number' })
  assert.equal(invalidNumber.status, 400)
  assert.equal(invalidNumber.body?.message, '订单信息校验失败')
  assert.equal(invalidNumber.body?.code, 'ORDER_VALIDATION_FAILED')
  assert.equal(invalidNumber.body?.field_errors?.price, '总租金格式不正确')

  const invalidDates = await requestJson(app, { checkin: '2026-10-24', checkout: '2026-10-24' })
  assert.equal(invalidDates.status, 400)
  assert.equal(invalidDates.body?.code, 'INVALID_STAY_DATE')
  assert.equal(invalidDates.body?.message, '入住日期必须早于退房日期')

  const cancelled = await requestJson(app, { status: 'cancelled' })
  assert.equal(cancelled.status, 200)
  assert.equal(cancelled.body?.status, 'cancelled')
  assert.equal(cancelled.body?.email_header_at, '2026-08-01T01:02:03.000Z')

  process.stdout.write('test_order_update_error_contract: ok\n')
}

main().catch((error) => {
  process.stderr.write(String((error as any)?.stack || (error as any)?.message || error) + '\n')
  process.exit(1)
})
