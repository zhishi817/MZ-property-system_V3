import assert from 'assert'
import { randomBytes } from 'crypto'
import fs from 'fs'
import path from 'path'
import bcrypt from 'bcryptjs'
import { hasPg, pgPool } from '../../src/dbAdapter'
import { hasR2 } from '../../src/r2'
import { buildPersonnelSettlementPreview } from '../../src/lib/personnelSettlementPreview'
import { warmupPersonnelSettlementSchema } from '../../src/lib/personnelSettlementSchema'
import { assertPersonnelSettlementPhase5SchemaReady } from '../../src/lib/personnelSettlementPhase5Schema'
import { CLEANING_PROPERTY_TYPES } from '../../src/lib/personnelSettlement'
import { createPersonnelClaim } from '../../src/lib/personnelWorkloadClaims'
import { runPersonnelSettlementWeeklyJob } from '../../src/lib/personnelSettlementWeeklyJob'
import { getChromiumBrowser, resetChromiumBrowser } from '../../src/lib/playwright'

const PREFIX = 'dev-preview-phase5-'
const WEEK_START = '2010-03-01'
const WEEK_END = '2010-03-07'
const PAYMENT_DATE = '2026-09-11'
const API_BASE = 'http://localhost:4002'
const WEB_BASE = 'http://localhost:3000'
const PREVIEW_PDF = '/private/tmp/mz-phase5-integration-tax-invoice-20260911.pdf'
const WEB_SCREENSHOT = '/private/tmp/mz-phase5-web-integration-20260911.png'
const PRIVATE_PREFIX = 'local-private:personnel-settlements/'
const WEEKLY_JOB_LOCK_KEY = 205091105

const users = {
  admin: `${PREFIX}admin`,
  gst: `${PREFIX}gst`,
  nonGst: `${PREFIX}non-gst`,
}

function requirePreviewWriteGuard() {
  assert.strictEqual(process.env.MZ_DEV_PREVIEW, '1', 'MZ_DEV_PREVIEW must be 1')
  assert.strictEqual(process.env.APP_ENV, 'dev', 'APP_ENV must be dev')
  assert.strictEqual(process.env.DATABASE_ROLE, 'dev', 'DATABASE_ROLE must be dev')
  assert.strictEqual(process.env.MZ_PHASE5_INTEGRATION_WRITE, '1', 'MZ_PHASE5_INTEGRATION_WRITE must be 1')
  assert.strictEqual(process.env.PERSONNEL_SETTLEMENT_WEEKLY_ENABLED, 'false', 'weekly scheduler must remain disabled')
  assert.strictEqual(process.env.NOTIFICATION_WORKER_ENABLED, 'false', 'notification worker must remain disabled')
  assert.strictEqual(process.env.PDF_JOBS_MODE, 'disabled', 'unrelated PDF worker must remain disabled')
  assert.strictEqual(hasR2, false, 'R2 must be disabled for the Preview integration test')
}

function cleanText(value: unknown) {
  return String(value ?? '').trim()
}

function randomElevenDigits() {
  const digits = randomBytes(8).toString('hex').replace(/[a-f]/g, (value) => String(value.charCodeAt(0) % 10))
  return `9${digits.replace(/\D/g, '').padEnd(10, '0').slice(0, 10)}`
}

async function ids(sql: string, params: unknown[] = []) {
  if (!pgPool) return []
  const result = await pgPool.query(sql, params)
  return (result.rows || []).map((row: any) => String(row.id))
}

