const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require(path.resolve(__dirname, '../../backend/node_modules/playwright'))

const baseUrl = process.env.PROPERTY_DETAIL_QA_URL || 'http://127.0.0.1:3004'
const apiUrl = process.env.PROPERTY_DETAIL_API_URL || 'http://127.0.0.1:4012'
const outputDir = path.resolve(__dirname, '../test-results/property-detail')
const viewports = [
  { name: '320-narrow', width: 320, height: 700, touch: true },
  { name: '390-mobile', width: 390, height: 844, touch: true },
  { name: '768-tablet', width: 768, height: 1024, touch: true },
  { name: '1024-small-desktop', width: 1024, height: 800, touch: false },
  { name: '1440-desktop', width: 1440, height: 1000, touch: false },
]

function futureIso(days) {
  const date = new Date()
  date.setHours(12, 0, 0, 0)
  date.setDate(date.getDate() + days)
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-')
}

async function dispatchTouch(cdp, points) {
  const [start, ...moves] = points
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] })
  for (const point of moves) {
    await new Promise((resolve) => setTimeout(resolve, point.delay || 30))
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: point.x, y: point.y }] })
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

async function runViewport(browser, property, viewport) {
  console.log(`checking ${viewport.name}`)
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, hasTouch: viewport.touch, isMobile: viewport.width <= 768, deviceScaleFactor: 1 })
  const page = await context.newPage()
  const consoleErrors = []
  const pageErrors = []
  const mutations = []
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(`${message.text()} @ ${message.location().url || 'unknown'}`) })
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('request', (request) => { if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && request.url().includes('/public/guest-site')) mutations.push(`${request.method()} ${request.url()}`) })
  await page.goto(`${baseUrl}/properties/${encodeURIComponent(property.id)}`, { waitUntil: 'domcontentloaded' })
  await page.locator('[data-property-detail]').waitFor()
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(200)
  await page.getByRole('heading', { name: property.hero_title, exact: true }).waitFor()

  const titleLayout = await page.evaluate((expectedTitle) => {
    const heading = [...document.querySelectorAll('h1')].find((element) => element.textContent === expectedTitle)
    const titleCopy = heading.parentElement
    const titleRow = titleCopy.parentElement
    const titleShell = titleRow.parentElement
    const back = titleShell.querySelector('a[href^="/properties"]')
    const region = titleCopy.querySelector('p')
    const actions = titleRow.querySelector('div:last-child')
    const gallery = document.querySelector('[aria-label="Property photos"]')
    const rect = (element) => { const value = element.getBoundingClientRect(); return { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height } }
    return {
      heading: rect(heading), back: rect(back), region: rect(region), actions: rect(actions), shell: rect(titleShell), gallery: rect(gallery),
      titleClipped: heading.scrollWidth > heading.clientWidth + 2,
      headingScrollWidth: heading.scrollWidth,
      headingClientWidth: heading.clientWidth,
      headingScrollHeight: heading.scrollHeight,
      headingClientHeight: heading.clientHeight,
      titleShellParagraphs: titleShell.querySelectorAll('p').length,
      headingLineHeight: Number.parseFloat(getComputedStyle(heading).lineHeight),
      headingFontSize: Number.parseFloat(getComputedStyle(heading).fontSize),
    }
  }, property.hero_title)
  assert.equal(titleLayout.titleClipped, false, `${viewport.name} longest public title is clipped: ${JSON.stringify(titleLayout)}`)
  assert.equal(titleLayout.titleShellParagraphs, 1, `${viewport.name} title area still contains the duplicate property-type badge`)
  assert.ok(titleLayout.back.bottom + 12 <= titleLayout.heading.top, `${viewport.name} back link is crowded against title: ${JSON.stringify(titleLayout)}`)
  assert.ok(titleLayout.region.bottom + 12 <= titleLayout.gallery.top, `${viewport.name} region is crowded against gallery: ${JSON.stringify(titleLayout)}`)
  assert.ok(titleLayout.headingLineHeight >= titleLayout.headingFontSize, `${viewport.name} title line-height is too tight: ${JSON.stringify(titleLayout)}`)
  if (viewport.width > 760) {
    const overlapsActions = titleLayout.heading.left < titleLayout.actions.right
      && titleLayout.heading.right > titleLayout.actions.left
      && titleLayout.heading.top < titleLayout.actions.bottom
      && titleLayout.heading.bottom > titleLayout.actions.top
    assert.equal(overlapsActions, false, `${viewport.name} title overlaps Save/Share actions: ${JSON.stringify(titleLayout)}`)
  }

  const overflow = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, page: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) }))
  assert.ok(overflow.page <= overflow.viewport + 1, `${viewport.name} horizontal overflow ${overflow.page} > ${overflow.viewport}`)
  const visibleText = await page.locator('body').innerText()
  assert.doesNotMatch(visibleText, /[\u3400-\u9fff]/, `${viewport.name} public detail contains untranslated Chinese text`)
  assert.equal(await page.getByText('Property reviews will appear here', { exact: true }).count(), 1)
  assert.equal(await page.locator('#stay-requests article').count(), 3, `${viewport.name} stay request categories are incomplete`)
  assert.equal(await page.locator('#before-arrival').getByRole('heading', { name: 'Before you arrive', exact: true }).count(), 1, `${viewport.name} merged arrival heading is duplicated`)
  assert.equal(await page.locator('#stay-requests').getByRole('heading', { name: 'Frequently asked questions', exact: true }).count(), 1, `${viewport.name} FAQ heading is missing`)
  assert.equal(await page.locator('#stay-requests').getByRole('heading', { name: 'Can I check in early?', exact: true }).count(), 1, `${viewport.name} early check-in question is missing`)
  assert.equal(await page.locator('#stay-requests').getByRole('heading', { name: 'Can I check out late?', exact: true }).count(), 1, `${viewport.name} late check-out question is missing`)
  assert.equal(await page.locator('#stay-requests').getByRole('heading', { name: 'Can I drop off my luggage before check-in?', exact: true }).count(), 1, `${viewport.name} luggage question is missing`)
  assert.equal(await page.locator('#stay-requests').getByText('Q&A', { exact: true }).count(), 3, `${viewport.name} Q&A labels are incomplete`)
  assert.match(visibleText, /No fee · Advance request/, `${viewport.name} early check-in request is missing`)
  assert.doesNotMatch(visibleText, /From 11:30AM/, `${viewport.name} retained the incorrect early check-in time`)
  assert.match(visibleText, /Until 11:30AM · A\$20/, `${viewport.name} late check-out rule is missing`)
  assert.doesNotMatch(visibleText, /Payment timing|nothing is charged here/, `${viewport.name} exposes an unapproved payment-timing statement`)
  assert.match(visibleText, /Can I drop off my luggage before check-in\?/, `${viewport.name} luggage question is missing`)
  assert.match(visibleText, /Check-in\s+3PM\s+Check-out\s+10AM/i, `${viewport.name} standard arrival times are missing`)
  assert.doesNotMatch(visibleText, /3:00 PM|10:00 AM|11:30 AM/, `${viewport.name} retained a non-canonical time display`)
  assert.doesNotMatch(visibleText, /Ask before you arrive|Optional stay requests|not configured in the public listing data/, `${viewport.name} retained duplicate or developer-facing arrival copy`)
  const requestLinks = page.locator('#stay-requests a[href="/#contact"]')
  assert.equal(await requestLinks.count(), 3, `${viewport.name} request actions are incomplete`)
  if (property.price_label) assert.doesNotMatch(visibleText, new RegExp(String(property.price_label).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${viewport.name} exposed the stored static price as public pricing`)
  if (viewport.width > 760) {
    assert.match(visibleText, /Live PMS price\s+Not connected/, `${viewport.name} PMS pricing state is unclear`)
  }
  assert.equal(mutations.length, 0, `${viewport.name} performed a public mutation: ${mutations.join(', ')}`)

  const map = page.locator('[data-interactive-map]')
  await map.scrollIntoViewIfNeeded()
  await map.locator('img').first().waitFor()
  await page.waitForFunction(() => {
    const mapElement = document.querySelector('[data-interactive-map]')
    const mapRect = mapElement.getBoundingClientRect()
    const visibleTiles = [...mapElement.querySelectorAll('img')].filter((image) => {
      const tile = image.getBoundingClientRect()
      return tile.left < mapRect.right && tile.right > mapRect.left && tile.top < mapRect.bottom && tile.bottom > mapRect.top
    })
    return visibleTiles.length >= 4 && visibleTiles.every((image) => image.complete && image.naturalWidth === 256 && image.naturalHeight === 256)
  })
  const mapLayout = await map.evaluate((element) => {
    const rect = (node) => { const value = node.getBoundingClientRect(); return { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height } }
    const mapRect = rect(element)
    const circle = rect(element.querySelector('[class*="mapRadius"]'))
    const visibleTiles = [...element.querySelectorAll('img')].filter((image) => {
      const tile = image.getBoundingClientRect()
      return tile.left < mapRect.right && tile.right > mapRect.left && tile.top < mapRect.bottom && tile.bottom > mapRect.top
    })
    return {
      map: mapRect,
      circle,
      zoom: Number(element.dataset.zoom),
      touchAction: getComputedStyle(element).touchAction,
      tiles: visibleTiles.map((image) => ({ ...rect(image), naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight })),
      controls: [...element.querySelectorAll('button')].map((button) => rect(button)),
    }
  })
  assert.equal(mapLayout.zoom, 13, `${viewport.name} approximate map did not start at the controlled zoom`)
  assert.equal(mapLayout.touchAction, 'pan-y', `${viewport.name} approximate map blocks vertical page gestures`)
  assert.ok(mapLayout.tiles.length >= 4, `${viewport.name} approximate map rendered too few visible tiles`)
  assert.ok(mapLayout.tiles.every((tile) => tile.width === 256 && tile.height === 256 && tile.naturalWidth === 256 && tile.naturalHeight === 256), `${viewport.name} map tiles were stretched: ${JSON.stringify(mapLayout.tiles)}`)
  assert.ok(mapLayout.controls.every((control) => control.width >= 44 && control.height >= 44), `${viewport.name} map controls are too small: ${JSON.stringify(mapLayout.controls)}`)
  assert.ok(mapLayout.circle.left < mapLayout.map.right && mapLayout.circle.right > mapLayout.map.left && mapLayout.circle.top < mapLayout.map.bottom && mapLayout.circle.bottom > mapLayout.map.top, `${viewport.name} approximate-area circle is not visible`)

  await map.focus()
  const circleBeforeKeyboardPan = await map.locator('[class*="mapRadius"]').evaluate((element) => element.getBoundingClientRect().left)
  await page.keyboard.press('ArrowRight')
  const circleAfterKeyboardPan = await map.locator('[class*="mapRadius"]').evaluate((element) => element.getBoundingClientRect().left)
  assert.ok(circleAfterKeyboardPan < circleBeforeKeyboardPan - 40, `${viewport.name} keyboard map pan did not move the anchored area circle`)
  await page.keyboard.press('Home')
  await map.getByRole('button', { name: 'Zoom in' }).click()
  assert.equal(await map.getAttribute('data-zoom'), '14', `${viewport.name} map zoom-in control failed`)
  await map.getByRole('button', { name: 'Reset map' }).click()
  assert.equal(await map.getAttribute('data-zoom'), '13', `${viewport.name} map reset control failed`)

  if (viewport.touch) {
    const mapBox = await map.boundingBox()
    assert.ok(mapBox, `${viewport.name} map has no touch geometry`)
    const cdp = await context.newCDPSession(page)
    const circleBeforeTouchPan = await map.locator('[class*="mapRadius"]').evaluate((element) => element.getBoundingClientRect().left)
    await dispatchTouch(cdp, [
      { x: mapBox.x + mapBox.width * .72, y: mapBox.y + mapBox.height * .58 },
      { x: mapBox.x + mapBox.width * .32, y: mapBox.y + mapBox.height * .58, delay: 90 },
    ])
    const circleAfterTouchPan = await map.locator('[class*="mapRadius"]').evaluate((element) => element.getBoundingClientRect().left)
    assert.ok(circleAfterTouchPan < circleBeforeTouchPan - 30, `${viewport.name} horizontal map touch pan failed`)
    await map.getByRole('button', { name: 'Reset map' }).click()
    const scrollBeforeMapSwipe = await page.evaluate(() => window.scrollY)
    await dispatchTouch(cdp, [
      { x: mapBox.x + mapBox.width * .55, y: mapBox.y + mapBox.height * .72 },
      { x: mapBox.x + mapBox.width * .55, y: mapBox.y + mapBox.height * .3, delay: 100 },
    ])
    await page.waitForTimeout(120)
    const scrollAfterMapSwipe = await page.evaluate(() => window.scrollY)
    assert.ok(scrollAfterMapSwipe > scrollBeforeMapSwipe + 20, `${viewport.name} vertical page swipe was trapped by the map`)
  }
  if (viewport.name === '390-mobile' || viewport.name === '1440-desktop') {
    await map.scrollIntoViewIfNeeded()
    await page.screenshot({ path: path.join(outputDir, `${viewport.name}-nearby-map.png`) })
  }
  await page.evaluate(() => { document.documentElement.style.scrollBehavior = 'auto'; window.scrollTo(0, 0) })
  await page.waitForFunction(() => window.scrollY === 0)

  if (viewport.width > 760) {
    const layout = await page.evaluate(() => {
      const gallerySection = document.querySelector('[aria-label="Property photos"]')
      const desktopGallery = [...gallerySection.children].find((element) => getComputedStyle(element).display === 'grid' && element.querySelector('img'))
      const caption = [...gallerySection.children].find((element) => element.textContent.includes('View photos'))
      const nav = document.querySelector('nav[aria-label="Property sections"]')
      const overview = document.querySelector('#overview')
      const aside = document.querySelector('aside[aria-label="Plan your stay"]')
      const guestStepper = aside.querySelector('[data-guest-stepper]')
      const rect = (element) => { const value = element.getBoundingClientRect(); return { top: value.top, bottom: value.bottom, height: value.height } }
      return {
        gallery: rect(gallerySection), desktop: rect(desktopGallery), caption: rect(caption), nav: rect(nav), overview: rect(overview), aside: rect(aside),
        galleryOverflow: getComputedStyle(desktopGallery).overflow,
        galleryButtons: [...desktopGallery.querySelectorAll('button')].map((element) => ({ ...rect(element), overflow: getComputedStyle(element).overflow })),
        guestButtons: [...guestStepper.querySelectorAll('button')].map((element) => rect(element)),
        nativeGuestSelects: aside.querySelectorAll('select').length,
      }
    })
    assert.equal(layout.galleryOverflow, 'hidden', `${viewport.name} gallery no longer clips its zoom treatment: ${JSON.stringify(layout)}`)
    assert.ok(layout.galleryButtons.every((button) => button.bottom <= layout.desktop.bottom + 1 && button.overflow === 'hidden'), `${viewport.name} gallery button escaped its fixed grid: ${JSON.stringify(layout)}`)
    assert.ok(layout.desktop.bottom <= layout.caption.top + 1, `${viewport.name} gallery overlaps its caption: ${JSON.stringify(layout)}`)
    assert.ok(layout.gallery.bottom <= layout.nav.top + 1, `${viewport.name} gallery overlaps section navigation: ${JSON.stringify(layout)}`)
    assert.ok(layout.nav.bottom <= layout.overview.top + 1, `${viewport.name} section navigation overlaps overview at rest: ${JSON.stringify(layout)}`)
    assert.ok(layout.aside.top >= layout.overview.top - 1, `${viewport.name} booking card starts above overview: ${JSON.stringify(layout)}`)
    assert.equal(layout.nativeGuestSelects, 0, `${viewport.name} booking card kept a native guest selector`)
    assert.equal(layout.guestButtons.length, 2, `${viewport.name} booking card guest stepper is incomplete`)
    assert.ok(layout.guestButtons.every((button) => button.height >= 36), `${viewport.name} booking card guest stepper targets are too small: ${JSON.stringify(layout.guestButtons)}`)

    await page.getByRole('link', { name: 'Overview', exact: true }).click()
    await page.waitForTimeout(250)
    const overviewAnchor = await page.evaluate(() => {
      const nav = document.querySelector('nav[aria-label="Property sections"]').getBoundingClientRect()
      const overview = document.querySelector('#overview').getBoundingClientRect()
      const aside = document.querySelector('aside[aria-label="Plan your stay"]').getBoundingClientRect()
      return { navBottom: nav.bottom, overviewTop: overview.top, asideTop: aside.top }
    })
    assert.ok(overviewAnchor.overviewTop >= overviewAnchor.navBottom - 1, `${viewport.name} sticky navigation covers overview anchor: ${JSON.stringify(overviewAnchor)}`)
    assert.ok(overviewAnchor.asideTop >= overviewAnchor.navBottom - 1, `${viewport.name} sticky booking card covers section navigation: ${JSON.stringify(overviewAnchor)}`)
    await page.getByRole('link', { name: 'Before you arrive', exact: true }).click()
    await page.waitForTimeout(250)
    const arrivalAnchor = await page.evaluate(() => {
      const nav = document.querySelector('nav[aria-label="Property sections"]').getBoundingClientRect()
      const arrival = document.querySelector('#before-arrival').getBoundingClientRect()
      return { navBottom: nav.bottom, arrivalTop: arrival.top }
    })
    assert.ok(arrivalAnchor.arrivalTop >= arrivalAnchor.navBottom - 1, `${viewport.name} sticky navigation covers the merged arrival anchor: ${JSON.stringify(arrivalAnchor)}`)
    if (viewport.name === '1024-small-desktop' || viewport.name === '1440-desktop') {
      await page.screenshot({ path: path.join(outputDir, `${viewport.name}-gallery-layout-scroll.png`) })
    }
  }

  const save = page.locator('[data-local-save]')
  await save.click()
  await page.waitForFunction(() => document.querySelector('[data-local-save]')?.getAttribute('aria-pressed') === 'true')
  assert.equal(await save.getAttribute('aria-pressed'), 'true', `${viewport.name} local save did not toggle`)

  if (viewport.width <= 820) {
    const menu = page.locator('button[aria-controls="mz-primary-nav"]')
    await menu.click()
    assert.equal(await menu.getAttribute('aria-expanded'), 'true')
    assert.equal(await page.locator('#mz-primary-nav a[aria-current="page"]').textContent(), 'All Properties')
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => document.querySelector('button[aria-controls="mz-primary-nav"]')?.getAttribute('aria-expanded') === 'false')
    assert.equal(await menu.evaluate((element) => document.activeElement === element), true)
  }

  if (viewport.width <= 760) {
    const gallery = page.locator('[aria-label="Property photos"] > div[tabindex="0"]')
    await gallery.scrollIntoViewIfNeeded()
    const box = await gallery.boundingBox()
    assert.ok(box, `${viewport.name} mobile gallery has no geometry`)
    if (property.gallery_urls.length > 1) {
      const cdp = await context.newCDPSession(page)
      await dispatchTouch(cdp, [
        { x: box.x + box.width * .78, y: box.y + box.height * .55 },
        { x: box.x + box.width * .22, y: box.y + box.height * .55, delay: 90 },
      ])
      await page.waitForTimeout(450)
      const scrollLeft = await gallery.evaluate((element) => element.scrollLeft)
      assert.ok(scrollLeft > box.width * .45, `${viewport.name} horizontal gallery swipe did not advance`)
      await gallery.focus()
      await page.keyboard.press('ArrowLeft')
      await page.waitForTimeout(450)
      const returnedScrollLeft = await gallery.evaluate((element) => element.scrollLeft)
      assert.ok(returnedScrollLeft < box.width * .35, `${viewport.name} gallery keyboard navigation did not return (${scrollLeft} -> ${returnedScrollLeft}, width ${box.width})`)
    }
    await page.evaluate(() => { document.documentElement.style.scrollBehavior = 'auto'; window.scrollTo(0, document.documentElement.scrollHeight) })
    await page.waitForFunction(() => window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2)
    const safeFooter = await page.evaluate(() => {
      const footerBottom = document.querySelector('footer > div:last-child').getBoundingClientRect()
      const bar = document.querySelector('[data-mobile-stay-bar]').getBoundingClientRect()
      return { footerBottom: footerBottom.bottom, barTop: bar.top }
    })
    assert.ok(safeFooter.footerBottom <= safeFooter.barTop + 1, `${viewport.name} stay bar covers footer content: ${JSON.stringify(safeFooter)}`)
  }

  const rulesTrigger = page.getByRole('button', { name: /Read all house rules/ })
  if (viewport.name === '390-mobile' || viewport.name === '1440-desktop') await page.locator('#before-arrival').screenshot({ path: path.join(outputDir, `${viewport.name}-before-arrival-merged.png`) })
  await rulesTrigger.scrollIntoViewIfNeeded()
  const beforeDialogScroll = await page.evaluate(() => window.scrollY)
  await rulesTrigger.click()
  await page.getByRole('dialog').waitFor()
  await page.getByRole('dialog').getByRole('heading', { name: 'House rules', exact: true }).waitFor()
  if (viewport.name === '390-mobile' || viewport.name === '1440-desktop') await page.screenshot({ path: path.join(outputDir, `${viewport.name}-rules-panel.png`) })
  await page.keyboard.press('Escape')
  await page.getByRole('dialog').waitFor({ state: 'detached' })
  await page.waitForTimeout(80)
  assert.ok(await rulesTrigger.evaluate((element) => document.activeElement === element), `${viewport.name} rules dialog did not restore focus`)
  const afterDialogScroll = await page.evaluate(() => window.scrollY)
  assert.ok(Math.abs(afterDialogScroll - beforeDialogScroll) <= 2, `${viewport.name} rules dialog did not restore scroll: ${beforeDialogScroll} -> ${afterDialogScroll}`)
  await rulesTrigger.click()
  await page.getByRole('dialog').waitFor()
  await page.getByRole('button', { name: 'Back to property', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'detached' })

  const cancellationTrigger = page.getByRole('button', { name: /View cancellation information/ })
  await cancellationTrigger.scrollIntoViewIfNeeded()
  const beforeCancellationScroll = await page.evaluate(() => window.scrollY)
  await cancellationTrigger.click()
  const cancellationDialog = page.getByRole('dialog')
  await cancellationDialog.getByRole('heading', { name: 'Cancellation policy', exact: true }).waitFor()
  const cancellationText = await cancellationDialog.innerText()
  assert.match(cancellationText, /Confirm before booking/)
  assert.doesNotMatch(cancellationText, /not configured in the public listing data|No policy inferred|Terms not available/)
  await page.keyboard.press('Escape')
  await cancellationDialog.waitFor({ state: 'detached' })
  await page.waitForTimeout(80)
  assert.ok(await cancellationTrigger.evaluate((element) => document.activeElement === element), `${viewport.name} cancellation dialog did not restore focus`)
  const afterCancellationScroll = await page.evaluate(() => window.scrollY)
  assert.ok(Math.abs(afterCancellationScroll - beforeCancellationScroll) <= 2, `${viewport.name} cancellation dialog did not restore scroll: ${beforeCancellationScroll} -> ${afterCancellationScroll}`)

  const dateTrigger = page.locator('[data-date-dialog-trigger]:visible')
  await dateTrigger.click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('heading', { name: 'Choose dates & guests' }).waitFor()
  assert.equal(await dialog.locator('select').count(), 0, `${viewport.name} date dialog kept a native guest selector`)
  const dialogStepper = dialog.locator('[data-guest-stepper]')
  assert.equal(await dialogStepper.count(), 1, `${viewport.name} date dialog guest stepper is missing`)
  const guestBefore = Number(await dialogStepper.locator('output strong').innerText())
  const increaseGuests = dialogStepper.getByRole('button', { name: 'Increase guests' })
  const decreaseGuests = dialogStepper.getByRole('button', { name: 'Decrease guests' })
  if (guestBefore < Number(property.public_capacity_override || property.capacity || 1)) {
    await increaseGuests.focus()
    await page.keyboard.press('Enter')
    assert.equal(Number(await dialogStepper.locator('output strong').innerText()), guestBefore + 1, `${viewport.name} guest keyboard increment failed`)
    await decreaseGuests.click()
    assert.equal(Number(await dialogStepper.locator('output strong').innerText()), guestBefore, `${viewport.name} guest decrement failed`)
  } else {
    assert.equal(await increaseGuests.isDisabled(), true, `${viewport.name} guest maximum is not disabled`)
  }
  const guestTargets = await dialogStepper.locator('button').evaluateAll((buttons) => buttons.map((button) => { const rect = button.getBoundingClientRect(); return { width: rect.width, height: rect.height } }))
  const minimumGuestTarget = viewport.width <= 760 ? 44 : 36
  assert.ok(guestTargets.every((target) => target.width >= minimumGuestTarget && target.height >= minimumGuestTarget), `${viewport.name} dialog guest touch targets are too small: ${JSON.stringify(guestTargets)}`)
  const checkin = futureIso(2)
  const checkout = futureIso(4)
  await dialog.locator(`[data-date="${checkin}"]:not([disabled])`).first().click()
  await dialog.locator(`[data-date="${checkout}"]:not([disabled])`).first().click()
  if (viewport.name === '390-mobile' || viewport.name === '1440-desktop') await page.screenshot({ path: path.join(outputDir, `${viewport.name}-dates-panel.png`) })
  await dialog.getByRole('button', { name: /Done/ }).click()
  await dialog.waitFor({ state: 'detached' })
  await page.waitForTimeout(80)
  assert.ok(await dateTrigger.evaluate((element) => document.activeElement === element), `${viewport.name} date dialog did not restore focus`)

  await page.evaluate(() => { document.documentElement.style.scrollBehavior = 'auto'; window.scrollTo(0, 0) })
  await page.waitForFunction(() => window.scrollY === 0)
  await page.screenshot({ path: path.join(outputDir, `${viewport.name}.png`), fullPage: true })
  assert.equal(pageErrors.length, 0, `${viewport.name} page errors: ${pageErrors.join(' | ')}`)
  assert.equal(consoleErrors.length, 0, `${viewport.name} console errors: ${consoleErrors.join(' | ')}`)
  assert.equal(mutations.length, 0, `${viewport.name} performed a public mutation: ${mutations.join(', ')}`)
  const result = { ...viewport, overflow, pageErrors, consoleErrors, mutations }
  await context.close()
  return result
}

;(async () => {
  fs.mkdirSync(outputDir, { recursive: true })
  const response = await fetch(`${apiUrl}/public/guest-site/properties?locale=en`)
  assert.equal(response.ok, true, `public property read failed: ${response.status}`)
  const properties = await response.json()
  const property = properties
    .filter((item) => item?.id && item?.is_published === true && Array.isArray(item.gallery_urls) && item.gallery_urls.length > 1)
    .sort((left, right) => (
      String(right.hero_title || '').length - String(left.hero_title || '').length
      || String(right.hero_title || '').localeCompare(String(left.hero_title || ''))
    ))[0]
  assert.ok(property, 'no published public property with a gallery is available for read-only QA')
  const browser = await chromium.launch({ headless: true })
  try {
    const results = []
    for (const viewport of viewports) results.push(await runViewport(browser, property, viewport))

    const reduced = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' })
    const page = await reduced.newPage()
    await page.goto(`${baseUrl}/properties/${encodeURIComponent(property.id)}`, { waitUntil: 'domcontentloaded' })
    await page.locator('[data-property-detail]').waitFor()
    const duration = await page.locator('[aria-label="Property photos"] img').first().evaluate((element) => getComputedStyle(element).transitionDuration)
    assert.ok(parseFloat(duration) <= .001, `reduced motion transition remained active: ${duration}`)
    await page.screenshot({ path: path.join(outputDir, '390-reduced-motion.png'), fullPage: true })
    await reduced.close()

    fs.writeFileSync(path.join(outputDir, 'results.json'), `${JSON.stringify({ property_id: property.id, property_title: property.hero_title, api: apiUrl, results }, null, 2)}\n`)
    console.log(`property detail browser QA: PASS (${viewports.length} viewports, property ${property.id})`)
  } finally {
    await browser.close()
  }
})().catch((error) => { console.error(error); process.exit(1) })
