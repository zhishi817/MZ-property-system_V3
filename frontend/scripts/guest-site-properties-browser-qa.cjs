const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require(path.resolve(__dirname, '../../backend/node_modules/playwright'))

const baseUrl = process.env.GUEST_SITE_ADMIN_QA_URL || 'http://127.0.0.1:3006'
const bookingUrl = process.env.GUEST_SITE_BOOKING_QA_URL || 'http://127.0.0.1:3004'
const outputDir = path.resolve(__dirname, '../../output/guest-site-property-admin')
const viewports = [
  { name: '320-narrow', width: 320, height: 700 },
  { name: '390-mobile', width: 390, height: 844 },
  { name: '768-tablet', width: 768, height: 1024 },
  { name: '1024-small-desktop', width: 1024, height: 800 },
  { name: '1440-desktop', width: 1440, height: 1000 },
]
const wideAmenitiesViewport = { name: '1660-wide-desktop', width: 1660, height: 1050 }

const categories = [
  { key: 'kitchen-appliances', label_zh: '厨房电器', label_en: 'Kitchen appliances' },
  { key: 'coffee', label_zh: '咖啡设备', label_en: 'Coffee' },
  { key: 'kitchenware', label_zh: '厨房用品', label_en: 'Kitchenware' },
  { key: 'laundry', label_zh: '洗衣', label_en: 'Laundry' },
  { key: 'network', label_zh: '网络与工作', label_en: 'Internet & work' },
  { key: 'parking', label_zh: '停车', label_en: 'Parking' },
  { key: 'building', label_zh: '楼宇设施', label_en: 'Building facilities' },
  { key: 'baby-amenities', label_zh: '婴幼儿用品', label_en: 'Baby amenities' },
]

const items = [
  ['kettle', 'kitchen-appliances', '热水壶', 'Kettle', 'kettle'],
  ['toaster', 'kitchen-appliances', '烤面包机', 'Toaster', 'toaster'],
  ['microwave', 'kitchen-appliances', '微波炉', 'Microwave', 'microwave'],
  ['oven', 'kitchen-appliances', '烤箱', 'Oven', 'oven'],
  ['dishwasher', 'kitchen-appliances', '洗碗机', 'Dishwasher', 'dishwasher'],
  ['pod-coffee-machine', 'coffee', '胶囊咖啡机', 'Pod coffee machine', 'coffee'],
  ['espresso-machine', 'coffee', '意式咖啡机', 'Espresso machine', 'coffee'],
  ['filter-coffee-maker', 'coffee', '滴滤咖啡机', 'Filter coffee maker', 'coffee'],
  ['french-press', 'coffee', '法压壶', 'French press', 'coffee'],
  ['coffee-pods-provided', 'coffee', '提供咖啡胶囊', 'Coffee pods provided', 'coffee-pod'],
  ['pots-and-pans', 'kitchenware', '锅具', 'Pots and pans', 'pan'],
  ['cutlery', 'kitchenware', '餐具', 'Cutlery', 'cutlery'],
  ['plates-and-bowls', 'kitchenware', '盘碗', 'Plates and bowls', 'plate'],
  ['glassware', 'kitchenware', '杯具', 'Glassware', 'glass'],
  ['cooking-utensils', 'kitchenware', '烹饪用具', 'Cooking utensils', 'utensils'],
  ['kitchen-knives', 'kitchenware', '厨房刀具', 'Kitchen knives', 'knife'],
  ['cutting-board', 'kitchenware', '砧板', 'Cutting board', 'cutting-board'],
  ['washing-machine', 'laundry', '洗衣机', 'Washing machine', 'washing-machine'],
  ['separate-dryer', 'laundry', '独立烘干机', 'Separate dryer', 'dryer'],
  ['washer-dryer-combo', 'laundry', '洗烘一体机', 'Washer-dryer combo', 'washer-dryer'],
  ['drying-rack', 'laundry', '晾衣架', 'Drying rack', 'drying-rack'],
  ['laundry-detergent', 'laundry', '洗衣液', 'Laundry detergent', 'detergent'],
  ['wifi', 'network', '无线网络', 'Wi-Fi', 'wifi'],
  ['free-parking', 'parking', '免费停车', 'Free parking', 'parking'],
  ['swimming-pool', 'building', '游泳池', 'Swimming pool', 'pool'],
  ['gym', 'building', '健身房', 'Gym', 'gym'],
  ['baby-cot', 'baby-amenities', '婴儿床', 'Baby cot', 'baby-cot', 'provided'],
  ['high-chair', 'baby-amenities', '婴儿餐椅', 'High chair', 'high-chair', 'provided'],
].map(([key, categoryKey, labelZh, labelEn, icon, companyDefaultStatus]) => {
  const group = categories.find((entry) => entry.key === categoryKey)
  return {
    key,
    category_key: categoryKey,
    category_label_zh: group.label_zh,
    category_label_en: group.label_en,
    label_zh: labelZh,
    label_en: labelEn,
    icon,
    ...(companyDefaultStatus ? { company_default_status: companyDefaultStatus } : {}),
  }
})

const catalog = {
  statuses: ['provided', 'not_provided', 'pending'],
  categories,
  items,
  templates: [{
    id: 'standard-apartment-candidates',
    name_zh: '标准公寓候选',
    description_zh: 'QA template',
    amenity_keys: ['kettle', 'pod-coffee-machine', 'washing-machine', 'wifi'],
  }],
}

