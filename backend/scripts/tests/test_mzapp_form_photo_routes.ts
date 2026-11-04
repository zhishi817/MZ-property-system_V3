import assert from 'node:assert/strict'
import express from 'express'
import sharp from 'sharp'

process.env.DATABASE_URL = ''
process.env.MZ_DEV_PREVIEW_DISABLE_RUNTIME_DDL = '1'

type FixtureTask = {
  id: string
  task_date: string
  property_id: string
  property_code: string
  task_type: string
  status: string
  execution_state: string
  order_id: string | null
  order_checkin: string | null
  order_checkout: string | null
  inspector_id: string | null
  cleaner_id: string | null
  assignee_id: string | null
  inspection_mode?: string | null
  inspection_scope?: string | null
  linked_checkout_task_id?: string | null
}

type FixtureMedia = {
  id: string
  task_id: string
  type: string
  url: string
  uploader_id: string | null
  created_at?: string | Date
}

const tasks: FixtureTask[] = [
  {
    id: 'manual-checkout-active',
    task_date: '2026-10-22',
    property_id: 'property-7',
    property_code: 'ROUTE-707',
    task_type: 'checkout_clean',
    status: 'done',
    execution_state: 'active',
    order_id: null,
    order_checkin: null,
    order_checkout: null,
    inspector_id: null,
    cleaner_id: 'manual-cleaner-1',
    assignee_id: null,
  },
  {
    id: 'manual-checkin-active',
    task_date: '2026-10-22',
    property_id: 'property-7',
    property_code: 'ROUTE-707',
    task_type: 'checkin_clean',
    status: 'done',
    execution_state: 'active',
    order_id: null,
    order_checkin: null,
    order_checkout: null,
    inspector_id: 'manual-inspector-1',
    cleaner_id: null,
    assignee_id: 'manual-inspector-1',
    inspection_scope: 'inspect_and_hang',
    linked_checkout_task_id: 'manual-checkout-active',
  },
  {
    id: 'self-complete-active',
    task_date: '2026-10-20',
    property_id: 'property-6',
    property_code: 'ROUTE-606',
    task_type: 'checkout_clean',
    status: 'keys_hung',
    execution_state: 'active',
    order_id: 'self-complete-order',
    order_checkin: '2026-10-18',
    order_checkout: '2026-10-20',
    inspector_id: null,
    cleaner_id: 'cleaner-1',
    assignee_id: null,
    inspection_mode: 'self_complete',
  },
  {
    id: 'checkout-active',
    task_date: '2026-10-21',
    property_id: 'property-1',
    property_code: 'ROUTE-101',
    task_type: 'checkout_clean',
    status: 'done',
    execution_state: 'active',
    order_id: 'checkout-order',
    order_checkin: '2026-10-18',
    order_checkout: '2026-10-21',
    inspector_id: null,
    cleaner_id: 'cleaner-1',
    assignee_id: null,
  },
  {
    id: 'checkin-active',
    task_date: '2026-10-21',
    property_id: 'property-1',
    property_code: 'ROUTE-101',
    task_type: 'checkin_clean',
    status: 'done',
    execution_state: 'active',
    order_id: 'checkin-order',
    order_checkin: '2026-10-21',
    order_checkout: '2026-10-24',
    inspector_id: 'inspector-1',
    cleaner_id: null,
    assignee_id: 'inspector-1',
  },
  {
    id: 'same-day-independent',
    task_date: '2026-10-21',
    property_id: 'property-1',
    property_code: 'ROUTE-101',
    task_type: 'checkin_clean',
    status: 'done',
    execution_state: 'active',
    order_id: null,
    order_checkin: null,
    order_checkout: null,
    inspector_id: 'inspector-1',
    cleaner_id: null,
    assignee_id: 'inspector-1',
  },
  {
    id: 'password-only-execution',
    task_date: '2026-10-31',
    property_id: 'property-106',
    property_code: '3804609',
    task_type: 'checkin_clean',
    status: 'inspected',
    execution_state: 'active',
    order_id: 'password-only-order',
    order_checkin: '2026-10-31',
    order_checkout: '2026-11-02',
    inspector_id: null,
    cleaner_id: null,
    assignee_id: 'mia-1',
    inspection_mode: 'same_day',
    inspection_scope: 'password_only',
  },
  {
    id: 'password-only-cancelled',
    task_date: '2026-10-30',
    property_id: 'property-106-cancelled',
    property_code: '3804610',
    task_type: 'checkin_clean',
    status: 'cancelled',
    execution_state: 'cancelled',
    order_id: 'password-only-cancelled-order',
    order_checkin: '2026-10-30',
    order_checkout: '2026-11-01',
    inspector_id: null,
    cleaner_id: null,
    assignee_id: 'mia-1',
    inspection_mode: 'same_day',
    inspection_scope: 'password_only',
  },
  {
    id: 'password-only-inspector-fallback',
    task_date: '2026-10-29',
    property_id: 'property-106-fallback',
    property_code: '3804611',
    task_type: 'checkin_clean',
    status: 'inspected',
    execution_state: 'active',
    order_id: 'password-only-fallback-order',
    order_checkin: '2026-10-29',
    order_checkout: '2026-11-01',
    inspector_id: 'fallback-inspector-1',
    cleaner_id: null,
    assignee_id: null,
    inspection_mode: 'same_day',
    inspection_scope: 'password_only',
  },
  {
    id: 'password-only-reassigned',
    task_date: '2026-10-28',
    property_id: 'property-106-reassigned',
    property_code: '3804612',
    task_type: 'checkin_clean',
    status: 'inspected',
    execution_state: 'active',
    order_id: 'password-only-reassigned-order',
    order_checkin: '2026-10-28',
    order_checkout: '2026-10-31',
    inspector_id: 'replacement-inspector-1',
    cleaner_id: null,
    assignee_id: 'replacement-executor-1',
    inspection_mode: 'same_day',
    inspection_scope: 'password_only',
  },
  {
    id: 'password-only-dual-assignment',
    task_date: '2026-10-27',
    property_id: 'property-106-dual',
    property_code: '3804613',
    task_type: 'checkin_clean',
    status: 'inspected',
    execution_state: 'active',
    order_id: 'password-only-dual-order',
    order_checkin: '2026-10-27',
    order_checkout: '2026-10-30',
    inspector_id: 'stale-inspector-1',
    cleaner_id: null,
    assignee_id: 'current-password-executor-1',
    inspection_mode: 'same_day',
    inspection_scope: 'password_only',
  },
  {
    id: 'password-only-replaced-video',
    task_date: '2026-10-26',
    property_id: 'property-106-replaced',
    property_code: '3804614',
    task_type: 'checkin_clean',
    status: 'inspected',
    execution_state: 'active',
    order_id: 'password-only-replaced-order',
    order_checkin: '2026-10-26',
    order_checkout: '2026-10-29',
    inspector_id: null,
    cleaner_id: null,
    assignee_id: 'later-replacement-executor-1',
    inspection_mode: 'same_day',
    inspection_scope: 'password_only',
  },
  {
    id: 'feedback-task',
    task_date: '2026-10-21',
    property_id: 'property-1',
    property_code: 'ROUTE-101',
    task_type: 'checkout_clean',
    status: 'done',
    execution_state: 'active',
    order_id: 'feedback-order',
    order_checkin: '2026-10-19',
    order_checkout: '2026-10-21',
    inspector_id: 'inspector-1',
    cleaner_id: 'cleaner-1',
    assignee_id: null,
  },
  {
    id: 'reassigned-task',
    task_date: '2026-10-20',
    property_id: 'property-2',
    property_code: 'ROUTE-202',
    task_type: 'checkout_clean',
    status: 'done',
    execution_state: 'active',
    order_id: 'reassigned-order',
    order_checkin: '2026-10-18',
    order_checkout: '2026-10-20',
    inspector_id: null,
    cleaner_id: 'cleaner-2',
    assignee_id: null,
  },
  {
    id: 'cancelled-task',
    task_date: '2026-10-19',
    property_id: 'property-3',
    property_code: 'ROUTE-303',
    task_type: 'checkout_clean',
    status: 'cancelled',
    execution_state: 'cancelled',
    order_id: 'cancelled-order',
    order_checkin: '2026-10-17',
    order_checkout: '2026-10-19',
    inspector_id: null,
    cleaner_id: 'cleaner-1',
    assignee_id: null,
  },
  {
    id: 'deleted-task',
    task_date: '2026-10-18',
    property_id: 'property-4',
    property_code: 'ROUTE-404',
    task_type: 'checkout_clean',
    status: 'done',
    execution_state: 'deleted',
    order_id: 'deleted-order',
    order_checkin: '2026-10-16',
    order_checkout: '2026-10-18',
    inspector_id: null,
    cleaner_id: 'cleaner-1',
    assignee_id: null,
  },
  {
    id: 'superseded-task',
    task_date: '2026-10-17',
    property_id: 'property-5',
    property_code: 'ROUTE-505',
    task_type: 'checkout_clean',
    status: 'done',
    execution_state: 'superseded',
    order_id: null,
    order_checkin: null,
    order_checkout: null,
    inspector_id: null,
    cleaner_id: 'cleaner-1',
    assignee_id: null,
  },
]

