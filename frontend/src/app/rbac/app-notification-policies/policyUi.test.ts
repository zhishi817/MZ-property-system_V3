import { describe, expect, it } from 'vitest'
import { buildPolicyForm, buildPolicySummary, isPolicyDirty, type AppNotificationPolicy } from './policyUi'

const groups = [
  { key: 'ops_manager_users' as const, label: '运营经理组（admin + 线下经理）', description: '' },
  { key: 'customer_service_users' as const, label: '客服', description: '' },
  { key: 'warehouse_related_users' as const, label: '仓库相关人', description: '' },
]

const templates = [
  { key: 'participants_plus_ops_manager' as const, label: '', description: '', summary_label: '当前任务参与人 + 运营经理组' },
  { key: 'participants_plus_ops_manager_and_customer_service' as const, label: '', description: '', summary_label: '当前任务参与人 + 运营经理组 + 客服' },
  { key: 'explicit_only' as const, label: '', description: '', summary_label: '仅显式追加' },
]

const users = [
  { id: 'u1', username: 'Miranda', role: 'admin' },
  { id: 'u2', username: 'Alice', role: 'customer_service' },
]

const policy: AppNotificationPolicy = {
  policy_key: 'guest_checked_out',
  enabled: true,
  template_key: 'participants_plus_ops_manager_and_customer_service',
  extra_group_keys: [],
  extra_user_ids: [],
  note: null,
  version: 0,
  updated_at: null,
  updated_by: null,
  catalog_meta: {
    policy_key: 'guest_checked_out',
    label: '客人已退房',
    description: '',
    source_event_types: ['CLEANING_TASK_UPDATED'],
    default_template_key: 'participants_plus_ops_manager_and_customer_service',
    allowed_group_keys: ['ops_manager_users', 'customer_service_users', 'warehouse_related_users'],
    supports_extra_users: true,
    default_enabled: true,
  },
}

describe('policyUi', () => {
  it('builds explicit summary with customer service and named users', () => {
    const summary = buildPolicySummary({
      policyKey: 'guest_checked_out',
      templateKey: 'participants_plus_ops_manager_and_customer_service',
      extraGroupKeys: [],
      extraUserIds: ['u1'],
      groups,
      templates,
      users,
    })
    expect(summary).toBe('当前任务参与人 + 运营经理组 + 客服 + Miranda')
  })

  it('does not duplicate ops manager when extra group repeats template scope', () => {
    const summary = buildPolicySummary({
      policyKey: 'guest_checked_out',
      templateKey: 'participants_plus_ops_manager',
      extraGroupKeys: ['ops_manager_users', 'warehouse_related_users'],
      extraUserIds: [],
      groups,
      templates,
      users,
    })
    expect(summary).toBe('当前任务参与人 + 运营经理组 + 仓库相关人')
  })

  it('uses related participant wording for warehouse key updates', () => {
    const summary = buildPolicySummary({
      policyKey: 'warehouse_key_updated',
      templateKey: 'participants_plus_ops_manager',
      extraGroupKeys: [],
      extraUserIds: [],
      groups,
      templates,
      users,
    })
    expect(summary).toBe('相关任务参与人 + 运营经理组')
  })

  it('marks explicit_only empty summary clearly', () => {
    const summary = buildPolicySummary({
      policyKey: 'day_end_handover_reminder',
      templateKey: 'explicit_only',
      extraGroupKeys: [],
      extraUserIds: [],
      groups,
      templates,
      users,
    })
    expect(summary).toBe('仅显式追加（当前无接收人）')
  })

  it('tracks dirty state from template and extra users', () => {
    const form = buildPolicyForm(policy)
    expect(isPolicyDirty(policy, form)).toBe(false)
    expect(isPolicyDirty(policy, { ...form, template_key: 'participants_plus_ops_manager' })).toBe(true)
    expect(isPolicyDirty(policy, { ...form, extra_user_ids: ['u1'] })).toBe(true)
  })
})
