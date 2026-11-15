import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { deepCleaningExecutionUploadReference, deepCleaningCompletionPayload, deepCleaningCanAct, deepCleaningExecutorLabel, mergeDeepCleaningAuthoritativeRow, deepCleaningNeedsReviewAssignee, deepCleaningReviewPayload } from './deepCleaningWorkflow'
import { deepCleaningVisibleAttachments } from './deepCleaningRecordDisplay'

const base = { pay_method: 'company_pay', gst_type: 'GST_INCLUDED_10' }
describe('deep cleaning workflow client contract', () => {
  it('merges the authoritative saved row by identity and distinguishes executor from submitter', () => {
    const before = { id: 'one', worker_name: '', status: 'pending', details: 'saved context' }
    const after = mergeDeepCleaningAuthoritativeRow(before, { id: 'one', worker_name: 'Finance person', status: 'assigned' })
    expect(after).toEqual({ ...before, worker_name: 'Finance person', status: 'assigned' })
    expect(mergeDeepCleaningAuthoritativeRow(before, { id: 'other', status: 'assigned' })).toBe(before)
    expect(deepCleaningExecutorLabel({ assignee_id: 'finance' }, [{ value: 'finance', label: 'Finance person' }])).toBe('Finance person')
    expect(deepCleaningExecutorLabel({ worker_name: 'Old text' })).toContain('历史姓名，未关联执行人员')
    expect(deepCleaningExecutorLabel({})).toBe('未分配')
  })
  it('fails closed without explicit server actions and capabilities', () => {
    expect(deepCleaningCanAct({}, 'review')).toBe(false)
    expect(deepCleaningCanAct({ available_actions: ['review'], can_review: false }, 'review')).toBe(false)
    expect(deepCleaningCanAct({ available_actions: [], can_review: true }, 'review')).toBe(false)
    expect(deepCleaningCanAct({ available_actions: ['review'], can_review: true }, 'review')).toBe(true)
    expect(deepCleaningCanAct({ available_actions: ['assign'], can_assign: true }, 'assign')).toBe(true)
  })
  it('distinguishes blank from zero and sends a whole-order price without adding consumables', () => {
    expect(() => deepCleaningReviewPayload({ ...base, pricing_mode: 'total', total_amount: null }, 'op')).toThrow()
    expect(deepCleaningReviewPayload({ ...base, pricing_mode: 'total', total_amount: 0, consumables: [{ cost: 50 }], price_items: [{ amount: 90 }] }, 'op')).toEqual({ ...base, pricing_mode: 'total', total_amount: 0, review_notes: '', operation_id: 'op' })
    expect(() => deepCleaningReviewPayload({ ...base, pricing_mode: 'total', total_amount: -1 }, 'op')).toThrow()
  })
  it('requires an explicit actual executor only for authorized reviews missing an assignee', () => {
    const missing = { available_actions: ['review'], can_review: true, assignee_id: null }
    const values = { ...base, pricing_mode: 'total', total_amount: 120 }
    expect(deepCleaningNeedsReviewAssignee(missing)).toBe(true)
    expect(deepCleaningNeedsReviewAssignee({ ...missing, can_review: false })).toBe(false)
    expect(() => deepCleaningReviewPayload(values, 'same-op', missing)).toThrow('真实执行人')
    expect(deepCleaningReviewPayload({ ...values, assignee_id: 'chosen-person' }, 'same-op', missing)).toMatchObject({ assignee_id: 'chosen-person', operation_id: 'same-op', total_amount: 120 })
    expect(deepCleaningReviewPayload({ ...values, assignee_id: 'different-person' }, 'same-op', { ...missing, assignee_id: 'existing-person' })).not.toHaveProperty('assignee_id')
    expect(deepCleaningNeedsReviewAssignee({ ...missing, available_actions: [] })).toBe(false)
  })
  it('sends only selected itemized prices, with stable IDs and no total double-counting', () => {
    const result = deepCleaningReviewPayload({ ...base, pricing_mode: 'items', total_amount: 999, price_items: [{ id: 'a', description: ' Kitchen ', amount: 10.25 }, { id: 'b', description: 'Bath', amount: 0 }] }, 'same-op')
    expect(result).toEqual({ ...base, pricing_mode: 'items', price_items: [{ id: 'a', description: 'Kitchen', amount: 10.25 }, { id: 'b', description: 'Bath', amount: 0 }], review_notes: '', operation_id: 'same-op' })
    expect(() => deepCleaningReviewPayload({ ...base, pricing_mode: 'items', price_items: [] }, 'op')).toThrow()
    expect(() => deepCleaningReviewPayload({ ...base, pricing_mode: 'items', price_items: [{ id: 'x', description: 'a', amount: null }] }, 'op')).toThrow()
    expect(() => deepCleaningReviewPayload({ ...base, pricing_mode: 'items', price_items: [{ id: 'x', description: 'a', amount: 1 }, { id: 'x', description: 'b', amount: 2 }] }, 'op')).toThrow()
    expect(() => deepCleaningReviewPayload({ ...base, pricing_mode: 'total', total_amount: 1, pay_method: '' }, 'op')).toThrow()
  })
  it('hides duplicate attachments for display without deleting persisted refs or conflating before and after', () => {
    const attachments = ['deep-cleaning/before', 'deep-cleaning/after', 'deep-cleaning/document']
    expect(deepCleaningVisibleAttachments(attachments, '["deep-cleaning/before"]', ['deep-cleaning/after'])).toEqual(['deep-cleaning/document'])
    expect(attachments).toHaveLength(3)
    expect(deepCleaningVisibleAttachments(attachments, [], [])).toEqual(attachments)
  })
  it('separates CRUD edits from workflow, keeps failed drawers open and avoids parallel review writes', () => {
    const page = readFileSync(new URL('../app/deep-cleaning/records/page.tsx', import.meta.url), 'utf8')
    const save = page.slice(page.indexOf('  async function saveEdit()'), page.indexOf('  async function openWorkflow('))
    expect(save).not.toMatch(/status:|assignee_id:|worker_name:|labor_cost:|total_cost:|pay_method:|review_status:|completed_at:/)
    expect(save).toContain('repair_photo_urls: deepCleaningMediaReferences(editAfterFiles')
    expect(save).toContain("repair_notes: String(v.repair_notes || '')")
    expect(save).not.toContain('/workflow/')
    expect(page).not.toContain('Promise.all([writePromise, reviewPromise])')
    expect(page).not.toContain("hasPerm('rbac.manage')")
    expect(page).toContain("const canWrite = mounted && hasPerm('property_deep_cleaning.write')")
    expect(page).toContain('useEffect(() => { setMounted(true) }, [])')
    expect(page).toContain("hidden: !deepCleaningCanAct(r, 'review')")
    expect(page).toContain('if (!res.ok) throw new Error')
    expect(page.indexOf('if (!res.ok) throw new Error', page.indexOf('async function submitWorkflow'))).toBeLessThan(page.indexOf('setWorkflow(null)', page.indexOf('async function submitWorkflow')))
    expect(page).toContain('operation_id: workflow.operationId')
    expect(page).toContain('await loadList(false)')
    const media = readFileSync(new URL('../components/DeepCleaningMedia.tsx', import.meta.url), 'utf8')
    expect(media).toContain("objectFit: 'contain'")
    expect(media).not.toContain("objectFit: 'cover'")
    expect(media).toContain('minmax(140px, 180px)')
  })
})

