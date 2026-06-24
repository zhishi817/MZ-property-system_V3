import { Router } from 'express'
import { db, Property, addAudit } from '../store'
import { hasPg, pgPool, pgSelect, pgInsert, pgUpdate, pgDelete, pgRunInTransaction } from '../dbAdapter'
import { z } from 'zod'
import { requirePerm } from '../auth'
import { v4 as uuidv4 } from 'uuid'

export const router = Router()
const PROPERTY_PAYABLE_TEMPLATE_KIND = 'property_payable'

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
  room_type_code: z.string().optional(),
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
  wifi_ssid: z.string().optional(),
  wifi_password: z.string().optional(),
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
  payable_templates: z.array(z.object({
    id: z.string().optional(),
    vendor: z.string().min(1),
    category: z.string().min(1),
    category_detail: z.string().optional(),
    amount: z.coerce.number().optional(),
    due_day_of_month: z.coerce.number().min(1).max(31),
    frequency_months: z.coerce.number().min(1).max(24).optional(),
    remind_days_before: z.coerce.number().min(0).max(30).optional(),
    payment_type: z.enum(['bank_account', 'bpay', 'payid', 'rent_deduction', 'cash']).optional(),
    pay_account_name: z.string().optional(),
    pay_bsb: z.string().optional(),
    pay_account_number: z.string().optional(),
    pay_ref: z.string().optional(),
    bpay_code: z.string().optional(),
    pay_mobile_number: z.string().optional(),
    report_category: z.string().optional(),
    start_month_key: z.string().regex(/^\d{4}-\d{2}$/),
    bill_account_no: z.string().optional(),
    note: z.string().optional(),
  })).optional(),
})

function normListingName(v: any) {
  const s = String(v ?? '').trim()
  return s ? s : null
}

async function ensureListingColumns() {
  if (!pgPool) return
  await pgPool.query('ALTER TABLE properties ADD COLUMN IF NOT EXISTS airbnb_listing_name text')
  await pgPool.query('ALTER TABLE properties ADD COLUMN IF NOT EXISTS booking_listing_name text')
  await pgPool.query('ALTER TABLE properties ADD COLUMN IF NOT EXISTS listing_names jsonb')
}

async function ensurePropertyColumns() {
  if (!pgPool) return
  await ensureListingColumns()
  await pgPool.query('ALTER TABLE properties ADD COLUMN IF NOT EXISTS biz_category text')
  await pgPool.query('ALTER TABLE properties ADD COLUMN IF NOT EXISTS building_facility_other text')
  await pgPool.query('ALTER TABLE properties ADD COLUMN IF NOT EXISTS bedroom_ac text')
  await pgPool.query('ALTER TABLE properties ADD COLUMN IF NOT EXISTS room_type_code text')
  await pgPool.query('ALTER TABLE properties ADD COLUMN IF NOT EXISTS wifi_ssid text')
  await pgPool.query('ALTER TABLE properties ADD COLUMN IF NOT EXISTS wifi_password text')
  await pgPool.query('ALTER TABLE properties ADD COLUMN IF NOT EXISTS archived boolean DEFAULT false')
}

async function ensurePropertyPayableColumns(client?: any) {
  const executor = client || pgPool
  if (!executor) return
  await executor.query(`CREATE TABLE IF NOT EXISTS recurring_payments (
    id text PRIMARY KEY,
    property_id text REFERENCES properties(id) ON DELETE SET NULL,
    scope text,
    vendor text,
    category text,
    category_detail text,
    amount numeric,
    due_day_of_month integer,
    frequency_months integer,
    remind_days_before integer,
    status text,
    last_paid_date date,
    next_due_date date,
    start_month_key text,
    pay_account_name text,
    pay_bsb text,
    pay_account_number text,
    pay_ref text,
    expense_id text,
    expense_resource text,
    payment_type text,
    bpay_code text,
    pay_mobile_number text,
    report_category text,
    amount_mode text,
    income_base text,
    rate_percent numeric,
    property_ids text[],
    template_kind text,
    bill_account_no text,
    note text,
    created_by text,
    updated_by text,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz
  );`)
  await executor.query(`ALTER TABLE recurring_payments ADD COLUMN IF NOT EXISTS template_kind text DEFAULT '${PROPERTY_PAYABLE_TEMPLATE_KIND}';`)
  await executor.query('ALTER TABLE recurring_payments ADD COLUMN IF NOT EXISTS bill_account_no text;')
  await executor.query('ALTER TABLE recurring_payments ADD COLUMN IF NOT EXISTS note text;')
  await executor.query('ALTER TABLE recurring_payments ADD COLUMN IF NOT EXISTS created_by text;')
  await executor.query('ALTER TABLE recurring_payments ADD COLUMN IF NOT EXISTS updated_by text;')
}

