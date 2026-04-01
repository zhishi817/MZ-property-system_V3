import { db } from '../../src/store'
import { __test as ordersTest } from '../../src/modules/orders'

async function main() {
  const { isInactiveOrderStatus } = ordersTest as any
  if (typeof isInactiveOrderStatus !== 'function') throw new Error('missing isInactiveOrderStatus')

  db.orders.length = 0
  db.orders.push({
    id: 'o1',
    source: 'airbnb',
    property_id: 'p1',
    checkin: '2026-01-01',
    checkout: '2026-01-05',
    status: 'cancelled',
    idempotency_key: 'p1-2026-01-01-2026-01-05',
  } as any)

  const key = 'p1-2026-01-01-2026-01-05'
  const exists = db.orders.find((x: any) => x.idempotency_key === key && !isInactiveOrderStatus((x as any).status))
  if (exists) throw new Error('cancelled order should not block idempotency')
  process.stdout.write('ok\n')
}

main().catch((e) => {
  process.stderr.write(String(e?.stack || e?.message || e) + '\n')
  process.exit(1)
})
