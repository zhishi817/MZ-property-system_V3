import { Router } from 'express'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import { createHash } from 'crypto'
import { z } from 'zod'
import { PDFDocument } from 'pdf-lib'
import { requireAnyPerm, requirePerm } from '../auth'
import { hasPg, pgDelete, pgInsert, pgPool, pgRunInTransaction, pgSelect, pgUpdate } from '../dbAdapter'
import { hasR2, r2Upload } from '../r2'
import { addAudit, db, roleHasPermission } from '../store'
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
    invoice_type text DEFAULT 'invoice',
    invoice_no text,
    biz_unique_key text,
    issue_date date,
    due_date date,
    valid_until date,
    currency text DEFAULT 'AUD',
    status text DEFAULT 'draft',
    customer_id text,
    bill_to_name text,
    bill_to_email text,
    bill_to_phone text,
    bill_to_abn text,
    bill_to_address text,
    subtotal numeric,
    tax_total numeric,
    total numeric,
    amount_paid numeric DEFAULT 0,
    amount_due numeric,
    payment_method text,
    payment_method_note text,
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
  await pgPool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS customer_id text;`)
  await pgPool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS invoice_type text DEFAULT 'invoice';`)
  await pgPool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS biz_unique_key text;`)
  await pgPool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS valid_until date;`)
  await pgPool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS bill_to_phone text;`)
  await pgPool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS bill_to_abn text;`)
  await pgPool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_method text;`)
  await pgPool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_method_note text;`)
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_invoices_company ON invoices(company_id);')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_invoices_issue_date ON invoices(issue_date);')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_invoices_type ON invoices(invoice_type);')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_invoices_invoice_no ON invoices(invoice_no);')
  await pgPool.query("CREATE UNIQUE INDEX IF NOT EXISTS uniq_invoices_company_invoice_no ON invoices(company_id, invoice_no) WHERE invoice_no IS NOT NULL;")
  await pgPool.query("CREATE UNIQUE INDEX IF NOT EXISTS uniq_invoices_biz_unique_key ON invoices(biz_unique_key) WHERE biz_unique_key IS NOT NULL;")

  await pgPool.query(`CREATE TABLE IF NOT EXISTS invoice_customers (
    id text PRIMARY KEY,
    name text NOT NULL,
    abn text,
    address text,
    phone text,
    email text,
    status text DEFAULT 'active',
    created_by text,
    updated_by text,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz
  );`)
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_invoice_customers_status ON invoice_customers(status);')
  await pgPool.query("CREATE UNIQUE INDEX IF NOT EXISTS uniq_invoice_customers_abn ON invoice_customers(abn) WHERE abn IS NOT NULL AND abn <> '';")

  await pgPool.query(`CREATE TABLE IF NOT EXISTS invoice_payment_events (
    id text PRIMARY KEY,
    invoice_id text REFERENCES invoices(id) ON DELETE CASCADE,
    status text,
    payment_method text,
    payment_method_note text,
    created_by text,
    created_at timestamptz DEFAULT now()
  );`)
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_invoice_payment_events_invoice ON invoice_payment_events(invoice_id, created_at DESC);')
 
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

  await pgPool.query(`CREATE TABLE IF NOT EXISTS invoice_number_sequences (
    id text PRIMARY KEY,
    company_id text REFERENCES invoice_companies(id) ON DELETE CASCADE,
    ymd text NOT NULL,
    invoice_type text NOT NULL,
    next_value integer NOT NULL,
    updated_at timestamptz,
    UNIQUE(company_id, ymd, invoice_type)
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

type InvoiceType = 'quote' | 'invoice' | 'receipt'
function normalizeInvoiceType(v: any): InvoiceType {
  const s = String(v || '').trim().toLowerCase()
  if (s === 'quote') return 'quote'
  if (s === 'receipt') return 'receipt'
  return 'invoice'
}

function addDays(dateOnly: string, days: number) {
  const dt = new Date(`${dateOnly}T00:00:00Z`)
  dt.setUTCDate(dt.getUTCDate() + Number(days || 0))
  return dt.toISOString().slice(0, 10)
}

async function roleHasPermAsync(roleName: string, code: string) {
  if (roleName === 'admin') return true
  let ok = false
  try {
    if (hasPg && pgPool) {
      let roleId = db.roles.find(r => r.name === roleName)?.id
      try {
        const r0 = await pgPool.query('SELECT id FROM roles WHERE name=$1 LIMIT 1', [roleName])
        if (r0 && r0.rows && r0.rows[0] && r0.rows[0].id) roleId = String(r0.rows[0].id)
      } catch {}
      const roleIds = Array.from(new Set([roleId, roleName, roleName.startsWith('role.') ? roleName.replace(/^role\./, '') : `role.${roleName}`].filter(Boolean)))
      const r = await pgPool.query('SELECT 1 FROM role_permissions WHERE role_id = ANY($1::text[]) AND permission_code = $2 LIMIT 1', [roleIds, code])
      ok = !!r?.rowCount
    }
  } catch {}
  if (!ok) ok = roleHasPermission(roleName, code)
  return ok
}
 
function round2(n: any) {
  const x = Number(n || 0)
  return Math.round(x * 100) / 100
}
 
type GstType = 'GST_10' | 'GST_INCLUDED_10' | 'GST_FREE' | 'INPUT_TAXED'

function stableBizKeyPayload(payload: any) {
  const p = payload || {}
  const items = Array.isArray(p.line_items) ? p.line_items : []
  const normalizedItems = items.map((x: any) => ({
    description: String(x?.description || '').trim(),
    quantity: round2(Number(x?.quantity || 0)),
    unit_price: round2(Number(x?.unit_price || 0)),
    gst_type: String(x?.gst_type || '').trim(),
    sort_order: Number(x?.sort_order ?? 0),
  })).filter((x: any) => x.description)
    .sort((a: any, b: any) => (a.sort_order - b.sort_order) || a.description.localeCompare(b.description))

  return {
    company_id: String(p.company_id || '').trim(),
    invoice_type: normalizeInvoiceType(p.invoice_type),
    issue_date: toDateOnly(p.issue_date) || '',
    total: round2(Number(p.total || 0)),
    currency: String(p.currency || 'AUD').trim(),
    bill_to_name: String(p.bill_to_name || '').trim(),
    bill_to_email: String(p.bill_to_email || '').trim(),
    primary_source_type: String(p.primary_source_type || '').trim(),
    primary_source_id: String(p.primary_source_id || '').trim(),
    line_items: normalizedItems,
  }
}

function computeBizUniqueKey(payload: any) {
  const base = stableBizKeyPayload(payload)
  const raw = JSON.stringify(base)
  return createHash('sha256').update(raw).digest('hex')
}

function isPgUniqueViolation(e: any) {
  const code = String(e?.code || '')
  return code === '23505'
}
 
function computeLine(item: { quantity: number; unit_price: number; gst_type: GstType }) {
  const qty = Number(item.quantity || 0)
  const unit = Number(item.unit_price || 0)
  const base = round2(qty * unit)
  if (item.gst_type === 'GST_INCLUDED_10') {
    const tax = round2(base / 11)
    const sub = round2(base - tax)
    return { line_subtotal: sub, tax_amount: tax, line_total: base }
  }
  let tax = 0
  if (item.gst_type === 'GST_10') tax = round2(base * 0.1)
  const lineTotal = round2(base + tax)
  return { line_subtotal: base, tax_amount: tax, line_total: lineTotal }
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

function invoiceTypePrefix(t: InvoiceType) {
  if (t === 'quote') return 'QT'
  if (t === 'receipt') return 'REC'
  return 'INV'
}

async function nextInvoiceNoByType(companyId: string, invoiceType: InvoiceType, issueDate: string, client: any) {
  const year = String(issueDate || '').slice(0, 4)
  if (!/^\d{4}$/.test(year)) throw new Error('invalid_issue_date')
  const prefix = invoiceTypePrefix(invoiceType)
  const compRs = await client.query('SELECT code FROM invoice_companies WHERE id=$1 LIMIT 1', [companyId])
  const companyCode = String(compRs?.rows?.[0]?.code || '').trim() || 'INV'
  const row = await client.query('SELECT * FROM invoice_number_sequences WHERE company_id=$1 AND ymd=$2 AND invoice_type=$3 FOR UPDATE', [companyId, year, invoiceType])
  let seq = row?.rows?.[0]
  if (!seq) {
    const ins = await client.query(
      'INSERT INTO invoice_number_sequences (id, company_id, ymd, invoice_type, next_value, updated_at) VALUES ($1,$2,$3,$4,$5, now()) RETURNING *',
      [uuid(), companyId, year, invoiceType, 1]
    )
    seq = ins?.rows?.[0]
  }
  const nextValue = Number(seq?.next_value || 1)
  const num = String(nextValue).padStart(4, '0')
  const invoiceNo = `${companyCode}${prefix}${year}${num}`
  await client.query('UPDATE invoice_number_sequences SET next_value=$1, updated_at=now() WHERE company_id=$2 AND ymd=$3 AND invoice_type=$4', [nextValue + 1, companyId, year, invoiceType])
  return invoiceNo
}
 
const optStr = (max: number) => z.preprocess((v) => (v === null || v === undefined || v === '' ? undefined : v), z.string().trim().max(max).optional())
const optStrMinMax = (min: number, max: number) => z.preprocess((v) => (v === null || v === undefined || v === '' ? undefined : v), z.string().trim().min(min).max(max).optional())

const CompanySchema = z.object({
  code: optStrMinMax(1, 20),
  legal_name: z.string().trim().min(1).max(200),
  trading_name: optStr(200),
  abn: z.string().trim().min(5).max(50),
  address_line1: optStr(200),
  address_line2: optStr(200),
  address_city: optStr(100),
  address_state: optStr(100),
  address_postcode: optStr(20),
  address_country: optStr(100),
  phone: optStr(50),
  email: optStr(200),
  logo_url: optStr(500),
  bank_account_name: optStr(200),
  bank_bsb: optStr(50),
  bank_account_no: optStr(80),
  payment_note: optStr(500),
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
    const abn = String(v.abn || '').trim()
    if (abn) {
      const dup = await pgPool!.query('SELECT 1 FROM invoice_companies WHERE abn=$1 LIMIT 1', [abn])
      if (dup?.rowCount) return res.status(400).json({ message: 'duplicate_company_abn' })
    }
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
    if (v.abn) {
      const abn = String(v.abn || '').trim()
      if (abn) {
        const dup = await pgPool!.query('SELECT 1 FROM invoice_companies WHERE abn=$1 AND id<>$2 LIMIT 1', [abn, id])
        if (dup?.rowCount) return res.status(400).json({ message: 'duplicate_company_abn' })
      }
    }
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

router.delete('/companies/:id', requirePerm('invoice.company.manage'), async (req, res) => {
  try {
    await ensureInvoiceTables()
    const { id } = req.params
    const user = (req as any).user || {}
    const before = await pgSelect('invoice_companies', '*', { id })
    const b = Array.isArray(before) ? before[0] : null
    if (!b) return res.status(404).json({ message: 'not_found' })
    const used = await pgPool!.query('SELECT 1 FROM invoices WHERE company_id=$1 LIMIT 1', [id])
    if (used?.rowCount) return res.status(400).json({ message: 'company_in_use' })
    const row = await pgDelete('invoice_companies', id)
    addAudit('InvoiceCompany', id, 'delete', b, row, user?.sub || user?.username || null, { ip: req.ip, user_agent: req.headers['user-agent'] })
    return res.json({ ok: true })
  } catch (e: any) {
    return res.status(400).json({ message: e?.message || 'delete_failed' })
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

const CustomerSchema = z.object({
  name: z.string().trim().min(1).max(200),
  abn: optStr(50),
  address: optStr(500),
  phone: optStr(50),
  email: optStr(200),
  status: z.enum(['active', 'archived']).optional(),
})

router.get('/customers', requireAnyPerm(['invoice.view','invoice.draft.create','invoice.issue']), async (req, res) => {
  try {
    await ensureInvoiceTables()
    const q = String((req.query as any)?.q || '').trim()
    const status = String((req.query as any)?.status || 'active')
    const params: any[] = []
    const where: string[] = []
    if (status) { params.push(status); where.push(`status = $${params.length}`) }
    if (q) {
      params.push(`%${q}%`)
      const p = `$${params.length}`
      where.push(`(name ILIKE ${p} OR abn ILIKE ${p} OR email ILIKE ${p} OR phone ILIKE ${p})`)
    }
    const sql = `SELECT * FROM invoice_customers${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC NULLS LAST, created_at DESC LIMIT 500`
    const rows = await pgPool!.query(sql, params)
    return res.json(rows?.rows || [])
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'list_failed' })
  }
})

router.post('/customers', requireAnyPerm(['invoice.company.manage','invoice.draft.create','invoice.issue']), async (req, res) => {
  try {
    await ensureInvoiceTables()
    const user = (req as any).user || {}
    const actor = user?.sub || user?.username || null
    const v = CustomerSchema.parse(req.body || {})
    const abn = String(v.abn || '').trim()
    const email = String(v.email || '').trim()
    const name = String(v.name || '').trim()
    if (abn) {
      const dup = await pgPool!.query("SELECT 1 FROM invoice_customers WHERE status='active' AND abn=$1 LIMIT 1", [abn])
      if (dup?.rowCount) return res.status(400).json({ message: 'duplicate_customer_abn' })
    }
    if (email) {
      const dup2 = await pgPool!.query("SELECT 1 FROM invoice_customers WHERE status='active' AND lower(email)=lower($1) AND lower(name)=lower($2) LIMIT 1", [email, name])
      if (dup2?.rowCount) return res.status(400).json({ message: 'duplicate_customer' })
    }
    const id = uuid()
    const row = await pgInsert('invoice_customers', { id, name, abn: abn || null, address: v.address || null, phone: v.phone || null, email: email || null, status: v.status || 'active', created_by: actor, updated_by: actor, created_at: nowIso(), updated_at: nowIso() } as any)
    addAudit('InvoiceCustomer', id, 'create', null, row, actor, { ip: req.ip, user_agent: req.headers['user-agent'] })
    return res.status(201).json(row)
  } catch (e: any) {
    return res.status(400).json({ message: e?.message || 'create_failed' })
  }
})

router.patch('/customers/:id', requireAnyPerm(['invoice.company.manage','invoice.draft.create','invoice.issue']), async (req, res) => {
  try {
    await ensureInvoiceTables()
    const { id } = req.params
    const user = (req as any).user || {}
    const actor = user?.sub || user?.username || null
    const beforeRows = await pgSelect('invoice_customers', '*', { id })
    const before = Array.isArray(beforeRows) ? beforeRows[0] : null
    if (!before) return res.status(404).json({ message: 'not_found' })
    const v = CustomerSchema.partial().parse(req.body || {})
    const abn = v.abn != null ? String(v.abn || '').trim() : undefined
    const email = v.email != null ? String(v.email || '').trim() : undefined
    const name = v.name != null ? String(v.name || '').trim() : undefined
    if (abn) {
      const dup = await pgPool!.query("SELECT 1 FROM invoice_customers WHERE status='active' AND abn=$1 AND id<>$2 LIMIT 1", [abn, id])
      if (dup?.rowCount) return res.status(400).json({ message: 'duplicate_customer_abn' })
    }
    if (email && (name || before.name)) {
      const n = name || String(before.name || '')
      const dup2 = await pgPool!.query("SELECT 1 FROM invoice_customers WHERE status='active' AND lower(email)=lower($1) AND lower(name)=lower($2) AND id<>$3 LIMIT 1", [email, String(n || ''), id])
      if (dup2?.rowCount) return res.status(400).json({ message: 'duplicate_customer' })
    }
    const row = await pgUpdate('invoice_customers', id, { ...v, abn: abn === undefined ? undefined : (abn || null), email: email === undefined ? undefined : (email || null), name: name === undefined ? undefined : name, updated_by: actor, updated_at: nowIso() } as any)
    addAudit('InvoiceCustomer', id, 'update', before, row, actor, { ip: req.ip, user_agent: req.headers['user-agent'] })
    return res.json(row)
  } catch (e: any) {
    return res.status(400).json({ message: e?.message || 'update_failed' })
  }
})

router.delete('/customers/:id', requireAnyPerm(['invoice.company.manage','invoice.draft.create','invoice.issue']), async (req, res) => {
  try {
    await ensureInvoiceTables()
    const { id } = req.params
    const user = (req as any).user || {}
    const actor = user?.sub || user?.username || null
    const beforeRows = await pgSelect('invoice_customers', '*', { id })
    const before = Array.isArray(beforeRows) ? beforeRows[0] : null
    if (!before) return res.status(404).json({ message: 'not_found' })
    const row = await pgUpdate('invoice_customers', id, { status: 'archived', updated_by: actor, updated_at: nowIso() } as any)
    addAudit('InvoiceCustomer', id, 'delete', before, row, actor, { ip: req.ip, user_agent: req.headers['user-agent'] })
    return res.json({ ok: true })
  } catch (e: any) {
    return res.status(400).json({ message: e?.message || 'delete_failed' })
  }
})
 
const LineItemSchema = z.object({
  description: z.string().trim().min(1).max(500),
  quantity: z.number().nonnegative(),
  unit_price: z.number(),
  gst_type: z.enum(['GST_10','GST_INCLUDED_10','GST_FREE','INPUT_TAXED']).default('GST_10'),
  sort_order: z.number().int().optional(),
})
 
const InvoiceCreateSchema = z.object({
  company_id: z.string().min(1),
  invoice_type: z.enum(['quote','invoice','receipt']).optional(),
  currency: z.string().trim().min(1).max(10).optional(),
  customer_id: z.string().trim().max(80).optional(),
  bill_to_name: z.string().trim().min(1).max(200).optional(),
  bill_to_email: z.string().trim().max(200).optional(),
  bill_to_phone: z.string().trim().max(50).optional(),
  bill_to_abn: z.string().trim().max(50).optional(),
  bill_to_address: z.string().trim().max(500).optional(),
  notes: z.string().trim().max(2000).optional(),
  terms: z.string().trim().max(2000).optional(),
  payment_method: z.string().trim().max(50).optional(),
  payment_method_note: z.string().trim().max(200).optional(),
  issue_date: z.string().trim().optional(),
  due_date: z.string().trim().optional(),
  valid_until: z.string().trim().optional(),
  paid_at: z.string().trim().optional(),
  amount_paid: z.number().optional(),
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
    const roleName = String(user?.role || '')
    const canSwitchType = await roleHasPermAsync(roleName, 'invoice.type.switch')
    const invoiceType = canSwitchType ? normalizeInvoiceType(v.invoice_type) : 'invoice'
    const invoiceId = uuid()
    const lines = v.line_items.map((x, idx) => {
      const gstType: GstType = (invoiceType === 'invoice' ? (x.gst_type as GstType) : 'GST_FREE')
      const computed = computeLine({ quantity: x.quantity, unit_price: x.unit_price, gst_type: gstType })
      return {
        id: uuid(),
        invoice_id: invoiceId,
        description: x.description,
        quantity: x.quantity,
        unit_price: x.unit_price,
        gst_type: gstType,
        tax_amount: computed.tax_amount,
        line_subtotal: computed.line_subtotal,
        line_total: computed.line_total,
        sort_order: x.sort_order ?? idx,
      }
    })
    const amountPaid = invoiceType === 'receipt' ? Number(v.amount_paid || 0) : 0
    const totals = computeTotals(lines as any, amountPaid)
    const primary = (v.sources && v.sources[0]) ? v.sources[0] : null
    const issueDate = toDateOnly(v.issue_date)
    const dueDate = toDateOnly(v.due_date)
    const paidAt = toDateOnly(v.paid_at)
    const validUntilInput = toDateOnly(v.valid_until)
    const baseDate = issueDate || new Date().toISOString().slice(0, 10)
    const validUntil = invoiceType === 'quote' ? (validUntilInput || addDays(baseDate, 30)) : validUntilInput
    const invoicePayload: any = {
      id: invoiceId,
      company_id: v.company_id,
      invoice_type: invoiceType,
      currency: v.currency || 'AUD',
      status: 'draft',
      customer_id: v.customer_id || null,
      bill_to_name: v.bill_to_name || null,
      bill_to_email: v.bill_to_email || null,
      bill_to_phone: v.bill_to_phone || null,
      bill_to_abn: v.bill_to_abn || null,
      bill_to_address: v.bill_to_address || null,
      notes: v.notes || null,
      terms: v.terms || null,
      payment_method: v.payment_method || null,
      payment_method_note: v.payment_method_note || null,
      issue_date: issueDate,
      due_date: dueDate,
      valid_until: validUntil,
      paid_at: paidAt ? `${paidAt}T00:00:00Z` : null,
      primary_source_type: primary ? primary.source_type : null,
      primary_source_id: primary ? primary.source_id : null,
      created_by: createdBy,
      updated_by: createdBy,
      created_at: nowIso(),
      updated_at: nowIso(),
      ...totals,
    }
    const bizKey = computeBizUniqueKey({ ...invoicePayload, issue_date: issueDate, total: totals.total, line_items: lines })
    const dup = await pgPool!.query('SELECT id FROM invoices WHERE biz_unique_key=$1 LIMIT 1', [bizKey])
    if (dup?.rowCount) return res.status(409).json({ message: 'duplicate_invoice' })
    invoicePayload.biz_unique_key = bizKey
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
    if (isPgUniqueViolation(e)) return res.status(409).json({ message: 'duplicate_invoice' })
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
  company_id: z.string().trim().min(1).max(80).optional(),
  invoice_type: z.enum(['quote','invoice','receipt']).optional(),
  currency: z.string().trim().min(1).max(10).optional(),
  customer_id: z.string().trim().max(80).optional(),
  bill_to_name: z.string().trim().min(1).max(200).optional(),
  bill_to_email: z.string().trim().max(200).optional(),
  bill_to_phone: z.string().trim().max(50).optional(),
  bill_to_abn: z.string().trim().max(50).optional(),
  bill_to_address: z.string().trim().max(500).optional(),
  notes: z.string().trim().max(2000).optional(),
  terms: z.string().trim().max(2000).optional(),
  payment_method: z.string().trim().max(50).optional(),
  payment_method_note: z.string().trim().max(200).optional(),
  issue_date: z.string().trim().optional(),
  due_date: z.string().trim().optional(),
  valid_until: z.string().trim().optional(),
  paid_at: z.string().trim().optional(),
  amount_paid: z.number().optional(),
  line_items: z.array(LineItemSchema).min(1).optional(),
})
 
router.patch('/:id', requireAnyPerm(['invoice.draft.create','invoice.issue']), async (req, res) => {
  try {
    await ensureInvoiceTables()
    const { id } = req.params
    const user = (req as any).user || {}
    const actor = user?.sub || user?.username || null
    const roleName = String(user?.role || '')
    const v = InvoicePatchSchema.parse(req.body || {})
    const updated = await pgRunInTransaction(async (client) => {
      const rs = await client.query('SELECT * FROM invoices WHERE id=$1 FOR UPDATE', [id])
      const before = rs?.rows?.[0]
      if (!before) return null

      const canSwitchType = await roleHasPermAsync(roleName, 'invoice.type.switch')
      const beforeType = normalizeInvoiceType(before.invoice_type)
      const nextType = (canSwitchType && v.invoice_type !== undefined) ? normalizeInvoiceType(v.invoice_type) : beforeType

      const nextCompanyId = v.company_id !== undefined ? String(v.company_id || '').trim() : String(before.company_id || '').trim()
      const nextCurrency = v.currency !== undefined ? String(v.currency || 'AUD').trim() : String(before.currency || 'AUD').trim()

      const nextIssueDate = v.issue_date !== undefined ? toDateOnly(v.issue_date) : toDateOnly(before.issue_date)
      const nextDueDate = v.due_date !== undefined ? toDateOnly(v.due_date) : toDateOnly(before.due_date)
      const nextValidUntilInput = v.valid_until !== undefined ? toDateOnly(v.valid_until) : toDateOnly(before.valid_until)
      const baseDate = nextIssueDate || new Date().toISOString().slice(0, 10)
      const nextValidUntil = nextType === 'quote' ? (nextValidUntilInput || addDays(baseDate, 30)) : nextValidUntilInput

      const nextPaidAtDateOnly = v.paid_at !== undefined ? toDateOnly(v.paid_at) : toDateOnly(before.paid_at)
      const nextPaidAt = nextPaidAtDateOnly ? `${nextPaidAtDateOnly}T00:00:00Z` : null

      const nextAmountPaid = v.amount_paid !== undefined ? round2(Number(v.amount_paid || 0)) : round2(Number(before.amount_paid || 0))

      const toNullIfBlank = (x: any) => {
        if (x === undefined) return undefined
        const s = String(x || '').trim()
        return s ? s : null
      }

      let nextLines: any[] = []
      if (Array.isArray(v.line_items)) {
        nextLines = v.line_items.map((x, idx) => {
          const gstType: GstType = (nextType === 'invoice' ? (x.gst_type as GstType) : 'GST_FREE')
          const computed = computeLine({ quantity: x.quantity, unit_price: x.unit_price, gst_type: gstType })
          return {
            id: uuid(),
            invoice_id: id,
            description: x.description,
            quantity: x.quantity,
            unit_price: x.unit_price,
            gst_type: gstType,
            tax_amount: computed.tax_amount,
            line_subtotal: computed.line_subtotal,
            line_total: computed.line_total,
            sort_order: x.sort_order ?? idx,
          }
        })
        await client.query('DELETE FROM invoice_line_items WHERE invoice_id=$1', [id])
        for (const li of nextLines) await pgInsert('invoice_line_items', li as any, client)
      } else {
        const rsLines = await client.query('SELECT * FROM invoice_line_items WHERE invoice_id=$1 ORDER BY sort_order ASC', [id])
        const existing = rsLines?.rows || []
        nextLines = existing.map((x: any, idx: number) => {
          const gstType: GstType = (nextType === 'invoice' ? (x.gst_type as GstType) : 'GST_FREE')
          const computed = computeLine({ quantity: x.quantity, unit_price: x.unit_price, gst_type: gstType })
          return {
            id: String(x.id || uuid()),
            invoice_id: id,
            description: String(x.description || ''),
            quantity: Number(x.quantity || 0),
            unit_price: Number(x.unit_price || 0),
            gst_type: gstType,
            tax_amount: computed.tax_amount,
            line_subtotal: computed.line_subtotal,
            line_total: computed.line_total,
            sort_order: Number(x.sort_order ?? idx),
          }
        })
        if (nextType !== beforeType) {
          await client.query('DELETE FROM invoice_line_items WHERE invoice_id=$1', [id])
          for (const li of nextLines) {
            await pgInsert('invoice_line_items', { ...li, id: uuid() } as any, client)
          }
          nextLines = (await client.query('SELECT * FROM invoice_line_items WHERE invoice_id=$1 ORDER BY sort_order ASC', [id]))?.rows || nextLines
        }
      }

      const totals = computeTotals(nextLines as any, nextAmountPaid)
      const bizKey = computeBizUniqueKey({
        company_id: nextCompanyId,
        invoice_type: nextType,
        issue_date: nextIssueDate,
        currency: nextCurrency,
        total: totals.total,
        bill_to_name: v.bill_to_name !== undefined ? v.bill_to_name : before.bill_to_name,
        bill_to_email: v.bill_to_email !== undefined ? v.bill_to_email : before.bill_to_email,
        primary_source_type: before.primary_source_type,
        primary_source_id: before.primary_source_id,
        line_items: nextLines,
      })
      const dup = await client.query('SELECT id FROM invoices WHERE biz_unique_key=$1 AND id<>$2 LIMIT 1', [bizKey, id])
      if (dup?.rowCount) throw new Error('duplicate_invoice')

      const nextRow = await pgUpdate('invoices', id, {
        company_id: nextCompanyId || undefined,
        invoice_type: nextType,
        currency: nextCurrency,
        customer_id: v.customer_id !== undefined ? toNullIfBlank(v.customer_id) : before.customer_id,
        bill_to_name: v.bill_to_name !== undefined ? toNullIfBlank(v.bill_to_name) : before.bill_to_name,
        bill_to_email: v.bill_to_email !== undefined ? toNullIfBlank(v.bill_to_email) : before.bill_to_email,
        bill_to_phone: v.bill_to_phone !== undefined ? toNullIfBlank(v.bill_to_phone) : before.bill_to_phone,
        bill_to_abn: v.bill_to_abn !== undefined ? toNullIfBlank(v.bill_to_abn) : before.bill_to_abn,
        bill_to_address: v.bill_to_address !== undefined ? toNullIfBlank(v.bill_to_address) : before.bill_to_address,
        notes: v.notes !== undefined ? toNullIfBlank(v.notes) : before.notes,
        terms: v.terms !== undefined ? toNullIfBlank(v.terms) : before.terms,
        payment_method: v.payment_method !== undefined ? toNullIfBlank(v.payment_method) : before.payment_method,
        payment_method_note: v.payment_method_note !== undefined ? toNullIfBlank(v.payment_method_note) : before.payment_method_note,
        issue_date: nextIssueDate,
        due_date: nextDueDate,
        valid_until: nextValidUntil,
        paid_at: nextPaidAt,
        amount_paid: nextAmountPaid,
        amount_due: totals.amount_due,
        subtotal: totals.subtotal,
        tax_total: totals.tax_total,
        total: totals.total,
        biz_unique_key: bizKey,
        updated_by: actor,
        updated_at: nowIso(),
      } as any, client)
      addAudit('Invoice', id, 'update', before, nextRow, actor, { ip: req.ip, user_agent: req.headers['user-agent'] })
      return nextRow
    })
    if (!updated) return res.status(404).json({ message: 'not_found' })
    return res.json(updated)
  } catch (e: any) {
    if (String(e?.message || '') === 'duplicate_invoice') return res.status(409).json({ message: 'duplicate_invoice' })
    if (isPgUniqueViolation(e)) return res.status(409).json({ message: 'duplicate_invoice' })
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
      const invType = normalizeInvoiceType(inv.invoice_type)
      const invoiceNo = inv.invoice_no ? String(inv.invoice_no) : await nextInvoiceNoByType(String(inv.company_id), invType, issueDate, client)
      const nextStatus = invType === 'receipt' ? 'paid' : 'issued'
      const shouldMarkPaid = invType === 'receipt'
      const lines = (await client.query('SELECT * FROM invoice_line_items WHERE invoice_id=$1 ORDER BY sort_order ASC', [id]))?.rows || []
      const bizKey = computeBizUniqueKey({
        company_id: inv.company_id,
        invoice_type: invType,
        issue_date: issueDate,
        currency: inv.currency,
        total: inv.total,
        bill_to_name: inv.bill_to_name,
        bill_to_email: inv.bill_to_email,
        primary_source_type: inv.primary_source_type,
        primary_source_id: inv.primary_source_id,
        line_items: lines,
      })
      const dup = await client.query('SELECT id FROM invoices WHERE biz_unique_key=$1 AND id<>$2 LIMIT 1', [bizKey, id])
      if (dup?.rowCount) throw new Error('duplicate_invoice')
      const upd = await client.query(
        `UPDATE invoices
         SET status=$1, invoice_no=$2, issue_date=to_date($3,'YYYY-MM-DD'), issued_at=now(),
             biz_unique_key=$4,
             paid_at=CASE WHEN $5::boolean THEN COALESCE(paid_at, now()) ELSE paid_at END,
             amount_paid=CASE WHEN $5::boolean THEN COALESCE(total,0) ELSE amount_paid END,
             amount_due=CASE WHEN $5::boolean THEN 0 ELSE amount_due END,
             updated_by=$6, updated_at=now()
         WHERE id=$7 RETURNING *`,
        [nextStatus, invoiceNo, issueDate, bizKey, shouldMarkPaid, actor, id]
      )
      return upd?.rows?.[0]
    })
    addAudit('Invoice', id, 'issue', null, result, actor, { ip: req.ip, user_agent: req.headers['user-agent'] })
    return res.json(result)
  } catch (e: any) {
    const msg = String(e?.message || '')
    if (msg === 'not_found') return res.status(404).json({ message: 'not_found' })
    if (msg === 'duplicate_invoice') return res.status(409).json({ message: 'duplicate_invoice' })
    if (isPgUniqueViolation(e)) return res.status(409).json({ message: 'duplicate_invoice' })
    return res.status(400).json({ message: e?.message || 'issue_failed' })
  }
})
 
router.delete('/:id', requireAnyPerm(['invoice.draft.create','invoice.issue']), async (req, res) => {
  try {
    await ensureInvoiceTables()
    const { id } = req.params
    const user = (req as any).user || {}
    const actor = user?.sub || user?.username || null
    const beforeRows = await pgSelect('invoices', '*', { id })
    const before = Array.isArray(beforeRows) ? beforeRows[0] : null
    if (!before) return res.status(404).json({ message: 'not_found' })
    const status = String(before.status || 'draft')
    if (status !== 'draft') return res.status(400).json({ message: 'only_draft_can_delete' })
    const deleted = await pgDelete('invoices', id)
    addAudit('Invoice', id, 'delete', before, deleted, actor, { ip: req.ip, user_agent: req.headers['user-agent'] })
    return res.json({ ok: true })
  } catch (e: any) {
    if (isPgUniqueViolation(e)) return res.status(409).json({ message: 'duplicate_invoice' })
    return res.status(400).json({ message: e?.message || 'delete_failed' })
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
    if (status === 'refunded') return res.status(400).json({ message: 'cannot_void_refunded' })
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

router.get('/:id/payment-history', requirePerm('invoice.view'), async (req, res) => {
  try {
    await ensureInvoiceTables()
    const { id } = req.params
    const rows = await pgPool!.query('SELECT * FROM invoice_payment_events WHERE invoice_id=$1 ORDER BY created_at DESC LIMIT 100', [id])
    return res.json(rows?.rows || [])
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'list_failed' })
  }
})

router.post('/:id/mark-paid', requireAnyPerm(['invoice.payment.record','invoice.draft.create','invoice.issue']), async (req, res) => {
  try {
    await ensureInvoiceTables()
    const { id } = req.params
    const user = (req as any).user || {}
    const actor = user?.sub || user?.username || null
    const method = String((req.body || {}).payment_method || '').trim() || null
    const methodNote = String((req.body || {}).payment_method_note || '').trim() || null
    if (!method) return res.status(400).json({ message: 'missing_payment_method' })
    const beforeRows = await pgSelect('invoices', '*', { id })
    const before = Array.isArray(beforeRows) ? beforeRows[0] : null
    if (!before) return res.status(404).json({ message: 'not_found' })
    const status = String(before.status || '')
    if (status === 'void') return res.status(400).json({ message: 'cannot_pay_void' })
    if (status === 'refunded') return res.status(400).json({ message: 'cannot_pay_refunded' })

    const row = await pgRunInTransaction(async (client) => {
      const rs = await client.query('SELECT * FROM invoices WHERE id=$1 FOR UPDATE', [id])
      const inv = rs?.rows?.[0]
      if (!inv) throw new Error('not_found')
      const st = String(inv.status || '')
      if (st === 'void') throw new Error('cannot_pay_void')
      if (st === 'refunded') throw new Error('cannot_pay_refunded')
      const issueDate = toDateOnly(inv.issue_date) || new Date().toISOString().slice(0, 10)
      const invType = normalizeInvoiceType(inv.invoice_type)
      const invoiceNo = inv.invoice_no ? String(inv.invoice_no) : await nextInvoiceNoByType(String(inv.company_id), invType, issueDate, client)
      const linesRs = await client.query('SELECT * FROM invoice_line_items WHERE invoice_id=$1 ORDER BY sort_order ASC', [id])
      const lines = Array.isArray(linesRs?.rows) ? linesRs.rows : []
      const baseTotals = computeTotals(lines as any, 0)
      const totals = computeTotals(lines as any, Number(baseTotals.total || 0))
      const upd = await client.query(
        `UPDATE invoices
         SET invoice_no=$1,
             issue_date=COALESCE(issue_date, to_date($2,'YYYY-MM-DD')),
             issued_at=COALESCE(issued_at, now()),
             status='paid',
             paid_at=now(),
             payment_method=$3,
             payment_method_note=$4,
             subtotal=$5,
             tax_total=$6,
             total=$7,
             amount_paid=$8,
             amount_due=$9,
             updated_by=$10,
             updated_at=now()
         WHERE id=$11 RETURNING *`,
        [invoiceNo, issueDate, method, methodNote, totals.subtotal, totals.tax_total, totals.total, totals.amount_paid, totals.amount_due, actor, id]
      )
      return upd?.rows?.[0]
    })
    try {
      await pgInsert('invoice_payment_events', { id: uuid(), invoice_id: id, status: 'paid', payment_method: method, payment_method_note: methodNote, created_by: actor, created_at: nowIso() } as any)
    } catch {}
    addAudit('Invoice', id, 'mark_paid', before, row, actor, { ip: req.ip, user_agent: req.headers['user-agent'] })
    return res.json(row)
  } catch (e: any) {
    const msg = String(e?.message || '')
    if (msg === 'not_found') return res.status(404).json({ message: 'not_found' })
    if (msg === 'cannot_pay_void') return res.status(400).json({ message: 'cannot_pay_void' })
    if (msg === 'cannot_pay_refunded') return res.status(400).json({ message: 'cannot_pay_refunded' })
    return res.status(400).json({ message: e?.message || 'mark_paid_failed' })
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
    const method = String((req.body || {}).payment_method || '').trim() || null
    const methodNote = String((req.body || {}).payment_method_note || '').trim() || null
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
    const row = await pgUpdate('invoices', id, { ...totals, status: newStatus, paid_at: newStatus === 'paid' ? paidAtTs : null, payment_method: method, payment_method_note: methodNote, updated_by: actor, updated_at: nowIso() } as any)
    try {
      await pgInsert('invoice_payment_events', { id: uuid(), invoice_id: id, status: newStatus, payment_method: method, payment_method_note: methodNote, created_by: actor, created_at: nowIso() } as any)
    } catch {}
    addAudit('Invoice', id, 'record_payment', before, { ...row, payment: { amount, paid_at: paidAt, payment_method: method, payment_method_note: methodNote } }, actor, { ip: req.ip, user_agent: req.headers['user-agent'] })
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
        const bizKey = computeBizUniqueKey({ company_id: payload.company_id, invoice_type: 'invoice', currency: payload.currency, total: totals.total, primary_source_type: primary.source_type, primary_source_id: primary.source_id, line_items: lines })
        const dup = await pgPool!.query('SELECT id FROM invoices WHERE biz_unique_key=$1 LIMIT 1', [bizKey])
        if (dup?.rowCount) throw new Error('duplicate_invoice')
        const row = await pgInsert('invoices', { id: invoiceId, company_id: payload.company_id, invoice_type: 'invoice', currency: payload.currency, status: 'draft', biz_unique_key: bizKey, primary_source_type: primary.source_type, primary_source_id: primary.source_id, created_by: actor, updated_by: actor, created_at: nowIso(), updated_at: nowIso(), ...totals } as any)
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
      const bizKey = computeBizUniqueKey({ company_id: payload.company_id, invoice_type: 'invoice', currency: payload.currency, total: totals.total, bill_to_name: payload.bill_to_name, bill_to_email: payload.bill_to_email, primary_source_type: s.source_type, primary_source_id: s.source_id, line_items: lines })
      const dup = await pgPool!.query('SELECT id FROM invoices WHERE biz_unique_key=$1 LIMIT 1', [bizKey])
      if (dup?.rowCount) throw new Error('duplicate_invoice')
      const row = await pgInsert('invoices', { id: invoiceId, company_id: payload.company_id, invoice_type: 'invoice', currency: payload.currency, status: 'draft', biz_unique_key: bizKey, bill_to_name: payload.bill_to_name, bill_to_email: payload.bill_to_email, bill_to_address: payload.bill_to_address, primary_source_type: s.source_type, primary_source_id: s.source_id, created_by: actor, updated_by: actor, created_at: nowIso(), updated_at: nowIso(), ...totals } as any)
      for (const li of lines) await pgInsert('invoice_line_items', li as any)
      await pgPool!.query('INSERT INTO invoice_sources (invoice_id, source_type, source_id, label) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [invoiceId, s.source_type, s.source_id, d.label || null])
      addAudit('Invoice', invoiceId, 'create', null, { ...row, line_items: lines, sources: [s] }, actor, { ip: req.ip, user_agent: req.headers['user-agent'] })
      outputs.push({ ...row, line_items: lines, sources: [s] })
    }
    return res.status(201).json({ mode: 'per_item', invoices: outputs })
  } catch (e: any) {
    if (String(e?.message || '') === 'duplicate_invoice') return res.status(409).json({ message: 'duplicate_invoice' })
    if (isPgUniqueViolation(e)) return res.status(409).json({ message: 'duplicate_invoice' })
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
 
