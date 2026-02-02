import { Router } from 'express'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import { z } from 'zod'
import { PDFDocument } from 'pdf-lib'
import { requireAnyPerm, requirePerm } from '../auth'
import { hasPg, pgInsert, pgPool, pgRunInTransaction, pgSelect, pgUpdate } from '../dbAdapter'
import { hasR2, r2Upload } from '../r2'
import { addAudit } from '../store'
import { v4 as uuid } from 'uuid'
 
export const router = Router()
 
const memUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } })
 
let invoiceSchemaReady: Promise<void> | null = null
async function ensureInvoiceTables() {
  if (!hasPg || !pgPool) return
  if (invoiceSchemaReady) return invoiceSchemaReady
  invoiceSchemaReady = (async () => {
  await pgPool.query(`CREATE TABLE IF NOT EXISTS invoice_companies (
    id text PRIMARY KEY,
    code text,
    legal_name text NOT NULL,
    trading_name text,
    abn text NOT NULL,
    address_line1 text,
    address_line2 text,
    address_city text,
    address_state text,
    address_postcode text,
    address_country text,
    phone text,
    email text,
    logo_url text,
    bank_account_name text,
    bank_bsb text,
    bank_account_no text,
    payment_note text,
    is_default boolean DEFAULT false,
    status text DEFAULT 'active',
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz
  );`)
  await pgPool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_companies_abn ON invoice_companies(abn);')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_invoice_companies_status ON invoice_companies(status);')
 
  await pgPool.query(`CREATE TABLE IF NOT EXISTS invoices (
    id text PRIMARY KEY,
    company_id text REFERENCES invoice_companies(id) ON DELETE RESTRICT,
    invoice_no text,
    issue_date date,
    due_date date,
    currency text DEFAULT 'AUD',
    status text DEFAULT 'draft',
    bill_to_name text,
    bill_to_email text,
    bill_to_address text,
    subtotal numeric,
    tax_total numeric,
    total numeric,
    amount_paid numeric DEFAULT 0,
    amount_due numeric,
    primary_source_type text,
    primary_source_id text,
    notes text,
    terms text,
    issued_at timestamptz,
    sent_at timestamptz,
    paid_at timestamptz,
    voided_at timestamptz,
    refunded_at timestamptz,
    void_reason text,
    refund_reason text,
    created_by text,
    updated_by text,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz
  );`)
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_invoices_company ON invoices(company_id);')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_invoices_issue_date ON invoices(issue_date);')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_invoices_invoice_no ON invoices(invoice_no);')
  await pgPool.query("CREATE UNIQUE INDEX IF NOT EXISTS uniq_invoices_company_invoice_no ON invoices(company_id, invoice_no) WHERE invoice_no IS NOT NULL;")
 
  await pgPool.query(`CREATE TABLE IF NOT EXISTS invoice_sources (
    invoice_id text REFERENCES invoices(id) ON DELETE CASCADE,
    source_type text NOT NULL,
    source_id text NOT NULL,
    label text,
    created_at timestamptz DEFAULT now(),
    PRIMARY KEY (invoice_id, source_type, source_id)
  );`)
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_invoice_sources_type_id ON invoice_sources(source_type, source_id);')
 
  await pgPool.query(`CREATE TABLE IF NOT EXISTS invoice_line_items (
    id text PRIMARY KEY,
    invoice_id text REFERENCES invoices(id) ON DELETE CASCADE,
    description text NOT NULL,
    quantity numeric NOT NULL,
    unit_price numeric NOT NULL,
    gst_type text NOT NULL,
    tax_amount numeric NOT NULL,
    line_subtotal numeric NOT NULL,
    line_total numeric NOT NULL,
    sort_order integer DEFAULT 0
  );`)
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_invoice_line_items_invoice ON invoice_line_items(invoice_id);')
 
  await pgPool.query(`CREATE TABLE IF NOT EXISTS invoice_files (
    id text PRIMARY KEY,
    invoice_id text REFERENCES invoices(id) ON DELETE CASCADE,
    kind text DEFAULT 'pdf',
    url text NOT NULL,
    file_name text,
    mime_type text,
    file_size integer,
    sha256 text,
    created_by text,
    created_at timestamptz DEFAULT now()
  );`)
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_invoice_files_invoice ON invoice_files(invoice_id);')
 
  await pgPool.query(`CREATE TABLE IF NOT EXISTS invoice_send_logs (
    id text PRIMARY KEY,
    invoice_id text REFERENCES invoices(id) ON DELETE CASCADE,
    channel text DEFAULT 'manual',
    to_email text,
    cc_email text,
    subject text,
    body text,
    status text DEFAULT 'sent',
    error text,
    created_by text,
    created_at timestamptz DEFAULT now()
  );`)
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_invoice_send_logs_invoice ON invoice_send_logs(invoice_id, created_at);')
 
  await pgPool.query(`CREATE TABLE IF NOT EXISTS number_sequences (
    id text PRIMARY KEY,
    company_id text REFERENCES invoice_companies(id) ON DELETE CASCADE,
    year integer NOT NULL,
    next_value integer NOT NULL,
    padding integer DEFAULT 6,
    format text DEFAULT '{prefix}-{year}-{seq}',
    updated_at timestamptz,
    UNIQUE(company_id, year)
  );`)
  })()
  return invoiceSchemaReady
}
 
