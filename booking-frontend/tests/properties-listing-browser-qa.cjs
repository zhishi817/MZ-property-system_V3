const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { chromium } = require(path.resolve(__dirname, '../../backend/node_modules/playwright'))

const bookingRoot = path.resolve(__dirname, '..')
const outputDir = path.resolve(bookingRoot, 'test-results/properties-listing')
const webPort = 3016
const apiPort = 4026
const baseUrl = `http://127.0.0.1:${webPort}`
const apiUrl = `http://127.0.0.1:${apiPort}`

function fixture(id, overrides = {}) {
  return {
    id,
    type: 'Apartment',
    capacity: 4,
    public_capacity_override: null,
    public_region_label: 'Docklands',
    hero_title: `Published stay ${id}`,
    short_description: 'A factual public description used only for isolated listing QA.',
    long_description: 'A longer public description used only for isolated listing QA.',
    hero_image_url: '/homepage/property-docklands.avif',
    gallery_urls: ['/homepage/property-docklands.avif'],
    feature_tags: ['Entire property'],
    amenities: ['Wi-Fi'],
    amenity_items: [{ key: 'wifi', category: 'Internet', label: 'Wi-Fi', icon: 'wifi' }],
    house_rules: ['No smoking'],
    sort_order: 1,
    is_published: true,
    bedroom_count: 2,
    bathroom_count: 1,
    bed_count: 2,
    checkin_time: '3PM',
    checkout_time: '10AM',
    cancellation_policy: '',
    stay_services: [],
    booking_highlights: [],
    ...overrides,
  }
}

const properties = [
  fixture('docklands-studio', { hero_title: 'Docklands studio retreat', bedroom_count: 0, capacity: 2, sort_order: 1 }),
  fixture('cbd-one', { hero_title: 'City one-bedroom stay', public_region_label: 'Melbourne CBD', bedroom_count: 1, capacity: 2, hero_image_url: '/homepage/property-melbourne-web.jpeg', sort_order: 2 }),
  fixture('st-kilda-two', { hero_title: 'St Kilda two-bedroom apartment', public_region_label: 'St Kilda', bedroom_count: 2, capacity: 4, hero_image_url: '/homepage/property-st-kilda.jpeg', sort_order: 3 }),
  fixture('richmond-house', { hero_title: 'Richmond three-bedroom house', public_region_label: 'Richmond', type: 'House', bedroom_count: 3, capacity: 6, hero_image_url: '/homepage/property-melbourne-web.jpeg', sort_order: 4 }),
  fixture('carlton-house', { hero_title: 'Carlton neighbourhood house', public_region_label: 'Carlton', type: 'Townhouse', bedroom_count: 2, capacity: 5, hero_image_url: '/homepage/property-st-kilda.jpeg', sort_order: 5 }),
  fixture('private-draft', { hero_title: 'Unpublished private draft', is_published: false, address: 'Private address', sort_order: 6 }),
  fixture('archived-public', { hero_title: 'Archived public row', archived: true, sort_order: 7 }),
]

const config = {
  banner_title: 'Stay Melbourne, Live Local',
  banner_subtitle: 'Thoughtfully managed Melbourne properties.',
  hero_background_urls: ['/homepage/property-melbourne-web.jpeg'],
  primary_button_text: 'Find Properties',
  primary_button_href: '/properties',
  secondary_button_text: 'Our Story',
  secondary_button_href: '/our-story',
  brand_story: 'MZ Property manages considered stays and property partnerships across Melbourne.',
  contact_email: 'info@mzproperty.com.au',
  contact_phone: '+61 434 782 499',
  contact_whatsapp: '',
  contact_address: '130 Gladstone St, South Melbourne, VIC 3205',
  faq_items: [],
}

const apiState = { mode: 'ready', availabilityReads: 0, propertyReads: 0 }

function respondJson(response, status, payload, delay = 0) {
  const send = () => {
    response.statusCode = status
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify(payload))
  }
  if (delay) setTimeout(send, delay)
  else send()
}

