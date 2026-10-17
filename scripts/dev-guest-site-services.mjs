import { execFileSync, spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyPreparedEnvironment } from './dev-preview-db.mjs'

const SCRIPT_FILE = fileURLToPath(import.meta.url)
const ROOT = path.resolve(path.dirname(SCRIPT_FILE), '..')
const RUNTIME_DIR = path.join(ROOT, '.dev-preview', 'guest-site-services')
const LOG_DIR = path.join(RUNTIME_DIR, 'logs')
const STATE_FILE = path.join(RUNTIME_DIR, 'state.json')
const LOOPBACK_HOST = '127.0.0.1'
const ACTIVITY_PORT = 4013
const DEFAULT_IDLE_TIMEOUT_MS = 300_000
const BACKEND_URL = `http://${LOOPBACK_HOST}:4012`
const PROPERTY_ID = '233a33d3-5a77-4b53-b6ae-8d806f9ea2d4'
const PREVIEW_URL = `http://${LOOPBACK_HOST}:3004/properties/${PROPERTY_ID}`
const npmExecutable = process.platform === 'win32' ? 'npm.cmd' : 'npm'

const SAFE_FALSE_FLAGS = [
  'EMAIL_SYNC_SCHEDULE_ENABLED',
  'EMAIL_SYNC_WATCHDOG_ENABLED',
  'NOTIFICATION_WORKER_ENABLED',
  'NOTIFICATION_WORKER_RUN_ON_START',
  'CLEANING_SYNC_JOBS_ENABLED',
  'CLEANING_SYNC_JOBS_EVENT_ENABLED',
  'CLEANING_SYNC_RETRY_ENABLED',
  'CLEANING_BACKFILL_FAST_ENABLED',
  'CLEANING_BACKFILL_SLOW_ENABLED',
  'JOB_RUNS_PRUNE_ENABLED',
  'KEY_UPLOAD_SLA_ENABLED',
  'KEY_UPLOAD_REMINDER_ENABLED',
  'DAY_END_HANDOVER_REMINDER_ENABLED',
  'PERSONNEL_SETTLEMENT_WEEKLY_ENABLED',
  'FEATURE_CLEANING_APP',
]

const SERVICE_PORTS = { booking: 3004, admin: 3006, backend: 4012 }
const MANAGED_PORTS = { ...SERVICE_PORTS, activity: ACTIVITY_PORT }
const ACTIVITY_ORIGINS = new Set([
  `http://${LOOPBACK_HOST}:3004`,
  'http://localhost:3004',
  `http://${LOOPBACK_HOST}:3006`,
  'http://localhost:3006',
])

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function ensureRuntimeDirectories() {
  fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 })
  try { fs.chmodSync(RUNTIME_DIR, 0o700) } catch {}
  try { fs.chmodSync(LOG_DIR, 0o700) } catch {}
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) } catch { return null }
}

function writeState(state) {
  ensureRuntimeDirectories()
  const next = `${STATE_FILE}.${process.pid}.tmp`
  fs.writeFileSync(next, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  fs.chmodSync(next, 0o600)
  fs.renameSync(next, STATE_FILE)
}

function pidIsAlive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) < 1) return false
  try {
    process.kill(Number(pid), 0)
    return true
  } catch (error) {
    if (error?.code === 'EPERM') return true
    return false
  }
}

export function isPathInside(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function listenerPids(port) {
  try {
    return execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' })
      .split(/\s+/g).map(Number).filter(Number.isFinite)
  } catch {
    return []
  }
}

function processCwd(pid) {
  try {
    const output = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' })
    return output.split(/\r?\n/g).find((line) => line.startsWith('n'))?.slice(1) || ''
  } catch {
    return ''
  }
}

function killProcessGroup(pid, signal = 'SIGTERM') {
  if (!pidIsAlive(pid)) return
  try { process.kill(-Number(pid), signal) } catch {
    try { process.kill(Number(pid), signal) } catch {}
  }
}

async function waitForPortsToClear(timeoutMs = 20000, ports = MANAGED_PORTS) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (Object.values(ports).every((port) => listenerPids(port).length === 0)) return true
    await wait(250)
  }
  return Object.values(ports).every((port) => listenerPids(port).length === 0)
}

