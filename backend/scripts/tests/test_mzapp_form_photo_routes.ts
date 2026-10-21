import assert from 'node:assert/strict'
import express from 'express'
import sharp from 'sharp'

process.env.DATABASE_URL = ''
process.env.MZ_DEV_PREVIEW_DISABLE_RUNTIME_DDL = '1'

type FixtureTask = {
  id: string
  task_date: string
  property_id: string
  property_code: string
  task_type: string
  status: string
  execution_state: string
  order_id: string | null
  order_checkin: string | null
  order_checkout: string | null
  inspector_id: string | null
  cleaner_id: string | null
  assignee_id: string | null
}

type FixtureMedia = {
  id: string
  task_id: string
  type: string
  url: string
  uploader_id: string | null
}

const tasks: FixtureTask[] = [
  {
    id: 'checkout-active',
    task_date: '2026-10-21',
    property_id: 'property-1',
    property_code: 'ROUTE-101',
    task_type: 'checkout_clean',
    status: 'done',
    execution_state: 'active',
    order_id: 'checkout-order',
    order_checkin: '2026-10-18',
    order_checkout: '2026-10-21',
    inspector_id: null,
    cleaner_id: 'cleaner-1',
    assignee_id: null,
  },
  {
    id: 'checkin-active',
    task_date: '2026-10-21',
    property_id: 'property-1',
    property_code: 'ROUTE-101',
    task_type: 'checkin_clean',
    status: 'done',
    execution_state: 'active',
    order_id: 'checkin-order',
    order_checkin: '2026-10-21',
    order_checkout: '2026-10-24',
    inspector_id: 'inspector-1',
    cleaner_id: null,
    assignee_id: 'inspector-1',
  },
  {
    id: 'same-day-independent',
    task_date: '2026-10-21',
    property_id: 'property-1',
    property_code: 'ROUTE-101',
    task_type: 'checkin_clean',
    status: 'done',
    execution_state: 'active',
    order_id: null,
    order_checkin: null,
    order_checkout: null,
    inspector_id: 'inspector-1',
    cleaner_id: null,
    assignee_id: 'inspector-1',
  },
  {
    id: 'reassigned-task',
    task_date: '2026-10-20',
    property_id: 'property-2',
    property_code: 'ROUTE-202',
    task_type: 'checkout_clean',
    status: 'done',
    execution_state: 'active',
    order_id: 'reassigned-order',
    order_checkin: '2026-10-18',
    order_checkout: '2026-10-20',
    inspector_id: null,
    cleaner_id: 'cleaner-2',
    assignee_id: null,
  },
  {
    id: 'cancelled-task',
    task_date: '2026-10-19',
    property_id: 'property-3',
    property_code: 'ROUTE-303',
    task_type: 'checkout_clean',
    status: 'cancelled',
    execution_state: 'cancelled',
    order_id: 'cancelled-order',
    order_checkin: '2026-10-17',
    order_checkout: '2026-10-19',
    inspector_id: null,
    cleaner_id: 'cleaner-1',
    assignee_id: null,
  },
  {
    id: 'deleted-task',
    task_date: '2026-10-18',
    property_id: 'property-4',
    property_code: 'ROUTE-404',
    task_type: 'checkout_clean',
    status: 'done',
    execution_state: 'deleted',
    order_id: 'deleted-order',
    order_checkin: '2026-10-16',
    order_checkout: '2026-10-18',
    inspector_id: null,
    cleaner_id: 'cleaner-1',
    assignee_id: null,
  },
  {
    id: 'superseded-task',
    task_date: '2026-10-17',
    property_id: 'property-5',
    property_code: 'ROUTE-505',
    task_type: 'checkout_clean',
    status: 'done',
    execution_state: 'superseded',
    order_id: null,
    order_checkin: null,
    order_checkout: null,
    inspector_id: null,
    cleaner_id: 'cleaner-1',
    assignee_id: null,
  },
]

