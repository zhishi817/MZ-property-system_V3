export const DEFAULT_MONTHLY_STATEMENT_CARRY_START_MONTH = '2026-01'

export const MONTHLY_STATEMENT_LOAD_SOURCES = [
  'properties',
  'orders',
  'rent_segments',
  'landlords',
  'finance',
  'property_expenses',
  'recurring_payments',
  'deep_cleaning',
  'maintenance',
] as const

export type MonthlyStatementLoadSource = typeof MONTHLY_STATEMENT_LOAD_SOURCES[number]

export function updateMonthlyStatementLoadFailures(
  current: readonly MonthlyStatementLoadSource[],
  source: MonthlyStatementLoadSource,
  failed: boolean,
): MonthlyStatementLoadSource[] {
  const next = new Set(current)
  if (failed) next.add(source)
  else next.delete(source)
  return MONTHLY_STATEMENT_LOAD_SOURCES.filter(item => next.has(item))
}

export function serializeMonthlyStatementLoadFailures(
  ...groups: Array<string | readonly MonthlyStatementLoadSource[] | null | undefined>
): string {
  const selected = new Set<string>()
  for (const group of groups) {
    const values = Array.isArray(group) ? group : String(group || '').split(',')
    values.forEach(value => selected.add(String(value || '').trim()))
  }
  return MONTHLY_STATEMENT_LOAD_SOURCES.filter(source => selected.has(source)).join(',')
}

export function isMonthlyStatementBaseDataReady(input: {
  isPrintMode: boolean
  ordersLoaded?: boolean
  txsLoaded?: boolean
  propertiesLoaded?: boolean
  landlordsLoaded?: boolean
  dataLoadError?: string
}): boolean {
  if (!input.isPrintMode) return true
  return !serializeMonthlyStatementLoadFailures(input.dataLoadError)
    && input.ordersLoaded !== false
    && input.txsLoaded !== false
    && input.propertiesLoaded !== false
    && input.landlordsLoaded !== false
}

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
