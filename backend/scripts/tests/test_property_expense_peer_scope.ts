import assert from 'node:assert/strict'
import { shouldScopePropertyExpenseByPeerRoleForRoles } from '../../src/modules/crud'

function testCustomerServiceStillScoped() {
  assert.equal(
    shouldScopePropertyExpenseByPeerRoleForRoles('property_expenses', ['customer_service'], false),
    true,
  )
}

function testFinanceAssistantWithCustomerServiceIsNotScoped() {
  assert.equal(
    shouldScopePropertyExpenseByPeerRoleForRoles(
      'property_expenses',
      ['Finance_staff_assistant', 'customer_service'],
      true,
    ),
    false,
  )
}

function testFinanceStaffIsNeverScoped() {
  assert.equal(
    shouldScopePropertyExpenseByPeerRoleForRoles('property_expenses', ['finance_staff', 'customer_service'], false),
    false,
  )
}

function testOtherResourcesAreNotScoped() {
  assert.equal(
    shouldScopePropertyExpenseByPeerRoleForRoles('company_expenses', ['customer_service'], false),
    false,
  )
}

testCustomerServiceStillScoped()
testFinanceAssistantWithCustomerServiceIsNotScoped()
testFinanceStaffIsNeverScoped()
testOtherResourcesAreNotScoped()

console.log('test_property_expense_peer_scope: ok')