const media: FixtureMedia[] = [
  { id: 'completion-1', task_id: 'checkout-active', type: 'completion_living', url: 'cleaning/route/cleaner-own.jpg', uploader_id: 'cleaner-1' },
  { id: 'key-1', task_id: 'checkout-active', type: 'key_photo', url: 'cleaning/route/guest-key.jpg', uploader_id: 'cleaner-1' },
  { id: 'inspection-1', task_id: 'checkin-active', type: 'inspection_living', url: 'cleaning/route/inspector-own.jpg', uploader_id: 'inspector-1' },
  { id: 'reassigned-1', task_id: 'reassigned-task', type: 'completion_kitchen', url: 'cleaning/route/former-cleaner.jpg', uploader_id: 'cleaner-1' },
  { id: 'cancelled-1', task_id: 'cancelled-task', type: 'completion_bedroom', url: 'cleaning/route/cancelled.jpg', uploader_id: 'cleaner-1' },
  { id: 'deleted-1', task_id: 'deleted-task', type: 'completion_bedroom', url: 'cleaning/route/deleted.jpg', uploader_id: 'cleaner-1' },
  { id: 'superseded-1', task_id: 'superseded-task', type: 'completion_bedroom', url: 'cleaning/route/superseded.jpg', uploader_id: 'cleaner-1' },
  { id: 'ownerless-1', task_id: 'checkout-active', type: 'consumable_item_photo:coffee', url: 'cleaning/route/ownerless.jpg', uploader_id: null },
]

const completionEvidence = new Map<string, Set<string>>([
  ['cleaner-1', new Set(['checkout-active', 'reassigned-task', 'cancelled-task', 'deleted-task', 'superseded-task'])],
])
const inspectionEvidence = new Map<string, Set<string>>([
  ['inspector-1', new Set(['checkin-active', 'same-day-independent'])],
])

function taskRows(ids: string[]) {
  const requested = new Set(ids.map(String))
  return tasks.filter((task) => requested.has(task.id))
}

function auditRows(ids: string[], userId: string, action: string) {
  const evidence = action === 'submit_inspection' ? inspectionEvidence : completionEvidence
  const owned = evidence.get(userId) || new Set<string>()
  return ids.filter((id) => owned.has(id)).map((source_id) => ({ source_id }))
}

const dbAdapter = require('../../src/dbAdapter')
dbAdapter.hasPg = true
dbAdapter.pgPool = {
  async query(sql0: string, params: any[] = []) {
    const sql = String(sql0 || '')
    if (/^\s*(CREATE|ALTER|INSERT|UPDATE|DELETE|DROP|TRUNCATE|REPLACE|MERGE|GRANT|REVOKE)\b/i.test(sql)) {
      throw new Error(`write SQL is forbidden in this read-only route test: ${sql.replace(/\s+/g, ' ').slice(0, 180)}`)
    }
    if (/FROM cleaning_tasks t[\s\S]*LEFT JOIN orders o/.test(sql)) {
      const ids = Array.isArray(params[0]) ? params[0].map(String) : [String(params[0] || '')]
      const rows = taskRows(ids)
      return { rows, rowCount: rows.length }
    }
    if (/FROM work_task_action_audits/.test(sql)) {
      const ids = Array.isArray(params[0]) ? params[0].map(String) : []
      const userId = String(params[1] || '')
      const action = /performed_as_action\s*=\s*'submit_inspection'/.test(sql) || params[2] === 'submit_inspection'
        ? 'submit_inspection'
        : 'complete_cleaning'
      const rows = auditRows(ids, userId, action)
      return { rows, rowCount: rows.length }
    }
    if (/FROM cleaning_task_media ctm[\s\S]*JOIN cleaning_tasks ct/.test(sql)) {
      const references = new Set((Array.isArray(params[0]) ? params[0] : []).map(String))
      const rows = media
        .filter((item) => references.has(item.url))
        .map((item) => {
          const task = tasks.find((candidate) => candidate.id === item.task_id)!
          return {
            type: item.type,
            url: item.url,
            source_task_id: item.task_id,
            uploader_id: item.uploader_id,
            id: task.id,
            cleaner_id: task.cleaner_id,
            inspector_id: task.inspector_id,
            assignee_id: task.assignee_id,
          }
        })
      return { rows, rowCount: rows.length }
    }
    if (/FROM cleaning_task_media/.test(sql) && /task_id::text = ANY/.test(sql)) {
      const ids = new Set((Array.isArray(params[0]) ? params[0] : []).map(String))
      const rows = media
        .filter((item) => ids.has(item.task_id))
        .map((item) => ({
          ...item,
          captured_at: '2026-10-21T01:00:00.000Z',
          created_at: '2026-10-21T01:00:00.000Z',
        }))
      return { rows, rowCount: rows.length }
    }
    if (/FROM cleaning_consumable_usages u[\s\S]*JOIN cleaning_tasks ct/.test(sql)) {
      return { rows: [], rowCount: 0 }
    }
    if (/FROM cleaning_consumable_usages/.test(sql) && /task_id::text = ANY/.test(sql)) {
      return { rows: [], rowCount: 0 }
    }
    if (/FROM work_task_participants/.test(sql)) return { rows: [], rowCount: 0 }
    if (/FROM guest_luggage_notices|FROM cleaning_day_end_media|FROM property_maintenance|FROM external_maintenance_orders|FROM work_task_events/.test(sql)) {
      return { rows: [], rowCount: 0 }
    }
    throw new Error(`unexpected test query: ${sql.replace(/\s+/g, ' ').slice(0, 180)}`)
  },
}

