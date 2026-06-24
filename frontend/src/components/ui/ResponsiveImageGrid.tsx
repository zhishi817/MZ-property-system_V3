"use client"

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { resolveResponsiveColumns, uiTokens } from '../../lib/uiTokens'

type Props<T> = {
  gap?: number
  items: readonly T[]
  keyExtractor: (item: T, index: number) => string
  renderItem: (item: T, index: number, itemWidth: number) => ReactNode
}

export default function ResponsiveImageGrid<T>({
  gap = uiTokens.spacing.sm,
  items,
  keyExtractor,
  renderItem,
}: Props<T>) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [containerWidth, setContainerWidth] = useState(0)

  useEffect(() => {
    const node = containerRef.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      const width = Math.max(0, Math.floor(entry.contentRect.width))
      setContainerWidth(width)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const { columns, itemWidth } = useMemo(() => {
    const columns = resolveResponsiveColumns(containerWidth || uiTokens.breakpoints.mobile)
    const totalGap = gap * Math.max(0, columns - 1)
    const itemWidth = containerWidth > 0 ? Math.floor((containerWidth - totalGap) / columns) : 0
    return { columns, itemWidth }
  }, [containerWidth, gap])

  return (
    <div ref={containerRef} style={{ width: '100%', display: 'flex', flexWrap: 'wrap', gap }}>
      {items.map((item, index) => (
        <div key={keyExtractor(item, index)} style={{ width: itemWidth > 0 ? itemWidth : `calc(${100 / columns}% - ${gap}px)` }}>
          {renderItem(item, index, itemWidth)}
        </div>
      ))}
    </div>
  )
}
