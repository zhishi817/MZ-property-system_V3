const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { chromium } = require(path.resolve(__dirname, '../../backend/node_modules/playwright'))

const bookingRoot = path.resolve(__dirname, '..')
const outputDir = path.resolve(bookingRoot, 'test-results/navigation-consistency')
const webPort = 3005
const apiPort = 4014
const baseUrl = `http://127.0.0.1:${webPort}`
const apiUrl = `http://127.0.0.1:${apiPort}`

const property = {
  id: 'nav-fixture',
  type: 'One-bedroom apartment',
  capacity: 2,
  public_capacity_override: 2,
  public_region_label: 'Docklands, Melbourne',
  hero_title: 'Waterfront 1BR Docklands Apartment',
  short_description: 'A calm waterfront stay used only for isolated navigation QA.',
  long_description: 'A bright one-bedroom apartment with a practical layout and waterfront outlook.',
  hero_image_url: '/homepage/property-docklands.avif',
  gallery_urls: ['/homepage/property-docklands.avif', '/homepage/property-melbourne-web.jpeg', '/homepage/property-st-kilda.jpeg'],
  feature_tags: ['Entire apartment', 'Self check-in'],
  amenities: ['Wi-Fi', 'Free parking'],
  amenity_items: [
    { key: 'wifi', category: 'Internet', label: 'Wi-Fi', icon: 'wifi' },
    { key: 'parking', category: 'Parking', label: 'Free parking', icon: 'parking' },
  ],
  house_rules: ['No smoking', 'No parties'],
  sort_order: 1,
  is_published: true,
  bedroom_count: 1,
  bathroom_count: 1,
  bed_count: 1,
  checkin_time: '3PM',
  checkout_time: '10AM',
  cancellation_policy: 'Confirm the cancellation terms with the property team before booking.',
  stay_services: [
    { key: 'early_checkin', enabled: true, title: 'Early check-in', headline: 'No fee · Advance request', description: 'Ask in advance. Approval depends on availability.', fee_amount: 0, fee_currency: 'AUD', until_time: '', requires_advance_request: true, manual_confirmation: true, guaranteed: false, grants_room_access: false, payment_timing: '' },
    { key: 'late_checkout', enabled: true, title: 'Late check-out', headline: 'Until 11:30AM · A$20', description: 'Ask in advance. Approval depends on availability.', fee_amount: 20, fee_currency: 'AUD', until_time: '11:30AM', requires_advance_request: true, manual_confirmation: true, guaranteed: false, grants_room_access: false, payment_timing: '' },
    { key: 'baggage_dropoff', enabled: true, title: 'Luggage drop-off', headline: 'Advance confirmation required', description: 'Ask the property team before arrival.', fee_amount: null, fee_currency: 'AUD', until_time: '', requires_advance_request: true, manual_confirmation: true, guaranteed: false, grants_room_access: false, payment_timing: '' },
  ],
  booking_highlights: [],
}

const config = {
  banner_title: 'Stay Melbourne, Live Local',
  banner_subtitle: 'Thoughtfully managed Melbourne properties.',
  hero_background_urls: ['/homepage/property-melbourne-web.jpeg'],
  primary_button_text: 'Find Properties',
  primary_button_href: '/#properties',
  secondary_button_text: 'Our Story',
  secondary_button_href: '/our-story',
  brand_story: 'MZ Property manages considered stays and property partnerships across Melbourne.',
  contact_email: 'info@mzproperty.com.au',
  contact_phone: '+61 434 782 499',
  contact_whatsapp: '',
  contact_address: '130 Gladstone St, South Melbourne, VIC 3205',
  faq_items: [],
}

function apiResponse(request, response) {
  const url = new URL(request.url, apiUrl)
  response.setHeader('Content-Type', 'application/json')
  response.setHeader('Access-Control-Allow-Origin', '*')
  if (url.pathname === '/public/guest-site/config') return response.end(JSON.stringify(config))
  if (url.pathname === '/public/guest-site/stats') return response.end(JSON.stringify({ properties_managed_to_date: 120 }))
  if (url.pathname === '/public/guest-site/properties/nav-fixture/availability') return response.end(JSON.stringify({ property_id: property.id, available: null, blocked_ranges: [] }))
  if (url.pathname === '/public/guest-site/properties/nav-fixture') return response.end(JSON.stringify(property))
  if (url.pathname === '/public/guest-site/properties') return response.end(JSON.stringify([property]))
  response.statusCode = 404
  return response.end(JSON.stringify({ error: 'not found' }))
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
      NEXT_PUBLIC_DEV_ACTIVITY_URL: 'http://127.0.0.1:4013/activity',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (value) => logs.push(String(value)))
  child.stderr.on('data', (value) => logs.push(String(value)))
  child.once('exit', (code) => {
    if (code && code !== 0) process.stderr.write(logs.slice(-12).join(''))
  })
  return child
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve))
}

function rounded(value) {
  return Math.round(value * 100) / 100
}

