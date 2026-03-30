"use client"
import { Card, Table, Space, Button, Modal, Form, Input, Select, InputNumber, Switch, message, Tag } from 'antd'
import { useEffect, useMemo, useState } from 'react'
import { getJSON, patchJSON, postJSON } from '../../../lib/api'
import { hasPerm } from '../../../lib/auth'

type Supplier = { id: string; name: string; kind: string; active: boolean }
type RuleRow = { id: string; region_key: string; supplier_id: string; supplier_name?: string; priority: number; active: boolean }

export default function InventoryRegionRulesPage() {
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [rows, setRows] = useState<RuleRow[]>([])
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<RuleRow | null>(null)
  const [form] = Form.useForm()
  const canManage = hasPerm('inventory.po.manage')

  async function loadBase() {
    const [ss, rs] = await Promise.all([
      getJSON<Supplier[]>('/inventory/suppliers'),
      getJSON<RuleRow[]>('/inventory/region-supplier-rules'),
    ])
    setSuppliers(ss || [])
    setRows(rs || [])
  }
  useEffect(() => { loadBase().catch((e) => message.error(e?.message || '加载失败')) }, [])

  const supplierOptions = useMemo(() => (suppliers || []).filter(s => s.active).map(s => ({ value: s.id, label: s.name })), [suppliers])

  async function submit() {
    const v = await form.validateFields()
    if (editing) {
      await patchJSON(`/inventory/region-supplier-rules/${editing.id}`, v)
      message.success('已更新')
    } else {
      await postJSON('/inventory/region-supplier-rules', v)
      message.success('已创建')
    }
    setOpen(false)
    setEditing(null)
    form.resetFields()
    await loadBase()
  }

  const columns: any[] = [
    { title: 'Region', dataIndex: 'region_key', render: (v: string) => v === '*' ? <Tag color="gold">*</Tag> : v },
    { title: '供应商', dataIndex: 'supplier_name' },
    { title: '优先级', dataIndex: 'priority' },
    { title: '启用', dataIndex: 'active', render: (v: boolean) => v ? '是' : '否' },
    canManage ? { title: '操作', render: (_: any, r: RuleRow) => (
      <Button onClick={() => { setEditing(r); setOpen(true); form.setFieldsValue({ region_key: r.region_key, supplier_id: r.supplier_id, priority: r.priority, active: r.active }) }}>编辑</Button>
    ) } : null,
  ].filter(Boolean)

  return (
    <Card
      title="供应区域规则"
      extra={canManage ? <Button type="primary" onClick={() => { setEditing(null); setOpen(true); form.resetFields(); form.setFieldsValue({ active: true, priority: 0 }) }}>新增规则</Button> : null}
    >
      <Table rowKey={(r) => r.id} columns={columns} dataSource={rows} pagination={{ pageSize: 20 }} />
      <Modal open={open} title={editing ? '编辑规则' : '新增规则'} onCancel={() => setOpen(false)} onOk={submit} okButtonProps={{ disabled: !canManage }}>
        <Form form={form} layout="vertical">
          <Form.Item name="region_key" label="Region（精确匹配；用 * 作为默认）" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="supplier_id" label="供应商" rules={[{ required: true }]}><Select options={supplierOptions} showSearch optionFilterProp="label" /></Form.Item>
          <Form.Item name="priority" label="优先级（越大越优先）" rules={[{ required: true }]}><InputNumber style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="active" label="启用" valuePropName="checked"><Switch /></Form.Item>
        </Form>
      </Modal>
    </Card>
  )
}

