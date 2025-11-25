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
import { getRole, preloadPerms, hasPerm } from '../lib/auth'
import { VersionBadge } from './VersionBadge'

const { Header, Sider, Content } = Layout

export function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  function getCookie(name: string) {
    if (typeof document === 'undefined') return null
    const m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/([.$?*|{}()\[\]\\/+^])/g, '\\$1') + '=([^;]*)'))
    return m ? decodeURIComponent(m[1]) : null
  }
  const [collapsed, setCollapsed] = useState(false)
  const isLogin = pathname.startsWith('/login')
  const [role, setRole] = useState<string | null>(null)
  const [authed, setAuthed] = useState<boolean>(false)
  useEffect(() => { setRole(getRole()) }, [])
  useEffect(() => {
    const c = (typeof document !== 'undefined') ? (document.cookie || '') : ''
    setAuthed(/(?:^|;\s*)auth=/.test(c))
  }, [pathname])
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
  }, [authed, isLogin, router])
  const items = (() => {
    const arr: any[] = []
    arr.push({ key: 'dashboard', icon: <ProfileOutlined />, label: <Link href="/dashboard" prefetch={false}>总览</Link> })
    if (hasPerm('landlord.manage')) {
      const children = [
        { key: 'landlords-home', label: <Link href="/landlords" prefetch={false}>房东列表</Link> },
        { key: 'landlords-agreements', label: <Link href="/landlords/auth-agreements" prefetch={false}>授权协议</Link> },
        { key: 'landlords-contracts', label: <Link href="/landlords/property-contracts" prefetch={false}>房源合同</Link> },
      ]
      arr.push({ key: 'landlords', icon: <TeamOutlined />, label: '房东管理', children })
    }
    if (hasPerm('property.write') || hasPerm('keyset.manage')) {
      const children = [
        { key: 'properties-list', label: <Link href="/properties" prefetch={false}>房源列表</Link> },
        { key: 'keys', label: <Link href="/keys" prefetch={false}>钥匙列表</Link> },
      ]
      arr.push({ key: 'properties', icon: <ApartmentOutlined />, label: '房源管理', children })
    }
    if (hasPerm('property.write')) {
      arr.push({ key: 'maintenance', icon: <ProfileOutlined />, label: <Link href="/maintenance" prefetch={false}>房源维修</Link> })
    }
    if (hasPerm('inventory.move')) {
      arr.push({ key: 'inventory', icon: <ProfileOutlined />, label: <Link href="/inventory" prefetch={false}>仓库管理</Link> })
    }
    if (hasPerm('finance.payout') || hasPerm('finance.tx.write') || hasPerm('order.view') || hasPerm('order.write')) {
      const children: any[] = []
      if (hasPerm('finance.tx.write')) children.push({ key: 'finance-home', label: <Link href="/finance" prefetch={false}>财务总览</Link> })
      if (hasPerm('order.view') || hasPerm('order.write')) children.push({ key: 'orders', label: <Link href="/orders" prefetch={false}>订单管理</Link> })
      if (hasPerm('finance.tx.write')) children.push({ key: 'expenses', label: <Link href="/finance/expenses" prefetch={false}>支出管理</Link> })
      if (hasPerm('finance.tx.write')) children.push({ key: 'company', label: <Link href="/finance/company-overview" prefetch={false}>房源营收</Link> })
      if (hasPerm('finance.payout')) children.push({ key: 'company-revenue', label: <Link href="/finance/company-revenue" prefetch={false}>公司营收</Link> })
      if (children.length) arr.push({ key: 'finance', icon: <DollarOutlined />, label: '财务管理', children })
    }
    if (hasPerm('cleaning.view') || hasPerm('cleaning.schedule.manage') || hasPerm('cleaning.task.assign')) {
      arr.push({ key: 'cleaning', icon: <CalendarOutlined />, label: <Link href="/cleaning">清洁安排</Link> })
    }
    if (hasPerm('rbac.manage')) {
      arr.push({ key: 'rbac', icon: <ProfileOutlined />, label: <Link href="/rbac">角色权限</Link> })
    }
    return arr
  })()

  
  
  function logout() {
    if (typeof window !== 'undefined') {
      try { document.cookie = 'auth=; Max-Age=0; path=/' } catch {}
      try { localStorage.removeItem('token'); sessionStorage.removeItem('token'); localStorage.removeItem('perms'); localStorage.removeItem('role') } catch {}
      setRole(null); router.replace('/login');
      setTimeout(() => { try { window.location.replace('/login') } catch {} }, 50)
    }
  }
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
