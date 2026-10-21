import assert from 'assert'
import fs from 'fs'
import path from 'path'

process.env.DATABASE_URL = ''

async function main() {
  const {
    canViewFormPhotoTaskRows,
    canonicalFormPhotoTurnover,
    formPhotoMediaType,
    formPhotoRecordVisibleToScope,
    workRecordReadOnlyViews,
    workRecordProjectionExecutionState,
  } = await import('../../src/modules/mzapp')
  const rows = [{
    id: 'form-photo-task-1',
    task_date: '2026-07-24',
    property_id: 'property-1',
    property_code: 'RM-1001',
    task_type: 'checkout_clean',
    status: 'done',
    execution_state: 'active',
    order_id: 'order-1',
    order_checkin: '2026-07-20',
    order_checkout: '2026-07-24',
    inspector_id: 'inspector-1',
    cleaner_id: 'cleaner-1',
    assignee_id: 'executor-1',
  }]

  assert.equal(await canViewFormPhotoTaskRows({ role: 'cleaner' }, rows, 'cleaner-1'), true)
  assert.equal(await canViewFormPhotoTaskRows({ role: 'cleaning_inspector' }, rows, 'inspector-1'), true)
  assert.equal(await canViewFormPhotoTaskRows({ role: 'cleaner' }, rows, 'outsider-1'), false)
  assert.equal(await canViewFormPhotoTaskRows({ role: 'admin' }, rows, 'admin-1'), true)
  assert.deepEqual(formPhotoMediaType('inspection_living'), { source: 'inspection', area: 'living' })
  assert.deepEqual(formPhotoMediaType('inspection_balcony'), { source: 'inspection', area: 'balcony' })
  assert.equal(formPhotoMediaType('inspection_consumables_confirmed'), null)
  assert.deepEqual(formPhotoMediaType('restock_proof:coffee'), { source: 'restock', item_id: 'coffee' })
  assert.deepEqual(formPhotoMediaType('completion_bedroom'), { source: 'completion', area: 'bedroom' })
  assert.deepEqual(formPhotoMediaType('key_photo'), { source: 'key', area: 'guest_key', label: '客人钥匙照片' })
  assert.deepEqual(formPhotoMediaType('consumable_item_photo:coffee'), { source: 'consumable', area: 'consumable', item_id: 'coffee' })

  const cleanerOwned = new Set(['form-photo-task-1'])
  assert.equal(formPhotoRecordVisibleToScope({ task_id: 'form-photo-task-1', source: 'completion', uploader_id: 'cleaner-1' }, 'cleaner', 'cleaner-1', cleanerOwned), true)
  assert.equal(formPhotoRecordVisibleToScope({ task_id: 'form-photo-task-1', source: 'completion', uploader_id: null }, 'cleaner', 'cleaner-1', cleanerOwned), false)
  assert.equal(formPhotoRecordVisibleToScope({ task_id: 'form-photo-task-1', source: 'inspection', uploader_id: 'inspector-1' }, 'cleaner', 'cleaner-1', cleanerOwned), false)
  assert.equal(formPhotoRecordVisibleToScope({ task_id: 'form-photo-task-1', source: 'key', uploader_id: 'cleaner-1' }, 'inspector', 'inspector-1', new Set(['form-photo-task-1'])), true)
  assert.equal(formPhotoRecordVisibleToScope({ task_id: 'unrelated', source: 'inspection', uploader_id: 'inspector-1' }, 'inspector', 'inspector-1', new Set(['form-photo-task-1'])), false)
  assert.equal(canonicalFormPhotoTurnover([
    {
      ...rows[0],
      id: 'checkout-task',
      task_type: 'checkout_clean',
      order_id: 'checkout-order',
      order_checkin: '2026-07-20',
      order_checkout: '2026-07-24',
    },
    {
      ...rows[0],
      id: 'checkin-task',
      task_type: 'checkin_clean',
      order_id: 'checkin-order',
      order_checkin: '2026-07-24',
      order_checkout: '2026-07-28',
    },
  ]), true)
  assert.equal(canonicalFormPhotoTurnover([
    rows[0],
    { ...rows[0], id: 'same-room-unrelated-task', order_id: 'unrelated-order' },
  ]), false)
  assert.equal(canonicalFormPhotoTurnover([
    {
      ...rows[0],
      id: 'cancelled-checkout-task',
      task_type: 'checkout_clean',
      status: 'cancelled',
      order_id: 'checkout-order',
      order_checkout: '2026-07-24',
    },
    {
      ...rows[0],
      id: 'active-checkin-task',
      task_type: 'checkin_clean',
      order_id: 'checkin-order',
      order_checkin: '2026-07-24',
    },
  ]), false)

  assert.deepEqual(workRecordReadOnlyViews({
    work_record_read_only: true,
    source_type: 'cleaning_tasks',
    execution_role: 'cleaning',
    work_record_state: 'completed',
    completed_by_user_id: 'cleaner-1',
  }, { role: 'cleaner' }, 'cleaner-1'), {
    property_access: true,
    lock_codes: true,
    cleaner_photos: true,
    inspection_photos: false,
    guest_key_photo: true,
    media_scope: 'cleaner',
  })
  assert.equal(workRecordReadOnlyViews({
    work_record_read_only: true,
    source_type: 'cleaning_tasks',
    execution_role: 'cleaning',
    work_record_state: 'completed',
    completed_by_user_id: 'cleaner-1',
  }, { role: 'cleaner' }, 'outsider-1').property_access, false)
  assert.equal(workRecordReadOnlyViews({
    work_record_read_only: true,
    source_type: 'cleaning_tasks',
    execution_role: 'inspection',
    work_record_state: 'completed',
    completed_by_user_id: 'inspector-1',
  }, { role: 'admin' }, 'admin-1').lock_codes, true)
  for (const managerRole of ['admin', 'offline_manager', 'customer_service']) {
    assert.equal(workRecordReadOnlyViews({
      work_record_read_only: true,
      source_type: 'cleaning_tasks',
      execution_role: 'inspection',
      work_record_state: 'completed',
      completed_by_user_id: 'inspector-1',
    }, { role: managerRole }, `${managerRole}-1`).lock_codes, true)
  }
  assert.equal(workRecordReadOnlyViews({
    work_record_read_only: true,
    source_type: 'cleaning_tasks',
    execution_role: 'cleaning',
    work_record_state: 'reassigned',
    status: 'assigned',
    completed_by_user_id: 'cleaner-1',
  }, { role: 'cleaner' }, 'cleaner-1').lock_codes, true)
  for (const deniedRecord of [
    { work_record_state: 'cancelled', status: 'cancelled' },
    { work_record_state: 'rescheduled', status: 'assigned' },
    { work_record_state: 'completed', execution_state: 'deleted' },
    { work_record_state: 'completed', execution_state: 'superseded' },
  ]) {
    assert.equal(workRecordReadOnlyViews({
      work_record_read_only: true,
      source_type: 'cleaning_tasks',
      execution_role: 'cleaning',
      completed_by_user_id: 'cleaner-1',
      ...deniedRecord,
    }, { role: 'admin' }, 'admin-1').lock_codes, false)
  }

  const supersededProjectionState = workRecordProjectionExecutionState([
    { __raw_id: 'active-source', execution_state: 'active' },
    { __raw_id: 'historical-source', execution_state: 'superseded' },
  ], 'active-source')
  assert.equal(supersededProjectionState, 'superseded', 'a grouped historical superseded source must remain visible to the final capability gate')
  assert.equal(workRecordReadOnlyViews({
    work_record_read_only: true,
    source_type: 'cleaning_tasks',
    execution_role: 'cleaning',
    work_record_state: 'completed',
    completed_by_user_id: 'cleaner-1',
    execution_state: supersededProjectionState,
  }, { role: 'admin' }, 'admin-1').lock_codes, false, 'SQL candidate execution state must survive projection before lock-code authorization')

  const source = fs.readFileSync(path.resolve(__dirname, '../../src/modules/mzapp.ts'), 'utf8')
  const start = source.indexOf("router.get('/work-tasks/:id/form-photos'")
  const end = source.indexOf("router.get('/cleaning-tasks/:id/inspection-photos'", start)
  assert(start >= 0 && end > start, 'form photo read route must exist')
  const routeSource = source.slice(start, end)
  assert(!/ensureCleaning(TaskMedia|ChecklistTables)|CREATE TABLE|ALTER TABLE|CREATE INDEX|INSERT INTO/i.test(routeSource), 'form photo GET must remain pure read')
  assert.match(source, /if \(\(merged \|\| turnover\) && sourceIdHints\.length\)[\s\S]*?WHERE t\.id::text = ANY\(\$1::text\[\]\)/, 'composite form-photo reads must resolve exact source ids')
  assert.doesNotMatch(source, /if \(merged\) \{[\s\S]{0,800}property_code[\s\S]{0,800}task_date/, 'form-photo reads must not relate media by property and date')

  const mediaProxySource = fs.readFileSync(path.resolve(__dirname, '../../src/modules/cleaning_app.ts'), 'utf8')
  assert.match(mediaProxySource, /const relatedSourceIds = Array\.from\(new Set[\s\S]*?\.slice\(0, 2\)\)\)/, 'media proxy must cap exact related source ids at the canonical pair')
  assert.match(mediaProxySource, /hasScopedMediaContext\s*\?\s*await canViewMzappScopedRecordedCleaningMedia[\s\S]*?:\s*await canViewMzappRecordedCleaningMedia/, 'scoped media requests must use the role-aware byte authorization path instead of broad participant authorization')
  assert.match(source, /media_source_ids:[\s\S]*?readOnlyMediaSourceIds/, 'work records must expose the exact canonical media source ids')
  assert.match(source, /old_code: readOnlyViews\.lock_codes \? cleanTask\.old_code \?\? null : null[\s\S]*?new_code: readOnlyViews\.lock_codes \? cleanTask\.new_code \?\? null : null/, 'work-record lock codes must be returned only through the explicit read-only capability')
  assert.match(source, /execution_state: row\.execution_state,[\s\S]*?const projectionExecutionState = workRecordProjectionExecutionState\(rows, primarySourceId\)[\s\S]*?execution_state: projectionExecutionState,/, 'cleaning SQL execution state must survive the single-role projection')
  assert.match(source, /const projectionExecutionState = workRecordProjectionExecutionState\(arr, preferred\?\.source_id\)[\s\S]*?execution_state: projectionExecutionState,/, 'manager merge must retain blocking execution state before read-only capability evaluation')

  for (const moduleName of ['cleaning_app', 'mzapp']) {
    const moduleSource = fs.readFileSync(path.resolve(__dirname, `../../src/modules/${moduleName}.ts`), 'utf8')
    assert.match(moduleSource, /area: z\.enum\(\[[\s\S]*?'bathroom'/, `${moduleName} inspection photo schema must accept bathroom`)
    assert.match(moduleSource, /bathroom:\s*3/, `${moduleName} inspection photo limit must be three`)
    assert.match(moduleSource, /area: z\.enum\(\[[\s\S]*?'balcony'/, `${moduleName} inspection photo schema must accept balcony`)
    assert.match(moduleSource, /balcony:\s*3/, `${moduleName} balcony inspection photo limit must be three`)
  }
  const actionAuditSource = fs.readFileSync(path.resolve(__dirname, '../../src/lib/workTaskActionAudit.ts'), 'utf8')
  assert.match(actionAuditSource, /'inspection_bathroom'/, 'inspection action photo gate must count bathroom media')
  assert.match(actionAuditSource, /'inspection_balcony'/, 'inspection action photo gate must count balcony media')
  process.stdout.write('test_mzapp_form_photo_read: ok\n')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
