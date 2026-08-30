export type PdfJobsWorkerMode = 'once' | 'daemon' | 'disabled'

export type PdfJobsWorkerModeResolution = {
  mode: PdfJobsWorkerMode
  reason: 'mode_missing' | 'mode_invalid' | null
}

/**
 * A worker without an explicit mode must never resume the legacy minute poll.
 * Render Cron Jobs use `once`; the old dedicated service may only use `daemon`
 * with a separately explicit cron expression.
 */
export function resolvePdfJobsWorkerMode(value: unknown): PdfJobsWorkerModeResolution {
  const raw = String(value ?? '').trim().toLowerCase()
  if (raw === 'once' || raw === 'daemon' || raw === 'disabled') return { mode: raw, reason: null }
  return { mode: 'disabled', reason: raw ? 'mode_invalid' : 'mode_missing' }
}

export function positiveInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Math.floor(Number(value))
  if (!Number.isFinite(parsed) || parsed < min) return fallback
  return Math.min(max, parsed)
}

export function pdfJobRetryDelayMs(attempts: number): number {
  const parsed = Number(attempts || 0)
  const n = Number.isFinite(parsed) ? Math.max(1, parsed) : 1
  if (n <= 1) return 60_000
  if (n === 2) return 5 * 60_000
  return 30 * 60_000
}

export function addPdfJobsRetryDueAt(dueAts: number[], dueAt: number): number[] {
  return Array.from(new Set([...dueAts, dueAt].filter((value) => Number.isFinite(value)))).sort((a, b) => a - b)
}

export function removeDuePdfJobsRetryDueAts(dueAts: number[], now: number): number[] {
  return dueAts.filter((dueAt) => dueAt > now)
}
