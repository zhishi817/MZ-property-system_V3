"use client"
import { Card, Table, Space, Button, Modal, Form, Input, Select, Switch, Tag, message } from 'antd'
import { useEffect, useMemo, useState } from 'react'
import { getJSON, patchJSON, postJSON } from '../../../lib/api'
import { hasPerm } from '../../../lib/auth'

type Supplier = { id: string; name: string; kind: string; active: boolean }

export default function InventorySuppliersPage() {
  const [rows, setRows] = useState<Supplier[]>([])
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<Supplier | null>(null)
  const [form] = Form.useForm()
  const canManage = hasPerm('inventory.po.manage')

  const kindOptions = useMemo(() => ([
    { value: 'linen', label: '床品' },
    { value: 'daily', label: '日用品' },
    { value: 'consumable', label: '消耗品' },
    { value: 'other', label: '其他' },
  ]), [])

  async function load() {
    const data = await getJSON<Supplier[]>('/inventory/suppliers')
    setRows(data || [])
  }

  useEffect(() => { load().catch((e) => message.error(e?.message || '加载失败')) }, [])

  async function submit() {
    const v = await form.validateFields()
    if (editing) {
      await patchJSON(`/inventory/suppliers/${editing.id}`, v)
      message.success('已更新')
    } else {
      await postJSON('/inventory/suppliers', v)
      message.success('已创建')
    }
    setOpen(false)
    setEditing(null)
    form.resetFields()
    await load()
  }

  const kindTag = (k: string) => {
    if (k === 'linen') return <Tag color="blue">床品</Tag>
    if (k === 'daily') return <Tag color="purple">日用品</Tag>
    if (k === 'consumable') return <Tag color="green">消耗品</Tag>
    return <Tag>{k || '其他'}</Tag>
  }

  const columns: any[] = [
    { title: '名称', dataIndex: 'name' },
    { title: '类型', dataIndex: 'kind', render: (v: string) => kindTag(v) },
    { title: '启用', dataIndex: 'active', render: (v: boolean) => v ? '是' : '否' },
    canManage ? { title: '操作', render: (_: any, r: Supplier) => (
      <Button onClick={() => { setEditing(r); setOpen(true); form.setFieldsValue({ name: r.name, kind: r.kind, active: r.active }) }}>编辑</Button>
    ) } : null,
  ].filter(Boolean)

  return (
    <Card
      title="供应商列表"
      extra={canManage ? <Button type="primary" onClick={() => { setEditing(null); setOpen(true); form.resetFields(); form.setFieldsValue({ kind: 'linen', active: true }) }}>新增供应商</Button> : null}
    >
      <Table rowKey={(r) => r.id} columns={columns} dataSource={rows} pagination={{ pageSize: 20 }} />
      <Modal open={open} title={editing ? '编辑供应商' : '新增供应商'} onCancel={() => setOpen(false)} onOk={submit} okButtonProps={{ disabled: !canManage }}>
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="名称" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="kind" label="类型" rules={[{ required: true }]}><Select options={kindOptions} /></Form.Item>
          <Form.Item name="active" label="启用" valuePropName="checked"><Switch /></Form.Item>
        </Form>
      </Modal>
    </Card>
  )
}

