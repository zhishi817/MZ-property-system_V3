import { Router } from 'express'
import { db, Landlord, addAudit } from '../store'
import { hasSupabase, supaSelect, supaInsert, supaUpdate, supaDelete } from '../supabase'
import { hasPg, pgSelect, pgInsert, pgUpdate, pgDelete } from '../dbAdapter'
import { hasPg, pgSelect, pgInsert, pgUpdate } from '../dbAdapter'
import { z } from 'zod'
import { requirePerm } from '../auth'
import bcrypt from 'bcryptjs'

export const router = Router()

router.get('/', (req, res) => {
  if (hasSupabase) {
    supaSelect('landlords')
      .then((data) => res.json(data))
      .catch((err) => res.status(500).json({ message: err.message }))
    return
  }
  if (hasPg) {
    pgSelect('landlords')
      .then((data) => res.json(data))
      .catch((err) => res.status(500).json({ message: err.message }))
    return
  }
  return res.json(db.landlords)
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
  const { v4: uuid } = require('uuid')
  const l: Landlord = { id: uuid(), ...parsed.data }
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
      const row = await supaDelete('landlords', id)
      addAudit('Landlord', id, 'delete', row, null, actor?.sub)
      return res.json({ id })
    }
    if (hasPg) {
      const row = await pgDelete('landlords', id)
      addAudit('Landlord', id, 'delete', row, null, actor?.sub)
      return res.json({ id })
    }
    const idx = db.landlords.findIndex(x => x.id === id)
    if (idx === -1) return res.status(404).json({ message: 'not found' })
    const beforeLocal = db.landlords[idx]
    db.landlords.splice(idx, 1)
    addAudit('Landlord', id, 'delete', beforeLocal, null, actor?.sub)
    return res.json({ id })
  } catch (e: any) {
    return res.status(500).json({ message: e.message })
  }
})