async function measureHeader(page) {
  return page.locator('[data-site-header]').evaluate((header) => {
    const nav = header.querySelector('#mz-primary-nav')
    const brand = header.querySelector('a[aria-label="MZ Property home"]')
    const cta = nav.querySelector('a[href="/properties"]:last-child')
    const firstLink = nav.querySelector('a:not([aria-current]):not(:last-child)') || nav.querySelector('a:not(:last-child)')
    const rect = (element) => {
      const value = element.getBoundingClientRect()
      return { x: value.x, y: value.y, width: value.width, height: value.height }
    }
    const style = (element) => {
      const value = getComputedStyle(element)
      return {
        fontFamily: value.fontFamily,
        fontSize: value.fontSize,
        fontWeight: value.fontWeight,
        color: value.color,
        paddingLeft: value.paddingLeft,
        paddingRight: value.paddingRight,
        gap: value.gap,
        position: value.position,
      }
    }
    return {
      state: header.dataset.headerState,
      header: rect(header),
      brand: rect(brand),
      nav: rect(nav),
      cta: rect(cta),
      headerStyle: style(header),
      linkStyle: style(firstLink),
      navStyle: style(nav),
      links: [...nav.querySelectorAll('a')].map((link) => ({ label: link.textContent.trim(), href: link.getAttribute('href'), current: link.getAttribute('aria-current') })),
    }
  }).then((value) => JSON.parse(JSON.stringify(value), (key, item) => typeof item === 'number' ? rounded(item) : item))
}

const routes = [
  { name: 'home', path: '/', active: 'Home' },
  { name: 'contact', path: '/contact', active: 'Contact us' },
  { name: 'story', path: '/our-story', active: 'Our Story' },
  { name: 'properties', path: '/properties', active: 'All Properties' },
  { name: 'property-detail', path: '/properties/nav-fixture', active: 'All Properties' },
  { name: 'property-placeholder', path: '/property-details', active: 'All Properties' },
]

const viewports = [
  { name: '390-mobile', width: 390, height: 844, routes },
  { name: '768-tablet', width: 768, height: 1024, routes: routes.filter((item) => ['home', 'contact', 'story', 'property-detail'].includes(item.name)) },
  { name: '1440-desktop', width: 1440, height: 1000, routes },
  { name: '2048-reference', width: 2048, height: 1000, routes: routes.filter((item) => ['home', 'contact', 'story', 'property-detail'].includes(item.name)) },
]

