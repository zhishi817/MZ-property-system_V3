import type { Metadata } from 'next'
import PublicGuideClient from './PublicGuideClient'

export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
  },
}

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
} as const

export default function Page({ params }: { params: { token: string } }) {
  const token = String(params?.token || '').trim()
  return <PublicGuideClient token={token} />
}
