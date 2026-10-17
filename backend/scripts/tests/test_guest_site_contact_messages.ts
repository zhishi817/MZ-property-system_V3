import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const dbAdapter: any = require('../../src/dbAdapter')
const originalHasPg = dbAdapter.hasPg
const originalPgPool = dbAdapter.pgPool
const moduleSource = fs.readFileSync(path.resolve(__dirname, '../../src/modules/guest_site.ts'), 'utf8')
const migration = fs.readFileSync(path.resolve(__dirname, '../migrations/20261001_guest_site_contact_messages.sql'), 'utf8')
const publicContentMigration = fs.readFileSync(path.resolve(__dirname, '../migrations/20261001_guest_site_public_content_schema.sql'), 'utf8')
const schemaSource = fs.readFileSync(path.resolve(__dirname, '../../src/lib/guestSiteSchema.ts'), 'utf8')
const adminSource = fs.readFileSync(path.resolve(__dirname, '../../../frontend/src/app/guest-site/inquiries/page.tsx'), 'utf8')

type QueryCall = { sql: string; params: any[] }
const clientCalls: QueryCall[] = []
const poolCalls: QueryCall[] = []
let duplicateId = ''
let insertFailure = false
let released = 0
let recentEmailCount = 0
let recentTotalCount = 0
let contactConcurrencyMode = false
let contactConcurrencyCount = 0
let contactLockTail = Promise.resolve()
let schemaMarkers = [
  '20261001_guest_site_public_content_schema',
  '20261001_guest_site_contact_messages',
  '20261002_guest_site_amenity_selections',
  '20261002_guest_site_amenity_templates',
  '20261003_guest_site_stay_policies',
]

