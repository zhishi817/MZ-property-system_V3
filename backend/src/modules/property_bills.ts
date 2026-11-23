import { Router } from 'express'
import { z } from 'zod'
import { requireAnyPerm, requirePerm, userHasAnyPerm } from '../auth'
import { pgPool, pgRunInTransaction } from '../dbAdapter'
import { addAudit } from '../store'
import { deleteUnusedPropertyPayableTemplateTx, resumePropertyPayableTemplateTx, stopPropertyPayableTemplateTx, updatePropertyPayableTemplateDisplayNameTx } from '../lib/propertyPayableTemplateSafety'

export const propertyBillsRouter = Router()
export const PROPERTY_BILL_CATEGORIES = ['water', 'electricity', 'gas_hot_water', 'internet', 'council_rate', 'owners_corp', 'other'] as const
type Category = typeof PROPERTY_BILL_CATEGORIES[number]
type Status = 'owner' | 'company' | 'pending' | 'not_applicable'
type PropertyBillTemplate = {
  template_id: string
  template_status: string
  property_id: string
  category: Category
  vendor?: string
  category_detail?: string
  other_bill_name?: string
  amount?: number
  account_number?: string
  cycle_months?: number
  due_day_of_month?: number
  bill_expected_day_of_month?: number
  bill_period_start_day_of_month?: number
  bill_period_start_month_offset?: number
  bill_period_end_day_of_month?: number
  bill_period_end_month_offset?: number
  remind_days_before?: number
  payment_type?: string
  pay_account_name?: string
  pay_bsb?: string
  pay_account_number?: string
  pay_ref?: string
  bpay_code?: string
  pay_mobile_number?: string
  start_month_key?: string
  note?: string
}
type Bill = {
  status: Status
  source: 'configured' | 'template'
  template_count?: number
  active_template_count?: number
  templates?: PropertyBillTemplate[]
}
type OtherBillListItem = {
  source: 'configured' | 'template'
  status: Status
  name?: string
  template_status?: string
}

const categorySchema = z.enum(PROPERTY_BILL_CATEGORIES)
const propertyIdSchema = z.string().trim().min(1).max(200)
const saveSchema = z.object({
  status: z.enum(['owner', 'company', 'pending', 'not_applicable']),
}).strict()
const searchSchema = z.object({ query: z.string().trim().max(200).default('') }).strict()
const displayNameSchema = z.object({ name: z.string().trim().min(1).max(80) }).strict()
const menu = requirePerm('menu.finance.property_payables.visible')
const readPerm = requireAnyPerm(['recurring_payments.view', 'finance.tx.write'])
const writeCodes = ['recurring_payments.write', 'finance.tx.write']
const writePerm = requireAnyPerm(writeCodes)

function optionalText(value: any) {
  const text = String(value || '').trim()
  return text || undefined
}

function optionalNumber(value: any, min: number, max: number) {
  const number = Number(value)
  return Number.isFinite(number) && number >= min && number <= max ? number : undefined
}

