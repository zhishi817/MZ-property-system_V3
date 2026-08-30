import assert from 'node:assert/strict'
import fs from 'node:fs'

const { loadGuestLuggageNoticesForWorkTasks } = require('../../src/modules/mzapp')

const notices = [
  {
    id: 'notice-a',
    property_id: 'property-a',
    task_date: '2026-09-01',
    note: '门边行李',
    photo_urls: ['mzapp/notice-a.jpg'],
    version: 3,
    created_by: 'manager-1',
    updated_by: 'manager-2',
    created_at: '2026-08-30T00:00:00.000Z',
    updated_at: '2026-08-30T01:00:00.000Z',
  },
  {
    id: 'notice-b',
    property_id: 'property-b',
    task_date: '2026-09-02',
    note: null,
    photo_urls: [],
    version: 1,
    created_by: null,
    updated_by: null,
    created_at: null,
    updated_at: null,
  },
]

async function main() {
  const calls: Array<{ sql: string; params: any[] }> = []
  const client = {
    async query(sql: string, params: any[]) {
      calls.push({ sql, params })
      return {
        rows: [
          {
            notice_id: 'notice-a',
            role_kind: 'cleaner',
            user_id: 'cleaner-1',
            user_name: 'Cleaner One',
            acknowledged_at: '2026-08-30T02:00:00.000Z',
          },
          {
            notice_id: 'notice-a',
            role_kind: 'inspector',
            user_id: 'inspector-1',
            user_name: 'Inspector One',
            acknowledged_at: null,
          },
          {
            notice_id: 'notice-b',
            role_kind: 'cleaner',
            user_id: 'cleaner-2',
            user_name: 'Cleaner Two',
            acknowledged_at: null,
          },
        ],
      }
    },
  }

  assert.deepEqual(await loadGuestLuggageNoticesForWorkTasks([], 'cleaner-1', client), [])
  assert.equal(calls.length, 0, 'an empty task list must not query guest luggage authorizations')

  const details = await loadGuestLuggageNoticesForWorkTasks(notices, 'cleaner-1', client)
  assert.equal(calls.length, 1, 'all notices in one work-task response must use one authorization query')
  assert.deepEqual(calls[0].params, [
    ['notice-a', 'notice-b'],
    ['property-a', 'property-b'],
    ['2026-09-01', '2026-09-02'],
    [3, 1],
  ])
  assert.match(calls[0].sql, /WITH notices AS/, 'batch query must bind the requested notice set')
  assert.match(calls[0].sql, /unnest\(\$1::text\[\], \$2::text\[\], \$3::date\[\], \$4::integer\[\]\)/, 'batch query must preserve each notice property, date and version')
  assert.match(calls[0].sql, /COALESCE\(t\.cleaner_id::text, t\.assignee_id::text\)/, 'cleaner fallback must retain existing assignee semantics')
  assert.match(calls[0].sql, /'inspector'::text AS role_kind/, 'inspector authorization must remain independent from cleaner authorization')
  assert.match(calls[0].sql, /ack\.notice_version = n\.notice_version/, 'acknowledgements must remain version-scoped')

  assert.deepEqual(details, [
    {
      id: 'notice-a',
      property_id: 'property-a',
      task_date: '2026-09-01',
      note: '门边行李',
      photo_urls: ['mzapp/notice-a.jpg'],
      version: 3,
      created_by: 'manager-1',
      updated_by: 'manager-2',
      created_at: '2026-08-30T00:00:00.000Z',
      updated_at: '2026-08-30T01:00:00.000Z',
      current_user_acknowledged: true,
      acknowledgements: {
        cleaners: [{ user_id: 'cleaner-1', user_name: 'Cleaner One', acknowledged: true, acknowledged_at: '2026-08-30T02:00:00.000Z' }],
        inspectors: [{ user_id: 'inspector-1', user_name: 'Inspector One', acknowledged: false, acknowledged_at: null }],
      },
    },
    {
      id: 'notice-b',
      property_id: 'property-b',
      task_date: '2026-09-02',
      note: null,
      photo_urls: [],
      version: 1,
      created_by: null,
      updated_by: null,
      created_at: null,
      updated_at: null,
      current_user_acknowledged: false,
      acknowledgements: {
        cleaners: [{ user_id: 'cleaner-2', user_name: 'Cleaner Two', acknowledged: false, acknowledged_at: null }],
        inspectors: [],
      },
    },
  ])

  const source = fs.readFileSync(require.resolve('../../src/modules/mzapp'), 'utf8')
  const batchLoaderStart = source.indexOf('export async function loadGuestLuggageNoticesForWorkTasks')
  const batchLoaderEnd = source.indexOf('async function listGuestLuggageRecipients', batchLoaderStart)
  assert.ok(batchLoaderStart >= 0 && batchLoaderEnd > batchLoaderStart, 'batch loader must remain a distinct work-tasks helper')
  const batchLoaderSource = source.slice(batchLoaderStart, batchLoaderEnd)
  assert.match(batchLoaderSource, /AND \$\{activeCleaningTaskWhereSql\('t'\)\}/, 'batch authorization must still exclude inactive, superseded and cancelled cleaning tasks')
  const workTasksStart = source.indexOf("router.get('/work-tasks'")
  const workTasksEnd = source.indexOf('const restockByTaskId', workTasksStart)
  assert.ok(workTasksStart >= 0 && workTasksEnd > workTasksStart, 'work-tasks guest-luggage assembly must remain discoverable')
  const workTasksGuestLuggageBlock = source.slice(workTasksStart, workTasksEnd)
  assert.match(workTasksGuestLuggageBlock, /loadGuestLuggageNoticesForWorkTasks\(luggageRows\?\.rows \|\| \[\], userId\)/, 'work-tasks must use the batch loader')
  assert.doesNotMatch(workTasksGuestLuggageBlock, /Promise\.all\([\s\S]{0,400}loadGuestLuggageNotice\(/, 'work-tasks must not issue one detail query per notice')

  console.log('guest luggage work-tasks batch contract passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
