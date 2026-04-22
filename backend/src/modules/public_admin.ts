import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { requirePerm } from '../auth'
import { hasPg, pgPool, pgSelect, pgUpdate, pgInsert } from '../dbAdapter'
import { decryptPublicAccessPassword, encryptPublicAccessPassword, hasPublicAccessPasswordKey } from '../lib/publicPasswordCrypto'

export const router = Router()

async function ensurePublicAccessTable() {
  if (!pgPool) return
  await pgPool.query(`CREATE TABLE IF NOT EXISTS public_access (
    area text PRIMARY KEY,
    password_hash text NOT NULL,
    password_enc text,
    password_updated_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz DEFAULT now()
  );`)
  try { await pgPool.query(`ALTER TABLE public_access ADD COLUMN IF NOT EXISTS password_enc text;`) } catch {}
}

async function clearPublicAccess(area: string) {
  if (!pgPool) return
  await ensurePublicAccessTable()
  await pgPool.query('DELETE FROM public_access WHERE area=$1', [area])
}

function forbidMaintenanceStaff(req: any) {
  try {
    const user = req?.user
    if (user && String(user.role || '') === 'maintenance_staff') return true
  } catch {}
  return false
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

router.get('/cleaning-guide/current-password', requirePerm('rbac.manage'), async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  try {
    if (hasPg) {
      await ensurePublicAccessTable()
      const rows = await pgSelect('public_access', '*', { area: 'cleaning' }) as any[]
      const r = rows && rows[0]
      if (!r) return res.json({ configured: false, password: null, password_updated_at: null })
      const enc = String(r?.password_enc || '')
      if (!enc) return res.json({ configured: true, password: null, password_updated_at: r?.password_updated_at || null, reason: hasPublicAccessPasswordKey() ? 'missing_enc' : 'missing_key' })
      const plain = decryptPublicAccessPassword(enc)
      if (!plain) return res.json({ configured: true, password: null, password_updated_at: r?.password_updated_at || null, reason: 'missing_key' })
      return res.json({ configured: true, password: plain, password_updated_at: r?.password_updated_at || null })
    }
    return res.json({ configured: false, password: null, password_updated_at: null })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.get('/maintenance-share/password-info', requirePerm('rbac.manage'), async (_req, res) => {
  try {
    if (hasPg) {
      await ensurePublicAccessTable()
      const rows = await pgSelect('public_access', '*', { area: 'maintenance_share' }) as any[]
      const r = rows && rows[0]
      return res.json({ configured: !!r, password_updated_at: r?.password_updated_at || null })
    }
    return res.json({ configured: false, password_updated_at: null })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.get('/maintenance-share/current-password', requirePerm('rbac.manage'), async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  if (forbidMaintenanceStaff(req as any)) return res.status(403).json({ message: 'forbidden' })
  try {
    if (hasPg) {
      await ensurePublicAccessTable()
      const rows = await pgSelect('public_access', '*', { area: 'maintenance_share' }) as any[]
      const r = rows && rows[0]
      if (!r) return res.json({ configured: false, password: null, password_updated_at: null })
      const enc = String(r?.password_enc || '')
      if (!enc) return res.json({ configured: true, password: null, password_updated_at: r?.password_updated_at || null, reason: hasPublicAccessPasswordKey() ? 'missing_enc' : 'missing_key' })
      const plain = decryptPublicAccessPassword(enc)
      if (!plain) return res.json({ configured: true, password: null, password_updated_at: r?.password_updated_at || null, reason: 'missing_key' })
      return res.json({ configured: true, password: plain, password_updated_at: r?.password_updated_at || null })
    }
    return res.json({ configured: false, password: null, password_updated_at: null })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.get('/deep-cleaning-share/password-info', requirePerm('rbac.manage'), async (_req, res) => {
  try {
    if (hasPg) {
      await ensurePublicAccessTable()
      const rows = await pgSelect('public_access', '*', { area: 'deep_cleaning_share' }) as any[]
      const r = rows && rows[0]
      return res.json({ configured: !!r, password_updated_at: r?.password_updated_at || null })
    }
    return res.json({ configured: false, password_updated_at: null })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.get('/deep-cleaning-share/current-password', requirePerm('rbac.manage'), async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  if (forbidMaintenanceStaff(req as any)) return res.status(403).json({ message: 'forbidden' })
  try {
    if (hasPg) {
      await ensurePublicAccessTable()
      const rows = await pgSelect('public_access', '*', { area: 'deep_cleaning_share' }) as any[]
      const r = rows && rows[0]
      if (!r) return res.json({ configured: false, password: null, password_updated_at: null })
      const enc = String(r?.password_enc || '')
      if (!enc) return res.json({ configured: true, password: null, password_updated_at: r?.password_updated_at || null, reason: hasPublicAccessPasswordKey() ? 'missing_enc' : 'missing_key' })
      const plain = decryptPublicAccessPassword(enc)
      if (!plain) return res.json({ configured: true, password: null, password_updated_at: r?.password_updated_at || null, reason: 'missing_key' })
      return res.json({ configured: true, password: plain, password_updated_at: r?.password_updated_at || null })
    }
    return res.json({ configured: false, password: null, password_updated_at: null })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.get('/deep-cleaning-upload/password-info', requirePerm('rbac.manage'), async (_req, res) => {
  try {
    if (hasPg) {
      await ensurePublicAccessTable()
      const rows = await pgSelect('public_access', '*', { area: 'deep_cleaning_upload' }) as any[]
      const r = rows && rows[0]
      return res.json({ configured: !!r, password_updated_at: r?.password_updated_at || null })
    }
    return res.json({ configured: false, password_updated_at: null })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.get('/deep-cleaning-upload/current-password', requirePerm('rbac.manage'), async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  try {
    if (hasPg) {
      await ensurePublicAccessTable()
      const rows = await pgSelect('public_access', '*', { area: 'deep_cleaning_upload' }) as any[]
      const r = rows && rows[0]
      if (!r) return res.json({ configured: false, password: null, password_updated_at: null })
      const enc = String(r?.password_enc || '')
      if (!enc) return res.json({ configured: true, password: null, password_updated_at: r?.password_updated_at || null, reason: hasPublicAccessPasswordKey() ? 'missing_enc' : 'missing_key' })
      const plain = decryptPublicAccessPassword(enc)
      if (!plain) return res.json({ configured: true, password: null, password_updated_at: r?.password_updated_at || null, reason: 'missing_key' })
      return res.json({ configured: true, password: plain, password_updated_at: r?.password_updated_at || null })
    }
    return res.json({ configured: false, password: null, password_updated_at: null })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.get('/maintenance-progress/password-info', requirePerm('rbac.manage'), async (_req, res) => {
  try {
    if (hasPg) {
      await ensurePublicAccessTable()
      const rows = await pgSelect('public_access', '*', { area: 'maintenance_share' }) as any[]
      const r = rows && rows[0]
      return res.json({ configured: !!r, password_updated_at: r?.password_updated_at || null })
    }
    return res.json({ configured: false, password_updated_at: null })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.get('/maintenance-progress/current-password', requirePerm('rbac.manage'), async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  try {
    if (hasPg) {
      await ensurePublicAccessTable()
      const rows = await pgSelect('public_access', '*', { area: 'maintenance_share' }) as any[]
      const r = rows && rows[0]
      if (!r) return res.json({ configured: false, password: null, password_updated_at: null })
      const enc = String(r?.password_enc || '')
      if (!enc) return res.json({ configured: true, password: null, password_updated_at: r?.password_updated_at || null, reason: hasPublicAccessPasswordKey() ? 'missing_enc' : 'missing_key' })
      const plain = decryptPublicAccessPassword(enc)
      if (!plain) return res.json({ configured: true, password: null, password_updated_at: r?.password_updated_at || null, reason: 'missing_key' })
      return res.json({ configured: true, password: plain, password_updated_at: r?.password_updated_at || null })
    }
    return res.json({ configured: false, password: null, password_updated_at: null })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.get('/company-expense/password-info', requirePerm('rbac.manage'), async (_req, res) => {
  try {
    if (hasPg) {
      await ensurePublicAccessTable()
      const rows = await pgSelect('public_access', '*', { area: 'company_expense' }) as any[]
      const r = rows && rows[0]
      return res.json({ configured: !!r, password_updated_at: r?.password_updated_at || null })
    }
    return res.json({ configured: false, password_updated_at: null })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.get('/company-expense/current-password', requirePerm('rbac.manage'), async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  if (forbidMaintenanceStaff(req as any)) return res.status(403).json({ message: 'forbidden' })
  try {
    if (hasPg) {
      await ensurePublicAccessTable()
      const rows = await pgSelect('public_access', '*', { area: 'company_expense' }) as any[]
      const r = rows && rows[0]
      if (!r) return res.json({ configured: false, password: null, password_updated_at: null })
      const enc = String(r?.password_enc || '')
      if (!enc) return res.json({ configured: true, password: null, password_updated_at: r?.password_updated_at || null, reason: hasPublicAccessPasswordKey() ? 'missing_enc' : 'missing_key' })
      const plain = decryptPublicAccessPassword(enc)
      if (!plain) return res.json({ configured: true, password: null, password_updated_at: r?.password_updated_at || null, reason: 'missing_key' })
      return res.json({ configured: true, password: plain, password_updated_at: r?.password_updated_at || null })
    }
    return res.json({ configured: false, password: null, password_updated_at: null })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.get('/property-expense/password-info', requirePerm('rbac.manage'), async (_req, res) => {
  try {
    if (hasPg) {
      await ensurePublicAccessTable()
      const rows = await pgSelect('public_access', '*', { area: 'property_expense' }) as any[]
      const r = rows && rows[0]
      return res.json({ configured: !!r, password_updated_at: r?.password_updated_at || null })
    }
    return res.json({ configured: false, password_updated_at: null })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.get('/property-expense/current-password', requirePerm('rbac.manage'), async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  if (forbidMaintenanceStaff(req as any)) return res.status(403).json({ message: 'forbidden' })
  try {
    if (hasPg) {
      await ensurePublicAccessTable()
      const rows = await pgSelect('public_access', '*', { area: 'property_expense' }) as any[]
      const r = rows && rows[0]
      if (!r) return res.json({ configured: false, password: null, password_updated_at: null })
      const enc = String(r?.password_enc || '')
      if (!enc) return res.json({ configured: true, password: null, password_updated_at: r?.password_updated_at || null, reason: hasPublicAccessPasswordKey() ? 'missing_enc' : 'missing_key' })
      const plain = decryptPublicAccessPassword(enc)
      if (!plain) return res.json({ configured: true, password: null, password_updated_at: r?.password_updated_at || null, reason: 'missing_key' })
      return res.json({ configured: true, password: plain, password_updated_at: r?.password_updated_at || null })
    }
    return res.json({ configured: false, password: null, password_updated_at: null })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.get('/property-guide/password-info', requirePerm('rbac.manage'), async (_req, res) => {
  try {
    if (hasPg) {
      await ensurePublicAccessTable()
      const rows = await pgSelect('public_access', '*', { area: 'property_guide' }) as any[]
      const r = rows && rows[0]
      return res.json({ configured: !!r, password_updated_at: r?.password_updated_at || null })
    }
    return res.json({ configured: false, password_updated_at: null })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.get('/property-guide/current-password', requirePerm('rbac.manage'), async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  try {
    if (hasPg) {
      await ensurePublicAccessTable()
      const rows = await pgSelect('public_access', '*', { area: 'property_guide' }) as any[]
      const r = rows && rows[0]
      if (!r) return res.json({ configured: false, password: null, password_updated_at: null })
      const enc = String(r?.password_enc || '')
      if (!enc) return res.json({ configured: true, password: null, password_updated_at: r?.password_updated_at || null, reason: hasPublicAccessPasswordKey() ? 'missing_enc' : 'missing_key' })
      const plain = decryptPublicAccessPassword(enc)
      if (!plain) return res.json({ configured: true, password: null, password_updated_at: r?.password_updated_at || null, reason: 'missing_key' })
      return res.json({ configured: true, password: plain, password_updated_at: r?.password_updated_at || null })
    }
    return res.json({ configured: false, password: null, password_updated_at: null })
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
      const enc = encryptPublicAccessPassword(String(new_password))
      const rows = await pgSelect('public_access', '*', { area: 'cleaning' }) as any[]
      const existing = rows && rows[0]
      const now = new Date().toISOString()
      if (existing) {
        await pgPool!.query('UPDATE public_access SET password_hash=$1, password_enc=$2, password_updated_at=$3 WHERE area=$4', [hash, enc, now, 'cleaning'])
      } else {
        await pgInsert('public_access', { area: 'cleaning', password_hash: hash, password_enc: enc, password_updated_at: now })
      }
      res.setHeader('Cache-Control', 'no-store')
      return res.json({ ok: true, password: String(new_password), stored: !!enc, reason: enc ? undefined : 'missing_key' })
    }
    return res.status(500).json({ message: 'no database configured' })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'reset failed' })
  }
})

router.post('/maintenance-share/reset-password', requirePerm('rbac.manage'), async (req, res) => {
  const { new_password } = req.body || {}
  if (!new_password) return res.status(400).json({ message: 'missing new_password' })
  try {
    const user = (req as any).user
    if (user && String(user.role || '') === 'maintenance_staff') return res.status(403).json({ message: 'forbidden' })
  } catch {}
  try {
    if (hasPg) {
      await ensurePublicAccessTable()
      const hash = await bcrypt.hash(String(new_password), 10)
      const enc = encryptPublicAccessPassword(String(new_password))
      const rows = await pgSelect('public_access', '*', { area: 'maintenance_share' }) as any[]
      const existing = rows && rows[0]
      const now = new Date().toISOString()
      if (existing) {
        await pgPool!.query('UPDATE public_access SET password_hash=$1, password_enc=$2, password_updated_at=$3 WHERE area=$4', [hash, enc, now, 'maintenance_share'])
      } else {
        await pgInsert('public_access', { area: 'maintenance_share', password_hash: hash, password_enc: enc, password_updated_at: now })
      }
      res.setHeader('Cache-Control', 'no-store')
      return res.json({ ok: true, password: String(new_password), stored: !!enc, reason: enc ? undefined : 'missing_key' })
    }
    return res.status(500).json({ message: 'no database configured' })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'reset failed' })
  }
})

router.post('/deep-cleaning-share/reset-password', requirePerm('rbac.manage'), async (req, res) => {
  const { new_password } = req.body || {}
  if (!new_password) return res.status(400).json({ message: 'missing new_password' })
  try {
    const user = (req as any).user
    if (user && String(user.role || '') === 'maintenance_staff') return res.status(403).json({ message: 'forbidden' })
  } catch {}
  try {
    if (hasPg) {
      await ensurePublicAccessTable()
      const hash = await bcrypt.hash(String(new_password), 10)
      const enc = encryptPublicAccessPassword(String(new_password))
      const rows = await pgSelect('public_access', '*', { area: 'deep_cleaning_share' }) as any[]
      const existing = rows && rows[0]
      const now = new Date().toISOString()
      if (existing) {
        await pgPool!.query('UPDATE public_access SET password_hash=$1, password_enc=$2, password_updated_at=$3 WHERE area=$4', [hash, enc, now, 'deep_cleaning_share'])
      } else {
        await pgInsert('public_access', { area: 'deep_cleaning_share', password_hash: hash, password_enc: enc, password_updated_at: now })
      }
      res.setHeader('Cache-Control', 'no-store')
      return res.json({ ok: true, password: String(new_password), stored: !!enc, reason: enc ? undefined : 'missing_key' })
    }
    return res.status(500).json({ message: 'no database configured' })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'reset failed' })
  }
})

router.post('/deep-cleaning-upload/reset-password', requirePerm('rbac.manage'), async (req, res) => {
  const { new_password } = req.body || {}
  if (!new_password) return res.status(400).json({ message: 'missing new_password' })
  try {
    const user = (req as any).user
    if (user && String(user.role || '') === 'maintenance_staff') return res.status(403).json({ message: 'forbidden' })
  } catch {}
  try {
    if (hasPg) {
      await ensurePublicAccessTable()
      const hash = await bcrypt.hash(String(new_password), 10)
      const enc = encryptPublicAccessPassword(String(new_password))
      const rows = await pgSelect('public_access', '*', { area: 'deep_cleaning_upload' }) as any[]
      const existing = rows && rows[0]
      const now = new Date().toISOString()
      if (existing) {
        await pgPool!.query('UPDATE public_access SET password_hash=$1, password_enc=$2, password_updated_at=$3 WHERE area=$4', [hash, enc, now, 'deep_cleaning_upload'])
      } else {
        await pgInsert('public_access', { area: 'deep_cleaning_upload', password_hash: hash, password_enc: enc, password_updated_at: now })
      }
      res.setHeader('Cache-Control', 'no-store')
      return res.json({ ok: true, password: String(new_password), stored: !!enc, reason: enc ? undefined : 'missing_key' })
    }
    return res.status(500).json({ message: 'no database configured' })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'reset failed' })
  }
})

router.post('/maintenance-progress/reset-password', requirePerm('rbac.manage'), async (req, res) => {
  const { new_password } = req.body || {}
  if (!new_password) return res.status(400).json({ message: 'missing new_password' })
  if (forbidMaintenanceStaff(req as any)) return res.status(403).json({ message: 'forbidden' })
  try {
    if (hasPg) {
      await ensurePublicAccessTable()
      const hash = await bcrypt.hash(String(new_password), 10)
      const enc = encryptPublicAccessPassword(String(new_password))
      const rows = await pgSelect('public_access', '*', { area: 'maintenance_share' }) as any[]
      const existing = rows && rows[0]
      const now = new Date().toISOString()
      if (existing) {
        await pgPool!.query('UPDATE public_access SET password_hash=$1, password_enc=$2, password_updated_at=$3 WHERE area=$4', [hash, enc, now, 'maintenance_share'])
      } else {
        await pgInsert('public_access', { area: 'maintenance_share', password_hash: hash, password_enc: enc, password_updated_at: now })
      }
      res.setHeader('Cache-Control', 'no-store')
      return res.json({ ok: true, password: String(new_password), stored: !!enc, reason: enc ? undefined : 'missing_key' })
    }
    return res.status(500).json({ message: 'no database configured' })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'reset failed' })
  }
})

router.post('/company-expense/reset-password', requirePerm('rbac.manage'), async (req, res) => {
  const { new_password } = req.body || {}
  if (!new_password) return res.status(400).json({ message: 'missing new_password' })
  if (forbidMaintenanceStaff(req as any)) return res.status(403).json({ message: 'forbidden' })
  try {
    if (hasPg) {
      await ensurePublicAccessTable()
      const hash = await bcrypt.hash(String(new_password), 10)
      const enc = encryptPublicAccessPassword(String(new_password))
      const rows = await pgSelect('public_access', '*', { area: 'company_expense' }) as any[]
      const existing = rows && rows[0]
      const now = new Date().toISOString()
      if (existing) {
        await pgPool!.query('UPDATE public_access SET password_hash=$1, password_enc=$2, password_updated_at=$3 WHERE area=$4', [hash, enc, now, 'company_expense'])
      } else {
        await pgInsert('public_access', { area: 'company_expense', password_hash: hash, password_enc: enc, password_updated_at: now })
      }
      res.setHeader('Cache-Control', 'no-store')
      return res.json({ ok: true, password: String(new_password), stored: !!enc, reason: enc ? undefined : 'missing_key' })
    }
    return res.status(500).json({ message: 'no database configured' })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'reset failed' })
  }
})

router.post('/property-expense/reset-password', requirePerm('rbac.manage'), async (req, res) => {
  const { new_password } = req.body || {}
  if (!new_password) return res.status(400).json({ message: 'missing new_password' })
  if (forbidMaintenanceStaff(req as any)) return res.status(403).json({ message: 'forbidden' })
  try {
    if (hasPg) {
      await ensurePublicAccessTable()
      const hash = await bcrypt.hash(String(new_password), 10)
      const enc = encryptPublicAccessPassword(String(new_password))
      const rows = await pgSelect('public_access', '*', { area: 'property_expense' }) as any[]
      const existing = rows && rows[0]
      const now = new Date().toISOString()
      if (existing) {
        await pgPool!.query('UPDATE public_access SET password_hash=$1, password_enc=$2, password_updated_at=$3 WHERE area=$4', [hash, enc, now, 'property_expense'])
      } else {
        await pgInsert('public_access', { area: 'property_expense', password_hash: hash, password_enc: enc, password_updated_at: now })
      }
      res.setHeader('Cache-Control', 'no-store')
      return res.json({ ok: true, password: String(new_password), stored: !!enc, reason: enc ? undefined : 'missing_key' })
    }
    return res.status(500).json({ message: 'no database configured' })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'reset failed' })
  }
})

router.post('/property-guide/reset-password', requirePerm('rbac.manage'), async (req, res) => {
  const { new_password } = req.body || {}
  const pwd = String(new_password || '')
  if (!pwd) return res.status(400).json({ message: 'missing new_password' })
  if (!/^\d{4,6}$/.test(pwd)) return res.status(400).json({ message: 'new_password must be 4-6 digits' })
  if (forbidMaintenanceStaff(req as any)) return res.status(403).json({ message: 'forbidden' })
  try {
    if (hasPg) {
      await ensurePublicAccessTable()
      const hash = await bcrypt.hash(pwd, 10)
      const enc = encryptPublicAccessPassword(pwd)
      const rows = await pgSelect('public_access', '*', { area: 'property_guide' }) as any[]
      const existing = rows && rows[0]
      const now = new Date().toISOString()
      if (existing) {
        await pgPool!.query('UPDATE public_access SET password_hash=$1, password_enc=$2, password_updated_at=$3 WHERE area=$4', [hash, enc, now, 'property_guide'])
      } else {
        await pgInsert('public_access', { area: 'property_guide', password_hash: hash, password_enc: enc, password_updated_at: now })
      }
      res.setHeader('Cache-Control', 'no-store')
      return res.json({ ok: true, password: pwd, stored: !!enc, reason: enc ? undefined : 'missing_key' })
    }
    return res.status(500).json({ message: 'no database configured' })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'reset failed' })
  }
})

router.post('/cleaning-guide/clear-password', requirePerm('rbac.manage'), async (_req, res) => {
  try {
    if (hasPg) { await clearPublicAccess('cleaning'); return res.json({ ok: true }) }
    return res.status(500).json({ message: 'no database configured' })
  } catch (e: any) { return res.status(500).json({ message: e?.message || 'clear failed' }) }
})

router.post('/maintenance-share/clear-password', requirePerm('rbac.manage'), async (req, res) => {
  try { if (forbidMaintenanceStaff(req as any)) return res.status(403).json({ message: 'forbidden' }) } catch {}
  try {
    if (hasPg) { await clearPublicAccess('maintenance_share'); return res.json({ ok: true }) }
    return res.status(500).json({ message: 'no database configured' })
  } catch (e: any) { return res.status(500).json({ message: e?.message || 'clear failed' }) }
})

router.post('/maintenance-progress/clear-password', requirePerm('rbac.manage'), async (req, res) => {
  try { if (forbidMaintenanceStaff(req as any)) return res.status(403).json({ message: 'forbidden' }) } catch {}
  try {
    if (hasPg) { await clearPublicAccess('maintenance_share'); return res.json({ ok: true }) }
    return res.status(500).json({ message: 'no database configured' })
  } catch (e: any) { return res.status(500).json({ message: e?.message || 'clear failed' }) }
})

router.post('/deep-cleaning-share/clear-password', requirePerm('rbac.manage'), async (req, res) => {
  try { if (forbidMaintenanceStaff(req as any)) return res.status(403).json({ message: 'forbidden' }) } catch {}
  try {
    if (hasPg) { await clearPublicAccess('deep_cleaning_share'); return res.json({ ok: true }) }
    return res.status(500).json({ message: 'no database configured' })
  } catch (e: any) { return res.status(500).json({ message: e?.message || 'clear failed' }) }
})

router.post('/deep-cleaning-upload/clear-password', requirePerm('rbac.manage'), async (req, res) => {
  try { if (forbidMaintenanceStaff(req as any)) return res.status(403).json({ message: 'forbidden' }) } catch {}
  try {
    if (hasPg) { await clearPublicAccess('deep_cleaning_upload'); return res.json({ ok: true }) }
    return res.status(500).json({ message: 'no database configured' })
  } catch (e: any) { return res.status(500).json({ message: e?.message || 'clear failed' }) }
})

router.post('/company-expense/clear-password', requirePerm('rbac.manage'), async (req, res) => {
  try { if (forbidMaintenanceStaff(req as any)) return res.status(403).json({ message: 'forbidden' }) } catch {}
  try {
    if (hasPg) { await clearPublicAccess('company_expense'); return res.json({ ok: true }) }
    return res.status(500).json({ message: 'no database configured' })
  } catch (e: any) { return res.status(500).json({ message: e?.message || 'clear failed' }) }
})

router.post('/property-expense/clear-password', requirePerm('rbac.manage'), async (req, res) => {
  try { if (forbidMaintenanceStaff(req as any)) return res.status(403).json({ message: 'forbidden' }) } catch {}
  try {
    if (hasPg) { await clearPublicAccess('property_expense'); return res.json({ ok: true }) }
    return res.status(500).json({ message: 'no database configured' })
  } catch (e: any) { return res.status(500).json({ message: e?.message || 'clear failed' }) }
})

router.post('/property-guide/clear-password', requirePerm('rbac.manage'), async (req, res) => {
  try { if (forbidMaintenanceStaff(req as any)) return res.status(403).json({ message: 'forbidden' }) } catch {}
  try {
    if (hasPg) { await clearPublicAccess('property_guide'); return res.json({ ok: true }) }
    return res.status(500).json({ message: 'no database configured' })
  } catch (e: any) { return res.status(500).json({ message: e?.message || 'clear failed' }) }
})

export default router
