"use client"

import { Typography } from 'antd'
import type { CSSProperties, ReactNode } from 'react'
import { uiTokens } from '../../lib/uiTokens'

type Variant = 'title' | 'section' | 'body' | 'caption' | 'label'

const variantStyles: Record<Variant, CSSProperties> = {
  title: { fontSize: uiTokens.font.xxl, lineHeight: 1.4, fontWeight: 800, color: '#111827' },
  section: { fontSize: uiTokens.font.xl, lineHeight: 1.45, fontWeight: 800, color: '#111827' },
  body: { fontSize: uiTokens.font.md, lineHeight: 1.6, fontWeight: 500, color: '#374151' },
  caption: { fontSize: uiTokens.font.sm, lineHeight: 1.55, fontWeight: 500, color: '#6B7280' },
  label: { fontSize: uiTokens.font.sm, lineHeight: 1.5, fontWeight: 700, color: '#111827' },
}

export default function AppText({
  children,
  expandable,
  numberOfLines,
  style,
  variant = 'body',
}: {
  children: ReactNode
  expandable?: boolean
  numberOfLines?: number
  style?: CSSProperties
  variant?: Variant
}) {
  if (expandable || numberOfLines) {
    return (
      <Typography.Paragraph
        ellipsis={numberOfLines ? { rows: numberOfLines, expandable: !!expandable, symbol: expandable ? '展开' : undefined } : undefined}
        style={{ marginBottom: 0, ...variantStyles[variant], ...style }}
      >
        {children}
      </Typography.Paragraph>
    )
  }

  return (
    <Typography.Text style={{ ...variantStyles[variant], ...style }}>
      {children}
    </Typography.Text>
  )
}
