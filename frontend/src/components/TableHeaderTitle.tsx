"use client"
import { Tooltip } from 'antd'
import React, { useLayoutEffect, useMemo, useRef, useState } from 'react'

function nodeToText(n: any): string {
  if (n == null) return ''
  if (typeof n === 'string' || typeof n === 'number' || typeof n === 'boolean') return String(n)
  if (Array.isArray(n)) return n.map(nodeToText).join('')
  if (React.isValidElement(n)) return nodeToText((n as any).props?.children)
  return ''
}

export default function TableHeaderTitle({
  title,
  tooltipText,
  minWidth,
}: {
  title: React.ReactNode
  tooltipText?: string
  minWidth?: number
}) {
  const ref = useRef<HTMLSpanElement | null>(null)
  const [overflowed, setOverflowed] = useState(false)

  const text = useMemo(() => {
    const t = String(tooltipText || '').trim()
    if (t) return t
    return nodeToText(title).trim()
  }, [title, tooltipText])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const check = () => {
      try {
        const p = el.parentElement as HTMLElement | null
        if (!p) return
        const over = (p.scrollWidth - p.clientWidth) > 1 || (p.scrollHeight - p.clientHeight) > 1
        setOverflowed(over)
      } catch {}
    }
    check()
    const ro = new ResizeObserver(() => check())
    try { ro.observe(el) } catch {}
    try { if (el.parentElement) ro.observe(el.parentElement) } catch {}
    return () => { try { ro.disconnect() } catch {} }
  }, [title])

  const inner = (
    <span ref={ref} style={minWidth ? { display: 'inline-block', minWidth } : undefined}>{title}</span>
  )

  if (!text) return inner
  if (!overflowed) return inner
  return <Tooltip title={text}>{inner}</Tooltip>
}

