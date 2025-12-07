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
import { auth } from './auth'
import { hasPg, pgPool } from './dbAdapter'
import { hasSupabase, supabase } from './supabase'
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
app.use(auth)
const uploadDir = path.join(process.cwd(), 'uploads')
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir)
app.use('/uploads', express.static(uploadDir))

app.get('/health', (req, res) => {
  res.json({ status: 'ok' })
})
app.get('/health/db', async (_req, res) => {
  const result: any = { pg: false, supabase: false }
  try {
    if (pgPool) {
      const r = await pgPool.query('SELECT 1 as ok')
      result.pg = !!(r && r.rows && r.rows[0] && r.rows[0].ok)
    }
  } catch (e: any) {
    result.pg = false
    result.pg_error = e?.message
  }
  try {
    if (supabase) {
      const { error } = await supabase.from('properties').select('id').limit(1)
      result.supabase = !error
      if (error) result.supabase_error = error.message
    }
  } catch (e: any) {
    result.supabase = false
    result.supabase_error = e?.message
  }
  res.json(result)
})

app.use('/landlords', landlordsRouter)
app.use('/properties', propertiesRouter)
app.use('/keys', keysRouter)
app.use('/orders', ordersRouter)
app.use('/inventory', inventoryRouter)
app.use('/finance', financeRouter)
app.use('/crud', crudRouter)
app.use('/cleaning', cleaningRouter)
app.use('/config', configRouter)
app.use('/auth', authRouter)
app.use('/audits', auditsRouter)
app.use('/rbac', rbacRouter)
app.use('/version', versionRouter)
app.use('/maintenance', maintenanceRouter)

const port = process.env.PORT ? Number(process.env.PORT) : 4001
app.listen(port, () => {console.log(`Server listening on port ${port}`); console.log(`[DataSources] pg=${hasPg} supabase=${hasSupabase}`)})