void ensureInvoiceTables().catch(() => {})
 
function nowIso() {
  return new Date().toISOString()
}
 
function toDateOnly(d: any): string | null {
  if (!d) return null
  const s = String(d)
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  const dt = new Date(s)
  if (Number.isNaN(dt.getTime())) return null
  return dt.toISOString().slice(0, 10)
}
 
function round2(n: any) {
  const x = Number(n || 0)
  return Math.round(x * 100) / 100
}
 
type GstType = 'GST_10' | 'GST_FREE' | 'INPUT_TAXED'
 
function computeLine(item: { quantity: number; unit_price: number; gst_type: GstType }) {
  const qty = Number(item.quantity || 0)
  const unit = Number(item.unit_price || 0)
  const lineSubtotal = round2(qty * unit)
  let tax = 0
  if (item.gst_type === 'GST_10') tax = round2(lineSubtotal * 0.1)
  const lineTotal = round2(lineSubtotal + tax)
  return { line_subtotal: lineSubtotal, tax_amount: tax, line_total: lineTotal }
}
 
function computeTotals(lines: Array<{ line_subtotal: number; tax_amount: number; line_total: number }>, amountPaid: any) {
  const subtotal = round2(lines.reduce((s, x) => s + Number(x.line_subtotal || 0), 0))
  const taxTotal = round2(lines.reduce((s, x) => s + Number(x.tax_amount || 0), 0))
  const total = round2(lines.reduce((s, x) => s + Number(x.line_total || 0), 0))
  const paid = round2(amountPaid)
  const due = round2(total - paid)
  return { subtotal, tax_total: taxTotal, total, amount_paid: paid, amount_due: due }
}
 
async function nextInvoiceNo(companyId: string, year: number, client: any) {
  const comp = await pgSelect('invoice_companies', '*', { id: companyId }, client)
  const company = Array.isArray(comp) ? comp[0] : null
  if (!company) throw new Error('company_not_found')
  const prefix = String(company.code || '').trim() || 'INV'
  const row = await client.query('SELECT * FROM number_sequences WHERE company_id=$1 AND year=$2 FOR UPDATE', [companyId, year])
  let seq = row?.rows?.[0]
  if (!seq) {
    const ins = await client.query(
      'INSERT INTO number_sequences (id, company_id, year, next_value, padding, format, updated_at) VALUES ($1,$2,$3,$4,$5,$6, now()) RETURNING *',
      [uuid(), companyId, year, 1, 6, '{prefix}-{year}-{seq}']
    )
    seq = ins?.rows?.[0]
  }
  const nextValue = Number(seq?.next_value || 1)
  const padding = Math.min(12, Math.max(3, Number(seq?.padding || 6)))
  const num = String(nextValue).padStart(padding, '0')
  const invoiceNo = `${prefix}-${year}-${num}`
  await client.query('UPDATE number_sequences SET next_value=$1, updated_at=now() WHERE company_id=$2 AND year=$3', [nextValue + 1, companyId, year])
  return invoiceNo
}
 
const CompanySchema = z.object({
  code: z.string().trim().min(1).max(20).optional(),
  legal_name: z.string().trim().min(1).max(200),
  trading_name: z.string().trim().max(200).optional(),
  abn: z.string().trim().min(5).max(50),
  address_line1: z.string().trim().max(200).optional(),
  address_line2: z.string().trim().max(200).optional(),
  address_city: z.string().trim().max(100).optional(),
  address_state: z.string().trim().max(100).optional(),
  address_postcode: z.string().trim().max(20).optional(),
  address_country: z.string().trim().max(100).optional(),
  phone: z.string().trim().max(50).optional(),
  email: z.string().trim().max(200).optional(),
  logo_url: z.string().trim().max(500).optional(),
  bank_account_name: z.string().trim().max(200).optional(),
  bank_bsb: z.string().trim().max(50).optional(),
  bank_account_no: z.string().trim().max(80).optional(),
  payment_note: z.string().trim().max(500).optional(),
  is_default: z.boolean().optional(),
  status: z.enum(['active', 'archived']).optional(),
})
 
router.get('/companies', requirePerm('invoice.view'), async (_req, res) => {
  try {
    await ensureInvoiceTables()
    const rows = hasPg ? await pgPool!.query('SELECT * FROM invoice_companies ORDER BY is_default DESC, created_at DESC') : null
    return res.json(rows?.rows || [])
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'list_failed' })
  }
})
 
router.post('/companies', requirePerm('invoice.company.manage'), async (req, res) => {
  try {
    await ensureInvoiceTables()
    const user = (req as any).user || {}
    const v = CompanySchema.parse(req.body || {})
    const id = uuid()
    const payload: any = { id, ...v, created_at: nowIso(), updated_at: nowIso() }
    if (v.is_default) {
      await pgPool!.query(`UPDATE invoice_companies SET is_default=false WHERE is_default=true`)
    }
    const row = await pgInsert('invoice_companies', payload as any)
    addAudit('InvoiceCompany', id, 'create', null, row, user?.sub || user?.username || null, { ip: req.ip, user_agent: req.headers['user-agent'] })
    return res.status(201).json(row)
  } catch (e: any) {
    return res.status(400).json({ message: e?.message || 'create_failed' })
  }
})
 
