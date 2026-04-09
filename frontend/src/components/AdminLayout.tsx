"use client"
import { Layout, Button, Space, Tag } from 'antd'
import {
  ApartmentOutlined,
  KeyOutlined,
  ProfileOutlined,
  ShopOutlined,
  TeamOutlined,
  DollarOutlined,
  CalendarOutlined,
} from '@ant-design/icons'
import Link from 'next/link'
import dynamic from 'next/dynamic'
const AdminMenu = dynamic(() => import('./AdminMenu'), { ssr: false })
import { useEffect, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { getRole, hasPerm, preloadRolePerms } from '../lib/auth'
import { clearAuth, getJSON, isApiFailureKind } from '../lib/api'
import { VersionBadge } from './VersionBadge'
import { pickHomeRoute } from '../lib/homeRoute'

const { Header, Sider, Content } = Layout

export function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const [permTick, setPermTick] = useState(0)
  const [permsLoaded, setPermsLoaded] = useState(false)
  const [authState, setAuthState] = useState<'anonymous' | 'auth_loading' | 'backend_unavailable' | 'authenticated'>('anonymous')
  function getCookie(name: string) {
    if (typeof document === 'undefined') return null
    const m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/([.$?*|{}()\[\]\\/+^])/g, '\\$1') + '=([^;]*)'))
    return m ? decodeURIComponent(m[1]) : null
  }
  const [collapsed, setCollapsed] = useState(false)
  const isLogin = pathname.startsWith('/login')
  const isPublic = pathname.startsWith('/public')
  const [role, setRole] = useState<string | null>(null)
  const [username, setUsername] = useState<string | null>(null)
  const [mounted, setMounted] = useState(false)
  useEffect(() => { setRole(getRole()) }, [])
  useEffect(() => { setMounted(true) }, [])
  const authedRaw = (typeof document !== 'undefined') ? /(?:^|;\s*)auth=/.test(document.cookie || '') : false
  const authed = mounted ? authedRaw : false
  useEffect(() => {
    if (!authed) {
      setPermsLoaded(false)
      setAuthState('anonymous')
    } else if (mounted) {
      setAuthState((prev) => prev === 'authenticated' ? prev : 'auth_loading')
    }
  }, [authed, mounted])
  useEffect(() => {
    if (typeof document === 'undefined') return
    const m = document.cookie.match(/(?:^|;\s*)auth=([^;]*)/)
    const token = m ? decodeURIComponent(m[1]) : null
    try {
      const existing = localStorage.getItem('token') || sessionStorage.getItem('token')
      if (token && !existing) localStorage.setItem('token', token)
    } catch {}
  }, [pathname])

  async function bootstrapSession() {
    if (!mounted || !authed) return
    setAuthState('auth_loading')
    const me = await getJSON<any>('/auth/me', { authSensitive: true, timeoutMs: 5000 })
    setUsername((me as any)?.username || null)
    setRole((me as any)?.role || getRole())
    await preloadRolePerms()
    setPermsLoaded(true)
    setPermTick((x) => x + 1)
    setAuthState('authenticated')
  }

  useEffect(() => {
    if (!mounted || !authed) return
    let cancelled = false
    ;(async () => {
      try {
        await bootstrapSession()
      } catch (e: any) {
        if (cancelled) return
        if (isApiFailureKind(e, 'network_unavailable')) {
          setAuthState('backend_unavailable')
          return
        }
        if (isApiFailureKind(e, 'auth_401')) {
          clearAuth()
          try { router.replace('/login') } catch {}
        }
      }
    })()
    return () => { cancelled = true }
  }, [mounted, authed, router])

  useEffect(() => {
    if (!mounted || !authed || authState !== 'backend_unavailable') return
    let cancelled = false
    const timer = setInterval(() => {
      getJSON('/health', { timeoutMs: 1500 })
        .then(async () => {
          if (cancelled) return
          await bootstrapSession()
        })
        .catch(() => {})
    }, 2000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [mounted, authed, authState])

  useEffect(() => {
    if (!mounted) return
    if (!isLogin && !isPublic && !authed) {
      try { router.replace('/login') } catch {}
    }
  }, [mounted, isLogin, isPublic, authed, router])

  useEffect(() => {
    void permTick
  }, [permTick])
  useEffect(() => {
    if (!mounted || !authed) return
    if (isLogin || isPublic) return
    if (!permsLoaded) return
    if (pathname.startsWith('/dashboard') && !hasPerm('menu.dashboard')) {
      try { router.replace(pickHomeRoute()) } catch {}
    }
  }, [mounted, authed, isLogin, isPublic, pathname, permTick, permsLoaded, router])
  const items: any[] = []
  if (hasPerm('menu.dashboard')) items.push({ key: 'dashboard', icon: <ProfileOutlined />, label: <Link href="/dashboard" prefetch={false}>总览</Link> })
  if (hasPerm('menu.landlords')) {
    const landlordChildren: any[] = []
    landlordChildren.push({ key: 'landlords-home', label: <Link href="/landlords" prefetch={false}>房东列表</Link> })
    landlordChildren.push({ key: 'landlord-agreements', label: <Link href="/landlords/agreements" prefetch={false}>授权协议</Link> })
    landlordChildren.push({ key: 'landlord-contracts', label: <Link href="/landlords/contracts" prefetch={false}>房源合同</Link> })
    items.push({ key: 'landlords', icon: <TeamOutlined />, label: '房东管理', children: landlordChildren })
  }
  if (hasPerm('menu.properties')) {
    const propChildren: any[] = []
    if (hasPerm('menu.properties.list.visible')) propChildren.push({ key: 'properties-list', label: <Link href="/properties" prefetch={false}>房源列表</Link> })
    if (hasPerm('menu.properties.keys.visible')) propChildren.push({ key: 'properties-keys', label: <Link href="/keys" prefetch={false}>房源钥匙</Link> })
    if (hasPerm('menu.properties.guides.visible')) propChildren.push({ key: 'properties-guides', label: <Link href="/properties/guides" prefetch={false}>入住指南</Link> })
    items.push({ key: 'properties', icon: <ApartmentOutlined />, label: '房源管理', children: propChildren })
  }
  if (hasPerm('menu.properties.maintenance.visible')) items.push({ key: 'maintenance', icon: <ProfileOutlined />, label: '房源维修', children: [
    { key: 'maintenance-overview', label: <Link href="/maintenance/overview" prefetch={false}>维修总览</Link> },
    { key: 'maintenance-unified', label: <Link href="/maintenance/records" prefetch={false}>维修记录</Link> },
    ...(hasPerm('menu.properties.public_repair.visible') ? [{ key: 'public-repair', label: <Link href="/maintenance/public-repair" prefetch={false}>房源报修表</Link> }] : []),
    { key: 'maintenance-progress', label: <Link href="/maintenance/progress" prefetch={false}>维修进度表</Link> },
  ] })
  if (hasPerm('menu.properties.deep_cleaning.visible')) items.push({ key: 'deep-cleaning', icon: <ProfileOutlined />, label: '深度清洁', children: [
    { key: 'deep-cleaning-overview', label: <Link href="/deep-cleaning/overview" prefetch={false}>清洁总览</Link> },
    { key: 'deep-cleaning-records', label: <Link href="/deep-cleaning/records" prefetch={false}>清洁记录</Link> },
    { key: 'deep-cleaning-upload', label: <Link href="/deep-cleaning/upload" prefetch={false}>清洁上传表</Link> },
    { key: 'deep-cleaning-share-password', label: <Link href="/deep-cleaning/share-password" prefetch={false}>外链密码</Link> },
  ] })
  if (hasPerm('menu.onboarding')) items.push({ key: 'onboarding', icon: <ProfileOutlined />, label: '房源上新', children: [
    { key: 'onboarding-list', label: <Link href="/onboarding" prefetch={false}>上新管理</Link> },
    { key: 'onboarding-fa-prices', label: <Link href="/onboarding/fa-prices" prefetch={false}>家具/家电价格表</Link> },
  ] })
  const canViewInventoryMenu = (...codes: string[]) => hasPerm('menu.inventory') || codes.some((code) => hasPerm(code))
  if (canViewInventoryMenu(
    'menu.inventory.overview.visible',
    'menu.inventory.warehouses.visible',
    'menu.inventory.linen.visible',
    'menu.inventory.daily.visible',
    'menu.inventory.consumable.visible',
    'menu.inventory.other.visible',
    'menu.inventory.suppliers.visible',
    'menu.inventory.movements.visible',
  )) {
    const inventoryChildren: any[] = []
    if (canViewInventoryMenu('menu.inventory.overview.visible')) inventoryChildren.push({ key: '/inventory/overview', label: <Link href="/inventory/overview" prefetch={false}>仓库总览</Link> })
    if (canViewInventoryMenu('menu.inventory.warehouses.visible')) inventoryChildren.push({ key: '/inventory/warehouses', label: <Link href="/inventory/warehouses" prefetch={false}>仓库列表</Link> })

    const inventoryLinenChildren: any[] = []
    if (canViewInventoryMenu('menu.inventory.linen.stocks.visible')) inventoryLinenChildren.push({ key: '/inventory/category/linen/stocks', label: <Link href="/inventory/category/linen/stocks" prefetch={false}>床品库存</Link> })
    if (canViewInventoryMenu('menu.inventory.linen.purchase_orders.visible')) inventoryLinenChildren.push({ key: '/inventory/category/linen/purchase-orders', label: <Link href="/inventory/category/linen/purchase-orders" prefetch={false}>床品采购记录</Link> })
    if (canViewInventoryMenu('menu.inventory.linen.deliveries.visible')) inventoryLinenChildren.push({ key: '/inventory/category/linen/deliveries', label: <Link href="/inventory/category/linen/deliveries" prefetch={false}>床品配送记录</Link> })
    if (canViewInventoryMenu('menu.inventory.linen.usage.visible')) inventoryLinenChildren.push({ key: '/inventory/category/linen/usage', label: <Link href="/inventory/category/linen/usage" prefetch={false}>床品使用记录</Link> })
    if (canViewInventoryMenu('menu.inventory.linen.returns.visible')) inventoryLinenChildren.push({ key: '/inventory/category/linen/returns', label: <Link href="/inventory/category/linen/returns" prefetch={false}>床品退货记录</Link> })
    if (inventoryLinenChildren.length) inventoryChildren.push({ key: 'inventory_linen', label: '床品管理', children: inventoryLinenChildren })

    const inventoryDailyChildren: any[] = []
    if (canViewInventoryMenu('menu.inventory.daily.stocks.visible')) inventoryDailyChildren.push({ key: '/inventory/category/daily/stocks', label: <Link href="/inventory/category/daily/stocks" prefetch={false}>日用品库存</Link> })
    if (canViewInventoryMenu('menu.inventory.daily.prices.visible')) inventoryDailyChildren.push({ key: '/inventory/category/daily/prices', label: <Link href="/inventory/category/daily/prices" prefetch={false}>日用品价格表</Link> })
    if (canViewInventoryMenu('menu.inventory.daily.purchase_orders.visible')) inventoryDailyChildren.push({ key: '/inventory/category/daily/purchase-orders', label: <Link href="/inventory/category/daily/purchase-orders" prefetch={false}>日用品采购记录</Link> })
    if (canViewInventoryMenu('menu.inventory.daily.deliveries.visible')) inventoryDailyChildren.push({ key: '/inventory/category/daily/deliveries', label: <Link href="/inventory/category/daily/deliveries" prefetch={false}>日用品配送记录</Link> })
    if (canViewInventoryMenu('menu.inventory.daily.replacements.visible')) inventoryDailyChildren.push({ key: '/inventory/category/daily/replacements', label: <Link href="/inventory/category/daily/replacements" prefetch={false}>日用品更换记录</Link> })
    if (inventoryDailyChildren.length) inventoryChildren.push({ key: 'inventory_daily', label: '日用品管理', children: inventoryDailyChildren })

    const inventoryConsumableChildren: any[] = []
    if (canViewInventoryMenu('menu.inventory.consumable.stocks.visible')) inventoryConsumableChildren.push({ key: '/inventory/category/consumable/stocks', label: <Link href="/inventory/category/consumable/stocks" prefetch={false}>消耗品库存</Link> })
    if (canViewInventoryMenu('menu.inventory.consumable.prices.visible')) inventoryConsumableChildren.push({ key: '/inventory/category/consumable/prices', label: <Link href="/inventory/category/consumable/prices" prefetch={false}>消耗品价格表</Link> })
    if (canViewInventoryMenu('menu.inventory.consumable.purchase_orders.visible')) inventoryConsumableChildren.push({ key: '/inventory/category/consumable/purchase-orders', label: <Link href="/inventory/category/consumable/purchase-orders" prefetch={false}>消耗品采购记录</Link> })
    if (canViewInventoryMenu('menu.inventory.consumable.deliveries.visible')) inventoryConsumableChildren.push({ key: '/inventory/category/consumable/deliveries', label: <Link href="/inventory/category/consumable/deliveries" prefetch={false}>消耗品配送记录</Link> })
    if (canViewInventoryMenu('menu.inventory.consumable.usage.visible')) inventoryConsumableChildren.push({ key: '/inventory/category/consumable/usage', label: <Link href="/inventory/category/consumable/usage" prefetch={false}>消耗品使用记录</Link> })
    if (inventoryConsumableChildren.length) inventoryChildren.push({ key: 'inventory_consumable', label: '消耗品管理', children: inventoryConsumableChildren })

    const inventoryOtherChildren: any[] = []
    if (canViewInventoryMenu('menu.inventory.other.stocks.visible')) inventoryOtherChildren.push({ key: '/inventory/category/other/stocks', label: <Link href="/inventory/category/other/stocks" prefetch={false}>其他物品库存</Link> })
    if (canViewInventoryMenu('menu.inventory.other.prices.visible')) inventoryOtherChildren.push({ key: '/inventory/category/other/prices', label: <Link href="/inventory/category/other/prices" prefetch={false}>其他物品价格表</Link> })
    if (canViewInventoryMenu('menu.inventory.other.purchase_orders.visible')) inventoryOtherChildren.push({ key: '/inventory/category/other/purchase-orders', label: <Link href="/inventory/category/other/purchase-orders" prefetch={false}>其他物品采购记录</Link> })
    if (canViewInventoryMenu('menu.inventory.other.deliveries.visible')) inventoryOtherChildren.push({ key: '/inventory/category/other/deliveries', label: <Link href="/inventory/category/other/deliveries" prefetch={false}>其他物品配送记录</Link> })
    if (canViewInventoryMenu('menu.inventory.other.usage.visible')) inventoryOtherChildren.push({ key: '/inventory/category/other/usage', label: <Link href="/inventory/category/other/usage" prefetch={false}>其他物品使用记录</Link> })
    if (inventoryOtherChildren.length) inventoryChildren.push({ key: 'inventory_other', label: '其他物品管理', children: inventoryOtherChildren })

    const inventorySupplierChildren: any[] = []
    if (canViewInventoryMenu('menu.inventory.suppliers.list.visible')) inventorySupplierChildren.push({ key: '/inventory/suppliers', label: <Link href="/inventory/suppliers" prefetch={false}>供应商列表</Link> })
    if (canViewInventoryMenu('menu.inventory.suppliers.region_rules.visible')) inventorySupplierChildren.push({ key: '/inventory/region-rules', label: <Link href="/inventory/region-rules" prefetch={false}>供应区域规则</Link> })
    if (inventorySupplierChildren.length) inventoryChildren.push({ key: 'inventory_suppliers', label: '供应商管理', children: inventorySupplierChildren })

    if (canViewInventoryMenu('menu.inventory.movements.visible')) inventoryChildren.push({ key: '/inventory/movements', label: <Link href="/inventory/movements" prefetch={false}>库存流水</Link> })

    items.push({
      key: 'inventory',
      icon: <ProfileOutlined />,
      label: '仓库管理',
      children: inventoryChildren,
    })
  }
  const financeChildren: any[] = []
  if (hasPerm('menu.finance.orders.visible')) financeChildren.push({ key: 'orders', label: <Link href="/orders" prefetch={false}>订单管理</Link> })
  if (hasPerm('menu.finance.expenses.visible')) financeChildren.push({ key: 'expenses', label: <Link href="/finance/expenses" prefetch={false}>房源支出</Link> })
  if (hasPerm('menu.finance.recurring.visible')) financeChildren.push({ key: 'finance-recurring', label: <Link href="/finance/recurring" prefetch={false}>固定支出</Link> })
  if (hasPerm('menu.finance.invoices.visible')) financeChildren.push({ key: 'finance-invoices', label: <Link href="/finance/invoices" prefetch={false}>发票中心</Link> })
  if (hasPerm('menu.finance.company_overview.visible') || hasPerm('finance.tx.write') || hasPerm('finance_transactions.view')) financeChildren.push({ key: 'finance-transactions', label: <Link href="/finance/transactions" prefetch={false}>交易流水</Link> })
  if (hasPerm('menu.finance.company_overview.visible')) financeChildren.push({ key: 'finance-performance', label: '房源表现', children: [
    { key: 'finance-performance-overview', label: <Link href="/finance/performance/overview" prefetch={false}>经营分析</Link> },
    { key: 'finance-performance-revenue', label: <Link href="/finance/performance/revenue" prefetch={false}>房源营收</Link> },
    { key: 'finance-performance-property', label: <Link href="/finance/performance/property" prefetch={false}>单房源分析</Link> },
  ] })
  if (hasPerm('menu.finance.company_revenue.visible')) financeChildren.push({ key: 'company-revenue', label: <Link href="/finance/company-revenue" prefetch={false}>公司营收</Link> })
  if (hasPerm('menu.finance')) items.push({ key: 'finance', icon: <DollarOutlined />, label: '财务管理', children: financeChildren })
  if (hasPerm('menu.cleaning')) items.push({ key: 'cleaning', icon: <CalendarOutlined />, label: '线下事务', children: [
    { key: 'cleaning-overview', label: <Link href="/cleaning/overview" prefetch={false}>线下总览</Link> },
    { key: 'task-center', label: <Link href="/task-center" prefetch={false}>任务安排</Link> },
    { key: 'cleaning-schedule', label: <Link href="/cleaning" prefetch={false}>每日清洁</Link> },
  ] })
  if (hasPerm('menu.rbac') || hasPerm('rbac.manage')) items.push({ key: 'rbac', icon: <ProfileOutlined />, label: <Link href="/rbac" prefetch={false}>角色权限</Link> })
  if (hasPerm('menu.jobs.email_sync.visible')) items.push({ key: 'jobs', icon: <ProfileOutlined />, label: '系统任务', children: [
    { key: 'jobs-email-sync', label: <Link href="/jobs/email-sync" prefetch={false}>邮件同步</Link> },
    { key: 'jobs-cleaning-sync-jobs', label: <Link href="/jobs/cleaning-sync-jobs" prefetch={false}>清洁同步队列</Link> },
    { key: 'jobs-cleaning-sync-retry', label: <Link href="/jobs/cleaning-sync-retry" prefetch={false}>清洁同步重试</Link> },
    { key: 'jobs-cleaning-backfill', label: <Link href="/jobs/cleaning-backfill" prefetch={false}>清洁回填自动化</Link> },
  ] })
  const cmsChildren: any[] = []
  if (hasPerm('menu.cms')) {
    cmsChildren.push({ key: 'cms-home', label: <Link href="/cms" prefetch={false}>页面管理</Link> })
    cmsChildren.push({ key: 'cms-cleaning', label: <Link href="/cms/public-cleaning" prefetch={false}>清洁公开指南</Link> })
    cmsChildren.push({ key: 'cms-cleaning-password', label: <Link href="/cms/public-cleaning-password" prefetch={false}>公开访问密码</Link> })
    cmsChildren.push({ key: 'cms-company', label: <Link href="/cms/company" prefetch={false}>公司内容中心</Link> })
  }
  if (cmsChildren.length) items.push({ key: 'cms', icon: <ShopOutlined />, label: 'CMS管理', children: cmsChildren })
  if (hasPerm('menu.inventory.audits.visible')) items.push({ key: '/inventory/audits', icon: <ProfileOutlined />, label: <Link href="/inventory/audits" prefetch={false}>操作日志</Link> })

  
  
  function logout() {
    if (typeof window !== 'undefined') {
      try { document.cookie = 'auth=; Max-Age=0; path=/' } catch {}
      try { localStorage.removeItem('token'); sessionStorage.removeItem('token'); localStorage.removeItem('role'); sessionStorage.removeItem('role') } catch {}
      setRole(null); router.replace('/login');
      setTimeout(() => { try { window.location.replace('/login') } catch {} }, 50)
    }
  }
  return (
    (isLogin || isPublic) ? (
      <>{children}</>
    ) : (
      <Layout style={{ minHeight: '100vh', display:'flex' }}>
        <Sider className="mz-admin-sider" collapsible collapsed={collapsed} onCollapse={setCollapsed} breakpoint="md" style={{ background:'#001529', borderRight:'1px solid #e5e7eb', overflow:'hidden' }} width={240}>
          <div style={{ color: '#fff', padding: 16, fontWeight: 700 }}>MZ Property</div>
          <AdminMenu items={items} />
        </Sider>
        <Layout style={{ display:'flex' }}>
          <Header style={{ background: '#fff', padding: '0 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ fontWeight: 700, fontFamily:'SF Pro Display, Segoe UI, Roboto, Helvetica Neue, Arial' }}>后台管理</div>
            <div>
              <Space>
                {authState === 'backend_unavailable' ? <Tag color="orange">本地后端启动中，正在重试</Tag> : null}
                <span style={{ fontFamily:'SF Pro Text, Segoe UI, Roboto, Helvetica Neue, Arial', color:'#555', display: authed ? 'inline' : 'none' }}>
                  Hi, {username || ''}{role ? ` (${role})` : ''}
                </span>
                <Button onClick={logout} style={{ display: authed ? 'inline-flex' : 'none' }}>退出</Button>
                <span
                  onClick={() => { try { router.replace('/login') } catch {} }}
                  style={{ cursor:'pointer', color:'#1677ff', display: authed ? 'none' : 'inline' }}
                >
                  登录
                </span>
              </Space>
            </div>
          </Header>
          <Content style={{ margin: '16px' }}>{children}</Content>
          <Layout.Footer style={{ textAlign: 'center', fontSize: 12 }}>
            <VersionBadge />
          </Layout.Footer>
        </Layout>
      </Layout>
    )
  )
}
