import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  DEFAULT_PREVIEW_IDLE_TIMEOUT_SECONDS,
  createPreviewActivityState,
  readPreviewActivityState,
  resolvePreviewIdleTimeoutMs,
  resolvePreviewRuntimeIdleTimeoutMs,
  resolvePreviewLanHost,
  shouldStopPreviewForIdle,
  writePreviewActivityState,
} from '../dev-preview-idle.mjs'

assert.equal(DEFAULT_PREVIEW_IDLE_TIMEOUT_SECONDS, 300)
assert.equal(resolvePreviewIdleTimeoutMs(undefined), 300_000)
assert.equal(resolvePreviewIdleTimeoutMs('2'), 2_000)
assert.equal(resolvePreviewRuntimeIdleTimeoutMs('900'), 300_000)
assert.equal(resolvePreviewRuntimeIdleTimeoutMs('2', true), 2_000)

const start = 1_000_000
const idle = createPreviewActivityState(start)
assert.equal(shouldStopPreviewForIdle({ now: start + 299_999, state: idle, timeoutMs: 300_000 }), false)
assert.equal(shouldStopPreviewForIdle({ now: start + 300_000, state: idle, timeoutMs: 300_000 }), true)
assert.equal(shouldStopPreviewForIdle({
  now: start + 600_000,
  state: { ...idle, active_requests: 1 },
  timeoutMs: 300_000,
}), false)
assert.equal(shouldStopPreviewForIdle({
  now: start + 599_999,
  state: { ...idle, last_activity_ms: start + 300_000 },
  timeoutMs: 300_000,
}), false)

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mz-preview-idle-'))
try {
  const stateFile = path.join(tempDir, 'activity.json')
  writePreviewActivityState(stateFile, idle)
  assert.deepEqual(readPreviewActivityState(stateFile), idle)
  fs.writeFileSync(stateFile, 'not-json')
  assert.equal(readPreviewActivityState(stateFile), null)
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true })
}

assert.equal(resolvePreviewLanHost('', {
  en0: [{ family: 'IPv4', internal: false, address: '192.168.50.248' }],
  lo0: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
}), '192.168.50.248')
assert.throws(() => resolvePreviewLanHost('', {
  en0: [{ family: 'IPv4', internal: false, address: '192.168.1.2' }],
  en1: [{ family: 'IPv4', internal: false, address: '10.0.0.2' }],
}), /set MZ_DEV_PREVIEW_LAN_HOST explicitly/)

console.log('dev preview idle controller: PASS')
