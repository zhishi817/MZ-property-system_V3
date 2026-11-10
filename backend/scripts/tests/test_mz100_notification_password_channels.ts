import assert from 'assert'
import fs from 'fs'
import path from 'path'
import vm from 'vm'
import ts from 'typescript'
import { notificationInboxContent, notificationPushContent } from '../../src/lib/notificationChannelContent'

// Synthetic fixtures only. Never import cleaning/routes/workers: their module setup
// can reach storage, queues and external services. Extract pure function declarations.
const source = (file: string) => fs.readFileSync(path.resolve(__dirname, '../../src', file), 'utf8')
const cleaning = source('modules/cleaning.ts')
const parsed = ts.createSourceFile('cleaning.ts', cleaning, ts.ScriptTarget.Latest, true)
const names = ['cleanNotificationText', 'formatCleaningTaskFieldChange', 'buildCleaningTaskUpdateNoticeDetails', 'buildCleaningTaskCreateNoticeDetails']
const declarations = parsed.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && names.includes(node.name?.text || ''))
assert.equal(declarations.length, names.length, 'all isolated pure notice builders must exist')
const javascript = ts.transpileModule(declarations.map(node => node.getText(parsed)).join('\n'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 },
}).outputText
const sandbox: any = {}
vm.runInNewContext(`${javascript}\nthis.builders = { buildCleaningTaskUpdateNoticeDetails, buildCleaningTaskCreateNoticeDetails };`, sandbox, { timeout: 1000 })
const update = (before: any, after: any) => JSON.parse(JSON.stringify(sandbox.builders.buildCleaningTaskUpdateNoticeDetails(before, after)))
const create = (after: any) => JSON.parse(JSON.stringify(sandbox.builders.buildCleaningTaskCreateNoticeDetails(after)))
const previous = { task_date: '2099-01-02', old_code: 'SYNTH-OLD-A', new_code: 'SYNTH-NEW-A', checkout_time: '10:00', guest_special_request: 'Synthetic note', keys_required: 1 }
const next = { ...previous, old_code: 'SYNTH-OLD-B', new_code: 'SYNTH-NEW-B', checkout_time: '11:00', guest_special_request: 'Synthetic changed note', keys_required: 2 }
const changed = update(previous, next)
assert.deepEqual(changed.changes, ['password', 'time', 'note', 'keys'])
assert.ok(changed.lines.includes('旧密码：已更新（值已隐藏）'))
assert.ok(changed.lines.includes('新密码：已更新（值已隐藏）'))
assert.ok(changed.inboxLines.includes('旧密码：SYNTH-OLD-B（原：SYNTH-OLD-A）'))
assert.ok(changed.inboxLines.includes('新密码：SYNTH-NEW-B（原：SYNTH-NEW-A）'))
assert.ok(!changed.lines.join('\n').includes('SYNTH-'), 'push notice lines must not contain synthetic passwords')
assert.equal(changed.lines[0], '任务日期：2099-01-02')
assert.equal(changed.inboxLines[0], changed.lines[0])
for (const line of changed.lines.filter((line: string) => !line.includes('密码'))) assert.ok(changed.inboxLines.includes(line), 'non-password detail must remain identical across channels')
const cleared = update(previous, { ...previous, old_code: null, new_code: '' })
assert.ok(cleared.inboxLines.includes('旧密码：-（原：SYNTH-OLD-A）'))
assert.ok(cleared.inboxLines.includes('新密码：-（原：SYNTH-NEW-A）'))
assert.deepEqual(update(previous, previous), { changes: [], lines: [], inboxLines: [] })
assert.deepEqual(update({ old_code: ' A  B ' }, { old_code: 'A B' }).changes, [], 'normalization alone is not a password change')
assert.deepEqual(update({}, { status: 'ready' }).inboxLines, [], 'status-only notices must preserve the default-body fallback')

for (const [task_type, field, label] of [['checkout_clean', 'old_code', '旧密码'], ['checkin_clean', 'new_code', '新密码']]) {
  const notice = create({ ...next, task_type })
  assert.ok(notice.lines.includes(`${label}：已填写（值已隐藏）`))
  assert.ok(notice.inboxLines.includes(`${label}：${(next as any)[field]}`))
  assert.ok(!notice.lines.join('\n').includes('SYNTH-'))
  const irrelevant = field === 'old_code' ? 'new_code' : 'old_code'
  assert.ok(!notice.inboxLines.join('\n').includes((next as any)[irrelevant]), 'creation must include only the applicable task password')
}
assert.ok(!create({ ...next, task_type: 'stayover_clean' }).inboxLines.join('\n').includes('SYNTH-'), 'stayover creation must not expose inapplicable passwords')
assert.deepEqual(create({ task_type: 'checkin_clean', task_date: '2099-01-02' }), { changes: [], lines: [], inboxLines: [] })

