import assert from 'assert'
import fs from 'fs'
import path from 'path'

const cleaningSource = fs.readFileSync(path.resolve(__dirname, '../../src/modules/cleaning.ts'), 'utf8')
const cleaningPageSource = fs.readFileSync(path.resolve(__dirname, '../../../frontend/src/app/cleaning/page.tsx'), 'utf8')
const patchStart = cleaningSource.indexOf("router.patch('/offline-tasks/:id'")
const patchEnd = cleaningSource.indexOf("router.delete('/offline-tasks/:id'", patchStart)
assert(patchStart >= 0 && patchEnd > patchStart, 'offline task PATCH boundaries must exist')

const patchSource = cleaningSource.slice(patchStart, patchEnd)
assert(patchSource.includes("Object.prototype.hasOwnProperty.call(req.body || {}, 'assignee_id')"), 'PATCH must distinguish an omitted assignee from an explicit value')
assert(!patchSource.includes('OFFLINE_TASK_ASSIGNEE_REQUIRED'), 'PATCH must not reject clearing the assignee')
assert(patchSource.includes("String(patch.assignee_id || '').trim() || null"), 'PATCH must normalize null, empty and whitespace-only assignees to null')
assert(patchSource.includes('if (normalizedAssigneeId && !(await isValidAnyStaffId(normalizedAssigneeId)))'), 'PATCH must validate only non-empty assignees')
assert(patchSource.includes('await ensureOfflineTasksTable()'), 'PATCH must ensure the source table')
assert(patchSource.includes('await ensureWorkTasksTable()'), 'PATCH must ensure the canonical work_tasks table')
assert(patchSource.includes('pgRunInTransaction'), 'PATCH must update source and canonical rows transactionally')
assert(patchSource.includes('upsertWorkTaskFromOfflineTask'), 'PATCH must refresh the canonical work task projection')
assert(patchSource.includes('assignment_status'), 'PATCH response must include canonical assignment status')

const createModalStart = cleaningPageSource.indexOf('open={offlineCreateOpen}')
const editModalStart = cleaningPageSource.indexOf('open={offlineEditOpen}', createModalStart)
const manualModalStart = cleaningPageSource.indexOf('open={manualCreateOpen}', editModalStart)
assert(createModalStart >= 0 && editModalStart > createModalStart && manualModalStart > editModalStart, 'offline create/edit modal boundaries must exist')
const createModalSource = cleaningPageSource.slice(createModalStart, editModalStart)
const editModalSource = cleaningPageSource.slice(editModalStart, manualModalStart)
assert.match(createModalSource, /fieldLabel}>指派人[\s\S]*?<Select[\s\S]*?allowClear/, 'offline create assignee must remain optional')
assert.match(editModalSource, /fieldLabel}>指派人[\s\S]*?<Select[\s\S]*?allowClear/, 'offline edit assignee must be clearable')
assert(cleaningPageSource.includes('assignee_id: offlineCreateForm.assignee_id || undefined'), 'blank create assignee must remain omitted')
assert(cleaningPageSource.includes('assignee_id: offlineEditForm.assignee_id || null'), 'blank edit assignee must be submitted as null')

process.stdout.write('test_offline_task_assignment_patch_contract: ok\n')
