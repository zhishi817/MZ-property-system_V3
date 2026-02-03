import { Router } from 'express'
import { db, FinanceTransaction, Payout, CompanyPayout, PropertyRevenueStatus, addAudit } from '../store'
import { hasPg, pgSelect, pgInsert, pgUpdate, pgDelete, pgRunInTransaction } from '../dbAdapter'
import multer from 'multer'
import path from 'path'
import { hasR2, r2Upload } from '../r2'
import fs from 'fs'
import { z } from 'zod'
import { buildExpenseFingerprint, hasFingerprint, setFingerprint, addDedupLog } from '../fingerprint'
import { requirePerm, requireAnyPerm } from '../auth'
import { PDFDocument } from 'pdf-lib'
import { pgInsertOnConflictDoNothing, pgPool } from '../dbAdapter'

export const router = Router()
const upload = hasR2 ? multer({ storage: multer.memoryStorage() }) : multer({ dest: path.join(process.cwd(), 'uploads') })
const memUpload = multer({ storage: multer.memoryStorage() })
const mergeMaxMb = Math.max(5, Math.min(200, Number(process.env.MERGE_PDF_MAX_MB || 50)))
const mergeUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: mergeMaxMb * 1024 * 1024 } })

function toReportCat(raw?: string, detail?: string): string {
  const v = String(raw||'').toLowerCase()
  const d = String(detail||'').toLowerCase()
  const s = v + ' ' + d
  if (['carpark'].includes(v) || s.includes('车位')) return 'parking_fee'
  if (['owners_corp','ownerscorp','body_corp','bodycorp'].includes(v) || s.includes('物业')) return 'body_corp'
  if (['internet','nbn'].includes(v) || s.includes('internet') || s.includes('nbn') || s.includes('网')) return 'internet'
  if (['electricity'].includes(v) || s.includes('electric') || s.includes('电')) return 'electricity'
  if (['water'].includes(v) || ((s.includes('water') || s.includes('水')) && !s.includes('热'))) return 'water'
  if (['gas','gas_hot_water','hot_water'].includes(v) || s.includes('gas') || s.includes('热水') || s.includes('煤气')) return 'gas'
  if (['consumables'].includes(v) || s.includes('consumable') || s.includes('消耗')) return 'consumables'
  if (['council_rate','council'].includes(v) || s.includes('council') || s.includes('市政')) return 'council'
  if (s.includes('management_fee') || s.includes('管理费')) return 'management_fee'
  return 'other'
}

router.get('/', async (_req, res) => {
  try {
    
    if (hasPg) {
      const raw = await pgSelect('finance_transactions')
      const rows: any[] = Array.isArray(raw) ? raw : []
      return res.json(rows)
    }
    return res.json(db.financeTransactions)
  } catch {
    return res.json(db.financeTransactions)
  }
})

