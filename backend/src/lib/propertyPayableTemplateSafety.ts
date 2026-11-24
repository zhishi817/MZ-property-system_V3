export const RECURRING_TEMPLATE_LOCK_NAMESPACE = 202603

type RecurringReferenceResource = 'property_expenses' | 'company_expenses' | 'finance_transactions'

function text(value: any) {
  return String(value || '').trim()
}

function lower(value: any) {
  return text(value).toLowerCase()
}

function monthIndex(value: any) {
  const match = /^(\d{4})-(\d{2})$/.exec(text(value))
  if (!match) return Number.NaN
  const year = Number(match[1])
  const month = Number(match[2])
  if (!Number.isInteger(year) || month < 1 || month > 12) return Number.NaN
  return year * 12 + month - 1
}

function monthKeyFromIndex(value: number) {
  if (!Number.isInteger(value) || value < 0) return ''
  const year = Math.floor(value / 12)
  const month = value % 12 + 1
  return `${year}-${String(month).padStart(2, '0')}`
}

function frequencyMonths(value: any) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 24 ? parsed : null
}

export function recurringTemplateSafetyError(code: string) {
  return Object.assign(new Error(code), { code })
}

export function isPropertyPayableTemplateRow(row: any) {
  return text(row?.template_kind) === 'property_payable' && lower(row?.scope || 'property') === 'property'
}

export function isRecurringTemplateActive(row: any) {
  return lower(row?.status || 'active') === 'active'
}

export function shouldMaterializePropertyPayableTemplate(row: any, snapshot: any) {
  return Boolean(snapshot) || isRecurringTemplateActive(row)
}

export function isPropertyPayableMonthDue(row: any, monthKey: any) {
  const start = monthIndex(row?.start_month_key)
  const month = monthIndex(monthKey)
  if (!Number.isFinite(start) || !Number.isFinite(month) || month < start) return false
  const frequency = frequencyMonths(row?.frequency_months)
  return frequency != null && ((month - start) % frequency) === 0
}

export function nextPropertyPayableDueMonthAfter(row: any, afterMonthKey: any) {
  const start = monthIndex(row?.start_month_key)
  const after = monthIndex(afterMonthKey)
  if (!Number.isFinite(start) || !Number.isFinite(after)) return ''
  const freq = frequencyMonths(row?.frequency_months)
  if (freq == null) return ''
  const firstAllowed = Math.max(start, after + 1)
  const steps = Math.max(0, Math.ceil((firstAllowed - start) / freq))
  return monthKeyFromIndex(start + steps * freq)
}

export function propertyPayableMelbourneMonthKey(at: Date) {
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) return ''
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit',
  }).formatToParts(at)
  const year = parts.find((part) => part.type === 'year')?.value || ''
  const month = parts.find((part) => part.type === 'month')?.value || ''
  return /^\d{4}-\d{2}$/.test(`${year}-${month}`) ? `${year}-${month}` : ''
}

export function assertPropertyPayableSnapshotBinding(template: any, snapshot: any) {
  if (!snapshot || !isPropertyPayableTemplateRow(template)) return
  if (text(snapshot?.property_id) !== text(template?.property_id) || lower(snapshot?.category) !== lower(template?.category)) {
    throw recurringTemplateSafetyError('property_payable_template_binding_mismatch')
  }
}

export async function lockRecurringTemplateIdsTx(client: any, rawIds: any[]) {
  const ids = Array.from(new Set(rawIds.map(text).filter(Boolean))).sort()
  for (const id of ids) {
    await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [RECURRING_TEMPLATE_LOCK_NAMESPACE, id])
  }
  return ids
}

export async function readRecurringTemplateForUpdateTx(client: any, rawId: any) {
  const id = text(rawId)
  if (!id) return null
  await lockRecurringTemplateIdsTx(client, [id])
  const result = await client.query('SELECT * FROM recurring_payments WHERE id = $1 FOR UPDATE', [id])
  return result.rows?.[0] || null
}

function recurringTemplateId(resource: RecurringReferenceResource, row: any) {
  return text(resource === 'finance_transactions' ? row?.recurring_payment_id : row?.fixed_expense_id)
}

export async function assertRecurringReferenceWriteTx(
  client: any,
  resource: RecurringReferenceResource,
  previous: any,
  next: any,
) {
  const previousTemplateId = recurringTemplateId(resource, previous)
  const nextTemplateId = recurringTemplateId(resource, next)
  await lockRecurringTemplateIdsTx(client, [previousTemplateId, nextTemplateId])
  if (!nextTemplateId) return null

  const previousMonth = text(previous?.month_key)
  const nextMonth = text(next?.month_key)
  const createsLink = !previous || previousTemplateId !== nextTemplateId || previousMonth !== nextMonth
  const changesPropertyPayableBinding = resource === 'property_expenses' && Boolean(previous) && (
    text(previous?.property_id) !== text(next?.property_id)
    || lower(previous?.category) !== lower(next?.category)
  )
  if (!createsLink && !changesPropertyPayableBinding) return null

  const result = await client.query('SELECT * FROM recurring_payments WHERE id = $1 FOR UPDATE', [nextTemplateId])
  const template = result.rows?.[0] || null
  if (!template) throw recurringTemplateSafetyError('recurring_template_not_found')
  if (!isPropertyPayableTemplateRow(template)) return template
  if (resource !== 'property_expenses') throw recurringTemplateSafetyError('property_payable_template_scope_mismatch')
  if (text(next?.property_id) !== text(template.property_id) || lower(next?.category) !== lower(template.category)) {
    throw recurringTemplateSafetyError('property_payable_template_binding_mismatch')
  }
  if (createsLink && !isRecurringTemplateActive(template)) throw recurringTemplateSafetyError('property_payable_template_inactive')
  if (createsLink && !isPropertyPayableMonthDue(template, nextMonth)) {
    throw recurringTemplateSafetyError('property_payable_period_not_due')
  }
  return template
}

