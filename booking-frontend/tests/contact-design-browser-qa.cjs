const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require(path.resolve(__dirname, '../../backend/node_modules/playwright'))

const baseUrl = process.env.CONTACT_DESIGN_QA_URL || 'http://127.0.0.1:3004'
const outputDir = path.resolve(__dirname, '../test-results/contact-design')
const allViewports = [
  { name: '320-phone', width: 320, height: 700, touch: true },
  { name: '390-phone', width: 390, height: 844, touch: true },
  { name: '768-tablet', width: 768, height: 1024, touch: true },
  { name: '1024-landscape', width: 1024, height: 768, touch: false },
  { name: '1440-desktop', width: 1440, height: 1000, touch: false },
]
const requestedViewports = new Set(String(process.env.CONTACT_DESIGN_QA_VIEWPORT || '').split(',').map((value) => value.trim()).filter(Boolean))
const viewports = requestedViewports.size ? allViewports.filter((config) => requestedViewports.has(config.name)) : allViewports
assert.ok(viewports.length, 'CONTACT_DESIGN_QA_VIEWPORT did not match a configured viewport')

async function openMenuIfNeeded(page, config) {
  if (config.width > 820) return
  const trigger = page.locator('button[aria-controls="mz-primary-nav"]')
  await trigger.click()
  assert.equal(await trigger.getAttribute('aria-expanded'), 'true')
}

async function chooseContactSelect(page, id, option) {
  const trigger = page.locator(`#contact-preview-${id}`)
  await trigger.click()
  await page.waitForFunction((triggerId) => document.getElementById(triggerId)?.getAttribute('aria-expanded') === 'true', `contact-preview-${id}`)
  assert.equal(await trigger.getAttribute('aria-expanded'), 'true')
  await page.getByRole('option').filter({ hasText: option }).click()
  await page.waitForFunction((triggerId) => document.getElementById(triggerId)?.getAttribute('aria-expanded') === 'false', `contact-preview-${id}`)
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false')
  assert.equal((await trigger.innerText()).trim(), option)
}

async function fillPropertyEnquiry(page, name) {
  await page.locator('#contact-preview-name').fill(name)
  await page.locator('#contact-preview-email').fill('review@example.com')
  await page.locator('#contact-preview-phone').fill('+61 400 000 000')
  await page.locator('#contact-preview-suburb').fill('South Melbourne')
  await chooseContactSelect(page, 'propertyType', 'Apartment')
  await chooseContactSelect(page, 'currentUse', 'Short-term rental')
  await page.locator('#contact-preview-message').fill('I would like to discuss management support for this property.')
}

