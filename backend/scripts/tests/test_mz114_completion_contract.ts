import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { completionPhotoLimitViolation } from '../../src/lib/cleaningCompletionPhotoLimits'
import { isCleaningCompletionAudit, legacyCompletionPhotoSaveAuditWhereSql } from '../../src/lib/cleaningCompletionEvidence'

const photos = (area: string, count: number) => Array.from({ length: count }, () => ({ area }))
for (const count of [1, 2, 3, 4]) {
  assert.equal(completionPhotoLimitViolation(photos('shower_drain', count), 'stayover_clean'), null)
}
for (const type of ['checkout_clean', 'checkin_clean', undefined, '']) {
  assert.deepEqual(completionPhotoLimitViolation(photos('shower_drain', 2), type), { area: 'shower_drain', limit: 1 })
}
for (const [area, limit] of Object.entries({ toilet: 9, living: 3, sofa: 2, bedroom: 8, kitchen: 2, vacuum_used: 1, remote_tv: 1, remote_ac: 1, remote_controls: 3 })) {
  assert.equal(completionPhotoLimitViolation(photos(area, limit), 'stayover_clean'), null)
  assert.deepEqual(completionPhotoLimitViolation(photos(area, limit + 1), 'stayover_clean'), { area, limit }, `${area}: no unapproved rule change`)
}
assert.equal(isCleaningCompletionAudit({ performed_as_action: 'record_completion_photos', status_after: 'assigned' }), false)
assert.equal(isCleaningCompletionAudit({ performed_as_action: 'complete_cleaning', status_after: 'assigned', metadata: { route: 'cleaning_app.tasks.completion_photos' } }), false)
assert.equal(isCleaningCompletionAudit({ performed_as_action: 'complete_cleaning', status_after: 'assigned', metadata: { step: 'completion_photos_saved' } }), false)
assert.equal(isCleaningCompletionAudit({ performed_as_action: 'complete_cleaning', status_after: 'done', metadata: { route: 'cleaning_app.tasks.self_complete' } }), true)
const legacySql = legacyCompletionPhotoSaveAuditWhereSql('audit')
assert.match(legacySql, /metadata->>'route'.* = 'cleaning_app.tasks.completion_photos'/)
assert.match(legacySql, /AND lower\(COALESCE\(audit.metadata->>'step'.* = 'completion_photos_saved'/)
assert.match(legacySql, /status_before.* = .*status_after/)
assert.throws(() => legacyCompletionPhotoSaveAuditWhereSql('audit; DELETE'), /invalid_sql_alias/)

const source = fs.readFileSync(path.resolve(__dirname, '../../src/modules/cleaning_app.ts'), 'utf8')
const route = source.slice(source.indexOf("router.post('/tasks/:id/completion-photos'"), source.indexOf('const lockboxVideoSchema'))
assert.match(route, /completionPhotoLimitViolation\(parsed.data.items, task.task_type\)/, 'only canonical locked task type selects relaxed drain limit')
assert.match(route, /performedAsAction: 'record_completion_photos'/)
assert.doesNotMatch(route, /performedAsAction: 'complete_cleaning'/, 'photo persistence cannot create a terminal completion audit')
assert(route.indexOf('FOR UPDATE') < route.indexOf('completionPhotoLimitViolation'))
assert(route.indexOf('canPerformCleaningTaskActionForRow') < route.indexOf('completionPhotoLimitViolation'))
assert(route.indexOf('loadIdempotentStepReceipt') < route.indexOf('assertCleaningTaskRoleRecordMutable'))
assert(route.indexOf('assertCleaningTaskRoleRecordMutable') < route.indexOf('DELETE FROM cleaning_task_media'))
assert.match(source, /REQUIRED_COMPLETION_PHOTO_AREAS.filter/, 'minimum area checks remain in formal completion')
assert.match(source, /if \(!canView\) \{[\s\S]*?status\(403\)/, 'private media authorization still fails closed')
console.log('MZ114 completion photo contract passed')