function apiResponse(request, response) {
  const url = new URL(request.url, apiUrl)
  response.setHeader('Access-Control-Allow-Origin', '*')
  if (url.pathname === '/public/guest-site/config') return respondJson(response, 200, config)
  if (url.pathname === '/public/guest-site/stats') return respondJson(response, 200, { properties_managed_to_date: 120 })
  if (/\/public\/guest-site\/properties\/[^/]+\/availability$/.test(url.pathname)) {
    apiState.availabilityReads += 1
    return respondJson(response, 200, { property_id: url.pathname.split('/').at(-2), available: null, blocked_ranges: [] })
  }
  const detailMatch = url.pathname.match(/^\/public\/guest-site\/properties\/([^/]+)$/)
  if (detailMatch) {
    const property = properties.find((item) => item.id === decodeURIComponent(detailMatch[1]) && item.is_published && !item.archived)
    return property ? respondJson(response, 200, property) : respondJson(response, 404, { message: 'property_not_found' })
  }
  if (url.pathname === '/public/guest-site/properties') {
    apiState.propertyReads += 1
    if (apiState.mode === 'error') return respondJson(response, 503, { message: 'fixture_unavailable' })
    return respondJson(response, 200, properties, apiState.mode === 'slow' ? 700 : 0)
  }
  return respondJson(response, 404, { message: 'not_found' })
}

function waitForUrl(url, timeout = 45000) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const check = () => {
      http.get(url, (response) => {
        response.resume()
        if (response.statusCode && response.statusCode < 500) return resolve()
        if (Date.now() - started > timeout) return reject(new Error(`Timed out waiting for ${url}`))
        setTimeout(check, 250)
      }).on('error', () => {
        if (Date.now() - started > timeout) return reject(new Error(`Timed out waiting for ${url}`))
        setTimeout(check, 250)
      })
    }
    check()
  })
}

function startNext() {
  const nextBin = require.resolve('next/dist/bin/next', { paths: [bookingRoot] })
  const logs = []
  const child = spawn(process.execPath, [nextBin, 'dev', '-p', String(webPort)], {
    cwd: bookingRoot,
    env: {
      ...process.env,
      NEXT_PUBLIC_API_BASE_URL: apiUrl,
      INTERNAL_API_BASE_URL: apiUrl,
      HOMEPAGE_PUBLIC_PROPERTY_FEED_URL: `${apiUrl}/public/guest-site/properties?locale=en&featured=true`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (value) => logs.push(String(value)))
  child.stderr.on('data', (value) => logs.push(String(value)))
  child.once('exit', (code) => {
    if (code && code !== 0) process.stderr.write(logs.slice(-20).join(''))
  })
  return child
}

function stopNext(child) {
  if (!child || child.exitCode !== null) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Next fixture did not stop within 10 seconds')), 10000)
    child.once('exit', () => {
      clearTimeout(timeout)
      resolve()
    })
    child.kill('SIGTERM')
  })
}

function resetNextFetchCache() {
  fs.rmSync(path.join(bookingRoot, '.next/cache/fetch-cache'), { recursive: true, force: true })
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve))
}

function futureIso(days) {
  const date = new Date()
  date.setUTCHours(12, 0, 0, 0)
  date.setUTCDate(date.getUTCDate() + days)
  return [date.getUTCFullYear(), String(date.getUTCMonth() + 1).padStart(2, '0'), String(date.getUTCDate()).padStart(2, '0')].join('-')
}

function observePage(page) {
  const evidence = { consoleErrors: [], pageErrors: [], mutations: [], external: [] }
  page.on('console', (message) => { if (message.type() === 'error') evidence.consoleErrors.push(message.text()) })
  page.on('pageerror', (error) => evidence.pageErrors.push(error.message))
  page.on('request', (request) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) evidence.mutations.push(`${request.method()} ${request.url()}`)
    const url = new URL(request.url())
    if (!['127.0.0.1', 'localhost', 'tile.openstreetmap.org'].includes(url.hostname)) evidence.external.push(request.url())
  })
  return evidence
}

async function assertNoOverflow(page, label) {
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    page: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
  }))
  assert.ok(dimensions.page <= dimensions.viewport + 1, `${label} horizontal overflow: ${JSON.stringify(dimensions)}`)
  return dimensions
}

async function chooseFilterButton(page, fieldsetName, label) {
  const fieldset = page.locator('fieldset').filter({ hasText: fieldsetName }).first()
  await fieldset.getByRole('button', { name: label, exact: true }).click()
}

async function chooseEnglishSelect(page, id, label) {
  const trigger = page.locator(`#${id}`)
  await trigger.click()
  assert.equal(await trigger.getAttribute('aria-expanded'), 'true', `${id} listbox did not open`)
  await page.locator(`#${id}-listbox`).getByRole('option', { name: label, exact: false }).click()
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false', `${id} listbox did not close after selection`)
}