async function checkViewport(browser, viewport) {
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, isMobile: viewport.width <= 820, hasTouch: viewport.width <= 820, deviceScaleFactor: 1 })
  const page = await context.newPage()
  const consoleErrors = []
  const pageErrors = []
  const mutations = []
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('request', (request) => { if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && !request.url().endsWith('/activity')) mutations.push(`${request.method()} ${request.url()}`) })
  await page.route('http://127.0.0.1:4013/activity', (route) => route.fulfill({ status: 204, body: '' }))

  let restBaseline = null
  let compactBaseline = null
  const results = []
  for (const route of viewport.routes) {
    const response = await page.goto(`${baseUrl}${route.path}`, { waitUntil: 'networkidle' })
    assert.equal(response?.status(), 200, `${viewport.name} ${route.name} failed to load`)
    await page.evaluate(() => document.fonts.ready)
    if (route.name === 'contact') {
      assert.equal(await page.getByRole('heading', { level: 1 }).textContent(), 'Let’s talk about your property.')
      assert.equal(await page.getByRole('combobox').count(), 2)
    } else if (route.name === 'story') {
      assert.equal(await page.getByRole('heading', { level: 1 }).textContent(), 'Built one property at a time.')
      assert.equal(await page.locator('main img[data-story-image]').count(), 4)
    } else if (route.name === 'property-detail') {
      assert.equal(await page.locator('[data-property-detail]').count(), 1)
      assert.equal(await page.getByRole('heading', { level: 1 }).textContent(), property.hero_title)
    } else if (route.name === 'property-placeholder') {
      assert.equal(await page.getByRole('heading', { level: 1 }).textContent(), 'Property details are coming soon.')
    }
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.waitForFunction(() => document.querySelector('[data-site-header]')?.dataset.headerState === 'rest')
    const rest = await measureHeader(page)
    assert.equal(rest.links.find((item) => item.current === 'page')?.label, route.active, `${viewport.name} ${route.name} active navigation is wrong`)
    if (!restBaseline) restBaseline = rest
    else {
      assert.deepEqual({ ...rest, links: rest.links.map(({ label, href }) => ({ label, href })) }, { ...restBaseline, links: restBaseline.links.map(({ label, href }) => ({ label, href })) }, `${viewport.name} ${route.name} rest header drifted from homepage`)
    }

    if (['home', 'contact', 'story', 'property-detail'].includes(route.name) && ['390-mobile', '2048-reference'].includes(viewport.name)) {
      await page.locator('[data-site-header]').screenshot({ path: path.join(outputDir, `${viewport.name}-${route.name}-rest.png`) })
    }

    await page.evaluate(() => window.scrollTo(0, Math.min(240, document.documentElement.scrollHeight - window.innerHeight)))
    if (await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight + 40)) {
      await page.waitForFunction(() => document.querySelector('[data-site-header]')?.dataset.headerState === 'compact')
      await page.waitForTimeout(420)
      const compact = await measureHeader(page)
      if (!compactBaseline) compactBaseline = compact
      else {
        assert.deepEqual({ ...compact, links: compact.links.map(({ label, href }) => ({ label, href })) }, { ...compactBaseline, links: compactBaseline.links.map(({ label, href }) => ({ label, href })) }, `${viewport.name} ${route.name} compact header drifted from homepage`)
      }
      if (['home', 'contact', 'story', 'property-detail'].includes(route.name) && ['390-mobile', '2048-reference'].includes(viewport.name)) {
        await page.locator('[data-site-header]').screenshot({ path: path.join(outputDir, `${viewport.name}-${route.name}-compact.png`) })
      }
    }

    const overflow = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, page: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) }))
    assert.ok(overflow.page <= overflow.viewport + 1, `${viewport.name} ${route.name} overflows: ${JSON.stringify(overflow)}`)
    results.push({ route: route.name, rest, overflow })
  }

  if (viewport.width <= 820) {
    for (const route of viewport.routes.filter((item) => ['home', 'contact', 'story', 'property-detail'].includes(item.name))) {
      await page.goto(`${baseUrl}${route.path}`, { waitUntil: 'networkidle' })
      const trigger = page.locator('button[aria-controls="mz-primary-nav"]')
      await trigger.click()
      assert.equal(await trigger.getAttribute('aria-expanded'), 'true')
      assert.deepEqual(await page.locator('#mz-primary-nav a').evaluateAll((links) => links.map((link) => link.textContent.trim())), ['Home', 'All Properties', 'Our Story', 'Reviews', 'Contact us', 'Find Properties'])
      if (viewport.name === '390-mobile') {
        await page.waitForTimeout(420)
        await page.screenshot({ path: path.join(outputDir, `${viewport.name}-${route.name}-menu-open.png`) })
      }
      await page.keyboard.press('Escape')
      await page.waitForFunction(() => document.querySelector('button[aria-controls="mz-primary-nav"]')?.getAttribute('aria-expanded') === 'false')
      assert.equal(await trigger.evaluate((element) => document.activeElement === element), true)
    }

    await page.goto(`${baseUrl}/contact`, { waitUntil: 'networkidle' })
    await page.locator('button[aria-controls="mz-primary-nav"]').click()
    await page.locator('#mz-primary-nav a[href="/our-story"]').click()
    await page.waitForURL(`${baseUrl}/our-story`)
    assert.equal(await page.locator('button[aria-controls="mz-primary-nav"]').getAttribute('aria-expanded'), 'false')
    await page.goBack({ waitUntil: 'networkidle' })
    assert.equal(new URL(page.url()).pathname, '/contact')
    await page.goForward({ waitUntil: 'networkidle' })
    assert.equal(new URL(page.url()).pathname, '/our-story')
  }

  await page.goto(`${baseUrl}/our-story`, { waitUntil: 'networkidle' })
  if (viewport.width <= 820) await page.locator('button[aria-controls="mz-primary-nav"]').click()
  await page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'All Properties', exact: true }).click()
  await page.waitForURL(`${baseUrl}/properties`)
  assert.equal(await page.locator('[data-properties-page]').count(), 1)
  await page.goBack({ waitUntil: 'networkidle' })
  assert.equal(new URL(page.url()).pathname, '/our-story')
  await page.goForward({ waitUntil: 'networkidle' })
  assert.equal(new URL(page.url()).pathname, '/properties')

  assert.deepEqual(mutations, [], `${viewport.name} unexpected mutations: ${mutations.join(' | ')}`)
  assert.deepEqual(pageErrors, [], `${viewport.name} page errors: ${pageErrors.join(' | ')}`)
  assert.deepEqual(consoleErrors, [], `${viewport.name} console errors: ${consoleErrors.join(' | ')}`)
  await context.close()
  return { viewport: viewport.name, width: viewport.width, height: viewport.height, routes: results.length, mutations: mutations.length, pageErrors, consoleErrors }
}

;(async () => {
  fs.mkdirSync(outputDir, { recursive: true })
  const apiServer = http.createServer(apiResponse)
  await new Promise((resolve, reject) => {
    apiServer.once('error', reject)
    apiServer.listen(apiPort, '127.0.0.1', resolve)
  })
  const next = startNext()
  let browser
  try {
    await waitForUrl(`${baseUrl}/`)
    browser = await chromium.launch({ headless: true })
    const results = []
    for (const viewport of viewports) results.push(await checkViewport(browser, viewport))
    fs.writeFileSync(path.join(outputDir, 'results.json'), `${JSON.stringify({ baseUrl, api: 'isolated in-process fixture; no database', results }, null, 2)}\n`)
    console.log(`navigation consistency browser QA: PASS (${viewports.length} widths)`)
  } finally {
    if (browser) await browser.close()
    next.kill('SIGTERM')
    await closeServer(apiServer)
  }
})().catch((error) => { console.error(error); process.exit(1) })