router.patch('/companies/:id', requirePerm('invoice.company.manage'), async (req, res) => {
  try {
    await ensureInvoiceTables()
    const { id } = req.params
    const user = (req as any).user || {}
    const before = await pgSelect('invoice_companies', '*', { id })
    const v = CompanySchema.partial().parse(req.body || {})
    if (v.is_default) {
      await pgPool!.query(`UPDATE invoice_companies SET is_default=false WHERE is_default=true`)
    }
    const row = await pgUpdate('invoice_companies', id, { ...v, updated_at: nowIso() } as any)
    addAudit('InvoiceCompany', id, 'update', (Array.isArray(before) ? before[0] : null), row, user?.sub || user?.username || null, { ip: req.ip, user_agent: req.headers['user-agent'] })
    return res.json(row)
  } catch (e: any) {
    return res.status(400).json({ message: e?.message || 'update_failed' })
  }
})

router.post('/companies/:id/logo/upload', requirePerm('invoice.company.manage'), memUpload.single('file'), async (req, res) => {
  const { id } = req.params
  if (!req.file) return res.status(400).json({ message: 'missing_file' })
  try {
    await ensureInvoiceTables()
    const user = (req as any).user || {}
    const actor = user?.sub || user?.username || null
    const beforeRows = await pgSelect('invoice_companies', '*', { id })
    const before = Array.isArray(beforeRows) ? beforeRows[0] : null
    if (!before) return res.status(404).json({ message: 'not_found' })

    const ct = String(req.file.mimetype || '')
    if (!/^image\/(png|jpe?g)$/i.test(ct)) return res.status(400).json({ message: 'unsupported_file_type' })
    const ext = (() => {
      if (/png/i.test(ct)) return '.png'
      return '.jpg'
    })()

    let url = ''
    if (hasR2 && (req.file as any).buffer) {
      const key = `invoice-company-logos/${id}/${uuid()}${ext}`
      url = await r2Upload(key, ct, (req.file as any).buffer)
    } else {
      const dir = path.join(process.cwd(), 'uploads', 'invoice-company-logos', id)
      await fs.promises.mkdir(dir, { recursive: true })
      const name = `${uuid()}${ext}`
      const full = path.join(dir, name)
      await fs.promises.writeFile(full, (req.file as any).buffer)
      url = `/uploads/invoice-company-logos/${id}/${name}`
    }

    const row = await pgUpdate('invoice_companies', id, { logo_url: url, updated_at: nowIso() } as any)
    addAudit('InvoiceCompany', id, 'upload_logo', before, row, actor, { ip: req.ip, user_agent: req.headers['user-agent'] })
    return res.status(201).json(row)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'upload_failed' })
  }
})
 
const LineItemSchema = z.object({
  description: z.string().trim().min(1).max(500),
  quantity: z.number().nonnegative(),
  unit_price: z.number(),
  gst_type: z.enum(['GST_10','GST_FREE','INPUT_TAXED']).default('GST_10'),
  sort_order: z.number().int().optional(),
})
 
const InvoiceCreateSchema = z.object({
  company_id: z.string().min(1),
  currency: z.string().trim().min(1).max(10).optional(),
  bill_to_name: z.string().trim().min(1).max(200).optional(),
  bill_to_email: z.string().trim().max(200).optional(),
  bill_to_address: z.string().trim().max(500).optional(),
  notes: z.string().trim().max(2000).optional(),
  terms: z.string().trim().max(2000).optional(),
  issue_date: z.string().trim().optional(),
  due_date: z.string().trim().optional(),
  sources: z.array(z.object({ source_type: z.string().trim().min(1).max(50), source_id: z.string().trim().min(1).max(80), label: z.string().trim().max(200).optional() })).optional(),
  line_items: z.array(LineItemSchema).min(1),
})
 
router.get('/', requirePerm('invoice.view'), async (req, res) => {
  try {
    await ensureInvoiceTables()
    const q = req.query || {}
    const companyId = String((q as any).company_id || '')
    const status = String((q as any).status || '')
    const from = String((q as any).from || '')
    const to = String((q as any).to || '')
    const keyword = String((q as any).q || '').trim()
    const params: any[] = []
    const where: string[] = []
    if (companyId) { params.push(companyId); where.push(`company_id = $${params.length}`) }
    if (status) { params.push(status); where.push(`status = $${params.length}`) }
    if (from) { params.push(from); where.push(`(issue_date IS NULL OR issue_date >= to_date($${params.length},'YYYY-MM-DD'))`) }
    if (to) { params.push(to); where.push(`(issue_date IS NULL OR issue_date <= to_date($${params.length},'YYYY-MM-DD'))`) }
    if (keyword) {
      params.push(`%${keyword}%`)
      const p = `$${params.length}`
      where.push(`(invoice_no ILIKE ${p} OR bill_to_name ILIKE ${p} OR bill_to_email ILIKE ${p})`)
    }
    const sql = `SELECT * FROM invoices${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT 500`
    const rows = await pgPool!.query(sql, params)
    return res.json(rows?.rows || [])
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'list_failed' })
  }
})
 
