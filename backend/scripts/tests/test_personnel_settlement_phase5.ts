import assert from 'assert'
import fs from 'fs'
import path from 'path'
import {
  PERSONNEL_SETTLEMENT_DOCUMENT_TEMPLATE_VERSION,
  renderPersonnelSettlementDocumentHtml,
  resolvePersonnelSettlementDocumentKind,
  summarizePersonnelSettlementDocumentLines,
  type PersonnelSettlementDocumentInput,
} from '../../src/lib/personnelSettlementDocumentTemplate'
import { previousCompletedPersonnelSettlementWeek } from '../../src/lib/personnelSettlementWeeklyJob'
import {
  appendPersonnelSettlementFinanceAdjustment,
  personnelSettlementDocumentAllowsEmptyLines,
  personnelSettlementDocumentPaymentDestination,
  personnelSettlementDocumentSourceHash,
  selectCurrentPersonnelSettlementDocuments,
  serializePersonnelSettlementDocument,
} from '../../src/lib/personnelSettlementDocuments'

const root = path.resolve(__dirname, '../..')
const read = (relativePath: string) => fs.readFileSync(path.resolve(root, relativePath), 'utf8')

assert.equal(previousCompletedPersonnelSettlementWeek(new Date('2026-09-14T00:30:00+10:00')), '2026-09-07')
assert.equal(previousCompletedPersonnelSettlementWeek(new Date('2026-09-16T12:00:00+10:00')), '2026-09-07')
assert.equal(resolvePersonnelSettlementDocumentKind(true, 'confirmed'), 'tax_invoice')
assert.equal(resolvePersonnelSettlementDocumentKind(false, 'confirmed'), 'invoice')
assert.equal(resolvePersonnelSettlementDocumentKind(true, 'awaiting_confirmation'), 'settlement_draft')

const adjustedLines = appendPersonnelSettlementFinanceAdjustment([], {
  finance_adjustment: { amount_cents: -1500, reason: 'Approved correction' },
}, '2026-09-13')
assert.equal(adjustedLines.length, 1)
assert.equal(adjustedLines[0].subtotal_cents, -1500)
assert.equal(adjustedLines[0].gst_cents, 0)
assert(adjustedLines[0].description.includes('Approved correction'))
assert.equal(personnelSettlementDocumentAllowsEmptyLines({ subtotal_cents: 0, gst_cents: 0, total_cents: 0 }), true)
assert.equal(personnelSettlementDocumentAllowsEmptyLines({ subtotal_cents: 1, gst_cents: 0, total_cents: 1 }), false)

assert.equal(
  personnelSettlementDocumentPaymentDestination('confirmed', { payment_method: 'bank_transfer' }, {
    payment_method: 'bank_transfer', bank_account_name: 'Synthetic Cleaner', bank_bsb: '123456', bank_account_number: '987654321',
  }),
  null,
)
assert.deepEqual(
  personnelSettlementDocumentPaymentDestination('paid', { payment_method: 'bank_transfer' }, {
    payment_method: 'bank_transfer', bank_account_name: 'Synthetic Cleaner', bank_bsb: '123456', bank_account_number: '987654321',
  }),
  {
    payment_method: 'bank_transfer', recorded: true, bank_account_name: 'Synthetic Cleaner',
    bank_bsb: '123456', bank_account_last4: '4321',
  },
)
assert.deepEqual(
  personnelSettlementDocumentPaymentDestination('paid', { payment_method: 'cash' }, { payment_method: 'cash' }),
  { payment_method: 'cash', recorded: true },
)
assert.deepEqual(
  personnelSettlementDocumentPaymentDestination('paid', { payment_method: 'bank_transfer' }, {}),
  {
    payment_method: 'bank_transfer', recorded: false, bank_account_name: null,
    bank_bsb: null, bank_account_last4: null,
  },
)

