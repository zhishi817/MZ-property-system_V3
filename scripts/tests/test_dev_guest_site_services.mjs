import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  activityRequestAllowed,
  assertGuestSiteRuntimeSafety,
  createIdleController,
  idleTimeoutMsFromEnv,
  isPathInside,
  stateOwnsIdleMonitor,
} from '../dev-guest-site-services.mjs'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(scriptDir, '..', '..')

const falseFlags = [
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

const safe = {
  APP_ENV: 'dev',
  DATABASE_ROLE: 'dev',
  NODE_ENV: 'development',
  MZ_DEV_PREVIEW: '1',
  PORT_OVERRIDE: '4012',
  DEV_PREVIEW_BIND_HOST: '127.0.0.1',
  MZ_DEV_PREVIEW_DISABLE_RUNTIME_DDL: '1',
  STARTUP_WARMUP_MODE: 'readonly',
  PDF_JOBS_MODE: 'disabled',
}
for (const key of falseFlags) safe[key] = 'false'

assert.equal(assertGuestSiteRuntimeSafety(safe), true)
assert.throws(() => assertGuestSiteRuntimeSafety({ ...safe, APP_ENV: 'prod' }), /APP_ENV/)
assert.throws(() => assertGuestSiteRuntimeSafety({ ...safe, DATABASE_ROLE: 'prod' }), /DATABASE_ROLE/)
assert.throws(() => assertGuestSiteRuntimeSafety({ ...safe, NODE_ENV: 'production' }), /NODE_ENV/)
assert.throws(() => assertGuestSiteRuntimeSafety({ ...safe, DEV_PREVIEW_BIND_HOST: '0.0.0.0' }), /127\.0\.0\.1/)
assert.throws(() => assertGuestSiteRuntimeSafety({ ...safe, STARTUP_WARMUP_MODE: 'full' }), /read-only/)
assert.throws(() => assertGuestSiteRuntimeSafety({ ...safe, MZ_DEV_PREVIEW_DISABLE_RUNTIME_DDL: '0' }), /runtime DDL/)
assert.throws(() => assertGuestSiteRuntimeSafety({ ...safe, NOTIFICATION_WORKER_ENABLED: 'true' }), /NOTIFICATION_WORKER_ENABLED/)

assert.equal(isPathInside(path.join(root, 'backend'), root), true)
assert.equal(isPathInside('/tmp/unrelated-project', root), false)

assert.equal(idleTimeoutMsFromEnv({}), 300_000)
assert.equal(idleTimeoutMsFromEnv({ MZ_PREVIEW_IDLE_TIMEOUT_MS: '50' }), 300_000)
assert.equal(idleTimeoutMsFromEnv({ MZ_PREVIEW_IDLE_TEST_MODE: '1', MZ_PREVIEW_IDLE_TIMEOUT_MS: '80' }), 80)
assert.throws(() => idleTimeoutMsFromEnv({ MZ_PREVIEW_IDLE_TEST_MODE: '1', MZ_PREVIEW_IDLE_TIMEOUT_MS: '20' }), /between 50 and 300000/)

const expectedActivity = { sessionId: 'session-a', token: 'token-a' }
assert.equal(activityRequestAllowed({ origin: 'http://127.0.0.1:3004', host: '127.0.0.1:4013', ...expectedActivity }, expectedActivity), true)
assert.equal(activityRequestAllowed({ origin: 'http://localhost:3006', host: 'localhost:4013', ...expectedActivity }, expectedActivity), true)
assert.equal(activityRequestAllowed({ origin: 'https://example.com', host: '127.0.0.1:4013', ...expectedActivity }, expectedActivity), false)
assert.equal(activityRequestAllowed({ origin: 'http://127.0.0.1:3004', host: '127.0.0.1:4013', sessionId: 'old-session', token: 'token-a' }, expectedActivity), false)
assert.equal(activityRequestAllowed({ origin: 'http://127.0.0.1:3004', host: '127.0.0.1:4013', sessionId: 'session-a', token: 'wrong' }, expectedActivity), false)

assert.equal(stateOwnsIdleMonitor({ workspace: root, status: 'running', session_id: 'session-a', idle_monitor: { pid: 42 } }, 'session-a', 42), true)
assert.equal(stateOwnsIdleMonitor({ workspace: root, status: 'running', session_id: 'new-session', idle_monitor: { pid: 84 } }, 'session-a', 42), false)

let expirations = 0
const controller = createIdleController({ timeoutMs: 80, onExpire: async () => { expirations += 1 } })
const firstExpiry = controller.getExpiresAt()
await new Promise((resolve) => setTimeout(resolve, 45))
const secondExpiry = controller.touch()
assert.ok(secondExpiry > firstExpiry, 'activity from another tab should extend the shared session deadline')
await new Promise((resolve) => setTimeout(resolve, 50))
assert.equal(expirations, 0, 'the original timer must not end an extended session')
await new Promise((resolve) => setTimeout(resolve, 55))
assert.equal(expirations, 1, 'an inactive session should expire exactly once')
controller.stop()

const lifecycleSource = fs.readFileSync(path.join(root, 'scripts', 'dev-guest-site-services.mjs'), 'utf8')
assert.doesNotMatch(lifecycleSource, /setInterval\s*\(/)
assert.doesNotMatch(lifecycleSource, /LaunchAgent|launchctl|KeepAlive/)
assert.match(lifecycleSource, /processCwd\(pid\)/)
assert.match(lifecycleSource, /refusing to stop/)
assert.match(lifecycleSource, /PG_IDLE_TIMEOUT_MS: '30000'/)
assert.match(lifecycleSource, /DEFAULT_IDLE_TIMEOUT_MS = 300_000/)
assert.match(lifecycleSource, /session_id: idleSession\.sessionId/)
assert.match(lifecycleSource, /stateOwnsIdleMonitor/)
assert.match(lifecycleSource, /NEXT_PUBLIC_BOOKING_SITE_URL: `http:\/\/\$\{LOOPBACK_HOST\}:3004`/)
assert.match(lifecycleSource, /NEXT_PUBLIC_ADMIN_FRONTEND_URL: `http:\/\/\$\{LOOPBACK_HOST\}:3006`/)
assert.doesNotMatch(lifecycleSource, /DATABASE_URL.*activity|activity.*DATABASE_URL/)

for (const file of ['booking-frontend/src/app/PreviewActivity.tsx', 'frontend/src/components/PreviewActivity.tsx']) {
  const source = fs.readFileSync(path.join(root, file), 'utf8')
  for (const eventName of ['pointerdown', 'keydown', 'input', 'scroll', 'visibilitychange']) assert.match(source, new RegExp(eventName))
  assert.match(source, /usePathname/)
  assert.match(source, /reportThrottleMs = 10_000/)
  assert.match(source, /\/status/)
  assert.doesNotMatch(source, /event\.key|event\.target\.value|setInterval/)
}

const backendSource = fs.readFileSync(path.join(root, 'backend', 'src', 'index.ts'), 'utf8')
assert.match(backendSource, /STARTUP_WARMUP_MODE === 'readonly'/)
assert.match(backendSource, /DEV_PREVIEW_BIND_HOST/)
assert.match(backendSource, /preserveManagedPreviewEnvironment = process\.env\.MZ_DEV_PREVIEW === '1'/)
assert.match(backendSource, /override: !preserveManagedPreviewEnvironment/)

for (const file of ['backend/src/modules/invoices.ts', 'backend/src/modules/cleaning_app.ts']) {
  const source = fs.readFileSync(path.join(root, file), 'utf8')
  assert.match(source, /MZ_DEV_PREVIEW_DISABLE_RUNTIME_DDL !== '1'/)
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
for (const command of ['start', 'stop', 'restart', 'status', 'logs']) {
  assert.match(pkg.scripts[`dev:guest-site:${command}`], /dev-guest-site-services\.mjs/)
}

for (const file of ['Start MZ Preview.command', 'Stop MZ Preview.command', 'MZ Preview Status.command']) {
  const target = path.join(root, file)
  assert.equal(fs.existsSync(target), true)
  assert.notEqual(fs.statSync(target).mode & 0o111, 0)
}

console.log('on-demand guest-site service lifecycle: PASS')
