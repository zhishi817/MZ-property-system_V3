const assert = require('node:assert/strict')
const http = require('node:http')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { chromium } = require(path.resolve(__dirname, '../../backend/node_modules/playwright'))

const appPort = 3011
const fixturePort = 4111
const appUrl = `http://127.0.0.1:${appPort}`
const fixtureUrl = `http://127.0.0.1:${fixturePort}`
const outputDir = path.resolve(__dirname, '../test-results/homepage-cms')
const nextBin = path.resolve(__dirname, '../node_modules/.bin/next')
let mode = 'success'

const approvedFallback = {
  title: 'Hosting Made Simple, Stay Made Memorable',
  story: 'Founded in Melbourne in October 2018, MZ Property connects property owners with travellers looking for a place to feel at home. Our work brings together two perspectives: the owner’s long-term investment and the guest’s experience of Melbourne.',
  address: '130 Gladstone St, South Melbourne, VIC 3205',
}

const configuredContent = {
  banner_title: 'Configured Melbourne Hosting, Beautifully Managed',
  banner_subtitle: 'Configured owner care and guest stays from the existing website settings.',
  hero_background_urls: ['/homepage/property-melbourne-web.jpeg', '/homepage/property-st-kilda.jpeg'],
  brand_story: 'Configured story from the existing booking website settings.',
  contact_email: 'configured@mzproperty.example',
  contact_phone: '+61 400 123 456',
  contact_whatsapp: '+61 411 222 333',
  contact_address: '130 Configured St, South Melbourne, VIC 3205',
}

const legacyContent = {
  banner_title: '安心入住墨尔本',
  banner_subtitle: '精选短租房源，适合商务出行、家庭入住和长期停留。',
  hero_background_urls: [],
  brand_story: 'MZ Property 提供真实房源、清晰沟通和本地化服务，让客人在预订前就知道自己会住进什么样的空间。',
  contact_email: '',
  contact_phone: '',
  contact_whatsapp: '',
  contact_address: '87 Gladstone St, South Melbourne, VIC 3205',
}

const properties = [
  { id: 'stay-3', is_published: true, sort_order: 30, hero_title: 'Configured Stay Three', public_region_label: 'St Kilda', hero_image_url: '/homepage/property-st-kilda.jpeg', bedroom_count: 1, bathroom_count: 1 },
  { id: 'draft', is_published: false, sort_order: 0, hero_title: 'Draft Must Stay Hidden', public_region_label: 'Internal' },
  { id: 'stay-1', is_published: true, sort_order: 10, hero_title: 'Configured Stay One', public_region_label: 'Melbourne CBD', hero_image_url: '/homepage/property-melbourne-web.jpeg', bedroom_count: 2, bathroom_count: 1 },
  { id: 'stay-2', is_published: true, sort_order: 20, hero_title: 'Configured Stay Two', public_region_label: 'Docklands', hero_image_url: '/homepage/property-docklands.avif', bedroom_count: 2, bathroom_count: 2 },
]

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

const fixture = http.createServer((req, res) => {
  const url = new URL(req.url, fixtureUrl)
  const pathname = url.pathname.replace(/^\/(?:success|empty|failure|fallback)/, '')
  if (mode === 'failure' && (pathname === '/public/guest-site/config' || pathname === '/public/guest-site/properties')) {
    return json(res, 503, { message: 'guest_site_schema_not_ready' })
  }
  if (pathname === '/public/guest-site/config') return json(res, 200, mode === 'fallback' ? legacyContent : configuredContent)
  if (pathname === '/public/guest-site/properties') return json(res, 200, mode === 'empty' ? [] : properties)
  return json(res, 404, { message: 'not_found' })
})

async function waitFor(url, timeoutMs = 30000) {
  const started = Date.now()
  let lastError
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch (error) { lastError = error }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw lastError || new Error(`Timed out waiting for ${url}`)
}

async function startNext() {
  const logs = []
  const scenarioFixtureUrl = `${fixtureUrl}/${mode}`
  const child = spawn(nextBin, ['dev', '-p', String(appPort)], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      NEXT_PUBLIC_API_BASE_URL: scenarioFixtureUrl,
      NEXT_PUBLIC_API_BASE_DEV: scenarioFixtureUrl,
      INTERNAL_API_BASE_URL: scenarioFixtureUrl,
      HOMEPAGE_MANAGED_COUNT_SOURCE: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => logs.push(String(chunk)))
  child.stderr.on('data', (chunk) => logs.push(String(chunk)))
  try {
    await waitFor(appUrl, 45000)
    return { child, logs }
  } catch (error) {
    child.kill('SIGTERM')
    throw new Error(`${error.message}\n${logs.join('').slice(-4000)}`)
  }
}

async function stopNext(child) {
  if (child.exitCode != null) return
  child.kill('SIGTERM')
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ])
  if (child.exitCode == null) child.kill('SIGKILL')
}

async function completeReveals(page, selector) {
  const reveals = page.locator(`${selector} [data-reveal]`)
  const count = await reveals.count()
  for (let index = 0; index < count; index += 1) {
    const reveal = reveals.nth(index)
    await reveal.evaluate((element) => element.scrollIntoView({ block: 'center' }))
    await reveal.evaluate((element) => new Promise((resolve) => {
      const started = performance.now()
      const check = () => {
        if (Number.parseFloat(getComputedStyle(element).opacity) > .98 || performance.now() - started > 1600) resolve()
        else requestAnimationFrame(check)
      }
      check()
    }))
  }
}

