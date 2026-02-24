import assert from 'assert'
import { __test_dayOnly } from '../../src/services/cleaningSync'

function main() {
  assert.equal(__test_dayOnly(new Date('2026-02-01T00:00:00.000Z')), '2026-02-01')
  assert.equal(__test_dayOnly('2026-02-01'), '2026-02-01')
  assert.equal(__test_dayOnly('2026-02-01T12:00:00Z'), '2026-02-01')
  assert.equal(__test_dayOnly('2026-02-01 00:00:00+00'), '2026-02-01')
  assert.equal(__test_dayOnly('2026-02-01 00:00:00.000+00'), '2026-02-01')
  assert.equal(__test_dayOnly('Sat Feb 01 2026 00:00:00 GMT+0000 (UTC)'), '2026-02-01')
  process.stdout.write('ok\n')
}

main()

