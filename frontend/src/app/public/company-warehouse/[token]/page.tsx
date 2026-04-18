import type { Metadata } from 'next'
import PublicCompanyWarehouseClient from './PublicCompanyWarehouseClient'

export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
  },
}

export default function Page({ params }: { params: { token: string } }) {
  const token = String(params?.token || '').trim()
  return <PublicCompanyWarehouseClient token={token} />
}
