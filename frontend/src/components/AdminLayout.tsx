"use client"
import { Layout, Menu, Button } from 'antd'
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
import { useEffect, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { getRole, hasPerm } from '../lib/auth'
import { VersionBadge } from './VersionBadge'

const { Header, Sider, Content } = Layout

export function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  async function preloadPerms() { return }
  function getCookie(name: string) {
    if (typeof document === 'undefined') return null
    const m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/([.$?*|{}()\[\]\\/+^])/g, '\\$1') + '=([^;]*)'))
    return m ? decodeURIComponent(m[1]) : null
  }
  const [collapsed, setCollapsed] = useState(false)
  const isLogin = pathname.startsWith('/login')
  const [role, setRole] = useState<string | null>(null)
  const [mounted, setMounted] = useState(false)
  useEffect(() => { setRole(getRole()) }, [])
  useEffect(() => { setMounted(true) }, [])
  const authed = (typeof document !== 'undefined') ? /(?:^|;\s*)auth=/.test(document.cookie || '') : false
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
    if (authed) { preloadPerms().catch(() => {}) }
  }, [authed])
  useEffect(() => {
    if (!isLogin && !authed) {
      try { router.replace('/login') } catch {}
    }
  }, [isLogin, authed, router])
  const items: any[] = []
  items.push({ key: 'dashboard', icon: <ProfileOutlined />, label: <Link href="/dashboard" prefetch={false}>总览</Link> })
  if (hasPerm('landlord.manage')) {
    const landlordChildren: any[] = []
    landlordChildren.push({ key: 'landlords-home', label: <Link href="/landlords" prefetch={false}>房东列表</Link> })
    landlordChildren.push({ key: 'landlord-agreements', label: <Link href="/landlords/agreements" prefetch={false}>授权协议</Link> })
    landlordChildren.push({ key: 'landlord-contracts', label: <Link href="/landlords/contracts" prefetch={false}>房源合同</Link> })
    items.push({ key: 'landlords', icon: <TeamOutlined />, label: '房东管理', children: landlordChildren })
  }
  if (hasPerm('property.write') || ['customer_service','field','cleaner_inspector'].includes(role || '')) {
    const propChildren: any[] = []
    propChildren.push({ key: 'properties-list', label: <Link href="/properties" prefetch={false}>房源列表</Link> })
    if (hasPerm('keyset.manage') || hasPerm('key.flow')) propChildren.push({ key: 'properties-keys', label: <Link href="/keys" prefetch={false}>房源钥匙</Link> })
    if (role === 'admin' || hasPerm('property.write')) propChildren.push({ key: 'properties-maintenance', label: <Link href="/maintenance" prefetch={false}>房源维修</Link> })
    items.push({ key: 'properties', icon: <ApartmentOutlined />, label: '房源管理', children: propChildren })
  }
  if (hasPerm('inventory.move')) items.push({ key: 'inventory', icon: <ProfileOutlined />, label: <Link href="/inventory" prefetch={false}>仓库库存</Link> })
  const financeChildren: any[] = []
  if (hasPerm('finance.payout') || hasPerm('finance.tx.write')) financeChildren.push({ key: 'finance-home', label: <Link href="/finance" prefetch={false}>财务总览</Link> })
  if (hasPerm('order.manage')) financeChildren.push({ key: 'orders', label: <Link href="/orders" prefetch={false}>订单管理</Link> })
  if (hasPerm('finance.tx.write')) financeChildren.push({ key: 'expenses', label: <Link href="/finance/expenses" prefetch={false}>房源支出</Link> })
  if (hasPerm('finance.tx.write')) financeChildren.push({ key: 'finance-recurring', label: <Link href="/finance/recurring" prefetch={false}>固定支出</Link> })
  if (hasPerm('finance.tx.write') || hasPerm('finance.payout') || role === 'customer_service') financeChildren.push({ key: 'company', label: <Link href="/finance/company-overview" prefetch={false}>房源营收</Link> })
  if (hasPerm('finance.payout')) financeChildren.push({ key: 'company-revenue', label: <Link href="/finance/company-revenue" prefetch={false}>公司营收</Link> })
  if (financeChildren.length > 0) items.push({ key: 'finance', icon: <DollarOutlined />, label: '财务管理', children: financeChildren })
  if (hasPerm('cleaning.task.assign') || role === 'customer_service' || role === 'cleaning_manager' || role === 'cleaner_inspector') items.push({ key: 'cleaning', icon: <CalendarOutlined />, label: <Link href="/cleaning" prefetch={false}>清洁安排</Link> })
  if (hasPerm('rbac.manage')) items.push({ key: 'rbac', icon: <ProfileOutlined />, label: <Link href="/rbac" prefetch={false}>角色权限</Link> })
  items.push({ key: 'cms', icon: <ShopOutlined />, label: <Link href="/cms" prefetch={false}>CMS管理</Link> })

  
  
  function logout() {
    if (typeof window !== 'undefined') {
      try { document.cookie = 'auth=; Max-Age=0; path=/' } catch {}
      try { localStorage.removeItem('token'); sessionStorage.removeItem('token'); localStorage.removeItem('role'); sessionStorage.removeItem('role') } catch {}
      setRole(null); router.replace('/login');
      setTimeout(() => { try { window.location.replace('/login') } catch {} }, 50)
    }
  }
  if (!mounted) return null
  if (!isLogin && !authed) return null
  return (
    isLogin ? (
      <>{children}</>
    ) : (
      <Layout style={{ minHeight: '100vh' }}>
        <Sider collapsible collapsed={collapsed} onCollapse={setCollapsed} breakpoint="md">
          <div style={{ color: '#fff', padding: 16, fontWeight: 600 }}>MZ Property</div>
          <Menu theme="dark" mode="inline" items={items} />
        </Sider>
        <Layout>
          <Header style={{ background: '#fff', padding: '0 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>后台管理</div>
            <div>
              {authed ? <Button onClick={logout}>退出{role ? `(${role})` : ''}</Button> : <Link href="/login" prefetch={false}>登录</Link>}
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