async function cleanup() {
  if (!pgPool) return
  const batches = await pgPool.query(
    'SELECT id FROM personnel_settlement_batches WHERE week_start=$1::date AND week_end=$2::date',
    [WEEK_START, WEEK_END],
  )
  const batchIds = (batches.rows || []).map((row: any) => String(row.id))
  const settlementRows = batchIds.length
    ? await pgPool.query('SELECT id, user_id FROM personnel_weekly_settlements WHERE batch_id=ANY($1::text[])', [batchIds])
    : { rows: [] }
  const foreignSettlement = (settlementRows.rows || []).find((row: any) => !String(row.user_id).startsWith(PREFIX))
  assert.ok(!foreignSettlement, 'reserved Phase 5 test week contains a non-synthetic settlement')
  const settlementIds = (settlementRows.rows || []).map((row: any) => String(row.id))
  const documentRows = settlementIds.length
    ? await pgPool.query('SELECT id, storage_key FROM personnel_settlement_documents WHERE settlement_id=ANY($1::text[])', [settlementIds])
    : { rows: [] }
  const documentIds = (documentRows.rows || []).map((row: any) => String(row.id))
  const claimIds = await ids('SELECT id FROM personnel_workload_claims WHERE submitter_user_id LIKE $1', [`${PREFIX}%`])
  const ruleIds = await ids('SELECT id FROM personnel_fee_rules WHERE user_id LIKE $1', [`${PREFIX}%`])

  await pgPool.query('BEGIN')
  try {
    await pgPool.query('DELETE FROM event_queue WHERE user_id LIKE $1', [`${PREFIX}%`])
    await pgPool.query('DELETE FROM user_notifications WHERE user_id LIKE $1', [`${PREFIX}%`])
    if (documentIds.length) await pgPool.query('DELETE FROM personnel_settlement_documents WHERE id=ANY($1::text[])', [documentIds])
    if (settlementIds.length) {
      await pgPool.query("DELETE FROM company_expenses WHERE ref_type='personnel_weekly_settlement' AND ref_id=ANY($1::text[])", [settlementIds])
      await pgPool.query('DELETE FROM personnel_settlement_lines WHERE settlement_id=ANY($1::text[])', [settlementIds])
      await pgPool.query('DELETE FROM audit_logs WHERE entity_id=ANY($1::text[])', [settlementIds])
      await pgPool.query('DELETE FROM personnel_weekly_settlements WHERE id=ANY($1::text[])', [settlementIds])
    }
    if (batchIds.length) {
      await pgPool.query('DELETE FROM audit_logs WHERE entity_id=ANY($1::text[])', [batchIds])
      await pgPool.query('DELETE FROM personnel_settlement_batches WHERE id=ANY($1::text[])', [batchIds])
    }
    await pgPool.query('DELETE FROM personnel_settlement_job_runs WHERE week_start=$1::date AND week_end=$2::date', [WEEK_START, WEEK_END])
    if (claimIds.length) {
      await pgPool.query('DELETE FROM personnel_workload_claim_evidence WHERE claim_id=ANY($1::text[])', [claimIds])
      await pgPool.query('DELETE FROM audit_logs WHERE entity_id=ANY($1::text[])', [claimIds])
      await pgPool.query('DELETE FROM personnel_workload_claims WHERE id=ANY($1::text[])', [claimIds])
    }
    if (ruleIds.length) await pgPool.query('DELETE FROM personnel_fee_rule_items WHERE rule_id=ANY($1::text[])', [ruleIds])
    await pgPool.query('DELETE FROM personnel_fee_rules WHERE user_id LIKE $1', [`${PREFIX}%`])
    await pgPool.query('DELETE FROM personnel_settlement_profile_audits WHERE user_id LIKE $1 OR actor_user_id LIKE $1', [`${PREFIX}%`])
    await pgPool.query('DELETE FROM personnel_settlement_profiles WHERE user_id LIKE $1', [`${PREFIX}%`])
    await pgPool.query('DELETE FROM work_task_action_audits WHERE id LIKE $1 OR source_id LIKE $1 OR actor_user_id LIKE $1', [`${PREFIX}%`])
    await pgPool.query('DELETE FROM cleaning_tasks WHERE id LIKE $1', [`${PREFIX}%`])
    await pgPool.query('DELETE FROM properties WHERE id LIKE $1', [`${PREFIX}%`])
    await pgPool.query('DELETE FROM sessions WHERE user_id LIKE $1', [`${PREFIX}%`])
    await pgPool.query('DELETE FROM user_roles WHERE user_id LIKE $1', [`${PREFIX}%`])
    await pgPool.query('DELETE FROM audit_logs WHERE actor_id LIKE $1', [`${PREFIX}%`])
    await pgPool.query('DELETE FROM users WHERE id LIKE $1', [`${PREFIX}%`])
    await pgPool.query('DELETE FROM invoice_companies WHERE id=$1', [`${PREFIX}company`])
    await pgPool.query('COMMIT')
  } catch (error) {
    await pgPool.query('ROLLBACK')
    throw error
  }

  for (const row of documentRows.rows || []) {
    const reference = cleanText(row.storage_key)
    if (!reference.startsWith(PRIVATE_PREFIX)) continue
    const fileName = reference.slice(PRIVATE_PREFIX.length)
    if (!/^personnel-settlement-[a-z0-9]{64}\.pdf$/.test(fileName)) continue
    await fs.promises.unlink(path.resolve(process.cwd(), 'private-uploads', 'personnel-settlements', fileName)).catch(() => undefined)
  }
}

