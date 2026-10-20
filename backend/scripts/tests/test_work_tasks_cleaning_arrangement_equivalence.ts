import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

type ArrangementTask = {
  id: string
  propertyId: string
  taskType: string
  day: string
  status: string
  active: boolean
  validOrder: boolean
  inspectionMode: string
  inspectionScope: string
  inspectionDueDate: string | null
}

const terminalDeferredStatuses = new Set([
  'inspected',
  'done',
  'completed',
  'ready',
  'keys_hung',
  'cancelled',
  'canceled',
])

function isOpenDeferred(task: ArrangementTask) {
  return (
    ['checkout_clean', 'checkout_cleaning'].includes(task.taskType)
    && task.inspectionMode === 'deferred'
    && !!task.inspectionDueDate
    && !terminalDeferredStatuses.has(task.status)
  )
}

function oldArrangementIds(tasks: ArrangementTask[], propertyIds: Set<string>) {
  return tasks
    .filter((task) => {
      if (!propertyIds.has(task.propertyId) || !task.active || !task.validOrder) return false
      if (isOpenDeferred(task)) return true
      if (task.taskType !== 'checkin_clean' || task.inspectionScope === 'password_only') return false
      return tasks.some((deferred) => (
        deferred.active
        && deferred.validOrder
        && isOpenDeferred(deferred)
        && deferred.propertyId === task.propertyId
        && task.day >= deferred.day
        && task.day <= String(deferred.inspectionDueDate)
      ))
    })
    .map((task) => task.id)
    .sort()
}

function newArrangementIds(tasks: ArrangementTask[], propertyIds: Set<string>) {
  const normalized = tasks.filter((task) => (
    ['checkout_clean', 'checkout_cleaning', 'checkin_clean'].includes(task.taskType)
    && propertyIds.has(task.propertyId)
    && task.active
    && task.validOrder
  ))
  const deferred = normalized.filter(isOpenDeferred)
  const checkins = normalized.filter((task) => (
    task.taskType === 'checkin_clean'
    && task.inspectionScope !== 'password_only'
    && deferred.some((candidate) => (
      candidate.propertyId === task.propertyId
      && task.day >= candidate.day
      && task.day <= String(candidate.inspectionDueDate)
    ))
  ))
  return [...deferred, ...checkins].map((task) => task.id).sort()
}

const task = (id: string, overrides: Partial<ArrangementTask> = {}): ArrangementTask => ({
  id,
  propertyId: 'property-a',
  taskType: 'checkin_clean',
  day: '2026-10-20',
  status: 'assigned',
  active: true,
  validOrder: true,
  inspectionMode: '',
  inspectionScope: 'inspect_and_hang',
  inspectionDueDate: null,
  ...overrides,
})

const namedCases: ArrangementTask[][] = [
  [],
  [task('deferred', { taskType: 'checkout_clean', inspectionMode: 'deferred', inspectionDueDate: '2026-10-22' })],
  [
    task('deferred', { taskType: 'checkout_cleaning', inspectionMode: 'deferred', inspectionDueDate: '2026-10-22' }),
    task('matching-checkin'),
    task('password-only', { inspectionScope: 'password_only' }),
    task('outside-window', { day: '2026-10-23' }),
  ],
  [
    task('terminal-deferred', { taskType: 'checkout_clean', inspectionMode: 'deferred', inspectionDueDate: '2026-10-22', status: 'inspected' }),
    task('no-longer-matching-checkin'),
  ],
  [
    task('inactive-deferred', { taskType: 'checkout_clean', inspectionMode: 'deferred', inspectionDueDate: '2026-10-22', active: false }),
    task('invalid-order-deferred', { taskType: 'checkout_clean', inspectionMode: 'deferred', inspectionDueDate: '2026-10-22', validOrder: false }),
    task('other-property-deferred', { propertyId: 'property-b', taskType: 'checkout_clean', inspectionMode: 'deferred', inspectionDueDate: '2026-10-22' }),
    task('candidate-checkin'),
  ],
  [
    task('deferred-a', { taskType: 'checkout_clean', inspectionMode: 'deferred', inspectionDueDate: '2026-10-22' }),
    task('deferred-b', { taskType: 'checkout_clean', inspectionMode: 'deferred', inspectionDueDate: '2026-10-21' }),
    task('one-checkin-row'),
  ],
]

