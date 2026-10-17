const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require(path.resolve(__dirname, '../../backend/node_modules/playwright'))

const baseUrl = process.env.OUR_STORY_QA_URL || 'http://127.0.0.1:3004'
const outputDir = path.resolve(__dirname, '../test-results/our-story')
const viewports = [
  { name: '320-phone', width: 320, height: 700, touch: true },
  { name: '390-phone', width: 390, height: 844, touch: true },
  { name: '768-tablet', width: 768, height: 1024, touch: true },
  { name: '1024-landscape', width: 1024, height: 768, touch: true },
  { name: '1440-desktop', width: 1440, height: 1000, touch: false },
]

async function waitForHash(page, hash) {
  await page.waitForFunction((expected) => window.location.hash === expected, hash)
}

async function openMenuIfNeeded(page, config) {
  if (config.width > 820) return
  const button = page.locator('button[aria-controls="mz-primary-nav"]')
  await button.click()
  assert.equal(await button.getAttribute('aria-expanded'), 'true')
}

async function visitStorySections(page) {
  for (const selector of ['#beginning', '#growth', '#care', '#lessons', '#story-contact']) {
    await page.locator(selector).scrollIntoViewIfNeeded()
    await page.locator(`${selector} [data-reveal]`).first().waitFor({ state: 'visible' })
  }
}

async function checkViewport(browser, config) {
  const context = await browser.newContext({
    viewport: { width: config.width, height: config.height },
    hasTouch: config.touch,
    isMobile: config.width <= 820,
    deviceScaleFactor: 1,
  })
  const page = await context.newPage()
  const consoleErrors = []
  const pageErrors = []
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })
  page.on('pageerror', (error) => pageErrors.push(error.message))

  let response = await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' })
  assert.equal(response?.status(), 200)
  await page.evaluate(() => document.fonts.ready)
  await openMenuIfNeeded(page, config)
  await page.locator('#mz-primary-nav a[href="/our-story"]').click()
  await page.waitForURL(`${baseUrl}/our-story`)
  assert.equal(await page.locator('h1').textContent(), 'Built one property at a time.')
  assert.doesNotMatch(await page.locator('main').innerText(), /\bhomes?\b/i, `${config.name} still contains home/homes in Our Story copy`)
  assert.equal(await page.locator('#mz-primary-nav a[aria-current="page"]').textContent(), 'Our Story')
  assert.equal(await page.locator('footer a[href="/our-story"]').count(), 1)
  assert.equal(await page.locator('[data-reveal]').count() > 0, true)
  assert.equal(await page.locator('main img[data-story-image]').count(), 4)
  assert.equal(await page.locator('main figure figcaption').filter({ hasText: 'Illustrative imagery' }).count(), 4)
  assert.equal(await page.getByText('These are the working practices described by our team', { exact: false }).count(), 0)
  assert.equal(await page.getByText('no single review or process can guarantee a particular result', { exact: false }).count(), 1)

  const overflow = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, page: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) }))
  assert.ok(overflow.page <= overflow.viewport + 1, `${config.name} story overflow: ${JSON.stringify(overflow)}`)
  await visitStorySections(page)
  await page.waitForFunction(() => [...document.querySelectorAll('main img[data-story-image]')].every((image) => image.complete && image.naturalWidth > 0))
  const storyImages = await page.locator('main img[data-story-image]').evaluateAll((images) => images.map((image) => ({ alt: image.getAttribute('alt'), complete: image.complete, naturalWidth: image.naturalWidth })))
  assert.ok(storyImages.every((image) => image.alt && image.complete && image.naturalWidth > 0), `${config.name} has an invalid or broken story image: ${JSON.stringify(storyImages)}`)

  await openMenuIfNeeded(page, config)
  await page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'All Properties', exact: true }).click()
  await page.waitForURL(`${baseUrl}/properties`)
  assert.equal(await page.locator('[data-properties-page]').count(), 1)
  await page.goBack({ waitUntil: 'networkidle' })
  assert.equal(new URL(page.url()).pathname, '/our-story')
  await page.goForward({ waitUntil: 'networkidle' })
  assert.equal(page.url(), `${baseUrl}/properties`)

  await page.goto(`${baseUrl}/our-story`, { waitUntil: 'networkidle' })
  await openMenuIfNeeded(page, config)
  await page.locator('#mz-primary-nav a[href="/#testimonials"]').click()
  await page.waitForURL(`${baseUrl}/#testimonials`)
  await waitForHash(page, '#testimonials')
  assert.equal(await page.locator('#testimonials').count(), 1)

  await page.goto(`${baseUrl}/our-story`, { waitUntil: 'networkidle' })
  await openMenuIfNeeded(page, config)
  await page.locator('#mz-primary-nav a[href="/contact"]').click()
  await page.waitForURL(`${baseUrl}/contact`)
  assert.equal(await page.locator('#contact-design').count(), 1)

  await page.goto(`${baseUrl}/our-story`, { waitUntil: 'networkidle' })
  await page.locator('a[aria-label="MZ Property home"]').first().click()
  await page.waitForURL(`${baseUrl}/`)
  assert.equal(await page.locator('#home').count(), 1)

  await page.goto(`${baseUrl}/our-story`, { waitUntil: 'networkidle' })
  await visitStorySections(page)
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({ path: path.join(outputDir, `${config.name}.png`), fullPage: true })

  assert.deepEqual(pageErrors, [], `${config.name} page errors: ${pageErrors.join(' | ')}`)
  assert.deepEqual(consoleErrors, [], `${config.name} console errors: ${consoleErrors.join(' | ')}`)
  await context.close()
  return { name: config.name, ...overflow }
}

async function checkReducedMotion(browser) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' })
  const page = await context.newPage()
  await page.goto(`${baseUrl}/our-story`, { waitUntil: 'networkidle' })
  const styles = await page.locator('[data-reveal]').first().evaluate((element) => {
    const computed = getComputedStyle(element)
    return { opacity: computed.opacity, transform: computed.transform, transitionDuration: computed.transitionDuration }
  })
  assert.equal(styles.opacity, '1')
  assert.equal(styles.transform, 'none')
  assert.ok(styles.transitionDuration.split(',').every((value) => parseFloat(value) <= 0.001), styles.transitionDuration)
  await context.close()
  return styles
}

async function main() {
  fs.mkdirSync(outputDir, { recursive: true })
  const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' })
  try {
    const results = []
    for (const viewport of viewports) results.push(await checkViewport(browser, viewport))
    const reducedMotion = await checkReducedMotion(browser)
    fs.writeFileSync(path.join(outputDir, 'results.json'), JSON.stringify({ baseUrl, results, reducedMotion }, null, 2))
    console.log(JSON.stringify({ status: 'passed', results, reducedMotion }, null, 2))
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
