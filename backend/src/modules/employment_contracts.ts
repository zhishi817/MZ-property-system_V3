import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { z } from 'zod'
import { requireAnyPerm } from '../auth'
import { hasPg, pgPool } from '../dbAdapter'
import { addAudit } from '../store'
import { generateEmploymentContractPdf } from '../lib/employmentContractPdf'

export const router = Router()

const VIEW_PERMS = ['employment_contracts.view', 'employment_contracts.create', 'employment_contracts.write']
const WRITE_PERMS = ['employment_contracts.create', 'employment_contracts.write']
const DELETE_PERMS = ['employment_contracts.delete']
const STATUSES = ['draft', 'generated', 'archived'] as const

const fieldsSchema = z.object({
  employer_name: z.string().trim().min(1),
  employer_credit_code: z.string().trim().optional().default(''),
  legal_representative: z.string().trim().optional().default(''),
  employer_address: z.string().trim().optional().default(''),
  employee_name: z.string().trim().min(1),
  employee_id_no: z.string().trim().optional().default(''),
  employee_phone: z.string().trim().optional().default(''),
  employee_address: z.string().trim().optional().default(''),
  contract_term_type: z.enum(['open_ended', 'fixed_term']).default('open_ended'),
  effective_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('')).default(''),
  probation_months: z.coerce.number().int().min(0).max(6).default(1),
  job_title_cn: z.string().trim().min(1),
  job_title_en: z.string().trim().min(1),
  job_duties_cn: z.string().trim().min(1),
  job_duties_en: z.string().trim().min(1),
  work_location_cn: z.string().trim().min(1),
  work_location_en: z.string().trim().min(1),
  work_timezone: z.string().trim().min(1),
  core_hours_start: z.string().regex(/^\d{2}:\d{2}$/),
  core_hours_end: z.string().regex(/^\d{2}:\d{2}$/),
  flexible_hours_start: z.string().regex(/^\d{2}:\d{2}$/).default('16:00'),
  flexible_hours_end: z.string().regex(/^\d{2}:\d{2}$/).default('21:00'),
  rest_days_cn: z.string().trim().min(1).default('周日、周一'),
  rest_days_en: z.string().trim().min(1).default('Sunday and Monday'),
  monthly_salary: z.coerce.number().positive(),
  payday: z.coerce.number().int().min(1).max(31),
  payment_method_cn: z.string().trim().min(1),
  payment_method_en: z.string().trim().min(1),
  social_insurance_mode: z.enum(['standard', 'pending']),
  social_insurance_city: z.string().trim().min(1),
  contribution_base_note: z.string().trim().optional().default(''),
  termination_notice_days: z.coerce.number().int().min(0).max(180).default(60),
  employer_authorized_representative: z.string().trim().optional().default(''),
  employer_sign_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('')).default(''),
  employee_sign_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('')).default(''),
}).superRefine((fields, ctx) => {
  if (fields.contract_term_type === 'fixed_term' && !fields.end_date) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['end_date'], message: '固定期限合同必须填写结束日期' })
  }
  if (fields.contract_term_type === 'fixed_term' && fields.end_date && fields.end_date < fields.effective_date) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['end_date'], message: '结束日期不能早于生效日期' })
  }
})

const createSchema = z.object({
  fields: fieldsSchema,
  notes: z.string().trim().max(2000).optional().nullable(),
})

const patchSchema = z.object({
  fields: fieldsSchema.optional(),
  notes: z.string().trim().max(2000).optional().nullable(),
  status: z.enum(STATUSES).optional(),
})

