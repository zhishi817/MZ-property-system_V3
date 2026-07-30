import assert from 'assert'
import fs from 'fs'
import path from 'path'

async function main() {
  const source = fs.readFileSync(path.resolve(__dirname, '../../src/modules/cleaning_app.ts'), 'utf8')
  const start = source.indexOf("router.post('/tasks/:id/inspection-issue-photos'")
  const end = source.indexOf('const completionPhotosSchema', start)
  assert(start >= 0 && end > start, 'post-inspection issue append route must exist')
  const route = source.slice(start, end)

  assert.match(route, /isInspectionFinishedStatus/, 'only a successfully submitted inspection may append issue evidence')
  assert.match(route, /scopeType: 'cleaning_task_inspection_issue_photos'/, 'issue append must use a dedicated idempotency scope')
  assert.match(route, /loadIdempotentStepReceipt\(client/, 'issue append must replay a matching submission safely')
  assert.match(route, /saveIdempotentStepReceipt\(client/, 'issue append must persist its receipt in the same transaction')
  assert.match(route, /type = 'inspection_unclean'/, 'issue append must count only its own media type')
  assert.match(route, /VALUES \(\$1,\$2,'inspection_unclean'/, 'issue append must add cleaning issue media')
  assert.doesNotMatch(route, /DELETE\s+FROM\s+cleaning_task_media/i, 'issue append must not replace submitted inspection media')
  assert.doesNotMatch(route, /applyCleaningTaskActionTransition/, 'issue append must not advance the task state again')

  process.stdout.write('test_inspection_issue_append_contract: ok\n')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