const media: FixtureMedia[] = [
  { id: 'manual-key-1', task_id: 'manual-checkout-active', type: 'key_photo', url: 'cleaning/route/manual-key.jpg', uploader_id: 'manual-cleaner-1' },
  { id: 'completion-1', task_id: 'checkout-active', type: 'completion_living', url: 'cleaning/route/cleaner-own.jpg', uploader_id: 'cleaner-1' },
  { id: 'key-1', task_id: 'checkout-active', type: 'key_photo', url: 'cleaning/route/guest-key.jpg', uploader_id: 'cleaner-1' },
  { id: 'lockbox-1', task_id: 'checkout-active', type: 'lockbox_video', url: 'cleaning/route/lockbox.mp4', uploader_id: 'cleaner-1' },
  { id: 'self-complete-lockbox', task_id: 'self-complete-active', type: 'lockbox_video', url: 'cleaning/route/self-complete-lockbox.mp4', uploader_id: 'cleaner-1' },
  { id: 'inspection-1', task_id: 'checkin-active', type: 'inspection_living', url: 'cleaning/route/inspector-own.jpg', uploader_id: 'inspector-1' },
  { id: 'inspection-unclean', task_id: 'checkin-active', type: 'inspection_unclean', url: 'cleaning/route/inspection-unclean.jpg', uploader_id: 'inspector-1' },
  { id: 'inspection-lockbox', task_id: 'checkin-active', type: 'lockbox_video', url: 'cleaning/route/inspector-lockbox.mp4', uploader_id: 'inspector-1' },
  { id: 'password-only-lockbox', task_id: 'password-only-execution', type: 'lockbox_video', url: 'cleaning/route/password-only-lockbox.mp4', uploader_id: 'mia-1' },
  { id: 'password-only-completion', task_id: 'password-only-execution', type: 'completion_living', url: 'cleaning/route/password-only-cleaner.jpg', uploader_id: 'legacy-cleaner-1' },
  { id: 'password-only-inspection', task_id: 'password-only-execution', type: 'inspection_living', url: 'cleaning/route/password-only-inspection.jpg', uploader_id: 'mia-1' },
  { id: 'password-only-cancelled-lockbox', task_id: 'password-only-cancelled', type: 'lockbox_video', url: 'cleaning/route/password-only-cancelled.mp4', uploader_id: 'mia-1' },
  { id: 'password-only-fallback-lockbox', task_id: 'password-only-inspector-fallback', type: 'lockbox_video', url: 'cleaning/route/password-only-fallback.mp4', uploader_id: 'legacy-video-writer' },
  { id: 'password-only-fallback-inspection', task_id: 'password-only-inspector-fallback', type: 'inspection_living', url: 'cleaning/route/password-only-fallback-inspection.jpg', uploader_id: 'fallback-inspector-1' },
  { id: 'password-only-fallback-key', task_id: 'password-only-inspector-fallback', type: 'key_photo', url: 'cleaning/route/password-only-fallback-key.jpg', uploader_id: 'fallback-inspector-1' },
  { id: 'password-only-fallback-restock', task_id: 'password-only-inspector-fallback', type: 'restock_proof:soap', url: 'cleaning/route/password-only-fallback-restock.jpg', uploader_id: 'fallback-inspector-1' },
  { id: 'password-only-reassigned-lockbox', task_id: 'password-only-reassigned', type: 'lockbox_video', url: 'cleaning/route/password-only-reassigned.mp4', uploader_id: 'service-video-writer-1', created_at: '2026-10-28T01:00:00.000Z' },
  { id: 'password-only-reassigned-inspection', task_id: 'password-only-reassigned', type: 'inspection_living', url: 'cleaning/route/password-only-reassigned-inspection.jpg', uploader_id: 'former-password-executor-1' },
  { id: 'password-only-reassigned-completion', task_id: 'password-only-reassigned', type: 'completion_living', url: 'cleaning/route/password-only-reassigned-completion.jpg', uploader_id: 'former-password-executor-1' },
  { id: 'password-only-dual-lockbox', task_id: 'password-only-dual-assignment', type: 'lockbox_video', url: 'cleaning/route/password-only-dual.mp4', uploader_id: 'current-password-executor-1', created_at: '2026-10-27T01:00:00.000Z' },
  { id: 'password-only-replaced-lockbox', task_id: 'password-only-replaced-video', type: 'lockbox_video', url: 'cleaning/route/password-only-replaced.mp4', uploader_id: null, created_at: '2026-10-26T02:00:00.000Z' },
  { id: 'reassigned-1', task_id: 'reassigned-task', type: 'completion_kitchen', url: 'cleaning/route/former-cleaner.jpg', uploader_id: 'cleaner-1' },
  { id: 'reassigned-video', task_id: 'reassigned-task', type: 'lockbox_video', url: 'cleaning/route/former-cleaner.mp4', uploader_id: 'cleaner-1' },
  { id: 'reassigned-replacement', task_id: 'reassigned-task', type: 'completion_living', url: 'cleaning/route/replacement-cleaner.jpg', uploader_id: 'cleaner-2' },
  { id: 'cancelled-1', task_id: 'cancelled-task', type: 'completion_bedroom', url: 'cleaning/route/cancelled.jpg', uploader_id: 'cleaner-1' },
  { id: 'deleted-1', task_id: 'deleted-task', type: 'completion_bedroom', url: 'cleaning/route/deleted.jpg', uploader_id: 'cleaner-1' },
  { id: 'superseded-1', task_id: 'superseded-task', type: 'completion_bedroom', url: 'cleaning/route/superseded.jpg', uploader_id: 'cleaner-1' },
  { id: 'ownerless-1', task_id: 'checkout-active', type: 'consumable_item_photo:coffee', url: 'cleaning/route/ownerless.jpg', uploader_id: null },
]

const feedbackMedia = [
  {
    feedback_source_type: 'property_maintenance',
    feedback_source_id: 'feedback-active',
    property_id: 'property-1',
    source_task_id: 'feedback-task',
    created_by_user_id: 'cleaner-1',
    photo_urls: ['mzapp/feedback/active.jpg'],
  },
  {
    feedback_source_type: 'property_maintenance',
    feedback_source_id: 'feedback-cancelled',
    property_id: 'property-3',
    source_task_id: 'cancelled-task',
    created_by_user_id: 'cleaner-1',
    photo_urls: ['mzapp/feedback/cancelled.jpg'],
  },
  {
    feedback_source_type: 'property_maintenance',
    feedback_source_id: 'feedback-deleted',
    property_id: 'property-4',
    source_task_id: 'deleted-task',
    created_by_user_id: 'cleaner-1',
    photo_urls: ['mzapp/feedback/deleted.jpg'],
  },
  {
    feedback_source_type: 'property_maintenance',
    feedback_source_id: 'feedback-superseded',
    property_id: 'property-5',
    source_task_id: 'superseded-task',
    created_by_user_id: 'cleaner-1',
    photo_urls: ['mzapp/feedback/superseded.jpg'],
  },
]

const historicalFeedbackMedia = [{
  feedback_source_type: 'property_maintenance',
  feedback_source_id: 'feedback-historical',
  property_id: 'property-1',
  source_task_id: null,
  created_by_user_id: null,
  photo_urls: ['mzapp/feedback/historical-event.jpg'],
  before_photo_urls: null,
  after_photo_urls: null,
  repair_photo_urls: null,
  completion_photo_urls: null,
  attachment_urls: null,
  project_items: null,
  assignee_id: 'replacement-repairer',
  work_task_id: 'property_maintenance:feedback-historical',
  historical_work_record_media: true,
  work_record_actor_user_id: 'repairer-1',
}]

const completionEvidence = new Map<string, Set<string>>([
  ['cleaner-1', new Set(['checkout-active', 'self-complete-active', 'reassigned-task', 'cancelled-task', 'deleted-task', 'superseded-task'])],
])
const inspectionEvidence = new Map<string, Set<string>>([
  ['inspector-1', new Set(['checkin-active', 'same-day-independent'])],
  ['inspection-only-historical-1', new Set(['password-only-reassigned'])],
])
const accessVideoEvidence = new Map<string, Set<string>>([
  ['former-password-executor-1', new Set(['password-only-reassigned'])],
  ['cross-source-video-actor-1', new Set(['password-only-execution'])],
  ['old-replaced-video-actor-1', new Set(['password-only-replaced-video'])],
  ['replacement-video-executor-1', new Set(['password-only-replaced-video'])],
])
const currentVideoAuditActorByTask = new Map<string, string>([
  ['password-only-reassigned', 'former-password-executor-1'],
  ['password-only-replaced-video', 'replacement-video-executor-1'],
])
const inspectionSubmissionReceipts = new Map([
  ['checkin-active', {
    submit_id: 'inspection-batch-checkin-active',
    created_at: '2026-10-21T01:02:00.000Z',
    updated_at: '2026-10-21T01:03:00.000Z',
  }],
])

// MZ-081 / AU2117-shaped evidence: inspection is assigned on the check-in
// source while the cleaner's supplies evidence belongs to the checkout source.
const cleaningProofMedia: FixtureMedia[] = [
  { id: 'supplies-1', task_id: 'checkout-active', type: 'consumable_item_photo:toilet_paper', url: 'cleaning/route/cleaner-supplies.jpg', uploader_id: 'cleaner-1' },
  { id: 'restock-1', task_id: 'checkout-active', type: 'restock_proof:toilet_paper', url: 'cleaning/route/cleaner-restock.jpg', uploader_id: 'cleaner-1' },
  { id: 'supplies-legacy-media', task_id: 'checkout-active', type: 'consumable_item_photo', url: 'cleaning/route/cleaner-legacy-media.jpg', uploader_id: 'cleaner-1' },
  { id: 'other-inspector-restock', task_id: 'checkout-active', type: 'restock_proof:soap', url: 'cleaning/route/unrelated-restock.jpg', uploader_id: 'former-inspector' },
]
const usageProofs: any[] = []

function taskRows(ids: string[]) {
  const requested = new Set(ids.map(String))
  return tasks.filter((task) => requested.has(task.id))
}

function auditRows(ids: string[], userId: string, action: string) {
  const evidence = action === 'submit_inspection'
    ? inspectionEvidence
    : action === 'upload_access_video'
      ? accessVideoEvidence
      : completionEvidence
  const owned = evidence.get(userId) || new Set<string>()
  return ids.filter((id) => owned.has(id)).map((source_id) => ({ source_id }))
}

