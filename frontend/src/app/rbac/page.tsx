"use client"
import { Card, Table, Drawer, Space, Button, Select, message, Modal, Form, Input, InputNumber, Checkbox, Divider } from 'antd'
import { useEffect, useState } from 'react'
import { API_BASE, authHeaders } from '../../lib/api'
import { preloadRolePerms } from '../../lib/auth'
import { hasPerm } from '../../lib/auth'

type Role = { id: string; name: string }
type Permission = { code: string; name?: string }
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
    setSelectedPerms(rp.map((x: any) => x.permission_code))
  }

  async function save() {
    const res = await fetch(`${API_BASE}/rbac/role-permissions`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify({ role_id: current?.id, permissions: selectedPerms }) })
    if (res.ok) { message.success('已保存'); setOpen(false); try { await preloadRolePerms() } catch {} } else { message.error('保存失败') }
  }

  async function submitUser() {
    const v = await userForm.validateFields()
    const res = await fetch(`${API_BASE}/rbac/users`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(v) })
    if (res.ok) { message.success('已创建用户'); setUserOpen(false); userForm.resetFields(); load() } else { message.error('创建失败') }
  }

  async function removeUser(id: string) {
    Modal.confirm({ title: '确认删除用户', okType: 'danger', onOk: async () => {
      const res = await fetch(`${API_BASE}/rbac/users/${id}`, { method: 'DELETE', headers: authHeaders() })
      if (res.ok) { message.success('已删除'); load() } else { message.error('删除失败') }
    } })
  }

  const columns = [
    { title: '角色', dataIndex: 'name' },
    { title: '操作', render: (_: any, r: Role) => (<Space>{hasPerm('rbac.manage') && <Button onClick={() => edit(r)}>配置权限</Button>}</Space>) },
  ]

  const userCols = [
    { title: '用户名', dataIndex: 'username' },
    { title: '邮箱', dataIndex: 'email' },
    { title: '角色', dataIndex: 'role' },
    { title: '操作', render: (_: any, r: User) => (<Space><Button danger onClick={() => removeUser(r.id)}>删除</Button></Space>) },
  ]

  const menuPerms = perms.filter(p => p.code.startsWith('menu.') && !/\.visible$/.test(p.code)).map(p => ({ label: p.code, value: p.code }))
  const featurePerms = perms.filter(p => !p.code.startsWith('menu.') && !/\.view$|\.write$|\.delete$/.test(p.code)).map(p => ({ label: p.code, value: p.code }))
  const matrixRows = [
    { key:'properties.list', label:'房源列表', menu:'menu.properties.list.visible', resources:['properties'] },
    { key:'properties.maintenance', label:'房源维修', menu:'menu.properties.maintenance.visible', resources:['property_maintenance'] },
    { key:'finance.expenses', label:'房源支出', menu:'menu.finance.expenses.visible', resources:['property_expenses'] },
    { key:'finance.recurring', label:'固定支出', menu:'menu.finance.recurring.visible', resources:['recurring_payments'] },
    { key:'finance.orders', label:'订单管理', menu:'menu.finance.orders.visible', resources:['orders'] },
    { key:'finance.company_overview', label:'财务总览', menu:'menu.finance.company_overview.visible', resources:['finance_transactions','orders','properties','property_expenses'] },
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
  return (
    <Card title="角色权限" extra={hasPerm('rbac.manage') ? <Button onClick={() => setUserOpen(true)}>新建用户</Button> : null}>
      <Table rowKey={(r) => r.id} columns={columns as any} dataSource={roles} pagination={false} />
      <Card title="系统用户" style={{ marginTop: 16 }}>
        <Table rowKey={(r) => (r as any).id} columns={userCols as any} dataSource={users} pagination={{ pageSize: 10 }} />
      </Card>
      <Drawer open={open} onClose={() => setOpen(false)} title={`配置权限：${current?.name}`}>
        <Card size="small" title="菜单显示">
          <Checkbox.Group value={selectedPerms.filter(isMenu)} onChange={(v)=> setSelectedPerms(prev => [...prev.filter(c => !isMenu(c)), ...(v as string[])])} options={menuPerms} />
        </Card>
        <Divider />
        <Card size="small" title="子菜单矩阵（可见 / 查看 / 编辑 / 删除 / 归档）">
          {(() => {
            const groupBy: Record<string, any[]> = {}
            matrixRows.forEach(row => {
              const parent = String(row.menu).split('.').slice(0,2).join('.')
              groupBy[parent] = groupBy[parent] || []
              groupBy[parent].push(row)
            })
            const parents = Object.keys(groupBy)
            return (
              <div style={{ display:'grid', gap:12 }}>
                {parents.map((parent) => (
                  <Card key={parent} size="small" title={parent}>
                    <Table rowKey={(r)=>r.key} dataSource={groupBy[parent]} pagination={false} columns={[
                      { title:'子菜单', dataIndex:'label' },
                      { title:'可见', dataIndex:'visible', render: (_:any, row:any)=> (
                        <Checkbox checked={has(row.menu)} onChange={(e)=> toggle(row.menu, e.target.checked)} />
                      ) },
                      { title:'查看', dataIndex:'view', render: (_:any, row:any)=> (
                        <Checkbox checked={row.resources.every((res:string)=> has(`${res}.view`))} onChange={(e)=> {
                          const checked = e.target.checked
                          ensureVisibleWhenAction(row.menu)
                          row.resources.forEach((res:string)=> toggle(`${res}.view`, checked))
                        }} />
                      ) },
                      { title:'编辑', dataIndex:'write', render: (_:any, row:any)=> (
                        <Checkbox checked={row.resources.every((res:string)=> has(`${res}.write`))} onChange={(e)=> {
                          const checked = e.target.checked
                          ensureVisibleWhenAction(row.menu)
                          row.resources.forEach((res:string)=> toggle(`${res}.write`, checked))
                        }} />
                      ) },
                      { title:'删除', dataIndex:'delete', render: (_:any, row:any)=> (
                        <Checkbox checked={row.resources.every((res:string)=> has(`${res}.delete`))} onChange={(e)=> {
                          const checked = e.target.checked
                          ensureVisibleWhenAction(row.menu)
                          row.resources.forEach((res:string)=> toggle(`${res}.delete`, checked))
                        }} />
                      ) },
                      { title:'归档', dataIndex:'archive', render: (_:any, row:any)=> (
                        <Checkbox checked={row.resources.every((res:string)=> has(`${res}.archive`))} onChange={(e)=> {
                          const checked = e.target.checked
                          ensureVisibleWhenAction(row.menu)
                          row.resources.forEach((res:string)=> toggle(`${res}.archive`, checked))
                        }} />
                      ) },
                    ] as any} />
                  </Card>
                ))}
              </div>
            )
          })()}
        </Card>
        <Divider />
        <Card size="small" title="功能权限（其他）">
          <Checkbox.Group value={selectedPerms.filter(isFeature)} onChange={(v)=> setSelectedPerms(prev => [...prev.filter(c => !isFeature(c)), ...(v as string[])])} options={featurePerms} />
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
    </Card>
  )
}
