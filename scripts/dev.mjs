import { spawn } from 'node:child_process'

const BACKEND_HEALTH_URL = 'http://localhost:4002/health'
const BACKEND_CWD = new URL('../backend/', import.meta.url)
const FRONTEND_CWD = new URL('../frontend/', import.meta.url)

function npmCmd() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForBackendHealth() {
  for (;;) {
    try {
      const res = await fetch(BACKEND_HEALTH_URL, { method: 'GET' })
      if (res.ok) return
    } catch {}
    await sleep(1000)
  }
}

function spawnDev(name, cwd, args) {
  const child = spawn(npmCmd(), args, {
    cwd,
    env: process.env,
    stdio: 'inherit',
  })
  child.on('exit', (code, signal) => {
    if (signal) console.log(`[${name}] exited with signal ${signal}`)
    else console.log(`[${name}] exited with code ${code ?? 0}`)
  })
  return child
}

const backend = spawnDev('backend', BACKEND_CWD, ['run', 'dev'])
let frontend = null
let shuttingDown = false

function shutdown(exitCode = 0) {
  if (shuttingDown) return
  shuttingDown = true
  if (frontend && !frontend.killed) {
    try { frontend.kill('SIGTERM') } catch {}
  }
  if (backend && !backend.killed) {
    try { backend.kill('SIGTERM') } catch {}
  }
  setTimeout(() => process.exit(exitCode), 300)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

backend.on('exit', () => {
  if (!shuttingDown) shutdown(1)
})

try {
  console.log('[dev] waiting for backend health before starting frontend...')
  await waitForBackendHealth()
  if (shuttingDown) process.exit(0)
  console.log('[dev] backend healthy, starting frontend...')
  frontend = spawnDev('frontend', FRONTEND_CWD, ['run', 'dev'])
  frontend.on('exit', () => {
    if (!shuttingDown) shutdown(1)
  })
} catch (error) {
  console.error('[dev] failed to start development workflow', error)
  shutdown(1)
}
