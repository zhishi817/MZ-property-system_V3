"use client"
import { Layout, Button, Space, Tag, Drawer, Grid } from 'antd'
import {
  ApartmentOutlined,
  KeyOutlined,
  ProfileOutlined,
  ShopOutlined,
  TeamOutlined,
  DollarOutlined,
  CalendarOutlined,
  MenuOutlined,
} from '@ant-design/icons'
import Link from 'next/link'
import Image from 'next/image'
import dynamic from 'next/dynamic'
const AdminMenu = dynamic(() => import('./AdminMenu'), { ssr: false })
import { useEffect, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { getRole, hasPerm, preloadRolePerms } from '../lib/auth'
import { clearAuth, getJSON, isApiFailureKind } from '../lib/api'
import { VersionBadge } from './VersionBadge'
import { pickHomeRoute } from '../lib/homeRoute'
import { ADMIN_NAVIGATION, buildSidebarNavigation, type SidebarNavNode } from '../lib/adminNavigation'
import { AdminNotificationBell } from './AdminNotificationBell'

const { Header, Sider, Content } = Layout
const { useBreakpoint } = Grid
const PUBLIC_SHELL_PATHS = ['/public', '/public-cleaning-guide', '/guide/p']

export function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const screens = useBreakpoint()
  const [permTick, setPermTick] = useState(0)
  const [permsLoaded, setPermsLoaded] = useState(false)
  const [authState, setAuthState] = useState<'anonymous' | 'auth_loading' | 'backend_unavailable' | 'authenticated'>('anonymous')
  function getCookie(name: string) {
    if (typeof document === 'undefined') return null
    const m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/([.$?*|{}()\[\]\\/+^])/g, '\\$1') + '=([^;]*)'))
    return m ? decodeURIComponent(m[1]) : null
  }
  const [collapsed, setCollapsed] = useState(false)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const isLogin = pathname.startsWith('/login')
  const isPublic = PUBLIC_SHELL_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`))
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
    setMobileMenuOpen(false)
  }, [pathname])

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
  function iconFor(id: string) {
    if (id === 'dashboard') return <ProfileOutlined />
    if (id === 'landlords') return <TeamOutlined />
    if (id === 'hr') return <TeamOutlined />
    if (id === 'properties') return <ApartmentOutlined />
    if (id === 'keys') return <KeyOutlined />
    if (id === 'finance') return <DollarOutlined />
    if (id === 'cleaning') return <CalendarOutlined />
    if (id === 'cms' || id === 'guest-site') return <ShopOutlined />
    return <ProfileOutlined />
  }

  function toMenuItem(node: SidebarNavNode, level = 0): any {
    const label = node.href ? <Link href={node.href} prefetch={false}>{node.label}</Link> : node.label
    const item: any = { key: node.id, label }
    if (level === 0) item.icon = iconFor(node.id)
    if (node.children?.length) item.children = node.children.map((child) => toMenuItem(child, level + 1))
    return item
  }

  const items = buildSidebarNavigation(ADMIN_NAVIGATION, hasPerm).map((node) => toMenuItem(node))
  const isMobile = mounted && !screens.md

  
  
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
      <Layout className="mz-admin-shell">
        <Sider className="mz-admin-sider" collapsible collapsed={collapsed} onCollapse={setCollapsed} breakpoint="md" style={{ background:'#001529', borderRight:'1px solid #e5e7eb', overflow:'hidden' }} width={240}>
          <div className="mz-admin-brand">
            <Image
              className="mz-admin-brand-logo"
              src="/mz-logo.png"
              alt="MZ Property"
              width={184}
              height={70}
              priority
            />
          </div>
          <AdminMenu items={items} />
        </Sider>
        <Layout className="mz-admin-main">
          <Header className="mz-admin-header">
            <div className="mz-admin-header-title">
              {isMobile ? (
                <Button
                  className="mz-admin-menu-button"
                  type="text"
                  icon={<MenuOutlined />}
                  aria-label="打开导航菜单"
                  onClick={() => setMobileMenuOpen(true)}
                />
              ) : null}
              <div style={{ fontWeight: 700, fontFamily:'SF Pro Display, Segoe UI, Roboto, Helvetica Neue, Arial' }}>后台管理</div>
            </div>
            <div className="mz-admin-header-actions">
              <Space wrap>
                {authState === 'backend_unavailable' ? <Tag color="orange">本地后端启动中，正在重试</Tag> : null}
                <AdminNotificationBell />
                <span className="mz-admin-user" style={{ fontFamily:'SF Pro Text, Segoe UI, Roboto, Helvetica Neue, Arial', color:'#555', display: authed ? 'inline' : 'none' }}>
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
          <Content className="mz-admin-content">{children}</Content>
          <Layout.Footer style={{ textAlign: 'center', fontSize: 12 }}>
            <VersionBadge />
          </Layout.Footer>
        </Layout>
        <Drawer
          className="mz-admin-mobile-drawer"
          rootClassName="mz-admin-mobile-drawer-root"
          title="MZ Property"
          placement="left"
          open={mobileMenuOpen}
          onClose={() => setMobileMenuOpen(false)}
          width={280}
          styles={{ body: { padding: 0 } }}
        >
          <AdminMenu items={items} theme="light" onClick={() => setMobileMenuOpen(false)} />
        </Drawer>
      </Layout>
    )
  )
}
