import assert from 'assert'
import express from 'express'
import path from 'path'
import dotenv from 'dotenv'

dotenv.config({ path: path.resolve(__dirname, '../../.env.local'), override: true })
process.env.PG_CONN_TIMEOUT_MS = process.env.PG_CONN_TIMEOUT_MS || '8000'
process.env.PG_QUERY_TIMEOUT_MS = process.env.PG_QUERY_TIMEOUT_MS || '20000'
process.env.PG_STATEMENT_TIMEOUT_MS = process.env.PG_STATEMENT_TIMEOUT_MS || '20000'

type UserKey = 'admin' | 'cleaner' | 'inspector' | 'outsider_inspector' | 'mixed' | 'offline_manager' | 'customer_service'

const TEST_DATE = '2026-07-05'
const PROPERTY_IDS = {
  cleaning: 'phase5-e2e-property-cleaning',
  inspection: 'phase5-e2e-property-inspection',
  password: 'phase5-e2e-property-password',
  merged: 'phase5-e2e-property-merged',
}
const CLEANING_TASK_ID = 'phase5-e2e-checkout-cleaning'
const INSPECTION_TASK_ID = 'phase5-e2e-pure-checkin-inspection'
const PASSWORD_TASK_ID = 'phase5-e2e-password-only'
const MERGED_CLEANING_TASK_ID = 'phase5-e2e-merged-cleaning'
const MERGED_INSPECTION_TASK_ID = 'phase5-e2e-merged-inspection'
const TASK_IDS = [CLEANING_TASK_ID, INSPECTION_TASK_ID, PASSWORD_TASK_ID, MERGED_CLEANING_TASK_ID, MERGED_INSPECTION_TASK_ID]
const FLOW_TASK_IDS = [CLEANING_TASK_ID, INSPECTION_TASK_ID, PASSWORD_TASK_ID]
const RUN_ID = `phase5-${Date.now()}`
const REQUIRED_CONSUMABLE_ITEMS = [
  'toilet_paper',
  'facial_tissue',
  'shampoo',
  'conditioner',
  'body_wash',
  'hand_soap',
  'dish_sponge',
  'dish_soap',
  'tea_bags',
  'coffee',
  'sugar_sticks',
  'bin_bags_large',
  'bin_bags_small',
  'dish_detergent',
  'laundry_powder',
  'cooking_oil',
  'salt_sugar',
  'pepper',
  'toilet_cleaner',
  'bleach',
  'spare_pillowcase',
  'other',
]

const USERS: Record<UserKey, any> = {
  admin: { sub: 'phase5-admin', username: 'phase5-admin', role: 'admin', roles: ['admin'] },
  cleaner: { sub: 'phase5-cleaner', username: 'phase5-cleaner', role: 'cleaner', roles: ['cleaner'] },
  inspector: { sub: 'phase5-inspector', username: 'phase5-inspector', role: 'cleaning_inspector', roles: ['cleaning_inspector'] },
  outsider_inspector: { sub: 'phase5-outsider-inspector', username: 'phase5-outsider-inspector', role: 'cleaning_inspector', roles: ['cleaning_inspector'] },
  mixed: { sub: 'phase5-mixed', username: 'phase5-mixed', role: 'cleaner_inspector', roles: ['cleaner_inspector'] },
  offline_manager: { sub: 'phase5-offline-manager', username: 'phase5-offline-manager', role: 'offline_manager', roles: ['offline_manager'] },
  customer_service: { sub: 'phase5-customer-service', username: 'phase5-customer-service', role: 'customer_service', roles: ['customer_service'] },
}

function urlFor(name: string) {
  return `https://example.test/phase5/${name}`
}

async function maybeDelete(pgPool: any, table: string, sql: string, params: any[]) {
  const exists = await pgPool.query(`SELECT to_regclass($1) AS name`, [`public.${table}`])
  if (!exists?.rows?.[0]?.name) return
  await pgPool.query(sql, params)
}

