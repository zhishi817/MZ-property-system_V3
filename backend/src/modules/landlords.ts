import { Router } from 'express'
import { db, Landlord, addAudit } from '../store'
// Supabase removed
import { hasPg, pgSelect, pgInsert, pgUpdate, pgDelete } from '../dbAdapter'
import { z } from 'zod'
import { requirePerm } from '../auth'
import bcrypt from 'bcryptjs'
import { v4 as uuidv4 } from 'uuid'
import {
  ensureManagementFeeRulesTable,
  isValidMonthKey,
  listManagementFeeRulesByLandlordIds,
  ruleHasRecordedManagementFeeUsage,
  syncLandlordCachedManagementFeeRate,
} from '../lib/managementFeeRules'

export const router = Router()

async function attachManagementFeeRules(rows: any[]) {
  const list = Array.isArray(rows) ? rows : []
  if (!list.length || !hasPg) return list
  await ensureManagementFeeRulesTable()
  const byLandlord = await listManagementFeeRulesByLandlordIds(list.map((x: any) => String(x?.id || '')))
  return list.map((row: any) => {
    const landlordId = String(row?.id || '')
    const rules = byLandlord[landlordId] || []
    const latestRate = rules[0] ? Number(rules[0].management_fee_rate || 0) : row?.management_fee_rate
    return {
      ...row,
      management_fee_rate: latestRate == null ? row?.management_fee_rate : latestRate,
      management_fee_rules: rules,
    }
  })
}

router.get('/', (req, res) => {
  const q: any = req.query || {}
  const includeArchived = String(q.include_archived || '').toLowerCase() === 'true'
  // Supabase branch removed
  if (hasPg) {
    const filter = includeArchived ? {} : { archived: false }
    pgSelect('landlords', '*', filter as any)
      .then(async (data) => {
        const rows = includeArchived ? (data || []) : (data || []).filter((x: any) => !x.archived)
        const withRules = await attachManagementFeeRules(rows as any[])
        res.json(withRules)
      })
      .catch((err) => res.status(500).json({ message: err.message }))
    return
  }
  return res.json((db.landlords || []).filter((l: any) => includeArchived ? true : !l.archived))
})

const schema = z.object({
  name: z.string().min(1),
  phone: z.string().optional(),
  emails: z.array(z.string()).optional(),
  email: z.string().optional(),
  management_fee_rate: z.number().optional(),
  payout_bsb: z.string().optional(),
  payout_account: z.string().optional(),
  property_ids: z.array(z.string()).optional(),
}).transform((v) => {
  const m = (v as any)
  if (!Array.isArray(m.emails)) m.emails = (m.email ? [m.email] : [])
  m.emails = (Array.isArray(m.emails) ? m.emails : []).map((s: any) => String(s||'').trim()).filter(Boolean)
  if (!m.email && Array.isArray(m.emails) && m.emails[0]) m.email = m.emails[0]
  if (m.management_fee !== undefined && m.management_fee_rate === undefined) m.management_fee_rate = m.management_fee
  return m
})

router.post('/', requirePerm('landlord.manage'), (req, res) => {
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const l: Landlord = { id: uuidv4(), ...parsed.data }
  // Supabase branch removed
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
  const bodyRaw = req.body as Partial<Landlord>
  const body: Partial<Landlord> = { ...bodyRaw }
  if (Array.isArray((body as any).emails)) {
    (body as any).emails = (body as any).emails.map((s: any) => String(s||'').trim()).filter(Boolean)
    if (!(body as any).email && (body as any).emails[0]) (body as any).email = (body as any).emails[0]
  } else if ((body as any).email) {
    (body as any).emails = [(body as any).email]
  }
  try {
    // Supabase branch removed
    if (hasPg) {
      const rows: any = await pgSelect('landlords', '*', { id })
      const before = rows && rows[0]
      const row = await pgUpdate('landlords', id, body)
      const out = row || { ...(before || {}), ...body, id }
      addAudit('Landlord', id, 'update', before, out)
      return res.json(out)
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
  // Supabase branch removed
  if (hasPg) {
    pgSelect('landlords', '*', { id })
      .then(async rows => {
        if (!rows || !rows[0]) return res.status(404).json({ message: 'not found' })
        const withRules = await attachManagementFeeRules(rows as any[])
        res.json(withRules[0])
      })
      .catch(err => res.status(500).json({ message: err.message }))
    return
  }
  const l = db.landlords.find(x => x.id === id)
  if (!l) return res.status(404).json({ message: 'not found' })
  return res.json(l)
})

const ruleSchema = z.object({
  effective_from_month: z.string().trim().regex(/^\d{4}-\d{2}$/),
  management_fee_rate: z.number().min(0).max(1),
  note: z.string().trim().max(500).optional(),
})

router.get('/:id/management-fee-rules', requirePerm('landlord.manage'), async (req, res) => {
  try {
    const { id } = req.params
    if (!hasPg) return res.json([])
    await ensureManagementFeeRulesTable()
    const rows = await listManagementFeeRulesByLandlordIds([id])
    return res.json(rows[String(id) || ''] || [])
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'list_failed' })
  }
})

