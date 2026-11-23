import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const dbPath = require.resolve('../../src/dbAdapter')
const authPath = require.resolve('../../src/auth')
const storePath = require.resolve('../../src/store')
const auditCalls: any[][] = []
const required = (codes: string[]) => (req: any, res: any, next: any) =>
  codes.some((code) => req.user.permissions.includes(code)) ? next() : res.status(403).json({})
const queryCalls: Array<{sql: string; params: any[]}> = []
let exists = true, brokenSchema = false
let configured: any[] = []
let displayNameStorageReady = false
const displayNames = new Map<string, string>()
let actionTemplate: any = null
const actionDisplayNames = new Map<string, string>()
let actionDependencies = {property_expenses: 0, company_expenses: 0, finance_transactions: 0}
let failDependencyCheck = false
const actionQueryCalls: Array<{sql: string; params: any[]}> = []
const linkedLegacyFixture = {
  template: {id: 'T-water', status: 'active'},
  snapshots: [
    {id: 'past-paid', month_key: '2026-09', status: 'paid', amount: 91.25, due_date: '2026-09-30', paid_date: '2026-09-28'},
    {id: 'current-unpaid', month_key: '2026-11', status: 'unpaid', amount: 137.45, due_date: '2026-11-26', bill_received_date: '2026-11-08'},
    {id: 'future-unpaid-out-of-cycle', month_key: '2027-01', status: 'unpaid', amount: 149.9, due_date: '2027-01-19', bill_received_date: '2026-12-30'},
    {id: 'future-paid', month_key: '2027-03', status: 'paid', amount: 155.6, due_date: '2027-03-22', paid_date: '2027-03-20'},
  ],
}
const linkedLegacyBaseline = JSON.stringify(linkedLegacyFixture)
const actionClient = {
  async query(sql: string, params: any[] = []) {
    actionQueryCalls.push({sql, params})
    if (sql.includes('pg_advisory_xact_lock')) return {rows: []}
    if (sql.includes('SELECT * FROM recurring_payments WHERE id = $1 FOR UPDATE')) {
      return {rows: actionTemplate && actionTemplate.id === params[0] ? [{...actionTemplate}] : []}
    }
    if (sql.includes('UPDATE recurring_payments') && sql.includes('SET other_bill_name = $1')) {
      if (!actionTemplate || actionTemplate.id !== params[1] || actionTemplate.property_id !== params[2] || actionTemplate.category !== params[3]) return {rows: []}
      actionDisplayNames.set(String(params[1]), String(params[0]))
      actionTemplate = {...actionTemplate, other_bill_name: String(params[0])}
      return {rows: [{template_id: String(params[1]), other_bill_name: String(params[0])}]}
    }
    if (sql.includes("UPDATE recurring_payments") && sql.includes("SET status = 'paused'")) {
      if (!actionTemplate || actionTemplate.id !== params[1] || actionTemplate.property_id !== params[2] || actionTemplate.category !== params[3]) return {rows: []}
      actionTemplate = {...actionTemplate, status: 'paused', updated_by: params[0]}
      return {rows: [{...actionTemplate}]}
    }
    if (sql.includes('UPDATE recurring_payments') && sql.includes("SET status = 'active'") && sql.includes('start_month_key = $1')) {
      if (!actionTemplate || actionTemplate.id !== params[2] || actionTemplate.property_id !== params[3] || actionTemplate.category !== params[4]) return {rows: []}
      actionTemplate = {...actionTemplate, status: 'active', start_month_key: params[0], updated_by: params[1]}
      return {rows: [{...actionTemplate}]}
    }
    if (sql.includes('SELECT count(*)::int AS count FROM')) {
      if (failDependencyCheck) throw new Error('fixture dependency unavailable')
      const table = sql.match(/FROM\s+(property_expenses|company_expenses|finance_transactions)/)?.[1] as keyof typeof actionDependencies
      return {rows: [{count: actionDependencies[table] || 0}]}
    }
    if (sql.includes('DELETE FROM recurring_payments')) {
      if (!actionTemplate || actionTemplate.id !== params[0] || actionTemplate.property_id !== params[1] || actionTemplate.category !== params[2]) return {rows: []}
      const deleted = {...actionTemplate}
      actionTemplate = null
      return {rows: [deleted]}
    }
    throw new Error(`unexpected action SQL: ${sql}`)
  },
}
let transactionClient: any = actionClient
const fakeDb = {
  hasPg: true,
  pgRunInTransaction: async (callback: any) => callback(transactionClient),
  pgPool: {
    async query(sql: string, params: any[]) {
      if (/^(?:ALTER TABLE|CREATE (?:UNIQUE )?INDEX)/.test(sql.trim())) return {rows: [], rowCount: 0}
      queryCalls.push({sql, params})
      if (brokenSchema) throw Object.assign(new Error('fake missing table'), {code: '42P01'})
      if (sql.includes('recurring_payments') && (sql.includes('COALESCE(cashflow_type') || /\br\.cashflow_type\b/.test(sql))) {
        throw Object.assign(new Error('fake missing cashflow_type column'), {code: '42703'})
      }
      if (sql.includes('INSERT INTO property_bill_configurations')) return {rowCount: exists ? 1 : 0}
      if (sql.includes('information_schema.columns') && sql.includes("column_name = 'other_bill_name'")) {
        return {rows: [{column_present: displayNameStorageReady}]}
      }
      if (sql.includes('FROM property_expenses')) return {rows: [{date: '2026-06-01', status: 'paid', amount: '125.40'}]}
      if (sql.includes('FROM property_bill_configurations')) return {rows: configured}
      if (sql.includes('FROM recurring_payments')) return {rows: [
        {template_id: 'T-water', template_status: 'active', property_id: 'A', category: 'water', vendor: 'Utility', bill_account_no: 'fixture-water', frequency_months: 3,
          due_day_of_month: 31, bill_expected_day_of_month: 12, payment_type: 'bpay', pay_account_name: 'Utility Payee',
          pay_ref: 'BPAY-REF', bpay_code: '123456', start_month_key: '2026-01', note: 'template note'},
        {template_id: 'T-water-future', template_status: 'active', property_id: 'A', category: 'water', vendor: 'Future Utility',
          bill_account_no: 'fixture-future', frequency_months: 12, start_month_key: '2030-01'},
        {template_id: 'T-water-paused', template_status: 'paused', property_id: 'A', category: 'water', vendor: 'Paused Utility',
          bill_account_no: 'fixture-paused', frequency_months: 1, start_month_key: '2024-01'},
      ].map((row) => ({...row, other_bill_name: displayNameStorageReady ? displayNames.get(String(row.template_id)) || null : null}))}
      if (sql.includes('FROM properties')) return {rows: params[0] === 'A'
        ? [{id: 'A', code: 'A-1', address: 'fixture', region: 'Melbourne'}]
        : [
          {id: 'A', code: 'A-10', address: 'fixture', region: 'Melbourne'},
          {id: 'B', code: 'A-2', address: 'new fixture', region: 'Melbourne'},
        ]}
      throw new Error('unexpected SQL')
    },
  },
}
for (const [id, exports] of [[dbPath, fakeDb], [authPath, {
  requireAnyPerm: required, requirePerm: (code: string) => required([code]),
  userHasAnyPerm: async (user: any, codes: string[]) => codes.some(code => user.permissions.includes(code)),
}], [storePath, {addAudit(...args: any[]) { auditCalls.push(args) }}]] as const) {
  require.cache[id] = {id, filename: id, loaded: true, exports} as any
}
const { filterPropertyBillRows, propertyBillsRouter, projectPropertyBills, stripPropertyBillAccounts } = require('../../src/modules/property_bills')
const {
  assertRecurringReferenceWriteTx,
  deleteUnusedPropertyPayableTemplateTx,
  isPropertyPayableMonthDue,
  nextPropertyPayableDueMonthAfter,
  propertyPayableMelbourneMonthKey,
  resumePropertyPayableTemplateTx,
  shouldMaterializePropertyPayableTemplate,
  updatePropertyPayableTemplateDisplayNameTx,
} = require('../../src/lib/propertyPayableTemplateSafety')
const { buildPropertyPayableWorkbenchMonth, ensurePropertyPayableSnapshotTx, router: recurringRouter } = require('../../src/modules/recurring')
const {
  hidePropertyPayableVendor,
  loadHiddenPropertyPayableVendorKeys,
  PROPERTY_PAYABLE_HIDDEN_VENDOR_STORAGE_KEY,
  restorePropertyPayableVendor,
  saveHiddenPropertyPayableVendorKeys,
  visiblePropertyPayableVendorOptions,
} = require('../../../frontend/src/lib/propertyPayableVendorPreferences')
const { sortPropertiesByRegionThenCode } = require('../../../frontend/src/lib/properties')
const menu = 'menu.finance.property_payables.visible'
async function dispatch(routePath: string, permissions: string[], fields: any = {}) {
  const method = String(fields.method || 'get').toLowerCase()
  const route = propertyBillsRouter.stack.find((x: any) => x.route.path === routePath && x.route.methods[method]).route
  let status = 200, payload: any
  const {method: _method, ...requestFields} = fields
  const req = {user: {sub: 'fixture-user', permissions}, query: {}, params: {}, body: {}, ...requestFields}
  const res = {status(n: number) {status = n; return this}, json(data: any) {payload = data; return this}}
  for (const layer of route.stack) {
    let next = false
    await layer.handle(req, res, () => {next = true})
    if (!next) break
  }
  return {status, payload}
}
const dispatchPost = (routePath: string, permissions: string[], fields: any = {}) =>
  dispatch(routePath, permissions, {...fields, method: 'post'})
