import { describe, expect, it } from 'vitest'
import { computePropertyRevenueMetrics } from './propertyRevenueMetrics'

describe('computePropertyRevenueMetrics', () => {
  it('excludes owner stay nights from occupancy and daily average', () => {
    const result = computePropertyRevenueMetrics({
      orders: [
        { stay_type: 'owner', nights: 13 },
        { stay_type: 'guest', nights: 6 },
        { stay_type: 'guest', nights: 4 },
        { stay_type: 'guest', nights: 1 },
        { stay_type: 'guest', nights: 6 },
      ],
      daysInMonth: 31,
      rentIncome: 2019.63,
    })

    expect(result.ownerNights).toBe(13)
    expect(result.guestNights).toBe(17)
    expect(result.availableDays).toBe(18)
    expect(result.occupancyRate).toBe(94.44)
    expect(result.dailyAverage).toBe(118.8)
  })
})
