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
import { usePathname } from 'next/navigation'
import { getRole } from '../lib/auth'

const { Header, Sider, Content } = Layout

export function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  if (pathname.startsWith('/login')) {
    return <>{children}</>
  }
  const [collapsed, setCollapsed] = useState(false)
  const items = [
    { key: 'dashboard', icon: <ProfileOutlined />, label: <Link href="/">总览</Link> },
    { key: 'landlords', icon: <TeamOutlined />, label: <Link href="/landlords">房东管理</Link> },
    { key: 'properties', icon: <ApartmentOutlined />, label: <Link href="/properties">房源管理</Link> },
    { key: 'keys', icon: <KeyOutlined />, label: <Link href="/keys">钥匙管理</Link> },
    { key: 'orders', icon: <ShopOutlined />, label: <Link href="/orders">订单管理</Link> },
    { key: 'inventory', icon: <ProfileOutlined />, label: <Link href="/inventory">仓库库存</Link> },
    { key: 'finance', icon: <DollarOutlined />, label: <Link href="/finance">财务管理</Link> },
    { key: 'cleaning', icon: <CalendarOutlined />, label: <Link href="/cleaning">清洁安排</Link> },
    { key: 'rbac', icon: <ProfileOutlined />, label: <Link href="/rbac">角色权限</Link> },
  ]

  const [role, setRole] = useState<string | null>(null)
  useEffect(() => { setRole(getRole()) }, [])
  function logout() {
    if (typeof window !== 'undefined') {
      localStorage.removeItem('token'); localStorage.removeItem('role'); setRole(null)
    }
  }
  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider collapsible collapsed={collapsed} onCollapse={setCollapsed} breakpoint="md">
        <div style={{ color: '#fff', padding: 16, fontWeight: 600 }}>MZ Property</div>
        <Menu theme="dark" mode="inline" items={items} />
      </Sider>
      <Layout>
        <Header style={{ background: '#fff', padding: '0 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>后台管理</div>
          <div>
            {role ? <Button onClick={logout}>退出({role})</Button> : <Link href="/login">登录</Link>}
          </div>
        </Header>
        <Content style={{ margin: '16px' }}>{children}</Content>
      </Layout>
    </Layout>
  )
}