const txSchema = z.object({ kind: z.enum(['income','expense']), amount: z.coerce.number().min(0), currency: z.string(), ref_type: z.string().optional(), ref_id: z.string().optional(), occurred_at: z.string().optional(), note: z.string().optional(), category: z.string().optional(), property_id: z.string().optional(), invoice_url: z.string().optional(), category_detail: z.string().optional() })
router.post('/', requirePerm('finance.tx.write'), async (req, res) => {
  const parsed = txSchema.safeParse(req.body)
  if (!parsed.success) {
    const msg = parsed.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; ')
    return res.status(400).json({ message: msg || 'invalid payload' })
  }
  const { v4: uuid } = require('uuid')
  const tx: FinanceTransaction = { id: uuid(), occurred_at: parsed.data.occurred_at || new Date().toISOString(), ...parsed.data }
  db.financeTransactions.push(tx)
  addAudit('FinanceTransaction', tx.id, 'create', null, tx)
  if (hasPg) {
    try {
      const result = await pgRunInTransaction(async (client) => {
        function normalizeStatus(raw: any): string { return String(raw || '').trim().toLowerCase() }
        function isCanceledStatus(raw: any): boolean {
          const s = normalizeStatus(raw)
          return s === 'canceled' || s === 'cancelled'
        }
        try {
          await client.query('ALTER TABLE company_incomes ADD COLUMN IF NOT EXISTS property_id text REFERENCES properties(id) ON DELETE SET NULL;')
          await client.query('ALTER TABLE company_incomes ADD COLUMN IF NOT EXISTS ref_type text;')
          await client.query('ALTER TABLE company_incomes ADD COLUMN IF NOT EXISTS ref_id text;')
          await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_company_incomes_ref ON company_incomes(category, ref_type, ref_id);`)
        } catch {}

        const cat0 = String((tx as any).category || '').toLowerCase()
        if (String(tx.kind) === 'income' && cat0 === 'cancel_fee' && String((tx as any).ref_type || '') === 'order' && String((tx as any).ref_id || '')) {
          const dup = await pgSelect('finance_transactions', '*', { ref_type: 'order', ref_id: String((tx as any).ref_id), category: 'cancel_fee' }, client)
          if (Array.isArray(dup) && dup[0]) {
            return { txRow: dup[0], duplicated: true }
          }
        }

        const txRow = await pgInsert('finance_transactions', tx as any, client)
        try {
          const cat = String((tx as any).category || '').toLowerCase()
          const isIncome = String(tx.kind) === 'income'
          if (isIncome && (cat === 'cancel_fee' || cat === 'late_checkout' || cat === 'other' || cat === 'cleaning_fee' || cat === 'mgmt_fee')) {
            const occurred = String(tx.occurred_at || '').slice(0, 10) || new Date().toISOString().slice(0,10)
            const rec: any = {
              id: uuid(),
              occurred_at: occurred,
              amount: Number(tx.amount || 0),
              currency: String(tx.currency || 'AUD'),
              category: cat || 'other',
              note: String(tx.note || ''),
              property_id: (tx as any).property_id || null,
              ref_type: (tx as any).ref_type || null,
              ref_id: (tx as any).ref_id || null,
            }

            if (cat === 'cancel_fee' && String((tx as any).ref_type || '') === 'order' && String((tx as any).ref_id || '')) {
              const oid = String((tx as any).ref_id)
              const ordRows = await pgSelect('orders', 'id,status,count_in_income', { id: oid }, client)
              const ord = Array.isArray(ordRows) ? ordRows[0] : null
              const canceled = isCanceledStatus(ord?.status)
              const countInIncome = !!(ord as any)?.count_in_income
              if (canceled && countInIncome) {
                return { txRow: txRow || tx, duplicated: false, skippedCompanyIncome: true }
              }
            }

            if (rec.ref_type && rec.ref_id) {
              const ins = await pgInsertOnConflictDoNothing('company_incomes', rec, ['category', 'ref_type', 'ref_id'], client)
              if (ins) addAudit('CompanyIncome', String((ins as any).id || rec.id), 'create', null, ins as any)
            } else {
              const dup2 = await pgSelect('company_incomes', '*', { occurred_at: rec.occurred_at, category: rec.category, amount: rec.amount, note: rec.note, property_id: rec.property_id }, client)
              if (!(Array.isArray(dup2) && dup2[0])) {
                const ins = await pgInsert('company_incomes', rec as any, client)
                if (ins) addAudit('CompanyIncome', String((ins as any).id || rec.id), 'create', null, ins as any)
              }
            }
          }
        } catch {}
        return { txRow: txRow || tx, duplicated: false }
      })
      const row = (result as any)?.txRow
      const status = (result as any)?.duplicated ? 200 : 201
      return res.status(status).json(row || tx)
    } catch (e: any) {
      return res.status(500).json({ message: e?.message || 'pg insert failed' })
    }
  }
  return res.status(201).json(tx)
})

// Backfill company_incomes from finance_transactions for a given month
router.post('/company-incomes/backfill', requireAnyPerm(['finance.tx.write','company_incomes.write']), async (req, res) => {
  try {
    if (!hasPg) return res.status(400).json({ message: 'pg required' })
    const month = String(((req.body || {}).month) || ((req.query || {}).month) || '')
    const dryRun = String(((req.body || {}).dry_run) ?? ((req.query || {}) as any).dry_run ?? '').toLowerCase() === 'true' || String(((req.body || {}).dry_run) ?? ((req.query || {}) as any).dry_run ?? '') === '1'
    if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ message: 'invalid month format' })
    const lockKey = 91000000 + Number(month.replace('-', ''))
    const lock = await pgPool!.query('SELECT pg_try_advisory_lock($1) AS ok', [lockKey])
    const ok = !!(lock?.rows?.[0]?.ok)
    if (!ok) return res.status(409).json({ message: 'backfill already running', reason: 'locked', month })
    try {
      const y = Number(month.slice(0,4)), m = Number(month.slice(5,7))
      const start = new Date(Date.UTC(y, m - 1, 1)).toISOString().slice(0,10)
      const endExclusive = new Date(Date.UTC(y, m, 1)).toISOString().slice(0,10)
      function normalizeStatus(raw: any): string { return String(raw || '').trim().toLowerCase() }
      function isCanceledStatus(raw: any): boolean {
        const s = normalizeStatus(raw)
        return s === 'canceled' || s === 'cancelled'
      }

      const result = await pgRunInTransaction(async (client) => {
        try {
          await client.query('ALTER TABLE company_incomes ADD COLUMN IF NOT EXISTS property_id text REFERENCES properties(id) ON DELETE SET NULL;')
          await client.query('ALTER TABLE company_incomes ADD COLUMN IF NOT EXISTS ref_type text;')
          await client.query('ALTER TABLE company_incomes ADD COLUMN IF NOT EXISTS ref_id text;')
          await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_company_incomes_ref ON company_incomes(category, ref_type, ref_id);`)
        } catch {}

        const rs = await client.query(
          `SELECT
             t.id AS tx_id,
             (t.occurred_at)::date AS occurred_at,
             t.amount,
             t.currency,
             t.note,
             t.property_id,
             t.ref_id AS order_id,
             o.status AS order_status,
             o.count_in_income AS order_count_in_income
           FROM finance_transactions t
           LEFT JOIN orders o ON o.id = t.ref_id
           WHERE t.kind='income'
             AND t.category='cancel_fee'
             AND t.ref_type='order'
             AND t.ref_id IS NOT NULL
             AND (t.occurred_at)::date >= to_date($1,'YYYY-MM-DD')
             AND (t.occurred_at)::date < to_date($2,'YYYY-MM-DD')`,
          [start, endExclusive]
        )
        const rows: any[] = rs.rows || []
        let scanned = rows.length
        let updated_ref = 0
        let inserted = 0
        let deleted = 0
        let deleted_tx = 0
        let ambiguous = 0
        let skipped_missing_order = 0

        const sample_ambiguous: any[] = []
        const sample_missing_order: any[] = []

        for (const t of rows) {
          const orderId = String(t.order_id || '')
          if (!orderId) continue
          const occ = String(t.occurred_at || '').slice(0,10)
          const amt = Number(t.amount || 0)
          const propId = String(t.property_id || '') || null
          const statusKnown = !!t.order_status
          const canceled = isCanceledStatus(t.order_status)
          const countInIncome = !!t.order_count_in_income

          if (!t.order_status) {
            skipped_missing_order++
            if (sample_missing_order.length < 10) sample_missing_order.push({ order_id: orderId, tx_id: String(t.tx_id || ''), occurred_at: occ, amount: amt })
          }

          const existingByRef = await pgSelect('company_incomes', 'id', { category: 'cancel_fee', ref_type: 'order', ref_id: orderId }, client)
          const hasByRef = Array.isArray(existingByRef) && existingByRef[0]
          if (!hasByRef) {
            const cand = await client.query(
              `SELECT id FROM company_incomes
               WHERE category='cancel_fee'
                 AND (ref_type IS NULL OR ref_type = '')
                 AND (ref_id IS NULL OR ref_id = '')
                 AND occurred_at = to_date($1,'YYYY-MM-DD')
                 AND amount = $2
                 AND (property_id IS NOT DISTINCT FROM $3)`,
              [occ, amt, propId]
            )
            const ids: string[] = (cand.rows || []).map((r: any) => String(r.id))
            if (ids.length === 1) {
              if (!dryRun) {
                await client.query(`UPDATE company_incomes SET ref_type='order', ref_id=$1 WHERE id=$2`, [orderId, ids[0]])
              }
              updated_ref++
            } else if (ids.length > 1) {
              ambiguous++
              if (sample_ambiguous.length < 10) sample_ambiguous.push({ order_id: orderId, occurred_at: occ, amount: amt, candidate_ids: ids })
            }
          }

          if (statusKnown && !canceled) {
            if (!dryRun) {
              const del = await client.query(`DELETE FROM company_incomes WHERE category='cancel_fee' AND ref_type='order' AND ref_id=$1 RETURNING id`, [orderId])
              deleted += Number(del.rowCount || 0)
              const delTx = await client.query(`DELETE FROM finance_transactions WHERE id=$1 RETURNING id`, [String(t.tx_id || '')])
              deleted_tx += Number(delTx.rowCount || 0)
            } else {
              deleted += hasByRef ? 1 : 0
              deleted_tx += 1
            }
            continue
          }

          if (!statusKnown) continue
          const shouldCompany = canceled && !countInIncome
          if (!shouldCompany) {
            if (!dryRun) {
              const del = await client.query(`DELETE FROM company_incomes WHERE category='cancel_fee' AND ref_type='order' AND ref_id=$1 RETURNING id`, [orderId])
              deleted += Number(del.rowCount || 0)
            } else {
              deleted += hasByRef ? 1 : 0
            }
            continue
          }

          const rec: any = {
            id: require('uuid').v4(),
            occurred_at: occ,
            amount: amt,
            currency: String(t.currency || 'AUD'),
            category: 'cancel_fee',
            note: String(t.note || ''),
            property_id: propId,
            ref_type: 'order',
            ref_id: orderId,
          }
          if (!dryRun) {
            const ins = await pgInsertOnConflictDoNothing('company_incomes', rec, ['category', 'ref_type', 'ref_id'], client)
            if (ins) {
              inserted++
              try { addAudit('CompanyIncome', String((ins as any).id || rec.id), 'create', null, ins as any) } catch {}
            }
          } else {
            if (!hasByRef) inserted++
          }
        }

        return {
          month,
          dry_run: dryRun,
          scanned,
          updated_ref,
          inserted,
          deleted,
          deleted_tx,
          ambiguous,
          skipped_missing_order,
          sample_ambiguous,
          sample_missing_order,
        }
      })

      return res.status(201).json(result)
    } finally {
      try { await pgPool!.query('SELECT pg_advisory_unlock($1)', [lockKey]) } catch {}
    }
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'backfill_failed' })
  }
})

router.post('/invoices', requireAnyPerm(['finance.tx.write','property_expenses.write','company_expenses.write']), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'missing file' })
  try {
    if (hasR2 && req.file && (req.file as any).buffer) {
      const ext = path.extname(req.file.originalname) || ''
      const key = `invoices/${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`
      const url = await r2Upload(key, req.file.mimetype || 'application/octet-stream', (req.file as any).buffer)
      return res.status(201).json({ url })
    }
    const url = `/uploads/${req.file.filename}`
    return res.status(201).json({ url })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'upload failed' })
  }
})

