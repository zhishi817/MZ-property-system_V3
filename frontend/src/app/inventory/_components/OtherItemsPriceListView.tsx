"use client"

import { Button, Card, Descriptions, Drawer, Form, Input, InputNumber, Modal, Space, Switch, Table, Tag, message } from 'antd'
import { useEffect, useState } from 'react'
import { deleteJSON, getJSON, patchJSON, postJSON } from '../../../lib/api'
import { hasPerm } from '../../../lib/auth'

type PriceRow = {
  id: string
  sku: string
  item_name: string
  unit?: string | null
  default_quantity?: number | null
  cost_unit_price?: number | null
  unit_price?: number | null
  currency?: string | null
  sort_order?: number | null
  is_active?: boolean
}

export default function OtherItemsPriceListView() {
  const canManage = hasPerm('inventory.po.manage')
  const [rows, setRows] = useState<PriceRow[]>([])
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [detailOpen, setDetailOpen] = useState(false)
  const [formOpen, setFormOpen] = useState(false)
  const [detailRow, setDetailRow] = useState<PriceRow | null>(null)
  const [editingRow, setEditingRow] = useState<PriceRow | null>(null)
  const [form] = Form.useForm()

  async function load() {
    setLoading(true)
    try {
      const data = await getJSON<PriceRow[]>('/inventory/other-items-prices')
      setRows(data || [])
    } catch (e: any) {
      message.error(e?.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load().catch(() => {})
  }, [])

  function openCreate() {
    setEditingRow(null)
    form.resetFields()
    form.setFieldsValue({
      unit: 'pcs',
      default_quantity: 1,
      cost_unit_price: 0,
      unit_price: 0,
      is_active: true,
    })
    setFormOpen(true)
  }

  function openEdit(row: PriceRow) {
    setEditingRow(row)
    form.setFieldsValue({
      unit: row.unit || '',
      default_quantity: row.default_quantity ?? 1,
      cost_unit_price: Number(row.cost_unit_price || 0),
      unit_price: Number(row.unit_price || 0),
      is_active: row.is_active !== false,
    })
    setFormOpen(true)
  }

  async function submit() {
    try {
      setSubmitting(true)
      const values = await form.validateFields()
      const payload = {
        item_name: values.item_name ? String(values.item_name).trim() : undefined,
        unit: values.unit ? String(values.unit).trim() : null,
        default_quantity: values.default_quantity != null ? Number(values.default_quantity) : null,
        cost_unit_price: Number(values.cost_unit_price || 0),
        unit_price: Number(values.unit_price || 0),
        is_active: values.is_active !== false,
      }
      if (!editingRow) {
        await postJSON('/inventory/other-items-prices', payload)
        message.success('已新增')
      } else {
        await patchJSON(`/inventory/other-items-prices/${editingRow.id}`, payload)
        message.success('已更新')
      }
      setFormOpen(false)
      setEditingRow(null)
      await load()
    } catch (e: any) {
      message.error(e?.message || '保存失败')
    } finally {
      setSubmitting(false)
    }
  }

  async function remove(row: PriceRow) {
    try {
      await deleteJSON(`/inventory/other-items-prices/${row.id}`)
      message.success('已删除')
      if (detailRow?.id === row.id) {
        setDetailOpen(false)
        setDetailRow(null)
      }
      await load()
    } catch (e: any) {
      message.error(e?.message || '删除失败')
    }
  }

  function confirmRemove(row: PriceRow) {
    Modal.confirm({
      title: '确认删除',
      content: `是否确认删除其他物品：${row.item_name}？`,
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: () => remove(row),
    })
  }

  const columns = [
    { title: '物品名称', dataIndex: 'item_name', width: 240 },
    { title: 'SKU', dataIndex: 'sku', width: 140 },
    { title: '单位', dataIndex: 'unit', width: 100, render: (value: string | null | undefined) => value || '-' },
    { title: '标准数量', dataIndex: 'default_quantity', width: 100, align: 'right' as const, render: (value: number | null | undefined) => value ?? '-' },
    { title: '成本价', dataIndex: 'cost_unit_price', width: 120, align: 'right' as const, render: (value: number) => `$${Number(value || 0).toFixed(2)} AUD` },
    { title: '卖出价', dataIndex: 'unit_price', width: 140, align: 'right' as const, render: (value: number) => `$${Number(value || 0).toFixed(2)} AUD` },
    { title: '状态', dataIndex: 'is_active', width: 100, render: (value: boolean | undefined) => value === false ? <Tag color="default">停用</Tag> : <Tag color="green">启用</Tag> },
    {
      title: '操作',
      width: 240,
      render: (_: any, row: PriceRow) => (
        <Space size={8}>
          <Button onClick={() => { setDetailRow(row); setDetailOpen(true) }}>详情</Button>
          {canManage ? <Button onClick={() => openEdit(row)}>编辑</Button> : null}
          {canManage ? <Button danger onClick={() => confirmRemove(row)}>删除</Button> : null}
        </Space>
      ),
    },
  ]

  return (
    <>
      <Card title="其他物品价格表" extra={canManage ? <Button type="primary" onClick={openCreate}>新增其他物品</Button> : null}>
        <Space style={{ marginBottom: 12 }} wrap>
          <Button onClick={() => load().catch(() => {})}>刷新</Button>
        </Space>
        <Table rowKey={(row) => row.id} loading={loading} columns={columns as any} dataSource={rows} pagination={{ pageSize: 20 }} scroll={{ x: 920 }} />
      </Card>

      <Drawer
        title="其他物品详情"
        placement="right"
        width={720}
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        extra={
          <Space>
            <Button onClick={() => setDetailOpen(false)}>取消</Button>
            <Button type="primary" disabled={!canManage || !detailRow} onClick={() => detailRow && openEdit(detailRow)}>编辑</Button>
          </Space>
        }
      >
        {detailRow ? (
          <Descriptions title="其他物品基础信息" bordered column={2} labelStyle={{ width: '120px' }}>
            <Descriptions.Item label="物品名称">{detailRow.item_name || '-'}</Descriptions.Item>
            <Descriptions.Item label="SKU">{detailRow.sku || '-'}</Descriptions.Item>
            <Descriptions.Item label="单位">{detailRow.unit || '-'}</Descriptions.Item>
            <Descriptions.Item label="标准数量">{detailRow.default_quantity ?? '-'}</Descriptions.Item>
            <Descriptions.Item label="成本价">{`$${Number(detailRow.cost_unit_price || 0).toFixed(2)} AUD`}</Descriptions.Item>
            <Descriptions.Item label="卖出价">{`$${Number(detailRow.unit_price || 0).toFixed(2)} AUD`}</Descriptions.Item>
            <Descriptions.Item label="状态">{detailRow.is_active === false ? '停用' : '启用'}</Descriptions.Item>
          </Descriptions>
        ) : null}
      </Drawer>

      <Drawer
        title={editingRow ? '编辑其他物品' : '新增其他物品'}
        placement="right"
        width={460}
        open={formOpen}
        onClose={() => setFormOpen(false)}
        extra={
          <Space>
            <Button onClick={() => setFormOpen(false)}>取消</Button>
            <Button type="primary" loading={submitting} onClick={() => submit().catch(() => {})}>保存</Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical">
          {editingRow ? <Form.Item label="SKU"><Input value={editingRow.sku} disabled /></Form.Item> : null}
          <Form.Item name="item_name" label="物品名称" rules={[{ required: true, message: '请输入物品名称' }]}>
            <Input disabled={!!editingRow} placeholder="请输入其他物品名称" />
          </Form.Item>
          <Form.Item name="unit" label="单位">
            <Input placeholder="如 件 / 台 / 套" />
          </Form.Item>
          <Form.Item name="default_quantity" label="标准数量">
            <InputNumber min={1} precision={0} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="cost_unit_price" label="成本价" rules={[{ required: true, message: '请输入成本价' }]}>
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="unit_price" label="卖出价" rules={[{ required: true, message: '请输入卖出价' }]}>
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="is_active" label="启用" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Drawer>
    </>
  )
}