function normalizeTemplate(template: any, category: Category): PropertyBillTemplate {
  return {
    template_id: String(template.template_id),
    template_status: optionalText(template.template_status) || 'active',
    property_id: String(template.property_id),
    category,
    ...(optionalText(template.vendor) ? {vendor: optionalText(template.vendor)} : {}),
    ...(optionalText(template.category_detail) ? {category_detail: optionalText(template.category_detail)} : {}),
    ...(optionalText(template.other_bill_name) ? {other_bill_name: optionalText(template.other_bill_name)} : {}),
    ...(optionalNumber(template.amount, 0, Number.MAX_SAFE_INTEGER) != null ? {amount: Number(template.amount)} : {}),
    ...(optionalText(template.bill_account_no) ? {account_number: optionalText(template.bill_account_no)} : {}),
    ...(optionalNumber(template.frequency_months, 1, 24) != null ? {cycle_months: Number(template.frequency_months)} : {}),
    ...(optionalNumber(template.due_day_of_month, 1, 31) != null ? {due_day_of_month: Number(template.due_day_of_month)} : {}),
    ...(optionalNumber(template.bill_expected_day_of_month, 1, 31) != null ? {bill_expected_day_of_month: Number(template.bill_expected_day_of_month)} : {}),
    ...(optionalNumber(template.bill_period_start_day_of_month, 1, 31) != null ? {bill_period_start_day_of_month: Number(template.bill_period_start_day_of_month)} : {}),
    ...(optionalNumber(template.bill_period_start_month_offset, -24, 24) != null ? {bill_period_start_month_offset: Number(template.bill_period_start_month_offset)} : {}),
    ...(optionalNumber(template.bill_period_end_day_of_month, 1, 31) != null ? {bill_period_end_day_of_month: Number(template.bill_period_end_day_of_month)} : {}),
    ...(optionalNumber(template.bill_period_end_month_offset, -24, 24) != null ? {bill_period_end_month_offset: Number(template.bill_period_end_month_offset)} : {}),
    ...(optionalNumber(template.remind_days_before, 0, 365) != null ? {remind_days_before: Number(template.remind_days_before)} : {}),
    ...(optionalText(template.payment_type) ? {payment_type: optionalText(template.payment_type)} : {}),
    ...(optionalText(template.pay_account_name) ? {pay_account_name: optionalText(template.pay_account_name)} : {}),
    ...(optionalText(template.pay_bsb) ? {pay_bsb: optionalText(template.pay_bsb)} : {}),
    ...(optionalText(template.pay_account_number) ? {pay_account_number: optionalText(template.pay_account_number)} : {}),
    ...(optionalText(template.pay_ref) ? {pay_ref: optionalText(template.pay_ref)} : {}),
    ...(optionalText(template.bpay_code) ? {bpay_code: optionalText(template.bpay_code)} : {}),
    ...(optionalText(template.pay_mobile_number) ? {pay_mobile_number: optionalText(template.pay_mobile_number)} : {}),
    ...(optionalText(template.start_month_key) ? {start_month_key: optionalText(template.start_month_key)} : {}),
    ...(optionalText(template.note) ? {note: optionalText(template.note)} : {}),
  }
}

// Keep every surviving property-payable template for the matching property and
// category. The directory never chooses one template as canonical or rewrites
// the original template relationship.
export function projectPropertyBills(properties: any[], configured: any[], templates: any[]) {
  const rows = properties.map((p) => ({
    id: String(p.id), code: p.code == null ? '' : String(p.code),
    address: p.address == null ? '' : String(p.address),
    region: p.region == null ? '' : String(p.region),
    bills: {} as Partial<Record<Category, Bill>>,
  }))
  const byId = new Map(rows.map((row) => [row.id, row.bills]))
  const templateOptions = new Map<string, Map<Category, any[]>>()
  for (const template of templates) {
    const id = String(template.property_id)
    const category = categorySchema.safeParse(template.category)
    if (!byId.has(id) || !category.success) continue
    const options = templateOptions.get(id) || new Map<Category, any[]>()
    options.set(category.data, [...(options.get(category.data) || []), template])
    templateOptions.set(id, options)
  }
  for (const [id, options] of templateOptions) {
    for (const [category, candidates] of options) {
      const normalized = candidates
        .map((template) => normalizeTemplate(template, category))
        .sort((a, b) => {
          const status = Number(b.template_status === 'active') - Number(a.template_status === 'active')
          if (status) return status
          const start = String(a.start_month_key || '').localeCompare(String(b.start_month_key || ''))
          if (start) return start
          return String(a.vendor || a.template_id).localeCompare(String(b.vendor || b.template_id))
        })
      const activeCount = normalized.filter((template) => template.template_status === 'active').length
      byId.get(id)![category] = {
        status: activeCount ? 'company' : 'pending',
        source: 'template',
        template_count: normalized.length,
        active_template_count: activeCount,
        templates: normalized,
      }
    }
  }
  for (const item of configured) {
    const bills = byId.get(String(item.property_id))
    const category = categorySchema.safeParse(item.category)
    const status = z.enum(['owner', 'company', 'pending', 'not_applicable']).safeParse(item.status)
    if (!bills || !category.success || !status.success) continue
    const template = bills[category.data]
    bills[category.data] = {
      source: 'configured',
      status: status.data,
      ...(template?.template_count ? {template_count: template.template_count} : {}),
      ...(template?.active_template_count ? {active_template_count: template.active_template_count} : {}),
      ...(template?.templates?.length ? {templates: template.templates} : {}),
    }
  }
  return rows
}

