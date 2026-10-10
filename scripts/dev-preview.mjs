import { execFileSync, spawn } from 'node:child_process'
import path from 'node:path'
import { PREVIEW_ROOT, verifyPreparedEnvironment } from './dev-preview-db.mjs'
import {
  createPreviewActivityState,
  readPreviewActivityState,
  resolvePreviewRuntimeIdleTimeoutMs,
  resolvePreviewLanHost,
  shouldStopPreviewForIdle,
  writePreviewActivityState,
} from './dev-preview-idle.mjs'

const MOBILE_ROOT = path.resolve(PREVIEW_ROOT, '..', 'mobile')
const mode = process.argv.includes('--all') ? 'all' : process.argv.includes('--mobile') ? 'mobile' : 'web'
const lanMode = process.argv.includes('--lan')
const lanHost = lanMode ? resolvePreviewLanHost(process.env.MZ_DEV_PREVIEW_LAN_HOST) : ''
const ports = mode === 'mobile' ? [8081] : mode === 'all' ? [3000, 4002, 8081] : [3000, 4002]
const activityTrackingEnabled = mode !== 'mobile'
const activityFile = path.join(PREVIEW_ROOT, '.dev-preview', 'runtime-activity.json')
const idleTimeoutOverrideEnabled = process.env.MZ_DEV_PREVIEW_ALLOW_IDLE_TIMEOUT_OVERRIDE === '1'
const idleTimeoutMs = resolvePreviewRuntimeIdleTimeoutMs(
  process.env.MZ_DEV_PREVIEW_IDLE_TIMEOUT_SECONDS,
  idleTimeoutOverrideEnabled,
)
const children = new Set()
const restartTimers = new Set()
let stopping = false
let idleTimer = null
let activityReadWarningShown = false

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

function isInside(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

async function wait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function releaseManagedPorts(verified) {
  const roots = [PREVIEW_ROOT, MOBILE_ROOT, verified.state.source_root].filter(Boolean)
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    let foundListener = false
    for (const port of ports) {
      for (const pid of listenerPids(port)) {
        foundListener = true
        const cwd = processCwd(pid)
        if (!cwd) continue
        if (!roots.some((root) => isInside(cwd, root))) {
          throw new Error(`port ${port} is owned by an unmanaged process; refusing to terminate it`)
        }
        try { process.kill(pid, 'SIGTERM') } catch (error) {
          if (error?.code !== 'ESRCH') throw error
        }
        console.log(`[MZ-Dev-Preview] stopped previous managed listener port=${port} pid=${pid}`)
      }
    }
    if (!foundListener) return
    await wait(500)
  }
  for (const port of ports) {
    const remaining = listenerPids(port)
    if (remaining.length) throw new Error(`port ${port} is still occupied after managed shutdown convergence`)
  }
}

function signalPreviewListeners(signal) {
  const roots = [PREVIEW_ROOT, MOBILE_ROOT]
  for (const port of ports) {
    for (const pid of listenerPids(port)) {
      const cwd = processCwd(pid)
      if (!cwd || !roots.some((root) => isInside(cwd, root))) continue
      try { process.kill(pid, signal) } catch {}
    }
  }
}

function start(name, executable, args, cwd, env = {}, options = {}) {
  const child = spawn(executable, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: 'inherit',
    detached: process.platform !== 'win32',
  })
  children.add(child)
  child.on('exit', (code, signal) => {
    children.delete(child)
    if (!stopping && options.restartOnExit) {
      console.error(`[MZ-Dev-Preview] ${name} exited code=${code ?? 'none'} signal=${signal || 'none'} restarting_owned_service=true`)
      const timer = setTimeout(() => {
        restartTimers.delete(timer)
        if (!stopping) start(name, executable, args, cwd, env, options)
      }, 1000)
      restartTimers.add(timer)
      return
    }
    if (!stopping) {
      console.error(`[MZ-Dev-Preview] ${name} exited code=${code ?? 'none'} signal=${signal || 'none'}`)
      shutdown(code || 1)
    }
  })
  return child
}

function signalOwnedChild(child, signal) {
  try {
    if (process.platform === 'win32') child.kill(signal)
    else process.kill(-child.pid, signal)
  } catch {}
}

async function waitForJson(url, predicate, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs
  let lastStatus = 0
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { cache: 'no-store' })
      lastStatus = response.status
      const payload = await response.json()
      if (predicate(payload, response)) return payload
    } catch {}
    await wait(750)
  }
  throw new Error(`timed out waiting for ${url}; last_status=${lastStatus || 'unreachable'}`)
}

async function waitForPage(url, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: 'manual', cache: 'no-store' })
      if (response.status >= 200 && response.status < 500) return response.status
    } catch {}
    await wait(750)
  }
  throw new Error(`timed out waiting for ${url}`)
}

