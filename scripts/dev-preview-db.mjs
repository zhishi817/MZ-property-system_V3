import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
export const PREVIEW_ROOT = path.resolve(SCRIPT_DIR, '..')
const STATE_DIR = path.join(PREVIEW_ROOT, '.dev-preview')
const STATE_FILE = path.join(STATE_DIR, 'database-identity.json')
const BACKEND_ENV_FILE = path.join(PREVIEW_ROOT, 'backend', '.env.local')
const FRONTEND_ENV_FILE = path.join(PREVIEW_ROOT, 'frontend', '.env.local')
const DEFAULT_SOURCE_ENV = path.resolve(PREVIEW_ROOT, '..', '..', 'MZ Property System', 'backend', '.env.local')

const BACKGROUND_OVERRIDES = {
  MZ_DEV_PREVIEW: '1',
  APP_ENV: 'dev',
  DATABASE_ROLE: 'dev',
  NODE_ENV: 'development',
  PORT_OVERRIDE: '4002',
  FRONTEND_BASE_URL: 'http://localhost:3000',
  FRONTEND_URL: 'http://localhost:3000',
  ALLOWED_ORIGINS: 'http://localhost:3000,http://127.0.0.1:3000',
  EMAIL_SYNC_SCHEDULE_ENABLED: 'false',
  EMAIL_SYNC_WATCHDOG_ENABLED: 'false',
  NOTIFICATION_WORKER_ENABLED: 'false',
  NOTIFICATION_WORKER_RUN_ON_START: 'false',
  CLEANING_SYNC_JOBS_ENABLED: 'false',
  CLEANING_SYNC_RETRY_ENABLED: 'false',
  CLEANING_BACKFILL_FAST_ENABLED: 'false',
  CLEANING_BACKFILL_SLOW_ENABLED: 'false',
  JOB_RUNS_PRUNE_ENABLED: 'false',
  KEY_UPLOAD_SLA_ENABLED: 'false',
  KEY_UPLOAD_REMINDER_ENABLED: 'false',
  DAY_END_HANDOVER_REMINDER_ENABLED: 'false',
  FEATURE_CLEANING_APP: 'false',
  PDF_JOBS_MODE: 'disabled',
}

const EXTERNAL_SECRET_KEY = /^(?:R2_|CLOUDFLARE_|SMTP_|IMAP_|GMAIL_|MICROSOFT_|OUTLOOK_|RESEND_|TWILIO_|STRIPE_|OPENAI_|ANTHROPIC_|GOOGLE_|AWS_|S3_|AIRBNB_|REDIS_|UPSTASH_|SENTRY_|ALERT_WEBHOOK_|VERCEL_PROTECTION_)/i
const PRODUCTION_DATABASE_KEYS = new Set(['DATABASE_URL_PROD', 'NEON_DATABASE_URL_PROD'])

export function parseEnvText(text) {
  const result = {}
  for (const rawLine of String(text || '').split(/\r?\n/g)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const index = line.indexOf('=')
    if (index < 1) continue
    const key = line.slice(0, index).trim()
    let value = line.slice(index + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    result[key] = value
  }
  return result
}

export function readEnvFile(file) {
  if (!fs.existsSync(file)) throw new Error(`environment file is missing: ${file}`)
  return parseEnvText(fs.readFileSync(file, 'utf8'))
}

export function databaseIdentityFingerprint(rawUrl) {
  const url = new URL(String(rawUrl || ''))
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('DATABASE_URL must use postgres')
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''))
  if (!url.hostname || !database) throw new Error('DATABASE_URL must include host and database')
  const identity = [url.protocol, url.hostname.toLowerCase(), url.port || '5432', decodeURIComponent(url.username), database].join('|')
  return crypto.createHash('sha256').update(identity).digest('hex')
}

export function assertDevDatabaseConfig(env, expectedFingerprint = '') {
  if (String(env.APP_ENV || '').toLowerCase() !== 'dev') throw new Error('APP_ENV must be dev')
  if (String(env.DATABASE_ROLE || '').toLowerCase() !== 'dev') throw new Error('DATABASE_ROLE must be dev')
  if (/^(?:prod|production)$/i.test(String(env.NODE_ENV || ''))) throw new Error('NODE_ENV cannot be production')
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required')

  const currentFingerprint = databaseIdentityFingerprint(env.DATABASE_URL)
  const productionUrl = env.NEON_DATABASE_URL_PROD || env.DATABASE_URL_PROD || ''
  const productionFingerprint = env.MZ_DEV_PREVIEW_PROD_DB_FINGERPRINT
    || (productionUrl ? databaseIdentityFingerprint(productionUrl) : '')
  if (!productionFingerprint) throw new Error('production database identity is required for fail-closed comparison')
  if (currentFingerprint === productionFingerprint) throw new Error('refusing production database identity')

  const enrolledFingerprint = expectedFingerprint || env.MZ_DEV_PREVIEW_DATABASE_FINGERPRINT || ''
  if (enrolledFingerprint && currentFingerprint !== enrolledFingerprint) {
    throw new Error('database identity differs from enrolled MZ-Dev-Preview database')
  }
  return { currentFingerprint, productionFingerprint }
}

