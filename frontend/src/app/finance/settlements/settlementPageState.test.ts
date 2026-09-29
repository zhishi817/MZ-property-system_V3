import { describe, expect, it } from 'vitest'
import { resolveSettlementLoadIssue } from './settlementPageState'

describe('settlement page load issue', () => {
  it('maps a missing Preview schema to one user-facing initialization state', () => {
    const issue = resolveSettlementLoadIssue(new Error('personnel_settlement_schema_not_ready'))

    expect(issue).toEqual({
      kind: 'schema_not_ready',
      message: '费用结算数据尚未初始化',
      description: '当前固定 Preview 尚未完成费用结算开发数据库初始化。完成初始化后刷新本页即可继续测试。',
    })
    expect(JSON.stringify(issue)).not.toContain('personnel_settlement_schema_not_ready')
  })

  it('does not expose an unexpected technical error to the page', () => {
    const issue = resolveSettlementLoadIssue(new Error('HTTP 500 secret implementation detail'))

    expect(issue.kind).toBe('request_failed')
    expect(JSON.stringify(issue)).not.toContain('secret implementation detail')
  })
})
