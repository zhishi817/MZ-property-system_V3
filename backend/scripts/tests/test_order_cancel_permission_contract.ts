import assert from 'assert'
import express from 'express'

process.env.DATABASE_URL = ''

type TestUser = {
  sub: string
  role: string
  roles: string[]
}

async function requestJson(router: express.Router, user: TestUser, orderId: string, body: any) {
  const app = express()
  app.use(express.json())
  app.use((req: any, _res, next) => {
    req.user = user
    next()
  })
  app.use('/orders', router)
  const server = await new Promise<any>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
  })
  try {
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const response = await fetch(`http://127.0.0.1:${port}/orders/${orderId}`, {
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
  const { router, hasOrderCancelPermission } = await import('../../src/modules/orders')

  const insertedRoleIds = new Set(['role.order_editor_only', 'role.order_cancel_operator', 'role.order_cancel_override_only'])
  const originalOrders = db.orders.slice()
  const originalAudits = db.audits.slice()
  const customerServiceOverrideAlreadyExists = db.rolePermissions.some(
    (row) => row.role_id === 'role.customer_service' && row.permission_code === 'order.cancel.override',
  )

  db.roles.push(
    { id: 'role.order_editor_only', name: 'order_editor_only', description: 'test only' },
    { id: 'role.order_cancel_operator', name: 'order_cancel_operator', description: 'test only' },
    { id: 'role.order_cancel_override_only', name: 'order_cancel_override_only', description: 'test only' },
  )
  db.rolePermissions.push(
    { role_id: 'role.order_editor_only', permission_code: 'order.write' },
    { role_id: 'role.order_cancel_operator', permission_code: 'order.write' },
    { role_id: 'role.order_cancel_operator', permission_code: 'order.cancel' },
    { role_id: 'role.order_cancel_override_only', permission_code: 'order.write' },
    { role_id: 'role.order_cancel_override_only', permission_code: 'order.cancel.override' },
  )
  if (!customerServiceOverrideAlreadyExists) {
    db.rolePermissions.push({ role_id: 'role.customer_service', permission_code: 'order.cancel.override' })
  }

  const customPrimaryWithCustomerService: TestUser = {
    sub: 'test-multi-role',
    role: 'Finance_staff_assistant',
    roles: ['Finance_staff_assistant', 'customer_service'],
  }
  const editorOnly: TestUser = {
    sub: 'test-editor-only',
    role: 'order_editor_only',
    roles: ['order_editor_only'],
  }
  const cancelWithoutOverride: TestUser = {
    sub: 'test-cancel-no-override',
    role: 'order_cancel_operator',
    roles: ['order_cancel_operator'],
  }
  const overrideWithoutCancel: TestUser = {
    sub: 'test-override-no-cancel',
    role: 'order_cancel_override_only',
    roles: ['order_cancel_override_only'],
  }

  const resetOrder = () => {
    db.orders.length = 0
    db.orders.push({
      id: 'order-cancel-permission-contract',
      source: 'airbnb',
      property_id: 'test-property',
      checkin: '2026-10-18',
      checkout: '2026-10-24',
      status: 'confirmed',
      note: 'before',
    } as any)
  }

  try {
    assert.equal(await hasOrderCancelPermission(customPrimaryWithCustomerService, false), true)
    assert.equal(await hasOrderCancelPermission(customPrimaryWithCustomerService, true), true)
    assert.equal(await hasOrderCancelPermission(editorOnly, false), false)
    assert.equal(await hasOrderCancelPermission(cancelWithoutOverride, false), true)
    assert.equal(await hasOrderCancelPermission(cancelWithoutOverride, true), false)
    assert.equal(await hasOrderCancelPermission(overrideWithoutCancel, true), false)

    resetOrder()
    const ordinaryEdit = await requestJson(router, editorOnly, 'order-cancel-permission-contract', { note: 'after' })
    assert.equal(ordinaryEdit.status, 200)
    assert.equal(ordinaryEdit.body?.note, 'after')
    assert.equal(ordinaryEdit.body?.status, 'confirmed')

    resetOrder()
    const deniedCancel = await requestJson(router, editorOnly, 'order-cancel-permission-contract', { status: 'cancelled' })
    assert.equal(deniedCancel.status, 403)
    assert.equal(deniedCancel.body?.code, 'ORDER_CANCEL_FORBIDDEN')
    assert.equal(db.orders[0]?.status, 'confirmed')

    resetOrder()
    const multiRoleCancel = await requestJson(router, customPrimaryWithCustomerService, 'order-cancel-permission-contract', { status: 'cancelled' })
    assert.equal(multiRoleCancel.status, 200)
    assert.equal(multiRoleCancel.body?.status, 'cancelled')

    process.stdout.write('test_order_cancel_permission_contract: ok\n')
  } finally {
    db.orders.length = 0
    db.orders.push(...originalOrders)
    db.audits.length = 0
    db.audits.push(...originalAudits)
    db.roles = db.roles.filter((role) => !insertedRoleIds.has(role.id))
    db.rolePermissions = db.rolePermissions.filter((row) => {
      if (insertedRoleIds.has(row.role_id)) return false
      if (!customerServiceOverrideAlreadyExists && row.role_id === 'role.customer_service' && row.permission_code === 'order.cancel.override') return false
      return true
    })
  }
}

main().catch((error) => {
  process.stderr.write(String((error as any)?.stack || (error as any)?.message || error) + '\n')
  process.exit(1)
})