export function buildSanitizedEnvironment(sourceEnv) {
  const { currentFingerprint, productionFingerprint } = assertDevDatabaseConfig(sourceEnv)
  const result = {}
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (EXTERNAL_SECRET_KEY.test(key)) continue
    if (PRODUCTION_DATABASE_KEYS.has(key)) continue
    result[key] = value
  }
  Object.assign(result, BACKGROUND_OVERRIDES, {
    MZ_DEV_PREVIEW_DATABASE_FINGERPRINT: currentFingerprint,
    MZ_DEV_PREVIEW_PROD_DB_FINGERPRINT: productionFingerprint,
  })
  return result
}

function serializeEnv(env) {
  return `${Object.keys(env).sort().map((key) => `${key}=${JSON.stringify(String(env[key]))}`).join('\n')}\n`
}

function writePrivateFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content, { encoding: 'utf8', mode: 0o600 })
  fs.chmodSync(file, 0o600)
}

export function preparePreviewEnvironment(sourceEnvFile = DEFAULT_SOURCE_ENV) {
  const sourceEnv = readEnvFile(path.resolve(sourceEnvFile))
  const previewEnv = buildSanitizedEnvironment(sourceEnv)
  const sourceRoot = path.resolve(path.dirname(sourceEnvFile), '..')
  writePrivateFile(BACKEND_ENV_FILE, serializeEnv(previewEnv))
  writePrivateFile(FRONTEND_ENV_FILE, [
    'NEXT_PUBLIC_API_BASE_URL="http://localhost:4002"',
    'NEXT_PUBLIC_API_BASE_DEV="http://localhost:4002"',
    '',
  ].join('\n'))
  writePrivateFile(STATE_FILE, `${JSON.stringify({
    version: 1,
    environment: 'MZ-Dev-Preview',
    database_role: 'dev',
    database_fingerprint: previewEnv.MZ_DEV_PREVIEW_DATABASE_FINGERPRINT,
    production_fingerprint: previewEnv.MZ_DEV_PREVIEW_PROD_DB_FINGERPRINT,
    source_root: sourceRoot,
    prepared_at: new Date().toISOString(),
  }, null, 2)}\n`)
  return {
    fingerprint: previewEnv.MZ_DEV_PREVIEW_DATABASE_FINGERPRINT,
    sourceRoot,
  }
}

export function verifyPreparedEnvironment() {
  if (!fs.existsSync(STATE_FILE)) throw new Error('MZ-Dev-Preview database is not enrolled; run dev:preview:prepare')
  const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  if (state.environment !== 'MZ-Dev-Preview' || state.database_role !== 'dev') throw new Error('invalid MZ-Dev-Preview state file')
  const env = readEnvFile(BACKEND_ENV_FILE)
  const verified = assertDevDatabaseConfig(env, String(state.database_fingerprint || ''))
  if (verified.productionFingerprint !== state.production_fingerprint) throw new Error('production comparison identity changed; re-enrollment required')
  return { env, state, ...verified }
}

function safeErrorCode(error) {
  return String(error?.code || error?.name || 'UNKNOWN').replace(/[^A-Z0-9_-]/gi, '').slice(0, 64) || 'UNKNOWN'
}

async function openClient(env) {
  const require = createRequire(import.meta.url)
  const { Client } = require('../backend/node_modules/pg')
  const client = new Client({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 10000 })
  await client.connect()
  return client
}

async function readMigrationState(env, version = '') {
  const client = await openClient(env)
  try {
    await client.query('BEGIN READ ONLY')
    await client.query("SET LOCAL statement_timeout = '5s'")
    const registry = await client.query("SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present")
    if (!registry.rows?.[0]?.present) {
      await client.query('ROLLBACK')
      return { schemaMigrationsPresent: false, migrationApplied: version ? false : null }
    }
    const migrationApplied = version
      ? !!(await client.query('SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version=$1) AS applied', [version])).rows?.[0]?.applied
      : null
    await client.query('ROLLBACK')
    return { schemaMigrationsPresent: true, migrationApplied }
  } catch (error) {
    try { await client.query('ROLLBACK') } catch {}
    throw error
  } finally {
    await client.end().catch(() => undefined)
  }
}

