"use client"

export type MenuPermNode = {
  label: string
  perms?: string[]
  children?: Record<string, MenuPermNode>
}

export const MENU_PERMISSION_MAP: Record<string, MenuPermNode> = {
  'menu.dashboard': {
    label: '总览',
  },
  'menu.landlords': {
    label: '房东管理',
    perms: [
      'landlords.view',
      'landlords.write',
      'landlords.delete',
      'landlords.archive',
      'landlord.manage',
    ],
  },
  'menu.properties': {
    label: '房源管理',
    children: {
      'menu.properties.list.visible': {
        label: '房源列表',
        perms: [
          'properties.view',
          'properties.write',
          'properties.delete',
          'properties.archive',
        ],
      },
      'menu.properties.keys.visible': {
        label: '房源钥匙',
        perms: [
          'keyset.manage',
          'key.flow',
        ],
      },
    },
  },
  'menu.properties.maintenance.visible': {
    label: '房源维修',
    perms: [
      'property_maintenance.view',
      'property_maintenance.write',
      'property_maintenance.delete',
      'property_maintenance.archive',
      'repair_orders.view',
      'repair_orders.write',
      'repair_orders.delete',
      'repair_orders.archive',
    ],
  },
  'menu.properties.deep_cleaning.visible': {
    label: '深度清洁',
    perms: [
      'property_deep_cleaning.view',
      'property_deep_cleaning.write',
      'property_deep_cleaning.delete',
      'property_deep_cleaning.archive',
      'property_deep_cleaning.audit',
    ],
  },
  'menu.onboarding': {
    label: '房源上新',
    perms: [
      'onboarding.read',
      'onboarding.manage',
    ],
  },
  'menu.inventory': {
    label: '仓库库存',
    perms: [
      'inventory.move',
    ],
  },
  'menu.keys': {
    label: '钥匙管理',
    perms: [
      'keyset.manage',
      'key.flow',
    ],
  },
  'menu.finance': {
    label: '财务管理',
    children: {
      'menu.finance.orders.visible': {
        label: '订单管理',
        perms: [
          'order.view',
          'order.create',
          'order.write',
          'order.delete',
          'order.archive',
          'order.cancel',
          'order.confirm_payment',
          'order.deduction.manage',
        ],
      },
      'menu.finance.expenses.visible': {
        label: '房源支出',
        perms: [
          'property_expenses.view',
          'property_expenses.write',
          'property_expenses.delete',
          'property_expenses.archive',
        ],
      },
      'menu.finance.recurring.visible': {
        label: '固定支出',
        perms: [
          'recurring_payments.view',
          'recurring_payments.write',
          'recurring_payments.delete',
          'recurring_payments.archive',
        ],
      },
      'menu.finance.invoices.visible': {
        label: '发票中心',
        perms: [
          'invoice.view',
          'invoice.draft.create',
          'invoice.issue',
          'invoice.send',
          'invoice.void',
          'invoice.payment.record',
          'invoice.company.manage',
        ],
      },
      'menu.finance.company_overview.visible': {
        label: '财务总览',
        perms: [
          'finance_transactions.view',
          'finance_transactions.write',
          'finance_transactions.delete',
          'finance_transactions.archive',
          'finance.tx.write',
          'finance.payout',
        ],
      },
      'menu.finance.company_revenue.visible': {
        label: '公司营收',
        perms: [
          'company_incomes.view',
          'company_incomes.write',
          'company_incomes.delete',
          'company_incomes.archive',
          'company_expenses.view',
          'company_expenses.write',
          'company_expenses.delete',
          'company_expenses.archive',
        ],
      },
    },
  },
  'menu.cleaning': {
    label: '清洁安排',
    perms: [
      'cleaning.view',
      'cleaning.schedule.manage',
      'cleaning.task.assign',
      'cleaning_app.tasks.view.self',
      'cleaning_app.calendar.view.all',
      'cleaning_app.tasks.start',
      'cleaning_app.tasks.finish',
      'cleaning_app.inspect.finish',
      'cleaning_app.issues.report',
      'cleaning_app.media.upload',
      'cleaning_app.ready.set',
      'cleaning_app.assign',
      'cleaning_app.restock.manage',
      'cleaning_app.sse.subscribe',
      'cleaning_app.push.subscribe',
    ],
  },
  'menu.rbac': {
    label: '角色权限',
    perms: [
      'rbac.manage',
      'users.password.reset',
      'users.view',
      'users.write',
      'users.delete',
      'users.archive',
    ],
  },
  'menu.cms': {
    label: 'CMS管理',
    perms: [
      'cms_pages.view',
      'cms_pages.write',
      'cms_pages.delete',
      'cms_pages.archive',
    ],
  },
  'menu.jobs.email_sync.visible': {
    label: '系统任务 · 邮件同步',
  },
}

export function buildMenuKeySet(map: Record<string, MenuPermNode>) {
  const keys: string[] = []
  function walk(nodes: Record<string, MenuPermNode>) {
    Object.entries(nodes).forEach(([k, node]) => {
      keys.push(k)
      if (node.children) walk(node.children)
    })
  }
  walk(map)
  return new Set(keys)
}

export function buildPermToMenuIndex(map: Record<string, MenuPermNode>) {
  const m: Record<string, Set<string>> = {}
  function walk(nodes: Record<string, MenuPermNode>) {
    Object.entries(nodes).forEach(([k, node]) => {
      ;(node.perms || []).forEach((p) => {
        const code = String(p || '').trim()
        if (!code) return
        m[code] = m[code] || new Set<string>()
        m[code].add(k)
      })
      if (node.children) walk(node.children)
    })
  }
  walk(map)
  return m
}

export function findMenuNode(map: Record<string, MenuPermNode>, key: string): MenuPermNode | null {
  const target = String(key || '').trim()
  if (!target) return null
  let found: MenuPermNode | null = null
  function walk(nodes: Record<string, MenuPermNode>) {
    Object.entries(nodes).forEach(([k, node]) => {
      if (k === target) found = node
      if (!found && node.children) walk(node.children)
    })
  }
  walk(map)
  return found
}

export function findMenuPathLabels(map: Record<string, MenuPermNode>, key: string) {
  const target = String(key || '').trim()
  const path: string[] = []
  function walk(nodes: Record<string, MenuPermNode>, stack: string[]) {
    for (const [k, node] of Object.entries(nodes)) {
      const next = [...stack, node.label]
      if (k === target) { path.push(...next); return true }
      if (node.children) {
        const ok = walk(node.children, next)
        if (ok) return true
      }
    }
    return false
  }
  walk(map, [])
  return path
}