export function filterPropertyBillRows(rows: ReturnType<typeof projectPropertyBills>, rawQuery: string) {
  const query = String(rawQuery || '').trim().toLowerCase()
  if (!query) return rows
  return rows.filter((row) => {
    const searchable: any[] = [row.code, row.address]
    for (const bill of Object.values(row.bills) as Bill[]) {
      for (const template of bill.templates || []) {
        if (template.template_status === 'active') searchable.push(template.vendor, template.account_number)
      }
    }
    return searchable.some((value) => String(value || '').toLowerCase().includes(query))
  })
}

export function stripPropertyBillAccounts(rows: ReturnType<typeof projectPropertyBills>) {
  return rows.map((row) => {
    const bills: Record<string, Pick<Bill, 'status' | 'source' | 'template_count' | 'active_template_count'> & {
      other_items?: OtherBillListItem[]
      registration_status?: Status
    }> = {}
    for (const category of PROPERTY_BILL_CATEGORIES) {
      const bill = row.bills[category]
      if (!bill) continue
      const summary: typeof bills[string] = {
        status: bill.status, source: bill.source,
        ...(bill.template_count ? {template_count: bill.template_count} : {}),
        ...(bill.active_template_count ? {active_template_count: bill.active_template_count} : {}),
      }
      if (category === 'other') {
        // Other-bill names are display-only recurring-template metadata. Never infer a bill name from
        // category_detail, vendor, account, note or placeholder text.
        const templateItems: OtherBillListItem[] = (bill.templates || []).map((template) => ({
          source: 'template',
          status: 'company',
          ...(optionalText(template.other_bill_name) ? {name: optionalText(template.other_bill_name)} : {}),
          template_status: optionalText(template.template_status) || 'active',
        }))
        summary.other_items = templateItems.length
          ? templateItems
          : bill.source === 'configured' ? [{source: 'configured', status: bill.status}] : []
        if (bill.source === 'configured' && templateItems.length) summary.registration_status = bill.status
      }
      bills[category] = summary
    }
    return {...row, bills}
  })
}

function unavailable(res: any, error?: any) {
  if (!error || ['42P01', '42703'].includes(String(error?.code))) return res.status(503).json({message: 'property_bills_schema_not_ready'})
  return res.status(500).json({message: 'property_bills_request_failed'})
}

