import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import {
  DevPreviewActivityTracker,
  isDevPreviewActivityEnabled,
  shouldTrackDevPreviewBusinessRequest,
} from '../../src/lib/devPreviewActivity'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mz-preview-activity-'))
const activityFile = path.join(tempDir, 'activity.json')
const env = {
  MZ_DEV_PREVIEW: '1',
  APP_ENV: 'dev',
  DATABASE_ROLE: 'dev',
  MZ_DEV_PREVIEW_ACTIVITY_FILE: activityFile,
}

try {
  assert.equal(isDevPreviewActivityEnabled(env), true)
  assert.equal(isDevPreviewActivityEnabled({ ...env, APP_ENV: 'prod' }), false)
  assert.equal(isDevPreviewActivityEnabled({ ...env, MZ_DEV_PREVIEW: '0' }), false)

  assert.equal(shouldTrackDevPreviewBusinessRequest({ method: 'PATCH', path: '/mzapp/tasks/1', headers: {} } as any), true)
  assert.equal(shouldTrackDevPreviewBusinessRequest({ method: 'GET', path: '/mzapp/work-tasks', headers: {} } as any), false)
  assert.equal(shouldTrackDevPreviewBusinessRequest({ method: 'POST', path: '/health/ready', headers: {} } as any), false)
  assert.equal(shouldTrackDevPreviewBusinessRequest({ method: 'POST', path: '/mzapp/tasks/1', headers: { accept: 'text/event-stream' } } as any), false)
  assert.equal(shouldTrackDevPreviewBusinessRequest({ method: 'POST', path: '/mzapp/tasks/1', headers: { 'x-mz-dev-preview-background': '1' } } as any), false)

  const tracker = new DevPreviewActivityTracker(env, 1_000)
  tracker.mark('client_interaction', 2_000)
  let state = JSON.parse(fs.readFileSync(activityFile, 'utf8'))
  assert.equal(state.last_activity_ms, 2_000)
  assert.equal(state.active_requests, 0)

  const response = new EventEmitter()
  let nextCalled = false
  tracker.middleware(
    { method: 'POST', path: '/mzapp/guest-ready-notifications', headers: {} } as any,
    response as any,
    () => { nextCalled = true },
  )
  assert.equal(nextCalled, true)
  state = JSON.parse(fs.readFileSync(activityFile, 'utf8'))
  assert.equal(state.active_requests, 1)

  response.emit('finish')
  response.emit('close')
  state = JSON.parse(fs.readFileSync(activityFile, 'utf8'))
  assert.equal(state.active_requests, 0)
  assert.match(state.reason, /^request_finished:/)

  console.log('dev preview backend activity tracker: PASS')
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true })
}