function shutdown(code = 0) {
  if (stopping) return
  stopping = true
  if (idleTimer) clearInterval(idleTimer)
  for (const timer of restartTimers) clearTimeout(timer)
  restartTimers.clear()
  const ownedChildren = Array.from(children)
  for (const child of ownedChildren) signalOwnedChild(child, 'SIGTERM')
  setTimeout(() => signalPreviewListeners('SIGTERM'), 750)
  setTimeout(() => {
    for (const child of ownedChildren) {
      if (child.exitCode === null && child.signalCode === null) signalOwnedChild(child, 'SIGKILL')
    }
    signalPreviewListeners('SIGKILL')
  }, 1500)
  setTimeout(() => process.exit(code), 2000)
}

function markLauncherReady() {
  if (!activityTrackingEnabled) return
  const current = readPreviewActivityState(activityFile) || createPreviewActivityState()
  writePreviewActivityState(activityFile, {
    ...current,
    last_activity_ms: Date.now(),
    reason: 'launcher_ready',
  })
}

function startIdleMonitor() {
  if (!activityTrackingEnabled) {
    console.log('[MZ-Dev-Preview] idle_monitor=disabled reason=mobile_only_requires_backend_activity_coordinator')
    return
  }
  const timeoutSource = idleTimeoutOverrideEnabled ? 'explicit_test_override' : 'fixed_default'
  console.log(`[MZ-Dev-Preview] idle_monitor=enabled timeout_seconds=${Math.round(idleTimeoutMs / 1000)} timeout_source=${timeoutSource} activity_file=${activityFile}`)
  idleTimer = setInterval(() => {
    const state = readPreviewActivityState(activityFile)
    if (!state) {
      if (!activityReadWarningShown) {
        activityReadWarningShown = true
        console.error('[MZ-Dev-Preview] idle_monitor_warning reason=activity_state_unreadable; fail_open=true')
      }
      return
    }
    activityReadWarningShown = false
    if (!shouldStopPreviewForIdle({ state, timeoutMs: idleTimeoutMs })) return
    console.log(`[MZ-Dev-Preview] idle_timeout elapsed_seconds=${Math.floor((Date.now() - state.last_activity_ms) / 1000)} stopping_owned_services=true`)
    shutdown(0)
  }, 1000)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

async function main() {
  const verified = verifyPreparedEnvironment()
  console.log(`[MZ-Dev-Preview] workspace=${PREVIEW_ROOT} app=dev database=dev fingerprint=${verified.currentFingerprint.slice(0, 12)} mode=${mode} network=${lanMode ? `lan:${lanHost}` : 'localhost'}`)
  await releaseManagedPorts(verified)

  if (activityTrackingEnabled) writePreviewActivityState(activityFile, createPreviewActivityState(Date.now(), 'launcher_starting'))

  if (mode !== 'mobile') {
    start('backend', 'npm', ['run', 'dev'], path.join(PREVIEW_ROOT, 'backend'), {
      MZ_DEV_PREVIEW_ACTIVITY_FILE: activityFile,
    })
    const config = await waitForJson('http://localhost:4002/health/config', (payload, response) => (
      response.ok && payload?.app_env === 'dev' && payload?.database_role === 'dev'
    ))
    await waitForJson('http://localhost:4002/health/ready', (_payload, response) => response.ok)
    console.log(`[MZ-Dev-Preview] backend_ready port=4002 app=${config.app_env} database=${config.database_role}`)

    start('frontend', 'npm', ['run', 'dev'], path.join(PREVIEW_ROOT, 'frontend'), {
      PORT: '3000',
      NEXT_PUBLIC_API_BASE_URL: 'http://localhost:4002',
      NEXT_PUBLIC_API_BASE_DEV: 'http://localhost:4002',
      NEXT_PUBLIC_MZ_DEV_PREVIEW_ACTIVITY: '1',
      NEXT_PUBLIC_MZ_DEV_PREVIEW_ACTIVITY_URL: 'http://localhost:4002/health/dev-preview-activity',
    }, { restartOnExit: true })
    const status = await waitForPage('http://localhost:3000')
    console.log(`[MZ-Dev-Preview] frontend_ready port=3000 http_status=${status} api=localhost:4002`)
  }

  if (mode !== 'web') {
    const mobileApiHost = lanMode ? lanHost : '127.0.0.1'
    start('mobile', path.join(MOBILE_ROOT, 'node_modules', '.bin', 'expo'), ['start', lanMode ? '--lan' : '--localhost', '--port', '8081', '-c'], MOBILE_ROOT, {
      EXPO_NO_TELEMETRY: '1',
      EXPO_PUBLIC_API_BASE_URL: `http://${mobileApiHost}:4002`,
      EXPO_PUBLIC_MZ_DEV_PREVIEW_ACTIVITY: activityTrackingEnabled ? '1' : '0',
    })
    console.log(`[MZ-Dev-Preview] mobile_starting port=8081 api=${mobileApiHost}:4002 network=${lanMode ? 'lan' : 'localhost'}`)
  }

  markLauncherReady()
  startIdleMonitor()
  await new Promise(() => undefined)
}

main().catch((error) => {
  console.error(`[MZ-Dev-Preview] start_failed reason=${String(error?.message || error)}`)
  shutdown(1)
})
