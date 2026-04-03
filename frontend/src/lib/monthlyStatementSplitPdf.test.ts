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

  it('renders order calendar as per-week print blocks and only auto-fits short calendars', () => {
    const p = path.join(process.cwd(), 'src', 'components', 'MonthlyStatement.tsx')
    const s = fs.readFileSync(p, 'utf8')
    expect(s).toContain("const calendarWeekCount = Math.max(1, endNext.subtract(1, 'day').endOf('week').diff(start.startOf('week'), 'week') + 1)")
    expect(s).toContain('const shouldAutoFitCalendar = isPdfMode && renderEngine === \'print\' && calendarWeekCount <= 4')
    expect(s).toContain('data-calendar-week="1"')
  })
})
