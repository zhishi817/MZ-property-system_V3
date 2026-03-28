"use client"
import { Card, Space, Button, Tag, Table, Modal, Form, InputNumber, message, Select, Input } from 'antd'
import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { API_BASE, authHeaders, getJSON, patchJSON, postJSON } from '../../../../lib/api'

type Po = {
  id: string
  supplier_id: string
  warehouse_id: string
  status: string
  requested_delivery_date?: string | null
  note?: string | null
  created_at: string
  supplier_name: string
  warehouse_name: string
  warehouse_code: string
}
type Line = { id: string; item_id: string; item_name: string; item_sku: string; quantity: number; unit: string; unit_price?: number | null; note?: string | null }
type Delivery = { id: string; received_at: string; received_by?: string | null; note?: string | null }

export default function PurchaseOrderDetailPage({ params }: any) {
  const id = String(params?.id || '')
  const [po, setPo] = useState<Po | null>(null)
  const [lines, setLines] = useState<Line[]>([])
  const [deliveries, setDeliveries] = useState<Delivery[]>([])
  const [open, setOpen] = useState(false)
  const [form] = Form.useForm()

  async function load() {
    const data = await getJSON<any>(`/inventory/purchase-orders/${id}`)
    setPo(data?.po || null)
    setLines(data?.lines || [])
    setDeliveries(data?.deliveries || [])
  }

  useEffect(() => { load().catch((e) => message.error(e?.message || '加载失败')) }, [id])

  const statusTag = (s: string) => {
    if (s === 'draft') return <Tag>草稿</Tag>
    if (s === 'ordered') return <Tag color="blue">已下单</Tag>
    if (s === 'received') return <Tag color="green">已到货</Tag>
    if (s === 'closed') return <Tag color="default">已关闭</Tag>
    return <Tag>{s}</Tag>
  }

  async function exportCsv() {
    const res = await fetch(`${API_BASE}/inventory/purchase-orders/${id}/export`, { method: 'POST', headers: { ...authHeaders() } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `PO_${id}.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  async function setStatus(status: string) {
    await patchJSON(`/inventory/purchase-orders/${id}`, { status })
    message.success('状态已更新')
    await load()
  }

  const deliveryItems = useMemo(() => (lines || []).map(l => ({ value: l.item_id, label: `${l.item_name} (${l.item_sku})` })), [lines])

  async function submitDelivery() {
    const v = await form.validateFields()
    const payload = {
      note: v.note || undefined,
      lines: (v.lines || []).map((x: any) => ({ item_id: x.item_id, quantity_received: x.quantity_received, note: x.note || undefined })),
    }
    await postJSON(`/inventory/purchase-orders/${id}/deliveries`, payload)
    message.success('到货已登记并入库')
    setOpen(false)
    form.resetFields()
    await load()
  }

  const columns: any[] = [
    { title: '物料', dataIndex: 'item_name', render: (_: any, r: Line) => <Space><span>{r.item_name}</span><Tag>{r.item_sku}</Tag></Space> },
    { title: '数量', dataIndex: 'quantity' },
    { title: '单位', dataIndex: 'unit' },
    { title: '单价', dataIndex: 'unit_price' },
    { title: '备注', dataIndex: 'note' },
  ]

  return (
    <Card
      title={<Space><span>采购单详情</span>{po ? statusTag(po.status) : null}</Space>}
      extra={
        <Space>
          <Link href="/inventory/purchase-orders" prefetch={false}><Button type="link">返回列表</Button></Link>
          <Button onClick={() => exportCsv().catch((e) => message.error(e?.message || '导出失败'))}>导出CSV</Button>
          <Button type="primary" onClick={() => { form.setFieldsValue({ lines: (lines || []).map(l => ({ item_id: l.item_id, quantity_received: l.quantity, note: '' })) }); setOpen(true) }}>登记到货</Button>
          <Select
            value={po?.status as any}
            onChange={(v) => setStatus(v).catch((e) => message.error(e?.message || '更新失败'))}
            style={{ width: 140 }}
            options={[
              { value: 'draft', label: '草稿' },
              { value: 'ordered', label: '已下单' },
              { value: 'received', label: '已到货' },
              { value: 'closed', label: '已关闭' },
            ]}
          />
        </Space>
      }
    >
      {po ? (
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <div>供应商：{po.supplier_name}</div>
          <div>送货仓库：{po.warehouse_code} - {po.warehouse_name}</div>
          {po.requested_delivery_date ? <div>期望送货日期：{po.requested_delivery_date}</div> : null}
          {po.note ? <div>备注：{po.note}</div> : null}
        </Space>
      ) : null}

      <div style={{ marginTop: 12 }}>
        <Table rowKey={(r) => r.id} columns={columns} dataSource={lines} pagination={false} />
      </div>

      {deliveries.length ? (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>到货记录</div>
          <Table
            rowKey={(r) => r.id}
            columns={[
              { title: '到货时间', dataIndex: 'received_at' },
              { title: '收货人', dataIndex: 'received_by' },
              { title: '备注', dataIndex: 'note' },
            ]}
            dataSource={deliveries}
            pagination={false}
          />
        </div>
      ) : null}

      <Modal open={open} title="登记到货并入库" onCancel={() => setOpen(false)} onOk={submitDelivery}>
        <Form form={form} layout="vertical" initialValues={{ lines: [] }}>
          <Form.List name="lines" rules={[{ validator: async (_: any, v: any[]) => { if (!v || v.length < 1) throw new Error('至少一条明细') } }]}>
            {(fields, { add, remove }) => (
              <>
                {fields.map((f) => (
                  <Space key={f.key} align="baseline" style={{ display: 'flex', marginBottom: 8 }} wrap>
                    <Form.Item {...f} name={[f.name, 'item_id']} label="物料" rules={[{ required: true }]} style={{ minWidth: 320 }}>
                      <Select showSearch optionFilterProp="label" options={deliveryItems} />
                    </Form.Item>
                    <Form.Item {...f} name={[f.name, 'quantity_received']} label="到货数量" rules={[{ required: true }]} style={{ width: 140 }}>
                      <InputNumber min={1} style={{ width: '100%' }} />
                    </Form.Item>
                    <Form.Item {...f} name={[f.name, 'note']} label="备注" style={{ minWidth: 200 }}>
                      <Input />
                    </Form.Item>
                    <Button onClick={() => remove(f.name)} danger>删除</Button>
                  </Space>
                ))}
                <Button onClick={() => add({})}>新增到货行</Button>
              </>
            )}
          </Form.List>
          <Form.Item name="note" label="到货备注">
            <Input />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  )
}
