import dotenv from 'dotenv'
import path from 'path'
dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), override: true })
dotenv.config({ path: path.resolve(__dirname, '../.env.local'), override: true })
dotenv.config()
import express from 'express'
import cors from 'cors'
import morgan from 'morgan'
import bcrypt from 'bcryptjs'
import { v4 as uuid } from 'uuid'
import { router as landlordsRouter } from './modules/landlords'
import { router as propertiesRouter } from './modules/properties'
import { router as keysRouter } from './modules/keys'
import { router as ordersRouter } from './modules/orders'
import { router as inventoryRouter } from './modules/inventory'
import { router as financeRouter } from './modules/finance'
import { router as cleaningRouter } from './modules/cleaning'
import { router as configRouter } from './modules/config'
import cleaningAppRouter from './modules/cleaning_app'
import { router as authRouter } from './modules/auth'
import { router as auditsRouter } from './modules/audits'
import { router as rbacRouter } from './modules/rbac'
import { router as usersRouter } from './modules/users'
import { router as versionRouter } from './modules/version'
import { router as statsRouter } from './modules/stats'
import { router as eventsRouter } from './modules/events'
import notificationsRouter from './modules/notifications'
import maintenanceRouter from './modules/maintenance'
import deepCleaningRouter from './modules/deep_cleaning'
import { router as workTasksRouter } from './modules/work_tasks'
import { router as taskCenterRouter } from './modules/task_center'
import { router as mzappRouter } from './modules/mzapp'
import { router as propertyOnboardingRouter } from './modules/propertyOnboarding'
import { router as propertyGuidesRouter } from './modules/property_guides'
import { router as propertyGuideLinkSyncRouter } from './modules/property_guide_link_sync'
import { router as jobsRouter, runEmailSyncJob } from './modules/jobs'
import cron from 'node-cron'
import crudRouter from './modules/crud'
import recurringRouter from './modules/recurring'
import { router as invoicesRouter } from './modules/invoices'
import { router as cmsCompanyRouter } from './modules/cms_company'
import { router as cmsCompanySecretsRouter } from './modules/cms_company_secrets'
import { runKeyUploadReminder } from './lib/keyUploadReminderJob'
import { auth } from './auth'
import publicRouter from './modules/public'
import publicAdminRouter from './modules/public_admin'
import { r2Status } from './r2'
import { getPlaywrightDiagnostics } from './lib/playwright'
 
 
// 环境保险锁（Render 上用 RENDER_ENV=dev/prod 显式区分，避免误判）
let appEnv = process.env.APP_ENV
let dbRole = process.env.DATABASE_ROLE
const renderEnv = String(process.env.RENDER_ENV || '').trim().toLowerCase()
if (!appEnv) {
  appEnv = renderEnv === 'dev' || renderEnv === 'prod' ? renderEnv : (process.env.NODE_ENV === 'production' ? 'prod' : 'dev')
  process.env.APP_ENV = appEnv
}
if (!dbRole) {
  if (renderEnv === 'dev' || renderEnv === 'prod') {
    dbRole = renderEnv
  } else {
    const url = process.env.DATABASE_URL || ''
    dbRole = url ? (/localhost/i.test(url) ? 'dev' : 'prod') : 'none'
  }
  process.env.DATABASE_ROLE = dbRole
}
if (dbRole !== 'none') {
  if (appEnv === 'dev' && dbRole === 'prod') {
    throw new Error('❌ DEV backend cannot connect to PROD database')
  }
  if (appEnv === 'prod' && dbRole === 'dev') {
    throw new Error('❌ PROD backend cannot connect to DEV database')
  }
}
import { hasPg, pgPool } from './dbAdapter'
// Supabase removed
import fs from 'fs'
const isProd = process.env.NODE_ENV === 'production'
if (isProd && hasPg) {
  const url = process.env.DATABASE_URL || ''
  if (!url) throw new Error('DATABASE_URL 未设置')
  if (/localhost/i.test(url)) throw new Error('DATABASE_URL 不能使用 localhost')
  if (!/[?&](sslmode=require|sslmode=verify-full|ssl=true|ssl=1)\b/i.test(url)) throw new Error('DATABASE_URL 需开启 SSL（例如 sslmode=require）')
}

