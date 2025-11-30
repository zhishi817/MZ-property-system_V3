import { Router } from 'express'
import { requireAnyPerm } from '../auth'
import { hasPg, pgSelect, pgInsert, pgUpdate, pgDelete } from '../dbAdapter'
import { hasSupabase, supaSelect, supaInsert, supaUpdate, supaDelete } from '../supabase'
import { db, addAudit } from '../store'

const router = Router()

const ALLOW: Record<string, true> = {
  properties: true,
  landlords: true,
  orders: true,
  cleaning_tasks: true,
  finance_transactions: true,
  company_expenses: true,
  property_expenses: true,
  company_incomes: true,
  property_incomes: true,
  payouts: true,
  company_payouts: true,
  users: true,
}

function okResource(r: string): boolean { return !!ALLOW[r] }

router.get('/:resource', requireAnyPerm(['rbac.manage','property.write','order.view','finance.tx.write','finance.payout']), async (req, res) => {
  const { resource } = req.params
  if (!okResource(resource)) return res.status(404).json({ message: 'resource not allowed' })
  const filter: Record<string, any> = { ...(req.query || {}) }
  delete filter.limit; delete filter.offset; delete filter.order
  try {
    if (hasPg) {
      const rows = (await pgSelect(resource, '*', Object.keys(filter).length ? filter : undefined)) as any[] || []
      return res.json(rows)
    }
    if (hasSupabase) {
      const rows = (await supaSelect(resource, '*', Object.keys(filter).length ? filter : undefined)) as any[] || []
      return res.json(rows)
    }
    // in-memory fallback
    const arr = (db as any)[camelToArrayKey(resource)] || []
    const filtered = arr.filter((r: any) => Object.entries(filter).every(([k,v]) => (r?.[k]) == v))
    return res.json(filtered)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'list failed' })
  }
})

router.get('/:resource/:id', requireAnyPerm(['rbac.manage','property.write','order.view','finance.tx.write','finance.payout']), async (req, res) => {
  const { resource, id } = req.params
  if (!okResource(resource)) return res.status(404).json({ message: 'resource not allowed' })
  try {
    if (hasPg) {
      const rows = (await pgSelect(resource, '*', { id })) as any[] || []
      return rows[0] ? res.json(rows[0]) : res.status(404).json({ message: 'not found' })
    }
    if (hasSupabase) {
      const rows = (await supaSelect(resource, '*', { id })) as any[] || []
      return rows[0] ? res.json(rows[0]) : res.status(404).json({ message: 'not found' })
    }
    const arr = (db as any)[camelToArrayKey(resource)] || []
    const found = arr.find((x: any) => x.id === id)
    return found ? res.json(found) : res.status(404).json({ message: 'not found' })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'get failed' })
  }
})