router.post('/', requireAnyPerm(['invoice.draft.create','invoice.issue']), async (req, res) => {
  try {
    await ensureInvoiceTables()
    const user = (req as any).user || {}
    const v = InvoiceCreateSchema.parse(req.body || {})
    const createdBy = user?.sub || user?.username || null
    const invoiceId = uuid()
    const lines = v.line_items.map((x, idx) => {
      const computed = computeLine({ quantity: x.quantity, unit_price: x.unit_price, gst_type: x.gst_type as GstType })
      return {
        id: uuid(),
        invoice_id: invoiceId,
        description: x.description,
        quantity: x.quantity,
        unit_price: x.unit_price,
        gst_type: x.gst_type,
        tax_amount: computed.tax_amount,
        line_subtotal: computed.line_subtotal,
        line_total: computed.line_total,
        sort_order: x.sort_order ?? idx,
      }
    })
    const totals = computeTotals(lines as any, 0)
    const primary = (v.sources && v.sources[0]) ? v.sources[0] : null
    const issueDate = toDateOnly(v.issue_date)
    const dueDate = toDateOnly(v.due_date)
    const invoicePayload: any = {
      id: invoiceId,
      company_id: v.company_id,
      currency: v.currency || 'AUD',
      status: 'draft',
      bill_to_name: v.bill_to_name || null,
      bill_to_email: v.bill_to_email || null,
      bill_to_address: v.bill_to_address || null,
      notes: v.notes || null,
      terms: v.terms || null,
      issue_date: issueDate,
      due_date: dueDate,
      primary_source_type: primary ? primary.source_type : null,
      primary_source_id: primary ? primary.source_id : null,
      created_by: createdBy,
      updated_by: createdBy,
      created_at: nowIso(),
      updated_at: nowIso(),
      ...totals,
    }
    const row = await pgInsert('invoices', invoicePayload)
    for (const li of lines) await pgInsert('invoice_line_items', li as any)
    if (Array.isArray(v.sources) && v.sources.length) {
      for (const s of v.sources) {
        await pgPool!.query('INSERT INTO invoice_sources (invoice_id, source_type, source_id, label) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [invoiceId, s.source_type, s.source_id, s.label || null])
      }
    }
    addAudit('Invoice', invoiceId, 'create', null, { ...row, line_items: lines, sources: v.sources || [] }, createdBy, { ip: req.ip, user_agent: req.headers['user-agent'] })
    return res.status(201).json({ ...row, line_items: lines, sources: v.sources || [] })
  } catch (e: any) {
    return res.status(400).json({ message: e?.message || 'create_failed' })
  }
})
 
router.get('/:id', requirePerm('invoice.view'), async (req, res) => {
  try {
    await ensureInvoiceTables()
    const { id } = req.params
    const inv = await pgSelect('invoices', '*', { id })
    const invoice = Array.isArray(inv) ? inv[0] : null
    if (!invoice) return res.status(404).json({ message: 'not_found' })
    const lines = await pgSelect('invoice_line_items', '*', { invoice_id: id })
    const sources = await pgPool!.query('SELECT * FROM invoice_sources WHERE invoice_id=$1 ORDER BY created_at ASC', [id])
    const files = await pgSelect('invoice_files', '*', { invoice_id: id })
    const comp = invoice.company_id ? await pgSelect('invoice_companies', '*', { id: invoice.company_id }) : null
    const company = Array.isArray(comp) ? comp[0] : null
    return res.json({ ...invoice, company, line_items: Array.isArray(lines) ? lines : [], sources: sources?.rows || [], files: Array.isArray(files) ? files : [] })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'get_failed' })
  }
})
 
const InvoicePatchSchema = z.object({
  currency: z.string().trim().min(1).max(10).optional(),
  bill_to_name: z.string().trim().min(1).max(200).optional(),
  bill_to_email: z.string().trim().max(200).optional(),
  bill_to_address: z.string().trim().max(500).optional(),
  notes: z.string().trim().max(2000).optional(),
  terms: z.string().trim().max(2000).optional(),
  issue_date: z.string().trim().optional(),
  due_date: z.string().trim().optional(),
  line_items: z.array(LineItemSchema).min(1).optional(),
})
 
