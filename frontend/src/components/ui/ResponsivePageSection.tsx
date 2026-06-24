"use client"

import type { CSSProperties, ReactNode } from 'react'
import { uiTokens } from '../../lib/uiTokens'

export default function ResponsivePageSection({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div
      style={{
        width: '100%',
        maxWidth: uiTokens.contentMaxWidth,
        margin: '0 auto',
        paddingInline: uiTokens.spacing.lg,
        display: 'grid',
        gap: uiTokens.spacing.lg,
        ...style,
      }}
    >
      {children}
    </div>
  )
}