async function assertCleanup() {
  if (!pgPool) throw new Error('pg_required')
  const checks: Array<[string, string, unknown[]]> = [
    ['users', 'SELECT COUNT(*)::int AS count FROM users WHERE id LIKE $1', [`${PREFIX}%`]],
    ['profiles', 'SELECT COUNT(*)::int AS count FROM personnel_settlement_profiles WHERE user_id LIKE $1', [`${PREFIX}%`]],
    ['rules', 'SELECT COUNT(*)::int AS count FROM personnel_fee_rules WHERE user_id LIKE $1', [`${PREFIX}%`]],
    ['tasks', 'SELECT COUNT(*)::int AS count FROM cleaning_tasks WHERE id LIKE $1', [`${PREFIX}%`]],
    ['claims', 'SELECT COUNT(*)::int AS count FROM personnel_workload_claims WHERE submitter_user_id LIKE $1', [`${PREFIX}%`]],
    ['batch', 'SELECT COUNT(*)::int AS count FROM personnel_settlement_batches WHERE week_start=$1::date AND week_end=$2::date', [WEEK_START, WEEK_END]],
    ['runs', 'SELECT COUNT(*)::int AS count FROM personnel_settlement_job_runs WHERE week_start=$1::date AND week_end=$2::date', [WEEK_START, WEEK_END]],
    ['notifications', 'SELECT COUNT(*)::int AS count FROM user_notifications WHERE user_id LIKE $1', [`${PREFIX}%`]],
    ['queue', 'SELECT COUNT(*)::int AS count FROM event_queue WHERE user_id LIKE $1', [`${PREFIX}%`]],
    ['company', 'SELECT COUNT(*)::int AS count FROM invoice_companies WHERE id=$1', [`${PREFIX}company`]],
  ]
  for (const [label, sql, params] of checks) {
    const result = await pgPool.query(sql, params)
    assert.strictEqual(Number(result.rows?.[0]?.count || 0), 0, `${label} synthetic cleanup incomplete`)
  }
}

async function verifySchema() {
  if (!pgPool) throw new Error('pg_required')
  await assertPersonnelSettlementPhase5SchemaReady(pgPool)
  const result = await pgPool.query(
    `SELECT
       EXISTS(SELECT 1 FROM schema_migrations WHERE version='20260911_personnel_settlement_phase5') AS marker,
       to_regclass('public.personnel_settlement_documents') IS NOT NULL AS documents,
       to_regclass('public.personnel_settlement_job_runs') IS NOT NULL AS job_runs`,
  )
  assert.deepStrictEqual(result.rows[0], { marker: true, documents: true, job_runs: true })
}

