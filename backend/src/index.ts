import dotenv from 'dotenv'
import path from 'path'
dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), override: true })
dotenv.config()
import express from 'express'
import cors from 'cors'
import morgan from 'morgan'
import { router as landlordsRouter } from './modules/landlords'
import { router as propertiesRouter } from './modules/properties'
import { router as keysRouter } from './modules/keys'
import { router as ordersRouter } from './modules/orders'
import { router as inventoryRouter } from './modules/inventory'
import { router as financeRouter } from './modules/finance'
import { router as cleaningRouter } from './modules/cleaning'
import { router as configRouter } from './modules/config'
import { router as authRouter } from './modules/auth'
import { router as auditsRouter } from './modules/audits'
import { router as rbacRouter } from './modules/rbac'
import { router as versionRouter } from './modules/version'
import maintenanceRouter from './modules/maintenance'
import crudRouter from './modules/crud'
import recurringRouter from './modules/recurring'
import { auth } from './auth'
// 环境保险锁（允许缺省采用智能默认，不再抛错）
let appEnv = process.env.APP_ENV
let dbRole = process.env.DATABASE_ROLE
if (!appEnv) {
  appEnv = process.env.NODE_ENV === 'production' ? 'prod' : 'dev'
  process.env.APP_ENV = appEnv
}
if (!dbRole) {
  const url = process.env.DATABASE_URL || ''
  dbRole = url ? (/localhost/i.test(url) ? 'dev' : 'prod') : 'none'
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
  if (!/[?&]sslmode=require/.test(url)) throw new Error('DATABASE_URL 需包含 sslmode=require')
}

const app = express()
const corsOpts: cors.CorsOptions = {
  origin: true,
  credentials: false,
  methods: ['GET','HEAD','PUT','PATCH','POST','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization']
}
app.use(cors(corsOpts))
app.options('*', cors(corsOpts))
app.use(express.json())
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
// Auth middleware comes AFTER health routes
app.use(auth)
const uploadDir = path.join(process.cwd(), 'uploads')
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir)
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
app.use('/config', configRouter)
app.use('/auth', authRouter)
app.use('/audits', auditsRouter)
app.use('/rbac', rbacRouter)
app.use('/version', versionRouter)
app.use('/maintenance', maintenanceRouter)

const port = process.env.PORT ? Number(process.env.PORT) : 4001
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
})
