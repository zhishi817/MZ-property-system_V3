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
  inspection_mode?: string | null
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
    id: 'self-complete-active',
    task_date: '2026-10-20',
    property_id: 'property-6',
    property_code: 'ROUTE-606',
    task_type: 'checkout_clean',
    status: 'keys_hung',
    execution_state: 'active',
    order_id: 'self-complete-order',
    order_checkin: '2026-10-18',
    order_checkout: '2026-10-20',
    inspector_id: null,
    cleaner_id: 'cleaner-1',
    assignee_id: null,
    inspection_mode: 'self_complete',
  },
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
    id: 'feedback-task',
    task_date: '2026-10-21',
    property_id: 'property-1',
    property_code: 'ROUTE-101',
    task_type: 'checkout_clean',
    status: 'done',
    execution_state: 'active',
    order_id: 'feedback-order',
    order_checkin: '2026-10-19',
    order_checkout: '2026-10-21',
    inspector_id: 'inspector-1',
    cleaner_id: 'cleaner-1',
    assignee_id: null,
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
  { id: 'lockbox-1', task_id: 'checkout-active', type: 'lockbox_video', url: 'cleaning/route/lockbox.mp4', uploader_id: 'cleaner-1' },
  { id: 'self-complete-lockbox', task_id: 'self-complete-active', type: 'lockbox_video', url: 'cleaning/route/self-complete-lockbox.mp4', uploader_id: 'cleaner-1' },
  { id: 'inspection-1', task_id: 'checkin-active', type: 'inspection_living', url: 'cleaning/route/inspector-own.jpg', uploader_id: 'inspector-1' },
  { id: 'inspection-unclean', task_id: 'checkin-active', type: 'inspection_unclean', url: 'cleaning/route/inspection-unclean.jpg', uploader_id: 'inspector-1' },
  { id: 'inspection-lockbox', task_id: 'checkin-active', type: 'lockbox_video', url: 'cleaning/route/inspector-lockbox.mp4', uploader_id: 'inspector-1' },
  { id: 'reassigned-1', task_id: 'reassigned-task', type: 'completion_kitchen', url: 'cleaning/route/former-cleaner.jpg', uploader_id: 'cleaner-1' },
  { id: 'reassigned-video', task_id: 'reassigned-task', type: 'lockbox_video', url: 'cleaning/route/former-cleaner.mp4', uploader_id: 'cleaner-1' },
  { id: 'reassigned-replacement', task_id: 'reassigned-task', type: 'completion_living', url: 'cleaning/route/replacement-cleaner.jpg', uploader_id: 'cleaner-2' },
  { id: 'cancelled-1', task_id: 'cancelled-task', type: 'completion_bedroom', url: 'cleaning/route/cancelled.jpg', uploader_id: 'cleaner-1' },
  { id: 'deleted-1', task_id: 'deleted-task', type: 'completion_bedroom', url: 'cleaning/route/deleted.jpg', uploader_id: 'cleaner-1' },
  { id: 'superseded-1', task_id: 'superseded-task', type: 'completion_bedroom', url: 'cleaning/route/superseded.jpg', uploader_id: 'cleaner-1' },
  { id: 'ownerless-1', task_id: 'checkout-active', type: 'consumable_item_photo:coffee', url: 'cleaning/route/ownerless.jpg', uploader_id: null },
]

const feedbackMedia = [
  {
    feedback_source_type: 'property_maintenance',
    feedback_source_id: 'feedback-active',
    property_id: 'property-1',
    source_task_id: 'feedback-task',
    created_by_user_id: 'cleaner-1',
    photo_urls: ['mzapp/feedback/active.jpg'],
  },
  {
    feedback_source_type: 'property_maintenance',
    feedback_source_id: 'feedback-cancelled',
    property_id: 'property-3',
    source_task_id: 'cancelled-task',
    created_by_user_id: 'cleaner-1',
    photo_urls: ['mzapp/feedback/cancelled.jpg'],
  },
  {
    feedback_source_type: 'property_maintenance',
    feedback_source_id: 'feedback-deleted',
    property_id: 'property-4',
    source_task_id: 'deleted-task',
    created_by_user_id: 'cleaner-1',
    photo_urls: ['mzapp/feedback/deleted.jpg'],
  },
  {
    feedback_source_type: 'property_maintenance',
    feedback_source_id: 'feedback-superseded',
    property_id: 'property-5',
    source_task_id: 'superseded-task',
    created_by_user_id: 'cleaner-1',
    photo_urls: ['mzapp/feedback/superseded.jpg'],
  },
]

