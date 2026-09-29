export type SettlementLoadIssue = {
  kind: 'schema_not_ready' | 'request_failed'
  message: string
  description: string
}

export function resolveSettlementLoadIssue(error: unknown): SettlementLoadIssue {
  const technicalMessage = String((error as any)?.message || error || '')

  if (technicalMessage.includes('personnel_settlement_schema_not_ready')) {
    return {
      kind: 'schema_not_ready',
      message: '费用结算数据尚未初始化',
      description: '当前固定 Preview 尚未完成费用结算开发数据库初始化。完成初始化后刷新本页即可继续测试。',
    }
  }

  return {
    kind: 'request_failed',
    message: '人员结算资料加载失败',
    description: '请确认开发后端已启动，然后重新加载。若仍然失败，请查看后端日志。',
  }
}
