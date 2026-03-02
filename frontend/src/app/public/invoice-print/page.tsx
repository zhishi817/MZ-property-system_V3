"use client"

import { useEffect, useMemo, useRef, useState } from 'react'
import { getJSON } from '../../../lib/api'
import { buildInvoiceTemplateHtml, normalizeAssetUrl } from '../../../lib/invoiceTemplateHtml'

export default function PublicInvoicePrintPage() {
  const [invoiceId, setInvoiceId] = useState<string>('')
  const [invoice, setInvoice] = useState<any>(null)
  const [ready, setReady] = useState(false)
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
      await Promise.race([Promise.all(loaders), new Promise((r) => setTimeout(r, 8000))])
    } catch {}
  }

  useEffect(() => {
    try {
      const qs = typeof window !== 'undefined' ? window.location.search : ''
      const sp = new URLSearchParams(qs || '')
      const id = String(sp.get('invoice_id') || '').trim()
      if (id) setInvoiceId(id)
    } catch {}
  }, [])

  useEffect(() => {
    if (!invoiceId) return
    let alive = true
    setReady(false)
    getJSON<any>(`/invoices/${encodeURIComponent(invoiceId)}`)
      .then(async (j) => {
        if (!alive) return
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
      .catch(() => {
        if (!alive) return
        setInvoice(null)
      })
    return () => { alive = false }
  }, [invoiceId])

  const srcDoc = useMemo(() => {
    if (!invoice) return ''
    const data = { invoice: invoice, company: invoice.company || {} }
    return buildInvoiceTemplateHtml({ template: 'classic', data })
  }, [invoice])

  useEffect(() => {
    if (!invoice || !srcDoc) return
    let cancelled = false
    setReady(false)
    const t = window.setTimeout(() => {
      if (cancelled) return
      setReady(true)
    }, 12000)
    const onLoad = async () => {
      try {
        const doc = iframeRef.current?.contentDocument
        if (!doc) return
        await waitForIframeAssets(doc)
        if (!cancelled) setReady(true)
      } catch {}
    }
    const iframe = iframeRef.current
    if (iframe) iframe.addEventListener('load', onLoad)
    return () => {
      cancelled = true
      window.clearTimeout(t)
      try { if (iframe) iframe.removeEventListener('load', onLoad) } catch {}
    }
  }, [invoice, srcDoc])

  return (
    <div data-invoice-ready={ready ? '1' : '0'} style={{ background: '#fff' }}>
      <iframe
        ref={iframeRef}
        title="invoice-print"
        style={{ width: '100%', minHeight: '100vh', border: 'none', background: '#fff' }}
        srcDoc={srcDoc}
      />
    </div>
  )
}

