"use client"

import { Button, type ButtonProps } from 'antd'
import { uiTokens } from '../../lib/uiTokens'

export default function AppButton(props: ButtonProps) {
  return (
    <Button
      {...props}
      style={{
        minHeight: uiTokens.touchMinSize,
        paddingInline: uiTokens.spacing.lg,
        whiteSpace: 'normal',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        ...props.style,
      }}
    />
  )
}
