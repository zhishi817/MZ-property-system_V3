import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const DEFAULT_PREVIEW_IDLE_TIMEOUT_SECONDS = 300

export function resolvePreviewIdleTimeoutMs(rawValue, fallbackSeconds = DEFAULT_PREVIEW_IDLE_TIMEOUT_SECONDS) {
  const parsed = Number(rawValue)
  const seconds = Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackSeconds
  return Math.floor(seconds * 1000)
}

export function resolvePreviewRuntimeIdleTimeoutMs(rawValue, overrideEnabled = false) {
  return resolvePreviewIdleTimeoutMs(overrideEnabled ? rawValue : undefined)
}

export function createPreviewActivityState(now = Date.now(), reason = 'launcher_ready') {
  return {
    last_activity_ms: Math.floor(now),
    active_requests: 0,
    reason,
  }
}

export function writePreviewActivityState(filePath, state) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${process.pid}.tmp`
  fs.writeFileSync(temporaryPath, `${JSON.stringify(state)}\n`, { mode: 0o600 })
  fs.renameSync(temporaryPath, filePath)
}

export function readPreviewActivityState(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    const lastActivityMs = Number(parsed?.last_activity_ms)
    const activeRequests = Number(parsed?.active_requests)
    if (!Number.isFinite(lastActivityMs) || !Number.isFinite(activeRequests)) return null
    return {
      last_activity_ms: Math.floor(lastActivityMs),
      active_requests: Math.max(0, Math.floor(activeRequests)),
      reason: String(parsed?.reason || ''),
    }
  } catch {
    return null
  }
}

export function shouldStopPreviewForIdle({ now = Date.now(), state, timeoutMs }) {
  if (!state || Number(state.active_requests) > 0) return false
  return Number(now) - Number(state.last_activity_ms) >= Number(timeoutMs)
}

function privateIpv4(address) {
  if (/^10\./.test(address)) return true
  if (/^192\.168\./.test(address)) return true
  const match = address.match(/^172\.(\d+)\./)
  return !!match && Number(match[1]) >= 16 && Number(match[1]) <= 31
}

export function resolvePreviewLanHost(explicitHost = '', networkInterfaces = os.networkInterfaces()) {
  const requested = String(explicitHost || '').trim()
  if (requested) {
    if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(requested)) throw new Error('MZ_DEV_PREVIEW_LAN_HOST must be an IPv4 address')
    return requested
  }

  const candidates = []
  for (const entries of Object.values(networkInterfaces || {})) {
    for (const entry of entries || []) {
      if (entry?.family !== 'IPv4' || entry?.internal || !privateIpv4(String(entry.address || ''))) continue
      candidates.push(String(entry.address))
    }
  }
  const unique = Array.from(new Set(candidates))
  if (unique.length !== 1) {
    throw new Error(`unable to select one private LAN IPv4 address; set MZ_DEV_PREVIEW_LAN_HOST explicitly (found=${unique.length})`)
  }
  return unique[0]
}
