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
    ]
    memoryDb.properties = [
      { id: 'turnover-property', code: 'TURNOVER', region: 'TEST' },
      { id: 'unassigned-property', code: 'UNASSIGNED', region: 'TEST' },
    ]
    memoryDb.orders = []
    memoryDb.workTasks = []
    memoryDb.cleaningOfflineTasks = []

    const day = await buildTaskCenterDay('2026-10-10', false, true, false, true)
    const boardTasks = day.rows.flatMap((row: any) => row.subrows.flatMap((subrow: any) => subrow.tasks))
    const turnoverTasks = boardTasks.filter((task: any) => task.property_id === 'turnover-property')

    assert.ok(turnoverTasks.length > 0, 'unassigned turnover tasks remain executable')
    assert.equal(turnoverTasks.every((task: any) => task.source_type === 'cleaning_tasks'), true)
    assert.equal(turnoverTasks.every((task: any) => task.execution_list_visible === true), true)
    assert.equal(turnoverTasks.every((task: any) => task.daily_stats_group === 'turnover'), true)
    assert.deepEqual(
      Array.from(new Set(turnoverTasks.map((task: any) => task.daily_stats_key))),
      ['turnover:2026-10-10:turnover-property'],
      'checkout and checkin share one property/date turnover count',
    )
    assert.equal(
      boardTasks.some((task: any) => task.property_id === 'unassigned-property'),
      false,
      'non-turnover cleaning without an executor is filtered from the Web execution board',
    )
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
