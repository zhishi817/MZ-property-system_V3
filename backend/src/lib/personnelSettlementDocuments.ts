import crypto, { randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'
import { pgPool, pgRunInTransaction } from '../dbAdapter'
import { hasR2, r2GetObjectByKey, r2Upload } from '../r2'
import { getMelbourneDate } from './personnelSettlement'
import {
  PERSONNEL_SETTLEMENT_DOCUMENT_TEMPLATE_VERSION,
  renderPersonnelSettlementDocumentHtml,
  resolvePersonnelSettlementDocumentKind,
  type PersonnelSettlementDocumentInput,
  type PersonnelSettlementDocumentStage,
} from './personnelSettlementDocumentTemplate'
import { assertPersonnelSettlementPhase5SchemaReady } from './personnelSettlementPhase5Schema'
import { getChromiumBrowser, resetChromiumBrowser } from './playwright'

type Queryable = { query: (sql: string, params?: any[]) => Promise<any> }

const LOCAL_PRIVATE_PREFIX = 'local-private:personnel-settlements/'
const SAFE_LOCAL_NAME = /^personnel-settlement-[a-z0-9]{64}\.pdf$/
const ALLOWED_DOCUMENT_STAGES = new Set<PersonnelSettlementDocumentStage>([
  'awaiting_confirmation', 'confirmed', 'finance_approved', 'paid',
])

function cleanText(value: unknown) {
  return String(value ?? '').trim()
}

function jsonObject(value: unknown): Record<string, any> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return { ...(value as Record<string, any>) }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {}
  }
  return {}
}

function sha256(value: Buffer | string) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function safeSegment(value: unknown, fallback: string) {
  return cleanText(value).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120) || fallback
}

function buildInvoiceNumber(settlement: any) {
  const week = cleanText(settlement.week_end).replace(/\D/g, '')
  const suffix = sha256(cleanText(settlement.id)).slice(0, 10).toUpperCase()
  return `PS-${week}-${suffix}`
}

export function appendPersonnelSettlementFinanceAdjustment(
  lines: PersonnelSettlementDocumentInput['lines'],
  ruleSnapshot: unknown,
  weekEnd: string,
) {
  const adjustment = jsonObject(jsonObject(ruleSnapshot).finance_adjustment)
  const amountCents = Number(adjustment.amount_cents || 0)
  if (!Number.isSafeInteger(amountCents) || amountCents === 0) return [...lines]
  const reason = cleanText(adjustment.reason)
  return [
    ...lines,
    {
      service_date: weekEnd,
      component_type: 'finance_adjustment',
      property_id: null,
      property_label: null,
      description: reason,
      quantity_numerator: 1,
      quantity_denominator: 1,
      unit_rate_cents: amountCents,
      subtotal_cents: amountCents,
      gst_cents: 0,
      total_cents: amountCents,
    },
  ]
}

export function serializePersonnelSettlementDocument(row: any) {
  const kind = cleanText(row?.document_kind)
  const stage = cleanText(row?.document_stage)
  const invoiceNumber = cleanText(row?.invoice_number) || null
  return {
    id: cleanText(row?.id),
    settlement_id: cleanText(row?.settlement_id),
    document_stage: stage,
    document_kind: kind,
    document_label: kind === 'tax_invoice' ? 'Tax Invoice' : kind === 'invoice' ? 'Invoice' : '费用结算草稿',
    version: Number(row?.version || 0),
    invoice_number: invoiceNumber,
    mime_type: cleanText(row?.mime_type) || 'application/pdf',
    byte_size: Number(row?.byte_size || 0),
    generated_at: row?.generated_at ? String(row.generated_at) : null,
    file_name: `${invoiceNumber || `settlement-${cleanText(row?.settlement_id).slice(0, 8)}`}-${stage}-v${Number(row?.version || 0)}.pdf`,
  }
}

export function selectCurrentPersonnelSettlementDocuments<
  T extends { document_stage?: unknown; version?: unknown; generated_at?: unknown },
>(documents: T[], currentStage: unknown): T[] {
  const stage = cleanText(currentStage)
  if (!stage) return []
  return documents
    .filter((document) => cleanText(document?.document_stage) === stage)
    .sort((left, right) => {
      const generatedDifference = Date.parse(cleanText(right?.generated_at)) - Date.parse(cleanText(left?.generated_at))
      if (Number.isFinite(generatedDifference) && generatedDifference !== 0) return generatedDifference
      return Number(right?.version || 0) - Number(left?.version || 0)
    })
    .slice(0, 1)
}

