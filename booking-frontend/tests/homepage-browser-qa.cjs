const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')

const { chromium } = require(path.resolve(__dirname, '../../backend/node_modules/playwright'))

const baseUrl = process.env.HOMEPAGE_QA_URL || 'http://127.0.0.1:3004'
const outputDir = path.resolve(__dirname, '../test-results/homepage')
const allViewports = [
  { name: '320-portrait', width: 320, height: 568, touch: true },
  { name: '390-portrait', width: 390, height: 844, touch: true },
  { name: '768-landscape', width: 768, height: 390, touch: true },
  { name: '768-portrait', width: 768, height: 1024, touch: true },
  { name: '1024-landscape', width: 1024, height: 768, touch: false },
  { name: '1440-desktop', width: 1440, height: 1000, touch: false },
]
const viewports = process.env.HOMEPAGE_QA_VIEWPORT
  ? allViewports.filter((viewport) => viewport.name === process.env.HOMEPAGE_QA_VIEWPORT)
  : allViewports

function expectClose(values, tolerance, label) {
  assert.ok(Math.max(...values) - Math.min(...values) <= tolerance, `${label}: ${values.join(', ')}`)
}

async function assertPanelBelowTrigger(trigger, panel, label) {
  const [triggerBox, panelBox] = await Promise.all([trigger.boundingBox(), panel.boundingBox()])
  assert.ok(triggerBox && panelBox, `${label} is missing geometry`)
  assert.ok(panelBox.y >= triggerBox.y + triggerBox.height - 1, `${label} flipped above its trigger`)
}

function melbourneDateOffset(days) {
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date())
  const value = (type) => Number(parts.find((part) => part.type === type).value)
  const date = new Date(Date.UTC(value('year'), value('month') - 1, value('day') + days, 12))
  return [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()]
    .map((part, index) => index === 0 ? String(part) : String(part).padStart(2, '0'))
    .join('-')
}

function formatEnglishStayDate(value) {
  const [year, month, day] = value.split('-').map(Number)
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Melbourne', day: '2-digit', month: 'short', year: 'numeric',
  }).format(new Date(Date.UTC(year, month - 1, day, 12)))
}

