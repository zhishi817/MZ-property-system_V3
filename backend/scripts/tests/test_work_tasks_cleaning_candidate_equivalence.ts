import assert from 'node:assert/strict'

type QueryScope = {
  from: string
  to: string
  userId: string
  allowAll: boolean
}

type ActionEvidence = {
  action: 'complete_cleaning' | 'submit_inspection'
  actorUserId: string
  occurredAt: string
}

type MediaEvidence = {
  actorUserId: string
  capturedAt: string
  url: string
}

type CancellationEvidence = {
  occurredAt: string
  sequence: number
}

type SyntheticTask = {
  id: string
  scheduledDate: string
  deferred: boolean
  inspectionDueDate: string | null
  status: string
  active: boolean
  validOrder: boolean
  hasMatchingCheckinInRange: boolean
  actions: ActionEvidence[]
  media: MediaEvidence[]
  cancellations: CancellationEvidence[]
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

function melbourneDate(instant: string) {
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Melbourne',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(instant))
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value || ''
  return `${value('year')}-${value('month')}-${value('day')}`
}

function inRange(date: string, query: QueryScope) {
  return date >= query.from && date <= query.to
}

function scheduledOrDeferredMatch(task: SyntheticTask, query: QueryScope) {
  if (inRange(task.scheduledDate, query)) return true
  if (!task.deferred || !task.inspectionDueDate) return false
  const unfinished = !terminalDeferredStatuses.has(task.status.toLowerCase())
  const dueWindowMatch = task.inspectionDueDate <= query.to
    && (task.inspectionDueDate >= query.from || unfinished)
  return dueWindowMatch || (unfinished && task.hasMatchingCheckinInRange)
}

function permitted(actorUserId: string, query: QueryScope) {
  return query.allowAll || actorUserId === query.userId
}

function latestCancellation(task: SyntheticTask) {
  return [...task.cancellations].sort((left, right) => {
    const byTime = right.occurredAt.localeCompare(left.occurredAt)
    return byTime || right.sequence - left.sequence
  })[0] || null
}

function actionOrMediaEvidenceMatch(task: SyntheticTask, query: QueryScope) {
  const actionMatch = task.actions.some((evidence) => (
    permitted(evidence.actorUserId, query)
    && inRange(melbourneDate(evidence.occurredAt), query)
  ))
  const mediaMatch = task.media.some((evidence) => (
    evidence.url.trim() !== ''
    && permitted(evidence.actorUserId, query)
    && inRange(melbourneDate(evidence.capturedAt), query)
  ))
  return actionMatch || mediaMatch
}

function latestCancellationMatchesRange(task: SyntheticTask, query: QueryScope) {
  const cancellation = latestCancellation(task)
  return !!cancellation && inRange(melbourneDate(cancellation.occurredAt), query)
}

function oldBroadQueryIncludes(task: SyntheticTask, query: QueryScope) {
  const scheduled = scheduledOrDeferredMatch(task, query)
  const actionOrMedia = actionOrMediaEvidenceMatch(task, query)
  const latestCancellationExists = latestCancellation(task) !== null
  const historicalInRange = actionOrMedia || latestCancellationMatchesRange(task, query)
  const evidenceBypassesActiveOrder = actionOrMedia || latestCancellationExists
  return (scheduled || historicalInRange) && ((task.active && task.validOrder) || evidenceBypassesActiveOrder)
}

function newCandidateQueryIncludes(task: SyntheticTask, query: QueryScope) {
  const scheduled = scheduledOrDeferredMatch(task, query)
  const scheduledCandidate = scheduled && task.active && task.validOrder
  const historicalCandidate = actionOrMediaEvidenceMatch(task, query) || latestCancellationMatchesRange(task, query)
  const cancelledScheduledCandidate = scheduled && latestCancellation(task) !== null
  return scheduledCandidate || historicalCandidate || cancelledScheduledCandidate
}

const selfQuery: QueryScope = {
  from: '2026-10-20',
  to: '2026-10-20',
  userId: 'user-a',
  allowAll: false,
}

const baseTask = (overrides: Partial<SyntheticTask>): SyntheticTask => ({
  id: 'task',
  scheduledDate: '2026-10-19',
  deferred: false,
  inspectionDueDate: null,
  status: 'completed',
  active: false,
  validOrder: false,
  hasMatchingCheckinInRange: false,
  actions: [],
  media: [],
  cancellations: [],
  ...overrides,
})

const namedCases: Array<[string, SyntheticTask, QueryScope, boolean]> = [
  ['active scheduled task', baseTask({ scheduledDate: '2026-10-20', active: true, validOrder: true }), selfQuery, true],
  ['inactive scheduled task without evidence', baseTask({ scheduledDate: '2026-10-20' }), selfQuery, false],
  ['unfinished overdue deferred task', baseTask({ deferred: true, inspectionDueDate: '2026-10-18', status: 'assigned', active: true, validOrder: true }), selfQuery, true],
  ['terminal overdue deferred task', baseTask({ deferred: true, inspectionDueDate: '2026-10-18', status: 'inspected', active: true, validOrder: true }), selfQuery, false],
  ['MZ049 checkin replacement window', baseTask({ deferred: true, inspectionDueDate: '2026-10-22', status: 'assigned', active: true, validOrder: true, hasMatchingCheckinInRange: true }), selfQuery, true],
  ['self completion on actual Melbourne day', baseTask({ actions: [{ action: 'complete_cleaning', actorUserId: 'user-a', occurredAt: '2026-10-20T03:00:00.000Z' }] }), selfQuery, true],
  ['other user completion hidden from mine', baseTask({ actions: [{ action: 'complete_cleaning', actorUserId: 'user-b', occurredAt: '2026-10-20T03:00:00.000Z' }] }), selfQuery, false],
  ['manager sees other user completion', baseTask({ actions: [{ action: 'submit_inspection', actorUserId: 'user-b', occurredAt: '2026-10-20T03:00:00.000Z' }] }), { ...selfQuery, allowAll: true }, true],
  ['Melbourne day begins before UTC day', baseTask({ actions: [{ action: 'complete_cleaning', actorUserId: 'user-a', occurredAt: '2026-10-19T13:00:00.000Z' }] }), selfQuery, true],
  ['instant before Melbourne day boundary excluded', baseTask({ actions: [{ action: 'complete_cleaning', actorUserId: 'user-a', occurredAt: '2026-10-19T12:59:59.999Z' }] }), selfQuery, false],
  ['latest in-range completion wins despite later out-of-range action', baseTask({ actions: [
    { action: 'complete_cleaning', actorUserId: 'user-a', occurredAt: '2026-10-20T03:00:00.000Z' },
    { action: 'complete_cleaning', actorUserId: 'user-a', occurredAt: '2026-10-21T03:00:00.000Z' },
  ] }), selfQuery, true],
  ['latest cancellation outside range excludes older in-range cancellation', baseTask({ cancellations: [
    { occurredAt: '2026-10-20T03:00:00.000Z', sequence: 1 },
    { occurredAt: '2026-10-21T03:00:00.000Z', sequence: 2 },
  ] }), selfQuery, false],
  ['scheduled inactive row keeps the old any-date cancellation bypass', baseTask({ scheduledDate: '2026-10-20', cancellations: [
    { occurredAt: '2026-10-21T03:00:00.000Z', sequence: 1 },
  ] }), selfQuery, true],
  ['latest cancellation in range includes record', baseTask({ cancellations: [
    { occurredAt: '2026-10-19T03:00:00.000Z', sequence: 1 },
    { occurredAt: '2026-10-20T03:00:00.000Z', sequence: 2 },
  ] }), selfQuery, true],
  ['blank lockbox URL is not evidence', baseTask({ media: [{ actorUserId: 'user-a', capturedAt: '2026-10-20T03:00:00.000Z', url: '  ' }] }), selfQuery, false],
  ['authorized lockbox evidence preserves executor record', baseTask({ media: [{ actorUserId: 'user-a', capturedAt: '2026-10-20T03:00:00.000Z', url: 'local-fixture://lockbox' }] }), selfQuery, true],
]

for (const [name, task, query, expected] of namedCases) {
  assert.equal(oldBroadQueryIncludes(task, query), expected, `${name}: old-query model fixture is invalid`)
  assert.equal(newCandidateQueryIncludes(task, query), expected, `${name}: candidate-query result changed`)
}

const emptyTasks: SyntheticTask[] = []
assert.deepEqual(emptyTasks.filter((task) => oldBroadQueryIncludes(task, selfQuery)), [])
assert.deepEqual(emptyTasks.filter((task) => newCandidateQueryIncludes(task, selfQuery)), [])

const scheduledAndHistorical = baseTask({
  id: 'scheduled-and-historical',
  scheduledDate: '2026-10-20',
  active: true,
  validOrder: true,
  actions: [{ action: 'complete_cleaning', actorUserId: 'user-a', occurredAt: '2026-10-20T03:00:00.000Z' }],
})
const deduplicatedCandidateIds = new Set(
  [scheduledAndHistorical]
    .filter((task) => newCandidateQueryIncludes(task, selfQuery))
    .map((task) => task.id),
)
assert.deepEqual([...deduplicatedCandidateIds], ['scheduled-and-historical'])

let randomState = 0x5a053
function randomInt(max: number) {
  randomState = (randomState * 1664525 + 1013904223) >>> 0
  return randomState % max
}

const dates = ['2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22']
const instants = [
  '2026-10-19T12:59:59.999Z',
  '2026-10-19T13:00:00.000Z',
  '2026-10-20T03:00:00.000Z',
  '2026-10-20T13:00:00.000Z',
  '2026-10-21T03:00:00.000Z',
]
const statuses = ['assigned', 'pending', 'inspected', 'done', 'completed', 'ready', 'keys_hung', 'cancelled']
const actors = ['user-a', 'user-b']

for (let index = 0; index < 20_000; index += 1) {
  const actionCount = randomInt(4)
  const mediaCount = randomInt(3)
  const cancellationCount = randomInt(4)
  const task = baseTask({
    id: `fuzz-${index}`,
    scheduledDate: dates[randomInt(dates.length)],
    deferred: randomInt(2) === 1,
    inspectionDueDate: randomInt(3) === 0 ? null : dates[randomInt(dates.length)],
    status: statuses[randomInt(statuses.length)],
    active: randomInt(2) === 1,
    validOrder: randomInt(2) === 1,
    hasMatchingCheckinInRange: randomInt(2) === 1,
    actions: Array.from({ length: actionCount }, () => ({
      action: randomInt(2) === 0 ? 'complete_cleaning' : 'submit_inspection',
      actorUserId: actors[randomInt(actors.length)],
      occurredAt: instants[randomInt(instants.length)],
    })),
    media: Array.from({ length: mediaCount }, () => ({
      actorUserId: actors[randomInt(actors.length)],
      capturedAt: instants[randomInt(instants.length)],
      url: randomInt(3) === 0 ? '' : 'local-fixture://lockbox',
    })),
    cancellations: Array.from({ length: cancellationCount }, (_unused, sequence) => ({
      occurredAt: instants[randomInt(instants.length)],
      sequence,
    })),
  })
  const query = { ...selfQuery, allowAll: randomInt(2) === 1 }
  assert.equal(
    newCandidateQueryIncludes(task, query),
    oldBroadQueryIncludes(task, query),
    `candidate equivalence failed for ${task.id}`,
  )
}

const syntheticPopulation = Array.from({ length: 50_000 }, (_unused, index) => baseTask({
  id: `population-${index}`,
  scheduledDate: index % 167 === 0 ? '2026-10-20' : '2026-09-01',
  active: true,
  validOrder: true,
  actions: index % 997 === 0
    ? [{ action: 'complete_cleaning', actorUserId: 'user-a', occurredAt: '2026-10-20T03:00:00.000Z' }]
    : [],
}))
const candidateCount = syntheticPopulation.filter((task) => newCandidateQueryIncludes(task, selfQuery)).length
const oldPerTaskHistoryLookups = syntheticPopulation.length * 4
const candidatePerTaskHistoryLookups = candidateCount * 4
assert.ok(candidateCount > 0 && candidateCount < syntheticPopulation.length)
assert.ok(candidatePerTaskHistoryLookups < oldPerTaskHistoryLookups / 100)

console.log(JSON.stringify({
  status: 'passed',
  named_cases: namedCases.length,
  empty_result_case: true,
  scheduled_historical_union_deduplicated: true,
  fuzz_cases: 20_000,
  synthetic_population: syntheticPopulation.length,
  candidate_count: candidateCount,
  structural_history_lookups_before: oldPerTaskHistoryLookups,
  structural_history_lookups_after: candidatePerTaskHistoryLookups,
  note: 'operation-count model only; not a PostgreSQL runtime benchmark',
}))
