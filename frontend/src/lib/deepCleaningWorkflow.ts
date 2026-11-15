import { deepCleaningMediaReferences } from './deepCleaningRecordDisplay'

type WorkflowRecord = { available_actions?: string[]; can_review?: boolean; can_assign?: boolean; assignee_id?: string | null }

export function mergeDeepCleaningAuthoritativeRow<T extends { id: string }>(current: T, incoming: Partial<T> & { id: string }): T {
  return String(current.id) === String(incoming.id) ? { ...current, ...incoming } : current
}

export function deepCleaningExecutorLabel(record: { assignee_id?: string; worker_name?: string }, users: { value: string; label: string }[] = []) {
  if (record.assignee_id) return record.worker_name || users.find(user => user.value === record.assignee_id)?.label || '已分配（人员名称待加载）'
  return record.worker_name ? `${record.worker_name}（历史姓名，未关联执行人员）` : '未分配'
}

export function deepCleaningNeedsReviewAssignee(row: WorkflowRecord) {
  return deepCleaningCanAct(row, 'review') && !String(row.assignee_id || '').trim()
}

export function deepCleaningCanAct(row: WorkflowRecord, action: 'assign' | 'complete' | 'review') {
  if (!Array.isArray(row.available_actions) || !row.available_actions.includes(action)) return false
  if (action === 'review') return row.can_review === true
  if (action === 'assign') return row.can_assign === true
  return true
}

export function newDeepCleaningOperationId() {
  return globalThis.crypto?.randomUUID?.() || `deep-cleaning-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function amount(value: unknown): number {
  if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) || Number(value) < 0) throw new Error('请填写有效金额；零费用请填 0')
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100
}

export function deepCleaningReviewPayload(values: Record<string, any>, operationId: string, record?: WorkflowRecord) {
  if (!['rent_deduction', 'tenant_pay', 'company_pay', 'landlord_pay', 'other_pay'].includes(values.pay_method)) throw new Error('请选择扣款方式')
  if (!['GST_INCLUDED_10', 'GST_10', 'GST_FREE', 'INPUT_TAXED'].includes(values.gst_type)) throw new Error('请选择 GST')
  const needsAssignee = record ? deepCleaningNeedsReviewAssignee(record) : false
  const assignee = String(values.assignee_id || '').trim()
  if (needsAssignee && !assignee) throw new Error('请为这条历史记录选择真实执行人')
  const base = { pricing_mode: values.pricing_mode, pay_method: values.pay_method, gst_type: values.gst_type, review_notes: String(values.review_notes || ''), operation_id: operationId, ...(needsAssignee ? { assignee_id: assignee } : {}) }
  if (values.pricing_mode === 'total') return { ...base, total_amount: amount(values.total_amount) }
  if (values.pricing_mode !== 'items' || !Array.isArray(values.price_items) || !values.price_items.length) throw new Error('请至少填写一个价格项目')
  const seen = new Set<string>()
  const price_items = values.price_items.map((item: any) => {
    const id = String(item?.id || '').trim()
    const description = String(item?.description || '').trim()
    if (!id || seen.has(id) || !description) throw new Error('请填写完整且不重复的价格项目')
    seen.add(id)
    return { id, description, amount: amount(item.amount) }
  })
  return { ...base, price_items }
}

export function deepCleaningCompletionPayload(after: unknown, addedBefore: unknown, note: unknown, operationId: string) {
  const completionPhotos = deepCleaningMediaReferences(after)
  if (!completionPhotos.length) throw new Error('请上传清洁后照片')
  const beforePhotos = deepCleaningMediaReferences(addedBefore)
  return {
    completion_photo_urls: completionPhotos,
    ...(beforePhotos.length ? { before_photo_urls: beforePhotos } : {}),
    completion_note: String(note || ''),
    operation_id: operationId,
  }
}

export function deepCleaningExecutionUploadReference(response: { remote_reference?: unknown; key?: unknown; url?: unknown } | null) {
  for (const candidate of [response?.remote_reference, response?.key, response?.url]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  }
  throw new Error('upload failed')
}
