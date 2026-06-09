"use client"

import { Button, Space } from 'antd'
import type { ReactNode } from 'react'

export type TableRowAction = {
  key: string
  label: ReactNode
  onClick: () => void
  danger?: boolean
  disabled?: boolean
  hidden?: boolean
  loading?: boolean
}

type TableRowActionsProps = {
  actions: TableRowAction[]
}

export default function TableRowActions({ actions }: TableRowActionsProps) {
  const visibleActions = actions.filter((action) => !action.hidden)

  if (!visibleActions.length) return null

  return (
    <Space>
      {visibleActions.map((action) => (
        <Button
          key={action.key}
          danger={action.danger}
          disabled={action.disabled}
          loading={action.loading}
          onClick={action.onClick}
        >
          {action.label}
        </Button>
      ))}
    </Space>
  )
}
