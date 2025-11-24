import 'dotenv/config'
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
import { auth } from './auth'
import { hasPg } from './dbAdapter'
import { hasSupabase } from './supabase'
import fs from 'fs'
import path from 'path'

const app = express()
app.use(cors())
app.use(express.json())
app.use(morgan('dev'))
app.use(auth)
const uploadDir = path.join(process.cwd(), 'uploads')
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir)
app.use('/uploads', express.static(uploadDir))

app.get('/health', (req, res) => {
  res.json({ status: 'ok' })
})

app.use('/landlords', landlordsRouter)
app.use('/properties', propertiesRouter)
app.use('/keys', keysRouter)
app.use('/orders', ordersRouter)
app.use('/inventory', inventoryRouter)
app.use('/finance', financeRouter)
app.use('/cleaning', cleaningRouter)
app.use('/config', configRouter)
app.use('/auth', authRouter)
app.use('/audits', auditsRouter)
app.use('/rbac', rbacRouter)
app.use('/version', versionRouter)

const port = process.env.PORT ? Number(process.env.PORT) : 4000
app.listen(port, () => {console.log(`Server listening on port ${port}`); console.log(`[DataSources] pg=${hasPg} supabase=${hasSupabase}`)})