export async function listPersonnelSettlementDocuments(
  settlementId: string,
  executor: Queryable | null = pgPool,
) {
  if (!executor) throw new Error('pg_required')
  await assertPersonnelSettlementPhase5SchemaReady(executor)
  const result = await executor.query(
    `SELECT id, settlement_id, document_stage, document_kind, version,
            invoice_number, mime_type, byte_size, generated_at::text
       FROM personnel_settlement_documents
      WHERE settlement_id=$1
      ORDER BY generated_at DESC, version DESC`,
    [settlementId],
  )
  return (result.rows || []).map(serializePersonnelSettlementDocument)
}

async function loadDocumentSource(settlementId: string, executor: Queryable) {
  const settlementResult = await executor.query(
    `SELECT settlement.*, batch.week_start::text, batch.week_end::text
       FROM personnel_weekly_settlements settlement
       JOIN personnel_settlement_batches batch ON batch.id=settlement.batch_id
      WHERE settlement.id=$1
      LIMIT 1`,
    [settlementId],
  )
  const settlement = settlementResult.rows?.[0]
  if (!settlement) throw new Error('settlement_not_found')
  const stage = cleanText(settlement.status) as PersonnelSettlementDocumentStage
  if (!ALLOWED_DOCUMENT_STAGES.has(stage)) throw new Error('settlement_document_status_invalid')

  const profile = jsonObject(settlement.profile_snapshot)
  const supplier = {
    legal_name: cleanText(profile.supplier_legal_name),
    business_name: cleanText(profile.supplier_business_name) || null,
    abn: cleanText(profile.abn).replace(/\D/g, ''),
    gst_registered: cleanText(profile.gst_status) === 'registered',
  }
  if (!supplier.legal_name) throw new Error('settlement_supplier_profile_incomplete')
  if (supplier.gst_registered && supplier.abn.length !== 11) {
    throw new Error('settlement_supplier_profile_incomplete')
  }
  if (cleanText(profile.gst_status) === 'unconfirmed') throw new Error('settlement_gst_unconfirmed')
  if (!supplier.gst_registered && Number(settlement.gst_cents || 0) !== 0) {
    throw new Error('settlement_gst_amount_invalid')
  }

  const buyerResult = await executor.query(
    `SELECT legal_name, trading_name, abn, address_line1, address_line2,
            address_city, address_state, address_postcode, address_country
       FROM invoice_companies
      WHERE COALESCE(status,'active')='active'
      ORDER BY COALESCE(is_default,false) DESC, created_at DESC
      LIMIT 1`,
  )
  const buyerRow = buyerResult.rows?.[0]
  const buyer = {
    legal_name: cleanText(buyerRow?.legal_name),
    trading_name: cleanText(buyerRow?.trading_name) || null,
    abn: cleanText(buyerRow?.abn).replace(/\D/g, ''),
    address: [buyerRow?.address_line1, buyerRow?.address_line2, buyerRow?.address_city, buyerRow?.address_state, buyerRow?.address_postcode, buyerRow?.address_country]
      .map(cleanText).filter(Boolean).join(', '),
  }
  if (!buyer.legal_name || buyer.abn.length !== 11 || !buyer.address) throw new Error('settlement_buyer_profile_incomplete')

  const linesResult = await executor.query(
    `SELECT service_date::text, component_type, property_id::text,
            NULLIF(TRIM(calculation_snapshot->>'property_label'), '') AS property_label,
            COALESCE(NULLIF(TRIM(description),''), component_type) AS description,
            quantity_numerator, quantity_denominator, unit_rate_cents,
            subtotal_cents, gst_cents, total_cents
       FROM personnel_settlement_lines
      WHERE settlement_id=$1
      ORDER BY service_date, created_at, id`,
    [settlementId],
  )
  if (!linesResult.rowCount) throw new Error('settlement_lines_required')
  const invoiceNumber = stage === 'awaiting_confirmation'
    ? null
    : cleanText(settlement.supplier_invoice_number) || buildInvoiceNumber(settlement)
  const baseLines: PersonnelSettlementDocumentInput['lines'] = (linesResult.rows || []).map((line: any) => ({
    service_date: cleanText(line.service_date),
    component_type: cleanText(line.component_type) || null,
    property_id: cleanText(line.property_id) || null,
    property_label: cleanText(line.property_label) || null,
    description: cleanText(line.description),
    quantity_numerator: Number(line.quantity_numerator || 0),
    quantity_denominator: Number(line.quantity_denominator || 1),
    unit_rate_cents: Number(line.unit_rate_cents || 0),
    subtotal_cents: Number(line.subtotal_cents || 0),
    gst_cents: Number(line.gst_cents || 0),
    total_cents: Number(line.total_cents || 0),
  }))
  const input: PersonnelSettlementDocumentInput = {
    documentStage: stage,
    documentKind: resolvePersonnelSettlementDocumentKind(supplier.gst_registered, stage),
    invoiceNumber,
    issueDate: getMelbourneDate(new Date(settlement.updated_at || Date.now())),
    weekStart: cleanText(settlement.week_start),
    weekEnd: cleanText(settlement.week_end),
    currency: 'AUD',
    supplier,
    buyer,
    lines: appendPersonnelSettlementFinanceAdjustment(baseLines, settlement.rule_snapshot, cleanText(settlement.week_end)),
    totals: {
      subtotal_cents: Number(settlement.subtotal_cents || 0),
      gst_cents: Number(settlement.gst_cents || 0),
      total_cents: Number(settlement.total_cents || 0),
    },
    confirmedAt: settlement.workload_amount_confirmed_at ? String(settlement.workload_amount_confirmed_at) : null,
    paidAt: settlement.paid_at ? String(settlement.paid_at) : null,
    paymentReference: cleanText(settlement.payment_reference) || null,
  }
  return { settlement, input }
}

