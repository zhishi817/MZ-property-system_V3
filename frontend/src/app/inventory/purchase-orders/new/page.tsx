"use client"
import { ArrowLeftOutlined } from '@ant-design/icons'
import { Card, Space, Button, Form, Select, Input, InputNumber, DatePicker, message, Divider, Typography, Table } from 'antd'
import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import dayjs from 'dayjs'
import { getJSON, postJSON } from '../../../../lib/api'

type Warehouse = { id: string; code: string; name: string; active: boolean }
type Supplier = { id: string; name: string; kind: string; active: boolean }
type LinenType = { code: string; name: string; item_id?: string | null; active: boolean; sort_order?: number | null; aliases?: string[]; alias_item_ids?: string[] }
type SupplierPrice = { supplier_id: string; item_id: string; linen_type_code?: string | null; purchase_unit_price: number; refund_unit_price: number }
type LinenItem = { id: string; name: string; sku?: string | null; linen_type_code?: string | null; active?: boolean }

function normalizeLinenTypeCode(code?: string | null) {
  return String(code || '').trim().toLowerCase()
}

function displayLinenLabel(code?: string | null, fallback?: string | null) {
  const normalized = normalizeLinenTypeCode(code)
  const map: Record<string, string> = {
    bath_mat: 'Bath mat',
    hand_towel: 'Hand towel',
    tea_towel: 'Tea towel',
    bath_towel: 'Bath towel',
    bedsheet: 'Queen sheet',
    duvet_cover: 'Doona cover',
    pillowcase: 'Pillowcase',
  }
  return map[normalized] || String(fallback || code || '').trim()
}

function linenTypePriority(row: LinenType) {
  const code = normalizeLinenTypeCode(row.code)
  let score = 0
  if (row.item_id) score += 100
  if (/^[a-z0-9_]+$/.test(code)) score += 20
  if (code.includes('_')) score += 10
  if (!code.includes(' ')) score += 5
  return score
}

function isExcludedForEwash(item: Pick<LinenType, 'code' | 'name'>) {
  const code = normalizeLinenTypeCode(item.code).replace(/[\s_-]+/g, '')
  const name = String(item.name || '').trim().toLowerCase().replace(/[\s_-]+/g, '')
  const rawName = String(item.name || '').trim()
  const rawCode = String(item.code || '').trim()
  const checks = [
    code,
    name,
    rawName,
    rawCode,
  ]
  return checks.some((value) =>
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
    ].some((needle) => String(value).includes(needle)),
  )
}

function dedupeLinenTypes(rows: LinenType[]) {
  const map = new Map<string, LinenType>()
  for (const row of rows || []) {
    const key = String(row?.name || '').trim() || normalizeLinenTypeCode(row.code)
    const prev = map.get(key)
    if (!prev) {
      map.set(key, {
        ...row,
        sort_order: row.sort_order ?? null,
        aliases: [String(row.code || '')],
        alias_item_ids: row.item_id ? [String(row.item_id)] : [],
      })
      continue
    }
    const mergedAliases = Array.from(new Set([...(prev.aliases || [String(prev.code || '')]), String(row.code || '')].filter(Boolean)))
    const mergedItemIds = Array.from(new Set([...(prev.alias_item_ids || (prev.item_id ? [String(prev.item_id)] : [])), ...(row.item_id ? [String(row.item_id)] : [])].filter(Boolean)))
    const winner = linenTypePriority(row) > linenTypePriority(prev) ? row : prev
    map.set(key, {
      ...winner,
      sort_order: winner.sort_order ?? prev.sort_order ?? row.sort_order ?? null,
      aliases: mergedAliases,
      alias_item_ids: mergedItemIds,
    })
  }
  return Array.from(map.values()).sort((a, b) => {
    const sortA = Number.isFinite(Number(a.sort_order)) ? Number(a.sort_order) : 9999
    const sortB = Number.isFinite(Number(b.sort_order)) ? Number(b.sort_order) : 9999
    if (sortA !== sortB) return sortA - sortB
    return String(a.name || '').localeCompare(String(b.name || ''), 'zh')
  })
}

