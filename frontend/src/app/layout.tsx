import './globals.css'
import 'antd/dist/reset.css'
import type { Metadata } from 'next'
import dynamic from 'next/dynamic'
const ClientAdminLayout = dynamic(() => import('../components/AdminLayout').then(m => m.AdminLayout), { ssr: false })
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
          <ClientAdminLayout>{children}</ClientAdminLayout>
        </ClientThemeProvider>
      </body>
    </html>
  )
}
