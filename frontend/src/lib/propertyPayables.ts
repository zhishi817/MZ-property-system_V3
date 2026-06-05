import dayjs from 'dayjs'

export const PROPERTY_PAYABLE_TEMPLATE_KIND = 'property_payable'

export const PROPERTY_PAYABLE_CATEGORY_OPTIONS = [
  { value: 'electricity', label: '电费' },
  { value: 'water', label: '水费' },
  { value: 'gas_hot_water', label: '煤气/热水费' },
  { value: 'internet', label: '网费' },
  { value: 'owners_corp', label: '物业费' },
  { value: 'council_rate', label: '市政费' },
  { value: 'other', label: '其他' },
] as const

export const PROPERTY_PAYABLE_PAYMENT_TYPE_OPTIONS = [
  { value: 'bank_account', label: 'Bank account' },
  { value: 'bpay', label: 'Bpay' },
  { value: 'payid', label: 'PayID' },
  { value: 'cash', label: '现金' },
  { value: 'rent_deduction', label: '租金扣除' },
] as const

export const PROPERTY_PAYABLE_FREQUENCY_OPTIONS = [
  { value: 1, label: '每月' },
  { value: 2, label: '每两月' },
  { value: 3, label: '每季度' },
  { value: 6, label: '每半年' },
  { value: 12, label: '每年' },
] as const

export function propertyPayableCategoryLabel(value?: string) {
  const hit = PROPERTY_PAYABLE_CATEGORY_OPTIONS.find((item) => item.value === value)
  return hit?.label || value || '-'
}

export function propertyPayablePaymentTypeLabel(value?: string) {
  const hit = PROPERTY_PAYABLE_PAYMENT_TYPE_OPTIONS.find((item) => item.value === value)
  return hit?.label || value || '-'
}

export function defaultPropertyPayableTemplate() {
  return {
    vendor: '',
    category: 'electricity',
    amount: undefined,
    due_day_of_month: 15,
    frequency_months: 1,
    remind_days_before: 3,
    payment_type: 'bank_account',
    start_month_key: '',
    bill_account_no: '',
    note: '',
  }
}

export function formatPropertyPayableMonthKey(value: any): string {
  if (!value) return ''
  if (typeof value === 'string' && /^\d{4}-\d{2}$/.test(value.trim())) return value.trim()
  if (typeof value?.format === 'function') return value.format('YYYY-MM')
  const parsed = dayjs(value)
  return parsed.isValid() ? parsed.format('YYYY-MM') : ''
}

export function toPropertyPayableMonthValue(value: any) {
  const mk = formatPropertyPayableMonthKey(value)
  return mk ? dayjs(`${mk}-01`, 'YYYY-MM-DD') : null
}

export function hydratePropertyPayableTemplatesForForm(raw: any): any[] {
  return (Array.isArray(raw) ? raw : []).map((item) => ({
    ...item,
    start_month_key: toPropertyPayableMonthValue(item?.start_month_key),
  }))
}

export function normalizePropertyPayableTemplates(raw: any): any[] {
  return (Array.isArray(raw) ? raw : [])
    .map((item) => ({
      id: item?.id ? String(item.id) : undefined,
      vendor: String(item?.vendor || '').trim(),
      category: String(item?.category || '').trim(),
      category_detail: String(item?.category_detail || '').trim(),
      amount: item?.amount == null || item?.amount === '' ? undefined : Number(item.amount || 0),
      due_day_of_month: item?.due_day_of_month == null || item?.due_day_of_month === '' ? undefined : Number(item.due_day_of_month),
      frequency_months: item?.frequency_months == null || item?.frequency_months === '' ? undefined : Number(item.frequency_months),
      remind_days_before: item?.remind_days_before == null || item?.remind_days_before === '' ? 3 : Number(item.remind_days_before),
      payment_type: String(item?.payment_type || 'bank_account'),
      pay_account_name: String(item?.pay_account_name || '').trim(),
      pay_bsb: String(item?.pay_bsb || '').trim(),
      pay_account_number: String(item?.pay_account_number || '').trim(),
      pay_ref: String(item?.pay_ref || '').trim(),
      bpay_code: String(item?.bpay_code || '').trim(),
      pay_mobile_number: String(item?.pay_mobile_number || '').trim(),
      report_category: String(item?.report_category || '').trim(),
      start_month_key: formatPropertyPayableMonthKey(item?.start_month_key),
      bill_account_no: String(item?.bill_account_no || '').trim(),
      note: String(item?.note || '').trim(),
      template_kind: item?.template_kind ? String(item.template_kind) : undefined,
      status: item?.status ? String(item.status) : undefined,
    }))
    .filter((item) => item.vendor || item.category || item.bill_account_no || item.note || item.id)
}

export function propertyPayableSortBucket(row: { status?: string; is_overdue?: boolean; is_due_soon?: boolean; amount_confirmed?: boolean }) {
  if (row.status === 'paid') return 3
  if (row.is_overdue) return 0
  if (row.is_due_soon) return 1
  return 2
}

export function canMarkPropertyPayablePaid(row: { status?: string; amount_confirmed?: boolean }) {
  return row.status !== 'paid' && row.amount_confirmed === true
}
