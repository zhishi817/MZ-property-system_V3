"use client"
import { Card, Table, Space, Button, Modal, Form, Input, InputNumber, Select, Switch, Tag, message } from 'antd'
import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { getJSON, patchJSON, postJSON } from '../../../lib/api'
import { hasPerm } from '../../../lib/auth'

type ItemRow = {
  id: string
  name: string
  sku: string
  category: 'linen' | 'consumable' | 'daily'
  unit: string
  default_threshold: number
  bin_location?: string | null
  active: boolean
  is_key_item: boolean
}

export default function InventoryItemsPage() {
  const [items, setItems] = useState<ItemRow[]>([])
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<ItemRow | null>(null)
  const [form] = Form.useForm()

  const canManage = hasPerm('inventory.item.manage')

  async function load() {
    const rows = await getJSON<ItemRow[]>('/inventory/items')
    setItems(rows || [])
  }
  useEffect(() => { load().catch((e) => message.error(e?.message || '加载失败')) }, [])

  const categoryOptions = useMemo(() => ([
    { value: 'linen', label: '床品' },
    { value: 'consumable', label: '消耗品' },
    { value: 'daily', label: '日用品' },
  ]), [])

  async function submit() {
    const v = await form.validateFields()
    if (editing) {
      await patchJSON(`/inventory/items/${editing.id}`, v)
      message.success('已更新')
    } else {
      await postJSON('/inventory/items', v)
      message.success('已创建')
    }
    setOpen(false)
    setEditing(null)
    form.resetFields()
    await load()
  }

  const columns: any[] = [
    { title: '名称', dataIndex: 'name' },
    { title: 'SKU', dataIndex: 'sku' },
    { title: '分类', dataIndex: 'category', render: (v: string) => v === 'linen' ? <Tag color="blue">床品</Tag> : v === 'daily' ? <Tag color="purple">日用品</Tag> : <Tag>消耗品</Tag> },
    { title: '单位', dataIndex: 'unit' },
    { title: '默认阈值', dataIndex: 'default_threshold' },
    { title: '仓位', dataIndex: 'bin_location' },
    { title: '关键SKU', dataIndex: 'is_key_item', render: (v: boolean) => v ? <Tag color="green">是</Tag> : '-' },
    { title: '状态', dataIndex: 'active', render: (v: boolean) => v ? <Tag color="green">启用</Tag> : <Tag>停用</Tag> },
    canManage ? { title: '操作', dataIndex: '_op', render: (_: any, r: ItemRow) => <Button onClick={() => { setEditing(r); setOpen(true); form.setFieldsValue(r) }}>编辑</Button> } : null,
  ].filter(Boolean)

  return (
    <Card
      title="物料主数据"
      extra={
        <Space>
          <Link href="/inventory/stocks" prefetch={false}><Button type="link">库存</Button></Link>
          <Link href="/inventory/movements" prefetch={false}><Button type="link">流水</Button></Link>
          <Link href="/inventory/purchase-orders" prefetch={false}><Button type="link">采购单</Button></Link>
          <Link href="/inventory/items" prefetch={false}><Button type="link">物料</Button></Link>
          {canManage ? <Button type="primary" onClick={() => { setEditing(null); setOpen(true); form.resetFields(); form.setFieldsValue({ category: 'consumable', active: true, default_threshold: 0, is_key_item: false }) }}>新建物料</Button> : null}
        </Space>
      }
    >
      <Table rowKey={(r) => r.id} columns={columns} dataSource={items} pagination={{ pageSize: 20 }} />

      <Modal open={open} title={editing ? '编辑物料' : '新建物料'} onCancel={() => setOpen(false)} onOk={submit} okButtonProps={{ disabled: !canManage }}>
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="名称" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="sku" label="SKU" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="category" label="分类" rules={[{ required: true }]}><Select options={categoryOptions} /></Form.Item>
          <Form.Item name="unit" label="单位" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="default_threshold" label="默认阈值" rules={[{ required: true }]}><InputNumber min={0} style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="bin_location" label="默认仓位"><Input /></Form.Item>
          <Form.Item name="is_key_item" label="关键SKU" valuePropName="checked"><Switch /></Form.Item>
          <Form.Item name="active" label="启用" valuePropName="checked"><Switch /></Form.Item>
        </Form>
      </Modal>
    </Card>
  )
}

