const assert = require('node:assert/strict')
const path = require('node:path')

const baseUrl = process.env.CLEANING_MANUAL_CREATE_QA_URL || 'http://127.0.0.1:3016'
const parsedBaseUrl = new URL(baseUrl)
const allowedQaHosts = new Set(['127.0.0.1', 'localhost', '[::1]'])
if (parsedBaseUrl.protocol !== 'http:' || !allowedQaHosts.has(parsedBaseUrl.hostname.toLowerCase())) {
  throw new Error('CLEANING_MANUAL_CREATE_QA_URL must use HTTP on a loopback host')
}
const { chromium } = require(path.resolve(__dirname, '../../backend/node_modules/playwright'))
const capturedCreates = []

function json(route, payload, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) })
}

async function installApiMock(page) {
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const pathname = url.pathname.replace(/^\/api/, '')
    if (pathname === '/auth/me') return json(route, { username: 'qa-admin', role: 'admin' })
    if (pathname === '/rbac/my-permissions') return json(route, ['cleaning.view', 'cleaning.manage'])
    if (pathname === '/properties') {
      return json(route, [{ id: 'property-qa-1', code: 'QA-001', address: 'QA Docklands', region: 'Docklands' }])
    }
    if (pathname === '/cleaning/staff') return json(route, [])
    if (pathname === '/cleaning/calendar-range') return json(route, [])
    if (pathname === '/cleaning/tasks/minmax') return json(route, { ok: true, min: null, max: null, from: '2026-11-02' })
    if (pathname === '/health/db') return json(route, { pg: true })
    if (pathname === '/cleaning/tasks' && request.method() === 'POST') {
      capturedCreates.push(request.postDataJSON())
      return json(route, { ok: true, rows: [] }, 201)
    }
    if (pathname === '/notifications/unread-count') return json(route, { count: 0 })
    if (pathname === '/version') return json(route, { version: 'qa' })
    if (pathname === '/health') return json(route, { ok: true })
    return json(route, [])
  })
}

async function chooseSelectInField(page, root, label, option) {
  const field = root.getByText(label, { exact: true }).locator('..')
  await field.locator('.ant-select').click()
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').last().getByText(option, { exact: true }).click()
}

async function fillInputInField(root, label, value) {
  const field = root.getByText(label, { exact: true }).locator('..')
  await field.locator('input').fill(value)
}

async function openCreateModal(page, runtimeErrors) {
  await page.getByRole('button', { name: '新增清洁任务', exact: true }).click()
  const modal = page.locator('.ant-modal').filter({ hasText: '新增清洁任务' }).last()
  try {
    await modal.waitFor({ timeout: 5000 })
  } catch (error) {
    const diagnostics = await page.evaluate(() => ({
      modalCount: document.querySelectorAll('.ant-modal').length,
      bodyText: document.body.innerText.slice(0, 1000),
    }))
    throw new Error(`manual create modal did not open: ${JSON.stringify(diagnostics)}; runtime=${runtimeErrors.join(' | ')}; ${error.message}`)
  }
  await chooseSelectInField(page, modal, '房号', 'QA-001 QA Docklands')
  return modal
}

async function setMode(page, modal, label) {
  await chooseSelectInField(page, modal, '类型', label)
  if (label === '新增入住') await chooseSelectInField(page, modal, '与退房任务的关系', '明确创建独立入住任务')
}

async function submit(page, modal) {
  await modal.locator('.ant-modal-footer .ant-btn-primary').click()
  await modal.waitFor({ state: 'hidden' })
}

async function runCase(page, runtimeErrors, input) {
  const before = capturedCreates.length
  const modal = await openCreateModal(page, runtimeErrors)
  if (input.prefillPasswords) {
    await fillInputInField(modal, '退房密码', input.checkoutPassword)
    await fillInputInField(modal, '入住密码', input.checkinPassword)
  }
  await setMode(page, modal, input.modeLabel)
  if (!input.prefillPasswords && input.modeLabel !== '入住中清洁') {
    if (input.checkoutPassword !== undefined) await fillInputInField(modal, '退房密码', input.checkoutPassword)
    if (input.checkinPassword !== undefined) await fillInputInField(modal, '入住密码', input.checkinPassword)
  }
  await submit(page, modal)
  assert.equal(capturedCreates.length, before + 1, `${input.name}: expected exactly one create request`)
  const payload = capturedCreates.at(-1)
  assert.equal(payload.create_mode, input.expectedMode, `${input.name}: wrong create_mode`)
  assert.deepEqual(
    Object.fromEntries(Object.entries(payload).filter(([key]) => key === 'old_code' || key === 'new_code')),
    input.expectedPasswords,
    `${input.name}: password field applicability mismatch`,
  )
}