export async function renderPersonnelSettlementPdf(input: PersonnelSettlementDocumentInput) {
  const html = renderPersonnelSettlementDocumentHtml(input)
  let browser = await getChromiumBrowser()
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const page = await browser.newPage()
      try {
        await page.setContent(html, { waitUntil: 'load' })
        return Buffer.from(await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true }))
      } finally {
        await page.close().catch(() => undefined)
      }
    } catch (error: any) {
      if (attempt > 0 || !/(closed|disconnected|Target)/i.test(cleanText(error?.message))) throw error
      await resetChromiumBrowser()
      browser = await getChromiumBrowser()
    }
  }
  throw new Error('settlement_document_render_failed')
}

async function persistDocumentBytes(input: {
  settlementId: string
  userId: string
  stage: string
  sourceHash: string
  body: Buffer
}) {
  if (hasR2) {
    const key = `mzapp/personnel-settlements/${safeSegment(input.userId, 'user')}/${safeSegment(input.settlementId, 'settlement')}/${safeSegment(input.stage, 'stage')}-${input.sourceHash}.pdf`
    await r2Upload(key, 'application/pdf', input.body)
    return key
  }
  const fileName = `personnel-settlement-${input.sourceHash}.pdf`
  const uploadDir = path.resolve(process.cwd(), 'private-uploads', 'personnel-settlements')
  await fs.promises.mkdir(uploadDir, { recursive: true })
  await fs.promises.writeFile(path.join(uploadDir, fileName), input.body)
  return `${LOCAL_PRIVATE_PREFIX}${fileName}`
}

export function personnelSettlementDocumentSourceHash(input: PersonnelSettlementDocumentInput) {
  return sha256(JSON.stringify({
    template_version: PERSONNEL_SETTLEMENT_DOCUMENT_TEMPLATE_VERSION,
    document: input,
  }))
}

