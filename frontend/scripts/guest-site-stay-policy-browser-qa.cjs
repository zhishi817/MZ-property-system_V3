const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require(path.resolve(__dirname, '../../backend/node_modules/playwright'))

const adminUrl = process.env.GUEST_SITE_ADMIN_QA_URL || 'http://127.0.0.1:3006'
const bookingUrl = process.env.GUEST_SITE_BOOKING_QA_URL || 'http://127.0.0.1:3004'
const outputDir = path.resolve(__dirname, '../../output/guest-site-stay-policies-20261003')
const viewports = [
  { name: '320-narrow', width: 320, height: 700 },
  { name: '390-mobile', width: 390, height: 844 },
  { name: '768-tablet', width: 768, height: 1024 },
  { name: '1024-small-desktop', width: 1024, height: 800 },
  { name: '1440-desktop', width: 1440, height: 1000 },
]

const sections = ['house_rules', 'cancellation_policy', 'stay_times', 'stay_services']
const defaultServices = [
  { key: 'early_checkin', enabled: true, title: 'Early check-in', headline: 'No fee · Advance request', description: 'Ask in advance. We will do our best to arrange an earlier arrival, but it is not guaranteed.', fee_amount: 0, fee_currency: 'AUD', until_time: '', requires_advance_request: true, manual_confirmation: true, guaranteed: false, grants_room_access: false, payment_timing: '' },
  { key: 'late_checkout', enabled: true, title: 'Late check-out', headline: 'Until 11:30AM · A$20', description: 'Ask in advance. Approval is manual and depends on availability.', fee_amount: 20, fee_currency: 'AUD', until_time: '11:30AM', requires_advance_request: true, manual_confirmation: true, guaranteed: false, grants_room_access: false, payment_timing: '' },
  { key: 'baggage_dropoff', enabled: true, title: 'Luggage drop-off', headline: 'Advance confirmation required', description: 'Ask the property team before arrival. Confirmed luggage drop-off does not mean the property is ready for check-in.', fee_amount: null, fee_currency: 'AUD', until_time: '', requires_advance_request: true, manual_confirmation: true, guaranteed: false, grants_room_access: false, payment_timing: '' },
]

function content(section, draft = true) {
  if (section === 'house_rules') return { items: draft ? ['No smoking', 'Quiet hours after 10PM'] : ['No smoking'] }
  if (section === 'cancellation_policy') return { body: draft ? 'Company candidate cancellation terms supplied for this QA preview.' : 'Previously published cancellation terms.' }
  if (section === 'stay_times') return { checkin_time: '3PM', checkout_time: '10AM' }
  return { services: defaultServices.map((service) => ({ ...service })) }
}

function version(section, status, revision) {
  return {
    id: `${section}-${status}-${revision}`, scope_type: 'company', property_id: null, section, status, revision,
    content: content(section, status === 'draft'), updated_at: '2026-10-03T12:00:00.000Z', updated_by: 'qa-editor',
    published_at: status === 'published' ? '2026-10-03T11:00:00.000Z' : null,
    published_by: status === 'published' ? 'qa-publisher' : null,
  }
}

let companyOverview = {
  schema_ready: true,
  sections: sections.map((section) => {
    const draft = version(section, 'draft', 2)
    const published = version(section, 'published', 1)
    return { section, draft, published, default_draft: null, readiness: { ready: true, issues: [], content: draft.content }, history: [draft, published] }
  }),
}

const property = {
  id: 'property-qa-1', code: 'QA-101', address: 'Private QA address', type: 'Apartment', capacity: 2,
  public_region_label: 'Docklands', hero_title: 'Policy preview apartment', short_description: 'A public preview fixture.',
  long_description: 'A public preview fixture for the effective stay policy.', hero_image_url: `${bookingUrl}/homepage/testimonial.jpg`,
  gallery_urls: [`${bookingUrl}/homepage/testimonial.jpg`], feature_tags: ['Entire apartment'], amenities: [], amenity_selections: [],
  house_rules: ['Legacy property rule'], sort_order: 0, is_published: true, bedroom_count: 1, bathroom_count: 1, bed_count: 1,
  checkin_time: '4PM', checkout_time: '11AM', booking_highlights: [],
  publish_readiness: { ready: true, items: [] },
}