router.patch('/:id', requireAnyPerm(['invoice.draft.create','invoice.issue']), async (req, res) => {
  try {
    await ensureInvoiceTables()
    const { id } = req.params
    const user = (req as any).user || {}
    const actor = user?.sub || user?.username || null
    const beforeRows = await pgSelect('invoices', '*', { id })
    const before = Array.isArray(beforeRows) ? beforeRows[0] : null
    if (!before) return res.status(404).json({ message: 'not_found' })
    const v = InvoicePatchSchema.parse(req.body || {})
    const status = String(before.status || 'draft')
    const editableAfterIssue = ['bill_to_email','bill_to_address','notes','terms','due_date']
    if (status !== 'draft') {
      for (const k of Object.keys(v)) {
        if (k === 'line_items') return res.status(400).json({ message: 'issued_invoice_cannot_edit_line_items' })
        if (!editableAfterIssue.includes(k)) return res.status(400).json({ message: `issued_invoice_cannot_edit_${k}` })
      }
    }
    let updated = await pgUpdate('invoices', id, {
      currency: v.currency,
      bill_to_name: status === 'draft' ? v.bill_to_name : undefined,
      bill_to_email: v.bill_to_email,
      bill_to_address: v.bill_to_address,
      notes: v.notes,
      terms: v.terms,
      issue_date: status === 'draft' ? toDateOnly(v.issue_date) : undefined,
      due_date: toDateOnly(v.due_date),
      updated_by: actor,
      updated_at: nowIso(),
    } as any)
    if (Array.isArray(v.line_items)) {
      await pgPool!.query('DELETE FROM invoice_line_items WHERE invoice_id=$1', [id])
      const lines = v.line_items.map((x, idx) => {
        const computed = computeLine({ quantity: x.quantity, unit_price: x.unit_price, gst_type: x.gst_type as GstType })
        return {
          id: uuid(),
          invoice_id: id,
          description: x.description,
          quantity: x.quantity,
          unit_price: x.unit_price,
          gst_type: x.gst_type,
          tax_amount: computed.tax_amount,
          line_subtotal: computed.line_subtotal,
          line_total: computed.line_total,
          sort_order: x.sort_order ?? idx,
        }
      })
      for (const li of lines) await pgInsert('invoice_line_items', li as any)
      const totals = computeTotals(lines as any, Number(updated?.amount_paid || 0))
      updated = await pgUpdate('invoices', id, { ...totals, updated_by: actor, updated_at: nowIso() } as any)
    }
    addAudit('Invoice', id, 'update', before, updated, actor, { ip: req.ip, user_agent: req.headers['user-agent'] })
    return res.json(updated)
  } catch (e: any) {
    return res.status(400).json({ message: e?.message || 'update_failed' })
  }
})
 
router.post('/:id/issue', requirePerm('invoice.issue'), async (req, res) => {
  try {
    await ensureInvoiceTables()
    const { id } = req.params
    const user = (req as any).user || {}
    const actor = user?.sub || user?.username || null
    const result = await pgRunInTransaction(async (client) => {
      const rs = await client.query('SELECT * FROM invoices WHERE id=$1 FOR UPDATE', [id])
      const inv = rs?.rows?.[0]
      if (!inv) throw new Error('not_found')
      if (String(inv.status || '') !== 'draft') return inv
      const issueDate = toDateOnly(inv.issue_date) || new Date().toISOString().slice(0, 10)
      const year = Number(issueDate.slice(0, 4))
      const invoiceNo = await nextInvoiceNo(String(inv.company_id), year, client)
      const upd = await client.query(
        `UPDATE invoices
         SET status='issued', invoice_no=$1, issue_date=to_date($2,'YYYY-MM-DD'), issued_at=now(), updated_by=$3, updated_at=now()
         WHERE id=$4 RETURNING *`,
        [invoiceNo, issueDate, actor, id]
      )
      return upd?.rows?.[0]
    })
    addAudit('Invoice', id, 'issue', null, result, actor, { ip: req.ip, user_agent: req.headers['user-agent'] })
    return res.json(result)
  } catch (e: any) {
    const msg = String(e?.message || '')
    if (msg === 'not_found') return res.status(404).json({ message: 'not_found' })
    return res.status(400).json({ message: e?.message || 'issue_failed' })
  }
})
 
router.post('/:id/void', requirePerm('invoice.void'), async (req, res) => {
  try {
    await ensureInvoiceTables()
    const { id } = req.params
    const user = (req as any).user || {}
    const actor = user?.sub || user?.username || null
    const reason = String((req.body || {}).reason || '').trim()
    if (!reason) return res.status(400).json({ message: 'missing_reason' })
    const beforeRows = await pgSelect('invoices', '*', { id })
    const before = Array.isArray(beforeRows) ? beforeRows[0] : null
    if (!before) return res.status(404).json({ message: 'not_found' })
    const status = String(before.status || '')
    if (status === 'paid') return res.status(400).json({ message: 'cannot_void_paid' })
    const row = await pgUpdate('invoices', id, { status: 'void', void_reason: reason, voided_at: nowIso(), updated_by: actor, updated_at: nowIso() } as any)
    addAudit('Invoice', id, 'void', before, row, actor, { ip: req.ip, user_agent: req.headers['user-agent'] })
    return res.json(row)
  } catch (e: any) {
    return res.status(400).json({ message: e?.message || 'void_failed' })
  }
})
 
router.post('/:id/mark-sent', requirePerm('invoice.send'), async (req, res) => {
  try {
    await ensureInvoiceTables()
    const { id } = req.params
    const user = (req as any).user || {}
    const actor = user?.sub || user?.username || null
    const body = req.body || {}
    const toEmail = body.to_email != null ? String(body.to_email || '').trim() : null
    const ccEmail = body.cc_email != null ? String(body.cc_email || '').trim() : null
    const subject = body.subject != null ? String(body.subject || '').trim() : null
    const mailBody = body.body != null ? String(body.body || '').trim() : null
    const channel = body.channel != null ? String(body.channel || '').trim() : 'manual'
    const beforeRows = await pgSelect('invoices', '*', { id })
    const before = Array.isArray(beforeRows) ? beforeRows[0] : null
    if (!before) return res.status(404).json({ message: 'not_found' })
    const status = String(before.status || '')
    if (status === 'draft') return res.status(400).json({ message: 'cannot_send_draft' })
    const row = await pgUpdate('invoices', id, { status: status === 'issued' ? 'sent' : status, sent_at: nowIso(), updated_by: actor, updated_at: nowIso() } as any)
    try {
      await pgInsert('invoice_send_logs', { id: uuid(), invoice_id: id, channel, to_email: toEmail, cc_email: ccEmail, subject, body: mailBody, status: 'sent', created_by: actor } as any)
    } catch {}
    addAudit('Invoice', id, 'mark_sent', before, row, actor, { ip: req.ip, user_agent: req.headers['user-agent'] })
    return res.json(row)
  } catch (e: any) {
    return res.status(400).json({ message: e?.message || 'mark_sent_failed' })
  }
})

