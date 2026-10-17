import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  defaultStayServices,
  emptyPolicyContent,
  policySectionReadiness,
  resolveEffectivePolicy,
} from '../../src/lib/guestSiteStayPolicy'
import {
  GuestSitePolicyConflict,
  GuestSitePolicyValidationError,
  buildCompanyPolicyImpact,
  bulkSetPropertyPoliciesToFollow,
  getCompanyPolicyImpact,
  publishCompanyPolicy,
  publishPropertyOverride,
  savePolicyDraft,
  setPropertyPolicyMode,
  type PolicyQueryable,
  type PolicyVersionRow,
} from '../../src/lib/guestSiteStayPolicyStore'

const migration = fs.readFileSync(path.resolve(__dirname, '../migrations/20261003_guest_site_stay_policies.sql'), 'utf8')
const moduleSource = fs.readFileSync(path.resolve(__dirname, '../../src/modules/guest_site.ts'), 'utf8')
const storeSource = fs.readFileSync(path.resolve(__dirname, '../../src/store.ts'), 'utf8')
const permissionSource = fs.readFileSync(path.resolve(__dirname, '../../src/permissionsCatalog.ts'), 'utf8')

const publishedCompany: PolicyVersionRow = {
  id: 'company-published-1',
  scope_type: 'company',
  property_id: null,
  section: 'house_rules',
  status: 'published',
  revision: 1,
  content: { items: ['No smoking'] },
  supersedes_id: null,
  created_at: '2026-10-03T00:00:00.000Z',
  created_by: 'editor-1',
  updated_at: '2026-10-03T00:00:00.000Z',
  updated_by: 'publisher-1',
  published_at: '2026-10-03T00:00:00.000Z',
  published_by: 'publisher-1',
}

const companyDraft: PolicyVersionRow = {
  ...publishedCompany,
  id: 'company-draft-2',
  status: 'draft',
  revision: 2,
  content: { items: ['No smoking', 'Quiet hours after 10PM'] },
  supersedes_id: publishedCompany.id,
  published_at: null,
  published_by: null,
}

function dbRow(version: PolicyVersionRow) {
  return { ...version }
}

function impactRows() {
  return [
    {
      property_id: 'property-follow',
      property_code: 'MZ-101',
      property_title: 'Docklands stay',
      is_published: true,
      mode: 'follow_company',
      mode_revision: 3,
      legacy_house_rules: ['Legacy follow rule'],
      legacy_checkin_time: '4PM',
      legacy_checkout_time: '11AM',
      override_content: null,
      override_revision: 0,
    },
    {
      property_id: 'property-legacy',
      property_code: 'MZ-102',
      property_title: 'South Melbourne stay',
      is_published: true,
      mode: 'legacy',
      mode_revision: 1,
      legacy_house_rules: ['Keep the legacy rule'],
      legacy_checkin_time: '4PM',
      legacy_checkout_time: '11AM',
      override_content: null,
      override_revision: 0,
    },
    {
      property_id: 'property-override',
      property_code: 'MZ-103',
      property_title: 'CBD stay',
      is_published: false,
      mode: 'override',
      mode_revision: 4,
      legacy_house_rules: ['Legacy override rule'],
      legacy_checkin_time: '4PM',
      legacy_checkout_time: '11AM',
      override_content: { items: ['Property-specific rule'] },
      override_revision: 7,
    },
  ]
}

function makeImpactDb() {
  const calls: Array<{ sql: string; params: any[] }> = []
  const db: PolicyQueryable = {
    async query(sql: string, params: any[] = []) {
      calls.push({ sql, params })
      if (/FROM guest_site_stay_policy_versions/.test(sql) && /status=\$4/.test(sql)) {
        if (params[3] === 'draft') return { rows: [dbRow(companyDraft)], rowCount: 1 }
        if (params[3] === 'published') return { rows: [dbRow(publishedCompany)], rowCount: 1 }
      }
      if (/FROM guest_site_property_displays d/.test(sql)) return { rows: impactRows(), rowCount: 3 }
      return { rows: [], rowCount: 0 }
    },
  }
  return { db, calls }
}

