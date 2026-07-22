"use client"
import { Alert, Card, Table, Drawer, Space, Button, Select, message, Modal, Form, Input, Checkbox, Typography, Tag, Collapse, Radio, ColorPicker } from 'antd'
import { useEffect, useMemo, useState } from 'react'
import { API_BASE, authHeaders } from '../../lib/api'
import { preloadRolePerms } from '../../lib/auth'
import { hasPerm } from '../../lib/auth'
import { MENU_PERMISSION_INDEX, MENU_PERMISSION_ROWS, MENU_PERMISSION_TREE, buildMenuKeySet, buildPermToMenuIndex } from './rbacMenuMap'

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
  const [mounted, setMounted] = useState(false)
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
  const [menuSearch, setMenuSearch] = useState<string>('')
  const [advancedSearch, setAdvancedSearch] = useState<string>('')

  useEffect(() => {
    setMounted(true)
  }, [])

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
    const menuKeySet = buildMenuKeySet(MENU_PERMISSION_TREE)
    setMenuCheckedKeys(initial.filter((c) => menuKeySet.has(String(c || ''))))
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
    payload.email = String(payload.email || '').trim() || null
    payload.phone_au = payload.phone_au ? normalizeAuPhone(payload.phone_au) : null
    payload.roles = normalizeRoles(payload.role, payload.extra_roles)
    delete payload.extra_roles
    if (payload.color_hex) payload.color_hex = String(payload.color_hex).trim().toUpperCase()
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
    payload.email = String(payload.email || '').trim() || null
    payload.phone_au = payload.phone_au ? normalizeAuPhone(payload.phone_au) : null
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
          {canManage && <Button onClick={() => edit(r)}>配置权限</Button>}
          {canManage && <Button onClick={() => openEditRole(r)}>编辑</Button>}
          {canManage && <Button danger disabled={r.name === 'admin'} onClick={() => removeRole(r)}>删除</Button>}
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
        {canManage && <Button onClick={() => openEditUser(r)}>编辑</Button>}
        {canManage && <Button onClick={() => openResetPassword(r)}>设置新密码</Button>}
        {canManage && <Button danger onClick={() => removeUser(r.id)}>删除</Button>}
      </Space>
    ) },
  ]

  const canManage = mounted && hasPerm('rbac.manage')

  const menuKeySet = useMemo(() => buildMenuKeySet(MENU_PERMISSION_TREE), [])
  const permToMenuIndex = useMemo(() => buildPermToMenuIndex(MENU_PERMISSION_TREE), [])
  const menuIndex = useMemo(() => MENU_PERMISSION_INDEX, [])

  const permByCode: Record<string, Permission> = useMemo(() => {
    const m: Record<string, Permission> = {}
    perms.forEach((p) => { if (p?.code) m[String(p.code)] = p })
    return m
  }, [perms])

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

  function stripRiskSuffix(name: string) {
    return String(name || '').replace(/（[^）]*高危[^）]*）/g, '').replace(/\([^)]*high[^)]*\)/gi, '').trim()
  }

  function formatActionLabel(code: string) {
    const fixed: Record<string, string> = {
      'order.confirm_payment': '确认收款',
      'order.deduction.manage': '扣款管理',
      'order.cancel': '取消订单',
      'invoice.draft.create': '创建草稿',
      'invoice.issue': '开票',
      'invoice.send': '发送',
      'invoice.void': '作废',
      'invoice.payment.record': '付款记录',
      'invoice.company.manage': '公司管理',
      'invoice.type.switch': '发票类型',
      'users.password.reset': '重置密码',
      'cleaning_app.assign': '指派',
      'cleaning_app.ready.set': 'Ready 状态',
      'cleaning_app.restock.manage': '补货管理',
      'cleaning_app.sse.subscribe': '实时订阅',
      'cleaning_app.push.subscribe': '推送订阅',
      'cleaning_app.media.upload': '上传媒体',
      'cleaning_app.issues.report': '上报问题',
      'cleaning_app.tasks.start': '开始任务',
      'cleaning_app.tasks.finish': '完成任务',
      'cleaning_app.inspect.finish': '完成检查',
      'cleaning_app.calendar.view.all': '查看全部',
      'cleaning_app.tasks.view.self': '查看本人',
      'inventory.po.manage': '采购管理',
      'inventory.move': '库存操作',
      'inventory_linen_deliveries.archive': '作废',
      'inventory_daily_deliveries.archive': '作废',
      'inventory_consumable_deliveries.archive': '作废',
      'inventory_other_deliveries.archive': '作废',
      'company_secret_items.view': '查看线下密码',
      'company_secret_items.write': '编辑线下密码',
      'company_secret_items.delete': '删除线下密码',
      'cms_public_access.manage': '外链密码',
      'keyset.manage': '钥匙管理',
      'key.flow': '钥匙流转',
      'finance.tx.write': '编辑',
      'finance.payout': '结算/打款',
      'rbac.manage': '权限管理',
      'landlord.manage': '管理',
      'onboarding.read': '查看',
      'onboarding.manage': '管理',
    }
    if (fixed[code]) return fixed[code]
    if (/\.(view|read)$/i.test(code) || /\.view\./i.test(code) || /\.read\./i.test(code)) return '查看'
    if (/\.create$/i.test(code) || /\.create\./i.test(code)) return '新增'
    if (/\.write$/i.test(code) || /\.write\./i.test(code)) return '编辑'
    if (/\.delete$/i.test(code)) return '删除'
    if (/\.archive$/i.test(code)) return '归档'
    if (/\.manage$/i.test(code) || /\.manage\./i.test(code)) return '管理'
    const display = stripRiskSuffix(getDisplayName(code))
    const suffix = display.split(/[：:]/).slice(1).join('：').trim()
    if (suffix && suffix.length <= 12) return suffix
    return '允许'
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

  const mappedPermsAll = (() => {
    const s = new Set<string>()
    Object.keys(permToMenuIndex).forEach((k) => s.add(k))
    return s
  })()

  const unmappedRows = (() => {
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
  })()

  useEffect(() => {
    if (!open || !current?.id) return
    const key = `rbac:rolePermDraft:${current.id}`
    const dirty = JSON.stringify(selectedPerms.slice().sort()) !== JSON.stringify(savedSnapshot.slice().sort())
    try {
      window.localStorage.setItem(key, JSON.stringify({ roleId: current.id, perms: selectedPerms, dirty, updatedAt: Date.now() }))
    } catch {}
  }, [open, current?.id, selectedPerms, savedSnapshot])

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

  const halfCheckedKeys = (() => {
    const checkedSet = new Set(menuCheckedKeys)
    const half: string[] = []
    Object.values(menuIndex).forEach((n) => {
      if (!n.children.length) return
      const anyChild = n.children.some((c) => checkedSet.has(c) || hasAnyCheckedChild(c, checkedSet))
      const allChild = n.children.every((c) => checkedSet.has(c) || hasAnyCheckedChild(c, checkedSet))
      if (anyChild && !allChild && !checkedSet.has(n.key)) half.push(n.key)
    })
    return half
  })()

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
    const fromSelected = selectedPerms.filter((c) => menuKeySet.has(String(c || '')))
    const a = JSON.stringify(fromSelected.slice().sort())
    const b = JSON.stringify(menuCheckedKeys.slice().sort())
    if (a !== b) setMenuCheckedKeys(fromSelected)
  }, [open, selectedPerms, menuCheckedKeys, menuKeySet])

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

  const matrixRows = (() => {
    const q = String(menuSearch || '').trim().toLowerCase()
    const filtered = MENU_PERMISSION_ROWS.filter((row) => {
      if (!q) return true
      const label = String(row.label || '').toLowerCase()
      const path = String(row.pathText || '').toLowerCase()
      return label.includes(q) || path.includes(q)
    })
    return filtered.map((row) => {
      const actionCodes = canonicalizePerms(row.perms)
      return {
        ...row,
        actionCodes,
        actionItems: actionCodes.map((code) => ({
          code,
          label: formatActionLabel(code),
          riskLevel: getRiskLevel(code),
          purpose: getPurpose(code),
          displayName: getDisplayName(code),
        })),
      }
    })
  })()

  const menuSelectionSummary = (() => {
    const visibleCount = menuCheckedKeys.length
    const actionCount = selectedPerms.filter((code) => !isMenuCode(code)).length
    return { visibleCount, actionCount }
  })()

  return (
    <Card
      title="角色权限"
      extra={canManage
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
        <div style={{ display: 'grid', gap: 12 }}>
          <Card size="small" title="菜单权限矩阵" styles={{ body: { padding: 12 } }}>
            <div style={{ display: 'grid', gap: 12 }}>
              <Alert
                type="info"
                showIcon
                message="按菜单逐行配置"
                description="勾选任一操作权限时，会自动勾选该行菜单可见。取消“可见”时，你可以选择仅隐藏入口，或同时移除该菜单下的操作权限。"
              />
              <div style={{ display: 'flex', gap: 12, justifyContent: 'space-between', flexWrap: 'wrap' }}>
                <Input
                  placeholder="搜索菜单或路径"
                  value={menuSearch}
                  onChange={(e) => setMenuSearch(e.target.value)}
                  style={{ maxWidth: 360 }}
                />
                <Space wrap>
                  <Tag bordered={false} color="blue">已显示 {menuSelectionSummary.visibleCount}</Tag>
                  <Tag bordered={false} color="geekblue">已授权 {menuSelectionSummary.actionCount}</Tag>
                  <Button size="small" onClick={() => { setAllMenusVisible(true).catch(() => {}) }}>全部显示</Button>
                  <Button size="small" onClick={() => { setAllMenusVisible(false).catch(() => {}) }}>全部隐藏</Button>
                </Space>
              </div>
              <Table
                size="small"
                rowKey={(r) => String((r as any).key)}
                dataSource={matrixRows as any}
                pagination={{ pageSize: 18, showSizeChanger: true }}
                scroll={{ x: 960 }}
                columns={[
                  {
                    title: '菜单 / 页面',
                    width: 360,
                    render: (_: any, row: any) => (
                      <div style={{ display: 'grid', gap: 4, paddingLeft: row.depth ? row.depth * 14 : 0 }}>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                          <Typography.Text strong>{row.label}</Typography.Text>
                          {row.depth > 0 ? <Tag>{`L${row.depth + 1}`}</Tag> : null}
                          {row.actionItems?.length ? null : <Tag color="default">仅入口</Tag>}
                        </div>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {row.pathText}
                        </Typography.Text>
                      </div>
                    ),
                  },
                  {
                    title: '可见',
                    width: 100,
                    align: 'center',
                    render: (_: any, row: any) => (
                      <Checkbox
                        checked={menuCheckedKeys.includes(String(row.key))}
                        indeterminate={halfCheckedKeys.includes(String(row.key))}
                        onChange={(e) => { toggleMenuVisibility(String(row.key), e.target.checked).catch(() => {}) }}
                      />
                    ),
                  },
                  {
                    title: '可执行操作',
                    render: (_: any, row: any) => (
                      row.actionItems?.length ? (
                        <div
                          style={{
                            display: 'grid',
                            gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
                            gap: 10,
                            alignItems: 'stretch',
                          }}
                        >
                          {row.actionItems.map((item: any) => {
                            const checked = has(String(item.code))
                            const high = item.riskLevel === 'high'
                            return (
                              <label
                                key={item.code}
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'space-between',
                                  gap: 8,
                                  width: '100%',
                                  minHeight: 40,
                                  padding: '7px 12px',
                                  boxSizing: 'border-box',
                                  border: `1px solid ${checked ? '#91caff' : '#f0f0f0'}`,
                                  borderRadius: 12,
                                  background: checked ? '#f0f7ff' : '#fff',
                                  cursor: 'pointer',
                                }}
                                title={item.purpose}
                              >
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                                  <Checkbox
                                    checked={checked}
                                    onChange={async (e) => {
                                      const next = e.target.checked
                                      if (next && !menuCheckedKeys.includes(String(row.key))) {
                                        await toggleMenuVisibility(String(row.key), true, { skipPrompt: true })
                                      }
                                      await setChecked(String(item.code), next)
                                    }}
                                  />
                                  <Typography.Text ellipsis style={{ minWidth: 0 }}>{item.label}</Typography.Text>
                                </span>
                                {high ? <span style={{ flexShrink: 0 }}>{riskTag(item.riskLevel)}</span> : null}
                              </label>
                            )
                          })}
                        </div>
                      ) : (
                        <Typography.Text type="secondary">该项仅控制菜单入口显示</Typography.Text>
                      )
                    ),
                  },
                ]}
                expandable={{
                  expandedRowRender: (row: any) => (
                    <div style={{ display: 'grid', gap: 8 }}>
                      <Typography.Text type="secondary">权限路径：{row.pathText}</Typography.Text>
                      {row.actionItems?.length ? (
                        <div style={{ display: 'grid', gap: 6 }}>
                          {row.actionItems.map((item: any) => (
                            <div key={item.code} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', justifyContent: 'space-between' }}>
                              <div style={{ display: 'grid', gap: 2 }}>
                                <Typography.Text strong>{item.label}</Typography.Text>
                                <Typography.Text type="secondary" style={{ fontSize: 12 }}>{item.displayName}</Typography.Text>
                                <Typography.Text type="secondary" style={{ fontSize: 12 }}>{item.purpose}</Typography.Text>
                              </div>
                              {riskTag(item.riskLevel)}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <Typography.Text type="secondary">没有绑定额外动作权限。</Typography.Text>
                      )}
                    </div>
                  ),
                  rowExpandable: (row: any) => !!row.actionItems?.length,
                }}
              />
              <Collapse
                defaultActiveKey={[]}
                items={[
                  {
                    key: 'advanced',
                    label: '未映射权限（高级）',
                    children: (
                      <div style={{ display: 'grid', gap: 10 }}>
                        <Typography.Text type="secondary">仅展示低/中风险且未进入菜单矩阵的权限；高风险权限仍通过对应菜单项授予。</Typography.Text>
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
          </Card>

          <Space>
            <Button type="primary" onClick={() => { doSave().catch(() => {}) }}>保存</Button>
            <Button onClick={() => setOpen(false)}>取消</Button>
          </Space>
        </div>
      </Drawer>
      <Modal open={userOpen} onCancel={() => setUserOpen(false)} onOk={submitUser} title="新建用户">
        <Form form={userForm} layout="vertical" initialValues={{ color_hex: '#3B82F6' }}>
          <Form.Item name="username" label="用户名" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="email" label="邮箱（可选）" rules={[{ type: 'email' }]}><Input placeholder="可留空" /></Form.Item>
          <Form.Item
            name="phone_au"
            label="澳洲手机号（可选）"
            normalize={(v) => normalizeAuPhone(v)}
            rules={[{ pattern: /^\+61\d{9}$/, message: '请输入有效澳洲手机号，例如 +61412345678 或 0412345678' }]}
          >
            <Input placeholder="可留空；例如 +61412345678 或 0412345678" />
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
            <ColorPicker format="hex" showText getPopupContainer={(n) => (n?.parentElement as any) || (typeof document !== 'undefined' ? document.body : undefined as any)} />
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
          <Form.Item name="email" label="邮箱（可选）" rules={[{ type: 'email' }]}><Input placeholder="可留空" /></Form.Item>
          <Form.Item
            name="phone_au"
            label="澳洲手机号（可选）"
            normalize={(v) => normalizeAuPhone(v)}
            rules={[{ pattern: /^\+61\d{9}$/, message: '请输入有效澳洲手机号，例如 +61412345678 或 0412345678' }]}
          >
            <Input placeholder="可留空；例如 +61412345678 或 0412345678" />
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
            <ColorPicker format="hex" showText getPopupContainer={(n) => (n?.parentElement as any) || (typeof document !== 'undefined' ? document.body : undefined as any)} />
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
