export function isValidMonthKey(v: string): boolean {
  return /^\d{4}-\d{2}$/.test(String(v || ''))
}

export function compareMonthKey(a: string, b: string): number {
  const aa = String(a || '')
  const bb = String(b || '')
  if (!isValidMonthKey(aa) || !isValidMonthKey(bb)) return 0
  if (aa === bb) return 0
  return aa < bb ? -1 : 1
}

export function shouldIncludeForMonth(startMonthKey: string | undefined, selectedMonthKey: string): boolean {
  if (!startMonthKey) return true
  if (!isValidMonthKey(startMonthKey) || !isValidMonthKey(selectedMonthKey)) return true
  return startMonthKey <= selectedMonthKey
}

export function shouldAutoMarkPaidForMonth(startMonthKey: string | undefined, selectedMonthKey: string, currentMonthKey: string): boolean {
  if (!startMonthKey) return false
  if (!isValidMonthKey(startMonthKey) || !isValidMonthKey(selectedMonthKey) || !isValidMonthKey(currentMonthKey)) return false
  if (selectedMonthKey < startMonthKey) return false
  return selectedMonthKey < currentMonthKey
}