function makeTransactionalPool(handler: (sql: string, params: any[]) => Promise<any>) {
  const calls: Array<{ sql: string; params: any[] }> = []
  let released = 0
  const client = {
    async query(sql: string, params: any[] = []) {
      calls.push({ sql, params })
      return handler(sql, params)
    },
    release() { released += 1 },
  }
  return {
    pool: {
      query: client.query,
      async connect() { return client },
    },
    calls,
    released: () => released,
  }
}

async function testPureRules() {
  assert.deepEqual(policySectionReadiness('house_rules', { items: ['No parties'] }, 'company').issues, [])
  assert.equal(policySectionReadiness('cancellation_policy', { body: '' }, 'company').ready, false)
  assert.equal(policySectionReadiness('stay_times', { checkin_time: '3PM', checkout_time: '10AM' }, 'company').ready, true)
  assert.equal(policySectionReadiness('stay_services', { services: defaultStayServices() }, 'company').ready, true)
  assert.equal(policySectionReadiness('stay_services', emptyPolicyContent('stay_services'), 'company').ready, true,
    'an empty cancellation draft must not block the independent stay-services section')

  const inherited = resolveEffectivePolicy({
    legacy: { house_rules: ['Legacy'], checkin_time: '4PM', checkout_time: '11AM' },
    modes: { house_rules: 'follow_company', cancellation_policy: 'legacy', stay_times: 'legacy', stay_services: 'legacy' },
    company: { house_rules: { items: ['Company rule'] } },
  })
  assert.deepEqual(inherited.house_rules, ['Company rule'])
  assert.equal(inherited.checkin_time, '4PM')
  assert.equal(inherited.cancellation_policy, '')

  const override = resolveEffectivePolicy({
    legacy: { house_rules: ['Legacy'] },
    modes: { house_rules: 'override' },
    company: { house_rules: { items: ['Company rule'] } },
    overrides: { house_rules: { items: ['Property rule'] } },
  })
  assert.deepEqual(override.house_rules, ['Property rule'])
  assert.equal(override.section_sources.house_rules, 'override')

  const missingOverride = resolveEffectivePolicy({
    legacy: { house_rules: ['Legacy'] },
    modes: { house_rules: 'override' },
    company: { house_rules: { items: ['Company rule'] } },
  })
  assert.deepEqual(missingOverride.house_rules, [], 'a broken override must not silently fall back to company or legacy content')
  assert.equal(missingOverride.section_sources.house_rules, 'override_unpublished')

  const impact = buildCompanyPolicyImpact({
    section: 'house_rules',
    draft: companyDraft,
    published: publishedCompany,
    properties: impactRows() as any,
  })
  assert.equal(impact.changed_count, 1)
  assert.equal(impact.properties.find((row) => row.property_id === 'property-follow')?.changed, true)
  assert.equal(impact.properties.find((row) => row.property_id === 'property-legacy')?.changed, false)
  assert.equal(impact.properties.find((row) => row.property_id === 'property-override')?.changed, false)
  assert.match(impact.impact_hash, /^[a-f0-9]{64}$/)
  const changedModeRevision = buildCompanyPolicyImpact({
    section: 'house_rules', draft: companyDraft, published: publishedCompany,
    properties: impactRows().map((row) => row.property_id === 'property-follow' ? { ...row, mode_revision: 4 } : row) as any,
  })
  assert.notEqual(changedModeRevision.impact_hash, impact.impact_hash, 'mode revision changes must invalidate a reviewed impact hash')
  const changedVisibility = buildCompanyPolicyImpact({
    section: 'house_rules', draft: companyDraft, published: publishedCompany,
    properties: impactRows().map((row) => row.property_id === 'property-follow' ? { ...row, is_published: false } : row) as any,
  })
  assert.notEqual(changedVisibility.impact_hash, impact.impact_hash, 'public visibility changes must invalidate a reviewed impact hash')
}

