"use client"
import { Card, Table, Drawer, Space, Button, Select, message, Modal, Form, Input, InputNumber } from 'antd'
import { useEffect, useState } from 'react'
import { API_BASE, authHeaders } from '../../lib/api'
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
    if (res.ok) { message.success('已保存'); setOpen(false) } else { message.error('保存失败') }
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

  return (
    <Card title="角色权限" extra={hasPerm('rbac.manage') ? <Button onClick={() => setUserOpen(true)}>新建用户</Button> : null}>
      <Table rowKey={(r) => r.id} columns={columns as any} dataSource={roles} pagination={false} />
      <Card title="系统用户" style={{ marginTop: 16 }}>
        <Table rowKey={(r) => (r as any).id} columns={userCols as any} dataSource={users} pagination={{ pageSize: 10 }} />
      </Card>
      <Drawer open={open} onClose={() => setOpen(false)} title={`配置权限：${current?.name}`}>
        <Select mode="multiple" style={{ width: '100%' }} value={selectedPerms} onChange={setSelectedPerms} options={perms.map(p => ({ value: p.code, label: p.code }))} />
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
