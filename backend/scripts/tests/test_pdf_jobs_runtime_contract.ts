import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  addPdfJobsRetryDueAt,
  pdfJobRetryDelayMs,
  removeDuePdfJobsRetryDueAts,
  resolvePdfJobsWorkerMode,
} from '../../src/services/pdfJobsRuntime'

const backendRoot = path.resolve(__dirname, '../..')
const read = (relativePath: string) => fs.readFileSync(path.join(backendRoot, relativePath), 'utf8')

assert.deepEqual(resolvePdfJobsWorkerMode(undefined), { mode: 'disabled', reason: 'mode_missing' })
assert.deepEqual(resolvePdfJobsWorkerMode('unknown'), { mode: 'disabled', reason: 'mode_invalid' })
assert.deepEqual(resolvePdfJobsWorkerMode(' once '), { mode: 'once', reason: null })
assert.deepEqual(resolvePdfJobsWorkerMode('daemon'), { mode: 'daemon', reason: null })
assert.deepEqual(resolvePdfJobsWorkerMode('disabled'), { mode: 'disabled', reason: null })

assert.equal(pdfJobRetryDelayMs(1), 60_000)
assert.equal(pdfJobRetryDelayMs(2), 5 * 60_000)
assert.equal(pdfJobRetryDelayMs(3), 30 * 60_000)
assert.equal(pdfJobRetryDelayMs(99), 30 * 60_000)

const firstRetryAt = 1 * 60_000
const laterRetryAt = 30 * 60_000
let pendingRetryAts = addPdfJobsRetryDueAt([], firstRetryAt)
pendingRetryAts = addPdfJobsRetryDueAt(pendingRetryAts, laterRetryAt)
assert.deepEqual(pendingRetryAts, [firstRetryAt, laterRetryAt])
pendingRetryAts = removeDuePdfJobsRetryDueAts(pendingRetryAts, firstRetryAt)
assert.deepEqual(pendingRetryAts, [laterRetryAt], 'a fired 1-minute retry must retain a later 30-minute retry')

const worker = read('src/worker_pdf_jobs.ts')
assert.match(worker, /runtime\.mode === 'once'/)
assert.match(worker, /processPdfJobsDrain/)
assert.match(worker, /await runDrain\(false, 1\)/)
assert.match(worker, /await closeOnceResources\(\)/)
assert.match(worker, /runtime\.mode === 'daemon' && !expr/)
assert.match(worker, /runtime\.mode === 'daemon' && !cron\.validate\(expr\)/)
assert.match(worker, /PDF_JOBS_RUN_ON_START', false/)
assert.doesNotMatch(worker, /PDF_JOBS_CRON\s*\|\|\s*'\*\/1 \* \* \* \*'/)

const service = read('src/services/pdfJobsWorker.ts')
assert.match(service, /export async function processPdfJobsDrain/)
assert.match(service, /while \(total\.processed < maxJobs && Date\.now\(\) - startedAt < maxRunMs\)/)
assert.match(service, /schedulePdfJobsRetryKick\(retryDelayMs\)/)
assert.match(service, /opts\.scheduleRetries !== false/)
assert.match(service, /await processPdfJobsDrain\(\{\s*batchSize: runLimit,\s*maxJobs: 50,\s*maxRunMs: 10 \* 60_000,/s)
assert.match(service, /retryKickDueAts = addPdfJobsRetryDueAt/)
assert.match(service, /retryKickDueAts = removeDuePdfJobsRetryDueAts/)
assert.match(service, /armPdfJobsRetryKick\(\)/)
assert.match(service, /let kickPending = false/)
assert.match(service, /if \(kickScheduled \|\| kickInFlight\) \{\s*kickPending = true\s*return\s*\}/s)
assert.match(service, /if \(kickPending\) \{\s*kickPending = false\s*schedulePdfJobsKick\(kickRequestedLimit\)/s)

function assertProducerKicksAfterInsert(relativePath: string, expectedInsertCount: number) {
  const source = read(relativePath)
  assert.match(source, /import \{ schedulePdfJobsKick \} from '..\/services\/pdfJobsWorker'/)
  assert.match(source, /if \(String\(existing\.status \|\| ''\) === 'queued'\) schedulePdfJobsKick\(1\)/)
  let offset = 0
  let seen = 0
  for (;;) {
    const insertAt = source.indexOf('INSERT INTO pdf_jobs', offset)
    if (insertAt < 0) break
    const returnAt = source.indexOf('return res.json', insertAt)
    const kickAt = source.indexOf('schedulePdfJobsKick(2)', insertAt)
    assert.ok(returnAt > insertAt, `${relativePath}: inserted job must return a response`)
    assert.ok(kickAt > insertAt && kickAt < returnAt, `${relativePath}: kick must be scheduled only after the autocommit insert resolves`)
    offset = returnAt
    seen++
  }
  assert.equal(seen, expectedInsertCount, `${relativePath}: every PDF enqueue path must have a post-commit kick`)
}

assertProducerKicksAfterInsert('src/modules/finance.ts', 2)
assertProducerKicksAfterInsert('src/modules/maintenance.ts', 1)
assertProducerKicksAfterInsert('src/modules/deep_cleaning.ts', 1)

console.log('pdf jobs runtime contract: PASS')
