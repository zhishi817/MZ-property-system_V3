"use client"
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons'
import { App, Button, Card, DatePicker, Descriptions, Drawer, Form, Image, Input, InputNumber, Modal, Popconfirm, Select, Space, Table, Tag, Upload } from 'antd'
import type { UploadFile, UploadProps } from 'antd/es/upload/interface'
import { useEffect, useMemo, useState } from 'react'
import dayjs from 'dayjs'
import html2canvas from 'html2canvas'
import jsPDF from 'jspdf'
import { API_BASE, authHeaders, deleteJSON, getJSON, patchJSON, postJSON } from '../../../lib/api'

type Warehouse = { id: string; code: string; name: string; active: boolean }
type Supplier = { id: string; name: string; kind: string; active: boolean }
type LinenType = { code: string; name: string; sort_order?: number | null; active: boolean }
type Item = { id: string; name: string; sku: string; active: boolean; linen_type_code?: string | null }
type SupplierPrice = {
  supplier_id: string
  item_id: string
  refund_unit_price: number
  active?: boolean
}
type LinenTypeMeta = { code: string; name: string; psl_code?: string | null; sort_order?: number | null; active: boolean }
type ReturnLine = {
  id?: string
  item_id: string
  item_name?: string | null
  item_sku?: string | null
  quantity: number
  refund_unit_price?: number | null
  amount_total?: number | null
  note?: string | null
}
type ReturnBatch = {
  id: string
  return_no?: string | null
  supplier_id?: string
  supplier_name: string
  warehouse_code: string
  warehouse_name: string
  status: string
  returned_at?: string | null
  quantity_total: number
  amount_total: number
  note?: string | null
  photo_urls?: string[] | null
  lines?: ReturnLine[] | null
}

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
  if (match(['handtowel', '手巾'])) return { code: String(pslCode || '3200'), description: 'HAND TOWEL STD' }
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

function money(value?: number | null, options?: { withCurrency?: boolean }) {
  const base = `$${Number(value || 0).toFixed(2)}`
  return options?.withCurrency ? `${base} AUD` : base
}

function formatDateTime(value?: string | null) {
  if (!value) return '-'
  const d = dayjs(value)
  return d.isValid() ? d.format('YYYY-MM-DD HH:mm') : String(value)
}

function displayReturnNo(row?: ReturnBatch | null) {
  return String(row?.return_no || row?.id || '').trim() || '-'
}