async function runFailureAndDuplicateGuard(page, runtimeErrors) {
  let attempts = 0
  await page.unroute('**/api/**')
  await installApiMock(page)
  await page.route('**/api/cleaning/tasks', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    attempts += 1
    if (attempts === 1) return json(route, { message: 'synthetic_create_failure' }, 500)
    await new Promise((resolve) => setTimeout(resolve, 200))
    capturedCreates.push(route.request().postDataJSON())
    return json(route, { ok: true, rows: [] }, 201)
  })

  const modal = await openCreateModal(page, runtimeErrors)
  await setMode(page, modal, '新增退房')
  await fillInputInField(modal, '退房密码', '4455')
  await modal.locator('.ant-modal-footer .ant-btn-primary').click()
  await page.getByText('synthetic_create_failure', { exact: true }).waitFor()
  await modal.waitFor()
  assert.equal(await modal.getByText('4455', { exact: true }).count(), 0, 'password must stay in the input, not render as plain text')
  assert.equal(await modal.getByText('退房密码', { exact: true }).locator('..').locator('input').inputValue(), '4455', 'failed submit cleared the form')

  const createButton = modal.locator('.ant-modal-footer .ant-btn-primary')
  await createButton.evaluate((button) => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await modal.waitFor({ state: 'hidden' })
  assert.equal(attempts, 2, 'rapid duplicate submit sent more than one retry request')
}

async function main() {
  const browser = await chromium.launch({ headless: true })
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    const payload = Buffer.from(JSON.stringify({ role: 'admin', sub: 'qa-admin' })).toString('base64url')
    await context.addCookies([{ name: 'auth', value: `qa.${payload}.signature`, url: baseUrl }])
    const page = await context.newPage()
    const runtimeErrors = []
    page.on('pageerror', (error) => runtimeErrors.push(`pageerror:${error.message}`))
    page.on('console', (message) => {
      if (message.type() === 'error') runtimeErrors.push(`console:${message.text()}`)
    })
    await installApiMock(page)
    await page.goto(`${baseUrl}/cleaning`, { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle')
    await page.getByRole('button', { name: '新增清洁任务' }).waitFor()

    const cases = [
      { name: 'checkout nonblank', modeLabel: '新增退房', expectedMode: 'checkout', checkoutPassword: ' 4455 ', checkinPassword: '7788', expectedPasswords: { old_code: '4455' } },
      { name: 'checkout blank', modeLabel: '新增退房', expectedMode: 'checkout', checkoutPassword: ' ', checkinPassword: '7788', expectedPasswords: { old_code: null } },
      { name: 'checkin nonblank', modeLabel: '新增入住', expectedMode: 'checkin', checkoutPassword: '4455', checkinPassword: ' 7788 ', expectedPasswords: { new_code: '7788' } },
      { name: 'checkin blank', modeLabel: '新增入住', expectedMode: 'checkin', checkoutPassword: '4455', checkinPassword: ' ', expectedPasswords: { new_code: null } },
      { name: 'turnover nonblank', modeLabel: '退房+入住', expectedMode: 'turnover', checkoutPassword: ' 4455 ', checkinPassword: ' 7788 ', expectedPasswords: { old_code: '4455', new_code: '7788' } },
      { name: 'turnover blank', modeLabel: '退房+入住', expectedMode: 'turnover', checkoutPassword: ' ', checkinPassword: ' ', expectedPasswords: { old_code: null, new_code: null } },
      { name: 'stayover with stale values', modeLabel: '入住中清洁', expectedMode: 'stayover', checkoutPassword: '4455', checkinPassword: '7788', prefillPasswords: true, expectedPasswords: {} },
      { name: 'stayover blank', modeLabel: '入住中清洁', expectedMode: 'stayover', checkoutPassword: '', checkinPassword: '', prefillPasswords: true, expectedPasswords: {} },
    ]
    for (const entry of cases) await runCase(page, runtimeErrors, entry)
    await runFailureAndDuplicateGuard(page, runtimeErrors)
    console.log(`cleaning manual create browser QA passed (${cases.length} payload cases + failure/duplicate guard)`)
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