async function stopManagedProcesses({ quiet = false } = {}) {
  const state = readState()
  if (state?.workspace && state.workspace !== ROOT) throw new Error('runtime state belongs to another workspace')

  if (state?.idle_monitor?.pid && pidIsAlive(state.idle_monitor.pid)) killProcessGroup(state.idle_monitor.pid)
  for (const service of Object.values(state?.services || {})) {
    if (service?.pid && pidIsAlive(service.pid)) killProcessGroup(service.pid)
  }
  await wait(500)

  for (const [name, port] of Object.entries(MANAGED_PORTS)) {
    for (const pid of listenerPids(port)) {
      const cwd = processCwd(pid)
      if (!cwd || !isPathInside(cwd, ROOT)) {
        throw new Error(`${name} port ${port} belongs to another process; refusing to stop pid ${pid}`)
      }
      process.kill(pid, 'SIGTERM')
    }
  }

  if (!(await waitForPortsToClear())) {
    throw new Error('managed preview processes did not stop cleanly; no force kill was attempted')
  }

  writeState({
    version: 1,
    workspace: ROOT,
    environment: 'MZ-Dev-Preview',
    status: 'stopped',
    stopped_at: new Date().toISOString(),
    stop_reason: 'manual',
    services: {},
    idle_monitor: null,
  })
  if (!quiet) console.log('[MZ preview] stopped; backend process and its database pool are closed')
}

export function assertGuestSiteRuntimeSafety(env) {
  if (String(env.APP_ENV || '').toLowerCase() !== 'dev') throw new Error('APP_ENV must be dev')
  if (String(env.DATABASE_ROLE || '').toLowerCase() !== 'dev') throw new Error('DATABASE_ROLE must be dev')
  if (String(env.MZ_DEV_PREVIEW || '') !== '1') throw new Error('MZ_DEV_PREVIEW must be enabled')
  if (/^(?:prod|production)$/i.test(String(env.NODE_ENV || ''))) throw new Error('NODE_ENV cannot be production')
  if (String(env.PORT_OVERRIDE || '') !== '4012') throw new Error('backend port must be 4012')
  if (String(env.DEV_PREVIEW_BIND_HOST || '') !== LOOPBACK_HOST) throw new Error('backend must bind to 127.0.0.1')
  if (String(env.MZ_DEV_PREVIEW_DISABLE_RUNTIME_DDL || '') !== '1') throw new Error('runtime DDL must be disabled')
  if (String(env.STARTUP_WARMUP_MODE || '') !== 'readonly') throw new Error('startup warmups must be read-only')
  if (String(env.PDF_JOBS_MODE || '').toLowerCase() !== 'disabled') throw new Error('PDF jobs must be disabled')
  for (const key of SAFE_FALSE_FLAGS) {
    if (String(env[key] || '').toLowerCase() !== 'false') throw new Error(`${key} must be false`)
  }
  return true
}

function safeBackendEnvironment(verified) {
  const env = {
    ...process.env,
    ...verified.env,
    APP_ENV: 'dev',
    DATABASE_ROLE: 'dev',
    NODE_ENV: 'development',
    MZ_DEV_PREVIEW: '1',
    PORT_OVERRIDE: '4012',
    DEV_PREVIEW_BIND_HOST: LOOPBACK_HOST,
    MZ_DEV_PREVIEW_DISABLE_RUNTIME_DDL: '1',
    STARTUP_WARMUP_MODE: 'readonly',
    PDF_JOBS_MODE: 'disabled',
    PG_POOL_MAX: '2',
    PG_IDLE_TIMEOUT_MS: '30000',
    PG_MAX_LIFETIME_SECONDS: '300',
    FRONTEND_BASE_URL: `http://${LOOPBACK_HOST}:3006`,
    FRONTEND_URL: `http://${LOOPBACK_HOST}:3006`,
    ALLOWED_ORIGINS: [
      `http://${LOOPBACK_HOST}:3004`,
      'http://localhost:3004',
      `http://${LOOPBACK_HOST}:3006`,
      'http://localhost:3006',
    ].join(','),
  }
  for (const key of SAFE_FALSE_FLAGS) env[key] = 'false'
  assertGuestSiteRuntimeSafety(env)
  return env
}

