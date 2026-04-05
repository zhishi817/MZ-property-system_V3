import { hasPg, pgPool } from '../dbAdapter'

type CollectedAttachment = {
  url: string
  source: 'expense_invoices' | 'finance_transactions'
  created_at?: string | null
  expense_id?: string | null
  expense_invoice_id?: string | null
  tx_id?: string | null
  dedupe_key: string
  object_key?: string | null
}

function monthRangeISO(monthKey: string): { start: string; end: string } | null {
  const m = String(monthKey || '').trim()
  const mm = m.match(/^(\d{4})-(\d{2})$/)
  if (!mm) return null
  const y = Number(mm[1])
  const mo = Number(mm[2])
  if (!Number.isFinite(y) || !Number.isFinite(mo) || mo < 1 || mo > 12) return null
  const start = new Date(Date.UTC(y, mo - 1, 1))
  const end = new Date(Date.UTC(y, mo, 1))
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) }
}

function normalizeUrlString(raw: any): string {
  const s = String(raw || '').trim()
  if (!s) return ''
  if (s.startsWith('/')) return s.replace(/\/+$/g, '')
  try {
    const u = new URL(s)
    u.host = String(u.host || '').toLowerCase()
    if (u.pathname !== '/') u.pathname = u.pathname.replace(/\/+$/g, '') || '/'
    return u.toString()
  } catch {
    return s.replace(/\/+$/g, '')
  }
}

function toAbsoluteUrl(normalizedUrl: string, apiBase?: string): string {
  const u = String(normalizedUrl || '').trim()
  if (!u) return ''
  if (/^https?:\/\//i.test(u)) return u
  const base = String(apiBase || '').trim().replace(/\/+$/g, '')
  if (!base || !u.startsWith('/')) return u
  return `${base}${u}`
}

function inferObjectKey(inputUrl: string): string | null {
  const raw = String(inputUrl || '').trim()
  if (!raw) return null
  const pullPath = (pathValue: string) => {
    const clean = String(pathValue || '').replace(/^\/+/, '')
    return clean || null
  }
  if (raw.startsWith('/')) {
    if (/^\/public\/r2-image\b/i.test(raw)) {
      try {
        const u = new URL(`http://local${raw}`)
        const target = String(u.searchParams.get('url') || '').trim()
        if (target) return inferObjectKey(target)
      } catch {}
      return null
    }
    if (/^\/uploads\//i.test(raw)) return pullPath(raw)
    return pullPath(raw)
  }
  try {
    const u = new URL(raw)
    if (/\/public\/r2-image\b/i.test(u.pathname)) {
      const nested = String(u.searchParams.get('url') || '').trim()
      if (nested) return inferObjectKey(nested)
      return null
    }
    const host = String(u.hostname || '').toLowerCase()
    if (host.endsWith('.r2.dev') || host.includes('r2.cloudflarestorage.com')) {
      return pullPath(u.pathname)
    }
    if (/^\/uploads\//i.test(u.pathname)) return pullPath(u.pathname)
    return null
  } catch {
    return null
  }
}

export function buildAttachmentDedupeKey(rawUrl: string, normalizedUrl?: string): { dedupeKey: string; objectKey: string | null } {
  const norm = normalizeUrlString(normalizedUrl || rawUrl)
  const objectKey = inferObjectKey(norm) || inferObjectKey(String(rawUrl || ''))
  return {
    dedupeKey: objectKey ? `object:${objectKey}` : `url:${norm}`,
    objectKey,
  }
}

export function normalizeAttachmentUrl(rawUrl: string, apiBase?: string): { normalizedUrl: string; absoluteUrl: string; dedupeKey: string; objectKey: string | null } {
  const normalizedUrl = normalizeUrlString(rawUrl)
  const absoluteUrl = toAbsoluteUrl(normalizedUrl, apiBase)
  const { dedupeKey, objectKey } = buildAttachmentDedupeKey(absoluteUrl, normalizedUrl)
  return { normalizedUrl, absoluteUrl, dedupeKey, objectKey }
}

export async function collectMonthlyInvoiceAttachments(input: {
  propertyId: string
  monthKey: string
  apiBase?: string
}): Promise<CollectedAttachment[]> {
  if (!hasPg || !pgPool) return []
  const pid = String(input.propertyId || '').trim()
  const monthKey = String(input.monthKey || '').trim()
  const apiBase = String(input.apiBase || '').trim()
  if (!pid || !/^\d{4}-\d{2}$/.test(monthKey)) return []
  const range = monthRangeISO(monthKey)
  if (!range) return []

  const expenseSql = `
    SELECT
      i.id AS expense_invoice_id,
      i.expense_id,
      i.url,
      i.created_at,
      'expense_invoices'::text AS source
    FROM expense_invoices i
    JOIN property_expenses e ON i.expense_id = e.id
    WHERE e.property_id = $1
      AND (
        e.month_key = $2
        OR substring(e.due_date::text, 1, 7) = $2
        OR (e.occurred_at >= $3::date AND e.occurred_at < $4::date)
        OR (e.occurred_at IS NULL AND e.created_at >= $3::date AND e.created_at < $4::date)
      )
    ORDER BY i.created_at ASC NULLS LAST, i.id ASC
  `
  const txSql = `
    SELECT
      t.id AS tx_id,
      t.invoice_url AS url,
      t.created_at,
      'finance_transactions'::text AS source
    FROM finance_transactions t
    WHERE t.kind = 'expense'
      AND t.property_id = $1
      AND t.invoice_url IS NOT NULL
      AND btrim(t.invoice_url) <> ''
      AND (
        substring(t.month_key::text, 1, 7) = $2
        OR substring(t.due_date::text, 1, 7) = $2
        OR substring(t.occurred_at::text, 1, 7) = $2
        OR (t.occurred_at IS NULL AND t.created_at >= $3::date AND t.created_at < $4::date)
      )
    ORDER BY t.created_at ASC NULLS LAST, t.id ASC
  `

  const [expenseRows, txRows] = await Promise.all([
    pgPool.query(expenseSql, [pid, monthKey, range.start, range.end]).then((r) => r.rows || []).catch(() => [] as any[]),
    pgPool.query(txSql, [pid, monthKey, range.start, range.end]).then((r) => r.rows || []).catch(() => [] as any[]),
  ])

  const out: CollectedAttachment[] = []
  const seen = new Set<string>()
  for (const row of [...expenseRows, ...txRows]) {
    const rawUrl = String(row?.url || '').trim()
    if (!rawUrl) continue
    const normalized = normalizeAttachmentUrl(rawUrl, apiBase)
    if (!normalized.absoluteUrl || !/^https?:\/\//i.test(normalized.absoluteUrl) && !normalized.absoluteUrl.startsWith('/')) continue
    if (seen.has(normalized.dedupeKey)) continue
    seen.add(normalized.dedupeKey)
    out.push({
      url: normalized.absoluteUrl,
      source: String(row?.source || '') === 'finance_transactions' ? 'finance_transactions' : 'expense_invoices',
      created_at: row?.created_at || null,
      expense_id: row?.expense_id || null,
      expense_invoice_id: row?.expense_invoice_id || null,
      tx_id: row?.tx_id || null,
      dedupe_key: normalized.dedupeKey,
      object_key: normalized.objectKey,
    })
  }
  return out
}