router.get('/:id/send-logs', requirePerm('invoice.view'), async (req, res) => {
  try {
    await ensureInvoiceTables()
    const { id } = req.params
    const rows = await pgPool!.query('SELECT * FROM invoice_send_logs WHERE invoice_id=$1 ORDER BY created_at DESC LIMIT 50', [id])
    return res.json(rows?.rows || [])
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'list_failed' })
  }
})
 
router.post('/:id/record-payment', requirePerm('invoice.payment.record'), async (req, res) => {
  try {
    await ensureInvoiceTables()
    const { id } = req.params
    const user = (req as any).user || {}
    const actor = user?.sub || user?.username || null
    const amount = round2((req.body || {}).amount)
    const paidAt = toDateOnly((req.body || {}).paid_at) || new Date().toISOString().slice(0, 10)
    const paidAtTs = (() => {
      const dt = new Date(`${paidAt}T00:00:00.000Z`)
      return Number.isNaN(dt.getTime()) ? nowIso() : dt.toISOString()
    })()
    if (!(amount > 0)) return res.status(400).json({ message: 'invalid_amount' })
    const beforeRows = await pgSelect('invoices', '*', { id })
    const before = Array.isArray(beforeRows) ? beforeRows[0] : null
    if (!before) return res.status(404).json({ message: 'not_found' })
    if (String(before.status || '') === 'void') return res.status(400).json({ message: 'cannot_pay_void' })
    const lines = await pgSelect('invoice_line_items', '*', { invoice_id: id })
    const totals = computeTotals((Array.isArray(lines) ? lines : []) as any, Number(before.amount_paid || 0) + amount)
    const newStatus = totals.amount_due <= 0 ? 'paid' : String(before.status || '')
    const row = await pgUpdate('invoices', id, { ...totals, status: newStatus, paid_at: newStatus === 'paid' ? paidAtTs : null, updated_by: actor, updated_at: nowIso() } as any)
    addAudit('Invoice', id, 'record_payment', before, { ...row, payment: { amount, paid_at: paidAt } }, actor, { ip: req.ip, user_agent: req.headers['user-agent'] })
    return res.json(row)
  } catch (e: any) {
    return res.status(400).json({ message: e?.message || 'record_payment_failed' })
  }
})
 
router.post('/:id/refund', requirePerm('invoice.void'), async (req, res) => {
  try {
    await ensureInvoiceTables()
    const { id } = req.params
    const user = (req as any).user || {}
    const actor = user?.sub || user?.username || null
    const reason = String((req.body || {}).reason || '').trim()
    if (!reason) return res.status(400).json({ message: 'missing_reason' })
    const beforeRows = await pgSelect('invoices', '*', { id })
    const before = Array.isArray(beforeRows) ? beforeRows[0] : null
    if (!before) return res.status(404).json({ message: 'not_found' })
    const status = String(before.status || '')
    if (status !== 'paid') return res.status(400).json({ message: 'only_paid_can_refund' })
    const row = await pgUpdate('invoices', id, { status: 'refunded', refund_reason: reason, refunded_at: nowIso(), updated_by: actor, updated_at: nowIso() } as any)
    addAudit('Invoice', id, 'refund', before, row, actor, { ip: req.ip, user_agent: req.headers['user-agent'] })
    return res.json(row)
  } catch (e: any) {
    return res.status(400).json({ message: e?.message || 'refund_failed' })
  }
})

const DraftFromSourcesSchema = z.object({
  company_id: z.string().min(1),
  mode: z.enum(['per_item','merge']).default('per_item'),
  currency: z.string().trim().min(1).max(10).optional(),
  sources: z.array(z.object({ source_type: z.enum(['work_order','deep_clean','landlord_fee','consumables','accommodation','external_job']), source_id: z.string().trim().min(1).max(80) })).min(1),
})