let managedTemplates = [{
  id: 'template-company-1', scope: 'company', scope_key: '', name: 'Company essentials',
  amenity_candidates: [{ key: 'wifi' }, { key: 'kettle' }], is_active: true,
  created_at: '2026-10-02T00:00:00.000Z', updated_at: '2026-10-02T00:00:00.000Z',
}]
const templateMutations = []

const notReady = {
  ready: false,
  items: [
    { key: 'title', label: '英文标题', ready: true, message: '' },
    { key: 'description', label: '英文简介', ready: true, message: '' },
    { key: 'cover', label: '封面图片', ready: true, message: '' },
    { key: 'region', label: '公开区域', ready: true, message: '' },
    { key: 'capacity', label: '入住人数', ready: true, message: '' },
    { key: 'amenities', label: '已确认设施', ready: false, message: '至少确认一项实际提供的设施' },
    { key: 'company-default-amenities', label: '公司默认婴儿设施', ready: true, message: '' },
    { key: 'times', label: '入住退房时间', ready: true, message: '' },
    { key: 'english', label: '英文公开内容', ready: true, message: '' },
  ],
}

let rows = [
  {
    id: 'target-0', code: 'QA-000', address: 'Internal exact address', region: 'Docklands', type: 'Apartment', capacity: 2,
    building_name: 'Harbour Tower', building_facilities: ['Swimming pool', 'Gym', 'Unverified cinema'], airbnb_listing_name: 'Legacy source title',
    is_published: false, hero_title: 'Keep this unique title', short_description: 'A calm waterfront stay for two.', long_description: '',
    hero_image_url: `${bookingUrl}/homepage/testimonial.jpg`, gallery_urls: [`${bookingUrl}/homepage/testimonial.jpg`], feature_tags: ['Keep my current tag'], amenities: ['免费停车', 'Portable cot'], amenity_selections: [],
    legacy_amenity_candidates: [{ key: 'free-parking', status: 'pending' }, { key: 'custom:portable-cot', status: 'pending', custom_label: 'Portable cot', custom_category: 'Other' }],
    house_rules: [], sort_order: 0, public_region_label: 'Docklands', public_capacity_override: null,
    bedroom_count: 1, bathroom_count: 1, bed_count: 1, checkin_time: '4PM', checkout_time: '10 AM',
    location_note: 'Internal note once only', price_label: 'A$128', booking_highlights: [], publish_readiness: notReady,
  },
  {
    id: 'source-1', code: 'QA-101', address: 'Another internal address', region: 'Southbank', type: 'Apartment', capacity: 4,
    building_name: 'River Tower', building_facilities: ['Swimming pool'], airbnb_listing_name: 'Source listing title',
    is_published: true, hero_title: 'Do not copy this title', short_description: 'Do not copy this description.', long_description: 'Do not copy.',
    hero_image_url: `${bookingUrl}/homepage/testimonial.jpg`, gallery_urls: [`${bookingUrl}/homepage/testimonial.jpg`], feature_tags: ['Entire apartment', 'Self check-in'], amenities: ['Wi-Fi'],
    amenity_selections: [{ key: 'wifi', status: 'provided' }], house_rules: ['No smoking', 'No pets'], sort_order: 10,
    public_region_label: 'Southbank', public_capacity_override: 4, bedroom_count: 2, bathroom_count: 2, bed_count: 2,
    checkin_time: '15:00', checkout_time: '10:00', location_note: 'Private source note', price_label: 'A$999',
    booking_highlights: ['Long-stay enquiries welcome'], publish_readiness: { ...notReady, ready: true, items: notReady.items.map((entry) => ({ ...entry, ready: true })) },
  },
  {
    id: 'visual-amenities', code: 'QA-202', address: 'Visual fixture address', region: 'Docklands', type: 'Apartment', capacity: 4,
    building_name: 'Visual Fixture Tower', building_facilities: [], airbnb_listing_name: '', is_published: false,
    hero_title: 'Semantic amenities fixture', short_description: 'Responsive visual verification for confirmed amenities.', long_description: '',
    hero_image_url: `${bookingUrl}/homepage/testimonial.jpg`, gallery_urls: [`${bookingUrl}/homepage/testimonial.jpg`], feature_tags: ['Entire apartment'], amenities: [],
    amenity_selections: [
      ...items.filter((item) => !item.company_default_status).map((item) => ({ key: item.key, status: 'provided' })),
      { key: 'custom:extended-remote-work', status: 'provided', custom_label: 'Workspace suitable for extended remote-working stays', custom_category: 'Other' },
    ], legacy_amenity_candidates: [], house_rules: ['No smoking'], sort_order: 20,
    public_region_label: 'Docklands', public_capacity_override: 4, bedroom_count: 2, bathroom_count: 1, bed_count: 2,
    checkin_time: '3PM', checkout_time: '10AM', location_note: '', price_label: '', booking_highlights: [],
    publish_readiness: { ...notReady, ready: true, items: notReady.items.map((entry) => ({ ...entry, ready: true })) },
  },
]

const patches = []
const requestedUrls = []
const browserRequests = []

function json(route, payload, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) })
}

