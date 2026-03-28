"use client"
import { Alert, Card, Table, Drawer, Space, Button, Select, message, Modal, Form, Input, Checkbox, Typography, Tag, Collapse, Tree, Empty, Divider, Radio, ColorPicker } from 'antd'
import { useEffect, useMemo, useState } from 'react'
import { API_BASE, authHeaders } from '../../lib/api'
import { preloadRolePerms } from '../../lib/auth'
import { hasPerm } from '../../lib/auth'
import { MENU_PERMISSION_MAP, buildMenuKeySet, buildPermToMenuIndex, findMenuNode, findMenuPathLabels } from './rbacMenuMap'

type Role = { id: string; name: string; description?: string }
type RiskLevel = 'low' | 'medium' | 'high'
type PermissionMeta = {
  code: string
  displayName: string
  riskLevel: RiskLevel
  purpose: string
  scenarios: string[]
  denyImpact: string[]
  privacyRisk: string[]
}
type Permission = { code: string; name?: string; meta?: PermissionMeta }
type User = { id: string; username: string; email?: string; phone_au?: string; role: string; roles?: string[]; color_hex?: string | null }

export default function RBACPage() {
  const [roles, setRoles] = useState<Role[]>([])
  const [perms, setPerms] = useState<Permission[]>([])
  const [open, setOpen] = useState(false)
  const [current, setCurrent] = useState<Role | null>(null)
  const [selectedPerms, setSelectedPerms] = useState<string[]>([])
  const [users, setUsers] = useState<User[]>([])
  const [userOpen, setUserOpen] = useState(false)
  const [userForm] = Form.useForm()
  const [editUserOpen, setEditUserOpen] = useState(false)
  const [editUser, setEditUser] = useState<User | null>(null)
  const [editUserForm] = Form.useForm()
  const [roleOpen, setRoleOpen] = useState(false)
  const [roleForm] = Form.useForm()
  const [editRoleOpen, setEditRoleOpen] = useState(false)
  const [editRole, setEditRole] = useState<Role | null>(null)
  const [editRoleForm] = Form.useForm()
  const [pwOpen, setPwOpen] = useState(false)
  const [pwUser, setPwUser] = useState<User | null>(null)
  const [pwForm] = Form.useForm()
  const [savedSnapshot, setSavedSnapshot] = useState<string[]>([])
  const [menuCheckedKeys, setMenuCheckedKeys] = useState<string[]>([])
  const [menuExpandedKeys, setMenuExpandedKeys] = useState<string[]>([])
  const [menuSearch, setMenuSearch] = useState<string>('')
  const [activeMenuKey, setActiveMenuKey] = useState<string>('')
  const [advancedSearch, setAdvancedSearch] = useState<string>('')

  function normalizeRoles(primaryRole: any, extraRoles: any) {
    const role = String(primaryRole || '').trim()
    const extras = Array.isArray(extraRoles) ? extraRoles : []
    const roles = extras.map((x: any) => String(x || '').trim()).filter(Boolean)
    if (role) roles.unshift(role)
    return Array.from(new Set(roles))
  }

  function normalizeAuPhone(v: any) {
    const raw = String(v || '').trim()
    if (!raw) return ''
    let s = raw.replace(/[\s()-]/g, '').replace(/-+/g, '')
    if (s.startsWith('00')) s = `+${s.slice(2)}`
    if (s.startsWith('+')) {
      const d = s.slice(1).replace(/\D/g, '')
      if (!d.startsWith('61')) return raw
      const rest = d.slice(2)
      if (!/^\d{9}$/.test(rest)) return raw
      return `+61${rest}`
    }
    const d = s.replace(/\D/g, '')
    if (d.startsWith('61')) {
      const rest = d.slice(2)
      if (!/^\d{9}$/.test(rest)) return raw
      return `+61${rest}`
    }
    if (d.startsWith('0') && d.length === 10) return `+61${d.slice(1)}`
    return raw
  }

  function riskTag(level?: RiskLevel) {
    const lv = level || 'medium'
    const map: Record<RiskLevel, { color: string; text: string }> = {
      low: { color: 'green', text: '低风险' },
      medium: { color: 'orange', text: '中风险' },
      high: { color: 'red', text: '高风险' },
    }
    const v = map[lv]
    const styleBy: Record<RiskLevel, any> = {
      low: { background: '#f6ffed', borderColor: '#b7eb8f', color: '#389e0d' },
      medium: { background: '#fff7e6', borderColor: '#ffd591', color: '#fa8c16' },
      high: { background: '#fff1f0', borderColor: '#ffa39e', color: '#cf1322' },
    }
    return <Tag style={{ border: '1px solid', ...styleBy[lv] }}>{v.text}</Tag>
  }

  function renderPermDetail(p: Permission) {
    const m = p.meta
    if (!m) return null
    const list = (items?: string[]) => (
      <ul style={{ margin: 0, paddingInlineStart: 18 }}>
        {(items || []).map((x, i) => <li key={i}>{x}</li>)}
      </ul>
    )
    return (
      <div style={{ padding: 12 }}>
        <Typography.Title level={5} style={{ margin: 0 }}>权限信息</Typography.Title>
        <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
          <div><Typography.Text strong>权限代码：</Typography.Text><Typography.Text>{m.code}</Typography.Text></div>
          <div><Typography.Text strong>风险等级：</Typography.Text>{riskTag(m.riskLevel)}</div>
          <div>
            <Typography.Text strong>功能说明：</Typography.Text>
            <Typography.Paragraph style={{ marginBottom: 0 }}>{m.purpose}</Typography.Paragraph>
          </div>
          <div><Typography.Text strong>使用场景：</Typography.Text>{list(m.scenarios)}</div>
          <div><Typography.Text strong>拒绝影响：</Typography.Text>{list(m.denyImpact)}</div>
          <div><Typography.Text strong>隐私/安全风险：</Typography.Text>{list(m.privacyRisk)}</div>
        </div>
      </div>
    )
  }

  const [drawerWidth, setDrawerWidth] = useState<number>(980)
  useEffect(() => {
    function update() {
      const w = typeof window !== 'undefined' ? window.innerWidth : 1200
      const v = w < 420 ? Math.floor(w * 0.98) : w < 768 ? Math.floor(w * 0.96) : Math.min(1200, Math.floor(w * 0.9))
      setDrawerWidth(v)
    }
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])

  function permTitleCell(r: any) {
    const title = String(r?.meta?.displayName || r?.name || r?.code || '')
    const code = String(r?.code || '')
    return (
      <div style={{ display: 'grid', gap: 2, minWidth: 260 }}>
        <Typography.Text strong style={{ lineHeight: 1.25 }}>{title}</Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12, wordBreak: 'break-all' }}>{code}</Typography.Text>
      </div>
    )
  }

  const permColumns: any[] = [
    { title: '权限名称', width: 360, render: (_: any, r: any) => permTitleCell(r) },
    { title: '风险', dataIndex: ['meta', 'riskLevel'], width: 100, render: (v: any) => riskTag(v) },
    {
      title: '说明',
      dataIndex: ['meta', 'purpose'],
      width: 520,
      render: (v: any) => <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }} ellipsis={{ rows: 2 }}>{String(v || '')}</Typography.Paragraph>,
    },
  ]

  function groupUpdate(groupCodes: string[], nextSelectedCodes: string[]) {
    const groupSet = new Set(groupCodes)
    const unique = Array.from(new Set(nextSelectedCodes))
    setSelectedPerms((prev) => [...prev.filter((c) => !groupSet.has(c)), ...unique])
  }

  function dedupeBySynonyms(list: Permission[]) {
    const codes = new Set(list.map((p) => p.code))
    return list.filter((p) => {
      const c = p.code
      if (c.startsWith('orders.') && codes.has(c.replace(/^orders\./, 'order.'))) return false
      if (c.startsWith('property.') && codes.has(c.replace(/^property\./, 'properties.'))) return false
      return true
    })
  }

  function canonicalizePerms(list: string[]) {
    const s = new Set((list || []).map((x) => String(x || '')).filter(Boolean))
    Array.from(s).forEach((c) => {
      if (c.startsWith('orders.') && s.has(c.replace(/^orders\./, 'order.'))) s.delete(c)
      if (c.startsWith('property.') && s.has(c.replace(/^property\./, 'properties.'))) s.delete(c)
    })
    return Array.from(s)
  }

  async function load() {
    const r = await fetch(`${API_BASE}/rbac/roles`).then(r => r.json())
    const p = await fetch(`${API_BASE}/rbac/permissions`).then(r => r.json())
    setRoles(r); setPerms(p)
    try { const u = await fetch(`${API_BASE}/rbac/users`, { headers: authHeaders() }).then(r => r.json()); setUsers(u || []) } catch { setUsers([]) }
  }
  useEffect(() => { load() }, [])

  async function edit(role: Role) {
    setCurrent(role)
    setOpen(true)
    setActiveMenuKey('')
    setMenuSearch('')
    setAdvancedSearch('')
    const rp = await fetch(`${API_BASE}/rbac/role-permissions?role_id=${role.id}`).then(r => r.json())
    const list = canonicalizePerms((rp || []).map((x: any) => String(x.permission_code || '')).filter(Boolean))
    const key = `rbac:rolePermDraft:${role.id}`
    let restored: string[] | null = null
    try {
      const raw = typeof window !== 'undefined' ? window.localStorage.getItem(key) : null
      if (raw) {
        const parsed = JSON.parse(raw)
        if (parsed && Array.isArray(parsed.perms) && parsed.roleId === role.id && parsed.dirty) restored = canonicalizePerms(parsed.perms)
      }
    } catch {}
    const initial = restored || list
    setSelectedPerms(initial)
    setSavedSnapshot(list)
    const menuKeySet = buildMenuKeySet(MENU_PERMISSION_MAP)
    setMenuCheckedKeys(initial.filter((c) => menuKeySet.has(String(c || ''))))
    setMenuExpandedKeys(Array.from(menuKeySet))
  }

  async function doSave() {
    const res = await fetch(`${API_BASE}/rbac/role-permissions`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify({ role_id: current?.id, permissions: selectedPerms }) })
    if (res.ok) {
      try { if (current?.id) window.localStorage.removeItem(`rbac:rolePermDraft:${current.id}`) } catch {}
      setSavedSnapshot(selectedPerms)
      message.success('已保存')
      setOpen(false)
      try { await preloadRolePerms() } catch {}
    } else { message.error('保存失败') }
  }

  async function submitUser() {
    const v = await userForm.validateFields()
    const payload: any = { ...v }
    if (!payload.email) delete payload.email
    payload.roles = normalizeRoles(payload.role, payload.extra_roles)
    delete payload.extra_roles
    if (payload.color_hex) payload.color_hex = String(payload.color_hex).trim().toUpperCase()
    if (payload.phone_au) payload.phone_au = normalizeAuPhone(payload.phone_au)
    const res = await fetch(`${API_BASE}/rbac/users`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(payload) })
    if (res.ok) { message.success('已创建用户'); setUserOpen(false); userForm.resetFields(); load() } else { message.error('创建失败') }
  }

  function openEditUser(u: User) {
    setEditUser(u)
    setEditUserOpen(true)
    const roles = Array.isArray((u as any).roles) ? ((u as any).roles as any[]) : []
    const all = Array.from(new Set([String(u.role || '').trim(), ...roles.map((x) => String(x || '').trim())].filter(Boolean)))
    const extra = all.filter((x) => x !== String(u.role || '').trim())
    editUserForm.setFieldsValue({ username: u.username, email: u.email || '', phone_au: u.phone_au || '', role: u.role, extra_roles: extra, color_hex: (u.color_hex || '#3B82F6') })
  }

  async function submitEditUser() {
    const v = await editUserForm.validateFields()
    const id = editUser?.id
    if (!id) return
    const payload: any = { ...v }
    if (!payload.email) delete payload.email
    if (payload.phone_au) payload.phone_au = normalizeAuPhone(payload.phone_au)
    payload.roles = normalizeRoles(payload.role, payload.extra_roles)
    delete payload.extra_roles
    if (!payload.color_hex) delete payload.color_hex
    if (payload.color_hex) payload.color_hex = String(payload.color_hex).trim().toUpperCase()
    const res = await fetch(`${API_BASE}/rbac/users/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(payload) })
    if (res.ok) {
      message.success('已更新用户')
      setEditUserOpen(false)
      setEditUser(null)
      editUserForm.resetFields()
      load()
    } else {
      let msg = '更新失败'
      try {
        const j = await res.json()
        if (j?.message) msg = String(j.message)
      } catch {}
      message.error(msg)
    }
  }

  async function submitRole() {
    const v = await roleForm.validateFields()
    const res = await fetch(`${API_BASE}/rbac/roles`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(v) })
    if (res.ok) { message.success('已创建角色'); setRoleOpen(false); roleForm.resetFields(); load() } else { message.error('创建失败') }
  }

  function openEditRole(r: Role) {
    setEditRole(r)
    setEditRoleOpen(true)
    editRoleForm.setFieldsValue({ name: r.name, description: r.description || '' })
  }

  async function submitEditRole() {
    const v = await editRoleForm.validateFields()
    const id = editRole?.id
    if (!id) return
    const res = await fetch(`${API_BASE}/rbac/roles/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(v) })
    if (res.ok) {
      const updated = await res.json()
      message.success('已更新角色')
      setEditRoleOpen(false)
      setEditRole(null)
      editRoleForm.resetFields()
      if (open && current?.id === id) setOpen(false)
      await load()
      try { await preloadRolePerms() } catch {}
      if (open && current?.id === id && updated?.id) {
        try { window.localStorage.removeItem(`rbac:rolePermDraft:${id}`) } catch {}
      }
    } else {
      let msg = '更新失败'
      try {
        const j = await res.json()
        if (j?.message) msg = String(j.message)
      } catch {}
      message.error(msg)
    }
  }

  function openResetPassword(u: User) {
    setPwUser(u)
    setPwOpen(true)
    pwForm.resetFields()
  }

  async function submitResetPassword() {
    const v = await pwForm.validateFields()
    const id = pwUser?.id
    if (!id) return
    const res = await fetch(`${API_BASE}/rbac/users/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify({ password: v.password }) })
    if (res.ok) { message.success('密码已更新'); setPwOpen(false); setPwUser(null); pwForm.resetFields(); load() } else { message.error('更新失败') }
  }

  async function removeUser(id: string) {
    Modal.confirm({ title: '确认删除用户', okType: 'danger', onOk: async () => {
      const res = await fetch(`${API_BASE}/rbac/users/${id}`, { method: 'DELETE', headers: authHeaders() })
      if (res.ok) { message.success('已删除'); load() } else { message.error('删除失败') }
    } })
  }

  async function removeRole(role: Role) {
    Modal.confirm({
      title: '确认删除角色',
      content: `角色：${role.name}`,
      okType: 'danger',
      onOk: async () => {
        const res = await fetch(`${API_BASE}/rbac/roles/${encodeURIComponent(role.id)}`, { method: 'DELETE', headers: authHeaders() })
        if (res.ok) {
          try { window.localStorage.removeItem(`rbac:rolePermDraft:${role.id}`) } catch {}
          if (open && current?.id === role.id) setOpen(false)
          if (editRoleOpen && editRole?.id === role.id) { setEditRoleOpen(false); setEditRole(null) }
          message.success('已删除角色')
          await load()
          try { await preloadRolePerms() } catch {}
          return
        }
        let msg = '删除失败'
        try {
          const j = await res.json()
          if (j?.message) msg = String(j.message)
        } catch {}
        message.error(msg)
      },
    })
  }

  const columns = [
    { title: '角色', dataIndex: 'name' },
    { title: '描述', dataIndex: 'description' },
    {
      title: '操作',
      render: (_: any, r: Role) => (
        <Space>
          {hasPerm('rbac.manage') && <Button onClick={() => edit(r)}>配置权限</Button>}
          {hasPerm('rbac.manage') && <Button onClick={() => openEditRole(r)}>编辑</Button>}
          {hasPerm('rbac.manage') && <Button danger disabled={r.name === 'admin'} onClick={() => removeRole(r)}>删除</Button>}
        </Space>
      ),
    },
  ]

  const userCols = [
    { title: '用户名', dataIndex: 'username' },
    { title: '邮箱', dataIndex: 'email' },
    { title: '澳洲手机号', dataIndex: 'phone_au' },
    {
      title: '主角色',
      dataIndex: 'role',
      render: (v: any) => <Tag>{String(v || '')}</Tag>,
    },
    {
      title: '多角色',
      render: (_: any, r: User) => {
        const roles = Array.isArray((r as any).roles) ? ((r as any).roles as any[]) : []
        const list = Array.from(new Set(roles.map((x) => String(x || '').trim()).filter(Boolean)))
        if (!list.length) return <Typography.Text type="secondary">-</Typography.Text>
        return (
          <Space size={[6, 6]} wrap>
            {list.map((x) => <Tag key={x}>{x}</Tag>)}
          </Space>
        )
      },
    },
    { title: '操作', render: (_: any, r: User) => (
      <Space>
        {hasPerm('rbac.manage') && <Button onClick={() => openEditUser(r)}>编辑</Button>}
        {hasPerm('rbac.manage') && <Button onClick={() => openResetPassword(r)}>设置新密码</Button>}
        {hasPerm('rbac.manage') && <Button danger onClick={() => removeUser(r.id)}>删除</Button>}
      </Space>
    ) },
  ]

  const menuKeySet = useMemo(() => buildMenuKeySet(MENU_PERMISSION_MAP), [])
  const permToMenuIndex = useMemo(() => buildPermToMenuIndex(MENU_PERMISSION_MAP), [])
  const mappedPermSet = useMemo(() => new Set(Object.keys(permToMenuIndex)), [permToMenuIndex])

  const permByCode: Record<string, Permission> = (() => {
    const m: Record<string, Permission> = {}
    perms.forEach((p) => { if (p?.code) m[String(p.code)] = p })
    return m
  })()

  function humanizeCode(code: string) {
    const raw = String(code || '').trim()
    if (!raw) return ''
    return raw
      .replace(/[._]/g, ' ')
      .replace(/\b([a-z])/g, (m) => m.toUpperCase())
  }

  function getDisplayName(code: string) {
    const p = permByCode[code]
    const name = String(p?.meta?.displayName || p?.name || p?.code || '')
    return name || humanizeCode(code) || code
  }

  function getPurpose(code: string) {
    const p = permByCode[code]
    const v = String(p?.meta?.purpose || '').trim()
    return v || '该权限暂无说明（建议补齐权限文档）。'
  }

  function getRiskLevel(code: string): RiskLevel {
    if (String(code).endsWith('.delete')) return 'high'
    const p = permByCode[code]
    const lv = (p?.meta?.riskLevel as RiskLevel | undefined) || undefined
    return lv || 'low'
  }

  function isHighRiskCode(code: string) {
    return getRiskLevel(code) === 'high'
  }

  function isMenuCode(code: string) {
    return menuKeySet.has(String(code || ''))
  }

  function has(code: string) { return selectedPerms.includes(code) }

  function applyChecked(code: string, checked: boolean) {
    setSelectedPerms((prev) => {
      const s = new Set(prev)
      if (checked) s.add(code); else s.delete(code)
      return Array.from(s)
    })
  }

  function confirmHighRiskEnable(code: string) {
    const title = `授予【${getDisplayName(code)}】`
    const content = (
      <div style={{ display: 'grid', gap: 8 }}>
        <Alert type="error" showIcon message="⚠️ 以下权限可能造成财务、系统或数据不可逆影响" />
        <div>
          <Typography.Text strong>启用后果：</Typography.Text>
          <Typography.Paragraph style={{ marginBottom: 0 }}>{getPurpose(code)}</Typography.Paragraph>
        </div>
      </div>
    )
    return new Promise<boolean>((resolve) => {
      Modal.confirm({
        title,
        content,
        okType: 'danger',
        okText: '确认启用',
        cancelText: '取消',
        onOk: () => resolve(true),
        onCancel: () => resolve(false),
      })
    })
  }

  async function setChecked(code: string, checked: boolean) {
    if (checked && isHighRiskCode(code)) {
      const ok = await confirmHighRiskEnable(code)
      if (!ok) return
    }
    applyChecked(code, checked)
  }

  function isViewLike(code: string) {
    const c = String(code || '')
    if (!c) return false
    if (/\.(view|read)$/i.test(c)) return true
    if (/\.view\./i.test(c)) return true
    if (/\.read\./i.test(c)) return true
    if (c === 'invoice.view') return true
    return false
  }

  function classifyAction(code: string) {
    const c = String(code || '')
    if (!c) return '流程动作'
    if (/\.(view|read)$/i.test(c) || /\.view\./i.test(c) || /\.read\./i.test(c)) return '查看'
    if (/\.create$/i.test(c) || /\.create\./i.test(c)) return '新增'
    if (/\.write$/i.test(c) || /\.write\./i.test(c) || /\.manage$/i.test(c) || /\.manage\./i.test(c)) return '编辑'
    if (/\.delete$/i.test(c)) return '删除'
    if (/\.archive$/i.test(c)) return '归档'
    return '流程动作'
  }

  const menuTreeData: any[] = useMemo(() => {
    function build(nodes: Record<string, any>): any[] {
      return Object.entries(nodes).map(([k, n]) => ({
        key: k,
        title: n.label,
        children: n.children ? build(n.children) : undefined,
      }))
    }
    return build(MENU_PERMISSION_MAP as any)
  }, [])

  const filteredMenuTreeData: any[] = useMemo(() => {
    const q = String(menuSearch || '').trim().toLowerCase()
    if (!q) return menuTreeData
    function filter(nodes: any[]): any[] {
      const out: any[] = []
      nodes.forEach((n) => {
        const title = String(n.title || '').toLowerCase()
        const children = Array.isArray(n.children) ? filter(n.children) : []
        if (title.includes(q) || children.length) out.push({ ...n, children: children.length ? children : undefined })
      })
      return out
    }
    return filter(menuTreeData)
  }, [menuTreeData, menuSearch])

  const mappedPermsAll = useMemo(() => {
    const s = new Set<string>()
    Object.keys(permToMenuIndex).forEach((k) => s.add(k))
    return s
  }, [permToMenuIndex])

  const unmappedRows = useMemo(() => {
    const q = String(advancedSearch || '').trim().toLowerCase()
    const list = dedupeBySynonyms(perms
      .filter((p) => {
        const code = String(p.code || '')
        if (!code) return false
        if (isMenuCode(code)) return false
        if (mappedPermsAll.has(code)) return false
        if (isHighRiskCode(code)) return false
        return true
      }))
    const rows = list.map((p) => ({ key: p.code, ...p }))
    if (!q) return rows
    return rows.filter((r: any) => {
      const dn = getDisplayName(String(r.code)).toLowerCase()
      const cc = String(r.code || '').toLowerCase()
      return dn.includes(q) || cc.includes(q)
    })
  }, [advancedSearch, perms, mappedPermsAll])

  const unmappedCodes = useMemo(() => unmappedRows.map((r: any) => String(r.code)), [unmappedRows])

  useEffect(() => {
    if (!open || !current?.id) return
    const key = `rbac:rolePermDraft:${current.id}`
    const dirty = JSON.stringify(selectedPerms.slice().sort()) !== JSON.stringify(savedSnapshot.slice().sort())
    try {
      window.localStorage.setItem(key, JSON.stringify({ roleId: current.id, perms: selectedPerms, dirty, updatedAt: Date.now() }))
    } catch {}
  }, [open, current?.id, selectedPerms, savedSnapshot])

  const menuIndex = useMemo(() => {
    const idx: Record<string, { key: string; label: string; perms: string[]; children: string[]; parent?: string }> = {}
    function walk(nodes: Record<string, any>, parent?: string) {
      Object.entries(nodes).forEach(([k, n]) => {
        const key = String(k)
        const label = String((n as any)?.label || key)
        const perms = Array.isArray((n as any)?.perms) ? (n as any).perms.map((x: any) => String(x || '')).filter(Boolean) : []
        const children = (n as any)?.children ? Object.keys((n as any).children) : []
        idx[key] = { key, label, perms, children, parent }
        if ((n as any)?.children) walk((n as any).children, key)
      })
    }
    walk(MENU_PERMISSION_MAP as any, undefined)
    return idx
  }, [])

  function getAncestors(key: string) {
    const out: string[] = []
    let cur = menuIndex[key]?.parent
    while (cur) {
      out.push(cur)
      cur = menuIndex[cur]?.parent
    }
    return out
  }

  function getDescendantsInclusive(key: string) {
    const out: string[] = []
    function walk(k: string) {
      out.push(k)
      const kids = menuIndex[k]?.children || []
      kids.forEach(walk)
    }
    walk(key)
    return out
  }

  function hasAnyCheckedChild(parentKey: string, checkedSet: Set<string>): boolean {
    const kids = menuIndex[parentKey]?.children || []
    return kids.some((k) => checkedSet.has(k) || hasAnyCheckedChild(k, checkedSet))
  }

  const halfCheckedKeys = useMemo(() => {
    const checkedSet = new Set(menuCheckedKeys)
    const half: string[] = []
    Object.values(menuIndex).forEach((n) => {
      if (!n.children.length) return
      const anyChild = n.children.some((c) => checkedSet.has(c) || hasAnyCheckedChild(c, checkedSet))
      const allChild = n.children.every((c) => checkedSet.has(c) || hasAnyCheckedChild(c, checkedSet))
      if (anyChild && !allChild && !checkedSet.has(n.key)) half.push(n.key)
    })
    return half
  }, [menuCheckedKeys, menuIndex])

  function confirmMenuHideOrRemove(keys: string[]) {
    const labels = keys.map((k) => menuIndex[k]?.label || k)
    let choice: 'hide' | 'remove' = 'remove'
    return new Promise<'hide' | 'remove'>((resolve) => {
      Modal.confirm({
        title: '取消菜单可见',
        content: (
          <div style={{ display: 'grid', gap: 10 }}>
            <Typography.Text>你正在隐藏：{labels.slice(0, 6).join('，')}{labels.length > 6 ? '…' : ''}</Typography.Text>
            <Radio.Group
              defaultValue="remove"
              onChange={(e) => { choice = e.target.value }}
              options={[
                { value: 'hide', label: '仅隐藏菜单（保留操作权限）' },
                { value: 'remove', label: '隐藏菜单并移除该菜单下所有操作权限（推荐）' },
              ]}
            />
          </div>
        ),
        okText: '确认',
        cancelText: '取消',
        onOk: () => resolve(choice),
        onCancel: () => resolve('hide'),
      })
    })
  }

  async function toggleMenuVisibility(menuKey: string, checked: boolean, opts?: { skipPrompt?: boolean }) {
    const key = String(menuKey || '')
    if (!key) return
    const prevSet = new Set(menuCheckedKeys)
    let nextSet = new Set(prevSet)

    const affected = getDescendantsInclusive(key)
    if (checked) {
      affected.forEach((k) => nextSet.add(k))
      getAncestors(key).forEach((a) => nextSet.add(a))
    } else {
      affected.forEach((k) => nextSet.delete(k))
      getAncestors(key).forEach((a) => {
        if (!hasAnyCheckedChild(a, nextSet)) nextSet.delete(a)
      })
    }

    const newlyChecked = Array.from(nextSet).filter((k) => !prevSet.has(k))
    const newlyUnchecked = Array.from(prevSet).filter((k) => !nextSet.has(k))

    const toPrompt = !checked
      ? newlyUnchecked.filter((k) => (menuIndex[k]?.perms || []).length > 0)
      : []
    let removeOps = false
    if (!opts?.skipPrompt && toPrompt.length) {
      const choice = await confirmMenuHideOrRemove(toPrompt)
      removeOps = choice === 'remove'
    }

    const selectedSet = new Set(selectedPerms)
    newlyChecked.forEach((k) => selectedSet.add(k))
    newlyUnchecked.forEach((k) => selectedSet.delete(k))
    newlyChecked.forEach((k) => {
      const perms = menuIndex[k]?.perms || []
      perms.forEach((p) => {
        if (isViewLike(p) && !isHighRiskCode(p)) selectedSet.add(p)
      })
    })

    if (removeOps && toPrompt.length) {
      const permsToRemove = new Set<string>()
      toPrompt.forEach((mk) => (menuIndex[mk]?.perms || []).forEach((p) => permsToRemove.add(p)))
      permsToRemove.forEach((p) => {
        const refs = permToMenuIndex[p]
        const usedElsewhere = refs ? Array.from(refs).some((mk) => nextSet.has(mk)) : false
        if (!usedElsewhere) selectedSet.delete(p)
      })
    }

    const finalSelected = canonicalizePerms(Array.from(selectedSet))
    setMenuCheckedKeys(Array.from(nextSet))
    setSelectedPerms(finalSelected)
  }

  useEffect(() => {
    if (!open) return
    const fromSelected = selectedPerms.filter((c) => isMenuCode(c))
    const a = JSON.stringify(fromSelected.slice().sort())
    const b = JSON.stringify(menuCheckedKeys.slice().sort())
    if (a !== b) setMenuCheckedKeys(fromSelected)
  }, [open, selectedPerms, menuCheckedKeys])

  const activeNode = activeMenuKey ? findMenuNode(MENU_PERMISSION_MAP, activeMenuKey) : null
  const activePath = activeMenuKey ? findMenuPathLabels(MENU_PERMISSION_MAP, activeMenuKey) : []
  const activePerms = (activeNode?.perms || []).map((x) => String(x || '')).filter(Boolean)
  const permsByAction = useMemo(() => {
    const map: Record<string, string[]> = {}
    activePerms.forEach((p) => {
      const act = classifyAction(p)
      map[act] = map[act] || []
      map[act].push(p)
    })
    const order = ['查看', '新增', '编辑', '删除', '归档', '流程动作']
    const out: Record<string, string[]> = {}
    order.forEach((k) => { if (map[k]?.length) out[k] = map[k] })
    Object.keys(map).forEach((k) => { if (!out[k]) out[k] = map[k] })
    return out
  }, [activePerms.join('|')])

  async function setAllMenusVisible(checked: boolean) {
    if (checked) {
      const allKeys = Array.from(menuKeySet)
      const selectedSet = new Set(selectedPerms)
      allKeys.forEach((k) => selectedSet.add(k))
      allKeys.forEach((k) => {
        const perms = menuIndex[k]?.perms || []
        perms.forEach((p) => { if (isViewLike(p) && !isHighRiskCode(p)) selectedSet.add(p) })
      })
      setMenuCheckedKeys(allKeys)
      setMenuExpandedKeys(allKeys)
      setSelectedPerms(canonicalizePerms(Array.from(selectedSet)))
      return
    }

    const submenus = Object.values(menuIndex).filter((n) => n.perms.length > 0).map((n) => n.key).filter((k) => menuCheckedKeys.includes(k))
    let removeOps = false
    if (submenus.length) {
      const choice = await confirmMenuHideOrRemove(submenus)
      removeOps = choice === 'remove'
    }
    const selectedSet = new Set(selectedPerms)
    menuCheckedKeys.forEach((k) => selectedSet.delete(k))
    if (removeOps && submenus.length) {
      const permsToRemove = new Set<string>()
      submenus.forEach((mk) => (menuIndex[mk]?.perms || []).forEach((p) => permsToRemove.add(p)))
      permsToRemove.forEach((p) => selectedSet.delete(p))
    }
    setMenuCheckedKeys([])
    setSelectedPerms(canonicalizePerms(Array.from(selectedSet)))
  }

  return (
    <Card
      title="角色权限"
      extra={hasPerm('rbac.manage')
        ? (
          <Space>
            <Button onClick={() => setRoleOpen(true)}>新建角色</Button>
            <Button onClick={() => setUserOpen(true)}>新建用户</Button>
          </Space>
        )
        : null}
    >
      <Table rowKey={(r) => r.id} columns={columns as any} dataSource={roles} pagination={false} />
      <Card title="系统用户" style={{ marginTop: 16 }}>
        <Table rowKey={(r) => (r as any).id} columns={userCols as any} dataSource={users} pagination={{ pageSize: 10 }} />
      </Card>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title={`配置权限：${current?.name}`}
        width={drawerWidth}
        style={{ maxWidth: '98vw' }}
        styles={{ body: { padding: 12 } }}
      >
        <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 12, alignItems: 'start' }}>
          <Card size="small" title="菜单（入口权限）" styles={{ body: { padding: 10 } }}>
            <div style={{ display: 'grid', gap: 10 }}>
              <Input
                placeholder="搜索菜单"
                value={menuSearch}
                onChange={(e) => {
                  const v = e.target.value
                  setMenuSearch(v)
                  if (v) setMenuExpandedKeys(Array.from(menuKeySet))
                }}
              />
              <Space wrap>
                <Button size="small" onClick={() => setMenuExpandedKeys(Array.from(menuKeySet))}>展开</Button>
                <Button size="small" onClick={() => setMenuExpandedKeys([])}>折叠</Button>
                <Button size="small" onClick={() => { setAllMenusVisible(true).catch(() => {}) }}>全选</Button>
                <Button size="small" onClick={() => { setAllMenusVisible(false).catch(() => {}) }}>反选</Button>
              </Space>
              <Tree
                checkable
                selectable
                checkStrictly
                expandedKeys={menuExpandedKeys}
                onExpand={(keys) => setMenuExpandedKeys((keys as any[]).map((k) => String(k)))}
                checkedKeys={{ checked: menuCheckedKeys, halfChecked: halfCheckedKeys }}
                onCheck={(_, info: any) => {
                  const k = String(info?.node?.key || '')
                  const c = !!info?.checked
                  toggleMenuVisibility(k, c).catch(() => {})
                }}
                selectedKeys={activeMenuKey ? [activeMenuKey] : []}
                onSelect={(keys) => setActiveMenuKey(String((keys as any[])[0] || ''))}
                treeData={filteredMenuTreeData as any}
              />
              <Typography.Text type="secondary">菜单层仅控制是否可见/是否能进入，不包含任何操作权限。</Typography.Text>
            </div>
          </Card>

          <Card
            size="small"
            title={activePath.length ? `${activePath[activePath.length - 1]} · 可执行操作` : '可执行操作'}
            extra={activePath.length ? <Typography.Text type="secondary">{activePath.join(' > ')}</Typography.Text> : null}
            styles={{ body: { padding: 12 } }}
          >
            {!activeMenuKey ? (
              <Empty description="请选择左侧子菜单查看可执行操作" />
            ) : !activePerms.length ? (
              <Empty description="该菜单未配置可执行操作（未在 MENU_PERMISSION_MAP 中声明 perms）" />
            ) : (
              <div style={{ display: 'grid', gap: 12 }}>
                <Alert type="info" showIcon message="提示" description="这里展示的是“行为/操作权限”。菜单本身只控制入口可见性。" />
                {Object.entries(permsByAction).map(([action, list]) => (
                  <div key={action}>
                    <Typography.Text strong>{action}</Typography.Text>
                    <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
                      {list.map((code) => {
                        const high = isHighRiskCode(code)
                        const label = getDisplayName(code)
                        const purpose = getPurpose(code)
                        return (
                          <div key={code} style={{ display: 'grid', gap: 4, padding: 10, border: '1px solid #f0f0f0', borderRadius: 8 }}>
                            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', justifyContent: 'space-between' }}>
                              <Checkbox
                                checked={has(code)}
                                onChange={async (e) => {
                                  const next = e.target.checked
                                  if (next && activeMenuKey && !menuCheckedKeys.includes(activeMenuKey)) {
                                    await toggleMenuVisibility(activeMenuKey, true, { skipPrompt: true })
                                  }
                                  await setChecked(code, next)
                                }}
                              >
                                <Typography.Text strong>{high ? `🔒 ${label}` : label}</Typography.Text>
                              </Checkbox>
                              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                                {riskTag(getRiskLevel(code))}
                              </div>
                            </div>
                            <Typography.Text type="secondary">{purpose}</Typography.Text>
                          </div>
                        )
                      })}
                    </div>
                    <Divider style={{ margin: '12px 0' }} />
                  </div>
                ))}

                <Collapse
                  defaultActiveKey={[]}
                  items={[
                    {
                      key: 'advanced',
                      label: '未映射权限（高级）',
                      children: (
                        <div style={{ display: 'grid', gap: 10 }}>
                          <Typography.Text type="secondary">仅展示低/中风险权限；高风险权限不进入该区域。</Typography.Text>
                          <Input
                            placeholder="搜索未映射权限"
                            value={advancedSearch}
                            onChange={(e) => setAdvancedSearch(e.target.value)}
                          />
                          <Table
                            size="small"
                            rowKey={(r) => String((r as any).code)}
                            dataSource={unmappedRows as any}
                            pagination={{ pageSize: 10, showSizeChanger: true }}
                            tableLayout="fixed"
                            columns={[
                              { title: '权限', width: 360, render: (_: any, r: any) => permTitleCell(r) },
                              { title: '风险', width: 110, render: (_: any, r: any) => riskTag(getRiskLevel(String(r.code))) },
                              {
                                title: '启用',
                                width: 90,
                                align: 'center',
                                render: (_: any, r: any) => (
                                  <Checkbox
                                    checked={has(String(r.code))}
                                    onChange={(e) => { setChecked(String(r.code), e.target.checked).catch(() => {}) }}
                                  />
                                ),
                              },
                            ]}
                          />
                        </div>
                      ),
                    },
                  ]}
                />
              </div>
            )}

            <Space style={{ marginTop: 12 }}>
              <Button type="primary" onClick={() => { doSave().catch(() => {}) }}>保存</Button>
              <Button onClick={() => setOpen(false)}>取消</Button>
            </Space>
          </Card>
        </div>
      </Drawer>
      <Modal open={userOpen} onCancel={() => setUserOpen(false)} onOk={submitUser} title="新建用户">
        <Form form={userForm} layout="vertical" initialValues={{ color_hex: '#3B82F6' }}>
          <Form.Item name="username" label="用户名" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="email" label="邮箱" rules={[{ type: 'email' }]}><Input placeholder="可选" /></Form.Item>
          <Form.Item
            name="phone_au"
            label="澳洲手机号"
            normalize={(v) => normalizeAuPhone(v)}
            rules={[{ required: true }, { pattern: /^\+61\d{9}$/, message: '请输入有效澳洲手机号，例如 +61412345678 或 0412345678' }]}
          >
            <Input placeholder="+61412345678 或 0412345678" />
          </Form.Item>
          <Form.Item name="role" label="主角色" rules={[{ required: true }]}><Select options={roles.map(r => ({ value: r.name, label: r.name }))} /></Form.Item>
          <Form.Item name="extra_roles" label="其他角色">
            <Select mode="multiple" options={roles.map(r => ({ value: r.name, label: r.name }))} />
          </Form.Item>
          <Form.Item
            name="color_hex"
            label="颜色"
            rules={[{ pattern: /^#[0-9a-fA-F]{6}$/, message: '请输入形如 #RRGGBB 的颜色值' }]}
            getValueProps={(v) => ({ value: (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)) ? v.toUpperCase() : '#3B82F6' })}
            getValueFromEvent={(...args: any[]) => {
              const hex = args?.[1]
              const color = args?.[0]
              if (typeof hex === 'string' && /^#[0-9a-fA-F]{6}$/.test(hex)) return hex.toUpperCase()
              if (typeof color?.toHexString === 'function') return String(color.toHexString()).toUpperCase()
              if (typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color)) return color.toUpperCase()
              return undefined
            }}
          >
            <ColorPicker format="hex" showText getPopupContainer={(n) => (n?.parentElement as any) || document.body} />
          </Form.Item>
          <Form.Item name="password" label="密码" rules={[{ required: true, min: 6 }]}><Input.Password /></Form.Item>
        </Form>
      </Modal>
      <Modal
        open={editUserOpen}
        onCancel={() => { setEditUserOpen(false); setEditUser(null) }}
        onOk={submitEditUser}
        title={`编辑用户：${editUser?.username || ''}`}
      >
        <Form form={editUserForm} layout="vertical">
          <Form.Item name="username" label="用户名" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="email" label="邮箱" rules={[{ type: 'email' }]}><Input placeholder="留空则不修改" /></Form.Item>
          <Form.Item
            name="phone_au"
            label="澳洲手机号"
            normalize={(v) => normalizeAuPhone(v)}
            rules={[{ required: true }, { pattern: /^\+61\d{9}$/, message: '请输入有效澳洲手机号，例如 +61412345678 或 0412345678' }]}
          >
            <Input placeholder="+61412345678 或 0412345678" />
          </Form.Item>
          <Form.Item name="role" label="主角色" rules={[{ required: true }]}><Select options={roles.map(r => ({ value: r.name, label: r.name }))} /></Form.Item>
          <Form.Item name="extra_roles" label="其他角色">
            <Select mode="multiple" options={roles.map(r => ({ value: r.name, label: r.name }))} />
          </Form.Item>
          <Form.Item
            name="color_hex"
            label="颜色"
            rules={[{ pattern: /^#[0-9a-fA-F]{6}$/, message: '请输入形如 #RRGGBB 的颜色值' }]}
            getValueProps={(v) => ({ value: (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)) ? v.toUpperCase() : '#3B82F6' })}
            getValueFromEvent={(...args: any[]) => {
              const hex = args?.[1]
              const color = args?.[0]
              if (typeof hex === 'string' && /^#[0-9a-fA-F]{6}$/.test(hex)) return hex.toUpperCase()
              if (typeof color?.toHexString === 'function') return String(color.toHexString()).toUpperCase()
              if (typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color)) return color.toUpperCase()
              return undefined
            }}
          >
            <ColorPicker format="hex" showText getPopupContainer={(n) => (n?.parentElement as any) || document.body} />
          </Form.Item>
        </Form>
      </Modal>
      <Modal open={roleOpen} onCancel={() => setRoleOpen(false)} onOk={submitRole} title="新建角色">
        <Form form={roleForm} layout="vertical">
          <Form.Item name="name" label="角色名" rules={[{ required: true }]}><Input placeholder="例如：ops_manager" /></Form.Item>
          <Form.Item name="description" label="描述"><Input.TextArea rows={3} /></Form.Item>
        </Form>
      </Modal>
      <Modal
        open={editRoleOpen}
        onCancel={() => { setEditRoleOpen(false); setEditRole(null) }}
        onOk={submitEditRole}
        title={`编辑角色：${editRole?.name || ''}`}
      >
        <Form form={editRoleForm} layout="vertical">
          <Form.Item name="name" label="角色名" rules={[{ required: true }]}><Input placeholder="例如：ops_manager" /></Form.Item>
          <Form.Item name="description" label="描述"><Input.TextArea rows={3} /></Form.Item>
        </Form>
      </Modal>
      <Modal open={pwOpen} onCancel={() => { setPwOpen(false); setPwUser(null) }} onOk={submitResetPassword} title={`设置新密码：${pwUser?.username || ''}`}>
        <Form form={pwForm} layout="vertical">
          <Form.Item name="password" label="新密码" rules={[{ required: true, min: 6 }]}><Input.Password /></Form.Item>
          <Form.Item
            name="passwordConfirm"
            label="确认新密码"
            dependencies={['password']}
            rules={[
              { required: true, min: 6 },
              ({ getFieldValue }) => ({
                validator(_, value) {
                  const p = getFieldValue('password')
                  if (!value || value === p) return Promise.resolve()
                  return Promise.reject(new Error('两次输入的密码不一致'))
                },
              }),
            ]}
          >
            <Input.Password />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  )
}