async function cleanup(pgPool: any) {
  await maybeDelete(pgPool, 'event_queue', `DELETE FROM event_queue WHERE event_id LIKE 'phase5-e2e%' OR user_notification_id IN (
    SELECT id FROM user_notifications WHERE entity_id = ANY($1::text[])
  )`, [TASK_IDS])
  await maybeDelete(pgPool, 'user_notifications', `DELETE FROM user_notifications WHERE entity_id = ANY($1::text[]) OR event_id LIKE 'phase5-e2e%'`, [TASK_IDS])
  await maybeDelete(pgPool, 'work_task_events', `DELETE FROM work_task_events WHERE source_type='cleaning_tasks' AND source_ref_ids && $1::text[]`, [TASK_IDS])
  await maybeDelete(pgPool, 'work_task_action_audits', `DELETE FROM work_task_action_audits WHERE source_type='cleaning_tasks' AND source_id = ANY($1::text[])`, [TASK_IDS])
  await maybeDelete(pgPool, 'idempotent_step_receipts', `DELETE FROM idempotent_step_receipts WHERE scope_id = ANY($1::text[])`, [TASK_IDS])
  await maybeDelete(pgPool, 'cleaning_consumable_usages', `DELETE FROM cleaning_consumable_usages WHERE task_id = ANY($1::text[])`, [TASK_IDS])
  await maybeDelete(pgPool, 'cleaning_task_media', `DELETE FROM cleaning_task_media WHERE task_id = ANY($1::text[])`, [TASK_IDS])
  await maybeDelete(pgPool, 'work_task_participants', `DELETE FROM work_task_participants WHERE source_type='cleaning_tasks' AND source_id = ANY($1::text[])`, [TASK_IDS])
  await pgPool.query(`DELETE FROM cleaning_tasks WHERE id = ANY($1::text[])`, [TASK_IDS])
  await pgPool.query(`DELETE FROM properties WHERE id = ANY($1::text[])`, [Object.values(PROPERTY_IDS)])
}

async function seed(pgPool: any) {
  await pgPool.query(
    `INSERT INTO properties(id, code, address, region)
     VALUES
       ($1,'PHASE5-CLEAN','Phase 5 E2E cleaning property','phase5'),
       ($2,'PHASE5-INSP','Phase 5 E2E inspection property','phase5'),
       ($3,'PHASE5-PASS','Phase 5 E2E password property','phase5'),
       ($4,'PHASE5-MERGED','Phase 5 E2E merged property','phase5')
     ON CONFLICT (id) DO UPDATE SET code=EXCLUDED.code, address=EXCLUDED.address, region=EXCLUDED.region`,
    [PROPERTY_IDS.cleaning, PROPERTY_IDS.inspection, PROPERTY_IDS.password, PROPERTY_IDS.merged],
  )
  await pgPool.query(
    `INSERT INTO cleaning_tasks(
       id, property_id, task_type, type, task_date, date, status, assignee_id, cleaner_id, inspector_id,
       inspection_mode, inspection_scope, source, execution_state, checkout_time, checkin_time, keys_required,
       old_code, new_code, guest_special_request, auto_sync_enabled
     )
     VALUES
       ($1,$6,'checkout_clean','checkout_clean',$11::date,$11::date,'assigned',$9,$9,$10,'same_day','inspect_and_hang','manual','active','10am','3pm',1,'OLD1','NEW1','Phase 5 normal checkout cleaning',true),
       ($2,$7,'checkin_clean','checkin_clean',$11::date,$11::date,'assigned',$9,NULL,NULL,'same_day','inspect_and_hang','manual','active',NULL,'3pm',1,'OLD2','NEW2','Phase 5 pure checkin site execution',true),
       ($3,$8,'checkin_clean','checkin_clean',$11::date,$11::date,'assigned',$9,NULL,NULL,'same_day','password_only','manual','active',NULL,'3pm',1,'OLD3','NEW3','Phase 5 password-only execution',true),
       ($4,$12,'checkout_clean','checkout_clean',$11::date,$11::date,'assigned',$9,$9,$10,'same_day','inspect_and_hang','manual','active','10am','3pm',1,'OLD4','NEW4','Phase 5 merged checkout cleaning',true),
       ($5,$12,'checkin_clean','checkin_clean',$11::date,$11::date,'assigned',$9,NULL,NULL,'same_day','inspect_and_hang','manual','active',NULL,'3pm',1,'OLD5','NEW5','Phase 5 merged checkin execution',true)`,
    [
      CLEANING_TASK_ID,
      INSPECTION_TASK_ID,
      PASSWORD_TASK_ID,
      MERGED_CLEANING_TASK_ID,
      MERGED_INSPECTION_TASK_ID,
      PROPERTY_IDS.cleaning,
      PROPERTY_IDS.inspection,
      PROPERTY_IDS.password,
      USERS.cleaner.sub,
      USERS.inspector.sub,
      TEST_DATE,
      PROPERTY_IDS.merged,
    ],
  )
}