async function checkViewport(browser, config) {
  const context = await browser.newContext({ viewport: { width: config.width, height: config.height }, hasTouch: config.touch, isMobile: config.width <= 820, deviceScaleFactor: 1, locale: 'zh-CN' })
  const page = await context.newPage()
  const pageErrors = []
  const consoleErrors = []
  const mutations = []
  const submissions = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })
  await page.route('http://127.0.0.1:4013/activity', (route) => route.fulfill({ status: 204, body: '' }))
  await page.route('**/public/guest-site/contact-messages', async (route) => {
    const request = route.request()
    assert.equal(request.method(), 'POST')
    submissions.push(request.postDataJSON())
    await new Promise((resolve) => setTimeout(resolve, 80))
    if (submissions.length === 2) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false }) })
      return
    }
    await route.fulfill({ status: submissions.length === 1 ? 201 : 200, contentType: 'application/json', body: JSON.stringify({ ok: true, id: `contact-${submissions.length}`, duplicate: submissions.length > 1 }) })
  })
  page.on('request', (request) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method())) return
    if (/^http:\/\/127\.0\.0\.1:4013\/activity$/.test(request.url())) return
    if (/\/public\/guest-site\/contact-messages$/.test(request.url())) return
    mutations.push(`${request.method()} ${request.url()}`)
  })

  let response = await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' })
  assert.equal(response?.status(), 200)
  await openMenuIfNeeded(page, config)
  await page.locator('#mz-primary-nav a[href="/contact"]').click()
  await page.waitForURL(`${baseUrl}/contact`)
  assert.equal(await page.getByRole('heading', { level: 1 }).textContent(), 'Let’s talk about your property.')
  assert.equal(await page.locator('#mz-primary-nav a[aria-current="page"]').textContent(), 'Contact us')
  assert.equal(await page.getByText('info@mzproperty.com.au', { exact: true }).count() >= 1, true)
  assert.equal(await page.getByText('+61 434 782 499', { exact: true }).count() >= 1, true)
  assert.equal(await page.getByText('130 Gladstone St, South Melbourne, VIC 3205', { exact: true }).count() >= 1, true)
  assert.equal(await page.locator('input[name="enquiry-intent"]').count(), 0)
  assert.equal(await page.locator('input[type="date"]').count(), 0)
  assert.equal(await page.locator('select').count(), 0)
  assert.equal(/[\u3400-\u9fff]/.test(await page.locator('main').innerText()), false)
  assert.equal(/\bSubmit\b|Send property enquiry|Saving…/i.test(await page.locator('main').innerText()), false)
  assert.equal(await page.getByRole('button', { name: 'Let’s talk' }).count(), 1)

  for (const name of ['name', 'email', 'phone', 'suburb', 'propertyType', 'currentUse', 'message']) {
    assert.equal(await page.locator(`[name="${name}"]`).count(), 1, `${config.name} missing ${name}`)
  }

  const flowGeometry = await page.evaluate(() => {
    const form = document.querySelector('[data-contact-form-shell]')?.getBoundingClientRect()
    const guests = document.querySelector('[data-guest-paths]')?.getBoundingClientRect()
    return form && guests ? { formLeft: form.left, formWidth: form.width, guestLeft: guests.left, guestWidth: guests.width } : null
  })
  assert.ok(flowGeometry, `${config.name} missing Contact geometry`)
  assert.ok(Math.abs(flowGeometry.formLeft - flowGeometry.guestLeft) <= 1, `${config.name} Contact left edges differ: ${JSON.stringify(flowGeometry)}`)
  assert.ok(Math.abs(flowGeometry.formWidth - flowGeometry.guestWidth) <= 1, `${config.name} Contact widths differ: ${JSON.stringify(flowGeometry)}`)

  const guestPaths = page.locator('[data-guest-paths]')
  assert.equal(await guestPaths.getByRole('link', { name: 'Explore Our Properties' }).getAttribute('href'), '/#properties')
  assert.equal(await guestPaths.locator('a[href="mailto:info@mzproperty.com.au"]').count(), 1)
  assert.equal(await guestPaths.locator('a[href="tel:+61434782499"]').count(), 1)

  await page.getByRole('button', { name: 'Let’s talk' }).click()
  assert.equal(await page.getByText('Please review the highlighted fields.', { exact: true }).count(), 1)
  await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'alert')
  for (const name of ['name', 'email', 'suburb', 'propertyType', 'currentUse', 'message']) {
    assert.equal(await page.locator(`#contact-preview-${name}`).getAttribute('aria-invalid'), 'true', `${config.name} ${name} should be invalid`)
  }
  assert.equal(await page.locator('#contact-preview-phone').getAttribute('aria-invalid'), 'false')

  const propertyTypeSelect = page.locator('#contact-preview-propertyType')
  const currentUseSelect = page.locator('#contact-preview-currentUse')
  if (config.touch) {
    await propertyTypeSelect.tap()
    await page.waitForFunction(() => document.getElementById('contact-preview-propertyType')?.getAttribute('aria-expanded') === 'true')
    await page.getByRole('option', { name: 'Apartment', exact: true }).tap()
    await page.waitForFunction(() => document.getElementById('contact-preview-propertyType')?.getAttribute('aria-expanded') === 'false')
    assert.equal((await propertyTypeSelect.innerText()).trim(), 'Apartment')
  } else {
    await propertyTypeSelect.focus()
    await page.waitForFunction(() => document.activeElement?.id === 'contact-preview-propertyType')
    await page.keyboard.press('ArrowDown')
    await page.waitForFunction(() => document.getElementById('contact-preview-propertyType')?.getAttribute('aria-expanded') === 'true')
    assert.equal(await propertyTypeSelect.getAttribute('aria-expanded'), 'true')
    assert.equal(await page.getByRole('option', { name: 'Apartment', exact: true }).evaluate((option) => document.activeElement === option), true)
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => document.getElementById('contact-preview-propertyType')?.getAttribute('aria-expanded') === 'false')
    assert.equal(await propertyTypeSelect.getAttribute('aria-expanded'), 'false')
    await page.waitForFunction(() => document.activeElement?.id === 'contact-preview-propertyType')
    assert.equal(await propertyTypeSelect.evaluate((trigger) => document.activeElement === trigger), true)
  }

  if (config.touch) await currentUseSelect.tap()
  else await currentUseSelect.click()
  await page.waitForFunction(() => document.getElementById('contact-preview-currentUse')?.getAttribute('aria-expanded') === 'true')
  assert.equal(await currentUseSelect.getAttribute('aria-expanded'), 'true')
  const openMenuGeometry = await page.locator('[role="listbox"]').evaluate((menu) => {
    const rect = menu.getBoundingClientRect()
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight }
  })
  assert.ok(openMenuGeometry.left >= 0 && openMenuGeometry.right <= openMenuGeometry.viewportWidth + 1, `${config.name} select menu overflow: ${JSON.stringify(openMenuGeometry)}`)
  if (config.touch) await page.getByRole('heading', { name: 'Start a conversation about your property.' }).tap()
  else await page.getByRole('heading', { name: 'Start a conversation about your property.' }).click()
  await page.waitForFunction(() => document.getElementById('contact-preview-currentUse')?.getAttribute('aria-expanded') === 'false')
  assert.equal(await currentUseSelect.getAttribute('aria-expanded'), 'false')

  await fillPropertyEnquiry(page, 'Design reviewer')
  await propertyTypeSelect.click()
  const selectedProperty = page.getByRole('option', { name: /Apartment Selected/ })
  assert.equal(await selectedProperty.getAttribute('aria-selected'), 'true')
  await page.keyboard.press('Escape')
  const submitButton = page.getByRole('button', { name: 'Let’s talk' })
  await submitButton.evaluate((button) => { button.click(); button.click() })
  await page.getByText('Thank you — we’ve received your property enquiry and the MZ Property team can now review it.', { exact: true }).waitFor()
  assert.equal(submissions.length, 1, `${config.name} duplicate click sent more than one request`)
  assert.match(submissions[0].submission_id, /^[0-9a-f-]{36}$/)
  assert.deepEqual({ ...submissions[0], submission_id: '<uuid>' }, {
    submission_id: '<uuid>',
    inquiry_type: 'property_management',
    name: 'Design reviewer',
    email: 'review@example.com',
    phone: '+61 400 000 000',
    property_area: 'South Melbourne',
    property_type: 'Apartment',
    current_use: 'Short-term rental',
    message: 'I would like to discuss management support for this property.',
  })
  for (const name of ['name', 'email', 'phone', 'suburb', 'propertyType', 'currentUse', 'message']) {
    assert.equal(await page.locator(`[name="${name}"]`).inputValue(), '', `${config.name} ${name} did not clear after durable success`)
  }

  await fillPropertyEnquiry(page, 'Retry reviewer')
  await page.getByRole('button', { name: 'Let’s talk' }).click()
  await page.getByText('We couldn’t receive your enquiry right now. Your details are still here, so you can try again.', { exact: true }).waitFor()
  assert.equal(await page.locator('#contact-preview-name').inputValue(), 'Retry reviewer')
  assert.equal(await page.locator('#contact-preview-message').inputValue(), 'I would like to discuss management support for this property.')
  await page.getByRole('button', { name: 'Let’s talk' }).click()
  await page.getByText('Thank you — we’ve received your property enquiry and the MZ Property team can now review it.', { exact: true }).waitFor()
  assert.equal(submissions.length, 3)
  assert.equal(submissions[1].submission_id, submissions[2].submission_id, `${config.name} retry did not reuse its stable submission ID`)
  assert.deepEqual(mutations, [], `${config.name} sent unexpected mutation requests: ${mutations.join(' | ')}`)

  const dimensions = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, page: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) }))
  assert.ok(dimensions.page <= dimensions.viewport + 1, `${config.name} contact overflow: ${JSON.stringify(dimensions)}`)
  assert.equal(await page.locator('a[href*="google.com/maps/search"]').getAttribute('href').then((href) => href?.includes('130%20Gladstone%20St')), true)

  await guestPaths.getByRole('link', { name: 'Explore Our Properties' }).click()
  await page.waitForURL(`${baseUrl}/#properties`)
  assert.equal(await page.locator('#properties').count(), 1)

  await page.goto(`${baseUrl}/contact`, { waitUntil: 'networkidle' })
  await page.locator('a[aria-label="MZ Property home"]').first().click()
  await page.waitForURL(`${baseUrl}/`)
  assert.equal(await page.locator('#home').count(), 1)

  await page.goto(`${baseUrl}/contact`, { waitUntil: 'networkidle' })
  await page.screenshot({ path: path.join(outputDir, `${config.name}.png`), fullPage: true })
  assert.deepEqual(pageErrors, [], `${config.name} page errors: ${pageErrors.join(' | ')}`)
  assert.deepEqual(consoleErrors, [], `${config.name} console errors: ${consoleErrors.join(' | ')}`)
  assert.deepEqual(mutations, [], `${config.name} sent unexpected mutation requests after capture: ${mutations.join(' | ')}`)
  await context.close()
  return { name: config.name, locale: 'zh-CN', alignedContactWidth: flowGeometry.formWidth, submissionRequests: submissions.length, ...dimensions }
}

async function main() {
  fs.mkdirSync(outputDir, { recursive: true })
  const results = []
  for (const config of viewports) {
    const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' })
    try {
      results.push(await checkViewport(browser, config))
    } finally {
      await browser.close()
    }
  }
  const submissionRequests = results.reduce((total, result) => total + result.submissionRequests, 0)
  fs.writeFileSync(path.join(outputDir, 'results.json'), JSON.stringify({ baseUrl, results, submissionRequests }, null, 2))
  console.log(JSON.stringify({ status: 'passed', results, submissionRequests }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