async function seed(runtimePassword: string) {
  if (!pgPool) throw new Error('pg_required')
  const preview = await buildPersonnelSettlementPreview({ week_start: WEEK_START, user_ids: [] }, pgPool)
  assert.strictEqual(preview.people.filter((person: any) => person.lines?.length).length, 0, 'reserved Phase 5 test week already contains settlement candidates')
  const passwordHash = await bcrypt.hash(runtimePassword, 4)
  const buyerAbn = randomElevenDigits()
  const gstAbn = randomElevenDigits()
  const nonGstAbn = randomElevenDigits()
  await pgPool.query('BEGIN')
  try {
    await pgPool.query(
      `INSERT INTO invoice_companies (
         id, code, legal_name, trading_name, abn, address_line1, address_city,
         address_state, address_postcode, address_country, is_default, status, created_at
       ) VALUES ($1,'PHASE5','Homixa Phase 5 Preview Pty Ltd','Homixa Preview',$2,
         '1 Preview Street','Melbourne','VIC','3000','Australia',true,'active',now() + interval '1 minute')`,
      [`${PREFIX}company`, buyerAbn],
    )
    await pgPool.query(
      `INSERT INTO users (id, username, password_hash, role, display_name, legal_name)
       VALUES ($1,$1,$2,'admin','Phase 5 Preview Admin','Phase 5 Preview Admin')`,
      [users.admin, passwordHash],
    )
    const people = [
      { key: 'gst', userId: users.gst, name: 'Phase 5 GST Supplier', abn: gstAbn, gst: 'registered', rate: 10000 },
      { key: 'non-gst', userId: users.nonGst, name: 'Phase 5 Non-GST Supplier', abn: nonGstAbn, gst: 'not_registered', rate: 12000 },
    ]
    for (const person of people) {
      await pgPool.query(
        `INSERT INTO users (
           id, username, password_hash, role, display_name, legal_name,
           bank_account_name, bank_bsb, bank_account_number, personal_abn
         ) VALUES ($1,$1,$2,'cleaner',$3,$3,$3,'123456',$4,$5)`,
        [person.userId, passwordHash, person.name, person.key === 'gst' ? '90001234' : '90005678', person.abn],
      )
      await pgPool.query(
        `INSERT INTO personnel_settlement_profiles (
           id, user_id, effective_from, settlement_enabled, person_type,
           supplier_legal_name, supplier_business_name, abn, gst_status,
           gst_effective_from, invoice_document_type, currency, created_by, updated_by
         ) VALUES ($1,$2,'2010-01-01',true,'cleaner',$3,$3,$4,$5,
           '2010-01-01','supplier_invoice','AUD',$6,$6)`,
        [`${PREFIX}profile-${person.key}`, person.userId, person.name, person.abn, person.gst, users.admin],
      )
      await pgPool.query(
        `INSERT INTO personnel_fee_rules (
           id, user_id, name, status, effective_from, price_basis, currency, created_by, updated_by
         ) VALUES ($1,$2,$3,'active','2010-01-01','exclusive_gst','AUD',$4,$4)`,
        [`${PREFIX}rule-${person.key}`, person.userId, `${person.name} rule`, users.admin],
      )
      for (const [index, propertyType] of CLEANING_PROPERTY_TYPES.entries()) {
        await pgPool.query(
          `INSERT INTO personnel_fee_rule_items (id, rule_id, component_type, conditions, priority, rate_cents)
           VALUES ($1,$2,'cleaning_task',$3::jsonb,$4,$5)`,
          [`${PREFIX}item-${person.key}-${index}`, `${PREFIX}rule-${person.key}`, JSON.stringify({ property_type: propertyType }), CLEANING_PROPERTY_TYPES.length - index, person.rate],
        )
      }
    }
    await pgPool.query(
      "INSERT INTO properties (id, address, code, type) VALUES ($1,'Synthetic Phase 5 Preview Property','PHASE5','一房一卫')",
      [`${PREFIX}property`],
    )
    const tasks = [
      { key: 'gst', userId: users.gst, date: '2010-03-02' },
      { key: 'non-gst', userId: users.nonGst, date: '2010-03-03' },
    ]
    for (const task of tasks) {
      const taskId = `${PREFIX}task-${task.key}`
      await pgPool.query(
        `INSERT INTO cleaning_tasks (
           id, property_id, date, task_date, status, type, task_type, source,
           cleaner_id, assignee_id
         ) VALUES ($1,$2,$3::date,$3::date,'cleaned','checkout_cleaning','checkout_cleaning','manual',$4,$4)`,
        [taskId, `${PREFIX}property`, task.date, task.userId],
      )
      await pgPool.query(
        `INSERT INTO work_task_action_audits (
           id, source_type, source_id, performed_by_user_id, performed_by_name,
           performed_as_action, performed_at, actor_user_id, status_before, status_after, metadata
         ) VALUES ($1,'cleaning_tasks',$2,$3,$4,'complete_cleaning',
           ($5::date + time '12:00') AT TIME ZONE 'Australia/Melbourne',$3,
           'in_progress','cleaned','{}'::jsonb)`,
        [`${PREFIX}audit-${task.key}`, taskId, task.userId, task.userId, task.date],
      )
    }
    await pgPool.query('COMMIT')
  } catch (error) {
    await pgPool.query('ROLLBACK')
    throw error
  }
}

