import assert from 'assert'
import {
  APP_NOTIFICATION_GROUP_ROLE_KEYS,
  getAppNotificationPolicyCatalogMeta,
  resolveAppPolicyKeyFromKind,
  resolveAppPolicyTemplateGroupKeys,
} from '../../src/services/appNotificationPolicies'

function run() {
  assert.deepStrictEqual(APP_NOTIFICATION_GROUP_ROLE_KEYS.admin_users, ['admin'])
  assert.deepStrictEqual(APP_NOTIFICATION_GROUP_ROLE_KEYS.offline_manager_users, ['offline_manager'])
  assert.deepStrictEqual(APP_NOTIFICATION_GROUP_ROLE_KEYS.customer_service_users, ['customer_service'])
  assert.deepStrictEqual(APP_NOTIFICATION_GROUP_ROLE_KEYS.ops_manager_users, ['admin', 'offline_manager'])
  assert.ok(!(APP_NOTIFICATION_GROUP_ROLE_KEYS.ops_manager_users || []).includes('customer_service'))

  assert.deepStrictEqual(
    resolveAppPolicyTemplateGroupKeys('key_photo_uploaded', 'participants_plus_ops_manager'),
    ['cleaning_task_participants', 'ops_manager_users'],
  )
  assert.deepStrictEqual(
    resolveAppPolicyTemplateGroupKeys('issue_reported', 'participants_plus_ops_manager_and_customer_service'),
    ['cleaning_task_participants', 'ops_manager_users', 'customer_service_users'],
  )
  assert.deepStrictEqual(
    resolveAppPolicyTemplateGroupKeys('work_task_completed', 'worktask_assignee_plus_ops_manager'),
    ['work_task_assignee', 'ops_manager_users'],
  )

  assert.strictEqual(getAppNotificationPolicyCatalogMeta('guest_checked_out').default_template_key, 'participants_plus_ops_manager_and_customer_service')
  assert.strictEqual(getAppNotificationPolicyCatalogMeta('task_requirements_changed').default_template_key, 'participants_plus_ops_manager_and_customer_service')
  assert.strictEqual(getAppNotificationPolicyCatalogMeta('issue_reported').default_template_key, 'participants_plus_ops_manager_and_customer_service')
  assert.strictEqual(getAppNotificationPolicyCatalogMeta('keys_hung').default_template_key, 'participants_plus_ops_manager')
  assert.strictEqual(getAppNotificationPolicyCatalogMeta('guest_luggage_updated').default_template_key, 'participants_plus_ops_manager_and_customer_service')
  assert.strictEqual(getAppNotificationPolicyCatalogMeta('warehouse_key_updated').default_template_key, 'participants_plus_ops_manager')
  assert.strictEqual(getAppNotificationPolicyCatalogMeta('work_task_completed').default_template_key, 'worktask_assignee_plus_ops_manager')
  assert.strictEqual(getAppNotificationPolicyCatalogMeta('key_upload_sla_escalation').default_template_key, 'ops_manager_only')

  assert.strictEqual(resolveAppPolicyKeyFromKind('cleaning_task_manager_fields_updated'), 'task_requirements_changed')
  assert.strictEqual(resolveAppPolicyKeyFromKind('guest_luggage_deleted'), 'guest_luggage_updated')
  assert.strictEqual(resolveAppPolicyKeyFromKind('consumables_updated'), 'consumables_submitted')
  assert.strictEqual(resolveAppPolicyKeyFromKind('key_upload_sla', { level: 'remind' }), 'key_upload_sla_reminder')
  assert.strictEqual(resolveAppPolicyKeyFromKind('key_upload_sla', { level: 'escalation' }), 'key_upload_sla_escalation')
  assert.strictEqual(resolveAppPolicyKeyFromKind('unknown_kind'), null)

  console.log('ok')
}

run()