function serviceDefinitions(backendEnv, idleSession) {
  const webEnv = {
    ...process.env,
    NODE_ENV: 'development',
    NEXT_PUBLIC_API_BASE_URL: BACKEND_URL,
    NEXT_PUBLIC_API_BASE_DEV: BACKEND_URL,
    INTERNAL_API_BASE_URL: BACKEND_URL,
    NEXT_PUBLIC_BOOKING_SITE_URL: `http://${LOOPBACK_HOST}:3004`,
    NEXT_PUBLIC_ADMIN_FRONTEND_URL: `http://${LOOPBACK_HOST}:3006`,
    NEXT_PUBLIC_MZ_PREVIEW_ACTIVITY_ENDPOINT: `http://${LOOPBACK_HOST}:${ACTIVITY_PORT}`,
    NEXT_PUBLIC_MZ_PREVIEW_SESSION_ID: idleSession.sessionId,
    NEXT_PUBLIC_MZ_PREVIEW_ACTIVITY_TOKEN: idleSession.token,
  }
  return {
    backend: {
      port: SERVICE_PORTS.backend,
      cwd: path.join(ROOT, 'backend'),
      args: ['run', 'dev'],
      env: backendEnv,
      health: async () => {
        const config = await fetchJson(`${BACKEND_URL}/health/config`)
        if (config.response.status !== 200 || config.payload?.app_env !== 'dev' || config.payload?.database_role !== 'dev') return false
        const ready = await fetchJson(`${BACKEND_URL}/health/ready`)
        return ready.response.status === 200 && ready.payload?.status === 'ok'
      },
    },
    booking: {
      port: SERVICE_PORTS.booking,
      cwd: path.join(ROOT, 'booking-frontend'),
      args: ['run', 'dev', '--', '--hostname', LOOPBACK_HOST],
      env: { ...webEnv, PORT: '3004' },
      health: () => fetchOk(`http://${LOOPBACK_HOST}:3004/`),
    },
    admin: {
      port: SERVICE_PORTS.admin,
      cwd: path.join(ROOT, 'frontend'),
      args: ['run', 'dev', '--', '--port', '3006', '--hostname', LOOPBACK_HOST],
      env: { ...webEnv, PORT: '3006' },
      health: () => fetchOk(`http://${LOOPBACK_HOST}:3006/login`),
    },
  }
}

export function idleTimeoutMsFromEnv(env = process.env) {
  if (env.MZ_PREVIEW_IDLE_TEST_MODE !== '1') return DEFAULT_IDLE_TIMEOUT_MS
  const requested = Number(env.MZ_PREVIEW_IDLE_TIMEOUT_MS)
  if (!Number.isFinite(requested) || requested < 50 || requested > DEFAULT_IDLE_TIMEOUT_MS) {
    throw new Error('test idle timeout must be between 50 and 300000ms')
  }
  return Math.floor(requested)
}

export function activityRequestAllowed(request, expected) {
  return ACTIVITY_ORIGINS.has(String(request.origin || ''))
    && [`${LOOPBACK_HOST}:${ACTIVITY_PORT}`, `localhost:${ACTIVITY_PORT}`].includes(String(request.host || '').toLowerCase())
    && request.sessionId === expected.sessionId
    && request.token === expected.token
}

export function stateOwnsIdleMonitor(state, sessionId, monitorPid) {
  return state?.workspace === ROOT
    && state?.status === 'running'
    && state?.session_id === sessionId
    && Number(state?.idle_monitor?.pid) === Number(monitorPid)
}

export function createIdleController({ timeoutMs, onExpire, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer = null
  let expiresAt = 0
  let stopped = false
  const schedule = () => {
    if (timer) clearTimer(timer)
    expiresAt = now() + timeoutMs
    timer = setTimer(async () => {
      if (stopped) return
      stopped = true
      timer = null
      await onExpire()
    }, timeoutMs)
  }
  schedule()
  return {
    touch() {
      if (stopped) return expiresAt
      schedule()
      return expiresAt
    },
    getExpiresAt() { return expiresAt },
    stop() {
      stopped = true
      if (timer) clearTimer(timer)
      timer = null
    },
  }
}

async function fetchJson(url, timeoutMs = 6000) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { cache: 'no-store', signal: controller.signal })
    return { response, payload: await response.json().catch(() => null) }
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchOk(url, timeoutMs = 8000) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { redirect: 'manual', cache: 'no-store', signal: controller.signal })
    return response.status >= 200 && response.status < 400
  } finally {
    clearTimeout(timeout)
  }
}

function openServiceLog(name) {
  ensureRuntimeDirectories()
  const file = path.join(LOG_DIR, `${name}.log`)
  return { file, fd: fs.openSync(file, 'a', 0o600) }
}

