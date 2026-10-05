import assert from 'assert'
import fs from 'fs'
import path from 'path'
import {
  registerCleaningStartTimeoutSchedule,
  resolveCleaningStartTimeoutScheduleConfig,
} from '../../src/services/cleaningStartTimeoutSchedule'

type ScheduledHandler = () => Promise<void>

function makeHarness(env: NodeJS.ProcessEnv) {
  const scheduled: Array<{ expression: string; handler: ScheduledHandler; options?: { scheduled?: boolean } }> = []
  const queries: string[] = []
  const logs: string[] = []
  let starts = 0

  const task = registerCleaningStartTimeoutSchedule({
    env,
    hasPg: true,
    pgPool: {
      async query(sql: string) {
        queries.push(sql)
        return {
          rows: [
            {
              id: 'overdue-task',
              assignee_id: 'assignee-1',
              scheduled_at: '2026-10-04T08:00:00.000Z',
              key_photo_uploaded_at: null,
            },
            {
              id: 'completed-key-task',
              assignee_id: 'assignee-2',
              scheduled_at: '2026-10-04T08:00:00.000Z',
              key_photo_uploaded_at: '2026-10-04T08:30:00.000Z',
            },
          ],
        }
      },
    },
    schedule(expression, handler, options) {
      scheduled.push({ expression, handler, options })
      return { start: () => { starts += 1 } }
    },
    logger: {
      log: (message?: any) => { logs.push(String(message || '')) },
      error: (message?: any) => { logs.push(`error:${String(message || '')}`) },
    },
    now: () => Date.parse('2026-10-04T10:00:00.000Z'),
  })

  return { task, scheduled, queries, logs, starts: () => starts }
}

function testDefaultIsCompletelyDisabled() {
  const h = makeHarness({ FEATURE_CLEANING_APP: 'true' })
  assert.equal(h.task, null)
  assert.equal(h.scheduled.length, 0)
  assert.equal(h.queries.length, 0)
  assert.equal(h.starts(), 0)
  assert.ok(h.logs.some((line) => line.includes('reason=flag_disabled')))
}

function testExplicitFalseIsCompletelyDisabled() {
  const h = makeHarness({
    FEATURE_CLEANING_APP: 'true',
    CLEANING_START_TIMEOUT_ENABLED: 'false',
  })
  assert.equal(h.task, null)
  assert.equal(h.scheduled.length, 0)
  assert.equal(h.queries.length, 0)
  assert.equal(h.starts(), 0)
}

function testCleaningFeatureStillGuardsExplicitEnable() {
  const h = makeHarness({
    FEATURE_CLEANING_APP: 'false',
    CLEANING_START_TIMEOUT_ENABLED: 'true',
  })
  assert.equal(h.task, null)
  assert.equal(h.scheduled.length, 0)
  assert.equal(h.queries.length, 0)
  assert.ok(h.logs.some((line) => line.includes('reason=cleaning_feature_disabled')))
}

function testPgUnavailableDoesNotRegisterOrStart() {
  let scheduled = 0
  let started = 0
  const logs: string[] = []
  const task = registerCleaningStartTimeoutSchedule({
    env: {
      FEATURE_CLEANING_APP: 'true',
      CLEANING_START_TIMEOUT_ENABLED: 'true',
    },
    hasPg: false,
    pgPool: null,
    schedule() {
      scheduled += 1
      return { start: () => { started += 1 } }
    },
    logger: {
      log: (message?: any) => { logs.push(String(message || '')) },
      error: (message?: any) => { logs.push(`error:${String(message || '')}`) },
    },
  })
  assert.equal(task, null)
  assert.equal(scheduled, 0)
  assert.equal(started, 0)
  assert.ok(logs.some((line) => line.includes('reason=pg_unavailable')))
}

function testExplicitEnablePreservesLegacyCronAndThresholdParsing() {
  const zeroThreshold = resolveCleaningStartTimeoutScheduleConfig({
    FEATURE_CLEANING_APP: 'true',
    CLEANING_START_TIMEOUT_ENABLED: 'true',
    CLEANING_START_TIMEOUT_CRON: ' 5 * * * * ',
    CLEANING_START_TIMEOUT_MINUTES: '0',
  })
  assert.equal(zeroThreshold.expression, ' 5 * * * * ')
  assert.equal(zeroThreshold.thresholdMinutes, 0)

  const invalidThreshold = resolveCleaningStartTimeoutScheduleConfig({
    FEATURE_CLEANING_APP: 'true',
    CLEANING_START_TIMEOUT_ENABLED: 'true',
    CLEANING_START_TIMEOUT_MINUTES: 'not-a-number',
  })
  assert.ok(Number.isNaN(invalidThreshold.thresholdMinutes))

  const legacyFeatureWhitespace = resolveCleaningStartTimeoutScheduleConfig({
    FEATURE_CLEANING_APP: ' true ',
    CLEANING_START_TIMEOUT_ENABLED: 'true',
  })
  assert.equal(legacyFeatureWhitespace.featureEnabled, false)
}

async function testExplicitEnablePreservesScheduledBehaviorWithoutRunOnStart() {
  const h = makeHarness({
    FEATURE_CLEANING_APP: 'true',
    CLEANING_START_TIMEOUT_ENABLED: 'true',
    CLEANING_START_TIMEOUT_CRON: '5 * * * *',
    CLEANING_START_TIMEOUT_MINUTES: '90',
  })
  assert.ok(h.task)
  assert.equal(h.scheduled.length, 1)
  assert.equal(h.scheduled[0].expression, '5 * * * *')
  assert.deepEqual(h.scheduled[0].options, { scheduled: true })
  assert.equal(h.starts(), 1)
  assert.equal(h.queries.length, 0, 'registration must not run the database scan immediately')

  await h.scheduled[0].handler()
  assert.equal(h.queries.length, 1)
  assert.ok(h.queries[0].includes("from cleaning_tasks where date=now()::date and status='scheduled'"))
  assert.ok(h.logs.some((line) => line.includes('task=overdue-task')))
  assert.ok(!h.logs.some((line) => line.includes('task=completed-key-task')))
}

function testOtherBackgroundSchedulesRemainRegistered() {
  const indexSource = fs.readFileSync(path.resolve(__dirname, '../../src/index.ts'), 'utf8')
  for (const marker of [
    'NOTIFICATION_WORKER_ENABLED',
    'CLEANING_BACKFILL_FAST_ENABLED',
    'CLEANING_SYNC_JOBS_ENABLED',
    'CLEANING_SYNC_RETRY_ENABLED',
  ]) {
    assert.ok(indexSource.includes(marker), `${marker} registration must remain in backend startup`)
  }
}

async function main() {
  testDefaultIsCompletelyDisabled()
  testExplicitFalseIsCompletelyDisabled()
  testCleaningFeatureStillGuardsExplicitEnable()
  testPgUnavailableDoesNotRegisterOrStart()
  testExplicitEnablePreservesLegacyCronAndThresholdParsing()
  await testExplicitEnablePreservesScheduledBehaviorWithoutRunOnStart()
  testOtherBackgroundSchedulesRemainRegistered()
  process.stdout.write('ok\n')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
