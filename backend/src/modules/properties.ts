import { Router } from 'express'
import { db, Property, addAudit } from '../store'
import { hasSupabase, supaSelect, supaInsert, supaUpdate, supaDelete } from '../supabase'
import { hasPg, pgSelect, pgInsert, pgUpdate, pgDelete } from '../dbAdapter'
import { z } from 'zod'
import { requirePerm } from '../auth'

export const router = Router()

router.get('/', (req, res) => {
  if (hasSupabase) {
    supaSelect('properties')
      .then((data) => res.json(data))
      .catch((err) => res.status(500).json({ message: err.message }))
    return
  }
  if (hasPg) {
    pgSelect('properties')
      .then((data) => res.json(data))
      .catch((err) => res.status(500).json({ message: err.message }))
    return
  }
  return res.json(db.properties)
})

const createSchema = z.object({
  code: z.string().optional(),
  address: z.string().min(3),
  type: z.string(),
  capacity: z.number().int().min(1),
  region: z.string().optional(),
  area_sqm: z.number().optional(),
  building_name: z.string().optional(),
  building_facilities: z.array(z.string()).optional(),
  building_facility_floor: z.string().optional(),
  building_contact_name: z.string().optional(),
  building_contact_phone: z.string().optional(),
  building_contact_email: z.string().optional(),
  building_notes: z.string().optional(),
  bed_config: z.string().optional(),
  tv_model: z.string().optional(),
  aircon_model: z.string().optional(),
  notes: z.string().optional(),
  floor: z.string().optional(),
  parking_type: z.string().optional(),
  parking_space: z.string().optional(),
  access_type: z.string().optional(),
  access_guide_link: z.string().optional(),
  keybox_location: z.string().optional(),
  keybox_code: z.string().optional(),
  garage_guide_link: z.string().optional(),
  landlord_id: z.string().optional(),
  orientation: z.string().optional(),
  fireworks_view: z.boolean().optional(),
})

router.post('/', requirePerm('property.write'), async (req, res) => {
  const parsed = createSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const { v4: uuid } = require('uuid')
  const autoCode = `PM-${Math.random().toString(36).slice(2,6).toUpperCase()}-${Date.now().toString().slice(-4)}`
  const pFull: any = { id: uuid(), code: parsed.data.code || autoCode, ...parsed.data }
  const baseKeys = ['id','address','type','capacity','region','area_sqm','building_name','building_facilities','building_facility_floor','building_contact_name','building_contact_phone','building_contact_email','building_notes','bed_config','tv_model','aircon_model','access_guide_link','keybox_location','keybox_code','garage_guide_link','floor','parking_type','parking_space','access_type','orientation','fireworks_view','notes','landlord_id']
  const pBase: any = Object.fromEntries(Object.entries(pFull).filter(([k]) => baseKeys.includes(k)))
  const minimalKeys = ['id','address','type','capacity','region','area_sqm','notes']
  const pMinimal: any = Object.fromEntries(Object.entries(pFull).filter(([k]) => minimalKeys.includes(k)))
  try {
    if (hasSupabase) {
      try {
        const row = await supaInsert('properties', pFull)
        addAudit('Property', row.id, 'create', null, row)
        ;['guest','spare_1','spare_2','other'].forEach((t) => {
          if (!db.keySets.find((s) => s.code === (row.code || '') && s.set_type === t)) {
            const { v4: uuidv4 } = require('uuid')
            db.keySets.push({ id: uuidv4(), set_type: t, status: 'available', code: row.code || '', items: [] })
          }
        })
        return res.status(201).json(row)
      } catch (e: any) {
        try {
          const row = await supaInsert('properties', pBase)
          addAudit('Property', row.id, 'create', null, row)
          ;['guest','spare_1','spare_2','other'].forEach((t) => {
            if (!db.keySets.find((s) => s.code === (row.code || '') && s.set_type === t)) {
              const { v4: uuidv4 } = require('uuid')
              db.keySets.push({ id: uuidv4(), set_type: t, status: 'available', code: row.code || '', items: [] })
            }
          })
          return res.status(201).json(row)
        } catch (e2: any) {
          const row = await supaInsert('properties', pMinimal)
          addAudit('Property', row.id, 'create', null, row)
          ;['guest','spare_1','spare_2','other'].forEach((t) => {
            if (!db.keySets.find((s) => s.code === (row.code || '') && s.set_type === t)) {
              const { v4: uuidv4 } = require('uuid')
              db.keySets.push({ id: uuidv4(), set_type: t, status: 'available', code: row.code || '', items: [] })
            }
          })
          return res.status(201).json(row)
        }
      }
    }
    if (hasPg) {
      const row = await pgInsert('properties', pFull)
      addAudit('Property', row.id, 'create', null, row)
      ;['guest','spare_1','spare_2','other'].forEach((t) => {
        if (!db.keySets.find((s) => s.code === (row.code || '') && s.set_type === t)) {
          const { v4: uuidv4 } = require('uuid')
          db.keySets.push({ id: uuidv4(), set_type: t, status: 'available', code: row.code || '', items: [] })
        }
      })
      return res.status(201).json(row)
    }
    db.properties.push(pFull)
    addAudit('Property', pFull.id, 'create', null, pFull)
    ;['guest','spare_1','spare_2','other'].forEach((t) => {
      if (!db.keySets.find((s) => s.code === (pFull.code || '') && s.set_type === t)) {
        const { v4: uuidv4 } = require('uuid')
        db.keySets.push({ id: uuidv4(), set_type: t, status: 'available', code: pFull.code || '', items: [] })
      }
    })
    return res.status(201).json(pFull)
  } catch (e: any) {
    return res.status(500).json({ message: e.message })
  }
})