async function dispatchTouch(cdp, points) {
  const [start, ...moves] = points
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] })
  for (const point of moves) {
    await new Promise((resolve) => setTimeout(resolve, point.delay || 24))
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: point.x, y: point.y }] })
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
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
  let expectContactFailure = false
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error' && !expectContactFailure) {
      const location = message.location().url
      consoleErrors.push(`${message.text()}${location ? ` @ ${location}` : ''}`)
    }
  })

  await page.goto(baseUrl, { waitUntil: 'networkidle' })
  await page.evaluate(() => document.fonts.ready)
  const faviconHref = await page.locator('link[rel="icon"]').getAttribute('href')
  assert.match(faviconHref || '', /\/homepage\/mz-mark-v2\.svg\?v=20261017-1$/, `${config.name} favicon is not the square brand mark`)
  assert.match(await page.locator('link[rel="apple-touch-icon"]').getAttribute('href') || '', /\/homepage\/mz-mark-v2\.svg\?v=20261017-1$/, `${config.name} apple icon is not the square brand mark`)
  const faviconMetrics = await page.evaluate(async (href) => new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight })
    image.onerror = reject
    image.src = href
  }), faviconHref)
  assert.equal(faviconMetrics.width, faviconMetrics.height, `${config.name} favicon asset is not square`)
  if (config.name === '390-portrait') {
    const freshTab = await context.newPage()
    await freshTab.goto(baseUrl, { waitUntil: 'networkidle' })
    assert.match(await freshTab.locator('link[rel="icon"]').getAttribute('href') || '', /\/homepage\/mz-mark-v2\.svg\?v=20261017-1$/, 'fresh tab did not receive the versioned square favicon')
    await freshTab.close()
  }
  assert.equal(await page.locator('h1').textContent(), 'Hosting Made Simple,Stay Made Memorable')
  for (const id of ['home', 'properties', 'records', 'story', 'qualities', 'testimonials', 'contact']) {
    await page.locator(`#${id}`).waitFor({ state: 'visible' })
  }
  const story = page.locator('#story')
  assert.equal(await story.getByRole('heading', { name: 'Our Mission', exact: true }).count(), 1, `${config.name} mission heading is missing`)
  assert.deepEqual(await story.locator('p').allTextContents(), [
    'Meet MZ Property',
    'Founded in Melbourne in October 2018, MZ Property connects property owners with travellers looking for a place to feel at home. Our work brings together two perspectives: the owner’s long-term investment and the guest’s experience of Melbourne.',
    'For property owners, our goal is to make owning a home more rewarding, easier, and less stressful.',
    'For guests, we aim to offer a welcoming home base that makes every Melbourne stay feel personal and memorable.',
  ], `${config.name} Story / Mission copy changed`)
  assert.equal((await page.locator('footer address').textContent()).replace(/\s+/g, ' ').trim(), '130 Gladstone St, South Melbourne, VIC 3205', `${config.name} footer address is stale`)
  const footerLogo = page.locator('footer img[alt="MZ Property"]')
  const footerLogoMetrics = await footerLogo.evaluate((image) => ({
    naturalRatio: image.naturalWidth / image.naturalHeight,
    renderedRatio: image.getBoundingClientRect().width / image.getBoundingClientRect().height,
    filter: getComputedStyle(image).filter,
  }))
  assert.ok(Math.abs(footerLogoMetrics.naturalRatio - footerLogoMetrics.renderedRatio) < 0.02, `${config.name} footer logo aspect ratio changed`)
  assert.notEqual(footerLogoMetrics.filter, 'brightness(0) invert(1)', `${config.name} footer logo still uses the whiteout filter`)
  if (config.name === '390-portrait' || config.name === '1440-desktop') {
    await page.locator('footer').screenshot({ path: path.join(outputDir, `${config.name}-footer-brand-address.png`) })
  }

  const overflow = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    page: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
  }))
  assert.ok(overflow.page <= overflow.viewport + 1, `${config.name} horizontal overflow: ${overflow.page} > ${overflow.viewport}`)

  const header = page.locator('[data-header]')
  const expectedMenu = [
    { label: 'Home', href: '/#home' },
    { label: 'All Properties', href: '/properties' },
    { label: 'Our Story', href: '/our-story' },
    { label: 'Reviews', href: '/#testimonials' },
    { label: 'Contact us', href: '/contact' },
  ]
  const primaryMenu = await page.locator('#mz-primary-nav a').evaluateAll((anchors) => anchors
    .map((anchor) => ({ label: anchor.textContent.trim(), href: anchor.getAttribute('href') }))
    .filter((item) => item.label !== 'Find Properties'))
  assert.deepEqual(primaryMenu, expectedMenu, `${config.name} primary navigation order/destinations changed`)
  const footerMenu = await page.getByRole('heading', { name: 'Menu', exact: true }).locator('..').locator('a').evaluateAll((anchors) => anchors
    .map((anchor) => ({ label: anchor.textContent.trim(), href: anchor.getAttribute('href') })))
  assert.deepEqual(footerMenu, expectedMenu, `${config.name} footer navigation order/destinations changed`)
  const headerBefore = await header.evaluate((element) => element.getBoundingClientRect().height)
  await page.evaluate(() => window.scrollTo(0, 120))
  await page.waitForTimeout(420)
  const headerAfter = await header.evaluate((element) => element.getBoundingClientRect().height)
  assert.ok(headerAfter < headerBefore, `${config.name} header did not compact`)

  if (config.width <= 820) {
    const menu = page.locator('button[aria-controls="mz-primary-nav"]')
    await menu.click()
    assert.equal(await menu.getAttribute('aria-expanded'), 'true')
    const propertiesLink = page.locator('#mz-primary-nav a[href="/properties"]').first()
    await propertiesLink.waitFor({ state: 'visible' })
    await propertiesLink.click()
    await page.waitForURL((url) => url.pathname === '/properties')
    assert.equal(await menu.getAttribute('aria-expanded'), 'false')
    await page.goBack({ waitUntil: 'networkidle' })
    await menu.click()
    await page.keyboard.press('Escape')
    assert.equal(await menu.getAttribute('aria-expanded'), 'false')
  } else {
    const propertiesLink = page.locator('#mz-primary-nav a[href="/properties"]').first()
    await propertiesLink.waitFor({ state: 'visible' })
    await propertiesLink.click()
    await page.waitForURL((url) => url.pathname === '/properties')
    await page.goBack({ waitUntil: 'networkidle' })
  }

  const staySearch = page.locator('[data-stay-search]')
  await staySearch.waitFor({ state: 'visible' })
  const floatingGeometry = await page.evaluate(() => {
    const hero = document.querySelector('#home').getBoundingClientRect()
    const search = document.querySelector('[data-stay-search]').parentElement.getBoundingClientRect()
    return { heroBottom: hero.bottom + window.scrollY, searchTop: search.top + window.scrollY, searchBottom: search.bottom + window.scrollY }
  })
  assert.ok(floatingGeometry.searchTop < floatingGeometry.heroBottom, `${config.name} search does not overlap the hero boundary`)
  assert.ok(floatingGeometry.searchBottom > floatingGeometry.heroBottom, `${config.name} search does not extend into the properties background`)
  const areaTrigger = page.locator('#stay-area')
  const guestsTrigger = page.locator('#stay-guests')
  assert.equal(await areaTrigger.getAttribute('data-value'), 'all-melbourne')
  assert.equal(await guestsTrigger.getAttribute('data-value'), '2')
  await areaTrigger.focus()
  await page.keyboard.press('ArrowDown')
  const areaListbox = page.locator('#stay-area-listbox')
  await areaListbox.waitFor({ state: 'visible' })
  await page.waitForFunction(() => {
    const element = document.querySelector('#stay-area-listbox')
    if (!element) return false
    const rect = element.getBoundingClientRect()
    return rect.top >= -1 && rect.bottom <= window.innerHeight + 1
  })
  assert.equal(await areaTrigger.getAttribute('aria-expanded'), 'true')
  const areaBox = await areaListbox.boundingBox()
  assert.ok(areaBox, `${config.name} area listbox has no bounding box`)
  assert.ok(areaBox.x >= -1 && areaBox.x + areaBox.width <= config.width + 1, `${config.name} area listbox is horizontally clipped`)
  assert.ok(areaBox.y >= -1 && areaBox.y + areaBox.height <= config.height + 1, `${config.name} area listbox is vertically clipped: ${JSON.stringify(areaBox)} viewport=${config.height}`)
  await assertPanelBelowTrigger(areaTrigger, areaListbox, `${config.name} area listbox`)
  await page.keyboard.press('Enter')
  assert.equal(await areaTrigger.getAttribute('data-value'), 'melbourne-cbd', `${config.name} area keyboard selection failed`)
  await page.waitForFunction(() => document.activeElement?.id === 'stay-area')
  await areaTrigger.click()
  await areaListbox.locator('[role="option"]').filter({ hasText: 'All Melbourne' }).click()
  assert.equal(await areaTrigger.getAttribute('data-value'), 'all-melbourne')
  await guestsTrigger.click()
  const guestsListbox = page.locator('#stay-guests-listbox')
  await guestsListbox.waitFor({ state: 'visible' })
  await assertPanelBelowTrigger(guestsTrigger, guestsListbox, `${config.name} guests listbox`)
  if (config.name === '390-portrait') {
    await page.screenshot({ path: path.join(outputDir, '390-guests-open.png') })
  }
  await page.keyboard.press('Tab')
  await guestsListbox.waitFor({ state: 'hidden' })
  assert.equal(await guestsTrigger.getAttribute('aria-expanded'), 'false')
  const checkinTrigger = page.locator('#stay-checkin')
  assert.equal((await checkinTrigger.textContent()).trim(), 'Select date')
  assert.equal(await page.locator('#stay-checkout').textContent().then((text) => text.trim()), 'Select date')
  const checkinCalendar = page.locator('#stay-checkin-calendar')
  await areaTrigger.click()
  await areaListbox.waitFor({ state: 'visible' })
  await checkinTrigger.click()
  await areaListbox.waitFor({ state: 'hidden' })
  await checkinCalendar.waitFor({ state: 'visible' })
  await page.waitForFunction(() => {
    const element = document.querySelector('#stay-checkin-calendar')
    if (!element) return false
    const rect = element.getBoundingClientRect()
    return rect.top >= -1 && rect.bottom <= window.innerHeight + 1
  })
  await checkinCalendar.getByText('Sun', { exact: true }).waitFor()
  assert.doesNotMatch(await checkinCalendar.textContent(), /[年月日]/, `${config.name} calendar leaked non-English date chrome`)
  assert.equal(await checkinCalendar.locator(`[data-date="${melbourneDateOffset(-1)}"]`).isDisabled(), true, `${config.name} calendar did not disable a past Melbourne date`)
  await page.waitForFunction(() => document.activeElement?.hasAttribute('data-date'))
  const focusedDate = await page.evaluate(() => document.activeElement?.getAttribute('data-date'))
  await page.keyboard.press('ArrowRight')
  await page.waitForFunction((previous) => document.activeElement?.getAttribute('data-date') !== previous, focusedDate)
  const calendarBox = await checkinCalendar.boundingBox()
  assert.ok(calendarBox, `${config.name} calendar has no bounding box`)
  assert.ok(calendarBox.x >= -1 && calendarBox.x + calendarBox.width <= config.width + 1, `${config.name} calendar is horizontally clipped`)
  assert.ok(calendarBox.y >= -1 && calendarBox.y + calendarBox.height <= config.height + 1, `${config.name} calendar is vertically clipped: ${JSON.stringify(calendarBox)} viewport=${config.height}`)
  await assertPanelBelowTrigger(checkinTrigger, checkinCalendar, `${config.name} check-in calendar`)
  if (config.name === '390-portrait') {
    await page.screenshot({ path: path.join(outputDir, '390-calendar-open.png') })
  }
  if (config.name === '1440-desktop') {
    await page.screenshot({ path: path.join(outputDir, '1440-calendar-open.png') })
  }
  await page.keyboard.press('Escape')
  await checkinCalendar.waitFor({ state: 'hidden' })
  await page.waitForFunction(() => document.activeElement?.id === 'stay-checkin')
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'stay-checkin', `${config.name} Escape did not return focus to check-in`)
  if (config.name === '390-portrait') {
    assert.equal(await page.locator('#stay-area').getAttribute('data-value'), 'all-melbourne')
    assert.equal(await page.locator('#stay-guests').getAttribute('data-value'), '2')
    await staySearch.getByRole('button', { name: 'View matching properties' }).click()
    await page.getByText('Choose a check-in date.').waitFor()
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'stay-checkin')

    const checkin = melbourneDateOffset(1)
    const checkout = melbourneDateOffset(4)
    await page.locator('#stay-area').click()
    await page.locator('#stay-area-listbox [role="option"]').filter({ hasText: 'Docklands' }).click()
    await page.locator('#stay-checkin').click()
    await page.locator(`#stay-checkin-calendar [data-date="${checkin}"]`).click()
    assert.equal(await page.locator('#stay-checkin').textContent().then((text) => text.trim()), formatEnglishStayDate(checkin))
    await page.locator('#stay-checkout').click()
    await page.locator('[data-header]').click({ position: { x: 10, y: 10 } })
    await page.locator('#stay-checkout-calendar').waitFor({ state: 'hidden' })
    await page.locator('#stay-checkout').click()
    await page.locator(`#stay-checkout-calendar [data-date="${checkout}"]`).click()
    assert.equal(await page.locator('#stay-checkout').textContent().then((text) => text.trim()), formatEnglishStayDate(checkout))
    await page.locator('#stay-guests').click()
    await page.locator('#stay-guests-listbox [role="option"]').filter({ hasText: '3 guests' }).click()
    await staySearch.getByRole('button', { name: 'View matching properties' }).click()
    await page.waitForURL((url) => url.pathname === '/properties')
    assert.equal(new URL(page.url()).searchParams.get('area'), 'docklands')
    assert.equal(new URL(page.url()).searchParams.get('checkin'), checkin)
    assert.equal(new URL(page.url()).searchParams.get('checkout'), checkout)
    assert.equal(new URL(page.url()).searchParams.get('guests'), '3')
    await page.locator('[data-properties-page]').waitFor()
    await page.getByText('Plan first, confirm later.').waitFor()
    await page.reload({ waitUntil: 'networkidle' })
    assert.equal(new URL(page.url()).searchParams.get('area'), 'docklands')
    assert.equal(new URL(page.url()).searchParams.get('checkin'), checkin)
    assert.equal(new URL(page.url()).searchParams.get('checkout'), checkout)
    assert.equal(new URL(page.url()).searchParams.get('guests'), '3')
    await page.screenshot({ path: path.join(outputDir, '390-property-results.png'), fullPage: true })
    await page.goBack({ waitUntil: 'networkidle' })
    await page.waitForURL((url) => url.pathname === '/')
    assert.equal(await page.locator('#stay-area').getAttribute('data-value'), 'docklands')
    assert.equal(await page.locator('#stay-checkin').getAttribute('data-value'), checkin)
    assert.equal(await page.locator('#stay-checkout').getAttribute('data-value'), checkout)
    assert.equal(await page.locator('#stay-guests').getAttribute('data-value'), '3')
  }

  const carousel = page.locator('#testimonials')
  const testimonialViewport = carousel.locator('[data-testimonial-viewport]')
  await carousel.scrollIntoViewIfNeeded()
  const heights = []
  const contactTops = []
  const authors = new Set()
  for (let step = 0; step < 3; step += 1) {
    const metrics = await page.evaluate(() => {
      const section = document.querySelector('#testimonials')
      const viewport = document.querySelector('[data-testimonial-viewport]')
      const active = document.querySelector('[data-testimonial-slide][aria-hidden="false"]')
      const contact = document.querySelector('#contact')
      return {
        height: viewport.getBoundingClientRect().height,
        contactTop: contact.getBoundingClientRect().top + window.scrollY,
        author: active.querySelector('cite').textContent,
        clipped: active.scrollHeight > viewport.clientHeight + 1,
        activeIndex: section.dataset.activeIndex,
      }
    })
    heights.push(metrics.height)
    contactTops.push(metrics.contactTop)
    authors.add(metrics.author)
    assert.equal(metrics.clipped, false, `${config.name} active testimonial is clipped`)
    await carousel.getByRole('button', { name: 'Next testimonial' }).click()
    await page.waitForTimeout(560)
  }
  assert.equal(authors.size, 3, `${config.name} did not expose all three testimonials`)
  expectClose(heights, 1, `${config.name} testimonial height changed`)
  expectClose(contactTops, 1, `${config.name} contact position changed`)

  await carousel.getByRole('button', { name: 'Pause testimonial rotation' }).click()
  assert.equal(await carousel.locator('[data-pause]').getAttribute('aria-pressed'), 'true')
  await carousel.focus()
  const keyboardStart = await carousel.getAttribute('data-active-index')
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(560)
  assert.notEqual(await carousel.getAttribute('data-active-index'), keyboardStart, `${config.name} keyboard navigation failed`)

  if (config.name === '390-portrait') {
    await testimonialViewport.scrollIntoViewIfNeeded()
    const box = await testimonialViewport.boundingBox()
    assert.ok(box, 'testimonial viewport has no bounding box')
    const cdp = await context.newCDPSession(page)
    const swipeStart = await carousel.getAttribute('data-active-index')
    await dispatchTouch(cdp, [
      { x: box.x + box.width * 0.72, y: box.y + box.height * 0.55 },
      { x: box.x + box.width * 0.62, y: box.y + box.height * 0.55, delay: 34 },
    ])
    await page.waitForTimeout(600)
    assert.notEqual(await carousel.getAttribute('data-active-index'), swipeStart, 'short fast touch swipe did not change testimonial')

    await testimonialViewport.scrollIntoViewIfNeeded()
    const verticalBox = await testimonialViewport.boundingBox()
    const verticalStartIndex = await carousel.getAttribute('data-active-index')
    const scrollBefore = await page.evaluate(() => window.scrollY)
    await dispatchTouch(cdp, [
      { x: verticalBox.x + verticalBox.width * 0.5, y: verticalBox.y + verticalBox.height * 0.72 },
      { x: verticalBox.x + verticalBox.width * 0.5 + 3, y: verticalBox.y + verticalBox.height * 0.42, delay: 80 },
      { x: verticalBox.x + verticalBox.width * 0.5 + 4, y: verticalBox.y + verticalBox.height * 0.2, delay: 80 },
    ])
    await page.waitForTimeout(300)
    const scrollAfter = await page.evaluate(() => window.scrollY)
    assert.ok(scrollAfter > scrollBefore + 10, `vertical touch did not scroll page: ${scrollBefore} -> ${scrollAfter}`)
    assert.equal(await carousel.getAttribute('data-active-index'), verticalStartIndex, 'vertical touch incorrectly changed testimonial')

    const form = page.locator('#contact form')
    await form.scrollIntoViewIfNeeded()
    await form.getByRole('button', { name: 'Send message' }).click()
    await page.getByText('Please review the highlighted fields. Your message has not been sent.').waitFor()
    await page.locator('#contact-firstName').fill('Visual')
    await page.locator('#contact-lastName').fill('Tester')
    await page.locator('#contact-email').fill('visual.tester@example.com')
    await page.locator('#contact-message').fill('Please keep this local QA message in the form when the backend is unavailable.')
    expectContactFailure = true
    await form.getByRole('button', { name: 'Send message' }).click()
    await page.getByText('We could not save your message right now. Your details are still in the form, so you can try again.').waitFor({ timeout: 12000 })
    assert.equal(await page.locator('#contact-message').inputValue(), 'Please keep this local QA message in the form when the backend is unavailable.')
    expectContactFailure = false

    const chatButton = page.getByRole('button', { name: "Let's Chat!" })
    await chatButton.click()
    await page.getByRole('dialog').waitFor({ state: 'visible' })
    await page.getByRole('button', { name: 'Close chat demo' }).click()
    await page.getByRole('dialog').waitFor({ state: 'hidden' })

    await page.reload({ waitUntil: 'networkidle' })
    await page.evaluate(() => document.fonts.ready)
  }

  await page.locator('#records').scrollIntoViewIfNeeded()
  await page.waitForTimeout(1550)
  const counterTexts = await page.locator('[data-counter]').allTextContents()
  assert.equal(counterTexts[0], '8', `${config.name} dynamic business years did not reach 8`)
  assert.equal(counterTexts[1], process.env.HOMEPAGE_QA_EXPECTED_PROPERTY_COUNT || '121', `${config.name} property count did not use the approved preview value`)
  assert.equal(counterTexts[2], '15,800+', `${config.name} review count did not reach 15,800+`)
  assert.equal(counterTexts[3], '4.8/5', `${config.name} rating did not reach 4.8/5`)
  await page.locator('#contact').scrollIntoViewIfNeeded()
  await page.waitForTimeout(760)
  const contactVisible = await page.locator('#contact').evaluate((section) => (
    [...section.querySelectorAll('[data-reveal]')].every((element) => Number.parseFloat(getComputedStyle(element).opacity) > 0.98)
  ))
  assert.equal(contactVisible, true, `${config.name} contact reveal did not complete`)
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur() })
  await page.waitForTimeout(100)
  await page.screenshot({ path: path.join(outputDir, `${config.name}.png`), fullPage: true })
  assert.deepEqual(pageErrors, [], `${config.name} page errors: ${pageErrors.join(' | ')}`)
  assert.deepEqual(consoleErrors, [], `${config.name} console errors: ${consoleErrors.join(' | ')}`)
  await context.close()
  return { ...config, testimonialHeights: heights, contactTops }
}