export default function PurchaseOrderNewPage() {
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [linenTypes, setLinenTypes] = useState<LinenType[]>([])
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
    const [ws, ss, linenTypeRows, linenItems, priceRows] = await Promise.all([
      getJSON<Warehouse[]>('/inventory/warehouses'),
      getJSON<Supplier[]>('/inventory/suppliers'),
      getJSON<LinenType[]>('/inventory/linen-types'),
      getJSON<LinenItem[]>('/inventory/items?active=true&category=linen'),
      loadSupplierPricesCompat(),
    ])
    const activeWarehouses = (ws || []).filter((w) => w.active)
    const activeSuppliers = (ss || []).filter((s) => s.active && s.kind === 'linen')
    const itemRows = (linenItems || []).filter((i) => i.active !== false)
    const mergedLinenTypes = (linenTypeRows || [])
      .filter((i) => i.active)
      .map((linenType) => {
        const matches = itemRows.filter((item) => normalizeLinenTypeCode(item.linen_type_code) === normalizeLinenTypeCode(linenType.code))
        const canonical = matches[0]
        return {
          ...linenType,
          item_id: String(linenType.item_id || canonical?.id || ''),
          alias_item_ids: matches.map((item) => String(item.id || '')).filter(Boolean),
          aliases: Array.from(new Set([
            String(linenType.code || ''),
            ...matches.flatMap((item) => [
              String(item.linen_type_code || ''),
              String(item.name || ''),
              String(item.sku || '').replace(/^LT:/i, ''),
            ]),
          ].filter(Boolean))),
        }
      })
    const activeLinenTypes = dedupeLinenTypes(mergedLinenTypes)
    setWarehouses(activeWarehouses)
    setSuppliers(activeSuppliers)
    setLinenTypes(activeLinenTypes)
    setPrices(priceRows || [])

    const smWarehouse = activeWarehouses.find((w) => {
      const id = String(w.id || '').trim().toLowerCase()
      const code = String(w.code || '').trim().toLowerCase()
      const name = String(w.name || '').trim().toLowerCase()
      return id === 'wh.south_melbourne' || code === 'sou' || code === 'sm' || name.includes('south melbourne') || name.includes('sm')
    })
    const currentLines = form.getFieldValue('linesByItem') || {}
    const nextLines = activeLinenTypes.reduce((acc: Record<string, any>, item) => {
      acc[item.code] = {
        quantity: Number(currentLines?.[item.code]?.quantity || 0),
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
    for (const row of prices || []) {
      const price = Number(row.purchase_unit_price || 0)
      map.set(`${row.supplier_id}:item:${row.item_id}`, price)
      const code = normalizeLinenTypeCode(row.linen_type_code)
      if (code) map.set(`${row.supplier_id}:code:${code}`, price)
      const itemCode = normalizeLinenTypeCode(String(row.item_id || '').split('item.linen_type.').pop())
      if (itemCode) map.set(`${row.supplier_id}:code:${itemCode}`, price)
    }
    return map
  }, [prices])

  function resolveUnitPrice(supplierId: string | undefined, item: LinenType) {
    if (!supplierId) return 0
    const itemIds = Array.from(new Set([String(item.item_id || ''), ...(item.alias_item_ids || [])].filter(Boolean)))
    for (const itemId of itemIds) {
      const hit = Number(priceMap.get(`${supplierId}:item:${itemId}`) || 0)
      if (hit > 0) return hit
    }
    const codes = Array.from(new Set([normalizeLinenTypeCode(item.code), ...((item.aliases || []).map(normalizeLinenTypeCode))].filter(Boolean)))
    for (const code of codes) {
      const hit = Number(priceMap.get(`${supplierId}:code:${code}`) || 0)
      if (hit > 0) return hit
    }
    return 0
  }

  const selectedSupplierId = Form.useWatch('supplier_id', form)
  const watchedLinesByItem = Form.useWatch('linesByItem', form) || {}
  const selectedSupplierNameLower = useMemo(
    () => String((suppliers || []).find((s) => s.id === selectedSupplierId)?.name || '').trim().toLowerCase(),
    [suppliers, selectedSupplierId],
  )
  const visibleLinenTypes = useMemo(
    () => (linenTypes || []).filter((item) => !(selectedSupplierNameLower.includes('ewash') && isExcludedForEwash(item))),
    [linenTypes, selectedSupplierNameLower],
  )

  const itemRows = useMemo(() => {
    return visibleLinenTypes.map((item) => {
      const quantity = Number(watchedLinesByItem?.[item.code]?.quantity || 0)
      const unitPrice = resolveUnitPrice(selectedSupplierId, item)
      return {
        ...item,
        id: item.code,
        sku: displayLinenLabel(item.code, item.name),
        unit: 'pcs',
        quantity,
        unitPrice,
        amount: quantity * unitPrice,
      }
    })
  }, [visibleLinenTypes, watchedLinesByItem, selectedSupplierId, priceMap])

  const totalAmount = useMemo(
    () => itemRows.reduce((sum, row) => sum + Number(row.amount || 0), 0),
    [itemRows],
  )
  const gstAmount = useMemo(() => Number((totalAmount * 0.1).toFixed(2)), [totalAmount])
  const totalAmountInclGst = useMemo(() => Number((totalAmount + gstAmount).toFixed(2)), [totalAmount, gstAmount])

  async function submit() {
    setSubmitting(true)
    try {
      const v = await form.validateFields()
      const lines = visibleLinenTypes
        .map((item) => {
          const quantity = Number(v?.linesByItem?.[item.code]?.quantity || 0)
          if (!(quantity > 0)) return null
          if (!item.item_id) throw new Error(`床品类型 ${item.name} 未关联库存物料，请先补齐床品类型映射`)
          const unit_price = v.supplier_id ? resolveUnitPrice(v.supplier_id, item) : undefined
          return { item_id: item.item_id, quantity, unit_price }
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
      render: (_: any, row: any) => (
        <Form.Item name={['linesByItem', row.code, 'quantity']} noStyle>
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
          <Table rowKey={(r) => r.code} columns={columns} dataSource={itemRows} pagination={false} size="middle" tableLayout="fixed" />
        </div>

        <Divider />
        <div style={{ display: 'grid', gap: 6 }}>
          <Typography.Text strong>当前采购小计：${totalAmount.toFixed(2)}</Typography.Text>
          <Typography.Text strong>GST (10%)：${gstAmount.toFixed(2)}</Typography.Text>
          <Typography.Text strong>含 GST 总价：${totalAmountInclGst.toFixed(2)}</Typography.Text>
        </div>

        <div style={{ marginTop: 16, maxWidth: 520 }}>
          <Form.Item name="note" label="备注">
            <Input />
          </Form.Item>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button type="primary" loading={submitting} onClick={() => submit().catch((e) => message.error(e?.message || '提交失败'))}>
            创建采购单
          </Button>
        </div>
      </Form>
    </Card>
  )
}