router.patch('/:id', requirePerm('property.write'), async (req, res) => {
  const { id } = req.params
  const body = req.body as any
  const cleanedBody: any = Object.fromEntries(Object.entries(body).filter(([k]) => k !== 'bedrooms'))
  const baseKeys = ['address','type','capacity','region','area_sqm','building_name','building_facilities','building_facility_floor','building_contact_name','building_contact_phone','building_contact_email','building_notes','bed_config','tv_model','aircon_model','access_guide_link','keybox_location','keybox_code','garage_guide_link','floor','parking_type','parking_space','access_type','orientation','fireworks_view','notes','landlord_id']
  const bodyBase: any = Object.fromEntries(Object.entries(cleanedBody).filter(([k]) => baseKeys.includes(k)))
  try {
    if (hasSupabase) {
      const rows: any = await supaSelect('properties', '*', { id })
      const before = rows && rows[0]
      const minimalKeys = ['address','type','capacity','region','area_sqm','notes']
      const cleaned: any = Object.fromEntries(Object.entries(body).filter(([k]) => k !== 'bedrooms'))
      const bodyMinimal: any = Object.fromEntries(Object.entries(cleaned).filter(([k]) => minimalKeys.includes(k)))
      try {
        const row = await supaUpdate('properties', id, cleaned)
        addAudit('Property', id, 'update', before, row)
        return res.json(row)
      } catch (e: any) {
        try {
          const row = await supaUpdate('properties', id, bodyBase)
          addAudit('Property', id, 'update', before, row)
          return res.json(row)
        } catch (e2: any) {
          const row = await supaUpdate('properties', id, bodyMinimal)
          addAudit('Property', id, 'update', before, row)
          return res.json(row)
        }
      }
    }
    if (hasPg) {
      const rows: any = await pgSelect('properties', '*', { id })
      const before = rows && rows[0]
      const row = await pgUpdate('properties', id, cleanedBody)
      addAudit('Property', id, 'update', before, row)
      return res.json(row)
    }
    const p = db.properties.find((x) => x.id === id)
    if (!p) return res.status(404).json({ message: 'not found' })
    const beforeLocal = { ...p }
    Object.assign(p, cleanedBody)
    addAudit('Property', id, 'update', beforeLocal, p)
    return res.json(p)
  } catch (e: any) {
    return res.status(500).json({ message: e.message })
  }
})

router.get('/:id', (req, res) => {
  const { id } = req.params
  if (hasSupabase) {
    supaSelect('properties', '*', { id })
      .then((rows) => { if (!rows || !rows[0]) return res.status(404).json({ message: 'not found' }); res.json(rows[0]) })
      .catch((err) => res.status(500).json({ message: err.message }))
    return
  }
  if (hasPg) {
    pgSelect('properties', '*', { id })
      .then((rows) => { if (!rows || !rows[0]) return res.status(404).json({ message: 'not found' }); res.json(rows[0]) })
      .catch((err) => res.status(500).json({ message: err.message }))
    return
  }
  const p = db.properties.find((x) => x.id === id)
  if (!p) return res.status(404).json({ message: 'not found' })
  return res.json(p)
})

router.delete('/:id', requirePerm('property.write'), async (req, res) => {
  const { id } = req.params
  const actor = (req as any).user
  try {
    if (hasSupabase) {
      const row = await supaDelete('properties', id)
      addAudit('Property', id, 'delete', row, null, actor?.sub)
      return res.json({ id })
    }
    if (hasPg) {
      const row = await pgDelete('properties', id)
      addAudit('Property', id, 'delete', row, null, actor?.sub)
      return res.json({ id })
    }
    const idx = db.properties.findIndex(x => x.id === id)
    if (idx === -1) return res.status(404).json({ message: 'not found' })
    const beforeLocal = db.properties[idx]
    db.properties.splice(idx, 1)
    addAudit('Property', id, 'delete', beforeLocal, null, actor?.sub)
    return res.json({ id })
  } catch (e: any) {
    return res.status(500).json({ message: e.message })
  }
})