function propertySection(section) {
  const draft = { ...version(section, 'draft', 3), id: `property-${section}-draft-3`, scope_type: 'property', property_id: property.id }
  const published = { ...version(section, 'published', 2), id: `property-${section}-published-2`, scope_type: 'property', property_id: property.id }
  return {
    section,
    mode: { property_id: property.id, section, mode: 'legacy', revision: 1 },
    draft,
    published,
    default_draft: null,
    readiness: { ready: true, issues: [], content: draft.content },
    company_published: content(section, false),
    history: [draft, published],
  }
}

let propertyOverview = {
  property_id: property.id,
  sections: sections.map(propertySection),
  effective_policy: {},
  public_property: {},
}

const previewProperty = {
  id: property.id,
  type: property.type,
  capacity: property.capacity,
  public_capacity_override: null,
  public_region_label: property.public_region_label,
  hero_title: property.hero_title,
  short_description: property.short_description,
  long_description: property.long_description,
  hero_image_url: property.hero_image_url,
  gallery_urls: property.gallery_urls,
  feature_tags: property.feature_tags,
  amenities: [],
  amenity_items: [],
  house_rules: ['Candidate rule from the unified policy.'],
  cancellation_policy: 'Company candidate cancellation terms supplied for this QA preview.',
  stay_services: [
    { ...defaultServices[0], title: 'Flexible early arrival' },
    { ...defaultServices[1], enabled: false },
    { ...defaultServices[2], title: 'Pre-arranged bag drop' },
  ],
  sort_order: 0,
  is_published: false,
  bedroom_count: 1,
  bathroom_count: 1,
  bed_count: 1,
  checkin_time: '3PM',
  checkout_time: '10AM',
  price_label: '',
  booking_highlights: [],
}

const allServicesPreviewProperty = {
  ...previewProperty,
  stay_services: previewProperty.stay_services.map((service) => ({ ...service, enabled: true })),
}

const writes = []

function config() {
  return {
    banner_title: 'QA title', banner_subtitle: 'QA subtitle', hero_background_urls: [],
    primary_button_text: 'View properties', primary_button_href: '/properties', secondary_button_text: 'Contact', secondary_button_href: '/#contact',
    brand_story: 'QA story', contact_email: 'info@example.com', contact_phone: '+61 400 000 000', contact_whatsapp: '',
    contact_address: 'Public QA address', faq_items: [],
  }
}

function json(route, payload, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) })
}

