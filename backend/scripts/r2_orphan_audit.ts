import assert from 'assert'
import dotenv from 'dotenv'
import path from 'path'
import {
  extractR2KeysFromValue,
  isApprovedCleanupPrefix,
  isReferenceColumn,
  parsePrefixList,
  summarizeR2Objects,
} from '../src/lib/r2MediaGovernance'
import { pgPool } from '../src/dbAdapter'
import { r2DeleteObjects, r2ListObjects, r2Status } from '../src/r2'

dotenv.config({ path: path.resolve(__dirname, '../.env.local'), override: true })

const DELETE_CONFIRMATION = 'DELETE_R2_ORPHANS'
const DEFAULT_PREFIX = 'cleaning/'
const DEFAULT_OLDER_THAN_DAYS = 30
const DEFAULT_MAX_OBJECTS = 10000
const DEFAULT_MAX_ROWS_PER_COLUMN = 10000

type Args = {
  prefix: string
  olderThanDays: number
  maxObjects: number
  maxRowsPerColumn: number
  apply: boolean
  confirm: string
}

function flagValue(name: string) {
  const prefix = `--${name}=`
  const entry = process.argv.slice(2).find((item) => item.startsWith(prefix))
  return entry ? entry.slice(prefix.length) : undefined
}

function hasFlag(name: string) {
  return process.argv.slice(2).includes(`--${name}`)
}

function boundedNumber(raw: string | undefined, fallback: number, min: number, max: number) {
  const value = Number(raw)
  if (!Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.floor(value)))
}

function parseArgs(): Args {
  const prefix = flagValue('prefix') ?? String(process.env.R2_AUDIT_PREFIX || DEFAULT_PREFIX)
  return {
    prefix: prefix.trim(),
    olderThanDays: boundedNumber(flagValue('older-than-days') || process.env.R2_AUDIT_OLDER_THAN_DAYS, DEFAULT_OLDER_THAN_DAYS, 1, 3650),
    maxObjects: boundedNumber(flagValue('max-objects') || process.env.R2_AUDIT_MAX_OBJECTS, DEFAULT_MAX_OBJECTS, 1, 100000),
    maxRowsPerColumn: boundedNumber(flagValue('max-rows-per-column') || process.env.R2_AUDIT_MAX_ROWS_PER_COLUMN, DEFAULT_MAX_ROWS_PER_COLUMN, 100, 1000000),
    apply: hasFlag('apply'),
    confirm: flagValue('confirm') || '',
  }
}

function quoteIdentifier(value: string) {
  return `"${String(value || '').replace(/"/g, '""')}"`
}

async function collectReferencedKeys(maxRowsPerColumn: number) {
  assert(pgPool, 'Postgres is not configured')
  const columns = await pgPool.query(`
    SELECT table_schema, table_name, column_name, data_type, udt_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND (
        column_name ILIKE '%url%'
        OR column_name ILIKE '%uri%'
        OR column_name ILIKE '%key%'
        OR column_name ILIKE '%photo%'
        OR column_name ILIKE '%media%'
        OR column_name ILIKE '%file%'
        OR column_name ILIKE '%image%'
        OR column_name ILIKE '%video%'
        OR column_name ILIKE '%attachment%'
        OR column_name ILIKE '%proof%'
        OR column_name ILIKE '%document%'
      )
      AND column_name NOT ILIKE '%password%'
      AND column_name NOT ILIKE '%secret%'
      AND column_name NOT ILIKE '%token%'
      AND column_name NOT ILIKE '%credential%'
      AND column_name NOT ILIKE '%auth%'
      AND column_name NOT ILIKE '%access_key%'
      AND (
        data_type IN ('text', 'character varying', 'character')
        OR (data_type = 'ARRAY' AND udt_name = '_text')
        OR data_type IN ('json', 'jsonb')
      )
    ORDER BY table_name, ordinal_position
  `)
  const referenced = new Set<string>()
  let scannedSources = 0
  let scannedRows = 0
  for (const source of columns.rows || []) {
    if (!isReferenceColumn(String(source.column_name || ''))) continue
    const table = `${quoteIdentifier(String(source.table_schema))}.${quoteIdentifier(String(source.table_name))}`
    const column = quoteIdentifier(String(source.column_name))
    try {
      const rows = await pgPool.query(
        `SELECT CAST(${column} AS text) AS raw FROM ${table} WHERE ${column} IS NOT NULL LIMIT $1`,
        [maxRowsPerColumn],
      )
      scannedSources += 1
      scannedRows += Number(rows.rowCount || 0)
      for (const row of rows.rows || []) {
        for (const key of extractR2KeysFromValue(row.raw)) referenced.add(key)
      }
    } catch (error: any) {
      // A single legacy/incompatible table must not hide references found in
      // the rest of the database. Keep only a safe source-level diagnostic.
      console.warn(`[r2-audit] skipped_source table=${String(source.table_name)} column=${String(source.column_name)} code=${String(error?.code || 'QUERY_FAILED')}`)
    }
  }
  return { referenced, candidateSourceCount: Number(columns.rowCount || 0), scannedSources, scannedRows }
}

async function main() {
  const args = parseArgs()
  const status = r2Status()
  assert(status.hasR2, `R2 is not configured; missing=${status.missing.join(',')}`)
  assert(pgPool, 'Postgres is not configured')

  const minAgeMs = args.olderThanDays * 24 * 60 * 60 * 1000
  const [objects, references] = await Promise.all([
    r2ListObjects({ prefix: args.prefix, maxObjects: args.maxObjects }),
    collectReferencedKeys(args.maxRowsPerColumn),
  ])
  const summary = summarizeR2Objects(objects, references.referenced, Date.now(), minAgeMs)
  const report: Record<string, unknown> = {
    status: args.apply ? 'apply_requested' : 'dry_run',
    prefix: args.prefix,
    older_than_days: args.olderThanDays,
    max_objects: args.maxObjects,
    database_reference_keys: references.referenced.size,
    reference_candidate_columns: references.candidateSourceCount,
    scanned_reference_sources: references.scannedSources,
    scanned_reference_rows: references.scannedRows,
    ...summary,
    sample_eligible_orphan_keys: summary.eligible_orphan_keys.slice(0, 20),
  }
  delete report.eligible_orphan_keys

  if (args.apply) {
    const allowedPrefixes = parsePrefixList(process.env.R2_ORPHAN_DELETE_ALLOWED_PREFIXES)
    assert(isApprovedCleanupPrefix(args.prefix, allowedPrefixes), 'Deletion is disabled unless the exact prefix is listed in R2_ORPHAN_DELETE_ALLOWED_PREFIXES')
    assert(args.confirm === DELETE_CONFIRMATION, `Deletion requires --confirm=${DELETE_CONFIRMATION}`)
    const deletion = await r2DeleteObjects(summary.eligible_orphan_keys)
    report.status = 'applied'
    report.deleted_count = deletion.deleted.length
    report.delete_error_count = deletion.errors.length
    report.delete_errors = deletion.errors.slice(0, 20).map((item) => ({ key: item.key, code: item.code }))
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}

main()
  .catch((error: any) => {
    process.stderr.write(`[r2-audit] failed code=${String(error?.code || 'R2_AUDIT_FAILED')} message=${String(error?.message || error)}\n`)
    process.exitCode = 1
  })
  .finally(async () => {
    try { await pgPool?.end() } catch {}
  })