async function generateAndVerify() {
  if (!pgPool) throw new Error('pg_required')
  const pending: any = await createPersonnelClaim({
    userId: users.nonGst,
    claim: {
      client_request_id: `${PREFIX}pending-claim`,
      service_date: '2010-03-04',
      claim_type: 'subsidy_amount',
      requested_amount_cents: 500,
      note: 'Synthetic pending claim used to verify the issue gate',
    },
  })
  assert.strictEqual(pending.status, 'draft')

  const first = await runPersonnelSettlementWeeklyJob({ triggerSource: 'manual', actorUserId: users.admin, weekStart: WEEK_START })
  assert.strictEqual(first.status, 'partial')
  assert.strictEqual(first.generated_count, 2)
  assert.strictEqual(first.issued_count, 1)
  assert.strictEqual(first.errors.length, 1)
  assert.strictEqual(first.errors[0].code, 'settlement_claims_pending')

  await pgPool.query('DELETE FROM audit_logs WHERE entity_id=$1', [`${PREFIX}pending-claim`])
  await pgPool.query('DELETE FROM personnel_workload_claims WHERE id=$1', [`${PREFIX}pending-claim`])
  const second = await runPersonnelSettlementWeeklyJob({ triggerSource: 'manual', actorUserId: users.admin, weekStart: WEEK_START })
  assert.strictEqual(second.status, 'succeeded')
  assert.strictEqual(second.generated_count, 0)
  assert.strictEqual(second.issued_count, 2)
  assert.strictEqual(second.errors.length, 0)

  const settlements = await pgPool.query(
    `SELECT id, user_id, status, subtotal_cents::int, gst_cents::int, total_cents::int
       FROM personnel_weekly_settlements
      WHERE batch_id IN (SELECT id FROM personnel_settlement_batches WHERE week_start=$1::date AND week_end=$2::date)
      ORDER BY user_id`,
    [WEEK_START, WEEK_END],
  )
  assert.strictEqual(settlements.rowCount, 2)
  const byUser = new Map((settlements.rows || []).map((row: any) => [String(row.user_id), row]))
  assert.deepStrictEqual(
    { status: byUser.get(users.gst)?.status, subtotal: byUser.get(users.gst)?.subtotal_cents, gst: byUser.get(users.gst)?.gst_cents, total: byUser.get(users.gst)?.total_cents },
    { status: 'awaiting_confirmation', subtotal: 10000, gst: 1000, total: 11000 },
  )
  assert.deepStrictEqual(
    { status: byUser.get(users.nonGst)?.status, subtotal: byUser.get(users.nonGst)?.subtotal_cents, gst: byUser.get(users.nonGst)?.gst_cents, total: byUser.get(users.nonGst)?.total_cents },
    { status: 'awaiting_confirmation', subtotal: 12000, gst: 0, total: 12000 },
  )

  const documents = await pgPool.query(
    `SELECT settlement.user_id, document.document_stage, document.document_kind, document.version
       FROM personnel_settlement_documents document
       JOIN personnel_weekly_settlements settlement ON settlement.id=document.settlement_id
      WHERE settlement.id=ANY($1::text[]) ORDER BY settlement.user_id`,
    [(settlements.rows || []).map((row: any) => String(row.id))],
  )
  assert.strictEqual(documents.rowCount, 2)
  for (const row of documents.rows || []) {
    assert.strictEqual(row.document_stage, 'awaiting_confirmation')
    assert.strictEqual(row.document_kind, 'settlement_draft')
    assert.strictEqual(Number(row.version), 1)
  }

  const notices = await pgPool.query(
    `SELECT notification.user_id, notification.event_id, COUNT(queue.id)::int AS queue_count
       FROM user_notifications notification
       LEFT JOIN event_queue queue ON queue.user_notification_id=notification.id
      WHERE notification.user_id LIKE $1
      GROUP BY notification.user_id, notification.event_id ORDER BY notification.user_id`,
    [`${PREFIX}%`],
  )
  assert.strictEqual(notices.rowCount, 2)
  assert.deepStrictEqual((notices.rows || []).map((row: any) => String(row.user_id)).sort(), [users.gst, users.nonGst].sort())
  for (const row of notices.rows || []) {
    assert.strictEqual(Number(row.queue_count), 1)
    assert.match(
      String(row.event_id),
      new RegExp(`^personnel-settlement-confirmation-requested:${byUser.get(String(row.user_id)).id}:\\d{17}$`),
    )
  }

  const lockClient = await pgPool.connect()
  try {
    await lockClient.query('BEGIN')
    const lock = await lockClient.query('SELECT pg_try_advisory_xact_lock($1) AS locked', [WEEKLY_JOB_LOCK_KEY])
    assert.strictEqual(lock.rows[0].locked, true)
    const skipped = await runPersonnelSettlementWeeklyJob({ triggerSource: 'manual', actorUserId: users.admin, weekStart: WEEK_START })
    assert.strictEqual(skipped.status, 'skipped')
    assert.strictEqual(skipped.errors[0].code, 'already_running')
  } finally {
    await lockClient.query('ROLLBACK').catch(() => undefined)
    lockClient.release()
  }
  return { settlements, byUser }
}