// Expense-specific invoice resource
router.get('/expense-invoices/:expenseId', requireAnyPerm(['property_expenses.view','finance.tx.write','property_expenses.write']), async (req, res) => {
  const { expenseId } = req.params
  try {
    if (hasPg) {
      try {
        const rows = await pgSelect('expense_invoices', '*', { expense_id: expenseId })
        return res.json(Array.isArray(rows) ? rows : [])
      } catch (e: any) {
        const msg = String(e?.message || '')
        const { pgPool } = require('../dbAdapter')
        if (pgPool && /relation\s+"?expense_invoices"?\s+does\s+not\s+exist/i.test(msg)) {
          await pgPool.query(`CREATE TABLE IF NOT EXISTS expense_invoices (
            id text PRIMARY KEY,
            expense_id text REFERENCES property_expenses(id) ON DELETE CASCADE,
            url text NOT NULL,
            file_name text,
            mime_type text,
            file_size integer,
            created_at timestamptz DEFAULT now(),
            created_by text
          );`)
          await pgPool.query('CREATE INDEX IF NOT EXISTS idx_expense_invoices_expense ON expense_invoices(expense_id);')
          const rows2 = await pgSelect('expense_invoices', '*', { expense_id: expenseId })
          return res.json(Array.isArray(rows2) ? rows2 : [])
        }
        throw e
      }
    }
    const rows = db.expenseInvoices.filter((x: any) => String(x.expense_id) === String(expenseId))
    return res.json(rows)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'list failed' })
  }
})

router.post('/expense-invoices/:expenseId/upload', requireAnyPerm(['property_expenses.write','finance.tx.write']), memUpload.single('file'), async (req, res) => {
  const { expenseId } = req.params
  if (!req.file) return res.status(400).json({ message: 'missing file' })
  try {
    const user = (req as any).user || {}
    const { v4: uuid } = require('uuid')
    const ext = path.extname(req.file.originalname) || ''
    let url = ''
    if (hasR2 && (req.file as any).buffer) {
      const key = `expenses/${expenseId}/${uuid()}${ext}`
      url = await r2Upload(key, req.file.mimetype || 'application/octet-stream', (req.file as any).buffer)
    } else {
      const dir = path.join(process.cwd(), 'uploads', 'expenses', expenseId)
      await fs.promises.mkdir(dir, { recursive: true })
      const name = `${uuid()}${ext}`
      const full = path.join(dir, name)
      await fs.promises.writeFile(full, (req.file as any).buffer)
      url = `/uploads/expenses/${expenseId}/${name}`
    }
    if (hasPg) {
      try {
        const row = await pgInsert('expense_invoices', {
          id: uuid(),
          expense_id: expenseId,
          url,
          file_name: req.file.originalname,
          mime_type: req.file.mimetype,
          file_size: req.file.size,
          created_by: user?.sub || user?.username || null
        } as any)
        return res.status(201).json(row || { url })
      } catch (e: any) {
        const msg = String(e?.message || '')
        const { pgPool } = require('../dbAdapter')
        if (pgPool && /relation\s+"?expense_invoices"?\s+does\s+not\s+exist/i.test(msg)) {
          await pgPool.query(`CREATE TABLE IF NOT EXISTS expense_invoices (
            id text PRIMARY KEY,
            expense_id text REFERENCES property_expenses(id) ON DELETE CASCADE,
            url text NOT NULL,
            file_name text,
            mime_type text,
            file_size integer,
            created_at timestamptz DEFAULT now(),
            created_by text
          );`)
          await pgPool.query('CREATE INDEX IF NOT EXISTS idx_expense_invoices_expense ON expense_invoices(expense_id);')
          const row2 = await pgInsert('expense_invoices', {
            id: uuid(), expense_id: expenseId, url,
            file_name: req.file.originalname, mime_type: req.file.mimetype,
            file_size: req.file.size, created_by: user?.sub || user?.username || null
          } as any)
          return res.status(201).json(row2 || { url })
        }
        throw e
      }
    }
    const id = uuid()
    db.expenseInvoices.push({ id, expense_id: expenseId, url, file_name: req.file.originalname, mime_type: req.file.mimetype, file_size: req.file.size, created_at: new Date().toISOString(), created_by: user?.sub || user?.username || undefined } as any)
    return res.status(201).json({ id, url })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'upload failed' })
  }
})

router.delete('/expense-invoices/:id', requireAnyPerm(['property_expenses.write','finance.tx.write']), async (req, res) => {
  const { id } = req.params
  try {
    if (hasPg) {
      try { await pgDelete('expense_invoices', id); return res.json({ ok: true }) } catch (e: any) {
        const msg = String(e?.message || '')
        const { pgPool } = require('../dbAdapter')
        if (pgPool && /relation\s+"?expense_invoices"?\s+does\s+not\s+exist/i.test(msg)) {
          await pgPool.query(`CREATE TABLE IF NOT EXISTS expense_invoices (
            id text PRIMARY KEY,
            expense_id text REFERENCES property_expenses(id) ON DELETE CASCADE,
            url text NOT NULL,
            file_name text,
            mime_type text,
            file_size integer,
            created_at timestamptz DEFAULT now(),
            created_by text
          );`)
          await pgPool.query('CREATE INDEX IF NOT EXISTS idx_expense_invoices_expense ON expense_invoices(expense_id);')
          await pgDelete('expense_invoices', id)
          return res.json({ ok: true })
        }
        throw e
      }
    }
    const idx = db.expenseInvoices.findIndex((x: any) => x.id === id)
    if (idx !== -1) db.expenseInvoices.splice(idx, 1)
    return res.json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'delete failed' })
  }
})

// Query invoices by property and occurred_at range via expense join
router.get('/expense-invoices/search', requireAnyPerm(['property_expenses.view','finance.tx.write','property_expenses.write']), async (req, res) => {
  const { property_id, from, to } = (req.query || {}) as any
  if (!property_id || !from || !to) return res.status(400).json({ message: 'missing property_id/from/to' })
  try {
    if (hasPg) {
      const { pgPool } = require('../dbAdapter')
      if (pgPool) {
        const sql = `SELECT i.* FROM expense_invoices i JOIN property_expenses e ON i.expense_id = e.id WHERE e.property_id = $1 AND e.occurred_at >= $2 AND e.occurred_at <= $3 ORDER BY i.created_at ASC`
        const r = await pgPool.query(sql, [property_id, from, to])
        return res.json(r.rows || [])
      }
    }
    const rows = db.expenseInvoices.filter((ii: any) => {
      const exp = (db as any).property_expenses?.find?.((e: any) => String(e.id) === String(ii.expense_id))
      if (!exp) return false
      const pidOk = String(exp.property_id || '') === String(property_id)
      const dt = exp.occurred_at ? new Date(exp.occurred_at) : null
      const fromD = new Date(String(from))
      const toD = new Date(String(to))
      const inRange = dt ? (dt >= fromD && dt <= toD) : false
      return pidOk && inRange
    })
    return res.json(rows)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'search failed' })
  }
})