async function runCachePolicy(browser) {
  apiState.mode = 'ready'
  apiState.propertyReads = 0
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 })
  const page = await context.newPage()
  await page.goto(`${baseUrl}/properties`, { waitUntil: 'networkidle' })
  const afterFirstLoad = apiState.propertyReads
  await page.reload({ waitUntil: 'networkidle' })
  const afterImmediateReload = apiState.propertyReads
  await page.waitForTimeout(1200)
  const afterIdle = apiState.propertyReads
  assert.deepEqual(
    { afterFirstLoad, afterImmediateReload, afterIdle },
    { afterFirstLoad: 1, afterImmediateReload: 1, afterIdle: 1 },
    'normal property-list reads must reuse the 15-second cache and must not poll while idle',
  )
  await context.close()
  return { afterFirstLoad, afterImmediateReload, afterIdle, pollingReads: afterIdle - afterImmediateReload }
}

async function runDesktop(browser) {
  apiState.mode = 'ready'
  apiState.availabilityReads = 0
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 })
  const page = await context.newPage()
  await page.route('https://tile.openstreetmap.org/**', (route) => route.fulfill({ status: 204, body: '' }))
  const evidence = observePage(page)
  let response = await page.goto(`${baseUrl}/properties`, { waitUntil: 'networkidle' })
  assert.equal(response?.status(), 200)
  await page.evaluate(() => document.fonts.ready)
  assert.equal(await page.locator('[data-properties-page]').getAttribute('data-feed-status'), 'ready')
  assert.equal(await page.locator('article').count(), 5)
  assert.equal(await page.locator('#mz-primary-nav a[aria-current="page"]').textContent(), 'All Properties')
  assert.doesNotMatch(await page.locator('main').innerText(), /[\u3400-\u9fff]/)
  assert.doesNotMatch(await page.locator('main').innerText(), /A\$\d|\$\d|per night/i)
  assert.equal(apiState.availabilityReads, 0)
  await page.evaluate(() => { window.scrollTo(0, 0); if (document.activeElement instanceof HTMLElement) document.activeElement.blur() })
  await page.screenshot({ path: path.join(outputDir, 'implementation-desktop-1440.png'), fullPage: true })

  const desktopArea = page.locator('#desktop-area')
  await desktopArea.focus()
  await page.keyboard.press('End')
  assert.equal(await desktopArea.getAttribute('aria-expanded'), 'true')
  await page.keyboard.press('Escape')
  assert.equal(await desktopArea.getAttribute('aria-expanded'), 'false')
  await page.waitForFunction(() => document.activeElement?.id === 'desktop-area')
  assert.equal(await desktopArea.evaluate((element) => document.activeElement === element), true)
  await chooseEnglishSelect(page, 'desktop-area', 'Richmond')
  await chooseEnglishSelect(page, 'desktop-guests', '5 guests')
  await chooseFilterButton(page, 'Bedrooms', '3 bed')
  await chooseFilterButton(page, 'Property type', 'House')
  await page.getByRole('button', { name: 'Show stays' }).click()
  await page.waitForURL((url) => url.searchParams.get('area') === 'Richmond' && url.searchParams.get('guests') === '5' && url.searchParams.get('bedrooms') === '3' && url.searchParams.get('type') === 'house')
  await page.getByRole('heading', { name: 'Richmond three-bedroom house' }).waitFor()
  assert.equal(await page.locator('article').count(), 1)

  await page.goBack({ waitUntil: 'networkidle' })
  assert.equal(new URL(page.url()).search, '')
  assert.equal(await page.locator('article').count(), 5)
  await page.goForward({ waitUntil: 'networkidle' })
  assert.equal(await page.locator('article').count(), 1)

  await page.getByRole('link', { name: 'View Richmond three-bedroom house' }).click()
  await page.waitForURL((url) => url.pathname === '/properties/richmond-house')
  await page.getByRole('heading', { level: 1, name: 'Richmond three-bedroom house' }).waitFor()
  assert.equal(apiState.availabilityReads, 0)
  const backLink = page.locator('main a[href^="/properties?"]').first()
  assert.equal(new URL(await backLink.getAttribute('href'), baseUrl).searchParams.get('guests'), '5')
  await backLink.click()
  await page.waitForURL((url) => url.pathname === '/properties' && url.searchParams.get('guests') === '5')
  assert.equal(await page.locator('article').count(), 1)

  await page.getByRole('button', { name: 'Clear all' }).click()
  await page.waitForURL(`${baseUrl}/properties`)
  assert.equal(await page.locator('#desktop-area').getAttribute('data-value'), 'all-melbourne')
  assert.equal(await page.locator('#desktop-guests').getAttribute('data-value'), '')
  const checkin = futureIso(20)
  const checkout = futureIso(24)
  await page.locator('#desktop-checkin').click()
  await page.locator(`#desktop-checkin-calendar [data-date="${checkin}"]`).click()
  await page.locator('#desktop-checkout').click()
  await page.locator(`#desktop-checkout-calendar [data-date="${checkout}"]`).click()
  await page.getByRole('button', { name: 'Show stays' }).click()
  await page.waitForURL((url) => url.searchParams.get('checkin') === checkin && url.searchParams.get('checkout') === checkout)
  assert.equal(apiState.availabilityReads, 0)
  const firstCardHref = await page.locator('article a').first().getAttribute('href')
  assert.equal(new URL(firstCardHref, baseUrl).searchParams.get('checkin'), checkin)
  await page.getByRole('button', { name: 'Clear all' }).click()
  await chooseEnglishSelect(page, 'desktop-guests', '8 guests')
  await page.getByRole('button', { name: 'Show stays' }).click()
  await page.getByText('No properties match these filters.').waitFor()
  await page.getByRole('button', { name: 'Clear filters' }).click()
  await page.waitForURL(`${baseUrl}/properties`)
  await page.locator('article').first().waitFor()
  assert.equal(await page.locator('article').count(), 5)
  const overflow = await assertNoOverflow(page, 'desktop')

  assert.deepEqual(evidence.mutations, [])
  assert.deepEqual(evidence.external, [])
  assert.deepEqual(evidence.pageErrors, [])
  assert.deepEqual(evidence.consoleErrors, [])
  await context.close()
  return { viewport: '1440x1000', cards: 5, overflow, availabilityReads: apiState.availabilityReads }
}

