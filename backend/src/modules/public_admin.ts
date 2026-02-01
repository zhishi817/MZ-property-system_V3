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
        await pgPool!.query('UPDATE public_access SET password_hash=$1, password_updated_at=$2 WHERE area=$3', [hash, now, 'cleaning'])
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
      const rows = await pgSelect('public_access', '*', { area: 'maintenance_share' }) as any[]
      const existing = rows && rows[0]
      const now = new Date().toISOString()
      if (existing) {
        await pgPool!.query('UPDATE public_access SET password_hash=$1, password_updated_at=$2 WHERE area=$3', [hash, now, 'maintenance_share'])
      } else {
        await pgInsert('public_access', { area: 'maintenance_share', password_hash: hash, password_updated_at: now })
      }
      return res.json({ ok: true })
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
      const rows = await pgSelect('public_access', '*', { area: 'deep_cleaning_share' }) as any[]
      const existing = rows && rows[0]
      const now = new Date().toISOString()
      if (existing) {
        await pgPool!.query('UPDATE public_access SET password_hash=$1, password_updated_at=$2 WHERE area=$3', [hash, now, 'deep_cleaning_share'])
      } else {
        await pgInsert('public_access', { area: 'deep_cleaning_share', password_hash: hash, password_updated_at: now })
      }
      return res.json({ ok: true })
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
      const rows = await pgSelect('public_access', '*', { area: 'deep_cleaning_upload' }) as any[]
      const existing = rows && rows[0]
      const now = new Date().toISOString()
      if (existing) {
        await pgPool!.query('UPDATE public_access SET password_hash=$1, password_updated_at=$2 WHERE area=$3', [hash, now, 'deep_cleaning_upload'])
      } else {
        await pgInsert('public_access', { area: 'deep_cleaning_upload', password_hash: hash, password_updated_at: now })
      }
      return res.json({ ok: true })
    }
    return res.status(500).json({ message: 'no database configured' })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'reset failed' })
  }
})

router.post('/maintenance-progress/reset-password', requirePerm('rbac.manage'), async (req, res) => {
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
      const rows = await pgSelect('public_access', '*', { area: 'maintenance_share' }) as any[]
      const existing = rows && rows[0]
      const now = new Date().toISOString()
      if (existing) {
        await pgPool!.query('UPDATE public_access SET password_hash=$1, password_updated_at=$2 WHERE area=$3', [hash, now, 'maintenance_share'])
      } else {
        await pgInsert('public_access', { area: 'maintenance_share', password_hash: hash, password_updated_at: now })
      }
      return res.json({ ok: true })
    }
    return res.status(500).json({ message: 'no database configured' })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'reset failed' })
  }
})

router.post('/maintenance/merge-repairs', requirePerm('rbac.manage'), async (_req, res) => {
  try {
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS work_no text;`)
    await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS category text;`)
    await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS status text;`)
    await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS urgency text;`)
    await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS assignee_id text;`)
    await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS eta date;`)
    await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS completed_at timestamptz;`)
    await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS submitted_at timestamptz;`)
    await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS repair_notes text;`)
    await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS repair_photo_urls jsonb;`)
    const sql = `
      INSERT INTO property_maintenance (
        id, property_id, occurred_at, worker_name,
        details, notes, created_by, photo_urls, property_code,
        work_no, category, status, urgency, assignee_id, eta, completed_at, submitted_at,
        repair_notes, repair_photo_urls
      )
      SELECT
        r.id,
        r.property_id,
        COALESCE(r.submitted_at::date, now()::date),
        NULL,
        CASE
          WHEN r.detail IS NULL OR r.detail = '' THEN '[]'::jsonb
          ELSE jsonb_build_array(jsonb_build_object('content', r.detail))
        END,
        r.remark,
        r.submitter_id,
        COALESCE(
          (SELECT ARRAY(SELECT jsonb_array_elements_text(COALESCE(r.attachment_urls::jsonb, '[]'::jsonb)))),
          ARRAY[]::text[]
        ),
        NULL,
        ('R-' || to_char(COALESCE(r.submitted_at, now()), 'YYYYMMDD') || '-' || substr(r.id, 1, 4)),
        r.category,
        r.status,
        r.urgency,
        r.assignee_id,
        CASE WHEN r.eta ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN r.eta::date ELSE NULL END,
        r.completed_at,
        COALESCE(r.submitted_at, now()),
        NULL,
        COALESCE(r.attachment_urls::jsonb, '[]'::jsonb)
      FROM repair_orders r
      ON CONFLICT (id) DO NOTHING;
    `
    const result = await pgPool.query(sql)
    return res.json({ ok: true, inserted: result.rowCount || 0 })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'merge failed' })
  }
})

export default router
