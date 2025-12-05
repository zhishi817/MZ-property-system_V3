import { Router } from 'express'
import { db, FinanceTransaction, Payout, CompanyPayout, addAudit } from '../store'
import { hasSupabase, supaSelect, supaInsert, supaUpdate, supaDelete } from '../supabase'
import { hasPg, pgSelect, pgInsert, pgUpdate, pgDelete } from '../dbAdapter'
import multer from 'multer'
import path from 'path'
import { hasR2, r2Upload } from '../r2'
import { z } from 'zod'
import { requirePerm } from '../auth'
import { PDFDocument } from 'pdf-lib'

export const router = Router()
const upload = hasR2 ? multer({ storage: multer.memoryStorage() }) : multer({ dest: path.join(process.cwd(), 'uploads') })

router.get('/', async (_req, res) => {
  try {
    if (hasSupabase) {
      const raw = await supaSelect('finance_transactions')
      const rows: any[] = Array.isArray(raw) ? raw : []
      return res.json(rows)
    }
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
  if (hasSupabase) {
    try { const row = await supaInsert('finance_transactions', tx); return res.status(201).json(row || tx) } catch (e: any) { return res.status(500).json({ message: e?.message || 'supabase insert failed' }) }
  }
  if (hasPg) {
    try { const row = await pgInsert('finance_transactions', tx as any); return res.status(201).json(row || tx) } catch (e: any) { return res.status(500).json({ message: e?.message || 'pg insert failed' }) }
  }
  return res.status(201).json(tx)
})

router.post('/invoices', requirePerm('finance.tx.write'), upload.single('file'), async (req, res) => {
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

// Merge monthly statement PDF with multiple invoice PDFs and return a single PDF
router.post('/merge-pdf', requirePerm('finance.payout'), async (req, res) => {
  try {
    const { statement_pdf_base64, statement_pdf_url, invoice_urls } = req.body || {}
    if (!statement_pdf_base64 && !statement_pdf_url) return res.status(400).json({ message: 'missing statement pdf' })
    const urls: string[] = Array.isArray(invoice_urls) ? invoice_urls.filter((u: any) => typeof u === 'string') : []
    async function fetchBytes(u: string): Promise<Uint8Array> {
      const r = await fetch(u)
      if (!r.ok) throw new Error(`fetch failed: ${r.status}`)
      const ab = await r.arrayBuffer()
      return new Uint8Array(ab)
    }
    let merged = await PDFDocument.create()
    // append statement
    if (statement_pdf_base64 && typeof statement_pdf_base64 === 'string') {
      const b64 = statement_pdf_base64.replace(/^data:application\/pdf;base64,/, '')
      const bytes = Uint8Array.from(Buffer.from(b64, 'base64'))
      const src = await PDFDocument.load(bytes)
      const copied = await merged.copyPages(src, src.getPageIndices())
      copied.forEach(p => merged.addPage(p))
    } else if (statement_pdf_url && typeof statement_pdf_url === 'string') {
      const bytes = await fetchBytes(statement_pdf_url)
      const src = await PDFDocument.load(bytes)
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
})

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

router.get('/payouts', async (_req, res) => {
  try {
    if (hasSupabase) {
      const raw = await supaSelect('payouts')
      const rows: any[] = Array.isArray(raw) ? raw : []
      return res.json(rows)
    }
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
    } else if (hasSupabase) {
      const raw = await supaSelect('company_payouts')
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
  } else if (hasSupabase) {
    try {
      await supaInsert('company_payouts', p)
      await supaInsert('finance_transactions', tx)
      return res.status(201).json(p)
    } catch (e: any) { return res.status(500).json({ message: e?.message || 'supabase insert failed' }) }
  }
  return res.status(201).json(p)
})

router.patch('/company-payouts/:id', requirePerm('finance.payout'), async (req, res) => {
  const { id } = req.params
  const idx = db.companyPayouts.findIndex(x => x.id === id)
  const prev = idx !== -1 ? db.companyPayouts[idx] : undefined
  if (!prev && !hasPg && !hasSupabase) return res.status(404).json({ message: 'not found' })
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
  } else if (hasSupabase) {
    try { const row = await supaUpdate('company_payouts', id, updated); return res.json(row || updated) } catch {
      try { const { supaUpsert } = require('../supabase'); const row2 = await supaUpsert('company_payouts', updated); return res.json(row2 || updated) } catch {}
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
  } else if (hasSupabase) {
    try {
      await supaDelete('company_payouts', id)
      const linked = await supaSelect('finance_transactions', '*', { ref_type: 'company_payout', ref_id: id })
      for (const r of (linked || []) as any[]) { if (r?.id) await supaDelete('finance_transactions', r.id) }
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
  if (hasSupabase) {
    try {
      await supaInsert('payouts', p)
      await supaInsert('finance_transactions', tx)
      return res.status(201).json(p)
    } catch (e: any) { return res.status(500).json({ message: e?.message || 'supabase insert failed' }) }
  }
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
  if (hasSupabase) {
    try { const row = await supaUpdate('payouts', p.id, p); return res.json(row || p) } catch {}
  } else if (hasPg) {
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
    } else if (hasSupabase) {
      const rows = await supaSelect('payouts', '*', { id })
      if (rows && (rows as any[])[0]) return res.json((rows as any[])[0])
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
  if (hasSupabase) {
    try {
      await supaDelete('payouts', id)
      const linked = await supaSelect('finance_transactions', '*', { ref_type: 'payout', ref_id: id })
      for (const r of (linked || []) as any[]) { if (r?.id) await supaDelete('finance_transactions', r.id) }
      return res.json({ ok: true })
    } catch {}
  } else if (hasPg) {
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
  if (hasSupabase) {
    try { const row = await supaUpdate('finance_transactions', id, updated); return res.json(row || updated) } catch {
      try { const { supaUpsert } = require('../supabase'); const row2 = await supaUpsert('finance_transactions', updated); return res.json(row2 || updated) } catch {}
    }
  } else if (hasPg) {
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
  if (hasSupabase) {
    try { await supaDelete('finance_transactions', id); return res.json({ ok: true }) } catch {}
  } else if (hasPg) {
    try { await pgDelete('finance_transactions', id); return res.json({ ok: true }) } catch {}
  }
  return res.json({ ok: true })
})