const base: PersonnelSettlementDocumentInput = {
  documentStage: 'confirmed',
  documentKind: 'tax_invoice',
  invoiceNumber: 'PS-20260913-ABC123',
  issueDate: '2026-09-14',
  weekStart: '2026-09-07',
  weekEnd: '2026-09-13',
  currency: 'AUD',
  supplier: { legal_name: 'Cleaner & Co', business_name: 'Cleaner <Team>', abn: '11111111111', gst_registered: true },
  buyer: { legal_name: 'Homixa Pty Ltd', trading_name: 'Homixa', abn: '22222222222', address: 'Melbourne VIC 3000' },
  lines: [{ service_date: '2026-09-10', component_type: 'cleaning_task', property_label: '<Room>', description: 'Cleaning · <Room> · 两房两卫', quantity_numerator: 2, quantity_denominator: 1, unit_rate_cents: 10000, subtotal_cents: 20000, gst_cents: 2000, total_cents: 22000 }],
  totals: { subtotal_cents: 20000, gst_cents: 2000, total_cents: 22000 },
  confirmedAt: '2026-09-14T01:00:00.000Z',
}
assert.notEqual(
  personnelSettlementDocumentSourceHash(base),
  personnelSettlementDocumentSourceHash({ ...base, documentStage: 'paid', paidAt: '2026-09-15T01:00:00.000Z' }),
)
const taxInvoice = renderPersonnelSettlementDocumentHtml(base)
assert(taxInvoice.includes('<h1>Tax Invoice</h1>'))
assert(taxInvoice.includes('Cleaner &lt;Team&gt;'))
assert(taxInvoice.includes('Cleaning - &lt;Room&gt;'))
assert(taxInvoice.includes('<th>Date</th><th>Description</th><th class="num">Total</th>'))
assert(!taxInvoice.includes('<th class="num">Qty</th>'))
assert(!taxInvoice.includes('<th class="num">Rate</th>'))
assert(!taxInvoice.includes('bank_account'))
assert(!taxInvoice.includes('Payment details / 付款信息'))

const paidBankInvoice = renderPersonnelSettlementDocumentHtml({
  ...base,
  documentStage: 'paid',
  paidAt: '2026-09-15T01:00:00.000Z',
  paymentDestination: {
    payment_method: 'bank_transfer',
    recorded: true,
    bank_account_name: 'Cleaner Settlement Account',
    bank_bsb: '123456',
    bank_account_last4: '4321',
  },
})
assert(paidBankInvoice.includes('Payment details / 付款信息'))
assert(paidBankInvoice.includes('Bank transfer / 银行转账'))
assert(paidBankInvoice.includes('Cleaner Settlement Account'))
assert(paidBankInvoice.includes('123-456'))
assert(paidBankInvoice.includes('Ending 4321 / 尾号 4321'))
assert(!paidBankInvoice.includes('987654321'))

const paidCashInvoice = renderPersonnelSettlementDocumentHtml({
  ...base,
  documentStage: 'paid',
  paidAt: '2026-09-15T01:00:00.000Z',
  paymentDestination: { payment_method: 'cash', recorded: true },
})
assert(paidCashInvoice.includes('Cash / 现金支付'))
assert(!paidCashInvoice.includes('Account / 银行账号'))

const paidLegacyInvoice = renderPersonnelSettlementDocumentHtml({
  ...base,
  documentStage: 'paid',
  paidAt: '2026-09-15T01:00:00.000Z',
  paymentDestination: { payment_method: 'bank_transfer', recorded: false },
})
assert(paidLegacyInvoice.includes('Not recorded / 未记录'))
assert.notEqual(
  personnelSettlementDocumentSourceHash({
    ...base,
    documentStage: 'paid',
    paidAt: '2026-09-15T01:00:00.000Z',
    paymentDestination: { payment_method: 'bank_transfer', recorded: false },
  }),
  personnelSettlementDocumentSourceHash({
    ...base,
    documentStage: 'paid',
    paidAt: '2026-09-15T01:00:00.000Z',
    paymentDestination: {
      payment_method: 'bank_transfer',
      recorded: true,
      bank_account_name: 'Cleaner Settlement Account',
      bank_bsb: '123456',
      bank_account_last4: '4321',
    },
  }),
)

