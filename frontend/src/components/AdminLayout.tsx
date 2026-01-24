"use client"
import { Layout, Button, Space } from 'antd'
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
import { API_BASE, authHeaders } from '../lib/api'
import { VersionBadge } from './VersionBadge'

const { Header, Sider, Content } = Layout

export function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const [permTick, setPermTick] = useState(0)
  async function preloadPerms() { try { await preloadRolePerms(); setPermTick((x)=>x+1) } catch {} }
  function getCookie(name: string) {
    if (typeof document === 'undefined') return null
    const m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/([.$?*|{}()\[\]\\/+^])/g, '\\$1') + '=([^;]*)'))
    return m ? decodeURIComponent(m[1]) : null
  }
  const [collapsed, setCollapsed] = useState(false)
  const isLogin = pathname.startsWith('/login')
  const [role, setRole] = useState<string | null>(null)
  const [username, setUsername] = useState<string | null>(null)
  const [mounted, setMounted] = useState(false)
  useEffect(() => { setRole(getRole()) }, [])
  useEffect(() => { setMounted(true) }, [])
  const authedRaw = (typeof document !== 'undefined') ? /(?:^|;\s*)auth=/.test(document.cookie || '') : false
  const authed = mounted ? authedRaw : false
  useEffect(() => {
    if (typeof document === 'undefined') return
    const m = document.cookie.match(/(?:^|;\s*)auth=([^;]*)/)
    const token = m ? decodeURIComponent(m[1]) : null
    try {
      const existing = localStorage.getItem('token') || sessionStorage.getItem('token')
      if (token && !existing) localStorage.setItem('token', token)
    } catch {}
  }, [pathname])
  useEffect(() => {
    if (mounted && authed) { preloadPerms().catch(() => {}) }
  }, [mounted, authed])
  useEffect(() => {
    if (mounted && authed) { preloadPerms().catch(() => {}) }
  }, [mounted, authed, pathname])
  useEffect(() => {
    if (!mounted || !authed) return
    ;(async () => {
      try {
        const res = await fetch(`${API_BASE}/auth/me`, { headers: authHeaders() })
        const j = res.ok ? await res.json() : null
        setUsername((j as any)?.username || null)
        setRole((j as any)?.role || getRole())
      } catch {}
    })()
  }, [mounted, authed])
  useEffect(() => {
    if (!mounted) return
    if (!isLogin && !authed) {
      try { router.replace('/login') } catch {}
    }
  }, [mounted, isLogin, authed, router])
  const items: any[] = []
  if (hasPerm('menu.dashboard')) items.push({ key: 'dashboard', icon: <ProfileOutlined />, label: <Link href="/dashboard" prefetch={false}>总览</Link> })
  if (hasPerm('menu.landlords')) {
    const landlordChildren: any[] = []
    landlordChildren.push({ key: 'landlords-home', label: <Link href="/landlords" prefetch={false}>房东列表</Link> })
    landlordChildren.push({ key: 'landlord-agreements', label: <Link href="/landlords/agreements" prefetch={false}>授权协议</Link> })
    landlordChildren.push({ key: 'landlord-contracts', label: <Link href="/landlords/contracts" prefetch={false}>房源合同</Link> })
    items.push({ key: 'landlords', icon: <TeamOutlined />, label: '房东管理', children: landlordChildren })
  }
  if (hasPerm('menu.properties') || ['customer_service','field','cleaner_inspector'].includes(role || '')) {
    const propChildren: any[] = []
    if (hasPerm('menu.properties.list.visible')) propChildren.push({ key: 'properties-list', label: <Link href="/properties" prefetch={false}>房源列表</Link> })
    if (hasPerm('menu.properties.keys.visible')) propChildren.push({ key: 'properties-keys', label: <Link href="/keys" prefetch={false}>房源钥匙</Link> })
    items.push({ key: 'properties', icon: <ApartmentOutlined />, label: '房源管理', children: propChildren })
  }
  if (hasPerm('menu.properties.maintenance.visible')) items.push({ key: 'maintenance', icon: <ProfileOutlined />, label: '房源维修', children: [
    { key: 'maintenance-overview', label: <Link href="/maintenance/overview" prefetch={false}>维修总览</Link> },
    { key: 'maintenance-records', label: <Link href="/maintenance" prefetch={false}>维修记录</Link> },
  ] })
  if (hasPerm('menu.onboarding')) items.push({ key: 'onboarding', icon: <ProfileOutlined />, label: '房源上新', children: [
    { key: 'onboarding-list', label: <Link href="/onboarding" prefetch={false}>上新管理</Link> },
    { key: 'onboarding-prices', label: <Link href="/onboarding/prices" prefetch={false}>日用品价格表</Link> },
    { key: 'onboarding-fa-prices', label: <Link href="/onboarding/fa-prices" prefetch={false}>家具/家电价格表</Link> },
  ] })
  if (hasPerm('menu.inventory')) items.push({ key: 'inventory', icon: <ProfileOutlined />, label: <Link href="/inventory" prefetch={false}>仓库库存</Link> })
  const financeChildren: any[] = []
  if (hasPerm('menu.finance.orders.visible')) financeChildren.push({ key: 'orders', label: <Link href="/orders" prefetch={false}>订单管理</Link> })
  if (hasPerm('menu.finance.expenses.visible')) financeChildren.push({ key: 'expenses', label: <Link href="/finance/expenses" prefetch={false}>房源支出</Link> })
  if (hasPerm('menu.finance.recurring.visible')) financeChildren.push({ key: 'finance-recurring', label: <Link href="/finance/recurring" prefetch={false}>固定支出</Link> })
  if (hasPerm('menu.finance.company_overview.visible')) financeChildren.push({ key: 'finance-performance', label: '房源表现', children: [
    { key: 'finance-performance-overview', label: <Link href="/finance/performance/overview" prefetch={false}>经营分析</Link> },
    { key: 'finance-performance-revenue', label: <Link href="/finance/performance/revenue" prefetch={false}>房源营收</Link> },
    { key: 'finance-performance-property', label: <Link href="/finance/performance/property" prefetch={false}>单房源分析</Link> },
  ] })
  if (hasPerm('menu.finance.company_revenue.visible')) financeChildren.push({ key: 'company-revenue', label: <Link href="/finance/company-revenue" prefetch={false}>公司营收</Link> })
  if (hasPerm('menu.finance')) items.push({ key: 'finance', icon: <DollarOutlined />, label: '财务管理', children: financeChildren })
  if (hasPerm('menu.cleaning') || hasPerm('cleaning.task.assign') || role === 'customer_service' || role === 'cleaning_manager' || role === 'cleaner_inspector') items.push({ key: 'cleaning', icon: <CalendarOutlined />, label: <Link href="/cleaning" prefetch={false}>清洁安排</Link> })
  if (hasPerm('menu.rbac') || hasPerm('rbac.manage')) items.push({ key: 'rbac', icon: <ProfileOutlined />, label: <Link href="/rbac" prefetch={false}>角色权限</Link> })
  if (hasPerm('menu.jobs.email_sync.visible')) items.push({ key: 'jobs', icon: <ProfileOutlined />, label: '系统任务', children: [
    { key: 'jobs-email-sync', label: <Link href="/jobs/email-sync" prefetch={false}>邮件同步</Link> },
  ] })
  if (hasPerm('menu.cms')) items.push({ key: 'cms', icon: <ShopOutlined />, label: 'CMS管理', children: [
    { key: 'cms-home', label: <Link href="/cms" prefetch={false}>页面管理</Link> },
    { key: 'cms-cleaning', label: <Link href="/cms/public-cleaning" prefetch={false}>清洁公开指南</Link> },
    { key: 'cms-cleaning-password', label: <Link href="/cms/public-cleaning-password" prefetch={false}>公开访问密码</Link> },
  ] })

  
  
  function logout() {
    if (typeof window !== 'undefined') {
      try { document.cookie = 'auth=; Max-Age=0; path=/' } catch {}
      try { localStorage.removeItem('token'); sessionStorage.removeItem('token'); localStorage.removeItem('role'); sessionStorage.removeItem('role') } catch {}
      setRole(null); router.replace('/login');
      setTimeout(() => { try { window.location.replace('/login') } catch {} }, 50)
    }
  }
  return (
    isLogin ? (
      <>{children}</>
    ) : (
      <Layout style={{ minHeight: '100vh', display:'flex' }}>
        <Sider collapsible collapsed={collapsed} onCollapse={setCollapsed} breakpoint="md" style={{ background:'#001529', borderRight:'1px solid #e5e7eb' }} width={240}>
          <div style={{ color: '#fff', padding: 16, fontWeight: 700 }}>MZ Property</div>
          <AdminMenu items={items} />
        </Sider>
        <Layout style={{ display:'flex' }}>
          <Header style={{ background: '#fff', padding: '0 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ fontWeight: 700, fontFamily:'SF Pro Display, Segoe UI, Roboto, Helvetica Neue, Arial' }}>后台管理</div>
            <div>
              <Space>
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
