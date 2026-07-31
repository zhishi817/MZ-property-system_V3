import assert from 'assert'
import fs from 'fs'
import path from 'path'

const cleaningSource = fs.readFileSync(path.resolve(__dirname, '../../src/modules/cleaning.ts'), 'utf8')
const patchStart = cleaningSource.indexOf("router.patch('/offline-tasks/:id'")
const patchEnd = cleaningSource.indexOf("router.delete('/offline-tasks/:id'", patchStart)
assert(patchStart >= 0 && patchEnd > patchStart, 'offline task PATCH boundaries must exist')

const patchSource = cleaningSource.slice(patchStart, patchEnd)
assert(patchSource.includes("Object.prototype.hasOwnProperty.call(req.body || {}, 'assignee_id')"), 'PATCH must distinguish an omitted assignee from an explicit value')
assert(patchSource.includes('OFFLINE_TASK_ASSIGNEE_REQUIRED'), 'PATCH must reject clearing the assignee')
assert(patchSource.includes('await ensureOfflineTasksTable()'), 'PATCH must ensure the source table')
assert(patchSource.includes('await ensureWorkTasksTable()'), 'PATCH must ensure the canonical work_tasks table')
assert(patchSource.includes('pgRunInTransaction'), 'PATCH must update source and canonical rows transactionally')
assert(patchSource.includes('upsertWorkTaskFromOfflineTask'), 'PATCH must refresh the canonical work task projection')
assert(patchSource.includes('assignment_status'), 'PATCH response must include canonical assignment status')

process.stdout.write('test_offline_task_assignment_patch_contract: ok\n')