export default function LinenReturnsDamageView() {
  const { message } = App.useApp()
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [items, setItems] = useState<Item[]>([])
  const [linenTypes, setLinenTypes] = useState<LinenTypeMeta[]>([])
  const [supplierPrices, setSupplierPrices] = useState<SupplierPrice[]>([])
  const [rows, setRows] = useState<ReturnBatch[]>([])
  const [open, setOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [photoFiles, setPhotoFiles] = useState<UploadFile[]>([])
  const [photoUrls, setPhotoUrls] = useState<string[]>([])
  const [editingRow, setEditingRow] = useState<ReturnBatch | null>(null)
  const [viewingRow, setViewingRow] = useState<ReturnBatch | null>(null)
  const [form] = Form.useForm()

  async function loadBase() {
    const [ws, ss, lt, its, prices] = await Promise.all([
      getJSON<Warehouse[]>('/inventory/warehouses'),
      getJSON<Supplier[]>('/inventory/suppliers'),
      getJSON<LinenType[]>('/inventory/linen-types'),
      getJSON<Item[]>('/inventory/items?active=true&category=linen'),
      getJSON<SupplierPrice[]>('/inventory/supplier-item-prices?active=true').catch(() => []),
    ])
    setWarehouses((ws || []).filter((w) => w.active))
    setSuppliers((ss || []).filter((s) => s.active && s.kind === 'linen'))
    setSupplierPrices((prices || []).filter((row) => row.active !== false))
    const activeLinenTypes = (lt || []).filter((row) => row.active)
    setLinenTypes(activeLinenTypes)
    const orderMap = new Map<string, number>(
      activeLinenTypes.map((row, idx) => [String(row.code || ''), Number.isFinite(Number(row.sort_order)) ? Number(row.sort_order) : idx]),
    )
    setItems(
      (its || [])
        .filter((i) => i.active)
        .slice()
        .sort((a, b) => {
          const orderA = orderMap.get(String(a.linen_type_code || '')) ?? 9999
          const orderB = orderMap.get(String(b.linen_type_code || '')) ?? 9999
          if (orderA !== orderB) return orderA - orderB
          return String(a.name || '').localeCompare(String(b.name || ''), 'zh')
        }),
    )
  }

  async function loadRows() {
    const batchRows = await getJSON<ReturnBatch[]>('/inventory/linen/supplier-return-batches')
    setRows(batchRows || [])
  }

  useEffect(() => {
    loadBase()
      .then(loadRows)
      .catch((e) => message.error(e?.message || '加载失败'))
  }, [message])

  const defaultWarehouseId = useMemo(() => {
    return warehouses.find((w) => `${w.code}`.toUpperCase() === 'SOU')?.id || warehouses[0]?.id || ''
  }, [warehouses])

  const supplierOptions = useMemo(() => suppliers.map((s) => ({ value: s.id, label: s.name })), [suppliers])
  const itemOptions = useMemo(() => items.map((i) => ({ value: i.id, label: `${i.name} (${i.sku})` })), [items])
  const refundPriceMap = useMemo(() => {
    const map = new Map<string, number>()
    for (const row of supplierPrices || []) {
      const supplierId = String(row.supplier_id || '')
      const itemId = String(row.item_id || '')
      if (!supplierId || !itemId) continue
      map.set(`${supplierId}:${itemId}`, Number(row.refund_unit_price || 0))
    }
    return map
  }, [supplierPrices])

  function resolveRefundPrice(supplierId?: string, itemId?: string) {
    if (!supplierId || !itemId) return 0
    return refundPriceMap.get(`${supplierId}:${itemId}`) ?? 0
  }

  function syncLineRefundPrice(lineIndex: number, nextItemId?: string, nextSupplierId?: string) {
    const supplierId = String(nextSupplierId || form.getFieldValue('supplier_id') || '')
    const itemId = String(nextItemId || form.getFieldValue(['lines', lineIndex, 'item_id']) || '')
    form.setFieldValue(['lines', lineIndex, 'refund_unit_price'], resolveRefundPrice(supplierId, itemId))
  }

  function syncAllRefundPrices(nextSupplierId?: string) {
    const lines = Array.isArray(form.getFieldValue('lines')) ? form.getFieldValue('lines') : []
    lines.forEach((_: any, index: number) => syncLineRefundPrice(index, undefined, nextSupplierId))
  }

  function resetCreateForm() {
    form.resetFields()
    form.setFieldsValue({
      returned_at: dayjs(),
      lines: [{ quantity: 1, refund_unit_price: 0 }],
    })
    setPhotoUrls([])
    setPhotoFiles([])
  }

  function openCreateModal() {
    setEditingRow(null)
    resetCreateForm()
    setOpen(true)
  }

  function openEditModal(row: ReturnBatch) {
    setEditingRow(row)
    form.resetFields()
    form.setFieldsValue({
      supplier_id: row.supplier_id,
      returned_at: row.returned_at ? dayjs(row.returned_at) : dayjs(),
      note: row.note || '',
      lines: (row.lines || []).map((line) => ({
        item_id: line.item_id,
        quantity: Number(line.quantity || 0),
        refund_unit_price: Number(line.refund_unit_price || 0),
        note: line.note || '',
      })),
    })
    const urls = Array.isArray(row.photo_urls) ? row.photo_urls.filter(Boolean) : []
    setPhotoUrls(urls)
    setPhotoFiles(urls.map((url, idx) => ({ uid: `photo-existing-${idx}`, name: `photo-${idx + 1}`, status: 'done', url } as UploadFile)))
    setOpen(true)
  }

  async function submitReturn() {
    if (submitting) return
    if (!defaultWarehouseId) {
      message.error('未找到可用退货仓库，请先维护仓库信息')
      return
    }
    const values = await form.validateFields()
    setSubmitting(true)
    try {
      const payload = {
        supplier_id: values.supplier_id,
        warehouse_id: defaultWarehouseId,
        returned_at: values.returned_at ? dayjs(values.returned_at).format('YYYY-MM-DD HH:mm:ss') : undefined,
        note: values.note || undefined,
        photo_urls: photoUrls,
        lines: (values.lines || []).map((line: any) => ({
          item_id: line.item_id,
          quantity: Number(line.quantity || 0),
          refund_unit_price: Number(line.refund_unit_price || 0),
          note: line.note || undefined,
        })),
      }
      if (editingRow?.id) await patchJSON(`/inventory/linen/supplier-return-batches/${editingRow.id}`, payload)
      else await postJSON('/inventory/linen/supplier-return-batches', payload)
      message.success(editingRow?.id ? '退货记录已更新' : '退货记录已保存')
      setOpen(false)
      setEditingRow(null)
      resetCreateForm()
      await loadRows()
    } catch (e: any) {
      message.error(e?.message || '保存失败')
    } finally {
      setSubmitting(false)
    }
  }

  async function deleteReturn(row: ReturnBatch) {
    try {
      await deleteJSON(`/inventory/linen/supplier-return-batches/${row.id}`)
      message.success('退货记录已删除')
      if (viewingRow?.id === row.id) setViewingRow(null)
      await loadRows()
    } catch (e: any) {
      message.error(e?.message || '删除失败')
    }
  }

  const uploadProps: UploadProps = {
    listType: 'picture-card',
    fileList: photoFiles,
    multiple: true,
    customRequest: async ({ file, onSuccess, onError }: any) => {
      const uid = Math.random().toString(36).slice(2)
      const nextFile: UploadFile = {
        uid,
        name: (file as any)?.name || 'photo',
        status: 'uploading',
        percent: 0,
      }
      setUploading(true)
      setPhotoFiles((prev) => [...prev, nextFile])
      try {
        const fd = new FormData()
        fd.append('file', file as File)
        const res = await fetch(`${API_BASE}/inventory/upload`, {
          method: 'POST',
          headers: { ...authHeaders() },
          body: fd,
        })
        const json = await res.json().catch(() => ({}))
        if (!res.ok || !json?.url) throw new Error(json?.message || '上传失败')
        setPhotoUrls((prev) => [...prev, json.url])
        setPhotoFiles((prev) => prev.map((item) => (item.uid === uid ? { ...item, status: 'done', percent: 100, url: json.url } : item)))
        onSuccess?.(json, file)
      } catch (e: any) {
        setPhotoFiles((prev) => prev.map((item) => (item.uid === uid ? { ...item, status: 'error' } : item)))
        onError?.(e)
        message.error(e?.message || '上传失败')
      } finally {
        setUploading(false)
      }
    },
    onRemove: (file) => {
      setPhotoFiles((prev) => prev.filter((item) => item.uid !== file.uid))
      if ((file as any)?.url) setPhotoUrls((prev) => prev.filter((url) => url !== (file as any).url))
      return true
    },
  }

  async function downloadReturnSheet(row: ReturnBatch) {
    const supplierNameLower = String(row.supplier_name || '').trim().toLowerCase()
    const isPslSupplier = supplierNameLower.includes('psl')
    const pdfLines = (supplierNameLower.includes('ewash') ? (row.lines || []).filter((line) => !isExcludedForEwashLine(line.item_sku, line.item_name)) : (row.lines || []))
    const pdfCompact = pdfLines.length >= 6
    const pdfHeaderPad = pdfCompact ? '7px 10px' : '12px 16px'
    const pdfRowPad = pdfCompact ? '6px 10px' : '14px 16px'
    const pdfTableFontSize = pdfCompact ? 12 : 15
    const pdfCardPadding = pdfCompact ? 14 : 24
    const pdfCardGap = pdfCompact ? 12 : 22
    const pdfMetaGap = pdfCompact ? 6 : 14
    const pdfTopPadding = pdfCompact ? '14px 18px 12px' : '26px 26px 24px'
    const hasPdfNotes = String(row.note || '').trim().length > 0
    const pslDeliveryWeekday = getWeekdayLabel(row.returned_at)
    const pslCodeMap = new Map<string, string>()
    for (const meta of linenTypes || []) pslCodeMap.set(normalizeLinenDisplayKey(meta.code), String(meta.psl_code || ''))

    const printable = document.createElement('div')
    printable.style.position = 'fixed'
    printable.style.left = '-10000px'
    printable.style.top = '0'
    printable.style.width = `${PDF_PAGE_WIDTH}px`
    printable.style.height = `${PDF_PAGE_HEIGHT}px`
    printable.style.background = '#ffffff'
    printable.style.color = '#111827'
    printable.style.fontFamily = '"PingFang SC","Microsoft YaHei","Helvetica Neue",Arial,sans-serif'
    printable.style.padding = pdfTopPadding
    printable.style.boxSizing = 'border-box'
    printable.style.display = 'flex'
    printable.style.flexDirection = 'column'
    printable.style.overflow = 'hidden'

    const rowsHtml = pdfLines.map((line, idx) => {
      const amount = money(line.amount_total ?? (Number(line.refund_unit_price || 0) * Number(line.quantity || 0)))
      if (isPslSupplier) {
        const meta = getPslLineMeta(line.item_sku, line.item_name, pslCodeMap.get(normalizeLinenDisplayKey(line.item_sku || line.item_name)))
        return `<tr>
          <td style="padding:9px 12px;border:1px solid #d1d5db;">${meta.code || '-'}</td>
          <td style="padding:9px 12px;border:1px solid #d1d5db;">${meta.description}</td>
          <td style="padding:9px 12px;text-align:center;border:1px solid #d1d5db;">${line.quantity}</td>
          <td style="padding:9px 12px;text-align:right;border:1px solid #d1d5db;">${money(line.refund_unit_price)}</td>
          <td style="padding:9px 12px;text-align:right;border:1px solid #d1d5db;">${amount}</td>
        </tr>`
      }
      return `<tr style="background:${idx % 2 === 0 ? '#ffffff' : '#f8fafc'};">
        <td style="padding:${pdfRowPad};border:1px solid #dbe4f0;">
          <div style="font-weight:700;color:#16385f;line-height:1.1;">${displayLinenEnglish(line.item_sku, line.item_name)}</div>
          <div style="margin-top:2px;color:#64748b;font-size:${pdfCompact ? 11 : 13}px;line-height:1.1;">${line.item_name || '-'}</div>
        </td>
        <td style="padding:${pdfRowPad};text-align:center;border:1px solid #dbe4f0;">${line.quantity}</td>
        <td style="padding:${pdfRowPad};text-align:right;border:1px solid #dbe4f0;">${money(line.refund_unit_price)}</td>
        <td style="padding:${pdfRowPad};text-align:right;border:1px solid #dbe4f0;color:#166534;font-weight:700;">${amount}</td>
        <td style="padding:${pdfRowPad};border:1px solid #dbe4f0;">${line.note || '-'}</td>
      </tr>`
    }).join('')

    if (isPslSupplier) {
      printable.innerHTML = `
        <div style="display:grid;grid-template-columns:190px 1fr;gap:22px;align-items:start;margin-top:2px;margin-bottom:8px;">
          <div style="display:flex;justify-content:flex-start;">
            <img src="/psl-logo.png" alt="Princes Linen Services" style="height:58px;width:auto;object-fit:contain;" />
          </div>
          <div>
            <div style="font-size:${pdfCompact ? 24 : 28}px;font-weight:800;color:#111827;text-align:center;margin-top:4px;letter-spacing:0.4px;">CUSTOMER LINEN RETURN FORM</div>
            <div style="margin-top:8px;text-align:center;font-size:11px;color:#4b5563;line-height:1.5;">
              Please email this linen return form to <strong>orders@pslaundry.com.au</strong><br />
              If needed, contact PSL on <strong>(03) 9791 8344</strong>
            </div>
          </div>
        </div>
        <div style="margin-top:18px;display:grid;grid-template-columns:1fr 1fr;gap:18px;font-size:${pdfCompact ? 13 : 14}px;">
          <div style="display:grid;gap:10px;">
            <div><strong>Customer:</strong> MZ PROPERTY</div>
            <div><strong>Acct No:</strong> 6354</div>
            <div><strong>Contact name:</strong> MZ Property Team</div>
            <div><strong>Returned by:</strong> MZ Property</div>
          </div>
          <div style="display:grid;gap:10px;">
            <div><strong>Today's Date:</strong> ${row.returned_at ? dayjs(row.returned_at).format('YYYY-MM-DD') : '-'}</div>
            <div><strong>Date Returned:</strong> ${row.returned_at ? dayjs(row.returned_at).format('YYYY-MM-DD') : '-'}</div>
            <div><strong>Return Day:</strong> ${pslDeliveryWeekday || '-'}</div>
            <div><strong>Comments:</strong> ${row.note || ''}</div>
          </div>
        </div>
        <div style="margin-top:14px;display:grid;grid-template-columns:repeat(7, 1fr);gap:6px;font-size:11px;color:#4b5563;">
          ${['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'].map((day) => `
            <div style="text-align:center;padding:6px 4px;border:1px solid #d1d5db;border-radius:999px;background:${day === pslDeliveryWeekday ? '#dbeafe' : '#fff'};color:${day === pslDeliveryWeekday ? '#1d4ed8' : '#4b5563'};font-weight:${day === pslDeliveryWeekday ? 700 : 500};">${day}</div>
          `).join('')}
        </div>
        <div style="margin-top:16px;border-top:2px solid #111827;"></div>
        <div style="margin-top:16px;">
          <table style="width:100%;border-collapse:collapse;font-size:${pdfCompact ? 13 : 14}px;">
            <thead>
              <tr style="background:#f3f4f6;">
                <th style="padding:10px 12px;text-align:left;border:1px solid #d1d5db;width:100px;">CODE</th>
                <th style="padding:10px 12px;text-align:left;border:1px solid #d1d5db;">ITEM DESCRIPTION</th>
                <th style="padding:10px 12px;text-align:center;border:1px solid #d1d5db;width:120px;">QTY</th>
                <th style="padding:10px 12px;text-align:right;border:1px solid #d1d5db;width:120px;">UNIT PRICE</th>
                <th style="padding:10px 12px;text-align:right;border:1px solid #d1d5db;width:140px;">AMOUNT</th>
              </tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </div>
        <div style="margin-top:${pdfCompact ? 14 : 22}px;border:1px solid #dbeafe;border-radius:18px;padding:${pdfCompact ? '12px 16px' : '16px 22px'};background:#f8fbff;display:flex;align-items:center;justify-content:space-between;gap:24px;">
          <div style="display:grid;gap:6px;">
            <div style="font-size:${pdfCompact ? 16 : 18}px;font-weight:800;color:#16385f;">Return Total</div>
            <div style="color:#64748b;font-size:${pdfCompact ? 12 : 13}px;">Quantity: ${Number(row.quantity_total || 0)}</div>
          </div>
          <div style="padding:${pdfCompact ? '7px 14px' : '10px 18px'};border-radius:999px;background:#ecfdf5;color:#166534;font-size:${pdfCompact ? 18 : 22}px;font-weight:800;">
            ${money(row.amount_total, { withCurrency: true })}
          </div>
        </div>
        <div style="margin-top:auto;padding-top:14px;border-top:1px solid #e5e7eb;color:#64748b;font-size:12px;">
          <div>Customer: MZ PROPERTY</div>
          <div style="margin-top:4px;">Return Reference: ${displayReturnNo(row)}</div>
        </div>
      `
    } else {
      printable.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:24px;">
          <div>
            <img src="/mz-logo.png" alt="MZ Logo" style="height:${pdfCompact ? 52 : 64}px;width:auto;object-fit:contain;" />
            <div style="margin-top:${pdfCompact ? 6 : 10}px;font-size:${pdfCompact ? 15 : 17}px;font-weight:700;color:#16385f;">MZ Property linen Return</div>
            <div style="margin-top:4px;font-size:11px;color:#7c8aa5;">MZ Property 床品退货单</div>
          </div>
          <div style="text-align:right;">
            <div style="line-height:1.15;text-align:right;">
              <div style="font-size:13px;font-weight:700;color:#16385f;">Return Reference</div>
              <div style="margin-top:3px;font-size:10px;color:#8fa6c5;letter-spacing:0.2px;">退货单号</div>
            </div>
            <div style="margin-top:${pdfCompact ? 6 : 10}px;display:inline-block;padding:${pdfCompact ? '7px 12px' : '10px 18px'};border-radius:999px;border:1px solid #bfdbfe;background:#eff6ff;font-size:${pdfCompact ? 17 : 20}px;font-weight:700;color:#1d4ed8;">
              ${displayReturnNo(row)}
            </div>
          </div>
        </div>
        <div style="margin-top:${pdfCompact ? 10 : 16}px;border-top:4px solid #16385f;"></div>
        <div style="text-align:center;margin-top:${pdfCompact ? 14 : 24}px;">
          <div style="font-size:${pdfCompact ? 25 : 36}px;font-weight:800;letter-spacing:1px;color:#16385f;">LINEN RETURN NOTE</div>
          <div style="margin-top:${pdfCompact ? 4 : 8}px;color:#64748b;font-size:${pdfCompact ? 10 : 11}px;letter-spacing:0.3px;">供应商退货凭证 / 床品协同单</div>
        </div>
        <div style="margin-top:${pdfCompact ? 12 : 22}px;padding-top:${pdfCompact ? 10 : 18}px;border-top:1px dashed #cbd5e1;">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:${pdfCardGap}px;">
            <div style="border:1px solid #dbe4f0;border-radius:20px;padding:${pdfCardPadding}px;background:#f8fbff;">
              <div style="margin-bottom:${pdfCompact ? 10 : 16}px;">
                <div style="line-height:1.15;"><div style="font-size:16px;font-weight:800;color:#16385f;">Supplier Details</div><div style="margin-top:4px;font-size:11px;color:#8fa6c5;">供应信息</div></div>
              </div>
              <div style="display:grid;gap:${pdfMetaGap}px;font-size:${pdfCompact ? 12 : 15}px;">
                <div><span style="display:inline-block;width:96px;color:#64748b;font-weight:600;">Supplier</span><strong>${row.supplier_name || '-'}</strong></div>
                <div><span style="display:inline-block;width:96px;color:#64748b;font-weight:600;">Status</span><span>已退货</span></div>
                <div><span style="display:inline-block;width:96px;color:#64748b;font-weight:600;">Notes</span>${hasPdfNotes ? row.note : '-'}</div>
              </div>
            </div>
            <div style="border:1px solid #dbe4f0;border-radius:20px;padding:${pdfCardPadding}px;background:#f8fbff;">
              <div style="margin-bottom:${pdfCompact ? 10 : 16}px;">
                <div style="line-height:1.15;"><div style="font-size:16px;font-weight:800;color:#16385f;">Dates & Warehouse</div><div style="margin-top:4px;font-size:11px;color:#8fa6c5;">日期与仓库</div></div>
              </div>
              <div style="display:grid;gap:${pdfMetaGap}px;font-size:${pdfCompact ? 12 : 15}px;">
                <div><span style="display:inline-block;width:110px;color:#64748b;font-weight:600;">Return Date</span><strong>${row.returned_at ? dayjs(row.returned_at).format('YYYY-MM-DD') : '-'}</strong></div>
                <div><span style="display:inline-block;width:110px;color:#64748b;font-weight:600;">Warehouse</span><strong>${row.warehouse_code} - ${row.warehouse_name}</strong></div>
                <div><span style="display:inline-block;width:110px;color:#64748b;font-weight:600;">Photos</span><strong>${Array.isArray(row.photo_urls) ? row.photo_urls.length : 0}</strong></div>
              </div>
            </div>
          </div>
        </div>
        <div style="margin-top:${pdfCompact ? 14 : 24}px;">
          <table style="width:100%;border-collapse:collapse;font-size:${pdfTableFontSize}px;">
            <thead>
              <tr style="background:#16385f;color:#fff;">
                <th style="padding:${pdfHeaderPad};text-align:left;">Code / Name</th>
                <th style="padding:${pdfHeaderPad};text-align:center;width:90px;">Qty</th>
                <th style="padding:${pdfHeaderPad};text-align:right;width:120px;">Unit Price</th>
                <th style="padding:${pdfHeaderPad};text-align:right;width:140px;">Amount</th>
                <th style="padding:${pdfHeaderPad};text-align:left;width:140px;">Notes</th>
              </tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </div>
          <div style="margin-top:${pdfCompact ? 14 : 22}px;border:1px solid #dbeafe;border-radius:18px;padding:${pdfCompact ? '12px 16px' : '16px 22px'};background:#f8fbff;display:flex;align-items:center;justify-content:space-between;gap:24px;">
          <div style="display:grid;gap:6px;">
            <div style="font-size:${pdfCompact ? 16 : 18}px;font-weight:800;color:#16385f;">Return Total</div>
            <div style="color:#64748b;font-size:${pdfCompact ? 12 : 13}px;">Quantity: ${Number(row.quantity_total || 0)}</div>
          </div>
          <div style="padding:${pdfCompact ? '7px 14px' : '10px 18px'};border-radius:999px;background:#ecfdf5;color:#166534;font-size:${pdfCompact ? 18 : 22}px;font-weight:800;">
            ${money(row.amount_total, { withCurrency: true })}
          </div>
        </div>
        <div style="margin-top:auto;padding-top:${pdfCompact ? 10 : 18}px;border-top:1px solid #e2e8f0;display:flex;justify-content:space-between;gap:16px;color:#64748b;font-size:${pdfCompact ? 12 : 14}px;">
          <div>
            <div style="font-size:${pdfCompact ? 12 : 13}px;font-weight:600;color:#64748b;">Settlement Currency</div>
            <div style="margin-top:2px;font-size:10px;color:#94a3b8;">结算币种</div>
            <div style="margin-top:2px;">Australian Dollar (AUD)</div>
          </div>
          <div style="text-align:right;">
            <div style="font-size:${pdfCompact ? 12 : 13}px;font-weight:600;color:#64748b;">Tracking Reference</div>
            <div style="margin-top:2px;font-size:10px;color:#94a3b8;">退货跟踪号</div>
            <div style="margin-top:2px;">${displayReturnNo(row)}</div>
          </div>
        </div>
      `
    }

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
      cloneWrap.appendChild(printable)
      document.body.appendChild(cloneWrap)
      const canvas = await html2canvas(printable, {
        scale: 2,
        backgroundColor: '#ffffff',
        useCORS: true,
        width: PDF_PAGE_WIDTH,
        height: PDF_PAGE_HEIGHT,
        windowWidth: PDF_PAGE_WIDTH,
        windowHeight: PDF_PAGE_HEIGHT,
      })
      const img = canvas.toDataURL('image/png')
      const pdf = new jsPDF('p', 'mm', 'a4')
      const pageWidth = pdf.internal.pageSize.getWidth()
      const pageHeight = pdf.internal.pageSize.getHeight()
      pdf.addImage(img, 'PNG', 0, 0, pageWidth, pageHeight)
      pdf.save(`${displayReturnNo(row) || `linen-return-${dayjs(row.returned_at || row.id).format('YYYYMMDD')}`}.pdf`)
    } finally {
      if (cloneWrap?.parentNode) cloneWrap.parentNode.removeChild(cloneWrap)
    }
  }

  return (
    <>
      <Card
        title="床品退货记录"
        extra={<Button type="primary" onClick={openCreateModal}>新增退货</Button>}
      >
        <Table
          rowKey={(r) => r.id}
          dataSource={rows}
          columns={[
            { title: '退货单号', render: (_: any, row: ReturnBatch) => displayReturnNo(row) },
            { title: '退回日期', dataIndex: 'returned_at', render: (v: string) => formatDateTime(v) },
            { title: '供应商', dataIndex: 'supplier_name' },
            {
              title: '退货明细',
              render: (_: any, row: ReturnBatch) => (
                <div style={{ minWidth: 260 }}>
                  {(row.lines || []).length ? (
                    (row.lines || []).map((line, idx) => (
                      <div key={`${row.id}-${line.id || idx}`}>
                        {line.item_name || '-'} x {Number(line.quantity || 0)}，{money(line.refund_unit_price)} / 件
                      </div>
                    ))
                  ) : (
                    <span>-</span>
                  )}
                </div>
              ),
            },
            { title: '总数量', dataIndex: 'quantity_total' },
            { title: '总金额', dataIndex: 'amount_total', render: (v: number) => money(v, { withCurrency: true }) },
            {
              title: '退货照片',
              render: (_: any, row: ReturnBatch) => {
                const photos = Array.isArray(row.photo_urls) ? row.photo_urls.filter(Boolean) : []
                if (!photos.length) return <span>-</span>
                return (
                  <Image.PreviewGroup>
                    <Space size={8} wrap>
                      {photos.slice(0, 3).map((url, idx) => (
                        <Image key={`${row.id}-${idx}`} src={url} alt={`退货照片${idx + 1}`} width={56} height={56} style={{ objectFit: 'cover', borderRadius: 8 }} />
                      ))}
                      {photos.length > 3 ? <Tag color="blue">共 {photos.length} 张</Tag> : null}
                    </Space>
                  </Image.PreviewGroup>
                )
              },
            },
            { title: '备注', dataIndex: 'note', render: (v: string | null | undefined) => v || '-' },
            {
              title: '操作',
              width: 280,
              render: (_: any, row: ReturnBatch) => (
                <Space size={8}>
                  <Button onClick={() => setViewingRow(row)}>详情</Button>
                  <Button onClick={() => openEditModal(row)}>编辑</Button>
                  <Popconfirm title="确定删除这条退货记录吗？" onConfirm={() => deleteReturn(row)}>
                    <Button danger>删除</Button>
                  </Popconfirm>
                  <Button onClick={() => downloadReturnSheet(row)}>下载</Button>
                </Space>
              ),
            },
          ]}
          pagination={{ pageSize: 20 }}
        />
      </Card>

      <Drawer
        open={open}
        title={editingRow?.id ? '编辑退货' : '新增退货'}
        width={880}
        onClose={() => { setOpen(false); setEditingRow(null) }}
        extra={
          <Space>
            <Button onClick={() => { setOpen(false); setEditingRow(null) }}>取消</Button>
            <Button type="primary" loading={submitting} onClick={() => submitReturn().catch(() => {})}>保存</Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical">
          <Space wrap style={{ width: '100%' }}>
            <Form.Item name="returned_at" label="退回日期" rules={[{ required: true, message: '请选择退回日期' }]} style={{ minWidth: 240 }}>
              <DatePicker showTime style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="supplier_id" label="退还供应商" rules={[{ required: true, message: '请选择供应商' }]} style={{ minWidth: 280 }}>
              <Select showSearch optionFilterProp="label" options={supplierOptions} onChange={(value) => syncAllRefundPrices(String(value || ''))} />
            </Form.Item>
          </Space>
          <Form.List name="lines" rules={[{ validator: async (_: any, value: any[]) => { if (!value || value.length < 1) throw new Error('至少填写一条退货明细') } }]}>
            {(fields, { add, remove }) => (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                  <div style={{ fontWeight: 600 }}>退货明细</div>
                  <Button
                    type="dashed"
                    shape="circle"
                    icon={<PlusOutlined />}
                    onClick={() => add({ quantity: 1, refund_unit_price: 0 })}
                    aria-label="新增床品"
                  />
                </div>
                <div style={{ border: '1px solid #f0f0f0', borderRadius: 12, padding: 16, background: '#fafafa' }}>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'minmax(280px, 2.4fr) 120px 160px minmax(180px, 1.4fr) 40px',
                      gap: 8,
                      alignItems: 'center',
                      padding: '0 0 8px',
                      marginBottom: 12,
                      borderBottom: '1px solid #f0f0f0',
                      fontSize: 13,
                      fontWeight: 600,
                      color: 'rgba(0,0,0,0.72)',
                    }}
                  >
                    <div>床品类型</div>
                    <div>数量</div>
                    <div>退货价格</div>
                    <div>备注</div>
                    <div />
                  </div>
                  {fields.map((field, index) => (
                    <div
                      key={field.key}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'minmax(280px, 2.4fr) 120px 160px minmax(180px, 1.4fr) 40px',
                        gap: 8,
                        alignItems: 'start',
                        paddingBottom: index === fields.length - 1 ? 0 : 12,
                        marginBottom: index === fields.length - 1 ? 0 : 12,
                        borderBottom: index === fields.length - 1 ? 'none' : '1px solid #f0f0f0',
                      }}
                    >
                      <Form.Item {...field} name={[field.name, 'item_id']} rules={[{ required: true, message: '请选择床品类型' }]} style={{ marginBottom: 0 }}>
                        <Select
                          showSearch
                          optionFilterProp="label"
                          options={itemOptions}
                          placeholder="选择床品类型"
                          onChange={(value) => syncLineRefundPrice(field.name, String(value || ''))}
                        />
                      </Form.Item>
                      <Form.Item {...field} name={[field.name, 'quantity']} rules={[{ required: true, message: '请输入数量' }]} style={{ marginBottom: 0 }}>
                        <InputNumber min={1} precision={0} style={{ width: '100%' }} placeholder="数量" />
                      </Form.Item>
                      <Form.Item {...field} name={[field.name, 'refund_unit_price']} style={{ marginBottom: 0 }}>
                        <InputNumber min={0} precision={2} style={{ width: '100%' }} disabled controls={false} placeholder="退货价格" />
                      </Form.Item>
                      <Form.Item {...field} name={[field.name, 'note']} style={{ marginBottom: 0 }}>
                        <Input placeholder="可选" />
                      </Form.Item>
                      <div style={{ display: 'flex', justifyContent: 'center' }}>
                        <Button type="text" danger icon={<DeleteOutlined />} onClick={() => remove(field.name)} />
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </Form.List>
          <Form.Item name="note" label="整单备注" style={{ marginTop: 16 }}>
            <Input.TextArea rows={3} placeholder="可填写本次退货说明" />
          </Form.Item>
          <Form.Item label="退货照片">
            <Upload {...uploadProps}>
              <div>{uploading ? '上传中...' : '上传照片'}</div>
            </Upload>
          </Form.Item>
        </Form>
      </Drawer>

      <Drawer
        open={!!viewingRow}
        title="退货详情"
        onClose={() => setViewingRow(null)}
        width={920}
        extra={
          <Space>
            <Button onClick={() => setViewingRow(null)}>取消</Button>
            <Button
              type="primary"
              onClick={() => {
                if (!viewingRow) return
                const row = viewingRow
                setViewingRow(null)
                openEditModal(row)
              }}
            >
              编辑
            </Button>
          </Space>
        }
      >
        {viewingRow ? (
          <>
            <Descriptions bordered size="small" column={2} style={{ marginBottom: 16 }}>
              <Descriptions.Item label="退回日期">{formatDateTime(viewingRow.returned_at)}</Descriptions.Item>
              <Descriptions.Item label="供应商">{viewingRow.supplier_name || '-'}</Descriptions.Item>
              <Descriptions.Item label="退货单号">{displayReturnNo(viewingRow)}</Descriptions.Item>
              <Descriptions.Item label="状态">已退货</Descriptions.Item>
              <Descriptions.Item label="总数量">{Number(viewingRow.quantity_total || 0)}</Descriptions.Item>
              <Descriptions.Item label="总金额">{money(viewingRow.amount_total, { withCurrency: true })}</Descriptions.Item>
              <Descriptions.Item label="备注" span={2}>{viewingRow.note || '-'}</Descriptions.Item>
            </Descriptions>
            <Table
              rowKey={(r) => `${r.id || r.item_id}-${r.note || ''}`}
              dataSource={viewingRow.lines || []}
              pagination={false}
              columns={[
                { title: '床品类型', dataIndex: 'item_name' },
                { title: 'SKU', dataIndex: 'item_sku' },
                { title: '数量', dataIndex: 'quantity' },
                { title: '退货价格', dataIndex: 'refund_unit_price', render: (v: number) => money(v) },
                { title: '金额', dataIndex: 'amount_total', render: (v: number) => money(v) },
                { title: '备注', dataIndex: 'note', render: (v: string | null | undefined) => v || '-' },
              ]}
            />
            <div style={{ marginTop: 16 }}>
              <div style={{ fontWeight: 600, marginBottom: 8 }}>退货照片</div>
              {Array.isArray(viewingRow.photo_urls) && viewingRow.photo_urls.length ? (
                <Image.PreviewGroup>
                  <Space wrap>
                    {viewingRow.photo_urls.map((url, idx) => (
                      <Image key={`${viewingRow.id}-detail-${idx}`} src={url} alt={`退货照片${idx + 1}`} width={88} height={88} style={{ objectFit: 'cover', borderRadius: 8 }} />
                    ))}
                  </Space>
                </Image.PreviewGroup>
              ) : (
                <span style={{ color: 'rgba(0,0,0,0.45)' }}>暂无照片</span>
              )}
            </div>
          </>
        ) : null}
      </Drawer>
    </>
  )
}