function spawnDetached(name, spec) {
  if (listenerPids(spec.port).length) throw new Error(`${name} port ${spec.port} is occupied`)
  const log = openServiceLog(name)
  const child = spawn(npmExecutable, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    detached: true,
    stdio: ['ignore', log.fd, log.fd],
  })
  fs.closeSync(log.fd)
  child.unref()
  return { pid: child.pid, port: spec.port, log: path.relative(ROOT, log.file), started_at: new Date().toISOString() }
}

function spawnIdleMonitor(idleSession) {
  if (listenerPids(ACTIVITY_PORT).length) throw new Error(`activity port ${ACTIVITY_PORT} is occupied`)
  const log = openServiceLog('activity')
  const child = spawn(process.execPath, [SCRIPT_FILE, 'idle-monitor'], {
    cwd: ROOT,
    env: {
      ...process.env,
      MZ_PREVIEW_SESSION_ID: idleSession.sessionId,
      MZ_PREVIEW_ACTIVITY_TOKEN: idleSession.token,
      MZ_PREVIEW_IDLE_TIMEOUT_MS: String(idleSession.timeoutMs),
      MZ_PREVIEW_IDLE_TEST_MODE: idleSession.testMode ? '1' : '0',
    },
    detached: true,
    stdio: ['ignore', log.fd, log.fd],
  })
  fs.closeSync(log.fd)
  child.unref()
  return { pid: child.pid, port: ACTIVITY_PORT, log: path.relative(ROOT, log.file), started_at: new Date().toISOString() }
}

async function waitUntilHealthy(name, spec, pid, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!pidIsAlive(pid)) throw new Error(`${name} process exited during startup`)
    try {
      if (await spec.health()) return
    } catch {}
    await wait(750)
  }
  throw new Error(`${name} did not become ready within ${timeoutMs}ms`)
}

async function waitUntilActivityMonitor(idleSession, pid, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!pidIsAlive(pid)) throw new Error('activity monitor exited during startup')
    try {
      const response = await fetch(`http://${LOOPBACK_HOST}:${ACTIVITY_PORT}/status`, {
        cache: 'no-store',
        headers: {
          Origin: `http://${LOOPBACK_HOST}:3004`,
          'X-MZ-Preview-Session': idleSession.sessionId,
          'X-MZ-Preview-Token': idleSession.token,
        },
      })
      if (response.status === 200) return
    } catch {}
    await wait(100)
  }
  throw new Error('activity monitor did not become ready')
}

async function currentProcessesHealthy() {
  const state = readState()
  if (state?.workspace !== ROOT || state?.status !== 'running') return false
  for (const [name, port] of Object.entries(SERVICE_PORTS)) {
    const service = state.services?.[name]
    if (!service?.pid || !pidIsAlive(service.pid) || !listenerPids(port).length) return false
  }
  if (!state.idle_monitor?.pid || !pidIsAlive(state.idle_monitor.pid) || !listenerPids(ACTIVITY_PORT).length) return false
  return true
}

async function stopIdleSessionServices(sessionId, monitorPid) {
  let state = readState()
  if (!stateOwnsIdleMonitor(state, sessionId, monitorPid)) return false

  for (const service of Object.values(state.services || {})) {
    if (service?.pid && pidIsAlive(service.pid)) killProcessGroup(service.pid)
  }
  await wait(500)

  state = readState()
  if (!stateOwnsIdleMonitor(state, sessionId, monitorPid)) return false
  for (const [name, port] of Object.entries(SERVICE_PORTS)) {
    for (const pid of listenerPids(port)) {
      const cwd = processCwd(pid)
      if (!cwd || !isPathInside(cwd, ROOT)) {
        throw new Error(`${name} port ${port} belongs to another process; idle stop refused pid ${pid}`)
      }
      process.kill(pid, 'SIGTERM')
    }
  }
  if (!(await waitForPortsToClear(20000, SERVICE_PORTS))) {
    throw new Error('idle preview processes did not stop cleanly; no force kill was attempted')
  }

  state = readState()
  if (!stateOwnsIdleMonitor(state, sessionId, monitorPid)) return false
  writeState({
    version: 1,
    workspace: ROOT,
    environment: 'MZ-Dev-Preview',
    status: 'stopped',
    stopped_at: new Date().toISOString(),
    stop_reason: 'inactivity',
    session_id: sessionId,
    idle_timeout_seconds: state.idle_timeout_seconds,
    last_activity_at: state.last_activity_at || state.ready_at || state.started_at,
    services: {},
    idle_monitor: null,
  })
  return true
}