async function installApiMock(page, options = {}) {
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const pathname = url.pathname.replace(/^\/api/, '')
    requestedUrls.push(`${request.method()} ${pathname}`)
    if (pathname === '/auth/me') return json(route, { username: 'qa-admin', role: 'admin' })
    if (pathname === '/rbac/my-permissions') return json(route, ['guest_site_properties.view', 'guest_site_properties.write'])
    if (pathname === '/cms/guest-site/amenity-catalog') return json(route, catalog)
    if (pathname === '/cms/guest-site/amenity-templates' && request.method() === 'GET') {
      if (options.templateSchemaReady === false) return json(route, { schema_ready: false, templates: [] })
      const buildingName = String(url.searchParams.get('building_name') || '')
      return json(route, {
        schema_ready: true,
        templates: managedTemplates.filter((template) => template.scope === 'company' || (template.scope === 'building' && template.scope_key === buildingName)),
      })
    }
    if (pathname === '/cms/guest-site/amenity-templates' && request.method() === 'POST') {
      const body = request.postDataJSON()
      const created = {
        id: `template-${managedTemplates.length + 1}`,
        ...body,
        is_active: true,
        created_at: '2026-10-02T00:00:00.000Z',
        updated_at: '2026-10-02T00:00:00.000Z',
      }
      managedTemplates.push(created)
      templateMutations.push({ method: 'POST', id: created.id, body })
      return json(route, created, 201)
    }
    if (pathname.startsWith('/cms/guest-site/amenity-templates/') && request.method() === 'PATCH') {
      const id = decodeURIComponent(pathname.split('/').pop())
      const body = request.postDataJSON()
      managedTemplates = managedTemplates.map((template) => template.id === id ? { ...template, ...body, updated_at: '2026-10-02T01:00:00.000Z' } : template)
      templateMutations.push({ method: 'PATCH', id, body })
      const updated = managedTemplates.find((template) => template.id === id)
      return updated ? json(route, updated) : json(route, { message: 'amenity_template_not_found' }, 404)
    }
    if (pathname === '/cms/guest-site/properties' && request.method() === 'GET') return json(route, rows)
    if (pathname.startsWith('/cms/guest-site/properties/') && request.method() === 'PATCH') {
      const id = decodeURIComponent(pathname.split('/').pop())
      const body = request.postDataJSON()
      patches.push({ id, body })
      rows = rows.map((row) => row.id === id ? { ...row, ...body } : row)
      return json(route, rows.find((row) => row.id === id))
    }
    if (pathname === '/notifications/unread-count') return json(route, { count: 0 })
    if (pathname === '/version') return json(route, { version: 'qa' })
    if (pathname === '/health') return json(route, { ok: true })
    return json(route, [])
  })
}

async function runUnmigratedTemplateCompatibility(browser) {
  const context = await newAdminContext(browser, { width: 390, height: 844 })
  const page = await context.newPage()
  await installApiMock(page, { templateSchemaReady: false })
  await page.goto(`${baseUrl}/guest-site/properties`, { waitUntil: 'domcontentloaded' })
  await page.locator('[data-edit-current="target-0"]').click()
  await page.getByText('可维护模板存储尚未启用', { exact: true }).waitFor()
  await page.waitForTimeout(500)
  await page.getByText('可维护模板存储尚未启用', { exact: true }).scrollIntoViewIfNeeded()
  assert.equal(await page.locator('[data-managed-template-section]').count(), 0, 'unmigrated environment exposed persisted template controls')
  assert.equal(await page.locator('[data-apply-standard-template]').isEnabled(), true, 'unmigrated environment disabled the existing built-in candidate flow')
  await page.screenshot({ path: path.join(outputDir, '390-template-schema-pending.png'), fullPage: false })
  await context.close()
}

async function newAdminContext(browser, viewport) {
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } })
  const payload = Buffer.from(JSON.stringify({ role: 'admin', sub: 'qa-admin' })).toString('base64url')
  await context.addCookies([{ name: 'auth', value: `qa.${payload}.signature`, url: baseUrl }])
  return context
}

async function assertHealthyPage(page, label, consoleErrors, pageErrors) {
  await page.getByText('预订网站房源展示', { exact: true }).first().waitFor()
  const state = await page.evaluate(() => ({
    bodyText: document.body.innerText.trim().length,
    viewport: document.documentElement.clientWidth,
    pageWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    overlay: !!document.querySelector('[data-nextjs-dialog], .vite-error-overlay, #webpack-dev-server-client-overlay'),
  }))
  assert.ok(state.bodyText > 200, `${label} rendered blank or incomplete content`)
  assert.equal(state.overlay, false, `${label} rendered a framework error overlay`)
  assert.ok(state.pageWidth <= state.viewport + 2, `${label} document overflow ${state.pageWidth} > ${state.viewport}`)
  assert.deepEqual(pageErrors, [], `${label} page errors: ${pageErrors.join(' | ')}`)
  assert.deepEqual(consoleErrors, [], `${label} console errors: ${consoleErrors.join(' | ')}`)
}

async function dismissConfirm(page, actionName) {
  const modal = page.locator('.ant-modal-confirm').last()
  await modal.waitFor()
  const button = actionName === '取消' ? modal.locator('.ant-btn-default').last() : modal.locator('.ant-btn-primary').last()
  await button.click()
  await modal.waitFor({ state: 'hidden' })
}

