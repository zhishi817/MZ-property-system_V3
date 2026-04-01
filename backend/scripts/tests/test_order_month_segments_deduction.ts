import assert from 'assert'
import { splitOrderByMonths } from '../../src/lib/orderMonthSegments'

function round2(n: any): number {
  const x = Number(n || 0)
  if (!Number.isFinite(x)) return 0
  return Number(x.toFixed(2))
}

function sum2(arr: any[], key: string): number {
  return round2(arr.reduce((s, x) => s + Number((x as any)?.[key] || 0), 0))
}

function main() {
  {
    const order: any = {
      id: 'o1',
      property_id: 'p1',
      checkin: '2026-03-29',
      checkout: '2026-04-02',
      net_income: 318.85,
      cleaning_fee: 0,
      internal_deduction_total: 50,
      status: 'confirmed',
      count_in_income: true,
    }
    const segs = splitOrderByMonths(order)
    assert.equal(segs.length, 2)
    assert.equal(sum2(segs as any, 'internal_deduction'), 50)
    assert.equal(sum2(segs as any, 'visible_net_income'), 268.85)
    assert.equal(segs[0].nights, 3)
    assert.equal(round2(segs[0].visible_net_income), 201.64)
    assert.equal(segs[1].nights, 1)
    assert.equal(round2(segs[1].visible_net_income), 67.21)
  }

  {
    const order: any = {
      id: 'o2',
      property_id: 'p1',
      checkin: '2026-03-01',
      checkout: '2026-03-04',
      net_income: 239.14,
      cleaning_fee: 0,
      internal_deduction_total: 50,
      status: 'confirmed',
      count_in_income: true,
    }
    const segs = splitOrderByMonths(order)
    assert.equal(segs.length, 1)
    assert.equal(sum2(segs as any, 'internal_deduction'), 50)
    assert.equal(sum2(segs as any, 'visible_net_income'), 189.14)
  }

  console.log('OK test_order_month_segments_deduction')
}

main()

