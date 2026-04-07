"use client"
import { ArrowLeftOutlined } from '@ant-design/icons'
import { Card, Space, Button, Tag, Table, Modal, Form, InputNumber, message, Descriptions, Divider, Input, DatePicker, Select } from 'antd'
import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { API_BASE, authHeaders, getJSON, patchJSON, postJSON } from '../../../../lib/api'
import html2canvas from 'html2canvas'
import jsPDF from 'jspdf'
import dayjs from 'dayjs'

type Po = {
  id: string
  po_no?: string | null
  supplier_id: string
  warehouse_id: string
  status: string
  ordered_date?: string | null
  requested_delivery_date?: string | null
  note?: string | null
  subtotal_amount?: number | null
  gst_amount?: number | null
  total_amount_inc_gst?: number | null
  created_at: string
  supplier_name: string
  warehouse_name: string
  warehouse_code: string
}
type Line = { id: string; item_id: string; item_name: string; item_sku: string; quantity: number; unit: string; unit_price?: number | null; amount_total?: number | null; note?: string | null }
type Delivery = { id: string; received_at: string; received_by?: string | null; note?: string | null }
type Supplier = { id: string; name: string; kind: string; active: boolean }
type Warehouse = { id: string; code: string; name: string; active: boolean }
type LinenTypeMeta = { code: string; name: string; psl_code?: string | null; sort_order?: number | null; active: boolean; item_id?: string | null }
type SupplierPrice = { supplier_id: string; item_id: string; linen_type_code?: string | null; purchase_unit_price: number }
const PDF_PAGE_WIDTH = 794
const PDF_PAGE_HEIGHT = 1123

function normalizeLinenDisplayKey(value?: string | null) {
  return String(value || '').trim().toLowerCase().replace(/^lt:/, '')
}

function displayLinenEnglish(value?: string | null, fallback?: string | null) {
  const key = normalizeLinenDisplayKey(value)
  const map: Record<string, string> = {
    bath_mat: 'Bath mat',
    hand_towel: 'Hand towel',
    tea_towel: 'Tea towel',
    bath_towel: 'Bath towel',
    bedsheet: 'Queen sheet',
    duvet_cover: 'Doona cover',
    pillowcase: 'Pillowcase',
  }
  return map[key] || String(fallback || value || '').replace(/^LT:/i, '').trim() || '-'
}

function getPslLineMeta(value?: string | null, fallback?: string | null, pslCode?: string | null) {
  const normalized = [value, fallback]
    .map((item) => String(item || '').trim().toLowerCase())
    .map((item) => item.replace(/^lt:/, ''))
    .map((item) => item.replace(/[\s_-]+/g, ''))
    .filter(Boolean)
  const match = (needles: string[]) => normalized.some((candidate) => needles.some((needle) => candidate.includes(needle)))

  if (match(['trolleyliner', '推车liner', '推车內胆', '推车内胆'])) return { code: String(pslCode || '0005'), description: 'TROLLEY LINER' }
  if (match(['trolley', '推车'])) return { code: String(pslCode || '0010'), description: 'TROLLEY' }
  if (match(['redlaundrybag', '红色洗衣袋'])) return { code: String(pslCode || '0045'), description: 'RED LAUNDRY BAG' }
  if (match(['orangebag', '橘色袋子', '橙色袋子'])) return { code: String(pslCode || '0065'), description: 'ORANGE BAG' }
  if (match(['bathtowel', '浴巾'])) return { code: String(pslCode || '3400'), description: 'BATH TOWEL STD' }
  if (match(['handtowel', '手巾', '手巾'])) return { code: String(pslCode || '3200'), description: 'HAND TOWEL STD' }
  if (match(['pillowcase', 'pillowslip', '枕套'])) return { code: String(pslCode || '2600'), description: 'PILLOW SLIP' }
  if (match(['bathmat', '地巾'])) return { code: String(pslCode || '3300'), description: 'BATH MAT STD' }
  if (match(['teatowel', '茶巾'])) return { code: String(pslCode || '8800'), description: 'RED DOBBY TEA TOWEL' }
  if (match(['duvetcover', 'doonacover', '被套'])) return { code: String(pslCode || '5250'), description: 'DOONA COVER QUEEN 1CM STRIPE' }
  if (match(['bedsheet', 'queensheet', '床单'])) return { code: String(pslCode || '2300'), description: 'QUEEN SHEET LONG' }

  return { code: String(pslCode || ''), description: displayLinenEnglish(value, fallback).toUpperCase() }
}

function getWeekdayLabel(value?: string | null) {
  if (!value) return ''
  const parsed = dayjs(value)
  if (!parsed.isValid()) return ''
  return parsed.format('ddd').toUpperCase()
}

