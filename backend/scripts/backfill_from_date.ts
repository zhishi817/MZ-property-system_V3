import 'dotenv/config'
import { pgPool } from '../src/dbAdapter'
import { resolveUidSinceDate, runEmailSyncJob } from '../src/modules/jobs'

async function main() {
  const args = process.argv.slice(2)
  const accArg = args.find(a => a.startsWith('--account='))
  const startArg = args.find(a => a.startsWith('--start='))
  const account = accArg ? accArg.split('=')[1] : ''
  const startDate = startArg ? startArg.split('=')[1] : ''
  if (!account || !startDate) { console.error('usage: ts-node backfill_from_date.ts --account=<email> --start=YYYY-MM-DD'); process.exit(1) }
  const minUid = await resolveUidSinceDate(account, startDate)
  const setLast = Number(minUid) - 1
  await pgPool!.query('UPDATE email_sync_state SET last_uid=$2, last_backfill_at=now() WHERE account=$1', [account, setLast])
  console.log(JSON.stringify({ tag: 'backfill_cli', account, startDate, min_uid: minUid, set_last_uid: setLast, scan_limit: 50 }))
  const result = await runEmailSyncJob({ mode: 'incremental', account, max_per_run: 50, max_messages: 50, batch_size: 20, concurrency: 1, batch_sleep_ms: 0, min_interval_ms: 0, trigger_source: 'backfill_cli' })
  console.log(JSON.stringify({ tag: 'backfill_cli_done', stats: result?.stats || {} }))
}

main().catch((e) => { console.error(e); process.exit(1) })