// Merge monthly statement PDF with multiple invoice PDFs and return a single PDF
router.post(
  '/merge-pdf',
  requireAnyPerm(['finance.payout', 'finance.tx.write', 'property_expenses.view', 'invoice.view']),
  mergeUpload.single('statement'),
  async (req: any, res: any) => {
  try {
    const { statement_pdf_base64, statement_pdf_url, invoice_urls } = req.body || {}
    const statementFile = (req as any).file as any
    if (!statementFile?.buffer && !statement_pdf_base64 && !statement_pdf_url) return res.status(400).json({ message: 'missing statement pdf' })
    let urls: string[] = []
    if (Array.isArray(invoice_urls)) {
      urls = invoice_urls.filter((u: any) => typeof u === 'string')
    } else if (typeof invoice_urls === 'string') {
      try {
        const parsed = JSON.parse(invoice_urls)
        if (Array.isArray(parsed)) urls = parsed.filter((u: any) => typeof u === 'string')
        else if (typeof parsed === 'string') urls = [parsed]
      } catch {
        urls = invoice_urls.split(',').map(s => s.trim()).filter(Boolean)
      }
    }
    const allowedHosts = (() => {
      const hosts = new Set<string>()
      const addHost = (h: string) => { if (h) hosts.add(h.toLowerCase()) }
      try {
        const apiBase = String(process.env.API_BASE || '')
        if (apiBase) addHost(new URL(apiBase).host)
      } catch {}
      try {
        const r2Base = String(process.env.R2_PUBLIC_BASE_URL || process.env.R2_PUBLIC_BASE || '')
        if (r2Base) addHost(new URL(r2Base).host)
      } catch {}
      const reqHost = String(req.headers.host || '')
      if (reqHost) addHost(reqHost)
      return hosts
    })()
    function normalizeFetchUrl(input: string): string {
      const raw = String(input || '').trim()
      if (!raw) throw new Error('invalid url')
      if (raw.startsWith('/')) {
        const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http')
        const host = String(req.headers.host || '')
        if (!host) throw new Error('invalid host')
        return `${proto}://${host}${raw}`
      }
      return raw
    }
    function assertAllowed(urlStr: string) {
      const u = new URL(urlStr)
      const proto = u.protocol.toLowerCase()
      if (proto !== 'http:' && proto !== 'https:') throw new Error('invalid protocol')
      const host = u.host.toLowerCase()
      if (!allowedHosts.has(host)) throw new Error('disallowed host')
    }
    async function fetchBytes(u: string): Promise<Uint8Array> {
      const url = normalizeFetchUrl(u)
      assertAllowed(url)
      const r = await fetch(url)
      if (!r.ok) throw new Error(`fetch failed: ${r.status}`)
      const ab = await r.arrayBuffer()
      return new Uint8Array(ab)
    }
    let merged = await PDFDocument.create()
    // append statement
    if (statementFile?.buffer && Buffer.isBuffer(statementFile.buffer)) {
      let src: any
      try {
        src = await PDFDocument.load(new Uint8Array(statementFile.buffer))
      } catch (e: any) {
        return res.status(400).json({ message: `invalid statement pdf: ${String(e?.message || 'load failed')}` })
      }
      const copied = await merged.copyPages(src, src.getPageIndices())
      copied.forEach(p => merged.addPage(p))
    } else if (statement_pdf_base64 && typeof statement_pdf_base64 === 'string') {
      const b64 = statement_pdf_base64.replace(/^data:application\/pdf;base64,/, '')
      const bytes = Uint8Array.from(Buffer.from(b64, 'base64'))
      let src: any
      try {
        src = await PDFDocument.load(bytes)
      } catch (e: any) {
        return res.status(400).json({ message: `invalid statement pdf: ${String(e?.message || 'load failed')}` })
      }
      const copied = await merged.copyPages(src, src.getPageIndices())
      copied.forEach(p => merged.addPage(p))
    } else if (statement_pdf_url && typeof statement_pdf_url === 'string') {
      const bytes = await fetchBytes(statement_pdf_url)
      let src: any
      try {
        src = await PDFDocument.load(bytes)
      } catch (e: any) {
        return res.status(400).json({ message: `invalid statement pdf: ${String(e?.message || 'load failed')}` })
      }
      const copied = await merged.copyPages(src, src.getPageIndices())
      copied.forEach(p => merged.addPage(p))
    }
    for (const u of urls) {
      try {
        if (/\.pdf($|\?)/i.test(u || '')) {
          const bytes = await fetchBytes(u)
          const src = await PDFDocument.load(bytes)
          const copied = await merged.copyPages(src, src.getPageIndices())
          copied.forEach(p => merged.addPage(p))
        } else if (/\.(png|jpg|jpeg)($|\?)/i.test(u || '')) {
          const bytes = await fetchBytes(u)
          const img = /\.png($|\?)/i.test(u || '') ? await merged.embedPng(bytes) : await merged.embedJpg(bytes)
          const page = merged.addPage([595, 842])
          const maxW = 595 - 60
          const maxH = 842 - 60
          const scale = Math.min(maxW / img.width, maxH / img.height)
          const w = img.width * scale
          const h = img.height * scale
          const x = (595 - w) / 2
          const y = (842 - h) / 2
          page.drawImage(img, { x, y, width: w, height: h })
        }
      } catch {}
    }
    const out = await merged.save()
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', 'attachment; filename="statement-merged.pdf"')
    return res.status(200).send(Buffer.from(out))
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'merge failed' })
  }
  },
  (err: any, _req: any, res: any, _next: any) => {
    const code = String(err?.code || '')
    if (code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ message: `报表PDF过大（最大 ${mergeMaxMb}MB）` })
    }
    if (code) return res.status(400).json({ message: err?.message || `upload failed (${code})` })
    return res.status(500).json({ message: err?.message || 'merge failed' })
  }
)

router.post('/send-monthly', requirePerm('finance.payout'), (req, res) => {
  const { landlord_id, month } = req.body || {}
  if (!landlord_id || !month) return res.status(400).json({ message: 'missing landlord_id or month' })
  res.json({ ok: true })
})

router.post('/send-annual', requirePerm('finance.payout'), (req, res) => {
  const { landlord_id, year } = req.body || {}
  if (!landlord_id || !year) return res.status(400).json({ message: 'missing landlord_id or year' })
  res.json({ ok: true })
})

const revenueStatusGetMonthRe = /^\d{4}-\d{2}$/
router.get('/property-revenue-status', async (req, res) => {
  try {
    const from = String((req.query as any)?.from || '')
    const to = String((req.query as any)?.to || '')
    const property_id = String((req.query as any)?.property_id || '')
    const hasRange = !!(from && to)
    if (hasRange && (!revenueStatusGetMonthRe.test(from) || !revenueStatusGetMonthRe.test(to))) {
      return res.status(400).json({ message: 'invalid month range' })
    }
    if (hasPg) {
      const wh: string[] = []
      const vals: any[] = []
      if (hasRange) {
        wh.push(`month_key >= $${vals.length + 1} AND month_key <= $${vals.length + 2}`)
        vals.push(from, to)
      }
      if (property_id) {
        wh.push(`property_id = $${vals.length + 1}`)
        vals.push(property_id)
      }
      const where = wh.length ? `WHERE ${wh.join(' AND ')}` : ''
      const sql = `SELECT * FROM property_revenue_statuses ${where} ORDER BY month_key ASC`
      const rs = await pgPool!.query(sql, vals)
      return res.json(rs.rows || [])
    }
    const list = db.propertyRevenueStatuses || []
    const filtered = list.filter((r) => {
      if (property_id && String(r.property_id) !== property_id) return false
      if (hasRange && (String(r.month_key) < from || String(r.month_key) > to)) return false
      return true
    })
    filtered.sort((a, b) => String(a.month_key).localeCompare(String(b.month_key)))
    return res.json(filtered)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'get status failed' })
  }
})