async function verifyWeb(runtimePassword: string) {
  const adminToken = await login(users.admin, runtimePassword)
  const browser = await getChromiumBrowser()
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } })
  await context.addCookies([{ name: 'auth', value: adminToken, url: WEB_BASE }])
  const page = await context.newPage()
  await page.addInitScript((token) => {
    window.localStorage.setItem('token', token)
    window.localStorage.setItem('role', 'admin')
  }, adminToken)
  const consoleErrors: string[] = []
  const badResponses: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('response', (response) => {
    if (response.status() >= 500 || (response.url().includes('/finance/settlements') && response.status() >= 400)) {
      badResponses.push(`${response.status()} ${new URL(response.url()).pathname}`)
    }
  })
  try {
    await page.goto(`${WEB_BASE}/finance/settlements`, { waitUntil: 'networkidle' })
    assert.ok(await page.getByText('费用结算', { exact: true }).first().isVisible())
    await page.getByRole('tab', { name: '周结算' }).click()
    const dateInput = page.locator('.ant-picker input:visible').first()
    await dateInput.waitFor({ state: 'visible' })
    assert.match(await dateInput.inputValue(), /^\d{4}-\d{2}-\d{2} 至 \d{4}-\d{2}-\d{2}$/)
    assert.ok(await page.getByRole('button', { name: '生成 / 重算所选周' }).isVisible())
    const bodyText = await page.locator('body').innerText()
    assert.ok(bodyText.includes('周任务运行记录'))
    assert.ok(!bodyText.includes('personnel_settlement_phase5_schema_not_ready'))
    await page.screenshot({ path: WEB_SCREENSHOT, fullPage: true })
    assert.deepStrictEqual(badResponses, [], `web settlement requests failed: ${badResponses.join(', ')}`)
    const blockingConsoleErrors = consoleErrors.filter((message) => !message.includes('[antd: Input] `addonAfter` is deprecated'))
    assert.deepStrictEqual(blockingConsoleErrors, [], `web console errors: ${blockingConsoleErrors.join(' | ')}`)
  } finally {
    await context.close()
  }
}

async function apiRequest(pathname: string, init: RequestInit = {}, token?: string) {
  const headers = new Headers(init.headers || {})
  if (token) headers.set('Authorization', `Bearer ${token}`)
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const response = await fetch(`${API_BASE}${pathname}`, { ...init, headers })
  const contentType = String(response.headers.get('content-type') || '')
  const body = contentType.includes('application/json')
    ? await response.json().catch(() => null)
    : Buffer.from(await response.arrayBuffer())
  return { response, body }
}

async function login(userId: string, runtimePassword: string) {
  const result = await apiRequest('/auth/login', {
    method: 'POST', body: JSON.stringify({ username: userId, password: runtimePassword }),
  })
  assert.strictEqual(result.response.status, 200, `login failed for ${userId}`)
  assert.ok(cleanText((result.body as any)?.token))
  return String((result.body as any).token)
}

