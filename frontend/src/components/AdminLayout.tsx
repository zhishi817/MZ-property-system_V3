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
import { getRole } from '../lib/auth'
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
    if (!isLogin && !authed) {
      try { router.replace('/login') } catch {}
    }
  }, [authed, isLogin, router])
  const items = [
    { key: 'dashboard', icon: <ProfileOutlined />, label: <Link href="/dashboard" prefetch={false}>总览</Link> },
    { key: 'landlords', icon: <TeamOutlined />, label: <Link href="/landlords" prefetch={false}>房东管理</Link> },
    { key: 'properties', icon: <ApartmentOutlined />, label: <Link href="/properties" prefetch={false}>房源管理</Link> },
    { key: 'keys', icon: <KeyOutlined />, label: <Link href="/keys" prefetch={false}>钥匙管理</Link> },
    { key: 'inventory', icon: <ProfileOutlined />, label: <Link href="/inventory" prefetch={false}>仓库库存</Link> },
    {
      key: 'finance',
      icon: <DollarOutlined />,
      label: '财务管理',
      children: [
        { key: 'finance-home', label: <Link href="/finance" prefetch={false}>财务总览</Link> },
        { key: 'orders', label: <Link href="/orders" prefetch={false}>订单管理</Link> },
        { key: 'expenses', label: <Link href="/finance/expenses" prefetch={false}>支出管理</Link> },
        { key: 'monthly', label: <Link href="/finance/monthly-statement" prefetch={false}>月度报表</Link> },
        { key: 'annual', label: <Link href="/finance/annual-statement" prefetch={false}>年度报表</Link> },
        { key: 'company', label: <Link href="/finance/company-overview" prefetch={false}>公司收益</Link> },
      ],
    },
    { key: 'cleaning', icon: <CalendarOutlined />, label: <Link href="/cleaning">清洁安排</Link> },
    { key: 'rbac', icon: <ProfileOutlined />, label: <Link href="/rbac">角色权限</Link> },
  ]

  
  
  function logout() {
    if (typeof window !== 'undefined') {
      try { document.cookie = 'auth=; Max-Age=0; path=/' } catch {}
      try { localStorage.removeItem('token'); sessionStorage.removeItem('token') } catch {}
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
