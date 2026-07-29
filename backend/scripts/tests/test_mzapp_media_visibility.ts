import assert from 'assert'

process.env.DATABASE_URL = ''

async function main() {
  const { canViewMzappInspectionMedia, canViewMzappLockboxVideo, canViewMzappRecordedCleaningMedia } = await import('../../src/modules/mzapp')

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
