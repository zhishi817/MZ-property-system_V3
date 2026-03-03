"use client"

import { useEffect, useRef, useState } from 'react'
import { getJSON } from '../../../lib/api'
import { normalizeAssetUrl } from '../../../lib/invoiceTemplateHtml'

export default function PublicInvoicePrintPage() {
  const [invoiceId, setInvoiceId] = useState<string>('')
  const [invoice, setInvoice] = useState<any>(null)
  const [ready, setReady] = useState(false)
  const loadSeqRef = useRef(0)

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

  async function waitForAssets(doc: Document) {
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

  async function loadTemplateIntoPage(inv: any) {
    const seq = ++loadSeqRef.current
    setReady(false)
    try {
      const root = document.getElementById('invoice-root')
      if (root) root.innerHTML = ''
      ;(window as any).__INVOICE_TEMPLATE__ = 'classic'
      ;(window as any).__INVOICE_DATA__ = { invoice: inv, company: inv?.company || {} }

      const cssId = 'invoice-template-css'
      if (!document.getElementById(cssId)) {
        const link = document.createElement('link')
        link.id = cssId
        link.rel = 'stylesheet'
        link.href = '/invoice-templates/invoice-template.css'
        document.head.appendChild(link)
      }

      const jsId = 'invoice-template-js'
      const prev = document.getElementById(jsId)
      if (prev) prev.remove()
      await new Promise<void>((resolve, reject) => {
        const s = document.createElement('script')
        s.id = jsId
        s.src = '/invoice-templates/invoice-template.js'
        s.async = true
        s.onload = () => resolve()
        s.onerror = () => reject(new Error('load_template_failed'))
        document.body.appendChild(s)
      })

      await waitForAssets(document)
      if (loadSeqRef.current === seq) setReady(true)
    } catch {
      if (loadSeqRef.current === seq) setReady(true)
    }
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

  useEffect(() => {
    if (!invoice) return
    let cancelled = false
    setReady(false)
    const t = window.setTimeout(() => {
      if (cancelled) return
      setReady(true)
    }, 12000)
    loadTemplateIntoPage(invoice)
    return () => {
      cancelled = true
      window.clearTimeout(t)
    }
  }, [invoice])

  return (
    <div data-invoice-ready={ready ? '1' : '0'} style={{ background: '#fff' }}>
      <style>{`
        @media print {
          @page { size: A4; margin: 20mm; }
        }
      `}</style>
      <div id="invoice-root" />
    </div>
  )
}