router.post('/:id/management-fee-rules', requirePerm('landlord.manage'), async (req, res) => {
  try {
    const { id } = req.params
    if (!hasPg) return res.status(400).json({ message: 'pg required' })
    await ensureManagementFeeRulesTable()
    const parsed = ruleSchema.safeParse(req.body || {})
    if (!parsed.success) return res.status(400).json(parsed.error.format())
    const landlordRows = await pgSelect('landlords', '*', { id })
    const landlord = Array.isArray(landlordRows) ? landlordRows[0] : null
    if (!landlord) return res.status(404).json({ message: 'not found' })
    const v = parsed.data
    const dup = await pgSelect('landlord_management_fee_rules', '*', { landlord_id: id, effective_from_month: v.effective_from_month })
    if (Array.isArray(dup) && dup[0]) return res.status(409).json({ message: 'duplicate_effective_from_month' })
    const actor = (req as any)?.user?.sub || (req as any)?.user?.username || null
    const row = await pgInsert('landlord_management_fee_rules', {
      id: uuidv4(),
      landlord_id: id,
      effective_from_month: v.effective_from_month,
      management_fee_rate: v.management_fee_rate,
      note: v.note || null,
      created_by: actor,
    } as any)
    await syncLandlordCachedManagementFeeRate(id)
    addAudit('LandlordManagementFeeRule', String((row as any)?.id || ''), 'create', null, row, actor)
    return res.status(201).json(row)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'create_failed' })
  }
})

router.patch('/:id/management-fee-rules/:ruleId', requirePerm('landlord.manage'), async (req, res) => {
  try {
    const { id, ruleId } = req.params
    if (!hasPg) return res.status(400).json({ message: 'pg required' })
    await ensureManagementFeeRulesTable()
    const parsed = ruleSchema.partial().safeParse(req.body || {})
    if (!parsed.success) return res.status(400).json(parsed.error.format())
    const patch = parsed.data
    if (patch.effective_from_month && !isValidMonthKey(patch.effective_from_month)) return res.status(400).json({ message: 'invalid_effective_from_month' })
    const rows = await pgSelect('landlord_management_fee_rules', '*', { id: ruleId, landlord_id: id })
    const before = Array.isArray(rows) ? rows[0] : null
    if (!before) return res.status(404).json({ message: 'not found' })
    const structuralChange =
      (patch.effective_from_month !== undefined && String(patch.effective_from_month) !== String(before.effective_from_month || '')) ||
      (patch.management_fee_rate !== undefined && Number(patch.management_fee_rate || 0) !== Number(before.management_fee_rate || 0))
    if (structuralChange) {
      const used = await ruleHasRecordedManagementFeeUsage(id, String(before.effective_from_month || ''))
      if (used) return res.status(409).json({ message: 'rule_in_use' })
      if (patch.effective_from_month) {
        const dup = await pgSelect('landlord_management_fee_rules', '*', { landlord_id: id, effective_from_month: patch.effective_from_month })
        const hit = Array.isArray(dup) ? dup.find((x: any) => String(x?.id || '') !== String(ruleId)) : null
        if (hit) return res.status(409).json({ message: 'duplicate_effective_from_month' })
      }
    }
    const actor = (req as any)?.user?.sub || (req as any)?.user?.username || null
    const row = await pgUpdate('landlord_management_fee_rules', ruleId, {
      ...(patch.effective_from_month !== undefined ? { effective_from_month: patch.effective_from_month } : {}),
      ...(patch.management_fee_rate !== undefined ? { management_fee_rate: patch.management_fee_rate } : {}),
      ...(patch.note !== undefined ? { note: patch.note || null } : {}),
    } as any)
    await syncLandlordCachedManagementFeeRate(id)
    addAudit('LandlordManagementFeeRule', String(ruleId), 'update', before, row, actor)
    return res.json(row)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'update_failed' })
  }
})

router.delete('/:id/management-fee-rules/:ruleId', requirePerm('landlord.manage'), async (req, res) => {
  try {
    const { id, ruleId } = req.params
    if (!hasPg) return res.status(400).json({ message: 'pg required' })
    await ensureManagementFeeRulesTable()
    const rows = await pgSelect('landlord_management_fee_rules', '*', { id: ruleId, landlord_id: id })
    const before = Array.isArray(rows) ? rows[0] : null
    if (!before) return res.status(404).json({ message: 'not found' })
    const all = await listManagementFeeRulesByLandlordIds([id])
    const rules = all[String(id) || ''] || []
    if (rules[0] && String((rules[0] as any).id || '') !== String(ruleId)) return res.status(409).json({ message: 'only_latest_rule_can_delete' })
    const used = await ruleHasRecordedManagementFeeUsage(id, String(before.effective_from_month || ''))
    if (used) return res.status(409).json({ message: 'rule_in_use' })
    const actor = (req as any)?.user?.sub || (req as any)?.user?.username || null
    await pgDelete('landlord_management_fee_rules', ruleId)
    await syncLandlordCachedManagementFeeRate(id)
    addAudit('LandlordManagementFeeRule', String(ruleId), 'delete', before, null, actor)
    return res.json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'delete_failed' })
  }
})

router.delete('/:id', requirePerm('landlord.manage'), async (req, res) => {
  const { id } = req.params
  const actor = (req as any).user
  try {
    // Supabase branch removed
    if (hasPg) {
      const rows: any = await pgSelect('landlords', '*', { id })
      const before = rows && rows[0]
      const row = await pgUpdate('landlords', id, { archived: true })
      const out = row || { ...(before || {}), id, archived: true }
      addAudit('Landlord', id, 'archive', before, out, actor?.sub)
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
