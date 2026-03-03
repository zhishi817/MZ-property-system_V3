import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

describe('invoice-print route', () => {
  it('renders template in top-level document (no iframe)', () => {
    const p = path.join(process.cwd(), 'src', 'app', 'public', 'invoice-print', 'page.tsx')
    const s = fs.readFileSync(p, 'utf8')
    expect(s).toContain('id="invoice-root"')
    expect(s).not.toContain('<iframe')
  })
})

