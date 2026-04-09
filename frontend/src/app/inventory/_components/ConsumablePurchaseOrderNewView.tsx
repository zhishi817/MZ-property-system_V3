"use client"

import { ArrowLeftOutlined } from '@ant-design/icons'
import { Button, Card, DatePicker, Empty, Form, Input, InputNumber, Select, Space, Table, Typography, message } from 'antd'
import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import dayjs from 'dayjs'
import { getJSON, postJSON } from '../../../lib/api'

type Warehouse = { id: string; code: string; name: string; active: boolean }
type Supplier = { id: string; name: string; kind: string; active: boolean }
type ConsumableItem = { id: string; sku: string; item_name: string; unit?: string | null; default_quantity?: number | null; cost_unit_price?: number | null; unit_price?: number | null; currency?: string | null; is_active?: boolean; sort_order?: number | null }

export default function ConsumablePurchaseOrderNewView() {
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [items, setItems] = useState<ConsumableItem[]>([])
  const [selectedItemIds, setSelectedItemIds] = useState<string[]>([])
  const [pendingItemIds, setPendingItemIds] = useState<string[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [form] = Form.useForm()

  async function loadBase() {
    const [ws, ss, consumableItems] = await Promise.all([
      getJSON<Warehouse[]>('/inventory/warehouses'),
      getJSON<Supplier[]>('/inventory/suppliers'),
      getJSON<ConsumableItem[]>('/inventory/consumable-items-prices'),
    ])
    const activeWarehouses = (ws || []).filter((row) => row.active)
    const activeSuppliers = (ss || []).filter((row) => row.active && row.kind === 'consumable')
    const activeItems = (consumableItems || []).filter((row) => row.is_active !== false)
    setWarehouses(activeWarehouses)
    setSuppliers(activeSuppliers)
    setItems(activeItems)
    const smWarehouse = activeWarehouses.find((w) => ['wh.south_melbourne', 'sm', 'sou'].includes(String(w.id || '').toLowerCase()) || String(w.name || '').toLowerCase().includes('south melbourne') || String(w.code || '').toLowerCase() === 'sm')
    const currentLines = form.getFieldValue('linesByItem') || {}
    const nextLines = activeItems.reduce((acc: Record<string, any>, item) => {
      acc[item.id] = { quantity: Number(currentLines?.[item.id]?.quantity || 0) }
      return acc
    }, {})
    form.setFieldsValue({ warehouse_id: form.getFieldValue('warehouse_id') || smWarehouse?.id, supplier_id: form.getFieldValue('supplier_id') || undefined, linesByItem: nextLines })
  }

  useEffect(() => { loadBase().catch((e) => message.error(e?.message || '加载失败')) }, [])

  const whOptions = useMemo(() => warehouses.map((row) => ({ value: row.id, label: `${row.code} - ${row.name}` })), [warehouses])
  const supplierOptions = useMemo(() => suppliers.map((row) => ({ value: row.id, label: row.name })), [suppliers])
  const watchedLinesByItem = Form.useWatch('linesByItem', form) || {}
  const addItemOptions = useMemo(() => items.filter((item) => !selectedItemIds.includes(item.id)).map((item) => ({ value: item.id, label: `${item.item_name} (${item.sku})` })), [items, selectedItemIds])
  const itemRows = useMemo(() => items.filter((item) => selectedItemIds.includes(item.id)).map((item) => {
    const quantity = Number(watchedLinesByItem?.[item.id]?.quantity || 0)
    const unitPrice = Number(item.cost_unit_price || 0)
    return { ...item, key: item.id, quantity, unitPrice, amount: quantity * unitPrice }
  }), [items, selectedItemIds, watchedLinesByItem])
  const totalAmount = useMemo(() => itemRows.reduce((sum, row) => sum + Number(row.amount || 0), 0), [itemRows])
  const gstAmount = useMemo(() => Number((totalAmount * 0.1).toFixed(2)), [totalAmount])
  const totalAmountInclGst = useMemo(() => Number((totalAmount + gstAmount).toFixed(2)), [totalAmount, gstAmount])

  async function submit() {
    setSubmitting(true)
    try {
      const values = await form.validateFields()
      const lines = items.map((item) => {
        const quantity = Number(values?.linesByItem?.[item.id]?.quantity || 0)
        if (!(quantity > 0)) return null
        return { item_id: `item.consumable_price.${item.id}`, quantity, unit: item.unit || 'pcs', unit_price: Number(item.cost_unit_price || 0) }
      }).filter(Boolean)
      if (!lines.length) throw new Error('请至少填写一种消耗品数量')
      const result = await postJSON<any>('/inventory/purchase-orders', { supplier_id: values.supplier_id, warehouse_id: values.warehouse_id, ordered_date: values.ordered_date ? dayjs(values.ordered_date).format('YYYY-MM-DD') : undefined, note: values.note || undefined, lines })
      message.success('消耗品采购单已创建')
      const poId = String(result?.po?.id || '')
      if (poId && typeof window !== 'undefined') window.location.href = `/inventory/purchase-orders/${poId}?category=consumable`
    } catch (e: any) {
      message.error(e?.message || '创建失败')
    } finally {
      setSubmitting(false)
    }
  }

  function addItem() {
    if (!pendingItemIds.length) return message.warning('请先选择一个或多个消耗品')
    setSelectedItemIds((current) => Array.from(new Set([...current, ...pendingItemIds])))
    const currentLines = form.getFieldValue('linesByItem') || {}
    for (const itemId of pendingItemIds) {
      if (!currentLines?.[itemId]) form.setFieldValue(['linesByItem', itemId, 'quantity'], 1)
    }
    setPendingItemIds([])
  }
  function removeItem(itemId: string) {
    setSelectedItemIds((current) => current.filter((id) => id !== itemId))
    form.setFieldValue(['linesByItem', itemId, 'quantity'], 0)
  }

  const columns = [
    { title: '消耗品', width: 240, render: (_: any, row: any) => <div><div style={{ fontWeight: 500 }}>{row.item_name}</div><div style={{ color: '#8c8c8c', fontSize: 12 }}>{row.sku}</div></div> },
    { title: '单位', dataIndex: 'unit', width: 90, render: (value: string | null | undefined) => value || '-' },
    { title: '采购价', dataIndex: 'unitPrice', width: 120, align: 'right' as const, render: (value: number) => `$${Number(value || 0).toFixed(2)}` },
    { title: '采购数量', width: 140, render: (_: any, row: any) => <Form.Item name={['linesByItem', row.id, 'quantity']} style={{ marginBottom: 0 }}><InputNumber min={1} precision={0} style={{ width: '100%' }} /></Form.Item> },
    { title: '金额', dataIndex: 'amount', width: 120, align: 'right' as const, render: (value: number) => `$${Number(value || 0).toFixed(2)}` },
    { title: '操作', width: 100, render: (_: any, row: any) => <Button danger onClick={() => removeItem(String(row.id))}>删除</Button> },
  ]

  return (
    <Card title="新建消耗品采购单" extra={<Space><Link href="/inventory/category/consumable/purchase-orders" prefetch={false}><Button icon={<ArrowLeftOutlined />}>返回采购记录</Button></Link><Button type="primary" loading={submitting} onClick={() => submit().catch(() => {})}>保存采购单</Button></Space>}>
      <Form form={form} layout="vertical">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(180px, 1fr))', gap: 16, marginBottom: 20 }}>
          <Form.Item name="supplier_id" label="供应商" rules={[{ required: true, message: '请选择供应商' }]}><Select options={supplierOptions} placeholder="请选择消耗品供应商" /></Form.Item>
          <Form.Item name="warehouse_id" label="送货仓库" rules={[{ required: true, message: '请选择仓库' }]}><Select options={whOptions} placeholder="请选择仓库" /></Form.Item>
          <Form.Item name="ordered_date" label="下单日期"><DatePicker style={{ width: '100%' }} /></Form.Item>
        </div>

        <div style={{ padding: 16, border: '1px solid #f0f0f0', borderRadius: 12, background: '#fafafa', marginBottom: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 12, alignItems: 'start' }}>
            <div>
              <div style={{ marginBottom: 8, fontWeight: 500 }}>采购物品</div>
              <Select mode="multiple" showSearch value={pendingItemIds} onChange={(value) => setPendingItemIds((value || []).map((item) => String(item)))} options={addItemOptions} placeholder="输入消耗品名称或 SKU 搜索，可多选" optionFilterProp="label" optionLabelProp="label" style={{ width: '100%' }} notFoundContent="没有可添加的消耗品" />
              <div style={{ marginTop: 6, color: '#8c8c8c', fontSize: 12 }}>输入关键字后可多选消耗品，再点“添加物品”统一加入采购单</div>
            </div>
            <div><div style={{ marginBottom: 8, fontWeight: 500, visibility: 'hidden' }}>操作</div><Button type="primary" onClick={addItem}>添加物品</Button></div>
          </div>
        </div>

        {itemRows.length ? <Table rowKey="id" columns={columns as any} dataSource={itemRows} pagination={false} scroll={{ x: 920 }} /> : <div style={{ border: '1px dashed #d9d9d9', borderRadius: 12, padding: 32, background: '#fff' }}><Empty description="输入并选择消耗品后，再添加到采购单" /></div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}><Space direction="vertical" size={4} style={{ minWidth: 220 }}><Typography.Text>未税金额：${totalAmount.toFixed(2)}</Typography.Text><Typography.Text>GST：${gstAmount.toFixed(2)}</Typography.Text><Typography.Text strong>含税总额：${totalAmountInclGst.toFixed(2)}</Typography.Text></Space></div>
        <Form.Item name="note" label="备注" style={{ marginTop: 24 }}><Input.TextArea rows={3} placeholder="可选" /></Form.Item>
      </Form>
    </Card>
  )
}