const dispatchDelete = (routePath: string, permissions: string[], fields: any = {}) =>
  dispatch(routePath, permissions, {...fields, method: 'delete'})
const dispatchPatch = (routePath: string, permissions: string[], fields: any = {}) =>
  dispatch(routePath, permissions, {...fields, method: 'patch'})
async function dispatchRecurring(routePath: string, permissions: string[], fields: any = {}) {
  const method = String(fields.method || 'post').toLowerCase()
  const route = recurringRouter.stack.find((x: any) => x.route?.path === routePath && x.route.methods[method])?.route
  assert.ok(route, `missing recurring route ${method.toUpperCase()} ${routePath}`)
  let status = 200, payload: any
  const {method: _method, ...requestFields} = fields
  const req = {user: {sub: 'fixture-user', username: 'Fixture User', permissions}, query: {}, params: {}, body: {}, ...requestFields}
  const res = {status(n: number) {status = n; return this}, json(data: any) {payload = data; return this}}
  for (const layer of route.stack) {
    let next = false
    await layer.handle(req, res, () => {next = true})
    if (!next) break
  }
  return {status, payload}
}

async function runCreatorDeleteRace(creatorFirst: boolean) {
  const state = {
    template: {id: 'race-template', property_id: 'A', category: 'water', template_kind: 'property_payable', scope: 'property', status: 'active', start_month_key: '2027-01', frequency_months: 1},
    propertyExpenses: [] as any[],
  }
  let held = false
  const waiters: Array<() => void> = []
  const acquire = async () => {
    if (!held) { held = true; return }
    await new Promise<void>((resolve) => waiters.push(resolve))
  }
  const release = () => {
    const next = waiters.shift()
    if (next) next()
    else held = false
  }
  const client = () => {
    let locked = false
    return {
      release,
      async query(sql: string, params: any[] = []) {
        if (sql.includes('pg_advisory_xact_lock')) {
          if (!locked) { await acquire(); locked = true }
          return {rows: []}
        }
        if (sql.includes('SELECT * FROM recurring_payments WHERE id = $1 FOR UPDATE')) {
          return {rows: state.template?.id === params[0] ? [{...state.template}] : []}
        }
        if (sql.includes('SELECT count(*)::int AS count FROM property_expenses')) return {rows: [{count: state.propertyExpenses.length}]}
        if (sql.includes('SELECT count(*)::int AS count FROM company_expenses')) return {rows: [{count: 0}]}
        if (sql.includes('SELECT count(*)::int AS count FROM finance_transactions')) return {rows: [{count: 0}]}
        if (sql.includes('DELETE FROM recurring_payments')) {
          const deleted = state.template
          state.template = null as any
          return {rows: deleted ? [deleted] : []}
        }
        throw new Error(`unexpected race SQL: ${sql}`)
      },
    }
  }
  const creatorClient = client()
  const deleteClient = client()
  const create = async () => {
    try {
      await assertRecurringReferenceWriteTx(creatorClient, 'property_expenses', null, {
        fixed_expense_id: 'race-template', month_key: '2027-01', property_id: 'A', category: 'water',
      })
      state.propertyExpenses.push({fixed_expense_id: 'race-template'})
      return {created: true}
    } finally { creatorClient.release() }
  }
  const remove = async () => {
    try {
      return await deleteUnusedPropertyPayableTemplateTx(deleteClient, {templateId: 'race-template', propertyId: 'A', category: 'water'})
    } finally { deleteClient.release() }
  }
  const first = creatorFirst ? create() : remove()
  const second = creatorFirst ? remove() : create()
  const [firstResult, secondResult] = await Promise.allSettled([first, second])
  return {state, createResult: creatorFirst ? firstResult : secondResult, deleteResult: creatorFirst ? secondResult : firstResult}
}