const app = express()
const allowList = String(process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)
const corsOpts: cors.CorsOptions = {
  origin: (origin, cb) => {
    if (!allowList.length) return cb(null, true)
    const ok = !origin || allowList.includes(origin)
    cb(null, ok)
  },
  credentials: true,
  methods: ['GET','HEAD','PUT','PATCH','POST','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-Guide-Session'],
  exposedHeaders: ['X-Total-Count','x-auto-expense-sync','x-auto-expense-reason','x-auto-expense-error']
}
app.use(cors(corsOpts))
app.options('*', cors(corsOpts))
const jsonLimit = String(process.env.JSON_BODY_LIMIT || '25mb')
app.use(express.json({ limit: jsonLimit }))
app.use(express.urlencoded({ extended: true, limit: jsonLimit }))
app.use(morgan('dev'))
// Health endpoints should NOT require auth
app.get('/health', (req, res) => { res.json({ status: 'ok' }) })
app.get('/health/db', async (_req, res) => {
  const result: any = { status: 'ok', appEnv, databaseRole: dbRole, pg: false }
  try {
    const url = process.env.DATABASE_URL || ''
    if (url) {
      const u = new URL(url)
      result.pg_host = u.hostname
      const db = (u.pathname || '').replace(/^\//,'')
      result.pg_database = db
    }
  } catch {}
  try {
    if (pgPool) {
      const r = await pgPool.query('SELECT current_database() as db, 1 as ok')
      result.pg = !!(r && r.rows && r.rows[0] && r.rows[0].ok)
      result.pg_database = result.pg_database || (r.rows?.[0]?.db)
    }
  } catch (e: any) {
    result.pg = false
    result.pg_error = e?.message
  }
  res.json(result)
})
app.get('/health/config', (_req, res) => {
  const cfg: any = {
    app_env: process.env.APP_ENV || 'unknown',
    node_env: process.env.NODE_ENV || 'unknown',
    database_role: process.env.DATABASE_ROLE || 'none',
    api_base: process.env.API_BASE || '',
    port: process.env.PORT || '4001',
  }
  try {
    const url = process.env.DATABASE_URL || ''
    if (url) {
      const u = new URL(url)
      cfg.pg_host = u.hostname
      cfg.pg_db = (u.pathname || '').replace(/^\//,'')
    }
  } catch {}
  res.json(cfg)
})
app.get('/health/r2', (_req, res) => {
  try { return res.json(r2Status()) } catch { return res.json({ hasR2: false }) }
})
app.get('/health/migrations', async (_req, res) => {
  const mig: any = { status: 'ok' }
  try {
    if (pgPool) {
      const qcol = async (table: string, col: string) => {
        const r = await pgPool!.query(`select 1 from information_schema.columns where table_schema='public' and table_name=$1 and column_name=$2 limit 1`, [table, col])
        return !!r.rowCount
      }
      mig.recurring_frequency_months = await qcol('recurring_payments','frequency_months')
      mig.orders_checkin = await qcol('orders','checkin')
      mig.orders_checkout = await qcol('orders','checkout')
    }
  } catch (e: any) {
    mig.status = 'error'
    mig.error = e?.message
  }
  res.json(mig)
})
app.get('/health/version', (_req, res) => {
  let pkg: any = {}
  try { pkg = require('../package.json') } catch {}
  const build = process.env.GIT_SHA || process.env.RENDER_GIT_COMMIT || 'unknown'
  res.json({ build, version: pkg.version || 'unknown', node_env: process.env.NODE_ENV || 'unknown', started_at: new Date().toISOString() })
})
app.get('/health/playwright', (_req, res) => {
  try { return res.json(getPlaywrightDiagnostics()) } catch (e: any) { return res.status(500).json({ message: String(e?.message || '') }) }
})
app.post('/internal/bootstrap-admin', async (req, res) => {
  const token = String(process.env.ADMIN_BOOTSTRAP_TOKEN || '')
  if (!token) return res.status(401).json({ message: 'unauthorized' })
  const h = String(req.headers.authorization || '')
  if (!h.startsWith('Bearer ') || h.slice(7) !== token) return res.status(401).json({ message: 'unauthorized' })
  if (!hasPg || !pgPool) return res.status(400).json({ message: 'pg_not_configured' })
  const body = req.body || {}
  const username = String(body.username || process.env.ADMIN_USERNAME || 'admin').trim()
  const email = String(body.email || process.env.ADMIN_EMAIL || 'admin@example.com').trim()
  const role = String(body.role || process.env.ADMIN_ROLE || 'admin').trim() || 'admin'
  const password = String(body.password || process.env.ADMIN_PASSWORD || '').trim()
  if (!username) return res.status(400).json({ message: 'missing_username' })
  if (!email) return res.status(400).json({ message: 'missing_email' })
  if (!password) return res.status(400).json({ message: 'missing_password' })
  try {
    const hash = await bcrypt.hash(password, 10)
    const r = await pgPool.query('SELECT id, username, email FROM users WHERE username=$1 OR email=$2 LIMIT 1', [username, email])
    const existing = r?.rows?.[0] || null
    if (!existing) {
      const id = uuid()
      await pgPool.query('INSERT INTO users(id, username, email, password_hash, role) VALUES ($1,$2,$3,$4,$5)', [id, username, email, hash, role])
      return res.json({ ok: true, action: 'created', id, username, email, role })
    }
    const id = String(existing.id)
    await pgPool.query('UPDATE users SET password_hash=$1, role=$2 WHERE id=$3', [hash, role, id])
    try { await pgPool.query('UPDATE sessions SET revoked=true WHERE user_id=$1 AND revoked=false', [id]) } catch {}
    return res.json({ ok: true, action: 'reset', id, username: existing.username, email: existing.email, role })
  } catch (e: any) {
    return res.status(500).json({ message: String(e?.message || 'bootstrap_failed') })
  }
})
app.post('/internal/trigger-email-sync', async (req, res) => {
  const h = String(req.headers.authorization || '')
  const hasBearer = h.startsWith('Bearer ')
  const token = hasBearer ? h.slice(7) : ''
  const cron = String(process.env.JOB_CRON_TOKEN || '')
  if (!cron || token !== cron) return res.status(401).json({ message: 'unauthorized' })
  try {
    const body = req.body || {}
    const account = String(body.account || '') || undefined
    const maxPer = Math.min(50, Number(body.max_per_run || 50))
    const maxMsgs = Math.min(50, Number(body.max_messages || 50))
    const r = await runEmailSyncJob({ mode: 'incremental', account, max_per_run: maxPer, max_messages: maxMsgs, batch_size: Math.min(20, Number(body.batch_size || 20)), concurrency: 1, batch_sleep_ms: 0, min_interval_ms: 0, trigger_source: 'internal_web_cron' })
    return res.json({ ok: true, stats: r?.stats || {}, schedule_runs: r?.schedule_runs || [] })
  } catch (e: any) {
    return res.status(Number(e?.status || 500)).json({ message: e?.message || 'trigger_failed', reason: e?.reason || 'unknown' })
  }
})
app.get('/__routes', (_req, res) => {
  try {
    const list: Array<{ path: string; methods: string[] }> = []
    function add(path: string, methodsObj: any) {
      const methods = Object.keys(methodsObj || {}).filter(k => !!methodsObj[k]).map(k => k.toUpperCase())
      list.push({ path, methods })
    }
    function base(layer: any): string {
      const s = String(layer?.regexp?.source || '')
      const m = s.match(/^\\\/([A-Za-z0-9_\-]+)(?:\\\/)?/) || s.match(/^\^\\\/([A-Za-z0-9_\-]+)(?:\\\/)?/)
      return m ? `/${m[1]}` : ''
    }
    const stack: any[] = (app as any)?._router?.stack || []
    for (const layer of stack) {
      if (layer?.route) {
        add(String(layer.route.path || ''), layer.route.methods || {})
      } else if (layer?.name === 'router' && layer?.handle?.stack) {
        const b = base(layer)
        for (const h of layer.handle.stack) {
          if (h?.route) add(`${b}${String(h.route.path || '')}`, h.route.methods || {})
        }
      }
    }
    res.json(list)
  } catch (e: any) {
    res.status(500).json({ message: e?.message || 'route list failed' })
  }
})
app.use('/public', auth, publicAdminRouter)
app.use('/public', publicRouter)
app.use(auth)
const uploadDir = path.join(process.cwd(), 'uploads')
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir)
app.use('/uploads', (_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
  next()
})
app.use('/uploads', express.static(uploadDir))


app.use('/landlords', landlordsRouter)
app.use('/properties', propertiesRouter)
app.use('/keys', keysRouter)
app.use('/orders', ordersRouter)
app.use('/inventory', inventoryRouter)
app.use('/finance', financeRouter)
app.use('/crud', crudRouter)
app.use('/recurring', recurringRouter)
app.use('/cleaning', cleaningRouter)
app.use('/cleaning-app', cleaningAppRouter)
app.use('/config', configRouter)
app.use('/auth', authRouter)
app.use('/audits', auditsRouter)
app.use('/rbac', rbacRouter)
app.use('/users', usersRouter)
app.use('/version', versionRouter)
app.use('/stats', statsRouter)
app.use('/events', eventsRouter)
app.use('/notifications', notificationsRouter)
app.use('/maintenance', maintenanceRouter)
app.use('/deep-cleaning', deepCleaningRouter)
app.use('/work-tasks', workTasksRouter)
app.use('/task-center', taskCenterRouter)
app.use('/mzapp', mzappRouter)
app.use('/property-guides', propertyGuidesRouter)
app.use('/property-guide-link-sync', propertyGuideLinkSyncRouter)
app.use('/jobs', jobsRouter)
app.use('/onboarding', propertyOnboardingRouter)
app.use('/invoices', invoicesRouter)
app.use('/cms', cmsCompanyRouter)
app.use('/cms', cmsCompanySecretsRouter)

const port = process.env.PORT_OVERRIDE ? Number(process.env.PORT_OVERRIDE) : (process.env.PORT ? Number(process.env.PORT) : 4001)
app.listen(port, () => {
  console.log(`Server listening on port ${port}`)
  console.log(`[DataSources] pg=${hasPg}`)
  try {
    const url = process.env.DATABASE_URL || ''
    if (url) {
      const u = new URL(url)
      const db = (u.pathname || '').replace(/^\//,'')
      console.log(`[PG] host=${u.hostname} db=${db}`)
    }
  } catch {}
  try {
    const defaultEnabled = (process.env.NODE_ENV === 'production')
    const enabled = String(process.env.EMAIL_SYNC_SCHEDULE_ENABLED || (defaultEnabled ? 'true' : 'false')).toLowerCase() === 'true'
    const expr = String(process.env.EMAIL_SYNC_CRON || '0 */3 * * *')
    if (enabled && hasPg) {
      console.log(`[email-sync][schedule] enabled cron=${expr}`)
      const task = cron.schedule(expr, async () => {
        const started = Date.now()
        try {
          const key = 987654321
          const lock = await pgPool!.query('SELECT pg_try_advisory_lock($1) AS ok', [key])
          const ok = !!(lock?.rows?.[0]?.ok)
          if (!ok) { console.log('[email-sync][schedule] skipped_reason=already_running'); return }
          const res = await runEmailSyncJob({ mode: 'incremental', trigger_source: 'schedule', max_per_run: Math.min(50, Number(process.env.EMAIL_SYNC_MAX_PER_RUN || 50)), batch_size: Math.min(20, Number(process.env.EMAIL_SYNC_BATCH_SIZE || 20)), concurrency: Math.min(1, Number(process.env.EMAIL_SYNC_CONCURRENCY || 1)), batch_sleep_ms: Number(process.env.EMAIL_SYNC_BATCH_SLEEP_MS || 0), min_interval_ms: Number(process.env.EMAIL_SYNC_MIN_INTERVAL_MS || 60000) })
          const dur = Date.now() - started
          const s = (res?.stats || {})
          console.log(`[email-sync][schedule] scanned=${s.scanned||0} inserted=${s.inserted||0} skipped=${s.skipped_duplicate||0} failed=${s.failed||0} duration_ms=${dur}`)
          try { await pgPool!.query('SELECT pg_advisory_unlock($1)', [key]) } catch {}
        } catch (e: any) {
          console.error(`[email-sync][schedule] error message=${String(e?.message || '')}`)
        }
      }, { scheduled: true })
      task.start()

      const wdEnabled = String(process.env.EMAIL_SYNC_WATCHDOG_ENABLED || 'true').toLowerCase() === 'true'
      if (wdEnabled) {
      const wd = cron.schedule('*/10 * * * *', async () => {
        try {
          const key = 987654321
          const lock = await pgPool!.query('SELECT pg_try_advisory_lock($1) AS ok', [key])
          const ok = !!(lock?.rows?.[0]?.ok)
          if (!ok) return
          // collect recent failed uids per account; exclude duplicates/already_running
          const sql = `
            WITH cand AS (
              SELECT account, uid FROM email_orders_raw WHERE status IN ('failed','unmatched_property') AND created_at > now() - interval '12 hours' AND uid IS NOT NULL AND account IS NOT NULL
              UNION ALL
              SELECT account, uid FROM email_sync_items WHERE status='failed' AND created_at > now() - interval '12 hours' AND uid IS NOT NULL AND account IS NOT NULL
            )
            SELECT DISTINCT c.account, c.uid
            FROM cand c
            WHERE NOT EXISTS (
              SELECT 1 FROM email_sync_items e
              WHERE e.account = c.account AND e.uid = c.uid AND e.status='skipped' AND e.reason IN ('duplicate','already_running','db_error')
            )
            ORDER BY c.account DESC, c.uid DESC
            LIMIT 200`
          const rs = await pgPool!.query(sql)
          const groups: Record<string, number[]> = {}
          for (const r of (rs?.rows || [])) {
            const acc = String(r.account || '')
            const uid = Number(r.uid || 0)
            if (!acc || !uid) continue
            if (!groups[acc]) groups[acc] = []
            if (groups[acc].length < 50) groups[acc].push(uid)
          }
          for (const acc of Object.keys(groups)) {
            const uids = groups[acc]
            if (!uids.length) continue
            console.log(`[email-sync][watchdog] retry account=${acc} uids=${uids.length}`)
            try { await runEmailSyncJob({ mode: 'incremental', trigger_source: 'watchdog_retry_failed', account: acc, uids, min_interval_ms: 0, max_per_run: uids.length, batch_size: Math.min(10, uids.length), concurrency: 1, batch_sleep_ms: 0 }) } catch (e: any) { console.error(`[email-sync][watchdog] account=${acc} error=${String(e?.message || '')}`) }
          }
          try { await pgPool!.query('SELECT pg_advisory_unlock($1)', [key]) } catch {}
        } catch (e: any) { console.error(`[email-sync][watchdog] error=${String(e?.message || '')}`) }
      }, { scheduled: true })
      wd.start()
      } else {
        console.log('[email-sync][watchdog] disabled')
      }
    } else {
      console.log('[email-sync][schedule] disabled')
    }
  } catch (e: any) {
    console.error(`[email-sync][schedule] init error message=${String(e?.message || '')}`)
  }
  ;(async () => {
    try {
      if (hasPg) {
        const r1 = await pgPool!.query('SELECT current_database() AS db, current_schema AS schema')
        const r2 = await pgPool!.query('SHOW search_path')
        const r3 = await pgPool!.query('SELECT current_schemas(true) AS schemas')
        console.log(`[DBInfo] current_database=${String(r1?.rows?.[0]?.db||'')} current_schema=${String(r1?.rows?.[0]?.schema||'')} search_path=${String(r2?.rows?.[0]?.search_path||'')} current_schemas=${JSON.stringify(r3?.rows?.[0]?.schemas||[])}`)
      }
    } catch (e: any) {
  console.log(`[DBInfo] query failed message=${String(e?.message || '')}`)
  }
  })()
  ;(async () => {
    try {
      const enableCleaning = String(process.env.FEATURE_CLEANING_APP || 'false').toLowerCase() === 'true'
      if (enableCleaning && hasPg) {
        const expr = String(process.env.CLEANING_START_TIMEOUT_CRON || '*/15 * * * *')
        const threshMin = Number(process.env.CLEANING_START_TIMEOUT_MINUTES || 60)
        const task = cron.schedule(expr, async () => {
          try {
            const sql = `select id, assignee_id, scheduled_at, key_photo_uploaded_at from cleaning_tasks where date=now()::date and status='scheduled'`
            const rs = await pgPool!.query(sql)
            for (const r of (rs?.rows || [])) {
              const sch = r.scheduled_at ? new Date(r.scheduled_at) : null
              const hasKeyPhoto = !!r.key_photo_uploaded_at
              if (!sch || hasKeyPhoto) continue
              const diff = Date.now() - sch.getTime()
              if (diff > threshMin * 60 * 1000) {
                console.log(`[cleaning-timeout] task=${r.id} assignee=${r.assignee_id} overdue_minutes=${Math.round(diff/60000)}`)
              }
            }
          } catch (e: any) {
            console.error(`[cleaning-timeout] error message=${String(e?.message || '')}`)
          }
        }, { scheduled: true })
        task.start()
      }
    } catch (e: any) {
      console.error(`[cleaning-timeout] init error message=${String(e?.message || '')}`)
    }
  })()
  ;(async () => {
    try {
      const fastEnabled = String(process.env.CLEANING_BACKFILL_FAST_ENABLED || 'false').toLowerCase() === 'true'
      const slowEnabled = String(process.env.CLEANING_BACKFILL_SLOW_ENABLED || 'false').toLowerCase() === 'true'
      if (!(fastEnabled || slowEnabled)) {
        console.log('[cleaning-backfill][schedule] disabled')
        return
      }
      if (!hasPg || !pgPool) {
        console.log('[cleaning-backfill][schedule] pg=false')
        return
      }

      const lockName = String(process.env.CLEANING_BACKFILL_LOCK_NAME || 'cleaning_backfill')
      const lockTtlMs = Math.max(60000, Number(process.env.CLEANING_BACKFILL_LOCK_TTL_MS || (6 * 60 * 60 * 1000)))
      const minIntervalMs = Math.max(0, Number(process.env.CLEANING_BACKFILL_MIN_INTERVAL_MS || 0))
      const timeZone = String(process.env.CLEANING_BACKFILL_TIME_ZONE || 'Australia/Sydney')
      const renewEveryMs = Math.max(60000, Number(process.env.CLEANING_BACKFILL_LOCK_RENEW_MS || (2 * 60 * 1000)))
      const state: { lastRunAt?: number } = {}
      const { runCleaningBackfillOnce } = require('./services/cleaningBackfillRunner')

      if (fastEnabled) {
        const expr = String(process.env.CLEANING_BACKFILL_FAST_CRON || '0 */4 * * *')
        console.log(`[cleaning-backfill][fast][schedule] enabled cron=${expr}`)
        const pastDays = Math.max(0, Number(process.env.CLEANING_BACKFILL_FAST_PAST_DAYS || 1))
        const futureDays = Math.max(0, Number(process.env.CLEANING_BACKFILL_FAST_FUTURE_DAYS || 7))
        const concurrency = Math.max(1, Math.min(25, Number(process.env.CLEANING_BACKFILL_FAST_CONCURRENCY || 10)))
        const task = cron.schedule(expr, async () => {
          const r = await runCleaningBackfillOnce({ scheduleName: 'fast', lockName, lockTtlMs, lockRenewIntervalMs: renewEveryMs, timeZone, pastDays, futureDays, concurrency, minIntervalMs, state, triggerSource: 'schedule' })
          if (r?.skipped) console.log(`[cleaning-backfill][fast][schedule] skipped_reason=${String((r as any).skipped_reason || '')}`)
          else if (r?.ok) console.log(`[cleaning-backfill][fast][schedule] ok run_id=${String((r as any).run_id || '')} scanned=${Number((r as any).orders_scanned || 0)} failed=${Number((r as any).orders_failed || 0)} duration_ms=${Number((r as any).duration_ms || 0)}`)
          else console.error(`[cleaning-backfill][fast][schedule] failed run_id=${String((r as any).run_id || '')} message=${String((r as any).error || '')}`)
        }, { scheduled: true })
        task.start()
      } else {
        console.log('[cleaning-backfill][fast][schedule] disabled')
      }

      if (slowEnabled) {
        const expr = String(process.env.CLEANING_BACKFILL_SLOW_CRON || '0 3 */2 * *')
        console.log(`[cleaning-backfill][slow][schedule] enabled cron=${expr}`)
        const pastDays = Math.max(0, Number(process.env.CLEANING_BACKFILL_SLOW_PAST_DAYS || 14))
        const futureDays = Math.max(0, Number(process.env.CLEANING_BACKFILL_SLOW_FUTURE_DAYS || 30))
        const concurrency = Math.max(1, Math.min(25, Number(process.env.CLEANING_BACKFILL_SLOW_CONCURRENCY || 10)))
        const task = cron.schedule(expr, async () => {
          const r = await runCleaningBackfillOnce({ scheduleName: 'slow', lockName, lockTtlMs, lockRenewIntervalMs: renewEveryMs, timeZone, pastDays, futureDays, concurrency, minIntervalMs, state, triggerSource: 'schedule' })
          if (r?.skipped) console.log(`[cleaning-backfill][slow][schedule] skipped_reason=${String((r as any).skipped_reason || '')}`)
          else if (r?.ok) console.log(`[cleaning-backfill][slow][schedule] ok run_id=${String((r as any).run_id || '')} scanned=${Number((r as any).orders_scanned || 0)} failed=${Number((r as any).orders_failed || 0)} duration_ms=${Number((r as any).duration_ms || 0)}`)
          else console.error(`[cleaning-backfill][slow][schedule] failed run_id=${String((r as any).run_id || '')} message=${String((r as any).error || '')}`)
        }, { scheduled: true })
        task.start()
      } else {
        console.log('[cleaning-backfill][slow][schedule] disabled')
      }
    } catch (e: any) {
      console.error(`[cleaning-backfill][schedule] init error message=${String(e?.message || '')}`)
    }
  })()
  ;(async () => {
    try {
      const enabled = String(process.env.CLEANING_SYNC_JOBS_ENABLED || 'true').toLowerCase() === 'true'
      if (enabled && hasPg) {
        const expr = String(process.env.CLEANING_SYNC_JOBS_CRON || '*/1 * * * *')
        console.log(`[cleaning-sync-jobs][schedule] enabled cron=${expr}`)
        let inFlight = false
        const task = cron.schedule(expr, async () => {
          if (inFlight) { try { console.log('[cleaning-sync-jobs][schedule] skipped_reason=in_flight') } catch {} ; return }
          let jr: any = null
          const startedAt = Date.now()
          try {
            inFlight = true
            try {
              const { createJobRun } = require('./services/jobRuns')
              jr = await createJobRun({ job_name: 'cleaning_sync_jobs', schedule_name: 'cron', trigger_source: 'schedule', run_id: uuid() })
            } catch {}
            const { processCleaningSyncJobsOnce } = require('./services/cleaningSyncJobsWorker')
            const r = await processCleaningSyncJobsOnce({
              limit: Math.min(20, Number(process.env.CLEANING_SYNC_JOBS_BATCH || 10)),
              reclaim_timeout_minutes: Math.min(120, Math.max(1, Number(process.env.CLEANING_SYNC_JOBS_RECLAIM_MINUTES || 10))),
            })
            try {
              if (jr?.id) {
                const { finishJobRun } = require('./services/jobRuns')
                await finishJobRun({
                  id: String(jr.id),
                  orders_scanned: Number(r.processed || 0),
                  orders_succeeded: Number(r.ok || 0),
                  orders_failed: Number(r.failed || 0),
                  duration_ms: Date.now() - startedAt,
                  result: r,
                })
              }
            } catch {}
            if ((r?.processed || 0) > 0 || (r?.failed || 0) > 0 || (r?.reclaimed || 0) > 0) {
              console.log(`[cleaning-sync-jobs][schedule] processed=${r.processed || 0} ok=${r.ok || 0} failed=${r.failed || 0} reclaimed=${r.reclaimed || 0}`)
            }
          } catch (e: any) {
            try {
              if (jr?.id) {
                const { finishJobRun } = require('./services/jobRuns')
                await finishJobRun({ id: String(jr.id), duration_ms: Date.now() - startedAt, error_message: String(e?.message || ''), result: { message: String(e?.message || ''), code: String(e?.code || '') } })
              }
            } catch {}
            console.error(`[cleaning-sync-jobs][schedule] error message=${String(e?.message || '')}`)
          } finally {
            inFlight = false
          }
        }, { scheduled: true })
        task.start()
      } else {
        console.log('[cleaning-sync-jobs][schedule] disabled')
      }
    } catch (e: any) {
      console.error(`[cleaning-sync-jobs][schedule] init error message=${String(e?.message || '')}`)
    }
  })()
  ;(async () => {
    try {
      const enabled = String(process.env.CLEANING_SYNC_RETRY_ENABLED || 'true').toLowerCase() === 'true'
      if (enabled && hasPg) {
        const expr = String(process.env.CLEANING_SYNC_RETRY_CRON || '*/5 * * * *')
        console.log(`[cleaning-sync-retry][schedule] enabled cron=${expr}`)
        const task = cron.schedule(expr, async () => {
          try {
            const key = 246813579
            const lock = await pgPool!.query('SELECT pg_try_advisory_lock($1) AS ok', [key])
            const ok = !!(lock?.rows?.[0]?.ok)
            if (!ok) return
            const { processDueCleaningSyncRetries } = require('./services/cleaningSyncRetry')
            const r = await processDueCleaningSyncRetries({ limit: Math.min(20, Number(process.env.CLEANING_SYNC_RETRY_BATCH || 10)) })
            if ((r?.processed || 0) > 0 || (r?.failed || 0) > 0) {
              console.log(`[cleaning-sync-retry][schedule] processed=${r.processed || 0} ok=${r.ok || 0} failed=${r.failed || 0}`)
            }
            try { await pgPool!.query('SELECT pg_advisory_unlock($1)', [key]) } catch {}
          } catch (e: any) {
            console.error(`[cleaning-sync-retry][schedule] error message=${String(e?.message || '')}`)
          }
        }, { scheduled: true })
        task.start()
      } else {
        console.log('[cleaning-sync-retry][schedule] disabled')
      }
    } catch (e: any) {
      console.error(`[cleaning-sync-retry][schedule] init error message=${String(e?.message || '')}`)
    }
  })()
  ;(async () => {
    try {
      const enabled = String(process.env.PDF_JOBS_SCHEDULE_ENABLED || 'true').toLowerCase() === 'true'
      if (enabled && hasPg) {
        const expr = String(process.env.PDF_JOBS_CRON || '*/1 * * * *')
        console.log(`[pdf-jobs][schedule] enabled cron=${expr}`)
        let inFlight = false
        const task = cron.schedule(expr, async () => {
          if (inFlight) { try { console.log('[pdf-jobs][schedule] skipped_reason=in_flight') } catch {} ; return }
          try {
            inFlight = true
            const { processPdfJobsOnce } = require('./services/pdfJobsWorker')
            const r = await processPdfJobsOnce({
              limit: Math.min(5, Math.max(1, Number(process.env.PDF_JOBS_BATCH || 2))),
            })
            if ((r?.processed || 0) > 0 || (r?.failed || 0) > 0 || (r?.reclaimed || 0) > 0) {
              console.log(`[pdf-jobs][schedule] processed=${r.processed || 0} ok=${r.ok || 0} failed=${r.failed || 0} reclaimed=${r.reclaimed || 0}`)
            }
          } catch (e: any) {
            console.error(`[pdf-jobs][schedule] error message=${String(e?.message || '')}`)
          } finally {
            inFlight = false
          }
        }, { scheduled: true })
        task.start()
      } else {
        console.log('[pdf-jobs][schedule] disabled')
      }
    } catch (e: any) {
      console.error(`[pdf-jobs][schedule] init error message=${String(e?.message || '')}`)
    }
  })()

  ;(async () => {
    try {
      const defaultEnabled = process.env.NODE_ENV === 'production'
      const enabled = String(process.env.KEY_UPLOAD_SLA_ENABLED || 'false').toLowerCase() === 'true'
      const featureCleaning = String(process.env.FEATURE_CLEANING_APP || 'false').toLowerCase() === 'true'
      if (!enabled) {
        console.log('[key-upload-sla][schedule] disabled')
        return
      }
      if (!featureCleaning) {
        console.log('[key-upload-sla][schedule] skipped_reason=feature_cleaning_app_disabled')
        return
      }
      if (!hasPg || !pgPool) {
        console.log('[key-upload-sla][schedule] skipped_reason=pg=false')
        return
      }

    } catch (e: any) {
      console.error(`[key-upload-sla][schedule] init error message=${String(e?.message || '')}`)
    }
  })()

  ;(async () => {
    try {
      const defaultEnabled = process.env.NODE_ENV === 'production'
      const enabled = String(process.env.KEY_UPLOAD_REMINDER_ENABLED || (defaultEnabled ? 'true' : 'false')).toLowerCase() === 'true'
      const featureCleaning = String(process.env.FEATURE_CLEANING_APP || 'false').toLowerCase() === 'true'
      if (!enabled) {
        console.log('[key-upload-reminder][schedule] disabled')
        return
      }
      if (!featureCleaning) {
        console.log('[key-upload-reminder][schedule] skipped_reason=feature_cleaning_app_disabled')
        return
      }
      if (!hasPg || !pgPool) {
        console.log('[key-upload-reminder][schedule] skipped_reason=pg=false')
        return
      }

      const schedules: Array<{ expr: string; at: string }> = [
        { expr: '0 10 * * *', at: '10:00' },
        { expr: '30 11 * * *', at: '11:30' },
        { expr: '0 13 * * *', at: '13:00' },
        { expr: '0 14 * * *', at: '14:00' },
      ]

      for (const s of schedules) {
        console.log(`[key-upload-reminder][schedule] enabled cron=${s.expr} tz=Australia/Melbourne at=${s.at}`)
        const task = cron.schedule(
          s.expr,
          async () => {
            const started = Date.now()
            try {
              const lockKey = 246802468 + Number(s.at.replace(':', ''))
              const lock = await pgPool!.query('SELECT pg_try_advisory_lock($1) AS ok', [lockKey])
              const ok = !!(lock?.rows?.[0]?.ok)
              if (!ok) return
              const r = await runKeyUploadReminder({ at: s.at })
              const dur = Date.now() - started
              if ((r as any)?.skipped) console.log(`[key-upload-reminder][schedule] skipped_reason=${String((r as any).skipped)}`)
              else console.log(`[key-upload-reminder][schedule] ok at=${s.at} duration_ms=${dur}`)
              try { await pgPool!.query('SELECT pg_advisory_unlock($1)', [lockKey]) } catch {}
            } catch (e: any) {
              console.error(`[key-upload-reminder][schedule] error at=${s.at} message=${String(e?.message || '')}`)
            }
          },
          { scheduled: true, timezone: 'Australia/Melbourne' },
        )
        task.start()
      }
    } catch (e: any) {
      console.error(`[key-upload-reminder][schedule] init error message=${String(e?.message || '')}`)
    }
  })()
  })
  app.get('/health/login', async (_req, res) => {
    const started = Date.now()
    try {
      if (hasPg) {
        const r = await pgPool!.query('SELECT 1 AS ok')
        const dur = Date.now() - started
        return res.json({ ok: true, db_ok: !!(r?.rows?.[0]?.ok), latency_ms: dur })
      }
      return res.json({ ok: true, db_ok: false, latency_ms: Date.now() - started })
    } catch (e: any) {
      return res.status(500).json({ ok: false, message: String(e?.message || ''), latency_ms: Date.now() - started })
    }
  })

  app.get('/health/email-sync', async (_req, res) => {
    try {
      if (hasPg) {
        const r = await pgPool!.query('SELECT id, status, scanned, inserted, failed, created_at FROM email_sync_runs ORDER BY created_at DESC LIMIT 1')
        return res.json({ last_run: r?.rows?.[0] || null })
      }
      return res.json({ last_run: null })
    } catch (e: any) {
      return res.status(500).json({ message: String(e?.message || '') })
    }
  })