const dailyLines: PersonnelSettlementDocumentInput['lines'] = []
const addLine = (
  serviceDate: string,
  componentType: string,
  description: string,
  totalCents: number,
  propertyLabel?: string,
) => dailyLines.push({
  service_date: serviceDate,
  component_type: componentType,
  property_label: propertyLabel || null,
  description,
  quantity_numerator: 1,
  quantity_denominator: 1,
  unit_rate_cents: totalCents,
  subtotal_cents: totalCents,
  gst_cents: 0,
  total_cents: totalCents,
})
for (let day = 7; day <= 13; day++) addLine(`2026-09-${String(day).padStart(2, '0')}`, 'custom_amount', `Other work ${day}`, 1000)
for (const propertyLabel of ['AU1706', 'FG1003', 'MSQ4503', 'MSQ8508']) {
  addLine('2026-09-07', 'cleaning_task', `Cleaning · ${propertyLabel} · 两房两卫`, 5500, propertyLabel)
}
addLine('2026-09-07', 'subsidy_amount', 'Parking', 1500)
addLine('2026-09-08', 'warehouse_hour', 'Stock count', 3500)
addLine('2026-09-08', 'overtime_hour', 'Late checkout', 2000)
const dailySummary = summarizePersonnelSettlementDocumentLines(dailyLines)
assert.equal(dailySummary.length, 7)
assert.equal(dailySummary[0].service_date, '2026-09-07')
assert.equal(dailySummary[0].description, 'Cleaning - AU1706 / FG1003 / MSQ4503 / MSQ8508; Other work 7; Subsidy - Parking')
assert.equal(dailySummary[0].total_cents, 24500)
assert.equal(dailySummary[1].description, 'Other work 8; Warehouse - Stock count; Overtime - Late checkout')
assert.equal(dailySummary[1].total_cents, 6500)
const dailyHtml = renderPersonnelSettlementDocumentHtml({
  ...base,
  lines: dailyLines,
  totals: { subtotal_cents: 36000, gst_cents: 0, total_cents: 36000 },
})
const dailyTableBody = dailyHtml.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] || ''
assert.equal((dailyTableBody.match(/<tr>/g) || []).length, 7)
assert(dailyHtml.includes('Cleaning - AU1706 / FG1003 / MSQ4503 / MSQ8508; Other work 7; Subsidy - Parking'))
assert(dailyHtml.includes('$245.00'))

const ordinaryInvoice = renderPersonnelSettlementDocumentHtml({
  ...base,
  documentKind: 'invoice',
  supplier: { ...base.supplier, gst_registered: false },
  totals: { subtotal_cents: 20000, gst_cents: 0, total_cents: 20000 },
})
assert(ordinaryInvoice.includes('<h1>Invoice</h1>'))
assert(!ordinaryInvoice.includes('<h1>Tax Invoice</h1>'))
const ordinaryInvoiceWithoutAbn = renderPersonnelSettlementDocumentHtml({
  ...base,
  documentKind: 'invoice',
  supplier: { ...base.supplier, abn: '', gst_registered: false },
  totals: { subtotal_cents: 20000, gst_cents: 0, total_cents: 20000 },
})
assert(ordinaryInvoiceWithoutAbn.includes('<h1>Invoice</h1>'))
assert(!ordinaryInvoiceWithoutAbn.includes('<div>ABN </div>'))

const draft = renderPersonnelSettlementDocumentHtml({ ...base, documentStage: 'awaiting_confirmation', documentKind: 'settlement_draft', invoiceNumber: null })
assert(draft.includes('<h1>Weekly Settlement Draft</h1>'))
assert(draft.includes('NOT A TAX INVOICE'))
const zeroValueDraft = renderPersonnelSettlementDocumentHtml({
  ...base,
  documentStage: 'awaiting_confirmation',
  documentKind: 'settlement_draft',
  invoiceNumber: null,
  lines: [],
  totals: { subtotal_cents: 0, gst_cents: 0, total_cents: 0 },
})
assert(zeroValueDraft.includes('No payable items / 本周无应付项目'))
assert(zeroValueDraft.includes('$0.00'))

const serialized = serializePersonnelSettlementDocument({
  id: 'document-1', settlement_id: 'settlement-1', document_stage: 'confirmed', document_kind: 'tax_invoice',
  version: 1, invoice_number: 'PS-1', mime_type: 'application/pdf', byte_size: 123, generated_at: '2026-09-14',
  storage_key: 'must-not-leak', supplier_snapshot: { secret: true }, buyer_snapshot: { secret: true },
}) as any
assert.equal(serialized.storage_key, undefined)
assert.equal(serialized.supplier_snapshot, undefined)
assert.equal(serialized.document_label, 'Tax Invoice')

const currentDocuments = selectCurrentPersonnelSettlementDocuments([
  { id: 'draft-v2', document_stage: 'awaiting_confirmation', version: 2, generated_at: '2026-09-14T00:00:00.000Z' },
  { id: 'draft-v3', document_stage: 'awaiting_confirmation', version: 3, generated_at: '2026-09-15T00:00:00.000Z' },
  { id: 'invoice-v1', document_stage: 'confirmed', version: 1, generated_at: '2026-09-13T00:00:00.000Z' },
], 'awaiting_confirmation')
assert.deepEqual(currentDocuments.map((document) => document.id), ['draft-v3'])
assert.deepEqual(selectCurrentPersonnelSettlementDocuments(currentDocuments, 'confirmed'), [])

