import dayjs, { type Dayjs } from 'dayjs'

export type ExpenseLikeForDate = {
  fixed_expense_id?: string
  month_key?: string
  created_at?: string
  due_date?: string
  occurred_at?: string
}

function normalizeMonthKey(v?: string): string | null {
  if (!v) return null
  const s = String(v).trim()
  if (/^\d{4}-\d{2}$/.test(s)) return s
  const d = dayjs(s)
  if (!d.isValid()) return null
  return d.format('YYYY-MM')
}

export function isMonthKeyBefore(a?: string, b?: string): boolean {
  const aa = normalizeMonthKey(a)
  const bb = normalizeMonthKey(b)
  if (!aa || !bb) return false
  return aa < bb
}

export function getExpenseMonthKey(exp: ExpenseLikeForDate, now: Dayjs): string {
  return (
    normalizeMonthKey(exp.month_key) ||
    normalizeMonthKey(exp.due_date) ||
    normalizeMonthKey(exp.occurred_at) ||
    normalizeMonthKey(exp.created_at) ||
    now.format('YYYY-MM')
  )
}

export function getExpenseDateForDisplay(exp: ExpenseLikeForDate, now: Dayjs = dayjs()): string | undefined {
  const isFixed = !!exp.fixed_expense_id
  if (!isFixed) return exp.occurred_at

  const expenseMonthKey = getExpenseMonthKey(exp, now)
  const currentMonthKey = now.format('YYYY-MM')
  const isPastMonth = isMonthKeyBefore(expenseMonthKey, currentMonthKey)

  if (isPastMonth) return exp.due_date || exp.occurred_at || exp.created_at
  return exp.created_at || exp.due_date || exp.occurred_at
}