async function installMocks(page, options = {}) {
  const role = options.role || 'admin'
  const permissions = options.permissions || ['guest_site_settings.view', 'guest_site_settings.write', 'guest_site_properties.view', 'guest_site_properties.write', 'guest_site_policies.publish']
  const previewFixture = options.previewProperty || previewProperty
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const pathname = url.pathname.replace(/^\/api/, '')
    if (pathname === '/auth/me') return json(route, { username: `qa-${role}`, role })
    if (pathname === '/rbac/my-permissions') return json(route, permissions)
    if (pathname === '/notifications/unread-count') return json(route, { count: 0 })
    if (pathname === '/version') return json(route, { version: 'qa' })
    if (pathname === '/health') return json(route, { ok: true })
    if (pathname === '/cms/guest-site/config' && request.method() === 'GET') return json(route, config())
    if (pathname === '/cms/guest-site/amenity-catalog') return json(route, { statuses: [], categories: [], items: [], templates: [] })
    if (pathname === '/cms/guest-site/amenity-templates') return json(route, { schema_ready: true, templates: [] })
    if (pathname === '/cms/guest-site/properties' && request.method() === 'GET') return json(route, [property])
    if (pathname === '/cms/guest-site/stay-policies' && request.method() === 'GET') {
      if (options.schemaMissing) return json(route, { message: 'guest_site_stay_policy_schema_not_ready' }, 503)
      return json(route, companyOverview)
    }
    if (pathname === `/cms/guest-site/stay-policies/properties/${property.id}` && request.method() === 'GET') return json(route, propertyOverview)
    if (/\/cms\/guest-site\/stay-policies\/company\/[^/]+\/draft$/.test(pathname) && request.method() === 'PUT') {
      writes.push({ method: request.method(), pathname, body: request.postDataJSON(), role })
      return json(route, { ok: true })
    }
    if (/\/cms\/guest-site\/stay-policies\/company\/[^/]+\/impact$/.test(pathname) && request.method() === 'POST') {
      const section = pathname.split('/').at(-2)
      return json(route, {
        section, draft_revision: 2, impact_hash: 'a'.repeat(64), changed_count: 1,
        properties: [
          { property_id: property.id, property_code: property.code, property_title: property.hero_title, is_published: true, mode: 'follow_company', mode_revision: 1, override_revision: 0, changed: true, before: content(section, false), after: content(section, true) },
          { property_id: 'legacy-2', property_code: 'QA-102', property_title: 'Legacy property stays unchanged', is_published: true, mode: 'legacy', mode_revision: 1, override_revision: 0, changed: false, before: content(section, false), after: content(section, false) },
        ],
      })
    }
    if (/\/cms\/guest-site\/stay-policies\/company\/[^/]+\/preview$/.test(pathname) && request.method() === 'POST') {
      const section = pathname.split('/').at(-2)
      return json(route, { property_id: property.id, section, current_mode: 'legacy', applies_without_mode_change: false, current_property: previewFixture, candidate_property: previewFixture })
    }
    if (/\/cms\/guest-site\/stay-policies\/company\/[^/]+\/publish$/.test(pathname) && request.method() === 'POST') {
      writes.push({ method: request.method(), pathname, body: request.postDataJSON(), role })
      return json(route, { ok: true })
    }
    if (pathname === `/cms/guest-site/stay-policies/properties/${property.id}/house_rules/preview` && request.method() === 'POST') {
      return json(route, { property_id: property.id, section: 'house_rules', current_mode: 'legacy', applies_without_mode_change: false, current_property: previewFixture, candidate_property: previewFixture })
    }
    if (/\/cms\/guest-site\/stay-policies\/properties\/[^/]+\/[^/]+\/draft$/.test(pathname) && request.method() === 'PUT') {
      writes.push({ method: request.method(), pathname, body: request.postDataJSON(), role })
      return json(route, { ok: true })
    }
    if (/\/cms\/guest-site\/stay-policies\/properties\/[^/]+\/[^/]+\/mode$/.test(pathname) && request.method() === 'PUT') {
      const body = request.postDataJSON()
      writes.push({ method: request.method(), pathname, body, role })
      const section = pathname.split('/').at(-2)
      propertyOverview = { ...propertyOverview, sections: propertyOverview.sections.map((item) => item.section === section ? { ...item, mode: { ...item.mode, mode: body.mode, revision: item.mode.revision + 1 } } : item) }
      return json(route, { ok: true })
    }
    if (/\/cms\/guest-site\/stay-policies\/properties\/[^/]+\/[^/]+\/publish$/.test(pathname) && request.method() === 'POST') {
      writes.push({ method: request.method(), pathname, body: request.postDataJSON(), role })
      return json(route, { ok: true })
    }
    if (/\/cms\/guest-site\/stay-policies\/[^/]+\/bulk-follow$/.test(pathname) && request.method() === 'POST') {
      writes.push({ method: request.method(), pathname, body: request.postDataJSON(), role })
      return json(route, { ok: true })
    }
    return json(route, [])
  })
}

async function contextFor(browser, viewport, role = 'admin') {
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } })
  const payload = Buffer.from(JSON.stringify({ role, sub: `qa-${role}` })).toString('base64url')
  await context.addCookies([{ name: 'auth', value: `qa.${payload}.signature`, url: adminUrl }])
  return context
}

async function assertNoDocumentOverflow(page, label) {
  const geometry = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }))
  assert.ok(geometry.scroll <= geometry.client + 2, `${label} document overflow: ${JSON.stringify(geometry)}`)
}