async function buildDraftForSource(source_type: string, source_id: string) {
  if (source_type === 'accommodation') {
    const r = await pgSelect('orders', '*', { id: source_id })
    const o = Array.isArray(r) ? r[0] : null
    if (!o) throw new Error('source_not_found')
    const price = round2(o.price)
    return {
      bill_to_name: String(o.guest_name || '').trim() || null,
      bill_to_email: null,
      bill_to_address: null,
      label: `order:${String(o.source || '')}:${String(o.confirmation_code || o.external_id || '')}`.replace(/:+$/,''),
      line_items: [
        { description: `Accommodation fee (${String(o.checkin || '').slice(0,10)} to ${String(o.checkout || '').slice(0,10)})`, quantity: 1, unit_price: price, gst_type: 'GST_10' as GstType },
      ],
    }
  }

  if (source_type === 'work_order') {
    const rs = await pgPool!.query('SELECT * FROM property_maintenance WHERE id=$1 LIMIT 1', [source_id])
    const m = rs?.rows?.[0]
    if (!m) throw new Error('source_not_found')
    const details = m.details
    let items: any[] = []
    try {
      const parsed = Array.isArray(details) ? details : (details ? (typeof details === 'string' ? JSON.parse(details) : details) : [])
      items = Array.isArray(parsed) ? parsed : []
    } catch { items = [] }
    const sum = round2((Array.isArray(items) ? items : []).reduce((s: number, x: any) => s + Number(x.amount || 0), 0))
    const amt = sum || round2(m.maintenance_amount || 0) || round2(m.parts_amount || 0)
    const desc = `Work order ${String(m.work_no || m.id)}`
    return {
      bill_to_name: null,
      bill_to_email: null,
      bill_to_address: null,
      label: desc,
      line_items: [
        { description: desc, quantity: 1, unit_price: amt, gst_type: 'GST_10' as GstType },
      ],
    }
  }

  if (source_type === 'deep_clean') {
    const rs = await pgPool!.query('SELECT * FROM property_deep_cleaning WHERE id=$1 LIMIT 1', [source_id])
    const d = rs?.rows?.[0]
    if (!d) throw new Error('source_not_found')
    const labor = round2(d.labor_cost || 0)
    const desc = `Deep cleaning ${String(d.work_no || d.id)}`
    return {
      bill_to_name: null,
      bill_to_email: null,
      bill_to_address: null,
      label: desc,
      line_items: [
        { description: desc, quantity: 1, unit_price: labor, gst_type: 'GST_10' as GstType },
      ],
    }
  }

  const exp = await pgPool!.query('SELECT * FROM property_expenses WHERE id=$1 LIMIT 1', [source_id])
  const e = exp?.rows?.[0]
  if (!e) throw new Error('source_not_found')
  const amount = round2(e.amount || 0)
  const cat = String(e.category || source_type)
  const detail = String(e.category_detail || '').trim()
  const note = String(e.note || '').trim()
  const label = [cat, detail].filter(Boolean).join(' / ') || cat
  const desc = note ? `${label} - ${note}` : label
  return {
    bill_to_name: null,
    bill_to_email: null,
    bill_to_address: null,
    label,
    line_items: [
      { description: desc, quantity: 1, unit_price: amount, gst_type: 'GST_10' as GstType },
    ],
  }
}

