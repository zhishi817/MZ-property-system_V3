import { describe, expect, it, vi } from 'vitest'
import {
  PROPERTY_REVENUE_REFERENCE_STALE_MS,
  PROPERTY_REVENUE_RESUME_STALE_MS,
  claimPropertyRevenueInitialLoad,
  claimPropertyRevenueRangeChange,
  createPropertyRevenueReloadLifecycle,
  shouldRefreshPropertyRevenueOnResume,
  shouldRefreshPropertyRevenueReferences,
} from './propertyRevenueRefreshPolicy'

describe('propertyRevenueRefreshPolicy', () => {
  it('keeps Strict Mode effect replay to one initial request and one request per real range change', () => {
    vi.useFakeTimers()
    try {
      const lifecycle = createPropertyRevenueReloadLifecycle()
      let requestCount = 0
      const runEffects = (rangeKey: string) => {
        if (claimPropertyRevenueInitialLoad(lifecycle)) setTimeout(() => { requestCount += 1 }, 0)
        if (claimPropertyRevenueRangeChange(lifecycle, rangeKey)) setTimeout(() => { requestCount += 1 }, 0)
      }

      runEffects('2026-08|2026-08')
      runEffects('2026-08|2026-08')
      vi.runAllTimers()
      expect(requestCount).toBe(1)

      runEffects('2026-09|2026-09')
      runEffects('2026-09|2026-09')
      vi.runAllTimers()
      expect(requestCount).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not refresh on hidden, paused, or still-fresh resume events', () => {
    const now = 1_000_000
    expect(shouldRefreshPropertyRevenueOnResume({ isVisible: false, isPaused: false, lastSuccessfulRefreshAt: 0, now })).toBe(false)
    expect(shouldRefreshPropertyRevenueOnResume({ isVisible: true, isPaused: true, lastSuccessfulRefreshAt: 0, now })).toBe(false)
    expect(shouldRefreshPropertyRevenueOnResume({
      isVisible: true,
      isPaused: false,
      lastSuccessfulRefreshAt: now - PROPERTY_REVENUE_RESUME_STALE_MS + 1,
      now,
    })).toBe(false)
  })

  it('refreshes on first resume or once the 60-second freshness window expires', () => {
    const now = 1_000_000
    expect(shouldRefreshPropertyRevenueOnResume({ isVisible: true, isPaused: false, lastSuccessfulRefreshAt: 0, now })).toBe(true)
    expect(shouldRefreshPropertyRevenueOnResume({
      isVisible: true,
      isPaused: false,
      lastSuccessfulRefreshAt: now - PROPERTY_REVENUE_RESUME_STALE_MS,
      now,
    })).toBe(true)
  })

  it('reuses reference data for five minutes and refreshes missing or stale data', () => {
    const now = 1_000_000
    expect(shouldRefreshPropertyRevenueReferences({ hasCachedData: false, lastSuccessfulRefreshAt: now, now })).toBe(true)
    expect(shouldRefreshPropertyRevenueReferences({
      hasCachedData: true,
      lastSuccessfulRefreshAt: now - PROPERTY_REVENUE_REFERENCE_STALE_MS + 1,
      now,
    })).toBe(false)
    expect(shouldRefreshPropertyRevenueReferences({
      hasCachedData: true,
      lastSuccessfulRefreshAt: now - PROPERTY_REVENUE_REFERENCE_STALE_MS,
      now,
    })).toBe(true)
  })
})
