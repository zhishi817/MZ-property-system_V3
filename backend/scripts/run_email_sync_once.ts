import dotenv from 'dotenv'
import path from 'path'
dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), override: true })
dotenv.config()
import { runEmailSyncJob } from '../src/modules/jobs'

async function main() {
  const res = await runEmailSyncJob({ mode: 'incremental', preview_limit: 5, max_per_run: 5, batch_size: 5, concurrency: 1, batch_sleep_ms: 0, min_interval_ms: 0 })
  console.log(JSON.stringify(res))
}

main().catch((e)=>{ console.error(e?.message || e) })