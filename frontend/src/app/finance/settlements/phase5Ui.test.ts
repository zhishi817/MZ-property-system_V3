import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'

describe('personnel settlement phase 5 web contract', () => {
  const panel = fs.readFileSync(path.resolve(process.cwd(), 'src/app/finance/settlements/WeeklySettlementsPanel.tsx'), 'utf8')
  const api = fs.readFileSync(path.resolve(process.cwd(), 'src/lib/api.ts'), 'utf8')

  it('keeps finance focused on partner-submitted settlements and document history', () => {
    expect(panel).not.toContain("'/finance/settlements/weekly/run'")
    expect(panel).not.toContain("'/finance/settlements/weekly/generate'")
    expect(panel).not.toContain('批量生成与发起记录')
    expect(panel).not.toContain('周任务运行记录')
    expect(panel).toContain('重算并退回合作方确认')
    expect(panel).toContain('确认已核对')
    expect(panel).toContain('确认已付款')
    expect(panel).toContain('查看 PDF')
  })

  it('downloads protected PDF bytes through the authenticated API helper', () => {
    expect(panel).toContain('await getBlob(')
    expect(panel).toContain('/documents/${encodeURIComponent(document.id)}')
    expect(api).toContain('export async function getBlob')
    expect(panel).not.toContain('storage_key')
  })
})
