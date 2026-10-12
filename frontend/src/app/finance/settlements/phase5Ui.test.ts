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

  it('shows execution, incomplete, moved, and legacy-preserved settlement states', () => {
    expect(panel).toContain("completed: { label: '已完成'")
    expect(panel).toContain("incomplete: { label: '未完成'")
    expect(panel).toContain("rescheduled: { label: '改期/跨日'")
    expect(panel).toContain("management_closed: { label: '管理关闭'")
    expect(panel).toContain("legacy_completed_unverified: { label: '历史完成待核实'")
    expect(panel).toContain('本周房源工作清单')
    expect(panel).toContain('为兼容历史已冻结结算而保留的原金额')
    expect(panel).toContain('已计入金额')
    expect(panel).toContain('不计费')
  })
})