async function clickConfirm(page, label) {
  const modal = page.locator('.ant-modal-confirm:visible').last()
  await modal.waitFor()
  const isConfirm = /^确认/.test(label)
  await modal.locator(isConfirm ? '.ant-btn-primary' : '.ant-btn-default').last().click()
  await modal.waitFor({ state: 'hidden' })
}

async function runPublisherWorkflow(browser) {
  const context = await contextFor(browser, viewports.at(-1))
  const page = await context.newPage()
  await installMocks(page, { previewProperty: allServicesPreviewProperty })
  await page.goto(`${adminUrl}/guest-site/settings`, { waitUntil: 'domcontentloaded' })
  await page.getByText('统一规则与入住服务', { exact: true }).waitFor()
  await page.locator('[data-policy-section="house_rules"]').waitFor()
  assert.equal(await page.getByText('版本记录（2）', { exact: true }).count(), 1)

  const beforeSave = writes.length
  await page.locator('[data-save-policy-draft="house_rules"]').click()
  await page.getByText('房屋守则草稿已保存，公开版本未改变', { exact: true }).waitFor()
  assert.equal(writes.length, beforeSave + 1)
  assert.match(writes.at(-1).pathname, /house_rules\/draft$/)

  await page.locator('[data-impact-policy="house_rules"]').click()
  await page.getByText('发布影响清单 · 1 套会改变', { exact: true }).waitFor()
  await page.getByText('QA-101 · Policy preview apartment', { exact: true }).waitFor()
  await page.getByText('QA-102 · Legacy property stays unchanged', { exact: true }).waitFor()
  const publishButton = page.locator('[data-publish-policy="house_rules"]')
  const beforePublish = writes.length
  await publishButton.click()
  await clickConfirm(page, '返回影响清单')
  assert.equal(writes.length, beforePublish, 'cancelled company publish still wrote data')
  await publishButton.click()
  await clickConfirm(page, '确认发布此分区')
  await page.getByText('房屋守则已发布', { exact: true }).waitFor()
  assert.equal(writes.filter((entry) => /company\/house_rules\/publish$/.test(entry.pathname)).length, 1)

  const house = page.locator('[data-policy-section="house_rules"]')
  await house.locator('.ant-select').click()
  await page.locator('.ant-select-item-option').filter({ hasText: 'QA-101' }).click()
  await house.locator('[data-preview-policy="house_rules"]').click()
  const previewFrame = page.frameLocator('[data-policy-preview]')
  await previewFrame.getByRole('heading', { name: 'Policy preview apartment', exact: true }).waitFor()
  await previewFrame.getByRole('heading', { name: 'Frequently asked questions', exact: true }).waitFor()
  await previewFrame.getByRole('heading', { name: 'Can I check in early?', exact: true }).waitFor()
  await previewFrame.getByRole('heading', { name: 'Can I check out late?', exact: true }).waitFor()
  await previewFrame.getByRole('heading', { name: 'Can I drop off my luggage before check-in?', exact: true }).waitFor()
  await previewFrame.getByText('No fee · Advance request', { exact: true }).waitFor()
  await previewFrame.getByText('Until 11:30AM · A$20', { exact: true }).waitFor()
  await previewFrame.getByText('Advance confirmation required', { exact: true }).waitFor()
  assert.equal(await previewFrame.getByText('Q&A', { exact: true }).count(), 3, 'all enabled FAQ labels were not rendered')
  const companyFaq = previewFrame.locator('#stay-requests')
  await companyFaq.scrollIntoViewIfNeeded()
  await companyFaq.screenshot({ path: path.join(outputDir, '1440-company-preview-faq.png') })
  await page.screenshot({ path: path.join(outputDir, '1440-company-preview.png'), fullPage: false })
  await page.keyboard.press('Escape')

  await page.goto(`${adminUrl}/guest-site/properties`, { waitUntil: 'domcontentloaded' })
  await page.locator(`[data-policy-current="${property.id}"]`).click()
  await page.locator('[data-property-policy-section="house_rules"]').waitFor()
  const beforeMode = writes.length
  await page.locator('[data-mode-follow="house_rules"]').click()
  await clickConfirm(page, '取消')
  assert.equal(writes.length, beforeMode, 'cancelled mode switch still wrote data')
  await page.locator('[data-mode-follow="house_rules"]').click()
  await clickConfirm(page, '确认切换公开模式')
  await page.getByText('已切换为跟随公司', { exact: true }).waitFor()
  assert.equal(writes.filter((entry) => /house_rules\/mode$/.test(entry.pathname)).length, 1)

  await page.locator('[data-publish-property-policy="house_rules"]').click()
  await clickConfirm(page, '确认发布单房覆盖')
  await page.getByText('单房覆盖已发布并生效', { exact: true }).waitFor()
  assert.equal(writes.filter((entry) => /house_rules\/publish$/.test(entry.pathname) && entry.pathname.includes('/properties/')).length, 1)
  await page.locator('.ant-drawer:visible .ant-drawer-close').last().click()
  await page.locator('[data-property-policy-section="house_rules"]').waitFor({ state: 'hidden' })

  const row = page.locator('.ant-table-tbody .ant-table-row').filter({ hasText: property.code })
  await row.locator('.ant-checkbox-wrapper').click()
  await page.locator('[data-bulk-follow-policy]').click()
  await clickConfirm(page, '确认整批跟随公司')
  await page.getByText(/1 套房源已显式改为跟随房屋守则/).waitFor()
  assert.equal(writes.filter((entry) => /house_rules\/bulk-follow$/.test(entry.pathname)).length, 1)
  await context.close()
}

