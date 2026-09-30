import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertDevDatabaseConfig,
  buildSanitizedEnvironment,
  databaseIdentityFingerprint,
  parseEnvText,
} from '../dev-preview-db.mjs'
import {
  buildDenyHook,
  GIT_GUARD_MARKER,
} from '../dev-preview-git-guard.mjs'

const devUrl = 'postgresql://dev_user:dev_password@dev.example.invalid/dev_db?sslmode=require'
const prodUrl = 'postgresql://prod_user:prod_password@prod.example.invalid/prod_db?sslmode=require'

const source = {
  APP_ENV: 'dev',
  DATABASE_ROLE: 'dev',
  NODE_ENV: 'development',
  DATABASE_URL: devUrl,
  DATABASE_URL_PROD: prodUrl,
  R2_SECRET_ACCESS_KEY: 'must-not-survive',
  SMTP_PASSWORD: 'must-not-survive',
  AIRBNB_IMAP_PASS: 'must-not-survive',
  REDIS_URL: 'redis://must-not-survive.example.invalid',
  ALERT_WEBHOOK_URL: 'https://must-not-survive.example.invalid',
  VERCEL_PROTECTION_BYPASS_SECRET: 'must-not-survive',
  NOTIFICATION_WORKER_ENABLED: 'true',
  CLEANING_SYNC_JOBS_ENABLED: 'true',
}

const verified = assertDevDatabaseConfig(source)
assert.equal(verified.currentFingerprint, databaseIdentityFingerprint(devUrl))
assert.notEqual(verified.currentFingerprint, verified.productionFingerprint)

assert.throws(() => assertDevDatabaseConfig({ ...source, APP_ENV: 'prod' }), /APP_ENV/)
assert.throws(() => assertDevDatabaseConfig({ ...source, DATABASE_ROLE: 'prod' }), /DATABASE_ROLE/)
assert.throws(() => assertDevDatabaseConfig({ ...source, DATABASE_URL: prodUrl }), /production database identity/)
assert.throws(() => assertDevDatabaseConfig({ ...source, DATABASE_URL_PROD: '' }), /production database identity/)
assert.throws(() => assertDevDatabaseConfig(source, databaseIdentityFingerprint(prodUrl)), /differs from enrolled/)

const sanitized = buildSanitizedEnvironment(source)
assert.equal(sanitized.MZ_DEV_PREVIEW, '1')
assert.equal(sanitized.APP_ENV, 'dev')
assert.equal(sanitized.DATABASE_ROLE, 'dev')
assert.equal(sanitized.PORT_OVERRIDE, '4002')
assert.equal(sanitized.NOTIFICATION_WORKER_ENABLED, 'false')
assert.equal(sanitized.CLEANING_SYNC_JOBS_ENABLED, 'false')
assert.equal(sanitized.EMAIL_SYNC_SCHEDULE_ENABLED, 'false')
assert.equal(sanitized.R2_SECRET_ACCESS_KEY, undefined)
assert.equal(sanitized.SMTP_PASSWORD, undefined)
assert.equal(sanitized.AIRBNB_IMAP_PASS, undefined)
assert.equal(sanitized.REDIS_URL, undefined)
assert.equal(sanitized.ALERT_WEBHOOK_URL, undefined)
assert.equal(sanitized.VERCEL_PROTECTION_BYPASS_SECRET, undefined)
assert.equal(sanitized.DATABASE_URL_PROD, undefined)
assert.equal(sanitized.MZ_DEV_PREVIEW_DATABASE_FINGERPRINT, databaseIdentityFingerprint(devUrl))

assert.deepEqual(parseEnvText('A=1\nB="two"\n# ignored\n'), { A: '1', B: 'two' })

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const databaseGuardSource = fs.readFileSync(path.resolve(scriptDir, '..', 'dev-preview-db.mjs'), 'utf8')
assert.doesNotMatch(databaseGuardSource, /personnel_settlement|settlements/i)

const gitGuardHook = buildDenyHook(['/preview/root', '/preview/mobile'])
assert.match(gitGuardHook, /^#!\/bin\/sh/)
assert.match(gitGuardHook, /\/preview\/root/)
assert.match(gitGuardHook, /\/preview\/mobile/)
assert.match(gitGuardHook, /case "\$worktree" in/)
assert.match(gitGuardHook, new RegExp(GIT_GUARD_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
assert.match(gitGuardHook, /separate clean release candidate worktree/)
assert.doesNotMatch(gitGuardHook, /personnel_settlement|settlements/i)

console.log('dev preview database and Git guard: PASS')
