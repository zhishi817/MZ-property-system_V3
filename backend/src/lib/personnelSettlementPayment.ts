export const PERSONNEL_PAYMENT_METHODS = [
  'bank_transfer',
  'cash',
  'foreign_currency',
  'other',
] as const

export type PersonnelPaymentMethod = typeof PERSONNEL_PAYMENT_METHODS[number]

const PERSONNEL_PAYMENT_METHOD_SET = new Set<string>(PERSONNEL_PAYMENT_METHODS)

export function isPersonnelPaymentMethod(value: unknown): value is PersonnelPaymentMethod {
  return PERSONNEL_PAYMENT_METHOD_SET.has(String(value ?? '').trim())
}

export function normalizePersonnelPaymentMethod(value: unknown): PersonnelPaymentMethod {
  return isPersonnelPaymentMethod(value) ? value : 'bank_transfer'
}

export function personnelPaymentMethodRequiresBankDetails(value: unknown) {
  return normalizePersonnelPaymentMethod(value) === 'bank_transfer'
}
