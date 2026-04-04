import { db } from '../store'
import { hasPg, pgPool } from '../dbAdapter'

export type MonthlyStatementPhotoTable = 'property_maintenance' | 'property_deep_cleaning'

export function listPhotoUrls(raw: any): string[] {
  if (!raw) return []
  if (Array.isArray(raw)) {
    return raw
      .flatMap((item) => listPhotoUrls(item))
      .map((s) => String(s || '').trim())
      .filter(Boolean)
  }
  if (typeof raw === 'string') {
    const s = raw.trim()
    if (!s) return []
    try {
      const parsed = JSON.parse(s)
      if (parsed !== raw) return listPhotoUrls(parsed)
    } catch {}
    return [s]
  }
  if (typeof raw === 'object') {
    const obj = raw as any
    if (Array.isArray(obj.urls)) return listPhotoUrls(obj.urls)
    const direct = String(obj.url || obj.src || obj.path || '').trim()
    return direct ? [direct] : []
  }
  return [String(raw || '').trim()].filter(Boolean)
}

export function countPhotoUrls(raw: any): number {
  return listPhotoUrls(raw).length
}

export function recordHasPhotoUrls(row: any): boolean {
  return (countPhotoUrls(row?.photo_urls) + countPhotoUrls(row?.repair_photo_urls)) > 0
}

export function recordMonthKey(row: any): string {
  const raw: any = recordBusinessDateRaw(row)
  return String(raw || '').slice(0, 7)
}

export function recordBusinessDateRaw(row: any): any {
  return (
    row?.completed_at ||
    row?.occurred_at ||
    row?.ended_at ||
    row?.started_at ||
    row?.submitted_at ||
    row?.created_at
  )
}

type LoadRowsInput = {
  table: MonthlyStatementPhotoTable
  pid: string
  monthKey: string
  range: { start: string; end: string }
  propertyCode?: string
  propertyCodeRaw?: string
}

export async function loadMonthlyStatementPhotoRows(input: LoadRowsInput): Promise<any[]> {
  const table = input.table
  const pid = String(input.pid || '').trim()
  const monthKey = String(input.monthKey || '').trim()
  const propertyCode = String(input.propertyCode || '').trim()
  const propertyCodeRaw = String(input.propertyCodeRaw || '').trim()
  const codes = Array.from(new Set([propertyCode, propertyCodeRaw].map((s) => String(s || '').trim()).filter(Boolean)))

  if (!pid) return []

  if (hasPg && pgPool) {
    const cols = await pgPool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
      [table]
    )
    const colSet = new Set((cols.rows || []).map((r: any) => String(r.column_name || '').toLowerCase()))
    const hasPropCode = colSet.has('property_code')
    const dateCols = ['completed_at', 'occurred_at', 'ended_at', 'started_at', 'submitted_at', 'created_at'].filter((c) => colSet.has(c))
    if (!dateCols.length) return []

    const dateExpr = (c: string) => `substring(t.${c}::text, 1, 10)`
    const primaryDateExpr = `COALESCE(${dateCols.map((c) => `NULLIF(${dateExpr(c)}, '')`).join(', ')})`
    const dateCond = `(${primaryDateExpr} >= $2 AND ${primaryDateExpr} < $3)`
    const parts: any[] = []

    const q1 = `SELECT to_jsonb(t) AS row FROM ${table} t WHERE t.property_id=$1 AND ${dateCond} LIMIT 8000`
    const r1 = await pgPool.query(q1, [pid, input.range.start, input.range.end])
    parts.push(...(r1.rows || []).map((x: any) => x.row))

    if (codes.length) {
      if (hasPropCode) {
        const q2 = `SELECT to_jsonb(t) AS row FROM ${table} t WHERE t.property_code = ANY($1::text[]) AND ${dateCond} LIMIT 8000`
        const r2 = await pgPool.query(q2, [codes, input.range.start, input.range.end])
        parts.push(...(r2.rows || []).map((x: any) => x.row))
      }
      const q3 = `SELECT to_jsonb(t) AS row FROM ${table} t WHERE t.property_id = ANY($1::text[]) AND ${dateCond} LIMIT 8000`
      const r3 = await pgPool.query(q3, [codes, input.range.start, input.range.end])
      parts.push(...(r3.rows || []).map((x: any) => x.row))
    }

    const map = new Map<string, any>()
    for (const row of parts) {
      const id = String(row?.id || '')
      if (id) map.set(id, row)
    }
    return Array.from(map.values())
  }

  const list = Array.isArray((db as any)[table]) ? (db as any)[table] : []
  const codeSet = new Set(codes)
  const map = new Map<string, any>()
  for (const row of list) {
    const pidOk = String(row?.property_id || '') === pid
    const codeOk = codeSet.size ? codeSet.has(String(row?.property_code || '').trim()) : false
    const legacyOk = codeSet.size ? codeSet.has(String(row?.property_id || '').trim()) : false
    if (!(pidOk || codeOk || legacyOk)) continue
    if (recordMonthKey(row) !== monthKey) continue
    const id = String(row?.id || '')
    if (id) map.set(id, row)
  }
  return Array.from(map.values())
}