function setCors(response, origin) {
  response.setHeader('Access-Control-Allow-Origin', origin)
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  response.setHeader('Access-Control-Allow-Headers', 'X-MZ-Preview-Session, X-MZ-Preview-Token')
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('Vary', 'Origin')
}

function sendJson(response, status, payload, origin = '') {
  if (origin) setCors(response, origin)
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(`${JSON.stringify(payload)}\n`)
}

async function runIdleMonitor() {
  const sessionId = String(process.env.MZ_PREVIEW_SESSION_ID || '')
  const token = String(process.env.MZ_PREVIEW_ACTIVITY_TOKEN || '')
  if (!sessionId || token.length < 32) throw new Error('activity monitor session is missing')
  const timeoutMs = idleTimeoutMsFromEnv(process.env)
  let server
  const controller = createIdleController({
    timeoutMs,
    onExpire: async () => {
      try {
        const stopped = await stopIdleSessionServices(sessionId, process.pid)
        if (stopped) console.log('[MZ preview] stopped after real-user inactivity')
      } catch (error) {
        console.error(`[MZ preview] idle stop failed: ${String(error?.message || error)}`)
      } finally {
        controller.stop()
        if (server) server.close(() => process.exit(0))
        setTimeout(() => process.exit(0), 1000).unref()
      }
    },
  })

  server = http.createServer((request, response) => {
    const origin = String(request.headers.origin || '')
    const allowed = activityRequestAllowed({
      origin,
      host: request.headers.host,
      sessionId: request.headers['x-mz-preview-session'],
      token: request.headers['x-mz-preview-token'],
    }, { sessionId, token })
    if (request.method === 'OPTIONS') {
      if (!ACTIVITY_ORIGINS.has(origin) || ![`${LOOPBACK_HOST}:${ACTIVITY_PORT}`, `localhost:${ACTIVITY_PORT}`].includes(String(request.headers.host || '').toLowerCase())) {
        return sendJson(response, 403, { ok: false })
      }
      setCors(response, origin)
      response.writeHead(204)
      return response.end()
    }
    if (!allowed) return sendJson(response, 403, { ok: false })
    if (request.method === 'GET' && request.url === '/status') {
      return sendJson(response, 200, { ok: true, expires_at: new Date(controller.getExpiresAt()).toISOString() }, origin)
    }
    if (request.method === 'POST' && request.url === '/activity') {
      request.resume()
      const expiresAt = controller.touch()
      const state = readState()
      if (stateOwnsIdleMonitor(state, sessionId, process.pid)) {
        writeState({ ...state, last_activity_at: new Date().toISOString() })
      }
      return sendJson(response, 200, { ok: true, expires_at: new Date(expiresAt).toISOString() }, origin)
    }
    return sendJson(response, 404, { ok: false }, origin)
  })

  const close = () => {
    controller.stop()
    server.close(() => process.exit(0))
  }
  process.once('SIGTERM', close)
  process.once('SIGINT', close)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(ACTIVITY_PORT, LOOPBACK_HOST, resolve)
  })
  console.log(`[MZ preview] activity monitor ready on ${LOOPBACK_HOST}:${ACTIVITY_PORT}; timeout=${Math.round(timeoutMs / 1000)}s`)
}

async function openPreview() {
  if (process.platform !== 'darwin' || process.env.MZ_PREVIEW_SKIP_OPEN === '1') return
  const child = spawn('open', [PREVIEW_URL], { detached: true, stdio: 'ignore' })
  child.unref()
}