async function runNonPublisher(browser) {
  const start = writes.length
  const permissions = ['guest_site_settings.view', 'guest_site_settings.write', 'guest_site_properties.view', 'guest_site_properties.write']
  const context = await contextFor(browser, viewports[1], 'policy-editor')
  const page = await context.newPage()
  await installMocks(page, { role: 'policy-editor', permissions })
  await page.goto(`${adminUrl}/guest-site/settings`, { waitUntil: 'domcontentloaded' })
  await page.getByText('当前账号没有规则发布权限', { exact: true }).waitFor()
  await page.locator('[data-impact-policy="house_rules"]').click()
  await page.getByText('发布影响清单 · 1 套会改变', { exact: true }).waitFor()
  assert.equal(await page.locator('[data-publish-policy="house_rules"]').isDisabled(), true)
  await page.goto(`${adminUrl}/guest-site/properties`, { waitUntil: 'domcontentloaded' })
  assert.equal(await page.locator('[data-bulk-follow-policy]').isDisabled(), true)
  const checkbox = page.locator('.ant-table-tbody .ant-checkbox-input').first()
  assert.equal(await checkbox.isDisabled(), true)
  await page.locator(`[data-policy-current="${property.id}"]`).click()
  await page.locator('[data-property-policy-section="house_rules"]').waitFor()
  assert.equal(await page.locator('[data-mode-follow="house_rules"]').isDisabled(), true)
  assert.equal(await page.locator('[data-publish-property-policy="house_rules"]').isDisabled(), true)
  assert.equal(writes.length, start, 'non-publisher triggered a protected policy write')
  await context.close()
}

async function runSchemaMissing(browser) {
  const start = writes.length
  const context = await contextFor(browser, viewports[1])
  const page = await context.newPage()
  await installMocks(page, { schemaMissing: true })
  await page.goto(`${adminUrl}/guest-site/settings`, { waitUntil: 'domcontentloaded' })
  const missingAlert = page.getByText('当前环境尚未启用统一规则存储', { exact: true })
  await missingAlert.waitFor()
  await page.getByText(/原有公开房源会继续使用各房源的旧规则与时间/).waitFor()
  assert.equal(await page.locator('[data-policy-section]').count(), 0)
  assert.equal(writes.length, start)
  await missingAlert.scrollIntoViewIfNeeded()
  await page.screenshot({ path: path.join(outputDir, '390-schema-missing.png'), fullPage: false })
  await context.close()
}