async function testDraftTransactionAndConflict() {
  const savedRow: PolicyVersionRow = {
    ...companyDraft,
    id: 'draft-created',
    revision: 1,
    content: { items: ['No smoking'] },
    supersedes_id: null,
  }
  const ok = makeTransactionalPool(async (sql) => {
    if (/FROM guest_site_stay_policy_versions/.test(sql) && /status=\$4/.test(sql)) return { rows: [], rowCount: 0 }
    if (/MAX\(revision\)/.test(sql)) return { rows: [{ max_revision: 0 }], rowCount: 1 }
    if (/INSERT INTO guest_site_stay_policy_versions/.test(sql)) return { rows: [savedRow], rowCount: 1 }
    return { rows: [], rowCount: 0 }
  })
  const saved = await savePolicyDraft(ok.pool as any, {
    scopeType: 'company', propertyId: null, section: 'house_rules', expectedRevision: 0,
    content: { items: ['No smoking'] }, actorId: 'editor-1',
  })
  assert.equal(saved.draft.id, 'draft-created')
  assert.equal(saved.readiness.ready, true)
  assert(ok.calls.some((call) => call.sql === 'BEGIN'))
  assert(ok.calls.some((call) => call.sql === 'COMMIT'))
  assert(ok.calls.some((call) => /INSERT INTO guest_site_stay_policy_audits/.test(call.sql)))
  assert.equal(ok.released(), 1)

  const conflict = makeTransactionalPool(async (sql, params) => {
    if (/FROM guest_site_stay_policy_versions/.test(sql) && /status=\$4/.test(sql) && params[3] === 'draft') {
      return { rows: [{ ...companyDraft, revision: 5 }], rowCount: 1 }
    }
    return { rows: [], rowCount: 0 }
  })
  await assert.rejects(
    savePolicyDraft(conflict.pool as any, {
      scopeType: 'company', propertyId: null, section: 'house_rules', expectedRevision: 4,
      content: { items: ['Changed'] }, actorId: 'editor-1',
    }),
    (error: any) => error instanceof GuestSitePolicyConflict && error.code === 'policy_revision_conflict',
  )
  assert(conflict.calls.some((call) => call.sql === 'ROLLBACK'))
  assert.equal(conflict.calls.some((call) => /INSERT INTO guest_site_stay_policy_audits/.test(call.sql)), false)
}