const revenueStatusPatchSchema = z.object({
  property_id: z.string().min(1),
  month_key: z.string().regex(revenueStatusGetMonthRe),
  scheduled_email_set: z.boolean().optional(),
  transferred: z.boolean().optional(),
})
router.patch('/property-revenue-status', requirePerm('finance.payout'), async (req, res) => {
  const parsed = revenueStatusPatchSchema.safeParse(req.body || {})
  if (!parsed.success) {
    const msg = parsed.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; ')
    return res.status(400).json({ message: msg || 'invalid payload' })
  }
  const actor = String((req as any)?.user?.sub || '')
  try {
    const nowIso = new Date().toISOString()
    const { property_id, month_key, scheduled_email_set, transferred } = parsed.data
    if (hasPg) {
      const exists = await pgSelect('property_revenue_statuses', '*', { property_id, month_key })
      const before = Array.isArray(exists) ? exists[0] : null
      if (before?.id) {
        const updated: any = {
          scheduled_email_set: scheduled_email_set ?? before.scheduled_email_set ?? false,
          transferred: transferred ?? before.transferred ?? false,
          updated_at: nowIso,
          updated_by: actor || null,
        }
        const row = await pgUpdate('property_revenue_statuses', String(before.id), updated)
        try { addAudit('PropertyRevenueStatus', String(before.id), 'update', before, row || { ...before, ...updated }, actor || undefined) } catch {}
        return res.json(row || { ...before, ...updated })
      }
      const id = require('uuid').v4()
      const created: PropertyRevenueStatus = {
        id,
        property_id,
        month_key,
        scheduled_email_set: scheduled_email_set ?? false,
        transferred: transferred ?? false,
        updated_at: nowIso,
        updated_by: actor || undefined,
      }
      const row = await pgInsert('property_revenue_statuses', created as any)
      try { addAudit('PropertyRevenueStatus', id, 'create', null, row || created, actor || undefined) } catch {}
      return res.status(201).json(row || created)
    }
    const list = db.propertyRevenueStatuses || (db.propertyRevenueStatuses = [])
    const idx = list.findIndex(r => String(r.property_id) === property_id && String(r.month_key) === month_key)
    if (idx >= 0) {
      const before = list[idx]
      const after: PropertyRevenueStatus = {
        ...before,
        scheduled_email_set: scheduled_email_set ?? before.scheduled_email_set ?? false,
        transferred: transferred ?? before.transferred ?? false,
        updated_at: nowIso,
        updated_by: actor || undefined,
      }
      list[idx] = after
      try { addAudit('PropertyRevenueStatus', String(after.id), 'update', before, after, actor || undefined) } catch {}
      return res.json(after)
    }
    const id = require('uuid').v4()
    const created: PropertyRevenueStatus = {
      id,
      property_id,
      month_key,
      scheduled_email_set: scheduled_email_set ?? false,
      transferred: transferred ?? false,
      updated_at: nowIso,
      updated_by: actor || undefined,
    }
    list.push(created)
    try { addAudit('PropertyRevenueStatus', id, 'create', null, created, actor || undefined) } catch {}
    return res.status(201).json(created)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'update status failed' })
  }
})

// Property revenue aggregated by fixed expenses report_category and order income
router.get('/property-revenue', async (req, res) => {
  try {
    const { property_id, property_code, month } = (req.query || {}) as any
    if (!month || (!(property_id) && !(property_code))) return res.status(400).json({ message: 'missing month or property' })
    const excludeOrphanFixedSnapshots = String(((req.query as any)?.exclude_orphan_fixed_snapshots ?? '')).toLowerCase() === 'true' || String(((req.query as any)?.exclude_orphan_fixed_snapshots ?? '')) === '1'
    const ym = String(month)
    const y = Number(ym.slice(0,4))
    const m = Number(ym.slice(5,7))
    if (!y || !m) return res.status(400).json({ message: 'invalid month format' })
    const start = new Date(Date.UTC(y, m - 1, 1))
    const end = new Date(Date.UTC(y, m, 0))
    let pid = String(property_id || '')
    let pcode = String(property_code || '')
    let label = ''
    if (hasPg) {
      try {
        const { pgPool } = require('../dbAdapter')
        if (pgPool) {
          if (!pid && pcode) {
            const qr = await pgPool.query('SELECT id,code,address FROM properties WHERE lower(code) = lower($1) LIMIT 1', [pcode])
            if (qr.rows && qr.rows[0]) pid = qr.rows[0].id, label = qr.rows[0].code || qr.rows[0].address || ''
          } else if (pid) {
            const qr = await pgPool.query('SELECT id,code,address FROM properties WHERE id = $1 LIMIT 1', [pid])
            if (qr.rows && qr.rows[0]) label = qr.rows[0].code || qr.rows[0].address || ''
          }
        }
      } catch {}
    }
    const cols = { parking_fee: 0, electricity: 0, water: 0, gas: 0, internet: 0, consumables: 0, body_corp: 0, council: 0, other: 0, management_fee: 0 }
    let rentIncome = 0
    let warnings: string[] = []
    const orphanFixedSnapshots: Array<{ expense_id: string; fixed_expense_id: string; month_key?: string; amount: number; category?: string }> = []
    let orphanFixedSnapshotsTotal = 0
    try {
      if (hasPg) {
        const orders = await pgSelect('orders', '*', { property_id: pid })
        const ords: any[] = Array.isArray(orders) ? orders : []
        function toDate(s: any): Date | null { try { return s ? new Date(String(s)) : null } catch { return null } }
        function overlapNights(ci?: any, co?: any): number {
          const a = toDate(ci)
          const b = toDate(co)
          if (!a || !b) return 0
          const A = a > start ? a : start
          const B = b < end ? b : end
          const ms = B.getTime() - A.getTime()
          return ms > 0 ? Math.floor(ms / (24 * 3600 * 1000)) : 0
        }
        for (const o of ords) {
          const ov = overlapNights(o.checkin, o.checkout)
          const nights = Number(o.nights || 0) || 0
          const visNet = Number((o as any).visible_net_income ?? o.net_income ?? 0)
          const status = String((o as any).status || '').toLowerCase()
          const isCanceled = status.includes('cancel')
          const include = (!isCanceled) || !!(o as any).count_in_income
          if (include && ov > 0 && nights > 0) rentIncome += (visNet * ov) / nights
        }
        let peRows: any[] = []
        try {
          const { pgPool } = require('../dbAdapter')
          if (pgPool) {
            const sql = `SELECT * FROM property_expenses
              WHERE (property_id = $1 OR lower(property_id) = lower($2))
                AND (
                  month_key = $3 OR
                  date_trunc('month', COALESCE(paid_date, occurred_at)::date) = date_trunc('month', to_date($3,'YYYY-MM'))
                )`
            const rs = await pgPool.query(sql, [pid || null, pcode || null, ym])
            peRows = rs.rows || []
          }
        } catch {}
        const rp = await pgSelect('recurring_payments', '*')
        const rpRows: any[] = Array.isArray(rp) ? rp : []
        const map: Record<string, string> = Object.fromEntries(rpRows.map(r => [String(r.id), String((r as any).report_category || 'other')]))
        function toReportCat(raw?: string, detail?: string): string {
          const v = String(raw||'').toLowerCase()
          const d = String(detail||'').toLowerCase()
          const s = v + ' ' + d
          // explicit category values
          if (['carpark'].includes(v)) return 'parking_fee'
          if (['owners_corp','ownerscorp','body_corp','bodycorp'].includes(v)) return 'body_corp'
          if (['internet','nbn'].includes(v)) return 'internet'
          if (['electricity'].includes(v)) return 'electricity'
          if (['water'].includes(v)) return 'water'
          if (['gas','gas_hot_water','hot_water'].includes(v)) return 'gas'
          if (['consumables'].includes(v)) return 'consumables'
          if (['council_rate','council'].includes(v)) return 'council'
          // heuristics & Chinese labels
          if (s.includes('车位')) return 'parking_fee'
          if (s.includes('物业')) return 'body_corp'
          if (s.includes('internet') || s.includes('nbn') || s.includes('网')) return 'internet'
          if (s.includes('electric') || s.includes('电')) return 'electricity'
          if ((s.includes('water') || s.includes('水')) && !s.includes('热')) return 'water'
          if (s.includes('gas') || s.includes('热水') || s.includes('煤气')) return 'gas'
          if (s.includes('consumable') || s.includes('消耗')) return 'consumables'
          if (s.includes('council') || s.includes('市政')) return 'council'
          if (s.includes('管理费') || s.includes('management')) return 'management_fee'
          return 'other'
        }
        for (const e of peRows) {
          const fid = String((e as any).fixed_expense_id || '')
          const amt = Number((e as any).amount || 0)
          if (fid && !map[fid]) {
            const genFrom = String((e as any).generated_from || '')
            const note = String((e as any).note || '')
            const isSnapshot = genFrom === 'recurring_payments' || /^fixed payment/i.test(note)
            if (isSnapshot) {
              orphanFixedSnapshotsTotal += amt
              if (orphanFixedSnapshots.length < 20) {
                orphanFixedSnapshots.push({
                  expense_id: String((e as any).id || ''),
                  fixed_expense_id: fid,
                  month_key: String((e as any).month_key || '') || undefined,
                  amount: amt,
                  category: String((e as any).category || '') || undefined,
                })
              }
              if (excludeOrphanFixedSnapshots) continue
            }
          }
          const cat = fid ? (map[fid] || 'other') : toReportCat(String((e as any).category || ''), String((e as any).category_detail || ''))
          if (cat in cols) (cols as any)[cat] += amt
          else cols.other += amt
        }
        const missingMonthKey = peRows.filter((e: any) => !e.month_key).length
        if (missingMonthKey > 0) warnings.push(`expenses_without_month_key=${missingMonthKey}`)
        if (orphanFixedSnapshots.length > 0) warnings.push(`orphan_fixed_expense_snapshots=${orphanFixedSnapshots.length}`)
        // Auto compute management fee from landlord config
        try {
          const props = await pgSelect('properties', 'id,landlord_id', { id: pid })
          const prop = Array.isArray(props) ? props[0] : null
          let rate = 0
          if (prop?.landlord_id) {
            const lrows = await pgSelect('landlords', 'id,management_fee_rate', { id: prop.landlord_id })
            const ll = Array.isArray(lrows) ? lrows[0] : null
            rate = Number((ll as any)?.management_fee_rate || 0)
          }
          if (rate && rentIncome) {
            const fee = Number(((rentIncome * rate)).toFixed(2))
            cols.management_fee += fee
          }
        } catch {}
      }
    } catch {}
    const totalExpense = Object.entries(cols).reduce((s, [k, v]) => s + (k === 'management_fee' ? Number(v || 0) : Number(v || 0)), 0)
    const payload: any = {
      property_code: label || pcode || pid,
      month: ym,
      parking_fee: -Number(cols.parking_fee || 0),
      electricity: -Number(cols.electricity || 0),
      water: -Number(cols.water || 0),
      gas: -Number(cols.gas || 0),
      internet: -Number(cols.internet || 0),
      consumables: -Number(cols.consumables || 0),
      body_corp: -Number(cols.body_corp || 0),
      council: -Number(cols.council || 0),
      other: -Number(cols.other || 0),
      management_fee: -Number(cols.management_fee || 0),
      total_expense: -Number(totalExpense || 0),
      net_income: Number(rentIncome || 0) - Number(totalExpense || 0)
    }
    if (orphanFixedSnapshots.length) {
      payload.orphan_fixed_expense_snapshots_total = -Number(orphanFixedSnapshotsTotal || 0)
      payload.orphan_fixed_expense_snapshots_sample = orphanFixedSnapshots
      payload.exclude_orphan_fixed_snapshots = excludeOrphanFixedSnapshots
    }
    if (warnings.length) payload.warnings = warnings
    return res.json(payload)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'property-revenue failed' })
  }
})

