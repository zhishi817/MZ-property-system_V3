"use client"

import Image from 'next/image'
import { Spin, Typography } from 'antd'
import { useEffect, useState } from 'react'

type PdfPreviewProps = {
  url: string
}

type RenderedPage = {
  pageNumber: number
  src: string
  width: number
  height: number
}

const DISPLAY_SCALE = 1.55
const MAX_OUTPUT_SCALE = 3

export default function PdfPreview({ url }: PdfPreviewProps) {
  const [pages, setPages] = useState<RenderedPage[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    const objectUrls: string[] = []

    async function load() {
      setLoading(true)
      setError('')
      setPages([])
      try {
        const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
        pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/legacy/build/pdf.worker.min.mjs', import.meta.url).toString()

        const doc = await pdfjs.getDocument(url).promise
        const rendered: RenderedPage[] = []

        for (let i = 1; i <= doc.numPages; i += 1) {
          const page = await doc.getPage(i)
          const outputScale = Math.min(MAX_OUTPUT_SCALE, Math.max(2, window.devicePixelRatio || 1))
          const displayViewport = page.getViewport({ scale: DISPLAY_SCALE })
          const renderViewport = page.getViewport({ scale: DISPLAY_SCALE * outputScale })
          const canvas = document.createElement('canvas')
          const context = canvas.getContext('2d')
          if (!context) throw new Error('无法初始化 PDF 画布')
          canvas.width = Math.ceil(renderViewport.width)
          canvas.height = Math.ceil(renderViewport.height)
          await page.render({ canvasContext: context, canvas, viewport: renderViewport }).promise
          const blob = await new Promise<Blob>((resolve, reject) => {
            canvas.toBlob((value) => value ? resolve(value) : reject(new Error('PDF 页面转换失败')), 'image/png')
          })
          const objectUrl = URL.createObjectURL(blob)
          objectUrls.push(objectUrl)
          rendered.push({ pageNumber: i, src: objectUrl, width: Math.ceil(displayViewport.width), height: Math.ceil(displayViewport.height) })
        }

        if (!cancelled) setPages(rendered)
      } catch (e: any) {
        if (!cancelled) setError(e?.message || '文档预览加载失败')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => {
      cancelled = true
      objectUrls.forEach((value) => URL.revokeObjectURL(value))
    }
  }, [url])

  if (loading) {
    return (
      <div style={{ minHeight: '50vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#fafafa', borderRadius: 12 }}>
        <Spin tip="正在加载文档预览..." />
      </div>
    )
  }

  if (error) {
    return (
      <div style={{ minHeight: 260, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#fff7f7', border: '1px solid #ffd6d6', borderRadius: 12, padding: 24 }}>
        <Typography.Text type="danger">{error}</Typography.Text>
      </div>
    )
  }

  return (
    <div style={{ background: '#f5f5f5', borderRadius: 12, padding: 16 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'center' }}>
        {pages.map((page) => (
          <Image
            key={page.pageNumber}
            src={page.src}
            alt={`PDF 第 ${page.pageNumber} 页`}
            width={page.width}
            height={page.height}
            unoptimized
            style={{ width: '100%', maxWidth: page.width, height: 'auto', display: 'block', background: '#fff', boxShadow: '0 6px 18px rgba(0,0,0,0.08)' }}
          />
        ))}
      </div>
    </div>
  )
}