const publicBody = changed.lines.join('\n')
const privateBody = changed.inboxLines.join('\n')
const metadata = Object.freeze({ entity: 'cleaning_task', entityId: 'synthetic-task', action: 'open_task', _inbox_body: privateBody })
const publicMetadata = { entity: 'cleaning_task', entityId: 'synthetic-task', action: 'open_task' }
assert.deepEqual(notificationInboxContent(publicBody, metadata), { body: privateBody, data: publicMetadata })
assert.deepEqual(notificationPushContent(publicBody, metadata), { body: publicBody, data: publicMetadata })
assert.equal(metadata._inbox_body, privateBody, 'channel serialization must not mutate stored metadata')
for (const invalid of [undefined, null, '', '   ', 123, false, {}, []]) {
  const data = { ...publicMetadata, _inbox_body: invalid }
  assert.deepEqual(notificationInboxContent(publicBody, data), { body: publicBody, data: publicMetadata }, 'legacy/invalid private body must fall back to stored public body')
  assert.deepEqual(notificationPushContent(publicBody, data), { body: publicBody, data: publicMetadata }, 'reserved metadata must always be stripped from push')
}
for (const data of [undefined, null, {}, publicMetadata]) {
  assert.equal(notificationInboxContent(publicBody, data).body, publicBody, 'old notifications remain readable')
  assert.equal(notificationPushContent(publicBody, data).body, publicBody)
}
assert.ok(!JSON.stringify(notificationPushContent(publicBody, metadata)).includes('SYNTH-'), 'the complete outbound payload must not contain inbox passwords')

