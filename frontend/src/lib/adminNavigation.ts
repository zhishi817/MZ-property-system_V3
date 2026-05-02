export type AdminNavNode = {
  id: string
  label: string
  href?: string
  visibleWhenAny?: string[]
  rbacKey?: string
  actionPerms?: string[]
  children?: AdminNavNode[]
}

export type SidebarNavNode = {
  id: string
  label: string
  href?: string
  children?: SidebarNavNode[]
}

export type MenuPermTreeNode = {
  key: string
  label: string
  checkable: boolean
  perms: string[]
  children?: MenuPermTreeNode[]
}

export const ADMIN_NAVIGATION: AdminNavNode[] = [
  {
    id: 'dashboard',
    label: '总览',
    href: '/dashboard',
    visibleWhenAny: ['menu.dashboard'],
    rbacKey: 'menu.dashboard',
  },
  {
    id: 'landlords',
    label: '房东管理',
    visibleWhenAny: ['menu.landlords'],
    rbacKey: 'menu.landlords',
    actionPerms: ['landlords.view', 'landlords.write', 'landlords.delete', 'landlords.archive', 'landlord.manage'],
    children: [
      { id: 'landlords-list', label: '房东列表', href: '/landlords' },
      { id: 'landlords-agreements', label: '授权协议', href: '/landlords/agreements' },
      { id: 'landlords-contracts', label: '房源合同', href: '/landlords/contracts' },
    ],
  },
  {
    id: 'properties',
    label: '房源管理',
    visibleWhenAny: ['menu.properties'],
    rbacKey: 'menu.properties',
    children: [
      {
        id: 'properties-list',
        label: '房源列表',
        href: '/properties',
        visibleWhenAny: ['menu.properties.list.visible'],
        rbacKey: 'menu.properties.list.visible',
        actionPerms: ['properties.view', 'properties.write', 'properties.delete', 'properties.archive'],
      },
      {
        id: 'properties-keys',
        label: '房源钥匙',
        href: '/keys',
        visibleWhenAny: ['menu.properties.keys.visible'],
        rbacKey: 'menu.properties.keys.visible',
        actionPerms: ['keyset.manage', 'key.flow'],
      },
      {
        id: 'properties-guides',
        label: '入住指南',
        href: '/properties/guides',
        visibleWhenAny: ['menu.properties.guides.visible'],
        rbacKey: 'menu.properties.guides.visible',
        actionPerms: ['property_guides.view', 'property_guides.write', 'property_guides.delete', 'property_guides.archive'],
      },
    ],
  },
  {
    id: 'maintenance',
    label: '房源维修',
    visibleWhenAny: ['menu.properties.maintenance.visible'],
    rbacKey: 'menu.properties.maintenance.visible',
    actionPerms: ['property_maintenance.view', 'property_maintenance.write', 'property_maintenance.delete', 'property_maintenance.archive'],
    children: [
      { id: 'maintenance-overview', label: '维修总览', href: '/maintenance/overview' },
      { id: 'maintenance-records', label: '维修记录', href: '/maintenance/records' },
      {
        id: 'maintenance-public-repair',
        label: '房源报修表',
        href: '/maintenance/public-repair',
        visibleWhenAny: ['menu.properties.public_repair.visible'],
      },
      { id: 'maintenance-progress', label: '维修进度表', href: '/maintenance/progress' },
    ],
  },
  {
    id: 'deep-cleaning',
    label: '深度清洁',
    visibleWhenAny: ['menu.properties.deep_cleaning.visible'],
    rbacKey: 'menu.properties.deep_cleaning.visible',
    actionPerms: [
      'property_deep_cleaning.view',
      'property_deep_cleaning.write',
      'property_deep_cleaning.delete',
      'property_deep_cleaning.archive',
      'property_deep_cleaning.audit',
    ],
    children: [
      { id: 'deep-cleaning-overview', label: '清洁总览', href: '/deep-cleaning/overview' },
      { id: 'deep-cleaning-records', label: '清洁记录', href: '/deep-cleaning/records' },
      { id: 'deep-cleaning-upload', label: '清洁上传表', href: '/deep-cleaning/upload' },
      { id: 'deep-cleaning-share-password', label: '外链密码', href: '/deep-cleaning/share-password' },
    ],
  },
  {
    id: 'onboarding',
    label: '房源上新',
    visibleWhenAny: ['menu.onboarding'],
    rbacKey: 'menu.onboarding',
    actionPerms: ['onboarding.read', 'onboarding.manage'],
    children: [
      { id: 'onboarding-list', label: '上新管理', href: '/onboarding' },
      { id: 'onboarding-fa-prices', label: '家具/家电价格表', href: '/onboarding/fa-prices' },
    ],
  },
  {
    id: 'inventory',
    label: '仓库管理',
    visibleWhenAny: [
      'menu.inventory',
      'menu.inventory.overview.visible',
      'menu.inventory.warehouses.visible',
      'menu.inventory.linen.visible',
      'menu.inventory.daily.visible',
      'menu.inventory.consumable.visible',
      'menu.inventory.other.visible',
      'menu.inventory.suppliers.visible',
      'menu.inventory.movements.visible',
    ],
    rbacKey: 'menu.inventory',
    children: [
      {
        id: 'inventory-overview',
        label: '仓库总览',
        href: '/inventory/overview',
        visibleWhenAny: ['menu.inventory.overview.visible'],
        rbacKey: 'menu.inventory.overview.visible',
        actionPerms: ['inventory.view'],
      },
      {
        id: 'inventory-warehouses',
        label: '仓库列表',
        href: '/inventory/warehouses',
        visibleWhenAny: ['menu.inventory.warehouses.visible'],
        rbacKey: 'menu.inventory.warehouses.visible',
        actionPerms: ['inventory.view'],
      },
      {
        id: 'inventory-linen',
        label: '床品管理',
        visibleWhenAny: ['menu.inventory.linen.visible'],
        rbacKey: 'menu.inventory.linen.visible',
        children: [
          {
            id: 'inventory-linen-stocks',
            label: '床品库存',
            href: '/inventory/category/linen/stocks',
            visibleWhenAny: ['menu.inventory.linen.stocks.visible'],
            rbacKey: 'menu.inventory.linen.stocks.visible',
            actionPerms: ['inventory.view'],
          },
          {
            id: 'inventory-linen-purchase-orders',
            label: '床品采购记录',
            href: '/inventory/category/linen/purchase-orders',
            visibleWhenAny: ['menu.inventory.linen.purchase_orders.visible'],
            rbacKey: 'menu.inventory.linen.purchase_orders.visible',
            actionPerms: ['inventory.po.manage'],
          },
          {
            id: 'inventory-linen-deliveries',
            label: '床品配送记录',
            href: '/inventory/category/linen/deliveries',
            visibleWhenAny: ['menu.inventory.linen.deliveries.visible'],
            rbacKey: 'menu.inventory.linen.deliveries.visible',
            actionPerms: ['inventory.po.manage', 'inventory.move'],
          },
          {
            id: 'inventory-linen-usage',
            label: '床品使用记录',
            href: '/inventory/category/linen/usage',
            visibleWhenAny: ['menu.inventory.linen.usage.visible'],
            rbacKey: 'menu.inventory.linen.usage.visible',
            actionPerms: ['inventory.move'],
          },
          {
            id: 'inventory-linen-returns',
            label: '床品退货记录',
            href: '/inventory/category/linen/returns',
            visibleWhenAny: ['menu.inventory.linen.returns.visible'],
            rbacKey: 'menu.inventory.linen.returns.visible',
            actionPerms: ['inventory.move', 'inventory.po.manage'],
          },
        ],
      },
      {
        id: 'inventory-daily',
        label: '日用品管理',
        visibleWhenAny: ['menu.inventory.daily.visible'],
        rbacKey: 'menu.inventory.daily.visible',
        children: [
          {
            id: 'inventory-daily-stocks',
            label: '日用品库存',
            href: '/inventory/category/daily/stocks',
            visibleWhenAny: ['menu.inventory.daily.stocks.visible'],
            rbacKey: 'menu.inventory.daily.stocks.visible',
            actionPerms: ['inventory.view'],
          },
          {
            id: 'inventory-daily-prices',
            label: '日用品价格表',
            href: '/inventory/category/daily/prices',
            visibleWhenAny: ['menu.inventory.daily.prices.visible'],
            rbacKey: 'menu.inventory.daily.prices.visible',
            actionPerms: ['inventory.view', 'inventory.po.manage'],
          },
          {
            id: 'inventory-daily-purchase-orders',
            label: '日用品采购记录',
            href: '/inventory/category/daily/purchase-orders',
            visibleWhenAny: ['menu.inventory.daily.purchase_orders.visible'],
            rbacKey: 'menu.inventory.daily.purchase_orders.visible',
            actionPerms: ['inventory.po.manage'],
          },
          {
            id: 'inventory-daily-deliveries',
            label: '日用品配送记录',
            href: '/inventory/category/daily/deliveries',
            visibleWhenAny: ['menu.inventory.daily.deliveries.visible'],
            rbacKey: 'menu.inventory.daily.deliveries.visible',
            actionPerms: ['inventory.po.manage', 'inventory.move'],
          },
          {
            id: 'inventory-daily-replacements',
            label: '日用品更换记录',
            href: '/inventory/category/daily/replacements',
            visibleWhenAny: ['menu.inventory.daily.replacements.visible'],
            rbacKey: 'menu.inventory.daily.replacements.visible',
            actionPerms: ['inventory.move'],
          },
        ],
      },
      {
        id: 'inventory-consumable',
        label: '消耗品管理',
        visibleWhenAny: ['menu.inventory.consumable.visible'],
        rbacKey: 'menu.inventory.consumable.visible',
        children: [
          {
            id: 'inventory-consumable-stocks',
            label: '消耗品库存',
            href: '/inventory/category/consumable/stocks',
            visibleWhenAny: ['menu.inventory.consumable.stocks.visible'],
            rbacKey: 'menu.inventory.consumable.stocks.visible',
            actionPerms: ['inventory.view'],
          },
          {
            id: 'inventory-consumable-prices',
            label: '消耗品价格表',
            href: '/inventory/category/consumable/prices',
            visibleWhenAny: ['menu.inventory.consumable.prices.visible'],
            rbacKey: 'menu.inventory.consumable.prices.visible',
            actionPerms: ['inventory.view', 'inventory.po.manage'],
          },
          {
            id: 'inventory-consumable-purchase-orders',
            label: '消耗品采购记录',
            href: '/inventory/category/consumable/purchase-orders',
            visibleWhenAny: ['menu.inventory.consumable.purchase_orders.visible'],
            rbacKey: 'menu.inventory.consumable.purchase_orders.visible',
            actionPerms: ['inventory.po.manage'],
          },
          {
            id: 'inventory-consumable-deliveries',
            label: '消耗品配送记录',
            href: '/inventory/category/consumable/deliveries',
            visibleWhenAny: ['menu.inventory.consumable.deliveries.visible'],
            rbacKey: 'menu.inventory.consumable.deliveries.visible',
            actionPerms: ['inventory.po.manage', 'inventory.move'],
          },
          {
            id: 'inventory-consumable-usage',
            label: '消耗品使用记录',
            href: '/inventory/category/consumable/usage',
            visibleWhenAny: ['menu.inventory.consumable.usage.visible'],
            rbacKey: 'menu.inventory.consumable.usage.visible',
            actionPerms: ['inventory.move'],
          },
        ],
      },
      {
        id: 'inventory-other',
        label: '其他物品管理',
        visibleWhenAny: ['menu.inventory.other.visible'],
        rbacKey: 'menu.inventory.other.visible',
        children: [
          {
            id: 'inventory-other-stocks',
            label: '其他物品库存',
            href: '/inventory/category/other/stocks',
            visibleWhenAny: ['menu.inventory.other.stocks.visible'],
            rbacKey: 'menu.inventory.other.stocks.visible',
            actionPerms: ['inventory.view'],
          },
          {
            id: 'inventory-other-prices',
            label: '其他物品价格表',
            href: '/inventory/category/other/prices',
            visibleWhenAny: ['menu.inventory.other.prices.visible'],
            rbacKey: 'menu.inventory.other.prices.visible',
            actionPerms: ['inventory.po.manage'],
          },
          {
            id: 'inventory-other-purchase-orders',
            label: '其他物品采购记录',
            href: '/inventory/category/other/purchase-orders',
            visibleWhenAny: ['menu.inventory.other.purchase_orders.visible'],
            rbacKey: 'menu.inventory.other.purchase_orders.visible',
            actionPerms: ['inventory.po.manage'],
          },
          {
            id: 'inventory-other-deliveries',
            label: '其他物品配送记录',
            href: '/inventory/category/other/deliveries',
            visibleWhenAny: ['menu.inventory.other.deliveries.visible'],
            rbacKey: 'menu.inventory.other.deliveries.visible',
            actionPerms: ['inventory.po.manage', 'inventory.move'],
          },
          {
            id: 'inventory-other-usage',
            label: '其他物品使用记录',
            href: '/inventory/category/other/usage',
            visibleWhenAny: ['menu.inventory.other.usage.visible'],
            rbacKey: 'menu.inventory.other.usage.visible',
            actionPerms: ['inventory.move'],
          },
        ],
      },
      {
        id: 'inventory-suppliers',
        label: '供应商管理',
        visibleWhenAny: ['menu.inventory.suppliers.visible'],
        rbacKey: 'menu.inventory.suppliers.visible',
        children: [
          {
            id: 'inventory-suppliers-list',
            label: '供应商列表',
            href: '/inventory/suppliers',
            visibleWhenAny: ['menu.inventory.suppliers.list.visible'],
            rbacKey: 'menu.inventory.suppliers.list.visible',
            actionPerms: ['inventory.po.manage'],
          },
          {
            id: 'inventory-suppliers-region-rules',
            label: '供应区域规则',
            href: '/inventory/region-rules',
            visibleWhenAny: ['menu.inventory.suppliers.region_rules.visible'],
            rbacKey: 'menu.inventory.suppliers.region_rules.visible',
            actionPerms: ['inventory.po.manage'],
          },
        ],
      },
      {
        id: 'inventory-movements',
        label: '库存流水',
        href: '/inventory/movements',
        visibleWhenAny: ['menu.inventory.movements.visible'],
        rbacKey: 'menu.inventory.movements.visible',
        actionPerms: ['inventory.view', 'inventory.move'],
      },
    ],
  },
  {
    id: 'keys',
    label: '钥匙管理',
    href: '/keys',
    visibleWhenAny: ['menu.keys'],
    rbacKey: 'menu.keys',
    actionPerms: ['keyset.manage', 'key.flow'],
  },
  {
    id: 'finance',
    label: '财务管理',
    visibleWhenAny: ['menu.finance'],
    rbacKey: 'menu.finance',
    children: [
      {
        id: 'finance-orders',
        label: '订单管理',
        href: '/orders',
        visibleWhenAny: ['menu.finance.orders.visible'],
        rbacKey: 'menu.finance.orders.visible',
        actionPerms: [
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
      {
        id: 'finance-expenses',
        label: '房源支出',
        href: '/finance/expenses',
        visibleWhenAny: ['menu.finance.expenses.visible'],
        rbacKey: 'menu.finance.expenses.visible',
        actionPerms: ['property_expenses.view', 'property_expenses.write', 'property_expenses.delete', 'property_expenses.archive'],
      },
      {
        id: 'finance-recurring',
        label: '固定支出',
        href: '/finance/recurring',
        visibleWhenAny: ['menu.finance.recurring.visible'],
        rbacKey: 'menu.finance.recurring.visible',
        actionPerms: ['recurring_payments.view', 'recurring_payments.write', 'recurring_payments.delete', 'recurring_payments.archive'],
      },
      {
        id: 'finance-invoices',
        label: '发票中心',
        href: '/finance/invoices',
        visibleWhenAny: ['menu.finance.invoices.visible'],
        rbacKey: 'menu.finance.invoices.visible',
        actionPerms: ['invoice.view', 'invoice.draft.create', 'invoice.issue', 'invoice.send', 'invoice.void', 'invoice.payment.record', 'invoice.company.manage'],
      },
      {
        id: 'finance-transactions',
        label: '交易流水',
        href: '/finance/transactions',
        visibleWhenAny: ['menu.finance.company_overview.visible', 'finance.tx.write', 'finance_transactions.view'],
      },
      {
        id: 'finance-performance',
        label: '房源表现',
        visibleWhenAny: ['menu.finance.company_overview.visible'],
        rbacKey: 'menu.finance.company_overview.visible',
        actionPerms: [
          'finance_transactions.view',
          'finance_transactions.write',
          'finance_transactions.delete',
          'finance_transactions.archive',
          'finance.tx.write',
          'finance.payout',
        ],
        children: [
          { id: 'finance-performance-overview', label: '经营分析', href: '/finance/performance/overview' },
          { id: 'finance-performance-revenue', label: '房源营收', href: '/finance/performance/revenue' },
          { id: 'finance-performance-property', label: '单房源分析', href: '/finance/performance/property' },
        ],
      },
      {
        id: 'finance-company-revenue',
        label: '公司营收',
        href: '/finance/company-revenue',
        visibleWhenAny: ['menu.finance.company_revenue.visible'],
        rbacKey: 'menu.finance.company_revenue.visible',
        actionPerms: [
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
    ],
  },
  {
    id: 'cleaning',
    label: '线下事务',
    visibleWhenAny: ['menu.cleaning'],
    rbacKey: 'menu.cleaning',
    actionPerms: [
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
    children: [
      {
        id: 'cleaning-overview',
        label: '线下总览',
        href: '/cleaning/overview',
        visibleWhenAny: ['menu.cleaning.overview.visible', 'menu.cleaning'],
        rbacKey: 'menu.cleaning.overview.visible',
        actionPerms: ['cleaning.view', 'cleaning.schedule.manage', 'cleaning.task.assign'],
      },
      {
        id: 'task-center',
        label: '任务安排',
        href: '/task-center',
        visibleWhenAny: ['menu.cleaning.task_center.visible', 'menu.cleaning'],
        rbacKey: 'menu.cleaning.task_center.visible',
        actionPerms: ['cleaning.view', 'cleaning.schedule.manage', 'cleaning.task.assign', 'cleaning_app.ready.set'],
      },
      {
        id: 'cleaning-schedule',
        label: '每日清洁',
        href: '/cleaning',
        visibleWhenAny: ['menu.cleaning.daily.visible', 'menu.cleaning'],
        rbacKey: 'menu.cleaning.daily.visible',
        actionPerms: ['cleaning.view', 'cleaning.schedule.manage', 'cleaning.task.assign'],
      },
    ],
  },
  {
    id: 'rbac',
    label: '角色权限',
    visibleWhenAny: ['menu.rbac', 'rbac.manage'],
    rbacKey: 'menu.rbac',
    actionPerms: ['rbac.manage', 'users.password.reset', 'users.view', 'users.write', 'users.delete', 'users.archive'],
    children: [
      { id: 'rbac-home', label: '角色权限', href: '/rbac' },
      { id: 'rbac-notification-rules', label: '通知规则', href: '/rbac/notification-rules' },
    ],
  },
  {
    id: 'jobs',
    label: '系统任务',
    visibleWhenAny: ['menu.jobs.email_sync.visible'],
    rbacKey: 'menu.jobs.email_sync.visible',
    children: [
      { id: 'jobs-email-sync', label: '邮件同步', href: '/jobs/email-sync' },
      { id: 'jobs-cleaning-sync-jobs', label: '清洁同步队列', href: '/jobs/cleaning-sync-jobs' },
      { id: 'jobs-cleaning-sync-retry', label: '清洁同步重试', href: '/jobs/cleaning-sync-retry' },
      { id: 'jobs-cleaning-backfill', label: '清洁回填自动化', href: '/jobs/cleaning-backfill' },
    ],
  },
  {
    id: 'cms',
    label: 'CMS管理',
    visibleWhenAny: ['menu.cms'],
    rbacKey: 'menu.cms',
    children: [
      {
        id: 'cms-home',
        label: '页面管理',
        href: '/cms',
        rbacKey: 'menu.cms.visible',
        actionPerms: ['cms_pages.view', 'cms_pages.write', 'cms_pages.delete', 'cms_pages.archive'],
      },
      { id: 'cms-public-cleaning', label: '清洁公开指南', href: '/cms/public-cleaning' },
      { id: 'cms-public-cleaning-password', label: '公开访问密码', href: '/cms/public-cleaning-password' },
      { id: 'cms-company', label: '公司内容中心', href: '/cms/company' },
    ],
  },
  {
    id: 'inventory-audits',
    label: '操作日志',
    href: '/inventory/audits',
    visibleWhenAny: ['menu.inventory.audits.visible'],
    rbacKey: 'menu.inventory.audits.visible',
    actionPerms: ['inventory.view'],
  },
]

export function buildSidebarNavigation(nodes: AdminNavNode[], hasPerm: (code: string) => boolean): SidebarNavNode[] {
  function walk(node: AdminNavNode): SidebarNavNode | null {
    const ownVisible = !node.visibleWhenAny?.length || node.visibleWhenAny.some((code) => hasPerm(code))
    if (!ownVisible) return null
    const children = (node.children || []).map(walk).filter(Boolean) as SidebarNavNode[]
    if (node.children?.length && !node.href && !children.length) return null
    return {
      id: node.id,
      label: node.label,
      href: node.href,
      children: children.length ? children : undefined,
    }
  }
  return nodes.map(walk).filter(Boolean) as SidebarNavNode[]
}

export function buildMenuPermissionTree(nodes: AdminNavNode[]): MenuPermTreeNode[] {
  function walk(node: AdminNavNode): MenuPermTreeNode | null {
    const children = (node.children || []).map(walk).filter(Boolean) as MenuPermTreeNode[]
    const perms = (node.actionPerms || []).map((code) => String(code || '')).filter(Boolean)
    if (!node.rbacKey && !children.length && !perms.length) return null
    return {
      key: node.rbacKey || `group:${node.id}`,
      label: node.label,
      checkable: !!node.rbacKey,
      perms,
      children: children.length ? children : undefined,
    }
  }
  return nodes.map(walk).filter(Boolean) as MenuPermTreeNode[]
}