function normalizePayableTemplates(raw: any[] | undefined, actorId: string | null, propertyId: string) {
  const rows = Array.isArray(raw) ? raw : []
  return rows.map((item) => {
    const id = String(item?.id || '').trim() || uuidv4()
    return {
      id,
      property_id: propertyId,
      scope: 'property',
      template_kind: PROPERTY_PAYABLE_TEMPLATE_KIND,
      vendor: String(item?.vendor || '').trim(),
      category: String(item?.category || '').trim(),
      category_detail: String(item?.category_detail || '').trim() || null,
      amount: item?.amount == null ? 0 : Number(item.amount || 0),
      due_day_of_month: Number(item?.due_day_of_month || 1),
      frequency_months: Math.max(1, Number(item?.frequency_months || 1)),
      remind_days_before: Number(item?.remind_days_before ?? 3),
      payment_type: item?.payment_type ? String(item.payment_type) : 'bank_account',
      pay_account_name: String(item?.pay_account_name || '').trim() || null,
      pay_bsb: String(item?.pay_bsb || '').trim() || null,
      pay_account_number: String(item?.pay_account_number || '').trim() || null,
      pay_ref: String(item?.pay_ref || '').trim() || null,
      bpay_code: String(item?.bpay_code || '').trim() || null,
      pay_mobile_number: String(item?.pay_mobile_number || '').trim() || null,
      report_category: String(item?.report_category || '').trim() || null,
      start_month_key: String(item?.start_month_key || '').trim(),
      bill_account_no: String(item?.bill_account_no || '').trim() || null,
      note: String(item?.note || '').trim() || null,
      status: 'active',
      created_by: actorId,
      updated_by: actorId,
    }
  })
}

async function syncPropertyPayableTemplatesTx(client: any, propertyId: string, rawTemplates: any[] | undefined, actorId: string | null) {
  await ensurePropertyPayableColumns(client)
  const nextTemplates = normalizePayableTemplates(rawTemplates, actorId, propertyId)
  const existingRes = await client.query(
    `SELECT *
       FROM recurring_payments
      WHERE property_id = $1
        AND COALESCE(template_kind, $2) = $3`,
    [propertyId, 'fixed_expense', PROPERTY_PAYABLE_TEMPLATE_KIND]
  )
  const existingRows: any[] = Array.isArray(existingRes.rows) ? existingRes.rows : []
  const existingById = new Map<string, any>()
  existingRows.forEach((row) => existingById.set(String(row.id), row))
  const keepIds = new Set(nextTemplates.map((row) => String(row.id)))

  for (const tpl of nextTemplates) {
    const existing = existingById.get(String(tpl.id))
    if (existing) {
      const patch = {
        property_id: propertyId,
        scope: 'property',
        template_kind: PROPERTY_PAYABLE_TEMPLATE_KIND,
        vendor: tpl.vendor,
        category: tpl.category,
        category_detail: tpl.category_detail,
        amount: tpl.amount,
        due_day_of_month: tpl.due_day_of_month,
        frequency_months: tpl.frequency_months,
        remind_days_before: tpl.remind_days_before,
        payment_type: tpl.payment_type,
        pay_account_name: tpl.pay_account_name,
        pay_bsb: tpl.pay_bsb,
        pay_account_number: tpl.pay_account_number,
        pay_ref: tpl.pay_ref,
        bpay_code: tpl.bpay_code,
        pay_mobile_number: tpl.pay_mobile_number,
        report_category: tpl.report_category,
        start_month_key: tpl.start_month_key,
        bill_account_no: tpl.bill_account_no,
        note: tpl.note,
        updated_by: actorId,
        updated_at: new Date(),
      }
      const after = await pgUpdate('recurring_payments', String(tpl.id), patch, client)
      addAudit('RecurringPayment', String(tpl.id), 'update', existing, after, actorId || undefined)
    } else {
      const created = await pgInsert('recurring_payments', tpl, client)
      addAudit('RecurringPayment', String(tpl.id), 'create', null, created || tpl, actorId || undefined)
    }
  }

  for (const existing of existingRows) {
    if (keepIds.has(String(existing.id))) continue
    if (String(existing.status || '') === 'paused') continue
    const after = await pgUpdate('recurring_payments', String(existing.id), { status: 'paused', updated_by: actorId, updated_at: new Date() }, client)
    addAudit('RecurringPayment', String(existing.id), 'pause', existing, after, actorId || undefined)
  }

  return nextTemplates.map((item) => item.id)
}

async function findListingConflictPg(listingName: string, excludeId?: string | null) {
  if (!pgPool) return null
  const res = await pgPool.query(
    `SELECT id, code, address
     FROM properties
     WHERE (airbnb_listing_name = $1 OR booking_listing_name = $1 OR (listing_names->>'other') = $1)
       AND ($2::text IS NULL OR id <> $2::text)
     LIMIT 1`,
    [listingName, excludeId || null],
  )
  return res.rows?.[0] || null
}

