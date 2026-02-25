import { Router } from 'express'
import { z } from 'zod'
import { requireAnyPerm, requirePerm } from '../auth'
import { hasPg, pgSelect, pgUpdate } from '../dbAdapter'
import { db } from '../store'

export const router = Router()

const colorSchema = z.object({ color_hex: z.string().regex(/^#[0-9a-fA-F]{6}$/) }).strict()

router.get('/', requireAnyPerm(['rbac.manage', 'cleaning.schedule.manage', 'cleaning.task.assign']), async (_req, res) => {
  try {
    if (hasPg) {
      const rows = await pgSelect('users', 'id, username, email, role, color_hex, created_at') as any[] || []
      return res.json(rows)
    }
    const rows = (db.users || []).map((u: any) => ({ id: u.id, username: u.username, email: u.email, role: u.role, color_hex: u.color_hex, created_at: u.created_at }))
    return res.json(rows)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'users_failed' })
  }
})

router.get('/:id', requireAnyPerm(['rbac.manage', 'cleaning.schedule.manage', 'cleaning.task.assign']), async (req, res) => {
  const id = String(req.params.id || '').trim()
  if (!id) return res.status(400).json({ message: 'id required' })
  try {
    if (hasPg) {
      const rows = await pgSelect('users', 'id, username, email, role, color_hex, created_at', { id }) as any[] || []
      const row = rows[0]
      if (!row) return res.status(404).json({ message: 'user not found' })
      return res.json(row)
    }
    const row = (db.users || []).find((u: any) => String(u.id) === id)
    if (!row) return res.status(404).json({ message: 'user not found' })
    return res.json({ id: row.id, username: (row as any).username, email: (row as any).email, role: (row as any).role, color_hex: (row as any).color_hex, created_at: (row as any).created_at })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'user_failed' })
  }
})

router.patch('/:id', requirePerm('rbac.manage'), async (req, res) => {
  const id = String(req.params.id || '').trim()
  if (!id) return res.status(400).json({ message: 'id required' })
  const parsed = colorSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (hasPg) {
      const updated = await pgUpdate('users', id, { color_hex: parsed.data.color_hex } as any)
      return res.json(updated || { id, color_hex: parsed.data.color_hex })
    }
    const u = (db.users || []).find((x: any) => String(x.id) === id)
    if (!u) return res.status(404).json({ message: 'user not found' })
    ;(u as any).color_hex = parsed.data.color_hex
    return res.json(u)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'update_failed' })
  }
})