async function runTimedResume(initialNowISO: string, afterLockNowISO: string) {
  let sampledNowISO = initialNowISO
  let lockAcquired = false
  let templateRead = false
  let nowCalls = 0
  const template = {
    id: 'timed-resume', property_id: 'A', category: 'water', template_kind: 'property_payable', scope: 'property',
    status: 'paused', start_month_key: '2026-09', frequency_months: 3,
  }
  const snapshots = [
    {id: 'past-paid', month_key: '2026-09', status: 'paid'},
    {id: 'future-paid', month_key: '2027-03', status: 'paid'},
  ]
  const snapshotBaseline = JSON.stringify(snapshots)
  const queries: string[] = []
  const client = {
    async query(sql: string, params: any[] = []) {
      queries.push(sql)
      if (sql.includes('pg_advisory_xact_lock')) {
        sampledNowISO = afterLockNowISO
        lockAcquired = true
        return {rows: []}
      }
      if (sql.includes('SELECT * FROM recurring_payments WHERE id = $1 FOR UPDATE')) {
        assert.equal(lockAcquired, true, 'template row is read only after the advisory lock')
        templateRead = true
        return {rows: [{...template}]}
      }
      if (sql.includes('UPDATE recurring_payments') && sql.includes("SET status = 'active'")) {
        return {rows: [{...template, status: 'active', start_month_key: params[0]}]}
      }
      throw new Error(`unexpected timed resume SQL: ${sql}`)
    },
  }
  const result = await resumePropertyPayableTemplateTx(client, {
    templateId: template.id,
    propertyId: template.property_id,
    category: template.category,
    actorId: 'fixture-user',
    now: () => {
      nowCalls += 1
      assert.equal(templateRead, true, 'Melbourne month is sampled only after lock and binding validation')
      return new Date(sampledNowISO)
    },
  })
  assert.equal(nowCalls, 1)
  assert.equal(JSON.stringify(snapshots), snapshotBaseline, 'timed resume does not mutate existing bills')
  assert.equal(queries.some((sql) => /(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+)?(?:property_expenses|company_expenses|finance_transactions)/i.test(sql)), false)
  return result
}
async function main() {
  const viewer = [menu, 'recurring_payments.view']
  const writer = [...viewer, 'recurring_payments.write']
  const search = '/search'
  const detail = '/:propertyId/:category'
  const post = '/:propertyId/:category'
  const history = '/:propertyId/:category/history'
  const stopTemplate = '/:propertyId/:category/templates/:templateId/stop'
  const resumeTemplate = '/:propertyId/:category/templates/:templateId/resume'
  const deleteTemplate = '/:propertyId/:category/templates/:templateId'
  const displayNameTemplate = '/:propertyId/:category/templates/:templateId/display-name'
  const params = {propertyId: 'A', category: 'water'}
  const orderingFixture = projectPropertyBills([
    {id: 'docklands', code: 'D-1', region: 'Docklands', address: 'keep'},
    {id: 'melbourne-10', code: 'A-10', region: 'Melbourne', address: 'keep'},
    {id: 'unassigned', code: '1', region: '', address: 'keep'},
    {id: 'melbourne-2', code: 'A-2', region: 'Melbourne', address: 'keep'},
    {id: 'southbank', code: '3', region: 'Southbank', address: 'skip'},
    {id: 'custom-region', code: '2', region: 'Carlton', address: 'keep'},
  ], [], [])
  assert.deepEqual(sortPropertiesByRegionThenCode(orderingFixture).map((row: any) => row.id), [
    'melbourne-2', 'melbourne-10', 'southbank', 'docklands', 'custom-region', 'unassigned',
  ], 'property bills reuse property management region order and natural room-number comparison')
  assert.deepEqual(sortPropertiesByRegionThenCode(filterPropertyBillRows(orderingFixture, 'keep')).map((row: any) => row.id), [
    'melbourne-2', 'melbourne-10', 'docklands', 'custom-region', 'unassigned',
  ], 'search results retain the same relative property-management order')
  const otherSummary = stripPropertyBillAccounts(projectPropertyBills(
    [
      {id: 'none', code: 'NONE'},
      {id: 'registered', code: 'REGISTERED'},
      {id: 'single', code: 'SINGLE'},
      {id: 'many', code: 'MANY'},
    ],
    [
      {property_id: 'registered', category: 'other', status: 'owner'},
      {property_id: 'many', category: 'other', status: 'owner'},
    ],
    [
      {template_id: 'single-aircon', property_id: 'single', category: 'other', other_bill_name: '空调使用费', category_detail: 'Report Category Semantics', vendor: 'Not The Expense Name', template_status: 'active'},
      {template_id: 'many-long', property_id: 'many', category: 'other', other_bill_name: '这是一个用于验证固定行高不会换行的很长其他账单名称', category_detail: 'Must Not Become A Name Detail', vendor: 'Long Supplier', template_status: 'active', start_month_key: '2026-01'},
      {template_id: 'many-unnamed', property_id: 'many', category: 'other', vendor: 'Must Not Become A Name', note: 'Must Not Become A Name Either', template_status: 'active', start_month_key: '2026-02'},
      {template_id: 'many-paused', property_id: 'many', category: 'other', other_bill_name: '暂停旧账单', vendor: 'Paused Supplier', template_status: 'paused', start_month_key: '2026-03'},
    ],
  ))
  assert.deepEqual(otherSummary.find((row: any) => row.id === 'none').bills, {}, 'no other bill remains an empty dash case')
  assert.deepEqual(otherSummary.find((row: any) => row.id === 'registered').bills.other, {
    source: 'configured', status: 'owner', other_items: [{source: 'configured', status: 'owner'}],
  }, 'a category-only owner registration produces one unnamed item instead of inventing a name')
  assert.deepEqual(otherSummary.find((row: any) => row.id === 'single').bills.other.other_items, [
    {source: 'template', status: 'company', name: '空调使用费', template_status: 'active'},
  ])
  const manyOther = otherSummary.find((row: any) => row.id === 'many').bills.other
  assert.equal(manyOther.registration_status, 'owner', 'category payer remains separate from individual template items')
  assert.deepEqual(manyOther.other_items.map((item: any) => [item.name, item.status, item.template_status]), [
    ['这是一个用于验证固定行高不会换行的很长其他账单名称', 'company', 'active'],
    [undefined, 'company', 'active'],
    ['暂停旧账单', 'company', 'paused'],
  ])
  assert.doesNotMatch(JSON.stringify(otherSummary), /Not The Expense Name|Must Not Become A Name|Long Supplier|Paused Supplier|Report Category Semantics/, 'category detail, vendor and note never become other-bill names')
  const vendorOptions = [
    {value: 'Occom', label: 'Occom'},
    {value: 'Whit te s', label: 'Whit te s'},
    {value: 'South East Water', label: 'South East Water'},
  ]
  const storageValues = new Map<string, string>()
  const fakeStorage = {
    getItem(key: string) { return storageValues.get(key) || null },
    setItem(key: string, value: string) { storageValues.set(key, value) },
  }
  const hiddenTarget = hidePropertyPayableVendor([], '  Whit   te s  ')
  assert.deepEqual(visiblePropertyPayableVendorOptions(vendorOptions, hiddenTarget).map((item: any) => item.value), ['Occom', 'South East Water'], 'only the selected misspelled suggestion is hidden')
  assert.deepEqual(hidePropertyPayableVendor(hiddenTarget, ''), hiddenTarget, 'empty values do not create hidden entries')
  saveHiddenPropertyPayableVendorKeys(fakeStorage, hiddenTarget)
  assert.ok(storageValues.has(PROPERTY_PAYABLE_HIDDEN_VENDOR_STORAGE_KEY))
  const reloadedHiddenTarget = loadHiddenPropertyPayableVendorKeys(fakeStorage)
  assert.deepEqual(reloadedHiddenTarget, hiddenTarget, 'hidden suggestions survive a same-browser reload')
  assert.deepEqual(visiblePropertyPayableVendorOptions(vendorOptions, reloadedHiddenTarget).map((item: any) => item.value), ['Occom', 'South East Water'])
  const restoredTarget = restorePropertyPayableVendor(reloadedHiddenTarget, 'Whit te s')
  assert.deepEqual(visiblePropertyPayableVendorOptions(vendorOptions, restoredTarget).map((item: any) => item.value), ['Occom', 'Whit te s', 'South East Water'], 'restoring returns the exact suggestion without changing its siblings')
  saveHiddenPropertyPayableVendorKeys(fakeStorage, restoredTarget)
  assert.deepEqual(loadHiddenPropertyPayableVendorKeys(fakeStorage), [], 'restored state persists across reload')
  assert.doesNotThrow(() => saveHiddenPropertyPayableVendorKeys({
    getItem() { return null },
    setItem() { throw new Error('fixture storage unavailable') },
  }, hiddenTarget), 'unavailable browser storage does not break the template form')
  assert.equal((await dispatch('/', ['finance.tx.write'])).status, 403)
  assert.equal((await dispatch('/', [menu])).status, 403)
  assert.equal((await dispatchPost(search, [menu], {body: {query: 'fixture-water'}})).status, 403)
  assert.equal((await dispatchPost(post, viewer, {params, body: {status: 'owner'}})).status, 403)
  const bindingTemplate = {id: 'T-binding', property_id: 'A', category: 'water', template_kind: 'property_payable', scope: 'property', status: 'paused'}
  const unchangedSnapshot = {id: 'E-binding', fixed_expense_id: 'T-binding', month_key: '2027-01', property_id: 'A', category: 'water', status: 'unpaid'}
  const existingBindingClient = (snapshot: any) => ({
    writes: 0,
    async query(sql: string) {
      if (sql.includes('pg_advisory_xact_lock')) return {rows: []}
      if (sql.includes('SELECT * FROM recurring_payments')) return {rows: [bindingTemplate]}
      if (sql.includes('FROM property_expenses')) return {rows: snapshot ? [snapshot] : []}
      this.writes += 1
      throw new Error(`unexpected binding SQL: ${sql}`)
    },
  })
  const retainedClient = existingBindingClient(unchangedSnapshot)
  assert.equal((await ensurePropertyPayableSnapshotTx(retainedClient, bindingTemplate, '2027-01', 'fixture-user')).id, 'E-binding')
  assert.equal(retainedClient.writes, 0)
  await assert.rejects(
    () => ensurePropertyPayableSnapshotTx(existingBindingClient({...unchangedSnapshot, property_id: 'B'}), bindingTemplate, '2027-01', 'fixture-user'),
    /property_payable_template_binding_mismatch/,
  )
  await assert.rejects(
    () => ensurePropertyPayableSnapshotTx(existingBindingClient({...unchangedSnapshot, category: 'electricity'}), bindingTemplate, '2027-01', 'fixture-user'),
    /property_payable_template_binding_mismatch/,
  )
  await assert.rejects(
    () => ensurePropertyPayableSnapshotTx(existingBindingClient(null), bindingTemplate, '2027-01', 'fixture-user'),
    /property_payable_template_inactive/,
  )
  const bindingUpdateClient = {
    async query(sql: string) {
      if (sql.includes('pg_advisory_xact_lock')) return {rows: []}
      if (sql.includes('SELECT * FROM recurring_payments')) return {rows: [bindingTemplate]}
      throw new Error(`unexpected binding update SQL: ${sql}`)
    },
  }
  await assert.rejects(
    () => assertRecurringReferenceWriteTx(bindingUpdateClient, 'property_expenses', unchangedSnapshot, {...unchangedSnapshot, property_id: 'B'}),
    /property_payable_template_binding_mismatch/,
  )
  await assert.rejects(
    () => assertRecurringReferenceWriteTx(bindingUpdateClient, 'property_expenses', unchangedSnapshot, {...unchangedSnapshot, category: 'electricity'}),
    /property_payable_template_binding_mismatch/,
  )
  assert.equal(queryCalls.length, 0)
  assert.equal((await dispatch('/', viewer, {query: {property_id: ['A']}})).status, 400)
  assert.equal(queryCalls.length, 0)
  const unconfigured = (await dispatch('/', viewer, {query: {property_id: 'A'}})).payload
  assert.deepEqual(unconfigured, {can_edit: false, display_name_storage_ready: false, rows: [{id: 'A', code: 'A-1', address: 'fixture', region: 'Melbourne', bills: {
    water: {source: 'template', status: 'company', template_count: 3, active_template_count: 2},
  }}]})
  assert.doesNotMatch(JSON.stringify(unconfigured), /fixture-water|fixture-future|fixture-paused|account_number|templates/)
  assert.match(queryCalls[0].sql, /SELECT id, code, address, region FROM properties[\s\S]*archived/)
  assert.deepEqual(queryCalls[0].params, ['A'])
  assert.match(queryCalls[2].sql, /information_schema\.columns[\s\S]*column_name = 'other_bill_name'/)
  assert.match(queryCalls[3].sql, /NULL::text AS other_bill_name[\s\S]*template_kind = 'property_payable'[\s\S]*COALESCE\(r\.status, 'active'\) IN \('active', 'paused'\)/)
  assert.doesNotMatch(queryCalls[3].sql, /start_month_key\s*<=/)
  assert.match(queryCalls[3].sql, /COALESCE\(to_jsonb\(r\)->>'cashflow_type', 'expense'\) = 'expense'/)
  assert.ok(queryCalls.every(({sql}) => /^SELECT/.test(sql)))
  queryCalls.length = 0
  assert.equal((await dispatchPost(search, viewer, {body: {query: ['fixture-water']}})).status, 400)
  assert.equal(queryCalls.length, 0)
  const byAccount = (await dispatchPost(search, viewer, {body: {query: 'fixture-water'}})).payload
  assert.deepEqual(byAccount.rows.map((row: any) => row.id), ['A'])
  assert.doesNotMatch(JSON.stringify(byAccount), /fixture-water|account_number/)
  queryCalls.length = 0
  assert.deepEqual((await dispatchPost(search, viewer, {body: {query: 'fixture-future'}})).payload.rows.map((row: any) => row.id), ['A'], 'future active templates remain searchable')
  queryCalls.length = 0
  assert.deepEqual((await dispatchPost(search, viewer, {body: {query: 'fixture-paused'}})).payload.rows, [], 'paused account does not disclose a match')
  queryCalls.length = 0
  assert.deepEqual((await dispatchPost(search, viewer, {body: {query: 'A-1'}})).payload.rows.map((row: any) => row.id), ['A'])
  queryCalls.length = 0
  assert.deepEqual((await dispatchPost(search, viewer, {body: {query: 'Utility'}})).payload.rows.map((row: any) => row.id), ['A'])
  queryCalls.length = 0
  assert.deepEqual((await dispatchPost(search, viewer, {body: {query: 'does-not-exist'}})).payload.rows, [])
  queryCalls.length = 0
  const templateDetail = (await dispatch(detail, viewer, {params})).payload
  assert.deepEqual(templateDetail.bill, {source: 'template', status: 'company', template_count: 3, active_template_count: 2})
  assert.deepEqual(templateDetail.templates.map((template: any) => [template.template_id, template.template_status]), [
    ['T-water', 'active'], ['T-water-future', 'active'], ['T-water-paused', 'paused'],
  ])
  assert.deepEqual({account_number: templateDetail.templates[0].account_number, payment_type: templateDetail.templates[0].payment_type,
    pay_ref: templateDetail.templates[0].pay_ref, bpay_code: templateDetail.templates[0].bpay_code,
    due_day_of_month: templateDetail.templates[0].due_day_of_month},
  {account_number: 'fixture-water', payment_type: 'bpay', pay_ref: 'BPAY-REF', bpay_code: '123456', due_day_of_month: 31})
  assert.notEqual(templateDetail.templates[0].account_number, templateDetail.templates[0].pay_ref, 'bill Account Number is not sourced from the BPAY payment reference')
  configured = [{property_id: 'A', category: 'water', status: 'company', vendor: 'Configured Utility', account_number: 'configured-123', cycle_months: 1, due_date: null}]
  queryCalls.length = 0
  const configuredTemplateMatch = (await dispatchPost(search, viewer, {body: {query: 'fixture-water'}})).payload
  assert.deepEqual(configuredTemplateMatch.rows.map((row: any) => row.id), ['A'], 'company search uses the original active templates')
  assert.doesNotMatch(JSON.stringify(configuredTemplateMatch), /fixture-water|BPAY-REF|123456|account_number/)
  queryCalls.length = 0
  const configuredMatch = (await dispatchPost(search, viewer, {body: {query: 'configured-123'}})).payload
  assert.deepEqual(configuredMatch.rows, [], 'legacy independent detail columns are not a company-payment source')
  configured = [{property_id: 'A', category: 'water', status: 'pending', vendor: null, account_number: null, cycle_months: null, due_date: null}]
  const override = (await dispatch('/', writer)).payload
  assert.equal(override.can_edit, true)
  assert.deepEqual(override.rows[1].bills, {}, 'new property starts unregistered')
  assert.deepEqual(override.rows[0].bills.water, {source: 'configured', status: 'pending', template_count: 3, active_template_count: 2})
  queryCalls.length = 0
  assert.equal((await dispatchPost(post, writer, {params, body: {status: 'company', due_date: '2026-02-30'}})).status, 400)
  assert.equal((await dispatchPost(post, writer, {params: {...params, category: 'unsupported'}, body: {status: 'company'}})).status, 400)
  assert.equal((await dispatchPost(post, writer, {params, body: {status: 'company', amount: 100}})).status, 400)
  assert.equal(queryCalls.length, 0)
  assert.equal((await dispatchPost(post, writer, {params, body: {status: 'owner', vendor: 'ignore', account_number: 'ignore'}})).status, 400)
  const oldWorkbenchTemplate = {
    id: 'T-owner-registration', property_id: 'A', category: 'water', template_kind: 'property_payable', scope: 'property',
    status: 'active', start_month_key: '2026-11', frequency_months: 1, amount: 125.4, bill_expected_day_of_month: 10,
  }
  const oldWorkbenchSnapshot = {
    id: 'owner-registration-current', fixed_expense_id: oldWorkbenchTemplate.id, month_key: '2026-11',
    property_id: 'A', category: 'water', amount: 125.4, status: 'pending', amount_confirmed: false,
    bill_expected_date: '2026-11-10', bill_received_date: null, due_date: '2026-11-30',
  }
  const oldWorkbenchBeforeOwnerRegistration = buildPropertyPayableWorkbenchMonth(
    [oldWorkbenchTemplate], new Map([[oldWorkbenchTemplate.id, oldWorkbenchSnapshot]]), '2026-11', '2026-11-20', '2026-11-27',
  )
  assert.equal((await dispatchPost(post, writer, {params, body: {status: 'owner'}})).status, 200)
  assert.deepEqual(queryCalls[0].params, ['A', 'water', 'owner', 'fixture-user'])
  assert.match(queryCalls[0].sql, /^INSERT INTO property_bill_configurations[\s\S]*archived[\s\S]*ON CONFLICT \(property_id, category\)/)
  assert.doesNotMatch(queryCalls[0].sql, /(?:UPDATE|DELETE|INSERT\s+INTO)\s+(?:recurring_payments|property_expenses)/i)
  assert.doesNotMatch(queryCalls[0].sql, /report|statement|settlement/i)
  assert.match(queryCalls[0].sql, /EXCLUDED\.status = 'company'[\s\S]*property_bill_configurations\.account_number/)
  assert.equal(queryCalls.length, 1)
  assert.deepEqual(
    buildPropertyPayableWorkbenchMonth([oldWorkbenchTemplate], new Map([[oldWorkbenchTemplate.id, oldWorkbenchSnapshot]]), '2026-11', '2026-11-20', '2026-11-27'),
    oldWorkbenchBeforeOwnerRegistration,
    'owner registration leaves the old pending workbench behavior unchanged',
  )
  assert.equal((await dispatchPost(post, writer, {params, body: {status: 'company'}})).status, 200)
  assert.deepEqual(queryCalls[1].params, ['A', 'water', 'company', 'fixture-user'])
  assert.equal(JSON.stringify(linkedLegacyFixture), linkedLegacyBaseline, 'payer registration leaves past paid, current unpaid and future paid linked rows unchanged')

  const displayNameSnapshots = JSON.parse(JSON.stringify(linkedLegacyFixture.snapshots))
  const displayNameSnapshotsBaseline = JSON.stringify(displayNameSnapshots)
  actionTemplate = {
    id: 'T-other-aircon', property_id: 'A', category: 'other', template_kind: 'property_payable', scope: 'property',
    status: 'active', start_month_key: '2026-09', frequency_months: 3, amount: 88,
    category_detail: 'report-semantic-detail', vendor: 'Fixture Supplier', bill_account_no: 'ACCOUNT-ORIGINAL',
    updated_by: 'fixture-previous-actor', updated_at: '2026-10-01T00:00:00.000Z',
  }
  const displayNameTemplateBaseline = JSON.stringify(actionTemplate)
  const templateWithoutOtherBillName = (template: any) => {
    const {other_bill_name: _name, ...rest} = template
    return rest
  }
  actionDisplayNames.clear()
  actionQueryCalls.length = 0
  const displayNameParams = {propertyId: 'A', category: 'other', templateId: 'T-other-aircon'}
  assert.equal((await dispatchPatch(displayNameTemplate, viewer, {params: displayNameParams, body: {name: '空调使用费'}})).status, 403)
  assert.equal(actionQueryCalls.length, 0, 'name-only permission is checked before acquiring a template lock')
  assert.equal((await dispatchPatch(displayNameTemplate, writer, {params: {...displayNameParams, category: 'water'}, body: {name: '空调使用费'}})).status, 400)
  assert.equal((await dispatchPatch(displayNameTemplate, writer, {params: displayNameParams, body: {name: '   '}})).status, 400)
  assert.equal((await dispatchPatch(displayNameTemplate, writer, {params: displayNameParams, body: {name: '空调', unexpected: true}})).status, 400)
  assert.equal(actionQueryCalls.length, 0, 'invalid category/body never reaches persistence')
  assert.equal((await dispatchPatch(displayNameTemplate, writer, {params: {...displayNameParams, propertyId: 'B'}, body: {name: '空调使用费'}})).status, 404)
  assert.equal(actionDisplayNames.size, 0, 'cross-property name update fails closed')
  actionQueryCalls.length = 0
  const named = await dispatchPatch(displayNameTemplate, writer, {params: displayNameParams, body: {name: '  空调使用费  '}})
  assert.deepEqual(named, {status: 200, payload: {ok: true, name: '空调使用费'}})
  assert.deepEqual(auditCalls.at(-1)?.slice(0, 5), [
    'PropertyBillTemplateDisplayName', 'T-other-aircon', 'update',
    {other_bill_name: null}, {other_bill_name: '空调使用费'},
  ], 'name-only audit excludes account, supplier and unrelated template fields')
  assert.equal(actionDisplayNames.get('T-other-aircon'), '空调使用费')
  assert.equal(actionTemplate.other_bill_name, '空调使用费')
  assert.equal(JSON.stringify(templateWithoutOtherBillName(actionTemplate)), displayNameTemplateBaseline, 'name-only save changes no recurring_payments field except other_bill_name')
  assert.equal(JSON.stringify(displayNameSnapshots), displayNameSnapshotsBaseline, 'name-only save preserves paid, unpaid, out-of-cycle and future snapshot ids/fields')
  assert.ok(actionQueryCalls.some(({sql}) => sql.includes('pg_advisory_xact_lock')), 'name-only save takes the shared single-template advisory lock')
  assert.equal(actionQueryCalls.filter(({sql}) => /^(?:INSERT|UPDATE|DELETE)\s+/i.test(sql.trim())).length, 1)
  const nameUpdate = actionQueryCalls.find(({sql}) => /^UPDATE\s+/i.test(sql.trim()))!
  assert.match(nameUpdate.sql, /^UPDATE recurring_payments\s+SET other_bill_name = \$1/)
  assert.doesNotMatch(nameUpdate.sql, /updated_at|updated_by|category_detail|amount|start_month_key|frequency_months/)
  assert.deepEqual(nameUpdate.params, ['空调使用费', 'T-other-aircon', 'A', 'other'])
  assert.equal(actionQueryCalls.some(({sql}) => /(?:UPDATE|DELETE|INSERT\s+INTO)\s+(?:property_expenses|company_expenses|finance_transactions)/i.test(sql)), false)
  actionQueryCalls.length = 0
  const renamed = await dispatchPatch(displayNameTemplate, writer, {params: displayNameParams, body: {name: '中央空调使用费'}})
  assert.deepEqual(renamed, {status: 200, payload: {ok: true, name: '中央空调使用费'}})
  assert.equal(actionDisplayNames.get('T-other-aircon'), '中央空调使用费')
  const reloadedNameProjection = stripPropertyBillAccounts(projectPropertyBills(
    [{id: 'A', code: 'A-1'}], [], [{...actionTemplate, template_id: actionTemplate.id, template_status: actionTemplate.status}],
  ))
  assert.equal(reloadedNameProjection[0].bills.other.other_items[0].name, '中央空调使用费', 'reloaded list reads other_bill_name from the original template row')
  assert.equal(JSON.stringify(templateWithoutOtherBillName(actionTemplate)), displayNameTemplateBaseline, 'rename and reload leave every other template field byte-for-byte unchanged')
  assert.equal(JSON.stringify(displayNameSnapshots), displayNameSnapshotsBaseline, 'rename and reload leave every linked snapshot id/field unchanged')

  const confirmTemplate = {
    id: 'T-confirm-one-month', property_id: 'A', category: 'water', template_kind: 'property_payable', scope: 'property',
    status: 'active', start_month_key: '2026-10', frequency_months: 1, amount: 90,
    bill_account_no: 'BILL-ACCOUNT-001', payment_type: 'bpay', bpay_code: '123456', pay_ref: 'BPAY-REFERENCE-999',
  }
  const confirmSnapshots = [
    {id: 'snapshot-2026-10', fixed_expense_id: confirmTemplate.id, month_key: '2026-10', property_id: 'A', category: 'water', amount: 80, status: 'paid', due_date: '2026-10-31', paid_date: '2026-10-31', amount_confirmed: true},
    {id: 'snapshot-2026-11', fixed_expense_id: confirmTemplate.id, month_key: '2026-11', property_id: 'A', category: 'water', amount: 90, status: 'pending', due_date: '2026-11-30', bill_received_date: null, note: null, amount_confirmed: false},
    {id: 'snapshot-2026-12', fixed_expense_id: confirmTemplate.id, month_key: '2026-12', property_id: 'A', category: 'water', amount: 100, status: 'pending', due_date: '2026-12-31', bill_received_date: null, amount_confirmed: false},
  ]
  const confirmTemplateBaseline = JSON.stringify(confirmTemplate)
  const unrelatedConfirmMonthsBaseline = JSON.stringify([confirmSnapshots[0], confirmSnapshots[2]])
  const confirmSql: Array<{sql: string; params: any[]}> = []
  const confirmClient = {
    async query(sql: string, params: any[] = []) {
      confirmSql.push({sql, params})
      if (sql.startsWith('SET LOCAL ') || sql.includes('pg_advisory_xact_lock')) return {rows: []}
      if (sql.includes('SELECT * FROM recurring_payments WHERE id = $1 FOR UPDATE')) return {rows: [{...confirmTemplate}]}
      if (sql.includes('SELECT *') && sql.includes('FROM property_expenses') && sql.includes('fixed_expense_id = $1')) {
        const snapshot = confirmSnapshots.find((row) => row.fixed_expense_id === params[0] && row.month_key === params[1])
        return {rows: snapshot ? [{...snapshot}] : []}
      }
      if (sql.includes('UPDATE property_expenses') && sql.includes('amount_confirmed = true')) {
        const index = confirmSnapshots.findIndex((row) => row.id === params[7])
        assert.ok(index >= 0, 'confirm update targets an existing snapshot id')
        const before = confirmSnapshots[index]
        confirmSnapshots[index] = {
          ...before,
          amount: params[0], due_date: params[1], note: params[2], bill_received_date: params[3],
          bill_period_start: params[4], bill_period_end: params[5], status: before.status === 'paid' ? 'paid' : 'unpaid',
          amount_confirmed: true, amount_confirmed_by: params[6], amount_confirmed_at: 'fixture-now',
        }
        return {rows: [{...confirmSnapshots[index]}]}
      }
      throw new Error(`unexpected confirm SQL: ${sql}`)
    },
  }
  transactionClient = confirmClient
  try {
    const confirmed = await dispatchRecurring('/payments/:id/confirm-bill', writer, {
      params: {id: confirmTemplate.id},
      body: {month_key: '2026-11', amount: 132.75, bill_received_date: '2026-11-18', note: 'November actual bill'},
    })
    assert.equal(confirmed.status, 200)
    assert.equal(confirmed.payload.snapshot_id, 'snapshot-2026-11')
    assert.equal(confirmSnapshots[1].amount, 132.75)
    assert.equal(confirmSnapshots[1].bill_received_date, '2026-11-18')
    assert.equal(confirmSnapshots[1].due_date, '2026-11-30', 'single-month confirmation keeps the internal month-end settlement cutoff')
    assert.equal(confirmSnapshots[1].amount_confirmed, true)
    assert.equal(JSON.stringify([confirmSnapshots[0], confirmSnapshots[2]]), unrelatedConfirmMonthsBaseline, 'single-month confirmation leaves other paid/unpaid months untouched')
    assert.equal(JSON.stringify(confirmTemplate), confirmTemplateBaseline, 'single-month confirmation never writes actual values back to template defaults')
    const updateStatements = confirmSql.filter(({sql}) => /^UPDATE\s+/i.test(sql.trim()))
    assert.equal(updateStatements.length, 1)
    assert.match(updateStatements[0].sql, /^UPDATE property_expenses/)
    assert.doesNotMatch(updateStatements.map(({sql}) => sql).join('\n'), /recurring_payments|report|statement|settlement/i)
  } finally {
    transactionClient = actionClient
  }
  exists = false
  assert.equal((await dispatchPost(post, writer, {params, body: {status: 'owner'}})).status, 404)
  queryCalls.length = 0
  assert.deepEqual((await dispatch(history, viewer, {params})).payload, {rows: [{date: '2026-06-01', status: 'paid', amount: 125.4}]})
  assert.equal(queryCalls.length, 1)
  assert.match(queryCalls[0].sql, /^SELECT[\s\S]*e.fixed_expense_id AND r.property_id = e.property_id[\s\S]*p.id = \$1 AND e.category = \$2/)
  assert.match(queryCalls[0].sql, /e\.generated_from[\s\S]*e\.amount_confirmed[\s\S]*e\.bill_received_date[\s\S]*e\.paid_date/)
  assert.match(queryCalls[0].sql, /e\.deleted_at IS NULL/)
  assert.match(queryCalls[0].sql, /COALESCE\(to_jsonb\(r\)->>'cashflow_type', 'expense'\) = 'expense'/)
  actionTemplate = {id: 'T-water', property_id: 'A', category: 'water', template_kind: 'property_payable', scope: 'property', status: 'active', start_month_key: '2026-01', frequency_months: 3}
  const sameCategorySibling = {id: 'T-water-sibling', property_id: 'A', category: 'water', status: 'active'}
  const siblingBaseline = JSON.stringify(sameCategorySibling)
  actionDependencies = {property_expenses: 3, company_expenses: 0, finance_transactions: 0}
  failDependencyCheck = false
  actionQueryCalls.length = 0
  const templateParams = {propertyId: 'A', category: 'water', templateId: 'T-water'}
  assert.equal((await dispatchPost(stopTemplate, viewer, {params: templateParams})).status, 403)
  assert.equal(actionQueryCalls.length, 0, 'write permission is checked before any template action')
  assert.equal((await dispatchPost(stopTemplate, writer, {params: {...templateParams, propertyId: 'B'}})).status, 404)
  assert.equal(actionTemplate.status, 'active', 'cross-property stop is rejected')
  const stopped = await dispatchPost(stopTemplate, writer, {params: templateParams})
  assert.deepEqual(stopped.payload, {ok: true, stopped: true, already_stopped: false})
  assert.equal(actionTemplate.status, 'paused')
  assert.equal(JSON.stringify(sameCategorySibling), siblingBaseline, 'single-template stop does not alter another template in the same category')
  assert.equal(JSON.stringify(linkedLegacyFixture), linkedLegacyBaseline, 'safe stop preserves past paid, current unpaid and future paid rows')
  assert.equal(actionQueryCalls.some(({sql}) => /DELETE\s+FROM\s+(property_expenses|company_expenses|finance_transactions)/i.test(sql)), false)
  actionQueryCalls.length = 0
  assert.equal((await dispatchPost(resumeTemplate, viewer, {params: templateParams})).status, 403)
  assert.equal(actionQueryCalls.length, 0, 'write permission is checked before resume')
  assert.equal((await dispatchPost(resumeTemplate, writer, {params: {...templateParams, propertyId: 'B'}})).status, 404)
  assert.equal(actionTemplate.status, 'paused', 'cross-property resume is rejected')
  for (const invalidFrequency of [undefined, 0, 1.5, 25, 'not-a-number']) {
    actionTemplate = {...actionTemplate, status: 'paused', start_month_key: '2026-01', frequency_months: invalidFrequency}
    actionQueryCalls.length = 0
    const rejectedResume = await dispatchPost(resumeTemplate, writer, {params: templateParams})
    assert.equal(rejectedResume.status, 409)
    assert.equal(rejectedResume.payload.code, 'template_resume_schedule_unavailable')
    assert.equal(actionTemplate.status, 'paused', `invalid frequency ${String(invalidFrequency)} remains paused`)
    assert.equal(actionQueryCalls.some(({sql}) => sql.includes("SET status = 'active'")), false)
    assert.equal(nextPropertyPayableDueMonthAfter({start_month_key: '2026-01', frequency_months: invalidFrequency}, '2026-11'), '')
    assert.equal(isPropertyPayableMonthDue({start_month_key: '2026-01', frequency_months: invalidFrequency}, '2026-12'), false)
  }
  actionTemplate = {...actionTemplate, status: 'paused', start_month_key: '2026-01', frequency_months: 3}
  const currentParts = new Intl.DateTimeFormat('en-AU', {timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit'}).formatToParts(new Date())
  const currentMonthKey = `${currentParts.find((part) => part.type === 'year')?.value}-${currentParts.find((part) => part.type === 'month')?.value}`
  const resumed = await dispatchPost(resumeTemplate, writer, {params: templateParams})
  assert.equal(resumed.status, 200)
  assert.equal(resumed.payload.already_active, false)
  assert.equal(resumed.payload.resume_from_month_key, nextPropertyPayableDueMonthAfter({start_month_key: '2026-01', frequency_months: 3}, currentMonthKey))
  assert.ok(resumed.payload.resume_from_month_key > currentMonthKey, 'safe resume starts strictly after the current paused month')
  assert.equal(isPropertyPayableMonthDue({start_month_key: '2026-01', frequency_months: 3}, resumed.payload.resume_from_month_key), true, 'safe resume keeps the original cycle phase')
  assert.equal(actionTemplate.status, 'active')
  assert.equal(actionTemplate.start_month_key, resumed.payload.resume_from_month_key)
  assert.equal(JSON.stringify(sameCategorySibling), siblingBaseline, 'single-template resume leaves same-category siblings unchanged')
  assert.equal(JSON.stringify(linkedLegacyFixture), linkedLegacyBaseline, 'safe resume preserves past paid, current unpaid and future paid rows')
  assert.equal(actionQueryCalls.some(({sql}) => /(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+)?(?:property_expenses|company_expenses|finance_transactions)/i.test(sql)), false)
  const resumeStart = actionTemplate.start_month_key
  const alreadyResumed = await dispatchPost(resumeTemplate, writer, {params: templateParams})
  assert.equal(alreadyResumed.status, 200)
  assert.equal(alreadyResumed.payload.already_active, true)
  assert.equal(actionTemplate.start_month_key, resumeStart, 'idempotent resume does not advance the schedule twice')
  const resumedTemplate = {...actionTemplate}
  const scheduleClient = (snapshot: any) => ({
    writes: 0,
    async query(sql: string) {
      if (sql.includes('pg_advisory_xact_lock')) return {rows: []}
      if (sql.includes('SELECT * FROM recurring_payments')) return {rows: [resumedTemplate]}
      if (sql.includes('FROM property_expenses')) return {rows: snapshot ? [snapshot] : []}
      this.writes += 1
      throw new Error(`unexpected resumed schedule SQL: ${sql}`)
    },
  })
  await assert.rejects(
    () => ensurePropertyPayableSnapshotTx(scheduleClient(null), resumedTemplate, currentMonthKey, 'fixture-user'),
    /property_payable_period_not_due/,
  )
  const retainedPausedPeriod = {id: 'existing-paused-period', fixed_expense_id: resumedTemplate.id, month_key: currentMonthKey, property_id: 'A', category: 'water', status: 'paid'}
  const retainedScheduleClient = scheduleClient(retainedPausedPeriod)
  assert.equal((await ensurePropertyPayableSnapshotTx(retainedScheduleClient, resumedTemplate, currentMonthKey, 'fixture-user')).id, retainedPausedPeriod.id)
  assert.equal(retainedScheduleClient.writes, 0, 'existing history remains readable without rewrite after resume')
  await assert.rejects(
    () => assertRecurringReferenceWriteTx(scheduleClient(null), 'property_expenses', null, {
      fixed_expense_id: resumedTemplate.id, month_key: currentMonthKey, property_id: 'A', category: 'water',
    }),
    /property_payable_period_not_due/,
  )
  assert.equal(buildPropertyPayableWorkbenchMonth([resumedTemplate], new Map(), currentMonthKey, `${currentMonthKey}-15`, `${currentMonthKey}-20`).rows.length, 0, 'workbench does not virtualize a missed paused month after resume')
  assert.equal(buildPropertyPayableWorkbenchMonth([resumedTemplate], new Map([[resumedTemplate.id, retainedPausedPeriod]]), currentMonthKey, `${currentMonthKey}-15`, `${currentMonthKey}-20`).rows.length, 1, 'workbench keeps an existing historical snapshot visible')
  assert.equal(buildPropertyPayableWorkbenchMonth([resumedTemplate], new Map(), resumeStart, `${currentMonthKey}-15`, `${currentMonthKey}-20`).rows.length, 1, 'workbench resumes on the next original due month')
  assert.equal(propertyPayableMelbourneMonthKey(new Date('2026-11-30T12:59:59Z')), '2026-11')
  assert.equal(propertyPayableMelbourneMonthKey(new Date('2026-11-30T13:00:00Z')), '2026-12')
  const beforeMidnightResume = await runTimedResume('2026-11-30T12:59:59Z', '2026-11-30T12:59:59Z')
  assert.equal(beforeMidnightResume.resumeFromMonthKey, '2026-12', 'quarterly cycle resumes in December before Melbourne midnight')
  const crossedMidnightResume = await runTimedResume('2026-11-30T12:59:59Z', '2026-11-30T13:00:00Z')
  assert.equal(crossedMidnightResume.resumeFromMonthKey, '2027-03', 'lock wait crossing Melbourne midnight samples the post-lock month')
  actionQueryCalls.length = 0
  const blockedDelete = await dispatchDelete(deleteTemplate, writer, {params: templateParams})
  assert.equal(blockedDelete.status, 409)
  assert.equal(blockedDelete.payload.code, 'template_has_linked_records')
  assert.ok(actionTemplate, 'linked template remains after refused delete')
  failDependencyCheck = true
  const unknownDelete = await dispatchDelete(deleteTemplate, writer, {params: templateParams})
  assert.equal(unknownDelete.status, 409)
  assert.equal(unknownDelete.payload.code, 'template_dependency_check_failed')
  assert.ok(actionTemplate, 'unknown dependency state fails closed')
  failDependencyCheck = false
  actionDependencies = {property_expenses: 0, company_expenses: 0, finance_transactions: 0}
  const unverifiableDelete = await dispatchDelete(deleteTemplate, writer, {params: templateParams})
  assert.equal(unverifiableDelete.status, 409)
  assert.equal(unverifiableDelete.payload.code, 'template_link_history_unverifiable')
  assert.ok(actionTemplate, 'current zero rows do not prove the template was never linked')
  assert.ok(actionQueryCalls.some(({sql}) => sql.includes('pg_advisory_xact_lock')))
  assert.equal(actionQueryCalls.some(({sql}) => /DELETE FROM recurring_payments/.test(sql)), false)
  const deleteFirstRace = await runCreatorDeleteRace(false)
  assert.equal(deleteFirstRace.deleteResult.status, 'fulfilled')
  assert.equal((deleteFirstRace.deleteResult as PromiseFulfilledResult<any>).value.historyUnverifiable, true)
  assert.equal(deleteFirstRace.createResult.status, 'fulfilled')
  assert.equal(deleteFirstRace.state.propertyExpenses.length, 1, 'refused delete leaves the template available to the serialized creator')
  assert.ok(deleteFirstRace.state.template)
  const createFirstRace = await runCreatorDeleteRace(true)
  assert.equal(createFirstRace.createResult.status, 'fulfilled')
  assert.equal(createFirstRace.state.propertyExpenses.length, 1)
  assert.equal(createFirstRace.deleteResult.status, 'fulfilled')
  assert.equal((createFirstRace.deleteResult as PromiseFulfilledResult<any>).value.blocked, true, 'creator-first race makes delete fail closed')
  assert.ok(createFirstRace.state.template)
  assert.equal(shouldMaterializePropertyPayableTemplate({status: 'paused'}, null), false, 'paused template has no virtual missing-period row')
  assert.equal(shouldMaterializePropertyPayableTemplate({status: 'paused'}, {id: 'existing'}), true, 'paused template keeps generated rows visible')
  assert.equal(shouldMaterializePropertyPayableTemplate({status: 'active'}, null), true)
  brokenSchema = true
  assert.equal((await dispatch('/', viewer)).status, 503)
  const migration = fs.readFileSync(path.join(__dirname, '../migrations/20261120_mz128_property_bill_configurations.sql'), 'utf8')
  assert.match(migration, /PRIMARY KEY \(property_id, category\)/)
  assert.doesNotMatch(migration, /ALTER TABLE|UPDATE\s+recurring_payments|INSERT INTO\s+property_expenses/)
  const displayNameMigration = fs.readFileSync(path.join(__dirname, '../migrations/20261120_mz128_recurring_payment_other_bill_name.sql'), 'utf8')
  assert.match(displayNameMigration, /ALTER TABLE recurring_payments\s+ADD COLUMN IF NOT EXISTS other_bill_name text/)
  assert.match(displayNameMigration, /20261120_mz128_recurring_payment_other_bill_name/)
  assert.doesNotMatch(displayNameMigration, /CREATE TABLE|DEFAULT|NOT NULL|UPDATE\s+recurring_payments|INSERT INTO\s+(?:property_expenses|company_expenses|finance_transactions)/)
  const page = fs.readFileSync(path.join(__dirname, '../../../frontend/src/app/finance/property-payables/page.tsx'), 'utf8')
  const propertyBills = fs.readFileSync(path.join(__dirname, '../../../frontend/src/app/finance/property-payables/PropertyBills.tsx'), 'utf8')
  const vendorInput = fs.readFileSync(path.join(__dirname, '../../../frontend/src/components/PropertyPayableVendorInput.tsx'), 'utf8')
  assert.match(page, /extra=\{\s*<div className="property-payables-header-actions">/)
  assert.match(page, /<div className="property-payables-metrics">/)
  const primaryTabs = page.match(/<Segmented[\s\S]*?options=\{\[([\s\S]*?)\]\}/)?.[1] || ''
  assert.match(primaryTabs, /待处理'[\s\S]*日历'[\s\S]*已付记录'[\s\S]*房源账单'/)
  assert.doesNotMatch(primaryTabs, /模板管理/)
  assert.match(page, /new URLSearchParams\(window\.location\.search\)\.get\('view'\) === 'templates'/)
  assert.match(page, /activeView === 'templates'[\s\S]*模板管理（兼容入口）[\s\S]*返回房源账单/)
  assert.doesNotMatch(page, /activeView !== 'property-bills' \? <div className="property-payables-(?:header-actions|metrics)"/)
  assert.match(propertyBills, /postJSON<Directory>\(\`\$\{endpoint\}\/search\`, \{query: submittedQuery\}\)/)
  assert.match(propertyBills, /sortPropertiesByRegionThenCode\(directory\?\.rows \|\| \[\]\)/)
  assert.match(propertyBills, /顶部月份、房源与代付状态筛选用于其他代付标签；房源账单始终查询全部有效房源/)
  assert.match(propertyBills, /没有匹配的房源账单/)
  assert.match(propertyBills, /style=\{\{ width: 300, maxWidth: '100%' \}\}/)
  assert.match(propertyBills, /justifyContent: 'flex-end'[\s\S]*width: 300, maxWidth: '100%'/)
  assert.match(propertyBills, /scroll=\{\{ x: 1160 \}\} tableLayout="fixed"[\s\S]*onRow=\{\(\) => \(\{ style: \{ height: 56 \} \}\)\}/)
  assert.match(propertyBills, /title: '房号'[\s\S]*title: '登记状态'[\s\S]*BILL_COLUMNS\.map[\s\S]*title: '操作'/)
  assert.match(propertyBills, /title: '房号'[\s\S]*\{propertyLabel\(row\)\}<\/strong>/)
  assert.doesNotMatch(propertyBills, /propertyDisplay|selected\.row\.address/)
  assert.match(propertyBills, /title: '操作'[\s\S]*<Button onClick=\{\(\) => open\(row, firstCategory\(\)\)\}>管理<\/Button>/)
  assert.doesNotMatch(propertyBills, /开始登记/)
  assert.match(propertyBills, /\['other', '其他账单'\]/)
  assert.match(propertyBills, /if \(category === 'other'\) return renderOtherBills\(row\)/)
  assert.match(propertyBills, /otherBillName[\s\S]*未命名[\s\S]*otherBillStatus/)
  assert.match(propertyBills, /whiteSpace: 'nowrap'[\s\S]*textOverflow: 'ellipsis'/)
  assert.match(propertyBills, /trigger="click"[\s\S]*查看其余 \$\{remaining\.length\} 项其他账单/)
  assert.match(propertyBills, /类别登记：\$\{statusLabels\[bill\.registration_status\]\}（未套用到各模板）/)
  assert.match(propertyBills, /\{registrationNote \? <Popover[\s\S]*类别登记说明[\s\S]*<\/Popover> : null\}\s*\{remaining\.length \? <Popover/, 'single-template rows keep a separate category-registration affordance')
  assert.match(propertyBills, /role="tablist" aria-label="费用分类"/)
  assert.match(propertyBills, /const historyRequest = useRef\(0\)[\s\S]*const requestId = \+\+historyRequest\.current[\s\S]*historyRequest\.current === requestId/, 'history responses are scoped to the current property/category request')
  assert.match(propertyBills, /role="tab" aria-selected=\{selected\.category === category\} disabled=\{disabled\}/, 'category switching is disabled while detail or history data is in flight')
  assert.match(propertyBills, /open\(row, firstCategory\(\)\)/)
  assert.match(propertyBills, /postJSON\(categoryPath\(selected\.row\.id, selected\.category\), \{ status: values\.status \}\)/)
  assert.doesNotMatch(propertyBills, /模板资料来自原代付模板|同一房源、同一费用分类的模板会逐份列出/)
  assert.match(propertyBills, /selectedTemplates\.map/)
  assert.match(propertyBills, /收费公司\/事项[\s\S]*Account Number[\s\S]*默认金额[\s\S]*账单周期[\s\S]*付款截止日/)
  assert.match(propertyBills, /BPAY Code[\s\S]*付款 Reference/)
  assert.match(propertyBills, /<Descriptions\.Item label="预计收到账单日">\{template\.bill_expected_day_of_month/)
  assert.match(propertyBills, /<Descriptions\.Item label="付款截止日">\{PROPERTY_PAYABLE_SETTLEMENT_DUE_LABEL\}<\/Descriptions\.Item>/)
  assert.match(propertyBills, /<Descriptions\.Item label="Account Number">\{template\.account_number/)
  assert.match(propertyBills, /<Descriptions\.Item label="付款 Reference">\{template\.pay_ref/)
  assert.doesNotMatch(propertyBills, /供应商到期日|Account Number">\{template\.pay_ref/)
  assert.match(propertyBills, /仍有.*启用中的代付模板[\s\S]*不会暂停、删除或修改这些模板/)
  assert.match(propertyBills, /尚未关联启用中的代付模板[\s\S]*系统不会自动创建模板/)
  assert.doesNotMatch(propertyBills, /name="(?:vendor|account_number|cycle_months|due_date)"/)
  assert.match(propertyBills, /onViewTemplate\?\.[\s\S]*onEditTemplate\?\.[\s\S]*onCreateTemplate\?\./)
  assert.doesNotMatch(propertyBills, /onOpenTemplates|打开原模板管理/)
  assert.match(propertyBills, /停用只阻止以后生成新账单；已经生成的已付和未付账单都会保留/)
  assert.match(propertyBills, /恢复后从下一个原定账期继续，不会补建停用期间漏掉的账单；已有账单保持不变/)
  assert.match(propertyBills, /只有能可靠证明从未关联任何账单、历史或其他记录的模板才能删除；否则系统会拒绝/)
  assert.match(propertyBills, /template_link_history_unverifiable/)
  assert.doesNotMatch(propertyBills, /recurring\/payments\/[\s\S]*(?:pause|resume)/)
  assert.match(propertyBills, /postJSON\(`\$\{path\}\/\$\{action\}`, \{\}\)/)
  assert.match(propertyBills, /deleteJSON\(path\)/)
  assert.match(page, /<PropertyBills[\s\S]*onViewTemplate=\{openPropertyBillTemplateDetail\}[\s\S]*onEditTemplate=\{openPropertyBillTemplateEditor\}/)
  assert.match(page, /\/other\/templates\/\$\{encodeURIComponent\(templateId\)\}\/display-name[\s\S]*method: 'PATCH'[\s\S]*body: JSON\.stringify\(\{ name \}\)/)
  assert.match(page, /saveTemplateDisplayNameOnly[\s\S]*仅保存费用名称/)
  assert.match(page, /watchedTemplateCategory === 'other'[\s\S]*name="other_bill_name" label="费用名称"/)
  assert.doesNotMatch(page.match(/const body = \{[\s\S]*?\n    \}/)?.[0] || '', /other_bill_name/, 'generic template PATCH/POST body never receives the display-only name')
  assert.match(page, /detailMode === 'template'[\s\S]*只查看并沿用原代付模板资料，不提供付款、账单确认、暂停或删除操作/)
  assert.match(page, /disabled=\{Boolean\(templateContext\)\}/)
  assert.match(page, /保存或取消后会返回当前房源与费用分类并刷新模板资料/)
  assert.match(propertyBills, /footer=\{<div[\s\S]*查看历史记录[\s\S]*保存配置/)
  const recurring = fs.readFileSync(path.join(__dirname, '../../src/modules/recurring.ts'), 'utf8')
  const crud = fs.readFileSync(path.join(__dirname, '../../src/modules/crud.ts'), 'utf8')
  const finance = fs.readFileSync(path.join(__dirname, '../../src/modules/finance.ts'), 'utf8')
  const properties = fs.readFileSync(path.join(__dirname, '../../src/modules/properties.ts'), 'utf8')
  const annualReport = fs.readFileSync(path.join(__dirname, '../../src/lib/annualPropertyReport.ts'), 'utf8')
  const companyReport = fs.readFileSync(path.join(__dirname, '../../src/lib/companyRevenueReport.ts'), 'utf8')
  assert.doesNotMatch(recurring, /\bother_bill_name\b/, 'future generation, generic create/update and snapshot flows do not consume or overwrite the display title')
  assert.doesNotMatch(crud, /\bother_bill_name\b/, 'generic CRUD serialization does not accept the display title')
  assert.doesNotMatch(properties, /\bother_bill_name\b/, 'property-level template synchronization does not copy or overwrite the display title')
  assert.doesNotMatch(finance, /\bother_bill_name\b/, 'finance classification does not consume the display title')
  assert.doesNotMatch(annualReport, /\bother_bill_name\b/)
  assert.doesNotMatch(companyReport, /\bother_bill_name\b/)
  assert.match(recurring, /if \(existing\) return \{ \.\.\.existing, inserted: false \}[\s\S]*if \(!isRecurringTemplateActive\(current\)\) throw recurringTemplateSafetyError\('property_payable_template_inactive'\)/)
  assert.match(recurring, /!isPropertyPayableMonthDue\(current, monthKey\)[\s\S]*property_payable_period_not_due/)
  assert.match(recurring, /assertPropertyPayableSnapshotBinding\(current, existing\)/)
  assert.ok((recurring.match(/ensurePropertyPayableSnapshotTx\(client, payment, monthKey/g) || []).length >= 4)
  assert.ok((recurring.match(/property_payable_template_binding_mismatch'\) return res\.status\(409\)/g) || []).length >= 4)
  assert.match(recurring, /shouldMaterializePropertyPayableTemplate\(tpl, snapshot\)/)
  assert.match(crud, /assertRecurringReferenceWriteTx\(client, resource as any, previous, \{ \.\.\.previous, \.\.\.toInsert \}\)/)
  assert.doesNotMatch(propertyBills, /payable_templates|endpoint\s*=\s*['"]\/properties|(?:getJSON|postJSON)\([^)]*['"]\/properties/, 'property bills do not fall back to the property-management write/read endpoints')
  assert.match(vendorInput, /管理下拉选项[\s\S]*管理收费公司建议项/)
  assert.match(vendorInput, /仅隐藏当前浏览器中的建议项，不会删除或修改模板、账单、历史及已保存值，也不会同步到其他浏览器或用户/)
  assert.match(vendorInput, /hiddenVendorListeners\.add\(setHiddenKeys\)[\s\S]*if \(hiddenVendorKeysCache !== null\)/, 'the current field subscribes before loading a persisted hidden suggestion')
  assert.match(vendorInput, /value=\{props\.value \|\| undefined\}/)
  assert.match(vendorInput, /visiblePropertyPayableVendorOptions\(allOptions, hiddenKeys\)/)
  assert.doesNotMatch(vendorInput, /postJSON|deleteJSON|patchJSON|recurring\/payments/)
  console.log('property bills: recurring-template-column-only other-bill name create/rename/reload isolation, redacted name-only audit, paid/unpaid/out-of-cycle snapshot preservation, generation/report non-consumption, local vendor suggestion hide/restore/reload isolation, one-month bill confirmation isolation, owner-registration non-mutation, template field-source semantics, safe stop/resume without paused-period backfill, post-lock Melbourne month sampling across midnight, delete fail-closed without immutable never-linked proof, retained generated rows, due-period-only materialization, sibling isolation, dependency fail-closed, creator/delete lock races, existing snapshot binding protection, exact binding/permission, all-template details, secure search/redaction, compact layout, persistent controls and migration contracts passed')
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
