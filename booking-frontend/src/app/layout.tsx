import './globals.css'
import './mz-fonts.css'
import type { Metadata } from 'next'
import PreviewActivity from './PreviewActivity'

export const metadata: Metadata = {
  title: 'MZ Property | Melbourne Stays & Property Care',
  description: 'Explore MZ Property’s Melbourne stays and property-management services.',
  icons: {
    icon: { url: '/homepage/mz-mark-v2.svg?v=20261017-1', type: 'image/svg+xml' },
    shortcut: '/homepage/mz-mark-v2.svg?v=20261017-1',
    apple: { url: '/homepage/mz-mark-v2.svg?v=20261017-1', type: 'image/svg+xml' },
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}<PreviewActivity /></body>
    </html>
  )
}
