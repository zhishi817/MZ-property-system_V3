import './globals.css'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'MZ Property Booking',
  description: 'Browse short stay properties and send booking inquiries.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