// Source integration gates complement the runtime pure-function tests above.
const notifications = source('modules/notifications.ts')
const inboxStart = notifications.indexOf("router.get('/inbox'")
const inboxEnd = notifications.indexOf('router.', inboxStart + 10)
const inbox = notifications.slice(inboxStart, inboxEnd < 0 ? undefined : inboxEnd)
assert.ok(inbox.includes('notificationInboxContent('), 'authenticated inbox must serialize the private body')
assert.ok(inbox.includes('user_id = $1') && inbox.includes('String(user.sub'), 'inbox must retain user ownership scoping')
const events = source('services/notificationEvents.ts')
assert.match(events, /inboxBody\??:\s*string/, 'private body must be an explicit event input')
assert.ok(events.includes('_inbox_body') && events.includes('params.inboxBody'), 'event persistence must explicitly store inbox-only content')
assert.ok(events.includes("...notificationPushContent('', baseData).data"), 'arbitrary event data must not inject the reserved inbox body')
const eventAst = ts.createSourceFile('notificationEvents.ts', events, ts.ScriptTarget.Latest, true)
let persistedData: ts.Expression | undefined
const findPersistedData = (node: ts.Node) => {
  if (ts.isVariableDeclaration(node) && node.name.getText(eventAst) === 'data' && node.initializer?.getText(eventAst).includes('params.inboxBody')) persistedData = node.initializer
  ts.forEachChild(node, findPersistedData)
}
findPersistedData(eventAst)
assert.ok(persistedData, 'event persistence data object must exist')
const dataExpression = ts.transpileModule(`this.result = (${persistedData!.getText(eventAst)});`, {
  compilerOptions: { target: ts.ScriptTarget.ES2018 },
}).outputText
for (const enabled of [undefined, 'false', 'TRUE', '', 'true']) {
  for (const inboxBody of [undefined, null, '', '   ', privateBody]) {
    const context: any = { process: { env: { NOTIFICATION_INBOX_PASSWORD_VALUES_ENABLED: enabled } }, notificationPushContent, baseData: metadata, params: { inboxBody }, eventId: 'synthetic-event', entity: 'cleaning_task', entityId: 'synthetic-task', appPolicyKey: null, isAppNotificationPolicyKey: () => false }
    vm.runInNewContext(dataExpression, context, { timeout: 1000 })
    assert.equal(context.result._inbox_body, enabled === 'true' && inboxBody === privateBody ? privateBody : undefined, 'only explicit non-empty inboxBody with the exact opt-in flag may populate private storage')
    assert.equal(context.result.action, 'open_task', 'event metadata must keep navigation data')
  }
}
const worker = source('services/notificationQueueWorker.ts')
assert.ok(worker.includes('notificationPushContent('), 'worker must strip private content before push')
const intake = worker.slice(worker.indexOf('async function takePendingBatch('), worker.indexOf('async function markSent('))
assert.ok(intake.includes('...notificationPushContent(x.body, x.data)'), 'queue intake mapping must replace raw body and data with sanitized channel content')
const process = worker.slice(worker.indexOf('async function processOnce('), worker.indexOf('type QueueDrainResult'))
const takeAt = process.indexOf('await takePendingBatch(')
const groupAt = process.indexOf('byPayload.get(')
assert.ok(takeAt >= 0 && groupAt > takeAt, 'payload grouping must consume the sanitized intake batch')
for (const adapter of ['notifyExpoUsers', 'notifyExpoAll']) {
  const start = notifications.indexOf(`export async function ${adapter}(`)
  const end = notifications.indexOf('export async function ', start + 1)
  assert.ok(notifications.slice(start, end < 0 ? undefined : end).includes('notificationPushContent(params.body, params.data)'), `${adapter} must strip private metadata at the final push boundary`)
}
const mobileManager = source('modules/mzapp.ts')
const managerStart = mobileManager.indexOf('async function handleManagerFields')
const managerEnd = mobileManager.indexOf("router.patch('/cleaning-tasks/manager-fields'", managerStart)
const manager = mobileManager.slice(managerStart, managerEnd)
assert.ok(manager.includes('inboxBody,') && manager.includes('const inboxBody = lines.flatMap('), 'existing mobile manager notice must pass a separate inbox body')
assert.ok(manager.includes('transactionResult.passwordNoticeChanges || []).filter('), 'mobile inbox must use saved transaction password changes')
assert.ok(manager.includes("const body = lines.join('\\n')"), 'mobile push must retain the original redacted lines')
assert.ok(manager.includes('RETURNING old_code, new_code'), 'notice values must come from UPDATE RETURNING')
assert.ok(manager.includes('const passwordWriteFields = claimedFields.filter((field) => passwordEntryByField.has(field))'), 'unclaimed/replayed fields must never be included as writes')
assert.ok(manager.includes('const lockedPasswordTasks = lockedTasks.filter(') && manager.includes('FOR UPDATE'), 'before snapshots must come from the locked task set')
for (const [field, label] of [['old_code', '旧密码'], ['new_code', '新密码']]) {
  const savedChange = `(transactionResult.passwordNoticeChanges || []).some((change) => change.field === '${field}')`
  assert.ok(manager.includes(`if (${savedChange}) lines.push('${label}：已更新（值已隐藏）')`), 'password line presence must use committed changes rather than a stale pre-transaction snapshot')
  assert.ok(manager.includes(`if (${savedChange}) changes.push('password')`), 'password event markers must reflect saved changes only')
  assert.ok(manager.includes(`${field}_changed: ${savedChange}`), 'password dedupe flags must reflect saved changes only')
  assert.ok(!manager.includes(`parsed.data.${field} !== undefined && !eqNorm(parsed.data.${field}, prevRow?.${field})`), 'stale request comparison must not suppress a concurrent saved password change or invent a replay change')
}
const replayGuardAt = manager.indexOf('if (transactionResult.replayed)')
const sideEffectsAt = manager.indexOf('setImmediate(', replayGuardAt)
assert.ok(replayGuardAt >= 0 && sideEffectsAt > replayGuardAt && manager.slice(replayGuardAt, sideEffectsAt).includes('return res.status('), 'operation receipt replay must return before notification side effects')