const dbAdapter = require('../../src/dbAdapter')
dbAdapter.hasPg = true
dbAdapter.pgPool = {
  async query(sql0: string, params: any[] = []) {
    const sql = String(sql0 || '')
    if (/^\s*(CREATE|ALTER|INSERT|UPDATE|DELETE|DROP|TRUNCATE|REPLACE|MERGE|GRANT|REVOKE)\b/i.test(sql)) {
      throw new Error(`write SQL is forbidden in this read-only route test: ${sql.replace(/\s+/g, ' ').slice(0, 180)}`)
    }
    if (/SELECT 1 FROM schema_migrations WHERE version=\$1 LIMIT 1/.test(sql)) {
      return { rows: [{ '?column?': 1 }], rowCount: 1 }
    }
    if (/LIMIT 0/.test(sql) && /FROM (property_maintenance|external_maintenance_orders|maintenance_workflow_events|work_tasks)/.test(sql)) {
      return { rows: [], rowCount: 0 }
    }
    if (/WITH scheduled_match_ids AS MATERIALIZED/.test(sql) && /current_lockbox_video_actor AS MATERIALIZED/.test(sql)) {
      const userId = String(params[2] || '')
      if (!['former-password-executor-1', 'service-video-writer-1'].includes(userId)) return { rows: [], rowCount: 0 }
      const task = tasks.find((item) => item.id === 'password-only-reassigned')!
      const rows = [{
        ...task,
        property_id: null,
        property_code: null,
        historical_evidence: true,
        order_keys_required: 1,
        keys_required: 1,
        assignee_name: 'Replacement',
        cleaner_name: null,
        inspector_name: 'Replacement inspector',
        lockbox_video_url: null,
        key_photo_url: null,
        living_room_photo_url: null,
        lockbox_audit_action: 'upload_access_video',
        lockbox_audit_performed_at: '2026-10-28T01:00:00.000Z',
        lockbox_audit_status_before: 'in_progress',
        lockbox_audit_status_after: 'inspected',
        lockbox_audit_metadata: {},
        has_current_lockbox_video: true,
        has_current_manual_key_handover: false,
        current_manual_key_handover_at: null,
        lockbox_record_at: '2026-10-28T01:00:00.000Z',
        lockbox_record_actor_user_id: userId,
        lockbox_record_actor_name: userId === 'former-password-executor-1' ? 'Former executor' : 'Video writer',
        executor_record_confirmation_source: 'video',
        cleaner_record_at: null,
        cleaner_record_date: null,
        cleaner_record_actor_user_id: null,
        cleaner_record_actor_name: null,
        has_cleaner_completion_evidence: false,
        inspector_record_at: null,
        inspector_record_date: null,
        inspector_record_actor_user_id: null,
        cancelled_record_at: null,
        cancelled_record_actor_user_id: null,
        updated_at: '2026-10-28T01:00:00.000Z',
      }]
      return { rows, rowCount: rows.length }
    }
    if (/WITH normalized_arrangement_tasks AS MATERIALIZED/.test(sql)) return { rows: [], rowCount: 0 }
    if (/END AS cleaning_submission_ready/.test(sql) && /FROM cleaning_tasks t/.test(sql)) {
      const ids = Array.isArray(params[0]) ? params[0].map(String) : []
      const rows = ids.map((id) => ({ id, cleaning_submission_ready: true }))
      return { rows, rowCount: rows.length }
    }
    if (/FROM cleaning_tasks[\s\S]*WHERE execution_state = 'superseded'/.test(sql)) return { rows: [], rowCount: 0 }
    if (/FROM cleaning_tasks t[\s\S]*LEFT JOIN orders o/.test(sql)) {
      const ids = Array.isArray(params[0]) ? params[0].map(String) : [String(params[0] || '')]
      const rows = taskRows(ids)
      return { rows, rowCount: rows.length }
    }
    if (/WITH current_video AS \(/.test(sql) && /latest_upload AS \(/.test(sql)) {
      const ids = new Set((Array.isArray(params[0]) ? params[0] : []).map(String))
      const rows = media
        .filter((item) => ids.has(item.task_id) && item.type === 'lockbox_video')
        .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
        .filter((item, index, all) => all.findIndex((candidate) => candidate.task_id === item.task_id) === index)
        .map((item) => ({
          task_id: item.task_id,
          media_id: item.id,
          uploader_id: item.uploader_id,
          actor_user_id: currentVideoAuditActorByTask.get(item.task_id) || null,
        }))
      return { rows, rowCount: rows.length }
    }
    if (/FROM work_task_action_audits/.test(sql) && Array.isArray(params[0])) {
      const ids = Array.isArray(params[0]) ? params[0].map(String) : []
      if (/AS inspected_at/.test(sql)) {
        const hasEvidence = auditRows(ids, String(params[1] || ''), 'submit_inspection').length > 0
        return { rows: [{ inspected_at: hasEvidence ? new Date('2026-10-21T02:00:00.100Z') : null }], rowCount: 1 }
      }
      if (/AS actor_user_id/.test(sql)) {
        const rows = Array.from(completionEvidence.entries()).flatMap(([actor_user_id, owned]) => ids.filter((id) => owned.has(id)).map((source_id) => ({ source_id, actor_user_id })))
        return { rows, rowCount: rows.length }
      }
      const userId = String(params[1] || '')
      const action = /performed_as_action\s*=\s*'upload_access_video'/.test(sql)
        ? 'upload_access_video'
        : /performed_as_action\s*=\s*'submit_inspection'/.test(sql) || params[2] === 'submit_inspection'
          ? 'submit_inspection'
          : 'complete_cleaning'
      const rows = auditRows(ids, userId, action)
      return { rows, rowCount: rows.length }
    }
    if (/FROM cleaning_task_media ctm[\s\S]*JOIN cleaning_tasks ct/.test(sql)) {
      const references = new Set((Array.isArray(params[0]) ? params[0] : []).map(String))
      const rows = media
        .filter((item) => references.has(item.url))
        .map((item) => {
          const task = tasks.find((candidate) => candidate.id === item.task_id)!
          return {
            media_id: item.id,
            type: item.type,
            url: item.url,
            source_task_id: item.task_id,
            uploader_id: item.uploader_id,
            created_at: item.created_at || '2026-10-21T01:00:00.000Z',
            id: task.id,
            cleaner_id: task.cleaner_id,
            inspector_id: task.inspector_id,
            assignee_id: task.assignee_id,
          }
        })
      return { rows, rowCount: rows.length }
    }
    if (/FROM cleaning_task_media/.test(sql) && /task_id::text = ANY/.test(sql)) {
      const ids = new Set((Array.isArray(params[0]) ? params[0] : []).map(String))
      const rows = media
        .filter((item) => ids.has(item.task_id) && (item.type !== 'lockbox_video' || params[1] === true))
        .map((item) => ({
          ...item,
          captured_at: '2026-10-21T01:00:00.000Z',
          created_at: item.created_at || '2026-10-21T01:00:00.000Z',
        }))
      return { rows, rowCount: rows.length }
    }
    if (/FROM cleaning_tasks\s+WHERE id=\$1/.test(sql)) {
      const task = tasks.find((candidate) => candidate.id === String(params[0] || ''))
      const rows = task ? [task] : []
      return { rows, rowCount: rows.length }
    }
    if (/FROM cleaning_task_media/.test(sql) && /task_id=\$1 AND type LIKE 'inspection_%'/.test(sql)) {
      const taskId = String(params[0] || '')
      const rows = media
        .filter((item) => item.task_id === taskId && item.type.startsWith('inspection_'))
        .map((item) => ({
          ...item,
          note: null,
          captured_at: '2026-10-21T01:00:00.000Z',
          created_at: '2026-10-21T01:00:00.000Z',
        }))
      return { rows, rowCount: rows.length }
    }
    if (/FROM app_submit_receipts/.test(sql)) {
      const receipt = inspectionSubmissionReceipts.get(String(params[0] || ''))
      const rows = receipt ? [receipt] : []
      return { rows, rowCount: rows.length }
    }
    if (/^\s*SELECT metadata\s+FROM work_task_action_audits/.test(sql)) return { rows: [], rowCount: 0 }
    if (/FROM property_maintenance m[\s\S]*UNION ALL[\s\S]*FROM property_deep_cleaning d/.test(sql)) {
      const keyPattern = String(params[0] || '').replace(/^%|%$/g, '')
      const rows = feedbackMedia
        .filter((item) => item.photo_urls.includes(keyPattern))
        .map((item) => ({
          ...item,
          before_photo_urls: null,
          after_photo_urls: null,
          repair_photo_urls: null,
          completion_photo_urls: null,
          attachment_urls: null,
          project_items: null,
          assignee_id: null,
          work_task_id: null,
          historical_work_record_media: false,
          work_record_actor_user_id: null,
        }))
      if (String(params[1] || '') === 'property_maintenance:feedback-historical') {
        rows.push(...historicalFeedbackMedia.filter((item) => item.photo_urls.includes(keyPattern)) as any)
      }
      return { rows, rowCount: rows.length }
    }
    if (/FROM work_tasks[\s\S]*source_type = 'property_maintenance'/.test(sql)) {
      const workTaskId = String(params[0] || '')
      const sourceId = String(params[1] || '')
      const propertyId = String(params[2] || '')
      const rows = workTaskId === 'property_maintenance:feedback-active'
        && sourceId === 'feedback-active'
        && propertyId === 'property-1'
        ? [{ id: workTaskId, assignee_id: 'repairer-1' }]
        : []
      return { rows, rowCount: rows.length }
    }
    if (/FROM cleaning_tasks\s+WHERE id::text = \$1::text/.test(sql)) {
      const task = tasks.find((candidate) => candidate.id === String(params[0] || ''))
      const rows = task?.execution_state === 'active' ? [task] : []
      return { rows, rowCount: rows.length }
    }
    if (/FROM cleaning_tasks t[\s\S]*LEFT JOIN properties p_id/.test(sql)) {
      const task = tasks.find((candidate) => candidate.id === String(params[0] || ''))
      const rows = task?.execution_state === 'active'
        ? [{
            ...task,
            is_manual_participant: false,
            can_manual_report: false,
            has_execution_evidence: false,
            has_inspection_evidence: false,
          }]
        : []
      return { rows, rowCount: rows.length }
    }
    if (/FROM cleaning_consumable_usages u[\s\S]*JOIN cleaning_tasks ct/.test(sql)) {
      const references = new Set((params[0] || []).map(String))
      const rows = usageProofs.filter((row) => references.has(row.photo_url)).map((row) => ({ ...tasks.find((task) => task.id === row.task_id), photo_url: row.photo_url, photo_urls: null, created_at: row.created_at }))
      return { rows, rowCount: rows.length }
    }
    if (/FROM cleaning_consumable_usages/.test(sql) && /task_id::text = ANY/.test(sql)) {
      const ids = new Set((params[0] || []).map(String))
      const rows = usageProofs.filter((row) => ids.has(row.task_id))
      return { rows, rowCount: rows.length }
    }
    if (/FROM work_task_participants/.test(sql)) return { rows: [], rowCount: 0 }
    if (/FROM guest_luggage_notices|FROM cleaning_day_end_media|FROM property_maintenance|FROM external_maintenance_orders|FROM work_task_events/.test(sql)) {
      return { rows: [], rowCount: 0 }
    }
    throw new Error(`unexpected test query: ${sql.replace(/\s+/g, ' ').slice(0, 180)}`)
  },
}

let r2ReadCount = 0
const r2 = require('../../src/r2')
r2.hasR2 = true
r2.r2GetObjectByKey = async (key: string) => {
  assert.ok(
    media.some((item) => item.url === key)
      || usageProofs.some((item) => item.photo_url === key)
      || feedbackMedia.some((item) => item.photo_urls.includes(key))
      || historicalFeedbackMedia.some((item) => item.photo_urls.includes(key)),
    `only a recorded fixture key may reach object storage: ${key}`,
  )
  r2ReadCount += 1
  if (key.endsWith('.mp4')) {
    return {
      body: Buffer.from('0123456789-video-bytes'),
      contentType: 'video/mp4',
      etag: `route-video-${r2ReadCount}`,
    }
  }
  return {
    body: await sharp({ create: { width: 2, height: 2, channels: 3, background: '#2266aa' } }).png().toBuffer(),
    contentType: 'image/png',
    etag: `route-${r2ReadCount}`,
  }
}

const { warmupR5TaskRuntimeSchema } = require('../../src/lib/r5RequestSchema')
const { warmupPasswordAuthoritySchema } = require('../../src/lib/passwordAuthoritySchema')
const { warmupMaintenanceRuntimeSchema } = require('../../src/lib/maintenanceRuntimeSchema')
const { router: mzappRouter, canViewMzappPropertyFeedback, propertyFeedbackSourceTaskAccess, workRecordReadOnlyViews } = require('../../src/modules/mzapp')
const { router: cleaningAppRouter } = require('../../src/modules/cleaning_app')

type TestUser = { id: string; role: string }

async function withRouteServer(run: (baseUrl: string) => Promise<void>) {
  await warmupR5TaskRuntimeSchema()
  await warmupPasswordAuthoritySchema()
  await warmupMaintenanceRuntimeSchema()
  const app = express()
  app.use((req: any, _res, next) => {
    const id = String(req.headers['x-test-user'] || '')
    const role = String(req.headers['x-test-role'] || 'cleaner')
    req.user = id ? { sub: id, role, roles: [role] } : null
    next()
  })
  app.use('/mzapp', mzappRouter)
  app.use('/cleaning-app', cleaningAppRouter)
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
  })
  try {
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    await run(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

function userHeaders(user: TestUser) {
  return { 'x-test-user': user.id, 'x-test-role': user.role }
}

async function getJson(baseUrl: string, path: string, user: TestUser) {
  const response = await fetch(`${baseUrl}${path}`, { headers: userHeaders(user) })
  return { response, body: await response.json() as any }
}

function formPhotoPath(workTaskId: string, sourceIds: string[], scope: string, includeVideos = false) {
  const query = new URLSearchParams({ source_ids: sourceIds.join(','), scope })
  if (includeVideos) query.set('include_videos', '1')
  return `/mzapp/work-tasks/${encodeURIComponent(workTaskId)}/form-photos?${query}`
}

function mediaPath(key: string, sourceIds: string[], scope: string, sourceTaskId: string, variant?: string) {
  const query = new URLSearchParams({
    key,
    source_ids: sourceIds.join(','),
    media_scope: scope,
    source_task_id: sourceTaskId,
  })
  if (variant) query.set('variant', variant)
  return `/cleaning-app/media/image?${query}`
}

async function verifyFormPhotoRoute(baseUrl: string) {
  const pairId = 'cleaning_tasks_merged:property-1:2026-10-21'
  const cleaner = { id: 'cleaner-1', role: 'cleaner' }
  const inspector = { id: 'inspector-1', role: 'cleaning_inspector' }
  const manager = { id: 'manager-1', role: 'admin' }
  const mia = { id: 'mia-1', role: 'cleaning_inspector' }

  assert.deepEqual(workRecordReadOnlyViews({
    work_record_read_only: true,
    source_type: 'cleaning_tasks',
    source_id: 'password-only-execution',
    task_type: 'checkin_clean',
    inspection_scope: 'password_only',
    execution_role: 'execution',
    work_record_state: 'completed',
    status: 'inspected',
    execution_state: 'active',
    completed_by_user_id: 'mia-1',
  }, { sub: 'mia-1', role: 'cleaning_inspector', roles: ['cleaning_inspector'] }, 'mia-1'), {
    property_access: true,
    guest_context: true,
    lock_codes: false,
    lockbox_video: true,
    cleaner_photos: false,
    inspection_photos: false,
    guest_key_photo: false,
    media_scope: 'inspector',
    feedback_history: false,
    feedback_report: false,
    feedback_source_id: null,
  }, 'password-only execution history exposes only its saved lockbox video capability')

  assert.equal(workRecordReadOnlyViews({
    work_record_read_only: true,
    source_type: 'cleaning_tasks',
    source_id: 'password-only-cancelled',
    task_type: 'checkin_clean',
    inspection_scope: 'password_only',
    execution_role: 'execution',
    work_record_state: 'cancelled',
    status: 'cancelled',
    execution_state: 'cancelled',
    completed_by_user_id: 'mia-1',
  }, { sub: 'mia-1', role: 'cleaning_inspector', roles: ['cleaning_inspector'] }, 'mia-1').lockbox_video, false, 'cancelled password-only records do not recover historical media')

  assert.equal(workRecordReadOnlyViews({
    work_record_read_only: true,
    source_type: 'cleaning_tasks',
    source_id: 'password-only-reassigned',
    task_type: 'checkin_clean',
    inspection_scope: 'password_only',
    execution_role: 'execution',
    work_record_state: 'reassigned',
    status: 'inspected',
    execution_state: 'active',
    completed_by_user_id: 'former-password-executor-1',
  }, { sub: 'former-password-executor-1', role: 'cleaning_inspector', roles: ['cleaning_inspector'] }, 'former-password-executor-1').lockbox_video, true, 'a reassigned password-only work record retains its read-only video capability')

  const cleanerResult = await getJson(baseUrl, formPhotoPath(pairId, ['checkout-active', 'checkin-active'], 'cleaner'), cleaner)
  assert.equal(cleanerResult.response.status, 200)
  assert.deepEqual(cleanerResult.body.items.map((item: any) => item.id).sort(), ['completion-1', 'key-1'])

  const syntheticRecordId = 'cleaning_tasks_cleaner:checkout-active::record:completed:2026-10-21'
  const syntheticRecord = await getJson(baseUrl, formPhotoPath(syntheticRecordId, ['checkout-active'], 'cleaner'), cleaner)
  assert.equal(syntheticRecord.response.status, 200, 'a synthetic work-record id must resolve its exact Root-issued source id')
  assert.deepEqual(syntheticRecord.body.items.map((item: any) => item.id).sort(), ['completion-1', 'key-1'])

  const inspectorResult = await getJson(baseUrl, formPhotoPath(pairId, ['checkout-active', 'checkin-active'], 'inspector'), inspector)
  assert.equal(inspectorResult.response.status, 200)
  assert.deepEqual(inspectorResult.body.items.map((item: any) => item.id).sort(), ['inspection-1', 'inspection-unclean', 'key-1'])

  const inspectorWithVideo = await getJson(baseUrl, formPhotoPath(pairId, ['checkout-active', 'checkin-active'], 'inspector', true), inspector)
  assert.equal(inspectorWithVideo.response.status, 200)
  assert.deepEqual(inspectorWithVideo.body.items.map((item: any) => item.id).sort(), ['inspection-1', 'inspection-lockbox', 'inspection-unclean', 'key-1'])

  const managerResult = await getJson(baseUrl, formPhotoPath(pairId, ['checkout-active', 'checkin-active'], 'manager'), manager)
  assert.equal(managerResult.response.status, 200)
  assert.deepEqual(managerResult.body.items.map((item: any) => item.id).sort(), ['completion-1', 'inspection-1', 'inspection-unclean', 'key-1', 'ownerless-1'])

  const managerWithVideo = await getJson(baseUrl, formPhotoPath(pairId, ['checkout-active', 'checkin-active'], 'manager', true), { id: 'customer-service-1', role: 'customer_service' })
  assert.equal(managerWithVideo.response.status, 200)
  assert.deepEqual(managerWithVideo.body.items.map((item: any) => item.id).sort(), ['completion-1', 'inspection-1', 'inspection-lockbox', 'key-1', 'lockbox-1', 'ownerless-1'])

  const selfCompleteVideo = await getJson(baseUrl, formPhotoPath('self-complete-active', ['self-complete-active'], 'cleaner', true), cleaner)
  assert.equal(selfCompleteVideo.response.status, 200)
  assert.deepEqual(selfCompleteVideo.body.items.map((item: any) => item.id), ['self-complete-lockbox'])

  const passwordOnlyVideo = await getJson(baseUrl, formPhotoPath('password-only-execution', ['password-only-execution'], 'inspector', true), mia)
  assert.equal(passwordOnlyVideo.response.status, 200)
  assert.deepEqual(passwordOnlyVideo.body.items.map((item: any) => item.id), ['password-only-lockbox'], 'the exact password-only executor sees only the saved lockbox video, never cleaner completion or inspection photos')

  const passwordOnlyOutsider = await getJson(baseUrl, formPhotoPath('password-only-execution', ['password-only-execution'], 'inspector', true), { id: 'outsider-1', role: 'cleaning_inspector' })
  assert.equal(passwordOnlyOutsider.response.status, 403, 'an unrelated inspector cannot read password-only execution history')

  const passwordOnlyInspectorFallback = await getJson(
    baseUrl,
    formPhotoPath('password-only-inspector-fallback', ['password-only-inspector-fallback'], 'inspector', true),
    { id: 'fallback-inspector-1', role: 'cleaning_inspector' },
  )
  assert.equal(passwordOnlyInspectorFallback.response.status, 200)
  assert.deepEqual(passwordOnlyInspectorFallback.body.items.map((item: any) => item.id), ['password-only-fallback-lockbox'], 'inspector_id fallback stays on the video-only surface even when their inspection/key photos exist')

  const staleInspectorWithAssignee = await getJson(
    baseUrl,
    formPhotoPath('password-only-dual-assignment', ['password-only-dual-assignment'], 'inspector', true),
    { id: 'stale-inspector-1', role: 'cleaning_inspector' },
  )
  assert.equal(staleInspectorWithAssignee.response.status, 403, 'inspector_id is not a fallback when a different persisted assignee exists')

  const currentDualAssignee = await getJson(
    baseUrl,
    formPhotoPath('password-only-dual-assignment', ['password-only-dual-assignment'], 'inspector', true),
    { id: 'current-password-executor-1', role: 'cleaning_inspector' },
  )
  assert.equal(currentDualAssignee.response.status, 200)
  assert.deepEqual(currentDualAssignee.body.items.map((item: any) => item.id), ['password-only-dual-lockbox'])

  const passwordOnlyReassigned = await getJson(
    baseUrl,
    formPhotoPath('password-only-reassigned', ['password-only-reassigned'], 'inspector', true),
    { id: 'former-password-executor-1', role: 'cleaning_inspector' },
  )
  assert.equal(passwordOnlyReassigned.response.status, 200)
  assert.deepEqual(passwordOnlyReassigned.body.items.map((item: any) => item.id), ['password-only-reassigned-lockbox'], 'same-transaction upload_access_video audit restores the real executor even when a different non-empty uploader is persisted')

  const passwordOnlyPersistedUploader = await getJson(
    baseUrl,
    formPhotoPath('password-only-reassigned', ['password-only-reassigned'], 'inspector', true),
    { id: 'service-video-writer-1', role: 'cleaning_inspector' },
  )
  assert.equal(passwordOnlyPersistedUploader.response.status, 200)
  assert.deepEqual(passwordOnlyPersistedUploader.body.items.map((item: any) => item.id), ['password-only-reassigned-lockbox'], 'the persisted uploader remains an independent legal evidence actor when the same-transaction audit actor differs')

  const passwordOnlyInspectionOnlyActor = await getJson(
    baseUrl,
    formPhotoPath('password-only-reassigned', ['password-only-reassigned'], 'inspector', true),
    { id: 'inspection-only-historical-1', role: 'cleaning_inspector' },
  )
  assert.equal(passwordOnlyInspectionOnlyActor.response.status, 403, 'generic inspection evidence cannot replace same-source password-only video evidence')

  const passwordOnlyCrossSourceAuditActor = await getJson(
    baseUrl,
    formPhotoPath('password-only-reassigned', ['password-only-reassigned'], 'inspector', true),
    { id: 'cross-source-video-actor-1', role: 'cleaning_inspector' },
  )
  assert.equal(passwordOnlyCrossSourceAuditActor.response.status, 403, 'an upload_access_video audit from another source cannot authorize reassigned history')

  const oldReplacedVideoActor = await getJson(
    baseUrl,
    formPhotoPath('password-only-replaced-video', ['password-only-replaced-video'], 'inspector', true),
    { id: 'old-replaced-video-actor-1', role: 'cleaning_inspector' },
  )
  assert.equal(oldReplacedVideoActor.response.status, 403, 'an older upload audit cannot authorize a later replacement video')

  const currentBlankUploaderAuditActor = await getJson(
    baseUrl,
    formPhotoPath('password-only-replaced-video', ['password-only-replaced-video'], 'inspector', true),
    { id: 'replacement-video-executor-1', role: 'cleaning_inspector' },
  )
  assert.equal(currentBlankUploaderAuditActor.response.status, 200, 'the exact current-video audit keeps legacy blank-uploader history readable after reassignment')
  assert.deepEqual(currentBlankUploaderAuditActor.body.items.map((item: any) => item.id), ['password-only-replaced-lockbox'])

  const cancelledPasswordOnly = await getJson(baseUrl, formPhotoPath('password-only-cancelled', ['password-only-cancelled'], 'inspector', true), mia)
  assert.equal(cancelledPasswordOnly.response.status, 403, 'cancelled password-only media stays hidden even when the old source id is known')

  const outsider = await getJson(baseUrl, formPhotoPath(pairId, ['checkout-active', 'checkin-active'], 'cleaner'), { id: 'outsider-1', role: 'cleaner' })
  assert.equal(outsider.response.status, 403)

  const independent = await getJson(baseUrl, formPhotoPath(pairId, ['checkout-active', 'same-day-independent'], 'inspector'), inspector)
  assert.equal(independent.response.status, 403, 'same property/date without a booking boundary must not share photos')

  const manualPairId = 'cleaning_tasks_merged:property-7:2026-10-22'
  const manualPairIds = ['manual-checkout-active', 'manual-checkin-active']
  const manualInspector = { id: 'manual-inspector-1', role: 'cleaning_inspector' }
  const manualPair = await getJson(baseUrl, formPhotoPath(manualPairId, manualPairIds, 'inspector'), manualInspector)
  assert.equal(manualPair.response.status, 200, 'the assigned checkin inspector may read the explicitly linked manual checkout evidence')
  assert.deepEqual(manualPair.body.items.map((item: any) => item.id), ['manual-key-1'])

  const wrongManualSource = await getJson(baseUrl, formPhotoPath(manualPairId, ['manual-checkout-active', 'same-day-independent'], 'inspector'), manualInspector)
  assert.equal(wrongManualSource.response.status, 403, 'an explicit manual link cannot authorize an unrelated same-day source')

  const manualCheckin = tasks.find((task) => task.id === 'manual-checkin-active')!
  const originalInspectorId = manualCheckin.inspector_id
  const originalAssigneeId = manualCheckin.assignee_id
  manualCheckin.inspector_id = 'replacement-inspector'
  manualCheckin.assignee_id = 'replacement-inspector'
  const manualReassigned = await getJson(baseUrl, formPhotoPath(manualPairId, manualPairIds, 'inspector'), manualInspector)
  assert.equal(manualReassigned.response.status, 403, 'reassignment revokes the former checkin inspector from the linked manual checkout evidence')
  manualCheckin.inspector_id = originalInspectorId
  manualCheckin.assignee_id = originalAssigneeId

  const originalManualStatus = manualCheckin.status
  const originalManualExecutionState = manualCheckin.execution_state
  manualCheckin.status = 'cancelled'
  manualCheckin.execution_state = 'cancelled'
  const manualCancelled = await getJson(baseUrl, formPhotoPath(manualPairId, manualPairIds, 'inspector'), manualInspector)
  assert.equal(manualCancelled.response.status, 403, 'a cancelled side invalidates explicit manual-pair evidence access')
  manualCheckin.status = originalManualStatus
  manualCheckin.execution_state = originalManualExecutionState

  const formerCleaner = await getJson(baseUrl, formPhotoPath('reassigned-task', ['reassigned-task'], 'cleaner'), cleaner)
  assert.equal(formerCleaner.response.status, 200)
  assert.deepEqual(formerCleaner.body.items.map((item: any) => item.id), ['reassigned-1'])

  const reassignedManager = await getJson(baseUrl, formPhotoPath('reassigned-task', ['reassigned-task'], 'manager', true), { id: 'customer-service-1', role: 'customer_service' })
  assert.equal(reassignedManager.response.status, 200)
  assert.deepEqual(reassignedManager.body.items.map((item: any) => item.id).sort(), ['reassigned-1', 'reassigned-replacement', 'reassigned-video'])

  const replacementCleaner = await getJson(baseUrl, formPhotoPath('reassigned-task', ['reassigned-task'], 'cleaner'), { id: 'cleaner-2', role: 'cleaner' })
  assert.equal(replacementCleaner.response.status, 200)
  assert.deepEqual(replacementCleaner.body.items.map((item: any) => item.id), ['reassigned-replacement'], 'a replacement assignee sees only their own media, never the former cleaner\'s photos')

  const cancelled = await getJson(baseUrl, formPhotoPath('cancelled-task', ['cancelled-task'], 'cleaner'), cleaner)
  assert.equal(cancelled.response.status, 403, 'cancelled records remain hidden even if the old source id is known')

  const deleted = await getJson(baseUrl, formPhotoPath('deleted-task', ['deleted-task'], 'cleaner'), cleaner)
  assert.equal(deleted.response.status, 403, 'deleted records remain hidden even if the old source id is known')

  const superseded = await getJson(baseUrl, formPhotoPath('superseded-task', ['superseded-task'], 'cleaner'), cleaner)
  assert.equal(superseded.response.status, 403, 'superseded records remain hidden even if the old source id is known')
}

async function verifyWorkTaskListToMediaRoute(baseUrl: string) {
  const actor = { id: 'former-password-executor-1', role: 'cleaning_inspector' }
  const listed = await getJson(baseUrl, '/mzapp/work-tasks?date_from=2026-10-28&date_to=2026-10-28', actor)
  assert.equal(listed.response.status, 200, JSON.stringify(listed.body))
  const record = (Array.isArray(listed.body) ? listed.body : []).find((item: any) => item.source_id === 'password-only-reassigned')
  assert.ok(record, 'same-source current-video audit actor receives the password-only historical task record')
  assert.equal(record.execution_role, 'execution')
  assert.equal(record.read_only_views?.lockbox_video, true)
  assert.equal(record.read_only_views?.inspection_photos, false)
  assert.equal(record.read_only_views?.cleaner_photos, false)
  assert.deepEqual(record.read_only_views?.media_source_ids, ['password-only-reassigned'])

  const photos = await getJson(
    baseUrl,
    formPhotoPath(String(record.id), record.read_only_views.media_source_ids, record.read_only_views.media_scope, true),
    actor,
  )
  assert.equal(photos.response.status, 200)
  assert.deepEqual(photos.body.items.map((item: any) => item.id), ['password-only-reassigned-lockbox'])
  const streamed = await fetch(
    `${baseUrl}${mediaPath(photos.body.items[0].url, record.read_only_views.media_source_ids, record.read_only_views.media_scope, 'password-only-reassigned', 'source')}`,
    { headers: { ...userHeaders(actor), range: 'bytes=2-7' } },
  )
  assert.equal(streamed.status, 206)
  assert.equal(Buffer.from(await streamed.arrayBuffer()).toString(), '234567')

  const uploaderActor = { id: 'service-video-writer-1', role: 'cleaning_inspector' }
  const uploaderListed = await getJson(baseUrl, '/mzapp/work-tasks?date_from=2026-10-28&date_to=2026-10-28', uploaderActor)
  const uploaderRecord = (Array.isArray(uploaderListed.body) ? uploaderListed.body : []).find((item: any) => item.source_id === 'password-only-reassigned')
  assert.ok(uploaderRecord, 'a non-empty persisted uploader remains a separate task-list actor when the same-transaction audit identifies another executor')
  const uploaderPhotos = await getJson(
    baseUrl,
    formPhotoPath(String(uploaderRecord.id), uploaderRecord.read_only_views.media_source_ids, uploaderRecord.read_only_views.media_scope, true),
    uploaderActor,
  )
  assert.equal(uploaderPhotos.response.status, 200)
  assert.deepEqual(uploaderPhotos.body.items.map((item: any) => item.id), ['password-only-reassigned-lockbox'])

  for (const deniedActor of [
    { id: 'old-replaced-video-actor-1', role: 'cleaning_inspector' },
    { id: 'stale-inspector-1', role: 'cleaning_inspector' },
  ]) {
    const deniedList = await getJson(baseUrl, '/mzapp/work-tasks?date_from=2026-10-26&date_to=2026-10-28', deniedActor)
    assert.equal(deniedList.response.status, 200)
    assert.equal((Array.isArray(deniedList.body) ? deniedList.body : []).some((item: any) => [
      'password-only-reassigned',
      'password-only-replaced-video',
      'password-only-dual-assignment',
    ].includes(String(item.source_id || ''))), false, 'old audit actors and non-fallback inspectors receive no historical password-only entry')
  }
}

async function verifyMediaByteRoute(baseUrl: string) {
  const cleaner = { id: 'cleaner-1', role: 'cleaner' }
  const inspector = { id: 'inspector-1', role: 'cleaning_inspector' }
  const pair = ['checkout-active', 'checkin-active']
  const mia = { id: 'mia-1', role: 'cleaning_inspector' }

  const cleanerOwn = await fetch(`${baseUrl}${mediaPath('cleaning/route/cleaner-own.jpg', pair, 'cleaner', 'checkout-active')}`, { headers: userHeaders(cleaner) })
  assert.equal(cleanerOwn.status, 200)
  assert.equal(cleanerOwn.headers.get('content-type'), 'image/jpeg')
  assert.ok((await cleanerOwn.arrayBuffer()).byteLength > 0)

  const inspectorKey = await fetch(`${baseUrl}${mediaPath('cleaning/route/guest-key.jpg', pair, 'inspector', 'checkout-active')}`, { headers: userHeaders(inspector) })
  assert.equal(inspectorKey.status, 200, 'the assigned inspector may read the canonical turnover cleaner key photo')
  await inspectorKey.arrayBuffer()

  const inspectorOwn = await fetch(`${baseUrl}${mediaPath('cleaning/route/inspector-own.jpg', pair, 'inspector', 'checkin-active')}`, { headers: userHeaders(inspector) })
  assert.equal(inspectorOwn.status, 200, 'the assigned inspector may read their own inspection photo bytes')
  await inspectorOwn.arrayBuffer()

  const manager = { id: 'manager-1', role: 'admin' }
  const managerOwnerless = await fetch(`${baseUrl}${mediaPath('cleaning/route/ownerless.jpg', pair, 'manager', 'checkout-active')}`, { headers: userHeaders(manager) })
  assert.equal(managerOwnerless.status, 200, 'a manager may read authorized legacy photo bytes without uploader attribution')
  await managerOwnerless.arrayBuffer()

  const managerInspectionUnclean = await fetch(`${baseUrl}${mediaPath('cleaning/route/inspection-unclean.jpg', pair, 'manager', 'checkin-active')}`, { headers: userHeaders(manager) })
  assert.equal(managerInspectionUnclean.status, 200, 'admin and offline manager may read inspection unclean evidence for the exact task')
  await managerInspectionUnclean.arrayBuffer()

  const offlineManagerInspectionUnclean = await fetch(
    `${baseUrl}${mediaPath('cleaning/route/inspection-unclean.jpg', pair, 'manager', 'checkin-active')}`,
    { headers: userHeaders({ id: 'offline-manager-1', role: 'offline_manager' }) },
  )
  assert.equal(offlineManagerInspectionUnclean.status, 200, 'offline manager retains exact-source inspection unclean access')
  await offlineManagerInspectionUnclean.arrayBuffer()

  const customerServiceInspectionUnclean = await fetch(
    `${baseUrl}${mediaPath('cleaning/route/inspection-unclean.jpg', pair, 'manager', 'checkin-active')}`,
    { headers: userHeaders({ id: 'customer-service-1', role: 'customer_service' }) },
  )
  assert.equal(customerServiceInspectionUnclean.status, 403, 'customer service must not inherit inspection unclean evidence through the shared manager route')

  const customerServiceLegacyInspectionUnclean = await fetch(
    `${baseUrl}/cleaning-app/media/image?key=${encodeURIComponent('cleaning/route/inspection-unclean.jpg')}&source_task_id=checkin-active`,
    { headers: userHeaders({ id: 'customer-service-1', role: 'customer_service' }) },
  )
  assert.equal(customerServiceLegacyInspectionUnclean.status, 403, 'customer service must not recover inspection unclean bytes through the legacy unscoped media route')

  const customerService = { id: 'customer-service-1', role: 'customer_service' }
  const managerVideo = await fetch(
    `${baseUrl}${mediaPath('cleaning/route/lockbox.mp4', pair, 'manager', 'checkout-active', 'source')}`,
    { headers: { ...userHeaders(customerService), range: 'bytes=2-7' } },
  )
  assert.equal(managerVideo.status, 206, 'customer service may stream an exact-source historical lockbox video')
  assert.equal(managerVideo.headers.get('content-type'), 'video/mp4')
  assert.equal(managerVideo.headers.get('accept-ranges'), 'bytes')
  assert.equal(managerVideo.headers.get('content-range'), 'bytes 2-7/22')
  assert.equal(Buffer.from(await managerVideo.arrayBuffer()).toString(), '234567')

  const passwordOnlyVideo = await fetch(
    `${baseUrl}${mediaPath('cleaning/route/password-only-lockbox.mp4', ['password-only-execution'], 'inspector', 'password-only-execution', 'source')}`,
    { headers: { ...userHeaders(mia), range: 'bytes=2-7' } },
  )
  assert.equal(passwordOnlyVideo.status, 206, 'the exact password-only executor may stream their saved historical lockbox video')
  assert.equal(Buffer.from(await passwordOnlyVideo.arrayBuffer()).toString(), '234567')

  const passwordOnlyCleanerPhoto = await fetch(
    `${baseUrl}${mediaPath('cleaning/route/password-only-cleaner.jpg', ['password-only-execution'], 'inspector', 'password-only-execution')}`,
    { headers: userHeaders(mia) },
  )
  assert.equal(passwordOnlyCleanerPhoto.status, 403, 'password-only history never grants the inspector cleaner completion-photo bytes')

  const passwordOnlyCrossSource = await fetch(
    `${baseUrl}${mediaPath('cleaning/route/password-only-lockbox.mp4', ['checkin-active'], 'inspector', 'password-only-execution', 'source')}`,
    { headers: userHeaders(mia) },
  )
  assert.equal(passwordOnlyCrossSource.status, 403, 'a mismatched Root-issued source list cannot authorize password-only video bytes')

  const cancelledPasswordOnlyVideo = await fetch(
    `${baseUrl}${mediaPath('cleaning/route/password-only-cancelled.mp4', ['password-only-cancelled'], 'inspector', 'password-only-cancelled', 'source')}`,
    { headers: userHeaders(mia) },
  )
  assert.equal(cancelledPasswordOnlyVideo.status, 403, 'cancelled password-only video bytes remain unavailable')

  const passwordOnlyInspectorFallback = await fetch(
    `${baseUrl}${mediaPath('cleaning/route/password-only-fallback.mp4', ['password-only-inspector-fallback'], 'inspector', 'password-only-inspector-fallback', 'source')}`,
    { headers: userHeaders({ id: 'fallback-inspector-1', role: 'cleaning_inspector' }) },
  )
  assert.equal(passwordOnlyInspectorFallback.status, 200, 'inspector_id fallback may read only the exact password-only video even when the stored uploader differs')
  await passwordOnlyInspectorFallback.arrayBuffer()

  const passwordOnlyFallbackInspection = await fetch(
    `${baseUrl}${mediaPath('cleaning/route/password-only-fallback-inspection.jpg', ['password-only-inspector-fallback'], 'inspector', 'password-only-inspector-fallback')}`,
    { headers: userHeaders({ id: 'fallback-inspector-1', role: 'cleaning_inspector' }) },
  )
  assert.equal(passwordOnlyFallbackInspection.status, 403, 'inspector_id fallback cannot enter the generic inspection-photo surface')

  const passwordOnlyFallbackKey = await fetch(
    `${baseUrl}${mediaPath('cleaning/route/password-only-fallback-key.jpg', ['password-only-inspector-fallback'], 'inspector', 'password-only-inspector-fallback')}`,
    { headers: userHeaders({ id: 'fallback-inspector-1', role: 'cleaning_inspector' }) },
  )
  assert.equal(passwordOnlyFallbackKey.status, 403, 'password-only fallback cannot inherit the generic guest-key exception')

  const passwordOnlyFallbackRestock = await fetch(
    `${baseUrl}${mediaPath('cleaning/route/password-only-fallback-restock.jpg', ['password-only-inspector-fallback'], 'inspector', 'password-only-inspector-fallback')}`,
    { headers: userHeaders({ id: 'fallback-inspector-1', role: 'cleaning_inspector' }) },
  )
  assert.equal(passwordOnlyFallbackRestock.status, 403, 'password-only fallback cannot inherit restock/supplies photo access')

  const passwordOnlyStaleInspector = await fetch(
    `${baseUrl}${mediaPath('cleaning/route/password-only-dual.mp4', ['password-only-dual-assignment'], 'inspector', 'password-only-dual-assignment', 'source')}`,
    { headers: userHeaders({ id: 'stale-inspector-1', role: 'cleaning_inspector' }) },
  )
  assert.equal(passwordOnlyStaleInspector.status, 403, 'a non-fallback inspector cannot stream the assignee-owned password-only video')

  const passwordOnlyReassigned = await fetch(
    `${baseUrl}${mediaPath('cleaning/route/password-only-reassigned.mp4', ['password-only-reassigned'], 'inspector', 'password-only-reassigned', 'source')}`,
    { headers: { ...userHeaders({ id: 'former-password-executor-1', role: 'cleaning_inspector' }), range: 'bytes=2-7' } },
  )
  assert.equal(passwordOnlyReassigned.status, 206, 'same-source historical upload audit authorizes the reassigned actor even when legacy media has no uploader_id')
  assert.equal(Buffer.from(await passwordOnlyReassigned.arrayBuffer()).toString(), '234567')

  const passwordOnlyReassignedPhoto = await fetch(
    `${baseUrl}${mediaPath('cleaning/route/password-only-reassigned-completion.jpg', ['password-only-reassigned'], 'inspector', 'password-only-reassigned')}`,
    { headers: userHeaders({ id: 'former-password-executor-1', role: 'cleaning_inspector' }) },
  )
  assert.equal(passwordOnlyReassignedPhoto.status, 403, 'historical video evidence never grants completion-photo bytes')

  const passwordOnlyInspectionOnlyActor = await fetch(
    `${baseUrl}${mediaPath('cleaning/route/password-only-reassigned.mp4', ['password-only-reassigned'], 'inspector', 'password-only-reassigned', 'source')}`,
    { headers: userHeaders({ id: 'inspection-only-historical-1', role: 'cleaning_inspector' }) },
  )
  assert.equal(passwordOnlyInspectionOnlyActor.status, 403, 'generic inspection history cannot authorize password-only video bytes')

  const passwordOnlyCrossSourceAuditActor = await fetch(
    `${baseUrl}${mediaPath('cleaning/route/password-only-reassigned.mp4', ['password-only-reassigned'], 'inspector', 'password-only-reassigned', 'source')}`,
    { headers: userHeaders({ id: 'cross-source-video-actor-1', role: 'cleaning_inspector' }) },
  )
  assert.equal(passwordOnlyCrossSourceAuditActor.status, 403, 'a historical upload audit for a different source cannot authorize video bytes')

  const oldReplacedVideoActor = await fetch(
    `${baseUrl}${mediaPath('cleaning/route/password-only-replaced.mp4', ['password-only-replaced-video'], 'inspector', 'password-only-replaced-video', 'source')}`,
    { headers: userHeaders({ id: 'old-replaced-video-actor-1', role: 'cleaning_inspector' }) },
  )
  assert.equal(oldReplacedVideoActor.status, 403, 'an old same-source audit cannot stream a newer replacement video')

  const unscopedVideo = await fetch(
    `${baseUrl}/cleaning-app/media/image?key=${encodeURIComponent('cleaning/route/lockbox.mp4')}&variant=source&source_task_id=checkout-active`,
    { headers: userHeaders(customerService) },
  )
  assert.equal(unscopedVideo.status, 403, 'video bytes require Root-issued exact source ids and media scope')

  const photoAsSource = await fetch(
    `${baseUrl}${mediaPath('cleaning/route/cleaner-own.jpg', pair, 'manager', 'checkout-active', 'source')}`,
    { headers: userHeaders(customerService) },
  )
  assert.equal(photoAsSource.status, 403, 'the raw-byte variant is limited to recorded lockbox videos')

  const readsAfterAuthorized = r2ReadCount
  const inspectorCleanerPhoto = await fetch(`${baseUrl}${mediaPath('cleaning/route/cleaner-own.jpg', pair, 'inspector', 'checkout-active')}`, { headers: userHeaders(inspector) })
  assert.equal(inspectorCleanerPhoto.status, 403, 'cross-phase inspection access is limited to the guest-key photo')

  const outsider = await fetch(`${baseUrl}${mediaPath('cleaning/route/cleaner-own.jpg', pair, 'cleaner', 'checkout-active')}`, { headers: userHeaders({ id: 'outsider-1', role: 'cleaner' }) })
  assert.equal(outsider.status, 403)

  const formerCleaner = await fetch(`${baseUrl}${mediaPath('cleaning/route/former-cleaner.jpg', ['reassigned-task'], 'cleaner', 'reassigned-task')}`, { headers: userHeaders(cleaner) })
  assert.equal(formerCleaner.status, 200, 'immutable completion evidence preserves the former cleaner\'s own photo access')
  await formerCleaner.arrayBuffer()

  const replacementCleaner = await fetch(`${baseUrl}${mediaPath('cleaning/route/former-cleaner.jpg', ['reassigned-task'], 'cleaner', 'reassigned-task')}`, { headers: userHeaders({ id: 'cleaner-2', role: 'cleaner' }) })
  assert.equal(replacementCleaner.status, 403, 'a reassignment must not transfer byte access to another uploader\'s photo')

  const cancelled = await fetch(`${baseUrl}${mediaPath('cleaning/route/cancelled.jpg', ['cancelled-task'], 'cleaner', 'cancelled-task')}`, { headers: userHeaders(cleaner) })
  assert.equal(cancelled.status, 403)

  const deleted = await fetch(`${baseUrl}${mediaPath('cleaning/route/deleted.jpg', ['deleted-task'], 'cleaner', 'deleted-task')}`, { headers: userHeaders(cleaner) })
  assert.equal(deleted.status, 403)

  const superseded = await fetch(`${baseUrl}${mediaPath('cleaning/route/superseded.jpg', ['superseded-task'], 'cleaner', 'superseded-task')}`, { headers: userHeaders(cleaner) })
  assert.equal(superseded.status, 403)

  const ownerless = await fetch(`${baseUrl}${mediaPath('cleaning/route/ownerless.jpg', ['checkout-active'], 'cleaner', 'checkout-active')}`, { headers: userHeaders(cleaner) })
  assert.equal(ownerless.status, 403, 'legacy media without uploader attribution fails closed for field staff')
  assert.equal(r2ReadCount, readsAfterAuthorized + 1, 'only the additionally authorized former cleaner request may reach object storage')
}

async function verifyLegacyInspectionPhotoRoute(baseUrl: string) {
  const customerService = await getJson(
    baseUrl,
    '/mzapp/cleaning-tasks/checkin-active/inspection-photos',
    { id: 'customer-service-1', role: 'customer_service' },
  )
  assert.equal(customerService.response.status, 200)
  assert.deepEqual(
    customerService.body.items.map((item: any) => item.area),
    ['living'],
    'the legacy inspection-photo list must preserve the customer-service unclean-photo boundary',
  )
  assert.deepEqual(customerService.body.formal_submission, {
    status: 'submitted',
    submit_id: 'inspection-batch-checkin-active',
    saved_at: '2026-10-21T01:03:00.000Z',
    guest_arrival_confirmed: false,
  })

  const admin = await getJson(
    baseUrl,
    '/mzapp/cleaning-tasks/checkin-active/inspection-photos',
    { id: 'manager-1', role: 'admin' },
  )
  assert.equal(admin.response.status, 200)
  assert.deepEqual(admin.body.items.map((item: any) => item.area).sort(), ['living', 'unclean'])

  const offlineManager = await getJson(
    baseUrl,
    '/mzapp/cleaning-tasks/checkin-active/inspection-photos',
    { id: 'offline-manager-1', role: 'offline_manager' },
  )
  assert.equal(offlineManager.response.status, 200)
  assert.deepEqual(offlineManager.body.items.map((item: any) => item.area).sort(), ['living', 'unclean'])
}

async function verifyHistoricalFeedbackMediaRoute(baseUrl: string) {
  const cleaner = { id: 'cleaner-1', role: 'cleaner' }
  const inspector = { id: 'inspector-1', role: 'cleaning_inspector' }
  const outsider = { id: 'outsider-1', role: 'cleaner' }
  const request = (key: string, sourceTaskId: string | null, user: TestUser, workTaskId: string | null = null) => {
    const query = new URLSearchParams({ key })
    if (sourceTaskId) query.set('source_task_id', sourceTaskId)
    if (workTaskId) query.set('work_task_id', workTaskId)
    return fetch(`${baseUrl}/cleaning-app/media/image?${query}`, { headers: userHeaders(user) })
  }

  const creator = await request('mzapp/feedback/active.jpg', 'feedback-task', cleaner)
  assert.equal(creator.status, 200, 'the exact source-task creator may read their historical report image')
  assert.ok((await creator.arrayBuffer()).byteLength > 0)

  const creatorWithoutClientContext = await request('mzapp/feedback/active.jpg', null, cleaner)
  assert.equal(creatorWithoutClientContext.status, 200, 'the server derives an active exact source task when the optional client context is omitted')
  assert.ok((await creatorWithoutClientContext.arrayBuffer()).byteLength > 0)

  const inspectorSourceAccess = await propertyFeedbackSourceTaskAccess(
    { sub: inspector.id, role: inspector.role, roles: [inspector.role] },
    feedbackMedia[0].property_id,
    feedbackMedia[0].source_task_id,
  )
  assert.deepEqual(
    inspectorSourceAccess,
    { exists: true, canViewHistory: true, canCreate: true, feedbackSource: 'inspection_feedback' },
    'the exact source-task inspector resolves the active task and retains history access',
  )
  assert.equal(
    await canViewMzappPropertyFeedback(
      { sub: inspector.id, role: inspector.role, roles: [inspector.role] },
      feedbackMedia[0],
      inspector.id,
    ),
    true,
    'the exact source-task inspector keeps history permission independently of the media byte route',
  )
  const anotherAuthorizedExecutor = await request('mzapp/feedback/active.jpg', 'feedback-task', inspector)
  assert.equal(anotherAuthorizedExecutor.status, 200, 'another executor assigned to the exact source task may read its report image')
  assert.ok((await anotherAuthorizedExecutor.arrayBuffer()).byteLength > 0)

  const maintenanceExecutor = await request(
    'mzapp/feedback/active.jpg',
    null,
    { id: 'repairer-1', role: 'maintenance_staff' },
    'property_maintenance:feedback-active',
  )
  assert.equal(maintenanceExecutor.status, 200, 'an exact maintenance work-task assignee may read their own linked feedback media without joining the original cleaning task')
  assert.ok((await maintenanceExecutor.arrayBuffer()).byteLength > 0)

  const historicalActor = await request(
    'mzapp/feedback/historical-event.jpg',
    null,
    { id: 'repairer-1', role: 'maintenance_staff' },
    'property_maintenance:feedback-historical',
  )
  assert.equal(historicalActor.status, 200, 'an immutable completion-event actor may read their exact historical photo')
  assert.ok((await historicalActor.arrayBuffer()).byteLength > 0)

  const historicalReplacement = await request(
    'mzapp/feedback/historical-event.jpg',
    null,
    { id: 'replacement-repairer', role: 'maintenance_staff' },
    'property_maintenance:feedback-historical',
  )
  assert.equal(historicalReplacement.status, 403, 'a replacement assignee must not inherit the immutable actor photo')

  const wrongSamePropertySource = await request('mzapp/feedback/active.jpg', 'same-day-independent', inspector)
  assert.equal(wrongSamePropertySource.status, 403, 'same-property task context may not borrow another task report image')

  for (const invalidSource of ['cancelled-task', 'deleted-task', 'superseded-task']) {
    const invalid = await request(`mzapp/feedback/${invalidSource.replace('-task', '')}.jpg`, invalidSource, cleaner)
    assert.equal(invalid.status, 403, `${invalidSource} may not authorize historical report media`)
    const omittedContext = await request(`mzapp/feedback/${invalidSource.replace('-task', '')}.jpg`, null, cleaner)
    assert.equal(omittedContext.status, 403, `${invalidSource} remains denied when the client omits source_task_id`)
  }

  const unrelated = await request('mzapp/feedback/active.jpg', 'feedback-task', outsider)
  assert.equal(unrelated.status, 403, 'an unrelated worker may not read exact-source historical report media')
}

async function verifyInspectorCleaningProofRoutes(baseUrl: string) {
  media.push(...cleaningProofMedia)
  usageProofs.push({ id: 'legacy-usage', task_id: 'checkout-active', item_id: 'paper', photo_url: 'cleaning/route/legacy-usage.jpg', created_at: '2026-10-21T01:00:00.000Z' })
  const pair = ['checkout-active', 'checkin-active']
  const inspector = { id: 'inspector-1', role: 'cleaning_inspector' }
  const read = (key: string, ids = pair, user = inspector) => fetch(
    `${baseUrl}${mediaPath(key, ids, 'inspector', 'checkout-active')}`,
    { headers: userHeaders(user) },
  )
  for (const key of ['cleaning/route/cleaner-supplies.jpg', 'cleaning/route/cleaner-restock.jpg', 'cleaning/route/cleaner-legacy-media.jpg', 'cleaning/route/legacy-usage.jpg']) {
    const result = await read(key)
    assert.equal(result.status, 200, 'assigned inspector may read exact canonical cleaner supplies proof')
    assert.equal(result.headers.get('content-type'), 'image/jpeg')
    assert.ok((await result.arrayBuffer()).byteLength)
  }
  const history = await getJson(baseUrl, formPhotoPath('cleaning_tasks_inspector:history::record:completed:2026-10-21', pair, 'inspector'), inspector)
  assert.equal(history.response.status, 200)
  assert.deepEqual(history.body.items.filter((item: any) => ['restock', 'consumable'].includes(item.source)).map((item: any) => item.id).sort(), ['legacy-usage:0', 'restock-1', 'supplies-1', 'supplies-legacy-media'])

  const readsBeforeDenied = r2ReadCount
  for (const result of [
    await read('cleaning/route/cleaner-supplies.jpg', ['checkout-active', 'same-day-independent']),
    await read('cleaning/route/cleaner-supplies.jpg', [...pair, 'same-day-independent']),
    await read('cleaning/route/unrelated-restock.jpg'),
    await read('cleaning/route/ownerless.jpg'),
    await read('cleaning/route/cleaner-supplies.jpg', pair, { id: 'outsider-1', role: 'cleaning_inspector' }),
    await read('cleaning/route/cleaner-supplies.jpg', pair, { id: 'cleaner-1', role: 'cleaner' }),
  ]) {
    assert.equal(result.status, 403)
    assert.match(result.headers.get('cache-control') || '', /no-store/, 'permission errors must not persist as cached photo results')
  }
  assert.equal(r2ReadCount, readsBeforeDenied, 'denied and tampered references never reach storage')

  const checkin = tasks.find((task) => task.id === 'checkin-active')!
  checkin.inspector_id = 'inspector-2'
  checkin.assignee_id = 'inspector-2'
  try {
    const historical = await read('cleaning/route/cleaner-supplies.jpg')
    assert.equal(historical.status, 200, 'formal inspection actor keeps authorized own history after reassignment')
    await historical.arrayBuffer()
    media.push({ id: 'later-supplies', task_id: 'checkout-active', type: 'consumable_item_photo:paper', url: 'cleaning/route/later-supplies.jpg', uploader_id: 'cleaner-1', created_at: '2026-10-22T01:00:00.000Z' })
    media.push({ id: 'later-subsecond', task_id: 'checkout-active', type: 'restock_proof:paper', url: 'cleaning/route/later-subsecond.jpg', uploader_id: 'cleaner-1', created_at: new Date('2026-10-21T02:00:00.900Z') })
    assert.equal((await read('cleaning/route/later-supplies.jpg')).status, 403, 'former inspector cannot borrow later-round evidence on a reused source')
    assert.equal((await read('cleaning/route/later-subsecond.jpg')).status, 403, 'PostgreSQL Date values retain sub-second historical bounds')
    const historyAfterLaterUpload = await getJson(baseUrl, formPhotoPath('cleaning_tasks_inspector:history::record:completed:2026-10-21', pair, 'inspector'), inspector)
    assert.equal(historyAfterLaterUpload.body.items.some((item: any) => item.id === 'later-supplies'), false)
    assert.equal(historyAfterLaterUpload.body.items.some((item: any) => item.id === 'later-subsecond'), false)
    inspectionEvidence.get('inspector-1')!.delete('checkin-active')
    const revoked = await read('cleaning/route/cleaner-supplies.jpg')
    assert.equal(revoked.status, 403, 'former assignment without immutable execution evidence grants no access')
    const current = await read('cleaning/route/cleaner-supplies.jpg', pair, { id: 'inspector-2', role: 'cleaning_inspector' })
    assert.equal(current.status, 200, 'new current inspection duty may read the cleaner proof, not previous inspector media')
    await current.arrayBuffer()
    checkin.inspector_id = null
    checkin.inspection_scope = 'inspect_and_hang'
    assert.equal((await read('cleaning/route/cleaner-supplies.jpg', pair, { id: 'inspector-2', role: 'cleaning_inspector' })).status, 200, 'pure check-in inspector assignment uses MZ-074 effective assignee')
  } finally {
    checkin.inspector_id = 'inspector-1'
    checkin.assignee_id = 'inspector-1'
    checkin.inspection_scope = null
    inspectionEvidence.get('inspector-1')!.add('checkin-active')
  }
}

withRouteServer(async (baseUrl) => {
  await verifyWorkTaskListToMediaRoute(baseUrl)
  await verifyFormPhotoRoute(baseUrl)
  await verifyMediaByteRoute(baseUrl)
  await verifyLegacyInspectionPhotoRoute(baseUrl)
  await verifyHistoricalFeedbackMediaRoute(baseUrl)
  await verifyInspectorCleaningProofRoutes(baseUrl)
})
  .then(() => process.stdout.write('test_mzapp_form_photo_routes: ok\n'))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
