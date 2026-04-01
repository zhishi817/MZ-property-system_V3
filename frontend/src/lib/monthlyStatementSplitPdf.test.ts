import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

describe('monthly statement split pdf', () => {
  it('uses base sections for no-photos monthly statement', () => {
    const p = path.join(process.cwd(), 'src', 'app', 'finance', 'properties-overview', 'page.tsx')
    const s = fs.readFileSync(p, 'utf8')
    expect(s).toContain("const sectionsApi = photosMode === 'off' ? 'base' : 'all'")
    expect(s).toContain('/finance/merge-monthly-pack')
  })

  it('hides MONTHLY STATEMENT header for module-only pdfs', () => {
    const p = path.join(process.cwd(), 'src', 'components', 'MonthlyStatement.tsx')
    const s = fs.readFileSync(p, 'utf8')
    expect(s).toContain('hideReportHeader')
    expect(s).toContain('!hideReportHeader')
    expect(s).toContain('MONTHLY STATEMENT')
  })
})
