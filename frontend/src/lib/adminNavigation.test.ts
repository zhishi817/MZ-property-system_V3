import { describe, expect, it } from 'vitest'
import { ADMIN_NAVIGATION, buildSidebarNavigation } from './adminNavigation'

describe('CMS navigation consolidation', () => {
  it('keeps exactly the three planned CMS entries', () => {
    const cms = ADMIN_NAVIGATION.find((item) => item.id === 'cms')
    expect(cms?.children?.map((item) => item.label)).toEqual([
      '公司内容中心',
      '公开指南与外链',
      '线下密码管理',
    ])
  })

  it('shows the consolidated entries when their resource permissions are granted', () => {
    const permissions = new Set([
      'menu.cms',
      'cms_pages.view',
      'cms_public_access.manage',
      'company_secret_items.view',
    ])
    const sidebar = buildSidebarNavigation(ADMIN_NAVIGATION, (code) => permissions.has(code))
    const cms = sidebar.find((item) => item.id === 'cms')

    expect(cms?.children?.map((item) => item.href)).toEqual([
      '/cms/company',
      '/cms/public-resources',
      '/cms/offline-passwords',
    ])
  })
})

describe('personnel settlement navigation', () => {
  it('adds the exact 费用结算 submenu behind its dedicated permission', () => {
    const permissions = new Set([
      'menu.finance',
      'menu.finance.personnel_settlements.visible',
    ])
    const sidebar = buildSidebarNavigation(ADMIN_NAVIGATION, (code) => permissions.has(code))
    const finance = sidebar.find((item) => item.id === 'finance')
    const settlement = finance?.children?.find((item) => item.id === 'finance-personnel-settlements')

    expect(settlement).toEqual(expect.objectContaining({
      label: '费用结算',
      href: '/finance/settlements',
    }))
  })
})
