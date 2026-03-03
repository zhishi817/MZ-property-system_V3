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

function monthKeyToIndex(monthKey: string): number {
  const [ys, ms] = String(monthKey || '').split('-')
  const y = Number(ys)
  const m = Number(ms)
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return NaN
  return y * 12 + (m - 1)
}

export function isDueForMonth(startMonthKey: string | undefined, selectedMonthKey: string, frequencyMonths: number | undefined): boolean {
  const start = String(startMonthKey || '')
  const sel = String(selectedMonthKey || '')
  if (!isValidMonthKey(sel)) return true
  if (start && !isValidMonthKey(start)) return true
  if (!start) return true
  const freq = Math.max(1, Math.min(24, Number(frequencyMonths || 1)))
  const a = monthKeyToIndex(start)
  const b = monthKeyToIndex(sel)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return true
  if (b < a) return false
  return ((b - a) % freq) === 0
}