function matchesBinding(template: any, input: {propertyId: string; category: string}) {
  return isPropertyPayableTemplateRow(template)
    && text(template?.property_id) === text(input.propertyId)
    && lower(template?.category) === lower(input.category)
}

export async function updatePropertyPayableTemplateDisplayNameTx(
  client: any,
  input: {templateId: string; propertyId: string; category: string; name: string},
) {
  if (lower(input.category) !== 'other') return { invalidCategory: true as const }
  const name = text(input.name)
  if (!name || name.length > 80) return { invalidName: true as const }
  const template = await readRecurringTemplateForUpdateTx(client, input.templateId)
  if (!template || !matchesBinding(template, input) || lower(template.category) !== 'other') return { notFound: true as const }
  const updated = await client.query(
    `UPDATE recurring_payments
        SET other_bill_name = $1
      WHERE id = $2 AND property_id = $3 AND lower(category) = lower($4)
        AND template_kind = 'property_payable' AND COALESCE(scope, 'property') = 'property'
      RETURNING id AS template_id, other_bill_name`,
    [name, input.templateId, input.propertyId, input.category],
  )
  const changed = updated.rows?.[0] || null
  return changed
    ? {
        before: {other_bill_name: template.other_bill_name ?? null},
        after: {other_bill_name: changed.other_bill_name},
        name,
      }
    : { notFound: true as const }
}

export async function stopPropertyPayableTemplateTx(
  client: any,
  input: {templateId: string; propertyId: string; category: string; actorId: string},
) {
  const before = await readRecurringTemplateForUpdateTx(client, input.templateId)
  if (!before || !matchesBinding(before, input)) return { notFound: true as const }
  if (!isRecurringTemplateActive(before)) return { before, after: before, alreadyStopped: true as const }
  const updated = await client.query(
    `UPDATE recurring_payments
        SET status = 'paused', updated_by = $1, updated_at = now()
      WHERE id = $2 AND property_id = $3 AND lower(category) = lower($4)
        AND template_kind = 'property_payable' AND COALESCE(scope, 'property') = 'property'
      RETURNING *`,
    [input.actorId, input.templateId, input.propertyId, input.category],
  )
  const after = updated.rows?.[0] || null
  return after ? { before, after, alreadyStopped: false as const } : { notFound: true as const }
}

export async function resumePropertyPayableTemplateTx(
  client: any,
  input: {templateId: string; propertyId: string; category: string; actorId: string; now?: () => Date},
) {
  const before = await readRecurringTemplateForUpdateTx(client, input.templateId)
  if (!before || !matchesBinding(before, input)) return { notFound: true as const }
  if (isRecurringTemplateActive(before)) return { before, after: before, alreadyActive: true as const, resumeFromMonthKey: text(before.start_month_key) }
  // Sample the business month only after this exact template's advisory/row
  // locks are held and its binding is verified. A lock wait can cross midnight.
  const currentMonthKey = propertyPayableMelbourneMonthKey(input.now ? input.now() : new Date())
  const resumeFromMonthKey = nextPropertyPayableDueMonthAfter(before, currentMonthKey)
  if (!resumeFromMonthKey) return { before, scheduleUnavailable: true as const }
  const updated = await client.query(
    `UPDATE recurring_payments
        SET status = 'active', start_month_key = $1, updated_by = $2, updated_at = now()
      WHERE id = $3 AND property_id = $4 AND lower(category) = lower($5)
        AND template_kind = 'property_payable' AND COALESCE(scope, 'property') = 'property'
        AND COALESCE(status, 'active') = 'paused'
      RETURNING *`,
    [resumeFromMonthKey, input.actorId, input.templateId, input.propertyId, input.category],
  )
  const after = updated.rows?.[0] || null
  return after
    ? { before, after, alreadyActive: false as const, resumeFromMonthKey }
    : { notFound: true as const }
}

export async function deleteUnusedPropertyPayableTemplateTx(
  client: any,
  input: {templateId: string; propertyId: string; category: string},
) {
  const before = await readRecurringTemplateForUpdateTx(client, input.templateId)
  if (!before || !matchesBinding(before, input)) return { notFound: true as const }

  let dependencies: {property_expenses: number; company_expenses: number; finance_transactions: number}
  try {
    const propertyExpenses = await client.query('SELECT count(*)::int AS count FROM property_expenses WHERE fixed_expense_id = $1', [input.templateId])
    const companyExpenses = await client.query('SELECT count(*)::int AS count FROM company_expenses WHERE fixed_expense_id = $1', [input.templateId])
    const financeTransactions = await client.query('SELECT count(*)::int AS count FROM finance_transactions WHERE recurring_payment_id = $1', [input.templateId])
    dependencies = {
      property_expenses: Number(propertyExpenses.rows?.[0]?.count || 0),
      company_expenses: Number(companyExpenses.rows?.[0]?.count || 0),
      finance_transactions: Number(financeTransactions.rows?.[0]?.count || 0),
    }
  } catch {
    return { before, dependencyCheckFailed: true as const }
  }
  if (Object.values(dependencies).some((count) => count > 0)) return { before, dependencies, blocked: true as const }
  // Current zero rows cannot prove the template was never linked: the legacy
  // pause/delete flows may already have removed unpaid snapshots. Without an
  // immutable lifecycle proof in the current schema, deletion must fail closed.
  return { before, dependencies, historyUnverifiable: true as const }
}