async function checkReducedMotion(browser) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', hasTouch: true, isMobile: true })
  const page = await context.newPage()
  await page.goto(baseUrl, { waitUntil: 'networkidle' })
  const carousel = page.locator('#testimonials')
  await carousel.scrollIntoViewIfNeeded()
  assert.equal(await carousel.locator('[data-pause]').getAttribute('aria-pressed'), 'true')
  await page.getByText('Automatic rotation disabled by reduced-motion preference.').waitFor()
  const start = await carousel.getAttribute('data-active-index')
  await carousel.getByRole('button', { name: 'Next testimonial' }).click()
  await page.waitForTimeout(50)
  assert.notEqual(await carousel.getAttribute('data-active-index'), start)
  const duration = await carousel.locator('[data-testimonial-slide]').first().evaluate((element) => getComputedStyle(element).transitionDuration)
  const durationMs = duration.split(',').map((value) => {
    const normalized = value.trim()
    return normalized.endsWith('ms') ? Number.parseFloat(normalized) : Number.parseFloat(normalized) * 1000
  })
  assert.ok(Math.max(...durationMs) <= 1, `reduced-motion transition remained too long: ${duration}`)
  await page.screenshot({ path: path.join(outputDir, '390-reduced-motion.png'), fullPage: true })
  await context.close()
}

async function main() {
  fs.mkdirSync(outputDir, { recursive: true })
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  try {
    const results = []
    for (const config of viewports) results.push(await checkViewport(browser, config))
    await checkReducedMotion(browser)
    fs.writeFileSync(path.join(outputDir, 'results.json'), `${JSON.stringify({ baseUrl, results }, null, 2)}\n`)
    console.log(`homepage-browser-qa: passed ${results.length} viewport/orientation cases + reduced motion`)
    console.log(`screenshots: ${outputDir}`)
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