function isExcludedForEwashLine(value?: string | null, fallback?: string | null) {
  const checks = [
    normalizeLinenDisplayKey(value),
    normalizeLinenDisplayKey(fallback),
    String(fallback || '').trim().toLowerCase().replace(/[\s_-]+/g, ''),
    String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, ''),
    String(fallback || '').trim(),
    String(value || '').trim(),
  ]
  return checks.some((candidate) =>
    [
      '红色洗衣袋',
      '橘色袋子',
      '推车',
      '推车liner',
      'trolley',
      'trolleyliner',
      'redlaundrybag',
      'orangebag',
      'cartliner',
    ].some((needle) => String(candidate).includes(needle)),
  )
}

function sortLinesByLinenTypeOrder<T extends { item_sku?: string | null; item_name?: string | null }>(
  rows: T[],
  linenTypes: LinenTypeMeta[],
) {
  const orderMap = new Map<string, number>()
  for (const [idx, row] of (linenTypes || []).entries()) {
    const key = normalizeLinenDisplayKey(row.code)
    if (!key) continue
    orderMap.set(key, Number.isFinite(Number(row.sort_order)) ? Number(row.sort_order) : idx)
  }
  return (rows || []).slice().sort((a, b) => {
    const orderA = orderMap.get(normalizeLinenDisplayKey(a.item_sku || a.item_name)) ?? 9999
    const orderB = orderMap.get(normalizeLinenDisplayKey(b.item_sku || b.item_name)) ?? 9999
    if (orderA !== orderB) return orderA - orderB
    return String(a.item_name || a.item_sku || '').localeCompare(String(b.item_name || b.item_sku || ''), 'zh')
  })
}