function findListingConflictLocal(listingName: string, excludeId?: string | null) {
  const name = normListingName(listingName)
  if (!name) return null
  const rows = ((db.properties || []) as any[]).filter((p: any) => !excludeId || p.id !== excludeId)
  for (const p of rows) {
    const vals = [p.airbnb_listing_name, p.booking_listing_name, p.listing_names?.other]
    if (vals.some((v: any) => normListingName(v) === name)) return { id: p.id, code: p.code, address: p.address }
  }
  return null
}

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
  const actorId = String(actor?.sub || actor?.username || '').trim() || null
  const pFull: any = { id: uuidv4(), code: parsed.data.code || autoCode, created_by: actor?.sub || actor?.username || null, ...parsed.data }
  const lnObj = (pFull.listing_names || {}) as any
  pFull.airbnb_listing_name = normListingName(pFull.airbnb_listing_name || lnObj.airbnb || null)
  pFull.booking_listing_name = normListingName(pFull.booking_listing_name || lnObj.booking || null)
  pFull.listing_names = { other: String(lnObj.other || '').trim() }
  const baseKeys = ['id','code','address','type','capacity','room_type_code','region','area_sqm','biz_category','building_name','building_facilities','building_facility_floor','building_facility_other','building_contact_name','building_contact_phone','building_contact_email','building_notes','bed_config','tv_model','wifi_ssid','wifi_password','aircon_model','bedroom_ac','access_guide_link','keybox_location','keybox_code','garage_guide_link','floor','parking_type','parking_space','access_type','orientation','fireworks_view','notes','landlord_id','created_by','listing_names','airbnb_listing_name','booking_listing_name','airbnb_listing_id','booking_listing_id']
  const pBase: any = Object.fromEntries(Object.entries(pFull).filter(([k]) => baseKeys.includes(k)))
  const minimalKeys = ['id','code','address','type','capacity','room_type_code','region','area_sqm','notes','listing_names']
  const pMinimal: any = Object.fromEntries(Object.entries(pFull).filter(([k]) => minimalKeys.includes(k)))
  try {
    // Supabase branch removed
    if (hasPg) {
      await ensurePropertyColumns()
      const listingCandidates = [
        pFull.airbnb_listing_name,
        pFull.booking_listing_name,
        (pFull.listing_names || {}).other,
      ].map(normListingName).filter(Boolean) as string[]
      if (listingCandidates.length) {
        try {
          await ensureListingColumns()
          for (const name of listingCandidates) {
            const conflict = await findListingConflictPg(name, null)
            if (conflict) return res.status(400).json({ message: `已经存在 Listing 名称：${name}`, code: 'DUPLICATE_LISTING_NAME', listing_name: name })
          }
        } catch (e: any) {
          return res.status(500).json({ message: e?.message || 'listing name check failed' })
        }
      }
      const created = await pgRunInTransaction(async (client) => {
        const row = await pgInsert('properties', pBase, client)
        if (Array.isArray(parsed.data.payable_templates) && parsed.data.payable_templates.length) {
          await syncPropertyPayableTemplatesTx(client, String(row.id), parsed.data.payable_templates, actorId)
        }
        return row
      })
      addAudit('Property', String((created as any)?.id || pFull.id), 'create', null, created, actorId || undefined)
      ;['guest','spare_1','spare_2','other'].forEach((t) => {
        if (!db.keySets.find((s) => s.code === ((created as any)?.code || '') && s.set_type === t)) {
          db.keySets.push({ id: uuidv4(), set_type: t, status: 'available', code: (created as any)?.code || '', items: [] } as any)
        }
      })
      return res.status(201).json(created)
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
    cleanedBody.airbnb_listing_name = normListingName(cleanedBody.airbnb_listing_name || ln.airbnb || null)
    cleanedBody.booking_listing_name = normListingName(cleanedBody.booking_listing_name || ln.booking || null)
    cleanedBody.listing_names = { other: String(ln.other || '').trim() }
  }
  const baseKeys = ['code','address','type','capacity','room_type_code','region','area_sqm','biz_category','building_name','building_facilities','building_facility_floor','building_facility_other','building_contact_name','building_contact_phone','building_contact_email','building_notes','bed_config','tv_model','wifi_ssid','wifi_password','aircon_model','bedroom_ac','access_guide_link','keybox_location','keybox_code','garage_guide_link','floor','parking_type','parking_space','access_type','orientation','fireworks_view','notes','landlord_id','listing_names','airbnb_listing_name','booking_listing_name','airbnb_listing_id','booking_listing_id']
  const actor = (req as any).user
  const actorId = String(actor?.sub || actor?.username || '').trim() || null
  const bodyBaseRaw: any = Object.fromEntries(Object.entries(cleanedBody).filter(([k]) => baseKeys.includes(k)))
  const bodyBase: any = { ...bodyBaseRaw, updated_at: new Date(), updated_by: actor?.sub || actor?.username || null }
  try {
    if (hasPg) {
      await ensurePropertyColumns()
      const rows: any = await pgSelect('properties', '*', { id })
      const before = rows && rows[0]
      const touchedListing = Object.prototype.hasOwnProperty.call(bodyBaseRaw, 'airbnb_listing_name')
        || Object.prototype.hasOwnProperty.call(bodyBaseRaw, 'booking_listing_name')
        || Object.prototype.hasOwnProperty.call(bodyBaseRaw, 'listing_names')
      if (touchedListing) {
        const merged: any = { ...(before || {}), ...(bodyBaseRaw || {}) }
        const listingCandidates = [
          merged.airbnb_listing_name,
          merged.booking_listing_name,
          (merged.listing_names || {}).other,
        ].map(normListingName).filter(Boolean) as string[]
        await ensureListingColumns()
        for (const name of listingCandidates) {
          const conflict = await findListingConflictPg(name, id)
          if (conflict) return res.status(400).json({ message: `已经存在 Listing 名称：${name}`, code: 'DUPLICATE_LISTING_NAME', listing_name: name })
        }
      }
      const row = await pgRunInTransaction(async (client) => {
        const updated = await pgUpdate('properties', id, bodyBase, client)
        if (Object.prototype.hasOwnProperty.call(body, 'payable_templates')) {
          await syncPropertyPayableTemplatesTx(client, id, Array.isArray(body.payable_templates) ? body.payable_templates : [], actorId)
        }
        return updated
      })
      addAudit('Property', id, 'update', before, row, actorId || undefined)
      return res.json(row)
    }
    const p = db.properties.find((x) => x.id === id)
    if (!p) return res.status(404).json({ message: 'not found' })
    const beforeLocal = { ...p }
    const touchedListingLocal = Object.prototype.hasOwnProperty.call(bodyBaseRaw, 'airbnb_listing_name')
      || Object.prototype.hasOwnProperty.call(bodyBaseRaw, 'booking_listing_name')
      || Object.prototype.hasOwnProperty.call(bodyBaseRaw, 'listing_names')
    if (touchedListingLocal) {
      const merged: any = { ...(p as any), ...(bodyBaseRaw || {}) }
      const listingCandidates = [
        merged.airbnb_listing_name,
        merged.booking_listing_name,
        (merged.listing_names || {}).other,
      ].map(normListingName).filter(Boolean) as string[]
      for (const name of listingCandidates) {
        const conflict = findListingConflictLocal(name, id)
        if (conflict) return res.status(400).json({ message: `已经存在 Listing 名称：${name}`, code: 'DUPLICATE_LISTING_NAME', listing_name: name })
      }
    }
    Object.assign(p, cleanedBody)
    addAudit('Property', id, 'update', beforeLocal, p)
    return res.json(p)
  } catch (e: any) {
    return res.status(500).json({ message: e.message })
  }
})

