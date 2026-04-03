import { describe, expect, it } from 'vitest'
import { resolveExcludeOrphanFixedSnapshotsParam } from './monthlyStatementPrint'

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
})
