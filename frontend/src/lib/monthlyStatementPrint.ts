export const DEFAULT_MONTHLY_STATEMENT_CARRY_START_MONTH = '2026-01'

export function resolveExcludeOrphanFixedSnapshotsParam(raw: string | null | undefined): boolean {
  if (raw === '0') return false
  if (raw === '1') return true
  return true
}

export function resolveMonthlyStatementCarryStartMonth(raw: string | null | undefined): string {
  const v = String(raw || '').trim()
  if (/^\d{4}-\d{2}$/.test(v)) return v
  return DEFAULT_MONTHLY_STATEMENT_CARRY_START_MONTH
}
