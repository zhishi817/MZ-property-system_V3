import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MONTHLY_STATEMENT_CARRY_START_MONTH,
  isMonthlyStatementBaseDataReady,
  resolveExcludeOrphanFixedSnapshotsParam,
  resolveMonthlyStatementCarryStartMonth,
  serializeMonthlyStatementLoadFailures,
  updateMonthlyStatementLoadFailures,
} from './monthlyStatementPrint'

describe('resolveExcludeOrphanFixedSnapshotsParam', () => {
  it('defaults to excluding orphan fixed snapshots when query is absent', () => {
    expect(resolveExcludeOrphanFixedSnapshotsParam(undefined)).toBe(true)
    expect(resolveExcludeOrphanFixedSnapshotsParam(null)).toBe(true)
    expect(resolveExcludeOrphanFixedSnapshotsParam('')).toBe(true)
  })

  it('allows explicit opt-in to include orphan fixed snapshots', () => {
    expect(resolveExcludeOrphanFixedSnapshotsParam('0')).toBe(false)
    expect(resolveExcludeOrphanFixedSnapshotsParam('1')).toBe(true)
  })

  it('defaults carry calculations to the configured start month', () => {
    expect(resolveMonthlyStatementCarryStartMonth(undefined)).toBe(DEFAULT_MONTHLY_STATEMENT_CARRY_START_MONTH)
    expect(resolveMonthlyStatementCarryStartMonth('')).toBe(DEFAULT_MONTHLY_STATEMENT_CARRY_START_MONTH)
    expect(resolveMonthlyStatementCarryStartMonth('2026-02')).toBe('2026-02')
  })

  it('keeps failed data sources deterministic and removes recovered sources', () => {
    let failed = updateMonthlyStatementLoadFailures([], 'finance', true)
    failed = updateMonthlyStatementLoadFailures(failed, 'orders', true)
    failed = updateMonthlyStatementLoadFailures(failed, 'finance', true)
    expect(failed).toEqual(['orders', 'finance'])
    expect(serializeMonthlyStatementLoadFailures(failed, 'maintenance,orders')).toBe('orders,finance,maintenance')

    failed = updateMonthlyStatementLoadFailures(failed, 'orders', false)
    expect(failed).toEqual(['finance'])
  })

  it('allows a genuine zero-data report only after every source loaded successfully', () => {
    const loaded = {
      isPrintMode: true,
      ordersLoaded: true,
      txsLoaded: true,
      propertiesLoaded: true,
      landlordsLoaded: true,
    }
    expect(isMonthlyStatementBaseDataReady(loaded)).toBe(true)
    expect(isMonthlyStatementBaseDataReady({ ...loaded, dataLoadError: 'finance' })).toBe(false)
    expect(isMonthlyStatementBaseDataReady({ ...loaded, ordersLoaded: false })).toBe(false)
  })
})
