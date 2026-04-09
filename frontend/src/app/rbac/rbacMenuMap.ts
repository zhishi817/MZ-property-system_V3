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
        label: '房源管理',
        children: {
          'menu.properties.list.index.visible': {
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
          'menu.properties.guides.visible': {
            label: '入住指南',
            perms: [
              'property_guides.view',
              'property_guides.write',
              'property_guides.delete',
              'property_guides.archive',
            ],
          },
        },
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
    label: '仓库管理',
    children: {
      'menu.inventory.overview.visible': {
        label: '仓库总览',
        perms: ['inventory.view'],
      },
      'menu.inventory.warehouses.visible': {
        label: '仓库列表',
        perms: ['inventory.view'],
      },
      'menu.inventory.linen.visible': {
        label: '床品管理',
        children: {
          'menu.inventory.linen.stocks.visible': {
            label: '床品库存',
            perms: ['inventory.view'],
          },
          'menu.inventory.linen.purchase_orders.visible': {
            label: '床品采购记录',
            perms: ['inventory.po.manage'],
          },
          'menu.inventory.linen.deliveries.visible': {
            label: '床品配送记录',
            perms: ['inventory.po.manage', 'inventory.move'],
          },
          'menu.inventory.linen.usage.visible': {
            label: '床品使用记录',
            perms: ['inventory.move'],
          },
          'menu.inventory.linen.returns.visible': {
            label: '床品退货记录',
            perms: ['inventory.move', 'inventory.po.manage'],
          },
        },
      },
      'menu.inventory.daily.visible': {
        label: '日用品管理',
        children: {
          'menu.inventory.daily.stocks.visible': {
            label: '日用品库存',
            perms: ['inventory.view'],
          },
          'menu.inventory.daily.prices.visible': {
            label: '日用品价格表',
            perms: ['inventory.view', 'inventory.po.manage'],
          },
          'menu.inventory.daily.purchase_orders.visible': {
            label: '日用品采购记录',
            perms: ['inventory.po.manage'],
          },
          'menu.inventory.daily.deliveries.visible': {
            label: '日用品配送记录',
            perms: ['inventory.po.manage', 'inventory.move'],
          },
          'menu.inventory.daily.replacements.visible': {
            label: '日用品更换记录',
            perms: ['inventory.move'],
          },
        },
      },
      'menu.inventory.consumable.visible': {
        label: '消耗品管理',
        children: {
          'menu.inventory.consumable.stocks.visible': {
            label: '消耗品库存',
            perms: ['inventory.view'],
          },
          'menu.inventory.consumable.prices.visible': {
            label: '消耗品价格表',
            perms: ['inventory.view', 'inventory.po.manage'],
          },
          'menu.inventory.consumable.purchase_orders.visible': {
            label: '消耗品采购记录',
            perms: ['inventory.po.manage'],
          },
          'menu.inventory.consumable.deliveries.visible': {
            label: '消耗品配送记录',
            perms: ['inventory.po.manage', 'inventory.move'],
          },
          'menu.inventory.consumable.usage.visible': {
            label: '消耗品使用记录',
            perms: ['inventory.move'],
          },
        },
      },
      'menu.inventory.other.visible': {
        label: '其他物品管理',
        children: {
          'menu.inventory.other.stocks.visible': {
            label: '其他物品库存',
            perms: ['inventory.view'],
          },
          'menu.inventory.other.prices.visible': {
            label: '其他物品价格表',
            perms: ['inventory.po.manage'],
          },
          'menu.inventory.other.purchase_orders.visible': {
            label: '其他物品采购记录',
            perms: ['inventory.po.manage'],
          },
          'menu.inventory.other.deliveries.visible': {
            label: '其他物品配送记录',
            perms: ['inventory.po.manage', 'inventory.move'],
          },
          'menu.inventory.other.usage.visible': {
            label: '其他物品使用记录',
            perms: ['inventory.move'],
          },
        },
      },
      'menu.inventory.suppliers.visible': {
        label: '供应商管理',
        children: {
          'menu.inventory.suppliers.list.visible': {
            label: '供应商列表',
            perms: ['inventory.po.manage'],
          },
          'menu.inventory.suppliers.region_rules.visible': {
            label: '供应区域规则',
            perms: ['inventory.po.manage'],
          },
        },
      },
      'menu.inventory.movements.visible': {
        label: '库存流水',
        perms: ['inventory.view', 'inventory.move'],
      },
    },
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
    label: '线下事务',
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
    children: {
      'menu.cms.visible': {
        label: '页面管理',
        perms: [
          'cms_pages.view',
          'cms_pages.write',
          'cms_pages.delete',
          'cms_pages.archive',
        ],
      },
    },
  },
  'menu.inventory.audits.visible': {
    label: '操作日志',
    perms: ['inventory.view'],
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
      if (k === target) {
        path.splice(0, path.length, ...next)
        return true
      }
      if (node.children && walk(node.children, next)) return true
    }
    return false
  }
  walk(map, [])
  return path
}
