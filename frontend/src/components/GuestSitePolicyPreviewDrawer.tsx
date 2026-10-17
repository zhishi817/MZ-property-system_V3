"use client"

import { Alert, Drawer } from 'antd'
import { useCallback, useEffect, useRef, useState } from 'react'

const BOOKING_SITE_BASE = process.env.NEXT_PUBLIC_BOOKING_SITE_URL || process.env.NEXT_PUBLIC_BOOKING_FRONTEND_URL || 'http://localhost:3004'
const BOOKING_SITE_ORIGIN = (() => { try { return new URL(BOOKING_SITE_BASE).origin } catch { return '' } })()

export default function GuestSitePolicyPreviewDrawer({ open, onClose, property, title }: { open: boolean; onClose: () => void; property: Record<string, unknown> | null; title: string }) {
  const [nonce, setNonce] = useState('')
  const frameRef = useRef<HTMLIFrameElement | null>(null)

  useEffect(() => {
    setNonce(open ? window.crypto.randomUUID() : '')
  }, [open])
  const send = useCallback(() => {
    if (!property || !nonce || !BOOKING_SITE_ORIGIN || !frameRef.current?.contentWindow) return
    frameRef.current.contentWindow.postMessage({ type: 'mz-admin-property-preview', nonce, property }, BOOKING_SITE_ORIGIN)
  }, [nonce, property])

  useEffect(() => {
    if (!open || !nonce) return
    const receive = (event: MessageEvent) => {
      if (event.origin !== BOOKING_SITE_ORIGIN || event.source !== frameRef.current?.contentWindow) return
      if (event.data?.type === 'mz-property-preview-ready' && event.data?.nonce === nonce) send()
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [open, nonce, send])

  return <Drawer open={open} onClose={onClose} destroyOnClose width="min(1200px, 100vw)" title={title}>
    <Alert type="info" showIcon message="只读真实布局预览" description="候选内容仅通过当前认证后台内存传给共享访客详情组件；不会保存、发布、请求 availability 或生成公开草稿链接。" style={{ marginBottom: 16 }} />
    {property && nonce ? <iframe ref={frameRef} data-policy-preview src={`${BOOKING_SITE_BASE.replace(/\/+$/g, '')}/property-preview#${nonce}`} title={title} sandbox="allow-scripts allow-same-origin" onLoad={send} style={{ display: 'block', width: '100%', height: 'calc(100dvh - 170px)', minHeight: 480, border: '1px solid #d9d9d9', borderRadius: 8, background: '#f7f0e6' }} /> : null}
  </Drawer>
}
