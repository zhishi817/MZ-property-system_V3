"use client"
import { Card, Table, Drawer, Space, Button, Select, message, Form, Input, Modal } from 'antd'
import { useEffect, useState } from 'react'
import { API_BASE } from '../../lib/api'
import { hasPerm } from '../../lib/auth'

type Role = { id: string; name: string }
type Permission = { code: string; name?: string }
type User = { id: string; email: string; username?: string; role: string }

export default function RBACPage() {
  const [roles, setRoles] = useState<Role[]>([])
  const [perms, setPerms] = useState<Permission[]>([])
  const [open, setOpen] = useState(false)
  const [current, setCurrent] = useState<Role | null>(null)
  const [selectedPerms, setSelectedPerms] = useState<string[]>([])
  const [users, setUsers] = useState<User[]>([])
  const [userOpen, setUserOpen] = useState(false)
  const [editingUser, setEditingUser] = useState<User | null>(null)
  const [userForm] = Form.useForm()

  async function load() {
    const r = await fetch(`${API_BASE}/rbac/roles`).then(r => r.json())
    const p = await fetch(`${API_BASE}/rbac/permissions`).then(r => r.json())
    setRoles(r); setPerms(p)
    try {
      const uRes = await fetch(`${API_BASE}/rbac/users`, { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } })
      const u = uRes.ok ? await uRes.json() : []
      setUsers(Array.isArray(u) ? u : [])
    } catch { setUsers([]) }
  }
  useEffect(() => { load() }, [])

  async function edit(role: Role) {
    setCurrent(role)
    setOpen(true)
    const rp = await fetch(`${API_BASE}/rbac/role-permissions?role_id=${role.id}`).then(r => r.json())
    setSelectedPerms(rp.map((x: any) => x.permission_code))
  }

  async function save() {
    const res = await fetch(`${API_BASE}/rbac/role-permissions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` }, body: JSON.stringify({ role_id: current?.id, permissions: selectedPerms }) })
    if (res.ok) { message.success('已保存'); setOpen(false) } else { message.error('保存失败') }
  }

  const columns = [
    { title: '角色', dataIndex: 'name' },
    { title: '操作', render: (_: any, r: Role) => (<Space>{hasPerm('rbac.manage') && <Button onClick={() => edit(r)}>配置权限</Button>}</Space>) },
  ]

  function openCreateUser() { setEditingUser(null); setUserOpen(true); userForm.resetFields() }
  function openEditUser(u: User) { setEditingUser(u); setUserOpen(true); userForm.setFieldsValue({ email: u.email, username: u.username, role: u.role }) }
  async function submitUser() {
    const v = await userForm.validateFields()
    const payload = { email: v.email, username: v.username, role: v.role, password: v.password }
    const url = editingUser ? `${API_BASE}/rbac/users/${editingUser.id}` : `${API_BASE}/rbac/users`
    const method = editingUser ? 'PATCH' : 'POST'
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` }, body: JSON.stringify(payload) })
    if (res.ok) { message.success(editingUser ? '用户已更新' : '用户已创建'); setUserOpen(false); load() }
    else { try { const err = await res.json(); message.error(err?.message || '保存失败') } catch { message.error('保存失败') } }
  }
  async function deleteUser(u: User) {
    Modal.confirm({ title: `确认删除用户 ${u.email}?`, okType: 'danger', onOk: async () => {
      const res = await fetch(`${API_BASE}/rbac/users/${u.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } })
      if (res.ok) { message.success('用户已删除'); load() }
      else { try { const err = await res.json(); message.error(err?.message || '删除失败') } catch { message.error('删除失败') } }
    } })
  }

  const userCols = [
    { title: '邮箱', dataIndex: 'email' },
    { title: '用户名', dataIndex: 'username' },
    { title: '角色', dataIndex: 'role' },
    { title: '操作', render: (_: any, r: User) => hasPerm('rbac.manage') ? (<Space><Button onClick={() => openEditUser(r)}>编辑</Button><Button danger onClick={() => deleteUser(r)}>删除</Button></Space>) : null },
  ]

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Card title="角色权限">
        <Table rowKey={(r) => r.id} columns={columns as any} dataSource={roles} pagination={false} />
        <Drawer open={open} onClose={() => setOpen(false)} title={`配置权限：${current?.name}`}>
          <Select mode="multiple" style={{ width: '100%' }} value={selectedPerms} onChange={setSelectedPerms} options={perms.map(p => ({ value: p.code, label: p.code }))} />
          <Space style={{ marginTop: 12 }}>
            <Button type="primary" onClick={save}>保存</Button>
            <Button onClick={() => setOpen(false)}>取消</Button>
          </Space>
        </Drawer>
      </Card>
      <Card title="系统用户" extra={hasPerm('rbac.manage') ? <Button type="primary" onClick={openCreateUser}>新增用户</Button> : null}>
        <Table rowKey={(r) => r.id} columns={userCols as any} dataSource={users} pagination={{ pageSize: 10 }} />
        <Drawer open={userOpen} onClose={() => setUserOpen(false)} title={editingUser ? `编辑用户：${editingUser.email}` : '新增用户'}>
          <Form form={userForm} layout="vertical">
            <Form.Item name="email" label="邮箱" rules={[{ required: true }, { type: 'email' }]}><Input /></Form.Item>
            <Form.Item name="username" label="用户名"><Input /></Form.Item>
            <Form.Item name="role" label="角色" rules={[{ required: true }]}><Select options={roles.map(r => ({ value: r.name, label: r.name }))} /></Form.Item>
            <Form.Item name="password" label="密码" help={editingUser ? '留空则不修改密码' : undefined}><Input.Password /></Form.Item>
          </Form>
          <Space style={{ marginTop: 12 }}>
            <Button type="primary" onClick={submitUser}>{editingUser ? '保存' : '创建'}</Button>
            <Button onClick={() => setUserOpen(false)}>取消</Button>
          </Space>
        </Drawer>
      </Card>
    </Space>
  )
}