async function testImpactAndPublishTransactions() {
  const impactDb = makeImpactDb()
  const impact = await getCompanyPolicyImpact(impactDb.db, 'house_rules', companyDraft.revision)
  assert.equal(impact.changed_count, 1)

  const publish = makeTransactionalPool(async (sql, params) => {
    if (/FROM guest_site_stay_policy_versions/.test(sql) && /status=\$4/.test(sql)) {
      if (params[3] === 'draft') return { rows: [dbRow(companyDraft)], rowCount: 1 }
      if (params[3] === 'published') return { rows: [dbRow(publishedCompany)], rowCount: 1 }
    }
    if (/FROM guest_site_property_displays d/.test(sql)) return { rows: impactRows(), rowCount: 3 }
    if (/SET status='published'/.test(sql)) return { rows: [{ ...companyDraft, status: 'published' }], rowCount: 1 }
    return { rows: [], rowCount: 0 }
  })
  const result = await publishCompanyPolicy(publish.pool as any, {
    section: 'house_rules', expectedRevision: companyDraft.revision, impactHash: impact.impact_hash, actorId: 'publisher-1',
  })
  assert.equal(result.published.status, 'published')
  assert(publish.calls.some((call) => call.sql === 'BEGIN ISOLATION LEVEL SERIALIZABLE'))
  assert(publish.calls.some((call) => /LOCK TABLE properties IN SHARE MODE/.test(call.sql)))
  assert(publish.calls.some((call) => /LOCK TABLE guest_site_property_policy_sections IN SHARE MODE/.test(call.sql)))
  assert(publish.calls.some((call) => /LOCK TABLE guest_site_stay_policy_versions IN SHARE MODE/.test(call.sql)))
  const versionLockIndex = publish.calls.findIndex((call) => /LOCK TABLE guest_site_stay_policy_versions IN SHARE MODE/.test(call.sql))
  const modeLockIndex = publish.calls.findIndex((call) => /LOCK TABLE guest_site_property_policy_sections IN SHARE MODE/.test(call.sql))
  assert(versionLockIndex >= 0 && versionLockIndex < modeLockIndex, 'policy versions must be locked before modes to avoid cross-publish lock inversion')
  assert(publish.calls.some((call) => /SET status='archived'/.test(call.sql)))
  assert(publish.calls.some((call) => /INSERT INTO guest_site_stay_policy_audits/.test(call.sql)))
  assert(publish.calls.some((call) => call.sql === 'COMMIT'))

  const stale = makeTransactionalPool(async (sql, params) => {
    if (/FROM guest_site_stay_policy_versions/.test(sql) && /status=\$4/.test(sql)) {
      if (params[3] === 'draft') return { rows: [dbRow(companyDraft)], rowCount: 1 }
      if (params[3] === 'published') return { rows: [dbRow(publishedCompany)], rowCount: 1 }
    }
    if (/FROM guest_site_property_displays d/.test(sql)) return { rows: impactRows(), rowCount: 3 }
    return { rows: [], rowCount: 0 }
  })
  await assert.rejects(
    publishCompanyPolicy(stale.pool as any, {
      section: 'house_rules', expectedRevision: companyDraft.revision, impactHash: '0'.repeat(64), actorId: 'publisher-1',
    }),
    (error: any) => error instanceof GuestSitePolicyConflict && error.code === 'policy_impact_changed',
  )
  assert(stale.calls.some((call) => call.sql === 'ROLLBACK'))
  assert.equal(stale.calls.some((call) => /SET status='archived'/.test(call.sql)), false, 'stale impact must fail before replacing the current published version')
}

async function testOverrideFailureKeepsPublishedState() {
  const emptyCancellationDraft: PolicyVersionRow = {
    ...companyDraft,
    id: 'property-draft-empty-cancellation',
    scope_type: 'property',
    property_id: 'property-override',
    section: 'cancellation_policy',
    status: 'draft',
    content: { body: '' },
    revision: 8,
  }
  const invalid = makeTransactionalPool(async (sql, params) => {
    if (/FROM properties p/.test(sql)) return { rows: [{ id: 'property-override' }], rowCount: 1 }
    if (/FROM guest_site_stay_policy_versions/.test(sql) && /status=\$4/.test(sql) && params[3] === 'draft') {
      return { rows: [emptyCancellationDraft], rowCount: 1 }
    }
    if (/FROM guest_site_property_policy_sections/.test(sql)) {
      return { rows: [{ property_id: 'property-override', section: 'cancellation_policy', mode: 'legacy', revision: 1 }], rowCount: 1 }
    }
    return { rows: [], rowCount: 0 }
  })
  await assert.rejects(
    publishPropertyOverride(invalid.pool as any, {
      propertyId: 'property-override', section: 'cancellation_policy', expectedRevision: 8,
      expectedModeRevision: 1, actorId: 'publisher-1',
    }),
    (error: any) => error instanceof GuestSitePolicyValidationError && error.code === 'policy_section_not_ready',
  )
  assert(invalid.calls.some((call) => call.sql === 'ROLLBACK'))
  assert.equal(invalid.calls.some((call) => /SET status='archived'/.test(call.sql)), false)
  assert.equal(invalid.calls.some((call) => /SET mode='override'/.test(call.sql)), false)
}

