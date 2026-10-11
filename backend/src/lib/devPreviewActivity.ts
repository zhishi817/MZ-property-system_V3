import fs from 'fs'
import path from 'path'
import type { NextFunction, Request, Response } from 'express'

type ActivityState = {
  last_activity_ms: number
  active_requests: number
  reason: string
}

type ActivityEnvironment = Record<string, string | undefined>

export function isDevPreviewActivityEnabled(env: ActivityEnvironment = process.env) {
  return String(env.MZ_DEV_PREVIEW || '').trim() === '1'
    && String(env.APP_ENV || '').trim().toLowerCase() === 'dev'
    && String(env.DATABASE_ROLE || '').trim().toLowerCase() === 'dev'
    && path.isAbsolute(String(env.MZ_DEV_PREVIEW_ACTIVITY_FILE || '').trim())
}

export function shouldTrackDevPreviewBusinessRequest(req: Pick<Request, 'method' | 'path' | 'headers'>) {
  const method = String(req.method || '').toUpperCase()
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return false
  const requestPath = String(req.path || '')
  if (requestPath.startsWith('/health') || requestPath.startsWith('/_next') || requestPath.startsWith('/assets')) return false
  if (String(req.headers?.accept || '').toLowerCase().includes('text/event-stream')) return false
  if (String(req.headers?.['x-mz-dev-preview-background'] || '').trim() === '1') return false
  return true
}

export class DevPreviewActivityTracker {
  readonly enabled: boolean
  private readonly filePath: string
  private state: ActivityState

  constructor(env: ActivityEnvironment = process.env, now = Date.now()) {
    this.enabled = isDevPreviewActivityEnabled(env)
    this.filePath = String(env.MZ_DEV_PREVIEW_ACTIVITY_FILE || '').trim()
    this.state = { last_activity_ms: now, active_requests: 0, reason: 'backend_started' }
    if (this.enabled) this.persist()
  }

  mark(reason = 'client_interaction', now = Date.now()) {
    if (!this.enabled) return
    this.state.last_activity_ms = now
    this.state.reason = reason
    this.persist()
  }

  middleware = (req: Request, res: Response, next: NextFunction) => {
    if (!this.enabled || !shouldTrackDevPreviewBusinessRequest(req)) return next()
    this.state.active_requests += 1
    this.state.last_activity_ms = Date.now()
    this.state.reason = `request_started:${String(req.method || '').toUpperCase()}`
    this.persist()

    let settled = false
    const settle = () => {
      if (settled) return
      settled = true
      this.state.active_requests = Math.max(0, this.state.active_requests - 1)
      this.state.last_activity_ms = Date.now()
      this.state.reason = `request_finished:${String(req.method || '').toUpperCase()}`
      this.persist()
    }
    res.once('finish', settle)
    res.once('close', settle)
    next()
  }

  private persist() {
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    fs.writeFileSync(temporaryPath, `${JSON.stringify(this.state)}\n`, { mode: 0o600 })
    fs.renameSync(temporaryPath, this.filePath)
  }
}