async function inspectScenario(browser, scenario, viewport) {
  mode = scenario
  const { child, logs } = await startNext()
  try {
    const context = await browser.newContext({ viewport, hasTouch: viewport.width <= 768, isMobile: viewport.width <= 390 })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => {
      if (message.type() !== 'error') return
      const location = message.location().url
      errors.push(`${message.text()}${location ? ` @ ${location}` : ''}`)
    })
    await page.goto(appUrl, { waitUntil: 'networkidle' })
    await page.evaluate(() => document.fonts.ready)
    const contentStatus = await page.locator('[data-content-status]').getAttribute('data-content-status')
    const feedStatus = await page.locator('#properties').getAttribute('data-feed-status')
    const heading = (await page.locator('h1').textContent()).replace(/\s+/g, ' ').replace(/,\s*/g, ', ').trim()

    if (scenario === 'success') {
      assert.equal(contentStatus, 'ready')
      assert.equal(feedStatus, 'ready')
      assert.equal(heading, configuredContent.banner_title)
      assert.equal(await page.locator('#story p').nth(1).textContent(), configuredContent.brand_story)
      assert.equal((await page.locator('footer address').textContent()).replace(/\s+/g, ' ').trim(), configuredContent.contact_address)
      assert.equal(await page.locator('.heroDots, [aria-label="Choose hero image"]').locator('button').count(), 2)
      assert.deepEqual(await page.locator('#properties article h3').allTextContents(), ['Configured Stay One', 'Configured Stay Two', 'Configured Stay Three'])
      assert.equal(await page.getByText('Draft Must Stay Hidden').count(), 0)
    } else if (scenario === 'empty') {
      assert.equal(contentStatus, 'ready')
      assert.equal(feedStatus, 'empty')
      await page.getByText('Our published listings are being prepared. Property details will appear here once they are ready.').waitFor()
      assert.equal(await page.locator('#properties article h3').count(), 3)
    } else if (scenario === 'failure') {
      assert.equal(contentStatus, 'error')
      assert.equal(feedStatus, 'error')
      assert.equal(heading, approvedFallback.title)
      await page.getByText('Published properties could not be loaded right now.').waitFor()
    } else {
      assert.equal(contentStatus, 'fallback')
      assert.equal(feedStatus, 'ready')
      assert.equal(heading, approvedFallback.title)
      assert.equal(await page.locator('#story p').nth(1).textContent(), approvedFallback.story)
      assert.equal((await page.locator('footer address').textContent()).replace(/\s+/g, ' ').trim(), approvedFallback.address)
      assert.equal(await page.getByText('87 Gladstone St', { exact: false }).count(), 0)
    }

    const overflow = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - document.documentElement.clientWidth)
    assert.ok(overflow <= 1, `${scenario} has horizontal overflow: ${overflow}`)
    await page.screenshot({ path: path.join(outputDir, `${scenario}-${viewport.width}-hero.png`) })
    await completeReveals(page, '#properties')
    const hiddenPropertyReveals = await page.locator('#properties [data-reveal]').evaluateAll((elements) => elements
      .filter((element) => Number.parseFloat(getComputedStyle(element).opacity) < .98)
      .map((element) => ({ tag: element.tagName, classes: element.className, opacity: getComputedStyle(element).opacity, top: element.getBoundingClientRect().top, height: element.getBoundingClientRect().height })))
    assert.equal(hiddenPropertyReveals.length, 0, `${scenario} left property content invisible after scrolling: ${JSON.stringify(hiddenPropertyReveals)}`)
    await page.locator('#properties').screenshot({ path: path.join(outputDir, `${scenario}-${viewport.width}-properties.png`) })
    if (scenario === 'success' || scenario === 'fallback') {
      await completeReveals(page, '#story')
      await page.locator('#story').screenshot({ path: path.join(outputDir, `${scenario}-${viewport.width}-story.png`) })
      await page.locator('footer').scrollIntoViewIfNeeded()
      await page.locator('footer').screenshot({ path: path.join(outputDir, `${scenario}-${viewport.width}-footer.png`) })
    }
    assert.deepEqual(errors, [], `${scenario} browser errors: ${errors.join(' | ')}`)
    await context.close()
  } finally {
    await stopNext(child)
    if (child.exitCode && child.exitCode !== 0 && child.signalCode !== 'SIGTERM') {
      throw new Error(`Next exited unexpectedly for ${scenario}: ${logs.join('').slice(-4000)}`)
    }
  }
}

async function main() {
  require('node:fs').mkdirSync(outputDir, { recursive: true })
  await new Promise((resolve) => fixture.listen(fixturePort, '127.0.0.1', resolve))
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  try {
    const selected = process.env.HOMEPAGE_CMS_QA_SCENARIO || ''
    if (!selected || selected === 'success') {
      await inspectScenario(browser, 'success', { width: 390, height: 844 })
      await inspectScenario(browser, 'success', { width: 1440, height: 1000 })
    }
    if (!selected || selected === 'empty') await inspectScenario(browser, 'empty', { width: 390, height: 844 })
    if (!selected || selected === 'failure') await inspectScenario(browser, 'failure', { width: 390, height: 844 })
    if (!selected || selected === 'fallback') await inspectScenario(browser, 'fallback', { width: 390, height: 844 })
    console.log(selected
      ? `homepage-cms-browser-qa: passed ${selected}`
      : 'homepage-cms-browser-qa: passed success (390/1440), empty, failure and fallback')
    console.log(`screenshots: ${outputDir}`)
  } finally {
    await browser.close()
    await new Promise((resolve) => fixture.close(resolve))
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