// Auto-calc management fee for a property and month, persist into property_expenses and finance_transactions
router.post('/management-fee/calc', requireAnyPerm(['property_expenses.write','finance.tx.write']), async (req, res) => {
  try {
    const { property_id, property_code, month } = (req.body || {}) as any
    if (!month || (!(property_id) && !(property_code))) return res.status(400).json({ message: 'missing month or property' })
    if (!hasPg) return res.status(400).json({ message: 'pg required' })
    const ym = String(month)
    const y = Number(ym.slice(0,4)), m = Number(ym.slice(5,7))
    if (!y || !m) return res.status(400).json({ message: 'invalid month format' })
    const start = new Date(Date.UTC(y, m - 1, 1))
    const end = new Date(Date.UTC(y, m, 0))
    let pid = String(property_id || '')
    let pcode = String(property_code || '')
    const { pgPool } = require('../dbAdapter')
    // resolve property id by code
    if (!pid && pcode) {
      const qr = await pgPool!.query('SELECT id, landlord_id FROM properties WHERE lower(code)=lower($1) LIMIT 1', [pcode])
      pid = qr.rows?.[0]?.id || ''
    }
    if (!pid) return res.status(404).json({ message: 'property_not_found' })
    // compute rent income for target month
    const orders = await pgSelect('orders', '*', { property_id: pid })
    const ords: any[] = Array.isArray(orders) ? orders : []
    function toDate(s: any): Date | null { try { return s ? new Date(String(s)) : null } catch { return null } }
    function overlapNights(ci?: any, co?: any): number {
      const a = toDate(ci), b = toDate(co)
      if (!a || !b) return 0
      const A = a > start ? a : start
      const B = b < end ? b : end
      const ms = B.getTime() - A.getTime()
      return ms > 0 ? Math.floor(ms / (24 * 3600 * 1000)) : 0
    }
    let rentIncome = 0
    for (const o of ords) {
      const ov = overlapNights(o.checkin, o.checkout)
      const nights = Number(o.nights || 0) || 0
      const visNet = Number((o as any).visible_net_income ?? o.net_income ?? 0)
      const status = String((o as any).status || '').toLowerCase()
      const isCanceled = status.includes('cancel')
      const include = (!isCanceled) || !!(o as any).count_in_income
      if (include && ov > 0 && nights > 0) rentIncome += (visNet * ov) / nights
    }
    // read landlord rate
    const propRows = await pgSelect('properties', 'id,landlord_id,code', { id: pid })
    const prop = Array.isArray(propRows) ? propRows[0] : null
    const lid = prop?.landlord_id
    if (!lid) return res.status(400).json({ message: 'landlord_not_linked' })
    const llRows = await pgSelect('landlords', 'id,management_fee_rate', { id: lid })
    const landlord = Array.isArray(llRows) ? llRows[0] : null
    const rate = Number((landlord as any)?.management_fee_rate || 0)
    if (!rate) return res.status(400).json({ message: 'management_fee_rate_missing' })
    if (!rentIncome) return res.status(400).json({ message: 'rent_income_zero' })
    const fee = Number(((rentIncome * rate)).toFixed(2))
    // upsert property_expenses
    const { v4: uuid } = require('uuid')
    const occurred = new Date(Date.UTC(y, m - 1, 1)).toISOString().slice(0,10)
    const existing = await pgSelect('property_expenses', '*', { property_id: pid, month_key: ym, category: 'management_fee' })
    let expRow: any
    if (Array.isArray(existing) && existing[0]) {
      const id = existing[0].id
      expRow = await pgUpdate('property_expenses', id, { amount: fee, occurred_at: occurred, note: `auto management fee ${ym}` } as any)
    } else {
      expRow = await pgInsert('property_expenses', { id: uuid(), property_id: pid, amount: fee, category: 'management_fee', occurred_at: occurred, month_key: ym, note: `auto management fee ${ym}` } as any)
    }
    // write finance transaction for integration
    const tx: FinanceTransaction = { id: uuid(), kind: 'expense', amount: fee, currency: 'AUD', occurred_at: new Date().toISOString(), ref_type: 'property_expense', ref_id: expRow?.id || (existing?.[0]?.id || null), property_id: pid, category: 'management_fee', note: `management fee ${prop?.code || pid} ${ym}` }
    await pgInsert('finance_transactions', tx as any)
    addAudit('FinanceTransaction', tx.id, 'create', null, tx)
    // return with double-check snapshot
    const recorded = await pgSelect('property_expenses', '*', { property_id: pid, month_key: ym, category: 'management_fee' })
    const diff = Math.abs(Number((recorded?.[0]?.amount || 0)) - fee)
    return res.status(201).json({ property_id: pid, month: ym, rent_income: Number(rentIncome.toFixed(2)), rate, fee, recorded_fee: Number((recorded?.[0]?.amount || 0)), diff })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'calc_failed' })
  }
})

