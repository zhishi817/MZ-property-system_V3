"use client"
import { Card, Table, Drawer, Space, Button, Select, message, Modal, Form, Input, Checkbox, Divider, Typography, Tag } from 'antd'
import { useEffect, useState } from 'react'
import { API_BASE, authHeaders } from '../../lib/api'
import { preloadRolePerms } from '../../lib/auth'
import { hasPerm } from '../../lib/auth'

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
type User = { id: string; username: string; email?: string; role: string }

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
  }

  async function save() {
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
    const res = await fetch(`${API_BASE}/rbac/users`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(v) })
    if (res.ok) { message.success('已创建用户'); setUserOpen(false); userForm.resetFields(); load() } else { message.error('创建失败') }
  }

  function openEditUser(u: User) {
    setEditUser(u)
    setEditUserOpen(true)
    editUserForm.setFieldsValue({ username: u.username, email: u.email || '', role: u.role })
  }

  async function submitEditUser() {
    const v = await editUserForm.validateFields()
    const id = editUser?.id
    if (!id) return
    const payload: any = { ...v }
    if (!payload.email) delete payload.email
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
    { title: '角色', dataIndex: 'role' },
    { title: '操作', render: (_: any, r: User) => (
      <Space>
        {hasPerm('rbac.manage') && <Button onClick={() => openEditUser(r)}>编辑</Button>}
        {hasPerm('rbac.manage') && <Button onClick={() => openResetPassword(r)}>设置新密码</Button>}
        {hasPerm('rbac.manage') && <Button danger onClick={() => removeUser(r.id)}>删除</Button>}
      </Space>
    ) },
  ]

  const menuRows = dedupeBySynonyms(perms
    .filter(p => p.code.startsWith('menu.') && !/\.visible$/.test(p.code))
    .map(p => ({ key: p.code, ...p })))
  const menuCodes = menuRows.map((p: any) => p.code)

  const resourceRows = dedupeBySynonyms(perms
    .filter(p => !p.code.startsWith('menu.') && /\.(view|write|delete|archive)$/.test(p.code))
    .map(p => ({ key: p.code, ...p })))
  const resourceCodes = resourceRows.map((p: any) => p.code)

  const featureRows = dedupeBySynonyms(perms
    .filter(p => !p.code.startsWith('menu.') && !/\.(view|write|delete|archive)$/.test(p.code))
    .map(p => ({ key: p.code, ...p })))
  const featureCodes = featureRows.map((p: any) => p.code)

  const matrixRows = [
    { key:'properties.list', label:'房源列表', menu:'menu.properties.list.visible', resources:['properties'] },
    { key:'properties.maintenance', label:'房源维修', menu:'menu.properties.maintenance.visible', resources:['property_maintenance'] },
    { key:'finance.expenses', label:'房源支出', menu:'menu.finance.expenses.visible', resources:['property_expenses'] },
    { key:'finance.recurring', label:'固定支出', menu:'menu.finance.recurring.visible', resources:['recurring_payments'] },
    { key:'finance.orders', label:'订单管理', menu:'menu.finance.orders.visible', resources:['order'] },
    { key:'finance.invoices', label:'发票中心', menu:'menu.finance.invoices.visible', resources:[] },
    { key:'finance.company_overview', label:'财务总览', menu:'menu.finance.company_overview.visible', resources:['finance_transactions','order','properties','property_expenses'] },
    { key:'finance.company_revenue', label:'公司营收', menu:'menu.finance.company_revenue.visible', resources:['company_incomes','company_expenses'] },
    { key:'landlords', label:'房东管理', menu:'menu.landlords.visible', resources:['landlords'] },
    { key:'cleaning', label:'清洁安排', menu:'menu.cleaning.visible', resources:['cleaning_tasks'] },
    { key:'cms', label:'CMS管理', menu:'menu.cms.visible', resources:['cms_pages'] },
  ]
  function has(code: string) { return selectedPerms.includes(code) }
  function toggle(code: string, checked: boolean) {
    setSelectedPerms(prev => checked ? Array.from(new Set([...prev, code])) : prev.filter(c => c !== code))
  }
  function isMenu(code: string) { return code.startsWith('menu.') }
  function isFeature(code: string) { return !isMenu(code) && !/\.(view|write|delete)$/.test(code) }
  function ensureVisibleWhenAction(menuCode: string) {
    setSelectedPerms(prev => (prev.includes(menuCode) ? prev : [...prev, menuCode]))
  }

  useEffect(() => {
    if (!open || !current?.id) return
    const key = `rbac:rolePermDraft:${current.id}`
    const dirty = JSON.stringify(selectedPerms.slice().sort()) !== JSON.stringify(savedSnapshot.slice().sort())
    try {
      window.localStorage.setItem(key, JSON.stringify({ roleId: current.id, perms: selectedPerms, dirty, updatedAt: Date.now() }))
    } catch {}
  }, [open, current?.id, selectedPerms, savedSnapshot])

  const matrixGroups: { key: string; title: string; rows: any[] }[] = (() => {
    const groupBy: Record<string, any[]> = {}
    matrixRows.forEach((row) => {
      const parent = String(row.menu).split('.').slice(0, 2).join('.')
      groupBy[parent] = groupBy[parent] || []
      groupBy[parent].push(row)
    })
    const titleByCode: Record<string, string> = {}
    perms.forEach((p) => { if (p.code) titleByCode[p.code] = String(p.meta?.displayName || p.name || p.code) })
    return Object.keys(groupBy).map((k) => ({ key: k, title: titleByCode[k] || k, rows: groupBy[k] }))
  })()

  const matrixColumns: any[] = [
    { title: '子菜单', dataIndex: 'label', width: 240, render: (v: any) => <Typography.Text strong>{v}</Typography.Text> },
    { title: '可见', dataIndex: 'visible', align: 'center', width: 110, render: (_: any, row: any) => <Checkbox checked={has(row.menu)} onChange={(e) => toggle(row.menu, e.target.checked)} /> },
    {
      title: '查看',
      dataIndex: 'view',
      align: 'center',
      width: 110,
      render: (_: any, row: any) => (
        <Checkbox
          checked={row.resources.every((res: string) => has(`${res}.view`))}
          onChange={(e) => {
            const checked = e.target.checked
            ensureVisibleWhenAction(row.menu)
            row.resources.forEach((res: string) => toggle(`${res}.view`, checked))
          }}
        />
      ),
    },
    {
      title: '编辑',
      dataIndex: 'write',
      align: 'center',
      width: 110,
      render: (_: any, row: any) => (
        <Checkbox
          checked={row.resources.every((res: string) => has(`${res}.write`))}
          onChange={(e) => {
            const checked = e.target.checked
            ensureVisibleWhenAction(row.menu)
            row.resources.forEach((res: string) => toggle(`${res}.write`, checked))
          }}
        />
      ),
    },
    {
      title: '删除',
      dataIndex: 'delete',
      align: 'center',
      width: 110,
      render: (_: any, row: any) => (
        <Checkbox
          checked={row.resources.every((res: string) => has(`${res}.delete`))}
          onChange={(e) => {
            const checked = e.target.checked
            ensureVisibleWhenAction(row.menu)
            row.resources.forEach((res: string) => toggle(`${res}.delete`, checked))
          }}
        />
      ),
    },
    {
      title: '归档',
      dataIndex: 'archive',
      align: 'center',
      width: 110,
      render: (_: any, row: any) => (
        <Checkbox
          checked={row.resources.every((res: string) => has(`${res}.archive`))}
          onChange={(e) => {
            const checked = e.target.checked
            ensureVisibleWhenAction(row.menu)
            row.resources.forEach((res: string) => toggle(`${res}.archive`, checked))
          }}
        />
      ),
    },
  ]

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
        <Card size="small" title="菜单显示（仅影响入口可见性）">
          <Table
            size="small"
            rowKey={(r) => (r as any).code}
            dataSource={menuRows as any}
            tableLayout="fixed"
            scroll={{ x: 980 }}
            pagination={{ pageSize: 20, showSizeChanger: true }}
            rowSelection={{
              selectedRowKeys: selectedPerms.filter((c) => menuCodes.includes(c)),
              onChange: (keys) => groupUpdate(menuCodes, keys as string[]),
            }}
            expandable={{
              expandedRowRender: (record) => renderPermDetail(record as any),
              rowExpandable: (record) => !!(record as any).meta,
            }}
            columns={permColumns}
          />
        </Card>
        <Divider />
        <div style={{ display: 'grid', gap: 12 }}>
          {matrixGroups.map((g) => (
            <div key={g.key}>
              <Typography.Text strong style={{ display: 'block', margin: '4px 0 8px' }}>{g.title}</Typography.Text>
              <Card size="small" styles={{ body: { padding: 0 } }}>
                <Table
                  size="middle"
                  rowKey={(r) => (r as any).key}
                  dataSource={g.rows as any}
                  pagination={false}
                  tableLayout="fixed"
                  columns={matrixColumns}
                />
              </Card>
            </div>
          ))}
        </div>
        <Divider />
        <Card size="small" title="数据权限（资源操作）">
          <Table
            size="small"
            rowKey={(r) => (r as any).code}
            dataSource={resourceRows as any}
            tableLayout="fixed"
            scroll={{ x: 980 }}
            pagination={{ pageSize: 20, showSizeChanger: true }}
            rowSelection={{
              selectedRowKeys: selectedPerms.filter((c) => resourceCodes.includes(c)),
              onChange: (keys) => groupUpdate(resourceCodes, keys as string[]),
            }}
            expandable={{
              expandedRowRender: (record) => renderPermDetail(record as any),
              rowExpandable: (record) => !!(record as any).meta,
            }}
            columns={permColumns}
          />
        </Card>
        <Divider />
        <Card size="small" title="功能权限（系统能力）">
          <Table
            size="small"
            rowKey={(r) => (r as any).code}
            dataSource={featureRows as any}
            tableLayout="fixed"
            scroll={{ x: 980 }}
            pagination={{ pageSize: 20, showSizeChanger: true }}
            rowSelection={{
              selectedRowKeys: selectedPerms.filter((c) => featureCodes.includes(c)),
              onChange: (keys) => groupUpdate(featureCodes, keys as string[]),
            }}
            expandable={{
              expandedRowRender: (record) => renderPermDetail(record as any),
              rowExpandable: (record) => !!(record as any).meta,
            }}
            columns={permColumns}
          />
        </Card>
        <Space style={{ marginTop: 12 }}>
          <Button type="primary" onClick={save}>保存</Button>
          <Button onClick={() => setOpen(false)}>取消</Button>
        </Space>
      </Drawer>
      <Modal open={userOpen} onCancel={() => setUserOpen(false)} onOk={submitUser} title="新建用户">
        <Form form={userForm} layout="vertical">
          <Form.Item name="username" label="用户名" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="email" label="邮箱" rules={[{ required: true, type: 'email' }]}><Input /></Form.Item>
          <Form.Item name="role" label="角色" rules={[{ required: true }]}><Select options={roles.map(r => ({ value: r.name, label: r.name }))} /></Form.Item>
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
          <Form.Item name="role" label="角色" rules={[{ required: true }]}><Select options={roles.map(r => ({ value: r.name, label: r.name }))} /></Form.Item>
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