async function runWorkflow(browser) {
  const context = await newAdminContext(browser, { width: 1440, height: 1000 })
  const page = await context.newPage()
  const consoleErrors = []
  const pageErrors = []
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(`${message.text()} @ ${message.location().url || 'unknown'}`) })
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('request', (request) => browserRequests.push(`${request.method()} ${request.url()}`))
  await installApiMock(page)
  await page.goto(`${baseUrl}/guest-site/properties`, { waitUntil: 'domcontentloaded' })
  await assertHealthyPage(page, 'admin workflow', consoleErrors, pageErrors)

  await page.locator('.ant-table-tbody .ant-table-row').filter({ hasText: 'QA-000' }).waitFor()
  const rowsText = await page.locator('.ant-table-tbody .ant-table-row').allInnerTexts()
  assert.match(rowsText[0], /QA-000/, 'sort_order 0 was not rendered first')

  await page.locator('[data-edit-and-publish="target-0"]').click()
  await page.getByText('当前内容未公开', { exact: true }).waitFor()
  await page.getByText('公司默认 2', { exact: true }).waitFor()
  for (const key of ['baby-cot', 'high-chair']) {
    const defaultRow = page.locator(`[data-amenity-key="${key}"]`)
    await defaultRow.getByText('公司默认 · 全房已提供', { exact: true }).waitFor()
    assert.equal(await defaultRow.locator('.ant-radio-group').count(), 0, `${key} exposed a per-property status control`)
  }
  assert.equal(await page.locator('[data-checkin-time-select] .ant-select-selection-item').innerText(), '4PM（现有非标准值）')
  assert.equal(await page.locator('[data-checkout-time-select] .ant-select-selection-item').innerText(), '10AM（公司标准）')
  await page.getByText('请选择公司标准时间', { exact: true }).waitFor()
  await page.locator('[data-checkin-time-select]').click()
  await page.locator('.ant-select-item-option').filter({ hasText: '3PM（公司标准）' }).click()
  await page.getByText('请选择公司标准时间', { exact: true }).waitFor({ state: 'hidden' })
  assert.equal(await page.locator('[data-checkin-time-select] .ant-select-selection-item').innerText(), '3PM（公司标准）')
  const standardsText = await page.locator('.ant-alert').filter({ hasText: '已确认的公司标准' }).innerText()
  assert.match(standardsText, /早入住免费，需提前申请，团队会尽量安排但不保证/)
  assert.match(standardsText, /标准入住 3PM、退房 10AM/)
  assert.match(standardsText, /晚退房到 11:30AM 为 A\$20，需按实际可用情况人工确认/)
  assert.doesNotMatch(standardsText, /3:00 PM|10:00 AM|早入住[^；。]*11:30AM|支付时点|自动确认/)

  await page.getByText('Company essentials', { exact: true }).waitFor()
  await page.locator('[data-amenity-key="wifi"]').getByText('不提供', { exact: true }).click()
  await page.locator('[data-template-apply="template-company-1"]').click()
  await dismissConfirm(page, '加入待确认')
  await page.getByText('不提供 1', { exact: true }).waitFor()
  await page.getByText('待确认 1', { exact: true }).waitFor()

  await page.locator('[data-template-new]').click()
  await page.locator('[data-template-name]').fill('Harbour shared areas')
  await page.locator('[data-template-scope]').click()
  await page.locator('.ant-select-item-option').filter({ hasText: '楼宇模板' }).click()
  const templateCandidateSelect = page.locator('[data-template-candidates]')
  await templateCandidateSelect.click()
  await templateCandidateSelect.locator('input').fill('Baby cot')
  const babyDefaultOption = page.locator('.ant-select-item-option').filter({ hasText: 'Baby cot（公司默认，无需加入模板）' })
  await babyDefaultOption.waitFor()
  assert.match(await babyDefaultOption.getAttribute('class'), /ant-select-item-option-disabled/, 'company default was selectable in a template')
  await templateCandidateSelect.locator('input').fill('Swimming pool')
  await page.keyboard.press('Enter')
  await templateCandidateSelect.locator('input').fill('Gym')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Escape')
  await page.locator('[data-template-save]').click()
  await page.getByText('Harbour shared areas', { exact: true }).waitFor()
  const createTemplateMutation = templateMutations.find((entry) => entry.method === 'POST')
  assert.ok(createTemplateMutation, 'building template create was not called')
  assert.equal(createTemplateMutation.body.scope, 'building')
  assert.equal(createTemplateMutation.body.scope_key, 'Harbour Tower')
  assert.equal(createTemplateMutation.body.amenity_candidates.every((candidate) => !Object.hasOwn(candidate, 'status')), true, 'template persisted property statuses')

  await page.locator('[data-template-edit="template-2"]').click()
  await page.locator('[data-template-name]').fill('Harbour facilities')
  await page.locator('[data-template-save]').click()
  await page.getByText('Harbour facilities', { exact: true }).waitFor()
  await page.locator('[data-template-apply="template-2"]').click()
  await dismissConfirm(page, '加入待确认')
  await page.getByText('待确认 3', { exact: true }).waitFor()
  await page.locator('[data-template-toggle="template-2"]').click()
  await dismissConfirm(page, '确认停用')
  await page.locator('[data-managed-template="template-2"]').getByText('已停用', { exact: true }).waitFor()
  await page.locator('[data-template-toggle="template-2"]').click()
  await page.locator('[data-managed-template="template-2"]').getByText('启用', { exact: true }).waitFor()
  assert.ok(templateMutations.some((entry) => entry.method === 'PATCH' && entry.id === 'template-2' && entry.body.name === 'Harbour facilities'), 'template edit was not called')
  assert.ok(templateMutations.some((entry) => entry.method === 'PATCH' && entry.id === 'template-2' && entry.body.is_active === false), 'template deactivate was not called')
  assert.ok(templateMutations.some((entry) => entry.method === 'PATCH' && entry.id === 'template-2' && entry.body.is_active === true), 'template reactivate was not called')
  await page.screenshot({ path: path.join(outputDir, '1440-managed-templates.png'), fullPage: false })

  await page.locator('.ant-drawer-close').first().click()
  await page.getByText('当前内容未公开', { exact: true }).waitFor({ state: 'hidden' })
  await page.locator('[data-edit-and-publish="target-0"]').click()
  await page.getByText('当前内容未公开', { exact: true }).waitFor()
  assert.equal(await page.locator('[data-checkin-time-select] .ant-select-selection-item').innerText(), '4PM（现有非标准值）', 'closing without saving unexpectedly changed the existing non-standard time')
  await page.locator('[data-checkin-time-select]').click()
  await page.locator('.ant-select-item-option').filter({ hasText: '3PM（公司标准）' }).click()

  const publicRequestsBefore = requestedUrls.filter((entry) => entry.includes('/public/')).length
  const propertyWritesBeforePreview = patches.length
  const titleInput = page.getByLabel('前台英文主标题')
  await titleInput.fill('Unsaved waterfront draft preview')
  assert.equal(await page.locator('[data-checkin-time-select] .ant-select-selection-item').innerText(), '3PM（公司标准）', 'check-in selection reverted before preview')
  assert.equal(await page.locator('[data-checkout-time-select] .ant-select-selection-item').innerText(), '10AM（公司标准）', 'check-out selection reverted before preview')
  await page.locator('[data-preview-current]').click()
  const previewFrameElement = page.locator('[data-admin-property-preview]')
  const previewFrame = page.frameLocator('[data-admin-property-preview]')
  await previewFrameElement.waitFor()
  await previewFrame.locator('[data-property-detail][data-admin-draft-preview="true"]').waitFor()
  await previewFrame.getByRole('heading', { name: 'Unsaved waterfront draft preview', exact: true }).waitFor()
  const previewText = await previewFrame.locator('body').innerText()
  assert.match(previewText, /UNPUBLISHED · ADMIN ONLY/i)
  assert.match(previewText, /No fee · Advance request/)
  assert.match(previewText, /Until 11:30AM · A\$20/)
  assert.match(previewText, /Check-in\s+3PM\s+Check-out\s+10AM/i)
  assert.match(previewText, /Baby cot/)
  assert.match(previewText, /High chair/)
  assert.equal(await previewFrame.locator('[data-amenity-summary]').count(), 1, 'empty per-property selection did not use the compact default summary')
  assert.equal(await previewFrame.getByRole('button', { name: 'View all amenities' }).count(), 0, 'two company defaults exposed a meaningless expand action')
  assert.equal(await previewFrame.locator('[data-amenity-item="baby-cot"] svg').count(), 1, 'draft preview omitted the Baby cot semantic icon')
  assert.equal(await previewFrame.locator('[data-amenity-item="high-chair"] svg').count(), 1, 'draft preview omitted the High chair semantic icon')
  assert.doesNotMatch(previewText, /3:00 PM|10:00 AM|From 11:30AM|Payment timing|Ask before you arrive|Optional stay requests/)
  assert.equal(await previewFrame.locator('#before-arrival').getByRole('heading', { name: 'Before you arrive', exact: true }).count(), 1, 'draft preview did not use the merged arrival section')
  for (const privateValue of ['Internal exact address', 'QA-000', 'Internal note once only', 'Harbour Tower']) {
    assert.doesNotMatch(previewText, new RegExp(privateValue), `draft preview exposed private value: ${privateValue}`)
  }
  assert.equal(browserRequests.some((entry) => entry.includes('/property-detail-data/')), false, 'draft preview requested availability')
  assert.equal(browserRequests.some((entry) => entry.includes('/public/guest-site/properties')), false, 'draft preview requested a public property')
  assert.equal(patches.length, propertyWritesBeforePreview, 'opening draft preview wrote property data')
  await page.screenshot({ path: path.join(outputDir, '1440-unpublished-real-detail-preview.png') })
  assert.equal(requestedUrls.filter((entry) => entry.includes('/public/')).length, publicRequestsBefore, 'unpublished preview used a public endpoint')
  await page.keyboard.press('Escape')
  await page.locator('[data-admin-property-preview]').waitFor({ state: 'hidden' })
  await titleInput.fill('')
  await page.locator('[data-preview-current]').click()
  await page.frameLocator('[data-admin-property-preview]').getByRole('heading', { name: 'Preview unavailable' }).waitFor()
  assert.equal(await page.frameLocator('[data-admin-property-preview]').locator('[data-property-detail]').count(), 0, 'empty draft rendered a property detail')
  await page.keyboard.press('Escape')
  await page.locator('[data-admin-property-preview]').waitFor({ state: 'hidden' })
  await titleInput.fill('Keep this unique title')

  await page.locator('[data-apply-standard-template]').click()
  await dismissConfirm(page, '取消')
  await page.getByText('待确认 0', { exact: true }).waitFor()
  await page.locator('[data-apply-legacy-candidates]').click()
  await dismissConfirm(page, '加入待确认')
  await page.getByText('待确认 2', { exact: true }).waitFor()
  await page.locator('[data-apply-standard-template]').click()
  await dismissConfirm(page, '加入待确认')
  await page.getByText('待确认 6', { exact: true }).waitFor()
  await page.locator('[data-apply-standard-template]').click()
  await page.getByText(/没有新的候选项/, { exact: false }).waitFor()
  assert.equal(await page.getByText('待确认 6', { exact: true }).count(), 1, 'reapplying the template duplicated candidate amenities')

  await page.locator('[data-save-current]').click()
  await page.getByText('未发布内容已保存', { exact: true }).waitFor()
  assert.equal(patches.at(-1).body.is_published, false, 'save unpublished unexpectedly published the property')
  assert.equal(patches.at(-1).body.checkin_time, '3PM', 'save payload did not canonicalise check-in')
  assert.equal(patches.at(-1).body.checkout_time, '10AM', 'save payload did not canonicalise check-out')
  assert.equal(patches.at(-1).body.amenity_selections.length, 6, 'candidate amenities were not persisted')
  assert.equal(patches.at(-1).body.amenity_selections.some((item) => item.key === 'baby-cot' || item.key === 'high-chair'), false, 'save payload persisted company defaults per property')
  assert.deepEqual(patches.at(-1).body.amenities, ['免费停车', 'Portable cot'], 'saving unrelated fields silently rewrote legacy amenities')

  await page.locator('[data-edit-and-publish="target-0"]').click()
  await page.locator('[data-amenity-key="wifi"]').getByText('已提供', { exact: true }).click()
  await page.getByText('单套已提供 1', { exact: true }).waitFor()

  await page.locator('[data-copy-source]').click()
  await page.locator('.ant-select-item-option').filter({ hasText: 'QA-101' }).click()
  await page.locator('[data-copy-apply]').click()
  await dismissConfirm(page, '确认填入空项')
  assert.equal(await page.getByLabel('前台英文主标题').inputValue(), 'Keep this unique title', 'selective copy overwrote the unique title')
  assert.equal(await page.getByRole('textbox', { name: '房源概览标签' }).inputValue(), 'Keep my current tag', 'selective copy overwrote a current difference')
  assert.equal(await page.getByLabel('英文房屋守则').inputValue(), 'No smoking\nNo pets', 'selective copy did not fill an empty safe field')
  assert.equal(await page.getByLabel('英文预订区提示').inputValue(), 'Long-stay enquiries welcome', 'booking prompt copy did not fill the booking area')

  await page.locator('[data-publish-current]').click()
  await page.getByText('房源已上架', { exact: true }).waitFor()
  assert.equal(patches.at(-1).body.is_published, true, 'publish did not send the explicit published state')
  assert.equal(patches.at(-1).body.hero_title, 'Keep this unique title')
  assert.equal(patches.at(-1).body.price_label, 'A$128', 'selective copy overwrote price')
  assert.equal(patches.at(-1).body.public_region_label, 'Docklands', 'selective copy overwrote location')
  assert.deepEqual(patches.at(-1).body.amenity_selections.find((item) => item.key === 'wifi'), { key: 'wifi', status: 'provided' })

  await page.locator('[data-edit-current="target-0"]').click()
  await page.getByText('这套房源已公开', { exact: true }).waitFor()
  await page.locator('[data-save-current]').waitFor()
  assert.match(await page.locator('[data-save-current]').innerText(), /保存并更新公开内容/)
  await page.screenshot({ path: path.join(outputDir, '1440-published-editor.png') })

  const directPreview = await context.newPage()
  await directPreview.goto(`${bookingUrl}/property-preview#0123456789abcdef`, { waitUntil: 'domcontentloaded' })
  await directPreview.getByRole('heading', { name: 'Waiting for draft preview' }).waitFor()
  await directPreview.evaluate(() => {
    window.postMessage({ type: 'mz-admin-property-preview', nonce: '0123456789abcdef', property: { id: 'injected', hero_title: 'Injected property' } }, '*')
  })
  await directPreview.waitForTimeout(100)
  await directPreview.getByRole('heading', { name: 'Waiting for draft preview' }).waitFor()
  assert.equal(await directPreview.locator('[data-property-detail]').count(), 0, 'direct preview route rendered property content')
  await directPreview.close()

  await assertHealthyPage(page, 'admin workflow after interactions', consoleErrors, pageErrors)
  await context.close()
}