async function withServer<T>(run: (baseUrl: string) => Promise<T>) {
  const { router: cleaningRouter } = await import('../../src/modules/cleaning')
  const { router: cleaningAppRouter } = await import('../../src/modules/cleaning_app')
  const { router: mzappRouter } = await import('../../src/modules/mzapp')
  const app = express()
  app.use(express.json({ limit: '5mb' }))
  app.use((req: any, _res, next) => {
    const key = String(req.headers['x-phase5-user'] || 'admin') as UserKey
    req.user = USERS[key] || USERS.admin
    next()
  })
  app.use('/cleaning', cleaningRouter)
  app.use('/cleaning-app', cleaningAppRouter)
  app.use('/mzapp', mzappRouter)
  const server = await new Promise<any>((resolve) => {
    const listener = app.listen(0, () => resolve(listener))
  })
  try {
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    return await run(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

async function requestJson(baseUrl: string, user: UserKey, method: string, requestPath: string, body?: any, expected = 200) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 60000)
  try {
    const response = await fetch(`${baseUrl}${requestPath}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-phase5-user': user,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await response.text()
    const data = text ? JSON.parse(text) : null
    assert.equal(response.status, expected, `${user} ${method} ${requestPath} expected ${expected}, got ${response.status}: ${text}`)
    return data
  } finally {
    clearTimeout(timeout)
  }
}

function findSource(items: any[], sourceId: string) {
  return items.find((item) => {
    if (String(item?.source_id || '') === sourceId) return true
    if (Array.isArray(item?.source_ids) && item.source_ids.map(String).includes(sourceId)) return true
    if (String(item?.entity_id || '') === sourceId) return true
    if (Array.isArray(item?.entity_ids) && item.entity_ids.map(String).includes(sourceId)) return true
    return false
  })
}

function action(item: any, id: string) {
  return (Array.isArray(item?.available_actions) ? item.available_actions : []).find((entry: any) => String(entry?.id || '') === id)
}

async function main() {
  process.stdout.write('phase5_e2e_acceptance: loading db and modules\n')
  const { pgPool } = await import('../../src/dbAdapter')
  if (!pgPool) {
    process.stdout.write('phase5_e2e_acceptance: skipped (pg not configured)\n')
    return
  }
  const { ensureCleaningSchemaV2 } = await import('../../src/services/cleaningSync')
  const { ensureWorkTaskActionAuditsTable } = await import('../../src/lib/workTaskActionAudit')
  await ensureCleaningSchemaV2()
  await ensureWorkTaskActionAuditsTable(pgPool)
  await cleanup(pgPool)
  await seed(pgPool)

  const summary: string[] = []
  try {
    await withServer(async (baseUrl) => {
      process.stdout.write('phase5_e2e_acceptance: granting admin inspection participant\n')
      await requestJson(baseUrl, 'admin', 'POST', '/mzapp/work-task-participants/set', {
        source_type: 'cleaning_tasks',
        source_ids: [INSPECTION_TASK_ID],
        grants: [{ user_id: USERS.admin.sub, participant_role: 'collaborator', action_ids: ['submit_inspection'] }],
      })
      await requestJson(baseUrl, 'admin', 'POST', '/mzapp/work-task-participants/set', {
        source_type: 'cleaning_tasks',
        source_ids: [MERGED_CLEANING_TASK_ID],
        grants: [{ user_id: USERS.admin.sub, participant_role: 'collaborator', action_ids: ['upload_key_photo'] }],
      })
      await requestJson(baseUrl, 'admin', 'POST', '/mzapp/work-task-participants/set', {
        source_type: 'cleaning_tasks',
        source_ids: [MERGED_INSPECTION_TASK_ID],
        grants: [{ user_id: USERS.admin.sub, participant_role: 'collaborator', action_ids: ['submit_inspection'] }],
      })

      process.stdout.write('phase5_e2e_acceptance: validating web cleaning semantics\n')
      const calendarPath = `/cleaning/calendar-range?from=${TEST_DATE}&to=${TEST_DATE}&include_deferred_inspection=1`
      const webAdmin = await requestJson(baseUrl, 'admin', 'GET', calendarPath)
      const webCleaner = findSource(webAdmin, CLEANING_TASK_ID)
      const webInspection = findSource(webAdmin, INSPECTION_TASK_ID)
      const webPassword = findSource(webAdmin, PASSWORD_TASK_ID)
      assert.ok(webCleaner, 'web admin should see normal checkout cleaning')
      assert.ok(webInspection, 'web admin should see pure checkin inspection')
      assert.ok(webPassword, 'web admin should see password-only execution')
      assert.equal(webPassword.display_scope?.label, '仅改密码/挂钥匙')
      assert.equal(webPassword.execution_semantics, 'key_or_password_action')
      assert.equal(webPassword.participant_summary?.primary_role, 'executor')
      assert.equal(webPassword.editable_fields?.assignee_id?.enabled, true)
      assert.equal(webPassword.editable_fields?.inspector_id?.enabled, false)
      assert.equal(webInspection.display_scope?.label, '入住现场执行')
      assert.equal(webInspection.participant_summary?.primary_role, 'executor')
      assert.equal(webInspection.editable_fields?.assignee_id?.enabled, true)
      assert.equal(webInspection.editable_fields?.inspector_id?.enabled, false)

      for (const manager of ['admin', 'customer_service', 'offline_manager'] as UserKey[]) {
        const webRows = await requestJson(baseUrl, manager, 'GET', calendarPath)
        assert.ok(findSource(webRows, CLEANING_TASK_ID), `${manager} should see cleaning task on web`)
        assert.ok(findSource(webRows, INSPECTION_TASK_ID), `${manager} should see inspection task on web`)
        assert.ok(findSource(webRows, PASSWORD_TASK_ID), `${manager} should see password-only task on web`)
      }
      summary.push('web:/cleaning admin/customer_service/offline_manager visibility and labels ok')

      process.stdout.write('phase5_e2e_acceptance: validating mobile list/actions\n')
      const mobilePath = `/mzapp/work-tasks?date_from=${TEST_DATE}&date_to=${TEST_DATE}`
      const mobileAllPath = `${mobilePath}&view=all`
      const cleanerRows = await requestJson(baseUrl, 'cleaner', 'GET', mobilePath)
      const cleanerCleaning = findSource(cleanerRows, CLEANING_TASK_ID)
      const cleanerPassword = findSource(cleanerRows, PASSWORD_TASK_ID)
      assert.ok(cleanerCleaning, 'cleaner should see assigned cleaning task')
      assert.ok(cleanerPassword, 'cleaner should see assigned password-only execution task')
      const cleanerInspection = findSource(cleanerRows, INSPECTION_TASK_ID)
      assert.ok(cleanerInspection, 'cleaner should see assigned pure checkin site execution task')
      assert.equal(action(cleanerCleaning, 'upload_key_photo')?.enabled, true)
      assert.equal(action(cleanerCleaning, 'fill_supplies')?.enabled, true)
      assert.equal(action(cleanerInspection, 'submit_inspection')?.enabled, true)
      assert.equal(action(cleanerInspection, 'submit_inspection')?.source_id, INSPECTION_TASK_ID)
      assert.equal(action(cleanerInspection, 'upload_access_video')?.enabled, true)
      assert.equal(action(cleanerInspection, 'upload_access_video')?.source_id, INSPECTION_TASK_ID)
      assert.equal(cleanerPassword.execution_semantics, 'key_or_password_action')
      assert.equal(action(cleanerPassword, 'upload_access_video')?.enabled, true)
      assert.equal(action(cleanerPassword, 'upload_access_video')?.source_id, PASSWORD_TASK_ID)

      const inspectorRows = await requestJson(baseUrl, 'inspector', 'GET', mobilePath)
      assert.ok(!findSource(inspectorRows, INSPECTION_TASK_ID), 'unassigned inspector should not see pure checkin site execution task')

      const outsiderRows = await requestJson(baseUrl, 'outsider_inspector', 'GET', mobilePath)
      assert.ok(!findSource(outsiderRows, INSPECTION_TASK_ID), 'unassigned inspector should not see pure inspection task')

      const adminRows = await requestJson(baseUrl, 'admin', 'GET', mobileAllPath)
      const adminInspection = findSource(adminRows, INSPECTION_TASK_ID)
      assert.ok(adminInspection, 'admin view=all should see pure inspection task')
      assert.equal(action(adminInspection, 'submit_inspection')?.enabled, true)
      assert.equal(action(adminInspection, 'upload_access_video')?.enabled, false)
      const adminMerged = findSource(adminRows, MERGED_INSPECTION_TASK_ID)
      assert.ok(adminMerged, 'admin view=all should see merged same-property tasks')
      assert.equal(action(adminMerged, 'upload_key_photo')?.enabled, true)
      assert.equal(action(adminMerged, 'submit_inspection')?.enabled, true)
      assert.equal(action(adminMerged, 'submit_inspection')?.source_id, MERGED_INSPECTION_TASK_ID)

      for (const manager of ['admin', 'customer_service', 'offline_manager'] as UserKey[]) {
        const rows = await requestJson(baseUrl, manager, 'GET', mobileAllPath)
        assert.ok(findSource(rows, CLEANING_TASK_ID), `${manager} view=all should see cleaning task`)
        assert.ok(findSource(rows, INSPECTION_TASK_ID), `${manager} view=all should see inspection task`)
        assert.ok(findSource(rows, PASSWORD_TASK_ID), `${manager} view=all should see password-only task`)
      }
      summary.push('mobile:list/detail available_actions visibility ok')

      process.stdout.write('phase5_e2e_acceptance: executing submit flows\n')
      await requestJson(baseUrl, 'cleaner', 'POST', `/cleaning-app/tasks/${CLEANING_TASK_ID}/start`, {
        media_url: urlFor('key.jpg'),
        captured_at: `${TEST_DATE}T00:00:00.000Z`,
      })
      await requestJson(baseUrl, 'cleaner', 'POST', `/cleaning-app/tasks/${CLEANING_TASK_ID}/consumables`, {
        living_room_photo_url: urlFor('living.jpg'),
        items: REQUIRED_CONSUMABLE_ITEMS.map((item_id) => ({ item_id, status: 'ok', qty: 1 })),
      })
      const cleaningStatus = await pgPool.query(`SELECT status FROM cleaning_tasks WHERE id=$1`, [CLEANING_TASK_ID])
      assert.equal(String(cleaningStatus?.rows?.[0]?.status || ''), 'cleaned')

      await requestJson(baseUrl, 'cleaner', 'POST', `/cleaning-app/tasks/${INSPECTION_TASK_ID}/inspection-photos`, {
        submit_id: `${RUN_ID}-cleaner-inspection`,
        step_key: 'inspection-photos',
        items: [
          { area: 'toilet', url: urlFor('inspection-toilet.jpg') },
          { area: 'living', url: urlFor('inspection-living.jpg') },
        ],
      }, 201)
      const inspectionStatus = await pgPool.query(`SELECT status FROM cleaning_tasks WHERE id=$1`, [INSPECTION_TASK_ID])
      assert.equal(String(inspectionStatus?.rows?.[0]?.status || ''), 'inspected')

      await requestJson(baseUrl, 'cleaner', 'POST', `/cleaning-app/tasks/${INSPECTION_TASK_ID}/lockbox-video`, {
        media_url: urlFor('inspection-lockbox.mp4'),
        captured_at: `${TEST_DATE}T00:30:00.000Z`,
      }, 201)
      const inspectionLockboxStatus = await pgPool.query(`SELECT status, lockbox_video_uploaded_at FROM cleaning_tasks WHERE id=$1`, [INSPECTION_TASK_ID])
      assert.equal(String(inspectionLockboxStatus?.rows?.[0]?.status || ''), 'keys_hung')
      assert.ok(inspectionLockboxStatus?.rows?.[0]?.lockbox_video_uploaded_at, 'pure checkin site execution should record lockbox video timestamp')

      await requestJson(baseUrl, 'cleaner', 'POST', `/cleaning-app/tasks/${PASSWORD_TASK_ID}/lockbox-video`, {
        media_url: urlFor('password-video.mp4'),
        captured_at: `${TEST_DATE}T01:00:00.000Z`,
      }, 201)
      const passwordStatus = await pgPool.query(`SELECT status, lockbox_video_uploaded_at FROM cleaning_tasks WHERE id=$1`, [PASSWORD_TASK_ID])
      assert.equal(String(passwordStatus?.rows?.[0]?.status || ''), 'keys_hung')
      assert.ok(passwordStatus?.rows?.[0]?.lockbox_video_uploaded_at, 'password-only task should record lockbox video timestamp')

      await requestJson(baseUrl, 'outsider_inspector', 'POST', `/cleaning-app/tasks/${PASSWORD_TASK_ID}/lockbox-video`, {
        media_url: urlFor('outsider-video.mp4'),
      }, 403)
      summary.push('submit flows cleaning/inspection/password-only ok')

      process.stdout.write('phase5_e2e_acceptance: validating refresh events\n')
      const eventCounts = await pgPool.query(
        `SELECT source_ref_ids[1] AS task_id, count(*)::int AS count
         FROM work_task_events
         WHERE source_type='cleaning_tasks'
           AND source_ref_ids && $1::text[]
         GROUP BY source_ref_ids[1]`,
        [FLOW_TASK_IDS],
      )
      const countByTask = new Map((eventCounts?.rows || []).map((row: any) => [String(row.task_id || ''), Number(row.count || 0)]))
      for (const taskId of FLOW_TASK_IDS) assert.ok((countByTask.get(taskId) || 0) > 0, `missing refresh event for ${taskId}`)
      const notificationCounts = await pgPool.query(
        `SELECT count(*)::int AS count
         FROM user_notifications
         WHERE entity='cleaning_task'
           AND entity_id = ANY($1::text[])`,
        [TASK_IDS],
      ).catch(() => ({ rows: [{ count: 0 }] }))
      summary.push(`work_task_events ok; user_notifications rows=${Number(notificationCounts?.rows?.[0]?.count || 0)}`)
    })

    process.stdout.write(`phase5_e2e_acceptance: passed\n${summary.map((line) => `- ${line}`).join('\n')}\n`)
  } finally {
    if (process.env.PHASE5_KEEP_E2E_DATA === '1') {
      process.stdout.write('phase5_e2e_acceptance: kept sample data because PHASE5_KEEP_E2E_DATA=1\n')
    } else {
      await cleanup(pgPool)
      process.stdout.write('phase5_e2e_acceptance: cleaned sample data\n')
    }
    await pgPool.end().catch(() => {})
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