router.post('/draft-from-sources', requireAnyPerm(['invoice.draft.create','invoice.issue']), async (req, res) => {
  try {
    await ensureInvoiceTables()
    const user = (req as any).user || {}
    const actor = user?.sub || user?.username || null
    const v = DraftFromSourcesSchema.parse(req.body || {})
    const currency = v.currency || 'AUD'
    if (v.mode === 'merge') {
      const blocks = []
      for (const s of v.sources) blocks.push({ s, draft: await buildDraftForSource(s.source_type, s.source_id) })
      const allLineItems = blocks.flatMap((b) => b.draft.line_items.map((li) => ({ ...li, description: `[${b.s.source_type}:${b.s.source_id}] ${li.description}` })))
      const payload = {
        company_id: v.company_id,
        currency,
        sources: v.sources,
        line_items: allLineItems.map((x) => ({ description: x.description, quantity: Number(x.quantity), unit_price: Number(x.unit_price), gst_type: x.gst_type, sort_order: 0 })),
      }
      const resp = await (async () => {
        const invoiceId = uuid()
        const lines = payload.line_items.map((x, idx) => {
          const computed = computeLine({ quantity: x.quantity, unit_price: x.unit_price, gst_type: x.gst_type as GstType })
          return { id: uuid(), invoice_id: invoiceId, description: x.description, quantity: x.quantity, unit_price: x.unit_price, gst_type: x.gst_type, tax_amount: computed.tax_amount, line_subtotal: computed.line_subtotal, line_total: computed.line_total, sort_order: idx }
        })
        const totals = computeTotals(lines as any, 0)
        const primary = payload.sources[0]
        const row = await pgInsert('invoices', { id: invoiceId, company_id: payload.company_id, currency: payload.currency, status: 'draft', primary_source_type: primary.source_type, primary_source_id: primary.source_id, created_by: actor, updated_by: actor, created_at: nowIso(), updated_at: nowIso(), ...totals } as any)
        for (const li of lines) await pgInsert('invoice_line_items', li as any)
        for (const s of payload.sources) {
          await pgPool!.query('INSERT INTO invoice_sources (invoice_id, source_type, source_id, label) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [invoiceId, s.source_type, s.source_id, null])
        }
        addAudit('Invoice', invoiceId, 'create', null, { ...row, line_items: lines, sources: payload.sources }, actor, { ip: req.ip, user_agent: req.headers['user-agent'] })
        return { ...row, line_items: lines, sources: payload.sources }
      })()
      return res.status(201).json({ mode: 'merge', invoices: [resp] })
    }
    const outputs: any[] = []
    for (const s of v.sources) {
      const d = await buildDraftForSource(s.source_type, s.source_id)
      const payload = {
        company_id: v.company_id,
        currency,
        sources: [s],
        bill_to_name: d.bill_to_name,
        bill_to_email: d.bill_to_email,
        bill_to_address: d.bill_to_address,
        line_items: d.line_items,
      }
      const invoiceId = uuid()
      const lines = payload.line_items.map((x, idx) => {
        const computed = computeLine({ quantity: x.quantity, unit_price: x.unit_price, gst_type: x.gst_type as GstType })
        return { id: uuid(), invoice_id: invoiceId, description: x.description, quantity: x.quantity, unit_price: x.unit_price, gst_type: x.gst_type, tax_amount: computed.tax_amount, line_subtotal: computed.line_subtotal, line_total: computed.line_total, sort_order: idx }
      })
      const totals = computeTotals(lines as any, 0)
      const row = await pgInsert('invoices', { id: invoiceId, company_id: payload.company_id, currency: payload.currency, status: 'draft', bill_to_name: payload.bill_to_name, bill_to_email: payload.bill_to_email, bill_to_address: payload.bill_to_address, primary_source_type: s.source_type, primary_source_id: s.source_id, created_by: actor, updated_by: actor, created_at: nowIso(), updated_at: nowIso(), ...totals } as any)
      for (const li of lines) await pgInsert('invoice_line_items', li as any)
      await pgPool!.query('INSERT INTO invoice_sources (invoice_id, source_type, source_id, label) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [invoiceId, s.source_type, s.source_id, d.label || null])
      addAudit('Invoice', invoiceId, 'create', null, { ...row, line_items: lines, sources: [s] }, actor, { ip: req.ip, user_agent: req.headers['user-agent'] })
      outputs.push({ ...row, line_items: lines, sources: [s] })
    }
    return res.status(201).json({ mode: 'per_item', invoices: outputs })
  } catch (e: any) {
    return res.status(400).json({ message: e?.message || 'draft_from_sources_failed' })
  }
})

router.post('/:id/files/upload', requireAnyPerm(['invoice.draft.create','invoice.issue','invoice.send']), memUpload.single('file'), async (req, res) => {
  const { id } = req.params
  if (!req.file) return res.status(400).json({ message: 'missing_file' })
  try {
    await ensureInvoiceTables()
    const user = (req as any).user || {}
    const actor = user?.sub || user?.username || null
    const ext = path.extname(req.file.originalname) || ''
    let url = ''
    if (hasR2 && (req.file as any).buffer) {
      const key = `invoice-files/${id}/${uuid()}${ext}`
      url = await r2Upload(key, req.file.mimetype || 'application/octet-stream', (req.file as any).buffer)
    } else {
      const dir = path.join(process.cwd(), 'uploads', 'invoice-files', id)
      await fs.promises.mkdir(dir, { recursive: true })
      const name = `${uuid()}${ext}`
      const full = path.join(dir, name)
      await fs.promises.writeFile(full, (req.file as any).buffer)
      url = `/uploads/invoice-files/${id}/${name}`
    }
    const rec: any = {
      id: uuid(),
      invoice_id: id,
      kind: String((req.body || {}).kind || 'pdf'),
      url,
      file_name: req.file.originalname,
      mime_type: req.file.mimetype,
      file_size: req.file.size,
      created_by: actor,
    }
    const row = await pgInsert('invoice_files', rec)
    addAudit('Invoice', id, 'upload_file', null, row, actor, { ip: req.ip, user_agent: req.headers['user-agent'] })
    return res.status(201).json(row)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'upload_failed' })
  }
})

router.post('/merge-pdf', requirePerm('invoice.view'), async (req, res) => {
  try {
    await ensureInvoiceTables()
    const body = req.body || {}
    const invoiceIds: string[] = Array.isArray(body.invoice_ids) ? body.invoice_ids.filter((x: any) => typeof x === 'string') : []
    const urlInputs: string[] = Array.isArray(body.urls) ? body.urls.filter((x: any) => typeof x === 'string') : []
    const urls: string[] = [...urlInputs]
    if (invoiceIds.length) {
      const r = await pgPool!.query(
        `SELECT invoice_id, url, file_name, created_at
         FROM invoice_files
         WHERE invoice_id = ANY($1::text[])
         ORDER BY invoice_id ASC, created_at DESC`,
        [invoiceIds]
      )
      const grouped: Record<string, any[]> = {}
      for (const row of (r?.rows || [])) {
        const iid = String(row.invoice_id || '')
        if (!grouped[iid]) grouped[iid] = []
        grouped[iid].push(row)
      }
      for (const iid of invoiceIds) {
        const list = grouped[iid] || []
        const best = list.find((x) => /\.pdf($|\?)/i.test(String(x.url || ''))) || list[0]
        if (best?.url) urls.push(String(best.url))
      }
    }
    if (!urls.length) return res.status(400).json({ message: 'missing invoice pdf urls' })

    async function fetchBytes(u: string): Promise<Uint8Array> {
      const s = String(u || '')
      if (s.startsWith('/uploads/')) {
        const full = path.join(process.cwd(), s.replace(/^\//, ''))
        const buf = await fs.promises.readFile(full)
        return new Uint8Array(buf)
      }
      const r = await fetch(s)
      if (!r.ok) throw new Error(`fetch failed: ${r.status}`)
      const ab = await r.arrayBuffer()
      return new Uint8Array(ab)
    }

    const merged = await PDFDocument.create()
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
      } catch {
      }
    }
    const out = await merged.save()
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', 'attachment; filename=\"invoices-merged.pdf\"')
    return res.status(200).send(Buffer.from(out))
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'merge_failed' })
  }
})
 
