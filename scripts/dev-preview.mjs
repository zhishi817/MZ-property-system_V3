import { execFileSync, spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PREVIEW_ROOT, verifyPreparedEnvironment } from './dev-preview-db.mjs'

const MOBILE_ROOT = path.resolve(PREVIEW_ROOT, '..', 'mobile')
const mode = process.argv.includes('--all') ? 'all' : process.argv.includes('--mobile') ? 'mobile' : 'web'
const ports = mode === 'mobile' ? [8081] : mode === 'all' ? [3000, 4002, 8081] : [3000, 4002]
const children = new Set()
let stopping = false

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
  for (const port of ports) {
    for (const pid of listenerPids(port)) {
      const cwd = processCwd(pid)
      if (!cwd || !roots.some((root) => isInside(cwd, root))) {
        throw new Error(`port ${port} is owned by an unmanaged process; refusing to terminate it`)
      }
      process.kill(pid, 'SIGTERM')
      console.log(`[MZ-Dev-Preview] stopped previous managed listener port=${port} pid=${pid}`)
    }
  }
  await wait(1000)
  for (const port of ports) {
    if (listenerPids(port).length) throw new Error(`port ${port} is still occupied after managed shutdown`)
  }
}

function start(name, executable, args, cwd, env = {}) {
  const child = spawn(executable, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: 'inherit',
  })
  children.add(child)
  child.on('exit', (code, signal) => {
    children.delete(child)
    if (!stopping) {
      console.error(`[MZ-Dev-Preview] ${name} exited code=${code ?? 'none'} signal=${signal || 'none'}`)
      shutdown(code || 1)
    }
  })
  return child
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
  for (const child of children) {
    try { child.kill('SIGTERM') } catch {}
  }
  setTimeout(() => process.exit(code), 500)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

async function main() {
  const verified = verifyPreparedEnvironment()
  console.log(`[MZ-Dev-Preview] workspace=${PREVIEW_ROOT} app=dev database=dev fingerprint=${verified.currentFingerprint.slice(0, 12)} mode=${mode}`)
  await releaseManagedPorts(verified)

  if (mode !== 'mobile') {
    start('backend', 'npm', ['run', 'dev'], path.join(PREVIEW_ROOT, 'backend'))
    const config = await waitForJson('http://localhost:4002/health/config', (payload, response) => (
      response.ok && payload?.app_env === 'dev' && payload?.database_role === 'dev'
    ))
    await waitForJson('http://localhost:4002/health/ready', (_payload, response) => response.ok)
    console.log(`[MZ-Dev-Preview] backend_ready port=4002 app=${config.app_env} database=${config.database_role}`)

    start('frontend', 'npm', ['run', 'dev'], path.join(PREVIEW_ROOT, 'frontend'), {
      PORT: '3000',
      NEXT_PUBLIC_API_BASE_URL: 'http://localhost:4002',
      NEXT_PUBLIC_API_BASE_DEV: 'http://localhost:4002',
    })
    const status = await waitForPage('http://localhost:3000')
    console.log(`[MZ-Dev-Preview] frontend_ready port=3000 http_status=${status} api=localhost:4002`)
  }

  if (mode !== 'web') {
    start('mobile', path.join(MOBILE_ROOT, 'node_modules', '.bin', 'expo'), ['start', '--localhost', '--port', '8081', '-c'], MOBILE_ROOT, {
      EXPO_NO_TELEMETRY: '1',
      EXPO_PUBLIC_API_BASE_URL: 'http://127.0.0.1:4002',
    })
    console.log('[MZ-Dev-Preview] mobile_starting port=8081 api=127.0.0.1:4002')
  }

  await new Promise(() => undefined)
}

main().catch((error) => {
  console.error(`[MZ-Dev-Preview] start_failed reason=${String(error?.message || error)}`)
  shutdown(1)
})