async function testPropertyModeAndOverrideTransactions() {
  const follow = makeTransactionalPool(async (sql, params) => {
    if (/FROM properties p/.test(sql)) return { rows: [{ id: 'property-follow' }], rowCount: 1 }
    if (/FROM guest_site_property_policy_sections/.test(sql)) {
      return { rows: [{ property_id: 'property-follow', section: 'house_rules', mode: 'legacy', revision: 1 }], rowCount: 1 }
    }
    if (/FROM guest_site_stay_policy_versions/.test(sql) && /status=\$4/.test(sql) && params[3] === 'published') {
      return { rows: [publishedCompany], rowCount: 1 }
    }
    if (/UPDATE guest_site_property_policy_sections/.test(sql)) {
      return { rows: [{ property_id: 'property-follow', section: 'house_rules', mode: 'follow_company', revision: 2 }], rowCount: 1 }
    }
    return { rows: [], rowCount: 0 }
  })
  const followed = await setPropertyPolicyMode(follow.pool as any, {
    propertyId: 'property-follow', section: 'house_rules', mode: 'follow_company', expectedRevision: 1, actorId: 'editor-1',
  })
  assert.equal(followed.mode, 'follow_company')
  assert.equal(followed.revision, 2)
  assert(follow.calls.some((call) => /action, scope_type/.test(call.sql) && /guest_site_stay_policy_audits/.test(call.sql)))
  assert(follow.calls.some((call) => call.sql === 'COMMIT'))

  const bulk = makeTransactionalPool(async (sql, params) => {
    if (/FROM guest_site_stay_policy_versions/.test(sql) && /status=\$4/.test(sql) && params[3] === 'published') {
      return { rows: [publishedCompany], rowCount: 1 }
    }
    if (/FROM properties p/.test(sql)) return { rows: [{ id: params[0] }], rowCount: 1 }
    if (/FROM guest_site_property_policy_sections/.test(sql)) {
      const revision = params[0] === 'property-a' ? 1 : 9
      return { rows: [{ property_id: params[0], section: 'house_rules', mode: 'legacy', revision }], rowCount: 1 }
    }
    if (/UPDATE guest_site_property_policy_sections/.test(sql)) {
      return { rows: [{ property_id: params[0], section: 'house_rules', mode: 'follow_company', revision: 2 }], rowCount: 1 }
    }
    return { rows: [], rowCount: 0 }
  })
  await assert.rejects(
    bulkSetPropertyPoliciesToFollow(bulk.pool as any, {
      section: 'house_rules',
      items: [
        { propertyId: 'property-a', expectedRevision: 1 },
        { propertyId: 'property-b', expectedRevision: 1 },
      ],
      actorId: 'editor-1',
    }),
    (error: any) => error instanceof GuestSitePolicyConflict && error.code === 'policy_mode_revision_conflict',
  )
  assert(bulk.calls.some((call) => call.sql === 'ROLLBACK'), 'one stale row must roll back the complete bulk opt-in')
  assert.equal(bulk.calls.some((call) => call.sql === 'COMMIT'), false)

  const propertyDraft: PolicyVersionRow = {
    ...companyDraft,
    id: 'property-draft-ready',
    scope_type: 'property',
    property_id: 'property-override',
    revision: 8,
    content: { items: ['Property-specific rule'] },
  }
  const override = makeTransactionalPool(async (sql, params) => {
    if (/FROM properties p/.test(sql)) return { rows: [{ id: 'property-override' }], rowCount: 1 }
    if (/FROM guest_site_property_policy_sections/.test(sql)) {
      return { rows: [{ property_id: 'property-override', section: 'house_rules', mode: 'legacy', revision: 1 }], rowCount: 1 }
    }
    if (/FROM guest_site_stay_policy_versions/.test(sql) && /status=\$4/.test(sql)) {
      if (params[3] === 'draft') return { rows: [propertyDraft], rowCount: 1 }
      if (params[3] === 'published') return { rows: [], rowCount: 0 }
    }
    if (/SET status='published'/.test(sql)) return { rows: [{ ...propertyDraft, status: 'published' }], rowCount: 1 }
    if (/UPDATE guest_site_property_policy_sections/.test(sql)) {
      return { rows: [{ property_id: 'property-override', section: 'house_rules', mode: 'override', revision: 2 }], rowCount: 1 }
    }
    return { rows: [], rowCount: 0 }
  })
  const publishedOverride = await publishPropertyOverride(override.pool as any, {
    propertyId: 'property-override', section: 'house_rules', expectedRevision: 8,
    expectedModeRevision: 1, actorId: 'publisher-1',
  })
  assert.equal(publishedOverride.published.status, 'published')
  assert.equal(publishedOverride.mode.mode, 'override')
  assert.equal(override.calls.filter((call) => /INSERT INTO guest_site_stay_policy_audits/.test(call.sql)).length, 2)
  assert(override.calls.some((call) => call.sql === 'COMMIT'))
}