async function loadPropertyBillRows(propertyId?: string) {
  const properties = await pgPool!.query(
    `SELECT id, code, address, region FROM properties
     WHERE COALESCE(archived, false) = false AND ($1::text IS NULL OR id = $1)
     ORDER BY code, id`, [propertyId ?? null])
  const ids = properties.rows.map((property: any) => String(property.id))
  if (!ids.length) return { rows: [], nameStorageReady: false }
  const configured = await pgPool!.query(
    `SELECT property_id, category, status
     FROM property_bill_configurations WHERE property_id = ANY($1::text[])`, [ids])
  const capability = await pgPool!.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'recurring_payments' AND column_name = 'other_bill_name'
     ) AS column_present`,
  )
  const nameStorageReady = Boolean(capability.rows?.[0]?.column_present)
  const otherBillNameProjection = nameStorageReady ? 'r.other_bill_name' : 'NULL::text AS other_bill_name'
  const templates = await pgPool!.query(
    `SELECT r.id AS template_id, r.status AS template_status, r.property_id, r.category, r.category_detail,
            ${otherBillNameProjection},
            r.vendor, r.amount, r.bill_account_no, r.frequency_months,
            r.due_day_of_month, r.bill_expected_day_of_month, r.payment_type, r.pay_account_name,
            r.pay_bsb, r.pay_account_number, r.pay_ref, r.bpay_code, r.pay_mobile_number,
            r.bill_period_start_day_of_month, r.bill_period_start_month_offset,
            r.bill_period_end_day_of_month, r.bill_period_end_month_offset, r.remind_days_before,
            r.start_month_key, r.note
       FROM recurring_payments r
     WHERE r.property_id = ANY($1::text[]) AND r.template_kind = 'property_payable'
       AND COALESCE(r.scope, 'property') = 'property'
       AND COALESCE(to_jsonb(r)->>'cashflow_type', 'expense') = 'expense'
       AND COALESCE(r.status, 'active') IN ('active', 'paused')
     ORDER BY r.property_id, r.category, CASE WHEN COALESCE(r.status, 'active') = 'active' THEN 0 ELSE 1 END,
              r.start_month_key, r.vendor, r.id`, [ids])
  return { rows: projectPropertyBills(properties.rows, configured.rows, templates.rows), nameStorageReady }
}

async function directoryResponse(req: any, propertyId?: string, query = '') {
  const loaded = await loadPropertyBillRows(propertyId)
  const rows = filterPropertyBillRows(loaded.rows, query)
  return {
    can_edit: await userHasAnyPerm(req.user || {}, writeCodes),
    display_name_storage_ready: loaded.nameStorageReady,
    rows: stripPropertyBillAccounts(rows),
  }
}

propertyBillsRouter.get('/', menu, readPerm, async (req, res) => {
  const filter = propertyIdSchema.optional().safeParse(req.query.property_id)
  if (!filter.success) return res.status(400).json({message: 'invalid_property_id'})
  if (!pgPool) return unavailable(res)
  try {
    return res.json(await directoryResponse(req, filter.data))
  } catch (error) {
    return unavailable(res, error)
  }
})

propertyBillsRouter.post('/search', menu, readPerm, async (req, res) => {
  const body = searchSchema.safeParse(req.body || {})
  if (!body.success) return res.status(400).json({message: 'invalid_property_bill_search'})
  if (!pgPool) return unavailable(res)
  try {
    return res.json(await directoryResponse(req, undefined, body.data.query))
  } catch (error) {
    return unavailable(res, error)
  }
})

propertyBillsRouter.get('/:propertyId/:category', menu, readPerm, async (req, res) => {
  const property = propertyIdSchema.safeParse(req.params.propertyId)
  const category = categorySchema.safeParse(req.params.category)
  if (!property.success || !category.success) return res.status(400).json({message: 'invalid_property_bill'})
  if (!pgPool) return unavailable(res)
  try {
    const loaded = await loadPropertyBillRows(property.data)
    const row = loaded.rows[0]
    if (!row) return res.status(404).json({message: 'property_not_found'})
    const detail = row.bills[category.data]
    if (!detail) return res.json({bill: null, templates: [], display_name_storage_ready: loaded.nameStorageReady})
    const { templates = [], ...bill } = detail
    return res.json({bill, templates, display_name_storage_ready: loaded.nameStorageReady})
  } catch (error) {
    return unavailable(res, error)
  }
})

propertyBillsRouter.patch('/:propertyId/:category/templates/:templateId/display-name', menu, readPerm, writePerm, async (req, res) => {
  const property = propertyIdSchema.safeParse(req.params.propertyId)
  const category = categorySchema.safeParse(req.params.category)
  const template = propertyIdSchema.safeParse(req.params.templateId)
  const body = displayNameSchema.safeParse(req.body)
  if (!property.success || !category.success || !template.success || !body.success || category.data !== 'other') {
    return res.status(400).json({message: 'invalid_property_bill_display_name'})
  }
  const actor = String((req as any).user?.sub || '').trim()
  if (!actor) return res.status(401).json({message: 'unauthorized'})
  if (!pgPool) return unavailable(res)
  try {
    const result: any = await pgRunInTransaction((client) => updatePropertyPayableTemplateDisplayNameTx(client, {
      templateId: template.data,
      propertyId: property.data,
      category: category.data,
      name: body.data.name,
    }))
    if (result?.invalidCategory || result?.invalidName) return res.status(400).json({message: 'invalid_property_bill_display_name'})
    if (result?.notFound) return res.status(404).json({message: 'property_bill_template_not_found'})
    try { addAudit('PropertyBillTemplateDisplayName', template.data, 'update', result.before, result.after, actor) } catch {}
    return res.json({ok: true, name: result.name})
  } catch (error: any) {
    if (['42P01', '42703'].includes(String(error?.code))) return res.status(503).json({code: 'display_name_storage_not_ready', message: 'display name storage not ready'})
    return res.status(409).json({message: 'property_bill_display_name_update_failed'})
  }
})

propertyBillsRouter.post('/:propertyId/:category/templates/:templateId/stop', menu, readPerm, writePerm, async (req, res) => {
  const property = propertyIdSchema.safeParse(req.params.propertyId)
  const category = categorySchema.safeParse(req.params.category)
  const template = propertyIdSchema.safeParse(req.params.templateId)
  if (!property.success || !category.success || !template.success) return res.status(400).json({message: 'invalid_property_bill_template'})
  const actor = String((req as any).user?.sub || '').trim()
  if (!actor) return res.status(401).json({message: 'unauthorized'})
  if (!pgPool) return unavailable(res)
  try {
    const result: any = await pgRunInTransaction((client) => stopPropertyPayableTemplateTx(client, {
      templateId: template.data, propertyId: property.data, category: category.data, actorId: actor,
    }))
    if (result?.notFound) return res.status(404).json({message: 'property_bill_template_not_found'})
    try { addAudit('RecurringPayment', template.data, 'property-bill-safe-stop', result.before, result.after, actor) } catch {}
    return res.json({ok: true, stopped: true, already_stopped: Boolean(result.alreadyStopped)})
  } catch {
    return res.status(409).json({code: 'template_stop_failed', message: '模板停用失败，未更改模板或账单'})
  }
})

propertyBillsRouter.post('/:propertyId/:category/templates/:templateId/resume', menu, readPerm, writePerm, async (req, res) => {
  const property = propertyIdSchema.safeParse(req.params.propertyId)
  const category = categorySchema.safeParse(req.params.category)
  const template = propertyIdSchema.safeParse(req.params.templateId)
  if (!property.success || !category.success || !template.success) return res.status(400).json({message: 'invalid_property_bill_template'})
  const actor = String((req as any).user?.sub || '').trim()
  if (!actor) return res.status(401).json({message: 'unauthorized'})
  if (!pgPool) return unavailable(res)
  try {
    const result: any = await pgRunInTransaction((client) => resumePropertyPayableTemplateTx(client, {
      templateId: template.data,
      propertyId: property.data,
      category: category.data,
      actorId: actor,
    }))
    if (result?.notFound) return res.status(404).json({message: 'property_bill_template_not_found'})
    if (result?.scheduleUnavailable) return res.status(409).json({
      code: 'template_resume_schedule_unavailable', message: '模板缺少可靠的原周期，已拒绝恢复；未补建任何账单',
    })
    try { addAudit('RecurringPayment', template.data, 'property-bill-safe-resume', result.before, result.after, actor) } catch {}
    return res.json({
      ok: true,
      resumed: true,
      already_active: Boolean(result.alreadyActive),
      resume_from_month_key: result.resumeFromMonthKey || null,
    })
  } catch {
    return res.status(409).json({code: 'template_resume_failed', message: '模板恢复失败，未更改模板或账单'})
  }
})

propertyBillsRouter.delete('/:propertyId/:category/templates/:templateId', menu, readPerm, writePerm, async (req, res) => {
  const property = propertyIdSchema.safeParse(req.params.propertyId)
  const category = categorySchema.safeParse(req.params.category)
  const template = propertyIdSchema.safeParse(req.params.templateId)
  if (!property.success || !category.success || !template.success) return res.status(400).json({message: 'invalid_property_bill_template'})
  const actor = String((req as any).user?.sub || '').trim()
  if (!actor) return res.status(401).json({message: 'unauthorized'})
  if (!pgPool) return unavailable(res)
  try {
    const result: any = await pgRunInTransaction((client) => deleteUnusedPropertyPayableTemplateTx(client, {
      templateId: template.data, propertyId: property.data, category: category.data,
    }))
    if (result?.notFound) return res.status(404).json({message: 'property_bill_template_not_found'})
    if (result?.dependencyCheckFailed) return res.status(409).json({
      code: 'template_dependency_check_failed', message: '无法完整核实关联记录，已拒绝删除；请改用停用',
    })
    if (result?.blocked) return res.status(409).json({
      code: 'template_has_linked_records', message: '模板已有账单、历史或其他关联记录，不能删除；请改用停用',
    })
    if (result?.historyUnverifiable) return res.status(409).json({
      code: 'template_link_history_unverifiable', message: '当前数据结构无法证明模板从未关联过账单，已拒绝删除；请改用停用',
    })
    return res.status(409).json({code: 'template_dependency_check_failed', message: '无法完整核实关联记录，已拒绝删除；请改用停用'})
  } catch {
    return res.status(409).json({code: 'template_dependency_check_failed', message: '无法完整核实关联记录，已拒绝删除；请改用停用'})
  }
})

propertyBillsRouter.post('/:propertyId/:category', menu, readPerm, writePerm, async (req, res) => {
  const property = propertyIdSchema.safeParse(req.params.propertyId)
  const category = categorySchema.safeParse(req.params.category)
  const body = saveSchema.safeParse(req.body)
  if (!property.success || !category.success || !body.success) return res.status(400).json({message: 'invalid_property_bill'})
  const actor = String((req as any).user?.sub || '').trim()
  if (!actor) return res.status(401).json({message: 'unauthorized'})
  if (!pgPool) return unavailable(res)
  const data = body.data
  try {
    // One statement checks scope and writes only this category in the new config table.
    const result = await pgPool.query(
      `INSERT INTO property_bill_configurations
        (property_id, category, status, updated_by)
       SELECT id, $2, $3, $4 FROM properties
        WHERE id = $1 AND COALESCE(archived,false) = false
       ON CONFLICT (property_id, category) DO UPDATE SET status = EXCLUDED.status,
        account_number = CASE WHEN EXCLUDED.status = 'company' THEN property_bill_configurations.account_number ELSE NULL END,
        vendor = CASE WHEN EXCLUDED.status = 'company' THEN property_bill_configurations.vendor ELSE NULL END,
        cycle_months = CASE WHEN EXCLUDED.status = 'company' THEN property_bill_configurations.cycle_months ELSE NULL END,
        due_date = CASE WHEN EXCLUDED.status = 'company' THEN property_bill_configurations.due_date ELSE NULL END,
        updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING property_id`,
      [property.data, category.data, data.status, actor])
    if (!result.rowCount) return res.status(404).json({message: 'property_not_found'})
    return res.json({ok: true})
  } catch (error) {
    return unavailable(res, error)
  }
})

propertyBillsRouter.get('/:propertyId/:category/history', menu, readPerm, async (req, res) => {
  const property = propertyIdSchema.safeParse(req.params.propertyId)
  const category = categorySchema.safeParse(req.params.category)
  if (!property.success || !category.success) return res.status(400).json({message: 'invalid_property_bill'})
  if (!pgPool) return unavailable(res)
  try {
    // Legacy expense snapshots do not carry an immutable payable subtype. Only
    // show history with a surviving, same-property payable template link; do not
    // guess the source of orphaned snapshots or modify original records.
    const result = await pgPool.query(
      `SELECT COALESCE(e.paid_date, e.bill_received_date, e.due_date)::text AS date,
              e.status, e.amount
         FROM property_expenses e
         JOIN recurring_payments r ON r.id = e.fixed_expense_id AND r.property_id = e.property_id
         JOIN properties p ON p.id = e.property_id AND COALESCE(p.archived,false) = false
        WHERE p.id = $1 AND e.category = $2 AND e.generated_from = 'recurring_payments'
          AND e.deleted_at IS NULL
          AND (COALESCE(e.amount_confirmed, false) OR e.bill_received_date IS NOT NULL OR e.paid_date IS NOT NULL OR e.status = 'paid')
          AND r.template_kind = 'property_payable'
          AND COALESCE(r.scope, 'property') = 'property'
          AND COALESCE(to_jsonb(r)->>'cashflow_type', 'expense') = 'expense'
        ORDER BY COALESCE(e.paid_date, e.bill_received_date, e.due_date) DESC NULLS LAST, e.id DESC
        LIMIT 100`, [property.data, category.data])
    return res.json({ rows: result.rows.map((row: any) => ({
      date: row.date || null,
      status: row.status || null,
      amount: row.amount == null ? null : Number(row.amount),
    })) })
  } catch (error) {
    return unavailable(res, error)
  }
})