async function runViewport(browser, viewport) {
  const context = await newAdminContext(browser, viewport)
  const page = await context.newPage()
  const consoleErrors = []
  const pageErrors = []
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(`${message.text()} @ ${message.location().url || 'unknown'}`) })
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('request', (request) => browserRequests.push(`${request.method()} ${request.url()}`))
  await installApiMock(page)
  await page.goto(`${baseUrl}/guest-site/properties`, { waitUntil: 'domcontentloaded' })
  await assertHealthyPage(page, viewport.name, consoleErrors, pageErrors)

  await page.locator('[data-edit-current="target-0"]').click()
  await page.getByText('这套房源已公开', { exact: true }).waitFor()
  await page.waitForTimeout(500)
  const drawerGeometry = await page.evaluate(() => {
    const element = [...document.querySelectorAll('.ant-drawer-content-wrapper')].find((candidate) => {
      const candidateRect = candidate.getBoundingClientRect()
      return candidateRect.left < document.documentElement.clientWidth && candidateRect.right > 0
    })
    if (!element) return null
    const rect = element.getBoundingClientRect()
    return { left: rect.left, right: rect.right, width: rect.width, viewport: document.documentElement.clientWidth, pageWidth: document.documentElement.scrollWidth }
  })
  assert.ok(drawerGeometry, `${viewport.name} has no visible editor drawer`)
  assert.ok(drawerGeometry.left >= -1 && drawerGeometry.right <= drawerGeometry.viewport + 1, `${viewport.name} editor drawer escaped the viewport: ${JSON.stringify(drawerGeometry)}`)
  assert.ok(drawerGeometry.pageWidth <= drawerGeometry.viewport + 2, `${viewport.name} editor caused horizontal overflow: ${JSON.stringify(drawerGeometry)}`)
  const controls = await page.locator('[data-amenity-key="wifi"] .ant-radio-button-wrapper').evaluateAll((elements) => elements.map((element) => {
    const rect = element.getBoundingClientRect()
    return { width: rect.width, height: rect.height }
  }))
  assert.ok(controls.every((control) => control.height >= 24), `${viewport.name} amenity status control is too small`)
  await page.locator('[data-managed-template-section]').scrollIntoViewIfNeeded()
  const templateGeometry = await page.locator('[data-managed-template-section]').evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }))
  assert.ok(templateGeometry.scrollWidth <= templateGeometry.clientWidth + 2, `${viewport.name} managed templates overflow horizontally: ${JSON.stringify(templateGeometry)}`)
  await page.screenshot({ path: path.join(outputDir, `${viewport.name}-editor-with-templates.png`), fullPage: false })
  await page.locator('[data-preview-current]').click()
  const previewFrameElement = page.locator('[data-admin-property-preview]')
  const previewFrame = page.frameLocator('[data-admin-property-preview]')
  await previewFrameElement.waitFor()
  await previewFrame.locator('[data-property-detail][data-admin-draft-preview="true"]').waitFor()
  const previewGeometry = await previewFrameElement.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return { left: rect.left, right: rect.right, width: rect.width, viewport: document.documentElement.clientWidth }
  })
  assert.ok(previewGeometry.left >= -1 && previewGeometry.right <= previewGeometry.viewport + 1, `${viewport.name} preview iframe escaped the viewport: ${JSON.stringify(previewGeometry)}`)
  assert.equal(await previewFrame.locator('[data-property-detail]').count(), 1, `${viewport.name} did not render the real property detail DOM`)
  await page.screenshot({ path: path.join(outputDir, `${viewport.name}-real-detail-preview.png`), fullPage: false })
  await assertHealthyPage(page, `${viewport.name} editor`, consoleErrors, pageErrors)
  await context.close()
}