async function commandStart() {
  ensureRuntimeDirectories()
  if (await currentProcessesHealthy()) {
    console.log(`[MZ preview] already running: ${PREVIEW_URL}`)
    await openPreview()
    return
  }

  await stopManagedProcesses({ quiet: true })
  const verified = verifyPreparedEnvironment()
  const backendEnv = safeBackendEnvironment(verified)
  const idleSession = {
    sessionId: crypto.randomUUID(),
    token: crypto.randomBytes(32).toString('hex'),
    timeoutMs: idleTimeoutMsFromEnv(process.env),
    testMode: process.env.MZ_PREVIEW_IDLE_TEST_MODE === '1',
  }
  const definitions = serviceDefinitions(backendEnv, idleSession)
  const state = {
    version: 1,
    workspace: ROOT,
    environment: 'MZ-Dev-Preview',
    database_role: 'dev',
    bind_host: LOOPBACK_HOST,
    status: 'starting',
    session_id: idleSession.sessionId,
    idle_timeout_seconds: idleSession.timeoutMs / 1000,
    started_at: new Date().toISOString(),
    services: {},
    idle_monitor: null,
  }

  try {
    state.services.backend = spawnDetached('backend', definitions.backend)
    writeState(state)
    await waitUntilHealthy('backend', definitions.backend, state.services.backend.pid)

    state.services.booking = spawnDetached('booking', definitions.booking)
    state.services.admin = spawnDetached('admin', definitions.admin)
    writeState(state)
    await Promise.all([
      waitUntilHealthy('booking', definitions.booking, state.services.booking.pid),
      waitUntilHealthy('admin', definitions.admin, state.services.admin.pid),
    ])

    state.status = 'running'
    state.ready_at = new Date().toISOString()
    state.last_activity_at = state.ready_at
    state.idle_monitor = spawnIdleMonitor(idleSession)
    writeState(state)
    await waitUntilActivityMonitor(idleSession, state.idle_monitor.pid)
    console.log(`[MZ preview] ready: ${PREVIEW_URL}`)
    console.log(`[MZ preview] stops after ${Math.round(idleSession.timeoutMs / 1000)} seconds without real browser activity`)
    console.log('[MZ preview] use “Stop MZ Preview.command” to stop immediately')
    await openPreview()
  } catch (error) {
    if (state.idle_monitor?.pid) killProcessGroup(state.idle_monitor.pid)
    for (const service of Object.values(state.services)) killProcessGroup(service.pid)
    await waitForPortsToClear()
    state.status = 'failed'
    state.error = String(error?.message || error)
    state.failed_at = new Date().toISOString()
    state.idle_monitor = null
    writeState(state)
    throw error
  }
}

function commandStatus() {
  const state = readState()
  console.log(`[MZ preview] state=${state?.status || 'stopped'}`)
  for (const [name, port] of Object.entries(MANAGED_PORTS)) {
    const service = name === 'activity' ? state?.idle_monitor : state?.services?.[name]
    const managedPidAlive = !!(service?.pid && pidIsAlive(service.pid))
    const ownedListeners = listenerPids(port).filter((pid) => {
      const cwd = processCwd(pid)
      return !!cwd && isPathInside(cwd, ROOT)
    })
    console.log(`[MZ preview] ${name} port=${port} process=${managedPidAlive ? 'running' : 'stopped'} listener=${ownedListeners.length ? 'present' : 'absent'}`)
  }
  console.log(`[MZ preview] URL=${PREVIEW_URL}`)
}

function redactLogText(value) {
  return String(value || '')
    .replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted-database-url]')
    .replace(/([?&](?:access_token|token)=)[^&\s]*/gi, '$1[REDACTED]')
}

function commandLogs(name = 'backend') {
  if (!['backend', 'booking', 'admin', 'activity'].includes(name)) throw new Error('log name must be backend, booking, admin, or activity')
  const file = path.join(LOG_DIR, `${name}.log`)
  if (!fs.existsSync(file)) return console.log(`[MZ preview] no log yet for ${name}`)
  const stat = fs.statSync(file)
  const length = Math.min(stat.size, 256 * 1024)
  const fd = fs.openSync(file, 'r')
  const buffer = Buffer.alloc(length)
  fs.readSync(fd, buffer, 0, length, Math.max(0, stat.size - length))
  fs.closeSync(fd)
  console.log(redactLogText(buffer.toString('utf8')).split(/\r?\n/g).slice(-120).join('\n'))
}

export async function runCli(args = process.argv.slice(2)) {
  const command = args[0] || 'status'
  if (command === 'start') return commandStart()
  if (command === 'stop') return stopManagedProcesses()
  if (command === 'restart') {
    await stopManagedProcesses({ quiet: true })
    return commandStart()
  }
  if (command === 'status') return commandStatus()
  if (command === 'logs') return commandLogs(args[1] || 'backend')
  if (command === 'idle-monitor') return runIdleMonitor()
  throw new Error(`unknown command: ${command}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_FILE) {
  runCli().catch((error) => {
    console.error(`[MZ preview] failed: ${String(error?.message || error).replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted]')}`)
    process.exit(1)
  })
}
