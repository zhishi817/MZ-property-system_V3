"use client"
import { ArrowLeftOutlined } from '@ant-design/icons'
import { Card, Space, Button, Form, Select, Input, InputNumber, DatePicker, message, Divider, Typography, Table } from 'antd'
import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import dayjs from 'dayjs'
import { getJSON, postJSON } from '../../../../lib/api'

type Warehouse = { id: string; code: string; name: string; active: boolean }
type Supplier = { id: string; name: string; kind: string; active: boolean }
type Item = { id: string; name: string; sku: string; unit: string; category: string; active: boolean }
type SupplierPrice = { supplier_id: string; item_id: string; purchase_unit_price: number; refund_unit_price: number }

export default function PurchaseOrderNewPage() {
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [items, setItems] = useState<Item[]>([])
  const [prices, setPrices] = useState<SupplierPrice[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [form] = Form.useForm()

  async function loadSupplierPricesCompat() {
    try {
      return await getJSON<SupplierPrice[]>('/inventory/supplier-item-prices?active=true')
    } catch {
      return await getJSON<SupplierPrice[]>('/crud/supplier_item_prices')
    }
  }

  async function loadBase() {
    const [ws, ss, its, priceRows] = await Promise.all([
      getJSON<Warehouse[]>('/inventory/warehouses'),
      getJSON<Supplier[]>('/inventory/suppliers'),
      getJSON<Item[]>('/inventory/items?active=true&category=linen'),
      loadSupplierPricesCompat(),
    ])
    const activeWarehouses = (ws || []).filter((w) => w.active)
    const activeSuppliers = (ss || []).filter((s) => s.active && s.kind === 'linen')
    const activeItems = (its || []).filter((i) => i.active)
    setWarehouses(activeWarehouses)
    setSuppliers(activeSuppliers)
    setItems(activeItems)
    setPrices(priceRows || [])

    const smWarehouse = activeWarehouses.find((w) => {
      const id = String(w.id || '').trim().toLowerCase()
      const code = String(w.code || '').trim().toLowerCase()
      const name = String(w.name || '').trim().toLowerCase()
      return id === 'wh.south_melbourne' || code === 'sou' || code === 'sm' || name.includes('south melbourne') || name.includes('sm')
    })
    const currentLines = form.getFieldValue('linesByItem') || {}
    const nextLines = activeItems.reduce((acc: Record<string, any>, item) => {
      acc[item.id] = {
        quantity: Number(currentLines?.[item.id]?.quantity || 0),
      }
      return acc
    }, {})
    form.setFieldsValue({
      warehouse_id: form.getFieldValue('warehouse_id') || smWarehouse?.id,
      supplier_id: form.getFieldValue('supplier_id') || undefined,
      linesByItem: nextLines,
    })
  }

  useEffect(() => { loadBase().catch((e) => message.error(e?.message || '加载失败')) }, [])

  const whOptions = useMemo(() => (warehouses || []).map((w) => ({ value: w.id, label: `${w.code} - ${w.name}` })), [warehouses])
  const supplierOptions = useMemo(() => (suppliers || []).map((s) => ({ value: s.id, label: s.name })), [suppliers])

  const priceMap = useMemo(() => {
    const map = new Map<string, number>()
    for (const row of prices || []) map.set(`${row.supplier_id}:${row.item_id}`, Number(row.purchase_unit_price || 0))
    return map
  }, [prices])

  const selectedSupplierId = Form.useWatch('supplier_id', form)
  const watchedLinesByItem = Form.useWatch('linesByItem', form) || {}

  const itemRows = useMemo(() => {
    return (items || []).map((item) => {
      const quantity = Number(watchedLinesByItem?.[item.id]?.quantity || 0)
      const unitPrice = selectedSupplierId ? Number(priceMap.get(`${selectedSupplierId}:${item.id}`) || 0) : 0
      return {
        ...item,
        quantity,
        unitPrice,
        amount: quantity * unitPrice,
      }
    })
  }, [items, watchedLinesByItem, selectedSupplierId, priceMap])

  const totalAmount = useMemo(
    () => itemRows.reduce((sum, row) => sum + Number(row.amount || 0), 0),
    [itemRows],
  )

  async function submit() {
    setSubmitting(true)
    try {
      const v = await form.validateFields()
      const lines = (items || [])
        .map((item) => {
          const quantity = Number(v?.linesByItem?.[item.id]?.quantity || 0)
          const unit_price = v.supplier_id ? Number(priceMap.get(`${v.supplier_id}:${item.id}`) || 0) : undefined
          return quantity > 0 ? { item_id: item.id, quantity, unit_price } : null
        })
        .filter(Boolean)
      if (!lines.length) throw new Error('请至少填写一种床品数量')

      const payload: any = {
        supplier_id: v.supplier_id,
        warehouse_id: v.warehouse_id,
        ordered_date: v.ordered_date ? dayjs(v.ordered_date).format('YYYY-MM-DD') : undefined,
        requested_delivery_date: v.requested_delivery_date ? dayjs(v.requested_delivery_date).format('YYYY-MM-DD') : undefined,
        lines,
        note: v.note || undefined,
      }
      const created = await postJSON<any>('/inventory/purchase-orders', payload)
      const id = created?.po?.id || created?.po_id || created?.id || null
      message.success('采购单已创建')
      if (id) window.location.href = `/inventory/purchase-orders/${id}`
    } finally {
      setSubmitting(false)
    }
  }

  const columns: any[] = [
    { title: '床品类型', dataIndex: 'name', width: 220 },
    { title: 'SKU', dataIndex: 'sku', width: 180, ellipsis: true },
    {
      title: '数量',
      width: 140,
      render: (_: any, row: Item) => (
        <Form.Item name={['linesByItem', row.id, 'quantity']} noStyle>
          <InputNumber min={0} style={{ width: '100%' }} />
        </Form.Item>
      ),
    },
    { title: '单价', width: 120, render: (_: any, row: any) => row.unitPrice ? row.unitPrice.toFixed(2) : '-' },
    { title: '金额', width: 140, render: (_: any, row: any) => row.quantity > 0 ? row.amount.toFixed(2) : '-' },
  ]

  return (
    <Card
      title="新建采购单（PO）"
      extra={
        <Link href="/inventory/category/linen/purchase-orders" prefetch={false}>
          <Button icon={<ArrowLeftOutlined />}>返回列表</Button>
        </Link>
      }
    >
      <Form form={form} layout="vertical">
        <Space wrap style={{ width: '100%' }}>
          <Form.Item name="warehouse_id" label="收货仓库" rules={[{ required: true }]} style={{ minWidth: 260 }}>
            <Select options={whOptions} />
          </Form.Item>
          <Form.Item name="supplier_id" label="供应商" rules={[{ required: true }]} style={{ minWidth: 260 }}>
            <Select options={supplierOptions} />
          </Form.Item>
          <Form.Item name="ordered_date" label="下单日期" style={{ minWidth: 220 }}>
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="requested_delivery_date" label="送货日期" style={{ minWidth: 220 }}>
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
        </Space>

        <Divider orientation="left">床品明细</Divider>
        <Typography.Text type="secondary">所有床品类型固定显示，直接填写需要采购的数量，数量为 0 的行不会进入采购单。</Typography.Text>

        <div style={{ marginTop: 12 }}>
          <Table rowKey={(r) => r.id} columns={columns} dataSource={itemRows} pagination={false} size="middle" tableLayout="fixed" />
        </div>

        <Divider />
        <Typography.Text strong>当前采购金额合计：{totalAmount.toFixed(2)}</Typography.Text>

        <div style={{ marginTop: 16, maxWidth: 520 }}>
          <Form.Item name="note" label="备注">
            <Input />
          </Form.Item>
        </div>

        <Button type="primary" loading={submitting} onClick={() => submit().catch((e) => message.error(e?.message || '提交失败'))}>
          创建采购单
        </Button>
      </Form>
    </Card>
  )
}