async function testMigrationAndRouteContracts() {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS guest_site_stay_policy_versions/)
  assert.match(migration, /CREATE TABLE IF NOT EXISTS guest_site_property_policy_sections/)
  assert.match(migration, /CREATE TABLE IF NOT EXISTS guest_site_stay_policy_audits/)
  const indexes = [...migration.matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS ([a-z0-9_]+)/g)].map((match) => match[1])
  assert.deepEqual(indexes, [
    'uq_guest_site_stay_policy_company_draft',
    'uq_guest_site_stay_policy_company_published',
    'uq_guest_site_stay_policy_property_draft',
    'uq_guest_site_stay_policy_property_published',
    'idx_guest_site_stay_policy_history',
    'idx_guest_site_property_policy_mode',
    'idx_guest_site_stay_policy_audits_subject',
  ], 'migration index inventory must remain exact')
  assert.match(migration, /revision integer NOT NULL DEFAULT 1/)
  assert.match(migration, /content jsonb NOT NULL DEFAULT '\{\}'::jsonb/)
  assert.match(migration, /PRIMARY KEY \(property_id, section\)/)
  assert.match(migration, /CHECK \(mode IN \('legacy', 'follow_company', 'override'\)\)/)
  assert.match(migration, /metadata jsonb NOT NULL DEFAULT '\{\}'::jsonb/)
  assert.match(migration, /CREATE OR REPLACE FUNCTION guest_site_initialize_property_policy_sections\(\)/)
  assert.match(migration, /CREATE TRIGGER trg_guest_site_initialize_property_policy_sections/)
  assert.match(migration, /AFTER INSERT ON guest_site_property_displays/)
  assert.match(migration, /SELECT NEW\.property_id, section_name, 'follow_company'/)
  assert.match(migration, /SELECT d\.property_id, section_name, 'legacy'/)
  assert.match(migration, /VALUES \('20261003_guest_site_stay_policies'\)/)
  assert.doesNotMatch(migration, /INSERT INTO guest_site_stay_policy_versions[\s\S]*VALUES/i, 'migration must not seed company or property policy content')
  assert.doesNotMatch(migration, /UPDATE\s+guest_site_property_displays/i, 'legacy public content must remain untouched')

  assert.match(moduleSource, /guest-site\/stay-policies\/company\/:section\/draft/)
  assert.match(moduleSource, /guest-site\/stay-policies\/company\/:section\/impact/)
  assert.match(moduleSource, /guest-site\/stay-policies\/company\/:section\/preview/)
  assert.match(moduleSource, /guest-site\/stay-policies\/company\/:section\/publish/)
  assert.match(moduleSource, /guest-site\/stay-policies\/properties\/:propertyId\/:section\/mode/)
  assert.match(moduleSource, /guest-site\/stay-policies\/:section\/bulk-follow/)
  assert.match(moduleSource, /requirePerm\('guest_site_settings\.write'\)[\s\S]*requirePerm\('guest_site_policies\.publish'\)/)
  assert.match(moduleSource, /requirePerm\('guest_site_properties\.write'\)[\s\S]*requirePerm\('guest_site_policies\.publish'\)/)
  assert.match(moduleSource, /applies_without_mode_change: mode === source/)
  assert.match(moduleSource, /cancellation_policy: effectivePolicy\.cancellation_policy/)
  assert.match(moduleSource, /stay_services: effectivePolicy\.stay_services/)
  assert.doesNotMatch(moduleSource.slice(moduleSource.indexOf("publicRouter.get('/guest-site/properties'"), moduleSource.indexOf("publicRouter.post('/guest-site/inquiries'")), /section_sources/, 'public DTO routes must not expose internal source/mode metadata')
  assert.match(storeSource, /\{ code: 'guest_site_policies\.publish' \}/)
  assert.match(permissionSource, /'guest_site_policies\.publish':/)
  assert.doesNotMatch(storeSource, /grant\([^\n]*guest_site_policies\.publish/, 'new publish permission must not be automatically granted to a non-admin role')
}

