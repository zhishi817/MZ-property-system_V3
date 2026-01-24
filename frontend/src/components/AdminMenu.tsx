 "use client"
 import { Menu } from 'antd'
 
 export default function AdminMenu({ items }: { items: any[] }) {
   return <Menu theme="dark" mode="inline" items={items} />
 }
