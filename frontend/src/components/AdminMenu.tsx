"use client"
import { Menu } from 'antd'
import type { MenuProps } from 'antd'
 
export default function AdminMenu({ items, theme = 'dark', onClick }: { items: any[]; theme?: MenuProps['theme']; onClick?: MenuProps['onClick'] }) {
  return <Menu theme={theme} mode="inline" items={items} onClick={onClick} />
}
