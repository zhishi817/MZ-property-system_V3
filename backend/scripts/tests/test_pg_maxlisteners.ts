import dotenv from 'dotenv'
import path from 'path'
dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), override: true })
dotenv.config()

process.env.PG_POOL_MAX = '1'

let warned = false
process.on('warning', (w: any) => {
  const name = String(w?.name || '')
  const msg = String(w?.message || '')
  if (name === 'MaxListenersExceededWarning' || /MaxListenersExceededWarning/i.test(msg)) {
    warned = true
    try { process.stderr.write(String(w?.stack || msg) + '\n') } catch {}
  }
})

async function main() {
  const { pgPool, pgRunInTransaction } = await import('../../src/dbAdapter')
  if (!pgPool) throw new Error('pg=false')

  for (let i = 0; i < 60; i++) {
    await pgRunInTransaction(async (client: any) => {
      await client.query('SELECT 1 AS ok')
      return true
    })
  }

  if (warned) throw new Error('MaxListenersExceededWarning detected')
  try { await pgPool.end() } catch {}
  process.stdout.write('ok\n')
}

main().catch((e) => {
  process.stderr.write(String(e?.stack || e?.message || e) + '\n')
  process.exit(1)
})