const migration = read('scripts/migrations/20260911_personnel_settlement_phase5.sql')
assert(migration.includes('CREATE TABLE IF NOT EXISTS personnel_settlement_documents'))
assert(migration.includes('CREATE TABLE IF NOT EXISTS personnel_settlement_job_runs'))
assert(migration.includes("VALUES ('20260911_personnel_settlement_phase5')"))

const workflow = read('src/lib/personnelSettlementWorkflow.ts')
assert(workflow.includes("status IN ('draft','submitted','returned')"))
assert(workflow.includes('async function publishPersonnelSettlementConfirmationRequest'))
assert(workflow.includes('ruleSnapshot.confirmation_request = {'))
assert(workflow.includes("round: 'dispute_resolution'"))
assert(workflow.includes("eventId: `personnel-settlement-confirmation-requested:${input.settlementId}:${normalizeConfirmationRevision(input.confirmationRevision)}`"))
assert(workflow.includes('recipientUserIds: [input.userId]'))
assert(workflow.includes("confirmation_round: input.isDisputeResolution ? 'dispute_resolution' : 'initial'"))
assert(workflow.includes("action: 'open_personnel_settlement'"))
assert(workflow.includes("status='confirmed', workload_amount_confirmed_at=now()"))
assert(workflow.includes("status='awaiting_confirmation'"))
assert(workflow.includes("'return_for_confirmation'"))

const scheduler = read('src/index.ts')
assert(scheduler.includes("PERSONNEL_SETTLEMENT_WEEKLY_ENABLED || 'false'"))
assert(scheduler.includes("PERSONNEL_SETTLEMENT_WEEKLY_CRON || '5 0 * * 1'"))
assert(scheduler.includes("timezone: 'Australia/Melbourne'"))
const weeklyJob = read('src/lib/personnelSettlementWeeklyJob.ts')
assert(weeklyJob.includes('pg_try_advisory_xact_lock'))
assert(!weeklyJob.includes('generatePersonnelSettlementWeek'))
assert(!weeklyJob.includes('issuePersonnelSettlementConfirmation'))

const routes = read('src/modules/personnel_settlements.ts')
assert(routes.includes("router.get('/my-settlements/:settlementId/documents/:documentId'"))
assert(routes.includes('selectCurrentPersonnelSettlementDocuments(settlement.documents || [], settlement.status)'))
assert(routes.includes("router.post('/weekly/run'"))
assert(routes.includes("router.get('/weekly-runs'"))
assert(routes.includes("router.post('/weekly/:settlementId/generate-document'"))
assert(routes.includes("router.get('/my-settlements-preview'"))
assert(routes.includes("router.post('/my-settlements-submit'"))
assert(routes.includes("'/weekly/:settlementId/return-for-confirmation'"))

const documentSource = read('src/lib/personnelSettlementDocuments.ts')
assert(documentSource.includes("throw new Error('settlement_gst_amount_invalid')"))
assert(documentSource.includes('supplier.gst_registered && supplier.abn.length !== 11'))
assert(documentSource.includes('appendPersonnelSettlementFinanceAdjustment'))
assert(documentSource.includes("calculation_snapshot->>'property_label'"))
assert(documentSource.includes('template_version: PERSONNEL_SETTLEMENT_DOCUMENT_TEMPLATE_VERSION'))
assert(documentSource.includes("throw new Error('settlement_document_source_changed')"))
assert(documentSource.indexOf('const lockedSource = await loadDocumentSource') > documentSource.indexOf('FOR UPDATE'))
assert.equal(PERSONNEL_SETTLEMENT_DOCUMENT_TEMPLATE_VERSION, 'daily-summary-invoice-v2-payment-destination')

const notificationRegistry = read('../docs/notification-registry.yaml')
assert(notificationRegistry.includes('business_event: personnel_settlement_revision_confirmation_requested'))
assert(notificationRegistry.includes('Initial partner submission does not emit this notification.'))
assert(notificationRegistry.includes('required: [personnel_weekly_settlements.user_id]'))
assert(notificationRegistry.includes('excluded: [roles, configurable_groups, extra_users, previous_assignees]'))
assert(notificationRegistry.includes('storage_unique: [user_id, event_id]'))
assert(notificationRegistry.includes('{settlement_id}:{confirmation_revision}'))

for (const source of [migration, workflow, documentSource]) {
  assert(!/rcti/i.test(source), 'Phase 5 must not create or label an RCTI')
}

console.log('personnel settlement phase5 tests passed')
