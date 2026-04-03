import { describe, expect, it } from 'vitest'
import { DEFAULT_MONTHLY_STATEMENT_CARRY_START_MONTH, resolveExcludeOrphanFixedSnapshotsParam, resolveMonthlyStatementCarryStartMonth } from './monthlyStatementPrint'

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
})