let r2ReadCount = 0
const r2 = require('../../src/r2')
r2.hasR2 = true
r2.r2GetObjectByKey = async (key: string) => {
  assert.ok(media.some((item) => item.url === key), `only a recorded fixture key may reach object storage: ${key}`)
  r2ReadCount += 1
  return {
    body: await sharp({ create: { width: 2, height: 2, channels: 3, background: '#2266aa' } }).png().toBuffer(),
    contentType: 'image/png',
    etag: `route-${r2ReadCount}`,
  }
}

const { router: mzappRouter } = require('../../src/modules/mzapp')
const { router: cleaningAppRouter } = require('../../src/modules/cleaning_app')

type TestUser = { id: string; role: string }

async function withRouteServer(run: (baseUrl: string) => Promise<void>) {
  const app = express()
  app.use((req: any, _res, next) => {
    const id = String(req.headers['x-test-user'] || '')
    const role = String(req.headers['x-test-role'] || 'cleaner')
    req.user = id ? { sub: id, role, roles: [role] } : null
    next()
  })
  app.use('/mzapp', mzappRouter)
  app.use('/cleaning-app', cleaningAppRouter)
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
  })
  try {
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    await run(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

function userHeaders(user: TestUser) {
  return { 'x-test-user': user.id, 'x-test-role': user.role }
}

async function getJson(baseUrl: string, path: string, user: TestUser) {
  const response = await fetch(`${baseUrl}${path}`, { headers: userHeaders(user) })
  return { response, body: await response.json() as any }
}

function formPhotoPath(workTaskId: string, sourceIds: string[], scope: string) {
  const query = new URLSearchParams({ source_ids: sourceIds.join(','), scope })
  return `/mzapp/work-tasks/${encodeURIComponent(workTaskId)}/form-photos?${query}`
}

function mediaPath(key: string, sourceIds: string[], scope: string, sourceTaskId: string) {
  const query = new URLSearchParams({
    key,
    source_ids: sourceIds.join(','),
    media_scope: scope,
    source_task_id: sourceTaskId,
  })
  return `/cleaning-app/media/image?${query}`
}

async function verifyFormPhotoRoute(baseUrl: string) {
  const pairId = 'cleaning_tasks_merged:property-1:2026-10-21'
  const cleaner = { id: 'cleaner-1', role: 'cleaner' }
  const inspector = { id: 'inspector-1', role: 'cleaning_inspector' }
  const manager = { id: 'manager-1', role: 'admin' }

  const cleanerResult = await getJson(baseUrl, formPhotoPath(pairId, ['checkout-active', 'checkin-active'], 'cleaner'), cleaner)
  assert.equal(cleanerResult.response.status, 200)
  assert.deepEqual(cleanerResult.body.items.map((item: any) => item.id).sort(), ['completion-1', 'key-1'])

  const inspectorResult = await getJson(baseUrl, formPhotoPath(pairId, ['checkout-active', 'checkin-active'], 'inspector'), inspector)
  assert.equal(inspectorResult.response.status, 200)
  assert.deepEqual(inspectorResult.body.items.map((item: any) => item.id).sort(), ['inspection-1', 'key-1'])

  const managerResult = await getJson(baseUrl, formPhotoPath(pairId, ['checkout-active', 'checkin-active'], 'manager'), manager)
  assert.equal(managerResult.response.status, 200)
  assert.deepEqual(managerResult.body.items.map((item: any) => item.id).sort(), ['completion-1', 'inspection-1', 'key-1', 'ownerless-1'])

  const outsider = await getJson(baseUrl, formPhotoPath(pairId, ['checkout-active', 'checkin-active'], 'cleaner'), { id: 'outsider-1', role: 'cleaner' })
  assert.equal(outsider.response.status, 403)

  const independent = await getJson(baseUrl, formPhotoPath(pairId, ['checkout-active', 'same-day-independent'], 'inspector'), inspector)
  assert.equal(independent.response.status, 403, 'same property/date without a booking boundary must not share photos')

  const formerCleaner = await getJson(baseUrl, formPhotoPath('reassigned-task', ['reassigned-task'], 'cleaner'), cleaner)
  assert.equal(formerCleaner.response.status, 200)
  assert.deepEqual(formerCleaner.body.items.map((item: any) => item.id), ['reassigned-1'])

  const replacementCleaner = await getJson(baseUrl, formPhotoPath('reassigned-task', ['reassigned-task'], 'cleaner'), { id: 'cleaner-2', role: 'cleaner' })
  assert.equal(replacementCleaner.response.status, 200)
  assert.deepEqual(replacementCleaner.body.items, [], 'a replacement assignee must not inherit the former cleaner\'s photos')

  const cancelled = await getJson(baseUrl, formPhotoPath('cancelled-task', ['cancelled-task'], 'cleaner'), cleaner)
  assert.equal(cancelled.response.status, 403, 'cancelled records remain hidden even if the old source id is known')

  const deleted = await getJson(baseUrl, formPhotoPath('deleted-task', ['deleted-task'], 'cleaner'), cleaner)
  assert.equal(deleted.response.status, 403, 'deleted records remain hidden even if the old source id is known')

  const superseded = await getJson(baseUrl, formPhotoPath('superseded-task', ['superseded-task'], 'cleaner'), cleaner)
  assert.equal(superseded.response.status, 403, 'superseded records remain hidden even if the old source id is known')
}

async function verifyMediaByteRoute(baseUrl: string) {
  const cleaner = { id: 'cleaner-1', role: 'cleaner' }
  const inspector = { id: 'inspector-1', role: 'cleaning_inspector' }
  const pair = ['checkout-active', 'checkin-active']

  const cleanerOwn = await fetch(`${baseUrl}${mediaPath('cleaning/route/cleaner-own.jpg', pair, 'cleaner', 'checkout-active')}`, { headers: userHeaders(cleaner) })
  assert.equal(cleanerOwn.status, 200)
  assert.equal(cleanerOwn.headers.get('content-type'), 'image/jpeg')
  assert.ok((await cleanerOwn.arrayBuffer()).byteLength > 0)

  const inspectorKey = await fetch(`${baseUrl}${mediaPath('cleaning/route/guest-key.jpg', pair, 'inspector', 'checkout-active')}`, { headers: userHeaders(inspector) })
  assert.equal(inspectorKey.status, 200, 'the assigned inspector may read the canonical turnover cleaner key photo')
  await inspectorKey.arrayBuffer()

  const inspectorOwn = await fetch(`${baseUrl}${mediaPath('cleaning/route/inspector-own.jpg', pair, 'inspector', 'checkin-active')}`, { headers: userHeaders(inspector) })
  assert.equal(inspectorOwn.status, 200, 'the assigned inspector may read their own inspection photo bytes')
  await inspectorOwn.arrayBuffer()

  const manager = { id: 'manager-1', role: 'admin' }
  const managerOwnerless = await fetch(`${baseUrl}${mediaPath('cleaning/route/ownerless.jpg', pair, 'manager', 'checkout-active')}`, { headers: userHeaders(manager) })
  assert.equal(managerOwnerless.status, 200, 'a manager may read authorized legacy photo bytes without uploader attribution')
  await managerOwnerless.arrayBuffer()

  const readsAfterAuthorized = r2ReadCount
  const inspectorCleanerPhoto = await fetch(`${baseUrl}${mediaPath('cleaning/route/cleaner-own.jpg', pair, 'inspector', 'checkout-active')}`, { headers: userHeaders(inspector) })
  assert.equal(inspectorCleanerPhoto.status, 403, 'cross-phase inspection access is limited to the guest-key photo')

  const outsider = await fetch(`${baseUrl}${mediaPath('cleaning/route/cleaner-own.jpg', pair, 'cleaner', 'checkout-active')}`, { headers: userHeaders({ id: 'outsider-1', role: 'cleaner' }) })
  assert.equal(outsider.status, 403)

  const formerCleaner = await fetch(`${baseUrl}${mediaPath('cleaning/route/former-cleaner.jpg', ['reassigned-task'], 'cleaner', 'reassigned-task')}`, { headers: userHeaders(cleaner) })
  assert.equal(formerCleaner.status, 200, 'immutable completion evidence preserves the former cleaner\'s own photo access')
  await formerCleaner.arrayBuffer()

  const replacementCleaner = await fetch(`${baseUrl}${mediaPath('cleaning/route/former-cleaner.jpg', ['reassigned-task'], 'cleaner', 'reassigned-task')}`, { headers: userHeaders({ id: 'cleaner-2', role: 'cleaner' }) })
  assert.equal(replacementCleaner.status, 403, 'a reassignment must not transfer byte access to another uploader\'s photo')

  const cancelled = await fetch(`${baseUrl}${mediaPath('cleaning/route/cancelled.jpg', ['cancelled-task'], 'cleaner', 'cancelled-task')}`, { headers: userHeaders(cleaner) })
  assert.equal(cancelled.status, 403)

  const deleted = await fetch(`${baseUrl}${mediaPath('cleaning/route/deleted.jpg', ['deleted-task'], 'cleaner', 'deleted-task')}`, { headers: userHeaders(cleaner) })
  assert.equal(deleted.status, 403)

  const superseded = await fetch(`${baseUrl}${mediaPath('cleaning/route/superseded.jpg', ['superseded-task'], 'cleaner', 'superseded-task')}`, { headers: userHeaders(cleaner) })
  assert.equal(superseded.status, 403)

  const ownerless = await fetch(`${baseUrl}${mediaPath('cleaning/route/ownerless.jpg', ['checkout-active'], 'cleaner', 'checkout-active')}`, { headers: userHeaders(cleaner) })
  assert.equal(ownerless.status, 403, 'legacy media without uploader attribution fails closed for field staff')
  assert.equal(r2ReadCount, readsAfterAuthorized + 1, 'only the additionally authorized former cleaner request may reach object storage')
}

withRouteServer(async (baseUrl) => {
  await verifyFormPhotoRoute(baseUrl)
  await verifyMediaByteRoute(baseUrl)
})
  .then(() => process.stdout.write('test_mzapp_form_photo_routes: ok\n'))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
