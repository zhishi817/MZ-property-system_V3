import './globals.css'
import 'antd/dist/reset.css'
import type { Metadata } from 'next'
import { AntdRegistry } from '../components/AntdRegistry'
import { ClientThemeProvider } from '../components/ClientThemeProvider'
import { AdminLayout } from '../components/AdminLayout'

export const metadata: Metadata = {
  title: 'MZ Property System',
  description: 'Airbnb短租后台管理系统',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <AntdRegistry>
          <ClientThemeProvider>
            <AdminLayout>{children}</AdminLayout>
          </ClientThemeProvider>
        </AntdRegistry>
      </body>
    </html>
  )
}