router.get('/management-fee/history', requireAnyPerm(['property_expenses.view','finance.tx.write']), async (req, res) => {
  try {
    if (!hasPg) return res.status(400).json({ message: 'pg required' })
    const { property_id, month_from, month_to } = (req.query || {}) as any
    const conds: any[] = []
    const where: string[] = ["category = 'management_fee'"]
    if (property_id) { where.push('property_id = $1'); conds.push(property_id) }
    if (month_from && month_to) { where.push('month_key BETWEEN $2 AND $3'); conds.push(month_from, month_to) }
    const { pgPool } = require('../dbAdapter')
    const rs = await pgPool!.query(`SELECT * FROM property_expenses WHERE ${where.join(' AND ')} ORDER BY month_key DESC`, conds)
    return res.json(rs.rows || [])
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'history_failed' })
  }
})

// Validation endpoint: compare raw expenses aggregation for a property and month
router.get('/property-revenue/validate', async (req, res) => {
  try {
    const { property_id, property_code, month } = (req.query || {}) as any
    if (!month || (!(property_id) && !(property_code))) return res.status(400).json({ message: 'missing month or property' })
    const ym = String(month)
    let pid = String(property_id || '')
    let pcode = String(property_code || '')
    if (hasPg) {
      try {
        const { pgPool } = require('../dbAdapter')
        if (pgPool) {
          if (!pid && pcode) {
            const qr = await pgPool.query('SELECT id,code FROM properties WHERE lower(code) = lower($1) LIMIT 1', [pcode])
            if (qr.rows && qr.rows[0]) pid = qr.rows[0].id
          }
        }
      } catch {}
    }
    const totals: Record<string, number> = { parking_fee: 0, electricity: 0, water: 0, gas: 0, internet: 0, consumables: 0, body_corp: 0, council: 0, other: 0 }
    if (hasPg) {
      try {
        const { pgPool } = require('../dbAdapter')
        if (pgPool) {
          const sql = `SELECT * FROM property_expenses
            WHERE (property_id = $1 OR lower(property_id) = lower($2))
              AND (
                month_key = $3 OR
                date_trunc('month', COALESCE(paid_date, occurred_at)::date) = date_trunc('month', to_date($3,'YYYY-MM'))
              )`
          const rs = await pgPool.query(sql, [pid || null, pcode || null, ym])
          const rows = rs.rows || []
          for (const e of rows) {
            const fid = String((e as any).fixed_expense_id || '')
            const amt = Number((e as any).amount || 0)
            let cat = 'other'
            if (fid) {
              try {
                const rp = await pgSelect('recurring_payments', '*', { id: fid })
                const r = Array.isArray(rp) ? rp[0] : null
                cat = String((r as any)?.report_category || 'other')
              } catch {}
            } else {
              cat = toReportCat(String((e as any).category || ''), String((e as any).category_detail || ''))
            }
            if (totals[cat] === undefined) totals[cat] = 0
            totals[cat] += amt
          }
        }
      } catch (e: any) {
        return res.status(500).json({ message: e?.message || 'validate failed' })
      }
    }
    return res.json({ property_id: pid, property_code: pcode, month: ym, totals })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'validate failed' })
  }
})

router.get('/payouts', async (_req, res) => {
  try {
    
    if (hasPg) {
      const raw = await pgSelect('payouts')
      const rows: any[] = Array.isArray(raw) ? raw : []
      return res.json(rows)
    }
    return res.json(db.payouts)
  } catch {
    return res.json(db.payouts)
  }
})

// Company payouts
router.get('/company-payouts', async (_req, res) => {
  try {
    if (hasPg) {
      const raw = await pgSelect('company_payouts')
      const rows: any[] = Array.isArray(raw) ? raw : []
      return res.json(rows)
    }
    return res.json(db.companyPayouts)
  } catch {
    return res.json(db.companyPayouts)
  }
})

const companyPayoutSchema = z.object({ period_from: z.string(), period_to: z.string(), amount: z.number().min(0), invoice_no: z.string().optional(), note: z.string().optional() })
router.post('/company-payouts', requirePerm('finance.payout'), async (req, res) => {
  const parsed = companyPayoutSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const { v4: uuid } = require('uuid')
  const p: CompanyPayout = { id: uuid(), status: 'pending', ...parsed.data }
  db.companyPayouts.push(p)
  addAudit('CompanyPayout', p.id, 'create', null, p)
  const tx: FinanceTransaction = { id: uuid(), kind: 'expense', amount: p.amount, currency: 'AUD', occurred_at: new Date().toISOString(), ref_type: 'company_payout', ref_id: p.id, note: p.note || 'company payout', invoice_url: undefined }
  db.financeTransactions.push(tx)
  addAudit('FinanceTransaction', tx.id, 'create', null, tx)
  if (hasPg) {
    try {
      await pgInsert('company_payouts', p as any)
      await pgInsert('finance_transactions', tx as any)
      return res.status(201).json(p)
    } catch (e: any) { return res.status(500).json({ message: e?.message || 'pg insert failed' }) }
  }
  return res.status(201).json(p)
})

router.patch('/company-payouts/:id', requirePerm('finance.payout'), async (req, res) => {
  const { id } = req.params
  const idx = db.companyPayouts.findIndex(x => x.id === id)
  const prev = idx !== -1 ? db.companyPayouts[idx] : undefined
  if (!prev && !hasPg) return res.status(404).json({ message: 'not found' })
  const body = req.body as Partial<CompanyPayout>
  const updated: CompanyPayout = { ...(prev || ({} as any)), ...body, id }
  if (idx !== -1) db.companyPayouts[idx] = updated
  addAudit('CompanyPayout', id, 'update', prev, updated)
  // sync linked transaction amount/note if provided
  const linkedIdx = db.financeTransactions.findIndex(t => t.ref_type === 'company_payout' && t.ref_id === id)
  if (linkedIdx !== -1) {
    if (body.amount != null) db.financeTransactions[linkedIdx].amount = Number(body.amount)
    if (body.note != null) db.financeTransactions[linkedIdx].note = body.note
  }
  if (hasPg) {
    try { const row = await pgUpdate('company_payouts', id, updated as any); return res.json(row || updated) } catch {
      try { const row2 = await pgInsert('company_payouts', updated as any); return res.json(row2 || updated) } catch {}
    }
  }
  return res.json(updated)
})

router.delete('/company-payouts/:id', requirePerm('finance.payout'), async (req, res) => {
  const { id } = req.params
  const idx = db.companyPayouts.findIndex(x => x.id === id)
  if (idx !== -1) db.companyPayouts.splice(idx, 1)
  db.financeTransactions = db.financeTransactions.filter(t => !(t.ref_type === 'company_payout' && t.ref_id === id))
  if (hasPg) {
    try {
      await pgDelete('company_payouts', id)
      const linked = await pgSelect('finance_transactions', '*', { ref_type: 'company_payout', ref_id: id })
      for (const r of (linked || []) as any[]) { if (r?.id) await pgDelete('finance_transactions', r.id) }
      return res.json({ ok: true })
    } catch {}
  }
  return res.json({ ok: true })
})

const payoutSchema = z.object({ landlord_id: z.string(), period_from: z.string(), period_to: z.string(), amount: z.number().min(0), invoice_no: z.string().optional() })
router.post('/payouts', requirePerm('finance.payout'), async (req, res) => {
  const parsed = payoutSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const { v4: uuid } = require('uuid')
  const p: Payout = { id: uuid(), status: 'pending', ...parsed.data }
  db.payouts.push(p)
  addAudit('Payout', p.id, 'create', null, p)
  const tx: FinanceTransaction = { id: uuid(), kind: 'expense', amount: p.amount, currency: 'AUD', occurred_at: new Date().toISOString(), ref_type: 'payout', ref_id: p.id, note: `landlord payout ${p.landlord_id}` }
  db.financeTransactions.push(tx)
  addAudit('FinanceTransaction', tx.id, 'create', null, tx)
  // Supabase branch removed
  if (hasPg) {
    try {
      await pgInsert('payouts', p as any)
      await pgInsert('finance_transactions', tx as any)
      return res.status(201).json(p)
    } catch (e: any) { return res.status(500).json({ message: e?.message || 'pg insert failed' }) }
  }
  return res.status(201).json(p)
})

