import assert from 'assert'
import fs from 'fs'
import path from 'path'

const cleaningSource = fs.readFileSync(path.resolve(__dirname, '../../src/modules/cleaning.ts'), 'utf8')
const patchStart = cleaningSource.indexOf("router.patch('/offline-tasks/:id'")
const patchEnd = cleaningSource.indexOf("router.delete('/offline-tasks/:id'", patchStart)
assert(patchStart >= 0 && patchEnd > patchStart, 'offline task PATCH boundaries must exist')

const patchSource = cleaningSource.slice(patchStart, patchEnd)
const ensureOfflineTasksIndex = patchSource.indexOf('await ensureOfflineTasksTable()')
const ensureWorkTasksIndex = patchSource.indexOf('await ensureWorkTasksTable()')
const transactionIndex = patchSource.indexOf('pgRunInTransaction')
const firstLockIndex = patchSource.indexOf('FOR UPDATE')

assert(ensureOfflineTasksIndex >= 0, 'offline PATCH must ensure the source table')
assert(ensureWorkTasksIndex > ensureOfflineTasksIndex, 'offline PATCH must ensure work_tasks after the source table')
assert(transactionIndex > ensureWorkTasksIndex, 'offline PATCH must ensure work_tasks before opening its transaction')
assert(firstLockIndex > ensureWorkTasksIndex, 'offline PATCH must ensure work_tasks before its first row lock')

process.stdout.write('test_offline_task_assignment_first_patch_contract: ok\n')
