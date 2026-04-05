const path = require('path')
const dotenv = require('dotenv')
const { Pool } = require('pg')

dotenv.config({ path: path.join(__dirname, '..', '.env.local') })

const monthArg = String(process.argv[2] || '2026-03').trim()
if (!/^\d{4}-\d{2}$/.test(monthArg)) {
  console.error(`invalid month: ${monthArg}`)
  process.exit(1)
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})

async function queryValue(client, sql, params = []) {
  const res = await client.query(sql, params)
  return res.rows?.[0] || null
}

async function monthStats(client, table, monthKey) {
  const duplicateGroups = await queryValue(client, `
    SELECT COUNT(*)::int AS n
    FROM (
      SELECT fixed_expense_id, month_key
      FROM ${table}
      WHERE month_key = $1
        AND fixed_expense_id IS NOT NULL
        AND fixed_expense_id <> ''
      GROUP BY fixed_expense_id, month_key
      HAVING COUNT(*) > 1
    ) t
  `, [monthKey])
  const duplicateRows = await queryValue(client, `
    SELECT COALESCE(SUM(cnt - 1), 0)::int AS n
    FROM (
      SELECT COUNT(*)::int AS cnt
      FROM ${table}
      WHERE month_key = $1
        AND fixed_expense_id IS NOT NULL
        AND fixed_expense_id <> ''
      GROUP BY fixed_expense_id, month_key
      HAVING COUNT(*) > 1
    ) t
  `, [monthKey])
  const orphanRows = await queryValue(client, `
    SELECT COUNT(*)::int AS n
    FROM ${table} e
    WHERE e.month_key = $1
      AND e.fixed_expense_id IS NOT NULL
      AND e.fixed_expense_id <> ''
      AND (
        e.generated_from = 'recurring_payments'
        OR COALESCE(e.note, '') ILIKE 'Fixed payment%'
      )
      AND NOT EXISTS (
        SELECT 1 FROM recurring_payments rp WHERE rp.id = e.fixed_expense_id
      )
  `, [monthKey])
  return {
    duplicate_groups: Number(duplicateGroups?.n || 0),
    duplicate_rows: Number(duplicateRows?.n || 0),
    orphan_rows: Number(orphanRows?.n || 0),
  }
}

async function globalDuplicateRows(client, table) {
  const row = await queryValue(client, `
    SELECT COALESCE(SUM(cnt - 1), 0)::int AS n
    FROM (
      SELECT COUNT(*)::int AS cnt
      FROM ${table}
      WHERE fixed_expense_id IS NOT NULL
        AND fixed_expense_id <> ''
        AND month_key IS NOT NULL
        AND month_key <> ''
      GROUP BY fixed_expense_id, month_key
      HAVING COUNT(*) > 1
    ) t
  `)
  return Number(row?.n || 0)
}

async function cleanupTable(client, table) {
  const orphanDel = await client.query(`
    DELETE FROM ${table} e
    WHERE e.fixed_expense_id IS NOT NULL
      AND e.fixed_expense_id <> ''
      AND (
        e.generated_from = 'recurring_payments'
        OR COALESCE(e.note, '') ILIKE 'Fixed payment%'
      )
      AND NOT EXISTS (
        SELECT 1 FROM recurring_payments rp WHERE rp.id = e.fixed_expense_id
      )
    RETURNING id
  `)

  const dupDel = await client.query(`
    WITH ranked AS (
      SELECT
        id,
        ROW_NUMBER() OVER (
          PARTITION BY fixed_expense_id, month_key
          ORDER BY
            CASE WHEN COALESCE(status, '') = 'paid' THEN 0 ELSE 1 END,
            paid_date DESC NULLS LAST,
            due_date DESC NULLS LAST,
            occurred_at DESC NULLS LAST,
            created_at DESC NULLS LAST,
            id DESC
        ) AS rn
      FROM ${table}
      WHERE fixed_expense_id IS NOT NULL
        AND fixed_expense_id <> ''
        AND month_key IS NOT NULL
        AND month_key <> ''
    )
    DELETE FROM ${table} t
    USING ranked r
    WHERE t.id = r.id
      AND r.rn > 1
    RETURNING t.id
  `)

  return {
    deleted_orphans: Number(orphanDel.rowCount || 0),
    deleted_duplicates: Number(dupDel.rowCount || 0),
  }
}

async function ensureIndexes(client) {
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_property_expenses_fixed_month
    ON property_expenses(fixed_expense_id, month_key)
    WHERE fixed_expense_id IS NOT NULL
      AND fixed_expense_id <> ''
      AND month_key IS NOT NULL
      AND month_key <> ''
  `)
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_company_expenses_fixed_month
    ON company_expenses(fixed_expense_id, month_key)
    WHERE fixed_expense_id IS NOT NULL
      AND fixed_expense_id <> ''
      AND month_key IS NOT NULL
      AND month_key <> ''
  `)
}

;(async () => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const before = {
      focus_month: monthArg,
      property_expenses: await monthStats(client, 'property_expenses', monthArg),
      company_expenses: await monthStats(client, 'company_expenses', monthArg),
      global_duplicate_rows: {
        property_expenses: await globalDuplicateRows(client, 'property_expenses'),
        company_expenses: await globalDuplicateRows(client, 'company_expenses'),
      },
    }

    const cleaned = {
      property_expenses: await cleanupTable(client, 'property_expenses'),
      company_expenses: await cleanupTable(client, 'company_expenses'),
    }

    await ensureIndexes(client)

    const after = {
      focus_month: monthArg,
      property_expenses: await monthStats(client, 'property_expenses', monthArg),
      company_expenses: await monthStats(client, 'company_expenses', monthArg),
      global_duplicate_rows: {
        property_expenses: await globalDuplicateRows(client, 'property_expenses'),
        company_expenses: await globalDuplicateRows(client, 'company_expenses'),
      },
    }

    await client.query('COMMIT')
    console.log(JSON.stringify({ ok: true, before, cleaned, after }, null, 2))
  } catch (err) {
    try { await client.query('ROLLBACK') } catch {}
    console.error(err && err.stack ? err.stack : String(err))
    process.exitCode = 1
  } finally {
    client.release()
    await pool.end()
  }
})()
