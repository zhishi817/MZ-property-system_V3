import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { canSubmitPublicDeepCleaning, publicDeepCleaningPayload } from './deepCleaningPublicShare'

describe('public deep cleaning evidence-only boundary', () => {
  const media = { before: ['before-ref'], after: ['after-ref'], attachments: ['attachment-ref'] }
  it('ordinary evidence save never sends state, prices, assignment, schedule or review changes', () => {
    const result = publicDeepCleaningPayload({ details: 'Cleaned kitchen', repair_notes: 'done', labor_minutes: 0, status: 'completed', review_status: 'pending', labor_cost: 100, total_cost: 200, consumables: [{ cost: 50 }], assignee_id: 'untrusted', eta: '2026-11-12' }, media)
    expect(result).toEqual({ urgency: undefined, details: 'Cleaned kitchen', repair_notes: 'done', labor_minutes: 0, photo_urls: ['before-ref'], repair_photo_urls: ['after-ref'], attachment_urls: ['attachment-ref'], checklist: [] })
    expect(media.after).toEqual(['after-ref'])
  })
  it('only explicit completion submits pending review and requires after evidence', () => {
    expect(publicDeepCleaningPayload({}, media, true)).toMatchObject({ status: 'pending_review' })
    expect(publicDeepCleaningPayload({}, media, true)).not.toHaveProperty('review_status')
    expect(() => publicDeepCleaningPayload({}, { ...media, after: [] }, true)).toThrow('清洁后照片')
    expect(publicDeepCleaningPayload({}, { ...media, after: [] })).not.toHaveProperty('status')
  })
  it('does not offer resubmission of pending/approved/history terminal records', () => {
    expect(canSubmitPublicDeepCleaning({ status: 'assigned', review_status: 'pending' })).toBe(true)
    expect(canSubmitPublicDeepCleaning({ status: 'pending_review', review_status: 'pending' })).toBe(false)
    expect(canSubmitPublicDeepCleaning({ status: 'completed', review_status: 'pending' })).toBe(false)
    expect(canSubmitPublicDeepCleaning({ status: 'assigned', review_status: 'approved' })).toBe(false)
    expect(canSubmitPublicDeepCleaning({ status: 'canceled' })).toBe(false)
    expect(canSubmitPublicDeepCleaning(null)).toBe(false)
  })
  it('retains share-password auth and uploads without adding directory/price controls', () => {
    const page = readFileSync(new URL('../app/public/deep-cleaning-share/[token]/page.tsx', import.meta.url), 'utf8')
    expect(page).toContain('body: JSON.stringify({ token: shareId, password })')
    expect(page).toContain('Authorization: `Bearer ${shareJwt}`')
    expect(page).toContain('/public/deep-cleaning-share/upload')
    expect(page).toContain('已有耗材记录只读')
    expect(page).toContain('金额由管理员确认')
    expect(page).toContain('publicDeepCleaningPayload(v,')
    expect(page).not.toContain('name="status"')
    expect(page).not.toContain('name="labor_cost"')
    expect(page).not.toContain("name={[f.name, 'cost']}")
    expect(page).not.toContain('/deep-cleaning/executors')
  })
})
