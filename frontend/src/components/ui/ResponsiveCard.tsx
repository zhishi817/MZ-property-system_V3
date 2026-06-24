"use client"

import type { CSSProperties, ReactNode } from 'react'
import { uiTokens } from '../../lib/uiTokens'

export default function ResponsiveCard({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div
      style={{
        background: '#fff',
        border: '1px solid #E5E7EB',
        borderRadius: uiTokens.radius.lg,
        padding: uiTokens.spacing.lg,
        display: 'grid',
        gap: uiTokens.spacing.md,
        ...style,
      }}
    >
      {children}
    </div>
  )
}
