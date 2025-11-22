import 'dotenv/config'
import { pgPool } from '../src/dbAdapter'
import bcrypt from 'bcryptjs'
import { v4 as uuid } from 'uuid'

async function run() {
  if (!pgPool) {
    console.error('DATABASE_URL not set. Please configure backend/.env')
    process.exit(1)
  }
  const username = process.env.ADMIN_USERNAME || 'admin'
  const email = process.env.ADMIN_EMAIL || 'admin@example.com'
  const role = process.env.ADMIN_ROLE || 'admin'
  const password = process.env.ADMIN_PASSWORD || 'admin'
  const hash = await bcrypt.hash(password, 10)
  const id = uuid()

  const exists = await pgPool.query('SELECT id FROM users WHERE username = $1 OR email = $2 LIMIT 1', [username, email])
  if (exists.rows.length) {
    console.log('User already exists, skipping')
    process.exit(0)
  }
  await pgPool.query('INSERT INTO users(id, username, email, password_hash, role) VALUES ($1,$2,$3,$4,$5)', [id, username, email, hash, role])
  console.log('Seeded admin user:', username)
  await pgPool.end()
}

run().catch(async (e) => {
  console.error(e)
  if (pgPool) await pgPool.end()
  process.exit(1)
})