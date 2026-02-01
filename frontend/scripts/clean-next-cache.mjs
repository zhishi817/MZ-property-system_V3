import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = fileURLToPath(new URL('..', import.meta.url))
const nextDir = join(rootDir, '.next')
const full = process.argv.includes('--full')
const targets = full
  ? [nextDir]
  : [
      join(nextDir, 'server'),
      join(nextDir, 'static'),
      join(nextDir, 'cache'),
      join(nextDir, 'trace'),
    ]

try {
  for (const p of targets) {
    await rm(p, { recursive: true, force: true })
  }
} catch (e) {
  process.exitCode = 1
  console.error(e)
}