const client = {
  async query(sql: string, params: any[] = []) {
    clientCalls.push({ sql, params })
    if (/SELECT id\s+FROM guest_site_contact_messages/.test(sql)) {
      return { rows: duplicateId ? [{ id: duplicateId }] : [], rowCount: duplicateId ? 1 : 0 }
    }
    if (/COUNT\(\*\) FILTER \(WHERE guest_email/.test(sql)) {
      return { rows: [{ email_count: recentEmailCount, total_count: recentTotalCount }], rowCount: 1 }
    }
    if (/INSERT INTO guest_site_contact_messages/.test(sql) && insertFailure) throw new Error('simulated_insert_failure')
    return { rows: [], rowCount: 0 }
  },
  release() { released += 1 },
}

function createConcurrentClient() {
  let unlockGlobal: (() => void) | null = null
  return {
    async query(sql: string, params: any[] = []) {
      clientCalls.push({ sql, params })
      if (/pg_advisory_xact_lock/.test(sql) && params[0] === 'guest-site-contact-rate-limit:global') {
        const previous = contactLockTail
        let unlock = () => {}
        contactLockTail = new Promise<void>((resolve) => { unlock = resolve })
        await previous
        unlockGlobal = unlock
        return { rows: [], rowCount: 0 }
      }
      if (/pg_advisory_xact_lock/.test(sql)) return { rows: [], rowCount: 0 }
      if (/SELECT id\s+FROM guest_site_contact_messages/.test(sql)) return { rows: [], rowCount: 0 }
      if (/COUNT\(\*\) FILTER \(WHERE guest_email/.test(sql)) {
        return { rows: [{ email_count: contactConcurrencyCount, total_count: contactConcurrencyCount }], rowCount: 1 }
      }
      if (/INSERT INTO guest_site_contact_messages/.test(sql)) {
        contactConcurrencyCount += 1
        return { rows: [], rowCount: 1 }
      }
      if (sql === 'COMMIT' || sql === 'ROLLBACK') {
        unlockGlobal?.()
        unlockGlobal = null
      }
      return { rows: [], rowCount: 0 }
    },
    release() {
      unlockGlobal?.()
      unlockGlobal = null
      released += 1
    },
  }
}

const savedContact = {
  id: 'contact-1',
  submission_id: '74b01bb1-0af6-4dcc-9f7b-35e820067f93',
  guest_name: 'Ada Lovelace',
  guest_email: 'ada@example.com',
  message: 'Please contact me.',
  status: 'new',
  admin_note: null,
  handled_by: null,
  handled_at: null,
  created_at: '2026-10-01T00:00:00.000Z',
  updated_at: '2026-10-01T00:00:00.000Z',
}

dbAdapter.hasPg = true
dbAdapter.pgPool = {
  async connect() { return contactConcurrencyMode ? createConcurrentClient() : client },
  async query(sql: string, params: any[] = []) {
    poolCalls.push({ sql, params })
    if (/FROM schema_migrations WHERE version = ANY/.test(sql)) {
      return { rows: schemaMarkers.map((version) => ({ version })), rowCount: schemaMarkers.length }
    }
    if (/SELECT data FROM guest_site_configs/.test(sql)) {
      return {
        rows: [{ data: {
          banner_title: 'CMS headline',
          banner_subtitle: 'CMS subtitle',
          hero_background_urls: ['https://images.example/hero.jpg'],
          primary_button_text: 'View properties',
          primary_button_href: '/properties',
          secondary_button_text: 'Contact us',
          secondary_button_href: '/#contact',
          brand_story: 'CMS brand story',
          contact_email: 'info@example.com',
          contact_phone: '+61 400 000 000',
          contact_whatsapp: '',
          contact_address: '130 Example St',
          faq_items: [],
        } }],
        rowCount: 1,
      }
    }
    if (/FROM properties p[\s\S]*LEFT JOIN guest_site_property_displays/.test(sql)) {
      return {
        rows: [{
          id: 'published-1',
          code: 'INTERNAL-CODE',
          address: 'Secret unit address',
          type: 'Apartment',
          capacity: 4,
          region: 'Internal region',
          is_published: true,
          hero_title: 'Published stay',
          short_description: 'Public summary',
          long_description: 'Public description',
          hero_image_url: 'https://images.example/stay.jpg',
          gallery_urls: ['https://images.example/stay.jpg'],
          feature_tags: ['City views'],
          amenities: ['Wi-Fi'],
          house_rules: ['No smoking'],
          sort_order: 1,
          public_region_label: 'Melbourne CBD',
          public_capacity_override: 3,
          bedroom_count: 2,
          bathroom_count: 1,
          bed_count: 2,
          checkin_time: '15:00',
          checkout_time: '10:00',
          location_note: 'Melbourne CBD',
          price_label: 'Request a quote',
          booking_highlights: ['Manual confirmation'],
          notes: 'Internal note',
          airbnb_listing_name: 'Private channel name',
          booking_listing_name: 'Private booking name',
        }],
        rowCount: 1,
      }
    }
    if (/COUNT\(\*\)::int AS properties_managed_to_date[\s\S]*FROM properties/.test(sql)) {
      return { rows: [{ properties_managed_to_date: 121, as_of: '2026-10-01T00:00:00.000Z' }], rowCount: 1 }
    }
    if (/UPDATE guest_site_contact_messages/.test(sql)) return { rows: [{ ...savedContact, status: params[1] || savedContact.status }], rowCount: 1 }
    if (/FROM guest_site_contact_messages/.test(sql)) return { rows: [savedContact], rowCount: 1 }
    return { rows: [], rowCount: 0 }
  },
}

const guestSiteSchema = require('../../src/lib/guestSiteSchema')
const { publicRouter, adminRouter } = require('../../src/modules/guest_site')

function routeHandler(router: any, routePath: string, method: string) {
  const layer = router.stack.find((candidate: any) => candidate?.route?.path === routePath && candidate.route.methods?.[method])
  assert(layer, `${method.toUpperCase()} ${routePath} must exist`)
  const stack = layer.route.stack
  return {
    handler: stack[stack.length - 1].handle,
    middleware: stack.slice(0, -1).map((item: any) => item.handle),
    middlewareCount: stack.length - 1,
  }
}

async function invoke(handler: any, req: any) {
  const res: any = {
    statusCode: 200,
    body: undefined,
    status(code: number) { this.statusCode = code; return this },
    json(body: any) { this.body = body; return this },
  }
  await handler(req, res)
  return res
}

async function invokeMiddleware(handler: any, req: any) {
  let nextCalled = false
  const res = await invoke((request: any, response: any) => handler(request, response, () => { nextCalled = true }), req)
  return { ...res, nextCalled }
}

async function main() {
  const originalTranslationKey = process.env.OPENAI_API_KEY
  delete process.env.OPENAI_API_KEY
  const publicRoute = routeHandler(publicRouter, '/guest-site/contact-messages', 'post')
  schemaMarkers = schemaMarkers.filter((version) => version !== '20261001_guest_site_contact_messages')
  await guestSiteSchema.warmupGuestSiteSchema()
  const schemaUnavailable = await invoke(publicRoute.handler, {
    body: {
      submission_id: savedContact.submission_id,
      first_name: 'Ada',
      last_name: 'Lovelace',
      email: 'ada@example.com',
      message: 'Please contact me.',
    },
  })
  assert.equal(schemaUnavailable.statusCode, 503)
  assert.equal(schemaUnavailable.body.message, 'guest_site_contact_messages_schema_not_ready')
  schemaMarkers.push('20261001_guest_site_contact_messages')
  await guestSiteSchema.warmupGuestSiteSchema()
  assert.match(migration, /BEGIN;/)
  assert.match(migration, /CREATE TABLE IF NOT EXISTS guest_site_contact_messages/)
  assert.match(migration, /submission_id uuid NOT NULL UNIQUE/)
  assert.match(migration, /status IN \('new', 'contacted', 'closed'\)/)
  assert.match(migration, /idx_guest_site_contact_messages_created[\s\S]*created_at DESC/)
  assert.match(migration, /idx_guest_site_contact_messages_email_created[\s\S]*guest_email, created_at DESC/)
  assert.match(migration, /INSERT INTO schema_migrations[\s\S]*20261001_guest_site_contact_messages/)
  assert.match(publicContentMigration, /CREATE TABLE IF NOT EXISTS guest_site_configs/)
  assert.match(publicContentMigration, /CREATE TABLE IF NOT EXISTS guest_site_property_displays/)
  assert.match(publicContentMigration, /CREATE TABLE IF NOT EXISTS guest_site_translations/)
  assert.match(publicContentMigration, /ALTER TABLE guest_site_property_displays ADD COLUMN IF NOT EXISTS amenities/)
  assert.match(publicContentMigration, /INSERT INTO schema_migrations[\s\S]*20261001_guest_site_public_content_schema/)
  assert.match(schemaSource, /SELECT version FROM schema_migrations WHERE version = ANY/)
  assert.doesNotMatch(moduleSource, /CREATE TABLE|ALTER TABLE|ensureGuestSiteTables/, 'guest-site request module must not own DDL')
  assert.match(moduleSource, /chat\/completions/, 'cache misses should retain the existing translation capability')
  assert.doesNotMatch(moduleSource, /saveCachedTranslation/, 'public reads must not persist translations')

  const publicStart = moduleSource.indexOf("publicRouter.post('/guest-site/contact-messages'")
  const publicEnd = moduleSource.indexOf("adminRouter.get('/guest-site/config'", publicStart)
  const publicRouteSource = moduleSource.slice(publicStart, publicEnd)
  assert(publicStart >= 0 && publicEnd > publicStart, 'public contact route must be discoverable')
  assert.doesNotMatch(publicRouteSource, /ensureGuestSiteTables|CREATE TABLE|ALTER TABLE/, 'public write must never run request-path DDL')
  assert.match(publicRouteSource, /contact_storage_unavailable/, 'public write must fail closed without durable storage')
  assert.match(publicRouteSource, /pg_advisory_xact_lock/, 'semantic duplicate checks must be serialized')
  assert.match(publicRouteSource, /guest-site-contact-rate-limit:global/, 'quota checks must hold a stable global transaction lock')
  assert.match(publicRouteSource, /guest-site-contact-rate-limit:email:/, 'quota checks must hold a stable per-email transaction lock')
  assert.match(publicRouteSource, /submission_id = \$1::uuid/, 'stable submission IDs must be idempotent')
  assert.doesNotMatch(publicRouteSource, /fallbackStore/, 'public contact success must never be memory-only')

  const publicStatsRoute = routeHandler(publicRouter, '/guest-site/stats', 'get')
  const publicConfigRoute = routeHandler(publicRouter, '/guest-site/config', 'get')
  const publicPropertiesRoute = routeHandler(publicRouter, '/guest-site/properties', 'get')
  const publicPropertyRoute = routeHandler(publicRouter, '/guest-site/properties/:id', 'get')
  const adminListRoute = routeHandler(adminRouter, '/guest-site/contact-messages', 'get')
  const adminPatchRoute = routeHandler(adminRouter, '/guest-site/contact-messages/:id', 'patch')
  assert.equal(adminListRoute.middlewareCount, 1, 'admin list must retain permission middleware')
  assert.equal(adminPatchRoute.middlewareCount, 1, 'admin update must retain permission middleware')
  assert.match(moduleSource, /adminRouter\.get\('\/guest-site\/contact-messages', requirePerm\('guest_site_inquiries\.view'\)/)
  assert.match(moduleSource, /adminRouter\.patch\('\/guest-site\/contact-messages\/:id', requirePerm\('guest_site_inquiries\.write'\)/)
  assert.match(adminSource, /title="网站咨询"/)
  assert.match(adminSource, /<MessageBlock>\{editingContact\.message\}<\/MessageBlock>/, 'admin detail must show the complete persisted enquiry')

  poolCalls.length = 0
  const config = await invoke(publicConfigRoute.handler, { query: { locale: 'en' } })
  assert.equal(config.statusCode, 200)
  assert.equal(config.body.banner_title, 'CMS headline')
  assert.equal(poolCalls.some((call) => /\b(?:CREATE|ALTER|INSERT|UPDATE|DELETE)\b/i.test(call.sql)), false, 'public config read must be read-only')

  poolCalls.length = 0
  const untranslatedConfig = await invoke(publicConfigRoute.handler, { query: { locale: 'fr' } })
  assert.equal(untranslatedConfig.statusCode, 200)
  assert.equal(untranslatedConfig.body.banner_title, 'CMS headline')
  assert(poolCalls.some((call) => /FROM guest_site_translations/.test(call.sql)), 'translated config should consult only the existing cache')
  assert.equal(poolCalls.some((call) => /\b(?:CREATE|ALTER|INSERT|UPDATE|DELETE)\b/i.test(call.sql)), false, 'translation fallback must not write or run DDL')

  const originalFetch = globalThis.fetch
  let translationFetches = 0
  process.env.OPENAI_API_KEY = 'contract-test-key'
  globalThis.fetch = (async () => {
    translationFetches += 1
    await new Promise((resolve) => setTimeout(resolve, 5))
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ banner_title: 'Titre traduit' }) } }] }),
    }
  }) as any
  const translatedConfigs = await Promise.all(Array.from({ length: 5 }, () => invoke(publicConfigRoute.handler, { query: { locale: 'fr' } })))
  assert(translatedConfigs.every((response) => response.statusCode === 200 && response.body.banner_title === 'Titre traduit'))
  assert.equal(translationFetches, 1, 'concurrent locale cache misses must share one external translation request')
  const runtimeCachedConfig = await invoke(publicConfigRoute.handler, { query: { locale: 'fr' } })
  assert.equal(runtimeCachedConfig.body.banner_title, 'Titre traduit')
  assert.equal(translationFetches, 1, 'runtime translation cache must prevent repeated external requests')
  assert.equal(poolCalls.some((call) => /\b(?:CREATE|ALTER|INSERT|UPDATE|DELETE)\b/i.test(call.sql)), false, 'generated translations must remain read-only')
  globalThis.fetch = originalFetch
  if (originalTranslationKey === undefined) delete process.env.OPENAI_API_KEY
  else process.env.OPENAI_API_KEY = originalTranslationKey

  poolCalls.length = 0
  const properties = await invoke(publicPropertiesRoute.handler, { query: { locale: 'en', featured: 'true' } })
  assert.equal(properties.statusCode, 200)
  assert.equal(properties.body.length, 1)
  assert.equal(properties.body[0].hero_title, 'Published stay')
  assert.deepEqual(properties.body[0].house_rules, ['No smoking'])
  assert.equal(properties.body[0].cancellation_policy, '')
  assert.equal(properties.body[0].checkin_time, '3PM')
  assert.equal(properties.body[0].checkout_time, '10AM')
  assert.equal(properties.body[0].stay_services.length, 3)
  assert.equal('section_sources' in properties.body[0], false, 'public DTO must not expose internal policy source metadata')
  for (const sensitive of ['code', 'address', 'region', 'notes', 'airbnb_listing_name', 'booking_listing_name', 'building_name', 'building_facilities', 'bed_config', 'location_note']) {
    assert.equal(sensitive in properties.body[0], false, `public property leaked ${sensitive}`)
  }
  const publishedQuery = poolCalls.find((call) => /FROM properties p/.test(call.sql))
  assert.match(publishedQuery?.sql || '', /COALESCE\(d\.is_published, false\)=true/)
  assert.match(publishedQuery?.sql || '', /COALESCE\(d\.sort_order, 99999\) ASC/)
  assert.equal(poolCalls.some((call) => /\b(?:CREATE|ALTER|INSERT|UPDATE|DELETE)\b/i.test(call.sql)), false, 'public property read must be read-only')

  const previewAttempt = await invoke(publicPropertyRoute.handler, { params: { id: 'draft' }, query: { locale: 'en', preview: '1' } })
  assert.equal(previewAttempt.statusCode, 404, 'anonymous preview=1 must not expose unpublished listings')
  const internalCodeAttempt = await invoke(publicPropertyRoute.handler, { params: { id: 'INTERNAL-CODE' }, query: { locale: 'en' } })
  assert.equal(internalCodeAttempt.statusCode, 404, 'public property lookup must not accept an internal code as an identifier')

  poolCalls.length = 0
  const stats = await invoke(publicStatsRoute.handler, {})
  assert.equal(stats.statusCode, 200)
  assert.deepEqual(stats.body, { properties_managed_to_date: 121, as_of: '2026-10-01T00:00:00.000Z' })
  const statsQuery = poolCalls.find((call) => /FROM properties/.test(call.sql))
  assert(statsQuery, 'public stats must read the authoritative properties table')
  assert.doesNotMatch(statsQuery.sql, /archived|is_published|active|deleted/i, 'managed-to-date count must include archived rows without inventing another status filter')
  assert.doesNotMatch(statsQuery.sql, /SELECT\s+(id|code|address|\*)/i, 'public stats must expose an aggregate only')

  const anonymousList = await invokeMiddleware(adminListRoute.middleware[0], {})
  assert.equal(anonymousList.statusCode, 401)
  assert.equal(anonymousList.body.message, 'unauthorized')
  assert.equal(anonymousList.nextCalled, false)
  const forbiddenList = await invokeMiddleware(adminListRoute.middleware[0], { user: { role: 'homepage_contact_no_access' } })
  assert.equal(forbiddenList.statusCode, 403)
  assert.equal(forbiddenList.body.message, 'forbidden')
  assert.equal(forbiddenList.nextCalled, false)
  const adminList = await invokeMiddleware(adminListRoute.middleware[0], { user: { role: 'admin' } })
  assert.equal(adminList.nextCalled, true)

  const anonymousPatch = await invokeMiddleware(adminPatchRoute.middleware[0], {})
  assert.equal(anonymousPatch.statusCode, 401)
  assert.equal(anonymousPatch.nextCalled, false)
  const forbiddenPatch = await invokeMiddleware(adminPatchRoute.middleware[0], { user: { role: 'homepage_contact_no_access' } })
  assert.equal(forbiddenPatch.statusCode, 403)
  assert.equal(forbiddenPatch.nextCalled, false)
  const adminPatch = await invokeMiddleware(adminPatchRoute.middleware[0], { user: { role: 'admin' } })
  assert.equal(adminPatch.nextCalled, true)

  const invalid = await invoke(publicRoute.handler, { body: { first_name: 'Ada' } })
  assert.equal(invalid.statusCode, 400)
  assert.equal(invalid.body.message, 'invalid_contact_message')

  dbAdapter.hasPg = false
  const unavailable = await invoke(publicRoute.handler, {
    body: {
      submission_id: savedContact.submission_id,
      first_name: 'Ada',
      last_name: 'Lovelace',
      email: 'ada@example.com',
      message: 'Please contact me.',
    },
  })
  assert.equal(unavailable.statusCode, 503)
  assert.equal(unavailable.body.message, 'contact_storage_unavailable')
  dbAdapter.hasPg = true

  clientCalls.length = 0
  duplicateId = ''
  const created = await invoke(publicRoute.handler, {
    body: {
      submission_id: savedContact.submission_id,
      first_name: '  Ada ',
      last_name: ' Lovelace  ',
      email: 'ADA@EXAMPLE.COM',
      message: ' Please contact me. ',
    },
  })
  assert.equal(created.statusCode, 201)
  assert.equal(created.body.ok, true)
  assert.equal(created.body.duplicate, false)
  const insert = clientCalls.find((call) => /INSERT INTO guest_site_contact_messages/.test(call.sql))
  assert(insert, 'validated contact message must be inserted')
  assert.equal(insert.params[2], 'Ada Lovelace')
  assert.equal(insert.params[3], 'ada@example.com')
  assert.equal(insert.params[4], 'Please contact me.')
  assert.match(String(insert.params[5]), /^[0-9a-f]{64}$/)
  assert(clientCalls.some((call) => call.sql === 'COMMIT'))

  clientCalls.length = 0
  recentEmailCount = 3
  const rateLimited = await invoke(publicRoute.handler, {
    body: {
      submission_id: 'a5a3bbf3-9449-4508-8b72-a59947a20e83',
      first_name: 'Ada',
      last_name: 'Lovelace',
      email: 'ada@example.com',
      message: 'A different valid message.',
    },
  })
  assert.equal(rateLimited.statusCode, 429)
  assert.equal(rateLimited.body.message, 'contact_rate_limited')
  assert.equal(clientCalls.some((call) => /INSERT INTO guest_site_contact_messages/.test(call.sql)), false)
  assert(clientCalls.some((call) => call.sql === 'ROLLBACK'))
  recentEmailCount = 0

  clientCalls.length = 0
  contactConcurrencyMode = true
  contactConcurrencyCount = 0
  contactLockTail = Promise.resolve()
  const concurrentResults = await Promise.all(Array.from({ length: 5 }, (_, index) => invoke(publicRoute.handler, {
    body: {
      submission_id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      first_name: 'Concurrent',
      last_name: `Guest ${index + 1}`,
      email: 'parallel@example.com',
      message: `Unique valid message ${index + 1}.`,
    },
  })))
  contactConcurrencyMode = false
  assert.equal(concurrentResults.filter((response) => response.statusCode === 201).length, 3)
  assert.equal(concurrentResults.filter((response) => response.statusCode === 429).length, 2)
  assert.equal(contactConcurrencyCount, 3, 'serialized quota checks must cap parallel unique submissions')

  clientCalls.length = 0
  const propertyCreated = await invoke(publicRoute.handler, {
    body: {
      submission_id: '15935e0e-70c6-4a41-879f-d77186c0fc2e',
      inquiry_type: 'property_management',
      name: '  Property Owner  ',
      email: 'OWNER@EXAMPLE.COM',
      phone: '+61 400 000 000',
      property_area: ' South Melbourne ',
      property_type: 'Apartment',
      current_use: 'Short-term rental',
      message: 'Please help me manage this property.',
    },
  })
  assert.equal(propertyCreated.statusCode, 201)
  assert.equal(propertyCreated.body.ok, true)
  const propertyInsert = clientCalls.find((call) => /INSERT INTO guest_site_contact_messages/.test(call.sql))
  assert(propertyInsert, 'property management enquiry must use the existing contact message table')
  assert.equal(propertyInsert.params[2], 'Property Owner')
  assert.equal(propertyInsert.params[3], 'owner@example.com')
  assert.equal(propertyInsert.params[4], [
    'Property management enquiry',
    'Phone: +61 400 000 000',
    'Property area / suburb: South Melbourne',
    'Property type: Apartment',
    'Current use: Short-term rental',
    '',
    'Enquiry details:',
    'Please help me manage this property.',
  ].join('\n'))

  const invalidProperty = await invoke(publicRoute.handler, {
    body: {
      submission_id: '2d13c4c7-2537-421f-9357-ca52db20f142',
      inquiry_type: 'property_management',
      name: 'Property Owner',
      email: 'owner@example.com',
      property_area: 'South Melbourne',
      property_type: 'Apartment',
      message: 'Missing the current use field.',
    },
  })
  assert.equal(invalidProperty.statusCode, 400)
  assert.equal(invalidProperty.body.message, 'invalid_contact_message')

  clientCalls.length = 0
  duplicateId = 'existing-contact'
  const duplicate = await invoke(publicRoute.handler, {
    body: {
      submission_id: savedContact.submission_id,
      first_name: 'Ada',
      last_name: 'Lovelace',
      email: 'ada@example.com',
      message: 'Please contact me.',
    },
  })
  assert.equal(duplicate.statusCode, 200)
  assert.deepEqual(duplicate.body, { ok: true, id: 'existing-contact', duplicate: true })
  assert.equal(clientCalls.some((call) => /INSERT INTO guest_site_contact_messages/.test(call.sql)), false)

  poolCalls.length = 0
  const invalidStatus = await invoke(adminListRoute.handler, { query: { status: 'converted' } })
  assert.equal(invalidStatus.statusCode, 400)
  const listed = await invoke(adminListRoute.handler, { query: { status: 'new' } })
  assert.equal(listed.statusCode, 200)
  assert.equal(listed.body[0].id, savedContact.id)
  assert.deepEqual(poolCalls.at(-1)?.params, ['new'])

  const patched = await invoke(adminPatchRoute.handler, {
    params: { id: savedContact.id },
    body: { status: 'contacted', admin_note: 'Called guest' },
    user: { sub: 'admin-user', role: 'admin' },
  })
  assert.equal(patched.statusCode, 200)
  assert.equal(patched.body.status, 'contacted')
  const update = poolCalls.find((call) => /UPDATE guest_site_contact_messages/.test(call.sql))
  assert.deepEqual(update?.params, [savedContact.id, 'contacted', true, 'Called guest', 'admin-user'])

  duplicateId = ''
  insertFailure = true
  clientCalls.length = 0
  const failed = await invoke(publicRoute.handler, {
    body: {
      submission_id: '9c39a4d9-7cba-43e0-b5e0-edba34f213a5',
      first_name: 'Grace',
      last_name: 'Hopper',
      email: 'grace@example.com',
      message: 'Please call me.',
    },
  })
  assert.equal(failed.statusCode, 500)
  assert(clientCalls.some((call) => call.sql === 'ROLLBACK'), 'failed writes must roll back')
  assert(released >= 3, 'every acquired client must be released')

  process.stdout.write('test_guest_site_contact_messages: ok\n')
}

main().finally(() => {
  dbAdapter.hasPg = originalHasPg
  dbAdapter.pgPool = originalPgPool
}).catch((error) => {
  console.error(error)
  process.exit(1)
})
