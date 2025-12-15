import { Router } from 'express'
import { db, Property, addAudit } from '../store'
import { hasPg, pgSelect, pgInsert, pgUpdate, pgDelete } from '../dbAdapter'
import { z } from 'zod'
import { requirePerm } from '../auth'
import { v4 as uuidv4 } from 'uuid'

export const router = Router()

router.get('/', (req, res) => {
  const q: any = req.query || {}
  const includeArchived = String(q.include_archived || '').toLowerCase() === 'true'
  // Supabase branch removed
  if (hasPg) {
    const filter = includeArchived ? {} : { archived: false }
    pgSelect('properties', '*', filter as any)
      .then((data) => res.json(includeArchived ? data : (data || []).filter((x: any) => !x.archived)))
      .catch((err) => res.status(500).json({ message: err.message }))
    return
  }
  return res.json((db.properties || []).filter((p: any) => includeArchived ? true : !p.archived))
})

const createSchema = z.object({
  code: z.string().optional(),
  address: z.string().min(3),
  type: z.string(),
  capacity: z.number().int().min(1),
  region: z.string().optional(),
  area_sqm: z.number().optional(),
  biz_category: z.enum(['leased','management_fee']).optional(),
  building_name: z.string().optional(),
  building_facilities: z.array(z.string()).optional(),
  building_facility_floor: z.string().optional(),
  building_facility_other: z.string().optional(),
  building_contact_name: z.string().optional(),
  building_contact_phone: z.string().optional(),
  building_contact_email: z.string().optional(),
  building_notes: z.string().optional(),
  bed_config: z.string().optional(),
  tv_model: z.string().optional(),
  aircon_model: z.string().optional(),
  bedroom_ac: z.enum(['none','master_only','both']).optional(),
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
  listing_names: z.record(z.string()).optional(),
  airbnb_listing_name: z.string().optional(),
  booking_listing_name: z.string().optional(),
  airbnb_listing_id: z.string().optional(),
  booking_listing_id: z.string().optional(),
})

