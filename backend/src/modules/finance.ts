import { Router } from 'express'
import { db, FinanceTransaction, Payout, addAudit } from '../store'
import { z } from 'zod'
import { requirePerm } from '../auth'

export const router = Router()

router.get('/', (req, res) => {
  res.json(db.financeTransactions)
})

const txSchema = z.object({ kind: z.enum(['income','expense']), amount: z.number().min(0), currency: z.string(), ref_type: z.string().optional(), ref_id: z.string().optional(), occurred_at: z.string().optional(), note: z.string().optional() })
router.post('/', requirePerm('finance.payout'), (req, res) => {
  const parsed = txSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const { v4: uuid } = require('uuid')
  const tx: FinanceTransaction = { id: uuid(), occurred_at: parsed.data.occurred_at || new Date().toISOString(), ...parsed.data }
  db.financeTransactions.push(tx)
  addAudit('FinanceTransaction', tx.id, 'create', null, tx)
  res.status(201).json(tx)
})

router.get('/payouts', (req, res) => {
  res.json(db.payouts)
})

const payoutSchema = z.object({ landlord_id: z.string(), period_from: z.string(), period_to: z.string(), amount: z.number().min(0), invoice_no: z.string().optional() })
router.post('/payouts', requirePerm('finance.payout'), (req, res) => {
  const parsed = payoutSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const { v4: uuid } = require('uuid')
  const p: Payout = { id: uuid(), status: 'pending', ...parsed.data }
  db.payouts.push(p)
  addAudit('Payout', p.id, 'create', null, p)
  res.status(201).json(p)
})

router.patch('/payouts/:id', requirePerm('finance.payout'), (req, res) => {
  const p = db.payouts.find(x => x.id === req.params.id)
  if (!p) return res.status(404).json({ message: 'not found' })
  const before = { ...p }
  Object.assign(p, req.body as Partial<Payout>)
  addAudit('Payout', p.id, 'update', before, p)
  res.json(p)
})