router.post('/:resource', requireAnyPerm(['rbac.manage','property.write','order.write','finance.tx.write','finance.payout']), async (req, res) => {
  const { resource } = req.params
  if (!okResource(resource)) return res.status(404).json({ message: 'resource not allowed' })
  const payload = { ...(req.body || {}) }
  if (!payload.id) payload.id = require('uuid').v4()
  try {
    if (hasPg) {
      if (resource === 'company_expenses') {
        const dup = await pgSelect(resource, '*', { occurred_at: payload.occurred_at, category: payload.category, amount: payload.amount, note: payload.note })
        if (Array.isArray(dup) && dup[0]) return res.status(409).json({ message: '重复记录：公司支出已存在' })
      }
      if (resource === 'property_expenses') {
        const dup = await pgSelect(resource, '*', { property_id: payload.property_id, occurred_at: payload.occurred_at, category: payload.category, amount: payload.amount, note: payload.note })
        if (Array.isArray(dup) && dup[0]) return res.status(409).json({ message: '重复记录：房源支出已存在' })
      }
      if (resource === 'company_incomes') {
        const dup = await pgSelect(resource, '*', { occurred_at: payload.occurred_at, category: payload.category, amount: payload.amount, note: payload.note })
        if (Array.isArray(dup) && dup[0]) return res.status(409).json({ message: '重复记录：公司收入已存在' })
      }
      if (resource === 'property_incomes') {
        const dup = await pgSelect(resource, '*', { property_id: payload.property_id, occurred_at: payload.occurred_at, category: payload.category, amount: payload.amount, note: payload.note })
        if (Array.isArray(dup) && dup[0]) return res.status(409).json({ message: '重复记录：房源收入已存在' })
      }
    }
  } catch {}
  try {
    if (hasPg) {
      const row = await pgInsert(resource, payload)
      addAudit(resource, String((row as any)?.id || ''), 'create', null, row, (req as any).user?.sub)
      return res.status(201).json(row)
    }
    if (hasSupabase) {
      const row = await supaInsert(resource, payload)
      addAudit(resource, String((row as any)?.id || ''), 'create', null, row, (req as any).user?.sub)
      return res.status(201).json(row)
    }
    const arrKey = camelToArrayKey(resource)
    const id = payload.id || require('uuid').v4()
    const row = { ...payload, id }
    ;((db as any)[arrKey] = (db as any)[arrKey] || []).push(row)
    addAudit(resource, String(id), 'create', null, row, (req as any).user?.sub)
    return res.status(201).json(row)
  } catch (e: any) {
    const msg = String(e?.message || '')
    if (/duplicate|unique/i.test(msg)) return res.status(409).json({ message: '唯一键冲突' })
    return res.status(500).json({ message: msg || 'create failed' })
  }
})

router.patch('/:resource/:id', requireAnyPerm(['rbac.manage','property.write','order.write','finance.tx.write','finance.payout']), async (req, res) => {
  const { resource, id } = req.params
  if (!okResource(resource)) return res.status(404).json({ message: 'resource not allowed' })
  const payload = req.body || {}
  try {
    if (hasPg) {
      const row = await pgUpdate(resource, id, payload)
      addAudit(resource, id, 'update', null, row, (req as any).user?.sub)
      return res.json(row || { id, ...payload })
    }
    if (hasSupabase) {
      const row = await supaUpdate(resource, id, payload)
      addAudit(resource, id, 'update', null, row, (req as any).user?.sub)
      return res.json(row || { id, ...payload })
    }
    const arrKey = camelToArrayKey(resource)
    const arr = (db as any)[arrKey] || []
    const idx = arr.findIndex((x: any) => x.id === id)
    const merged = { ...(arr[idx] || { id }), ...payload }
    if (idx !== -1) arr[idx] = merged; else arr.push(merged)
    addAudit(resource, id, 'update', null, merged, (req as any).user?.sub)
    return res.json(merged)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'update failed' })
  }
})

router.delete('/:resource/:id', requireAnyPerm(['rbac.manage','property.write','order.write','finance.tx.write','finance.payout']), async (req, res) => {
  const { resource, id } = req.params
  if (!okResource(resource)) return res.status(404).json({ message: 'resource not allowed' })
  try {
    if (hasPg) {
      await pgDelete(resource, id)
      addAudit(resource, id, 'delete', null, null, (req as any).user?.sub)
      return res.json({ ok: true })
    }
    if (hasSupabase) {
      await supaDelete(resource, id)
      addAudit(resource, id, 'delete', null, null, (req as any).user?.sub)
      return res.json({ ok: true })
    }
    const arrKey = camelToArrayKey(resource)
    const arr = (db as any)[arrKey] || []
    const idx = arr.findIndex((x: any) => x.id === id)
    if (idx !== -1) arr.splice(idx, 1)
    addAudit(resource, id, 'delete', null, null, (req as any).user?.sub)
    return res.json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'delete failed' })
  }
})

function camelToArrayKey(r: string): string {
  // properties -> properties, finance_transactions -> financeTransactions etc.
  return r.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
}

export default router