async function testPublishPermissionMiddleware() {
  const dbAdapter: any = require('../../src/dbAdapter')
  const originalHasPg = dbAdapter.hasPg
  const originalPool = dbAdapter.pgPool
  dbAdapter.hasPg = false
  dbAdapter.pgPool = null
  try {
    const { adminRouter } = require('../../src/modules/guest_site')
    function middlewareFor(path: string, method: 'post' | 'put') {
      const layer = adminRouter.stack.find((candidate: any) => (
        candidate?.route?.path === path && candidate.route.methods?.[method]
      ))
      assert(layer, `${method.toUpperCase()} ${path} must exist`)
      return layer.route.stack.slice(0, -1).map((item: any) => item.handle)
    }

    const publishMiddleware = middlewareFor('/guest-site/stay-policies/company/:section/publish', 'post')
    const modeMiddleware = middlewareFor('/guest-site/stay-policies/properties/:propertyId/:section/mode', 'put')
    const bulkMiddleware = middlewareFor('/guest-site/stay-policies/:section/bulk-follow', 'post')
    for (const middleware of [publishMiddleware, modeMiddleware, bulkMiddleware]) {
      assert.equal(middleware.length, 2, 'every public-effective change must require edit and separate publish permissions')
    }

    async function invoke(handler: any, user: any) {
      let nextCalled = false
      const res: any = {
        statusCode: 200,
        body: undefined,
        status(code: number) { this.statusCode = code; return this },
        json(body: any) { this.body = body; return this },
      }
      await handler({ user }, res, () => { nextCalled = true })
      return { ...res, nextCalled }
    }

    const editorCanEdit = await invoke(publishMiddleware[0], { role: 'customer_service' })
    assert.equal(editorCanEdit.nextCalled, true, 'existing settings editors keep draft access')
    const editorCannotPublish = await invoke(publishMiddleware[1], { role: 'customer_service' })
    assert.equal(editorCannotPublish.statusCode, 403, 'existing editors must not receive publish permission automatically')
    assert.equal(editorCannotPublish.nextCalled, false)
    for (const middleware of [modeMiddleware, bulkMiddleware]) {
      const editorCannotChangeEffectivePolicy = await invoke(middleware[1], { role: 'customer_service' })
      assert.equal(editorCannotChangeEffectivePolicy.statusCode, 403, 'mode changes must not bypass the separate publish permission')
    }
    const adminCanPublish = await invoke(publishMiddleware[1], { role: 'admin' })
    assert.equal(adminCanPublish.nextCalled, true)
    const anonymousCannotPublish = await invoke(publishMiddleware[1], undefined)
    assert.equal(anonymousCannotPublish.statusCode, 401)
  } finally {
    dbAdapter.hasPg = originalHasPg
    dbAdapter.pgPool = originalPool
  }
}

async function main() {
  await testPureRules()
  await testDraftTransactionAndConflict()
  await testImpactAndPublishTransactions()
  await testOverrideFailureKeepsPublishedState()
  await testPropertyModeAndOverrideTransactions()
  await testMigrationAndRouteContracts()
  await testPublishPermissionMiddleware()
  console.log('guest-site stay policy contract: ok')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
