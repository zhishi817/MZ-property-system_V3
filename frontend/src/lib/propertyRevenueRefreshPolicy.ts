export const PROPERTY_REVENUE_RESUME_STALE_MS = 60_000
export const PROPERTY_REVENUE_REFERENCE_STALE_MS = 5 * 60_000

export type PropertyRevenueReloadLifecycle = {
  initialLoadStarted: boolean
  rangeKey: string | null
}

export const createPropertyRevenueReloadLifecycle = (): PropertyRevenueReloadLifecycle => ({
  initialLoadStarted: false,
  rangeKey: null,
})

export const claimPropertyRevenueInitialLoad = (lifecycle: PropertyRevenueReloadLifecycle) => {
  if (lifecycle.initialLoadStarted) return false
  lifecycle.initialLoadStarted = true
  return true
}

export const claimPropertyRevenueRangeChange = (lifecycle: PropertyRevenueReloadLifecycle, rangeKey: string) => {
  if (lifecycle.rangeKey === null) {
    lifecycle.rangeKey = rangeKey
    return false
  }
  if (lifecycle.rangeKey === rangeKey) return false
  lifecycle.rangeKey = rangeKey
  return true
}

const isFresh = (lastSuccessfulAt: number, now: number, maxAgeMs: number) => {
  if (!(lastSuccessfulAt > 0) || now < lastSuccessfulAt) return false
  return now - lastSuccessfulAt < maxAgeMs
}

export const shouldRefreshPropertyRevenueOnResume = ({
  isVisible,
  isPaused,
  lastSuccessfulRefreshAt,
  now,
}: {
  isVisible: boolean
  isPaused: boolean
  lastSuccessfulRefreshAt: number
  now: number
}) => {
  if (!isVisible || isPaused) return false
  return !isFresh(lastSuccessfulRefreshAt, now, PROPERTY_REVENUE_RESUME_STALE_MS)
}

export const shouldRefreshPropertyRevenueReferences = ({
  hasCachedData,
  lastSuccessfulRefreshAt,
  now,
}: {
  hasCachedData: boolean
  lastSuccessfulRefreshAt: number
  now: number
}) => {
  if (!hasCachedData) return true
  return !isFresh(lastSuccessfulRefreshAt, now, PROPERTY_REVENUE_REFERENCE_STALE_MS)
}
