"use client"

import { Grid } from 'antd'
import type { ReactNode } from 'react'

const { useBreakpoint } = Grid

export default function ResponsiveDataView({
  cards,
  forceCards,
  table,
}: {
  cards: ReactNode
  forceCards?: boolean
  table: ReactNode
}) {
  const screens = useBreakpoint()
  const showCards = forceCards || !screens.md
  return <>{showCards ? cards : table}</>
}
