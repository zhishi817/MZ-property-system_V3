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
