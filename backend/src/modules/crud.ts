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
  cms_pages: true,
  payouts: true,
  company_payouts: true,
  users: true,
  property_maintenance: true,
}

function okResource(r: string): boolean { return !!ALLOW[r] }

router.get('/:resource', requireAnyPerm(['rbac.manage','property.write','order.view','finance.tx.write','finance.payout']), async (req, res) => {
  const { resource } = req.params
  if (!okResource(resource)) return res.status(404).json({ message: 'resource not allowed' })
  const filter: Record<string, any> = { ...(req.query || {}) }
  const user = (req as any).user || {}
  if (user?.role === 'customer_service' && resource === 'property_expenses') {
    filter.created_by = user.sub
  }
  delete filter.limit; delete filter.offset; delete filter.order
  try {
    if (hasPg) {
      const rows = (await pgSelect(resource, '*', Object.keys(filter).length ? filter : undefined)) as any[] || []
      if (resource === 'property_expenses') {
        let props: any[] = []
        try { props = (await pgSelect('properties', 'id,code,address')) as any[] || [] } catch {}
        const byId: Record<string, any> = Object.fromEntries(props.map(p => [String(p.id), p]))
        const byCode: Record<string, any> = Object.fromEntries(props.map(p => [String(p.code || ''), p]))
        const labeled = rows.map(r => {
          const pid = String(r.property_id || '')
          const p = byId[pid] || byCode[pid]
          const label = p?.code || p?.address || pid || ''
          return { ...r, property_code: label }
        })
        return res.json(labeled)
      }
      return res.json(rows)
    }
    if (hasSupabase) {
      const rows = (await supaSelect(resource, '*', Object.keys(filter).length ? filter : undefined)) as any[] || []
      if (resource === 'property_expenses') {
        let props: any[] = []
        try { props = (await supaSelect('properties', 'id,code,address')) as any[] || [] } catch {}
        const byId: Record<string, any> = Object.fromEntries(props.map(p => [String(p.id), p]))
        const byCode: Record<string, any> = Object.fromEntries(props.map(p => [String(p.code || ''), p]))
        const labeled = rows.map(r => {
          const pid = String(r.property_id || '')
          const p = byId[pid] || byCode[pid]
          const label = p?.code || p?.address || pid || ''
          return { ...r, property_code: label }
        })
        return res.json(labeled)
      }
      return res.json(rows)
    }
    // in-memory fallback
    const arr = (db as any)[camelToArrayKey(resource)] || []
    const filtered = arr.filter((r: any) => Object.entries(filter).every(([k,v]) => (r?.[k]) == v))
    if (resource === 'property_expenses') {
      const labeled = filtered.map((r: any) => {
        const pid = String(r.property_id || '')
        const p = (db as any).properties.find((pp: any) => String(pp.id) === pid) || (db as any).properties.find((pp: any) => String(pp.code || '') === pid)
        const label = (p?.code || p?.address || pid || '')
        return { ...r, property_code: label }
      })
      return res.json(labeled)
    }
    return res.json(filtered)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'list failed' })
  }
});

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
  const user = (req as any).user || {}
  let detailsRaw: any[] = []
  if (resource === 'property_expenses' || resource === 'company_expenses' || resource === 'property_incomes' || resource === 'company_incomes' || resource === 'property_maintenance') {
    if (!payload.created_by) payload.created_by = user.sub || user.username || 'unknown'
  }
  if (resource === 'property_maintenance') {
    try {
      detailsRaw = Array.isArray(payload.details)
        ? payload.details
        : (typeof payload.details === 'string'
            ? (() => { try { return JSON.parse(payload.details) } catch { return [] } })()
            : [])
      if (hasPg) {
        if (payload.details && typeof payload.details !== 'string') payload.details = JSON.stringify(payload.details)
      } else if (hasSupabase) {
        if (payload.details && typeof payload.details === 'string') {
          try { payload.details = JSON.parse(payload.details) } catch {}
        }
      }
      if (payload.photo_urls && !Array.isArray(payload.photo_urls)) payload.photo_urls = [payload.photo_urls]
      // Resolve property_id by id or code (robust)
      try {
        const val = String(payload.property_id || '').trim()
        const code = String(payload.property_code || '').trim()
        if (hasPg) {
          const { pgPool } = require('../dbAdapter')
          if (pgPool) {
            const qres = await pgPool.query('SELECT id FROM properties WHERE id = $1 OR lower(code) = lower($1) OR lower(code) = lower($2) LIMIT 1', [val || null, code || null])
            if (qres.rows && qres.rows[0] && qres.rows[0].id) payload.property_id = qres.rows[0].id
            if (payload.property_id) {
              const chk = await pgPool.query('SELECT 1 FROM properties WHERE id = $1 LIMIT 1', [payload.property_id])
              if (!chk.rows || !chk.rows[0]) {
                payload.property_id = null
              }
            }
          }
        } else if (hasSupabase) {
          const byCode = code ? await supaSelect('properties', 'id', { code }) : []
          if (byCode && (byCode as any[])[0] && (byCode as any[])[0].id) payload.property_id = (byCode as any[])[0].id
          if (payload.property_id) {
            const byId = await supaSelect('properties', 'id', { id: payload.property_id })
            if (!byId || !(byId as any[])[0]) payload.property_id = null
          }
        }
      } catch {}
    } catch {}
  }
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
      let row = null
      try {
        if (resource === 'property_maintenance') {
          const { pgPool } = require('../dbAdapter')
          const sql = `INSERT INTO property_maintenance (id, property_id, occurred_at, worker_name, details, notes, created_by, photo_urls, property_code)
            VALUES ($1,$2,$3,$4,$5::text,$6,$7,$8::jsonb,$9) RETURNING *`
          const detailsArr = Array.isArray(detailsRaw) ? detailsRaw : []
          if (detailsArr.length > 1) {
            const created: any[] = []
            for (const d of detailsArr) {
              const id = require('uuid').v4()
              const values = [
                id,
                payload.property_id || null,
                payload.occurred_at || new Date().toISOString().slice(0,10),
                payload.worker_name || '',
                typeof d === 'string' ? JSON.stringify([d]) : JSON.stringify([d || {}]),
                payload.notes || '',
                payload.created_by || null,
                JSON.stringify(Array.isArray(payload.photo_urls) ? payload.photo_urls : []),
                payload.property_code || null
              ]
              const r1 = await pgPool.query(sql, values)
              if (r1.rows && r1.rows[0]) created.push(r1.rows[0])
            }
            row = created
          } else {
            const values = [
              payload.id,
              payload.property_id || null,
              payload.occurred_at || new Date().toISOString().slice(0,10),
              payload.worker_name || '',
              typeof payload.details === 'string' ? payload.details : JSON.stringify(payload.details || []),
              payload.notes || '',
              payload.created_by || null,
              JSON.stringify(Array.isArray(payload.photo_urls) ? payload.photo_urls : []),
              payload.property_code || null
            ]
            const res = await pgPool.query(sql, values)
            row = res.rows && res.rows[0]
          }
        } else {
          row = await pgInsert(resource, payload)
        }
      } catch (e: any) {
        const msg = String(e?.message || '')
        if (resource === 'property_maintenance' && /does not exist|relation .* does not exist/i.test(msg)) {
          try {
            const { pgPool } = require('../dbAdapter')
            if (pgPool) {
              await pgPool.query(`CREATE TABLE IF NOT EXISTS property_maintenance (
                id text PRIMARY KEY,
                property_id text REFERENCES properties(id) ON DELETE SET NULL,
                occurred_at date NOT NULL,
                worker_name text,
                details text,
                notes text,
                created_by text,
                created_at timestamptz DEFAULT now()
              );`)
              await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_property_maintenance_pid ON property_maintenance(property_id);`)
              await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_property_maintenance_date ON property_maintenance(occurred_at);`)
              await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS photo_urls jsonb;`)
              await pgPool.query(`ALTER TABLE property_maintenance ALTER COLUMN details TYPE text USING details::text;`)
              const sql2 = `INSERT INTO property_maintenance (id, property_id, occurred_at, worker_name, details, notes, created_by, photo_urls, property_code)
                VALUES ($1,$2,$3,$4,$5::text,$6,$7,$8::jsonb,$9) RETURNING *`
              const detailsArr = Array.isArray(payload.details) ? payload.details : (payload.details ? [payload.details] : [])
              if (detailsArr.length > 1) {
                const created: any[] = []
                for (const d of detailsArr) {
                  const id = require('uuid').v4()
                  const values2 = [id, payload.property_id || null, payload.occurred_at || new Date().toISOString().slice(0,10), payload.worker_name || '', JSON.stringify([d || {}]), payload.notes || '', payload.created_by || null, JSON.stringify(Array.isArray(payload.photo_urls) ? payload.photo_urls : []), payload.property_code || null]
                  const res2 = await pgPool.query(sql2, values2)
                  if (res2.rows && res2.rows[0]) created.push(res2.rows[0])
                }
                row = created
              } else {
                const values2 = [payload.id, payload.property_id || null, payload.occurred_at || new Date().toISOString().slice(0,10), payload.worker_name || '', JSON.stringify(detailsArr || []), payload.notes || '', payload.created_by || null, JSON.stringify(Array.isArray(payload.photo_urls) ? payload.photo_urls : []), payload.property_code || null]
                const res2 = await pgPool.query(sql2, values2)
                row = res2.rows && res2.rows[0]
              }
            }
          } catch (e2) {
            return res.status(500).json({ message: (e2 as any)?.message || 'create failed (table init)' })
          }
        } else if (resource === 'property_maintenance' && /column\s+"?property_code"?\s+of\s+relation\s+"?property_maintenance"?\s+does\s+not\s+exist/i.test(msg)) {
          try {
            const { pgPool } = require('../dbAdapter')
            if (pgPool) {
              await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS property_code text;`)
              await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS photo_urls jsonb;`)
              await pgPool.query(`ALTER TABLE property_maintenance ALTER COLUMN details TYPE text USING details::text;`)
              const sql2 = `INSERT INTO property_maintenance (id, property_id, occurred_at, worker_name, details, notes, created_by, photo_urls, property_code)
                VALUES ($1,$2,$3,$4,$5::text,$6,$7,$8::jsonb,$9) RETURNING *`
              const detailsArr = Array.isArray(detailsRaw) ? detailsRaw : []
              if (detailsArr.length > 1) {
                const created: any[] = []
                for (const d of detailsArr) {
                  const id = require('uuid').v4()
                  const values2 = [id, payload.property_id || null, payload.occurred_at || new Date().toISOString().slice(0,10), payload.worker_name || '', JSON.stringify([d || {}]), payload.notes || '', payload.created_by || null, JSON.stringify(Array.isArray(payload.photo_urls) ? payload.photo_urls : []), payload.property_code || null]
                  const res2 = await pgPool.query(sql2, values2)
                  if (res2.rows && res2.rows[0]) created.push(res2.rows[0])
                }
                row = created
              } else {
                const values2 = [payload.id, payload.property_id || null, payload.occurred_at || new Date().toISOString().slice(0,10), payload.worker_name || '', JSON.stringify(detailsArr || []), payload.notes || '', payload.created_by || null, JSON.stringify(Array.isArray(payload.photo_urls) ? payload.photo_urls : []), payload.property_code || null]
                const res2 = await pgPool.query(sql2, values2)
                row = res2.rows && res2.rows[0]
              }
            }
          } catch (e3) {
            return res.status(500).json({ message: (e3 as any)?.message || 'create failed (column add)' })
          }
        } else if (resource === 'property_maintenance' && /column\s+"?photo_urls"?\s+.*type\s+text\[\].*jsonb/i.test(msg)) {
          try {
            const { pgPool } = require('../dbAdapter')
            if (pgPool) {
              const sql2 = `INSERT INTO property_maintenance (id, property_id, occurred_at, worker_name, details, notes, created_by, photo_urls, property_code)
                VALUES ($1,$2,$3,$4,$5::text,$6,$7,$8::text[],$9) RETURNING *`
              const detailsArr = Array.isArray(detailsRaw) ? detailsRaw : []
              if (detailsArr.length > 1) {
                const created: any[] = []
                for (const d of detailsArr) {
                  const id = require('uuid').v4()
                  const values2 = [id, payload.property_id || null, payload.occurred_at || new Date().toISOString().slice(0,10), payload.worker_name || '', JSON.stringify([d || {}]), payload.notes || '', payload.created_by || null, (Array.isArray(payload.photo_urls) ? payload.photo_urls : []), payload.property_code || null]
                  const res2 = await pgPool.query(sql2, values2)
                  if (res2.rows && res2.rows[0]) created.push(res2.rows[0])
                }
                row = created
              } else {
                const values2 = [payload.id, payload.property_id || null, payload.occurred_at || new Date().toISOString().slice(0,10), payload.worker_name || '', JSON.stringify(detailsArr || []), payload.notes || '', payload.created_by || null, (Array.isArray(payload.photo_urls) ? payload.photo_urls : []), payload.property_code || null]
                const res2 = await pgPool.query(sql2, values2)
                row = res2.rows && res2.rows[0]
              }
            }
          } catch (e3) {
            return res.status(500).json({ message: (e3 as any)?.message || 'create failed (photo_urls text[])' })
          }
        } else {
          return res.status(500).json({ message: msg || 'create failed' })
        }
      }
      addAudit(resource, String((row as any)?.id || ''), 'create', null, row, (req as any).user?.sub)
      return res.status(201).json(row)
    }
    const arrKey = camelToArrayKey(resource)
    const id = payload.id || require('uuid').v4()
    if (resource === 'property_maintenance') {
      const detailsArr = Array.isArray(payload.details) ? payload.details : (payload.details ? [payload.details] : [])
      const created: any[] = []
      if (detailsArr.length > 1) {
        for (const d of detailsArr) {
          const rid = require('uuid').v4()
          const row = { ...payload, id: rid, details: Array.isArray(d) ? d : [d] }
          ;((db as any)[arrKey] = (db as any)[arrKey] || []).push(row)
          created.push(row)
        }
        addAudit(resource, String(created[0]?.id || ''), 'create', null, created, (req as any).user?.sub)
        return res.status(201).json(created)
      }
      const row = { ...payload, id }
      ;((db as any)[arrKey] = (db as any)[arrKey] || []).push(row)
      addAudit(resource, String(id), 'create', null, row, (req as any).user?.sub)
      return res.status(201).json(row)
    }
  } catch (e: any) {
    const msg = String(e?.message || '')
    if (/duplicate|unique/i.test(msg)) return res.status(409).json({ message: '唯一键冲突' })
    return res.status(500).json({ message: msg || 'create failed' })
  }
});

router.patch('/:resource/:id', requireAnyPerm(['rbac.manage','property.write','order.write','finance.tx.write','finance.payout']), async (req, res) => {
  const { resource, id } = req.params
  if (!okResource(resource)) return res.status(404).json({ message: 'resource not allowed' })
  const payload = req.body || {}
  if (resource === 'property_maintenance') { delete (payload as any).property_code }
  const user = (req as any).user || {}
  if (user?.role === 'customer_service' && resource === 'property_expenses') {
    try {
      if (hasPg) {
        const rows = (await pgSelect(resource, '*', { id })) as any[] || []
        const row = rows[0]
        if (row && row.created_by && row.created_by !== user.sub) return res.status(403).json({ message: 'forbidden' })
      }
    } catch {}
  }
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