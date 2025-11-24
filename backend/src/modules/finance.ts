import { Router } from 'express'
import { db, FinanceTransaction, Payout, addAudit } from '../store'
import { hasSupabase, supaSelect, supaInsert, supaUpdate, supaDelete } from '../supabase'
import { hasPg, pgSelect, pgInsert, pgUpdate, pgDelete } from '../dbAdapter'
import multer from 'multer'
import path from 'path'
import { z } from 'zod'
import { requirePerm } from '../auth'

export const router = Router()
const upload = multer({ dest: path.join(process.cwd(), 'uploads') })

router.get('/', async (_req, res) => {
  try {
    if (hasPg) {
      const rows = (await pgSelect('finance_transactions')) as any[] || []
      return res.json(rows)
    }
    if (hasSupabase) {
      const rows = (await supaSelect('finance_transactions')) as any[] || []
      return res.json(rows)
    }
    return res.json(db.financeTransactions)
  } catch {
    return res.json(db.financeTransactions)
  }
})

const txSchema = z.object({ kind: z.enum(['income','expense']), amount: z.number().min(0), currency: z.string(), ref_type: z.string().optional(), ref_id: z.string().optional(), occurred_at: z.string().optional(), note: z.string().optional(), category: z.string().optional(), property_id: z.string().optional(), invoice_url: z.string().optional(), category_detail: z.string().optional() })
router.post('/', requirePerm('finance.payout'), async (req, res) => {
  const parsed = txSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const { v4: uuid } = require('uuid')
  const tx: FinanceTransaction = { id: uuid(), occurred_at: parsed.data.occurred_at || new Date().toISOString(), ...parsed.data }
  db.financeTransactions.push(tx)
  addAudit('FinanceTransaction', tx.id, 'create', null, tx)
  if (hasPg) {
    try { const row = await pgInsert('finance_transactions', tx as any); return res.status(201).json(row || tx) } catch { return res.status(201).json(tx) }
  }
  if (hasSupabase) {
    try { const row = await supaInsert('finance_transactions', tx); return res.status(201).json(row || tx) } catch { return res.status(201).json(tx) }
  }
  return res.status(201).json(tx)
})

router.post('/invoices', requirePerm('finance.payout'), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'missing file' })
  const url = `/uploads/${req.file.filename}`
  res.status(201).json({ url })
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
    if (hasPg) {
      const rows = (await pgSelect('payouts')) as any[] || []
      return res.json(rows)
    }
    if (hasSupabase) {
      const rows = (await supaSelect('payouts')) as any[] || []
      return res.json(rows)
    }
    return res.json(db.payouts)
  } catch {
    return res.json(db.payouts)
  }
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
  if (hasPg) {
    try {
      await pgInsert('payouts', p as any)
      await pgInsert('finance_transactions', tx as any)
      return res.status(201).json(p)
    } catch { return res.status(201).json(p) }
  }
  if (hasSupabase) {
    try {
      await supaInsert('payouts', p)
      await supaInsert('finance_transactions', tx)
      return res.status(201).json(p)
    } catch { return res.status(201).json(p) }
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
  } else if (hasSupabase) {
    try { const row = await supaUpdate('payouts', p.id, p); return res.json(row || p) } catch {}
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
  if (hasPg) {
    try {
      await pgDelete('payouts', id)
      const linked = await pgSelect('finance_transactions', '*', { ref_type: 'payout', ref_id: id })
      for (const r of (linked || []) as any[]) { if (r?.id) await pgDelete('finance_transactions', r.id) }
      return res.json({ ok: true })
    } catch {}
  } else if (hasSupabase) {
    try {
      await supaDelete('payouts', id)
      const linked = await supaSelect('finance_transactions', '*', { ref_type: 'payout', ref_id: id })
      for (const r of (linked || []) as any[]) { if (r?.id) await supaDelete('finance_transactions', r.id) }
      return res.json({ ok: true })
    } catch {}
  }
  return res.json({ ok: true })
})

router.patch('/:id', requirePerm('finance.payout'), async (req, res) => {
  const { id } = req.params
  const parsed = txSchema.partial().safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const idx = db.financeTransactions.findIndex(x => x.id === id)
  const prev = idx !== -1 ? db.financeTransactions[idx] : undefined
  const updated: FinanceTransaction = { ...(prev || ({} as any)), ...(parsed.data as any), id }
  if (idx !== -1) db.financeTransactions[idx] = updated
  else db.financeTransactions.push(updated)
  if (hasPg) {
    try { const row = await pgUpdate('finance_transactions', id, updated as any); return res.json(row || updated) } catch {
      try { await pgInsert('finance_transactions', updated as any); return res.json(updated) } catch {}
    }
  } else if (hasSupabase) {
    try { const row = await supaUpdate('finance_transactions', id, updated); return res.json(row || updated) } catch {
      try { const { supaUpsert } = require('../supabase'); const row2 = await supaUpsert('finance_transactions', updated); return res.json(row2 || updated) } catch {}
    }
  }
  return res.json(updated)
})

router.delete('/:id', requirePerm('finance.payout'), async (req, res) => {
  const { id } = req.params
  const idx = db.financeTransactions.findIndex(x => x.id === id)
  if (idx !== -1) db.financeTransactions.splice(idx, 1)
  if (hasPg) {
    try { await pgDelete('finance_transactions', id); return res.json({ ok: true }) } catch {}
  } else if (hasSupabase) {
    try { await supaDelete('finance_transactions', id); return res.json({ ok: true }) } catch {}
  }
  return res.json({ ok: true })
})
