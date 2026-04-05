"use client"
import { ArrowLeftOutlined } from '@ant-design/icons'
import { Card, Space, Button, Tag, Table, Modal, Form, InputNumber, message, Descriptions, Divider, Input } from 'antd'
import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { API_BASE, authHeaders, getJSON, patchJSON, postJSON } from '../../../../lib/api'
import html2canvas from 'html2canvas'
import jsPDF from 'jspdf'

type Po = {
  id: string
  po_no?: string | null
  supplier_id: string
  warehouse_id: string
  status: string
  ordered_date?: string | null
  requested_delivery_date?: string | null
  note?: string | null
  created_at: string
  supplier_name: string
  warehouse_name: string
  warehouse_code: string
}
type Line = { id: string; item_id: string; item_name: string; item_sku: string; quantity: number; unit: string; unit_price?: number | null; amount_total?: number | null; note?: string | null }
type Delivery = { id: string; received_at: string; received_by?: string | null; note?: string | null }

export default function PurchaseOrderDetailPage({ params }: any) {
  const id = String(params?.id || '')
  const [po, setPo] = useState<Po | null>(null)
  const [lines, setLines] = useState<Line[]>([])
  const [deliveries, setDeliveries] = useState<Delivery[]>([])
  const [open, setOpen] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [exportingPdf, setExportingPdf] = useState(false)
  const [ordering, setOrdering] = useState(false)
  const [form] = Form.useForm()

  async function load() {
    const data = await getJSON<any>(`/inventory/purchase-orders/${id}`)
    setPo(data?.po || null)
    setLines(data?.lines || [])
    setDeliveries(data?.deliveries || [])
  }

  useEffect(() => { load().catch((e) => message.error(e?.message || '加载失败')) }, [id])

  const fmtMoney = (value: any) => {
    const num = Number(value || 0)
    return `$${num.toFixed(2)}`
  }

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
    a.download = `${String(po?.po_no || id)}.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  async function downloadPdf() {
    const root = document.getElementById('purchase-order-pdf-root')
    if (!root) throw new Error('未找到可导出的 PDF 预览内容')
    setExportingPdf(true)
    try {
      const canvas = await html2canvas(root, { scale: 2, backgroundColor: '#ffffff' })
      const img = canvas.toDataURL('image/png')
      const pdf = new jsPDF('p', 'mm', 'a4')
      const pageWidth = pdf.internal.pageSize.getWidth()
      const pageHeight = pdf.internal.pageSize.getHeight()
      const widthScale = pageWidth / canvas.width
      const heightScale = pageHeight / canvas.height
      const scale = Math.min(widthScale, heightScale)
      const imgWidth = canvas.width * scale
      const imgHeight = canvas.height * scale
      const x = (pageWidth - imgWidth) / 2
      const y = (pageHeight - imgHeight) / 2
      pdf.addImage(img, 'PNG', x, y, imgWidth, imgHeight)
      pdf.save(`${String(po?.po_no || id)}.pdf`)
    } finally {
      setExportingPdf(false)
    }
  }

  async function markOrdered() {
    if (!po) return
    setOrdering(true)
    try {
      await patchJSON(`/inventory/purchase-orders/${id}`, {
        status: 'ordered',
        ordered_date: po.ordered_date || new Date().toISOString().slice(0, 10),
      })
      message.success('采购单已下单')
      await load()
    } finally {
      setOrdering(false)
    }
  }

  async function archivePo() {
    await patchJSON(`/inventory/purchase-orders/${id}`, { status: 'closed' })
    message.success('采购单已归档')
    await load()
  }

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
    { title: '床品类型', dataIndex: 'item_name', render: (_: any, r: Line) => <Space><span>{r.item_name}</span><Tag>{r.item_sku}</Tag></Space> },
    { title: '数量', dataIndex: 'quantity', width: 100 },
    { title: '单位', dataIndex: 'unit', width: 100 },
    { title: '单价', dataIndex: 'unit_price', width: 120, render: (v: any) => v == null ? '-' : fmtMoney(v) },
    { title: '金额', dataIndex: 'amount_total', width: 140, render: (_: any, r: Line) => fmtMoney(r.amount_total ?? (Number(r.unit_price || 0) * Number(r.quantity || 0))) },
    { title: '备注', dataIndex: 'note' },
  ]

  const totalAmount = useMemo(
    () => (lines || []).reduce((sum, line) => sum + Number(line.amount_total ?? (Number(line.unit_price || 0) * Number(line.quantity || 0))), 0),
    [lines],
  )

  return (
    <>
      <Card
        title={<Space><span>采购单详情</span>{po ? statusTag(po.status) : null}</Space>}
        extra={
          <Space>
            <Link href="/inventory/category/linen/purchase-orders" prefetch={false}><Button icon={<ArrowLeftOutlined />}>返回列表</Button></Link>
            <Button onClick={() => exportCsv().catch((e) => message.error(e?.message || '导出失败'))}>导出CSV</Button>
            <Button onClick={() => setPreviewOpen(true)}>预览并下载PDF</Button>
            {po?.status === 'draft' ? <Button type="primary" loading={ordering} onClick={() => markOrdered().catch((e) => message.error(e?.message || '下单失败'))}>下单</Button> : null}
            {po?.status !== 'closed' ? <Button danger onClick={() => archivePo().catch((e) => message.error(e?.message || '归档失败'))}>归档</Button> : null}
          </Space>
        }
      >
        {po ? (
          <div style={{ display: 'grid', gap: 18 }}>
            <Descriptions bordered column={2} labelStyle={{ width: 120 }}>
              <Descriptions.Item label="采购单号">{po.po_no || po.id}</Descriptions.Item>
              <Descriptions.Item label="状态">{statusTag(po.status)}</Descriptions.Item>
              <Descriptions.Item label="供应商">{po.supplier_name}</Descriptions.Item>
              <Descriptions.Item label="收货仓库">{po.warehouse_code} - {po.warehouse_name}</Descriptions.Item>
              <Descriptions.Item label="下单日期">{po.ordered_date || '-'}</Descriptions.Item>
              <Descriptions.Item label="送货日期">{po.requested_delivery_date || '-'}</Descriptions.Item>
            </Descriptions>

            {po.note ? (
              <div>
                <div style={{ fontWeight: 600, marginBottom: 8 }}>备注</div>
                <div style={{ padding: 12, border: '1px solid #f0f0f0', borderRadius: 8, background: '#fafafa', whiteSpace: 'pre-wrap' }}>{po.note}</div>
              </div>
            ) : null}

            <Divider style={{ margin: '4px 0' }}>床品明细</Divider>
            <Table
              rowKey={(r) => r.id}
              columns={columns}
              dataSource={lines}
              pagination={false}
              summary={() => (
                <Table.Summary.Row>
                  <Table.Summary.Cell index={0} colSpan={4}>
                    <div style={{ textAlign: 'right', fontWeight: 700 }}>总金额</div>
                  </Table.Summary.Cell>
                  <Table.Summary.Cell index={1}>
                    <div style={{ fontWeight: 700 }}>{fmtMoney(totalAmount)}</div>
                  </Table.Summary.Cell>
                  <Table.Summary.Cell index={2}></Table.Summary.Cell>
                </Table.Summary.Row>
              )}
            />

            <Divider style={{ margin: '4px 0' }}>到货记录</Divider>
            <Table
              rowKey={(r) => r.id}
              columns={[
                { title: '到货时间', dataIndex: 'received_at' },
                { title: '收货人', dataIndex: 'received_by' },
                { title: '备注', dataIndex: 'note' },
              ]}
              dataSource={deliveries}
              pagination={false}
              locale={{ emptyText: '暂无到货记录' }}
            />
          </div>
        ) : null}
      </Card>

      <Modal open={open} title="登记到货并入库" onCancel={() => setOpen(false)} onOk={() => submitDelivery().catch((e) => message.error(e?.message || '登记失败'))}>
        <Form form={form} layout="vertical" initialValues={{ lines: [] }}>
          <Form.List name="lines" rules={[{ validator: async (_: any, v: any[]) => { if (!v || v.length < 1) throw new Error('至少一条明细') } }]}>
            {(fields, { add, remove }) => (
              <>
                {fields.map((f) => (
                  <Space key={f.key} align="baseline" style={{ display: 'flex', marginBottom: 8 }} wrap>
                    <Form.Item {...f} name={[f.name, 'item_id']} label="床品类型" rules={[{ required: true }]} style={{ minWidth: 320 }}>
                      <Input />
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

      <Modal
        open={previewOpen}
        onCancel={() => setPreviewOpen(false)}
        width={1160}
        footer={[
          <Button key="close" onClick={() => setPreviewOpen(false)}>关闭</Button>,
          <Button key="download" type="primary" loading={exportingPdf} onClick={() => downloadPdf().catch((e) => message.error(e?.message || '导出 PDF 失败'))}>下载PDF</Button>,
        ]}
        title="采购单 PDF 预览"
      >
        {po ? (
          <div style={{ display: 'flex', justifyContent: 'center', background: '#eef2f7', padding: 12 }}>
            <div
              id="purchase-order-pdf-root"
              style={{
                width: 860,
                maxWidth: '100%',
                minHeight: 1216,
                background: '#fff',
                padding: '34px 34px 30px',
                boxSizing: 'border-box',
                display: 'flex',
                flexDirection: 'column',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 24 }}>
                <div>
                  <img src="/mz-logo.png" alt="MZ Logo" style={{ height: 64, width: 'auto', objectFit: 'contain' }} />
                  <div style={{ marginTop: 10, fontSize: 15, color: '#4b5563' }}>MZ Property linen purchasing document</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ color: '#64748b', fontSize: 14, fontWeight: 600 }}>采购订单号</div>
                  <div style={{ marginTop: 10, display: 'inline-block', padding: '10px 18px', borderRadius: 999, border: '1px solid #bfdbfe', background: '#eff6ff', fontSize: 20, fontWeight: 700, color: '#1d4ed8' }}>
                    {po.po_no || po.id}
                  </div>
                </div>
              </div>

              <div style={{ marginTop: 16, borderTop: '4px solid #16385f' }}></div>

              <div style={{ textAlign: 'center', marginTop: 24 }}>
                <div style={{ fontSize: 36, fontWeight: 800, letterSpacing: 1, color: '#16385f' }}>LINEN PURCHASE ORDER</div>
                <div style={{ marginTop: 8, color: '#64748b', fontSize: 16 }}>正式采购凭证 / 床品供应协同单</div>
              </div>

              <div style={{ marginTop: 22, paddingTop: 18, borderTop: '1px dashed #cbd5e1' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 22 }}>
                  <div style={{ border: '1px solid #dbe4f0', borderRadius: 20, padding: 24, background: '#f8fbff' }}>
                    <div style={{ fontSize: 16, fontWeight: 800, color: '#16385f', marginBottom: 16 }}>供应信息</div>
                    <div style={{ display: 'grid', gap: 14, fontSize: 15 }}>
                      <div><span style={{ color: '#64748b', display: 'inline-block', width: 88 }}>供应商:</span><strong>{po.supplier_name}</strong></div>
                      <div><span style={{ color: '#64748b', display: 'inline-block', width: 88 }}>订单状态:</span>{statusTag(po.status)}</div>
                      <div><span style={{ color: '#64748b', display: 'inline-block', width: 88 }}>备注说明:</span>{po.note || '按清单配送，数量以实际收货为准'}</div>
                    </div>
                  </div>
                  <div style={{ border: '1px solid #dbe4f0', borderRadius: 20, padding: 24, background: '#f8fbff' }}>
                    <div style={{ fontSize: 16, fontWeight: 800, color: '#16385f', marginBottom: 16 }}>日期与仓库</div>
                    <div style={{ display: 'grid', gap: 14, fontSize: 15 }}>
                      <div><span style={{ color: '#64748b', display: 'inline-block', width: 96 }}>下单日期:</span><strong>{po.ordered_date || '-'}</strong></div>
                      <div><span style={{ color: '#64748b', display: 'inline-block', width: 96 }}>送货日期:</span><strong>{po.requested_delivery_date || '-'}</strong></div>
                      <div><span style={{ color: '#64748b', display: 'inline-block', width: 96 }}>收货仓库:</span><strong>{po.warehouse_code} - {po.warehouse_name}</strong></div>
                    </div>
                  </div>
                </div>
              </div>

              <div style={{ marginTop: 24 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 15 }}>
                  <thead>
                    <tr style={{ background: '#16385f', color: '#fff' }}>
                      <th style={{ padding: '14px 16px', textAlign: 'left' }}>床品类型 / 编码</th>
                      <th style={{ padding: '14px 16px', textAlign: 'center', width: 90 }}>数量</th>
                      <th style={{ padding: '14px 16px', textAlign: 'center', width: 90 }}>单位</th>
                      <th style={{ padding: '14px 16px', textAlign: 'right', width: 120 }}>单价 (AUD)</th>
                      <th style={{ padding: '14px 16px', textAlign: 'right', width: 140 }}>金额 (AUD)</th>
                      <th style={{ padding: '14px 16px', textAlign: 'left', width: 140 }}>备注</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((line, idx) => (
                      <tr key={line.id} style={{ background: idx % 2 === 0 ? '#ffffff' : '#f8fafc' }}>
                        <td style={{ padding: '14px 16px', border: '1px solid #dbe4f0' }}>
                          <div style={{ fontWeight: 600 }}>{line.item_name}</div>
                          <div style={{ color: '#64748b', fontSize: 13 }}>{line.item_sku}</div>
                        </td>
                        <td style={{ padding: '14px 16px', textAlign: 'center', border: '1px solid #dbe4f0' }}>{line.quantity}</td>
                        <td style={{ padding: '14px 16px', textAlign: 'center', border: '1px solid #dbe4f0' }}>{line.unit}</td>
                        <td style={{ padding: '14px 16px', textAlign: 'right', border: '1px solid #dbe4f0' }}>{fmtMoney(line.unit_price)}</td>
                        <td style={{ padding: '14px 16px', textAlign: 'right', border: '1px solid #dbe4f0', color: '#166534', fontWeight: 700 }}>
                          {fmtMoney(line.amount_total ?? (Number(line.unit_price || 0) * Number(line.quantity || 0)))}
                        </td>
                        <td style={{ padding: '14px 16px', border: '1px solid #dbe4f0' }}>{line.note || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div style={{ marginTop: 22, border: '1px solid #dbeafe', borderRadius: 18, padding: '16px 22px', background: '#f8fbff', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 24 }}>
                <div style={{ fontSize: 18, fontWeight: 700, color: '#16385f' }}>订单总额</div>
                <div style={{ padding: '10px 18px', borderRadius: 999, background: '#ecfdf5', color: '#166534', fontSize: 22, fontWeight: 800 }}>
                  {fmtMoney(totalAmount)} AUD
                </div>
              </div>

              <div style={{ marginTop: 'auto', paddingTop: 18, borderTop: '1px solid #e2e8f0', display: 'flex', justifyContent: 'space-between', gap: 16, color: '#64748b', fontSize: 14 }}>
                <div>结算币种: Australian Dollar (AUD)</div>
                <div>订单跟踪号: {po.po_no || po.id}</div>
              </div>
            </div>
          </div>
        ) : null}
      </Modal>
    </>
  )
}