async function runSemanticAmenitiesPreview(browser, viewport) {
  const context = await newAdminContext(browser, viewport)
  const page = await context.newPage()
  await installApiMock(page)
  await page.goto(`${baseUrl}/guest-site/properties`, { waitUntil: 'domcontentloaded' })
  await page.locator('[data-edit-current="visual-amenities"]').click()
  await page.locator('[data-preview-current]').click()
  const previewFrame = page.frameLocator('[data-admin-property-preview]')
  await previewFrame.getByRole('heading', { name: 'Semantic amenities fixture', exact: true }).waitFor()
  const amenities = previewFrame.locator('#amenities')
  await amenities.scrollIntoViewIfNeeded()
  const collapsed = await amenities.evaluate((section) => {
    const grid = section.querySelector('[data-amenity-summary]')
    if (!grid) return null
    const sectionRect = section.getBoundingClientRect()
    const gridRect = grid.getBoundingClientRect()
    const visibleItems = [...grid.querySelectorAll('[data-amenity-item]')].filter((element) => element.offsetParent !== null)
    return {
      keys: visibleItems.map((element) => element.getAttribute('data-amenity-item')),
      columns: getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length,
      gridWidth: gridRect.width,
      sectionWidth: sectionRect.width,
      rightGap: sectionRect.right - gridRect.right,
      distinctColumns: new Set(visibleItems.map((element) => Math.round(element.getBoundingClientRect().left))).size,
      frameWidth: document.documentElement.clientWidth,
    }
  })
  assert.ok(collapsed, `${viewport.name} compact amenity summary is missing`)
  const collapsedKeys = collapsed.keys
  for (const key of ['kettle', 'washing-machine', 'wifi', 'free-parking']) {
    assert.ok(collapsedKeys.includes(key), `${viewport.name} collapsed summary omitted core amenity ${key}: ${collapsedKeys.join(', ')}`)
  }
  assert.equal(collapsedKeys.includes('baby-cot'), false, `${viewport.name} Baby cot displaced a core summary amenity`)
  assert.equal(collapsedKeys.includes('high-chair'), false, `${viewport.name} High chair displaced a core summary amenity`)
  const expectedCollapsedCount = collapsed.frameWidth <= 760 ? 10 : 15
  const expectedCollapsedColumns = collapsed.frameWidth <= 980 ? 2 : 3
  assert.equal(collapsedKeys.length, expectedCollapsedCount, `${viewport.name} compact summary does not show the expected dense item count`)
  assert.equal(collapsed.columns, expectedCollapsedColumns, `${viewport.name} compact summary has the wrong responsive column count: ${JSON.stringify(collapsed)}`)
  assert.equal(collapsed.distinctColumns, expectedCollapsedColumns, `${viewport.name} compact summary did not actually occupy every configured column`)
  assert.ok(collapsed.gridWidth >= collapsed.sectionWidth * .98 && collapsed.rightGap <= 2, `${viewport.name} compact summary leaves unused right-side layout space: ${JSON.stringify(collapsed)}`)
  await amenities.screenshot({ path: path.join(outputDir, `${viewport.name}-semantic-amenities-collapsed.png`) })
  const expand = previewFrame.getByRole('button', { name: 'View all amenities' })
  await expand.evaluate((element) => element.scrollIntoView({ block: 'center', behavior: 'auto' }))
  await page.waitForTimeout(180)
  await expand.click()
  const result = await amenities.evaluate((section) => {
    const rows = section.querySelectorAll('[data-amenity-item]')
    const icons = section.querySelectorAll('[data-amenity-item] svg[class*="amenityIcon_"]')
    const groups = section.querySelector('[data-amenity-expanded]')
    const firstItemGrid = section.querySelector('[class*="amenityGrid_"]')
    const longLabel = section.querySelector('[data-amenity-item="custom:extended-remote-work"]')
    const frameWidth = document.documentElement.clientWidth
    const pageWidth = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth)
    return {
      rows: rows.length,
      icons: icons.length,
      groupColumns: groups ? getComputedStyle(groups).gridTemplateColumns.split(' ').filter(Boolean).length : 0,
      itemColumns: firstItemGrid ? getComputedStyle(firstItemGrid).gridTemplateColumns.split(' ').filter(Boolean).length : 0,
      overflow: pageWidth - frameWidth,
      frameWidth,
      categories: [...section.querySelectorAll('section[aria-label]')].map((element) => element.getAttribute('aria-label')),
      longLabelContained: !!longLabel && longLabel.scrollWidth <= longLabel.clientWidth + 1,
    }
  })
  assert.equal(result.rows, 29, `${viewport.name} semantic amenity rows are incomplete`)
  assert.equal(result.icons, 29, `${viewport.name} semantic amenity icons are incomplete`)
  assert.deepEqual(result.categories, ['Kitchen appliances', 'Coffee', 'Kitchenware', 'Laundry', 'Internet & work', 'Parking', 'Building facilities', 'Baby amenities', 'Other'], `${viewport.name} expanded amenity categories are not in stable priority order`)
  const expectedGroupColumns = result.frameWidth <= 760 ? 1 : 2
  const expectedItemColumns = result.frameWidth <= 360 ? 1 : result.frameWidth <= 760 ? 2 : 1
  assert.equal(result.groupColumns, expectedGroupColumns, `${viewport.name} expanded category groups do not use the available width: ${JSON.stringify(result)}`)
  assert.equal(result.itemColumns, expectedItemColumns, `${viewport.name} expanded category items have the wrong responsive layout: ${JSON.stringify(result)}`)
  assert.equal(result.longLabelContained, true, `${viewport.name} long amenity label overflowed its grid cell`)
  assert.ok(result.overflow <= 2, `${viewport.name} semantic amenity preview overflows: ${JSON.stringify(result)}`)
  await amenities.screenshot({ path: path.join(outputDir, `${viewport.name}-semantic-amenities.png`) })
  const collapse = previewFrame.getByRole('button', { name: 'Show fewer amenities' })
  await collapse.evaluate((element) => element.scrollIntoView({ block: 'center', behavior: 'auto' }))
  await page.waitForTimeout(180)
  await collapse.click()
  assert.equal(await amenities.locator('[data-amenity-summary]').count(), 1, `${viewport.name} did not restore the compact summary after collapse`)
  assert.equal(await amenities.locator('[data-amenity-expanded]').count(), 0, `${viewport.name} left the expanded group layout mounted after collapse`)
  await context.close()
}

async function main() {
  fs.mkdirSync(outputDir, { recursive: true })
  const browser = await chromium.launch({ headless: true })
  try {
    await runWorkflow(browser)
    await runUnmigratedTemplateCompatibility(browser)
    for (const viewport of viewports) {
      await runViewport(browser, viewport)
      await runSemanticAmenitiesPreview(browser, viewport)
    }
    await runSemanticAmenitiesPreview(browser, wideAmenitiesViewport)
  } finally {
    await browser.close()
  }
  console.log(JSON.stringify({
    ok: true,
    viewports: viewports.map((viewport) => viewport.name),
    wideAmenitiesViewport: wideAmenitiesViewport.name,
    patches: patches.map((entry) => ({ id: entry.id, is_published: entry.body.is_published })),
    templateMutations: templateMutations.map((entry) => ({ method: entry.method, id: entry.id, fields: Object.keys(entry.body).sort() })),
    outputDir,
    databaseWrites: 0,
    publicPreviewRequests: requestedUrls.filter((entry) => entry.includes('/public/')).length,
    propertyDetailDataRequests: browserRequests.filter((entry) => entry.includes('/property-detail-data/')).length,
  }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