// Execute the actual collection loop and formatting expression with synthetic
// locked/returned rows. Do not run the transaction callback or any query.
const managerAst = ts.createSourceFile('manager.ts', manager, ts.ScriptTarget.Latest, true)
let collectLoop: ts.ForOfStatement | undefined
let inboxExpression: ts.Expression | undefined
const findPasswordSnippets = (node: ts.Node) => {
  if (ts.isForOfStatement(node) && node.expression.getText(managerAst) === 'passwordWriteFields' && node.statement.getText(managerAst).includes('passwordNoticeChanges.push')) collectLoop = node
  if (ts.isVariableDeclaration(node) && node.name.getText(managerAst) === 'inboxBody') inboxExpression = node.initializer
  ts.forEachChild(node, findPasswordSnippets)
}
findPasswordSnippets(managerAst)
assert.ok(collectLoop && inboxExpression, 'the real saved-change collector and inbox formatter must exist')
const transpileSnippet = (text: string) => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2019 } }).outputText
const collector = transpileSnippet(collectLoop!.getText(managerAst))
const formatter = transpileSnippet(`this.result = (${inboxExpression!.getText(managerAst)});`)
const norm = (value: any) => String(value ?? '').replace(/\s+/g, ' ').trim()
const fmt = (label: string, after: any, before: any) => `${label}：${norm(after) || '-'}（原：${norm(before) || '-'}）`
const oldRedacted = '旧密码：已更新（值已隐藏）'
const newRedacted = '新密码：已更新（值已隐藏）'
const evaluateSavedNotice = (passwordWriteFields: string[], row: any, writtenRow: any, lines: string[]) => {
  const context: any = { passwordWriteFields, row, writtenRow, passwordNoticeChanges: [], eqNorm: (left: any, right: any) => norm(left) === norm(right) }
  vm.runInNewContext(collector, context, { timeout: 1000 })
  const render: any = { lines, transactionResult: { passwordNoticeChanges: context.passwordNoticeChanges }, fmt }
  vm.runInNewContext(formatter, render, { timeout: 1000 })
  return { changes: JSON.parse(JSON.stringify(context.passwordNoticeChanges)), body: render.result }
}
const saved = evaluateSavedNotice(['old_code', 'new_code'], previous, next, [oldRedacted, newRedacted, '非密码详情'])
assert.equal(saved.body, '旧密码：SYNTH-OLD-B（原：SYNTH-OLD-A）\n新密码：SYNTH-NEW-B（原：SYNTH-NEW-A）\n非密码详情')
assert.equal(saved.changes.length, 2)
const clearSaved = evaluateSavedNotice(['new_code'], previous, { new_code: null }, [newRedacted])
assert.equal(clearSaved.body, '新密码：-（原：SYNTH-NEW-A）')
for (const [fields, written] of [[[], next], [['old_code'], previous], [['old_code'], undefined]] as Array<[string[], any]>) {
  const skipped = evaluateSavedNotice(fields, previous, written, [oldRedacted])
  assert.deepEqual(skipped.changes, [], 'replayed/unclaimed, unchanged or missing returned rows must not manufacture saved password changes')
  assert.equal(skipped.body, oldRedacted, 'no saved change must retain redacted fallback')
}
const multiple: any = { lines: [oldRedacted], transactionResult: { passwordNoticeChanges: [
  { field: 'old_code', before: 'SYNTH-LOCKED-1', after: 'SYNTH-SAVED-1' },
  { field: 'old_code', before: 'SYNTH-LOCKED-2', after: 'SYNTH-SAVED-2' },
  { field: 'new_code', before: 'SYNTH-OTHER-1', after: 'SYNTH-OTHER-2' },
] }, fmt }
vm.runInNewContext(formatter, multiple, { timeout: 1000 })
assert.equal(multiple.result, '旧密码：SYNTH-SAVED-1（原：SYNTH-LOCKED-1）\n旧密码：SYNTH-SAVED-2（原：SYNTH-LOCKED-2）', 'multiple saved task changes must retain their corresponding locked before values and field scope')
const calls: ts.CallExpression[] = []
const visit = (node: ts.Node) => {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && /^buildCleaningTask(Update|Create)NoticeDetails$/.test(node.expression.text)) calls.push(node)
  ts.forEachChild(node, visit)
}
visit(parsed)
assert.equal(calls.length, 4, 'both update paths, manual creation and the atomic-save path must be covered; review this gate if a new caller is added')
for (const call of calls) {
  const follow = cleaning.slice(call.end, call.end + 1800)
  assert.ok(/inboxBody\s*[:,]/.test(follow) && follow.includes('inboxLines'), 'every builder caller must pass private inbox content explicitly')
}
console.log('MZ-100 notification password channel tests passed (synthetic, no database or push calls)')
