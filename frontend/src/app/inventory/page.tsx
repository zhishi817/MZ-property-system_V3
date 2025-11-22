"use client"
import { Table, Card, Tag, Space, Button, Modal, Form, Input, InputNumber, Select, message } from 'antd'
import { useEffect, useState } from 'react'
import { API_BASE } from '../../lib/api'
import { hasPerm } from '../../lib/auth'

type Item = { id: string; name: string; sku: string; unit: string; threshold: number; bin_location?: string; quantity: number }

export default function InventoryPage() {
  const [items, setItems] = useState<Item[]>([])
  const [warnings, setWarnings] = useState<Item[]>([])
  const [moveOpen, setMoveOpen] = useState(false)
  const [newOpen, setNewOpen] = useState(false)
  const [form] = Form.useForm()
  const [newForm] = Form.useForm()

  async function load() {
    const list = await fetch(`${API_BASE}/inventory/items`).then(r => r.json())
    const warn = await fetch(`${API_BASE}/inventory/warnings`).then(r => r.json())
    setItems(list); setWarnings(warn)
  }
  useEffect(() => { load() }, [])

  async function submitMove() {
    const v = await form.validateFields()
    const res = await fetch(`${API_BASE}/inventory/movements`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` }, body: JSON.stringify(v) })
    if (res.ok) { message.success('已出入库'); setMoveOpen(false); form.resetFields(); load() } else { message.error('操作失败') }
  }

  async function submitNew() {
    const v = await newForm.validateFields()
    const res = await fetch(`${API_BASE}/inventory/items`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` }, body: JSON.stringify(v) })
    if (res.ok) { message.success('物料已创建'); setNewOpen(false); newForm.resetFields(); load() } else { message.error('创建失败') }
  }

  const columns = [
    { title: '名称', dataIndex: 'name' },
    { title: 'SKU', dataIndex: 'sku' },
    { title: '单位', dataIndex: 'unit' },
    { title: '库存', dataIndex: 'quantity', render: (_: any, r: Item) => r.quantity < r.threshold ? <Space><Tag color="red">低库存</Tag><span>{r.quantity}</span></Space> : r.quantity },
    { title: '阈值', dataIndex: 'threshold' },
    { title: '仓位', dataIndex: 'bin_location' },
  ]

  return (
    <Card title="仓库库存" extra={hasPerm('inventory.move') ? <Space><Button onClick={() => setNewOpen(true)}>新建物料</Button><Button type="primary" onClick={() => setMoveOpen(true)}>出入库</Button></Space> : null}>
      <Table rowKey={(r) => r.id} columns={columns as any} dataSource={items} pagination={{ pageSize: 10 }} />
      {warnings.length > 0 && <div style={{ marginTop: 12 }}><Tag color="red">低库存提醒</Tag> {warnings.map(w => w.name).join('，')}</div>}
      <Modal open={moveOpen} onCancel={() => setMoveOpen(false)} onOk={submitMove} title="出入库">
        <Form form={form} layout="vertical">
          <Form.Item name="item_id" label="物料" rules={[{ required: true }]}>
            <Select options={items.map(i => ({ value: i.id, label: `${i.name}(${i.sku})` }))} />
          </Form.Item>
          <Form.Item name="type" label="类型" rules={[{ required: true }]}>
            <Select options={[{ value: 'in', label: '入库' }, { value: 'out', label: '出库' }]} />
          </Form.Item>
          <Form.Item name="quantity" label="数量" rules={[{ required: true }]}>
            <InputNumber min={1} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>
      <Modal open={newOpen} onCancel={() => setNewOpen(false)} onOk={submitNew} title="新建物料">
        <Form form={newForm} layout="vertical">
          <Form.Item name="name" label="名称" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="sku" label="SKU" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="unit" label="单位" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="threshold" label="阈值" rules={[{ required: true }]}><InputNumber min={0} style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="bin_location" label="仓位"><Input /></Form.Item>
          <Form.Item name="quantity" label="初始库存" rules={[{ required: true }]}><InputNumber min={0} style={{ width: '100%' }} /></Form.Item>
        </Form>
      </Modal>
    </Card>
  )
}