import assert from 'assert'
import fs from 'fs'
import path from 'path'

process.env.DATABASE_URL = ''

async function main() {
  const { canViewMzappInspectionMedia, canViewMzappLockboxVideo, canViewMzappPropertyFeedback, canViewMzappRecordedCleaningMedia } = await import('../../src/modules/mzapp')
  const { feedbackMediaUrlArray } = await import('../../src/modules/cleaning_app')

  const row = {
    id: 'media-visibility-task',
    inspector_id: 'inspector-1',
    cleaner_id: 'cleaner-1',
    assignee_id: 'assignee-1',
  }

  assert.equal(
    await canViewMzappInspectionMedia({ sub: 'admin-1', role: 'admin', roles: ['admin'] }, row, 'admin-1'),
    true,
    'admin can read inspector media even when not assigned',
  )
  assert.equal(
    await canViewMzappInspectionMedia({ sub: 'offline-manager-1', role: 'offline_manager', roles: ['offline_manager'] }, row, 'offline-manager-1'),
    true,
    'offline manager can read inspector media even when not assigned',
  )
  assert.equal(
    await canViewMzappInspectionMedia({ sub: 'customer-service-1', role: 'customer_service', roles: ['customer_service'] }, row, 'customer-service-1'),
    true,
    'customer service can read inspector media consistently with manager view-all',
  )
  assert.equal(
    await canViewMzappInspectionMedia({ sub: 'inspector-1', role: 'cleaning_inspector', roles: ['cleaning_inspector'] }, row, 'inspector-1'),
    true,
    'assigned inspector can read inspector media',
  )
  assert.equal(
    await canViewMzappInspectionMedia({ sub: 'outsider-1', role: 'cleaner', roles: ['cleaner'] }, row, 'outsider-1'),
    false,
    'unassigned non-manager cannot read inspector media',
  )

  assert.equal(
    await canViewMzappRecordedCleaningMedia({ sub: 'inspector-1', role: 'cleaning_inspector', roles: ['cleaning_inspector'] }, row, 'inspector-1', 'inspection_living'),
    true,
    'assigned inspector can read a recorded inspection image',
  )
  assert.equal(
    await canViewMzappRecordedCleaningMedia({ sub: 'outsider-1', role: 'cleaning_inspector', roles: ['cleaning_inspector'] }, row, 'outsider-1', 'inspection_living'),
    false,
    'unassigned inspector cannot read another task inspection image by object key',
  )
  assert.equal(
    await canViewMzappRecordedCleaningMedia({ sub: 'cleaner-1', role: 'cleaner', roles: ['cleaner'] }, row, 'cleaner-1', 'completion_living'),
    true,
    'assigned cleaner can read the task completion image',
  )
  assert.equal(
    await canViewMzappRecordedCleaningMedia({ sub: 'outsider-1', role: 'cleaning_inspector', roles: ['cleaning_inspector'] }, row, 'outsider-1', 'lockbox_video'),
    false,
    'unassigned inspector cannot read another task lockbox video media by object key',
  )

  assert.equal(
    await canViewMzappPropertyFeedback({ sub: 'cleaner-1', role: 'cleaner', roles: ['cleaner'] }, row, 'cleaner-1'),
    true,
    'assigned cleaner can read this task property feedback',
  )
  assert.equal(
    await canViewMzappPropertyFeedback({ sub: 'inspector-1', role: 'cleaning_inspector', roles: ['cleaning_inspector'] }, row, 'inspector-1'),
    true,
    'assigned inspector can read this task property feedback',
  )
  assert.equal(
    await canViewMzappPropertyFeedback({ sub: 'outsider-1', role: 'cleaner', roles: ['cleaner'] }, row, 'outsider-1'),
    false,
    'an unrelated cleaner cannot read another task property feedback',
  )
  assert.deepEqual(
    feedbackMediaUrlArray(['cleaning/feedback-a.jpg', 'cleaning/feedback-b.jpg']),
    ['cleaning/feedback-a.jpg', 'cleaning/feedback-b.jpg'],
    'PostgreSQL text[] media values must stay as individual references for feedback authorization',
  )

  const mediaRouteSource = fs.readFileSync(path.resolve(__dirname, '../../src/modules/cleaning_app.ts'), 'utf8')
  const mediaRouteStart = mediaRouteSource.indexOf("'/media/image'")
  const mediaRouteEnd = mediaRouteSource.indexOf("'/upload'", mediaRouteStart)
  assert(mediaRouteStart >= 0 && mediaRouteEnd > mediaRouteStart, 'authenticated image route must exist')
  const mediaRoute = mediaRouteSource.slice(mediaRouteStart, mediaRouteEnd)
  assert.match(mediaRoute, /isPropertyFeedbackMediaKey/, 'feedback route must only accept approved private feedback key namespaces')
  assert.match(mediaRoute, /findPropertyFeedbackMediaRows/, 'feedback media must resolve its feedback record before reading R2')
  assert.match(mediaRoute, /feedbackMediaRows\.length === 1/, 'ambiguous feedback references must fail closed before reading R2')
  assert.match(mediaRoute, /canViewMzappPropertyFeedback/, 'feedback media must require the current task participant')
  assert.match(mediaRoute, /source_task_id/, 'feedback media must receive the current task source')
  assert.match(mediaRouteSource, /to_jsonb\(m\.photo_urls\) AS photo_urls/, 'maintenance text[] media must be normalized to a JSON array before exact reference matching')
  assert.match(mediaRouteSource, /to_jsonb\(d\.photo_urls\) AS photo_urls/, 'deep-cleaning legacy media must be normalized before exact reference matching')

  for (const role of ['admin', 'offline_manager', 'customer_service', 'cleaning_inspector', 'cleaner_inspector']) {
    assert.equal(
      canViewMzappLockboxVideo({ role, roles: [role] }),
      true,
      `${role} can view lockbox video`,
    )
  }
  assert.equal(
    canViewMzappLockboxVideo({ sub: 'cleaner-1', role: 'cleaner', roles: ['cleaner'] }),
    false,
    'ordinary cleaner cannot view lockbox video',
  )
  assert.equal(
    canViewMzappLockboxVideo({ sub: 'staff-1', role: 'staff', roles: ['staff'] }),
    false,
    'unclassified staff cannot view lockbox video',
  )

  process.stdout.write('test_mzapp_media_visibility: ok\n')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
