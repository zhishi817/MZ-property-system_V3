import crypto from 'crypto'
import { hasPg, pgSelect } from './dbAdapter'

export function hashFingerprint(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex')
}

export async function setFingerprint(key: string, ttlSec: number): Promise<boolean> {
  const expireAt = new Date(Date.now() + Math.max(1000, ttlSec * 1000)).toISOString()
  try {
    const Redis = require('ioredis')
    const url = process.env.REDIS_URL || 'redis://localhost:6379'
    const redis = new Redis(url)
    const ok = await redis.set(key, '1', 'EX', Math.max(1, ttlSec), 'NX')
    try { await redis.quit() } catch {}
    if (ok === 'OK') return true
  } catch {}
  try {
    if (hasPg) {
      const { pgPool } = require('./dbAdapter')
      await pgPool!.query(`CREATE TABLE IF NOT EXISTS expense_fingerprints (
        key text PRIMARY KEY,
        expire_at timestamptz NOT NULL,
        created_at timestamptz DEFAULT now()
      )`)
      await pgPool!.query(`INSERT INTO expense_fingerprints(key, expire_at)
        VALUES($1, $2)
        ON CONFLICT (key) DO UPDATE SET expire_at = EXCLUDED.expire_at`, [key, expireAt])
      return true
    }
  } catch {}
  return false
}

export async function hasFingerprint(key: string): Promise<boolean> {
  try {
    const Redis = require('ioredis')
    const url = process.env.REDIS_URL || 'redis://localhost:6379'
    const redis = new Redis(url)
    const exists = await redis.exists(key)
    try { await redis.quit() } catch {}
    return !!exists
  } catch {}
  try {
    if (hasPg) {
      const { pgPool } = require('./dbAdapter')
      await pgPool!.query(`CREATE TABLE IF NOT EXISTS expense_fingerprints (
        key text PRIMARY KEY,
        expire_at timestamptz NOT NULL,
        created_at timestamptz DEFAULT now()
      )`)
      const rs = await pgPool!.query('SELECT 1 FROM expense_fingerprints WHERE key=$1 AND expire_at > now() LIMIT 1', [key])
      return !!rs.rowCount
    }
  } catch {}
  return false
}

export function buildExpenseFingerprint(payload: any, mode: 'exact'|'fuzzy' = 'exact'): string {
  const pid = String(payload?.property_id || '')
  const tenant = String(payload?.tenant_id || '')
  const cat = String(payload?.category || '')
  const amt = Number(payload?.amount || 0)
  const note = String(payload?.note || '').trim().toLowerCase()
  let dateKey = ''
  try {
    const d = new Date(String(payload?.paid_date || payload?.occurred_at || ''))
    dateKey = isFinite(d.getTime()) ? d.toISOString().slice(0,10) : ''
  } catch {}
  const monthKey = dateKey ? dateKey.slice(0,7) : String(payload?.month_key || '')
  const baseAmt = mode === 'exact' ? amt : Number((Math.round(amt * 2) / 2).toFixed(2))
  const baseNote = mode === 'exact' ? note : note.replace(/\s+/g,' ').replace(/[^a-z0-9\s]/g,'').slice(0,64)
  const raw = `pe|${pid}|${tenant}|${cat}|${baseAmt}|${monthKey}|${dateKey}|${baseNote}`
  return 'pe:' + hashFingerprint(raw)
}

export async function addDedupLog(row: { resource: string; resource_id?: string; fingerprint: string; mode: 'exact'|'fuzzy'; result: 'hit'|'miss'|'locked'|'error'; operator_id?: string; reasons?: string[]; latency_ms?: number }) {
  try {
    const { v4: uuid } = require('uuid')
    const payload = { id: uuid(), ...row, created_at: new Date().toISOString() }
    if (hasPg) {
      const { pgPool } = require('./dbAdapter')
      await pgPool!.query(`CREATE TABLE IF NOT EXISTS expense_dedup_logs (
        id text PRIMARY KEY,
        resource text NOT NULL,
        resource_id text,
        fingerprint text,
        mode text,
        result text,
        operator_id text,
        reasons text[],
        latency_ms integer,
        created_at timestamptz DEFAULT now()
      )`)
      await pgPool!.query('INSERT INTO expense_dedup_logs(id, resource, resource_id, fingerprint, mode, result, operator_id, reasons, latency_ms) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [payload.id, payload.resource, payload.resource_id || null, payload.fingerprint, payload.mode, payload.result, payload.operator_id || null, payload.reasons || [], payload.latency_ms || null])
      return
    }
  } catch {}
}
