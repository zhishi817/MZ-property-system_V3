import assert from 'assert'
import fs from 'fs'
import path from 'path'

process.env.DATABASE_URL = ''

async function main() {
  const { canViewMzappInspectionMedia, canViewMzappLockboxVideo, canViewMzappPropertyFeedback, canViewMzappRecordedCleaningMedia, propertyFeedbackCapabilities } = await import('../../src/modules/mzapp')
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
    true,
    'an authenticated internal user can read property-scoped feedback history without being this task participant',
  )
  assert.equal(
    await canViewMzappPropertyFeedback({}, row, ''),
    false,
    'an unauthenticated caller cannot read property feedback history',
  )
  assert.deepEqual(
    propertyFeedbackCapabilities({ sub: 'creator-1', role: 'cleaner', roles: ['cleaner'] }, 'daily_necessities', { created_by_user_id: 'creator-1' }),
    { can_edit_content: true, can_delete: true, can_move_category: false },
    'the true submitter can only edit/delete their own non-workflow feedback record',
  )
  assert.deepEqual(
    propertyFeedbackCapabilities({ sub: 'other-1', role: 'cleaner', roles: ['cleaner'] }, 'daily_necessities', { created_by_user_id: 'creator-1' }),
    { can_edit_content: false, can_delete: false, can_move_category: false },
    'a non-owner cannot mutate another user feedback record',
  )
  assert.deepEqual(
    propertyFeedbackCapabilities({ sub: 'manager-1', role: 'offline_manager', roles: ['offline_manager'] }, 'deep_cleaning', { created_by_user_id: null }),
    { can_edit_content: true, can_delete: true, can_move_category: true },
    'offline managers can manage legacy records but legacy rows remain ordinary-user read-only',
  )
  assert.deepEqual(
    propertyFeedbackCapabilities({ sub: 'creator-1', role: 'cleaner', roles: ['cleaner'] }, 'maintenance', { created_by_user_id: 'creator-1', status: 'in_progress' }),
    { can_edit_content: true, can_delete: false, can_move_category: false },
    'a submitter cannot directly withdraw maintenance after it entered workflow',
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
  assert.match(mediaRoute, /canViewMzappPropertyFeedback/, 'feedback media must re-check the current authenticated user')
  assert.doesNotMatch(mediaRoute, /requireAnyPerm/, 'feedback image reading must not require a task execution permission')
  const maintenanceSource = fs.readFileSync(path.resolve(__dirname, '../../src/modules/maintenance.ts'), 'utf8')
  assert.match(maintenanceSource, /const key = `maintenance\//, 'the official maintenance upload endpoint must own its maintenance key namespace')
  assert.match(mediaRouteSource, /!key\.startsWith\('mzapp\/'\) && !key\.startsWith\('maintenance\/'\)/, 'the authenticated proxy must accept the official maintenance namespace only through its recorded-media path')
  assert.doesNotMatch(mediaRouteSource, /if \(!key\.startsWith\('mzapp\/'\)\) return false/, 'the proxy must not reject official maintenance upload keys before record authorization')
  assert.match(mediaRouteSource, /JOIN properties p ON p\.id::text = m\.property_id::text/, 'feedback media must resolve maintenance media through its real property')
  assert.match(mediaRouteSource, /m\.deleted_at IS NULL/, 'soft-deleted feedback must not resolve normal media URLs')
  assert.match(mediaRouteSource, /to_jsonb\(m\.photo_urls\) AS photo_urls/, 'maintenance text[] media must be normalized to a JSON array before exact reference matching')
  assert.match(mediaRouteSource, /to_jsonb\(m\.completion_photo_urls\) AS completion_photo_urls/, 'maintenance completion media must be normalized before exact reference matching')
  assert.match(mediaRouteSource, /COALESCE\(m\.completion_photo_urls::text, ''\) LIKE \$1/, 'maintenance completion media must be discoverable by the authenticated proxy')
  assert.match(mediaRouteSource, /feedbackMediaUrlArray\(row\?\.completion_photo_urls\)/, 'completion media must be checked against its exact maintenance record')
  assert.match(mediaRouteSource, /FROM external_maintenance_orders e/, 'external maintenance completion media must resolve through its workflow record')
  assert.match(mediaRouteSource, /canViewExternalMaintenanceCompletionMedia/, 'external completion media must be authorized against manager or assigned maintenance staff')
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
