import assert from 'assert'
import fs from 'fs'
import path from 'path'

process.env.DATABASE_URL = ''

async function main() {
  const { canViewMzappGuestLuggageNoticeMedia, canViewMzappHistoricalWorkRecordMedia, canViewMzappInspectionMedia, canViewMzappLockboxVideo, canViewMzappOfflineWorkTaskMedia, canViewMzappPropertyFeedback, canViewMzappRecordedCleaningMedia, propertyFeedbackCapabilities } = await import('../../src/modules/mzapp')
  const { canViewExternalMaintenanceCompletionMedia, feedbackMediaRowReferencesKey, feedbackMediaUrlArray, findPropertyFeedbackMediaRows } = await import('../../src/modules/cleaning_app')

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
    await canViewMzappRecordedCleaningMedia({ sub: 'cleaner-1', role: 'cleaner', roles: ['cleaner'] }, row, 'cleaner-1', 'inspection_living'),
    true,
    'an assigned cleaner can read inspection photos for the task they can see',
  )
  assert.equal(
    await canViewMzappRecordedCleaningMedia({ sub: 'assignee-1', role: 'cleaner', roles: ['cleaner'] }, row, 'assignee-1', 'restock_proof:item-a'),
    true,
    'an assigned task executor can read restock photos for the task they can see',
  )
  assert.equal(
    await canViewMzappRecordedCleaningMedia({ sub: 'outsider-1', role: 'cleaning_inspector', roles: ['cleaning_inspector'] }, row, 'outsider-1', 'inspection_living'),
    false,
    'unassigned inspector cannot read another task inspection image by object key',
  )
  assert.equal(
    await canViewMzappRecordedCleaningMedia(
      { sub: 'uploader-1', role: 'cleaner', roles: ['cleaner'] },
      { ...row, uploader_id: 'uploader-1' },
      'uploader-1',
      'inspection_living',
    ),
    true,
    'the authenticated uploader can read their own recorded task media even when not assigned to the task',
  )
  assert.equal(
    await canViewMzappRecordedCleaningMedia(
      { sub: 'outsider-1', role: 'cleaner', roles: ['cleaner'] },
      { ...row, uploader_id: 'uploader-1' },
      'outsider-1',
      'inspection_living',
    ),
    false,
    'an unrelated user cannot inherit uploader access',
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

  const offlineRow = { id: 'cleaning_offline_tasks:offline-1', assignee_id: 'assignee-1' }
  assert.equal(
    await canViewMzappOfflineWorkTaskMedia({ sub: 'offline-manager-1', role: 'offline_manager', roles: ['offline_manager'] }, offlineRow, 'offline-manager-1'),
    true,
    'offline managers can read an exact recorded offline task photo',
  )
  assert.equal(
    await canViewMzappOfflineWorkTaskMedia({ sub: 'assignee-1', role: 'cleaner', roles: ['cleaner'] }, offlineRow, 'assignee-1'),
    true,
    'the assigned offline worker can read their task photo',
  )
  assert.equal(
    await canViewMzappOfflineWorkTaskMedia({ sub: 'outsider-1', role: 'cleaner', roles: ['cleaner'] }, offlineRow, 'outsider-1'),
    false,
    'an unrelated worker cannot read another offline task photo',
  )

  const externalMaintenanceRow = {
    work_task_id: 'external_maintenance_orders:order-1',
    assignee_id: 'executor-b',
  }
  const externalHistoricalMaintenanceRow = {
    ...externalMaintenanceRow,
    historical_work_record_media: true,
    work_record_actor_user_id: 'executor-a',
  }
  const externalHistoryPool = {
    query: async () => ({
      rows: [{
        payload: {
          patch: { completion_photo_urls: ['maintenance/executor-a-proof.jpg'] },
        },
      }],
    }),
  }
  assert.equal(
    await canViewExternalMaintenanceCompletionMedia(
      externalHistoryPool,
      { sub: 'executor-a', role: 'maintenance_staff', roles: ['maintenance_staff'] },
      externalHistoricalMaintenanceRow,
      'executor-a',
      'external_maintenance_orders:order-1',
      'maintenance/executor-a-proof.jpg',
    ),
    true,
    'a former external-maintenance executor may read only their exact immutable event photo through the canonical task id',
  )
  assert.equal(
    await canViewExternalMaintenanceCompletionMedia(
      externalHistoryPool,
      { sub: 'executor-a', role: 'maintenance_staff', roles: ['maintenance_staff'] },
      externalHistoricalMaintenanceRow,
      'executor-a',
      'external_maintenance_orders:other-order',
      'maintenance/executor-a-proof.jpg',
    ),
    false,
    'a mismatched canonical work-task id must not authorize a former executor media read',
  )
  assert.equal(
    await canViewExternalMaintenanceCompletionMedia(
      externalHistoryPool,
      { sub: 'executor-a', role: 'maintenance_staff', roles: ['maintenance_staff'] },
      externalHistoricalMaintenanceRow,
      'executor-a',
      'external_maintenance_orders:order-1',
      'maintenance/executor-b-proof.jpg',
    ),
    false,
    'a former executor cannot read a different photo from the same task',
  )
  assert.equal(
    await canViewExternalMaintenanceCompletionMedia(
      externalHistoryPool,
      { sub: 'executor-b', role: 'maintenance_staff', roles: ['maintenance_staff'] },
      externalHistoricalMaintenanceRow,
      'executor-b',
      'external_maintenance_orders:order-1',
      'maintenance/executor-a-proof.jpg',
    ),
    false,
    'the current replacement assignee cannot inherit a prior executor historical-media grant',
  )
  assert.equal(
    await canViewExternalMaintenanceCompletionMedia(
      externalHistoryPool,
      { sub: 'offline-manager-1', role: 'offline_manager', roles: ['offline_manager'] },
      externalHistoricalMaintenanceRow,
      'offline-manager-1',
      'external_maintenance_orders:order-1',
      'maintenance/executor-a-proof.jpg',
    ),
    true,
    'an offline manager can read the immutable external-maintenance work record',
  )
  assert.equal(
    await canViewExternalMaintenanceCompletionMedia(
      externalHistoryPool,
      { sub: 'executor-b', role: 'maintenance_staff', roles: ['maintenance_staff'] },
      externalMaintenanceRow,
      'executor-b',
      'external_maintenance_orders:order-1',
      'maintenance/live-current-proof.jpg',
    ),
    true,
    'the current assignee retains access to live external-maintenance media',
  )

  const historicalMediaLookupPool = {
    query: async (sql: string, params: any[]) => {
      assert.match(sql, /FROM work_task_events event[\s\S]*?w\.id::text = \$2::text/, 'historical media lookup must bind the exact canonical work-task id')
      assert.deepEqual(params, ['%maintenance/executor-a-proof.jpg%', 'external_maintenance_orders:order-1'])
      return {
        rows: [{
          feedback_source_type: 'external_maintenance_orders',
          feedback_source_id: 'order-1',
          work_task_id: 'external_maintenance_orders:order-1',
          assignee_id: 'executor-b',
          historical_work_record_media: true,
          work_record_actor_user_id: 'executor-a',
          completion_photo_urls: ['maintenance/executor-a-proof.jpg'],
        }],
      }
    },
  }
  assert.deepEqual(
    await findPropertyFeedbackMediaRows(
      historicalMediaLookupPool,
      'maintenance/executor-a-proof.jpg',
      'external_maintenance_orders:order-1',
    ),
    [{
      feedback_source_type: 'external_maintenance_orders',
      feedback_source_id: 'order-1',
      work_task_id: 'external_maintenance_orders:order-1',
      assignee_id: 'executor-b',
      historical_work_record_media: true,
      work_record_actor_user_id: 'executor-a',
      completion_photo_urls: ['maintenance/executor-a-proof.jpg'],
    }],
    'an immutable A event photo remains discoverable after the live source row has been overwritten by B',
  )

  const guestLuggageRow = { id: 'guest-luggage-1', property_id: 'property-1', task_date: '2026-08-12' }
  assert.equal(
    await canViewMzappGuestLuggageNoticeMedia({ sub: 'manager-1', role: 'offline_manager', roles: ['offline_manager'] }, guestLuggageRow, 'manager-1'),
    true,
    'offline managers can read an exact recorded same-day temporary-notice photo',
  )
  assert.equal(
    await canViewMzappGuestLuggageNoticeMedia({}, guestLuggageRow, ''),
    false,
    'unauthenticated callers cannot read temporary-notice photos',
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
  const historicalWorkRecordMedia = {
    work_task_id: 'property_maintenance:record-1',
    work_record_actor_user_id: 'executor-a',
  }
  assert.equal(
    canViewMzappHistoricalWorkRecordMedia({ sub: 'executor-a', role: 'maintenance_staff', roles: ['maintenance_staff'] }, historicalWorkRecordMedia, 'executor-a', 'property_maintenance:record-1'),
    true,
    'the evidence actor can read immutable media from their own historical work record',
  )
  assert.equal(
    canViewMzappHistoricalWorkRecordMedia({ sub: 'executor-b', role: 'maintenance_staff', roles: ['maintenance_staff'] }, historicalWorkRecordMedia, 'executor-b', 'property_maintenance:record-1'),
    false,
    'the current replacement assignee cannot inherit a prior actor historical media grant',
  )
  assert.equal(
    canViewMzappHistoricalWorkRecordMedia({ sub: 'outsider-1', role: 'cleaner', roles: ['cleaner'] }, historicalWorkRecordMedia, 'outsider-1', 'property_maintenance:record-1'),
    false,
    'an unrelated authenticated user cannot read newly discoverable historical event media',
  )
  for (const role of ['admin', 'offline_manager', 'customer_service']) {
    assert.equal(
      canViewMzappHistoricalWorkRecordMedia({ sub: `${role}-1`, role, roles: [role] }, historicalWorkRecordMedia, `${role}-1`, 'property_maintenance:record-1'),
      true,
      `${role} retains the established manager work-record media scope`,
    )
  }
  assert.equal(
    canViewMzappHistoricalWorkRecordMedia({ sub: 'executor-a', role: 'maintenance_staff', roles: ['maintenance_staff'] }, historicalWorkRecordMedia, 'executor-a', 'property_maintenance:wrong-record'),
    false,
    'historical media authorization requires the exact canonical work-task id',
  )
  assert.deepEqual(
    propertyFeedbackCapabilities({ sub: 'creator-1', role: 'cleaner', roles: ['cleaner'] }, 'daily_necessities', { created_by_user_id: 'creator-1' }),
    { can_edit_content: true, can_edit_completion_content: false, can_correct_completion: false, can_delete: true, can_move_category: false },
    'the true submitter can only edit/delete their own non-workflow feedback record',
  )
  assert.deepEqual(
    propertyFeedbackCapabilities({ sub: 'other-1', role: 'cleaner', roles: ['cleaner'] }, 'daily_necessities', { created_by_user_id: 'creator-1' }),
    { can_edit_content: false, can_edit_completion_content: false, can_correct_completion: false, can_delete: false, can_move_category: false },
    'a non-owner cannot mutate another user feedback record',
  )
  assert.deepEqual(
    propertyFeedbackCapabilities({ sub: 'manager-1', role: 'offline_manager', roles: ['offline_manager'] }, 'deep_cleaning', { created_by_user_id: null }),
    { can_edit_content: true, can_edit_completion_content: false, can_correct_completion: false, can_delete: true, can_move_category: true },
    'offline managers can manage legacy records but legacy rows remain ordinary-user read-only',
  )
  assert.deepEqual(
    propertyFeedbackCapabilities({ sub: 'creator-1', role: 'cleaner', roles: ['cleaner'] }, 'maintenance', { created_by_user_id: 'creator-1', status: 'in_progress' }),
    { can_edit_content: true, can_edit_completion_content: false, can_correct_completion: false, can_delete: false, can_move_category: false },
    'a submitter can edit their report but does not inherit completion-evidence permission',
  )
  assert.deepEqual(
    propertyFeedbackCapabilities({ sub: 'customer-service-1', role: 'customer_service', roles: ['customer_service'] }, 'maintenance', { created_by_user_id: 'creator-1', status: 'pending_review' }),
    { can_edit_content: false, can_edit_completion_content: false, can_correct_completion: false, can_delete: true, can_move_category: false },
    'customer service managers can directly soft-delete a maintenance record without reopening its workflow',
  )
  assert.deepEqual(
    propertyFeedbackCapabilities({ sub: 'executor-1', role: 'maintenance_staff', roles: ['maintenance_staff'] }, 'maintenance', { created_by_user_id: 'creator-1', assignee_id: 'executor-1', status: 'assigned' }),
    { can_edit_content: false, can_edit_completion_content: true, can_correct_completion: false, can_delete: false, can_move_category: false },
    'the real assigned executor can supplement completion evidence without becoming the report editor',
  )
  assert.deepEqual(
    propertyFeedbackCapabilities({ sub: 'other-1', role: 'maintenance_staff', roles: ['maintenance_staff'] }, 'maintenance', { created_by_user_id: 'creator-1', assignee_id: 'executor-1', status: 'assigned' }),
    { can_edit_content: false, can_edit_completion_content: false, can_correct_completion: false, can_delete: false, can_move_category: false },
    'an unassigned user cannot edit either the report or its completion evidence',
  )
  assert.deepEqual(
    propertyFeedbackCapabilities({ sub: 'manager-1', role: 'maintenance_manager', roles: ['maintenance_manager'] }, 'maintenance', { created_by_user_id: 'creator-1', assignee_id: 'executor-1', status: 'pending_review' }, { canManageMaintenanceWorkflow: true }),
    { can_edit_content: false, can_edit_completion_content: true, can_correct_completion: false, can_delete: false, can_move_category: false },
    'a maintenance workflow manager can supplement pending-review evidence through the dedicated capability',
  )
  assert.deepEqual(
    propertyFeedbackCapabilities({ sub: 'admin-1', role: 'admin', roles: ['admin'] }, 'maintenance', { created_by_user_id: 'creator-1', assignee_id: 'executor-1', status: 'closed', review_status: 'approved' }),
    { can_edit_content: false, can_edit_completion_content: false, can_correct_completion: true, can_delete: true, can_move_category: false },
    'an admin corrects closed completion evidence only through the audited correction capability',
  )
  assert.deepEqual(
    propertyFeedbackCapabilities({ sub: 'executor-1', role: 'maintenance_staff', roles: ['maintenance_staff'] }, 'maintenance', { created_by_user_id: 'creator-1', assignee_id: 'executor-1', status: 'closed', review_status: 'approved' }),
    { can_edit_content: false, can_edit_completion_content: false, can_correct_completion: false, can_delete: false, can_move_category: false },
    'an assigned executor cannot correct a closed maintenance record',
  )
  assert.deepEqual(
    propertyFeedbackCapabilities({ sub: 'manager-1', role: 'offline_manager', roles: ['offline_manager'] }, 'maintenance', { created_by_user_id: 'creator-1', assignee_id: 'executor-1', status: 'cancelled' }),
    { can_edit_content: true, can_edit_completion_content: false, can_correct_completion: false, can_delete: false, can_move_category: false },
    'cancelled maintenance never exposes completion-evidence mutation',
  )
  assert.deepEqual(
    feedbackMediaUrlArray(['cleaning/feedback-a.jpg', 'cleaning/feedback-b.jpg']),
    ['cleaning/feedback-a.jpg', 'cleaning/feedback-b.jpg'],
    'PostgreSQL text[] media values must stay as individual references for feedback authorization',
  )
  assert.equal(
    feedbackMediaRowReferencesKey({
      before_photo_urls: ['inventory/daily-before.jpg'],
      after_photo_urls: ['inventory/daily-after.jpg'],
    }, 'inventory/daily-after.jpg'),
    true,
    'a daily-replacement after photo must exact-match its recorded source row',
  )
  assert.equal(
    feedbackMediaRowReferencesKey({
      before_photo_urls: ['inventory/daily-before.jpg'],
      after_photo_urls: ['inventory/daily-after.jpg'],
    }, 'inventory/unrelated.jpg'),
    false,
    'an unrecorded inventory key must not become readable through a daily-replacement row',
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
  assert.match(mediaRoute, /canViewMzappOfflineWorkTaskMedia/, 'offline task media must use the dedicated task visibility rule')
  assert.match(mediaRoute, /guest_luggage_id/, 'temporary-notice media must require its notice context')
  assert.match(mediaRoute, /guest_luggage_notices/, 'temporary-notice media must resolve its saved notice record before reading R2')
  assert.match(mediaRoute, /canViewMzappGuestLuggageNoticeMedia/, 'temporary-notice media must re-check the current authenticated user')
  assert.match(mediaRoute, /hasGuestLuggageSourceConflict/, 'temporary-notice media must fail closed on a cross-source collision')
  assert.match(mediaRouteSource, /offlineTaskPhotoReferenceVariants/, 'current-public-base historical offline URLs must remain inside the dedicated offline authorization branch')
  assert.doesNotMatch(mediaRoute, /requireAnyPerm/, 'feedback image reading must not require a task execution permission')
  assert.match(mediaRouteSource, /JOIN properties p ON p\.id::text = m\.property_id::text/, 'feedback media must resolve maintenance media through its real property')
  assert.match(mediaRouteSource, /m\.deleted_at IS NULL/, 'soft-deleted feedback must not resolve normal media URLs')
  assert.match(mediaRouteSource, /to_jsonb\(m\.photo_urls\) AS photo_urls/, 'maintenance text[] media must be normalized to a JSON array before exact reference matching')
  assert.match(mediaRouteSource, /to_jsonb\(m\.completion_photo_urls\) AS completion_photo_urls/, 'executor completion photos must be eligible for exact feedback-media authorization')
  assert.match(mediaRouteSource, /m\.completion_photo_urls::text/, 'completion photo candidate lookup must include the canonical executor field')
  assert.match(mediaRouteSource, /feedbackMediaUrlArray\(row\?\.completion_photo_urls\)/, 'completion photo references must be exact-matched after candidate lookup')
  assert.match(mediaRouteSource, /FROM work_task_events event[\s\S]*?event\.event_type = 'TASK_COMPLETED'/, 'historical feedback media must remain discoverable from immutable completion events')
  assert.match(mediaRouteSource, /true AS historical_work_record_media[\s\S]*?execution_evidence,is_execution[\s\S]*?work_record_actor_user_id/, 'historical event media must carry explicit actor-bound provenance')
  assert.match(mediaRoute, /historical_work_record_media === true[\s\S]*?canViewMzappHistoricalWorkRecordMedia/, 'historical event media must use actor-or-manager authorization instead of broad property feedback visibility')
  assert.match(mediaRoute, /findPropertyFeedbackMediaRows\(pgPool, key, workTaskId\)/, 'historical feedback media lookup must use the canonical work-task context')
  assert.match(mediaRouteSource, /key\.startsWith\('maintenance\/'\)/, 'legacy web maintenance object keys must use the authenticated feedback-media proxy')
  assert.match(mediaRouteSource, /to_jsonb\(d\.photo_urls\) AS photo_urls/, 'deep-cleaning legacy media must be normalized before exact reference matching')
  assert.match(mediaRouteSource, /to_jsonb\(d\.repair_photo_urls\) AS repair_photo_urls/, 'deep-cleaning repair photos must remain exact-match candidates')
  assert.match(mediaRouteSource, /to_jsonb\(d\.attachment_urls\) AS attachment_urls/, 'deep-cleaning attachments must remain exact-match candidates')
  assert.match(mediaRouteSource, /to_jsonb\(d\.project_items\) AS project_items/, 'deep-cleaning project before/after photos must remain exact-match candidates')
  assert.match(mediaRouteSource, /key\.startsWith\('deep-cleaning\/'\)/, 'historical deep-cleaning keys must enter the authenticated feedback-media branch')
  assert.match(mediaRouteSource, /key\.startsWith\('deep-cleaning-upload\/'\)/, 'historical deep-cleaning upload keys must enter the authenticated feedback-media branch')
  assert.match(mediaRouteSource, /key\.startsWith\('inventory\/'\)/, 'daily-replacement inventory keys must use the authenticated feedback-media proxy')
  assert.match(mediaRouteSource, /to_jsonb\(n\.before_photo_urls\) AS before_photo_urls/, 'daily-replacement before photos must be eligible for exact feedback-media authorization')
  assert.match(mediaRouteSource, /to_jsonb\(n\.after_photo_urls\) AS after_photo_urls/, 'daily-replacement after photos must be eligible for exact feedback-media authorization')
  assert.match(mediaRouteSource, /n\.after_photo_urls::text/, 'daily-replacement after photos must participate in candidate lookup before the proxy reads R2')

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
