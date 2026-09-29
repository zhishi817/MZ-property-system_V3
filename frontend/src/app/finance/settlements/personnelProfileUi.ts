export function normalizeAustralianAbn(value: unknown) {
  return String(value ?? '').replace(/\D/g, '')
}

export function isValidAustralianAbn(value: unknown) {
  const digits = normalizeAustralianAbn(value)
  return /^\d{11}$/.test(digits)
}

const PROFILE_SAVE_ERROR_LABELS: Record<string, string> = {
  invalid_abn: 'ABN 必须为 11 位数字，请核对后再保存。',
  abn_required: '启用费用结算前，请填写 11 位 ABN。',
  abn_required_for_gst: '选择“已注册 GST”前，请填写 11 位 ABN。',
  effective_date_in_future: '结算资料生效日期不能晚于今天。',
  change_reason_required: '请填写资料修改原因。',
  profile_effective_date_locked: '这个日期会影响已批准或已付款的历史结算，请选择更晚的结算资料生效日期。',
}

export function personnelProfileSaveErrorMessage(error: any) {
  const code = String(error?.code || error?.message || '').trim()
  return PROFILE_SAVE_ERROR_LABELS[code] || String(error?.message || '人员结算资料保存失败')
}
