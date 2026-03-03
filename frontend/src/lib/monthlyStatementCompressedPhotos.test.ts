import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

describe('monthly statement compressed photos', () => {
  it('supports compressed photos mode and passes photo_w/photo_q', () => {
    const p = path.join(process.cwd(), 'src', 'app', 'finance', 'company-overview', 'page.tsx')
    const s = fs.readFileSync(p, 'utf8')
    expect(s).toContain("'compressed'")
    expect(s).toContain('photo_w')
    expect(s).toContain('photo_q')
  })

  it('uses r2-image jpeg compression params in MonthlyStatement', () => {
    const p = path.join(process.cwd(), 'src', 'components', 'MonthlyStatement.tsx')
    const s = fs.readFileSync(p, 'utf8')
    expect(s).toContain("photosModeNorm === 'compressed'")
    expect(s).toContain('fmt=jpeg')
    expect(s).toContain('&w=')
    expect(s).toContain('&q=')
  })
})

