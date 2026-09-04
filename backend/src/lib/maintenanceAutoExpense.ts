import { normalizeMaintenanceWorkflowStatus } from './maintenanceWorkflow'

function toISODateOnly(value: any): string | null {
  if (!value) return null
  if (typeof value === 'string') {
    const text = value.trim()
    if (!text) return null
    if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10)
    const parsed = new Date(text)
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10)
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10)
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10)
}

export function maintenanceAutoExpenseStatus(row: any): 'completed' | 'void' {
  const rawStatus = String(row?.status || '').trim().toLowerCase()
  const workflowStatus = normalizeMaintenanceWorkflowStatus(row?.status, row?.review_status)
  const reviewStatus = String(row?.review_status || '').trim().toLowerCase()
  const terminalStatus = ['closed', 'completed', 'done', 'ready'].includes(rawStatus)
  return terminalStatus && workflowStatus === 'closed' && ['approved', 'closed'].includes(reviewStatus)
    ? 'completed'
    : 'void'
}

export function maintenanceAutoExpenseOccurredAt(row: any): string | null {
  return toISODateOnly(row?.completed_at)
    || toISODateOnly(row?.occurred_at)
    || toISODateOnly(row?.created_at)
}
