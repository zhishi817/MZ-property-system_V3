"use client"
import { Card, Table, Space, Button, Modal, Form, Input, Switch, message } from 'antd'
import { useEffect, useState } from 'react'
import { getJSON, patchJSON, postJSON } from '../../../lib/api'
import { hasPerm } from '../../../lib/auth'

type Warehouse = { id: string; code: string; name: string; active: boolean }

export default function InventoryWarehousesPage() {
  const [rows, setRows] = useState<Warehouse[]>([])
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<Warehouse | null>(null)
  const [form] = Form.useForm()
  const canManage = hasPerm('inventory.item.manage')

  async function load() {
    const data = await getJSON<Warehouse[]>('/inventory/warehouses')
    setRows(data || [])
  }

  useEffect(() => { load().catch((e) => message.error(e?.message || '加载失败')) }, [])

  async function submit() {
    const v = await form.validateFields()
    if (editing) {
      await patchJSON(`/inventory/warehouses/${editing.id}`, v)
      message.success('已更新')
    } else {
      await postJSON('/inventory/warehouses', v)
      message.success('已创建')
    }
    setOpen(false)
    setEditing(null)
    form.resetFields()
    await load()
  }

  const columns: any[] = [
    { title: 'Code', dataIndex: 'code' },
    { title: '名称', dataIndex: 'name' },
    { title: '启用', dataIndex: 'active', render: (v: boolean) => v ? '是' : '否' },
    canManage ? { title: '操作', render: (_: any, r: Warehouse) => (
      <Space>
        <Button onClick={() => { setEditing(r); setOpen(true); form.setFieldsValue({ code: r.code, name: r.name, active: r.active }) }}>编辑</Button>
      </Space>
    ) } : null,
  ].filter(Boolean)

  return (
    <Card
      title="仓库管理"
      extra={canManage ? <Button type="primary" onClick={() => { setEditing(null); setOpen(true); form.resetFields(); form.setFieldsValue({ active: true }) }}>新增仓库</Button> : null}
    >
      <Table rowKey={(r) => r.id} columns={columns} dataSource={rows} pagination={{ pageSize: 20 }} />
      <Modal open={open} title={editing ? '编辑仓库' : '新增仓库'} onCancel={() => setOpen(false)} onOk={submit} okButtonProps={{ disabled: !canManage }}>
        <Form form={form} layout="vertical">
          <Form.Item name="code" label="Code" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="name" label="名称" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="active" label="启用" valuePropName="checked"><Switch /></Form.Item>
        </Form>
      </Modal>
    </Card>
  )
}

