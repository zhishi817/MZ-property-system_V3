import { getChromiumBrowser, resetChromiumBrowser } from '../../src/lib/playwright'

async function main() {
  const b1 = await getChromiumBrowser()
  const c1 = await b1.newContext()
  await c1.close()
  await resetChromiumBrowser()
  const b2 = await getChromiumBrowser()
  const c2 = await b2.newContext()
  await c2.close()
  await resetChromiumBrowser()
  process.stdout.write('ok\n')
}

main().catch((e) => {
  process.stderr.write(String(e?.stack || e?.message || e) + '\n')
  process.exit(1)
})
