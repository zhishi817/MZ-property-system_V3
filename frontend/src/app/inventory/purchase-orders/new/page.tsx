"use client"
import { Card, Space, Button, Form, Select, Input, InputNumber, DatePicker, message } from 'antd'
import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import dayjs from 'dayjs'
import { getJSON, postJSON } from '../../../../lib/api'

type Warehouse = { id: string; code: string; name: string; active: boolean }
type Supplier = { id: string; name: string; kind: string; active: boolean }
type Item = { id: string; name: string; sku: string; unit: string; category: string; active: boolean }
type PropertyRow = { id: string; code?: string | null; address?: string | null; region?: string | null }

export default function PurchaseOrderNewPage() {
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [items, setItems] = useState<Item[]>([])
  const [properties, setProperties] = useState<PropertyRow[]>([])
  const [form] = Form.useForm()

  async function loadBase() {
    const [ws, ss, its, ps] = await Promise.all([
      getJSON<Warehouse[]>('/inventory/warehouses'),
      getJSON<Supplier[]>('/inventory/suppliers'),
      getJSON<Item[]>('/inventory/items?active=true'),
      getJSON<PropertyRow[]>('/properties'),
    ])
    setWarehouses((ws || []).filter(w => w.active))
    setSuppliers((ss || []).filter(s => s.active))
    setItems((its || []).filter(i => i.active))
    setProperties(ps || [])
    if ((ws || []).length && !form.getFieldValue('warehouse_id')) form.setFieldsValue({ warehouse_id: (ws || [])[0].id })
  }

  useEffect(() => { loadBase().catch((e) => message.error(e?.message || '加载失败')) }, [])

  const whOptions = useMemo(() => (warehouses || []).map(w => ({ value: w.id, label: `${w.code} - ${w.name}` })), [warehouses])
  const supplierOptions = useMemo(() => [{ value: '', label: '自动（按区域规则）' }, ...(suppliers || []).map(s => ({ value: s.id, label: s.name }))], [suppliers])
  const itemOptions = useMemo(() => (items || []).map(i => ({ value: i.id, label: `${i.name} (${i.sku})` })), [items])
  const propertyOptions = useMemo(() => [{ value: '', label: '不关联房源' }, ...(properties || []).map(p => ({ value: p.id, label: `${p.code || ''} ${p.address || ''}`.trim() }))], [properties])

  async function submit() {
    const v = await form.validateFields()
    const payload: any = {
      supplier_id: v.supplier_id || undefined,
      warehouse_id: v.warehouse_id,
      property_id: v.property_id || undefined,
      requested_delivery_date: v.requested_delivery_date ? dayjs(v.requested_delivery_date).format('YYYY-MM-DD') : undefined,
      note: v.note || undefined,
      lines: (v.lines || []).map((x: any) => ({ item_id: x.item_id, quantity: x.quantity, unit_price: x.unit_price || undefined, note: x.note || undefined })),
    }
    const created = await postJSON<any>('/inventory/purchase-orders', payload)
    const id = created?.po?.id || created?.po_id || created?.id || null
    message.success('采购单已创建')
    if (id) window.location.href = `/inventory/purchase-orders/${id}`
  }

  return (
    <Card
      title="新建采购单（PO）"
      extra={
        <Space>
          <Link href="/inventory/purchase-orders" prefetch={false}><Button type="link">返回列表</Button></Link>
        </Space>
      }
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={{ supplier_id: '', property_id: '', lines: [{ quantity: 1 }] }}
      >
        <Space wrap style={{ width: '100%' }}>
          <Form.Item name="warehouse_id" label="送货仓库" rules={[{ required: true }]} style={{ minWidth: 260 }}>
            <Select options={whOptions} />
          </Form.Item>
          <Form.Item name="property_id" label="关联房源（用于自动选供应商）" style={{ minWidth: 320 }}>
            <Select showSearch optionFilterProp="label" options={propertyOptions} />
          </Form.Item>
          <Form.Item name="supplier_id" label="供应商" style={{ minWidth: 260 }}>
            <Select options={supplierOptions} />
          </Form.Item>
          <Form.Item name="requested_delivery_date" label="期望送货日期" style={{ minWidth: 220 }}>
            <DatePicker />
          </Form.Item>
        </Space>

        <Form.Item name="note" label="备注">
          <Input />
        </Form.Item>

        <Form.List name="lines" rules={[{ validator: async (_: any, v: any[]) => { if (!v || v.length < 1) throw new Error('至少一条明细') } }]}>
          {(fields, { add, remove }, { errors }) => (
            <>
              {fields.map((f) => (
                <Space key={f.key} align="baseline" style={{ display: 'flex', marginBottom: 8 }} wrap>
                  <Form.Item {...f} name={[f.name, 'item_id']} label="物料" rules={[{ required: true }]} style={{ minWidth: 340 }}>
                    <Select showSearch optionFilterProp="label" options={itemOptions} />
                  </Form.Item>
                  <Form.Item {...f} name={[f.name, 'quantity']} label="数量" rules={[{ required: true }]} style={{ width: 140 }}>
                    <InputNumber min={1} style={{ width: '100%' }} />
                  </Form.Item>
                  <Form.Item {...f} name={[f.name, 'unit_price']} label="单价" style={{ width: 140 }}>
                    <InputNumber min={0} style={{ width: '100%' }} />
                  </Form.Item>
                  <Form.Item {...f} name={[f.name, 'note']} label="备注" style={{ minWidth: 220 }}>
                    <Input />
                  </Form.Item>
                  <Button onClick={() => remove(f.name)} danger>删除</Button>
                </Space>
              ))}
              <Form.Item>
                <Space>
                  <Button onClick={() => add({ quantity: 1 })}>新增明细</Button>
                  <Button type="primary" onClick={() => submit().catch((e) => message.error(e?.message || '提交失败'))}>创建采购单</Button>
                </Space>
                <div style={{ color: '#ff4d4f' }}>{errors.join(' ')}</div>
              </Form.Item>
            </>
          )}
        </Form.List>
      </Form>
    </Card>
  )
}

