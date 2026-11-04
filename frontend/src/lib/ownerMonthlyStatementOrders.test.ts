import dayjs from 'dayjs'
import { describe, expect, it } from 'vitest'
import { computePropertyRevenueMetrics } from './propertyRevenueMetrics'
import {
  getOwnerStatementMonthSegments,
  monthSegments,
  resolveOwnerStatementMonthSegments,
  shouldIncludeOrderInOwnerStatement,
} from './orders'
import { computeMonthlyStatementBalanceDebug } from './statementBalances'

describe('owner monthly statement order policy', () => {
  const orders: any[] = [
    { id: 'cancel-zero-unchecked', property_id: 'p1', checkin: '2026-03-02', checkout: '2026-03-04', net_income: 0, status: 'cancelled', count_in_income: false },
    { id: 'cancel-paid-checked', property_id: 'p1', checkin: '2026-03-05', checkout: '2026-03-07', net_income: 400, status: 'canceled', count_in_income: true },
    { id: 'cancel-paid-unchecked', property_id: 'p1', checkin: '2026-03-08', checkout: '2026-03-10', net_income: 300, status: 'CANCELLED', count_in_income: false },
    { id: 'normal-zero', property_id: 'p1', checkin: '2026-03-11', checkout: '2026-03-13', net_income: 0, status: 'confirmed', count_in_income: false },
    { id: 'normal-paid', property_id: 'p1', checkin: '2026-03-14', checkout: '2026-03-16', net_income: 500, status: 'confirmed', count_in_income: true },
    { id: 'restored', property_id: 'p1', checkin: '2026-03-17', checkout: '2026-03-18', net_income: 200, status: 'confirmed', count_in_income: true },
    { id: 'cancel-pending', property_id: 'p1', checkin: '2026-03-19', checkout: '2026-03-21', net_income: 250, status: 'cancellation_pending', count_in_income: false },
  ]

  it('excludes terminal cancelled states while preserving pending cancellation, normal $0, and restored stays', () => {
    expect(shouldIncludeOrderInOwnerStatement(orders[0])).toBe(false)
    expect(shouldIncludeOrderInOwnerStatement(orders[1])).toBe(false)
    expect(shouldIncludeOrderInOwnerStatement(orders[3])).toBe(true)
    expect(shouldIncludeOrderInOwnerStatement(orders[6])).toBe(true)

    const segments = getOwnerStatementMonthSegments(orders, dayjs('2026-03-01'))
    expect(segments.map((row) => row.id).sort()).toEqual(['cancel-pending', 'normal-paid', 'normal-zero', 'restored'])
    expect(segments.find((row) => row.id === 'normal-zero')?.nights).toBe(2)

    const rentIncome = segments.reduce((sum, row: any) => sum + Number(row.visible_net_income ?? row.net_income ?? 0), 0)
    const metrics = computePropertyRevenueMetrics({ orders: segments, daysInMonth: 31, rentIncome })
    expect(rentIncome).toBe(950)
    expect(metrics.guestNights).toBe(7)
    expect(metrics.occupancyRate).toBe(22.58)
    expect(metrics.dailyAverage).toBe(135.71)
  })

  it('removes a cancelled cross-month order from every month and restores it only after status recovery', () => {
    const cancelled: any = {
      id: 'cancel-cross-month',
      property_id: 'p1',
      checkin: '2026-03-30',
      checkout: '2026-04-03',
      net_income: 800,
      status: 'cancelled',
      count_in_income: true,
    }
    expect(getOwnerStatementMonthSegments([cancelled], dayjs('2026-03-01'))).toEqual([])
    expect(getOwnerStatementMonthSegments([cancelled], dayjs('2026-04-01'))).toEqual([])
    expect(getOwnerStatementMonthSegments([{ ...cancelled, status: 'cancellation_pending', count_in_income: false }], dayjs('2026-04-01'))).toHaveLength(1)
    expect(getOwnerStatementMonthSegments([{ ...cancelled, status: 'confirmed' }], dayjs('2026-04-01'))).toHaveLength(1)
  })

  it('keeps preview/PDF balance inputs, management fee basis, and owner payable free of cancellations', () => {
    const sharedSegments = monthSegments(orders, dayjs('2026-03-01'))
    expect(sharedSegments.some((row) => row.id === 'cancel-paid-checked')).toBe(true)
    expect(sharedSegments.some((row) => row.id === 'cancel-pending')).toBe(false)
    const serverLikeSegments = [
      ...sharedSegments,
      ...getOwnerStatementMonthSegments(orders.filter((row) => row.id === 'cancel-pending'), dayjs('2026-03-01')),
    ]

    const previewSegments = resolveOwnerStatementMonthSegments({
      orders,
      providedSegments: serverLikeSegments,
      monthStart: dayjs('2026-03-01'),
      propertyId: 'p1',
    })
    const pdfFallbackSegments = resolveOwnerStatementMonthSegments({
      orders,
      providedSegments: [],
      monthStart: dayjs('2026-03-01'),
      propertyId: 'p1',
    })
    expect(previewSegments).toEqual(pdfFallbackSegments)

    const debug = computeMonthlyStatementBalanceDebug({
      month: '2026-03',
      propertyId: 'p1',
      orders,
      orderSegments: serverLikeSegments,
      txs: [
        {
          id: 'company-cancel-income',
          kind: 'income',
          amount: 250,
          currency: 'AUD',
          property_id: 'p1',
          occurred_at: '2026-03-06',
          category: 'cancel_fee',
          ref_type: 'order',
          ref_id: 'cancel-paid-checked',
        },
      ],
      managementFeeRate: 0.1,
      carryStartMonth: '2026-03',
    })

    expect(debug.target.contributing_order_ids.sort()).toEqual([
      'cancel-pending|202603',
      'normal-paid|202603',
      'normal-zero|202603',
      'restored|202603',
    ])
    expect(debug.target.contributing_income_tx_ids).toEqual([])
    expect(debug.target.operating_entries.find((entry) => entry.source === 'management_fee')?.signed_amount).toBe(-95)
    expect(debug.result.operating_net_income).toBe(855)
    expect(debug.result.payable_to_owner).toBe(855)
  })
})
