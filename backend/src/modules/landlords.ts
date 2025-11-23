import { Router } from 'express'
import { db, Landlord, addAudit } from '../store'
import { hasSupabase, supaSelect, supaInsert, supaUpdate, supaDelete } from '../supabase'
import { hasPg, pgSelect, pgInsert, pgUpdate, pgDelete } from '../dbAdapter'
import { z } from 'zod'
import { requirePerm } from '../auth'
import bcrypt from 'bcryptjs'
import { v4 as uuidv4 } from 'uuid'

export const router = Router()

router.get('/', (req, res) => {
  const q: any = req.query || {}
  const includeArchived = String(q.include_archived || '').toLowerCase() === 'true'
  if (hasSupabase) {
    const handle = (rows: any) => {
      const arr = Array.isArray(rows) ? rows : []
      return res.json(includeArchived ? arr : arr.filter((x: any) => !x.archived))
    }
    supaSelect('landlords', '*', includeArchived ? undefined as any : { archived: false } as any)
      .then(handle)
      .catch(() => {
        supaSelect('landlords')
          .then(handle)
          .catch((err) => res.status(500).json({ message: err.message }))
      })
    return
  }
  if (hasPg) {
    const filter = includeArchived ? {} : { archived: false }
    pgSelect('landlords', '*', filter as any)
      .then((data) => res.json(includeArchived ? data : (data || []).filter((x: any) => !x.archived)))
      .catch((err) => res.status(500).json({ message: err.message }))
    return
  }
  return res.json((db.landlords || []).filter((l: any) => includeArchived ? true : !l.archived))
})

const schema = z.object({
  name: z.string().min(1),
  phone: z.string().optional(),
  email: z.string().optional(),
  management_fee_rate: z.number().optional(),
  payout_bsb: z.string().optional(),
  payout_account: z.string().optional(),
  property_ids: z.array(z.string()).optional(),
}).transform((v) => {
  const m = (v as any)
  if (m.management_fee !== undefined && m.management_fee_rate === undefined) m.management_fee_rate = m.management_fee
  return m
})

router.post('/', requirePerm('landlord.manage'), (req, res) => {
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const l: Landlord = { id: uuidv4(), ...parsed.data }
  if (hasSupabase) {
    return supaInsert('landlords', l)
      .then((row) => { addAudit('Landlord', row.id, 'create', null, row); res.status(201).json(row) })
      .catch((err) => res.status(500).json({ message: err.message }))
  }
  if (hasPg) {
    return pgInsert('landlords', l)
      .then((row) => { addAudit('Landlord', l.id, 'create', null, row); res.status(201).json(row) })
      .catch((err) => res.status(500).json({ message: err.message }))
  }
  db.landlords.push(l)
  addAudit('Landlord', l.id, 'create', null, l)
  return res.status(201).json(l)
})

router.patch('/:id', requirePerm('landlord.manage'), async (req, res) => {
  const { id } = req.params
  const body = req.body as Partial<Landlord>
  try {
    if (hasSupabase) {
      const rows: any = await supaSelect('landlords', '*', { id })
      const before = rows && rows[0]
      const row = await supaUpdate('landlords', id, body)
      addAudit('Landlord', id, 'update', before, row)
      return res.json(row)
    }
    if (hasPg) {
      const rows: any = await pgSelect('landlords', '*', { id })
      const before = rows && rows[0]
      const row = await pgUpdate('landlords', id, body)
      addAudit('Landlord', id, 'update', before, row)
      return res.json(row)
    }
    const l = db.landlords.find(x => x.id === id)
    if (!l) return res.status(404).json({ message: 'not found' })
    const beforeLocal = { ...l }
    Object.assign(l, body)
    addAudit('Landlord', id, 'update', beforeLocal, l)
    return res.json(l)
  } catch (e: any) {
    return res.status(500).json({ message: e.message })
  }
})

router.get('/:id', (req, res) => {
  const { id } = req.params
  if (hasSupabase) {
    supaSelect('landlords', '*', { id })
      .then(rows => { if (!rows || !rows[0]) return res.status(404).json({ message: 'not found' }); res.json(rows[0]) })
      .catch(err => res.status(500).json({ message: err.message }))
    return
  }
  if (hasPg) {
    pgSelect('landlords', '*', { id })
      .then(rows => { if (!rows || !rows[0]) return res.status(404).json({ message: 'not found' }); res.json(rows[0]) })
      .catch(err => res.status(500).json({ message: err.message }))
    return
  }
  const l = db.landlords.find(x => x.id === id)
  if (!l) return res.status(404).json({ message: 'not found' })
  return res.json(l)
})

router.delete('/:id', requirePerm('landlord.manage'), async (req, res) => {
  const { id } = req.params
  const actor = (req as any).user
  try {
    if (hasSupabase) {
      const rows: any = await supaSelect('landlords', '*', { id })
      const before = rows && rows[0]
      try {
        const row = await supaUpdate('landlords', id, { archived: true })
        addAudit('Landlord', id, 'archive', before, row, actor?.sub)
        return res.json({ id, archived: true })
      } catch (e: any) {
        return res.status(400).json({ message: '数据库缺少 archived 列，请先执行迁移：ALTER TABLE landlords ADD COLUMN IF NOT EXISTS archived boolean DEFAULT false;' })
      }
    }
    if (hasPg) {
      const rows: any = await pgSelect('landlords', '*', { id })
      const before = rows && rows[0]
      const row = await pgUpdate('landlords', id, { archived: true })
      addAudit('Landlord', id, 'archive', before, row, actor?.sub)
      return res.json({ id, archived: true })
    }
    const l = db.landlords.find(x => x.id === id)
    if (!l) return res.status(404).json({ message: 'not found' })
    const beforeLocal = { ...l }
    ;(l as any).archived = true
    addAudit('Landlord', id, 'archive', beforeLocal, l, actor?.sub)
    return res.json({ id, archived: true })
  } catch (e: any) {
    return res.status(500).json({ message: e.message })
  }
})