import { Router } from 'express'
import { requireAnyPerm, requireResourcePerm } from '../auth'
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
  fixed_expenses: true,
  company_incomes: true,
  property_incomes: true,
  recurring_payments: true,
  cms_pages: true,
  payouts: true,
  company_payouts: true,
  users: true,
  property_maintenance: true,
}

function okResource(r: string): boolean { return !!ALLOW[r] }

router.get('/:resource', requireResourcePerm('view'), async (req, res) => {
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
      try {
        const rows: any[] = []
        const { pgPool } = require('../dbAdapter')
        function buildWhere(filters?: Record<string, any>) {
          const keys = Object.keys(filters || {})
          if (!keys.length) return { clause: '', values: [] as any[] }
          const parts = keys.map((k, i) => `${k} = $${i + 1}`)
          const values = keys.map((k) => (filters as any)[k])
          return { clause: ` WHERE ${parts.join(' AND ')}`, values }
        }
        const w = buildWhere(Object.keys(filter).length ? filter : undefined)
        let orderBy = ''
        if (resource === 'property_expenses' || resource === 'company_expenses') {
          orderBy = ' ORDER BY due_date ASC NULLS LAST, paid_date ASC NULLS LAST, occurred_at ASC'
        } else if (resource === 'recurring_payments') {
          orderBy = ' ORDER BY next_due_date ASC NULLS LAST, due_day_of_month ASC, vendor ASC'
        } else if (resource === 'fixed_expenses') {
          orderBy = ' ORDER BY due_day_of_month ASC, vendor ASC'
        }
        if (pgPool) {
          try {
            if (resource === 'property_expenses') {
              const rowsRaw = await pgSelect(resource, '*', Object.keys(filter).length ? filter : undefined)
              rows.push(...(Array.isArray(rowsRaw) ? rowsRaw : []))
            } else {
              const sql = `SELECT * FROM ${resource}${w.clause}${orderBy}`
              const resq = await pgPool.query(sql, w.values)
              rows.push(...(resq?.rows || []))
            }
          } catch (e: any) {
            const msg = String(e?.message || '')
            if (resource === 'fixed_expenses' && /relation\s+"?fixed_expenses"?\s+does\s+not\s+exist/i.test(msg)) {
              await pgPool.query(`CREATE TABLE IF NOT EXISTS fixed_expenses (
                id text PRIMARY KEY,
                property_id text REFERENCES properties(id) ON DELETE SET NULL,
                scope text,
                vendor text,
                category text,
                amount numeric,
                due_day_of_month integer,
                remind_days_before integer,
                status text,
                pay_account_name text,
                pay_bsb text,
                pay_account_number text,
                pay_ref text,
                created_at timestamptz DEFAULT now(),
                updated_at timestamptz
              );`)
              await pgPool.query('CREATE INDEX IF NOT EXISTS idx_fixed_expenses_scope ON fixed_expenses(scope);')
              await pgPool.query('CREATE INDEX IF NOT EXISTS idx_fixed_expenses_status ON fixed_expenses(status);')
              const sql2 = `SELECT * FROM ${resource}${w.clause}${orderBy}`
              const res2 = await pgPool.query(sql2, w.values)
              rows.push(...(res2?.rows || []))
            } else {
              throw e
            }
          }
        }
        if (resource === 'property_expenses') {
          let props: any[] = []
          try { const propsRaw = await pgSelect('properties', 'id,code,address'); props = Array.isArray(propsRaw) ? propsRaw : [] } catch {}
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
      } catch {}
    }
    if (hasSupabase) {
      const rowsRaw = await supaSelect(resource, '*', Object.keys(filter).length ? filter : undefined)
      const rows: any[] = Array.isArray(rowsRaw) ? rowsRaw : []
      if (resource === 'property_expenses') {
        let props: any[] = []
        try { const propsRaw = await supaSelect('properties', 'id,code,address'); props = Array.isArray(propsRaw) ? propsRaw : [] } catch {}
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
    let filtered = arr.filter((r: any) => Object.entries(filter).every(([k,v]) => (r?.[k]) == v))
    if (resource === 'property_expenses' || resource === 'company_expenses') {
      filtered = filtered.sort((a: any, b: any) => {
        const av = a?.due_date ? new Date(a.due_date).getTime() : Number.POSITIVE_INFINITY
        const bv = b?.due_date ? new Date(b.due_date).getTime() : Number.POSITIVE_INFINITY
        if (av !== bv) return av - bv
        const ap = a?.paid_date ? new Date(a.paid_date).getTime() : Number.POSITIVE_INFINITY
        const bp = b?.paid_date ? new Date(b.paid_date).getTime() : Number.POSITIVE_INFINITY
        if (ap !== bp) return ap - bp
        const ao = a?.occurred_at ? new Date(a.occurred_at).getTime() : Number.POSITIVE_INFINITY
        const bo = b?.occurred_at ? new Date(b.occurred_at).getTime() : Number.POSITIVE_INFINITY
        return ao - bo
      })
    } else if (resource === 'recurring_payments') {
      filtered = filtered.sort((a: any, b: any) => {
        const av = a?.next_due_date ? new Date(a.next_due_date).getTime() : Number.POSITIVE_INFINITY
        const bv = b?.next_due_date ? new Date(b.next_due_date).getTime() : Number.POSITIVE_INFINITY
        if (av !== bv) return av - bv
        const ad = Number(a?.due_day_of_month || 0)
        const bd = Number(b?.due_day_of_month || 0)
        if (ad !== bd) return ad - bd
        return String(a?.vendor || '').localeCompare(String(b?.vendor || ''))
      })
    } else if (resource === 'fixed_expenses') {
      filtered = filtered.sort((a: any, b: any) => {
        const ad = Number(a?.due_day_of_month || 0)
        const bd = Number(b?.due_day_of_month || 0)
        if (ad !== bd) return ad - bd
        return String(a?.vendor || '').localeCompare(String(b?.vendor || ''))
      })
    }
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

router.get('/:resource/:id', requireResourcePerm('view'), async (req, res) => {
  const { resource, id } = req.params
  if (!okResource(resource)) return res.status(404).json({ message: 'resource not allowed' })
  try {
    if (hasPg) {
      const rowsRaw = await pgSelect(resource, '*', { id })
      const rows: any[] = Array.isArray(rowsRaw) ? rowsRaw : []
      return rows[0] ? res.json(rows[0]) : res.status(404).json({ message: 'not found' })
    }
    if (hasSupabase) {
      const rowsRaw = await supaSelect(resource, '*', { id })
      const rows: any[] = Array.isArray(rowsRaw) ? rowsRaw : []
      return rows[0] ? res.json(rows[0]) : res.status(404).json({ message: 'not found' })
    }
    const arr = (db as any)[camelToArrayKey(resource)] || []
    const found = arr.find((x: any) => x.id === id)
    return found ? res.json(found) : res.status(404).json({ message: 'not found' })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'get failed' })
  }
})

router.post('/:resource', requireResourcePerm('write'), async (req, res) => {
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
          const byCodeRaw = code ? await supaSelect('properties', 'id', { code }) : null
          const byCode: any[] = Array.isArray(byCodeRaw) ? byCodeRaw : []
          if (byCode[0]?.id) payload.property_id = byCode[0].id
          if (payload.property_id) {
            const byIdRaw = await supaSelect('properties', 'id', { id: payload.property_id })
            const byId: any[] = Array.isArray(byIdRaw) ? byIdRaw : []
            if (!byId[0]) payload.property_id = null
          }
        }
      } catch {}
    } catch {}
  }
  try {
    if (hasPg) {
      if (resource === 'company_expenses') {
        const dup = payload.fixed_expense_id && payload.month_key
          ? await pgSelect(resource, '*', { fixed_expense_id: payload.fixed_expense_id, month_key: payload.month_key })
          : await pgSelect(resource, '*', { occurred_at: payload.occurred_at, category: payload.category, amount: payload.amount, note: payload.note })
        if (Array.isArray(dup) && dup[0]) return res.status(409).json({ message: '重复记录：公司支出已存在' })
      }
      if (resource === 'property_expenses') {
        const dup = payload.fixed_expense_id && payload.month_key
          ? await pgSelect(resource, '*', { fixed_expense_id: payload.fixed_expense_id, month_key: payload.month_key })
          : await pgSelect(resource, '*', { property_id: payload.property_id, occurred_at: payload.occurred_at, category: payload.category, amount: payload.amount, note: payload.note })
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
          let toInsert: any = payload
          if (resource === 'property_expenses') {
            const allow = ['id','occurred_at','amount','currency','category','category_detail','note','invoice_url','property_id','created_by','fixed_expense_id','month_key','due_date','paid_date','status']
            const cleaned: any = { id: payload.id }
            for (const k of allow) { if ((payload as any)[k] !== undefined) cleaned[k] = (payload as any)[k] }
            if (cleaned.amount !== undefined) cleaned.amount = Number(cleaned.amount || 0)
            if (cleaned.occurred_at) cleaned.occurred_at = String(cleaned.occurred_at).slice(0,10)
            if (cleaned.due_date) cleaned.due_date = String(cleaned.due_date).slice(0,10)
            if (cleaned.paid_date) cleaned.paid_date = String(cleaned.paid_date).slice(0,10)
            toInsert = cleaned
          } else if (resource === 'company_expenses') {
            const allow = ['id','occurred_at','amount','currency','category','category_detail','note','invoice_url','fixed_expense_id','month_key','due_date','paid_date','status']
            const cleaned: any = { id: payload.id }
            for (const k of allow) { if ((payload as any)[k] !== undefined) cleaned[k] = (payload as any)[k] }
            if (cleaned.amount !== undefined) cleaned.amount = Number(cleaned.amount || 0)
            if (cleaned.occurred_at) cleaned.occurred_at = String(cleaned.occurred_at).slice(0,10)
            if (cleaned.due_date) cleaned.due_date = String(cleaned.due_date).slice(0,10)
            if (cleaned.paid_date) cleaned.paid_date = String(cleaned.paid_date).slice(0,10)
            toInsert = cleaned
          } else if (resource === 'recurring_payments') {
            const allow = ['id','property_id','scope','vendor','category','category_detail','amount','due_day_of_month','remind_days_before','status','last_paid_date','next_due_date','pay_account_name','pay_bsb','pay_account_number','pay_ref','expense_id','expense_resource']
            const cleaned: any = { id: payload.id }
            for (const k of allow) { if ((payload as any)[k] !== undefined) cleaned[k] = (payload as any)[k] }
            if (cleaned.amount !== undefined) cleaned.amount = Number(cleaned.amount || 0)
            cleaned.remind_days_before = 3
            const today = new Date()
            const d0 = typeof cleaned.last_paid_date === 'string' ? new Date(cleaned.last_paid_date) : null
            const base = d0 && !isNaN(d0.getTime()) ? d0 : today
            const due = Number(cleaned.due_day_of_month || 1)
            const y = base.getUTCFullYear()
            const m = base.getUTCMonth()
            const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate()
            const targetDayThis = Math.min(due, daysInMonth)
            const thisDue = new Date(Date.UTC(y, m, targetDayThis))
            let next: Date
            if (base.getUTCDate() < targetDayThis) {
              next = thisDue
            } else {
              const y2 = m === 11 ? y + 1 : y
              const m2 = (m + 1) % 12
              const dim2 = new Date(Date.UTC(y2, m2 + 1, 0)).getUTCDate()
              next = new Date(Date.UTC(y2, m2, Math.min(due, dim2)))
            }
            if (!cleaned.next_due_date) cleaned.next_due_date = next.toISOString().slice(0,10)
            toInsert = cleaned
          } else if (resource === 'fixed_expenses') {
            const allow = ['id','property_id','scope','vendor','category','amount','due_day_of_month','remind_days_before','status','pay_account_name','pay_bsb','pay_account_number','pay_ref']
            const cleaned: any = { id: payload.id }
            for (const k of allow) { if ((payload as any)[k] !== undefined) cleaned[k] = (payload as any)[k] }
            if (cleaned.amount !== undefined) cleaned.amount = Number(cleaned.amount || 0)
            toInsert = cleaned
          }
          row = await pgInsert(resource, toInsert)
        }
      } catch (e: any) {
        const msg = String(e?.message || '')
        if (resource === 'fixed_expenses' && /relation\s+"?fixed_expenses"?\s+does\s+not\s+exist/i.test(msg)) {
          try {
            const { pgPool } = require('../dbAdapter')
            if (pgPool) {
              await pgPool.query(`CREATE TABLE IF NOT EXISTS fixed_expenses (
                id text PRIMARY KEY,
                property_id text REFERENCES properties(id) ON DELETE SET NULL,
                scope text,
                vendor text,
                category text,
                amount numeric,
                due_day_of_month integer,
                remind_days_before integer,
                status text,
                pay_account_name text,
                pay_bsb text,
                pay_account_number text,
                pay_ref text,
                created_at timestamptz DEFAULT now(),
                updated_at timestamptz
              );`)
              await pgPool.query('CREATE INDEX IF NOT EXISTS idx_fixed_expenses_scope ON fixed_expenses(scope);')
              await pgPool.query('CREATE INDEX IF NOT EXISTS idx_fixed_expenses_status ON fixed_expenses(status);')
              const allow = ['id','property_id','scope','vendor','category','amount','due_day_of_month','remind_days_before','status','pay_account_name','pay_bsb','pay_account_number','pay_ref']
              const cleaned: any = { id: payload.id }
              for (const k of allow) { if ((payload as any)[k] !== undefined) cleaned[k] = (payload as any)[k] }
              if (cleaned.amount !== undefined) cleaned.amount = Number(cleaned.amount || 0)
              const row2 = await pgInsert(resource, cleaned)
              addAudit(resource, String((row2 as any)?.id || ''), 'create', null, row2, (req as any).user?.sub)
              return res.status(201).json(row2)
            }
          } catch (e2) {
            return res.status(500).json({ message: (e2 as any)?.message || 'create failed (table init)' })
          }
        }
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
          if (resource === 'company_expenses' && /column\s+"?category_detail"?\s+of\s+relation\s+"?company_expenses"?\s+does\s+not\s+exist/i.test(msg)) {
            try {
              const { pgPool } = require('../dbAdapter')
              if (pgPool) {
                await pgPool.query('ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS category_detail text;')
                const allow = ['id','occurred_at','amount','currency','category','category_detail','note','invoice_url']
                const cleaned: any = { id: payload.id }
                for (const k of allow) { if ((payload as any)[k] !== undefined) cleaned[k] = (payload as any)[k] }
                if (cleaned.amount !== undefined) cleaned.amount = Number(cleaned.amount || 0)
                if (cleaned.occurred_at) cleaned.occurred_at = String(cleaned.occurred_at).slice(0,10)
                const row2 = await pgInsert(resource, cleaned)
                addAudit(resource, String((row2 as any)?.id || ''), 'create', null, row2, (req as any).user?.sub)
                return res.status(201).json(row2)
              }
            } catch (e4) {
              return res.status(500).json({ message: (e4 as any)?.message || 'create failed (column add)' })
            }
          }
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

router.patch('/:resource/:id', requireResourcePerm('write'), async (req, res) => {
  const { resource, id } = req.params
  if (!okResource(resource)) return res.status(404).json({ message: 'resource not allowed' })
  const payload = req.body || {}
  if (resource === 'property_maintenance') { delete (payload as any).property_code }
  const user = (req as any).user || {}
  if (user?.role === 'customer_service' && resource === 'property_expenses') {
    try {
      if (hasPg) {
        const rowsRaw = await pgSelect(resource, '*', { id })
        const rows: any[] = Array.isArray(rowsRaw) ? rowsRaw : []
        const row = rows[0]
        if (row && row.created_by && row.created_by !== user.sub) return res.status(403).json({ message: 'forbidden' })
      }
    } catch {}
  }
  try {
    if (hasPg) {
      let toUpdate: any = payload
      if (resource === 'property_expenses') {
        const allow = ['occurred_at','amount','currency','category','category_detail','note','invoice_url','property_id','fixed_expense_id','month_key','due_date','paid_date','status']
        const cleaned: any = {}
        for (const k of allow) { if (payload[k] !== undefined) cleaned[k] = payload[k] }
        if (cleaned.amount !== undefined) cleaned.amount = Number(cleaned.amount || 0)
        if (cleaned.occurred_at) cleaned.occurred_at = String(cleaned.occurred_at).slice(0,10)
        if (cleaned.due_date) cleaned.due_date = String(cleaned.due_date).slice(0,10)
        if (cleaned.paid_date) cleaned.paid_date = String(cleaned.paid_date).slice(0,10)
        toUpdate = cleaned
      } else if (resource === 'company_expenses') {
        const allow = ['occurred_at','amount','currency','category','category_detail','note','invoice_url','fixed_expense_id','month_key','due_date','paid_date','status']
        const cleaned: any = {}
        for (const k of allow) { if ((payload as any)[k] !== undefined) cleaned[k] = (payload as any)[k] }
        if (cleaned.amount !== undefined) cleaned.amount = Number(cleaned.amount || 0)
        if (cleaned.occurred_at) cleaned.occurred_at = String(cleaned.occurred_at).slice(0,10)
        if (cleaned.due_date) cleaned.due_date = String(cleaned.due_date).slice(0,10)
        if (cleaned.paid_date) cleaned.paid_date = String(cleaned.paid_date).slice(0,10)
        toUpdate = cleaned
      } else if (resource === 'recurring_payments') {
        const allow = ['property_id','scope','vendor','category','category_detail','amount','due_day_of_month','remind_days_before','status','last_paid_date','next_due_date','pay_account_name','pay_bsb','pay_account_number','pay_ref','expense_id','expense_resource']
        const cleaned: any = {}
        for (const k of allow) { if ((payload as any)[k] !== undefined) cleaned[k] = (payload as any)[k] }
        if (cleaned.amount !== undefined) cleaned.amount = Number(cleaned.amount || 0)
        cleaned.remind_days_before = 3
        const today = new Date()
        const d0 = typeof cleaned.last_paid_date === 'string' ? new Date(cleaned.last_paid_date) : null
        const base = d0 && !isNaN(d0.getTime()) ? d0 : today
        const due = Number(cleaned.due_day_of_month || payload.due_day_of_month || 1)
        const y = base.getUTCFullYear()
        const m = base.getUTCMonth()
        const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate()
        const targetDayThis = Math.min(due, daysInMonth)
        const thisDue = new Date(Date.UTC(y, m, targetDayThis))
        let next: Date
        if (base.getUTCDate() < targetDayThis) {
          next = thisDue
        } else {
          const y2 = m === 11 ? y + 1 : y
          const m2 = (m + 1) % 12
          const dim2 = new Date(Date.UTC(y2, m2 + 1, 0)).getUTCDate()
          next = new Date(Date.UTC(y2, m2, Math.min(due, dim2)))
        }
        if (!cleaned.next_due_date) cleaned.next_due_date = next.toISOString().slice(0,10)
        toUpdate = cleaned
      } else if (resource === 'fixed_expenses') {
        const allow = ['property_id','scope','vendor','category','amount','due_day_of_month','remind_days_before','status','pay_account_name','pay_bsb','pay_account_number','pay_ref']
        const cleaned: any = {}
        for (const k of allow) { if ((payload as any)[k] !== undefined) cleaned[k] = (payload as any)[k] }
        if (cleaned.amount !== undefined) cleaned.amount = Number(cleaned.amount || 0)
        toUpdate = cleaned
      }
      const row = await pgUpdate(resource, id, toUpdate)
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

router.delete('/:resource/:id', requireResourcePerm('delete'), async (req, res) => {
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