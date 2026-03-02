import { AsyncSemaphore } from '../../src/lib/asyncSemaphore'

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

async function main() {
  const sem = new AsyncSemaphore(1, 50)
  let running = 0
  let maxRunning = 0
  const tasks = Array.from({ length: 8 }).map((_, i) =>
    sem.runExclusive(async () => {
      running += 1
      if (running > maxRunning) maxRunning = running
      await sleep(30 + (i % 3) * 10)
      running -= 1
      return i
    })
  )
  await Promise.all(tasks)
  if (maxRunning !== 1) throw new Error(`expected maxRunning=1 but got ${maxRunning}`)
  process.stdout.write('ok\n')
}

main().catch((e) => {
  process.stderr.write(String(e?.stack || e?.message || e) + '\n')
  process.exit(1)
})