for (const [index, tasks] of namedCases.entries()) {
  assert.deepEqual(
    newArrangementIds(tasks, new Set(['property-a'])),
    oldArrangementIds(tasks, new Set(['property-a'])),
    `named case ${index} changed arrangement membership`,
  )
}

let randomState = 0x5a049053
function randomInt(max: number) {
  randomState = (randomState * 1664525 + 1013904223) >>> 0
  return randomState % max
}

const taskTypes = ['checkout_clean', 'checkout_cleaning', 'checkin_clean', 'ordinary_clean']
const days = ['2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22']
const statuses = ['assigned', 'pending', 'inspected', 'done', 'completed', 'ready', 'keys_hung', 'cancelled']

for (let run = 0; run < 20_000; run += 1) {
  const tasks = Array.from({ length: randomInt(14) }, (_, index) => {
    const day = days[randomInt(days.length)]
    return task(`fuzz-${run}-${index}`, {
      propertyId: randomInt(3) === 0 ? 'property-b' : 'property-a',
      taskType: taskTypes[randomInt(taskTypes.length)],
      day,
      status: statuses[randomInt(statuses.length)],
      active: randomInt(4) !== 0,
      validOrder: randomInt(4) !== 0,
      inspectionMode: randomInt(2) === 0 ? 'deferred' : '',
      inspectionScope: randomInt(4) === 0 ? 'password_only' : 'inspect_and_hang',
      inspectionDueDate: randomInt(4) === 0 ? null : days[randomInt(days.length)],
    })
  })
  assert.deepEqual(
    newArrangementIds(tasks, new Set(['property-a'])),
    oldArrangementIds(tasks, new Set(['property-a'])),
    `fuzz run ${run} changed arrangement membership`,
  )
}

const source = fs.readFileSync(path.resolve(__dirname, '../../src/modules/mzapp.ts'), 'utf8')
const queryStart = source.indexOf('`WITH normalized_arrangement_tasks AS MATERIALIZED (')
const queryEnd = source.indexOf('`,\n            [arrangementPropertyIds]', queryStart)
assert(queryStart >= 0 && queryEnd > queryStart, 'optimized arrangement query must remain discoverable')
const query = source.slice(queryStart, queryEnd)
assert.equal((query.match(/FROM cleaning_tasks\b/g) || []).length, 1, 'arrangement query must scan cleaning_tasks only once')
assert.doesNotMatch(query, /FROM cleaning_tasks deferred/, 'correlated full cleaning_tasks rescan must stay removed')
assert.match(query, /normalized_arrangement_tasks AS MATERIALIZED/, 'normalized task set must remain materialized')
assert.match(query, /deferred_arrangement_tasks AS MATERIALIZED/, 'deferred task set must remain materialized')
assert.match(query, /checkin\.task_day BETWEEN deferred\.task_day AND deferred\.inspection_due_date/, 'MZ049 replacement window must remain inclusive')
assert.match(query, /checkin\.property_id = deferred\.property_id/, 'replacement matching must stay property scoped')
assert.match(query, /inspection_scope, 'inspect_and_hang'\)\) <> 'password_only'/, 'password-only check-ins must remain excluded')
assert.match(query, /UNION ALL/, 'deferred and check-in task kinds must remain a duplicate-free append')

process.stdout.write('test_work_tasks_cleaning_arrangement_equivalence: ok (named boundaries + 20,000 fuzz cases)\n')
