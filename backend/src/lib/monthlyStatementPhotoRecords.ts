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
  const raw: any = recordCompletedDateRaw(row)
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

export function recordCompletedDateRaw(row: any): any {
  return row?.completed_at || null
}

type LoadRowsInput = {
  table: MonthlyStatementPhotoTable
  pid: string
  monthKey: string
  range: { start: string; end: string }
  propertyCode?: string
  propertyCodeRaw?: string
}

const columnCache = new Map<string, { cols: Set<string>; loadedAt: number }>()
const COLUMN_CACHE_TTL_MS = 5 * 60 * 1000
const ensuredIndexTables = new Set<string>()

async function loadColumnSet(table: string, force = false): Promise<Set<string>> {
  if (!pgPool) return new Set<string>()
  const now = Date.now()
  const cached = columnCache.get(table)
  if (!force && cached && now - cached.loadedAt < COLUMN_CACHE_TTL_MS) return cached.cols
  const cols = await pgPool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
    [table]
  )
  const colSet = new Set((cols.rows || []).map((r: any) => String(r.column_name || '').toLowerCase()))
  columnCache.set(table, { cols: colSet, loadedAt: now })
  return colSet
}

async function ensurePhotoQueryIndexes(table: string, colSet: Set<string>) {
  if (!pgPool || ensuredIndexTables.has(table)) return
  ensuredIndexTables.add(table)
  try {
    await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_${table}_property_completed_at ON ${table}(property_id, completed_at);`)
  } catch {}
  if (colSet.has('property_code')) {
    try {
      await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_${table}_property_code_completed_at ON ${table}(property_code, completed_at);`)
    } catch {}
  }
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
    let colSet = await loadColumnSet(table, false)
    if (!colSet.has('completed_at')) colSet = await loadColumnSet(table, true)
    const hasPropCode = colSet.has('property_code')
    if (!colSet.has('completed_at')) return []
    await ensurePhotoQueryIndexes(table, colSet)
    const dateCond = `(t.completed_at >= $2::date AND t.completed_at < $3::date)`
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
