import dotenv from 'dotenv'
import path from 'path'
dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), override: true })
dotenv.config()

import { pgPool } from '../../src/dbAdapter'

async function main() {
  if (!pgPool) throw new Error('pg=false')

  const total = await pgPool.query('select count(*)::int as c from cleaning_tasks')
  const propSuffixBool = await pgPool.query("select count(*)::int as c from cleaning_tasks where property_id like '%true' or property_id like '%false'")
  const badPropTop = await pgPool.query("select property_id, count(*)::int as c from cleaning_tasks where property_id like '%true' or property_id like '%false' group by property_id order by c desc limit 20")
  const taskTypeBool = await pgPool.query("select count(*)::int as c from cleaning_tasks where task_type in ('true','false')")
  const taskTypeTop = await pgPool.query('select task_type, count(*)::int as c from cleaning_tasks group by task_type order by c desc limit 20')

  const missingProp = await pgPool.query(`
    SELECT COUNT(*)::int AS c
    FROM cleaning_tasks t
    LEFT JOIN properties p ON (p.id::text) = (t.property_id::text)
    WHERE t.property_id IS NOT NULL AND p.id IS NULL AND length(t.property_id) > 0
  `)
  const missingPropTop = await pgPool.query(`
    SELECT t.property_id, COUNT(*)::int AS c
    FROM cleaning_tasks t
    LEFT JOIN properties p ON (p.id::text) = (t.property_id::text)
    WHERE t.property_id IS NOT NULL AND p.id IS NULL AND length(t.property_id) > 0
    GROUP BY t.property_id
    ORDER BY c DESC
    LIMIT 20
  `)

  const sameDayDup = await pgPool.query(`
    SELECT COUNT(*)::int AS c
    FROM (
      SELECT property_id, COALESCE(task_date,date)::date AS d, COUNT(*) AS n
      FROM cleaning_tasks
      WHERE property_id IS NOT NULL AND COALESCE(task_date,date) IS NOT NULL
      GROUP BY property_id, COALESCE(task_date,date)::date
      HAVING COUNT(*) > 2
    ) x
  `)
  const sameDayDupTop = await pgPool.query(`
    SELECT property_id, COALESCE(task_date,date)::date AS d, COUNT(*)::int AS n
    FROM cleaning_tasks
    WHERE property_id IS NOT NULL AND COALESCE(task_date,date) IS NOT NULL
    GROUP BY property_id, COALESCE(task_date,date)::date
    HAVING COUNT(*) > 2
    ORDER BY n DESC
    LIMIT 20
  `)

  process.stdout.write(
    JSON.stringify(
      {
        total: total.rows?.[0]?.c ?? null,
        propSuffixBool: propSuffixBool.rows?.[0]?.c ?? null,
        badPropTop: badPropTop.rows || [],
        taskTypeBool: taskTypeBool.rows?.[0]?.c ?? null,
        taskTypeTop: taskTypeTop.rows || [],
        missingProp: missingProp.rows?.[0]?.c ?? null,
        missingPropTop: missingPropTop.rows || [],
        sameDayDupGroupsOver2: sameDayDup.rows?.[0]?.c ?? null,
        sameDayDupTop: sameDayDupTop.rows || [],
      },
      null,
      2
    ) + '\n'
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

