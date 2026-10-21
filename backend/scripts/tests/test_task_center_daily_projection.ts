import assert from 'assert'

async function main() {
  process.env.DATABASE_URL = ''
  const [{ buildTaskCenterDay }, { db }] = await Promise.all([
    import('../../src/modules/task_center'),
    import('../../src/store'),
  ])
  const memoryDb = db as any
  const original = {
    cleaningTasks: memoryDb.cleaningTasks,
    properties: memoryDb.properties,
    orders: memoryDb.orders,
    workTasks: memoryDb.workTasks,
    cleaningOfflineTasks: memoryDb.cleaningOfflineTasks,
    propertyMaintenance: memoryDb.propertyMaintenance,
    propertyDeepCleaning: memoryDb.propertyDeepCleaning,
    propertyDailyNecessities: memoryDb.propertyDailyNecessities,
  }

  try {
    memoryDb.cleaningTasks = [
      {
        id: 'turnover-checkout',
        property_id: 'turnover-property',
        task_type: 'checkout_clean',
        task_date: '2026-10-10',
        status: 'assigned',
      },
      {
        id: 'turnover-checkin',
        property_id: 'turnover-property',
        task_type: 'checkin_clean',
        task_date: '2026-10-10',
        status: 'assigned',
      },
      {
        id: 'unassigned-non-turnover',
        property_id: 'unassigned-property',
        task_type: 'stayover_clean',
        task_date: '2026-10-10',
        status: 'assigned',
      },
      ...['maintenance-property', 'deep-property', 'deep-stale-property', 'daily-property', 'hidden-property'].map((propertyId) => ({
        id: `checkout-${propertyId}`,
        property_id: propertyId,
        task_type: 'checkout_clean',
        task_date: '2026-10-10',
        status: 'assigned',
      })),
    ]
    memoryDb.properties = [
      { id: 'turnover-property', code: 'TURNOVER', region: 'TEST' },
      { id: 'unassigned-property', code: 'UNASSIGNED', region: 'TEST' },
      { id: 'maintenance-property', code: 'MAINT', region: 'TEST' },
      { id: 'deep-property', code: 'DEEP', region: 'TEST' },
      { id: 'deep-stale-property', code: 'WSP380909', region: 'TEST' },
      { id: 'daily-property', code: 'DAILY', region: 'TEST' },
      { id: 'hidden-property', code: 'HIDDEN', region: 'TEST' },
    ]
    memoryDb.orders = []
    memoryDb.workTasks = [
      {
        id: 'ordinary-offline-completed',
        source_type: 'manual_work_task',
        source_id: 'ordinary-offline-completed',
        task_kind: 'offline',
        scheduled_date: '2026-10-10',
        assignee_id: 'worker-1',
        status: 'done',
        title: '普通线下已完成任务',
      },
      {
        id: 'property_deep_cleaning:deep-active',
        source_type: 'property_deep_cleaning',
        source_id: 'deep-active',
        task_kind: 'deep_cleaning',
        scheduled_date: '2026-10-10',
        assignee_id: 'deep-cleaner-saved-by-task-center',
        status: 'assigned',
        title: 'D-ACTIVE',
      },
      {
        id: 'property_maintenance:maintenance-active',
        source_type: 'property_maintenance',
        source_id: 'maintenance-active',
        task_kind: 'maintenance',
        scheduled_date: '2026-06-24',
        assignee_id: null,
        status: 'assigned',
        title: 'STALE-MAINTENANCE-PROJECTION',
      },
      {
        id: 'property_deep_cleaning:deep-stale',
        source_type: 'property_deep_cleaning',
        source_id: 'deep-stale',
        task_kind: 'deep_cleaning',
        scheduled_date: '2026-06-24',
        assignee_id: null,
        status: 'assigned',
        title: 'STALE-DEEP-PROJECTION',
      },
    ]
    memoryDb.cleaningOfflineTasks = []
    memoryDb.propertyMaintenance = [
      { id: 'maintenance-active', property_id: 'maintenance-property', status: 'pending', work_no: 'M-ACTIVE', details: '待安排维修' },
      { id: 'maintenance-review', property_id: 'hidden-property', status: 'awaiting_review', work_no: 'M-REVIEW' },
    ]
    memoryDb.propertyDeepCleaning = [
      { id: 'deep-active', property_id: 'deep-property', status: 'pending', work_no: 'D-ACTIVE', project_desc: '待安排深清' },
      { id: 'deep-stale', property_id: 'deep-stale-property', status: 'pending', work_no: 'D-380909', project_desc: '按新退房日重新投影' },
      { id: 'deep-completed', property_id: 'hidden-property', status: 'completed', work_no: 'D-DONE' },
      { id: 'deep-review', property_id: 'hidden-property', status: 'pending', review_status: 'pending_review', work_no: 'D-REVIEW' },
      { id: 'deep-deleted', property_id: 'hidden-property', status: 'pending', deleted_at: '2026-10-11T00:00:00Z', work_no: 'D-DELETED' },
      { id: 'deep-deleted-wsp3710b-2', property_id: 'hidden-property', status: 'pending', deleted_at: '2026-10-11T00:00:00Z', work_no: 'WSP3710B-DELETED-2' },
    ]
    memoryDb.propertyDailyNecessities = [
      { id: 'daily-active', property_id: 'daily-property', status: 'need_replace', item_name: '补纸巾', quantity: 2 },
      { id: 'daily-closed', property_id: 'hidden-property', status: 'replaced', item_name: '已补齐' },
    ]

    const day = await buildTaskCenterDay('2026-10-10', false, true, false, true)
    const boardTasks = day.rows.flatMap((row: any) => row.subrows.flatMap((subrow: any) => subrow.tasks))
    const turnoverTasks = boardTasks.filter((task: any) => task.property_id === 'turnover-property')

    assert.ok(turnoverTasks.length > 0, 'unassigned turnover tasks remain executable')
    assert.equal(turnoverTasks.every((task: any) => task.source_type === 'cleaning_tasks'), true)
    assert.equal(turnoverTasks.every((task: any) => task.execution_list_visible === true), true)
    assert.equal(turnoverTasks.every((task: any) => task.daily_stats_group === 'turnover'), true)
    assert.deepEqual(
      Array.from(new Set(turnoverTasks.map((task: any) => task.daily_stats_key))),
      ['turnover:2026-10-10:cleaning_task:turnover-checkin'],
      'the merged checkout/checkin card uses its stable cleaning source identity instead of property/date',
    )
    assert.equal(
      boardTasks.some((task: any) => task.property_id === 'unassigned-property'),
      false,
      'non-turnover cleaning without an executor is filtered from the Web execution board',
    )
    assert.equal(
      boardTasks.some((task: any) => task.task_id === 'ordinary-offline-completed'),
      true,
      'MZ-021 ordinary completed offline tasks remain visible',
    )
    assert.deepEqual(
      day.property_followups.map((task: any) => task.task_id).sort(),
      [
        'property_daily_necessities:daily-active',
        'property_deep_cleaning:deep-active',
        'property_deep_cleaning:deep-stale',
        'property_maintenance:maintenance-active',
      ],
      'active date-matched unassigned property candidates remain visible to Web scheduling',
    )
    const deepCandidate = day.property_followups.find((task: any) => task.task_id === 'property_deep_cleaning:deep-active')
    assert.equal(deepCandidate?.assignee_id, 'deep-cleaner-saved-by-task-center')
    assert.equal(deepCandidate?.status, 'assigned', 'saved deep-cleaning assignment survives refresh projection')
    assert.equal(
      day.property_followups.filter((task: any) => task !== deepCandidate).every((task: any) => task.assignee_id == null),
      true,
    )
    assert.equal(deepCandidate?.execution_list_visible, true, 'assigned deep-cleaning remains visible to execution clients')
    const maintenanceCandidate = day.property_followups.find((task: any) => task.task_id === 'property_maintenance:maintenance-active')
    assert.equal(maintenanceCandidate?.scheduled_date, '2026-10-10')
    assert.equal(maintenanceCandidate?.status, 'todo', 'stale work status cannot override the maintenance source workflow')
    const staleDeepCandidate = day.property_followups.find((task: any) => task.task_id === 'property_deep_cleaning:deep-stale')
    assert.equal(staleDeepCandidate?.scheduled_date, '2026-10-10', 'selected-day checkout replaces an unassigned stale work date')
    assert.equal(staleDeepCandidate?.status, 'todo', 'stale assigned work status cannot survive without an authoritative assignee')
    assert.equal(
      day.property_followups.some((task: any) => String(task.task_id).includes('deep-deleted')),
      false,
      'soft-deleted deep-cleaning sources do not flow back into the pure-read projection',
    )
    assert.equal(
      day.property_followups.filter((task: any) => task !== deepCandidate).every((task: any) => task.execution_list_visible === false),
      true,
      'unassigned candidates remain management-only',
    )
    const viewOnlyDay = await buildTaskCenterDay('2026-10-10', false, true, false, false)
    assert.deepEqual(viewOnlyDay.property_followups, [], 'view-only users cannot read management-only property candidates')
    const layoutOnlyDay = await buildTaskCenterDay('2026-10-10', false, true, false, true, false, false)
    assert.deepEqual(
      layoutOnlyDay.property_followups,
      [],
      'schedule.manage-only users cannot receive assignable candidates that save-board would reject',
    )

    memoryDb.cleaningTasks = []
    memoryDb.properties = []
    memoryDb.propertyMaintenance = []
    memoryDb.propertyDeepCleaning = []
    memoryDb.propertyDailyNecessities = []
    memoryDb.workTasks = [
      ...Array.from({ length: 10 }, (_, index) => ({
        id: `offline-2026-10-12-${index + 1}`,
        source_type: 'work_tasks',
        source_id: `offline-2026-10-12-${index + 1}`,
        task_kind: 'offline',
        scheduled_date: '2026-10-12',
        assignee_id: index < 3 ? `worker-${index + 1}` : null,
        status: index < 3 ? 'assigned' : 'todo',
        title: `10/12 线下任务 ${index + 1}`,
      })),
      ...Array.from({ length: 8 }, (_, index) => ({
        id: `offline-2026-10-13-${index + 1}`,
        source_type: 'work_tasks',
        source_id: `offline-2026-10-13-${index + 1}`,
        task_kind: 'offline',
        scheduled_date: '2026-10-13',
        assignee_id: null,
        status: 'todo',
        title: `10/13 线下任务 ${index + 1}`,
      })),
    ]
    const offlineDay12 = await buildTaskCenterDay('2026-10-12', false, false, false, true)
    const offlineTasks12 = offlineDay12.rows.flatMap((row: any) => row.subrows.flatMap((subrow: any) => subrow.tasks))
    assert.equal(offlineTasks12.length, 10, 'Web management lists all ten native offline tasks on 10/12')
    assert.equal(offlineTasks12.filter((task: any) => task.execution_list_visible).length, 3, 'only three assigned 10/12 tasks remain Mobile-executable')
    assert.equal(offlineTasks12.filter((task: any) => task.daily_stats_group === 'offline').length, 10, 'Web offline count includes seven management-only tasks')
    assert.equal(offlineTasks12.filter((task: any) => !task.assignee_id).every((task: any) => task.management_actions?.some((action: any) => action.id === 'assign_executor' && action.enabled)), true, 'all seven unassigned 10/12 tasks are assignable in Web management')
    const offlineDay13 = await buildTaskCenterDay('2026-10-13', false, false, false, true)
    const offlineTasks13 = offlineDay13.rows.flatMap((row: any) => row.subrows.flatMap((subrow: any) => subrow.tasks))
    assert.equal(offlineTasks13.length, 8, 'Web management lists all eight native offline tasks on 10/13')
    assert.equal(offlineTasks13.filter((task: any) => task.execution_list_visible).length, 0, 'unassigned 10/13 tasks remain absent from Mobile execution')
    assert.equal(offlineTasks13.filter((task: any) => task.daily_stats_group === 'offline').length, 8, 'Web offline count is eight on 10/13')
    assert.equal(offlineTasks13.every((task: any) => task.management_actions?.some((action: any) => action.id === 'assign_executor' && action.enabled)), true, 'all eight unassigned 10/13 tasks are assignable in Web management')
  } finally {
    Object.assign(memoryDb, original)
  }
}

main()
  .then(() => process.stdout.write('test_task_center_daily_projection: ok\n'))
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