async function runResponsive(browser, viewport) {
  const context = await contextFor(browser, viewport)
  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await installMocks(page)
  await page.goto(`${adminUrl}/guest-site/settings`, { waitUntil: 'domcontentloaded' })
  await page.getByText('统一规则与入住服务', { exact: true }).waitFor()
  const settingsSection = page.locator('[data-policy-section="house_rules"]')
  await settingsSection.waitFor()
  await assertNoDocumentOverflow(page, `${viewport.name} settings`)
  await settingsSection.scrollIntoViewIfNeeded()
  await page.screenshot({ path: path.join(outputDir, `${viewport.name}-settings.png`), fullPage: false })

  await page.goto(`${adminUrl}/guest-site/properties`, { waitUntil: 'domcontentloaded' })
  await page.locator(`[data-policy-current="${property.id}"]`).click()
  const drawerSection = page.locator('[data-property-policy-section="house_rules"]')
  await drawerSection.waitFor()
  await page.waitForTimeout(520)
  const drawerGeometry = await page.locator('.ant-drawer:visible .ant-drawer-content-wrapper').last().evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return { left: rect.left, right: rect.right, viewport: document.documentElement.clientWidth, pageWidth: document.documentElement.scrollWidth }
  })
  assert.ok(drawerGeometry.left >= -1 && drawerGeometry.right <= drawerGeometry.viewport + 1, `${viewport.name} policy drawer escaped viewport: ${JSON.stringify(drawerGeometry)}`)
  assert.ok(drawerGeometry.pageWidth <= drawerGeometry.viewport + 2, `${viewport.name} property policy page overflowed`)
  await page.locator('[data-preview-property-policy="house_rules"]').click()
  const frame = page.locator('[data-policy-preview]')
  await frame.waitFor()
  await page.waitForTimeout(520)
  const frameGeometry = await frame.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return { left: rect.left, right: rect.right, viewport: document.documentElement.clientWidth }
  })
  assert.ok(frameGeometry.left >= -1 && frameGeometry.right <= frameGeometry.viewport + 1, `${viewport.name} policy preview escaped viewport: ${JSON.stringify(frameGeometry)}`)
  const preview = page.frameLocator('[data-policy-preview]')
  await preview.getByText('Candidate rule from the unified policy.', { exact: true }).waitFor()
  await preview.getByRole('heading', { name: 'Frequently asked questions', exact: true }).waitFor()
  await preview.getByRole('heading', { name: 'Can I check in early?', exact: true }).waitFor()
  await preview.getByRole('heading', { name: 'Can I drop off my luggage before check-in?', exact: true }).waitFor()
  await preview.getByText('No fee · Advance request', { exact: true }).waitFor()
  await preview.getByText('Advance confirmation required', { exact: true }).waitFor()
  assert.equal(await preview.getByRole('heading', { name: 'Can I check out late?', exact: true }).count(), 0, `${viewport.name} disabled FAQ leaked into preview`)
  const faq = preview.locator('#stay-requests')
  const faqGeometry = await faq.evaluate((element) => ({ client: element.clientWidth, scroll: element.scrollWidth }))
  assert.ok(faqGeometry.scroll <= faqGeometry.client + 1, `${viewport.name} FAQ overflowed horizontally: ${JSON.stringify(faqGeometry)}`)
  if (viewport.name === '390-mobile' || viewport.name === '1440-desktop') {
    await faq.scrollIntoViewIfNeeded()
    await faq.screenshot({ path: path.join(outputDir, `${viewport.name}-property-preview-faq.png`) })
  }
  await page.screenshot({ path: path.join(outputDir, `${viewport.name}-property-preview.png`), fullPage: false })
  assert.deepEqual(pageErrors, [], `${viewport.name} page errors: ${pageErrors.join(' | ')}`)
  await context.close()
}

async function main() {
  fs.mkdirSync(outputDir, { recursive: true })
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  try {
    await runPublisherWorkflow(browser)
    await runNonPublisher(browser)
    await runSchemaMissing(browser)
    for (const viewport of viewports) await runResponsive(browser, viewport)
  } finally {
    await browser.close()
  }
  console.log(JSON.stringify({
    ok: true,
    viewports: viewports.map((viewport) => viewport.name),
    protectedWrites: writes.map((entry) => ({ method: entry.method, pathname: entry.pathname, role: entry.role })),
    databaseWrites: 0,
    outputDir,
  }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
