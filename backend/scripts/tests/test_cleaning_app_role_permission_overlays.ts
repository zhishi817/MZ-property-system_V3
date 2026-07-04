import assert from 'assert'

process.env.DATABASE_URL = ''

async function main() {
  const { listPermissionCodesForUser } = await import('../../src/auth')

  const cleaner = await listPermissionCodesForUser({ sub: 'test-cleaner', role: 'cleaner', roles: ['cleaner'] })
  assert.ok(cleaner.includes('cleaning_app.tasks.start'), 'cleaner can upload key photo')
  assert.ok(cleaner.includes('cleaning_app.tasks.finish'), 'cleaner can submit consumables')
  assert.ok(cleaner.includes('cleaning_app.media.upload'), 'cleaner can upload media')

  const inspector = await listPermissionCodesForUser({ sub: 'test-inspector', role: 'cleaning_inspector', roles: ['cleaning_inspector'] })
  assert.ok(inspector.includes('cleaning_app.inspect.finish'), 'inspector can submit inspection photos')
  assert.ok(inspector.includes('cleaning_app.tasks.finish'), 'inspector can complete site actions')
  assert.ok(inspector.includes('cleaning_app.media.upload'), 'inspector can upload media')

  const combined = await listPermissionCodesForUser({ sub: 'test-combined', role: 'cleaner_inspector', roles: ['cleaner_inspector'] })
  assert.ok(combined.includes('cleaning_app.tasks.start'), 'combined role can upload key photo')
  assert.ok(combined.includes('cleaning_app.tasks.finish'), 'combined role can submit completion actions')
  assert.ok(combined.includes('cleaning_app.inspect.finish'), 'combined role can submit inspection photos')

  const customerService = await listPermissionCodesForUser({ sub: 'test-cs', role: 'customer_service', roles: ['customer_service'] })
  assert.ok(customerService.includes('cleaning_app.expense.company.submit'), 'customer service can submit company expense')
  assert.ok(customerService.includes('cleaning_app.expense.property.submit'), 'customer service can submit property expense')

  const finance = await listPermissionCodesForUser({ sub: 'test-finance', role: 'finance_staff', roles: ['finance_staff'] })
  assert.ok(finance.includes('cleaning_app.expense.company.submit'), 'finance staff can submit company expense')
  assert.ok(finance.includes('cleaning_app.expense.property.submit'), 'finance staff can submit property expense')

  process.stdout.write('test_cleaning_app_role_permission_overlays: ok\n')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
