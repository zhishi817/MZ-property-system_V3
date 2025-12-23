import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { requirePerm } from '../auth'
import { hasPg, pgPool, pgSelect, pgUpdate, pgInsert } from '../dbAdapter'

export const router = Router()

async function ensurePublicAccessTable() {
  if (!pgPool) return
  await pgPool.query(`CREATE TABLE IF NOT EXISTS public_access (
    area text PRIMARY KEY,
    password_hash text NOT NULL,
    password_updated_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz DEFAULT now()
  );`)
}

router.get('/cleaning-guide/password-info', requirePerm('rbac.manage'), async (_req, res) => {
  try {
    if (hasPg) {
      await ensurePublicAccessTable()
      const rows = await pgSelect('public_access', '*', { area: 'cleaning' }) as any[]
      const r = rows && rows[0]
      return res.json({ configured: !!r, password_updated_at: r?.password_updated_at || null })
    }
    return res.json({ configured: false, password_updated_at: null })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.post('/cleaning-guide/reset-password', requirePerm('rbac.manage'), async (req, res) => {
  const { new_password } = req.body || {}
  if (!new_password) return res.status(400).json({ message: 'missing new_password' })
  try {
    if (hasPg) {
      await ensurePublicAccessTable()
      const hash = await bcrypt.hash(String(new_password), 10)
      const rows = await pgSelect('public_access', '*', { area: 'cleaning' }) as any[]
      const existing = rows && rows[0]
      const now = new Date().toISOString()
      if (existing) {
        await pgUpdate('public_access', 'cleaning', { password_hash: hash, password_updated_at: now } as any)
      } else {
        await pgInsert('public_access', { area: 'cleaning', password_hash: hash, password_updated_at: now })
      }
      return res.json({ ok: true })
    }
    return res.status(500).json({ message: 'no database configured' })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'reset failed' })
  }
})

export default router