async function applyMigration(env, file) {
  const migrationsDir = path.resolve(PREVIEW_ROOT, 'backend', 'scripts', 'migrations')
  const target = path.resolve(PREVIEW_ROOT, file)
  if (!target.startsWith(`${migrationsDir}${path.sep}`) || !target.endsWith('.sql')) {
    throw new Error('migration file must be an SQL file under backend/scripts/migrations')
  }
  if (!fs.existsSync(target)) throw new Error('migration file does not exist')
  const sql = fs.readFileSync(target, 'utf8')
  if (!/^BEGIN;[\s\S]*COMMIT;\s*$/m.test(sql)) throw new Error('migration must own an explicit transaction')
  const markerMatch = sql.match(/INSERT\s+INTO\s+schema_migrations\s*\(\s*version\s*\)\s*VALUES\s*\(\s*'([^']+)'\s*\)/i)
  if (!markerMatch) throw new Error('migration must record a schema_migrations version')
  const version = markerMatch[1]

  const before = await readMigrationState(env, version)
  if (before.migrationApplied) return { alreadyApplied: true, version }

  const client = await openClient(env)
  try {
    await client.query("SET statement_timeout = '45s'")
    await client.query("SET lock_timeout = '5s'")
    await client.query(sql)
  } finally {
    await client.end().catch(() => undefined)
  }
  const after = await readMigrationState(env, version)
  if (!after.migrationApplied) throw new Error('migration marker was not recorded')
  return { alreadyApplied: false, version }
}

const PREVIEW_BASELINE_MIGRATIONS = [
  'backend/scripts/migrations/20260902_r5_1_request_schema.sql',
  'backend/scripts/migrations/20260902_r5_2a_core_task_schema.sql',
  'backend/scripts/migrations/20260903_maintenance_runtime_schema.sql',
  'backend/scripts/migrations/20260910_r5_2b_property_guides_schema.sql',
]

function argValue(name) {
  const prefix = `${name}=`
  const found = process.argv.slice(3).find((value) => value.startsWith(prefix))
  return found ? found.slice(prefix.length) : ''
}

async function main() {
  const command = process.argv[2] || 'verify'
  if (command === 'prepare') {
    const source = argValue('--source-env') || process.env.MZ_DEV_PREVIEW_SOURCE_ENV || DEFAULT_SOURCE_ENV
    const result = preparePreviewEnvironment(source)
    console.log(`[MZ-Dev-Preview] prepared app=dev database=dev fingerprint=${result.fingerprint.slice(0, 12)} external_workers=disabled`)
    return
  }

  const verified = verifyPreparedEnvironment()
  if (command === 'verify') {
    const db = process.argv.includes('--connect') ? await readMigrationState(verified.env) : null
    console.log(`[MZ-Dev-Preview] verified app=dev database=dev fingerprint=${verified.currentFingerprint.slice(0, 12)}${db ? ` schema_registry=${db.schemaMigrationsPresent ? 'present' : 'missing'}` : ''}`)
    return
  }

  if (command === 'migrate-baseline') {
    if (!process.argv.includes('--apply')) throw new Error('migration refused without --apply')
    for (const file of PREVIEW_BASELINE_MIGRATIONS) {
      const result = await applyMigration(verified.env, file)
      console.log(`[MZ-Dev-Preview] migration=${result.version} result=${result.alreadyApplied ? 'already_applied' : 'applied'} database=dev fingerprint=${verified.currentFingerprint.slice(0, 12)}`)
    }
    return
  }

  if (command === 'migrate') {
    if (!process.argv.includes('--apply')) throw new Error('migration refused without --apply')
    const file = argValue('--file')
    if (!file) throw new Error('migration refused without explicit --file')
    const result = await applyMigration(verified.env, file)
    console.log(`[MZ-Dev-Preview] migration=${result.version} result=${result.alreadyApplied ? 'already_applied' : 'applied'} database=dev fingerprint=${verified.currentFingerprint.slice(0, 12)}`)
    return
  }

  throw new Error(`unknown command: ${command}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[MZ-Dev-Preview] refused code=${safeErrorCode(error)} reason=${String(error?.message || 'failed').replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted]')}`)
    process.exit(1)
  })
}