const historicalFeedbackMedia = [{
  feedback_source_type: 'property_maintenance',
  feedback_source_id: 'feedback-historical',
  property_id: 'property-1',
  source_task_id: null,
  created_by_user_id: null,
  photo_urls: ['mzapp/feedback/historical-event.jpg'],
  before_photo_urls: null,
  after_photo_urls: null,
  repair_photo_urls: null,
  completion_photo_urls: null,
  attachment_urls: null,
  project_items: null,
  assignee_id: 'replacement-repairer',
  work_task_id: 'property_maintenance:feedback-historical',
  historical_work_record_media: true,
  work_record_actor_user_id: 'repairer-1',
}]

const completionEvidence = new Map<string, Set<string>>([
  ['cleaner-1', new Set(['checkout-active', 'self-complete-active', 'reassigned-task', 'cancelled-task', 'deleted-task', 'superseded-task'])],
])
const inspectionEvidence = new Map<string, Set<string>>([
  ['inspector-1', new Set(['checkin-active', 'same-day-independent'])],
])
const inspectionSubmissionReceipts = new Map([
  ['checkin-active', {
    submit_id: 'inspection-batch-checkin-active',
    created_at: '2026-10-21T01:02:00.000Z',
    updated_at: '2026-10-21T01:03:00.000Z',
  }],
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
    if (/FROM work_task_action_audits/.test(sql) && Array.isArray(params[0])) {
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
        .filter((item) => ids.has(item.task_id) && (item.type !== 'lockbox_video' || params[1] === true))
        .map((item) => ({
          ...item,
          captured_at: '2026-10-21T01:00:00.000Z',
          created_at: '2026-10-21T01:00:00.000Z',
        }))
      return { rows, rowCount: rows.length }
    }
    if (/FROM cleaning_tasks\s+WHERE id=\$1/.test(sql)) {
      const task = tasks.find((candidate) => candidate.id === String(params[0] || ''))
      const rows = task ? [task] : []
      return { rows, rowCount: rows.length }
    }
    if (/FROM cleaning_task_media/.test(sql) && /task_id=\$1 AND type LIKE 'inspection_%'/.test(sql)) {
      const taskId = String(params[0] || '')
      const rows = media
        .filter((item) => item.task_id === taskId && item.type.startsWith('inspection_'))
        .map((item) => ({
          ...item,
          note: null,
          captured_at: '2026-10-21T01:00:00.000Z',
          created_at: '2026-10-21T01:00:00.000Z',
        }))
      return { rows, rowCount: rows.length }
    }
    if (/FROM app_submit_receipts/.test(sql)) {
      const receipt = inspectionSubmissionReceipts.get(String(params[0] || ''))
      const rows = receipt ? [receipt] : []
      return { rows, rowCount: rows.length }
    }
    if (/^\s*SELECT metadata\s+FROM work_task_action_audits/.test(sql)) return { rows: [], rowCount: 0 }
    if (/FROM property_maintenance m[\s\S]*UNION ALL[\s\S]*FROM property_deep_cleaning d/.test(sql)) {
      const keyPattern = String(params[0] || '').replace(/^%|%$/g, '')
      const rows = feedbackMedia
        .filter((item) => item.photo_urls.includes(keyPattern))
        .map((item) => ({
          ...item,
          before_photo_urls: null,
          after_photo_urls: null,
          repair_photo_urls: null,
          completion_photo_urls: null,
          attachment_urls: null,
          project_items: null,
          assignee_id: null,
          work_task_id: null,
          historical_work_record_media: false,
          work_record_actor_user_id: null,
        }))
      if (String(params[1] || '') === 'property_maintenance:feedback-historical') {
        rows.push(...historicalFeedbackMedia.filter((item) => item.photo_urls.includes(keyPattern)) as any)
      }
      return { rows, rowCount: rows.length }
    }
    if (/FROM work_tasks[\s\S]*source_type = 'property_maintenance'/.test(sql)) {
      const workTaskId = String(params[0] || '')
      const sourceId = String(params[1] || '')
      const propertyId = String(params[2] || '')
      const rows = workTaskId === 'property_maintenance:feedback-active'
        && sourceId === 'feedback-active'
        && propertyId === 'property-1'
        ? [{ id: workTaskId, assignee_id: 'repairer-1' }]
        : []
      return { rows, rowCount: rows.length }
    }
    if (/FROM cleaning_tasks\s+WHERE id::text = \$1::text/.test(sql)) {
      const task = tasks.find((candidate) => candidate.id === String(params[0] || ''))
      const rows = task?.execution_state === 'active' ? [task] : []
      return { rows, rowCount: rows.length }
    }
    if (/FROM cleaning_tasks t[\s\S]*LEFT JOIN properties p_id/.test(sql)) {
      const task = tasks.find((candidate) => candidate.id === String(params[0] || ''))
      const rows = task?.execution_state === 'active'
        ? [{
            ...task,
            is_manual_participant: false,
            can_manual_report: false,
            has_execution_evidence: false,
            has_inspection_evidence: false,
          }]
        : []
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
  assert.ok(
    media.some((item) => item.url === key)
      || feedbackMedia.some((item) => item.photo_urls.includes(key))
      || historicalFeedbackMedia.some((item) => item.photo_urls.includes(key)),
    `only a recorded fixture key may reach object storage: ${key}`,
  )
  r2ReadCount += 1
  if (key.endsWith('.mp4')) {
    return {
      body: Buffer.from('0123456789-video-bytes'),
      contentType: 'video/mp4',
      etag: `route-video-${r2ReadCount}`,
    }
  }
  return {
    body: await sharp({ create: { width: 2, height: 2, channels: 3, background: '#2266aa' } }).png().toBuffer(),
    contentType: 'image/png',
    etag: `route-${r2ReadCount}`,
  }
}

const { router: mzappRouter, canViewMzappPropertyFeedback, propertyFeedbackSourceTaskAccess } = require('../../src/modules/mzapp')
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

function formPhotoPath(workTaskId: string, sourceIds: string[], scope: string, includeVideos = false) {
  const query = new URLSearchParams({ source_ids: sourceIds.join(','), scope })
  if (includeVideos) query.set('include_videos', '1')
  return `/mzapp/work-tasks/${encodeURIComponent(workTaskId)}/form-photos?${query}`
}

function mediaPath(key: string, sourceIds: string[], scope: string, sourceTaskId: string, variant?: string) {
  const query = new URLSearchParams({
    key,
    source_ids: sourceIds.join(','),
    media_scope: scope,
    source_task_id: sourceTaskId,
  })
  if (variant) query.set('variant', variant)
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

  const syntheticRecordId = 'cleaning_tasks_cleaner:checkout-active::record:completed:2026-10-21'
  const syntheticRecord = await getJson(baseUrl, formPhotoPath(syntheticRecordId, ['checkout-active'], 'cleaner'), cleaner)
  assert.equal(syntheticRecord.response.status, 200, 'a synthetic work-record id must resolve its exact Root-issued source id')
  assert.deepEqual(syntheticRecord.body.items.map((item: any) => item.id).sort(), ['completion-1', 'key-1'])

  const inspectorResult = await getJson(baseUrl, formPhotoPath(pairId, ['checkout-active', 'checkin-active'], 'inspector'), inspector)
  assert.equal(inspectorResult.response.status, 200)
  assert.deepEqual(inspectorResult.body.items.map((item: any) => item.id).sort(), ['inspection-1', 'inspection-unclean', 'key-1'])

  const inspectorWithVideo = await getJson(baseUrl, formPhotoPath(pairId, ['checkout-active', 'checkin-active'], 'inspector', true), inspector)
  assert.equal(inspectorWithVideo.response.status, 200)
  assert.deepEqual(inspectorWithVideo.body.items.map((item: any) => item.id).sort(), ['inspection-1', 'inspection-lockbox', 'inspection-unclean', 'key-1'])

  const managerResult = await getJson(baseUrl, formPhotoPath(pairId, ['checkout-active', 'checkin-active'], 'manager'), manager)
  assert.equal(managerResult.response.status, 200)
  assert.deepEqual(managerResult.body.items.map((item: any) => item.id).sort(), ['completion-1', 'inspection-1', 'inspection-unclean', 'key-1', 'ownerless-1'])

  const managerWithVideo = await getJson(baseUrl, formPhotoPath(pairId, ['checkout-active', 'checkin-active'], 'manager', true), { id: 'customer-service-1', role: 'customer_service' })
  assert.equal(managerWithVideo.response.status, 200)
  assert.deepEqual(managerWithVideo.body.items.map((item: any) => item.id).sort(), ['completion-1', 'inspection-1', 'inspection-lockbox', 'key-1', 'lockbox-1', 'ownerless-1'])

  const selfCompleteVideo = await getJson(baseUrl, formPhotoPath('self-complete-active', ['self-complete-active'], 'cleaner', true), cleaner)
  assert.equal(selfCompleteVideo.response.status, 200)
  assert.deepEqual(selfCompleteVideo.body.items.map((item: any) => item.id), ['self-complete-lockbox'])

  const outsider = await getJson(baseUrl, formPhotoPath(pairId, ['checkout-active', 'checkin-active'], 'cleaner'), { id: 'outsider-1', role: 'cleaner' })
  assert.equal(outsider.response.status, 403)

  const independent = await getJson(baseUrl, formPhotoPath(pairId, ['checkout-active', 'same-day-independent'], 'inspector'), inspector)
  assert.equal(independent.response.status, 403, 'same property/date without a booking boundary must not share photos')

  const formerCleaner = await getJson(baseUrl, formPhotoPath('reassigned-task', ['reassigned-task'], 'cleaner'), cleaner)
  assert.equal(formerCleaner.response.status, 200)
  assert.deepEqual(formerCleaner.body.items.map((item: any) => item.id), ['reassigned-1'])

  const reassignedManager = await getJson(baseUrl, formPhotoPath('reassigned-task', ['reassigned-task'], 'manager', true), { id: 'customer-service-1', role: 'customer_service' })
  assert.equal(reassignedManager.response.status, 200)
  assert.deepEqual(reassignedManager.body.items.map((item: any) => item.id).sort(), ['reassigned-1', 'reassigned-replacement', 'reassigned-video'])

  const replacementCleaner = await getJson(baseUrl, formPhotoPath('reassigned-task', ['reassigned-task'], 'cleaner'), { id: 'cleaner-2', role: 'cleaner' })
  assert.equal(replacementCleaner.response.status, 200)
  assert.deepEqual(replacementCleaner.body.items.map((item: any) => item.id), ['reassigned-replacement'], 'a replacement assignee sees only their own media, never the former cleaner\'s photos')

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

  const managerInspectionUnclean = await fetch(`${baseUrl}${mediaPath('cleaning/route/inspection-unclean.jpg', pair, 'manager', 'checkin-active')}`, { headers: userHeaders(manager) })
  assert.equal(managerInspectionUnclean.status, 200, 'admin and offline manager may read inspection unclean evidence for the exact task')
  await managerInspectionUnclean.arrayBuffer()

  const offlineManagerInspectionUnclean = await fetch(
    `${baseUrl}${mediaPath('cleaning/route/inspection-unclean.jpg', pair, 'manager', 'checkin-active')}`,
    { headers: userHeaders({ id: 'offline-manager-1', role: 'offline_manager' }) },
  )
  assert.equal(offlineManagerInspectionUnclean.status, 200, 'offline manager retains exact-source inspection unclean access')
  await offlineManagerInspectionUnclean.arrayBuffer()

  const customerServiceInspectionUnclean = await fetch(
    `${baseUrl}${mediaPath('cleaning/route/inspection-unclean.jpg', pair, 'manager', 'checkin-active')}`,
    { headers: userHeaders({ id: 'customer-service-1', role: 'customer_service' }) },
  )
  assert.equal(customerServiceInspectionUnclean.status, 403, 'customer service must not inherit inspection unclean evidence through the shared manager route')

  const customerServiceLegacyInspectionUnclean = await fetch(
    `${baseUrl}/cleaning-app/media/image?key=${encodeURIComponent('cleaning/route/inspection-unclean.jpg')}&source_task_id=checkin-active`,
    { headers: userHeaders({ id: 'customer-service-1', role: 'customer_service' }) },
  )
  assert.equal(customerServiceLegacyInspectionUnclean.status, 403, 'customer service must not recover inspection unclean bytes through the legacy unscoped media route')

  const customerService = { id: 'customer-service-1', role: 'customer_service' }
  const managerVideo = await fetch(
    `${baseUrl}${mediaPath('cleaning/route/lockbox.mp4', pair, 'manager', 'checkout-active', 'source')}`,
    { headers: { ...userHeaders(customerService), range: 'bytes=2-7' } },
  )
  assert.equal(managerVideo.status, 206, 'customer service may stream an exact-source historical lockbox video')
  assert.equal(managerVideo.headers.get('content-type'), 'video/mp4')
  assert.equal(managerVideo.headers.get('accept-ranges'), 'bytes')
  assert.equal(managerVideo.headers.get('content-range'), 'bytes 2-7/22')
  assert.equal(Buffer.from(await managerVideo.arrayBuffer()).toString(), '234567')

  const unscopedVideo = await fetch(
    `${baseUrl}/cleaning-app/media/image?key=${encodeURIComponent('cleaning/route/lockbox.mp4')}&variant=source&source_task_id=checkout-active`,
    { headers: userHeaders(customerService) },
  )
  assert.equal(unscopedVideo.status, 403, 'video bytes require Root-issued exact source ids and media scope')

  const photoAsSource = await fetch(
    `${baseUrl}${mediaPath('cleaning/route/cleaner-own.jpg', pair, 'manager', 'checkout-active', 'source')}`,
    { headers: userHeaders(customerService) },
  )
  assert.equal(photoAsSource.status, 403, 'the raw-byte variant is limited to recorded lockbox videos')

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

async function verifyLegacyInspectionPhotoRoute(baseUrl: string) {
  const customerService = await getJson(
    baseUrl,
    '/mzapp/cleaning-tasks/checkin-active/inspection-photos',
    { id: 'customer-service-1', role: 'customer_service' },
  )
  assert.equal(customerService.response.status, 200)
  assert.deepEqual(
    customerService.body.items.map((item: any) => item.area),
    ['living'],
    'the legacy inspection-photo list must preserve the customer-service unclean-photo boundary',
  )
  assert.deepEqual(customerService.body.formal_submission, {
    status: 'submitted',
    submit_id: 'inspection-batch-checkin-active',
    saved_at: '2026-10-21T01:03:00.000Z',
    guest_arrival_confirmed: false,
  })

  const admin = await getJson(
    baseUrl,
    '/mzapp/cleaning-tasks/checkin-active/inspection-photos',
    { id: 'manager-1', role: 'admin' },
  )
  assert.equal(admin.response.status, 200)
  assert.deepEqual(admin.body.items.map((item: any) => item.area).sort(), ['living', 'unclean'])

  const offlineManager = await getJson(
    baseUrl,
    '/mzapp/cleaning-tasks/checkin-active/inspection-photos',
    { id: 'offline-manager-1', role: 'offline_manager' },
  )
  assert.equal(offlineManager.response.status, 200)
  assert.deepEqual(offlineManager.body.items.map((item: any) => item.area).sort(), ['living', 'unclean'])
}

async function verifyHistoricalFeedbackMediaRoute(baseUrl: string) {
  const cleaner = { id: 'cleaner-1', role: 'cleaner' }
  const inspector = { id: 'inspector-1', role: 'cleaning_inspector' }
  const outsider = { id: 'outsider-1', role: 'cleaner' }
  const request = (key: string, sourceTaskId: string | null, user: TestUser, workTaskId: string | null = null) => {
    const query = new URLSearchParams({ key })
    if (sourceTaskId) query.set('source_task_id', sourceTaskId)
    if (workTaskId) query.set('work_task_id', workTaskId)
    return fetch(`${baseUrl}/cleaning-app/media/image?${query}`, { headers: userHeaders(user) })
  }

  const creator = await request('mzapp/feedback/active.jpg', 'feedback-task', cleaner)
  assert.equal(creator.status, 200, 'the exact source-task creator may read their historical report image')
  assert.ok((await creator.arrayBuffer()).byteLength > 0)

  const creatorWithoutClientContext = await request('mzapp/feedback/active.jpg', null, cleaner)
  assert.equal(creatorWithoutClientContext.status, 200, 'the server derives an active exact source task when the optional client context is omitted')
  assert.ok((await creatorWithoutClientContext.arrayBuffer()).byteLength > 0)

  const inspectorSourceAccess = await propertyFeedbackSourceTaskAccess(
    { sub: inspector.id, role: inspector.role, roles: [inspector.role] },
    feedbackMedia[0].property_id,
    feedbackMedia[0].source_task_id,
  )
  assert.deepEqual(
    inspectorSourceAccess,
    { exists: true, canViewHistory: true, canCreate: true, feedbackSource: 'inspection_feedback' },
    'the exact source-task inspector resolves the active task and retains history access',
  )
  assert.equal(
    await canViewMzappPropertyFeedback(
      { sub: inspector.id, role: inspector.role, roles: [inspector.role] },
      feedbackMedia[0],
      inspector.id,
    ),
    true,
    'the exact source-task inspector keeps history permission independently of the media byte route',
  )
  const anotherAuthorizedExecutor = await request('mzapp/feedback/active.jpg', 'feedback-task', inspector)
  assert.equal(anotherAuthorizedExecutor.status, 200, 'another executor assigned to the exact source task may read its report image')
  assert.ok((await anotherAuthorizedExecutor.arrayBuffer()).byteLength > 0)

  const maintenanceExecutor = await request(
    'mzapp/feedback/active.jpg',
    null,
    { id: 'repairer-1', role: 'maintenance_staff' },
    'property_maintenance:feedback-active',
  )
  assert.equal(maintenanceExecutor.status, 200, 'an exact maintenance work-task assignee may read their own linked feedback media without joining the original cleaning task')
  assert.ok((await maintenanceExecutor.arrayBuffer()).byteLength > 0)

  const historicalActor = await request(
    'mzapp/feedback/historical-event.jpg',
    null,
    { id: 'repairer-1', role: 'maintenance_staff' },
    'property_maintenance:feedback-historical',
  )
  assert.equal(historicalActor.status, 200, 'an immutable completion-event actor may read their exact historical photo')
  assert.ok((await historicalActor.arrayBuffer()).byteLength > 0)

  const historicalReplacement = await request(
    'mzapp/feedback/historical-event.jpg',
    null,
    { id: 'replacement-repairer', role: 'maintenance_staff' },
    'property_maintenance:feedback-historical',
  )
  assert.equal(historicalReplacement.status, 403, 'a replacement assignee must not inherit the immutable actor photo')

  const wrongSamePropertySource = await request('mzapp/feedback/active.jpg', 'same-day-independent', inspector)
  assert.equal(wrongSamePropertySource.status, 403, 'same-property task context may not borrow another task report image')

  for (const invalidSource of ['cancelled-task', 'deleted-task', 'superseded-task']) {
    const invalid = await request(`mzapp/feedback/${invalidSource.replace('-task', '')}.jpg`, invalidSource, cleaner)
    assert.equal(invalid.status, 403, `${invalidSource} may not authorize historical report media`)
    const omittedContext = await request(`mzapp/feedback/${invalidSource.replace('-task', '')}.jpg`, null, cleaner)
    assert.equal(omittedContext.status, 403, `${invalidSource} remains denied when the client omits source_task_id`)
  }

  const unrelated = await request('mzapp/feedback/active.jpg', 'feedback-task', outsider)
  assert.equal(unrelated.status, 403, 'an unrelated worker may not read exact-source historical report media')
}

withRouteServer(async (baseUrl) => {
  await verifyFormPhotoRoute(baseUrl)
  await verifyMediaByteRoute(baseUrl)
  await verifyLegacyInspectionPhotoRoute(baseUrl)
  await verifyHistoricalFeedbackMediaRoute(baseUrl)
})
  .then(() => process.stdout.write('test_mzapp_form_photo_routes: ok\n'))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
