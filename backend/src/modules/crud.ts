import { Router } from 'express'
import { requireAnyPerm, requireResourcePerm } from '../auth'
import { hasPg, pgSelect, pgInsert, pgUpdate, pgDelete } from '../dbAdapter'
import { buildExpenseFingerprint, hasFingerprint, setFingerprint, addDedupLog } from '../fingerprint'
import { db, addAudit } from '../store'

const router = Router()
// Supabase removed

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
  property_deep_cleaning: true,
  order_import_staging: true,
  repair_orders: true,
}

function okResource(r: string): boolean { return !!ALLOW[r] }

router.get('/:resource', requireResourcePerm('view'), async (req, res) => {
  const { resource } = req.params
  if (!okResource(resource)) return res.status(404).json({ message: 'resource not allowed' })
  const filter: Record<string, any> = { ...(req.query || {}) }
  const q = typeof (req.query as any)?.q === 'string' ? String((req.query as any).q || '').trim() : ''
  const withTotal = String((req.query as any)?.withTotal || '') === '1'
  const aggregate = String((req.query as any)?.aggregate || '') === '1'
  const limit = (() => {
    const v = (req.query as any)?.limit
    const n = Number(Array.isArray(v) ? v[0] : v)
    return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 5000) : undefined
  })()
  const offset = (() => {
    const v = (req.query as any)?.offset
    const n = Number(Array.isArray(v) ? v[0] : v)
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined
  })()
  const user = (req as any).user || {}
  if (user?.role === 'customer_service' && resource === 'property_expenses') {
    filter.created_by = user.sub
  }
  delete filter.limit; delete filter.offset; delete filter.order; delete filter.q; delete filter.withTotal; delete filter.aggregate
  try {
    if (hasPg) {
      try {
        const rows: any[] = []
        const { pgPool } = require('../dbAdapter')
        function buildWhere(filters?: Record<string, any>) {
          const rawKeys = Object.keys(filters || {})
          const keys = rawKeys.filter(k => /^[a-zA-Z0-9_]+$/.test(k))
          const parts: string[] = []
          const values: any[] = []
          for (const k of keys) {
            if (k.endsWith('_from')) {
              const col = k.slice(0, -5)
              if (/^[a-zA-Z0-9_]+$/.test(col)) {
                values.push((filters as any)[k])
                parts.push(`"${col}" >= $${values.length}`)
              }
              continue
            }
            if (k.endsWith('_to')) {
              const col = k.slice(0, -3)
              if (/^[a-zA-Z0-9_]+$/.test(col)) {
                values.push((filters as any)[k])
                parts.push(`"${col}" <= $${values.length}`)
              }
              continue
            }
            values.push((filters as any)[k])
            parts.push(`"${k}" = $${values.length}`)
          }
          if (!parts.length) return { clause: '', values: [] as any[] }
          return { clause: ` WHERE ${parts.join(' AND ')}`, values }
        }
        const w = buildWhere(Object.keys(filter).length ? filter : undefined)
        let orderBy = ''
        if (resource === 'property_expenses') {
          orderBy = ' ORDER BY paid_date DESC NULLS LAST, due_date DESC NULLS LAST, occurred_at DESC'
        } else if (resource === 'company_expenses') {
          orderBy = ' ORDER BY due_date ASC NULLS LAST, paid_date ASC NULLS LAST, occurred_at ASC'
        } else if (resource === 'recurring_payments') {
          orderBy = " ORDER BY CASE WHEN category='消耗品费' OR report_category='consumables' THEN 1 ELSE 0 END ASC, created_at DESC NULLS LAST, next_due_date ASC NULLS LAST, due_day_of_month ASC, vendor ASC"
        } else if (resource === 'fixed_expenses') {
          orderBy = ' ORDER BY due_day_of_month ASC, vendor ASC'
        } else if (resource === 'property_maintenance') {
          orderBy = ' ORDER BY occurred_at DESC NULLS LAST, id ASC'
        } else if (resource === 'property_deep_cleaning') {
          orderBy = ' ORDER BY occurred_at DESC NULLS LAST, id ASC'
        } else if (resource === 'repair_orders') {
          orderBy = ' ORDER BY submitted_at DESC NULLS LAST, id ASC'
        }
        if (pgPool) {
          try {
            if (resource === 'property_maintenance') {
              try {
                await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS work_no text;`)
                await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS category text;`)
                await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS status text;`)
                await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS urgency text;`)
                await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS submitted_at timestamptz;`)
                await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS completed_at timestamptz;`)
                await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS submitter_name text;`)
                await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS assignee_id text;`)
                await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS eta date;`)
                await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS repair_notes text;`)
                await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS repair_photo_urls jsonb;`)
                await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS maintenance_amount numeric;`)
                await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS has_parts boolean;`)
                await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS parts_amount numeric;`)
                await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS pay_method text;`)
                await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS pay_other_note text;`)
                await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS photo_urls jsonb;`)
                await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS property_code text;`)
              } catch {}
            }
            if (resource === 'property_deep_cleaning') {
              try {
                await pgPool.query(`CREATE TABLE IF NOT EXISTS property_deep_cleaning (
                  id text PRIMARY KEY,
                  property_id text REFERENCES properties(id) ON DELETE SET NULL,
                  occurred_at date NOT NULL,
                  worker_name text,
                  project_desc text,
                  started_at timestamptz,
                  ended_at timestamptz,
                  duration_minutes integer,
                  details text,
                  notes text,
                  created_by text,
                  photo_urls jsonb,
                  property_code text,
                  work_no text,
                  category text,
                  status text,
                  urgency text,
                  submitted_at timestamptz,
                  submitter_name text,
                  assignee_id text,
                  eta date,
                  completed_at timestamptz,
                  repair_notes text,
                  repair_photo_urls jsonb,
                  attachment_urls jsonb,
                  checklist jsonb,
                  consumables jsonb,
                  labor_minutes integer,
                  labor_cost numeric,
                  review_status text,
                  reviewed_by text,
                  reviewed_at timestamptz,
                  review_notes text,
                  created_at timestamptz DEFAULT now(),
                  updated_at timestamptz
                );`)
                await pgPool.query('CREATE INDEX IF NOT EXISTS idx_property_deep_cleaning_property_id ON property_deep_cleaning(property_id);')
                await pgPool.query('CREATE INDEX IF NOT EXISTS idx_property_deep_cleaning_status ON property_deep_cleaning(status);')
                await pgPool.query('CREATE INDEX IF NOT EXISTS idx_property_deep_cleaning_category ON property_deep_cleaning(category);')
                await pgPool.query('CREATE INDEX IF NOT EXISTS idx_property_deep_cleaning_occurred_at ON property_deep_cleaning(occurred_at);')
                await pgPool.query(`ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS project_desc text;`)
                await pgPool.query(`ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS started_at timestamptz;`)
                await pgPool.query(`ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS ended_at timestamptz;`)
                await pgPool.query(`ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS duration_minutes integer;`)
                await pgPool.query(`ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS photo_urls jsonb;`)
                await pgPool.query(`ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS repair_photo_urls jsonb;`)
                await pgPool.query(`ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS attachment_urls jsonb;`)
                await pgPool.query(`ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS checklist jsonb;`)
                await pgPool.query(`ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS consumables jsonb;`)
              } catch {}
            }
            const w2 = (() => {
              if ((resource !== 'property_maintenance' && resource !== 'property_deep_cleaning') || !q) return w
              const like = `%${q.replace(/%/g, '\\%').replace(/_/g, '\\_')}%`
              const idx = w.values.length + 1
              const clause = w.clause ? `${w.clause} AND (` : ' WHERE ('
              const or = [
                `COALESCE("property_code",'') ILIKE $${idx} ESCAPE '\\\\'`,
                `EXISTS (SELECT 1 FROM properties p WHERE p.id = ${resource}.property_id AND COALESCE(p.code,'') ILIKE $${idx} ESCAPE '\\\\')`,
                `COALESCE("property_id",'') ILIKE $${idx} ESCAPE '\\\\'`,
                `COALESCE("work_no",'') ILIKE $${idx} ESCAPE '\\\\'`,
                `COALESCE("category",'') ILIKE $${idx} ESCAPE '\\\\'`,
                `COALESCE("status",'') ILIKE $${idx} ESCAPE '\\\\'`,
                `COALESCE("submitter_name",'') ILIKE $${idx} ESCAPE '\\\\'`,
                `COALESCE("assignee_id",'') ILIKE $${idx} ESCAPE '\\\\'`,
                `COALESCE("details",'') ILIKE $${idx} ESCAPE '\\\\'`,
                `COALESCE("notes",'') ILIKE $${idx} ESCAPE '\\\\'`,
                `COALESCE("repair_notes",'') ILIKE $${idx} ESCAPE '\\\\'`,
                `COALESCE("review_status",'') ILIKE $${idx} ESCAPE '\\\\'`,
                `COALESCE("review_notes",'') ILIKE $${idx} ESCAPE '\\\\'`,
                `COALESCE("checklist"::text,'') ILIKE $${idx} ESCAPE '\\\\'`,
                `COALESCE("consumables"::text,'') ILIKE $${idx} ESCAPE '\\\\'`,
              ].join(' OR ')
              return { clause: `${clause}${or})`, values: [...w.values, like] }
            })()
            const getLimitOffset = () => {
              const parts: string[] = []
              const values = [...w2.values]
              if (typeof limit === 'number') { values.push(limit); parts.push(` LIMIT $${values.length}`) }
              if (typeof offset === 'number') { values.push(offset); parts.push(` OFFSET $${values.length}`) }
              return { clause: parts.join(''), values }
            }
            if (aggregate && (resource === 'property_maintenance' || resource === 'property_deep_cleaning')) {
              const baseWhere = w2.clause
              const vals = w2.values
              const q1 = await pgPool.query(`SELECT COUNT(*)::int AS total FROM ${resource}${baseWhere}`, vals)
              const q2 = await pgPool.query(`SELECT COALESCE(status,'') AS key, COUNT(*)::int AS value FROM ${resource}${baseWhere} GROUP BY COALESCE(status,'') ORDER BY value DESC`, vals)
              const q3 = await pgPool.query(`SELECT COALESCE(category,'') AS key, COUNT(*)::int AS value FROM ${resource}${baseWhere} GROUP BY COALESCE(category,'') ORDER BY value DESC`, vals)
              const q4 = await pgPool.query(`SELECT to_char(date_trunc('month', occurred_at::date), 'YYYY-MM') AS key, COUNT(*)::int AS value FROM ${resource}${baseWhere} GROUP BY 1 ORDER BY 1 ASC`, vals)
              return res.json({
                total: q1?.rows?.[0]?.total || 0,
                by_status: q2?.rows || [],
                by_category: q3?.rows || [],
                by_month: q4?.rows || [],
              })
            }
            const lo = getLimitOffset()
            const sql = `SELECT * FROM ${resource}${w2.clause}${orderBy}${lo.clause}`
            const resq = await pgPool.query(sql, lo.values)
            rows.push(...(resq?.rows || []))
            if (withTotal || typeof limit === 'number' || typeof offset === 'number') {
              const c = await pgPool.query(`SELECT COUNT(*)::int AS total FROM ${resource}${w2.clause}`, w2.values)
              const total = c?.rows?.[0]?.total
              if (typeof total === 'number') res.setHeader('X-Total-Count', String(total))
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
            } else if (resource === 'recurring_payments' && /relation\s+"?recurring_payments"?\s+does\s+not\s+exist/i.test(msg)) {
              await pgPool.query(`CREATE TABLE IF NOT EXISTS recurring_payments (
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
                created_at timestamptz DEFAULT now(),
                updated_at timestamptz
              );`)
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
        } else if (resource === 'company_incomes') {
          let props: any[] = []
          try { const propsRaw = await pgSelect('properties', 'id,code,address'); props = Array.isArray(propsRaw) ? propsRaw : [] } catch {}
          const byId: Record<string, any> = Object.fromEntries(props.map(p => [String(p.id), p]))
          const labeled = rows.map(r => {
            const pid = String((r as any).property_id || '')
            const p = byId[pid]
            const label = p?.code || p?.address || pid || ''
            return { ...r, property_code: label }
          })
          return res.json(labeled)
        } else if (resource === 'property_maintenance') {
          function randomSuffix(len: number): string {
            const chars = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
            let s = ''
            for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)]
            return s
          }
          function asIsoOrEmpty(v: any): string {
            if (!v) return ''
            if (typeof v === 'string') return v
            try {
              const d = new Date(v)
              if (!isNaN(d.getTime())) return d.toISOString()
            } catch {}
            return ''
          }
          function guessCategoryFromDetails(details: any): string {
            const known = new Set(['入户走廊','客厅','厨房','卧室','阳台','浴室','其他'])
            try {
              const arr: any[] = Array.isArray(details) ? details : (typeof details === 'string' ? JSON.parse(details) : [])
              if (!Array.isArray(arr) || !arr.length) return ''
              const norm = (v: any) => String(v || '').trim()
              const pickItem = (x: any) => norm(x?.item ?? x?.label ?? x?.key ?? x?.name)
              const pickContent = (x: any) => norm(x?.content ?? x?.value ?? x?.text)
              for (const x of arr) {
                const item = pickItem(x)
                const content = pickContent(x)
                if (!content) continue
                const itemLower = item.toLowerCase()
                if (known.has(content) && (item.includes('区域') || item.includes('位置') || itemLower.includes('category') || itemLower.includes('area'))) {
                  return content
                }
              }
              for (const x of arr) {
                const content = pickContent(x)
                if (known.has(content)) return content
              }
            } catch {}
            return ''
          }
          async function backfillWorkNo(row: any) {
            const current = String(row?.work_no || '').trim()
            if (current) return current
            const baseDateRaw = String(row?.occurred_at || row?.submitted_at || '').slice(0, 10)
            const date = (baseDateRaw && /^\d{4}-\d{2}-\d{2}$/.test(baseDateRaw))
              ? baseDateRaw.replace(/-/g, '')
              : new Date().toISOString().slice(0, 10).replace(/-/g, '')
            const prefix = `R-${date}-`
            let candidate = `${prefix}${String(row?.id || '').slice(0, 4) || randomSuffix(4)}`
            try {
              for (let i = 0; i < 8; i++) {
                const chk = await pgPool.query('SELECT 1 FROM property_maintenance WHERE work_no=$1 LIMIT 1', [candidate])
                if (!chk.rowCount) break
                candidate = `${prefix}${randomSuffix(4 + i)}`
              }
              await pgPool.query(`UPDATE property_maintenance SET work_no=$1 WHERE id=$2 AND (work_no IS NULL OR work_no='')`, [candidate, String(row?.id || '')])
            } catch {}
            return candidate
          }
          const userIds = Array.from(new Set(rows.map(r => String((r as any)?.created_by || '').trim()).filter(Boolean)))
          const userMap: Record<string, string> = {}
          if (userIds.length) {
            try {
              const r = await pgPool.query('SELECT id, username FROM users WHERE id = ANY($1::text[])', [userIds])
              for (const u of (r.rows || [])) {
                const id = String((u as any)?.id || '').trim()
                const name = String((u as any)?.username || '').trim()
                if (id && name) userMap[id] = name
              }
            } catch {}
          }
          let props: any[] = []
          try { const propsRaw = await pgSelect('properties', 'id,code,address'); props = Array.isArray(propsRaw) ? propsRaw : [] } catch {}
          const byId: Record<string, any> = Object.fromEntries(props.map(p => [String(p.id), p]))
          const byCode: Record<string, any> = Object.fromEntries(props.map(p => [String(p.code || ''), p]))
          const enriched = rows.map(r => {
            const pid = String(r.property_id || '')
            const p = byId[pid] || byCode[pid]
            const code = p?.code || r.property_code || pid || ''
            const submitter = String(r.submitter_name || '').trim()
              || String(r.worker_name || '').trim()
              || String(userMap[String(r.created_by || '')] || '').trim()
              || String(r.created_by || '').trim()
            const submittedAt = asIsoOrEmpty(r.submitted_at)
              || asIsoOrEmpty((r as any).created_at)
              || (String(r.occurred_at || '').trim() ? `${String(r.occurred_at).slice(0,10)}T00:00:00.000Z` : '')
            const category = String(r.category || '').trim()
              || String((r as any).category_detail || '').trim()
              || guessCategoryFromDetails((r as any).details)
            return { ...r, code, property_code: code, submitter_name: submitter, submitted_at: submittedAt || (r as any).submitted_at, category }
          })
          const toFixWorkNo = enriched.filter(r => !String((r as any)?.work_no || '').trim()).slice(0, 50)
          if (toFixWorkNo.length) {
            await Promise.all(toFixWorkNo.map(async (r) => { (r as any).work_no = await backfillWorkNo(r) }))
          }
          const toFixMeta = enriched.filter(r => {
            const needSubmitter = !String((r as any)?.submitter_name || '').trim()
            const needSubmittedAt = !String((r as any)?.submitted_at || '').trim()
            const needCategory = !String((r as any)?.category || '').trim()
            return needSubmitter || needSubmittedAt || needCategory
          }).slice(0, 50)
          if (toFixMeta.length) {
            await Promise.all(toFixMeta.map(async (r: any) => {
              try {
                const sets: string[] = []
                const vals: any[] = []
                const submitterName = String(r.submitter_name || '').trim()
                const submittedAt = String(r.submitted_at || '').trim()
                const category = String(r.category || '').trim()
                if (submitterName) { vals.push(submitterName); sets.push(`submitter_name = $${vals.length}`) }
                if (submittedAt) { vals.push(submittedAt); sets.push(`submitted_at = $${vals.length}`) }
                if (category) { vals.push(category); sets.push(`category = $${vals.length}`) }
                if (!sets.length) return
                vals.push(String(r.id || ''))
                await pgPool.query(`UPDATE property_maintenance SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals)
              } catch {}
            }))
          }
          return res.json(enriched)
        } else if (resource === 'property_deep_cleaning') {
          function asIsoOrEmpty(v: any): string {
            if (!v) return ''
            if (typeof v === 'string') return v
            try {
              const d = new Date(v)
              if (!isNaN(d.getTime())) return d.toISOString()
            } catch {}
            return ''
          }
          const userIds = Array.from(new Set(rows.map(r => String((r as any)?.created_by || '').trim()).filter(Boolean)))
          const userMap: Record<string, string> = {}
          if (userIds.length) {
            try {
              const r = await pgPool.query('SELECT id, username FROM users WHERE id = ANY($1::text[])', [userIds])
              for (const u of (r.rows || [])) {
                const id = String((u as any)?.id || '').trim()
                const name = String((u as any)?.username || '').trim()
                if (id && name) userMap[id] = name
              }
            } catch {}
          }
          let props: any[] = []
          try { const propsRaw = await pgSelect('properties', 'id,code,address'); props = Array.isArray(propsRaw) ? propsRaw : [] } catch {}
          const byId: Record<string, any> = Object.fromEntries(props.map(p => [String(p.id), p]))
          const byCode: Record<string, any> = Object.fromEntries(props.map(p => [String(p.code || ''), p]))
          const enriched = rows.map(r => {
            const pid = String(r.property_id || '')
            const p = byId[pid] || byCode[pid]
            const code = p?.code || (r as any).property_code || pid || ''
            const submitter = String((r as any).submitter_name || '').trim()
              || String((r as any).worker_name || '').trim()
              || String(userMap[String((r as any).created_by || '')] || '').trim()
              || String((r as any).created_by || '').trim()
            const submittedAt = asIsoOrEmpty((r as any).submitted_at)
              || asIsoOrEmpty((r as any).created_at)
              || (String((r as any).occurred_at || '').trim() ? `${String((r as any).occurred_at).slice(0,10)}T00:00:00.000Z` : '')
            return { ...r, code, property_code: code, submitter_name: submitter, submitted_at: submittedAt || (r as any).submitted_at }
          })
          return res.json(enriched)
        }
        return res.json(rows)
      } catch {}
    }
    // Supabase branch removed
    // in-memory fallback
    const arr = (db as any)[camelToArrayKey(resource)] || []
    let filtered = arr.filter((r: any) => Object.entries(filter).every(([k,v]) => (r?.[k]) == v))
    if ((resource === 'property_maintenance' || resource === 'property_deep_cleaning') && q) {
      const s = q.toLowerCase()
      filtered = filtered.filter((r: any) => {
        const hay = [
          r?.property_code,
          r?.property_id,
          r?.work_no,
          r?.category,
          r?.status,
          r?.submitter_name,
          r?.assignee_id,
          r?.details,
          r?.notes,
          r?.repair_notes,
          r?.review_status,
          r?.review_notes,
          JSON.stringify(r?.checklist || ''),
          JSON.stringify(r?.consumables || ''),
        ].map((x: any) => String(x || '').toLowerCase()).join(' ')
        return hay.includes(s)
      })
    }
    if (resource === 'property_expenses') {
      filtered = filtered.sort((a: any, b: any) => {
        const ap = a?.paid_date ? new Date(a.paid_date).getTime() : Number.NEGATIVE_INFINITY
        const bp = b?.paid_date ? new Date(b.paid_date).getTime() : Number.NEGATIVE_INFINITY
        if (ap !== bp) return bp - ap
        const ad = a?.due_date ? new Date(a.due_date).getTime() : Number.NEGATIVE_INFINITY
        const bd = b?.due_date ? new Date(b.due_date).getTime() : Number.NEGATIVE_INFINITY
        if (ad !== bd) return bd - ad
        const ao = a?.occurred_at ? new Date(a.occurred_at).getTime() : Number.NEGATIVE_INFINITY
        const bo = b?.occurred_at ? new Date(b.occurred_at).getTime() : Number.NEGATIVE_INFINITY
        return bo - ao
      })
    } else if (resource === 'company_expenses') {
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
        const aIsConsumables = String(a?.category || '') === '消耗品费' || String(a?.report_category || '') === 'consumables'
        const bIsConsumables = String(b?.category || '') === '消耗品费' || String(b?.report_category || '') === 'consumables'
        if (aIsConsumables !== bIsConsumables) return aIsConsumables ? 1 : -1
        const ac = a?.created_at ? new Date(a.created_at).getTime() : 0
        const bc = b?.created_at ? new Date(b.created_at).getTime() : 0
        if (ac !== bc) return bc - ac
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
    } else if (resource === 'property_maintenance') {
      filtered = filtered.sort((a: any, b: any) => {
        const ao = a?.occurred_at ? new Date(a.occurred_at).getTime() : Number.NEGATIVE_INFINITY
        const bo = b?.occurred_at ? new Date(b.occurred_at).getTime() : Number.NEGATIVE_INFINITY
        if (ao !== bo) return bo - ao
        return String(a?.id || '').localeCompare(String(b?.id || ''))
      })
    } else if (resource === 'property_deep_cleaning') {
      filtered = filtered.sort((a: any, b: any) => {
        const ao = a?.occurred_at ? new Date(a.occurred_at).getTime() : Number.NEGATIVE_INFINITY
        const bo = b?.occurred_at ? new Date(b.occurred_at).getTime() : Number.NEGATIVE_INFINITY
        if (ao !== bo) return bo - ao
        return String(a?.id || '').localeCompare(String(b?.id || ''))
      })
    } else if (resource === 'repair_orders') {
      filtered = filtered.sort((a: any, b: any) => {
        const asb = a?.submitted_at ? new Date(a.submitted_at).getTime() : Number.NEGATIVE_INFINITY
        const bsb = b?.submitted_at ? new Date(b.submitted_at).getTime() : Number.NEGATIVE_INFINITY
        if (asb !== bsb) return bsb - asb
        return String(a?.id || '').localeCompare(String(b?.id || ''))
      })
    }
    if (aggregate && (resource === 'property_maintenance' || resource === 'property_deep_cleaning')) {
      const total = filtered.length
      const by_status: Record<string, number> = {}
      const by_category: Record<string, number> = {}
      const by_month: Record<string, number> = {}
      for (const r of filtered) {
        const st = String(r?.status || '')
        const cat = String(r?.category || '')
        by_status[st] = (by_status[st] || 0) + 1
        by_category[cat] = (by_category[cat] || 0) + 1
        const d = r?.occurred_at || r?.submitted_at || ''
        const key = String(d || '').slice(0,7)
        if (key && /^\d{4}-\d{2}$/.test(key)) by_month[key] = (by_month[key] || 0) + 1
      }
      const toPairs = (obj: Record<string, number>) => Object.entries(obj).map(([key, value]) => ({ key, value }))
      return res.json({ total, by_status: toPairs(by_status), by_category: toPairs(by_category), by_month: toPairs(by_month).sort((a,b)=>String(a.key).localeCompare(String(b.key))) })
    }
    if (withTotal || typeof limit === 'number' || typeof offset === 'number') res.setHeader('X-Total-Count', String(filtered.length))
    if (typeof offset === 'number') filtered = filtered.slice(offset)
    if (typeof limit === 'number') filtered = filtered.slice(0, limit)
    if (resource === 'property_expenses') {
      const labeled = filtered.map((r: any) => {
        const pid = String(r.property_id || '')
        const p = (db as any).properties.find((pp: any) => String(pp.id) === pid) || (db as any).properties.find((pp: any) => String(pp.code || '') === pid)
        const label = (p?.code || p?.address || pid || '')
        return { ...r, property_code: label }
      })
      return res.json(labeled)
    } else if (resource === 'company_incomes') {
      const labeled = filtered.map((r: any) => {
        const pid = String((r as any).property_id || '')
        const p = (db as any).properties.find((pp: any) => String(pp.id) === pid) || null
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
    // Supabase branch removed
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
  if (resource === 'property_expenses' || resource === 'company_expenses' || resource === 'property_incomes' || resource === 'company_incomes' || resource === 'property_maintenance' || resource === 'property_deep_cleaning') {
    if (!payload.created_by) payload.created_by = user.sub || user.username || 'unknown'
  }
  if (resource === 'property_maintenance') {
    if (!hasPg) {
      const current = String((payload as any).work_no || '').trim()
      if (!current) {
        const date = new Date().toISOString().slice(0, 10).replace(/-/g, '')
        const prefix = `R-${date}-`
        const existing = new Set<string>()
        try {
          const arr = (db as any)[camelToArrayKey(resource)] || []
          for (const r of Array.isArray(arr) ? arr : []) {
            const w = String((r as any)?.work_no || '').trim()
            if (w) existing.add(w)
          }
        } catch {}
        let tries = 0
        for (;;) {
          const suffix = Math.random().toString(36).slice(2, 8)
          const candidate = `${prefix}${suffix}`
          if (!existing.has(candidate)) { ;(payload as any).work_no = candidate; break }
          tries += 1
          if (tries >= 20) { ;(payload as any).work_no = candidate; break }
        }
      }
    }
    try {
      detailsRaw = Array.isArray(payload.details)
        ? payload.details
        : (typeof payload.details === 'string'
            ? (() => { try { return JSON.parse(payload.details) } catch { return [] } })()
            : [])
      if (hasPg) {
        if (payload.details && typeof payload.details !== 'string') payload.details = JSON.stringify(payload.details)
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
        }
      } catch {}
    } catch {}
  }
  if (resource === 'property_deep_cleaning') {
    const current = String((payload as any).work_no || '').trim()
    if (!current) {
      const date = new Date().toISOString().slice(0, 10).replace(/-/g, '')
      const prefix = `DC-${date}-`
      ;(payload as any).work_no = `${prefix}${Math.random().toString(36).slice(2, 6)}`
    }
    if (!payload.occurred_at) (payload as any).occurred_at = new Date().toISOString().slice(0,10)
    if (!payload.submitted_at) (payload as any).submitted_at = new Date().toISOString()
    if (!payload.status) (payload as any).status = 'pending'
    if (payload.photo_urls === undefined) (payload as any).photo_urls = []
    if (payload.repair_photo_urls === undefined) (payload as any).repair_photo_urls = []
    if (payload.attachment_urls === undefined) (payload as any).attachment_urls = []
    if (payload.checklist === undefined) (payload as any).checklist = []
    if (payload.consumables === undefined) (payload as any).consumables = []
    if (payload.review_status === undefined) (payload as any).review_status = 'pending'
    if (payload.details && typeof payload.details !== 'string') {
      try { payload.details = JSON.stringify(payload.details) } catch {}
    }
    if (payload.photo_urls && !Array.isArray(payload.photo_urls)) payload.photo_urls = [payload.photo_urls]
    if (payload.repair_photo_urls && !Array.isArray(payload.repair_photo_urls)) payload.repair_photo_urls = [payload.repair_photo_urls]
    if (payload.attachment_urls && !Array.isArray(payload.attachment_urls)) payload.attachment_urls = [payload.attachment_urls]
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
        const started = Date.now()
        try {
          const d = payload.paid_date || payload.occurred_at
          if (d && !payload.month_key) {
            const y = String(d).slice(0,4)
            const m = String(d).slice(5,7)
            if (y && m) payload.month_key = `${y}-${m}`
          }
        } catch {}
        const fpExact = buildExpenseFingerprint(payload, 'exact')
        const fpFuzzy = buildExpenseFingerprint(payload, 'fuzzy')
        try {
          const { pgPool } = require('../dbAdapter')
          if (pgPool) {
            const key1 = 202601
            const key2 = Math.abs(require('xxhashjs').h32(fpExact, 0xABCD).toNumber() || 0)
            const lock = await pgPool.query('SELECT pg_try_advisory_lock($1, $2) AS ok', [key1, key2])
            const ok = !!(lock?.rows?.[0]?.ok)
            if (!ok) {
              await addDedupLog({ resource: 'property_expenses', fingerprint: fpExact, mode: 'exact', result: 'locked', operator_id: (req as any).user?.sub || null, latency_ms: Date.now() - started })
              return res.status(409).json({ message: '创建冲突：资源锁定中' })
            }
            try {
              if (await hasFingerprint(fpExact)) {
                await addDedupLog({ resource: 'property_expenses', fingerprint: fpExact, mode: 'exact', result: 'hit', operator_id: (req as any).user?.sub || null, latency_ms: Date.now() - started })
                return res.status(409).json({ message: '重复记录：指纹存在（24小时内）', fingerprint: fpExact })
              }
              const dup = payload.fixed_expense_id && payload.month_key
                ? await pgSelect(resource, '*', { fixed_expense_id: payload.fixed_expense_id, month_key: payload.month_key })
                : await pgSelect(resource, '*', { property_id: payload.property_id, month_key: payload.month_key, category: payload.category, amount: payload.amount })
              if (Array.isArray(dup) && dup[0]) {
                await addDedupLog({ resource: 'property_expenses', fingerprint: fpExact, mode: 'exact', result: 'hit', operator_id: (req as any).user?.sub || null, reasons: ['unique_match'], latency_ms: Date.now() - started })
                return res.status(409).json({ message: '重复记录：房源支出已存在（同房源、同月份、同类别、同金额）', existing_id: dup[0]?.id })
              }
              const occ = String(payload.paid_date || payload.occurred_at || '')
              const sql = `SELECT id FROM property_expenses WHERE property_id=$1 AND category=$2 AND abs(amount - $3) <= 1 AND occurred_at BETWEEN (to_date($4,'YYYY-MM-DD') - interval '1 day') AND (to_date($4,'YYYY-MM-DD') + interval '1 day') LIMIT 1`
              const rs = await pgPool.query(sql, [payload.property_id, payload.category, Number(payload.amount||0), occ.slice(0,10)])
              if (rs.rowCount) {
                await addDedupLog({ resource: 'property_expenses', fingerprint: fpFuzzy, mode: 'fuzzy', result: 'hit', operator_id: (req as any).user?.sub || null, reasons: ['fuzzy_window'], latency_ms: Date.now() - started })
                return res.status(409).json({ message: '重复记录：模糊匹配（±1天、±$1）', fingerprint: fpFuzzy, existing_id: rs.rows[0]?.id })
              }
              await setFingerprint(fpExact, 24 * 3600)
            } finally {
              try { await pgPool.query('SELECT pg_advisory_unlock($1, $2)', [key1, key2]) } catch {}
            }
          }
        } catch {}
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
          function randomSuffix(len: number): string {
            const chars = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
            let s = ''
            for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)]
            return s
          }
          async function genWorkNo(): Promise<string> {
            const date = new Date().toISOString().slice(0,10).replace(/-/g,'')
            const prefix = `R-${date}-`
            let len = 4
            for (;;) {
              const candidate = prefix + randomSuffix(len)
              try {
                const r = await pgPool.query('SELECT 1 FROM property_maintenance WHERE work_no = $1 LIMIT 1', [candidate])
                if (!r.rowCount) return candidate
              } catch {
                return candidate
              }
              len += 1
              if (len > 10) return candidate
            }
          }
          const workNo = payload.work_no || await genWorkNo()
          await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS work_no text;`)
          await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS category text;`)
          await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS status text;`)
          await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS urgency text;`)
          await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS submitted_at timestamptz;`)
          await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS completed_at timestamptz;`)
          await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS submitter_name text;`)
          await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS maintenance_amount numeric(12,2);`)
          await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS has_parts boolean;`)
          await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS parts_amount numeric(12,2);`)
          await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS pay_method text;`)
          await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS pay_other_note text;`)
          const sql = `INSERT INTO property_maintenance (id, property_id, occurred_at, worker_name, details, notes, created_by, photo_urls, property_code, work_no, category, status, urgency, submitted_at, submitter_name, completed_at, maintenance_amount, has_parts, parts_amount, pay_method, pay_other_note)
            VALUES ($1,$2,$3,$4,$5::text,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING *`
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
                payload.property_code || null,
                workNo,
                payload.category || null,
                payload.status || 'pending',
                payload.urgency || null,
                payload.submitted_at || new Date().toISOString(),
                payload.submitter_name || null,
                payload.completed_at || null,
                (d && (d as any).maintenance_amount !== undefined) ? Number((d as any).maintenance_amount || 0) : null,
                (d && (d as any).has_parts !== undefined) ? !!(d as any).has_parts : null,
                (d && (d as any).parts_amount !== undefined) ? Number((d as any).parts_amount || 0) : null,
                (d && (d as any).pay_method !== undefined) ? String((d as any).pay_method || '') : null,
                (d && (d as any).pay_other_note !== undefined) ? String((d as any).pay_other_note || '') : null
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
              payload.property_code || null,
              workNo,
              payload.category || null,
              payload.status || 'pending',
              payload.urgency || null,
              payload.submitted_at || new Date().toISOString(),
              payload.submitter_name || null,
              payload.completed_at || null,
              payload.maintenance_amount !== undefined ? Number(payload.maintenance_amount || 0) : null,
              payload.has_parts !== undefined ? !!payload.has_parts : null,
              payload.parts_amount !== undefined ? Number(payload.parts_amount || 0) : null,
              payload.pay_method !== undefined ? String(payload.pay_method || '') : null,
              payload.pay_other_note !== undefined ? String(payload.pay_other_note || '') : null
            ]
            const res = await pgPool.query(sql, values)
            row = res.rows && res.rows[0]
          }
        } else {
          if (resource === 'property_deep_cleaning') {
            const { pgPool } = require('../dbAdapter')
            if (!pgPool) return res.status(500).json({ message: 'no database configured' })
            try {
              await pgPool.query(`CREATE TABLE IF NOT EXISTS property_deep_cleaning (
                id text PRIMARY KEY,
                property_id text REFERENCES properties(id) ON DELETE SET NULL,
                occurred_at date NOT NULL,
                worker_name text,
                project_desc text,
                started_at timestamptz,
                ended_at timestamptz,
                duration_minutes integer,
                details text,
                notes text,
                created_by text,
                photo_urls jsonb,
                property_code text,
                work_no text,
                category text,
                status text,
                urgency text,
                submitted_at timestamptz,
                submitter_name text,
                assignee_id text,
                eta date,
                completed_at timestamptz,
                repair_notes text,
                repair_photo_urls jsonb,
                attachment_urls jsonb,
                checklist jsonb,
                consumables jsonb,
                labor_minutes integer,
                labor_cost numeric,
                review_status text,
                reviewed_by text,
                reviewed_at timestamptz,
                review_notes text,
                created_at timestamptz DEFAULT now(),
                updated_at timestamptz
              );`)
              await pgPool.query(`ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS project_desc text;`)
              await pgPool.query(`ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS started_at timestamptz;`)
              await pgPool.query(`ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS ended_at timestamptz;`)
              await pgPool.query(`ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS duration_minutes integer;`)
              await pgPool.query(`ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS photo_urls jsonb;`)
              await pgPool.query(`ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS repair_photo_urls jsonb;`)
              await pgPool.query(`ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS attachment_urls jsonb;`)
              await pgPool.query(`ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS checklist jsonb;`)
              await pgPool.query(`ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS consumables jsonb;`)
            } catch {}

            const allow = [
              'id','property_id','occurred_at','worker_name',
              'project_desc','started_at','ended_at','duration_minutes',
              'details','notes','created_by',
              'photo_urls','repair_photo_urls','attachment_urls',
              'property_code','work_no','category','status','urgency',
              'submitted_at','submitter_name','assignee_id','eta','completed_at',
              'repair_notes','checklist','consumables','labor_minutes','labor_cost',
              'review_status','reviewed_by','reviewed_at','review_notes',
            ]
            const cleaned: any = { id: payload.id }
            for (const k of allow) { if ((payload as any)[k] !== undefined) cleaned[k] = (payload as any)[k] }
            if (!cleaned.occurred_at) cleaned.occurred_at = new Date().toISOString().slice(0,10)
            if (!cleaned.submitted_at) cleaned.submitted_at = new Date().toISOString()
            if (!cleaned.status) cleaned.status = 'pending'
            if (cleaned.review_status === undefined) cleaned.review_status = 'pending'
            if (cleaned.details && typeof cleaned.details !== 'string') {
              try { cleaned.details = JSON.stringify(cleaned.details) } catch {}
            }
            const jsonbKeys = ['photo_urls','repair_photo_urls','attachment_urls','checklist','consumables']
            for (const k of jsonbKeys) {
              if (cleaned[k] !== undefined && cleaned[k] !== null && typeof cleaned[k] !== 'string') {
                try { cleaned[k] = JSON.stringify(cleaned[k]) } catch {}
              }
              if (cleaned[k] === undefined) cleaned[k] = JSON.stringify([])
            }

            const sql = `INSERT INTO property_deep_cleaning (
              id, property_id, occurred_at, worker_name,
              project_desc, started_at, ended_at, duration_minutes,
              details, notes, created_by,
              photo_urls, repair_photo_urls, attachment_urls,
              property_code, work_no, category, status, urgency,
              submitted_at, submitter_name, assignee_id, eta, completed_at,
              repair_notes, checklist, consumables, labor_minutes, labor_cost,
              review_status, reviewed_by, reviewed_at, review_notes
            ) VALUES (
              $1,$2,$3,$4,
              $5,$6,$7,$8,
              $9::text,$10,$11,
              $12::jsonb,$13::jsonb,$14::jsonb,
              $15,$16,$17,$18,$19,
              $20,$21,$22,$23,$24,
              $25,$26::jsonb,$27::jsonb,$28,$29,
              $30,$31,$32,$33
            ) RETURNING *`
            const values = [
              cleaned.id,
              cleaned.property_id || null,
              String(cleaned.occurred_at).slice(0,10),
              cleaned.worker_name || '',
              cleaned.project_desc || null,
              cleaned.started_at || null,
              cleaned.ended_at || null,
              cleaned.duration_minutes !== undefined ? cleaned.duration_minutes : null,
              cleaned.details || JSON.stringify([]),
              cleaned.notes || '',
              cleaned.created_by || null,
              cleaned.photo_urls,
              cleaned.repair_photo_urls,
              cleaned.attachment_urls,
              cleaned.property_code || null,
              cleaned.work_no || null,
              cleaned.category || null,
              cleaned.status || null,
              cleaned.urgency || null,
              cleaned.submitted_at || null,
              cleaned.submitter_name || null,
              cleaned.assignee_id || null,
              cleaned.eta ? String(cleaned.eta).slice(0,10) : null,
              cleaned.completed_at || null,
              cleaned.repair_notes || null,
              cleaned.checklist,
              cleaned.consumables,
              cleaned.labor_minutes !== undefined ? cleaned.labor_minutes : null,
              cleaned.labor_cost !== undefined ? cleaned.labor_cost : null,
              cleaned.review_status || null,
              cleaned.reviewed_by || null,
              cleaned.reviewed_at || null,
              cleaned.review_notes || null,
            ]
            const r = await pgPool.query(sql, values)
            const row2 = r.rows && r.rows[0]
            addAudit(resource, String((row2 as any)?.id || ''), 'create', null, row2, (req as any).user?.sub)
            return res.status(201).json(row2)
          }

          let toInsert: any = payload
          if (resource === 'property_expenses') {
            const allow = ['id','occurred_at','amount','currency','category','category_detail','note','property_id','created_by','fixed_expense_id','month_key','due_date','paid_date','status']
            const cleaned: any = { id: payload.id }
            for (const k of allow) { if ((payload as any)[k] !== undefined) cleaned[k] = (payload as any)[k] }
            if (cleaned.amount !== undefined) cleaned.amount = Number(cleaned.amount || 0)
            if (cleaned.occurred_at) cleaned.occurred_at = String(cleaned.occurred_at).slice(0,10)
            if (cleaned.due_date) cleaned.due_date = String(cleaned.due_date).slice(0,10)
            if (cleaned.paid_date) cleaned.paid_date = String(cleaned.paid_date).slice(0,10)
            try {
              const d = cleaned.paid_date || cleaned.occurred_at
              if (d && !cleaned.month_key) {
                const y = String(d).slice(0,4)
                const m = String(d).slice(5,7)
                if (y && m) cleaned.month_key = `${y}-${m}`
              }
            } catch {}
            toInsert = cleaned
          } else if (resource === 'company_expenses') {
            const allow = ['id','occurred_at','amount','currency','category','category_detail','note','fixed_expense_id','month_key','due_date','paid_date','status']
            const cleaned: any = { id: payload.id }
            for (const k of allow) { if ((payload as any)[k] !== undefined) cleaned[k] = (payload as any)[k] }
            if (cleaned.amount !== undefined) cleaned.amount = Number(cleaned.amount || 0)
            if (cleaned.occurred_at) cleaned.occurred_at = String(cleaned.occurred_at).slice(0,10)
            if (cleaned.due_date) cleaned.due_date = String(cleaned.due_date).slice(0,10)
            if (cleaned.paid_date) cleaned.paid_date = String(cleaned.paid_date).slice(0,10)
            toInsert = cleaned
          } else if (resource === 'recurring_payments') {
            const allow = ['id','property_id','scope','vendor','category','category_detail','amount','due_day_of_month','frequency_months','remind_days_before','status','last_paid_date','next_due_date','pay_account_name','pay_bsb','pay_account_number','pay_ref','expense_id','expense_resource','payment_type','bpay_code','pay_mobile_number','report_category']
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
            try { const { pgPool } = require('../dbAdapter'); if (pgPool) await ensureRecurringFrequencyInteger(pgPool) } catch {}
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
        } else if (resource === 'property_expenses' && /column\s+"?fixed_expense_id"?\s+of\s+relation\s+"?property_expenses"?\s+does\s+not\s+exist/i.test(msg)) {
          try {
            const { pgPool } = require('../dbAdapter')
            if (pgPool) {
              await pgPool.query('ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS fixed_expense_id text;')
              await pgPool.query('ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS month_key text;')
              await pgPool.query('ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS due_date date;')
              await pgPool.query('ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS paid_date date;')
              await pgPool.query('ALTER TABLE property_expenses ADD COLUMN IF NOT EXISTS status text;')
              const allow = ['id','occurred_at','amount','currency','category','category_detail','note','invoice_url','property_id','created_by','fixed_expense_id','month_key','due_date','paid_date','status']
              const cleaned: any = { id: payload.id }
              for (const k of allow) { if ((payload as any)[k] !== undefined) cleaned[k] = (payload as any)[k] }
              if (cleaned.amount !== undefined) cleaned.amount = Number(cleaned.amount || 0)
              if (cleaned.occurred_at) cleaned.occurred_at = String(cleaned.occurred_at).slice(0,10)
              if (cleaned.due_date) cleaned.due_date = String(cleaned.due_date).slice(0,10)
              if (cleaned.paid_date) cleaned.paid_date = String(cleaned.paid_date).slice(0,10)
              const row2 = await pgInsert(resource, cleaned)
              addAudit(resource, String((row2 as any)?.id || ''), 'create', null, row2, (req as any).user?.sub)
              return res.status(201).json(row2)
            }
          } catch (e3) {
            return res.status(500).json({ message: (e3 as any)?.message || 'create failed (column add)' })
          }
        } else if (resource === 'company_expenses' && /column\s+"?fixed_expense_id"?\s+of\s+relation\s+"?company_expenses"?\s+does\s+not\s+exist/i.test(msg)) {
          try {
            const { pgPool } = require('../dbAdapter')
            if (pgPool) {
              await pgPool.query('ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS fixed_expense_id text;')
              await pgPool.query('ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS month_key text;')
              await pgPool.query('ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS due_date date;')
              await pgPool.query('ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS paid_date date;')
              await pgPool.query('ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS status text;')
              const allow = ['id','occurred_at','amount','currency','category','category_detail','note','fixed_expense_id','month_key','due_date','paid_date','status']
              const cleaned: any = { id: payload.id }
              for (const k of allow) { if ((payload as any)[k] !== undefined) cleaned[k] = (payload as any)[k] }
              if (cleaned.amount !== undefined) cleaned.amount = Number(cleaned.amount || 0)
              if (cleaned.occurred_at) cleaned.occurred_at = String(cleaned.occurred_at).slice(0,10)
              if (cleaned.due_date) cleaned.due_date = String(cleaned.due_date).slice(0,10)
              if (cleaned.paid_date) cleaned.paid_date = String(cleaned.paid_date).slice(0,10)
              const row2 = await pgInsert(resource, cleaned)
              addAudit(resource, String((row2 as any)?.id || ''), 'create', null, row2, (req as any).user?.sub)
              return res.status(201).json(row2)
            }
          } catch (e4) {
            return res.status(500).json({ message: (e4 as any)?.message || 'create failed (column add)' })
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
        } else if (resource === 'property_deep_cleaning' && /does not exist|relation .* does not exist/i.test(msg)) {
          try {
            const { pgPool } = require('../dbAdapter')
            if (pgPool) {
              await pgPool.query(`CREATE TABLE IF NOT EXISTS property_deep_cleaning (
                id text PRIMARY KEY,
                property_id text REFERENCES properties(id) ON DELETE SET NULL,
                occurred_at date NOT NULL,
                worker_name text,
                project_desc text,
                started_at timestamptz,
                ended_at timestamptz,
                duration_minutes integer,
                details text,
                notes text,
                created_by text,
                photo_urls jsonb,
                property_code text,
                work_no text,
                category text,
                status text,
                urgency text,
                submitted_at timestamptz,
                submitter_name text,
                assignee_id text,
                eta date,
                completed_at timestamptz,
                repair_notes text,
                repair_photo_urls jsonb,
                attachment_urls jsonb,
                checklist jsonb,
                consumables jsonb,
                labor_minutes integer,
                labor_cost numeric,
                review_status text,
                reviewed_by text,
                reviewed_at timestamptz,
                review_notes text,
                created_at timestamptz DEFAULT now(),
                updated_at timestamptz
              );`)
              await pgPool.query('CREATE INDEX IF NOT EXISTS idx_property_deep_cleaning_pid ON property_deep_cleaning(property_id);')
              await pgPool.query('CREATE INDEX IF NOT EXISTS idx_property_deep_cleaning_date ON property_deep_cleaning(occurred_at);')
              await pgPool.query(`ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS project_desc text;`)
              await pgPool.query(`ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS started_at timestamptz;`)
              await pgPool.query(`ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS ended_at timestamptz;`)
              await pgPool.query(`ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS duration_minutes integer;`)
              const allow = ['id','property_id','occurred_at','worker_name','project_desc','started_at','ended_at','duration_minutes','details','notes','created_by','photo_urls','property_code','work_no','category','status','urgency','submitted_at','submitter_name','assignee_id','eta','completed_at','repair_notes','repair_photo_urls','attachment_urls','checklist','consumables','labor_minutes','labor_cost','review_status','reviewed_by','reviewed_at','review_notes']
              const cleaned: any = { id: payload.id }
              for (const k of allow) { if ((payload as any)[k] !== undefined) cleaned[k] = (payload as any)[k] }
              if (!cleaned.occurred_at) cleaned.occurred_at = new Date().toISOString().slice(0,10)
              if (cleaned.details && typeof cleaned.details !== 'string') { try { cleaned.details = JSON.stringify(cleaned.details) } catch {} }
              if (!cleaned.submitted_at) cleaned.submitted_at = new Date().toISOString()
              if (!cleaned.status) cleaned.status = 'pending'
              if (cleaned.photo_urls === undefined) cleaned.photo_urls = []
              if (cleaned.repair_photo_urls === undefined) cleaned.repair_photo_urls = []
              if (cleaned.attachment_urls === undefined) cleaned.attachment_urls = []
              if (cleaned.checklist === undefined) cleaned.checklist = []
              if (cleaned.consumables === undefined) cleaned.consumables = []
              if (cleaned.review_status === undefined) cleaned.review_status = 'pending'
              row = await pgInsert(resource, cleaned)
              addAudit(resource, String((row as any)?.id || ''), 'create', null, row, (req as any).user?.sub)
              return res.status(201).json(row)
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
        } else if (resource === 'recurring_payments' && /relation\s+"?recurring_payments"?\s+does\s+not\s+exist/i.test(msg)) {
          try {
            const { pgPool } = require('../dbAdapter')
            if (pgPool) {
              await pgPool.query(`CREATE TABLE IF NOT EXISTS recurring_payments (
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
                pay_account_name text,
                pay_bsb text,
                pay_account_number text,
                pay_ref text,
                expense_id text,
                expense_resource text,
                payment_type text,
                bpay_code text,
                pay_mobile_number text,
                created_at timestamptz DEFAULT now(),
                updated_at timestamptz
              );`)
              const allow = ['id','property_id','scope','vendor','category','category_detail','amount','due_day_of_month','frequency_months','remind_days_before','status','last_paid_date','next_due_date','pay_account_name','pay_bsb','pay_account_number','pay_ref','expense_id','expense_resource','payment_type','bpay_code','pay_mobile_number','report_category']
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
        } else {
          if (resource === 'company_expenses' && /column\s+"?category_detail"?\s+of\s+relation\s+"?company_expenses"?\s+does\s+not\s+exist/i.test(msg)) {
            try {
              const { pgPool } = require('../dbAdapter')
              if (pgPool) {
                await pgPool.query('ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS category_detail text;')
                const allow = ['id','occurred_at','amount','currency','category','category_detail','note']
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
          } else if (resource === 'recurring_payments' && /column\s+"?category_detail"?\s+of\s+relation\s+"?recurring_payments"?\s+does\s+not\s+exist/i.test(msg)) {
            try {
              const { pgPool } = require('../dbAdapter')
              if (pgPool) {
                await pgPool.query('ALTER TABLE recurring_payments ADD COLUMN IF NOT EXISTS category_detail text;')
              const allow = ['id','property_id','scope','vendor','category','category_detail','amount','due_day_of_month','frequency_months','remind_days_before','status','last_paid_date','next_due_date','pay_account_name','pay_bsb','pay_account_number','pay_ref','expense_id','expense_resource','payment_type','bpay_code','pay_mobile_number']
              const cleaned: any = { id: payload.id }
              for (const k of allow) { if ((payload as any)[k] !== undefined) cleaned[k] = (payload as any)[k] }
              if (cleaned.amount !== undefined) cleaned.amount = Number(cleaned.amount || 0)
              const row2 = await pgInsert(resource, cleaned)
              addAudit(resource, String((row2 as any)?.id || ''), 'create', null, row2, (req as any).user?.sub)
              return res.status(201).json(row2)
            }
            } catch (e5) {
              return res.status(500).json({ message: (e5 as any)?.message || 'create failed (column add)' })
            }
          } else if (resource === 'recurring_payments' && /column\s+"?payment_type"?\s+of\s+relation\s+"?recurring_payments"?\s+does\s+not\s+exist/i.test(msg)) {
            try {
              const { pgPool } = require('../dbAdapter')
              if (pgPool) {
                await pgPool.query('ALTER TABLE recurring_payments ADD COLUMN IF NOT EXISTS payment_type text;')
                const allow = ['id','property_id','scope','vendor','category','category_detail','amount','due_day_of_month','frequency_months','remind_days_before','status','last_paid_date','next_due_date','pay_account_name','pay_bsb','pay_account_number','pay_ref','expense_id','expense_resource','payment_type','bpay_code','pay_mobile_number']
                const cleaned: any = { id: payload.id }
                for (const k of allow) { if ((payload as any)[k] !== undefined) cleaned[k] = (payload as any)[k] }
                if (cleaned.amount !== undefined) cleaned.amount = Number(cleaned.amount || 0)
                const row2 = await pgInsert(resource, cleaned)
                addAudit(resource, String((row2 as any)?.id || ''), 'create', null, row2, (req as any).user?.sub)
                return res.status(201).json(row2)
              }
            } catch (e6) {
              return res.status(500).json({ message: (e6 as any)?.message || 'create failed (column add)' })
            }
          } else if (resource === 'recurring_payments' && /column\s+"?bpay_code"?\s+of\s+relation\s+"?recurring_payments"?\s+does\s+not\s+exist/i.test(msg)) {
            try {
              const { pgPool } = require('../dbAdapter')
              if (pgPool) {
                await pgPool.query('ALTER TABLE recurring_payments ADD COLUMN IF NOT EXISTS bpay_code text;')
                const allow = ['id','property_id','scope','vendor','category','category_detail','amount','due_day_of_month','frequency_months','remind_days_before','status','last_paid_date','next_due_date','pay_account_name','pay_bsb','pay_account_number','pay_ref','expense_id','expense_resource','payment_type','bpay_code','pay_mobile_number']
                const cleaned: any = { id: payload.id }
                for (const k of allow) { if ((payload as any)[k] !== undefined) cleaned[k] = (payload as any)[k] }
                if (cleaned.amount !== undefined) cleaned.amount = Number(cleaned.amount || 0)
                const row2 = await pgInsert(resource, cleaned)
                addAudit(resource, String((row2 as any)?.id || ''), 'create', null, row2, (req as any).user?.sub)
                return res.status(201).json(row2)
              }
            } catch (e7) {
              return res.status(500).json({ message: (e7 as any)?.message || 'create failed (column add)' })
            }
          } else if (resource === 'recurring_payments' && /column\s+"?pay_mobile_number"?\s+of\s+relation\s+"?recurring_payments"?\s+does\s+not\s+exist/i.test(msg)) {
            try {
              const { pgPool } = require('../dbAdapter')
              if (pgPool) {
                await pgPool.query('ALTER TABLE recurring_payments ADD COLUMN IF NOT EXISTS pay_mobile_number text;')
                const allow = ['id','property_id','scope','vendor','category','category_detail','amount','due_day_of_month','frequency_months','remind_days_before','status','last_paid_date','next_due_date','pay_account_name','pay_bsb','pay_account_number','pay_ref','expense_id','expense_resource','payment_type','bpay_code','pay_mobile_number']
                const cleaned: any = { id: payload.id }
                for (const k of allow) { if ((payload as any)[k] !== undefined) cleaned[k] = (payload as any)[k] }
                if (cleaned.amount !== undefined) cleaned.amount = Number(cleaned.amount || 0)
                const row2 = await pgInsert(resource, cleaned)
                addAudit(resource, String((row2 as any)?.id || ''), 'create', null, row2, (req as any).user?.sub)
                return res.status(201).json(row2)
              }
            } catch (e8) {
              return res.status(500).json({ message: (e8 as any)?.message || 'create failed (column add)' })
            }
          } else if (resource === 'recurring_payments' && /column\s+"?frequency_months"?\s+of\s+relation\s+"?recurring_payments"?\s+does\s+not\s+exist/i.test(msg)) {
            try {
              const { pgPool } = require('../dbAdapter')
              if (pgPool) {
                await pgPool.query('ALTER TABLE recurring_payments ADD COLUMN IF NOT EXISTS frequency_months integer;')
                const allow = ['id','property_id','scope','vendor','category','category_detail','amount','due_day_of_month','frequency_months','remind_days_before','status','last_paid_date','next_due_date','pay_account_name','pay_bsb','pay_account_number','pay_ref','expense_id','expense_resource','payment_type','bpay_code','pay_mobile_number']
                const cleaned: any = { id: payload.id }
                for (const k of allow) { if ((payload as any)[k] !== undefined) cleaned[k] = (payload as any)[k] }
                if (cleaned.amount !== undefined) cleaned.amount = Number(cleaned.amount || 0)
                const row2 = await pgInsert(resource, cleaned)
                addAudit(resource, String((row2 as any)?.id || ''), 'create', null, row2, (req as any).user?.sub)
                return res.status(201).json(row2)
              }
            } catch (e9) {
              return res.status(500).json({ message: (e9 as any)?.message || 'create failed (column add)' })
            }
          } else if (resource === 'recurring_payments' && /column\s+"?report_category"?\s+of\s+relation\s+"?recurring_payments"?\s+does\s+not\s+exist/i.test(msg)) {
            try {
              const { pgPool } = require('../dbAdapter')
              if (pgPool) {
                await pgPool.query('ALTER TABLE recurring_payments ADD COLUMN IF NOT EXISTS report_category text;')
                const allow = ['id','property_id','scope','vendor','category','category_detail','amount','due_day_of_month','frequency_months','remind_days_before','status','last_paid_date','next_due_date','pay_account_name','pay_bsb','pay_account_number','pay_ref','expense_id','expense_resource','payment_type','bpay_code','pay_mobile_number','report_category']
                const cleaned: any = { id: payload.id }
                for (const k of allow) { if ((payload as any)[k] !== undefined) cleaned[k] = (payload as any)[k] }
                if (cleaned.amount !== undefined) cleaned.amount = Number(cleaned.amount || 0)
                const row2 = await pgInsert(resource, cleaned)
                addAudit(resource, String((row2 as any)?.id || ''), 'create', null, row2, (req as any).user?.sub)
                return res.status(201).json(row2)
              }
            } catch (e10) {
              return res.status(500).json({ message: (e10 as any)?.message || 'create failed (column add)' })
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
  if (resource === 'property_maintenance' || resource === 'property_deep_cleaning') { delete (payload as any).property_code }
  const user = (req as any).user || {}
  if (resource === 'property_deep_cleaning') {
    const sensitive = ['review_status','review_notes','reviewed_by','reviewed_at']
    const touched = sensitive.some(k => Object.prototype.hasOwnProperty.call(payload, k))
    if (touched) {
      const perms: string[] = Array.isArray(user?.perms) ? user.perms : []
      if (!perms.includes('property_deep_cleaning.audit') && !perms.includes('rbac.manage')) return res.status(403).json({ message: 'forbidden' })
    }
  }
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
      if (resource === 'property_maintenance') {
        try {
          const { pgPool } = require('../dbAdapter')
          if (pgPool) {
            await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS work_no text;`)
            await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS category text;`)
            await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS status text;`)
            await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS urgency text;`)
            await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS assignee_id text;`)
            await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS eta date;`)
            await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS completed_at timestamptz;`)
            await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS submitted_at timestamptz;`)
            await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS repair_notes text;`)
            await pgPool.query(`ALTER TABLE property_maintenance ADD COLUMN IF NOT EXISTS repair_photo_urls jsonb;`)
          }
        } catch {}
        if (toUpdate.details && typeof toUpdate.details !== 'string') {
          try { toUpdate.details = JSON.stringify(toUpdate.details) } catch {}
        }
        if (toUpdate.repair_photo_urls && !Array.isArray(toUpdate.repair_photo_urls)) {
          toUpdate.repair_photo_urls = [toUpdate.repair_photo_urls]
        }
      }
      if (resource === 'property_deep_cleaning') {
        try {
          const { pgPool } = require('../dbAdapter')
          if (pgPool) {
            await pgPool.query(`CREATE TABLE IF NOT EXISTS property_deep_cleaning (
              id text PRIMARY KEY,
              property_id text REFERENCES properties(id) ON DELETE SET NULL,
              occurred_at date NOT NULL,
              worker_name text,
              project_desc text,
              started_at timestamptz,
              ended_at timestamptz,
              duration_minutes integer,
              details text,
              notes text,
              created_by text,
              photo_urls jsonb,
              property_code text,
              work_no text,
              category text,
              status text,
              urgency text,
              submitted_at timestamptz,
              submitter_name text,
              assignee_id text,
              eta date,
              completed_at timestamptz,
              repair_notes text,
              repair_photo_urls jsonb,
              attachment_urls jsonb,
              checklist jsonb,
              consumables jsonb,
              labor_minutes integer,
              labor_cost numeric,
              review_status text,
              reviewed_by text,
              reviewed_at timestamptz,
              review_notes text,
              created_at timestamptz DEFAULT now(),
              updated_at timestamptz
            );`)
            await pgPool.query(`ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS project_desc text;`)
            await pgPool.query(`ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS started_at timestamptz;`)
            await pgPool.query(`ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS ended_at timestamptz;`)
            await pgPool.query(`ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS duration_minutes integer;`)
            await pgPool.query(`ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS photo_urls jsonb;`)
            await pgPool.query(`ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS repair_photo_urls jsonb;`)
            await pgPool.query(`ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS attachment_urls jsonb;`)
            await pgPool.query(`ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS checklist jsonb;`)
            await pgPool.query(`ALTER TABLE property_deep_cleaning ADD COLUMN IF NOT EXISTS consumables jsonb;`)
          }
        } catch {}
        if (toUpdate.details && typeof toUpdate.details !== 'string') {
          try { toUpdate.details = JSON.stringify(toUpdate.details) } catch {}
        }
        const listFields = ['photo_urls','repair_photo_urls','attachment_urls','checklist','consumables']
        for (const k of listFields) {
          if (toUpdate[k] !== undefined && toUpdate[k] !== null && (k.endsWith('_urls') || k === 'checklist' || k === 'consumables')) {
            if (k.endsWith('_urls') && !Array.isArray(toUpdate[k])) toUpdate[k] = [toUpdate[k]]
          }
        }
      }
      if (resource === 'property_expenses') {
        const allow = ['occurred_at','amount','currency','category','category_detail','note','property_id','fixed_expense_id','month_key','due_date','paid_date','status']
        const cleaned: any = {}
        for (const k of allow) { if (payload[k] !== undefined) cleaned[k] = payload[k] }
        if (cleaned.amount !== undefined) cleaned.amount = Number(cleaned.amount || 0)
        if (cleaned.occurred_at) cleaned.occurred_at = String(cleaned.occurred_at).slice(0,10)
        if (cleaned.due_date) cleaned.due_date = String(cleaned.due_date).slice(0,10)
        if (cleaned.paid_date) cleaned.paid_date = String(cleaned.paid_date).slice(0,10)
        try {
          const d = cleaned.paid_date || cleaned.occurred_at
          if (d && !cleaned.month_key) {
            const y = String(d).slice(0,4)
            const m = String(d).slice(5,7)
            if (y && m) cleaned.month_key = `${y}-${m}`
          }
        } catch {}
        toUpdate = cleaned
      } else if (resource === 'company_expenses') {
        const allow = ['occurred_at','amount','currency','category','category_detail','note','fixed_expense_id','month_key','due_date','paid_date','status']
        const cleaned: any = {}
        for (const k of allow) { if ((payload as any)[k] !== undefined) cleaned[k] = (payload as any)[k] }
        if (cleaned.amount !== undefined) cleaned.amount = Number(cleaned.amount || 0)
        if (cleaned.occurred_at) cleaned.occurred_at = String(cleaned.occurred_at).slice(0,10)
        if (cleaned.due_date) cleaned.due_date = String(cleaned.due_date).slice(0,10)
        if (cleaned.paid_date) cleaned.paid_date = String(cleaned.paid_date).slice(0,10)
        toUpdate = cleaned
      } else if (resource === 'recurring_payments') {
        const allow = ['property_id','scope','vendor','category','category_detail','amount','due_day_of_month','frequency_months','remind_days_before','status','last_paid_date','next_due_date','pay_account_name','pay_bsb','pay_account_number','pay_ref','expense_id','expense_resource','payment_type','bpay_code','pay_mobile_number','report_category']
        const cleaned: any = {}
        for (const k of allow) { if ((payload as any)[k] !== undefined) cleaned[k] = (payload as any)[k] }
        if (cleaned.amount !== undefined) cleaned.amount = Number(cleaned.amount || 0)
        if (cleaned.frequency_months !== undefined) cleaned.frequency_months = Number(cleaned.frequency_months || 1)
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
      let row
      try {
        if (resource === 'property_maintenance') {
          const { pgPool } = require('../dbAdapter')
          if (pgPool) {
            const keys = Object.keys(toUpdate).filter(k => toUpdate[k] !== undefined)
            const set = keys.map((k, i) => (k === 'repair_photo_urls' || k === 'photo_urls') ? `"${k}" = $${i + 1}::jsonb` : `"${k}" = $${i + 1}`).join(', ')
            const values = keys.map((k) => ((k === 'repair_photo_urls' || k === 'photo_urls')
              ? JSON.stringify(Array.isArray(toUpdate[k]) ? toUpdate[k] : [])
              : toUpdate[k]))
            const sql = `UPDATE property_maintenance SET ${set} WHERE id = $${keys.length + 1} RETURNING *`
            const res2 = await pgPool.query(sql, [...values, id])
            row = res2.rows && res2.rows[0]
          } else {
            row = await pgUpdate(resource, id, toUpdate)
          }
        } else if (resource === 'property_deep_cleaning') {
          const { pgPool } = require('../dbAdapter')
          if (pgPool) {
            const jsonbFields = new Set(['photo_urls','repair_photo_urls','attachment_urls','checklist','consumables'])
            const keys = Object.keys(toUpdate).filter(k => toUpdate[k] !== undefined)
            const set = keys.map((k, i) => jsonbFields.has(k) ? `"${k}" = $${i + 1}::jsonb` : `"${k}" = $${i + 1}`).join(', ')
            const values = keys.map((k) => (jsonbFields.has(k)
              ? JSON.stringify(toUpdate[k] === null ? null : toUpdate[k])
              : toUpdate[k]))
            const sql = `UPDATE property_deep_cleaning SET ${set} WHERE id = $${keys.length + 1} RETURNING *`
            const res2 = await pgPool.query(sql, [...values, id])
            row = res2.rows && res2.rows[0]
          } else {
            row = await pgUpdate(resource, id, toUpdate)
          }
        } else {
          row = await pgUpdate(resource, id, toUpdate)
        }
      } catch (e: any) {
        const msg = String(e?.message || '')
        if (resource === 'recurring_payments' && /column\s+"?frequency_months"?\s+of\s+relation\s+"?recurring_payments"?\s+does\s+not\s+exist/i.test(msg)) {
          const { pgPool } = require('../dbAdapter')
          if (pgPool) await pgPool.query('ALTER TABLE recurring_payments ADD COLUMN IF NOT EXISTS frequency_months integer;')
          row = await pgUpdate(resource, id, toUpdate)
        } else if (resource === 'recurring_payments' && /column\s+"?report_category"?\s+of\s+relation\s+"?recurring_payments"?\s+does\s+not\s+exist/i.test(msg)) {
          const { pgPool } = require('../dbAdapter')
          if (pgPool) await pgPool.query('ALTER TABLE recurring_payments ADD COLUMN IF NOT EXISTS report_category text;')
          row = await pgUpdate(resource, id, toUpdate)
        } else {
          throw e
        }
      }
      addAudit(resource, id, 'update', null, row, (req as any).user?.sub)
      return res.json(row || { id, ...payload })
    }
    // Supabase branch removed
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
    // Supabase branch removed
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

async function ensureRecurringFrequencyInteger(pgPool: any) {
  try {
    await pgPool.query('ALTER TABLE recurring_payments ADD COLUMN IF NOT EXISTS frequency_months integer;')
    await pgPool.query('ALTER TABLE recurring_payments ALTER COLUMN frequency_months TYPE integer USING frequency_months::integer;')
  } catch {}
}
