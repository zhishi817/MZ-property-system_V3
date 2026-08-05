import assert from 'assert'
import fs from 'fs'
import path from 'path'

process.env.DATABASE_URL = ''

async function main() {
  const { pendingStatusForPaidInvoice } = await import('../../src/modules/invoices')

  assert.equal(pendingStatusForPaidInvoice({ status: 'paid' }), 'issued')
  assert.equal(pendingStatusForPaidInvoice({ status: 'paid', sent_at: '2026-08-03T10:00:00.000Z' }), 'sent')
  assert.throws(() => pendingStatusForPaidInvoice({ status: 'issued' }), /only_paid_can_restore_pending/)
  assert.throws(() => pendingStatusForPaidInvoice({ status: 'paid', invoice_type: 'receipt' }), /cannot_restore_pending_receipt/)

  const source = fs.readFileSync(path.resolve(__dirname, '../../src/modules/invoices.ts'), 'utf8')
  const markPaid = source.slice(source.indexOf("router.post('/:id/mark-paid'"), source.indexOf("router.post('/:id/restore-pending'"))
  const restorePending = source.slice(source.indexOf("router.post('/:id/restore-pending'"), source.indexOf("router.post('/:id/record-payment'"))
  for (const route of [markPaid, restorePending]) {
    assert.match(route, /pgRunInTransaction\(async \(client\)/)
    assert.match(route, /await client\.query\(\s*`INSERT INTO invoice_payment_events/)
    assert.doesNotMatch(route, /await pgInsert\('invoice_payment_events'/)
  }

  process.stdout.write('test_invoice_payment_state: ok\n')
}

main().catch((error) => {
  process.stderr.write(String((error as any)?.stack || (error as any)?.message || error) + '\n')
  process.exit(1)
})
