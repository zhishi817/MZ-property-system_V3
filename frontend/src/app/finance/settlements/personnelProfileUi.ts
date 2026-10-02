export function normalizeAustralianAbn(value: unknown) {
  return String(value ?? '').replace(/\D/g, '')
}

export function isValidAustralianAbn(value: unknown) {
  const digits = normalizeAustralianAbn(value)
  return /^\d{11}$/.test(digits)
}

export const PERSONNEL_PAYMENT_METHOD_LABELS = {
  bank_transfer: '银行转账',
  cash: '现金支付',
  foreign_currency: '外币支付',
  other: '其他支付方式',
} as const

export type PersonnelPaymentMethod = keyof typeof PERSONNEL_PAYMENT_METHOD_LABELS

export function normalizePersonnelPaymentMethod(value: unknown): PersonnelPaymentMethod {
  const normalized = String(value ?? '').trim() as PersonnelPaymentMethod
  return normalized in PERSONNEL_PAYMENT_METHOD_LABELS ? normalized : 'bank_transfer'
}

export function personnelPaymentMethodRequiresBankDetails(value: unknown) {
  return normalizePersonnelPaymentMethod(value) === 'bank_transfer'
}

const PROFILE_SAVE_ERROR_LABELS: Record<string, string> = {
  invalid_abn: 'ABN 必须为 11 位数字，请核对后再保存。',
  abn_required_for_gst: '选择“已注册 GST”前，请填写 11 位 ABN。',
  effective_date_in_future: '结算资料生效日期不能晚于今天。',
  change_reason_required: '请填写资料修改原因。',
  profile_effective_date_locked: '这个日期会影响已批准或已付款的历史结算，请选择更晚的结算资料生效日期。',
  profile_effective_date_forward_move_not_allowed: '当前版本的生效日期只能保持不变或向前调整；需要未来生效时请另建新版本。',
  profile_version_stale: '当前资料版本已经发生变化，请关闭编辑窗口、刷新列表后重试。',
}

export function personnelProfileSaveErrorMessage(error: any) {
  const code = String(error?.code || error?.message || '').trim()
  return PROFILE_SAVE_ERROR_LABELS[code] || String(error?.message || '人员结算资料保存失败')
}