async function runErrorRetry(browser) {
  apiState.mode = 'error'
  apiState.propertyReads = 0
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 })
  const page = await context.newPage()
  const evidence = observePage(page)
  const response = await page.goto(`${baseUrl}/properties?guests=4`, { waitUntil: 'networkidle' })
  assert.equal(response?.status(), 200)
  await page.getByText('We could not load the property collection.').waitFor()
  const afterInitialError = apiState.propertyReads
  assert.equal(afterInitialError, 1, 'isolated initial error should perform one public-list read')

  apiState.mode = 'slow'
  await page.getByRole('button', { name: 'Retry' }).click()
  await page.getByText('Loading published properties…').waitFor()
  await page.getByRole('heading', { name: 'St Kilda two-bedroom apartment' }).waitFor()
  assert.equal(new URL(page.url()).searchParams.get('guests'), '4')
  const afterExplicitRetry = apiState.propertyReads
  assert.equal(afterExplicitRetry, 2, 'explicit Retry should add exactly one forced public-list read')
  await page.waitForTimeout(1200)
  const afterIdle = apiState.propertyReads
  assert.equal(afterIdle, 2, 'successful Retry must not start polling')

  assert.deepEqual(evidence.mutations, [])
  assert.deepEqual(evidence.external, [])
  assert.deepEqual(evidence.pageErrors, [])
  assert.deepEqual(evidence.consoleErrors, [])
  await context.close()
  apiState.mode = 'ready'
  return { afterInitialError, afterExplicitRetry, afterIdle, pollingReads: afterIdle - afterExplicitRetry }
}