async function ensureEmploymentContractsTable() {
  if (!pgPool) return
  await pgPool.query(`CREATE TABLE IF NOT EXISTS employment_contracts (
    id text PRIMARY KEY,
    contract_no text NOT NULL UNIQUE,
    status text NOT NULL DEFAULT 'draft',
    fields jsonb NOT NULL DEFAULT '{}'::jsonb,
    notes text,
    last_generated_at timestamptz,
    created_by text,
    updated_by text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );`)
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_employment_contracts_status_updated ON employment_contracts(status, updated_at DESC);')
  await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_employment_contracts_employee_name
    ON employment_contracts ((fields->>'employee_name'));`)
}

function actorOf(req: any) {
  const user = req?.user || {}
  return String(user.sub || user.username || '').trim() || null
}

function nextContractNo() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase()
  return `LC-${date}-${suffix}`
}

async function loadContract(id: string) {
  await ensureEmploymentContractsTable()
  const result = await pgPool!.query('SELECT * FROM employment_contracts WHERE id=$1 LIMIT 1', [id])
  return result.rows?.[0] || null
}

router.get('/', requireAnyPerm(VIEW_PERMS), async (req, res) => {
  try {
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    await ensureEmploymentContractsTable()
    const query = req.query || {}
    const values: any[] = []
    const where: string[] = []
    const status = String(query.status || '').trim()
    const socialInsuranceMode = String(query.social_insurance_mode || '').trim()
    const keyword = String(query.q || '').trim()

    if (status) {
      if (!STATUSES.includes(status as any)) return res.status(400).json({ message: 'invalid status' })
      values.push(status)
      where.push(`status=$${values.length}`)
    } else if (String(query.include_archived || '').toLowerCase() !== 'true') {
      where.push(`status <> 'archived'`)
    }
    if (socialInsuranceMode) {
      if (!['standard', 'pending'].includes(socialInsuranceMode)) return res.status(400).json({ message: 'invalid social_insurance_mode' })
      values.push(socialInsuranceMode)
      where.push(`fields->>'social_insurance_mode'=$${values.length}`)
    }
    if (keyword) {
      values.push(`%${keyword}%`)
      const index = values.length
      where.push(`(contract_no ILIKE $${index} OR fields->>'employee_name' ILIKE $${index} OR fields->>'employer_name' ILIKE $${index})`)
    }

    const result = await pgPool.query(
      `SELECT * FROM employment_contracts
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY updated_at DESC, created_at DESC`,
      values,
    )
    return res.json(result.rows || [])
  } catch (error: any) {
    return res.status(500).json({ message: error?.message || 'list failed' })
  }
})

router.get('/:id', requireAnyPerm(VIEW_PERMS), async (req, res) => {
  try {
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    const row = await loadContract(String(req.params.id || '').trim())
    if (!row) return res.status(404).json({ message: 'not found' })
    return res.json(row)
  } catch (error: any) {
    return res.status(500).json({ message: error?.message || 'get failed' })
  }
})

router.post('/', requireAnyPerm(WRITE_PERMS), async (req, res) => {
  try {
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    await ensureEmploymentContractsTable()
    const parsed = createSchema.safeParse(req.body || {})
    if (!parsed.success) return res.status(400).json(parsed.error.format())
    const actor = actorOf(req)
    const id = uuidv4()
    const result = await pgPool.query(
      `INSERT INTO employment_contracts(id, contract_no, status, fields, notes, created_by, updated_by, created_at, updated_at)
       VALUES($1,$2,'draft',$3::jsonb,$4,$5,$5,now(),now())
       RETURNING *`,
      [id, nextContractNo(), JSON.stringify(parsed.data.fields), parsed.data.notes || null, actor],
    )
    const row = result.rows?.[0] || null
    addAudit('EmploymentContract', id, 'create', null, row, actor || undefined)
    return res.status(201).json(row)
  } catch (error: any) {
    return res.status(500).json({ message: error?.message || 'create failed' })
  }
})

router.patch('/:id', requireAnyPerm(WRITE_PERMS), async (req, res) => {
  try {
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    await ensureEmploymentContractsTable()
    const id = String(req.params.id || '').trim()
    const parsed = patchSchema.safeParse(req.body || {})
    if (!parsed.success) return res.status(400).json(parsed.error.format())
    const before = await loadContract(id)
    if (!before) return res.status(404).json({ message: 'not found' })
    const actor = actorOf(req)
    const keys: string[] = []
    const values: any[] = []
    const add = (key: string, value: any) => {
      keys.push(key)
      values.push(value)
    }
    if (parsed.data.fields !== undefined) add('fields', JSON.stringify(parsed.data.fields))
    if (parsed.data.notes !== undefined) add('notes', parsed.data.notes || null)
    if (parsed.data.status !== undefined) add('status', parsed.data.status)
    add('updated_by', actor)
    add('updated_at', new Date().toISOString())
    const setClause = keys.map((key, index) => `"${key}"=$${index + 1}${key === 'fields' ? '::jsonb' : ''}`).join(', ')
    const result = await pgPool.query(
      `UPDATE employment_contracts SET ${setClause} WHERE id=$${keys.length + 1} RETURNING *`,
      [...values, id],
    )
    const row = result.rows?.[0] || null
    addAudit('EmploymentContract', id, 'update', before, row, actor || undefined)
    return res.json(row)
  } catch (error: any) {
    return res.status(500).json({ message: error?.message || 'update failed' })
  }
})

router.post('/:id/generate-pdf', requireAnyPerm(WRITE_PERMS), async (req, res) => {
  try {
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    const id = String(req.params.id || '').trim()
    const before = await loadContract(id)
    if (!before) return res.status(404).json({ message: 'not found' })
    const generatedAt = new Date()
    const result = await generateEmploymentContractPdf({
      contractNo: String(before.contract_no || id),
      fields: before.fields || {},
      generatedAt,
    })
    const updatedResult = await pgPool.query(
      `UPDATE employment_contracts
       SET status='generated', last_generated_at=$1, updated_by=$2, updated_at=$1
       WHERE id=$3
       RETURNING *`,
      [generatedAt.toISOString(), actorOf(req), id],
    )
    const updated = updatedResult.rows?.[0] || before
    addAudit('EmploymentContract', id, 'generate_pdf', before, updated, actorOf(req) || undefined)
    const encodedName = encodeURIComponent(result.filename)
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"; filename*=UTF-8''${encodedName}`)
    return res.status(200).send(result.pdf)
  } catch (error: any) {
    return res.status(500).json({ message: error?.message || 'generate pdf failed' })
  }
})

router.delete('/:id', requireAnyPerm(DELETE_PERMS), async (req, res) => {
  try {
    if (!hasPg || !pgPool) return res.status(500).json({ message: 'no database configured' })
    await ensureEmploymentContractsTable()
    const id = String(req.params.id || '').trim()
    const before = await loadContract(id)
    if (!before) return res.status(404).json({ message: 'not found' })
    await pgPool.query('DELETE FROM employment_contracts WHERE id=$1', [id])
    addAudit('EmploymentContract', id, 'delete', before, null, actorOf(req) || undefined)
    return res.json({ ok: true })
  } catch (error: any) {
    return res.status(500).json({ message: error?.message || 'delete failed' })
  }
})