export async function ensurePersonnelSettlementDocument(input: {
  settlementId: string
  actorUserId: string
}) {
  if (!pgPool) throw new Error('pg_required')
  await assertPersonnelSettlementPhase5SchemaReady(pgPool)
  const source = await loadDocumentSource(input.settlementId, pgPool)
  const sourceHash = personnelSettlementDocumentSourceHash(source.input)
  const existing = await pgPool.query(
    `SELECT * FROM personnel_settlement_documents
      WHERE settlement_id=$1 AND document_stage=$2 AND source_sha256=$3
      LIMIT 1`,
    [input.settlementId, source.input.documentStage, sourceHash],
  )
  if (existing.rowCount) return serializePersonnelSettlementDocument(existing.rows[0])

  const pdf = await renderPersonnelSettlementPdf(source.input)
  if (!pdf.length) throw new Error('settlement_document_render_failed')
  const contentHash = sha256(pdf)
  const storageKey = await persistDocumentBytes({
    settlementId: input.settlementId,
    userId: cleanText(source.settlement.user_id),
    stage: source.input.documentStage,
    sourceHash,
    body: pdf,
  })
  const saved = await pgRunInTransaction(async (client) => {
    await client.query('SELECT id FROM personnel_weekly_settlements WHERE id=$1 FOR UPDATE', [input.settlementId])
    const lockedSource = await loadDocumentSource(input.settlementId, client)
    if (personnelSettlementDocumentSourceHash(lockedSource.input) !== sourceHash) {
      throw new Error('settlement_document_source_changed')
    }
    const repeated = await client.query(
      `SELECT * FROM personnel_settlement_documents
        WHERE settlement_id=$1 AND document_stage=$2 AND source_sha256=$3
        LIMIT 1`,
      [input.settlementId, source.input.documentStage, sourceHash],
    )
    if (repeated.rowCount) return repeated.rows[0]
    const versionResult = await client.query(
      `SELECT COALESCE(MAX(version),0)::int + 1 AS version
         FROM personnel_settlement_documents
        WHERE settlement_id=$1 AND document_stage=$2`,
      [input.settlementId, source.input.documentStage],
    )
    const version = Number(versionResult.rows?.[0]?.version || 1)
    const id = randomUUID()
    const result = await client.query(
      `INSERT INTO personnel_settlement_documents (
         id, settlement_id, document_stage, document_kind, version,
         invoice_number, source_sha256, content_sha256, storage_key,
         mime_type, byte_size, supplier_snapshot, buyer_snapshot,
         totals_snapshot, status_snapshot, generated_by, generated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'application/pdf',$10,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,$15,now())
       RETURNING *`,
      [
        id, input.settlementId, source.input.documentStage, source.input.documentKind, version,
        source.input.invoiceNumber, sourceHash, contentHash, storageKey, pdf.length,
        JSON.stringify(source.input.supplier), JSON.stringify(source.input.buyer), JSON.stringify(source.input.totals),
        JSON.stringify({ status: source.input.documentStage, confirmed_at: source.input.confirmedAt, paid_at: source.input.paidAt, payment_reference: source.input.paymentReference }),
        input.actorUserId,
      ],
    )
    await client.query(
      `UPDATE personnel_weekly_settlements
          SET supplier_invoice_number=COALESCE(supplier_invoice_number,$1),
              invoice_media_id=$2, invoice_generated_at=now(), updated_at=now()
        WHERE id=$3`,
      [source.input.invoiceNumber, id, input.settlementId],
    )
    return result.rows[0]
  })
  if (!saved) throw new Error('settlement_document_save_failed')
  return serializePersonnelSettlementDocument(saved)
}

export async function getPersonnelSettlementDocument(input: {
  settlementId: string
  documentId: string
  requestingUserId?: string
}, executor: Queryable | null = pgPool) {
  if (!executor) throw new Error('pg_required')
  await assertPersonnelSettlementPhase5SchemaReady(executor)
  const params: any[] = [input.settlementId, input.documentId]
  const ownerFilter = input.requestingUserId ? 'AND settlement.user_id=$3' : ''
  if (input.requestingUserId) params.push(input.requestingUserId)
  const result = await executor.query(
    `SELECT document.*, settlement.user_id
       FROM personnel_settlement_documents document
       JOIN personnel_weekly_settlements settlement ON settlement.id=document.settlement_id
      WHERE document.settlement_id=$1 AND document.id=$2 ${ownerFilter}
      LIMIT 1`,
    params,
  )
  return result.rows?.[0] || null
}

export async function readPersonnelSettlementDocumentBytes(row: any) {
  const reference = cleanText(row?.storage_key)
  if (reference.startsWith('mzapp/personnel-settlements/')) {
    if (!hasR2) throw new Error('media_storage_unavailable')
    return await r2GetObjectByKey(reference)
  }
  if (reference.startsWith(LOCAL_PRIVATE_PREFIX)) {
    const fileName = reference.slice(LOCAL_PRIVATE_PREFIX.length)
    if (!SAFE_LOCAL_NAME.test(fileName) || reference !== `${LOCAL_PRIVATE_PREFIX}${fileName}`) {
      throw new Error('invalid_settlement_document_reference')
    }
    try {
      const body = await fs.promises.readFile(path.resolve(process.cwd(), 'private-uploads', 'personnel-settlements', fileName))
      return body.length ? { body, contentType: 'application/pdf' } : null
    } catch {
      return null
    }
  }
  throw new Error('invalid_settlement_document_reference')
}