async function runMobile(browser) {
  apiState.mode = 'ready'
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true })
  const page = await context.newPage()
  const evidence = observePage(page)
  await page.goto(`${baseUrl}/properties`, { waitUntil: 'networkidle' })
  await page.evaluate(() => document.fonts.ready)
  await page.evaluate(() => { window.scrollTo(0, 0); if (document.activeElement instanceof HTMLElement) document.activeElement.blur() })
  await page.screenshot({ path: path.join(outputDir, 'implementation-mobile-390.png'), fullPage: true })
  const trigger = page.getByRole('button', { name: /Your search/ })
  await trigger.click()
  const dialog = page.getByRole('dialog', { name: 'Filters' })
  await dialog.waitFor()
  const dialogBox = await dialog.boundingBox()
  assert.ok(dialogBox && dialogBox.x >= -1 && dialogBox.x + dialogBox.width <= 391)
  const applyButton = dialog.getByRole('button', { name: /Show 5 stays/ })
  const applyBox = await applyButton.boundingBox()
  assert.ok(applyBox && applyBox.y >= 0 && applyBox.y + applyBox.height <= 845, 'mobile filter action is clipped')
  await page.screenshot({ path: path.join(outputDir, 'implementation-mobile-filters-390.png') })

  const mobileArea = dialog.locator('#mobile-area')
  await mobileArea.click()
  assert.equal(await mobileArea.getAttribute('aria-expanded'), 'true')
  await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'option')
  await page.keyboard.press('Escape')
  assert.equal(await mobileArea.getAttribute('aria-expanded'), 'false')
  assert.equal(await dialog.isVisible(), true, 'Escape on a mobile listbox must not close the filter dialog')

  await chooseEnglishSelect(dialog, 'mobile-guests', '5 guests')
  await chooseFilterButton(dialog, 'Bedrooms', '3 bed')
  await chooseFilterButton(dialog, 'Property type', 'House')
  await dialog.getByRole('button', { name: 'Cancel filters' }).click()
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-haspopup') === 'dialog')
  assert.equal(await trigger.evaluate((element) => document.activeElement === element), true)
  assert.equal(new URL(page.url()).search, '')

  await trigger.click()
  assert.equal(await page.locator('#mobile-guests').getAttribute('data-value'), '')
  await chooseEnglishSelect(dialog, 'mobile-guests', '5 guests')
  await chooseFilterButton(dialog, 'Bedrooms', '3 bed')
  await chooseFilterButton(dialog, 'Property type', 'House')
  await dialog.getByRole('button', { name: 'Show 1 stay' }).click()
  await page.waitForURL((url) => url.searchParams.get('guests') === '5' && url.searchParams.get('bedrooms') === '3')
  assert.equal(await page.locator('article').count(), 1)
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-haspopup') === 'dialog')
  assert.equal(await trigger.evaluate((element) => document.activeElement === element), true)

  await page.goBack({ waitUntil: 'networkidle' })
  assert.equal(await page.locator('article').count(), 5)
  await page.goForward({ waitUntil: 'networkidle' })
  assert.equal(await page.locator('article').count(), 1)
  await trigger.click()
  await dialog.waitFor()
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-haspopup') === 'dialog')
  assert.equal(await trigger.evaluate((element) => document.activeElement === element), true)
  const overflow = await assertNoOverflow(page, 'mobile')

  assert.deepEqual(evidence.mutations, [])
  assert.deepEqual(evidence.external, [])
  assert.deepEqual(evidence.pageErrors, [])
  assert.deepEqual(evidence.consoleErrors, [])
  await context.close()
  return { viewport: '390x844', overflow }
}

;(async () => {
  fs.mkdirSync(outputDir, { recursive: true })
  const apiServer = http.createServer(apiResponse)
  await new Promise((resolve, reject) => {
    apiServer.once('error', reject)
    apiServer.listen(apiPort, '127.0.0.1', resolve)
  })
  let next
  let browser
  try {
    resetNextFetchCache()
    next = startNext()
    await waitForUrl(`${baseUrl}/contact`)
    browser = await chromium.launch({ headless: true })
    const normalCache = await runCachePolicy(browser)
    const desktop = await runDesktop(browser)
    const mobile = await runMobile(browser)
    const normalSuiteReads = apiState.propertyReads
    await browser.close()
    browser = undefined
    await stopNext(next)
    next = undefined

    resetNextFetchCache()
    next = startNext()
    await waitForUrl(`${baseUrl}/contact`)
    browser = await chromium.launch({ headless: true })
    const retry = await runErrorRetry(browser)
    const result = {
      status: 'passed',
      baseUrl,
      api: 'isolated in-process fixture; no database, Hostex or production service',
      cache: {
        normal: normalCache,
        normalSuiteReads,
        retry,
      },
      desktop,
      mobile,
      screenshots: ['implementation-desktop-1440.png', 'implementation-mobile-390.png', 'implementation-mobile-filters-390.png'],
    }
    fs.writeFileSync(path.join(outputDir, 'results.json'), `${JSON.stringify(result, null, 2)}\n`)
    console.log('properties listing browser QA: PASS')
  } finally {
    if (browser) await browser.close()
    if (next) await stopNext(next)
    resetNextFetchCache()
    await closeServer(apiServer)
  }
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
