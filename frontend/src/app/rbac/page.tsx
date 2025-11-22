"use client"
import { Card, Table, Drawer, Space, Button, Select, message } from 'antd'
import { useEffect, useState } from 'react'
import { API_BASE } from '../../lib/api'
import { hasPerm } from '../../lib/auth'

type Role = { id: string; name: string }
type Permission = { code: string; name?: string }

export default function RBACPage() {
  const [roles, setRoles] = useState<Role[]>([])
  const [perms, setPerms] = useState<Permission[]>([])
  const [open, setOpen] = useState(false)
  const [current, setCurrent] = useState<Role | null>(null)
  const [selectedPerms, setSelectedPerms] = useState<string[]>([])

  async function load() {
    const r = await fetch(`${API_BASE}/rbac/roles`).then(r => r.json())
    const p = await fetch(`${API_BASE}/rbac/permissions`).then(r => r.json())
    setRoles(r); setPerms(p)
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

  return (
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
  )
}