async function verifyApiAndComplete(runtimePassword: string, generation: Awaited<ReturnType<typeof generateAndVerify>>) {
  if (!pgPool) throw new Error('pg_required')
  const { settlements, byUser } = generation
  const [adminToken, gstToken, nonGstToken] = await Promise.all([
    login(users.admin, runtimePassword), login(users.gst, runtimePassword), login(users.nonGst, runtimePassword),
  ])
  for (const [userId, token] of [[users.gst, gstToken], [users.nonGst, nonGstToken]] as const) {
    const settlement = byUser.get(userId)
    assert.ok(settlement)
    const list = await apiRequest(`/finance/settlements/my-settlements?week_start=${WEEK_START}`, {}, token)
    assert.strictEqual(list.response.status, 200)
    assert.strictEqual((list.body as any[]).length, 1)
    assert.strictEqual((list.body as any[])[0].user_id, userId)
    const detail = await apiRequest(`/finance/settlements/my-settlements/${settlement.id}`, {}, token)
    assert.strictEqual(detail.response.status, 200)
    assert.strictEqual((detail.body as any).documents.length, 1)
    assert.strictEqual((detail.body as any).documents[0].storage_key, undefined)
    const draftDocument = (detail.body as any).documents[0]
    const ownPdf = await apiRequest(`/finance/settlements/my-settlements/${settlement.id}/documents/${draftDocument.id}`, {}, token)
    assert.strictEqual(ownPdf.response.status, 200)
    assert.match(String(ownPdf.response.headers.get('content-type')), /application\/pdf/)
    assert.ok(Buffer.isBuffer(ownPdf.body) && (ownPdf.body as Buffer).subarray(0, 4).toString() === '%PDF')
    const otherToken = userId === users.gst ? nonGstToken : gstToken
    const denied = await apiRequest(`/finance/settlements/my-settlements/${settlement.id}/documents/${draftDocument.id}`, {}, otherToken)
    assert.strictEqual(denied.response.status, 404)
    if (userId === users.gst) {
      const disputed = await apiRequest(
        `/finance/settlements/my-settlements/${settlement.id}/dispute`,
        { method: 'POST', body: JSON.stringify({ reason: 'Synthetic amount dispute' }) }, token,
      )
      assert.strictEqual(disputed.response.status, 200)
      assert.strictEqual((disputed.body as any).status, 'disputed')
      const resolved = await apiRequest(
        `/finance/settlements/weekly/${settlement.id}/resolve-dispute`,
        { method: 'POST', body: JSON.stringify({ decision: 'edit_amount', final_total_cents: 11500 }) }, adminToken,
      )
      assert.strictEqual(resolved.response.status, 200)
      assert.strictEqual((resolved.body as any).status, 'awaiting_confirmation')
      assert.strictEqual((resolved.body as any).total_cents, 11500)
      assert.deepStrictEqual((resolved.body as any).dispute_resolution.decision, 'edit_amount')
      assert.strictEqual((resolved.body as any).dispute_resolution.previous_total_cents, 11000)
      assert.strictEqual((resolved.body as any).dispute_resolution.final_total_cents, 11500)
      const retry = await apiRequest(
        `/finance/settlements/weekly/${settlement.id}/resolve-dispute`,
        { method: 'POST', body: JSON.stringify({ decision: 'edit_amount', final_total_cents: 11500 }) }, adminToken,
      )
      assert.strictEqual(retry.response.status, 200)
      assert.strictEqual((retry.body as any).total_cents, 11500)
      const reissuedDetail = await apiRequest(`/finance/settlements/my-settlements/${settlement.id}`, {}, token)
      assert.strictEqual(reissuedDetail.response.status, 200)
      assert.deepStrictEqual((reissuedDetail.body as any).documents.map((row: any) => Number(row.version)), [2])
      settlement.total_cents = 11500
    }
    const confirmed = await apiRequest(
      `/finance/settlements/my-settlements/${settlement.id}/confirm`,
      { method: 'POST', body: JSON.stringify({ note: '工作量及金额正确' }) }, token,
    )
    assert.strictEqual(confirmed.response.status, 200)
    assert.strictEqual((confirmed.body as any).status, 'confirmed')
  }

  const reissueNotices = await pgPool.query(
    `SELECT notification.user_id, notification.event_id, COUNT(queue.id)::int AS queue_count
       FROM user_notifications notification
       LEFT JOIN event_queue queue ON queue.user_notification_id=notification.id
      WHERE notification.user_id LIKE $1
      GROUP BY notification.user_id, notification.event_id
      ORDER BY notification.user_id, notification.event_id`,
    [`${PREFIX}%`],
  )
  assert.strictEqual(reissueNotices.rowCount, 3)
  assert.strictEqual((reissueNotices.rows || []).filter((row: any) => row.user_id === users.gst).length, 2)
  assert.strictEqual((reissueNotices.rows || []).filter((row: any) => row.user_id === users.nonGst).length, 1)
  assert.ok((reissueNotices.rows || []).every((row: any) => Number(row.queue_count) === 1))

  const gstSettlement = byUser.get(users.gst)
  const nonGstSettlement = byUser.get(users.nonGst)
  const noAuth = await apiRequest(`/finance/settlements/my-settlements/${gstSettlement.id}/documents/missing-document`)
  assert.strictEqual(noAuth.response.status, 401)
  const runs = await apiRequest('/finance/settlements/weekly-runs?limit=10', {}, adminToken)
  assert.strictEqual(runs.response.status, 200)
  assert.ok((runs.body as any[]).some((run: any) => run.week_start === WEEK_START && run.status === 'skipped'))

  for (const [userId, token, settlement] of [
    [users.gst, gstToken, gstSettlement],
    [users.nonGst, nonGstToken, nonGstSettlement],
  ] as const) {
    const adminBeforePayment = await apiRequest(`/finance/settlements/weekly/${settlement.id}`, {}, adminToken)
    assert.strictEqual(adminBeforePayment.response.status, 200)
    assert.ok(cleanText((adminBeforePayment.body as any).payment_destination_preview.bank_account_name))
    assert.ok(cleanText((adminBeforePayment.body as any).payment_destination_preview.bank_bsb))
    assert.ok(cleanText((adminBeforePayment.body as any).payment_destination_preview.bank_account_number))
    const approved = await apiRequest(
      `/finance/settlements/weekly/${settlement.id}/approve`,
      { method: 'POST', body: JSON.stringify({}) },
      adminToken,
    )
    assert.strictEqual(approved.response.status, 200)
    assert.strictEqual((approved.body as any).status, 'finance_approved')
    assert.ok(cleanText((approved.body as any).finance_reviewed_at))
    const paid = await apiRequest(
      `/finance/settlements/weekly/${settlement.id}/confirm-paid`,
      {
        method: 'POST',
        body: JSON.stringify({
          payment_date: PAYMENT_DATE,
        }),
      },
      adminToken,
    )
    assert.strictEqual(paid.response.status, 200)
    assert.strictEqual((paid.body as any).status, 'paid')
    assert.strictEqual((paid.body as any).payment_destination_snapshot.bank_account_number, undefined)
    assert.ok(cleanText((paid.body as any).payment_destination_snapshot.bank_account_masked))
    const ownerAfterPayment = await apiRequest(`/finance/settlements/my-settlements/${settlement.id}`, {}, token)
    assert.strictEqual(ownerAfterPayment.response.status, 200)
    assert.strictEqual((ownerAfterPayment.body as any).payment_destination_snapshot.bank_account_number, undefined)
    assert.ok(cleanText((ownerAfterPayment.body as any).payment_destination_snapshot.bank_account_masked))
  }

  const settlementIds = (settlements.rows || []).map((row: any) => String(row.id))
  const expenseCount = await pgPool.query(
    `SELECT COUNT(*)::int AS count FROM company_expenses
      WHERE ref_type='personnel_weekly_settlement' AND ref_id=ANY($1::text[])
        AND category='cleaning_expense' AND status='paid'`,
    [settlementIds],
  )
  assert.strictEqual(Number(expenseCount.rows[0].count), 2)
  const storedPaymentReferences = await pgPool.query(
    'SELECT payment_reference FROM personnel_weekly_settlements WHERE id=ANY($1::text[])',
    [settlementIds],
  )
  assert.ok(storedPaymentReferences.rows.every((row: any) => row.payment_reference == null), 'new payment confirmations must not store transfer references')
  const documents = await pgPool.query(
    `SELECT document.*, settlement.user_id
       FROM personnel_settlement_documents document
       JOIN personnel_weekly_settlements settlement ON settlement.id=document.settlement_id
      WHERE settlement.id=ANY($1::text[])
      ORDER BY settlement.user_id, document.document_stage`,
    [settlementIds],
  )
  assert.strictEqual(documents.rowCount, 7)
  for (const userId of [users.gst, users.nonGst]) {
    const rows = (documents.rows || []).filter((row: any) => String(row.user_id) === userId)
    const expectedStages = userId === users.gst
      ? ['awaiting_confirmation', 'awaiting_confirmation', 'confirmed', 'paid']
      : ['awaiting_confirmation', 'confirmed', 'paid']
    assert.deepStrictEqual(rows.map((row: any) => String(row.document_stage)).sort(), expectedStages.sort())
    assert.deepStrictEqual(
      rows.filter((row: any) => row.document_stage === 'awaiting_confirmation').map((row: any) => Number(row.version)).sort(),
      userId === users.gst ? [1, 2] : [1],
    )
    const finalRows = rows.filter((row: any) => row.document_stage !== 'awaiting_confirmation')
    assert.ok(finalRows.every((row: any) => row.document_kind === (userId === users.gst ? 'tax_invoice' : 'invoice')))
    assert.ok(finalRows.every((row: any) => Number(row.totals_snapshot?.gst_cents || 0) === (userId === users.gst ? 1000 : 0)))
    assert.ok(rows.every((row: any) => row.buyer_snapshot?.legal_name === 'Homixa Phase 5 Preview Pty Ltd'))
  }
  const gstPaid = (documents.rows || []).find((row: any) => row.user_id === users.gst && row.document_stage === 'paid')
  const adminPdf = await apiRequest(`/finance/settlements/weekly/${gstSettlement.id}/documents/${gstPaid.id}`, {}, adminToken)
  assert.strictEqual(adminPdf.response.status, 200)
  assert.ok(Buffer.isBuffer(adminPdf.body) && (adminPdf.body as Buffer).subarray(0, 4).toString() === '%PDF')
  await fs.promises.writeFile(PREVIEW_PDF, adminPdf.body as Buffer)
  return { documents: documents.rowCount, paidExpenses: Number(expenseCount.rows[0].count) }
}

async function main() {
  requirePreviewWriteGuard()
  assert.ok(hasPg && pgPool, 'development PostgreSQL is required')
  const runtimePassword = randomBytes(32).toString('base64url')
  await warmupPersonnelSettlementSchema()
  await verifySchema()
  await cleanup()
  await assertCleanup()
  try {
    await seed(runtimePassword)
    const generation = await generateAndVerify()
    await verifyWeb(runtimePassword)
    const completed = await verifyApiAndComplete(runtimePassword, generation)
    console.log(JSON.stringify({
      ok: true,
      week_start: WEEK_START,
      settlements: generation.settlements.rowCount,
      documents: completed.documents,
      notifications: 3,
      paid_expenses: completed.paidExpenses,
      web_screenshot: WEB_SCREENSHOT,
      preview_pdf: PREVIEW_PDF,
    }))
  } finally {
    await cleanup()
    await assertCleanup()
    await resetChromiumBrowser()
  }
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    if (pgPool) await pgPool.end().catch(() => undefined)
  })
