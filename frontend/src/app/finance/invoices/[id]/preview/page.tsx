"use client"

import { useEffect, useMemo, useRef, useState } from 'react'
import { App, Button, Card, Col, Grid, Row, Space } from 'antd'
import dayjs from 'dayjs'
import { useRouter } from 'next/navigation'
import html2canvas from 'html2canvas'
import { jsPDF } from 'jspdf'
import { getJSON } from '../../../../../lib/api'
import { buildInvoiceTemplateHtml } from '../../../../../lib/invoiceTemplateHtml'

export default function InvoicePreviewPage({ params }: { params: { id: string } }) {
  const router = useRouter()
  const { message } = App.useApp()
  const screens = Grid.useBreakpoint()
  const isMobile = !screens.md

  const id = String(params?.id || '')
  const [invoice, setInvoice] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)

  useEffect(() => {
    if (!id) return
    setLoading(true)
    getJSON<any>(`/invoices/${id}`)
      .then((j) => { setInvoice(j); })
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
      const win = iframeRef.current?.contentWindow
      if (!win) return
      win.focus()
      win.print()
    } catch {
      message.error('打印失败')
    }
  }

  async function capturePng(params: { label: string; injectStyleText?: string }) {
    const doc = iframeRef.current?.contentDocument
    if (!doc) throw new Error('missing_iframe')
    const styleId = 'inv-capture-style'
    const prev = doc.getElementById(styleId)
    if (prev) prev.remove()
    if (params.injectStyleText) {
      const st = doc.createElement('style')
      st.id = styleId
      st.textContent = params.injectStyleText
      doc.head.appendChild(st)
    }
    await new Promise(r => setTimeout(r, 50))
    const canvas = await html2canvas(doc.body, { scale: 2, backgroundColor: '#ffffff', useCORS: true })
    const blob: Blob = await new Promise((resolve, reject) => {
      canvas.toBlob((b) => b ? resolve(b) : reject(new Error('toBlob_failed')), 'image/png')
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `invoice_${invoice?.invoice_no || id}_${params.label}_${dayjs().format('YYYYMMDD_HHmm')}.png`.replace(/[^\w\-\.]+/g, '_')
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
    if (params.injectStyleText) {
      const now = doc.getElementById(styleId)
      if (now) now.remove()
    }
  }

  async function downloadCompare() {
    try {
      if (!invoice) return
      const beforeStyle = `
        html, body { font-size: 10px !important; font-weight: 300 !important; }
        .inv-title h1 { font-size: 16px !important; font-weight: 600 !important; }
        .inv-band .meta .v { font-size: 12px !important; font-weight: 500 !important; }
        .inv-table { font-size: 10px !important; }
        .inv-summary td:last-child { font-size: 12px !important; }
        .inv-amount-due .value { font-size: 18px !important; }
      `
      await capturePng({ label: 'before', injectStyleText: beforeStyle })
      await capturePng({ label: 'after' })
      message.success('对比图已下载')
    } catch (e: any) {
      message.error(String(e?.message || '导出失败'))
    }
  }

  async function exportPdf() {
    try {
      const doc = iframeRef.current?.contentDocument
      if (!doc) return
      const body = doc.body
      const canvas = await html2canvas(body, { scale: 2, backgroundColor: '#ffffff', useCORS: true })
      const imgData = canvas.toDataURL('image/jpeg', 0.92)
      const pdf = new jsPDF('p', 'mm', 'a4')
      const pageW = 210
      const pageH = 297
      const imgW = pageW
      const imgH = canvas.height * (imgW / canvas.width)
      let y = 0
      let remaining = imgH
      while (remaining > 0) {
        pdf.addImage(imgData, 'JPEG', 0, y, imgW, imgH)
        remaining -= pageH
        if (remaining > 0) { pdf.addPage(); y -= pageH }
      }
      const name = `invoice_${invoice?.invoice_no || id}_${dayjs().format('YYYYMMDD_HHmm')}.pdf`.replace(/[^\w\-\.]+/g, '_')
      pdf.save(name)
    } catch (e: any) {
      message.error(String(e?.message || '导出失败'))
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
            <Button onClick={downloadCompare} disabled={!srcDoc}>下载对比图</Button>
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
