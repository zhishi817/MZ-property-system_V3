"use client"

import { useEffect, useMemo, useRef, useState } from 'react'
import { App, Button, Card, Col, Grid, Row, Space } from 'antd'
import dayjs from 'dayjs'
import { useRouter } from 'next/navigation'
import html2canvas from 'html2canvas'
import { jsPDF } from 'jspdf'
import { getJSON } from '../../../../../lib/api'
import { buildInvoiceTemplateHtml, normalizeAssetUrl } from '../../../../../lib/invoiceTemplateHtml'

export default function InvoicePreviewPage({ params }: { params: { id: string } }) {
  const router = useRouter()
  const { message } = App.useApp()
  const screens = Grid.useBreakpoint()
  const isMobile = !screens.md

  const id = String(params?.id || '')
  const [invoice, setInvoice] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)

  function isR2Url(u: string) {
    try {
      const url = new URL(u)
      const host = String(url.hostname || '').toLowerCase()
      return host.endsWith('.r2.dev') || host.includes('r2.cloudflarestorage.com')
    } catch {
      return false
    }
  }

  async function tryFetchDataUrl(url: string) {
    const u = String(url || '').trim()
    if (!u) return null
    if (u.startsWith('data:')) return u
    try {
      const resp = await fetch(u, { credentials: 'include' })
      if (!resp.ok) return null
      const blob = await resp.blob()
      const dataUrl: string = await new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result || ''))
        reader.onerror = () => reject(new Error('read_logo_failed'))
        reader.readAsDataURL(blob)
      })
      if (!String(dataUrl || '').startsWith('data:')) return null
      return dataUrl
    } catch {
      return null
    }
  }

  async function waitForIframeAssets(doc: Document) {
    try {
      const fonts: any = (doc as any).fonts
      if (fonts?.ready) {
        await Promise.race([fonts.ready, new Promise((r) => setTimeout(r, 1500))])
      }
    } catch {}
    try {
      const imgs = Array.from(doc.images || [])
      const loaders = imgs.map((img) => {
        if (img.complete) return Promise.resolve()
        return new Promise<void>((resolve) => {
          const done = () => {
            img.removeEventListener('load', done)
            img.removeEventListener('error', done)
            resolve()
          }
          img.addEventListener('load', done)
          img.addEventListener('error', done)
        })
      })
      await Promise.race([Promise.all(loaders), new Promise((r) => setTimeout(r, 4000))])
    } catch {}
  }

  useEffect(() => {
    if (!id) return
    setLoading(true)
    getJSON<any>(`/invoices/${id}`)
      .then(async (j) => {
        const next = { ...(j || {}), company: { ...(j?.company || {}) } }
        const logo = String(next.company?.logo_url || '').trim()
        if (logo) {
          const abs = normalizeAssetUrl(logo)
          const proxied = isR2Url(abs) ? `${normalizeAssetUrl('/public/r2-image')}?url=${encodeURIComponent(abs)}` : abs
          const inlined = await tryFetchDataUrl(proxied)
          next.company.logo_url = inlined || proxied
        }
        setInvoice(next)
      })
      .catch((e: any) => message.error(String(e?.message || '加载失败')))
      .finally(() => setLoading(false))
  }, [id])

  const srcDoc = useMemo(() => {
    if (!invoice) return ''
    const data = { invoice: invoice, company: invoice.company || {} }
    return buildInvoiceTemplateHtml({ template: 'classic', data })
  }, [invoice])

  async function doPrint() {
    try {
      const doc = iframeRef.current?.contentDocument
      if (!doc) { message.error('打印失败'); return }
      const printCss = `
        @media print {
          .inv-header { grid-template-columns: 1fr 1fr !important; gap: 16px !important; }
          .inv-title { text-align: right !important; }
          .inv-band { grid-template-columns: 1fr 1fr !important; }
          .inv-footer-grid { grid-template-columns: 1fr 0.9fr !important; }
        }
      `
      const win = iframeRef.current?.contentWindow
      if (!win) return
      win.focus()
      await withTempStyle(doc, 'inv-print-style', printCss, async () => {
        await waitForIframeAssets(doc)
        win.print()
      })
    } catch {
      message.error('打印失败')
    }
  }

  async function withTempStyle<T>(doc: Document, id: string, cssText: string, fn: () => Promise<T>): Promise<T> {
    const prev = doc.getElementById(id)
    if (prev) prev.remove()
    const st = doc.createElement('style')
    st.id = id
    st.textContent = cssText
    doc.head.appendChild(st)
    try {
      return await fn()
    } finally {
      try { st.remove() } catch {}
    }
  }

  async function exportPdf() {
    const key = 'invoice-export-pdf'
    message.loading({ content: '正在生成 PDF…', key, duration: 0 })
    try {
      const doc = iframeRef.current?.contentDocument
      if (!doc) throw new Error('missing_iframe')
      const target = (doc.querySelector('.inv-sheet') as HTMLElement | null) || doc.body
      const exportCss = `
        html, body { background: #ffffff !important; }
        .inv-preview-wrap { padding: 0 !important; text-align: left !important; }
        .inv-sheet { border: none !important; border-radius: 0 !important; box-shadow: none !important; width: 794px !important; height: 1123px !important; min-height: 0 !important; overflow: hidden !important; }
        .inv-page { padding: 76px !important; height: 1123px !important; min-height: 0 !important; box-sizing: border-box !important; }
      `
      const canvas = await withTempStyle(doc, 'inv-export-style', exportCss, async () => {
        await new Promise(r => setTimeout(r, 60))
        await waitForIframeAssets(doc)
        return await html2canvas(target, {
          scale: 2,
          backgroundColor: '#ffffff',
          useCORS: true,
          allowTaint: false,
          imageTimeout: 15000,
          scrollX: 0,
          scrollY: 0,
          windowWidth: Math.max(target.scrollWidth || 0, target.clientWidth || 0),
          windowHeight: Math.max(target.scrollHeight || 0, target.clientHeight || 0),
        })
      })
      const pdf = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4', compress: true })
      const pageW = pdf.internal.pageSize.getWidth()
      const pageH = pdf.internal.pageSize.getHeight()
      const pxPerMm = canvas.width / pageW
      const pagePxH = Math.floor(pageH * pxPerMm)
      let yPx = 0
      let pageIndex = 0
      while (yPx < canvas.height) {
        const remaining = canvas.height - yPx
        if (pageIndex > 0 && remaining < Math.ceil(pxPerMm * 2)) break
        if (pageIndex > 0) pdf.addPage()
        const sliceH = Math.min(pagePxH, remaining)
        const pageCanvas = document.createElement('canvas')
        pageCanvas.width = canvas.width
        pageCanvas.height = sliceH
        const ctx = pageCanvas.getContext('2d')
        if (!ctx) throw new Error('canvas_ctx_failed')
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, pageCanvas.width, pageCanvas.height)
        ctx.drawImage(canvas, 0, yPx, canvas.width, sliceH, 0, 0, canvas.width, sliceH)
        const imgData = pageCanvas.toDataURL('image/png')
        const imgH = pageW * (sliceH / canvas.width)
        pdf.addImage(imgData, 'PNG', 0, 0, pageW, imgH)
        yPx += sliceH
        pageIndex += 1
      }
      const name = `invoice_${invoice?.invoice_no || id}_${dayjs().format('YYYYMMDD_HHmm')}.pdf`.replace(/[^\w\-\.]+/g, '_')
      pdf.save(name)
      message.success({ content: 'PDF 已导出', key })
    } catch (e: any) {
      const msg = String(e?.message || '')
      if (msg.includes('missing_iframe')) {
        message.error({ content: '导出失败：预览未加载完成，请稍后重试', key })
      } else if (msg.includes('SecurityError') || msg.toLowerCase().includes('taint')) {
        message.error({ content: '导出失败：存在跨域图片导致截图受限（请检查公司 Logo 链接/权限）', key })
      } else {
        message.error({ content: msg || '导出失败', key })
      }
    }
  }

  return (
    <div style={{ background: '#F5F7FA', padding: 16, minHeight: 'calc(100vh - 64px)' }}>
      <Card
        loading={loading}
        title="发票预览"
        extra={(
          <Space wrap style={{ justifyContent: isMobile ? 'flex-start' : 'flex-end' }}>
            <Button onClick={doPrint} disabled={!srcDoc}>打印</Button>
            <Button onClick={exportPdf} disabled={!srcDoc}>导出 PDF</Button>
            <Button type="primary" onClick={() => router.back()}>返回编辑</Button>
          </Space>
        )}
      >
        <Row gutter={16}>
          <Col span={24}>
            <div style={{ width: '100%', display: 'flex', justifyContent: 'center' }}>
              <iframe
                ref={iframeRef}
                title="invoice-preview"
                style={{
                  width: isMobile ? '100%' : 980,
                  height: isMobile ? 760 : 900,
                  border: '1px solid rgba(0,0,0,0.08)',
                  borderRadius: 10,
                  background: '#fff',
                }}
                srcDoc={srcDoc}
              />
            </div>
          </Col>
        </Row>
      </Card>
    </div>
  )
}
