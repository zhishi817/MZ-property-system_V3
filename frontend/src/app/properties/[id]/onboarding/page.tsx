"use client"
import { Card, Tabs, Form, Input, DatePicker, Button, Select, Table, InputNumber, Space, message, Upload, Switch, Tag, Drawer, Modal, Tooltip, Popconfirm } from 'antd'
import { ArrowLeftOutlined, DeleteOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { API_BASE, getJSON, postJSON, patchJSON, authHeaders } from '../../../../lib/api'
import html2canvas from 'html2canvas'
import { jsPDF } from 'jspdf'
import { zhToEn } from '../../../../lib/translator'

type Onb = { id: string; property_id: string; address_snapshot?: string; owner_user_id?: string; onboarding_date?: string; status?: string; remark?: string; daily_items_total?: number; furniture_appliance_total?: number; decor_total?: number; oneoff_fees_total?: number; grand_total?: number }
type PriceItem = { id: string; category?: string; item_name: string; unit_price: number; unit?: string; default_quantity?: number }
type Item = { id: string; onboarding_id: string; group: 'daily'|'furniture'|'appliance'|'decor'; category?: string; item_name: string; brand?: string; condition?: 'New'|'Used'; quantity: number; unit_price: number; total_price: number; is_custom?: boolean; remark?: string }
type Fee = { id: string; onboarding_id: string; fee_type: string; name: string; unit_price: number; quantity: number; total_price: number; include_in_property_cost: boolean; waived?: boolean }

export default function PropertyOnboardingPage({ params }: { params: { id: string } }) {
  const pid = params.id
  const router = useRouter()
  const [onb, setOnb] = useState<Onb | null>(null)
  const [prices, setPrices] = useState<PriceItem[]>([])
  const [items, setItems] = useState<Item[]>([])
  const [fees, setFees] = useState<Fee[]>([])
  const itemsOrderRef = useRef<string[]>([])
  const feesOrderRef = useRef<string[]>([])
  const [feeUpdating, setFeeUpdating] = useState<Record<string, boolean>>({})
  const [formBasic] = Form.useForm()
  const [attach, setAttach] = useState<any[]>([])
  const [prop, setProp] = useState<{ id: string; code?: string; address?: string } | null>(null)
  const printRef = useRef<HTMLDivElement>(null)

  async function ensureOnboarding() {
    const list = await getJSON<Onb[]>(`/onboarding?property_id=${encodeURIComponent(pid)}`).catch(()=>[])
    let row = list?.[0] || null
    if (!row) row = await postJSON<Onb>('/onboarding', { property_id: pid })
    setOnb(row)
    formBasic.setFieldsValue({ onboarding_date: row.onboarding_date ? dayjs(row.onboarding_date) : dayjs(), remark: row.remark })
    await refreshData(row.id)
  }
  async function refreshData(onbId?: string) {
    const id = onbId || onb?.id
    if (!id) return
    const [it, fe, ob, at] = await Promise.all([
      getJSON<Item[]>(`/onboarding/${id}/items`),
      getJSON<Fee[]>(`/onboarding/${id}/fees`),
      getJSON<Onb>(`/onboarding/${id}`),
      getJSON<any[]>(`/onboarding/${id}/attachments`).catch(()=>[]),
    ])
    const srcItems = it || []
    const srcFees = fe || []
    if (itemsOrderRef.current.length === 0) itemsOrderRef.current = srcItems.map(i=>i.id)
    const sortedItems = srcItems.slice().sort((a,b)=>{
      const ia = itemsOrderRef.current.indexOf(a.id)
      const ib = itemsOrderRef.current.indexOf(b.id)
      if (ia !== -1 && ib !== -1) return ia - ib
      if (ia !== -1) return -1
      if (ib !== -1) return 1
      return 0
    })
    itemsOrderRef.current = sortedItems.map(i=>i.id)
    setItems(sortedItems)
    if (feesOrderRef.current.length === 0) feesOrderRef.current = srcFees.map(f=>f.id)
    const sortedFees = srcFees.slice().sort((a,b)=>{
      const ia = feesOrderRef.current.indexOf(a.id)
      const ib = feesOrderRef.current.indexOf(b.id)
      if (ia !== -1 && ib !== -1) return ia - ib
      if (ia !== -1) return -1
      if (ib !== -1) return 1
      return 0
    })
    feesOrderRef.current = sortedFees.map(f=>f.id)
    setFees(sortedFees)
    setOnb(ob || onb)
    setAttach(at || [])
  }
  useEffect(() => { ensureOnboarding().catch(()=>{}); getJSON<PriceItem[]>('/onboarding/daily-items-prices').then(setPrices).catch(()=>setPrices([])); getJSON<{id:string,code?:string,address?:string}>(`/properties/${encodeURIComponent(pid)}`).then(setProp).catch(()=>setProp(null)) }, [pid])

  const totals = useMemo(() => {
    const sumDaily = items.filter(i=>i.group==='daily').reduce((s,i)=> s + Number(i.total_price||0), 0)
    const sumFurn = items.filter(i=>i.group==='furniture' || i.group==='appliance').reduce((s,i)=> s + Number(i.total_price||0), 0)
    const sumDecor = items.filter(i=>i.group==='decor').reduce((s,i)=> s + Number(i.total_price||0), 0)
    const sumFees = fees.reduce((s,f)=> s + (f.waived ? 0 : Number(f.total_price||0)), 0)
    const sumGrand = sumDaily + sumFurn + sumDecor + fees.filter(f=>f.include_in_property_cost).reduce((s,f)=> s + (f.waived ? 0 : Number(f.total_price||0)), 0)
    return { sumDaily, sumFurn, sumDecor, sumFees, sumGrand }
  }, [items, fees])

  const fmtCurrency = (n: number | string | undefined) => new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(Number(n || 0))

  async function saveBasic() {
    if (!onb) return
    const v = await formBasic.validateFields()
    const payload = { onboarding_date: v.onboarding_date ? v.onboarding_date.format('YYYY-MM-DD') : undefined, remark: v.remark }
    await patchJSON(`/onboarding/${onb.id}`, payload)
    message.success('已保存基础信息')
  }

  // daily item add
  const [dailyCat, setDailyCat] = useState<string | undefined>(undefined)
  const [selectedPriceIds, setSelectedPriceIds] = useState<string[]>([])
  const [qtyMap, setQtyMap] = useState<Record<string, number>>({})
  const [blinkIds, setBlinkIds] = useState<Record<string, boolean>>({})
  function blink(id: string) {
    setBlinkIds((m) => ({ ...m, [id]: true }))
    setTimeout(() => { setBlinkIds((m) => ({ ...m, [id]: false })) }, 300)
  }

  async function optimisticSetItemQuantity(r: Item, nq: number) {
    const prevQ = Number(r.quantity || 0)
    const newQ = Math.max(1, Number(nq || 1))
    blink(r.id)
    setItems((arr) => arr.map((it) => it.id === r.id ? { ...it, quantity: newQ, total_price: Number(it.unit_price || 0) * newQ } : it))
    try {
      await patchJSON(`/onboarding/${r.onboarding_id}/items/${r.id}`, { quantity: newQ })
    } catch (e) {
      setItems((arr) => arr.map((it) => it.id === r.id ? { ...it, quantity: prevQ, total_price: Number(it.unit_price || 0) * prevQ } : it))
      message.error('更新失败')
    }
  }
  useEffect(() => {
    const filtered = prices.filter(p => !dailyCat || p.category === dailyCat)
    const init: Record<string, number> = {}
    filtered.forEach(p => { init[p.id] = Number(p.default_quantity || 1) })
    setQtyMap(init)
    setSelectedPriceIds([])
  }, [dailyCat, prices])
  async function addSelectedDailyItems() {
    if (!onb || !selectedPriceIds.length) { message.warning('请先勾选日用品'); return }
    const filtered = prices.filter(p => selectedPriceIds.includes(p.id))
    const errors: string[] = []
    await Promise.all(filtered.map(async (p) => {
      const q = qtyMap[p.id] != null ? Number(qtyMap[p.id]) : Number(p.default_quantity || 1)
      const payload = { group:'daily', category: p.category || dailyCat, item_name: p.item_name, quantity: q, unit_price: Number(p.unit_price || 0), price_list_id: p.id }
      try { await postJSON(`/onboarding/${onb!.id}/items`, payload) } catch (e: any) { errors.push(`${p.item_name}: ${e?.message || '添加失败'}`) }
    }))
    setSelectedPriceIds([])
    await refreshData(onb.id)
    if (errors.length) message.error(errors.join('\n'))
    else message.success('已添加所选日用品')
  }

  // furniture/appliance/decor add (simplified)
  const [faGroup, setFaGroup] = useState<'furniture'|'appliance'|'decor'>('appliance')
  const [faPrices, setFaPrices] = useState<any[]>([])
  const [faSelectedIds, setFaSelectedIds] = useState<string[]>([])
  const [faQtyMap, setFaQtyMap] = useState<Record<string, number>>({})
  useEffect(() => { (async () => { try { const list = await getJSON<any[]>(`/onboarding/fa-items-prices?grp=${encodeURIComponent(faGroup)}`); setFaPrices(list || []); const init: Record<string, number> = {}; (list||[]).forEach((p: any)=> { init[p.id] = Number(p.default_quantity || 1) }); setFaQtyMap(init); setFaSelectedIds([]) } catch { setFaPrices([]) } })() }, [faGroup])
  async function addSelectedFAItems() {
    if (!onb || !faSelectedIds.length) { message.warning('请先勾选'); return }
    const filtered = faPrices.filter((p: any) => faSelectedIds.includes(p.id))
    await Promise.all(filtered.map(async (p: any) => {
      const q = faQtyMap[p.id] != null ? Number(faQtyMap[p.id]) : Number(p.default_quantity || 1)
      const payload = { group: (faGroup as any), item_name: p.item_name, quantity: q, unit_price: Number(p.unit_price || 0), price_list_id: p.id, condition: 'New' as any }
      try { await postJSON(`/onboarding/${onb!.id}/items`, payload) } catch {}
    }))
    setFaSelectedIds([])
    await refreshData(onb.id)
  }

  // decor simple add states
  const [decorName, setDecorName] = useState<string | undefined>(undefined)
  const [decorUnitPrice, setDecorUnitPrice] = useState<number>(0)
  const [decorQty, setDecorQty] = useState<number>(1)

  // fees add
  const [feeType, setFeeType] = useState<string>('平台上线费')
  const [feeName, setFeeName] = useState<string>('')
  const [feeUnit, setFeeUnit] = useState<number>(0)
  const [feeQty, setFeeQty] = useState<number>(1)
  const [feeInclude, setFeeInclude] = useState<boolean>(true)
  async function addFee() {
    if (!onb) return
    if (feeType === '其他' && !feeName) { message.warning('请输入费用名称'); return }
    const payload = { fee_type: feeType, name: (feeType === '其他' ? feeName : feeType), unit_price: feeUnit, quantity: feeQty, include_in_property_cost: feeInclude }
    await postJSON(`/onboarding/${onb.id}/fees`, payload)
    setFeeName(''); setFeeUnit(0); setFeeQty(1)
    await refreshData(onb.id)
  }

  async function uploadAttachments(fileList: any[]) {
    if (!onb) return
    const fd = new FormData()
    fileList.forEach((f: any) => fd.append('files', f as any))
    const res = await fetch(`${API_BASE}/onboarding/${onb.id}/attachments/upload`, { method: 'POST', headers: { ...authHeaders() }, body: fd })
    if (!res.ok) { message.error('上传失败'); return }
    message.success('已上传')
  }

  async function generatePdfPreview() {
    const node = (modalRef.current || printRef.current) as HTMLElement
    if (!onb || !node) return
    const canvas = await html2canvas(node, { scale: 2, useCORS: true, allowTaint: true, backgroundColor: '#ffffff' })
    const pdf = new jsPDF('p', 'mm', 'a4')
    const margin = 10
    const pageWmm = pdf.internal.pageSize.getWidth() - margin * 2
    const pageHmm = pdf.internal.pageSize.getHeight() - margin * 2
    const pxPerMm = canvas.width / pageWmm
    const pageHPx = Math.floor(pageHmm * pxPerMm)
    const baseRect = node.getBoundingClientRect()
    const scaleFactor = canvas.width / Math.max(1, (node.scrollWidth || node.clientWidth))
    const rows: Array<{ top: number; bottom: number }> = []
    node.querySelectorAll('table tr').forEach((el) => {
      const r = (el as HTMLElement).getBoundingClientRect()
      const top = Math.max(0, Math.round((r.top - baseRect.top) * scaleFactor))
      const bottom = Math.max(top + Math.round(r.height * scaleFactor), Math.round((r.bottom - baseRect.top) * scaleFactor))
      if (bottom > top) rows.push({ top, bottom })
    })
    const blocks: number[] = []
    node.querySelectorAll('[data-pdf-block]').forEach((el) => {
      const r = (el as HTMLElement).getBoundingClientRect()
      const b = Math.max(0, Math.round((r.bottom - baseRect.top) * scaleFactor))
      blocks.push(b)
    })
    const mainCtx = canvas.getContext('2d')!
    const tfoots: Array<{ top: number; bottom: number }> = []
    node.querySelectorAll('table tfoot').forEach((el) => {
      const r = (el as HTMLElement).getBoundingClientRect()
      const top = Math.max(0, Math.round((r.top - baseRect.top) * scaleFactor))
      const bottom = Math.max(top + Math.round(r.height * scaleFactor), Math.round((r.bottom - baseRect.top) * scaleFactor))
      if (bottom > top) tfoots.push({ top, bottom })
    })
    const subtotals: Array<{ top: number; bottom: number }> = []
    node.querySelectorAll('.subtotalBar').forEach((el) => {
      const r = (el as HTMLElement).getBoundingClientRect()
      const top = Math.max(0, Math.round((r.top - baseRect.top) * scaleFactor))
      const bottom = Math.max(top + Math.round(r.height * scaleFactor), Math.round((r.bottom - baseRect.top) * scaleFactor))
      if (bottom > top) subtotals.push({ top, bottom })
    })
    const blockTitleInfos: Array<{ top: number; needH: number }> = []
    const blockTitles = Array.from(node.querySelectorAll('.blockTitle')) as HTMLElement[]
    for (const t of blockTitles) {
      const table = t.parentElement?.querySelector('.itemsTable') as HTMLElement | null
      if (!table) continue
      const thead = table.querySelector('thead') as HTMLElement | null
      const two = Array.from(table.querySelectorAll('tbody tr')).slice(0, 2) as HTMLElement[]
      const needH = ((thead?.getBoundingClientRect().height || 0) + two.reduce((s, r) => s + r.getBoundingClientRect().height, 0)) * scaleFactor
      const r = t.getBoundingClientRect()
      const top = Math.max(0, Math.round((r.top - baseRect.top) * scaleFactor))
      blockTitleInfos.push({ top, needH })
    }
    const groupHeaderInfos: Array<{ top: number; needH: number }> = []
    const dailyTables = Array.from(node.querySelectorAll('.itemsTable[data-kind="daily"]')) as HTMLElement[]
    for (const tb of dailyTables) {
      const headers = Array.from(tb.querySelectorAll('tr.groupHeader')) as HTMLTableRowElement[]
      for (const h of headers) {
        const r = h.getBoundingClientRect()
        const top = Math.max(0, Math.round((r.top - baseRect.top) * scaleFactor))
        const following: HTMLTableRowElement[] = []
        let el: Element | null = h.nextElementSibling
        while (el && following.length < 2) {
          if ((el as HTMLTableRowElement).classList.contains('groupHeader')) break
          following.push(el as HTMLTableRowElement)
          el = el.nextElementSibling
        }
        const needH = following.reduce((s, row) => s + (row.getBoundingClientRect().height * scaleFactor), 0)
        groupHeaderInfos.push({ top, needH })
      }
    }
    const grandBars: Array<{ top: number; bottom: number }> = []
    node.querySelectorAll('.grandTotalBar').forEach((el) => {
      const r = (el as HTMLElement).getBoundingClientRect()
      const top = Math.max(0, Math.round((r.top - baseRect.top) * scaleFactor))
      const bottom = Math.max(top + Math.round(r.height * scaleFactor), Math.round((r.bottom - baseRect.top) * scaleFactor))
      if (bottom > top) grandBars.push({ top, bottom })
    })
    const findWhiteBreak = (start: number, maxH: number) => {
      try {
        const band = 80
        for (let dy = 0; dy < band; dy++) {
          const yRow = start + maxH - dy
          if (yRow <= start + 30) break
          const data = mainCtx.getImageData(0, yRow, canvas.width, 1).data
          let white = 0
          const step = Math.max(4, Math.floor((canvas.width * 4) / 200))
          for (let i = 0; i < data.length; i += step) {
            const r = data[i], g = data[i + 1], b = data[i + 2]
            if (r > 245 && g > 245 && b > 245) white++
          }
          const ratio = white / Math.ceil(data.length / step)
          if (ratio > 0.98) return maxH - dy
        }
      } catch {}
      return maxH
    }
    const chooseBreak = (start: number, maxH: number) => {
      const target = start + maxH
      const threshold = 140
      let best = -1
      // prefer block boundary
      for (const b of blocks) {
        if (b <= target - 6 && b >= target - threshold) {
          best = Math.max(best, b)
        }
      }
      // then prefer table row end
      for (const row of rows) {
        if (row.bottom <= target - 6 && row.bottom >= target - threshold) {
          best = Math.max(best, row.bottom)
        }
      }
      if (best > start) return best - start
      const wb = findWhiteBreak(start, maxH)
      // avoid breaking inside subtotal (tfoot)
      for (const tf of tfoots) {
        const cand = start + wb
        if (cand >= tf.top && cand <= tf.bottom) {
          const adj = tf.top - start - 2
          if (adj > 40) return adj
        }
      }
      for (const sb of subtotals) {
        const cand = start + wb
        if (cand >= sb.top && cand <= sb.bottom) {
          const adj = sb.top - start - 2
          if (adj > 40) return adj
        }
      }
      // enforce no-orphan for block titles (need header + 2 rows)
      for (const bt of blockTitleInfos) {
        if (bt.top >= start && bt.top <= target) {
          const remaining = target - bt.top
          if (remaining < bt.needH + 8) {
            const adj = bt.top - start - 2
            if (adj > 40) return adj
          }
        }
      }
      // enforce no-orphan for group headers (need 2 rows)
      for (const gh of groupHeaderInfos) {
        if (gh.top >= start && gh.top <= target) {
          const remaining = target - gh.top
          if (remaining < gh.needH + 8) {
            const adj = gh.top - start - 2
            if (adj > 40) return adj
          }
        }
      }
      if (wb >= maxH - threshold) return wb
      return maxH
    }
    let y = 0
    let pageIndex = 0
    const baseOverlapPx = Math.max(6, Math.round(6 * pxPerMm))
    const isMostlyWhite = (ctx: CanvasRenderingContext2D, h: number) => {
      try {
        const sampleH = Math.min(h, 120)
        const data = ctx.getImageData(0, Math.floor(h/2 - sampleH/2), Math.min(600, canvas.width), sampleH).data
        let white = 0
        const step = Math.max(4, Math.floor((canvas.width * 4) / 200))
        for (let i = 0; i < data.length; i += step) {
          const r = data[i], g = data[i+1], b = data[i+2]
          if (r > 245 && g > 245 && b > 245) white++
        }
        const ratio = white / Math.ceil(data.length / step)
        return ratio > 0.985
      } catch { return false }
    }
    while (y < canvas.height) {
      let sliceH = Math.min(pageHPx, canvas.height - y)
      sliceH = chooseBreak(y, sliceH)
      if (sliceH <= 0) break
      const sliceCanvas = document.createElement('canvas')
      sliceCanvas.width = canvas.width
      sliceCanvas.height = sliceH
      const ctx = sliceCanvas.getContext('2d')!
      ctx.drawImage(canvas, 0, y, canvas.width, sliceH, 0, 0, canvas.width, sliceH)
      if (pageIndex > 0) {
        const regionStart = y
        const regionEnd = y + sliceH
        const hasGrand = grandBars.some(b => b.top >= regionStart && b.top <= regionEnd)
        const hasContentRow = rows.some(r => r.top >= regionStart && r.top <= regionEnd)
        const hasBlockEdge = blocks.some(b => b >= regionStart && b <= regionEnd)
        const hasAny = hasGrand || hasContentRow || hasBlockEdge
        const mostlyWhite = isMostlyWhite(ctx, sliceH)
        const tinySlice = sliceH < Math.round(20 * pxPerMm)
        if (!hasAny || (mostlyWhite && !hasAny) || tinySlice) {
          break
        }
      }
      const imgData = sliceCanvas.toDataURL('image/png')
      if (pageIndex > 0) pdf.addPage()
      const imgHmm = sliceH / pxPerMm
      pdf.addImage(imgData, 'PNG', margin, margin, pageWmm, imgHmm)
      // small overlap only when the tail is mostly white (avoid duplicating colored subtotal bars)
      const tailSampleH = Math.min(24, sliceH)
      let tailNonWhite = 0
      try {
        const td = ctx.getImageData(0, sliceH - tailSampleH, Math.min(600, canvas.width), tailSampleH).data
        const step = Math.max(4, Math.floor((canvas.width * 4) / 200))
        for (let i = 0; i < td.length; i += step) {
          const r = td[i], g = td[i+1], b = td[i+2]
          if (!(r > 245 && g > 245 && b > 245)) tailNonWhite++
        }
      } catch {}
      const allowOverlap = tailNonWhite === 0
      const overlapPx = allowOverlap ? baseOverlapPx : 0
      y += Math.max(1, sliceH - overlapPx)
      pageIndex++
    }
    const nameBase = `${(prop?.code || '').trim()} Property Onboarding Listing`.trim()
    const fileName = `${nameBase || 'property-onboarding-listing'}.pdf`
    try {
      const dataUrl = pdf.output('datauristring')
      try {
        const ab = pdf.output('arraybuffer') as ArrayBuffer
        const resBin = await fetch(`${API_BASE}/onboarding/${onb.id}/merge-pdf-binary`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/pdf', ...authHeaders() },
          body: ab,
        })
        if (resBin.ok) {
          const blob = await resBin.blob()
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = fileName
          document.body.appendChild(a)
          a.click()
          a.remove()
          URL.revokeObjectURL(url)
          message.success('PDF已下载')
          return
        }
      } catch {}
      try {
        const res = await fetch(`${API_BASE}/onboarding/${onb.id}/merge-pdf`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ pdf_base64: dataUrl }),
        })
        if (res.ok) {
          const blob = await res.blob()
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = fileName
          document.body.appendChild(a)
          a.click()
          a.remove()
          URL.revokeObjectURL(url)
          message.success('PDF已下载')
          return
        }
      } catch {}
      pdf.save(fileName)
      message.success('PDF已下载')
    } catch {
      message.error('PDF导出失败')
    }
  }

  const locked = !!(onb?.status && (onb.status === 'confirmed' || onb.status === 'pdf_generated'))
  const [pdfLang, setPdfLang] = useState<'zh'|'en'>('zh')
  const [pdfDailyMode, setPdfDailyMode] = useState<'details'|'total'>('details')
  const [pdfDailyOverride, setPdfDailyOverride] = useState<number | undefined>(undefined)
  const dict = {
    zh: { title: '新房上线清单', addr: '房源地址：', date: '上线日期：', sec: { appliance:'家用电器', furniture:'家具', decor:'软装', daily:'日用品', fees:'一次性上线费用' }, th: { area:'区域', name:'物品名称', supplier:'供应商', qty:'数量', unit:'单价', total:'总价', notes:'备注', type:'类型' }, subtotal:'合计', grand:'Grand Total' },
    en: { title: 'Property Onboarding Listing', addr: 'Property Address: ', date: 'Onboarding Date: ', sec: { appliance:'Appliances', furniture:'Furniture', decor:'Decor', daily:'Daily Items', fees:'One-off Onboarding Fees' }, th: { area:'Area', name:'Item', supplier:'Supplier', qty:'Qty', unit:'Unit Price', total:'Total', notes:'Notes', type:'Type' }, subtotal:'Subtotal', grand:'Grand Total' }
  }
  const nameMapZhEn: Record<string,string> = {
    '毛毯':'Blanket','床垫保护套':'Mattress Protector','枕头':'Pillow','灯泡':'Light Bulb','E27灯泡':'E27 Bulb','E14灯泡':'E14 Bulb','衣架':'Hangers','杯子':'Cup','咖啡机':'Coffee Machine','烘干机':'Dryer','洗衣机':'Washing Machine','沙发':'Sofa','茶几':'Coffee Table','床':'Bed','马桶刷':'Toilet Brush','吹风机':'Hair Dryer','沐浴露':'Body Wash','洗手液':'Hand Wash','砧板':'Cutting Board','平台上线费':'Platform Onboarding Fee','床头':'Bedside Table',
    '床头灯':'Bedside Lamp','面包机':'Bread Maker','烧水壶':'Kettle','电热水壶':'Electric Kettle','装饰花':'Decorative Flowers','厨房装饰花':'Kitchen Decorative Flowers','被子':'Duvet','衣柜':'Wardrobe','晾衣架':'Clothes Rack','晾衣杆':'Clothes Rail','垃圾桶':'Trash Bin','餐桌':'Dining Table','餐椅':'Dining Chair','窗帘':'Curtains','床单':'Bedsheet',
    '人工安装费':'Installation Labour','第一次清洁&床品费':'First Cleaning & Bedding Fee','拍照费':'Photography Fee'
    ,
    '量勺':'Measuring Spoons','压蒜器':'Garlic Press','沙拉碗':'Salad Bowl','漏网':'Strainer','打蛋器':'Whisk','锅铲':'Spatula','食物夹':'Tongs','削皮刀':'Peeler','开罐器':'Can Opener','漏勺':'Skimmer','盐罐':'Salt Jar','土豆压泥器':'Potato Masher','粘毛桶':'Lint Roller','防滑垫':'Non-slip Mat','茶咖啡糖罐':'Tea Coffee Sugar Canister','粘毛桶备用卷':'Lint Roller Refill','刀叉勺':'Cutlery Set','剪子':'Scissors','剪刀':'Scissors','烤箱手套':'Oven Mitts','炒菜勺':'Cooking Spoon','喝水杯':'Drinking Cup','咖啡杯':'Coffee Mug','碗碟':'Bowls and Plates','锅':'Pot','红酒杯':'Wine Glass','糖罐':'Sugar Jar',
    '吸尘器':'Vacuum Cleaner','灭火器':'Fire Extinguisher','洗衣粉收纳盒':'Laundry Powder Storage Box','拖把头':'Mop Head','簸箕':'Dustpan','门阻':'Door Stopper','拖把杆':'Mop Handle','婴儿床':'Baby Cot','婴儿椅':'High Chair','厨房收纳盒':'Kitchen Storage Box','急救包':'First Aid Kit'
  }
  const nameRegexZhEn: Array<{ re: RegExp; en: string }> = [
    { re: /^床头灯$/, en: 'Bedside Lamp' },
    { re: /^面包机$/, en: 'Bread Maker' },
    { re: /咖啡机/, en: 'Coffee Machine' },
    { re: /^烧水壶$/, en: 'Kettle' },
    { re: /^电?热水壶$/, en: 'Electric Kettle' },
    { re: /^装饰花$/, en: 'Decorative Flowers' },
    { re: /^厨房装饰花$/, en: 'Kitchen Decorative Flowers' },
    { re: /^被子$/, en: 'Duvet' },
    { re: /^窗帘$/, en: 'Curtains' },
  ]
  const areaMapZhEn: Record<string,string> = { '客厅':'Living Room','餐厅':'Dining','卧室':'Bedroom','卫生间':'Bathroom','厨房':'Kitchen','其他':'Others' }
  const transName = (s?: string) => (pdfLang==='en' ? zhToEn(s||'') : (s||''))
  const transArea = (s?: string) => (pdfLang==='en' ? (s ? (areaMapZhEn[s] || s) : '') : (s||''))
  const [editOpen, setEditOpen] = useState(false)
  const [editKind, setEditKind] = useState<'item'|'fee'|null>(null)
  const [editData, setEditData] = useState<any>(null)
  const [editForm] = Form.useForm()
  const [previewOpen, setPreviewOpen] = useState(false)
  const modalRef = useRef<HTMLDivElement>(null)
  async function deleteItemOptimistic(rr: Item) {
    const prev = items.slice()
    setItems((arr) => arr.filter((it) => it.id !== rr.id))
    try {
      const res = await fetch(`${API_BASE}/onboarding/${rr.onboarding_id}/items/${rr.id}`, { method:'DELETE', headers: { ...authHeaders() } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      await refreshData(rr.onboarding_id)
      message.success('已删除')
    } catch (e: any) {
      setItems(prev)
      message.error(e?.message || '删除失败')
    }
  }
  async function deleteFeeOptimistic(r: Fee) {
    const prev = fees.slice()
    setFees((list) => list.filter((f) => f.id !== r.id))
    try {
      const res = await fetch(`${API_BASE}/onboarding/${r.onboarding_id}/fees/${r.id}`, { method:'DELETE', headers: { ...authHeaders() } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      await refreshData(r.onboarding_id)
      message.success('已删除')
    } catch (e: any) {
      setFees(prev)
      message.error(e?.message || '删除失败')
    }
  }
  useEffect(() => {
    if (!previewOpen) return
    const node = modalRef.current as HTMLElement | null
    if (!node) return
    const pdf = new jsPDF('p', 'mm', 'a4')
    const margin = 10
    const pageWmm = pdf.internal.pageSize.getWidth() - margin * 2
    const pageHmm = pdf.internal.pageSize.getHeight() - margin * 2
    const pxPerMm = Math.max(1, (node.scrollWidth || node.clientWidth) / pageWmm)
    const pageHPx = Math.floor(pageHmm * pxPerMm)
    const baseRect = node.getBoundingClientRect()
    const bars = Array.from(node.querySelectorAll('.subtotalBar')) as HTMLElement[]
    for (const bar of bars) {
      const r = bar.getBoundingClientRect()
      const top = Math.max(0, Math.round(r.top - baseRect.top))
      const bottom = Math.max(top + Math.round(r.height), Math.round(r.bottom - baseRect.top))
      const pTop = Math.floor(top / pageHPx)
      const pBottom = Math.floor(bottom / pageHPx)
      if (pTop !== pBottom) {
        const br = document.createElement('div')
        br.className = 'pageBreak'
        bar.parentElement?.insertBefore(br, bar)
      }
    }
    // Prevent orphan block titles: require table header + 2 rows
    const titles = Array.from(node.querySelectorAll('.blockTitle')) as HTMLElement[]
    for (const t of titles) {
      const table = t.parentElement?.querySelector('.itemsTable') as HTMLElement | null
      if (!table) continue
      const thead = table.querySelector('thead') as HTMLElement | null
      const rows = Array.from(table.querySelectorAll('tbody tr')).slice(0,2) as HTMLElement[]
      const needH = (thead?.getBoundingClientRect().height || 0) + rows.reduce((s,r)=> s + r.getBoundingClientRect().height, 0)
      const r = t.getBoundingClientRect()
      const top = Math.max(0, Math.round(r.top - baseRect.top))
      const remaining = pageHPx - (top % pageHPx)
      if (remaining < needH + 8) {
        const br = document.createElement('div')
        br.className = 'pageBreak'
        t.parentElement?.insertBefore(br, t)
      }
    }
    // Daily group headers: require at least 2 rows under header
    const dailyTables = Array.from(node.querySelectorAll('.itemsTable[data-kind="daily"]')) as HTMLElement[]
    for (const tb of dailyTables) {
      const headers = Array.from(tb.querySelectorAll('tr.groupHeader')) as HTMLTableRowElement[]
      for (const h of headers) {
        const r = h.getBoundingClientRect()
        const top = Math.max(0, Math.round(r.top - baseRect.top))
        const following = [] as HTMLTableRowElement[]
        let el: Element | null = h.nextElementSibling
        while (el && following.length < 2) {
          if ((el as HTMLTableRowElement).classList.contains('groupHeader')) break
          following.push(el as HTMLTableRowElement)
          el = el.nextElementSibling
        }
        const needH = following.reduce((s,row)=> s + row.getBoundingClientRect().height, 0)
        const remaining = pageHPx - (top % pageHPx)
        if (following.length >= 2 && remaining < needH + 8) {
          const brRow = tb.ownerDocument!.createElement('tr')
          brRow.className = 'pageBreakRow'
          const td = tb.ownerDocument!.createElement('td')
          const colCount = (tb.querySelectorAll('thead tr th').length || 7)
          td.setAttribute('colspan', String(colCount))
          brRow.appendChild(td)
          h.parentElement!.insertBefore(brRow, h)
        }
      }
    }
  }, [previewOpen, items, fees])
  const itemColumns = [
    { title:'分类', dataIndex:'group', render:(v: any, r: any) => (r.isGroup ? 'daily' : v) },
    { title:'类别', dataIndex:'category', render:(v: any, r: any) => (r.isGroup ? (<strong>{v || '其他'}</strong>) : (v || '')) },
    { title:'名称', dataIndex:'item_name' },
    { title:'单位', dataIndex:'unit' },
    { title:'品牌', dataIndex:'brand' },
    { title:'新旧', dataIndex:'condition' },
    { title:'数量', dataIndex:'quantity', align:'right' as const, render:(v: any) => Number(v||0) },
    { title:'单价', dataIndex:'unit_price', align:'right' as const, render:(v: any)=> fmtCurrency(v) },
    { title:'小计', dataIndex:'total_price', align:'right' as const, render:(v: any)=> fmtCurrency(v) },
    { title:'操作', render: (_: any, r: Item | any) => (r && (r as any).isGroup ? null : (
      <Space>
        <Button onClick={() => { setEditKind('item'); setEditData(r as Item); editForm.setFieldsValue({ item_name: (r as Item).item_name, quantity: Number((r as Item).quantity||0), unit_price: Number((r as Item).unit_price||0), brand: (r as Item).brand, condition: (r as Item).condition, remark: (r as Item).remark }); setEditOpen(true) }}>编辑</Button>
        <Button disabled={locked} danger onClick={() => { const rr = r as Item; Modal.confirm({ title: '确认删除该条目？此操作不可恢复', okText: '删除', cancelText: '取消', onOk: () => deleteItemOptimistic(rr) }) }}>删除</Button>
      </Space>
    )) },
  ]
  const feeColumns = [
    { title:'类型', dataIndex:'fee_type' },
    { title:'名称', dataIndex:'name' },
    { title:'数量', dataIndex:'quantity', align:'right' as const, render:(v: any)=> Number(v||0) },
    { title:'单价', dataIndex:'unit_price', align:'right' as const, render:(v: any, r: Fee)=> (r.waived ? (<span><s>{fmtCurrency(v)}</s> {fmtCurrency(0)}</span>) : (fmtCurrency(v))) },
    { title:'总价', dataIndex:'total_price', align:'right' as const, render:(v: any, r: Fee)=> (r.waived ? (<span><s>{fmtCurrency(v)}</s> {fmtCurrency(0)}</span>) : (fmtCurrency(v))) },
    { title:'计入成本', dataIndex:'include_in_property_cost', render:(v: boolean, r: Fee)=> (
      <Tooltip title={locked ? '已锁定，先在基础信息点击“解锁”以编辑' : ''}>
        <Switch
          disabled={locked || !!feeUpdating[r.id]}
          checked={r.include_in_property_cost}
          onChange={(nv)=> {
            setFeeUpdating((m)=> ({ ...m, [r.id]: true }))
            const prev = r.include_in_property_cost
            // optimistic update
            setFees((list)=> list.map(f=> f.id===r.id ? { ...f, include_in_property_cost: nv } : f))
            patchJSON(`/onboarding/${r.onboarding_id}/fees/${r.id}`, { include_in_property_cost: nv })
              .then(()=> refreshData(r.onboarding_id))
              .catch(()=> { setFees((list)=> list.map(f=> f.id===r.id ? { ...f, include_in_property_cost: prev } : f)); message.error('更新失败') })
              .finally(()=> setFeeUpdating((m)=> { const { [r.id]:_, ...rest } = m; return rest }))
          }}
        />
      </Tooltip>
    ) },
    { title:'Waive', dataIndex:'waived', render:(v: boolean, r: Fee)=> (
      <Tooltip title={locked ? '已锁定，先在基础信息点击“解锁”以编辑' : ''}>
        <Switch
          disabled={locked || !!feeUpdating[r.id]}
          checked={!!r.waived}
          onChange={(nv)=> {
            setFeeUpdating((m)=> ({ ...m, [r.id]: true }))
            const prev = !!r.waived
            setFees((list)=> list.map(f=> f.id===r.id ? { ...f, waived: nv } : f))
            patchJSON(`/onboarding/${r.onboarding_id}/fees/${r.id}`, { waived: nv })
              .then(()=> refreshData(r.onboarding_id))
              .catch(()=> { setFees((list)=> list.map(f=> f.id===r.id ? { ...f, waived: prev } : f)); message.error('更新失败') })
              .finally(()=> setFeeUpdating((m)=> { const { [r.id]:_, ...rest } = m; return rest }))
          }}
        />
      </Tooltip>
    ) },
    { title:'操作', render: (_: any, r: Fee)=> (
      <Space>
        <Button onClick={() => { setEditKind('fee'); setEditData(r); editForm.setFieldsValue({ fee_type: r.fee_type, name: r.name, quantity: Number(r.quantity||1), unit_price: Number(r.unit_price||0), include_in_property_cost: !!r.include_in_property_cost, remark: r.remark }); setEditOpen(true) }}>编辑</Button>
        <Button disabled={locked} danger onClick={() => { Modal.confirm({ title: '确认删除此费用？此操作不可恢复', okText: '删除', cancelText: '取消', onOk: () => deleteFeeOptimistic(r) }) }}>删除</Button>
      </Space>
    ) },
  ]

  return (
    <Card title={<Space><Button type="text" icon={<ArrowLeftOutlined />} onClick={() => { try { router.push('/onboarding') } catch { router.back() } }} />房源上新</Space>} extra={<Space>
      <span>{pdfLang==='zh'?'导出语言':'Language'}</span>
      <Select size="small" value={pdfLang} onChange={(v)=> setPdfLang(v as any)} options={[{ value:'zh', label:'中文' }, { value:'en', label:'English' }]} />
      <span>日用品展示</span>
      <Select size="small" value={pdfDailyMode} onChange={(v)=> setPdfDailyMode(v as any)} options={[{ value:'details', label:'明细' }, { value:'total', label:'总价' }]} />
      {pdfDailyMode==='total' && (<InputNumber size="small" min={0} value={pdfDailyOverride} onChange={(v)=> setPdfDailyOverride(Number(v||0))} addonBefore={pdfLang==='zh'?'总价':'Total'} />)}
    </Space>}>
      {!onb ? <div>正在准备上新记录…</div> : (
        <Tabs items={[
          { key:'base', label:'基础信息', children:(
            <Form form={formBasic} layout="vertical" onValuesChange={(chg)=> { if (chg && 'onboarding_date' in chg) { const v: any = (chg as any).onboarding_date; setOnb((prev)=> prev ? { ...prev, onboarding_date: (v && v.format ? v.format('YYYY-MM-DD') : prev.onboarding_date) } : prev) } }}>
              <Form.Item label="房源地址"><Input value={onb.address_snapshot || ''} readOnly /></Form.Item>
              <Form.Item name="onboarding_date" label="上线日期"><DatePicker style={{ width: '100%' }} format="DD/MM/YYYY" /></Form.Item>
              <Form.Item name="remark" label="备注"><Input.TextArea rows={3} /></Form.Item>
              <Space>
                <Tag>状态：{onb.status || 'draft'}</Tag>
                <Button type="primary" onClick={saveBasic} disabled={locked}>保存</Button>
                <Button onClick={async ()=> { if (!onb) return; try { const res = await fetch(`${API_BASE}/onboarding/${onb.id}/confirm`, { method:'POST', headers: { ...authHeaders() } }); if (!res.ok) throw new Error(`HTTP ${res.status}`); await refreshData(onb.id); message.success('已确认并锁定'); } catch (e: any) { message.error(e?.message || '确认失败') } }} disabled={locked}>确认并锁定</Button>
                {locked && (
                  <Button danger onClick={async ()=> { if (!onb) return; try { const res = await fetch(`${API_BASE}/onboarding/${onb.id}/unlock`, { method:'POST', headers: { ...authHeaders() } }); if (!res.ok) throw new Error(`HTTP ${res.status}`); await refreshData(onb.id); message.success('已解锁，可编辑/删除'); } catch (e: any) { message.error(e?.message || '解锁失败') } }}>解锁</Button>
                )}
              </Space>
            </Form>
          )},
          { key:'daily', label:'日用品配置', children:(
            <div>
          <div style={{ display:'flex', gap:8, marginBottom:12, alignItems:'center' }}>
            <Select placeholder="分类" style={{ width: 200 }} allowClear value={dailyCat} onChange={setDailyCat} options={[{value:'卧室',label:'卧室'},{value:'厨房',label:'厨房'},{value:'卫生间',label:'卫生间'},{value:'其他',label:'其他'}]} />
            <Button type="primary" onClick={addSelectedDailyItems} disabled={!selectedPriceIds.length}>添加已勾选</Button>
            <Button onClick={() => { const filtered = prices.filter(p => !dailyCat || p.category === dailyCat); setSelectedPriceIds(filtered.map(p=>p.id)) }}>全选</Button>
            <Button onClick={() => setSelectedPriceIds([])} disabled={!selectedPriceIds.length}>取消全选</Button>
          </div>
          <Table
            rowKey={(r)=>r.id}
            columns={[
              { title:'名称', dataIndex:'item_name' },
              { title:'单位', dataIndex:'unit' },
              { title:'标准数量', dataIndex:'default_quantity', align:'right' as const },
              { title:'单价', dataIndex:'unit_price', align:'right' as const, render:(v: number)=> `$${Number(v||0).toFixed(2)}` },
              { title:'数量', key:'qty', align:'center' as const, render: (_: any, r: PriceItem) => (
                <div style={{ display:'inline-flex', alignItems:'center', gap:8, justifyContent:'center' }}>
                  <Button size="small" style={{ width:28, padding:0 }} onClick={() => { const cur = qtyMap[r.id] ?? Number(r.default_quantity || 1); const nq = Math.max(1, Number(cur) - 1); setQtyMap((m)=> ({ ...m, [r.id]: nq })) }}>－</Button>
                  <div style={{ minWidth: 36, textAlign:'center', lineHeight:'24px', height:24, border:'1px solid #ddd', borderRadius:4 }}>{qtyMap[r.id] ?? Number(r.default_quantity || 1)}</div>
                  <Button size="small" style={{ width:28, padding:0 }} onClick={() => { const cur = qtyMap[r.id] ?? Number(r.default_quantity || 1); const nq = Number(cur) + 1; setQtyMap((m)=> ({ ...m, [r.id]: nq })) }}>＋</Button>
                </div>
              ) },
            ] as any}
            dataSource={prices.filter(p=> !dailyCat || p.category===dailyCat)}
            pagination={{ pageSize: 10 }}
            size="small"
            rowSelection={{
              selectedRowKeys: selectedPriceIds,
              onChange: (keys: any[]) => setSelectedPriceIds(keys as string[]),
            }}
          />
          <div style={{ marginTop: 12 }}>
            <Table
              rowKey={(r)=>r.id}
              columns={itemColumns as any}
              dataSource={(function(){
                const src = items.filter(i=>i.group==='daily')
                const byCat: Record<string, Item[]> = {}
                src.forEach((it)=> {
                  const c = (it.category && String(it.category).trim()) || '其他'
                  (byCat[c] = byCat[c] || []).push(it)
                })
                const cats = Object.keys(byCat).sort()
                if (!cats.length) return src
                const out: any[] = []
                for (const cat of cats) {
                  out.push({ id: `grp-${cat}`, isGroup: true, group: 'daily', category: cat })
                  out.push(...byCat[cat])
                }
                return out
              })()}
              pagination={false}
              size="small"
              expandable={undefined}
            />
          </div>
              <div style={{ textAlign:'right', marginTop:8 }}>日用品合计：<strong>{fmtCurrency(totals.sumDaily)}</strong></div>
            </div>
          )},
          { key:'fa', label:'家具 & 家电', children:(
            <div>
              <div style={{ display:'flex', gap:8, marginBottom:12, alignItems:'center' }}>
                <Select style={{ width: 160 }} value={faGroup} onChange={(v)=> setFaGroup(v as any)} options={[{value:'furniture',label:'家具'},{value:'appliance',label:'家电'}]} />
                <Button type="primary" onClick={addSelectedFAItems} disabled={!faSelectedIds.length}>添加已勾选</Button>
              </div>
              <Table
                rowKey={(r)=>r.id}
                columns={[
                  { title:'名称', dataIndex:'item_name' },
                  { title:'单位', dataIndex:'unit' },
                  { title:'标准数量', dataIndex:'default_quantity', align:'center' as const },
                  { title:'单价', dataIndex:'unit_price', align:'right' as const, render:(v: any)=> fmtCurrency(v) },
                  { title:'数量', key:'qty', align:'center' as const, render: (_: any, r: any) => (
                    <div style={{ display:'inline-flex', alignItems:'center', gap:8, justifyContent:'center' }}>
                      <Button size="small" style={{ width:28, padding:0 }} onClick={() => { const cur = faQtyMap[r.id] ?? Number(r.default_quantity || 1); const nq = Math.max(1, Number(cur) - 1); setFaQtyMap((m)=> ({ ...m, [r.id]: nq })) }}>－</Button>
                      <div style={{ minWidth: 36, textAlign:'center', lineHeight:'24px', height:24, border:'1px solid #ddd', borderRadius:4 }}>{faQtyMap[r.id] ?? Number(r.default_quantity || 1)}</div>
                      <Button size="small" style={{ width:28, padding:0 }} onClick={() => { const cur = faQtyMap[r.id] ?? Number(r.default_quantity || 1); const nq = Number(cur) + 1; setFaQtyMap((m)=> ({ ...m, [r.id]: nq })) }}>＋</Button>
                    </div>
                  ) },
                ] as any}
                dataSource={faPrices}
                pagination={{ pageSize: 10 }}
                size="small"
                rowSelection={{ selectedRowKeys: faSelectedIds, onChange: (keys: any[]) => setFaSelectedIds(keys as string[]) }}
              />
              <Table rowKey={(r)=>r.id} columns={itemColumns as any} dataSource={items.filter(i=>i.group==='furniture' || i.group==='appliance')} pagination={false} size="small" style={{ marginTop: 12 }} />
              <div style={{ textAlign:'right', marginTop:8 }}>家具家电合计：<strong>{fmtCurrency(totals.sumFurn)}</strong></div>
            </div>
          )},
          { key:'decor', label:'软装', children:(
            <div>
              <div style={{ display:'flex', gap:8, marginBottom:12 }}>
                <Input placeholder="物品名称" value={decorName} onChange={(e)=> setDecorName(e.target.value)} style={{ width: 240 }} />
                <InputNumber min={0} value={decorUnitPrice} onChange={(v)=> setDecorUnitPrice(Number(v||0))} style={{ width: 120 }} addonBefore="单价" />
                <InputNumber min={1} value={decorQty} onChange={(v)=> setDecorQty(Number(v||1))} style={{ width: 120 }} addonBefore="数量" />
                <Button type="primary" onClick={async ()=> { if (!onb || !decorName) { message.warning('请输入名称'); return }; await postJSON(`/onboarding/${onb.id}/items`, { group:'decor', item_name: decorName, quantity: decorQty, unit_price: decorUnitPrice }); setDecorName(undefined); setDecorUnitPrice(0); setDecorQty(1); await refreshData(onb.id) }}>添加</Button>
              </div>
              <Table rowKey={(r)=>r.id} columns={itemColumns as any} dataSource={items.filter(i=>i.group==='decor')} pagination={false} size="small" />
              <div style={{ textAlign:'right', marginTop:8 }}>软装合计：<strong>{fmtCurrency(totals.sumDecor)}</strong></div>
            </div>
          )},
          { key:'fees', label:'一次性上线费用', children:(
            <div>
              <div style={{ display:'flex', gap:8, marginBottom:12, alignItems:'center' }}>
                <Select style={{ width: 200 }} value={feeType} onChange={setFeeType as any} options={[{value:'平台上线费',label:'平台上线费'},{value:'人工安装费',label:'人工安装费'},{value:'第一次清洁&床品费',label:'第一次清洁&床品费'},{value:'拍照费',label:'拍照费'},{value:'其他',label:'其他'}]} />
                <Input placeholder="费用名称" value={feeName} onChange={(e)=> setFeeName(e.target.value)} style={{ width: 240 }} disabled={feeType !== '其他'} />
                <InputNumber min={0} value={feeUnit} onChange={(v)=> setFeeUnit(Number(v||0))} style={{ width: 120 }} addonBefore="单价" />
                <InputNumber min={1} value={feeQty} onChange={(v)=> setFeeQty(Number(v||1))} style={{ width: 120 }} addonBefore="数量" />
                <span>计入成本</span><Switch checked={feeInclude} onChange={setFeeInclude} />
                <Button type="primary" onClick={addFee}>添加</Button>
              </div>
              <Table rowKey={(r)=>r.id} columns={feeColumns as any} dataSource={fees} pagination={false} size="small" />
              <div style={{ textAlign:'right', marginTop:8 }}>一次性上线费用合计：<strong>{fmtCurrency(totals.sumFees)}</strong></div>
            </div>
          )},
          { key:'attach', label:'发票 & 附件', children:(
            <div>
              <Upload multiple beforeUpload={()=>false} onChange={(info)=> { const f = (info.file as any)?.originFileObj; if (f) { uploadAttachments([f] as any).catch(()=>{}) } }}>
                <Button disabled={locked}>上传附件/发票</Button>
              </Upload>
              <div style={{ marginTop: 12 }}>
                {(attach||[]).length ? (
                  <div>
                    <style>{`.attRow{display:flex;align-items:center;justify-content:space-between;padding:6px 8px;border-radius:6px}.attRow:hover{background:#fafafa}.attName{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:80%}.attActions{opacity:0;transition:opacity .2s}.attRow:hover .attActions{opacity:1}`}</style>
                    {Array.from(new Map((attach||[]).map(a=>[a.id||a.url,a])).values()).map((a: any) => (
                      <div className="attRow" key={a.id || a.url}>
                        <a className="attName" href={(a.url||'').startsWith('http') ? a.url : `${API_BASE}${a.url}`} target="_blank">{a.file_name || a.url}</a>
                        {!locked && (
                          <span className="attActions">
                            <Popconfirm title="确认删除此附件？" okText="删除" cancelText="取消" onConfirm={async () => { try { await fetch(`${API_BASE}/onboarding/${onb!.id}/attachments/${encodeURIComponent(a.id)}`, { method:'DELETE', headers: { ...authHeaders() } }); setAttach((list)=> list.filter((x)=> (x.id||x.url)!==(a.id||a.url))); message.success('已删除'); } catch (e: any) { message.error(e?.message || '删除失败') } }}>
                              <Button type="text" size="small" icon={<DeleteOutlined />} style={{ color:'#ff4d4f' }} />
                            </Popconfirm>
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (<div style={{ color:'#999' }}>暂无附件</div>)}
              </div>
            </div>
          )},
          { key:'summary', label:'汇总 & 生成PDF', children:(
            <div>
              <div ref={printRef as any}>
                <h3>MZ Property Pty Ltd</h3>
                <div>{dict[pdfLang].addr}{onb.address_snapshot || ''}</div>
            <div>{dict[pdfLang].date}{formBasic.getFieldValue('onboarding_date') ? formBasic.getFieldValue('onboarding_date').format('DD/MM/YYYY') : ''}</div>
                <h4>{dict[pdfLang].sec.daily}</h4>
                <table style={{ width:'100%', borderCollapse:'collapse', tableLayout:'fixed' }}>
                  <colgroup>
                    <col style={{ width:'38%' }} />
                    <col style={{ width:'18%' }} />
                    <col style={{ width:'10%' }} />
                    <col style={{ width:'17%' }} />
                    <col style={{ width:'17%' }} />
                  </colgroup>
                  <thead>
                    <tr>
                      <th style={{ textAlign:'left', padding:'6px 8px', borderBottom:'1px solid #eee' }}>{dict[pdfLang].th.name}</th>
                      <th style={{ textAlign:'left', padding:'6px 8px', borderBottom:'1px solid #eee' }}>{dict[pdfLang].th.supplier}</th>
                      <th style={{ textAlign:'right', padding:'6px 8px', borderBottom:'1px solid #eee' }}>{dict[pdfLang].th.qty}</th>
                      <th style={{ textAlign:'right', padding:'6px 8px', borderBottom:'1px solid #eee' }}>{dict[pdfLang].th.unit}</th>
                      <th style={{ textAlign:'right', padding:'6px 8px', borderBottom:'1px solid #eee' }}>{dict[pdfLang].th.subtotal}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.filter(i=>i.group==='daily').map(i=> (
                      <tr key={i.id}>
                        <td style={{ padding:'6px 8px', borderBottom:'1px solid #f5f5f5' }}>{i.item_name}</td>
                        <td style={{ padding:'6px 8px', borderBottom:'1px solid #f5f5f5' }}></td>
                        <td style={{ textAlign:'right', padding:'6px 8px', borderBottom:'1px solid #f5f5f5' }}>{Number(i.quantity||0)}</td>
                        <td style={{ textAlign:'right', padding:'6px 8px', borderBottom:'1px solid #f5f5f5' }}>{fmtCurrency(i.unit_price)}</td>
                        <td style={{ textAlign:'right', padding:'6px 8px', borderBottom:'1px solid #f5f5f5' }}>{fmtCurrency(i.total_price)}</td>
                      </tr>
                    ))}
                    <tr>
                      <td colSpan={5} style={{ background:'#ffa940', textAlign:'right', padding:'6px 8px', fontWeight:600 }}>{dict[pdfLang].subtotal}: {fmtCurrency(totals.sumDaily)}</td>
                    </tr>
                  </tbody>
                </table>

                <h4 style={{ marginTop:16 }}>{dict[pdfLang].sec.fa}</h4>
                <table style={{ width:'100%', borderCollapse:'collapse', tableLayout:'fixed' }}>
                  <colgroup>
                    <col style={{ width:'38%' }} />
                    <col style={{ width:'18%' }} />
                    <col style={{ width:'10%' }} />
                    <col style={{ width:'17%' }} />
                    <col style={{ width:'17%' }} />
                  </colgroup>
                  <thead>
                    <tr>
                      <th style={{ textAlign:'left', padding:'6px 8px', borderBottom:'1px solid #eee' }}>{dict[pdfLang].th.name}</th>
                      <th style={{ textAlign:'left', padding:'6px 8px', borderBottom:'1px solid #eee' }}>{dict[pdfLang].th.supplier}</th>
                      <th style={{ textAlign:'right', padding:'6px 8px', borderBottom:'1px solid #eee' }}>{dict[pdfLang].th.qty}</th>
                      <th style={{ textAlign:'right', padding:'6px 8px', borderBottom:'1px solid #eee' }}>{dict[pdfLang].th.unit}</th>
                      <th style={{ textAlign:'right', padding:'6px 8px', borderBottom:'1px solid #eee' }}>{dict[pdfLang].th.total}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.filter(i=>i.group==='furniture' || i.group==='appliance').map(i=> (
                      <tr key={i.id}>
                        <td style={{ padding:'6px 8px', borderBottom:'1px solid #f5f5f5' }}>{i.item_name}</td>
                        <td style={{ padding:'6px 8px', borderBottom:'1px solid #f5f5f5' }}></td>
                        <td style={{ textAlign:'right', padding:'6px 8px', borderBottom:'1px solid #f5f5f5' }}>{Number(i.quantity||0)}</td>
                        <td style={{ textAlign:'right', padding:'6px 8px', borderBottom:'1px solid #f5f5f5' }}>{fmtCurrency(i.unit_price)}</td>
                        <td style={{ textAlign:'right', padding:'6px 8px', borderBottom:'1px solid #f5f5f5' }}>{fmtCurrency(i.total_price)}</td>
                      </tr>
                    ))}
                    <tr>
                      <td colSpan={5} style={{ background:'#ffa940', textAlign:'right', padding:'6px 8px', fontWeight:600 }}>{dict[pdfLang].subtotal}: {fmtCurrency(totals.sumFurn)}</td>
                    </tr>
                  </tbody>
                </table>

                <h4 style={{ marginTop:16 }}>{dict[pdfLang].sec.decor}</h4>
                <table style={{ width:'100%', borderCollapse:'collapse', tableLayout:'fixed' }}>
                  <colgroup>
                    <col style={{ width:'38%' }} />
                    <col style={{ width:'18%' }} />
                    <col style={{ width:'10%' }} />
                    <col style={{ width:'17%' }} />
                    <col style={{ width:'17%' }} />
                  </colgroup>
                  <thead>
                    <tr>
                      <th style={{ textAlign:'left', padding:'6px 8px', borderBottom:'1px solid #eee' }}>{dict[pdfLang].th.name}</th>
                      <th style={{ textAlign:'left', padding:'6px 8px', borderBottom:'1px solid #eee' }}>{dict[pdfLang].th.supplier}</th>
                      <th style={{ textAlign:'right', padding:'6px 8px', borderBottom:'1px solid #eee' }}>{dict[pdfLang].th.qty}</th>
                      <th style={{ textAlign:'right', padding:'6px 8px', borderBottom:'1px solid #eee' }}>{dict[pdfLang].th.unit}</th>
                      <th style={{ textAlign:'right', padding:'6px 8px', borderBottom:'1px solid #eee' }}>{dict[pdfLang].th.total}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.filter(i=>i.group==='decor').map(i=> (
                      <tr key={i.id}>
                        <td style={{ padding:'6px 8px', borderBottom:'1px solid #f5f5f5' }}>{i.item_name}</td>
                        <td style={{ padding:'6px 8px', borderBottom:'1px solid #f5f5f5' }}></td>
                        <td style={{ textAlign:'right', padding:'6px 8px', borderBottom:'1px solid #f5f5f5' }}>{Number(i.quantity||0)}</td>
                        <td style={{ textAlign:'right', padding:'6px 8px', borderBottom:'1px solid #f5f5f5' }}>{fmtCurrency(i.unit_price)}</td>
                        <td style={{ textAlign:'right', padding:'6px 8px', borderBottom:'1px solid #f5f5f5' }}>{fmtCurrency(i.total_price)}</td>
                      </tr>
                    ))}
                    <tr>
                      <td colSpan={5} style={{ background:'#ffa940', textAlign:'right', padding:'6px 8px', fontWeight:600 }}>{dict[pdfLang].subtotal}: {fmtCurrency(totals.sumDecor)}</td>
                    </tr>
                  </tbody>
                </table>

                <h4 style={{ marginTop:16 }}>{dict[pdfLang].sec.fees}</h4>
                <table style={{ width:'100%', borderCollapse:'collapse', tableLayout:'fixed' }}>
                  <colgroup>
                    <col style={{ width:'25%' }} />
                    <col style={{ width:'35%' }} />
                    <col style={{ width:'10%' }} />
                    <col style={{ width:'15%' }} />
                    <col style={{ width:'15%' }} />
                  </colgroup>
                  <thead>
                    <tr>
                      <th style={{ textAlign:'left', padding:'6px 8px', borderBottom:'1px solid #eee' }}>{dict[pdfLang].th.type}</th>
                      <th style={{ textAlign:'left', padding:'6px 8px', borderBottom:'1px solid #eee' }}>{dict[pdfLang].th.name}</th>
                      <th style={{ textAlign:'right', padding:'6px 8px', borderBottom:'1px solid #eee' }}>{dict[pdfLang].th.qty}</th>
                      <th style={{ textAlign:'right', padding:'6px 8px', borderBottom:'1px solid #eee' }}>{dict[pdfLang].th.unit}</th>
                      <th style={{ textAlign:'right', padding:'6px 8px', borderBottom:'1px solid #eee' }}>{dict[pdfLang].th.total}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {fees.map(f=> (
                      <tr key={f.id}>
                        <td style={{ padding:'6px 8px', borderBottom:'1px solid #f5f5f5' }}>{f.fee_type}</td>
                        <td style={{ padding:'6px 8px', borderBottom:'1px solid #f5f5f5' }}>{f.name}</td>
                        <td style={{ textAlign:'right', padding:'6px 8px', borderBottom:'1px solid #f5f5f5' }}>{Number(f.quantity||0)}</td>
                        <td style={{ textAlign:'right', padding:'6px 8px', borderBottom:'1px solid #f5f5f5' }}>{f.waived ? (<span><s>{fmtCurrency(f.unit_price)}</s> {fmtCurrency(0)}</span>) : (fmtCurrency(f.unit_price))}</td>
                        <td style={{ textAlign:'right', padding:'6px 8px', borderBottom:'1px solid #f5f5f5' }}>{f.waived ? (<span><s>{fmtCurrency(f.total_price)}</s> {fmtCurrency(0)}</span>) : (fmtCurrency(f.total_price))}</td>
                      </tr>
                    ))}
                  </tbody>
                <tr>
                  <td colSpan={5} style={{ background:'#ffa940', textAlign:'right', padding:'6px 8px', fontWeight:600 }}>{dict[pdfLang].subtotal}: {fmtCurrency(totals.sumFees)}</td>
                </tr>
                </table>
                <h3 className="grandTotalBar" data-pdf-block="grand-total" style={{ textAlign:'right', marginTop:12 }}>{dict[pdfLang].grand}：{fmtCurrency(((pdfDailyMode==='total' && pdfDailyOverride!=null ? Number(pdfDailyOverride) : totals.sumDaily)) + totals.sumFurn + totals.sumDecor + fees.filter(f=>f.include_in_property_cost).reduce((s,f)=> s + (f.waived ? 0 : Number(f.total_price||0)), 0))}</h3>
              </div>
              <Space>
                <Button type="primary" onClick={()=> setPreviewOpen(true)} disabled={!items.length && !fees.length}>预览并导出PDF</Button>
              </Space>
            </div>
          )},
        ]} />
      )}
      <Drawer title={editKind==='item' ? '编辑条目' : '编辑费用'} placement="right" width={420} open={editOpen} onClose={() => setEditOpen(false)} extra={<Space><Button onClick={() => setEditOpen(false)}>取消</Button><Button type="primary" onClick={async () => {
        try {
          const v = await editForm.validateFields()
          if (!editData) return
          if (editKind === 'item') {
            const body: any = { quantity: Number(v.quantity||0), remark: v.remark }
            if (editData.group !== 'daily') body.unit_price = Number(v.unit_price||0)
            if (editData.group === 'furniture' || editData.group === 'appliance') { body.brand = v.brand; body.condition = v.condition }
            await patchJSON(`/onboarding/${editData.onboarding_id}/items/${editData.id}`, body)
            await refreshData(editData.onboarding_id)
          } else if (editKind === 'fee') {
            const nm = (v.fee_type === '其他') ? v.name : v.fee_type
            const body: any = { fee_type: v.fee_type, name: nm, quantity: Number(v.quantity||1), unit_price: Number(v.unit_price||0), include_in_property_cost: !!v.include_in_property_cost, remark: v.remark }
            await patchJSON(`/onboarding/${editData.onboarding_id}/fees/${editData.id}`, body)
            await refreshData(editData.onboarding_id)
          }
          setEditOpen(false)
          message.success('已更新')
        } catch (e: any) { message.error(e?.message || '更新失败') }
      }}>保存</Button></Space>}>
        <Form form={editForm} layout="vertical">
          {editKind==='item' ? (
            <>
              <Form.Item name="item_name" label="名称"><Input disabled /></Form.Item>
              {(editData?.group !== 'daily') && (<Form.Item name="unit_price" label="单价"><InputNumber min={0} style={{ width:'100%' }} /></Form.Item>)}
              <Form.Item name="quantity" label="数量" rules={[{ required: true }]}><InputNumber min={1} style={{ width:'100%' }} /></Form.Item>
              {(editData?.group === 'furniture' || editData?.group === 'appliance') && (
                <>
                  <Form.Item name="brand" label="品牌"><Input /></Form.Item>
                  <Form.Item name="condition" label="新旧"><Select options={[{ value:'New', label:'全新' }, { value:'Used', label:'二手' }]} /></Form.Item>
                </>
              )}
              <Form.Item name="remark" label="备注"><Input.TextArea rows={2} /></Form.Item>
            </>
          ) : (
                <>
                  <Form.Item name="fee_type" label="类型" rules={[{ required: true }]}><Select options={[{value:'平台上线费',label:'平台上线费'},{value:'人工安装费',label:'人工安装费'},{value:'第一次清洁&床品费',label:'第一次清洁&床品费'},{value:'拍照费',label:'拍照费'},{value:'其他',label:'其他'}]} /></Form.Item>
                  <Form.Item name="name" label="名称" rules={[{ required: false }]}><Input disabled={editForm.getFieldValue('fee_type') !== '其他'} /></Form.Item>
                  <Form.Item name="unit_price" label="单价" rules={[{ required: true }]}><InputNumber min={0} style={{ width:'100%' }} /></Form.Item>
                  <Form.Item name="quantity" label="数量" rules={[{ required: true }]}><InputNumber min={1} style={{ width:'100%' }} /></Form.Item>
                  <Form.Item name="include_in_property_cost" label="计入成本" valuePropName="checked"><Switch /></Form.Item>
                  <Form.Item name="remark" label="备注"><Input.TextArea rows={2} /></Form.Item>
                </>
          )}
        </Form>
      </Drawer>
      <Modal open={previewOpen} onCancel={()=> setPreviewOpen(false)} width={860} footer={<Space><Button onClick={()=> setPreviewOpen(false)}>关闭</Button><Button type="primary" onClick={generatePdfPreview}>导出PDF</Button></Space>}>
        <div ref={modalRef as any} style={{ width: 794, margin: '0 auto', padding: 16, background:'#fff' }}>
          <style>{`
            @media print {
              .tableWrap { break-inside: avoid; page-break-inside: avoid; }
              .subtotalBar { break-inside: avoid; page-break-inside: avoid; }
              .pageBreak { break-before: page; page-break-before: always; }
              .pageBreakRow { break-before: page; page-break-before: always; }
            }
          `}</style>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
            <div style={{ display:'flex', alignItems:'center', gap:12 }}>
              <img src={(typeof window!=='undefined' ? `${window.location.origin}/mz-logo.png` : '/mz-logo.png')} alt="MZ Property" style={{ height:64 }} crossOrigin="anonymous" />
            </div>
            <div style={{ textAlign:'right' }}>
              <div style={{ fontSize:22, fontWeight:700 }}>{pdfLang==='zh'?'新房上线清单':'Property Onboarding Listing'}</div>
              <div>MZ Property Pty Ltd</div>
              <div>ABN: 42 657 925 365</div>
              <div>email: info@mzproperty.com.au</div>
            </div>
          </div>
          <div style={{ display:'flex', justifyContent:'space-between', marginTop:8 }}>
            <div>{dict[pdfLang].addr}{(prop?.code ? `${prop.code} ` : '')}{prop?.address || onb?.address_snapshot || ''}</div>
            <div>{dict[pdfLang].date}{(function(){ const v = formBasic.getFieldValue('onboarding_date'); if (v && v.format) return v.format('DD/MM/YYYY'); const s = (onb?.onboarding_date || ''); return s ? dayjs(s).format('DD/MM/YYYY') : '' })()}</div>
          </div>

          {items.some(i=>i.group==='appliance') && (
            <div data-pdf-block="appliance" style={{ marginTop:12, pageBreakInside:'avoid', breakInside:'avoid-page' as any }}>
              <div className="blockTitle" style={{ textAlign:'center', fontWeight:700, borderTop:'1px solid #bbb', borderBottom:'1px solid #bbb', padding:'6px 0' }}>{dict[pdfLang].sec.appliance}</div>
              <div className="tableWrap" style={{ breakInside:'avoid', pageBreakInside:'avoid' }}>
              <table className="itemsTable" style={{ width:'100%', borderCollapse:'collapse', fontSize:11, tableLayout:'fixed' }}>
                <colgroup>
                  <col style={{ width:'34%' }} />
                  <col style={{ width:'18%' }} />
                  <col style={{ width:'10%' }} />
                  <col style={{ width:'14%' }} />
                  <col style={{ width:'14%' }} />
                  <col style={{ width:'10%' }} />
                </colgroup>
                <thead style={{ background:'#f5e8d2' }}>
                  <tr>
                    <th style={{ border:'1px solid #bbb', padding:'4px' }}>{dict[pdfLang].th.name}</th>
                    <th style={{ border:'1px solid #bbb', padding:'4px' }}>{dict[pdfLang].th.supplier}</th>
                    <th style={{ border:'1px solid #bbb', padding:'4px', textAlign:'right' }}>{dict[pdfLang].th.qty}</th>
                    <th style={{ border:'1px solid #bbb', padding:'4px', textAlign:'right' }}>{dict[pdfLang].th.unit}</th>
                    <th style={{ border:'1px solid #bbb', padding:'4px', textAlign:'right' }}>{dict[pdfLang].th.total}</th>
                    <th style={{ border:'1px solid #bbb', padding:'4px' }}>{dict[pdfLang].th.notes}</th>
                  </tr>
                </thead>
                <tbody>
                  {items.filter(i=>i.group==='appliance').map(i=> (
                    <tr key={i.id}>
                      <td style={{ border:'1px solid #bbb', padding:'4px' }}>{transName(i.item_name)}</td>
                      <td style={{ border:'1px solid #bbb', padding:'4px' }}>{i.brand || ''}</td>
                      <td style={{ border:'1px solid #bbb', padding:'4px', textAlign:'right' }}>{Number(i.quantity||0)}</td>
                      <td style={{ border:'1px solid #bbb', padding:'4px', textAlign:'right' }}>${Number(i.unit_price||0).toFixed(2)}</td>
                      <td style={{ border:'1px solid #bbb', padding:'4px', textAlign:'right' }}>${Number(i.total_price||0).toFixed(2)}</td>
                      <td style={{ border:'1px solid #bbb', padding:'4px' }}>{i.remark || ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
              <div className="subtotalBar" style={{ background:'#ffa940', padding:'6px', textAlign:'right', fontWeight:700, breakInside:'avoid', pageBreakInside:'avoid' }}>
                {pdfLang==='zh'?'合计':'Subtotal'}: ${items.filter(i=>i.group==='appliance').reduce((s,i)=> s+Number(i.total_price||0),0).toFixed(2)}
              </div>
            </div>
          )}
          {items.some(i=>i.group==='furniture') && (
            <div data-pdf-block="furniture" style={{ marginTop:12, pageBreakInside:'avoid', breakInside:'avoid-page' as any }}>
              <div className="blockTitle" style={{ textAlign:'center', fontWeight:700, borderTop:'1px solid #bbb', borderBottom:'1px solid #bbb', padding:'6px 0' }}>{dict[pdfLang].sec.furniture}</div>
              <div className="tableWrap" style={{ breakInside:'avoid', pageBreakInside:'avoid' }}>
              <table className="itemsTable" style={{ width:'100%', borderCollapse:'collapse', fontSize:11, tableLayout:'fixed' }}>
                <colgroup>
                  <col style={{ width:'34%' }} />
                  <col style={{ width:'18%' }} />
                  <col style={{ width:'10%' }} />
                  <col style={{ width:'14%' }} />
                  <col style={{ width:'14%' }} />
                  <col style={{ width:'10%' }} />
                </colgroup>
                <thead style={{ background:'#f5e8d2' }}>
                  <tr>
                    <th style={{ border:'1px solid #bbb', padding:'4px' }}>{dict[pdfLang].th.name}</th>
                    <th style={{ border:'1px solid #bbb', padding:'4px' }}>{dict[pdfLang].th.supplier}</th>
                    <th style={{ border:'1px solid #bbb', padding:'4px', textAlign:'right' }}>{dict[pdfLang].th.qty}</th>
                    <th style={{ border:'1px solid #bbb', padding:'4px', textAlign:'right' }}>{dict[pdfLang].th.unit}</th>
                    <th style={{ border:'1px solid #bbb', padding:'4px', textAlign:'right' }}>{dict[pdfLang].th.total}</th>
                    <th style={{ border:'1px solid #bbb', padding:'4px' }}>{dict[pdfLang].th.notes}</th>
                  </tr>
                </thead>
                <tbody>
                  {items.filter(i=>i.group==='furniture').map(i=> (
                    <tr key={i.id}>
                      <td style={{ border:'1px solid #bbb', padding:'4px' }}>{transName(i.item_name)}</td>
                      <td style={{ border:'1px solid #bbb', padding:'4px' }}>{i.brand || ''}</td>
                      <td style={{ border:'1px solid #bbb', padding:'4px', textAlign:'right' }}>{Number(i.quantity||0)}</td>
                      <td style={{ border:'1px solid #bbb', padding:'4px', textAlign:'right' }}>${Number(i.unit_price||0).toFixed(2)}</td>
                      <td style={{ border:'1px solid #bbb', padding:'4px', textAlign:'right' }}>${Number(i.total_price||0).toFixed(2)}</td>
                      <td style={{ border:'1px solid #bbb', padding:'4px' }}>{i.remark || ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
              <div className="subtotalBar" style={{ background:'#ffa940', padding:'6px', textAlign:'right', fontWeight:700, breakInside:'avoid', pageBreakInside:'avoid' }}>
                {pdfLang==='zh'?'合计':'Subtotal'}: ${items.filter(i=>i.group==='furniture').reduce((s,i)=> s+Number(i.total_price||0),0).toFixed(2)}
              </div>
            </div>
          )}

          {items.some(i=>i.group==='decor') && (
          <div data-pdf-block="decor" style={{ marginTop:12, pageBreakInside:'avoid', breakInside:'avoid-page' as any }}>
            <div className="blockTitle" style={{ textAlign:'center', fontWeight:700, borderTop:'1px solid #bbb', borderBottom:'1px solid #bbb', padding:'6px 0' }}>{dict[pdfLang].sec.decor}</div>
            <div className="tableWrap" style={{ breakInside:'avoid', pageBreakInside:'avoid' }}>
            <table className="itemsTable" style={{ width:'100%', borderCollapse:'collapse', fontSize:11, tableLayout:'fixed' }}>
              <colgroup>
                <col style={{ width:'34%' }} />
                <col style={{ width:'18%' }} />
                <col style={{ width:'10%' }} />
                <col style={{ width:'14%' }} />
                <col style={{ width:'14%' }} />
                <col style={{ width:'10%' }} />
              </colgroup>
              <thead style={{ background:'#f5e8d2' }}>
                <tr>
                  <th style={{ border:'1px solid #bbb', padding:'4px' }}>{dict[pdfLang].th.name}</th>
                  <th style={{ border:'1px solid #bbb', padding:'4px' }}>{dict[pdfLang].th.supplier}</th>
                  <th style={{ border:'1px solid #bbb', padding:'4px', textAlign:'right' }}>{dict[pdfLang].th.qty}</th>
                  <th style={{ border:'1px solid #bbb', padding:'4px', textAlign:'right' }}>{dict[pdfLang].th.unit}</th>
                  <th style={{ border:'1px solid #bbb', padding:'4px', textAlign:'right' }}>{dict[pdfLang].th.total}</th>
                  <th style={{ border:'1px solid #bbb', padding:'4px' }}>{dict[pdfLang].th.notes}</th>
                </tr>
              </thead>
              <tbody>
                {items.filter(i=>i.group==='decor').map(i=> (
                  <tr key={i.id}>
                    <td style={{ border:'1px solid #bbb', padding:'4px' }}>{transName(i.item_name)}</td>
                    <td style={{ border:'1px solid #bbb', padding:'4px' }}>{i.brand || ''}</td>
                    <td style={{ border:'1px solid #bbb', padding:'4px', textAlign:'right' }}>{Number(i.quantity||0)}</td>
                    <td style={{ border:'1px solid #bbb', padding:'4px', textAlign:'right' }}>${Number(i.unit_price||0).toFixed(2)}</td>
                    <td style={{ border:'1px solid #bbb', padding:'4px', textAlign:'right' }}>${Number(i.total_price||0).toFixed(2)}</td>
                    <td style={{ border:'1px solid #bbb', padding:'4px' }}></td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
            <div className="subtotalBar" style={{ background:'#ffa940', padding:'6px', textAlign:'right', fontWeight:700, breakInside:'avoid', pageBreakInside:'avoid' }}>
              {pdfLang==='zh'?'合计':'Subtotal'}: ${totals.sumDecor.toFixed(2)}
            </div>
          </div>
          )}

          {pdfDailyMode==='details' ? (
            <div data-pdf-block="daily" style={{ marginTop:12, pageBreakInside:'avoid', breakInside:'avoid-page' as any }}>
              <div className="blockTitle" style={{ textAlign:'center', fontWeight:700, borderTop:'1px solid #bbb', borderBottom:'1px solid #bbb', padding:'6px 0' }}>{dict[pdfLang].sec.daily}</div>
              <table className="itemsTable" data-kind="daily" style={{ width:'100%', borderCollapse:'collapse', fontSize:11 }}>
                <colgroup>
                  <col style={{ width:'50%' }} />
                  <col style={{ width:'12%' }} />
                  <col style={{ width:'12%' }} />
                  <col style={{ width:'14%' }} />
                  <col style={{ width:'12%' }} />
                </colgroup>
                <thead style={{ background:'#f5e8d2' }}>
                  <tr>
                    <th style={{ border:'1px solid #bbb', padding:'4px' }}>{dict[pdfLang].th.name}</th>
                    <th style={{ border:'1px solid #bbb', padding:'4px', textAlign:'right' }}>{dict[pdfLang].th.qty}</th>
                    <th style={{ border:'1px solid #bbb', padding:'4px', textAlign:'right' }}>{dict[pdfLang].th.unit}</th>
                    <th style={{ border:'1px solid #bbb', padding:'4px', textAlign:'right' }}>{dict[pdfLang].th.total}</th>
                    <th style={{ border:'1px solid #bbb', padding:'4px' }}>{dict[pdfLang].th.notes}</th>
                  </tr>
                </thead>
                <tbody>
                  {(function(){
                    const daily = items.filter(i=>i.group==='daily')
                    const catsSet = new Set<string>()
                    for (const it of daily) catsSet.add(it.category ? String(it.category).trim() : '其他')
                    const order = ['卧室','厨房','卫生间','客厅','其他']
                    const cats = Array.from(catsSet).filter(cat=> cat !== '餐厅').sort((a,b)=> (order.indexOf(a)===-1?999:order.indexOf(a)) - (order.indexOf(b)===-1?999:order.indexOf(b)))
                    const rows: any[] = []
                    for (const area of cats) {
                      rows.push(
                        <tr key={`hdr-${area}`} className="groupHeader"><td colSpan={5} style={{ background:'#f0f0f0', fontWeight:600, padding:'6px' }}>{transArea(area)}</td></tr>
                      )
                      daily.filter(i=> ((i.category ? String(i.category).trim() : '其他')) === area).forEach(i=> {
                        rows.push(
                          <tr key={i.id}>
                            <td style={{ border:'1px solid #bbb', padding:'4px' }}>{transName(i.item_name)}</td>
                            <td style={{ border:'1px solid #bbb', padding:'4px', textAlign:'right' }}>{Number(i.quantity||0)}</td>
                            <td style={{ border:'1px solid #bbb', padding:'4px', textAlign:'right' }}>${Number(i.unit_price||0).toFixed(2)}</td>
                            <td style={{ border:'1px solid #bbb', padding:'4px', textAlign:'right' }}>${Number(i.total_price||0).toFixed(2)}</td>
                            <td style={{ border:'1px solid #bbb', padding:'4px' }}>{i.remark || ''}</td>
                          </tr>
                        )
                      })
                    }
                    return rows
                  })()}
                </tbody>
              </table>
              <div className="subtotalBar" style={{ background:'#ffa940', padding:'6px', textAlign:'right', fontWeight:700, breakInside:'avoid', pageBreakInside:'avoid' }}>{pdfLang==='zh'?'合计':'Subtotal'}: ${totals.sumDaily.toFixed(2)}</div>
            </div>
          ) : (
            <div data-pdf-block="daily" style={{ marginTop:12, pageBreakInside:'avoid', breakInside:'avoid-page' as any }}>
              <div className="blockTitle" style={{ textAlign:'center', fontWeight:700, borderTop:'1px solid #bbb', borderBottom:'1px solid #bbb', padding:'6px 0' }}>{dict[pdfLang].sec.daily}</div>
              <table className="itemsTable" data-kind="daily" style={{ width:'100%', borderCollapse:'collapse', fontSize:11 }}>
                <colgroup>
                  <col style={{ width:'70%' }} />
                  <col style={{ width:'30%' }} />
                </colgroup>
                <thead style={{ background:'#f5e8d2' }}>
                  <tr>
                    <th style={{ border:'1px solid #bbb', padding:'4px' }}>{dict[pdfLang].th.name}</th>
                    <th style={{ border:'1px solid #bbb', padding:'4px', textAlign:'right' }}>{dict[pdfLang].th.qty}</th>
                  </tr>
                </thead>
                <tbody>
                  {(function(){
                    const daily = items.filter(i=>i.group==='daily')
                    const catsSet = new Set<string>()
                    for (const it of daily) catsSet.add(it.category ? String(it.category).trim() : '其他')
                    const order = ['卧室','厨房','卫生间','客厅','其他']
                    const cats = Array.from(catsSet).filter(cat=> cat !== '餐厅').sort((a,b)=> (order.indexOf(a)===-1?999:order.indexOf(a)) - (order.indexOf(b)===-1?999:order.indexOf(b)))
                    const rows: any[] = []
                    for (const area of cats) {
                      rows.push(
                        <tr key={`hdr-${area}`} className="groupHeader"><td colSpan={2} style={{ background:'#f0f0f0', fontWeight:600, padding:'6px' }}>{transArea(area)}</td></tr>
                      )
                      daily.filter(i=> ((i.category ? String(i.category).trim() : '其他')) === area).forEach(i=> {
                        rows.push(
                          <tr key={i.id}>
                            <td style={{ border:'1px solid #bbb', padding:'4px' }}>{transName(i.item_name)}</td>
                            <td style={{ border:'1px solid #bbb', padding:'4px', textAlign:'right' }}>{Number(i.quantity||0)}</td>
                          </tr>
                        )
                      })
                    }
                    return rows
                  })()}
                </tbody>
              </table>
              <div className="subtotalBar" style={{ background:'#ffa940', padding:'6px', textAlign:'right', fontWeight:700, breakInside:'avoid', pageBreakInside:'avoid' }}>{pdfLang==='zh'?'合计':'Subtotal'}: ${(pdfDailyOverride!=null ? Number(pdfDailyOverride) : totals.sumDaily).toFixed(2)}</div>
            </div>
          )}

          <div data-pdf-block="fees" style={{ marginTop:12, pageBreakInside:'avoid', breakInside:'avoid-page' as any }}>
            <div className="blockTitle" style={{ textAlign:'center', fontWeight:700, borderTop:'1px solid #bbb', borderBottom:'1px solid #bbb', padding:'6px 0' }}>{dict[pdfLang].sec.fees}</div>
            <table style={{ width:'100%', borderCollapse:'collapse', fontSize:11, tableLayout:'fixed' }}>
              <colgroup>
                <col style={{ width:'25%' }} />
                <col style={{ width:'35%' }} />
                <col style={{ width:'10%' }} />
                <col style={{ width:'15%' }} />
                <col style={{ width:'15%' }} />
              </colgroup>
              <thead style={{ background:'#f5e8d2' }}>
                <tr>
                  <th style={{ border:'1px solid #bbb', padding:'4px' }}>{dict[pdfLang].th.name}</th>
                  <th style={{ border:'1px solid #bbb', padding:'4px', textAlign:'right' }}>{dict[pdfLang].th.qty}</th>
                  <th style={{ border:'1px solid #bbb', padding:'4px', textAlign:'right' }}>{dict[pdfLang].th.unit}</th>
                  <th style={{ border:'1px solid #bbb', padding:'4px', textAlign:'right' }}>{dict[pdfLang].th.total}</th>
                  <th style={{ border:'1px solid #bbb', padding:'4px' }}>{dict[pdfLang].th.notes}</th>
                </tr>
              </thead>
              <tbody>
                {fees.map(f=> (
                  <tr key={f.id}>
                    <td style={{ border:'1px solid #bbb', padding:'4px' }}>{transName(f.name)}</td>
                    <td style={{ border:'1px solid #bbb', padding:'4px', textAlign:'right' }}>{Number(f.quantity||0)}</td>
                    <td style={{ border:'1px solid #bbb', padding:'4px', textAlign:'right' }}>{f.waived ? (<span><s>${Number(f.unit_price||0).toFixed(2)}</s> $0.00</span>) : (`$${Number(f.unit_price||0).toFixed(2)}`)}</td>
                    <td style={{ border:'1px solid #bbb', padding:'4px', textAlign:'right' }}>{f.waived ? (<span><s>${Number(f.total_price||0).toFixed(2)}</s> $0.00</span>) : (`$${Number(f.total_price||0).toFixed(2)}`)}</td>
                    <td style={{ border:'1px solid #bbb', padding:'4px' }}></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="subtotalBar" style={{ background:'#ffa940', padding:'6px', textAlign:'right', fontWeight:700, breakInside:'avoid', pageBreakInside:'avoid' }}>{pdfLang==='zh'?'合计':'Subtotal'}: ${totals.sumFees.toFixed(2)}</div>
          </div>

          <div className="grandTotalBar" data-pdf-block="grand-total" style={{ textAlign:'right', marginTop:12, fontWeight:700 }}>Grand Total：${(((pdfDailyMode==='total' && pdfDailyOverride!=null ? Number(pdfDailyOverride) : totals.sumDaily)) + totals.sumFurn + totals.sumDecor + fees.filter(f=>f.include_in_property_cost).reduce((s,f)=> s + (f.waived ? 0 : Number(f.total_price||0)), 0)).toFixed(2)}</div>
        </div>
      </Modal>
    </Card>
  )
}
