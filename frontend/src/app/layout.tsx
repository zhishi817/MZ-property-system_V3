import './globals.css'
import 'antd/dist/reset.css'
import type { Metadata } from 'next'
import { AdminLayout } from '../components/AdminLayout'
import { ClientThemeProvider } from '../components/ClientThemeProvider'

export const metadata: Metadata = {
  title: 'MZ Property System',
  description: 'Airbnb短租后台管理系统',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <ClientThemeProvider>
          <AdminLayout>{children}</AdminLayout>
        </ClientThemeProvider>
      </body>
    </html>
  )
}