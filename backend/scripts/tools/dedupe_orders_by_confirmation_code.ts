import { pgPool } from '../../src/dbAdapter'
import { syncOrderToCleaningTasks } from '../../src/services/cleaningSync'

async function main() {
  const rs = await pgPool.query(`
    SELECT confirmation_code, array_agg(id ORDER BY created_at DESC) AS ids
    FROM orders
    WHERE confirmation_code IS NOT NULL
    GROUP BY confirmation_code
    HAVING COUNT(*) > 1
  `)
  for (const row of rs.rows) {
    const ids: string[] = row.ids || []
    const keep = ids[0]
    const remove = ids.slice(1)
    if (remove.length) {
      await pgPool.query('DELETE FROM orders WHERE id = ANY($1)', [remove])
      for (const id of remove) {
        try { await syncOrderToCleaningTasks(String(id), { deleted: true }) } catch {}
      }
    }
    try { if (keep) await syncOrderToCleaningTasks(String(keep)) } catch {}
    console.log('dedup', row.confirmation_code, 'keep', keep, 'removed', remove.length)
  }
}

main().then(()=> process.exit(0)).catch((e)=> { console.error(e); process.exit(1) })