export default function PurchaseOrderDetailPage({ params }: any) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const id = String(params?.id || '')
  const [po, setPo] = useState<Po | null>(null)
  const [lines, setLines] = useState<Line[]>([])
  const [deliveries, setDeliveries] = useState<Delivery[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [linenTypes, setLinenTypes] = useState<LinenTypeMeta[]>([])
  const [supplierPrices, setSupplierPrices] = useState<SupplierPrice[]>([])
  const [editing, setEditing] = useState(false)
  const [open, setOpen] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [exportingPdf, setExportingPdf] = useState(false)
  const [ordering, setOrdering] = useState(false)
  const [savingEdit, setSavingEdit] = useState(false)
  const [deliveryForm] = Form.useForm()
  const [editForm] = Form.useForm()

  async function loadBase() {
    const [ws, ss, lt, sp] = await Promise.all([
      getJSON<Warehouse[]>('/inventory/warehouses'),
      getJSON<Supplier[]>('/inventory/suppliers'),
      getJSON<LinenTypeMeta[]>('/inventory/linen-types'),
      getJSON<SupplierPrice[]>('/inventory/supplier-item-prices?active=true').catch(() => []),
    ])
    setWarehouses(ws || [])
    setSuppliers(ss || [])
    setLinenTypes(lt || [])
    setSupplierPrices(sp || [])
  }

  async function load() {
    const data = await getJSON<any>(`/inventory/purchase-orders/${id}`)
    setPo(data?.po || null)
    setLines(data?.lines || [])
    setDeliveries(data?.deliveries || [])
  }

  useEffect(() => {
    Promise.all([loadBase(), load()]).catch((e) => message.error(e?.message || '加载失败'))
  }, [id])

  useEffect(() => {
    if (searchParams.get('edit') === '1' && po && po.status !== 'received' && po.status !== 'closed') setEditing(true)
    if ((po?.status === 'received' || po?.status === 'closed') && editing) setEditing(false)
  }, [searchParams, po, editing])

  const supplierPriceMap = useMemo(() => {
    const map = new Map<string, number>()
    for (const row of supplierPrices || []) {
      const supplierId = String(row.supplier_id || '')
      const itemId = String(row.item_id || '')
      const code = normalizeLinenDisplayKey(row.linen_type_code)
      const itemCode = normalizeLinenDisplayKey(itemId.split('item.linen_type.').pop())
      const price = Number(row.purchase_unit_price || 0)
      if (supplierId && itemId) map.set(`${supplierId}:item:${itemId}`, price)
      if (supplierId && code) map.set(`${supplierId}:code:${code}`, price)
      if (supplierId && itemCode) map.set(`${supplierId}:code:${itemCode}`, price)
    }
    return map
  }, [supplierPrices])

  function resolveSupplierUnitPrice(supplierId: string | undefined, line: Line) {
    if (!supplierId) return null
    const itemId = String(line.item_id || '').trim()
    if (itemId) {
      const hit = supplierPriceMap.get(`${supplierId}:item:${itemId}`)
      if (hit != null) return Number(hit)
    }
    const candidates = [
      normalizeLinenDisplayKey(line.item_sku),
      normalizeLinenDisplayKey(line.item_name),
      normalizeLinenDisplayKey(itemId.split('item.linen_type.').pop()),
    ].filter(Boolean)
    for (const code of candidates) {
      const hit = supplierPriceMap.get(`${supplierId}:code:${code}`)
      if (hit != null) return Number(hit)
    }
    return null
  }

  useEffect(() => {
    if (!po) return
    const sorted = sortLinesByLinenTypeOrder(lines, linenTypes)
    editForm.setFieldsValue({
      supplier_id: po.supplier_id,
      warehouse_id: po.warehouse_id,
      ordered_date: po.ordered_date ? dayjs(po.ordered_date) : null,
      requested_delivery_date: po.requested_delivery_date ? dayjs(po.requested_delivery_date) : null,
      note: po.note || '',
      lines: sorted.map((line) => ({
        id: line.id,
        item_id: line.item_id,
        item_name: line.item_name,
        item_sku: line.item_sku,
        quantity: Number(line.quantity || 0),
        note: line.note || '',
        unit_price: line.unit_price == null ? resolveSupplierUnitPrice(po.supplier_id, line) : Number(line.unit_price),
      })),
    })
  }, [po, lines, linenTypes, editForm, supplierPriceMap])

  const watchedEditSupplierId = Form.useWatch('supplier_id', editForm)

  useEffect(() => {
    if (!editing || !po || !watchedEditSupplierId) return
    const currentLines = editForm.getFieldValue('lines') || []
    const nextLines = currentLines.map((line: any, idx: number) => {
      const fallbackLine = lines[idx]
      const resolved = resolveSupplierUnitPrice(watchedEditSupplierId, {
        id: String(line?.id || fallbackLine?.id || ''),
        item_id: String(line?.item_id || fallbackLine?.item_id || ''),
        item_name: String(line?.item_name || fallbackLine?.item_name || ''),
        item_sku: String(line?.item_sku || fallbackLine?.item_sku || ''),
        quantity: Number(line?.quantity || fallbackLine?.quantity || 0),
        unit: String(fallbackLine?.unit || 'pcs'),
        unit_price: line?.unit_price,
        amount_total: fallbackLine?.amount_total,
        note: line?.note || fallbackLine?.note || '',
      })
      return {
        ...line,
        unit_price: resolved == null ? (line?.unit_price ?? null) : resolved,
      }
    })
    editForm.setFieldValue('lines', nextLines)
  }, [editing, po, watchedEditSupplierId, supplierPriceMap, lines, editForm])

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
    let cloneWrap: HTMLDivElement | null = null
    try {
      cloneWrap = document.createElement('div')
      cloneWrap.style.position = 'fixed'
      cloneWrap.style.left = '-10000px'
      cloneWrap.style.top = '0'
      cloneWrap.style.width = `${PDF_PAGE_WIDTH}px`
      cloneWrap.style.height = `${PDF_PAGE_HEIGHT}px`
      cloneWrap.style.background = '#ffffff'
      cloneWrap.style.overflow = 'hidden'
      cloneWrap.style.zIndex = '-1'

      const clone = root.cloneNode(true) as HTMLElement
      clone.style.width = `${PDF_PAGE_WIDTH}px`
      clone.style.maxWidth = `${PDF_PAGE_WIDTH}px`
      clone.style.height = `${PDF_PAGE_HEIGHT}px`
      clone.style.minHeight = `${PDF_PAGE_HEIGHT}px`
      clone.style.transform = 'none'
      clone.style.margin = '0'

      cloneWrap.appendChild(clone)
      document.body.appendChild(cloneWrap)

      const canvas = await html2canvas(clone, {
        scale: 2,
        backgroundColor: '#ffffff',
        useCORS: true,
        width: PDF_PAGE_WIDTH,
        height: PDF_PAGE_HEIGHT,
        windowWidth: PDF_PAGE_WIDTH,
        windowHeight: PDF_PAGE_HEIGHT,
      })
      document.body.removeChild(cloneWrap)
      cloneWrap = null
      const img = canvas.toDataURL('image/png')
      const pdf = new jsPDF('p', 'mm', 'a4')
      const pageWidth = pdf.internal.pageSize.getWidth()
      const pageHeight = pdf.internal.pageSize.getHeight()
      pdf.addImage(img, 'PNG', 0, 0, pageWidth, pageHeight)
      pdf.save(`${String(po?.po_no || id)}.pdf`)
    } finally {
      if (cloneWrap?.parentNode) cloneWrap.parentNode.removeChild(cloneWrap)
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
    const v = await deliveryForm.validateFields()
    const payload = {
      note: v.note || undefined,
      lines: (v.lines || []).map((x: any) => ({ item_id: x.item_id, quantity_received: x.quantity_received, note: x.note || undefined })),
    }
    await postJSON(`/inventory/purchase-orders/${id}/deliveries`, payload)
    message.success('到货已登记并入库')
    setOpen(false)
    deliveryForm.resetFields()
    await load()
  }

  async function submitEdit(markAsOrdered = false) {
    if (!po) return
    setSavingEdit(true)
    try {
      const values = await editForm.validateFields()
      await patchJSON(`/inventory/purchase-orders/${id}`, {
        supplier_id: values.supplier_id,
        warehouse_id: values.warehouse_id,
        status: markAsOrdered ? 'ordered' : undefined,
        ordered_date: values.ordered_date ? dayjs(values.ordered_date).format('YYYY-MM-DD') : undefined,
        requested_delivery_date: values.requested_delivery_date ? dayjs(values.requested_delivery_date).format('YYYY-MM-DD') : undefined,
        note: values.note || '',
        lines: (values.lines || []).map((line: any) => ({
          id: line.id,
          quantity: Number(line.quantity || 0),
          note: line.note || '',
          unit_price: line.unit_price == null || line.unit_price === '' ? null : Number(line.unit_price),
        })),
      })
      message.success(markAsOrdered ? '采购单已保存并下单' : '采购单已更新')
      setEditing(false)
      router.replace(`/inventory/category/linen/purchase-orders`)
      await load()
    } finally {
      setSavingEdit(false)
    }
  }

  const columns: any[] = [
    { title: '床品类型', dataIndex: 'item_name', render: (_: any, r: Line) => <Space><span>{r.item_name}</span><Tag>{r.item_sku}</Tag></Space> },
    { title: '数量', dataIndex: 'quantity', width: 100 },
    { title: '单位', dataIndex: 'unit', width: 100 },
    { title: '单价', dataIndex: 'unit_price', width: 120, render: (v: any) => v == null ? '-' : fmtMoney(v) },
    { title: '金额', dataIndex: 'amount_total', width: 140, render: (_: any, r: Line) => fmtMoney(r.amount_total ?? (Number(r.unit_price || 0) * Number(r.quantity || 0))) },
    { title: '备注', dataIndex: 'note' },
  ]

  const sortedLines = useMemo(() => sortLinesByLinenTypeOrder(lines, linenTypes), [lines, linenTypes])
  const totalAmount = useMemo(
    () => (sortedLines || []).reduce((sum, line) => sum + Number(line.amount_total ?? (Number(line.unit_price || 0) * Number(line.quantity || 0))), 0),
    [sortedLines],
  )
  const gstAmount = useMemo(() => Number((Number(po?.gst_amount ?? (totalAmount * 0.1)) || 0).toFixed(2)), [po?.gst_amount, totalAmount])
  const totalAmountInclGst = useMemo(
    () => Number((Number(po?.total_amount_inc_gst ?? (totalAmount + gstAmount)) || 0).toFixed(2)),
    [po?.total_amount_inc_gst, totalAmount, gstAmount],
  )
  const supplierNameLower = String(po?.supplier_name || '').trim().toLowerCase()
  const isPslSupplier = supplierNameLower.includes('psl')
  const hideSupplierPricing = isPslSupplier || supplierNameLower.includes('ewash')
  const pdfLines = useMemo(
    () => (supplierNameLower.includes('ewash') ? sortedLines.filter((line) => !isExcludedForEwashLine(line.item_sku, line.item_name)) : sortedLines),
    [sortedLines, supplierNameLower],
  )
  const pdfCompact = pdfLines.length >= 6
  const pdfHeaderPad = pdfCompact ? '7px 10px' : '12px 16px'
  const pdfRowPad = pdfCompact ? '6px 10px' : '14px 16px'
  const pdfTableFontSize = pdfCompact ? 12 : 15
  const pdfCardPadding = pdfCompact ? 14 : 24
  const pdfCardGap = pdfCompact ? 12 : 22
  const pdfMetaGap = pdfCompact ? 6 : 14
  const pdfTopPadding = pdfCompact ? '14px 18px 12px' : '26px 26px 24px'
  const hasPdfNotes = String(po?.note || '').trim().length > 0
  const displaySku = (sku?: string | null, itemName?: string | null) => displayLinenEnglish(sku, itemName)
  const pslDeliveryWeekday = getWeekdayLabel(po?.requested_delivery_date)
  const pslCodeMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const row of linenTypes || []) {
      map.set(normalizeLinenDisplayKey(row.code), String(row.psl_code || ''))
    }
    return map
  }, [linenTypes])

  const bilingualTitle = (en: string, zh: string, options?: { align?: 'left' | 'center' | 'right', enSize?: number, zhSize?: number, gap?: number, weight?: number, enColor?: string, zhColor?: string }) => (
    <div style={{ textAlign: options?.align || 'left', lineHeight: 1.15 }}>
      <div style={{ fontSize: options?.enSize || 16, fontWeight: options?.weight || 800, color: options?.enColor || '#16385f' }}>{en}</div>
      <div style={{ marginTop: options?.gap ?? 4, fontSize: options?.zhSize || 11, color: options?.zhColor || '#8fa6c5', letterSpacing: 0.2 }}>{zh}</div>
    </div>
  )

  const bilingualLabel = (en: string, zh: string, width: number) => (
    <span style={{ display: 'inline-flex', flexDirection: 'column', width, color: '#64748b', lineHeight: 1.1, verticalAlign: 'top' }}>
      <span style={{ fontSize: 13, fontWeight: 600 }}>{en}</span>
      <span style={{ marginTop: 2, fontSize: 10, color: '#94a3b8' }}>{zh}</span>
    </span>
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
            {po?.status !== 'closed' ? <Button danger onClick={() => archivePo().catch((e) => message.error(e?.message || '归档失败'))}>归档</Button> : null}
          </Space>
        }
      >
        {po ? (
          <div style={{ display: 'grid', gap: 18 }}>
            {editing ? (
              <Form form={editForm} layout="vertical">
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                  <Form.Item label="采购单号">
                    <Input value={po.po_no || po.id} disabled />
                  </Form.Item>
                  <Form.Item label="状态">
                    <Input value={po.status === 'draft' ? '草稿' : po.status === 'ordered' ? '已下单' : po.status === 'received' ? '已到货' : '已关闭'} disabled />
                  </Form.Item>
                  <Form.Item name="supplier_id" label="供应商" rules={[{ required: true, message: '请选择供应商' }]}>
                    <Select options={suppliers.filter((s) => s.active).map((s) => ({ value: s.id, label: s.name }))} />
                  </Form.Item>
                  <Form.Item name="warehouse_id" label="收货仓库" rules={[{ required: true, message: '请选择仓库' }]}>
                    <Select options={warehouses.filter((w) => w.active).map((w) => ({ value: w.id, label: `${w.code} - ${w.name}` }))} />
                  </Form.Item>
                  <Form.Item name="ordered_date" label="下单日期">
                    <DatePicker style={{ width: '100%' }} />
                  </Form.Item>
                  <Form.Item name="requested_delivery_date" label="送货日期">
                    <DatePicker style={{ width: '100%' }} />
                  </Form.Item>
                </div>
                <Form.Item name="note" label="备注">
                  <Input.TextArea rows={3} />
                </Form.Item>

                <Divider style={{ margin: '4px 0' }}>床品明细</Divider>
                <Form.List name="lines">
                  {(fields) => (
                    <div style={{ display: 'grid', gap: 12 }}>
                      {fields.map((field) => (
                        <div key={field.key} style={{ display: 'grid', gridTemplateColumns: '1.4fr 120px 120px 1fr', gap: 12, alignItems: 'start', padding: 12, border: '1px solid #f0f0f0', borderRadius: 10, background: '#fafafa' }}>
                          <Form.Item name={[field.name, 'id']} hidden><Input /></Form.Item>
                          <Form.Item name={[field.name, 'item_id']} hidden><Input /></Form.Item>
                          <Form.Item name={[field.name, 'unit_price']} hidden><InputNumber /></Form.Item>
                          <Form.Item label="床品类型" style={{ marginBottom: 0 }}>
                            <Input value={editForm.getFieldValue(['lines', field.name, 'item_name'])} disabled />
                          </Form.Item>
                          <Form.Item name={[field.name, 'quantity']} label="数量" rules={[{ required: true, message: '请输入数量' }]}>
                            <InputNumber min={0} precision={0} style={{ width: '100%' }} />
                          </Form.Item>
                          <Form.Item shouldUpdate noStyle>
                            {() => (
                              <Form.Item label="单价" style={{ marginBottom: 0 }}>
                                <Input value={fmtMoney(editForm.getFieldValue(['lines', field.name, 'unit_price']))} disabled />
                              </Form.Item>
                            )}
                          </Form.Item>
                          <Form.Item name={[field.name, 'note']} label="备注">
                            <Input />
                          </Form.Item>
                        </div>
                      ))}
                    </div>
                  )}
                </Form.List>

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, marginTop: 16 }}>
                  <Button onClick={() => { setEditing(false); editForm.resetFields(); router.replace('/inventory/category/linen/purchase-orders') }}>取消</Button>
                  {po?.status === 'draft' ? <Button loading={savingEdit} onClick={() => submitEdit(true).catch((e) => message.error(e?.message || '保存并下单失败'))}>保存并下单</Button> : null}
                  <Button type="primary" loading={savingEdit} onClick={() => submitEdit().catch((e) => message.error(e?.message || '保存失败'))}>保存</Button>
                </div>
              </Form>
            ) : (
              <>
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
                  dataSource={sortedLines}
                  pagination={false}
                  summary={() => (
                    <>
                      <Table.Summary.Row>
                        <Table.Summary.Cell index={0} colSpan={4}>
                          <div style={{ textAlign: 'right', fontWeight: 700 }}>小计</div>
                        </Table.Summary.Cell>
                        <Table.Summary.Cell index={1}>
                          <div style={{ fontWeight: 700 }}>{fmtMoney(totalAmount)}</div>
                        </Table.Summary.Cell>
                        <Table.Summary.Cell index={2}></Table.Summary.Cell>
                      </Table.Summary.Row>
                      <Table.Summary.Row>
                        <Table.Summary.Cell index={0} colSpan={4}>
                          <div style={{ textAlign: 'right', fontWeight: 700 }}>GST (10%)</div>
                        </Table.Summary.Cell>
                        <Table.Summary.Cell index={1}>
                          <div style={{ fontWeight: 700 }}>{fmtMoney(gstAmount)}</div>
                        </Table.Summary.Cell>
                        <Table.Summary.Cell index={2}></Table.Summary.Cell>
                      </Table.Summary.Row>
                      <Table.Summary.Row>
                        <Table.Summary.Cell index={0} colSpan={4}>
                          <div style={{ textAlign: 'right', fontWeight: 700 }}>含 GST 总价</div>
                        </Table.Summary.Cell>
                        <Table.Summary.Cell index={1}>
                          <div style={{ fontWeight: 700 }}>{fmtMoney(totalAmountInclGst)}</div>
                        </Table.Summary.Cell>
                        <Table.Summary.Cell index={2}></Table.Summary.Cell>
                      </Table.Summary.Row>
                    </>
                  )}
                />

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
                  {po?.status !== 'received' && po?.status !== 'closed' ? <Button onClick={() => { setEditing(true); router.replace(`/inventory/purchase-orders/${id}?edit=1`) }}>编辑</Button> : null}
                  {po?.status === 'draft' ? <Button type="primary" loading={ordering} onClick={() => markOrdered().catch((e) => message.error(e?.message || '下单失败'))}>下单</Button> : null}
                </div>
              </>
            )}

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
        <Form form={deliveryForm} layout="vertical" initialValues={{ lines: [] }}>
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
                width: PDF_PAGE_WIDTH,
                maxWidth: '100%',
                height: PDF_PAGE_HEIGHT,
                background: '#fff',
                padding: pdfTopPadding,
                boxSizing: 'border-box',
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
              }}
            >
              {isPslSupplier ? (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: '190px 1fr', gap: 22, alignItems: 'start', marginTop: 2, marginBottom: 8 }}>
                    <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
                      <img src="/psl-logo.png" alt="Princes Linen Services" style={{ height: 58, width: 'auto', objectFit: 'contain' }} />
                    </div>
                    <div>
                      <div style={{ fontSize: pdfCompact ? 24 : 28, fontWeight: 800, color: '#111827', textAlign: 'center', marginTop: 4, letterSpacing: 0.4 }}>
                        CUSTOMER LINEN ORDER FORM
                      </div>
                      <div style={{ marginTop: 8, textAlign: 'center', fontSize: 11, color: '#4b5563', lineHeight: 1.5 }}>
                        Please email this linen order form to <strong>orders@pslaundry.com.au</strong><br />
                        If needed, contact PSL on <strong>(03) 9791 8344</strong>
                      </div>
                    </div>
                  </div>
                  <div style={{ marginTop: 18, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18, fontSize: pdfCompact ? 13 : 14 }}>
                    <div style={{ display: 'grid', gap: 10 }}>
                      <div><strong>Customer:</strong> MZ PROPERTY</div>
                      <div><strong>Acct No:</strong> 6354</div>
                      <div><strong>Contact name:</strong> MZ Property Team</div>
                      <div><strong>Ordered by:</strong> MZ Property</div>
                    </div>
                    <div style={{ display: 'grid', gap: 10 }}>
                      <div><strong>Today&apos;s Date:</strong> {po.ordered_date || '-'}</div>
                      <div><strong>Date to be Delivered:</strong> {po.requested_delivery_date || '-'}</div>
                      <div><strong>Delivery Day:</strong> {pslDeliveryWeekday || '-'}</div>
                      <div><strong>Comments:</strong> {po.note || ''}</div>
                    </div>
                  </div>
                  <div style={{ marginTop: 14, display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 6, fontSize: 11, color: '#4b5563' }}>
                    {['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'].map((day) => (
                      <div
                        key={day}
                        style={{
                          textAlign: 'center',
                          padding: '6px 4px',
                          border: '1px solid #d1d5db',
                          borderRadius: 999,
                          background: day === pslDeliveryWeekday ? '#dbeafe' : '#fff',
                          color: day === pslDeliveryWeekday ? '#1d4ed8' : '#4b5563',
                          fontWeight: day === pslDeliveryWeekday ? 700 : 500,
                        }}
                      >
                        {day}
                      </div>
                    ))}
                  </div>
                  <div style={{ marginTop: 16, borderTop: '2px solid #111827' }}></div>
                  <div style={{ marginTop: 16 }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: pdfCompact ? 13 : 14 }}>
                      <thead>
                        <tr style={{ background: '#f3f4f6' }}>
                          <th style={{ padding: '10px 12px', textAlign: 'left', border: '1px solid #d1d5db', width: 100 }}>CODE</th>
                          <th style={{ padding: '10px 12px', textAlign: 'left', border: '1px solid #d1d5db' }}>ITEM DESCRIPTION</th>
                          <th style={{ padding: '10px 12px', textAlign: 'center', border: '1px solid #d1d5db', width: 120 }}>QTY</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pdfLines.map((line) => {
                          const meta = getPslLineMeta(line.item_sku, line.item_name, pslCodeMap.get(normalizeLinenDisplayKey(line.item_sku || line.item_name)))
                          return (
                            <tr key={line.id}>
                              <td style={{ padding: '9px 12px', border: '1px solid #d1d5db' }}>{meta.code || '-'}</td>
                              <td style={{ padding: '9px 12px', border: '1px solid #d1d5db' }}>{meta.description}</td>
                              <td style={{ padding: '9px 12px', textAlign: 'center', border: '1px solid #d1d5db' }}>{line.quantity}</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                  <div style={{ marginTop: 'auto', paddingTop: 14, borderTop: '1px solid #e5e7eb', color: '#64748b', fontSize: 12 }}>
                    <div>Customer: MZ PROPERTY</div>
                    <div style={{ marginTop: 4 }}>Purchase Order No: {po.po_no || po.id}</div>
                  </div>
                </>
              ) : (
                <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 24 }}>
                <div>
                  <img src="/mz-logo.png" alt="MZ Logo" style={{ height: pdfCompact ? 52 : 64, width: 'auto', objectFit: 'contain' }} />
                  <div style={{ marginTop: pdfCompact ? 6 : 10, fontSize: pdfCompact ? 15 : 17, fontWeight: 700, color: '#16385f' }}>MZ Property linen Order</div>
                  <div style={{ marginTop: 4, fontSize: 11, color: '#7c8aa5' }}>MZ Property 床品采购单</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  {bilingualTitle('Purchase Order No.', '采购订单号', { align: 'right', enSize: 13, zhSize: 10, weight: 700, gap: 3 })}
                  <div style={{ marginTop: pdfCompact ? 6 : 10, display: 'inline-block', padding: pdfCompact ? '7px 12px' : '10px 18px', borderRadius: 999, border: '1px solid #bfdbfe', background: '#eff6ff', fontSize: pdfCompact ? 17 : 20, fontWeight: 700, color: '#1d4ed8' }}>
                    {po.po_no || po.id}
                  </div>
                </div>
              </div>

              <div style={{ marginTop: pdfCompact ? 10 : 16, borderTop: '4px solid #16385f' }}></div>

              <div style={{ textAlign: 'center', marginTop: pdfCompact ? 14 : 24 }}>
                <div style={{ fontSize: pdfCompact ? 25 : 36, fontWeight: 800, letterSpacing: 1, color: '#16385f' }}>LINEN PURCHASE ORDER</div>
                <div style={{ marginTop: pdfCompact ? 4 : 8, color: '#64748b', fontSize: pdfCompact ? 10 : 11, letterSpacing: 0.3 }}>正式采购凭证 / 床品供应协同单</div>
              </div>

              <div style={{ marginTop: pdfCompact ? 12 : 22, paddingTop: pdfCompact ? 10 : 18, borderTop: '1px dashed #cbd5e1' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: pdfCardGap }}>
                  <div style={{ border: '1px solid #dbe4f0', borderRadius: 20, padding: pdfCardPadding, background: '#f8fbff' }}>
                    <div style={{ marginBottom: pdfCompact ? 10 : 16 }}>{bilingualTitle('Supplier Details', '供应信息')}</div>
                    <div style={{ display: 'grid', gap: pdfMetaGap, fontSize: pdfCompact ? 12 : 15 }}>
                      <div>{bilingualLabel('Supplier', '供应商', 88)}<strong>{po.supplier_name}</strong></div>
                      <div>{bilingualLabel('Status', '订单状态', 88)}{statusTag(po.status)}</div>
                      <div>{bilingualLabel('Notes', '备注说明', 88)}{hasPdfNotes ? po.note : null}</div>
                    </div>
                  </div>
                  <div style={{ border: '1px solid #dbe4f0', borderRadius: 20, padding: pdfCardPadding, background: '#f8fbff' }}>
                    <div style={{ marginBottom: pdfCompact ? 10 : 16 }}>{bilingualTitle('Dates & Warehouse', '日期与仓库')}</div>
                    <div style={{ display: 'grid', gap: pdfMetaGap, fontSize: pdfCompact ? 12 : 15 }}>
                      <div>{bilingualLabel('Order Date', '下单日期', 96)}<strong>{po.ordered_date || '-'}</strong></div>
                      <div>{bilingualLabel('Delivery Date', '送货日期', 96)}<strong>{po.requested_delivery_date || '-'}</strong></div>
                      <div>{bilingualLabel('Warehouse', '收货仓库', 96)}<strong>{po.warehouse_code} - {po.warehouse_name}</strong></div>
                    </div>
                  </div>
                </div>
              </div>

              <div style={{ marginTop: pdfCompact ? 14 : 24 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: pdfTableFontSize }}>
                  <thead>
                    <tr style={{ background: '#16385f', color: '#fff' }}>
                      <th style={{ padding: pdfHeaderPad, textAlign: 'left' }}>{bilingualTitle('Code / Name', '编码 / 名称', { enSize: 14, zhSize: 10, gap: 2, weight: 700, enColor: '#8fa6c5', zhColor: '#8fa6c5' })}</th>
                      <th style={{ padding: pdfHeaderPad, textAlign: 'center', width: 90 }}>{bilingualTitle('Qty', '数量', { align: 'center', enSize: 14, zhSize: 10, gap: 2, weight: 700, enColor: '#8fa6c5', zhColor: '#8fa6c5' })}</th>
                      <th style={{ padding: pdfHeaderPad, textAlign: 'center', width: 90 }}>{bilingualTitle('Unit', '单位', { align: 'center', enSize: 14, zhSize: 10, gap: 2, weight: 700, enColor: '#8fa6c5', zhColor: '#8fa6c5' })}</th>
                      {!hideSupplierPricing ? <th style={{ padding: pdfHeaderPad, textAlign: 'right', width: 120 }}>{bilingualTitle('Unit Price', '单价', { align: 'right', enSize: 14, zhSize: 10, gap: 2, weight: 700, enColor: '#8fa6c5', zhColor: '#8fa6c5' })}</th> : null}
                      {!hideSupplierPricing ? <th style={{ padding: pdfHeaderPad, textAlign: 'right', width: 140 }}>{bilingualTitle('Amount', '金额', { align: 'right', enSize: 14, zhSize: 10, gap: 2, weight: 700, enColor: '#8fa6c5', zhColor: '#8fa6c5' })}</th> : null}
                      <th style={{ padding: pdfHeaderPad, textAlign: 'left', width: 140 }}>{bilingualTitle('Notes', '备注', { enSize: 14, zhSize: 10, gap: 2, weight: 700, enColor: '#8fa6c5', zhColor: '#8fa6c5' })}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pdfLines.map((line, idx) => (
                      <tr key={line.id} style={{ background: idx % 2 === 0 ? '#ffffff' : '#f8fafc' }}>
                        <td style={{ padding: pdfRowPad, border: '1px solid #dbe4f0' }}>
                          <div style={{ fontWeight: 700, color: '#16385f', lineHeight: 1.1 }}>{displaySku(line.item_sku, line.item_name)}</div>
                          <div style={{ marginTop: 2, color: '#64748b', fontSize: pdfCompact ? 11 : 13, lineHeight: 1.1 }}>{line.item_name}</div>
                        </td>
                        <td style={{ padding: pdfRowPad, textAlign: 'center', border: '1px solid #dbe4f0' }}>{line.quantity}</td>
                        <td style={{ padding: pdfRowPad, textAlign: 'center', border: '1px solid #dbe4f0' }}>{line.unit}</td>
                        {!hideSupplierPricing ? <td style={{ padding: pdfRowPad, textAlign: 'right', border: '1px solid #dbe4f0' }}>{fmtMoney(line.unit_price)}</td> : null}
                        {!hideSupplierPricing ? <td style={{ padding: pdfRowPad, textAlign: 'right', border: '1px solid #dbe4f0', color: '#166534', fontWeight: 700 }}>
                          {fmtMoney(line.amount_total ?? (Number(line.unit_price || 0) * Number(line.quantity || 0)))}
                        </td> : null}
                        <td style={{ padding: pdfRowPad, border: '1px solid #dbe4f0' }}>{line.note || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {!hideSupplierPricing ? <div style={{ marginTop: pdfCompact ? 14 : 22, border: '1px solid #dbeafe', borderRadius: 18, padding: pdfCompact ? '12px 16px' : '16px 22px', background: '#f8fbff', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 24 }}>
                <div style={{ display: 'grid', gap: 6 }}>
                  <div>{bilingualTitle('Order Total', '订单总额', { enSize: pdfCompact ? 16 : 18, zhSize: 11, gap: 3 })}</div>
                  <div style={{ color: '#64748b', fontSize: pdfCompact ? 12 : 13 }}>Subtotal: {fmtMoney(totalAmount)} AUD</div>
                  <div style={{ color: '#64748b', fontSize: pdfCompact ? 12 : 13 }}>GST (10%): {fmtMoney(gstAmount)} AUD</div>
                </div>
                <div style={{ padding: pdfCompact ? '7px 14px' : '10px 18px', borderRadius: 999, background: '#ecfdf5', color: '#166534', fontSize: pdfCompact ? 18 : 22, fontWeight: 800 }}>
                  {fmtMoney(totalAmountInclGst)} AUD
                </div>
              </div> : null}

              <div style={{ marginTop: 'auto', paddingTop: pdfCompact ? 10 : 18, borderTop: '1px solid #e2e8f0', display: 'flex', justifyContent: 'space-between', gap: 16, color: '#64748b', fontSize: pdfCompact ? 12 : 14 }}>
                {!hideSupplierPricing ? <div>
                  <div style={{ fontSize: pdfCompact ? 12 : 13, fontWeight: 600, color: '#64748b' }}>Settlement Currency</div>
                  <div style={{ marginTop: 2, fontSize: 10, color: '#94a3b8' }}>结算币种</div>
                  <div style={{ marginTop: 2 }}>Australian Dollar (AUD)</div>
                </div> : <div />}
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: pdfCompact ? 12 : 13, fontWeight: 600, color: '#64748b' }}>Tracking Reference</div>
                  <div style={{ marginTop: 2, fontSize: 10, color: '#94a3b8' }}>订单跟踪号</div>
                  <div style={{ marginTop: 2 }}>{po.po_no || po.id}</div>
                </div>
              </div>
                </>
              )}
            </div>
          </div>
        ) : null}
      </Modal>
    </>
  )
}