describe('completion before photo additions', () => {
  it('keeps added before and after separate and uses stable operation ID for retries', () => {
    const build = () => deepCleaningCompletionPayload(['after.png'], ['before-new.png', 'before-new.png'], 'note', 'same-op')
    expect(build()).toEqual({ completion_photo_urls: ['after.png'], before_photo_urls: ['before-new.png'], completion_note: 'note', operation_id: 'same-op' })
    expect(build()).toEqual(build())
  })
  it('omits empty additions for legacy-compatible requests and still requires after photos', () => {
    expect(deepCleaningCompletionPayload(['after.png'], [], '', 'op')).not.toHaveProperty('before_photo_urls')
    expect(() => deepCleaningCompletionPayload([], ['before.png'], '', 'op')).toThrow('请上传清洁后照片')
  })
})

it('prefers private execution upload reference and preserves legacy fallback', () => {
  expect(deepCleaningExecutionUploadReference({ remote_reference: 'r2://fixture/mzapp/a.png', key: 'mzapp/a.png', url: 'https://example.invalid/a.png' })).toBe('r2://fixture/mzapp/a.png')
  expect(deepCleaningExecutionUploadReference({ key: 'mzapp/a.png', url: 'url' })).toBe('mzapp/a.png')
  expect(deepCleaningExecutionUploadReference({ url: '/uploads/a.png' })).toBe('/uploads/a.png')
  expect(() => deepCleaningExecutionUploadReference(null)).toThrow('upload failed')
})