router.post('/', requirePerm('property.write'), async (req, res) => {
  const parsed = createSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    const ln = (parsed.data as any).listing_names || {}
    const hasAnyObj = Object.values(ln || {}).some((v: any) => String(v || '').trim())
    const hasAnyFlat = [
      (parsed.data as any).airbnb_listing_name,
      (parsed.data as any).booking_listing_name,
    ].some((v: any) => String(v || '').trim())
    if (!hasAnyObj && !hasAnyFlat) return res.status(400).json({ message: '请至少填写一个平台的 Listing 名称' })
  } catch {}
  const autoCode = `PM-${Math.random().toString(36).slice(2,6).toUpperCase()}-${Date.now().toString().slice(-4)}`
  const actor = (req as any).user
  const pFull: any = { id: uuidv4(), code: parsed.data.code || autoCode, created_by: actor?.sub || actor?.username || null, ...parsed.data }
  const lnObj = (pFull.listing_names || {}) as any
  pFull.airbnb_listing_name = pFull.airbnb_listing_name || lnObj.airbnb || null
  pFull.booking_listing_name = pFull.booking_listing_name || lnObj.booking || null
  pFull.listing_names = { other: (lnObj.other || '') }
  const baseKeys = ['id','code','address','type','capacity','region','area_sqm','biz_category','building_name','building_facilities','building_facility_floor','building_facility_other','building_contact_name','building_contact_phone','building_contact_email','building_notes','bed_config','tv_model','aircon_model','bedroom_ac','access_guide_link','keybox_location','keybox_code','garage_guide_link','floor','parking_type','parking_space','access_type','orientation','fireworks_view','notes','landlord_id','created_by','listing_names','airbnb_listing_name','booking_listing_name','airbnb_listing_id','booking_listing_id']
  const pBase: any = Object.fromEntries(Object.entries(pFull).filter(([k]) => baseKeys.includes(k)))
  const minimalKeys = ['id','code','address','type','capacity','region','area_sqm','notes','listing_names']
  const pMinimal: any = Object.fromEntries(Object.entries(pFull).filter(([k]) => minimalKeys.includes(k)))
  try {
    // Supabase branch removed
    if (hasPg) {
      try {
        const row = await pgInsert('properties', pBase)
        addAudit('Property', row.id, 'create', null, row)
        ;['guest','spare_1','spare_2','other'].forEach((t) => {
          if (!db.keySets.find((s) => s.code === (row.code || '') && s.set_type === t)) {
            db.keySets.push({ id: uuidv4(), set_type: t, status: 'available', code: row.code || '', items: [] } as any)
          }
        })
        return res.status(201).json(row)
      } catch (e: any) {
        if (/column\s+"?listing_names"?\s+of\s+relation\s+"?properties"?\s+does\s+not\s+exist/i.test(e?.message || '')) {
          try {
            await require('../dbAdapter').pgPool?.query('ALTER TABLE properties ADD COLUMN IF NOT EXISTS listing_names jsonb')
            const row = await pgInsert('properties', pBase)
            addAudit('Property', row.id, 'create', null, row)
            ;['guest','spare_1','spare_2','other'].forEach((t) => {
              if (!db.keySets.find((s) => s.code === (row.code || '') && s.set_type === t)) {
                db.keySets.push({ id: uuidv4(), set_type: t, status: 'available', code: row.code || '', items: [] } as any)
              }
            })
            return res.status(201).json(row)
          } catch (e2: any) {
            return res.status(500).json({ message: e2?.message || 'failed to add listing_names column' })
          }
        }
        if (/column\s+"?airbnb_listing_name"?\s+of\s+relation\s+"?properties"?\s+does\s+not\s+exist/i.test(e?.message || '')) {
          await require('../dbAdapter').pgPool?.query('ALTER TABLE properties ADD COLUMN IF NOT EXISTS airbnb_listing_name text')
          const row2 = await pgInsert('properties', pBase)
          addAudit('Property', row2.id, 'create', null, row2)
          return res.status(201).json(row2)
        }
        if (/column\s+"?booking_listing_name"?\s+of\s+relation\s+"?properties"?\s+does\s+not\s+exist/i.test(e?.message || '')) {
          await require('../dbAdapter').pgPool?.query('ALTER TABLE properties ADD COLUMN IF NOT EXISTS booking_listing_name text')
          const row2 = await pgInsert('properties', pBase)
          addAudit('Property', row2.id, 'create', null, row2)
          return res.status(201).json(row2)
        }
        if (/column\s+"?airbnb_listing_id"?\s+of\s+relation\s+"?properties"?\s+does\s+not\s+exist/i.test(e?.message || '')) {
          await require('../dbAdapter').pgPool?.query('ALTER TABLE properties ADD COLUMN IF NOT EXISTS airbnb_listing_id text')
          const row2 = await pgInsert('properties', pBase)
          addAudit('Property', row2.id, 'create', null, row2)
          return res.status(201).json(row2)
        }
        if (/column\s+"?booking_listing_id"?\s+of\s+relation\s+"?properties"?\s+does\s+not\s+exist/i.test(e?.message || '')) {
          await require('../dbAdapter').pgPool?.query('ALTER TABLE properties ADD COLUMN IF NOT EXISTS booking_listing_id text')
          const row2 = await pgInsert('properties', pBase)
          addAudit('Property', row2.id, 'create', null, row2)
          return res.status(201).json(row2)
        }
        if (/column\s+"?biz_category"?\s+of\s+relation\s+"?properties"?\s+does\s+not\s+exist/i.test(e?.message || '')) {
          try {
            await require('../dbAdapter').pgPool?.query('ALTER TABLE properties ADD COLUMN IF NOT EXISTS biz_category text')
            const row = await pgInsert('properties', pBase)
            addAudit('Property', row.id, 'create', null, row)
            ;['guest','spare_1','spare_2','other'].forEach((t) => {
              if (!db.keySets.find((s) => s.code === (row.code || '') && s.set_type === t)) {
                db.keySets.push({ id: uuidv4(), set_type: t, status: 'available', code: row.code || '', items: [] } as any)
              }
            })
            return res.status(201).json(row)
          } catch (e3: any) {
            return res.status(500).json({ message: e3?.message || 'failed to add biz_category column' })
          }
        }
        if (/column\s+"?building_facility_other"?\s+of\s+relation\s+"?properties"?\s+does\s+not\s+exist/i.test(e?.message || '')) {
          try {
            await require('../dbAdapter').pgPool?.query('ALTER TABLE properties ADD COLUMN IF NOT EXISTS building_facility_other text')
            const row = await pgInsert('properties', pBase)
            addAudit('Property', row.id, 'create', null, row)
            ;['guest','spare_1','spare_2','other'].forEach((t) => {
              if (!db.keySets.find((s) => s.code === (row.code || '') && s.set_type === t)) {
                db.keySets.push({ id: uuidv4(), set_type: t, status: 'available', code: row.code || '', items: [] } as any)
              }
            })
            return res.status(201).json(row)
          } catch (e4: any) {
            return res.status(500).json({ message: e4?.message || 'failed to add building_facility_other column' })
          }
        }
        if (/column\s+"?bedroom_ac"?\s+of\s+relation\s+"?properties"?\s+does\s+not\s+exist/i.test(e?.message || '')) {
          try {
            await require('../dbAdapter').pgPool?.query('ALTER TABLE properties ADD COLUMN IF NOT EXISTS bedroom_ac text')
            const row = await pgInsert('properties', pBase)
            addAudit('Property', row.id, 'create', null, row)
            ;['guest','spare_1','spare_2','other'].forEach((t) => {
              if (!db.keySets.find((s) => s.code === (row.code || '') && s.set_type === t)) {
                db.keySets.push({ id: uuidv4(), set_type: t, status: 'available', code: row.code || '', items: [] } as any)
              }
            })
            return res.status(201).json(row)
          } catch (e5: any) {
            return res.status(500).json({ message: e5?.message || 'failed to add bedroom_ac column' })
          }
        }
        return res.status(500).json({ message: e?.message || 'create failed' })
      }
    }
    db.properties.push(pFull)
    addAudit('Property', pFull.id, 'create', null, pFull)
    ;['guest','spare_1','spare_2','other'].forEach((t) => {
      if (!db.keySets.find((s) => s.code === (pFull.code || '') && s.set_type === t)) {
        db.keySets.push({ id: uuidv4(), set_type: t, status: 'available', code: pFull.code || '', items: [] } as any)
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
  if (cleanedBody.listing_names && typeof cleanedBody.listing_names === 'object') {
    const ln: any = cleanedBody.listing_names || {}
    cleanedBody.airbnb_listing_name = cleanedBody.airbnb_listing_name || ln.airbnb || null
    cleanedBody.booking_listing_name = cleanedBody.booking_listing_name || ln.booking || null
    cleanedBody.listing_names = { other: (ln.other || '') }
  }
  const baseKeys = ['code','address','type','capacity','region','area_sqm','biz_category','building_name','building_facilities','building_facility_floor','building_facility_other','building_contact_name','building_contact_phone','building_contact_email','building_notes','bed_config','tv_model','aircon_model','bedroom_ac','access_guide_link','keybox_location','keybox_code','garage_guide_link','floor','parking_type','parking_space','access_type','orientation','fireworks_view','notes','landlord_id','listing_names','airbnb_listing_name','booking_listing_name','airbnb_listing_id','booking_listing_id']
  const actor = (req as any).user
  const bodyBaseRaw: any = Object.fromEntries(Object.entries(cleanedBody).filter(([k]) => baseKeys.includes(k)))
  const bodyBase: any = { ...bodyBaseRaw, updated_at: new Date(), updated_by: actor?.sub || actor?.username || null }
  try {
    if (hasSupabase) {
      const rows: any = await supaSelect('properties', '*', { id })
      const before = rows && rows[0]
      const minimalKeys = ['code','address','type','capacity','region','area_sqm','notes']
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
      try {
        const row = await pgUpdate('properties', id, bodyBase)
        addAudit('Property', id, 'update', before, row)
        return res.json(row)
      } catch (e: any) {
        if (/column\s+"?listing_names"?\s+of\s+relation\s+"?properties"?\s+does\s+not\s+exist/i.test(e?.message || '')) {
          await require('../dbAdapter').pgPool?.query('ALTER TABLE properties ADD COLUMN IF NOT EXISTS listing_names jsonb')
          const row2 = await pgUpdate('properties', id, bodyBase)
          addAudit('Property', id, 'update', before, row2)
          return res.json(row2)
        }
        if (/column\s+"?biz_category"?\s+of\s+relation\s+"?properties"?\s+does\s+not\s+exist/i.test(e?.message || '')) {
          await require('../dbAdapter').pgPool?.query('ALTER TABLE properties ADD COLUMN IF NOT EXISTS biz_category text')
          const row3 = await pgUpdate('properties', id, bodyBase)
          addAudit('Property', id, 'update', before, row3)
          return res.json(row3)
        }
        if (/column\s+"?building_facility_other"?\s+of\s+relation\s+"?properties"?\s+does\s+not\s+exist/i.test(e?.message || '')) {
          await require('../dbAdapter').pgPool?.query('ALTER TABLE properties ADD COLUMN IF NOT EXISTS building_facility_other text')
          const row4 = await pgUpdate('properties', id, bodyBase)
          addAudit('Property', id, 'update', before, row4)
          return res.json(row4)
        }
        if (/column\s+"?bedroom_ac"?\s+of\s+relation\s+"?properties"?\s+does\s+not\s+exist/i.test(e?.message || '')) {
          await require('../dbAdapter').pgPool?.query('ALTER TABLE properties ADD COLUMN IF NOT EXISTS bedroom_ac text')
          const row5 = await pgUpdate('properties', id, bodyBase)
          addAudit('Property', id, 'update', before, row5)
          return res.json(row5)
        }
        throw e
      }
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
  // Supabase branch removed
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
    // Supabase branch removed
    if (hasPg) {
      const rows: any = await pgSelect('properties', '*', { id })
      const before = rows && rows[0]
      const row = await pgUpdate('properties', id, { archived: true })
      addAudit('Property', id, 'archive', before, row, actor?.sub)
      return res.json({ id, archived: true })
    }
    const p = db.properties.find(x => x.id === id)
    if (!p) return res.status(404).json({ message: 'not found' })
    const beforeLocal = { ...p }
    ;(p as any).archived = true
    addAudit('Property', id, 'archive', beforeLocal, p, actor?.sub)
    return res.json({ id, archived: true })
  } catch (e: any) {
    return res.status(500).json({ message: e.message })
  }
})