router.patch('/payouts/:id', requirePerm('finance.payout'), async (req, res) => {
  const p = db.payouts.find(x => x.id === req.params.id)
  if (!p) return res.status(404).json({ message: 'not found' })
  const before = { ...p }
  Object.assign(p, req.body as Partial<Payout>)
  addAudit('Payout', p.id, 'update', before, p)
  if (hasPg) {
    try { const row = await pgUpdate('payouts', p.id, p as any); return res.json(row || p) } catch {}
  }
  return res.json(p)
})

router.get('/payouts/:id', async (req, res) => {
  const { id } = req.params
  try {
    if (hasPg) {
      const rows = await pgSelect('payouts', '*', { id })
      if (rows && rows[0]) return res.json(rows[0])
    }
  } catch {}
  const local = db.payouts.find(x => x.id === id)
  if (!local) return res.status(404).json({ message: 'not found' })
  return res.json(local)
})

router.delete('/payouts/:id', requirePerm('finance.payout'), async (req, res) => {
  const { id } = req.params
  const idx = db.payouts.findIndex(x => x.id === id)
  if (idx !== -1) db.payouts.splice(idx, 1)
  db.financeTransactions = db.financeTransactions.filter(t => !(t.ref_type === 'payout' && t.ref_id === id))
  if (hasPg) {
    try {
      await pgDelete('payouts', id)
      const linked = await pgSelect('finance_transactions', '*', { ref_type: 'payout', ref_id: id })
      for (const r of (linked || []) as any[]) { if (r?.id) await pgDelete('finance_transactions', r.id) }
      return res.json({ ok: true })
    } catch {}
  }
  return res.json({ ok: true })
})

router.patch('/:id', requirePerm('finance.tx.write'), async (req, res) => {
  const { id } = req.params
  const parsed = txSchema.partial().safeParse(req.body)
  if (!parsed.success) {
    const msg = parsed.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; ')
    return res.status(400).json({ message: msg || 'invalid payload' })
  }
  const idx = db.financeTransactions.findIndex(x => x.id === id)
  const prev = idx !== -1 ? db.financeTransactions[idx] : undefined
  const updated: FinanceTransaction = { ...(prev || ({} as any)), ...(parsed.data as any), id }
  if (idx !== -1) db.financeTransactions[idx] = updated
  else db.financeTransactions.push(updated)
  if (hasPg) {
    try { const row = await pgUpdate('finance_transactions', id, updated as any); return res.json(row || updated) } catch {
      try { await pgInsert('finance_transactions', updated as any); return res.json(updated) } catch {}
    }
  }
  return res.json(updated)
})

router.delete('/:id', requirePerm('finance.tx.write'), async (req, res) => {
  const { id } = req.params
  const idx = db.financeTransactions.findIndex(x => x.id === id)
  if (idx !== -1) db.financeTransactions.splice(idx, 1)
  if (hasPg) {
    try { await pgDelete('finance_transactions', id); return res.json({ ok: true }) } catch {}
  }
  return res.json({ ok: true })
})
// Deduplicate property_expenses by (property_id, month_key, category, amount)
router.post('/dedup-property-expenses', requireAnyPerm(['property_expenses.write','finance.tx.write']), async (_req, res) => {
  try {
    if (!hasPg) return res.status(400).json({ message: 'pg required' })
    const { pgPool } = require('../dbAdapter')
    if (!pgPool) return res.status(500).json({ message: 'pg pool unavailable' })
    const dupSql = `
      SELECT property_id, month_key, category, amount, array_agg(id ORDER BY coalesce(updated_at, created_at, now()) DESC) AS ids
      FROM property_expenses
      WHERE month_key IS NOT NULL
      GROUP BY property_id, month_key, category, amount
      HAVING COUNT(*) > 1
    `
    const qr = await pgPool.query(dupSql)
    const groups = qr.rows || []
    let merged = 0, removed = 0, marked = 0
    for (const g of groups) {
      const ids: string[] = g.ids || []
      if (!ids.length) continue
      const keep = ids[0]
      const drop = ids.slice(1)
      if (drop.length) {
        await pgPool.query('DELETE FROM property_expenses WHERE id = ANY($1::text[])', [drop])
        removed += drop.length
      }
      merged++
    }
    return res.json({ merged_groups: merged, removed_records: removed, marked_conflicts: marked })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'dedup failed' })
  }
})

router.post('/expenses/validate-duplicate', requireAnyPerm(['property_expenses.write','finance.tx.write']), async (req, res) => {
  try {
    const body = req.body || {}
    const mode = String(body.mode || 'exact') === 'fuzzy' ? 'fuzzy' : 'exact'
    const fp = buildExpenseFingerprint(body, mode as any)
    const started = Date.now()
    const result: any = { verification_id: fp, is_duplicate: false, reasons: [], similar: [] }
    if (await hasFingerprint(fp)) { result.is_duplicate = true; result.reasons.push('fingerprint_recent'); }
    if (hasPg) {
      const occ = String(body.paid_date || body.occurred_at || '')
      const whereExact = { property_id: body.property_id, month_key: (occ ? occ.slice(0,7) : body.month_key), category: body.category, amount: Number(body.amount||0) }
      const ex = await pgSelect('property_expenses', '*', whereExact)
      if (Array.isArray(ex) && ex[0]) { result.is_duplicate = true; result.reasons.push('unique_match'); result.similar.push(ex[0]) }
      try {
        const { pgPool } = require('../dbAdapter')
        const sql = `SELECT * FROM property_expenses WHERE property_id=$1 AND category=$2 AND abs(amount - $3) <= 1 AND occurred_at BETWEEN (to_date($4,'YYYY-MM-DD') - interval '1 day') AND (to_date($4,'YYYY-MM-DD') + interval '1 day') LIMIT 10`
        const rs = await pgPool!.query(sql, [body.property_id, body.category, Number(body.amount||0), occ.slice(0,10)])
        if (rs.rowCount) { result.is_duplicate = true; result.reasons.push('fuzzy_window'); result.similar.push(...rs.rows) }
      } catch {}
    }
    await addDedupLog({ resource: 'property_expenses', fingerprint: fp, mode: mode as any, result: result.is_duplicate ? 'hit' : 'miss', operator_id: (req as any).user?.sub || null, reasons: result.reasons, latency_ms: Date.now() - started })
    return res.json(result)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'validate_failed' })
  }
})

router.post('/expenses/scan-duplicates', requireAnyPerm(['property_expenses.write','finance.tx.write']), async (_req, res) => {
  try {
    if (!hasPg) return res.status(400).json({ message: 'pg required' })
    const { pgPool } = require('../dbAdapter')
    const sql = `SELECT property_id, month_key, category, amount, COUNT(*) AS cnt FROM property_expenses WHERE month_key IS NOT NULL GROUP BY property_id, month_key, category, amount HAVING COUNT(*) > 1 ORDER BY cnt DESC LIMIT 100`
    const rs = await pgPool!.query(sql)
    const groups = rs.rows || []
    return res.json({ groups })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'scan_failed' })
  }
})

router.get('/duplicates/metrics', requireAnyPerm(['property_expenses.view','finance.tx.write']), async (_req, res) => {
  try {
    if (!hasPg) return res.json({ duplicate_rate_24h: 0, hits_24h: 0, validations_24h: 0 })
    const { pgPool } = require('../dbAdapter')
    const rs = await pgPool!.query(`SELECT count(*) FILTER (WHERE result='hit') AS hits, count(*) AS total FROM expense_dedup_logs WHERE created_at > now() - interval '24 hours'`)
    const hits = Number(rs.rows?.[0]?.hits || 0)
    const total = Number(rs.rows?.[0]?.total || 0)
    const rate = total ? Number(((hits / total) * 100).toFixed(2)) : 0
    return res.json({ duplicate_rate_24h: rate, hits_24h: hits, validations_24h: total })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'metrics_failed' })
  }
})
