import type { Metadata } from 'next'
import PublicGuideClient from '../../../../guide/p/[token]/PublicGuideClient'

export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
  },
}

export default function Page({ params }: { params: { token: string } }) {
  const token = String(params?.token || '').trim()
  return <PublicGuideClient token={token} />
}