router.get('/:id', async (req, res) => {
  const { id } = req.params
  // Supabase branch removed
  if (hasPg) {
    try {
      await ensurePropertyPayableColumns()
      const rows = await pgSelect('properties', '*', { id })
      if (!rows || !rows[0]) return res.status(404).json({ message: 'not found' })
      const p = rows[0]
      try {
        const payables = await pgPool!.query(
          `SELECT *
             FROM recurring_payments
            WHERE property_id = $1
              AND COALESCE(template_kind, $2) = $3
            ORDER BY COALESCE(status, 'active') ASC, COALESCE(vendor, '') ASC, COALESCE(created_at, now()) ASC`,
          [id, 'fixed_expense', PROPERTY_PAYABLE_TEMPLATE_KIND]
        )
        ;(p as any).payable_templates = Array.isArray(payables.rows) ? payables.rows : []
      } catch {
        ;(p as any).payable_templates = []
      }
      if (p.updated_by) {
        try {
          const us = await pgSelect('users', 'username, email', { id: p.updated_by })
          if (us && us[0]) {
            p.updated_by_name = us[0].username || us[0].email
          } else {
            p.updated_by_name = p.updated_by
          }
        } catch {}
      }
      return res.json(p)
    } catch (err: any) {
      return res.status(500).json({ message: err.message })
    }
  }
  const p = db.properties.find((x) => x.id === id)
  if (!p) return res.status(404).json({ message: 'not found' })
  return res.json({ ...p, payable_templates: [] })
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
