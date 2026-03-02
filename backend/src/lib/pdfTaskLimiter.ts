import { AsyncSemaphore } from './asyncSemaphore'

function clampInt(v: any, min: number, max: number, fallback: number) {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  const i = Math.floor(n)
  return Math.max(min, Math.min(max, i))
}

const max = clampInt(process.env.PDF_TASK_CONCURRENCY, 1, 4, 1)
const queueLimit = clampInt(process.env.PDF_TASK_QUEUE_LIMIT, 0, 200, 10)

export const pdfTaskLimiter = new AsyncSemaphore(max, queueLimit)
export const pdfTaskLimiterConfig = { max, queueLimit }
